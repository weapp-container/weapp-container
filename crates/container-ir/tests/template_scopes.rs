use container_ir::{evaluate_wxml_with_templates_from_source, parse_wxml, WxmlAst, WxmlNode};
use serde_json::json;
use std::collections::BTreeMap;

fn text(ast: &WxmlAst) -> String {
    fn collect(nodes: &[WxmlNode], output: &mut String) {
        for node in nodes {
            match node {
                WxmlNode::Text { value, .. } => output.push_str(value),
                WxmlNode::Element { children, .. } => collect(children, output),
                WxmlNode::Comment { .. } => {}
            }
        }
    }
    let mut result = String::new();
    collect(&ast.nodes, &mut result);
    result
}

#[test]
fn loop_aliases_select_and_populate_templates_at_each_occurrence() {
    let ast = parse_wxml(
        r#"<template name="plain"><text>{{position}}:{{label}};</text></template><template name="strong"><text>[{{position}}:{{label}}];</text></template><block wx:for="{{rows}}" wx:for-item="row" wx:for-index="number"><template is="{{row.kind}}" data="{{...row, position: number}}"/></block>"#,
    )
    .unwrap();
    let original = ast.clone();
    let rendered = evaluate_wxml_with_templates_from_source(
        &ast,
        &json!({"rows":[{"kind":"plain","label":"A"},{"kind":"strong","label":"B"}]}),
        &BTreeMap::new(),
        Some("pages/home/index.wxml"),
    )
    .unwrap();
    assert_eq!(text(&rendered), "0:A;[1:B];");
    assert_eq!(ast, original, "compiled template remains reusable");
}

#[test]
fn loop_scope_exists_before_same_node_conditional_template_invocation() {
    let ast = parse_wxml(
        r#"<template name="row"><text>{{name}}</text></template><template wx:for="{{rows}}" wx:for-item="row" wx:if="{{row.visible}}" is="row" data="{{row}}"/>"#,
    )
    .unwrap();
    let rendered = evaluate_wxml_with_templates_from_source(
        &ast,
        &json!({"rows":[{"name":"A","visible":true},{"name":"hidden","visible":false},{"name":"C","visible":true}]}),
        &BTreeMap::new(),
        None,
    )
    .unwrap();
    assert_eq!(text(&rendered), "AC");
}

#[test]
fn includes_in_nested_loops_keep_current_aliases_and_declaring_file_path() {
    let ast = parse_wxml(
        r#"<block wx:for="{{groups}}" wx:for-item="group"><block wx:for="{{group.items}}" wx:for-item="entry"><include src="../../fragments/detail.wxml"/></block></block>"#,
    )
    .unwrap();
    let templates = [
        (
            "fragments/detail.wxml".into(),
            parse_wxml(r#"<include src="./label.wxml"/>"#).unwrap(),
        ),
        (
            "fragments/label.wxml".into(),
            parse_wxml(r#"<text>{{group.title}}:{{entry}};</text>"#).unwrap(),
        ),
    ]
    .into_iter()
    .collect();
    let rendered = evaluate_wxml_with_templates_from_source(
        &ast,
        &json!({"groups":[{"title":"A","items":[1,2]},{"title":"B","items":[3]}]}),
        &templates,
        Some("pages/home/index.wxml"),
    )
    .unwrap();
    assert_eq!(text(&rendered), "A:1;A:2;B:3;");
}

#[test]
fn inactive_template_branch_does_not_evaluate_missing_data_or_dynamic_name() {
    let ast = parse_wxml(
        r#"<block wx:for="{{rows}}"><template wx:if="{{item.visible}}" is="{{item.template}}" data="{{item.value}}"/><text wx:else>hidden;</text></block>"#,
    )
    .unwrap();
    let rendered = evaluate_wxml_with_templates_from_source(
        &ast,
        &json!({"rows":[{"visible":false}]}),
        &BTreeMap::new(),
        None,
    )
    .unwrap();
    assert_eq!(text(&rendered), "hidden;");
}

#[test]
fn template_output_is_not_reinterpreted_as_page_binding_source() {
    let ast = parse_wxml(
        r#"<template name="label"><text title="{{label}}">{{label}}</text></template><block wx:for="{{rows}}"><template is="label" data="{{item}}"/></block>"#,
    )
    .unwrap();
    let rendered = evaluate_wxml_with_templates_from_source(
        &ast,
        &json!({"rows":[{"label":"{{secret}}"}],"secret":"must-not-leak"}),
        &BTreeMap::new(),
        None,
    )
    .unwrap();
    assert_eq!(text(&rendered), "{{secret}}");
    let WxmlNode::Element { children, .. } = &rendered.nodes[0] else {
        panic!("loop block expected");
    };
    let WxmlNode::Element { attrs, .. } = &children[0] else {
        panic!("template text expected");
    };
    assert_eq!(attrs["title"], "{{secret}}");
}

#[test]
fn mustache_boundaries_preserve_quoted_delimiters_and_nested_object_literals() {
    let ast = parse_wxml(r#"<text>{{'a}}b'}}/{{({outer:{value:7}}).outer.value}}</text>"#).unwrap();
    let rendered =
        evaluate_wxml_with_templates_from_source(&ast, &json!({}), &BTreeMap::new(), None).unwrap();
    assert_eq!(text(&rendered), "a}}b/7");
    let WxmlNode::Element { children, .. } = &ast.nodes[0] else {
        panic!("text expected")
    };
    let WxmlNode::Text { bindings, .. } = &children[0] else {
        panic!("binding expected")
    };
    assert_eq!(bindings, &["'a}}b'", "({outer:{value:7}}).outer.value"]);
}

#[test]
fn keyed_template_and_include_keep_every_root_in_one_repeat_fragment() {
    for invocation in [
        r#"<template is="pair" data="{{item}}" wx:for="{{rows}}" wx:key="id"/>"#,
        r#"<include src="pair.wxml" wx:for="{{rows}}" wx:key="id"/>"#,
    ] {
        let ast = parse_wxml(&format!(
            r#"<template name="pair"><text>{{label}}</text><view>{{label}}</view></template>{invocation}"#
        )).unwrap();
        let templates = [(
            "pair.wxml".into(),
            parse_wxml("<text>{{item.label}}</text><view>{{item.label}}</view>").unwrap(),
        )]
        .into_iter()
        .collect();
        let render = |rows| {
            evaluate_wxml_with_templates_from_source(&ast, &json!({"rows":rows}), &templates, None)
                .unwrap()
        };
        let first = render(json!([{"id":"a","label":"A"},{"id":"b","label":"B"}]));
        let reordered = render(json!([{"id":"b","label":"B"},{"id":"a","label":"A"}]));
        assert_eq!(first.nodes.len(), 2);
        assert_eq!(first.nodes[0], reordered.nodes[1]);
        assert_eq!(first.nodes[1], reordered.nodes[0]);
        for node in first.nodes {
            let WxmlNode::Element {
                tag, key, children, ..
            } = node
            else {
                panic!("keyed block expected");
            };
            assert_eq!(tag, "block");
            assert!(key.is_some());
            assert_eq!(children.len(), 2, "all template roots share the repeat key");
        }
    }
}
