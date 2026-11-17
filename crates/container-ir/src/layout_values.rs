//! Property-specific values for the portable block/flex formatting boundary.
//! Invalid declarations are discarded before the cascade. Recognized CSS
//! values outside the implemented layout subset survive as unsupported values.

use crate::{
    parse_wxss_font_size, parse_wxss_line_height, WxssDeclaration, WxssFontSize, WxssLineHeight,
    WxssTextLength, WxssTextValueError,
};

#[derive(Clone, Debug, PartialEq)]
pub enum WxssLayoutValue {
    Keyword(String),
    Length(WxssTextLength),
    Number(f32),
    Integer(i32),
    Unsupported(String),
}

fn invalid(value: &str) -> WxssTextValueError {
    WxssTextValueError::Invalid(value.into())
}

fn global(value: &str) -> bool {
    matches!(
        value,
        "initial" | "inherit" | "unset" | "revert" | "revert-layer"
    )
}

fn substitution(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    (lower.starts_with("var(") || lower.starts_with("env("))
        && matches!(
            parse_wxss_font_size(value),
            Ok(WxssFontSize::Unsupported(_))
        )
}

fn length(value: &str, negative: bool) -> Result<WxssLayoutValue, WxssTextValueError> {
    let (numeric, sign) = if negative && value.starts_with('-') {
        let rest = &value[1..];
        if !rest.starts_with(|c: char| c.is_ascii_digit() || c == '.') {
            return Err(invalid(value));
        }
        (rest, -1.0)
    } else {
        (value, 1.0)
    };
    match parse_wxss_font_size(numeric)? {
        WxssFontSize::Length(mut length) => {
            length.value *= sign;
            Ok(WxssLayoutValue::Length(length))
        }
        WxssFontSize::Unsupported(_)
            if numeric.contains('(')
                || numeric.starts_with(|c: char| c.is_ascii_digit() || matches!(c, '+' | '.')) =>
        {
            Ok(WxssLayoutValue::Unsupported(value.into()))
        }
        _ => Err(invalid(value)),
    }
}

fn number(value: &str) -> Result<WxssLayoutValue, WxssTextValueError> {
    match parse_wxss_line_height(value)? {
        WxssLineHeight::Number(number) => Ok(WxssLayoutValue::Number(number)),
        WxssLineHeight::Unsupported(_) if crate::text_values::number_function(value) => {
            Ok(WxssLayoutValue::Unsupported(value.into()))
        }
        _ => Err(invalid(value)),
    }
}

/// Parse a recognized longhand. Percentages retain their original unit until
/// the formatting engine knows the actual containing block and axis.
pub fn parse_wxss_layout_value(
    property: &str,
    source: &str,
) -> Result<WxssLayoutValue, WxssTextValueError> {
    let source = source.trim();
    if source.is_empty() {
        return Err(WxssTextValueError::Empty);
    }
    let value = source
        .split_ascii_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if global(&value) {
        return Ok(WxssLayoutValue::Keyword(value));
    }
    if substitution(source) {
        return Ok(WxssLayoutValue::Unsupported(source.into()));
    }
    let keyword = |allowed: &[&str]| {
        allowed
            .contains(&value.as_str())
            .then(|| WxssLayoutValue::Keyword(value.clone()))
            .ok_or_else(|| invalid(source))
    };
    match property {
        "width" | "height" | "min-width" | "min-height" | "max-width" | "max-height"
        | "flex-basis" => {
            if (value == "auto" && !property.starts_with("max-"))
                || (value == "none" && property.starts_with("max-"))
            {
                return Ok(WxssLayoutValue::Keyword(value));
            }
            if matches!(
                value.as_str(),
                "min-content" | "max-content" | "fit-content" | "stretch" | "contain"
            ) || (property == "flex-basis" && value == "content")
            {
                return Ok(WxssLayoutValue::Unsupported(source.into()));
            }
            if let Some(argument) = value
                .strip_prefix("fit-content(")
                .and_then(|v| v.strip_suffix(')'))
            {
                return match length(argument.trim(), false)? {
                    WxssLayoutValue::Length(_) | WxssLayoutValue::Unsupported(_) => {
                        Ok(WxssLayoutValue::Unsupported(source.into()))
                    }
                    _ => Err(invalid(source)),
                };
            }
            length(source, false)
        }
        "margin-top" | "margin-right" | "margin-bottom" | "margin-left" | "top" | "right"
        | "bottom" | "left" => {
            if value == "auto" {
                return Ok(WxssLayoutValue::Keyword(value));
            }
            length(source, true)
        }
        "padding-top" | "padding-right" | "padding-bottom" | "padding-left" => {
            length(source, false)
        }
        "row-gap" | "column-gap" => {
            if value == "normal" {
                return Ok(WxssLayoutValue::Keyword(value));
            }
            length(source, false)
        }
        "flex-grow" | "flex-shrink" => number(source),
        "display" => {
            let parts = value.split_ascii_whitespace().collect::<Vec<_>>();
            let outer = |v: &str| matches!(v, "block" | "inline" | "run-in");
            let inner =
                |v: &str| matches!(v, "flow" | "flow-root" | "table" | "flex" | "grid" | "ruby");
            if matches!(parts.as_slice(), [a,b] if (outer(a) && inner(b)) || (inner(a) && outer(b)))
            {
                // Multi-keyword display remains a recognized unsupported value
                // until inline formatting and display canonicalization exist.
                return Ok(WxssLayoutValue::Unsupported(source.into()));
            }
            keyword(&[
                "block",
                "flex",
                "none",
                "inline",
                "inline-block",
                "inline-flex",
                "grid",
                "inline-grid",
                "contents",
                "flow-root",
                "list-item",
                "table",
                "table-row",
                "table-cell",
                "table-row-group",
                "table-column",
                "table-column-group",
                "table-caption",
                "table-header-group",
                "table-footer-group",
                "ruby",
                "ruby-base",
                "ruby-text",
                "run-in",
            ])
        }
        "flex-direction" => keyword(&["row", "row-reverse", "column", "column-reverse"]),
        "flex-wrap" => keyword(&["nowrap", "wrap", "wrap-reverse"]),
        "position" => keyword(&["static", "relative", "absolute", "fixed", "sticky"]),
        "justify-content" => keyword(&[
            "normal",
            "start",
            "end",
            "flex-start",
            "flex-end",
            "center",
            "stretch",
            "space-between",
            "space-around",
            "space-evenly",
            "left",
            "right",
            "safe center",
            "unsafe center",
            "safe start",
            "unsafe start",
            "safe end",
            "unsafe end",
            "safe flex-start",
            "unsafe flex-start",
            "safe flex-end",
            "unsafe flex-end",
        ]),
        "align-items" | "align-self" => {
            if property == "align-self" && value == "auto" {
                return Ok(WxssLayoutValue::Keyword(value));
            }
            keyword(&[
                "normal",
                "start",
                "end",
                "flex-start",
                "flex-end",
                "self-start",
                "self-end",
                "center",
                "baseline",
                "first baseline",
                "last baseline",
                "stretch",
                "safe center",
                "unsafe center",
                "safe start",
                "unsafe start",
                "safe end",
                "unsafe end",
                "safe flex-start",
                "unsafe flex-start",
                "safe flex-end",
                "unsafe flex-end",
                "safe self-start",
                "unsafe self-start",
                "safe self-end",
                "unsafe self-end",
            ])
        }
        "align-content" => keyword(&[
            "normal",
            "start",
            "end",
            "flex-start",
            "flex-end",
            "center",
            "stretch",
            "space-between",
            "space-around",
            "space-evenly",
            "baseline",
            "first baseline",
            "last baseline",
            "safe center",
            "unsafe center",
            "safe start",
            "unsafe start",
            "safe end",
            "unsafe end",
        ]),
        "order" => {
            if crate::text_values::number_function(source) {
                return Ok(WxssLayoutValue::Unsupported(source.into()));
            }
            let digits = source.strip_prefix(['+', '-']).unwrap_or(source);
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid(source));
            }
            Ok(source
                .parse::<i32>()
                .map(WxssLayoutValue::Integer)
                .unwrap_or_else(|_| WxssLayoutValue::Unsupported(source.into())))
        }
        _ => Err(invalid(source)),
    }
}

fn tokens(value: &str) -> Option<Vec<&str>> {
    let mut output = Vec::new();
    let mut depth = 0usize;
    let mut start = None;
    for (index, ch) in value.char_indices() {
        match ch {
            '(' => depth = depth.checked_add(1)?,
            ')' => depth = depth.checked_sub(1)?,
            _ => {}
        }
        if ch.is_ascii_whitespace() && depth == 0 {
            if let Some(begin) = start.take() {
                output.push(&value[begin..index]);
            }
        } else {
            start.get_or_insert(index);
        }
    }
    if depth != 0 {
        return None;
    }
    if let Some(begin) = start {
        output.push(&value[begin..]);
    }
    Some(output)
}

fn expand_flex(value: &str) -> Option<[String; 3]> {
    let lower = value.trim().to_ascii_lowercase();
    if global(&lower) {
        return Some([lower.clone(), lower.clone(), lower]);
    }
    if substitution(value) {
        return Some([value.into(), value.into(), value.into()]);
    }
    if lower == "none" {
        return Some(["0".into(), "0".into(), "auto".into()]);
    }
    if lower == "auto" {
        return Some(["1".into(), "1".into(), "auto".into()]);
    }
    let values = tokens(value)?;
    if values.is_empty() || values.len() > 3 {
        return None;
    }
    if values.iter().any(|v| global(&v.to_ascii_lowercase())) {
        return None;
    }
    let mut numbers = Vec::new();
    let mut basis = None;
    let mut basis_after_factor = false;
    for token in values {
        let factor = number(token).ok();
        if matches!(
            factor,
            Some(WxssLayoutValue::Number(_) | WxssLayoutValue::Unsupported(_))
        ) {
            // The grow/shrink grammar is one contiguous group; a basis may
            // precede or follow it, but cannot split the two flex factors.
            if basis_after_factor {
                return None;
            }
            if numbers.len() == 2 {
                if factor != Some(WxssLayoutValue::Number(0.0)) || basis.is_some() {
                    return None;
                }
                basis = Some(token.to_owned());
            } else {
                numbers.push(token.to_owned());
            }
        } else {
            if basis.is_some() || parse_wxss_layout_value("flex-basis", token).is_err() {
                return None;
            }
            basis_after_factor = !numbers.is_empty();
            basis = Some(token.to_owned());
        }
    }
    let grow = numbers.first().cloned().unwrap_or_else(|| "1".into());
    let shrink = numbers.get(1).cloned().unwrap_or_else(|| "1".into());
    Some([grow, shrink, basis.unwrap_or_else(|| "0%".into())])
}

/// Return None for unrelated properties; Some(empty) for an invalid known
/// declaration. Expansion precedes importance, specificity and source order.
pub(crate) fn expand_layout_declaration(
    declaration: &WxssDeclaration,
) -> Option<Vec<WxssDeclaration>> {
    let name = declaration.property.as_str();
    let value = declaration.value.trim();
    let mut result = Vec::new();
    let mut add = |name: &str, value: &str| {
        result.push(WxssDeclaration {
            property: name.into(),
            value: value.into(),
            important: declaration.important,
        })
    };
    match name {
        "flex" => {
            let Some(values) = expand_flex(value) else {
                return Some(Vec::new());
            };
            for (name, value) in ["flex-grow", "flex-shrink", "flex-basis"]
                .into_iter()
                .zip(values)
            {
                add(name, &value);
            }
        }
        "flex-flow" => {
            let lower = value.to_ascii_lowercase();
            if global(&lower) {
                add("flex-direction", &lower);
                add("flex-wrap", &lower);
            } else {
                let Some(values) = tokens(value) else {
                    return Some(Vec::new());
                };
                if let Some(deferred) = values.iter().find(|v| substitution(v)) {
                    // Pending substitution can change the shorthand grammar.
                    // Retain an explicit unsupported longhand on both axes
                    // rather than silently dropping a syntactically deferred
                    // declaration or pretending its other tokens are final.
                    add("flex-direction", deferred);
                    add("flex-wrap", deferred);
                    result.push(declaration.clone());
                    return Some(result);
                }
                if values.is_empty() || values.len() > 2 {
                    return Some(Vec::new());
                }
                let mut direction = None;
                let mut wrap = None;
                for token in values {
                    let lower = token.to_ascii_lowercase();
                    if matches!(
                        lower.as_str(),
                        "row" | "row-reverse" | "column" | "column-reverse"
                    ) && direction.is_none()
                    {
                        direction = Some(lower);
                    } else if matches!(lower.as_str(), "nowrap" | "wrap" | "wrap-reverse")
                        && wrap.is_none()
                    {
                        wrap = Some(lower);
                    } else {
                        return Some(Vec::new());
                    }
                }
                add("flex-direction", direction.as_deref().unwrap_or("row"));
                add("flex-wrap", wrap.as_deref().unwrap_or("nowrap"));
            }
        }
        "gap" => {
            let Some(values) = tokens(value) else {
                return Some(Vec::new());
            };
            if values.len() != 1 && values.iter().any(|v| global(&v.to_ascii_lowercase())) {
                return Some(Vec::new());
            }
            let values = match values.as_slice() {
                [a] => [*a, *a],
                [a, b] => [*a, *b],
                _ => return Some(Vec::new()),
            };
            if values
                .iter()
                .any(|v| parse_wxss_layout_value("row-gap", v).is_err())
            {
                return Some(Vec::new());
            }
            add("row-gap", values[0]);
            add("column-gap", values[1]);
        }
        "margin" | "padding" | "inset" => {
            let Some(values) = tokens(value) else {
                return Some(Vec::new());
            };
            if values.len() != 1 && values.iter().any(|v| global(&v.to_ascii_lowercase())) {
                return Some(Vec::new());
            }
            let values = match values.as_slice() {
                [a] => [*a, *a, *a, *a],
                [a, b] => [*a, *b, *a, *b],
                [a, b, c] => [*a, *b, *c, *b],
                [a, b, c, d] => [*a, *b, *c, *d],
                _ => return Some(Vec::new()),
            };
            for (edge, value) in ["top", "right", "bottom", "left"].into_iter().zip(values) {
                let property = if name == "inset" {
                    edge.to_owned()
                } else {
                    format!("{name}-{edge}")
                };
                if parse_wxss_layout_value(&property, value).is_err() {
                    return Some(Vec::new());
                }
                add(&property, value);
            }
        }
        "width" | "height" | "min-width" | "min-height" | "max-width" | "max-height"
        | "flex-basis" | "margin-top" | "margin-right" | "margin-bottom" | "margin-left"
        | "padding-top" | "padding-right" | "padding-bottom" | "padding-left" | "top" | "right"
        | "bottom" | "left" | "row-gap" | "column-gap" | "flex-grow" | "flex-shrink"
        | "display" | "position" | "flex-direction" | "flex-wrap" | "justify-content"
        | "align-items" | "align-self" | "align-content" | "order" => {
            if parse_wxss_layout_value(name, value).is_err() {
                return Some(Vec::new());
            }
            add(name, value);
        }
        _ => return None,
    }
    // Keep shorthand inspection metadata without letting an invalid shorthand
    // partially override one of its longhands.
    if matches!(
        name,
        "flex" | "flex-flow" | "gap" | "margin" | "padding" | "inset"
    ) {
        result.push(declaration.clone());
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn property_specific_layout_grammar_does_not_treat_numbers_as_lengths() {
        for (property, value) in [
            ("width", "2"),
            ("height", "-1px"),
            ("flex-grow", "1px"),
            ("flex-shrink", "-1"),
            ("flex-wrap", "wrapping"),
            ("display", "potato"),
            ("align-items", "space-between"),
            ("order", "1.0"),
        ] {
            assert!(
                parse_wxss_layout_value(property, value).is_err(),
                "{property}:{value}"
            );
        }
        for (property, value) in [
            ("width", "25%"),
            ("height", "auto"),
            ("margin-left", "-2px"),
            ("margin-right", "auto"),
            ("padding-top", "2em"),
            ("column-gap", "normal"),
            ("order", "-2"),
        ] {
            assert!(
                parse_wxss_layout_value(property, value).is_ok(),
                "{property}:{value}"
            );
        }
    }

    #[test]
    fn flex_shorthand_resets_all_longhands_with_css_initial_defaults() {
        for (value, expected) in [
            ("1", ["1", "1", "0%"]),
            ("2 3", ["2", "3", "0%"]),
            ("20px", ["1", "1", "20px"]),
            ("2 20px", ["2", "1", "20px"]),
            ("20px 2 3", ["2", "3", "20px"]),
            ("2 3 0", ["2", "3", "0"]),
            ("calc(1 + 2)", ["calc(1 + 2)", "1", "0%"]),
            ("none", ["0", "0", "auto"]),
            ("auto", ["1", "1", "auto"]),
            ("initial", ["initial", "initial", "initial"]),
        ] {
            assert_eq!(
                expand_flex(value).unwrap(),
                expected.map(str::to_owned),
                "{value}"
            );
        }
        for value in [
            "-1",
            "1 -2",
            "1 2 3",
            "auto auto",
            "2px 3px",
            "1 2 3px 4",
            "1 20px 2",
            "1 inherit",
            "initial 2",
        ] {
            assert!(expand_flex(value).is_none(), "{value}");
        }
    }

    fn cascade(source: &str) -> std::collections::BTreeMap<String, WxssDeclaration> {
        let stylesheet = crate::parse_wxss(&format!(".card {{{source}}}")).unwrap();
        crate::resolve_wxss_style(&stylesheet, Some("view"), None, &["card"])
    }

    #[test]
    fn layout_validation_precedes_importance_specificity_and_source_order() {
        let style = cascade("width:40px; width:2!important; height:30px; height:-1px!important; flex-grow:2; flex-grow:2px!important; order:0; order:1.5!important");
        for (property, value) in [
            ("width", "40px"),
            ("height", "30px"),
            ("flex-grow", "2"),
            ("order", "0"),
        ] {
            assert_eq!(style[property].value, value);
            assert!(!style[property].important);
        }
        for (source, grow, shrink, basis) in [
            ("flex:1; flex-grow:3", "3", "1", "0%"),
            ("flex-grow:3; flex:1", "1", "1", "0%"),
            ("flex:1!important; flex-grow:3", "1", "1", "0%"),
            ("flex-basis:20px!important; flex:2", "2", "1", "20px"),
        ] {
            let style = cascade(source);
            for (property, value) in [
                ("flex-grow", grow),
                ("flex-shrink", shrink),
                ("flex-basis", basis),
            ] {
                assert_eq!(style[property].value, value, "{source}");
            }
        }
        let selector = crate::WxssSelectorNode {
            tag: Some("view".into()),
            id: Some("hero".into()),
            classes: vec!["card".into()],
            ..Default::default()
        };
        let ir = crate::parse_wxss("#hero {flex:2} .card {flex:3!important}").unwrap();
        let inline = crate::parse_inline_wxss("flex:4");
        let style = crate::resolve_wxss_style_for_node_with_inline(&ir, &selector, &[], &inline);
        assert_eq!(style["flex-grow"].value, "3");
        let inline = crate::parse_inline_wxss("flex:4!important");
        let style = crate::resolve_wxss_style_for_node_with_inline(&ir, &selector, &[], &inline);
        assert_eq!(style["flex-grow"].value, "4");
    }

    #[test]
    fn invalid_shorthands_never_partially_reset_longhands() {
        for invalid in [
            "margin:1px inherit",
            "margin:2px unset!important",
            "margin:1px 2px 3px 4px 5px",
            "margin:1px invalid",
        ] {
            let style = cascade(&format!("margin:5px 6px 7px 8px; {invalid}"));
            for (property, value) in [
                ("margin-top", "5px"),
                ("margin-right", "6px"),
                ("margin-bottom", "7px"),
                ("margin-left", "8px"),
            ] {
                assert_eq!(style[property].value, value, "{invalid}");
            }
        }
        for (valid, invalid, properties) in [
            (
                "gap:3px 4px",
                "gap:initial 2px!important",
                [("row-gap", "3px"), ("column-gap", "4px")],
            ),
            (
                "flex-flow:column wrap",
                "flex-flow:inherit wrap!important",
                [("flex-direction", "column"), ("flex-wrap", "wrap")],
            ),
            (
                "padding:3px 4px",
                "padding:5px -1px!important",
                [("padding-top", "3px"), ("padding-right", "4px")],
            ),
            (
                "inset:3px 4px",
                "inset:unset 1px!important",
                [("top", "3px"), ("left", "4px")],
            ),
            (
                "flex:2 3 20px",
                "flex:1 initial!important",
                [("flex-grow", "2"), ("flex-basis", "20px")],
            ),
        ] {
            let style = cascade(&format!("{valid};{invalid}"));
            for (property, value) in properties {
                assert_eq!(style[property].value, value, "{invalid}");
            }
        }
        let style = cascade("margin:-2px auto; padding:initial; gap:inherit; inset:unset");
        assert_eq!(style["margin-top"].value, "-2px");
        assert_eq!(style["margin-left"].value, "auto");
        assert_eq!(style["padding-bottom"].value, "initial");
        assert_eq!(style["column-gap"].value, "inherit");
        assert_eq!(style["bottom"].value, "unset");
    }

    #[test]
    fn recognized_unimplemented_values_survive_the_cascade() {
        for (property, value) in [
            ("width", "fit-content(10px)"),
            ("width", "min-content"),
            ("display", "inline flex"),
            ("display", "grid"),
            ("margin-left", "-2ch"),
            ("flex-grow", "calc(1 + 2)"),
            ("order", "99999999999999"),
        ] {
            assert!(
                parse_wxss_layout_value(property, value).is_ok(),
                "{property}:{value}"
            );
            let style = cascade(&format!("{property}:initial; {property}:{value}!important"));
            assert_eq!(style[property].value, value);
            assert!(style[property].important);
        }
        let style = cascade("flex-flow:column; flex-flow:row var(--wrap)!important");
        assert_eq!(style["flex-direction"].value, "var(--wrap)");
        assert_eq!(style["flex-wrap"].value, "var(--wrap)");
        for value in [
            "fit-content(auto)",
            "fit-content(-1px)",
            "fit-content(1px 2px)",
        ] {
            assert!(parse_wxss_layout_value("width", value).is_err());
        }
    }

    #[test]
    fn bounded_layout_grammar_matches_recorded_auxiliary_chrome_inputs() {
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/flex-grammar-chrome.json"))
                .unwrap();
        let cases = corpus["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 112);
        for case in cases {
            let property = case["property"].as_str().unwrap();
            let value = case["value"].as_str().unwrap();
            let declaration = WxssDeclaration {
                property: property.into(),
                value: value.into(),
                important: false,
            };
            let accepted = !expand_layout_declaration(&declaration)
                .expect("known layout property")
                .is_empty();
            assert_eq!(
                accepted,
                case["accepted"].as_bool().unwrap(),
                "{property}:{value}"
            );
        }
    }
}
