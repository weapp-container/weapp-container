//! Shared used-border geometry. Layout, paint and overflow must derive their
//! content/padding boxes from the same four computed edges.
use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BorderStyle {
    #[default]
    None,
    Hidden,
    Solid,
    Dashed,
    Dotted,
    Double,
    Groove,
    Ridge,
    Inset,
    Outset,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BorderSide {
    #[serde(default)]
    pub width: f32,
    #[serde(default = "black")]
    pub color: Color,
    #[serde(default)]
    pub style: BorderStyle,
}

fn black() -> Color {
    Color::BLACK
}

impl Default for BorderSide {
    fn default() -> Self {
        Self {
            width: 0.0,
            color: Color::BLACK,
            style: BorderStyle::None,
        }
    }
}

impl BorderSide {
    /// Width used by layout and painting. Invalid/unsupported borders are
    /// rejected by frame validation, rather than silently painted as solid.
    pub fn used_width(self) -> f32 {
        if self.style == BorderStyle::Solid && self.width.is_finite() {
            self.width.max(0.0)
        } else {
            0.0
        }
    }

    pub(super) fn validate(self) -> Result<(), RenderError> {
        if !self.width.is_finite() || self.width < 0.0 {
            return Err(RenderError::InvalidBorder);
        }
        let name = match self.style {
            BorderStyle::None | BorderStyle::Hidden | BorderStyle::Solid => return Ok(()),
            BorderStyle::Dashed => "border-style:dashed",
            BorderStyle::Dotted => "border-style:dotted",
            BorderStyle::Double => "border-style:double",
            BorderStyle::Groove => "border-style:groove",
            BorderStyle::Ridge => "border-style:ridge",
            BorderStyle::Inset => "border-style:inset",
            BorderStyle::Outset => "border-style:outset",
        };
        Err(RenderError::Unsupported(name))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum BoxSizing {
    ContentBox,
    #[default]
    BorderBox,
}

pub(super) fn is_border_box(value: &BoxSizing) -> bool {
    *value == BoxSizing::BorderBox
}

pub(super) fn is_empty_border(value: &[BorderSide; 4]) -> bool {
    value.iter().all(|side| *side == BorderSide::default())
}

impl LayoutStyle {
    /// Used border insets, in physical pixels, excluding `none` and `hidden`.
    pub fn border_insets(self) -> EdgeInsets {
        EdgeInsets {
            top: self.border[0].used_width(),
            right: self.border[1].used_width(),
            bottom: self.border[2].used_width(),
            left: self.border[3].used_width(),
        }
    }

    pub(super) fn content_insets(self) -> EdgeInsets {
        let border = self.border_insets();
        EdgeInsets {
            top: self.padding.top + border.top,
            right: self.padding.right + border.right,
            bottom: self.padding.bottom + border.bottom,
            left: self.padding.left + border.left,
        }
    }

    pub(super) fn outer_width(self, width: f32) -> f32 {
        self.outer_dimension(width, self.content_insets().horizontal())
    }

    pub(super) fn outer_height(self, height: f32) -> f32 {
        self.outer_dimension(height, self.content_insets().vertical())
    }

    fn outer_dimension(self, value: f32, insets: f32) -> f32 {
        match self.box_sizing {
            BoxSizing::ContentBox => value + insets,
            BoxSizing::BorderBox => value.max(insets),
        }
    }

    /// The inner border edge; absolute children use this containing block.
    pub fn padding_box(self, bounds: Rect) -> Rect {
        BorderGeometry::new(bounds, self).inner
    }

    /// The padding box inset by padding; flow children and text start here.
    pub fn content_box(self, bounds: Rect) -> Rect {
        inset_rect(self.padding_box(bounds), self.padding)
    }
}

fn inset_rect(bounds: Rect, insets: EdgeInsets) -> Rect {
    Rect {
        x: bounds.x + insets.left,
        y: bounds.y + insets.top,
        width: (bounds.width - insets.horizontal()).max(0.0),
        height: (bounds.height - insets.vertical()).max(0.0),
    }
}

#[derive(Clone, Copy)]
pub(super) struct BorderGeometry {
    pub outer: Rect,
    pub outer_radii: [CornerRadius; 4],
    pub inner: Rect,
    pub inner_radii: [CornerRadius; 4],
    /// Drawing widths may be proportionally clamped for legacy frames whose
    /// absolute bounds are smaller than the sum of opposing borders.
    widths: [f32; 4],
}

impl BorderGeometry {
    pub fn new(bounds: Rect, style: LayoutStyle) -> Self {
        let mut widths = style.border.map(BorderSide::used_width);
        for (near, far, extent) in [(3, 1, bounds.width), (0, 2, bounds.height)] {
            let sum = widths[near] + widths[far];
            if sum > extent && sum > 0.0 {
                let scale = extent.max(0.0) / sum;
                widths[near] *= scale;
                widths[far] *= scale;
            }
        }
        let inner = inset_rect(
            bounds,
            EdgeInsets {
                top: widths[0],
                right: widths[1],
                bottom: widths[2],
                left: widths[3],
            },
        );
        let outer_radii = normalized_corner_radii(bounds, style.border_radius);
        let inner_radii = normalized_corner_radii(
            inner,
            [
                CornerRadius {
                    x: (outer_radii[0].x - widths[3]).max(0.0),
                    y: (outer_radii[0].y - widths[0]).max(0.0),
                },
                CornerRadius {
                    x: (outer_radii[1].x - widths[1]).max(0.0),
                    y: (outer_radii[1].y - widths[0]).max(0.0),
                },
                CornerRadius {
                    x: (outer_radii[2].x - widths[1]).max(0.0),
                    y: (outer_radii[2].y - widths[2]).max(0.0),
                },
                CornerRadius {
                    x: (outer_radii[3].x - widths[3]).max(0.0),
                    y: (outer_radii[3].y - widths[2]).max(0.0),
                },
            ],
        );
        Self {
            outer: bounds,
            outer_radii,
            inner,
            inner_radii,
            widths,
        }
    }

    pub fn has_border(self) -> bool {
        self.widths.iter().any(|width| *width > 0.0)
    }

    /// Exactly one side owns a border-ring sample, including different-width
    /// corners. No side paints the transparent inner hole or blends a shared
    /// diagonal twice. This is the same partition as the native side polygons.
    pub fn side_at(self, x: f32, y: f32) -> Option<usize> {
        if !rounded_rect_contains(self.outer, x, y, self.outer_radii)
            || rounded_rect_contains(self.inner, x, y, self.inner_radii)
        {
            return None;
        }
        let local_x = f64::from(x) - f64::from(self.outer.x);
        let local_y = f64::from(y) - f64::from(self.outer.y);
        let distances = [
            local_y,
            f64::from(self.outer.width) - local_x,
            f64::from(self.outer.height) - local_y,
            local_x,
        ];
        let mut best = None;
        let mut minimum = f64::INFINITY;
        for (index, width) in self.widths.into_iter().enumerate() {
            if width > 0.0 {
                let ratio = distances[index] / f64::from(width);
                if ratio < minimum {
                    minimum = ratio;
                    best = Some(index);
                }
            }
        }
        best
    }

    #[cfg(any(feature = "skia-backend", test))]
    pub fn side_polygon(self, side: usize) -> Vec<(f32, f32)> {
        let widths = self.widths.map(f64::from);
        if widths[side] <= 0.0 {
            return Vec::new();
        }
        let width = f64::from(self.outer.width);
        let height = f64::from(self.outer.height);
        // Local coordinates keep products finite even for translated boxes.
        // Clip the whole rectangle to the region with minimum d_i / w_i.
        // Extending the corner bisectors inside the inner rectangle matters:
        // a rounded inner hole leaves paintable corner rings there.
        let distances = [
            (0.0, 1.0, 0.0),
            (-1.0, 0.0, width),
            (0.0, -1.0, height),
            (1.0, 0.0, 0.0),
        ];
        let mut polygon = vec![(0.0, 0.0), (width, 0.0), (width, height), (0.0, height)];
        let selected = distances[side];
        for (index, other) in distances.into_iter().enumerate() {
            if index == side || widths[index] <= 0.0 || polygon.is_empty() {
                continue;
            }
            let a = selected.0 * widths[index] - other.0 * widths[side];
            let b = selected.1 * widths[index] - other.1 * widths[side];
            let c = selected.2 * widths[index] - other.2 * widths[side];
            let value = |point: (f64, f64)| a * point.0 + b * point.1 + c;
            let mut output = Vec::new();
            let mut previous = *polygon.last().expect("nonempty polygon");
            let mut previous_value = value(previous);
            for point in polygon {
                let current_value = value(point);
                if (previous_value <= 0.0) != (current_value <= 0.0) {
                    let fraction = previous_value / (previous_value - current_value);
                    output.push((
                        previous.0 + (point.0 - previous.0) * fraction,
                        previous.1 + (point.1 - previous.1) * fraction,
                    ));
                }
                if current_value <= 0.0 {
                    output.push(point);
                }
                previous = point;
                previous_value = current_value;
            }
            polygon = output;
        }
        polygon
            .into_iter()
            .map(|point| {
                (
                    (point.0 + f64::from(self.outer.x)) as f32,
                    (point.1 + f64::from(self.outer.y)) as f32,
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side(width: f32, color: Color) -> BorderSide {
        BorderSide {
            width,
            color,
            style: BorderStyle::Solid,
        }
    }

    fn viewport() -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 150.0,
        }
    }

    fn box_style(box_sizing: BoxSizing) -> LayoutStyle {
        LayoutStyle {
            width: Some(100.0),
            height: Some(50.0),
            box_sizing,
            padding: EdgeInsets {
                top: 3.0,
                right: 5.0,
                bottom: 7.0,
                left: 9.0,
            },
            border: [
                side(4.0, Color::BLACK),
                side(6.0, Color::BLACK),
                side(8.0, Color::BLACK),
                side(10.0, Color::BLACK),
            ],
            ..LayoutStyle::default()
        }
    }

    fn node(id: &str, style: LayoutStyle) -> RenderNode {
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

    fn paint_frame() -> RenderFrame {
        let bounds = Rect {
            x: 2.0,
            y: 2.0,
            width: 32.0,
            height: 30.0,
        };
        let color = |red, green, blue| Color {
            red,
            green,
            blue,
            alpha: 128,
        };
        RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport: Rect {
                width: 40.0,
                height: 40.0,
                ..viewport()
            },
            root: RenderNode::new("border", bounds).with_style(LayoutStyle {
                border: [
                    side(3.0, color(255, 0, 0)),
                    side(5.0, color(0, 255, 0)),
                    side(7.0, color(0, 0, 255)),
                    side(9.0, color(255, 255, 0)),
                ],
                ..LayoutStyle::default()
            }),
        }
    }

    fn pixel(snapshot: &RenderSnapshot, x: usize, y: usize) -> [u8; 4] {
        let offset = y * snapshot.stride as usize + x * 4;
        snapshot.pixels[offset..offset + 4].try_into().unwrap()
    }

    #[test]
    fn legacy_style_wire_defaults_keep_border_box_and_omit_new_default_fields() {
        let style: LayoutStyle = serde_json::from_str("{}").unwrap();
        assert_eq!(style.box_sizing, BoxSizing::BorderBox);
        assert_eq!(style.border, [BorderSide::default(); 4]);
        let wire = serde_json::to_value(style).unwrap();
        assert!(wire.get("border").is_none());
        assert!(wire.get("box_sizing").is_none());
        let content: LayoutStyle = serde_json::from_str(r#"{"box_sizing":"content-box"}"#).unwrap();
        assert_eq!(content.box_sizing, BoxSizing::ContentBox);
        assert!(serde_json::from_str::<BorderSide>(r#"{"style":"pretend"}"#).is_err());
    }

    #[test]
    fn explicit_box_sizing_counts_all_four_borders_and_padding_once() {
        for (sizing, width, height) in [
            (BoxSizing::ContentBox, 130.0, 72.0),
            (BoxSizing::BorderBox, 100.0, 50.0),
        ] {
            let mut root = RenderNode::new("root", viewport()).with_style(LayoutStyle::default());
            let mut card = node("card", box_style(sizing));
            card.children.push(node(
                "flow",
                LayoutStyle {
                    width: Some(10.0),
                    height: Some(10.0),
                    ..LayoutStyle::default()
                },
            ));
            root.children = vec![card, node("after", LayoutStyle::default())];
            layout_tree(&mut root, viewport());
            assert_eq!(root.children[0].bounds.width, width);
            assert_eq!(root.children[0].bounds.height, height);
            assert_eq!(root.children[0].children[0].bounds.x, 19.0);
            assert_eq!(root.children[0].children[0].bounds.y, 7.0);
            assert_eq!(root.children[1].bounds.y, height);
            let previous = root.clone();
            layout_tree(&mut root, viewport());
            assert_eq!(root, previous, "relayout must not accumulate border insets");
        }
    }

    #[test]
    fn border_box_minimum_and_auto_fill_never_double_add_insets() {
        let mut style = box_style(BoxSizing::BorderBox);
        style.width = Some(1.0);
        style.height = Some(2.0);
        let mut root = RenderNode::new("root", viewport()).with_style(LayoutStyle::default());
        root.children.push(node("small", style));
        let mut auto = node(
            "auto",
            LayoutStyle {
                width: None,
                height: None,
                ..box_style(BoxSizing::ContentBox)
            },
        );
        auto.children.push(node(
            "content",
            LayoutStyle {
                height: Some(10.0),
                ..LayoutStyle::default()
            },
        ));
        root.children.push(auto);
        layout_tree(&mut root, viewport());
        assert_eq!(root.children[0].bounds.width, 30.0);
        assert_eq!(root.children[0].bounds.height, 22.0);
        assert_eq!(root.children[1].bounds.width, 200.0);
        assert_eq!(root.children[1].bounds.height, 32.0);
        assert_eq!(root.children[1].children[0].bounds.width, 170.0);
        let previous = root.clone();
        layout_tree(&mut root, viewport());
        assert_eq!(root, previous);
    }

    #[test]
    fn absolute_children_use_padding_box_while_flow_and_text_use_content_box() {
        let style = LayoutStyle {
            position: PositionMode::Relative,
            ..box_style(BoxSizing::ContentBox)
        };
        let mut root = RenderNode::new("root", viewport()).with_style(style);
        root.children.push(node(
            "absolute",
            LayoutStyle {
                position: PositionMode::Absolute,
                left: Some(0.0),
                right: Some(0.0),
                top: Some(0.0),
                bottom: Some(0.0),
                ..LayoutStyle::default()
            },
        ));
        root.children.push(node(
            "flow",
            LayoutStyle {
                width: Some(5.0),
                height: Some(5.0),
                ..LayoutStyle::default()
            },
        ));
        layout_tree(&mut root, viewport());
        assert_eq!(root.bounds.width, 130.0);
        assert_eq!(root.bounds.height, 72.0);
        assert_eq!(
            root.children[0].bounds,
            Rect {
                x: 10.0,
                y: 4.0,
                width: 114.0,
                height: 60.0
            }
        );
        assert_eq!(
            root.children[1].bounds,
            Rect {
                x: 19.0,
                y: 7.0,
                width: 5.0,
                height: 5.0
            }
        );
        assert_eq!(
            style.content_box(root.bounds),
            Rect {
                x: 19.0,
                y: 7.0,
                width: 100.0,
                height: 50.0
            }
        );
    }

    #[test]
    fn none_and_hidden_edges_have_zero_used_width_and_never_paint() {
        for style in [BorderStyle::None, BorderStyle::Hidden] {
            let mut frame = paint_frame();
            frame.root.style.as_mut().unwrap().border = [BorderSide {
                width: 50.0,
                color: Color::BLACK,
                style,
            }; 4];
            assert_eq!(frame.root.style.unwrap().border_insets(), EdgeInsets::ZERO);
            let mut renderer = SoftwareRenderer::new();
            renderer.commit(frame).unwrap();
            assert!(renderer
                .snapshot()
                .unwrap()
                .pixels
                .iter()
                .all(|byte| *byte == 0));
        }
    }

    #[test]
    fn software_four_color_border_preserves_transparent_hole_and_single_blending() {
        let mut renderer = SoftwareRenderer::new();
        renderer.commit(paint_frame()).unwrap();
        let snapshot = renderer.snapshot().unwrap();
        for (x, y, expected) in [
            (16, 3, [128, 0, 0, 128]),
            (32, 15, [0, 128, 0, 128]),
            (16, 30, [0, 0, 128, 128]),
            (3, 15, [128, 128, 0, 128]),
            (16, 15, [0, 0, 0, 0]),
            (0, 0, [0, 0, 0, 0]),
        ] {
            assert_eq!(pixel(&snapshot, x, y), expected, "{x},{y}");
        }
        assert!(
            snapshot
                .pixels
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| pixel[3] == 0 || pixel[3] == 128),
            "corner joins must not composite multiple sides"
        );
    }

    #[test]
    fn border_uses_both_inner_and_outer_rounded_edges_without_filling_the_hole() {
        let mut frame = paint_frame();
        frame.root.bounds = Rect {
            x: 4.0,
            y: 4.0,
            width: 32.0,
            height: 32.0,
        };
        frame.root.style = Some(LayoutStyle {
            border: [side(4.0, Color::BLACK); 4],
            border_radius: [CornerRadius { x: 12.0, y: 12.0 }; 4],
            ..LayoutStyle::default()
        });
        let mut renderer = SoftwareRenderer::new();
        renderer.commit(frame).unwrap();
        let snapshot = renderer.snapshot().unwrap();
        assert_eq!(pixel(&snapshot, 4, 4), [0, 0, 0, 0]);
        assert_eq!(pixel(&snapshot, 16, 5), [0, 0, 0, 255]);
        assert_eq!(pixel(&snapshot, 9, 9), [0, 0, 0, 255]);
        assert_eq!(pixel(&snapshot, 10, 10), [0, 0, 0, 0]);
        assert_eq!(pixel(&snapshot, 20, 20), [0, 0, 0, 0]);
    }

    #[test]
    fn asymmetric_corner_rounding_matches_border_paint_overflow_and_hits() {
        let mut frame = paint_frame();
        frame.root.bounds = Rect {
            x: 4.0,
            y: 4.0,
            width: 32.0,
            height: 32.0,
        };
        frame.root.style = Some(LayoutStyle {
            border: [side(4.0, Color::BLACK); 4],
            border_radius: [
                CornerRadius::ZERO,
                CornerRadius { x: 12.0, y: 12.0 },
                CornerRadius::ZERO,
                CornerRadius::ZERO,
            ],
            ..LayoutStyle::default()
        });
        frame
            .root
            .computed_style
            .insert("overflow".into(), "hidden".into());
        assert!(frame.root.hit_test(4.5, 4.5).is_some());
        assert!(frame.root.hit_test(35.5, 4.5).is_none());
        let clip = frame
            .root
            .descendant_clip(frame.root.style.unwrap().border_radius)
            .unwrap();
        assert!(clip.contains(8.5, 8.5));
        assert!(!clip.contains(31.5, 8.5));
        let mut renderer = SoftwareRenderer::new();
        renderer.commit(frame).unwrap();
        let snapshot = renderer.snapshot().unwrap();
        assert_eq!(pixel(&snapshot, 4, 4), [0, 0, 0, 255]);
        assert_eq!(pixel(&snapshot, 35, 4), [0, 0, 0, 0]);
        assert_eq!(pixel(&snapshot, 30, 9), [0, 0, 0, 255]);
    }

    #[test]
    fn fractional_corner_normalization_ignores_empty_adjacent_pairs() {
        let bounds = Rect {
            x: 0.0,
            y: 0.0,
            width: 0.5,
            height: 10.0,
        };
        let radii = [
            CornerRadius { x: 0.0, y: 1.0 },
            CornerRadius { x: 0.0, y: 1.0 },
            CornerRadius { x: 0.1, y: 1.0 },
            CornerRadius { x: 0.1, y: 1.0 },
        ];
        assert_eq!(normalized_corner_radii(bounds, radii), radii);
        assert!(!rounded_rect_contains(bounds, 0.01, 9.7, radii));
        assert!(rounded_rect_contains(bounds, 0.01, 9.1, radii));
    }

    #[test]
    fn extreme_finite_corner_pairs_normalize_without_sum_overflow_or_factor_underflow() {
        for extent in [40.0, f32::MIN_POSITIVE] {
            let normalized = normalized_corner_radii(
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: extent,
                    height: extent,
                },
                [CornerRadius {
                    x: f32::MAX,
                    y: f32::MAX,
                }; 4],
            );
            assert_eq!(
                normalized,
                [CornerRadius {
                    x: extent / 2.0,
                    y: extent / 2.0,
                }; 4],
                "finite corners must remain rounded at extent {extent}"
            );
        }
    }

    #[test]
    fn transformed_subpixel_corner_geometry_matches_paint_and_hit_testing() {
        let mut root = RenderNode::new(
            "fractional",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 10.0,
            },
        )
        .with_style(LayoutStyle {
            border_radius: [
                CornerRadius { x: 0.0, y: 1.0 },
                CornerRadius { x: 0.0, y: 1.0 },
                CornerRadius { x: 0.1, y: 1.0 },
                CornerRadius { x: 0.1, y: 1.0 },
            ],
            transform: Some(Transform2D {
                a: 100.0,
                d: 4.0,
                e: 4.0,
                f: 4.0,
                ..Transform2D::IDENTITY
            }),
            transform_origin: Some(TransformOrigin {
                x: TransformOriginValue::percent(0.0),
                y: TransformOriginValue::percent(0.0),
            }),
            ..LayoutStyle::default()
        });
        root.background = Some(Color::BLACK);
        assert!(root.hit_test(4.5, 40.5).is_some());
        assert!(root.hit_test(4.5, 42.5).is_none());
        let frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport: Rect {
                x: 0.0,
                y: 0.0,
                width: 64.0,
                height: 48.0,
            },
            root,
        };
        let mut software = SoftwareRenderer::new();
        software.commit(frame.clone()).unwrap();
        let snapshot = software.snapshot().unwrap();
        assert_eq!(pixel(&snapshot, 4, 40), [0, 0, 0, 255]);
        assert_eq!(pixel(&snapshot, 4, 42), [0, 0, 0, 0]);
        #[cfg(feature = "skia-backend")]
        {
            let mut native = SkiaRenderer::new();
            native.commit(frame).unwrap();
            let snapshot = native.snapshot().unwrap();
            // These points lie beyond the antialiased curve boundary.
            assert_eq!(pixel(&snapshot, 4, 42), [0, 0, 0, 0]);
            assert_eq!(pixel(&snapshot, 24, 40), [0, 0, 0, 255]);
        }
    }

    #[test]
    fn overflow_clips_descendants_at_inner_border_without_disabling_border_hits() {
        let mut frame = paint_frame();
        frame.root.id = "panel".into();
        frame.root.bounds = Rect {
            x: 4.0,
            y: 4.0,
            width: 32.0,
            height: 32.0,
        };
        frame.root.style = Some(LayoutStyle {
            border: [side(8.0, Color::BLACK); 4],
            ..LayoutStyle::default()
        });
        frame
            .root
            .computed_style
            .insert("overflow".into(), "hidden".into());
        let mut child = RenderNode::new(
            "child",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 40.0,
                height: 40.0,
            },
        );
        child.background = Some(Color::WHITE);
        frame.root.children.push(child);
        assert_eq!(frame.root.hit_test(5.0, 16.0).unwrap().id, "panel");
        assert_eq!(frame.root.hit_test(14.0, 14.0).unwrap().id, "child");
        let mut renderer = SoftwareRenderer::new();
        renderer.commit(frame).unwrap();
        let snapshot = renderer.snapshot().unwrap();
        assert_eq!(pixel(&snapshot, 5, 16), [0, 0, 0, 255]);
        assert_eq!(pixel(&snapshot, 14, 14), [255, 255, 255, 255]);
        assert_eq!(pixel(&snapshot, 2, 16), [0, 0, 0, 0]);
    }

    #[test]
    fn transformed_border_obeys_ancestor_clip_and_opacity_without_painting_interior() {
        let mut frame = paint_frame();
        frame.root = RenderNode::new(
            "clip",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 40.0,
            },
        );
        frame
            .root
            .computed_style
            .insert("overflow".into(), "hidden".into());
        let mut border = RenderNode::new(
            "border",
            Rect {
                x: 4.0,
                y: 4.0,
                width: 20.0,
                height: 20.0,
            },
        )
        .with_style(LayoutStyle {
            border: [side(2.0, Color::BLACK); 4],
            transform: Some(Transform2D {
                e: 8.0,
                ..Transform2D::IDENTITY
            }),
            ..LayoutStyle::default()
        });
        border.opacity = 0.5;
        frame.root.children.push(border);
        let mut renderer = SoftwareRenderer::new();
        renderer.commit(frame).unwrap();
        let snapshot = renderer.snapshot().unwrap();
        assert_eq!(pixel(&snapshot, 13, 5), [0, 0, 0, 128]);
        assert_eq!(pixel(&snapshot, 19, 5), [0, 0, 0, 128]);
        assert_eq!(pixel(&snapshot, 22, 5), [0, 0, 0, 0]);
        assert_eq!(pixel(&snapshot, 5, 5), [0, 0, 0, 0]);
        assert_eq!(pixel(&snapshot, 18, 10), [0, 0, 0, 0]);
    }

    #[test]
    fn malformed_and_unimplemented_borders_reject_before_replacing_the_previous_frame() {
        let mut renderer = SkiaRenderer::new();
        renderer.commit(paint_frame()).unwrap();
        let previous_frame = renderer.last_frame().unwrap().clone();
        let previous_pixels = renderer.snapshot().unwrap();
        for width in [-1.0, f32::NAN, f32::INFINITY] {
            let mut rejected = paint_frame();
            rejected.frame_id = 2;
            rejected.root.style.as_mut().unwrap().border[0].width = width;
            assert_eq!(renderer.commit(rejected), Err(RenderError::InvalidBorder));
            assert_eq!(renderer.last_frame().unwrap(), &previous_frame);
            assert_eq!(renderer.snapshot().unwrap(), previous_pixels);
        }
        for style in [
            BorderStyle::Dashed,
            BorderStyle::Dotted,
            BorderStyle::Double,
            BorderStyle::Groove,
            BorderStyle::Ridge,
            BorderStyle::Inset,
            BorderStyle::Outset,
        ] {
            let mut rejected = paint_frame();
            rejected.root.style.as_mut().unwrap().border[0].style = style;
            assert!(matches!(
                renderer.commit(rejected),
                Err(RenderError::Unsupported(_))
            ));
            assert_eq!(renderer.last_frame().unwrap(), &previous_frame);
            assert_eq!(renderer.snapshot().unwrap(), previous_pixels);
        }
    }

    #[test]
    fn oversized_legacy_border_bounds_collapse_proportionally_inside_the_box() {
        let geometry = BorderGeometry::new(
            Rect {
                x: 4.0,
                y: 5.0,
                width: 10.0,
                height: 10.0,
            },
            LayoutStyle {
                border: [
                    side(2.0, Color::BLACK),
                    side(3.0, Color::BLACK),
                    side(2.0, Color::BLACK),
                    side(9.0, Color::BLACK),
                ],
                border_radius: [CornerRadius { x: 8.0, y: 8.0 }; 4],
                ..LayoutStyle::default()
            },
        );
        assert_eq!(
            geometry.inner,
            Rect {
                x: 11.5,
                y: 7.0,
                width: 0.0,
                height: 6.0
            }
        );
        assert_eq!(geometry.inner_radii, [CornerRadius::ZERO; 4]);
        assert!(geometry.side_at(10.0, 10.0).is_some());
        assert_eq!(geometry.side_at(3.0, 10.0), None);
    }

    #[test]
    fn side_regions_extend_inside_the_inner_rectangle_to_cover_rounded_corner_rings() {
        let geometry = BorderGeometry::new(
            Rect {
                x: 4.0,
                y: 4.0,
                width: 32.0,
                height: 32.0,
            },
            LayoutStyle {
                border: [side(4.0, Color::BLACK); 4],
                border_radius: [CornerRadius { x: 12.0, y: 12.0 }; 4],
                ..LayoutStyle::default()
            },
        );
        let point = (9.75, 9.25);
        assert!(geometry.inner.contains(point.0, point.1));
        assert!(!rounded_rect_contains(
            geometry.inner,
            point.0,
            point.1,
            geometry.inner_radii
        ));
        assert_eq!(geometry.side_at(point.0, point.1), Some(0));
        let polygon = geometry.side_polygon(0);
        assert!(
            polygon.iter().any(|point| point.1 > geometry.inner.y),
            "corner bisectors must extend beyond the inner rectangle edge"
        );
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_skia_border_readback_matches_software_side_colors_and_transparent_center() {
        let frame = paint_frame();
        let mut software = SoftwareRenderer::new();
        software.commit(frame.clone()).unwrap();
        let mut native = SkiaRenderer::new();
        native.commit(frame).unwrap();
        let expected = software.snapshot().unwrap();
        let actual = native.snapshot().unwrap();
        for (x, y) in [(16, 3), (32, 15), (16, 30), (3, 15), (16, 15), (0, 0)] {
            assert_eq!(pixel(&actual, x, y), pixel(&expected, x, y), "{x},{y}");
        }
        assert!(
            actual
                .pixels
                .as_chunks::<4>()
                .0
                .iter()
                .all(|pixel| pixel[3] == 0 || pixel[3] == 128),
            "native diagonal joins must not double blend"
        );

        let mut rounded = paint_frame();
        rounded.root.bounds = Rect {
            x: 4.0,
            y: 4.0,
            width: 32.0,
            height: 32.0,
        };
        rounded.root.style = Some(LayoutStyle {
            border: [side(4.0, Color::BLACK); 4],
            border_radius: [CornerRadius { x: 12.0, y: 12.0 }; 4],
            ..LayoutStyle::default()
        });
        software.commit(rounded.clone()).unwrap();
        native.commit(rounded).unwrap();
        let expected = software.snapshot().unwrap();
        let actual = native.snapshot().unwrap();
        for (x, y) in [(4, 4), (16, 5), (9, 9), (10, 10), (20, 20)] {
            assert_eq!(
                pixel(&actual, x, y),
                pixel(&expected, x, y),
                "rounded {x},{y}"
            );
        }
    }
}
