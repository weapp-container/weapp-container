//! Opacity is a non-inherited group value. Invalid declarations must be
//! discarded before cascade comparison, not converted to opaque paint later.

use crate::WxssTextValueError;

#[derive(Clone, Debug, PartialEq)]
pub enum WxssOpacity {
    Initial,
    Inherit,
    Unset,
    Number(f32),
    Unsupported(String),
}

pub fn parse_wxss_opacity(source: &str) -> Result<WxssOpacity, WxssTextValueError> {
    let source = source.trim_matches([' ', '\t', '\n', '\r', '\u{c}']);
    if source.is_empty() {
        return Err(WxssTextValueError::Empty);
    }
    match source.to_ascii_lowercase().as_str() {
        "initial" => return Ok(WxssOpacity::Initial),
        "inherit" => return Ok(WxssOpacity::Inherit),
        "unset" => return Ok(WxssOpacity::Unset),
        "revert" | "revert-layer" => return Ok(WxssOpacity::Unsupported(source.into())),
        _ => {}
    }
    if crate::text_values::opacity_function(source) {
        return Ok(WxssOpacity::Unsupported(source.into()));
    }
    // Opacity clamps before storage. Font metrics deliberately reject f32
    // overflow/underflow, but those limits must not discard valid opacity
    // declarations or expose an earlier value in the cascade.
    let (number, divisor) = source
        .strip_suffix('%')
        .map_or((source, 1.0), |number| (number, 100.0));
    if !css_number(number) {
        return Err(WxssTextValueError::Invalid(source.into()));
    }
    let value = number
        .parse::<f64>()
        .map_err(|_| WxssTextValueError::Invalid(source.into()))?;
    let value = (value / divisor).clamp(0.0, 1.0) as f32;
    Ok(WxssOpacity::Number(if value == 0.0 { 0.0 } else { value }))
}

// CSS <number>: optional sign, integer/fraction, optional signed exponent.
// Full consumption rejects units, whitespace, NaN/inf and trailing dots.
fn css_number(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut index = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let integer = index;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    let has_integer = index != integer;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == fraction {
            return false;
        }
    } else if !has_integer {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let exponent = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == exponent {
            return false;
        }
    }
    index == bytes.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_percentages_and_css_wide_values_are_property_specific() {
        for (source, expected) in [
            (".5", 0.5),
            ("50%", 0.5),
            ("+5e1%", 0.5),
            ("1.5", 1.0),
            ("200%", 1.0),
            ("-1", 0.0),
            ("-50%", 0.0),
            ("-0", 0.0),
            ("1e39", 1.0),
            ("-1e39", 0.0),
            ("1e-46", 0.0),
            ("1e999", 1.0),
            ("-1e999", 0.0),
            ("1e-999", 0.0),
            ("1e999%", 1.0),
            ("\u{c} 0.25 ", 0.25),
        ] {
            assert_eq!(
                parse_wxss_opacity(source),
                Ok(WxssOpacity::Number(expected)),
                "{source}"
            );
        }
        assert_eq!(parse_wxss_opacity("INHERIT"), Ok(WxssOpacity::Inherit));
        assert_eq!(parse_wxss_opacity("initial"), Ok(WxssOpacity::Initial));
        assert_eq!(parse_wxss_opacity("unset"), Ok(WxssOpacity::Unset));
        for source in [
            "revert",
            "revert-layer",
            "calc(.2 + .3)",
            "calc(50%)",
            "calc(50% * 1)",
            "calc(50% / 2)",
            "calc(2 * 25%)",
            "var(--alpha)",
            "env(alpha, .5)",
        ] {
            assert_eq!(
                parse_wxss_opacity(source),
                Ok(WxssOpacity::Unsupported(source.into())),
                "{source}"
            );
        }
        for source in [
            "",
            " ",
            "normal",
            "auto",
            "NaN",
            "inf",
            "0px",
            "-1px",
            ".5 .8",
            "50 %",
            "1.",
            "1e",
            "calc()",
            "calc(1px)",
            "var()",
            "inherit initial",
            "--.5",
            "-+.5",
            "1e+",
            ".",
            "+",
            "-",
            "0x1",
            "1_000",
        ] {
            assert!(parse_wxss_opacity(source).is_err(), "{source}");
        }
    }

    #[test]
    fn valid_saturated_and_deferred_values_survive_the_cascade() {
        for value in [
            "1e39",
            "-1e39",
            "1e-46",
            "1e999",
            "1e-999",
            "1e999%",
            "calc(50% * 1)",
            "calc(50% / 2)",
            "calc(2 * 25%)",
        ] {
            let ir = crate::parse_wxss(&format!(
                "view{{opacity:.5}} #hero{{opacity:{value} !important}}"
            ))
            .unwrap();
            let style = crate::resolve_wxss_style(&ir, Some("view"), Some("hero"), &[]);
            assert_eq!(style["opacity"].value, value, "{value}");
            assert!(style["opacity"].important);
        }
    }
}
