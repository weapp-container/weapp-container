#![cfg(feature = "v8-native")]

use container_engine_v8::V8Engine;

include!("../../container-engine-quickjs/tests/support/timer_contract.rs");
timer_engine_contract_tests!(V8Engine::default());
