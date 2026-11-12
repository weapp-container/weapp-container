//! Explicit host/presenter selection. A failed GPU path never selects software.
use crate::pack::Result;
use container_render_skia::PageRenderMode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenterProfile {
    MacosMetal,
    LinuxSoftware,
}
impl PresenterProfile {
    pub fn select(host: &str, requested: Option<&str>) -> Result<Self> {
        match (host, requested) {
            ("macos", None | Some("metal")) => Ok(Self::MacosMetal),
            ("linux", Some("software")) => Ok(Self::LinuxSoftware),
            ("linux", None) => Err("Linux requires explicit --presenter software".into()),
            _ => Err("presenter profile is unavailable on this host".into()),
        }
    }
    pub fn validate_host(self, host: &str) -> Result<()> {
        if self.host() == host {
            Ok(())
        } else {
            Err("presenter profile belongs to another host".into())
        }
    }
    pub const fn host(self) -> &'static str {
        match self {
            Self::MacosMetal => "macos",
            Self::LinuxSoftware => "linux",
        }
    }
    pub const fn name(self) -> &'static str {
        match self {
            Self::MacosMetal => "metal",
            Self::LinuxSoftware => "software",
        }
    }
    pub const fn render_mode(self) -> PageRenderMode {
        match self {
            Self::MacosMetal => PageRenderMode::NativeGpu,
            Self::LinuxSoftware => PageRenderMode::Raster,
        }
    }
}

/// Conformance must present the entire configured raster frame. Ordinary
/// preview clipping/minimization semantics cannot authorize a frame ACK.
pub fn require_exact_surface(surface: (u32, u32), frame: (u32, u32)) -> Result<()> {
    if frame.0 == 0 || frame.1 == 0 || surface != frame {
        return Err("software conformance presentation requires an exact nonzero surface".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn software_is_explicit_and_host_bound() {
        assert!(PresenterProfile::select("linux", None).is_err());
        assert!(PresenterProfile::select("linux", Some("metal")).is_err());
        assert!(PresenterProfile::select("macos", Some("software")).is_err());
        assert!(PresenterProfile::select("windows", Some("software")).is_err());
        let software = PresenterProfile::select("linux", Some("software")).unwrap();
        assert_eq!(software.render_mode(), PageRenderMode::Raster);
        assert!(software.validate_host("macos").is_err());
        assert_eq!(
            PresenterProfile::select("macos", None).unwrap(),
            PresenterProfile::MacosMetal
        );
    }
    #[test]
    fn minimized_clipped_or_scaled_surface_does_not_authorize_ack() {
        for surface in [
            (0, 0),
            (375, 0),
            (0, 667),
            (374, 667),
            (375, 668),
            (750, 1334),
        ] {
            assert!(require_exact_surface(surface, (375, 667)).is_err());
        }
        assert!(require_exact_surface((0, 0), (0, 0)).is_err());
        require_exact_surface((375, 667), (375, 667)).unwrap();
    }
}
