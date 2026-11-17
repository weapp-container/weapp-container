//! Preserve the distinction between automatic and explicit integer stacking.
//! Invalid declarations disappear before cascade; valid deferred or out-of-
//! range values remain explicit winners for the runtime to reject.

use crate::text_values::{
    complete_function, css_identifier, css_whitespace, font_substitution, function_kind,
    NumericKind,
};
use crate::WxssTextValueError;

const MAX_SOURCE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxssZIndex {
    Initial,
    Inherit,
    Unset,
    Auto,
    Integer(i32),
    /// Known CSS-wide/deferred syntax, or a valid integer outside i32 range.
    /// The original value is retained instead of clamping or selecting an
    /// earlier declaration. No deferred function is evaluated here.
    Unsupported(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxssIsolation {
    Initial,
    Inherit,
    Unset,
    Auto,
    Isolate,
    Unsupported(String),
}

/// Known valid effects that would establish a context or alter compositing,
/// but have no portable paint implementation. `None` is the property's initial
/// no-effect value (normal, none or auto), not an authored CSS spelling.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxssStackingEffect {
    Initial,
    Inherit,
    Unset,
    None,
    Unsupported(String),
}

pub fn parse_wxss_isolation(source: &str) -> Result<WxssIsolation, WxssTextValueError> {
    let source = bounded_source(source)?;
    Ok(match source.to_ascii_lowercase().as_str() {
        "initial" => WxssIsolation::Initial,
        "inherit" => WxssIsolation::Inherit,
        "unset" => WxssIsolation::Unset,
        "auto" => WxssIsolation::Auto,
        "isolate" => WxssIsolation::Isolate,
        "revert" | "revert-layer" => WxssIsolation::Unsupported(source.into()),
        _ if font_substitution(source) == Some(true) => WxssIsolation::Unsupported(source.into()),
        _ => return Err(WxssTextValueError::Invalid(source.into())),
    })
}

fn bounded_source(source: &str) -> Result<&str, WxssTextValueError> {
    let source = source.trim_matches(css_whitespace);
    if source.is_empty() {
        Err(WxssTextValueError::Empty)
    } else if source.len() > MAX_SOURCE_BYTES {
        Err(WxssTextValueError::Invalid(source.into()))
    } else {
        Ok(source)
    }
}

/// Validate only properties whose complete bounded grammar is known here.
/// Filter lists, masks and other effects intentionally require their own typed
/// parser rather than treating every non-initial token as supported syntax.
pub fn parse_wxss_stacking_effect(
    property: &str,
    source: &str,
) -> Result<WxssStackingEffect, WxssTextValueError> {
    if !matches!(
        property,
        "mix-blend-mode" | "contain" | "will-change" | "perspective"
    ) {
        return Err(WxssTextValueError::Invalid(source.into()));
    }
    let source = bounded_source(source)?;
    let value = source.to_ascii_lowercase();
    match value.as_str() {
        "initial" => return Ok(WxssStackingEffect::Initial),
        "inherit" => return Ok(WxssStackingEffect::Inherit),
        "unset" => return Ok(WxssStackingEffect::Unset),
        "revert" | "revert-layer" => return Ok(WxssStackingEffect::Unsupported(source.into())),
        _ => {}
    }
    if font_substitution(source) == Some(true) {
        return Ok(WxssStackingEffect::Unsupported(source.into()));
    }
    let initial = match property {
        "mix-blend-mode" => "normal",
        "will-change" => "auto",
        _ => "none",
    };
    if value == initial {
        return Ok(WxssStackingEffect::None);
    }
    let valid = match property {
        "mix-blend-mode" => matches!(
            value.as_str(),
            "multiply"
                | "screen"
                | "overlay"
                | "darken"
                | "lighten"
                | "color-dodge"
                | "color-burn"
                | "hard-light"
                | "soft-light"
                | "difference"
                | "exclusion"
                | "hue"
                | "saturation"
                | "color"
                | "luminosity"
                | "plus-darker"
                | "plus-lighter"
        ),
        "contain" => {
            if matches!(value.as_str(), "strict" | "content") {
                true
            } else {
                let parts = value
                    .split(css_whitespace)
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>();
                !parts.is_empty()
                    && parts.len() <= 4
                    && parts.iter().all(|part| {
                        matches!(*part, "size" | "inline-size" | "layout" | "style" | "paint")
                    })
                    && parts
                        .iter()
                        .enumerate()
                        .all(|(index, part)| !parts[..index].contains(part))
                    && !(parts.contains(&"size") && parts.contains(&"inline-size"))
            }
        }
        "will-change" => source.split(',').all(|part| {
            let part = part.trim_matches(css_whitespace);
            css_identifier(part)
                && !matches!(
                    part.to_ascii_lowercase().as_str(),
                    "auto"
                        | "none"
                        | "all"
                        | "will-change"
                        | "initial"
                        | "inherit"
                        | "unset"
                        | "revert"
                        | "revert-layer"
                        | "default"
                )
        }),
        "perspective" => {
            let function = format!("perspective({source})");
            complete_function(&function).is_some() && crate::parse_wxss_transform(&function).is_ok()
        }
        _ => unreachable!(),
    };
    if valid {
        Ok(WxssStackingEffect::Unsupported(source.into()))
    } else {
        Err(WxssTextValueError::Invalid(source.into()))
    }
}

pub fn parse_wxss_z_index(source: &str) -> Result<WxssZIndex, WxssTextValueError> {
    let source = source.trim_matches(css_whitespace);
    if source.is_empty() {
        return Err(WxssTextValueError::Empty);
    }
    if source.len() > MAX_SOURCE_BYTES {
        return Err(WxssTextValueError::Invalid(source.into()));
    }
    match source.to_ascii_lowercase().as_str() {
        "initial" => return Ok(WxssZIndex::Initial),
        "inherit" => return Ok(WxssZIndex::Inherit),
        "unset" => return Ok(WxssZIndex::Unset),
        "auto" => return Ok(WxssZIndex::Auto),
        "revert" | "revert-layer" => return Ok(WxssZIndex::Unsupported(source.into())),
        _ => {}
    }
    // Integer-valued CSS math is valid syntax, even when its eventual value
    // needs rounding. Length/percentage/angle math cannot be a z-index.
    if matches!(
        function_kind(source),
        Some(NumericKind::Number | NumericKind::Deferred)
    ) {
        return Ok(WxssZIndex::Unsupported(source.into()));
    }
    // CSS <integer> allows an adjacent sign and leading ASCII zeros. Decimal
    // points and exponents are <number> tokens, not integer literal syntax.
    let bytes = source.as_bytes();
    let start = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    if start == bytes.len() || !bytes[start..].iter().all(u8::is_ascii_digit) {
        return Err(WxssTextValueError::Invalid(source.into()));
    }
    Ok(match source.parse::<i32>() {
        Ok(value) => WxssZIndex::Integer(value),
        Err(_) => WxssZIndex::Unsupported(source.into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolation_keywords_and_deferred_values_are_typed_before_cascade() {
        for (source, value) in [
            ("auto", WxssIsolation::Auto),
            ("ISOLATE", WxssIsolation::Isolate),
            ("initial", WxssIsolation::Initial),
            ("inherit", WxssIsolation::Inherit),
            ("unset", WxssIsolation::Unset),
        ] {
            assert_eq!(parse_wxss_isolation(source), Ok(value));
        }
        for source in [
            "revert",
            "revert-layer",
            "var(--boundary)",
            "env(boundary, isolate)",
            "attr(data-boundary)",
        ] {
            assert_eq!(
                parse_wxss_isolation(source),
                Ok(WxssIsolation::Unsupported(source.into()))
            );
        }
        for source in [
            "",
            "none",
            "normal",
            "isolate auto",
            "0",
            "calc(1)",
            "var()",
            "var(boundary)",
        ] {
            assert!(parse_wxss_isolation(source).is_err(), "{source}");
        }
        let ir = crate::parse_wxss(
            "view{isolation:isolate;isolation:bad} #hero{isolation:bad !important}",
        )
        .unwrap();
        let node = crate::WxssSelectorNode {
            tag: Some("view".into()),
            id: Some("hero".into()),
            ..Default::default()
        };
        let inline = crate::parse_inline_wxss("isolation:calc(1) !important");
        let style = crate::resolve_wxss_style_for_node_with_inline(&ir, &node, &[], &inline);
        assert_eq!(style["isolation"].value, "isolate");
        let ir = crate::parse_wxss("view{isolation:isolate;isolation:var(--boundary) !important}")
            .unwrap();
        let style = crate::resolve_wxss_style(&ir, Some("view"), None, &[]);
        assert_eq!(style["isolation"].value, "var(--boundary)");
    }

    #[test]
    fn recognized_effects_preserve_valid_unsupported_but_discard_malformed_values() {
        for (property, initial, valid, invalid) in [
            ("mix-blend-mode", "normal", "multiply", "unknown"),
            ("contain", "none", "paint layout", "size inline-size"),
            (
                "will-change",
                "auto",
                "opacity, transform",
                "opacity transform",
            ),
            ("perspective", "none", "calc(100px + 1em)", "-1px"),
        ] {
            assert_eq!(
                parse_wxss_stacking_effect(property, initial),
                Ok(WxssStackingEffect::None)
            );
            assert_eq!(
                parse_wxss_stacking_effect(property, valid),
                Ok(WxssStackingEffect::Unsupported(valid.into()))
            );
            assert!(parse_wxss_stacking_effect(property, invalid).is_err());
            let ir = crate::parse_wxss(&format!("view{{{property}:{valid};{property}:{invalid}}} #hero{{{property}:{invalid} !important}}" )).unwrap();
            let style = crate::resolve_wxss_style(&ir, Some("view"), Some("hero"), &[]);
            assert_eq!(style[property].value, valid);
        }
        for source in [
            "",
            "paint paint",
            "paint none",
            "strict layout",
            "size inline-size",
            "foo",
        ] {
            assert!(
                parse_wxss_stacking_effect("contain", source).is_err(),
                "{source}"
            );
        }
        for source in [
            "",
            "auto, opacity",
            "opacity,",
            ",opacity",
            "none",
            "all",
            "inherit, opacity",
        ] {
            assert!(
                parse_wxss_stacking_effect("will-change", source).is_err(),
                "{source}"
            );
        }
        assert!(
            parse_wxss_stacking_effect("filter", "blur(2px)").is_err(),
            "filter syntax requires its own parser"
        );
        assert!(parse_wxss_stacking_effect("perspective", "1px) scale(2").is_err());
    }

    #[test]
    fn auto_integer_and_css_wide_keywords_remain_distinct() {
        for (source, expected) in [
            ("auto", WxssZIndex::Auto),
            ("AuTo", WxssZIndex::Auto),
            ("INITIAL", WxssZIndex::Initial),
            ("inherit", WxssZIndex::Inherit),
            ("unset", WxssZIndex::Unset),
            ("0", WxssZIndex::Integer(0)),
            ("-0", WxssZIndex::Integer(0)),
            ("+00", WxssZIndex::Integer(0)),
            ("+00012", WxssZIndex::Integer(12)),
            ("-0012", WxssZIndex::Integer(-12)),
            ("2147483647", WxssZIndex::Integer(i32::MAX)),
            ("-2147483648", WxssZIndex::Integer(i32::MIN)),
            ("\u{c}\t +0002147483647\r\n", WxssZIndex::Integer(i32::MAX)),
        ] {
            assert_eq!(parse_wxss_z_index(source), Ok(expected), "{source}");
        }
        assert_ne!(parse_wxss_z_index("auto"), parse_wxss_z_index("0"));
    }

    #[test]
    fn valid_unimplemented_values_preserve_the_authored_winner() {
        for source in [
            "revert",
            "revert-layer",
            "2147483648",
            "-2147483649",
            "+0002147483648",
            "99999999999999999999999999999999999999",
            "var(--layer)",
            "var(--layer, 0)",
            "env(layer, 2)",
            "attr(data-layer type(<integer>), 0)",
            "calc(1 + 2)",
            "calc(1.5)",
            "calc(1px / 1px)",
            "min(1, 2)",
            "max(1, 2)",
            "clamp(0, 2, 3)",
            "round(nearest, 1.5)",
            "calc(var(--layer) + 1)",
        ] {
            assert_eq!(
                parse_wxss_z_index(source),
                Ok(WxssZIndex::Unsupported(source.into())),
                "{source}"
            );
        }
    }

    #[test]
    fn malformed_values_and_noninteger_literal_tokens_are_invalid() {
        for source in [
            "",
            " ",
            "normal",
            "none",
            "1.0",
            ".5",
            "1.",
            "1e1",
            "1E+1",
            "0px",
            "0%",
            "+",
            "-",
            "+-1",
            "--1",
            "+ 1",
            "1 2",
            "auto 0",
            "0x1",
            "1_000",
            "NaN",
            "inf",
            "\u{2212}1",
            "\u{0661}",
            "\u{a0}1",
            "calc()",
            "calc(1 +)",
            "calc(1px)",
            "calc(10%)",
            "calc(1deg)",
            "calc(1px + 1)",
            "min(1, 2px)",
            "var()",
            "var(layer)",
            "var(--layer",
            "var(--layer) 1",
            "unknown(1)",
            "inherit initial",
        ] {
            assert!(parse_wxss_z_index(source).is_err(), "{source}");
        }
    }

    #[test]
    fn invalid_declarations_are_discarded_before_specificity_and_inline_cascade() {
        for invalid in ["1.0", "1e1", "calc(1px)", "var()", "nonsense"] {
            let ir = crate::parse_wxss(&format!(
                "view{{z-index:7;z-index:{invalid}}} #hero{{z-index:{invalid} !important}}"
            ))
            .unwrap();
            let style = crate::resolve_wxss_style(&ir, Some("view"), Some("hero"), &[]);
            assert_eq!(style["z-index"].value, "7", "{invalid}");
            let inline = crate::parse_inline_wxss(&format!("z-index:{invalid} !important"));
            let node = crate::WxssSelectorNode {
                tag: Some("view".into()),
                id: Some("hero".into()),
                ..Default::default()
            };
            let style = crate::resolve_wxss_style_for_node_with_inline(&ir, &node, &[], &inline);
            assert_eq!(style["z-index"].value, "7", "{invalid}");
        }
    }

    #[test]
    fn automatic_and_unsupported_values_survive_stylesheet_and_inline_cascade() {
        for value in [
            "auto",
            "2147483648",
            "-2147483649",
            "var(--layer)",
            "calc(1 + 2)",
            "revert-layer",
        ] {
            let ir = crate::parse_wxss(&format!(
                "view{{z-index:7}} #hero{{z-index:{value} !important}}"
            ))
            .unwrap();
            let style = crate::resolve_wxss_style(&ir, Some("view"), Some("hero"), &[]);
            assert_eq!(style["z-index"].value, value, "{value}");
            assert!(style["z-index"].important);
            let inline = crate::parse_inline_wxss(&format!("z-index:{value} !important"));
            let node = crate::WxssSelectorNode {
                tag: Some("view".into()),
                id: Some("hero".into()),
                ..Default::default()
            };
            let style = crate::resolve_wxss_style_for_node_with_inline(&ir, &node, &[], &inline);
            assert_eq!(style["z-index"].value, value, "{value}");
        }
    }

    #[test]
    fn deferred_work_has_the_existing_numeric_grammar_bounds() {
        let source = format!("var(--layer,{})", "0".repeat(MAX_SOURCE_BYTES));
        assert!(parse_wxss_z_index(&source).is_err());
        let source = format!("{}1{}", "calc(".repeat(65), ")".repeat(65));
        assert!(parse_wxss_z_index(&source).is_err());
    }
}
