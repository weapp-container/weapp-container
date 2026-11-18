//! A single stdout owner with bounded asynchronous frames. Enqueue is not delivery.
//! Only the worker touches the pipe; it retains one offset and one original
//! monotonic deadline across EAGAIN/EINTR. A failed frame permanently poisons
//! the stream, including cleanup, so a partial prefix is never followed by JSON.
use serde_json::Value;
use std::collections::BTreeSet;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub type Ticket = u64;
const MAX_PENDING: usize = 4;
const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRANSPORT_WAIT: Duration = Duration::from_secs(5);
const MUTABLE_STATUS: i32 = libc::O_NONBLOCK
    | libc::O_APPEND
    | libc::O_ASYNC
    | libc::O_SYNC
    | libc::O_DSYNC
    | libc::O_ACCMODE;

#[derive(Debug)]
pub struct Completion {
    pub ticket: Ticket,
    pub bytes_written: Option<usize>,
    pub completed_at: Instant,
    pub result: Result<(), String>,
}
struct Frame {
    ticket: Ticket,
    bytes: Vec<u8>,
    deadline: Instant,
}

// Bound allocation while encoding, not only after an arbitrarily large Vec
// has already been created. The limit includes the final newline delimiter.
struct Encoder(Vec<u8>);
impl io::Write for Encoder {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > (MAX_FRAME_BYTES - 1).saturating_sub(self.0.len()) {
            return Err(io::Error::other(
                "stdout frame exceeds 2 MiB; frame not enqueued",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
type Failure = Arc<Mutex<Option<String>>>;
fn failed(failure: &Failure) -> Option<String> {
    failure.lock().unwrap().clone()
}
fn poison(failure: &Failure, error: String) {
    let mut first = failure.lock().unwrap();
    if first.is_none() {
        *first = Some(error);
    }
}
struct Pipe {
    fd: OwnedFd,
    original_flags: i32,
}
impl Pipe {
    fn new(fd: OwnedFd) -> Result<Self, String> {
        let raw = fd.as_raw_fd();
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(raw, stat.as_mut_ptr()) } < 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        let mode = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
        if mode != libc::S_IFIFO && mode != libc::S_IFSOCK {
            return Err("bounded stdout requires an owned pipe/socket".into());
        }
        let flags = unsafe { libc::fcntl(raw, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok(Self {
            fd,
            original_flags: flags,
        })
    }
    fn restore(&self) -> Result<(), String> {
        let raw = self.fd.as_raw_fd();
        let current = unsafe { libc::fcntl(raw, libc::F_GETFL) };
        if current < 0
            || unsafe {
                libc::fcntl(
                    raw,
                    libc::F_SETFL,
                    (current & !libc::O_NONBLOCK) | (self.original_flags & libc::O_NONBLOCK),
                )
            } < 0
        {
            return Err(io::Error::last_os_error().to_string());
        }
        let actual = unsafe { libc::fcntl(raw, libc::F_GETFL) };
        if actual < 0 || actual & MUTABLE_STATUS != self.original_flags & MUTABLE_STATUS {
            return Err("owned stdout public flags did not restore".into());
        }
        Ok(())
    }
    fn write(&self, frame: Frame) -> Completion {
        let mut offset = 0;
        let result = (|| {
            while offset < frame.bytes.len() {
                if Instant::now() >= frame.deadline {
                    return Err(format!(
                        "stdout original deadline expired after {offset} bytes"
                    ));
                }
                let n = unsafe {
                    libc::write(
                        self.fd.as_raw_fd(),
                        frame.bytes[offset..].as_ptr().cast(),
                        frame.bytes.len() - offset,
                    )
                };
                if n > 0 {
                    offset += n as usize;
                    continue;
                }
                if n == 0 {
                    return Err(format!("stdout made no progress after {offset} bytes"));
                }
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                if error.kind() != io::ErrorKind::WouldBlock {
                    return Err(format!("stdout failed after {offset} bytes: {error}"));
                }
                // The worker alone waits. A short poll allows bounded shutdown;
                // no timeout/offset is reset after a wake, EINTR or EAGAIN.
                let left = frame.deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    continue;
                }
                let mut event = libc::pollfd {
                    fd: self.fd.as_raw_fd(),
                    events: libc::POLLOUT,
                    revents: 0,
                };
                let millis = (left.as_millis().saturating_add(1)).min(10) as i32;
                let n = unsafe { libc::poll(&mut event, 1, millis) };
                if n < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    return Err(format!(
                        "stdout poll failed after {offset} bytes: {}",
                        io::Error::last_os_error()
                    ));
                }
            }
            if Instant::now() >= frame.deadline {
                return Err("stdout full frame finished outside original deadline".into());
            }
            Ok(())
        })();
        Completion {
            ticket: frame.ticket,
            bytes_written: Some(offset),
            completed_at: Instant::now(),
            result,
        }
    }
}
impl Drop for Pipe {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

pub struct Output {
    sender: Option<mpsc::SyncSender<Frame>>,
    completed: mpsc::Receiver<Completion>,
    worker: Option<JoinHandle<Result<(), String>>>,
    failure: Failure,
    pending: BTreeSet<Ticket>,
    next: Ticket,
}
impl Output {
    pub fn stdout() -> Result<Self, String> {
        let fd = unsafe { libc::dup(io::stdout().as_raw_fd()) };
        if fd < 0 {
            return Err(io::Error::last_os_error().to_string());
        }
        Self::new(unsafe { OwnedFd::from_raw_fd(fd) })
    }
    pub fn new(fd: OwnedFd) -> Result<Self, String> {
        let pipe = Pipe::new(fd)?;
        let (sender, requests) = mpsc::sync_channel::<Frame>(MAX_PENDING);
        // Logical outstanding cap bounds both queues to four frames/reports.
        let (reports, completed) = mpsc::channel();
        let failure = Arc::new(Mutex::new(None));
        let worker_failure = failure.clone();
        let worker = std::thread::spawn(move || {
            for frame in requests {
                let report = if let Some(error) = failed(&worker_failure) {
                    Completion {
                        ticket: frame.ticket,
                        bytes_written: Some(0),
                        completed_at: Instant::now(),
                        result: Err(error),
                    }
                } else {
                    pipe.write(frame)
                };
                if let Err(error) = &report.result {
                    poison(&worker_failure, error.clone());
                }
                if reports.send(report).is_err() {
                    break;
                }
            }
            pipe.restore()?;
            failed(&worker_failure).map_or(Ok(()), Err)
        });
        Ok(Self {
            sender: Some(sender),
            completed,
            worker: Some(worker),
            failure,
            pending: BTreeSet::new(),
            next: 1,
        })
    }
    pub fn enqueue(&mut self, value: &Value, original_deadline: Instant) -> Result<Ticket, String> {
        if let Some(error) = self.failure() {
            return Err(error);
        }
        if self.pending.len() >= MAX_PENDING {
            return Err("bounded stdout queue is full; frame not enqueued".into());
        }
        if Instant::now() >= original_deadline {
            return Err("stdout deadline expired before enqueue; no bytes accepted".into());
        }
        let mut encoder = Encoder(Vec::with_capacity(MAX_FRAME_BYTES));
        serde_json::to_writer(&mut encoder, value).map_err(|e| e.to_string())?;
        let mut bytes = encoder.0;
        bytes.push(b'\n');
        if Instant::now() >= original_deadline {
            return Err("stdout deadline expired while encoding; frame not enqueued".into());
        }
        let ticket = self.next;
        self.next = self.next.checked_add(1).ok_or("stdout ticket exhausted")?;
        // A separate transport maximum may shorten, never extend, the caller's
        // original monotonic deadline. Queueing time consumes the same budget.
        let deadline = original_deadline.min(Instant::now() + MAX_TRANSPORT_WAIT);
        let frame = Frame {
            ticket,
            bytes,
            deadline,
        };
        self.sender
            .as_ref()
            .ok_or("stdout owner already shut down")?
            .try_send(frame)
            .map_err(|e| e.to_string())?;
        self.pending.insert(ticket);
        Ok(ticket)
    }
    pub fn poll(&mut self) -> Vec<Completion> {
        let mut values = Vec::new();
        loop {
            match self.completed.try_recv() {
                Ok(value) => {
                    assert!(
                        self.pending.remove(&value.ticket),
                        "unknown stdout completion"
                    );
                    values.push(value);
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    values.extend(self.retire_disconnected());
                    break;
                }
            }
        }
        values
    }
    fn retire_disconnected(&mut self) -> Vec<Completion> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        let error =
            "stdout worker disconnected before completion; write count unavailable".to_string();
        poison(&self.failure, error.clone());
        std::mem::take(&mut self.pending)
            .into_iter()
            .map(|ticket| Completion {
                ticket,
                bytes_written: None,
                completed_at: Instant::now(),
                result: Err(error.clone()),
            })
            .collect()
    }
    pub fn is_idle(&self) -> bool {
        self.pending.is_empty()
    }
    pub fn failure(&self) -> Option<String> {
        failed(&self.failure)
    }
    /// Only after the native event loop/resource barrier, never in its callback.
    pub fn drain(&mut self) -> Vec<Completion> {
        let mut values = self.poll();
        while !self.pending.is_empty() {
            match self.completed.recv() {
                Ok(value) => {
                    assert!(self.pending.remove(&value.ticket));
                    values.push(value);
                }
                Err(_) => {
                    values.extend(self.retire_disconnected());
                    break;
                }
            }
        }
        values
    }
    pub fn finish(&mut self) -> Result<(), String> {
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            match worker.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => poison(&self.failure, error),
                Err(_) => poison(
                    &self.failure,
                    "stdout worker panicked; write count unavailable".into(),
                ),
            }
        }
        self.failure().map_or(Ok(()), Err)
    }
}
impl Drop for Output {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::fd::FromRawFd;
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn pipe() -> (OwnedFd, OwnedFd) {
        let mut fds = [-1; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }
    #[test]
    fn actual_slow_pipe_large_inspect_retains_offset_and_owner_progress() {
        let (reader, writer) = pipe();
        let mut output = Output::new(writer).unwrap();
        let value = serde_json::json!({"id":"inspect","transcript":"abcdef".repeat(180_000)});
        let mut expected = serde_json::to_vec(&value).unwrap();
        expected.push(b'\n');
        let reads = Arc::new(AtomicUsize::new(0));
        let progress = reads.clone();
        let reader = std::thread::spawn(move || {
            let mut input = std::fs::File::from(reader);
            let mut bytes = Vec::new();
            let mut block = [0; 4096];
            loop {
                let n = input.read(&mut block).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&block[..n]);
                progress.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(2));
            }
            bytes
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        let ticket = output.enqueue(&value, deadline).unwrap();
        let mut owner_ticks = 0;
        let mut completed = Vec::new();
        while !output.is_idle() {
            owner_ticks += 1;
            completed.extend(output.poll());
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(owner_ticks > 20);
        assert!(reads.load(Ordering::SeqCst) > 20);
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].ticket, ticket);
        assert!(completed[0].result.is_ok());
        assert!(completed[0].completed_at < deadline);
        assert_eq!(completed[0].bytes_written, Some(expected.len()));
        output.finish().unwrap();
        assert_eq!(reader.join().unwrap(), expected);
    }
    #[test]
    fn actual_full_pipe_queue_bound_expiry_is_sticky_and_cleanup_never_appends() {
        let (reader, writer) = pipe();
        let mut output = Output::new(writer).unwrap();
        let value = serde_json::json!({"inspect":"x".repeat(512*1024)});
        let deadline = Instant::now() + Duration::from_millis(100);
        for _ in 0..MAX_PENDING {
            output.enqueue(&value, deadline).unwrap();
        }
        let started = Instant::now();
        assert!(output
            .enqueue(&value, deadline)
            .unwrap_err()
            .contains("queue"));
        assert!(started.elapsed() < Duration::from_millis(50));
        let reports = output.drain();
        assert_eq!(reports.len(), MAX_PENDING);
        assert!(reports.iter().all(|v| v.result.is_err()));
        assert!(
            reports[0].bytes_written.unwrap() > 0 && reports[0].bytes_written.unwrap() < 512 * 1024
        );
        assert!(reports.iter().skip(1).all(|r| r.bytes_written == Some(0)));
        assert!(output
            .enqueue(
                &serde_json::json!({"kind":"cleanup"}),
                Instant::now() + Duration::from_secs(1)
            )
            .is_err());
        assert!(output.finish().is_err());
        let mut bytes = Vec::new();
        std::fs::File::from(reader).read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes.len(), reports[0].bytes_written.unwrap());
        assert!(!bytes.contains(&b'\n'));
        assert!(!bytes.windows(7).any(|v| v == b"cleanup"));
    }
    #[test]
    fn actual_reader_disconnect_retires_partial_frame_and_following_output() {
        let (reader, writer) = pipe();
        let mut output = Output::new(writer).unwrap();
        let drain = std::thread::spawn(move || {
            let mut f = std::fs::File::from(reader);
            let mut b = [0; 4096];
            f.read_exact(&mut b).unwrap();
        });
        output
            .enqueue(
                &serde_json::json!({"payload":"x".repeat(1024*1024)}),
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
        let reports = output.drain();
        drain.join().unwrap();
        assert_eq!(reports.len(), 1);
        assert!(reports[0].result.is_err());
        assert!(reports[0].bytes_written.unwrap() > 0);
        assert!(output
            .enqueue(
                &serde_json::json!({"kind":"cleanup"}),
                Instant::now() + Duration::from_secs(1)
            )
            .is_err());
        assert!(output.finish().is_err());
    }
    #[test]
    fn expired_before_enqueue_writes_nothing_and_does_not_renew_deadline() {
        let (reader, writer) = pipe();
        let mut output = Output::new(writer).unwrap();
        assert!(output
            .enqueue(&serde_json::json!({"late":true}), Instant::now())
            .is_err());
        assert!(output.is_idle());
        output.finish().unwrap();
        let mut bytes = Vec::new();
        std::fs::File::from(reader).read_to_end(&mut bytes).unwrap();
        assert!(bytes.is_empty());
    }
    #[test]
    fn queued_deadline_is_not_restarted_after_earlier_frame_drains() {
        let (reader, writer) = pipe();
        let mut output = Output::new(writer).unwrap();
        let first = serde_json::json!({"first":"x".repeat(512*1024)});
        output
            .enqueue(&first, Instant::now() + Duration::from_secs(1))
            .unwrap();
        output
            .enqueue(
                &serde_json::json!({"second":true}),
                Instant::now() + Duration::from_millis(30),
            )
            .unwrap();
        let reader = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(70));
            let mut bytes = Vec::new();
            std::fs::File::from(reader).read_to_end(&mut bytes).unwrap();
            bytes
        });
        let reports = output.drain();
        assert!(reports[0].result.is_ok());
        assert!(reports[1].result.is_err());
        assert_eq!(reports[1].bytes_written, Some(0));
        assert!(output.finish().is_err());
        let mut expected = serde_json::to_vec(&first).unwrap();
        expected.push(b'\n');
        assert_eq!(reader.join().unwrap(), expected);
    }
    #[test]
    fn normal_shutdown_drains_large_frame_before_terminal_in_same_order() {
        let (reader, writer) = pipe();
        let original_flags = unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_GETFL) };
        let observer = unsafe { OwnedFd::from_raw_fd(libc::dup(writer.as_raw_fd())) };
        let mut output = Output::new(writer).unwrap();
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            std::fs::File::from(reader).read_to_end(&mut bytes).unwrap();
            bytes
        });
        let first = serde_json::json!({"inspect":"x".repeat(256*1024)});
        let terminal = serde_json::json!({"kind":"cleanup"});
        output
            .enqueue(&first, Instant::now() + Duration::from_secs(1))
            .unwrap();
        assert!(output.drain().iter().all(|v| v.result.is_ok()));
        output
            .enqueue(&terminal, Instant::now() + Duration::from_secs(1))
            .unwrap();
        assert!(output.drain().iter().all(|v| v.result.is_ok()));
        output.finish().unwrap();
        assert_eq!(
            unsafe { libc::fcntl(observer.as_raw_fd(), libc::F_GETFL) } & MUTABLE_STATUS,
            original_flags & MUTABLE_STATUS
        );
        drop(observer);
        let bytes = reader.join().unwrap();
        let frames: Vec<Value> = bytes
            .split(|b| *b == b'\n')
            .filter(|v| !v.is_empty())
            .map(|v| serde_json::from_slice(v).unwrap())
            .collect();
        assert_eq!(frames, vec![first, terminal]);
    }

    #[test]
    fn oversized_encoding_is_rejected_before_acceptance_without_poison_or_bytes() {
        let (reader, writer) = pipe();
        let mut output = Output::new(writer).unwrap();
        assert!(output
            .enqueue(
                &serde_json::json!({"oversized":"x".repeat(MAX_FRAME_BYTES)}),
                Instant::now() + Duration::from_secs(1)
            )
            .unwrap_err()
            .contains("2 MiB"));
        assert!(output.is_idle());
        assert!(output.failure().is_none());
        output.finish().unwrap();
        let mut bytes = Vec::new();
        std::fs::File::from(reader).read_to_end(&mut bytes).unwrap();
        assert!(bytes.is_empty());
    }
}
