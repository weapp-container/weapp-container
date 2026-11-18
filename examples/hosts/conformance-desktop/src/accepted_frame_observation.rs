//! Default-off, versioned internal projection of one actual accepted frame.
//! No VM calls, rendering, layout, capture, public-id receiver lookup or SDK claim.
use crate::{observation, pack::Result};
use container_core::EngineKind;
use container_ir::hex_digest;
use container_render_skia::{
    DisplayMode, FlexDirection, FlexWrap, FormattingContext, RenderFrame, RenderNode,
    RenderNodeGeometry, Visibility,
};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeSet, HashMap},
    io::Read,
};

pub const FIELDS: [&str; 7] = [
    "computed.display",
    "computed.flex-direction",
    "computed.flex-wrap",
    "computed.opacity",
    "computed.visibility",
    "size.viewport-border-aabb.v1",
    "offset.viewport-border-aabb.v1",
];
const OBSERVE: &str = "accepted-frame.observe.v1";
const CAPABILITIES: &str = "accepted-frame.capabilities.v1";
const MAX_RESULTS: usize = 4096;

pub(crate) struct Observer {
    seed: [u8; 32],
    instance: String,
}

/// Pure, process-local index over exactly one accepted frame. Both read-only
/// observation and explicit input preparation use the same opaque token rules.
pub(crate) struct NodeBindings<'a> {
    pub owner: Value,
    pub geometries: Vec<RenderNodeGeometry<'a>>,
    by_node: HashMap<*const RenderNode, usize>,
    tokens: Vec<String>,
    by_token: HashMap<String, usize>,
}
impl<'a> NodeBindings<'a> {
    pub fn resolve(&self, handle: &Value) -> Result<&'a RenderNode> {
        Ok(self.geometries[Observer::resolve(handle, &self.owner, &self.by_token)?].node)
    }
    pub fn node(&self, node: &'a RenderNode) -> Result<Value> {
        let index = *self
            .by_node
            .get(&(node as *const _))
            .ok_or("node is outside the actual accepted tree")?;
        let geometry = &self.geometries[index];
        Ok(
            json!({"handle":Observer::handle(&self.owner, &self.tokens[index]),
            "parent":geometry.parent.map(|parent| Observer::handle(&self.owner, &self.tokens[parent])),
            "metadata":{"id":node.id,"publicId":node.attributes.get("id"),"tag":node.tag,
                "eventIdentity":node.event_identity,"componentScopeId":node.component_scope_id,
                "eventOwnerScopeId":node.event_owner_scope_id}}),
        )
    }
}

pub(crate) struct Request {
    pub route: String,
    target: Value,
    address: Address,
    fields: Vec<String>,
}
enum Address {
    Query(observation::Query),
    Node(Value),
    Parent(Value, observation::Query),
}

fn exact(value: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let object = value.as_object().ok_or("observer object required")?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err("observer object has missing or unsupported fields".into());
    }
    Ok(())
}
fn envelope(value: &Value, operation: &str, keys: &[&str]) -> Result<()> {
    let mut required = vec!["id", "op", "version"];
    required.extend_from_slice(keys);
    exact(value, &required, &[])?;
    if !value["id"].is_string() && !value["id"].is_u64() {
        return Err("observer IPC needs id".into());
    }
    if value["op"] != operation || value["version"].as_u64() != Some(1) {
        return Err("observer IPC operation/version unsupported".into());
    }
    Ok(())
}
pub(crate) fn parse_capabilities(value: &Value) -> Result<()> {
    envelope(value, CAPABILITIES, &[])
}
impl Request {
    pub fn parse(value: &Value) -> Result<Self> {
        envelope(value, OBSERVE, &["route", "target", "fields"])?;
        let route = value["route"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.trim() == *s
                    && !s.contains(['\\', '?', '#', '\0'])
                    && s.split('/')
                        .all(|part| !part.is_empty() && part != "." && part != "..")
            })
            .ok_or("observer route must be canonical")?
            .to_owned();
        let fields = value["fields"]
            .as_array()
            .ok_or("observer fields must be names")?;
        if fields.is_empty() || fields.len() > FIELDS.len() {
            return Err("observer fields must select one or more supported names".into());
        }
        let mut seen = BTreeSet::new();
        let fields = fields
            .iter()
            .map(|value| {
                let field = value
                    .as_str()
                    .filter(|field| FIELDS.contains(field))
                    .ok_or("observer field is unsupported")?;
                if !seen.insert(field) {
                    return Err("observer field names must be unique".into());
                }
                Ok(field.to_owned())
            })
            .collect::<Result<Vec<_>>>()?;
        let target = value["target"].clone();
        let object = target
            .as_object()
            .ok_or("observer target must be an address")?;
        let address = if object.contains_key("node") {
            exact(&target, &["node"], &[])?;
            Address::Node(target["node"].clone())
        } else if object.contains_key("parent") {
            exact(&target, &["parent", "selector"], &["has"])?;
            let mut query = target.clone();
            query.as_object_mut().unwrap().remove("parent");
            Address::Parent(target["parent"].clone(), observation::Query::parse(&query)?)
        } else {
            exact(&target, &["query"], &[])?;
            // Versioned address requires an object; legacy Fields are unchanged
            // and cannot be smuggled into this independent typed selector list.
            exact(&target["query"], &["selector"], &["scope", "has", "query"])?;
            Address::Query(observation::Query::parse(&target["query"])?)
        };
        Ok(Self {
            route,
            target,
            address,
            fields,
        })
    }
}

impl Observer {
    pub fn new() -> Result<Self> {
        let mut seed = [0; 32];
        // Native hosts are Unix. Failure to acquire a fresh instance nonce is
        // explicit; process/session/public ids are not uniqueness substitutes.
        std::fs::File::open("/dev/urandom")?.read_exact(&mut seed)?;
        Ok(Self::from_seed(seed))
    }
    fn from_seed(seed: [u8; 32]) -> Self {
        let mut bytes = b"accepted-frame-session-instance-v1\0".to_vec();
        bytes.extend_from_slice(&seed);
        Self {
            seed,
            instance: hex_digest(&bytes),
        }
    }
    pub fn capability(&self, engine: EngineKind, session_id: &str) -> Value {
        json!({"kind":"accepted-frame-observation-capabilities-v1","version":1,
            "engine":engine,"sessionId":session_id,"sessionInstance":self.instance,
            "operations":[OBSERVE],"fields":FIELDS})
    }
    fn owner(&self, engine: EngineKind, completion: &Value) -> Result<Value> {
        for key in [
            "sessionId",
            "route",
            "pageId",
            "templateRevision",
            "frameId",
            "renderRevision",
        ] {
            if !completion[key].is_string() {
                return Err("observer owner lacks an actual completion identity".into());
            }
        }
        Ok(
            json!({"kind":"accepted-frame-owner-v1","sessionId":completion["sessionId"],
            "sessionInstance":self.instance,"engine":engine,"route":completion["route"],
            "pageId":completion["pageId"],"templateRevision":completion["templateRevision"],
            "frameId":completion["frameId"],"renderRevision":completion["renderRevision"]}),
        )
    }
    fn handle(owner: &Value, token: &str) -> Value {
        json!({"kind":"accepted-frame-node-v1","owner":owner,"token":token})
    }
    fn resolve(handle: &Value, owner: &Value, tokens: &HashMap<String, usize>) -> Result<usize> {
        exact(handle, &["kind", "owner", "token"], &[])?;
        if handle["kind"] != "accepted-frame-node-v1" || handle["owner"] != *owner {
            return Err("node handle belongs to another actual accepted frame owner".into());
        }
        handle["token"]
            .as_str()
            .and_then(|token| tokens.get(token))
            .copied()
            .ok_or_else(|| "node handle is unknown to this actual accepted tree".into())
    }
    pub(crate) fn bindings<'a>(
        &self,
        frame: &'a RenderFrame,
        engine: EngineKind,
        completion: &Value,
    ) -> Result<NodeBindings<'a>> {
        if completion["frameId"] != frame.frame_id.to_string() {
            return Err("node binding frame differs from its actual completion".into());
        }
        let owner = self.owner(engine, completion)?;
        let geometries = frame.node_geometries();
        let by_node: HashMap<_, _> = geometries
            .iter()
            .enumerate()
            .map(|(index, geometry)| (geometry.node as *const _, index))
            .collect();
        let mut prefix = b"accepted-frame-node-token-v1\0".to_vec();
        prefix.extend_from_slice(&self.seed);
        prefix.extend_from_slice(&serde_json::to_vec(&owner)?);
        let mut tokens = Vec::with_capacity(geometries.len());
        for index in 0..geometries.len() {
            prefix.extend_from_slice(&(index as u64).to_be_bytes());
            tokens.push(hex_digest(&prefix));
            prefix.truncate(prefix.len() - 8);
        }
        let by_token = tokens
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, token)| (token, index))
            .collect();
        Ok(NodeBindings {
            owner,
            geometries,
            by_node,
            tokens,
            by_token,
        })
    }
    // Callers must establish their presentation/owner barrier before this pure
    // frame reader. Local raster tests use this function without asserting UI.
    pub fn observe(
        &self,
        frame: &RenderFrame,
        engine: EngineKind,
        completion: Value,
        request: &Request,
    ) -> Result<Value> {
        if completion["route"] != request.route
            || completion["frameId"] != frame.frame_id.to_string()
        {
            return Err("observer frame/route differs from its actual completion".into());
        }
        let binding = self.bindings(frame, engine, &completion)?;
        let owner = &binding.owner;
        let nodes = match &request.address {
            Address::Query(query) => observation::matches_from(frame, query, None)?,
            Address::Node(handle) => {
                vec![binding.resolve(handle)?]
            }
            Address::Parent(handle, query) => {
                let receiver = binding.resolve(handle)?;
                observation::matches_from(frame, query, Some(receiver))?
            }
        };
        if nodes.len() > MAX_RESULTS {
            return Err("observer selected more than 4096 actual nodes".into());
        }
        let mut output = Vec::with_capacity(nodes.len());
        for node in nodes {
            let index = *binding
                .by_node
                .get(&(node as *const _))
                .ok_or("selector returned a node outside the actual accepted tree")?;
            let geometry = &binding.geometries[index];
            let mut values = Map::new();
            for field in &request.fields {
                values.insert(field.clone(), project(frame, geometry, field)?);
            }
            output.push(json!({"handle":Self::handle(owner, &binding.tokens[index]),
                "parent":geometry.parent.map(|parent| Self::handle(owner, &binding.tokens[parent])),
                "metadata":{"id":node.id,"publicId":node.attributes.get("id"),"tag":node.tag,"eventIdentity":node.event_identity,
                    "componentScopeId":node.component_scope_id,"eventOwnerScopeId":node.event_owner_scope_id},
                "values":values}));
        }
        Ok(
            json!({"kind":"accepted-frame-observation-v1","version":1,"owner":owner,
            "target":request.target,"fields":request.fields,"count":output.len(),"nodes":output,
            "completion":completion}),
        )
    }
}
fn project(frame: &RenderFrame, geometry: &RenderNodeGeometry<'_>, field: &str) -> Result<Value> {
    let node = geometry.node;
    let style = node
        .style
        .as_ref()
        .ok_or("requested field is unsupported on legacy node")?;
    let flow = style
        .flow
        .as_ref()
        .ok_or("requested field requires typed computed state")?;
    Ok(match field {
        "computed.display" => json!(match (style.display, flow.context) {
            (DisplayMode::None, _) => "none",
            (_, FormattingContext::Block) => "block",
            (_, FormattingContext::Flex) => "flex",
        }),
        "computed.flex-direction" => {
            let actual = node
                .computed_style
                .get("flex-direction")
                .map(String::as_str);
            let direction = match actual {
                Some("row") => FlexDirection::Row,
                Some("row-reverse") => FlexDirection::RowReverse,
                Some("column") => FlexDirection::Column,
                Some("column-reverse") => FlexDirection::ColumnReverse,
                _ => {
                    return Err(
                        "accepted normalized computed flex-direction is missing or unsupported"
                            .into(),
                    )
                }
            };
            if flow.context == FormattingContext::Flex && direction != style.direction {
                return Err(
                    "accepted computed flex-direction differs from Flex layout direction".into(),
                );
            }
            json!(actual.unwrap())
        }
        "computed.flex-wrap" => {
            let actual = node.computed_style.get("flex-wrap").map(String::as_str);
            let wrap = match actual {
                Some("nowrap") => FlexWrap::NoWrap,
                Some("wrap") => FlexWrap::Wrap,
                Some("wrap-reverse") => FlexWrap::WrapReverse,
                _ => {
                    return Err(
                        "accepted normalized computed flex-wrap is missing or unsupported".into(),
                    )
                }
            };
            if wrap != flow.wrap {
                return Err("accepted computed flex-wrap differs from typed flow state".into());
            }
            json!(actual.unwrap())
        }
        "computed.opacity" => {
            if !node.opacity.is_finite() || !(0.0..=1.0).contains(&node.opacity) {
                return Err("accepted local opacity is invalid".into());
            }
            json!(node.opacity)
        }
        "computed.visibility" => {
            let actual = match node.visibility {
                Visibility::Visible => "visible",
                Visibility::Hidden => "hidden",
            };
            if node.computed_style.get("visibility").map(String::as_str) != Some(actual) {
                return Err("accepted resolved visibility is missing or inconsistent".into());
            }
            json!(actual)
        }
        "size.viewport-border-aabb.v1" | "offset.viewport-border-aabb.v1" => {
            if frame
                .root
                .style
                .as_ref()
                .and_then(|style| style.flow.as_ref())
                .is_none()
            {
                return Err("viewport AABB semantics require a typed accepted frame".into());
            }
            let b = geometry.bounds;
            if ![b.x, b.y, b.width, b.height].iter().all(|v| v.is_finite())
                || b.width < 0.0
                || b.height < 0.0
            {
                return Err("accepted world geometry is invalid".into());
            }
            let mut value = json!({"coordinateSpace":"viewport-css-px","box":"transformed-border-aabb",
                "clipped":false,"width":b.width,"height":b.height});
            if field.starts_with("offset.") {
                value["left"] = json!(b.x);
                value["top"] = json!(b.y);
            }
            value
        }
        _ => return Err("observer field is unsupported".into()),
    })
}

#[cfg(test)]
#[path = "accepted_frame_observation_tests.rs"]
mod tests;
