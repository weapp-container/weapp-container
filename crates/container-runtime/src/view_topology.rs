//! Authoritative event identities and ancestry from the evaluated View document.
//!
//! This index does not depend on a renderer, layout, browser DOM, or host-supplied
//! event path. Physical ancestry determines propagation; each declaration's
//! semantic ownership remains the ownership recorded in the document, including
//! projected slot content.

use crate::node_metadata::{project_dataset, project_mark};
use container_core::EventPhase;
use container_ir::{ViewDocument, ViewEventBinding, ViewEventPhase, ViewNode, ViewOwnership};
use serde_json::Value;
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub(super) enum ViewTopologyError {
    #[error("invalid View document: {0}")]
    InvalidDocument(String),
    #[error("unknown View occurrence id: {0}")]
    UnknownTarget(String),
    #[error("View text occurrence has no element parent: {0}")]
    NoElementTarget(String),
    #[error("event type cannot be empty")]
    EmptyEvent,
    #[error("View occurrence {occurrence_id} attribute {name} must be a JSON scalar")]
    InvalidAttribute { occurrence_id: String, name: String },
}

/// An immutable snapshot of evaluated metadata. User-visible ids need not be
/// unique; only `occurrence_id` is an identity or an event-routing address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ViewTopologyNode {
    pub occurrence_id: String,
    pub parent: Option<String>,
    /// Text occurrences have no element tag, attributes or listeners.
    pub tag: Option<String>,
    pub public_id: Option<String>,
    pub classes: Vec<String>,
    pub attrs: BTreeMap<String, String>,
    pub typed_attrs: BTreeMap<String, Value>,
    pub dataset: BTreeMap<String, Value>,
    pub mark: BTreeMap<String, Value>,
    pub ownership: ViewOwnership,
    pub events: Vec<ViewEventBinding>,
}

#[derive(Clone, Debug)]
pub(super) struct ViewTopology {
    nodes: BTreeMap<String, ViewTopologyNode>,
}

/// Only declared listeners are returned. A bubble binding on the resolved
/// target runs in Target phase; its capture binding runs immediately before it.
#[derive(Clone, Copy, Debug)]
pub(super) struct ViewTopologyListener<'a> {
    pub node: &'a ViewTopologyNode,
    pub binding: &'a ViewEventBinding,
    pub phase: EventPhase,
}

#[derive(Debug)]
pub(super) struct ViewEventRoute<'a> {
    pub target: &'a ViewTopologyNode,
    /// Root-to-target element occurrences, including both endpoints. Forest
    /// roots remain roots; this layer never fabricates a page element.
    pub path: Vec<&'a ViewTopologyNode>,
    pub listeners: Vec<ViewTopologyListener<'a>>,
    pub propagation_stopped: bool,
}

impl ViewTopology {
    pub fn from_document(document: &ViewDocument) -> Result<Self, ViewTopologyError> {
        document
            .validate()
            .map_err(|error| ViewTopologyError::InvalidDocument(error.to_string()))?;
        let mut nodes = BTreeMap::new();
        let mut pending: Vec<(&ViewNode, Option<&str>)> =
            document.nodes.iter().map(|node| (node, None)).collect();
        while let Some((node, parent)) = pending.pop() {
            let mut indexed = ViewTopologyNode {
                occurrence_id: node.occurrence_id().into(),
                parent: parent.map(str::to_owned),
                tag: None,
                public_id: None,
                classes: Vec::new(),
                attrs: BTreeMap::new(),
                typed_attrs: BTreeMap::new(),
                dataset: BTreeMap::new(),
                mark: BTreeMap::new(),
                ownership: node.ownership().clone(),
                events: Vec::new(),
            };
            if let ViewNode::Element {
                tag,
                attrs,
                typed_attrs,
                events,
                children,
                ..
            } = node
            {
                indexed.tag = Some(tag.clone());
                indexed.public_id =
                    scalar_attribute(node.occurrence_id(), attrs, typed_attrs, "id")?;
                indexed.classes =
                    scalar_attribute(node.occurrence_id(), attrs, typed_attrs, "class")?
                        .map(|value| value.split_whitespace().map(str::to_owned).collect())
                        .unwrap_or_default();
                indexed.attrs = attrs.clone();
                indexed.typed_attrs = typed_attrs.clone();
                indexed.dataset = project_dataset(attrs, typed_attrs);
                indexed.mark = project_mark(attrs, typed_attrs);
                indexed.events = events.clone();
                pending.extend(
                    children
                        .iter()
                        .map(|child| (child, Some(node.occurrence_id()))),
                );
            }
            nodes.insert(indexed.occurrence_id.clone(), indexed);
        }
        Ok(Self { nodes })
    }

    /// Exact lookup, including text occurrences. This never treats a public
    /// `id`, a selector or a host-provided DOM path as an occurrence id.
    pub fn node(&self, occurrence_id: &str) -> Option<&ViewTopologyNode> {
        self.nodes.get(occurrence_id)
    }

    pub fn element_target(
        &self,
        occurrence_id: &str,
    ) -> Result<&ViewTopologyNode, ViewTopologyError> {
        let mut node = self
            .node(occurrence_id)
            .ok_or_else(|| ViewTopologyError::UnknownTarget(occurrence_id.into()))?;
        while node.tag.is_none() {
            node = node
                .parent
                .as_deref()
                .and_then(|parent| self.node(parent))
                .ok_or_else(|| ViewTopologyError::NoElementTarget(occurrence_id.into()))?;
        }
        Ok(node)
    }

    /// Resolve text targets first, then return root-to-target element ancestry.
    /// The document is a validated tree, so parent traversal is finite and each
    /// ancestor is an element even when the original target was a text node.
    pub fn ancestry(
        &self,
        occurrence_id: &str,
    ) -> Result<Vec<&ViewTopologyNode>, ViewTopologyError> {
        let mut path = Vec::new();
        let mut node = Some(self.element_target(occurrence_id)?);
        while let Some(current) = node {
            path.push(current);
            node = current
                .parent
                .as_deref()
                .and_then(|parent| self.node(parent));
        }
        path.reverse();
        Ok(path)
    }

    /// Derive listener order using only committed declarations. In particular,
    /// callers cannot supply path, capture policy, handler, dataset or owner.
    /// A declared catch truncates synchronously before any handler is invoked;
    /// dynamic handler stopPropagation can still further shorten this route.
    pub fn event_route(
        &self,
        occurrence_id: &str,
        event: &str,
    ) -> Result<ViewEventRoute<'_>, ViewTopologyError> {
        if event.trim().is_empty() {
            return Err(ViewTopologyError::EmptyEvent);
        }
        let path = self.ancestry(occurrence_id)?;
        let target = *path
            .last()
            .expect("element target guarantees a nonempty path");
        let mut route = ViewEventRoute {
            target,
            path,
            listeners: Vec::new(),
            propagation_stopped: false,
        };
        for &node in &route.path {
            if let Some(binding) = binding(node, event, ViewEventPhase::Capture) {
                route.listeners.push(ViewTopologyListener {
                    node,
                    binding,
                    phase: EventPhase::Capture,
                });
                if binding.catch {
                    route.propagation_stopped = true;
                    return Ok(route);
                }
            }
        }
        for &node in route.path.iter().rev() {
            if let Some(binding) = binding(node, event, ViewEventPhase::Bubble) {
                route.listeners.push(ViewTopologyListener {
                    node,
                    binding,
                    phase: if node.occurrence_id == target.occurrence_id {
                        EventPhase::Target
                    } else {
                        EventPhase::Bubble
                    },
                });
                if binding.catch {
                    route.propagation_stopped = true;
                    return Ok(route);
                }
            }
        }
        Ok(route)
    }
}

/// Match the DOM scalar boundary without interpreting the legacy projection
/// when an evaluated value exists, even when that value is null or false.
pub(super) fn scalar_attribute(
    occurrence_id: &str,
    attrs: &BTreeMap<String, String>,
    typed_attrs: &BTreeMap<String, Value>,
    name: &str,
) -> Result<Option<String>, ViewTopologyError> {
    let Some(value) = typed_attrs.get(name) else {
        return Ok(attrs.get(name).cloned());
    };
    let invalid = || ViewTopologyError::InvalidAttribute {
        occurrence_id: occurrence_id.into(),
        name: name.into(),
    };
    let text = match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => {
            // JSON reaches the browser as a Number, including its IEEE-754
            // rounding. Rust's JSON spelling (e.g. 1.0) is not String(Number).
            let number = value
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(invalid)?;
            if number == 0.0 {
                "0".into()
            } else if (1e-6..1e21).contains(&number.abs()) {
                number.to_string()
            } else {
                let scientific = format!("{number:e}");
                let (mantissa, exponent) = scientific.split_once('e').expect("scientific number");
                format!(
                    "{mantissa}e{}{exponent}",
                    if exponent.starts_with('-') { "" } else { "+" }
                )
            }
        }
        Value::Array(_) | Value::Object(_) => return Err(invalid()),
    };
    Ok(Some(text))
}

fn binding<'a>(
    node: &'a ViewTopologyNode,
    event: &str,
    phase: ViewEventPhase,
) -> Option<&'a ViewEventBinding> {
    node.events
        .iter()
        .find(|binding| binding.event == event && binding.phase == phase)
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_ir::{RendererProfile, VIEW_DOCUMENT_VERSION};
    use serde_json::json;

    fn element(id: &str, children: Vec<ViewNode>) -> ViewNode {
        ViewNode::Element {
            occurrence_id: id.into(),
            tag: "view".into(),
            attrs: BTreeMap::new(),
            typed_attrs: BTreeMap::new(),
            key: None,
            ownership: ViewOwnership {
                document_id: "pages/home/index.wxml".into(),
                ..ViewOwnership::default()
            },
            events: vec![
                ViewEventBinding {
                    event: "tap".into(),
                    handler: format!("{id}Capture"),
                    phase: ViewEventPhase::Capture,
                    catch: false,
                },
                ViewEventBinding {
                    event: "tap".into(),
                    handler: format!("{id}Bubble"),
                    phase: ViewEventPhase::Bubble,
                    catch: false,
                },
            ],
            children,
        }
    }

    fn document(nodes: Vec<ViewNode>) -> ViewDocument {
        ViewDocument {
            version: VIEW_DOCUMENT_VERSION.into(),
            session_id: "session".into(),
            page_id: 7,
            revision: 11,
            route_path: "pages/home/index".into(),
            profile: RendererProfile::WebView,
            nodes,
            style_roots: Vec::new(),
            styles: Vec::new(),
            resources: Vec::new(),
        }
    }

    fn nested() -> ViewDocument {
        document(vec![element(
            "root",
            vec![element("parent", vec![element("target", Vec::new())])],
        )])
    }

    fn listener_names(route: &ViewEventRoute<'_>) -> Vec<(String, EventPhase)> {
        route
            .listeners
            .iter()
            .map(|listener| (listener.binding.handler.clone(), listener.phase))
            .collect()
    }

    #[test]
    fn capture_target_bubble_order_comes_from_document_without_host_route() {
        let topology = ViewTopology::from_document(&nested()).unwrap();
        let route = topology.event_route("target", "tap").unwrap();
        assert_eq!(route.target.occurrence_id, "target");
        assert_eq!(
            route
                .path
                .iter()
                .map(|node| node.occurrence_id.as_str())
                .collect::<Vec<_>>(),
            ["root", "parent", "target"]
        );
        assert_eq!(
            listener_names(&route),
            [
                ("rootCapture".into(), EventPhase::Capture),
                ("parentCapture".into(), EventPhase::Capture),
                ("targetCapture".into(), EventPhase::Capture),
                ("targetBubble".into(), EventPhase::Target),
                ("parentBubble".into(), EventPhase::Bubble),
                ("rootBubble".into(), EventPhase::Bubble),
            ]
        );
        assert!(!route.propagation_stopped);
        assert!(topology
            .event_route("target", "unbound")
            .unwrap()
            .listeners
            .is_empty());
    }

    #[test]
    fn every_catch_boundary_truncates_before_later_listeners() {
        let baseline = ViewTopology::from_document(&nested()).unwrap();
        let expected = listener_names(&baseline.event_route("target", "tap").unwrap());
        for (stop, (handler, _)) in expected.iter().enumerate() {
            let mut source = nested();
            let mut pending: Vec<_> = source.nodes.iter_mut().collect();
            while let Some(ViewNode::Element {
                events, children, ..
            }) = pending.pop()
            {
                for event in events {
                    event.catch = event.handler == *handler;
                }
                pending.extend(children.iter_mut());
            }
            let topology = ViewTopology::from_document(&source).unwrap();
            let route = topology.event_route("target", "tap").unwrap();
            assert_eq!(listener_names(&route), expected[..=stop]);
            assert!(route.propagation_stopped);
            assert!(route.listeners.last().unwrap().binding.catch);
        }
    }

    #[test]
    fn evaluated_metadata_retains_types_literals_and_independent_snapshot() {
        let mut node = element("occurrence", Vec::new());
        let ViewNode::Element {
            attrs, typed_attrs, ..
        } = &mut node
        else {
            unreachable!()
        };
        *attrs = BTreeMap::from([
            ("id".into(), "public-id".into()),
            ("class".into(), "card\tselected\nwide".into()),
            ("data-enabled".into(), "false".into()),
            ("data-user-id".into(), "7".into()),
            ("data-config".into(), "[object Object]".into()),
            ("data-null".into(), "".into()),
            ("data-literal".into(), "false".into()),
            ("data-__proto__".into(), "[object Object]".into()),
            ("mark:group-id".into(), "9".into()),
        ]);
        *typed_attrs = BTreeMap::from([
            ("data-enabled".into(), json!(false)),
            ("data-user-id".into(), json!(7)),
            ("data-config".into(), json!({"list": [1, true]})),
            ("data-null".into(), Value::Null),
            ("data-__proto__".into(), json!({"safe": true})),
            ("mark:group-id".into(), json!(9)),
        ]);
        let mut source = document(vec![node]);
        let topology = ViewTopology::from_document(&source).unwrap();
        let node = topology.node("occurrence").unwrap();
        assert_eq!(node.public_id.as_deref(), Some("public-id"));
        assert_eq!(node.tag.as_deref(), Some("view"));
        assert_eq!(node.classes, ["card", "selected", "wide"]);
        assert_eq!(
            json!(node.dataset),
            json!({
                "enabled": false, "userId": 7, "config": {"list": [1, true]},
                "null": null, "literal": "false", "__proto__": {"safe": true}
            })
        );
        assert_eq!(json!(node.mark), json!({"groupId": 9}));
        assert_eq!(node.attrs["data-enabled"], "false");
        assert_eq!(node.typed_attrs["data-enabled"], false);
        let ViewNode::Element { typed_attrs, .. } = &mut source.nodes[0] else {
            unreachable!()
        };
        typed_attrs.get_mut("data-config").unwrap()["list"][0] = json!(99);
        assert_eq!(node.dataset["config"]["list"][0], 1);
    }

    #[test]
    fn typed_id_and_classes_override_legacy_strings_including_null_and_false() {
        for (typed, expected_id, expected_classes) in [
            (
                json!("actual selected"),
                "actual selected",
                vec!["actual", "selected"],
            ),
            (Value::Null, "", vec![]),
            (json!(false), "false", vec!["false"]),
            (json!(true), "true", vec!["true"]),
            (json!(7), "7", vec!["7"]),
        ] {
            for legacy_present in [true, false] {
                let mut node = element("occurrence", Vec::new());
                let ViewNode::Element {
                    attrs, typed_attrs, ..
                } = &mut node
                else {
                    unreachable!()
                };
                for name in ["id", "class"] {
                    if legacy_present {
                        attrs.insert(name.into(), "legacy stale".into());
                    }
                    typed_attrs.insert(name.into(), typed.clone());
                }
                let topology = ViewTopology::from_document(&document(vec![node])).unwrap();
                let indexed = topology.node("occurrence").unwrap();
                assert_eq!(indexed.public_id.as_deref(), Some(expected_id));
                assert_eq!(indexed.classes, expected_classes);
            }
        }
        let topology =
            ViewTopology::from_document(&document(vec![element("empty", Vec::new())])).unwrap();
        assert_eq!(topology.node("empty").unwrap().public_id, None);
        assert!(topology.node("empty").unwrap().classes.is_empty());
    }

    #[test]
    fn typed_numeric_attributes_match_browser_number_string_boundaries() {
        for (number, expected) in [
            (json!(1.0), "1"),
            (json!(-0.0), "0"),
            (json!(1e-6), "0.000001"),
            (json!(1e-7), "1e-7"),
            (json!(1e20), "100000000000000000000"),
            (json!(1e21), "1e+21"),
            (json!(-1.5e21), "-1.5e+21"),
            (json!(9007199254740993u64), "9007199254740992"),
        ] {
            assert_eq!(
                scalar_attribute(
                    "node",
                    &BTreeMap::new(),
                    &BTreeMap::from([("id".into(), number)]),
                    "id"
                )
                .unwrap(),
                Some(expected.into())
            );
        }
    }

    #[test]
    fn nonscalar_typed_identity_attributes_reject_the_document() {
        for name in ["id", "class"] {
            for value in [
                json!([]),
                json!(["looks", "usable"]),
                json!({}),
                json!({"id": "forged"}),
            ] {
                let mut node = element("occurrence", Vec::new());
                let ViewNode::Element {
                    attrs, typed_attrs, ..
                } = &mut node
                else {
                    unreachable!()
                };
                attrs.insert(name.into(), "legacy-valid-scalar".into());
                typed_attrs.insert(name.into(), value);
                assert_eq!(
                    ViewTopology::from_document(&document(vec![node])).unwrap_err(),
                    ViewTopologyError::InvalidAttribute {
                        occurrence_id: "occurrence".into(),
                        name: name.into()
                    }
                );
            }
        }
    }

    #[test]
    fn text_target_resolves_to_element_and_forest_has_no_synthetic_page() {
        let text = ViewNode::Text {
            occurrence_id: "text".into(),
            value: "hello".into(),
            ownership: ViewOwnership {
                document_id: "pages/home/index.wxml".into(),
                ..ViewOwnership::default()
            },
        };
        let topology = ViewTopology::from_document(&document(vec![
            element("root", vec![element("parent", vec![text.clone()])]),
            element("separate", Vec::new()),
        ]))
        .unwrap();
        let route = topology.event_route("text", "tap").unwrap();
        assert_eq!(route.target.occurrence_id, "parent");
        assert_eq!(route.path.len(), 2);
        assert_eq!(route.path[0].occurrence_id, "root");
        assert_eq!(
            topology.node("text").unwrap().parent.as_deref(),
            Some("parent")
        );
        assert!(topology.node("text").unwrap().tag.is_none());
        assert_eq!(topology.ancestry("separate").unwrap().len(), 1);
        let orphan = ViewTopology::from_document(&document(vec![text])).unwrap();
        assert_eq!(
            orphan.event_route("text", "tap").unwrap_err(),
            ViewTopologyError::NoElementTarget("text".into())
        );
    }

    #[test]
    fn slot_listener_uses_declared_owner_and_never_inherits_receiving_component() {
        let mut slot = element("slot-content", Vec::new());
        let ViewNode::Element {
            ownership, attrs, ..
        } = &mut slot
        else {
            unreachable!()
        };
        ownership.event_owner = Some("declaration-owner".into());
        ownership.slot_owner = Some("slot-declaration".into());
        ownership.component_scope = Some("declaration-scope".into());
        attrs.insert(
            "bindtap".into(),
            "unresolved-attribute-is-not-a-listener".into(),
        );
        let mut receiving = element("receiving-component", vec![slot]);
        let ViewNode::Element { ownership, .. } = &mut receiving else {
            unreachable!()
        };
        ownership.event_owner = Some("receiver-owner".into());
        ownership.component_scope = Some("receiver-scope".into());
        let topology = ViewTopology::from_document(&document(vec![receiving])).unwrap();
        let route = topology.event_route("slot-content", "tap").unwrap();
        let target_listener = route
            .listeners
            .iter()
            .find(|listener| listener.phase == EventPhase::Target)
            .unwrap();
        assert_eq!(target_listener.binding.handler, "slot-contentBubble");
        assert_eq!(
            target_listener.node.ownership.event_owner.as_deref(),
            Some("declaration-owner")
        );
        assert_eq!(
            target_listener.node.ownership.slot_owner.as_deref(),
            Some("slot-declaration")
        );
        assert_eq!(
            target_listener.node.ownership.component_scope.as_deref(),
            Some("declaration-scope")
        );
        assert_eq!(
            route.path[0].ownership.event_owner.as_deref(),
            Some("receiver-owner")
        );
    }

    #[test]
    fn duplicate_occurrences_rejected_while_duplicate_public_ids_remain_distinct() {
        let duplicate = element("same-occurrence", Vec::new());
        assert!(matches!(
            ViewTopology::from_document(&document(vec![duplicate.clone(), duplicate])),
            Err(ViewTopologyError::InvalidDocument(_))
        ));
        let mut nodes = vec![element("a", Vec::new()), element("b", Vec::new())];
        for node in &mut nodes {
            let ViewNode::Element { attrs, .. } = node else {
                unreachable!()
            };
            attrs.insert("id".into(), "shared-public-id".into());
        }
        let topology = ViewTopology::from_document(&document(nodes)).unwrap();
        for id in ["a", "b"] {
            let route = topology.event_route(id, "tap").unwrap();
            assert_eq!(route.target.occurrence_id, id);
            assert_eq!(route.target.public_id.as_deref(), Some("shared-public-id"));
            assert_eq!(route.path.len(), 1);
        }
        assert_eq!(
            topology.event_route("shared-public-id", "tap").unwrap_err(),
            ViewTopologyError::UnknownTarget("shared-public-id".into())
        );
    }

    #[test]
    fn unknown_targets_and_empty_event_types_cannot_construct_a_route() {
        let topology = ViewTopology::from_document(&nested()).unwrap();
        for target in ["", "missing", "root.target", "#target", "event:forged"] {
            assert_eq!(
                topology.event_route(target, "tap").unwrap_err(),
                ViewTopologyError::UnknownTarget(target.into())
            );
        }
        assert_eq!(
            topology.event_route("target", " \t").unwrap_err(),
            ViewTopologyError::EmptyEvent
        );
    }
}
