//! Internal private-instance data and complete native runtime-log journal.
use super::*;
use container_core::ConformanceGuestObservation as Observation;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(1);
pub(super) fn incarnation() -> Result<String> {
    let next = NEXT
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
        .map_err(|_| "runtime journal incarnation exhausted")?;
    Ok(format!(
        "native-runtime-journal-{}-{}-{next}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ))
}
fn fields(value: &Value, names: &[&str]) -> Result<()> {
    let object = value
        .as_object()
        .ok_or("data/runtime request must be an object")?;
    if object.len() != names.len() || !names.iter().all(|key| object.contains_key(*key)) {
        return Err("data/runtime request fields differ".into());
    }
    Ok(())
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 256 && s.trim() == *s && !s.contains('\0'))
        .ok_or_else(|| format!("invalid data/runtime {key}").into())
}
impl NativeSession {
    fn runtime_owner(&self, owner: &Value) -> Result<()> {
        fields(owner, &["engine", "sessionId", "incarnation"])?;
        let config = self
            .host
            .session()
            .ok_or("runtime journal Session unloaded")?
            .config();
        if owner["engine"] != json!(config.engine)
            || owner["sessionId"] != config.session_id
            || owner["incarnation"] != self.runtime_log_incarnation
        {
            return Err("runtime journal owner differs from native Session incarnation".into());
        }
        Ok(())
    }
    pub fn runtime_logs(&mut self, request: &Value) -> Result<Value> {
        fields(request, &["id", "op", "owner", "reset"])?;
        self.runtime_owner(&request["owner"])?;
        let reset = request["reset"]
            .as_bool()
            .ok_or("runtime journal reset is not boolean")?;
        let turn = self
            .host
            .session_mut()
            .ok_or("runtime journal Session unloaded")?
            .read_conformance_runtime_logs(reset);
        self.record_method_effects("runtime.logs", "native-journal", turn.effects);
        let observed = turn.result?;
        if !matches!(observed, Observation::RuntimeLogs { .. }) {
            return Err("runtime journal returned another outcome".into());
        }
        Ok(
            json!({"kind":"native-runtime-log-snapshot-v1","owner":request["owner"],"reset":reset,"journal":observed}),
        )
    }
    pub fn close_runtime_logs(&mut self, request: &Value) -> Result<Value> {
        fields(request, &["id", "op", "owner"])?;
        self.runtime_owner(&request["owner"])?;
        if self.runtime_log_closed || self.pending_method.is_some() {
            return Err("runtime journal Session is closed or has a pending method".into());
        }
        self.runtime_log_route = Some(self.route()?);
        self.runtime_log_closed = true;
        let turn = self
            .host
            .session_mut()
            .ok_or("runtime journal Session unloaded")?
            .close_conformance_runtime_logs();
        self.record_method_effects("runtime.logs.close", "native-journal", turn.effects);
        let observed = turn.result?;
        if !matches!(observed, Observation::RuntimeLogs { .. }) {
            return Err("runtime journal close returned another outcome".into());
        }
        Ok(
            json!({"kind":"native-runtime-log-snapshot-v1","owner":request["owner"],"closed":true,"journal":observed}),
        )
    }
    pub fn read_data(&mut self, request: &Value) -> Result<Value> {
        fields(
            request,
            &[
                "id", "op", "owner", "route", "pageId", "scopeId", "path", "source",
            ],
        )?;
        self.runtime_owner(&request["owner"])?;
        self.require_presented()?;
        let route = text(request, "route")?.to_owned();
        self.assert_route(&route)?;
        let path = text(request, "path")?.to_owned();
        if !path.bytes().enumerate().all(|(at, c)| {
            c.is_ascii_alphabetic() || c == b'_' || c == b'$' || at > 0 && c.is_ascii_digit()
        }) {
            return Err("data path is outside reviewed flat source profile".into());
        }
        let source = &request["source"];
        fields(source, &["sha256", "callsite"])?;
        if !source["sha256"]
            .as_str()
            .is_some_and(container_ir::is_sha256)
        {
            return Err("data source digest invalid".into());
        }
        text(source, "callsite")?;
        let scope = if request["scopeId"].is_null() {
            None
        } else {
            Some(text(request, "scopeId")?.to_owned())
        };
        let acquired = self
            .host
            .session_mut()
            .ok_or("data Session unloaded")?
            .acquire_conformance_page(&route);
        self.record_method_effects("data.acquire", "native-data", acquired.effects);
        let binding = acquired.result?;
        if request["pageId"] != binding.page_id().0.to_string() {
            return Err("data read belongs to another Page incarnation".into());
        }
        let turn = self
            .host
            .session_mut()
            .ok_or("data Session unloaded")?
            .read_conformance_data(&binding, scope.clone(), path.clone());
        self.record_method_effects("data.read", "native-data", turn.effects);
        let observed = turn.result?;
        let (value, receiver_token) = match observed {
            Observation::Data {
                value,
                receiver_token,
            } => (value, receiver_token),
            _ => return Err("data read returned another outcome".into()),
        };
        Ok(
            json!({"kind":"native-private-receiver-data-v1","owner":request["owner"],"route":route,"pageId":binding.page_id().0.to_string(),
            "scopeId":scope,"path":path,"source":source,"receiverTokenSha256":hex_digest(receiver_token.as_bytes()),"value":value,"completion":self.completion()?}),
        )
    }
}

#[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
mod tests {
    use super::*;
    #[test]
    fn native_journal_owner_is_actual_and_available_without_any_presentation_claim() {
        for engine in [
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ] {
            let pack = Pack::read(
                &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../conformance/recipes/fixtures/issue1058"),
            )
            .unwrap();
            let mut native = NativeSession::new_with_render_mode(
                pack,
                engine,
                "native-journal-local-contract".into(),
                375,
                667,
                PageRenderMode::Raster,
            )
            .unwrap();
            let owner = json!({"engine":engine,"sessionId":native.session_id,"incarnation":native.runtime_log_incarnation});
            let request =
                json!({"id":"journal-source","op":"runtime.logs","owner":owner,"reset":false});
            for field in ["engine", "sessionId", "incarnation"] {
                let mut changed = request.clone();
                changed["owner"][field] = json!("foreign");
                assert!(native.runtime_logs(&changed).is_err());
            }
            let actual = native.runtime_logs(&request).unwrap();
            assert_eq!(actual["owner"], owner);
            assert_eq!(actual["journal"]["complete"], true);
            assert_eq!(actual["journal"]["overflow"], false);
            assert_eq!(native.acknowledged_revision, 0);
            assert!(!native.stable());
            let mut reset = request.clone();
            reset["id"] = json!("journal-reset");
            reset["reset"] = json!(true);
            let result = native.runtime_logs(&reset).unwrap();
            assert_eq!(result["journal"]["generation"], 1);
            assert_eq!(
                result["journal"]["resetCursor"],
                result["journal"]["endCursor"]
            );
            let closing = json!({"id":"journal-close","op":"runtime.logs.close","owner":owner});
            let terminal = native.close_runtime_logs(&closing).unwrap();
            assert_eq!(terminal["closed"], true);
            assert_eq!(terminal["journal"]["complete"], true);
            assert!(native.exception_closed());
            assert!(native.inspection_route().is_ok());
            assert!(native.close_runtime_logs(&closing).is_err());
            native.host.unload();
            assert!(!native.host.has_session());
        }
    }
}
