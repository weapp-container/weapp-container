//! Complete host geometry crosses one trusted environment installation.
use super::*;

pub(super) fn validate_menu_rect(rect: &MenuButtonRect) -> Result<(), BridgeError> {
    if [
        rect.left,
        rect.right,
        rect.top,
        rect.bottom,
        rect.width,
        rect.height,
    ]
    .iter()
    .any(|value| !value.is_finite())
        || rect.width <= 0.0
        || rect.height <= 0.0
        || (rect.right - rect.left - rect.width).abs() > 1e-6
        || (rect.bottom - rect.top - rect.height).abs() > 1e-6
    {
        return Err(BridgeError::invalid("invalid menu button geometry"));
    }
    Ok(())
}

impl Session {
    /// The owner has matched the native observation to the measured shell.
    /// Publish window, display and capsule together before any resize hook.
    pub fn notify_host_layout(
        &mut self,
        metrics: HostWindowMetrics,
        menu: MenuButtonRect,
    ) -> Result<BridgeBatch, BridgeError> {
        metrics
            .validate()
            .map_err(|error| BridgeError::invalid(error.to_string()))?;
        validate_menu_rect(&menu)?;
        self.with_engine_batch_turn(None, |session| {
            session.ensure_initialized()?;
            session.apply_host_geometry(
                metrics.window_width,
                metrics.window_height,
                Some(metrics.display),
                Some(menu),
            )
        })
    }
}
