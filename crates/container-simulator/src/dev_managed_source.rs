//! Actual compiler/source/portable owners for the explicit browser preparation
//! profile. This is not a site, Worker or presentation receipt.
use super::*;
use crate::browser_dev_aggregate_store::{
    AdmissionError, CreditStatus, NamespaceId, PackSourceInput, PackStart, SourceInputLease,
    SourceStep,
};

const COMPILER: &str = "0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e";

pub(super) fn fixed_compiler(workspace: &Path) -> Result<String, DevError> {
    let output = Command::new("git")
        .args(["rev-parse", "--verify", "HEAD"])
        .current_dir(workspace.join("vendor/weapp-vite"))
        .stdin(Stdio::null())
        .output()?;
    if !output.status.success() || output.stdout.len() > 128 {
        return Err(DevError::BrowserRuntime(
            "fixed compiler identity unavailable".into(),
        ));
    }
    let actual = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if actual != COMPILER {
        return Err(DevError::BrowserRuntime(
            "managed source compiler differs from the frozen baseline".into(),
        ));
    }
    Ok(actual)
}

struct Packing {
    id: NamespaceId,
    token: PortablePublicationToken,
    obsolete: bool,
}

pub(super) struct ManagedSourceBuild {
    command: Option<Command>,
    sender: Option<mpsc::Sender<BuildOutput>>,
    started: bool,
    failed_start: bool,
    issued: Option<NamespaceId>,
    raw: Option<SourceInputLease>,
    packing: Option<Packing>,
    current: Option<NamespaceId>,
    retiring: Vec<NamespaceId>,
    last_error: Option<String>,
    last_status: Option<CreditStatus>,
    cleanup_error: Option<String>,
    cleanup_diagnostic: Option<DevDiagnostic>,
}

impl ManagedSourceBuild {
    pub(super) fn stage_input(
        &self,
        owner: &mut BrowserRuntimePreparationOwner,
        expected: &PortablePackReport,
    ) -> Result<crate::browser_dev_aggregate_store::PortableInputLease, DevError> {
        let id = self.current.ok_or_else(|| {
            DevError::BrowserRuntime("no current owned portable generation".into())
        })?;
        let input = owner.portable_input(id)?;
        if input.report() != expected {
            return Err(DevError::BrowserRuntime(
                "stage ticket differs from the actual current portable input".into(),
            ));
        }
        Ok(input)
    }

    pub(super) fn new(command: Command, sender: mpsc::Sender<BuildOutput>) -> Self {
        Self {
            command: Some(command),
            sender: Some(sender),
            started: false,
            failed_start: false,
            issued: None,
            raw: None,
            packing: None,
            current: None,
            retiring: Vec::with_capacity(8),
            last_error: None,
            last_status: None,
            cleanup_error: None,
            cleanup_diagnostic: None,
        }
    }

    pub(super) fn release_inputs(&mut self) {
        self.raw = None;
        self.command = None;
        self.sender = None;
    }

    pub(super) fn publication_current(&self, supervisor: &DevSupervisor) -> bool {
        if self.failed_start
            || !self.started
            || self.raw.is_some()
            || self.packing.is_some()
            || self.current.is_none()
            || self
                .last_status
                .as_ref()
                .is_none_or(|status| status.kind != "success")
        {
            return false;
        }
        // The managed protocol is a single bounded, atomically replaced status
        // for THIS run. An empty legacy receipts directory grants no authority.
        supervisor.browser_runtime.as_ref().is_some_and(|owner| {
            owner.source_status().is_ok_and(|status| {
                status.is_some_and(|status| {
                    status.kind == "success"
                        && self.last_status.as_ref() == Some(&status)
                        && status.sequence == supervisor.last_receipt_sequence.to_string()
                })
            })
        })
    }

    fn retire(&mut self, id: NamespaceId) {
        if !self.retiring.contains(&id) {
            self.retiring.push(id);
        }
    }
}

impl DevSupervisor {
    pub(super) fn poll_managed_source(&mut self) -> Result<Option<DevEvent>, DevError> {
        let mut source = self.managed_source.take().expect("managed source owner");
        let result = self.poll_managed_source_inner(&mut source);
        // Preserve actual input borrowers on every ordinary failure, including
        // constructor, poll, acknowledgement and validation errors.
        self.managed_source = Some(source);
        match result {
            Ok(event) => Ok(event),
            Err(error) => {
                self.raw_build_ready = false;
                self.portable_freshness.invalidate();
                self.diagnostic_active = true;
                let message = error.to_string();
                let source = self.managed_source.as_mut().unwrap();
                if source.last_error.as_ref() == Some(&message) {
                    return Ok(None);
                }
                source.last_error = Some(message.clone());
                Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                    self.revision,
                    "browser-source",
                    "ERR_BROWSER_DEV_ARTIFACT",
                    message,
                ))))
            }
        }
    }

    fn poll_managed_source_inner(
        &mut self,
        source: &mut ManagedSourceBuild,
    ) -> Result<Option<DevEvent>, DevError> {
        if source.failed_start {
            // Startup is terminal, but a post-create constructor failure may
            // retain an actual suspended/live child. Keep advancing that same
            // barrier on every poll instead of stranding it until final exit.
            source.release_inputs();
            if let Some(owner) = self.browser_runtime.as_mut() {
                if owner.stop_source_watcher()? {
                    owner.drain_sources()?;
                }
            }
            self.poll_build_output();
            return Ok(None);
        }
        if !source.started {
            let owner = self
                .browser_runtime
                .as_mut()
                .expect("admitted runtime owner");
            if owner.report().is_none() {
                return Ok(None);
            }
            // Mark before the first side effect: a failed startup is never
            // retried against a partly created control directory.
            source.failed_start = true;
            owner.prepare_sources(
                self.receipt_session.clone(),
                self.compiler_commit.clone().expect("fixed compiler"),
            )?;
            let id = owner
                .issue_raw()
                .map_err(|r| DevError::BrowserRuntime(r.cause.to_string()))?;
            source.issued = Some(id);
            if owner.source_step(id)? != SourceStep::Issued {
                return Err(DevError::BrowserRuntime(
                    owner
                        .source_diagnostic(id)?
                        .unwrap_or("raw grant creation failed")
                        .to_owned(),
                ));
            }
            owner.spawn_source_watcher(source.command.as_mut().expect("unstarted command"))?;
            if let Some(stdout) = owner.source_stdout() {
                self.output_readers.push(spawn_output_reader(
                    stdout,
                    source.sender.as_ref().unwrap().clone(),
                ));
            }
            if let Some(stderr) = owner.source_stderr() {
                self.output_readers.push(spawn_output_reader(
                    stderr,
                    source.sender.as_ref().unwrap().clone(),
                ));
            }
            source.command = None;
            source.sender = None;
            source.started = true;
            source.failed_start = false;
        }
        self.poll_build_output();
        let owner = self.browser_runtime.as_mut().expect("source runtime owner");
        let exit = owner.poll_source_watcher()?;
        self.watcher_exit_observed |= exit.is_some();
        // Cleanup and actual pack progress happen even when status repeatedly
        // reports a build error. No source noise can strand a finite writer.
        let mut cleanup_error = None;
        for index in (0..source.retiring.len()).rev() {
            let id = source.retiring[index];
            match owner
                .retire_source(id)
                .and_then(|()| owner.cleanup_source(id))
            {
                Ok(SourceStep::Released) => {
                    source.retiring.remove(index);
                }
                Ok(_) => {}
                Err(error) => {
                    if cleanup_error.is_none() {
                        cleanup_error = Some(error);
                    }
                }
            }
        }
        // An old namespace's I/O error must not starve the current finite
        // writer, its deadline or actual process-tree barrier.
        let mut pack_error = None;
        let pack_step = if let Some(pack) = &source.packing {
            match owner.poll_source_pack(pack.id) {
                Ok(SourceStep::Failed) | Err(_) => {
                    let pack = source.packing.take().expect("failed actual pack");
                    let message = owner
                        .source_diagnostic(pack.id)?
                        .unwrap_or("managed pack failed")
                        .to_owned();
                    source.retire(pack.id);
                    owner.retire_source(pack.id)?;
                    // Constructor/poll failures can retain an actual writer;
                    // advance that same recovery now, regardless of old errors.
                    match owner.cleanup_source(pack.id) {
                        Ok(SourceStep::Released) => source.retiring.retain(|id| *id != pack.id),
                        Ok(_) => {}
                        Err(error) => {
                            if cleanup_error.is_none() {
                                cleanup_error = Some(error);
                            }
                        }
                    }
                    if !pack.obsolete {
                        pack_error = Some(io::Error::other(message));
                    }
                    None
                }
                Ok(step) => Some(step),
            }
        } else {
            None
        };
        let cleanup_message = cleanup_error.map(|error| error.to_string());
        if cleanup_message != source.cleanup_error {
            source.cleanup_error = cleanup_message;
            if let Some(message) = &source.cleanup_error {
                let mut diagnostic = DevDiagnostic::new(
                    self.revision,
                    "browser-source-cleanup",
                    "ERR_BROWSER_DEV_ARTIFACT",
                    message,
                );
                diagnostic.severity = "warning".into();
                source.cleanup_diagnostic = Some(diagnostic);
            }
        }
        if let Some(error) = pack_error {
            return Err(error.into());
        }
        let status = owner.source_status()?;
        if let Some(status) = status {
            let sequence = status.sequence.parse::<u64>().map_err(io::Error::other)?;
            if sequence < self.last_receipt_sequence {
                return Err(DevError::BrowserRuntime(
                    "source status sequence moved backwards".into(),
                ));
            }
            if sequence == self.last_receipt_sequence
                && source.last_status.as_ref() != Some(&status)
            {
                return Err(DevError::BrowserRuntime(
                    "source status changed without a new sequence".into(),
                ));
            }
            if sequence > self.last_receipt_sequence {
                self.last_receipt_sequence = sequence;
                self.portable_freshness.invalidate();
                self.raw_build_ready = false;
                source.last_status = Some(status.clone());
                source.last_error = None;
                if let Some(raw) = source.raw.take() {
                    source.retire(raw.namespace());
                }
                if let Some(pack) = &mut source.packing {
                    pack.obsolete = true;
                }
                match status.kind.as_str() {
                    "success" => {
                        let id = owner.accept_raw(&status)?;
                        if source.issued != Some(id) {
                            return Err(DevError::BrowserRuntime(
                                "success did not consume the outstanding grant".into(),
                            ));
                        }
                        source.issued = None;
                        source.raw = Some(owner.source_borrow(id)?);
                        // Immutable source remains charged while the pack's
                        // actual writer holds its borrower.
                        source.retire(id);
                        self.raw_build_ready = true;
                        self.diagnostic_active = false;
                        self.raw_source_inputs = Some(project_input_identities(
                            &self.config.project,
                            &[
                                resolve_watch_output(&self.config.project),
                                self.run_root.clone(),
                            ],
                        )?);
                    }
                    "error" | "blocked" => {
                        self.diagnostic_active = true;
                        // An error may have consumed its grant. Retiring it
                        // atomically revokes an unused grant or awaits the
                        // exact done ACK / actual watcher tree barrier.
                        if let Some(id) = source.issued.take() {
                            source.retire(id);
                        }
                        return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                            self.revision,
                            "build",
                            if status.kind == "blocked" {
                                "SOURCE_CAPACITY"
                            } else {
                                "BUILD_FAILED"
                            },
                            status
                                .message
                                .unwrap_or_else(|| "source build failed".into()),
                        ))));
                    }
                    _ => {}
                }
            }
        }
        if self
            .config
            .project
            .join("container.config.json")
            .try_exists()?
        {
            return Err(DevError::BrowserRuntime(
                "managed source profile does not yet admit modern View/config inputs".into(),
            ));
        }
        if let Some((fingerprint, path, message)) = self.source_app_json_error() {
            self.raw_build_ready = false;
            if self.source_error_fingerprint != Some(fingerprint) {
                self.source_error_fingerprint = Some(fingerprint);
                self.portable_freshness.invalidate();
                if let Some(pack) = &mut source.packing {
                    pack.obsolete = true;
                }
                let mut diagnostic =
                    DevDiagnostic::new(self.revision, "build", "BUILD_FAILED", message);
                diagnostic.file = Some(path.to_string_lossy().into_owned());
                self.diagnostic_active = true;
                return Ok(Some(DevEvent::Diagnostic(diagnostic)));
            }
        } else {
            self.source_error_fingerprint = None;
        }
        let owner = self.browser_runtime.as_mut().expect("source runtime owner");
        if let Some(step) = pack_step {
            if step != SourceStep::Writing {
                let pack = source.packing.take().expect("actual pack");
                if step == SourceStep::Ready
                    && !pack.obsolete
                    && self.raw_build_ready
                    && pack.token == self.portable_freshness.token(self.last_receipt_sequence)
                {
                    let report = owner.source_report(pack.id)?.clone();
                    if let Some(previous) = source.current.replace(pack.id) {
                        source.retire(previous);
                    }
                    self.revision = report.revision;
                    self.route_warning = portable_route_warning(&report);
                    self.accepted_portable = Some(report.clone());
                    self.diagnostic_active = false;
                    return Ok(Some(DevEvent::PortableReady {
                        revision: self.revision,
                        report,
                    }));
                }
                source.retire(pack.id);
                if step == SourceStep::Failed && !pack.obsolete {
                    self.diagnostic_active = true;
                    return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                        self.revision,
                        "pack",
                        "PACK_FAILED",
                        owner
                            .source_diagnostic(pack.id)?
                            .unwrap_or("managed pack failed"),
                    ))));
                }
            }
        }
        if source.packing.is_none() && self.raw_build_ready {
            if let Some(raw) = source.raw.take() {
                let token = self.portable_freshness.token(self.last_receipt_sequence);
                let intent = PackStart {
                    node_bin: self.config.node_bin.clone(),
                    packer: self
                        .workspace_root
                        .join("tools/container-manifest/bin/container-pack.mjs"),
                    revision: self
                        .revision
                        .checked_add(1)
                        .ok_or_else(|| io::Error::other("source revision exhausted"))?,
                    route: self.config.simulator.route.clone(),
                    publication_token: token.clone(),
                    modern_project_requested: false,
                    pack_timeout: self.config.pack_timeout,
                };
                match owner.start_source_pack(intent, PackSourceInput { raw }) {
                    Ok(id) => {
                        source.packing = Some(Packing {
                            id,
                            token,
                            obsolete: false,
                        })
                    }
                    Err(rejected) => {
                        let cause = rejected.cause;
                        source.raw = rejected.inputs.map(|input| input.raw);
                        if cause != AdmissionError::Capacity {
                            return Err(DevError::BrowserRuntime(cause.to_string()));
                        }
                    }
                }
            }
        }
        if source.issued.is_none() && exit.is_none() {
            match owner.issue_raw() {
                Ok(id) => {
                    source.issued = Some(id);
                    if owner.source_step(id)? != SourceStep::Issued {
                        return Err(DevError::BrowserRuntime(
                            owner
                                .source_diagnostic(id)?
                                .unwrap_or("raw grant creation failed")
                                .to_owned(),
                        ));
                    }
                }
                Err(rejected) if rejected.cause == AdmissionError::Capacity => {}
                Err(rejected) => return Err(DevError::BrowserRuntime(rejected.cause.to_string())),
            }
        }
        if source.packing.is_none() && source.raw.is_none() && self.output_drained {
            if let Some(status) = exit {
                return Ok(Some(DevEvent::Exited(status)));
            }
        }
        Ok(source.cleanup_diagnostic.take().map(DevEvent::Diagnostic))
    }
}

#[cfg(test)]
#[path = "dev_managed_source_live_tests.rs"]
mod live_tests;

#[cfg(test)]
#[path = "dev_managed_source_tests.rs"]
mod tests;
