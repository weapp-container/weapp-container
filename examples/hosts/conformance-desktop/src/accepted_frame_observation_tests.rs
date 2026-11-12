//! Synthetic address tests are explicitly separate from actual-engine raster tests.
use super::*;
use container_render_skia::{FlowStyle, LayoutStyle, Rect, RenderNode, ScrollOffset, Transform2D};
use std::collections::BTreeMap;
const ROUTE: &str = "pages/index/index";
fn completion(frame: &RenderFrame) -> Value {
    // Local frame fact input. This deliberately does NOT pretend to be a
    // native-window completion and never inserts a presentation ACK.
    json!({"kind":"local-raster-frame-facts-v1","sessionId":"observer-local-test","route":ROUTE,
        "pageId":"1","templateRevision":"2","frameId":frame.frame_id.to_string(),"renderRevision":"3"})
}
fn request(target: Value, fields: &[&str]) -> Request {
    Request::parse(
        &json!({"id":1,"op":OBSERVE,"version":1,"route":ROUTE,"target":target,"fields":fields}),
    )
    .unwrap()
}
fn node(id: &str, context: FormattingContext) -> RenderNode {
    let mut node = RenderNode::new(
        id,
        Rect {
            x: 10.25,
            y: 20.5,
            width: 30.75,
            height: 40.125,
        },
    );
    node.tag = Some("view".into());
    node.attributes.insert("id".into(), id.into());
    node.style = Some(LayoutStyle {
        flow: Some(FlowStyle {
            context,
            ..Default::default()
        }),
        ..Default::default()
    });
    node.computed_style
        .insert("visibility".into(), "visible".into());
    node.computed_style.insert(
        "flex-direction".into(),
        if context == FormattingContext::Flex {
            "column"
        } else {
            "row"
        }
        .into(),
    );
    node.computed_style
        .insert("flex-wrap".into(), "nowrap".into());
    node
}
fn frame() -> RenderFrame {
    let mut root = node("root", FormattingContext::Block);
    let mut left = node("left", FormattingContext::Flex);
    let mut a = node("duplicate", FormattingContext::Flex);
    a.classes.push("left-child".into());
    let mut right = node("right", FormattingContext::Flex);
    let mut b = node("duplicate", FormattingContext::Flex);
    b.classes.push("right-child".into());
    left.children.push(a);
    right.children.push(b);
    root.children.extend([left, right]);
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
fn observe(
    observer: &Observer,
    frame: &RenderFrame,
    target: Value,
    fields: &[&str],
) -> Result<Value> {
    observer.observe(
        frame,
        EngineKind::Quickjs,
        completion(frame),
        &request(target, fields),
    )
}
#[test]
fn fresh_instances_bind_identical_public_sessions_to_distinct_handles() {
    let a = Observer::new().unwrap();
    let b = Observer::new().unwrap();
    let f = frame();
    let first = observe(
        &a,
        &f,
        json!({"query":{"selector":"#duplicate"}}),
        &[FIELDS[0]],
    )
    .unwrap();
    let second = observe(
        &b,
        &f,
        json!({"query":{"selector":"#duplicate"}}),
        &[FIELDS[0]],
    )
    .unwrap();
    assert_ne!(
        first["owner"]["sessionInstance"],
        second["owner"]["sessionInstance"]
    );
    assert!(observe(
        &b,
        &f,
        json!({"node":first["nodes"][0]["handle"]}),
        &[FIELDS[0]]
    )
    .is_err());
}
#[test]
fn actual_occurrence_handles_and_parent_addresses_preserve_duplicate_public_ids() {
    let o = Observer::from_seed([7; 32]);
    let f = frame();
    let result = observe(
        &o,
        &f,
        json!({"query":{"selector":"#duplicate"}}),
        &[FIELDS[0]],
    )
    .unwrap();
    assert_eq!(result["count"], 2);
    assert_ne!(result["nodes"][0]["handle"], result["nodes"][1]["handle"]);
    assert_ne!(result["nodes"][0]["parent"], result["nodes"][1]["parent"]);
    let exact = observe(
        &o,
        &f,
        json!({"node":result["nodes"][1]["handle"]}),
        &[FIELDS[0]],
    )
    .unwrap();
    assert_eq!(exact["nodes"][0], result["nodes"][1]);
    let children = observe(
        &o,
        &f,
        json!({"parent":result["nodes"][1]["parent"],"selector":"#duplicate"}),
        &[FIELDS[0]],
    )
    .unwrap();
    assert_eq!(children["count"], 1);
    assert_eq!(children["nodes"][0], result["nodes"][1]);
    let has = observe(
        &o,
        &f,
        json!({"query":{"selector":"view","has":".right-child"}}),
        &[FIELDS[0]],
    )
    .unwrap();
    assert!(has["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["metadata"]["publicId"] == "right"));
}
#[test]
fn parent_address_uses_declaration_ownership_for_projected_slots() {
    let o = Observer::from_seed([8; 32]);
    let mut f = frame();
    f.root.children[0].component_scope_id = Some("component-a".into());
    f.root.children[0].children[0].event_owner_scope_id = Some("component-a".into());
    let mut projected = node("projected", FormattingContext::Block);
    projected.event_owner_scope_id = Some("declarer-b".into());
    f.root.children[0].children.push(projected);
    let host = observe(&o, &f, json!({"query":{"selector":"#left"}}), &[FIELDS[0]]).unwrap();
    let scoped = observe(
        &o,
        &f,
        json!({"parent":host["nodes"][0]["handle"],"selector":"*"}),
        &[FIELDS[0]],
    )
    .unwrap();
    assert_eq!(scoped["count"], 1);
    assert_eq!(scoped["nodes"][0]["metadata"]["publicId"], "duplicate");
    let query = observe(
        &o,
        &f,
        json!({"query":{"selector":"*","scope":["#left"]}}),
        &[FIELDS[0]],
    )
    .unwrap();
    assert_eq!(query["nodes"], scoped["nodes"]);
    f.root.children[1].component_scope_id = Some("component-a".into());
    assert!(observe(
        &o,
        &f,
        json!({"parent":host["nodes"][0]["handle"],"selector":"*"}),
        &[FIELDS[0]]
    )
    .is_err());
}
#[test]
fn all_frame_owner_dimensions_and_unknown_tokens_reject() {
    let o = Observer::from_seed([9; 32]);
    let f = frame();
    let r = observe(&o, &f, json!({"query":{"selector":"#left"}}), &[FIELDS[0]]).unwrap();
    for key in [
        "engine",
        "sessionId",
        "sessionInstance",
        "route",
        "pageId",
        "templateRevision",
        "frameId",
        "renderRevision",
    ] {
        let mut handle = r["nodes"][0]["handle"].clone();
        handle["owner"][key] = json!(if key == "engine" { "v8" } else { "different" });
        assert!(
            observe(&o, &f, json!({"node":handle}), &[FIELDS[0]]).is_err(),
            "{key}"
        );
    }
    let mut handle = r["nodes"][0]["handle"].clone();
    handle["token"] = json!("0".repeat(64));
    assert!(observe(&o, &f, json!({"node":handle}), &[FIELDS[0]]).is_err());
    let mut changed = completion(&f);
    changed["pageId"] = json!("2");
    assert!(o
        .observe(
            &f,
            EngineKind::Quickjs,
            changed,
            &request(json!({"node":r["nodes"][0]["handle"]}), &[FIELDS[0]])
        )
        .is_err());
    assert!(o
        .observe(
            &f,
            EngineKind::V8,
            completion(&f),
            &request(json!({"node":r["nodes"][0]["handle"]}), &[FIELDS[0]])
        )
        .is_err());
    let v8 = o
        .observe(
            &f,
            EngineKind::V8,
            completion(&f),
            &request(json!({"query":{"selector":"#left"}}), &[FIELDS[0]]),
        )
        .unwrap();
    assert!(observe(
        &o,
        &f,
        json!({"node":v8["nodes"][0]["handle"]}),
        &[FIELDS[0]]
    )
    .is_err());
}
#[test]
fn strict_versioned_envelopes_reject_unknown_missing_and_value_bearing_fields() {
    let valid = json!({"id":1,"op":OBSERVE,"version":1,"route":ROUTE,"target":{"query":{"selector":"view"}},"fields":[FIELDS[0]]});
    for key in ["id", "op", "version", "route", "target", "fields"] {
        let mut v = valid.clone();
        v.as_object_mut().unwrap().remove(key);
        assert!(Request::parse(&v).is_err(), "{key}");
    }
    for fields in [
        json!([]),
        json!([FIELDS[0], FIELDS[0]]),
        json!(["unknown"]),
        json!([{"name":FIELDS[0],"expected":"flex"}]),
        json!({"text":true,"attributes":[]}),
    ] {
        let mut v = valid.clone();
        v["fields"] = fields;
        assert!(Request::parse(&v).is_err());
    }
    for target in [
        json!({"query":"view"}),
        json!({"query":{"selector":"view","fields":{"text":true,"attributes":[]}}}),
        json!({"node":{},"query":{"selector":"view"}}),
        json!({"parent":{},"selector":"view","scope":[]}),
        json!({"query":{"selector":"view","expected":"flex"}}),
    ] {
        let mut v = valid.clone();
        v["target"] = target;
        assert!(Request::parse(&v).is_err());
    }
    let mut v = valid.clone();
    v["expected"] = json!("flex");
    assert!(Request::parse(&v).is_err());
    v = valid;
    v["version"] = json!(2);
    assert!(Request::parse(&v).is_err());
    assert!(parse_capabilities(&json!({"id":1,"op":CAPABILITIES,"version":1})).is_ok());
    assert!(
        parse_capabilities(&json!({"id":1,"op":CAPABILITIES,"version":1,"fields":[]})).is_err()
    );
    // Legacy grammar remains exactly text + attributes, with strict types.
    assert!(observation::Query::parse(
        &json!({"selector":"view","fields":{"text":true,"attributes":[]}})
    )
    .is_ok());
    for fields in [
        json!({"text":true}),
        json!({"text":true,"attributes":[],"computed":[]}),
        json!({"text":"yes","attributes":[]}),
    ] {
        assert!(observation::Query::parse(&json!({"selector":"view","fields":fields})).is_err());
    }
}
#[test]
fn computed_fields_are_typed_local_and_nonflex_direction_retains_its_css_value() {
    let o = Observer::from_seed([10; 32]);
    let mut f = frame();
    f.root.opacity = 0.25;
    let target = &mut f.root.children[0];
    target.opacity = 0.5;
    target.style.as_mut().unwrap().direction = FlexDirection::RowReverse;
    target.style.as_mut().unwrap().flow.as_mut().unwrap().wrap = FlexWrap::WrapReverse;
    target
        .computed_style
        .insert("flex-direction".into(), "row-reverse".into());
    target
        .computed_style
        .insert("flex-wrap".into(), "wrap-reverse".into());
    target.visibility = Visibility::Hidden;
    target
        .computed_style
        .insert("visibility".into(), "hidden".into());
    let r = observe(&o, &f, json!({"query":{"selector":"#left"}}), &FIELDS[..5]).unwrap();
    assert_eq!(
        r["nodes"][0]["values"],
        json!({"computed.display":"flex","computed.flex-direction":"row-reverse","computed.flex-wrap":"wrap-reverse","computed.opacity":0.5,"computed.visibility":"hidden"})
    );
    let block = observe(
        &o,
        &f,
        json!({"query":{"selector":"#root"}}),
        &[FIELDS[1], FIELDS[2]],
    )
    .unwrap();
    assert_eq!(block["nodes"][0]["values"][FIELDS[1]], "row");
    assert_eq!(block["nodes"][0]["values"][FIELDS[2]], "nowrap");
    assert_eq!(f.root.style.unwrap().direction, FlexDirection::Column);
    f.root.children[0].computed_style.remove("visibility");
    assert!(observe(&o, &f, json!({"query":{"selector":"#left"}}), &[FIELDS[4]]).is_err());
    f.root.children[0]
        .computed_style
        .insert("visibility".into(), "visible".into());
    assert!(observe(&o, &f, json!({"query":{"selector":"#left"}}), &[FIELDS[4]]).is_err());
    f.root.children[0].style = None;
    for field in FIELDS {
        assert!(
            observe(&o, &f, json!({"query":{"selector":"#left"}}), &[field]).is_err(),
            "{field}"
        );
    }
}
#[test]
fn missing_unlowered_and_inconsistent_flex_computed_values_never_default() {
    let o = Observer::from_seed([15; 32]);
    for selector in ["#root", "#left"] {
        for (property, field) in [("flex-direction", FIELDS[1]), ("flex-wrap", FIELDS[2])] {
            for value in [
                None,
                Some("inherit"),
                Some("initial"),
                Some("unset"),
                Some("ROW"),
                Some(" row"),
                Some("unsupported"),
            ] {
                let mut f = frame();
                let node = if selector == "#root" {
                    &mut f.root
                } else {
                    &mut f.root.children[0]
                };
                if let Some(value) = value {
                    node.computed_style.insert(property.into(), value.into());
                } else {
                    node.computed_style.remove(property);
                }
                assert!(
                    observe(&o, &f, json!({"query":{"selector":selector}}), &[field]).is_err(),
                    "{selector}/{property}/{value:?}"
                );
            }
        }
    }
    let mut f = frame();
    f.root.children[0]
        .computed_style
        .insert("flex-direction".into(), "row".into());
    assert!(observe(&o, &f, json!({"query":{"selector":"#left"}}), &[FIELDS[1]]).is_err());
    f.root
        .computed_style
        .insert("flex-wrap".into(), "wrap".into());
    assert!(observe(&o, &f, json!({"query":{"selector":"#root"}}), &[FIELDS[2]]).is_err());
}
#[test]
fn geometry_reuses_scroll_transform_aabb_and_typed_display_none_zero_contract() {
    let o = Observer::from_seed([11; 32]);
    let mut f = frame();
    f.root.children[0].scroll_container = true;
    f.root.children[0].scroll_offset = Some(ScrollOffset {
        scroll_left: 2.5,
        scroll_top: 3.25,
    });
    f.root.children[0].style.as_mut().unwrap().transform = Some(Transform2D {
        a: 1.5,
        b: 0.,
        c: 0.,
        d: 2.,
        e: 1.25,
        f: -0.5,
    });
    let r = observe(
        &o,
        &f,
        json!({"query":{"selector":".left-child"}}),
        &[FIELDS[5], FIELDS[6]],
    )
    .unwrap();
    let g = f
        .node_geometries()
        .into_iter()
        .find(|g| g.node.classes.contains(&"left-child".into()))
        .unwrap();
    let offset = &r["nodes"][0]["values"][FIELDS[6]];
    assert_eq!(offset["left"], json!(g.bounds.x));
    assert_eq!(offset["top"], json!(g.bounds.y));
    assert_eq!(offset["width"], json!(g.bounds.width));
    assert_eq!(offset["height"], json!(g.bounds.height));
    assert_ne!(g.bounds, f.root.children[0].children[0].bounds);
    assert_eq!(offset["coordinateSpace"], "viewport-css-px");
    assert_eq!(offset["box"], "transformed-border-aabb");
    assert_eq!(offset["clipped"], false);
    f.root.children[0].style.as_mut().unwrap().display = DisplayMode::None;
    let r = observe(
        &o,
        &f,
        json!({"query":{"selector":".left-child"}}),
        &[FIELDS[5]],
    )
    .unwrap();
    assert_eq!(r["nodes"][0]["values"][FIELDS[5]]["width"], 0.);
    assert_eq!(r["nodes"][0]["values"][FIELDS[5]]["height"], 0.);
}
#[test]
fn result_budget_and_malformed_handle_reject_without_partial_results() {
    let o = Observer::from_seed([12; 32]);
    let mut f = frame();
    for h in [
        Value::Null,
        json!({}),
        json!({"kind":"accepted-frame-node-v1","owner":{},"token":"a"}),
    ] {
        assert!(observe(&o, &f, json!({"node":h}), &[FIELDS[0]]).is_err());
    }
    f.root.children = (0..4097)
        .map(|_| node("repeated", FormattingContext::Block))
        .collect();
    assert!(observe(
        &o,
        &f,
        json!({"query":{"selector":"#repeated"}}),
        &[FIELDS[0]]
    )
    .is_err());
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[path = "accepted_frame_observation_native_tests.rs"]
mod native;
