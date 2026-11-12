//! One runtime owned by the native main thread. No simulator runtime is created.
use crate::observation;
use crate::pack::{Pack, Result};
use crate::profile::PresenterProfile;
use container_bridge::{BridgeBatch, BridgeEnvelope, op};
use container_core::EngineKind;
use container_host_common::HostSession;
use container_ir::hex_digest;
use container_render_skia::{PageRenderMode, Rect};
use container_runtime::{HostKind, HostMetadata, SessionConfig, engine_provider_compiled};
use serde_json::{Map, Value, json};

#[cfg(feature = "conformance-exception-channel")]
#[path = "exception_channel.rs"]
mod exception_channel;

type RenderIdentity = (u64, String, u64);

#[cfg(feature = "conformance-observation")]
#[path = "data_runtime.rs"]
mod data_runtime;
#[cfg(feature = "conformance-observation")]
#[path = "method_owner.rs"]
mod method_owner;

pub struct NativeSession {
    #[cfg(feature = "conformance-exception-channel")]
    exceptions: exception_channel::State,
    #[cfg(feature = "conformance-observation")]
    runtime_log_incarnation: String,
    #[cfg(feature = "conformance-observation")]
    runtime_log_closed: bool,
    #[cfg(feature = "conformance-observation")]
    runtime_log_route: Option<String>,
    pub host: HostSession,
    pub session_id: String,
    pub engine: EngineKind,
    pub pack: Pack,
    presenter_profile: Option<PresenterProfile>,
    #[cfg(feature = "accepted-frame-observation")]
    accepted_frame_observer: crate::accepted_frame_observation::Observer,
    viewport: Rect,
    next_request: u64,
    rendered: Option<RenderIdentity>,
    owner_pump_sequence: u64,
    required_pump_sequence: u64,
    action_sequence: u64,
    acknowledged_revision: u64,
    transcript: Vec<Value>,
    startup_operations: Map<String, Value>,
    startup_frozen: bool,
    #[cfg(feature = "conformance-observation")]
    method_ledger: crate::method_delivery::DeliveryLedger,
    #[cfg(feature = "conformance-observation")]
    pending_method: Option<method_owner::PendingMethod>,
}

impl NativeSession {
    pub fn new(
        pack: Pack,
        engine: EngineKind,
        session_id: String,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        let profile = PresenterProfile::select(
            std::env::consts::OS,
            if cfg!(target_os = "linux") {
                Some("software")
            } else {
                None
            },
        )?;
        Self::new_with_profile(pack, engine, session_id, width, height, profile)
    }

    pub fn new_with_profile(
        pack: Pack,
        engine: EngineKind,
        session_id: String,
        width: u32,
        height: u32,
        profile: PresenterProfile,
    ) -> Result<Self> {
        profile.validate_host(std::env::consts::OS)?;
        Self::construct(
            pack,
            engine,
            session_id,
            width,
            height,
            profile.render_mode(),
            Some(profile),
        )
    }

    fn new_with_render_mode(
        pack: Pack,
        engine: EngineKind,
        session_id: String,
        width: u32,
        height: u32,
        page_render_mode: PageRenderMode,
    ) -> Result<Self> {
        Self::construct(
            pack,
            engine,
            session_id,
            width,
            height,
            page_render_mode,
            None,
        )
    }

    fn construct(
        pack: Pack,
        engine: EngineKind,
        session_id: String,
        width: u32,
        height: u32,
        page_render_mode: PageRenderMode,
        presenter_profile: Option<PresenterProfile>,
    ) -> Result<Self> {
        if !engine_provider_compiled(engine) {
            return Err("requested engine provider is not compiled".into());
        }
        if session_id.trim().is_empty()
            || width == 0
            || height == 0
            || width > 4096
            || height > 4096
        {
            return Err("nonempty session and bounded positive viewport required".into());
        }
        let config = SessionConfig {
            session_id: session_id.clone(),
            engine,
            page_render_mode,
            host: HostMetadata {
                kind: HostKind::Desktop,
                platform: presenter_profile
                    .map(PresenterProfile::host)
                    .unwrap_or(std::env::consts::OS)
                    .into(),
                version: "weapp-conformance-desktop/0.1".into(),
                window_width: width,
                window_height: height,
                ..HostMetadata::default()
            },
            require_integrity: true,
            ..SessionConfig::default()
        };
        #[cfg(feature = "accepted-frame-observation")]
        let accepted_frame_observer = crate::accepted_frame_observation::Observer::new()?;
        let mut host = HostSession::from_manifest_json(&pack.manifest_bytes, config)?;
        // Opt in before app.init/page creation: synchronous Raster would run
        // guest ready hooks before the native software surface submits a frame.
        if presenter_profile == Some(PresenterProfile::LinuxSoftware) {
            host.session_mut()
                .ok_or("software session is unloaded")?
                .enable_dev_raster_presentation()?;
        }
        let mut native = Self {
            #[cfg(feature = "conformance-observation")]
            runtime_log_incarnation: data_runtime::incarnation()?,
            #[cfg(feature = "conformance-observation")]
            runtime_log_closed: false,
            #[cfg(feature = "conformance-observation")]
            runtime_log_route: None,
            #[cfg(feature = "conformance-exception-channel")]
            exceptions: exception_channel::State::new()?,
            host,
            session_id,
            engine,
            pack,
            presenter_profile,
            #[cfg(feature = "accepted-frame-observation")]
            accepted_frame_observer,
            viewport: Rect {
                x: 0.0,
                y: 0.0,
                width: width as f32,
                height: height as f32,
            },
            next_request: 1,
            rendered: None,
            owner_pump_sequence: 0,
            required_pump_sequence: 0,
            action_sequence: 0,
            acknowledged_revision: 0,
            transcript: Vec::new(),
            startup_operations: Map::new(),
            startup_frozen: false,
            #[cfg(feature = "conformance-observation")]
            method_ledger: Default::default(),
            #[cfg(feature = "conformance-observation")]
            pending_method: None,
        };
        let route = native.pack.initial_route()?;
        native.dispatch(op::APP_INIT, native.pack.init()?)?;
        native.dispatch(op::APP_LIFECYCLE, json!({"event":"launch","options":{}}))?;
        native.dispatch(op::PAGE_PUSH, json!({"path":route,"query":{}}))?;
        Ok(native)
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> Result<BridgeBatch> {
        let request = BridgeEnvelope::request(
            &self.session_id,
            format!("native-{}", self.next_request),
            operation,
            payload,
        );
        self.next_request = self
            .next_request
            .checked_add(1)
            .ok_or("native request sequence exhausted")?;
        let response = self.host.dispatch(request.clone())?;
        let record = json!({"status":0,"request":request,"json":serde_json::to_string(&response)?});
        self.transcript
            .push(json!({"seq":self.transcript.len()+1,"request":request,"response":response}));
        if !self.startup_frozen
            && matches!(
                operation,
                op::APP_INIT | op::APP_LIFECYCLE | op::PAGE_PUSH | op::RENDER_COMMIT
            )
        {
            self.startup_operations.insert(operation.into(), record);
        }
        ensure_success(&response)?;
        if !response.messages.iter().any(|message| {
            message.op == operation
                && message.request_id == request.request_id
                && message.payload.get("ok") == Some(&Value::Bool(true))
        }) {
            return Err(format!("{operation} returned no successful matching response").into());
        }
        Ok(response)
    }

    fn identity(&self) -> Result<RenderIdentity> {
        let session = self.host.session().ok_or("native session is unloaded")?;
        let page = session
            .app_service()
            .pages()
            .current()
            .ok_or("native session has no current page")?;
        Ok((
            page.id.0,
            page.path.clone(),
            session.view().template_revision,
        ))
    }

    pub fn route(&self) -> Result<String> {
        Ok(self.identity()?.1)
    }

    /// Polling and render scheduling stay on the same main-thread runtime.
    /// A failed render is returned; an older accepted frame grants no readiness.
    pub fn pump(&mut self, now_ns: u64) -> Result<()> {
        if self.exception_closed() {
            return Ok(());
        }
        let timers = self.host.poll_timers(now_ns)?;
        if !timers.messages.is_empty() {
            self.transcript.push(json!({"seq":self.transcript.len()+1,"source":"host-clock","nowNs":now_ns,"response":timers}));
            ensure_success(&timers)?;
        }
        let identity = self.identity()?;
        if self.rendered.as_ref() != Some(&identity) {
            if self.pack.manifest.renderer_profile_for_route(&identity.1)
                == container_ir::RendererProfile::WebView
            {
                return Err("native conformance host does not own browser renderer routes".into());
            }
            let template = self.pack.template(&identity.1)?;
            let styles = self.pack.manifest.route_style_ids(&identity.1)?;
            self.host.stage_skia_render_target(self.viewport, 1.0)?;
            self.dispatch(
                op::RENDER_COMMIT,
                json!({"templateId":template,"styleIds":styles,
                "useSessionResources":true,"viewport":self.viewport}),
            )?;
            self.rendered = Some(identity);
        }
        self.owner_pump_sequence = self
            .owner_pump_sequence
            .checked_add(1)
            .ok_or("native owner pump sequence exhausted")?;
        Ok(())
    }

    pub fn acknowledge(&mut self, revision: u64) -> Result<()> {
        let response: BridgeBatch =
            serde_json::from_slice(&self.host.acknowledge_presentation_json(revision)?)?;
        self.transcript.push(
            json!({"seq":self.transcript.len()+1,"source":"native-surface-presentation",
            "revision":revision,"response":response}),
        );
        ensure_success(&response)?;
        self.acknowledged_revision = revision;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub fn acknowledge_software(
        &mut self,
        presenter: &mut crate::presenter::SoftwareWindowPresenter,
        submission: crate::software_owner::SoftwareSubmission,
    ) -> Result<()> {
        let (revision, response) = presenter.acknowledge_submission(&mut self.host, submission)?;
        self.transcript.push(json!({"seq":self.transcript.len()+1,"source":"native-software-surface-presentation","revision":revision,"response":response}));
        ensure_success(&response)?;
        self.acknowledged_revision = revision;
        Ok(())
    }

    pub fn stable(&self) -> bool {
        self.identity().ok().as_ref() == self.rendered.as_ref()
            && self.owner_pump_sequence >= self.required_pump_sequence
            && self.host.session().is_some_and(|session| {
                let revision = self.host.render_revision();
                session.has_current_skia_scene()
                    && session.is_current_frame_presented()
                    && revision > 0
                    && self.acknowledged_revision == revision
                    && session.last_frame_input(revision).is_some_and(|input| {
                        input.template_revision == session.view().template_revision
                            && input.viewport == self.viewport
                    })
            })
    }

    /// An owner-thread completion barrier for the source-pinned synchronous
    /// wxml profile. This proves the current accepted input/presentation after
    /// a real pump, not global quiescence of future timers/network/idle work.
    pub fn completion(&self) -> Result<Value> {
        self.require_presented()?;
        let accepted = self
            .host
            .accepted_page_observation()?
            .ok_or("no accepted native frame")?;
        self.completion_for(accepted.frame, accepted.render_revision)
    }

    fn completion_for(
        &self,
        frame: &container_render_skia::RenderFrame,
        revision: u64,
    ) -> Result<Value> {
        let (page, route, template) = self.identity()?;
        let consumed_template = self
            .host
            .session()
            .and_then(|session| session.last_frame_input(revision))
            .ok_or("accepted native frame has no committed input")?
            .template_revision;
        Ok(
            json!({"kind":"owner-pump-native-presentation-v1","sessionId":self.session_id,
            "route":route,"pageId":page.to_string(),"templateRevision":template.to_string(),
            "consumedTemplateRevision":consumed_template.to_string(),"frameId":frame.frame_id.to_string(),
            "renderRevision":revision.to_string(),"presentationAckRevision":self.acknowledged_revision.to_string(),
            "actionSeq":self.action_sequence.to_string(),"ownerPumpSeq":self.owner_pump_sequence.to_string(),
            "requiredPumpSeq":self.required_pump_sequence.to_string(),"presented":true}),
        )
    }

    #[cfg(feature = "accepted-frame-observation")]
    fn accepted_frame_binding(&self) -> Result<EngineKind> {
        let config = self
            .host
            .session()
            .ok_or("native session is unloaded")?
            .config();
        if config.engine != self.engine || config.session_id != self.session_id {
            return Err(
                "accepted-frame metadata differs from actual runtime engine/session".into(),
            );
        }
        Ok(config.engine)
    }

    #[cfg(feature = "accepted-frame-observation")]
    pub fn accepted_frame_capabilities(&self, request: &Value) -> Result<Value> {
        crate::accepted_frame_observation::parse_capabilities(request)?;
        self.require_presented()?;
        let engine = self.accepted_frame_binding()?;
        let accepted = self
            .host
            .accepted_page_observation()?
            .ok_or("no accepted native frame")?;
        let mut value = self
            .accepted_frame_observer
            .capability(engine, &self.session_id);
        value["completion"] = self.completion_for(accepted.frame, accepted.render_revision)?;
        Ok(value)
    }

    #[cfg(feature = "accepted-frame-observation")]
    pub fn accepted_frame_observe(&self, request: &Value) -> Result<Value> {
        let request = crate::accepted_frame_observation::Request::parse(request)?;
        self.require_presented()?;
        self.assert_route(&request.route)?;
        let engine = self.accepted_frame_binding()?;
        let accepted = self
            .host
            .accepted_page_observation()?
            .ok_or("no accepted native frame")?;
        let completion = self.completion_for(accepted.frame, accepted.render_revision)?;
        self.accepted_frame_observer
            .observe(accepted.frame, engine, completion, &request)
    }

    #[cfg(feature = "accepted-frame-node-input")]
    pub fn node_capabilities(&self, request: &Value) -> Result<Value> {
        crate::accepted_frame_nodes::parse_capabilities(request)?;
        self.require_presented()?;
        let mut value = crate::accepted_frame_nodes::capability(
            &self.accepted_frame_observer,
            self.accepted_frame_binding()?,
            &self.session_id,
        );
        value["completion"] = self.completion()?;
        Ok(value)
    }

    #[cfg(feature = "accepted-frame-node-input")]
    pub fn acquire_nodes(&self, request: &Value) -> Result<Value> {
        let request = crate::accepted_frame_nodes::AcquireRequest::parse(request)?;
        self.require_presented()?;
        self.assert_route(&request.route)?;
        let engine = self.accepted_frame_binding()?;
        let accepted = self
            .host
            .accepted_page_observation()?
            .ok_or("no accepted native frame")?;
        let completion = self.completion_for(accepted.frame, accepted.render_revision)?;
        crate::accepted_frame_nodes::acquire(
            &self.accepted_frame_observer,
            accepted.frame,
            engine,
            completion,
            &request,
        )
    }

    /// Resolve the exact acquisition token, validate its actual hit path and
    /// dispatch coordinates in one owner-thread turn. No pump, VM work, await
    /// or selector/public-id re-resolution may occur before EVENT_BATCH.
    #[cfg(feature = "accepted-frame-node-input")]
    pub fn tap_node(&mut self, request: &Value) -> Result<Value> {
        let request = crate::accepted_frame_nodes::TapRequest::parse(request)?;
        self.require_presented()?;
        self.assert_route(&request.route)?;
        let engine = self.accepted_frame_binding()?;
        let prepared = {
            let accepted = self
                .host
                .accepted_page_observation()?
                .ok_or("no accepted native frame")?;
            let completion = self.completion_for(accepted.frame, accepted.render_revision)?;
            crate::accepted_frame_nodes::prepare_tap(
                &self.accepted_frame_observer,
                accepted.frame,
                engine,
                completion,
                &request,
            )?
        };
        // Reserve overflow checks before the sole effect. Failed dispatch may
        // have real guest effects; retain its error and force a fresh pump/frame,
        // but never return a fabricated success or accepted completion.
        let next_action = self
            .action_sequence
            .checked_add(1)
            .ok_or("native action sequence exhausted")?;
        let next_pump = self
            .owner_pump_sequence
            .checked_add(1)
            .ok_or("native required pump sequence exhausted")?;
        let result = self.dispatch(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":prepared.x,"y":prepared.y,
                "detail":{"x":prepared.x,"y":prepared.y},"button":0,"buttons":0,"bubbles":true}]}),
        );
        self.finish_node_dispatch(result, next_action, next_pump)?;
        Ok(prepared.proof)
    }

    // This publication boundary sees the real dispatcher outcome, including
    // failures that may follow guest effects. It never returns an input proof.
    #[cfg(feature = "accepted-frame-node-input")]
    fn finish_node_dispatch(
        &mut self,
        result: Result<BridgeBatch>,
        next_action: u64,
        next_pump: u64,
    ) -> Result<()> {
        self.required_pump_sequence = next_pump;
        if let Err(error) = result {
            self.rendered = None;
            return Err(error);
        }
        self.action_sequence = next_action;
        Ok(())
    }

    pub fn current_page(&self) -> Result<Value> {
        let completion = self.completion()?;
        Ok(
            json!({"path":completion["route"],"pageId":completion["pageId"],"completion":completion}),
        )
    }

    fn require_next_owner_pump(&mut self) -> Result<()> {
        self.action_sequence = self
            .action_sequence
            .checked_add(1)
            .ok_or("native action sequence exhausted")?;
        self.required_pump_sequence = self
            .owner_pump_sequence
            .checked_add(1)
            .ok_or("native required pump sequence exhausted")?;
        Ok(())
    }

    fn require_presented(&self) -> Result<()> {
        if self.exception_closed() {
            return Err("source exception close retired this Session".into());
        }
        if self.stable() {
            Ok(())
        } else {
            Err("observation/input awaits current native frame presentation".into())
        }
    }

    pub fn relaunch(&mut self, requested: &str) -> Result<Value> {
        self.require_presented()?;
        let route = self.pack.route(requested)?;
        self.dispatch(
            op::API_CALL,
            json!({"name":"wx.reLaunch","url":format!("/{route}")}),
        )?;
        let actual = self.route()?;
        if actual != route {
            return Err("native reLaunch did not activate the requested actual page".into());
        }
        self.rendered = None;
        self.require_next_owner_pump()?;
        Ok(json!({"path":actual}))
    }

    pub fn assert_route(&self, requested: &str) -> Result<()> {
        if self.pack.route(requested)? != self.route()? {
            return Err("native operation belongs to another current page route".into());
        }
        Ok(())
    }

    pub fn query(&self, query: &observation::Query, read_text: bool) -> Result<Value> {
        self.require_presented()?;
        let observation = self
            .host
            .accepted_page_observation()?
            .ok_or("no accepted native frame")?;
        let mut value = if read_text {
            observation::query_text(observation.frame, query)?
        } else {
            observation::query(observation.frame, query)?
        };
        value["route"] = json!(self.route()?);
        value["frameId"] = json!(observation.frame.frame_id);
        value["renderRevision"] = json!(observation.render_revision);
        value["completion"] = self.completion()?;
        Ok(value)
    }

    pub fn query_attribute(&self, query: &observation::Query, name: &str) -> Result<Value> {
        self.require_presented()?;
        let accepted = self
            .host
            .accepted_page_observation()?
            .ok_or("no accepted native frame")?;
        let mut value = observation::query_attribute(accepted.frame, query, name)?;
        value["route"] = json!(self.route()?);
        value["frameId"] = json!(accepted.frame.frame_id);
        value["renderRevision"] = json!(accepted.render_revision);
        value["completion"] = self.completion()?;
        Ok(value)
    }

    pub fn tap(&mut self, query: &observation::Query) -> Result<Value> {
        self.require_presented()?;
        let observation = self
            .host
            .accepted_page_observation()?
            .ok_or("no accepted native frame")?;
        let (x, y) = observation::tap_point(observation.frame, query)?;
        let mut proof = json!({"route":self.route()?,"selector":query.selector,"x":x,"y":y,
            "frameId":observation.frame.frame_id,"renderRevision":observation.render_revision,
            "inputTransport":"native-host-coordinate-event","inputCompletion":self.completion()?});
        for (key, value) in query
            .evidence()
            .as_object()
            .ok_or("query address evidence must be an object")?
        {
            proof[key] = value.clone();
        }
        self.dispatch(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":x,"y":y,
            "detail":{"x":x,"y":y},"button":0,"buttons":0,"bubbles":true}]}),
        )?;
        self.require_next_owner_pump()?;
        Ok(proof)
    }

    pub fn checkpoint(&self, id: &str, queries: &[observation::Query]) -> Result<Value> {
        self.require_presented()?;
        let observation = self
            .host
            .accepted_page_observation()?
            .ok_or("no accepted native frame")?;
        let mut value = observation::checkpoint(observation.frame, id, &self.route()?, queries)?;
        value["completion"] = self.completion()?;
        Ok(value)
    }

    pub fn startup(
        &mut self,
        target: &Value,
        host_surface: bool,
        gpu_surface: bool,
    ) -> Result<Value> {
        self.require_presented()?;
        if self.startup_frozen {
            return Err("native startup evidence was already frozen".into());
        }
        #[cfg(feature = "accepted-frame-observation")]
        let accepted_frame_capability = self
            .accepted_frame_observer
            .capability(self.accepted_frame_binding()?, &self.session_id);
        let profile = self
            .presenter_profile
            .ok_or("non-UI preflight cannot produce startup evidence")?;
        match profile {
            PresenterProfile::MacosMetal => {
                if !host_surface
                    || !gpu_surface
                    || !self.host.has_gpu_surface()?
                    || self.host.renderer_backend()? != "skia-gpu-metal"
                {
                    return Err("startup evidence requires a real presented Metal drawable".into());
                }
            }
            PresenterProfile::LinuxSoftware => {
                if !host_surface
                    || gpu_surface
                    || self.host.has_gpu_surface()?
                    || self.host.renderer_backend()? != "software-fallback"
                {
                    return Err(
                        "startup evidence requires an explicitly selected real software window"
                            .into(),
                    );
                }
            }
        }
        let snapshot = self.host.capture_render_snapshot()?;
        let digest = hex_digest(&snapshot.pixels);
        let compact = json!({"frame_id":snapshot.frame_id,"width":snapshot.width,"height":snapshot.height,
            "format":"rgba8-premultiplied","pixelCount":snapshot.pixels.len(),"sha256":digest});
        self.startup_operations.insert(
            "render.snapshot".into(),
            json!({"status":0,"sessionId":self.session_id,"json":serde_json::to_string(&compact)?}),
        );
        self.startup_frozen = true;
        let mut result = json!({"status":"passed","host":profile.host(),"engine":self.engine,"sessionId":self.session_id,
            "manifestIntegrity":self.pack.manifest.integrity.root,"route":self.route()?,"target":target,
            "operations":self.startup_operations,"surfaceProbe":{"schemaVersion":1,"status":"passed",
            "host":profile.host(),"engine":self.engine,"sessionId":self.session_id,
            "manifestIntegrity":self.pack.manifest.integrity.root,"frameId":snapshot.frame_id,
            "snapshotSha256":digest,"hostSurfaceAttached":host_surface,"containerSurfaceAttached":self.host.has_gpu_surface()?,
            "gpuSurface":gpu_surface,"rendererBackend":self.host.renderer_backend()?,
            "evidenceBoundary":"runtime-skia-metal-drawable","gpuCompletion":"command-submitted"}});
        if profile == PresenterProfile::LinuxSoftware {
            result["presenterProfile"] = json!("software");
            result["surfaceProbe"]["presenterBackend"] = json!("softbuffer-raster");
            result["surfaceProbe"]["evidenceBoundary"] = json!("runtime-software-native-window");
            result["surfaceProbe"]["presentationCompletion"] = json!("buffer-submitted");
            result["surfaceProbe"]
                .as_object_mut()
                .unwrap()
                .remove("gpuCompletion");
        }
        #[cfg(feature = "accepted-frame-observation")]
        {
            result["acceptedFrameObservation"] = accepted_frame_capability;
        }
        #[cfg(feature = "accepted-frame-node-input")]
        {
            result["acceptedFrameNodes"] = crate::accepted_frame_nodes::capability(
                &self.accepted_frame_observer,
                self.accepted_frame_binding()?,
                &self.session_id,
            );
        }
        #[cfg(feature = "conformance-exception-channel")]
        {
            result["capabilities"] = json!(["bounded-session-exceptions-v1"]);
            result["exceptionIncarnation"] = json!(self.exceptions.incarnation);
        }
        #[cfg(feature = "conformance-observation")]
        {
            result["runtimeDataObservation"] = json!({"kind":"private-receiver-data-and-runtime-journal-v1",
                "incarnation":self.runtime_log_incarnation,"flatDataPaths":true,
                "journalBegins":"native-realm-bootstrap-before-app-modules","maxEntries":1024,"maxTextUnits":65536});
        }
        Ok(result)
    }

    pub fn exception_closed(&self) -> bool {
        #[cfg(feature = "conformance-observation")]
        if self.runtime_log_closed {
            return true;
        }
        #[cfg(feature = "conformance-exception-channel")]
        {
            return self.exceptions.closed;
        }
        #[cfg(not(feature = "conformance-exception-channel"))]
        {
            false
        }
    }
    pub fn inspection_route(&self) -> Result<String> {
        #[cfg(feature = "conformance-observation")]
        if self.runtime_log_closed {
            return self
                .runtime_log_route
                .clone()
                .ok_or_else(|| "closed runtime journal Session has no last route".into());
        }
        #[cfg(feature = "conformance-exception-channel")]
        if self.exceptions.closed {
            return self
                .exceptions
                .route
                .clone()
                .ok_or_else(|| "closed Session has no last route".into());
        }
        self.route()
    }

    pub fn transcript(&self) -> Value {
        json!(self.transcript)
    }
}

/// No window, Metal presenter, presentation ACK or guest method is created.
/// Reuses the real Pack, construction, bridge startup and pump code above.
#[cfg(feature = "conformance-observation")]
pub fn preflight(pack: Pack, engine: EngineKind) -> Result<Value> {
    let mut native = NativeSession::new_with_render_mode(
        pack,
        engine,
        "method-fixture-preflight-v2".into(),
        375,
        667,
        PageRenderMode::Raster,
    )?;
    let result = (|| -> Result<Value> {
        let now = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos(),
        )?;
        native.pump(now)?;
        let route = native.route()?;
        let session = native.host.session_mut().ok_or("preflight unloaded")?;
        let acquired = session.acquire_conformance_page(&route);
        ensure_success(&acquired.effects)?;
        let binding = acquired.result?;
        let checked = session.validate_conformance_binding(
            &binding,
            now.checked_add(30_000_000_000)
                .ok_or("preflight deadline overflow")?,
        );
        checked?;
        let accepted = native
            .host
            .accepted_page_observation()?
            .ok_or("preflight has no accepted raster frame")?;
        let session = native.host.session().ok_or("preflight unloaded")?;
        let input = session
            .last_frame_input(accepted.render_revision)
            .ok_or("preflight frame has no consumed input")?;
        if input.route_path != route
            || input.page_id != binding.page_id()
            || input.template_revision != session.view().template_revision
        {
            return Err("preflight accepted frame input is stale".into());
        }
        let value = observation::query_text(
            accepted.frame,
            &observation::Query::parse(&json!("#value"))?,
        )?;
        let calls = observation::query_text(
            accepted.frame,
            &observation::Query::parse(&json!("#calls"))?,
        )?;
        if value["text"] != "1" || calls["text"] != "0" {
            return Err(
                "preflight fixture initial state does not match actual raster output".into(),
            );
        }
        Ok(
            json!({"kind":"local-method-pack-non-ui-preflight-v2","official":false,
            "engine":engine,"strictPackRead":true,"route":route,
            "manifestIntegrity":native.pack.manifest.integrity.root,
            "frameId":accepted.frame.frame_id.to_string(),
            "renderRevision":accepted.render_revision.to_string(),
            "consumedTemplateRevision":input.template_revision.to_string(),
            "rendererBackend":native.host.renderer_backend()?,
            "privateReceiverValidated":true,"value":value,"calls":calls,
            "guestMethodBeginAttempts":0,"windowCreated":false,
            "metalPresentationObserved":false,"nativePresentationAckAttempts":0,
            "nativeDeliveryValidated":false}),
        )
    })();
    native.host.unload();
    let unloaded = !native.host.has_session();
    if !unloaded {
        return Err("preflight failed to unload owned Session".into());
    }
    let mut result = result?;
    result["ownedSessionUnloaded"] = json!(unloaded);
    Ok(result)
}

pub fn ensure_success(batch: &BridgeBatch) -> Result<()> {
    if let Some(failure) = batch.messages.iter().find(|message| {
        message.op == op::ERROR
            || message.payload.get("ok") == Some(&Value::Bool(false))
            || message
                .payload
                .get("error")
                .is_some_and(|error| !error.is_null())
    }) {
        return Err(format!("runtime operation failed: {}", failure.payload).into());
    }
    Ok(())
}

#[cfg(all(
    test,
    any(feature = "quickjs-native", feature = "v8-native"),
    any(target_os = "macos", target_os = "linux")
))]
mod tests {
    use super::*;
    use std::path::Path;

    // Real Session/engine/Skia scheduling and real pipe backpressure, but no
    // native window, presentation ACK or UI evidence is claimed by this test.
    #[cfg(feature = "conformance-observation")]
    #[test]
    fn actual_owner_session_pumps_while_stdout_pipe_is_backpressured() {
        use std::os::fd::{FromRawFd, OwnedFd};
        use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
        for engine in [
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ] {
            let pack = Pack::read(
                &Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../conformance/recipes/fixtures/issue1058"),
            )
            .unwrap();
            let mut native =
                NativeSession::new(pack, engine, "backpressure-no-window".into(), 375, 667)
                    .unwrap();
            #[cfg(target_os = "linux")]
            native.pump(1).unwrap();
            let mut fds = [-1; 2];
            assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
            let reader = unsafe { OwnedFd::from_raw_fd(fds[0]) };
            let mut output =
                crate::method_output::Output::new(unsafe { OwnedFd::from_raw_fd(fds[1]) }).unwrap();
            output
                .enqueue(
                    &json!({"inspect":"x".repeat(512 * 1024)}),
                    Instant::now() + Duration::from_millis(150),
                )
                .unwrap();
            let before = native.owner_pump_sequence;
            let mut reports = Vec::new();
            while !output.is_idle() {
                let now_ns = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
                    .min(u64::MAX as u128) as u64;
                native.pump(now_ns).unwrap();
                reports.extend(output.poll());
                std::thread::sleep(Duration::from_millis(1));
            }
            assert!(native.owner_pump_sequence > before + 5);
            assert!(
                !native.stable(),
                "without a window no presentation may be accepted"
            );
            assert_eq!(reports.len(), 1);
            assert!(reports[0].result.is_err());
            assert!(
                reports[0].bytes_written.unwrap() > 0
                    && reports[0].bytes_written.unwrap() < 512 * 1024
            );
            assert!(output.finish().is_err());
            native.host.unload();
            assert!(!native.host.has_session());
            drop(reader);
        }
    }

    #[cfg(feature = "accepted-frame-observation")]
    #[test]
    fn accepted_frame_observer_rejects_unpresented_reads_and_metadata_engine_swaps() {
        for engine in [
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ] {
            let pack = Pack::read(
                &Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../conformance/recipes/fixtures/issue1058"),
            )
            .unwrap();
            let mut native = NativeSession::new_with_render_mode(
                pack,
                engine,
                "observer-unpresented-local".into(),
                375,
                667,
                PageRenderMode::Raster,
            )
            .unwrap();
            native.pump(1).unwrap();
            let transcript = native.transcript();
            let revision = native.host.render_revision();
            let frame = serde_json::to_vec(
                native
                    .host
                    .accepted_page_observation()
                    .unwrap()
                    .unwrap()
                    .frame,
            )
            .unwrap();
            assert!(!native.stable());
            let capabilities = json!({"id":1,"op":"accepted-frame.capabilities.v1","version":1});
            let observation = json!({"id":2,"op":"accepted-frame.observe.v1","version":1,
                "route":native.route().unwrap(),"target":{"query":{"selector":"*"}},"fields":["computed.display"]});
            assert!(
                native
                    .accepted_frame_capabilities(&capabilities)
                    .unwrap_err()
                    .to_string()
                    .contains("presentation")
            );
            assert!(
                native
                    .accepted_frame_observe(&observation)
                    .unwrap_err()
                    .to_string()
                    .contains("presentation")
            );
            assert_eq!(native.transcript(), transcript);
            assert_eq!(native.host.render_revision(), revision);
            assert_eq!(
                serde_json::to_vec(
                    native
                        .host
                        .accepted_page_observation()
                        .unwrap()
                        .unwrap()
                        .frame
                )
                .unwrap(),
                frame
            );
            #[cfg(feature = "accepted-frame-node-input")]
            {
                assert!(native
                    .node_capabilities(
                        &json!({"id":3,"op":"accepted-frame.nodes.capabilities.v1","version":1})
                    )
                    .is_err());
                assert!(native.acquire_nodes(&json!({"id":4,"op":"accepted-frame.nodes.acquire.v1","version":1,
                    "route":native.route().unwrap(),"target":{"query":{"selector":"*"}},"selection":"first"})).is_err());
                assert!(native
                    .tap_node(
                        &json!({"id":5,"op":"accepted-frame.nodes.tap.v1","version":1,
                    "route":native.route().unwrap(),"node":null})
                    )
                    .is_err());
                assert_eq!(native.transcript(), transcript);
                assert_eq!(native.action_sequence, 0);
                assert_eq!(native.required_pump_sequence, 0);
            }
            assert_eq!(native.acknowledged_revision, 0);
            assert_eq!(native.accepted_frame_binding().unwrap(), engine);
            native.engine = match engine {
                EngineKind::Quickjs => EngineKind::V8,
                EngineKind::V8 => EngineKind::Quickjs,
            };
            assert!(native.accepted_frame_binding().is_err());
            native.engine = engine;
            native.session_id = "substituted-session".into();
            assert!(native.accepted_frame_binding().is_err());
            native.host.unload();
            assert!(!native.host.has_session());
        }
    }

    #[cfg(feature = "accepted-frame-node-input")]
    #[test]
    fn failed_actual_node_dispatch_retires_frame_without_action_or_success_completion() {
        for engine in [
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ] {
            let pack = Pack::read(
                &Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../conformance/recipes/fixtures/issue1058"),
            )
            .unwrap();
            let mut native = NativeSession::new_with_render_mode(
                pack,
                engine,
                "node-dispatch-failure-no-window".into(),
                375,
                667,
                PageRenderMode::Raster,
            )
            .unwrap();
            native.pump(1).unwrap();
            assert!(native.rendered.is_some());
            assert!(!native.stable());
            // Genuine dispatcher payload rejection in a local raster Session.
            // This exercises the failure publication boundary, without an ACK
            // bypass or a claim about native-window or post-effect failures.
            let result = native.dispatch(
                op::EVENT_BATCH,
                json!({"events":"invalid-local-negative-fixture"}),
            );
            let original = result.as_ref().unwrap_err().to_string();
            assert!(original.contains("event.batch payload"));
            let next_action = native.action_sequence + 1;
            let next_pump = native.owner_pump_sequence + 1;
            let error = native
                .finish_node_dispatch(result, next_action, next_pump)
                .unwrap_err();
            assert_eq!(error.to_string(), original);
            assert_eq!(native.action_sequence, 0);
            assert_eq!(native.required_pump_sequence, next_pump);
            assert!(native.rendered.is_none());
            assert!(native.completion().is_err());
            assert_eq!(native.acknowledged_revision, 0);
            native.host.unload();
            assert!(!native.host.has_session());
        }
    }

    #[test]
    fn loaded_native_runtime_cannot_query_or_tap_before_window_presentation() {
        for engine in [
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ] {
            let pack = Pack::read(
                &Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../conformance/recipes/fixtures/issue1058"),
            )
            .unwrap();
            let mut native =
                NativeSession::new(pack, engine, "unpresented-test".into(), 375, 667).unwrap();
            assert_eq!(native.route().unwrap(), "pages/home/index");
            assert!(!native.stable());
            #[cfg(target_os = "linux")]
            {
                native.pump(1).unwrap();
                assert_eq!(
                    native.host.session().unwrap().page_render_mode(),
                    PageRenderMode::Raster
                );
                assert_eq!(native.host.renderer_backend().unwrap(), "software-fallback");
                assert!(!native.host.has_gpu_surface().unwrap());
                assert_eq!(
                    native.host.session().unwrap().raster_presentation_policy(),
                    container_runtime::RasterPresentationPolicy::ExplicitDev
                );
                assert!(!native.host.session().unwrap().is_current_frame_presented());
                assert!(native.acknowledge(native.host.render_revision()).is_err());
                assert!(!native.host.session().unwrap().is_current_frame_presented());
                assert!(!native.stable());
                assert!(
                    native
                        .startup(&json!({"kind":"native-window","host":"linux"}), true, false)
                        .is_err()
                );
                assert!(native.current_page().is_err());
                assert!(native.completion().is_err());
            }
            assert!(
                native
                    .checkpoint("before", &[observation::Query::flat("#builtin")])
                    .is_err()
            );
            assert!(
                native
                    .query(&observation::Query::flat("#builtin"), true)
                    .is_err()
            );
            assert!(native.tap(&observation::Query::flat("#increment")).is_err());
            native.host.unload();
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn failed_actual_runtime_submission_keeps_guest_state_and_all_observations_pending() {
        for engine in [
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ] {
            let pack = Pack::read(
                &Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../conformance/recipes/fixtures/issue1058"),
            )
            .unwrap();
            let mut native =
                NativeSession::new(pack, engine, "failed-submit-no-window".into(), 375, 667)
                    .unwrap();
            native.pump(1).unwrap();
            let snapshot = native.host.render_snapshot().unwrap();
            let revision = native.host.render_revision();
            let data = native
                .host
                .session()
                .unwrap()
                .app_service()
                .pages()
                .current()
                .unwrap()
                .data
                .clone();
            let transcript = native.transcript();
            let mut owner = crate::software_owner::SoftwarePublicationOwner::new(
                "negative-unit-no-window".into(),
            );
            let target = owner
                .prepare(
                    native.session_id.clone(),
                    snapshot.frame_id,
                    revision,
                    (375, 667),
                    (snapshot.width, snapshot.height),
                )
                .unwrap();
            let failure = crate::software_owner::submit_raster_publication(
                &mut owner,
                native.host.session_mut().unwrap(),
                target,
                || Err("injected submit failure; no native window exists".into()),
            );
            assert!(failure.is_err());
            let session = native.host.session().unwrap();
            assert!(session.current_dev_raster_presentation_ticket().is_none());
            assert!(!session.is_current_frame_presented());
            assert_eq!(session.app_service().pages().current().unwrap().data, data);
            assert_eq!(native.transcript(), transcript);
            assert!(!native.stable());
            assert!(native.completion().is_err());
            assert!(native.current_page().is_err());
            assert!(
                native
                    .query(&observation::Query::flat("#builtin"), true)
                    .is_err()
            );
            assert!(
                native
                    .checkpoint("failed", &[observation::Query::flat("#builtin")])
                    .is_err()
            );
            assert!(native.tap(&observation::Query::flat("#increment")).is_err());
            native.host.unload();
            assert!(!native.host.has_session());
        }
    }
}
