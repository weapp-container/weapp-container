#![cfg(feature = "quickjs-native")]
use container_engine_quickjs::{QuickJsConfig, QuickJsViewEngine};
include!("../../container-core/tests/support/view_engine.rs");
view_engine_contract_tests!(QuickJsViewEngine::new(QuickJsConfig::default()).unwrap());
