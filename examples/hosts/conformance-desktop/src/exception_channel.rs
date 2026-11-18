//! One optional terminal interval on the actual NativeSession. Caller source
//! labels remain declarations; engine/session/incarnation and cursor are native.
use super::*;
use container_core::ConformanceExceptionObservation;
use container_runtime::ConformanceExceptionCapture;
use std::sync::atomic::{AtomicU64, Ordering};
static INCARNATION: AtomicU64 = AtomicU64::new(1);

pub(super) struct State {
    pub incarnation: String,
    owner: Option<Value>,
    capture: Option<ConformanceExceptionCapture>,
    pub closed: bool,
    pub route: Option<String>,
}
impl State {
    pub fn new() -> Result<Self> {
        let seq = INCARNATION
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
            .map_err(|_| "exception incarnation namespace exhausted")?;
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        Ok(Self {
            incarnation: format!("native-exceptions-{}-{epoch}-{seq}", std::process::id()),
            owner: None,
            capture: None,
            closed: false,
            route: None,
        })
    }
}
fn fields(value: &Value, expected: &[&str]) -> Result<()> {
    let object = value
        .as_object()
        .ok_or("exception protocol value must be an object")?;
    if object.len() != expected.len() || !expected.iter().all(|key| object.contains_key(*key)) {
        return Err("exception protocol fields differ".into());
    }
    Ok(())
}
fn canonical(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.len() <= 256 && s.trim() == s && !s.contains('\0'))
}
fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
impl NativeSession {
    fn exception_owner(&self, owner: &Value) -> Result<()> {
        fields(owner, &["engine", "sessionId", "incarnation", "source"])?;
        let config = self
            .host
            .session()
            .ok_or("exception Session unloaded")?
            .config();
        if config.engine != self.engine
            || config.session_id != self.session_id
            || owner["engine"] != json!(config.engine)
            || owner["sessionId"] != config.session_id
            || owner["incarnation"] != self.exceptions.incarnation
        {
            return Err(
                "exception owner engine/session/incarnation differs from actual native Session"
                    .into(),
            );
        }
        let source = &owner["source"];
        fields(
            source,
            &[
                "sourceSha256",
                "event",
                "messageField",
                "subscribeCallsite",
                "assertCallsite",
                "closeCallsite",
                "helperSha256",
            ],
        )?;
        if source["event"] != "exception"
            || source["messageField"] != "message"
            || !digest(&source["sourceSha256"])
            || !digest(&source["helperSha256"])
            || !["subscribeCallsite", "assertCallsite", "closeCallsite"]
                .iter()
                .all(|key| canonical(&source[*key]))
        {
            return Err("exception source declaration is malformed".into());
        }
        Ok(())
    }
    pub fn begin_exceptions(&mut self, request: &Value) -> Result<Value> {
        fields(
            request,
            &["id", "op", "owner", "maxEvents", "maxMessageBytes"],
        )?;
        self.exception_owner(&request["owner"])?;
        if request["op"] != "exceptions.begin"
            || request["maxEvents"] != 256
            || request["maxMessageBytes"] != 65536
            || self.exceptions.owner.is_some()
            || self.exceptions.closed
            || self.pending_method.is_some()
        {
            return Err(
                "exception begin is duplicate, stale, pending or outside fixed bounds".into(),
            );
        }
        self.exceptions.owner = Some(request["owner"].clone());
        let turn = self
            .host
            .session_mut()
            .ok_or("exception Session unloaded")?
            .begin_conformance_exceptions();
        self.transcript
            .push(json!({"source":"native-exceptions-begin-effects","response":turn.effects}));
        let capture = turn.result?;
        let token = format!("{}:{}", self.exceptions.incarnation, capture.token());
        let result = json!({"kind":"native-exception-channel-begin-v1","owner":self.exceptions.owner,"token":token,"startCursor":capture.start_cursor()});
        self.exceptions.capture = Some(capture);
        Ok(result)
    }
    pub fn end_exceptions(&mut self, request: &Value) -> Result<Value> {
        fields(request, &["id", "op", "owner", "token", "startCursor"])?;
        self.exception_owner(&request["owner"])?;
        let capture = self
            .exceptions
            .capture
            .as_ref()
            .ok_or("exception interval has no successful native begin")?;
        let token = format!("{}:{}", self.exceptions.incarnation, capture.token());
        if request["op"] != "exceptions.end"
            || self.exceptions.owner.as_ref() != Some(&request["owner"])
            || request["token"] != token
            || request["startCursor"].as_u64() != Some(capture.start_cursor())
            || self.exceptions.closed
            || self.pending_method.is_some()
        {
            return Err("exception end owner/token/cursor is stale, pending or substituted".into());
        }
        self.exceptions.route = Some(self.route()?);
        self.exceptions.closed = true;
        let capture = capture.clone();
        let turn = self
            .host
            .session_mut()
            .ok_or("exception Session unloaded")?
            .close_conformance_exceptions(&capture);
        self.transcript.push(
            json!({"source":"native-exceptions-terminal-close-effects","response":turn.effects}),
        );
        match turn.result? {
            ConformanceExceptionObservation::Ended {
                start_cursor,
                end_cursor,
                events,
                complete,
                overflow,
                ..
            } => Ok(json!({
                "kind":"native-exception-channel-end-v1","owner":self.exceptions.owner,"token":token,"startCursor":start_cursor,
                "endCursor":end_cursor,"events":events,"complete":complete,"overflow":overflow })),
            _ => Err("exception close returned an unexpected observation".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn engines() -> Vec<EngineKind> {
        vec![
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ]
    }
    fn fixture(engine: EngineKind) -> NativeSession {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../conformance/recipes/fixtures/issue1058");
        NativeSession::new_with_render_mode(
            Pack::read(&root).unwrap(),
            engine,
            "native-exception-cpu-only".into(),
            375,
            667,
            PageRenderMode::Raster,
        )
        .unwrap()
    }
    fn begin(native: &NativeSession) -> Value {
        json!({"id":1,"op":"exceptions.begin","maxEvents":256,"maxMessageBytes":65536,"owner":{
        "engine":native.engine,"sessionId":native.session_id,"incarnation":native.exceptions.incarnation,"source":{
            "sourceSha256":"a".repeat(64),"event":"exception","messageField":"message","subscribeCallsite":"local-cpu-only:1",
            "assertCallsite":"local-cpu-only:2","closeCallsite":"local-cpu-only:3","helperSha256":"b".repeat(64)}}})
    }
    fn end(begun: &Value) -> Value {
        json!({"id":2,"op":"exceptions.end","owner":begun["owner"],"token":begun["token"],"startCursor":begun["startCursor"]})
    }
    #[test]
    fn actual_cpu_session_has_complete_terminal_interval_and_no_reentry() {
        for engine in engines() {
            let mut native = fixture(engine);
            // The regular desktop constructor uses this same default policy.
            // Raster changes presentation only, never AppService limits.
            assert_eq!(
                native.host.session().unwrap().config().engine_execution,
                container_runtime::EngineExecutionPolicy::default()
            );
            let route = native.route().unwrap();
            let request = begin(&native);
            let begun = native.begin_exceptions(&request).unwrap();
            let ended = native.end_exceptions(&end(&begun)).unwrap();
            assert_eq!(ended["complete"], true);
            assert_eq!(ended["overflow"], false);
            assert_eq!(ended["events"], json!([]));
            assert_eq!(ended["owner"], request["owner"]);
            assert!(native.exception_closed());
            assert_eq!(native.inspection_route().unwrap(), route);
            assert!(native.current_page().is_err());
            assert!(native.end_exceptions(&end(&begun)).is_err());
            assert!(native.begin_exceptions(&request).is_err());
            native.pump(1).unwrap();
            assert_eq!(
                native
                    .host
                    .session()
                    .unwrap()
                    .app_service()
                    .lifecycle()
                    .state(),
                container_core::LifecycleState::Destroyed
            );
        }
    }
    #[test]
    fn begin_rejects_foreign_engine_session_incarnation_and_bounds_before_mutation() {
        for engine in engines() {
            for field in [
                "engine",
                "sessionId",
                "incarnation",
                "maxEvents",
                "maxMessageBytes",
                "sourceSha256",
            ] {
                let mut native = fixture(engine);
                let mut request = begin(&native);
                match field {
                    "engine" => request["owner"]["engine"] = json!("other-engine"),
                    "sessionId" => request["owner"]["sessionId"] = json!("other-session"),
                    "incarnation" => request["owner"]["incarnation"] = json!("other-incarnation"),
                    "sourceSha256" => request["owner"]["source"]["sourceSha256"] = json!("wrong"),
                    key => request[key] = json!(1),
                };
                assert!(native.begin_exceptions(&request).is_err(), "{field}");
                assert!(native.exceptions.owner.is_none());
                assert!(!native.exception_closed());
            }
        }
    }
    #[test]
    fn end_rejects_owner_token_and_cursor_substitution_without_closing_the_live_session() {
        for engine in engines() {
            let mut native = fixture(engine);
            let request = begin(&native);
            let begun = native.begin_exceptions(&request).unwrap();
            for key in ["incarnation", "token", "startCursor"] {
                let mut close = end(&begun);
                if key == "incarnation" {
                    close["owner"][key] = json!("other")
                } else {
                    close[key] = json!(1)
                };
                assert!(native.end_exceptions(&close).is_err());
                assert!(!native.exception_closed());
            }
            assert_eq!(
                native.end_exceptions(&end(&begun)).unwrap()["complete"],
                true
            );
        }
    }
    #[test]
    fn identical_text_session_ids_still_have_distinct_native_incarnations() {
        for engine in engines() {
            let first = fixture(engine);
            let mut second = fixture(engine);
            assert_ne!(first.exceptions.incarnation, second.exceptions.incarnation);
            assert!(second.begin_exceptions(&begin(&first)).is_err());
            assert!(second.exceptions.owner.is_none());
        }
    }
}
