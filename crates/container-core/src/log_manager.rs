//! Private native LogManager journal. No guest callbacks run while locked.
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};

const MAX_RECORD_BYTES: usize = 102_400 + 1024;
const MAX_JOURNAL_BYTES: usize = 5 * 1024 * 1024;
const MAX_JOURNAL_RECORDS: usize = 8192;
const MAX_DRAIN_RECORDS: usize = 128;
// Includes the second JSON string encoding used by the diagnostic bridge.
const MAX_DRAIN_BYTES: usize = 256 * 1024;

#[derive(Default)]
struct State {
    records: VecDeque<(Value, usize, usize)>,
    bytes: usize,
}

#[derive(Default)]
pub struct LogManagerJournal {
    state: Mutex<State>,
    retired: AtomicBool,
    rejected: AtomicU64,
    fault_reported: AtomicBool,
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogManagerDrain {
    pub records: Vec<Value>,
    pub dropped: u64,
    pub faulted: bool,
}

impl LogManagerJournal {
    /// The complete primitive wire is parsed before locking. A bad log cannot
    /// unwind through either VM ABI or change the caller's ordinary effects.
    pub fn append_json(&self, text: &str) -> bool {
        let accepted = || {
            if self.retired.load(Ordering::Acquire) || text.len() > MAX_RECORD_BYTES {
                return None;
            }
            let value: Value = serde_json::from_str(text).ok()?;
            let object = value.as_object()?;
            if object.len() != 6
                || object.get("version")?.as_u64()? != 1
                || object.get("source")?.as_str()? != "logManager"
                || !matches!(
                    object.get("level")?.as_str()?,
                    "debug" | "info" | "log" | "warn"
                )
                || !matches!(
                    object.get("kind")?.as_str()?,
                    "explicit" | "api" | "lifecycle"
                )
                || object.get("name")?.as_str()?.len() > 256
                || !object.get("arguments")?.is_object()
            {
                return None;
            }
            let message = serde_json::to_string(&value).ok()?;
            let bridge_bytes = serde_json::to_string(&message).ok()?.len() + 128;
            if bridge_bytes > MAX_DRAIN_BYTES {
                return None;
            }
            let mut state = self.state.lock().ok()?;
            if self.retired.load(Ordering::Acquire) {
                return None;
            }
            while state.bytes + text.len() > MAX_JOURNAL_BYTES
                || state.records.len() >= MAX_JOURNAL_RECORDS
            {
                if let Some((_, size, _)) = state.records.pop_front() {
                    state.bytes -= size;
                    self.rejected.fetch_add(1, Ordering::Relaxed);
                } else {
                    return None;
                }
            }
            state.bytes += text.len();
            state.records.push_back((value, text.len(), bridge_bytes));
            Some(())
        };
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(accepted))
            .ok()
            .flatten()
            .is_some()
        {
            true
        } else {
            self.rejected.fetch_add(1, Ordering::Relaxed);
            false
        }
    }

    /// Host-only drain; this is never installed as a writable JS global.
    pub fn take(&self) -> LogManagerDrain {
        let Ok(mut state) = self.state.lock() else {
            return LogManagerDrain {
                records: Vec::new(),
                dropped: self.rejected.swap(0, Ordering::AcqRel),
                faulted: !self.fault_reported.swap(true, Ordering::AcqRel),
            };
        };
        let mut records = Vec::new();
        let mut drained_bytes = 0;
        for _ in 0..MAX_DRAIN_RECORDS {
            let Some((_, _, bridge_bytes)) = state.records.front() else {
                break;
            };
            if drained_bytes + bridge_bytes > MAX_DRAIN_BYTES {
                break;
            }
            let Some((value, size, bridge_bytes)) = state.records.pop_front() else {
                break;
            };
            drained_bytes += bridge_bytes;
            state.bytes -= size;
            records.push(value);
        }
        LogManagerDrain {
            records,
            dropped: self.rejected.swap(0, Ordering::AcqRel),
            faulted: false,
        }
    }

    /// Native admission is permanent after terminal owner retirement. The guest
    /// producer only receives this boolean, never the journal or its drain.
    pub fn is_active(&self) -> bool {
        !self.retired.load(Ordering::Acquire)
    }

    /// Terminal retirement discards all queued records and dropped counters.
    pub fn retire(&self) {
        self.retired.store(true, Ordering::Release);
        if let Ok(mut state) = self.state.lock() {
            state.records.clear();
            state.bytes = 0;
        }
        self.rejected.store(0, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(text: &str) -> String {
        serde_json::json!({"version":1,"source":"logManager","level":"log","kind":"explicit","name":"LogManager.log","arguments":{"roots":[0],"nodes":[{"type":"string","value":text}]}}).to_string()
    }
    #[test]
    fn journal_preserves_full_record_and_drains_exactly_once() {
        let journal = LogManagerJournal::default();
        let text = "x".repeat(50_000);
        assert!(journal.append_json(&record(&text)));
        let records = journal.take().records;
        assert_eq!(records[0]["arguments"]["nodes"][0]["value"], text);
        assert!(journal.take().records.is_empty());
    }
    #[test]
    fn journal_rejects_bad_wire_and_retired_ingress_without_panicking() {
        let journal = LogManagerJournal::default();
        assert!(!journal.append_json("bad-json"));
        assert_eq!(journal.take().dropped, 1);
        journal.retire();
        assert!(!journal.append_json(&record("late")));
        assert!(journal.take().records.is_empty());
    }
    #[test]
    fn native_liveness_queries_do_not_count_drops_and_retirement_discards_tail() {
        let journal = LogManagerJournal::default();
        for _ in 0..3 {
            assert!(journal.is_active());
        }
        let empty = journal.take();
        assert!(empty.records.is_empty());
        assert_eq!(empty.dropped, 0);
        assert!(journal.append_json(&record("queued")));
        journal.retire();
        for _ in 0..3 {
            assert!(!journal.is_active());
        }
        let retired = journal.take();
        assert!(retired.records.is_empty());
        assert_eq!(retired.dropped, 0);
    }
    #[test]
    fn journal_poison_is_reported_once_and_does_not_escape_native_boundary() {
        let journal = LogManagerJournal::default();
        let _ = std::panic::catch_unwind(|| {
            let _guard = journal.state.lock().unwrap();
            panic!("test poison");
        });
        assert!(!journal.append_json(&record("late")));
        assert!(journal.take().faulted);
        assert!(!journal.take().faulted);
    }
    #[test]
    fn journal_byte_budget_splits_large_records_without_consuming_tail() {
        let journal = LogManagerJournal::default();
        let text = "\\".repeat(50_000);
        for _ in 0..3 {
            assert!(journal.append_json(&record(&text)));
        }
        for _ in 0..3 {
            let drain = journal.take();
            assert_eq!(drain.records.len(), 1);
            let wire = serde_json::json!({"effects":[{"console":{"entries":[{"level":"log","message":drain.records[0].to_string()}]}}]}).to_string();
            assert!(wire.len() < 512 * 1024);
            assert_eq!(drain.records[0]["arguments"]["nodes"][0]["value"], text);
        }
        assert!(journal.take().records.is_empty());
    }
    #[test]
    fn journal_bounds_retention_and_each_host_drain() {
        let journal = LogManagerJournal::default();
        for _ in 0..100 {
            assert!(journal.append_json(&record(&"x".repeat(100_000))));
        }
        let drain = journal.take();
        assert!(drain.dropped > 0);
        assert!(drain.records.len() <= 128);
        assert!(drain.records.len() < 100);
    }
}
