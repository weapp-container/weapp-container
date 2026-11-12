#![cfg(all(feature = "v8-native", feature = "conformance-observation"))]

#[path = "../../container-core/test-support/conformance-guest-contract.rs"]
mod contract;

use container_core::{
    CallTarget, ConformanceGuestObservation, ConformanceGuestRequest, JsEngine, ModuleId,
};
use container_engine_v8::V8Engine as Engine;
use serde_json::{json, Value};

struct Harness {
    engine: Engine,
    module: ModuleId,
    active: Option<u64>,
}
impl Harness {
    fn new() -> Self {
        let mut engine = Engine::default();
        engine
            .set_capabilities(&std::collections::BTreeMap::from([(
                "getCurrentPages".into(),
                "full".into(),
            )]))
            .unwrap();
        let module = JsEngine::load_module(&mut engine, contract::FIXTURE).unwrap();
        let mut harness = Self {
            engine,
            module,
            active: None,
        };
        contract::Harness::activate(&mut harness, 1);
        harness
    }
}
impl contract::Harness for Harness {
    fn observe(
        &mut self,
        request: ConformanceGuestRequest,
    ) -> Result<ConformanceGuestObservation, String> {
        self.engine
            .observe_conformance_guest(&request)
            .map_err(|error| error.to_string())
    }
    fn call(&mut self, export: &str, args: Vec<Value>) -> Vec<Value> {
        JsEngine::call(
            &mut self.engine,
            CallTarget::Module {
                id: self.module,
                export: export.into(),
            },
            args,
        )
        .unwrap()
    }
    fn activate(&mut self, id: u64) {
        if let Some(previous) = self.active.take() {
            JsEngine::call(
                &mut self.engine,
                CallTarget::Global {
                    name: "__container_invoke_page_instance".into(),
                },
                vec![json!(previous), json!(0), json!("onUnload"), json!([])],
            )
            .unwrap();
        }
        let publication = format!("conformance-page-{id}");
        self.engine
            .prepare_page_mirror(
                &publication,
                &json!([{"index":0,"instanceId":id,"route":"pages/index","options":{}}]),
            )
            .unwrap();
        self.engine.commit_page_mirror(&publication).unwrap();
        JsEngine::call(
            &mut self.engine,
            CallTarget::Global {
                name: "__container_invoke_page_instance".into(),
            },
            vec![json!(id), json!(0), json!("onLoad"), json!([])],
        )
        .unwrap();
        self.active = Some(id);
    }
    fn drain(&mut self) {
        JsEngine::drain_microtasks(&mut self.engine).unwrap();
    }
}

#[test]
fn actual_receiver_values() {
    contract::actual_receiver_values(Harness::new());
}
#[test]
fn pending_settlement_and_cancellation() {
    contract::pending_settlement_and_cancellation(Harness::new());
}
#[test]
fn thrown_and_rejected_values() {
    contract::thrown_and_rejected_values(Harness::new());
}
#[test]
fn strict_json_and_thenable_domain() {
    contract::strict_json_and_thenable_domain(Harness::new());
}
#[test]
fn retired_binding_and_new_incarnation() {
    contract::retired_binding_and_new_incarnation(Harness::new());
}
#[test]
fn lookup_revalidates_before_apply() {
    contract::lookup_revalidates_before_apply(Harness::new());
}
#[test]
fn captured_intrinsics_and_single_projection() {
    contract::captured_intrinsics_and_single_projection(Harness::new());
}

#[test]
fn retirement_before_promise_or_projection() {
    contract::retirement_before_promise_or_projection(Harness::new());
}

#[test]
fn reentrant_method_getter_and_owner_tombstone() {
    contract::reentrant_method_getter_and_owner_tombstone(Harness::new());
}
#[test]
fn irreversible_owner_ledger_exhaustion() {
    contract::irreversible_owner_ledger_exhaustion(Harness::new());
}

#[test]
fn native_promise_species_retires_receiver() {
    contract::native_promise_species_retires_receiver(Harness::new());
}

#[test]
fn private_data_reads() {
    contract::private_data_reads(Harness::new());
}
#[test]
fn native_runtime_log_journal() {
    contract::native_runtime_log_journal(Harness::new());
}
#[test]
fn native_runtime_log_overflow() {
    contract::native_runtime_log_overflow(Harness::new());
}
#[test]
fn native_runtime_log_accessors() {
    contract::native_runtime_log_accessors(Harness::new());
}

#[test]
fn private_component_data_reads() {
    contract::private_component_data_reads(Harness::new());
}

#[test]
fn native_runtime_log_text_budget() {
    contract::native_runtime_log_text_budget(Harness::new());
}
#[test]
fn native_runtime_log_empty_object() {
    contract::native_runtime_log_empty_object(Harness::new());
}

#[test]
fn native_runtime_log_error_object() {
    contract::native_runtime_log_error_object(Harness::new());
}

#[test]
fn native_runtime_log_stack_hook() {
    contract::native_runtime_log_stack_hook(Harness::new());
}
