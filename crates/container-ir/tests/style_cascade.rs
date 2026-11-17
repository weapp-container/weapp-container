use container_ir::{
    parse_inline_wxss, parse_wxss, resolve_wxss_style_for_node_with_inline, WxssSelectorNode,
};

fn style(
    stylesheet: &str,
    inline: &str,
) -> std::collections::BTreeMap<String, container_ir::WxssDeclaration> {
    resolve_wxss_style_for_node_with_inline(
        &parse_wxss(stylesheet).unwrap(),
        &WxssSelectorNode {
            tag: Some("view".into()),
            id: Some("box".into()),
            classes: vec!["box".into()],
            ..Default::default()
        },
        &[],
        &parse_inline_wxss(inline),
    )
}

#[test]
fn inline_and_stylesheet_share_importance_specificity_and_source_order() {
    let result = style(
        "#box { width: 50px; height: 60px !important; color: red !important; }",
        "width: 12px; height: 20px; color: blue !IMPORTANT; color: green; width: 22px",
    );
    assert_eq!(result["width"].value, "22px");
    assert_eq!(result["height"].value, "60px");
    assert_eq!(result["color"].value, "blue");
    assert!(result["color"].important);
}

#[test]
fn inline_parser_handles_functions_strings_comments_and_bad_declarations() {
    let result = style(
        "",
        r#"broken; WIDTH: 9px; background-image: url("data:image/svg+xml;a:b;c"); --label: 'a;b:c'; /* ; : */ height: 10px ! important; opacity: ; color: red; color: blue !important; color: green"#,
    );
    assert_eq!(result["width"].value, "9px");
    assert_eq!(
        result["background-image"].value,
        r#"url("data:image/svg+xml;a:b;c")"#
    );
    assert_eq!(result["--label"].value, "'a;b:c'");
    assert_eq!(result["height"].value, "10px");
    assert!(result["height"].important);
    assert_eq!(result["color"].value, "blue");
    assert!(!result.contains_key("opacity"));
}

#[test]
fn shorthand_longhands_compete_before_cascade_loses_source_order() {
    let result = style(
        "#box { margin-left: 30px; padding-top: 40px !important; border-top-left-radius: 15px !important; background-color: red !important; }",
        "margin: 1px 2px; margin-left: 7px; padding: 3px; border-radius: 2px 4px / 6px 8px; background: blue",
    );
    assert_eq!(result["margin-top"].value, "1px");
    assert_eq!(result["margin-left"].value, "7px");
    assert_eq!(result["padding-top"].value, "40px");
    assert_eq!(result["padding-left"].value, "3px");
    assert_eq!(result["border-top-left-radius"].value, "15px");
    assert_eq!(result["border-bottom-right-radius"].value, "2px 6px");
    assert_eq!(result["background-color"].value, "red");
    let reversed = style(".box { margin-left: 7px; margin: 1px 2px; }", "");
    assert_eq!(reversed["margin-left"].value, "2px");
}

#[test]
fn winning_selector_in_a_list_has_no_artificial_source_order_advantage() {
    let result = style(
        ".box, #box { padding-left: 3px; } #box { padding: 5px; }",
        "",
    );
    assert_eq!(result["padding-left"].value, "5px");
}

#[test]
fn inline_recovery_does_not_make_invalid_stylesheets_succeed() {
    for invalid in [
        "view { color: rgb(1, 2; }",
        "view { color: 'red; }",
        "view { color: red; /* open } ",
    ] {
        assert!(parse_wxss(invalid).is_err(), "{invalid}");
    }
    let inline = parse_inline_wxss("width:12px; color: 'unterminated");
    assert_eq!(inline.len(), 1);
    assert_eq!(inline[0].value, "12px");
}

#[test]
fn invalid_shorthands_cannot_replace_valid_supported_longhands() {
    let result = style("#box { padding: 4px; margin: 2px; border-radius: 3px; background: red; }", "padding: nonsense; margin: 1px 2px 3px 4px 5px; border-radius: 9px / nonsense; background: nonsense");
    assert_eq!(result["padding-left"].value, "4px");
    assert_eq!(result["margin-left"].value, "2px");
    assert_eq!(result["border-top-left-radius"].value, "3px 3px");
    assert_eq!(result["background-color"].value, "red");
    for invalid in ["#fffg", "#éaaaa", "nonsense", "rgb(red, 0, 0)"] {
        assert_eq!(container_ir::parse_wxss_color(invalid), None);
    }
    // CSS RGB channels outside the range are valid and clamp at the boundary.
    assert_eq!(
        container_ir::parse_wxss_color("rgb(999, 0, 0)"),
        Some([255, 0, 0, 255])
    );
}
