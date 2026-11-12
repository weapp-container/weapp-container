use container_core::view_probe::{ViewBatchDiagnostics, ViewBatchPhaseSamples};
use container_core::ViewEngineTimings;

#[test]
fn absent_detail_does_not_extend_legacy_provider_wire_shape() {
    let wire = serde_json::to_value(ViewEngineTimings::default()).unwrap();
    assert!(!wire.as_object().unwrap().contains_key("lastBatchBreakdown"));
    assert!(wire.as_object().unwrap().contains_key("lastBatch"));
    let decoded: ViewEngineTimings = serde_json::from_value(wire).unwrap();
    assert!(decoded.last_batch_breakdown.is_none());
}

#[test]
fn enabled_detail_remains_explicit_and_requires_the_new_parser() {
    let batch: ViewBatchDiagnostics = serde_json::from_value(serde_json::json!({
        "schemaVersion":1,"engine":"quickjs","modern":false,"operation":"render",
        "batchSequence":"7","ownerThreadId":"9","androidTraceEmitted":false
    }))
    .unwrap();
    let phases = ViewBatchPhaseSamples {
        output_bytes: Some(0),
        ..Default::default()
    };
    let stages = ViewEngineTimings {
        last_batch_breakdown: Some(phases.into_breakdown(&batch)),
        last_batch: Some(batch),
        ..Default::default()
    };
    let wire = serde_json::to_value(&stages).unwrap();
    assert_eq!(wire["lastBatchBreakdown"]["schemaVersion"], 1);
    assert_eq!(wire["lastBatchBreakdown"]["phases"]["outputBytes"], "0");
    assert_eq!(
        serde_json::from_value::<ViewEngineTimings>(wire).unwrap(),
        stages
    );
}
