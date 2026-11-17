use super::*;
use canvas_batch::PreparedCanvasBatch;
use serde_json::{json, Value};

fn frame(commands: &[(&str, Value)]) -> CanvasFrame {
    CanvasFrame {
        frame_id: 1,
        canvas_id: "affine".into(),
        width: 32,
        height: 24,
        reserve: false,
        commands: commands
            .iter()
            .map(|(op, args)| CanvasCommand {
                op: (*op).into(),
                args: args.as_array().unwrap().clone(),
            })
            .collect(),
    }
}

fn pixel(image: &RenderSnapshot, x: usize, y: usize) -> [u8; 4] {
    let offset = y * image.stride as usize + x * 4;
    image.pixels[offset..offset + 4].try_into().unwrap()
}

fn each_backend(frame: &CanvasFrame, mut check: impl FnMut(&str, &RenderSnapshot)) {
    check("portable", &rasterize_canvas(frame).unwrap());
    #[cfg(feature = "skia-backend")]
    check(
        "native",
        &CanvasService::default().commit(frame.clone()).unwrap(),
    );
}

#[test]
fn affine_multiplication_is_ordered_and_parameters_follow_canvas_convention() {
    for (commands, inside, outside) in [
        (
            vec![
                ("translate", json!([6, 0])),
                ("transform", json!([2, 0, 0, 1, 0, 0])),
            ],
            7,
            13,
        ),
        (
            vec![
                ("transform", json!([2, 0, 0, 1, 0, 0])),
                ("translate", json!([6, 0])),
            ],
            13,
            7,
        ),
    ] {
        let mut commands = commands;
        commands.push(("fillRect", json!([0, 0, 2, 4])));
        each_backend(&frame(&commands), |backend, image| {
            assert_eq!(pixel(image, inside, 2), [0, 0, 0, 255], "{backend}");
            assert_eq!(pixel(image, outside, 2), [0; 4], "{backend}");
        });
    }
    each_backend(
        &frame(&[
            ("setTransform", json!([2, 1, 0.5, 2, 3, 4])),
            ("fillRect", json!([0, 0, 6, 1])),
        ]),
        |backend, image| assert!(pixel(image, 9, 8)[3] > 200, "{backend}: b/c ordering"),
    );
}

#[test]
fn set_transform_replaces_and_save_restore_recovers_the_previous_matrix() {
    each_backend(
        &frame(&[
            ("setTransform", json!([1, 0, 0, 1, 4, 4])),
            ("save", json!([])),
            ("transform", json!([1, 0, 1, 1, 0, 0])),
            ("setFillStyle", json!(["red"])),
            ("fillRect", json!([0, 0, 4, 4])),
            ("restore", json!([])),
            ("setFillStyle", json!(["blue"])),
            ("fillRect", json!([0, 6, 3, 3])),
            ("setTransform", json!([1, 0, 0, 1, 0, 0])),
            ("setFillStyle", json!(["#00ff00"])),
            ("fillRect", json!([20, 2, 3, 3])),
        ]),
        |backend, image| {
            assert_eq!(pixel(image, 8, 6), [255, 0, 0, 255], "{backend}");
            assert_eq!(pixel(image, 5, 11), [0, 0, 255, 255], "{backend}");
            assert_eq!(pixel(image, 9, 11), [0; 4], "{backend}");
            assert_eq!(pixel(image, 21, 3), [0, 255, 0, 255], "{backend}");
        },
    );
}

#[test]
fn clip_uses_construction_time_path_even_under_a_singular_current_matrix() {
    each_backend(
        &frame(&[
            ("setTransform", json!([1, 0, 0, 1, 6, 4])),
            ("beginPath", json!([])),
            ("rect", json!([0, 0, 10, 8])),
            ("setTransform", json!([0, 0, 0, 0, 0, 0])),
            ("clip", json!([])),
            ("setTransform", json!([1, 0, 0, 1, 0, 0])),
            ("fillRect", json!([0, 0, 32, 24])),
        ]),
        |backend, image| {
            assert_eq!(pixel(image, 8, 6), [0, 0, 0, 255], "{backend}");
            assert_eq!(pixel(image, 2, 6), [0; 4], "{backend}");
            assert_eq!(pixel(image, 18, 6), [0; 4], "{backend}");
        },
    );
}

#[test]
fn clip_nonzero_winding_handles_repeated_contours_holes_reflection_and_open_paths() {
    for commands in [
        vec![
            ("rect", json!([2, 2, 24, 20])),
            ("rect", json!([2, 2, 24, 20])),
        ],
        vec![
            ("rect", json!([2, 2, 24, 20])),
            ("rect", json!([8, 6, 12, 12])),
        ],
    ] {
        let mut commands = commands;
        commands.extend([("clip", json!([])), ("fillRect", json!([0, 0, 32, 24]))]);
        each_backend(&frame(&commands), |backend, image| {
            assert_eq!(
                pixel(image, 12, 10),
                [0, 0, 0, 255],
                "{backend}: nonzero winding"
            );
        });
    }
    each_backend(
        &frame(&[
            ("setTransform", json!([-1, 0, 0, 1, 30, 0])),
            ("rect", json!([2, 2, 24, 20])),
            ("moveTo", json!([8, 6])),
            ("lineTo", json!([8, 18])),
            ("lineTo", json!([20, 18])),
            ("lineTo", json!([20, 6])),
            ("closePath", json!([])),
            ("clip", json!([])),
            ("setTransform", json!([1, 0, 0, 1, 0, 0])),
            ("fillRect", json!([0, 0, 32, 24])),
        ]),
        |backend, image| {
            assert_eq!(
                pixel(image, 6, 4),
                [0, 0, 0, 255],
                "{backend}: reflected ring"
            );
            assert_eq!(
                pixel(image, 16, 10),
                [0; 4],
                "{backend}: opposite winding hole"
            );
        },
    );
    each_backend(
        &frame(&[
            ("moveTo", json!([2, 2])),
            ("lineTo", json!([22, 2])),
            ("lineTo", json!([2, 20])),
            ("clip", json!([])),
            ("fillRect", json!([0, 0, 32, 24])),
        ]),
        |backend, image| {
            assert_eq!(
                pixel(image, 4, 4),
                [0, 0, 0, 255],
                "{backend}: implicit closure"
            );
            assert_eq!(pixel(image, 20, 18), [0; 4], "{backend}");
        },
    );
}

#[test]
fn nested_clips_restore_coverage_but_keep_the_current_path() {
    each_backend(
        &frame(&[
            ("save", json!([])),
            ("rect", json!([2, 2, 20, 16])),
            ("clip", json!([])),
            ("save", json!([])),
            ("beginPath", json!([])),
            ("rect", json!([8, 2, 6, 16])),
            ("clip", json!([])),
            ("setFillStyle", json!(["red"])),
            ("fillRect", json!([0, 0, 32, 24])),
            ("restore", json!([])),
            ("setFillStyle", json!(["blue"])),
            ("fillRect", json!([2, 2, 4, 16])),
            ("setFillStyle", json!(["#00ff00"])),
            ("fill", json!([])),
            ("restore", json!([])),
            ("setFillStyle", json!(["#ffff00"])),
            ("fillRect", json!([26, 4, 4, 4])),
        ]),
        |backend, image| {
            assert_eq!(
                pixel(image, 4, 8),
                [0, 0, 255, 255],
                "{backend}: restored outer clip"
            );
            assert_eq!(
                pixel(image, 10, 8),
                [0, 255, 0, 255],
                "{backend}: clip retains path"
            );
            assert_eq!(
                pixel(image, 18, 8),
                [0; 4],
                "{backend}: path is not saved state"
            );
            assert_eq!(
                pixel(image, 27, 5),
                [255, 255, 0, 255],
                "{backend}: initial clip restored"
            );
        },
    );
}

#[test]
fn clip_gates_rectangle_path_stroke_and_text_pixel_sinks() {
    for drawing in [
        vec![("fillRect", json!([0, 0, 32, 24]))],
        vec![
            ("beginPath", json!([])),
            ("rect", json!([0, 0, 32, 24])),
            ("fill", json!([])),
        ],
        vec![
            ("beginPath", json!([])),
            ("setLineWidth", json!([4])),
            ("moveTo", json!([0, 10])),
            ("lineTo", json!([30, 10])),
            ("stroke", json!([])),
        ],
        vec![
            ("setLineWidth", json!([4])),
            ("strokeRect", json!([0, 6, 20, 8])),
        ],
        vec![
            ("setFontSize", json!([16])),
            ("setTextBaseline", json!(["top"])),
            ("fillText", json!(["MMMM", 0, 0])),
        ],
        vec![
            ("setFontSize", json!([16])),
            ("setTextBaseline", json!(["top"])),
            ("strokeText", json!(["MMMM", 0, 0])),
        ],
    ] {
        let mut commands = vec![("rect", json!([4, 4, 10, 14])), ("clip", json!([]))];
        commands.extend(drawing);
        each_backend(&frame(&commands), |backend, image| {
            let mut ink = 0;
            for y in 0..24 {
                for x in 0..32 {
                    let alpha = pixel(image, x, y)[3];
                    if (4..14).contains(&x) && (4..18).contains(&y) {
                        ink += usize::from(alpha > 0);
                    } else {
                        assert_eq!(alpha, 0, "{backend}: outside clip at ({x},{y})");
                    }
                }
            }
            assert!(ink > 0, "{backend}: drawing must exercise the mask");
        });
    }
    each_backend(
        &frame(&[
            ("setFillStyle", json!(["red"])),
            ("fillRect", json!([0, 0, 32, 24])),
            ("rect", json!([4, 4, 10, 14])),
            ("clip", json!([])),
            ("beginPath", json!([])),
            ("setGlobalAlpha", json!([0])),
            ("clearRect", json!([0, 0, 32, 24])),
        ]),
        |backend, image| {
            assert_eq!(pixel(image, 8, 8), [0; 4], "{backend}: clear ignores alpha");
            assert_eq!(
                pixel(image, 2, 8),
                [255, 0, 0, 255],
                "{backend}: beginPath preserves clip"
            );
        },
    );
}

#[test]
fn reserve_boundary_clears_clip_path_matrix_and_stack_while_replaying_pixels() {
    let mut service = CanvasService::default();
    service
        .commit(frame(&[
            ("setFillStyle", json!(["blue"])),
            ("fillRect", json!([0, 0, 2, 2])),
            ("rect", json!([4, 0, 4, 8])),
            ("clip", json!([])),
            ("setTransform", json!([1, 0, 0, 1, 20, 0])),
            ("save", json!([])),
        ]))
        .unwrap();
    let mut next = frame(&[
        ("restore", json!([])),
        ("fillRect", json!([12, 2, 4, 4])),
        ("fill", json!([])),
    ]);
    next.reserve = true;
    let image = service.commit(next).unwrap();
    assert_eq!(pixel(&image, 0, 0), [0, 0, 255, 255]);
    assert_eq!(pixel(&image, 13, 3), [0, 0, 0, 255]);
    assert_eq!(pixel(&image, 5, 3), [0; 4]);
    assert_eq!(pixel(&image, 25, 3), [0; 4]);
}

#[test]
fn late_invalid_affine_commands_never_enter_backend_or_publish_partial_history() {
    let mut service = CanvasService::default();
    let accepted = frame(&[("fillRect", json!([0, 0, 2, 2]))]);
    let image = service.commit(accepted.clone()).unwrap();
    for invalid in [
        json!([1, 0, 0, 1, 0]),
        json!([1, 0, 0, 1, 0, "1"]),
        json!([1e100, 0, 0, 1, 0, 0]),
    ] {
        let mut rejected = frame(&[("fillRect", json!([8, 8, 4, 4])), ("setTransform", invalid)]);
        rejected.reserve = true;
        assert!(service
            .commit_with_backend(rejected, |_, _| panic!("invalid affine entered backend"))
            .is_err());
        assert_eq!(service.snapshot("affine"), Some(image.clone()));
        assert_eq!(service.commands["affine"], accepted.commands);
    }
    let overflow = frame(&[
        ("setTransform", json!([1e30, 0, 0, 1e30, 0, 0])),
        ("transform", json!([1e30, 0, 0, 1e30, 0, 0])),
        ("setTransform", json!([1, 0, 0, 1, 0, 0])),
    ]);
    assert_eq!(
        service.commit_with_backend(overflow, |_, _| panic!("overflow entered backend")),
        Err(RenderError::InvalidCanvas(
            "canvas transform exceeds finite scalar limits".into()
        ))
    );
    assert_eq!(service.snapshot("affine"), Some(image));
    assert_eq!(service.commands["affine"], accepted.commands);
}

#[test]
fn clip_budgets_charge_peak_masks_and_empty_path_intersection_work_before_backend() {
    // Admission-only large frames use a small real snapshot as a backend token;
    // no pixels or masks for these 2048-square targets are fabricated or claimed.
    let token = rasterize_canvas(&frame(&[])).unwrap();
    let large = |commands: Vec<CanvasCommand>| {
        let mut target = frame(&[]);
        target.width = 2048;
        target.height = 2048;
        target.commands = commands;
        target
    };
    let command = |op: &str| CanvasCommand {
        op: op.into(),
        args: vec![],
    };
    let mut service = CanvasService::default();
    for count in [31, 32] {
        let target = large(
            (0..count)
                .flat_map(|_| [command("clip"), command("save")])
                .collect(),
        );
        if count == 31 {
            service
                .commit_with_backend(target, |_, _| Ok(token.clone()))
                .unwrap();
        } else {
            assert_eq!(
                service.commit_with_backend(target, |_, _| panic!("mask budget entered backend")),
                Err(RenderError::InvalidCanvas(
                    "canvas clip memory budget exceeded".into()
                ))
            );
        }
    }
    for count in [63, 64] {
        let target = large(vec![command("clip"); count]);
        if count == 63 {
            service
                .commit_with_backend(target, |_, _| Ok(token.clone()))
                .unwrap();
        } else {
            assert_eq!(
                service.commit_with_backend(target, |_, _| panic!("clip work entered backend")),
                Err(RenderError::InvalidCanvas(
                    "canvas geometry work budget exceeded".into()
                ))
            );
        }
    }
    let mut shared = vec![command("clip")];
    shared.extend(vec![command("save"); PreparedCanvasBatch::MAX_SAVE_DEPTH]);
    shared.push(command("clip"));
    service
        .commit_with_backend(large(shared), |_, _| Ok(token.clone()))
        .unwrap();
    let released = (0..40)
        .flat_map(|_| [command("save"), command("clip"), command("restore")])
        .collect();
    service
        .commit_with_backend(large(released), |_, _| Ok(token))
        .unwrap();
}

#[test]
fn curved_clips_keep_their_shape_and_construction_time_translation() {
    for (name, path, outside) in [
        (
            "arc",
            vec![("arc", json!([16, 12, 8, 0, std::f64::consts::TAU]))],
            (11, 6),
        ),
        (
            "quadratic",
            vec![
                ("moveTo", json!([4, 18])),
                ("quadraticCurveTo", json!([16, -10, 28, 18])),
                ("lineTo", json!([4, 18])),
            ],
            (11, 6),
        ),
        (
            "cubic",
            vec![
                ("moveTo", json!([4, 18])),
                ("bezierCurveTo", json!([4, -2, 28, -2, 28, 18])),
                ("lineTo", json!([4, 18])),
            ],
            (8, 6),
        ),
    ] {
        let mut commands = vec![
            ("setTransform", json!([1, 0, 0, 1, 2, 1])),
            ("beginPath", json!([])),
        ];
        commands.extend(path);
        commands.extend([
            ("setTransform", json!([1, 0, 0, 1, 0, 0])),
            ("clip", json!([])),
            ("fillRect", json!([0, 0, 32, 24])),
        ]);
        each_backend(&frame(&commands), |backend, image| {
            // These points are separated from every curve boundary. A bounds
            // mask or straight control polygon cannot satisfy both samples.
            assert_eq!(pixel(image, 18, 13), [0, 0, 0, 255], "{backend}: {name}");
            assert_eq!(
                pixel(image, outside.0, outside.1),
                [0; 4],
                "{backend}: {name}"
            );
            assert_eq!(pixel(image, 1, 1), [0; 4], "{backend}: {name}");
        });
    }
}

#[test]
fn generic_affine_stroke_maps_both_path_and_pen_with_distinct_b_and_c() {
    each_backend(
        &frame(&[
            ("setTransform", json!([1, 0, 0, 1, 2, 1])),
            ("transform", json!([2, 1, 0.5, 2, 0, 0])),
            ("setLineWidth", json!([4])),
            ("setLineCap", json!(["butt"])),
            ("beginPath", json!([])),
            ("moveTo", json!([2, 4])),
            ("lineTo", json!([10, 4])),
            ("stroke", json!([])),
        ]),
        |backend, image| {
            // The user-space butt stroke [2,10] x [2,6] maps to the
            // parallelogram (7,7),(23,15),(25,23),(9,15). These interior,
            // side and cap probes distinguish a transformed pen from a
            // device-width stroke, and distinguish b=1 from c=0.5.
            assert_eq!(pixel(image, 20, 17), [0, 0, 0, 255], "{backend}");
            assert_eq!(pixel(image, 12, 13), [0, 0, 0, 255], "{backend}");
            assert!(
                pixel(image, 16, 12)[3] > 200,
                "{backend}: transformed pen width"
            );
            assert_eq!(pixel(image, 16, 10), [0; 4], "{backend}: pen side");
            assert_eq!(pixel(image, 6, 10), [0; 4], "{backend}: butt cap");
        },
    );
}

#[test]
fn empty_clip_blocks_paint_and_clear_cannot_expand_and_restore_releases_it() {
    each_backend(
        &frame(&[
            ("setFillStyle", json!(["red"])),
            ("fillRect", json!([0, 0, 32, 24])),
            ("save", json!([])),
            ("beginPath", json!([])),
            ("clip", json!([])),
            ("setFillStyle", json!(["blue"])),
            ("fillRect", json!([0, 0, 32, 24])),
            ("clearRect", json!([0, 0, 32, 24])),
            ("beginPath", json!([])),
            ("rect", json!([0, 0, 32, 24])),
            ("clip", json!([])),
            ("fillRect", json!([0, 0, 32, 24])),
            ("restore", json!([])),
            ("setFillStyle", json!(["#00ff00"])),
            ("fillRect", json!([2, 2, 4, 4])),
        ]),
        |backend, image| {
            for y in 0..24 {
                for x in 0..32 {
                    let expected = if (2..6).contains(&x) && (2..6).contains(&y) {
                        [0, 255, 0, 255]
                    } else {
                        [255, 0, 0, 255]
                    };
                    assert_eq!(pixel(image, x, y), expected, "{backend}: ({x},{y})");
                }
            }
        },
    );
}

#[test]
fn late_clip_budget_rejection_preserves_owned_image_page_and_next_reserve_base() {
    let owner = CanvasOwnerKey {
        page_id: 1,
        page_incarnation: 1,
        scope_id: None,
        scope_incarnation: None,
        node_identity: "affine-budget-canvas".into(),
        node_generation: 1,
    };
    let viewport = Rect {
        x: 0.,
        y: 0.,
        width: 4.,
        height: 2.,
    };
    let mut root = RenderNode::new("page", viewport);
    root.background = Some(Color::BLACK);
    let mut canvas = RenderNode::new(
        "canvas",
        Rect {
            x: 0.,
            y: 0.,
            width: 3.,
            height: 2.,
        },
    );
    canvas.tag = Some("canvas".into());
    canvas.event_identity = Some(owner.node_identity.clone());
    canvas
        .attributes
        .insert("canvas-id".into(), "affine".into());
    root.children.push(canvas);
    let mut renderer = SkiaRenderer::new();
    drop(
        renderer
            .prepare_page_frame_with_canvas_bindings(
                RenderFrame {
                    frame_id: 1,
                    viewport,
                    root,
                    images: BTreeMap::new(),
                },
                PageFrameTargetPolicy::Legacy,
                vec![owner.clone()],
            )
            .unwrap()
            .accept(),
    );
    // A real 4MiB accepted bitmap exercises image attachment. Rejected batches
    // exceed admission budgets before allocating any clip masks or pixels.
    let draw = |commands: &[(&str, Value)], reserve| {
        let mut draw = frame(commands);
        draw.width = 1024;
        draw.height = 1024;
        draw.reserve = reserve;
        draw
    };
    drop(
        renderer
            .prepare_owned_canvas_draw(
                &owner,
                draw(
                    &[
                        ("setFillStyle", json!(["red"])),
                        ("fillRect", json!([0, 0, 1024, 1024])),
                    ],
                    false,
                ),
            )
            .unwrap()
            .accept(),
    );
    let accepted_canvas = renderer.owned_canvas_snapshot(&owner).unwrap();
    let accepted_page = renderer.last_frame().unwrap().clone();
    let accepted_pixels = renderer.snapshot_ref().unwrap().clone();
    let accepted_revision = renderer.snapshot_revision();
    let accepted_surface = renderer.canvas.owned[&owner].clone();
    let accepted_image = accepted_surface.image.as_ref().unwrap().clone();
    assert_eq!(pixel(&accepted_canvas, 100, 100), [255, 0, 0, 255]);
    assert_eq!(pixel(&accepted_pixels, 0, 0), [255, 0, 0, 255]);
    assert!(Arc::ptr_eq(
        accepted_page.images.values().next().unwrap(),
        &accepted_image
    ));
    for (save_masks, count, reason) in [
        (true, 128, "canvas clip memory budget exceeded"),
        (false, 300, "canvas geometry work budget exceeded"),
    ] {
        let mut commands = vec![
            ("setFillStyle", json!(["blue"])),
            ("fillRect", json!([0, 0, 1024, 1024])),
        ];
        for _ in 0..count {
            commands.push(("clip", json!([])));
            if save_masks {
                commands.push(("save", json!([])));
            }
        }
        assert!(matches!(
            renderer.prepare_owned_canvas_draw(&owner, draw(&commands, true)),
            Err(RenderError::InvalidCanvas(message)) if message == reason
        ));
        assert_eq!(
            renderer.owned_canvas_snapshot(&owner),
            Some(accepted_canvas.clone())
        );
        assert_eq!(renderer.last_frame(), Some(&accepted_page));
        assert_eq!(renderer.snapshot_ref(), Some(&accepted_pixels));
        assert_eq!(renderer.snapshot_revision(), accepted_revision);
        assert!(Arc::ptr_eq(
            &renderer.canvas.owned[&owner],
            &accepted_surface
        ));
        assert!(Arc::ptr_eq(
            renderer.canvas.owned[&owner].image.as_ref().unwrap(),
            &accepted_image
        ));
    }
    drop(
        renderer
            .prepare_owned_canvas_draw(
                &owner,
                draw(
                    &[
                        ("setFillStyle", json!(["#00ff00"])),
                        ("fillRect", json!([768, 0, 256, 1024])),
                    ],
                    true,
                ),
            )
            .unwrap()
            .accept(),
    );
    let recovered = renderer.owned_canvas_snapshot(&owner).unwrap();
    assert_eq!(pixel(&recovered, 100, 100), [255, 0, 0, 255]);
    assert_eq!(pixel(&recovered, 900, 100), [0, 255, 0, 255]);
    assert_eq!(renderer.canvas.owned[&owner].batch_starts, [2]);
    assert_eq!(renderer.canvas.owned[&owner].history.len(), 4);
    assert_eq!(renderer.snapshot_revision(), accepted_revision + 1);
}
