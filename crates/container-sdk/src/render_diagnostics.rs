//! Bounded observations of actual SDK work. ACK cadence is not a display
//! refresh clock: idle time and missing host callbacks cannot prove dropped FPS.
use serde_json::{json, Value};
use std::{collections::VecDeque, time::Instant};

#[derive(Default)]
pub(super) struct RenderDiagnostics {
    frames: VecDeque<Frame>,
    snapshot_captures: u64,
    snapshot_cache_hits: u64,
    last_ack: Option<(u64, Instant)>,
}

struct Frame {
    generation: u64,
    revision: u64,
    accepted: Instant,
    facts: Value,
    snapshot_ms: Option<f64>,
    acknowledged: bool,
    ack_wait_ms: Option<f64>,
    ack_interval_ms: Option<f64>,
}

impl RenderDiagnostics {
    pub(super) fn accepted(&mut self, generation: u64, revision: u64, facts: Value) {
        if self.frames.len() == 120 {
            self.frames.pop_front();
        }
        self.frames.push_back(Frame {
            generation,
            revision,
            accepted: Instant::now(),
            facts,
            snapshot_ms: None,
            acknowledged: false,
            ack_wait_ms: None,
            ack_interval_ms: None,
        });
    }

    pub(super) fn snapshot(&mut self, revision: u64, elapsed_ms: Option<f64>) {
        if let Some(ms) = elapsed_ms {
            self.snapshot_captures = self.snapshot_captures.saturating_add(1);
            if let Some(frame) = self
                .frames
                .back_mut()
                .filter(|frame| frame.revision == revision)
            {
                frame.snapshot_ms = Some(ms);
            }
        } else {
            self.snapshot_cache_hits = self.snapshot_cache_hits.saturating_add(1);
        }
    }

    pub(super) fn acknowledged(&mut self, generation: u64, revision: u64) {
        let Some(frame) = self.frames.iter_mut().rev().find(|frame| {
            frame.generation == generation && frame.revision == revision && !frame.acknowledged
        }) else {
            return;
        };
        let now = Instant::now();
        frame.acknowledged = true;
        frame.ack_wait_ms = Some(now.duration_since(frame.accepted).as_secs_f64() * 1000.0);
        frame.ack_interval_ms = self
            .last_ack
            .filter(|(previous, _)| *previous == generation)
            .map(|(_, time)| now.duration_since(time).as_secs_f64() * 1000.0);
        self.last_ack = Some((generation, now));
    }

    pub(super) fn report(&self) -> Value {
        json!({"schemaVersion":1,"scope":"sdk-accepted-frame-and-host-ack",
            "displayFrameClockAttached":false,"scrollFps":null,"droppedFrameRate":null,
            "snapshotCaptures":self.snapshot_captures,"snapshotCacheHits":self.snapshot_cache_hits,
            "frames":self.frames.iter().map(|frame| json!({
                "generation":frame.generation.to_string(),"revision":frame.revision.to_string(),
                "render":frame.facts,"cpuSnapshotMs":frame.snapshot_ms,
                "hostAcknowledged":frame.acknowledged,"acceptToHostAckMs":frame.ack_wait_ms,
                "hostAckIntervalMs":frame.ack_interval_ms,
            })).collect::<Vec<_>>()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_ack_and_retained_history_do_not_invent_display_samples() {
        let mut trace = RenderDiagnostics::default();
        for revision in 1..=121 {
            trace.accepted(1, revision, json!({"backend":"software-fallback"}));
        }
        trace.acknowledged(1, 120);
        trace.acknowledged(1, 121);
        let before = trace.report();
        trace.acknowledged(1, 121);
        trace.acknowledged(2, 121);
        assert_eq!(trace.report(), before);
        assert_eq!(before["frames"].as_array().unwrap().len(), 120);
        assert!(before["droppedFrameRate"].is_null());
        assert_eq!(before["displayFrameClockAttached"], false);
    }
}
