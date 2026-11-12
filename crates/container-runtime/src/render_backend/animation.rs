//! Numeric animation overlays over declaration-derived native scenes.
//! Resolve baselines after the ordinary pipeline, then apply only sampled
//! properties to the raw scene so inheritance/layout is recomputed once.
use crate::animation_protocol::{
    BaselineObservation, BaselineRequest, Matrix, OriginPoint, SampledStyle,
};
use container_bridge::{BridgeError, BridgeErrorCode};
use container_render_skia::{RenderNode, Transform2D, TransformOriginUnit};
use std::collections::{BTreeMap, BTreeSet};

fn invalid(message: &str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Render, message)
}

fn elements<'a>(
    root: &'a RenderNode,
    output: &mut BTreeMap<&'a str, &'a RenderNode>,
) -> Result<(), BridgeError> {
    if root.tag.is_some() {
        if let Some(id) = root.event_identity.as_deref() {
            if output.insert(id, root).is_some() {
                return Err(invalid("duplicate native animation occurrence"));
            }
        }
    }
    for child in &root.children {
        elements(child, output)?;
    }
    Ok(())
}

pub(super) fn baselines(
    root: &RenderNode,
    requests: &[BaselineRequest],
) -> Result<Vec<BaselineObservation>, BridgeError> {
    let mut nodes = BTreeMap::new();
    elements(root, &mut nodes)?;
    let mut seen = BTreeSet::new();
    requests
        .iter()
        .map(|request| {
            if !seen.insert(request.occurrence_id.as_str()) {
                return Err(invalid("duplicate native animation baseline request"));
            }
            let node = nodes
                .get(request.occurrence_id.as_str())
                .ok_or_else(|| invalid("native animation baseline occurrence is absent"))?;
            let style = node.style.unwrap_or_default();
            let origin = if request.transform {
                let origin = style.transform_origin.unwrap_or_default();
                let used = |value: container_render_skia::TransformOriginValue, size: f32| {
                    match value.unit {
                        TransformOriginUnit::Px => value.value,
                        TransformOriginUnit::Percent => size * (value.value / 100.0),
                    }
                };
                Some(OriginPoint {
                    x: f64::from(used(origin.x, node.bounds.width)),
                    y: f64::from(used(origin.y, node.bounds.height)),
                })
            } else {
                None
            };
            let observation = BaselineObservation {
                occurrence_id: request.occurrence_id.clone(),
                opacity: request.opacity.then_some(f64::from(node.opacity)),
                transform: request
                    .transform
                    .then(|| Matrix::from_affine(style.transform.unwrap_or(Transform2D::IDENTITY))),
                font_size: f64::from(node.text_style.unwrap_or_default().font_size),
                origin,
            };
            observation.validate(request)?;
            Ok(observation)
        })
        .collect()
}

/// Validate all occurrence identities and numeric values before any overwrite.
/// The shared normal pipeline subsequently resolves explicit inheritance and
/// containing blocks from these post-cascade sampled property strings.
pub(super) fn overlay(root: &mut RenderNode, styles: &[SampledStyle]) -> Result<(), BridgeError> {
    let mut nodes = BTreeMap::new();
    elements(root, &mut nodes)?;
    let mut samples = BTreeMap::new();
    for sample in styles {
        if !nodes.contains_key(sample.occurrence_id.as_str())
            || samples
                .insert(sample.occurrence_id.as_str(), sample)
                .is_some()
        {
            return Err(invalid(
                "native sampled style requires an exact unique element occurrence",
            ));
        }
        if sample
            .opacity
            .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
        {
            return Err(invalid("native sampled opacity must be finite in [0,1]"));
        }
        if let Some(matrix) = sample.transform {
            matrix.affine()?;
        }
    }
    drop(nodes);
    fn apply(root: &mut RenderNode, samples: &BTreeMap<&str, &SampledStyle>) {
        if root.tag.is_some() {
            if let Some(sample) = root
                .event_identity
                .as_deref()
                .and_then(|id| samples.get(id))
            {
                if let Some(opacity) = sample.opacity {
                    root.computed_style
                        .insert("opacity".into(), opacity.to_string());
                }
                if let Some(matrix) = sample.transform {
                    root.computed_style.insert(
                        "transform".into(),
                        format!(
                            "matrix({}, {}, {}, {}, {}, {})",
                            matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty
                        ),
                    );
                }
                if let Some(origin) = &sample.origin {
                    root.computed_style
                        .insert("transform-origin".into(), origin.clone());
                }
            }
        }
        for child in &mut root.children {
            apply(child, samples);
        }
    }
    apply(root, &samples);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_render_skia::{
        LayoutStyle, Rect, TextStyle, TransformOrigin, TransformOriginValue,
    };
    fn node(id: &str) -> RenderNode {
        let mut node = RenderNode::new(
            id,
            Rect {
                x: 9.0,
                y: 7.0,
                width: 80.0,
                height: 40.0,
            },
        );
        node.tag = Some("view".into());
        node.event_identity = Some(id.into());
        node
    }
    fn sample(id: &str) -> SampledStyle {
        SampledStyle {
            occurrence_id: id.into(),
            opacity: Some(0.4),
            transform: None,
            origin: None,
        }
    }
    #[test]
    fn baselines_capture_local_opacity_affine_origin_and_inherited_font_without_mutating_tree() {
        let mut root = node("root");
        root.opacity = 0.7;
        root.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                a: 2.0,
                e: 17.0,
                ..Transform2D::IDENTITY
            }),
            transform_origin: Some(TransformOrigin {
                x: TransformOriginValue::percent(25.0),
                y: TransformOriginValue {
                    value: 6.0,
                    unit: TransformOriginUnit::Px,
                },
            }),
            ..Default::default()
        });
        root.text_style = Some(TextStyle {
            font_size: 21.0,
            ..Default::default()
        });
        let before = root.clone();
        let observed = baselines(
            &root,
            &[BaselineRequest {
                occurrence_id: "root".into(),
                opacity: true,
                transform: true,
            }],
        )
        .unwrap();
        assert_eq!(observed[0].opacity, Some(f64::from(0.7f32)));
        assert_eq!(observed[0].transform.unwrap().tx, 17.0);
        assert_eq!(observed[0].origin.unwrap().x, 20.0);
        assert_eq!(observed[0].origin.unwrap().y, 6.0);
        assert_eq!(observed[0].font_size, 21.0);
        assert_eq!(root, before);
        let context = baselines(
            &root,
            &[BaselineRequest {
                occurrence_id: "root".into(),
                opacity: false,
                transform: false,
            }],
        )
        .unwrap();
        assert_eq!(context[0].opacity, None);
        assert_eq!(context[0].transform, None);
        assert!(context[0].origin.is_none());
        assert_eq!(context[0].font_size, 21.0);
    }
    #[test]
    fn overlay_is_exact_and_preflight_failure_cannot_partially_overwrite_raw_css() {
        let mut root = node("root");
        root.computed_style
            .insert("opacity".into(), "inherit".into());
        root.children.push(node("child"));
        for styles in [
            vec![sample("root"), sample("missing")],
            vec![sample("root"), sample("root")],
            vec![
                sample("root"),
                SampledStyle {
                    opacity: Some(f32::NAN),
                    ..sample("child")
                },
            ],
        ] {
            let before = root.clone();
            assert!(overlay(&mut root, &styles).is_err());
            assert_eq!(root, before);
        }
        overlay(&mut root, &[sample("root")]).unwrap();
        assert_eq!(root.computed_style["opacity"], "0.4");
        assert!(!root.children[0].computed_style.contains_key("opacity"));
    }
}
