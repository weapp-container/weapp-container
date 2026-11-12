//! Deterministic numeric 2D playback, independent of clocks and presentation.
//!
//! This is an explicit container policy, not a claim of complete WeChat parity:
//! aliases share axes, the last axis write in a group wins, untouched axes are
//! retained across steps, and composition is T * R * Scale * Skew. Origins
//! change discretely when a group's delay ends. Export/replay, ownership and
//! publication are the caller's responsibility. No sample mutates a timeline.

use container_bridge::{BridgeError, BridgeErrorCode};
use container_ir::{parse_wxss_transform_origin, WxssTransformOrigin};
use container_render_skia::Transform2D;
use serde_json::{Map, Value};
use std::{io, time::Duration};

pub(crate) const MAX_STEPS: usize = 4096;
pub(crate) const MAX_OPERATIONS: usize = 16_384;
pub(crate) const MAX_WIRE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_DURATION: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_ORIGIN_BYTES: usize = 4096;

fn invalid(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::InvalidRequest, message)
}

fn unsupported(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::UnsupportedCapability, message)
}

fn limited(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Render, message)
}

/// Canonical typed endpoints. `None` opacity means no baseline was supplied;
/// an opacity program requires the real resolved baseline instead of assuming 1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Values {
    pub(crate) opacity: Option<f64>,
    pub(crate) translate_x: f64,
    pub(crate) translate_y: f64,
    pub(crate) rotate_degrees: f64,
    pub(crate) scale_x: f64,
    pub(crate) scale_y: f64,
    pub(crate) skew_x_degrees: f64,
    pub(crate) skew_y_degrees: f64,
}

impl Default for Values {
    fn default() -> Self {
        Self {
            opacity: None,
            translate_x: 0.0,
            translate_y: 0.0,
            rotate_degrees: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            skew_x_degrees: 0.0,
            skew_y_degrees: 0.0,
        }
    }
}

impl Values {
    /// QR decomposition for T * R * Scale * Skew. A positive X scale and a
    /// signed Y scale carry reflections without inventing a rotation jump.
    /// Rank-one matrices retain their second column through X shear. When the
    /// first column is zero, the second column is aligned with the Y axis;
    /// the zero matrix has zero scales and zero angles. Ill-conditioned inputs
    /// that cannot be reconstructed at checked f32 precision are unsupported.
    pub(crate) fn from_affine(
        opacity: Option<f64>,
        matrix: Transform2D,
    ) -> Result<Self, BridgeError> {
        let [a, b, c, d, e, f] =
            [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map(f64::from);
        if ![a, b, c, d, e, f].into_iter().all(f64::is_finite) {
            return Err(invalid("animation baseline matrix must be finite"));
        }
        let mut values = Self {
            opacity,
            translate_x: e,
            translate_y: f,
            ..Self::default()
        };
        let scale_x = a.hypot(b);
        if scale_x != 0.0 {
            let cosine = a / scale_x;
            let sine = b / scale_x;
            let projection = cosine * c + sine * d;
            values.rotate_degrees = sine.atan2(cosine).to_degrees();
            values.scale_x = scale_x;
            values.scale_y = (a * d - b * c) / scale_x;
            values.skew_x_degrees = (projection / scale_x).atan().to_degrees();
        } else {
            let scale_y = c.hypot(d);
            values.scale_x = 0.0;
            values.scale_y = scale_y;
            if scale_y != 0.0 {
                values.rotate_degrees = (-c).atan2(d).to_degrees();
            }
        }
        values.validate()?;
        let rebuilt = values.affine()?;
        let norm = [a, b, c, d]
            .into_iter()
            .map(f64::abs)
            .fold(f64::from(f32::MIN_POSITIVE), f64::max);
        let tolerance = norm * 8.0 * f64::from(f32::EPSILON);
        if [matrix.a, matrix.b, matrix.c, matrix.d]
            .into_iter()
            .zip([rebuilt.a, rebuilt.b, rebuilt.c, rebuilt.d])
            .any(|(source, result)| (f64::from(source) - f64::from(result)).abs() > tolerance)
        {
            return Err(unsupported(
                "animation baseline is too ill-conditioned for numeric 2D decomposition",
            ));
        }
        Ok(values)
    }

    fn validate(self) -> Result<(), BridgeError> {
        if let Some(opacity) = self.opacity {
            if !opacity.is_finite() || !(0.0..=1.0).contains(&opacity) {
                return Err(invalid(
                    "animation baseline opacity must be between 0 and 1",
                ));
            }
        }
        for value in [
            self.translate_x,
            self.translate_y,
            self.rotate_degrees,
            self.scale_x,
            self.scale_y,
            self.skew_x_degrees,
            self.skew_y_degrees,
        ] {
            render_number(value)?;
        }
        Ok(())
    }

    /// Numeric endpoints are composed afresh; matrices are never interpolated.
    pub(crate) fn affine(self) -> Result<Transform2D, BridgeError> {
        self.validate()?;
        let (sine, cosine) = self.rotate_degrees.rem_euclid(360.0).to_radians().sin_cos();
        let skew_x = skew_tangent(self.skew_x_degrees)?;
        let skew_y = skew_tangent(self.skew_y_degrees)?;
        let a = cosine * self.scale_x - sine * self.scale_y * skew_y;
        let b = sine * self.scale_x + cosine * self.scale_y * skew_y;
        let c = cosine * self.scale_x * skew_x - sine * self.scale_y;
        let d = sine * self.scale_x * skew_x + cosine * self.scale_y;
        Ok(Transform2D {
            a: render_number(a)?,
            b: render_number(b)?,
            c: render_number(c)?,
            d: render_number(d)?,
            e: render_number(self.translate_x)?,
            f: render_number(self.translate_y)?,
        })
    }
}

fn render_number(value: f64) -> Result<f32, BridgeError> {
    let rounded = value as f32;
    if !value.is_finite() || !rounded.is_finite() || (value != 0.0 && rounded == 0.0) {
        return Err(unsupported(
            "animation value exceeds finite render precision",
        ));
    }
    Ok(if rounded == 0.0 { 0.0 } else { rounded })
}

fn skew_tangent(degrees: f64) -> Result<f64, BridgeError> {
    // Beyond this explicit policy bound, f64 remainder cannot reliably locate
    // a nearby odd-right-angle discontinuity. Never silently fold it away.
    if degrees.abs() > 1.0e12 {
        return Err(unsupported(
            "animation skew exceeds reliable angular precision",
        ));
    }
    let reduced = degrees.rem_euclid(180.0);
    if reduced == 90.0 {
        return Err(unsupported(
            "animation skew has a right-angle discontinuity",
        ));
    }
    let value = reduced.to_radians().tan();
    if !value.is_finite() {
        return Err(unsupported("animation skew is not finite"));
    }
    Ok(value)
}

#[derive(Clone, Copy, Debug)]
enum Easing {
    Linear,
    Bezier([f64; 4]),
    StepStart,
    StepEnd,
}

impl Easing {
    fn decode(value: &Value) -> Result<Self, BridgeError> {
        Ok(match value.as_str() {
            Some("linear") => Self::Linear,
            Some("ease") => Self::Bezier([0.25, 0.1, 0.25, 1.0]),
            Some("ease-in") => Self::Bezier([0.42, 0.0, 1.0, 1.0]),
            Some("ease-out") => Self::Bezier([0.0, 0.0, 0.58, 1.0]),
            Some("ease-in-out") => Self::Bezier([0.42, 0.0, 0.58, 1.0]),
            Some("step-start") => Self::StepStart,
            Some("step-end") => Self::StepEnd,
            _ => return Err(invalid("invalid animation timingFunction")),
        })
    }

    fn sample(self, progress: f64) -> f64 {
        if matches!(self, Self::StepStart) {
            return 1.0;
        }
        if progress <= 0.0 {
            return 0.0;
        }
        if progress >= 1.0 {
            return 1.0;
        }
        match self {
            Self::Linear => progress,
            Self::StepEnd => 0.0,
            Self::StepStart => 1.0,
            Self::Bezier([x1, y1, x2, y2]) => {
                // x(t) is monotonic for the four fixed CSS curves. Bisection
                // stays bounded even at the horizontal endpoint tangencies.
                let mut low = 0.0;
                let mut high = 1.0;
                for _ in 0..60 {
                    let time = (low + high) * 0.5;
                    if cubic(time, x1, x2) < progress {
                        low = time;
                    } else {
                        high = time;
                    }
                }
                cubic((low + high) * 0.5, y1, y2)
            }
        }
    }
}

fn cubic(time: f64, first: f64, second: f64) -> f64 {
    let remaining = 1.0 - time;
    3.0 * remaining * remaining * time * first
        + 3.0 * remaining * time * time * second
        + time * time * time
}

#[derive(Clone, Copy, Debug)]
enum Operation {
    Opacity(f64),
    TranslateX(f64),
    TranslateY(f64),
    Translate(f64, f64),
    Rotate(f64),
    ScaleX(f64),
    ScaleY(f64),
    Scale(f64, f64),
    SkewX(f64),
    SkewY(f64),
    Skew(f64, f64),
}

impl Operation {
    fn decode(value: &Value) -> Result<Self, BridgeError> {
        let object = object(value, &["type", "args"])?;
        let kind = object["type"]
            .as_str()
            .ok_or_else(|| invalid("animation operation type must be a string"))?;
        let count = match kind {
            "opacity" | "rotate" | "rotateZ" | "scaleX" | "scaleY" | "skewX" | "skewY"
            | "translateX" | "translateY" => 1,
            "scale" | "skew" | "translate" => 2,
            _ => return Err(unsupported("unsupported animation operation")),
        };
        let args = object["args"]
            .as_array()
            .filter(|args| args.len() == count)
            .ok_or_else(|| invalid("invalid animation operation argument count"))?;
        let argument = |index: usize| {
            let value = args[index]
                .as_f64()
                .ok_or_else(|| invalid("animation operation requires a finite number"))?;
            render_number(value)?;
            Ok::<_, BridgeError>(value)
        };
        let first = argument(0)?;
        Ok(match kind {
            "opacity" => {
                if !(0.0..=1.0).contains(&first) {
                    return Err(invalid("animation opacity must be between 0 and 1"));
                }
                Self::Opacity(first)
            }
            "rotate" | "rotateZ" => Self::Rotate(first),
            "scaleX" => Self::ScaleX(first),
            "scaleY" => Self::ScaleY(first),
            "scale" => Self::Scale(first, argument(1)?),
            "skewX" => Self::SkewX(first),
            "skewY" => Self::SkewY(first),
            "skew" => Self::Skew(first, argument(1)?),
            "translateX" => Self::TranslateX(first),
            "translateY" => Self::TranslateY(first),
            "translate" => Self::Translate(first, argument(1)?),
            _ => unreachable!("operation type checked before arguments"),
        })
    }

    fn apply(self, values: &mut Values, mask: &mut Mask) {
        match self {
            Self::Opacity(value) => values.opacity = Some(value),
            Self::Rotate(value) => values.rotate_degrees = value,
            Self::ScaleX(value) => values.scale_x = value,
            Self::ScaleY(value) => values.scale_y = value,
            Self::Scale(x, y) => {
                values.scale_x = x;
                values.scale_y = y;
            }
            Self::SkewX(value) => values.skew_x_degrees = value,
            Self::SkewY(value) => values.skew_y_degrees = value,
            Self::Skew(x, y) => {
                values.skew_x_degrees = x;
                values.skew_y_degrees = y;
            }
            Self::TranslateX(value) => values.translate_x = value,
            Self::TranslateY(value) => values.translate_y = value,
            Self::Translate(x, y) => {
                values.translate_x = x;
                values.translate_y = y;
            }
        }
        if matches!(self, Self::Opacity(_)) {
            mask.opacity = true;
        } else {
            mask.transform = true;
        }
    }
}

#[derive(Clone, Debug)]
struct Step {
    operations: Vec<Operation>,
    delay: Duration,
    duration: Duration,
    easing: Easing,
    origin: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Program {
    steps: Vec<Step>,
    duration: Duration,
}

impl Program {
    /// Decode the complete private producer schema before publishing a binding.
    /// Extra fields, unknown methods and unsupported origins reject the whole
    /// program. The decoder does not consume or change any previous program.
    pub(crate) fn decode(value: &Value) -> Result<Self, BridgeError> {
        let root = object(value, &["actions"])?;
        let actions = root["actions"]
            .as_array()
            .ok_or_else(|| invalid("animation actions must be an array"))?;
        if actions.len() > MAX_STEPS {
            return Err(limited("animation step budget exceeded"));
        }
        let mut steps = Vec::with_capacity(actions.len());
        let mut operation_count = 0_usize;
        let mut duration = Duration::ZERO;
        for action in actions {
            let action = object(action, &["animates", "option"])?;
            let animates = action["animates"]
                .as_array()
                .ok_or_else(|| invalid("animation animates must be an array"))?;
            operation_count = operation_count
                .checked_add(animates.len())
                .filter(|count| *count <= MAX_OPERATIONS)
                .ok_or_else(|| limited("animation operation budget exceeded"))?;
            let option = object(
                &action["option"],
                &["duration", "delay", "timingFunction", "transformOrigin"],
            )?;
            let step_duration = milliseconds(&option["duration"])?;
            let delay = milliseconds(&option["delay"])?;
            duration = duration
                .checked_add(delay)
                .and_then(|value| value.checked_add(step_duration))
                .filter(|value| *value <= MAX_DURATION)
                .ok_or_else(|| limited("animation total duration exceeds 24 hours"))?;
            let source = option["transformOrigin"]
                .as_str()
                .ok_or_else(|| invalid("animation transformOrigin must be a string"))?;
            if source.len() > MAX_ORIGIN_BYTES {
                return Err(limited("animation transformOrigin byte budget exceeded"));
            }
            let origin = match parse_wxss_transform_origin(source)
                .map_err(|_| invalid("invalid animation transformOrigin"))?
            {
                WxssTransformOrigin::Initial | WxssTransformOrigin::Unset => "50% 50% 0",
                WxssTransformOrigin::Position { .. } => source,
                WxssTransformOrigin::Inherit | WxssTransformOrigin::Unsupported(_) => {
                    return Err(unsupported("unsupported animation transformOrigin"));
                }
            };
            let operations = animates
                .iter()
                .map(Operation::decode)
                .collect::<Result<Vec<_>, _>>()?;
            steps.push(Step {
                operations,
                delay,
                duration: step_duration,
                easing: Easing::decode(&option["timingFunction"])?,
                origin: origin.into(),
            });
        }
        // Every accepted value has the shallow checked schema above. Counting
        // writes avoids allocating a second potentially large JSON buffer.
        serde_json::to_writer(WireBudget(MAX_WIRE_BYTES), value)
            .map_err(|_| limited("animation wire byte budget exceeded"))?;
        Ok(Self { steps, duration })
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }

    /// Query before resolving style baselines so an opacity-only program never
    /// needs to parse or decompose an unrelated CSS transform.
    pub(crate) fn uses_opacity(&self) -> bool {
        self.steps
            .iter()
            .flat_map(|step| &step.operations)
            .any(|operation| matches!(operation, Operation::Opacity(_)))
    }

    pub(crate) fn uses_transform(&self) -> bool {
        self.steps
            .iter()
            .flat_map(|step| &step.operations)
            .any(|operation| !matches!(operation, Operation::Opacity(_)))
    }

    pub(crate) fn bind(self, baseline: Values) -> Result<Timeline, BridgeError> {
        baseline.validate()?;
        baseline.affine()?;
        let mut values = baseline;
        let mut mask = Mask::default();
        let mut time = Duration::ZERO;
        let mut steps = Vec::with_capacity(self.steps.len());
        for step in self.steps {
            let from = values;
            let previous_mask = mask;
            for operation in step.operations {
                if matches!(operation, Operation::Opacity(_)) && from.opacity.is_none() {
                    return Err(invalid(
                        "opacity animation requires an explicit resolved baseline",
                    ));
                }
                operation.apply(&mut values, &mut mask);
            }
            values.affine()?;
            validate_skew_span(from.skew_x_degrees, values.skew_x_degrees)?;
            validate_skew_span(from.skew_y_degrees, values.skew_y_degrees)?;
            let start = time + step.delay;
            let end = start + step.duration;
            steps.push(BoundStep {
                start,
                end,
                from,
                target: values,
                previous_mask,
                mask,
                easing: step.easing,
                origin: step.origin,
            });
            time = end;
        }
        Ok(Timeline {
            steps,
            baseline,
            duration: self.duration,
        })
    }
}

fn object<'a>(value: &'a Value, names: &[&str]) -> Result<&'a Map<String, Value>, BridgeError> {
    value
        .as_object()
        .filter(|object| {
            object.len() == names.len() && names.iter().all(|name| object.contains_key(*name))
        })
        .ok_or_else(|| invalid("invalid animation object shape"))
}

fn milliseconds(value: &Value) -> Result<Duration, BridgeError> {
    let millis = value
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| invalid("animation time must be a finite nonnegative number"))?;
    if millis > MAX_DURATION.as_secs_f64() * 1000.0 {
        return Err(limited("animation time exceeds 24 hours"));
    }
    let duration = Duration::try_from_secs_f64(millis / 1000.0)
        .map_err(|_| invalid("animation time is not representable"))?;
    if millis != 0.0 && duration.is_zero() {
        return Err(unsupported("animation time is below nanosecond precision"));
    }
    Ok(duration)
}

struct WireBudget(usize);

impl io::Write for WireBudget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.0 {
            return Err(io::Error::other("animation wire byte budget exceeded"));
        }
        self.0 -= bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn validate_skew_span(from: f64, target: f64) -> Result<(), BridgeError> {
    skew_tangent(from)?;
    skew_tangent(target)?;
    let low = from.min(target);
    let high = from.max(target);
    let first_pole = ((low - 90.0) / 180.0).ceil() * 180.0 + 90.0;
    if first_pole >= low && first_pole <= high {
        return Err(unsupported(
            "animation skew interpolation crosses a right-angle discontinuity",
        ));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Default)]
struct Mask {
    opacity: bool,
    transform: bool,
}

#[derive(Clone, Debug)]
struct BoundStep {
    start: Duration,
    end: Duration,
    from: Values,
    target: Values,
    previous_mask: Mask,
    mask: Mask,
    easing: Easing,
    origin: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Timeline {
    steps: Vec<BoundStep>,
    baseline: Values,
    duration: Duration,
}

#[derive(Clone, Debug)]
pub(crate) struct Sample {
    pub(crate) values: Values,
    /// None until the first opacity group activates, and for untouched opacity.
    pub(crate) opacity: Option<f32>,
    /// None until a transform group activates; preserve normal base style then.
    pub(crate) transform: Option<Transform2D>,
    /// A parsed, supported source for normal font/viewport/border-box resolution.
    pub(crate) transform_origin: Option<String>,
    pub(crate) finished: bool,
}

impl Timeline {
    pub(crate) fn duration(&self) -> Duration {
        self.duration
    }

    pub(crate) fn sample(&self, elapsed: Duration) -> Result<Sample, BridgeError> {
        let mut values = self.baseline;
        let mut mask = Mask::default();
        let mut origin = None;
        for step in &self.steps {
            if elapsed < step.start {
                return sample(values, step.previous_mask, origin, false);
            }
            if step.mask.transform {
                origin = Some(step.origin.clone());
            }
            if elapsed >= step.end {
                values = step.target;
                mask = step.mask;
                continue;
            }
            let position =
                (elapsed - step.start).as_secs_f64() / (step.end - step.start).as_secs_f64();
            let progress = step.easing.sample(position);
            return sample(
                interpolate(step.from, step.target, progress),
                step.mask,
                origin,
                false,
            );
        }
        sample(values, mask, origin, true)
    }
}

fn interpolate(from: Values, target: Values, progress: f64) -> Values {
    let number = |from: f64, target: f64| {
        if progress == 0.0 {
            from
        } else if progress == 1.0 {
            target
        } else {
            // A difference-based lerp can overflow even for finite endpoints.
            (1.0 - progress) * from + progress * target
        }
    };
    Values {
        opacity: from.opacity.zip(target.opacity).map(|(a, b)| number(a, b)),
        translate_x: number(from.translate_x, target.translate_x),
        translate_y: number(from.translate_y, target.translate_y),
        rotate_degrees: number(from.rotate_degrees, target.rotate_degrees),
        scale_x: number(from.scale_x, target.scale_x),
        scale_y: number(from.scale_y, target.scale_y),
        skew_x_degrees: number(from.skew_x_degrees, target.skew_x_degrees),
        skew_y_degrees: number(from.skew_y_degrees, target.skew_y_degrees),
    }
}

fn sample(
    values: Values,
    mask: Mask,
    origin: Option<String>,
    finished: bool,
) -> Result<Sample, BridgeError> {
    values.validate()?;
    let opacity = if mask.opacity {
        Some(render_number(values.opacity.ok_or_else(|| {
            invalid("missing animation opacity baseline")
        })?)?)
    } else {
        None
    };
    Ok(Sample {
        values,
        opacity,
        transform: mask.transform.then(|| values.affine()).transpose()?,
        transform_origin: mask.transform.then_some(origin).flatten(),
        finished,
    })
}

#[cfg(test)]
#[path = "animation_timeline/tests.rs"]
mod tests;
