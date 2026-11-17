use container_ir::{
    decode_wxml, evaluate_wxml, evaluate_wxml_with_templates, parse_wxml, WxmlNode,
};
use serde_json::json;
use std::collections::BTreeMap;

fn marked_sites(nodes: &[WxmlNode]) -> BTreeMap<String, String> {
    let mut sites = BTreeMap::new();
    for node in nodes {
        if let WxmlNode::Element {
            attrs,
            source_site,
            children,
            ..
        } = node
        {
            if let Some(marker) = attrs.get("marker") {
                assert!(sites
                    .insert(
                        marker.clone(),
                        source_site.clone().expect("evaluated source site")
                    )
                    .is_none());
            }
            sites.extend(marked_sites(children));
        }
    }
    sites
}

#[test]
fn evaluated_source_sites_do_not_follow_filtered_sibling_indices() {
    let ast = parse_wxml(r#"<view wx:if="{{show}}"/><counter marker="stable"/><view><text wx:if="{{show}}"/><counter marker="nested"/></view>"#).unwrap();
    let shown = evaluate_wxml(&ast, &json!({"show":true})).unwrap();
    let hidden = evaluate_wxml(&ast, &json!({"show":false})).unwrap();
    assert_eq!(marked_sites(&shown.nodes), marked_sites(&hidden.nodes));
    let reevaluated = evaluate_wxml(&hidden, &json!({"show":false})).unwrap();
    assert_eq!(
        marked_sites(&hidden.nodes),
        marked_sites(&reevaluated.nodes)
    );
}

#[test]
fn nested_keyed_loops_and_template_invocations_keep_distinct_stable_source_sites() {
    let ast = parse_wxml(r#"<template name="counter"><counter marker="{{name}}"/></template><block wx:for="{{rows}}" wx:for-item="row" wx:key="id"><view wx:if="{{row.show}}"/><template is="counter" data="{{name:row.id}}"/><counter wx:for="{{row.values}}" wx:key="*this" marker="{{row.id + ':' + item}}"/></block><template is="counter" data="{{name:'tail'}}"/>"#).unwrap();
    let evaluate =
        |rows| evaluate_wxml_with_templates(&ast, &json!({"rows":rows}), &BTreeMap::new()).unwrap();
    let first = evaluate(json!([
        {"id":"a","show":true,"values":["x","y"]},
        {"id":"b","show":false,"values":["x","y"]}
    ]));
    let reordered = evaluate(json!([
        {"id":"b","show":true,"values":["y","x"]},
        {"id":"a","show":false,"values":["y","x"]}
    ]));
    let sites = marked_sites(&first.nodes);
    assert_eq!(sites.len(), 7);
    assert_eq!(
        sites
            .values()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        7
    );
    assert_eq!(sites, marked_sites(&reordered.nodes));
}

#[test]
fn source_site_metadata_is_optional_for_old_v1_and_preserves_evaluated_occurrences() {
    let ast = parse_wxml(r#"<counter marker="static"/>"#).unwrap();
    assert!(!String::from_utf8_lossy(&ast.canonical_json().unwrap()).contains("sourceSite"));
    assert_eq!(decode_wxml(&ast.canonical_json().unwrap()).unwrap(), ast);
    let evaluated = evaluate_wxml(&ast, &json!({})).unwrap();
    let mut encoded = serde_json::to_value(&evaluated).unwrap();
    assert!(encoded["nodes"][0]["sourceSite"].is_string());
    assert_eq!(
        decode_wxml(&evaluated.canonical_json().unwrap()).unwrap(),
        evaluated
    );
    let node = encoded["nodes"][0].as_object_mut().unwrap();
    let site = node.remove("sourceSite").unwrap();
    node.insert("source_site".into(), site);
    assert_eq!(
        decode_wxml(&serde_json::to_vec(&encoded).unwrap()).unwrap(),
        evaluated
    );
    encoded["nodes"][0]
        .as_object_mut()
        .unwrap()
        .remove("source_site");
    let legacy = decode_wxml(&serde_json::to_vec(&encoded).unwrap()).unwrap();
    assert!(matches!(
        &legacy.nodes[0],
        WxmlNode::Element {
            source_site: None,
            ..
        }
    ));
}
