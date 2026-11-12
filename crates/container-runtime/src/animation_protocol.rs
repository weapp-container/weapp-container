//! Strict values for the runtime-owned animation presentation lane. These
//! payloads describe sampled styles, never executable browser animations.

use crate::{animation_timeline, style_transforms};
use container_bridge::{BridgeError, BridgeErrorCode};
use container_ir::{PresentationKey, ViewViewport};
use container_render_skia::{Rect, Transform2D};
use serde::{Deserialize, Serialize};

pub(super) const VERSION: &str = "1.0";

fn invalid(message: &str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::InvalidRequest, message)
}

pub(super) fn render_number(value: f64) -> Result<f32, BridgeError> {
    let rounded = value as f32;
    if !value.is_finite() || !rounded.is_finite() || value != 0.0 && rounded == 0.0 {
        return Err(invalid(
            "animation observation exceeds finite render precision",
        ));
    }
    Ok(if rounded == 0.0 { 0.0 } else { rounded })
}

mod revision {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    pub(super) fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let source = String::deserialize(deserializer)?;
        source
            .parse::<u64>()
            .ok()
            .filter(|value| value.to_string() == source)
            .ok_or_else(|| D::Error::custom("animation revision must be a canonical u64 string"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ConsumedSample {
    #[serde(with = "revision")]
    pub demand_revision: u64,
    #[serde(with = "revision")]
    pub sample_revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Matrix {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub tx: f64,
    pub ty: f64,
}

impl Matrix {
    pub(super) fn from_affine(value: Transform2D) -> Self {
        Self {
            a: f64::from(value.a),
            b: f64::from(value.b),
            c: f64::from(value.c),
            d: f64::from(value.d),
            tx: f64::from(value.e),
            ty: f64::from(value.f),
        }
    }

    pub(super) fn affine(self) -> Result<Transform2D, BridgeError> {
        Ok(Transform2D {
            a: render_number(self.a)?,
            b: render_number(self.b)?,
            c: render_number(self.c)?,
            d: render_number(self.d)?,
            e: render_number(self.tx)?,
            f: render_number(self.ty)?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SampledStyle {
    pub occurrence_id: String,
    pub opacity: Option<f32>,
    pub transform: Option<Matrix>,
    pub origin: Option<String>,
}

impl SampledStyle {
    pub(super) fn from_sample(
        occurrence_id: String,
        sample: &animation_timeline::Sample,
        font_size: f32,
        viewport: Rect,
    ) -> Result<Self, BridgeError> {
        Ok(Self {
            occurrence_id,
            opacity: sample.opacity,
            transform: sample.transform.map(Matrix::from_affine),
            origin: sample
                .transform_origin
                .as_deref()
                .map(|source| style_transforms::animation_origin(source, font_size, viewport))
                .transpose()?,
        })
    }

    pub(super) fn inherit_missing(&mut self, previous: &Self) {
        self.opacity = self.opacity.or(previous.opacity);
        self.transform = self.transform.or(previous.transform);
        if self.origin.is_none() {
            self.origin.clone_from(&previous.origin);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BaselineRequest {
    pub occurrence_id: String,
    pub opacity: bool,
    pub transform: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OriginPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BaselineObservation {
    pub occurrence_id: String,
    pub opacity: Option<f64>,
    pub transform: Option<Matrix>,
    pub font_size: f64,
    pub origin: Option<OriginPoint>,
}

impl BaselineObservation {
    pub(super) fn validate(&self, request: &BaselineRequest) -> Result<(), BridgeError> {
        if self.occurrence_id != request.occurrence_id
            || self.opacity.is_some() != request.opacity
            || self.transform.is_some() != request.transform
            || self.origin.is_some() != request.transform
            || render_number(self.font_size)? < 0.0
        {
            return Err(invalid(
                "animation baseline does not match its property request",
            ));
        }
        if let Some(opacity) = self.opacity {
            render_number(opacity)?;
            if !(0.0..=1.0).contains(&opacity) {
                return Err(invalid("animation baseline opacity is outside [0,1]"));
            }
        }
        if let Some(matrix) = self.transform {
            matrix.affine()?;
        }
        if let Some(origin) = self.origin {
            render_number(origin.x)?;
            render_number(origin.y)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnimationSubmission {
    pub version: &'static str,
    pub request_id: String,
    pub baselines: Vec<BaselineRequest>,
    pub styles: Vec<SampledStyle>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BaselinePayload {
    pub version: String,
    pub request_id: String,
    pub key: PresentationKey,
    #[serde(with = "revision")]
    pub epoch: u64,
    pub values: Vec<BaselineObservation>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SamplePermit {
    pub version: String,
    pub key: PresentationKey,
    pub base_key: PresentationKey,
    #[serde(with = "revision")]
    pub base_geometry_epoch: u64,
    pub consumed_sample: ConsumedSample,
    pub permit_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SampleSubmission {
    pub version: &'static str,
    pub key: PresentationKey,
    pub base_key: PresentationKey,
    #[serde(with = "revision")]
    pub base_geometry_epoch: u64,
    pub consumed_sample: ConsumedSample,
    pub viewport: ViewViewport,
    pub styles: Vec<SampledStyle>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PrepareSamplePayload {
    pub version: String,
    pub base_key: PresentationKey,
    #[serde(with = "revision")]
    pub base_geometry_epoch: u64,
    #[serde(with = "revision")]
    pub sample_demand_revision: u64,
}
