//! Renderer selection is an execution requirement, independent of JS engines.
use crate::{valid_relative_path, ContainerManifestV1, ManifestError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(crate) fn canonical_view_path(value: &str) -> bool {
    valid_relative_path(value)
        && !value.split('/').any(|part| part == ".")
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '\\' | '#' | '?' | ':'))
}

pub const RENDERING_MANIFEST_SCHEMA_VERSION: u32 = 3;
pub const RENDERING_PROFILE_VERSION: &str = "1.0";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RendererProfile {
    #[default]
    Skia,
    #[serde(rename = "webview")]
    WebView,
    SkylineCompat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LayoutAuthority {
    Rust,
    Browser,
}

impl RendererProfile {
    pub const fn layout_authority(self) -> LayoutAuthority {
        match self {
            Self::Skia | Self::SkylineCompat => LayoutAuthority::Rust,
            Self::WebView => LayoutAuthority::Browser,
        }
    }
}

/// Page keys are emitted route paths, without a WXML/JSON extension. The
/// default is a container profile, not a claim of official renderer parity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererProfiles {
    pub version: String,
    pub default: RendererProfile,
    pub pages: BTreeMap<String, RendererProfile>,
}

impl Default for RendererProfiles {
    fn default() -> Self {
        Self {
            version: RENDERING_PROFILE_VERSION.into(),
            default: RendererProfile::Skia,
            pages: BTreeMap::new(),
        }
    }
}

impl RendererProfiles {
    pub fn profile_for_route(&self, path: &str) -> RendererProfile {
        self.pages.get(path).copied().unwrap_or(self.default)
    }

    /// A host must explicitly offer every required profile. This check never
    /// substitutes Skia for a missing WebView or Skyline compatibility mode.
    pub fn negotiate(
        &self,
        version: &str,
        profiles: &[RendererProfile],
    ) -> Result<(), ManifestError> {
        let compatible = version.split_once('.').is_some_and(|(major, minor)| {
            major == "1"
                && !minor.is_empty()
                && minor.bytes().all(|byte| byte.is_ascii_digit())
                && minor.parse::<u32>().is_ok()
        });
        if self.version != RENDERING_PROFILE_VERSION || !compatible {
            return Err(invalid("unsupported rendering profile version"));
        }
        if std::iter::once(&self.default)
            .chain(self.pages.values())
            .any(|profile| !profiles.contains(profile))
        {
            return Err(invalid(
                "host does not support every required renderer profile",
            ));
        }
        Ok(())
    }
}

fn invalid(reason: impl Into<String>) -> ManifestError {
    ManifestError::InvalidField {
        field: "rendering",
        reason: reason.into(),
    }
}

impl ContainerManifestV1 {
    pub fn renderer_profile_for_route(&self, path: &str) -> RendererProfile {
        self.rendering
            .as_ref()
            .map_or(RendererProfile::Skia, |rendering| {
                rendering.profile_for_route(path)
            })
    }

    pub(crate) fn validate_rendering(&self) -> Result<(), ManifestError> {
        let Some(rendering) = &self.rendering else {
            return Ok(());
        };
        if rendering.version != RENDERING_PROFILE_VERSION {
            return Err(invalid("unsupported rendering profile version"));
        }
        for page in rendering.pages.keys() {
            if !canonical_view_path(page)
                || page.ends_with(".wxml")
                || page.ends_with(".json")
                || !self.routes.iter().any(|route| route.path == *page)
            {
                return Err(invalid(format!(
                    "renderer page is not a declared route: {page}"
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_negotiation_never_falls_back() {
        let mut profiles = RendererProfiles::default();
        profiles
            .pages
            .insert("page".into(), RendererProfile::WebView);
        assert!(profiles.negotiate("1.0", &[RendererProfile::Skia]).is_err());
        assert!(profiles
            .negotiate("1.0", &[RendererProfile::Skia, RendererProfile::WebView])
            .is_ok());
        assert!(profiles
            .negotiate("2.0", &[RendererProfile::Skia, RendererProfile::WebView])
            .is_err());
        assert!(profiles
            .negotiate("1.2", &[RendererProfile::Skia, RendererProfile::WebView])
            .is_ok());
        assert_eq!(
            profiles.profile_for_route("page").layout_authority(),
            LayoutAuthority::Browser
        );
        assert_eq!(profiles.profile_for_route("other"), RendererProfile::Skia);
    }

    #[test]
    fn renderer_wire_names_are_explicit() {
        assert_eq!(
            serde_json::to_string(&RendererProfile::WebView).unwrap(),
            "\"webview\""
        );
        assert_eq!(
            serde_json::to_string(&RendererProfile::SkylineCompat).unwrap(),
            "\"skyline-compat\""
        );
        assert!(serde_json::from_str::<RendererProfile>("\"skyline\"").is_err());
    }

    fn manifest() -> ContainerManifestV1 {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "rendering-test".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest
    }

    #[test]
    fn profile_requires_v3_and_changes_require_session_restart() {
        let legacy = manifest();
        legacy.validate().unwrap();
        assert_eq!(
            legacy.renderer_profile_for_route("page"),
            RendererProfile::Skia
        );
        let mut next = legacy.clone();
        next.rendering = Some(RendererProfiles::default());
        assert!(next.validate().is_err());
        next.schema_version = RENDERING_MANIFEST_SCHEMA_VERSION;
        next.validate().unwrap();
        assert!(!legacy.can_replace_presentation_with(&next));
        let mut changed = next.clone();
        changed.rendering.as_mut().unwrap().default = RendererProfile::WebView;
        assert!(!next.can_replace_presentation_with(&changed));
        next.rendering = None;
        assert!(next.validate().is_err());
    }

    #[test]
    fn renderer_pages_must_reference_actual_routes() {
        let mut value = manifest();
        value.schema_version = RENDERING_MANIFEST_SCHEMA_VERSION;
        value.rendering = Some(RendererProfiles::default());
        value
            .rendering
            .as_mut()
            .unwrap()
            .pages
            .insert("missing".into(), RendererProfile::WebView);
        assert!(value.validate().is_err());
        value.routes.push(crate::Route {
            id: "route:missing".into(),
            path: "missing".into(),
            kind: crate::RouteKind::Page,
            config: None,
            entry_module: "missing.js".into(),
        });
        value.validate().unwrap();
    }
}
