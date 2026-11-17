use container_ir::{
    decode_wxml, evaluate_wxml, evaluate_wxml_with_templates_from_source, parse_wxml,
    project_wxml_slots_with_options, validate_wxml, WxmlAst, WxmlLexicalOrigin, WxmlNode,
};
use serde_json::json;
use std::collections::BTreeMap;

fn visit(nodes: &[WxmlNode], output: &mut BTreeMap<String, String>) {
    for node in nodes {
        let origin = node
            .lexical_origin()
            .expect("every evaluated node has a document");
        if let WxmlNode::Element {
            attrs, children, ..
        } = node
        {
            if let Some(id) = attrs.get("id") {
                output.insert(id.clone(), origin.document_id.clone());
            }
            visit(children, output);
        }
    }
}

#[test]
fn evaluated_import_include_and_loop_origins_are_structured_and_canonical() {
    let source = parse_wxml(r#"<import src="../shared/templates.wxml"/><view id="page"><template wx:for="{{items}}" wx:key="id" is="row" data="{{label:item.id}}"/><include src="../shared/include.wxml"/><!--page comment--></view>"#).unwrap();
    let templates = BTreeMap::from([
        ("shared/templates.wxml".into(), parse_wxml(r#"<template name="row"><text id="template-{{label}}">{{label}}</text><!--template comment--></template>"#).unwrap()),
        ("shared/include.wxml".into(), parse_wxml(r#"<text id="include">{{label}}</text>"#).unwrap()),
    ]);
    let ast = evaluate_wxml_with_templates_from_source(
        &source,
        &json!({"items":[{"id":"a"}],"label":"page data"}),
        &templates,
        Some("pages/index.wxml"),
    )
    .unwrap();
    let mut origins = BTreeMap::new();
    visit(&ast.nodes, &mut origins);
    assert_eq!(
        origins,
        BTreeMap::from([
            ("page".into(), "pages/index.wxml".into()),
            ("template-a".into(), "shared/templates.wxml".into()),
            ("include".into(), "shared/include.wxml".into()),
        ])
    );
    let WxmlNode::Element { children, .. } = &ast.nodes[0] else {
        panic!("page view")
    };
    assert_eq!(
        children[0].lexical_origin().unwrap().document_id,
        "pages/index.wxml"
    );
    let WxmlNode::Element { tag, children, .. } = &children[0] else {
        panic!("keyed template wrapper")
    };
    assert_eq!(tag, "block");
    assert_eq!(
        children[0].lexical_origin().unwrap().document_id,
        "shared/templates.wxml"
    );
    assert_eq!(
        ast.nodes[0].lexical_origin().unwrap().document_id,
        "pages/index.wxml"
    );
    assert_eq!(decode_wxml(&ast.canonical_json().unwrap()).unwrap(), ast);
}

#[test]
fn projection_keeps_light_and_fallback_lexical_documents() {
    let evaluate = |document, source| {
        evaluate_wxml_with_templates_from_source(
            &parse_wxml(source).unwrap(),
            &json!({}),
            &BTreeMap::new(),
            Some(document),
        )
        .unwrap()
    };
    let page = evaluate(
        "pages/index.wxml",
        r#"<text id="light" slot="content">light</text>"#,
    );
    let component = evaluate(
        "components/card/index.wxml",
        r#"<view id="card"><slot name="content"/><slot name="missing"><text id="fallback">fallback</text></slot></view>"#,
    );
    let projected = project_wxml_slots_with_options(&component, &page.nodes, true).unwrap();
    let mut origins = BTreeMap::new();
    visit(&projected.nodes, &mut origins);
    assert_eq!(origins["light"], "pages/index.wxml");
    assert_eq!(origins["fallback"], "components/card/index.wxml");
    assert_eq!(origins["card"], "components/card/index.wxml");
}

#[test]
fn old_source_blobs_and_anonymous_fragments_keep_their_wire_shape() {
    let source = parse_wxml("<view>text<!--comment--></view>").unwrap();
    assert!(!String::from_utf8(source.canonical_json().unwrap())
        .unwrap()
        .contains("lexicalOrigin"));
    assert_eq!(
        decode_wxml(&source.canonical_json().unwrap()).unwrap(),
        source
    );
    let anonymous = evaluate_wxml(&source, &json!({})).unwrap();
    assert!(anonymous.nodes[0].lexical_origin().is_none());
    let WxmlNode::Element { children, .. } = &anonymous.nodes[0] else {
        panic!("view")
    };
    assert!(children.iter().all(|node| node.lexical_origin().is_none()));
}

#[test]
fn malformed_or_escaping_document_metadata_is_rejected() {
    for document in [
        "",
        "/page.wxml",
        "../page.wxml",
        "page/../a.wxml",
        "page//a.wxml",
        "page\\a.wxml",
        "template:page.wxml",
        "page.wxml?x",
        "page.wxml\0",
    ] {
        assert!(
            WxmlLexicalOrigin::from_document(document).is_err(),
            "{document:?}"
        );
        let value = json!({"version":1,"nodes":[{"kind":"text","value":"x","bindings":[],"lexicalOrigin":{"documentId":document}}]});
        let ast: WxmlAst = serde_json::from_value(value).unwrap();
        assert!(validate_wxml(&ast).is_err(), "{document:?}");
    }
    let unknown = json!({"version":1,"nodes":[{"kind":"comment","value":"x","lexicalOrigin":{"documentId":"page.wxml","owner":"fake"}}]});
    assert!(decode_wxml(&serde_json::to_vec(&unknown).unwrap()).is_err());
}

#[test]
fn a_source_document_cannot_claim_another_declared_documents_origin() {
    let other = parse_wxml("<text>other document</text>").unwrap();
    let templates = BTreeMap::from([("shared/other.wxml".into(), other)]);
    let source: WxmlAst = serde_json::from_value(json!({
        "version":1,"nodes":[{"kind":"text","value":"source","bindings":[],
            "lexicalOrigin":{"documentId":"shared/other.wxml"}}]
    }))
    .unwrap();
    assert!(
        validate_wxml(&source).is_ok(),
        "the path alone is canonical"
    );
    let error = evaluate_wxml_with_templates_from_source(
        &source,
        &json!({}),
        &templates,
        Some("pages/index.wxml"),
    )
    .unwrap_err();
    assert!(error.to_string().contains("declaring document"));

    // Supplied documents are checked before selection, so an unused template
    // cannot carry a forged source identity into a later render.
    let templates = BTreeMap::from([("shared/unused.wxml".into(), source)]);
    let root = parse_wxml("<text>page</text>").unwrap();
    let error = evaluate_wxml_with_templates_from_source(
        &root,
        &json!({}),
        &templates,
        Some("pages/index.wxml"),
    )
    .unwrap_err();
    assert!(error.to_string().contains("declaring document"));
}

#[test]
fn matching_source_metadata_and_anonymous_evaluated_fragments_keep_provenance() {
    let source: WxmlAst = serde_json::from_value(json!({
        "version":1,"nodes":[{"kind":"text","value":"{{label}}","bindings":["label"],
            "lexicalOrigin":{"documentId":"pages/index.wxml"}}]
    }))
    .unwrap();
    let evaluated = evaluate_wxml_with_templates_from_source(
        &source,
        &json!({"label":"page"}),
        &BTreeMap::new(),
        Some("pages/index.wxml"),
    )
    .unwrap();
    assert_eq!(
        evaluated.nodes[0].lexical_origin().unwrap().document_id,
        "pages/index.wxml"
    );
    let anonymous = evaluate_wxml(&evaluated, &json!({})).unwrap();
    assert_eq!(
        anonymous.nodes[0].lexical_origin(),
        evaluated.nodes[0].lexical_origin()
    );
}
