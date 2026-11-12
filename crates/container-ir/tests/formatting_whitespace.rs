use container_ir::{
    decode_wxml, evaluate_wxml, evaluate_wxml_with_templates, parse_wxml,
    project_wxml_slots_with_options, WxmlAst, WxmlNode,
};
use serde_json::json;
use std::collections::BTreeMap;

fn without_source_identities(mut ast: WxmlAst) -> WxmlAst {
    fn visit(nodes: &mut [WxmlNode]) {
        for node in nodes {
            if let WxmlNode::Element {
                key_scope,
                source_site,
                children,
                ..
            } = node
            {
                *key_scope = None;
                *source_site = None;
                visit(children);
            }
        }
    }
    visit(&mut ast.nodes);
    ast
}

fn children(node: &WxmlNode) -> &[WxmlNode] {
    let WxmlNode::Element { children, .. } = node else {
        panic!("element expected");
    };
    children
}

fn text(nodes: &[WxmlNode]) -> String {
    let mut output = String::new();
    for node in nodes {
        match node {
            WxmlNode::Text { value, .. } => output.push_str(value),
            WxmlNode::Element { children, .. } => output.push_str(&text(children)),
            WxmlNode::Comment { .. } => {}
        }
    }
    output
}

#[test]
fn formatted_and_compact_sources_produce_the_same_layout_input() {
    let compact = r#"<view><text>Heading</text><card wx:for="{{rows}}" wx:key="id"><text>{{item.label}}</text></card><text wx:if="{{enabled}}">On</text><text wx:else>Off</text></view>"#;
    let formatted = r#"
<view>
    <text>Heading</text>
    <card wx:for="{{rows}}" wx:key="id">
        <text>{{item.label}}</text>
    </card>
    <text wx:if="{{enabled}}">On</text>
    <text wx:else>Off</text>
</view>
"#;
    let data =
        json!({"rows":[{"id":"a","label":"Alpha"},{"id":"b","label":"Beta"}],"enabled":false});
    let evaluate = |source| {
        without_source_identities(evaluate_wxml(&parse_wxml(source).unwrap(), &data).unwrap())
    };
    assert_eq!(evaluate(formatted), evaluate(compact));
}

#[test]
fn evaluation_keeps_raw_whitespace_and_uses_original_source_positions_for_identities() {
    let ast =
        parse_wxml("\r\n<view wx:for=\"{{rows}}\" wx:key=\"id\">\n    <counter/>\n</view>\r\n")
            .unwrap();
    let original = ast.clone();
    let encoded = ast.canonical_json().unwrap();
    assert!(
        matches!(&ast.nodes[0], WxmlNode::Text { value, bindings, .. } if value == "\r\n" && bindings.is_empty())
    );
    assert!(
        matches!(&children(&ast.nodes[1])[0], WxmlNode::Text { value, .. } if value == "\n    ")
    );
    let evaluated = evaluate_wxml(&ast, &json!({"rows":[{"id":"a"}]})).unwrap();
    assert_eq!(ast, original);
    assert_eq!(ast.canonical_json().unwrap(), encoded);
    assert_eq!(decode_wxml(&encoded).unwrap(), ast);
    assert_eq!(evaluated.nodes.len(), 1);
    let WxmlNode::Element {
        key,
        key_scope,
        source_site,
        children,
        ..
    } = &evaluated.nodes[0]
    else {
        panic!("repeated element expected");
    };
    assert_eq!(key.as_deref(), Some("a"));
    assert_eq!(key_scope.as_deref(), Some("root/node1:1"));
    let parent_site = source_site.as_deref().expect("evaluated repeat site");
    assert!(parent_site.starts_with("root/node1:1/repeat-key1:a/"));
    assert_eq!(children.len(), 1);
    assert!(
        matches!(&children[0], WxmlNode::Element { source_site: Some(site), .. } if site == &format!("{parent_site}/node1:1"))
    );
    assert_eq!(evaluate_wxml(&evaluated, &json!({})).unwrap(), evaluated);
}

#[test]
fn explicit_single_line_spaces_and_binding_generated_newlines_remain_text() {
    for newline in ["\n", "\r", "\r\n"] {
        let ast = parse_wxml(&format!("<view>{newline} \t</view>")).unwrap();
        let evaluated = evaluate_wxml(&ast, &json!({})).unwrap();
        assert!(children(&evaluated.nodes[0]).is_empty());
    }
    let ast = parse_wxml(
        "<view> \t</view><view>{{line}}</view><text>first\nsecond</text><text> \r\n\t</text><text><block>\n  </block></text>",
    )
    .unwrap();
    let evaluated = evaluate_wxml(&ast, &json!({"line":"\r\n    "})).unwrap();
    assert_eq!(text(children(&evaluated.nodes[0])), " \t");
    assert_eq!(text(children(&evaluated.nodes[1])), "\r\n    ");
    assert!(
        matches!(&children(&evaluated.nodes[1])[0], WxmlNode::Text { bindings, .. } if bindings.len() == 1 && bindings[0] == "line")
    );
    assert_eq!(text(children(&evaluated.nodes[2])), "first\nsecond");
    assert_eq!(text(children(&evaluated.nodes[3])), " \r\n\t");
    assert_eq!(text(children(&evaluated.nodes[4])), "\n  ");
    assert_eq!(evaluate_wxml(&evaluated, &json!({})).unwrap(), evaluated);
}

#[test]
fn text_whitespace_context_survives_loops_templates_and_includes() {
    let ast = parse_wxml(
        "<template name=\"space\">\n \t</template><text><block wx:for=\"{{rows}}\" wx:key=\"*this\">\r\n  </block><template is=\"space\"/><include src=\"space.wxml\"/></text><view><template is=\"space\"/><include src=\"space.wxml\"/></view>",
    )
    .unwrap();
    let templates = BTreeMap::from([("space.wxml".into(), parse_wxml("\r\n   ").unwrap())]);
    let evaluated =
        evaluate_wxml_with_templates(&ast, &json!({"rows":["a","b"]}), &templates).unwrap();
    assert_eq!(evaluated.nodes.len(), 2);
    assert_eq!(
        text(children(&evaluated.nodes[0])),
        "\r\n  \r\n  \n \t\r\n   "
    );
    assert!(children(&evaluated.nodes[1]).is_empty());
}

#[test]
fn formatting_only_light_children_do_not_suppress_slot_fallback() {
    let component = evaluate_wxml(
        &parse_wxml("<slot>\n    <text>Fallback</text>\n</slot>").unwrap(),
        &json!({}),
    )
    .unwrap();
    for multiple_slots in [false, true] {
        for (source, expected) in [
            ("<card>\n    \r\n</card>", "Fallback"),
            ("<card> </card>", " "),
            ("<card>{{line}}</card>", "\n    "),
        ] {
            let light =
                evaluate_wxml(&parse_wxml(source).unwrap(), &json!({"line":"\n    "})).unwrap();
            let projected = project_wxml_slots_with_options(
                &component,
                children(&light.nodes[0]),
                multiple_slots,
            )
            .unwrap();
            assert_eq!(text(&projected.nodes), expected);
        }
    }
}
