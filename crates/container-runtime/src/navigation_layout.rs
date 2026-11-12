//! Owner-thread navigation planning. UI measurement never holds an engine turn.
use super::*;

const MAX_PENDING: usize = 256;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_PENDING_BYTES: usize = 64 * 1024 * 1024;
const PREPARATION_NS: u64 = 15_000_000_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationLayoutRequest {
    pub schema_version: u32,
    pub ticket: String,
    pub session_id: String,
    pub root: String,
    #[serde(serialize_with = "serialize_decimal_u64")]
    pub deadline_ns: u64,
    pub target_route: String,
    pub chrome: PageChrome,
}

fn serialize_decimal_u64<S: serde::Serializer>(
    value: &u64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

pub(super) enum NavigationCompletion {
    Engine { id: u64, name: String },
    Bridge(BridgeEnvelope),
}
struct Queued {
    request: BridgeEnvelope,
    name: String,
    payload: Map<String, Value>,
    completion: NavigationCompletion,
    prepared: Option<route_transaction::PreparedRoute>,
    deadline: u64,
    bytes: usize,
}
struct Pending {
    queued: Queued,
    request: NavigationLayoutRequest,
    source: Vec<(PageId, String)>,
    planned: container_core::PageStack,
}
struct Commit {
    geometry: host_environment::PreparedHostGeometry,
    token: String,
    created: Value,
    expected: Vec<(PageId, String)>,
}
#[derive(Default)]
pub(super) struct NavigationLayoutState {
    pub(super) enabled: bool,
    queue: VecDeque<Queued>,
    active: Option<Pending>,
    commit: Option<Commit>,
    pub(super) committing: bool,
    bytes: usize,
    sequence: u64,
    mirror_sequence: u64,
    fault: Option<Value>,
    completions: Vec<BridgeEnvelope>,
    geometry_committed: bool,
    last_outcome: Option<Value>,
    pub(super) closed: bool,
}

pub(super) fn is_structural_navigation(name: &str) -> bool {
    matches!(
        name,
        "wx.navigateTo" | "wx.redirectTo" | "wx.navigateBack" | "wx.reLaunch" | "wx.switchTab"
    )
}

pub(super) fn engine_navigation_request(
    session: &str,
    name: &str,
    payload: &Map<String, Value>,
) -> Result<BridgeEnvelope, BridgeError> {
    let mut request = BridgeEnvelope::request(
        session,
        "engine-navigation",
        op::API_CALL,
        json!({"name":name,"payload":payload}),
    );
    request.deadline_ns = payload
        .get("deadlineNs")
        .or_else(|| payload.get("deadline_ns"))
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| BridgeError::invalid("navigation deadlineNs must be unsigned"))
        })
        .transpose()?;
    request.cancel_token = payload
        .get("cancelToken")
        .or_else(|| payload.get("cancel_token"))
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| BridgeError::invalid("navigation cancelToken must be a string"))
        })
        .transpose()?;
    request.validate()?;
    Ok(request)
}
fn shape(stack: &container_core::PageStack) -> Vec<(PageId, String)> {
    stack
        .iter()
        .map(|page| (page.id, page.path.clone()))
        .collect()
}

impl Session {
    pub fn set_deferred_navigation_enabled(&mut self, enabled: bool) -> Result<(), BridgeError> {
        if self.navigation_layout.enabled != enabled
            && (self.navigation_layout.active.is_some() || !self.navigation_layout.queue.is_empty())
        {
            return Err(BridgeError::invalid(
                "navigation layout transaction is pending",
            ));
        }
        self.navigation_layout.enabled = enabled;
        if enabled && self.initialized {
            self.sync_current_pages_trusted()?;
            self.start_next_navigation()?;
        }
        Ok(())
    }
    pub fn pending_navigation(&self) -> Option<NavigationLayoutRequest> {
        self.navigation_layout
            .active
            .as_ref()
            .map(|pending| pending.request.clone())
    }
    pub fn navigation_requires_restart(&self) -> bool {
        self.navigation_layout.fault.is_some()
    }
    pub fn last_navigation_outcome(&self) -> Option<&Value> {
        self.navigation_layout.last_outcome.as_ref()
    }
    pub fn navigation_fault(&self) -> Option<&Value> {
        self.navigation_layout.fault.as_ref()
    }
    pub(super) fn navigation_blocks_presentation(&self) -> bool {
        self.navigation_layout.active.is_some()
            || self.navigation_layout.committing
            || self.navigation_layout.fault.is_some()
    }
    pub(super) fn enqueue_navigation(
        &mut self,
        request: BridgeEnvelope,
        name: &str,
        payload: Map<String, Value>,
        completion: NavigationCompletion,
    ) -> Result<(), BridgeError> {
        let bytes = serde_json::to_vec(&payload)
            .map_err(|error| BridgeError::invalid(error.to_string()))?
            .len();
        if self.navigation_layout.closed {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "navigation owner is closed",
            ));
        }
        if self.requires_dev_restart() {
            return Err(BridgeError::new(
                BridgeErrorCode::Engine,
                "navigation requires session restart",
            ));
        }
        if self.navigation_layout.queue.len() + usize::from(self.navigation_layout.active.is_some())
            >= MAX_PENDING
            || bytes > MAX_MESSAGE_BYTES
            || self.navigation_layout.bytes.saturating_add(bytes) > MAX_PENDING_BYTES
        {
            return Err(BridgeError::invalid("navigation queue budget exceeded"));
        }
        let deadline = request
            .deadline_ns
            .unwrap_or(u64::MAX)
            .min(unix_now_ns().saturating_add(PREPARATION_NS));
        self.navigation_layout.bytes += bytes;
        self.navigation_layout.queue.push_back(Queued {
            request,
            name: name.into(),
            payload,
            completion,
            prepared: None,
            deadline,
            bytes,
        });
        self.start_next_navigation()
    }
    fn plan_navigation(
        &mut self,
        mut queued: Queued,
    ) -> Result<Pending, Box<(Queued, BridgeError)>> {
        let planned = (|| {
            if queued.deadline <= unix_now_ns() {
                return Err(BridgeError::new(
                    BridgeErrorCode::Timeout,
                    "navigation preparation expired",
                ));
            }
            self.validate_navigation_admission(&queued.request, &queued.name)?;
            if matches!(queued.request.op.as_str(), op::PAGE_PUSH | op::PAGE_REPLACE)
                && queued
                    .payload
                    .get("data")
                    .is_some_and(|data| !data.is_object())
            {
                return Err(BridgeError::invalid("page initial data must be an object"));
            }
            if queued.prepared.is_none() {
                let prepared = self.prepare_route_transaction(
                    &queued.name,
                    &queued.payload,
                    route_transaction::RouteOrigin::PublicApi,
                )?;
                queued.payload = prepared.payload.clone();
                queued.prepared = Some(prepared);
            }
            let raw = queued
                .payload
                .get("url")
                .or_else(|| queued.payload.get("path"))
                .and_then(Value::as_str);
            let (target, query) = navigation_target(
                &self.manifest,
                &queued.name,
                raw,
                queued.payload.get("query"),
            )?;
            let mut stack = self.app_service.pages().clone();
            match queued.name.as_str() {
                "wx.navigateTo" => {
                    stack
                        .push(
                            target
                                .ok_or_else(|| BridgeError::invalid("navigateTo requires url"))?,
                        )
                        .map_err(|error| BridgeError::invalid(error.to_string()))?;
                }
                "wx.redirectTo" => {
                    stack
                        .replace(
                            target
                                .ok_or_else(|| BridgeError::invalid("redirectTo requires url"))?,
                        )
                        .map_err(|error| BridgeError::invalid(error.to_string()))?;
                }
                "wx.reLaunch" => {
                    stack.clear();
                    stack
                        .push(target.ok_or_else(|| BridgeError::invalid("reLaunch requires url"))?)
                        .map_err(|error| BridgeError::invalid(error.to_string()))?;
                }
                "wx.navigateBack" => {
                    let delta = queued
                        .payload
                        .get("delta")
                        .and_then(Value::as_u64)
                        .unwrap_or(1)
                        .max(1);
                    for _ in 0..delta.min(stack.len().saturating_sub(1) as u64) {
                        stack
                            .pop()
                            .map_err(|error| BridgeError::invalid(error.to_string()))?;
                    }
                }
                "wx.switchTab" => {
                    let path =
                        target.ok_or_else(|| BridgeError::invalid("switchTab requires url"))?;
                    let cached = stack
                        .iter()
                        .find(|page| page.path == path)
                        .cloned()
                        .or_else(|| self.cached_tabs.get(&path).cloned());
                    if let Some(cached) = cached {
                        stack.activate_entry(cached);
                    } else {
                        stack.clear();
                        stack
                            .push(path)
                            .map_err(|error| BridgeError::invalid(error.to_string()))?;
                    }
                }
                _ => return Err(BridgeError::invalid("unsupported deferred navigation")),
            }
            if queued.name != "wx.navigateBack" {
                if let Some(page) = stack.current_mut() {
                    page.query = query
                        .as_object()
                        .map(|query| {
                            query
                                .iter()
                                .map(|(key, value)| {
                                    (
                                        key.clone(),
                                        value
                                            .as_str()
                                            .map(str::to_owned)
                                            .unwrap_or_else(|| value.to_string()),
                                    )
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                }
            }
            let target = stack
                .current()
                .ok_or_else(|| BridgeError::invalid("navigation has no target page"))?;
            let chrome = resolve_page_chrome(
                &self.manifest,
                &self.render_blobs,
                &target.path,
                Some(target),
                stack
                    .iter()
                    .map(|page| ChromePage {
                        id: page.id.0,
                        route: page.path.clone(),
                    })
                    .collect(),
                Some(self.config.session_id.clone()),
            )?;
            self.navigation_layout.sequence = self
                .navigation_layout
                .sequence
                .checked_add(1)
                .ok_or_else(|| BridgeError::invalid("navigation sequence exhausted"))?;
            let request = NavigationLayoutRequest {
                schema_version: 1,
                ticket: format!(
                    "{}:navigation:{}",
                    self.config.session_id, self.navigation_layout.sequence
                ),
                session_id: self.config.session_id.clone(),
                root: self.manifest.integrity.root.clone(),
                deadline_ns: queued.deadline,
                target_route: target.path.clone(),
                chrome,
            };
            Ok((stack, request))
        })();
        match planned {
            Ok((stack, request)) => Ok(Pending {
                source: shape(self.app_service.pages()),
                queued,
                request,
                planned: stack,
            }),
            Err(error) => Err(Box::new((queued, error))),
        }
    }
    fn start_next_navigation(&mut self) -> Result<(), BridgeError> {
        if self.app_service.pages().is_empty()
            || self.navigation_layout.active.is_some()
            || self.navigation_layout.committing
            || self.navigation_layout.fault.is_some()
        {
            return Ok(());
        }
        while let Some(queued) = self.navigation_layout.queue.pop_front() {
            match self.plan_navigation(queued) {
                Ok(pending) => {
                    self.presented_revision = None;
                    self.pending_presentation = None;
                    self.observer_frame_valid = false;
                    self.suspend_dev_raster_presentation();
                    self.navigation_layout.active = Some(pending);
                    return Ok(());
                }
                Err(failure) => {
                    let (queued, error) = *failure;
                    self.finish_navigation(queued, Err(error))?;
                }
            }
        }
        Ok(())
    }
    fn finish_navigation(
        &mut self,
        queued: Queued,
        result: Result<Value, BridgeError>,
    ) -> Result<(), BridgeError> {
        self.navigation_layout.bytes = self.navigation_layout.bytes.saturating_sub(queued.bytes);
        match queued.completion {
            NavigationCompletion::Engine { id, name } => {
                #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
                if !self.engine_execution_is_faulted() {
                    self.resolve_engine_api(id, &name, result)?;
                }
                #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
                let _ = (id, name, result);
            }
            NavigationCompletion::Bridge(request) => {
                let message = match result {
                    Ok(value) => self.response(&request, value),
                    Err(error) => {
                        self.error_envelope(&error, request.request_id.clone(), op::ERROR)
                    }
                };
                self.navigation_layout.completions.push(message);
            }
        }
        Ok(())
    }
    pub fn poll_navigation_timeouts(&mut self, now_ns: u64) -> Result<BridgeBatch, BridgeError> {
        self.with_engine_batch_turn(None, |session| {
            if session
                .navigation_layout
                .active
                .as_ref()
                .is_some_and(|active| {
                    active.queued.deadline <= now_ns
                        || active
                            .queued
                            .request
                            .cancel_token
                            .as_ref()
                            .is_some_and(|token| session.is_cancelled(token))
                })
            {
                let pending = session.navigation_layout.active.take().unwrap();
                let cancelled = pending
                    .queued
                    .request
                    .cancel_token
                    .as_ref()
                    .is_some_and(|token| session.is_cancelled(token));
                session.finish_navigation(
                    pending.queued,
                    Err(BridgeError::new(
                        if cancelled {
                            BridgeErrorCode::Cancelled
                        } else {
                            BridgeErrorCode::Timeout
                        },
                        "navigation preparation terminated",
                    )),
                )?;
            }
            // Expire queued operations against the same observed clock. Waiting
            // behind an earlier measurement never grants a fresh deadline.
            let queue = std::mem::take(&mut session.navigation_layout.queue);
            for queued in queue {
                let cancelled = queued
                    .request
                    .cancel_token
                    .as_ref()
                    .is_some_and(|token| session.is_cancelled(token));
                if queued.deadline <= now_ns || cancelled {
                    session.finish_navigation(
                        queued,
                        Err(BridgeError::new(
                            if cancelled {
                                BridgeErrorCode::Cancelled
                            } else {
                                BridgeErrorCode::Timeout
                            },
                            "navigation preparation terminated",
                        )),
                    )?;
                } else {
                    session.navigation_layout.queue.push_back(queued);
                }
            }
            session.start_next_navigation()?;
            Ok(BridgeBatch::new(std::mem::take(
                &mut session.navigation_layout.completions,
            )))
        })
    }
    pub fn cancel_all_navigation(&mut self, reason: &str) -> Result<BridgeBatch, BridgeError> {
        self.navigation_layout.closed = true;
        self.with_engine_batch_turn(None, |session| {
            let mut cancelled = Vec::new();
            if let Some(active) = session.navigation_layout.active.take() {
                cancelled.push(active.queued);
            }
            cancelled.extend(session.navigation_layout.queue.drain(..));
            for queued in cancelled {
                if let Err(error) = session.finish_navigation(
                    queued,
                    Err(BridgeError::new(BridgeErrorCode::Cancelled, reason)),
                ) {
                    session
                        .navigation_layout
                        .completions
                        .push(session.error_envelope(&error, String::new(), op::ERROR));
                }
            }
            Ok(BridgeBatch::new(std::mem::take(
                &mut session.navigation_layout.completions,
            )))
        })
    }
    pub fn cancel_navigation(
        &mut self,
        ticket: &str,
        code: BridgeErrorCode,
        message: &str,
    ) -> Result<BridgeBatch, BridgeError> {
        if self
            .navigation_layout
            .active
            .as_ref()
            .is_none_or(|pending| pending.request.ticket != ticket)
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "stale navigation ticket",
            ));
        }
        self.with_engine_batch_turn(None, |session| {
            let pending = session.navigation_layout.active.take().unwrap();
            session.finish_navigation(pending.queued, Err(BridgeError::new(code, message)))?;
            session.start_next_navigation()?;
            Ok(BridgeBatch::new(std::mem::take(
                &mut session.navigation_layout.completions,
            )))
        })
    }
    pub fn complete_navigation_layout(
        &mut self,
        ticket: &str,
        metrics: HostWindowMetrics,
        menu: MenuButtonRect,
    ) -> Result<BridgeBatch, BridgeError> {
        if self.requires_dev_restart() {
            return Err(BridgeError::new(
                BridgeErrorCode::Engine,
                "navigation requires session restart",
            ));
        }
        metrics
            .validate()
            .map_err(|error| BridgeError::invalid(error.to_string()))?;
        host_layout::validate_menu_rect(&menu)?;
        if self
            .navigation_layout
            .active
            .as_ref()
            .is_none_or(|pending| pending.request.ticket != ticket)
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "stale navigation ticket",
            ));
        }
        self.with_engine_batch_turn(None,|session| {
            let mut pending=session.navigation_layout.active.take().unwrap();
            if pending.source != shape(session.app_service.pages()) || pending.request.root != session.manifest.integrity.root || pending.queued.deadline <= unix_now_ns() || pending.queued.request.cancel_token.as_ref().is_some_and(|token| session.is_cancelled(token)) {
                session.navigation_layout.last_outcome=Some(json!({"ticket":ticket,"layoutCommitted":false,"stackCommitted":false,"phase":"preparation"}));
                let code=if pending.queued.deadline <= unix_now_ns(){BridgeErrorCode::Timeout}else{BridgeErrorCode::Cancelled};
                session.finish_navigation(pending.queued,Err(BridgeError::new(code,"navigation owner or deadline changed")))?;
                session.start_next_navigation()?;
                return Ok(BridgeBatch::new(std::mem::take(&mut session.navigation_layout.completions)));
            }
            // A hidden cached destination may update its dynamic chrome while
            // the UI is measuring. Request a new measurement, with the same
            // enqueue deadline, rather than commit geometry for an old shell.
            let target=pending.planned.current().unwrap();
            let live_target=session.app_service.pages().get(target.id).or_else(||session.cached_tabs.values().find(|entry|entry.id==target.id)).unwrap_or(target);
            let current_chrome=resolve_page_chrome(&session.manifest,&session.render_blobs,&target.path,Some(live_target),pending.planned.iter().map(|page|ChromePage{id:page.id.0,route:page.path.clone()}).collect(),Some(session.config.session_id.clone()))?;
            if current_chrome != pending.request.chrome {
                session.navigation_layout.last_outcome=Some(json!({"ticket":ticket,"layoutCommitted":false,"stackCommitted":false,"phase":"remeasure"}));
                match session.plan_navigation(pending.queued) {
                    Ok(pending)=>session.navigation_layout.active=Some(pending),
                    Err(failure)=>{let(queued,error)=*failure;session.finish_navigation(queued,Err(error))?;session.start_next_navigation()?;}
                }
                return Ok(BridgeBatch::new(std::mem::take(&mut session.navigation_layout.completions)));
            }
            let mut host=session.config.host.clone();host.window_width=metrics.window_width;host.window_height=metrics.window_height;host.display_metrics=Some(metrics.display);host.menu_button_rect=Some(menu);
            session.navigation_layout.geometry_committed=false;
            let preparation=(|| {
                let geometry=session.prepare_host_geometry(host)?;
                let token=session.next_page_mirror_token()?;
                let overrides=if matches!(pending.queued.request.op.as_str(),op::PAGE_PUSH|op::PAGE_REPLACE){pending.queued.payload.get("data")}else{None};
                let created=session.prepare_trusted_page_mirror(&token,&pending.planned,overrides)?;
                Ok(Commit {geometry,token,created,expected:shape(&pending.planned)})
            })();
            let commit=match preparation {
                Ok(commit)=>commit,
                Err(error)=> {
                    session.navigation_layout.last_outcome=Some(json!({"ticket":ticket,"layoutCommitted":false,"stackCommitted":false,"phase":"preparation","error":error}));
                    session.finish_navigation(pending.queued,Err(error))?;
                    session.start_next_navigation()?;
                    return Ok(BridgeBatch::new(std::mem::take(&mut session.navigation_layout.completions)));
                }
            };
            let cancelled=pending.queued.request.cancel_token.as_ref().is_some_and(|token|session.is_cancelled(token));
            if pending.queued.deadline <= unix_now_ns() || cancelled {
                session.cancel_trusted_page_mirror(&commit.token)?;
                session.navigation_layout.last_outcome=Some(json!({"ticket":ticket,"layoutCommitted":false,"stackCommitted":false,"phase":"preparation"}));
                session.finish_navigation(pending.queued,Err(BridgeError::new(if cancelled {BridgeErrorCode::Cancelled}else{BridgeErrorCode::Timeout},"navigation preparation terminated")))?;
                session.start_next_navigation()?;
                return Ok(BridgeBatch::new(std::mem::take(&mut session.navigation_layout.completions)));
            }
            let prepared_token=commit.token.clone();
            session.navigation_layout.commit=Some(commit);
            session.navigation_layout.committing=true;
            let engine_request_id = match &pending.queued.completion { NavigationCompletion::Engine { id, .. } => Some(*id), NavigationCompletion::Bridge(_) => None };
            let result = match pending.queued.prepared.take() {
                Some(prepared)=>session.navigation_result_prepared(&pending.queued.request,&pending.queued.name,engine_request_id,prepared),
                None=>Err(BridgeError::new(BridgeErrorCode::Engine,"navigation omitted prepared route")),
            };
            // A departure hook can fail before publication. Release its private
            // preparation as well as preparations consumed by successful commit.
            let cleanup=session.cancel_trusted_page_mirror(&prepared_token);
            let result=result.and_then(|value|cleanup.map(|()|value));
            let committed=session.navigation_layout.geometry_committed;
            let stack_committed=shape(session.app_service.pages()) != pending.source;
            session.navigation_layout.last_outcome=Some(json!({"ticket":ticket,"layoutCommitted":committed,"stackCommitted":stack_committed,"phase":"completion","ok":result.is_ok(),"error":result.as_ref().err()}));
            session.navigation_layout.commit=None;
            session.navigation_layout.committing=false;
            if let Err(error)=&result {
                session.navigation_layout.fault=Some(json!({"domain":"navigation","ticket":ticket,"phase":"committing","stackCommitted":stack_committed,"layoutCommitted":committed,"error":error,"sessionId":session.config.session_id,"stack":shape(session.app_service.pages()).iter().map(|(id,path)| json!({"pageId":id.0,"route":path})).collect::<Vec<_>>(),"recovery":"restart"}));
            }
            session.finish_navigation(pending.queued,result)?;
            let mut messages=std::mem::take(&mut session.navigation_layout.completions);
            if !session.engine_execution_is_faulted() { session.append_engine_effects(&mut messages)?; }
            session.start_next_navigation()?;
            Ok(BridgeBatch::new(messages))
        })
    }
    pub(super) fn commit_navigation_geometry(&mut self) -> Result<(), BridgeError> {
        let Some(commit) = self.navigation_layout.commit.take() else {
            return self.flush_unload_notifications();
        };
        if shape(self.app_service.pages()) != commit.expected {
            return Err(BridgeError::new(
                BridgeErrorCode::Engine,
                "navigation plan changed during commit",
            ));
        }
        self.install_prepared_host_geometry(commit.geometry)?;
        self.navigation_layout.geometry_committed = true;
        self.commit_trusted_page_mirror(&commit.token)?;
        self.apply_page_mirror_created(&commit.created);
        self.flush_unload_notifications()
    }
    fn next_page_mirror_token(&mut self) -> Result<String, BridgeError> {
        self.navigation_layout.mirror_sequence = self
            .navigation_layout
            .mirror_sequence
            .checked_add(1)
            .ok_or_else(|| {
                BridgeError::new(BridgeErrorCode::Engine, "page mirror sequence exhausted")
            })?;
        Ok(format!(
            "{}:pages:{}",
            self.config.session_id, self.navigation_layout.mirror_sequence
        ))
    }
    fn page_mirror_records(
        &self,
        stack: &container_core::PageStack,
        overrides: Option<&Value>,
    ) -> Value {
        Value::Array(stack.iter().map(|page|json!({"index":self.page_registration_index_for_id(&page.path,page.id),"instanceId":page.id.0,"route":page.path,"options":page.query,"data":if stack.current().is_some_and(|current|current.id==page.id){overrides.or_else(||self.page_initial_data.get(&page.id))}else{self.page_initial_data.get(&page.id)}})).collect())
    }
    fn prepare_trusted_page_mirror(
        &mut self,
        token: &str,
        stack: &container_core::PageStack,
        overrides: Option<&Value>,
    ) -> Result<Value, BridgeError> {
        let records = self.page_mirror_records(stack, overrides);
        let _ = (token, &records);
        if !self.engine_provider_available() || self.loaded_modules.is_empty() {
            return Ok(json!({"created":[]}));
        }
        match self.config.engine {
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs => self
                .quickjs_engine
                .as_mut()
                .unwrap()
                .prepare_page_mirror(token, &records)
                .map_err(|error| {
                    engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                }),
            #[cfg(feature = "v8-native")]
            EngineKind::V8 => self
                .v8_engine
                .as_mut()
                .unwrap()
                .prepare_page_mirror(token, &records)
                .map_err(|error| BridgeError::new(BridgeErrorCode::Engine, error.to_string())),
            #[allow(unreachable_patterns)]
            _ => Ok(json!({"created":[]})),
        }
    }
    fn commit_trusted_page_mirror(&mut self, token: &str) -> Result<(), BridgeError> {
        let _ = token;
        if !self.engine_provider_available() || self.loaded_modules.is_empty() {
            return Ok(());
        }
        match self.config.engine {
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs => self
                .quickjs_engine
                .as_mut()
                .unwrap()
                .commit_page_mirror(token)
                .map_err(|error| {
                    engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                }),
            #[cfg(feature = "v8-native")]
            EngineKind::V8 => self
                .v8_engine
                .as_mut()
                .unwrap()
                .commit_page_mirror(token)
                .map_err(|error| BridgeError::new(BridgeErrorCode::Engine, error.to_string())),
            #[allow(unreachable_patterns)]
            _ => Ok(()),
        }
    }
    fn cancel_trusted_page_mirror(&mut self, token: &str) -> Result<(), BridgeError> {
        let _ = token;
        if !self.engine_provider_available() || self.loaded_modules.is_empty() {
            return Ok(());
        }
        match self.config.engine {
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs => self
                .quickjs_engine
                .as_mut()
                .unwrap()
                .cancel_page_mirror(token)
                .map_err(|error| {
                    engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                }),
            #[cfg(feature = "v8-native")]
            EngineKind::V8 => self
                .v8_engine
                .as_mut()
                .unwrap()
                .cancel_page_mirror(token)
                .map_err(|error| BridgeError::new(BridgeErrorCode::Engine, error.to_string())),
            #[allow(unreachable_patterns)]
            _ => Ok(()),
        }
    }
    fn apply_page_mirror_created(&mut self, receipt: &Value) {
        if let Some(created) = receipt.get("created").and_then(Value::as_array) {
            for snapshot in created {
                if let Some(id) = snapshot
                    .get("instanceId")
                    .and_then(Value::as_u64)
                    .map(PageId)
                {
                    if let Some(page) = self.app_service.pages_mut().get_mut(id) {
                        page.data = snapshot.get("data").cloned().unwrap_or_else(|| json!({}));
                        self.page_initial_data.remove(&id);
                    }
                }
            }
        }
    }
    pub(super) fn sync_current_pages_trusted(&mut self) -> Result<(), BridgeError> {
        let token = self.next_page_mirror_token()?;
        let stack = self.app_service.pages().clone();
        let created = self.prepare_trusted_page_mirror(&token, &stack, None)?;
        self.commit_trusted_page_mirror(&token)?;
        self.apply_page_mirror_created(&created);
        Ok(())
    }
}
