//! Validate and normalize a complete Canvas submission before either executor
//! allocates pixels, builds paths or enters native drawing/font code.

use super::{
    canvas_arg_f32, canvas_arg_string, canvas_bounds, canvas_command_is_supported,
    parse_canvas_color, parse_canvas_line_cap, parse_canvas_line_join, parse_canvas_text_align,
    parse_canvas_text_baseline, CanvasCommand, CanvasFrame, CanvasLineCap, CanvasLineJoin,
    CanvasTextAlign, CanvasTextBaseline, Color, RenderError,
};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub(super) enum PreparedCanvasCommand {
    // Host-only replay boundary. No guest op maps to this variant.
    ResetState,
    SetFillStyle(Color),
    SetStrokeStyle(Color),
    SetLineWidth(f32),
    SetLineDash {
        pattern: Vec<f32>,
        offset: f32,
    },
    SetLineCap(CanvasLineCap),
    SetLineJoin(CanvasLineJoin),
    SetMiterLimit(f32),
    SetGlobalAlpha(f32),
    SetFontSize(f32),
    SetTextAlign(CanvasTextAlign),
    SetTextBaseline(CanvasTextBaseline),
    FillRect([f32; 4]),
    StrokeRect([f32; 4]),
    ClearRect([f32; 4]),
    BeginPath,
    ClosePath,
    MoveTo([f32; 2]),
    LineTo([f32; 2]),
    QuadraticCurveTo([f32; 4]),
    BezierCurveTo([f32; 6]),
    // Decode-only operation. Shared geometry admission lowers it once to a
    // MoveTo, LineTo or ConicArcTo before either executor consumes this vector.
    PendingArcTo([f32; 5]),
    ConicArcTo(super::canvas_arcto::TangentArc),
    Arc {
        center: [f32; 2],
        radius: f32,
        start: f32,
        sweep: f32,
    },
    Rect([f32; 4]),
    Fill,
    Stroke,
    FillText {
        text: String,
        position: [f32; 2],
    },
    StrokeText {
        text: String,
        position: [f32; 2],
    },
    Save,
    Restore,
    Translate([f32; 2]),
    Rotate(f32),
    Scale([f32; 2]),
    SetTransform([f32; 6]),
    Transform([f32; 6]),
    Clip,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct PreparedCanvasBatch {
    pub(super) frame_id: u64,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) stride: u32,
    pub(super) byte_len: usize,
    pub(super) commands: Vec<PreparedCanvasCommand>,
}

impl PreparedCanvasBatch {
    pub(super) const MAX_COMMANDS: usize = 16_384;
    pub(super) const MAX_COMMAND_BYTES: usize = 4 * 1024 * 1024;
    pub(super) const MAX_SAVE_DEPTH: usize = 256;
    pub(super) const MAX_GEOMETRY_VERTICES: usize = 65_536;
    pub(super) const MAX_DRAW_WORK: u64 = 256 * 1024 * 1024;
    pub(super) const MAX_SURFACE_BYTES: u64 = 16 * 1024 * 1024;
    pub(super) const MAX_CLIP_BYTES: u64 = 16 * 1024 * 1024;

    #[cfg(test)]
    pub(super) fn prepare(frame: &CanvasFrame) -> Result<Self, RenderError> {
        Self::prepare_batches(frame, &[])
    }

    pub(super) fn prepare_batches(
        frame: &CanvasFrame,
        boundaries: &[usize],
    ) -> Result<Self, RenderError> {
        // Keep the existing surface-layout-before-command validation order.
        let (stride, byte_len) = canvas_bounds(frame.width, frame.height)?;
        // Native zero-sized snapshots still use a one-pixel placeholder axis.
        let surface_bytes = u64::from(frame.width.max(1))
            .checked_mul(u64::from(frame.height.max(1)))
            .and_then(|pixels| pixels.checked_mul(4));
        if surface_bytes.is_none_or(|bytes| bytes > Self::MAX_SURFACE_BYTES) {
            return Err(RenderError::InvalidCanvas(
                "canvas surface byte budget exceeded".into(),
            ));
        }
        // Internal boundaries consume the same replay budget as public commands.
        if frame
            .commands
            .len()
            .checked_add(boundaries.len())
            .is_none_or(|count| count > Self::MAX_COMMANDS)
        {
            return Err(RenderError::InvalidCanvas(
                "canvas command budget exceeded".into(),
            ));
        }
        if boundaries.windows(2).any(|pair| pair[0] >= pair[1])
            || boundaries
                .iter()
                .any(|index| *index == 0 || *index >= frame.commands.len())
        {
            return Err(RenderError::InvalidCanvas(
                "invalid internal canvas batch boundary".into(),
            ));
        }
        struct CommandBytes(usize);
        impl std::io::Write for CommandBytes {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0 = self
                    .0
                    .checked_add(bytes.len())
                    .ok_or_else(|| std::io::Error::other("canvas command byte budget exceeded"))?;
                if self.0 > PreparedCanvasBatch::MAX_COMMAND_BYTES {
                    return Err(std::io::Error::other("canvas command byte budget exceeded"));
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut bytes = CommandBytes(boundaries.len() * 16);
        serde_json::to_writer(&mut bytes, &frame.commands).map_err(|_| {
            RenderError::InvalidCanvas("canvas command byte budget exceeded".into())
        })?;
        // Validate every public command before constructing host-only markers.
        // No pixels or native drawing resources exist at either step.
        let public_commands = frame
            .commands
            .iter()
            .map(PreparedCanvasCommand::prepare)
            .collect::<Result<Vec<_>, _>>()?;
        let mut commands = Vec::with_capacity(frame.commands.len() + boundaries.len());
        let mut boundary = boundaries.iter().copied().peekable();
        let mut depth = 0usize;
        for (index, command) in public_commands.into_iter().enumerate() {
            if boundary.peek() == Some(&index) {
                boundary.next();
                depth = 0;
                commands.push(PreparedCanvasCommand::ResetState);
            }
            match command {
                PreparedCanvasCommand::Save => {
                    depth += 1;
                    if depth > Self::MAX_SAVE_DEPTH {
                        return Err(RenderError::InvalidCanvas(
                            "canvas save depth budget exceeded".into(),
                        ));
                    }
                }
                PreparedCanvasCommand::Restore => depth = depth.saturating_sub(1),
                _ => {}
            }
            commands.push(command);
        }
        super::validate_canvas_geometry(&mut commands, frame.width, frame.height)?;
        Ok(Self {
            frame_id: frame.frame_id,
            width: frame.width,
            height: frame.height,
            stride: stride as u32,
            byte_len,
            commands,
        })
    }
}

impl PreparedCanvasCommand {
    fn prepare(command: &CanvasCommand) -> Result<Self, RenderError> {
        if !canvas_command_is_supported(&command.op) {
            return Err(RenderError::UnsupportedCanvasCommand(command.op.clone()));
        }
        Ok(match command.op.as_str() {
            "setFillStyle" => {
                Self::SetFillStyle(parse_canvas_color(canvas_arg_string(command, 0)?)?)
            }
            "setStrokeStyle" => {
                Self::SetStrokeStyle(parse_canvas_color(canvas_arg_string(command, 0)?)?)
            }
            "setLineWidth" => Self::SetLineWidth(canvas_arg_f32(command, 0)?.max(0.0)),
            "setLineDash" => {
                let pattern = command
                    .args
                    .first()
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        RenderError::InvalidCanvas(
                            "canvas command setLineDash argument 0 must be an array".into(),
                        )
                    })?;
                let expanded_len = if pattern.len() % 2 == 1 {
                    pattern.len().checked_mul(2)
                } else {
                    Some(pattern.len())
                }
                .filter(|length| *length <= i32::MAX as usize)
                .ok_or_else(|| {
                    RenderError::InvalidCanvas(
                        "canvas command setLineDash pattern exceeds native interval limits".into(),
                    )
                })?;
                let mut dash = Vec::with_capacity(expanded_len);
                for (index, value) in pattern.iter().enumerate() {
                    let number = value.as_f64().ok_or_else(|| {
                        RenderError::InvalidCanvas(format!(
                            "canvas command setLineDash argument {index} must be finite"
                        ))
                    })?;
                    let interval = number as f32;
                    if !number.is_finite() || number < 0.0 || !interval.is_finite() {
                        return Err(RenderError::InvalidCanvas(format!(
                            "canvas command setLineDash argument {index} must be finite and non-negative"
                        )));
                    }
                    dash.push(interval);
                }
                if dash.len() % 2 == 1 {
                    let mut repeated = dash.clone();
                    repeated.extend_from_slice(&dash);
                    dash = repeated;
                }
                if dash.iter().all(|value| *value == 0.0) {
                    dash.clear();
                }
                let period = dash.iter().copied().sum::<f32>();
                if !period.is_finite() {
                    return Err(RenderError::InvalidCanvas(
                        "canvas command setLineDash cycle must fit a finite native scalar".into(),
                    ));
                }
                let offset = command
                    .args
                    .get(1)
                    .map(|_| canvas_arg_f32(command, 1))
                    .transpose()?
                    .unwrap_or(0.0);
                Self::SetLineDash {
                    pattern: dash,
                    offset,
                }
            }
            "setLineCap" => {
                Self::SetLineCap(parse_canvas_line_cap(canvas_arg_string(command, 0)?)?)
            }
            "setLineJoin" => {
                Self::SetLineJoin(parse_canvas_line_join(canvas_arg_string(command, 0)?)?)
            }
            "setMiterLimit" => Self::SetMiterLimit(canvas_arg_f32(command, 0)?.max(0.0)),
            "setGlobalAlpha" => Self::SetGlobalAlpha(canvas_arg_f32(command, 0)?.clamp(0.0, 1.0)),
            "setFontSize" => Self::SetFontSize(canvas_arg_f32(command, 0)?.max(1.0)),
            "setTextAlign" => {
                Self::SetTextAlign(parse_canvas_text_align(canvas_arg_string(command, 0)?)?)
            }
            "setTextBaseline" => {
                Self::SetTextBaseline(parse_canvas_text_baseline(canvas_arg_string(command, 0)?)?)
            }
            "fillRect" => Self::FillRect(numbers(command)?),
            "strokeRect" => Self::StrokeRect(numbers(command)?),
            "clearRect" => Self::ClearRect(numbers(command)?),
            "beginPath" => Self::BeginPath,
            "closePath" => Self::ClosePath,
            "moveTo" => Self::MoveTo(numbers(command)?),
            "lineTo" => Self::LineTo(numbers(command)?),
            "quadraticCurveTo" => Self::QuadraticCurveTo(numbers(command)?),
            "bezierCurveTo" => Self::BezierCurveTo(numbers(command)?),
            "arcTo" => {
                let values = numbers(command)?;
                // Check the source number too: a negative subnormal must not
                // become an accepted negative zero during f32 conversion.
                if angle(command, 4)? < 0.0 {
                    return Err(RenderError::InvalidCanvas(
                        "canvas arcTo radius must be non-negative".into(),
                    ));
                }
                Self::PendingArcTo(values)
            }
            "arc" => {
                let center = [canvas_arg_f32(command, 0)?, canvas_arg_f32(command, 1)?];
                let radius = canvas_arg_f32(command, 2)?.abs();
                let start = angle(command, 3)?;
                let end = angle(command, 4)?;
                let anticlockwise = command
                    .args
                    .get(5)
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let (start, sweep) = normalize_arc(start, end, anticlockwise);
                Self::Arc {
                    center,
                    radius,
                    start,
                    sweep,
                }
            }
            "rect" => Self::Rect(numbers(command)?),
            "fill" => Self::Fill,
            "stroke" => Self::Stroke,
            "fillText" | "strokeText" => {
                let text = canvas_arg_string(command, 0)?;
                let position = [canvas_arg_f32(command, 1)?, canvas_arg_f32(command, 2)?];
                if command.op == "fillText" {
                    Self::FillText {
                        text: text.to_owned(),
                        position,
                    }
                } else {
                    Self::StrokeText {
                        text: text.to_owned(),
                        position,
                    }
                }
            }
            "save" => Self::Save,
            "restore" => Self::Restore,
            "translate" => Self::Translate(numbers(command)?),
            "rotate" => Self::Rotate(canvas_arg_f32(command, 0)?),
            "scale" => Self::Scale(numbers(command)?),
            "setTransform" => Self::SetTransform(numbers(command)?),
            "transform" => Self::Transform(numbers(command)?),
            "clip" => Self::Clip,
            _ => return Err(RenderError::UnsupportedCanvasCommand(command.op.clone())),
        })
    }
}

fn angle(command: &CanvasCommand, index: usize) -> Result<f64, RenderError> {
    command
        .args
        .get(index)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| {
            RenderError::InvalidCanvas(format!(
                "canvas command {} argument {index} must be finite",
                command.op
            ))
        })
}

/// Reduce in the source number domain before converting to either executor's
/// f32 coordinates. Repeated full-turn addition cannot make progress for large
/// floats, and subtracting opposite finite endpoints can itself overflow f64.
fn normalize_arc(start: f64, end: f64, anticlockwise: bool) -> (f32, f32) {
    let tau = std::f64::consts::TAU;
    let delta = end - start;
    let sweep = if !anticlockwise && delta >= tau {
        tau
    } else if anticlockwise && delta <= -tau {
        -tau
    } else {
        let remainder = if delta.is_finite() {
            delta % tau
        } else {
            // Both original operands are finite. Reduce each one before
            // subtraction when their opposite signs overflow the difference.
            ((end % tau) - (start % tau)) % tau
        };
        if !anticlockwise && remainder < 0.0 {
            remainder + tau
        } else if anticlockwise && remainder > 0.0 {
            remainder - tau
        } else {
            remainder
        }
    };
    // Signed remainder leaves ordinary negative starting angles unchanged.
    // Both outputs have magnitude <= one turn, so f32/degrees stay finite.
    let sweep = sweep as f32;
    ((start % tau) as f32, if sweep == 0.0 { 0.0 } else { sweep })
}

fn numbers<const N: usize>(command: &CanvasCommand) -> Result<[f32; N], RenderError> {
    let mut values = [0.0; N];
    for (index, value) in values.iter_mut().enumerate() {
        *value = canvas_arg_f32(command, index)?;
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(commands: &[(&str, Value)]) -> CanvasFrame {
        CanvasFrame {
            frame_id: 19,
            canvas_id: "prepared-test".into(),
            width: 8,
            height: 4,
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

    #[test]
    fn line_dash_rejects_native_scalar_and_cycle_overflow_before_backend_work() {
        for pattern in [json!([1e100, 1]), json!([f32::MAX, f32::MAX])] {
            assert!(matches!(
                PreparedCanvasBatch::prepare(&frame(&[("setLineDash", json!([pattern]))])),
                Err(RenderError::InvalidCanvas(_))
            ));
        }
        // An odd array is duplicated before validating its complete cycle.
        assert!(matches!(
            PreparedCanvasBatch::prepare(&frame(&[("setLineDash", json!([[f32::MAX]]))])),
            Err(RenderError::InvalidCanvas(_))
        ));
        let prepared =
            PreparedCanvasBatch::prepare(&frame(&[("setLineDash", json!([[1, 2, 3], -2]))]))
                .unwrap();
        assert_eq!(
            prepared.commands,
            vec![PreparedCanvasCommand::SetLineDash {
                pattern: vec![1.0, 2.0, 3.0, 1.0, 2.0, 3.0],
                offset: -2.0,
            }]
        );
    }

    #[test]
    fn line_dash_preserves_positive_native_intervals_and_normalizes_only_zero_cycles() {
        let prepared = PreparedCanvasBatch::prepare(&frame(&[
            ("setLineDash", json!([[0, 0]])),
            ("setLineDash", json!([[1e-8, 1e-8]])),
        ]))
        .unwrap();
        assert_eq!(
            prepared.commands,
            vec![
                PreparedCanvasCommand::SetLineDash {
                    pattern: vec![],
                    offset: 0.0,
                },
                PreparedCanvasCommand::SetLineDash {
                    pattern: vec![1e-8, 1e-8],
                    offset: 0.0,
                },
            ]
        );
    }

    #[test]
    fn late_invalid_command_rejects_the_whole_batch_without_executing_earlier_geometry() {
        let frame = frame(&[
            ("setFillStyle", json!(["red"])),
            ("fillRect", json!([0, 0, 8, 4])),
            // Opposite finite f64 endpoints overflow their difference. The
            // bounded preparation must still reach the later argument error.
            ("arc", json!([0, 0, 1, f64::MAX, -f64::MAX])),
            ("fillText", json!(["late failure", 0, "invalid"])),
        ]);
        let before = frame.clone();
        assert_eq!(
            PreparedCanvasBatch::prepare(&frame),
            Err(RenderError::InvalidCanvas(
                "canvas command fillText argument 2 must be finite".into()
            ))
        );
        assert_eq!(frame, before);
    }

    #[test]
    fn surface_layout_is_checked_before_command_validation() {
        let mut frame = frame(&[("unimplemented", json!([]))]);
        frame.width = u32::MAX;
        assert_eq!(
            PreparedCanvasBatch::prepare(&frame),
            Err(RenderError::PixelBufferOverflow)
        );
        frame.width = 8;
        assert_eq!(
            PreparedCanvasBatch::prepare(&frame),
            Err(RenderError::UnsupportedCanvasCommand(
                "unimplemented".into()
            ))
        );
    }

    #[cfg(target_pointer_width = "64")]
    #[test]
    fn large_surface_layout_stays_allocation_free_but_preparation_enforces_admission() {
        let mut frame = frame(&[("fillRect", json!([0, 0, 1, 1]))]);
        frame.width = 1 << 20;
        frame.height = 1 << 20;
        // Integer layout remains allocation-free even for four TiB. Preparing
        // an executable batch must still enforce the raster admission budget.
        assert_eq!(
            canvas_bounds(frame.width, frame.height),
            Ok((1 << 22, 1 << 42))
        );
        assert_eq!(
            PreparedCanvasBatch::prepare(&frame),
            Err(RenderError::InvalidCanvas(
                "canvas surface byte budget exceeded".into()
            ))
        );
        frame.width = 2048;
        frame.height = 2048;
        let prepared = PreparedCanvasBatch::prepare(&frame).unwrap();
        assert_eq!(prepared.frame_id, 19);
        assert_eq!(prepared.width, 2048);
        assert_eq!(prepared.height, 2048);
        assert_eq!(prepared.stride, 8192);
        assert_eq!(
            prepared.byte_len as u64,
            PreparedCanvasBatch::MAX_SURFACE_BYTES
        );
        assert_eq!(
            prepared.commands,
            vec![PreparedCanvasCommand::FillRect([0.0, 0.0, 1.0, 1.0])]
        );
    }

    #[test]
    fn normalized_styles_and_odd_zero_dash_patterns_match_software_replay() {
        let prepared = PreparedCanvasBatch::prepare(&frame(&[
            ("setFillStyle", json!(["#1234"])),
            ("setStrokeStyle", json!(["rgba(255,0,1,0.5)"])),
            ("setLineWidth", json!([-1])),
            ("setMiterLimit", json!([-2])),
            ("setGlobalAlpha", json!([4])),
            ("setGlobalAlpha", json!([-4])),
            ("setFontSize", json!([0])),
            ("setLineDash", json!([[1, 2, 3], -0.5])),
            ("setLineDash", json!([[0, 0, 0]])),
            ("setLineDash", json!([[]])),
            ("setLineCap", json!([" round "])),
            ("setLineJoin", json!([" bevel "])),
            ("setTextAlign", json!([" center "])),
            ("setTextBaseline", json!([" top "])),
        ]))
        .unwrap();
        assert_eq!(
            prepared.commands,
            vec![
                PreparedCanvasCommand::SetFillStyle(Color {
                    red: 17,
                    green: 34,
                    blue: 51,
                    alpha: 68,
                }),
                PreparedCanvasCommand::SetStrokeStyle(Color {
                    red: 255,
                    green: 0,
                    blue: 1,
                    alpha: 128,
                }),
                PreparedCanvasCommand::SetLineWidth(0.0),
                PreparedCanvasCommand::SetMiterLimit(0.0),
                PreparedCanvasCommand::SetGlobalAlpha(1.0),
                PreparedCanvasCommand::SetGlobalAlpha(0.0),
                PreparedCanvasCommand::SetFontSize(1.0),
                PreparedCanvasCommand::SetLineDash {
                    pattern: vec![1.0, 2.0, 3.0, 1.0, 2.0, 3.0],
                    offset: -0.5,
                },
                PreparedCanvasCommand::SetLineDash {
                    pattern: vec![],
                    offset: 0.0,
                },
                PreparedCanvasCommand::SetLineDash {
                    pattern: vec![],
                    offset: 0.0,
                },
                PreparedCanvasCommand::SetLineCap(CanvasLineCap::Round),
                PreparedCanvasCommand::SetLineJoin(CanvasLineJoin::Bevel),
                PreparedCanvasCommand::SetTextAlign(CanvasTextAlign::Center),
                PreparedCanvasCommand::SetTextBaseline(CanvasTextBaseline::Top),
            ]
        );
    }

    #[test]
    fn numeric_errors_and_dash_error_order_are_preserved() {
        let cases = [
            (
                "moveTo",
                json!([0]),
                "canvas command moveTo argument 1 must be finite",
            ),
            (
                "scale",
                json!([1e100, 1]),
                "canvas command scale argument 0 must be finite",
            ),
            (
                "setLineDash",
                json!([null, "bad offset"]),
                "canvas command setLineDash argument 0 must be an array",
            ),
            (
                "setLineDash",
                json!([[1, "bad segment"], "bad offset"]),
                "canvas command setLineDash argument 1 must be finite",
            ),
            (
                "setLineDash",
                json!([[1, -1], "bad offset"]),
                "canvas command setLineDash argument 1 must be finite and non-negative",
            ),
            (
                "setLineDash",
                json!([[1, 2], null]),
                "canvas command setLineDash argument 1 must be finite",
            ),
            (
                "fillText",
                json!([false, "bad x", "bad y"]),
                "canvas command fillText argument 0 must be a string",
            ),
        ];
        for (op, args, message) in cases {
            assert_eq!(
                PreparedCanvasBatch::prepare(&frame(&[(op, args)])),
                Err(RenderError::InvalidCanvas(message.into()))
            );
        }
    }

    #[test]
    fn arc_defaults_and_ignored_trailing_arguments_remain_compatible() {
        let prepared = PreparedCanvasBatch::prepare(&frame(&[
            ("arc", json!([1, 2, -3, 4, 5, "not a boolean", null])),
            ("arc", json!([1, 2, 3, 4, 5, true])),
            ("moveTo", json!([6, 7, "ignored"])),
            ("fillText", json!(["owned", 8, 9, false])),
            ("restore", json!(["ignored"])),
        ]))
        .unwrap();
        assert_eq!(
            prepared.commands,
            vec![
                PreparedCanvasCommand::Arc {
                    center: [1.0, 2.0],
                    radius: 3.0,
                    start: 4.0,
                    sweep: 1.0,
                },
                PreparedCanvasCommand::Arc {
                    center: [1.0, 2.0],
                    radius: 3.0,
                    start: 4.0,
                    sweep: (1.0 - std::f64::consts::TAU) as f32,
                },
                PreparedCanvasCommand::MoveTo([6.0, 7.0]),
                PreparedCanvasCommand::FillText {
                    text: "owned".into(),
                    position: [8.0, 9.0],
                },
                PreparedCanvasCommand::Restore,
            ]
        );
    }

    fn prepared_arc(start: f64, end: f64, anticlockwise: bool) -> (f32, f32) {
        let prepared = PreparedCanvasBatch::prepare(&frame(&[(
            "arc",
            json!([1, 2, 3, start, end, anticlockwise]),
        )]))
        .unwrap();
        match prepared.commands[0] {
            PreparedCanvasCommand::Arc { start, sweep, .. } => (start, sweep),
            _ => panic!("arc must prepare into a typed bounded arc"),
        }
    }

    #[test]
    fn arcs_keep_directional_full_turn_zero_and_reverse_multiple_turn_semantics() {
        let tau = std::f64::consts::TAU;
        let quarter = std::f64::consts::FRAC_PI_2;
        for (start, end, anticlockwise, expected) in [
            (0.0, 0.0, false, 0.0),
            (-0.0, 0.0, true, 0.0),
            (0.0, -0.0, false, 0.0),
            (0.0, tau, false, tau),
            (0.0, -tau, true, -tau),
            (0.0, -tau, false, 0.0),
            (0.0, tau, true, 0.0),
            (0.0, 4.0 * tau, false, tau),
            (0.0, -4.0 * tau, true, -tau),
            (0.0, -4.0 * tau, false, 0.0),
            (0.0, 4.0 * tau, true, 0.0),
            (0.0, -(4.0 * tau + quarter), false, tau - quarter),
            (0.0, 4.0 * tau + quarter, true, quarter - tau),
            (quarter, 2.0 * quarter, false, quarter),
            (quarter, 0.0, true, -quarter),
        ] {
            let (normalized_start, sweep) = prepared_arc(start, end, anticlockwise);
            assert_eq!(normalized_start, start as f32);
            assert_eq!(
                sweep, expected as f32,
                "arc {start} -> {end}, anticlockwise={anticlockwise}"
            );
            if sweep == 0.0 {
                assert!(!sweep.is_sign_negative(), "zero sweep is canonical +0");
            }
        }
    }

    #[test]
    fn all_finite_arc_angle_extremes_prepare_bounded_coordinates_and_degrees() {
        let tau = std::f32::consts::TAU;
        let large = [
            f64::MAX,
            -f64::MAX,
            1e100,
            -1e100,
            f64::from(f32::MAX),
            -f64::from(f32::MAX),
            1e-100,
            -1e-100,
        ];
        assert!(!(f64::MAX - -f64::MAX).is_finite());
        for start in large {
            for end in [start, -start, 0.0] {
                for anticlockwise in [false, true] {
                    let (start, sweep) = prepared_arc(start, end, anticlockwise);
                    assert!(start.is_finite() && start.abs() <= tau);
                    assert!(sweep.is_finite() && sweep.abs() <= tau);
                    assert!(start.to_degrees().is_finite());
                    assert!(sweep.to_degrees().is_finite());
                    assert!(if anticlockwise {
                        sweep <= 0.0
                    } else {
                        sweep >= 0.0
                    });
                }
            }
        }
        assert_eq!(prepared_arc(-f64::MAX, f64::MAX, false).1, tau);
        assert_eq!(prepared_arc(f64::MAX, -f64::MAX, true).1, -tau);
        assert_eq!(prepared_arc(f64::MAX, f64::MAX, false).1, 0.0);
        for end in [-f64::MIN_POSITIVE, -f64::from_bits(1)] {
            assert_eq!(prepared_arc(0.0, end, true).1.to_bits(), 0.0_f32.to_bits());
        }
    }

    #[test]
    fn arc_angle_range_expansion_does_not_widen_other_coordinates() {
        assert!(
            PreparedCanvasBatch::prepare(&frame(&[("arc", json!([0, 0, 1, 1e100, -1e100]))]))
                .is_ok()
        );
        for (args, index) in [
            (json!([1e100, 0, 1, 0, 1]), 0),
            (json!([0, 0, 1e100, 0, 1]), 2),
            (json!([0, 0, 1, "invalid", 1]), 3),
            (json!([0, 0, 1, 0, null]), 4),
        ] {
            assert_eq!(
                PreparedCanvasBatch::prepare(&frame(&[("arc", args)])),
                Err(RenderError::InvalidCanvas(format!(
                    "canvas command arc argument {index} must be finite"
                )))
            );
        }
    }
}
