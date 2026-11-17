use super::*;
use crate::host_services::{HostApiDescriptor, HostServicesConfig, TrustedApplication};
use crate::plugin::{
    PluginApiDescriptor, PluginDescriptor, RuntimePlugin, PLUGIN_PROTOCOL_VERSION,
};
use crate::provider::{HostApiProvider, ProviderContext, ProviderStart, SandboxProvider};
use container_ir::CapabilitySupport;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const API: &str = "weappContainer.plugin.fixture.run";

struct FixturePlugin {
    descriptor: PluginDescriptor,
    provider: RecordingProvider,
}

impl FixturePlugin {
    fn new() -> Self {
        Self {
            descriptor: PluginDescriptor {
                id: "fixture".into(),
                version: "1.0.0".into(),
                protocol_version: PLUGIN_PROTOCOL_VERSION,
                apis: vec![PluginApiDescriptor {
                    descriptor: HostApiDescriptor {
                        name: API.into(),
                        kind: "async".into(),
                        owner: "plugin".into(),
                        permission: Some("fixture.run".into()),
                        factory: None,
                        object_type: None,
                        event: None,
                        counterpart: None,
                        metadata: BTreeMap::new(),
                    },
                    support: CapabilitySupport::Partial,
                }],
                component_namespaces: BTreeSet::new(),
            },
            provider: RecordingProvider::default(),
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

#[derive(Default)]
struct RecordingProvider {
    contexts: Vec<ProviderContext>,
}

impl HostApiProvider for RecordingProvider {
    fn name(&self) -> &'static str {
        "fixture-plugin"
    }

    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        BTreeMap::from([(API.into(), CapabilitySupport::Full)])
    }

    fn start_call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> ProviderStart {
        self.contexts.push(context.clone());
        assert_eq!(name, API);
        assert_eq!(payload.get("value"), Some(&json!(7)));
        ProviderStart::Ready(Ok(json!({
            "sessionId": context.session_id,
            "deadlineNs": context.deadline_ns,
            "cancelToken": context.cancel_token,
        })))
    }

    fn call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, crate::provider::ProviderError> {
        self.start_call(name, payload, context).into_result()
    }
}

trait ProviderStartExt {
    fn into_result(self) -> Result<Value, crate::provider::ProviderError>;
}

impl ProviderStartExt for ProviderStart {
    fn into_result(self) -> Result<Value, crate::provider::ProviderError> {
        match self {
            ProviderStart::Ready(result) => result,
            ProviderStart::Pending => Err(crate::provider::ProviderError::timeout(
                "fixture provider unexpectedly deferred",
            )),
        }
    }
}

fn manifest() -> ContainerManifestV1 {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "plugin-session-tests".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.refresh_integrity().unwrap();
    manifest
}

fn host_config(manifest: &ContainerManifestV1, apis: &[&str]) -> HostServicesConfig {
    HostServicesConfig {
        application: TrustedApplication {
            host_app_id: "host".into(),
            tenant_id: "tenant".into(),
            publisher_id: "publisher".into(),
            app_id: "app".into(),
            environment: "trial".into(),
            version: "1.0.0".into(),
            pack_root: manifest.integrity.root.clone(),
        },
        account: HostAccount::default(),
        apis: apis.iter().map(|api| (*api).into()).collect(),
        sync_values: BTreeMap::new(),
    }
}

#[test]
fn registered_plugin_descriptor_enters_host_configuration_and_negotiation() {
    let mut session = Session::new(manifest(), SessionConfig::default()).unwrap();
    session
        .register_plugin(Box::new(FixturePlugin::new()))
        .unwrap();
    assert_eq!(
        session.provider.capabilities()[API],
        CapabilitySupport::Partial,
        "capability negotiation must use the plugin descriptor"
    );
    let config = host_config(session.manifest(), &[API]);
    session.configure_host_services(config).unwrap();
    assert!(session.host_services.registered.contains(API));
    assert_eq!(
        session.provider.capabilities()[API],
        CapabilitySupport::Partial
    );
}

#[test]
fn unregistered_plugin_api_is_rejected_and_duplicate_api_is_atomic() {
    let mut session = Session::new(manifest(), SessionConfig::default()).unwrap();
    assert!(session
        .configure_host_services(host_config(session.manifest(), &[API]))
        .is_err());

    session
        .register_plugin(Box::new(FixturePlugin::new()))
        .unwrap();
    let mut duplicate = FixturePlugin::new();
    duplicate.descriptor.apis[0].descriptor.name = "weappContainer.plugin.fixture.other".into();
    assert!(session.register_plugin(Box::new(duplicate)).is_err());
    assert_eq!(session.provider.api_descriptors().len(), 1);
}

#[test]
fn plugin_registration_is_closed_after_configuration_or_app_init() {
    let mut configured = Session::new(manifest(), SessionConfig::default()).unwrap();
    configured
        .register_plugin(Box::new(FixturePlugin::new()))
        .unwrap();
    configured
        .configure_host_services(host_config(configured.manifest(), &[API]))
        .unwrap();
    assert!(configured
        .register_plugin(Box::new(FixturePlugin::new()))
        .is_err());

    let mut initialized = Session::new(manifest(), SessionConfig::default()).unwrap();
    // The native engine is feature-gated in this crate's default test build;
    // set the same lifecycle fence that a successful app.init establishes.
    initialized.initialized = true;
    assert!(initialized
        .register_plugin(Box::new(FixturePlugin::new()))
        .is_err());
}

#[test]
fn configured_plugin_provider_receives_the_session_context() {
    let mut session = Session::new(manifest(), SessionConfig::default()).unwrap();
    session
        .register_plugin(Box::new(FixturePlugin::new()))
        .unwrap();
    session
        .configure_host_services(host_config(session.manifest(), &[API]))
        .unwrap();

    let context = ProviderContext {
        session_id: "session-7".into(),
        deadline_ns: Some(123),
        cancel_token: Some("cancel-7".into()),
        ..ProviderContext::default()
    };
    let payload = Map::from_iter([(String::from("value"), json!(7))]);
    let result = session.provider.start_call(API, &payload, &context);
    assert_eq!(
        result,
        ProviderStart::Ready(Ok(json!({
            "sessionId": "session-7",
            "deadlineNs": 123,
            "cancelToken": "cancel-7"
        })))
    );
}
