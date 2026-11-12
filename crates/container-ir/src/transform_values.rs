//! Bounded transform syntax, before fonts, layout or cascade choose a value.
//! Percent translations remain relative to the eventual transformed border box.
use crate::text_values::{
    complete_function, css_numeric_token, css_whitespace, font_substitution, function_kind,
    numeric_value, top_level_arguments, NumericKind, NumericTextValue,
};
use crate::{WxssTextLength, WxssTextLengthUnit, WxssTextValueError};

const MAX_SOURCE_BYTES: usize = 64 * 1024;
const MAX_OPERATIONS: usize = 256;
const MAX_FUNCTION_DEPTH: usize = 64;

#[derive(Clone, Debug, PartialEq)]
pub enum WxssTransform {
    Initial,
    Inherit,
    Unset,
    None,
    List(Vec<WxssTransformOperation>),
    Unsupported(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum WxssTransformOperation {
    Matrix([f32; 6]),
    Translate {
        x: WxssTextLength,
        y: WxssTextLength,
    },
    Scale {
        x: f32,
        y: f32,
    },
    /// Radians, without folding or changing the authored operation order.
    Rotate(f32),
    Skew {
        x: f32,
        y: f32,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum WxssTransformOrigin {
    Initial,
    Inherit,
    Unset,
    Position {
        x: WxssTextLength,
        y: WxssTextLength,
    },
    Unsupported(String),
}

#[derive(Clone, Copy)]
enum Parsed<T> {
    Value(T),
    Unsupported,
}

impl<T: Copy> Parsed<T> {
    fn take(self, unsupported: &mut bool, fallback: T) -> T {
        match self {
            Self::Value(value) => value,
            Self::Unsupported => {
                *unsupported = true;
                fallback
            }
        }
    }
}

fn invalid(source: &str) -> WxssTextValueError {
    WxssTextValueError::Invalid(source.into())
}

fn source_value(source: &str) -> Result<&str, WxssTextValueError> {
    let source = source.trim_matches(css_whitespace);
    if source.is_empty() {
        return Err(WxssTextValueError::Empty);
    }
    if source.len() > MAX_SOURCE_BYTES {
        return Err(invalid(source));
    }
    Ok(source)
}

fn length(value: f32, unit: WxssTextLengthUnit) -> WxssTextLength {
    WxssTextLength { value, unit }
}

fn zero() -> WxssTextLength {
    length(0.0, WxssTextLengthUnit::Px)
}

// The token grammar is shared with typography; sign/range policy belongs to
// each transform argument. Representable syntax outside f32 stays unsupported
// instead of reviving an earlier declaration through overflow or underflow.
fn number_value(number: &str, divisor: f64) -> Parsed<f32> {
    let Ok(value) = number.parse::<f64>() else {
        return Parsed::Unsupported;
    };
    let value = value / divisor;
    let result = value as f32;
    let nonzero = number
        .split(['e', 'E'])
        .next()
        .unwrap_or(number)
        .bytes()
        .any(|byte| matches!(byte, b'1'..=b'9'));
    if !value.is_finite() || !result.is_finite() || (nonzero && result == 0.0) {
        Parsed::Unsupported
    } else {
        Parsed::Value(if result == 0.0 { 0.0 } else { result })
    }
}

fn number(source: &str, percentage: bool) -> Result<Parsed<f32>, WxssTextValueError> {
    if let Some(kind) = function_kind(source) {
        return if matches!(kind, NumericKind::Number | NumericKind::Deferred)
            || percentage && kind == NumericKind::Percent
        {
            Ok(Parsed::Unsupported)
        } else {
            Err(invalid(source))
        };
    }
    let (value, unit) = css_numeric_token(source).ok_or_else(|| invalid(source))?;
    match unit {
        "" => Ok(number_value(value, 1.0)),
        "%" if percentage => Ok(number_value(value, 100.0)),
        _ => Err(invalid(source)),
    }
}

fn signed_length(
    source: &str,
    percentage: bool,
) -> Result<Parsed<WxssTextLength>, WxssTextValueError> {
    if let Some(kind) = function_kind(source) {
        return if matches!(kind, NumericKind::Length | NumericKind::Deferred)
            || percentage && matches!(kind, NumericKind::Percent | NumericKind::LengthPercent)
        {
            Ok(Parsed::Unsupported)
        } else {
            Err(invalid(source))
        };
    }
    let (value, suffix) = css_numeric_token(source).ok_or_else(|| invalid(source))?;
    if suffix.is_empty() {
        return match number_value(value, 1.0) {
            Parsed::Value(0.0) => Ok(Parsed::Value(zero())),
            _ => Err(invalid(source)),
        };
    }
    let unit = match numeric_value(&format!("1{suffix}"))? {
        NumericTextValue::Length(length) => length.unit,
        NumericTextValue::Unsupported => return Ok(Parsed::Unsupported),
        NumericTextValue::Number(_) => return Err(invalid(source)),
    };
    if unit == WxssTextLengthUnit::Percent && !percentage {
        return Err(invalid(source));
    }
    Ok(match number_value(value, 1.0) {
        Parsed::Value(value) => Parsed::Value(length(value, unit)),
        Parsed::Unsupported => Parsed::Unsupported,
    })
}

fn angle(source: &str) -> Result<Parsed<f32>, WxssTextValueError> {
    if let Some(kind) = function_kind(source) {
        return if matches!(kind, NumericKind::Angle | NumericKind::Deferred) {
            Ok(Parsed::Unsupported)
        } else {
            Err(invalid(source))
        };
    }
    let (value, suffix) = css_numeric_token(source).ok_or_else(|| invalid(source))?;
    let divisor = match suffix.to_ascii_lowercase().as_str() {
        "rad" => 1.0,
        "deg" => 180.0 / std::f64::consts::PI,
        "grad" => 200.0 / std::f64::consts::PI,
        "turn" => 1.0 / std::f64::consts::TAU,
        "" => {
            return match number_value(value, 1.0) {
                Parsed::Value(0.0) => Ok(Parsed::Value(0.0)),
                _ => Err(invalid(source)),
            };
        }
        _ => return Err(invalid(source)),
    };
    Ok(number_value(value, divisor))
}

/// The complete-function helper validates delimiters/quotes; this scanner only
/// finds one outer token and bounds nesting before invoking shared math parsing.
fn function_end(source: &str) -> Option<usize> {
    let open = source.find('(')?;
    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in source[open..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(expected) = quote {
            if character == expected {
                quote = None;
            }
            continue;
        }
        match character {
            '\'' | '"' => quote = Some(character),
            '(' => {
                depth += 1;
                if depth > MAX_FUNCTION_DEPTH {
                    return None;
                }
            }
            ')' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(open + index + 1);
                }
            }
            _ => {}
        }
    }
    None
}

fn arguments(body: &str) -> Result<Vec<&str>, WxssTextValueError> {
    let values = top_level_arguments(body).ok_or_else(|| invalid(body))?;
    if values.iter().any(|value| value.is_empty()) {
        return Err(invalid(body));
    }
    Ok(values)
}

fn arity(values: &[&str], minimum: usize, maximum: usize) -> Result<bool, WxssTextValueError> {
    if (minimum..=maximum).contains(&values.len()) {
        return Ok(false);
    }
    // A substitution can expand one component into comma-separated arguments.
    // It cannot remove already-authored separators above the maximum arity.
    if values.len() < minimum
        && values
            .iter()
            .any(|value| font_substitution(value) == Some(true))
    {
        return Ok(true);
    }
    Err(invalid(&values.join(",")))
}

fn operation(name: &str, body: &str) -> Result<Option<WxssTransformOperation>, WxssTextValueError> {
    use WxssTransformOperation as Op;
    let values = arguments(body)?;
    let mut unsupported = false;
    let operation = match name {
        "matrix" | "matrix3d" => {
            let count = if name == "matrix" { 6 } else { 16 };
            unsupported |= arity(&values, count, count)?;
            let mut matrix = [0.0; 6];
            for (index, value) in values.iter().enumerate() {
                let value = number(value, false)?.take(&mut unsupported, 0.0);
                if index < 6 {
                    matrix[index] = value;
                }
            }
            unsupported |= name == "matrix3d";
            Op::Matrix(matrix)
        }
        "translate" | "translatex" | "translatey" | "translatez" | "translate3d" => {
            let (minimum, maximum) = match name {
                "translate" => (1, 2),
                "translate3d" => (3, 3),
                _ => (1, 1),
            };
            unsupported |= arity(&values, minimum, maximum)?;
            let mut lengths = [zero(); 3];
            for (index, value) in values.iter().enumerate() {
                let percentage = name != "translatez" && !(name == "translate3d" && index == 2);
                lengths[index] = signed_length(value, percentage)?.take(&mut unsupported, zero());
            }
            unsupported |= matches!(name, "translatez" | "translate3d");
            Op::Translate {
                x: if name == "translatey" {
                    zero()
                } else {
                    lengths[0]
                },
                y: if name == "translatey" {
                    lengths[0]
                } else {
                    lengths[1]
                },
            }
        }
        "scale" | "scalex" | "scaley" | "scalez" | "scale3d" => {
            let (minimum, maximum) = match name {
                "scale" => (1, 2),
                "scale3d" => (3, 3),
                _ => (1, 1),
            };
            unsupported |= arity(&values, minimum, maximum)?;
            let mut scales = [1.0; 3];
            for (index, value) in values.iter().enumerate() {
                scales[index] = number(value, !matches!(name, "scalez" | "scale3d"))?
                    .take(&mut unsupported, 1.0);
            }
            if name == "scale" && values.len() == 1 {
                scales[1] = scales[0];
            }
            unsupported |= matches!(name, "scalez" | "scale3d");
            Op::Scale {
                x: if name == "scaley" { 1.0 } else { scales[0] },
                y: if name == "scaley" {
                    scales[0]
                } else {
                    scales[1]
                },
            }
        }
        "rotate" | "rotatex" | "rotatey" | "rotatez" => {
            unsupported |= arity(&values, 1, 1)?;
            let radians = angle(values[0])?.take(&mut unsupported, 0.0);
            unsupported |= name != "rotate";
            Op::Rotate(radians)
        }
        "rotate3d" => {
            let deferred = arity(&values, 4, 4)?;
            for (index, value) in values.iter().enumerate() {
                if index == 3 {
                    angle(value)?;
                } else if deferred {
                    // Before substitution the final angle's index is unknown.
                    if number(value, false).is_err() && angle(value).is_err() {
                        return Err(invalid(value));
                    }
                } else {
                    number(value, false)?;
                }
            }
            return Ok(None);
        }
        "skew" | "skewx" | "skewy" => {
            unsupported |= arity(&values, 1, if name == "skew" { 2 } else { 1 })?;
            let x = angle(values[0])?.take(&mut unsupported, 0.0);
            let y = if let Some(value) = values.get(1) {
                angle(value)?.take(&mut unsupported, 0.0)
            } else {
                0.0
            };
            Op::Skew {
                x: if name == "skewy" { 0.0 } else { x },
                y: if name == "skewy" { x } else { y },
            }
        }
        "perspective" => {
            arity(&values, 1, 1)?;
            if !values[0].eq_ignore_ascii_case("none") {
                // A negative primitive is invalid even when its unit or
                // magnitude cannot be lowered. Do not let Unsupported hide
                // the syntax error and erase a valid earlier declaration.
                if let Some((number, _)) = css_numeric_token(values[0]) {
                    if number.starts_with('-')
                        && number
                            .split(['e', 'E'])
                            .next()
                            .unwrap_or(number)
                            .bytes()
                            .any(|byte| matches!(byte, b'1'..=b'9'))
                    {
                        return Err(invalid(values[0]));
                    }
                }
                if let Parsed::Value(value) = signed_length(values[0], false)? {
                    if value.value < 0.0 {
                        return Err(invalid(values[0]));
                    }
                }
            }
            return Ok(None);
        }
        _ => return Err(invalid(name)),
    };
    Ok((!unsupported).then_some(operation))
}

pub fn parse_wxss_transform(source: &str) -> Result<WxssTransform, WxssTextValueError> {
    let source = source_value(source)?;
    match source.to_ascii_lowercase().as_str() {
        "initial" => return Ok(WxssTransform::Initial),
        "inherit" => return Ok(WxssTransform::Inherit),
        "unset" => return Ok(WxssTransform::Unset),
        "none" => return Ok(WxssTransform::None),
        "revert" | "revert-layer" => return Ok(WxssTransform::Unsupported(source.into())),
        _ => {}
    }
    let mut remaining = source;
    let mut operations = Vec::new();
    let mut unsupported = false;
    let mut count = 0;
    while !remaining.is_empty() {
        count += 1;
        if count > MAX_OPERATIONS {
            return Err(invalid(source));
        }
        let end = function_end(remaining).ok_or_else(|| invalid(source))?;
        let token = &remaining[..end];
        let (name, body) = complete_function(token).ok_or_else(|| invalid(token))?;
        if font_substitution(token) == Some(true) {
            unsupported = true;
        } else if let Some(operation) = operation(&name.to_ascii_lowercase(), body)? {
            operations.push(operation);
        } else {
            unsupported = true;
        }
        remaining = remaining[end..].trim_start_matches(css_whitespace);
    }
    Ok(if unsupported {
        WxssTransform::Unsupported(source.into())
    } else {
        WxssTransform::List(operations)
    })
}

// Preserve whitespace inside deferred functions while splitting position axes.
fn position_tokens(source: &str) -> Result<Vec<&str>, WxssTextValueError> {
    let mut result = Vec::new();
    let mut remaining = source;
    while !remaining.is_empty() {
        let mut end = remaining.len();
        for (index, character) in remaining.char_indices() {
            if character == '(' {
                end = function_end(remaining).ok_or_else(|| invalid(source))?;
                break;
            }
            if css_whitespace(character) {
                end = index;
                break;
            }
        }
        let token = &remaining[..end];
        if token.is_empty() {
            return Err(invalid(source));
        }
        result.push(token);
        if result.len() > 3 {
            return Err(invalid(source));
        }
        let tail = &remaining[end..];
        if !tail.is_empty() && !tail.starts_with(css_whitespace) {
            return Err(invalid(source));
        }
        remaining = tail.trim_start_matches(css_whitespace);
    }
    Ok(result)
}

fn keyword(source: &str, horizontal: bool) -> Option<WxssTextLength> {
    let value = match source.to_ascii_lowercase().as_str() {
        "center" => 50.0,
        "left" if horizontal => 0.0,
        "right" if horizontal => 100.0,
        "top" if !horizontal => 0.0,
        "bottom" if !horizontal => 100.0,
        _ => return None,
    };
    Some(length(value, WxssTextLengthUnit::Percent))
}

fn position_axis(
    source: &str,
    horizontal: bool,
) -> Result<Parsed<WxssTextLength>, WxssTextValueError> {
    if let Some(value) = keyword(source, horizontal) {
        Ok(Parsed::Value(value))
    } else {
        signed_length(source, true)
    }
}

pub fn parse_wxss_transform_origin(
    source: &str,
) -> Result<WxssTransformOrigin, WxssTextValueError> {
    let source = source_value(source)?;
    match source.to_ascii_lowercase().as_str() {
        "initial" => return Ok(WxssTransformOrigin::Initial),
        "inherit" => return Ok(WxssTransformOrigin::Inherit),
        "unset" => return Ok(WxssTransformOrigin::Unset),
        "revert" | "revert-layer" => {
            return Ok(WxssTransformOrigin::Unsupported(source.into()));
        }
        _ => {}
    }
    // Apply the same nesting bound to substitutions and ordinary positions.
    let tokens = position_tokens(source)?;
    if font_substitution(source) == Some(true) {
        return Ok(WxssTransformOrigin::Unsupported(source.into()));
    }
    let mut unsupported = false;
    let (x, y) = match tokens.as_slice() {
        [one] => {
            if matches!(one.to_ascii_lowercase().as_str(), "top" | "bottom") {
                (
                    Parsed::Value(length(50.0, WxssTextLengthUnit::Percent)),
                    position_axis(one, false)?,
                )
            } else {
                (
                    position_axis(one, true)?,
                    Parsed::Value(length(50.0, WxssTextLengthUnit::Percent)),
                )
            }
        }
        [first, second] | [first, second, _] => {
            // Keyword axes may be reordered; numeric coordinates retain x/y
            // order. E.g. bottom left and center left are valid, top 2px is not.
            if keyword(first, false).is_some() && keyword(second, true).is_some() {
                (position_axis(second, true)?, position_axis(first, false)?)
            } else {
                (position_axis(first, true)?, position_axis(second, false)?)
            }
        }
        _ => return Err(invalid(source)),
    };
    let x = x.take(&mut unsupported, zero());
    let y = y.take(&mut unsupported, zero());
    if let Some(z) = tokens.get(2) {
        match signed_length(z, false)? {
            Parsed::Value(length) if length.value == 0.0 => {}
            _ => unsupported = true,
        }
    }
    Ok(if unsupported {
        WxssTransformOrigin::Unsupported(source.into())
    } else {
        WxssTransformOrigin::Position { x, y }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operations(source: &str) -> Vec<WxssTransformOperation> {
        let WxssTransform::List(operations) = parse_wxss_transform(source).unwrap() else {
            panic!("expected transform operations: {source}");
        };
        operations
    }

    fn origin(
        x: f32,
        x_unit: WxssTextLengthUnit,
        y: f32,
        y_unit: WxssTextLengthUnit,
    ) -> WxssTransformOrigin {
        WxssTransformOrigin::Position {
            x: length(x, x_unit),
            y: length(y, y_unit),
        }
    }

    #[test]
    fn ordered_operations_retain_signed_relative_lengths_and_matrix_values() {
        use WxssTextLengthUnit::{Em, Percent};
        use WxssTransformOperation::{Matrix, Scale, Translate};
        assert_eq!(
            operations("translate(-.5e2%, +2EM) matrix(1,0,0,1,-2e1,+3) scale(-2,25%)"),
            vec![
                Translate {
                    x: length(-50.0, Percent),
                    y: length(2.0, Em)
                },
                Matrix([1.0, 0.0, 0.0, 1.0, -20.0, 3.0]),
                Scale { x: -2.0, y: 0.25 },
            ],
        );
    }

    #[test]
    fn one_axis_functions_and_omitted_arguments_have_distinct_defaults() {
        use WxssTextLengthUnit::Px;
        use WxssTransformOperation::{Scale, Skew, Translate};
        assert_eq!(
            operations("translate(2px)translateX(-3px) translateY(4px) scale(2) scaleX(3) scaleY(4) skew(0) skewX(0) skewY(0)"),
            vec![
                Translate { x: length(2.0, Px), y: zero() },
                Translate { x: length(-3.0, Px), y: zero() },
                Translate { x: zero(), y: length(4.0, Px) },
                Scale { x: 2.0, y: 2.0 },
                Scale { x: 3.0, y: 1.0 },
                Scale { x: 1.0, y: 4.0 },
                Skew { x: 0.0, y: 0.0 },
                Skew { x: 0.0, y: 0.0 },
                Skew { x: 0.0, y: 0.0 },
            ],
        );
    }

    #[test]
    fn angle_units_are_radians_and_only_literal_unitless_zero_is_an_angle() {
        let pi = std::f32::consts::PI;
        for source in [
            "rotate(180deg)",
            "rotate(200grad)",
            "rotate(.5turn)",
            "rotate(3.141592653589793rad)",
        ] {
            let values = operations(source);
            let WxssTransformOperation::Rotate(angle) = values[0] else {
                panic!("{source}")
            };
            assert!((angle - pi).abs() <= f32::EPSILON, "{source}: {angle}");
        }
        assert_eq!(
            operations("rotate(-0)"),
            vec![WxssTransformOperation::Rotate(0.0)]
        );
        for source in [
            "rotate(1)",
            "rotate(1e-999)",
            "rotate(10%)",
            "rotate(calc(0))",
        ] {
            assert!(parse_wxss_transform(source).is_err(), "{source}");
        }
        let values = operations("skewX(45deg) skewY(-.25turn) skew(1rad,2rad)");
        assert_eq!(
            values[1],
            WxssTransformOperation::Skew {
                x: 0.0,
                y: -std::f32::consts::FRAC_PI_2
            }
        );
        assert_eq!(values[2], WxssTransformOperation::Skew { x: 1.0, y: 2.0 });
    }

    #[test]
    fn invalid_arguments_never_become_defaults_or_partial_operation_lists() {
        for source in [
            "",
            " ",
            "normal",
            "none scale(2)",
            "scale()",
            "scale(2,bad)",
            "scale(2,)",
            "scale(,2)",
            "scale(2,,3)",
            "scale(1,2,3)",
            "scale(2px)",
            "scale(1e)",
            "scale(NaN)",
            "scale(1.)",
            "scale(2 3)",
            "translate(1px 2px)",
            "translate(1 px)",
            "translate(2)",
            "translate(1bogus)",
            "translateX(1px,2px)",
            "translateX(bogus)",
            "rotate(1px)",
            "matrix(1,0,0,1,0)",
            "matrix(1,0,0,1,0,0,0)",
            "matrix(1px,0,0,1,0,0)",
            "scale(2",
            "scale(2))",
            "unknown(1)",
            "translate3d(1px,2px)",
            "translateZ(2%)",
            "translate3d(1px,2px,3%)",
            "scale3d(1,2)",
            "rotate3d(1,0,0,2px)",
            "perspective(-1px)",
            "perspective(-1ex)",
            "perspective(-1e999px)",
            "perspective(-1e-999px)",
            "perspective(1%)",
            "rotateX(1rad) scale(2,bad)",
            "translateX(var(--x)) mystery(1)",
            "matrix(var(--matrix),bad)",
            "var(not-custom)",
        ] {
            assert!(parse_wxss_transform(source).is_err(), "{source}");
        }
    }

    #[test]
    fn known_deferred_values_are_preserved_without_executing_them() {
        for source in [
            "revert",
            "revert-layer",
            "var(--transform)",
            "env(transform, none)",
            "translateX(var(--offset))",
            "translate(calc(50% - 2em),0)",
            "translateX(min(1px,2em))",
            "translateX(1ex)",
            "translateX(2cqw)",
            "scale(calc(1 + 2))",
            "scale(calc(50% * 2))",
            "rotate(calc(1turn / 2))",
            "matrix(var(--matrix))",
            "matrix(1,var(--rest))",
            "matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)",
            "translate3d(1px,2px,3px)",
            "translateZ(1px)",
            "scaleZ(1)",
            "scale3d(1,2,3)",
            "rotateX(1rad)",
            "rotateY(1rad)",
            "rotateZ(1rad)",
            "rotate3d(1,0,0,1rad)",
            "rotate3d(var(--axis),1rad)",
            "perspective(100px)",
            "perspective(none)",
            "perspective(-0ex)",
            "perspective(-0e999px)",
        ] {
            assert_eq!(
                parse_wxss_transform(source),
                Ok(WxssTransform::Unsupported(source.into())),
                "{source}"
            );
        }
        for source in [
            "translate(calc(1 + 2))",
            "translate(calc(1px + 1rad))",
            "scale(calc(1px))",
            "rotate(calc(1px))",
            "rotate(calc(1deg + 2))",
            "translateX(calc())",
            "translateX(var())",
            "translateX(round(1px))",
        ] {
            assert!(parse_wxss_transform(source).is_err(), "{source}");
        }
    }

    #[test]
    fn numeric_representation_limits_preserve_valid_winners_as_unsupported() {
        for source in [
            "scale(1e999)",
            "scale(-1e999)",
            "scale(1e-999)",
            "scale(1e-46%)",
            "translateX(1e999px)",
            "translateY(-1e-999%)",
            "rotate(1e999deg)",
            "matrix(1,0,0,1,1e999,0)",
        ] {
            assert_eq!(
                parse_wxss_transform(source),
                Ok(WxssTransform::Unsupported(source.into())),
                "{source}"
            );
        }
        assert_eq!(
            operations("scale(3e38)"),
            vec![WxssTransformOperation::Scale { x: 3e38, y: 3e38 }]
        );
        assert_eq!(
            operations("scale(-0e999)"),
            vec![WxssTransformOperation::Scale { x: 0.0, y: 0.0 }]
        );
    }

    #[test]
    fn origin_keywords_swap_axes_and_keep_numeric_coordinates_in_order() {
        use WxssTextLengthUnit::{Em, Percent, Px};
        for (source, expected) in [
            ("left", origin(0.0, Percent, 50.0, Percent)),
            ("top", origin(50.0, Percent, 0.0, Percent)),
            ("center", origin(50.0, Percent, 50.0, Percent)),
            ("bottom left", origin(0.0, Percent, 100.0, Percent)),
            ("center left", origin(0.0, Percent, 50.0, Percent)),
            ("top center", origin(50.0, Percent, 0.0, Percent)),
            ("right bottom", origin(100.0, Percent, 100.0, Percent)),
            ("-25% +2em", origin(-25.0, Percent, 2.0, Em)),
            ("10px", origin(10.0, Px, 50.0, Percent)),
            ("10px top", origin(10.0, Px, 0.0, Percent)),
            ("left 2px", origin(0.0, Percent, 2.0, Px)),
            ("center center -0px", origin(50.0, Percent, 50.0, Percent)),
            ("2em 50% 0", origin(2.0, Em, 50.0, Percent)),
        ] {
            assert_eq!(
                parse_wxss_transform_origin(source),
                Ok(expected),
                "{source}"
            );
        }
    }

    #[test]
    fn origin_rejects_invalid_axes_while_retaining_valid_unsupported_values() {
        for source in [
            "",
            "none",
            "left right",
            "top bottom",
            "top 2px",
            "2px left",
            "left center 10%",
            "left center bad",
            "left top 0 0",
            "10",
            "10px,20px",
            "calc(2) center",
            "left calc(1px + 1rad)",
            "left calc()",
        ] {
            assert!(parse_wxss_transform_origin(source).is_err(), "{source}");
        }
        for source in [
            "revert",
            "var(--origin)",
            "center center 1px",
            "center center calc(0px)",
            "calc(50% - 1em) bottom",
            "1ex center",
            "left 1cqh",
            "1e999px 0",
        ] {
            assert_eq!(
                parse_wxss_transform_origin(source),
                Ok(WxssTransformOrigin::Unsupported(source.into())),
                "{source}"
            );
        }
    }

    #[test]
    fn css_wide_keywords_remain_typed() {
        for (source, transform, origin) in [
            (
                "INITIAL",
                WxssTransform::Initial,
                WxssTransformOrigin::Initial,
            ),
            (
                "inherit",
                WxssTransform::Inherit,
                WxssTransformOrigin::Inherit,
            ),
            ("unset", WxssTransform::Unset, WxssTransformOrigin::Unset),
        ] {
            assert_eq!(parse_wxss_transform(source), Ok(transform));
            assert_eq!(parse_wxss_transform_origin(source), Ok(origin));
        }
        assert_eq!(parse_wxss_transform("\u{c}none\t"), Ok(WxssTransform::None));
    }

    #[test]
    fn grammar_work_is_bounded_before_deferred_evaluation() {
        assert!(parse_wxss_transform(&"scale(1)".repeat(MAX_OPERATIONS)).is_ok());
        assert!(parse_wxss_transform(&"scale(1)".repeat(MAX_OPERATIONS + 1)).is_err());
        let source = format!("var(--x,{})", "x".repeat(MAX_SOURCE_BYTES));
        assert!(parse_wxss_transform(&source).is_err());
        assert!(parse_wxss_transform_origin(&source).is_err());
        let source = format!(
            "var(--x,{}1{})",
            "calc(".repeat(MAX_FUNCTION_DEPTH),
            ")".repeat(MAX_FUNCTION_DEPTH)
        );
        assert!(parse_wxss_transform(&source).is_err());
        assert!(parse_wxss_transform_origin(&source).is_err());
    }

    #[test]
    fn invalid_later_or_important_declarations_do_not_erase_valid_cascade_values() {
        for (property, valid, invalid) in [
            ("transform", "translateX(25%)", "scale(2,bad)"),
            ("transform-origin", "bottom left", "left right"),
        ] {
            let ir = crate::parse_wxss(&format!(
                "view{{{property}:{valid}}} #hero{{{property}:{invalid} !important}}"
            ))
            .unwrap();
            let style = crate::resolve_wxss_style(&ir, Some("view"), Some("hero"), &[]);
            assert_eq!(style[property].value, valid);
            let inline = crate::parse_inline_wxss(&format!("{property}:{invalid} !important"));
            let node = crate::WxssSelectorNode {
                tag: Some("view".into()),
                id: Some("hero".into()),
                ..Default::default()
            };
            let style = crate::resolve_wxss_style_for_node_with_inline(&ir, &node, &[], &inline);
            assert_eq!(style[property].value, valid);
        }
    }

    #[test]
    fn valid_unsupported_values_remain_the_winning_declaration() {
        for (property, values) in [
            (
                "transform",
                &[
                    "translateZ(1px)",
                    "translateX(var(--offset))",
                    "scale(1e999)",
                ][..],
            ),
            (
                "transform-origin",
                &["center center 1px", "calc(50% - 1em) center", "1e999px 0"][..],
            ),
        ] {
            for value in values {
                let ir = crate::parse_wxss(&format!(
                    "view{{{property}:initial}} #hero{{{property}:{value} !important}}"
                ))
                .unwrap();
                let style = crate::resolve_wxss_style(&ir, Some("view"), Some("hero"), &[]);
                assert_eq!(style[property].value, *value, "{value}");
                assert!(style[property].important);
            }
        }
    }
}
