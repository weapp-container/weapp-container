use super::*;
use serde_json::json;

fn operation(kind: &str, args: &[f64]) -> Value {
    json!({"type":kind,"args":args})
}

fn step(operations: Vec<Value>, duration: f64, delay: f64, easing: &str, origin: &str) -> Value {
    json!({"animates":operations,"option":{
        "duration":duration,"delay":delay,"timingFunction":easing,"transformOrigin":origin
    }})
}

fn program(steps: Vec<Value>) -> Program {
    Program::decode(&json!({"actions":steps})).unwrap()
}

fn one(operations: Vec<Value>) -> Program {
    program(vec![step(operations, 100.0, 0.0, "linear", "50% 50% 0")])
}

fn at(timeline: &Timeline, millis: u64) -> Sample {
    timeline.sample(Duration::from_millis(millis)).unwrap()
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1.0e-6 * expected.abs().max(1.0),
        "actual={actual}, expected={expected}"
    );
}

#[test]
fn typed_rotation_interpolation_preserves_the_rotating_unit_circle() {
    let timeline = one(vec![operation("rotate", &[90.0])])
        .bind(Values::default())
        .unwrap();
    let middle = at(&timeline, 50);
    let matrix = middle.transform.unwrap();
    let point = matrix.apply((1.0, 0.0));
    close(f64::from(point.0), std::f64::consts::FRAC_1_SQRT_2);
    close(f64::from(point.1), std::f64::consts::FRAC_1_SQRT_2);
    close(matrix.determinant(), 1.0);
    // Lerp of the start/end matrix would place the point at (0.5,0.5).
    assert!(point.0 > 0.7 && point.1 > 0.7);
    assert!(!middle.finished);
    let final_sample = at(&timeline, 100);
    assert!(final_sample.finished);
    let point = final_sample.transform.unwrap().apply((2.0, 0.0));
    close(f64::from(point.0), 0.0);
    close(f64::from(point.1), 2.0);
}

#[test]
fn opacity_only_requires_no_transform_baseline_and_publishes_no_transform_style() {
    let opacity = program(vec![step(
        vec![operation("opacity", &[0.8])],
        100.0,
        20.0,
        "linear",
        "right bottom",
    )]);
    assert!(opacity.uses_opacity());
    assert!(!opacity.uses_transform());
    // The caller may leave a CSS matrix3d() entirely in the normal style lane.
    // No Transform2D conversion is needed to bind this opacity baseline.
    let timeline = opacity
        .bind(Values {
            opacity: Some(0.2),
            ..Values::default()
        })
        .unwrap();
    for time in [0, 20, 70, 120] {
        let sample = at(&timeline, time);
        assert_eq!(sample.transform, None);
        assert_eq!(sample.transform_origin, None);
    }
    close(f64::from(at(&timeline, 70).opacity.unwrap()), 0.5);
    let transform = one(vec![operation("translateX", &[10.0])]);
    assert!(!transform.uses_opacity());
    assert!(transform.uses_transform());
    let empty = program(vec![]);
    assert!(!empty.uses_opacity());
    assert!(!empty.uses_transform());
}

#[test]
fn all_twelve_members_share_explicit_last_axis_write_policy() {
    let timeline = one(vec![
        operation("opacity", &[0.4]),
        operation("rotate", &[10.0]),
        operation("rotateZ", &[30.0]),
        operation("scale", &[2.0, 3.0]),
        operation("scaleX", &[4.0]),
        operation("scaleY", &[5.0]),
        operation("skew", &[10.0, 20.0]),
        operation("skewX", &[30.0]),
        operation("skewY", &[40.0]),
        operation("translate", &[7.0, 8.0]),
        operation("translateX", &[9.0]),
        operation("translateY", &[10.0]),
    ])
    .bind(Values {
        opacity: Some(0.8),
        ..Values::default()
    })
    .unwrap();
    let final_sample = at(&timeline, 100);
    assert_eq!(
        final_sample.values,
        Values {
            opacity: Some(0.4),
            rotate_degrees: 30.0,
            scale_x: 4.0,
            scale_y: 5.0,
            skew_x_degrees: 30.0,
            skew_y_degrees: 40.0,
            translate_x: 9.0,
            translate_y: 10.0,
        }
    );
    close(f64::from(final_sample.opacity.unwrap()), 0.4);
}

#[test]
fn fixed_composition_has_independent_geometric_endpoints() {
    let timeline = one(vec![
        operation("translate", &[20.0, 30.0]),
        operation("rotate", &[90.0]),
        operation("scale", &[2.0, 3.0]),
        operation("skewX", &[45.0]),
    ])
    .bind(Values::default())
    .unwrap();
    // (1,2) -> skew (3,2) -> scale (6,6) -> rotate (-6,6)
    // -> translate (14,36). This distinguishes Scale*Skew from Skew*Scale.
    let point = at(&timeline, 100).transform.unwrap().apply((1.0, 2.0));
    close(f64::from(point.0), 14.0);
    close(f64::from(point.1), 36.0);
}

#[test]
fn delay_group_boundaries_and_untouched_properties_are_retained() {
    let timeline = program(vec![
        step(
            vec![
                operation("translateX", &[15.0]),
                operation("opacity", &[0.75]),
            ],
            100.0,
            50.0,
            "linear",
            "left top",
        ),
        step(
            vec![operation("rotateZ", &[90.0])],
            100.0,
            20.0,
            "linear",
            "right bottom",
        ),
    ])
    .bind(Values {
        translate_x: 5.0,
        opacity: Some(0.25),
        ..Values::default()
    })
    .unwrap();
    assert_eq!(timeline.duration(), Duration::from_millis(270));
    let waiting = at(&timeline, 49);
    assert_eq!(waiting.transform, None);
    assert_eq!(waiting.opacity, None);
    assert_eq!(waiting.transform_origin, None);
    assert_eq!(waiting.values.translate_x, 5.0);
    let first = at(&timeline, 50);
    assert_eq!(first.transform_origin.as_deref(), Some("left top"));
    close(first.values.opacity.unwrap(), 0.25);
    let middle = at(&timeline, 100);
    close(middle.values.translate_x, 10.0);
    close(middle.values.opacity.unwrap(), 0.5);
    for time in [150, 169] {
        let waiting = at(&timeline, time);
        assert_eq!(waiting.values.translate_x, 15.0);
        assert_eq!(waiting.values.opacity, Some(0.75));
        assert_eq!(waiting.transform_origin.as_deref(), Some("left top"));
    }
    let second = at(&timeline, 170);
    assert_eq!(second.transform_origin.as_deref(), Some("right bottom"));
    assert_eq!(second.values.rotate_degrees, 0.0);
    let final_sample = at(&timeline, 270);
    assert!(final_sample.finished);
    assert_eq!(final_sample.values.translate_x, 15.0);
    assert_eq!(final_sample.values.opacity, Some(0.75));
    assert_eq!(final_sample.values.rotate_degrees, 90.0);
}

#[test]
fn all_css_easings_solve_x_and_preserve_exact_endpoints() {
    let cases = [
        ("linear", 0.5),
        ("ease", 0.802_403_387_584_857),
        ("ease-in", 0.315_356_812_572_539_34),
        ("ease-out", 0.684_643_187_427_460_8),
        ("ease-in-out", 0.5),
        ("step-start", 1.0),
        ("step-end", 0.0),
    ];
    for (name, expected) in cases {
        let easing = Easing::decode(&json!(name)).unwrap();
        assert!((easing.sample(0.5) - expected).abs() < 1.0e-12, "{name}");
        assert_eq!(easing.sample(1.0), 1.0, "{name}");
        assert_eq!(
            easing.sample(0.0),
            if name == "step-start" { 1.0 } else { 0.0 }
        );
    }
    // Evaluating y at t=.5 would incorrectly return .5375 for ease.
    assert!(Easing::decode(&json!("ease")).unwrap().sample(0.5) > 0.8);
}

#[test]
fn step_start_waits_for_delay_and_step_end_waits_for_the_last_frame() {
    for easing in ["step-start", "step-end"] {
        let timeline = program(vec![step(
            vec![operation("opacity", &[1.0])],
            100.0,
            20.0,
            easing,
            "center",
        )])
        .bind(Values {
            opacity: Some(0.2),
            ..Values::default()
        })
        .unwrap();
        assert_eq!(at(&timeline, 19).opacity, None);
        for time in [20, 119] {
            let expected = if easing == "step-start" { 1.0 } else { 0.2 };
            close(f64::from(at(&timeline, time).opacity.unwrap()), expected);
        }
        assert_eq!(at(&timeline, 120).opacity, Some(1.0));
        assert!(at(&timeline, 120).finished);
    }
}

#[test]
fn zero_duration_empty_and_simultaneous_next_groups_have_exact_order() {
    let timeline = program(vec![
        step(
            vec![operation("opacity", &[0.0])],
            0.0,
            0.0,
            "step-end",
            "center",
        ),
        step(vec![], 0.0, 0.0, "ease", "center"),
        step(
            vec![operation("translateX", &[10.0])],
            0.0,
            0.0,
            "linear",
            "center",
        ),
        step(
            vec![operation("opacity", &[1.0])],
            100.0,
            0.0,
            "step-end",
            "center",
        ),
    ])
    .bind(Values {
        opacity: Some(0.5),
        ..Values::default()
    })
    .unwrap();
    for time in [0, 99] {
        let sample = at(&timeline, time);
        assert_eq!(sample.opacity, Some(0.0));
        assert_eq!(sample.values.translate_x, 10.0);
        assert!(!sample.finished);
    }
    assert_eq!(at(&timeline, 100).opacity, Some(1.0));
    assert!(at(&timeline, 100).finished);
    let empty = program(vec![]);
    assert!(empty.is_empty());
    let empty = empty.bind(Values::default()).unwrap();
    assert!(at(&empty, 0).finished);
    assert_eq!(at(&empty, 0).transform, None);
    assert_eq!(at(&empty, 0).opacity, None);
}

#[test]
fn fractional_millisecond_duration_is_not_truncated_to_whole_milliseconds() {
    let timeline = program(vec![step(
        vec![operation("translateX", &[10.0])],
        0.5,
        0.25,
        "linear",
        "center",
    )])
    .bind(Values::default())
    .unwrap();
    assert_eq!(timeline.duration(), Duration::from_micros(750));
    let sample = timeline.sample(Duration::from_micros(500)).unwrap();
    assert_eq!(sample.values.translate_x, 5.0);
    assert!(!sample.finished);
}

#[test]
fn explicit_baseline_opacity_is_required_only_for_opacity_programs() {
    assert!(one(vec![operation("opacity", &[0.5])])
        .bind(Values::default())
        .is_err());
    let timeline = one(vec![operation("translateX", &[4.0])])
        .bind(Values {
            opacity: Some(0.3),
            ..Values::default()
        })
        .unwrap();
    let sample = at(&timeline, 50);
    assert_eq!(sample.opacity, None);
    assert_eq!(sample.values.opacity, Some(0.3));
}

#[test]
fn arbitrary_affine_baseline_retains_actual_geometry_at_the_first_sample() {
    let matrix = Transform2D {
        a: 2.0,
        b: 1.0,
        c: 3.0,
        d: 4.0,
        e: 5.0,
        f: 6.0,
    };
    let baseline = Values::from_affine(Some(0.6), matrix).unwrap();
    let timeline = one(vec![operation("rotateZ", &[90.0])])
        .bind(baseline)
        .unwrap();
    let initial = at(&timeline, 0);
    let point = initial.transform.unwrap().apply((4.0, 5.0));
    close(f64::from(point.0), 28.0);
    close(f64::from(point.1), 30.0);
    assert_eq!(initial.opacity, None);
    assert_eq!(initial.values.opacity, Some(0.6));
    assert!(initial.values.scale_x > 0.0);
    assert!(initial.values.scale_y > 0.0);
}

#[test]
fn affine_decomposition_handles_reflection_rank_one_zero_columns_and_zero_matrix() {
    let cases = [
        Transform2D {
            a: -2.0,
            b: 0.0,
            c: 0.0,
            d: 3.0,
            e: 8.0,
            f: -9.0,
        },
        Transform2D {
            a: 2.0,
            b: 4.0,
            c: 3.0,
            d: 6.0,
            e: 0.0,
            f: 0.0,
        },
        Transform2D {
            a: 0.0,
            b: 0.0,
            c: 3.0,
            d: 4.0,
            e: 2.0,
            f: 3.0,
        },
        Transform2D {
            a: 0.0,
            b: 0.0,
            c: 0.0,
            d: 0.0,
            e: 2.0,
            f: 3.0,
        },
    ];
    for matrix in cases {
        let values = Values::from_affine(None, matrix).unwrap();
        let rebuilt = values.affine().unwrap();
        for point in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (2.0, -3.0)] {
            let actual = rebuilt.apply(point);
            let expected = matrix.apply(point);
            close(f64::from(actual.0), f64::from(expected.0));
            close(f64::from(actual.1), f64::from(expected.1));
        }
    }
    assert!(Values::from_affine(None, cases[0]).unwrap().scale_y < 0.0);
}

#[test]
fn replacement_can_begin_at_the_actual_typed_sample_without_matrix_lerp_or_restart() {
    let first = one(vec![
        operation("rotate", &[90.0]),
        operation("translateX", &[20.0]),
    ])
    .bind(Values::default())
    .unwrap();
    let prior = at(&first, 50);
    let replacement = one(vec![operation("rotateZ", &[-45.0])])
        .bind(prior.values)
        .unwrap();
    assert_eq!(at(&replacement, 0).transform, prior.transform);
    assert_eq!(at(&replacement, 50).values.rotate_degrees, 0.0);
    assert_eq!(at(&replacement, 100).values.rotate_degrees, -45.0);
    assert_eq!(at(&replacement, 100).values.translate_x, 10.0);
    assert_eq!(at(&first, 50).values, prior.values);
}

#[test]
fn origin_is_fully_parsed_and_unsupported_variants_reject_the_whole_program() {
    for origin in [
        "left top",
        "top right",
        "1em 2rpx 0px",
        "25% -3px",
        "initial",
        "unset",
    ] {
        let timeline = program(vec![step(
            vec![operation("rotate", &[20.0])],
            10.0,
            0.0,
            "linear",
            origin,
        )])
        .bind(Values::default())
        .unwrap();
        let expected = if matches!(origin, "initial" | "unset") {
            "50% 50% 0"
        } else {
            origin
        };
        assert_eq!(at(&timeline, 0).transform_origin.as_deref(), Some(expected));
    }
    for origin in [
        "inherit",
        "center center 1px",
        "var(--origin) center",
        "",
        "left top extra",
    ] {
        let value = json!({"actions":[step(vec![operation("rotate", &[20.0])], 10.0, 0.0, "linear", origin)]});
        assert!(Program::decode(&value).is_err(), "{origin}");
    }
}

#[test]
fn malformed_mixed_program_rejection_does_not_consume_or_change_an_existing_timeline() {
    let existing = one(vec![operation("translateX", &[40.0])])
        .bind(Values::default())
        .unwrap();
    let before = at(&existing, 25);
    let mixed = json!({"actions":[
        step(vec![operation("translateX", &[70.0])],100.0,0.0,"linear","center"),
        step(vec![operation("rotateX", &[20.0])],100.0,0.0,"linear","center")
    ]});
    let snapshot = mixed.clone();
    assert!(Program::decode(&mixed).is_err());
    assert_eq!(mixed, snapshot);
    assert_eq!(at(&existing, 25).values, before.values);
    assert_eq!(at(&existing, 25).transform, before.transform);
    for value in [
        json!({}),
        json!({"actions":[],"extra":true}),
        json!({"actions":null}),
        json!({"actions":[{"animates":[],"option":{}}]}),
        json!({"actions":[step(vec![operation("scale", &[2.0])],100.0,0.0,"linear","center")]}),
        json!({"actions":[step(vec![json!({"type":"opacity","args":[null]})],100.0,0.0,"linear","center")]}),
        json!({"actions":[step(vec![operation("opacity", &[1.01])],100.0,0.0,"linear","center")]}),
    ] {
        assert!(Program::decode(&value).is_err(), "{value}");
    }
}

#[test]
fn time_count_origin_and_wire_budgets_reject_before_binding() {
    for (duration, delay) in [
        (-1.0, 0.0),
        (1.0, -1.0),
        (86_400_001.0, 0.0),
        (0.0, 86_400_001.0),
        (1.0e-10, 0.0),
    ] {
        let value = json!({"actions":[step(vec![],duration,delay,"linear","center")]});
        assert!(Program::decode(&value).is_err());
    }
    let thirteen_hours = step(vec![], 13.0 * 60.0 * 60.0 * 1000.0, 0.0, "linear", "center");
    assert!(Program::decode(&json!({"actions":[thirteen_hours.clone(),thirteen_hours]})).is_err());
    let empty = step(vec![], 0.0, 0.0, "linear", "center");
    assert!(Program::decode(&json!({"actions":vec![empty;MAX_STEPS+1]})).is_err());
    let too_many = step(
        vec![operation("translateX", &[1.0]); MAX_OPERATIONS + 1],
        0.0,
        0.0,
        "linear",
        "center",
    );
    assert!(Program::decode(&json!({"actions":[too_many]})).is_err());
    let too_long_origin = " ".repeat(MAX_ORIGIN_BYTES) + "center";
    assert!(
        Program::decode(&json!({"actions":[step(vec![],0.0,0.0,"linear",&too_long_origin)]}))
            .is_err()
    );
    let large_valid_origin = " ".repeat(4000) + "center";
    let large_step = step(vec![], 0.0, 0.0, "linear", &large_valid_origin);
    let wire = json!({"actions":vec![large_step;1100]});
    assert!(serde_json::to_vec(&wire).unwrap().len() > MAX_WIRE_BYTES);
    assert!(Program::decode(&wire).is_err());
}

#[test]
fn skew_discontinuities_and_nonfinite_render_values_are_explicit_errors() {
    for angle in [90.0, -90.0, 180.0] {
        assert!(one(vec![operation("skewX", &[angle])])
            .bind(Values::default())
            .is_err());
    }
    let bad = Values {
        scale_x: f64::INFINITY,
        ..Values::default()
    };
    assert!(one(vec![]).bind(bad).is_err());
    assert!(Values::from_affine(Some(-0.1), Transform2D::IDENTITY).is_err());
    let huge = json!({"actions":[step(vec![operation("translateX", &[1.0e300])],100.0,0.0,"linear","center")]});
    assert!(Program::decode(&huge).is_err());
    // Both endpoint matrices are finite; an overflowing intermediate sample
    // still returns an error rather than publishing any partial style values.
    let timeline = one(vec![operation("rotate", &[90.0])])
        .bind(Values {
            scale_x: 3.0e38,
            scale_y: 3.0e38,
            skew_x_degrees: 45.0,
            ..Values::default()
        })
        .unwrap();
    assert!(timeline.sample(Duration::from_millis(50)).is_err());
    assert!(timeline.sample(Duration::ZERO).is_ok());
    assert!(timeline.sample(Duration::from_millis(100)).is_ok());
}
