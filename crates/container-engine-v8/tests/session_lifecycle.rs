#![cfg(feature = "v8-native")]

use container_core::{CallTarget, JsEngine, ModuleId};
use container_engine_v8::V8Engine;
use serde_json::json;

fn load(engine: &mut V8Engine, value: usize) -> ModuleId {
    JsEngine::load_module(
        engine,
        format!("exports.value = () => {value}; exports.fail = () => {{ throw new Error('candidate failed'); }};").as_bytes(),
    )
    .unwrap()
}

fn value(engine: &mut V8Engine, module: ModuleId) -> usize {
    JsEngine::call(
        engine,
        CallTarget::Module {
            id: module,
            export: "value".into(),
        },
        vec![],
    )
    .unwrap()[0]
        .as_u64()
        .unwrap() as usize
}

#[test]
fn validated_candidate_can_replace_an_older_live_session() {
    let mut active = V8Engine::default();
    let mut module = load(&mut active, 0);
    for revision in 1..=4 {
        let mut candidate = V8Engine::default();
        let candidate_module = load(&mut candidate, revision);
        // Interleave turns from both sessions, including a microtask checkpoint.
        assert_eq!(value(&mut active, module), revision - 1);
        JsEngine::drain_microtasks(&mut active).unwrap();
        assert_eq!(value(&mut candidate, candidate_module), revision);
        // This deliberately disposes the older isolate before the candidate.
        active = candidate;
        module = candidate_module;
        assert_eq!(value(&mut active, module), revision);
    }
}

#[test]
fn failed_candidate_releases_its_scope_and_preserves_the_active_session() {
    let mut active = V8Engine::default();
    let module = load(&mut active, 7);
    let mut candidate = V8Engine::default();
    let candidate_module = load(&mut candidate, 9);
    let result = JsEngine::call(
        &mut candidate,
        CallTarget::Module {
            id: candidate_module,
            export: "fail".into(),
        },
        vec![json!("ignored")],
    );
    assert!(result.is_err());
    assert_eq!(value(&mut active, module), 7);
    drop(candidate);
    assert_eq!(value(&mut active, module), 7);
}
