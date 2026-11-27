use container_runtime::provider::ProviderError;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

const MAX_FIXTURE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(transparent)]
pub struct HostFixtures(BTreeMap<String, HostFixture>);

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum HostFixture {
    Resolve { resolve: Value },
    Reject { reject: String },
}

impl HostFixtures {
    pub fn read(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let mut bytes = Vec::new();
        File::open(path)?
            .take((MAX_FIXTURE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_FIXTURE_BYTES {
            return Err("host fixtures exceed 256 KiB".into());
        }
        let fixtures: Self = serde_json::from_slice(&bytes)?;
        if fixtures.0.len() > 256
            || fixtures.0.iter().any(|(name, fixture)| {
                name.trim().is_empty()
                    || name.len() > 128
                    || name.starts_with("wx.")
                    || matches!(fixture, HostFixture::Reject { reject } if reject.trim().is_empty())
            })
        {
            return Err("invalid method name, rejection message or fixture count".into());
        }
        Ok(fixtures)
    }

    pub(super) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(super) fn methods(&self) -> Vec<String> {
        self.0.keys().cloned().collect()
    }

    pub(super) fn response(&self, method: &str) -> Option<Result<Value, ProviderError>> {
        self.0.get(method).map(|fixture| match fixture {
            HostFixture::Resolve { resolve } => Ok(resolve.clone()),
            HostFixture::Reject { reject } => Err(ProviderError::invalid(reject)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_explicit_methods_have_responses() {
        let fixtures: HostFixtures = serde_json::from_value(json!({
            "company.getProfile": { "resolve": { "displayName": "Guest" } },
            "company.read": { "reject": "Profile access denied" },
            "company.optional": { "resolve": null }
        }))
        .unwrap();
        assert_eq!(
            fixtures.response("company.getProfile").unwrap().unwrap(),
            json!({"displayName": "Guest"})
        );
        assert_eq!(
            fixtures
                .response("company.read")
                .unwrap()
                .unwrap_err()
                .message,
            "Profile access denied"
        );
        assert_eq!(
            fixtures.response("company.optional").unwrap().unwrap(),
            Value::Null
        );
        assert!(fixtures.response("company.unknown").is_none());
        assert!(serde_json::from_value::<HostFixtures>(
            json!({"method": {"resolve": null, "reject": "ambiguous"}})
        )
        .is_err());
    }
}
