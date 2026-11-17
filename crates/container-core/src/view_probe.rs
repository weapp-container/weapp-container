//! Internal native-adapter diagnostics. No guest values, raw errors or IO.
//!
//! Feature-gated observation only: this module never owns or changes a View
//! deadline, cancellation, health state or execution result. Unsupported builds
//! return None. Clock failures remain None rather than being reported as zero.

use crate::ViewEngineErrorCode;
use serde::{Deserialize, Serialize};
use std::{marker::PhantomData, rc::Rc};

/// Deliberately closed metadata: no script, filename, message or session input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewBatchDiagnostics {
    pub schema_version: u8,
    pub engine: ViewProbeEngine,
    pub modern: bool,
    pub operation: ViewProbeOperation,
    /// Decimal strings retain all u64 bits in JavaScript/JSON clients.
    pub batch_sequence: Option<String>,
    pub owner_thread_id: Option<String>,
    pub monotonic_start_ns: Option<String>,
    pub monotonic_end_ns: Option<String>,
    pub boottime_start_ns: Option<String>,
    pub boottime_end_ns: Option<String>,
    pub thread_cpu_start_ns: Option<String>,
    pub thread_cpu_end_ns: Option<String>,
    pub thread_cpu_elapsed_ns: Option<String>,
    /// Stable ERR_* code only; guest error messages/stacks never cross here.
    pub error_code: Option<String>,
    /// None means Android ATrace was not compiled/available on this platform.
    pub android_trace_enabled: Option<bool>,
    pub android_trace_emitted: bool,
}

/// Optional, bounded detail for one actual batch. This schema is independent
/// of the closed ViewBatchDiagnostics v1 schema and never aggregates batches.
/// Both native identity fields must match the adjacent last_batch observation;
/// they are not a process/session identity for cross-process causal joins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewBatchBreakdown {
    pub schema_version: u8,
    pub engine: ViewProbeEngine,
    pub modern: bool,
    pub operation: ViewProbeOperation,
    pub batch_sequence: Option<String>,
    pub owner_thread_id: Option<String>,
    pub phases: ViewBatchPhases,
}

impl ViewBatchBreakdown {
    pub fn from_batch(batch: &ViewBatchDiagnostics, phases: ViewBatchPhases) -> Self {
        Self {
            schema_version: 1,
            engine: batch.engine,
            modern: batch.modern,
            operation: batch.operation,
            batch_sequence: batch.batch_sequence.clone(),
            owner_thread_id: batch.owner_thread_id.clone(),
            phases,
        }
    }
}

/// Null means not attempted, not applicable, or unavailable, never zero work.
/// Modern profile has no native JSON stringify API stage: its writer remains
/// inside execution. context_call contains the parse/execute/output stages;
/// it also includes runtime-lock acquisition, error mapping and value drops.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewBatchPhases {
    pub context_call: Option<ViewPhaseTiming>,
    pub json_stringify_api: Option<ViewPhaseTiming>,
    pub utf8_copy_api: Option<ViewPhaseTiming>,
    pub final_deadline_check: Option<ViewPhaseTiming>,
    pub poison_drop: Option<ViewPhaseTiming>,
    /// Actual successfully extracted UTF-8 byte count, never an estimated size.
    pub output_bytes: Option<String>,
}

/// Native-only accumulator. Sampling and output byte accounting do not
/// allocate; conversion into the wire strings happens after final deadline
/// checking and poisoned-realm destruction have finished.
#[derive(Default)]
pub struct ViewBatchPhaseSamples {
    pub context_call: Option<ViewPhaseMeasurement>,
    pub json_stringify_api: Option<ViewPhaseMeasurement>,
    pub utf8_copy_api: Option<ViewPhaseMeasurement>,
    pub final_deadline_check: Option<ViewPhaseMeasurement>,
    pub poison_drop: Option<ViewPhaseMeasurement>,
    pub output_bytes: Option<u64>,
}

impl ViewBatchPhaseSamples {
    pub fn into_breakdown(self, batch: &ViewBatchDiagnostics) -> ViewBatchBreakdown {
        ViewBatchBreakdown::from_batch(
            batch,
            ViewBatchPhases {
                context_call: self.context_call.map(ViewPhaseMeasurement::into_timing),
                json_stringify_api: self
                    .json_stringify_api
                    .map(ViewPhaseMeasurement::into_timing),
                utf8_copy_api: self.utf8_copy_api.map(ViewPhaseMeasurement::into_timing),
                final_deadline_check: self
                    .final_deadline_check
                    .map(ViewPhaseMeasurement::into_timing),
                poison_drop: self.poison_drop.map(ViewPhaseMeasurement::into_timing),
                output_bytes: self.output_bytes.map(|value| value.to_string()),
            },
        )
    }
}

pub struct ViewPhaseMeasurement {
    completed: bool,
    monotonic_start: Option<u64>,
    monotonic_end: Option<u64>,
    cpu_start: Option<u64>,
    cpu_end: Option<u64>,
}

impl ViewPhaseMeasurement {
    fn into_timing(self) -> ViewPhaseTiming {
        let text = |value: Option<u64>| value.map(|value| value.to_string());
        let elapsed = |start: Option<u64>, end: Option<u64>| {
            start
                .zip(end)
                .and_then(|(start, end)| end.checked_sub(start))
        };
        ViewPhaseTiming {
            completed: self.completed,
            monotonic_start_ns: text(self.monotonic_start),
            monotonic_end_ns: text(self.monotonic_end),
            wall_elapsed_ns: text(elapsed(self.monotonic_start, self.monotonic_end)),
            thread_cpu_start_ns: text(self.cpu_start),
            thread_cpu_end_ns: text(self.cpu_end),
            thread_cpu_elapsed_ns: text(elapsed(self.cpu_start, self.cpu_end)),
        }
    }
}

/// Same-thread clocks sampled around a native boundary. CPU sampling is nested
/// inside monotonic wall sampling. The API can return successfully after the
/// deadline; completed does not imply that the batch was accepted or healthy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewPhaseTiming {
    pub completed: bool,
    pub monotonic_start_ns: Option<String>,
    pub monotonic_end_ns: Option<String>,
    pub wall_elapsed_ns: Option<String>,
    pub thread_cpu_start_ns: Option<String>,
    pub thread_cpu_end_ns: Option<String>,
    pub thread_cpu_elapsed_ns: Option<String>,
}

/// Observation only. No VM call, allocation, IO or clock substitution occurs
/// during sampling; wire formatting is deferred until the batch has finished.
pub struct ViewPhaseProbe {
    #[cfg(all(
        feature = "view-batch-diagnostics",
        any(
            target_os = "android",
            target_os = "linux",
            target_os = "macos",
            target_os = "ios"
        )
    ))]
    active: native::PhaseSamples,
    _owner: PhantomData<Rc<()>>,
}

impl ViewPhaseProbe {
    #[inline]
    pub fn begin() -> Self {
        Self {
            #[cfg(all(
                feature = "view-batch-diagnostics",
                any(
                    target_os = "android",
                    target_os = "linux",
                    target_os = "macos",
                    target_os = "ios"
                )
            ))]
            active: native::PhaseSamples::start(),
            _owner: PhantomData,
        }
    }

    #[inline]
    pub fn finish(self, completed: bool) -> Option<ViewPhaseMeasurement> {
        #[cfg(all(
            feature = "view-batch-diagnostics",
            any(
                target_os = "android",
                target_os = "linux",
                target_os = "macos",
                target_os = "ios"
            )
        ))]
        {
            Some(native::phase_timing(
                self.active,
                native::PhaseSamples::end(),
                completed,
            ))
        }
        #[cfg(not(all(
            feature = "view-batch-diagnostics",
            any(
                target_os = "android",
                target_os = "linux",
                target_os = "macos",
                target_os = "ios"
            )
        )))]
        {
            let _ = (self, completed);
            None
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewProbeEngine {
    Quickjs,
    V8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewProbeOperation {
    Load,
    Evaluate,
    Render,
    RegisterDocuments,
    RenderRegistered,
    ReleaseScopes,
    Unknown,
}

impl ViewProbeOperation {
    pub fn from_entrypoint(entrypoint: &str) -> Self {
        match entrypoint {
            "__weappContainer_view_load" => Self::Load,
            "__weappContainer_view_evaluate" => Self::Evaluate,
            "__weappContainer_view_render" => Self::Render,
            "__weappContainer_view_register_documents" => Self::RegisterDocuments,
            "__weappContainer_view_render_registered" => Self::RenderRegistered,
            "__weappContainer_view_release_scopes" => Self::ReleaseScopes,
            _ => Self::Unknown,
        }
    }
}

/// Compiled support in the owning core crate, after Cargo feature unification.
/// Engine-local cfg(feature) cannot represent dependency-activated diagnostics.
/// Individual native samples can still fail and remain null in a supported build.
pub const VIEW_BATCH_DIAGNOSTICS_AVAILABLE: bool = cfg!(all(
    feature = "view-batch-diagnostics",
    any(
        target_os = "android",
        target_os = "linux",
        target_os = "macos",
        target_os = "ios"
    )
));

/// Thread-affine RAII guard: an Android section always ends on its owner thread,
/// including an early native return or Rust unwinding. No VM calls are made.
pub struct ViewBatchProbe {
    #[cfg(all(
        feature = "view-batch-diagnostics",
        any(
            target_os = "android",
            target_os = "linux",
            target_os = "macos",
            target_os = "ios"
        )
    ))]
    active: Option<native::ActiveProbe>,
    // A probe must not be moved to a watchdog/UI thread before ending its slice.
    _owner: PhantomData<Rc<()>>,
}

impl ViewBatchProbe {
    #[inline]
    pub fn begin(engine: ViewProbeEngine, modern: bool, entrypoint: &str) -> Self {
        #[cfg(all(
            feature = "view-batch-diagnostics",
            any(
                target_os = "android",
                target_os = "linux",
                target_os = "macos",
                target_os = "ios"
            )
        ))]
        {
            Self {
                active: Some(native::ActiveProbe::begin(
                    engine,
                    modern,
                    ViewProbeOperation::from_entrypoint(entrypoint),
                )),
                _owner: PhantomData,
            }
        }
        #[cfg(not(all(
            feature = "view-batch-diagnostics",
            any(
                target_os = "android",
                target_os = "linux",
                target_os = "macos",
                target_os = "ios"
            )
        )))]
        {
            let _ = (engine, modern, entrypoint);
            Self {
                _owner: PhantomData,
            }
        }
    }

    #[inline]
    pub fn finish(mut self, error: Option<ViewEngineErrorCode>) -> Option<ViewBatchDiagnostics> {
        #[cfg(all(
            feature = "view-batch-diagnostics",
            any(
                target_os = "android",
                target_os = "linux",
                target_os = "macos",
                target_os = "ios"
            )
        ))]
        {
            self.active.take().map(|active| active.finish(error))
        }
        #[cfg(not(all(
            feature = "view-batch-diagnostics",
            any(
                target_os = "android",
                target_os = "linux",
                target_os = "macos",
                target_os = "ios"
            )
        )))]
        {
            let _ = (&mut self, error);
            None
        }
    }
}

#[cfg(all(
    feature = "view-batch-diagnostics",
    any(
        target_os = "android",
        target_os = "linux",
        target_os = "macos",
        target_os = "ios"
    )
))]
mod native {
    use super::*;
    use std::cell::Cell;

    thread_local! { static SEQUENCE: Cell<u64> = const { Cell::new(0) }; }

    fn sequence_from<T: 'static>(
        key: &'static std::thread::LocalKey<T>,
        counter: impl FnOnce(&T) -> &Cell<u64>,
    ) -> Option<u64> {
        key.try_with(|value| next_sequence(counter(value)))
            .ok()
            .flatten()
    }

    fn next_sequence(sequence: &Cell<u64>) -> Option<u64> {
        let next = sequence.get().checked_add(1)?;
        sequence.set(next);
        Some(next)
    }

    fn ns(seconds: libc::time_t, nanos: libc::c_long) -> Option<u64> {
        checked_ns(u64::try_from(seconds).ok()?, u64::try_from(nanos).ok()?)
    }

    fn checked_ns(seconds: u64, nanos: u64) -> Option<u64> {
        if nanos >= 1_000_000_000 {
            return None;
        }
        seconds.checked_mul(1_000_000_000)?.checked_add(nanos)
    }

    fn clock(id: libc::clockid_t) -> Option<u64> {
        let mut value = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: local timespec is valid for the synchronous platform call.
        if unsafe { libc::clock_gettime(id, &mut value) } != 0 {
            return None;
        }
        ns(value.tv_sec, value.tv_nsec)
    }

    fn boottime() -> Option<u64> {
        #[cfg(any(target_os = "android", target_os = "linux"))]
        {
            clock(libc::CLOCK_BOOTTIME)
        }
        // Do not relabel Apple's monotonic clock as Linux CLOCK_BOOTTIME.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            None
        }
    }

    fn tid() -> Option<u64> {
        #[cfg(any(target_os = "android", target_os = "linux"))]
        {
            // SAFETY: gettid takes no pointers and does not mutate guest state.
            let value = unsafe { libc::syscall(libc::SYS_gettid) };
            u64::try_from(value).ok().filter(|value| *value > 0)
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            let mut value = 0u64;
            // SAFETY: thread zero selects this thread; value is a live output.
            let status = unsafe { libc::pthread_threadid_np(0, &mut value) };
            (status == 0 && value != 0).then_some(value)
        }
    }

    #[derive(Clone, Copy)]
    struct Samples {
        monotonic: Option<u64>,
        boottime: Option<u64>,
        cpu: Option<u64>,
    }

    impl Samples {
        fn start() -> Self {
            // CPU is nested inside both wall-clock observation windows.
            let monotonic = clock(libc::CLOCK_MONOTONIC);
            let boottime = boottime();
            let cpu = clock(libc::CLOCK_THREAD_CPUTIME_ID);
            Self {
                monotonic,
                boottime,
                cpu,
            }
        }
        fn end() -> Self {
            let cpu = clock(libc::CLOCK_THREAD_CPUTIME_ID);
            let boottime = boottime();
            let monotonic = clock(libc::CLOCK_MONOTONIC);
            Self {
                monotonic,
                boottime,
                cpu,
            }
        }
    }

    #[derive(Clone, Copy)]
    pub(super) struct PhaseSamples {
        monotonic: Option<u64>,
        cpu: Option<u64>,
    }

    impl PhaseSamples {
        pub(super) fn start() -> Self {
            let monotonic = clock(libc::CLOCK_MONOTONIC);
            let cpu = clock(libc::CLOCK_THREAD_CPUTIME_ID);
            Self { monotonic, cpu }
        }
        pub(super) fn end() -> Self {
            let cpu = clock(libc::CLOCK_THREAD_CPUTIME_ID);
            let monotonic = clock(libc::CLOCK_MONOTONIC);
            Self { monotonic, cpu }
        }
    }

    pub(super) fn phase_timing(
        start: PhaseSamples,
        end: PhaseSamples,
        completed: bool,
    ) -> ViewPhaseMeasurement {
        ViewPhaseMeasurement {
            completed,
            monotonic_start: start.monotonic,
            monotonic_end: end.monotonic,
            cpu_start: start.cpu,
            cpu_end: end.cpu,
        }
    }

    pub(super) struct ActiveProbe {
        engine: ViewProbeEngine,
        modern: bool,
        operation: ViewProbeOperation,
        sequence: Option<u64>,
        tid: Option<u64>,
        start: Samples,
        trace: TraceSection,
    }

    impl ActiveProbe {
        pub(super) fn begin(
            engine: ViewProbeEngine,
            modern: bool,
            operation: ViewProbeOperation,
        ) -> Self {
            let sequence = sequence_from(&SEQUENCE, |value| value);
            let tid = tid();
            let start = Samples::start();
            let trace = TraceSection::begin(engine, modern, operation, sequence);
            Self {
                engine,
                modern,
                operation,
                sequence,
                tid,
                start,
                trace,
            }
        }
        pub(super) fn finish(mut self, error: Option<ViewEngineErrorCode>) -> ViewBatchDiagnostics {
            self.trace.end();
            let end = Samples::end();
            diagnostics(&self, end, error)
        }
    }

    fn diagnostics(
        probe: &ActiveProbe,
        end: Samples,
        error: Option<ViewEngineErrorCode>,
    ) -> ViewBatchDiagnostics {
        let text = |value: Option<u64>| value.map(|value| value.to_string());
        ViewBatchDiagnostics {
            schema_version: 1,
            engine: probe.engine,
            modern: probe.modern,
            operation: probe.operation,
            batch_sequence: text(probe.sequence),
            owner_thread_id: text(probe.tid),
            monotonic_start_ns: text(probe.start.monotonic),
            monotonic_end_ns: text(end.monotonic),
            boottime_start_ns: text(probe.start.boottime),
            boottime_end_ns: text(end.boottime),
            thread_cpu_start_ns: text(probe.start.cpu),
            thread_cpu_end_ns: text(end.cpu),
            thread_cpu_elapsed_ns: text(
                probe
                    .start
                    .cpu
                    .zip(end.cpu)
                    .and_then(|(start, end)| end.checked_sub(start)),
            ),
            error_code: error.map(|error| error.as_str().into()),
            android_trace_enabled: probe.trace.enabled,
            android_trace_emitted: probe.trace.emitted,
        }
    }

    struct TraceSection {
        enabled: Option<bool>,
        emitted: bool,
        open: bool,
    }
    impl TraceSection {
        fn begin(
            engine: ViewProbeEngine,
            modern: bool,
            operation: ViewProbeOperation,
            sequence: Option<u64>,
        ) -> Self {
            #[cfg(all(feature = "android-view-atrace", target_os = "android"))]
            {
                // SAFETY: no arguments, available since Android API23.
                let enabled = unsafe { android::ATrace_isEnabled() };
                let emitted = if let Some(sequence) = sequence.filter(|_| enabled) {
                    // Entire label derives from closed enums and a native counter.
                    let mut label = format!(
                        "wc.view.{engine:?}.{}.{operation:?}#{}",
                        if modern { "m" } else { "l" },
                        sequence
                    );
                    label.push('\0');
                    // SAFETY: bounded NUL-terminated label lives through this call.
                    unsafe { android::ATrace_beginSection(label.as_ptr().cast()) };
                    true
                } else {
                    false
                };
                Self {
                    enabled: Some(enabled),
                    emitted,
                    open: emitted,
                }
            }
            #[cfg(not(all(feature = "android-view-atrace", target_os = "android")))]
            {
                let _ = (engine, modern, operation, sequence);
                Self {
                    enabled: None,
                    emitted: false,
                    open: false,
                }
            }
        }
        fn end(&mut self) {
            if !self.open {
                return;
            }
            self.open = false;
            #[cfg(all(feature = "android-view-atrace", target_os = "android"))]
            // SAFETY: this thread-affine guard opened exactly one matching section.
            unsafe {
                android::ATrace_endSection()
            };
        }
    }
    impl Drop for TraceSection {
        fn drop(&mut self) {
            self.end();
        }
    }

    #[cfg(all(feature = "android-view-atrace", target_os = "android"))]
    mod android {
        #[link(name = "android")]
        extern "C" {
            pub(super) fn ATrace_isEnabled() -> bool;
            pub(super) fn ATrace_beginSection(name: *const libc::c_char);
            pub(super) fn ATrace_endSection();
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn invalid_or_regressed_clocks_never_become_zero_durations() {
            assert_eq!(ns(-1, 0), None);
            assert_eq!(ns(0, -1), None);
            assert_eq!(ns(0, 1_000_000_000), None);
            // Test the u64 arithmetic boundary directly: time_t may be 32-bit,
            // where every nonnegative seconds value fits in u64 nanoseconds.
            let last_second = u64::MAX / 1_000_000_000;
            let last_nanos = u64::MAX % 1_000_000_000;
            assert_eq!(checked_ns(last_second, last_nanos), Some(u64::MAX));
            assert_eq!(checked_ns(last_second, last_nanos + 1), None);
            assert_eq!(checked_ns(last_second + 1, 0), None);
            assert_eq!(checked_ns(0, 999_999_999), Some(999_999_999));
            let probe = ActiveProbe {
                engine: ViewProbeEngine::Quickjs,
                modern: false,
                operation: ViewProbeOperation::Render,
                sequence: Some(u64::MAX),
                tid: None,
                start: Samples {
                    monotonic: None,
                    boottime: None,
                    cpu: Some(9),
                },
                trace: TraceSection {
                    enabled: None,
                    emitted: false,
                    open: false,
                },
            };
            let record = diagnostics(
                &probe,
                Samples {
                    monotonic: None,
                    boottime: None,
                    cpu: Some(8),
                },
                None,
            );
            assert_eq!(record.thread_cpu_elapsed_ns, None);
            assert_eq!(record.monotonic_start_ns, None);
            assert_eq!(
                record.batch_sequence.as_deref(),
                Some("18446744073709551615")
            );
        }
        static DESTROYED_TLS_OUTCOME: std::sync::atomic::AtomicU8 =
            std::sync::atomic::AtomicU8::new(0);
        struct DyingSequence(Cell<u64>);
        thread_local! { static DYING_SEQUENCE: DyingSequence = const { DyingSequence(Cell::new(0)) }; }
        impl Drop for DyingSequence {
            fn drop(&mut self) {
                let unavailable = sequence_from(&DYING_SEQUENCE, |value| &value.0);
                // Never panic while unwinding TLS; assert the result after join.
                DESTROYED_TLS_OUTCOME.store(
                    if unavailable.is_none() { 1 } else { 2 },
                    std::sync::atomic::Ordering::Release,
                );
            }
        }
        #[test]
        fn destroyed_tls_is_unavailable_without_panic_or_reused_id() {
            DESTROYED_TLS_OUTCOME.store(0, std::sync::atomic::Ordering::Release);
            std::thread::spawn(|| {
                assert_eq!(sequence_from(&DYING_SEQUENCE, |value| &value.0), Some(1));
                assert_eq!(sequence_from(&DYING_SEQUENCE, |value| &value.0), Some(2));
            })
            .join()
            .unwrap();
            assert_eq!(
                DESTROYED_TLS_OUTCOME.load(std::sync::atomic::Ordering::Acquire),
                1
            );
        }
        #[test]
        fn exhausted_sequence_never_wraps_or_reuses_an_id() {
            let sequence = Cell::new(u64::MAX - 1);
            assert_eq!(next_sequence(&sequence), Some(u64::MAX));
            assert_eq!(next_sequence(&sequence), None);
            assert_eq!(next_sequence(&sequence), None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_entrypoint_does_not_export_its_contents() {
        assert_eq!(
            ViewProbeOperation::from_entrypoint("PRIVATE_GUEST_SENTINEL"),
            ViewProbeOperation::Unknown
        );
        let probe =
            ViewBatchProbe::begin(ViewProbeEngine::Quickjs, false, "PRIVATE_GUEST_SENTINEL");
        let record = probe.finish(Some(ViewEngineErrorCode::Cancelled));
        assert_eq!(record.is_some(), VIEW_BATCH_DIAGNOSTICS_AVAILABLE);
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains("PRIVATE_GUEST_SENTINEL"));
        #[cfg(not(all(
            feature = "view-batch-diagnostics",
            any(
                target_os = "android",
                target_os = "linux",
                target_os = "macos",
                target_os = "ios"
            )
        )))]
        assert_eq!(json, "null");
    }
}

#[cfg(test)]
mod phase_measurement_tests {
    use super::*;

    fn batch() -> ViewBatchDiagnostics {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "engine": "quickjs", "modern": false,
            "operation": "renderRegistered", "batchSequence": "17",
            "ownerThreadId": "23", "androidTraceEmitted": false
        }))
        .unwrap()
    }

    #[test]
    fn failed_api_and_unavailable_clocks_remain_unknown_not_zero() {
        let sample = ViewPhaseMeasurement {
            completed: false,
            monotonic_start: Some(10),
            monotonic_end: Some(20),
            cpu_start: None,
            cpu_end: Some(9),
        };
        let detail = ViewBatchPhaseSamples {
            json_stringify_api: Some(sample),
            ..Default::default()
        }
        .into_breakdown(&batch());
        let phase = detail.phases.json_stringify_api.unwrap();
        assert!(!phase.completed);
        assert_eq!(phase.wall_elapsed_ns.as_deref(), Some("10"));
        assert_eq!(phase.thread_cpu_elapsed_ns, None);
        assert_eq!(detail.phases.output_bytes, None);
        assert_eq!(detail.phases.utf8_copy_api, None);
    }

    #[test]
    fn regressing_clocks_do_not_underflow_and_real_zero_is_preserved() {
        let phase = ViewPhaseMeasurement {
            completed: true,
            monotonic_start: Some(20),
            monotonic_end: Some(10),
            cpu_start: Some(0),
            cpu_end: Some(0),
        }
        .into_timing();
        assert_eq!(phase.wall_elapsed_ns, None);
        assert_eq!(phase.monotonic_end_ns.as_deref(), Some("10"));
        assert_eq!(phase.thread_cpu_elapsed_ns.as_deref(), Some("0"));
    }

    #[test]
    fn late_wire_binding_keeps_the_actual_batch_and_legacy_schema_unchanged() {
        let legacy = batch();
        let detail = ViewBatchPhaseSamples {
            output_bytes: Some(0),
            ..Default::default()
        }
        .into_breakdown(&legacy);
        assert_eq!(detail.schema_version, 1);
        assert_eq!(detail.batch_sequence, legacy.batch_sequence);
        assert_eq!(detail.owner_thread_id, legacy.owner_thread_id);
        assert_eq!(detail.operation, ViewProbeOperation::RenderRegistered);
        assert_eq!(detail.phases.output_bytes.as_deref(), Some("0"));
        assert_eq!(
            serde_json::to_value(&legacy)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            16
        );
        let mut first = crate::ViewEngineTimings {
            last_batch: Some(legacy),
            last_batch_breakdown: Some(detail),
            ..Default::default()
        };
        first.accumulate(&crate::ViewEngineTimings::default());
        assert!(first.last_batch.is_none());
        assert!(first.last_batch_breakdown.is_none());
    }
}
