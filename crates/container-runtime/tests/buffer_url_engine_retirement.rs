//! Retain the actual native byte owner across engine retirement. These tests
//! deliberately query the store before dropping or re-entering the engine.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_core::{BufferUrlStore, CallTarget, JsEngine};
use std::sync::Arc;

macro_rules! suite {
    ($module:ident, $engine:ty, $adapter:path) => {
        mod $module {
            use super::*;

            pub(super) fn leased_engine() -> ($engine, Arc<BufferUrlStore>, String) {
                let mut engine = <$engine>::default();
                engine
                    .set_capabilities(&std::collections::BTreeMap::from([
                        ("wx.createBufferURL".into(), "full".into()),
                        ("wx.revokeBufferURL".into(), "full".into()),
                    ]))
                    .unwrap();
                let module = JsEngine::load_module(
                    &mut engine,
                    br#"exports.make=()=>wx.createBufferURL(new Uint8Array([0,128,255]));"#,
                )
                .unwrap();
                let url = JsEngine::call(
                    &mut engine,
                    CallTarget::Module {
                        id: module,
                        export: "make".into(),
                    },
                    vec![],
                )
                .unwrap()
                .remove(0)
                .as_str()
                .unwrap()
                .to_owned();
                let store = engine.buffer_url_store().unwrap();
                assert_eq!(&*store.resolve(&url).unwrap(), &[0, 128, 255]);
                (engine, store, url)
            }

            #[test]
            fn core_interrupt_retires_retained_owner_before_engine_drop() {
                let (mut engine, store, url) = leased_engine();
                JsEngine::interrupt(&mut engine);
                assert!(store.resolve(&url).is_err());
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&store.invoke_json("create", "00"))
                        .unwrap()["ok"],
                    false
                );
                // Engine is deliberately still alive at the assertions.
                assert!(engine.buffer_url_store().is_some());
            }

            #[test]
            fn adapter_interrupt_retires_retained_owner_before_engine_drop() {
                let (mut engine, store, url) = leased_engine();
                <$engine as $adapter>::interrupt(&mut engine);
                assert!(store.resolve(&url).is_err());
                assert!(engine.buffer_url_store().is_some());
            }
        }
    };
}

#[cfg(feature = "quickjs-native")]
suite!(
    quickjs,
    container_engine_quickjs::QuickJsEngine,
    container_engine_quickjs::JsEngineAdapter
);
#[cfg(feature = "v8-native")]
suite!(
    v8,
    container_engine_v8::V8Engine,
    container_engine_v8::JsEngineAdapter
);

#[cfg(feature = "quickjs-native")]
mod quickjs_host_turn_faults {
    use super::*;
    use container_core::{EngineErrorCode, EngineExecutionBudget};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[test]
    fn cancellation_at_outer_guard_finish_retires_without_engine_reentry() {
        let (mut engine, store, url) = quickjs::leased_engine();
        let cancellation = Arc::new(AtomicBool::new(false));
        let guard = engine
            .begin_host_turn(EngineExecutionBudget {
                timeout: None,
                cancellation: Some(cancellation.clone()),
            })
            .unwrap();
        cancellation.store(true, Ordering::Release);
        assert_eq!(guard.finish().unwrap_err().code, EngineErrorCode::Cancelled);
        assert!(store.resolve(&url).is_err());
    }

    #[test]
    fn timeout_at_outer_guard_finish_retires_without_engine_reentry() {
        let (mut engine, store, url) = quickjs::leased_engine();
        let guard = engine
            .begin_host_turn(EngineExecutionBudget {
                timeout: Some(Duration::from_millis(1)),
                cancellation: None,
            })
            .unwrap();
        std::thread::sleep(Duration::from_millis(10));
        assert_eq!(guard.finish().unwrap_err().code, EngineErrorCode::Timeout);
        assert!(store.resolve(&url).is_err());
    }

    #[test]
    fn abandoned_outer_guard_retires_without_engine_reentry() {
        let (mut engine, store, url) = quickjs::leased_engine();
        let guard = engine
            .begin_host_turn(EngineExecutionBudget::unbounded())
            .unwrap();
        drop(guard);
        assert!(store.resolve(&url).is_err());
    }

    #[test]
    fn rejected_preflight_budgets_preserve_the_healthy_owner() {
        let (mut engine, store, url) = quickjs::leased_engine();
        for budget in [
            EngineExecutionBudget {
                timeout: Some(Duration::ZERO),
                cancellation: None,
            },
            EngineExecutionBudget {
                timeout: None,
                cancellation: Some(Arc::new(AtomicBool::new(true))),
            },
        ] {
            assert!(engine.begin_host_turn(budget).is_err());
            assert_eq!(&*store.resolve(&url).unwrap(), &[0, 128, 255]);
        }
    }
}
