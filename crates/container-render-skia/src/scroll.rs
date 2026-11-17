//! Resolved scroll viewport geometry. Input and state ownership stay in the runtime.
use super::*;

impl RenderNode {
    /// Padding-box viewport used by descendant paint, hits and scroll bounds.
    /// Borders remain outside this fixed viewport; padding remains inside it.
    pub fn scroll_viewport(&self) -> Rect {
        BorderGeometry::new(self.bounds, self.style.unwrap_or_default()).inner
    }

    /// Unscrolled positive content extent in this node's local coordinates.
    /// Descendant transforms participate; this node's own transform/offset do
    /// not. A nested scroll container contributes its box, not its contents.
    /// Viewport-fixed typed boxes do not contribute to an ancestor's scroll
    /// area. This is the border-box extent contract, not full CSS scrollWidth
    /// (for example clipped overflow and glyph ink overflow).
    pub fn scroll_content_extent(&self) -> (f32, f32) {
        fn collect(node: &RenderNode, parent: Transform2D, right: &mut f32, bottom: &mut f32) {
            if node.style.unwrap_or_default().display == DisplayMode::None
                || node.is_viewport_fixed()
            {
                return;
            }
            let transform = parent.multiply(node.local_transform());
            for point in [
                (node.bounds.x, node.bounds.y),
                (node.bounds.x + node.bounds.width, node.bounds.y),
                (node.bounds.x, node.bounds.y + node.bounds.height),
                (
                    node.bounds.x + node.bounds.width,
                    node.bounds.y + node.bounds.height,
                ),
            ] {
                let (x, y) = transform.apply(point);
                *right = right.max(x);
                *bottom = bottom.max(y);
            }
            if !node.scroll_container {
                for child in &node.children {
                    collect(child, transform, right, bottom);
                }
            }
        }
        let viewport = self.scroll_viewport();
        let mut right = viewport.x;
        let mut bottom = viewport.y;
        for child in &self.children {
            collect(child, Transform2D::IDENTITY, &mut right, &mut bottom);
        }
        let padding = self.style.unwrap_or_default().padding;
        (
            viewport.width.max(right - viewport.x + padding.right),
            viewport.height.max(bottom - viewport.y + padding.bottom),
        )
    }

    /// Candidate scroll position aligning a descendant's transformed AABB with
    /// this viewport. Excludes our own transform/scroll, includes nested ones.
    /// The result may be negative or beyond the extent; callers clamp it.
    pub fn scroll_target_offset(&self, target: &RenderNode) -> Option<ScrollOffset> {
        fn find(node: &RenderNode, target: &RenderNode, parent: Transform2D) -> Option<(f32, f32)> {
            if node.style.unwrap_or_default().display == DisplayMode::None
                || node.is_viewport_fixed()
            {
                return None;
            }
            let transform = parent.multiply(node.local_transform());
            if std::ptr::eq(node, target) {
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
                return Some((
                    corners
                        .iter()
                        .map(|point| point.0)
                        .fold(f32::INFINITY, f32::min),
                    corners
                        .iter()
                        .map(|point| point.1)
                        .fold(f32::INFINITY, f32::min),
                ));
            }
            let descendant_transform = transform.multiply(node.descendant_translation());
            node.children
                .iter()
                .find_map(|child| find(child, target, descendant_transform))
        }
        let viewport = self.scroll_viewport();
        self.children
            .iter()
            .find_map(|child| find(child, target, Transform2D::IDENTITY))
            .map(|(x, y)| ScrollOffset {
                scroll_left: x - viewport.x,
                scroll_top: y - viewport.y,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn fixture() -> RenderFrame {
        let viewport = rect(0.0, 0.0, 80.0, 80.0);
        let mut root = RenderNode::new("root", viewport);
        root.background = Some(Color::WHITE);
        let mut scroll = RenderNode::new("scroll", rect(10.0, 10.0, 30.0, 30.0));
        scroll.scroll_container = true;
        scroll.scroll_offset = Some(ScrollOffset {
            scroll_left: 0.0,
            scroll_top: 20.0,
        });
        scroll.background = Some(Color {
            red: 0,
            green: 0,
            blue: 255,
            alpha: 255,
        });
        let mut child = RenderNode::new("child", rect(12.0, 35.0, 20.0, 20.0));
        child.background = Some(Color::BLACK);
        scroll.children.push(child);
        root.children.push(scroll);
        let mut sibling = RenderNode::new("sibling", rect(50.0, 50.0, 10.0, 10.0));
        sibling.background = Some(Color::BLACK);
        root.children.push(sibling);
        RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root,
        }
    }

    fn pixels(frame: &RenderFrame, samples: &[(u32, u32, [u8; 4])]) {
        let mut software = SoftwareRenderer::new();
        software.commit(frame.clone()).unwrap();
        let mut native = SkiaRenderer::new();
        native.commit(frame.clone()).unwrap();
        // Explicit opt-in retains the exact tested frame and real readbacks;
        // ordinary tests leave no files. Native raster is never labeled GPU.
        if let Some(directory) = std::env::var_os("WEAPP_CONTAINER_SCROLL_EVIDENCE_DIR") {
            let thread = std::thread::current();
            let case = thread.name().unwrap_or("unnamed").replace(':', "_");
            let path = std::path::PathBuf::from(directory).join(case);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(
                path.join("frame.json"),
                serde_json::to_vec_pretty(frame).unwrap(),
            )
            .unwrap();
            for (name, renderer, snapshot) in [
                (
                    "software",
                    software.backend_name(),
                    software.snapshot().unwrap(),
                ),
                ("native", native.backend_name(), native.snapshot().unwrap()),
            ] {
                std::fs::write(path.join(format!("{name}.rgba")), &snapshot.pixels).unwrap();
                let metadata = serde_json::json!({ "frameId":snapshot.frame_id,
                    "width":snapshot.width,"height":snapshot.height,"stride":snapshot.stride,
                    "format":snapshot.format,"backend":renderer,"gpu":false });
                std::fs::write(
                    path.join(format!("{name}.json")),
                    serde_json::to_vec_pretty(&metadata).unwrap(),
                )
                .unwrap();
            }
        }
        for snapshot in [software.snapshot().unwrap(), native.snapshot().unwrap()] {
            for (x, y, expected) in samples {
                let at = ((y * snapshot.width + x) * 4) as usize;
                assert_eq!(&snapshot.pixels[at..at + 4], expected, "pixel ({x},{y})");
            }
        }
    }

    #[test]
    fn scroll_moves_descendants_and_shares_fixed_viewport_with_hits_and_geometry() {
        let frame = fixture();
        pixels(
            &frame,
            &[
                (15, 16, [0, 0, 0, 255]),
                (15, 36, [0, 0, 255, 255]),
                (15, 42, [255, 255, 255, 255]),
                (52, 52, [0, 0, 0, 255]),
            ],
        );
        assert_eq!(frame.root.hit_test(15.5, 16.5).unwrap().id, "child");
        assert_eq!(frame.root.hit_test(15.5, 36.5).unwrap().id, "scroll");
        assert_eq!(frame.root.hit_test(15.5, 42.5).unwrap().id, "root");
        let geometry = frame.node_geometries();
        assert_eq!(geometry[1].bounds, rect(10.0, 10.0, 30.0, 30.0));
        assert_eq!(geometry[2].bounds, rect(12.0, 15.0, 20.0, 20.0));
        assert_eq!(geometry[3].bounds, rect(50.0, 50.0, 10.0, 10.0));
    }

    #[test]
    fn scrolling_keeps_rounded_border_and_padding_viewport_fixed() {
        let mut frame = fixture();
        let scroll = &mut frame.root.children[0];
        scroll.style = Some(LayoutStyle {
            border: [BorderSide {
                width: 2.0,
                color: Color {
                    red: 255,
                    green: 0,
                    blue: 0,
                    alpha: 255,
                },
                style: BorderStyle::Solid,
            }; 4],
            border_radius: [CornerRadius { x: 8.0, y: 8.0 }; 4],
            ..LayoutStyle::default()
        });
        scroll.children[0].bounds = rect(0.0, 0.0, 80.0, 80.0);
        assert_eq!(scroll.scroll_viewport(), rect(12.0, 12.0, 26.0, 26.0));
        pixels(
            &frame,
            &[
                (11, 11, [255, 255, 255, 255]),
                (11, 25, [255, 0, 0, 255]),
                (13, 13, [255, 0, 0, 255]),
                (19, 14, [0, 0, 0, 255]),
            ],
        );
        assert_eq!(frame.root.hit_test(11.5, 25.5).unwrap().id, "scroll");
        assert_eq!(frame.root.hit_test(13.5, 13.5).unwrap().id, "scroll");
        assert_eq!(frame.root.hit_test(19.5, 14.5).unwrap().id, "child");
    }

    #[test]
    fn nested_transformed_scroll_containers_keep_their_own_clips_and_restore_siblings() {
        let mut frame = fixture();
        let scroll = &mut frame.root.children[0];
        scroll.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                a: 2.0,
                d: 2.0,
                ..Transform2D::IDENTITY
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
        let mut inner = RenderNode::new("inner", rect(15.0, 35.0, 10.0, 10.0));
        inner.scroll_container = true;
        inner.scroll_offset = Some(ScrollOffset {
            scroll_left: 5.0,
            scroll_top: 10.0,
        });
        let mut content = RenderNode::new("inner-content", rect(20.0, 45.0, 20.0, 20.0));
        content.background = Some(Color::BLACK);
        inner.children.push(content);
        scroll.children = vec![inner];
        pixels(
            &frame,
            &[
                (22, 22, [0, 0, 0, 255]),
                (42, 22, [0, 0, 255, 255]),
                (72, 22, [255, 255, 255, 255]),
                (52, 52, [0, 0, 0, 255]),
            ],
        );
        assert_eq!(frame.root.hit_test(22.5, 22.5).unwrap().id, "inner-content");
        assert_eq!(frame.root.hit_test(42.5, 22.5).unwrap().id, "scroll");
        let geometry = frame.node_geometries();
        assert_eq!(geometry[2].bounds, rect(20.0, 20.0, 20.0, 20.0));
        assert_eq!(geometry[3].bounds, rect(20.0, 20.0, 40.0, 40.0));
    }

    #[test]
    fn metadata_offsets_remain_untranslated_and_new_wire_flag_defaults_false() {
        let mut frame = fixture();
        frame.root.children[0].scroll_container = false;
        let json = serde_json::to_value(&frame).unwrap();
        assert!(json["root"]["children"][0].get("scrollContainer").is_none());
        let restored: RenderFrame = serde_json::from_value(json).unwrap();
        assert!(!restored.root.children[0].scroll_container);
        assert_eq!(restored.node_geometries()[2].bounds.y, 35.0);
        assert_eq!(restored.root.hit_test(15.5, 42.5).unwrap().id, "child");
        pixels(
            &restored,
            &[(15, 16, [0, 0, 255, 255]), (15, 42, [0, 0, 0, 255])],
        );
    }

    #[test]
    fn invalid_offsets_never_replace_the_previous_committed_frame_or_snapshot() {
        let frame = fixture();
        for bad in [-1.0, f32::INFINITY, f32::NEG_INFINITY, f32::NAN] {
            let mut invalid = frame.clone();
            invalid.frame_id = 2;
            invalid.root.children[0]
                .scroll_offset
                .as_mut()
                .unwrap()
                .scroll_top = bad;
            let mut software = SoftwareRenderer::new();
            software.commit(frame.clone()).unwrap();
            let before = software.snapshot();
            assert_eq!(
                software.commit(invalid.clone()),
                Err(RenderError::InvalidScrollOffset)
            );
            assert_eq!(software.last_frame(), Some(&frame));
            assert_eq!(software.snapshot(), before);
            let mut native = SkiaRenderer::new();
            native.commit(frame.clone()).unwrap();
            let before = native.snapshot();
            assert_eq!(
                native.commit(invalid),
                Err(RenderError::InvalidScrollOffset)
            );
            assert_eq!(native.last_frame(), Some(&frame));
            assert_eq!(native.snapshot(), before);
        }
    }

    #[test]
    fn content_extent_ignores_scroll_position_and_nested_content_but_counts_transforms_padding() {
        let mut frame = fixture();
        let scroll = &mut frame.root.children[0];
        scroll.style = Some(LayoutStyle {
            padding: EdgeInsets {
                right: 3.0,
                bottom: 4.0,
                ..EdgeInsets::default()
            },
            ..LayoutStyle::default()
        });
        assert_eq!(scroll.scroll_viewport(), rect(10.0, 10.0, 30.0, 30.0));
        assert_eq!(scroll.scroll_content_extent(), (30.0, 49.0));
        scroll.children[0].style = Some(LayoutStyle {
            transform: Some(Transform2D {
                e: 20.0,
                f: 10.0,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        assert_eq!(scroll.scroll_content_extent(), (45.0, 59.0));
        scroll.children[0].scroll_container = true;
        scroll.children[0].children.push(RenderNode::new(
            "nested-overflow",
            rect(500.0, 500.0, 10.0, 10.0),
        ));
        assert_eq!(scroll.scroll_content_extent(), (45.0, 59.0));
        scroll.children[0].style.as_mut().unwrap().display = DisplayMode::None;
        assert_eq!(scroll.scroll_content_extent(), (30.0, 30.0));
    }

    #[test]
    fn target_offsets_use_local_transformed_nested_scroll_geometry_and_world_matrices_match_hits() {
        let mut frame = fixture();
        let scroll = &mut frame.root.children[0];
        scroll.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                a: 2.0,
                d: 2.0,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        let inner = &mut scroll.children[0];
        inner.scroll_container = true;
        inner.scroll_offset = Some(ScrollOffset {
            scroll_left: 3.0,
            scroll_top: 4.0,
        });
        inner.style = Some(LayoutStyle {
            transform: Some(Transform2D {
                e: 5.0,
                f: 7.0,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        inner
            .children
            .push(RenderNode::new("target", rect(40.0, 60.0, 10.0, 10.0)));
        let target = &scroll.children[0].children[0];
        assert_eq!(
            scroll.scroll_target_offset(target),
            Some(ScrollOffset {
                scroll_left: 32.0,
                scroll_top: 53.0
            })
        );
        let geometry = frame.node_geometries();
        let target_geometry = &geometry[3];
        assert_eq!(
            target_geometry.world_transform.apply((40.0, 60.0)),
            (target_geometry.bounds.x, target_geometry.bounds.y)
        );
        let inverse = target_geometry.world_transform.inverse().unwrap();
        assert_eq!(
            (
                inverse.a * 20.0 + inverse.c * 10.0,
                inverse.b * 20.0 + inverse.d * 10.0
            ),
            (10.0, 5.0)
        );
        let unrelated = RenderNode::new("other", rect(0.0, 0.0, 1.0, 1.0));
        assert!(frame.root.children[0]
            .scroll_target_offset(&unrelated)
            .is_none());
        frame.root.children[0].children[0]
            .style
            .as_mut()
            .unwrap()
            .display = DisplayMode::None;
        let scroll = &frame.root.children[0];
        assert!(scroll
            .scroll_target_offset(&scroll.children[0].children[0])
            .is_none());
    }
}
