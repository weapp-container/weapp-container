use container_ir::{
    decode_wxss, parse_wxss, resolve_wxss_style, validate_wxss, MarkupError, WxssIr,
    WXSS_IR_VERSION,
};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct SharedFixture {
    name: String,
    source: String,
    ir: WxssIr,
}

#[test]
fn rust_and_packer_share_canonical_wxss_v2_structure() {
    let cases: Vec<SharedFixture> = serde_json::from_str(include_str!(
        "../../../tools/container-manifest/test/fixtures/wxss-v2.json"
    ))
    .unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let parsed = parse_wxss(&case.source).unwrap_or_else(|error| {
            panic!("{} failed to parse: {error}", case.name);
        });
        validate_wxss(&parsed).unwrap();
        assert_eq!(
            parsed.canonical_json().unwrap(),
            case.ir.canonical_json().unwrap(),
            "{}",
            case.name
        );
        assert_eq!(
            decode_wxss(&parsed.canonical_json().unwrap()).unwrap(),
            parsed,
            "{}",
            case.name
        );
    }
}

#[test]
fn legacy_v1_imports_decode_without_claiming_recovered_source_order() {
    let bytes = br#"{
        "version": 1,
        "imports": ["'./legacy.wxss'"],
        "rules": [{"selectors":["view"],"declarations":[
            {"property":"color","value":"red","important":false}
        ],"nested":[]}]
    }"#;
    let legacy = decode_wxss(bytes).unwrap();
    assert_eq!(legacy.version, 1);
    assert_eq!(legacy.imports, ["'./legacy.wxss'"]);
    assert_eq!(legacy.rules.len(), 1);
    assert!(legacy.rules[0].at_rule.is_none());
    assert_eq!(
        decode_wxss(&legacy.canonical_json().unwrap()).unwrap(),
        legacy
    );
    assert_eq!(WxssIr::default().version, WXSS_IR_VERSION);
    assert_eq!(WXSS_IR_VERSION, 2);
}

#[test]
fn v2_rejects_ambiguous_import_lists_and_import_rule_bodies() {
    let ordinary = json!({
        "selectors":["view"], "declarations":[], "nested":[]
    });
    for rule in [
        json!({"selectors":[],"declarations":[{"property":"color","value":"red","important":false}],"nested":[],"atRule":"@import './a.wxss'"}),
        json!({"selectors":[],"declarations":[],"nested":[ordinary],"atRule":"@import './a.wxss'"}),
        json!({"selectors":["view"],"declarations":[],"nested":[],"atRule":"@import './a.wxss'"}),
        json!({"selectors":[],"declarations":[],"nested":[],"atRule":"@IMPORT"}),
        json!({"selectors":[],"declarations":[],"nested":[],"atRule":"@"}),
    ] {
        let bytes = serde_json::to_vec(&json!({"version":2,"imports":[],"rules":[rule]})).unwrap();
        assert!(matches!(
            decode_wxss(&bytes),
            Err(MarkupError::InvalidSyntax { .. })
        ));
    }
    let legacy_list = br#"{"version":2,"imports":["'./a.wxss'"],"rules":[]}"#;
    assert!(matches!(
        decode_wxss(legacy_list),
        Err(MarkupError::InvalidSyntax { .. })
    ));
    for version in [0, 3, u32::MAX] {
        let bytes =
            serde_json::to_vec(&json!({"version":version,"imports":[],"rules":[]})).unwrap();
        assert!(matches!(
            decode_wxss(&bytes),
            Err(MarkupError::InvalidVersion { kind: "WXSS", version: rejected }) if rejected == version
        ));
    }
}

#[test]
fn parser_rejects_import_bodies_but_preserves_unknown_keyword_boundaries() {
    assert!(parse_wxss("@import './a.wxss' {} ").is_err());
    assert!(parse_wxss("@import;").is_err());
    let ir = parse_wxss("@imported 'metadata'; @imported { tag: value; }").unwrap();
    assert!(ir.imports.is_empty());
    assert_eq!(ir.rules[0].at_rule.as_deref(), Some("@imported 'metadata'"));
    assert_eq!(ir.rules[1].declarations[0].property, "tag");
    assert_eq!(ir.rules[1].declarations[0].value, "value");
    validate_wxss(&ir).unwrap();
}

#[test]
fn comments_and_utf8_do_not_change_group_or_descriptor_structure() {
    let source = r#"
        @media /* group */ screen { /* import stays here */ @import './a.wxss'; }
        @unknown { /* preserve import-only body */ @import './b.wxss'; }
        @font-face { font-family: "字体/*literal*/"; src: url('./字形.woff2'); }
        .卡片 { content: "你好"; }
    "#;
    let ir = parse_wxss(source).unwrap();
    assert_eq!(ir.rules[0].at_rule.as_deref(), Some("@media   screen"));
    assert_eq!(
        ir.rules[0].nested[0].at_rule.as_deref(),
        Some("@import './a.wxss'")
    );
    assert_eq!(
        ir.rules[1].nested[0].at_rule.as_deref(),
        Some("@import './b.wxss'")
    );
    assert_eq!(ir.rules[2].declarations[0].value, "\"字体/*literal*/\"");
    assert!(ir.rules[2].nested.is_empty());
    assert_eq!(ir.rules[3].selectors, [".卡片"]);
    assert_eq!(ir.rules[3].declarations[0].value, "\"你好\"");
    validate_wxss(&ir).unwrap();
}

#[test]
fn cascade_never_applies_unresolved_at_rule_descendants() {
    let ir = parse_wxss(
        "view { color: green; } \
         @media (min-width: 999999px) { view { color: red !important; } } \
         @supports (unknown: unsupported) { view { color: blue !important; } } \
         @keyframes hidden { view { color: purple !important; } }",
    )
    .unwrap();
    let style = resolve_wxss_style(&ir, Some("view"), None, &[]);
    assert_eq!(style["color"].value, "green");
    assert!(!style["color"].important);
}

#[test]
fn declarations_from_font_faces_are_not_ordinary_element_styles() {
    let ir = parse_wxss(
        "@font-face { font-family: Fixture; src: url('./f.woff2'); } \
         view { font-family: AppFont; }",
    )
    .unwrap();
    assert_eq!(ir.rules[0].declarations.len(), 2);
    let style = resolve_wxss_style(&ir, Some("view"), None, &[]);
    assert_eq!(style["font-family"].value, "AppFont");
    assert!(!style.contains_key("src"));
}
