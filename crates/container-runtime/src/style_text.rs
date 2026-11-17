//! Compute inherited typography after WXML/component projection. Cascading
//! declarations, selector reads, line measurement and glyph drawing must all
//! refer to this one resolved style, including anonymous text leaves.

use super::{BridgeError, BridgeErrorCode, Rect, RenderNode};
use container_ir::{
    parse_wxss_font_size, parse_wxss_line_height, parse_wxss_text_align, parse_wxss_text_direction,
    parse_wxss_unicode_bidi, parse_wxss_white_space, parse_wxss_word_break, WxssFontSize,
    WxssLineHeight, WxssTextAlign, WxssTextDirection, WxssTextLength, WxssTextLengthUnit,
    WxssUnicodeBidi, WxssWhiteSpace, WxssWordBreak,
};
use container_render_skia::{
    LineHeight, TextAlign, TextFlowStyle, TextStyle, WhiteSpace, WordBreak,
};

// `page` is a virtual page box, not the HTML root element. Keep the existing
// portable CSS root of 16 logical pixels for rem across page declarations.
const ROOT_FONT_SIZE: f32 = 16.0;

fn unsupported(property: &str, value: &str) -> BridgeError {
    BridgeError::new(
        BridgeErrorCode::UnsupportedCapability,
        format!("unsupported WXSS {property}: {value}"),
    )
}

fn pixels(value: WxssTextLength, relative: f32, viewport: Rect) -> Result<f32, BridgeError> {
    use WxssTextLengthUnit::*;
    let multiplier = match value.unit {
        Px => 1.0,
        Rpx => f64::from(viewport.width) / 750.0,
        Rem => f64::from(ROOT_FONT_SIZE),
        Em => f64::from(relative),
        Percent => f64::from(relative) / 100.0,
        Vw => f64::from(viewport.width) / 100.0,
        Vh => f64::from(viewport.height) / 100.0,
        Vmin => f64::from(viewport.width.min(viewport.height)) / 100.0,
        Vmax => f64::from(viewport.width.max(viewport.height)) / 100.0,
        In => 96.0,
        Cm => 96.0 / 2.54,
        Mm => 96.0 / 25.4,
        Q => 96.0 / 101.6,
        Pt => 96.0 / 72.0,
        Pc => 16.0,
    };
    let result = (f64::from(value.value) * multiplier) as f32;
    if !result.is_finite() || result < 0.0 {
        return Err(BridgeError::new(
            BridgeErrorCode::Render,
            "WXSS text length exceeds the finite layout range",
        ));
    }
    Ok(result)
}

pub(super) fn resolve_tree(node: &mut RenderNode, viewport: Rect) -> Result<(), BridgeError> {
    resolve(node, TextStyle::default(), viewport)
}

fn resolve_flow(
    node: &mut RenderNode,
    inherited: Option<TextFlowStyle>,
) -> Result<TextFlowStyle, BridgeError> {
    let initial = TextFlowStyle {
        white_space: WhiteSpace::Normal,
        word_break: WordBreak::Normal,
        text_align: TextAlign::Start,
    };
    let inherited = inherited.unwrap_or(initial);
    // start/end currently have an explicit LTR contract. Accepting rtl or a
    // bidi isolation declaration while drawing LTR would fabricate support.
    if let Some(value) = node.computed_style.get("direction") {
        if let Ok(WxssTextDirection::Unsupported(value)) = parse_wxss_text_direction(value) {
            return Err(unsupported("direction", &value));
        }
        node.computed_style.insert("direction".into(), "ltr".into());
    }
    if let Some(value) = node.computed_style.get("unicode-bidi") {
        if let Ok(WxssUnicodeBidi::Unsupported(value)) = parse_wxss_unicode_bidi(value) {
            return Err(unsupported("unicode-bidi", &value));
        }
        node.computed_style
            .insert("unicode-bidi".into(), "normal".into());
    }
    let white_space = match node.computed_style.get("white-space") {
        Some(value) => match parse_wxss_white_space(value) {
            Ok(WxssWhiteSpace::Initial) => initial.white_space,
            Ok(WxssWhiteSpace::Inherit | WxssWhiteSpace::Unset) | Err(_) => inherited.white_space,
            Ok(WxssWhiteSpace::Normal) => WhiteSpace::Normal,
            Ok(WxssWhiteSpace::Nowrap) => WhiteSpace::Nowrap,
            Ok(WxssWhiteSpace::Pre) => WhiteSpace::Pre,
            Ok(WxssWhiteSpace::PreWrap) => WhiteSpace::PreWrap,
            Ok(WxssWhiteSpace::PreLine) => WhiteSpace::PreLine,
            Ok(WxssWhiteSpace::BreakSpaces) => WhiteSpace::BreakSpaces,
            Ok(WxssWhiteSpace::Unsupported(value)) => {
                return Err(unsupported("white-space", &value))
            }
        },
        None => inherited.white_space,
    };
    let word_break = match node.computed_style.get("word-break") {
        Some(value) => match parse_wxss_word_break(value) {
            Ok(WxssWordBreak::Initial) => initial.word_break,
            Ok(WxssWordBreak::Inherit | WxssWordBreak::Unset) | Err(_) => inherited.word_break,
            Ok(WxssWordBreak::Normal) => WordBreak::Normal,
            Ok(WxssWordBreak::BreakAll) => WordBreak::BreakAll,
            Ok(WxssWordBreak::KeepAll) => WordBreak::KeepAll,
            Ok(WxssWordBreak::Unsupported(value)) => return Err(unsupported("word-break", &value)),
        },
        None => inherited.word_break,
    };
    let text_align = match node.computed_style.get("text-align") {
        Some(value) => match parse_wxss_text_align(value) {
            Ok(WxssTextAlign::Initial) => initial.text_align,
            Ok(WxssTextAlign::Inherit | WxssTextAlign::Unset) | Err(_) => inherited.text_align,
            Ok(WxssTextAlign::Start) => TextAlign::Start,
            Ok(WxssTextAlign::End) => TextAlign::End,
            Ok(WxssTextAlign::Left) => TextAlign::Left,
            Ok(WxssTextAlign::Right) => TextAlign::Right,
            Ok(WxssTextAlign::Center) => TextAlign::Center,
            Ok(WxssTextAlign::Unsupported(value)) => return Err(unsupported("text-align", &value)),
        },
        None => inherited.text_align,
    };
    node.computed_style.insert(
        "white-space".into(),
        match white_space {
            WhiteSpace::Normal => "normal",
            WhiteSpace::Nowrap => "nowrap",
            WhiteSpace::Pre => "pre",
            WhiteSpace::PreWrap => "pre-wrap",
            WhiteSpace::PreLine => "pre-line",
            WhiteSpace::BreakSpaces => "break-spaces",
        }
        .into(),
    );
    node.computed_style.insert(
        "word-break".into(),
        match word_break {
            WordBreak::Normal => "normal",
            WordBreak::BreakAll => "break-all",
            WordBreak::KeepAll => "keep-all",
        }
        .into(),
    );
    node.computed_style.insert(
        "text-align".into(),
        match text_align {
            TextAlign::Start => "start",
            TextAlign::End => "end",
            TextAlign::Left => "left",
            TextAlign::Right => "right",
            TextAlign::Center => "center",
        }
        .into(),
    );
    Ok(TextFlowStyle {
        white_space,
        word_break,
        text_align,
    })
}

fn resolve(node: &mut RenderNode, inherited: TextStyle, viewport: Rect) -> Result<(), BridgeError> {
    if let Some(value) = node.computed_style.get("font") {
        return Err(unsupported("font shorthand", value));
    }
    let font_size = match node.computed_style.get("font-size") {
        Some(value) => match parse_wxss_font_size(value) {
            Ok(WxssFontSize::Initial) => ROOT_FONT_SIZE,
            Ok(WxssFontSize::Inherit | WxssFontSize::Unset) | Err(_) => inherited.font_size,
            Ok(WxssFontSize::Length(length)) => pixels(length, inherited.font_size, viewport)?,
            Ok(WxssFontSize::Unsupported(value)) => return Err(unsupported("font-size", &value)),
        },
        None => inherited.font_size,
    };
    let line_height = match node.computed_style.get("line-height") {
        Some(value) => match parse_wxss_line_height(value) {
            Ok(WxssLineHeight::Initial | WxssLineHeight::Normal) => LineHeight::Normal,
            Ok(WxssLineHeight::Inherit | WxssLineHeight::Unset) | Err(_) => inherited.line_height,
            Ok(WxssLineHeight::Number(number)) => LineHeight::Number(number),
            Ok(WxssLineHeight::Length(length)) => {
                LineHeight::Px(pixels(length, font_size, viewport)?)
            }
            Ok(WxssLineHeight::Unsupported(value)) => {
                return Err(unsupported("line-height", &value));
            }
        },
        None => inherited.line_height,
    };
    let style = TextStyle {
        font_size,
        line_height,
        flow: Some(resolve_flow(node, inherited.flow)?),
    };
    if !style.used_line_height().is_finite() {
        return Err(BridgeError::new(
            BridgeErrorCode::Render,
            "WXSS line-height exceeds the finite layout range",
        ));
    }
    node.text_style = Some(style);
    // CSS computed values resolve relative font sizes and length/percentage
    // line heights now; inherited numbers remain multipliers in TextStyle so
    // a child with another font size has its own used line height.
    node.computed_style
        .insert("font-size".into(), format!("{font_size}px"));
    node.computed_style.insert(
        "line-height".into(),
        match line_height {
            LineHeight::Normal => "normal".into(),
            _ => format!("{}px", style.used_line_height()),
        },
    );
    for child in &mut node.children {
        resolve(child, style, viewport)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewport() -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            width: 375.0,
            height: 600.0,
        }
    }

    fn node(id: &str, font: Option<&str>, line: Option<&str>) -> RenderNode {
        let mut node = RenderNode::new(id, viewport());
        for (name, value) in [("font-size", font), ("line-height", line)] {
            if let Some(value) = value {
                node.computed_style.insert(name.into(), value.into());
            }
        }
        node
    }

    #[test]
    fn inherited_font_and_number_line_height_reach_anonymous_leaves() {
        let mut root = node("page", Some("20px"), Some("1.5"));
        let mut child = node("label", Some("50%"), None);
        child
            .children
            .push(node("text", None, None).with_text("small"));
        root.children.push(child);
        resolve_tree(&mut root, viewport()).unwrap();
        let child = &root.children[0];
        assert_eq!(
            child.text_style,
            Some(TextStyle {
                font_size: 10.0,
                line_height: LineHeight::Number(1.5),
                flow: Some(TextFlowStyle {
                    white_space: WhiteSpace::Normal,
                    word_break: WordBreak::Normal,
                    text_align: TextAlign::Start,
                }),
            })
        );
        assert_eq!(child.children[0].text_style, child.text_style);
        assert_eq!(child.computed_style["font-size"], "10px");
        assert_eq!(child.computed_style["line-height"], "15px");
        assert_eq!(root.computed_style["line-height"], "30px");
    }

    #[test]
    fn percent_and_em_line_heights_inherit_computed_lengths() {
        for value in ["150%", "1.5em", "30px"] {
            let mut root = node("parent", Some("20px"), Some(value));
            root.children.push(node("child", Some("10px"), None));
            resolve_tree(&mut root, viewport()).unwrap();
            assert_eq!(root.text_style.unwrap().line_height, LineHeight::Px(30.0));
            assert_eq!(
                root.children[0].text_style.unwrap().line_height,
                LineHeight::Px(30.0)
            );
            assert_eq!(root.children[0].computed_style["line-height"], "30px");
        }
    }

    #[test]
    fn font_lengths_use_parent_font_root_and_logical_viewport() {
        for (value, expected) in [
            ("2em", 40.0),
            ("2rem", 32.0),
            ("40rpx", 20.0),
            ("10vw", 37.5),
            ("10vh", 60.0),
            ("10vmin", 37.5),
            ("10vmax", 60.0),
            ("12pt", 16.0),
            ("1pc", 16.0),
            ("2.54cm", 96.0),
            ("1in", 96.0),
        ] {
            let mut root = node("page", Some("20px"), None);
            root.children.push(node("child", Some(value), None));
            resolve_tree(&mut root, viewport()).unwrap();
            assert!(
                (root.children[0].text_style.unwrap().font_size - expected).abs() < 0.001,
                "{value}"
            );
        }
    }

    #[test]
    fn inherited_globals_and_zero_are_not_default_substitutions() {
        let mut root = node("page", Some("24px"), Some("2"));
        for value in ["inherit", "unset", "initial", "medium", "0"] {
            root.children
                .push(node(value, Some(value), Some("inherit")));
        }
        root.children.push(node("zero-line", None, Some("0")));
        resolve_tree(&mut root, viewport()).unwrap();
        assert_eq!(
            root.children
                .iter()
                .map(|n| n.text_style.unwrap().font_size)
                .collect::<Vec<_>>(),
            vec![24.0, 24.0, 16.0, 16.0, 0.0, 24.0]
        );
        assert_eq!(root.children[4].text_style.unwrap().used_line_height(), 0.0);
        assert_eq!(root.children[5].text_style.unwrap().used_line_height(), 0.0);
    }

    #[test]
    fn css_text_flow_inherits_through_anonymous_leaves_without_rewriting_source_text() {
        let original = "  A\t B\r\nC  ";
        let mut root = node("page", None, None);
        for (name, value) in [
            ("white-space", "PRE-WRAP"),
            ("word-break", "break-all"),
            ("text-align", "center"),
        ] {
            root.computed_style.insert(name.into(), value.into());
        }
        root.children
            .push(node("inherited", None, None).with_text(original));
        for value in ["inherit", "unset", "initial"] {
            let mut child = node(value, None, None);
            for name in ["white-space", "word-break", "text-align"] {
                child.computed_style.insert(name.into(), value.into());
            }
            root.children.push(child);
        }
        resolve_tree(&mut root, viewport()).unwrap();
        let expected = TextFlowStyle {
            white_space: WhiteSpace::PreWrap,
            word_break: WordBreak::BreakAll,
            text_align: TextAlign::Center,
        };
        for child in &root.children[..3] {
            assert_eq!(child.text_style.unwrap().flow, Some(expected));
            assert_eq!(child.computed_style["white-space"], "pre-wrap");
            assert_eq!(child.computed_style["word-break"], "break-all");
            assert_eq!(child.computed_style["text-align"], "center");
        }
        assert_eq!(root.children[0].text.as_deref(), Some(original));
        assert_eq!(
            root.children[3].text_style.unwrap().flow,
            Some(TextFlowStyle {
                white_space: WhiteSpace::Normal,
                word_break: WordBreak::Normal,
                text_align: TextAlign::Start,
            })
        );
        assert_eq!(root.computed_style["white-space"], "pre-wrap");
        assert!(root.background.is_none());
    }

    #[test]
    fn each_supported_text_flow_keyword_reaches_the_shared_typed_style() {
        for (value, expected) in [
            ("normal", WhiteSpace::Normal),
            ("nowrap", WhiteSpace::Nowrap),
            ("pre", WhiteSpace::Pre),
            ("pre-wrap", WhiteSpace::PreWrap),
            ("pre-line", WhiteSpace::PreLine),
            ("break-spaces", WhiteSpace::BreakSpaces),
        ] {
            let mut root = node("page", None, None);
            root.computed_style
                .insert("white-space".into(), value.into());
            resolve_tree(&mut root, viewport()).unwrap();
            assert_eq!(root.text_style.unwrap().flow.unwrap().white_space, expected);
            assert_eq!(root.computed_style["white-space"], value);
        }
        for (value, expected) in [
            ("normal", WordBreak::Normal),
            ("break-all", WordBreak::BreakAll),
            ("keep-all", WordBreak::KeepAll),
        ] {
            let mut root = node("page", None, None);
            root.computed_style
                .insert("word-break".into(), value.into());
            resolve_tree(&mut root, viewport()).unwrap();
            assert_eq!(root.text_style.unwrap().flow.unwrap().word_break, expected);
            assert_eq!(root.computed_style["word-break"], value);
        }
        for (value, expected) in [
            ("start", TextAlign::Start),
            ("end", TextAlign::End),
            ("left", TextAlign::Left),
            ("right", TextAlign::Right),
            ("center", TextAlign::Center),
        ] {
            let mut root = node("page", None, None);
            root.computed_style
                .insert("text-align".into(), value.into());
            resolve_tree(&mut root, viewport()).unwrap();
            assert_eq!(root.text_style.unwrap().flow.unwrap().text_align, expected);
            assert_eq!(root.computed_style["text-align"], value);
        }
    }

    #[test]
    fn unimplemented_flow_and_bidi_fail_explicitly_instead_of_using_pseudo_defaults() {
        for (property, value) in [
            ("white-space", "preserve nowrap"),
            ("white-space", "revert"),
            ("word-break", "break-word"),
            ("word-break", "auto-phrase"),
            ("text-align", "justify"),
            ("text-align", "match-parent"),
            ("direction", "rtl"),
            ("unicode-bidi", "isolate"),
            ("white-space", "var(--space, pre)"),
            ("word-break", "env(preferred-break, normal)"),
            ("text-align", "attr(data-align)"),
            ("direction", "var(--direction)"),
            ("unicode-bidi", "revert-layer"),
        ] {
            let mut root = node("page", None, None);
            root.computed_style.insert(property.into(), value.into());
            let error = resolve_tree(&mut root, viewport()).unwrap_err();
            assert_eq!(
                error.code,
                BridgeErrorCode::UnsupportedCapability,
                "{property}:{value}"
            );
            assert!(error.message.contains(property), "{error:?}");
        }
        for value in ["ltr", "initial", "inherit", "unset"] {
            let mut root = node("page", None, None);
            root.computed_style.insert("direction".into(), value.into());
            resolve_tree(&mut root, viewport()).unwrap();
            assert_eq!(root.computed_style["direction"], "ltr");
        }
        for value in ["normal", "initial", "inherit", "unset"] {
            let mut root = node("page", None, None);
            root.computed_style
                .insert("unicode-bidi".into(), value.into());
            resolve_tree(&mut root, viewport()).unwrap();
            assert_eq!(root.computed_style["unicode-bidi"], "normal");
        }
    }

    #[test]
    fn valid_unimplemented_values_fail_explicitly_and_overflow_is_not_committed() {
        for (font, line) in [
            (Some("calc(10px + 1px)"), None),
            (None, Some("var(--height)")),
        ] {
            let mut root = node("page", font, line);
            let error = resolve_tree(&mut root, viewport()).unwrap_err();
            assert_eq!(error.code, BridgeErrorCode::UnsupportedCapability);
        }
        let mut root = node("page", Some("3e38px"), Some("2"));
        assert_eq!(
            resolve_tree(&mut root, viewport()).unwrap_err().code,
            BridgeErrorCode::Render
        );
    }
}
