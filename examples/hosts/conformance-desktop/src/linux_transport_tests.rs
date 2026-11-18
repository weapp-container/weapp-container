//! Actual Linux FDs only. These checks create no window and no Session ACK.
use crate::method_output::Output;
use serde_json::json;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::time::{Duration, Instant};
fn pipe(flags: i32) -> (OwnedFd, OwnedFd, OwnedFd) {
    let mut fds = [-1; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    let writer = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    let current = unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_GETFL) };
    assert!(current >= 0);
    assert_eq!(
        unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_SETFL, current | flags) },
        0
    );
    let probe = unsafe { libc::dup(writer.as_raw_fd()) };
    assert!(probe >= 0);
    (unsafe { OwnedFd::from_raw_fd(fds[0]) }, writer, unsafe {
        OwnedFd::from_raw_fd(probe)
    })
}
#[test]
fn full_linux_flags_match_an_independent_plain_write_control() {
    for flags in [
        0,
        libc::O_APPEND,
        libc::O_NONBLOCK,
        libc::O_APPEND | libc::O_NONBLOCK,
    ] {
        let (_control_reader, control, control_probe) = pipe(flags);
        let data = b"ordinary write\n";
        assert_eq!(
            unsafe { libc::write(control.as_raw_fd(), data.as_ptr().cast(), data.len()) },
            data.len() as isize
        );
        let expected = unsafe { libc::fcntl(control_probe.as_raw_fd(), libc::F_GETFL) };
        let (_reader, writer, probe) = pipe(flags);
        let before = unsafe { libc::fcntl(probe.as_raw_fd(), libc::F_GETFL) };
        let mut output = Output::new(writer).unwrap();
        output
            .enqueue(
                &json!({"linux":"flags"}),
                Instant::now() + Duration::from_secs(2),
            )
            .unwrap();
        let reports = output.drain();
        assert_eq!(reports.len(), 1);
        assert!(reports[0].result.is_ok());
        output.finish().unwrap();
        drop(output);
        let actual = unsafe { libc::fcntl(probe.as_raw_fd(), libc::F_GETFL) };
        assert_eq!(
            actual, expected,
            "full F_GETFL differs for requested flags {flags}"
        );
        assert_eq!(
            actual, before,
            "Linux ordinary pipe write changed flags unexpectedly"
        );
    }
}
#[test]
fn dropping_backpressured_linux_owner_keeps_original_deadline_and_flags() {
    for flags in [
        0,
        libc::O_APPEND,
        libc::O_NONBLOCK,
        libc::O_APPEND | libc::O_NONBLOCK,
    ] {
        let (_reader, writer, probe) = pipe(flags);
        let expected = unsafe { libc::fcntl(probe.as_raw_fd(), libc::F_GETFL) };
        let mut output = Output::new(writer).unwrap();
        let start = Instant::now();
        let deadline = start + Duration::from_millis(80);
        output
            .enqueue(&json!({"backpressure":"x".repeat(512*1024)}), deadline)
            .unwrap();
        drop(output);
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(70),
            "blocked writer ended before its original deadline"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "drop did not honor bounded original deadline: {elapsed:?}"
        );
        assert_eq!(
            unsafe { libc::fcntl(probe.as_raw_fd(), libc::F_GETFL) },
            expected
        );
    }
}
