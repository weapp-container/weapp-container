//! Synthetic accepted-tree contracts. No native-window/presentation evidence.
use super::*;
use container_render_skia::{Rect, RenderNode};
use std::collections::BTreeMap;
const ROUTE: &str = "pages/index/index";
fn facts(frame: &RenderFrame) -> Value {
    json!({"kind":"local-accepted-tree-facts-v1","sessionId":"node-local-test","route":ROUTE,
        "pageId":"1","templateRevision":"2","frameId":frame.frame_id.to_string(),"renderRevision":"3"})
}
fn frame() -> RenderFrame {
    let mut root = RenderNode::new(
        "root",
        Rect {
            x: 0.,
            y: 0.,
            width: 100.,
            height: 100.,
        },
    );
    root.tag = Some("view".into());
    for (index, x) in [10., 60.].iter().enumerate() {
        let mut child = RenderNode::new(
            "duplicate",
            Rect {
                x: *x,
                y: 10.,
                width: 25.,
                height: 25.,
            },
        );
        child.tag = Some("button".into());
        child.attributes.insert("id".into(), "duplicate".into());
        child.classes.push("candidate".into());
        child.event_identity = Some(format!("event:occurrence:{index}"));
        root.children.push(child);
    }
    RenderFrame {
        frame_id: 4,
        viewport: Rect {
            x: 0.,
            y: 0.,
            width: 100.,
            height: 100.,
        },
        root,
        images: BTreeMap::new(),
    }
}
fn request(target: Value, selection: &str) -> AcquireRequest {
    AcquireRequest::parse(&json!({"id":1,"op":ACQUIRE,"version":1,"route":ROUTE,"target":target,"selection":selection})).unwrap()
}
fn select(o: &Observer, f: &RenderFrame, selection: &str) -> Value {
    acquire(
        o,
        f,
        EngineKind::Quickjs,
        facts(f),
        &request(json!({"query":{"selector":".candidate"}}), selection),
    )
    .unwrap()
}
fn tap(handle: Value) -> TapRequest {
    TapRequest::parse(&json!({"id":2,"op":TAP,"version":1,"route":ROUTE,"node":handle})).unwrap()
}
#[test]
fn duplicate_public_ids_multi_matches_select_actual_first_and_distinct_opaque_handles() {
    let o = Observer::new().unwrap();
    let f = frame();
    let all = select(&o, &f, "all");
    let first = select(&o, &f, "first");
    assert_eq!(all["count"], 2);
    assert_eq!(all["matchCount"], 2);
    assert_eq!(first["count"], 1);
    assert_eq!(first["matchCount"], 2);
    assert_eq!(first["nodes"][0], all["nodes"][0]);
    assert_eq!(
        all["nodes"][0]["metadata"]["id"],
        all["nodes"][1]["metadata"]["id"]
    );
    assert_ne!(all["nodes"][0]["handle"], all["nodes"][1]["handle"]);
    let prepared = prepare_tap(
        &o,
        &f,
        EngineKind::Quickjs,
        facts(&f),
        &tap(first["nodes"][0]["handle"].clone()),
    )
    .unwrap();
    assert_eq!((prepared.x, prepared.y), (22.5, 22.5));
    assert!(prepared.proof.get("selector").is_none());
    assert!(prepared.proof.get("target").is_none());
}
#[test]
fn first_order_is_actual_query_order_and_no_match_does_not_invent_a_node() {
    let o = Observer::new().unwrap();
    let mut f = frame();
    f.root.children.reverse();
    let first = select(&o, &f, "first");
    assert_eq!(
        first["nodes"][0]["metadata"]["eventIdentity"],
        "event:occurrence:1"
    );
    let empty = acquire(
        &o,
        &f,
        EngineKind::Quickjs,
        facts(&f),
        &request(json!({"query":{"selector":"#missing"}}), "first"),
    )
    .unwrap();
    assert_eq!(empty["count"], 0);
    assert_eq!(empty["matchCount"], 0);
    assert_eq!(empty["nodes"], json!([]));
}
#[test]
fn parent_receiver_is_the_actual_opaque_component_host_even_with_duplicate_public_id() {
    let o = Observer::new().unwrap();
    let mut f = frame();
    for (index, node) in f.root.children.iter_mut().enumerate() {
        let scope = format!("component-{index}");
        node.component_scope_id = Some(scope.clone());
        let mut child = RenderNode::new(
            "same-child",
            Rect {
                x: 1.,
                y: 1.,
                width: 5.,
                height: 5.,
            },
        );
        child.tag = Some("text".into());
        child.classes.push("child".into());
        child.event_owner_scope_id = Some(scope);
        child.event_identity = Some(format!("event:child-{index}"));
        node.children.push(child);
    }
    let hosts = select(&o, &f, "all");
    for index in 0..2 {
        let value = acquire(
            &o,
            &f,
            EngineKind::Quickjs,
            facts(&f),
            &request(
                json!({"parent":hosts["nodes"][index]["handle"],"selector":".child"}),
                "first",
            ),
        )
        .unwrap();
        assert_eq!(value["count"], 1);
        assert_eq!(
            value["nodes"][0]["metadata"]["eventIdentity"],
            format!("event:child-{index}")
        );
        assert_eq!(value["nodes"][0]["parent"], hosts["nodes"][index]["handle"]);
    }
}
#[test]
fn stale_page_session_engine_template_frame_revision_and_fresh_process_instance_are_rejected() {
    let o = Observer::new().unwrap();
    let f = frame();
    let value = select(&o, &f, "first");
    let req = tap(value["nodes"][0]["handle"].clone());
    for key in ["pageId", "sessionId", "templateRevision", "renderRevision"] {
        let mut changed = facts(&f);
        changed[key] = json!("99");
        assert!(
            prepare_tap(&o, &f, EngineKind::Quickjs, changed, &req).is_err(),
            "{key}"
        );
    }
    assert!(prepare_tap(&o, &f, EngineKind::V8, facts(&f), &req).is_err());
    let mut newer = f.clone();
    newer.frame_id += 1;
    assert!(prepare_tap(&o, &newer, EngineKind::Quickjs, facts(&newer), &req).is_err());
    assert!(prepare_tap(
        &Observer::new().unwrap(),
        &f,
        EngineKind::Quickjs,
        facts(&f),
        &req
    )
    .is_err());
    let mut wrong_route = facts(&f);
    wrong_route["route"] = json!("pages/other/index");
    assert!(prepare_tap(&o, &f, EngineKind::Quickjs, wrong_route, &req).is_err());
}
#[test]
fn forged_unknown_and_public_id_handles_cannot_resolve_to_a_node() {
    let o = Observer::new().unwrap();
    let f = frame();
    let selected = select(&o, &f, "first");
    for handle in [
        json!("duplicate"),
        json!({"id":"duplicate"}),
        json!({"kind":"accepted-frame-node-v1","owner":selected["owner"],"token":"duplicate"}),
        {
            let mut handle = selected["nodes"][0]["handle"].clone();
            handle["token"] = json!("0".repeat(64));
            handle
        },
    ] {
        assert!(prepare_tap(&o, &f, EngineKind::Quickjs, facts(&f), &tap(handle)).is_err());
    }
}
#[test]
fn occluded_clipped_or_zero_geometry_fails_before_any_action_or_mutation() {
    let o = Observer::new().unwrap();
    for mode in ["covered", "zero", "offscreen"] {
        let mut f = frame();
        if mode == "covered" {
            f.root.children[1].bounds = f.root.children[0].bounds;
        }
        if mode == "zero" {
            f.root.children[0].bounds.width = 0.;
        }
        if mode == "offscreen" {
            f.root.children[0].bounds.x = 200.;
        }
        let selected = select(&o, &f, "first");
        let before = serde_json::to_vec(&f).unwrap();
        assert!(
            prepare_tap(
                &o,
                &f,
                EngineKind::Quickjs,
                facts(&f),
                &tap(selected["nodes"][0]["handle"].clone())
            )
            .is_err(),
            "{mode}"
        );
        assert_eq!(serde_json::to_vec(&f).unwrap(), before);
    }
}
#[test]
fn strict_wire_has_no_selector_reacquisition_or_expected_value_on_action() {
    let handle = json!({"kind":"accepted-frame-node-v1","owner":{},"token":"0".repeat(64)});
    for patch in [
        json!({"selector":"#duplicate"}),
        json!({"expected":"x"}),
        json!({"target":"duplicate"}),
    ] {
        let mut value = json!({"id":1,"op":TAP,"version":1,"route":ROUTE,"node":handle});
        for (key, item) in patch.as_object().unwrap() {
            value[key] = item.clone();
        }
        assert!(TapRequest::parse(&value).is_err());
    }
    assert!(AcquireRequest::parse(&json!({"id":1,"op":ACQUIRE,"version":1,"route":ROUTE,"selection":"unique","target":{"query":{"selector":".candidate"}}})).is_err());
    assert!(AcquireRequest::parse(&json!({"id":1,"op":ACQUIRE,"version":1,"route":ROUTE,"selection":"first","target":{"query":{"selector":".candidate","fields":{"text":true,"attributes":[]}}}})).is_err());
}
#[test]
fn readonly_observer_capability_stays_readonly_and_node_input_is_a_separate_explicit_capability() {
    let o = Observer::new().unwrap();
    let read = o.capability(EngineKind::Quickjs, "s");
    let nodes = capability(&o, EngineKind::Quickjs, "s");
    assert_eq!(read["operations"], json!(["accepted-frame.observe.v1"]));
    assert_eq!(nodes["operations"], json!([ACQUIRE, TAP]));
    assert_eq!(nodes["sessionInstance"], read["sessionInstance"]);
}
