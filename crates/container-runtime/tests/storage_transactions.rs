//! Real-engine admission, private handoff and host commit regressions.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::{EngineKind, StorageSnapshot};
use container_ir::{
    hex_digest, AppInfo, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};

const SOURCE: &str = r#"
App({});
exports.read=function(key){return {value:wx.getStorageSync(key)};};
exports.write=function(key,value){wx.setStorageSync(key,value);return {value:wx.getStorageSync(key)};};
exports.rejectKey=function(key){try{wx.setStorageSync(key,1);return {value:false};}catch(_){return {value:true};}};
exports.badBatch=function(){
  const cyclic={};cyclic.self=cyclic;
  let failed=false;
  try { wx.batchSetStorageSync([{key:'outer',value:1},{key:'late',value:cyclic}]); }
  catch(error) { failed=true; }
  return {value:failed};
};
exports.nestedBatch=function(){
  const cyclic={};cyclic.self=cyclic;
  let failed=false;
  const first={toJSON(){wx.setStorageSync('nested',{preserved:true});return {outer:true};}};
  try { wx.batchSetStorageSync([{key:'outer',value:first},{key:'late',value:cyclic}]); }
  catch(error) { failed=true; }
  return {value:failed};
};
exports.hideAndForge=function(){
  wx.setStorageSync('admitted',{value:1});
  __container_storage.admitted={value:999};
  __container_set_storage_snapshot({values:{forged:9},undefinedKeys:[]});
  __container_events.length=0;
  __container_events.push({type:'storage.patch.batch',patches:[{op:'set',key:'forged',value:9}]});
  const drain=__container_drain_events;
  globalThis.__container_drain_events=function(){
    const batch=drain();
    batch.__storageTransactions=[{sequence:'1',patches:[{op:'set',key:'forged',valueJson:'9',undefined:false}]}];
    return batch;
  };
  return {value:wx.getStorageSync('admitted')};
};
exports.failingPublicEffect=function(){
  wx.setStorageSync('admitted',{value:1});
  __container_events.push({type:'data.patch.batch',patches:[{path:42,value:0}]});
  return {value:true};
};
let poisonEffects=false;
exports.poisonPublicConversion=function(){
  wx.setStorageSync('ordered','guest');
  poisonEffects=true;
  __container_events.push({toJSON(){
    if(poisonEffects)throw new Error('public conversion failed');
    return {type:'probe'};
  }});
  return {value:true};
};
exports.repairPublicConversion=function(){poisonEffects=false;return {value:true};};
exports.depth=function(depth,key){
  let value=1;for(let i=0;i<depth;i++)value=[value];
  let failed=false;
  try { wx.setStorageSync(key,value); } catch(error){failed=true;}
  return {value:failed};
};
exports.inspectDepth=function(key){
  let value=wx.getStorageSync(key),depth=0;
  while(Array.isArray(value)){depth++;value=value[0];}
  return {value:{depth:depth,leaf:value}};
};
exports.accounting=function(){
  wx.batchSetStorageSync([
    {key:'numeric',value:[1.0,-0,1e20,1e21,1e-6,1e-7]},
    {key:'unicode',value:'中文😀\u0000\n'},
    {key:'undefined',value:undefined}, {key:'null',value:null}
  ]);
  return {value:wx.getStorageInfoSync()};
};
exports.preciseNumbers=function(){
  wx.batchSetStorageSync([{key:'smallNumber',value:1.9430538399282263e-44},{key:'quotaNumber',value:4.501222173364241e-13}]);
  return exports.inspectPreciseNumbers();
};
exports.inspectPreciseNumbers=function(){
  const small=wx.getStorageSync('smallNumber'),quota=wx.getStorageSync('quotaNumber');
  return {value:{small:JSON.stringify(small),quota:JSON.stringify(quota),smallExact:small===1.9430538399282263e-44,quotaExact:quota===4.501222173364241e-13}};
};
exports.numericQuotaEdge=function(){
  const value={number:4.501222173364241e-13,padding:''};
  value.padding='x'.repeat(1048576-JSON.stringify(value).length);
  wx.setStorageSync('numericQuotaEdge',value);
  return {value:{bytes:JSON.stringify(value).length,number:JSON.stringify(wx.getStorageSync('numericQuotaEdge').number)}};
};
exports.quota=function(){
  let single=false,batch=false;
  const tooBig='x'.repeat(1048576);
  try { wx.setStorageSync('large',tooBig); } catch(error){single=true;}
  try { wx.batchSetStorageSync([{key:'prefix',value:1},{key:'large',value:tooBig}]); } catch(error){batch=true;}
  return {value:{single:single,batch:batch,keys:wx.getStorageInfoSync().keys}};
};
exports.encrypted=function(){
  return wx.setStorage({key:'encrypted',data:1,encrypt:true})
    .then(function(){return {value:false};},function(error){return {value:error.code};});
};
"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

struct Fixture {
    session: Session,
    sequence: u64,
}
impl Fixture {
    fn new(engine: EngineKind, storage: Option<StorageSnapshot>) -> Self {
        let mut manifest = ContainerManifestV1 {
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        };
        manifest.compiler.commit = "storage-private-transactions-local-contract".into();
        manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: hex_digest(SOURCE.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        for name in [
            "wx.setStorageSync",
            "wx.getStorageSync",
            "wx.getStorageInfoSync",
            "wx.batchSetStorageSync",
            "wx.setStorage",
            "wx.getStorage",
        ] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                engine,
                ..Default::default()
            },
        )
        .unwrap();
        if let Some(storage) = storage {
            session.restore_storage(storage).unwrap();
        }
        let mut fixture = Self {
            session,
            sequence: 0,
        };
        let batch = fixture.raw(
            op::APP_INIT,
            json!({"modules":[{"id":"module:app.js","source":SOURCE}]}),
        );
        fixture.assert_ok(&batch);
        fixture
    }
    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("storage-{}", self.sequence),
            operation,
            payload,
        ))
    }
    fn invoke(&mut self, export: &str, args: Value) -> BridgeBatch {
        self.raw(
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":export,"args":args}),
        )
    }
    fn assert_ok(&self, batch: &BridgeBatch) {
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        assert!(
            !batch.messages.iter().any(|message| message.op == op::ERROR),
            "{batch:?}"
        );
    }
    fn call(&mut self, export: &str, args: Value) -> Value {
        let batch = self.invoke(export, args);
        self.assert_ok(&batch);
        batch.messages[0].payload["result"][0]["value"].clone()
    }
    fn repair_public_conversion(&mut self) {
        let batch = self.invoke("repairPublicConversion", json!([]));
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        // The failed drain's queued error remains observable on recovery.
        // It is an application diagnostic, not a new native commit failure.
        for error in batch
            .messages
            .iter()
            .filter(|message| message.op == op::ERROR)
        {
            let errors = error.payload["errors"]
                .as_array()
                .expect("queued JS diagnostics");
            assert!(
                errors
                    .iter()
                    .all(|error| error["message"] == "public conversion failed"),
                "{batch:?}"
            );
        }
    }
}

#[test]
fn rejected_outer_batch_preserves_only_legitimate_nested_writes() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, None);
        let stamp = fixture.session.storage_stamp();
        assert_eq!(fixture.call("badBatch", json!([])), true);
        assert_eq!(fixture.session.storage_stamp(), stamp);
        assert!(fixture.session.storage_snapshot().values.is_empty());
        assert_eq!(fixture.call("nestedBatch", json!([])), true);
        assert_eq!(
            fixture.session.storage_snapshot().values,
            json!({"nested":{"preserved":true}})
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        );
        assert_eq!(fixture.session.storage_revision(), 1);
    }
}

#[test]
fn public_traces_and_storage_aliases_cannot_forge_or_erase_private_intent() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, None);
        assert_eq!(fixture.call("hideAndForge", json!([])), json!({"value":1}));
        let snapshot = fixture.session.storage_snapshot();
        assert_eq!(snapshot.values.get("admitted"), Some(&json!({"value":1})));
        assert!(!snapshot.values.contains_key("forged"));
        let stamp = fixture.session.storage_stamp();
        assert_eq!(
            fixture.call("read", json!(["admitted"])),
            json!({"value":1})
        );
        assert_eq!(fixture.session.storage_stamp(), stamp);
    }
}

#[test]
fn accepted_storage_commits_before_an_unrelated_public_effect_fails() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, None);
        let batch = fixture.invoke("failingPublicEffect", json!([]));
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        assert!(
            batch.messages.iter().any(|message| message.op == op::ERROR),
            "{batch:?}"
        );
        assert_eq!(
            fixture.session.storage_snapshot().values.get("admitted"),
            Some(&json!({"value":1}))
        );
        let stamp = fixture.session.storage_stamp();
        assert_eq!(
            fixture.call("read", json!(["admitted"])),
            json!({"value":1})
        );
        assert_eq!(fixture.session.storage_stamp(), stamp);
        assert_eq!(fixture.session.storage_revision(), 1);
    }
}

#[test]
fn failed_public_conversion_settles_guest_storage_before_later_host_writes() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, None);
        let failed = fixture.invoke("poisonPublicConversion", json!([]));
        assert_eq!(failed.messages[0].payload["ok"], true, "{failed:?}");
        assert!(failed
            .messages
            .iter()
            .any(|message| message.op == op::ERROR));
        assert_eq!(
            fixture.session.storage_snapshot().values["ordered"],
            "guest"
        );
        assert_eq!(fixture.session.storage_revision(), 1);
        let host = fixture.raw(
            op::API_CALL,
            json!({"name":"wx.setStorageSync","key":"ordered","data":"host"}),
        );
        assert_eq!(host.messages[0].payload["ok"], true, "{host:?}");
        assert_eq!(fixture.session.storage_snapshot().values["ordered"], "host");
        let stamp = fixture.session.storage_stamp();
        fixture.repair_public_conversion();
        assert_eq!(fixture.call("read", json!(["ordered"])), "host");
        assert_eq!(fixture.session.storage_stamp(), stamp);
        assert_eq!(fixture.session.storage_revision(), 2);
    }
}

#[test]
fn same_revision_host_replacement_refreshes_after_public_conversion_failure() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, None);
        let failed = fixture.invoke("poisonPublicConversion", json!([]));
        assert!(failed
            .messages
            .iter()
            .any(|message| message.op == op::ERROR));
        let mut replacement = container_core::MemoryStorage::default();
        replacement.set("ordered", json!("replacement")).unwrap();
        assert_eq!(replacement.revision(), fixture.session.storage_revision());
        *fixture.session.app_service_mut().storage_mut() = replacement;
        let stamp = fixture.session.storage_stamp();
        fixture.repair_public_conversion();
        assert_eq!(fixture.call("read", json!(["ordered"])), "replacement");
        assert_eq!(fixture.session.storage_stamp(), stamp);
        assert_eq!(fixture.session.storage_revision(), 1);
    }
}

#[test]
fn engine_depth_admission_matches_core_decoding_and_preserves_legacy_restore() {
    for engine in engines() {
        let mut legacy = json!(1);
        for _ in 0..200 {
            legacy = Value::Array(vec![legacy]);
        }
        let mut snapshot = StorageSnapshot::default();
        snapshot.values.insert("legacy".into(), legacy);
        let mut fixture = Fixture::new(engine, Some(snapshot));
        assert_eq!(
            fixture.call("inspectDepth", json!(["legacy"])),
            json!({"depth":200,"leaf":1})
        );
        for depth in [127, 128] {
            assert_eq!(
                fixture.call("depth", json!([depth, format!("depth{depth}")])),
                false
            );
            assert_eq!(
                fixture.call("inspectDepth", json!([format!("depth{depth}")])),
                json!({"depth":depth,"leaf":1})
            );
            let mut actual =
                fixture.session.storage_snapshot().values[&format!("depth{depth}")].clone();
            for _ in 0..depth {
                actual = actual.as_array().unwrap()[0].clone();
            }
            assert_eq!(actual, 1);
        }
        let stamp = fixture.session.storage_stamp();
        assert_eq!(fixture.call("depth", json!([129, "rejected"])), true);
        assert_eq!(fixture.session.storage_stamp(), stamp);
        assert!(!fixture
            .session
            .storage_snapshot()
            .values
            .contains_key("rejected"));
    }
}

#[test]
fn ordinary_quota_rejection_has_no_batch_prefix_or_single_write_bypass() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, None);
        let stamp = fixture.session.storage_stamp();
        assert_eq!(
            fixture.call("quota", json!([])),
            json!({"single":true,"batch":true,"keys":[]})
        );
        assert_eq!(fixture.session.storage_stamp(), stamp);
        assert!(fixture.session.storage_snapshot().values.is_empty());
        assert_eq!(fixture.call("write", json!(["next", 1])), 1);
        assert_eq!(fixture.session.storage_revision(), 1);
    }
}

#[test]
fn unicode_key_whitespace_matches_native_admission_and_legacy_restore() {
    for engine in engines() {
        let mut snapshot = StorageSnapshot::default();
        snapshot.values.insert("\u{feff}".into(), json!("legacy"));
        let mut fixture = Fixture::new(engine, Some(snapshot));
        assert_eq!(fixture.call("read", json!(["\u{feff}"])), "legacy");
        let stamp = fixture.session.storage_stamp();
        assert_eq!(fixture.call("rejectKey", json!(["\u{85}"])), true);
        assert_eq!(fixture.session.storage_stamp(), stamp);
        assert_eq!(
            fixture.call("write", json!(["\u{feff}", "updated"])),
            "updated"
        );
        assert_eq!(
            fixture.session.storage_snapshot().values["\u{feff}"],
            "updated"
        );
        fixture.session.app_service_mut();
        assert_eq!(fixture.call("read", json!(["\u{feff}"])), "updated");
        let rejected = fixture.raw(
            op::API_CALL,
            json!({"name":"wx.setStorageSync","key":"\u{85}","data":1}),
        );
        assert_eq!(rejected.messages[0].payload["ok"], false, "{rejected:?}");
        assert!(!fixture
            .session
            .storage_snapshot()
            .values
            .contains_key("\u{85}"));
    }
}

#[test]
fn usage_and_undefined_markers_agree_across_guest_host_and_snapshot_repair() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, None);
        let info = fixture.call("accounting", json!([]));
        assert_eq!(
            info["currentSize"],
            fixture
                .session
                .app_service()
                .storage()
                .usage()
                .current_size_kib()
        );
        let snapshot = fixture.session.storage_snapshot();
        assert!(snapshot.undefined_keys.contains("undefined"));
        assert!(!snapshot.undefined_keys.contains("null"));
        assert_eq!(snapshot.values["undefined"], Value::Null);
        assert_eq!(snapshot.values["null"], Value::Null);
        fixture.session.app_service_mut(); // Force a trusted environment repair.
        assert_eq!(
            fixture.call("read", json!(["unicode"])),
            json!("中文😀\0\n")
        );
        assert_eq!(fixture.session.storage_snapshot(), snapshot);
    }
}

#[test]
fn numeric_storage_keeps_javascript_bits_across_commit_and_host_mirror_refresh() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, None);
        let expected = json!({
            "small":"1.9430538399282263e-44", "quota":"4.501222173364241e-13",
            "smallExact":true, "quotaExact":true
        });
        assert_eq!(fixture.call("preciseNumbers", json!([])), expected);
        let snapshot = fixture.session.storage_snapshot();
        assert_eq!(
            snapshot.values["smallNumber"].as_f64().unwrap().to_bits(),
            0x36dbbb70e036180f
        );
        assert_eq!(
            snapshot.values["quotaNumber"].as_f64().unwrap().to_bits(),
            0x3d5facae56160c35
        );
        fixture.session.app_service_mut();
        assert_eq!(fixture.call("inspectPreciseNumbers", json!([])), expected);
        assert_eq!(fixture.session.storage_snapshot(), snapshot);
    }
}

#[test]
fn numeric_roundtrip_does_not_inflate_a_locally_admitted_one_mib_payload() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, None);
        assert_eq!(
            fixture.call("numericQuotaEdge", json!([])),
            json!({
                "bytes":1048576,"number":"4.501222173364241e-13"
            })
        );
        let snapshot = fixture.session.storage_snapshot();
        assert_eq!(
            snapshot.values["numericQuotaEdge"]["number"]
                .as_f64()
                .unwrap()
                .to_bits(),
            0x3d5facae56160c35
        );
        assert_eq!(fixture.session.storage_revision(), 1);
    }
}
