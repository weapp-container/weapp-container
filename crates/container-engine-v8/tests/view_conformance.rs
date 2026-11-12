#![cfg(feature = "v8-native")]
use container_engine_v8::{V8Config, V8ViewEngine};
include!("../../container-core/tests/support/view_engine.rs");
view_engine_contract_tests!(V8ViewEngine::new(V8Config::default()).unwrap());
