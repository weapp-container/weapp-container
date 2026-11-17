use container_core::{
    view_probe::{ViewBatchProbe, ViewProbeEngine},
    ViewEngineErrorCode, ViewEngineTimings,
};
use serde::Deserialize;
use serde_json::json;

#[test]
fn old_timings_json_and_old_readers_remain_compatible() {
    let old = json!({"batches":1,"elapsedNs":7,"inputEncodeNs":1,"vmInputParseNs":1,
        "executeIncludingLazyCompileNs":2,"vmOutputEncodeNs":1,"outputDecodeNs":2,"compileNs":null});
    let timings: ViewEngineTimings = serde_json::from_value(old).unwrap();
    assert_eq!(timings.last_batch, None);
    let wire = serde_json::to_value(&timings).unwrap();
    assert_eq!(wire["lastBatch"], serde_json::Value::Null);
    #[derive(Deserialize)]
    struct OldReader {
        batches: u64,
    }
    assert_eq!(
        serde_json::from_value::<OldReader>(wire).unwrap().batches,
        1
    );
}

#[test]
fn aggregated_timings_never_relabel_sum_as_one_cpu_interval() {
    let mut first = ViewEngineTimings {
        batches: 1,
        elapsed_ns: 10,
        last_batch: ViewBatchProbe::begin(
            ViewProbeEngine::Quickjs,
            false,
            "__weappContainer_view_render",
        )
        .finish(None),
        ..ViewEngineTimings::default()
    };
    let last = ViewEngineTimings {
        batches: 1,
        elapsed_ns: 20,
        last_batch: ViewBatchProbe::begin(
            ViewProbeEngine::V8,
            true,
            "__weappContainer_view_render",
        )
        .finish(Some(ViewEngineErrorCode::Cancelled)),
        ..ViewEngineTimings::default()
    };
    first.accumulate(&last);
    assert_eq!(first.batches, 2);
    assert_eq!(first.elapsed_ns, 30);
    assert_eq!(first.last_batch, last.last_batch);
    first.accumulate(&ViewEngineTimings::default());
    assert_eq!(
        first.last_batch, None,
        "unknown last provider must not retain a stale batch"
    );
}
