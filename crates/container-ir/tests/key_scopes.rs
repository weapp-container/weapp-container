use container_ir::{
    decode_wxml, evaluate_wxml, evaluate_wxml_with_templates, parse_wxml, WxmlAst, WxmlNode,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn identities(ast: &WxmlAst) -> Vec<(String, String)> {
    fn visit(nodes: &[WxmlNode], output: &mut Vec<(String, String)>) {
        for node in nodes {
            if let WxmlNode::Element {
                key,
                key_scope,
                children,
                ..
            } = node
            {
                if let Some(key) = key {
                    output.push((key.clone(), key_scope.clone().expect("evaluated key scope")));
                }
                visit(children, output);
            }
        }
    }
    let mut output = Vec::new();
    visit(&ast.nodes, &mut output);
    output
}

#[test]
fn repeat_source_scopes_survive_reordering_and_conditional_siblings() {
    let ast = parse_wxml(r#"<view wx:if="{{visible}}"/><view wx:for="{{left}}" wx:key="id"><text wx:for="{{item.children}}" wx:key="*this">{{item}}</text></view><view wx:for="{{right}}" wx:key="id"/>"#).unwrap();
    let evaluate = |visible, left: Value, right: Value| {
        identities(
            &evaluate_wxml(&ast, &json!({"visible":visible,"left":left,"right":right})).unwrap(),
        )
    };
    let first = evaluate(
        true,
        json!([{"id":"a","children":["x"]},{"id":"b","children":["x"]}]),
        json!([{"id":"a"},{"id":"b"}]),
    );
    let reordered = evaluate(
        false,
        json!([{"id":"b","children":["x"]},{"id":"a","children":["x"]}]),
        json!([{"id":"b"},{"id":"a"}]),
    );
    assert_ne!(
        first[0], first[4],
        "independent loops can reuse the same public key"
    );
    assert_ne!(
        first[1], first[3],
        "nested scopes include their keyed ancestor"
    );
    for (before, after) in [(0, 2), (1, 3), (2, 0), (3, 1), (4, 5), (5, 4)] {
        assert_eq!(first[before], reordered[after]);
    }
}

#[test]
fn repeated_template_and_include_invocations_namespace_inner_repeats() {
    let ast = parse_wxml(r#"<template name="list"><text wx:for="{{rows}}" wx:key="*this">{{item}}</text></template><template is="list"/><template is="list"/><include src="part.wxml"/><include src="part.wxml"/>"#).unwrap();
    let templates = BTreeMap::from([(
        "part.wxml".into(),
        parse_wxml(r#"<text wx:for="{{rows}}" wx:key="*this">{{item}}</text>"#).unwrap(),
    )]);
    let evaluated = evaluate_wxml_with_templates(&ast, &json!({"rows":["a"]}), &templates).unwrap();
    let keys = identities(&evaluated);
    assert_eq!(keys.len(), 4);
    assert!(keys.iter().all(|(key, _)| key == "a"));
    let scopes: std::collections::BTreeSet<_> = keys.iter().map(|(_, scope)| scope).collect();
    assert_eq!(scopes.len(), 4);
}

#[test]
fn key_scope_is_optional_for_old_v1_blobs_and_roundtrips_when_evaluated() {
    let ast = parse_wxml(r#"<view wx:for="{{rows}}" wx:key="*this"/>"#).unwrap();
    let source_json = serde_json::to_vec(&ast).unwrap();
    assert!(!String::from_utf8_lossy(&source_json).contains("keyScope"));
    assert_eq!(decode_wxml(&source_json).unwrap(), ast);

    let evaluated = evaluate_wxml(&ast, &json!({"rows":["a"]})).unwrap();
    let mut encoded = serde_json::to_value(&evaluated).unwrap();
    assert!(encoded["nodes"][0]["keyScope"].is_string());
    assert_eq!(
        decode_wxml(&serde_json::to_vec(&encoded).unwrap()).unwrap(),
        evaluated
    );
    encoded["nodes"][0]
        .as_object_mut()
        .unwrap()
        .remove("keyScope");
    let legacy = decode_wxml(&serde_json::to_vec(&encoded).unwrap()).unwrap();
    let WxmlNode::Element { key, key_scope, .. } = &legacy.nodes[0] else {
        panic!("element expected");
    };
    assert_eq!(key.as_deref(), Some("a"));
    assert_eq!(key_scope, &None);
}
