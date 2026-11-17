//! Render-wire and deterministic software-paint coverage only. These cases
//! do not establish engine, browser, GPU, device, or official runtime parity.

use container_render_skia::{RenderFrame, Renderer, SoftwareRenderer};
use serde_json::{json, Value};

fn wire_frame() -> Value {
    json!({
        "frame_id":42,
        "viewport":{"x":0.0,"y":0.0,"width":2.0,"height":1.0},
        "root":{
            "id":"root",
            "bounds":{"x":0.0,"y":0.0,"width":2.0,"height":1.0},
            "background":{"red":255,"green":255,"blue":255,"alpha":255},
            "opacity":1.0,
            "children":[{
                "id":"child",
                "bounds":{"x":1.0,"y":0.0,"width":1.0,"height":1.0},
                "background":{"red":9,"green":17,"blue":33,"alpha":255},
                "opacity":1.0,
                "children":[]
            }]
        }
    })
}

fn typed_values() -> Value {
    json!({
        "integer":7,"fraction":1.5,"negative":-2,"enabled":false,
        "text":"value","empty":"","list":[1,true,null,{"n":2}],
        "object":{"nested":{"values":[false,"text"]}},"null":null,
        "__proto__":{"own":true},"constructor":"literal-own-key"
    })
}

fn legacy_strings() -> Value {
    json!({
        "number":"001","boolean":"false","array":"[1,2]",
        "object":"{\"n\":7}","null":"null","binding":"{{value}}",
        "empty":"","mixed":"prefix-7"
    })
}

#[test]
fn typed_metadata_roundtrips_through_frame_wire_without_type_changes() {
    let mut wire = wire_frame();
    let expected = typed_values();
    for node in ["/root", "/root/children/0"] {
        for field in ["dataset", "mark"] {
            wire.pointer_mut(node).unwrap()[field] = expected.clone();
        }
    }
    let bytes = serde_json::to_vec(&wire).unwrap();
    let decoded: RenderFrame = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(decoded.root.dataset["integer"], json!(7));
    assert_eq!(decoded.root.mark["enabled"], json!(false));
    assert_eq!(decoded.root.children[0].dataset["null"], Value::Null);
    assert_eq!(
        decoded.root.children[0].mark["__proto__"],
        json!({"own":true})
    );
    let encoded = serde_json::to_value(&decoded).unwrap();
    for node in ["/root", "/root/children/0"] {
        for field in ["dataset", "mark"] {
            assert_eq!(encoded.pointer(node).unwrap()[field], expected);
        }
    }
    let roundtrip: RenderFrame =
        serde_json::from_slice(&serde_json::to_vec(&decoded).unwrap()).unwrap();
    assert_eq!(roundtrip, decoded);
}

#[test]
fn legacy_string_maps_remain_strings_even_when_they_look_like_json() {
    let mut wire = wire_frame();
    let expected = legacy_strings();
    for field in ["dataset", "mark"] {
        wire["root"][field] = expected.clone();
    }
    let decoded: RenderFrame = serde_json::from_value(wire).unwrap();
    for values in [&decoded.root.dataset, &decoded.root.mark] {
        assert!(values.values().all(Value::is_string));
        assert_eq!(values["number"], "001");
        assert_eq!(values["boolean"], "false");
        assert_eq!(values["null"], "null");
    }
    let encoded = serde_json::to_value(decoded).unwrap();
    assert_eq!(encoded["root"]["dataset"], expected);
    assert_eq!(encoded["root"]["mark"], expected);
}

#[test]
fn omitted_maps_default_to_empty_and_keep_their_existing_omitted_encoding() {
    let decoded: RenderFrame = serde_json::from_value(wire_frame()).unwrap();
    for node in [&decoded.root, &decoded.root.children[0]] {
        assert!(node.dataset.is_empty());
        assert!(node.mark.is_empty());
    }
    let encoded = serde_json::to_value(decoded).unwrap();
    for node in ["/root", "/root/children/0"] {
        let object = encoded.pointer(node).unwrap().as_object().unwrap();
        assert!(!object.contains_key("dataset"));
        assert!(!object.contains_key("mark"));
    }
}

#[test]
fn metadata_requires_an_object_on_root_and_descendant_nodes() {
    for invalid in [
        Value::Null,
        json!(7),
        json!(false),
        json!("text"),
        json!([]),
        json!([1]),
    ] {
        for node in ["/root", "/root/children/0"] {
            for field in ["dataset", "mark"] {
                let mut wire = wire_frame();
                wire.pointer_mut(node).unwrap()[field] = invalid.clone();
                assert!(
                    serde_json::from_value::<RenderFrame>(wire).is_err(),
                    "{node}/{field} must reject non-object metadata: {invalid}"
                );
            }
        }
    }
}

#[test]
fn typed_and_legacy_metadata_do_not_change_software_rgba_pixels() {
    let mut renderer = SoftwareRenderer::new();
    renderer
        .commit(serde_json::from_value(wire_frame()).unwrap())
        .unwrap();
    let expected = renderer.snapshot().unwrap();
    assert_eq!(expected.pixels, [255, 255, 255, 255, 9, 17, 33, 255]);

    for values in [legacy_strings(), typed_values()] {
        let mut wire = wire_frame();
        for node in ["/root", "/root/children/0"] {
            wire.pointer_mut(node).unwrap()["dataset"] = values.clone();
            wire.pointer_mut(node).unwrap()["mark"] = values.clone();
        }
        renderer
            .commit(serde_json::from_value(wire).unwrap())
            .unwrap();
        assert_eq!(renderer.snapshot().unwrap(), expected);
        // Metadata remains in the accepted frame; painting does not erase it.
        let accepted = serde_json::to_value(renderer.last_frame().unwrap()).unwrap();
        for node in ["/root", "/root/children/0"] {
            assert_eq!(accepted.pointer(node).unwrap()["dataset"], values);
            assert_eq!(accepted.pointer(node).unwrap()["mark"], values);
        }
    }
}
