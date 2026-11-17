//! Compute transform lengths before layout, then resolve percentages against
//! the accepted border box. Paint, input and selectors consume these same
//! values; typed frames supplied directly by a host bypass this WXSS lowering.

use super::{BridgeError, BridgeErrorCode, Rect, RenderNode};
use container_ir::{
    parse_wxss_transform, parse_wxss_transform_origin, WxssTextLength, WxssTextLengthUnit,
    WxssTransform, WxssTransformOperation, WxssTransformOrigin,
};
use container_render_skia::{
    Transform2D, TransformOrigin, TransformOriginUnit, TransformOriginValue,
};

#[derive(Debug)]
pub(super) struct PreparedTree {
    root: PreparedNode,
}

#[derive(Debug)]
struct PreparedNode {
    id: String,
    tag: Option<String>,
    key: Option<String>,
    event_identity: Option<String>,
    transform: Option<Vec<WxssTransformOperation>>,
    origin: TransformOrigin,
    children: Vec<PreparedNode>,
}

struct FinishedNode {
    transform: Option<Transform2D>,
    origin: TransformOrigin,
    origin_x: f32,
    origin_y: f32,
    children: Vec<FinishedNode>,
}

fn render_error(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Render, message)
}

fn unsupported(property: &str, value: &str) -> BridgeError {
    BridgeError::new(
        BridgeErrorCode::UnsupportedCapability,
        format!("unsupported WXSS {property}: {value}"),
    )
}

fn finite(value: f32) -> Result<f32, BridgeError> {
    if value.is_finite() {
        // Avoid two wire spellings of a zero computed value.
        Ok(if value == 0.0 { 0.0 } else { value })
    } else {
        Err(render_error(
            "WXSS transform exceeds the finite render range",
        ))
    }
}

fn checked_product(value: f32, multiplier: f64) -> Result<f32, BridgeError> {
    finite(value)?;
    let exact = f64::from(value) * multiplier;
    let result = finite(exact as f32)?;
    if exact != 0.0 && result == 0.0 {
        return Err(render_error(
            "WXSS transform length exceeds finite render precision",
        ));
    }
    Ok(result)
}

fn freeze_length(
    value: WxssTextLength,
    font_size: f32,
    viewport: Rect,
) -> Result<WxssTextLength, BridgeError> {
    use WxssTextLengthUnit::*;
    finite(value.value)?;
    let multiplier = match value.unit {
        Percent => return Ok(value),
        Px => 1.0,
        Rpx => f64::from(viewport.width) / 750.0,
        Rem => 16.0,
        Em => f64::from(finite(font_size)?),
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
    Ok(WxssTextLength {
        value: checked_product(value.value, multiplier)?,
        unit: Px,
    })
}

fn freeze_operation(
    operation: WxssTransformOperation,
    font_size: f32,
    viewport: Rect,
) -> Result<WxssTransformOperation, BridgeError> {
    use WxssTransformOperation::*;
    Ok(match operation {
        Translate { x, y } => Translate {
            x: freeze_length(x, font_size, viewport)?,
            y: freeze_length(y, font_size, viewport)?,
        },
        Matrix(values) => {
            for value in values {
                finite(value)?;
            }
            Matrix(values)
        }
        Scale { x, y } => Scale {
            x: finite(x)?,
            y: finite(y)?,
        },
        Rotate(angle) => Rotate(finite(angle)?),
        Skew { x, y } => Skew {
            x: finite(x)?,
            y: finite(y)?,
        },
    })
}

fn origin_value(value: WxssTextLength) -> Result<TransformOriginValue, BridgeError> {
    let unit = match value.unit {
        WxssTextLengthUnit::Px => TransformOriginUnit::Px,
        WxssTextLengthUnit::Percent => TransformOriginUnit::Percent,
        _ => {
            return Err(render_error(
                "WXSS transform origin was not computed before layout",
            ))
        }
    };
    Ok(TransformOriginValue {
        value: finite(value.value)?,
        unit,
    })
}

/// Freeze an animation's admitted 2D origin using the same units as native
/// computed style. Browsers receive only px/percent values: rpx and the
/// container's rem policy must not be reinterpreted by a second CSS engine.
pub(super) fn animation_origin(
    source: &str,
    font_size: f32,
    viewport: Rect,
) -> Result<String, BridgeError> {
    validate_bounds(viewport)?;
    if finite(font_size)? < 0.0 {
        return Err(render_error(
            "animation baseline font size must be nonnegative",
        ));
    }
    let (x, y) = match parse_wxss_transform_origin(source)
        .map_err(|_| render_error("invalid animation transform-origin"))?
    {
        WxssTransformOrigin::Initial | WxssTransformOrigin::Unset => {
            return Ok("50% 50%".into());
        }
        WxssTransformOrigin::Position { x, y } => (x, y),
        WxssTransformOrigin::Inherit | WxssTransformOrigin::Unsupported(_) => {
            return Err(unsupported("animation transform-origin", source));
        }
    };
    let component = |length| {
        let length = freeze_length(length, font_size, viewport)?;
        let unit = match length.unit {
            WxssTextLengthUnit::Px => "px",
            WxssTextLengthUnit::Percent => "%",
            _ => return Err(render_error("animation origin length was not computed")),
        };
        Ok(format!("{}{unit}", finite(length.value)?))
    };
    Ok(format!("{} {}", component(x)?, component(y)?))
}

/// Resolve font, absolute and viewport units once. Explicit inheritance copies
/// these computed operations: a parent's em length is already px, whereas its
/// percentages remain relative to each inheriting node's own final border box.
pub(super) fn prepare_tree(
    node: &mut RenderNode,
    viewport: Rect,
) -> Result<PreparedTree, BridgeError> {
    validate_bounds(viewport)?;
    Ok(PreparedTree {
        root: prepare(node, None, TransformOrigin::default(), viewport)?,
    })
}

fn prepare(
    node: &mut RenderNode,
    inherited_transform: Option<&[WxssTransformOperation]>,
    inherited_origin: TransformOrigin,
    viewport: Rect,
) -> Result<PreparedNode, BridgeError> {
    let font_size = node.text_style.unwrap_or_default().font_size;
    let transform = match node.computed_style.get("transform") {
        None => None,
        Some(source) => match parse_wxss_transform(source)
            .map_err(|_| render_error(format!("invalid computed WXSS transform: {source}")))?
        {
            WxssTransform::Initial | WxssTransform::Unset | WxssTransform::None => None,
            WxssTransform::Inherit => inherited_transform.map(<[_]>::to_vec),
            WxssTransform::List(operations) => Some(
                operations
                    .into_iter()
                    .map(|operation| freeze_operation(operation, font_size, viewport))
                    .collect::<Result<_, _>>()?,
            ),
            WxssTransform::Unsupported(value) => return Err(unsupported("transform", &value)),
        },
    };
    let declared_origin = node.computed_style.contains_key("transform-origin");
    let origin = match node.computed_style.get("transform-origin") {
        None => TransformOrigin::default(),
        Some(source) => match parse_wxss_transform_origin(source).map_err(|_| {
            render_error(format!("invalid computed WXSS transform-origin: {source}"))
        })? {
            WxssTransformOrigin::Initial | WxssTransformOrigin::Unset => TransformOrigin::default(),
            WxssTransformOrigin::Inherit => inherited_origin,
            WxssTransformOrigin::Position { x, y } => TransformOrigin {
                x: origin_value(freeze_length(x, font_size, viewport)?)?,
                y: origin_value(freeze_length(y, font_size, viewport)?)?,
            },
            WxssTransformOrigin::Unsupported(value) => {
                return Err(unsupported("transform-origin", &value));
            }
        },
    };
    if node.style.is_some() || transform.is_some() || declared_origin {
        let style = node.style.get_or_insert_with(Default::default);
        // Even a numerically identity transform establishes a containing block.
        // Layout must see its presence before percentages can be resolved.
        style.transform = transform.as_ref().map(|_| Transform2D::IDENTITY);
        style.transform_origin = Some(origin);
    }
    let children = node
        .children
        .iter_mut()
        .map(|child| prepare(child, transform.as_deref(), origin, viewport))
        .collect::<Result<_, _>>()?;
    Ok(PreparedNode {
        id: node.id.clone(),
        tag: node.tag.clone(),
        key: node.key.clone(),
        event_identity: node.event_identity.clone(),
        transform,
        origin,
        children,
    })
}

fn validate_bounds(bounds: Rect) -> Result<(), BridgeError> {
    for value in [bounds.x, bounds.y, bounds.width, bounds.height] {
        finite(value)?;
    }
    if bounds.width < 0.0 || bounds.height < 0.0 {
        return Err(render_error(
            "WXSS transform requires a nonnegative border box",
        ));
    }
    Ok(())
}

fn percentage(value: f32, size: f32) -> Result<f32, BridgeError> {
    // Match the renderer's Px/Percent origin model, including its f32 ratio.
    // Reject precision loss instead of silently erasing a nonzero percentage.
    let ratio = finite(value / 100.0)?;
    if value != 0.0 && ratio == 0.0 {
        return Err(render_error(
            "WXSS transform percentage exceeds finite render precision",
        ));
    }
    checked_product(ratio, f64::from(size))
}

fn used_length(value: WxssTextLength, size: f32) -> Result<f32, BridgeError> {
    match value.unit {
        WxssTextLengthUnit::Px => finite(value.value),
        WxssTextLengthUnit::Percent => percentage(value.value, size),
        _ => Err(render_error(
            "WXSS transform length was not computed before layout",
        )),
    }
}

fn used_origin(value: TransformOriginValue, size: f32) -> Result<f32, BridgeError> {
    match value.unit {
        TransformOriginUnit::Px => finite(value.value),
        TransformOriginUnit::Percent => percentage(value.value, size),
    }
}

fn finite_matrix(matrix: Transform2D) -> Result<Transform2D, BridgeError> {
    Ok(Transform2D {
        a: finite(matrix.a)?,
        b: finite(matrix.b)?,
        c: finite(matrix.c)?,
        d: finite(matrix.d)?,
        e: finite(matrix.e)?,
        f: finite(matrix.f)?,
    })
}

fn matrix_for(
    operation: &WxssTransformOperation,
    bounds: Rect,
) -> Result<Transform2D, BridgeError> {
    use WxssTransformOperation::*;
    finite_matrix(match operation {
        Matrix([a, b, c, d, e, f]) => Transform2D {
            a: *a,
            b: *b,
            c: *c,
            d: *d,
            e: *e,
            f: *f,
        },
        Translate { x, y } => Transform2D {
            e: used_length(*x, bounds.width)?,
            f: used_length(*y, bounds.height)?,
            ..Transform2D::IDENTITY
        },
        Scale { x, y } => Transform2D {
            a: *x,
            d: *y,
            ..Transform2D::IDENTITY
        },
        Rotate(angle) => {
            let (sin, cos) = angle.sin_cos();
            Transform2D {
                a: cos,
                b: sin,
                c: -sin,
                d: cos,
                ..Transform2D::IDENTITY
            }
        }
        Skew { x, y } => Transform2D {
            b: y.tan(),
            c: x.tan(),
            ..Transform2D::IDENTITY
        },
    })
}

fn finish(node: &RenderNode, prepared: PreparedNode) -> Result<FinishedNode, BridgeError> {
    if node.id != prepared.id
        || node.tag != prepared.tag
        || node.key != prepared.key
        || node.event_identity != prepared.event_identity
        || node.children.len() != prepared.children.len()
    {
        return Err(render_error(
            "WXSS transform tree changed between preparation and layout",
        ));
    }
    validate_bounds(node.bounds)?;
    let transform = prepared
        .transform
        .map(|operations| {
            operations
                .iter()
                .try_fold(Transform2D::IDENTITY, |matrix, operation| {
                    // CSS lists multiply in source order, so the rightmost
                    // operation acts on a point first.
                    matrix
                        .checked_multiply(matrix_for(operation, node.bounds)?)
                        .ok_or_else(|| {
                            render_error("WXSS transform matrix exceeds finite render precision")
                        })
                })
        })
        .transpose()?;
    let origin_x = used_origin(prepared.origin.x, node.bounds.width)?;
    let origin_y = used_origin(prepared.origin.y, node.bounds.height)?;
    finite(node.bounds.x + origin_x)?;
    finite(node.bounds.y + origin_y)?;
    let children = node
        .children
        .iter()
        .zip(prepared.children)
        .map(|(child, prepared)| finish(child, prepared))
        .collect::<Result<_, _>>()?;
    Ok(FinishedNode {
        transform,
        origin: prepared.origin,
        origin_x,
        origin_y,
        children,
    })
}

fn apply(node: &mut RenderNode, finished: FinishedNode) {
    if let Some(style) = &mut node.style {
        style.transform = finished.transform;
        style.transform_origin = Some(finished.origin);
    }
    node.computed_style.insert(
        "transform".into(),
        match finished.transform {
            None => "none".into(),
            Some(value) => format!(
                "matrix({}, {}, {}, {}, {}, {})",
                value.a, value.b, value.c, value.d, value.e, value.f
            ),
        },
    );
    node.computed_style.insert(
        "transform-origin".into(),
        format!("{}px {}px", finished.origin_x, finished.origin_y),
    );
    for (child, finished) in node.children.iter_mut().zip(finished.children) {
        apply(child, finished);
    }
}

/// Complete all fallible work against the unchanged candidate tree before
/// publishing any used value. Cross-ancestor/origin conjugation and transformed
/// geometry admission remain the renderer's shared gate for all frame sources.
pub(super) fn finish_tree(
    node: &mut RenderNode,
    prepared: PreparedTree,
) -> Result<(), BridgeError> {
    let finished = finish(node, prepared.root)?;
    apply(node, finished);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn sampled_origin_uses_native_units_and_rejects_deferred_3d_values() {
        let viewport = container_render_skia::Rect {
            x: 0.0,
            y: 0.0,
            width: 375.0,
            height: 800.0,
        };
        assert_eq!(
            super::animation_origin("20rpx 2em 0", 12.0, viewport).unwrap(),
            "10px 24px"
        );
        assert_eq!(
            super::animation_origin("25% 1rem", 12.0, viewport).unwrap(),
            "25% 16px"
        );
        assert_eq!(
            super::animation_origin("1em 50%", 0.0, viewport).unwrap(),
            "0px 50%"
        );
        for source in [
            "inherit",
            "var(--origin)",
            "10px 20px 1px",
            "calc(50% + 1px) 0",
        ] {
            assert!(
                super::animation_origin(source, 12.0, viewport).is_err(),
                "{source}"
            );
        }
    }
    use super::*;
    use container_render_skia::{LayoutStyle, TextStyle};

    fn bounds(width: f32, height: f32) -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        }
    }

    fn viewport() -> Rect {
        bounds(750.0, 500.0)
    }

    fn node(id: &str, declarations: &[(&str, &str)]) -> RenderNode {
        let mut node = RenderNode::new(id, bounds(0.0, 0.0));
        node.style = Some(LayoutStyle::default());
        node.computed_style = declarations
            .iter()
            .map(|(property, value)| (property.to_string(), value.to_string()))
            .collect();
        node
    }

    fn matrix(node: &RenderNode) -> Transform2D {
        node.style.unwrap().transform.unwrap()
    }

    #[test]
    fn translation_percentages_use_final_border_box_not_viewport_or_initial_bounds() {
        let mut root = node("root", &[("transform", "translate(50%, -25%)")]);
        root.bounds = bounds(10.0, 10.0);
        let prepared = prepare_tree(&mut root, viewport()).unwrap();
        assert_eq!(matrix(&root), Transform2D::IDENTITY);
        root.bounds = bounds(240.0, 160.0);
        finish_tree(&mut root, prepared).unwrap();
        assert_eq!((matrix(&root).e, matrix(&root).f), (120.0, -40.0));
        assert_eq!(
            root.computed_style["transform"],
            "matrix(1, 0, 0, 1, 120, -40)"
        );
        assert_eq!(root.computed_style["transform-origin"], "120px 80px");
    }

    #[test]
    fn explicit_inherit_copies_computed_em_but_retains_each_nodes_percentages() {
        let mut root = node(
            "root",
            &[
                ("font-size", "20px"),
                ("transform", "translate(1em, 50%)"),
                ("transform-origin", "1em 25%"),
            ],
        );
        root.children.push(node(
            "inherited",
            &[
                ("font-size", "40px"),
                ("transform", "inherit"),
                ("transform-origin", "inherit"),
            ],
        ));
        root.children.push(node(
            "local",
            &[("font-size", "40px"), ("transform", "translate(1em, 50%)")],
        ));
        for value in [None, Some("none"), Some("unset"), Some("initial")] {
            let declarations = value
                .map(|value| vec![("transform", value)])
                .unwrap_or_default();
            root.children
                .push(node(&format!("default-{value:?}"), &declarations));
        }
        super::super::style_text::resolve_tree(&mut root, viewport()).unwrap();
        let prepared = prepare_tree(&mut root, viewport()).unwrap();
        root.bounds = bounds(200.0, 100.0);
        for child in &mut root.children {
            child.bounds = bounds(80.0, 40.0);
        }
        finish_tree(&mut root, prepared).unwrap();
        assert_eq!((matrix(&root).e, matrix(&root).f), (20.0, 50.0));
        assert_eq!(
            (matrix(&root.children[0]).e, matrix(&root.children[0]).f),
            (20.0, 20.0)
        );
        assert_eq!(
            (matrix(&root.children[1]).e, matrix(&root.children[1]).f),
            (40.0, 20.0)
        );
        assert_eq!(
            root.children[0].computed_style["transform-origin"],
            "20px 10px"
        );
        let origin = root.children[0].style.unwrap().transform_origin.unwrap();
        assert_eq!(origin.x.unit, TransformOriginUnit::Px);
        assert_eq!(origin.y.unit, TransformOriginUnit::Percent);
        for child in &root.children[2..] {
            assert_eq!(child.style.unwrap().transform, None);
            assert_eq!(child.computed_style["transform"], "none");
            assert_eq!(child.computed_style["transform-origin"], "40px 20px");
        }
    }

    #[test]
    fn signed_font_viewport_and_absolute_lengths_share_the_computed_boundary() {
        let mut root = node(
            "root",
            &[
                ("transform", "translate(2rem, -3em)"),
                ("transform-origin", "2em -1em"),
            ],
        );
        root.text_style = Some(TextStyle {
            font_size: 10.0,
            ..TextStyle::default()
        });
        let prepared = prepare_tree(&mut root, viewport()).unwrap();
        root.bounds = bounds(100.0, 80.0);
        finish_tree(&mut root, prepared).unwrap();
        assert_eq!((matrix(&root).e, matrix(&root).f), (32.0, -30.0));
        assert_eq!(root.computed_style["transform-origin"], "20px -10px");
        for (source, expected) in [
            ("150rpx", 150.0),
            ("10vw", 75.0),
            ("10vh", 50.0),
            ("10vmin", 50.0),
            ("10vmax", 75.0),
            ("1in", 96.0),
            ("2.54cm", 96.0),
            ("25.4mm", 96.0),
            ("101.6q", 96.0),
            ("72pt", 96.0),
            ("6pc", 96.0),
        ] {
            let mut root = node("unit", &[("transform", &format!("translateX({source})"))]);
            let prepared = prepare_tree(&mut root, viewport()).unwrap();
            root.bounds = bounds(100.0, 80.0);
            finish_tree(&mut root, prepared).unwrap();
            assert!((matrix(&root).e - expected).abs() < 0.0001, "{source}");
        }
    }

    #[test]
    fn origin_defaults_are_noninherited_and_selector_values_are_box_relative() {
        let mut root = node("root", &[("transform-origin", "10px 25%")]);
        for value in [None, Some("initial"), Some("unset"), Some("inherit")] {
            let declarations = value
                .map(|value| vec![("transform-origin", value)])
                .unwrap_or_default();
            root.children
                .push(node(&format!("origin-{value:?}"), &declarations));
        }
        let prepared = prepare_tree(&mut root, viewport()).unwrap();
        root.bounds = bounds(200.0, 100.0);
        for child in &mut root.children {
            child.bounds = Rect {
                x: 300.0,
                y: -50.0,
                ..bounds(80.0, 40.0)
            };
        }
        finish_tree(&mut root, prepared).unwrap();
        assert_eq!(root.computed_style["transform-origin"], "10px 25px");
        for child in &root.children[..3] {
            assert_eq!(child.computed_style["transform-origin"], "40px 20px");
        }
        assert_eq!(
            root.children[3].computed_style["transform-origin"],
            "10px 10px"
        );
    }

    #[test]
    fn source_order_is_css_matrix_order_and_singular_zero_scale_is_not_none() {
        for (source, expected) in [
            ("translateX(10px) scale(2)", (12.0, 2.0)),
            ("scale(2) translateX(10px)", (22.0, 2.0)),
            ("matrix(1, 0, 0, 1, 3, 4) scale(2, 3)", (5.0, 7.0)),
        ] {
            let mut root = node("root", &[("transform", source)]);
            let prepared = prepare_tree(&mut root, viewport()).unwrap();
            finish_tree(&mut root, prepared).unwrap();
            assert_eq!(matrix(&root).apply((1.0, 1.0)), expected, "{source}");
        }
        let mut root = node("zero", &[("transform", "scale(0)")]);
        let prepared = prepare_tree(&mut root, viewport()).unwrap();
        assert!(root.style.unwrap().transform.is_some());
        root.bounds = bounds(100.0, 80.0);
        finish_tree(&mut root, prepared).unwrap();
        assert_eq!((matrix(&root).a, matrix(&root).d), (0.0, 0.0));
        assert_eq!(root.computed_style["transform"], "matrix(0, 0, 0, 0, 0, 0)");
    }

    #[test]
    fn rotation_and_both_skew_axes_are_resolved_without_reordering() {
        let mut root = node("root", &[("transform", "rotate(90deg) skew(45deg, 0deg)")]);
        let prepared = prepare_tree(&mut root, viewport()).unwrap();
        finish_tree(&mut root, prepared).unwrap();
        let point = matrix(&root).apply((2.0, 3.0));
        assert!((point.0 + 3.0).abs() < 0.00001);
        assert!((point.1 - 5.0).abs() < 0.00001);
    }

    #[test]
    fn unsupported_and_malformed_computed_values_fail_explicitly() {
        for (property, source) in [
            ("transform", "translateZ(1px)"),
            ("transform", "translateX(var(--offset))"),
            ("transform-origin", "center center 1px"),
        ] {
            let mut root = node("root", &[(property, source)]);
            assert_eq!(
                prepare_tree(&mut root, viewport()).unwrap_err().code,
                BridgeErrorCode::UnsupportedCapability,
                "{source}"
            );
        }
        let mut root = node("root", &[("transform", "translateX(bogus)")]);
        assert_eq!(
            prepare_tree(&mut root, viewport()).unwrap_err().code,
            BridgeErrorCode::Render
        );
    }

    #[test]
    fn finite_operands_that_overflow_length_percentages_or_matrix_accumulation_fail() {
        let mut root = node("length", &[("transform", "translateX(3e38em)")]);
        assert_eq!(
            prepare_tree(&mut root, viewport()).unwrap_err().code,
            BridgeErrorCode::Render
        );
        for (property, source) in [
            ("transform", "translateX(3e38%)"),
            ("transform-origin", "3e38% 50%"),
            ("transform", "scale(3e38) scale(2)"),
            ("transform", "translateX(3e38px) translateX(3e38px)"),
        ] {
            let mut root = node("root", &[(property, source)]);
            let prepared = prepare_tree(&mut root, viewport()).unwrap();
            root.bounds = bounds(1000.0, 1000.0);
            let before = root.clone();
            assert_eq!(
                finish_tree(&mut root, prepared).unwrap_err().code,
                BridgeErrorCode::Render,
                "{source}"
            );
            assert_eq!(
                root, before,
                "failed finish must not partially apply values"
            );
        }
    }

    #[test]
    fn nonzero_matrix_underflow_rejects_atomically_but_authored_zero_remains_valid() {
        for source in [
            "scale(1e-30) scale(1e-30)",
            "scale(1e-30) scale(1e-30) scale(1e30) scale(1e30)",
            "matrix(1e-30, 0, 0, 1e-30, 0, 0) scale(1e-30)",
        ] {
            // Finish would compute a valid parent before reaching the child.
            // A child's unrepresentable matrix must leave both nodes in the
            // prepared candidate state, without publishing either used value.
            let mut root = node("root", &[("transform", "translateX(10px)")]);
            root.children.push(node("child", &[("transform", source)]));
            let prepared = prepare_tree(&mut root, viewport()).unwrap();
            root.bounds = bounds(100.0, 80.0);
            root.children[0].bounds = bounds(40.0, 20.0);
            let before = root.clone();
            let error = finish_tree(&mut root, prepared).unwrap_err();
            assert_eq!(error.code, BridgeErrorCode::Render, "{source}");
            assert!(
                error.message.contains("finite render precision"),
                "{source}"
            );
            assert_eq!(root, before, "failed child finish must remain atomic");
        }

        // A single tiny but representable scale is not an authored zero.
        let mut tiny = node("tiny", &[("transform", "scale(1e-30)")]);
        let prepared = prepare_tree(&mut tiny, viewport()).unwrap();
        tiny.bounds = bounds(100.0, 80.0);
        finish_tree(&mut tiny, prepared).unwrap();
        assert_eq!((matrix(&tiny).a, matrix(&tiny).d), (1e-30, 1e-30));

        // Exactly authored zero remains a legitimate singular transform,
        // including when later operations contain small or large scales.
        let mut zero = node(
            "zero",
            &[("transform", "scale(0) scale(1e-30) scale(1e30)")],
        );
        let prepared = prepare_tree(&mut zero, viewport()).unwrap();
        zero.bounds = bounds(100.0, 80.0);
        finish_tree(&mut zero, prepared).unwrap();
        assert_eq!((matrix(&zero).a, matrix(&zero).d), (0.0, 0.0));
        assert!(zero.style.unwrap().transform.is_some());
    }

    #[test]
    fn preparation_is_bound_to_node_identity_and_tree_shape() {
        for change_shape in [false, true] {
            let mut root = node("root", &[("transform", "translateX(50%)")]);
            root.children.push(node("child", &[]));
            let prepared = prepare_tree(&mut root, viewport()).unwrap();
            if change_shape {
                root.children.clear();
            } else {
                root.children[0].id = "replaced".into();
            }
            let before = root.clone();
            assert_eq!(
                finish_tree(&mut root, prepared).unwrap_err().code,
                BridgeErrorCode::Render
            );
            assert_eq!(root, before);
        }
    }
}
