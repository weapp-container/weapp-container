// One managed component contract shared by both native engine adapters.
use container_core::{CallTarget, JsEngine, ValueBatch};
use serde_json::{json, Value};

fn global(engine: &mut NativeEngine, name: &str, args: ValueBatch) -> ValueBatch {
    JsEngine::call(engine, CallTarget::Global { name: name.into() }, args)
        .expect("managed component global call succeeds")
}

fn fixture() -> NativeEngine {
    let mut engine = NativeEngine::default();
    JsEngine::load_module(
        &mut engine,
        br#"
      globalThis.__managed_trace = [];
      globalThis.__managed_read = () => ({ trace: __managed_trace });
      Page({ __container_instance_id: 1, data: {}, handle(event) {
        __managed_trace.push(['page',event.currentTarget.id]);
      } });
    "#,
    )
    .expect("page fixture evaluates");
    global(
        &mut engine,
        "__container_configure_component_modules",
        vec![json!(["component:counter"])],
    );
    engine
        .load_module_with_id(
            "component:counter",
            include_bytes!("managed-component-engine.js"),
        )
        .expect("named component definition evaluates");
    engine
}

fn record(scope: &str, label: &str) -> Value {
    json!({"scopeId":scope,"moduleId":"component:counter","parentScopeId":null,"ownerScopeId":null,"properties":{"label":label}})
}

fn reconcile(
    engine: &mut NativeEngine,
    phase: &str,
    records: Vec<Value>,
    removals: Vec<Value>,
) -> Value {
    global(
        engine,
        "__container_reconcile_components",
        vec![json!({
            "version":1,"phase":phase,"pageId":1,"instances":records,"remove":removals
        })],
    )
    .remove(0)
}

fn trace(engine: &mut NativeEngine) -> Value {
    global(engine, "__managed_read", vec![])[0]["trace"].clone()
}

#[test]
fn managed_registration_and_phased_instances_preserve_independent_data() {
    let mut engine = fixture();
    assert_eq!(
        trace(&mut engine),
        json!([]),
        "definition registration runs no user hook"
    );
    let prepared = reconcile(
        &mut engine,
        "prepare",
        vec![record("one", "A"), record("two", "B")],
        vec![],
    );
    assert_eq!(prepared["instances"][0]["index"], 1);
    assert_eq!(prepared["instances"][1]["index"], 2);
    for instance in prepared["instances"].as_array().unwrap() {
        assert_eq!(instance["snapshot"]["data"]["count"], 1);
        assert_eq!(instance["snapshot"]["lifecycle"], json!(["created"]));
        assert_eq!(instance["snapshot"]["attached"], false);
    }
    let attached = reconcile(
        &mut engine,
        "attach",
        vec![record("one", "A"), record("two", "B")],
        vec![],
    );
    assert_eq!(
        attached["instances"][0]["snapshot"]["lifecycle"],
        json!(["created", "attached"])
    );
    let ready = reconcile(
        &mut engine,
        "ready",
        vec![record("one", "A"), record("two", "B")],
        vec![],
    );
    assert_eq!(
        ready["instances"][1]["snapshot"]["lifecycle"],
        json!(["created", "attached", "ready"])
    );
    reconcile(&mut engine, "attach", vec![record("one", "A")], vec![]);
    reconcile(&mut engine, "ready", vec![record("one", "A")], vec![]);
    let reused = reconcile(
        &mut engine,
        "prepare",
        vec![record("one", "changed")],
        vec![],
    );
    assert_eq!(reused["instances"][0]["index"], 1);
    assert_eq!(reused["instances"][0]["snapshot"]["data"]["count"], 1);
    assert_eq!(
        reused["instances"][0]["snapshot"]["properties"]["label"],
        "changed"
    );
    assert_eq!(
        trace(&mut engine),
        json!([
            ["created", "one"],
            ["property", "one", "A", "default"],
            ["created", "two"],
            ["property", "two", "B", "default"],
            ["attached", "one"],
            ["attached", "two"],
            ["ready", "one"],
            ["ready", "two"],
            ["property", "one", "changed", "A"]
        ])
    );
    let events = engine.drain_host_events().expect("component effects drain");
    let patches: Vec<&Value> = events
        .iter()
        .flat_map(|batch| batch["events"].as_array().into_iter().flatten())
        .filter(|event| event["type"] == "component.property.patch")
        .collect();
    assert!(patches.iter().any(|event| event["source"] == "setData"
        && event["scopeId"] == "one"
        && event["pageId"] == 1));
    assert!(patches
        .iter()
        .all(|event| event["scopeId"] == "one" || event["scopeId"] == "two"));
}

#[test]
fn prepare_validates_every_mapping_before_running_user_hooks() {
    let mut engine = fixture();
    let bad = json!({"scopeId":"bad","moduleId":"component:missing","properties":{},"parentScopeId":null,"ownerScopeId":null});
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Global {
            name: "__container_reconcile_components".into(),
        },
        vec![json!({
            "version":1,"phase":"prepare","pageId":1,"instances":[record("one","A"),bad],"remove":[]
        })],
    );
    assert!(result.is_err());
    assert_eq!(trace(&mut engine), json!([]));
    let registration = global(&mut engine, "__container_registration_snapshot", vec![]);
    assert_eq!(
        registration[0]["components"], 1,
        "failed prevalidation creates no instances"
    );
    let prepared = reconcile(&mut engine, "prepare", vec![record("one", "A")], vec![]);
    assert_eq!(prepared["instances"][0]["index"], 1);
}

#[test]
fn named_module_failures_restore_context_and_do_not_accumulate_definitions() {
    let mut engine = NativeEngine::default();
    global(
        &mut engine,
        "__container_configure_component_modules",
        vec![json!(["zero", "many", "retry"])],
    );
    assert!(engine
        .load_module_with_id("zero", b"module.exports = 1;")
        .is_err());
    assert!(engine
        .load_module_with_id("many", b"Component({}); Component({});")
        .is_err());
    assert!(engine
        .load_module_with_id("retry", b"Component({}); throw new Error('expected');")
        .is_err());
    assert_eq!(engine.loaded_module_count(), 0);
    let registration = global(&mut engine, "__container_registration_snapshot", vec![]);
    assert_eq!(registration[0]["components"], 0);
    engine
        .load_module_with_id("retry", b"Component({data:{valid:true}});")
        .expect("retry registers one definition");
    JsEngine::load_module(&mut engine, b"globalThis.__legacy_created = 0; Component({created(){ __legacy_created++; }}); globalThis.__legacy_read = () => __legacy_created;")
        .expect("unnamed module retains legacy registration");
    assert_eq!(global(&mut engine, "__legacy_read", vec![]), vec![json!(1)]);
    let result = global(
        &mut engine,
        "__container_reconcile_components",
        vec![json!({
            "version":1,"phase":"prepare","pageId":1,"instances":[{"scopeId":"valid","moduleId":"retry","parentScopeId":null,"ownerScopeId":null,"properties":{}}],"remove":[]
        })],
    );
    assert_eq!(result[0]["instances"][0]["snapshot"]["data"]["valid"], true);
}

#[test]
fn owner_scope_events_keep_dispatch_order_and_disposed_scopes_cannot_mutate_replacements() {
    let mut engine = fixture();
    let records = vec![record("one", "A"), record("two", "B")];
    reconcile(&mut engine, "prepare", records.clone(), vec![]);
    reconcile(&mut engine, "attach", records.clone(), vec![]);
    global(
        &mut engine,
        "__container_invoke_page_event",
        vec![
            json!(0),
            json!({"dispatches":[
                {"currentTarget":"root","handler":"handle","ownerScopeId":null,"phase":"capture"},
                {"currentTarget":"child","handler":"handle","ownerScopeId":"one","phase":"target"},
                {"currentTarget":"root","handler":"handle","ownerScopeId":null,"phase":"bubble"}
            ]}),
        ],
    );
    let first = global(
        &mut engine,
        "__container_component_snapshot",
        vec![json!(1)],
    );
    let second = global(
        &mut engine,
        "__container_component_snapshot",
        vec![json!(2)],
    );
    assert_eq!(first[0]["data"]["count"], 2);
    assert_eq!(second[0]["data"]["count"], 1);
    let current = trace(&mut engine);
    assert_eq!(
        &current.as_array().unwrap()[6..],
        json!([
            ["page", "root"],
            ["component", "one", "child"],
            ["page", "root"]
        ])
        .as_array()
        .unwrap()
        .as_slice()
    );
    let stopped = global(
        &mut engine,
        "__container_invoke_page_event",
        vec![
            json!(0),
            json!({"dispatches":[
                {"currentTarget":"child","handler":"stop","ownerScopeId":"one"},
                {"currentTarget":"root","handler":"handle","ownerScopeId":null}
            ]}),
        ],
    );
    assert_eq!(stopped.len(), 1);
    global(
        &mut engine,
        "__container_invoke_component",
        vec![json!(1), json!("late"), json!([])],
    );
    let disposed = reconcile(&mut engine, "dispose", records, vec![]);
    assert_eq!(disposed["instances"][0]["scopeId"], "two");
    assert_eq!(disposed["instances"][1]["scopeId"], "one");
    reconcile(
        &mut engine,
        "dispose",
        vec![],
        vec![json!("one"), json!("gone")],
    );
    engine.drain_host_events().expect("old effects drain");
    let replacement = reconcile(&mut engine, "prepare", vec![record("one", "new")], vec![]);
    let new_index = replacement["instances"][0]["index"].clone();
    engine
        .drain_host_events()
        .expect("replacement effects drain");
    // Native engine polls take safe-integer Unix milliseconds. Advance the
    // actual clock enough to make this fixture's 1 ms timeout due, without
    // turning a valid scheduling test into an out-of-range clock request.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock follows Unix epoch")
        .as_millis();
    let poll_ms = u64::try_from(now_ms + 1_000).expect("fixture clock fits u64");
    let fired = engine.drain_timers(poll_ms).expect("old timer drains");
    assert_eq!(
        fired.len(),
        1,
        "the disposed component's timer actually runs"
    );
    let effects = engine.drain_host_events().expect("timer effects drain");
    assert!(
        effects
            .iter()
            .all(|batch| batch["events"].as_array().unwrap().is_empty()),
        "disposed setData emits no stale patch"
    );
    let value = global(
        &mut engine,
        "__container_component_snapshot",
        vec![new_index],
    );
    assert_eq!(value[0]["data"]["count"], 1);
    let stale = global(
        &mut engine,
        "__container_invoke_page_event",
        vec![
            json!(0),
            json!({"dispatches":[
                {"currentTarget":"gone","handler":"handle","ownerScopeId":"two"}
            ]}),
        ],
    );
    assert!(stale.is_empty());
}

#[test]
fn parent_binding_delta_preserves_internal_property_writes_and_resets_removed_defaults() {
    let mut engine = fixture();
    let mut initial = record("one", "A");
    initial["properties"] = json!({"label":"A","title-text":"bound","undeclared":"ignored"});
    let first = reconcile(&mut engine, "prepare", vec![initial.clone()], vec![]);
    assert_eq!(
        first["instances"][0]["snapshot"]["data"]["titleText"],
        "bound"
    );
    assert!(first["instances"][0]["snapshot"]["data"]
        .get("undeclared")
        .is_none());
    global(
        &mut engine,
        "__container_invoke_component",
        vec![json!(1), json!("editLabel"), json!(["local"])],
    );
    let before = trace(&mut engine);
    let same = reconcile(&mut engine, "prepare", vec![initial], vec![]);
    assert_eq!(same["instances"][0]["snapshot"]["data"]["label"], "local");
    assert_eq!(same["instances"][0]["snapshot"]["properties"]["label"], "A");
    assert_eq!(
        trace(&mut engine),
        before,
        "unchanged external bindings do not rerun property observers"
    );
    let changed = reconcile(&mut engine, "prepare", vec![record("one", "B")], vec![]);
    assert_eq!(changed["instances"][0]["snapshot"]["data"]["label"], "B");
    assert_eq!(
        changed["instances"][0]["snapshot"]["data"]["titleText"],
        "fallback"
    );
    let mut removed = record("one", "unused");
    removed["properties"] = json!({});
    let reset = reconcile(&mut engine, "prepare", vec![removed.clone()], vec![]);
    assert_eq!(
        reset["instances"][0]["snapshot"]["data"]["label"],
        "default"
    );
    assert_eq!(
        reset["instances"][0]["snapshot"]["properties"]["label"],
        "default"
    );
    let before = trace(&mut engine);
    reconcile(&mut engine, "prepare", vec![removed], vec![]);
    assert_eq!(trace(&mut engine), before);
}

#[test]
fn nested_named_registration_restores_parent_context_and_rolls_back_nested_failures() {
    let mut engine = NativeEngine::default();
    global(
        &mut engine,
        "__container_configure_component_modules",
        vec![json!(["outer", "inner"])],
    );
    assert!(engine
        .load_module_with_id(
            "outer",
            br#"
      __container_evaluate_named_module('inner', function() { Component({data:{name:'inner'}}); });
      Component({data:{name:'outer'}});
      throw new Error('rollback both registrations');
    "#
        )
        .is_err());
    let registration = global(&mut engine, "__container_registration_snapshot", vec![]);
    assert_eq!(registration[0]["components"], 0);
    engine
        .load_module_with_id(
            "outer",
            br#"
      __container_evaluate_named_module('inner', function() { Component({data:{name:'inner'}}); });
      Component({data:{name:'outer'}});
    "#,
        )
        .expect("nested named modules register independently");
    let result = global(
        &mut engine,
        "__container_reconcile_components",
        vec![json!({
            "version":1,"phase":"prepare","pageId":1,"instances":[
              {"scopeId":"outer","moduleId":"outer","parentScopeId":null,"ownerScopeId":null,"properties":{}},
              {"scopeId":"inner","moduleId":"inner","parentScopeId":"outer","ownerScopeId":"outer","properties":{}}
            ],"remove":[]
        })],
    );
    assert_eq!(
        result[0]["instances"][0]["snapshot"]["data"]["name"],
        "outer"
    );
    assert_eq!(
        result[0]["instances"][1]["snapshot"]["data"]["name"],
        "inner"
    );
}

#[test]
fn throwing_one_shot_lifecycles_are_consumed_once_and_reported_once() {
    let mut engine = NativeEngine::default();
    global(
        &mut engine,
        "__container_configure_component_modules",
        vec![json!(["throwing"])],
    );
    engine
        .load_module_with_id(
            "throwing",
            br#"
      globalThis.__throw_counts = {created:0,attached:0,ready:0,detached:0};
      globalThis.__throw_read = () => ({counts:__throw_counts});
      Component({lifetimes:{
        created(){ __throw_counts.created++; throw new Error('created failure'); },
        attached(){ __throw_counts.attached++; throw new Error('attached failure'); },
        ready(){ __throw_counts.ready++; throw new Error('ready failure'); },
        detached(){ __throw_counts.detached++; throw new Error('detached failure'); }
      }});
    "#,
        )
        .expect("throwing component definition registers without invoking hooks");
    let instance = json!({"scopeId":"throwing","moduleId":"throwing","parentScopeId":null,"ownerScopeId":null,"properties":{}});
    let first = reconcile(&mut engine, "prepare", vec![instance.clone()], vec![]);
    assert_eq!(first["instances"][0]["snapshot"]["created"], true);
    global(
        &mut engine,
        "__container_invoke_component",
        vec![json!(1), json!("created"), json!([])],
    );
    for phase in ["attach", "attach", "ready", "ready"] {
        reconcile(&mut engine, phase, vec![instance.clone()], vec![]);
    }
    let disposed = reconcile(&mut engine, "dispose", vec![instance], vec![]);
    assert_eq!(
        disposed["instances"][0]["snapshot"]["lifecycle"],
        json!([
            "created:error",
            "attached:error",
            "ready:error",
            "detached:error"
        ])
    );
    assert_eq!(disposed["instances"][0]["snapshot"]["mounted"], false);
    reconcile(&mut engine, "dispose", vec![], vec![json!("throwing")]);
    assert_eq!(
        global(&mut engine, "__throw_read", vec![])[0]["counts"],
        json!({"created":1,"attached":1,"ready":1,"detached":1})
    );
    let effects = engine
        .drain_host_events()
        .expect("lifecycle diagnostics drain");
    let errors: Vec<&Value> = effects
        .iter()
        .flat_map(|batch| batch["errors"].as_array().into_iter().flatten())
        .collect();
    for name in ["created", "attached", "ready", "detached"] {
        let message = format!("{name} failure");
        assert_eq!(
            errors
                .iter()
                .filter(|error| error["message"]
                    .as_str()
                    .is_some_and(|value| value.contains(&message)))
                .count(),
            1
        );
    }
}

#[test]
fn public_event_ids_are_separate_from_internal_propagation_identities() {
    let mut engine = NativeEngine::default();
    JsEngine::load_module(
        &mut engine,
        br#"
      globalThis.__public_events=[];
      globalThis.__public_read=()=>({events:__public_events});
      Page({data:{}, first(event){
        __public_events.push({handler:'first',id:event.currentTarget.id,target:event.target.id});
        event.stopPropagation();
      }, same(event){
        __public_events.push({handler:'same',id:event.currentTarget.id,target:event.target.id});
      }, next(){__public_events.push({handler:'must-not-run'});}});
    "#,
    )
    .expect("event identity fixture evaluates");
    let results = global(
        &mut engine,
        "__container_invoke_page_event",
        vec![
            json!(0),
            json!({"dispatches":[
              {"current_target":"internal:one","target":"internal:target","publicCurrentTargetId":"duplicate","publicTargetId":"public-target","handler":"first"},
              {"current_target":"internal:one","target":"internal:target","publicCurrentTargetId":"","publicTargetId":"","handler":"same"},
              {"current_target":"internal:two","target":"internal:target","publicCurrentTargetId":"duplicate","publicTargetId":"public-target","handler":"next"}
            ]}),
        ],
    );
    assert_eq!(
        results.len(),
        2,
        "stopPropagation finishes only listeners on the same internal target"
    );
    assert_eq!(
        global(&mut engine, "__public_read", vec![])[0]["events"],
        json!([
          {"handler":"first","id":"duplicate","target":"public-target"},
          {"handler":"same","id":"","target":""}
        ])
    );
}

fn page_lifetime_fixture() -> NativeEngine {
    let mut engine = NativeEngine::default();
    global(
        &mut engine,
        "__container_configure_component_modules",
        vec![json!(["component:counter"])],
    );
    engine
        .load_module_with_id(
            "component:counter",
            br#"
      globalThis.__page_hooks = [];
      globalThis.__page_hooks_read = () => ({trace:__page_hooks});
      Component({
        data: { shows:0, hides:0 },
        methods: {
          show(){ throw new Error('ordinary show must never run'); },
          hide(){ throw new Error('ordinary hide must never run'); },
          resize(){ throw new Error('ordinary resize must never run'); }
        },
        pageLifetimes: {
          show(){
            __page_hooks.push(['show', this.scopeId]);
            this.setData({shows:this.data.shows+1});
            if(this.scopeId === 'one') throw new Error('show failure');
          },
          hide(){
            __page_hooks.push(['hide', this.scopeId]);
            this.setData({hides:this.data.hides+1});
          },
          resize(size){ __page_hooks.push(['resize', this.scopeId, size]); }
        }
      });
    "#,
        )
        .expect("page lifetime component registers");
    engine
}

fn page_lifetimes(engine: &mut NativeEngine, name: &str, scopes: Value, args: Value) -> Value {
    global(
        engine,
        "__container_invoke_component_page_lifetimes",
        vec![json!({"version":1,"pageId":1,"name":name,"args":args,"scopeIds":scopes})],
    )
    .remove(0)
}

#[test]
fn batched_page_lifetimes_isolate_methods_errors_and_visibility_attempts() {
    let mut engine = page_lifetime_fixture();
    let records = vec![record("one", "A"), record("two", "B")];
    reconcile(&mut engine, "prepare", records.clone(), vec![]);
    assert_eq!(
        page_lifetimes(&mut engine, "show", json!(["one", "two"]), json!([])),
        json!({"instances":[]}),
        "created-only occurrences have no page visibility yet"
    );
    reconcile(&mut engine, "attach", records.clone(), vec![]);
    for _ in 0..2 {
        let result = page_lifetimes(&mut engine, "show", json!(["one", "two"]), json!([]));
        assert_eq!(result["instances"][0]["snapshot"]["data"]["shows"], 1);
        assert_eq!(result["instances"][1]["snapshot"]["data"]["shows"], 1);
    }
    for _ in 0..2 {
        let result = page_lifetimes(&mut engine, "hide", json!(["one", "two"]), json!([]));
        assert_eq!(result["instances"][0]["snapshot"]["data"]["hides"], 1);
    }
    page_lifetimes(
        &mut engine,
        "resize",
        json!(["one", "two"]),
        json!([{"windowWidth":320,"windowHeight":640}]),
    );
    assert_eq!(
        global(&mut engine, "__page_hooks_read", vec![])[0]["trace"],
        json!([
            ["show","one"], ["show","two"], ["hide","one"], ["hide","two"],
            ["resize","one",{"windowWidth":320,"windowHeight":640}],
            ["resize","two",{"windowWidth":320,"windowHeight":640}]
        ])
    );
    let effects = engine.drain_host_events().expect("hook effects drain");
    let errors = effects
        .iter()
        .flat_map(|batch| batch["errors"].as_array().into_iter().flatten())
        .collect::<Vec<_>>();
    assert_eq!(
        errors.len(),
        1,
        "a throwing show is consumed; siblings continue"
    );
    assert_eq!(errors[0]["message"], "show failure");
    reconcile(&mut engine, "dispose", records, vec![]);
    assert_eq!(
        page_lifetimes(&mut engine, "show", json!(["one", "two"]), json!([])),
        json!({"instances":[]}),
        "disposed occurrences receive no more hooks"
    );
}

#[test]
fn page_lifetime_batch_prevalidates_all_scopes_before_any_callback() {
    let mut engine = page_lifetime_fixture();
    reconcile(&mut engine, "prepare", vec![record("one", "A")], vec![]);
    reconcile(&mut engine, "attach", vec![record("one", "A")], vec![]);
    let foreign = record("foreign", "B");
    for phase in ["prepare", "attach"] {
        global(
            &mut engine,
            "__container_reconcile_components",
            vec![json!({
                "version":1,"phase":phase,"pageId":2,"instances":[foreign],"remove":[]
            })],
        );
    }
    for batch in [
        json!({"version":1,"pageId":1,"name":"show","args":[],"scopeIds":["one","foreign"]}),
        json!({"version":1,"pageId":1,"name":"show","args":[],"scopeIds":["one","one"]}),
        json!({"version":1,"pageId":1,"name":"invalid","args":[],"scopeIds":["one"]}),
        json!({"version":1,"pageId":1,"name":"show","args":{},"scopeIds":["one"]}),
    ] {
        assert!(JsEngine::call(
            &mut engine,
            CallTarget::Global {
                name: "__container_invoke_component_page_lifetimes".into()
            },
            vec![batch]
        )
        .is_err());
    }
    assert_eq!(
        global(&mut engine, "__page_hooks_read", vec![])[0]["trace"],
        json!([])
    );
    assert_eq!(
        page_lifetimes(&mut engine, "show", json!(["one"]), json!([]))["instances"][0]["snapshot"]
            ["data"]["shows"],
        1,
        "invalid batches did not consume the legitimate show transition"
    );
}
