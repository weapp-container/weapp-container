//! Page Canvas authority uses retained receiver requests and exact declaration
//! generations. Public API payloads can only reach independent legacy surfaces.
use super::*;
use container_render_skia::CanvasOwnerKey;

const MAX_CONTEXTS: usize = 256;
const MAX_PENDING: usize = 256;
const MAX_PENDING_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub(super) struct OwnedCanvasState {
    after: u64,
    last_context: u64,
    generation: u64,
    contexts: BTreeMap<u64, Context>,
    declarations: BTreeMap<(u64, String), Declaration>,
    pending: VecDeque<PendingDraw>,
    pending_bytes: usize,
}

#[derive(Clone)]
struct Context {
    canvas_id: String,
    owner: browser_query::QueryOwner,
    receivers: Value,
    binding: Option<CanvasOwnerKey>,
}

#[derive(Clone)]
struct Declaration {
    key: CanvasOwnerKey,
    canvas_id: String,
    width: u32,
    height: u32,
}

pub(super) struct PreparedCanvasBindings {
    contexts: BTreeMap<u64, Context>,
    declarations: BTreeMap<(u64, String), Declaration>,
    generation: u64,
    pub(super) keys: Vec<CanvasOwnerKey>,
}

pub(super) struct RetiredCanvasBindings {
    _keys: Vec<CanvasOwnerKey>,
    _contexts: BTreeMap<u64, Context>,
    _declarations: BTreeMap<(u64, String), Declaration>,
}

impl OwnedCanvasState {
    pub(super) fn accept_bindings(
        &mut self,
        prepared: PreparedCanvasBindings,
    ) -> RetiredCanvasBindings {
        self.generation = prepared.generation;
        RetiredCanvasBindings {
            _keys: prepared.keys,
            _contexts: std::mem::replace(&mut self.contexts, prepared.contexts),
            _declarations: std::mem::replace(&mut self.declarations, prepared.declarations),
        }
    }
}

struct PendingDraw {
    request: CapturedRequest,
    bytes: usize,
    // A native publication is never repeated because callback transport failed.
    completion: Option<Result<Value, BridgeError>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapturedRequests {
    requests: Vec<CapturedRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapturedRequest {
    kind: String,
    sequence: String,
    context: String,
    owner: browser_query::QueryOwner,
    receivers: Value,
    #[serde(default)]
    canvas_id: Option<String>,
    #[serde(default)]
    ticket: Option<String>,
    #[serde(default)]
    options: Option<Map<String, Value>>,
}

fn cancelled(message: &str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Cancelled, message)
}

fn number(text: &str, name: &str) -> Result<u64, BridgeError> {
    text.parse::<u64>()
        .ok()
        .filter(|value| *value != 0 && value.to_string() == text)
        .ok_or_else(|| BridgeError::invalid(format!("invalid owned Canvas {name}")))
}

fn token(proof: &Value, scope: Option<&str>) -> Result<u64, BridgeError> {
    let value = match scope {
        Some(scope) => proof.get("scopes").and_then(|value| value.get(scope)),
        None => proof.get("pageToken"),
    }
    .and_then(Value::as_str)
    .ok_or_else(|| BridgeError::invalid("invalid owned Canvas receiver proof"))?;
    number(value, "receiver incarnation")
}

fn declaration_nodes<'a>(node: &'a RenderNode, nodes: &mut Vec<&'a RenderNode>) {
    if node.tag.as_deref() == Some("canvas") {
        nodes.push(node);
    }
    for child in &node.children {
        declaration_nodes(child, nodes);
    }
}

impl Session {
    pub(super) fn prepare_owned_canvas_bindings(
        &mut self,
        frame: &RenderFrame,
        generated: bool,
    ) -> Result<PreparedCanvasBindings, BridgeError> {
        let mut declarations = self.owned_canvases.declarations.clone();
        let mut generation = self.owned_canvases.generation;
        let page = self.app_service.pages().current().map(|page| page.id.0);
        let mut keys = Vec::new();
        if let Some(page) = page {
            declarations.retain(|(owner, _), _| *owner != page);
            if generated && self.engine_provider_available() && !self.loaded_modules.is_empty() {
                let mut nodes = Vec::new();
                declaration_nodes(&frame.root, &mut nodes);
                nodes.retain(|node| {
                    node.attributes
                        .get("canvas-id")
                        .is_some_and(|id| !id.is_empty())
                });
                // Ordinary pages without named Canvas nodes do not acquire a
                // new receiver requirement merely by sharing the renderer.
                if !nodes.is_empty() {
                    let scopes = nodes
                        .iter()
                        .filter_map(|node| node.event_owner_scope_id.clone())
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .collect::<Vec<_>>();
                    let proof = self.owned_canvas_receiver_snapshot(page, &scopes)?;
                    let page_incarnation = token(&proof, None)?;
                    for node in nodes {
                        let Some(canvas_id) =
                            node.attributes.get("canvas-id").filter(|id| !id.is_empty())
                        else {
                            continue;
                        };
                        let identity = node.event_identity.as_ref().ok_or_else(|| {
                            BridgeError::invalid("owned Canvas needs an evaluated node identity")
                        })?;
                        if canvas_id.len() > 256 || identity.len() > 4096 {
                            return Err(BridgeError::invalid(
                                "owned Canvas declaration identity exceeds its budget",
                            ));
                        }
                        let dimension = |name: &str, fallback: u32| -> Result<u32, BridgeError> {
                            node.attributes.get(name).map_or(Ok(fallback), |value| {
                                value.parse::<u32>().map_err(|_| {
                                    BridgeError::invalid("invalid Canvas intrinsic dimensions")
                                })
                            })
                        };
                        let width = dimension("width", 300)?;
                        let height = dimension("height", 150)?;
                        let scope_id = node.event_owner_scope_id.clone();
                        let scope_incarnation = scope_id
                            .as_deref()
                            .map(|scope| token(&proof, Some(scope)))
                            .transpose()?;
                        let previous = self
                            .owned_canvases
                            .declarations
                            .get(&(page, identity.clone()));
                        let unchanged = previous.filter(|entry| {
                            entry.canvas_id == *canvas_id
                                && entry.width == width
                                && entry.height == height
                                && entry.key.page_incarnation == page_incarnation
                                && entry.key.scope_id == scope_id
                                && entry.key.scope_incarnation == scope_incarnation
                        });
                        let key = if let Some(previous) = unchanged {
                            previous.key.clone()
                        } else {
                            generation = generation.checked_add(1).ok_or_else(|| {
                                BridgeError::invalid("owned Canvas node generation exhausted")
                            })?;
                            CanvasOwnerKey {
                                page_id: page,
                                page_incarnation,
                                scope_id,
                                scope_incarnation,
                                node_identity: identity.clone(),
                                node_generation: generation,
                            }
                        };
                        if declarations
                            .insert(
                                (page, identity.clone()),
                                Declaration {
                                    key: key.clone(),
                                    canvas_id: canvas_id.clone(),
                                    width,
                                    height,
                                },
                            )
                            .is_some()
                        {
                            return Err(BridgeError::invalid(
                                "duplicate evaluated Canvas node identity",
                            ));
                        }
                        keys.push(key);
                    }
                }
            }
        }
        if declarations.len() > MAX_CONTEXTS {
            return Err(BridgeError::invalid(
                "owned Canvas declaration count exceeded",
            ));
        }
        let active = declarations
            .values()
            .map(|entry| entry.key.clone())
            .collect::<BTreeSet<_>>();
        let contexts = self
            .owned_canvases
            .contexts
            .iter()
            .filter(|(_, context)| {
                context
                    .binding
                    .as_ref()
                    .is_none_or(|key| active.contains(key))
            })
            .map(|(id, context)| (*id, context.clone()))
            .collect();
        Ok(PreparedCanvasBindings {
            contexts,
            declarations,
            generation,
            keys,
        })
    }

    pub(super) fn accept_owned_canvas_bindings(&mut self, prepared: PreparedCanvasBindings) {
        drop(self.owned_canvases.accept_bindings(prepared));
        let active = self
            .owned_canvases
            .declarations
            .values()
            .map(|entry| entry.key.clone())
            .collect::<BTreeSet<_>>();
        if let Some(renderer) = self.skia_backend.renderer.peek_mut() {
            renderer.retire_owned_canvases(&active);
        }
    }

    pub(super) fn retire_all_owned_canvases(&mut self) {
        self.owned_canvases.contexts.clear();
        self.owned_canvases.declarations.clear();
        if let Some(renderer) = self.skia_backend.renderer.peek_mut() {
            renderer.retire_owned_canvases(&BTreeSet::new());
        }
    }

    pub(super) fn retire_owned_canvas_owners(
        &mut self,
        page: PageId,
        scopes: Option<&BTreeSet<String>>,
    ) {
        let retired = |scope: &Option<String>| {
            scopes.is_none_or(|scopes| scope.as_ref().is_some_and(|scope| scopes.contains(scope)))
        };
        self.owned_canvases
            .declarations
            .retain(|_, entry| entry.key.page_id != page.0 || !retired(&entry.key.scope_id));
        self.owned_canvases.contexts.retain(|_, entry| {
            entry.owner.page_id != page.0.to_string() || !retired(&entry.owner.scope_id)
        });
        let active = self
            .owned_canvases
            .declarations
            .values()
            .map(|entry| entry.key.clone())
            .collect::<BTreeSet<_>>();
        if let Some(renderer) = self.skia_backend.renderer.peek_mut() {
            renderer.retire_owned_canvases(&active);
        }
    }

    pub(super) fn forget_retired_owned_canvas_requests(&mut self) {
        self.retire_all_owned_canvases();
        // The retained JS realm retirement has rejected its private callbacks;
        // no Rust request may keep their command buffers alive afterward.
        self.owned_canvases.pending.clear();
        self.owned_canvases.pending_bytes = 0;
    }

    fn canvas_receivers_live(
        &mut self,
        owner: &browser_query::QueryOwner,
        proof: &Value,
    ) -> Result<(), BridgeError> {
        let page = number(&owner.page_id, "page")?;
        if self.app_service.pages().get(PageId(page)).is_none()
            && !self
                .cached_tabs
                .values()
                .any(|entry| entry.id == PageId(page))
        {
            return Err(cancelled("owned Canvas Page was unloaded"));
        }
        let scopes = owner.scope_id.iter().cloned().collect::<Vec<_>>();
        if self.owned_canvas_receiver_snapshot(page, &scopes)? != *proof {
            return Err(cancelled("owned Canvas receiver incarnation was retired"));
        }
        Ok(())
    }

    fn reconcile_owned_canvas_receivers(&mut self) {
        let declarations = self
            .owned_canvases
            .declarations
            .iter()
            .map(|(id, entry)| (id.clone(), entry.key.clone()))
            .collect::<Vec<_>>();
        for (id, key) in declarations {
            let owner = browser_query::QueryOwner {
                page_id: key.page_id.to_string(),
                scope_id: key.scope_id.clone(),
            };
            let mut scopes = Map::new();
            if let (Some(scope), Some(incarnation)) = (&key.scope_id, key.scope_incarnation) {
                scopes.insert(scope.clone(), json!(incarnation.to_string()));
            }
            let proof = json!({"pageToken":key.page_incarnation.to_string(),"scopes":scopes});
            if self.canvas_receivers_live(&owner, &proof).is_err() {
                self.owned_canvases.declarations.remove(&id);
            }
        }
        let records = self
            .owned_canvases
            .contexts
            .iter()
            .map(|(id, entry)| (*id, entry.owner.clone(), entry.receivers.clone()))
            .collect::<Vec<_>>();
        for (id, owner, proof) in records {
            if self.canvas_receivers_live(&owner, &proof).is_err() {
                self.owned_canvases.contexts.remove(&id);
                let page = owner.page_id.parse::<u64>().unwrap_or_default();
                let page_token = token(&proof, None).ok();
                let scope_token = owner
                    .scope_id
                    .as_deref()
                    .and_then(|scope| token(&proof, Some(scope)).ok());
                self.owned_canvases.declarations.retain(|_, entry| {
                    !(entry.key.page_id == page
                        && Some(entry.key.page_incarnation) == page_token
                        && entry.key.scope_id == owner.scope_id
                        && entry.key.scope_incarnation == scope_token)
                });
            }
        }
        let active = self
            .owned_canvases
            .declarations
            .values()
            .map(|entry| entry.key.clone())
            .collect::<BTreeSet<_>>();
        if let Some(renderer) = self.skia_backend.renderer.peek_mut() {
            renderer.retire_owned_canvases(&active);
        }
    }

    fn owned_canvas_receiver_snapshot(
        &mut self,
        page: u64,
        scopes: &[String],
    ) -> Result<Value, BridgeError> {
        #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
        let _ = (page, scopes);
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::invalid("QuickJS provider unavailable"))?
                        .capture_selector_query_receivers(page, scopes)
                        .map_err(|error| {
                            let error = error.into_core_error();
                            let fallback = if error.code == container_core::EngineErrorCode::Call {
                                BridgeErrorCode::Cancelled
                            } else {
                                BridgeErrorCode::Engine
                            };
                            engine_bridge_error(error, fallback)
                        })
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    Err(BridgeError::invalid("QuickJS provider unavailable"))
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::invalid("V8 provider unavailable"))?
                        .capture_selector_query_receivers(page, scopes)
                        .map_err(|error| {
                            let error = error.into_core_error();
                            let fallback = if error.code == container_core::EngineErrorCode::Call {
                                BridgeErrorCode::Cancelled
                            } else {
                                BridgeErrorCode::Engine
                            };
                            engine_bridge_error(error, fallback)
                        })
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    Err(BridgeError::invalid("V8 provider unavailable"))
                }
            }
        }
    }

    fn capture_private_canvas_requests(&mut self) -> Result<Value, BridgeError> {
        let after = self.owned_canvases.after;
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::invalid("QuickJS provider unavailable"))?
                        .capture_owned_canvas_requests(after)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    let _ = after;
                    Err(BridgeError::invalid("QuickJS provider unavailable"))
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| BridgeError::invalid("V8 provider unavailable"))?
                        .capture_owned_canvas_requests(after)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    let _ = after;
                    Err(BridgeError::invalid("V8 provider unavailable"))
                }
            }
        }
    }

    fn bind_canvas_context(&mut self, id: u64) -> Result<bool, BridgeError> {
        let context = self
            .owned_canvases
            .contexts
            .get(&id)
            .ok_or_else(|| cancelled("owned Canvas context was retired"))?;
        let page = number(&context.owner.page_id, "page")?;
        if self.observer_frame_page != Some(PageId(page)) {
            return Ok(false);
        }
        if self
            .last_frame_input(self.render_revision())
            .is_some_and(|input| input.template_revision != self.view.template_revision)
        {
            // AppService has scheduled a different declaration tree. Wait for
            // its normal layout transaction before resolving a new occurrence
            // or drawing through a potentially removed old occurrence.
            return Ok(false);
        }
        if context.binding.is_some() {
            return Ok(true);
        }
        if !self.accepted_skia_scene {
            return Err(cancelled(
                "owned Canvas needs an evaluated page declaration",
            ));
        }
        let matches = self
            .owned_canvases
            .declarations
            .values()
            .filter(|entry| {
                entry.key.page_id == page
                    && entry.key.scope_id == context.owner.scope_id
                    && entry.canvas_id == context.canvas_id
                    && token(&context.receivers, None).ok() == Some(entry.key.page_incarnation)
                    && context
                        .owner
                        .scope_id
                        .as_deref()
                        .map(|scope| token(&context.receivers, Some(scope)))
                        .transpose()
                        .ok()
                        .flatten()
                        == entry.key.scope_incarnation
            })
            .map(|entry| entry.key.clone())
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(cancelled(
                "owned Canvas declaration is missing or ambiguous",
            ));
        }
        self.owned_canvases
            .contexts
            .get_mut(&id)
            .expect("context retained")
            .binding = Some(matches[0].clone());
        Ok(true)
    }

    fn submit_owned_canvas_draw(
        &mut self,
        request: &CapturedRequest,
    ) -> Result<Option<Value>, BridgeError> {
        let context_id = number(&request.context, "context")?;
        let context = self
            .owned_canvases
            .contexts
            .get(&context_id)
            .ok_or_else(|| cancelled("owned Canvas context was retired"))?;
        if context.owner.page_id != request.owner.page_id
            || context.owner.scope_id != request.owner.scope_id
            || context.receivers != request.receivers
        {
            return Err(cancelled(
                "owned Canvas request does not match its captured context",
            ));
        }
        self.canvas_receivers_live(&request.owner, &request.receivers)?;
        let page = number(&request.owner.page_id, "page")?;
        if self.app_service.pages().current().map(|page| page.id.0) != Some(page) {
            return Err(cancelled("owned Canvas Page is not current"));
        }
        if self.browser_route_active() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "owned Canvas page images are not connected to the browser presenter",
            ));
        }
        if !self.bind_canvas_context(context_id)? {
            return Ok(None);
        }
        let context = self
            .owned_canvases
            .contexts
            .get(&context_id)
            .expect("context bound");
        let canvas_id = context.canvas_id.clone();
        let key = context.binding.clone().expect("binding exists");
        let declaration = self
            .owned_canvases
            .declarations
            .values()
            .find(|entry| entry.key == key)
            .ok_or_else(|| cancelled("owned Canvas node generation was retired"))?;
        let mut payload = request
            .options
            .clone()
            .ok_or_else(|| BridgeError::invalid("owned Canvas draw options missing"))?;
        if payload.get("canvasId").and_then(Value::as_str) != Some(canvas_id.as_str()) {
            return Err(BridgeError::invalid("owned Canvas local name changed"));
        }
        if self.effective_capability("wx.canvas.draw") == CapabilitySupport::Unsupported {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "wx.canvas.draw is unsupported",
            ));
        }
        payload.insert("width".into(), json!(declaration.width));
        payload.insert("height".into(), json!(declaration.height));
        let frame_id = self
            .canvas_frame_sequence
            .max(self.view.last_frame_id.unwrap_or_default())
            .checked_add(1)
            .ok_or_else(|| BridgeError::invalid("owned Canvas frame sequence exhausted"))?;
        let frame =
            CanvasFrame::from_payload(&payload, frame_id, None).map_err(render_bridge_error)?;
        let authority = self.current_skia_frame_authority().cloned();
        if !self.has_current_skia_scene()
            || (self.skia_frame_authority_required() && authority.is_none())
        {
            return Err(cancelled(
                "owned Canvas has no current accepted page layout",
            ));
        }
        let provenance = self.last_frame_input(self.render_revision()).cloned();
        let page_frame_id = self
            .skia_backend
            .renderer
            .last_frame()
            .ok_or_else(|| cancelled("owned Canvas page frame was retired"))?
            .frame_id;
        // Receiver proof has just been rechecked. No guest code or checkpoint
        // runs between this validation, native preparation and joint accept.
        let prepared = self
            .skia_backend
            .renderer
            .ensure_mut()
            .prepare_owned_canvas_draw(&key, frame)
            .map_err(render_bridge_error)?;
        let snapshot = prepared
            .owned_canvas_snapshot()
            .ok_or_else(|| BridgeError::invalid("owned Canvas candidate omitted its snapshot"))?
            .clone();
        let retired_page = prepared.accept();
        self.canvas_frame_sequence = frame_id;
        self.record_last_frame_input(provenance);
        self.carry_retained_skia_frame_authority(authority);
        self.suspend_dev_raster_presentation();
        if self.page_render_mode() != PageRenderMode::Raster
            || self.dev_raster_presentation_required()
        {
            self.observer_frame_valid = false;
            // Preserve pending initial ready work when a draw replaces a frame
            // before its first host presentation. A pure repaint adds none.
            let generated = self
                .pending_presentation
                .is_some_and(|(owner, _, generated)| owner == Some(PageId(page)) && generated);
            self.pending_presentation = Some((Some(PageId(page)), page_frame_id, generated));
        } else {
            self.presented_revision = Some(self.render_revision());
        }
        // Keep the previous images and surfaces until repaint provenance,
        // authority and presentation state have all published together.
        drop(retired_page);
        Ok(Some(
            json!({"frameId":frame_id,"canvasId":canvas_id,"width":snapshot.width,"height":snapshot.height,"stride":snapshot.stride,"format":snapshot.format}),
        ))
    }

    pub(super) fn drain_private_owned_canvases(&mut self) -> Result<bool, BridgeError> {
        if !self.engine_provider_available() {
            return Ok(false);
        }
        self.reconcile_owned_canvas_receivers();
        let raw = self.capture_private_canvas_requests()?;
        let snapshot: CapturedRequests = serde_json::from_value(raw).map_err(|error| {
            BridgeError::invalid(format!("invalid retained Canvas requests: {error}"))
        })?;
        if snapshot.requests.len() > MAX_PENDING {
            return Err(BridgeError::invalid("owned Canvas request count exceeded"));
        }
        let had_requests = !snapshot.requests.is_empty();
        for mut request in snapshot.requests {
            let sequence = number(&request.sequence, "request sequence")?;
            if sequence <= self.owned_canvases.after {
                return Err(BridgeError::invalid("owned Canvas request was replayed"));
            }
            self.owned_canvases.after = sequence;
            let context_id = number(&request.context, "context")?;
            if request.kind == "context" {
                if context_id <= self.owned_canvases.last_context
                    || request.ticket.is_some()
                    || request.options.is_some()
                {
                    return Err(BridgeError::invalid(
                        "invalid owned Canvas context registration",
                    ));
                }
                self.owned_canvases.last_context = context_id;
                if self
                    .canvas_receivers_live(&request.owner, &request.receivers)
                    .is_err()
                {
                    continue;
                }
                let canvas_id = request
                    .canvas_id
                    .ok_or_else(|| BridgeError::invalid("owned Canvas name missing"))?;
                if canvas_id.is_empty() || canvas_id.len() > 256 {
                    return Err(BridgeError::invalid("owned Canvas name is invalid"));
                }
                // A stale/unavailable registration fails its later private draw
                // rather than aborting unrelated accepted effects in this turn.
                if self.owned_canvases.contexts.len() >= MAX_CONTEXTS {
                    continue;
                }
                self.owned_canvases.contexts.insert(
                    context_id,
                    Context {
                        canvas_id,
                        owner: request.owner,
                        receivers: request.receivers,
                        binding: None,
                    },
                );
                if self.bind_canvas_context(context_id).is_err() {
                    self.owned_canvases.contexts.remove(&context_id);
                }
            } else if request.kind == "draw" {
                if request.ticket.as_deref() != Some(format!("canvas:{sequence}").as_str())
                    || request.canvas_id.is_some()
                {
                    return Err(BridgeError::invalid("invalid owned Canvas draw ticket"));
                }
                let bytes =
                    serde_json::to_vec(request.options.as_ref().ok_or_else(|| {
                        BridgeError::invalid("owned Canvas draw options missing")
                    })?)
                    .map_err(|error| BridgeError::invalid(error.to_string()))?
                    .len();
                if self.owned_canvases.pending.len() >= MAX_PENDING {
                    return Err(BridgeError::invalid(
                        "retained Canvas callback count exceeded",
                    ));
                }
                if self.owned_canvases.pending_bytes.saturating_add(bytes) > MAX_PENDING_BYTES {
                    // Keep only the private delivery identity for a rejected
                    // admission. A transport retry cannot retain its commands
                    // or accidentally submit them after capacity becomes free.
                    request.options = None;
                    self.owned_canvases.pending.push_back(PendingDraw {
                        request,
                        bytes: 0,
                        completion: Some(Err(BridgeError::invalid(
                            "owned Canvas pending draw budget exceeded",
                        ))),
                    });
                } else {
                    self.owned_canvases.pending_bytes += bytes;
                    self.owned_canvases.pending.push_back(PendingDraw {
                        request,
                        bytes,
                        completion: None,
                    });
                }
            } else {
                return Err(BridgeError::invalid("unknown retained Canvas request kind"));
            }
        }
        let attempts = self.owned_canvases.pending.len();
        for _ in 0..attempts {
            let mut pending = self
                .owned_canvases
                .pending
                .pop_front()
                .expect("bounded pending queue");
            if pending.completion.is_none() {
                pending.completion = match self.submit_owned_canvas_draw(&pending.request) {
                    Ok(None) => None,
                    Ok(Some(value)) => Some(Ok(value)),
                    Err(error) => Some(Err(error)),
                };
            }
            if let Some(result) = &pending.completion {
                if let Err(error) = self.deliver_owned_canvas(&pending.request, result) {
                    self.owned_canvases.pending.push_front(pending);
                    return Err(error);
                }
                self.owned_canvases.pending_bytes -= pending.bytes;
                // The retained delivery can execute guest callback code. Its
                // effects must reach the ordinary public drain before any
                // subsequent request sees the accepted declaration tree.
                return Ok(true);
            } else {
                self.owned_canvases.pending.push_back(pending);
            }
        }
        Ok(had_requests)
    }

    fn deliver_owned_canvas(
        &mut self,
        request: &CapturedRequest,
        result: &Result<Value, BridgeError>,
    ) -> Result<(), BridgeError> {
        let payload = match result {
            Ok(value) => json!({"ticket":request.ticket,"result":value,"error":null}),
            Err(error) => {
                json!({"ticket":request.ticket,"result":null,"error":async_host::host_error_payload("wx.canvas.draw",error,None)})
            }
        };
        if !self.dispatch_lifecycle_notification("ownedCanvas", &payload)? {
            return Err(BridgeError::invalid(
                "retained owned Canvas delivery was not acknowledged",
            ));
        }
        Ok(())
    }
}
