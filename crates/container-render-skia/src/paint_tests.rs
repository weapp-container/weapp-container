//! Fontless CSS paint/hit cases with fixed, already committed geometry.
//!
//! Expected colors and targets follow CSS2 Appendix E, Flexbox 4.3, CSS
//! Display's order property, Transforms 2, and Color's opacity rules. They do
//! not derive their expectations from the paint plan or a sibling comparator.
//! SkiaRenderer exercises raster Skia with `skia-backend`; its documented
//! software fallback otherwise supplies no native/GPU evidence.

use crate::{
    Color, DisplayMode, FlowStyle, FormattingContext, ImageMode, ImageResource, LayoutStyle,
    PositionMode, Rect, RenderError, RenderFrame, RenderImage, RenderNode, RenderSnapshot,
    Renderer, ScrollOffset, SkiaRenderer, SoftwareRenderer, Transform2D, MAX_PAINT_DEPTH,
};
use sha2::{Digest, Sha256};
use std::{cell::Cell, fs::OpenOptions, io::Write, path::Path, sync::Arc};

const WHITE: [u8; 4] = [255, 255, 255, 255];
const RED: [u8; 4] = [255, 0, 0, 255];
const BLUE: [u8; 4] = [0, 0, 255, 255];
const GREEN: [u8; 4] = [0, 255, 0, 255];

fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

fn empty(id: &str, bounds: Rect) -> RenderNode {
    RenderNode::new(id, bounds).with_style(LayoutStyle {
        flow: Some(FlowStyle::default()),
        ..LayoutStyle::default()
    })
}

fn filled(id: &str, bounds: Rect, [red, green, blue, alpha]: [u8; 4]) -> RenderNode {
    let mut node = empty(id, bounds);
    node.background = Some(Color {
        red,
        green,
        blue,
        alpha,
    });
    node
}

fn root() -> RenderNode {
    filled("root", rect(0.0, 0.0, 96.0, 96.0), WHITE)
}

fn style(node: &mut RenderNode) -> &mut LayoutStyle {
    node.style.as_mut().expect("typed scene node")
}

fn z(node: &mut RenderNode, value: Option<i32>) {
    style(node).z_index = value;
    // Old producers retain this mirror. In a typed scene CSS applicability,
    // including the difference between auto and zero, comes from LayoutStyle.
    node.z_index = value.unwrap_or(0);
}

fn order(node: &mut RenderNode, value: i32) {
    style(node).flow.as_mut().unwrap().order = value;
}

fn flex(node: &mut RenderNode) {
    style(node).flow.as_mut().unwrap().context = FormattingContext::Flex;
}

struct Sample {
    x: u32,
    y: u32,
    rgba: [u8; 4],
    path: &'static [&'static str],
}

thread_local! {
    static EVIDENCE_SEQUENCE: Cell<u64> = const { Cell::new(0) };
}

fn write_new(path: &Path, bytes: &[u8]) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .unwrap_or_else(|error| panic!("create {}: {error}", path.display()));
    file.write_all(bytes)
        .unwrap_or_else(|error| panic!("write {}: {error}", path.display()));
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn export_evidence(
    frame: &RenderFrame,
    samples: &[Sample],
    software: &RenderSnapshot,
    native: &RenderSnapshot,
    skia: &SkiaRenderer,
) {
    let Some(root) = std::env::var_os("WEAPP_CONTAINER_STACKING_EVIDENCE_DIR") else {
        return;
    };
    let root = Path::new(&root);
    assert!(
        root.is_dir(),
        "evidence root must already exist: {}",
        root.display()
    );
    let thread = std::thread::current();
    let test = thread.name().unwrap_or("unnamed-test");
    let name: String = test
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let sequence = EVIDENCE_SEQUENCE.with(|value| {
        let next = value.get() + 1;
        value.set(next);
        next
    });
    let directory = root.join(format!("{name}-{sequence:03}"));
    std::fs::create_dir(&directory).unwrap_or_else(|error| {
        panic!(
            "create unique evidence case {}: {error}",
            directory.display()
        )
    });

    let frame_bytes = serde_json::to_vec_pretty(frame).unwrap();
    let expectations = serde_json::json!({
        "schemaVersion": 1,
        "oracleScope": "independently fixed sample colors and DOM hit paths",
        "fullFrameIndependentPixelOracle": false,
        "samples": samples.iter().map(|sample| serde_json::json!({
            "x": sample.x, "y": sample.y, "rgba": sample.rgba,
            "hitPath": sample.path,
        })).collect::<Vec<_>>(),
    });
    let expectation_bytes = serde_json::to_vec_pretty(&expectations).unwrap();
    write_new(&directory.join("frame.json"), &frame_bytes);
    write_new(&directory.join("expectations.json"), &expectation_bytes);
    write_new(&directory.join("software.rgba"), &software.pixels);
    write_new(&directory.join("native.rgba"), &native.pixels);
    let metadata = serde_json::json!({
        "schemaVersion": 1,
        "test": test,
        "sequence": sequence,
        "frame": {"file": "frame.json", "sha256": sha256(&frame_bytes)},
        "expectations": {"file": "expectations.json", "sha256": sha256(&expectation_bytes)},
        "software": {
            "file": "software.rgba", "sha256": sha256(&software.pixels),
            "width": software.width, "height": software.height,
            "stride": software.stride, "format": software.format,
        },
        "native": {
            "file": "native.rgba", "sha256": sha256(&native.pixels),
            "width": native.width, "height": native.height,
            "stride": native.stride, "format": native.format,
            "backend": skia.backend_name(),
            "hasNativeSurface": skia.has_native_surface(),
            "hasGpuSurface": skia.has_gpu_surface(),
        },
        "fullFrameNativeSoftwareComparisonEnabled": cfg!(feature = "skia-backend"),
        "fullFrameBytesEqual": software.pixels == native.pixels,
        "observedHitPaths": samples.iter().map(|sample| serde_json::json!({
            "x": sample.x, "y": sample.y,
            "path": frame.root.hit_test_path(sample.x as f32 + 0.5, sample.y as f32 + 0.5)
                .iter().map(|node| node.id.as_str()).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "evidenceScope": "software/Skia raster or declared fallback; no DevTools/GPU/host parity claim",
    });
    write_new(
        &directory.join("metadata.json"),
        &serde_json::to_vec_pretty(&metadata).unwrap(),
    );
}

fn sample(x: u32, y: u32, rgba: [u8; 4], path: &'static [&'static str]) -> Sample {
    Sample { x, y, rgba, path }
}

fn assert_scene(root: RenderNode, samples: &[Sample]) -> RenderFrame {
    let frame = RenderFrame {
        frame_id: 71,
        viewport: root.bounds,
        root,
        images: Default::default(),
    };
    assert_frame(&frame, samples);
    frame
}

fn assert_frame(frame: &RenderFrame, samples: &[Sample]) {
    let mut software = SoftwareRenderer::new();
    software.commit(frame.clone()).unwrap();
    let mut skia = SkiaRenderer::new();
    skia.commit(frame.clone()).unwrap();
    let software_image = software.snapshot().unwrap();
    let native_image = skia.snapshot().unwrap();
    // Export observations before assertions so a failed independent oracle or
    // backend comparison retains the original result instead of overwriting it.
    export_evidence(frame, samples, &software_image, &native_image, &skia);
    #[cfg(feature = "skia-backend")]
    assert_eq!(
        native_image.pixels, software_image.pixels,
        "fontless integer-geometry full-frame native/software pixels"
    );
    for sample in samples {
        let path: Vec<_> = frame
            .root
            .hit_test_path(sample.x as f32 + 0.5, sample.y as f32 + 0.5)
            .iter()
            .map(|node| node.id.as_str())
            .collect();
        assert_eq!(path, sample.path, "hit ({}, {})", sample.x, sample.y);
    }
    for (backend, image) in [
        ("software", software_image),
        ("Skia raster or declared fallback", native_image),
    ] {
        for sample in samples {
            let start = ((sample.y * image.width + sample.x) * 4) as usize;
            assert_eq!(
                &image.pixels[start..start + 4],
                &sample.rgba,
                "{backend} pixel ({}, {})",
                sample.x,
                sample.y
            );
        }
    }
}

fn nested_scene() -> RenderNode {
    let bounds = rect(16.0, 16.0, 64.0, 64.0);
    let mut parent = empty("parent", bounds);
    style(&mut parent).position = PositionMode::Relative;
    let mut high = filled("high", bounds, BLUE);
    style(&mut high).position = PositionMode::Absolute;
    z(&mut high, Some(999));
    parent.children.push(high);
    let mut sibling = filled("sibling", bounds, RED);
    style(&mut sibling).position = PositionMode::Absolute;
    z(&mut sibling, Some(1));
    let mut root = root();
    root.children = vec![parent, sibling];
    root
}

#[test]
fn typed_static_blocks_ignore_z_while_legacy_roots_keep_their_local_contract() {
    let bounds = rect(16.0, 16.0, 64.0, 64.0);
    let mut first = filled("first", bounds, RED);
    z(&mut first, Some(999));
    let last = filled("last", bounds, BLUE);
    let mut typed = root();
    typed.children = vec![first, last];
    assert_scene(typed.clone(), &[sample(32, 32, BLUE, &["root", "last"])]);
    style(&mut typed).flow = None;
    // Genuine legacy wire has only RenderNode.z_index. New typed metadata
    // without a CSS root is rejected at the shared admission boundary.
    for child in &mut typed.children {
        style(child).z_index = None;
    }
    assert_scene(typed, &[sample(32, 32, RED, &["root", "first"])]);
}

#[test]
fn an_identity_transform_paints_after_a_later_ordinary_block() {
    for transformed in [false, true] {
        let bounds = rect(16.0, 16.0, 64.0, 64.0);
        let mut first = filled("first", bounds, BLUE);
        style(&mut first).transform = transformed.then_some(Transform2D::IDENTITY);
        let mut root = root();
        root.children = vec![first, filled("last", bounds, RED)];
        assert_scene(
            root,
            &[if transformed {
                sample(32, 32, BLUE, &["root", "first"])
            } else {
                sample(32, 32, RED, &["root", "last"])
            }],
        );
    }
}

#[test]
fn transform_and_opacity_do_not_make_static_block_z_index_applicable() {
    for transform in [false, true] {
        let bounds = rect(16.0, 16.0, 64.0, 64.0);
        let mut first = filled("first", bounds, BLUE);
        if transform {
            style(&mut first).transform = Some(Transform2D::IDENTITY);
        } else {
            first.opacity = 0.5;
        }
        z(&mut first, Some(999));
        let mut last = filled("last", bounds, RED);
        style(&mut last).position = PositionMode::Relative;
        z(&mut last, Some(1));
        let mut root = root();
        root.children = vec![first, last];
        assert_scene(root, &[sample(32, 32, RED, &["root", "last"])]);
    }
}

#[test]
fn relative_auto_promotes_a_high_descendant_but_explicit_zero_traps_it() {
    for parent_z in [None, Some(0)] {
        let mut root = nested_scene();
        z(&mut root.children[0], parent_z);
        let frame = assert_scene(
            root,
            &[if parent_z.is_some() {
                sample(32, 32, RED, &["root", "sibling"])
            } else {
                sample(32, 32, BLUE, &["root", "parent", "high"])
            }],
        );
        // Promotion changes paint ownership, never the DOM/event tree.
        let geometry = frame.node_geometries();
        assert_eq!(
            geometry
                .iter()
                .map(|entry| (entry.node.id.as_str(), entry.parent))
                .collect::<Vec<_>>(),
            [
                ("root", None),
                ("parent", Some(0)),
                ("high", Some(1)),
                ("sibling", Some(0)),
            ]
        );
    }
}

#[test]
fn transform_opacity_and_isolation_each_trap_descendants_inside_their_context() {
    for boundary in ["identity", "opacity", "almost-opaque", "isolation"] {
        let mut root = nested_scene();
        let parent = &mut root.children[0];
        match boundary {
            "identity" => style(parent).transform = Some(Transform2D::IDENTITY),
            "opacity" => parent.opacity = 0.5,
            "almost-opaque" => parent.opacity = 0.999,
            "isolation" => style(parent).isolation = true,
            _ => unreachable!(),
        }
        assert_scene(root, &[sample(32, 32, RED, &["root", "sibling"])]);
    }
}

#[test]
fn negative_descendants_paint_after_context_background_but_before_noncontext_background() {
    for isolated in [false, true] {
        let bounds = rect(16.0, 16.0, 64.0, 64.0);
        let mut parent = filled("parent", bounds, RED);
        style(&mut parent).position = PositionMode::Relative;
        z(&mut parent, isolated.then_some(0));
        let mut low = filled("low", bounds, BLUE);
        style(&mut low).position = PositionMode::Absolute;
        z(&mut low, Some(-1));
        parent.children.push(low);
        let mut root = root();
        root.children.push(parent);
        assert_scene(
            root,
            &[if isolated {
                sample(32, 32, BLUE, &["root", "parent", "low"])
            } else {
                sample(32, 32, RED, &["root", "parent"])
            }],
        );
    }
    let mut root = root();
    let mut low = filled("low", rect(16.0, 16.0, 64.0, 64.0), BLUE);
    style(&mut low).position = PositionMode::Absolute;
    z(&mut low, Some(-999));
    root.children.push(low);
    assert_scene(root, &[sample(32, 32, BLUE, &["root", "low"])]);
}

#[test]
fn negative_contexts_use_numeric_levels_then_document_order() {
    for (first_z, last_z, color, path) in [
        (-1, -2, BLUE, &["root", "first"][..]),
        (-2, -1, RED, &["root", "last"][..]),
        (-1, -1, RED, &["root", "last"][..]),
    ] {
        let bounds = rect(16.0, 16.0, 64.0, 64.0);
        let mut first = filled("first", bounds, BLUE);
        style(&mut first).position = PositionMode::Absolute;
        z(&mut first, Some(first_z));
        let mut last = filled("last", bounds, RED);
        style(&mut last).position = PositionMode::Absolute;
        z(&mut last, Some(last_z));
        let mut root = root();
        root.children = vec![first, last];
        assert_scene(root, &[sample(32, 32, color, path)]);
    }
}

#[test]
fn a_static_flex_items_explicit_zero_paints_above_an_auto_item_despite_order() {
    for explicit_zero in [false, true] {
        let bounds = rect(16.0, 16.0, 64.0, 64.0);
        let mut first = filled("first", bounds, BLUE);
        order(&mut first, -10);
        z(&mut first, explicit_zero.then_some(0));
        let mut last = filled("last", bounds, RED);
        order(&mut last, 10);
        let mut root = root();
        flex(&mut root);
        root.children = vec![first, last];
        assert_scene(
            root,
            &[if explicit_zero {
                sample(32, 32, BLUE, &["root", "first"])
            } else {
                sample(32, 32, RED, &["root", "last"])
            }],
        );
    }
}

#[test]
fn flex_auto_items_allow_descendant_interleaving_while_zero_items_are_atomic() {
    for explicit_zero in [false, true] {
        let mut root = nested_scene();
        flex(&mut root);
        let parent = &mut root.children[0];
        style(parent).position = PositionMode::Static;
        z(parent, explicit_zero.then_some(0));
        // A static non-auto flex item forms the competing positive context.
        style(&mut root.children[1]).position = PositionMode::Static;
        assert_scene(
            root,
            &[if explicit_zero {
                sample(32, 32, RED, &["root", "sibling"])
            } else {
                sample(32, 32, BLUE, &["root", "parent", "high"])
            }],
        );
    }
}

#[test]
fn flex_order_breaks_equal_context_levels_but_never_overrides_z_index() {
    for (first_z, last_z, expected) in [(0, 0, BLUE), (0, 1, RED), (2, 1, BLUE)] {
        let bounds = rect(16.0, 16.0, 64.0, 64.0);
        let mut first = filled("first", bounds, BLUE);
        order(&mut first, 10);
        z(&mut first, Some(first_z));
        let mut last = filled("last", bounds, RED);
        order(&mut last, -10);
        z(&mut last, Some(last_z));
        let mut root = root();
        flex(&mut root);
        root.children = vec![first, last];
        let path = if expected == BLUE {
            &["root", "first"][..]
        } else {
            &["root", "last"][..]
        };
        assert_scene(root, &[sample(32, 32, expected, path)]);
    }
}

#[test]
fn positioned_paint_phase_precedes_order_comparison_with_ordinary_flex_items() {
    for out_of_flow in [PositionMode::Absolute, PositionMode::Fixed] {
        for flow_phase in ["ordinary", "relative", "transform"] {
            let bounds = rect(16.0, 16.0, 64.0, 64.0);
            let mut first = filled("first", bounds, BLUE);
            order(&mut first, 1);
            match flow_phase {
                "ordinary" => {}
                "relative" => style(&mut first).position = PositionMode::Relative,
                "transform" => style(&mut first).transform = Some(Transform2D::IDENTITY),
                _ => unreachable!(),
            }
            let mut last = filled("last", bounds, RED);
            style(&mut last).position = out_of_flow;
            // Out-of-flow children have effective order zero, despite this.
            order(&mut last, 999);
            let mut root = root();
            flex(&mut root);
            root.children = vec![first, last];
            assert_scene(
                root,
                &[if flow_phase == "ordinary" {
                    sample(32, 32, RED, &["root", "last"])
                } else {
                    sample(32, 32, BLUE, &["root", "first"])
                }],
            );
        }
    }
}

#[test]
fn fully_transparent_contexts_still_hit_descendants_with_real_event_ancestry() {
    let bounds = rect(16.0, 16.0, 64.0, 64.0);
    let mut under = filled("under", bounds, RED);
    style(&mut under).position = PositionMode::Relative;
    let mut group = empty("group", bounds);
    group.opacity = 0.0;
    group.hit_testable = false;
    let mut middle = empty("middle", bounds);
    middle.hit_testable = false;
    let mut high = filled("high", bounds, BLUE);
    style(&mut high).position = PositionMode::Relative;
    z(&mut high, Some(999));
    middle.children.push(high);
    group.children.push(middle);
    let mut root = root();
    root.children = vec![under, group];
    assert_scene(
        root,
        &[sample(32, 32, RED, &["root", "group", "middle", "high"])],
    );
}

#[test]
fn opacity_is_applied_to_the_completed_group_once_including_promoted_children() {
    let mut group = filled("group", rect(16.0, 16.0, 64.0, 64.0), RED);
    group.opacity = 0.5;
    let mut wrapper = empty("wrapper", group.bounds);
    style(&mut wrapper).position = PositionMode::Relative;
    let mut high = filled("high", rect(32.0, 16.0, 48.0, 64.0), BLUE);
    style(&mut high).position = PositionMode::Absolute;
    z(&mut high, Some(999));
    wrapper.children.push(high);
    group.children.push(wrapper);
    let mut root = root();
    root.children.push(group);
    assert_scene(
        root,
        &[
            // At the overlap the opaque blue child completely occludes red
            // before group alpha is applied: no red may leak into the result.
            sample(
                48,
                32,
                [127, 127, 255, 255],
                &["root", "group", "wrapper", "high"],
            ),
            sample(24, 32, [255, 127, 127, 255], &["root", "group", "wrapper"]),
        ],
    );
}

#[test]
fn nested_opacity_contexts_apply_each_group_alpha_exactly_once() {
    let bounds = rect(16.0, 16.0, 64.0, 64.0);
    let mut outer = empty("outer", bounds);
    outer.opacity = 0.5;
    let mut inner = empty("inner", bounds);
    inner.opacity = 0.5;
    let mut high = filled("high", bounds, BLUE);
    style(&mut high).position = PositionMode::Absolute;
    z(&mut high, Some(999));
    inner.children.push(high);
    outer.children.push(inner);
    let mut root = root();
    root.children.push(outer);
    assert_scene(
        root,
        &[sample(
            32,
            32,
            [191, 191, 255, 255],
            &["root", "outer", "inner", "high"],
        )],
    );
}

#[test]
fn f32_opacity_half_steps_keep_the_same_quantized_group_alpha_across_the_wire() {
    // These serialized decimals multiply to just below a half in JavaScript
    // f64 arithmetic, but the renderer's f32 product is exactly 3.5 or 6.5.
    // The group alpha therefore rounds to 4 or 7; opaque black over white
    // leaves 251 or 248 in every color channel. Keep those fixed expectations
    // independent of the compositing helper and exported paint commands.
    for (opacity, gray) in [(0.01372549_f32, 251), (0.025490196_f32, 248)] {
        let bounds = rect(16.0, 16.0, 64.0, 64.0);
        let mut group = empty("group", bounds);
        group.opacity = opacity;
        let mut middle = empty("middle", bounds);
        style(&mut middle).position = PositionMode::Relative;
        let mut ink = filled("ink", rect(24.0, 24.0, 48.0, 48.0), [0, 0, 0, 255]);
        style(&mut ink).position = PositionMode::Absolute;
        z(&mut ink, Some(999));
        middle.children.push(ink);
        group.children.push(middle);
        let mut root = root();
        root.children.push(group);
        assert_scene(
            root,
            &[
                sample(
                    32,
                    32,
                    [gray, gray, gray, 255],
                    &["root", "group", "middle", "ink"],
                ),
                sample(8, 8, WHITE, &["root"]),
            ],
        );
    }
}

#[test]
fn promoted_descendants_keep_their_positioned_ancestors_overflow_clip() {
    let mut clip = empty("clip", rect(16.0, 16.0, 24.0, 24.0));
    style(&mut clip).position = PositionMode::Relative;
    clip.computed_style
        .insert("overflow".into(), "hidden".into());
    let mut high = filled("high", rect(8.0, 8.0, 72.0, 72.0), BLUE);
    style(&mut high).position = PositionMode::Absolute;
    z(&mut high, Some(999));
    clip.children.push(high);
    let mut sibling = filled("sibling", rect(0.0, 0.0, 80.0, 80.0), RED);
    style(&mut sibling).position = PositionMode::Absolute;
    z(&mut sibling, Some(1));
    let mut root = root();
    root.children = vec![clip, sibling];
    assert_scene(
        root,
        &[
            sample(24, 24, BLUE, &["root", "clip", "high"]),
            sample(48, 48, RED, &["root", "sibling"]),
            sample(8, 8, RED, &["root", "sibling"]),
        ],
    );
}

#[test]
fn absolute_descendants_bypass_intermediate_clips_but_keep_the_containing_blocks_clip() {
    let mut outer = empty("outer", rect(8.0, 8.0, 64.0, 64.0));
    style(&mut outer).position = PositionMode::Relative;
    outer
        .computed_style
        .insert("overflow".into(), "hidden".into());
    let mut middle = empty("middle", rect(16.0, 16.0, 24.0, 24.0));
    middle
        .computed_style
        .insert("overflow".into(), "hidden".into());
    let mut high = filled("high", rect(0.0, 0.0, 80.0, 80.0), BLUE);
    style(&mut high).position = PositionMode::Absolute;
    z(&mut high, Some(999));
    middle.children.push(high);
    outer.children.push(middle);
    let mut sibling = filled("sibling", rect(0.0, 0.0, 96.0, 96.0), RED);
    style(&mut sibling).position = PositionMode::Absolute;
    z(&mut sibling, Some(1));
    let mut root = root();
    root.children = vec![outer, sibling];
    assert_scene(
        root,
        &[
            sample(24, 24, BLUE, &["root", "outer", "middle", "high"]),
            sample(48, 48, BLUE, &["root", "outer", "middle", "high"]),
            sample(4, 4, RED, &["root", "sibling"]),
            sample(76, 76, RED, &["root", "sibling"]),
        ],
    );
}

#[test]
fn promoted_descendants_keep_scroll_translation_and_clip_without_double_application() {
    for scroll_left in [20.0, 40.0] {
        let mut scroller = empty("scroller", rect(20.0, 20.0, 40.0, 40.0));
        style(&mut scroller).position = PositionMode::Relative;
        scroller.scroll_container = true;
        scroller.scroll_offset = Some(ScrollOffset {
            scroll_left,
            scroll_top: 10.0,
        });
        let mut high = filled("high", rect(40.0, 30.0, 40.0, 40.0), BLUE);
        style(&mut high).position = PositionMode::Absolute;
        z(&mut high, Some(999));
        scroller.children.push(high);
        let mut sibling = filled("sibling", rect(0.0, 0.0, 80.0, 80.0), RED);
        style(&mut sibling).position = PositionMode::Absolute;
        z(&mut sibling, Some(1));
        let mut root = root();
        root.children = vec![scroller, sibling];
        assert_scene(
            root,
            &[
                sample(24, 24, BLUE, &["root", "scroller", "high"]),
                if scroll_left == 20.0 {
                    sample(48, 24, BLUE, &["root", "scroller", "high"])
                } else {
                    sample(48, 24, RED, &["root", "sibling"])
                },
                sample(64, 24, RED, &["root", "sibling"]),
                sample(24, 8, RED, &["root", "sibling"]),
            ],
        );
    }
}

#[test]
fn viewport_fixed_escapes_clip_and_scroll_but_keeps_opacity_and_stacking_ancestry() {
    for opacity in [1.0, 0.5] {
        let mut clipped = empty("clipped", rect(40.0, 40.0, 10.0, 10.0));
        style(&mut clipped).position = PositionMode::Relative;
        clipped.opacity = opacity;
        clipped.scroll_container = true;
        clipped.scroll_offset = Some(ScrollOffset {
            scroll_left: 0.0,
            scroll_top: 30.0,
        });
        clipped
            .computed_style
            .insert("overflow".into(), "hidden".into());
        let mut fixed = filled("fixed", rect(5.0, 5.0, 20.0, 20.0), RED);
        style(&mut fixed).position = PositionMode::Fixed;
        z(&mut fixed, Some(999));
        clipped.children.push(fixed);
        let mut sibling = filled("sibling", rect(8.0, 8.0, 4.0, 4.0), BLUE);
        style(&mut sibling).position = PositionMode::Absolute;
        z(&mut sibling, Some(1));
        let mut root = root();
        root.children = vec![clipped, sibling];
        assert_scene(
            root,
            &[
                sample(
                    6,
                    6,
                    if opacity == 1.0 {
                        RED
                    } else {
                        [255, 127, 127, 255]
                    },
                    &["root", "clipped", "fixed"],
                ),
                if opacity == 1.0 {
                    sample(9, 9, RED, &["root", "clipped", "fixed"])
                } else {
                    sample(9, 9, BLUE, &["root", "sibling"])
                },
                sample(30, 30, WHITE, &["root"]),
            ],
        );
    }
}

#[test]
fn hidden_ancestors_do_not_publish_promoted_contexts_or_input_targets() {
    let mut root = nested_scene();
    style(&mut root.children[0]).display = DisplayMode::None;
    let frame = assert_scene(root, &[sample(32, 32, RED, &["root", "sibling"])]);
    let geometry = frame.node_geometries();
    assert!(!geometry[1].displayed);
    assert!(!geometry[2].displayed);
    assert!(geometry[3].displayed);
}

#[test]
fn the_wire_keeps_auto_zero_and_isolation_distinct() {
    let auto: LayoutStyle = serde_json::from_str("{}").unwrap();
    let zero: LayoutStyle = serde_json::from_str(r#"{"z_index":0}"#).unwrap();
    let isolated: LayoutStyle = serde_json::from_str(r#"{"isolation":true}"#).unwrap();
    assert_eq!(auto.z_index, None);
    assert!(!auto.isolation);
    assert_eq!(zero.z_index, Some(0));
    assert!(isolated.isolation);
    assert!(serde_json::to_value(auto).unwrap().get("z_index").is_none());
    assert_eq!(serde_json::to_value(zero).unwrap()["z_index"], 0);
    assert_eq!(serde_json::to_value(isolated).unwrap()["isolation"], true);
}

#[test]
fn context_boundaries_preserve_plain_sibling_backgrounds_outside_the_overlap() {
    let mut root = nested_scene();
    style(&mut root.children[0]).isolation = true;
    root.children[0].background = Some(Color {
        red: 0,
        green: 255,
        blue: 0,
        alpha: 255,
    });
    root.children[0].bounds = rect(8.0, 8.0, 72.0, 72.0);
    assert_scene(
        root,
        &[
            sample(12, 12, GREEN, &["root", "parent"]),
            sample(32, 32, RED, &["root", "sibling"]),
            sample(88, 88, WHITE, &["root"]),
        ],
    );
}

#[test]
fn replaced_content_paints_and_hits_above_later_block_backgrounds_even_when_transparent() {
    for (image_alpha, empty_text) in [
        (None, false),
        (None, true),
        (Some(255), false),
        (Some(0), false),
    ] {
        let bounds = rect(16.0, 16.0, 64.0, 64.0);
        let mut first = empty("first", bounds);
        first.text = empty_text.then(String::new);
        let mut images = std::collections::BTreeMap::new();
        if let Some(alpha) = image_alpha {
            first.image = Some(RenderImage {
                resource: "blue-pixel".into(),
                mode: ImageMode::ScaleToFill,
            });
            images.insert(
                "blue-pixel".into(),
                Arc::new(ImageResource {
                    width: 1,
                    height: 1,
                    pixels: vec![0, 0, 255, alpha],
                }),
            );
        }
        let mut root = root();
        root.children = vec![first, filled("last", bounds, RED)];
        let frame = RenderFrame {
            frame_id: 72,
            viewport: root.bounds,
            root,
            images,
        };
        assert_frame(
            &frame,
            &[match image_alpha {
                None => sample(32, 32, RED, &["root", "last"]),
                Some(0) => sample(32, 32, RED, &["root", "first"]),
                Some(_) => sample(32, 32, BLUE, &["root", "first"]),
            }],
        );
    }
}

#[test]
fn overdeep_paint_trees_reject_serialization_and_leave_accepted_renderers_unchanged() {
    let accepted = RenderFrame {
        frame_id: 73,
        viewport: rect(0.0, 0.0, 96.0, 96.0),
        root: root(),
        images: Default::default(),
    };
    let bounds = rect(0.0, 0.0, 1.0, 1.0);
    let mut chain = empty("deepest", bounds);
    // Exactly depth 257 from the root. This rejects before recursive paint
    // planning/serialization while keeping construction and drop bounded.
    for _ in 1..=MAX_PAINT_DEPTH {
        let mut parent = empty("parent", bounds);
        parent.children.push(chain);
        chain = parent;
    }
    let mut candidate = accepted.clone();
    candidate.frame_id = 74;
    candidate.root.children.push(chain);
    let serialized = serde_json::to_string(&candidate).unwrap_err();
    assert_eq!(
        serialized.to_string(),
        RenderError::PaintBudgetExceeded.to_string()
    );
    assert!(serde_json::to_value(&candidate).is_err());

    let mut software = SoftwareRenderer::new();
    software.commit(accepted.clone()).unwrap();
    let previous = software.snapshot().unwrap();
    assert_eq!(
        software.commit(candidate.clone()),
        Err(RenderError::PaintBudgetExceeded)
    );
    assert_eq!(software.last_frame(), Some(&accepted));
    assert_eq!(software.snapshot().unwrap(), previous);

    let mut skia = SkiaRenderer::new();
    skia.commit(accepted.clone()).unwrap();
    let previous = skia.snapshot().unwrap();
    assert_eq!(
        skia.commit(candidate),
        Err(RenderError::PaintBudgetExceeded)
    );
    assert_eq!(skia.last_frame(), Some(&accepted));
    assert_eq!(skia.snapshot().unwrap(), previous);
}

#[test]
fn legacy_anonymous_text_does_not_retarget_over_hit_testable_siblings() {
    let bounds = rect(16.0, 16.0, 64.0, 64.0);
    let button = filled("button", bounds, RED);
    let mut anonymous = empty("text:anonymous", bounds).with_text("ink");
    anonymous.hit_testable = false;
    let mut owner = empty("owner", bounds);
    owner.children = vec![button, anonymous];
    let mut root = root();
    root.children.push(owner);

    // Genuine legacy input skips the later anonymous leaf rather than using
    // it to steal the earlier button's target. No font or renderer is needed.
    style(&mut root).flow = None;
    assert_eq!(
        root.hit_test_path(32.0, 32.0)
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        ["root", "owner", "button"]
    );

    // CSS paints anonymous foreground after ordinary block backgrounds. Its
    // event identity is the original public owner, with unchanged DOM ancestry.
    style(&mut root).flow = Some(FlowStyle::default());
    assert_eq!(
        root.hit_test_path(32.0, 32.0)
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        ["root", "owner"]
    );

    // Visible text overflow cannot expand that owner's input box. The public
    // button remains hittable outside the owner and keeps it in the event path.
    root.children[0].bounds.height = 10.0;
    assert_eq!(
        root.hit_test_path(32.0, 32.0)
            .iter()
            .map(|node| node.id.as_str())
            .collect::<Vec<_>>(),
        ["root", "owner", "button"]
    );
}

#[test]
fn legacy_roots_reject_new_stacking_metadata_without_replacing_accepted_state() {
    let mut root = root();
    style(&mut root).flow = None;
    let mut child = filled("child", rect(16.0, 16.0, 64.0, 64.0), BLUE);
    child.z_index = 5;
    root.children.push(child);
    let accepted = RenderFrame {
        frame_id: 75,
        viewport: root.bounds,
        root,
        images: Default::default(),
    };
    assert!(serde_json::to_value(&accepted)
        .unwrap()
        .get("paintPlan")
        .is_none());
    let error = RenderError::Unsupported("typed-stacking-without-css-root");
    let mut software = SoftwareRenderer::new();
    software.commit(accepted.clone()).unwrap();
    let software_before = software.snapshot().unwrap();
    let mut skia = SkiaRenderer::new();
    skia.commit(accepted.clone()).unwrap();
    let native_before = skia.snapshot().unwrap();
    for isolation in [false, true] {
        let mut candidate = accepted.clone();
        candidate.frame_id = 76;
        let child = &mut candidate.root.children[0];
        if isolation {
            style(child).isolation = true;
        } else {
            style(child).z_index = Some(0);
        }
        assert_eq!(
            serde_json::to_string(&candidate).unwrap_err().to_string(),
            error.to_string()
        );
        assert_eq!(software.commit(candidate.clone()), Err(error.clone()));
        assert_eq!(software.last_frame(), Some(&accepted));
        assert_eq!(software.snapshot().unwrap(), software_before);
        assert_eq!(skia.commit(candidate), Err(error.clone()));
        assert_eq!(skia.last_frame(), Some(&accepted));
        assert_eq!(skia.snapshot().unwrap(), native_before);
    }
}

#[test]
fn hidden_typed_root_exports_a_balanced_empty_context_and_no_hits() {
    let mut root = root();
    style(&mut root).display = DisplayMode::None;
    root.children
        .push(filled("hidden-child", rect(0.0, 0.0, 20.0, 20.0), RED));
    let frame = assert_scene(root, &[sample(4, 4, [0; 4], &[])]);
    let wire = serde_json::to_value(&frame).unwrap();
    assert_eq!(
        wire["paintPlan"]["commands"],
        serde_json::json!([
            {"op":"begin","path":[]},{"op":"end","path":[]}
        ])
    );
}

#[test]
fn an_absolute_child_skips_intermediate_scroll_even_without_its_own_flow_metadata() {
    for relative in [false, true] {
        let mut root = root();
        style(&mut root).position = PositionMode::Relative;
        let mut scroller = empty("scroller", rect(0.0, 0.0, 96.0, 96.0));
        scroller.scroll_container = true;
        scroller.scroll_offset = Some(ScrollOffset {
            scroll_left: 20.0,
            scroll_top: 0.0,
        });
        if relative {
            style(&mut scroller).position = PositionMode::Relative;
        }
        let mut child = filled("absolute", rect(40.0, 0.0, 10.0, 10.0), BLUE);
        style(&mut child).flow = None;
        style(&mut child).position = PositionMode::Absolute;
        scroller.children.push(child);
        root.children.push(scroller);
        let frame = assert_scene(
            root,
            &[
                sample(
                    24,
                    4,
                    if relative { BLUE } else { WHITE },
                    if relative {
                        &["root", "scroller", "absolute"]
                    } else {
                        &["root", "scroller"]
                    },
                ),
                sample(
                    44,
                    4,
                    if relative { WHITE } else { BLUE },
                    if relative {
                        &["root", "scroller"]
                    } else {
                        &["root", "scroller", "absolute"]
                    },
                ),
            ],
        );
        assert_eq!(
            frame.node_geometries()[2].bounds.x,
            if relative { 20.0 } else { 40.0 }
        );
    }
}
