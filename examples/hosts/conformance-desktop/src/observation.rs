//! Queries read the same accepted tree that was submitted to the native surface.
use crate::pack::Result;
use container_core::selector::{
    query as select, CompiledSelectorList, SelectorNodeRef, SelectorTree,
};
use container_render_skia::{RenderFrame, RenderNode};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Query {
    pub selector: String,
    pub scope: Vec<Scope>,
    pub has: Option<String>,
    pub fields: Option<Fields>,
}

/// Scope steps bind an actual accepted-frame component receiver. The object
/// variant is an address predicate, never a CSS pseudo-class or expected value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Selector(String),
    Has(String),
}

fn selector(value: &Value) -> Result<String> {
    let value = value
        .as_str()
        .filter(|value| !value.trim().is_empty() && !value.contains('\0'))
        .ok_or("query requires a nonempty selector string")?;
    CompiledSelectorList::parse(value)?;
    Ok(value.to_owned())
}

/// Internal checkpoint projection, never an expected-value payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fields {
    pub text: bool,
    pub attributes: Vec<String>,
}

impl Query {
    #[cfg(test)]
    pub fn flat(selector: &str) -> Self {
        Self {
            selector: selector.into(),
            scope: Vec::new(),
            has: None,
            fields: None,
        }
    }

    pub fn parse(value: &Value) -> Result<Self> {
        if let Some(selector) = value.as_str() {
            return Self::parse(&json!({"selector":selector}));
        }
        let object = value
            .as_object()
            .ok_or("query must be a selector or address object")?;
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "selector" | "scope" | "has" | "fields" | "query"
            )
        }) {
            return Err("query has an unsupported address field".into());
        }
        if object
            .get("query")
            .is_some_and(|value| value.as_str() != Some("css"))
        {
            return Err("query mode must be css".into());
        }
        let target = selector(value.get("selector").ok_or("query needs selector")?)?;
        let scope = match value.get("scope") {
            None => Vec::new(),
            Some(Value::Array(values)) => values
                .iter()
                .map(|value| {
                    if value.is_string() {
                        return Ok(Scope::Selector(selector(value)?));
                    }
                    let object = value
                        .as_object()
                        .filter(|object| object.len() == 1 && object.contains_key("has"))
                        .ok_or("query scope step must be a selector or exact has predicate")?;
                    Ok(Scope::Has(selector(&object["has"])?))
                })
                .collect::<Result<Vec<_>>>()?,
            _ => return Err("query scope must be an array".into()),
        };
        let has = value.get("has").map(selector).transpose()?;
        let fields = match value.get("fields") {
            None => None,
            Some(Value::Object(fields)) => {
                if fields.len() != 2
                    || !fields.contains_key("text")
                    || !fields.contains_key("attributes")
                {
                    return Err("checkpoint fields need exactly text and attribute names".into());
                }
                let text = fields
                    .get("text")
                    .and_then(Value::as_bool)
                    .ok_or("checkpoint text field must be boolean")?;
                let names = fields
                    .get("attributes")
                    .and_then(Value::as_array)
                    .ok_or("checkpoint attributes must be names")?;
                let mut attributes = Vec::new();
                for name in names {
                    let name = name
                        .as_str()
                        .filter(|name| {
                            !name.is_empty() && name.trim() == *name && !name.contains('\0')
                        })
                        .ok_or("checkpoint attribute name is malformed")?;
                    if attributes.iter().any(|previous| previous == name) {
                        return Err("checkpoint attribute names must be unique".into());
                    }
                    attributes.push(name.to_owned());
                }
                Some(Fields { text, attributes })
            }
            _ => return Err("checkpoint fields must be an object".into()),
        };
        Ok(Self {
            selector: target,
            scope,
            has,
            fields,
        })
    }

    /// Keep the transport envelope separate from the strict query address.
    /// Existing id/op/route/name wire shapes stay valid; unknown fields cannot
    /// be silently discarded while projecting the payload.
    pub fn parse_request(value: &Value) -> Result<Self> {
        let mut address = value
            .as_object()
            .cloned()
            .ok_or("query IPC must be an object")?;
        let operation = address
            .get("op")
            .and_then(Value::as_str)
            .ok_or("query IPC needs op")?;
        if !matches!(
            operation,
            "query" | "query.text" | "query.attribute" | "tap"
        ) {
            return Err("query IPC operation is unsupported".into());
        }
        if !address
            .get("id")
            .is_some_and(|id| id.is_string() || id.is_u64())
        {
            return Err("query IPC needs id".into());
        }
        if address
            .get("route")
            .is_some_and(|route| route.as_str().is_none_or(str::is_empty))
        {
            return Err("query IPC route must be a nonempty string".into());
        }
        if operation == "query.attribute" {
            if !address
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.is_empty() && name.trim() == name && !name.contains('\0'))
            {
                return Err("attribute IPC needs one canonical name".into());
            }
        } else if address.contains_key("name") {
            return Err("only attribute IPC may carry name".into());
        }
        for key in ["id", "op", "route", "name"] {
            address.remove(key);
        }
        Self::parse(&Value::Object(address))
    }

    pub fn evidence(&self) -> Value {
        let mut value = json!({"selector":self.selector});
        if !self.scope.is_empty() {
            value["scope"] = json!(self
                .scope
                .iter()
                .map(|step| match step {
                    Scope::Selector(selector) => json!(selector),
                    Scope::Has(has) => json!({"has":has}),
                })
                .collect::<Vec<_>>());
        }
        if let Some(has) = &self.has {
            value["has"] = json!(has);
        }
        value
    }
}

/// This adapter is rooted in the actual accepted-frame node returned by the
/// preceding query. It never re-resolves a receiver by an id, selector string,
/// legacy data attribute or a globally searched scope alias.
struct AcceptedTree<'a> {
    root: &'a RenderNode,
}
impl<'a> SelectorTree for AcceptedTree<'a> {
    type Node = &'a RenderNode;
    fn root(&self) -> Self::Node {
        self.root
    }
    fn metadata(&self, node: Self::Node) -> SelectorNodeRef<'_> {
        SelectorNodeRef {
            tag: node.tag.as_deref(),
            id: Some(&node.id),
            classes: &node.classes,
            attributes: &node.attributes,
            owner_scope: node.event_owner_scope_id.as_deref(),
            component_scope: node.component_scope_id.as_deref(),
        }
    }
    fn child(&self, node: Self::Node, index: usize) -> Option<Self::Node> {
        node.children.get(index)
    }
}

type ComponentHosts<'a> = BTreeMap<&'a str, Vec<&'a RenderNode>>;

fn component_token<'a>(components: &ComponentHosts<'a>, host: &'a RenderNode) -> Result<&'a str> {
    let token = host
        .component_scope_id
        .as_deref()
        .filter(|token| !token.is_empty() && token.trim() == *token && !token.contains('\0'))
        .ok_or("scope selector does not address a concrete runtime component")?;
    if !components
        .get(token)
        .is_some_and(|hosts| hosts.len() == 1 && std::ptr::eq(hosts[0], host))
    {
        return Err("component runtime scope token must identify exactly one actual host".into());
    }
    Ok(token)
}

fn within<'a>(
    frame: &'a RenderFrame,
    components: &ComponentHosts<'a>,
    receiver: Option<&'a RenderNode>,
    selector: &str,
) -> Result<Vec<&'a RenderNode>> {
    let Some(receiver) = receiver else {
        // Preserve the established flat Page-root query contract. Native vs
        // official root enumeration remains subject to runtime observation.
        return Ok(frame.query(selector, true)?);
    };
    let owner = if receiver.component_scope_id.is_some() {
        Some(component_token(components, receiver)?)
    } else {
        receiver.event_owner_scope_id.as_deref()
    };
    let mut nodes = select(
        &AcceptedTree { root: receiver },
        &CompiledSelectorList::parse(selector)?,
        true,
        None,
    );
    // Element.$$ addresses descendants, not its receiver. Ownership follows
    // declaration, including projected slot nodes, rather than render parent.
    nodes.retain(|node| {
        !std::ptr::eq(*node, receiver) && node.event_owner_scope_id.as_deref() == owner
    });
    Ok(nodes)
}

fn matches<'a>(frame: &'a RenderFrame, query: &Query) -> Result<Vec<&'a RenderNode>> {
    matches_from(frame, query, None)
}

/// Optional receiver is the actual node in this accepted frame, never a public id.
pub(crate) fn matches_from<'a>(
    frame: &'a RenderFrame,
    query: &Query,
    mut receiver: Option<&'a RenderNode>,
) -> Result<Vec<&'a RenderNode>> {
    if receiver.is_none() && query.scope.is_empty() && query.has.is_none() {
        return Ok(frame.query(&query.selector, true)?);
    }
    // Index physical component hosts once for the accepted generation. Token
    // validation cannot adopt a same-named host or rescan the entire page for
    // every predicate candidate.
    let mut components = ComponentHosts::new();
    for node in frame.query("*", true)? {
        if let Some(token) = node.component_scope_id.as_deref() {
            components.entry(token).or_default().push(node);
        }
    }
    for step in &query.scope {
        let hosts = match step {
            Scope::Selector(selector) => within(frame, &components, receiver, selector)?,
            Scope::Has(has) => {
                let mut hosts = Vec::new();
                for candidate in within(frame, &components, receiver, "*")? {
                    if candidate.component_scope_id.is_some() {
                        component_token(&components, candidate)?;
                        if !within(frame, &components, Some(candidate), has)?.is_empty() {
                            hosts.push(candidate);
                        }
                    }
                }
                hosts
            }
        };
        if hosts.len() != 1 {
            return Err("scope requires exactly one actual component host".into());
        }
        component_token(&components, hosts[0])?;
        receiver = Some(hosts[0]);
    }
    let mut nodes = within(frame, &components, receiver, &query.selector)?;
    if let Some(has) = &query.has {
        let mut filtered = Vec::new();
        for candidate in nodes {
            if !within(frame, &components, Some(candidate), has)?.is_empty() {
                filtered.push(candidate);
            }
        }
        nodes = filtered;
    }
    Ok(nodes)
}

fn text(node: &RenderNode, output: &mut String) {
    if let Some(value) = &node.text {
        output.push_str(value);
    }
    for child in &node.children {
        text(child, output);
    }
}

pub fn query(frame: &RenderFrame, query: &Query) -> Result<Value> {
    let nodes = matches(frame, query)?
        .iter()
        .map(|node| {
            json!({"id":node.id,
        "eventIdentity":node.event_identity,"componentScopeId":node.component_scope_id})
        })
        .collect::<Vec<_>>();
    let mut value = query.evidence();
    value["count"] = json!(nodes.len());
    value["nodes"] = json!(nodes);
    Ok(value)
}

pub fn query_text(frame: &RenderFrame, query: &Query) -> Result<Value> {
    let nodes = matches(frame, query)?;
    if nodes.len() != 1 {
        return Err("text read requires exactly one actual rendered node".into());
    }
    let mut value = query.evidence();
    let mut actual = String::new();
    text(nodes[0], &mut actual);
    value["count"] = json!(1);
    value["text"] = json!(actual);
    Ok(value)
}

/// Read one rendered string attribute from the same accepted scene. Presence
/// is independent from the checkpoint's legacy null projection. An absent map
/// entry never invents an Automator getter value or a JSON null.
pub fn query_attribute(frame: &RenderFrame, query: &Query, name: &str) -> Result<Value> {
    if name.is_empty() || name.trim() != name || name.contains('\0') || query.fields.is_some() {
        return Err("attribute read needs one canonical name and no checkpoint fields".into());
    }
    let nodes = matches(frame, query)?;
    if nodes.len() != 1 {
        return Err("attribute read requires exactly one actual rendered node".into());
    }
    let attribute = nodes[0].attributes.get(name);
    let mut value = query.evidence();
    value["count"] = json!(1);
    value["name"] = json!(name);
    value["present"] = json!(attribute.is_some());
    value["value"] = match attribute {
        Some(actual) => json!({"type":"string","value":actual}),
        None => json!({"type":"absent"}),
    };
    Ok(value)
}

pub fn checkpoint(frame: &RenderFrame, id: &str, route: &str, queries: &[Query]) -> Result<Value> {
    let groups = queries
        .iter()
        .map(|query| {
            let matches = matches(frame, query)?;
            let nodes = matches
                .iter()
                .map(|node| {
                    let mut actual = serde_json::Map::new();
                    if query.fields.as_ref().is_none_or(|fields| fields.text) {
                        let mut value = String::new();
                        text(node, &mut value);
                        actual.insert("text".into(), json!(value.trim()));
                    }
                    if let Some(fields) = &query.fields {
                        if !fields.attributes.is_empty() {
                            let attributes = fields
                                .attributes
                                .iter()
                                .map(|name| {
                                    // Missing stays explicit null. Do not normalize or invent values.
                                    (
                                        name.clone(),
                                        node.attributes
                                            .get(name)
                                            .map_or(Value::Null, |value| json!(value)),
                                    )
                                })
                                .collect::<serde_json::Map<String, Value>>();
                            actual.insert("attributes".into(), Value::Object(attributes));
                        }
                    }
                    Value::Object(actual)
                })
                .collect::<Vec<_>>();
            let mut value = query.evidence();
            value["query"] = json!("css");
            value["count"] = json!(nodes.len());
            value["nodes"] = json!(nodes);
            Ok(value)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"id":id,"route":route,"nodes":groups}))
}

/// A coordinate event still enters runtime hit-testing. Querying the selector
/// does not supply an event target or invoke an AppService handler.
pub fn tap_point(frame: &RenderFrame, query: &Query) -> Result<(f32, f32)> {
    let matches = matches(frame, query)?;
    if matches.len() != 1 {
        return Err("tap requires exactly one actual rendered node".into());
    }
    tap_point_for_node(frame, matches[0])
}

/// The node is an actual resolved frame reference, never a public id/selector.
/// Geometry and hit path are read from that same immutable accepted frame.
pub(crate) fn tap_point_for_node(frame: &RenderFrame, node: &RenderNode) -> Result<(f32, f32)> {
    let geometry = frame
        .node_geometries()
        .into_iter()
        .find(|entry| std::ptr::eq(entry.node, node))
        .ok_or("tap node has no accepted geometry")?;
    let bounds = geometry.bounds;
    if !geometry.displayed || bounds.width <= 0.0 || bounds.height <= 0.0 {
        return Err("tap node is not displayed with positive geometry".into());
    }
    let point = (
        bounds.x + bounds.width / 2.0,
        bounds.y + bounds.height / 2.0,
    );
    if !point.0.is_finite()
        || !point.1.is_finite()
        || !frame.viewport.contains(point.0, point.1)
        || !frame
            .root
            .hit_test_path(point.0, point.1)
            .iter()
            .any(|hit| std::ptr::eq(*hit, node))
    {
        return Err("tap node centre is clipped or covered in the committed frame".into());
    }
    Ok(point)
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_render_skia::Rect;

    fn frame() -> RenderFrame {
        let bounds = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let mut root = RenderNode::new("root", bounds);
        let mut selected = RenderNode::new(
            "selected",
            Rect {
                x: 10.0,
                y: 20.0,
                width: 40.0,
                height: 30.0,
            },
        );
        selected.attributes.insert("id".into(), "selected".into());
        selected.text = Some("actual-".into());
        let mut child = RenderNode::new(
            "child",
            Rect {
                x: 10.0,
                y: 20.0,
                width: 40.0,
                height: 30.0,
            },
        );
        child.text = Some("tree".into());
        selected.children.push(child);
        root.children.push(selected);
        RenderFrame {
            frame_id: 7,
            viewport: bounds,
            root,
            images: Default::default(),
        }
    }

    #[test]
    fn checkpoint_reads_subtree_text_and_actual_missing_counts() {
        let observed = checkpoint(
            &frame(),
            "observed",
            "pages/actual/index",
            &[Query::flat("#selected"), Query::flat("#absent")],
        )
        .unwrap();
        assert_eq!(observed["nodes"][0]["nodes"][0]["text"], "actual-tree");
        assert_eq!(observed["nodes"][1]["count"], 0);
    }

    #[test]
    fn direct_attribute_read_preserves_presence_empty_and_untrimmed_rendered_strings() {
        let mut frame = frame();
        frame.root.children[0]
            .attributes
            .insert("data-empty".into(), "".into());
        frame.root.children[0]
            .attributes
            .insert("data-raw".into(), "  实际值  ".into());
        let address = Query::flat("#selected");
        assert_eq!(
            query_attribute(&frame, &address, "data-empty").unwrap()["value"],
            json!({"type":"string","value":""})
        );
        assert_eq!(
            query_attribute(&frame, &address, "data-raw").unwrap()["value"],
            json!({"type":"string","value":"  实际值  "})
        );
        let absent = query_attribute(&frame, &address, "missing").unwrap();
        assert_eq!(absent["present"], false);
        assert_eq!(absent["value"], json!({"type":"absent"}));
        assert!(query_attribute(&frame, &Query::flat("#absent"), "missing").is_err());
        for name in ["", " data-raw", "data-raw\0"] {
            assert!(query_attribute(&frame, &address, name).is_err());
        }
        let projected =
            Query::parse(&json!({"selector":"#selected","fields":{"text":true,"attributes":[]}}))
                .unwrap();
        assert!(query_attribute(&frame, &projected, "data-raw").is_err());
    }

    #[test]
    fn tap_uses_accepted_geometry_and_rejects_an_occluding_node() {
        let mut frame = frame();
        assert_eq!(
            tap_point(&frame, &Query::flat("#selected")).unwrap(),
            (30.0, 35.0)
        );
        frame
            .root
            .children
            .push(RenderNode::new("cover", frame.viewport));
        assert!(tap_point(&frame, &Query::flat("#selected")).is_err());
        assert!(tap_point(&frame, &Query::flat("#absent")).is_err());
    }

    fn component_frame() -> RenderFrame {
        let mut frame = frame();
        let mut outer = RenderNode::new("foo", frame.viewport);
        outer.attributes.insert("id".into(), "foo".into());
        outer.component_scope_id = Some("runtime-outer".into());
        let mut inner = RenderNode::new("nested", frame.viewport);
        inner.attributes.insert("id".into(), "nested".into());
        inner.component_scope_id = Some("runtime-inner".into());
        inner.event_owner_scope_id = Some("runtime-outer".into());
        let mut button = frame.root.children.remove(0);
        button.id = "increment".into();
        button.attributes.insert("id".into(), "increment".into());
        button.event_owner_scope_id = Some("runtime-inner".into());
        button.event_identity = Some("actual-inner-button".into());
        button.text = Some("  actual-".into());
        button.children[0].text = Some("tree  ".into());
        let mut projected = RenderNode::new(
            "increment",
            Rect {
                x: 80.0,
                y: 80.0,
                width: 5.0,
                height: 5.0,
            },
        );
        projected.attributes.insert("id".into(), "increment".into());
        projected.event_owner_scope_id = Some("runtime-outer".into());
        projected.text = Some("projected other owner".into());
        inner.children = vec![button, projected];
        outer.children.push(inner);
        let mut outside = RenderNode::new(
            "increment",
            Rect {
                x: 90.0,
                y: 90.0,
                width: 5.0,
                height: 5.0,
            },
        );
        outside.attributes.insert("id".into(), "increment".into());
        outside.event_owner_scope_id = Some("runtime-sibling".into());
        outside.text = Some("outside component".into());
        let mut sibling = RenderNode::new("sibling", outside.bounds);
        sibling.component_scope_id = Some("runtime-sibling".into());
        sibling.children.push(outside);
        frame.root.children = vec![outer, sibling];
        frame
    }

    #[test]
    fn recursive_scope_uses_actual_component_tokens_and_declaration_owners() {
        let frame = component_frame();
        let address =
            Query::parse(&json!({"scope":["#foo","#nested"],"selector":"#increment"})).unwrap();
        assert_eq!(frame.query("#increment", true).unwrap().len(), 3);
        let observed = query(&frame, &address).unwrap();
        assert_eq!(observed["count"], 1);
        assert_eq!(observed["scope"], json!(["#foo", "#nested"]));
        assert_eq!(observed["nodes"][0]["eventIdentity"], "actual-inner-button");
        // Raw Element.text and completed DOM checkpoints have the upstream's
        // distinct whitespace behavior; both read the same accepted subtree.
        assert_eq!(
            query_text(&frame, &address).unwrap()["text"],
            "  actual-tree  "
        );
        let checkpoint =
            checkpoint(&frame, "actual", "pages/actual/index", &[address.clone()]).unwrap();
        assert_eq!(checkpoint["nodes"][0]["scope"], json!(["#foo", "#nested"]));
        assert_eq!(checkpoint["nodes"][0]["nodes"][0]["text"], "actual-tree");
        assert_eq!(tap_point(&frame, &address).unwrap(), (30.0, 35.0));
        assert!(query_text(&frame, &Query::flat("#increment")).is_err());
        assert!(tap_point(&frame, &Query::flat("#increment")).is_err());
    }

    #[test]
    fn direct_attribute_reads_keep_the_concrete_component_owner() {
        let mut frame = component_frame();
        frame.root.children[0].children[0].children[0]
            .attributes
            .insert("data-raw".into(), "actual-inner".into());
        frame.root.children[0].children[0].children[1]
            .attributes
            .insert("data-raw".into(), "other-owner".into());
        let address =
            Query::parse(&json!({"scope":["#foo","#nested"],"selector":"#increment"})).unwrap();
        let actual = query_attribute(&frame, &address, "data-raw").unwrap();
        assert_eq!(actual["scope"], json!(["#foo", "#nested"]));
        assert_eq!(
            actual["value"],
            json!({"type":"string","value":"actual-inner"})
        );
        assert!(query_attribute(&frame, &Query::flat("#increment"), "data-raw").is_err());
    }

    #[test]
    fn scopes_reject_missing_ambiguous_and_non_component_hosts() {
        let mut frame = component_frame();
        let query =
            |scope: &[&str]| Query::parse(&json!({"scope":scope,"selector":"#increment"})).unwrap();
        assert!(query_text(&frame, &query(&["#missing"])).is_err());
        assert!(query_text(&frame, &query(&["#foo", "#increment"])).is_err());
        frame.root.children[0].component_scope_id = None;
        frame.root.children[0]
            .attributes
            .insert("data-sim-scope".into(), "legacy".into());
        assert!(query_text(&frame, &query(&["#foo"])).is_err());
        frame.root.children[0].component_scope_id = Some("runtime-outer".into());
        let duplicate = frame.root.children[0].clone();
        frame.root.children.push(duplicate);
        assert!(query_text(&frame, &query(&["#foo"])).is_err());
    }

    #[test]
    fn query_wire_preserves_legacy_selectors_and_rejects_malformed_scope() {
        assert_eq!(
            Query::parse(&json!("#legacy")).unwrap(),
            Query::flat("#legacy")
        );
        assert_eq!(
            Query::flat("#legacy").evidence(),
            json!({"selector":"#legacy"})
        );
        for value in [
            json!({"selector":""}),
            json!({"selector":"#x","scope":null}),
            json!({"selector":"#x","scope":"#foo"}),
            json!({"selector":"#x","scope":[""]}),
        ] {
            assert!(Query::parse(&value).is_err());
        }
    }
    #[test]
    fn checkpoint_attribute_projection_reads_only_actual_requested_names() {
        let mut frame = frame();
        frame.root.children[0]
            .attributes
            .insert("data-title".into(), "  actual distinct title  ".into());
        frame.root.children[0]
            .attributes
            .insert("unrequested".into(), "private value".into());
        let query = Query::parse(&json!({"selector":"#selected","fields":{"text":false,"attributes":["data-title","missing"]}})).unwrap();
        let actual = checkpoint(&frame, "actual", "pages/actual/index", &[query]).unwrap();
        assert_eq!(
            actual["nodes"][0]["nodes"][0],
            json!({"attributes":{"data-title":"  actual distinct title  ","missing":null}})
        );
        assert!(actual["nodes"][0]["nodes"][0].get("text").is_none());
        assert!(actual["nodes"][0]["nodes"][0]["attributes"]
            .get("unrequested")
            .is_none());
    }

    #[test]
    fn combined_text_and_attributes_preserve_distinct_normalization() {
        let mut frame = frame();
        frame.root.children[0].text = Some("  observed-".into());
        frame.root.children[0].children[0].text = Some("subtree  ".into());
        frame.root.children[0]
            .attributes
            .insert("data-title".into(), "  untouched attribute  ".into());
        let query = Query::parse(
            &json!({"selector":"#selected","fields":{"text":true,"attributes":["data-title"]}}),
        )
        .unwrap();
        let actual = checkpoint(&frame, "actual", "pages/actual/index", &[query]).unwrap();
        assert_eq!(
            actual["nodes"][0]["nodes"][0],
            json!({"text":"observed-subtree","attributes":{"data-title":"  untouched attribute  "}})
        );
    }

    #[test]
    fn attribute_projection_uses_the_same_concrete_component_owner() {
        let mut frame = component_frame();
        frame.root.children[0].children[0].children[0]
            .attributes
            .insert("data-title".into(), "actual-inner-owner".into());
        frame.root.children[0].children[0].children[1]
            .attributes
            .insert("data-title".into(), "projected-other-owner".into());
        let query = Query::parse(&json!({"scope":["#foo","#nested"],"selector":"#increment","fields":{"text":false,"attributes":["data-title"]}})).unwrap();
        let actual = checkpoint(&frame, "actual", "pages/actual/index", &[query]).unwrap();
        assert_eq!(actual["nodes"][0]["count"], 1);
        assert_eq!(
            actual["nodes"][0]["nodes"][0]["attributes"]["data-title"],
            "actual-inner-owner"
        );
    }

    #[test]
    fn invalid_or_value_bearing_field_descriptors_are_rejected() {
        for fields in [
            json!(null),
            json!({"text":true}),
            json!({"text":true,"attributes":{"data-title":"expected"}}),
            json!({"text":"expected","attributes":[]}),
            json!({"text":true,"attributes":["data-title","data-title"]}),
            json!({"text":true,"attributes":[""]}),
            json!({"text":true,"attributes":[" data-title"]}),
            json!({"text":true,"attributes":[null]}),
            json!({"text":true,"attributes":[],"expected":"never"}),
        ] {
            assert!(Query::parse(&json!({"selector":"#selected","fields":fields})).is_err());
        }
    }

    #[test]
    fn missing_nodes_stay_absent_with_requested_attributes() {
        let query = Query::parse(
            &json!({"selector":"#absent","fields":{"text":false,"attributes":["data-title"]}}),
        )
        .unwrap();
        let actual = checkpoint(&frame(), "actual", "pages/actual/index", &[query]).unwrap();
        assert_eq!(actual["nodes"][0]["count"], 0);
        assert_eq!(actual["nodes"][0]["nodes"], json!([]));
    }

    fn marker_frame() -> RenderFrame {
        let mut frame = component_frame();
        let marker = &mut frame.root.children[0].children[0].children[0];
        marker.id = "needle".into();
        marker.attributes.insert("id".into(), "needle".into());
        marker
            .attributes
            .insert("data-actual".into(), "accepted-marker".into());
        // Real host identity does not depend on a generic CSS component tag.
        frame.root.children[0].tag = Some("outer-custom".into());
        frame.root.children[0].children[0].tag = Some("inner-custom".into());
        frame
    }

    #[test]
    fn typed_object_scope_finds_unique_actual_host_by_its_own_descendants() {
        let frame = marker_frame();
        assert!(frame.query("component", true).unwrap().is_empty());
        let address =
            Query::parse(&json!({"selector":"#needle","scope":[{"has":"#needle"}]})).unwrap();
        let actual = query(&frame, &address).unwrap();
        assert_eq!(actual["count"], 1);
        assert_eq!(actual["scope"], json!([{"has":"#needle"}]));
        assert_eq!(actual["nodes"][0]["eventIdentity"], "actual-inner-button");
        assert_eq!(
            query_text(&frame, &address).unwrap()["text"],
            "  actual-tree  "
        );
        assert_eq!(tap_point(&frame, &address).unwrap(), (30.0, 35.0));
        let attributes = query_attribute(&frame, &address, "data-actual").unwrap();
        assert_eq!(
            attributes["value"],
            json!({"type":"string","value":"accepted-marker"})
        );
    }

    #[test]
    fn nested_string_and_has_scopes_bind_each_actual_component_receiver() {
        let frame = marker_frame();
        for scope in [
            json!(["#foo",{"has":"#needle"}]),
            json!([{"has":"#nested"},"#nested"]),
        ] {
            let address = Query::parse(&json!({"selector":"#needle","scope":scope})).unwrap();
            assert_eq!(query(&frame, &address).unwrap()["count"], 1);
            assert_eq!(query(&frame, &address).unwrap()["scope"], scope);
        }
        let address = Query::parse(
            &json!({"selector":"#nested","scope":["#foo"],"has":"#needle",
            "fields":{"text":false,"attributes":["id"]}}),
        )
        .unwrap();
        let actual = checkpoint(&frame, "typed", "pages/actual/index", &[address]).unwrap();
        assert_eq!(actual["nodes"][0]["has"], "#needle");
        assert_eq!(actual["nodes"][0]["scope"], json!(["#foo"]));
        assert_eq!(
            actual["nodes"][0]["nodes"][0],
            json!({"attributes":{"id":"nested"}})
        );
    }

    #[test]
    fn top_level_has_filters_targets_without_changing_scope_or_ignoring_predicate() {
        let frame = marker_frame();
        let matching = Query::parse(&json!({"selector":"#nested","has":"#needle"})).unwrap();
        assert_eq!(query(&frame, &matching).unwrap()["count"], 1);
        assert_eq!(query(&frame, &matching).unwrap()["has"], "#needle");
        let absent = Query::parse(&json!({"selector":"#nested","has":"#not-present"})).unwrap();
        assert_eq!(query(&frame, &absent).unwrap()["count"], 0);
        assert!(query_text(&frame, &absent).is_err());
        assert!(tap_point(&frame, &absent).is_err());
        let wrong_owner = Query::parse(&json!({"selector":"#foo","has":"#needle"})).unwrap();
        assert_eq!(query(&frame, &wrong_owner).unwrap()["count"], 0);
    }

    #[test]
    fn ordinary_element_has_uses_actual_descendants_and_excludes_receiver_itself() {
        let mut frame = frame();
        let address = Query::parse(&json!({"selector":"#selected","has":"#child"})).unwrap();
        assert_eq!(query(&frame, &address).unwrap()["count"], 1);
        let self_only = Query::parse(&json!({"selector":"#selected","has":"#selected"})).unwrap();
        assert_eq!(query(&frame, &self_only).unwrap()["count"], 0);
        frame.root.children[0].children[0].event_owner_scope_id = Some("foreign-owner".into());
        assert_eq!(query(&frame, &address).unwrap()["count"], 0);
    }

    #[test]
    fn object_scopes_reject_missing_ambiguous_and_noncomponent_candidates() {
        let mut frame = marker_frame();
        let address =
            Query::parse(&json!({"selector":"#needle","scope":[{"has":"#needle"}]})).unwrap();
        let missing =
            Query::parse(&json!({"selector":"#needle","scope":[{"has":"#missing"}]})).unwrap();
        assert!(query(&frame, &missing).is_err());
        let mut clone = frame.root.children[0].children[0].clone();
        clone.id = "other-host".into();
        clone.component_scope_id = Some("other-runtime".into());
        clone.children[0].event_owner_scope_id = Some("other-runtime".into());
        frame.root.children.push(clone);
        assert!(query(&frame, &address).is_err());
        frame.root.children.pop();
        let host = &mut frame.root.children[0].children[0];
        host.component_scope_id = None;
        host.tag = Some("component".into());
        host.attributes
            .insert("data-sim-scope".into(), "runtime-inner".into());
        assert!(query(&frame, &address).is_err());
        let string = Query::parse(&json!({"selector":"#needle","scope":["#nested"]})).unwrap();
        assert!(query(&frame, &string).is_err());
    }

    #[test]
    fn repeated_runtime_token_and_invalid_component_metadata_fail_closed() {
        for token in ["", " runtime-inner", "runtime-inner\0"] {
            let mut frame = marker_frame();
            frame.root.children[0].children[0].component_scope_id = Some(token.into());
            let address = Query::parse(&json!({"selector":"#needle","scope":["#nested"]})).unwrap();
            assert!(query(&frame, &address).is_err());
        }
        let mut frame = marker_frame();
        let mut duplicate = frame.root.children[0].children[0].clone();
        duplicate.id = "not-the-selected-host".into();
        frame.root.children.push(duplicate);
        let address = Query::parse(&json!({"selector":"#needle","scope":["#nested"]})).unwrap();
        assert!(query(&frame, &address).is_err());
    }

    #[test]
    fn legacy_scope_attribute_alias_cannot_replace_an_actual_component_receiver() {
        let mut frame = marker_frame();
        let mut alias = RenderNode::new("legacy-alias", frame.viewport);
        alias
            .attributes
            .insert("data-sim-scope".into(), "runtime-inner".into());
        let mut fake = RenderNode::new("needle", frame.viewport);
        fake.event_owner_scope_id = Some("runtime-inner".into());
        fake.text = Some("wrong alias".into());
        alias.children.push(fake);
        frame.root.children.insert(0, alias);
        let address =
            Query::parse(&json!({"selector":"#needle","scope":["#foo","#nested"]})).unwrap();
        assert_eq!(
            query_text(&frame, &address).unwrap()["text"],
            "  actual-tree  "
        );
    }

    #[test]
    fn projected_slot_predicates_follow_declaration_owner_instead_of_render_parent() {
        let frame = marker_frame();
        // The projected second increment belongs to outer, though rendered
        // under inner. It can select outer; it cannot select inner.
        let outer =
            Query::parse(&json!({"selector":"#increment","scope":[{"has":"#increment"}]})).unwrap();
        assert!(
            query(&frame, &outer).is_err(),
            "outer and sibling own separate matching descendants"
        );
        let actual =
            Query::parse(&json!({"selector":"#nested","scope":["#foo"],"has":"#increment"}))
                .unwrap();
        assert_eq!(query(&frame, &actual).unwrap()["count"], 0);
        let inherited = Query::parse(&json!({"selector":"#increment","scope":["#foo"]})).unwrap();
        assert_eq!(
            query_text(&frame, &inherited).unwrap()["text"],
            "projected other owner"
        );
        let scoped =
            Query::parse(&json!({"selector":"#needle","scope":["#foo",{"has":"#increment"}]}))
                .unwrap();
        assert!(query(&frame, &scoped).is_err());
    }

    #[test]
    fn has_cannot_adopt_same_owner_nodes_outside_the_actual_receiver_subtree() {
        let mut frame = marker_frame();
        let mut outside = RenderNode::new("outside-marker", frame.viewport);
        outside.event_owner_scope_id = Some("runtime-inner".into());
        frame.root.children.push(outside);
        let query = Query::parse(&json!({"selector":"#nested","has":"#outside-marker"})).unwrap();
        assert_eq!(super::query(&frame, &query).unwrap()["count"], 0);
    }

    #[test]
    fn typed_addresses_reject_unknown_keys_modes_expected_values_and_malformed_predicates() {
        for value in [
            json!({"selector":"#x","has":null}),
            json!({"selector":"#x","has":""}),
            json!({"selector":"#x","has":true}),
            json!({"selector":"#x","has":"#x:has(#y)"}),
            json!({"selector":"#x","count":1}),
            json!({"selector":"#x","expected":"x"}),
            json!({"selector":"#x","query":"xpath"}),
            json!({"selector":"#x","query":null}),
            json!({"selector":"#x","scope":[{}]}),
            json!({"selector":"#x","scope":[{"has":null}]}),
            json!({"selector":"#x","scope":[{"has":"#y","selector":"#z"}]}),
            json!({"selector":"#x","scope":[{"has":"#y","expected":true}]}),
            json!({"selector":"#x","scope":[{"has":"#x:has(#y)"}]}),
            json!({"selector":"#x","scope":[null]}),
            json!({"selector":"#x","op":"query"}),
            json!({"selector":"   "}),
            json!({"selector":"#x\0"}),
            json!(["#x"]),
        ] {
            assert!(
                Query::parse(&value).is_err(),
                "accepted malformed query: {value}"
            );
        }
        let address = Query::parse(&json!({"selector":"#x","query":"css","scope":["#outer",{"has":"#desc"}],"has":"#leaf"})).unwrap();
        assert_eq!(
            address.evidence(),
            json!({"selector":"#x","scope":["#outer",{"has":"#desc"}],"has":"#leaf"})
        );
    }

    #[test]
    fn strict_ipc_projection_preserves_legacy_envelopes_and_typed_query_payloads() {
        let legacy = json!({"id":7,"op":"query","route":"pages/actual/index","selector":"#x","scope":["#outer"]});
        assert_eq!(
            Query::parse_request(&legacy).unwrap().evidence(),
            json!({"selector":"#x","scope":["#outer"]})
        );
        let typed = json!({"id":"q2","op":"query.attribute","route":"pages/actual/index","selector":"#x",
            "scope":[{"has":"#desc"}],"has":"#leaf","name":"data-value"});
        assert_eq!(
            Query::parse_request(&typed).unwrap().evidence(),
            json!({"selector":"#x","scope":[{"has":"#desc"}],"has":"#leaf"})
        );
        for patch in [
            json!({"count":1}),
            json!({"fallback":false}),
            json!({"id":null}),
            json!({"op":"checkpoint"}),
            json!({"route":null}),
            json!({"name":null}),
            json!({"has":null}),
        ] {
            let mut value = legacy.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(
                Query::parse_request(&value).is_err(),
                "accepted malformed IPC query: {value}"
            );
        }
        let mut value = typed;
        value["name"] = json!(" data-value");
        assert!(Query::parse_request(&value).is_err());
    }
    #[test]
    fn count_only_keeps_every_actual_node_without_unrequested_values() {
        let frame = component_frame();
        let query = Query::parse(&json!({"scope":[{"has":"#nested"},"#nested"],"selector":"#increment","fields":{"text":false,"attributes":[]}})).unwrap();
        let actual = checkpoint(&frame, "count", "pages/actual/index", &[query]).unwrap();
        assert_eq!(
            actual["nodes"][0]["scope"],
            json!([{"has":"#nested"},"#nested"])
        );
        assert_eq!(actual["nodes"][0]["count"], 1);
        assert_eq!(actual["nodes"][0]["nodes"], json!([{}]));
        let absent =
            Query::parse(&json!({"selector":"#absent","fields":{"text":false,"attributes":[]}}))
                .unwrap();
        let actual = checkpoint(&frame, "absent", "pages/actual/index", &[absent]).unwrap();
        assert_eq!(actual["nodes"][0]["count"], 0);
        assert_eq!(actual["nodes"][0]["nodes"], json!([]));
    }
}
