//! Evaluator-produced data dependencies. These carry no owner or write authority.
use super::{
    expression_array_index, EvaluationContext, Expression, ExpressionArrayEntry, ExpressionLexer,
    ExpressionObjectEntry, ExpressionParser, ExpressionToken, ExpressionTokenKind,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BindingPathSegment {
    Key(String),
    Index(usize),
}
pub type BindingDataPath = Vec<BindingPathSegment>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WxmlAttributeSource {
    pub source_site: String,
    pub attribute: String,
    pub paths: Vec<BindingDataPath>,
    #[serde(default)]
    pub direct_path: Option<BindingDataPath>,
    pub supported: bool,
}

#[derive(Clone, Debug)]
pub(super) struct BindingOrigin {
    path: Option<BindingDataPath>,
    members: Option<BTreeMap<String, Self>>,
    reads: Vec<BindingDataPath>,
    supported: bool,
}
impl BindingOrigin {
    pub(super) fn root(name: &str) -> Self {
        Self::path(vec![BindingPathSegment::Key(name.into())])
    }
    fn path(path: BindingDataPath) -> Self {
        Self {
            reads: vec![path.clone()],
            path: Some(path),
            members: None,
            supported: true,
        }
    }
    pub(super) fn literal() -> Self {
        Self {
            path: None,
            members: None,
            reads: vec![],
            supported: true,
        }
    }
    pub(super) fn unsupported() -> Self {
        Self {
            supported: false,
            ..Self::literal()
        }
    }
    pub(super) fn member(&self, key: &str, array: bool) -> Self {
        if let Some(path) = &self.path {
            let mut next = path.clone();
            if array {
                let Some(index) = expression_array_index(key) else {
                    return Self::unsupported();
                };
                next.push(BindingPathSegment::Index(index));
            } else {
                next.push(BindingPathSegment::Key(key.into()));
            }
            let mut value = Self::path(next);
            value
                .reads
                .extend(self.reads.iter().filter(|read| *read != path).cloned());
            value.supported = self.supported;
            value
        } else if let Some(members) = &self.members {
            members.get(key).cloned().unwrap_or_else(Self::literal)
        } else {
            self.clone()
        }
    }
    fn include(&mut self, other: &Self) {
        self.reads.extend(other.reads.clone());
        self.supported &= other.supported;
    }
    pub(super) fn direct(&self) -> bool {
        self.path.is_some()
    }
    pub(super) fn paths(&self) -> Vec<BindingDataPath> {
        let mut reads = self.reads.clone();
        reads.sort();
        reads.dedup();
        // Observing a child subsumes the traversal of its parent. Independent
        // selector/control reads survive, including a dynamic index dependency.
        reads
            .iter()
            .filter(|path| {
                !reads
                    .iter()
                    .any(|other| other.len() > path.len() && other.starts_with(path))
            })
            .cloned()
            .collect()
    }
}
fn parse(source: &str, shorthand: bool) -> Option<Expression> {
    let tokens = ExpressionLexer::new(source).tokenize().ok()?;
    if let Ok(value) = ExpressionParser::new(tokens.clone()).parse() {
        return Some(value);
    }
    if !shorthand {
        return None;
    }
    let mut tokens = tokens;
    tokens.insert(
        0,
        ExpressionToken {
            kind: ExpressionTokenKind::Symbol("{"),
            offset: 0,
        },
    );
    let end = tokens.pop()?;
    tokens.push(ExpressionToken {
        kind: ExpressionTokenKind::Symbol("}"),
        offset: end.offset,
    });
    tokens.push(end);
    ExpressionParser::new(tokens).parse().ok()
}
pub(super) fn template_origin(source: &str, context: &EvaluationContext) -> BindingOrigin {
    fn direct(value: &Expression) -> bool {
        match value {
            Expression::Variable(_) | Expression::Literal(_) => true,
            Expression::Member(base, key) => {
                direct(base) && matches!(&**key, Expression::Literal(_))
            }
            Expression::Object(entries) => entries.iter().all(|entry| match entry {
                ExpressionObjectEntry::Value(key, value) => {
                    matches!(key, Expression::Literal(_)) && direct(value)
                }
                ExpressionObjectEntry::Spread(value) => direct(value),
            }),
            _ => false,
        }
    }
    match parse(source, true) {
        Some(expression) if direct(&expression) => origin(&expression, context),
        _ => BindingOrigin::unsupported(),
    }
}
pub(super) fn source_origin(
    source: &str,
    context: &EvaluationContext,
    shorthand: bool,
) -> BindingOrigin {
    parse(source, shorthand)
        .map(|expression| origin(&expression, context))
        .unwrap_or_else(BindingOrigin::unsupported)
}
fn json(expression: &Expression, context: &EvaluationContext) -> Option<Value> {
    expression
        .evaluate(&context.values, 0)
        .ok()?
        .into_json()
        .ok()
}
fn origin(expression: &Expression, context: &EvaluationContext) -> BindingOrigin {
    match expression {
        Expression::Literal(_) => BindingOrigin::literal(),
        Expression::Variable(name) => context
            .origins
            .get(name)
            .cloned()
            .unwrap_or_else(BindingOrigin::unsupported),
        Expression::Member(base, key) => {
            // Use the evaluator's property-key conversion and canonical array
            // index grammar. A JSON round trip turns numeric 1 into "1.0",
            // losing the selected dependency and disagreeing with evaluation.
            let mut value = match (json(base, context), key.evaluate(&context.values, 0)) {
                (Some(base_value), Ok(key_value)) => {
                    origin(base, context).member(&key_value.string(), base_value.is_array())
                }
                _ => BindingOrigin::unsupported(),
            };
            value.include(&origin(key, context));
            value
        }
        Expression::Unary(_, value) => {
            let mut result = origin(value, context);
            result.path = None;
            result.members = None;
            result
        }
        Expression::Binary(operator, left, right) => {
            let left_origin = origin(left, context);
            if *operator == "&&" || *operator == "||" {
                let truth = left
                    .evaluate(&context.values, 0)
                    .map(|value| value.truthy())
                    .unwrap_or(false);
                let take_right = if *operator == "&&" { truth } else { !truth };
                if take_right {
                    let mut value = origin(right, context);
                    value.include(&left_origin);
                    value
                } else {
                    left_origin
                }
            } else {
                let mut value = left_origin;
                value.path = None;
                value.members = None;
                value.include(&origin(right, context));
                value
            }
        }
        Expression::Conditional(condition, yes, no) => {
            let selected = if condition
                .evaluate(&context.values, 0)
                .map(|value| value.truthy())
                .unwrap_or(false)
            {
                yes
            } else {
                no
            };
            let mut value = origin(selected, context);
            value.include(&origin(condition, context));
            value
        }
        Expression::Object(entries) => {
            let mut value = BindingOrigin::literal();
            let mut members = BTreeMap::new();
            for entry in entries {
                match entry {
                    ExpressionObjectEntry::Value(key, item) => {
                        let key_value =
                            key.evaluate(&context.values, 0).map(|value| value.string());
                        let item = origin(item, context);
                        value.include(&item);
                        value.include(&origin(key, context));
                        if let Ok(key) = key_value {
                            members.insert(key, item);
                        } else {
                            value.supported = false;
                        }
                    }
                    ExpressionObjectEntry::Spread(item) => {
                        let source = origin(item, context);
                        value.include(&source);
                        if let Some(Value::Object(entries)) = json(item, context) {
                            for key in entries.keys() {
                                members.insert(key.clone(), source.member(key, false));
                            }
                        } else {
                            value.supported = false;
                        }
                    }
                }
            }
            value.members = Some(members);
            value
        }
        Expression::Array(entries) => {
            let mut value = BindingOrigin::literal();
            let mut members = BTreeMap::new();
            let mut index = 0;
            for entry in entries {
                match entry {
                    ExpressionArrayEntry::Value(item) => {
                        let item = origin(item, context);
                        value.include(&item);
                        members.insert(index.to_string(), item);
                        index += 1;
                    }
                    ExpressionArrayEntry::Hole => {
                        index += 1;
                    }
                    ExpressionArrayEntry::Spread(item) => {
                        let source = origin(item, context);
                        value.include(&source);
                        if let Some(Value::Array(items)) = json(item, context) {
                            for offset in 0..items.len() {
                                members.insert(
                                    index.to_string(),
                                    source.member(&offset.to_string(), true),
                                );
                                index += 1;
                            }
                        } else {
                            value.supported = false;
                        }
                    }
                }
            }
            value.members = Some(members);
            value
        }
    }
}
pub(super) fn record(
    context: &EvaluationContext,
    site: &str,
    attribute: &str,
    origin: BindingOrigin,
) {
    context
        .attribute_sources
        .borrow_mut()
        .push(WxmlAttributeSource {
            source_site: site.into(),
            attribute: attribute.into(),
            paths: origin.paths(),
            direct_path: origin.path.clone(),
            supported: origin.supported,
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{evaluate_wxml_with_templates_and_provenance, parse_wxml};
    use serde_json::json;
    fn key(text: &str) -> BindingPathSegment {
        BindingPathSegment::Key(text.into())
    }
    #[test]
    fn fallback_retains_exact_loop_template_include_dependencies() {
        let source=parse_wxml(r#"<view wx:for="{{items}}" wx:key="id" animation="{{item.animation}}"/><template name="row"><view animation="{{value}}"/></template><template is="row" data="{{value:items[1].animation}}"/><include src="./nested.wxml"/>"#).unwrap();
        let templates = BTreeMap::from([
            ("page.wxml".into(), source.clone()),
            (
                "nested.wxml".into(),
                parse_wxml(r#"<view animation="{{globalAnimation}}"/>"#).unwrap(),
            ),
        ]);
        let output=evaluate_wxml_with_templates_and_provenance(&source,&json!({"items":[{"id":"a","animation":{"actions":[]}},{"id":"b","animation":{"actions":[1]}}],"globalAnimation":{"actions":[2]}}),&templates,Some("page.wxml")).unwrap();
        let sources = output
            .attribute_sources
            .iter()
            .filter(|source| source.attribute == "animation")
            .collect::<Vec<_>>();
        let first = vec![key("items"), BindingPathSegment::Index(0), key("animation")];
        let second = vec![key("items"), BindingPathSegment::Index(1), key("animation")];
        let global = vec![key("globalAnimation")];
        assert_eq!(
            sources
                .iter()
                .map(|source| source.paths.clone())
                .collect::<Vec<_>>(),
            vec![
                vec![first],
                vec![second.clone()],
                vec![second],
                vec![global]
            ]
        );
        assert!(sources
            .iter()
            .all(|source| source.supported && source.direct_path.as_ref() == source.paths.first()));
        assert_eq!(
            sources
                .iter()
                .map(|source| &source.source_site)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            4
        );
    }
    #[test]
    fn fallback_member_keys_match_the_evaluated_property() {
        for (expression, expected) in [
            (
                "records[1.0]",
                Some(vec![key("records"), BindingPathSegment::Index(1)]),
            ),
            (
                "records[-0]",
                Some(vec![key("records"), BindingPathSegment::Index(0)]),
            ),
            (
                "records[[1]]",
                Some(vec![key("records"), BindingPathSegment::Index(1)]),
            ),
            ("objects[1.0]", Some(vec![key("objects"), key("1")])),
            ("objects[true]", Some(vec![key("objects"), key("true")])),
            ("records['01']", None),
            ("records['1.0']", None),
            ("records['4294967295']", None),
        ] {
            let source =
                parse_wxml(&format!("<view animation=\"{{{{{expression}}}}}\"/>")).unwrap();
            let output = evaluate_wxml_with_templates_and_provenance(
                &source,
                &json!({"records":[{},{}],"objects":{"1":{},"true":{}}}),
                &BTreeMap::new(),
                Some("page.wxml"),
            )
            .unwrap();
            let source = &output.attribute_sources[0];
            assert_eq!(source.direct_path, expected, "{expression}");
            assert_eq!(source.supported, expected.is_some(), "{expression}");
        }
    }
    #[test]
    fn fallback_template_aliases_are_exact_or_explicitly_unsupported() {
        let source = parse_wxml(r#"<template name="row"><view animation="{{value}}"/></template><template is="row" data="{{value:animation,title:title}}"/><template is="row" data="{{value:enabled ? animation : other}}"/><template is="row" data="{{value:records[which]}}"/>"#).unwrap();
        let output = evaluate_wxml_with_templates_and_provenance(
            &source,
            &json!({"animation":{"actions":[]},"title":"unrelated","enabled":true,"other":{"actions":[]},"records":[{"actions":[]}],"which":0}),
            &BTreeMap::new(),
            Some("page.wxml"),
        ).unwrap();
        let sources = output
            .attribute_sources
            .iter()
            .filter(|source| source.attribute == "animation")
            .collect::<Vec<_>>();
        assert_eq!(sources[0].paths, vec![vec![key("animation")]]);
        assert!(sources[0].supported);
        assert!(sources[1..].iter().all(|source| !source.supported));
    }
    #[test]
    fn fallback_tracks_selected_dynamic_path_and_control_inputs() {
        let source =
            parse_wxml(r#"<view animation="{{enabled ? records[which] : other}}"/>"#).unwrap();
        let output = evaluate_wxml_with_templates_and_provenance(
            &source,
            &json!({"enabled":true,"which":1,"records":[{},{}],"other":{}}),
            &BTreeMap::new(),
            Some("page.wxml"),
        )
        .unwrap();
        let source = &output.attribute_sources[0];
        assert_eq!(
            source.paths,
            vec![
                vec![key("enabled")],
                vec![key("records"), BindingPathSegment::Index(1)],
                vec![key("which")]
            ]
        );
        assert_eq!(
            source.direct_path,
            Some(vec![key("records"), BindingPathSegment::Index(1)])
        );
    }
}
