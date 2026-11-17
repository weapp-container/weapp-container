use serde::Serialize;

pub const DEFAULT_COMPATIBILITY_VERSION: &str = "0.0.1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityProfile {
    pub version: &'static str,
    pub wechat_baseline_version: &'static str,
}

pub const COMPATIBILITY_PROFILES: &[CompatibilityProfile] = &[
    CompatibilityProfile {
        version: DEFAULT_COMPATIBILITY_VERSION,
        wechat_baseline_version: "3.17.4",
    },
    CompatibilityProfile {
        version: "0.0.0",
        wechat_baseline_version: "3.17.3",
    },
];

pub fn find(version: &str) -> Option<&'static CompatibilityProfile> {
    COMPATIBILITY_PROFILES
        .iter()
        .find(|profile| profile.version == version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_profile_is_pinned_to_the_supported_wechat_baseline() {
        assert_eq!(DEFAULT_COMPATIBILITY_VERSION, "0.0.1");
        assert_eq!(
            find(DEFAULT_COMPATIBILITY_VERSION)
                .unwrap()
                .wechat_baseline_version,
            "3.17.4"
        );
        assert_eq!(find("0.0.0").unwrap().wechat_baseline_version, "3.17.3");
        assert!(find("9.9.9").is_none());
    }
}
