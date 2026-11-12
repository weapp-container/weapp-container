//! Real Session bridge and native loader coverage. These are implementation
//! boundary tests, not complete WeChat producer/metadata/timing parity.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};

const SESSION: &str = "performance-owner";
const APP: &str = "module:app.js";
const LAZY: &str = "module:lazy.js";
const MEMBERS: [&str; 6] = [
    "object:Performance.getEntries",
    "object:Performance.getEntriesByName",
    "object:Performance.getEntriesByType",
    "object:EntryList.getEntries",
    "object:EntryList.getEntriesByName",
    "object:EntryList.getEntriesByType",
];
const SOURCE: &str = r#"
let launches=0,publicExecutions=0,retained;
App({onLaunch:function(options){launches++;options.path='guest-mutated';}});
const p=wx.getPerformance(),saved=[p.getEntries,p.getEntriesByName,p.getEntriesByType];
p.createObserver(function(list){if(!retained)retained=list;}).observe({type:'script'});
exports.read=function(){return {value:{entries:saved[0](),retained:retained.getEntries(),launches:launches,publicExecutions:publicExecutions,lazyRuns:globalThis.lazyRuns||0}}};
exports.queries=function(){
 const all=saved.concat([retained.getEntries,retained.getEntriesByName,retained.getEntriesByType]);
 return {value:all.map(function(fn,index){try{const args=index%3===0?[]:index%3===1?['evaluateScript','script']:['script'];return {array:Array.isArray(fn.apply({},args))};}catch(error){return {api:error.api,code:error.code};}})};
};
exports.replaceEvaluatorWithNoop=function(){
 __container_evaluate_module=function(){publicExecutions++;return null;};
 return {value:true};
};
exports.forge=function(){
 __container_evaluate_named_module('module:forged.js',function(){publicExecutions++;},true);
 __container_define_module('module:lazy.js',2,[],'commonjs',function(){publicExecutions++;});
 __container_evaluate_module('module:lazy.js');
 const poison=function(){throw Error('public alias used');};
 __container_evaluate_named_module=poison;__container_define_module=poison;__container_evaluate_module=poison;__container_module_exports=poison;__container_invoke_app=poison;
 Object.freeze(__container_modules);Object.defineProperty(globalThis,'__container_modules',{configurable:true,get:poison});
 return {value:true};
};
exports.retired=function(){let rejected=0;for(const fn of [saved[0],saved[1],saved[2],retained.getEntries,retained.getEntriesByName,retained.getEntriesByType,wx.getPerformance]){try{fn('evaluateScript','script');}catch(error){if(error.code==='ERR_UNSUPPORTED_CAPABILITY')rejected++;}}return {value:rejected};};
"#;
const LAZY_SOURCE: &str = "globalThis.lazyRuns=(globalThis.lazyRuns||0)+1;exports.read=function(){return {value:lazyRuns};};";

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
    fn new(engine: EngineKind, denied: Option<&str>) -> Self {
        Self::with_lazy_source(engine, denied, LAZY_SOURCE)
    }
    fn with_lazy_source(engine: EngineKind, denied: Option<&str>, lazy_source: &str) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "performance-owner-fixture".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        for (id, source) in [(APP, SOURCE), (LAZY, lazy_source)] {
            manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::App,
                dependencies: Vec::new(),
            });
        }
        for name in std::iter::once("wx.getPerformance").chain(MEMBERS) {
            manifest.capabilities.insert(
                name.into(),
                if denied == Some(name) {
                    CapabilitySupport::Unsupported
                } else {
                    CapabilitySupport::Partial
                },
            );
        }
        for name in ["wx.getStorageSync", "wx.setStorageSync"] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
        }
        manifest.refresh_integrity().unwrap();
        let capabilities = manifest.capabilities.clone();
        let session = Session::new(
            manifest,
            SessionConfig {
                session_id: SESSION.into(),
                engine,
                capabilities,
                ..Default::default()
            },
        )
        .unwrap();
        let mut fixture = Self {
            session,
            sequence: 0,
        };
        let initialized = fixture.raw(
            op::APP_INIT,
            json!({"launchOptions":{"path":"pages/home"},"modules":[{"id":APP,"source":SOURCE}]}),
        );
        assert_eq!(
            initialized.messages[0].payload["ok"], true,
            "{initialized:?}"
        );
        fixture
    }
    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            format!("performance-{}", self.sequence),
            operation,
            payload,
        ))
    }
    fn call_module(&mut self, id: &str, export: &str) -> Value {
        let batch = self.raw(
            op::MODULE_CALL,
            json!({"moduleId":id,"export":export,"args":[]}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        batch.messages[0].payload["result"][0]["value"].clone()
    }
    fn call(&mut self, export: &str) -> Value {
        self.call_module(APP, export)
    }
}

#[test]
fn session_performance_uses_real_launch_and_lazy_loader_after_public_alias_poisoning() {
    for engine in engines() {
        let mut f = Fixture::new(engine, None);
        let before = f.call("read");
        assert_eq!(before["launches"], 1);
        let entries = before["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        let script = entries
            .iter()
            .find(|entry| entry["name"] == "evaluateScript")
            .unwrap();
        assert_eq!(script["fileList"], json!(["app.js"]));
        let launch = entries
            .iter()
            .find(|entry| entry["name"] == "appLaunch")
            .unwrap();
        assert_eq!(launch["path"], "pages/home");
        for entry in entries {
            assert!(entry["startTime"].as_f64().unwrap() >= 0.0);
            assert!(entry["duration"].as_f64().unwrap() >= 0.0);
            assert!(
                entry.get("moduleName").is_none(),
                "metadata remains an explicit gap"
            );
            assert!(
                entry.get("pageId").is_none(),
                "no fabricated page incarnation"
            );
        }
        f.call("forge");
        assert_eq!(f.call("read")["entries"], before["entries"]);
        let loaded = f.raw(
            op::MODULE_LOAD,
            json!({"modules":[{"id":LAZY,"source":LAZY_SOURCE}]}),
        );
        assert_eq!(loaded.messages[0].payload["ok"], true, "{loaded:?}");
        assert_eq!(f.call_module(LAZY, "read"), 1);
        let after = f.call("read");
        assert_eq!(after["publicExecutions"], 2);
        assert_eq!(after["lazyRuns"], 1);
        assert_eq!(after["entries"].as_array().unwrap().len(), 3);
        assert_eq!(after["entries"][2]["fileList"], json!(["lazy.js"]));
        assert_eq!(after["retained"], before["retained"]);
    }
}

#[test]
fn session_performance_each_exact_query_policy_denies_only_its_saved_member() {
    for engine in engines() {
        for (denied_index, denied) in MEMBERS.iter().enumerate() {
            let mut f = Fixture::new(engine, Some(denied));
            let result = f.call("queries");
            for (index, query) in result.as_array().unwrap().iter().enumerate() {
                if index == denied_index {
                    assert_eq!(
                        query,
                        &json!({"api":denied,"code":"ERR_UNSUPPORTED_CAPABILITY"})
                    );
                } else {
                    assert_eq!(query, &json!({"array":true}));
                }
            }
        }
    }
}

#[test]
fn session_performance_terminal_host_revocation_fences_old_aliases_and_entry_lists() {
    for engine in engines() {
        let mut old = Fixture::new(engine, None);
        assert_eq!(old.call("retired"), 0);
        old.session.revoke_host_services();
        assert_eq!(old.call("retired"), 7);
        let mut next = Fixture::new(engine, None);
        assert_eq!(next.call("retired"), 0);
        assert_eq!(next.call("read")["entries"].as_array().unwrap().len(), 2);
        assert_eq!(old.call("retired"), 7);
    }
}

#[test]
fn session_performance_noop_public_evaluator_cannot_fake_a_completed_lazy_load() {
    for engine in engines() {
        let mut f = Fixture::new(engine, None);
        f.call("replaceEvaluatorWithNoop");
        let loaded = f.raw(
            op::MODULE_LOAD,
            json!({"modules":[{"id":LAZY,"source":LAZY_SOURCE}]}),
        );
        assert_eq!(loaded.messages[0].payload["ok"], true, "{loaded:?}");
        // Inspect through the already evaluated app before calling the lazy
        // export: exports lookup could otherwise hide a skipped MODULE_LOAD
        // by evaluating the lazy factory during the later MODULE_CALL.
        let after = f.call("read");
        assert_eq!(after["lazyRuns"], 1);
        assert_eq!(after["publicExecutions"], 0);
        assert_eq!(after["entries"].as_array().unwrap().len(), 3);
        assert_eq!(after["entries"][2]["fileList"], json!(["lazy.js"]));
    }
}

#[test]
fn session_retained_module_throw_keeps_module_load_error_and_finishes_queued_jobs() {
    const KEY: &str = "performance-evaluation-checkpoint";
    const MESSAGE: &str = "original retained module evaluation failure";
    const FAILING_SOURCE: &str = r#"
Promise.resolve().then(function(){
 const key='performance-evaluation-checkpoint';
 wx.setStorageSync(key,(wx.getStorageSync(key)||0)+1);
});
throw Error('original retained module evaluation failure');
"#;
    for engine in engines() {
        let mut f = Fixture::with_lazy_source(engine, None, FAILING_SOURCE);
        f.call("forge");
        assert!(f.session.app_service().storage().get(KEY).is_none());
        let failed = f.raw(
            op::MODULE_LOAD,
            json!({"modules":[{"id":LAZY,"source":FAILING_SOURCE}]}),
        );
        let failure = &failed.messages[0].payload;
        assert_eq!(failure["ok"], false, "{failed:?}");
        assert_eq!(failure["error"]["code"], "ERR_MODULE_LOAD", "{failed:?}");
        assert!(
            failure["error"]["message"]
                .as_str()
                .unwrap()
                .contains(MESSAGE),
            "{failed:?}"
        );
        assert_ne!(failure["requiresRestart"], true, "{failed:?}");
        // Read native committed storage before any later JS turn. Looking only
        // at a subsequent module call would also pass a postponed checkpoint.
        assert_eq!(
            f.session.app_service().storage().get(KEY),
            Some(&json!(1)),
            "queued jobs escaped the failing MODULE_LOAD task: {failed:?}"
        );
        let reports = failed
            .messages
            .iter()
            .filter(|message| message.op == op::ERROR)
            .flat_map(|message| message.payload["errors"].as_array().into_iter().flatten())
            .filter(|error| error["message"] == MESSAGE)
            .count();
        assert_eq!(
            reports, 1,
            "original failure was lost or replayed: {failed:?}"
        );
        assert!(f.session.execution_fault().is_none());
        assert_eq!(f.call("read")["entries"].as_array().unwrap().len(), 2);
        assert_eq!(f.session.app_service().storage().get(KEY), Some(&json!(1)));
    }
}
