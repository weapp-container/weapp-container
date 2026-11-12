//! Runtime-owned samples over an accepted browser topology. The browser only
//! observes CSS baselines and presents numeric styles; it never owns time.
use super::*;
use crate::animation_protocol::{
    self as wire, BaselinePayload, PrepareSamplePayload, SamplePermit, SampleSubmission,
};

pub(super) struct SampleCandidate {
    submission: SampleSubmission,
    permit: SamplePermit,
    animations: PreparedAnimations,
}

pub(super) struct SampleFinal {
    permit: SamplePermit,
    geometry: BrowserGeometryBatch,
}

/// Keep one bounded terminal identity when a template or lifetime boundary
/// retires a pending sample. An exact settle can then prove that the sample
/// never committed, even after its old presentation key is no longer current.
pub(super) fn retire_pending_sample(session: &mut Session) {
    if let Some(pending) = session.browser_view.sample_pending.take() {
        session.browser_view.sample_aborted = Some(pending.submission.key);
    }
}

pub(super) fn is_animation_operation(op: &str) -> bool {
    matches!(
        op,
        op::VIEW_ANIMATION_BASELINE
            | op::VIEW_SAMPLE_PREPARE
            | op::VIEW_SAMPLE_PRESENTED
            | op::VIEW_SAMPLE_ABORT
    )
}

pub(super) fn sample_page_input<'a>(
    session: &'a Session,
    key: &PresentationKey,
) -> Option<&'a BrowserPageInput> {
    let candidate = session.browser_view.sample_pending.as_ref()?;
    if key != &candidate.submission.key && key != &candidate.submission.base_key {
        return None;
    }
    session
        .browser_view
        .presented
        .as_ref()
        .filter(|accepted| accepted.submission.key == candidate.submission.base_key)
        .and_then(|accepted| accepted.page_input.as_ref())
}

pub(super) fn submission_metadata(
    animations: &Option<PreparedAnimations>,
    sequence: u64,
) -> Result<Option<Value>, BridgeError> {
    animations
        .as_ref()
        .filter(|value| !value.playback.baseline_requests.is_empty())
        .map(|value| {
            serde_json::to_value(wire::AnimationSubmission {
                version: wire::VERSION,
                request_id: format!("animation:{sequence}"),
                baselines: value.playback.baseline_requests.clone(),
                styles: value.playback.styles.clone(),
            })
            .map_err(|error| invalid(error.to_string()))
        })
        .transpose()
}

pub(super) fn validate_template_animations(
    session: &Session,
    geometry: &BrowserGeometryBatch,
) -> Result<(), BridgeError> {
    let pending = session
        .browser_view
        .pending
        .as_ref()
        .ok_or_else(|| stale("no pending browser candidate"))?;
    if let Some(animations) = &pending.animations {
        session.validate_prepared_animations(animations)?;
    }
    if let Some(baseline) = &pending.animation_baseline {
        let epoch = baseline["epoch"]
            .as_str()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| invalid("animation baseline epoch unavailable"))?;
        if geometry.epoch <= epoch {
            return Err(stale("browser geometry must follow its animation baseline"));
        }
    }
    Ok(())
}

fn input_json(input: Option<&BrowserPageInput>) -> Value {
    input.map(|input| json!({
        "pageId":input.page_id.0.to_string(),"routePath":input.route_path,
        "templateRevision":input.template_revision.to_string(),
        "viewport":{"x":f64::from(input.viewport.x),"y":f64::from(input.viewport.y),
            "width":f64::from(input.viewport.width),"height":f64::from(input.viewport.height)}
    })).unwrap_or(Value::Null)
}

impl Session {
    pub(crate) fn animation_browser_sample_input_is_current(&self) -> bool {
        self.browser_view.pending.is_none()
            && self
                .browser_view
                .presented
                .as_ref()
                .is_some_and(|accepted| {
                    self.browser_key_is_current(&accepted.submission.key)
                        && accepted.page_input.as_ref().is_some_and(|input| {
                            input.template_revision == self.view.template_revision
                        })
                })
    }

    fn bind_browser_animation_baseline(&mut self, payload: Value) -> Result<Value, BridgeError> {
        let baseline: BaselinePayload =
            serde_json::from_value(payload.clone()).map_err(|error| invalid(error.to_string()))?;
        if self.browser_view.live.enabled
            || baseline.version != wire::VERSION
            || baseline.epoch == 0
        {
            return Err(BridgeError::protocol(
                "unsupported animation baseline contract",
            ));
        }
        if !self.browser_key_is_current(&baseline.key) {
            return Err(stale(
                "animation baseline belongs to a retired presentation",
            ));
        }
        let pending = self
            .browser_view
            .pending
            .as_ref()
            .ok_or_else(|| stale("no animation baseline candidate"))?;
        if pending.submission.key != baseline.key
            || pending.geometry.is_some()
            || pending
                .submission
                .animation
                .as_ref()
                .and_then(|value| value["requestId"].as_str())
                != Some(baseline.request_id.as_str())
        {
            return Err(stale(
                "animation baseline does not own this hidden candidate",
            ));
        }
        if let Some(previous) = &pending.animation_baseline {
            if previous != &payload {
                return Err(stale("animation baseline cannot change after binding"));
            }
        } else {
            let mut candidate = pending
                .animations
                .clone()
                .ok_or_else(|| invalid("candidate has no animation owner"))?;
            candidate.playback.bind_baselines(&baseline.values)?;
            self.validate_prepared_animations(&candidate)?;
            let pending = self
                .browser_view
                .pending
                .as_mut()
                .expect("checked candidate");
            pending.animations = Some(candidate);
            pending.animation_baseline = Some(payload);
        }
        let styles = &self
            .browser_view
            .pending
            .as_ref()
            .expect("bound candidate")
            .animations
            .as_ref()
            .expect("animation owner")
            .playback
            .styles;
        Ok(
            json!({"ok":true,"version":wire::VERSION,"requestId":baseline.request_id,"key":baseline.key,"styles":styles}),
        )
    }

    fn prepare_browser_animation_sample(
        &mut self,
        request: PrepareSamplePayload,
    ) -> Result<Value, BridgeError> {
        if request.version != wire::VERSION || self.browser_view.live.enabled {
            return Err(BridgeError::protocol(
                "unsupported retained animation sample contract",
            ));
        }
        if let Some(pending) = &self.browser_view.sample_pending {
            if pending.submission.base_key == request.base_key
                && pending.submission.base_geometry_epoch == request.base_geometry_epoch
                && pending.submission.consumed_sample.demand_revision
                    == request.sample_demand_revision
            {
                return Ok(self.browser_sample_preparation_json(pending));
            }
            return Err(stale("another retained sample owns the presentation lane"));
        }
        if self.animation_playback.sample_demand_revision() != Some(request.sample_demand_revision)
        {
            return Err(stale("animation sample demand is stale"));
        }
        if !self.is_browser_view_presented() {
            return Err(stale(
                "retained sample requires a presented browser document",
            ));
        }
        let accepted = self
            .browser_view
            .presented
            .as_ref()
            .expect("checked presented");
        let input = accepted
            .page_input
            .as_ref()
            .ok_or_else(|| stale("retained sample has no cloned page input"))?;
        if accepted.submission.key != request.base_key
            || accepted.geometry.epoch != request.base_geometry_epoch
            || input.template_revision != self.view.template_revision
            || input.viewport.width != accepted.submission.viewport.width as f32
            || input.viewport.height != accepted.submission.viewport.height as f32
        {
            return Err(stale(
                "retained sample requires current template input and geometry",
            ));
        }
        // This lane retains the exact DOM and its existing resource leases.
        // It cannot fetch or install a new resource. New document consumers
        // still validate BufferURL authorization at their normal boundary.
        let viewport = input.viewport;
        let playback = self.animation_playback.prepare_sample(
            input.page_id.0,
            self.animation_clock.now(),
            viewport,
        )?;
        let consumed = playback
            .consumed_sample
            .ok_or_else(|| stale("animation sample lane was not discovered"))?;
        let animations = PreparedAnimations {
            bindings: None,
            playback,
        };
        self.validate_prepared_animations(&animations)?;
        let sequence = self
            .browser_view
            .sequence
            .checked_add(1)
            .ok_or_else(|| invalid("presentation revision exhausted"))?;
        let mut key = request.base_key.clone();
        key.presentation_revision = sequence;
        let submission = SampleSubmission {
            version: wire::VERSION,
            key: key.clone(),
            base_key: request.base_key.clone(),
            base_geometry_epoch: request.base_geometry_epoch,
            consumed_sample: consumed,
            viewport: accepted.submission.viewport,
            styles: animations.playback.styles.clone(),
        };
        let permit = SamplePermit {
            version: wire::VERSION.into(),
            key,
            base_key: request.base_key,
            base_geometry_epoch: request.base_geometry_epoch,
            consumed_sample: consumed,
            permit_id: format!("sample:{sequence}:{}", self.browser_view.generation),
        };
        let candidate = SampleCandidate {
            submission,
            permit,
            animations,
        };
        let result = self.browser_sample_preparation_json(&candidate);
        self.retire_browser_queries("animation sample is pending presentation");
        self.browser_view.sequence = sequence;
        self.browser_view.suspended = true;
        self.browser_view.sample_pending = Some(candidate);
        Ok(result)
    }

    fn browser_sample_preparation_json(&self, candidate: &SampleCandidate) -> Value {
        json!({"ok":true,"submission":candidate.submission,"permit":candidate.permit,
            "scheduling":{"version":wire::VERSION,"key":candidate.submission.key,
                "consumedInput":input_json(self.browser_view.presented.as_ref().and_then(|value| value.page_input.as_ref())),
                "consumedSample":candidate.submission.consumed_sample}})
    }

    fn accept_browser_animation_sample(
        &mut self,
        permit: SamplePermit,
        geometry: BrowserGeometryBatch,
    ) -> Result<Value, BridgeError> {
        if permit.version != wire::VERSION
            || self.browser_view.live.enabled
            || !self.browser_key_is_current(&permit.key)
        {
            return Err(stale("retained sample presentation is retired"));
        }
        if let Some(previous) = &self.browser_view.sample_final {
            if previous.permit == permit
                && previous.geometry == geometry
                && self
                    .browser_view
                    .presented
                    .as_ref()
                    .is_some_and(|value| value.submission.key == permit.key)
            {
                return Ok(
                    json!({"ok":true,"version":wire::VERSION,"key":permit.key,"consumedSample":permit.consumed_sample,"inputEnabled":self.is_browser_view_presented()}),
                );
            }
        }
        let pending = self
            .browser_view
            .sample_pending
            .as_ref()
            .ok_or_else(|| stale("no permitted animation sample"))?;
        if pending.permit != permit {
            return Err(stale("animation sample permit mismatch"));
        }
        self.validate_prepared_animations(&pending.animations)?;
        let accepted = self
            .browser_view
            .presented
            .as_ref()
            .ok_or_else(|| stale("sample base was retired"))?;
        if accepted.submission.key != permit.base_key
            || accepted.geometry.epoch != permit.base_geometry_epoch
        {
            return Err(stale("sample base geometry changed"));
        }
        geometry
            .validate()
            .map_err(|error| invalid(error.to_string()))?;
        let mut sampled_submission = accepted.submission.clone();
        sampled_submission.key = permit.key.clone();
        sampled_submission.animation = None;
        validate_geometry(&sampled_submission, &accepted.topology, &geometry)?;
        if geometry.epoch <= permit.base_geometry_epoch {
            return Err(stale("sample geometry must advance its base epoch"));
        }
        let candidate = self
            .browser_view
            .sample_pending
            .take()
            .expect("validated sample");
        self.accept_prepared_animations(candidate.animations);
        let accepted = self
            .browser_view
            .presented
            .as_mut()
            .expect("validated base");
        accepted.submission = sampled_submission;
        accepted.geometry = geometry.clone();
        accepted.permit = BrowserCommitPermit {
            version: VIEW_PRESENTATION_VERSION.into(),
            key: permit.key.clone(),
            epoch: geometry.epoch.to_string(),
            permit_id: permit.permit_id.clone(),
        };
        for contact in self.browser_view.contacts.values_mut() {
            if contact.key == permit.base_key {
                contact.key = permit.key.clone();
            }
        }
        self.browser_view.sample_final = Some(SampleFinal {
            permit: permit.clone(),
            geometry,
        });
        self.browser_view.suspended = false;
        Ok(
            json!({"ok":true,"version":wire::VERSION,"key":permit.key,"consumedSample":permit.consumed_sample,"inputEnabled":self.is_browser_view_presented()}),
        )
    }

    fn abort_browser_animation_sample(
        &mut self,
        key: PresentationKey,
    ) -> Result<Value, BridgeError> {
        // This is an exact settlement, including an ACK whose delivery was
        // cancelled or lost. Historical acceptance never re-enables input.
        if let Some(final_sample) = &self.browser_view.sample_final {
            if final_sample.permit.key == key {
                return Ok(json!({"ok":true,"version":wire::VERSION,"key":key,
                    "aborted":false,"presented":true,
                    "consumedSample":final_sample.permit.consumed_sample,"inputEnabled":false}));
            }
        }
        if self.browser_view.sample_aborted.as_ref() == Some(&key) {
            return Ok(json!({"ok":true,"version":wire::VERSION,"key":key,"aborted":true}));
        }
        let pending = self
            .browser_view
            .sample_pending
            .as_ref()
            .ok_or_else(|| stale("no retained sample to abort"))?;
        if pending.submission.key != key {
            return Err(stale("sample abort does not own the pending key"));
        }
        // Install the tombstone before dropping the candidate. A delayed
        // presented request can never accept this now-settled key afterward.
        self.browser_view.sample_aborted = Some(key.clone());
        self.browser_view.sample_pending = None;
        // The presenter may roll back only after receiving this exact final.
        // The original document keeps its independent input/geometry lease.
        self.browser_view.suspended = false;
        Ok(json!({"ok":true,"version":wire::VERSION,"key":key,"aborted":true}))
    }

    pub(super) fn handle_browser_animation_operation(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_engine_execution_healthy()?;
        self.ensure_view_execution_healthy()?;
        let result = match request.op.as_str() {
            op::VIEW_ANIMATION_BASELINE => {
                self.bind_browser_animation_baseline(request.payload.clone())?
            }
            op::VIEW_SAMPLE_PREPARE => self.prepare_browser_animation_sample(
                serde_json::from_value(request.payload.clone())
                    .map_err(|error| invalid(error.to_string()))?,
            )?,
            op::VIEW_SAMPLE_PRESENTED => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct PresentedSample {
                    version: String,
                    permit: SamplePermit,
                    geometry: BrowserGeometryBatch,
                }
                let value: PresentedSample = serde_json::from_value(request.payload.clone())
                    .map_err(|error| invalid(error.to_string()))?;
                if value.version != wire::VERSION {
                    return Err(BridgeError::protocol(
                        "unsupported sample presentation version",
                    ));
                }
                self.accept_browser_animation_sample(value.permit, value.geometry)?
            }
            op::VIEW_SAMPLE_ABORT => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Abort {
                    version: String,
                    key: PresentationKey,
                }
                let value: Abort = serde_json::from_value(request.payload.clone())
                    .map_err(|error| invalid(error.to_string()))?;
                if value.version != wire::VERSION {
                    return Err(BridgeError::protocol("unsupported sample abort version"));
                }
                self.abort_browser_animation_sample(value.key)?
            }
            _ => return Err(invalid("unknown animation operation")),
        };
        Ok(vec![self.response(request, result)])
    }
}
