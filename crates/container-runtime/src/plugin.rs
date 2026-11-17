//! Trusted, build-time runtime plugins.
//!
//! Plugins extend the host-provider boundary without adding platform-specific
//! implementations to the portable runtime. A host must register every plugin
//! before host services are configured or AppService initialization starts.

use crate::host_services::{host_api_descriptor, HostApiDescriptor};
use crate::provider::{
    HostApiProvider, NetworkType, ProviderContext, ProviderError, ProviderStart,
};
use container_ir::CapabilitySupport;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const PLUGIN_PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginApiDescriptor {
    pub descriptor: HostApiDescriptor,
    pub support: CapabilitySupport,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginDescriptor {
    pub id: String,
    pub version: String,
    pub protocol_version: u32,
    #[serde(default)]
    pub apis: Vec<PluginApiDescriptor>,
    #[serde(default)]
    pub component_namespaces: BTreeSet<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("plugin descriptor is invalid: {0}")]
    InvalidDescriptor(String),
    #[error("plugin id is already registered: {0}")]
    DuplicatePlugin(String),
    #[error("plugin API conflicts with an existing API: {0}")]
    ApiConflict(String),
}

/// A trusted plugin supplies metadata and one host provider. The host owns the
/// plugin instance and must compile it into the embedding binary.
pub trait RuntimePlugin: Send {
    fn descriptor(&self) -> &PluginDescriptor;
    fn into_provider(self: Box<Self>) -> Box<dyn HostApiProvider>;
}

struct RegisteredPlugin {
    descriptor: PluginDescriptor,
    provider: Box<dyn HostApiProvider>,
}

/// Routes namespaced plugin APIs to their registered provider and leaves all
/// other calls with the ordinary host provider. This keeps plugin state behind
/// the same deadline, cancellation and structured-error boundary.
pub struct PluginHostProvider {
    fallback: Box<dyn HostApiProvider>,
    plugins: BTreeMap<String, RegisteredPlugin>,
    api_owner: BTreeMap<String, String>,
}

impl PluginHostProvider {
    pub fn new(fallback: Box<dyn HostApiProvider>) -> Self {
        Self {
            fallback,
            plugins: BTreeMap::new(),
            api_owner: BTreeMap::new(),
        }
    }

    pub fn set_fallback(&mut self, fallback: Box<dyn HostApiProvider>) {
        self.fallback = fallback;
    }

    pub fn register_plugin(&mut self, plugin: Box<dyn RuntimePlugin>) -> Result<(), PluginError> {
        let descriptor = plugin.descriptor().clone();
        validate_descriptor(&descriptor)?;
        if self.plugins.contains_key(&descriptor.id) {
            return Err(PluginError::DuplicatePlugin(descriptor.id));
        }
        for api in &descriptor.apis {
            let name = &api.descriptor.name;
            if self.api_owner.contains_key(name) || host_api_descriptor(name).is_some() {
                return Err(PluginError::ApiConflict(name.clone()));
            }
        }
        let id = descriptor.id.clone();
        for api in &descriptor.apis {
            self.api_owner
                .insert(api.descriptor.name.clone(), id.clone());
        }
        self.plugins.insert(
            id,
            RegisteredPlugin {
                descriptor,
                provider: plugin.into_provider(),
            },
        );
        Ok(())
    }

    pub fn api_descriptors(&self) -> BTreeMap<String, HostApiDescriptor> {
        self.plugins
            .values()
            .flat_map(|plugin| {
                plugin
                    .descriptor
                    .apis
                    .iter()
                    .map(|api| (api.descriptor.name.clone(), api.descriptor.clone()))
            })
            .collect()
    }

    pub fn descriptors(&self) -> impl Iterator<Item = &PluginDescriptor> {
        self.plugins.values().map(|plugin| &plugin.descriptor)
    }

    fn plugin_for(&self, name: &str) -> Option<&str> {
        self.api_owner.get(name).map(String::as_str)
    }

    fn plugin_for_mut(&mut self, name: &str) -> Option<&mut RegisteredPlugin> {
        let owner = self.api_owner.get(name)?.clone();
        self.plugins.get_mut(&owner)
    }
}

impl HostApiProvider for PluginHostProvider {
    fn name(&self) -> &'static str {
        if self.plugins.is_empty() {
            self.fallback.name()
        } else {
            "plugin-router"
        }
    }

    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        let mut capabilities = self.fallback.capabilities();
        for plugin in self.plugins.values() {
            for api in &plugin.descriptor.apis {
                capabilities.insert(api.descriptor.name.clone(), api.support);
            }
        }
        capabilities
    }

    fn capabilities_for_host(
        &self,
        host: &crate::HostMetadata,
    ) -> BTreeMap<String, CapabilitySupport> {
        let mut capabilities = self.fallback.capabilities_for_host(host);
        for plugin in self.plugins.values() {
            let provider_capabilities = plugin.provider.capabilities_for_host(host);
            for api in &plugin.descriptor.apis {
                let support = provider_capabilities
                    .get(&api.descriptor.name)
                    .copied()
                    .unwrap_or(api.support);
                capabilities.insert(api.descriptor.name.clone(), support);
            }
        }
        capabilities
    }

    fn sync_file_snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        self.fallback.sync_file_snapshot()
    }

    fn supports_sync_filesystem(&self) -> bool {
        self.fallback.supports_sync_filesystem()
    }

    fn cancel(&mut self, token: &str) -> bool {
        let mut cancelled = self.fallback.cancel(token);
        for plugin in self.plugins.values_mut() {
            cancelled |= plugin.provider.cancel(token);
        }
        cancelled
    }

    fn update_network_type(&mut self, network_type: NetworkType) -> Result<(), ProviderError> {
        self.fallback.update_network_type(network_type)?;
        for plugin in self.plugins.values_mut() {
            plugin.provider.update_network_type(network_type)?;
        }
        Ok(())
    }

    fn start_call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> ProviderStart {
        if self.plugin_for(name).is_some() {
            return self
                .plugin_for_mut(name)
                .expect("plugin owner remains registered")
                .provider
                .start_call(name, payload, context);
        }
        self.fallback.start_call(name, payload, context)
    }

    fn call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        if self.plugin_for(name).is_some() {
            return self
                .plugin_for_mut(name)
                .expect("plugin owner remains registered")
                .provider
                .call(name, payload, context);
        }
        self.fallback.call(name, payload, context)
    }
}

fn validate_descriptor(descriptor: &PluginDescriptor) -> Result<(), PluginError> {
    if descriptor.protocol_version != PLUGIN_PROTOCOL_VERSION {
        return Err(PluginError::InvalidDescriptor(format!(
            "unsupported protocol version {}",
            descriptor.protocol_version
        )));
    }
    if !valid_plugin_id(&descriptor.id) {
        return Err(PluginError::InvalidDescriptor(
            "id must be 1-48 lowercase ASCII letters, digits or underscores and start with a letter"
                .into(),
        ));
    }
    if descriptor.version.trim().is_empty() || descriptor.version.len() > 128 {
        return Err(PluginError::InvalidDescriptor(
            "version must be nonempty and at most 128 bytes".into(),
        ));
    }
    let prefix = format!("weappContainer.plugin.{}.", descriptor.id);
    let mut names = BTreeSet::new();
    for api in &descriptor.apis {
        let name = &api.descriptor.name;
        if !name.starts_with(&prefix)
            || name[prefix.len()..].is_empty()
            || !name[prefix.len()..].split('.').all(valid_identifier)
            || api.descriptor.owner != "plugin"
        {
            return Err(PluginError::InvalidDescriptor(format!(
                "API {name} must be a plugin-owned namespaced API"
            )));
        }
        if !names.insert(name) {
            return Err(PluginError::InvalidDescriptor(format!(
                "duplicate API {name}"
            )));
        }
    }
    for namespace in &descriptor.component_namespaces {
        let expected = format!("plugin://{}/", descriptor.id);
        if !namespace.starts_with(&expected) || namespace.len() == expected.len() {
            return Err(PluginError::InvalidDescriptor(format!(
                "component namespace {namespace} must stay under {expected}"
            )));
        }
    }
    Ok(())
}

fn valid_plugin_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.as_bytes()[0].is_ascii_alphabetic()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ProviderErrorCode, SandboxProvider};

    struct FixturePlugin {
        descriptor: PluginDescriptor,
        provider: SandboxProvider,
    }

    impl FixturePlugin {
        fn new(id: &str, api: &str) -> Self {
            let name = format!("weappContainer.plugin.{id}.{api}");
            Self {
                descriptor: PluginDescriptor {
                    id: id.into(),
                    version: "1.0.0".into(),
                    protocol_version: PLUGIN_PROTOCOL_VERSION,
                    apis: vec![PluginApiDescriptor {
                        descriptor: HostApiDescriptor {
                            name,
                            kind: "async".into(),
                            owner: "plugin".into(),
                            permission: Some("fixture".into()),
                            factory: None,
                            object_type: None,
                            event: None,
                            counterpart: None,
                            metadata: BTreeMap::new(),
                        },
                        support: CapabilitySupport::Full,
                    }],
                    component_namespaces: BTreeSet::new(),
                },
                provider: SandboxProvider::new(),
            }
        }
    }

    impl RuntimePlugin for FixturePlugin {
        fn descriptor(&self) -> &PluginDescriptor {
            &self.descriptor
        }

        fn into_provider(self: Box<Self>) -> Box<dyn HostApiProvider> {
            Box::new(self.provider)
        }
    }

    #[test]
    fn routes_registered_api_and_merges_capability() {
        let mut provider = PluginHostProvider::new(Box::new(SandboxProvider::new()));
        provider
            .register_plugin(Box::new(FixturePlugin::new("fixture", "run")))
            .unwrap();
        assert_eq!(provider.name(), "plugin-router");
        assert_eq!(
            provider.capabilities()["weappContainer.plugin.fixture.run"],
            CapabilitySupport::Full
        );
        let error = provider
            .call(
                "weappContainer.plugin.fixture.run",
                &Map::new(),
                &ProviderContext::default(),
            )
            .unwrap_err();
        assert_eq!(error.code, ProviderErrorCode::Unsupported);
    }

    #[test]
    fn rejects_duplicate_and_public_api_collisions() {
        let mut provider = PluginHostProvider::new(Box::new(SandboxProvider::new()));
        provider
            .register_plugin(Box::new(FixturePlugin::new("fixture", "run")))
            .unwrap();
        assert!(matches!(
            provider.register_plugin(Box::new(FixturePlugin::new("fixture", "other"))),
            Err(PluginError::DuplicatePlugin(_))
        ));
        assert!(matches!(
            provider.register_plugin(Box::new(FixturePlugin::new("other", "run"))),
            Ok(())
        ));
    }

    #[test]
    fn rejects_invalid_namespace_and_component_scope() {
        let mut plugin = FixturePlugin::new("fixture", "run");
        plugin.descriptor.apis[0].descriptor.name = "wx.private.run".into();
        let mut provider = PluginHostProvider::new(Box::new(SandboxProvider::new()));
        assert!(matches!(
            provider.register_plugin(Box::new(plugin)),
            Err(PluginError::InvalidDescriptor(_))
        ));
        let mut plugin = FixturePlugin::new("fixture", "run");
        plugin
            .descriptor
            .component_namespaces
            .insert("plugin://other/component".into());
        assert!(matches!(
            provider.register_plugin(Box::new(plugin)),
            Err(PluginError::InvalidDescriptor(_))
        ));
    }
}
