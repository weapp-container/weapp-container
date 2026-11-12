//! Actual raster and shared hit-plan contracts for resolved visibility.
use crate::*;

fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}
fn node(id: &str, bounds: Rect, color: Color) -> RenderNode {
    let mut node = RenderNode::new(id, bounds).with_style(LayoutStyle {
        flow: Some(FlowStyle::default()),
        ..LayoutStyle::default()
    });
    node.background = Some(color);
    node
}
fn scene() -> RenderFrame {
    let mut root = node("root", rect(0.0, 0.0, 64.0, 64.0), Color::WHITE);
    let mut hidden = node(
        "hidden",
        rect(8.0, 8.0, 40.0, 40.0),
        Color {
            red: 255,
            green: 0,
            blue: 0,
            alpha: 255,
        },
    );
    hidden.visibility = Visibility::Hidden;
    let mut inherited = node(
        "inherited",
        rect(16.0, 16.0, 24.0, 24.0),
        Color {
            red: 0,
            green: 0,
            blue: 255,
            alpha: 255,
        },
    );
    inherited.visibility = Visibility::Hidden;
    inherited.children.push(node(
        "visible",
        rect(24.0, 24.0, 8.0, 8.0),
        Color {
            red: 0,
            green: 255,
            blue: 0,
            alpha: 255,
        },
    ));
    hidden.children.push(inherited);
    root.children.push(hidden);
    RenderFrame {
        frame_id: 1,
        viewport: root.bounds,
        root,
        images: Default::default(),
    }
}
fn pixel(snapshot: &RenderSnapshot, x: u32, y: u32) -> [u8; 4] {
    let at = (y * snapshot.stride + x * 4) as usize;
    snapshot.pixels[at..at + 4].try_into().unwrap()
}
fn check(frame: &RenderFrame, samples: &[(u32, u32, [u8; 4])]) {
    let mut software = SoftwareRenderer::new();
    software.commit(frame.clone()).unwrap();
    let mut skia = SkiaRenderer::new();
    skia.commit(frame.clone()).unwrap();
    #[cfg(feature = "skia-backend")]
    assert_eq!(skia.backend_name(), "skia-raster");
    for (name, snapshot) in [
        ("software", software.snapshot().unwrap()),
        ("skia-or-explicit-fallback", skia.snapshot().unwrap()),
    ] {
        for &(x, y, expected) in samples {
            let actual = pixel(&snapshot, x, y);
            for (a, b) in actual.into_iter().zip(expected) {
                assert!(
                    a.abs_diff(b) <= 1,
                    "{name}: {x},{y}: {actual:?} != {expected:?}"
                );
            }
        }
    }
}
#[test]
fn visibility_hidden_preserves_geometry_and_allows_visible_descendant_pixels_and_bubbling_path() {
    let frame = scene();
    check(
        &frame,
        &[
            (10, 10, [255, 255, 255, 255]),
            (18, 18, [255, 255, 255, 255]),
            (26, 26, [0, 255, 0, 255]),
        ],
    );
    assert_eq!(frame.root.hit_test(10.5, 10.5).unwrap().id, "root");
    assert_eq!(frame.root.hit_test(18.5, 18.5).unwrap().id, "root");
    assert_eq!(
        frame
            .root
            .hit_test_path(26.5, 26.5)
            .iter()
            .map(|n| n.id.as_str())
            .collect::<Vec<_>>(),
        ["root", "hidden", "inherited", "visible"]
    );
    let geometries = frame.node_geometries();
    assert_eq!(geometries[1].bounds, rect(8.0, 8.0, 40.0, 40.0));
    assert!(geometries[1].displayed);
    assert_eq!(frame.query("#hidden", true).unwrap().len(), 1);
    let wire = serde_json::to_value(&frame).unwrap();
    let commands = wire["paintPlan"]["commands"].as_array().unwrap();
    assert!(commands.iter().all(
        |c| !matches!(c["op"].as_str(), Some("background" | "content"))
            || !matches!(c["path"].as_array().map(|p| p.len()), Some(1 | 2))
    ));
}
#[test]
fn visibility_hidden_context_keeps_opacity_and_clipping_for_visible_descendants() {
    let mut frame = scene();
    frame.root.children[0].opacity = 0.5;
    check(
        &frame,
        &[
            (10, 10, [255, 255, 255, 255]),
            (26, 26, [127, 255, 127, 255]),
        ],
    );
    frame.root.children[0]
        .computed_style
        .insert("overflow".into(), "hidden".into());
    frame.root.children[0].bounds.width = 18.0;
    check(
        &frame,
        &[
            (25, 26, [127, 255, 127, 255]),
            (27, 26, [255, 255, 255, 255]),
        ],
    );
    assert_eq!(frame.root.hit_test(27.5, 26.5).unwrap().id, "root");
}
#[test]
fn visibility_hidden_does_not_override_ancestor_display_none_or_zero_opacity() {
    let mut frame = scene();
    frame.root.children[0].style.as_mut().unwrap().display = DisplayMode::None;
    check(&frame, &[(26, 26, [255, 255, 255, 255])]);
    assert_eq!(frame.root.hit_test(26.5, 26.5).unwrap().id, "root");
    assert_eq!(frame.node_geometries()[3].bounds, rect(0.0, 0.0, 0.0, 0.0));
    frame.root.children[0].style.as_mut().unwrap().display = DisplayMode::Flex;
    frame.root.children[0].opacity = 0.0;
    check(&frame, &[(26, 26, [255, 255, 255, 255])]);
}
#[test]
fn visibility_frame_roundtrip_retains_hidden_and_legacy_missing_defaults_to_visible() {
    let frame = scene();
    let value = serde_json::to_value(&frame).unwrap();
    assert_eq!(value["root"]["children"][0]["visibility"], "hidden");
    assert!(value["root"].get("visibility").is_none());
    let roundtrip: RenderFrame = serde_json::from_value(value).unwrap();
    assert_eq!(roundtrip, frame);
    for visibility in [serde_json::json!("collapse"), serde_json::Value::Null] {
        let mut value = serde_json::to_value(&frame).unwrap();
        value["root"]["visibility"] = visibility;
        assert!(serde_json::from_value::<RenderFrame>(value).is_err());
    }
}

#[test]
fn visibility_native_presentations_use_local_resolved_value_with_shared_parent_context() {
    let mut frame = scene();
    frame.root.children[0].tag = Some("video".into());
    frame.root.children[0].opacity = 0.5;
    frame.root.children[0].children[0].children[0].tag = Some("camera".into());
    let presentations = frame.native_component_presentations();
    assert_eq!(presentations.len(), 2);
    assert!(!presentations[0].visible);
    assert_eq!(presentations[0].world_bounds, rect(8.0, 8.0, 40.0, 40.0));
    assert!(presentations[1].visible);
    assert_eq!(presentations[1].opacity, 0.5);
    assert_eq!(presentations[1].world_bounds, rect(24.0, 24.0, 8.0, 8.0));
    assert!(presentations[1].paint_order > presentations[0].paint_order);
    frame.root.children[0].style.as_mut().unwrap().display = DisplayMode::None;
    assert!(frame
        .native_component_presentations()
        .iter()
        .all(|p| !p.visible));
}

#[test]
fn visibility_hidden_image_content_stays_suppressed_and_visible_image_obeys_transform_clip_opacity_and_hits(
) {
    let mut frame = scene();
    let hidden = &mut frame.root.children[0];
    hidden.opacity = 0.5;
    hidden.bounds.width = 18.0;
    hidden
        .computed_style
        .insert("overflow".into(), "hidden".into());
    hidden.style.as_mut().unwrap().transform = Some(Transform2D {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 5.0,
        f: 3.0,
    });
    hidden.image = Some(RenderImage {
        resource: "cyan".into(),
        mode: ImageMode::ScaleToFill,
    });
    hidden.children[0].image = hidden.image.clone();
    let visible = &mut hidden.children[0].children[0];
    visible.background = None;
    visible.image = Some(RenderImage {
        resource: "cyan".into(),
        mode: ImageMode::ScaleToFill,
    });
    frame.images.insert(
        "cyan".into(),
        std::sync::Arc::new(ImageResource {
            width: 1,
            height: 1,
            pixels: vec![0, 255, 255, 255],
        }),
    );
    check(
        &frame,
        &[
            (14, 12, [255, 255, 255, 255]),
            (22, 22, [255, 255, 255, 255]),
            (29, 29, [127, 255, 255, 255]),
            (32, 29, [255, 255, 255, 255]),
        ],
    );
    let geometry = frame.node_geometries();
    assert_eq!(geometry[3].bounds, rect(29.0, 27.0, 8.0, 8.0));
    assert_eq!(
        frame
            .root
            .hit_test_path(29.5, 29.5)
            .iter()
            .map(|n| n.id.as_str())
            .collect::<Vec<_>>(),
        ["root", "hidden", "inherited", "visible"]
    );
    assert_eq!(frame.root.hit_test(22.5, 22.5).unwrap().id, "root");
    assert_eq!(frame.root.hit_test(32.5, 29.5).unwrap().id, "root");
    // The legacy phase builder must suppress the same image content.
    frame.root.style = None;
    check(
        &frame,
        &[
            (14, 12, [255, 255, 255, 255]),
            (22, 22, [255, 255, 255, 255]),
            (29, 29, [127, 255, 255, 255]),
            (32, 29, [255, 255, 255, 255]),
        ],
    );
    assert_eq!(frame.root.hit_test(22.5, 22.5).unwrap().id, "root");
    assert_eq!(frame.root.hit_test(29.5, 29.5).unwrap().id, "visible");
}
