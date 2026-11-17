//! Renderer-independent presentation identity and browser-owned geometry.
//!
//! Coordinates are logical CSS pixels. A bounding rectangle is not a clip,
//! intersection, computed style or hit-test result. Runtime admission must
//! additionally match the key and node identities to its pending document.
use crate::RendererProfile;
use serde::{de, ser::SerializeStruct, Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeSet;

pub const VIEW_PRESENTATION_VERSION: &str = "1.0";
pub const MAX_BROWSER_GEOMETRY_NODES: usize = 100_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewPresentationError(pub String);

impl std::fmt::Display for ViewPresentationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ViewPresentationError {}

fn invalid(message: &str) -> ViewPresentationError {
    ViewPresentationError(message.into())
}

/// Exactly correlated with a runtime-owned pending or presented document.
/// Every integer is a canonical decimal string on the wire, including zero.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(try_from = "PresentationKeyWire")]
pub struct PresentationKey {
    pub session_id: String,
    pub page_id: u64,
    pub document_revision: u64,
    pub presentation_revision: u64,
    pub surface_generation: u64,
    pub profile: RendererProfile,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(try_from = "ViewViewportWire")]
pub struct ViewViewport {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(try_from = "ViewRectWire")]
pub struct ViewRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(try_from = "ViewPointWire")]
pub struct ViewPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(try_from = "ViewSizeWire")]
pub struct ViewSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(try_from = "BrowserNodeGeometryWire")]
pub struct BrowserNodeGeometry {
    pub occurrence_id: String,
    pub border_box: ViewRect,
    pub scroll_offset: ViewPoint,
    pub scroll_extent: ViewSize,
    pub client_size: ViewSize,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(try_from = "BrowserGeometryBatchWire")]
pub struct BrowserGeometryBatch {
    pub version: String,
    pub key: PresentationKey,
    pub epoch: u64,
    pub viewport: ViewViewport,
    pub nodes: Vec<BrowserNodeGeometry>,
}

impl PresentationKey {
    pub fn validate(&self) -> Result<(), ViewPresentationError> {
        if self.session_id.trim().is_empty() {
            return Err(invalid("presentation session id must not be empty"));
        }
        if self.presentation_revision == 0 {
            return Err(invalid("presentation revision must be nonzero"));
        }
        Ok(())
    }
}

impl ViewViewport {
    pub fn validate(&self) -> Result<(), ViewPresentationError> {
        if !self.width.is_finite()
            || !self.height.is_finite()
            || self.width <= 0.0
            || self.height <= 0.0
        {
            return Err(invalid("viewport dimensions must be finite and positive"));
        }
        Ok(())
    }
}

impl ViewRect {
    pub fn validate(&self) -> Result<(), ViewPresentationError> {
        ViewPoint {
            x: self.x,
            y: self.y,
        }
        .validate()?;
        ViewSize {
            width: self.width,
            height: self.height,
        }
        .validate()
    }
}

impl ViewPoint {
    pub fn validate(&self) -> Result<(), ViewPresentationError> {
        if !self.x.is_finite() || !self.y.is_finite() {
            return Err(invalid("geometry coordinates must be finite"));
        }
        Ok(())
    }
}

impl ViewSize {
    pub fn validate(&self) -> Result<(), ViewPresentationError> {
        if !self.width.is_finite()
            || !self.height.is_finite()
            || self.width < 0.0
            || self.height < 0.0
        {
            return Err(invalid(
                "geometry dimensions must be finite and nonnegative",
            ));
        }
        Ok(())
    }
}

impl BrowserNodeGeometry {
    pub fn validate(&self) -> Result<(), ViewPresentationError> {
        if self.occurrence_id.trim().is_empty() {
            return Err(invalid("browser geometry occurrence id must not be empty"));
        }
        self.border_box.validate()?;
        // Negative offsets are valid (for example an RTL scrolling element).
        self.scroll_offset.validate()?;
        self.scroll_extent.validate()?;
        self.client_size.validate()
    }
}

impl BrowserGeometryBatch {
    pub fn validate(&self) -> Result<(), ViewPresentationError> {
        if self.version != VIEW_PRESENTATION_VERSION {
            return Err(invalid("unsupported browser geometry version"));
        }
        self.key.validate()?;
        if self.key.profile != RendererProfile::WebView {
            return Err(invalid("browser geometry requires the webview profile"));
        }
        self.viewport.validate()?;
        if self.nodes.len() > MAX_BROWSER_GEOMETRY_NODES {
            return Err(invalid("browser geometry node budget exceeded"));
        }
        let mut ids = BTreeSet::new();
        for node in &self.nodes {
            node.validate()?;
            if !ids.insert(node.occurrence_id.as_str()) {
                return Err(invalid("browser geometry occurrence ids must be unique"));
            }
        }
        Ok(())
    }
}

/// String-only parsing prevents a JSON number from losing precision before
/// reaching Rust. Leading zeroes, signs, whitespace and exponents are invalid.
mod decimal_u64 {
    use super::*;

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.is_empty()
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(de::Error::custom("expected canonical decimal u64 string"));
        }
        value
            .parse()
            .map_err(|_| de::Error::custom("decimal u64 string is out of range"))
    }
}

struct DecimalU64(u64);

impl Serialize for DecimalU64 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

// Serialization validates in-memory values too: invalid floats must never
// quietly become JSON null. Borrow each field so a large geometry batch is
// serialized without cloning the entire node vector.
macro_rules! serialize_validated {
    ($name:ident, $value:ident, { $($field:literal => $expression:expr),+ $(,)? }) => {
        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                self.validate().map_err(serde::ser::Error::custom)?;
                let $value = self;
                let mut state = serializer.serialize_struct(stringify!($name), [$($field),+].len())?;
                $(state.serialize_field($field, &$expression)?;)+
                state.end()
            }
        }
    };
}

serialize_validated!(PresentationKey, key, {
    "sessionId" => key.session_id,
    "pageId" => DecimalU64(key.page_id),
    "documentRevision" => DecimalU64(key.document_revision),
    "presentationRevision" => DecimalU64(key.presentation_revision),
    "surfaceGeneration" => DecimalU64(key.surface_generation),
    "profile" => key.profile,
});
serialize_validated!(ViewViewport, viewport, { "width" => viewport.width, "height" => viewport.height });
serialize_validated!(ViewRect, rect, {
    "x" => rect.x, "y" => rect.y, "width" => rect.width, "height" => rect.height,
});
serialize_validated!(ViewPoint, point, { "x" => point.x, "y" => point.y });
serialize_validated!(ViewSize, size, { "width" => size.width, "height" => size.height });
serialize_validated!(BrowserNodeGeometry, node, {
    "occurrenceId" => node.occurrence_id,
    "borderBox" => node.border_box,
    "scrollOffset" => node.scroll_offset,
    "scrollExtent" => node.scroll_extent,
    "clientSize" => node.client_size,
});
serialize_validated!(BrowserGeometryBatch, batch, {
    "version" => batch.version,
    "key" => batch.key,
    "epoch" => DecimalU64(batch.epoch),
    "viewport" => batch.viewport,
    "nodes" => batch.nodes,
});

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresentationKeyWire {
    session_id: String,
    #[serde(deserialize_with = "decimal_u64::deserialize")]
    page_id: u64,
    #[serde(deserialize_with = "decimal_u64::deserialize")]
    document_revision: u64,
    #[serde(deserialize_with = "decimal_u64::deserialize")]
    presentation_revision: u64,
    #[serde(deserialize_with = "decimal_u64::deserialize")]
    surface_generation: u64,
    profile: RendererProfile,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewViewportWire {
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewRectWire {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewPointWire {
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ViewSizeWire {
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserNodeGeometryWire {
    occurrence_id: String,
    border_box: ViewRect,
    scroll_offset: ViewPoint,
    scroll_extent: ViewSize,
    client_size: ViewSize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserGeometryBatchWire {
    version: String,
    key: PresentationKey,
    #[serde(deserialize_with = "decimal_u64::deserialize")]
    epoch: u64,
    viewport: ViewViewport,
    #[serde(deserialize_with = "bounded_nodes")]
    nodes: Vec<BrowserNodeGeometry>,
}

/// Reject an oversized input while reading it, rather than allocating an
/// unbounded vector and validating its length only after deserialization.
fn bounded_nodes<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<BrowserNodeGeometry>, D::Error> {
    struct NodesVisitor;
    impl<'de> de::Visitor<'de> for NodesVisitor {
        type Value = Vec<BrowserNodeGeometry>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(
                formatter,
                "at most {MAX_BROWSER_GEOMETRY_NODES} geometry nodes"
            )
        }

        fn visit_seq<A: de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            if sequence
                .size_hint()
                .is_some_and(|size| size > MAX_BROWSER_GEOMETRY_NODES)
            {
                return Err(de::Error::custom("browser geometry node budget exceeded"));
            }
            let mut nodes = Vec::with_capacity(
                sequence
                    .size_hint()
                    .unwrap_or(0)
                    .min(MAX_BROWSER_GEOMETRY_NODES),
            );
            while let Some(node) = sequence.next_element()? {
                if nodes.len() == MAX_BROWSER_GEOMETRY_NODES {
                    return Err(de::Error::custom("browser geometry node budget exceeded"));
                }
                nodes.push(node);
            }
            Ok(nodes)
        }
    }
    deserializer.deserialize_seq(NodesVisitor)
}

macro_rules! validate_decoded {
    ($name:ident, $wire:ident, $($field:ident),+ $(,)?) => {
        impl TryFrom<$wire> for $name {
            type Error = ViewPresentationError;
            fn try_from(wire: $wire) -> Result<Self, Self::Error> {
                let value = Self { $($field: wire.$field),+ };
                value.validate()?;
                Ok(value)
            }
        }
    };
}

validate_decoded!(
    PresentationKey,
    PresentationKeyWire,
    session_id,
    page_id,
    document_revision,
    presentation_revision,
    surface_generation,
    profile
);
validate_decoded!(ViewViewport, ViewViewportWire, width, height);
validate_decoded!(ViewRect, ViewRectWire, x, y, width, height);
validate_decoded!(ViewPoint, ViewPointWire, x, y);
validate_decoded!(ViewSize, ViewSizeWire, width, height);
validate_decoded!(
    BrowserNodeGeometry,
    BrowserNodeGeometryWire,
    occurrence_id,
    border_box,
    scroll_offset,
    scroll_extent,
    client_size
);
validate_decoded!(
    BrowserGeometryBatch,
    BrowserGeometryBatchWire,
    version,
    key,
    epoch,
    viewport,
    nodes
);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn key() -> PresentationKey {
        PresentationKey {
            session_id: "browser-session".into(),
            page_id: 0,
            document_revision: 0,
            presentation_revision: 1,
            surface_generation: 0,
            profile: RendererProfile::WebView,
        }
    }

    fn node() -> BrowserNodeGeometry {
        BrowserNodeGeometry {
            occurrence_id: "event:0".into(),
            border_box: ViewRect {
                x: -1.5,
                y: 2.0,
                width: 100.0,
                height: 20.0,
            },
            scroll_offset: ViewPoint { x: -3.5, y: 10.0 },
            scroll_extent: ViewSize {
                width: 250.0,
                height: 500.0,
            },
            client_size: ViewSize {
                width: 100.0,
                height: 20.0,
            },
        }
    }

    fn batch() -> BrowserGeometryBatch {
        BrowserGeometryBatch {
            version: VIEW_PRESENTATION_VERSION.into(),
            key: key(),
            epoch: 0,
            viewport: ViewViewport {
                width: 375.0,
                height: 667.0,
            },
            nodes: vec![node()],
        }
    }

    #[test]
    fn every_u64_preserves_maximum_without_a_json_number() {
        let mut batch = batch();
        batch.key.page_id = u64::MAX;
        batch.key.document_revision = u64::MAX;
        batch.key.presentation_revision = u64::MAX;
        batch.key.surface_generation = u64::MAX;
        batch.epoch = u64::MAX;
        let bytes = serde_json::to_vec(&batch).unwrap();
        let wire: Value = serde_json::from_slice(&bytes).unwrap();
        for name in [
            "pageId",
            "documentRevision",
            "presentationRevision",
            "surfaceGeneration",
        ] {
            assert_eq!(wire["key"][name], u64::MAX.to_string());
        }
        assert_eq!(wire["epoch"], u64::MAX.to_string());
        assert_eq!(
            serde_json::from_slice::<BrowserGeometryBatch>(&bytes).unwrap(),
            batch
        );
    }

    #[test]
    fn initial_zeroes_round_trip_but_presentation_revision_must_be_nonzero() {
        let wire = serde_json::to_value(batch()).unwrap();
        assert_eq!(wire["epoch"], "0");
        for name in ["pageId", "documentRevision", "surfaceGeneration"] {
            assert_eq!(wire["key"][name], "0");
        }
        assert!(serde_json::from_value::<BrowserGeometryBatch>(wire.clone()).is_ok());
        let mut invalid = wire;
        invalid["key"]["presentationRevision"] = json!("0");
        assert!(serde_json::from_value::<BrowserGeometryBatch>(invalid).is_err());
        let mut invalid = key();
        invalid.presentation_revision = 0;
        assert!(invalid.validate().is_err());
        assert!(serde_json::to_value(invalid).is_err());
    }

    #[test]
    fn integer_wire_rejects_numbers_and_noncanonical_decimal_strings() {
        let invalid = [
            json!(0),
            json!(1),
            json!(1.5),
            json!(true),
            Value::Null,
            json!(""),
            json!("00"),
            json!("01"),
            json!("+1"),
            json!("-0"),
            json!("-1"),
            json!(" 1"),
            json!("1 "),
            json!("1\n"),
            json!("1.0"),
            json!("1e2"),
            json!("０"),
            json!("18446744073709551616"),
        ];
        for field in [
            "pageId",
            "documentRevision",
            "presentationRevision",
            "surfaceGeneration",
            "epoch",
        ] {
            for value in &invalid {
                let mut wire = serde_json::to_value(batch()).unwrap();
                if field == "epoch" {
                    wire[field] = value.clone();
                } else {
                    wire["key"][field] = value.clone();
                }
                assert!(
                    serde_json::from_value::<BrowserGeometryBatch>(wire).is_err(),
                    "{field}: {value}"
                );
            }
        }
    }

    #[test]
    fn unknown_duplicate_or_missing_fields_are_not_accepted() {
        let mut wire = serde_json::to_value(batch()).unwrap();
        wire["intersectionRatio"] = json!(1);
        assert!(serde_json::from_value::<BrowserGeometryBatch>(wire).is_err());
        let mut wire = serde_json::to_value(batch()).unwrap();
        wire["nodes"][0]["computedStyle"] = json!({});
        assert!(serde_json::from_value::<BrowserGeometryBatch>(wire).is_err());
        let mut wire = serde_json::to_value(batch()).unwrap();
        wire["key"]
            .as_object_mut()
            .unwrap()
            .remove("surfaceGeneration");
        assert!(serde_json::from_value::<BrowserGeometryBatch>(wire).is_err());
        let duplicate = r#"{"sessionId":"a","sessionId":"b","pageId":"0","documentRevision":"0","presentationRevision":"1","surfaceGeneration":"0","profile":"webview"}"#;
        assert!(serde_json::from_str::<PresentationKey>(duplicate).is_err());
        assert!(
            serde_json::from_str::<ViewRect>(r#"{"x":0,"y":0,"width":1,"height":1,"z":1}"#)
                .is_err()
        );
    }

    #[test]
    fn batch_version_profile_and_identifiers_are_validated() {
        for version in ["", "01.0", "1", "1.1", "2.0"] {
            let mut value = batch();
            value.version = version.into();
            assert!(value.validate().is_err());
            assert!(serde_json::to_value(value).is_err());
            let mut wire = serde_json::to_value(batch()).unwrap();
            wire["version"] = json!(version);
            assert!(serde_json::from_value::<BrowserGeometryBatch>(wire).is_err());
        }
        for profile in [RendererProfile::Skia, RendererProfile::SkylineCompat] {
            let mut value = batch();
            value.key.profile = profile;
            assert!(value.key.validate().is_ok());
            assert!(value.validate().is_err());
            let mut wire = serde_json::to_value(batch()).unwrap();
            wire["key"]["profile"] = serde_json::to_value(profile).unwrap();
            assert!(serde_json::from_value::<BrowserGeometryBatch>(wire).is_err());
        }
        for id in ["", " \t\n"] {
            let mut value = batch();
            value.key.session_id = id.into();
            assert!(value.validate().is_err());
            let mut wire = serde_json::to_value(batch()).unwrap();
            wire["nodes"][0]["occurrenceId"] = json!(id);
            assert!(serde_json::from_value::<BrowserGeometryBatch>(wire).is_err());
        }
    }

    #[test]
    fn duplicate_occurrence_ids_are_rejected_on_both_sides() {
        let mut value = batch();
        value.nodes.push(node());
        assert!(value.validate().is_err());
        assert!(serde_json::to_value(value).is_err());
        let mut wire = serde_json::to_value(batch()).unwrap();
        wire["nodes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::to_value(node()).unwrap());
        assert!(serde_json::from_value::<BrowserGeometryBatch>(wire).is_err());
    }

    #[test]
    fn nonfinite_and_negative_dimensions_never_serialize_as_valid_geometry() {
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
            for dimensions in [(value, 1.0), (1.0, value)] {
                let size = ViewSize {
                    width: dimensions.0,
                    height: dimensions.1,
                };
                assert!(size.validate().is_err());
                assert!(serde_json::to_value(size).is_err());
                let viewport = ViewViewport {
                    width: dimensions.0,
                    height: dimensions.1,
                };
                assert!(viewport.validate().is_err());
                assert!(serde_json::to_value(viewport).is_err());
                let rect = ViewRect {
                    x: 0.0,
                    y: 0.0,
                    width: dimensions.0,
                    height: dimensions.1,
                };
                assert!(serde_json::to_value(rect).is_err());
            }
        }
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for point in [
                ViewPoint { x: value, y: 0.0 },
                ViewPoint { x: 0.0, y: value },
            ] {
                assert!(point.validate().is_err());
                assert!(serde_json::to_value(point).is_err());
                let mut node = node();
                node.scroll_offset = point;
                assert!(serde_json::to_value(node).is_err());
            }
        }
        assert!(serde_json::from_value::<ViewViewport>(json!({"width":0,"height":1})).is_err());
        assert!(serde_json::from_value::<ViewViewport>(json!({"width":1,"height":-1})).is_err());
        assert!(serde_json::from_value::<ViewSize>(json!({"width":-1,"height":1})).is_err());
        assert!(
            serde_json::from_value::<ViewRect>(json!({"x":0,"y":0,"width":1,"height":-1})).is_err()
        );
        assert!(serde_json::from_str::<ViewPoint>(r#"{"x":1e999,"y":0}"#).is_err());
        assert!(serde_json::from_str::<ViewPoint>(r#"{"x":NaN,"y":0}"#).is_err());
    }

    #[test]
    fn zero_node_sizes_and_negative_positions_offsets_are_valid_browser_facts() {
        let mut value = batch();
        value.nodes[0].border_box = ViewRect {
            x: -100.0,
            y: -50.0,
            width: 0.0,
            height: 0.0,
        };
        value.nodes[0].scroll_offset = ViewPoint {
            x: -100.0,
            y: -50.0,
        };
        value.nodes[0].scroll_extent = ViewSize {
            width: 0.0,
            height: 0.0,
        };
        value.nodes[0].client_size = ViewSize {
            width: 0.0,
            height: 0.0,
        };
        let wire = serde_json::to_vec(&value).unwrap();
        assert_eq!(
            serde_json::from_slice::<BrowserGeometryBatch>(&wire).unwrap(),
            value
        );
        value.nodes.clear();
        assert!(value.validate().is_ok());
    }

    #[test]
    fn node_budget_accepts_boundary_and_rejects_oversized_memory_and_wire() {
        let mut value = batch();
        value.nodes = (0..MAX_BROWSER_GEOMETRY_NODES)
            .map(|index| {
                let mut node = node();
                node.occurrence_id = format!("event:{index}");
                node
            })
            .collect();
        assert!(value.validate().is_ok());
        let mut extra = node();
        extra.occurrence_id = "extra".into();
        value.nodes.push(extra);
        assert!(value.validate().unwrap_err().to_string().contains("budget"));
        assert!(serde_json::to_value(value).is_err());

        // Construct untrusted bytes independently of the checked serializer.
        let mut empty = batch();
        empty.nodes.clear();
        let node_json = serde_json::to_string(&node()).unwrap();
        let mut nodes = format!("{node_json},").repeat(MAX_BROWSER_GEOMETRY_NODES + 1);
        nodes.pop();
        let wire = serde_json::to_string(&empty)
            .unwrap()
            .replace("\"nodes\":[]", &format!("\"nodes\":[{nodes}]"));
        let error = serde_json::from_str::<BrowserGeometryBatch>(&wire).unwrap_err();
        assert!(error.to_string().contains("budget"), "{error}");
    }
}
