//! Compile-time distribution boundary. The full runtime has no extra policy;
//! showcase binaries admit only the exact packs and APIs selected by their producer.
use container_ir::CapabilitySupport;
use serde::Serialize;

#[cfg(feature = "restricted-showcase")]
mod compiled {
    include!(concat!(env!("OUT_DIR"), "/showcase_policy.rs"));
}

#[cfg(not(feature = "restricted-showcase"))]
#[used]
#[no_mangle]
pub static WEAPP_CONTAINER_DISTRIBUTION_IDENTITY: [u8; b"weapp-container-distribution:full:\0"
    .len()] = *b"weapp-container-distribution:full:\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionIdentity {
    pub distribution_profile: &'static str,
    pub policy_sha256: Option<&'static str>,
}

pub fn distribution_identity() -> DistributionIdentity {
    #[cfg(feature = "restricted-showcase")]
    {
        std::hint::black_box(&compiled::WEAPP_CONTAINER_DISTRIBUTION_IDENTITY);
        DistributionIdentity {
            distribution_profile: "restricted-showcase",
            policy_sha256: Some(compiled::POLICY_SHA256),
        }
    }
    #[cfg(not(feature = "restricted-showcase"))]
    {
        std::hint::black_box(&WEAPP_CONTAINER_DISTRIBUTION_IDENTITY);
        DistributionIdentity {
            distribution_profile: "full",
            policy_sha256: None,
        }
    }
}

pub const fn is_restricted_showcase() -> bool {
    cfg!(feature = "restricted-showcase")
}

/// One immutable font source shared across independent native sessions. Skia
/// still owns its decoded face for each Canvas/page owner; OS font discovery
/// and a host JSON option cannot replace this restricted delivery resource.
#[cfg(all(
    feature = "restricted-showcase",
    feature = "skia-backend",
    not(target_arch = "wasm32")
))]
pub(crate) fn showcase_native_font() -> container_render_skia::NativeFontData {
    use std::sync::{Arc, OnceLock};
    static BYTES: OnceLock<Arc<[u8]>> = OnceLock::new();
    std::hint::black_box(&compiled::WEAPP_CONTAINER_NATIVE_FONT_IDENTITY);
    let bytes = BYTES.get_or_init(|| Arc::from(compiled::NATIVE_FONT_BYTES));
    container_render_skia::NativeFontData::new(Arc::clone(bytes), 0)
}

pub fn showcase_pack_allowed(root: &str) -> bool {
    #[cfg(feature = "restricted-showcase")]
    {
        compiled::ALLOWED_PACK_ROOTS.binary_search(&root).is_ok()
    }
    #[cfg(not(feature = "restricted-showcase"))]
    {
        let _ = root;
        true
    }
}

pub(crate) fn showcase_capability_allowed(name: &str) -> bool {
    #[cfg(feature = "restricted-showcase")]
    {
        // Resolve the same public aliases as capability admission. A caller
        // cannot regain a denied factory through an object method spelling.
        let canonical = if super::is_timer_api(name) {
            "wx.timer"
        } else if super::is_selector_query_api(name) {
            "wx.createSelectorQuery"
        } else if name.starts_with("wx.fs.") {
            "wx.getFileSystemManager"
        } else {
            match name {
                "wx.socketTask.send" | "wx.socketTask.close" => "wx.connectSocket",
                "wx.audioContext" => "wx.createAudioContext",
                "wx.innerAudioContext" => "wx.createInnerAudioContext",
                "wx.videoContext" => "wx.createVideoContext",
                "wx.cameraContext" => "wx.createCameraContext",
                _ => name,
            }
        };
        compiled::ALLOWED_APIS.binary_search(&canonical).is_ok()
    }
    #[cfg(not(feature = "restricted-showcase"))]
    {
        let _ = name;
        true
    }
}

pub fn restrict_published_capabilities(
    capabilities: &mut std::collections::BTreeMap<String, CapabilitySupport>,
) {
    for (name, support) in capabilities {
        if !showcase_capability_allowed(name) {
            *support = CapabilitySupport::Unsupported;
        }
    }
}
