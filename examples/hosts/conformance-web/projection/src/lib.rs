//! Pure query projection; this module cannot acknowledge a frame or mint provenance.
use container_render_skia::RenderFrame;
use serde_json::{json, Value};

mod pack {
    pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
}
// Compile the exact shared native implementation, including its component
// ownership and hit-test tests. No second JavaScript selector implementation.
#[path = "../../../../../examples/hosts/conformance-desktop/src/observation.rs"]
mod observation;

fn project(frame: &RenderFrame, request: &Value) -> pack::Result<Value> {
    let object = request.as_object().ok_or("projection request must be an object")?;
    if object.contains_key("id") {
        return Err("projection caller cannot supply transport correlation fields".into());
    }
    let op = request["op"].as_str().ok_or("projection request needs op")?;
    let route = request["route"].as_str().filter(|value| !value.is_empty()).ok_or("projection request needs actual route")?;
    let mut value = if op == "checkpoint" {
        if object.keys().any(|key| !matches!(key.as_str(), "op" | "route" | "checkpoint" | "selectors")) {
            return Err("checkpoint contains an unsupported field".into());
        }
        let id = request["checkpoint"].as_str().filter(|value| !value.is_empty()).ok_or("checkpoint needs id")?;
        let selectors = request["selectors"].as_array().filter(|values| !values.is_empty() && values.len() <= 256).ok_or("checkpoint needs bounded selectors")?;
        let queries = selectors.iter().map(observation::Query::parse).collect::<pack::Result<Vec<_>>>()?;
        observation::checkpoint(frame, id, route, &queries)?
    } else {
        let mut address = object.clone();
        address.insert("id".into(), json!("web-projection"));
        let query = observation::Query::parse_request(&Value::Object(address))?;
        match op {
            "query" => observation::query(frame, &query)?,
            "query.text" => observation::query_text(frame, &query)?,
            "query.attribute" => observation::query_attribute(frame, &query, request["name"].as_str().ok_or("attribute needs name")?)?,
            "tap" => {
                let (x, y) = observation::tap_point(frame, &query)?;
                let mut value = query.evidence();
                value["point"] = json!({ "x": x, "y": y });
                value
            }
            _ => return Err("unsupported projection operation".into()),
        }
    };
    value["route"] = json!(route);
    Ok(value)
}

/// Caller supplies an actual privately retained frame. This pure function also
/// accepts synthetic data in unit tests; its output alone is never a receipt.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn project_frame_json(frame_json: &str, request_json: &str) -> String {
    let result = (|| -> pack::Result<Value> {
        if frame_json.len() > 16 * 1024 * 1024 || request_json.len() > 64 * 1024 {
            return Err("projection input exceeds bounded data limit".into());
        }
        project(&serde_json::from_str(frame_json)?, &serde_json::from_str(request_json)?)
    })();
    match result {
        Ok(value) => json!({ "status": "ok", "result": value }).to_string(),
        Err(error) => json!({ "status": "error", "message": error.to_string() }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_frames_and_expected_fields_are_not_observations() {
        assert_eq!(serde_json::from_str::<Value>(&project_frame_json("{}", r##"{"op":"query","route":"a","selector":"#x"}"##)).unwrap()["status"], "error");
        // Query parsing tests in the exact included observation module also
        // reject expected text/count and test scope tokens against real trees.
        assert!(observation::Query::parse(&json!({"selector":"#x", "text":"expected"})).is_err());
    }
}
