// Live component selection contract shared by the two native engines.
// This covers the documented selector subset; it is not DevTools evidence.
use container_core::{CallTarget, JsEngine, ValueBatch};
use serde_json::{json, Value};

fn global(engine: &mut NativeEngine, name: &str, args: ValueBatch) -> ValueBatch {
    JsEngine::call(engine, CallTarget::Global { name: name.into() }, args)
        .expect("component selection fixture call succeeds")
}

fn fixture() -> NativeEngine {
    let mut engine = NativeEngine::default();
    JsEngine::load_module(&mut engine, br#"
      Page({data:{}});
      globalThis.__selection_refs = Object.create(null);
      globalThis.__selection_attached = [];
      globalThis.__selection_read = function(pageId, scope, selector, all) {
        const owner = scope == null ? __container_page_instances[String(pageId)] : __container_component_scopes[scope];
        const result = all ? owner.selectAllComponents(selector) : owner.selectComponent(selector);
        return {value:all ? result.map(item => item.scopeId) : (result && result.scopeId)};
      };
      globalThis.__selection_status = function() { return {trace:__selection_attached}; };
      globalThis.__selection_save = function(name, scope) { __selection_refs[name] = __container_component_scopes[scope]; return true; };
      globalThis.__selection_saved = function(name) {
        const saved = __selection_refs[name];
        const owner = saved.selectOwnerComponent();
        return { owner: owner && owner.scopeId, children: saved.selectAllComponents('.child').map(item => item.scopeId) };
      };
      globalThis.__selection_identity = function() {
        const page = __container_page_instances['1'];
        const instance = page.selectComponent('#panel');
        instance.bump();
        return { actual: instance === __container_component_scopes['panel'],
          definition: instance === __container_components[0], id:instance.id, count:instance.data.count,
          owner: __container_component_scopes['inside'].selectOwnerComponent() === instance,
          slottedOwner: __container_component_scopes['slotted'].selectOwnerComponent() === instance };
      };
      globalThis.__selection_syntax = function(selector) {
        try { __container_page_instances['1'].selectComponent(selector); return {ok:true}; }
        catch(error) { return {code:error.code,message:error.message}; }
      };
    "#).expect("selection page and helpers evaluate");
    global(
        &mut engine,
        "__container_set_current_pages",
        vec![
            json!([0, 0]),
            json!([
                {"index":0,"instanceId":1,"route":"pages/test"},
                {"index":0,"instanceId":2,"route":"pages/test"}
            ]),
        ],
    );
    global(
        &mut engine,
        "__container_configure_component_modules",
        vec![json!(["selection:node"])],
    );
    engine
        .load_module_with_id(
            "selection:node",
            br#"
      Component({
        properties:{label:{type:String,value:'default'}}, data:{count:0},
        lifetimes:{attached(){
          __selection_attached.push({scope:this.scopeId,
            children:this.selectAllComponents('.child').map(item => item.scopeId)});
        }},
        methods:{bump(){this.setData({count:this.data.count+1});}}
      });
    "#,
        )
        .expect("selection component definition registers");
    engine
}

fn node(id: &str, classes: &[&str]) -> Value {
    json!({"id":id,"classes":classes,"tag":"view"})
}

fn record(
    scope: &str,
    owner: Option<&str>,
    parent: Option<&str>,
    order: usize,
    ancestors: Vec<Value>,
) -> Value {
    let classes: Vec<&str> = match scope {
        "panel" => vec!["panel", "common"],
        "inside" => vec!["child", "red"],
        "slotted" => vec!["child", "slotted"],
        _ => vec!["child", "common"],
    };
    json!({"scopeId":scope,"moduleId":"selection:node","parentScopeId":parent,"ownerScopeId":owner,
        "properties":{"label":scope},
        "selection":{"id":if scope == "inside" {"duplicate"} else {scope},"classes":classes,
          "tag":"custom-node","ancestors":ancestors,"order":order}})
}

fn records() -> Vec<Value> {
    vec![
        record("panel", None, None, 0, vec![node("root", &["root"])]),
        record(
            "inside",
            Some("panel"),
            Some("panel"),
            1,
            vec![node("wrapper", &["wrapper"])],
        ),
        // Page-declared slot content physically inside panel; its owner is the page.
        record(
            "slotted",
            None,
            Some("panel"),
            2,
            vec![node("root", &["root"]), node("panel", &["panel", "common"])],
        ),
        record("second", None, None, 3, vec![node("root", &["root"])]),
    ]
}

fn reconcile(
    engine: &mut NativeEngine,
    page: u64,
    phase: &str,
    records: Vec<Value>,
    remove: Vec<&str>,
) -> Value {
    global(
        engine,
        "__container_reconcile_components",
        vec![json!({
            "version":1,"phase":phase,"pageId":page,"instances":records,"remove":remove
        })],
    )
    .remove(0)
}

fn read(
    engine: &mut NativeEngine,
    page: u64,
    scope: Option<&str>,
    selector: &str,
    all: bool,
) -> Value {
    global(
        engine,
        "__selection_read",
        vec![json!(page), json!(scope), json!(selector), json!(all)],
    )
    .remove(0)["value"]
        .clone()
}

#[test]
fn selection_returns_live_instances_and_declaration_scope_preserves_slot_ownership() {
    let mut engine = fixture();
    reconcile(&mut engine, 1, "prepare", records(), vec![]);
    reconcile(&mut engine, 1, "attach", records(), vec![]);
    assert_eq!(
        read(&mut engine, 1, None, ".child", true),
        json!(["slotted", "second"])
    );
    assert_eq!(
        read(&mut engine, 1, Some("panel"), ".child", true),
        json!(["inside"])
    );
    assert_eq!(read(&mut engine, 1, None, "#duplicate", false), Value::Null);
    assert_eq!(
        read(&mut engine, 1, Some("panel"), "#duplicate.red", false),
        json!("inside")
    );
    assert_eq!(
        global(&mut engine, "__selection_identity", vec![])[0],
        json!({
            "actual":true,"definition":false,"id":"panel","count":1,"owner":true,"slottedOwner":false
        })
    );
    assert_eq!(
        global(&mut engine, "__selection_status", vec![])[0]["trace"][0],
        json!({"scope":"panel","children":["inside"]}),
        "attached can select the complete published graph, including children attached later"
    );
}

#[test]
fn selectors_apply_declaration_ancestors_groups_and_document_order_once() {
    let mut engine = fixture();
    reconcile(&mut engine, 1, "prepare", records(), vec![]);
    assert_eq!(
        read(&mut engine, 1, None, "#root > .panel.common", true),
        json!(["panel"])
    );
    assert_eq!(
        read(&mut engine, 1, None, "#root .slotted", true),
        json!(["slotted"])
    );
    assert_eq!(
        read(&mut engine, 1, None, "#root > .slotted", true),
        json!([])
    );
    assert_eq!(
        read(&mut engine, 1, None, "#panel > .slotted", true),
        json!(["slotted"])
    );
    assert_eq!(
        read(&mut engine, 1, None, "#second, .panel, .common", true),
        json!(["panel", "second"]),
        "selector groups form a deduplicated document-order union"
    );
    assert_eq!(
        read(
            &mut engine,
            1,
            Some("panel"),
            ".wrapper > .child.red",
            false
        ),
        json!("inside")
    );
    let mut mixed = records();
    mixed.push(record(
        "mixed",
        None,
        None,
        4,
        vec![
            node("", &["a"]),
            node("", &["b"]),
            node("", &["x"]),
            node("", &["b"]),
        ],
    ));
    reconcile(&mut engine, 1, "prepare", mixed, vec![]);
    assert_eq!(read(&mut engine,1,None,".a > .b .child",true),json!(["mixed"]),
        "descendant matching explores an earlier ancestor when the nearest match fails a child combinator");
    let mut reordered = records();
    reordered[0]["selection"]["order"] = json!(3);
    reordered[3]["selection"]["order"] = json!(0);
    reconcile(&mut engine, 1, "prepare", reordered, vec![]);
    assert_eq!(
        read(&mut engine, 1, None, ".common", true),
        json!(["second", "panel"])
    );
}

#[test]
fn selection_is_page_instance_scoped_even_for_duplicate_route_registrations() {
    let mut engine = fixture();
    reconcile(&mut engine, 1, "prepare", records(), vec![]);
    let mut foreign = record("foreign", None, None, 0, vec![]);
    foreign["selection"]["id"] = json!("panel");
    reconcile(&mut engine, 2, "prepare", vec![foreign], vec![]);
    assert_eq!(read(&mut engine, 1, None, "#panel", false), json!("panel"));
    assert_eq!(
        read(&mut engine, 2, None, "#panel", false),
        json!("foreign")
    );
    assert_eq!(
        read(&mut engine, 2, None, ".child", true),
        json!(["foreign"])
    );
    assert_eq!(read(&mut engine, 1, None, "#foreign", false), Value::Null);
    reconcile(&mut engine, 1, "prepare", vec![], vec![]);
    assert_eq!(
        read(&mut engine, 2, None, "#panel", false),
        json!("foreign")
    );
}

#[test]
fn invalid_selection_metadata_is_rejected_before_any_graph_or_hook_changes() {
    let mut engine = fixture();
    reconcile(&mut engine, 1, "prepare", records(), vec![]);
    let malformed = [
        json!(null),
        json!({"id":"bad","tag":"node","classes":[],"ancestors":[],"order":-1}),
        json!({"id":"bad","tag":"node","classes":["two classes"],"ancestors":[],"order":5}),
        json!({"id":"bad","tag":"node","classes":[],"ancestors":[{}],"order":5}),
    ];
    // null is the legacy absence representation and is allowed; malformed
    // records after it must still prevent the batch from changing visibility.
    for (index, selection) in malformed.into_iter().enumerate().skip(1) {
        let mut bad = record("new", None, None, 5, vec![]);
        bad["selection"] = selection;
        let result = JsEngine::call(
            &mut engine,
            CallTarget::Global {
                name: "__container_reconcile_components".into(),
            },
            vec![json!({
                "version":1,"phase":"prepare","pageId":1,"instances":[bad],"remove":["panel"]
            })],
        );
        assert!(result.is_err(), "malformed metadata {index}");
        assert_eq!(read(&mut engine, 1, None, "#panel", false), json!("panel"));
    }
    let mut duplicate = records();
    duplicate[3]["selection"]["order"] = json!(0);
    assert!(JsEngine::call(
        &mut engine,
        CallTarget::Global {
            name: "__container_reconcile_components".into()
        },
        vec![json!({
            "version":1,"phase":"prepare","pageId":1,"instances":duplicate,"remove":[]
        })]
    )
    .is_err());
    assert_eq!(
        read(&mut engine, 1, None, ".common", true),
        json!(["panel", "second"])
    );
    assert_eq!(
        global(&mut engine, "__selection_status", vec![])[0]["trace"],
        json!([])
    );
}

#[test]
fn frontier_replacement_hides_removed_nodes_and_detach_invalidates_retained_receivers() {
    let mut engine = fixture();
    reconcile(&mut engine, 1, "prepare", records(), vec![]);
    reconcile(&mut engine, 1, "attach", records(), vec![]);
    global(
        &mut engine,
        "__selection_save",
        vec![json!("old-panel"), json!("panel")],
    );
    global(
        &mut engine,
        "__selection_save",
        vec![json!("old-inside"), json!("inside")],
    );
    reconcile(&mut engine, 1, "prepare", vec![records().remove(3)], vec![]);
    assert_eq!(
        read(&mut engine, 1, None, "#panel", false),
        Value::Null,
        "removed metadata is unavailable before delayed detach cleanup"
    );
    assert_eq!(
        read(&mut engine, 1, None, ".common", true),
        json!(["second"])
    );
    reconcile(
        &mut engine,
        1,
        "dispose",
        vec![],
        vec!["inside", "panel", "slotted"],
    );
    assert_eq!(
        global(&mut engine, "__selection_saved", vec![json!("old-panel")])[0],
        json!({"owner":null,"children":[]})
    );
    assert_eq!(
        global(&mut engine, "__selection_saved", vec![json!("old-inside")])[0],
        json!({"owner":null,"children":[]})
    );
    reconcile(&mut engine, 1, "prepare", records(), vec![]);
    assert_eq!(
        global(&mut engine, "__selection_saved", vec![json!("old-panel")])[0],
        json!({"owner":null,"children":[]}),
        "a replacement using the same scope cannot reactivate the disposed instance"
    );
}

#[test]
fn legacy_component_helpers_without_host_metadata_are_not_selection_candidates() {
    let mut engine = fixture();
    let mut legacy = record("legacy", None, None, 0, vec![]);
    legacy.as_object_mut().unwrap().remove("selection");
    reconcile(&mut engine, 1, "prepare", vec![legacy], vec![]);
    assert_eq!(read(&mut engine, 1, None, "#legacy", false), Value::Null);
    assert_eq!(read(&mut engine, 1, None, ".child", true), json!([]));
}

#[test]
fn invalid_and_unsupported_selectors_fail_explicitly_instead_of_empty_success() {
    let mut engine = fixture();
    reconcile(&mut engine, 1, "prepare", records(), vec![]);
    for selector in [json!(null), json!(123), json!("")] {
        assert_eq!(
            global(&mut engine, "__selection_syntax", vec![selector])[0]["code"],
            "ERR_INVALID_REQUEST"
        );
    }
    for selector in [
        "custom-node",
        "[id=panel]",
        ".panel >>> .child",
        ".panel >",
        ",.panel",
        ".panel + .child",
    ] {
        assert_eq!(
            global(&mut engine, "__selection_syntax", vec![json!(selector)])[0]["code"],
            "ERR_UNSUPPORTED_CAPABILITY",
            "{selector}"
        );
    }
    assert_eq!(read(&mut engine, 1, None, ".missing", false), Value::Null);
    assert_eq!(read(&mut engine, 1, None, ".missing", true), json!([]));
}

#[test]
fn exported_interfaces_are_explicitly_unsupported_without_leaking_private_instances() {
    let mut engine = fixture();
    global(
        &mut engine,
        "__container_configure_component_modules",
        vec![json!(["selection:exported"])],
    );
    engine.load_module_with_id("selection:exported",br#"
      Component({behaviors:[Behavior({behaviors:['wx://component-export'],export(){return {public:true};}})],data:{secret:42}});
      globalThis.__selection_export_test=function(){
        const page=__container_page_instances['1'];
        const child=__container_component_scopes['nested-export'];
        return ['single','all','owner'].map(function(kind){
          try {
            const result=kind==='single'?page.selectComponent('#exported'):
              kind==='all'?page.selectAllComponents('.exported'):child.selectOwnerComponent();
            return {kind:kind,leaked:!!result};
          }catch(error){return {kind:kind,code:error.code};}
        });
      };
    "#).expect("export fixture registers");
    let mut exporter = record("exported", None, None, 0, vec![]);
    exporter["moduleId"] = json!("selection:exported");
    exporter["selection"]["classes"] = json!(["exported"]);
    let nested = record(
        "nested-export",
        Some("exported"),
        Some("exported"),
        1,
        vec![],
    );
    reconcile(&mut engine, 1, "prepare", vec![exporter, nested], vec![]);
    let results = global(&mut engine, "__selection_export_test", vec![]);
    assert_eq!(results.len(), 3);
    for result in results {
        assert_eq!(result["code"], "ERR_UNSUPPORTED_CAPABILITY");
        assert!(result.get("leaked").is_none());
    }
}

#[test]
fn native_first_match_returns_null_while_all_selection_filters_native_nodes() {
    let mut engine = fixture();
    let mut custom = record("second", None, None, 1, vec![]);
    custom["selection"]["id"] = json!("collision");
    let native = json!({"ownerScopeId":null,"componentScopeId":null,
      "selection":{"id":"collision","classes":["child","common"],"tag":"view","ancestors":[],"order":0}});
    let custom_node =
        json!({"ownerScopeId":null,"componentScopeId":"second","selection":custom["selection"]});
    global(
        &mut engine,
        "__container_reconcile_components",
        vec![json!({
            "version":1,"phase":"prepare","pageId":1,"instances":[custom],"remove":[],
            "selectionNodes":[native,custom_node]
        })],
    );
    assert_eq!(read(&mut engine, 1, None, "#collision", false), Value::Null);
    assert_eq!(read(&mut engine, 1, None, ".common", false), Value::Null);
    assert_eq!(
        read(&mut engine, 1, None, "#collision", true),
        json!(["second"])
    );
    assert_eq!(
        read(&mut engine, 1, None, ".common", true),
        json!(["second"])
    );
    for selection_nodes in [
        json!([]),
        json!([native, native, custom_node]),
        json!([
          {"ownerScopeId":null,"componentScopeId":"nonexistent","selection":custom_node["selection"]}
        ]),
    ] {
        assert!(JsEngine::call(
            &mut engine,
            CallTarget::Global {
                name: "__container_reconcile_components".into()
            },
            vec![json!({
              "version":1,"phase":"prepare","pageId":1,"instances":[custom],"remove":["second"],
              "selectionNodes":selection_nodes
            })]
        )
        .is_err());
        assert_eq!(
            read(&mut engine, 1, None, "#collision", true),
            json!(["second"]),
            "invalid full-node metadata preserves accepted selection"
        );
    }
    let nullable_scope = record("null", None, None, 2, vec![]);
    global(
        &mut engine,
        "__container_reconcile_components",
        vec![json!({
            "version":1,"phase":"prepare","pageId":1,"instances":[custom,nullable_scope],"remove":[],
            "selectionNodes":[native,custom_node,{"ownerScopeId":null,"componentScopeId":"null","selection":nullable_scope["selection"]}]
        })],
    );
    reconcile(&mut engine, 1, "dispose", vec![], vec!["null"]);
    assert_eq!(
        read(&mut engine, 1, None, "#collision", false),
        Value::Null,
        "a scope literally named null cannot remove unrelated native page nodes"
    );
    assert_eq!(
        read(&mut engine, 1, None, "#collision", true),
        json!(["second"])
    );
}

#[test]
fn publish_restores_selection_metadata_without_repeating_user_hooks_or_property_effects() {
    let mut engine = fixture();
    reconcile(&mut engine, 1, "prepare", records(), vec![]);
    reconcile(&mut engine, 1, "attach", records(), vec![]);
    let before = global(&mut engine, "__selection_status", vec![])[0].clone();
    let mut changed = records();
    changed[3]["selection"]["id"] = json!("changed-id");
    changed[3]["properties"]["label"] = json!("changed-label");
    reconcile(&mut engine, 1, "prepare", changed, vec![]);
    assert_eq!(
        read(&mut engine, 1, None, "#changed-id", false),
        json!("second")
    );
    engine
        .drain_host_events()
        .expect("candidate property effects drain");
    let restored = reconcile(&mut engine, 1, "publish", records(), vec![]);
    assert_eq!(
        read(&mut engine, 1, None, "#second", false),
        json!("second")
    );
    assert_eq!(
        read(&mut engine, 1, None, "#changed-id", false),
        Value::Null
    );
    assert_eq!(restored["instances"][3]["snapshot"]["properties"]["label"],"changed-label",
      "publication restores graph metadata rather than pretending to roll back JS heap side effects");
    assert_eq!(global(&mut engine, "__selection_status", vec![])[0], before);
    let effects = engine
        .drain_host_events()
        .expect("publication effects drain");
    assert!(effects
        .iter()
        .all(|batch| batch["events"].as_array().unwrap().is_empty()));
    global(
        &mut engine,
        "__container_reconcile_components",
        vec![json!({
          "version":1,"phase":"publish","pageId":1,"instances":[],"remove":[],"selectionNodes":[]
        })],
    );
    assert_eq!(read(&mut engine, 1, None, ".common", true), json!([]));
    assert!(JsEngine::call(&mut engine,CallTarget::Global{name:"__container_reconcile_components".into()},vec![json!({
      "version":1,"phase":"publish","pageId":1,"instances":[record("new",None,None,0,vec![])],"remove":[]
    })]).is_err(),"publication never constructs missing instances");
}

#[test]
fn component_selection_capabilities_are_partial_by_default_and_negotiated_denial_is_enforced() {
    let mut engine = fixture();
    reconcile(&mut engine, 1, "prepare", records(), vec![]);
    JsEngine::load_module(&mut engine,br#"
      globalThis.__selection_capabilities=function(attempt){
        const page=__container_page_instances['1'];
        const component=__container_component_scopes['panel'];
        return [
          ['Page.selectComponent',page,'selectComponent'],
          ['Page.selectAllComponents',page,'selectAllComponents'],
          ['Component.selectComponent',component,'selectComponent'],
          ['Component.selectAllComponents',component,'selectAllComponents'],
          ['Component.selectOwnerComponent',component,'selectOwnerComponent']
        ].map(function(entry){
          const record={name:entry[0],available:wx.canIUse(entry[0])};
          if(attempt){try{entry[1][entry[2]]('.child');record.succeeded=true;}catch(error){record.code=error.code;}}
          return record;
        });
      };
    "#).expect("capability fixture loads");
    let defaults = global(&mut engine, "__selection_capabilities", vec![json!(false)]);
    assert_eq!(defaults.len(), 5);
    assert!(defaults.iter().all(|record| record["available"] == true));
    let capabilities = defaults
        .iter()
        .map(|record| {
            (
                record["name"].as_str().unwrap().to_owned(),
                "unsupported".to_owned(),
            )
        })
        .collect();
    engine
        .set_capabilities(&capabilities)
        .expect("selection capabilities are negotiated");
    let denied = global(&mut engine, "__selection_capabilities", vec![json!(true)]);
    assert_eq!(denied.len(), 5);
    for record in denied {
        assert_eq!(record["available"], false);
        assert_eq!(record["code"], "ERR_UNSUPPORTED_CAPABILITY");
        assert!(record.get("succeeded").is_none());
    }
}
