//! Shared projection of evaluated WXML metadata into render and event nodes.
//!
//! Attributes retain literal/mixed strings and naming. `bound_values` supplies
//! the JSON value of an already evaluated complete binding. Never parse the
//! rendered attribute text or evaluate a binding a second time here.

use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy)]
enum MetadataKind {
    Dataset,
    Mark,
}

pub(super) fn project_dataset(
    attrs: &BTreeMap<String, String>,
    bound_values: &BTreeMap<String, Value>,
) -> BTreeMap<String, Value> {
    project_metadata(attrs, bound_values, MetadataKind::Dataset)
}

pub(super) fn project_mark(
    attrs: &BTreeMap<String, String>,
    bound_values: &BTreeMap<String, Value>,
) -> BTreeMap<String, Value> {
    project_metadata(attrs, bound_values, MetadataKind::Mark)
}

/// Preserve existing JSON values without interpreting their spelling or origin.
///
/// The evaluator's existing JSON boundary has already normalized undefined and
/// missing values to null. Forwarding that null does not classify its origin
/// or establish official null/presence behavior. Attr iteration is sorted, so
/// canonical collisions retain the existing last-sorted-attribute rule.
fn project_metadata(
    attrs: &BTreeMap<String, String>,
    bound_values: &BTreeMap<String, Value>,
    kind: MetadataKind,
) -> BTreeMap<String, Value> {
    attrs
        .iter()
        .filter_map(|(name, text)| {
            let key = match kind {
                MetadataKind::Dataset => name.strip_prefix("data-"),
                MetadataKind::Mark => name
                    .strip_prefix("mark:")
                    .or_else(|| name.strip_prefix("mark-")),
            }?;
            if key.is_empty() {
                return None;
            }
            let value = bound_values
                .get(name)
                .cloned()
                .unwrap_or_else(|| Value::String(text.clone()));
            Some((metadata_key(key), value))
        })
        .collect()
}

/// Preserve existing hyphen folding; source letters are not DOM-normalized.
fn metadata_key(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut uppercase = false;
    for ch in value.chars() {
        if ch == '-' {
            uppercase = true;
            continue;
        }
        if uppercase {
            output.extend(ch.to_uppercase());
            uppercase = false;
        } else {
            output.push(ch);
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn both_metadata_maps_preserve_bindings_and_literal_text() {
        for prefix in ["data-", "mark:", "mark-"] {
            let attrs = BTreeMap::from([
                (format!("{prefix}number"), "7".into()),
                (format!("{prefix}enabled"), "false".into()),
                (format!("{prefix}list"), "[1,2]".into()),
                (format!("{prefix}object"), "[object Object]".into()),
                (format!("{prefix}null"), String::new()),
                (format!("{prefix}literal-number"), "001".into()),
                (format!("{prefix}literal-boolean"), "true".into()),
                (format!("{prefix}literal-json"), "{\"n\":7}".into()),
                (format!("{prefix}mixed"), "prefix-7".into()),
                (format!("{prefix}empty"), String::new()),
                (prefix.into(), "empty key is ignored".into()),
                ("id".into(), "node".into()),
            ]);
            let bound_values = BTreeMap::from([
                (format!("{prefix}number"), json!(7)),
                (format!("{prefix}enabled"), json!(false)),
                (format!("{prefix}list"), json!([1, 2])),
                (format!("{prefix}object"), json!({"n": 7})),
                // Existing JSON null, not a missing/undefined verdict.
                (format!("{prefix}null"), Value::Null),
                (format!("{prefix}absent"), json!("must not invent a key")),
            ]);
            let values = if prefix == "data-" {
                project_dataset(&attrs, &bound_values)
            } else {
                project_mark(&attrs, &bound_values)
            };
            assert_eq!(
                json!(values),
                json!({
                    "number":7,"enabled":false,"list":[1,2],"object":{"n":7},
                    "null":null,"literalNumber":"001","literalBoolean":"true",
                    "literalJson":"{\"n\":7}","mixed":"prefix-7","empty":""
                })
            );
            assert_eq!(attrs[&format!("{prefix}number")], "7");
        }
    }

    #[test]
    fn actual_evaluation_keeps_types_and_does_not_reinterpret_bound_strings() {
        let source = container_ir::parse_wxml(
            r#"<view data-count="{{count}}" data-text="{{text}}" data-mixed="x{{count}}" data-literal="false" mark:count="{{count}}" mark-text="{{text}}"/>"#,
        )
        .unwrap();
        let evaluated = container_ir::evaluate_wxml(
            &source,
            &json!({"count":7,"text":"{{notAnotherBinding}}"}),
        )
        .unwrap();
        let container_ir::WxmlNode::Element {
            attrs,
            bound_values,
            ..
        } = &evaluated.nodes[0]
        else {
            panic!("evaluated element");
        };
        let dataset = project_dataset(attrs, bound_values);
        let mark = project_mark(attrs, bound_values);
        assert_eq!(dataset["count"].as_f64(), Some(7.0));
        assert_eq!(dataset["text"], "{{notAnotherBinding}}");
        assert_eq!(dataset["mixed"], "x7");
        assert_eq!(dataset["literal"], "false");
        assert_eq!(mark["count"], dataset["count"]);
        assert_eq!(mark["text"], dataset["text"]);
        assert_eq!(attrs["data-count"], "7");
    }

    #[test]
    fn projections_own_nested_snapshots_and_keep_special_keys() {
        let attrs = BTreeMap::from([
            ("data-__proto__".into(), "[object Object]".into()),
            ("data-user-id".into(), "[object Object]".into()),
            ("mark:__proto__".into(), "[object Object]".into()),
            ("mark-user-id".into(), "[object Object]".into()),
        ]);
        let mut bound_values = BTreeMap::from([
            ("data-__proto__".into(), json!({"safe":[true]})),
            ("data-user-id".into(), json!({"ids":[1,2]})),
            ("mark:__proto__".into(), json!({"safe":[true]})),
            ("mark-user-id".into(), json!({"ids":[1,2]})),
        ]);
        let dataset = project_dataset(&attrs, &bound_values);
        let mark = project_mark(&attrs, &bound_values);
        bound_values.get_mut("data-user-id").unwrap()["ids"][0] = json!(99);
        bound_values.get_mut("mark-user-id").unwrap()["ids"][0] = json!(99);
        assert_eq!(dataset["userId"], json!({"ids":[1,2]}));
        assert_eq!(mark["userId"], dataset["userId"]);
        assert_eq!(mark, dataset);
        let encoded = serde_json::to_string(&dataset).unwrap();
        let decoded: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(
            decoded.as_object().unwrap().get("__proto__"),
            Some(&json!({"safe":[true]}))
        );
    }
}
