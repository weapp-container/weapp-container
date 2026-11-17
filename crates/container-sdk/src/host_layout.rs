//! Complete, SDK-correlated native layout observations. Observing a surface
//! never publishes half of a new environment to application JavaScript.
use crate::{clock_now_ns, ContainerSession, HostChromeGeometry, SdkError};
use container_runtime::HostWindowMetrics;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const LAYOUT_TIMEOUT_NS: u64 = 15_000_000_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostLayoutConfig {
    pub protocol_version: String,
    pub atomic: bool,
}
impl HostLayoutConfig {
    pub(super) fn validate(&self) -> Result<(), SdkError> {
        if self.protocol_version != "1.0" || !self.atomic {
            return Err(SdkError::new(
                "ERR_PROTOCOL_VERSION",
                "hostLayout requires atomic protocol 1.0",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSurfaceIdentity {
    pub owner_id: String,
    pub surface_generation: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostLayoutObservation {
    pub schema_version: u32,
    pub owner_id: String,
    pub surface_generation: String,
    pub observation_id: String,
    pub window_metrics: HostWindowMetrics,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_id: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostLayout {
    pub schema_version: u32,
    pub owner_id: String,
    pub surface_generation: String,
    pub observation_id: String,
    /// Decimal string; never transported through an IEEE-754 JSON number.
    pub layout_revision: String,
    pub window_metrics: HostWindowMetrics,
    pub chrome: HostChromeGeometry,
}

#[derive(Default)]
pub(super) struct HostLayoutState {
    surface_sequence: u64,
    observation_sequence: u64,
    pub surface: Option<HostSurfaceIdentity>,
    pub pending: Option<HostLayoutObservation>,
    pub accepted: Option<HostLayout>,
    pending_deadline_ns: Option<u64>,
    timed_out: bool,
}
impl HostLayoutState {
    pub(super) fn invalidate_for_account_switch(&mut self) {
        self.surface = None;
        self.pending = None;
        self.accepted = None;
        self.pending_deadline_ns = None;
        self.timed_out = false;
    }
}

pub(super) fn decimal(value: &str, field: &str) -> Result<u64, SdkError> {
    let parsed = value.parse::<u64>().map_err(|_| {
        SdkError::invalid(format!(
            "{field} must be a canonical positive decimal string"
        ))
    })?;
    if parsed == 0 || parsed.to_string() != value {
        return Err(SdkError::invalid(format!(
            "{field} must be a canonical positive decimal string"
        )));
    }
    Ok(parsed)
}

impl ContainerSession {
    pub(super) fn atomic_host_layout(&self) -> bool {
        self.config.host_layout.is_some()
    }

    pub(super) fn require_atomic_host_layout(&self) -> Result<(), SdkError> {
        if !self.atomic_host_layout() {
            return Err(SdkError::new(
                "ERR_UNSUPPORTED_CAPABILITY",
                "atomic host layout was not enabled before startup",
            ));
        }
        Ok(())
    }

    /// Native view ownership is established before any guest code or GPU
    /// attachment. The returned generation must accompany every observation.
    pub fn begin_host_surface(&mut self) -> Result<HostSurfaceIdentity, SdkError> {
        self.ensure_lifecycle_open()?;
        self.require_atomic_host_layout()?;
        if self.host_layout_state.surface.is_some() {
            return Err(SdkError::invalid(
                "detach the existing host layout surface before replacing it",
            ));
        }
        self.host_layout_state.surface_sequence = self
            .host_layout_state
            .surface_sequence
            .checked_add(1)
            .ok_or_else(|| SdkError::invalid("host surface generation exhausted"))?;
        let identity = HostSurfaceIdentity {
            owner_id: self.sdk_owner_id.to_string(),
            surface_generation: self.host_layout_state.surface_sequence.to_string(),
        };
        self.host_layout_state.surface = Some(identity.clone());
        self.host_layout_state.pending = None;
        self.host_layout_state.pending_deadline_ns = None;
        Ok(identity)
    }

    pub fn end_host_surface(&mut self, identity: &HostSurfaceIdentity) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        self.validate_host_surface(identity)?;
        self.host_layout_state.surface = None;
        self.host_layout_state.pending = None;
        self.host_layout_state.pending_deadline_ns = None;
        if let Some(active) = self.active.as_mut() {
            let batch = active
                .session
                .retire_page_presenter("sdk-host-layout-surface-detached")?;
            self.observe_batch(&batch)?;
        }
        self.finish_operation_with_render(false)
    }

    fn validate_host_surface(&self, identity: &HostSurfaceIdentity) -> Result<(), SdkError> {
        self.require_atomic_host_layout()?;
        decimal(&identity.owner_id, "ownerId")?;
        decimal(&identity.surface_generation, "surfaceGeneration")?;
        if self.host_layout_state.surface.as_ref() != Some(identity) {
            return Err(SdkError::new(
                "ERR_CANCELLED",
                "host layout surface owner changed",
            ));
        }
        Ok(())
    }

    pub fn observe_host_layout(
        &mut self,
        identity: HostSurfaceIdentity,
        metrics: HostWindowMetrics,
    ) -> Result<HostLayoutObservation, SdkError> {
        self.ensure_lifecycle_open()?;
        self.validate_host_surface(&identity)?;
        metrics.validate().map_err(SdkError::invalid)?;
        self.host_layout_state.observation_sequence = self
            .host_layout_state
            .observation_sequence
            .checked_add(1)
            .ok_or_else(|| SdkError::invalid("host observation sequence exhausted"))?;
        let observation = HostLayoutObservation {
            schema_version: 1,
            owner_id: identity.owner_id,
            surface_generation: identity.surface_generation,
            observation_id: self.host_layout_state.observation_sequence.to_string(),
            window_metrics: metrics.clone(),
            session_id: self
                .active
                .as_ref()
                .map(|a| a.session.config().session_id.clone()),
            page_id: self
                .active
                .as_ref()
                .and_then(|a| a.session.app_service().pages().current())
                .map(|p| p.id.0),
        };
        self.observed_viewport = (metrics.window_width, metrics.window_height);
        self.observed_window_metrics = Some(metrics);
        self.host_layout_state.pending = Some(observation.clone());
        self.host_layout_state.pending_deadline_ns =
            Some(clock_now_ns().saturating_add(LAYOUT_TIMEOUT_NS));
        self.host_layout_state.timed_out = false;
        if let Some(active) = self.active.as_mut() {
            let batch = active
                .session
                .retire_page_presenter("sdk-host-layout-observed")?;
            self.observe_batch(&batch)?;
        }
        self.push_event(json!({"type":"hostLayoutObservation", "observation":observation}));
        Ok(observation)
    }

    pub(super) fn validate_host_layout(&self, layout: &HostLayout) -> Result<(), SdkError> {
        self.require_atomic_host_layout()?;
        if layout.schema_version != 1 {
            return Err(SdkError::new(
                "ERR_PROTOCOL_VERSION",
                "host layout schema must be 1",
            ));
        }
        self.validate_host_surface(&HostSurfaceIdentity {
            owner_id: layout.owner_id.clone(),
            surface_generation: layout.surface_generation.clone(),
        })?;
        decimal(&layout.observation_id, "observationId")?;
        let revision = decimal(&layout.layout_revision, "layoutRevision")?;
        layout
            .window_metrics
            .validate()
            .map_err(SdkError::invalid)?;
        layout.chrome.validate()?;
        if (layout.chrome.content_rect.width - f64::from(layout.window_metrics.window_width)).abs()
            > 0.5
            || (layout.chrome.content_rect.height - f64::from(layout.window_metrics.window_height))
                .abs()
                > 0.5
        {
            return Err(SdkError::invalid(
                "content rectangle disagrees with native window metrics",
            ));
        }
        if self.host_layout_state.accepted.as_ref() == Some(layout)
            && self.host_layout_state.pending.is_none()
        {
            return self.validate_host_chrome_owner(&layout.chrome);
        }
        let pending = self.host_layout_state.pending.as_ref().ok_or_else(|| {
            SdkError::new("ERR_CANCELLED", "no pending native layout observation")
        })?;
        if self.host_layout_state.timed_out
            || self
                .host_layout_state
                .pending_deadline_ns
                .is_some_and(|deadline| deadline <= clock_now_ns())
        {
            return Err(SdkError::new(
                "ERR_TIMEOUT",
                "native layout measurement expired; observe and measure again",
            ));
        }
        if pending.observation_id != layout.observation_id
            || pending.window_metrics != layout.window_metrics
            || pending.session_id != layout.chrome.session_id
            || pending.page_id != layout.chrome.page_id
        {
            return Err(SdkError::new(
                "ERR_CANCELLED",
                "layout does not match the exact native observation and page owner",
            ));
        }
        if let Some(accepted) = &self.host_layout_state.accepted {
            if revision <= decimal(&accepted.layout_revision, "layoutRevision")? {
                return Err(SdkError::new(
                    "ERR_CANCELLED",
                    "stale complete host layout revision",
                ));
            }
        }
        self.validate_host_chrome_owner(&layout.chrome)
    }

    pub fn update_host_layout(&mut self, layout: HostLayout) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.session.pending_navigation().is_some())
        {
            return Err(SdkError::invalid(
                "a navigation measurement must commit through completeNavigationLayout",
            ));
        }
        self.validate_host_layout(&layout)?;
        if self.host_layout_state.accepted.as_ref() == Some(&layout)
            && self.host_layout_state.pending.is_none()
        {
            return Ok(());
        }
        let previous = self
            .active
            .as_ref()
            .map(|active| active.session.config().host.clone());
        let result = self.active.as_mut().map(|active| {
            active.session.notify_host_layout(
                layout.window_metrics.clone(),
                layout.chrome.menu_button_rect.clone(),
            )
        });
        // User resize hooks may fail after the native environment commits.
        // Inspect actual runtime metadata rather than rolling back those hooks.
        let committed = (result.as_ref().is_none_or(Result::is_ok)
            || self
                .active
                .as_ref()
                .is_some_and(|active| previous.as_ref() != Some(&active.session.config().host)))
            && self.active.as_ref().is_none_or(|active| {
                let host = &active.session.config().host;
                host.window_width == layout.window_metrics.window_width
                    && host.window_height == layout.window_metrics.window_height
                    && host.display_metrics.as_ref() == Some(&layout.window_metrics.display)
                    && host.menu_button_rect.as_ref() == Some(&layout.chrome.menu_button_rect)
            });
        if committed {
            self.accept_host_layout(layout);
        }
        let result = result.map_or(Ok(()), |result| {
            result
                .map_err(SdkError::from)
                .and_then(|batch| self.observe_batch(&batch))
        });
        if committed {
            if let Some(active) = self.active.as_mut() {
                active.rendered = None;
            }
            self.snapshot_cache = None;
        }
        let finished = self.finish_operation();
        result.and(finished)
    }

    pub fn complete_navigation_host_layout(
        &mut self,
        ticket: &str,
        layout: HostLayout,
    ) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        self.validate_host_layout(&layout)?;
        let pending = self
            .active
            .as_ref()
            .and_then(|active| active.session.pending_navigation())
            .ok_or_else(|| SdkError::new("ERR_CANCELLED", "no pending navigation layout"))?;
        if pending.ticket != ticket {
            return Err(SdkError::new(
                "ERR_CANCELLED",
                "navigation layout ticket changed",
            ));
        }
        let result = self.active_mut()?.session.complete_navigation_layout(
            ticket,
            layout.window_metrics.clone(),
            layout.chrome.menu_button_rect.clone(),
        );
        let committed = self
            .active
            .as_ref()
            .and_then(|active| active.session.last_navigation_outcome())
            .is_some_and(|outcome| {
                outcome.get("ticket").and_then(Value::as_str) == Some(ticket)
                    && outcome.get("layoutCommitted").and_then(Value::as_bool) == Some(true)
            });
        if committed {
            self.accept_host_layout(layout);
        }
        let result = result
            .map_err(SdkError::from)
            .and_then(|batch| self.observe_batch(&batch));
        if committed {
            if let Some(active) = self.active.as_mut() {
                active.rendered = None;
            }
            self.snapshot_cache = None;
        }
        let finished = self.finish_operation();
        result.and(finished)
    }

    pub(super) fn accept_host_layout(&mut self, mut layout: HostLayout) {
        if let Some(active) = &self.active {
            layout.chrome.session_id = Some(active.session.config().session_id.clone());
            layout.chrome.page_id = active
                .session
                .app_service()
                .pages()
                .current()
                .map(|p| p.id.0);
        }
        self.config.host.window_width = layout.window_metrics.window_width;
        self.config.host.window_height = layout.window_metrics.window_height;
        self.config.host.display_metrics = Some(layout.window_metrics.display.clone());
        self.config.host.menu_button_rect = Some(layout.chrome.menu_button_rect.clone());
        self.host_chrome = Some(layout.chrome.clone());
        self.host_layout_state.pending = None;
        self.host_layout_state.pending_deadline_ns = None;
        self.host_layout_state.timed_out = false;
        self.staged_chrome_pending = false;
        self.host_layout_state.accepted = Some(layout.clone());
        self.push_event(json!({"type":"hostLayoutAccepted", "acceptedLayout":layout}));
    }

    pub(super) fn host_layout_ready(&self) -> bool {
        if !self.atomic_host_layout() {
            return true;
        }
        let Some(layout) = &self.host_layout_state.accepted else {
            return false;
        };
        self.host_layout_state.pending.is_none()
            && self
                .host_layout_state
                .surface
                .as_ref()
                .is_some_and(|surface| {
                    surface.owner_id == layout.owner_id
                        && surface.surface_generation == layout.surface_generation
                })
            && self.active.as_ref().is_some_and(|active| {
                layout.chrome.session_id.as_deref()
                    == Some(active.session.config().session_id.as_str())
                    && layout.chrome.page_id
                        == active
                            .session
                            .app_service()
                            .pages()
                            .current()
                            .map(|p| p.id.0)
                    && active.session.pending_navigation().is_none()
            })
    }

    pub(super) fn poll_host_layout_timeout(&mut self, now_ns: u64) {
        if !self.host_layout_state.timed_out
            && self
                .host_layout_state
                .pending_deadline_ns
                .is_some_and(|deadline| deadline <= now_ns)
        {
            self.host_layout_state.timed_out = true;
            self.push_event(json!({"type":"hostLayoutError", "observation":self.host_layout_state.pending,
                "error":{"code":"ERR_TIMEOUT", "message":"Native layout measurement expired; retry with a new observation."}}));
        }
    }

    pub(super) fn validate_presentation_layout(&self, payload: &Value) -> Result<(), SdkError> {
        if !self.atomic_host_layout() {
            return Ok(());
        }
        let layout = self
            .host_layout_state
            .accepted
            .as_ref()
            .ok_or_else(|| SdkError::new("ERR_CANCELLED", "no accepted host layout"))?;
        for (key, expected) in [
            ("ownerId", &layout.owner_id),
            ("surfaceGeneration", &layout.surface_generation),
            ("observationId", &layout.observation_id),
            ("layoutRevision", &layout.layout_revision),
        ] {
            if payload.get(key).and_then(Value::as_str) != Some(expected.as_str()) {
                return Err(SdkError::new(
                    "ERR_CANCELLED",
                    format!("presentation has stale {key}"),
                ));
            }
        }
        Ok(())
    }
}
