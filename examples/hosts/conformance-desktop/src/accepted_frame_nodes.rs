//! Default-off opaque acquisition/input protocol. No source expectations or
//! public-id target lookup. Resolution and geometry preparation are pure; the
//! Session owns the sole coordinate dispatch and owner-pump publication barrier.
use crate::{accepted_frame_observation::Observer, observation, pack::Result};
use container_core::EngineKind;
use container_render_skia::RenderFrame;
use serde_json::{json, Value};

pub const CAPABILITIES: &str = "accepted-frame.nodes.capabilities.v1";
pub const ACQUIRE: &str = "accepted-frame.nodes.acquire.v1";
pub const TAP: &str = "accepted-frame.nodes.tap.v1";
const MAX_MATCHES: usize = 4096;

fn exact(value: &Value, keys: &[&str]) -> Result<()> {
    let object = value.as_object().ok_or("node IPC object required")?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err("node IPC has unknown or missing fields".into());
    }
    Ok(())
}
fn envelope(value: &Value, op: &str, fields: &[&str]) -> Result<()> {
    let mut keys = vec!["id", "op", "version"];
    keys.extend_from_slice(fields);
    exact(value, &keys)?;
    if value["op"] != op
        || value["version"].as_u64() != Some(1)
        || !value["id"].is_string() && !value["id"].is_u64()
    {
        return Err("node IPC operation/version/id unsupported".into());
    }
    Ok(())
}
fn route(value: &Value) -> Result<String> {
    value
        .as_str()
        .filter(|route| {
            !route.is_empty()
                && route.trim() == *route
                && !route.contains(['\\', '?', '#', '\0'])
                && route
                    .split('/')
                    .all(|part| !part.is_empty() && part != "." && part != "..")
        })
        .map(str::to_owned)
        .ok_or_else(|| "node IPC route is not canonical".into())
}
pub fn parse_capabilities(value: &Value) -> Result<()> {
    envelope(value, CAPABILITIES, &[])
}
pub fn capability(observer: &Observer, engine: EngineKind, session_id: &str) -> Value {
    let source = observer.capability(engine, session_id);
    json!({"kind":"accepted-frame-node-capabilities-v1","version":1,
        "engine":engine,"sessionId":session_id,"sessionInstance":source["sessionInstance"],
        "operations":[ACQUIRE,TAP],"selection":["first","all"],
        "inputTransport":"native-host-coordinate-event"})
}
pub struct AcquireRequest {
    pub route: String,
    target: Value,
    query: observation::Query,
    parent: Option<Value>,
    first: bool,
}
impl AcquireRequest {
    pub fn parse(value: &Value) -> Result<Self> {
        envelope(value, ACQUIRE, &["route", "target", "selection"])?;
        let first = match value["selection"].as_str() {
            Some("first") => true,
            Some("all") => false,
            _ => return Err("node acquisition selection must be first or all".into()),
        };
        let target = value["target"].clone();
        let (parent, query) = if target.get("parent").is_some() {
            let object = target
                .as_object()
                .ok_or("node parent query must be object")?;
            if object
                .keys()
                .any(|key| !matches!(key.as_str(), "parent" | "selector" | "has"))
                || !object.contains_key("selector")
            {
                return Err("node parent query accepts only handle, selector and has".into());
            }
            let mut address = object.clone();
            address.remove("parent");
            (
                Some(target["parent"].clone()),
                observation::Query::parse(&Value::Object(address))?,
            )
        } else {
            exact(&target, &["query"])?;
            let object = target["query"]
                .as_object()
                .ok_or("node query must be explicit object")?;
            if object
                .keys()
                .any(|key| !matches!(key.as_str(), "selector" | "scope" | "has" | "query"))
            {
                return Err("node acquisition has unsupported query address field".into());
            }
            (None, observation::Query::parse(&target["query"])?)
        };
        if query.fields.is_some() {
            return Err("node acquisition cannot select checkpoint fields".into());
        }
        Ok(Self {
            route: route(&value["route"])?,
            target,
            query,
            parent,
            first,
        })
    }
}
pub struct TapRequest {
    pub route: String,
    node: Value,
}
impl TapRequest {
    pub fn parse(value: &Value) -> Result<Self> {
        envelope(value, TAP, &["route", "node"])?;
        Ok(Self {
            route: route(&value["route"])?,
            node: value["node"].clone(),
        })
    }
}
fn same_route(completion: &Value, route: &str) -> Result<()> {
    if completion["route"] != route {
        return Err("node operation belongs to another actual Page route".into());
    }
    Ok(())
}
pub fn acquire(
    observer: &Observer,
    frame: &RenderFrame,
    engine: EngineKind,
    completion: Value,
    request: &AcquireRequest,
) -> Result<Value> {
    same_route(&completion, &request.route)?;
    let bindings = observer.bindings(frame, engine, &completion)?;
    let parent = request
        .parent
        .as_ref()
        .map(|handle| bindings.resolve(handle))
        .transpose()?;
    let matches = observation::matches_from(frame, &request.query, parent)?;
    if matches.len() > MAX_MATCHES {
        return Err("node acquisition exceeds 4096 actual matches".into());
    }
    let selected = if request.first {
        &matches[..matches.len().min(1)]
    } else {
        &matches[..]
    };
    let nodes = selected
        .iter()
        .map(|node| bindings.node(node))
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"kind":"accepted-frame-node-acquisition-v1","version":1,
        "owner":bindings.owner,"target":request.target,"selection":if request.first {"first"} else {"all"},
        "matchCount":matches.len(),"count":nodes.len(),"nodes":nodes,"completion":completion}),
    )
}
pub struct PreparedTap {
    pub x: f32,
    pub y: f32,
    pub proof: Value,
}
pub fn prepare_tap(
    observer: &Observer,
    frame: &RenderFrame,
    engine: EngineKind,
    completion: Value,
    request: &TapRequest,
) -> Result<PreparedTap> {
    same_route(&completion, &request.route)?;
    let bindings = observer.bindings(frame, engine, &completion)?;
    let node = bindings.resolve(&request.node)?;
    let (x, y) = observation::tap_point_for_node(frame, node)?;
    let proof = json!({"kind":"accepted-frame-node-tap-v1","version":1,
        "route":request.route,"node":request.node,"owner":bindings.owner,
        "x":x,"y":y,"frameId":completion["frameId"],"renderRevision":completion["renderRevision"],
        "inputTransport":"native-host-coordinate-event","inputCompletion":completion});
    Ok(PreparedTap { x, y, proof })
}

#[cfg(test)]
#[path = "accepted_frame_nodes_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "accepted_frame_nodes_native_tests.rs"]
mod native_tests;
