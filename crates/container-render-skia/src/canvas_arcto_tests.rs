use super::*;
use canvas_arcto::TangentArc;
use canvas_batch::{PreparedCanvasBatch, PreparedCanvasCommand};
use serde_json::{json, Value};

fn frame(commands: &[(&str, Value)]) -> CanvasFrame {
    CanvasFrame {
        frame_id: 7,
        canvas_id: "arcto".into(),
        width: 64,
        height: 64,
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

fn near(actual: f32, expected: f64) {
    assert!(
        (f64::from(actual) - expected).abs() < 0.00002,
        "{actual} != {expected}"
    );
}

fn conic(prepared: &PreparedCanvasBatch) -> TangentArc {
    assert!(!prepared
        .commands
        .iter()
        .any(|command| matches!(command, PreparedCanvasCommand::PendingArcTo(_))));
    let arcs = prepared
        .commands
        .iter()
        .filter_map(|command| match command {
            PreparedCanvasCommand::ConicArcTo(arc) => Some(*arc),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(arcs.len(), 1);
    arcs[0]
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
fn public_canvas_payload_and_both_operation_registries_admit_arc_to() {
    assert!(canvas_command_is_known("arcTo"));
    assert!(canvas_command_is_supported("arcTo"));
    let payload = json!({
        "canvasId":"arcto", "width":16, "height":16,
        "commands":[{"op":"arcTo","args":[2,3,4,5,6]}]
    });
    let frame = CanvasFrame::from_payload(payload.as_object().unwrap(), 9, None).unwrap();
    assert_eq!(
        frame.commands[0].args,
        json!([2, 3, 4, 5, 6]).as_array().unwrap().clone()
    );
    assert_eq!(
        PreparedCanvasBatch::prepare(&frame).unwrap().commands,
        [PreparedCanvasCommand::MoveTo([2.0, 3.0])]
    );
}

#[test]
fn canonical_tangents_cover_both_turn_directions_and_a_120_degree_arc() {
    for (y2, end_y) in [(20, 14.0), (0, 6.0)] {
        let source = frame(&[
            ("moveTo", json!([2, 10])),
            ("arcTo", json!([12, 10, 12, y2, 4])),
        ]);
        let prepared = PreparedCanvasBatch::prepare(&source).unwrap();
        let arc = conic(&prepared);
        assert_eq!(arc.start, CanvasPoint { x: 8.0, y: 10.0 });
        assert_eq!(arc.control, CanvasPoint { x: 12.0, y: 10.0 });
        assert_eq!(arc.end, CanvasPoint { x: 12.0, y: end_y });
        near(arc.weight, std::f64::consts::FRAC_1_SQRT_2);
        assert_eq!(prepared.commands.len(), source.commands.len());
        assert_eq!(source.commands[1].op, "arcTo");
    }
    let source = frame(&[
        ("moveTo", json!([0, 0])),
        ("arcTo", json!([10, 0, 5, 5.0 * 3.0_f64.sqrt(), 2])),
    ]);
    let arc = conic(&PreparedCanvasBatch::prepare(&source).unwrap());
    near(arc.start.x, 10.0 - 2.0 * 3.0_f64.sqrt());
    near(arc.start.y, 0.0);
    near(arc.end.x, 10.0 - 3.0_f64.sqrt());
    near(arc.end.y, 3.0);
    near(arc.weight, 0.5);
}

#[test]
fn empty_zero_coincident_and_collinear_cases_lower_to_only_move_or_line() {
    let prepared =
        PreparedCanvasBatch::prepare(&frame(&[("arcTo", json!([12, 8, 16, 8, 4]))])).unwrap();
    assert_eq!(
        prepared.commands,
        [PreparedCanvasCommand::MoveTo([12.0, 8.0])]
    );
    for args in [
        json!([12, 10, 12, 20, 0]),
        json!([2, 10, 12, 20, 4]),
        json!([12, 10, 12, 10, 4]),
        json!([12, 10, 20, 10, 4]),
        json!([12, 10, 0, 10, 4]),
    ] {
        let p1 = [
            args[0].as_f64().unwrap() as f32,
            args[1].as_f64().unwrap() as f32,
        ];
        let prepared =
            PreparedCanvasBatch::prepare(&frame(&[("moveTo", json!([2, 10])), ("arcTo", args)]))
                .unwrap();
        assert_eq!(prepared.commands[1], PreparedCanvasCommand::LineTo(p1));
    }
    // Radius zero does not require an inverse. A nonzero source radius below
    // the f32 domain follows the same explicit native-scalar policy.
    for radius in [0.0, 1e-100] {
        let prepared = PreparedCanvasBatch::prepare(&frame(&[
            ("moveTo", json!([2, 10])),
            ("setTransform", json!([0, 0, 0, 0, 3, 4])),
            ("arcTo", json!([12, 10, 12, 20, radius])),
        ]))
        .unwrap();
        assert_eq!(
            prepared.commands[2],
            PreparedCanvasCommand::LineTo([12.0, 10.0])
        );
    }
}

#[test]
fn large_radius_extends_tangents_and_near_straight_huge_radius_avoids_angle_drift() {
    let arc = conic(
        &PreparedCanvasBatch::prepare(&frame(&[
            ("moveTo", json!([2, 10])),
            ("arcTo", json!([12, 10, 12, 20, 30])),
        ]))
        .unwrap(),
    );
    assert_eq!(arc.start, CanvasPoint { x: -18.0, y: 10.0 });
    assert_eq!(arc.end, CanvasPoint { x: 12.0, y: 40.0 });
    let prepared = PreparedCanvasBatch::prepare(&frame(&[
        ("moveTo", json!([0, 0])),
        ("arcTo", json!([1, 0, 2, 0.000001, 100_000_000])),
    ]))
    .unwrap();
    let arc = conic(&prepared);
    // Independent small-angle tangent estimate: r*tan(atan(1e-6)/2) ≈50.
    // A center/start-angle representation drifts by multiple pixels here.
    assert!((arc.start.x + 49.0).abs() < 0.0001);
    assert_eq!(arc.start.y, 0.0);
    assert!((arc.end.x - 51.0).abs() < 0.0001);
    assert!((arc.end.y - 0.00005).abs() < 1e-9);
    assert_eq!(arc.weight, 1.0);
}

#[test]
fn changed_ctm_and_close_path_recover_the_actual_old_endpoint() {
    let prepared = PreparedCanvasBatch::prepare(&frame(&[
        ("setTransform", json!([2, 1, 1, 2, 4, 2])),
        ("moveTo", json!([2, 3])), // stored endpoint (11,10)
        ("setTransform", json!([1, 0, 0, 1, 0, 0])),
        ("arcTo", json!([21, 10, 21, 20, 4])),
    ]))
    .unwrap();
    let arc = conic(&prepared);
    assert_eq!(arc.start, CanvasPoint { x: 17.0, y: 10.0 });
    assert_eq!(arc.end, CanvasPoint { x: 21.0, y: 14.0 });
    let prepared = PreparedCanvasBatch::prepare(&frame(&[
        ("moveTo", json!([2, 10])),
        ("lineTo", json!([2, 2])),
        ("closePath", json!([])),
        ("arcTo", json!([12, 10, 12, 20, 4])),
    ]))
    .unwrap();
    let arc = conic(&prepared);
    assert_eq!(arc.start, CanvasPoint { x: 8.0, y: 10.0 });
    assert_eq!(arc.end, CanvasPoint { x: 12.0, y: 14.0 });
    let mut state = CanvasRasterState::default();
    for command in &prepared.commands {
        assert!(
            apply_canvas_state_command(&mut state, command)
                || apply_canvas_path_command(&mut state, command)
        );
    }
    assert_eq!(state.path.current_point(), Some(arc.end));
    assert_ne!(
        state.path.current_point(),
        Some(CanvasPoint { x: 12.0, y: 20.0 })
    );
}

#[test]
fn affine_conics_capture_shear_nonuniform_scale_and_reflection_before_clip() {
    for matrix in [
        [1.0, 0.5, 0.25, 1.0, 6.0, 4.0],
        [-1.0, 0.5, 0.25, 1.0, 40.0, 4.0],
    ] {
        let source = frame(&[
            ("setTransform", json!(matrix)),
            ("moveTo", json!([2, 4])),
            ("lineTo", json!([14, 4])),
            ("arcTo", json!([22, 4, 22, 12, 8])),
            ("lineTo", json!([22, 20])),
            ("lineTo", json!([2, 20])),
            ("closePath", json!([])),
            ("setTransform", json!([0, 0, 0, 0, 0, 0])),
            ("clip", json!([])),
            ("setTransform", json!([1, 0, 0, 1, 0, 0])),
            ("fillRect", json!([0, 0, 64, 64])),
        ]);
        let arc = conic(&PreparedCanvasBatch::prepare(&source).unwrap());
        let [a, b, c, d, e, f] = matrix;
        assert_eq!(
            arc.start,
            CanvasPoint {
                x: (a * 14.0 + c * 4.0 + e) as f32,
                y: (b * 14.0 + d * 4.0 + f) as f32
            }
        );
        assert_eq!(
            arc.end,
            CanvasPoint {
                x: (a * 22.0 + c * 12.0 + e) as f32,
                y: (b * 22.0 + d * 12.0 + f) as f32
            }
        );
        each_backend(&source, |backend, image| {
            let mut inside_count = 0;
            let mut outside_count = 0;
            for y in 0..64 {
                for x in 0..64 {
                    // Analytic rounded rectangle in user space, independently
                    // mapped back from each device pixel center. Avoid AA edges.
                    let (px, py) = (x as f64 + 0.5 - e, y as f64 + 0.5 - f);
                    let det = a * d - b * c;
                    let (u, v) = ((d * px - c * py) / det, (a * py - b * px) / det);
                    let corner_distance = (u - 14.0).hypot(v - 12.0);
                    let inside = (3.0..=21.0).contains(&u)
                        && (5.0..=19.0).contains(&v)
                        && (u <= 14.0 || v >= 12.0 || corner_distance <= 7.0);
                    let outside = !(1.0..=23.0).contains(&u)
                        || !(3.0..=21.0).contains(&v)
                        || (u >= 14.0 && v <= 12.0 && corner_distance >= 9.0);
                    if inside {
                        inside_count += 1;
                        assert!(pixel(image, x, y)[3] > 200, "{backend}: inside{x},{y}");
                    }
                    if outside {
                        outside_count += 1;
                        assert_eq!(pixel(image, x, y), [0; 4], "{backend}: outside{x},{y}");
                    }
                }
            }
            assert!(inside_count > 100 && outside_count > 1000);
        });
    }
}

#[test]
fn stroke_stops_at_second_tangent_and_does_not_finish_at_second_control_point() {
    each_backend(
        &frame(&[
            ("setLineWidth", json!([2])),
            ("moveTo", json!([2, 4])),
            ("arcTo", json!([22, 4, 22, 20, 8])),
            ("stroke", json!([])),
        ]),
        |backend, image| {
            assert!(pixel(image, 10, 3)[3] > 200, "{backend}: tangent line");
            assert!(pixel(image, 21, 10)[3] > 100, "{backend}: circle arc");
            assert_eq!(pixel(image, 21, 16), [0; 4], "{backend}: no line to P2");
            assert_eq!(pixel(image, 21, 4), [0; 4], "{backend}: no sharp corner");
        },
    );
}

#[test]
fn typed_admission_rejects_missing_wrong_negative_and_out_of_range_values() {
    for args in [
        json!([1, 2, 3, 4]),
        json!([1, 2, 3, 4, null]),
        json!([1, 2, 3, 4, "2"]),
        json!([1, 2, 3, 4, -1]),
        json!([1, 2, 3, 4, -1e-100]),
        json!([1, 2, 3, 4, 1e100]),
    ] {
        canvas_work_probes::reset();
        assert!(matches!(
            PreparedCanvasBatch::prepare(&frame(&[("arcTo", args)])),
            Err(RenderError::InvalidCanvas(_))
        ));
        assert_eq!(
            canvas_work_probes::counts(),
            canvas_work_probes::Counts::default()
        );
    }
}

#[test]
fn late_geometry_rejection_keeps_snapshot_history_and_the_next_reserve_base() {
    let mut service = CanvasService::default();
    let accepted = frame(&[
        ("setFillStyle", json!(["red"])),
        ("fillRect", json!([0, 0, 64, 64])),
    ]);
    let snapshot = service.commit(accepted.clone()).unwrap();
    for suffix in [
        vec![
            ("moveTo", json!([0, 0])),
            ("setTransform", json!([0, 0, 0, 0, 0, 0])),
            ("arcTo", json!([10, 0, 10, 10, 2])),
        ],
        vec![
            ("moveTo", json!([0, 0])),
            ("arcTo", json!([f32::MAX, 0, 0, f32::MAX, f32::MAX])),
        ],
        vec![
            ("moveTo", json!([0, 0])),
            (
                "arcTo",
                json!([100_000_000, 0, 100_000_000, 100_000_000, 100_000_000]),
            ),
        ],
    ] {
        let mut commands = vec![
            ("setFillStyle", json!(["blue"])),
            ("fillRect", json!([0, 0, 64, 64])),
        ];
        commands.extend(suffix);
        let mut rejected = frame(&commands);
        rejected.reserve = true;
        canvas_work_probes::reset();
        assert!(matches!(
            service.commit(rejected),
            Err(RenderError::InvalidCanvas(_))
        ));
        assert_eq!(
            canvas_work_probes::counts(),
            canvas_work_probes::Counts::default()
        );
        assert_eq!(service.snapshot("arcto"), Some(snapshot.clone()));
        assert_eq!(service.commands["arcto"], accepted.commands);
    }
    let mut recovery = frame(&[
        ("setFillStyle", json!(["#00ff00"])),
        ("fillRect", json!([0, 0, 2, 2])),
    ]);
    recovery.reserve = true;
    let recovered = service.commit(recovery.clone()).unwrap();
    assert_eq!(pixel(&recovered, 0, 0), [0, 255, 0, 255]);
    assert_eq!(pixel(&recovered, 10, 10), [255, 0, 0, 255]);
    let mut history = accepted.commands;
    history.extend(recovery.commands);
    assert_eq!(service.commands["arcto"], history);
}

#[test]
fn chained_arc_to_uses_tangent_endpoint_and_batch_reset_discards_old_path_state() {
    let source = frame(&[
        ("moveTo", json!([2, 10])),
        ("arcTo", json!([12, 10, 12, 20, 4])),
        ("arcTo", json!([12, 24, 22, 24, 4])),
        ("arcTo", json!([30, 5, 40, 5, 4])),
        ("arcTo", json!([40, 5, 40, 15, 4])),
    ]);
    let original = source.commands.clone();
    let prepared = PreparedCanvasBatch::prepare_batches(&source, &[3]).unwrap();
    let first = match prepared.commands[1] {
        PreparedCanvasCommand::ConicArcTo(arc) => arc,
        ref other => panic!("first arc was not lowered: {other:?}"),
    };
    assert_eq!(first.end, CanvasPoint { x: 12.0, y: 14.0 });
    let second = match prepared.commands[2] {
        PreparedCanvasCommand::ConicArcTo(arc) => arc,
        ref other => panic!("second arc was not lowered: {other:?}"),
    };
    assert_eq!(second.start, CanvasPoint { x: 12.0, y: 20.0 });
    assert_eq!(second.end, CanvasPoint { x: 16.0, y: 24.0 });
    assert_eq!(prepared.commands[3], PreparedCanvasCommand::ResetState);
    assert_eq!(
        prepared.commands[4],
        PreparedCanvasCommand::MoveTo([30.0, 5.0])
    );
    let third = match prepared.commands[5] {
        PreparedCanvasCommand::ConicArcTo(arc) => arc,
        ref other => panic!("post-reset arc was not lowered: {other:?}"),
    };
    assert_eq!(third.start, CanvasPoint { x: 36.0, y: 5.0 });
    assert_eq!(third.end, CanvasPoint { x: 40.0, y: 9.0 });
    let mut state = CanvasRasterState::default();
    for command in &prepared.commands {
        assert!(
            apply_canvas_state_command(&mut state, command)
                || apply_canvas_path_command(&mut state, command)
        );
    }
    assert_eq!(state.path.current_point(), Some(third.end));
    assert_eq!(source.commands, original);
    assert!(source
        .commands
        .iter()
        .skip(1)
        .all(|command| command.op == "arcTo"));
}

#[test]
fn late_arc_to_rejection_preserves_owned_image_page_history_and_reserve_recovery() {
    let owner = CanvasOwnerKey {
        page_id: 1,
        page_incarnation: 1,
        scope_id: None,
        scope_incarnation: None,
        node_identity: "arcto-owned".into(),
        node_generation: 1,
    };
    let viewport = Rect {
        x: 0.,
        y: 0.,
        width: 72.,
        height: 64.,
    };
    let mut root = RenderNode::new("page", viewport);
    root.background = Some(Color::BLACK);
    let mut canvas = RenderNode::new(
        "canvas",
        Rect {
            x: 0.,
            y: 0.,
            width: 64.,
            height: 64.,
        },
    );
    canvas.tag = Some("canvas".into());
    canvas.event_identity = Some(owner.node_identity.clone());
    canvas.attributes.insert("canvas-id".into(), "arcto".into());
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
    let accepted = frame(&[
        ("setFillStyle", json!(["red"])),
        ("fillRect", json!([0, 0, 64, 64])),
        ("moveTo", json!([2, 10])),
        ("arcTo", json!([12, 10, 12, 20, 4])),
    ]);
    drop(
        renderer
            .prepare_owned_canvas_draw(&owner, accepted.clone())
            .unwrap()
            .accept(),
    );
    let accepted_canvas = renderer.owned_canvas_snapshot(&owner).unwrap();
    let accepted_page = renderer.last_frame().unwrap().clone();
    let accepted_pixels = renderer.snapshot_ref().unwrap().clone();
    let accepted_revision = renderer.snapshot_revision();
    let accepted_surface = renderer.canvas.owned[&owner].clone();
    let accepted_image = accepted_surface.image.as_ref().unwrap().clone();
    assert_eq!(pixel(&accepted_canvas, 30, 30), [255, 0, 0, 255]);
    assert!(Arc::ptr_eq(
        accepted_page.images.values().next().unwrap(),
        &accepted_image
    ));
    for suffix in [
        vec![
            ("moveTo", json!([0, 0])),
            ("setTransform", json!([0, 0, 0, 0, 0, 0])),
            ("arcTo", json!([10, 0, 10, 10, 2])),
        ],
        vec![
            ("moveTo", json!([0, 0])),
            ("arcTo", json!([f32::MAX, 0, 0, f32::MAX, f32::MAX])),
        ],
        vec![
            ("moveTo", json!([0, 0])),
            (
                "arcTo",
                json!([100_000_000, 0, 100_000_000, 100_000_000, 100_000_000]),
            ),
        ],
    ] {
        let mut commands = vec![
            ("setFillStyle", json!(["blue"])),
            ("fillRect", json!([0, 0, 64, 64])),
        ];
        commands.extend(suffix);
        let mut rejected = frame(&commands);
        rejected.reserve = true;
        canvas_work_probes::reset();
        assert!(matches!(
            renderer.prepare_owned_canvas_draw(&owner, rejected),
            Err(RenderError::InvalidCanvas(_))
        ));
        assert_eq!(
            canvas_work_probes::counts(),
            canvas_work_probes::Counts::default()
        );
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
        assert_eq!(renderer.canvas.owned[&owner].history, accepted.commands);
    }
    let mut recovery = frame(&[
        ("arcTo", json!([30, 5, 40, 5, 4])),
        ("setFillStyle", json!(["#00ff00"])),
        ("fillRect", json!([48, 0, 16, 64])),
    ]);
    recovery.reserve = true;
    drop(
        renderer
            .prepare_owned_canvas_draw(&owner, recovery.clone())
            .unwrap()
            .accept(),
    );
    let recovered = renderer.owned_canvas_snapshot(&owner).unwrap();
    assert_eq!(pixel(&recovered, 30, 30), [255, 0, 0, 255]);
    assert_eq!(pixel(&recovered, 60, 30), [0, 255, 0, 255]);
    let mut history = accepted.commands;
    history.extend(recovery.commands);
    assert_eq!(renderer.canvas.owned[&owner].history, history);
    assert_eq!(renderer.canvas.owned[&owner].batch_starts, [4]);
    assert_eq!(renderer.snapshot_revision(), accepted_revision + 1);
}
