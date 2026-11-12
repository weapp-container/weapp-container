//! Typed CSS flow is an opt-in addition to the portable frame. Taffy solves
//! geometry once; paint, hit testing, selectors and scrolling consume the
//! resulting absolute rectangles and the same accepted text plans.

use super::{
    layout_text, BoxSizing, DisplayMode, EdgeInsets, FlexDirection, PositionMode, Rect,
    RenderError, RenderNode, TextMeasurer, TextStyle,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use taffy::prelude::TaffyAuto;
use taffy::util::ResolveOrZero;
use taffy::{geometry as tg, style as ts, NodeId, TaffyTree};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum FormattingContext {
    #[default]
    Block,
    Flex,
}

/// Percentages are fractions (0.5 means 50%), resolved by the solver against
/// the actual containing block. `Auto` remains distinct from a zero length.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LayoutLength {
    #[default]
    Auto,
    Px(f32),
    Percent(f32),
}

impl LayoutLength {
    fn validate(self, auto: bool, negative: bool) -> Result<(), RenderError> {
        match self {
            Self::Auto if auto => Ok(()),
            Self::Px(value) | Self::Percent(value)
                if value.is_finite() && (negative || value >= 0.0) =>
            {
                Ok(())
            }
            _ => Err(RenderError::InvalidFlowStyle),
        }
    }

    fn dimension(self) -> ts::Dimension {
        match self {
            Self::Auto => ts::Dimension::AUTO,
            Self::Px(value) => ts::Dimension::length(value),
            Self::Percent(value) => ts::Dimension::percent(value),
        }
    }

    fn optional(self) -> ts::LengthPercentageAuto {
        match self {
            Self::Auto => ts::LengthPercentageAuto::AUTO,
            Self::Px(value) => ts::LengthPercentageAuto::length(value),
            Self::Percent(value) => ts::LengthPercentageAuto::percent(value),
        }
    }

    fn required(self) -> ts::LengthPercentage {
        match self {
            Self::Px(value) => ts::LengthPercentage::length(value),
            Self::Percent(value) => ts::LengthPercentage::percent(value),
            Self::Auto => unreachable!("flow validation rejects auto padding/gaps"),
        }
    }

    fn resolve(self, reference: f32) -> Option<f32> {
        match self {
            Self::Auto => None,
            Self::Px(value) => Some(value),
            Self::Percent(value) => Some(value * reference),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FlowEdges {
    pub top: LayoutLength,
    pub right: LayoutLength,
    pub bottom: LayoutLength,
    pub left: LayoutLength,
}

impl FlowEdges {
    pub const ZERO: Self = Self {
        top: LayoutLength::Px(0.0),
        right: LayoutLength::Px(0.0),
        bottom: LayoutLength::Px(0.0),
        left: LayoutLength::Px(0.0),
    };
    pub const AUTO: Self = Self {
        top: LayoutLength::Auto,
        right: LayoutLength::Auto,
        bottom: LayoutLength::Auto,
        left: LayoutLength::Auto,
    };

    fn validate(self, auto: bool, negative: bool) -> Result<(), RenderError> {
        for length in [self.top, self.right, self.bottom, self.left] {
            length.validate(auto, negative)?;
        }
        Ok(())
    }

    fn optional(self) -> tg::Rect<ts::LengthPercentageAuto> {
        tg::Rect {
            top: self.top.optional(),
            right: self.right.optional(),
            bottom: self.bottom.optional(),
            left: self.left.optional(),
        }
    }

    fn required(self) -> tg::Rect<ts::LengthPercentage> {
        tg::Rect {
            top: self.top.required(),
            right: self.right.required(),
            bottom: self.bottom.required(),
            left: self.left.required(),
        }
    }
}

impl Default for FlowEdges {
    fn default() -> Self {
        Self::ZERO
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FlexWrap {
    #[default]
    NoWrap,
    Wrap,
    WrapReverse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlignItems {
    Normal,
    Start,
    End,
    FlexStart,
    FlexEnd,
    SelfStart,
    SelfEnd,
    Center,
    Baseline,
    Stretch,
}

impl AlignItems {
    fn taffy(self) -> ts::AlignItems {
        match self {
            Self::Normal => ts::AlignItems::NORMAL,
            Self::Start => ts::AlignItems::START,
            Self::End => ts::AlignItems::END,
            Self::FlexStart => ts::AlignItems::FLEX_START,
            Self::FlexEnd => ts::AlignItems::FLEX_END,
            Self::SelfStart => ts::AlignItems::SELF_START,
            Self::SelfEnd => ts::AlignItems::SELF_END,
            Self::Center => ts::AlignItems::CENTER,
            Self::Baseline => ts::AlignItems::BASELINE,
            Self::Stretch => ts::AlignItems::STRETCH,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AlignContent {
    Normal,
    Start,
    End,
    FlexStart,
    FlexEnd,
    Center,
    Stretch,
    SpaceBetween,
    SpaceAround,
    SpaceEvenly,
}

impl AlignContent {
    fn taffy(self) -> ts::AlignContent {
        match self {
            Self::Normal => ts::AlignContent::NORMAL,
            Self::Start => ts::AlignContent::START,
            Self::End => ts::AlignContent::END,
            Self::FlexStart => ts::AlignContent::FLEX_START,
            Self::FlexEnd => ts::AlignContent::FLEX_END,
            Self::Center => ts::AlignContent::CENTER,
            Self::Stretch => ts::AlignContent::STRETCH,
            Self::SpaceBetween => ts::AlignContent::SPACE_BETWEEN,
            Self::SpaceAround => ts::AlignContent::SPACE_AROUND,
            Self::SpaceEvenly => ts::AlignContent::SPACE_EVENLY,
        }
    }
}

pub type JustifyContent = AlignContent;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FlowStyle {
    pub context: FormattingContext,
    /// Ordinal group for a direct in-flow child of a Flex formatting context.
    /// It changes solver and paint order, never document/event tree identity.
    #[serde(default, skip_serializing_if = "is_zero_order")]
    pub order: i32,
    pub width: LayoutLength,
    pub height: LayoutLength,
    /// Intrinsic content width / height. The solver applies this only to an
    /// automatic axis, after percentages and Flex allocation are resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<f32>,
    pub min_width: LayoutLength,
    pub min_height: LayoutLength,
    pub max_width: LayoutLength,
    pub max_height: LayoutLength,
    pub margin: FlowEdges,
    pub padding: FlowEdges,
    pub inset: FlowEdges,
    pub row_gap: LayoutLength,
    pub column_gap: LayoutLength,
    pub flex_basis: LayoutLength,
    pub flex_grow: f32,
    pub flex_shrink: f32,
    pub wrap: FlexWrap,
    pub justify_content: Option<JustifyContent>,
    pub align_items: Option<AlignItems>,
    pub align_self: Option<AlignItems>,
    pub align_content: Option<AlignContent>,
}

fn is_zero_order(value: &i32) -> bool {
    *value == 0
}

impl Default for FlowStyle {
    fn default() -> Self {
        Self {
            context: FormattingContext::Block,
            order: 0,
            width: LayoutLength::Auto,
            height: LayoutLength::Auto,
            aspect_ratio: None,
            min_width: LayoutLength::Auto,
            min_height: LayoutLength::Auto,
            max_width: LayoutLength::Auto,
            max_height: LayoutLength::Auto,
            margin: FlowEdges::ZERO,
            padding: FlowEdges::ZERO,
            inset: FlowEdges::AUTO,
            row_gap: LayoutLength::Px(0.0),
            column_gap: LayoutLength::Px(0.0),
            flex_basis: LayoutLength::Auto,
            flex_grow: 0.0,
            flex_shrink: 1.0,
            wrap: FlexWrap::NoWrap,
            justify_content: None,
            align_items: None,
            align_self: None,
            align_content: None,
        }
    }
}

impl FlowStyle {
    pub fn validate(self) -> Result<(), RenderError> {
        for length in [
            self.width,
            self.height,
            self.min_width,
            self.min_height,
            self.max_width,
            self.max_height,
            self.flex_basis,
        ] {
            length.validate(true, false)?;
        }
        self.margin.validate(true, true)?;
        self.padding.validate(false, false)?;
        self.inset.validate(true, true)?;
        self.row_gap.validate(false, false)?;
        self.column_gap.validate(false, false)?;
        if ![self.flex_grow, self.flex_shrink]
            .into_iter()
            .all(|value| value.is_finite() && value >= 0.0)
        {
            return Err(RenderError::InvalidFlowStyle);
        }
        if self
            .aspect_ratio
            .is_some_and(|ratio| !ratio.is_finite() || ratio <= 0.0)
        {
            return Err(RenderError::InvalidFlowStyle);
        }
        Ok(())
    }
}

struct TextContext {
    text: String,
    style: TextStyle,
    replaced_image: Option<ReplacedImageContext>,
}

/// Replaced content derives its automatic axis from the content-box axis
/// actually allocated by the parent. Generic preferred aspect-ratio transfer
/// eagerly freezes that axis from authored dimensions before Flex allocation.
#[derive(Clone, Copy)]
enum ReplacedImageContext {
    WidthFix(f32),
    HeightFix(f32),
}

impl ReplacedImageContext {
    fn new(node: &RenderNode, flow: FlowStyle) -> Option<Self> {
        let ratio = flow.aspect_ratio?;
        match node.image.as_ref()?.mode {
            crate::ImageMode::WidthFix if flow.height == LayoutLength::Auto => {
                Some(Self::WidthFix(ratio))
            }
            crate::ImageMode::HeightFix if flow.width == LayoutLength::Auto => {
                Some(Self::HeightFix(ratio))
            }
            _ => None,
        }
    }

    fn measure(self, available: tg::Size<ts::AvailableSpace>) -> tg::Size<f32> {
        let definite = |space| match space {
            ts::AvailableSpace::Definite(value) => value.max(0.0),
            _ => 0.0,
        };
        // compute_leaf_layout has already removed padding and borders from
        // available space. Applying the ratio to known_dimensions instead
        // would incorrectly include those insets for border-box producers.
        match self {
            Self::WidthFix(ratio) => {
                let width = definite(available.width);
                tg::Size {
                    width,
                    height: width / ratio,
                }
            }
            Self::HeightFix(ratio) => {
                let height = definite(available.height);
                tg::Size {
                    width: height * ratio,
                    height,
                }
            }
        }
    }
}

struct BuiltNode {
    id: NodeId,
    children: Vec<BuiltNode>,
    /// A frame producer can put text and child boxes on the same node. Such
    /// text gets a private anonymous solver box without altering render/event
    /// identity or public child order.
    text_box: Option<NodeId>,
}

fn taffy_error(error: taffy::TaffyError) -> RenderError {
    RenderError::FlowLayout(error.to_string())
}

fn overflow(node: &RenderNode, axis: &str) -> ts::Overflow {
    let value = node
        .computed_style
        .get(&format!("overflow-{axis}"))
        .or_else(|| node.computed_style.get("overflow"))
        .map(String::as_str)
        .unwrap_or("visible");
    match value {
        "hidden" => ts::Overflow::Hidden,
        "clip" => ts::Overflow::Clip,
        // Taffy models auto and scroll identically for sizing; whether a
        // scrollbar is actually painted remains a host/surface decision.
        "scroll" | "auto" => ts::Overflow::Scroll,
        _ => ts::Overflow::Visible,
    }
}

fn solver_style(node: &RenderNode, root: bool, viewport: Rect) -> ts::Style {
    let old = node.style.unwrap_or_default();
    let flow = old.flow.unwrap_or_else(|| FlowStyle {
        width: old
            .width
            .map(LayoutLength::Px)
            .unwrap_or(LayoutLength::Auto),
        height: old
            .height
            .map(LayoutLength::Px)
            .unwrap_or(LayoutLength::Auto),
        ..FlowStyle::default()
    });
    let border = old.border_insets();
    let mut style = ts::Style {
        item_is_replaced: node.image.is_some(),
        display: if old.display == DisplayMode::None {
            ts::Display::None
        } else {
            match flow.context {
                FormattingContext::Block => ts::Display::Block,
                FormattingContext::Flex => ts::Display::Flex,
            }
        },
        box_sizing: match old.box_sizing {
            BoxSizing::ContentBox => ts::BoxSizing::ContentBox,
            BoxSizing::BorderBox => ts::BoxSizing::BorderBox,
        },
        position: match old.position {
            // Taffy's positioned nodes establish absolute containing blocks.
            // A CSS transform does so independently of position:static. Use
            // relative only inside the solver, with zero offsets below, and
            // retain the authored Static mode in the shared render tree.
            PositionMode::Static if old.transform.is_some() => ts::Position::Relative,
            PositionMode::Static => ts::Position::Static,
            PositionMode::Relative => ts::Position::Relative,
            PositionMode::Absolute => ts::Position::Absolute,
            PositionMode::Fixed => ts::Position::Fixed,
        },
        inset: if old.position == PositionMode::Static && old.transform.is_some() {
            FlowEdges::ZERO.optional()
        } else {
            flow.inset.optional()
        },
        size: tg::Size {
            width: flow.width.dimension(),
            height: flow.height.dimension(),
        },
        aspect_ratio: if ReplacedImageContext::new(node, flow).is_some() {
            None
        } else {
            flow.aspect_ratio
        },
        min_size: tg::Size {
            width: flow.min_width.optional(),
            height: flow.min_height.optional(),
        },
        max_size: tg::Size {
            width: flow.max_width.optional(),
            height: flow.max_height.optional(),
        },
        margin: flow.margin.optional(),
        padding: flow.padding.required(),
        border: tg::Rect {
            top: ts::LengthPercentage::length(border.top),
            right: ts::LengthPercentage::length(border.right),
            bottom: ts::LengthPercentage::length(border.bottom),
            left: ts::LengthPercentage::length(border.left),
        },
        overflow: tg::Point {
            x: overflow(node, "x"),
            y: overflow(node, "y"),
        },
        flex_direction: match old.direction {
            FlexDirection::Row => ts::FlexDirection::Row,
            FlexDirection::RowReverse => ts::FlexDirection::RowReverse,
            FlexDirection::Column => ts::FlexDirection::Column,
            FlexDirection::ColumnReverse => ts::FlexDirection::ColumnReverse,
        },
        flex_wrap: match flow.wrap {
            FlexWrap::NoWrap => ts::FlexWrap::NoWrap,
            FlexWrap::Wrap => ts::FlexWrap::Wrap,
            FlexWrap::WrapReverse => ts::FlexWrap::WrapReverse,
        },
        flex_grow: flow.flex_grow,
        flex_shrink: flow.flex_shrink,
        flex_basis: flow.flex_basis.dimension(),
        gap: tg::Size {
            width: flow.column_gap.required(),
            height: flow.row_gap.required(),
        },
        align_self: flow.align_self.map(AlignItems::taffy),
        ..ts::Style::default()
    };
    if let Some(value) = flow.align_items {
        style.align_items = value.taffy();
    }
    if let Some(value) = flow.align_content {
        style.align_content = value.taffy();
    }
    if let Some(value) = flow.justify_content {
        style.justify_content = value.taffy();
    }
    if root {
        // The virtual page/root has a host-supplied default border box. An
        // explicit CSS dimension still overrides that default.
        // The root's implicit host extent is a border box. Resolve its
        // authored padding here instead of using compatibility px fields
        // computed before final font-relative/percentage lowering.
        let insets = EdgeInsets {
            top: flow.padding.top.resolve(viewport.width).unwrap_or(0.0) + border.top,
            right: flow.padding.right.resolve(viewport.width).unwrap_or(0.0) + border.right,
            bottom: flow.padding.bottom.resolve(viewport.width).unwrap_or(0.0) + border.bottom,
            left: flow.padding.left.resolve(viewport.width).unwrap_or(0.0) + border.left,
        };
        if flow.width == LayoutLength::Auto {
            style.size.width = ts::Dimension::length(match old.box_sizing {
                BoxSizing::BorderBox => viewport.width,
                BoxSizing::ContentBox => (viewport.width - insets.horizontal()).max(0.0),
            });
        }
        if flow.height == LayoutLength::Auto {
            style.size.height = ts::Dimension::length(match old.box_sizing {
                BoxSizing::BorderBox => viewport.height,
                BoxSizing::ContentBox => (viewport.height - insets.vertical()).max(0.0),
            });
        }
    }
    style
}

fn build(
    node: &RenderNode,
    tree: &mut TaffyTree<TextContext>,
    root: bool,
    viewport: Rect,
) -> Result<BuiltNode, RenderError> {
    node.validate_anonymous_flex_order()?;
    if let Some(flow) = node.style.and_then(|style| style.flow) {
        flow.validate()?;
    }
    let children: Vec<_> = node
        .children
        .iter()
        .map(|child| build(child, tree, false, viewport))
        .collect::<Result<_, _>>()?;
    let style = solver_style(node, root, viewport);
    let context = || TextContext {
        text: node.text.clone().unwrap_or_default(),
        style: node.text_style.unwrap_or_default(),
        replaced_image: node
            .style
            .and_then(|style| style.flow)
            .and_then(|flow| ReplacedImageContext::new(node, flow)),
    };
    let (id, text_box) = if children.is_empty() {
        let id = tree
            .new_leaf_with_context(style, context())
            .map_err(taffy_error)?;
        (id, None)
    } else {
        let mut ordered = Vec::with_capacity(children.len() + usize::from(node.text.is_some()));
        let text_box = if node.text.is_some() {
            let id = tree
                .new_leaf_with_context(ts::Style::default(), context())
                .map_err(taffy_error)?;
            // Anonymous text is an unstyleable Flex item in ordinal group 0.
            ordered.push((0, 0, id));
            Some(id)
        } else {
            None
        };
        ordered.extend(
            children
                .iter()
                .enumerate()
                .map(|(index, child)| (node.child_flow_order(index), index + 1, child.id)),
        );
        ordered.sort_by_key(|(order, index, _)| (*order, *index));
        let ids: Vec<_> = ordered.into_iter().map(|(_, _, id)| id).collect();
        (
            tree.new_with_children(style, &ids).map_err(taffy_error)?,
            text_box,
        )
    };
    Ok(BuiltNode {
        id,
        children,
        text_box,
    })
}

fn apply(
    node: &mut RenderNode,
    built: &BuiltNode,
    tree: &TaffyTree<TextContext>,
    origins: &HashMap<NodeId, (f32, f32)>,
    containing: Rect,
    viewport: Rect,
    measurer: &mut dyn TextMeasurer,
) -> Result<(), RenderError> {
    let layout = tree.layout(built.id).map_err(taffy_error)?;
    let origin = origins.get(&built.id).ok_or_else(|| {
        RenderError::FlowLayout("solver node has no containing-block origin".into())
    })?;
    node.bounds = Rect {
        x: origin.0,
        y: origin.1,
        width: layout.size.width,
        height: layout.size.height,
    };
    if ![
        node.bounds.x,
        node.bounds.y,
        node.bounds.width,
        node.bounds.height,
    ]
    .into_iter()
    .all(f32::is_finite)
        || node.bounds.width < 0.0
        || node.bounds.height < 0.0
    {
        return Err(RenderError::InvalidFlowStyle);
    }
    if let Some(style) = node.style.as_mut() {
        style.margin = EdgeInsets {
            top: layout.margin.top,
            right: layout.margin.right,
            bottom: layout.margin.bottom,
            left: layout.margin.left,
        };
        style.padding = EdgeInsets {
            top: layout.padding.top,
            right: layout.padding.right,
            bottom: layout.padding.bottom,
            left: layout.padding.left,
        };
        let content = style.content_box(node.bounds);
        style.width = Some(match style.box_sizing {
            BoxSizing::BorderBox => node.bounds.width,
            BoxSizing::ContentBox => content.width,
        });
        style.height = Some(match style.box_sizing {
            BoxSizing::BorderBox => node.bounds.height,
            BoxSizing::ContentBox => content.height,
        });
        if let Some(flow) = style.flow {
            let reference = if style.position == PositionMode::Fixed {
                viewport
            } else {
                containing
            };
            style.top = flow.inset.top.resolve(reference.height);
            style.bottom = flow.inset.bottom.resolve(reference.height);
            style.left = flow.inset.left.resolve(reference.width);
            style.right = flow.inset.right.resolve(reference.width);
        }
    }
    let style = node.style.unwrap_or_default();
    if node.text.is_some() {
        node.text_style.get_or_insert_with(TextStyle::default);
    }
    if let Some(text) = node.text.as_deref() {
        let content = style.content_box(node.bounds);
        let text_box = built
            .text_box
            .map(|id| tree.layout(id).map_err(taffy_error))
            .transpose()?;
        let mut plan = layout_text(
            text,
            node.text_style.unwrap_or_default(),
            Some(text_box.map_or(content.width, |layout| layout.size.width)),
            measurer,
        );
        if let Some(text_box) = text_box {
            let dx = node.bounds.x + text_box.location.x - content.x;
            let dy = node.bounds.y + text_box.location.y - content.y;
            plan.translate(dx, dy);
        }
        node.text_layout = Some(plan);
    }
    let positioned = if style.position != PositionMode::Static || style.transform.is_some() {
        style.padding_box(node.bounds)
    } else {
        containing
    };
    for (child, child_built) in node.children.iter_mut().zip(&built.children) {
        apply(
            child,
            child_built,
            tree,
            origins,
            positioned,
            viewport,
            measurer,
        )?;
    }
    Ok(())
}

/// Taffy hoists out-of-flow boxes to their containing block. Their location
/// is relative to that solver parent, which can differ from the WXML/paint
/// parent. Resolve the solver graph once instead of adding DOM-parent
/// offsets to absolute/fixed boxes a second time.
fn collect_origins(
    tree: &TaffyTree<TextContext>,
    id: NodeId,
    parent_origin: (f32, f32),
    hidden: bool,
    origins: &mut HashMap<NodeId, (f32, f32)>,
) -> Result<(), RenderError> {
    let layout = tree.layout(id).map_err(taffy_error)?;
    let hidden = hidden || tree.style(id).map_err(taffy_error)?.display == ts::Display::None;
    let origin = if hidden {
        (0.0, 0.0)
    } else {
        (
            parent_origin.0 + layout.location.x,
            parent_origin.1 + layout.location.y,
        )
    };
    origins.insert(id, origin);
    for child in tree.children(id).map_err(taffy_error)? {
        let style = tree.style(child).map_err(taffy_error)?;
        if hidden || style.display == ts::Display::None || !style.position.is_out_of_flow() {
            collect_origins(tree, child, origin, hidden, origins)?;
        }
    }
    for &child in tree.hoisted_children(id).map_err(taffy_error)? {
        collect_origins(tree, child, origin, hidden, origins)?;
    }
    Ok(())
}

pub(super) fn layout(
    root: &mut RenderNode,
    viewport: Rect,
    measurer: &mut dyn TextMeasurer,
) -> Result<(), RenderError> {
    let mut tree = TaffyTree::new();
    // Logical-pixel subcoordinates are part of the shared frame; each host
    // controls raster scaling independently. Rounding here loses geometry.
    tree.disable_rounding();
    let built = build(root, &mut tree, true, viewport)?;
    tree.compute_layout_with_measure(
        built.id,
        tg::Size {
            width: ts::AvailableSpace::Definite(viewport.width),
            height: ts::AvailableSpace::Definite(viewport.height),
        },
        |inputs, _, context, style| {
            let padding = style
                .padding
                .resolve_or_zero(inputs.parent_size.width, |_, _| 0.0);
            let border = style
                .border
                .resolve_or_zero(inputs.parent_size.width, |_, _| 0.0);
            let mut baselines = crate::text::TextBaselines::default();
            let mut output = taffy::compute_leaf_layout(
                inputs,
                style,
                |_, _| 0.0,
                |known, available| {
                    let Some(context) = context.as_deref() else {
                        return tg::Size::ZERO;
                    };
                    if let Some(replaced_image) = context.replaced_image {
                        return replaced_image.measure(available);
                    }
                    // Ordinary empty views also carry a TextContext. Their
                    // intrinsic size is zero, with no text baseline; measuring
                    // a synthetic space would needlessly discover host fonts.
                    if context.text.is_empty() {
                        return tg::Size {
                            width: known.width.unwrap_or(0.0),
                            height: known.height.unwrap_or(0.0),
                        };
                    }
                    let constraint = known.width.map_or_else(
                        || match available.width {
                            ts::AvailableSpace::Definite(value) => {
                                crate::text::TextMeasureConstraint::Definite(value.max(0.0))
                            }
                            ts::AvailableSpace::MinContent => {
                                crate::text::TextMeasureConstraint::MinContent
                            }
                            ts::AvailableSpace::MaxContent => {
                                crate::text::TextMeasureConstraint::MaxContent
                            }
                        },
                        crate::text::TextMeasureConstraint::Definite,
                    );
                    let (metrics, measured_baselines) = crate::text::measure_with_constraint(
                        &context.text,
                        context.style,
                        constraint,
                        measurer,
                    );
                    baselines = measured_baselines;
                    tg::Size {
                        width: known.width.unwrap_or(metrics.width),
                        height: known.height.unwrap_or(metrics.height),
                    }
                },
            );
            let top_inset = padding.top + border.top;
            output.baselines = taffy::tree::Baselines {
                first: baselines.first.map(|value| value + top_inset),
                last: baselines.last.map(|value| value + top_inset),
            };
            output
        },
    )
    .map_err(taffy_error)?;
    let mut origins = HashMap::new();
    collect_origins(
        &tree,
        built.id,
        (viewport.x, viewport.y),
        false,
        &mut origins,
    )?;
    apply(root, &built, &tree, &origins, viewport, viewport, measurer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        layout_tree_with_measurer, Color, FallbackTextMeasurer, LineHeight, RenderFrame, Renderer,
        ScrollOffset, SoftwareRenderer, TextMeasurement,
    };

    fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn block(id: &str, width: LayoutLength, height: LayoutLength) -> RenderNode {
        RenderNode::new(id, rect(0.0, 0.0, 0.0, 0.0)).with_style(crate::LayoutStyle {
            flow: Some(FlowStyle {
                width,
                height,
                ..FlowStyle::default()
            }),
            ..crate::LayoutStyle::default()
        })
    }

    fn flex(width: f32, height: f32) -> RenderNode {
        let mut node = block("root", LayoutLength::Px(width), LayoutLength::Px(height));
        // WXSS lowering supplies CSS's row initial value explicitly. The old
        // LayoutStyle direction default stays column for legacy frames.
        let style = node.style.as_mut().unwrap();
        style.direction = FlexDirection::Row;
        style.flow.as_mut().unwrap().context = FormattingContext::Flex;
        node
    }

    fn flow(node: &mut RenderNode) -> &mut FlowStyle {
        node.style.as_mut().unwrap().flow.as_mut().unwrap()
    }

    fn solve(node: &mut RenderNode, viewport: Rect) {
        layout_tree_with_measurer(node, viewport, &mut FallbackTextMeasurer).unwrap();
    }

    fn close(actual: f32, expected: f32) {
        assert!((actual - expected).abs() < 0.001, "{actual} != {expected}");
    }

    #[test]
    fn block_context_fills_width_and_ignores_flex_item_properties() {
        let viewport = rect(0.0, 0.0, 300.0, 200.0);
        let mut root = block("root", LayoutLength::Auto, LayoutLength::Auto);
        root.children = vec![
            block("first", LayoutLength::Auto, LayoutLength::Px(20.0)),
            block("second", LayoutLength::Auto, LayoutLength::Px(30.0)),
        ];
        flow(&mut root.children[0]).flex_grow = 5.0;
        flow(&mut root.children[0]).flex_basis = LayoutLength::Px(90.0);
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(0.0, 0.0, 300.0, 20.0));
        assert_eq!(root.children[1].bounds, rect(0.0, 20.0, 300.0, 30.0));
    }

    #[test]
    fn flex_grow_uses_basis_and_scaled_shrink_uses_intrinsic_bases() {
        let viewport = rect(0.0, 0.0, 300.0, 100.0);
        let mut root = flex(300.0, 100.0);
        for (id, grow) in [("one", 1.0), ("two", 2.0)] {
            let mut child = block(id, LayoutLength::Px(200.0), LayoutLength::Px(20.0));
            let style = flow(&mut child);
            style.flex_grow = grow;
            style.flex_basis = LayoutLength::Px(0.0);
            style.min_width = LayoutLength::Px(0.0);
            root.children.push(child);
        }
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(0.0, 0.0, 100.0, 20.0));
        assert_eq!(root.children[1].bounds, rect(100.0, 0.0, 200.0, 20.0));

        flow(&mut root).width = LayoutLength::Px(150.0);
        for child in &mut root.children {
            let style = flow(child);
            style.width = LayoutLength::Px(100.0);
            style.flex_grow = 0.0;
            style.flex_basis = LayoutLength::Auto;
        }
        solve(&mut root, viewport);
        close(root.children[0].bounds.width, 75.0);
        close(root.children[1].bounds.width, 75.0);
        // CSS shrink factors are scaled by each item's flex base size.
        flow(&mut root.children[1]).width = LayoutLength::Px(200.0);
        solve(&mut root, viewport);
        close(root.children[0].bounds.width, 50.0);
        close(root.children[1].bounds.width, 100.0);
    }

    #[test]
    fn wrapping_uses_distinct_row_and_column_gaps() {
        let viewport = rect(0.0, 0.0, 220.0, 120.0);
        let mut root = flex(220.0, 120.0);
        flow(&mut root).wrap = FlexWrap::Wrap;
        flow(&mut root).column_gap = LayoutLength::Px(10.0);
        flow(&mut root).row_gap = LayoutLength::Px(15.0);
        flow(&mut root).align_content = Some(AlignContent::Start);
        root.children = (0..3)
            .map(|i| {
                block(
                    &i.to_string(),
                    LayoutLength::Px(100.0),
                    LayoutLength::Px(20.0),
                )
            })
            .collect();
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(0.0, 0.0, 100.0, 20.0));
        assert_eq!(root.children[1].bounds, rect(110.0, 0.0, 100.0, 20.0));
        assert_eq!(root.children[2].bounds, rect(0.0, 35.0, 100.0, 20.0));
        flow(&mut root).wrap = FlexWrap::WrapReverse;
        flow(&mut root).align_content = Some(AlignContent::FlexStart);
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(0.0, 100.0, 100.0, 20.0));
        assert_eq!(root.children[2].bounds, rect(0.0, 65.0, 100.0, 20.0));
    }

    #[test]
    fn justify_alignment_auto_margins_and_reverse_share_final_geometry() {
        let viewport = rect(0.0, 0.0, 300.0, 100.0);
        let mut root = flex(300.0, 100.0);
        flow(&mut root).justify_content = Some(JustifyContent::SpaceBetween);
        flow(&mut root).align_items = Some(AlignItems::Center);
        root.children = vec![
            block("a", LayoutLength::Px(50.0), LayoutLength::Px(20.0)),
            block("b", LayoutLength::Px(50.0), LayoutLength::Px(40.0)),
        ];
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(0.0, 40.0, 50.0, 20.0));
        assert_eq!(root.children[1].bounds, rect(250.0, 30.0, 50.0, 40.0));
        root.style.as_mut().unwrap().direction = FlexDirection::RowReverse;
        solve(&mut root, viewport);
        close(root.children[0].bounds.x, 250.0);
        close(root.children[1].bounds.x, 0.0);
        root.style.as_mut().unwrap().direction = FlexDirection::Row;
        flow(&mut root).justify_content = None;
        flow(&mut root.children[1]).margin.left = LayoutLength::Auto;
        flow(&mut root.children[0]).align_self = Some(AlignItems::End);
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(0.0, 80.0, 50.0, 20.0));
        assert_eq!(root.children[1].bounds, rect(250.0, 30.0, 50.0, 40.0));
    }

    #[test]
    fn nested_percentages_resolve_against_actual_content_box() {
        let viewport = rect(0.0, 0.0, 600.0, 400.0);
        let mut root = block("root", LayoutLength::Px(200.0), LayoutLength::Px(80.0));
        flow(&mut root).padding = FlowEdges {
            top: LayoutLength::Px(10.0),
            right: LayoutLength::Px(10.0),
            bottom: LayoutLength::Px(10.0),
            left: LayoutLength::Px(10.0),
        };
        let mut child = block(
            "half",
            LayoutLength::Percent(0.5),
            LayoutLength::Percent(0.5),
        );
        child.children.push(block(
            "quarter",
            LayoutLength::Percent(0.5),
            LayoutLength::Percent(0.5),
        ));
        root.children.push(child);
        solve(&mut root, viewport);
        assert_eq!(root.bounds, rect(0.0, 0.0, 200.0, 80.0));
        assert_eq!(root.children[0].bounds, rect(10.0, 10.0, 90.0, 30.0));
        assert_eq!(
            root.children[0].children[0].bounds,
            rect(10.0, 10.0, 45.0, 15.0)
        );
        assert_eq!(
            flow(&mut root.children[0]).width,
            LayoutLength::Percent(0.5)
        );
        // Reflow must keep the authored percentage, not reuse its last used px.
        flow(&mut root).width = LayoutLength::Px(300.0);
        solve(&mut root, viewport);
        close(root.children[0].bounds.width, 140.0);
        close(root.children[0].children[0].bounds.width, 70.0);
    }

    #[test]
    fn percentage_padding_and_margin_use_containing_width() {
        let viewport = rect(0.0, 0.0, 200.0, 300.0);
        let mut root = block("root", LayoutLength::Px(200.0), LayoutLength::Px(300.0));
        let mut child = block("child", LayoutLength::Px(100.0), LayoutLength::Px(100.0));
        flow(&mut child).padding = FlowEdges {
            top: LayoutLength::Percent(0.1),
            right: LayoutLength::Percent(0.1),
            bottom: LayoutLength::Percent(0.1),
            left: LayoutLength::Percent(0.1),
        };
        flow(&mut child).margin.top = LayoutLength::Percent(0.05);
        root.children.push(child);
        solve(&mut root, viewport);
        let child = &root.children[0];
        assert_eq!(child.bounds, rect(0.0, 10.0, 100.0, 100.0));
        assert_eq!(
            child.style.unwrap().content_box(child.bounds),
            rect(20.0, 30.0, 60.0, 60.0)
        );
    }

    #[test]
    fn flex_growth_respects_min_and_max_without_rounding_fractional_values() {
        let viewport = rect(0.0, 0.0, 301.0, 50.0);
        let mut root = flex(301.0, 50.0);
        root.children = (0..3)
            .map(|i| {
                let mut child = block(&i.to_string(), LayoutLength::Auto, LayoutLength::Px(10.0));
                flow(&mut child).flex_grow = 1.0;
                flow(&mut child).flex_basis = LayoutLength::Px(0.0);
                child
            })
            .collect();
        solve(&mut root, viewport);
        close(root.children[0].bounds.width, 301.0 / 3.0);
        flow(&mut root.children[0]).max_width = LayoutLength::Px(50.0);
        flow(&mut root.children[1]).min_width = LayoutLength::Px(150.0);
        solve(&mut root, viewport);
        close(root.children[0].bounds.width, 50.0);
        close(root.children[1].bounds.width, 150.0);
        close(root.children[2].bounds.width, 101.0);
    }

    #[test]
    fn intrinsic_image_ratio_uses_resolved_percentage_and_allocated_flex_axes() {
        let viewport = rect(0.0, 0.0, 400.0, 300.0);
        let mut root = block("root", LayoutLength::Auto, LayoutLength::Auto);
        let mut parent = block("parent", LayoutLength::Px(200.0), LayoutLength::Px(100.0));
        let mut width_fix = block("width-fix", LayoutLength::Percent(0.5), LayoutLength::Auto);
        flow(&mut width_fix).aspect_ratio = Some(2.0);
        width_fix.image = Some(crate::RenderImage {
            resource: "source".into(),
            mode: crate::ImageMode::WidthFix,
        });
        parent.children.push(width_fix);
        root.children.push(parent);
        solve(&mut root, viewport);
        assert_eq!(
            root.children[0].children[0].bounds,
            rect(0.0, 0.0, 100.0, 50.0)
        );

        let mut root = flex(300.0, 200.0);
        flow(&mut root).align_items = Some(AlignItems::Start);
        let mut image = block("width-fix", LayoutLength::Px(300.0), LayoutLength::Auto);
        flow(&mut image).aspect_ratio = Some(2.0);
        image.image = Some(crate::RenderImage {
            resource: "source".into(),
            mode: crate::ImageMode::WidthFix,
        });
        flow(&mut image).flex_grow = 1.0;
        flow(&mut image).flex_basis = LayoutLength::Px(0.0);
        flow(&mut image).min_width = LayoutLength::Px(0.0);
        let mut reserved = block("reserved", LayoutLength::Px(100.0), LayoutLength::Px(10.0));
        flow(&mut reserved).flex_shrink = 0.0;
        root.children = vec![image, reserved];
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(0.0, 0.0, 200.0, 100.0));

        let mut root = block("root", LayoutLength::Px(300.0), LayoutLength::Px(200.0));
        let mut height_fix = block("height-fix", LayoutLength::Auto, LayoutLength::Percent(0.5));
        flow(&mut height_fix).aspect_ratio = Some(2.0);
        height_fix.image = Some(crate::RenderImage {
            resource: "source".into(),
            mode: crate::ImageMode::HeightFix,
        });
        root.children.push(height_fix);
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(0.0, 0.0, 200.0, 100.0));
        for ratio in [0.0, -1.0, f32::NAN, f32::INFINITY] {
            flow(&mut root.children[0]).aspect_ratio = Some(ratio);
            assert_eq!(
                flow(&mut root.children[0]).validate(),
                Err(RenderError::InvalidFlowStyle)
            );
        }
    }

    #[test]
    fn replaced_image_ratio_uses_allocated_content_axes_with_both_box_sizing_modes() {
        let viewport = rect(0.0, 0.0, 400.0, 400.0);
        for box_sizing in [BoxSizing::ContentBox, BoxSizing::BorderBox] {
            for (mode, direction, ratio, expected_outer, expected_content) in [
                (
                    crate::ImageMode::WidthFix,
                    FlexDirection::Row,
                    2.0,
                    rect(0.0, 0.0, 200.0, 104.0),
                    rect(8.0, 6.0, 184.0, 92.0),
                ),
                (
                    crate::ImageMode::HeightFix,
                    FlexDirection::Column,
                    0.5,
                    rect(0.0, 0.0, 110.0, 200.0),
                    rect(8.0, 6.0, 94.0, 188.0),
                ),
            ] {
                let mut root = flex(300.0, 300.0);
                root.style.as_mut().unwrap().direction = direction;
                flow(&mut root).align_items = Some(AlignItems::Start);
                let (width, height) = match mode {
                    crate::ImageMode::WidthFix => (LayoutLength::Px(300.0), LayoutLength::Auto),
                    _ => (LayoutLength::Auto, LayoutLength::Px(300.0)),
                };
                let mut image = block("image", width, height);
                let style = image.style.as_mut().unwrap();
                style.box_sizing = box_sizing;
                style.border = [crate::BorderSide {
                    width: 2.0,
                    color: crate::Color::BLACK,
                    style: crate::BorderStyle::Solid,
                }; 4];
                let image_flow = flow(&mut image);
                image_flow.aspect_ratio = Some(ratio);
                image_flow.min_width = LayoutLength::Px(0.0);
                image_flow.min_height = LayoutLength::Px(0.0);
                image_flow.padding = FlowEdges {
                    top: LayoutLength::Px(4.0),
                    right: LayoutLength::Px(6.0),
                    bottom: LayoutLength::Px(4.0),
                    left: LayoutLength::Px(6.0),
                };
                image.image = Some(crate::RenderImage {
                    resource: "source".into(),
                    mode,
                });
                let mut reserved =
                    block("reserved", LayoutLength::Px(100.0), LayoutLength::Px(100.0));
                flow(&mut reserved).flex_shrink = 0.0;
                root.children = vec![image, reserved];
                solve(&mut root, viewport);
                let image = &root.children[0];
                assert_eq!(image.bounds, expected_outer, "{box_sizing:?} {mode:?}");
                assert_eq!(
                    image.style.unwrap().content_box(image.bounds),
                    expected_content,
                    "content ratio: {box_sizing:?} {mode:?}"
                );
            }
        }

        // A column flex item's authored height 300 must shrink to 200 before
        // heightFix derives its automatic width, rather than freezing 150.
        let mut root = flex(300.0, 300.0);
        root.style.as_mut().unwrap().direction = FlexDirection::Column;
        flow(&mut root).align_items = Some(AlignItems::Start);
        let mut image = block("height-fix", LayoutLength::Auto, LayoutLength::Px(300.0));
        flow(&mut image).aspect_ratio = Some(0.5);
        flow(&mut image).min_height = LayoutLength::Px(0.0);
        image.image = Some(crate::RenderImage {
            resource: "source".into(),
            mode: crate::ImageMode::HeightFix,
        });
        let mut reserved = block("reserved", LayoutLength::Px(10.0), LayoutLength::Px(100.0));
        flow(&mut reserved).flex_shrink = 0.0;
        root.children = vec![image, reserved];
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(0.0, 0.0, 100.0, 200.0));
    }

    #[test]
    fn absolute_uses_nearest_positioned_ancestor_and_fixed_uses_viewport() {
        let viewport = rect(7.0, 11.0, 400.0, 300.0);
        let mut root = block("root", LayoutLength::Px(400.0), LayoutLength::Px(300.0));
        let mut ancestor = block(
            "positioned",
            LayoutLength::Px(200.0),
            LayoutLength::Px(100.0),
        );
        ancestor.style.as_mut().unwrap().position = PositionMode::Relative;
        flow(&mut ancestor).margin.left = LayoutLength::Px(40.0);
        flow(&mut ancestor).margin.top = LayoutLength::Px(30.0);
        let mut intermediate = block("static", LayoutLength::Px(80.0), LayoutLength::Px(60.0));
        flow(&mut intermediate).margin.left = LayoutLength::Px(20.0);
        flow(&mut intermediate).padding.top = LayoutLength::Px(10.0);
        let mut absolute = block(
            "absolute",
            LayoutLength::Percent(0.5),
            LayoutLength::Percent(0.5),
        );
        absolute.style.as_mut().unwrap().position = PositionMode::Absolute;
        flow(&mut absolute).inset.left = LayoutLength::Px(5.0);
        flow(&mut absolute).inset.top = LayoutLength::Px(6.0);
        let mut fixed = block("fixed", LayoutLength::Px(20.0), LayoutLength::Px(10.0));
        fixed.style.as_mut().unwrap().position = PositionMode::Fixed;
        flow(&mut fixed).inset.right = LayoutLength::Px(8.0);
        flow(&mut fixed).inset.bottom = LayoutLength::Px(9.0);
        intermediate.children = vec![absolute, fixed];
        ancestor.children.push(intermediate);
        root.children.push(ancestor);
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(47.0, 41.0, 200.0, 100.0));
        let children = &root.children[0].children[0].children;
        assert_eq!(children[0].bounds, rect(52.0, 47.0, 100.0, 50.0));
        assert_eq!(children[1].bounds, rect(379.0, 292.0, 20.0, 10.0));
    }

    #[test]
    fn root_offsets_and_small_root_do_not_change_initial_containing_block() {
        let viewport = rect(7.0, 11.0, 400.0, 300.0);
        let mut root = block("root", LayoutLength::Px(200.0), LayoutLength::Px(100.0));
        flow(&mut root).margin.left = LayoutLength::Px(20.0);
        flow(&mut root).margin.top = LayoutLength::Px(30.0);
        let mut absolute = block(
            "absolute",
            LayoutLength::Percent(0.5),
            LayoutLength::Px(10.0),
        );
        absolute.style.as_mut().unwrap().position = PositionMode::Absolute;
        flow(&mut absolute).inset.right = LayoutLength::Px(0.0);
        flow(&mut absolute).inset.top = LayoutLength::Px(0.0);
        let mut fixed = block("fixed", LayoutLength::Px(20.0), LayoutLength::Px(10.0));
        fixed.style.as_mut().unwrap().position = PositionMode::Fixed;
        flow(&mut fixed).inset.right = LayoutLength::Px(8.0);
        flow(&mut fixed).inset.bottom = LayoutLength::Px(9.0);
        root.children = vec![absolute, fixed];
        solve(&mut root, viewport);
        assert_eq!(root.bounds, rect(27.0, 41.0, 200.0, 100.0));
        assert_eq!(root.children[0].bounds, rect(207.0, 11.0, 200.0, 10.0));
        assert_eq!(root.children[1].bounds, rect(379.0, 292.0, 20.0, 10.0));
    }

    #[test]
    fn display_none_clears_geometry_including_out_of_flow_descendants() {
        let viewport = rect(0.0, 0.0, 100.0, 100.0);
        let mut root = flex(100.0, 100.0);
        let mut hidden = block("hidden", LayoutLength::Px(50.0), LayoutLength::Px(50.0));
        hidden.style.as_mut().unwrap().display = DisplayMode::None;
        let mut absolute = block("absolute", LayoutLength::Px(20.0), LayoutLength::Px(20.0));
        absolute.style.as_mut().unwrap().position = PositionMode::Absolute;
        hidden.children.push(absolute);
        root.children = vec![
            hidden,
            block("shown", LayoutLength::Px(30.0), LayoutLength::Px(20.0)),
        ];
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(0.0, 0.0, 0.0, 0.0));
        assert_eq!(
            root.children[0].children[0].bounds,
            rect(0.0, 0.0, 0.0, 0.0)
        );
        assert_eq!(root.children[1].bounds, rect(0.0, 0.0, 30.0, 20.0));
        assert_eq!(root.hit_test(10.0, 10.0).unwrap().id, "shown");
    }

    #[test]
    fn text_remeasures_at_assigned_flex_width_and_keeps_accepted_plan() {
        let viewport = rect(0.0, 0.0, 60.0, 100.0);
        let mut root = flex(60.0, 100.0);
        flow(&mut root).align_items = Some(AlignItems::Start);
        let mut label = block("text", LayoutLength::Auto, LayoutLength::Auto)
            .with_text("WWWWWWWW")
            .with_text_style(TextStyle {
                font_size: 10.0,
                line_height: LineHeight::Px(15.0),
                flow: None,
            });
        flow(&mut label).min_width = LayoutLength::Px(0.0);
        root.children = vec![
            label,
            block("reserved", LayoutLength::Px(40.0), LayoutLength::Px(20.0)),
        ];
        flow(&mut root.children[1]).flex_shrink = 0.0;
        solve(&mut root, viewport);
        let text = &root.children[0];
        assert_eq!(text.bounds, rect(0.0, 0.0, 20.0, 30.0));
        let plan = text.text_layout.as_ref().unwrap();
        assert_eq!(plan.measurement, TextMeasurement::Fallback);
        assert_eq!(plan.metrics.line_count, 2);
        assert_eq!(plan.glyphs[4].x, 0.0);
        close(plan.glyphs[4].baseline_y - plan.glyphs[0].baseline_y, 15.0);
        let frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root,
        };
        let before = frame.root.children[0].text_layout.clone();
        let mut renderer = SoftwareRenderer::new();
        renderer.commit(frame).unwrap();
        renderer.snapshot().unwrap();
        assert_eq!(
            renderer.last_frame().unwrap().root.children[0].text_layout,
            before
        );
    }

    #[test]
    fn text_flow_uses_word_min_content_and_replays_alignment_in_the_content_box() {
        let viewport = rect(0.0, 0.0, 100.0, 100.0);
        let text_style = TextStyle {
            font_size: 10.0,
            line_height: LineHeight::Px(20.0),
            flow: Some(crate::TextFlowStyle {
                white_space: crate::WhiteSpace::Normal,
                word_break: crate::WordBreak::Normal,
                text_align: crate::TextAlign::Center,
            }),
        };
        let mut root = block("root", LayoutLength::Auto, LayoutLength::Auto);
        let mut label = block("label", LayoutLength::Px(100.0), LayoutLength::Auto)
            .with_text("  AA   BB  ")
            .with_text_style(text_style);
        flow(&mut label).padding.left = LayoutLength::Px(10.0);
        flow(&mut label).padding.right = LayoutLength::Px(10.0);
        root.children.push(label);
        solve(&mut root, viewport);
        let label = &root.children[0];
        let content = label.style.unwrap().content_box(label.bounds);
        let plan = label.text_layout.as_ref().unwrap();
        let flow = plan.flow.as_ref().unwrap();
        assert_eq!(flow.available_width, Some(content.width));
        assert_eq!(plan.metrics.width, 25.0);
        assert_eq!(plan.glyphs[0].x, (content.width - 25.0) * 0.5);
        let frame = RenderFrame {
            images: Default::default(),
            frame_id: 1,
            viewport,
            root,
        };
        let mut renderer = SoftwareRenderer::new();
        renderer.commit(frame.clone()).unwrap();
        let mut stale = frame;
        stale.root.children[0]
            .text_layout
            .as_mut()
            .unwrap()
            .flow
            .as_mut()
            .unwrap()
            .available_width = Some(content.width + 1.0);
        assert_eq!(renderer.commit(stale), Err(RenderError::InvalidTextLayout));
        assert_eq!(renderer.last_frame().unwrap().frame_id, 1);
    }

    #[test]
    fn text_flow_flex_auto_minimum_preserves_words_and_explicit_zero_minimum_allows_overflow() {
        let viewport = rect(0.0, 0.0, 60.0, 100.0);
        let mut root = flex(60.0, 100.0);
        flow(&mut root).align_items = Some(AlignItems::Start);
        let label = block("label", LayoutLength::Auto, LayoutLength::Auto)
            .with_text("LONGWORD")
            .with_text_style(TextStyle {
                font_size: 10.0,
                line_height: LineHeight::Px(20.0),
                flow: Some(crate::TextFlowStyle::default()),
            });
        let mut fixed = block("reserved", LayoutLength::Px(40.0), LayoutLength::Px(20.0));
        flow(&mut fixed).flex_shrink = 0.0;
        root.children = vec![label, fixed];
        solve(&mut root, viewport);
        assert_eq!(
            root.children[0].bounds.width, 40.0,
            "automatic minimum is the unbreakable word, not a scalar"
        );
        flow(&mut root.children[0]).min_width = LayoutLength::Px(0.0);
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds.width, 20.0);
        let plan = root.children[0].text_layout.as_ref().unwrap();
        assert_eq!(plan.metrics.line_count, 1);
        assert_eq!(plan.metrics.width, 40.0);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_font_is_remeasured_after_flex_assigns_available_width() {
        let mut renderer = crate::SkiaRenderer::new();
        let font = renderer
            .canvas
            .native_fonts
            .for_character('W', 10.0)
            .expect("native allocation conformance requires a font containing W");
        let advance = font.measure_str("W", None).0;
        assert!(advance > 0.0);
        let viewport = rect(0.0, 0.0, advance * 4.1, 100.0);
        let mut root = flex(viewport.width, viewport.height);
        flow(&mut root).align_items = Some(AlignItems::Start);
        let mut text = block("text", LayoutLength::Auto, LayoutLength::Auto)
            .with_text("WWWW")
            .with_text_style(TextStyle {
                font_size: 10.0,
                line_height: LineHeight::Px(15.0),
                flow: None,
            });
        flow(&mut text).min_width = LayoutLength::Px(0.0);
        let mut fixed = block(
            "reserved",
            LayoutLength::Px(advance * 2.0),
            LayoutLength::Px(10.0),
        );
        flow(&mut fixed).flex_shrink = 0.0;
        root.children = vec![text, fixed];
        renderer.layout_tree(&mut root, viewport).unwrap();
        let text = &root.children[0];
        close(text.bounds.width, advance * 2.1);
        close(text.bounds.height, 30.0);
        let plan = text.text_layout.as_ref().unwrap();
        assert_eq!(plan.measurement, TextMeasurement::Native);
        assert_eq!(plan.metrics.line_count, 2);
        close(plan.glyphs[1].x, advance);
        close(plan.glyphs[2].x, 0.0);
        close(plan.glyphs[2].baseline_y - plan.glyphs[0].baseline_y, 15.0);
        let accepted = plan.clone();
        renderer
            .commit(RenderFrame {
                images: std::collections::BTreeMap::new(),
                frame_id: 1,
                viewport,
                root,
            })
            .unwrap();
        assert_eq!(
            renderer.last_frame().unwrap().root.children[0]
                .text_layout
                .as_ref(),
            Some(&accepted)
        );
        assert!(renderer
            .snapshot()
            .unwrap()
            .pixels
            .chunks(4)
            .any(|pixel| pixel[3] > 0));
    }

    #[test]
    fn flex_scroll_extent_hits_and_paint_use_same_rectangles() {
        let viewport = rect(0.0, 0.0, 100.0, 50.0);
        let mut root = flex(100.0, 50.0);
        root.scroll_container = true;
        root.scroll_offset = Some(ScrollOffset {
            scroll_left: 30.0,
            scroll_top: 0.0,
        });
        root.background = Some(Color::WHITE);
        for id in ["first", "second"] {
            let mut child = block(id, LayoutLength::Px(80.0), LayoutLength::Px(50.0));
            flow(&mut child).flex_shrink = 0.0;
            child.background = Some(if id == "first" {
                Color::BLACK
            } else {
                Color {
                    red: 255,
                    green: 0,
                    blue: 0,
                    alpha: 255,
                }
            });
            root.children.push(child);
        }
        solve(&mut root, viewport);
        assert_eq!(root.scroll_content_extent(), (160.0, 50.0));
        assert_eq!(root.hit_test(10.5, 20.5).unwrap().id, "first");
        assert_eq!(root.hit_test(60.5, 20.5).unwrap().id, "second");
        let frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root,
        };
        let geometry = frame.node_geometries();
        assert_eq!(geometry[1].bounds, rect(-30.0, 0.0, 80.0, 50.0));
        assert_eq!(geometry[2].bounds, rect(50.0, 0.0, 80.0, 50.0));
        let mut renderer = SoftwareRenderer::new();
        renderer.commit(frame).unwrap();
        let image = renderer.snapshot().unwrap();
        let sample = |x: usize| &image.pixels[(20 * 100 + x) * 4..(20 * 100 + x + 1) * 4];
        assert_eq!(sample(10), [0, 0, 0, 255]);
        assert_eq!(sample(60), [255, 0, 0, 255]);
    }

    #[test]
    fn viewport_fixed_escapes_scroll_and_clips_but_keeps_opacity_order_and_event_ancestry() {
        let viewport = rect(0.0, 0.0, 100.0, 100.0);
        let mut root = block("root", LayoutLength::Px(100.0), LayoutLength::Px(100.0));
        root.style.as_mut().unwrap().position = PositionMode::Relative;
        root.scroll_container = true;
        root.scroll_offset = Some(ScrollOffset {
            scroll_left: 0.0,
            scroll_top: 50.0,
        });
        root.background = Some(Color::WHITE);
        let mut filler = block("filler", LayoutLength::Px(100.0), LayoutLength::Px(200.0));
        filler.background = Some(Color::WHITE);
        let mut clipped = block("clipped", LayoutLength::Px(10.0), LayoutLength::Px(10.0));
        clipped.style.as_mut().unwrap().position = PositionMode::Absolute;
        flow(&mut clipped).inset.left = LayoutLength::Px(40.0);
        flow(&mut clipped).inset.top = LayoutLength::Px(60.0);
        clipped
            .computed_style
            .insert("overflow".into(), "hidden".into());
        clipped.opacity = 0.5;
        let mut fixed = block("fixed", LayoutLength::Px(20.0), LayoutLength::Px(20.0));
        fixed.style.as_mut().unwrap().position = PositionMode::Fixed;
        flow(&mut fixed).inset.left = LayoutLength::Px(5.0);
        flow(&mut fixed).inset.top = LayoutLength::Px(5.0);
        fixed.background = Some(Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        });
        clipped.children.push(fixed);
        let mut later = block("later", LayoutLength::Px(4.0), LayoutLength::Px(4.0));
        later.style.as_mut().unwrap().position = PositionMode::Absolute;
        flow(&mut later).inset.left = LayoutLength::Px(8.0);
        flow(&mut later).inset.top = LayoutLength::Px(58.0);
        later.background = Some(Color {
            red: 0,
            green: 0,
            blue: 255,
            alpha: 255,
        });
        root.children = vec![filler, clipped, later];
        solve(&mut root, viewport);
        let fixed = &root.children[1].children[0];
        assert_eq!(fixed.bounds, rect(5.0, 5.0, 20.0, 20.0));
        assert_eq!(root.scroll_content_extent(), (100.0, 200.0));
        assert_eq!(root.scroll_target_offset(fixed), None);
        assert_eq!(
            root.hit_test_path(6.5, 6.5)
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            ["root", "clipped", "fixed"]
        );
        assert_eq!(root.hit_test(9.5, 9.5).unwrap().id, "later");
        let frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root,
        };
        assert_eq!(
            frame.node_geometries()[3].bounds,
            rect(5.0, 5.0, 20.0, 20.0)
        );
        let mut software = SoftwareRenderer::new();
        software.commit(frame.clone()).unwrap();
        let mut native = crate::SkiaRenderer::new();
        native.commit(frame.clone()).unwrap();
        for image in [software.snapshot().unwrap(), native.snapshot().unwrap()] {
            let sample =
                |x: usize, y: usize| &image.pixels[(y * 100 + x) * 4..(y * 100 + x + 1) * 4];
            assert_eq!(sample(6, 6), [255, 127, 127, 255]);
            assert_eq!(sample(9, 9), [0, 0, 255, 255]);
            assert_eq!(sample(30, 30), [255, 255, 255, 255]);
        }
        #[cfg(feature = "skia-backend")]
        {
            // Exercise the same mapping used by native GPU hosts on a real
            // raster surface; this does not claim GPU execution.
            let mut target = crate::skia::surfaces::raster_n32_premul((200, 300)).unwrap();
            crate::SkiaRenderer::draw_frame_to_target(
                target.canvas(),
                &frame,
                200,
                300,
                &mut native.canvas.native_fonts,
            )
            .unwrap();
            let image = crate::native_raster::readback_native(&mut target, 1, 200, 300).unwrap();
            let sample =
                |x: usize, y: usize| &image.pixels[(y * 200 + x) * 4..(y * 200 + x + 1) * 4];
            assert_eq!(sample(13, 19), [255, 127, 127, 255]);
            assert_eq!(sample(19, 28), [0, 0, 255, 255]);
        }
    }

    #[test]
    fn transformed_fixed_containing_block_fails_before_replacing_accepted_frame() {
        let viewport = rect(0.0, 0.0, 100.0, 100.0);
        let mut root = flex(100.0, 100.0);
        let mut renderer = SoftwareRenderer::new();
        renderer
            .commit(RenderFrame {
                images: std::collections::BTreeMap::new(),
                frame_id: 1,
                viewport,
                root: root.clone(),
            })
            .unwrap();
        root.style.as_mut().unwrap().transform = Some(crate::Transform2D::IDENTITY);
        let mut fixed = block("fixed", LayoutLength::Px(10.0), LayoutLength::Px(10.0));
        fixed.style.as_mut().unwrap().position = PositionMode::Fixed;
        root.children.push(fixed);
        let error = RenderError::Unsupported("transformed-fixed-containing-block");
        assert_eq!(
            layout_tree_with_measurer(&mut root, viewport, &mut FallbackTextMeasurer),
            Err(error.clone())
        );
        assert_eq!(
            renderer.commit(RenderFrame {
                images: std::collections::BTreeMap::new(),
                frame_id: 2,
                viewport,
                root
            }),
            Err(error)
        );
        assert_eq!(renderer.last_frame().unwrap().frame_id, 1);
    }

    #[test]
    fn flex_order_changes_solver_positions_without_reordering_the_public_tree() {
        for (direction, expected) in [
            (FlexDirection::Row, [60.0, 0.0, 40.0, 20.0]),
            (FlexDirection::RowReverse, [20.0, 80.0, 40.0, 60.0]),
            (FlexDirection::Column, [60.0, 0.0, 40.0, 20.0]),
            (FlexDirection::ColumnReverse, [20.0, 80.0, 40.0, 60.0]),
        ] {
            let viewport = rect(0.0, 0.0, 100.0, 100.0);
            let mut root = flex(100.0, 100.0);
            root.style.as_mut().unwrap().direction = direction;
            for (id, order) in [("a", i32::MAX), ("b", i32::MIN), ("c", 0), ("d", i32::MIN)] {
                let mut child = block(id, LayoutLength::Px(20.0), LayoutLength::Px(20.0));
                flow(&mut child).order = order;
                root.children.push(child);
            }
            layout_tree_with_measurer(&mut root, viewport, &mut FallbackTextMeasurer).unwrap();
            assert_eq!(
                root.children
                    .iter()
                    .map(|node| node.id.as_str())
                    .collect::<Vec<_>>(),
                ["a", "b", "c", "d"]
            );
            let row = matches!(direction, FlexDirection::Row | FlexDirection::RowReverse);
            for (child, value) in root.children.iter().zip(expected) {
                let coordinate = if row { child.bounds.x } else { child.bounds.y };
                assert_eq!(coordinate, value, "{direction:?} {}", child.id);
                let (x, y) = (child.bounds.x + 1.0, child.bounds.y + 1.0);
                assert_eq!(root.hit_test(x, y).unwrap().id, child.id);
            }
            let frame = RenderFrame {
                frame_id: 1,
                viewport,
                root,
                images: Default::default(),
            };
            assert_eq!(
                frame
                    .node_geometries()
                    .iter()
                    .map(|geometry| geometry.node.id.as_str())
                    .collect::<Vec<_>>(),
                ["root", "a", "b", "c", "d"]
            );
        }
    }

    #[test]
    fn flex_order_precedes_wrapping_and_preserves_stable_ordinal_groups() {
        let viewport = rect(0.0, 0.0, 45.0, 100.0);
        let mut root = flex(45.0, 100.0);
        flow(&mut root).wrap = FlexWrap::Wrap;
        flow(&mut root).align_content = Some(AlignContent::FlexStart);
        for (id, order) in [("last", 2), ("first", -1), ("second", -1), ("third", 0)] {
            let mut child = block(id, LayoutLength::Px(20.0), LayoutLength::Px(10.0));
            flow(&mut child).order = order;
            root.children.push(child);
        }
        layout_tree_with_measurer(&mut root, viewport, &mut FallbackTextMeasurer).unwrap();
        let boxes: Vec<_> = root.children.iter().map(|node| node.bounds).collect();
        assert_eq!(
            boxes,
            [
                rect(20.0, 10.0, 20.0, 10.0),
                rect(0.0, 0.0, 20.0, 10.0),
                rect(20.0, 0.0, 20.0, 10.0),
                rect(0.0, 10.0, 20.0, 10.0)
            ]
        );
    }

    #[test]
    fn positioned_phases_and_flex_z_index_take_precedence_over_ordinal_order() {
        use crate::{Renderer, SkiaRenderer};
        let assert_paint_and_hit = |frame: &RenderFrame, target: &str, red: u8| {
            assert_eq!(frame.root.hit_test(1.0, 1.0).unwrap().id, target);
            let mut software = SoftwareRenderer::new();
            let mut native = SkiaRenderer::new();
            software.commit(frame.clone()).unwrap();
            native.commit(frame.clone()).unwrap();
            for snapshot in [software.snapshot().unwrap(), native.snapshot().unwrap()] {
                assert_eq!(&snapshot.pixels[..4], &[red, 0, 0, 255]);
            }
        };
        for flex_parent in [true, false] {
            let viewport = rect(0.0, 0.0, 20.0, 20.0);
            let mut root = flex(20.0, 20.0);
            if !flex_parent {
                flow(&mut root).context = FormattingContext::Block;
            }
            for (index, (order, position, z_index)) in [
                (4, PositionMode::Static, None),
                (-1, PositionMode::Static, None),
                (i32::MAX, PositionMode::Absolute, None),
                (i32::MIN, PositionMode::Fixed, None),
                (-5, PositionMode::Static, Some(1)),
                (4, PositionMode::Static, None),
            ]
            .into_iter()
            .enumerate()
            {
                let mut child = block(
                    &format!("n{index}"),
                    LayoutLength::Px(10.0),
                    LayoutLength::Px(10.0),
                );
                flow(&mut child).order = order;
                child.style.as_mut().unwrap().position = position;
                child.style.as_mut().unwrap().z_index = z_index;
                child.bounds = rect(0.0, 0.0, 10.0, 10.0);
                child.z_index = z_index.unwrap_or(0);
                child.background = Some(Color {
                    red: index as u8 * 30,
                    green: 0,
                    blue: 0,
                    alpha: 255,
                });
                root.children.push(child);
            }
            let mut frame = RenderFrame {
                frame_id: 1,
                viewport,
                root,
                images: Default::default(),
            };
            // Static z-index applies to flex items, but not ordinary blocks.
            // In block mode the fixed context wins over every static box.
            assert_paint_and_hit(
                &frame,
                if flex_parent { "n4" } else { "n3" },
                if flex_parent { 120 } else { 90 },
            );
            frame.root.children[4].style.as_mut().unwrap().display = DisplayMode::None;
            frame.root.children[5].style.as_mut().unwrap().display = DisplayMode::None;
            // A static flex item's positive order cannot move it above the
            // positioned phase. Authored MIN/MAX orders do not affect the
            // out-of-flow boxes, whose effective ordinal group remains zero.
            assert_paint_and_hit(&frame, "n3", 90);
            frame.root.children[0].style.as_mut().unwrap().position = PositionMode::Relative;
            // Once n0 enters the positioned phase, its flex order 4 breaks
            // the level-zero tie. In block mode document order still wins.
            assert_paint_and_hit(
                &frame,
                if flex_parent { "n0" } else { "n3" },
                if flex_parent { 0 } else { 90 },
            );
        }
    }

    #[test]
    fn order_wire_defaults_and_anonymous_text_boundary_are_explicit_and_atomic() {
        assert_eq!(serde_json::from_str::<FlowStyle>("{}").unwrap().order, 0);
        assert!(serde_json::to_value(FlowStyle::default())
            .unwrap()
            .get("order")
            .is_none());
        for value in ["1.5", "2147483648", "-2147483649", "null", "\"1\""] {
            assert!(serde_json::from_str::<FlowStyle>(&format!("{{\"order\":{value}}}")).is_err());
        }
        let viewport = rect(0.0, 0.0, 20.0, 20.0);
        let mut root = flex(20.0, 20.0).with_text("anonymous");
        let child = block("ordered", LayoutLength::Px(5.0), LayoutLength::Px(5.0));
        root.children.push(child);
        layout_tree_with_measurer(&mut root, viewport, &mut FallbackTextMeasurer).unwrap();
        assert!(root.text_layout.is_some());
        flow(&mut root.children[0]).order = -1;
        let before = root.clone();
        assert_eq!(
            layout_tree_with_measurer(&mut root, viewport, &mut FallbackTextMeasurer),
            Err(RenderError::Unsupported("ordered-anonymous-flex-text"))
        );
        assert_eq!(root, before);
        let mut renderer = crate::SkiaRenderer::new();
        renderer
            .commit(RenderFrame {
                frame_id: 1,
                viewport,
                root: RenderNode::new("accepted", viewport),
                images: Default::default(),
            })
            .unwrap();
        let pixels = renderer.snapshot().unwrap();
        assert_eq!(
            renderer.commit(RenderFrame {
                frame_id: 2,
                viewport,
                root,
                images: Default::default()
            }),
            Err(RenderError::Unsupported("ordered-anonymous-flex-text"))
        );
        assert_eq!(renderer.last_frame().unwrap().frame_id, 1);
        assert_eq!(renderer.snapshot().unwrap(), pixels);
    }

    #[test]
    fn transformed_static_and_positioned_absolute_containing_blocks_share_paint_and_hits() {
        let viewport = rect(0.0, 0.0, 400.0, 300.0);
        for position in [PositionMode::Static, PositionMode::Relative] {
            for (dx, dy) in [(0.0, 0.0), (12.0, 9.0)] {
                let mut root = block("root", LayoutLength::Auto, LayoutLength::Auto);
                root.background = Some(Color::WHITE);
                let mut parent = block(
                    "transformed",
                    LayoutLength::Px(200.0),
                    LayoutLength::Px(100.0),
                );
                parent.style.as_mut().unwrap().position = position;
                parent.style.as_mut().unwrap().transform = Some(crate::Transform2D {
                    e: dx,
                    f: dy,
                    ..crate::Transform2D::IDENTITY
                });
                parent.style.as_mut().unwrap().border = [crate::BorderSide {
                    width: 2.0,
                    color: Color::BLACK,
                    style: crate::BorderStyle::Solid,
                }; 4];
                flow(&mut parent).padding = FlowEdges {
                    top: LayoutLength::Px(10.0),
                    right: LayoutLength::Px(10.0),
                    bottom: LayoutLength::Px(10.0),
                    left: LayoutLength::Px(10.0),
                };
                flow(&mut parent).margin.left = LayoutLength::Px(40.0);
                if position == PositionMode::Static {
                    // Establishing a containing block must not turn authored
                    // static inset declarations into relative displacement.
                    flow(&mut parent).inset.left = LayoutLength::Px(700.0);
                    flow(&mut parent).inset.top = LayoutLength::Percent(0.9);
                    flow(&mut parent).inset.right = LayoutLength::Px(800.0);
                    flow(&mut parent).inset.bottom = LayoutLength::Px(900.0);
                }
                let mut intermediate =
                    block("static", LayoutLength::Px(80.0), LayoutLength::Px(50.0));
                flow(&mut intermediate).margin.left = LayoutLength::Px(7.0);
                flow(&mut intermediate).margin.top = LayoutLength::Px(5.0);
                let mut absolute = block(
                    "absolute",
                    LayoutLength::Percent(0.5),
                    LayoutLength::Percent(0.5),
                );
                absolute.background = Some(Color {
                    red: 0,
                    green: 0,
                    blue: 255,
                    alpha: 255,
                });
                absolute.style.as_mut().unwrap().position = PositionMode::Absolute;
                flow(&mut absolute).inset.left = LayoutLength::Percent(0.25);
                flow(&mut absolute).inset.top = LayoutLength::Percent(0.25);
                intermediate.children.push(absolute);
                parent.children.push(intermediate);
                root.children = vec![
                    block("before", LayoutLength::Px(10.0), LayoutLength::Px(20.0)),
                    parent,
                    block("after", LayoutLength::Px(10.0), LayoutLength::Px(20.0)),
                ];
                solve(&mut root, viewport);
                assert_eq!(root.children[1].style.unwrap().position, position);
                assert_eq!(root.children[1].bounds, rect(40.0, 20.0, 200.0, 100.0));
                assert_eq!(root.children[2].bounds, rect(0.0, 120.0, 10.0, 20.0));
                let absolute = &root.children[1].children[0].children[0];
                // The 196x96 padding box is the containing block; the static
                // intermediate's own margin/size must not contribute again.
                assert_eq!(absolute.bounds, rect(91.0, 46.0, 98.0, 48.0));
                close(absolute.style.unwrap().left.unwrap(), 49.0);
                close(absolute.style.unwrap().top.unwrap(), 24.0);
                let frame = RenderFrame {
                    images: std::collections::BTreeMap::new(),
                    frame_id: 1,
                    viewport,
                    root,
                };
                let geometry = frame
                    .node_geometries()
                    .into_iter()
                    .find(|entry| entry.node.id == "absolute")
                    .unwrap();
                assert_eq!(geometry.bounds, rect(91.0 + dx, 46.0 + dy, 98.0, 48.0));
                let x = (92.0 + dx) as usize;
                let y = (47.0 + dy) as usize;
                assert_eq!(
                    frame.root.hit_test(x as f32, y as f32).unwrap().id,
                    "absolute"
                );
                let mut software = SoftwareRenderer::new();
                software.commit(frame.clone()).unwrap();
                let mut snapshots = vec![software.snapshot().unwrap()];
                #[cfg(feature = "skia-backend")]
                {
                    let mut native = crate::SkiaRenderer::new();
                    native.commit(frame).unwrap();
                    snapshots.push(native.snapshot().unwrap());
                }
                for image in snapshots.drain(..) {
                    assert_eq!(
                        &image.pixels[(y * 400 + x) * 4..(y * 400 + x + 1) * 4],
                        [0, 0, 255, 255]
                    );
                }
            }
        }
    }

    #[test]
    fn transformed_static_absolute_text_resolves_percent_insets_and_available_width() {
        let viewport = rect(0.0, 0.0, 400.0, 300.0);
        let mut root = block("root", LayoutLength::Auto, LayoutLength::Auto);
        let mut parent = block(
            "transformed",
            LayoutLength::Px(200.0),
            LayoutLength::Px(100.0),
        );
        parent.style.as_mut().unwrap().transform = Some(crate::Transform2D::IDENTITY);
        flow(&mut parent).margin.left = LayoutLength::Px(40.0);
        flow(&mut parent).margin.top = LayoutLength::Px(20.0);
        let mut intermediate = block("static", LayoutLength::Px(20.0), LayoutLength::Px(10.0));
        let mut text = block("text", LayoutLength::Auto, LayoutLength::Auto)
            .with_text("W".repeat(30))
            .with_text_style(TextStyle {
                font_size: 10.0,
                line_height: LineHeight::Px(10.0),
                flow: None,
            });
        text.style.as_mut().unwrap().position = PositionMode::Absolute;
        flow(&mut text).inset.left = LayoutLength::Percent(0.25);
        flow(&mut text).inset.right = LayoutLength::Percent(0.25);
        flow(&mut text).inset.top = LayoutLength::Percent(0.1);
        intermediate.children.push(text);
        parent.children.push(intermediate);
        root.children.push(parent);
        solve(&mut root, viewport);
        let text = &root.children[0].children[0].children[0];
        assert_eq!(text.bounds, rect(90.0, 30.0, 100.0, 20.0));
        assert_eq!(text.style.unwrap().left, Some(50.0));
        assert_eq!(text.style.unwrap().right, Some(50.0));
        assert_eq!(text.style.unwrap().top, Some(10.0));
        let plan = text.text_layout.as_ref().unwrap();
        assert_eq!(plan.metrics.line_count, 2);
        assert_eq!(plan.metrics.width, 100.0);
        assert_eq!(plan.metrics.height, 20.0);
        #[cfg(feature = "skia-backend")]
        {
            let mut native = crate::SkiaRenderer::new();
            native.layout_tree(&mut root, viewport).unwrap();
            let text = &root.children[0].children[0].children[0];
            let plan = text.text_layout.as_ref().unwrap();
            assert_eq!(text.bounds.width, 100.0);
            assert_eq!(plan.measurement, TextMeasurement::Native);
            assert!(plan.metrics.width <= 100.0);
            assert!(plan.metrics.line_count > 1);
            assert_eq!(text.bounds.height, plan.metrics.height);
        }
    }

    #[test]
    fn baseline_alignment_uses_text_baselines_including_padding_and_borders() {
        let viewport = rect(0.0, 0.0, 100.0, 100.0);
        let mut root = flex(100.0, 100.0);
        flow(&mut root).align_items = Some(AlignItems::Baseline);
        root.children = [10.0, 20.0]
            .into_iter()
            .enumerate()
            .map(|(i, size)| {
                block(&i.to_string(), LayoutLength::Px(20.0), LayoutLength::Auto)
                    .with_text("A")
                    .with_text_style(TextStyle {
                        font_size: size,
                        line_height: LineHeight::Px(size),
                        flow: None,
                    })
            })
            .collect();
        flow(&mut root.children[0]).padding.top = LayoutLength::Px(3.0);
        root.children[0].style.as_mut().unwrap().border[0] = crate::BorderSide {
            width: 2.0,
            color: Color::BLACK,
            style: crate::BorderStyle::Solid,
        };
        solve(&mut root, viewport);
        let baseline = |node: &RenderNode| {
            node.style.unwrap().content_box(node.bounds).y
                + node.text_layout.as_ref().unwrap().glyphs[0].baseline_y
        };
        close(baseline(&root.children[0]), baseline(&root.children[1]));
        close(root.children[0].bounds.y, 4.0);
        close(root.children[1].bounds.y, 0.0);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_baseline_alignment_matches_the_accepted_glyph_positions() {
        let viewport = rect(0.0, 0.0, 200.0, 100.0);
        let mut root = flex(200.0, 100.0);
        flow(&mut root).align_items = Some(AlignItems::Baseline);
        root.children = [10.0, 20.0]
            .into_iter()
            .enumerate()
            .map(|(i, size)| {
                block(&i.to_string(), LayoutLength::Px(50.0), LayoutLength::Auto)
                    .with_text("Wj")
                    .with_text_style(TextStyle {
                        font_size: size,
                        line_height: LineHeight::Px(size),
                        flow: None,
                    })
            })
            .collect();
        flow(&mut root.children[0]).padding.top = LayoutLength::Px(3.0);
        let mut renderer = crate::SkiaRenderer::new();
        renderer.layout_tree(&mut root, viewport).unwrap();
        let baseline = |node: &RenderNode| {
            node.style.unwrap().content_box(node.bounds).y
                + node.text_layout.as_ref().unwrap().glyphs[0].baseline_y
        };
        close(baseline(&root.children[0]), baseline(&root.children[1]));
        for node in &root.children {
            assert_eq!(
                node.text_layout.as_ref().unwrap().measurement,
                TextMeasurement::Native
            );
        }
    }

    #[test]
    fn root_auto_host_extent_uses_typed_padding_and_hidden_rectangles_stay_zero() {
        let viewport = rect(0.0, 0.0, 300.0, 100.0);
        let mut root = block("root", LayoutLength::Auto, LayoutLength::Auto);
        root.style.as_mut().unwrap().box_sizing = BoxSizing::ContentBox;
        flow(&mut root).padding = FlowEdges {
            top: LayoutLength::Px(20.0),
            right: LayoutLength::Px(20.0),
            bottom: LayoutLength::Px(20.0),
            left: LayoutLength::Px(20.0),
        };
        let mut positioned = block("positioned", LayoutLength::Px(50.0), LayoutLength::Px(50.0));
        positioned.style.as_mut().unwrap().position = PositionMode::Relative;
        flow(&mut positioned).inset.left = LayoutLength::Px(40.0);
        flow(&mut positioned).inset.top = LayoutLength::Px(30.0);
        let mut hidden = block("hidden", LayoutLength::Px(10.0), LayoutLength::Px(10.0));
        hidden.style.as_mut().unwrap().display = DisplayMode::None;
        positioned.children.push(hidden);
        root.children.push(positioned);
        solve(&mut root, viewport);
        assert_eq!(root.bounds, viewport);
        let mut frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root,
        };
        assert_eq!(
            frame.root.children[0].children[0].bounds,
            rect(0.0, 0.0, 0.0, 0.0)
        );
        assert_eq!(frame.node_geometries()[2].bounds, rect(0.0, 0.0, 0.0, 0.0));
        frame.root.children[0].style.as_mut().unwrap().transform = Some(crate::Transform2D {
            e: 100.0,
            f: 200.0,
            ..crate::Transform2D::IDENTITY
        });
        assert_eq!(frame.node_geometries()[2].bounds, rect(0.0, 0.0, 0.0, 0.0));
    }

    #[test]
    fn legacy_missing_flow_still_uses_original_column_layout() {
        let viewport = rect(0.0, 0.0, 100.0, 100.0);
        let original = crate::LayoutStyle::default();
        let serialized = serde_json::to_value(original).unwrap();
        assert!(serialized.get("flow").is_none());
        let deserialized: crate::LayoutStyle = serde_json::from_value(serialized).unwrap();
        assert_eq!(deserialized.flow, None);
        let mut root = RenderNode::new("root", viewport).with_style(deserialized);
        root.children = vec![
            RenderNode::new("a", rect(0.0, 0.0, 0.0, 0.0)).with_style(crate::LayoutStyle {
                width: Some(20.0),
                height: Some(10.0),
                ..original
            }),
            RenderNode::new("b", rect(0.0, 0.0, 0.0, 0.0)).with_style(crate::LayoutStyle {
                width: Some(30.0),
                height: Some(15.0),
                ..original
            }),
        ];
        solve(&mut root, viewport);
        assert_eq!(root.children[0].bounds, rect(0.0, 0.0, 20.0, 10.0));
        assert_eq!(root.children[1].bounds, rect(0.0, 10.0, 30.0, 15.0));
    }

    #[test]
    fn invalid_typed_lengths_fail_explicitly_and_flow_roundtrips() {
        let viewport = rect(0.0, 0.0, 100.0, 100.0);
        let mut root = flex(100.0, 100.0);
        flow(&mut root).column_gap = LayoutLength::Auto;
        assert_eq!(
            layout_tree_with_measurer(&mut root, viewport, &mut FallbackTextMeasurer),
            Err(RenderError::InvalidFlowStyle)
        );
        flow(&mut root).column_gap = LayoutLength::Percent(0.1);
        flow(&mut root).min_width = LayoutLength::Px(-1.0);
        assert_eq!(
            layout_tree_with_measurer(&mut root, viewport, &mut FallbackTextMeasurer),
            Err(RenderError::InvalidFlowStyle)
        );
        flow(&mut root).min_width = LayoutLength::Px(0.0);
        let json = serde_json::to_string(&root).unwrap();
        assert_eq!(serde_json::from_str::<RenderNode>(&json).unwrap(), root);
    }
}
