use crate::{pack, ContainerSession, PackSource, SdkError};
use container_runtime::{resolve_page_chrome, MenuButtonRect};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentRect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// Host-measured rectangles in current-screen logical pixels. Display metrics
/// remain a separate observation; neither rectangle rebases safeArea.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostChromeGeometry {
    pub schema_version: u32,
    pub revision: u64,
    pub content_rect: ContentRect,
    pub menu_button_rect: MenuButtonRect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_id: Option<u64>,
}
impl HostChromeGeometry {
    pub(super) fn validate(&self) -> Result<(), SdkError> {
        let content = &self.content_rect;
        let menu = &self.menu_button_rect;
        if self.schema_version != 1 {
            return Err(SdkError::new(
                "ERR_PROTOCOL_VERSION",
                "host chrome schema must be 1",
            ));
        }
        if self.revision == 0
            || [
                content.left,
                content.top,
                content.width,
                content.height,
                menu.left,
                menu.top,
                menu.right,
                menu.bottom,
                menu.width,
                menu.height,
            ]
            .iter()
            .any(|value| !value.is_finite())
            || content.width <= 0.
            || content.height <= 0.
            || menu.width <= 0.
            || menu.height <= 0.
            || (menu.right - menu.left - menu.width).abs() > 1e-6
            || (menu.bottom - menu.top - menu.height).abs() > 1e-6
        {
            return Err(SdkError::invalid("invalid host chrome geometry"));
        }
        if content.width > 16384.
            || content.height > 16384.
            || menu.width > 16384.
            || menu.height > 16384.
        {
            return Err(SdkError::invalid(
                "host chrome geometry exceeds logical bounds",
            ));
        }
        Ok(())
    }
}
impl ContainerSession {
    pub fn inspect_pack_chrome(
        &self,
        source: PackSource,
        route: Option<&str>,
    ) -> Result<Value, SdkError> {
        crate::require_full_distribution()?;
        self.ensure_open()?;
        let pack = pack::VerifiedPack::load(source)?;
        let route = pack.route(route)?;
        let mut result = serde_json::to_value(resolve_page_chrome(
            &pack.manifest,
            &pack.blobs,
            &route,
            None,
            Vec::new(),
            None,
        )?)
        .map_err(SdkError::invalid)?;
        result["route"] = json!(route);
        result["chromeRevision"] = json!(0);
        Ok(result)
    }
    pub fn update_host_chrome(&mut self, geometry: HostChromeGeometry) -> Result<(), SdkError> {
        self.ensure_open()?;
        if self.atomic_host_layout() {
            return Err(SdkError::new("ERR_UNSUPPORTED_CAPABILITY", "atomic layout requires complete hostLayout; hostChrome cannot publish half an environment"));
        }
        geometry.validate()?;
        self.validate_host_chrome_owner(&geometry)?;
        if let Some(active) = &mut self.active {
            active
                .session
                .notify_menu_button_rect(geometry.menu_button_rect.clone())?;
        }
        self.config.host.menu_button_rect = Some(geometry.menu_button_rect.clone());
        self.host_chrome = Some(geometry);
        // A native resize can arrive before its Flutter chrome measurement.
        // Complete a staged transaction once both observations agree, even
        // when the platform coalesces identical later metric callbacks.
        if self.staged_chrome_pending && self.chrome_geometry_matches() {
            self.staged_chrome_pending = false;
            if let Some(metrics) = self.observed_window_metrics.clone() {
                self.update_window_metrics(metrics)?;
            }
        }
        self.finish_operation_with_render(false)
    }
    pub(super) fn validate_host_chrome_owner(
        &self,
        geometry: &HostChromeGeometry,
    ) -> Result<(), SdkError> {
        if let Some(session_id) = &geometry.session_id {
            if self
                .active
                .as_ref()
                .is_none_or(|active| active.session.config().session_id != *session_id)
            {
                return Err(SdkError::new(
                    "ERR_CANCELLED",
                    "host chrome session changed",
                ));
            }
        }
        if let Some(page_id) = geometry.page_id {
            if self
                .active
                .as_ref()
                .and_then(|active| active.session.app_service().pages().current())
                .is_none_or(|page| page.id.0 != page_id)
            {
                return Err(SdkError::new("ERR_CANCELLED", "host chrome page changed"));
            }
        }
        if let Some(current) = &self.host_chrome {
            if geometry == current {
                return Ok(());
            }
            if geometry.revision <= current.revision {
                return Err(SdkError::new("ERR_CANCELLED", "stale host chrome revision"));
            }
        }
        Ok(())
    }
    pub fn set_preview_occluded(&mut self, occluded: bool) -> Result<(), SdkError> {
        self.ensure_open()?;
        if self.preview_occluded == occluded {
            return Ok(());
        }
        self.preview_occluded = occluded;
        let can_render = !occluded && self.host_layout_ready();
        let retirement = if let Some(active) = &mut self.active {
            let batch = active
                .session
                .retire_page_presenter("sdk-preview-occlusion")?;
            if can_render
                && !active.session.requires_dev_restart()
                && active.session.pending_navigation().is_none()
            {
                active.render(true)?;
            }
            Some(batch)
        } else {
            None
        };
        if let Some(batch) = retirement {
            self.observe_batch(&batch)?;
        }
        self.finish_operation_with_render(!occluded)
    }
    pub(super) fn chrome_geometry_matches(&self) -> bool {
        self.host_chrome.as_ref().is_none_or(|geometry| {
            (geometry.content_rect.width - f64::from(self.observed_viewport.0)).abs() <= 0.5
                && (geometry.content_rect.height - f64::from(self.observed_viewport.1)).abs() <= 0.5
        })
    }
    pub(super) fn chrome_state(&self) -> Result<Value, SdkError> {
        let value = self
            .active
            .as_ref()
            .map(|active| active.session.page_chrome())
            .transpose()?
            .flatten();
        let mut result = serde_json::to_value(value).map_err(SdkError::invalid)?;
        if result.is_object() {
            result["chromeRevision"] = json!(self.chrome_revision);
        }
        Ok(result)
    }
}
