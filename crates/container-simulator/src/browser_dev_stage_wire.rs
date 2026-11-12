//! Strict stage wire types, derived from the existing finite Node helper.
//!
//! These types describe bytes, not ownership or publication authority. Hash the
//! original input buffers; never serialize these projections to obtain pins.
//! `RawData`/`StrictJson` reject duplicate keys while reading the original JSON,
//! including arbitrary nested application data, before constructing any Value.

use crate::browser_dev_coordinator::TransportBackend;
use crate::browser_dev_runtime_receipt::RuntimeBundleRenderer;
use container_ir::RendererProfile;
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Number, Value};
use std::fmt;
use std::path::PathBuf;

#[derive(Debug, PartialEq)]
pub(super) struct StrictJson(pub(super) Value);

impl StrictJson {
    pub(super) fn value(&self) -> &Value {
        &self.0
    }
}

impl<'de> Deserialize<'de> for StrictJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;

        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = StrictJson;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("JSON with unique object keys at every depth")
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(StrictJson(Value::Null))
            }

            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                self.visit_unit()
            }

            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(StrictJson(Value::Bool(value)))
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(StrictJson(Value::Number(Number::from(value))))
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(StrictJson(Value::Number(Number::from(value))))
            }

            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                let number =
                    Number::from_f64(value).ok_or_else(|| E::custom("non-finite JSON number"))?;
                Ok(StrictJson(Value::Number(number)))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(StrictJson(Value::String(value.to_owned())))
            }

            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(StrictJson(Value::String(value)))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = access.next_element::<StrictJson>()? {
                    values.push(value.0);
                }
                Ok(StrictJson(Value::Array(values)))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some(key) = access.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate JSON object key"));
                    }
                    let value = access.next_value::<StrictJson>()?;
                    values.insert(key, value.0);
                }
                Ok(StrictJson(Value::Object(values)))
            }
        }

        deserializer.deserialize_any(JsonVisitor)
    }
}

/// Application data must be an object, but its nested application-owned keys
/// are intentionally unrestricted. They still pass through StrictJson once.
#[derive(Debug, PartialEq)]
pub(super) struct RawData(pub(super) Value);

impl RawData {
    pub(super) fn value(&self) -> &Value {
        &self.0
    }
}

impl<'de> Deserialize<'de> for RawData {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = StrictJson::deserialize(deserializer)?.0;
        if !value.is_object() {
            return Err(de::Error::custom("application data must be a JSON object"));
        }
        Ok(Self(value))
    }
}

// An absent optional startup field is valid. Explicit null is not: the helper
// requires records for data/query/launchOptions/metrics and a string for route.
fn optional_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

// Unlike an ordinary Option field, a field using this helper remains required
// in the wire object while its value may explicitly be null.
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FilePin {
    pub(super) path: String,
    pub(super) sha256: String,
    pub(super) size: u64,
}

pub(super) type IndexDescriptor = FilePin;

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProducerClaim {
    pub(super) report_sha256: String,
    pub(super) source_commit: String,
    pub(super) source_sha256: String,
    pub(super) renderer: RuntimeBundleRenderer,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Provenance {
    pub(super) status: String,
    pub(super) app_service: String,
    pub(super) presentation: String,
    pub(super) gpu: String,
    pub(super) producer_glue_interface_reexecuted: bool,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RuntimeResult {
    pub(super) directory: PathBuf,
    pub(super) bundle_id: String,
    pub(super) descriptor_sha256: String,
    pub(super) producer: ProducerClaim,
    pub(super) runtime_files: Vec<FilePin>,
    pub(super) provenance: Provenance,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RuntimeBundle {
    pub(super) schema_version: u32,
    pub(super) scope: String,
    pub(super) producer: ProducerClaim,
    pub(super) files: Vec<FilePin>,
    pub(super) runtime_files: Vec<FilePin>,
    pub(super) app_service: String,
    pub(super) presentation: String,
    pub(super) gpu: String,
    pub(super) bundle_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StageResult {
    pub(super) schema_version: u32,
    pub(super) request_id: String,
    pub(super) op: String,
    pub(super) status: String,
    pub(super) runtime: RuntimeResult,
    pub(super) stage: StageOutput,
    pub(super) runtime_ready: bool,
    pub(super) presented_ready: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StageOutput {
    pub(super) status: String,
    pub(super) directory: PathBuf,
    pub(super) descriptor: SiteDescriptor,
    pub(super) descriptor_sha256: String,
    pub(super) files: Vec<FilePin>,
    // Advisory text is retained in the strict wire shape. Authority is checked
    // through the typed status/readiness/provenance fields, not this prose.
    #[serde(rename = "limitations")]
    pub(super) _limitations: Vec<String>,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PublicationToken {
    pub(super) source_revision: String,
    pub(super) compiler_receipt_sequence: String,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RuntimeBundlePin {
    pub(super) id: String,
    pub(super) descriptor_sha256: String,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AdmissionRoute {
    pub(super) path: String,
    pub(super) declared_profile: RendererProfile,
    pub(super) transport_backend: TransportBackend,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Admission {
    pub(super) status: String,
    pub(super) loader_source_path: String,
    pub(super) loader_sha256: String,
    pub(super) routes: Vec<AdmissionRoute>,
    #[serde(rename = "requiresCanvasKit")]
    pub(super) requires_canvaskit: bool,
    pub(super) limitations: Vec<String>,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SiteDescriptor {
    pub(super) schema_version: u32,
    pub(super) scope: String,
    pub(super) run_id: String,
    pub(super) site_id: String,
    pub(super) pack_revision: String,
    pub(super) input_binding_sha256: String,
    pub(super) startup_intent_sha256: String,
    // This is startupIntent.route (or explicit null), not the portable report's
    // requested_route. The independently resolved route is selected_route.
    #[serde(deserialize_with = "required_nullable")]
    pub(super) requested_route: Option<String>,
    pub(super) selected_route: String,
    pub(super) publication_token: PublicationToken,
    pub(super) runtime_bundle: RuntimeBundlePin,
    pub(super) pack_index: IndexDescriptor,
    pub(super) manifest_sha256: String,
    pub(super) integrity_root: String,
    pub(super) compiler_commit: String,
    pub(super) product_config: FilePin,
    pub(super) startup_json: FilePin,
    pub(super) admission: Admission,
    pub(super) publication: String,
    pub(super) runtime: String,
    pub(super) presentation: String,
    pub(super) gpu: String,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BlobPin {
    pub(super) sha256: String,
    pub(super) url: String,
    pub(super) size: u64,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PackIndex {
    pub(super) schema_version: u32,
    pub(super) manifest: String,
    pub(super) manifest_sha256: String,
    pub(super) integrity_root: String,
    pub(super) blobs: Vec<BlobPin>,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Viewport {
    #[serde(deserialize_with = "super::number_semantics::deserialize_safe_u32")]
    pub(super) width: u32,
    #[serde(deserialize_with = "super::number_semantics::deserialize_safe_u32")]
    pub(super) height: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum RendererPolicy {
    Manifest,
    Force { profile: RendererProfile },
}

impl<'de> Deserialize<'de> for RendererPolicy {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct PolicyVisitor;

        impl<'de> Visitor<'de> for PolicyVisitor {
            type Value = RendererPolicy;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an exact manifest or force renderer policy")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut mode = None;
                let mut profile = None;
                while let Some(key) = access.next_key::<String>()? {
                    match key.as_str() {
                        "mode" => {
                            if mode.is_some() {
                                return Err(de::Error::duplicate_field("mode"));
                            }
                            mode = Some(access.next_value::<String>()?);
                        }
                        "profile" => {
                            if profile.is_some() {
                                return Err(de::Error::duplicate_field("profile"));
                            }
                            profile = Some(access.next_value::<RendererProfile>()?);
                        }
                        _ => return Err(de::Error::unknown_field(&key, &["mode", "profile"])),
                    }
                }
                match (mode.as_deref(), profile) {
                    (Some("manifest"), None) => Ok(RendererPolicy::Manifest),
                    (Some("force"), Some(profile)) => Ok(RendererPolicy::Force { profile }),
                    _ => Err(de::Error::custom("invalid exact renderer policy")),
                }
            }
        }

        deserializer.deserialize_map(PolicyVisitor)
    }
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StartupIntent {
    #[serde(deserialize_with = "super::number_semantics::deserialize_safe_u32")]
    pub(super) schema_version: u32,
    pub(super) execution: String,
    pub(super) engine: String,
    pub(super) viewport: Viewport,
    pub(super) renderer_policy: RendererPolicy,
    #[serde(default, deserialize_with = "optional_present")]
    pub(super) render_scale: Option<crate::presentation::RenderScale>,
    #[serde(default, deserialize_with = "optional_present")]
    pub(super) route: Option<String>,
    #[serde(default, deserialize_with = "optional_present")]
    pub(super) data: Option<RawData>,
    #[serde(default, deserialize_with = "optional_present")]
    pub(super) query: Option<RawData>,
    #[serde(default, deserialize_with = "optional_present")]
    pub(super) launch_options: Option<RawData>,
    #[serde(default, deserialize_with = "optional_present")]
    pub(super) metrics: Option<RawData>,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StartupIndex {
    pub(super) url: String,
    pub(super) sha256: String,
    #[serde(deserialize_with = "super::number_semantics::deserialize_safe_u64")]
    pub(super) size: u64,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StartupJson {
    #[serde(deserialize_with = "super::number_semantics::deserialize_safe_u32")]
    pub(super) schema_version: u32,
    pub(super) execution: String,
    pub(super) engine: String,
    pub(super) index: StartupIndex,
    pub(super) renderer_policy: RendererPolicy,
    pub(super) viewport: Viewport,
    // The exact captured runtime config is compared by the parent verifier.
    #[serde(default, deserialize_with = "optional_present")]
    pub(super) render_scale: Option<crate::presentation::RenderScale>,
    // The field is required; software emits null, CanvasKit emits an object.
    #[serde(deserialize_with = "required_nullable")]
    pub(super) renderer_assets: Option<StrictJson>,
    // stageBrowserPackGeneration always resolves and passes selectedRoute.
    pub(super) route: String,
    #[serde(default, deserialize_with = "optional_present")]
    pub(super) data: Option<RawData>,
    #[serde(default, deserialize_with = "optional_present")]
    pub(super) query: Option<RawData>,
    #[serde(default, deserialize_with = "optional_present")]
    pub(super) launch_options: Option<RawData>,
    #[serde(default, deserialize_with = "optional_present")]
    pub(super) metrics: Option<RawData>,
}
