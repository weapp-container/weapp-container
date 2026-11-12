// Shared native adapter contract; diagnostics never execute guest callbacks.
macro_rules! view_probe_contract {
    ($legacy:expr, $modern:expr) => {
        #[test]
        fn diagnostic_success_failure_cancel_and_reset_boundary() {
            use container_core::{ViewEngine, ViewExecutionBudget, ViewRenderBatch,
                ViewRenderDocument, ViewRenderTask, ViewExpressionTask, ViewEngineErrorCode};
            use std::{collections::BTreeMap, sync::atomic::Ordering, time::Duration};
            let diagnostics_available = container_core::view_probe::VIEW_BATCH_DIAGNOSTICS_AVAILABLE;
            for mut engine in [$legacy, $modern] {
                let budget = ViewExecutionBudget::default();
                assert_eq!(budget.timeout, Duration::from_millis(50));
                engine.load_modules(&[], &budget).unwrap();
                let batch = ViewRenderBatch { documents: vec![ViewRenderDocument {
                    document_id:"home.wxml".into(), ast:serde_json::json!({"version":1,"nodes":[]}),
                    bindings:BTreeMap::new(), compilation:None }], tasks:vec![ViewRenderTask {
                    task_id:"task".into(), scope_id:"scope".into(), document_id:"home.wxml".into(),
                    data:serde_json::json!({}) }] };
                engine.render_batch(&batch, &budget).unwrap();
                let successful = engine.last_timings().expect("actual native batch");
                if diagnostics_available {
                    let record = successful.last_batch.as_ref().expect("native diagnostic");
                    assert_eq!(record.operation, container_core::view_probe::ViewProbeOperation::Render);
                    assert_eq!(record.error_code, None);
                    assert!(record.owner_thread_id.is_some());
                    assert!(record.thread_cpu_elapsed_ns.is_some());
                    assert!(record.monotonic_start_ns.as_ref().unwrap().parse::<u64>().unwrap()
                        <= record.monotonic_end_ns.as_ref().unwrap().parse::<u64>().unwrap());
                }
                if !diagnostics_available { assert_eq!(successful.last_batch, None); }
                let tasks = [ViewExpressionTask { task_id:"throw".into(), scope_id:"scope".into(),
                    document_id:"home.wxml".into(), data:serde_json::json!({}), bindings:BTreeMap::new(),
                    expression:"(() => { throw new Error('PRIVATE_PROBE_SENTINEL'); })()".into() }];
                assert_eq!(engine.evaluate_batch(&tasks,&budget).unwrap_err().code,ViewEngineErrorCode::Execution);
                let failed = engine.last_timings().unwrap();
                assert!(!serde_json::to_string(&failed).unwrap().contains("PRIVATE_PROBE_SENTINEL"));
                if let Some(record) = failed.last_batch.as_ref() {
                    assert_eq!(record.error_code.as_deref(),Some("ERR_VIEW_EXECUTION"));
                    assert_ne!(record.batch_sequence, successful.last_batch.as_ref().unwrap().batch_sequence);
                }
                let cancelled = ViewExecutionBudget::default();
                cancelled.cancellation.store(true,Ordering::Release);
                assert_eq!(engine.render_batch(&batch,&cancelled).unwrap_err().code,ViewEngineErrorCode::Cancelled);
                let cancelled_timings = engine.last_timings();
                if diagnostics_available {
                    assert!(cancelled_timings.as_ref().and_then(|timings|timings.last_batch.as_ref()).is_some());
                }
                if let Some(record) = cancelled_timings.and_then(|timings|timings.last_batch) {
                    assert_eq!(record.error_code.as_deref(),Some("ERR_CANCELLED"));
                }
                assert_eq!(engine.render_batch(&batch,&budget).unwrap_err().code,ViewEngineErrorCode::RequiresReset);
                if !diagnostics_available {
                    assert_eq!(engine.last_timings(), None, "disabled probe preserves original early-return telemetry");
                }
                if diagnostics_available {
                    assert_eq!(engine.last_timings().unwrap().last_batch.unwrap().error_code.as_deref(), Some("ERR_VIEW_REQUIRES_RESET"));
                }
                engine.reset().unwrap();
                engine.load_modules(&[],&budget).unwrap();
                engine.render_batch(&batch,&budget).unwrap();
                // Deterministic expiry without spinning, sleep or changing the default.
                let expired = ViewExecutionBudget::new(Duration::ZERO);
                assert_eq!(engine.render_batch(&batch,&expired).unwrap_err().code,ViewEngineErrorCode::Timeout);
                let timeout_timings = engine.last_timings();
                if diagnostics_available {
                    assert!(timeout_timings.as_ref().and_then(|timings|timings.last_batch.as_ref()).is_some());
                }
                if let Some(record) = timeout_timings.and_then(|timings|timings.last_batch) {
                    assert_eq!(record.error_code.as_deref(),Some("ERR_TIMEOUT"));
                }
                assert_eq!(engine.render_batch(&batch,&budget).unwrap_err().code,ViewEngineErrorCode::RequiresReset);
            }
        }
    };
}
