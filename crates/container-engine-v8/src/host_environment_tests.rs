use super::*;
use container_core::{CallTarget, JsEngine};
use serde_json::{json, Value};

fn snapshot(width: u32) -> container_core::HostEnvironmentSnapshot {
    let capabilities = [
        "wx.getWindowInfo",
        "wx.getSystemInfoSync",
        "wx.setStorageSync",
        "wx.getStorageSync",
        "wx.getFileSystemManager",
        "wx.fs.readFileSync",
        "wx.fs.writeFileSync",
    ]
    .into_iter()
    .map(|name| (name.into(), "full".into()))
    .collect();
    container_core::HostEnvironmentSnapshot {
        version: "1.0".into(),
        capabilities,
        dom_query: false,
        sync_api_values: [
            ("wx.getWindowInfo".into(), json!({"windowWidth":width})),
            ("wx.getSystemInfoSync".into(), json!({"windowWidth":width})),
        ]
        .into_iter()
        .collect(),
        sync_api_errors: Default::default(),
        storage: Some(Default::default()),
        files: Some(Default::default()),
    }
}

fn call(engine: &mut V8Engine, module: container_core::ModuleId, name: &str) -> Value {
    JsEngine::call(
        engine,
        CallTarget::Module {
            id: module,
            export: name.into(),
        },
        vec![],
    )
    .unwrap()
    .remove(0)
}

fn fixture(engine: &mut V8Engine) -> container_core::ModuleId {
    engine.install_host_environment(&snapshot(375)).unwrap();
    JsEngine::load_module(
        engine,
        include_bytes!("../../container-core/src/host-environment-test-fixture.js"),
    )
    .unwrap()
}

#[test]
fn complete_install_is_atomic_without_jobs_or_mutable_intrinsics_and_preserves_pending_business_effects(
) {
    let mut engine = V8Engine::default();
    let module = fixture(&mut engine);
    assert_eq!(call(&mut engine, module, "queue"), true);
    assert_eq!(call(&mut engine, module, "poison"), true);
    let mut replacement = snapshot(640);
    replacement.storage = None;
    replacement.files = None;
    replacement.dom_query = true;
    engine.install_host_environment(&replacement).unwrap();
    assert_eq!(
        call(&mut engine, module, "restoreRead"),
        json!({
            "width":640,"systemWidth":640,"storage":"kept","file":"kept",
            "attacks":0,"jobs":0,"dom":true,"aliasOwnedByApp":true,
        })
    );
    assert_eq!(
        call(&mut engine, module, "restoreAliases"),
        json!({"width":640,"replacement":true,"attacks":0})
    );
    JsEngine::drain_microtasks(&mut engine).unwrap();
    assert_eq!(
        call(&mut engine, module, "trace"),
        json!({"entries":[{"width":640,"systemWidth":640,"storage":"kept","file":"kept"}]})
    );
    let events = engine.drain_host_events().unwrap();
    let events = events[0]["events"].as_array().unwrap();
    assert!(events
        .iter()
        .any(|event| event["type"] == "storage.patch.batch"));
    assert!(events
        .iter()
        .any(|event| event["type"] == "api.sync" && event["name"] == "wx.fs.writeFileSync"));
}

#[test]
fn explicit_storage_replace_replays_pending_private_storage_intent() {
    let mut engine = V8Engine::default();
    let module = fixture(&mut engine);
    call(&mut engine, module, "queue");
    let mut replacement = snapshot(640);
    replacement.files = None;
    engine.install_host_environment(&replacement).unwrap();
    let result = call(&mut engine, module, "restoreRead");
    assert_eq!(result["storage"], "kept");
    assert_eq!(result["file"], "kept");
    assert_eq!(result["width"], 640);
    assert_eq!(result["jobs"], 0);
}

#[test]
fn legacy_capability_and_dom_installers_share_the_trusted_transport() {
    let mut engine = V8Engine::default();
    let module = fixture(&mut engine);
    call(&mut engine, module, "queue");
    call(&mut engine, module, "poison");
    engine
        .set_capabilities(&snapshot(375).capabilities)
        .unwrap();
    engine.set_dom_query_contract(true).unwrap();
    assert_eq!(
        call(&mut engine, module, "restoreRead"),
        json!({
            "width":375,"systemWidth":375,"storage":"kept","file":"kept",
            "attacks":0,"jobs":0,"dom":true,"aliasOwnedByApp":true,
        })
    );
}

#[test]
fn invalid_complete_version_cannot_mutate_maps_or_checkpoint_jobs() {
    let mut engine = V8Engine::default();
    let module = fixture(&mut engine);
    call(&mut engine, module, "queue");
    let mut invalid = snapshot(999);
    invalid.version = "2.0".into();
    assert!(engine
        .install_host_environment(&invalid)
        .unwrap_err()
        .to_string()
        .contains("host environment installation failed"));
    // restoreRead is safe before poison too; alias ownership is reported false.
    let read = call(&mut engine, module, "restoreRead");
    assert_eq!(read["width"], 375);
    assert_eq!(read["storage"], "kept");
    assert_eq!(read["file"], "kept");
    assert_eq!(read["jobs"], 0);
}

#[test]
fn compatibility_functions_keep_global_entries_and_callback_owner_helpers_stay_private() {
    // These scheduler helpers were introduced inside the shared lexical scope;
    // they carry callback-owner authority and were never compatibility globals.
    let private = [
        "__container_api_callback_attempt",
        "__container_deliver_api_callback",
    ];
    let names = MINI_PROGRAM_BOOTSTRAP
        .lines()
        .filter_map(|line| {
            line.strip_prefix("function ")
                .and_then(|line| line.split_once('('))
                .map(|(name, _)| name)
        })
        .filter(|name| !private.contains(name))
        .chain(["App", "Page", "Component", "getApp"])
        .collect::<Vec<_>>();
    let mut engine = V8Engine::default();
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.types = names => names.map(name => typeof globalThis[name]);"#,
    )
    .unwrap();
    let actual = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "types".into(),
        },
        vec![json!(names)],
    )
    .unwrap();
    assert_eq!(actual.len(), names.len());
    assert!(actual.iter().all(|value| value == "function"), "{actual:?}");
    let private_types = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "types".into(),
        },
        vec![json!(private)],
    )
    .unwrap();
    assert_eq!(private_types, vec![json!("undefined"), json!("undefined")]);
}

#[test]
fn installer_exception_never_enters_application_exception_coercion() {
    let mut engine = V8Engine::default();
    let module = JsEngine::load_module(
        &mut engine,
        b"exports.read = () => globalThis.__installerCoercions;",
    )
    .unwrap();
    let native = engine.native.as_mut().unwrap();
    let saved = native.host_environment.take();
    let transports = native
        .compile_host_environment(
            r#"
      globalThis.__installerCoercions = 0;
      ({
        installHostEnvironment: function() {
          throw {toString() { globalThis.__installerCoercions += 1; return 'trap'; }};
        },
        captureReceiverIncarnations: function() { return '{}'; },
        createReceiverEventDispatcher: function() { return function() {}; },
        bindEventChannel: function() { return false; },
        dispatchLifecycleNotification: function() { return false; },
        dispatchRouteNotification: function() { return false; },
        trackPromiseRejection: function() {},
        flushUnhandledRejections: function() {}
      })
    "#,
        )
        .expect("test host transport container compiles");
    native.host_environment = Some(transports.installer);
    let error = engine.install_host_environment(&snapshot(375)).unwrap_err();
    assert!(error
        .to_string()
        .contains("host environment installation failed"));
    engine.native.as_mut().unwrap().host_environment = saved;
    assert_eq!(call(&mut engine, module, "read"), 0);
}

#[test]
fn effect_drain_ack_retires_only_its_captured_prefix_including_legacy_global_calls() {
    let mut engine = V8Engine::default();
    engine.install_host_environment(&snapshot(375)).unwrap();
    let module = JsEngine::load_module(
        &mut engine,
        br#"
      let appended = false;
      exports.queue = () => {
        wx.setStorageSync('first', 'consumed');
        globalThis.__container_events.push({toJSON() {
          if (!appended) { appended = true; wx.setStorageSync('late', 'retained'); }
          return {type:'serialization.probe'};
        }});
        return true;
      };
      exports.read = () => ({first:wx.getStorageSync('first'), late:wx.getStorageSync('late')});
    "#,
    )
    .unwrap();
    call(&mut engine, module, "queue");
    let first = JsEngine::call(
        &mut engine,
        CallTarget::Global {
            name: "__container_drain_events".into(),
        },
        vec![],
    )
    .unwrap();
    assert!(first[0].get("__containerDrainId").is_none());
    assert_eq!(first[0]["events"].as_array().unwrap().len(), 2);
    // A later host revision must replay only the unconsumed serialization write.
    engine.install_host_environment(&snapshot(640)).unwrap();
    assert_eq!(
        call(&mut engine, module, "read"),
        json!({"first":"","late":"retained"})
    );
    let second = engine.drain_host_events().unwrap();
    assert_eq!(second[0]["events"].as_array().unwrap().len(), 1);
    assert_eq!(second[0]["events"][0]["patches"][0]["key"], "late");
    let empty = JsEngine::call(
        &mut engine,
        CallTarget::Global {
            name: "__container_drain_events".into(),
        },
        vec![],
    )
    .unwrap();
    assert_eq!(empty[0]["events"], json!([]));
    engine.install_host_environment(&snapshot(800)).unwrap();
    assert_eq!(
        call(&mut engine, module, "read"),
        json!({"first":"","late":""})
    );
}

#[test]
fn failed_effect_serialization_retains_the_batch_and_pending_storage_suffix() {
    let mut engine = V8Engine::default();
    engine.install_host_environment(&snapshot(375)).unwrap();
    let module = JsEngine::load_module(
        &mut engine,
        br#"
      let fail = true, appended = false;
      exports.queue = () => {
        wx.setStorageSync('first', 'retained');
        globalThis.__container_events.push({toJSON() {
          if (!appended) { appended = true; wx.setStorageSync('late', 'retained'); }
          if (fail) throw new Error('deliberate effect serialization failure');
          return {type:'serialization.probe'};
        }});
        return true;
      };
      exports.allow = () => { fail = false; return true; };
      exports.read = () => ({first:wx.getStorageSync('first'), late:wx.getStorageSync('late')});
    "#,
    )
    .unwrap();
    call(&mut engine, module, "queue");
    assert!(engine.drain_host_events().is_err());
    engine.install_host_environment(&snapshot(640)).unwrap();
    assert_eq!(
        call(&mut engine, module, "read"),
        json!({"first":"retained","late":"retained"})
    );
    call(&mut engine, module, "allow");
    let retried = engine.drain_host_events().unwrap();
    assert_eq!(retried[0]["events"].as_array().unwrap().len(), 2);
    engine.install_host_environment(&snapshot(800)).unwrap();
    assert_eq!(
        call(&mut engine, module, "read"),
        json!({"first":"","late":"retained"})
    );
    let suffix = engine.drain_host_events().unwrap();
    assert!(suffix[0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |event| event["type"] == "storage.patch.batch" && event["patches"][0]["key"] == "late"
        ));
    engine.install_host_environment(&snapshot(900)).unwrap();
    assert_eq!(
        call(&mut engine, module, "read"),
        json!({"first":"","late":""})
    );
}

#[test]
fn successful_effect_drain_does_not_checkpoint_jobs_or_consume_their_later_storage_batch() {
    let mut engine = V8Engine::default();
    engine.install_host_environment(&snapshot(375)).unwrap();
    let module = JsEngine::load_module(
        &mut engine,
        br#"
      exports.queue = () => {
        globalThis.__container_events.push({toJSON() {
          Promise.resolve().then(() => wx.setStorageSync('later', 'retained'));
          return {type:'serialization.probe'};
        }});
        return true;
      };
      exports.read = () => wx.getStorageSync('later');
    "#,
    )
    .unwrap();
    call(&mut engine, module, "queue");
    let first = engine.drain_host_events().unwrap();
    assert_eq!(first[0]["events"], json!([{"type":"serialization.probe"}]));
    assert_eq!(call(&mut engine, module, "read"), "");
    JsEngine::drain_microtasks(&mut engine).unwrap();
    engine.install_host_environment(&snapshot(640)).unwrap();
    assert_eq!(call(&mut engine, module, "read"), "retained");
    let later = engine.drain_host_events().unwrap();
    assert_eq!(later[0]["events"].as_array().unwrap().len(), 1);
    assert_eq!(later[0]["events"][0]["patches"][0]["key"], "later");
    engine.install_host_environment(&snapshot(800)).unwrap();
    assert_eq!(call(&mut engine, module, "read"), "");
}
