//! Ownership of one finite tool or compiler process tree. Windows children enter a
//! private Job Object before their primary thread is allowed to execute.

use std::io;
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus};

#[derive(Debug)]
pub(super) struct OwnedProcess {
    child: Child,
    #[cfg(windows)]
    job: windows_job::Job,
    termination_requested: bool,
    stopped: bool,
    finite_cleanup: bool,
}

/// A finite constructor may already own a suspended/running child when its
/// Windows Job assignment or thread resumption fails. Keep that actual owner
/// with the original OS error; never reduce it to an unowned numeric PID.
#[must_use = "retain any returned process owner until its finite cleanup barrier completes"]
#[derive(Debug, thiserror::Error)]
#[error("{source}")]
pub(super) struct FiniteSpawnError {
    #[source]
    source: io::Error,
    owner: Option<Box<OwnedProcess>>,
}

impl From<io::Error> for FiniteSpawnError {
    fn from(source: io::Error) -> Self {
        Self {
            source,
            owner: None,
        }
    }
}

impl FiniteSpawnError {
    pub(super) fn into_parts(self) -> (io::Error, Option<Box<OwnedProcess>>) {
        (self.source, self.owner)
    }
}

impl OwnedProcess {
    pub(super) fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(windows)]
        {
            Self::spawn_windows(command, |_| Ok(()))
        }
        #[cfg(not(windows))]
        {
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
            }
            Ok(Self {
                child: command.spawn()?,
                termination_requested: false,
                stopped: false,
                finite_cleanup: false,
            })
        }
    }

    #[cfg(windows)]
    fn spawn_windows(
        command: &mut Command,
        before_assignment: impl FnOnce(&Child) -> io::Result<()>,
    ) -> io::Result<Self> {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

        let job = windows_job::Job::new()?;
        // std's main_thread_handle/spawn_with_attributes APIs are unstable.
        // CREATE_SUSPENDED is stable and lets us assign this process before
        // any compiler, shim, or worker code can create descendants.
        command.creation_flags(CREATE_SUSPENDED);
        let mut owned = Self {
            child: command.spawn()?,
            job,
            termination_requested: false,
            stopped: false,
            finite_cleanup: false,
        };
        // The guard already owns the suspended child. Any error or panic in
        // assignment/resumption kills and reaps it instead of leaking a
        // permanently suspended process or falling back to an unowned tree.
        let initialized = before_assignment(&owned.child)
            .and_then(|()| owned.job.assign(&owned.child))
            .and_then(|()| windows_job::resume_primary_thread(&owned.child));
        if let Err(error) = initialized {
            owned.stop();
            return Err(error);
        }
        Ok(owned)
    }

    pub(super) fn id(&self) -> u32 {
        self.child.id()
    }

    pub(super) fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub(super) fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Finite tools never reap their Unix group leader before requesting tree
    /// retirement. Its unreaped PID keeps that process-group identity reserved
    /// while the one numeric group signal is sent. Windows uses stable Job and
    /// direct-child handles, including errors before Job assignment succeeds.
    pub(super) fn spawn_finite(command: &mut Command) -> Result<Self, FiniteSpawnError> {
        #[cfg(windows)]
        {
            Self::spawn_finite_windows_with(command, |owned| {
                owned.job.assign(&owned.child)?;
                windows_job::resume_primary_thread(&owned.child)
            })
        }
        #[cfg(not(windows))]
        {
            let mut child = Self::spawn(command).map_err(FiniteSpawnError::from)?;
            child.finite_cleanup = true;
            Ok(child)
        }
    }

    #[cfg(windows)]
    fn spawn_finite_windows_with(
        command: &mut Command,
        initialize: impl FnOnce(&OwnedProcess) -> io::Result<()>,
    ) -> Result<Self, FiniteSpawnError> {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

        let job = windows_job::Job::new().map_err(FiniteSpawnError::from)?;
        command.creation_flags(CREATE_SUSPENDED);
        let child = command.spawn().map_err(FiniteSpawnError::from)?;
        // Every post-create failure returns this complete finite owner. Even
        // before assignment, it retains the stable direct-child handle.
        let owned = Self {
            child,
            job,
            termination_requested: false,
            stopped: false,
            finite_cleanup: true,
        };
        match initialize(&owned) {
            Ok(()) => Ok(owned),
            Err(source) => Err(FiniteSpawnError {
                source,
                owner: Some(Box::new(owned)),
            }),
        }
    }

    pub(super) fn terminate_finite(&mut self) -> io::Result<()> {
        if !self.finite_cleanup {
            return Err(io::Error::other("not a finite process owner"));
        }
        if self.stopped || self.termination_requested {
            return Ok(());
        }
        #[cfg(unix)]
        {
            use nix::errno::Errno;
            use nix::sys::signal::{killpg, Signal};
            use nix::unistd::Pid;
            let pid = i32::try_from(self.id())
                .map_err(|_| io::Error::other("owned process identifier overflow"))?;
            match killpg(Pid::from_raw(pid), Signal::SIGKILL) {
                Ok(()) | Err(Errno::ESRCH) => {}
                // Darwin can report EPERM when the only remaining member is
                // our exited, unreaped leader. Never infer retirement from the
                // errno: verify the exact reserved group before allowing it.
                #[cfg(target_os = "macos")]
                Err(Errno::EPERM)
                    if self.finite_leader_exited()?
                        && self.darwin_only_unreaped_leader_remains()? => {}
                Err(error) => return Err(io::Error::other(error)),
            }
        }
        #[cfg(windows)]
        {
            // A failed assignment leaves a suspended child outside this job.
            // Always try both stable handles, even if terminating one fails.
            let job_error = self.job.terminate().err();
            let child_error = match self.child.kill() {
                Ok(()) => None,
                Err(error) => match self.child.try_wait() {
                    // Killing an already exited/reaped direct child may fail;
                    // its retained handle/cached status can confirm that race.
                    Ok(Some(_)) => None,
                    Ok(None) | Err(_) => Some(error),
                },
            };
            if let Some(error) = job_error.or(child_error) {
                return Err(error);
            }
        }
        #[cfg(not(any(unix, windows)))]
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "finite process-tree ownership requires Unix or Windows",
        ));
        self.termination_requested = true;
        Ok(())
    }

    fn finite_leader_exited(&mut self) -> io::Result<bool> {
        #[cfg(unix)]
        {
            use nix::libc;
            // WNOWAIT observes only this owned child without releasing its PID.
            // libc supplies the POSIX operation on Darwin too; nix's waitid
            // wrapper does not expose it on that platform.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.id() as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result < 0 {
                return Err(io::Error::last_os_error());
            }
            // waitid leaves a zero pid when WNOHANG has no exited child.
            Ok(unsafe { info.si_pid() } != 0)
        }
        #[cfg(windows)]
        {
            Ok(self.child.try_wait()?.is_some())
        }
        #[cfg(not(any(unix, windows)))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "finite process ownership unavailable",
            ))
        }
    }

    #[cfg(target_os = "macos")]
    fn darwin_only_unreaped_leader_remains(&self) -> io::Result<bool> {
        // PROC_PGRP_ONLY includes the zombie leader that still reserves this
        // PID. Two slots distinguish that sole exact PID from any additional
        // descendant without enumerating unrelated processes. A zero/invalid
        // query is not absence proof: the unreaped leader must be present.
        #[link(name = "proc")]
        unsafe extern "C" {
            fn proc_listpids(
                kind: u32,
                group: u32,
                buffer: *mut std::ffi::c_void,
                size: i32,
            ) -> i32;
        }
        let mut members = [0_u32; 2];
        let bytes = unsafe {
            proc_listpids(
                2,
                self.id(),
                members.as_mut_ptr().cast(),
                std::mem::size_of_val(&members) as i32,
            )
        };
        if bytes <= 0 || bytes % std::mem::size_of::<u32>() as i32 != 0 {
            return Err(io::Error::other(
                "cannot verify the exact owned Darwin process group",
            ));
        }
        Ok(bytes == std::mem::size_of::<u32>() as i32 && members[0] == self.id())
    }

    /// Finite success retires the owned Unix process group or Windows job.
    /// Trusted finite tools must not detach helpers into another Unix group;
    /// this is not containment of arbitrary process-creating programs.
    /// A successful wrapper exit retires its remaining owned group immediately.
    pub(super) fn poll_finite_exit(&mut self) -> io::Result<Option<ExitStatus>> {
        if !self.finite_cleanup {
            return Err(io::Error::other("not a finite process owner"));
        }
        if self.stopped {
            return self.child.try_wait();
        }
        if !self.termination_requested {
            if !self.finite_leader_exited()? {
                return Ok(None);
            }
            self.terminate_finite()?;
        }
        #[cfg(target_os = "macos")]
        {
            // Keep the leader unreaped until every other group member has
            // disappeared. Checking after try_wait could observe a reused
            // numeric group, and Darwin's empty-group EPERM is ambiguous.
            if !self.finite_leader_exited()? || !self.darwin_only_unreaped_leader_remains()? {
                return Ok(None);
            }
            let status = self.child.try_wait()?;
            self.stopped = status.is_some();
            Ok(status)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let status = self.child.try_wait()?;
            if status.is_some() && self.poll_stopped()? {
                Ok(status)
            } else {
                Ok(None)
            }
        }
    }

    /// Fallible final barrier. Failure/timeout retains the owner so its caller
    /// can keep charging files and retry; it never sets stopped speculatively.
    pub(super) fn stop_finite(&mut self, budget: std::time::Duration) -> io::Result<bool> {
        self.terminate_finite()?;
        let deadline = std::time::Instant::now() + budget;
        loop {
            if self.poll_finite_exit()?.is_some() {
                return Ok(true);
            }
            if std::time::Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// Check cleanup progress without blocking the shared surface loop. Keep
    /// preparation files alive until every worker has relinquished them.
    #[cfg(not(target_os = "macos"))]
    pub(super) fn poll_stopped(&mut self) -> io::Result<bool> {
        if self.stopped {
            return Ok(true);
        }
        if self.child.try_wait()?.is_none() {
            return Ok(false);
        }
        #[cfg(windows)]
        let empty = self.job.is_empty()?;
        #[cfg(unix)]
        let empty = {
            use nix::errno::Errno;
            use nix::sys::signal::killpg;
            use nix::unistd::Pid;
            let pid = i32::try_from(self.id())
                .map_err(|_| io::Error::other("owned process group identifier overflow"))?;
            match killpg(Pid::from_raw(pid), None) {
                Ok(()) => false,
                Err(Errno::ESRCH) => true,
                Err(error) => return Err(io::Error::other(error)),
            }
        };
        #[cfg(not(any(unix, windows)))]
        let empty = true;
        if empty {
            self.stopped = true;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Request termination without blocking the surface's event loop. The
    /// ownership handle remains alive until stop/Drop, even after root exit.
    pub(super) fn terminate_now(&mut self) {
        if self.stopped || std::mem::replace(&mut self.termination_requested, true) {
            return;
        }
        #[cfg(unix)]
        {
            use nix::sys::signal::{killpg, Signal};
            use nix::unistd::Pid;
            if let Ok(pid) = i32::try_from(self.id()) {
                if let Err(error) = killpg(Pid::from_raw(pid), Signal::SIGKILL) {
                    if error != nix::errno::Errno::ESRCH {
                        eprintln!(
                            "weapp-simulator: cannot kill owned process group {pid}: {error}"
                        );
                    }
                }
            }
        }
        #[cfg(windows)]
        if let Err(error) = self.job.terminate() {
            eprintln!("weapp-simulator: cannot terminate owned Windows job: {error}");
        }
        // Also covers a Windows child whose job assignment failed while it
        // was suspended. Child::kill uses its process handle, never a new PID.
        let _ = self.child.kill();
    }

    /// Idempotent cleanup barrier. It never signals a previously released PID
    /// or job on a later Drop, and it reaps the direct child on every target.
    pub(super) fn stop(&mut self) {
        if self.finite_cleanup {
            match self.stop_finite(std::time::Duration::from_millis(500)) {
                Ok(true) => {}
                Ok(false) => eprintln!(
                    "weapp-simulator: finite process tree {} cleanup is unresolved",
                    self.id()
                ),
                Err(error) => eprintln!(
                    "weapp-simulator: finite process tree {} cleanup failed: {error}",
                    self.id()
                ),
            }
            return;
        }
        if std::mem::replace(&mut self.stopped, true) {
            return;
        }
        #[cfg(unix)]
        if !self.termination_requested {
            use nix::errno::Errno;
            use nix::sys::signal::{killpg, Signal};
            use nix::unistd::Pid;
            use std::time::{Duration, Instant};
            if let Ok(pid) = i32::try_from(self.id()) {
                let group = Pid::from_raw(pid);
                match killpg(group, Signal::SIGTERM) {
                    Ok(()) | Err(Errno::ESRCH) => {}
                    Err(error) => {
                        eprintln!("weapp-simulator: cannot stop owned process group {pid}: {error}")
                    }
                }
                let deadline = Instant::now() + Duration::from_millis(500);
                while Instant::now() < deadline {
                    let _ = self.child.try_wait();
                    if matches!(killpg(group, None), Err(Errno::ESRCH)) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                match killpg(group, Signal::SIGKILL) {
                    Ok(()) | Err(Errno::ESRCH) => {}
                    Err(error) => {
                        eprintln!("weapp-simulator: cannot kill owned process group {pid}: {error}")
                    }
                }
            }
        }
        #[cfg(windows)]
        {
            // A Job Object outlives the wrapper process. This also closes
            // workers that still hold compiler stdout/stderr pipes open.
            if let Err(error) = self.job.terminate() {
                eprintln!("weapp-simulator: cannot terminate owned Windows job: {error}");
            }
            if let Err(error) = self.job.wait_until_empty() {
                eprintln!("weapp-simulator: owned Windows job cleanup failed: {error}");
            }
        }
        self.termination_requested = true;
        match self.child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => {
                if let Err(error) = self.child.kill() {
                    eprintln!(
                        "weapp-simulator: cannot stop owned child {}: {error}",
                        self.id()
                    );
                }
                if let Err(error) = self.child.wait() {
                    eprintln!(
                        "weapp-simulator: cannot reap owned child {}: {error}",
                        self.id()
                    );
                }
            }
            Err(error) => {
                eprintln!(
                    "weapp-simulator: cannot inspect owned child {}: {error}",
                    self.id()
                )
            }
        }
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if self.finite_cleanup {
            self.stop();
            return;
        }
        #[cfg(not(windows))]
        self.stop();
        #[cfg(windows)]
        {
            // Closing the job also kills descendants. Ordinary completed
            // pack drops must never wait inside the surface event loop;
            // explicit shutdown/spawn failure uses stop() as its barrier.
            self.terminate_now();
            let _ = self.child.try_wait();
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod darwin_finite_tests {
    use super::*;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    fn spawn(script: &str) -> OwnedProcess {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        OwnedProcess::spawn_finite(&mut command).unwrap()
    }
    fn await_unreaped_exit(owner: &mut OwnedProcess) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !owner.finite_leader_exited().unwrap() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    #[test]
    fn natural_exit_keeps_the_reserved_leader_until_exact_group_retirement() {
        let mut owner = spawn("exit 7");
        await_unreaped_exit(&mut owner);
        assert!(owner.darwin_only_unreaped_leader_remains().unwrap());
        assert!(!owner.stopped);
        assert!(owner.stop_finite(Duration::from_secs(5)).unwrap());
        assert_eq!(owner.child.try_wait().unwrap().unwrap().code(), Some(7));
        assert!(owner.stopped);
    }
    #[test]
    fn an_exited_leader_cannot_hide_a_live_descendant_or_retire_an_unrelated_group() {
        let mut unrelated = spawn("exec /bin/sleep 30");
        let mut owner = spawn("/bin/sleep 30 & exit 0");
        await_unreaped_exit(&mut owner);
        assert!(!owner.darwin_only_unreaped_leader_remains().unwrap());
        assert!(!owner.stopped);
        assert!(owner.stop_finite(Duration::from_secs(5)).unwrap());
        assert!(unrelated.child.try_wait().unwrap().is_none());
        assert!(unrelated.stop_finite(Duration::from_secs(5)).unwrap());
    }
    #[test]
    fn a_live_sole_leader_is_never_a_cleanup_receipt() {
        let mut owner = spawn("exec /bin/sleep 30");
        assert!(owner.poll_finite_exit().unwrap().is_none());
        assert!(!owner.stopped);
        assert!(owner.stop_finite(Duration::from_secs(5)).unwrap());
    }
}

#[cfg(windows)]
mod windows_job {
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::process::Child;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessIdOfThread, OpenThread, ResumeThread, THREAD_QUERY_LIMITED_INFORMATION,
        THREAD_SUSPEND_RESUME,
    };

    #[derive(Debug)]
    pub(super) struct Job(OwnedHandle);

    impl Job {
        pub(super) fn new() -> io::Result<Self> {
            // An unnamed, non-inheritable job belongs only to this owner.
            let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            let handle = owned_handle(raw)?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            // Do not grant BREAKAWAY_OK or SILENT_BREAKAWAY_OK: descendants
            // must stay in the job even when their immediate parent exits.
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let success = unsafe {
                SetInformationJobObject(
                    handle.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&info) as u32,
                )
            };
            if success == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(handle))
        }

        pub(super) fn assign(&self, child: &Child) -> io::Result<()> {
            let success =
                unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) };
            if success == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        pub(super) fn terminate(&self) -> io::Result<()> {
            if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }

        pub(super) fn wait_until_empty(&self) -> io::Result<()> {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if self.is_empty()? {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Windows job still contains active processes after termination",
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        pub(super) fn is_empty(&self) -> io::Result<bool> {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            let success = unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                )
            };
            if success == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(info.ActiveProcesses == 0)
            }
        }
    }

    fn owned_handle(raw: HANDLE) -> io::Result<OwnedHandle> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            // SAFETY: each successful Win32 create/open call transfers one
            // unique handle. OwnedHandle closes it on every return path.
            Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
        }
    }

    pub(super) fn resume_primary_thread(child: &Child) -> io::Result<()> {
        // With its primary thread suspended the new process has executed no
        // user code and cannot have started workers. ToolHelp provides the
        // public stable alternative to Rust's nightly main_thread_handle.
        let snapshot = owned_handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..THREADENTRY32::default()
        };
        if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut primary = None;
        loop {
            if entry.th32OwnerProcessID == child.id() {
                let thread = owned_handle(unsafe {
                    OpenThread(
                        THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                        0,
                        entry.th32ThreadID,
                    )
                })?;
                // Keep the process handle alive and recheck the opened
                // thread's owner so no reused snapshot thread ID is resumed.
                if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != child.id() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "suspended child thread ownership changed",
                    ));
                }
                if primary.replace(thread).is_some() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "suspended child unexpectedly has multiple threads",
                    ));
                }
            }
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                    return Err(error);
                }
                break;
            }
        }
        let primary = primary.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "suspended child primary thread not found",
            )
        })?;
        let previous = unsafe { ResumeThread(primary.as_raw_handle()) };
        if previous == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        if previous != 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "suspended child primary thread had an unexpected suspend count",
            ));
        }
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Read;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };

    const HELPER: &str = "owned_process::tests::windows_child_helper";
    const ROLE: &str = "WEAPP_CONTAINER_OWNED_PROCESS_TEST_ROLE";
    const ROOT: &str = "WEAPP_CONTAINER_OWNED_PROCESS_TEST_ROOT";

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "weapp-owned-process-{}-{nonce}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn command(&self, role: &str) -> Command {
            helper_command(&self.0, role)
        }

        fn process(&self, role: &str) -> OwnedHandle {
            let marker = self.0.join(role);
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Ok(text) = fs::read_to_string(&marker) {
                    if let Ok(pid) = text.parse::<u32>() {
                        return process_handle(pid);
                    }
                }
                assert!(Instant::now() < deadline, "helper {role} did not start");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn helper_command(root: &Path, role: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", HELPER, "--nocapture"])
            .env(ROOT, root)
            .env(ROLE, role)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command
    }

    fn process_handle(pid: u32) -> OwnedHandle {
        let raw = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        assert!(
            !raw.is_null(),
            "cannot open helper {pid}: {}",
            io::Error::last_os_error()
        );
        // The tests retain handles rather than rediscovering exited PIDs.
        unsafe { OwnedHandle::from_raw_handle(raw) }
    }

    fn assert_exited(process: &OwnedHandle) {
        assert_eq!(
            unsafe { WaitForSingleObject(process.as_raw_handle(), 5_000) },
            WAIT_OBJECT_0,
            "owned process did not exit"
        );
    }

    fn assert_alive(process: &OwnedHandle) {
        assert_eq!(
            unsafe { WaitForSingleObject(process.as_raw_handle(), 0) },
            WAIT_TIMEOUT,
            "unrelated process was terminated"
        );
    }

    fn wait_wrapper_exit(process: &mut OwnedProcess) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = process.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            assert!(Instant::now() < deadline, "wrapper did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    // Returning from this one-test subprocess makes the wrapper exit before
    // its worker. Dropping that intentionally un-reaped Child is the fixture.
    #[test]
    #[allow(clippy::zombie_processes)]
    fn windows_child_helper() {
        let Ok(role) = std::env::var(ROLE) else {
            return;
        };
        let root = PathBuf::from(std::env::var_os(ROOT).unwrap());
        fs::write(root.join(&role), std::process::id().to_string()).unwrap();
        match role.as_str() {
            "wrapper" => {
                helper_command(&root, "worker")
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap();
            }
            "worker" => {
                let mut leaf = helper_command(&root, "leaf")
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap();
                // Bound lifetime even if the outer test process is killed.
                std::thread::sleep(Duration::from_secs(45));
                let _ = leaf.kill();
                let _ = leaf.wait();
            }
            "leaf" | "sentinel" => std::thread::sleep(Duration::from_secs(45)),
            other => panic!("unknown helper role {other}"),
        }
    }

    #[test]
    fn windows_termination_keeps_descendants_owned_after_wrapper_exit() {
        let fixture = Fixture::new();
        let mut process = OwnedProcess::spawn(&mut fixture.command("wrapper")).unwrap();
        let worker = fixture.process("worker");
        let leaf = fixture.process("leaf");
        wait_wrapper_exit(&mut process);
        assert_alive(&worker);
        assert_alive(&leaf);

        // Both superseded packs and timeout cancellation use this path.
        // Descendants retain stdout after their wrapper has been reaped.
        let mut stdout = process.take_stdout().unwrap();
        let (tx, rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut output = Vec::new();
            let result = stdout.read_to_end(&mut output);
            let _ = tx.send(result);
        });
        assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        process.terminate_now();
        process.terminate_now();
        assert_exited(&worker);
        assert_exited(&leaf);
        process.stop();
        process.stop();
        rx.recv_timeout(Duration::from_secs(5))
            .expect("stdout pipe remained open")
            .unwrap();
        reader.join().unwrap();
    }

    #[test]
    fn windows_drop_reaps_owned_tree_and_preserves_unrelated_job() {
        let target = Fixture::new();
        let unrelated = Fixture::new();
        let mut sentinel = OwnedProcess::spawn(&mut unrelated.command("sentinel")).unwrap();
        let sentinel_handle = unrelated.process("sentinel");
        let mut process = OwnedProcess::spawn(&mut target.command("wrapper")).unwrap();
        let worker = target.process("worker");
        let leaf = target.process("leaf");
        wait_wrapper_exit(&mut process);
        drop(process);
        assert_exited(&worker);
        assert_exited(&leaf);
        assert_alive(&sentinel_handle);
        sentinel.stop();
        assert_exited(&sentinel_handle);
    }

    #[test]
    fn windows_child_cannot_execute_before_job_assignment() {
        let fixture = Fixture::new();
        let marker = fixture.0.join("sentinel");
        let mut process = OwnedProcess::spawn_windows(&mut fixture.command("sentinel"), |_| {
            std::thread::sleep(Duration::from_millis(50));
            assert!(!marker.exists(), "child executed before job assignment");
            Ok(())
        })
        .unwrap();
        let handle = fixture.process("sentinel");
        process.stop();
        assert_exited(&handle);
    }

    #[test]
    fn windows_assignment_error_fails_closed_and_reaps_suspended_child() {
        let fixture = Fixture::new();
        let mut child_handle = None;
        let result = OwnedProcess::spawn_windows(&mut fixture.command("sentinel"), |child| {
            child_handle = Some(process_handle(child.id()));
            Err(io::Error::other("injected job assignment failure"))
        });
        assert!(result.is_err());
        assert_exited(child_handle.as_ref().unwrap());
        assert!(!fixture.0.join("sentinel").exists());
    }

    #[test]
    fn windows_finite_preassignment_failure_returns_the_suspended_child_owner() {
        let fixture = Fixture::new();
        let marker = fixture.0.join("sentinel");
        let failure =
            OwnedProcess::spawn_finite_windows_with(&mut fixture.command("sentinel"), |owned| {
                assert!(owned.finite_cleanup);
                assert!(owned.job.is_empty()?);
                assert!(!marker.exists());
                Err(io::Error::from_raw_os_error(5))
            })
            .unwrap_err();
        assert!(std::error::Error::source(&failure).is_some());
        let (source, owner) = failure.into_parts();
        assert_eq!(source.raw_os_error(), Some(5));
        let mut owner = owner.expect("postcreate failure must return the actual owner");
        let child = process_handle(owner.id());
        assert_alive(&child);
        assert!(owner.job.is_empty().unwrap());
        assert!(!owner.termination_requested);
        assert!(!owner.stopped);
        assert!(!marker.exists(), "suspended user code must never execute");

        // Terminating the empty Job alone cannot kill this unassigned child.
        assert!(owner.stop_finite(Duration::from_secs(5)).unwrap());
        assert_exited(&child);
        assert!(owner.child.try_wait().unwrap().is_some());
        assert!(owner.job.is_empty().unwrap());
        assert!(owner.stopped);
        assert!(owner.stop_finite(Duration::ZERO).unwrap());
        assert!(!marker.exists());
    }

    #[test]
    fn windows_finite_preresume_failure_returns_the_assigned_child_owner() {
        let fixture = Fixture::new();
        let marker = fixture.0.join("sentinel");
        let failure =
            OwnedProcess::spawn_finite_windows_with(&mut fixture.command("sentinel"), |owned| {
                owned.job.assign(&owned.child)?;
                assert!(!owned.job.is_empty()?);
                assert!(!marker.exists());
                Err(io::Error::other(
                    "injected failure before thread resumption",
                ))
            })
            .unwrap_err();
        let (source, owner) = failure.into_parts();
        assert_eq!(
            source.to_string(),
            "injected failure before thread resumption"
        );
        let mut owner = owner.expect("assigned suspended child must remain owned");
        let child = process_handle(owner.id());
        assert_alive(&child);
        assert!(!owner.job.is_empty().unwrap());
        assert!(!owner.stopped);
        assert!(!marker.exists());

        assert!(owner.stop_finite(Duration::from_secs(5)).unwrap());
        assert_exited(&child);
        assert!(owner.child.try_wait().unwrap().is_some());
        assert!(owner.job.is_empty().unwrap());
        assert!(owner.stopped);
        assert!(!marker.exists());
    }

    #[test]
    fn windows_finite_postresume_failure_keeps_descendants_and_unrelated_job_distinct() {
        let target = Fixture::new();
        let unrelated = Fixture::new();
        let mut sentinel = OwnedProcess::spawn(&mut unrelated.command("sentinel")).unwrap();
        let sentinel_handle = unrelated.process("sentinel");
        let mut direct = None;
        let failure =
            OwnedProcess::spawn_finite_windows_with(&mut target.command("wrapper"), |owned| {
                direct = Some(process_handle(owned.id()));
                owned.job.assign(&owned.child)?;
                windows_job::resume_primary_thread(&owned.child)?;
                Err(io::Error::other("injected failure after thread resumption"))
            })
            .unwrap_err();
        let (source, owner) = failure.into_parts();
        assert_eq!(
            source.to_string(),
            "injected failure after thread resumption"
        );
        let mut owner = owner.expect("resumed process and its Job must remain owned");
        let worker = target.process("worker");
        let leaf = target.process("leaf");
        wait_wrapper_exit(&mut owner);
        assert_exited(direct.as_ref().unwrap());
        assert_alive(&worker);
        assert_alive(&leaf);
        assert_alive(&sentinel_handle);
        assert!(!owner.job.is_empty().unwrap());
        assert!(!owner.stopped);

        assert!(owner.stop_finite(Duration::from_secs(5)).unwrap());
        assert_exited(&worker);
        assert_exited(&leaf);
        assert!(owner.child.try_wait().unwrap().is_some());
        assert!(owner.job.is_empty().unwrap());
        assert!(owner.stopped);
        assert_alive(&sentinel_handle);
        sentinel.stop();
        assert_exited(&sentinel_handle);
    }

    #[test]
    fn windows_finite_error_drop_is_fallback_cleanup_not_a_returned_barrier() {
        let fixture = Fixture::new();
        let mut direct = None;
        let failure =
            OwnedProcess::spawn_finite_windows_with(&mut fixture.command("sentinel"), |owned| {
                direct = Some(process_handle(owned.id()));
                Err(io::Error::other("injected preassignment failure"))
            })
            .unwrap_err();
        assert_alive(direct.as_ref().unwrap());
        assert!(failure.owner.is_some());
        // Exceptional Drop has no boolean receipt. Production must preserve
        // the error and its outer reservation and call explicit retry cleanup.
        drop(failure);
        assert_exited(direct.as_ref().unwrap());
        assert!(!fixture.0.join("sentinel").exists());
    }

    #[test]
    fn windows_finite_prechild_error_has_no_process_owner() {
        let fixture = Fixture::new();
        let mut command = Command::new(fixture.0.join("missing-program.exe"));
        let failure = OwnedProcess::spawn_finite(&mut command).unwrap_err();
        assert!(std::error::Error::source(&failure).is_some());
        let (source, owner) = failure.into_parts();
        assert_eq!(source.kind(), io::ErrorKind::NotFound);
        assert!(owner.is_none());
        assert!(std::mem::size_of::<FiniteSpawnError>() <= 128);
    }
}
