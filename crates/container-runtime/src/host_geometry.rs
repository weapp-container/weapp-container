//! Production projection of observations already accepted by the core.
//! This module never consults the deterministic development provider, invents
//! a screen extent from a render target, or supplies device/WeChat identity.

use crate::{HostMetadata, HostWindowMetrics, ProviderError};
use serde_json::{json, Value};

pub const HOST_GEOMETRY_APIS: [&str; 6] = [
    "wx.getSystemInfo",
    "wx.getSystemInfoAsync",
    "wx.getSystemInfoSync",
    "wx.getWindowInfo",
    "wx.getSystemSetting",
    "wx.getMenuButtonBoundingClientRect",
];

/// Return only fields whose source is an accepted core display/chrome
/// observation. `None` means the host has not supplied that observation;
/// malformed observations are rejected instead of reviving older snapshots.
/// Callers may merge real OS or explicit host fields, with this projection
/// taking precedence over stale geometry from their cached snapshots.
pub fn project_host_geometry(
    name: &str,
    host: &HostMetadata,
) -> Result<Option<Value>, ProviderError> {
    if name == "wx.getMenuButtonBoundingClientRect" {
        let Some(rect) = &host.menu_button_rect else {
            return Ok(None);
        };
        crate::host_layout::validate_menu_rect(rect)
            .map_err(|error| ProviderError::invalid(error.to_string()))?;
        return Ok(Some(json!(rect)));
    }
    if !HOST_GEOMETRY_APIS.contains(&name) {
        return Ok(None);
    }
    let Some(display) = &host.display_metrics else {
        return Ok(None);
    };
    let metrics = HostWindowMetrics {
        window_width: host.window_width,
        window_height: host.window_height,
        display: display.clone(),
    };
    metrics
        .validate()
        .map_err(|error| ProviderError::invalid(error.to_string()))?;
    if name == "wx.getSystemSetting" {
        return Ok(Some(
            json!({"deviceOrientation": display.device_orientation}),
        ));
    }
    let mut result = json!({
        "windowWidth": host.window_width,
        "windowHeight": host.window_height,
        "pixelRatio": display.pixel_ratio,
        "screenWidth": display.screen_width,
        "screenHeight": display.screen_height,
        "statusBarHeight": display.status_bar_height,
    });
    if name == "wx.getWindowInfo" {
        result["screenTop"] = json!(display.screen_top);
        if let Some(layout) = &display.host_layout {
            result["hostLayout"] = json!(layout);
        }
    } else {
        result["deviceOrientation"] = json!(display.device_orientation);
    }
    if let Some(safe) = &display.safe_area {
        // The host already established portrait-coordinate semantics. Never
        // rebase/swap axes or fabricate an inset-free safe area here.
        result["safeArea"] = json!(safe);
    }
    Ok(Some(result))
}

/// A supplied OS snapshot can include device/system fields. Keep them while
/// replacing every geometry field with the single accepted observation.
pub fn merge_host_geometry(
    name: &str,
    snapshot: Option<Value>,
    host: &HostMetadata,
) -> Result<Option<Value>, ProviderError> {
    if !HOST_GEOMETRY_APIS.contains(&name) {
        return Ok(snapshot);
    }
    let geometry = project_host_geometry(name, host)?;
    if geometry.is_none()
        && matches!(
            name,
            "wx.getWindowInfo" | "wx.getMenuButtonBoundingClientRect"
        )
    {
        return Ok(None);
    }
    let mut snapshot = match snapshot {
        Some(Value::Object(object)) => object,
        None if geometry.is_some() => serde_json::Map::new(),
        None => return Ok(None),
        Some(_) => {
            return Err(ProviderError::invalid(
                "host system snapshot must be an object",
            ))
        }
    };
    // Cached system fields do not own geometry. Remove all of them before
    // applying the accepted observation, including a now-absent safe area.
    if name != "wx.getMenuButtonBoundingClientRect" {
        for field in [
            "windowWidth",
            "windowHeight",
            "pixelRatio",
            "screenWidth",
            "screenHeight",
            "statusBarHeight",
            "screenTop",
            "safeArea",
            "hostLayout",
            "deviceOrientation",
        ] {
            snapshot.remove(field);
        }
    }
    if let Some(geometry) = geometry {
        snapshot.extend(
            geometry
                .as_object()
                .expect("host geometry is an object")
                .clone(),
        );
    }
    if !snapshot.is_empty() && matches!(name, "wx.getSystemInfo" | "wx.getSystemInfoAsync") {
        snapshot.insert(
            "errMsg".into(),
            json!(format!("{}:ok", name.trim_start_matches("wx."))),
        );
    }
    Ok((!snapshot.is_empty()).then_some(Value::Object(snapshot)))
}

#[cfg(test)]
#[path = "host_geometry_tests.rs"]
mod tests;
