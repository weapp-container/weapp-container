//! Rendering contracts shared by every container host.
//!
//! The default build intentionally uses a deterministic software command sink.  The
//! `skia-backend` feature reserves the Skia raster integration point without pulling
//! platform SDKs into ordinary CI builds.

pub use container_core::selector::SelectorError;
use container_core::selector::{
    query as query_selector, CompiledSelectorList, SelectorNodeRef, SelectorTree,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::time::Instant;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use web_time::Instant;
mod border;
#[cfg(test)]
mod canvas_affine_tests;
mod canvas_arcto;
#[cfg(test)]
mod canvas_arcto_tests;
mod canvas_batch;
mod canvas_clip;
mod canvas_service;
mod owned_canvas;
pub use owned_canvas::{CanvasOwnerKey, MAX_OWNED_CANVASES, MAX_OWNED_CANVAS_BYTES};
#[cfg(any(not(feature = "skia-backend"), test))]
mod canvas_stroke;
pub use canvas_service::CanvasService;
mod density;
mod flow;
pub use density::{AcceptedDensityRepaint, PreparedDensityRepaint};
mod images;
mod native_components;
#[cfg(feature = "skia-backend")]
mod native_raster;
mod page_frame;
mod paint;
pub use page_frame::{
    AcceptedPageFrame, PageFrameTargetPolicy, PreparedPageFrame, PreparedRenderTarget,
};
#[cfg(test)]
mod paint_tests;
use border::BorderGeometry;
pub use border::{BorderSide, BorderStyle, BoxSizing};
#[cfg(any(not(feature = "skia-backend"), test))]
use canvas_batch::{PreparedCanvasBatch, PreparedCanvasCommand};
pub use flow::{
    AlignContent, AlignItems, FlexWrap, FlowEdges, FlowStyle, FormattingContext, JustifyContent,
    LayoutLength,
};
pub use images::{
    ImageGeometry, ImageMode, ImageResource, RenderImage, MAX_FRAME_IMAGES, MAX_FRAME_IMAGE_BYTES,
    MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, MAX_IMAGE_ID_BYTES, MAX_IMAGE_PIXELS,
};
mod compositing;
mod scroll;
mod text;
mod transforms;
pub use compositing::{MAX_COMPOSITING_LAYER_BYTES, MAX_COMPOSITING_LAYER_DEPTH};
pub use paint::{MAX_PAINT_DEPTH, MAX_PAINT_NODES, MAX_PAINT_PATH_ENTRIES};
#[cfg(all(
    feature = "skia-gpu-metal",
    any(target_os = "macos", target_os = "ios")
))]
use std::ffi::c_void;
#[cfg(feature = "skia-backend")]
use text::NativeTextMeasurer;
use text::{layout_text, measure_with_measurer, FallbackTextMeasurer, TextMeasurer};
pub use text::{
    measure_styled_text, GlyphPosition, LineHeight, PortableFontData, PortableFontIdentity,
    PortableFontProfile, TextAlign, TextFlowBreak, TextFlowLine, TextFlowPlan, TextFlowStyle,
    TextLayout, TextMeasurement, TextSourceSpan, TextStyle, WhiteSpace, WordBreak,
    MAX_PORTABLE_FONT_BYTES,
};

#[cfg(feature = "skia-backend")]
use skia_safe as skia;
#[cfg(feature = "skia-backend")]
mod fonts;
#[cfg(feature = "skia-backend")]
use fonts::NativeFonts;
#[cfg(feature = "skia-backend")]
pub use fonts::{NativeFontData, NativeFontInfo};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    pub fn contains(self, x: f32, y: f32) -> bool {
        x.is_finite()
            && y.is_finite()
            && self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width >= 0.0
            && self.height >= 0.0
            && x >= self.x
            && y >= self.y
            && x < self.x + self.width
            && y < self.y + self.height
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct EdgeInsets {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

impl EdgeInsets {
    pub const ZERO: Self = Self {
        top: 0.0,
        right: 0.0,
        bottom: 0.0,
        left: 0.0,
    };

    fn horizontal(self) -> f32 {
        self.left + self.right
    }

    fn vertical(self) -> f32 {
        self.top + self.bottom
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FlexDirection {
    #[default]
    Column,
    #[serde(rename = "column-reverse")]
    ColumnReverse,
    Row,
    #[serde(rename = "row-reverse")]
    RowReverse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DisplayMode {
    #[default]
    Flex,
    None,
}

/// CSS/WXSS positioning mode used by the portable layout contract.
///
/// `Static` and `Relative` participate in the parent's formatting flow. `Absolute`
/// is removed from that flow and positioned against the nearest positioned
/// ancestor, while `Fixed` is positioned against the host viewport.  WXSS
/// does not expose the browser's full containing-block machinery, so these
/// four modes are the stable subset shared by the headless and native hosts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PositionMode {
    #[default]
    Static,
    Relative,
    Absolute,
    Fixed,
}

/// Portable layout metadata. `flow` retains typed percentages and `auto`
/// until the containing block is known. The legacy dimension/inset fields
/// contain physical pixels; WXSS `rpx`/`rem` lengths are converted using the
/// host viewport before entering this tree.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LayoutStyle {
    /// Typed CSS formatting context. Missing retains the historical portable
    /// frame layout; new WXSS frames keep percentages until layout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<FlowStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f32>,
    #[serde(default)]
    pub margin: EdgeInsets,
    #[serde(default)]
    pub padding: EdgeInsets,
    /// Clockwise top/right/bottom/left border edges. These are computed
    /// values; `none` and `hidden` have zero used width.
    #[serde(default, skip_serializing_if = "border::is_empty_border")]
    pub border: [BorderSide; 4],
    /// Old frame producers already supply outer dimensions. WXSS producers
    /// explicitly select `content-box` for the CSS initial value.
    #[serde(default, skip_serializing_if = "border::is_border_box")]
    pub box_sizing: BoxSizing,
    /// CSS/WXSS border radii in clockwise order starting at top-left.
    /// Each corner keeps independent horizontal and vertical radii so the
    /// `a / b` form of `border-radius` remains portable across hosts.
    #[serde(default, skip_serializing_if = "is_zero_corner_radii")]
    pub border_radius: [CornerRadius; 4],
    #[serde(default)]
    pub direction: FlexDirection,
    #[serde(default)]
    pub gap: f32,
    #[serde(default)]
    pub display: DisplayMode,
    #[serde(default)]
    pub position: PositionMode,
    /// Computed CSS stack level. Omitted is `auto`; explicit zero creates a
    /// context on positioned boxes and Flex items. The legacy node-level
    /// `z_index` remains a separate absolute-frame compatibility contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z_index: Option<i32>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub isolation: bool,
    /// Optional physical-pixel offsets.  `None` preserves the distinction
    /// between an omitted side and an explicit zero, which matters when both
    /// opposite sides are supplied for an out-of-flow element.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<f32>,
    /// Optional CSS/WXSS affine transform.  The matrix uses the same
    /// convention as Canvas 2D (`x' = a*x + c*y + e`).  Layout geometry stays
    /// in the untransformed coordinate space; paint and hit testing apply this
    /// matrix around `transform_origin`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<Transform2D>,
    /// Transform origin values are percentages by default, with pixel values
    /// retained when WXSS explicitly supplies a length.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform_origin: Option<TransformOrigin>,
}

impl Default for LayoutStyle {
    fn default() -> Self {
        Self {
            flow: None,
            width: None,
            height: None,
            margin: EdgeInsets::ZERO,
            padding: EdgeInsets::ZERO,
            border: [BorderSide::default(); 4],
            box_sizing: BoxSizing::BorderBox,
            border_radius: [CornerRadius::ZERO; 4],
            direction: FlexDirection::Column,
            gap: 0.0,
            display: DisplayMode::Flex,
            position: PositionMode::Static,
            z_index: None,
            isolation: false,
            top: None,
            right: None,
            bottom: None,
            left: None,
            transform: None,
            transform_origin: None,
        }
    }
}

/// A single CSS/WXSS rounded corner. Values are physical pixels after the
/// runtime resolves `rpx`, percentages and viewport units.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct CornerRadius {
    pub x: f32,
    pub y: f32,
}

impl CornerRadius {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0 };
}

fn is_zero_corner_radii(value: &[CornerRadius; 4]) -> bool {
    value
        .iter()
        .all(|radius| radius.x == 0.0 && radius.y == 0.0)
}

/// A two-dimensional affine matrix shared by WXSS transforms and Canvas 2D.
/// Values are intentionally public so host adapters can submit a resolved
/// transform without crossing the bridge once per node.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Transform2D {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub e: f32,
    pub f: f32,
}

impl Transform2D {
    pub const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    pub fn apply(self, point: (f32, f32)) -> (f32, f32) {
        (
            self.a * point.0 + self.c * point.1 + self.e,
            self.b * point.0 + self.d * point.1 + self.f,
        )
    }

    /// Compose matrices so `self.multiply(other)` applies `other` first.
    pub fn multiply(self, other: Self) -> Self {
        Self::from_coefficients(self.product(other).map(|value| value as f32))
    }

    /// Admission uses the same rounded result as paint and input, while
    /// rejecting overflow or a nonzero coefficient lost to f32 underflow.
    pub fn checked_multiply(self, other: Self) -> Option<Self> {
        let exact = self.product(other);
        let rounded = exact.map(|value| value as f32);
        exact
            .into_iter()
            .zip(rounded)
            .all(|(value, result)| result.is_finite() && (value == 0.0 || result != 0.0))
            .then_some(Self::from_coefficients(rounded))
    }

    fn product(self, other: Self) -> [f64; 6] {
        let [a, b, c, d, e, f] = [self.a, self.b, self.c, self.d, self.e, self.f].map(f64::from);
        let [x, y, z, w, u, v] =
            [other.a, other.b, other.c, other.d, other.e, other.f].map(f64::from);
        [
            a * x + c * y,
            b * x + d * y,
            a * z + c * w,
            b * z + d * w,
            a * u + c * v + e,
            b * u + d * v + f,
        ]
    }

    fn from_coefficients([a, b, c, d, e, f]: [f32; 6]) -> Self {
        Self { a, b, c, d, e, f }
    }

    /// Use f64 for products of f32 coefficients: a small nonzero determinant
    /// is not singular, and multiplying valid scales must not underflow here.
    pub fn determinant(self) -> f64 {
        f64::from(self.a) * f64::from(self.d) - f64::from(self.b) * f64::from(self.c)
    }

    pub fn inverse(self) -> Option<Self> {
        if [self.a, self.b, self.c, self.d, self.e, self.f]
            .iter()
            .any(|value| !value.is_finite())
        {
            return None;
        }
        let determinant = self.determinant();
        if !determinant.is_finite() || determinant == 0.0 {
            return None;
        }
        let inverse = 1.0 / determinant;
        let result = Self {
            a: (f64::from(self.d) * inverse) as f32,
            b: (-f64::from(self.b) * inverse) as f32,
            c: (-f64::from(self.c) * inverse) as f32,
            d: (f64::from(self.a) * inverse) as f32,
            e: ((f64::from(self.c) * f64::from(self.f) - f64::from(self.d) * f64::from(self.e))
                * inverse) as f32,
            f: ((f64::from(self.b) * f64::from(self.e) - f64::from(self.a) * f64::from(self.f))
                * inverse) as f32,
        };
        [result.a, result.b, result.c, result.d, result.e, result.f]
            .into_iter()
            .all(f32::is_finite)
            .then_some(result)
    }
}

impl Default for Transform2D {
    fn default() -> Self {
        Self::IDENTITY
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransformOriginUnit {
    Percent,
    Px,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TransformOriginValue {
    pub value: f32,
    pub unit: TransformOriginUnit,
}

impl TransformOriginValue {
    pub const fn percent(value: f32) -> Self {
        Self {
            value,
            unit: TransformOriginUnit::Percent,
        }
    }

    fn resolve(self, start: f32, size: f32) -> f32 {
        match self.unit {
            TransformOriginUnit::Percent => start + size * (self.value / 100.0),
            TransformOriginUnit::Px => start + self.value,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TransformOrigin {
    pub x: TransformOriginValue,
    pub y: TransformOriginValue,
}

impl Default for TransformOrigin {
    fn default() -> Self {
        Self {
            x: TransformOriginValue::percent(50.0),
            y: TransformOriginValue::percent(50.0),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TextMetrics {
    pub width: f32,
    pub height: f32,
    pub line_count: u32,
}

/// Deterministic fallback metrics for callers without a font provider. The
/// native runtime uses `SkiaRenderer::layout_tree` so measured geometry and
/// painting share the installed fonts and accepted glyph positions.
pub fn measure_text(text: &str, font_size: f32, max_width: Option<f32>) -> TextMetrics {
    let font_size = if font_size.is_finite() && font_size >= 0.0 {
        font_size
    } else {
        16.0
    };
    measure_styled_text(
        text,
        TextStyle {
            font_size,
            ..TextStyle::default()
        },
        max_width,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Color {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
    pub alpha: u8,
}

impl Color {
    pub const BLACK: Self = Self {
        red: 0,
        green: 0,
        blue: 0,
        alpha: 255,
    };
    pub const TRANSPARENT: Self = Self {
        red: 0,
        green: 0,
        blue: 0,
        alpha: 0,
    };
    pub const WHITE: Self = Self {
        red: 255,
        green: 255,
        blue: 255,
        alpha: 255,
    };
}

/// Resolved local CSS visibility. It preserves layout; unlike display, a
/// hidden node may have a visible descendant. Legacy producers default to
/// visible and must provide resolved values when using this frame field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    #[default]
    Visible,
    Hidden,
}
impl Visibility {
    pub fn as_css(self) -> &'static str {
        match self {
            Self::Visible => "visible",
            Self::Hidden => "hidden",
        }
    }
    fn is_visible(&self) -> bool {
        *self == Self::Visible
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenderNode {
    pub id: String,
    /// Unique committed-tree address for native input. The public WXML id
    /// may repeat across component instances and remains in `id`/attributes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_identity: Option<String>,
    /// AppService instance that owns this node's declared event listeners.
    /// Kept outside user attributes/dataset so slot projection can preserve
    /// declaration ownership independently of the render parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_owner_scope_id: Option<String>,
    /// Concrete custom-component host scope used by scoped selector queries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component_scope_id: Option<String>,
    /// Optional WXML `wx:key` identity. A keyed repeat keeps this value while
    /// it crosses the IR-to-render boundary so hosts can reconcile node state
    /// when an array is reordered. The field is omitted for source nodes that
    /// are not part of a keyed `wx:for`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Optional WXML tag name used by selector queries.  Existing producers
    /// may omit it; the renderer keeps the field optional so old frame JSON
    /// remains valid while hosts can expose `view`/`text` style selectors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// Space-separated WXML class tokens represented as normalized values.
    /// Selector matching is intentionally limited to deterministic simple
    /// selectors (`#id`, `.class`, `tag`, and combinations thereof).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub classes: Vec<String>,
    /// `data-*` attributes projected to the camel-cased dataset exposed by
    /// `event.currentTarget.dataset` and selector field reads. JSON values from
    /// evaluated pure bindings retain their types; legacy string values remain
    /// strings. This widens the Rust source API, without parsing old spellings.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub dataset: BTreeMap<String, Value>,
    /// Original WXML attributes, excluding no values.  SelectorQuery
    /// `fields.properties` reads component attributes from this map while
    /// preserving the distinction between an omitted `id` and a generated
    /// portable render-node identity.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attributes: BTreeMap<String, String>,
    /// `mark:*`/`mark-*` attributes projected to the camel-cased event mark
    /// object exposed by SelectorQuery and event dispatch. JSON values from
    /// evaluated pure bindings retain their types; legacy strings remain strings.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mark: BTreeMap<String, Value>,
    /// Winning WXSS declarations after cascade and supported computed-value
    /// resolution. Uninterpreted properties retain their source spelling;
    /// inherited colors, typography and borders contain resolved values.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub computed_style: BTreeMap<String, String>,
    /// Scroll position exposed by `SelectorQuery.scrollOffset`.  Keeping the
    /// offset on the node makes selector reads observe the same committed
    /// frame as geometry and hit testing, without a host round trip.
    #[serde(
        default,
        rename = "scrollOffset",
        skip_serializing_if = "Option::is_none"
    )]
    pub scroll_offset: Option<ScrollOffset>,
    /// Resolved scrolling viewport. Only an explicit container translates its
    /// descendants; legacy `scrollOffset` metadata keeps its old wire meaning.
    #[serde(default, rename = "scrollContainer", skip_serializing_if = "is_false")]
    pub scroll_container: bool,
    pub bounds: Rect,
    pub background: Option<Color>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<RenderImage>,
    pub opacity: f32,
    #[serde(default, skip_serializing_if = "Visibility::is_visible")]
    pub visibility: Visibility,
    pub children: Vec<RenderNode>,
    /// Optional layout/text properties.  Keeping them optional preserves the
    /// v1 frame wire shape for producers that already submit absolute bounds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<LayoutStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Computed typography. Absent on legacy absolute-frame producers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_style: Option<TextStyle>,
    /// Accepted glyph positions relative to this node's content-box origin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_layout: Option<TextLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground: Option<Color>,
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub z_index: i32,
    #[serde(default = "default_hit_testable", skip_serializing_if = "is_true")]
    pub hit_testable: bool,
}

/// Scroll position of a scroll-view-like render node.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct ScrollOffset {
    #[serde(rename = "scrollLeft", default)]
    pub scroll_left: f32,
    #[serde(rename = "scrollTop", default)]
    pub scroll_top: f32,
}

fn is_zero_i32(value: &i32) -> bool {
    *value == 0
}

fn is_true(value: &bool) -> bool {
    *value
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn default_hit_testable() -> bool {
    true
}

impl RenderNode {
    pub fn new(id: impl Into<String>, bounds: Rect) -> Self {
        Self {
            id: id.into(),
            event_identity: None,
            event_owner_scope_id: None,
            component_scope_id: None,
            key: None,
            tag: None,
            classes: Vec::new(),
            dataset: BTreeMap::new(),
            attributes: BTreeMap::new(),
            mark: BTreeMap::new(),
            computed_style: BTreeMap::new(),
            scroll_offset: None,
            scroll_container: false,
            bounds,
            background: None,
            image: None,
            opacity: 1.0,
            visibility: Visibility::Visible,
            children: Vec::new(),
            style: None,
            text: None,
            text_style: None,
            text_layout: None,
            foreground: None,
            z_index: 0,
            hit_testable: true,
        }
    }

    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }

    pub fn with_text_style(mut self, style: TextStyle) -> Self {
        self.text_style = Some(style);
        self
    }

    pub fn with_style(mut self, style: LayoutStyle) -> Self {
        self.style = Some(style);
        self
    }

    /// Return the deepest hit-testable node at a viewport coordinate. Children
    /// are traversed in reverse paint order and then by descending z-index.
    pub fn hit_test(&self, x: f32, y: f32) -> Option<&RenderNode> {
        self.hit_test_path(x, y).last().copied()
    }

    /// Return root-to-target nodes for event capture/target/bubble dispatch.
    pub fn hit_test_path(&self, x: f32, y: f32) -> Vec<&RenderNode> {
        paint::PaintPlan::new(self).hit_path(x, y)
    }

    /// The same local-space clipping contract drives targeting and painting.
    /// The scrolling viewport remains fixed while its contents translate.
    fn descendant_clip(&self, radii: [CornerRadius; 4]) -> Option<OverflowClip> {
        let mut shorthand = self
            .computed_style
            .get("overflow")
            .map(String::as_str)
            .unwrap_or("visible")
            .split_ascii_whitespace();
        let default_x = shorthand.next().unwrap_or("visible");
        let default_y = shorthand.next().unwrap_or(default_x);
        let overflow_x = self
            .computed_style
            .get("overflow-x")
            .map(|value| value.trim())
            .unwrap_or(default_x);
        let overflow_y = self
            .computed_style
            .get("overflow-y")
            .map(|value| value.trim())
            .unwrap_or(default_y);
        let scrolls = |value: &str| {
            ["hidden", "scroll", "auto"]
                .iter()
                .any(|mode| value.eq_ignore_ascii_case(mode))
        };
        // CSS visible computes to auto beside a scrolling axis, while clip
        // paired with visible remains an independent one-axis clip.
        let clip_x = self.scroll_container
            || scrolls(overflow_x)
            || overflow_x.eq_ignore_ascii_case("clip")
            || (overflow_x.eq_ignore_ascii_case("visible") && scrolls(overflow_y));
        let clip_y = self.scroll_container
            || scrolls(overflow_y)
            || overflow_y.eq_ignore_ascii_case("clip")
            || (overflow_y.eq_ignore_ascii_case("visible") && scrolls(overflow_x));
        let border = BorderGeometry::new(
            self.bounds,
            LayoutStyle {
                border_radius: radii,
                ..self.style.unwrap_or_default()
            },
        );
        (clip_x || clip_y).then_some(OverflowClip {
            bounds: border.inner,
            radii: border.inner_radii,
            clip_x,
            clip_y,
        })
    }

    // Painting and targeting must use the same stable sibling ordering.
    // Flex uses order-modified document order; equal ordinal groups retain
    // document order. Hit testing reverses the very same paint order.
    fn child_paint_order(&self) -> Vec<usize> {
        let mut indexes: Vec<usize> = (0..self.children.len()).collect();
        indexes.sort_by_key(|index| {
            (
                self.children[*index].z_index,
                self.child_flow_order(*index),
                *index,
            )
        });
        indexes
    }

    /// CSS order applies only to direct Flex items. Out-of-flow children are
    /// painted in ordinal group 0, independent of their authored order. Keep
    /// this policy shared by the solver, software/native paint and targeting.
    fn child_flow_order(&self, index: usize) -> i32 {
        if self
            .style
            .and_then(|style| style.flow)
            .is_some_and(|flow| flow.context == FormattingContext::Flex)
        {
            let child = self.children[index].style.unwrap_or_default();
            if !matches!(child.position, PositionMode::Absolute | PositionMode::Fixed) {
                return child.flow.map_or(0, |flow| flow.order);
            }
        }
        0
    }

    fn validate_anonymous_flex_order(&self) -> Result<(), RenderError> {
        // WXML has independent text leaves. Legacy typed producers can instead
        // put text and children on one node: its private anonymous solver box
        // has no independent paint/hit identity yet. Do not accept a changed
        // ordinal group until that content boundary can be represented by all
        // consumers. Layout must reject this before mutating any coordinates.
        if self.text.is_some()
            && (0..self.children.len()).any(|index| self.child_flow_order(index) != 0)
        {
            return Err(RenderError::Unsupported("ordered-anonymous-flex-text"));
        }
        Ok(())
    }

    fn descendant_translation(&self) -> Transform2D {
        let offset = if self.scroll_container {
            self.scroll_offset.unwrap_or_default()
        } else {
            ScrollOffset::default()
        };
        Transform2D {
            e: -offset.scroll_left,
            f: -offset.scroll_top,
            ..Transform2D::IDENTITY
        }
    }

    /// Typed fixed boxes establish a viewport coordinate/overflow boundary.
    /// Legacy absolute-frame producers retain their historical tree behavior.
    fn is_viewport_fixed(&self) -> bool {
        self.style
            .is_some_and(|style| style.flow.is_some() && style.position == PositionMode::Fixed)
    }

    fn traversal_transform(&self, inherited: Transform2D) -> Transform2D {
        if self.is_viewport_fixed() {
            self.local_transform()
        } else {
            inherited.multiply(self.local_transform())
        }
    }

    fn local_transform(&self) -> Transform2D {
        let style = self.style.unwrap_or_default();
        let Some(matrix) = style.transform else {
            return Transform2D::IDENTITY;
        };
        let origin = style.transform_origin.unwrap_or_default();
        let origin_x = origin.x.resolve(self.bounds.x, self.bounds.width);
        let origin_y = origin.y.resolve(self.bounds.y, self.bounds.height);
        Transform2D {
            e: origin_x,
            f: origin_y,
            ..Transform2D::IDENTITY
        }
        .multiply(matrix)
        .multiply(Transform2D {
            e: -origin_x,
            f: -origin_y,
            ..Transform2D::IDENTITY
        })
    }

    /// Compute a deterministic flex-column/row layout in-place. Existing
    /// absolute bounds are retained for a node without a style and a parent
    /// without layout metadata, preserving old frame producers.
    pub fn layout(&mut self, containing: Rect) {
        // Legacy infallible API: invalid/over-budget source leaves the tree
        // untouched, and renderer commit still rejects it explicitly. New
        // production callers use SkiaRenderer::layout_tree's Result API.
        let _ = layout_tree_with_measurer(self, containing, &mut FallbackTextMeasurer);
    }
}

#[derive(Debug, Clone, Copy)]
struct OverflowClip {
    bounds: Rect,
    radii: [CornerRadius; 4],
    clip_x: bool,
    clip_y: bool,
}

#[derive(Clone, Copy)]
struct WorldOverflowClip {
    clip: OverflowClip,
    transform: Transform2D,
}

impl OverflowClip {
    fn contains(self, x: f32, y: f32) -> bool {
        if self.clip_x && self.clip_y {
            return rounded_rect_contains(self.bounds, x, y, self.radii);
        }
        (!self.clip_x || (x >= self.bounds.x && x < self.bounds.x + self.bounds.width))
            && (!self.clip_y || (y >= self.bounds.y && y < self.bounds.y + self.bounds.height))
    }
}

/// Lay out a render tree against a viewport and return the same mutable tree
/// for convenient host pipelines.
pub fn layout_tree(root: &mut RenderNode, viewport: Rect) {
    root.layout(viewport);
}

fn layout_tree_with_measurer(
    root: &mut RenderNode,
    viewport: Rect,
    measurer: &mut dyn TextMeasurer,
) -> Result<(), RenderError> {
    validate_text_budget(root)?;
    validate_containing_blocks(root)?;
    reset_text_layouts(root);
    if root.style.is_some_and(|style| style.flow.is_some()) {
        flow::layout(root, viewport, measurer)?;
        return SoftwareRenderer::validate_node_contents(root);
    }
    measure_layout_sizes(
        root,
        viewport,
        viewport,
        root.style.is_some(),
        true,
        measurer,
    );
    layout_node(root, viewport, viewport, root.style.is_some(), measurer);
    SoftwareRenderer::validate_node_contents(root)
}

/// Transformed ancestors establish an absolute containing block, which flow
/// lowering models in the solver. Viewport-fixed descendants require another
/// containing-block/scroll boundary and remain explicitly unsupported here.
fn validate_containing_blocks(root: &RenderNode) -> Result<(), RenderError> {
    fn visit(node: &RenderNode, transformed_ancestor: bool) -> Result<(), RenderError> {
        node.validate_anonymous_flex_order()?;
        if node.is_viewport_fixed() && transformed_ancestor {
            return Err(RenderError::Unsupported(
                "transformed-fixed-containing-block",
            ));
        }
        let transformed =
            transformed_ancestor || node.style.is_some_and(|style| style.transform.is_some());
        for child in &node.children {
            visit(child, transformed)?;
        }
        Ok(())
    }
    visit(root, false)
}

/// Bound dynamic Page/setData text as well as pack-sourced text. The source
/// count includes control characters, so newline-only data cannot bypass the
/// glyph budget or cause an unbounded positioning pass.
pub const MAX_FRAME_TEXT_CHARACTERS: usize = 1_000_000;

fn validate_text_budget(root: &RenderNode) -> Result<(), RenderError> {
    paint::validate_budget(root)?;
    paint::validate_mode(root)?;
    fn visit(
        node: &RenderNode,
        remaining: &mut usize,
        remaining_glyphs: &mut usize,
    ) -> Result<(), RenderError> {
        if let Some(style) = node.text_style {
            style.validate()?;
        }
        if let Some(text) = &node.text {
            let count = text.chars().take(*remaining + 1).count();
            *remaining = remaining
                .checked_sub(count)
                .ok_or(RenderError::TextBudgetExceeded)?;
        }
        if let Some(plan) = &node.text_layout {
            *remaining_glyphs = remaining_glyphs
                .checked_sub(plan.glyphs.len())
                .ok_or(RenderError::TextBudgetExceeded)?;
            if let Some(flow) = &plan.flow {
                if flow.glyph_sources.len() != plan.glyphs.len() {
                    return Err(RenderError::InvalidTextLayout);
                }
                if flow.lines.len() > node.text.as_deref().map_or(0, |text| text.chars().count()) {
                    return Err(RenderError::TextBudgetExceeded);
                }
            }
        }
        for child in &node.children {
            visit(child, remaining, remaining_glyphs)?;
        }
        Ok(())
    }
    let mut remaining = MAX_FRAME_TEXT_CHARACTERS;
    let mut remaining_glyphs = MAX_FRAME_TEXT_CHARACTERS;
    visit(root, &mut remaining, &mut remaining_glyphs)
}

fn reset_text_layouts(node: &mut RenderNode) {
    node.text_layout = None;
    for child in &mut node.children {
        reset_text_layouts(child);
    }
}

fn layout_dimension(value: Option<f32>) -> Option<f32> {
    value.filter(|value| value.is_finite() && *value >= 0.0)
}

fn is_flow_child(node: &RenderNode) -> bool {
    let style = node.style.unwrap_or_default();
    !matches!(style.display, DisplayMode::None)
        && !matches!(style.position, PositionMode::Absolute | PositionMode::Fixed)
}

/// Natural row-item width before an available cross-axis size is assigned.
/// Unstyled frame producers may supply an intrinsic rectangle directly.
fn intrinsic_layout_width(node: &RenderNode, measurer: &mut dyn TextMeasurer) -> f32 {
    let style = node.style.unwrap_or_default();
    if matches!(style.display, DisplayMode::None) {
        return 0.0;
    }
    if let Some(width) = layout_dimension(style.width) {
        return style.outer_width(width);
    }
    if node.style.is_none() && node.bounds.width > 0.0 {
        return node.bounds.width;
    }
    let text_width = node
        .text
        .as_deref()
        .map(|text| {
            measure_with_measurer(text, node.text_style.unwrap_or_default(), None, measurer).width
        })
        .unwrap_or(0.0);
    let is_row = matches!(
        style.direction,
        FlexDirection::Row | FlexDirection::RowReverse
    );
    let mut children_width = 0.0_f32;
    let mut flow_count = 0_usize;
    for child in node.children.iter().filter(|child| is_flow_child(child)) {
        let outer_width = intrinsic_layout_width(child, measurer)
            + child.style.unwrap_or_default().margin.horizontal();
        if is_row {
            children_width += outer_width;
        } else {
            children_width = children_width.max(outer_width);
        }
        flow_count += 1;
    }
    if is_row {
        children_width += style.gap.max(0.0) * flow_count.saturating_sub(1) as f32;
    }
    text_width.max(children_width) + style.content_insets().horizontal()
}

fn child_layout_width(
    child: &RenderNode,
    is_row: bool,
    content_width: f32,
    containing: Rect,
    measurer: &mut dyn TextMeasurer,
) -> f32 {
    let style = child.style.unwrap_or_default();
    if let Some(width) = layout_dimension(style.width) {
        return style.outer_width(width);
    }
    if matches!(style.position, PositionMode::Absolute | PositionMode::Fixed) {
        if let Some((left, right)) = style.left.zip(style.right) {
            return (containing.width - left - right - style.margin.horizontal())
                .max(style.content_insets().horizontal());
        }
        return intrinsic_layout_width(child, measurer);
    }
    if is_row {
        intrinsic_layout_width(child, measurer)
    } else {
        (content_width - style.margin.horizontal()).max(style.content_insets().horizontal())
    }
}

/// Measure in-flow content before arranging siblings. Width must be resolved
/// first: text wrapping changes both its own height and every auto ancestor.
/// The root rectangle belongs to the host; styled descendants with auto
/// height are remeasured, including when a previous layout left positive bounds.
fn measure_layout_sizes(
    node: &mut RenderNode,
    containing: Rect,
    viewport: Rect,
    managed: bool,
    root: bool,
    measurer: &mut dyn TextMeasurer,
) {
    let style = node.style.unwrap_or_default();
    if managed {
        if matches!(style.display, DisplayMode::None) {
            node.bounds.width = 0.0;
            node.bounds.height = 0.0;
            return;
        }
        if let Some(width) = layout_dimension(style.width) {
            node.bounds.width = style.outer_width(width);
        }
        if let Some(height) = layout_dimension(style.height) {
            node.bounds.height = style.outer_height(height);
        }
    }
    let content_width = style.content_box(node.bounds).width;
    let positioned_containing =
        if matches!(style.position, PositionMode::Static) && style.transform.is_none() {
            containing
        } else {
            style.padding_box(node.bounds)
        };
    let is_row = matches!(
        style.direction,
        FlexDirection::Row | FlexDirection::RowReverse
    );
    let parent_managed = managed || node.style.is_some();
    let mut flow_height = 0.0_f32;
    let mut flow_count = 0_usize;
    for child in &mut node.children {
        let child_style = child.style.unwrap_or_default();
        let child_managed = parent_managed || child.style.is_some();
        let child_containing = if matches!(child_style.position, PositionMode::Fixed) {
            viewport
        } else {
            positioned_containing
        };
        if child_managed {
            child.bounds.width =
                child_layout_width(child, is_row, content_width, child_containing, measurer);
            if let Some(height) = layout_dimension(child_style.height) {
                child.bounds.height = child_style.outer_height(height);
            } else if let Some(text) = child.text.as_deref() {
                let width = child_style.content_box(child.bounds).width;
                child.bounds.height = measure_with_measurer(
                    text,
                    child.text_style.unwrap_or_default(),
                    Some(width),
                    measurer,
                )
                .height
                    + child_style.content_insets().vertical();
            } else if child.style.is_some() {
                child.bounds.height = 0.0;
            }
        }
        measure_layout_sizes(
            child,
            child_containing,
            viewport,
            child_managed && child.style.is_some(),
            false,
            measurer,
        );
        if is_flow_child(child) {
            let outer_height = child.bounds.height + child_style.margin.vertical();
            if is_row {
                flow_height = flow_height.max(outer_height);
            } else {
                flow_height += outer_height;
            }
            flow_count += 1;
        }
    }
    if parent_managed && node.style.is_some() && !root && layout_dimension(style.height).is_none() {
        if !is_row {
            flow_height += style.gap.max(0.0) * flow_count.saturating_sub(1) as f32;
        }
        let text_height = node
            .text
            .as_deref()
            .map(|text| {
                measure_with_measurer(
                    text,
                    node.text_style.unwrap_or_default(),
                    Some(content_width),
                    measurer,
                )
                .height
            })
            .unwrap_or(0.0);
        node.bounds.height =
            flow_height.max(text_height).max(0.0) + style.content_insets().vertical();
    }
}

fn layout_node(
    node: &mut RenderNode,
    containing: Rect,
    viewport: Rect,
    managed: bool,
    measurer: &mut dyn TextMeasurer,
) {
    let style = node.style.unwrap_or_default();
    if managed {
        if let Some(width) = layout_dimension(style.width) {
            node.bounds.width = style.outer_width(width);
        }
        if let Some(height) = layout_dimension(style.height) {
            node.bounds.height = style.outer_height(height);
        }
        if matches!(style.display, DisplayMode::None) {
            node.bounds.width = 0.0;
            node.bounds.height = 0.0;
            return;
        }
    }
    let content = style.content_box(node.bounds);
    if node.text.is_some() {
        node.text_style.get_or_insert_with(TextStyle::default);
    }
    node.text_layout = node.text.as_deref().map(|text| {
        layout_text(
            text,
            node.text_style.unwrap_or_default(),
            Some(content.width),
            measurer,
        )
    });
    let content_x = content.x;
    let content_y = content.y;
    let content_width = content.width;
    let content_height = content.height;
    // A transform establishes an absolute containing block even on a static
    // node, without making authored static insets affect normal flow.
    let positioned_containing =
        if matches!(style.position, PositionMode::Static) && style.transform.is_none() {
            containing
        } else {
            style.padding_box(node.bounds)
        };
    let is_row = matches!(
        style.direction,
        FlexDirection::Row | FlexDirection::RowReverse
    );
    let is_reverse = matches!(
        style.direction,
        FlexDirection::ColumnReverse | FlexDirection::RowReverse
    );
    let mut cursor = if is_row {
        if is_reverse {
            content_x + content_width
        } else {
            content_x
        }
    } else if is_reverse {
        content_y + content_height
    } else {
        content_y
    };
    let parent_managed = managed || node.style.is_some();
    for child in &mut node.children {
        let child_style = child.style.unwrap_or_default();
        let margin = child_style.margin;
        let child_managed = parent_managed || child.style.is_some();
        let out_of_flow = matches!(
            child_style.position,
            PositionMode::Absolute | PositionMode::Fixed
        );
        let child_containing = if matches!(child_style.position, PositionMode::Fixed) {
            viewport
        } else {
            positioned_containing
        };
        // display:none removes a node from both layout and paint. Clear any
        // stale geometry before recursing into a reused render tree.
        if child_managed && matches!(child_style.display, DisplayMode::None) {
            child.bounds.width = 0.0;
            child.bounds.height = 0.0;
            child.text_layout = None;
            layout_node(child, child_containing, viewport, true, measurer);
            continue;
        }
        if child_managed {
            let measured = child
                .text
                .as_deref()
                .map(|text| {
                    measure_with_measurer(
                        text,
                        child.text_style.unwrap_or_default(),
                        Some(child_style.content_box(child.bounds).width),
                        measurer,
                    )
                })
                .unwrap_or(TextMetrics {
                    width: child.bounds.width,
                    height: child.bounds.height,
                    line_count: 1,
                });
            let width =
                child_layout_width(child, is_row, content_width, child_containing, measurer);
            let height = if out_of_flow {
                layout_dimension(child_style.height)
                    .map(|height| child_style.outer_height(height))
                    .or_else(|| {
                        child_style
                            .top
                            .zip(child_style.bottom)
                            .map(|(top, bottom)| {
                                (child_containing.height - top - bottom - margin.vertical())
                                    .max(child_style.content_insets().vertical())
                            })
                    })
                    .unwrap_or({
                        if child.bounds.height > 0.0 {
                            child.bounds.height
                        } else {
                            measured.height
                        }
                    })
            } else {
                layout_dimension(child_style.height)
                    .map(|height| child_style.outer_height(height))
                    .unwrap_or_else(|| {
                        if is_row {
                            (content_height - margin.vertical())
                                .max(child_style.content_insets().vertical())
                        } else if child.bounds.height > 0.0 {
                            child.bounds.height
                        } else {
                            measured.height
                        }
                    })
            };
            child.bounds.width = width;
            child.bounds.height = height;
            if out_of_flow {
                child.bounds.x = child_style
                    .left
                    .map(|left| child_containing.x + left + margin.left)
                    .or_else(|| {
                        child_style.right.map(|right| {
                            child_containing.x + child_containing.width
                                - right
                                - width
                                - margin.right
                        })
                    })
                    .unwrap_or(child_containing.x + margin.left);
                child.bounds.y = child_style
                    .top
                    .map(|top| child_containing.y + top + margin.top)
                    .or_else(|| {
                        child_style.bottom.map(|bottom| {
                            child_containing.y + child_containing.height
                                - bottom
                                - height
                                - margin.bottom
                        })
                    })
                    .unwrap_or(child_containing.y + margin.top);
            } else if is_row {
                if is_reverse {
                    child.bounds.x = cursor - margin.right - width;
                    cursor -= margin.left + width + margin.right + style.gap;
                } else {
                    child.bounds.x = cursor + margin.left;
                    cursor += margin.left + width + margin.right + style.gap;
                }
                child.bounds.y = content_y + margin.top;
                apply_relative_offset(&mut child.bounds, child_style);
            } else {
                child.bounds.x = content_x + margin.left;
                if is_reverse {
                    child.bounds.y = cursor - margin.bottom - height;
                    cursor -= margin.top + height + margin.bottom + style.gap;
                } else {
                    child.bounds.y = cursor + margin.top;
                    cursor += margin.top + height + margin.bottom + style.gap;
                }
                apply_relative_offset(&mut child.bounds, child_style);
            }
        }
        layout_node(
            child,
            child_containing,
            viewport,
            child_managed && child.style.is_some(),
            measurer,
        );
    }
}

fn apply_relative_offset(bounds: &mut Rect, style: LayoutStyle) {
    if !matches!(style.position, PositionMode::Relative) {
        return;
    }
    if let Some(left) = style.left {
        bounds.x += left;
    } else if let Some(right) = style.right {
        bounds.x -= right;
    }
    if let Some(top) = style.top {
        bounds.y += top;
    } else if let Some(bottom) = style.bottom {
        bounds.y -= bottom;
    }
}

/// Normalize CSS corner radii so adjacent radii never overlap. CSS scales all
/// radii by one factor when a side's sum exceeds the corresponding box side;
/// applying that rule here keeps hit testing and both raster backends aligned.
fn normalized_corner_radii(bounds: Rect, radii: [CornerRadius; 4]) -> [CornerRadius; 4] {
    let mut radii = radii;
    for radius in &mut radii {
        radius.x = if radius.x.is_finite() {
            radius.x.max(0.0)
        } else {
            0.0
        };
        radius.y = if radius.y.is_finite() {
            radius.y.max(0.0)
        } else {
            0.0
        };
    }
    // An empty adjacent pair imposes no constraint. Replacing its zero sum
    // with 1 incorrectly shrinks other corners on subpixel-sized boxes.
    // Use f64 for both sums and scaling: finite f32 radii can have a sum
    // outside f32 range, or need a factor smaller than a representable f32.
    let mut scale = 1.0f64;
    for (extent, first, second) in [
        (bounds.width, radii[0].x, radii[1].x),
        (bounds.width, radii[3].x, radii[2].x),
        (bounds.height, radii[0].y, radii[3].y),
        (bounds.height, radii[1].y, radii[2].y),
    ] {
        let sum = f64::from(first) + f64::from(second);
        if sum > 0.0 {
            scale = scale.min(f64::from(extent.max(0.0)) / sum);
        }
    }
    scale = scale.clamp(0.0, 1.0);
    for radius in &mut radii {
        radius.x = (f64::from(radius.x) * scale) as f32;
        radius.y = (f64::from(radius.y) * scale) as f32;
    }
    radii
}

fn rounded_rect_contains(bounds: Rect, x: f32, y: f32, radii: [CornerRadius; 4]) -> bool {
    if !bounds.contains(x, y) {
        return false;
    }
    let radii = normalized_corner_radii(bounds, radii);
    if radii
        .iter()
        .all(|radius| radius.x <= 0.0 || radius.y <= 0.0)
    {
        return true;
    }
    let left = bounds.x;
    let top = bounds.y;
    let right = bounds.x + bounds.width;
    let bottom = bounds.y + bounds.height;
    // Inspect the relevant corner before accepting an interior point. A
    // middle strip derived from top-left radii is not valid for asymmetric
    // corners (for example a square top-left and rounded top-right).
    let (radius, center_x, center_y) = if x < left + radii[0].x && y < top + radii[0].y {
        (radii[0], left + radii[0].x, top + radii[0].y)
    } else if x >= right - radii[1].x && y < top + radii[1].y {
        (radii[1], right - radii[1].x, top + radii[1].y)
    } else if x >= right - radii[2].x && y >= bottom - radii[2].y {
        (radii[2], right - radii[2].x, bottom - radii[2].y)
    } else if x < left + radii[3].x && y >= bottom - radii[3].y {
        (radii[3], left + radii[3].x, bottom - radii[3].y)
    } else {
        return true;
    };
    if radius.x <= 0.0 || radius.y <= 0.0 {
        return true;
    }
    let dx = (x - center_x) / radius.x;
    let dy = (y - center_y) / radius.y;
    dx * dx + dy * dy <= 1.0
}

struct RenderSelectorTree<'a> {
    root: &'a RenderNode,
}

impl<'a> SelectorTree for RenderSelectorTree<'a> {
    type Node = &'a RenderNode;

    fn root(&self) -> Self::Node {
        self.root
    }

    fn metadata(&self, node: Self::Node) -> SelectorNodeRef<'_> {
        SelectorNodeRef {
            tag: node.tag.as_deref(),
            id: Some(&node.id),
            classes: &node.classes,
            attributes: &node.attributes,
            owner_scope: node.event_owner_scope_id.as_deref(),
            component_scope: node.component_scope_id.as_deref(),
        }
    }

    fn child(&self, node: Self::Node, index: usize) -> Option<Self::Node> {
        node.children.get(index)
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RenderFrame {
    pub frame_id: u64,
    pub viewport: Rect,
    pub root: RenderNode,
    /// One decoded resource per id, shared by all references and frame clones.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub images: BTreeMap<String, Arc<ImageResource>>,
}

// The paint plan is derived from the accepted tree, never trusted from an
// incoming frame. Keeping it on the wire binds every presenter to the same
// phases without duplicating CSS context sorting in JavaScript.
impl Serialize for RenderFrame {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.serialize_frame(serializer, true)
    }
}

impl RenderFrame {
    /// Frame metadata with byte ranges into a separate tightly packed image lane.
    /// Pixel bytes never become JSON numbers or per-byte JavaScript properties.
    pub fn binary_metadata_json(&self) -> Result<Vec<u8>, serde_json::Error> {
        struct Metadata<'a>(&'a RenderFrame);
        impl Serialize for Metadata<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                self.0.serialize_frame(serializer, false)
            }
        }
        serde_json::to_vec(&Metadata(self))
    }

    fn serialize_frame<S: serde::Serializer>(
        &self,
        serializer: S,
        pixels: bool,
    ) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap, SerializeStruct};
        struct ImageRanges<'a>(&'a BTreeMap<String, Arc<ImageResource>>);
        impl Serialize for ImageRanges<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                let mut map = serializer.serialize_map(Some(self.0.len()))?;
                let mut offset = 0usize;
                for (id, image) in self.0 {
                    #[derive(Serialize)]
                    struct Range {
                        width: u32,
                        height: u32,
                        offset: usize,
                        length: usize,
                    }
                    map.serialize_entry(
                        id,
                        &Range {
                            width: image.width,
                            height: image.height,
                            offset,
                            length: image.pixels.len(),
                        },
                    )?;
                    offset += image.pixels.len();
                }
                map.end()
            }
        }
        paint::validate_budget(&self.root).map_err(serde::ser::Error::custom)?;
        paint::validate_mode(&self.root).map_err(serde::ser::Error::custom)?;
        let css = self.root.style.is_some_and(|style| style.flow.is_some());
        let fields = 3 + usize::from(!self.images.is_empty()) + usize::from(css);
        let mut frame = serializer.serialize_struct("RenderFrame", fields)?;
        frame.serialize_field("frame_id", &self.frame_id)?;
        frame.serialize_field("viewport", &self.viewport)?;
        frame.serialize_field("root", &self.root)?;
        if !self.images.is_empty() {
            if pixels {
                frame.serialize_field("images", &self.images)?;
            } else {
                frame.serialize_field("images", &ImageRanges(&self.images))?;
            }
        }
        if css {
            frame.serialize_field(
                "paintPlan",
                &paint::PaintPlan::new_validated(&self.root).wire(),
            )?;
        }
        frame.end()
    }
}

/// A node's geometry in the committed frame's viewport coordinate space.
///
/// Entries borrow the frame and retain document order. The parent index lets
/// consumers choose their own ancestor clipping rules without repeating the
/// transform walk. `displayed` accounts for inherited `display: none`, while
/// transparent nodes still have layout geometry.
#[derive(Debug, Clone, Copy)]
pub struct RenderNodeGeometry<'a> {
    pub node: &'a RenderNode,
    pub bounds: Rect,
    /// Paint-space matrix, including ancestor scroll translations but excluding
    /// this node's descendant scroll translation. Also resolves input vectors.
    pub world_transform: Transform2D,
    pub parent: Option<usize>,
    pub displayed: bool,
}

/// Exact paint-space clipping metadata for an embedded native component.
/// The host must apply the axis/radius mask in this local coordinate space.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeComponentClip {
    pub bounds: Rect,
    pub transform: Transform2D,
    pub radii: [CornerRadius; 4],
    pub clip_x: bool,
    pub clip_y: bool,
}

#[derive(Debug)]
pub struct NativeComponentPresentation<'a> {
    pub node: &'a RenderNode,
    pub world_bounds: Rect,
    pub transform: Transform2D,
    pub clips: Vec<NativeComponentClip>,
    pub paint_order: usize,
    pub opacity: f32,
    pub visible: bool,
}

/// A host-consumable image produced by the last committed frame.
///
/// Pixels are tightly packed, premultiplied RGBA8 in row-major order.  The
/// snapshot is deliberately independent of a platform surface handle so the
/// same batch can be consumed by CanvasKit, a desktop window, or a mobile
/// surface bridge without crossing the FFI boundary per node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderSnapshot {
    pub frame_id: u64,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub format: String,
    pub pixels: Vec<u8>,
}

/// Physical page raster target, independent from logical layout and device DPR.
/// The development presenter keeps one RGBA frame within a 16 MiB budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderTargetSize {
    pub width: u32,
    pub height: u32,
}

impl RenderTargetSize {
    pub const MAX_SIDE: u32 = 4096;
    pub const MAX_BYTES: usize = 16 * 1024 * 1024;

    pub fn for_viewport(viewport: Rect, scale: f64) -> Result<Self, RenderError> {
        viewport_surface_layout(viewport, i32::MAX as u32)?;
        if !scale.is_finite() || scale <= 0.0 {
            return Err(RenderError::InvalidRenderTarget);
        }
        let width = (f64::from(viewport.width) * scale).ceil();
        let height = (f64::from(viewport.height) * scale).ceil();
        if width > f64::from(Self::MAX_SIDE) || height > f64::from(Self::MAX_SIDE) {
            return Err(RenderError::RenderTargetBudgetExceeded);
        }
        let target = Self {
            width: width as u32,
            height: height as u32,
        };
        let (_, bytes) = rgba_buffer_layout(target.width, target.height)?;
        if bytes > Self::MAX_BYTES {
            return Err(RenderError::RenderTargetBudgetExceeded);
        }
        Ok(target)
    }
}

/// One batched `CanvasRenderingContext2D` submission.
///
/// A canvas draw is deliberately kept separate from the page `RenderFrame`:
/// canvas has its own persistent bitmap and the `reserve` flag controls
/// whether the previous command history is retained.  Hosts consume the
/// resulting [`RenderSnapshot`] through the same RGBA8 handoff used by page
/// frames, so no FFI boundary is crossed per canvas command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanvasFrame {
    pub frame_id: u64,
    pub canvas_id: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub reserve: bool,
    pub commands: Vec<CanvasCommand>,
}

/// JSON representation of one 2D command emitted by the JS facade.  Keeping
/// arguments as JSON preserves the bridge wire format while the renderer
/// validates numeric arity and finite values before replaying the command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanvasCommand {
    pub op: String,
    #[serde(default)]
    pub args: Vec<Value>,
}

const DEFAULT_CANVAS_WIDTH: u32 = 300;
const DEFAULT_CANVAS_HEIGHT: u32 = 150;

impl CanvasFrame {
    /// Decode the payload produced by `wx.canvas.draw`.  Width and height are
    /// optional in the bridge because a WXML canvas normally obtains them from
    /// layout; callers pass the dimensions of an existing surface as the
    /// fallback.  A fresh canvas follows the HTML/微信 default of 300x150.
    pub fn from_payload(
        payload: &Map<String, Value>,
        frame_id: u64,
        fallback_size: Option<(u32, u32)>,
    ) -> Result<Self, RenderError> {
        let canvas_id = payload
            .get("canvasId")
            .or_else(|| payload.get("canvas_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| RenderError::InvalidCanvas("canvasId is required".into()))?
            .to_owned();
        let (fallback_width, fallback_height) =
            fallback_size.unwrap_or((DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT));
        let width = canvas_dimension(payload, "width", "canvasWidth", fallback_width)?;
        let height = canvas_dimension(payload, "height", "canvasHeight", fallback_height)?;
        let commands = payload
            .get("commands")
            .and_then(Value::as_array)
            .ok_or_else(|| RenderError::InvalidCanvas("commands must be an array".into()))?
            .iter()
            .map(CanvasCommand::from_value)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self {
            frame_id,
            canvas_id,
            width,
            height,
            reserve: payload
                .get("reserve")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            commands,
        })
    }
}

impl CanvasCommand {
    pub fn from_value(value: &Value) -> Result<Self, RenderError> {
        let object = value
            .as_object()
            .ok_or_else(|| RenderError::InvalidCanvas("canvas command must be an object".into()))?;
        let op = object
            .get("op")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| RenderError::InvalidCanvas("canvas command requires op".into()))?
            .to_owned();
        let args = object
            .get("args")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                RenderError::InvalidCanvas(format!("canvas command {op} requires args"))
            })?
            .clone();
        if !canvas_command_is_known(&op) {
            return Err(RenderError::UnsupportedCanvasCommand(op));
        }
        if !canvas_command_is_supported(&op) {
            return Err(RenderError::UnsupportedCanvasCommand(op));
        }
        Ok(Self { op, args })
    }
}

/// Commands accepted by the JS facade.  This is intentionally shared by the
/// renderer and host/provider validation so a newly added command cannot be
/// reported as successful before it has a replay implementation.
pub fn canvas_command_is_known(op: &str) -> bool {
    matches!(
        op,
        "setFillStyle"
            | "setStrokeStyle"
            | "setLineWidth"
            | "setGlobalAlpha"
            | "setFontSize"
            | "setLineDash"
            | "setLineCap"
            | "setLineJoin"
            | "setMiterLimit"
            | "setShadow"
            | "setTextAlign"
            | "setTextBaseline"
            | "fillRect"
            | "strokeRect"
            | "clearRect"
            | "beginPath"
            | "closePath"
            | "moveTo"
            | "lineTo"
            | "arc"
            | "arcTo"
            | "rect"
            | "fill"
            | "stroke"
            | "fillText"
            | "strokeText"
            | "drawImage"
            | "save"
            | "restore"
            | "translate"
            | "rotate"
            | "scale"
            | "setTransform"
            | "transform"
            | "clip"
            | "quadraticCurveTo"
            | "bezierCurveTo"
    )
}

/// Commands for which the portable software replay has deterministic
/// semantics.  Known-but-unimplemented commands remain in the protocol list so
/// the JS facade can preserve the command stream, but submission fails
/// explicitly instead of silently dropping pixels.
pub fn canvas_command_is_supported(op: &str) -> bool {
    matches!(
        op,
        "setFillStyle"
            | "setStrokeStyle"
            | "setLineWidth"
            | "setGlobalAlpha"
            | "setFontSize"
            | "setLineDash"
            | "setLineCap"
            | "setLineJoin"
            | "setMiterLimit"
            | "setTextAlign"
            | "setTextBaseline"
            | "fillRect"
            | "strokeRect"
            | "clearRect"
            | "beginPath"
            | "closePath"
            | "moveTo"
            | "lineTo"
            | "arc"
            | "arcTo"
            | "rect"
            | "fill"
            | "stroke"
            | "fillText"
            | "strokeText"
            | "save"
            | "restore"
            | "translate"
            | "rotate"
            | "scale"
            | "setTransform"
            | "transform"
            | "clip"
            | "quadraticCurveTo"
            | "bezierCurveTo"
    )
}

fn canvas_dimension(
    payload: &Map<String, Value>,
    key: &str,
    alias: &str,
    fallback: u32,
) -> Result<u32, RenderError> {
    let value = payload.get(key).or_else(|| payload.get(alias));
    let Some(value) = value else {
        return Ok(fallback);
    };
    let value = value.as_f64().ok_or_else(|| {
        RenderError::InvalidCanvas(format!("canvas {key} must be a finite number"))
    })?;
    if !value.is_finite() || value < 0.0 || value > f64::from(u32::MAX) {
        return Err(RenderError::InvalidCanvas(format!(
            "canvas {key} must be between 0 and {}",
            u32::MAX
        )));
    }
    Ok(value.ceil() as u32)
}

impl RenderFrame {
    /// Project native-layer metadata from the accepted paint plan. This shares
    /// clipping and stacking with rasterization rather than approximating them
    /// through an independent host traversal of CSS fields.
    pub fn native_component_presentations(&self) -> Vec<NativeComponentPresentation<'_>> {
        let plan = paint::PaintPlan::new(&self.root);
        let mut order = vec![0; plan.nodes.len()];
        for (position, command) in plan.commands.iter().enumerate() {
            if command.op == paint::Op::Content {
                order[command.node] = position;
            }
        }
        plan.nodes
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                let node = entry.node;
                if !matches!(
                    node.tag.as_deref(),
                    Some("camera" | "video" | "audio" | "map" | "live-player" | "live-pusher")
                ) && !(node.tag.as_deref() == Some("button")
                    && node.attributes.get("open-type").map(String::as_str)
                        == Some("getPhoneNumber"))
                {
                    return None;
                }
                let corners = [
                    (node.bounds.x, node.bounds.y),
                    (node.bounds.x + node.bounds.width, node.bounds.y),
                    (node.bounds.x, node.bounds.y + node.bounds.height),
                    (
                        node.bounds.x + node.bounds.width,
                        node.bounds.y + node.bounds.height,
                    ),
                ]
                .map(|point| entry.transform.apply(point));
                let left = corners
                    .iter()
                    .map(|point| point.0)
                    .fold(f32::INFINITY, f32::min);
                let top = corners
                    .iter()
                    .map(|point| point.1)
                    .fold(f32::INFINITY, f32::min);
                let right = corners
                    .iter()
                    .map(|point| point.0)
                    .fold(f32::NEG_INFINITY, f32::max);
                let bottom = corners
                    .iter()
                    .map(|point| point.1)
                    .fold(f32::NEG_INFINITY, f32::max);
                let mut opacity = node.opacity;
                let mut parent = entry.parent;
                while let Some(index) = parent {
                    opacity *= plan.nodes[index].node.opacity;
                    parent = plan.nodes[index].parent;
                }
                let mut clips = vec![NativeComponentClip {
                    bounds: self.viewport,
                    transform: Transform2D::IDENTITY,
                    radii: [CornerRadius::ZERO; 4],
                    clip_x: true,
                    clip_y: true,
                }];
                clips.extend(plan.clips(index).map(|world| NativeComponentClip {
                    bounds: world.clip.bounds,
                    transform: world.transform,
                    radii: world.clip.radii,
                    clip_x: world.clip.clip_x,
                    clip_y: world.clip.clip_y,
                }));
                Some(NativeComponentPresentation {
                    node,
                    world_bounds: Rect {
                        x: left,
                        y: top,
                        width: right - left,
                        height: bottom - top,
                    },
                    transform: entry.transform,
                    clips,
                    paint_order: order[index],
                    opacity,
                    visible: entry.displayed
                        && entry.paint_active
                        && opacity > 0.0
                        && node.visibility == Visibility::Visible,
                })
            })
            .collect()
    }

    /// Capture every node's world-space axis-aligned bounding rectangle in one
    /// preorder walk, using the same transform origins and matrix composition
    /// as painting and hit testing. Rectangles are intentionally not clipped
    /// against the viewport or ancestors: non-native intersection observers
    /// can use direct rectangle intersections, while native observers may
    /// follow `parent` to apply their ancestor rules. Explicit scroll containers
    /// translate descendants using the same fixed viewport as paint and hits.
    pub fn node_geometries(&self) -> Vec<RenderNodeGeometry<'_>> {
        let typed_layout = self.root.style.is_some_and(|style| style.flow.is_some());
        paint::PaintPlan::spatial(&self.root)
            .nodes
            .into_iter()
            .map(|entry| {
                let node = entry.node;
                let transform = entry.transform;
                let displayed = entry.displayed;
                let corners = [
                    (node.bounds.x, node.bounds.y),
                    (node.bounds.x + node.bounds.width, node.bounds.y),
                    (node.bounds.x, node.bounds.y + node.bounds.height),
                    (
                        node.bounds.x + node.bounds.width,
                        node.bounds.y + node.bounds.height,
                    ),
                ]
                .map(|point| transform.apply(point));
                let left = corners
                    .iter()
                    .map(|point| point.0)
                    .fold(f32::INFINITY, f32::min);
                let right = corners
                    .iter()
                    .map(|point| point.0)
                    .fold(f32::NEG_INFINITY, f32::max);
                let top = corners
                    .iter()
                    .map(|point| point.1)
                    .fold(f32::INFINITY, f32::min);
                let bottom = corners
                    .iter()
                    .map(|point| point.1)
                    .fold(f32::NEG_INFINITY, f32::max);
                RenderNodeGeometry {
                    node,
                    bounds: if typed_layout && !displayed {
                        Rect {
                            x: 0.0,
                            y: 0.0,
                            width: 0.0,
                            height: 0.0,
                        }
                    } else {
                        Rect {
                            x: left,
                            y: top,
                            width: right - left,
                            height: bottom - top,
                        }
                    },
                    world_transform: transform,
                    parent: entry.parent,
                    displayed,
                }
            })
            .collect()
    }

    /// Query the committed frame in tree order. `all = false` returns at most
    /// one node, matching `SelectorQuery.select`; `all = true` mirrors
    /// `selectAll`.  Geometry is read from the same frame submitted to the
    /// renderer, so the result cannot observe a half-applied view update.
    pub fn query<'a>(
        &'a self,
        selector: &str,
        all: bool,
    ) -> Result<Vec<&'a RenderNode>, SelectorError> {
        self.query_scoped(selector, all, None)
    }

    /// Query a concrete component host scope (or a legacy synthetic
    /// `data-sim-scope` root). Managed scopes respect declaration ownership,
    /// including slot content and nested component boundaries.
    pub fn query_scoped<'a>(
        &'a self,
        selector: &str,
        all: bool,
        scope_id: Option<&str>,
    ) -> Result<Vec<&'a RenderNode>, SelectorError> {
        let selector = CompiledSelectorList::parse(selector)?;
        Ok(query_selector(
            &RenderSelectorTree { root: &self.root },
            &selector,
            all,
            scope_id,
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderError {
    InvalidViewport,
    InvalidRenderTarget,
    RenderTargetBudgetExceeded,
    InvalidTransform,
    InvalidOpacity,
    InvalidBorder,
    InvalidScrollOffset,
    InvalidTextStyle,
    InvalidTextLayout,
    InvalidFlowStyle,
    FlowLayout(String),
    TextBudgetExceeded,
    PaintBudgetExceeded,
    CompositingBudgetExceeded,
    PixelBufferOverflow,
    PixelBufferAllocationFailed,
    InvalidFont(String),
    InvalidCanvas(String),
    InvalidImage(String),
    UnsupportedCanvasCommand(String),
    Unsupported(&'static str),
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidViewport => {
                f.write_str("viewport coordinates must be finite and dimensions must be non-negative and within renderer limits")
            }
            Self::InvalidRenderTarget => f.write_str("render scale must be finite and positive"),
            Self::RenderTargetBudgetExceeded => f.write_str("render target exceeds 4096 pixels per side or 16 MiB RGBA budget"),
            Self::InvalidTransform => f.write_str("transform, origin, accumulated matrix and transformed geometry must remain finite"),
            Self::InvalidOpacity => f.write_str("node opacity must be finite and between 0 and 1"),
            Self::InvalidBorder => f.write_str("border widths must be finite and non-negative"),
            Self::InvalidScrollOffset => {
                f.write_str("scroll offsets must be finite and non-negative")
            }
            Self::InvalidTextStyle => f.write_str("text size and line height must be finite and non-negative"),
            Self::InvalidTextLayout => f.write_str("text layout must contain finite positions matching the source text"),
            Self::InvalidFlowStyle => f.write_str("flow lengths and flex factors must be finite and valid for their properties"),
            Self::FlowLayout(message) => write!(f, "flow layout failed: {message}"),
            Self::TextBudgetExceeded => f.write_str("frame text source and glyph plan budgets must not exceed 1000000 characters"),
            Self::PaintBudgetExceeded => f.write_str("frame paint tree exceeds 100000 nodes, depth 256 or 1000000 path entries"),
            Self::CompositingBudgetExceeded => f.write_str("opacity groups exceed the 64 MiB additional RGBA layer budget or 32 nested layers"),
            Self::PixelBufferOverflow => {
                f.write_str("render surface is too large for an RGBA8 buffer")
            }
            Self::PixelBufferAllocationFailed => {
                f.write_str("failed to allocate an RGBA8 pixel buffer")
            }
            Self::InvalidFont(message) => write!(f, "invalid native font: {message}"),
            Self::InvalidCanvas(message) => write!(f, "invalid canvas submission: {message}"),
            Self::InvalidImage(message) => write!(f, "invalid image resource: {message}"),
            Self::UnsupportedCanvasCommand(op) => {
                write!(
                    f,
                    "canvas command is not implemented by this renderer: {op}"
                )
            }
            Self::Unsupported(name) => write!(f, "renderer capability is not available: {name}"),
        }
    }
}

impl std::error::Error for RenderError {}

#[derive(Clone, Copy)]
struct SurfaceLayout {
    width: u32,
    height: u32,
    bytes: usize,
}

/// Check the representation required by both RGBA snapshots and their Vec.
/// This is an integer capacity check, not a host memory budget.
fn rgba_buffer_layout(width: u32, height: u32) -> Result<(u32, usize), RenderError> {
    let stride = width
        .checked_mul(4)
        .ok_or(RenderError::PixelBufferOverflow)?;
    let bytes = usize::try_from(stride)
        .ok()
        .and_then(|row| usize::try_from(height).ok()?.checked_mul(row))
        .filter(|bytes| *bytes <= isize::MAX as usize)
        .ok_or(RenderError::PixelBufferOverflow)?;
    Ok((stride, bytes))
}

fn viewport_surface_layout(
    viewport: Rect,
    max_dimension: u32,
) -> Result<SurfaceLayout, RenderError> {
    if !viewport.x.is_finite()
        || !viewport.y.is_finite()
        || !viewport.width.is_finite()
        || !viewport.height.is_finite()
        || viewport.width < 0.0
        || viewport.height < 0.0
    {
        return Err(RenderError::InvalidViewport);
    }
    // i32::MAX/u32::MAX round upward when converted to f32. Compare in f64
    // before any integer cast so that boundary cannot silently saturate.
    let width = f64::from(viewport.width).ceil();
    let height = f64::from(viewport.height).ceil();
    if width > f64::from(max_dimension) || height > f64::from(max_dimension) {
        return Err(RenderError::InvalidViewport);
    }
    let width = width as u32;
    let height = height as u32;
    let (_, bytes) = rgba_buffer_layout(width, height)?;
    Ok(SurfaceLayout {
        width,
        height,
        bytes,
    })
}

/// Batch renderer contract. Hosts submit one frame tree per commit.
pub trait Renderer {
    fn backend_name(&self) -> &'static str;
    fn commit(&mut self, frame: RenderFrame) -> Result<(), RenderError>;
    fn last_frame(&self) -> Option<&RenderFrame>;

    /// Return whether the renderer is backed by a host-owned GPU surface.
    ///
    /// A Skia raster surface is still useful for deterministic offscreen
    /// tests, but it executes on the CPU.  Keeping this bit separate from
    /// [`Self::backend_name`] prevents a raster readback from being reported
    /// as a GPU/device pass by host smoke tests.
    fn has_gpu_surface(&self) -> bool {
        false
    }
}

/// Deterministic renderer used by headless tests and as the fallback path.
#[derive(Debug, Default)]
pub struct SoftwareRenderer {
    last_frame: Option<RenderFrame>,
    last_snapshot: Option<RenderSnapshot>,
    /// Presentation identity, independent from application render frameId.
    snapshot_revision: u64,
}

#[derive(Clone, Copy)]
struct RasterClipBounds {
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
}

impl RasterClipBounds {
    fn intersect_x(&mut self, left: f32, right: f32) {
        // Clips sample pixel centres, matching the point used by curved and
        // transformed geometry. No intermediate alpha mask is allocated.
        self.left = self.left.max((left - 0.5).ceil().max(0.0) as u32);
        self.right = self.right.min((right - 0.5).ceil().max(0.0) as u32);
    }

    fn intersect_y(&mut self, top: f32, bottom: f32) {
        self.top = self.top.max((top - 0.5).ceil().max(0.0) as u32);
        self.bottom = self.bottom.min((bottom - 0.5).ceil().max(0.0) as u32);
    }

    fn intersect_conservative_x(&mut self, left: f32, right: f32) {
        self.left = self.left.max((left - 0.5).ceil().max(0.0) as u32);
        self.right = self
            .right
            .min(((right - 0.5).floor() + 1.0).max(0.0) as u32);
    }

    fn intersect_conservative_y(&mut self, top: f32, bottom: f32) {
        self.top = self.top.max((top - 0.5).ceil().max(0.0) as u32);
        self.bottom = self
            .bottom
            .min(((bottom - 0.5).floor() + 1.0).max(0.0) as u32);
    }
}

struct RasterClipShape {
    clip: OverflowClip,
    inverse: Transform2D,
}

struct RasterClipState {
    bounds: RasterClipBounds,
    shapes: Vec<RasterClipShape>,
}

impl RasterClipState {
    fn new(width: u32, height: u32) -> Self {
        Self {
            bounds: RasterClipBounds {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            },
            shapes: Vec::new(),
        }
    }

    fn contains(&self, x: u32, y: u32) -> bool {
        self.shapes.iter().all(|shape| {
            let (x, y) = shape.inverse.apply((x as f32 + 0.5, y as f32 + 0.5));
            shape.clip.contains(x, y)
        })
    }

    fn push(&mut self, clip: OverflowClip, transform: Transform2D) {
        let Some(inverse) = transform.inverse() else {
            self.bounds.right = self.bounds.left;
            return;
        };
        let bounds = clip.bounds;
        if (clip.clip_x
            && (!bounds.x.is_finite() || !bounds.width.is_finite() || bounds.width <= 0.0))
            || (clip.clip_y
                && (!bounds.y.is_finite() || !bounds.height.is_finite() || bounds.height <= 0.0))
        {
            self.bounds.right = self.bounds.left;
            return;
        }
        let axis_aligned = transform.b == 0.0 && transform.c == 0.0;
        let reflected_axis =
            (clip.clip_x && transform.a < 0.0) || (clip.clip_y && transform.d < 0.0);
        if axis_aligned {
            if clip.clip_x {
                let left = bounds.x * transform.a + transform.e;
                let right = (bounds.x + bounds.width) * transform.a + transform.e;
                if transform.a < 0.0 {
                    // Reflection maps local [left, right) to world
                    // (left, right]. Keep both endpoints in this conservative
                    // scissor; inverse containment resolves their ownership.
                    self.bounds
                        .intersect_conservative_x(left.min(right), left.max(right));
                } else {
                    self.bounds.intersect_x(left, right);
                }
            }
            if clip.clip_y {
                let top = bounds.y * transform.d + transform.f;
                let bottom = (bounds.y + bounds.height) * transform.d + transform.f;
                if transform.d < 0.0 {
                    self.bounds
                        .intersect_conservative_y(top.min(bottom), top.max(bottom));
                } else {
                    self.bounds.intersect_y(top, bottom);
                }
            }
        } else if clip.clip_x && clip.clip_y {
            let corners = [
                transform.apply((bounds.x, bounds.y)),
                transform.apply((bounds.x + bounds.width, bounds.y)),
                transform.apply((bounds.x, bounds.y + bounds.height)),
                transform.apply((bounds.x + bounds.width, bounds.y + bounds.height)),
            ];
            let min_x = corners
                .iter()
                .map(|point| point.0)
                .fold(f32::INFINITY, f32::min);
            let max_x = corners
                .iter()
                .map(|point| point.0)
                .fold(f32::NEG_INFINITY, f32::max);
            let min_y = corners
                .iter()
                .map(|point| point.1)
                .fold(f32::INFINITY, f32::min);
            let max_y = corners
                .iter()
                .map(|point| point.1)
                .fold(f32::NEG_INFINITY, f32::max);
            // An AABB is only a conservative scan bound, not the clip's
            // half-open ownership rule. Its maximum may come from an
            // inclusive local edge (for example after a 90 degree rotation).
            // Keep both extrema until inverse containment tests the shape.
            self.bounds.intersect_conservative_x(min_x, max_x);
            self.bounds.intersect_conservative_y(min_y, max_y);
        }
        // Positive axis-aligned rectangles collapse into one scissor. Curves,
        // reflected endpoints and rotated/sheared stripes retain the same
        // inverse-space containment rule as hit testing.
        if !axis_aligned
            || reflected_axis
            || (clip.clip_x && clip.clip_y && !is_zero_corner_radii(&clip.radii))
        {
            self.shapes.push(RasterClipShape { clip, inverse });
        }
    }
}

impl SoftwareRenderer {
    pub fn new() -> Self {
        Self::default()
    }

    fn validate_node(node: &RenderNode) -> Result<(), RenderError> {
        validate_text_budget(node)?;
        validate_containing_blocks(node)?;
        Self::validate_node_contents(node)?;
        transforms::validate(node)
    }

    fn validate_node_contents(node: &RenderNode) -> Result<(), RenderError> {
        node.validate_anonymous_flex_order()?;
        if let Some(flow) = node.style.and_then(|style| style.flow) {
            flow.validate()?;
        }
        if !node.opacity.is_finite() || !(0.0..=1.0).contains(&node.opacity) {
            return Err(RenderError::InvalidOpacity);
        }
        if let Some(style) = node.text_style {
            style.validate()?;
            if style.flow.is_some() && node.text.is_some() && node.text_layout.is_none() {
                return Err(RenderError::InvalidTextLayout);
            }
        }
        if let Some(layout) = &node.text_layout {
            if node.text_style.is_none() {
                return Err(RenderError::InvalidTextLayout);
            }
            layout.validate_with_style(
                node.text.as_deref().ok_or(RenderError::InvalidTextLayout)?,
                node.text_style.ok_or(RenderError::InvalidTextLayout)?,
            )?;
            let content = node.style.unwrap_or_default().content_box(node.bounds);
            // A leaf's line formatting width is its allocated content width.
            // Text plus children uses a private solver text box and records
            // that box's finite width and origin in the flow plan instead.
            if let Some(flow) = &layout.flow {
                if node.children.is_empty()
                    && (flow.available_width != Some(content.width)
                        || flow.offset_x != 0.0
                        || flow.offset_y != 0.0)
                {
                    return Err(RenderError::InvalidTextLayout);
                }
            }
            if layout.glyphs.iter().any(|glyph| {
                !(content.x + glyph.x).is_finite() || !(content.y + glyph.baseline_y).is_finite()
            }) {
                return Err(RenderError::InvalidTextLayout);
            }
        }
        if let Some(offset) = node.scroll_offset {
            if ![offset.scroll_left, offset.scroll_top]
                .into_iter()
                .all(|value| value.is_finite() && value >= 0.0)
            {
                return Err(RenderError::InvalidScrollOffset);
            }
        }
        for border in node.style.unwrap_or_default().border {
            border.validate()?;
        }
        let insets = node.style.unwrap_or_default().border_insets();
        if !insets.horizontal().is_finite() || !insets.vertical().is_finite() {
            return Err(RenderError::InvalidBorder);
        }
        for child in &node.children {
            Self::validate_node_contents(child)?;
        }
        Ok(())
    }

    /// Rasterize the frame using the same deterministic source-over semantics
    /// used by the software fallback.  This output is also the portable
    /// handoff format for hosts that own the actual window/surface.
    fn rasterize(frame: &RenderFrame) -> Result<RenderSnapshot, RenderError> {
        let SurfaceLayout { width, height, .. } =
            viewport_surface_layout(frame.viewport, u32::MAX)?;
        Self::rasterize_at_size(frame, width, height)
    }

    fn rasterize_at_size(
        frame: &RenderFrame,
        width: u32,
        height: u32,
    ) -> Result<RenderSnapshot, RenderError> {
        if width == 0 || height == 0 {
            return Err(RenderError::InvalidRenderTarget);
        }
        let (stride, bytes) = rgba_buffer_layout(width, height)?;
        let scale_x = width as f32 / frame.viewport.width;
        let scale_y = height as f32 / frame.viewport.height;
        if !scale_x.is_finite() || !scale_y.is_finite() || scale_x <= 0.0 || scale_y <= 0.0 {
            return Err(RenderError::InvalidRenderTarget);
        }
        let device_transform = Transform2D {
            a: scale_x,
            b: 0.0,
            c: 0.0,
            d: scale_y,
            e: 0.0,
            f: 0.0,
        };
        let depth = compositing::layer_depth(&frame.root, bytes)?;
        let mut layers = compositing::LayerPool::new(depth, bytes)?;
        let mut pixels = vec![0; bytes];
        let plan = paint::PaintPlan::new_validated(&frame.root);
        let mut groups = Vec::new();
        for command in &plan.commands {
            let entry = &plan.nodes[command.node];
            match command.op {
                paint::Op::Begin => {
                    let alpha = (entry.paint_active && entry.node.opacity < 1.0)
                        .then(|| compositing::alpha(entry.node.opacity));
                    groups.push(alpha.map(|alpha| {
                        let parent = std::mem::replace(&mut pixels, layers.take());
                        (parent, alpha)
                    }));
                }
                paint::Op::End => {
                    if let Some((mut parent, alpha)) = groups.pop().flatten() {
                        compositing::composite(&mut parent, &pixels, alpha);
                        layers.recycle(std::mem::replace(&mut pixels, parent));
                    }
                }
                phase => {
                    if !entry.paint_active || entry.transform.inverse().is_none() {
                        continue;
                    }
                    let mut clips = RasterClipState::new(width, height);
                    for ancestor in plan.clips(command.node) {
                        clips.push(ancestor.clip, device_transform.multiply(ancestor.transform));
                    }
                    Self::draw_phase(
                        &mut pixels,
                        (width, height),
                        entry.node,
                        &frame.images,
                        device_transform.multiply(entry.transform),
                        &clips,
                        phase,
                    );
                }
            }
        }
        Ok(RenderSnapshot {
            frame_id: frame.frame_id,
            width,
            height,
            stride,
            format: "rgba8-premultiplied".into(),
            pixels,
        })
    }

    fn draw_phase(
        pixels: &mut [u8],
        surface: (u32, u32),
        node: &RenderNode,
        images: &BTreeMap<String, Arc<ImageResource>>,
        transform: Transform2D,
        clips: &RasterClipState,
        phase: paint::Op,
    ) {
        if phase == paint::Op::Background {
            if let Some(color) = node.background {
                Self::draw_transformed_rect(
                    pixels,
                    surface,
                    node.bounds,
                    transform,
                    node.style.unwrap_or_default().border_radius,
                    [color.red, color.green, color.blue, color.alpha],
                    clips,
                );
            }
            Self::draw_border(pixels, surface, node, transform, 1.0, clips);
        } else if let Some(resource) = node
            .image
            .as_ref()
            .and_then(|image| images.get(&image.resource))
        {
            images::draw_software(pixels, surface, node, resource, transform, 1.0, clips);
        }
    }

    fn draw_border(
        pixels: &mut [u8],
        surface: (u32, u32),
        node: &RenderNode,
        transform: Transform2D,
        opacity: f32,
        clips: &RasterClipState,
    ) {
        let style = node.style.unwrap_or_default();
        let geometry = BorderGeometry::new(node.bounds, style);
        if !geometry.has_border() || node.bounds.width <= 0.0 || node.bounds.height <= 0.0 {
            return;
        }
        let Some(inverse) = transform.inverse() else {
            return;
        };
        let corners = [
            transform.apply((node.bounds.x, node.bounds.y)),
            transform.apply((node.bounds.x + node.bounds.width, node.bounds.y)),
            transform.apply((
                node.bounds.x + node.bounds.width,
                node.bounds.y + node.bounds.height,
            )),
            transform.apply((node.bounds.x, node.bounds.y + node.bounds.height)),
        ];
        if corners
            .iter()
            .any(|point| !point.0.is_finite() || !point.1.is_finite())
        {
            return;
        }
        let (width, height) = surface;
        let mut bounds = clips.bounds;
        bounds.intersect_conservative_x(
            corners
                .iter()
                .map(|point| point.0)
                .fold(f32::INFINITY, f32::min),
            corners
                .iter()
                .map(|point| point.0)
                .fold(f32::NEG_INFINITY, f32::max),
        );
        bounds.intersect_conservative_y(
            corners
                .iter()
                .map(|point| point.1)
                .fold(f32::INFINITY, f32::min),
            corners
                .iter()
                .map(|point| point.1)
                .fold(f32::NEG_INFINITY, f32::max),
        );
        for y in bounds.top..bounds.bottom.min(height) {
            for x in bounds.left..bounds.right.min(width) {
                if !clips.contains(x, y) {
                    continue;
                }
                let local = inverse.apply((x as f32 + 0.5, y as f32 + 0.5));
                let Some(side) = geometry.side_at(local.0, local.1) else {
                    continue;
                };
                let color = style.border[side].color;
                let alpha = (f32::from(color.alpha) * opacity).clamp(0.0, 255.0).round() as u8;
                let offset = (y as usize * width as usize + x as usize) * 4;
                blend_pixel(
                    &mut pixels[offset..offset + 4],
                    [color.red, color.green, color.blue, alpha],
                );
            }
        }
    }

    fn draw_transformed_rect(
        pixels: &mut [u8],
        surface: (u32, u32),
        bounds: Rect,
        transform: Transform2D,
        radii: [CornerRadius; 4],
        source: [u8; 4],
        clips: &RasterClipState,
    ) {
        let (width, height) = surface;
        if bounds.width <= 0.0 || bounds.height <= 0.0 || source[3] == 0 {
            return;
        }
        if transform == Transform2D::IDENTITY && is_zero_corner_radii(&radii) {
            // Preserve the inexpensive axis-aligned path used by the common
            // case (most WXML boxes have no transform).
            let left = bounds.x.floor().max(0.0).min(width as f32) as u32;
            let top = bounds.y.floor().max(0.0).min(height as f32) as u32;
            let right = (bounds.x + bounds.width).ceil().max(0.0).min(width as f32) as u32;
            let bottom = (bounds.y + bounds.height)
                .ceil()
                .max(0.0)
                .min(height as f32) as u32;
            for y in top.max(clips.bounds.top)..bottom.min(clips.bounds.bottom) {
                for x in left.max(clips.bounds.left)..right.min(clips.bounds.right) {
                    if !clips.contains(x, y) {
                        continue;
                    }
                    let offset = (y as usize * width as usize + x as usize) * 4;
                    blend_pixel(&mut pixels[offset..offset + 4], source);
                }
            }
            return;
        }
        let corners = [
            transform.apply((bounds.x, bounds.y)),
            transform.apply((bounds.x + bounds.width, bounds.y)),
            transform.apply((bounds.x + bounds.width, bounds.y + bounds.height)),
            transform.apply((bounds.x, bounds.y + bounds.height)),
        ];
        if corners
            .iter()
            .any(|(x, y)| !x.is_finite() || !y.is_finite())
        {
            return;
        }
        let min_x = corners
            .iter()
            .map(|(x, _)| *x)
            .fold(f32::INFINITY, f32::min);
        let max_x = corners
            .iter()
            .map(|(x, _)| *x)
            .fold(f32::NEG_INFINITY, f32::max);
        let min_y = corners
            .iter()
            .map(|(_, y)| *y)
            .fold(f32::INFINITY, f32::min);
        let max_y = corners
            .iter()
            .map(|(_, y)| *y)
            .fold(f32::NEG_INFINITY, f32::max);
        let left = min_x.floor().max(0.0).min(width as f32) as u32;
        let top = min_y.floor().max(0.0).min(height as f32) as u32;
        let right = max_x.ceil().max(0.0).min(width as f32) as u32;
        let bottom = max_y.ceil().max(0.0).min(height as f32) as u32;
        let Some(inverse) = transform.inverse() else {
            return;
        };
        for y in top.max(clips.bounds.top)..bottom.min(clips.bounds.bottom) {
            for x in left.max(clips.bounds.left)..right.min(clips.bounds.right) {
                if !clips.contains(x, y) {
                    continue;
                }
                let local = inverse.apply((x as f32 + 0.5, y as f32 + 0.5));
                if !rounded_rect_contains(bounds, local.0, local.1, radii) {
                    continue;
                }
                let offset = (y as usize * width as usize + x as usize) * 4;
                blend_pixel(&mut pixels[offset..offset + 4], source);
            }
        }
    }

    /// Monotonic identity for accepted page presentations. Scroll replay and
    /// density repaint can retain frameId while changing all visible pixels.
    pub fn snapshot_revision(&self) -> u64 {
        self.snapshot_revision
    }

    pub fn snapshot(&self) -> Option<RenderSnapshot> {
        self.last_snapshot.clone()
    }

    fn commit_frame(
        &mut self,
        frame: RenderFrame,
        capture_snapshot: bool,
    ) -> Result<(), RenderError> {
        let candidate = page_frame::PreparedSoftwarePage::prepare(self, frame, capture_snapshot)?;
        drop(candidate.accept(self));
        Ok(())
    }
}

fn blend_pixel(destination: &mut [u8], source: [u8; 4]) {
    let source_alpha = u32::from(source[3]);
    let inverse = 255 - source_alpha;
    let destination_alpha = u32::from(destination[3]);
    let output_alpha = source_alpha + (destination_alpha * inverse + 127) / 255;
    if output_alpha == 0 {
        destination.fill(0);
        return;
    }
    // Store premultiplied channels.  This avoids a second alpha conversion in
    // CanvasKit/Metal/Vulkan upload paths and keeps blending deterministic.
    for channel in 0..3 {
        let source_channel = u32::from(source[channel]) * source_alpha;
        let destination_channel = u32::from(destination[channel]) * inverse;
        let value = (source_channel + destination_channel + 127) / 255;
        destination[channel] = value.min(255) as u8;
    }
    destination[3] = output_alpha.min(255) as u8;
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct CanvasPoint {
    x: f32,
    y: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct CanvasTransform {
    a: f32,
    b: f32,
    c: f32,
    d: f32,
    e: f32,
    f: f32,
}

impl CanvasTransform {
    const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    fn from_values([a, b, c, d, e, f]: [f32; 6]) -> Self {
        Self { a, b, c, d, e, f }
    }

    fn apply(self, point: CanvasPoint) -> CanvasPoint {
        CanvasPoint {
            x: self.a * point.x + self.c * point.y + self.e,
            y: self.b * point.x + self.d * point.y + self.f,
        }
    }

    fn inverse(self) -> Option<Self> {
        let determinant =
            f64::from(self.a) * f64::from(self.d) - f64::from(self.b) * f64::from(self.c);
        if determinant == 0.0 || !determinant.is_finite() {
            return None;
        }
        let inverse = Self {
            a: (f64::from(self.d) / determinant) as f32,
            b: (-f64::from(self.b) / determinant) as f32,
            c: (-f64::from(self.c) / determinant) as f32,
            d: (f64::from(self.a) / determinant) as f32,
            e: ((f64::from(self.c) * f64::from(self.f) - f64::from(self.d) * f64::from(self.e))
                / determinant) as f32,
            f: ((f64::from(self.b) * f64::from(self.e) - f64::from(self.a) * f64::from(self.f))
                / determinant) as f32,
        };
        [
            inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f,
        ]
        .iter()
        .all(|value| value.is_finite())
        .then_some(inverse)
    }

    #[cfg(feature = "skia-backend")]
    fn native(self) -> skia_safe::Matrix {
        skia_safe::Matrix::new_all(
            self.a, self.c, self.e, self.b, self.d, self.f, 0.0, 0.0, 1.0,
        )
    }

    fn multiply(self, other: Self) -> Self {
        Self {
            a: self.a * other.a + self.c * other.b,
            b: self.b * other.a + self.d * other.b,
            c: self.a * other.c + self.c * other.d,
            d: self.b * other.c + self.d * other.d,
            e: self.a * other.e + self.c * other.f + self.e,
            f: self.b * other.e + self.d * other.f + self.f,
        }
    }
}

#[derive(Debug, Clone)]
struct CanvasSavedState {
    fill: Color,
    stroke: Color,
    global_alpha: f32,
    line_width: f32,
    line_dash: Arc<[f32]>,
    line_dash_offset: f32,
    line_cap: CanvasLineCap,
    line_join: CanvasLineJoin,
    miter_limit: f32,
    font_size: f32,
    text_align: CanvasTextAlign,
    text_baseline: CanvasTextBaseline,
    transform: CanvasTransform,
    clip: Option<Arc<[u64]>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum CanvasTextAlign {
    #[default]
    Start,
    End,
    Left,
    Right,
    Center,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum CanvasTextBaseline {
    #[default]
    Alphabetic,
    Top,
    Hanging,
    Middle,
    Ideographic,
    Bottom,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum CanvasLineCap {
    #[default]
    Butt,
    Round,
    Square,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum CanvasLineJoin {
    #[default]
    Miter,
    Round,
    Bevel,
}

#[derive(Debug, Clone, Default)]
struct CanvasPath {
    subpaths: Vec<Vec<CanvasPoint>>,
    closed: Vec<bool>,
    vertices: usize,
    non_finite: bool,
    too_complex: bool,
}

impl CanvasPath {
    fn current_point(&self) -> Option<CanvasPoint> {
        self.subpaths
            .last()
            .and_then(|points| points.last())
            .copied()
    }

    fn current_mut(&mut self) -> &mut Vec<CanvasPoint> {
        if self.subpaths.is_empty() {
            self.subpaths.push(Vec::new());
            self.closed.push(false);
        }
        self.subpaths.last_mut().expect("subpath was inserted")
    }

    fn move_to(&mut self, point: CanvasPoint) {
        self.vertices += 1;
        self.non_finite |= !point.x.is_finite() || !point.y.is_finite();
        self.subpaths.push(vec![point]);
        self.closed.push(false);
    }

    fn line_to(&mut self, point: CanvasPoint) {
        if self.closed.last() == Some(&true) {
            let start = self
                .subpaths
                .last()
                .and_then(|points| points.first())
                .copied();
            if let Some(start) = start {
                self.move_to(start);
            }
        }
        self.vertices += 1;
        self.non_finite |= !point.x.is_finite() || !point.y.is_finite();
        self.current_mut().push(point);
    }

    fn close(&mut self) {
        if let Some(subpath) = self.subpaths.last_mut() {
            if !subpath.is_empty() {
                if subpath.len() > 1 && subpath.first() != subpath.last() {
                    subpath.push(subpath[0]);
                    self.vertices += 1;
                }
                *self.closed.last_mut().expect("subpath has closed marker") = true;
            }
        }
    }

    fn curve_to(&mut self, controls: &[CanvasPoint]) {
        if controls
            .iter()
            .any(|point| !point.x.is_finite() || !point.y.is_finite())
        {
            self.non_finite = true;
            return;
        }
        fn midpoint(a: CanvasPoint, b: CanvasPoint) -> CanvasPoint {
            CanvasPoint {
                x: (f64::from(a.x) * 0.5 + f64::from(b.x) * 0.5) as f32,
                y: (f64::from(a.y) * 0.5 + f64::from(b.y) * 0.5) as f32,
            }
        }
        fn distance(point: CanvasPoint, start: CanvasPoint, end: CanvasPoint) -> f64 {
            let (dx, dy) = (
                f64::from(end.x) - f64::from(start.x),
                f64::from(end.y) - f64::from(start.y),
            );
            let (px, py) = (
                f64::from(point.x) - f64::from(start.x),
                f64::from(point.y) - f64::from(start.y),
            );
            let length = dx * dx + dy * dy;
            let t = if length == 0.0 {
                0.0
            } else {
                ((px * dx + py * dy) / length).clamp(0.0, 1.0)
            };
            (px - t * dx).hypot(py - t * dy)
        }
        fn flatten(path: &mut CanvasPath, points: &[CanvasPoint], depth: u8) {
            let end = *points.last().expect("curve endpoint");
            if path.too_complex {
                return;
            }
            if points[1..points.len() - 1]
                .iter()
                .all(|point| distance(*point, points[0], end) <= 0.0625)
            {
                path.line_to(end);
                return;
            }
            if depth == 12 {
                path.too_complex = true;
                return;
            }
            let mut work = points.to_vec();
            let mut left = vec![work[0]];
            let mut right = vec![end];
            for size in (1..points.len()).rev() {
                for index in 0..size {
                    work[index] = midpoint(work[index], work[index + 1]);
                }
                left.push(work[0]);
                right.push(work[size - 1]);
            }
            right.reverse();
            flatten(path, &left, depth + 1);
            flatten(path, &right, depth + 1);
        }
        let Some(first) = controls.first().copied() else {
            return;
        };
        if self.current_mut().is_empty() {
            self.move_to(first);
        }
        let start = *self.current_mut().last().expect("curve starts a contour");
        let mut points = vec![start];
        points.extend_from_slice(controls);
        flatten(self, &points, 0);
    }

    #[cfg(any(not(feature = "skia-backend"), test))]
    fn stroke(&self, pixels: &mut [u8], width: u32, height: u32, state: &CanvasRasterState) {
        canvas_stroke::draw(
            pixels,
            width,
            height,
            self,
            state.transform,
            state.clip.as_deref(),
            canvas_stroke::StrokeStyle {
                color: state.color(state.stroke),
                width: state.line_width,
                cap: state.line_cap,
                join: state.line_join,
                miter_limit: state.miter_limit,
                dash: &state.line_dash,
                dash_offset: state.line_dash_offset,
            },
        );
    }
}

#[derive(Debug, Clone)]
struct CanvasRasterState {
    fill: Color,
    stroke: Color,
    global_alpha: f32,
    line_width: f32,
    line_dash: Arc<[f32]>,
    line_dash_offset: f32,
    line_cap: CanvasLineCap,
    line_join: CanvasLineJoin,
    miter_limit: f32,
    font_size: f32,
    text_align: CanvasTextAlign,
    text_baseline: CanvasTextBaseline,
    transform: CanvasTransform,
    clip: Option<Arc<[u64]>>,
    stack: Vec<CanvasSavedState>,
    path: CanvasPath,
}

impl Default for CanvasRasterState {
    fn default() -> Self {
        Self {
            fill: Color {
                red: 0,
                green: 0,
                blue: 0,
                alpha: 255,
            },
            stroke: Color {
                red: 0,
                green: 0,
                blue: 0,
                alpha: 255,
            },
            global_alpha: 1.0,
            line_width: 1.0,
            line_dash: Arc::from([]),
            line_dash_offset: 0.0,
            line_cap: CanvasLineCap::default(),
            line_join: CanvasLineJoin::default(),
            miter_limit: 10.0,
            font_size: 10.0,
            text_align: CanvasTextAlign::default(),
            text_baseline: CanvasTextBaseline::default(),
            transform: CanvasTransform::IDENTITY,
            clip: None,
            stack: Vec::new(),
            path: CanvasPath::default(),
        }
    }
}

impl CanvasRasterState {
    fn color(&self, color: Color) -> [u8; 4] {
        [
            color.red,
            color.green,
            color.blue,
            (f32::from(color.alpha) * self.global_alpha.clamp(0.0, 1.0)).round() as u8,
        ]
    }

    fn saved(&self) -> CanvasSavedState {
        CanvasSavedState {
            fill: self.fill,
            stroke: self.stroke,
            global_alpha: self.global_alpha,
            line_width: self.line_width,
            line_dash: self.line_dash.clone(),
            line_dash_offset: self.line_dash_offset,
            line_cap: self.line_cap,
            line_join: self.line_join,
            miter_limit: self.miter_limit,
            font_size: self.font_size,
            text_align: self.text_align,
            text_baseline: self.text_baseline,
            transform: self.transform,
            clip: self.clip.clone(),
        }
    }

    fn restore_saved(&mut self, saved: CanvasSavedState) {
        self.fill = saved.fill;
        self.stroke = saved.stroke;
        self.global_alpha = saved.global_alpha;
        self.line_width = saved.line_width;
        self.line_dash = saved.line_dash;
        self.line_dash_offset = saved.line_dash_offset;
        self.line_cap = saved.line_cap;
        self.line_join = saved.line_join;
        self.miter_limit = saved.miter_limit;
        self.font_size = saved.font_size;
        self.text_align = saved.text_align;
        self.text_baseline = saved.text_baseline;
        self.transform = saved.transform;
        self.clip = saved.clip;
    }
}

fn canvas_arg_f32(command: &CanvasCommand, index: usize) -> Result<f32, RenderError> {
    command
        .args
        .get(index)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value as f32)
        .filter(|value| value.is_finite())
        .ok_or_else(|| {
            RenderError::InvalidCanvas(format!(
                "canvas command {} argument {index} must be finite",
                command.op
            ))
        })
}

fn canvas_arg_string(command: &CanvasCommand, index: usize) -> Result<&str, RenderError> {
    command
        .args
        .get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RenderError::InvalidCanvas(format!(
                "canvas command {} argument {index} must be a string",
                command.op
            ))
        })
}

fn parse_canvas_text_align(value: &str) -> Result<CanvasTextAlign, RenderError> {
    match value.trim() {
        "start" => Ok(CanvasTextAlign::Start),
        "end" => Ok(CanvasTextAlign::End),
        "left" => Ok(CanvasTextAlign::Left),
        "right" => Ok(CanvasTextAlign::Right),
        "center" => Ok(CanvasTextAlign::Center),
        _ => Err(RenderError::InvalidCanvas(format!(
            "unsupported textAlign value {value}"
        ))),
    }
}

fn parse_canvas_text_baseline(value: &str) -> Result<CanvasTextBaseline, RenderError> {
    match value.trim() {
        "alphabetic" => Ok(CanvasTextBaseline::Alphabetic),
        "top" => Ok(CanvasTextBaseline::Top),
        "hanging" => Ok(CanvasTextBaseline::Hanging),
        "middle" => Ok(CanvasTextBaseline::Middle),
        "ideographic" => Ok(CanvasTextBaseline::Ideographic),
        "bottom" => Ok(CanvasTextBaseline::Bottom),
        _ => Err(RenderError::InvalidCanvas(format!(
            "unsupported textBaseline value {value}"
        ))),
    }
}

fn parse_canvas_line_cap(value: &str) -> Result<CanvasLineCap, RenderError> {
    match value.trim() {
        "butt" => Ok(CanvasLineCap::Butt),
        "round" => Ok(CanvasLineCap::Round),
        "square" => Ok(CanvasLineCap::Square),
        _ => Err(RenderError::InvalidCanvas(format!(
            "unsupported lineCap value {value}"
        ))),
    }
}

fn parse_canvas_line_join(value: &str) -> Result<CanvasLineJoin, RenderError> {
    match value.trim() {
        "miter" => Ok(CanvasLineJoin::Miter),
        "round" => Ok(CanvasLineJoin::Round),
        "bevel" => Ok(CanvasLineJoin::Bevel),
        _ => Err(RenderError::InvalidCanvas(format!(
            "unsupported lineJoin value {value}"
        ))),
    }
}

fn parse_canvas_color(value: &str) -> Result<Color, RenderError> {
    let value = value.trim();
    let hex = value.strip_prefix('#');
    if let Some(hex) = hex {
        let expand = |digit: u8| digit * 17;
        let bytes = hex.as_bytes();
        let nibble = |byte: u8| -> Option<u8> {
            match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            }
        };
        let channels = match bytes.len() {
            3 => [
                expand(nibble(bytes[0]).ok_or_else(|| invalid_color(value))?),
                expand(nibble(bytes[1]).ok_or_else(|| invalid_color(value))?),
                expand(nibble(bytes[2]).ok_or_else(|| invalid_color(value))?),
                255,
            ],
            4 => [
                expand(nibble(bytes[0]).ok_or_else(|| invalid_color(value))?),
                expand(nibble(bytes[1]).ok_or_else(|| invalid_color(value))?),
                expand(nibble(bytes[2]).ok_or_else(|| invalid_color(value))?),
                expand(nibble(bytes[3]).ok_or_else(|| invalid_color(value))?),
            ],
            6 | 8 => {
                let mut parsed = [0u8; 4];
                for channel in 0..3 {
                    let hi = nibble(bytes[channel * 2]).ok_or_else(|| invalid_color(value))?;
                    let lo = nibble(bytes[channel * 2 + 1]).ok_or_else(|| invalid_color(value))?;
                    parsed[channel] = hi * 16 + lo;
                }
                parsed[3] = if bytes.len() == 8 {
                    nibble(bytes[6]).ok_or_else(|| invalid_color(value))? * 16
                        + nibble(bytes[7]).ok_or_else(|| invalid_color(value))?
                } else {
                    255
                };
                parsed
            }
            _ => return Err(invalid_color(value)),
        };
        return Ok(Color {
            red: channels[0],
            green: channels[1],
            blue: channels[2],
            alpha: channels[3],
        });
    }
    let lower = value.to_ascii_lowercase();
    let named = match lower.as_str() {
        "transparent" => Color::TRANSPARENT,
        "black" => Color {
            red: 0,
            green: 0,
            blue: 0,
            alpha: 255,
        },
        "white" => Color::WHITE,
        "red" => Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        },
        "green" => Color {
            red: 0,
            green: 128,
            blue: 0,
            alpha: 255,
        },
        "blue" => Color {
            red: 0,
            green: 0,
            blue: 255,
            alpha: 255,
        },
        _ => return parse_canvas_function_color(value),
    };
    Ok(named)
}

fn invalid_color(value: &str) -> RenderError {
    RenderError::InvalidCanvas(format!("invalid canvas color {value}"))
}

fn parse_canvas_function_color(value: &str) -> Result<Color, RenderError> {
    let lower = value.to_ascii_lowercase();
    let (name, body) = lower
        .split_once('(')
        .and_then(|(name, body)| body.strip_suffix(')').map(|body| (name, body)))
        .ok_or_else(|| invalid_color(value))?;
    if name != "rgb" && name != "rgba" {
        return Err(invalid_color(value));
    }
    let values = body.split(',').map(str::trim).collect::<Vec<_>>();
    if values.len() != 3 && values.len() != 4 {
        return Err(invalid_color(value));
    }
    let parse_channel = |raw: &str| {
        raw.parse::<f32>()
            .ok()
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 255.0).round() as u8)
            .ok_or_else(|| invalid_color(value))
    };
    let alpha = if values.len() == 4 {
        values[3]
            .parse::<f32>()
            .ok()
            .filter(|value| value.is_finite())
            .map(|value| (value.clamp(0.0, 1.0) * 255.0).round() as u8)
            .ok_or_else(|| invalid_color(value))?
    } else {
        255
    };
    Ok(Color {
        red: parse_channel(values[0])?,
        green: parse_channel(values[1])?,
        blue: parse_channel(values[2])?,
        alpha,
    })
}

fn canvas_bounds(width: u32, height: u32) -> Result<(usize, usize), RenderError> {
    let (stride, bytes) = rgba_buffer_layout(width, height)?;
    let stride = usize::try_from(stride).map_err(|_| RenderError::PixelBufferOverflow)?;
    Ok((stride, bytes))
}

#[cfg(any(not(feature = "skia-backend"), test))]
fn draw_canvas_polygon(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    points: &[CanvasPoint],
    color: [u8; 4],
    clip: Option<&[u64]>,
) {
    if points.len() < 3 {
        return;
    }
    let min_x = points
        .iter()
        .map(|point| point.x)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as u32;
    let max_x = points
        .iter()
        .map(|point| point.x)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil()
        .min(width as f32) as u32;
    let min_y = points
        .iter()
        .map(|point| point.y)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as u32;
    let max_y = points
        .iter()
        .map(|point| point.y)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil()
        .min(height as f32) as u32;
    if min_x >= max_x || min_y >= max_y {
        return;
    }
    for y in min_y..max_y {
        for x in min_x..max_x {
            let px = x as f32 + 0.5;
            let py = y as f32 + 0.5;
            let mut inside = false;
            for index in 0..points.len() {
                let a = points[index];
                let b = points[(index + points.len() - 1) % points.len()];
                if (a.y > py) != (b.y > py) && px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x {
                    inside = !inside;
                }
            }
            if inside && canvas_clip::allows(clip, y as usize * width as usize + x as usize) {
                let offset = (y as usize * width as usize + x as usize) * 4;
                blend_pixel(&mut pixels[offset..offset + 4], color);
            }
        }
    }
}

#[cfg(any(not(feature = "skia-backend"), test))]
fn clear_canvas_polygon(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    points: &[CanvasPoint],
    clip: Option<&[u64]>,
) {
    if points.len() < 3 {
        return;
    }
    let min_x = points
        .iter()
        .map(|point| point.x)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as u32;
    let max_x = points
        .iter()
        .map(|point| point.x)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil()
        .min(width as f32) as u32;
    let min_y = points
        .iter()
        .map(|point| point.y)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as u32;
    let max_y = points
        .iter()
        .map(|point| point.y)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil()
        .min(height as f32) as u32;
    for y in min_y..max_y {
        for x in min_x..max_x {
            let px = x as f32 + 0.5;
            let py = y as f32 + 0.5;
            let mut inside = false;
            for index in 0..points.len() {
                let a = points[index];
                let b = points[(index + points.len() - 1) % points.len()];
                if (a.y > py) != (b.y > py) && px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x {
                    inside = !inside;
                }
            }
            if inside && canvas_clip::allows(clip, y as usize * width as usize + x as usize) {
                let offset = (y as usize * width as usize + x as usize) * 4;
                pixels[offset..offset + 4].fill(0);
            }
        }
    }
}

#[cfg(any(not(feature = "skia-backend"), test))]
fn canvas_text(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    state: &CanvasRasterState,
    text: &str,
    origin: CanvasPoint,
    color: [u8; 4],
) {
    // Keep the headless renderer deterministic when no platform font manager
    // exists. Native Skia hosts replace this with actual glyph rasterization.
    let scale = (state.font_size / 8.0).clamp(1.0, 8.0).round();
    let advance = 6.0 * scale;
    let max_columns = text
        .split('\n')
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0) as f32;
    let text_width = max_columns * advance;
    let x_origin = match state.text_align {
        CanvasTextAlign::End | CanvasTextAlign::Right => origin.x - text_width,
        CanvasTextAlign::Center => origin.x - text_width * 0.5,
        CanvasTextAlign::Start | CanvasTextAlign::Left => origin.x,
    };
    let glyph_height = 7.0 * scale;
    let line_height = 8.0 * scale;
    let y_origin = match state.text_baseline {
        CanvasTextBaseline::Top => origin.y,
        CanvasTextBaseline::Hanging => origin.y - glyph_height * 0.2,
        CanvasTextBaseline::Middle => origin.y - glyph_height * 0.5,
        CanvasTextBaseline::Ideographic => origin.y - glyph_height * 0.9,
        CanvasTextBaseline::Bottom => origin.y - glyph_height,
        CanvasTextBaseline::Alphabetic => origin.y - glyph_height,
    };
    let mut x = x_origin;
    let mut y = y_origin;
    for character in text.chars() {
        if character == '\n' {
            x = x_origin;
            y += line_height;
            continue;
        }
        let glyph = fallback_glyph(character);
        for (row, bits) in glyph.iter().enumerate() {
            for column in 0..5 {
                if bits & (1 << (4 - column)) != 0 {
                    let rect = [
                        CanvasPoint {
                            x: x + column as f32 * scale,
                            y: y + row as f32 * scale,
                        },
                        CanvasPoint {
                            x: x + (column as f32 + 1.0) * scale,
                            y: y + row as f32 * scale,
                        },
                        CanvasPoint {
                            x: x + (column as f32 + 1.0) * scale,
                            y: y + (row as f32 + 1.0) * scale,
                        },
                        CanvasPoint {
                            x: x + column as f32 * scale,
                            y: y + (row as f32 + 1.0) * scale,
                        },
                    ];
                    draw_canvas_polygon(pixels, width, height, &rect, color, state.clip.as_deref());
                }
            }
        }
        x += advance;
    }
}

#[cfg(test)]
mod canvas_work_probes {
    use std::cell::Cell;

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub(super) struct Counts {
        pub(super) software_rasters: usize,
        pub(super) native_surfaces: usize,
        pub(super) native_readbacks: usize,
    }

    thread_local! {
        static COUNTS: Cell<Counts> = const { Cell::new(Counts {
            software_rasters: 0,
            native_surfaces: 0,
            native_readbacks: 0,
        }) };
    }

    pub(super) fn reset() {
        COUNTS.with(|counts| counts.set(Counts::default()));
    }

    pub(super) fn counts() -> Counts {
        COUNTS.with(Cell::get)
    }

    pub(super) fn software_raster() {
        COUNTS.with(|cell| {
            let mut counts = cell.get();
            counts.software_rasters += 1;
            cell.set(counts);
        });
    }

    #[cfg(feature = "skia-backend")]
    pub(super) fn native_surface() {
        COUNTS.with(|cell| {
            let mut counts = cell.get();
            counts.native_surfaces += 1;
            cell.set(counts);
        });
    }

    #[cfg(feature = "skia-backend")]
    pub(super) fn native_readback() {
        COUNTS.with(|cell| {
            let mut counts = cell.get();
            counts.native_readbacks += 1;
            cell.set(counts);
        });
    }
}

// Preflight and software execution share all path/state steps.
fn apply_canvas_state_command(
    state: &mut CanvasRasterState,
    command: &canvas_batch::PreparedCanvasCommand,
) -> bool {
    use canvas_batch::PreparedCanvasCommand;
    match command {
        PreparedCanvasCommand::ResetState => *state = CanvasRasterState::default(),
        PreparedCanvasCommand::SetFillStyle(color) => state.fill = *color,
        PreparedCanvasCommand::SetStrokeStyle(color) => state.stroke = *color,
        PreparedCanvasCommand::SetLineWidth(width) => state.line_width = *width,
        PreparedCanvasCommand::SetLineDash { pattern, offset } => {
            state.line_dash = pattern.clone().into();
            state.line_dash_offset = *offset;
        }
        PreparedCanvasCommand::SetLineCap(cap) => state.line_cap = *cap,
        PreparedCanvasCommand::SetLineJoin(join) => state.line_join = *join,
        PreparedCanvasCommand::SetMiterLimit(limit) => state.miter_limit = *limit,
        PreparedCanvasCommand::SetGlobalAlpha(alpha) => state.global_alpha = *alpha,
        PreparedCanvasCommand::SetFontSize(size) => state.font_size = *size,
        PreparedCanvasCommand::SetTextAlign(align) => state.text_align = *align,
        PreparedCanvasCommand::SetTextBaseline(baseline) => state.text_baseline = *baseline,
        PreparedCanvasCommand::Save => state.stack.push(state.saved()),
        PreparedCanvasCommand::Restore => {
            if let Some(saved) = state.stack.pop() {
                state.restore_saved(saved);
            }
        }
        PreparedCanvasCommand::Translate([x, y]) => {
            state.transform = state.transform.multiply(CanvasTransform {
                a: 1.0,
                b: 0.0,
                c: 0.0,
                d: 1.0,
                e: *x,
                f: *y,
            })
        }
        PreparedCanvasCommand::Rotate(angle) => {
            state.transform = state.transform.multiply(CanvasTransform {
                a: angle.cos(),
                b: angle.sin(),
                c: -angle.sin(),
                d: angle.cos(),
                e: 0.0,
                f: 0.0,
            });
        }
        PreparedCanvasCommand::Scale([x, y]) => {
            state.transform = state.transform.multiply(CanvasTransform {
                a: *x,
                b: 0.0,
                c: 0.0,
                d: *y,
                e: 0.0,
                f: 0.0,
            })
        }
        PreparedCanvasCommand::SetTransform(values) => {
            state.transform = CanvasTransform::from_values(*values);
        }
        PreparedCanvasCommand::Transform(values) => {
            state.transform = state
                .transform
                .multiply(CanvasTransform::from_values(*values));
        }
        _ => return false,
    }
    true
}

fn apply_canvas_path_command(
    state: &mut CanvasRasterState,
    command: &canvas_batch::PreparedCanvasCommand,
) -> bool {
    use canvas_batch::PreparedCanvasCommand;
    match command {
        PreparedCanvasCommand::BeginPath => state.path = CanvasPath::default(),
        PreparedCanvasCommand::ClosePath => state.path.close(),
        PreparedCanvasCommand::MoveTo([x, y]) => {
            state
                .path
                .move_to(state.transform.apply(CanvasPoint { x: *x, y: *y }));
        }
        PreparedCanvasCommand::LineTo([x, y]) => {
            state
                .path
                .line_to(state.transform.apply(CanvasPoint { x: *x, y: *y }));
        }
        PreparedCanvasCommand::QuadraticCurveTo([cx, cy, x, y]) => {
            let control = state.transform.apply(CanvasPoint { x: *cx, y: *cy });
            let end = state.transform.apply(CanvasPoint { x: *x, y: *y });
            state.path.curve_to(&[control, end]);
        }
        PreparedCanvasCommand::BezierCurveTo([cx1, cy1, cx2, cy2, x, y]) => {
            let c1 = state.transform.apply(CanvasPoint { x: *cx1, y: *cy1 });
            let c2 = state.transform.apply(CanvasPoint { x: *cx2, y: *cy2 });
            let end = state.transform.apply(CanvasPoint { x: *x, y: *y });
            state.path.curve_to(&[c1, c2, end]);
        }
        PreparedCanvasCommand::ConicArcTo(arc) => canvas_arcto::append(&mut state.path, *arc),
        PreparedCanvasCommand::Arc {
            center,
            radius,
            start,
            sweep,
        } => {
            let [cx, cy] = *center;
            let (radius, start, sweep) = (*radius, *start, *sweep);
            // Native arcs transform unit-circle geometry with this matrix,
            // including zero sweeps. Validate it before sampling any points.
            let circle = state.transform.multiply(CanvasTransform {
                a: radius,
                b: 0.0,
                c: 0.0,
                d: radius,
                e: cx,
                f: cy,
            });
            if [circle.a, circle.b, circle.c, circle.d, circle.e, circle.f]
                .iter()
                .any(|value| !value.is_finite())
            {
                state.path.non_finite = true;
                return true;
            }
            let scale = f64::from(state.transform.a).hypot(f64::from(state.transform.b))
                + f64::from(state.transform.c).hypot(f64::from(state.transform.d));
            let device_radius = f64::from(radius) * scale;
            let angle_step = if device_radius <= 0.0625 {
                std::f64::consts::PI
            } else {
                2.0 * (1.0 - 0.0625 / device_radius).clamp(-1.0, 1.0).acos()
            };
            let required_steps = (f64::from(sweep.abs()) / angle_step).ceil();
            if sweep != 0.0 && (!required_steps.is_finite() || required_steps > 4096.0) {
                state.path.too_complex = true;
                return true;
            }
            let steps = required_steps.max(1.0) as usize;
            let first = state.transform.apply(CanvasPoint {
                x: cx + radius * start.cos(),
                y: cy + radius * start.sin(),
            });
            if state.path.current_mut().is_empty() {
                state.path.move_to(first);
            } else {
                state.path.line_to(first);
            }
            if sweep == 0.0 {
                return true;
            }
            for step in 1..=steps {
                let angle = start + sweep * (step as f32 / steps as f32);
                state.path.line_to(state.transform.apply(CanvasPoint {
                    x: cx + radius * angle.cos(),
                    y: cy + radius * angle.sin(),
                }));
            }
        }
        PreparedCanvasCommand::Rect(rect) => {
            let [x, y, width, height] = *rect;
            state
                .path
                .move_to(state.transform.apply(CanvasPoint { x, y }));
            state
                .path
                .line_to(state.transform.apply(CanvasPoint { x: x + width, y }));
            state.path.line_to(state.transform.apply(CanvasPoint {
                x: x + width,
                y: y + height,
            }));
            state
                .path
                .line_to(state.transform.apply(CanvasPoint { x, y: y + height }));
            state.path.close();
        }
        _ => return false,
    }
    true
}

/// Shared admission cost for the complete retained replay. This intentionally
/// overestimates clipped work rather than allocating a target to measure it.
fn validate_canvas_geometry(
    commands: &mut [canvas_batch::PreparedCanvasCommand],
    width: u32,
    height: u32,
) -> Result<(), RenderError> {
    use canvas_batch::{PreparedCanvasBatch, PreparedCanvasCommand};
    let mut state = CanvasRasterState::default();
    let mut vertices = 0usize;
    let mut work = 0u64;
    let pixels = u64::from(width) * u64::from(height);
    let mut clips = canvas_clip::Budget::new(pixels);
    fn charge_product(work: &mut u64, left: u64, right: u64) -> Result<(), RenderError> {
        let cost = left.checked_mul(right).ok_or_else(|| {
            RenderError::InvalidCanvas("canvas geometry work budget exceeded".into())
        })?;
        charge(work, cost)
    }
    fn charge(work: &mut u64, cost: u64) -> Result<(), RenderError> {
        *work = work
            .checked_add(cost)
            .filter(|value| *value <= PreparedCanvasBatch::MAX_DRAW_WORK)
            .ok_or_else(|| {
                RenderError::InvalidCanvas("canvas geometry work budget exceeded".into())
            })?;
        Ok(())
    }
    for command in commands {
        if let PreparedCanvasCommand::PendingArcTo(values) = command {
            *command = canvas_arcto::lower(*values, state.path.current_point(), state.transform)?;
        }
        let command = &*command;
        clips.admit(command)?;
        if apply_canvas_state_command(&mut state, command) {
            if [
                state.transform.a,
                state.transform.b,
                state.transform.c,
                state.transform.d,
                state.transform.e,
                state.transform.f,
            ]
            .iter()
            .any(|value| !value.is_finite())
            {
                return Err(RenderError::InvalidCanvas(
                    "canvas transform exceeds finite scalar limits".into(),
                ));
            }
            continue;
        }
        let before = state.path.vertices;
        if apply_canvas_path_command(&mut state, command) {
            if state.path.too_complex {
                return Err(RenderError::InvalidCanvas(
                    "canvas curve flattening budget exceeded".into(),
                ));
            }
            if state.path.non_finite {
                return Err(RenderError::InvalidCanvas(
                    "canvas path exceeds finite scalar limits".into(),
                ));
            }
            vertices = vertices
                .checked_add(state.path.vertices.saturating_sub(before))
                .filter(|count| *count <= PreparedCanvasBatch::MAX_GEOMETRY_VERTICES)
                .ok_or_else(|| {
                    RenderError::InvalidCanvas("canvas geometry vertex budget exceeded".into())
                })?;
            continue;
        }
        let stroke = matches!(
            command,
            PreparedCanvasCommand::Stroke
                | PreparedCanvasCommand::StrokeRect(_)
                | PreparedCanvasCommand::StrokeText { .. }
        );
        if stroke && state.line_width == 0.0 {
            continue;
        }
        if stroke && state.transform.inverse().is_none() {
            let determinant = f64::from(state.transform.a) * f64::from(state.transform.d)
                - f64::from(state.transform.b) * f64::from(state.transform.c);
            if determinant != 0.0 {
                return Err(RenderError::InvalidCanvas(
                    "canvas stroke inverse exceeds finite scalar limits".into(),
                ));
            }
            continue;
        }
        match command {
            PreparedCanvasCommand::Clip => {
                // Include mask initialization/intersection even for an empty
                // current path. Admission never allocates the mask itself.
                charge_product(&mut work, pixels + 1, state.path.vertices as u64 + 1)?;
            }
            PreparedCanvasCommand::Fill | PreparedCanvasCommand::Stroke => {
                if state.path.vertices != 0 {
                    charge_product(
                        &mut work,
                        pixels + 1,
                        state.path.vertices as u64 + u64::from(clips.has_clip()),
                    )?;
                }
                if stroke {
                    let inverse = state
                        .transform
                        .inverse()
                        .expect("non-singular inverse validated above");
                    for point in state.path.subpaths.iter().flatten() {
                        let x = f64::from(inverse.a) * f64::from(point.x)
                            + f64::from(inverse.c) * f64::from(point.y)
                            + f64::from(inverse.e);
                        let y = f64::from(inverse.b) * f64::from(point.x)
                            + f64::from(inverse.d) * f64::from(point.y)
                            + f64::from(inverse.f);
                        let native_point = inverse.apply(*point);
                        if !native_point.x.is_finite()
                            || !native_point.y.is_finite()
                            || !x.is_finite()
                            || !y.is_finite()
                            || x.abs() > f64::from(f32::MAX)
                            || y.abs() > f64::from(f32::MAX)
                        {
                            return Err(RenderError::InvalidCanvas(
                                "canvas stroke path exceeds finite scalar limits".into(),
                            ));
                        }
                    }
                }
            }
            PreparedCanvasCommand::FillRect(rect)
            | PreparedCanvasCommand::ClearRect(rect)
            | PreparedCanvasCommand::StrokeRect(rect) => {
                let [x, y, w, h] = *rect;
                for (x, y) in [(x, y), (x + w, y), (x + w, y + h), (x, y + h)] {
                    let point = state.transform.apply(CanvasPoint { x, y });
                    if !point.x.is_finite() || !point.y.is_finite() {
                        return Err(RenderError::InvalidCanvas(
                            "canvas rect exceeds finite scalar limits".into(),
                        ));
                    }
                }
                vertices += 5;
                if vertices > PreparedCanvasBatch::MAX_GEOMETRY_VERTICES {
                    return Err(RenderError::InvalidCanvas(
                        "canvas geometry vertex budget exceeded".into(),
                    ));
                }
                charge_product(&mut work, pixels + 1, 5)?;
            }
            PreparedCanvasCommand::FillText { text, position }
            | PreparedCanvasCommand::StrokeText { text, position } => {
                let origin = state.transform.apply(CanvasPoint {
                    x: position[0],
                    y: position[1],
                });
                if !origin.x.is_finite() || !origin.y.is_finite() {
                    return Err(RenderError::InvalidCanvas(
                        "canvas text position exceeds finite scalar limits".into(),
                    ));
                }
                // At most 35 fallback glyph cells, each a four-edge polygon.
                // A whole glyph/device-target bound deliberately overcharges
                // unusual fonts and transforms before font/native execution.
                let scale = f64::from(state.transform.a).hypot(f64::from(state.transform.b))
                    + f64::from(state.transform.c).hypot(f64::from(state.transform.d));
                let side = (f64::from(state.font_size.max(8.0))
                    + if stroke {
                        f64::from(state.line_width)
                    } else {
                        0.0
                    })
                    * scale.max(1.0);
                let glyph_pixels = ((side * side).ceil().min(pixels as f64) as u64).max(1);
                let cost = (text.chars().count() as u64)
                    .checked_mul(glyph_pixels)
                    .and_then(|value| value.checked_mul(if clips.has_clip() { 175 } else { 140 }))
                    .ok_or_else(|| {
                        RenderError::InvalidCanvas("canvas geometry work budget exceeded".into())
                    })?;
                charge(&mut work, cost)?;
            }
            _ => unreachable!("prepared command must have a state, path or drawing consumer"),
        }
    }
    Ok(())
}

#[cfg(test)]
fn rasterize_canvas(frame: &CanvasFrame) -> Result<RenderSnapshot, RenderError> {
    let prepared = PreparedCanvasBatch::prepare(frame)?;
    Ok(rasterize_prepared_canvas(&prepared))
}

#[cfg(any(not(feature = "skia-backend"), test))]
fn rasterize_prepared_canvas(frame: &PreparedCanvasBatch) -> RenderSnapshot {
    #[cfg(test)]
    canvas_work_probes::software_raster();
    let mut pixels = vec![0; frame.byte_len];
    let mut state = CanvasRasterState::default();
    for command in &frame.commands {
        if apply_canvas_state_command(&mut state, command)
            || apply_canvas_path_command(&mut state, command)
        {
            continue;
        }
        match command {
            PreparedCanvasCommand::Clip => {
                state.clip = Some(canvas_clip::intersect(
                    &state.path,
                    state.clip.as_deref(),
                    frame.width,
                    frame.height,
                ));
            }
            PreparedCanvasCommand::FillRect(rect)
            | PreparedCanvasCommand::StrokeRect(rect)
            | PreparedCanvasCommand::ClearRect(rect) => {
                let [x, y, width, height] = *rect;
                let points = [
                    state.transform.apply(CanvasPoint { x, y }),
                    state.transform.apply(CanvasPoint { x: x + width, y }),
                    state.transform.apply(CanvasPoint {
                        x: x + width,
                        y: y + height,
                    }),
                    state.transform.apply(CanvasPoint { x, y: y + height }),
                ];
                match command {
                    PreparedCanvasCommand::FillRect(_) => draw_canvas_polygon(
                        &mut pixels,
                        frame.width,
                        frame.height,
                        &points,
                        state.color(state.fill),
                        state.clip.as_deref(),
                    ),
                    PreparedCanvasCommand::ClearRect(_) => clear_canvas_polygon(
                        &mut pixels,
                        frame.width,
                        frame.height,
                        &points,
                        state.clip.as_deref(),
                    ),
                    _ => {
                        let path = CanvasPath {
                            subpaths: vec![points.to_vec()],
                            closed: vec![true],
                            vertices: 4,
                            non_finite: false,
                            too_complex: false,
                        };
                        path.stroke(&mut pixels, frame.width, frame.height, &state);
                    }
                }
            }
            PreparedCanvasCommand::Fill | PreparedCanvasCommand::Stroke => {
                if matches!(command, PreparedCanvasCommand::Fill) {
                    for subpath in &state.path.subpaths {
                        draw_canvas_polygon(
                            &mut pixels,
                            frame.width,
                            frame.height,
                            subpath,
                            state.color(state.fill),
                            state.clip.as_deref(),
                        );
                    }
                } else {
                    state
                        .path
                        .stroke(&mut pixels, frame.width, frame.height, &state);
                }
            }
            PreparedCanvasCommand::FillText { text, position }
            | PreparedCanvasCommand::StrokeText { text, position } => {
                if matches!(command, PreparedCanvasCommand::StrokeText { .. })
                    && (state.line_width == 0.0 || state.transform.inverse().is_none())
                {
                    continue;
                }
                let point = state.transform.apply(CanvasPoint {
                    x: position[0],
                    y: position[1],
                });
                let color = if matches!(command, PreparedCanvasCommand::FillText { .. }) {
                    state.color(state.fill)
                } else {
                    state.color(state.stroke)
                };
                canvas_text(
                    &mut pixels,
                    frame.width,
                    frame.height,
                    &state,
                    text,
                    point,
                    color,
                );
            }

            _ => unreachable!("shared state/path replay consumed command"),
        }
    }
    RenderSnapshot {
        frame_id: frame.frame_id,
        width: frame.width,
        height: frame.height,
        stride: frame.stride,
        format: "rgba8-premultiplied".into(),
        pixels,
    }
}

impl Renderer for SoftwareRenderer {
    fn backend_name(&self) -> &'static str {
        "software-fallback"
    }

    fn commit(&mut self, frame: RenderFrame) -> Result<(), RenderError> {
        self.commit_frame(frame, true)
    }

    fn last_frame(&self) -> Option<&RenderFrame> {
        self.last_frame.as_ref()
    }

    fn has_gpu_surface(&self) -> bool {
        false
    }
}

#[cfg(all(
    feature = "skia-gpu-metal",
    any(target_os = "macos", target_os = "ios")
))]
mod metal_target;

/// Where accepted page frames are presented. This is independent of the JS
/// engine and of whether an actual GPU surface has received a frame.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PageRenderMode {
    #[default]
    Raster,
    ExternalFrame,
    NativeGpu,
}

/// A presentation mode validated without constructing a renderer or acquiring
/// drawing resources. Lazy owners retain this token until an explicit Skia use.
#[derive(Clone, Copy, Debug)]
pub struct ValidatedPageRenderMode(PageRenderMode);

impl ValidatedPageRenderMode {
    pub fn new(mode: PageRenderMode) -> Result<Self, RenderError> {
        if mode == PageRenderMode::NativeGpu
            && !cfg!(any(
                feature = "skia-gpu-gles",
                all(
                    feature = "skia-gpu-metal",
                    any(target_os = "macos", target_os = "ios")
                )
            ))
        {
            return Err(RenderError::Unsupported("native-gpu-backend-not-compiled"));
        }
        Ok(Self(mode))
    }

    pub fn mode(self) -> PageRenderMode {
        self.0
    }
}

/// Pure, backend-aware proof for a future page target. Validation allocates no
/// page, Canvas, font provider, pixels or GPU context. This is configuration,
/// not an accepted frame or a presentation receipt.
#[derive(Clone, Copy, Debug)]
pub struct ValidatedPageRenderTarget {
    mode: ValidatedPageRenderMode,
    scale: f64,
    size: RenderTargetSize,
}

impl ValidatedPageRenderTarget {
    pub fn new(mode: PageRenderMode, viewport: Rect, scale: f64) -> Result<Self, RenderError> {
        let mode = ValidatedPageRenderMode::new(mode)?;
        let size = RenderTargetSize::for_viewport(viewport, scale)?;
        Ok(Self { mode, scale, size })
    }

    pub fn size(self) -> RenderTargetSize {
        self.size
    }

    pub fn scale(self) -> f64 {
        self.scale
    }
}

/// Stable renderer type used by host adapters. Native Skia can replace the inner
/// implementation behind the `skia-backend` feature without changing host APIs.
pub struct SkiaRenderer {
    software_fallback: SoftwareRenderer,
    component_frames: BTreeMap<String, Arc<ImageResource>>,
    canvas_bindings: Vec<CanvasOwnerKey>,
    #[cfg(feature = "skia-backend")]
    native_images: BTreeMap<String, images::NativeImage>,
    /// Export validated layout/paint IR to a host-owned presenter without
    /// allocating or rasterizing a second page surface on each commit.
    page_render_mode: PageRenderMode,
    /// Raster density only; never changes layout or simulated device metrics.
    render_scale: f64,
    /// Target of the accepted frame, independent of staged density settings.
    accepted_render_target: Option<RenderTargetSize>,
    /// Numeric density accepted with that page, never a pending target setting.
    accepted_render_scale: Option<f64>,
    last_render_ms: f64,
    /// Independent Canvas state and drawing resources move here on page use.
    canvas: CanvasService,
    #[cfg(feature = "skia-backend")]
    native_surface: Option<skia::Surface>,
    /// Readback from the last Skia raster surface. Keeping this beside the
    /// surface makes the host boundary explicit: a committed frame has been
    /// rasterized by Skia and the bytes returned by [`Self::snapshot`] are
    /// from that surface, rather than from the deterministic software path.
    #[cfg(feature = "skia-backend")]
    native_snapshot: Option<RenderSnapshot>,
    /// Optional host-owned Ganesh Metal context.  The context is only
    /// created after a platform adapter supplies valid MTLDevice and
    /// MTLCommandQueue handles.  Drawable textures are short lived and are
    /// wrapped per frame by [`Self::render_last_frame_to_metal_texture`].
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    metal_backend: Option<skia::gpu::mtl::BackendContext>,
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    metal_context: Option<skia::gpu::DirectContext>,
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    metal_surface_attached: bool,
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    metal_device_id: Option<usize>,
    /// Optional host-owned Ganesh OpenGL ES context. The host must make the
    /// EGL context current before attaching it and before rendering a frame.
    /// A context alone is not a surface; `gl_surface_attached` is set only
    /// after a real framebuffer receives the committed frame.
    #[cfg(feature = "skia-gpu-gles")]
    gl_context: Option<skia::gpu::DirectContext>,
    #[cfg(feature = "skia-gpu-gles")]
    gl_surface_attached: bool,
}

impl std::fmt::Debug for SkiaRenderer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SkiaRenderer")
            .field("software_fallback", &self.software_fallback)
            .field("backend", &self.backend_name())
            .field("native_surface", &self.has_native_surface())
            .finish()
    }
}

impl SkiaRenderer {
    /// Lay out text with this renderer's host font provider. The accepted
    /// glyph positions travel with the frame and are reused by every paint
    /// surface; software-only builds retain deterministic fallback metrics.
    pub fn layout_tree(
        &mut self,
        root: &mut RenderNode,
        viewport: Rect,
    ) -> Result<(), RenderError> {
        if let Some(font) = &self.canvas.portable_font {
            if self.page_render_mode != PageRenderMode::ExternalFrame {
                return Err(RenderError::InvalidFont(
                    "portable text metrics require the external painter owner".into(),
                ));
            }
            let mut measurer = font.measurer()?;
            measurer.validate_tree(root)?;
            return layout_tree_with_measurer(root, viewport, &mut measurer);
        }
        #[cfg(feature = "skia-backend")]
        {
            layout_tree_with_measurer(
                root,
                viewport,
                &mut NativeTextMeasurer(&mut self.canvas.native_fonts),
            )
        }
        #[cfg(not(feature = "skia-backend"))]
        layout_tree_with_measurer(root, viewport, &mut FallbackTextMeasurer)
    }

    /// Install immutable external-painter metrics before application layout.
    pub fn install_portable_text_font(
        &mut self,
        font: PortableFontData,
    ) -> Result<PortableFontIdentity, RenderError> {
        if self.page_render_mode != PageRenderMode::ExternalFrame
            || self.software_fallback.last_frame().is_some()
        {
            return Err(RenderError::InvalidFont(
                "external text font must precede the first frame".into(),
            ));
        }
        self.canvas.install_portable_text_font(font)
    }

    /// Validate viewport and RGBA buffer representation without allocating a
    /// surface or executing application code. Hosts can call this before
    /// updating a component graph or any other runtime state.
    pub fn validate_viewport(viewport: Rect) -> Result<(), RenderError> {
        let max_dimension = if cfg!(feature = "skia-backend") {
            i32::MAX as u32
        } else {
            u32::MAX
        };
        viewport_surface_layout(viewport, max_dimension).map(|_| ())
    }

    pub fn new() -> Self {
        Self::new_with_validated_page_render_mode(ValidatedPageRenderMode(PageRenderMode::Raster))
    }

    /// Construct only after mode negotiation succeeds. Initialization is
    /// infallible and creates neither a page surface nor an attached GPU.
    pub fn new_with_validated_page_render_mode(mode: ValidatedPageRenderMode) -> Self {
        Self::new_with_validated_mode_and_canvas(mode, CanvasService::default())
    }

    /// Move an existing Canvas/font owner into an inert page renderer. This
    /// constructor has no fallible steps, callbacks or drawing side effects.
    pub fn new_with_validated_mode_and_canvas(
        mode: ValidatedPageRenderMode,
        canvas: CanvasService,
    ) -> Self {
        Self {
            software_fallback: SoftwareRenderer::new(),
            component_frames: BTreeMap::new(),
            canvas_bindings: Vec::new(),
            #[cfg(feature = "skia-backend")]
            native_images: BTreeMap::new(),
            page_render_mode: mode.mode(),
            render_scale: 1.0,
            accepted_render_target: None,
            accepted_render_scale: None,
            last_render_ms: 0.0,
            canvas,
            #[cfg(feature = "skia-backend")]
            native_surface: None,
            #[cfg(feature = "skia-backend")]
            native_snapshot: None,
            #[cfg(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            ))]
            metal_backend: None,
            #[cfg(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            ))]
            metal_context: None,
            #[cfg(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            ))]
            metal_surface_attached: false,
            #[cfg(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            ))]
            metal_device_id: None,
            #[cfg(feature = "skia-gpu-gles")]
            gl_context: None,
            #[cfg(feature = "skia-gpu-gles")]
            gl_surface_attached: false,
        }
    }

    /// Import prevalidated configuration while moving the existing independent
    /// Canvas owner. No fallible operation or user callback runs after the move.
    pub fn new_with_validated_target_and_canvas(
        target: ValidatedPageRenderTarget,
        canvas: CanvasService,
    ) -> Self {
        let mut renderer = Self::new_with_validated_mode_and_canvas(target.mode, canvas);
        renderer.render_scale = target.scale;
        renderer
    }

    /// Commit complete frames for an external presenter (for example
    /// CanvasKit). No page raster surface/readback is created by `commit`.
    /// This is an IR export boundary, not an attached or verified GPU backend.
    pub fn new_frame_export_only() -> Self {
        Self {
            page_render_mode: PageRenderMode::ExternalFrame,
            ..Self::new()
        }
    }

    /// Prepare native drawing resources without allocating a CPU page surface.
    /// The host must attach a supported context and present a real target;
    /// selecting this mode alone never establishes GPU presentation.
    pub fn new_native_gpu() -> Result<Self, RenderError> {
        let mut renderer = Self::new();
        renderer.configure_page_render_mode(PageRenderMode::NativeGpu)?;
        Ok(renderer)
    }

    pub fn page_render_mode(&self) -> PageRenderMode {
        self.page_render_mode
    }

    /// Select a presentation owner before the first accepted page. Keeping
    /// this boundary immutable prevents stale pixels, resources or surface
    /// evidence from surviving a backend change within a live page.
    pub fn configure_page_render_mode(&mut self, mode: PageRenderMode) -> Result<(), RenderError> {
        if mode == self.page_render_mode {
            return Ok(());
        }
        if self.canvas.portable_font.is_some() {
            return Err(RenderError::InvalidFont(
                "portable text metrics require the external painter owner".into(),
            ));
        }
        if self.last_frame().is_some() {
            return Err(RenderError::Unsupported("page-render-mode-after-commit"));
        }
        self.page_render_mode = ValidatedPageRenderMode::new(mode)?.mode();
        Ok(())
    }

    /// The configured backend name before any renderer object or surface
    /// exists. Actual attachment may refine this name after initialization.
    pub fn configured_backend_name(mode: PageRenderMode) -> &'static str {
        match mode {
            PageRenderMode::ExternalFrame => "external-frame-export",
            PageRenderMode::NativeGpu => "skia-gpu-pending",
            PageRenderMode::Raster if cfg!(feature = "skia-backend") => "skia-raster",
            PageRenderMode::Raster => "software-fallback",
        }
    }

    /// Install ordered host-provided font faces before the first native page,
    /// Canvas or GPU render. All faces are decoded before the active provider
    /// changes; a rejected set leaves the current provider and caches intact.
    /// Reinstalling the same bytes and collection indexes is idempotent, even
    /// after rendering. Fonts are owned and cached for this renderer's lifetime.
    #[cfg(feature = "skia-backend")]
    pub fn install_native_fonts(
        &mut self,
        fonts: &[NativeFontData],
    ) -> Result<NativeFontInfo, RenderError> {
        self.canvas.install_native_fonts(fonts)
    }

    /// Describe the injected faces without exposing font bytes or claiming
    /// coverage for characters that have not been validated by the host.
    #[cfg(feature = "skia-backend")]
    pub fn native_font_info(&self) -> NativeFontInfo {
        self.canvas.native_font_info()
    }

    /// Return the latest frame as a portable RGBA snapshot.  Native Skia
    /// still owns and presents its platform surface when enabled; this method
    /// is the explicit batch boundary used by host adapters and tests.
    /// In frame-export-only mode this explicitly requested diagnostic uses
    /// the software rasterizer on demand; it is never GPU presentation proof.
    pub fn snapshot(&self) -> Option<RenderSnapshot> {
        #[cfg(feature = "skia-backend")]
        if let Some(snapshot) = &self.native_snapshot {
            return Some(snapshot.clone());
        }
        // A GPU-only commit has no CPU pixels. Call capture_snapshot explicitly
        // to generate diagnostics; never manufacture software pixels here.
        if self.page_render_mode == PageRenderMode::NativeGpu {
            return None;
        }
        self.software_fallback.snapshot().or_else(|| {
            self.software_fallback
                .last_frame
                .as_ref()
                .and_then(|frame| SoftwareRenderer::rasterize(frame).ok())
        })
    }

    /// Explicit diagnostic capture. Native GPU mode rasterizes the accepted
    /// frame on demand with the same installed fonts and prepared images. It
    /// does not read a drawable or establish GPU/device evidence, and does not
    /// advance the accepted frame revision or change GPU attachment state.
    pub fn capture_snapshot(&mut self) -> Result<Option<RenderSnapshot>, RenderError> {
        if self.page_render_mode != PageRenderMode::NativeGpu {
            return Ok(self.snapshot());
        }
        #[cfg(feature = "skia-backend")]
        {
            if let Some(snapshot) = &self.native_snapshot {
                return Ok(Some(snapshot.clone()));
            }
            let Some(frame) = self.software_fallback.last_frame.as_ref() else {
                return Ok(None);
            };
            let target = self
                .accepted_render_target
                .ok_or(RenderError::Unsupported("accepted-render-target-missing"))?;
            let mut surface = Self::render_native(
                frame,
                &mut self.canvas.native_fonts,
                &self.native_images,
                target,
            )?;
            let snapshot = native_raster::readback_native(
                &mut surface,
                frame.frame_id,
                target.width,
                target.height,
            )?;
            self.native_snapshot = Some(snapshot.clone());
            Ok(Some(snapshot))
        }
        #[cfg(not(feature = "skia-backend"))]
        Err(RenderError::Unsupported("native-gpu-backend-not-compiled"))
    }

    /// Rasterize the accepted logical frame at a host's physical pixel size.
    /// This is used by native CPU texture presenters; it does not resize the
    /// runtime viewport, alter hit testing or advance the accepted frame.
    /// The explicit host dimensions are independent of `render_scale`.
    pub fn snapshot_at_size(
        &mut self,
        width: u32,
        height: u32,
    ) -> Result<RenderSnapshot, RenderError> {
        if width == 0 || height == 0 || width > i32::MAX as u32 || height > i32::MAX as u32 {
            return Err(RenderError::InvalidViewport);
        }
        // Validate integer and RGBA representation before passing dimensions
        // to a native allocator. The host owns its presentation memory budget.
        viewport_surface_layout(
            Rect {
                x: 0.0,
                y: 0.0,
                width: width as f32,
                height: height as f32,
            },
            i32::MAX as u32,
        )?;
        if let Some(snapshot) = self.snapshot_ref() {
            if snapshot.width == width && snapshot.height == height {
                return Ok(snapshot.clone());
            }
        }
        #[cfg(feature = "skia-backend")]
        {
            let frame = self
                .software_fallback
                .last_frame
                .as_ref()
                .ok_or(RenderError::Unsupported("snapshot-without-frame"))?;
            let mut surface = skia::surfaces::raster_n32_premul((width as i32, height as i32))
                .ok_or(RenderError::Unsupported("skia-raster-surface"))?;
            Self::draw_frame_to_target_with_images(
                surface.canvas(),
                frame,
                width,
                height,
                &mut self.canvas.native_fonts,
                &self.native_images,
            )?;
            native_raster::readback_native(&mut surface, frame.frame_id, width, height)
        }
        #[cfg(not(feature = "skia-backend"))]
        {
            let frame = self
                .software_fallback
                .last_frame
                .as_ref()
                .ok_or(RenderError::Unsupported("snapshot-without-frame"))?;
            SoftwareRenderer::rasterize_at_size(frame, width, height)
        }
    }

    /// Borrow accepted pixels without cloning an entire RGBA frame. External
    /// frame-export hosts have no raster snapshot until explicitly requested.
    pub fn snapshot_ref(&self) -> Option<&RenderSnapshot> {
        #[cfg(feature = "skia-backend")]
        if let Some(snapshot) = &self.native_snapshot {
            return Some(snapshot);
        }
        self.software_fallback.last_snapshot.as_ref()
    }

    /// Accepted page presentation identity. It advances for every successful
    /// commit, including scrolling/density changes retaining the app frameId,
    /// and remains unchanged after rejection. No pixel comparison is needed.
    pub fn snapshot_revision(&self) -> u64 {
        self.software_fallback.snapshot_revision()
    }

    /// Physical target published by the last successful page commit. Staging
    /// density, diagnostic capture and independent Canvas draws leave it alone.
    pub fn accepted_render_target(&self) -> Option<RenderTargetSize> {
        self.accepted_render_target
    }

    /// Density accepted with the page pin. `render_scale` may be staged for a
    /// later logical resize and cannot substitute for this publication fact.
    pub fn accepted_render_scale(&self) -> Option<f64> {
        self.accepted_render_scale
    }

    /// Time spent preparing/rasterizing/readback for the accepted page frame.
    /// Excludes JavaScript, WXML evaluation and network/presentation time.
    pub fn last_render_ms(&self) -> f64 {
        self.last_render_ms
    }

    pub fn render_scale(&self) -> f64 {
        self.render_scale
    }

    /// Preflight a presentation target before changing runtime state.
    pub fn validate_render_target(
        &self,
        viewport: Rect,
        scale: f64,
    ) -> Result<RenderTargetSize, RenderError> {
        ValidatedPageRenderTarget::new(self.page_render_mode, viewport, scale)
            .map(ValidatedPageRenderTarget::size)
    }

    /// Select the density for a subsequent logical resize render. Callers must
    /// preflight the complete new viewport and restore on a rejected commit.
    pub fn configure_render_target(
        &mut self,
        viewport: Rect,
        scale: f64,
    ) -> Result<RenderTargetSize, RenderError> {
        let target = self.validate_render_target(viewport, scale)?;
        self.render_scale = scale;
        Ok(target)
    }

    /// Repaint the accepted layout at a different physical density. No View
    /// expression, component hook, module or AppService callback is executed.
    /// Failed allocation/validation retains both accepted settings and pixels.
    pub fn set_render_scale(&mut self, scale: f64) -> Result<(), RenderError> {
        self.set_render_scale_with_commit(scale, Self::commit_retained_page_frame)
    }

    /// Repaint the accepted layout, including when an earlier staging request
    /// already selected this scale. The accepted physical target, rather than
    /// pending configuration, determines whether pixels need to be replaced.
    /// This strict target path leaves legacy `set_render_scale` semantics alone.
    pub fn repaint_accepted_layout(&mut self, scale: f64) -> Result<(), RenderError> {
        self.repaint_accepted_layout_with_commit(scale, Self::commit_retained_page_frame)
    }

    fn repaint_accepted_layout_with_commit(
        &mut self,
        scale: f64,
        commit: impl FnOnce(&mut Self, RenderFrame) -> Result<(), RenderError>,
    ) -> Result<(), RenderError> {
        let frame = self
            .last_frame()
            .ok_or(RenderError::Unsupported("accepted-page-frame-missing"))?;
        let target = self.validate_render_target(frame.viewport, scale)?;
        // An unchanged accepted density is settings-only, even if staging
        // temporarily selected another scale. Rounded pixel collisions still
        // accept a new numeric policy and need their own page revision.
        if self.accepted_render_target == Some(target) && self.accepted_render_scale == Some(scale)
        {
            self.render_scale = scale;
            return Ok(());
        }
        let frame = frame.clone();
        let previous = self.render_scale;
        self.render_scale = scale;
        if let Err(error) = commit(self, frame) {
            self.render_scale = previous;
            return Err(error);
        }
        Ok(())
    }

    fn set_render_scale_with_commit(
        &mut self,
        scale: f64,
        commit: impl FnOnce(&mut Self, RenderFrame) -> Result<(), RenderError>,
    ) -> Result<(), RenderError> {
        if scale == self.render_scale {
            return Ok(());
        }
        let viewport = self
            .last_frame()
            .map(|frame| frame.viewport)
            .unwrap_or(Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            });
        self.validate_render_target(viewport, scale)?;
        let previous = self.render_scale;
        self.render_scale = scale;
        if let Some(frame) = self.last_frame().cloned() {
            if let Err(error) = commit(self, frame) {
                self.render_scale = previous;
                return Err(error);
            }
        }
        Ok(())
    }

    /// Submit one complete Canvas 2D batch and return the resulting surface
    /// snapshot.  The regular page frame remains the renderer's primary
    /// snapshot; canvas surfaces are addressable by id through
    /// [`Self::canvas_snapshot`].
    pub fn commit_canvas(&mut self, frame: CanvasFrame) -> Result<RenderSnapshot, RenderError> {
        self.canvas.commit(frame)
    }

    /// Read the last independent Canvas bitmap without changing the page.
    pub fn canvas_snapshot(&self, canvas_id: &str) -> Option<RenderSnapshot> {
        self.canvas.snapshot(canvas_id)
    }

    pub fn canvas_ids(&self) -> impl Iterator<Item = &str> {
        self.canvas.ids()
    }

    /// Whether the last commit owns a Skia raster surface. This is useful to
    /// host probes and diagnostics because `backend_name()` describes the
    /// build, while this method describes the current renderer state.
    pub fn has_native_surface(&self) -> bool {
        if self.page_render_mode != PageRenderMode::Raster {
            return false;
        }
        #[cfg(feature = "skia-backend")]
        {
            self.native_surface.is_some()
        }
        #[cfg(not(feature = "skia-backend"))]
        {
            false
        }
    }

    /// Whether the committed frame reached a host-owned GPU context.
    ///
    /// `skia-backend` currently provides a Skia CPU raster surface for
    /// portable readback.  A real GPU context must be attached by the
    /// platform host before this can become true; deliberately returning
    /// `false` here keeps feature compilation from being mistaken for GPU
    /// validation.
    pub fn has_gpu_surface(&self) -> bool {
        if self.page_render_mode == PageRenderMode::ExternalFrame {
            return false;
        }
        #[cfg(all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        ))]
        {
            self.metal_surface_attached
        }
        #[cfg(not(all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        )))]
        #[cfg(feature = "skia-gpu-gles")]
        {
            self.gl_surface_attached
        }
        #[cfg(all(
            not(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            )),
            not(feature = "skia-gpu-gles")
        ))]
        {
            false
        }
    }

    /// Attach the current host OpenGL ES context to a Ganesh renderer.
    ///
    /// `Interface::new_native` resolves symbols from the current process and
    /// therefore works with an EGL context that is already current on the
    /// calling thread. The context is retained by the renderer and remains
    /// thread-affine, matching the Java/Android surface owner.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn attach_gles_context(&mut self) -> Result<(), RenderError> {
        let interface = skia::gpu::gl::Interface::new_native()
            .ok_or(RenderError::Unsupported("skia-gpu-gles-interface"))?;
        self.attach_gl_interface(interface)
    }

    /// Attach a host-owned desktop GL or GLES context using its explicit symbol
    /// resolver. The callback is used synchronously and is never retained. GL
    /// functions and the current context remain valid through detach/abandon.
    /// This avoids implicit platform loader selection (WGL versus EGL/GLX).
    #[cfg(feature = "skia-gpu-gles")]
    pub fn attach_gl_context_with(
        &mut self,
        mut resolver: impl FnMut(&str) -> *const std::ffi::c_void,
    ) -> Result<(), RenderError> {
        let interface = skia::gpu::gl::Interface::new_load_with(|name| {
            // Skia probes optional EGL functions too. GLX/WGL loaders may
            // return non-null stubs for foreign API names, which crash when
            // called. This GL resolver is independent of the window-system
            // API; attach_gles_context retains the native EGL loader path.
            if name.starts_with("gl") {
                resolver(name)
            } else {
                std::ptr::null()
            }
        })
        .ok_or(RenderError::Unsupported("skia-gpu-gl-interface"))?;
        self.attach_gl_interface(interface)
    }

    #[cfg(feature = "skia-gpu-gles")]
    fn attach_gl_interface(
        &mut self,
        interface: skia::gpu::gl::Interface,
    ) -> Result<(), RenderError> {
        if !interface.validate() {
            return Err(RenderError::Unsupported("skia-gpu-gles-interface"));
        }
        let context = skia::gpu::direct_contexts::make_gl(interface, None)
            .ok_or(RenderError::Unsupported("skia-gpu-gles-context"))?;
        self.gl_context = Some(context);
        self.gl_surface_attached = false;
        Ok(())
    }

    /// Detach a host-owned OpenGL ES context before the EGL context is
    /// destroyed. This keeps Skia from retaining handles into a dead context.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn detach_gles_context(&mut self) {
        self.gl_surface_attached = false;
        self.gl_context = None;
    }

    /// Forget a lost or unusable host context without issuing GL calls.
    /// Normal teardown must use `detach_gles_context` while that context is
    /// current; failed window acquisition may leave no bindable EGL surface.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn abandon_gles_context(&mut self) {
        self.gl_surface_attached = false;
        if let Some(mut context) = self.gl_context.take() {
            context.abandon();
        }
    }

    /// Return whether a Ganesh GL context is currently attached. This is a
    /// diagnostic distinction from `has_gpu_surface`, which requires a frame
    /// to have reached a host framebuffer.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn has_gles_context(&self) -> bool {
        self.gl_context.is_some()
    }

    /// Render the most recently committed frame directly into the currently
    /// bound OpenGL ES framebuffer. The host owns the EGL swap; this method
    /// only records and submits Skia commands to the current context.
    ///
    /// `framebuffer` is the name returned by `GL_FRAMEBUFFER_BINDING` and must
    /// belong to the current EGL window surface. `width` and `height` are the
    /// physical drawable dimensions.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn render_last_frame_to_gles_framebuffer(
        &mut self,
        framebuffer: u32,
        width: u32,
        height: u32,
    ) -> Result<(), RenderError> {
        if self.page_render_mode == PageRenderMode::ExternalFrame {
            return Err(RenderError::Unsupported("external-frame-gpu-owner"));
        }
        if width == 0 || height == 0 {
            return Err(RenderError::InvalidViewport);
        }
        if width > i32::MAX as u32 || height > i32::MAX as u32 {
            return Err(RenderError::InvalidViewport);
        }
        let frame = self
            .software_fallback
            .last_frame
            .as_ref()
            .ok_or(RenderError::Unsupported("skia-gpu-gles-frame"))?;
        let context = self
            .gl_context
            .as_mut()
            .ok_or(RenderError::Unsupported("skia-gpu-gles-context"))?;
        let info = skia::gpu::gl::FramebufferInfo {
            fboid: framebuffer,
            format: skia::gpu::gl::Format::RGBA8.into(),
            ..Default::default()
        };
        let target =
            skia::gpu::backend_render_targets::make_gl((width as i32, height as i32), 0, 0, info);
        let mut surface = skia::gpu::surfaces::wrap_backend_render_target(
            context,
            &target,
            skia::gpu::SurfaceOrigin::BottomLeft,
            skia::ColorType::RGBA8888,
            None,
            None,
        )
        .ok_or(RenderError::Unsupported("skia-gpu-gles-surface"))?;
        Self::draw_frame_to_target_with_images(
            surface.canvas(),
            frame,
            width,
            height,
            &mut self.canvas.native_fonts,
            &self.native_images,
        )?;
        context.flush_and_submit();
        drop(surface);
        self.gl_surface_attached = true;
        Ok(())
    }

    /// Attach a host-owned Metal device and command queue to this renderer.
    ///
    /// The handles are Objective-C objects supplied by the platform adapter;
    /// Skia retains them while the Ganesh context is alive.  A context alone
    /// does not make [`Self::has_gpu_surface`] true: a real drawable texture
    /// must be submitted through [`Self::render_last_frame_to_metal_texture`]
    /// first.  This split keeps device/context probes from being mistaken for
    /// runtime surface ownership.
    ///
    /// # Safety
    ///
    /// `device` and `queue` must be valid retained Objective-C MTLDevice and
    /// MTLCommandQueue objects and remain valid while this renderer uses the
    /// context. They must belong to the same Metal device.
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub unsafe fn attach_metal_context(
        &mut self,
        device: *const c_void,
        queue: *const c_void,
    ) -> Result<(), RenderError> {
        if device.is_null() || queue.is_null() {
            return Err(RenderError::Unsupported("skia-gpu-metal-context"));
        }
        let device_id = unsafe { metal_target::context_device(device, queue)? };
        let backend = skia::gpu::mtl::BackendContext::new(
            device as skia::gpu::mtl::Handle,
            queue as skia::gpu::mtl::Handle,
        );
        let context = skia::gpu::direct_contexts::make_metal(&backend, None)
            .ok_or(RenderError::Unsupported("skia-gpu-metal-context"))?;
        self.metal_device_id = Some(device_id);
        self.metal_backend = Some(backend);
        self.metal_context = Some(context);
        self.metal_surface_attached = false;
        Ok(())
    }

    /// Detach the host-owned Metal context and forget the last drawable
    /// attachment. The host must stop presenting drawables before calling
    /// this method, so Skia never retains a stale layer texture.
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub fn detach_metal_context(&mut self) {
        self.metal_surface_attached = false;
        self.metal_context = None;
        self.metal_backend = None;
        self.metal_device_id = None;
    }

    /// Return whether a Metal context is attached, independently of whether a
    /// drawable has been rendered. This is intentionally not exposed as a GPU
    /// surface capability; callers should use [`Self::has_gpu_surface`].
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub fn has_metal_context(&self) -> bool {
        self.metal_context.is_some()
    }

    /// Draw the most recently committed frame directly to one host-owned
    /// Metal texture, either a drawable or an offscreen render target.
    ///
    /// Skia records drawing and flushes its command queue before returning.
    /// The host retains the texture until GPU completion. For an offscreen
    /// consumer, submit a completion barrier on the same queue and publish
    /// the immutable texture only after it completes. Returning from this
    /// method is submission evidence, not evidence of GPU completion.
    ///
    /// # Safety
    ///
    /// `texture` must be a live, retained, non-framebuffer-only 2D BGRA8Unorm
    /// MTLTexture with render-target usage and sample count one, created on
    /// the attached device. Width and height must match its physical size.
    /// It may belong to a CAMetalDrawable or an IOSurface/CVPixelBuffer.
    /// The host must retain it through GPU completion and prevent concurrent
    /// writes or consumption while this queue is still rendering.
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub unsafe fn render_last_frame_to_metal_texture(
        &mut self,
        texture: *const c_void,
        width: u32,
        height: u32,
    ) -> Result<(), RenderError> {
        if self.page_render_mode == PageRenderMode::ExternalFrame {
            return Err(RenderError::Unsupported("external-frame-gpu-owner"));
        }
        if texture.is_null() || width == 0 || height == 0 {
            return Err(RenderError::Unsupported("skia-gpu-metal-texture"));
        }
        if width > i32::MAX as u32 || height > i32::MAX as u32 {
            return Err(RenderError::InvalidViewport);
        }
        let frame = self
            .software_fallback
            .last_frame
            .as_ref()
            .ok_or(RenderError::Unsupported("skia-gpu-metal-frame"))?;
        let context = self
            .metal_context
            .as_mut()
            .ok_or(RenderError::Unsupported("skia-gpu-metal-context"))?;
        let device_id = self
            .metal_device_id
            .ok_or(RenderError::Unsupported("skia-gpu-metal-context"))?;
        unsafe { metal_target::validate(texture, width, height, device_id)? };
        let texture_info = skia::gpu::mtl::TextureInfo::new(texture as skia::gpu::mtl::Handle);
        let target = skia::gpu::backend_render_targets::make_mtl(
            (width as i32, height as i32),
            &texture_info,
        );
        let mut surface = skia::gpu::surfaces::wrap_backend_render_target(
            context,
            &target,
            skia::gpu::SurfaceOrigin::TopLeft,
            skia::ColorType::BGRA8888,
            None,
            None,
        )
        .ok_or(RenderError::Unsupported("skia-gpu-metal-surface"))?;
        Self::draw_frame_to_target_with_images(
            surface.canvas(),
            frame,
            width,
            height,
            &mut self.canvas.native_fonts,
            &self.native_images,
        )?;
        context.flush_and_submit();
        drop(surface);
        self.metal_surface_attached = true;
        Ok(())
    }

    /// Map the committed logical viewport onto the host's physical target.
    /// Both GPU adapters use this drawing path; raster tests exercise its
    /// pixel geometry without claiming that a GPU or drawable was present.
    #[cfg(feature = "skia-backend")]
    fn draw_frame_to_target_with_images(
        canvas: &skia::Canvas,
        frame: &RenderFrame,
        width: u32,
        height: u32,
        fonts: &mut NativeFonts,
        images: &BTreeMap<String, images::NativeImage>,
    ) -> Result<(), RenderError> {
        if width == 0 || height == 0 || width > i32::MAX as u32 || height > i32::MAX as u32 {
            return Err(RenderError::InvalidViewport);
        }
        viewport_surface_layout(frame.viewport, i32::MAX as u32)?;
        // A committed empty viewport has no content, even if the host keeps a
        // nonempty drawable during minimization or a resize transition.
        if frame.viewport.width == 0.0 || frame.viewport.height == 0.0 {
            canvas.clear(skia::Color::TRANSPARENT);
            return Ok(());
        }
        let (_, physical_bytes) = rgba_buffer_layout(width, height)?;
        compositing::layer_depth(&frame.root, physical_bytes)?;
        let scale_x = (f64::from(width) / f64::from(frame.viewport.width)) as f32;
        let scale_y = (f64::from(height) / f64::from(frame.viewport.height)) as f32;
        if !scale_x.is_finite() || !scale_y.is_finite() {
            return Err(RenderError::InvalidViewport);
        }
        canvas.clear(skia::Color::TRANSPARENT);
        canvas.save();
        canvas.scale((scale_x, scale_y));
        Self::draw_frame(canvas, frame, fonts, images);
        canvas.restore();
        Ok(())
    }

    #[cfg(all(test, feature = "skia-backend"))]
    fn draw_frame_to_target(
        canvas: &skia::Canvas,
        frame: &RenderFrame,
        width: u32,
        height: u32,
        fonts: &mut NativeFonts,
    ) -> Result<(), RenderError> {
        images::validate(frame)?;
        let images = images::prepare_native(&frame.images, &BTreeMap::new())?;
        Self::draw_frame_to_target_with_images(canvas, frame, width, height, fonts, &images)
    }

    #[cfg(feature = "skia-backend")]
    fn draw_frame(
        canvas: &skia::Canvas,
        frame: &RenderFrame,
        fonts: &mut NativeFonts,
        images: &BTreeMap<String, images::NativeImage>,
    ) {
        let plan = paint::PaintPlan::new_validated(&frame.root);
        let mut groups = Vec::new();
        for command in &plan.commands {
            let entry = &plan.nodes[command.node];
            match command.op {
                paint::Op::Begin => groups.push(
                    (entry.paint_active && entry.node.opacity < 1.0)
                        .then(|| compositing::save_native_layer(canvas, entry.node.opacity)),
                ),
                paint::Op::End => {
                    if let Some(save_count) = groups.pop().flatten() {
                        canvas.restore_to_count(save_count);
                    }
                }
                phase => {
                    if entry.paint_active && entry.transform.inverse().is_some() {
                        Self::draw_phase(
                            canvas,
                            entry.node,
                            entry.foreground,
                            entry.transform,
                            plan.clips(command.node),
                            fonts,
                            images,
                            phase,
                        );
                    }
                }
            }
        }
    }

    #[cfg(feature = "skia-backend")]
    #[allow(clippy::too_many_arguments)]
    fn draw_phase(
        canvas: &skia::Canvas,
        node: &RenderNode,
        foreground: Color,
        transform: Transform2D,
        clips: impl Iterator<Item = WorldOverflowClip>,
        fonts: &mut NativeFonts,
        images: &BTreeMap<String, images::NativeImage>,
        phase: paint::Op,
    ) {
        let style = node.style.unwrap_or_default();
        let effective_opacity = 1.0;
        let matrix = |transform: Transform2D| {
            skia::Matrix::new_all(
                transform.a,
                transform.c,
                transform.e,
                transform.b,
                transform.d,
                transform.f,
                0.0,
                0.0,
                1.0,
            )
        };
        // Each node paints from the host target's unchanged canvas baseline.
        // World-space clip metadata makes overflow resettable at fixed boxes,
        // while retaining a GPU target's scale and the original paint order.
        canvas.save();
        let target_matrix = canvas.local_to_device();
        for ancestor in clips {
            canvas.set_matrix(&target_matrix);
            canvas.concat(&matrix(ancestor.transform));
            Self::clip_descendants(canvas, ancestor.clip);
        }
        canvas.set_matrix(&target_matrix);
        canvas.concat(&matrix(transform));
        if phase == paint::Op::Background {
            if let Some(color) = node.background {
                let alpha = f32::from(color.alpha) * effective_opacity;
                let paint_color = skia::Color4f::from(skia::Color::from_argb(
                    alpha.clamp(0.0, 255.0).round() as u8,
                    color.red,
                    color.green,
                    color.blue,
                ));
                let mut paint = skia::Paint::new(paint_color, None);
                paint.set_anti_alias(true);
                let rect = skia::Rect::from_xywh(
                    node.bounds.x,
                    node.bounds.y,
                    node.bounds.width,
                    node.bounds.height,
                );
                let radii = normalized_corner_radii(
                    node.bounds,
                    node.style.unwrap_or_default().border_radius,
                );
                if radii.iter().any(|radius| radius.x > 0.0 && radius.y > 0.0) {
                    let skia_radii = radii.map(|radius| skia::Vector::new(radius.x, radius.y));
                    let rrect = skia::RRect::new_rect_radii(rect, &skia_radii);
                    canvas.draw_rrect(rrect, &paint);
                } else {
                    canvas.draw_rect(rect, &paint);
                }
            }
            Self::draw_border(canvas, node, effective_opacity);
        } else {
            if let Some(resource) = node
                .image
                .as_ref()
                .and_then(|image| images.get(&image.resource))
            {
                images::draw_native(canvas, node, resource, effective_opacity);
            }
            // Text layout and painting consume the same accepted glyph positions.
            // New WXML text may overflow its line box (including line-height:0);
            // ancestor overflow clips, rather than the glyph's own box, constrain
            // its ink. Legacy absolute frames retain their previous own-box clip.
            if let Some(text) = node.text.as_deref() {
                let color = foreground;
                let content = style.content_box(node.bounds);
                let text_style = node.text_style.unwrap_or_default();
                let legacy = node.text_style.is_none() && node.text_layout.is_none();
                if !text.is_empty()
                    && text_style.font_size > 0.0
                    && (!legacy || (content.width > 0.0 && content.height > 0.0))
                {
                    let alpha = (f32::from(color.alpha) * effective_opacity).clamp(0.0, 255.0);
                    let paint_color = skia::Color::from_argb(
                        alpha.round() as u8,
                        color.red,
                        color.green,
                        color.blue,
                    );
                    let paint = skia::Paint::new(skia::Color4f::from(paint_color), None);
                    canvas.save();
                    if legacy {
                        let clip = skia::Rect::from_xywh(
                            content.x,
                            content.y,
                            content.width,
                            content.height,
                        );
                        canvas.clip_rect(clip, skia::ClipOp::Intersect, false);
                        native_raster::draw_native_text(
                            canvas,
                            text,
                            (content.x, content.y + 16.0),
                            16.0,
                            fonts,
                            &paint,
                        );
                    } else {
                        let measured;
                        let plan = if let Some(plan) = &node.text_layout {
                            plan
                        } else {
                            measured = layout_text(
                                text,
                                text_style,
                                Some(content.width),
                                &mut NativeTextMeasurer(&mut *fonts),
                            );
                            &measured
                        };
                        Self::draw_positioned_text(
                            canvas,
                            plan,
                            (content.x, content.y),
                            text_style.font_size,
                            fonts,
                            &paint,
                        );
                    }
                    canvas.restore();
                }
            }
        }
        canvas.restore();
    }

    #[cfg(feature = "skia-backend")]
    fn draw_border(canvas: &skia::Canvas, node: &RenderNode, opacity: f32) {
        let style = node.style.unwrap_or_default();
        let geometry = BorderGeometry::new(node.bounds, style);
        if !geometry.has_border() || node.bounds.width <= 0.0 || node.bounds.height <= 0.0 {
            return;
        }
        let rounded = |bounds: Rect, radii: [CornerRadius; 4]| {
            skia::RRect::new_rect_radii(
                skia::Rect::from_xywh(bounds.x, bounds.y, bounds.width, bounds.height),
                &radii.map(|radius| skia::Vector::new(radius.x, radius.y)),
            )
        };
        canvas.save();
        canvas.clip_rrect(
            rounded(geometry.outer, geometry.outer_radii),
            skia::ClipOp::Intersect,
            false,
        );
        if geometry.inner.width > 0.0 && geometry.inner.height > 0.0 {
            canvas.clip_rrect(
                rounded(geometry.inner, geometry.inner_radii),
                skia::ClipOp::Difference,
                false,
            );
        }
        for (index, side) in style.border.into_iter().enumerate() {
            if side.used_width() <= 0.0 || side.color.alpha == 0 {
                continue;
            }
            let points = geometry.side_polygon(index);
            if points.len() < 3 {
                continue;
            }
            let mut path = skia::PathBuilder::new();
            path.move_to(points[0]);
            for point in &points[1..] {
                path.line_to(*point);
            }
            path.close();
            let color = side.color;
            let alpha = (f32::from(color.alpha) * opacity).clamp(0.0, 255.0).round() as u8;
            let mut paint = skia::Paint::new(
                skia::Color4f::from(skia::Color::from_argb(
                    alpha,
                    color.red,
                    color.green,
                    color.blue,
                )),
                None,
            );
            // Each diagonal belongs to a single side. Antialiasing every
            // side polygon separately would blend different translucent colors
            // twice at their join. Curved outer/inner geometry is clipped.
            paint.set_anti_alias(false);
            canvas.draw_path(&path.detach(), &paint);
        }
        canvas.restore();
    }

    #[cfg(feature = "skia-backend")]
    fn clip_descendants(canvas: &skia::Canvas, clip: OverflowClip) {
        let bounds = clip.bounds;
        if clip.clip_x && clip.clip_y {
            let rect = skia::Rect::from_xywh(bounds.x, bounds.y, bounds.width, bounds.height);
            let radii = normalized_corner_radii(bounds, clip.radii);
            if radii.iter().any(|radius| radius.x > 0.0 && radius.y > 0.0) {
                let radii = radii.map(|radius| skia::Vector::new(radius.x, radius.y));
                canvas.clip_rrect(
                    skia::RRect::new_rect_radii(rect, &radii),
                    skia::ClipOp::Intersect,
                    false,
                );
            } else {
                canvas.clip_rect(rect, skia::ClipOp::Intersect, false);
            }
        } else if let Some(current) = canvas.local_clip_bounds() {
            // A one-axis overflow clip is an unbounded local-space stripe.
            // The current canvas clip gives conservative finite limits on
            // the other axis, including ancestor rotations and nested clips.
            let left = if clip.clip_x { bounds.x } else { current.left };
            let right = if clip.clip_x {
                bounds.x + bounds.width
            } else {
                current.right
            };
            let top = if clip.clip_y { bounds.y } else { current.top };
            let bottom = if clip.clip_y {
                bounds.y + bounds.height
            } else {
                current.bottom
            };
            canvas.clip_rect(
                skia::Rect::new(left, top, right, bottom),
                skia::ClipOp::Intersect,
                false,
            );
        }
    }

    #[cfg(feature = "skia-backend")]
    fn draw_positioned_text(
        canvas: &skia::Canvas,
        layout: &TextLayout,
        origin: (f32, f32),
        font_size: f32,
        fonts: &mut NativeFonts,
        paint: &skia::Paint,
    ) {
        for glyph in &layout.glyphs {
            if layout.flow.is_some() && text::zero_advance(glyph.character) {
                continue;
            }
            let mut encoded = [0; 4];
            let text: &str = glyph.character.encode_utf8(&mut encoded);
            let baseline = (origin.0 + glyph.x, origin.1 + glyph.baseline_y);
            if let Some(font) = fonts.for_character(glyph.character, font_size) {
                canvas.draw_str(text, baseline, &font, paint);
            } else {
                canvas.save();
                canvas.translate((baseline.0, baseline.1 - font_size));
                canvas.scale((font_size / 16.0, font_size / 16.0));
                native_raster::draw_fallback_text(canvas, text, (0.0, 0.0), paint);
                canvas.restore();
            }
        }
    }

    #[cfg(feature = "skia-backend")]
    fn render_native(
        frame: &RenderFrame,
        fonts: &mut NativeFonts,
        images: &BTreeMap<String, images::NativeImage>,
        target: RenderTargetSize,
    ) -> Result<skia::Surface, RenderError> {
        let (_, bytes) = rgba_buffer_layout(target.width, target.height)?;
        compositing::layer_depth(&frame.root, bytes)?;
        let size = (target.width.max(1) as i32, target.height.max(1) as i32);
        let mut surface = skia::surfaces::raster_n32_premul(size)
            .ok_or(RenderError::Unsupported("skia-raster-surface"))?;
        Self::draw_frame_to_target_with_images(
            surface.canvas(),
            frame,
            target.width.max(1),
            target.height.max(1),
            fonts,
            images,
        )?;
        Ok(surface)
    }

    #[cfg(feature = "skia-backend")]
    fn invalidate_gpu_presentation(&mut self) {
        #[cfg(all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        ))]
        {
            // The new frame needs its own drawable submission before the
            // host may report an attached Metal surface again.
            self.metal_surface_attached = false;
        }
        #[cfg(feature = "skia-gpu-gles")]
        {
            // EGL attachment evidence also belongs to the accepted frame.
            self.gl_surface_attached = false;
        }
    }
}

fn fallback_glyph(character: char) -> [u8; 7] {
    // The fallback deliberately covers the ASCII alphabet/digits commonly
    // used by fixtures. Unknown glyphs remain legible as a boxed marker.
    match character.to_ascii_uppercase() {
        'A' => [
            0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'E' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
        ],
        'R' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
        ],
        '0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        '1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        '2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        '3' => [
            0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        '4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        '5' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110,
        ],
        '6' => [
            0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        '7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        '8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        '9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b11100,
        ],
        _ => [
            0b11111, 0b10001, 0b10101, 0b10001, 0b10101, 0b10001, 0b11111,
        ],
    }
}

impl Default for SkiaRenderer {
    fn default() -> Self {
        Self::new()
    }
}

impl Renderer for SkiaRenderer {
    fn backend_name(&self) -> &'static str {
        if self.page_render_mode == PageRenderMode::ExternalFrame {
            return "external-frame-export";
        }
        #[cfg(all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        ))]
        if self.metal_surface_attached {
            return "skia-gpu-metal";
        }
        #[cfg(feature = "skia-gpu-gles")]
        if self.gl_surface_attached {
            return "skia-gpu-gles";
        }
        Self::configured_backend_name(self.page_render_mode)
    }

    fn commit(&mut self, frame: RenderFrame) -> Result<(), RenderError> {
        let accepted = self
            .prepare_page_frame(frame, PageFrameTargetPolicy::Legacy)?
            .accept();
        drop(accepted);
        Ok(())
    }

    fn last_frame(&self) -> Option<&RenderFrame> {
        self.software_fallback.last_frame()
    }

    fn has_gpu_surface(&self) -> bool {
        SkiaRenderer::has_gpu_surface(self)
    }
}

#[cfg(test)]
mod tests {
    #[cfg(feature = "skia-gpu-gles")]
    #[test]
    fn abandon_gles_renderer_is_safe_without_current_context() {
        // This deliberately creates no EGL/GL context. The cleanup path must
        // not require a current context, even before attachment succeeded.
        let mut renderer = super::SkiaRenderer::new();
        renderer.abandon_gles_context();
        renderer.abandon_gles_context();
        assert!(!renderer.has_gles_context());
        assert!(!super::Renderer::has_gpu_surface(&renderer));
    }
    use super::*;

    fn frame() -> RenderFrame {
        RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport: Rect {
                x: 0.0,
                y: 0.0,
                width: 320.0,
                height: 640.0,
            },
            root: RenderNode::new(
                "root",
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 320.0,
                    height: 640.0,
                },
            ),
        }
    }

    #[test]
    fn presentation_revision_advances_when_frame_id_is_reused_but_not_on_rejection() {
        let mut renderer = SkiaRenderer::new();
        let mut value = frame();
        value.viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 2.0,
            height: 1.0,
        };
        value.root.bounds = value.viewport;
        value.root.background = Some(Color::BLACK);
        assert_eq!(renderer.snapshot_revision(), 0);
        renderer.commit(value.clone()).unwrap();
        let first = renderer.snapshot().unwrap();
        assert_eq!(renderer.snapshot_revision(), 1);
        value.root.background = Some(Color::WHITE);
        renderer.commit(value.clone()).unwrap();
        assert_eq!(renderer.snapshot_revision(), 2);
        let second = renderer.snapshot().unwrap();
        assert_eq!(first.frame_id, second.frame_id);
        assert_ne!(first.pixels, second.pixels);
        value.root.opacity = -1.0;
        assert!(renderer.commit(value).is_err());
        assert_eq!(renderer.snapshot_revision(), 2);
        assert_eq!(renderer.snapshot_ref(), Some(&second));
        // The standalone deterministic renderer owns the same publication
        // counter used by native and frame-export presentations.
        let mut software = SoftwareRenderer::new();
        software.commit(frame()).unwrap();
        assert_eq!(software.snapshot_revision(), 1);
        software.commit(frame()).unwrap();
        assert_eq!(software.snapshot_revision(), 2);
    }

    #[test]
    fn accepted_target_is_published_only_with_a_successful_page_commit() {
        for mode in [PageRenderMode::Raster, PageRenderMode::ExternalFrame] {
            let mut renderer = SkiaRenderer::new();
            renderer.configure_page_render_mode(mode).unwrap();
            let mut value = frame();
            value.viewport.width = 2.25;
            value.viewport.height = 3.25;
            value.root.bounds = value.viewport;
            assert_eq!(renderer.accepted_render_target(), None);
            let target = renderer
                .configure_render_target(value.viewport, 1.0)
                .unwrap();
            assert_eq!(renderer.accepted_render_target(), None);
            renderer.commit(value.clone()).unwrap();
            let revision = renderer.snapshot_revision();
            assert_eq!(renderer.accepted_render_target(), Some(target));
            assert_eq!(
                target,
                RenderTargetSize {
                    width: 3,
                    height: 4
                }
            );
            // Staging a resize has no authority over the retained publication.
            let mut next = value.clone();
            next.viewport.width = 5.0;
            next.root.bounds = next.viewport;
            let staged = renderer
                .configure_render_target(next.viewport, 1.0)
                .unwrap();
            let mut invalid = next.clone();
            invalid.root.opacity = f32::NAN;
            assert!(renderer.commit(invalid).is_err());
            assert_eq!(renderer.accepted_render_target(), Some(target));
            assert_eq!(renderer.snapshot_revision(), revision);
            renderer.capture_snapshot().unwrap();
            renderer
                .commit_canvas(CanvasFrame {
                    frame_id: 100,
                    canvas_id: "unrelated".into(),
                    width: 1,
                    height: 1,
                    reserve: false,
                    commands: Vec::new(),
                })
                .unwrap();
            assert_eq!(renderer.accepted_render_target(), Some(target));
            assert_eq!(renderer.snapshot_revision(), revision);
            renderer.commit(next).unwrap();
            assert_eq!(renderer.accepted_render_target(), Some(staged));
            assert_eq!(renderer.snapshot_revision(), revision + 1);
        }
    }

    #[cfg(not(feature = "skia-backend"))]
    #[test]
    fn software_target_pin_preserves_existing_wide_viewport_support() {
        let mut renderer = SkiaRenderer::new();
        let mut value = frame();
        value.viewport.width = 4097.0;
        value.viewport.height = 1.0;
        value.root.bounds = value.viewport;
        renderer.commit(value.clone()).unwrap();
        let accepted = RenderTargetSize {
            width: 4097,
            height: 1,
        };
        assert_eq!(renderer.accepted_render_target(), Some(accepted));
        let snapshot = renderer.snapshot_ref().unwrap();
        assert_eq!((snapshot.width, snapshot.height), (4097, 1));
        let revision = renderer.snapshot_revision();
        // RenderTargetSize's density budget is not a new software commit
        // restriction. A rejected staging request cannot alter the old pin.
        assert!(renderer
            .configure_render_target(value.viewport, 1.0)
            .is_err());
        assert_eq!(renderer.accepted_render_target(), Some(accepted));
        assert_eq!(renderer.snapshot_revision(), revision);
        renderer.set_render_scale(1.0).unwrap();
        assert_eq!(renderer.accepted_render_target(), Some(accepted));
        assert_eq!(renderer.snapshot_revision(), revision);
    }

    #[test]
    fn render_target_size_is_independent_ceil_and_bounded() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 375.0,
            height: 667.0,
        };
        for scale in [1.0, 1.5, 2.0, 3.0, 4.0] {
            let target = RenderTargetSize::for_viewport(viewport, scale).unwrap();
            assert_eq!(target.width, (375.0_f64 * scale).ceil() as u32);
            assert_eq!(target.height, (667.0_f64 * scale).ceil() as u32);
        }
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                RenderTargetSize::for_viewport(viewport, scale),
                Err(RenderError::InvalidRenderTarget)
            );
        }
        assert_eq!(
            RenderTargetSize::for_viewport(viewport, 5.0),
            Err(RenderError::RenderTargetBudgetExceeded)
        );
        let too_wide = Rect {
            width: 4097.0,
            ..viewport
        };
        assert_eq!(
            RenderTargetSize::for_viewport(too_wide, 1.0),
            Err(RenderError::RenderTargetBudgetExceeded)
        );
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn density_rasterizes_physical_pixels_and_keeps_logical_frame_atomic() {
        let mut renderer = SkiaRenderer::new();
        let mut logical = frame();
        logical.viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        logical.root.bounds = Rect {
            x: 2.0,
            y: 2.0,
            width: 2.0,
            height: 2.0,
        };
        logical.root.background = Some(Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        });
        renderer.commit(logical.clone()).unwrap();
        for scale in [1.5, 2.0, 3.0, 4.0, 1.0] {
            let revision = renderer.snapshot_revision();
            renderer.set_render_scale(scale).unwrap();
            assert!(renderer.snapshot_revision() > revision);
            let target = RenderTargetSize::for_viewport(logical.viewport, scale).unwrap();
            let snapshot = renderer.snapshot_ref().unwrap();
            assert_eq!(
                (snapshot.width, snapshot.height),
                (target.width, target.height)
            );
            let x = (3.0 * scale) as usize;
            let offset = (x * snapshot.stride as usize) + x * 4;
            assert_eq!(&snapshot.pixels[offset..offset + 4], &[255, 0, 0, 255]);
            assert_eq!(&snapshot.pixels[0..4], &[0, 0, 0, 0]);
            assert_eq!(renderer.last_frame(), Some(&logical));
        }
        let accepted = renderer.snapshot().unwrap();
        let revision = renderer.snapshot_revision();
        assert!(renderer.set_render_scale(500.0).is_err());
        assert_eq!(renderer.snapshot_revision(), revision);
        assert_eq!(renderer.render_scale(), 1.0);
        assert_eq!(renderer.snapshot_ref(), Some(&accepted));
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_readback_reservation_initializes_pixels_and_reports_capacity_failure() {
        assert_eq!(
            native_raster::allocate_readback_pixels(17).unwrap(),
            vec![0; 17]
        );
        assert_eq!(
            native_raster::allocate_readback_pixels(usize::MAX),
            Err(RenderError::PixelBufferAllocationFailed)
        );
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn density_readback_allocation_failure_retains_target_and_recovers() {
        let mut renderer = SkiaRenderer::new();
        let logical = frame();
        renderer.commit(logical.clone()).unwrap();
        let accepted = renderer.snapshot().unwrap();
        let revision = renderer.snapshot_revision();
        let render_ms = renderer.last_render_ms();
        let accepted_target = renderer.accepted_render_target();
        let target = RenderTargetSize::for_viewport(logical.viewport, 2.0).unwrap();

        let error = renderer
            .set_render_scale_with_commit(2.0, |renderer, frame| {
                renderer.commit_native_frame(frame, |surface, frame_id, width, height| {
                    assert_eq!((width, height), (target.width, target.height));
                    native_raster::readback_native_with_allocator(
                        surface,
                        frame_id,
                        width,
                        height,
                        |byte_len| {
                            assert_eq!(byte_len, (width * height * 4) as usize);
                            // Deterministic capacity overflow exercises the real
                            // fallible reservation without exhausting process memory.
                            native_raster::allocate_readback_pixels(usize::MAX)
                        },
                    )
                })
            })
            .unwrap_err();
        assert_eq!(error, RenderError::PixelBufferAllocationFailed);
        assert_eq!(renderer.render_scale(), 1.0);
        assert_eq!(renderer.snapshot_revision(), revision);
        assert_eq!(renderer.last_render_ms(), render_ms);
        assert_eq!(renderer.accepted_render_target(), accepted_target);
        assert_eq!(renderer.last_frame(), Some(&logical));
        assert_eq!(renderer.snapshot_ref(), Some(&accepted));

        renderer.set_render_scale(2.0).unwrap();
        assert_eq!(renderer.render_scale(), 2.0);
        assert_eq!(renderer.snapshot_revision(), revision + 1);
        assert_eq!(renderer.accepted_render_target(), Some(target));
        assert_eq!(renderer.last_frame(), Some(&logical));
        let snapshot = renderer.snapshot_ref().unwrap();
        assert_eq!(
            (snapshot.width, snapshot.height),
            (target.width, target.height)
        );
    }

    #[cfg(not(feature = "skia-backend"))]
    #[test]
    fn software_density_repaints_full_resolution_and_preserves_logical_frame() {
        let mut renderer = SkiaRenderer::new();
        renderer.commit(frame()).unwrap();
        let old_revision = renderer.snapshot_revision();
        renderer.set_render_scale(2.0).unwrap();
        assert_eq!(renderer.render_scale(), 2.0);
        assert_eq!(renderer.snapshot_revision(), old_revision + 1);
        assert_eq!(renderer.last_frame().unwrap().viewport.width, 320.0);
        let snapshot = renderer.snapshot_ref().unwrap();
        assert_eq!((snapshot.width, snapshot.height), (640, 1280));
    }

    #[cfg(not(feature = "skia-backend"))]
    #[test]
    fn binary_metadata_keeps_layout_and_byte_ranges_without_serializing_pixels() {
        let frame = RenderFrame {
            frame_id: 1,
            viewport: Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            root: RenderNode::new(
                "root",
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
            ),
            images: [
                (
                    "a".into(),
                    Arc::new(ImageResource {
                        width: 1,
                        height: 1,
                        pixels: vec![1, 2, 3, 255],
                    }),
                ),
                (
                    "b".into(),
                    Arc::new(ImageResource {
                        width: 1,
                        height: 1,
                        pixels: vec![5, 6, 7, 128],
                    }),
                ),
            ]
            .into(),
        };
        let metadata: serde_json::Value =
            serde_json::from_slice(&frame.binary_metadata_json().unwrap()).unwrap();
        let full = serde_json::to_value(&frame).unwrap();
        assert_eq!(metadata["root"], full["root"]);
        assert_eq!(metadata["viewport"], full["viewport"]);
        assert_eq!(metadata["images"]["a"]["offset"], 0);
        assert_eq!(metadata["images"]["b"]["offset"], 4);
        assert_eq!(metadata["images"]["b"]["length"], 4);
        assert!(metadata["images"]["a"].get("pixels").is_none());
    }

    #[test]
    fn software_rasterizer_maps_logical_geometry_to_physical_pixels() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 2.0,
            height: 1.0,
        };
        let mut root = RenderNode::new("root", viewport);
        let mut child = RenderNode::new(
            "thin-edge",
            Rect {
                x: 1.0,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
        );
        child.background = Some(Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        });
        root.children.push(child);
        let frame = RenderFrame {
            frame_id: 1,
            viewport,
            root,
            images: BTreeMap::new(),
        };

        for scale in [1u32, 2, 3] {
            let physical = SoftwareRenderer::rasterize_at_size(
                &frame,
                viewport.width as u32 * scale,
                viewport.height as u32 * scale,
            )
            .unwrap();
            assert_eq!((physical.width, physical.height), (2 * scale, scale));

            let edge_x = (1.25 * scale as f32).floor() as usize;
            let offset = edge_x * 4;
            assert_eq!(&physical.pixels[offset..offset + 4], &[255, 0, 0, 255]);
            assert_eq!(&physical.pixels[0..4], &[0; 4]);
        }
    }

    #[test]
    fn commits_a_batch_frame() {
        let mut renderer = SkiaRenderer::new();
        renderer.commit(frame()).expect("valid frame");
        assert_eq!(renderer.last_frame().map(|frame| frame.frame_id), Some(1));
    }

    #[test]
    fn external_density_changes_only_target_and_preserves_logical_frame() {
        let mut renderer = SkiaRenderer::new_frame_export_only();
        let value = frame();
        renderer.commit(value.clone()).unwrap();
        let revision = renderer.snapshot_revision();
        renderer.set_render_scale(2.0).unwrap();
        assert_eq!(renderer.last_frame(), Some(&value));
        assert_eq!(renderer.render_scale(), 2.0);
        assert_eq!(renderer.snapshot_revision(), revision + 1);
        assert!(renderer.snapshot_ref().is_none());
        assert!(!renderer.has_native_surface());
        assert!(!renderer.has_gpu_surface());
        assert!(renderer.set_render_scale(100.0).is_err());
        assert_eq!(renderer.render_scale(), 2.0);
        assert_eq!(renderer.snapshot_revision(), revision + 1);
    }

    #[test]
    fn accepted_layout_repaint_compares_the_pin_after_density_was_staged() {
        let mut renderer = SkiaRenderer::new_frame_export_only();
        let value = frame();
        renderer.commit(value.clone()).unwrap();
        let revision = renderer.snapshot_revision();
        let target = renderer
            .configure_render_target(value.viewport, 2.0)
            .unwrap();
        assert_ne!(renderer.accepted_render_target(), Some(target));
        renderer.repaint_accepted_layout(2.0).unwrap();
        assert_eq!(renderer.snapshot_revision(), revision + 1);
        assert_eq!(renderer.accepted_render_target(), Some(target));
        assert_eq!(renderer.last_frame(), Some(&value));
        assert!(renderer.snapshot_ref().is_none());
        renderer.repaint_accepted_layout(2.0).unwrap();
        assert_eq!(renderer.snapshot_revision(), revision + 1);
        // Cancelling staged density back to the accepted target only changes
        // configuration; no extra commit, readback or page revision is needed.
        renderer
            .configure_render_target(value.viewport, 3.0)
            .unwrap();
        renderer.repaint_accepted_layout(2.0).unwrap();
        assert_eq!(renderer.render_scale(), 2.0);
        assert_eq!(renderer.snapshot_revision(), revision + 1);
    }

    #[test]
    fn accepted_layout_repaint_rejection_keeps_staged_config_and_publication() {
        let mut renderer = SkiaRenderer::new_frame_export_only();
        assert_eq!(
            renderer.repaint_accepted_layout(2.0),
            Err(RenderError::Unsupported("accepted-page-frame-missing"))
        );
        let value = frame();
        renderer.commit(value.clone()).unwrap();
        let revision = renderer.snapshot_revision();
        let accepted = renderer.accepted_render_target();
        renderer
            .configure_render_target(value.viewport, 3.0)
            .unwrap();
        let error = renderer
            .repaint_accepted_layout_with_commit(2.0, |renderer, mut frame| {
                frame.root.opacity = f32::NAN;
                renderer.commit(frame)
            })
            .unwrap_err();
        assert_eq!(error, RenderError::InvalidOpacity);
        assert_eq!(renderer.render_scale(), 3.0);
        assert_eq!(renderer.snapshot_revision(), revision);
        assert_eq!(renderer.accepted_render_target(), accepted);
        assert_eq!(renderer.last_frame(), Some(&value));
        assert!(renderer.repaint_accepted_layout(f64::NAN).is_err());
        assert_eq!(renderer.render_scale(), 3.0);
        assert_eq!(renderer.snapshot_revision(), revision);
        renderer.repaint_accepted_layout(2.0).unwrap();
        assert_eq!(renderer.render_scale(), 2.0);
        assert_eq!(renderer.snapshot_revision(), revision + 1);
    }

    #[test]
    fn accepted_layout_repaint_revisions_numeric_density_when_targets_collide() {
        let mut renderer = SkiaRenderer::new_frame_export_only();
        let mut value = frame();
        value.viewport.width = 1.0;
        value.viewport.height = 1.0;
        value.root.bounds = value.viewport;
        let accepted = renderer
            .configure_render_target(value.viewport, 1.5)
            .unwrap();
        renderer.commit(value.clone()).unwrap();
        let revision = renderer.snapshot_revision();
        let staged = renderer
            .configure_render_target(value.viewport, 2.0)
            .unwrap();
        assert_eq!(accepted, staged);
        renderer.repaint_accepted_layout(2.0).unwrap();
        assert_eq!(renderer.render_scale(), 2.0);
        assert_eq!(renderer.snapshot_revision(), revision + 1);
        assert_eq!(renderer.accepted_render_scale(), Some(2.0));
        assert_eq!(renderer.accepted_render_target(), Some(accepted));
        assert_eq!(renderer.last_frame(), Some(&value));
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn colliding_numeric_densities_draw_identical_native_pixels() {
        let mut value = frame();
        value.viewport.width = 1.0;
        value.viewport.height = 1.0;
        value.root = RenderNode::new(
            "fractional",
            Rect {
                x: 0.125,
                y: 0.125,
                width: 0.5,
                height: 0.5,
            },
        );
        value.root.background = Some(Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        });
        let mut snapshots = Vec::new();
        for scale in [1.5, 2.0] {
            // Independent renderers force both paths through real native paint;
            // equality cannot come from the retained-repaint no-op itself.
            let mut renderer = SkiaRenderer::new();
            renderer
                .configure_render_target(value.viewport, scale)
                .unwrap();
            renderer.commit(value.clone()).unwrap();
            let snapshot = renderer.snapshot_ref().unwrap().clone();
            assert_eq!((snapshot.width, snapshot.height), (2, 2));
            assert!(snapshot.pixels.chunks(4).any(|pixel| pixel[3] != 0));
            assert!(snapshot.pixels.chunks(4).any(|pixel| pixel[3] != 255));
            snapshots.push(snapshot);
        }
        assert_eq!(snapshots[0].pixels, snapshots[1].pixels);
    }

    #[test]
    fn presentation_owner_cannot_change_after_a_page_was_accepted() {
        let mut renderer = SkiaRenderer::new();
        renderer.commit(frame()).unwrap();
        let pixels = renderer.snapshot();
        let revision = renderer.snapshot_revision();
        assert!(renderer
            .configure_page_render_mode(PageRenderMode::ExternalFrame)
            .is_err());
        assert_eq!(renderer.page_render_mode(), PageRenderMode::Raster);
        assert_eq!(renderer.snapshot(), pixels);
        assert_eq!(renderer.snapshot_revision(), revision);
    }

    #[cfg(not(any(
        feature = "skia-gpu-gles",
        all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        )
    )))]
    #[test]
    fn native_gpu_requires_a_compiled_gpu_backend() {
        assert!(matches!(
            SkiaRenderer::new_native_gpu(),
            Err(RenderError::Unsupported("native-gpu-backend-not-compiled"))
        ));
    }

    #[cfg(any(
        feature = "skia-gpu-gles",
        all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        )
    ))]
    #[test]
    fn gpu_commit_prepares_images_without_a_page_raster_or_readback() {
        let mut renderer = SkiaRenderer::new_native_gpu().unwrap();
        let mut value = frame();
        value.viewport.width = 2.0;
        value.viewport.height = 2.0;
        value.root.bounds = value.viewport;
        value.root.background = Some(Color::WHITE);
        value.images.insert(
            "sample".into(),
            std::sync::Arc::new(ImageResource {
                width: 1,
                height: 1,
                pixels: vec![255, 255, 255, 255],
            }),
        );
        value.root.image = Some(RenderImage {
            resource: "sample".into(),
            mode: ImageMode::ScaleToFill,
        });
        renderer.commit(value.clone()).unwrap();
        assert_eq!(renderer.native_images.len(), 1);
        assert!(renderer.native_surface.is_none());
        assert!(renderer.native_snapshot.is_none());
        assert!(renderer.snapshot().is_none());
        assert!(renderer.software_fallback.last_snapshot.is_none());
        assert_eq!(renderer.backend_name(), "skia-gpu-pending");
        assert!(!renderer.has_gpu_surface());
        let revision = renderer.snapshot_revision();
        // Diagnostics are explicit and preserve the accepted/presented state.
        let accepted_target = renderer.accepted_render_target();
        renderer
            .configure_render_target(value.viewport, 3.0)
            .unwrap();
        let snapshot = renderer.capture_snapshot().unwrap().unwrap();
        assert_eq!((snapshot.width, snapshot.height), (2, 2));
        assert_eq!(snapshot.pixels, [255; 16]);
        assert_eq!(renderer.accepted_render_target(), accepted_target);
        assert!(renderer.native_surface.is_none());
        assert!(!renderer.has_gpu_surface());
        assert_eq!(renderer.snapshot_revision(), revision);
        // Rejected commits preserve both the prepared frame and diagnostics.
        let mut invalid = value.clone();
        invalid.root.opacity = f32::NAN;
        assert!(renderer.commit(invalid).is_err());
        assert_eq!(renderer.snapshot(), Some(snapshot));
        assert_eq!(renderer.last_frame(), Some(&value));
        assert_eq!(renderer.accepted_render_target(), accepted_target);
        renderer
            .configure_render_target(value.viewport, 1.0)
            .unwrap();
        renderer.set_render_scale(2.0).unwrap();
        assert!(renderer.snapshot().is_none());
        assert_eq!(renderer.last_frame(), Some(&value));
        let snapshot = renderer.capture_snapshot().unwrap().unwrap();
        assert_eq!((snapshot.width, snapshot.height), (4, 4));
        assert_eq!(snapshot.pixels, [255; 64]);
    }

    #[test]
    fn external_frame_commits_export_ir_without_allocating_a_page_surface() {
        let mut renderer = SkiaRenderer::new_frame_export_only();
        let mut submitted = frame();
        submitted.viewport.width = 1.0;
        submitted.viewport.height = 1.0;
        submitted.root.bounds = submitted.viewport;
        submitted.root.background = Some(Color {
            red: 12,
            green: 34,
            blue: 56,
            alpha: 255,
        });
        renderer.commit(submitted.clone()).unwrap();
        assert_eq!(renderer.last_frame(), Some(&submitted));
        assert_eq!(renderer.backend_name(), "external-frame-export");
        assert!(!renderer.has_native_surface());
        assert!(!renderer.has_gpu_surface());
        assert!(renderer.software_fallback.last_snapshot.is_none());
        #[cfg(feature = "skia-backend")]
        {
            assert!(renderer.native_surface.is_none());
            assert!(renderer.native_snapshot.is_none());
        }

        // Readback is explicitly requested software diagnostics; it neither
        // caches a page bitmap nor changes the backend/surface claim.
        let diagnostic = renderer.snapshot().unwrap();
        assert_eq!(diagnostic.pixels, [12, 34, 56, 255]);
        assert!(renderer.software_fallback.last_snapshot.is_none());
        assert_eq!(renderer.backend_name(), "external-frame-export");
        assert!(!renderer.has_gpu_surface());

        let mut invalid = submitted.clone();
        invalid.frame_id = 2;
        invalid.root.opacity = f32::NAN;
        assert!(renderer.commit(invalid).is_err());
        assert_eq!(renderer.last_frame(), Some(&submitted));
        assert!(renderer.software_fallback.last_snapshot.is_none());

        submitted.frame_id = 3;
        submitted.root.background = Some(Color::WHITE);
        renderer.commit(submitted.clone()).unwrap();
        assert_eq!(renderer.last_frame(), Some(&submitted));
        assert!(renderer.software_fallback.last_snapshot.is_none());
    }

    #[test]
    fn viewport_preflight_rejects_invalid_coordinates_and_dimensions() {
        let valid = Rect {
            x: -2.0,
            y: 4.0,
            width: 0.0,
            height: 0.0,
        };
        assert_eq!(SkiaRenderer::validate_viewport(valid), Ok(()));
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            for viewport in [
                Rect {
                    x: invalid,
                    ..valid
                },
                Rect {
                    y: invalid,
                    ..valid
                },
                Rect {
                    width: invalid,
                    ..valid
                },
                Rect {
                    height: invalid,
                    ..valid
                },
            ] {
                assert_eq!(
                    SkiaRenderer::validate_viewport(viewport),
                    Err(RenderError::InvalidViewport)
                );
            }
        }
        for viewport in [
            Rect {
                width: -0.1,
                ..valid
            },
            Rect {
                height: -0.1,
                ..valid
            },
        ] {
            assert_eq!(
                SkiaRenderer::validate_viewport(viewport),
                Err(RenderError::InvalidViewport)
            );
        }
    }

    #[test]
    fn viewport_preflight_checks_ceil_limits_before_integer_casts() {
        for max_dimension in [u32::MAX, i32::MAX as u32] {
            let rounded_up = max_dimension as f32;
            let mut viewport = Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: rounded_up,
            };
            assert!(matches!(
                viewport_surface_layout(viewport, max_dimension),
                Err(RenderError::InvalidViewport)
            ));
            viewport.height = f32::from_bits(rounded_up.to_bits() - 1);
            assert!(viewport_surface_layout(viewport, max_dimension).is_ok());
        }
        let max_dimension = if cfg!(feature = "skia-backend") {
            i32::MAX as u32
        } else {
            u32::MAX
        };
        assert_eq!(
            SkiaRenderer::validate_viewport(Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: max_dimension as f32,
            }),
            Err(RenderError::InvalidViewport)
        );
    }

    #[test]
    fn viewport_preflight_checks_rgba_stride_and_vector_capacity_without_allocating() {
        assert_eq!(
            SkiaRenderer::validate_viewport(Rect {
                x: 0.0,
                y: 0.0,
                width: (1_u32 << 30) as f32,
                height: 0.0,
            }),
            Err(RenderError::PixelBufferOverflow)
        );
        // This product exceeds Vec's isize capacity on 64-bit targets and
        // checked usize multiplication on 32-bit targets.
        assert_eq!(
            rgba_buffer_layout(u32::MAX / 4, u32::MAX),
            Err(RenderError::PixelBufferOverflow)
        );
    }

    #[test]
    fn viewport_preflight_matches_committed_snapshot_and_preserves_it_on_error() {
        let mut renderer = SkiaRenderer::new();
        let mut value = frame();
        value.viewport.width = 1.25;
        value.viewport.height = 2.25;
        SkiaRenderer::validate_viewport(value.viewport).expect("allocation-free preflight");
        renderer.commit(value.clone()).expect("small valid frame");
        let snapshot = renderer.snapshot().expect("snapshot");
        assert_eq!(
            (snapshot.width, snapshot.height, snapshot.stride),
            (2, 3, 8)
        );
        value.frame_id = 2;
        value.viewport.width = (1_u32 << 30) as f32;
        assert_eq!(
            renderer.commit(value),
            Err(RenderError::PixelBufferOverflow)
        );
        assert_eq!(renderer.last_frame().map(|frame| frame.frame_id), Some(1));
        assert_eq!(renderer.snapshot(), Some(snapshot));
    }

    fn canvas_test_frame(frame_id: u64, commands: &[(&str, Value)]) -> CanvasFrame {
        CanvasFrame {
            frame_id,
            canvas_id: "main".into(),
            width: 2,
            height: 1,
            reserve: false,
            commands: commands
                .iter()
                .map(|(op, args)| CanvasCommand {
                    op: (*op).into(),
                    args: args.as_array().unwrap().clone(),
                })
                .collect(),
        }
    }

    fn canvas_arc_frame(frame_id: u64, start: f64, end: f64, anticlockwise: bool) -> CanvasFrame {
        let mut frame = canvas_test_frame(
            frame_id,
            &[
                ("setFillStyle", serde_json::json!(["red"])),
                ("beginPath", serde_json::json!([])),
                (
                    "arc",
                    serde_json::json!([4, 4, 3, start, end, anticlockwise]),
                ),
                ("fill", serde_json::json!([])),
            ],
        );
        frame.width = 8;
        frame.height = 8;
        frame
    }

    #[test]
    fn software_arc_pixels_keep_full_half_and_zero_sweeps() {
        let tau = std::f64::consts::TAU;
        let pi = std::f64::consts::PI;
        for (start, end, anticlockwise, half) in [
            (0.0, tau, false, 0),
            (0.0, -tau, true, 0),
            (-f64::MAX, f64::MAX, false, 0),
            (f64::MAX, -f64::MAX, true, 0),
            (0.0, pi, false, 1),
            (0.0, -pi, true, -1),
        ] {
            let snapshot =
                rasterize_canvas(&canvas_arc_frame(1, start, end, anticlockwise)).unwrap();
            // Exact deterministic software golden: a radius-three disk at
            // (4,4), optionally cut along its horizontal diameter.
            for y in 0..8_usize {
                for x in 0..8_usize {
                    let dx = x as f32 + 0.5 - 4.0;
                    let dy = y as f32 + 0.5 - 4.0;
                    let inside = dx * dx + dy * dy < 9.0
                        && (half == 0 || (half > 0 && y >= 4) || (half < 0 && y < 4));
                    let index = (y * 8 + x) * 4;
                    assert_eq!(
                        &snapshot.pixels[index..index + 4],
                        if inside {
                            &[255, 0, 0, 255]
                        } else {
                            &[0, 0, 0, 0]
                        },
                        "pixel ({x},{y}), arc {start}->{end}, anticlockwise={anticlockwise}"
                    );
                }
            }
        }
        for (start, end, anticlockwise) in [
            (0.0, -tau, false),
            (0.0, tau, true),
            (0.0, -4.0 * tau, false),
            (0.0, 4.0 * tau, true),
            (f64::MAX, f64::MAX, false),
            (-0.0, 0.0, true),
        ] {
            let snapshot =
                rasterize_canvas(&canvas_arc_frame(1, start, end, anticlockwise)).unwrap();
            assert!(snapshot.pixels.iter().all(|byte| *byte == 0));
        }
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_arc_pixels_keep_direction_and_finish_for_extreme_finite_angles() {
        let pi = std::f64::consts::PI;
        let tau = std::f64::consts::TAU;
        let mut renderer = SkiaRenderer::new();
        for (start, end, anticlockwise) in [
            (0.0, pi, false),
            (0.0, -pi, true),
            (-f64::MAX, f64::MAX, false),
            (f64::MAX, -f64::MAX, true),
            (f64::MAX, -f64::MAX, false),
            (-f64::MAX, f64::MAX, true),
            (1e100, -1e100, false),
            (-1e100, 1e100, true),
        ] {
            canvas_work_probes::reset();
            let snapshot = renderer
                .commit_canvas(canvas_arc_frame(8, start, end, anticlockwise))
                .unwrap();
            assert_eq!(
                (snapshot.width, snapshot.height, snapshot.stride),
                (8, 8, 32)
            );
            assert_eq!(snapshot.pixels.len(), 8 * 8 * 4);
            assert_eq!(&snapshot.pixels[0..4], &[0, 0, 0, 0]);
            if start == 0.0 {
                let upper = (2 * 8 + 4) * 4;
                let lower = (5 * 8 + 4) * 4;
                assert_eq!(
                    &snapshot.pixels[upper..upper + 4],
                    if anticlockwise {
                        &[255, 0, 0, 255]
                    } else {
                        &[0, 0, 0, 0]
                    }
                );
                assert_eq!(
                    &snapshot.pixels[lower..lower + 4],
                    if anticlockwise {
                        &[0, 0, 0, 0]
                    } else {
                        &[255, 0, 0, 255]
                    }
                );
            }
            assert_eq!(
                canvas_work_probes::counts(),
                canvas_work_probes::Counts {
                    software_rasters: 0,
                    native_surfaces: 1,
                    native_readbacks: 1,
                }
            );
        }
        for (start, end, anticlockwise) in [
            (0.0, -tau, false),
            (0.0, tau, true),
            (f64::MAX, f64::MAX, false),
            (-0.0, 0.0, true),
        ] {
            let snapshot = renderer
                .commit_canvas(canvas_arc_frame(9, start, end, anticlockwise))
                .unwrap();
            assert!(snapshot.pixels.iter().all(|byte| *byte == 0));
        }
    }

    #[test]
    fn invalid_canvas_batch_never_enters_backend_or_replaces_accepted_state() {
        let mut renderer = SkiaRenderer::new();
        let accepted = canvas_test_frame(
            1,
            &[
                ("setFillStyle", serde_json::json!(["red"])),
                ("fillRect", serde_json::json!([0, 0, 1, 1])),
            ],
        );
        let snapshot = renderer.commit_canvas(accepted.clone()).unwrap();
        let mut rejected = canvas_test_frame(
            2,
            &[
                ("fillRect", serde_json::json!([1, 0, 1, 1])),
                // Even normalized extreme arcs must not enter painting when
                // a later command invalidates the complete batch.
                ("arc", serde_json::json!([0, 0, 1, f64::MAX, -f64::MAX])),
                ("lineTo", serde_json::json!([1, "invalid"])),
            ],
        );
        rejected.reserve = true;
        canvas_work_probes::reset();
        assert_eq!(
            renderer.canvas.commit_with_backend(rejected, |_, _| {
                panic!("a malformed batch must not enter the selected backend")
            }),
            Err(RenderError::InvalidCanvas(
                "canvas command lineTo argument 1 must be finite".into()
            ))
        );
        assert_eq!(canvas_work_probes::counts(), Default::default());
        assert_eq!(
            renderer.canvas.commands.get("main"),
            Some(&accepted.commands)
        );
        assert_eq!(renderer.canvas_snapshot("main"), Some(snapshot));
    }

    #[test]
    fn canvas_backend_failure_preserves_history_for_reserved_and_replacement_batches() {
        let mut renderer = SkiaRenderer::new();
        let accepted = canvas_test_frame(
            1,
            &[
                ("setFillStyle", serde_json::json!(["red"])),
                ("fillRect", serde_json::json!([0, 0, 1, 1])),
            ],
        );
        let snapshot = renderer.commit_canvas(accepted.clone()).unwrap();
        for reserve in [true, false] {
            let mut rejected = canvas_test_frame(
                2,
                &[
                    ("setFillStyle", serde_json::json!(["blue"])),
                    ("fillRect", serde_json::json!([1, 0, 1, 1])),
                ],
            );
            rejected.reserve = reserve;
            canvas_work_probes::reset();
            assert_eq!(
                renderer.canvas.commit_with_backend(rejected, |_, batch| {
                    assert_eq!(
                        batch
                            .commands
                            .iter()
                            .filter(|command| !matches!(command, PreparedCanvasCommand::ResetState))
                            .count(),
                        if reserve { 4 } else { 2 }
                    );
                    assert_eq!(
                        batch
                            .commands
                            .iter()
                            .filter(|command| matches!(command, PreparedCanvasCommand::ResetState))
                            .count(),
                        usize::from(reserve)
                    );
                    // Model a selected backend/readback failure after complete
                    // preparation, without claiming a hardware fault was run.
                    Err(RenderError::Unsupported("injected-canvas-readback"))
                }),
                Err(RenderError::Unsupported("injected-canvas-readback"))
            );
            assert_eq!(canvas_work_probes::counts(), Default::default());
            assert_eq!(
                renderer.canvas.commands.get("main"),
                Some(&accepted.commands)
            );
            assert_eq!(renderer.canvas_snapshot("main"), Some(snapshot.clone()));
        }

        // A failed blue style must not leak into the next retained history.
        let mut reserved = canvas_test_frame(3, &[("fillRect", serde_json::json!([1, 0, 1, 1]))]);
        reserved.reserve = true;
        let snapshot = renderer.commit_canvas(reserved).unwrap();
        assert_eq!(snapshot.pixels, [255, 0, 0, 255, 0, 0, 0, 255]);
        assert_eq!(renderer.canvas.commands["main"].len(), 3);

        let replacement = canvas_test_frame(
            4,
            &[
                ("setFillStyle", serde_json::json!(["#00ff00"])),
                ("fillRect", serde_json::json!([0, 0, 1, 1])),
            ],
        );
        let snapshot = renderer.commit_canvas(replacement.clone()).unwrap();
        assert_eq!(snapshot.pixels, [0, 255, 0, 255, 0, 0, 0, 0]);
        assert_eq!(
            renderer.canvas.commands.get("main"),
            Some(&replacement.commands)
        );
    }

    #[test]
    fn canvas_id_error_precedes_surface_and_command_errors() {
        let mut renderer = SkiaRenderer::new();
        let mut rejected = canvas_test_frame(1, &[("lineTo", serde_json::json!(["invalid"]))]);
        rejected.canvas_id = " \t".into();
        rejected.width = u32::MAX;
        canvas_work_probes::reset();
        assert_eq!(
            renderer.commit_canvas(rejected),
            Err(RenderError::InvalidCanvas("canvasId is required".into()))
        );
        assert_eq!(canvas_work_probes::counts(), Default::default());
        assert_eq!(renderer.canvas_ids().count(), 0);
        assert!(renderer.canvas.commands.is_empty());
    }

    #[cfg(not(feature = "skia-backend"))]
    #[test]
    fn software_canvas_commit_executes_one_raster_pass() {
        let mut renderer = SkiaRenderer::new();
        let frame = canvas_test_frame(7, &[("fillRect", serde_json::json!([0, 0, 1, 1]))]);
        canvas_work_probes::reset();
        let snapshot = renderer.commit_canvas(frame).unwrap();
        assert_eq!(snapshot.pixels, [0, 0, 0, 255, 0, 0, 0, 0]);
        assert_eq!(
            canvas_work_probes::counts(),
            canvas_work_probes::Counts {
                software_rasters: 1,
                native_surfaces: 0,
                native_readbacks: 0,
            }
        );
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_canvas_commit_skips_software_raster_and_reads_back_once() {
        let mut renderer = SkiaRenderer::new();
        let frame = canvas_test_frame(7, &[("fillRect", serde_json::json!([0, 0, 1, 1]))]);
        canvas_work_probes::reset();
        let snapshot = renderer.commit_canvas(frame).unwrap();
        assert_eq!((snapshot.frame_id, snapshot.stride), (7, 8));
        assert_eq!(snapshot.pixels, [0, 0, 0, 255, 0, 0, 0, 0]);
        assert_eq!(
            canvas_work_probes::counts(),
            canvas_work_probes::Counts {
                software_rasters: 0,
                native_surfaces: 1,
                native_readbacks: 1,
            }
        );
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_invalid_canvas_styles_do_not_allocate_or_touch_fonts() {
        for (op, args, message) in [
            (
                "setLineDash",
                serde_json::json!([[1, -1]]),
                "canvas command setLineDash argument 1 must be finite and non-negative",
            ),
            (
                "setTextAlign",
                serde_json::json!(["invalid"]),
                "unsupported textAlign value invalid",
            ),
            (
                "setTextBaseline",
                serde_json::json!(["invalid"]),
                "unsupported textBaseline value invalid",
            ),
        ] {
            let mut renderer = SkiaRenderer::new();
            let accepted = canvas_test_frame(1, &[("fillRect", serde_json::json!([0, 0, 1, 1]))]);
            let snapshot = renderer.commit_canvas(accepted.clone()).unwrap();
            let mut rejected = canvas_test_frame(
                2,
                &[("fillText", serde_json::json!(["A", 0, 1])), (op, args)],
            );
            rejected.reserve = true;
            let fonts = renderer.native_font_info();
            assert!(renderer.canvas.native_fonts.fallback.is_empty());
            canvas_work_probes::reset();
            assert_eq!(
                renderer.commit_canvas(rejected),
                Err(RenderError::InvalidCanvas(message.into()))
            );
            assert_eq!(canvas_work_probes::counts(), Default::default());
            assert_eq!(renderer.native_font_info(), fonts);
            assert!(renderer.canvas.native_fonts.fallback.is_empty());
            assert_eq!(
                renderer.canvas.commands.get("main"),
                Some(&accepted.commands)
            );
            assert_eq!(renderer.canvas_snapshot("main"), Some(snapshot));
        }
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn shared_canvas_error_precedes_native_style_execution() {
        let mut renderer = SkiaRenderer::new();
        let rejected = canvas_test_frame(
            1,
            &[
                ("setLineDash", serde_json::json!([[1, 1]])),
                ("fillRect", serde_json::json!([0, 0, "invalid", 1])),
            ],
        );
        canvas_work_probes::reset();
        assert_eq!(
            renderer.commit_canvas(rejected),
            Err(RenderError::InvalidCanvas(
                "canvas command fillRect argument 2 must be finite".into()
            ))
        );
        assert_eq!(canvas_work_probes::counts(), Default::default());
        assert_eq!(renderer.canvas_ids().count(), 0);
        assert!(renderer.canvas.commands.is_empty());
    }

    #[test]
    fn canvas_batch_replays_into_an_addressable_surface() {
        let payload = serde_json::json!({
            "canvasId": "main",
            "width": 2,
            "height": 1,
            "commands": [
                {"op": "setFillStyle", "args": ["#ff0000"]},
                {"op": "fillRect", "args": [0, 0, 1, 1]}
            ]
        });
        let object = payload.as_object().expect("canvas payload object");
        let mut renderer = SkiaRenderer::new();
        let first = renderer
            .commit_canvas(CanvasFrame::from_payload(object, 11, None).unwrap())
            .expect("canvas batch commits");
        assert_eq!((first.frame_id, first.width, first.height), (11, 2, 1));
        assert_eq!(&first.pixels, &[255, 0, 0, 255, 0, 0, 0, 0]);
        assert_eq!(renderer.canvas_snapshot("main"), Some(first));

        let payload = serde_json::json!({
            "canvasId": "main",
            "width": 2,
            "height": 1,
            "reserve": true,
            "commands": [
                {"op": "setFillStyle", "args": ["rgba(0, 0, 255, 0.5)"]},
                {"op": "fillRect", "args": [1, 0, 1, 1]}
            ]
        });
        let second = renderer
            .commit_canvas(
                CanvasFrame::from_payload(payload.as_object().unwrap(), 12, None).unwrap(),
            )
            .expect("reserved canvas batch commits");
        assert_eq!(&second.pixels, &[255, 0, 0, 255, 0, 0, 128, 128]);

        let payload = serde_json::json!({
            "canvasId": "main",
            "width": 2,
            "height": 1,
            "commands": [{"op": "clearRect", "args": [0, 0, 2, 1]}]
        });
        let third = renderer
            .commit_canvas(
                CanvasFrame::from_payload(payload.as_object().unwrap(), 13, None).unwrap(),
            )
            .expect("non-reserved batch replaces history");
        assert_eq!(&third.pixels, &[0, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn canvas_rejects_known_but_unimplemented_commands_explicitly() {
        let payload = serde_json::json!({
            "canvasId": "main",
            "commands": [{"op": "drawImage", "args": ["asset.png", 0, 0]}]
        });
        let error = CanvasFrame::from_payload(payload.as_object().unwrap(), 1, None).unwrap_err();
        assert!(matches!(error, RenderError::UnsupportedCanvasCommand(op) if op == "drawImage"));
    }

    #[test]
    fn canvas_text_alignment_and_baseline_are_replayed() {
        let payload = serde_json::json!({
            "canvasId": "text",
            "width": 32,
            "height": 24,
            "commands": [
                {"op": "setFillStyle", "args": ["#ffffff"]},
                {"op": "setFontSize", "args": [8]},
                {"op": "setTextAlign", "args": ["center"]},
                {"op": "setTextBaseline", "args": ["top"]},
                {"op": "fillText", "args": ["A", 16, 0]}
            ]
        });
        let frame = CanvasFrame::from_payload(payload.as_object().unwrap(), 21, None)
            .expect("text commands are valid");
        let snapshot = rasterize_canvas(&frame).expect("text commands replay");
        assert!(snapshot
            .pixels
            .windows(4)
            .any(|pixel| pixel == [255, 255, 255, 255]));

        let invalid = serde_json::json!({
            "canvasId": "text",
            "commands": [{"op": "setTextAlign", "args": ["diagonal"]}]
        });
        let invalid_frame = CanvasFrame::from_payload(invalid.as_object().unwrap(), 22, None)
            .expect("alignment validation happens during replay");
        assert!(matches!(
            rasterize_canvas(&invalid_frame),
            Err(RenderError::InvalidCanvas(message)) if message.contains("textAlign")
        ));
    }

    #[test]
    fn canvas_stroke_style_commands_are_replayed_and_saved() {
        let payload = serde_json::json!({
            "canvasId": "stroke-style",
            "width": 16,
            "height": 8,
            "commands": [
                {"op": "setStrokeStyle", "args": ["#ffffff"]},
                {"op": "setLineWidth", "args": [2]},
                {"op": "setLineCap", "args": ["butt"]},
                {"op": "setLineJoin", "args": ["bevel"]},
                {"op": "setMiterLimit", "args": [4]},
                {"op": "beginPath", "args": []},
                {"op": "moveTo", "args": [2, 4]},
                {"op": "lineTo", "args": [14, 4]},
                {"op": "stroke", "args": []},
                {"op": "save", "args": []},
                {"op": "setLineCap", "args": ["round"]},
                {"op": "restore", "args": []},
                {"op": "beginPath", "args": []},
                {"op": "moveTo", "args": [2, 6]},
                {"op": "lineTo", "args": [14, 6]},
                {"op": "stroke", "args": []}
            ]
        });
        let mut renderer = SkiaRenderer::new();
        let snapshot = renderer
            .commit_canvas(
                CanvasFrame::from_payload(payload.as_object().unwrap(), 22, None).unwrap(),
            )
            .expect("line cap/join/miter commands are supported");
        assert!(snapshot.pixels.iter().any(|value| *value != 0));
    }

    #[test]
    fn canvas_line_dash_replays_even_and_odd_patterns_with_offset() {
        let payload = serde_json::json!({
            "canvasId": "dash",
            "width": 12,
            "height": 3,
            "commands": [
                {"op": "setStrokeStyle", "args": ["#ffffff"]},
                {"op": "setLineWidth", "args": [1]},
                {"op": "setLineDash", "args": [[2, 2]]},
                {"op": "beginPath", "args": []},
                {"op": "moveTo", "args": [0, 1]},
                {"op": "lineTo", "args": [12, 1]},
                {"op": "stroke", "args": []}
            ]
        });
        let frame = CanvasFrame::from_payload(payload.as_object().unwrap(), 31, None)
            .expect("dash commands are valid");
        let snapshot = rasterize_canvas(&frame).expect("dash commands replay");
        let pixel = |x: usize| &snapshot.pixels[(x * 4)..(x * 4 + 4)];
        assert_eq!(pixel(0), &[255, 255, 255, 255]);
        assert_eq!(pixel(1), &[255, 255, 255, 255]);
        assert_eq!(pixel(2), &[0, 0, 0, 0]);
        assert_eq!(pixel(3), &[0, 0, 0, 0]);
        assert_eq!(pixel(4), &[255, 255, 255, 255]);

        let odd = serde_json::json!({
            "canvasId": "dash-odd",
            "width": 8,
            "height": 3,
            "commands": [
                {"op": "setStrokeStyle", "args": ["#ffffff"]},
                {"op": "setLineDash", "args": [[2, 1, 1], 1]},
                {"op": "beginPath", "args": []},
                {"op": "moveTo", "args": [0, 1]},
                {"op": "lineTo", "args": [8, 1]},
                {"op": "stroke", "args": []}
            ]
        });
        let odd_frame = CanvasFrame::from_payload(odd.as_object().unwrap(), 32, None)
            .expect("odd dash commands are valid");
        let odd_snapshot = rasterize_canvas(&odd_frame).expect("odd dash pattern replays");
        // [2,1,1] repeats as [2,1,1,2,1,1], and offset 1 starts one unit
        // into the first dash. The remaining dash segments cover these
        // pixel centers.
        let drawn = (0..8)
            .filter(|x| odd_snapshot.pixels[x * 4 + 3] != 0)
            .collect::<Vec<_>>();
        assert_eq!(drawn, vec![0, 2, 5, 7]);
    }

    #[test]
    fn software_canvas_tiny_dashes_and_extreme_segments_use_surface_bounded_work() {
        for cap in ["butt", "round", "square"] {
            let payload = serde_json::json!({
                "canvasId": "tiny-dash",
                "width": 8,
                "height": 4,
                "commands": [
                    {"op": "setLineWidth", "args": [2]},
                    {"op": "setLineCap", "args": [cap]},
                    {"op": "setLineDash", "args": [[0, 1e-6]]},
                    {"op": "beginPath", "args": []},
                    {"op": "moveTo", "args": [0, 2]},
                    {"op": "lineTo", "args": [f32::MAX, 2]},
                    {"op": "stroke", "args": []}
                ]
            });
            let frame = CanvasFrame::from_payload(payload.as_object().unwrap(), 1, None).unwrap();
            let snapshot = rasterize_canvas(&frame).unwrap();
            for x in 0..8 {
                assert_eq!(
                    snapshot.pixels[(8 + x) * 4 + 3],
                    if cap == "butt" { 0 } else { 255 },
                    "zero-length on intervals must preserve {cap} cap semantics"
                );
                assert_eq!(snapshot.pixels[x * 4 + 3], 0);
            }
        }
    }

    #[test]
    fn rejects_invalid_opacity() {
        let mut renderer = SoftwareRenderer::new();
        let mut value = frame();
        value.root.opacity = 2.0;
        assert_eq!(renderer.commit(value), Err(RenderError::InvalidOpacity));
    }

    #[test]
    fn commits_a_portable_rgba_snapshot_with_child_source_over() {
        let mut renderer = SoftwareRenderer::new();
        let mut value = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 7,
            viewport: Rect {
                x: 0.0,
                y: 0.0,
                width: 2.0,
                height: 1.0,
            },
            root: RenderNode::new(
                "root",
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 2.0,
                    height: 1.0,
                },
            ),
        };
        value.root.background = Some(Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        });
        let mut child = RenderNode::new(
            "child",
            Rect {
                x: 1.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
        );
        child.background = Some(Color {
            red: 0,
            green: 0,
            blue: 255,
            alpha: 128,
        });
        value.root.children.push(child);
        renderer.commit(value).unwrap();
        let snapshot = renderer.snapshot().unwrap();
        assert_eq!(
            (snapshot.frame_id, snapshot.width, snapshot.height),
            (7, 2, 1)
        );
        assert_eq!(snapshot.stride, 8);
        assert_eq!(snapshot.format, "rgba8-premultiplied");
        assert_eq!(&snapshot.pixels[0..4], &[255, 0, 0, 255]);
        assert_eq!(&snapshot.pixels[4..8], &[127, 0, 128, 255]);

        let mut translucent = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 8,
            viewport: Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            root: RenderNode::new(
                "transparent",
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
            ),
        };
        translucent.root.background = Some(Color {
            red: 0,
            green: 255,
            blue: 0,
            alpha: 128,
        });
        renderer.commit(translucent).unwrap();
        assert_eq!(&renderer.snapshot().unwrap().pixels, &[0, 128, 0, 128]);
    }

    #[test]
    fn snapshot_keeps_translucent_pixels_premultiplied() {
        let mut renderer = SoftwareRenderer::new();
        let mut value = frame();
        value.viewport.width = 1.0;
        value.viewport.height = 1.0;
        value.root.bounds.width = 1.0;
        value.root.bounds.height = 1.0;
        value.root.background = Some(Color {
            red: 200,
            green: 100,
            blue: 50,
            alpha: 128,
        });
        renderer.commit(value).unwrap();
        let snapshot = renderer.snapshot().unwrap();
        assert_eq!(&snapshot.pixels, &[100, 50, 25, 128]);
    }

    #[test]
    fn descendant_fill_is_composited_inside_parent_opacity_group() {
        let mut renderer = SoftwareRenderer::new();
        let mut value = frame();
        value.viewport.width = 1.0;
        value.viewport.height = 1.0;
        value.root.bounds.width = 1.0;
        value.root.bounds.height = 1.0;
        value.root.opacity = 0.5;
        let mut child = RenderNode::new(
            "child",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
        );
        child.background = Some(Color {
            red: 0,
            green: 0,
            blue: 255,
            alpha: 255,
        });
        value.root.children.push(child);

        renderer.commit(value).unwrap();
        // The isolated subtree contributes a premultiplied blue channel and
        // alpha of 128 after its parent's opacity is applied exactly once.
        assert_eq!(&renderer.snapshot().unwrap().pixels, &[0, 0, 128, 128]);
    }

    #[test]
    fn sibling_z_order_matches_software_native_pixels_and_hit_target() {
        let mut value = frame();
        value.viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 4.0,
            height: 4.0,
        };
        value.root.bounds = value.viewport;
        value.root.background = None;
        value.root.opacity = 1.0;
        let mut red = RenderNode::new("red", value.viewport);
        red.background = Some(Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        });
        let mut blue = RenderNode::new("blue", value.viewport);
        blue.background = Some(Color {
            red: 0,
            green: 0,
            blue: 255,
            alpha: 255,
        });
        value.root.children = vec![red, blue];
        // A higher earlier sibling must paint last, while ties retain source
        // order and negative values remain below nonnegative siblings.
        for (red_z, blue_z, target, rgba) in [
            (9, 0, "red", [255, 0, 0, 255]),
            (0, 0, "blue", [0, 0, 255, 255]),
            (-1, 0, "blue", [0, 0, 255, 255]),
            (0, -1, "red", [255, 0, 0, 255]),
            (9, 10, "blue", [0, 0, 255, 255]),
        ] {
            value.root.children[0].z_index = red_z;
            value.root.children[1].z_index = blue_z;
            assert_eq!(value.root.hit_test(1.0, 1.0).unwrap().id, target);
            let mut software = SoftwareRenderer::new();
            software.commit(value.clone()).unwrap();
            assert_eq!(&software.snapshot().unwrap().pixels[0..4], &rgba);
            // This exercises Skia readback when skia-backend is enabled and
            // its documented software fallback otherwise.
            let mut renderer = SkiaRenderer::new();
            renderer.commit(value.clone()).unwrap();
            assert_eq!(&renderer.snapshot().unwrap().pixels[0..4], &rgba);
        }
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_background_opacity_matches_software_premultiplied_bytes() {
        let mut value = frame();
        value.viewport.width = 1.0;
        value.viewport.height = 1.0;
        value.root.bounds.width = 1.0;
        value.root.bounds.height = 1.0;
        value.root.background = None;
        value.root.opacity = 0.5;
        let mut child = RenderNode::new("fill", value.root.bounds);
        child.background = Some(Color {
            red: 0,
            green: 0,
            blue: 255,
            alpha: 255,
        });
        value.root.children = vec![child];
        let mut software = SoftwareRenderer::new();
        software.commit(value.clone()).unwrap();
        let mut native = SkiaRenderer::new();
        native.commit(value).unwrap();
        let expected = software.snapshot().unwrap().pixels;
        assert_eq!(expected, [0, 0, 128, 128]);
        assert_eq!(native.snapshot().unwrap().pixels, expected);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_skia_raster_surface_returns_real_rgba_readback() {
        let mut renderer = SkiaRenderer::new();
        let mut value = frame();
        value.frame_id = 42;
        value.viewport.width = 2.0;
        value.viewport.height = 1.0;
        value.root.bounds.width = 2.0;
        value.root.bounds.height = 1.0;
        value.root.background = Some(Color {
            red: 11,
            green: 22,
            blue: 33,
            alpha: 255,
        });
        renderer.commit(value).expect("Skia raster commit");
        assert_eq!(renderer.backend_name(), "skia-raster");
        assert!(renderer.has_native_surface());
        assert!(!renderer.has_gpu_surface());
        let snapshot = renderer.snapshot().expect("native readback");
        assert_eq!(
            (snapshot.frame_id, snapshot.width, snapshot.height),
            (42, 2, 1)
        );
        assert_eq!(snapshot.format, "rgba8-premultiplied");
        assert_eq!(snapshot.pixels, vec![11, 22, 33, 255, 11, 22, 33, 255]);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_publication_failure_retains_pixels_frame_and_attachment_flags() {
        let mut renderer = SkiaRenderer::new();
        let accepted = frame();
        renderer.commit(accepted.clone()).unwrap();
        let accepted_snapshot = renderer.snapshot().unwrap();
        // Seed only the internal frame-publication markers. This test creates
        // no GPU context or surface and establishes no GPU rendering evidence.
        #[cfg(all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        ))]
        {
            renderer.metal_surface_attached = true;
        }
        #[cfg(feature = "skia-gpu-gles")]
        {
            renderer.gl_surface_attached = true;
        }
        let mut candidate = accepted.clone();
        candidate.frame_id += 1;
        candidate.root.background = Some(Color::BLACK);
        let failure = RenderError::Unsupported("injected-native-preparation-failure");
        assert_eq!(
            renderer.commit_native_frame(candidate.clone(), |_, _, _, _| Err(failure.clone())),
            Err(failure)
        );
        assert_eq!(renderer.last_frame(), Some(&accepted));
        assert_eq!(renderer.snapshot(), Some(accepted_snapshot));
        assert!(renderer.native_surface.is_some());
        #[cfg(all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        ))]
        assert!(renderer.metal_surface_attached);
        #[cfg(feature = "skia-gpu-gles")]
        assert!(renderer.gl_surface_attached);

        renderer.commit(candidate.clone()).unwrap();
        assert_eq!(renderer.last_frame(), Some(&candidate));
        assert_eq!(renderer.snapshot().unwrap().frame_id, candidate.frame_id);
        #[cfg(all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        ))]
        assert!(!renderer.metal_surface_attached);
        #[cfg(feature = "skia-gpu-gles")]
        assert!(!renderer.gl_surface_attached);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_target_scaling_covers_all_physical_pixels_at_2x_3x_and_nonuniform_size() {
        let colors = [
            Color {
                red: 255,
                green: 0,
                blue: 0,
                alpha: 255,
            },
            Color {
                red: 0,
                green: 255,
                blue: 0,
                alpha: 255,
            },
            Color {
                red: 0,
                green: 0,
                blue: 255,
                alpha: 255,
            },
            Color {
                red: 255,
                green: 255,
                blue: 0,
                alpha: 255,
            },
        ];
        // The final case also prevents the old GLES max(1) denominator from
        // silently clipping a valid fractional logical viewport.
        for (logical_width, logical_height, width, height) in [
            (8.0, 6.0, 16, 12),
            (8.0, 6.0, 24, 18),
            (8.0, 6.0, 24, 12),
            (0.5, 0.75, 8, 12),
        ] {
            let mut value = frame();
            value.viewport.width = logical_width;
            value.viewport.height = logical_height;
            value.root.bounds = value.viewport;
            for (index, color) in colors.iter().enumerate() {
                let mut child = RenderNode::new(
                    format!("quadrant-{index}"),
                    Rect {
                        x: (index % 2) as f32 * logical_width / 2.0,
                        y: (index / 2) as f32 * logical_height / 2.0,
                        width: logical_width / 2.0,
                        height: logical_height / 2.0,
                    },
                );
                child.background = Some(*color);
                value.root.children.push(child);
            }
            let mut surface =
                skia::surfaces::raster_n32_premul((width as i32, height as i32)).unwrap();
            SkiaRenderer::draw_frame_to_target(
                surface.canvas(),
                &value,
                width,
                height,
                &mut NativeFonts::new(),
            )
            .expect("shared GPU target drawing path on a CPU Skia surface");
            let snapshot = native_raster::readback_native(&mut surface, 1, width, height).unwrap();
            for y in 0..height {
                for x in 0..width {
                    let index = usize::from(x >= width / 2) + 2 * usize::from(y >= height / 2);
                    let expected = colors[index];
                    let offset = (y * snapshot.stride + x * 4) as usize;
                    assert_eq!(
                        &snapshot.pixels[offset..offset + 4],
                        &[expected.red, expected.green, expected.blue, expected.alpha],
                        "logical {logical_width}x{logical_height}, target {width}x{height}, pixel ({x},{y})"
                    );
                }
            }
            // Target drawing must restore the canvas transform. A subsequent
            // physical 1px mark must not inherit the page's density scaling.
            let mut paint = skia::Paint::default();
            paint.set_color(skia::Color::MAGENTA);
            surface
                .canvas()
                .draw_rect(skia::Rect::from_xywh(1.0, 1.0, 1.0, 1.0), &paint);
            let snapshot = native_raster::readback_native(&mut surface, 1, width, height).unwrap();
            let offset = (snapshot.stride + 4) as usize;
            assert_eq!(&snapshot.pixels[offset..offset + 4], &[255, 0, 255, 255]);
        }
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_target_scaling_clears_empty_logical_viewports_without_drawing_content() {
        let mut value = frame();
        value.viewport.width = 0.0;
        value.root.background = Some(Color::BLACK);
        let mut surface = skia::surfaces::raster_n32_premul((4, 6)).unwrap();
        surface.canvas().clear(skia::Color::RED);
        SkiaRenderer::draw_frame_to_target(surface.canvas(), &value, 4, 6, &mut NativeFonts::new())
            .unwrap();
        let snapshot = native_raster::readback_native(&mut surface, 1, 4, 6).unwrap();
        assert!(snapshot.pixels.iter().all(|byte| *byte == 0));
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn raster_feature_does_not_claim_gpu_surface() {
        let renderer = SkiaRenderer::new();
        assert_eq!(renderer.backend_name(), "skia-raster");
        assert!(!renderer.has_gpu_surface());
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_skia_zero_sized_viewport_keeps_empty_snapshot_contract() {
        let mut renderer = SkiaRenderer::new();
        let mut value = frame();
        value.viewport.width = 0.0;
        value.viewport.height = 0.0;
        value.root.bounds.width = 0.0;
        value.root.bounds.height = 0.0;
        renderer.commit(value).expect("zero-sized native commit");
        let snapshot = renderer.snapshot().expect("zero-sized readback");
        assert_eq!(
            (snapshot.width, snapshot.height, snapshot.stride),
            (0, 0, 0)
        );
        assert!(snapshot.pixels.is_empty());
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_skia_raster_surface_draws_wxml_text_with_foreground_color() {
        let mut renderer = SkiaRenderer::new();
        let mut value = frame();
        value.frame_id = 43;
        value.viewport.width = 64.0;
        value.viewport.height = 32.0;
        value.root.bounds.width = 64.0;
        value.root.bounds.height = 32.0;
        let mut text = RenderNode::new(
            "title",
            Rect {
                x: 4.0,
                y: 2.0,
                width: 56.0,
                height: 24.0,
            },
        )
        .with_text("ABC");
        text.foreground = Some(Color {
            red: 7,
            green: 19,
            blue: 31,
            alpha: 255,
        });
        value.root.children.push(text);

        renderer.commit(value).expect("Skia raster text commit");
        let snapshot = renderer.snapshot().expect("native readback");
        assert_eq!((snapshot.width, snapshot.height), (64, 32));
        assert!(snapshot
            .pixels
            .chunks(4)
            .any(|pixel| pixel[3] > 0 && pixel[0] > 0 && pixel[1] > 0 && pixel[2] > 0));
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_skia_text_leaves_inherit_color_and_allow_overrides() {
        let blue = Color {
            red: 0,
            green: 0,
            blue: 255,
            alpha: 255,
        };
        let red = Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        };
        for (parent_color, leaf_color, expected) in [
            (None, None, Color::BLACK),
            (Some(blue), None, blue),
            (Some(blue), Some(red), red),
        ] {
            let mut renderer = SkiaRenderer::new();
            let mut value = frame();
            value.viewport.width = 64.0;
            value.viewport.height = 32.0;
            value.root.bounds = value.viewport;
            value.root.foreground = parent_color;
            let mut leaf = RenderNode::new(
                "raw-wxml-text",
                Rect {
                    x: 4.0,
                    y: 2.0,
                    width: 56.0,
                    height: 24.0,
                },
            )
            .with_text("ABC");
            leaf.foreground = leaf_color;
            value.root.children.push(leaf);
            renderer.commit(value).expect("text leaf render");
            let snapshot = renderer.snapshot().expect("text leaf readback");
            assert!(
                snapshot.pixels.chunks(4).any(|pixel| {
                    pixel == [expected.red, expected.green, expected.blue, expected.alpha]
                }),
                "expected visible text with {expected:?}"
            );
        }
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_skia_cjk_uses_available_system_glyphs() {
        // This test deliberately probes real system coverage. Production
        // providers remain lazy; reuse this explicitly requested manager.
        let manager = skia::FontMgr::new();
        let available = manager.family_names().find_map(|family| {
            manager
                .match_family_style(&family, skia::FontStyle::normal())
                .filter(|face| {
                    "中文"
                        .chars()
                        .all(|character| face.unichar_to_glyph(character as i32) != 0)
                })
        });
        let Some(available) = available else {
            eprintln!("CJK system fonts unavailable: native CJK raster coverage was not exercised");
            return;
        };
        eprintln!("CJK system font available: {}", available.family_name());
        let mut fonts = NativeFonts::from_manager(manager);

        let mut renderer = SkiaRenderer::new();
        let mut value = frame();
        value.viewport.width = 64.0;
        value.viewport.height = 32.0;
        value.root.bounds = value.viewport;
        value.root.children.push(
            RenderNode::new(
                "cjk",
                Rect {
                    x: 4.0,
                    y: 2.0,
                    width: 56.0,
                    height: 24.0,
                },
            )
            .with_text("中文"),
        );
        renderer.commit(value).expect("native CJK commit");
        let actual = renderer.snapshot().unwrap();
        let mut expected = skia::surfaces::raster_n32_premul((64, 32)).unwrap();
        expected.canvas().clear(skia::Color::TRANSPARENT);
        let paint = skia::Paint::new(skia::Color4f::from(skia::Color::BLACK), None);
        let mut x = 4.0;
        for character in "中文".chars() {
            let font = fonts
                .for_character(character, 16.0)
                .expect("an installed CJK font must be resolved through system fallback");
            assert_ne!(font.unichar_to_glyph(character as i32), 0);
            let mut encoded = [0; 4];
            let glyph: &str = character.encode_utf8(&mut encoded);
            expected.canvas().draw_str(glyph, (x, 18.0), &font, &paint);
            x += font.measure_str(glyph, Some(&paint)).0;
        }
        let expected = native_raster::readback_native(&mut expected, 1, 64, 32).unwrap();
        assert!(actual.pixels.chunks(4).any(|pixel| pixel[3] != 0));
        assert_eq!(
            actual.pixels, expected.pixels,
            "CJK output must match real system glyphs, not the deterministic 5x7 fallback"
        );
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_skia_missing_glyph_does_not_replace_supported_text() {
        let Some(font) = NativeFonts::new().for_character('A', 16.0) else {
            eprintln!(
                "System Latin font unavailable: mixed native/fallback coverage was not exercised"
            );
            return;
        };
        assert!("ABC"
            .chars()
            .all(|character| font.unichar_to_glyph(character as i32) != 0));
        assert_eq!(font.unichar_to_glyph('\u{10ffff}' as i32), 0);
        // Deliberately disable further system fallback, keeping a real Latin
        // face. The unsupported scalar must affect only its own glyph.
        let mut fonts = NativeFonts::from_manager(skia::FontMgr::empty());
        fonts.set_default_for_test(font.clone());
        assert!(fonts.for_character('\u{10ffff}', 16.0).is_none());
        let mut actual = skia::surfaces::raster_n32_premul((64, 32)).unwrap();
        let mut expected = skia::surfaces::raster_n32_premul((64, 32)).unwrap();
        let paint = skia::Paint::new(skia::Color4f::from(skia::Color::BLACK), None);
        actual.canvas().clear(skia::Color::TRANSPARENT);
        expected.canvas().clear(skia::Color::TRANSPARENT);
        native_raster::draw_native_text(
            actual.canvas(),
            "ABC\u{10ffff}",
            (0.0, 18.0),
            16.0,
            &mut fonts,
            &paint,
        );
        expected
            .canvas()
            .draw_str("ABC", (0.0, 18.0), &font, &paint);
        let actual = native_raster::readback_native(&mut actual, 1, 64, 32).unwrap();
        let expected = native_raster::readback_native(&mut expected, 1, 64, 32).unwrap();
        let latin_width = font.measure_str("ABC", Some(&paint)).0.floor() as usize;
        assert!(latin_width > 0);
        for row in 0..32 {
            let start = row * 64 * 4;
            let end = start + latin_width * 4;
            assert_eq!(
                &actual.pixels[start..end],
                &expected.pixels[start..end],
                "supported Latin glyphs changed because a later character is missing"
            );
        }
        assert!(
            actual
                .pixels
                .chunks(4)
                .enumerate()
                .any(|(index, pixel)| index % 64 > latin_width && pixel[3] != 0),
            "missing glyph marker must still be drawn"
        );
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn fontless_manager_reports_absence_instead_of_native_font_support() {
        let mut fonts = NativeFonts::from_manager(skia::FontMgr::empty());
        assert!(fonts.for_character('A', 16.0).is_none());
        assert!(fonts.for_character('中', 16.0).is_none());
        assert_eq!(fonts.fallback.len(), 2);
        assert!(fonts.for_character('中', 16.0).is_none());
        assert_eq!(
            fonts.fallback.len(),
            2,
            "negative character lookups are cached per renderer/provider"
        );
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_skia_canvas_replays_path_and_text_commands() {
        let payload = serde_json::json!({
            "canvasId": "native",
            "width": 64,
            "height": 32,
            "commands": [
                {"op": "setFillStyle", "args": ["#102030"]},
                {"op": "rect", "args": [1, 1, 20, 12]},
                {"op": "fill", "args": []},
                {"op": "setFillStyle", "args": ["#f0a000"]},
                {"op": "setFontSize", "args": [16]},
                {"op": "fillText", "args": ["ABC", 2, 28]}
            ]
        });
        let mut renderer = SkiaRenderer::new();
        let snapshot = renderer
            .commit_canvas(
                CanvasFrame::from_payload(payload.as_object().unwrap(), 44, None).unwrap(),
            )
            .expect("native canvas commands commit");
        assert_eq!((snapshot.width, snapshot.height), (64, 32));
        assert!(snapshot
            .pixels
            .chunks(4)
            .any(|pixel| pixel[3] > 0 && pixel[0] > 0 && pixel[1] > 0 && pixel[2] > 0));
    }

    #[test]
    fn selector_query_matches_id_class_and_tag_without_layout_round_trips() {
        let mut value = frame();
        let mut hero = RenderNode::new(
            "hero",
            Rect {
                x: 1.0,
                y: 2.0,
                width: 3.0,
                height: 4.0,
            },
        );
        hero.tag = Some("view".into());
        hero.classes = vec!["card".into(), "primary".into()];
        value.root.children.push(hero);
        let mut text = RenderNode::new(
            "copy",
            Rect {
                x: 5.0,
                y: 6.0,
                width: 7.0,
                height: 8.0,
            },
        );
        text.tag = Some("text".into());
        text.classes = vec!["card".into()];
        value.root.children.push(text);
        assert_eq!(value.query("#hero", false).unwrap().len(), 1);
        assert_eq!(value.query("view.card", false).unwrap()[0].id, "hero");
        assert_eq!(value.query(".card", true).unwrap().len(), 2);
        assert_eq!(value.query("#hero, text", true).unwrap().len(), 2);
        assert_eq!(value.query("view .card", true).unwrap().len(), 0);
    }

    #[test]
    fn selector_query_matches_attribute_presence_and_exact_values() {
        let mut value = frame();
        let mut button = RenderNode::new(
            "save",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
        );
        button.tag = Some("button".into());
        button.attributes.insert("type".into(), "primary".into());
        button
            .attributes
            .insert("data-state".into(), "ready".into());
        value.root.children.push(button);
        assert_eq!(value.query("button[type]", false).unwrap()[0].id, "save");
        assert_eq!(
            value.query("[data-state=ready]", false).unwrap()[0].id,
            "save"
        );
        assert_eq!(
            value
                .query("button[type=\"secondary\"]", false)
                .unwrap()
                .len(),
            0
        );
        assert!(matches!(
            value.query("button[type", false),
            Err(SelectorError::Unsupported(_))
        ));
    }

    #[test]
    fn selector_query_scope_limits_matches_to_component_root() {
        let mut value = frame();
        let mut first = RenderNode::new(
            "first",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
        );
        first.tag = Some("view".into());
        first
            .attributes
            .insert("data-sim-scope".into(), "one".into());
        let mut nested = RenderNode::new(
            "nested",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 5.0,
                height: 5.0,
            },
        );
        nested.tag = Some("text".into());
        nested.classes = vec!["target".into()];
        first.children.push(nested);
        let mut second = RenderNode::new(
            "second",
            Rect {
                x: 0.0,
                y: 20.0,
                width: 10.0,
                height: 10.0,
            },
        );
        second.tag = Some("view".into());
        let mut other = RenderNode::new(
            "other",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 5.0,
                height: 5.0,
            },
        );
        other.tag = Some("text".into());
        other.classes = vec!["target".into()];
        second.children.push(other);
        value.root.children = vec![first, second];
        assert_eq!(value.query(".target", true).unwrap().len(), 2);
        let scoped = value.query_scoped(".target", true, Some("one")).unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].id, "nested");
    }

    #[test]
    fn selector_query_matches_descendant_child_and_sibling_combinators() {
        let mut value = frame();
        let mut parent = RenderNode::new(
            "parent",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        );
        parent.tag = Some("view".into());
        let mut first = RenderNode::new(
            "first",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
        );
        first.tag = Some("text".into());
        first.classes = vec!["label".into()];
        let mut second = RenderNode::new(
            "second",
            Rect {
                x: 0.0,
                y: 10.0,
                width: 10.0,
                height: 10.0,
            },
        );
        second.tag = Some("text".into());
        second.classes = vec!["value".into()];
        parent.children = vec![first, second];
        let mut nested = RenderNode::new(
            "nested",
            Rect {
                x: 0.0,
                y: 20.0,
                width: 10.0,
                height: 10.0,
            },
        );
        nested.tag = Some("view".into());
        nested.children.push(RenderNode::new(
            "deep",
            Rect {
                x: 0.0,
                y: 30.0,
                width: 10.0,
                height: 10.0,
            },
        ));
        parent.children.push(nested);
        value.root.children.push(parent);

        assert_eq!(value.query("view > text", true).unwrap().len(), 2);
        assert_eq!(value.query("view .value", true).unwrap()[0].id, "second");
        assert_eq!(
            value.query(".label + .value", true).unwrap()[0].id,
            "second"
        );
        assert_eq!(
            value.query(".label ~ .value", true).unwrap()[0].id,
            "second"
        );
        assert_eq!(value.query("view > view > *", true).unwrap()[0].id, "deep");
        assert!(matches!(
            value.query("view >", true),
            Err(SelectorError::Unsupported(_))
        ));
    }

    #[test]
    fn lays_out_text_and_row_children_deterministically() {
        let mut root = RenderNode::new(
            "root",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            },
        )
        .with_style(LayoutStyle {
            direction: FlexDirection::Row,
            padding: EdgeInsets {
                left: 10.0,
                right: 10.0,
                top: 4.0,
                bottom: 4.0,
            },
            gap: 5.0,
            ..LayoutStyle::default()
        });
        root.children.push(
            RenderNode::new(
                "a",
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 20.0,
                    height: 10.0,
                },
            )
            .with_text("hello"),
        );
        root.children.push(RenderNode::new(
            "b",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 30.0,
                height: 10.0,
            },
        ));
        layout_tree(
            &mut root,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            },
        );
        assert_eq!(root.children[0].bounds.x, 10.0);
        assert_eq!(root.children[1].bounds.x, 35.0);
        assert_eq!(measure_text("hello", 16.0, None).width, 40.0);
    }

    fn auto_layout_node(id: &str, style: LayoutStyle) -> RenderNode {
        RenderNode::new(
            id,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
        )
        .with_style(style)
    }

    fn assert_layout_close(actual: f32, expected: f32) {
        assert!((actual - expected).abs() < 0.001, "{actual} != {expected}");
    }

    #[test]
    fn resolved_typography_controls_auto_layout_and_reflow() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let mut root = RenderNode::new("root", viewport).with_style(LayoutStyle::default());
        let label = auto_layout_node(
            "label",
            LayoutStyle {
                width: Some(10.0),
                ..LayoutStyle::default()
            },
        )
        .with_text("ABCD")
        .with_text_style(TextStyle {
            font_size: 10.0,
            line_height: LineHeight::Px(30.0),
            flow: None,
        });
        root.children = vec![
            label,
            auto_layout_node("after", LayoutStyle::default())
                .with_text("A")
                .with_text_style(TextStyle {
                    font_size: 0.0,
                    ..TextStyle::default()
                }),
        ];
        layout_tree(&mut root, viewport);
        let label = &root.children[0];
        assert_eq!(label.bounds.height, 60.0);
        let plan = label.text_layout.as_ref().unwrap();
        assert_eq!(plan.measurement, TextMeasurement::Fallback);
        assert_eq!(plan.metrics.line_count, 2);
        assert_eq!(plan.glyphs[2].baseline_y - plan.glyphs[0].baseline_y, 30.0);
        assert_eq!(root.children[1].bounds.y, 60.0);
        assert_eq!(root.children[1].bounds.height, 0.0);

        root.children[0].text_style = Some(TextStyle {
            font_size: 5.0,
            line_height: LineHeight::Number(2.0),
            flow: None,
        });
        layout_tree(&mut root, viewport);
        assert_eq!(root.children[0].bounds.height, 10.0);
        assert_eq!(
            root.children[0]
                .text_layout
                .as_ref()
                .unwrap()
                .metrics
                .line_count,
            1
        );
        assert_eq!(
            root.children[1].bounds.y, 10.0,
            "reflow replaces the previous line layout"
        );
    }

    #[test]
    fn old_frame_json_keeps_optional_typography_and_invalid_plans_retain_last_frame() {
        let old = frame();
        let encoded = serde_json::to_value(&old).unwrap();
        assert!(encoded["root"].get("text_style").is_none());
        assert!(encoded["root"].get("text_layout").is_none());
        let decoded: RenderFrame = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.root.text_style, None);
        assert_eq!(decoded.root.text_layout, None);
        let mut renderer = SoftwareRenderer::new();
        renderer.commit(old.clone()).unwrap();
        let mut invalid = old.clone();
        invalid.root.text_style = Some(TextStyle {
            font_size: -1.0,
            ..TextStyle::default()
        });
        assert_eq!(renderer.commit(invalid), Err(RenderError::InvalidTextStyle));
        assert_eq!(renderer.last_frame().unwrap().frame_id, old.frame_id);
        let mut stale = old;
        stale.root.text = Some("changed".into());
        stale.root.text_layout = Some(layout_text(
            "old",
            TextStyle::default(),
            None,
            &mut FallbackTextMeasurer,
        ));
        assert_eq!(renderer.commit(stale), Err(RenderError::InvalidTextLayout));
    }

    #[test]
    fn source_and_glyph_budgets_reject_dynamic_text_before_replacing_an_accepted_frame() {
        let mut renderer = SkiaRenderer::new();
        let accepted = frame();
        renderer.commit(accepted.clone()).unwrap();
        let mut too_large = accepted.clone();
        too_large.root.text = Some("\n".repeat(MAX_FRAME_TEXT_CHARACTERS + 1));
        let bounds_before = too_large.root.bounds;
        let viewport = too_large.viewport;
        assert_eq!(
            renderer.layout_tree(&mut too_large.root, viewport),
            Err(RenderError::TextBudgetExceeded)
        );
        assert_eq!(too_large.root.bounds, bounds_before);
        assert_eq!(too_large.root.text_layout, None);
        assert_eq!(
            renderer.commit(too_large),
            Err(RenderError::TextBudgetExceeded)
        );
        assert_eq!(renderer.last_frame().unwrap().frame_id, accepted.frame_id);

        let mut malicious_plan = accepted;
        malicious_plan.root.text = Some("A".into());
        malicious_plan.root.text_style = Some(TextStyle::default());
        malicious_plan.root.text_layout = Some(TextLayout {
            flow: None,
            measurement: TextMeasurement::Fallback,
            metrics: TextMetrics {
                width: 1.0,
                height: 1.0,
                line_count: 1,
            },
            glyphs: vec![
                GlyphPosition {
                    character: 'A',
                    x: 0.0,
                    baseline_y: 0.0
                };
                MAX_FRAME_TEXT_CHARACTERS + 1
            ],
        });
        assert_eq!(
            renderer.commit(malicious_plan),
            Err(RenderError::TextBudgetExceeded)
        );
    }

    #[test]
    fn glyph_positions_require_typed_style_and_finite_absolute_coordinates() {
        let mut value = frame();
        value.root.text = Some("A".into());
        value.root.text_layout = Some(layout_text(
            "A",
            TextStyle::default(),
            None,
            &mut FallbackTextMeasurer,
        ));
        let mut renderer = SoftwareRenderer::new();
        assert_eq!(
            renderer.commit(value.clone()),
            Err(RenderError::InvalidTextLayout)
        );
        value.root.text_style = Some(TextStyle::default());
        value.root.bounds.x = f32::MAX;
        value.root.text_layout.as_mut().unwrap().glyphs[0].x = f32::MAX;
        assert_eq!(renderer.commit(value), Err(RenderError::InvalidTextLayout));
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_text_layout_uses_font_advances_and_paints_accepted_wrapped_plan() {
        let mut renderer = SkiaRenderer::new();
        let font = renderer
            .canvas
            .native_fonts
            .for_character('W', 10.0)
            .expect("native text measurement conformance requires a host font containing W");
        let advance = font.measure_str("W", None).0;
        assert!(advance > 0.0);
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 80.0,
            height: 80.0,
        };
        let mut value = frame();
        value.viewport = viewport;
        value.root = RenderNode::new("root", viewport).with_style(LayoutStyle::default());
        value.root.children.push(
            auto_layout_node(
                "label",
                LayoutStyle {
                    width: Some(advance * 2.1),
                    ..LayoutStyle::default()
                },
            )
            .with_text("WWWW")
            .with_text_style(TextStyle {
                font_size: 10.0,
                line_height: LineHeight::Px(30.0),
                flow: None,
            }),
        );
        renderer.layout_tree(&mut value.root, viewport).unwrap();
        let node = &value.root.children[0];
        let plan = node.text_layout.as_ref().unwrap();
        assert_eq!(plan.measurement, TextMeasurement::Native);
        assert_eq!(plan.metrics.line_count, 2);
        assert_layout_close(plan.glyphs[1].x, advance);
        assert_eq!(plan.glyphs[2].x, 0.0);
        assert_layout_close(plan.glyphs[2].baseline_y - plan.glyphs[0].baseline_y, 30.0);
        assert_eq!(node.bounds.height, 60.0);
        let mut expected = skia::surfaces::raster_n32_premul((80, 80)).unwrap();
        expected.canvas().clear(skia::Color::TRANSPARENT);
        let paint = skia::Paint::new(skia::Color4f::from(skia::Color::BLACK), None);
        for glyph in &plan.glyphs {
            expected.canvas().draw_str(
                "W",
                (node.bounds.x + glyph.x, node.bounds.y + glyph.baseline_y),
                &font,
                &paint,
            );
        }
        let expected =
            native_raster::readback_native(&mut expected, value.frame_id, 80, 80).unwrap();
        renderer.commit(value).unwrap();
        let actual = renderer.snapshot().unwrap();
        assert_eq!(
            actual.pixels, expected.pixels,
            "paint must consume the same glyph plan measured for layout"
        );
        assert!(actual.pixels.chunks(4).any(|pixel| pixel[3] != 0));
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_zero_line_height_overflows_but_zero_font_size_has_no_ink() {
        for size in [10.0, 0.0] {
            let mut renderer = SkiaRenderer::new();
            let viewport = Rect {
                x: 0.0,
                y: 0.0,
                width: 60.0,
                height: 60.0,
            };
            let mut value = frame();
            value.viewport = viewport;
            value.root = RenderNode::new("root", viewport).with_style(LayoutStyle::default());
            value.root.children.push(
                auto_layout_node(
                    "label",
                    LayoutStyle {
                        position: PositionMode::Absolute,
                        left: Some(10.0),
                        top: Some(30.0),
                        width: Some(40.0),
                        ..LayoutStyle::default()
                    },
                )
                .with_text("ABC")
                .with_text_style(TextStyle {
                    font_size: size,
                    line_height: LineHeight::Px(0.0),
                    flow: None,
                }),
            );
            renderer.layout_tree(&mut value.root, viewport).unwrap();
            assert_eq!(value.root.children[0].bounds.height, 0.0);
            renderer.commit(value).unwrap();
            let has_ink = renderer
                .snapshot()
                .unwrap()
                .pixels
                .chunks(4)
                .any(|pixel| pixel[3] != 0);
            assert_eq!(
                has_ink,
                size > 0.0,
                "line-height zero must retain glyph ink outside its zero-height box"
            );
        }
    }

    #[test]
    fn auto_column_height_counts_padding_margins_and_only_in_flow_gaps() {
        let mut root = frame().root.with_style(LayoutStyle::default());
        let mut card = auto_layout_node(
            "card",
            LayoutStyle {
                padding: EdgeInsets {
                    top: 10.0,
                    bottom: 6.0,
                    left: 8.0,
                    right: 8.0,
                },
                margin: EdgeInsets {
                    top: 3.0,
                    bottom: 5.0,
                    ..EdgeInsets::ZERO
                },
                gap: 4.0,
                ..LayoutStyle::default()
            },
        );
        card.children
            .push(auto_layout_node("text", LayoutStyle::default()).with_text("hello"));
        for (id, display, position) in [
            ("hidden", DisplayMode::None, PositionMode::Static),
            ("absolute", DisplayMode::Flex, PositionMode::Absolute),
            ("fixed", DisplayMode::Flex, PositionMode::Fixed),
        ] {
            card.children.push(auto_layout_node(
                id,
                LayoutStyle {
                    height: Some(90.0),
                    display,
                    position,
                    margin: EdgeInsets {
                        top: 50.0,
                        bottom: 50.0,
                        ..EdgeInsets::ZERO
                    },
                    ..LayoutStyle::default()
                },
            ));
        }
        card.children.push(auto_layout_node(
            "last",
            LayoutStyle {
                height: Some(12.0),
                margin: EdgeInsets {
                    top: 2.0,
                    bottom: 3.0,
                    ..EdgeInsets::ZERO
                },
                ..LayoutStyle::default()
            },
        ));
        root.children = vec![card, auto_layout_node("after", LayoutStyle::default())];
        let viewport = root.bounds;
        layout_tree(&mut root, viewport);
        let card = &root.children[0];
        assert_layout_close(card.bounds.height, 56.2);
        assert_layout_close(card.children[0].bounds.y, 13.0);
        assert_layout_close(card.children[4].bounds.y, 38.2);
        assert_eq!(card.children[1].bounds.height, 0.0);
        assert_layout_close(root.children[1].bounds.y, 64.2);
        assert_eq!(root.bounds.height, viewport.height);
    }

    #[test]
    fn auto_row_height_uses_maximum_outer_child_height() {
        let mut root = frame().root.with_style(LayoutStyle::default());
        let mut row = auto_layout_node(
            "row",
            LayoutStyle {
                direction: FlexDirection::Row,
                padding: EdgeInsets {
                    top: 3.0,
                    bottom: 5.0,
                    ..EdgeInsets::ZERO
                },
                gap: 7.0,
                ..LayoutStyle::default()
            },
        );
        for (id, height, top, bottom) in [("a", None, 2.0, 4.0), ("b", Some(25.0), 1.0, 2.0)] {
            let mut child = auto_layout_node(
                id,
                LayoutStyle {
                    width: Some(20.0),
                    height,
                    margin: EdgeInsets {
                        top,
                        bottom,
                        ..EdgeInsets::ZERO
                    },
                    ..LayoutStyle::default()
                },
            );
            if height.is_none() {
                child.text = Some("1234".into());
            }
            row.children.push(child);
        }
        root.children = vec![row, auto_layout_node("after", LayoutStyle::default())];
        let viewport = root.bounds;
        layout_tree(&mut root, viewport);
        assert_layout_close(root.children[0].bounds.height, 52.4);
        assert_layout_close(root.children[1].bounds.y, 52.4);
        assert_layout_close(root.children[0].children[0].bounds.height, 38.4);
        assert_eq!(root.children[0].children[1].bounds.height, 25.0);
        assert_eq!(root.children[0].children[1].bounds.x, 27.0);
    }

    #[test]
    fn auto_height_wraps_at_final_content_width_and_can_shrink_after_relayout() {
        let mut root = frame().root.with_style(LayoutStyle {
            width: Some(64.0),
            ..LayoutStyle::default()
        });
        let mut card = auto_layout_node(
            "card",
            LayoutStyle {
                padding: EdgeInsets {
                    top: 4.0,
                    bottom: 4.0,
                    left: 4.0,
                    right: 4.0,
                },
                ..LayoutStyle::default()
            },
        );
        card.children
            .push(auto_layout_node("line", LayoutStyle::default()).with_text("12345678"));
        root.children = vec![card, auto_layout_node("after", LayoutStyle::default())];
        let viewport = root.bounds;
        layout_tree(&mut root, viewport);
        assert_eq!(root.children[0].children[0].bounds.width, 56.0);
        assert_layout_close(root.children[0].bounds.height, 46.4);
        assert_layout_close(root.children[1].bounds.y, 46.4);
        root.children[0].children[0].text = Some("short".into());
        layout_tree(&mut root, viewport);
        assert_layout_close(root.children[0].bounds.height, 27.2);
        assert_layout_close(root.children[1].bounds.y, 27.2);
    }

    #[test]
    fn auto_measurement_preserves_explicit_heights_and_unstyled_legacy_rectangles() {
        let mut legacy = frame().root;
        legacy.children.push(RenderNode::new(
            "legacy",
            Rect {
                x: 12.0,
                y: 23.0,
                width: 34.0,
                height: 45.0,
            },
        ));
        let previous = legacy.clone();
        let viewport = legacy.bounds;
        layout_tree(&mut legacy, viewport);
        assert_eq!(legacy, previous);

        let mut root = previous.with_style(LayoutStyle::default());
        let mut fixed = auto_layout_node(
            "fixed-height",
            LayoutStyle {
                height: Some(30.0),
                ..LayoutStyle::default()
            },
        );
        fixed.children.push(auto_layout_node(
            "overflow",
            LayoutStyle {
                height: Some(100.0),
                ..LayoutStyle::default()
            },
        ));
        root.children = vec![fixed, auto_layout_node("after", LayoutStyle::default())];
        layout_tree(&mut root, viewport);
        assert_eq!(root.children[0].bounds.height, 30.0);
        assert_eq!(root.children[1].bounds.y, 30.0);
    }

    #[test]
    fn lays_out_reverse_flex_directions_from_the_main_end() {
        let mut row = RenderNode::new(
            "row",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 40.0,
            },
        )
        .with_style(LayoutStyle {
            direction: FlexDirection::RowReverse,
            padding: EdgeInsets {
                left: 10.0,
                right: 10.0,
                ..EdgeInsets::ZERO
            },
            gap: 5.0,
            ..LayoutStyle::default()
        });
        row.children.push(RenderNode::new(
            "first",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 10.0,
            },
        ));
        row.children.push(RenderNode::new(
            "second",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 30.0,
                height: 10.0,
            },
        ));
        layout_tree(
            &mut row,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 40.0,
            },
        );
        assert_eq!(row.children[0].bounds.x, 170.0);
        assert_eq!(row.children[1].bounds.x, 135.0);

        let mut column = RenderNode::new(
            "column",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 40.0,
                height: 100.0,
            },
        )
        .with_style(LayoutStyle {
            direction: FlexDirection::ColumnReverse,
            padding: EdgeInsets {
                top: 4.0,
                bottom: 4.0,
                ..EdgeInsets::ZERO
            },
            gap: 3.0,
            ..LayoutStyle::default()
        });
        column.children.push(RenderNode::new(
            "first",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
        ));
        column.children.push(RenderNode::new(
            "second",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 15.0,
            },
        ));
        layout_tree(
            &mut column,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 40.0,
                height: 100.0,
            },
        );
        assert_eq!(column.children[0].bounds.y, 86.0);
        assert_eq!(column.children[1].bounds.y, 68.0);
    }

    #[test]
    fn lays_out_relative_absolute_and_fixed_wxss_positions() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 100.0,
        };
        let mut root = RenderNode::new("root", viewport).with_style(LayoutStyle {
            width: Some(200.0),
            height: Some(100.0),
            position: PositionMode::Relative,
            ..LayoutStyle::default()
        });
        let normal = RenderNode::new(
            "normal",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 10.0,
            },
        )
        .with_style(LayoutStyle {
            width: Some(20.0),
            height: Some(10.0),
            ..LayoutStyle::default()
        });
        let relative = RenderNode::new(
            "relative",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
        )
        .with_style(LayoutStyle {
            width: Some(10.0),
            height: Some(10.0),
            position: PositionMode::Relative,
            left: Some(7.0),
            top: Some(3.0),
            ..LayoutStyle::default()
        });
        let absolute = RenderNode::new(
            "absolute",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
        )
        .with_style(LayoutStyle {
            width: Some(30.0),
            height: Some(20.0),
            position: PositionMode::Absolute,
            right: Some(5.0),
            bottom: Some(6.0),
            ..LayoutStyle::default()
        });
        let fixed = RenderNode::new(
            "fixed",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
        )
        .with_style(LayoutStyle {
            width: Some(8.0),
            height: Some(9.0),
            position: PositionMode::Fixed,
            left: Some(2.0),
            top: Some(4.0),
            ..LayoutStyle::default()
        });
        root.children = vec![normal, relative, absolute, fixed];

        layout_tree(&mut root, viewport);

        assert_eq!(
            root.children[0].bounds,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 10.0,
            }
        );
        // Relative offsets move the painted box while preserving its flow
        // slot; out-of-flow nodes do not advance that cursor.
        assert_eq!(
            root.children[1].bounds,
            Rect {
                x: 7.0,
                y: 13.0,
                width: 10.0,
                height: 10.0,
            }
        );
        assert_eq!(
            root.children[2].bounds,
            Rect {
                x: 165.0,
                y: 74.0,
                width: 30.0,
                height: 20.0,
            }
        );
        assert_eq!(
            root.children[3].bounds,
            Rect {
                x: 2.0,
                y: 4.0,
                width: 8.0,
                height: 9.0,
            }
        );
    }

    #[test]
    fn display_none_children_do_not_consume_flow_space() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let mut root = RenderNode::new("root", viewport).with_style(LayoutStyle {
            width: Some(100.0),
            height: Some(100.0),
            ..LayoutStyle::default()
        });
        root.children.push(
            RenderNode::new(
                "hidden",
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 20.0,
                },
            )
            .with_style(LayoutStyle {
                width: Some(10.0),
                height: Some(20.0),
                display: DisplayMode::None,
                ..LayoutStyle::default()
            }),
        );
        root.children.push(
            RenderNode::new(
                "visible",
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 7.0,
                },
            )
            .with_style(LayoutStyle {
                width: Some(10.0),
                height: Some(7.0),
                ..LayoutStyle::default()
            }),
        );

        layout_tree(&mut root, viewport);

        assert_eq!(root.children[0].bounds.width, 0.0);
        assert_eq!(root.children[0].bounds.height, 0.0);
        assert_eq!(root.children[1].bounds.y, 0.0);
    }

    #[test]
    fn hit_test_returns_topmost_path_for_event_dispatch() {
        let mut root = frame().root;
        let mut back = RenderNode::new(
            "back",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0,
            },
        );
        back.tag = Some("view".into());
        let front = RenderNode::new(
            "front",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0,
            },
        );
        back.children.push(front);
        root.children.push(back);
        let path = root.hit_test_path(5.0, 5.0);
        assert_eq!(
            path.iter().map(|node| node.id.as_str()).collect::<Vec<_>>(),
            vec!["root", "back", "front"]
        );
        assert_eq!(
            root.hit_test(5.0, 5.0).map(|node| node.id.as_str()),
            Some("front")
        );
        assert!(root.hit_test(400.0, 400.0).is_none());
    }

    #[test]
    fn absolute_child_hits_through_zero_height_native_ancestors_and_keeps_bubble_path() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 160.0,
        };
        let mut root = RenderNode::new("root", viewport).with_style(LayoutStyle::default());
        let mut host = auto_layout_node("component-host", LayoutStyle::default());
        let mut native = auto_layout_node("native-wrapper", LayoutStyle::default());
        native.tag = Some("view".into());
        let marker = auto_layout_node(
            "absolute-marker",
            LayoutStyle {
                position: PositionMode::Absolute,
                left: Some(24.0),
                top: Some(32.0),
                width: Some(64.0),
                height: Some(48.0),
                ..LayoutStyle::default()
            },
        );
        native.children.push(marker);
        host.children.push(native);
        root.children.push(host);
        layout_tree(&mut root, viewport);
        assert_eq!(root.children[0].bounds.height, 0.0);
        assert_eq!(root.children[0].children[0].bounds.height, 0.0);
        assert_eq!(
            root.hit_test_path(40.0, 48.0)
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "root",
                "component-host",
                "native-wrapper",
                "absolute-marker"
            ]
        );
        assert_eq!(
            root.hit_test(100.0, 90.0).map(|node| node.id.as_str()),
            Some("root")
        );
    }

    fn overflowing_hit_tree() -> RenderNode {
        let mut root = RenderNode::new(
            "root",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        );
        let mut wrapper = RenderNode::new(
            "wrapper",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0,
            },
        );
        wrapper.children.push(RenderNode::new(
            "overflowing-child",
            Rect {
                x: 10.0,
                y: 10.0,
                width: 40.0,
                height: 40.0,
            },
        ));
        root.children.push(wrapper);
        root
    }

    #[test]
    fn explicit_overflow_clips_reject_children_outside_the_ancestor() {
        for overflow in ["hidden", "clip", "scroll", "auto", "HIDDEN"] {
            let mut root = overflowing_hit_tree();
            root.children[0]
                .computed_style
                .insert("overflow".into(), overflow.into());
            assert_eq!(
                root.hit_test(30.0, 30.0).map(|node| node.id.as_str()),
                Some("root"),
                "overflow: {overflow} must prune clipped descendants"
            );
            assert_eq!(
                root.hit_test(15.0, 15.0).map(|node| node.id.as_str()),
                Some("overflowing-child"),
                "overflow: {overflow} must keep children inside the clip"
            );
        }
        let mut root = overflowing_hit_tree();
        root.children[0]
            .computed_style
            .insert("overflow".into(), "visible".into());
        assert_eq!(
            root.hit_test(30.0, 30.0).map(|node| node.id.as_str()),
            Some("overflowing-child")
        );
    }

    #[test]
    fn overflow_axes_preserve_independent_clip_and_css_visible_to_auto_rules() {
        let mut root = overflowing_hit_tree();
        root.children[0]
            .computed_style
            .insert("overflow".into(), "clip visible".into());
        assert_eq!(
            root.hit_test(15.0, 30.0).map(|node| node.id.as_str()),
            Some("overflowing-child")
        );
        assert_eq!(
            root.hit_test(30.0, 15.0).map(|node| node.id.as_str()),
            Some("root")
        );
        root.children[0]
            .computed_style
            .insert("overflow-x".into(), "visible".into());
        root.children[0]
            .computed_style
            .insert("overflow-y".into(), "clip".into());
        assert_eq!(
            root.hit_test(30.0, 15.0).map(|node| node.id.as_str()),
            Some("overflowing-child")
        );
        assert_eq!(
            root.hit_test(15.0, 30.0).map(|node| node.id.as_str()),
            Some("root")
        );
        root.children[0]
            .computed_style
            .insert("overflow-y".into(), "hidden".into());
        assert_eq!(
            root.hit_test(30.0, 15.0).map(|node| node.id.as_str()),
            Some("root"),
            "visible computes to auto beside overflow-y hidden"
        );
    }

    #[test]
    fn rounded_clips_constrain_descendants_only_when_overflow_clips() {
        let mut root = overflowing_hit_tree();
        root.children[0].style = Some(LayoutStyle {
            border_radius: [CornerRadius { x: 10.0, y: 10.0 }; 4],
            ..LayoutStyle::default()
        });
        root.children[0].children[0].bounds = root.children[0].bounds;
        assert_eq!(
            root.hit_test(1.0, 1.0).map(|node| node.id.as_str()),
            Some("overflowing-child"),
            "a parent's rounded background does not clip visible descendants"
        );
        root.children[0]
            .computed_style
            .insert("overflow".into(), "hidden".into());
        assert_eq!(
            root.hit_test(1.0, 1.0).map(|node| node.id.as_str()),
            Some("root")
        );
        assert_eq!(
            root.hit_test(5.0, 5.0).map(|node| node.id.as_str()),
            Some("overflowing-child")
        );
    }

    #[test]
    fn overflow_clips_follow_the_ancestor_transform() {
        let mut root = overflowing_hit_tree();
        root.children[0].style = Some(LayoutStyle {
            transform: Some(Transform2D {
                e: 20.0,
                f: 5.0,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        root.children[0]
            .computed_style
            .insert("overflow".into(), "hidden".into());
        assert_eq!(
            root.hit_test(35.0, 20.0).map(|node| node.id.as_str()),
            Some("overflowing-child")
        );
        assert_eq!(
            root.hit_test(50.0, 35.0).map(|node| node.id.as_str()),
            Some("root")
        );
        root.children[0].computed_style.clear();
        assert_eq!(
            root.hit_test(50.0, 35.0).map(|node| node.id.as_str()),
            Some("overflowing-child")
        );
    }

    #[test]
    fn overflow_traversal_skips_display_none_but_keeps_transparent_targets() {
        let mut root = overflowing_hit_tree();
        root.hit_testable = false;
        root.children[0].hit_testable = false;
        assert!(root.hit_test_path(90.0, 90.0).is_empty());
        assert_eq!(
            root.hit_test_path(30.0, 30.0)
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec!["root", "wrapper", "overflowing-child"]
        );
        root.children[0].style = Some(LayoutStyle {
            display: DisplayMode::None,
            ..LayoutStyle::default()
        });
        assert!(root.hit_test_path(30.0, 30.0).is_empty());
        root.children[0].style = None;
        root.children[0].opacity = 0.0;
        assert_eq!(
            root.hit_test_path(30.0, 30.0)
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec!["root", "wrapper", "overflowing-child"]
        );
    }

    #[test]
    fn node_geometries_compose_nested_transform_origins_in_paint_coordinates() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 200.0,
        };
        let mut root = RenderNode::new("root", viewport).with_style(LayoutStyle {
            transform: Some(Transform2D {
                e: 7.0,
                f: -3.0,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        let mut wrapper = RenderNode::new(
            "wrapper",
            Rect {
                x: 10.0,
                y: 20.0,
                width: 40.0,
                height: 30.0,
            },
        )
        .with_style(LayoutStyle {
            transform: Some(Transform2D {
                a: 0.0,
                b: 1.0,
                c: -1.0,
                d: 0.0,
                e: 0.0,
                f: 0.0,
            }),
            transform_origin: Some(TransformOrigin {
                x: TransformOriginValue {
                    value: 0.0,
                    unit: TransformOriginUnit::Px,
                },
                y: TransformOriginValue {
                    value: 0.0,
                    unit: TransformOriginUnit::Px,
                },
            }),
            ..LayoutStyle::default()
        });
        wrapper.children.push(
            RenderNode::new(
                "leaf",
                Rect {
                    x: 20.0,
                    y: 25.0,
                    width: 10.0,
                    height: 4.0,
                },
            )
            .with_style(LayoutStyle {
                transform: Some(Transform2D {
                    a: 2.0,
                    d: 0.5,
                    ..Transform2D::IDENTITY
                }),
                // The leaf scales about its default center, then its parent
                // rotates about its top-left, then the root translates.
                ..LayoutStyle::default()
            }),
        );
        root.children.push(wrapper);
        let frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root,
        };
        let geometries = frame.node_geometries();
        assert_eq!(geometries.len(), 3);
        assert_eq!(
            geometries[1].bounds,
            Rect {
                x: -13.0,
                y: 17.0,
                width: 30.0,
                height: 40.0,
            }
        );
        assert_eq!(
            geometries[2].bounds,
            Rect {
                x: 9.0,
                y: 22.0,
                width: 2.0,
                height: 20.0,
            }
        );
        assert_eq!(
            frame.root.hit_test(10.0, 30.0).map(|node| node.id.as_str()),
            Some("leaf"),
            "geometry and hit testing must use the same nested coordinate space"
        );
    }

    #[test]
    fn node_geometries_use_all_four_corners_for_shear_and_reflection() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let mut root = RenderNode::new("root", viewport);
        root.children.push(
            RenderNode::new(
                "sheared",
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 20.0,
                },
            )
            .with_style(LayoutStyle {
                transform: Some(Transform2D {
                    a: 1.0,
                    b: 1.0,
                    c: 1.0,
                    d: -1.0,
                    e: 0.0,
                    f: 0.0,
                }),
                ..LayoutStyle::default()
            }),
        );
        let frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root,
        };
        assert_eq!(
            frame.node_geometries()[1].bounds,
            Rect {
                x: -10.0,
                y: -5.0,
                width: 30.0,
                height: 30.0,
            },
            "the opposite diagonal alone misses the y extrema"
        );
    }

    #[test]
    fn node_geometries_keep_preorder_parents_display_inheritance_and_scroll_metadata() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let mut root = RenderNode::new("root", viewport);
        root.opacity = 0.0;
        root.scroll_offset = Some(ScrollOffset {
            scroll_left: 17.0,
            scroll_top: 29.0,
        });
        let mut hidden = RenderNode::new("hidden", viewport).with_style(LayoutStyle {
            display: DisplayMode::None,
            ..LayoutStyle::default()
        });
        hidden
            .children
            .push(RenderNode::new("hidden-child", viewport));
        let mut visible = RenderNode::new("visible", viewport);
        visible
            .computed_style
            .insert("overflow".into(), "hidden".into());
        visible.children.push(RenderNode::new(
            "outside-child",
            Rect {
                x: 110.0,
                y: 120.0,
                width: 20.0,
                height: 30.0,
            },
        ));
        root.children = vec![hidden, visible, RenderNode::new("last", viewport)];
        let frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root,
        };
        let geometries = frame.node_geometries();
        assert_eq!(
            geometries
                .iter()
                .map(|geometry| geometry.node.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "root",
                "hidden",
                "hidden-child",
                "visible",
                "outside-child",
                "last"
            ]
        );
        assert_eq!(
            geometries
                .iter()
                .map(|geometry| geometry.parent)
                .collect::<Vec<_>>(),
            vec![None, Some(0), Some(1), Some(0), Some(3), Some(0)]
        );
        assert_eq!(
            geometries
                .iter()
                .map(|geometry| geometry.displayed)
                .collect::<Vec<_>>(),
            vec![true, false, false, true, true, true],
            "display:none affects descendants, while opacity does not remove geometry"
        );
        assert_eq!(
            geometries[4].bounds,
            Rect {
                x: 110.0,
                y: 120.0,
                width: 20.0,
                height: 30.0,
            },
            "geometry remains unclipped and metadata scroll offsets do not move painted nodes"
        );
        assert!(std::ptr::eq(
            geometries[4].node,
            &frame.root.children[1].children[0]
        ));
    }

    #[test]
    fn transformed_nodes_use_world_matrix_for_hit_testing() {
        let mut root = RenderNode::new(
            "root",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        );
        let child = RenderNode::new(
            "translated",
            Rect {
                x: 10.0,
                y: 10.0,
                width: 10.0,
                height: 10.0,
            },
        )
        .with_style(LayoutStyle {
            transform: Some(Transform2D {
                e: 20.0,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        root.children.push(child);
        assert_eq!(
            root.hit_test(35.0, 15.0).map(|node| node.id.as_str()),
            Some("translated")
        );
        assert_eq!(
            root.hit_test(15.0, 15.0).map(|node| node.id.as_str()),
            Some("root")
        );
    }

    #[test]
    fn software_snapshot_rasterizes_transformed_backgrounds() {
        let mut renderer = SoftwareRenderer::new();
        let mut value = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 12,
            viewport: Rect {
                x: 0.0,
                y: 0.0,
                width: 40.0,
                height: 20.0,
            },
            root: RenderNode::new(
                "root",
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 40.0,
                    height: 20.0,
                },
            ),
        };
        let mut child = RenderNode::new(
            "translated",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 5.0,
                height: 5.0,
            },
        );
        child.background = Some(Color {
            red: 1,
            green: 2,
            blue: 3,
            alpha: 255,
        });
        child.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                e: 10.0,
                f: 3.0,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        value.root.children.push(child);
        renderer.commit(value).unwrap();
        let pixels = renderer.snapshot().unwrap().pixels;
        let translated = ((4 * 40 + 12) * 4) as usize;
        assert_eq!(&pixels[translated..translated + 4], &[1, 2, 3, 255]);
        assert_eq!(pixels[4], 0);
    }

    #[test]
    fn software_snapshot_clips_backgrounds_to_wxss_border_radius() {
        let mut renderer = SoftwareRenderer::new();
        let mut value = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 13,
            viewport: Rect {
                x: 0.0,
                y: 0.0,
                width: 5.0,
                height: 5.0,
            },
            root: RenderNode::new(
                "root",
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 5.0,
                    height: 5.0,
                },
            ),
        };
        let mut card = RenderNode::new(
            "card",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 5.0,
                height: 5.0,
            },
        );
        card.background = Some(Color {
            red: 20,
            green: 40,
            blue: 60,
            alpha: 255,
        });
        card.style = Some(LayoutStyle {
            border_radius: [CornerRadius { x: 2.0, y: 2.0 }; 4],
            ..LayoutStyle::default()
        });
        value.root.children.push(card);
        renderer.commit(value).unwrap();
        let pixels = renderer.snapshot().unwrap().pixels;
        // Pixel centers at (0.5, 0.5) sit outside the quarter ellipse, while
        // (1.5, 1.5) and the center remain painted.
        assert_eq!(&pixels[0..4], &[0, 0, 0, 0]);
        assert_eq!(&pixels[24..28], &[20, 40, 60, 255]);
        assert_eq!(
            &pixels[(2 * 5 + 2) * 4..(2 * 5 + 2) * 4 + 4],
            &[20, 40, 60, 255]
        );
    }

    fn overflow_paint_frame() -> RenderFrame {
        let mut root = overflowing_hit_tree();
        root.background = Some(Color::WHITE);
        root.children[0].children[0].background = Some(Color::BLACK);
        RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 51,
            viewport: root.bounds,
            root,
        }
    }

    fn assert_overflow_pixels(frame: &RenderFrame, expected: &[(u32, u32, [u8; 4])]) {
        let mut software = SoftwareRenderer::new();
        software.commit(frame.clone()).unwrap();
        let mut native = SkiaRenderer::new();
        native.commit(frame.clone()).unwrap();
        // With skia-backend this checks actual raster readback. Without it,
        // SkiaRenderer retains its explicitly identified software fallback.
        for (backend, snapshot) in [
            ("software", software.snapshot().unwrap()),
            ("native-or-declared-fallback", native.snapshot().unwrap()),
        ] {
            for &(x, y, color) in expected {
                let offset = ((y * snapshot.width + x) * 4) as usize;
                assert_eq!(
                    &snapshot.pixels[offset..offset + 4],
                    &color,
                    "{backend} pixel ({x}, {y})"
                );
            }
        }
    }

    #[test]
    fn overflow_paint_and_targeting_share_explicit_clip_modes() {
        for mode in ["visible", "hidden", "clip", "scroll", "auto", "HIDDEN"] {
            let mut value = overflow_paint_frame();
            value.root.children[0]
                .computed_style
                .insert("overflow".into(), mode.into());
            let clipped = mode != "visible";
            assert_overflow_pixels(
                &value,
                &[
                    (15, 15, [0, 0, 0, 255]),
                    (
                        30,
                        30,
                        if clipped {
                            [255, 255, 255, 255]
                        } else {
                            [0, 0, 0, 255]
                        },
                    ),
                ],
            );
            assert_eq!(
                value.root.hit_test(30.5, 30.5).unwrap().id,
                if clipped { "root" } else { "overflowing-child" }
            );
        }
    }

    #[test]
    fn overflow_paint_preserves_single_axis_stripes_and_visible_computation() {
        for (mode, x_clipped, y_clipped) in [
            ("clip visible", true, false),
            ("visible clip", false, true),
            ("visible hidden", true, true),
            ("auto visible", true, true),
        ] {
            let mut value = overflow_paint_frame();
            let wrapper = &mut value.root.children[0];
            wrapper
                .computed_style
                .insert("overflow".into(), mode.into());
            // Rounded corners do not narrow an independent one-axis clip.
            wrapper.style = Some(LayoutStyle {
                border_radius: [CornerRadius { x: 10.0, y: 10.0 }; 4],
                ..LayoutStyle::default()
            });
            assert_overflow_pixels(
                &value,
                &[
                    (
                        15,
                        30,
                        if y_clipped {
                            [255, 255, 255, 255]
                        } else {
                            [0, 0, 0, 255]
                        },
                    ),
                    (
                        30,
                        15,
                        if x_clipped {
                            [255, 255, 255, 255]
                        } else {
                            [0, 0, 0, 255]
                        },
                    ),
                ],
            );
        }
        let mut value = overflow_paint_frame();
        let style = &mut value.root.children[0].computed_style;
        style.insert("overflow".into(), "hidden".into());
        style.insert("overflow-x".into(), "visible".into());
        style.insert("overflow-y".into(), "clip".into());
        assert_overflow_pixels(
            &value,
            &[(30, 15, [0, 0, 0, 255]), (15, 30, [255, 255, 255, 255])],
        );
    }

    #[test]
    fn overflow_rounded_paint_clips_descendants_without_implicitly_clipping_visible_children() {
        let mut value = overflow_paint_frame();
        let wrapper = &mut value.root.children[0];
        wrapper.style = Some(LayoutStyle {
            // Oversized radii normalize to the same 10px circle used by
            // targeting; no independent painter radius normalization exists.
            border_radius: [CornerRadius { x: 80.0, y: 80.0 }; 4],
            ..LayoutStyle::default()
        });
        wrapper.background = Some(Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        });
        wrapper.children[0].bounds = Rect {
            x: -10.0,
            y: -10.0,
            width: 60.0,
            height: 60.0,
        };
        assert_overflow_pixels(&value, &[(0, 0, [0, 0, 0, 255]), (30, 15, [0, 0, 0, 255])]);
        value.root.children[0]
            .computed_style
            .insert("overflow".into(), "hidden".into());
        assert_overflow_pixels(
            &value,
            &[
                (0, 0, [255, 255, 255, 255]),
                (10, 10, [0, 0, 0, 255]),
                (30, 15, [255, 255, 255, 255]),
            ],
        );
    }

    #[test]
    fn overflow_paint_intersects_nested_clips_and_restores_them_before_siblings() {
        let mut value = overflow_paint_frame();
        let outer = &mut value.root.children[0];
        outer
            .computed_style
            .insert("overflow".into(), "hidden".into());
        let inner = &mut outer.children[0];
        inner.background = None;
        inner
            .computed_style
            .insert("overflow".into(), "clip visible".into());
        let mut fill = RenderNode::new("nested-fill", value.viewport);
        fill.background = Some(Color::BLACK);
        inner.children.push(fill);
        let mut sibling = RenderNode::new(
            "sibling",
            Rect {
                x: 30.0,
                y: 0.0,
                width: 5.0,
                height: 5.0,
            },
        );
        sibling.background = Some(Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        });
        value.root.children.push(sibling);
        assert_overflow_pixels(
            &value,
            &[
                (5, 15, [255, 255, 255, 255]),
                (15, 15, [0, 0, 0, 255]),
                (25, 15, [255, 255, 255, 255]),
                (32, 2, [255, 0, 0, 255]),
            ],
        );
    }

    #[test]
    fn overflow_paint_rotates_the_actual_clip_instead_of_only_its_world_aabb() {
        let mut value = overflow_paint_frame();
        let wrapper = &mut value.root.children[0];
        let diagonal = std::f32::consts::FRAC_1_SQRT_2;
        wrapper.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                a: diagonal,
                b: diagonal,
                c: -diagonal,
                d: diagonal,
                e: 40.0,
                f: 20.0,
            }),
            ..LayoutStyle::default()
        });
        wrapper
            .computed_style
            .insert("overflow".into(), "hidden".into());
        wrapper.children[0].bounds = Rect {
            x: -40.0,
            y: -40.0,
            width: 100.0,
            height: 100.0,
        };
        assert_overflow_pixels(
            &value,
            &[
                (50, 30, [0, 0, 0, 255]),
                // Inside the diamond's AABB but outside its transformed edges.
                (37, 17, [255, 255, 255, 255]),
            ],
        );
        assert_eq!(value.root.hit_test(37.5, 17.5).unwrap().id, "root");
        assert_eq!(
            value.root.hit_test(50.5, 30.5).unwrap().id,
            "overflowing-child"
        );
        value.root.children[0]
            .computed_style
            .insert("overflow".into(), "clip visible".into());
        assert_overflow_pixels(
            &value,
            &[(37, 37, [0, 0, 0, 255]), (37, 17, [255, 255, 255, 255])],
        );
    }

    #[test]
    fn overflow_paint_ignores_scroll_metadata_and_skips_hidden_or_singular_subtrees() {
        let mut value = overflow_paint_frame();
        value.root.children[0]
            .computed_style
            .insert("overflow".into(), "hidden".into());
        value.root.children[0].scroll_offset = Some(ScrollOffset {
            scroll_left: 100.0,
            scroll_top: 100.0,
        });
        assert_overflow_pixels(
            &value,
            &[(15, 15, [0, 0, 0, 255]), (30, 30, [255, 255, 255, 255])],
        );
        value.root.children[0].style = Some(LayoutStyle {
            display: DisplayMode::None,
            ..LayoutStyle::default()
        });
        assert_overflow_pixels(&value, &[(15, 15, [255, 255, 255, 255])]);
        value.root.children[0].style = Some(LayoutStyle {
            transform: Some(Transform2D {
                a: 0.0,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        assert_overflow_pixels(&value, &[(15, 15, [255, 255, 255, 255])]);
    }

    #[test]
    fn rectangular_overflow_clips_reduce_to_a_shared_scissor_without_shape_masks() {
        let mut state = RasterClipState::new(100, 100);
        state.push(
            OverflowClip {
                bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 20.0,
                    height: 20.0,
                },
                radii: [CornerRadius::ZERO; 4],
                clip_x: true,
                clip_y: true,
            },
            Transform2D {
                a: 2.0,
                d: 3.0,
                f: 5.0,
                ..Transform2D::IDENTITY
            },
        );
        assert_eq!(
            (
                state.bounds.left,
                state.bounds.top,
                state.bounds.right,
                state.bounds.bottom
            ),
            (0, 5, 40, 65)
        );
        assert!(state.shapes.is_empty());
        state.push(
            OverflowClip {
                bounds: Rect {
                    x: 10.8,
                    y: 10.8,
                    width: 10.0,
                    height: 10.0,
                },
                radii: [CornerRadius::ZERO; 4],
                clip_x: true,
                clip_y: true,
            },
            Transform2D::IDENTITY,
        );
        assert_eq!(
            (
                state.bounds.left,
                state.bounds.top,
                state.bounds.right,
                state.bounds.bottom
            ),
            (11, 11, 21, 21)
        );
        assert!(state.shapes.is_empty());
    }

    #[test]
    fn reflected_overflow_pixel_centres_follow_inverse_hit_endpoint_ownership() {
        for (reflect_x, reflect_y, mode, points) in [
            (
                true,
                false,
                "clip visible",
                vec![
                    (16, 20, false),
                    (17, 20, true),
                    (48, 20, true),
                    (49, 20, false),
                ],
            ),
            (
                false,
                true,
                "visible clip",
                vec![
                    (20, 16, false),
                    (20, 17, true),
                    (20, 48, true),
                    (20, 49, false),
                ],
            ),
            (
                true,
                true,
                "hidden",
                vec![
                    (16, 48, false),
                    (48, 16, false),
                    (48, 48, true),
                    (49, 49, false),
                ],
            ),
        ] {
            let mut value = overflow_paint_frame();
            let wrapper = &mut value.root.children[0];
            wrapper.bounds = Rect {
                x: 12.0,
                y: 12.0,
                width: 32.0,
                height: 32.0,
            };
            let matrix = Transform2D {
                a: if reflect_x { -1.0 } else { 1.0 },
                d: if reflect_y { -1.0 } else { 1.0 },
                e: if reflect_x { 60.5 } else { 0.0 },
                f: if reflect_y { 60.5 } else { 0.0 },
                ..Transform2D::IDENTITY
            };
            wrapper.style = Some(LayoutStyle {
                transform: Some(matrix),
                // Origin lengths are relative to bounds. Cancel that offset
                // so the exact example matrix remains the world transform.
                transform_origin: Some(TransformOrigin {
                    x: TransformOriginValue {
                        value: -12.0,
                        unit: TransformOriginUnit::Px,
                    },
                    y: TransformOriginValue {
                        value: -12.0,
                        unit: TransformOriginUnit::Px,
                    },
                }),
                ..LayoutStyle::default()
            });
            assert_eq!(wrapper.local_transform(), matrix);
            wrapper
                .computed_style
                .insert("overflow".into(), mode.into());
            wrapper.children[0].bounds = value.viewport;
            let clip = wrapper.descendant_clip([CornerRadius::ZERO; 4]).unwrap();
            let mut clip_state = RasterClipState::new(100, 100);
            clip_state.push(clip, matrix);
            assert_eq!(
                clip_state.shapes.len(),
                1,
                "reflected clip retains inverse containment"
            );
            let mut software = SoftwareRenderer::new();
            software.commit(value.clone()).unwrap();
            let snapshot = software.snapshot().unwrap();
            // [12,44) reflected by x'=-x+60.5 is (16.5,48.5].
            // These exact pixel centres establish the software/hit contract;
            // native raster edge coverage is deliberately not inferred here.
            for (x, y, inside) in points {
                let offset = ((y * snapshot.width + x) * 4) as usize;
                assert_eq!(
                    &snapshot.pixels[offset..offset + 4],
                    if inside {
                        &[0, 0, 0, 255]
                    } else {
                        &[255, 255, 255, 255]
                    },
                    "reflection ({reflect_x}, {reflect_y}), pixel ({x}, {y})"
                );
                assert_eq!(
                    value
                        .root
                        .hit_test(x as f32 + 0.5, y as f32 + 0.5)
                        .unwrap()
                        .id,
                    if inside { "overflowing-child" } else { "root" }
                );
            }
        }
    }

    #[test]
    fn rotated_overflow_aabb_preserves_inclusive_local_edges_until_inverse_containment() {
        for (b, c, e, f, points) in [
            (
                1.0,
                -1.0,
                60.5,
                0.0,
                vec![(16, 20, false), (48, 20, true), (49, 20, false)],
            ),
            (
                -1.0,
                1.0,
                0.0,
                60.5,
                vec![(20, 16, false), (20, 48, true), (20, 49, false)],
            ),
            (
                -1.0,
                -1.0,
                60.5,
                60.5,
                vec![(16, 48, false), (48, 16, false), (48, 48, true)],
            ),
        ] {
            let mut value = overflow_paint_frame();
            let wrapper = &mut value.root.children[0];
            wrapper.bounds = Rect {
                x: 12.0,
                y: 12.0,
                width: 32.0,
                height: 32.0,
            };
            let matrix = Transform2D {
                a: 0.0,
                b,
                c,
                d: 0.0,
                e,
                f,
            };
            wrapper.style = Some(LayoutStyle {
                transform: Some(matrix),
                transform_origin: Some(TransformOrigin {
                    x: TransformOriginValue {
                        value: -12.0,
                        unit: TransformOriginUnit::Px,
                    },
                    y: TransformOriginValue {
                        value: -12.0,
                        unit: TransformOriginUnit::Px,
                    },
                }),
                ..LayoutStyle::default()
            });
            assert_eq!(wrapper.local_transform(), matrix);
            wrapper
                .computed_style
                .insert("overflow".into(), "hidden".into());
            wrapper.children[0].bounds = value.viewport;
            let inverse = matrix.inverse().unwrap();
            let clip = wrapper.descendant_clip([CornerRadius::ZERO; 4]).unwrap();
            let mut software = SoftwareRenderer::new();
            software.commit(value.clone()).unwrap();
            let snapshot = software.snapshot().unwrap();
            // Exact quarter turns (and their reflected composition) put the
            // inclusive local minimum onto the AABB's maximum. A scan bound
            // cannot reject that centre before checking the inverse shape.
            // This tests the software/target contract, not native AA rules.
            for (x, y, inside) in points {
                let local = inverse.apply((x as f32 + 0.5, y as f32 + 0.5));
                assert_eq!(clip.contains(local.0, local.1), inside);
                let offset = ((y * snapshot.width + x) * 4) as usize;
                assert_eq!(
                    &snapshot.pixels[offset..offset + 4],
                    if inside {
                        &[0, 0, 0, 255]
                    } else {
                        &[255, 255, 255, 255]
                    },
                    "matrix {matrix:?}, pixel ({x}, {y})"
                );
                assert_eq!(
                    value
                        .root
                        .hit_test(x as f32 + 0.5, y as f32 + 0.5)
                        .unwrap()
                        .id,
                    if inside { "overflowing-child" } else { "root" }
                );
            }
        }
    }

    #[test]
    fn rounded_backgrounds_exclude_corner_hit_targets() {
        let mut root = RenderNode::new(
            "root",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 5.0,
                height: 5.0,
            },
        );
        let mut card = RenderNode::new(
            "card",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 5.0,
                height: 5.0,
            },
        );
        card.style = Some(LayoutStyle {
            border_radius: [CornerRadius { x: 2.0, y: 2.0 }; 4],
            ..LayoutStyle::default()
        });
        root.children.push(card);
        assert_eq!(
            root.hit_test(0.5, 0.5).map(|node| node.id.as_str()),
            Some("root")
        );
        assert_eq!(
            root.hit_test(1.5, 1.5).map(|node| node.id.as_str()),
            Some("card")
        );
    }

    #[test]
    fn old_frame_json_deserializes_with_hit_testing_enabled() {
        let json = r#"{"id":"root","bounds":{"x":0,"y":0,"width":1,"height":1},"background":null,"opacity":1,"children":[]}"#;
        let node: RenderNode = serde_json::from_str(json).unwrap();
        assert!(node.hit_testable);
        assert_eq!(node.style, None);
    }
}

#[cfg(test)]
mod visibility_tests;
