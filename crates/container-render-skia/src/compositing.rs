//! Isolated opacity groups share one bounded allocation contract across
//! software, native raster and host-sized native targets.
use super::{DisplayMode, RenderError, RenderNode};

/// Additional simultaneously live RGBA8 opacity-layer storage. The accepted
/// surface/snapshot and Skia's own allocator overhead are outside this limit.
pub const MAX_COMPOSITING_LAYER_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_COMPOSITING_LAYER_DEPTH: usize = 32;

pub(crate) fn layer_depth(node: &RenderNode, bytes: usize) -> Result<usize, RenderError> {
    fn visit(node: &RenderNode, depth: usize, maximum: &mut usize) -> Result<(), RenderError> {
        if node.style.unwrap_or_default().display == DisplayMode::None || node.opacity == 0.0 {
            return Ok(());
        }
        let depth = depth + usize::from(node.opacity < 1.0);
        if depth > MAX_COMPOSITING_LAYER_DEPTH {
            return Err(RenderError::CompositingBudgetExceeded);
        }
        *maximum = (*maximum).max(depth);
        for child in &node.children {
            visit(child, depth, maximum)?;
        }
        Ok(())
    }
    let mut depth = 0;
    visit(node, 0, &mut depth)?;
    if bytes
        .checked_mul(depth)
        .is_none_or(|bytes| bytes > MAX_COMPOSITING_LAYER_BYTES)
    {
        return Err(RenderError::CompositingBudgetExceeded);
    }
    Ok(depth)
}

/// Round once at the group boundary, matching native N32 save-layer alpha.
pub(crate) fn alpha(opacity: f32) -> u8 {
    (opacity * 255.0).round() as u8
}

/// Use an alpha-only restore filter so N32 raster layers take Skia's accurate
/// shader/pipeline route. `save_layer_alpha` permits the legacy sprite blitter
/// (`SkAlpha255To256(alpha) == alpha + 1`, then `>> 8`), which changes 50% red
/// over white from [255,127,127] to [255,126,126] and compounds across nesting.
/// The filter leaves unpremultiplied RGB unchanged; Skia then premultiplies
/// with the scaled alpha exactly once. GPU targets use the same restore paint.
#[cfg(feature = "skia-backend")]
pub(crate) fn save_native_layer(canvas: &crate::skia::Canvas, opacity: f32) -> usize {
    let mut matrix = crate::skia::ColorMatrix::default();
    matrix.set_scale(1.0, 1.0, 1.0, f32::from(alpha(opacity)) / 255.0);
    let mut paint = crate::skia::Paint::default();
    paint.set_color_filter(crate::skia::color_filters::matrix(&matrix, None));
    let layer = canvas.save_layer(&crate::skia::canvas::SaveLayerRec::default().paint(&paint));
    layer
}

pub(crate) struct LayerPool(Vec<Vec<u8>>);

impl LayerPool {
    pub(crate) fn new(depth: usize, bytes: usize) -> Result<Self, RenderError> {
        let mut buffers = Vec::new();
        buffers
            .try_reserve_exact(depth)
            .map_err(|_| RenderError::CompositingBudgetExceeded)?;
        for _ in 0..depth {
            let mut pixels = Vec::new();
            pixels
                .try_reserve_exact(bytes)
                .map_err(|_| RenderError::CompositingBudgetExceeded)?;
            pixels.resize(bytes, 0);
            buffers.push(pixels);
        }
        Ok(Self(buffers))
    }

    pub(crate) fn take(&mut self) -> Vec<u8> {
        let mut pixels = self
            .0
            .pop()
            .expect("opacity depth validated before rasterization");
        pixels.fill(0);
        pixels
    }

    pub(crate) fn recycle(&mut self, pixels: Vec<u8>) {
        self.0.push(pixels);
    }
}

/// Source and destination are both premultiplied RGBA8. Scaling an already
/// composited group cannot reuse the straight-color primitive blend helper.
pub(crate) fn composite(destination: &mut [u8], source: &[u8], alpha: u8) {
    debug_assert_eq!(destination.len(), source.len());
    let (destination, destination_tail) = destination.as_chunks_mut::<4>();
    let (source, source_tail) = source.as_chunks::<4>();
    debug_assert!(destination_tail.is_empty() && source_tail.is_empty());
    for (destination, source) in destination.iter_mut().zip(source) {
        let scaled_alpha = (u32::from(source[3]) * u32::from(alpha) + 127) / 255;
        let inverse = 255 - scaled_alpha;
        for channel in 0..4 {
            let scaled = (u32::from(source[channel]) * u32::from(alpha) + 127) / 255;
            destination[channel] =
                (scaled + (u32::from(destination[channel]) * inverse + 127) / 255).min(255) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Color, Rect, RenderFrame, Renderer, SkiaRenderer, SoftwareRenderer};
    use std::collections::BTreeMap;

    #[test]
    fn premultiplied_group_is_scaled_once_including_its_alpha() {
        let mut destination = [255, 255, 255, 255];
        composite(&mut destination, &[0, 0, 255, 255], alpha(0.5));
        assert_eq!(destination, [127, 127, 255, 255]);
        let mut transparent = [0; 4];
        composite(&mut transparent, &[0, 0, 128, 128], alpha(0.5));
        assert_eq!(transparent, [0, 0, 64, 64]);
    }

    #[test]
    fn allocation_budget_uses_peak_nested_depth_and_reuses_sibling_slots() {
        let bounds = Rect {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        };
        let mut root = RenderNode::new("root", bounds);
        let mut translucent = RenderNode::new("group", bounds);
        translucent.opacity = 0.5;
        root.children = vec![translucent.clone(); 100];
        assert_eq!(layer_depth(&root, MAX_COMPOSITING_LAYER_BYTES), Ok(1));
        root.opacity = 0.5;
        assert_eq!(
            layer_depth(&root, MAX_COMPOSITING_LAYER_BYTES),
            Err(RenderError::CompositingBudgetExceeded)
        );
        assert_eq!(layer_depth(&root, MAX_COMPOSITING_LAYER_BYTES / 2), Ok(2));
        root.opacity = 0.0;
        assert_eq!(layer_depth(&root, usize::MAX), Ok(0));
        let mut pool = LayerPool::new(1, 4).unwrap();
        let mut layer = pool.take();
        let address = layer.as_ptr();
        layer.fill(255);
        pool.recycle(layer);
        let layer = pool.take();
        assert_eq!(layer.as_ptr(), address);
        assert_eq!(layer, [0; 4]);
    }
    fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn color(red: u8, green: u8, blue: u8, alpha: u8) -> Color {
        Color {
            red,
            green,
            blue,
            alpha,
        }
    }

    fn painted(id: &str, bounds: Rect, rgba: Color) -> RenderNode {
        let mut node = RenderNode::new(id, bounds);
        node.background = Some(rgba);
        node
    }

    fn frame(width: f32, height: f32) -> RenderFrame {
        let viewport = rect(0.0, 0.0, width, height);
        RenderFrame {
            frame_id: 1,
            viewport,
            root: painted("root", viewport, color(255, 255, 255, 255)),
            images: BTreeMap::new(),
        }
    }

    fn group_fixture() -> (RenderFrame, Vec<u8>) {
        let mut frame = frame(8.0, 4.0);
        let mut group = painted("group", rect(0.0, 0.0, 4.0, 4.0), color(255, 0, 0, 255));
        group.opacity = 0.5;
        group.children = vec![
            painted("green", rect(0.0, 0.0, 3.0, 3.0), color(0, 255, 0, 255)),
            painted("blue", rect(1.0, 1.0, 3.0, 3.0), color(0, 0, 255, 255)),
        ];
        let mut outer = painted("outer", rect(4.0, 0.0, 4.0, 4.0), color(255, 0, 0, 255));
        outer.opacity = 0.5;
        let mut inner = painted("inner", rect(4.0, 0.0, 3.0, 3.0), color(0, 255, 0, 255));
        inner.opacity = 0.5;
        inner.children.push(painted(
            "inner-blue",
            rect(5.0, 1.0, 2.0, 2.0),
            color(0, 0, 255, 255),
        ));
        outer.children.push(inner);
        frame.root.children = vec![group, outer];
        // Every pixel is checked, including unchanged red areas, overlapping
        // siblings and the twice-composited nested subtree. These colors are
        // computed from the completed opaque subtree, not per-node opacity.
        let mut expected = Vec::new();
        for y in 0..4 {
            for x in 0..8 {
                let rgba = if x < 4 {
                    if x >= 1 && y >= 1 {
                        [127, 127, 255, 255]
                    } else if x < 3 && y < 3 {
                        [127, 255, 127, 255]
                    } else {
                        [255, 127, 127, 255]
                    }
                } else if (5..7).contains(&x) && (1..3).contains(&y) {
                    [191, 127, 191, 255]
                } else if x < 7 && y < 3 {
                    [191, 191, 127, 255]
                } else {
                    [255, 127, 127, 255]
                };
                expected.extend(rgba);
            }
        }
        (frame, expected)
    }

    #[test]
    fn overlapping_backgrounds_siblings_and_nested_groups_blend_once() {
        let (frame, expected) = group_fixture();
        let mut renderer = SoftwareRenderer::new();
        renderer.commit(frame).unwrap();
        assert_eq!(renderer.snapshot().unwrap().pixels, expected);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_isolated_subtrees_match_full_rgba_and_host_target_scaling() {
        use crate::NativeFonts;
        let (frame, expected) = group_fixture();
        let mut renderer = SkiaRenderer::new();
        renderer.commit(frame.clone()).unwrap();
        assert_eq!(renderer.snapshot().unwrap().pixels, expected);
        let mut surface = crate::skia::surfaces::raster_n32_premul((16, 8)).unwrap();
        let save_count = surface.canvas().save_count();
        SkiaRenderer::draw_frame_to_target(
            surface.canvas(),
            &frame,
            16,
            8,
            &mut NativeFonts::new(),
        )
        .unwrap();
        assert_eq!(surface.canvas().save_count(), save_count);
        let actual = crate::native_raster::readback_native(&mut surface, 1, 16, 8).unwrap();
        for y in 0..8 {
            for x in 0..16 {
                let source = (y / 2 * 8 + x / 2) * 4;
                let target = (y * 16 + x) * 4;
                assert_eq!(
                    &actual.pixels[target..target + 4],
                    &expected[source..source + 4],
                    "pixel ({x}, {y})"
                );
            }
        }
    }

    #[test]
    fn intrinsic_alpha_and_transparent_groups_keep_premultiplied_readback() {
        let mut frame = frame(1.0, 1.0);
        frame.root.background = None;
        let mut group = painted("group", frame.viewport, color(0, 0, 255, 128));
        group.opacity = 0.5;
        frame.root.children = vec![group];
        for opacity in [0.0, 0.5, 1.0] {
            frame.root.children[0].opacity = opacity;
            let expected = match opacity {
                0.0 => [0; 4],
                0.5 => [0, 0, 64, 64],
                _ => [0, 0, 128, 128],
            };
            let mut software = SoftwareRenderer::new();
            software.commit(frame.clone()).unwrap();
            assert_eq!(software.snapshot().unwrap().pixels, expected);
            #[cfg(feature = "skia-backend")]
            {
                let mut native = SkiaRenderer::new();
                native.commit(frame.clone()).unwrap();
                assert_eq!(native.snapshot().unwrap().pixels, expected);
            }
        }
    }

    #[test]
    fn group_layers_preserve_visible_overflow_and_fixed_escape_from_clips_and_scroll() {
        use crate::{FlowStyle, LayoutStyle, PositionMode, ScrollOffset};
        let mut frame = frame(8.0, 4.0);
        let mut group = painted("group", rect(0.0, 0.0, 1.0, 1.0), color(255, 0, 0, 255));
        group.opacity = 0.5;
        group.children.push(painted(
            "overflow",
            rect(6.0, 1.0, 2.0, 2.0),
            color(0, 255, 0, 255),
        ));
        frame.root.children = vec![group.clone()];
        let mut expected = vec![255; 8 * 4 * 4];
        expected[0..4].copy_from_slice(&[255, 127, 127, 255]);
        for y in 1..3 {
            for x in 6..8 {
                let index = (y * 8 + x) * 4;
                expected[index..index + 4].copy_from_slice(&[127, 255, 127, 255]);
            }
        }
        let check = |frame: RenderFrame, expected: &[u8]| {
            let mut software = SoftwareRenderer::new();
            software.commit(frame.clone()).unwrap();
            assert_eq!(software.snapshot().unwrap().pixels, expected);
            #[cfg(feature = "skia-backend")]
            {
                let mut native = SkiaRenderer::new();
                native.commit(frame).unwrap();
                assert_eq!(native.snapshot().unwrap().pixels, expected);
            }
        };
        check(frame.clone(), &expected);
        group
            .computed_style
            .insert("overflow".into(), "hidden".into());
        group.scroll_container = true;
        group.scroll_offset = Some(ScrollOffset {
            scroll_left: 10.0,
            scroll_top: 10.0,
        });
        group.children[0].style = Some(LayoutStyle {
            flow: Some(FlowStyle::default()),
            position: PositionMode::Fixed,
            ..LayoutStyle::default()
        });
        frame.root.children = vec![group];
        assert_eq!(frame.root.hit_test(6.5, 1.5).unwrap().id, "overflow");
        check(frame, &expected);
    }

    #[test]
    fn budget_depth_and_invalid_opacity_rejection_preserve_accepted_frame_and_pixels() {
        let accepted = frame(1.0, 1.0);
        let mut oversized = frame(4097.0, 4097.0);
        oversized.root.opacity = 0.5;
        let mut deep = frame(1.0, 1.0);
        let mut node = RenderNode::new("leaf", deep.viewport);
        for i in 0..MAX_COMPOSITING_LAYER_DEPTH {
            let mut parent = RenderNode::new(format!("group-{i}"), deep.viewport);
            parent.opacity = 0.5;
            parent.children.push(node);
            node = parent;
        }
        deep.root = node;
        assert_eq!(layer_depth(&deep.root, 4), Ok(MAX_COMPOSITING_LAYER_DEPTH));
        let mut overdeep = deep.clone();
        let mut outer = RenderNode::new("outer", deep.viewport);
        outer.opacity = 0.5;
        outer.children.push(overdeep.root);
        overdeep.root = outer;
        let mut invalid = accepted.clone();
        invalid.root.opacity = f32::NAN;
        let rejected = [
            (oversized, RenderError::CompositingBudgetExceeded),
            (overdeep, RenderError::CompositingBudgetExceeded),
            (invalid, RenderError::InvalidOpacity),
        ];
        let mut software = SoftwareRenderer::new();
        software.commit(accepted.clone()).unwrap();
        let pixels = software.snapshot().unwrap();
        let mut native = SkiaRenderer::new();
        native.commit(accepted.clone()).unwrap();
        let native_pixels = native.snapshot().unwrap();
        for (candidate, error) in rejected {
            assert_eq!(software.commit(candidate.clone()), Err(error.clone()));
            assert_eq!(software.last_frame(), Some(&accepted));
            assert_eq!(software.snapshot(), Some(pixels.clone()));
            assert_eq!(native.commit(candidate), Err(error));
            assert_eq!(native.last_frame(), Some(&accepted));
            assert_eq!(native.snapshot(), Some(native_pixels.clone()));
        }
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn oversized_host_target_is_rejected_before_canvas_mutation() {
        use crate::NativeFonts;
        let mut frame = frame(1.0, 1.0);
        frame.root.opacity = 0.5;
        // The declared physical target is over budget. A tiny sentinel canvas
        // makes it possible to prove no clear, scale, save or draw was issued.
        let mut surface = crate::skia::surfaces::raster_n32_premul((1, 1)).unwrap();
        surface.canvas().clear(crate::skia::Color::MAGENTA);
        let save_count = surface.canvas().save_count();
        let matrix = surface.canvas().local_to_device();
        assert_eq!(
            SkiaRenderer::draw_frame_to_target(
                surface.canvas(),
                &frame,
                4097,
                4097,
                &mut NativeFonts::new()
            ),
            Err(RenderError::CompositingBudgetExceeded)
        );
        assert_eq!(surface.canvas().save_count(), save_count);
        assert_eq!(surface.canvas().local_to_device(), matrix);
        assert_eq!(
            crate::native_raster::readback_native(&mut surface, 1, 1, 1)
                .unwrap()
                .pixels,
            [255, 0, 255, 255]
        );
    }

    #[test]
    fn image_and_border_paint_inside_the_same_opacity_group() {
        use crate::{BorderSide, BorderStyle, ImageMode, ImageResource, LayoutStyle, RenderImage};
        use std::sync::Arc;
        let mut frame = frame(4.0, 4.0);
        let mut group = painted("image-border", frame.viewport, color(255, 0, 0, 255));
        group.opacity = 0.5;
        group.style = Some(LayoutStyle {
            border: [BorderSide {
                width: 1.0,
                color: color(0, 255, 0, 255),
                style: BorderStyle::Solid,
            }; 4],
            ..LayoutStyle::default()
        });
        group.image = Some(RenderImage {
            resource: "blue".into(),
            mode: ImageMode::ScaleToFill,
        });
        frame.images.insert(
            "blue".into(),
            Arc::new(ImageResource {
                width: 1,
                height: 1,
                pixels: vec![0, 0, 255, 255],
            }),
        );
        frame.root.children = vec![group];
        let mut expected = Vec::new();
        for y in 0..4 {
            for x in 0..4 {
                expected.extend(if x == 0 || y == 0 || x == 3 || y == 3 {
                    [127, 255, 127, 255]
                } else {
                    [127, 127, 255, 255]
                });
            }
        }
        let mut software = SoftwareRenderer::new();
        software.commit(frame.clone()).unwrap();
        assert_eq!(software.snapshot().unwrap().pixels, expected);
        #[cfg(feature = "skia-backend")]
        {
            let mut native = SkiaRenderer::new();
            native.commit(frame).unwrap();
            assert_eq!(native.snapshot().unwrap().pixels, expected);
        }
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_text_ink_is_composited_after_its_opaque_background() {
        use crate::TextStyle;
        let mut frame = frame(64.0, 32.0);
        let mut group = painted("text-group", frame.viewport, color(255, 0, 0, 255));
        let mut text = RenderNode::new("text", rect(5.0, 4.0, 40.0, 24.0));
        text.text = Some("A".into());
        text.text_style = Some(TextStyle::default());
        text.foreground = Some(color(0, 0, 255, 255));
        group.children.push(text);
        frame.root.children = vec![group];
        let mut native = SkiaRenderer::new();
        native.commit(frame.clone()).unwrap();
        let opaque = native.snapshot().unwrap();
        assert!(
            opaque
                .pixels
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[2] > 0),
            "native text produced blue ink"
        );
        frame.root.children[0].opacity = 0.5;
        native.commit(frame).unwrap();
        let actual = native.snapshot().unwrap();
        for (pixel, opaque) in actual
            .pixels
            .as_chunks::<4>()
            .0
            .iter()
            .zip(opaque.pixels.as_chunks::<4>().0)
        {
            for channel in 0..3 {
                let expected = 127 + (u32::from(opaque[channel]) * 128 + 127) / 255;
                // Native antialias coverage and N32 layer blending may round
                // one level differently. All pixels, including glyph ink and
                // the fully opaque background, must satisfy the group result.
                assert!((i32::from(pixel[channel]) - expected as i32).abs() <= 1);
            }
            assert_eq!(pixel[3], 255);
        }
    }
}
