//! Reject unrepresentable transforms before any backend publishes a frame.
//! This uses the same traversal as paint, geometry and input, including scroll
//! translations and viewport-fixed resets. A singular (e.g. scale(0)) matrix
//! is valid and invisible; a non-finite matrix must never masquerade as one.
use super::*;

fn finite(matrix: Transform2D) -> Result<(), RenderError> {
    if ![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]
        .into_iter()
        .all(f32::is_finite)
        || !matrix.determinant().is_finite()
        || (matrix.determinant() != 0.0 && matrix.inverse().is_none())
    {
        return Err(RenderError::InvalidTransform);
    }
    Ok(())
}

pub(super) fn validate(root: &RenderNode) -> Result<(), RenderError> {
    fn multiply(parent: Transform2D, local: Transform2D) -> Result<Transform2D, RenderError> {
        parent
            .checked_multiply(local)
            .ok_or(RenderError::InvalidTransform)
    }

    fn local_transform(node: &RenderNode) -> Result<Transform2D, RenderError> {
        let style = node.style.unwrap_or_default();
        let Some(matrix) = style.transform else {
            return Ok(Transform2D::IDENTITY);
        };
        finite(matrix)?;
        let origin = style.transform_origin.unwrap_or_default();
        let (x, y) = (
            origin.x.resolve(node.bounds.x, node.bounds.width),
            origin.y.resolve(node.bounds.y, node.bounds.height),
        );
        let shifted = multiply(
            Transform2D {
                e: x,
                f: y,
                ..Transform2D::IDENTITY
            },
            matrix,
        )?;
        multiply(
            shifted,
            Transform2D {
                e: -x,
                f: -y,
                ..Transform2D::IDENTITY
            },
        )
    }

    paint::validate_budget(root)?;
    let plan = paint::PaintPlan::spatial_validated(root);
    let mut descendants = Vec::with_capacity(plan.nodes.len());
    for entry in &plan.nodes {
        let node = entry.node;
        let inherited = entry
            .spatial_parent
            .map_or(Transform2D::IDENTITY, |parent| descendants[parent]);
        if let Some(style) = node.style {
            if let Some(matrix) = style.transform {
                finite(matrix)?;
            }
            if let Some(origin) = style.transform_origin {
                if !origin.x.value.is_finite() || !origin.y.value.is_finite() {
                    return Err(RenderError::InvalidTransform);
                }
            }
        }
        let local = local_transform(node)?;
        let matrix = if node.is_viewport_fixed() {
            local
        } else {
            multiply(inherited, local)?
        };
        finite(matrix)?;
        let Rect {
            x,
            y,
            width,
            height,
        } = node.bounds;
        for point in [
            (x, y),
            (x + width, y),
            (x, y + height),
            (x + width, y + height),
        ] {
            if !point.0.is_finite() || !point.1.is_finite() {
                return Err(RenderError::InvalidTransform);
            }
            let (x, y) = matrix.apply(point);
            if !x.is_finite() || !y.is_finite() {
                return Err(RenderError::InvalidTransform);
            }
        }
        let descendant = multiply(matrix, node.descendant_translation())?;
        finite(descendant)?;
        descendants.push(descendant);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> RenderFrame {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 8.0,
            height: 8.0,
        };
        RenderFrame {
            frame_id: 1,
            viewport,
            root: RenderNode::new("root", viewport),
            images: BTreeMap::new(),
        }
    }

    #[test]
    fn invalid_local_origin_world_and_geometry_preserve_all_backend_frames() {
        let mut candidates = Vec::new();
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut candidate = frame();
            candidate.root.style = Some(LayoutStyle {
                transform: Some(Transform2D {
                    e: value,
                    ..Transform2D::IDENTITY
                }),
                ..LayoutStyle::default()
            });
            candidates.push(candidate);
            let mut candidate = frame();
            candidate.root.style = Some(LayoutStyle {
                transform_origin: Some(TransformOrigin {
                    x: TransformOriginValue::percent(value),
                    ..TransformOrigin::default()
                }),
                ..LayoutStyle::default()
            });
            candidates.push(candidate);
        }
        // Every local matrix is finite, but composing the two translations
        // overflows. This used to silently skip paint/hits on native hosts.
        let mut accumulated = frame();
        accumulated.root.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                e: f32::MAX,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        let mut child = RenderNode::new("child", accumulated.viewport);
        child.style = accumulated.root.style;
        accumulated.root.children.push(child);
        candidates.push(accumulated);
        // The origin sandwich and transformed corners have their own range.
        let mut origin = frame();
        origin.root.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                a: 4.0,
                ..Transform2D::IDENTITY
            }),
            transform_origin: Some(TransformOrigin {
                x: TransformOriginValue {
                    value: f32::MAX,
                    unit: TransformOriginUnit::Px,
                },
                ..TransformOrigin::default()
            }),
            ..LayoutStyle::default()
        });
        candidates.push(origin);
        let mut geometry = frame();
        geometry.root.bounds.width = f32::MAX;
        geometry.root.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                a: 4.0,
                ..Transform2D::IDENTITY
            }),
            transform_origin: Some(TransformOrigin {
                x: TransformOriginValue::percent(0.0),
                y: TransformOriginValue::percent(0.0),
            }),
            ..LayoutStyle::default()
        });
        candidates.push(geometry);
        for export_only in [false, true] {
            let mut renderer = if export_only {
                SkiaRenderer::new_frame_export_only()
            } else {
                SkiaRenderer::new()
            };
            renderer.commit(frame()).unwrap();
            let accepted = renderer.last_frame().unwrap().clone();
            let pixels = renderer.snapshot().unwrap();
            for candidate in &candidates {
                assert_eq!(
                    renderer.commit(candidate.clone()),
                    Err(RenderError::InvalidTransform)
                );
                assert_eq!(renderer.last_frame(), Some(&accepted));
                assert_eq!(renderer.snapshot().unwrap(), pixels);
            }
        }
    }

    #[test]
    fn zero_scale_is_valid_invisible_and_does_not_hit() {
        let mut submitted = frame();
        submitted.root.background = Some(Color::WHITE);
        submitted.root.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                a: 0.0,
                d: 0.0,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        let mut renderer = SkiaRenderer::new();
        renderer.commit(submitted).unwrap();
        assert!(renderer
            .snapshot()
            .unwrap()
            .pixels
            .iter()
            .all(|value| *value == 0));
        assert!(renderer
            .last_frame()
            .unwrap()
            .root
            .hit_test(1.0, 1.0)
            .is_none());
    }

    #[test]
    fn small_nonzero_scale_paints_and_hits_the_same_visible_box() {
        let mut submitted = frame();
        submitted.root.bounds.width = 20_000.0;
        submitted.root.bounds.height = 20_000.0;
        submitted.root.background = Some(Color::WHITE);
        submitted.root.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                a: 0.0001,
                d: 0.0001,
                ..Transform2D::IDENTITY
            }),
            transform_origin: Some(TransformOrigin {
                x: TransformOriginValue::percent(0.0),
                y: TransformOriginValue::percent(0.0),
            }),
            ..LayoutStyle::default()
        });
        let mut renderer = SkiaRenderer::new();
        renderer.commit(submitted).unwrap();
        let snapshot = renderer.snapshot().unwrap();
        assert_eq!(&snapshot.pixels[..4], &[255, 255, 255, 255]);
        assert_eq!(&snapshot.pixels[8..12], &[0, 0, 0, 0]);
        let root = &renderer.last_frame().unwrap().root;
        assert_eq!(
            root.hit_test(0.5, 0.5).map(|node| node.id.as_str()),
            Some("root")
        );
        assert!(root.hit_test(2.5, 0.5).is_none());
    }

    #[test]
    fn inverse_keeps_nonzero_products_beyond_f32_determinant_range() {
        for scale in [1e-30, 1e30] {
            let matrix = Transform2D {
                a: scale,
                d: scale,
                ..Transform2D::IDENTITY
            };
            assert_ne!(matrix.determinant(), 0.0);
            let inverse = matrix.inverse().unwrap();
            assert!((matrix.multiply(inverse).a - 1.0).abs() < 1e-6);
            assert!((matrix.multiply(inverse).d - 1.0).abs() < 1e-6);
        }
    }

    #[test]
    fn nonzero_scale_with_unrepresentable_inverse_is_rejected_atomically() {
        let mut renderer = SkiaRenderer::new();
        renderer.commit(frame()).unwrap();
        let accepted = renderer.last_frame().unwrap().clone();
        let mut submitted = frame();
        submitted.root.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                a: 1e-40,
                d: 1e-40,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        assert_eq!(
            renderer.commit(submitted),
            Err(RenderError::InvalidTransform)
        );
        assert_eq!(renderer.last_frame(), Some(&accepted));
    }

    #[test]
    fn cross_ancestor_underflow_is_not_mistaken_for_authored_zero_scale() {
        let scale = |value| LayoutStyle {
            transform: Some(Transform2D {
                a: value,
                d: value,
                ..Transform2D::IDENTITY
            }),
            transform_origin: Some(TransformOrigin {
                x: TransformOriginValue::percent(0.0),
                y: TransformOriginValue::percent(0.0),
            }),
            ..LayoutStyle::default()
        };
        let mut submitted = frame();
        submitted.root.style = Some(scale(1e-30));
        let mut child = RenderNode::new("small", submitted.viewport);
        child.style = Some(scale(1e-30));
        let mut recover = RenderNode::new("large", submitted.viewport);
        recover.style = Some(scale(1e30));
        child.children.push(recover);
        submitted.root.children.push(child);
        let mut renderer = SkiaRenderer::new();
        renderer.commit(frame()).unwrap();
        let accepted = renderer.last_frame().unwrap().clone();
        assert_eq!(
            renderer.commit(submitted.clone()),
            Err(RenderError::InvalidTransform)
        );
        assert_eq!(renderer.last_frame(), Some(&accepted));
        submitted.root.style = Some(scale(0.0));
        renderer.commit(submitted).unwrap();
    }
}
