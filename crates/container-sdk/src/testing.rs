//! Test-only control over the production session. No executable strings cross
//! this boundary, and normal SDK distributions expose none of these commands.
use super::*;
use container_core::PageId;
use container_render_skia::RenderNode;

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TestOptions {
    pub now_ms: u64,
    pub turn_timeout_ms: u64,
    pub bootstrap_timeout_ms: u64,
    pub apis: Vec<String>,
    pub sync_values: BTreeMap<String, Value>,
}
impl Default for TestOptions {
    fn default() -> Self {
        Self {
            now_ms: 1_700_000_000_000,
            turn_timeout_ms: 1000,
            bootstrap_timeout_ms: 5000,
            apis: Vec::new(),
            sync_values: BTreeMap::new(),
        }
    }
}
impl TestOptions {
    pub(crate) fn execution_policy(&self) -> container_runtime::EngineExecutionPolicy {
        container_runtime::EngineExecutionPolicy {
            turn_timeout_ms: Some(self.turn_timeout_ms),
            bootstrap_timeout_ms: Some(self.bootstrap_timeout_ms),
        }
    }
}

pub struct TestSession {
    sdk: ContainerSession,
    now_ms: u64,
}
impl TestSession {
    pub fn new() -> Result<Self, SdkError> {
        require_full_distribution()?;
        if !engine_provider_compiled(EngineKind::Quickjs) {
            return Err(SdkError::new("ERR_ENGINE", "testing requires real QuickJS"));
        }
        Ok(Self {
            sdk: ContainerSession::new(ContainerConfig {
                dev_diagnostics: true,
                ..Default::default()
            })?,
            now_ms: TestOptions::default().now_ms,
        })
    }

    pub fn take_events(&mut self) -> Vec<Value> {
        self.sdk.take_events()
    }

    fn check_page(&self, payload: &Value) -> Result<PageId, SdkError> {
        let active = self
            .sdk
            .active
            .as_ref()
            .ok_or_else(|| SdkError::new("ERR_NOT_LOADED", "no page loaded"))?;
        let id = payload["pageId"]
            .as_u64()
            .ok_or_else(|| SdkError::invalid("pageId is required"))?;
        if payload["sessionId"].as_str() != Some(active.session.config().session_id.as_str())
            || active
                .session
                .app_service()
                .pages()
                .get(PageId(id))
                .is_none()
        {
            return Err(SdkError::new(
                "ERR_STALE_HANDLE",
                "page belongs to a retired session or page",
            ));
        }
        Ok(PageId(id))
    }

    fn control(&mut self, input: Value) -> Result<Value, SdkError> {
        let (value, batch) = self.sdk.active_mut()?.session.testing_control(input)?;
        self.sdk.observe_batch(&batch)?;
        self.sdk.finish_operation()?;
        Ok(value)
    }

    pub fn command(&mut self, operation: &str, payload: Value) -> Result<Value, SdkError> {
        match operation {
            "load" => {
                if self.sdk.active.is_some() {
                    let mut candidate = Self::new()?;
                    let result = candidate.command("load", payload)?;
                    self.sdk.close()?;
                    for event in self.sdk.take_events() {
                        candidate.sdk.push_event(event);
                    }
                    *self = candidate;
                    return Ok(result);
                }
                let options: TestOptions =
                    serde_json::from_value(payload.get("testing").cloned().unwrap_or(json!({})))
                        .map_err(SdkError::invalid)?;
                if options.now_ms > 9_007_199_254_740_991 {
                    return Err(SdkError::invalid("nowMs exceeds safe integer range"));
                }
                let path = PathBuf::from(
                    payload["packPath"]
                        .as_str()
                        .ok_or_else(|| SdkError::invalid("packPath is required"))?,
                );
                let pack = pack::VerifiedPack::load(path.clone().into())?;
                let mut apis = options.apis.clone();
                for name in options.sync_values.keys() {
                    if !apis.contains(name) {
                        apis.push(name.clone());
                    }
                }
                if !apis.iter().any(|api| api == "wx.request") {
                    apis.push("wx.request".into());
                }
                self.sdk.configure_host_services(HostServicesConfig {
                    application: TrustedApplication {
                        host_app_id: self.sdk.base_id.clone(),
                        tenant_id: "testing".into(),
                        publisher_id: "testing".into(),
                        app_id: "test-app".into(),
                        environment: "develop".into(),
                        version: "1".into(),
                        pack_root: pack.manifest.integrity.root.clone(),
                    },
                    account: HostAccount {
                        principal_id: Some("test-principal".into()),
                        epoch: 1,
                    },
                    apis,
                    sync_values: options.sync_values.clone(),
                })?;
                self.now_ms = options.now_ms;
                self.sdk.test_options = Some(options);
                self.sdk.load(
                    path.into(),
                    LoadOptions {
                        route: payload
                            .get("route")
                            .and_then(Value::as_str)
                            .map(|route| route.trim_start_matches('/').to_owned()),
                        options: payload
                            .get("options")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default(),
                        ..Default::default()
                    },
                )?;
                self.command("currentPage", json!({}))
            }
            "currentPage" => {
                let active = self.sdk.active_mut()?;
                let page = active
                    .session
                    .app_service()
                    .pages()
                    .current()
                    .ok_or_else(|| SdkError::new("ERR_NOT_LOADED", "no current page"))?;
                Ok(
                    json!({"sessionId":active.session.config().session_id,"pageId":page.id.0,"route":page.path}),
                )
            }
            "data" => {
                let id = self.check_page(&payload)?;
                Ok(self
                    .sdk
                    .active_mut()?
                    .session
                    .app_service()
                    .pages()
                    .get(id)
                    .unwrap()
                    .data
                    .clone())
            }
            "callMethod" => {
                let id = self.check_page(&payload)?;
                self.control(json!({"action":"call","pageId":id.0,"receiver":payload["receiver"],"method":payload["method"],"args":payload.get("args").cloned().unwrap_or(json!([]))}))
            }
            "componentData" => {
                let id = self.check_page(&payload)?;
                self.control(json!({"action":"data","pageId":id.0,"receiver":payload["receiver"]}))
                    .map(|value| value["value"].clone())
            }
            "component" => {
                let id = self.check_page(&payload)?;
                let active = self.sdk.active_mut()?;
                let frame = active
                    .session
                    .renderer()
                    .last_frame()
                    .ok_or_else(|| SdkError::new("ERR_NO_FRAME", "no committed view"))?;
                let nodes = frame
                    .query("#subject", false)
                    .map_err(|error| SdkError::invalid(format!("{error:?}")))?;
                let scope = nodes
                    .first()
                    .and_then(|node| node.component_scope_id.clone())
                    .ok_or_else(|| {
                        SdkError::new("ERR_COMPONENT_NOT_FOUND", "test subject was not mounted")
                    })?;
                self.control(json!({"action":"component","pageId":id.0,"scope":scope}))
                    .map(|value| value["value"].clone())
            }
            "query" => {
                let id = self.check_page(&payload)?;
                let active = self.sdk.active_mut()?;
                if active.session.app_service().pages().current().map(|p| p.id) != Some(id) {
                    return Err(SdkError::invalid("queries require the current page"));
                }
                let selector = payload["selector"]
                    .as_str()
                    .ok_or_else(|| SdkError::invalid("selector is required"))?;
                let frame = active
                    .session
                    .renderer()
                    .last_frame()
                    .ok_or_else(|| SdkError::new("ERR_NO_FRAME", "no committed view"))?;
                let nodes = frame
                    .query(selector, payload["all"] == true)
                    .map_err(|error| SdkError::invalid(format!("{error:?}")))?;
                Ok(json!(nodes.into_iter().map(|node| json!({"identity":node.event_identity.as_deref().unwrap_or(&node.id),"revision":active.session.view().revision.to_string(),"id":node.id,"tag":node.tag,"text":node_text(node),"attributes":node.attributes,"dataset":node.dataset})).collect::<Vec<_>>()))
            }
            "trigger" => {
                let page = self.check_page(&payload)?;
                let active = self.sdk.active_mut()?;
                if active.session.app_service().pages().current().map(|p| p.id) != Some(page) {
                    return Err(SdkError::new(
                        "ERR_STALE_HANDLE",
                        "node belongs to a hidden page",
                    ));
                }
                if payload["revision"].as_str()
                    != Some(active.session.view().revision.to_string().as_str())
                {
                    return Err(SdkError::new(
                        "ERR_STALE_HANDLE",
                        "node snapshot was retired; query the current view again",
                    ));
                }
                let frame = active
                    .session
                    .renderer()
                    .last_frame()
                    .ok_or_else(|| SdkError::new("ERR_NO_FRAME", "no committed view"))?;
                let mut path = Vec::new();
                if !event_path(
                    &frame.root,
                    payload["identity"].as_str().unwrap_or_default(),
                    &mut path,
                ) {
                    return Err(SdkError::new("ERR_STALE_HANDLE", "node was removed"));
                }
                self.sdk.input(vec![json!({"type":payload["type"],"target":payload["identity"],"path":path,"detail":payload.get("detail").cloned().unwrap_or(json!({})),"bubbles":true})])?;
                Ok(Value::Null)
            }
            "tick" => {
                self.sdk.pump(clock_now_ns())?;
                let value = self.control(json!({"action":"pending"}))?;
                Ok(json!({"timersReady":value["value"]}))
            }
            "advance" => {
                let by = payload["ms"]
                    .as_u64()
                    .ok_or_else(|| SdkError::invalid("ms must be a nonnegative integer"))?;
                let now = self
                    .now_ms
                    .checked_add(by)
                    .filter(|now| *now <= 9_007_199_254_740_991)
                    .ok_or_else(|| SdkError::invalid("clock overflow"))?;
                self.control(json!({"action":"clock","now":now}))?;
                self.now_ms = now;
                self.command("tick", json!({}))
            }
            "complete" => {
                let id = payload["callId"]
                    .as_str()
                    .ok_or_else(|| SdkError::invalid("callId is required"))?;
                if payload["hostApi"] == true {
                    let result = match payload.get("error") {
                        Some(error) => {
                            Err(serde_json::from_value(error.clone()).map_err(SdkError::invalid)?)
                        }
                        None => Ok(payload["result"].clone()),
                    };
                    self.sdk.complete_host_api_call(id, result)?;
                } else {
                    let result = match payload.get("error") {
                        Some(error) => {
                            Err(serde_json::from_value(error.clone()).map_err(SdkError::invalid)?)
                        }
                        None => Ok(payload["result"].clone()),
                    };
                    self.sdk.complete_host_call(id, result)?;
                }
                Ok(Value::Null)
            }
            "navigateTo" | "redirectTo" => {
                self.sdk.navigate(
                    payload["route"]
                        .as_str()
                        .ok_or_else(|| SdkError::invalid("route required"))?
                        .trim_start_matches('/'),
                    payload.get("query").cloned().unwrap_or(json!({})),
                    operation == "redirectTo",
                )?;
                self.command("currentPage", json!({}))
            }
            "navigateBack" => {
                self.sdk.back()?;
                self.command("currentPage", json!({}))
            }
            "lifecycle" => {
                self.sdk.set_foreground(payload["visible"] == true)?;
                Ok(Value::Null)
            }
            "close" => {
                self.sdk.close()?;
                Ok(json!({"closed":true}))
            }
            _ => Err(SdkError::invalid(format!(
                "unknown testing command: {operation}"
            ))),
        }
    }
}
fn event_path(node: &RenderNode, identity: &str, path: &mut Vec<String>) -> bool {
    let key = node.event_identity.as_deref().unwrap_or(&node.id);
    path.push(key.to_owned());
    if key == identity {
        return true;
    }
    for child in &node.children {
        if event_path(child, identity, path) {
            return true;
        }
    }
    path.pop();
    false
}
fn node_text(node: &RenderNode) -> String {
    let mut text = node.text.clone().unwrap_or_default();
    for child in &node.children {
        text.push_str(&node_text(child));
    }
    text
}
