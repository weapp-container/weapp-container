//! A development pack is evaluated once in an isolated View realm. The live
//! renderer accepts that exact candidate before metadata/resources publish.
use super::*;

impl Session {
    /// Replace a Skia presentation while retaining AppService, page/component
    /// instances, storage and timers. Candidate failure leaves the accepted
    /// manifest, resources, frame and input authority untouched.
    ///
    /// The caller supplies an unstarted candidate Session and the ordinary
    /// manifest-render payload. Unlike preview followed by render.commit, this
    /// does not repeat View evaluation or component work in the live Session.
    /// Post-publication presentation diagnostics are returned in the batch;
    /// they never turn an accepted generation into a rejected replacement.
    pub fn replace_dev_presentation(
        &mut self,
        candidate: &mut Session,
        payload: &Value,
    ) -> Result<BridgeBatch, BridgeError> {
        let request = BridgeEnvelope::request(
            self.config.session_id.clone(),
            format!("dev-presentation-{}", self.presentation_generation),
            op::RENDER_COMMIT,
            payload.clone(),
        );
        self.replace_dev_presentation_request(candidate, &request)
    }

    /// Preserve the caller's request identity across atomic publication and
    /// the presentation callbacks that can fail after pixels are accepted.
    pub fn replace_dev_presentation_request(
        &mut self,
        candidate: &mut Session,
        request: &BridgeEnvelope,
    ) -> Result<BridgeBatch, BridgeError> {
        self.ensure_dev_presentation_allowed()?;
        if request.kind != EnvelopeKind::Request
            || request.op != op::RENDER_COMMIT
            || request.session_id != self.config.session_id
        {
            return Err(BridgeError::invalid(
                "development presentation requires this session's render.commit request",
            ));
        }
        let payload = &request.payload;
        self.ensure_initialized()?;
        self.ensure_engine_execution_healthy()?;
        self.ensure_view_execution_healthy()?;
        if self.requires_dev_restart() || self.navigation_blocks_presentation() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "development presentation requires a stable live owner",
            ));
        }
        if self.browser_route_active() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "WebView development replacement requires its browser transaction",
            ));
        }
        let protocol = self.validate_dev_presentation_manifest(candidate)?;
        let next_manifest = candidate.manifest.clone();
        let generation = self.presentation_generation.checked_add(1).ok_or_else(|| {
            BridgeError::new(BridgeErrorCode::Render, "presentation generation exhausted")
        })?;
        let object = object_payload(payload)?;
        let viewport = parse_render_viewport(object.get("viewport"))?;
        let resources = candidate.render_resources(object)?;
        candidate.validate_dev_presentation_resources(&resources, viewport)?;
        if dev_reload::classify_pack_reload(
            &self.manifest,
            &self.render_blobs,
            &candidate.manifest,
            &resources,
        ) != dev_reload::DevReloadKind::InPlace
        {
            return Err(BridgeError::invalid(
                "development presentation changes retained View or component inputs; restart the session",
            ));
        }
        candidate.component_pages.clear();
        self.prepare_dev_component_snapshots(candidate)?;
        let page_input = self
            .app_service
            .pages()
            .current()
            .filter(|_| !object.contains_key("data"))
            .map(|page| BrowserPageInput {
                page_id: page.id,
                route_path: page.path.clone(),
                template_revision: self.view.template_revision,
                viewport,
            });
        let (document, preflight, scroll_enabled) = candidate
            .with_engine_host_turn_deadline(self.engine_turn_deadline, |candidate| {
                candidate.prepare_manifest_skia_document(object, Some(self))
            })?;
        // Layout belongs to the retained host renderer: portable/native fonts
        // and the eventual painter must share one provider. Materialization
        // clones its image cache and publishes neither a frame nor resources.
        let mut prepared = self.skia_backend.materialize(
            &candidate.manifest,
            document,
            preflight,
            scroll_enabled,
        )?;
        // Detached previews intentionally carry no live scheduling proof. This
        // exclusive operation captured the live input before candidate work,
        // and no live VM or callback ran while that snapshot was evaluated.
        let route = self
            .app_service
            .pages()
            .current()
            .map(|page| page.path.as_str());
        prepared.set_page_input(page_input.filter(|input| {
            route == Some(input.route_path.as_str())
                && prepared_route(payload) == Some(input.route_path.as_str())
        }));
        let mut scrolling = self.scrolling.clone();
        scrolling.reconcile(
            self.app_service.pages().current().map(|page| page.id),
            prepared.frame_mut(),
            true,
        )?;
        let canvas_bindings = self.prepare_owned_canvas_bindings(prepared.frame(), true)?;
        let component_indexes = self.prepare_dev_component_indexes(candidate)?;
        // Preview preparation does not stage animation playback. Its immutable
        // component snapshots retain JS state, while a new stylesheet begins a
        // fresh native animation binding lifetime just like manifest reload.
        debug_assert!(prepared.animations().is_none());
        let accepted = self
            .skia_backend
            .accept_with_canvas_bindings(prepared, canvas_bindings.keys.clone())?;
        let manifest = accepted.manifest.expect("development manifest candidate");

        // Every fallible validation, View evaluation, image decode, layout and
        // renderer preparation is complete. No VM, callback or fallible work
        // may separate acceptance from these joint publication field moves.
        self.protocol = protocol;
        self.manifest = next_manifest;
        self.presentation_generation = generation;
        self.invalidate_engine_host_environment();
        *self.chrome_catalog.borrow_mut() = None;
        self.invalidate_browser_presentation();
        self.animation_writes.retire_all();
        self.animation_bindings.retire_all();
        self.animation_playback.retire_all();
        self.accept_owned_canvas_bindings(canvas_bindings);
        self.render_blobs = manifest.resources;
        self.render_resources_verified = true;
        if let Some(page) = self.app_service.pages().current().map(|page| page.id) {
            if let Some(graph) = candidate.component_pages.remove(&page) {
                self.component_pages.insert(page, graph);
            }
        }
        self.scrolling = scrolling;
        self.accepted_view_document = Some(manifest.document);
        self.accepted_skia_scene = true;
        self.record_last_frame_input(manifest.page_input);
        self.capture_consumed_component_inputs();
        self.view.last_frame_id = Some(accepted.frame_id);
        self.observer_frame_page = self.app_service.pages().current().map(|page| page.id);
        self.observer_frame_valid = false;
        self.presented_revision = None;
        self.pending_presentation = Some((self.observer_frame_page, accepted.frame_id, true));
        self.install_skia_frame_authority();
        drop(accepted.retired_page);

        let mut messages = vec![self.response(
            request,
            json!({"ok":true,"committed":true,"frameId":accepted.frame_id,
                "backend":self.skia_backend.renderer.backend_name(),"revision":self.view.revision,
                "source":"manifest","templateId":object.get("templateId"),"generation":generation}),
        ), self.diagnostic(
            request,
            "debug",
            "development presentation committed",
            json!({"generation":generation,"frameId":accepted.frame_id,"root":self.manifest.integrity.root}),
        )];
        if let Err(error) = self.commit_dev_component_indexes(component_indexes) {
            messages.push(self.render_commit_diagnostic(
                request,
                accepted.frame_id,
                "component metadata",
                &error,
            ));
        }
        self.append_browser_retirement_messages(&mut messages);
        if self.skia_backend.renderer.page_render_mode() == PageRenderMode::Raster
            && !self.dev_raster_presentation_required()
        {
            let revision = self.render_revision();
            match self.acknowledge_presentation(revision) {
                Ok(batch) => messages.extend(batch.messages),
                Err(error) => messages.push(self.render_commit_diagnostic(
                    request,
                    accepted.frame_id,
                    "presentation",
                    &error,
                )),
            }
        }
        Ok(BridgeBatch::new(messages))
    }

    pub(super) fn ensure_dev_presentation_allowed(&self) -> Result<(), BridgeError> {
        // Both Skia replacement and browser staging share this admission
        // boundary. An allowlisted pack does not authorize development reload.
        if is_restricted_showcase() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "development manifest replacement is disabled in this distribution",
            ));
        }
        Ok(())
    }

    pub(super) fn validate_dev_presentation_manifest(
        &self,
        candidate: &Session,
    ) -> Result<ProtocolVersion, BridgeError> {
        self.ensure_dev_presentation_allowed()?;
        candidate
            .manifest
            .validate()
            .map_err(|error| SessionError::Manifest(error).bridge_error())?;
        if candidate.initialized {
            return Err(BridgeError::invalid(
                "development presentation requires an unstarted candidate session",
            ));
        }
        if self.config.require_integrity || !candidate.manifest.integrity.root.is_empty() {
            candidate
                .manifest
                .verify_integrity()
                .map_err(|error| SessionError::Manifest(error).bridge_error())?;
        }
        let version =
            ProtocolVersion::parse(&candidate.manifest.protocol_version).map_err(|error| {
                BridgeError::new(BridgeErrorCode::ProtocolVersion, error.to_string())
            })?;
        let protocol =
            negotiate_protocol(ProtocolVersion::current(), version).map_err(|error| {
                BridgeError::new(BridgeErrorCode::ProtocolVersion, error.to_string())
            })?;
        candidate
            .ensure_view_execution_supported()
            .map_err(|error| error.bridge_error())?;
        if protocol.major != self.protocol.major
            || self.config.engine != candidate.config.engine
            || self.config.renderer_override != candidate.config.renderer_override
            || !self
                .manifest
                .can_replace_presentation_with(&candidate.manifest)
        {
            return Err(BridgeError::invalid(
                "development presentation changes execution or configuration; restart the session",
            ));
        }
        Ok(protocol)
    }

    pub(super) fn validate_dev_presentation_resources(
        &self,
        blobs: &BTreeMap<String, Vec<u8>>,
        viewport: Rect,
    ) -> Result<(), BridgeError> {
        self.validate_view_resources(blobs)?;
        // Validate the complete presentation closure, including inactive routes
        // and assets. A visible first frame cannot authorize an incomplete pack.
        for template in &self.manifest.templates {
            let bytes = verified_blob(blobs, &template.wxml_ast)?;
            decode_wxml(bytes)
                .map_err(|error| BridgeError::new(BridgeErrorCode::Render, error.to_string()))?;
        }
        for style in &self.manifest.styles {
            verified_blob(blobs, &style.wxss_ir)?;
            styles::resolve_render_styles(
                &self.manifest,
                std::slice::from_ref(&style.id),
                blobs,
                viewport,
            )?;
        }
        for asset in &self.manifest.assets {
            let pointer = format!("sha256:{}", asset.sha256);
            let bytes = verified_blob(blobs, &pointer)?;
            if bytes.len() as u64 != asset.size {
                return Err(BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("asset {} size does not match the manifest", asset.path),
                ));
            }
        }
        Ok(())
    }
}

fn verified_blob<'a>(
    blobs: &'a BTreeMap<String, Vec<u8>>,
    pointer: &str,
) -> Result<&'a [u8], BridgeError> {
    let bytes = lookup_render_blob(blobs, pointer)?;
    if pointer.strip_prefix("sha256:") != Some(container_ir::hex_digest(bytes).as_str()) {
        return Err(BridgeError::new(
            BridgeErrorCode::Render,
            format!("presentation blob {pointer} SHA-256 mismatch"),
        ));
    }
    Ok(bytes)
}

fn prepared_route(payload: &Value) -> Option<&str> {
    let template = payload
        .get("templateId")
        .or_else(|| payload.get("template_id"))?
        .as_str()?;
    let path = template.strip_prefix("template:").unwrap_or(template);
    Some(path.strip_suffix(".wxml").unwrap_or(path))
}
