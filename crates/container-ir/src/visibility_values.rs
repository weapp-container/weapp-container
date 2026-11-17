//! Visibility is inherited, preserves layout and may be overridden by a
//! descendant. Valid unsupported values must remain winners in the cascade.
use crate::WxssTextValueError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxssVisibility {
    Visible,
    Hidden,
    Initial,
    Inherit,
    Unset,
    Unsupported(String),
}

// Substitution is checked before the property's final keyword grammar: an
// empty custom property can turn `var(--empty) visible` into `visible`.
// Keep the entire declaration until computed-value resolution is supported.
fn deferred_value(source: &str) -> bool {
    let mut delimiters = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut found = false;
    for (index, character) in source.char_indices() {
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
                let start = source[..index]
                    .char_indices()
                    .rev()
                    .take_while(|(_, ch)| ch.is_alphanumeric() || matches!(ch, '-' | '_'))
                    .last()
                    .map(|(at, _)| at)
                    .unwrap_or(index);
                let substitution = matches!(
                    source[start..index].to_ascii_lowercase().as_str(),
                    "var" | "env" | "attr"
                );
                delimiters.push((')', substitution.then_some((start, index + 1)), None));
            }
            '[' => delimiters.push((']', None, None)),
            '{' => delimiters.push(('}', None, None)),
            ',' => {
                if let Some((_, _, first_comma)) = delimiters.last_mut() {
                    first_comma.get_or_insert(index);
                }
            }
            ')' | ']' | '}' => {
                let Some((expected, substitution, first_comma)) = delimiters.pop() else {
                    return false;
                };
                if character != expected {
                    return false;
                }
                if let Some((start, body)) = substitution {
                    // Validate the substitution's first argument independently
                    // of its fallback component values. A fallback may contain
                    // nested blocks or punctuation and may never be selected.
                    let first = &source[body..first_comma.unwrap_or(index)];
                    let probe = format!("{}{})", &source[start..body], first);
                    if !crate::text_values::text_keyword_substitution(&probe) {
                        return false;
                    }
                    found = true;
                }
            }
            ';' | '!' if delimiters.is_empty() => return false,
            _ => {}
        }
    }
    found && delimiters.is_empty() && quote.is_none() && !escaped
}

pub fn parse_wxss_visibility(source: &str) -> Result<WxssVisibility, WxssTextValueError> {
    let source = source.trim_matches([' ', '\t', '\n', '\r', '\u{c}']);
    if source.is_empty() {
        return Err(WxssTextValueError::Empty);
    }
    Ok(match source.to_ascii_lowercase().as_str() {
        "visible" => WxssVisibility::Visible,
        "hidden" => WxssVisibility::Hidden,
        "initial" => WxssVisibility::Initial,
        "inherit" => WxssVisibility::Inherit,
        "unset" => WxssVisibility::Unset,
        "collapse" | "revert" | "revert-layer" => WxssVisibility::Unsupported(source.into()),
        _ if deferred_value(source) => WxssVisibility::Unsupported(source.into()),
        _ => return Err(WxssTextValueError::Invalid(source.into())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_keywords_invalid_and_unimplemented_values_keep_distinct_meanings() {
        for (source, value) in [
            (" VISIBLE ", WxssVisibility::Visible),
            ("hidden", WxssVisibility::Hidden),
            ("inherit", WxssVisibility::Inherit),
            ("initial", WxssVisibility::Initial),
            ("unset", WxssVisibility::Unset),
        ] {
            assert_eq!(parse_wxss_visibility(source), Ok(value));
        }
        for source in [
            "collapse",
            "revert",
            "revert-layer",
            "var(--visibility)",
            "env(visibility, hidden)",
            "var(--empty) visible",
            "visible var(--empty)",
            "var(--empty)visible",
            "var(--a) var(--b)",
            "hidden env(visibility,)",
            "var(--v, fn(!))",
            "var(--v, fn(;))",
            "var(--v, { hidden })",
            "var(--v, fn(!)) visible",
        ] {
            assert_eq!(
                parse_wxss_visibility(source),
                Ok(WxssVisibility::Unsupported(source.into()))
            );
        }
        for source in [
            "",
            " ",
            "none",
            "false",
            "0",
            "visible hidden",
            "calc(1)",
            "var()",
            "var(name)",
            "var(name) visible",
            "visible var()",
            "var(--empty) visible)",
            "var(--empty) ! visible",
            "var(--empty) ; visible",
            "var(--v, [})",
            "\"var(--empty) visible\"",
        ] {
            assert!(parse_wxss_visibility(source).is_err(), "{source}");
        }
    }
    #[test]
    fn visibility_invalid_declarations_are_discarded_but_collapse_and_deferred_winners_remain() {
        for value in [
            "collapse",
            "revert",
            "var(--visibility)",
            "var(--empty) visible",
            "hidden env(visibility,)",
            "var(--v, fn(!))",
            "var(--v, fn(;))",
            "var(--v, { hidden })",
            "var(--v, fn(!)) visible",
        ] {
            let ir = crate::parse_wxss(&format!(
                "view{{visibility:hidden}} #hero{{visibility:{value}!important}}"
            ))
            .unwrap();
            let resolved = crate::resolve_wxss_style(&ir, Some("view"), Some("hero"), &[]);
            assert_eq!(resolved["visibility"].value, value);
            assert!(resolved["visibility"].important);
        }
        let ir =
            crate::parse_wxss("view{visibility:hidden}#hero{visibility:none!important}").unwrap();
        assert_eq!(
            crate::resolve_wxss_style(&ir, Some("view"), Some("hero"), &[])["visibility"].value,
            "hidden"
        );
    }
}
