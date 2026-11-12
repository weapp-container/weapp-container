use container_ir::{decode_wxml, evaluate_wxml, parse_wxml, project_wxml_slots, WxmlAst, WxmlNode};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn attributes(node: &WxmlNode) -> (&BTreeMap<String, String>, &BTreeMap<String, Value>) {
    let WxmlNode::Element {
        attrs,
        bound_values,
        ..
    } = node
    else {
        panic!("element expected");
    };
    (attrs, bound_values)
}

#[test]
fn pure_bindings_preserve_loop_scoped_json_types_and_legacy_strings() {
    let ast = parse_wxml(r#"<card wx:for="{{rows}}" wx:key="id" object="{{item.object}}" array="{{item.array}}" false-string="{{item.falseString}}" number-string="{{item.numberString}}" boolean="{{false}}" number="{{index+1}}" nullable="{{null}}"/>"#).unwrap();
    let rows = json!([
        {"id":"a","object":{"label":"{{secret}}"},"array":[1,false,{"x":2}],"falseString":"false","numberString":"123"},
        {"id":"b","object":{"label":"second"},"array":["other"],"falseString":"true","numberString":"0042"}
    ]);
    let evaluated =
        evaluate_wxml(&ast, &json!({"rows":rows,"secret":"must not replace data"})).unwrap();
    assert_eq!(evaluated.nodes.len(), 2);
    for (index, node) in evaluated.nodes.iter().enumerate() {
        let (attrs, bound) = attributes(node);
        assert_eq!(bound["object"], rows[index]["object"]);
        assert_eq!(bound["array"], rows[index]["array"]);
        assert_eq!(bound["false-string"], rows[index]["falseString"]);
        assert_eq!(bound["number-string"], rows[index]["numberString"]);
        assert_eq!(bound["boolean"], false);
        // JavaScript has one Number type; JSON's integer/float storage is not
        // observable WXML semantics. as_f64 still rejects strings and bools.
        assert_eq!(bound["number"].as_f64(), Some((index + 1) as f64));
        assert_eq!(bound["nullable"], Value::Null);
        assert_eq!(bound.len(), 7, "wx directives remain routing metadata");
        assert_eq!(
            attrs["object"],
            serde_json::to_string(&rows[index]["object"]).unwrap()
        );
        assert_eq!(
            attrs["array"],
            serde_json::to_string(&rows[index]["array"]).unwrap()
        );
        assert_eq!(attrs["boolean"], "false");
        assert_eq!(attrs["number"], (index + 1).to_string());
        assert_eq!(attrs["nullable"], "");
    }
}

#[test]
fn mixed_literals_stay_strings_and_quoted_delimiters_do_not_split_bindings() {
    let ast = parse_wxml(r#"<card literal="false" json='{"x":1}' mixed="x{{value}}" spaced=" {{value}} " adjacent="{{value}}{{other}}" quoted="{{ '}}' }}" object="{{({label:'}}',nested:{items:[1,2]}})}}"/>"#).unwrap();
    let evaluated = evaluate_wxml(&ast, &json!({"value":false,"other":123})).unwrap();
    let (attrs, bound) = attributes(&evaluated.nodes[0]);
    assert_eq!(attrs["literal"], "false");
    assert_eq!(attrs["json"], r#"{"x":1}"#);
    assert_eq!(attrs["mixed"], "xfalse");
    assert_eq!(attrs["spaced"], " false ");
    assert_eq!(attrs["adjacent"], "false123");
    assert_eq!(bound.len(), 2);
    assert_eq!(bound["quoted"], "}}");
    let object = bound["object"].as_object().expect("typed object binding");
    assert_eq!(object.len(), 2);
    assert_eq!(object["label"], "}}");
    let nested = object["nested"].as_object().expect("typed nested object");
    assert_eq!(nested.len(), 1);
    let items = nested["items"].as_array().expect("typed nested array");
    assert_eq!(
        items.iter().map(Value::as_f64).collect::<Vec<_>>(),
        vec![Some(1.0), Some(2.0)]
    );
}

#[test]
fn previously_evaluated_string_bindings_are_not_executed_again() {
    let ast = parse_wxml(r#"<card value="{{value}}"/>"#).unwrap();
    let evaluated = evaluate_wxml(&ast, &json!({"value":"{{secret}}"})).unwrap();
    let again = evaluate_wxml(&evaluated, &json!({"secret":"unexpected"})).unwrap();
    let (attrs, bound) = attributes(&again.nodes[0]);
    assert_eq!(attrs["value"], "{{secret}}");
    assert_eq!(bound["value"], "{{secret}}");
}

#[test]
fn typed_attribute_metadata_is_optional_in_v1_and_roundtrips_without_type_guessing() {
    let ast = parse_wxml(r#"<card value="{{value}}"/>"#).unwrap();
    let source_json = ast.canonical_json().unwrap();
    assert!(!String::from_utf8_lossy(&source_json).contains("boundValues"));
    assert_eq!(decode_wxml(&source_json).unwrap(), ast);
    let evaluated = evaluate_wxml(&ast, &json!({"value":"false"})).unwrap();
    let mut encoded = serde_json::to_value(&evaluated).unwrap();
    assert_eq!(encoded["nodes"][0]["boundValues"]["value"], "false");
    assert_eq!(
        decode_wxml(&evaluated.canonical_json().unwrap()).unwrap(),
        evaluated
    );
    let node = encoded["nodes"][0].as_object_mut().unwrap();
    let metadata = node.remove("boundValues").unwrap();
    node.insert("bound_values".into(), metadata);
    assert_eq!(
        decode_wxml(&serde_json::to_vec(&encoded).unwrap()).unwrap(),
        evaluated
    );
    encoded["nodes"][0]
        .as_object_mut()
        .unwrap()
        .remove("bound_values");
    let legacy = decode_wxml(&serde_json::to_vec(&encoded).unwrap()).unwrap();
    let (attrs, bound) = attributes(&legacy.nodes[0]);
    assert_eq!(attrs["value"], "false");
    assert!(
        bound.is_empty(),
        "legacy evaluated strings do not imply a JSON type"
    );
}

#[test]
fn slot_projection_removes_routing_metadata_and_preserves_typed_child_properties() {
    let component = parse_wxml(r#"<slot name="header"/>"#).unwrap();
    let light = evaluate_wxml(
        &parse_wxml(r#"<card slot="{{slotName}}" value="{{value}}"/>"#).unwrap(),
        &json!({"slotName":"header","value":{"items":[1,2]}}),
    )
    .unwrap();
    let projected: WxmlAst = project_wxml_slots(&component, &light.nodes).unwrap();
    let (attrs, bound) = attributes(&projected.nodes[0]);
    assert!(!attrs.contains_key("slot"));
    assert!(!bound.contains_key("slot"));
    assert_eq!(bound["value"], json!({"items":[1,2]}));
}
