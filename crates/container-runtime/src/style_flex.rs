//! Lower cascaded layout values after projection and inherited typography.
//! Only the formatter resolves percentages; hosts, selectors, paint and hit
//! testing must consume the resulting shared geometry.

use super::{BridgeError, BridgeErrorCode, Rect, RenderNode};
use container_ir::{parse_wxss_layout_value, WxssLayoutValue, WxssTextLength, WxssTextLengthUnit};
use container_render_skia::{
    AlignContent, AlignItems, DisplayMode, FlexDirection, FlexWrap, FlowEdges, FlowStyle,
    FormattingContext, LayoutLength, PositionMode,
};

fn unsupported(property: &str, value: &str) -> BridgeError {
    BridgeError::new(
        BridgeErrorCode::UnsupportedCapability,
        format!("unsupported WXSS {property}: {value}"),
    )
}

fn compute<T: Copy>(
    node: &RenderNode,
    property: &str,
    initial: T,
    inherited: T,
    convert: impl FnOnce(WxssLayoutValue) -> Option<T>,
) -> Result<T, BridgeError> {
    let Some(source) = node.computed_style.get(property) else {
        return Ok(initial);
    };
    let value = match parse_wxss_layout_value(property, source) {
        Ok(value) => value,
        // Invalid declarations are discarded before the normal cascade. Keep
        // direct RenderNode callers from treating malformed values as valid.
        Err(_) => return Ok(initial),
    };
    match value {
        WxssLayoutValue::Keyword(ref value) if matches!(value.as_str(), "initial" | "unset") => {
            Ok(initial)
        }
        WxssLayoutValue::Keyword(ref value) if value == "inherit" => Ok(inherited),
        WxssLayoutValue::Keyword(ref value)
            if matches!(value.as_str(), "revert" | "revert-layer") =>
        {
            Err(unsupported(property, source))
        }
        WxssLayoutValue::Unsupported(_) => Err(unsupported(property, source)),
        value => convert(value).ok_or_else(|| unsupported(property, source)),
    }
}

fn pixels(
    length: WxssTextLength,
    font_size: f32,
    viewport: Rect,
) -> Result<LayoutLength, BridgeError> {
    use WxssTextLengthUnit::*;
    let multiplier = match length.unit {
        Percent => {
            let ratio = length.value / 100.0;
            if length.value != 0.0 && ratio == 0.0 {
                return Err(BridgeError::new(
                    BridgeErrorCode::Render,
                    "percentage exceeds finite layout precision",
                ));
            }
            return Ok(LayoutLength::Percent(ratio));
        }
        Px => 1.0,
        Rpx => f64::from(viewport.width) / 750.0,
        Rem => 16.0,
        Em => f64::from(font_size),
        Vw => f64::from(viewport.width) / 100.0,
        Vh => f64::from(viewport.height) / 100.0,
        Vmin => f64::from(viewport.width.min(viewport.height)) / 100.0,
        Vmax => f64::from(viewport.width.max(viewport.height)) / 100.0,
        In => 96.0,
        Cm => 96.0 / 2.54,
        Mm => 96.0 / 25.4,
        Q => 96.0 / 101.6,
        Pt => 96.0 / 72.0,
        Pc => 16.0,
    };
    let exact = f64::from(length.value) * multiplier;
    let value = exact as f32;
    if !value.is_finite() || (exact != 0.0 && value == 0.0) {
        return Err(BridgeError::new(
            BridgeErrorCode::Render,
            "WXSS length exceeds finite layout range",
        ));
    }
    Ok(LayoutLength::Px(value))
}

fn dimension(
    node: &RenderNode,
    property: &str,
    initial: LayoutLength,
    inherited: LayoutLength,
    viewport: Rect,
) -> Result<LayoutLength, BridgeError> {
    let mut pixel_error = None;
    let result = compute(node, property, initial, inherited, |value| match value {
        WxssLayoutValue::Length(length) => match pixels(
            length,
            node.text_style.unwrap_or_default().font_size,
            viewport,
        ) {
            Ok(value) => Some(value),
            Err(error) => {
                pixel_error = Some(error);
                None
            }
        },
        WxssLayoutValue::Keyword(value) if matches!(value.as_str(), "auto" | "none") => {
            Some(LayoutLength::Auto)
        }
        WxssLayoutValue::Keyword(value) if value == "normal" => Some(LayoutLength::Px(0.0)),
        _ => None,
    });
    if let Some(error) = pixel_error {
        Err(error)
    } else {
        result
    }
}

fn scalar(
    node: &RenderNode,
    property: &str,
    initial: f32,
    inherited: f32,
) -> Result<f32, BridgeError> {
    compute(node, property, initial, inherited, |value| match value {
        WxssLayoutValue::Number(value) => Some(value),
        _ => None,
    })
}

fn edges(
    node: &RenderNode,
    prefix: &str,
    initial: FlowEdges,
    inherited: FlowEdges,
    viewport: Rect,
) -> Result<FlowEdges, BridgeError> {
    let name = |edge: &str| {
        if prefix.is_empty() {
            edge.to_owned()
        } else {
            format!("{prefix}-{edge}")
        }
    };
    Ok(FlowEdges {
        top: dimension(node, &name("top"), initial.top, inherited.top, viewport)?,
        right: dimension(
            node,
            &name("right"),
            initial.right,
            inherited.right,
            viewport,
        )?,
        bottom: dimension(
            node,
            &name("bottom"),
            initial.bottom,
            inherited.bottom,
            viewport,
        )?,
        left: dimension(node, &name("left"), initial.left, inherited.left, viewport)?,
    })
}

fn align_item(value: WxssLayoutValue) -> Option<Option<AlignItems>> {
    let WxssLayoutValue::Keyword(value) = value else {
        return None;
    };
    Some(match value.as_str() {
        "auto" => None,
        "normal" => Some(AlignItems::Normal),
        "start" => Some(AlignItems::Start),
        "end" => Some(AlignItems::End),
        "flex-start" => Some(AlignItems::FlexStart),
        "flex-end" => Some(AlignItems::FlexEnd),
        "self-start" => Some(AlignItems::SelfStart),
        "self-end" => Some(AlignItems::SelfEnd),
        "center" => Some(AlignItems::Center),
        "baseline" | "first baseline" => Some(AlignItems::Baseline),
        "stretch" => Some(AlignItems::Stretch),
        _ => return None,
    })
}

fn align_content(value: WxssLayoutValue) -> Option<Option<AlignContent>> {
    let WxssLayoutValue::Keyword(value) = value else {
        return None;
    };
    Some(Some(match value.as_str() {
        "normal" => AlignContent::Normal,
        "start" => AlignContent::Start,
        "end" => AlignContent::End,
        "flex-start" => AlignContent::FlexStart,
        "flex-end" => AlignContent::FlexEnd,
        "center" => AlignContent::Center,
        "stretch" => AlignContent::Stretch,
        "space-between" => AlignContent::SpaceBetween,
        "space-around" => AlignContent::SpaceAround,
        "space-evenly" => AlignContent::SpaceEvenly,
        _ => return None,
    }))
}

#[derive(Clone, Copy)]
struct Inherited {
    flow: FlowStyle,
    display: (DisplayMode, FormattingContext),
    direction: FlexDirection,
    position: PositionMode,
}

impl Default for Inherited {
    fn default() -> Self {
        Self {
            flow: FlowStyle::default(),
            display: (DisplayMode::Flex, FormattingContext::Block),
            direction: FlexDirection::Row,
            position: PositionMode::Static,
        }
    }
}

pub(super) fn resolve_tree(node: &mut RenderNode, viewport: Rect) -> Result<(), BridgeError> {
    resolve(node, Inherited::default(), viewport)
}

fn resolve(node: &mut RenderNode, inherited: Inherited, viewport: Rect) -> Result<(), BridgeError> {
    let mut next = inherited;
    if let Some(mut style) = node.style {
        let display = compute(
            node,
            "display",
            (DisplayMode::Flex, FormattingContext::Block),
            inherited.display,
            |value| match value {
                WxssLayoutValue::Keyword(value) => match value.as_str() {
                    "block" => Some((DisplayMode::Flex, FormattingContext::Block)),
                    "flex" => Some((DisplayMode::Flex, FormattingContext::Flex)),
                    "none" => Some((DisplayMode::None, FormattingContext::Block)),
                    _ => None,
                },
                _ => None,
            },
        )?;
        let direction = compute(
            node,
            "flex-direction",
            FlexDirection::Row,
            inherited.direction,
            |value| {
                let WxssLayoutValue::Keyword(value) = value else {
                    return None;
                };
                match value.as_str() {
                    "row" => Some(FlexDirection::Row),
                    "row-reverse" => Some(FlexDirection::RowReverse),
                    "column" => Some(FlexDirection::Column),
                    "column-reverse" => Some(FlexDirection::ColumnReverse),
                    _ => None,
                }
            },
        )?;
        let position = compute(
            node,
            "position",
            PositionMode::Static,
            inherited.position,
            |value| {
                let WxssLayoutValue::Keyword(value) = value else {
                    return None;
                };
                match value.as_str() {
                    "static" => Some(PositionMode::Static),
                    "relative" => Some(PositionMode::Relative),
                    "absolute" => Some(PositionMode::Absolute),
                    "fixed" => Some(PositionMode::Fixed),
                    _ => None,
                }
            },
        )?;
        let order = compute(
            node,
            "order",
            0,
            inherited.flow.order,
            |value| match value {
                WxssLayoutValue::Integer(value) => Some(value),
                _ => None,
            },
        )?;
        let initial = FlowStyle::default();
        let parent = inherited.flow;
        let flow = FlowStyle {
            order,
            aspect_ratio: None,
            context: display.1,
            width: dimension(node, "width", initial.width, parent.width, viewport)?,
            height: dimension(node, "height", initial.height, parent.height, viewport)?,
            min_width: dimension(
                node,
                "min-width",
                initial.min_width,
                parent.min_width,
                viewport,
            )?,
            min_height: dimension(
                node,
                "min-height",
                initial.min_height,
                parent.min_height,
                viewport,
            )?,
            max_width: dimension(
                node,
                "max-width",
                initial.max_width,
                parent.max_width,
                viewport,
            )?,
            max_height: dimension(
                node,
                "max-height",
                initial.max_height,
                parent.max_height,
                viewport,
            )?,
            flex_basis: dimension(
                node,
                "flex-basis",
                initial.flex_basis,
                parent.flex_basis,
                viewport,
            )?,
            margin: edges(node, "margin", initial.margin, parent.margin, viewport)?,
            padding: edges(node, "padding", initial.padding, parent.padding, viewport)?,
            inset: edges(node, "", initial.inset, parent.inset, viewport)?,
            row_gap: dimension(node, "row-gap", initial.row_gap, parent.row_gap, viewport)?,
            column_gap: dimension(
                node,
                "column-gap",
                initial.column_gap,
                parent.column_gap,
                viewport,
            )?,
            flex_grow: scalar(node, "flex-grow", initial.flex_grow, parent.flex_grow)?,
            flex_shrink: scalar(node, "flex-shrink", initial.flex_shrink, parent.flex_shrink)?,
            wrap: compute(node, "flex-wrap", initial.wrap, parent.wrap, |value| {
                let WxssLayoutValue::Keyword(value) = value else {
                    return None;
                };
                match value.as_str() {
                    "nowrap" => Some(FlexWrap::NoWrap),
                    "wrap" => Some(FlexWrap::Wrap),
                    "wrap-reverse" => Some(FlexWrap::WrapReverse),
                    _ => None,
                }
            })?,
            justify_content: compute(
                node,
                "justify-content",
                initial.justify_content,
                parent.justify_content,
                align_content,
            )?,
            align_items: compute(
                node,
                "align-items",
                initial.align_items,
                parent.align_items,
                align_item,
            )?,
            align_self: compute(
                node,
                "align-self",
                initial.align_self,
                parent.align_self,
                align_item,
            )?,
            align_content: compute(
                node,
                "align-content",
                initial.align_content,
                parent.align_content,
                align_content,
            )?,
        };
        // The virtual page's host default belongs to the formatter. Keeping
        // it out of CSS computed values also makes width:inherit inherit
        // auto instead of a legacy viewport projection made before fonts.
        style.flow = Some(flow);
        style.direction = if flow.context == FormattingContext::Flex {
            direction
        } else {
            FlexDirection::Column
        };
        style.position = position;
        if style.display != DisplayMode::None {
            style.display = display.0;
        }
        node.style = Some(style);
        node.computed_style
            .insert("order".into(), order.to_string());
        // CSS computed values exist independently of the formatting context.
        // Block layout uses Column above, but its computed flex-direction can
        // still be Row (initial) or an explicitly inherited/reversed value.
        node.computed_style.insert(
            "flex-direction".into(),
            match direction {
                FlexDirection::Row => "row",
                FlexDirection::RowReverse => "row-reverse",
                FlexDirection::Column => "column",
                FlexDirection::ColumnReverse => "column-reverse",
            }
            .into(),
        );
        node.computed_style.insert(
            "flex-wrap".into(),
            match flow.wrap {
                FlexWrap::NoWrap => "nowrap",
                FlexWrap::Wrap => "wrap",
                FlexWrap::WrapReverse => "wrap-reverse",
            }
            .into(),
        );
        next = Inherited {
            flow,
            display,
            direction,
            position,
        };
    }
    for child in &mut node.children {
        resolve(child, next, viewport)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_render_skia::LayoutStyle;

    fn node(values: &[(&str, &str)]) -> RenderNode {
        let mut node = RenderNode::new(
            "node",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 300.0,
                height: 200.0,
            },
        );
        node.style = Some(LayoutStyle::default());
        node.computed_style = values
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect();
        node
    }

    #[test]
    fn flex_defaults_and_percentages_are_not_coerced_into_viewport_pixels() {
        let mut root = node(&[
            ("display", "flex"),
            ("width", "50%"),
            ("height", "25%"),
            ("padding-left", "10%"),
            ("flex-grow", "2"),
        ]);
        root.children.push(node(&[]));
        let viewport = root.bounds;
        resolve_tree(&mut root, viewport).unwrap();
        let style = root.style.unwrap();
        let flow = style.flow.unwrap();
        assert_eq!(style.direction, FlexDirection::Row);
        assert_eq!(flow.context, FormattingContext::Flex);
        assert_eq!(flow.width, LayoutLength::Percent(0.5));
        assert_eq!(flow.height, LayoutLength::Percent(0.25));
        assert_eq!(flow.padding.left, LayoutLength::Percent(0.1));
        assert_eq!(flow.flex_grow, 2.0);
        let child = root.children[0].style.unwrap();
        assert_eq!(child.flow.unwrap().context, FormattingContext::Block);
        assert_eq!(child.flow.unwrap().flex_grow, 0.0);
    }

    #[test]
    fn computed_flex_values_survive_block_flex_and_hidden_formatting() {
        for display in [None, Some("block"), Some("flex"), Some("none")] {
            for direction in ["row", "row-reverse", "column", "column-reverse"] {
                for wrap in ["nowrap", "wrap", "wrap-reverse"] {
                    let mut values = vec![("flex-direction", direction), ("flex-wrap", wrap)];
                    values.extend(display.map(|value| ("display", value)));
                    let mut root = node(&values);
                    let viewport = root.bounds;
                    resolve_tree(&mut root, viewport).unwrap();
                    assert_eq!(root.computed_style["flex-direction"], direction);
                    assert_eq!(root.computed_style["flex-wrap"], wrap);
                    let style = root.style.unwrap();
                    assert_eq!(style.display == DisplayMode::None, display == Some("none"));
                    let expected = if display == Some("flex") {
                        match direction {
                            "row" => FlexDirection::Row,
                            "row-reverse" => FlexDirection::RowReverse,
                            "column" => FlexDirection::Column,
                            _ => FlexDirection::ColumnReverse,
                        }
                    } else {
                        FlexDirection::Column
                    };
                    assert_eq!(style.direction, expected);
                }
            }
        }
    }

    #[test]
    fn explicit_flex_inheritance_uses_computed_parent_values_across_formatters() {
        let mut root = node(&[
            ("flex-direction", "row-reverse"),
            ("flex-wrap", "wrap-reverse"),
        ]);
        for display in ["block", "flex", "none"] {
            let mut child = node(&[
                ("display", display),
                ("flex-direction", "inherit"),
                ("flex-wrap", "inherit"),
            ]);
            child.children.push(node(&[
                ("display", "flex"),
                ("flex-direction", "inherit"),
                ("flex-wrap", "inherit"),
            ]));
            root.children.push(child);
        }
        root.children.push(node(&[]));
        root.children.push(node(&[
            ("flex-direction", "unset"),
            ("flex-wrap", "initial"),
        ]));
        let viewport = root.bounds;
        resolve_tree(&mut root, viewport).unwrap();
        assert_eq!(root.style.unwrap().direction, FlexDirection::Column);
        for child in &root.children[..3] {
            assert_eq!(child.computed_style["flex-direction"], "row-reverse");
            assert_eq!(child.computed_style["flex-wrap"], "wrap-reverse");
            assert_eq!(
                child.style.unwrap().flow.unwrap().wrap,
                FlexWrap::WrapReverse
            );
            assert_eq!(
                child.children[0].style.unwrap().direction,
                FlexDirection::RowReverse
            );
            assert_eq!(
                child.children[0].computed_style["flex-direction"],
                "row-reverse"
            );
        }
        for child in &root.children[3..] {
            assert_eq!(child.computed_style["flex-direction"], "row");
            assert_eq!(child.computed_style["flex-wrap"], "nowrap");
            assert_eq!(child.style.unwrap().direction, FlexDirection::Column);
        }
    }

    #[test]
    fn normalization_happens_only_after_supported_typed_lowering() {
        let mut root = node(&[
            ("flex-direction", "ROW-REVERSE"),
            ("flex-wrap", "WRAP-REVERSE"),
        ]);
        let viewport = root.bounds;
        resolve_tree(&mut root, viewport).unwrap();
        assert_eq!(root.computed_style["flex-direction"], "row-reverse");
        assert_eq!(root.computed_style["flex-wrap"], "wrap-reverse");
        let mut invalid = node(&[("flex-direction", "invalid"), ("flex-wrap", "invalid")]);
        resolve_tree(&mut invalid, viewport).unwrap();
        assert_eq!(invalid.computed_style["flex-direction"], "row");
        assert_eq!(invalid.computed_style["flex-wrap"], "nowrap");
        let mut unsupported = node(&[("flex-direction", "revert")]);
        assert!(resolve_tree(&mut unsupported, viewport).is_err());
        assert_eq!(unsupported.computed_style["flex-direction"], "revert");
        let mut legacy = node(&[]);
        legacy.style = None;
        resolve_tree(&mut legacy, viewport).unwrap();
        assert!(!legacy.computed_style.contains_key("flex-direction"));
        assert!(!legacy.computed_style.contains_key("flex-wrap"));
    }

    #[test]
    fn explicit_layout_inheritance_copies_computed_units_without_implicit_inheritance() {
        let mut root = node(&[
            ("display", "flex"),
            ("flex-direction", "column"),
            ("width", "50%"),
            ("row-gap", "4px"),
        ]);
        root.children.push(node(&[
            ("display", "inherit"),
            ("flex-direction", "inherit"),
            ("width", "inherit"),
            ("row-gap", "inherit"),
        ]));
        root.children
            .push(node(&[("display", "unset"), ("width", "unset")]));
        let viewport = root.bounds;
        resolve_tree(&mut root, viewport).unwrap();
        assert_eq!(
            root.children[0].style.unwrap().flow,
            root.style.unwrap().flow
        );
        assert_eq!(
            root.children[0].style.unwrap().direction,
            FlexDirection::Column
        );
        assert_eq!(
            root.children[1].style.unwrap().flow.unwrap().width,
            LayoutLength::Auto
        );
    }

    #[test]
    fn valid_unimplemented_layout_never_silently_becomes_a_default_column() {
        for (property, value) in [
            ("display", "grid"),
            ("display", "inline-flex"),
            ("display", "block flex"),
            ("width", "min-content"),
            ("width", "fit-content(10px)"),
            ("width", "calc(20px + 1px)"),
            ("align-items", "last baseline"),
            ("order", "99999999999999"),
            ("position", "sticky"),
            ("margin-left", "-2ch"),
        ] {
            let mut root = node(&[(property, value)]);
            let viewport = root.bounds;
            let error = resolve_tree(&mut root, viewport).unwrap_err();
            assert_eq!(
                error.code,
                BridgeErrorCode::UnsupportedCapability,
                "{property}:{value}"
            );
        }
    }

    #[test]
    fn order_is_bounded_computed_and_only_inherited_when_explicitly_requested() {
        let mut root = node(&[("order", "-2147483648")]);
        for value in [
            None,
            Some("inherit"),
            Some("initial"),
            Some("unset"),
            Some("+2147483647"),
        ] {
            let values: Vec<_> = value.map(|value| ("order", value)).into_iter().collect();
            root.children.push(node(&values));
        }
        let viewport = root.bounds;
        resolve_tree(&mut root, viewport).unwrap();
        assert_eq!(root.style.unwrap().flow.unwrap().order, i32::MIN);
        assert_eq!(
            root.children
                .iter()
                .map(|node| node.style.unwrap().flow.unwrap().order)
                .collect::<Vec<_>>(),
            [0, i32::MIN, 0, 0, i32::MAX]
        );
        assert_eq!(
            root.children
                .iter()
                .map(|node| node.computed_style["order"].as_str())
                .collect::<Vec<_>>(),
            ["0", "-2147483648", "0", "0", "2147483647"]
        );
    }

    #[test]
    fn layout_lengths_use_resolved_fonts_and_preserve_parent_computed_values() {
        let mut root = node(&[
            ("width", "2em"),
            ("height", "2rem"),
            ("margin-left", "-10rpx"),
            ("font-size", "20px"),
        ]);
        root.children.push(node(&[
            ("width", "inherit"),
            ("font-size", "10px"),
            ("padding-left", "2em"),
            ("height", "10vh"),
        ]));
        let viewport = root.bounds;
        crate::style_text::resolve_tree(&mut root, viewport).unwrap();
        resolve_tree(&mut root, viewport).unwrap();
        let parent = root.style.unwrap().flow.unwrap();
        let child = root.children[0].style.unwrap().flow.unwrap();
        assert_eq!(parent.width, LayoutLength::Px(40.0));
        assert_eq!(parent.height, LayoutLength::Px(32.0));
        assert_eq!(parent.margin.left, LayoutLength::Px(-4.0));
        assert_eq!(child.width, LayoutLength::Px(40.0));
        assert_eq!(child.padding.left, LayoutLength::Px(20.0));
        assert_eq!(child.height, LayoutLength::Px(20.0));
    }

    #[test]
    fn finite_source_lengths_cannot_overflow_during_relative_unit_lowering() {
        let mut root = node(&[("width", "3e38em"), ("font-size", "2px")]);
        let viewport = root.bounds;
        crate::style_text::resolve_tree(&mut root, viewport).unwrap();
        assert_eq!(
            resolve_tree(&mut root, viewport).unwrap_err().code,
            BridgeErrorCode::Render
        );
    }

    #[test]
    fn host_page_extent_does_not_become_an_inherited_css_dimension() {
        let mut root = node(&[("font-size", "20px"), ("padding-left", "1em")]);
        root.tag = Some("page".into());
        root.style.as_mut().unwrap().width = Some(284.0);
        root.children.push(node(&[("width", "inherit")]));
        let viewport = root.bounds;
        crate::style_text::resolve_tree(&mut root, viewport).unwrap();
        resolve_tree(&mut root, viewport).unwrap();
        assert_eq!(root.style.unwrap().flow.unwrap().width, LayoutLength::Auto);
        assert_eq!(
            root.style.unwrap().flow.unwrap().padding.left,
            LayoutLength::Px(20.0)
        );
        assert_eq!(
            root.children[0].style.unwrap().flow.unwrap().width,
            LayoutLength::Auto
        );
    }
}
