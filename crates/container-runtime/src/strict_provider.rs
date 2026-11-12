//! Production default for an embedding without installed native services.
//! Unknown identity, payment, hardware and file operations are always rejected.
//! A deterministic sandbox remains a separate, explicit development provider.

use crate::{
    host_api_catalog, host_api_descriptor, merge_host_geometry, HostApiProvider, HostMetadata,
    ProviderContext, ProviderError, ProviderErrorCode, HOST_GEOMETRY_APIS,
};
use container_ir::CapabilitySupport;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub struct StrictHostProvider {
    snapshots: BTreeMap<String, Value>,
}

impl StrictHostProvider {
    /// Only caller-observed, bounded synchronous snapshots may be installed.
    /// An absent snapshot stays unsupported, independently of authorization.
    pub fn from_snapshots(snapshots: BTreeMap<String, Value>) -> Result<Self, ProviderError> {
        if snapshots.len() > 64 {
            return Err(invalid("too many host snapshots"));
        }
        let mut total = 0usize;
        for (name, value) in &snapshots {
            if !host_api_descriptor(name)
                .is_some_and(|api| api.kind == "syncSnapshot" && api.owner == "host")
            {
                return Err(invalid(format!("not a host snapshot API: {name}")));
            }
            let size = serde_json::to_vec(value)
                .map_err(|_| invalid("host snapshot is not JSON"))?
                .len();
            total = total
                .checked_add(size)
                .ok_or_else(|| invalid("host snapshot budget overflow"))?;
            if size > 256 * 1024 || total > 1024 * 1024 {
                return Err(invalid("host snapshot budget exceeded"));
            }
        }
        Ok(Self { snapshots })
    }
}

fn invalid(message: impl Into<String>) -> ProviderError {
    ProviderError {
        code: ProviderErrorCode::InvalidRequest,
        message: message.into(),
        retryable: false,
    }
}

impl HostApiProvider for StrictHostProvider {
    fn name(&self) -> &'static str {
        "strict-host"
    }

    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        let mut result: BTreeMap<_, _> = host_api_catalog()
            .iter()
            .filter(|api| api.owner == "host" && api.kind == "syncSnapshot")
            .map(|api| (api.name.clone(), CapabilitySupport::Unsupported))
            .collect();
        for name in self.snapshots.keys() {
            result.insert(name.clone(), CapabilitySupport::Partial);
        }
        for name in HOST_GEOMETRY_APIS {
            result
                .entry(name.into())
                .or_insert(CapabilitySupport::Unsupported);
        }
        if self.snapshots.contains_key("wx.getSystemInfoSync") {
            result.insert("wx.getSystemInfo".into(), CapabilitySupport::Partial);
            result.insert("wx.getSystemInfoAsync".into(), CapabilitySupport::Partial);
        }
        for name in ["wx.setNavigationBarTitle", "wx.setNavigationBarColor"] {
            result.insert(name.into(), CapabilitySupport::Partial);
        }
        result
    }

    fn capabilities_for_host(&self, host: &HostMetadata) -> BTreeMap<String, CapabilitySupport> {
        let mut result = self.capabilities();
        for name in HOST_GEOMETRY_APIS {
            let snapshot_name = if matches!(name, "wx.getSystemInfo" | "wx.getSystemInfoAsync") {
                "wx.getSystemInfoSync"
            } else {
                name
            };
            let support =
                if merge_host_geometry(name, self.snapshots.get(snapshot_name).cloned(), host)
                    .is_ok_and(|value| value.is_some())
                {
                    CapabilitySupport::Partial
                } else {
                    CapabilitySupport::Unsupported
                };
            result.insert(name.into(), support);
        }
        result
    }

    fn call(
        &mut self,
        name: &str,
        _: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        if matches!(
            name,
            "wx.setNavigationBarTitle" | "wx.setNavigationBarColor"
        ) {
            // Session validates and commits this internal chrome state. This
            // acknowledgement does not claim to have displayed native UI.
            return Ok(
                serde_json::json!({"errMsg":format!("{}:ok",name.trim_start_matches("wx."))}),
            );
        }
        let snapshot_name = if matches!(name, "wx.getSystemInfo" | "wx.getSystemInfoAsync") {
            "wx.getSystemInfoSync"
        } else {
            name
        };
        merge_host_geometry(
            name,
            self.snapshots.get(snapshot_name).cloned(),
            &context.host,
        )?
        .ok_or_else(|| ProviderError {
            code: ProviderErrorCode::Unsupported,
            message: format!("host capability is not installed: {name}"),
            retryable: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_provider_cannot_create_accounts_payments_files_or_devices() {
        let mut provider = StrictHostProvider::default();
        for name in [
            "wx.login",
            "wx.checkSession",
            "wx.requestPayment",
            "wx.getLocation",
            "wx.getFileSystemManager",
            "wx.request",
        ] {
            assert_eq!(
                provider
                    .call(name, &Map::new(), &ProviderContext::default())
                    .unwrap_err()
                    .code,
                ProviderErrorCode::Unsupported
            );
            assert!(!provider.capabilities().contains_key(name));
        }
    }
    #[test]
    fn only_real_bounded_snapshots_can_be_installed() {
        let snapshots = BTreeMap::from([(
            "wx.getSystemInfoSync".into(),
            serde_json::json!({"platform":"test-observed"}),
        )]);
        let mut provider = StrictHostProvider::from_snapshots(snapshots).unwrap();
        assert_eq!(
            provider
                .call("wx.getSystemInfo", &Map::new(), &ProviderContext::default())
                .unwrap()["platform"],
            "test-observed"
        );
        let asynchronous = provider
            .call(
                "wx.getSystemInfoAsync",
                &Map::new(),
                &ProviderContext::default(),
            )
            .unwrap();
        assert_eq!(asynchronous["platform"], "test-observed");
        assert_eq!(asynchronous["errMsg"], "getSystemInfoAsync:ok");
        assert_eq!(
            provider.capabilities()["wx.getSystemInfoAsync"],
            CapabilitySupport::Partial
        );
        assert!(StrictHostProvider::from_snapshots(BTreeMap::from([(
            "wx.login".into(),
            serde_json::json!({"code":"forged"})
        )]))
        .is_err());
        assert!(StrictHostProvider::from_snapshots(BTreeMap::from([(
            "wx.getSystemInfoSync".into(),
            Value::String("x".repeat(256 * 1024))
        )]))
        .is_err());
    }
}
