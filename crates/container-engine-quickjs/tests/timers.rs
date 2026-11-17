#![cfg(feature = "quickjs-native")]

use container_engine_quickjs::{QuickJsConfig, QuickJsEngine};

include!("support/timer_contract.rs");
timer_engine_contract_tests!(QuickJsEngine::new(QuickJsConfig::default()));
