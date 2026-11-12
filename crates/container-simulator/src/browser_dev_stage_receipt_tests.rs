//! Static receipt and startup contracts. These tests do not exercise a Node
//! assembler, a stage helper, a browser or presentation readiness.

use super::*;

fn intent(data: &str, width: &str, schema: &str) -> Vec<u8> {
    format!(r#"{{"schemaVersion":{schema},"execution":"worker","engine":"quickjs","viewport":{{"width":{width},"height":667.0}},"rendererPolicy":{{"mode":"manifest"}},"data":{data}}}"#).into_bytes()
}

fn parse_intent(bytes: &[u8]) -> Result<wire::StartupIntent> {
    parse_startup_intent(bytes)
}

#[test]
fn runner_preflight_uses_the_original_immutable_startup_contract() {
    let valid = br#"{"schemaVersion":1,"execution":"worker","engine":"quickjs","viewport":{"width":414,"height":736},"rendererPolicy":{"mode":"force","profile":"webview"},"route":"pages/home/index","data":{"count":7}}"#;
    validate_startup_intent_bytes(valid).unwrap();
    let value = parse_startup_intent(valid).unwrap();
    assert_eq!(value.route.as_deref(), Some("pages/home/index"));
    assert_eq!(value.data.unwrap().value()["count"].as_f64(), Some(7.0));
    for (from, to) in [
        ("quickjs", "v8"),
        ("414", "4097"),
        ("pages/home/index", "pages/../index"),
        ("\"count\":7", "\"count\":7,\"count\":8"),
    ] {
        let invalid = std::str::from_utf8(valid).unwrap().replace(from, to);
        assert!(validate_startup_intent_bytes(invalid.as_bytes()).is_err());
    }
}

#[test]
fn startup_density_is_optional_strict_and_separate_from_device_metrics() {
    let base = r#"{"schemaVersion":1,"execution":"worker","engine":"quickjs","viewport":{"width":375,"height":667},"rendererPolicy":{"mode":"force","profile":"skia"},"renderScale":2}"#;
    let parsed = parse_startup_intent(base.as_bytes()).unwrap();
    assert_eq!(
        parsed.render_scale,
        Some(crate::presentation::RenderScale::Fixed(2.0))
    );
    assert!(parsed.metrics.is_none());
    for replacement in ["0", "2.5", "5", "null", "\"2\""] {
        assert!(parse_startup_intent(
            base.replace(
                "\"renderScale\":2",
                &format!("\"renderScale\":{replacement}")
            )
            .as_bytes()
        )
        .is_err());
    }
    assert!(parse_startup_intent(
        base.replace("\"renderScale\":2", "\"renderScale\":\"auto\"")
            .as_bytes()
    )
    .is_ok());
    assert!(parse_startup_intent(base.replace("\"skia\"", "\"webview\"").as_bytes()).is_err());
    assert!(parse_startup_intent(
        base.replace("375", "1000")
            .replace("667", "1000")
            .replace("\"renderScale\":2", "\"renderScale\":3")
            .as_bytes()
    )
    .is_err());
}

#[test]
fn raw_pins_and_node_semantic_projection_are_different_domains() {
    let original = intent(r#"{"n":1.0,"z":-0,"big":9007199254740993}"#, "375.0", "1.0");
    let generated = intent(r#"{"n":1,"z":0,"big":9007199254740992}"#, "375", "1");
    assert_ne!(sha(&original), sha(&generated));
    let original_typed = parse_intent(&original).unwrap();
    let generated_typed = parse_intent(&generated).unwrap();
    assert_eq!(original_typed, generated_typed);
    // Hash validation still consumes the exact original raw bytes.
    assert_eq!(sha(&original), format!("{:x}", Sha256::digest(&original)));
}

#[test]
fn original_decimal_tokens_survive_typed_startup_decoding() {
    let lower = intent(
        r#"{"n":1.00000000000000011102230246251565404236316680908203125}"#,
        "375",
        "1",
    );
    let upper = intent(
        r#"{"n":1.00000000000000011102230246251565404236316680908203126}"#,
        "375",
        "1",
    );
    let lower = parse_intent(&lower).unwrap();
    let upper = parse_intent(&upper).unwrap();
    assert_eq!(
        lower.data.as_ref().unwrap().value()["n"].as_f64(),
        Some(1.0)
    );
    assert_eq!(
        upper.data.as_ref().unwrap().value()["n"].as_f64(),
        Some(1.0000000000000002)
    );
    assert_ne!(lower.data, upper.data);
}

#[test]
fn viewport_and_schema_use_node_safe_integer_semantics() {
    for width in ["375", "375.0", "3.75e2", "375.0000000000000000001"] {
        let value = parse_intent(&intent("{}", width, "1.0")).unwrap();
        assert_eq!(value.viewport.width, 375);
    }
    for width in [
        "0",
        "-0",
        "-1",
        "375.5",
        "4097",
        "9007199254740992",
        "1e309",
    ] {
        assert!(parse_intent(&intent("{}", width, "1")).is_err(), "{width}");
    }
    for schema in ["0", "1.5", "2", "9007199254740992"] {
        assert!(
            parse_intent(&intent("{}", "375", schema)).is_err(),
            "{schema}"
        );
    }
}

#[test]
fn projection_does_not_erase_duplicate_unknown_null_or_wrong_type_fields() {
    for data in [
        r#"{"a":1,"a":2}"#,
        r#"{"a":1,"\u0061":2}"#,
        "null",
        "[]",
        "1",
    ] {
        assert!(parse_intent(&intent(data, "375", "1")).is_err(), "{data}");
    }
    let unknown = br#"{"schemaVersion":1,"execution":"worker","engine":"quickjs","viewport":{"width":375,"height":667},"rendererPolicy":{"mode":"manifest"},"extra":true}"#;
    assert!(parse_intent(unknown).is_err());
    let duplicate = br#"{"schemaVersion":1,"schemaVersion":1.0,"execution":"worker","engine":"quickjs","viewport":{"width":375,"height":667},"rendererPolicy":{"mode":"manifest"}}"#;
    assert!(parse_intent(duplicate).is_err());
}

#[test]
fn startup_index_and_renderer_config_share_the_same_numeric_projection() {
    let bytes = br#"{"schemaVersion":1.0,"execution":"worker","engine":"quickjs","index":{"url":"./pack-index.json","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":42.0},"rendererPolicy":{"mode":"manifest"},"viewport":{"width":375.0,"height":667.0},"rendererAssets":{"schemaVersion":1.0,"renderer":"canvaskit","ratio":2.0},"route":"pages/index/index","data":{"n":1.0}}"#;
    let startup: wire::StartupJson = parse_semantic(bytes, STARTUP_BYTES, 32 * 1024, 64).unwrap();
    assert_eq!(startup.index.size, 42);
    let config: wire::StrictJson = parse_semantic(
        br#"{"schemaVersion":1,"renderer":"canvaskit","ratio":2}"#,
        DESCRIPTOR_BYTES,
        262_144,
        128,
    )
    .unwrap();
    assert_eq!(startup.renderer_assets.as_ref(), Some(&config));
}

#[test]
fn byte_and_structure_limits_still_apply_to_original_startup_input() {
    let bytes = intent("{}", "375", "1");
    assert!(parse_semantic::<wire::StartupIntent>(&bytes, bytes.len() - 1, 32 * 1024, 64).is_err());
    assert!(parse_semantic::<wire::StartupIntent>(&bytes, STARTUP_BYTES, 3, 64).is_err());
    assert!(parse_semantic::<wire::StartupIntent>(&bytes, STARTUP_BYTES, 32 * 1024, 0).is_err());
}

#[test]
fn all_three_actual_namespace_directories_must_be_disjoint() {
    let source = Path::new("/owned/source/pack");
    let runtime = Path::new("/owned/runtime/output");
    let output = Path::new("/owned/stage/output");
    validate_directories(source, runtime, output).unwrap();
    // Distinct actual Arc owners do not prove disjoint native paths. In
    // particular, a stage output must never be inside its retained runtime.
    for (source, runtime, output) in [
        (source, runtime, runtime),
        (source, runtime, Path::new("/owned/runtime/output/stage")),
        (source, runtime, Path::new("/owned/runtime")),
        (source, runtime, source),
        (source, runtime, Path::new("/owned/source/pack/stage")),
        (source, runtime, Path::new("/owned/source")),
        (source, source, output),
        (source, Path::new("/owned/source/pack/runtime"), output),
        (source, Path::new("/owned/source"), output),
    ] {
        assert!(validate_directories(source, runtime, output).is_err());
    }
    // A sibling with a shared string prefix is still a distinct directory.
    validate_directories(source, runtime, Path::new("/owned/runtime/output-next")).unwrap();
}
