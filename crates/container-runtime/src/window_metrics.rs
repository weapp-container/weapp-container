//! Typed host observations. Coordinates are supplied by the host, never
//! reconstructed from the render viewport or Android input density.

use crate::SessionError;
use container_render_skia::{Rect, SkiaRenderer};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostDeviceOrientation {
    Portrait,
    Landscape,
}

/// A host-observed safe rectangle in logical pixels in the screen's portrait
/// direction. The public API does not specify its origin; hosts that cannot
/// establish that mapping must omit it. No inset rebasing is performed here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSafeArea {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
    pub width: f64,
    pub height: f64,
}

/// Container extension in the current rendering View's local logical coordinates.
/// Reserved-region frames already include host margins and contain active regions only.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostLayout {
    pub version: u32,
    pub safe_insets: HostSafeInsets,
    pub vertical_bar_edge: HostVerticalBarEdge,
    pub reserved_regions: Vec<HostReservedRegion>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSafeInsets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostVerticalBarEdge {
    Left,
    Right,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostReservedRegionKind {
    Occlusion,
    Division,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostReservedRegion {
    pub id: String,
    pub kind: HostReservedRegionKind,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl HostLayout {
    pub fn validate(&self, width: u32, height: u32) -> Result<(), SessionError> {
        let invalid = |message: &str| SessionError::Config(format!("hostLayout: {message}"));
        if self.version != 1 {
            return Err(invalid("unsupported version"));
        }
        let width = f64::from(width);
        let height = f64::from(height);
        let i = &self.safe_insets;
        if [i.top, i.right, i.bottom, i.left]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.0)
            || i.left + i.right >= width + 0.5
            || i.top + i.bottom >= height + 0.5
        {
            return Err(invalid(
                "safeInsets must leave a positive surface-local content area",
            ));
        }
        if self.reserved_regions.len() > 64 {
            return Err(invalid("too many reserved regions"));
        }
        let mut ids = std::collections::BTreeSet::new();
        for region in &self.reserved_regions {
            if region.id.is_empty()
                || region.id.len() > 256
                || region.id.chars().any(char::is_control)
                || !ids.insert(&region.id)
            {
                return Err(invalid("region IDs must be unique, nonempty and bounded"));
            }
            if [region.x, region.y, region.width, region.height]
                .iter()
                .any(|v| !v.is_finite())
                || region.x < 0.0
                || region.y < 0.0
                || region.width <= 0.0
                || region.height <= 0.0
                || region.x + region.width > width + 0.5
                || region.y + region.height > height + 0.5
            {
                return Err(invalid(
                    "reserved regions must be clipped to the rendering surface",
                ));
            }
        }
        Ok(())
    }
}

/// One complete host display observation. Viewport dimensions deliberately
/// live only on HostMetadata/HostWindowMetrics, avoiding competing sizes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostDisplayMetrics {
    pub pixel_ratio: f64,
    /// Current-orientation screen extent rounded to the nearest logical pixel.
    pub screen_width: u32,
    pub screen_height: u32,
    pub status_bar_height: f64,
    /// Window upper-edge y observation, not an input-coordinate transform.
    pub screen_top: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safe_area: Option<HostSafeArea>,
    pub device_orientation: HostDeviceOrientation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_layout: Option<HostLayout>,
}

/// Flat JSON is the single host update boundary: windowWidth/windowHeight
/// plus all HostDisplayMetrics fields. The retained HostMetadata stores the
/// dimensions separately and the display portion once.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWindowMetrics {
    pub window_width: u32,
    pub window_height: u32,
    #[serde(flatten)]
    pub display: HostDisplayMetrics,
}

impl<'de> Deserialize<'de> for HostWindowMetrics {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Serde does not support deny_unknown_fields with flatten. Keep the
        // wire boundary explicitly flat so unknown host observations cannot
        // silently bypass the typed contract.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            window_width: u32,
            window_height: u32,
            pixel_ratio: f64,
            screen_width: u32,
            screen_height: u32,
            status_bar_height: f64,
            screen_top: f64,
            #[serde(default)]
            safe_area: Option<HostSafeArea>,
            device_orientation: HostDeviceOrientation,
            #[serde(default)]
            host_layout: Option<HostLayout>,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            window_width: wire.window_width,
            window_height: wire.window_height,
            display: HostDisplayMetrics {
                pixel_ratio: wire.pixel_ratio,
                screen_width: wire.screen_width,
                screen_height: wire.screen_height,
                status_bar_height: wire.status_bar_height,
                screen_top: wire.screen_top,
                safe_area: wire.safe_area,
                device_orientation: wire.device_orientation,
                host_layout: wire.host_layout,
            },
        })
    }
}

pub(crate) fn validate_viewport(width: u32, height: u32) -> Result<(), SessionError> {
    if width == 0 || height == 0 {
        return Err(SessionError::Config(
            "host viewport dimensions must be positive".into(),
        ));
    }
    SkiaRenderer::validate_viewport(Rect {
        x: 0.0,
        y: 0.0,
        width: width as f32,
        height: height as f32,
    })
    .map_err(|error| SessionError::Config(error.to_string()))
}

impl HostWindowMetrics {
    /// Validate the entire candidate before any session/provider mutation.
    pub fn validate(&self) -> Result<(), SessionError> {
        validate_viewport(self.window_width, self.window_height)?;
        let display = &self.display;
        if let Some(layout) = &display.host_layout {
            layout.validate(self.window_width, self.window_height)?;
        }
        let invalid =
            |message: &str| SessionError::Config(format!("host window metrics: {message}"));
        if !display.pixel_ratio.is_finite() || display.pixel_ratio <= 0.0 {
            return Err(invalid("pixelRatio must be finite and positive"));
        }
        if display.screen_width == 0 || display.screen_height == 0 {
            return Err(invalid("screen dimensions must be positive"));
        }
        let height = f64::from(display.screen_height);
        if !display.status_bar_height.is_finite()
            || display.status_bar_height < 0.0
            || display.status_bar_height > height + 0.5
        {
            return Err(invalid(
                "statusBarHeight must be finite, nonnegative and within the screen",
            ));
        }
        if !display.screen_top.is_finite() {
            return Err(invalid("screenTop must be finite"));
        }
        if let Some(safe) = &display.safe_area {
            // Neither the origin nor natural display orientation is public.
            // Do not invent portrait coordinate bounds by swapping axes.
            // Only extent bounds use the larger observed screen axis, with
            // half a logical pixel for integer dimension quantization.
            let max_extent = f64::from(display.screen_width.max(display.screen_height)) + 0.5;
            for (name, value) in [
                ("safeArea.left", safe.left),
                ("safeArea.right", safe.right),
                ("safeArea.top", safe.top),
                ("safeArea.bottom", safe.bottom),
            ] {
                if !value.is_finite() {
                    return Err(invalid(&format!("{name} must be finite")));
                }
            }
            for (name, extent, edges, bound) in [
                (
                    "safeArea.width",
                    safe.width,
                    safe.right - safe.left,
                    max_extent,
                ),
                (
                    "safeArea.height",
                    safe.height,
                    safe.bottom - safe.top,
                    max_extent,
                ),
            ] {
                if !extent.is_finite()
                    || extent <= 0.0
                    || extent > bound
                    || (extent - edges).abs() > 1e-6
                {
                    return Err(invalid(&format!(
                        "{name} must be positive and match its portrait-coordinate edges"
                    )));
                }
            }
        }
        Ok(())
    }
}
