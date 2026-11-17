//! Isolated development declarations stay private until their exact browser ACK.
use super::*;

pub(super) struct DevBrowserPresentation {
    manifest: ContainerManifestV1,
    protocol: ProtocolVersion,
    prepared: Option<PreparedViewDocument>,
    graph: Option<components::ManagedPage>,
    expected_render: Value,
    page: PageId,
    route: String,
    root_revision: u64,
    input_lifetime: Option<u64>,
    surface_generation: u64,
    base_generation: u64,
    generation: u64,
    receiver_snapshot: Option<Value>,
    previous: Option<(PresentationKey, BrowserCommitPermit, Option<Value>)>,
    pub(super) live_bindings: Option<live::LiveBindings>,
}

#[derive(Clone)]
pub(super) struct DevBrowserRestoration {
    key: PresentationKey,
    permit: BrowserCommitPermit,
    input_lifetime: u64,
    receiver_snapshot: Option<Value>,
}

fn scopes(document: &ViewDocument) -> Vec<String> {
    let mut result = BTreeSet::new();
    let mut nodes: Vec<_> = document.nodes.iter().collect();
    while let Some(node) = nodes.pop() {
        let owner = node.ownership();
        for scope in [
            &owner.event_owner,
            &owner.component_scope,
            &owner.slot_owner,
        ]
        .into_iter()
        .flatten()
        {
            result.insert(scope.clone());
        }
        if let container_ir::ViewNode::Element { children, .. } = node {
            nodes.extend(children);
        }
    }
    result.into_iter().collect()
}

impl Session {
    /// Owner-side staging status. It grants no document or input authority.
    pub fn browser_dev_presentation_pending(&self) -> bool {
        self.browser_view.development.is_some()
            || self
                .browser_view
                .pending
                .as_ref()
                .is_some_and(|p| p.development.is_some())
    }

    /// Monotonic accepted development generation; staging never advances it.
    pub fn browser_dev_presentation_generation(&self) -> u64 {
        self.presentation_generation
    }

    pub(super) fn stage_dev_browser_presentation(
        &mut self,
        candidate: &mut Session,
        payload: &Value,
    ) -> Result<(), BridgeError> {
        self.ensure_initialized()?;
        if self.navigation_blocks_presentation()
            || self.browser_view.pending.is_some()
            || self.browser_view.sample_pending.is_some()
        {
            return Err(stale(
                "development presentation requires a stable browser owner",
            ));
        }
        let protocol = self.validate_dev_presentation_manifest(candidate)?;
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
            return Err(invalid(
                "development presentation changes retained execution inputs",
            ));
        }
        let page = self
            .app_service
            .pages()
            .current()
            .ok_or_else(|| stale("development presentation requires a page"))?;
        let page_id = page.id;
        let route = page.path.clone();
        let generation = self
            .presentation_generation
            .checked_add(1)
            .ok_or_else(|| invalid("presentation generation exhausted"))?;
        let mut render = object.clone();
        if !render.contains_key("frameId") && !render.contains_key("frame_id") {
            render.insert(
                "frameId".into(),
                json!(self
                    .view
                    .last_frame_id
                    .unwrap_or(0)
                    .checked_add(1)
                    .ok_or_else(|| invalid("document revision exhausted"))?),
            );
        }
        let mut prepared =
            candidate.with_engine_host_turn_deadline(self.engine_turn_deadline, |candidate| {
                let input = candidate.load_manifest_view_input(&render, Some(self))?;
                candidate.evaluate_manifest_view_input(input, Some(self))
            })?;
        if prepared.input.route_path != route || prepared.document.page_id != page_id.0 {
            return Err(stale(
                "development template does not belong to the active page",
            ));
        }
        ViewTopology::from_document(&prepared.document).map_err(|e| invalid(e.to_string()))?;
        prepared.input.page_input = (!object.contains_key("data")).then(|| BrowserPageInput {
            page_id,
            route_path: route.clone(),
            template_revision: self.view.template_revision,
            viewport,
        });
        let receiver_snapshot = self
            .engine_provider_available()
            .then(|| self.live_receiver_snapshot(page_id.0, &scopes(&prepared.document)))
            .transpose()?;
        let previous_document = self
            .browser_view
            .presented
            .as_ref()
            .filter(|_| self.is_browser_view_presented())
            .map(|p| {
                (
                    p.submission.key.clone(),
                    p.permit.clone(),
                    p.submission.document.clone(),
                )
            });
        let previous = previous_document
            .map(|(key, permit, document)| {
                let snapshot = self
                    .engine_provider_available()
                    .then(|| self.live_receiver_snapshot(page_id.0, &scopes(&document)))
                    .transpose()?;
                Ok::<_, BridgeError>((key, permit, snapshot))
            })
            .transpose()?;
        let mut expected = object.clone();
        expected.remove("blobs");
        expected.insert("useSessionResources".into(), json!(true));
        self.browser_view.development_abort = None;
        self.browser_view.development = Some(DevBrowserPresentation {
            manifest: candidate.manifest.clone(),
            protocol,
            prepared: Some(prepared),
            graph: candidate.component_pages.remove(&page_id),
            expected_render: Value::Object(expected),
            page: page_id,
            route,
            root_revision: self.view.template_revision,
            input_lifetime: self.input_lifetime_revision,
            surface_generation: self.browser_view.generation,
            base_generation: self.presentation_generation,
            generation,
            receiver_snapshot,
            previous,
            live_bindings: None,
        });
        Ok(())
    }

    fn validate_dev_browser_fences(
        &mut self,
        dev: &DevBrowserPresentation,
    ) -> Result<(), BridgeError> {
        self.ensure_engine_execution_healthy()?;
        self.ensure_view_execution_healthy()?;
        if self.navigation_blocks_presentation()
            || self.app_service.lifecycle().state() != container_core::LifecycleState::Active
            || self
                .app_service
                .pages()
                .current()
                .is_none_or(|p| p.id != dev.page || p.path != dev.route)
            || self.view.template_revision != dev.root_revision
            || self.input_lifetime_revision != dev.input_lifetime
            || self.browser_view.generation != dev.surface_generation
            || self.presentation_generation != dev.base_generation
        {
            return Err(stale(
                "development presentation inputs changed before publication",
            ));
        }
        if let Some(expected) = &dev.receiver_snapshot {
            let names = expected["scopes"]
                .as_object()
                .ok_or_else(|| invalid("missing receiver scopes"))?
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            if self.live_receiver_snapshot(dev.page.0, &names)? != *expected {
                return Err(stale("development receiver incarnation changed"));
            }
        }
        Ok(())
    }

    pub(super) fn prepare_staged_dev_browser_view(
        &mut self,
        payload: &Value,
        surface_generation: u64,
    ) -> Result<BrowserViewSubmission, BridgeError> {
        let dev = self
            .browser_view
            .development
            .take()
            .expect("staged development document");
        let first_surface = dev.surface_generation == 0 && self.browser_view.presented.is_none();
        if payload != &dev.expected_render
            || (!first_surface && surface_generation != dev.surface_generation)
        {
            self.browser_view.development = Some(dev);
            return Err(stale(
                "development request differs from the staged document",
            ));
        }
        self.validate_dev_browser_fences(&dev)?;
        let mut dev = dev;
        let prepared = dev
            .prepared
            .take()
            .expect("development document evaluated once");
        if prepared.document.page_id > 9_007_199_254_740_991
            || prepared.document.revision > 9_007_199_254_740_991
        {
            return Err(invalid(
                "development document exceeds the browser exact integer range",
            ));
        }
        let sequence = self
            .browser_view
            .sequence
            .checked_add(1)
            .ok_or_else(|| invalid("presentation revision exhausted"))?;
        let key = PresentationKey {
            session_id: self.config.session_id.clone(),
            page_id: prepared.document.page_id,
            document_revision: prepared.document.revision,
            presentation_revision: sequence,
            surface_generation,
            profile: RendererProfile::WebView,
        };
        key.validate().map_err(|e| invalid(e.to_string()))?;
        let topology =
            ViewTopology::from_document(&prepared.document).map_err(|e| invalid(e.to_string()))?;
        let submission = BrowserViewSubmission {
            version: VIEW_PRESENTATION_VERSION.into(),
            key,
            viewport: ViewViewport {
                width: f64::from(prepared.input.viewport.width),
                height: f64::from(prepared.input.viewport.height),
            },
            document: prepared.document,
            animation: None,
        };
        // Before the first Browser document the host has not issued a surface
        // generation yet. Its initial prepare binds this staged candidate once.
        dev.surface_generation = surface_generation;
        self.browser_view.generation = surface_generation;
        self.browser_view.sequence = sequence;
        self.browser_view.suspended = true;
        self.browser_view.pending = Some(Candidate {
            submission: submission.clone(),
            page_input: prepared.input.page_input,
            topology,
            resources: prepared.input.resources,
            geometry: None,
            permit: None,
            live: None,
            animations: None,
            animation_baseline: None,
            development: Some(dev),
        });
        Ok(submission)
    }

    fn check_pending_dev_browser(&mut self) -> Result<(), BridgeError> {
        let Some(dev) = self
            .browser_view
            .pending
            .as_mut()
            .and_then(|p| p.development.take())
        else {
            return Ok(());
        };
        let result = self.validate_dev_browser_fences(&dev);
        if let Some(pending) = self.browser_view.pending.as_mut() {
            pending.development = Some(dev);
        }
        result
    }

    pub(super) fn prepare_dev_browser_permit(&mut self) -> Result<(), BridgeError> {
        if !self
            .browser_view
            .pending
            .as_ref()
            .is_some_and(|p| p.development.is_some())
        {
            return Ok(());
        }
        self.check_pending_dev_browser()?;
        self.settle_browser_contact_retirement("development-presentation")?;
        self.check_pending_dev_browser()
    }

    pub(super) fn prepare_dev_browser_publication(
        &mut self,
    ) -> Result<Option<(PageId, String)>, BridgeError> {
        self.check_pending_dev_browser()?;
        let Some(dev) = self
            .browser_view
            .pending
            .as_mut()
            .and_then(|p| p.development.take())
        else {
            return Ok(None);
        };
        let ticket = match dev.graph.as_ref() {
            Some(graph) => self.prepare_dev_component_graph_indexes(dev.page, graph),
            None => Ok(None),
        };
        if let Some(pending) = self.browser_view.pending.as_mut() {
            pending.development = Some(dev);
            ticket
        } else {
            Err(stale(
                "development publication owner retired during metadata preparation",
            ))
        }
    }

    pub(super) fn publish_dev_browser_presentation(&mut self, mut dev: DevBrowserPresentation) {
        self.protocol = dev.protocol;
        self.manifest = dev.manifest;
        self.presentation_generation = dev.generation;
        self.invalidate_engine_host_environment();
        *self.chrome_catalog.borrow_mut() = None;
        self.animation_writes.retire_all();
        self.animation_bindings.retire_all();
        self.animation_playback.retire_all();
        if let Some(graph) = dev.graph.take() {
            self.component_pages.insert(dev.page, graph);
        }
        if let Some(bindings) = dev.live_bindings {
            self.install_live_bindings(bindings);
        }
        self.browser_view.development_abort = None;
    }

    pub(super) fn dev_browser_abort_restoration(&mut self) -> Option<DevBrowserRestoration> {
        let dev = self.browser_view.pending.as_ref()?.development.as_ref()?;
        let (key, permit, expected) = dev.previous.clone()?;
        if self.input_lifetime_revision != dev.input_lifetime
            || self.presentation_generation != dev.base_generation
            || self.browser_view.generation != dev.surface_generation
            || !self.browser_key_is_current(&key)
            || self
                .browser_view
                .presented
                .as_ref()
                .is_none_or(|p| p.submission.key != key || p.permit != permit)
        {
            return None;
        }
        if let Some(expected) = &expected {
            let scopes = expected["scopes"]
                .as_object()?
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            if self.live_receiver_snapshot(key.page_id, &scopes).ok()? != *expected {
                return None;
            }
            // Restored v1 input now carries the same immutable native proof
            // used by the rollback decision and by the v2 input dispatcher.
            self.browser_view.presented.as_mut()?.receiver_snapshot =
                Some(Arc::new(expected.clone()));
        }
        Some(DevBrowserRestoration {
            key,
            permit,
            input_lifetime: self.input_lifetime_revision?,
            receiver_snapshot: expected,
        })
    }

    pub(super) fn append_dev_browser_restoration(&mut self, result: &mut Value) {
        let Some(proof) = self.browser_view.development_abort.clone() else {
            return;
        };
        if !self.is_browser_view_presented()
            || self
                .browser_view
                .presented
                .as_ref()
                .is_none_or(|p| p.submission.key != proof.key || p.permit != proof.permit)
            || self.input_lifetime_revision != Some(proof.input_lifetime)
        {
            return;
        }
        if let Some(expected) = &proof.receiver_snapshot {
            let Some(scopes) = expected["scopes"].as_object() else {
                return;
            };
            let scopes = scopes.keys().cloned().collect::<Vec<_>>();
            if self
                .live_receiver_snapshot(proof.key.page_id, &scopes)
                .ok()
                .as_ref()
                != Some(expected)
            {
                self.browser_view.suspended = true;
                self.browser_view.development_abort = None;
                return;
            }
        }
        result["restoredKey"] = json!(proof.key);
        result["inputEnabled"] = json!(true);
        result["inputLifetimeRevision"] = json!(proof.input_lifetime.to_string());
    }
}
