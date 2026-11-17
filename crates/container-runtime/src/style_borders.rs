//! Project independently cascaded WXSS border longhands into the shared frame.
//! Inherited/currentColor values are resolved after component tree projection,
//! so the three presenters consume colours and geometry from the same tree.

use super::{
    parse_render_color, parse_wxss_length, Color, LayoutStyle, Rect, RenderNode, WxssDeclaration,
};
use container_render_skia::{BorderSide, BorderStyle, BoxSizing};
use std::collections::BTreeMap;

const EDGES: [&str; 4] = ["top", "right", "bottom", "left"];

fn width(value: &str, viewport: Rect) -> Option<f32> {
    match value.trim().to_ascii_lowercase().as_str() {
        "thin" => Some(1.0),
        "medium" => Some(3.0),
        "thick" => Some(5.0),
        _ => parse_wxss_length(value)
            .ok()
            .and_then(|length| length.to_px(viewport.width, viewport.height, 16.0))
            .filter(|value| value.is_finite() && *value >= 0.0),
    }
}

fn border_style(value: &str) -> BorderStyle {
    match value.trim().to_ascii_lowercase().as_str() {
        "hidden" => BorderStyle::Hidden,
        "solid" => BorderStyle::Solid,
        "dashed" => BorderStyle::Dashed,
        "dotted" => BorderStyle::Dotted,
        "double" => BorderStyle::Double,
        "groove" => BorderStyle::Groove,
        "ridge" => BorderStyle::Ridge,
        "inset" => BorderStyle::Inset,
        "outset" => BorderStyle::Outset,
        _ => BorderStyle::None,
    }
}

pub(super) fn parse_borders(
    declarations: &BTreeMap<String, WxssDeclaration>,
    viewport: Rect,
) -> [BorderSide; 4] {
    std::array::from_fn(|index| {
        let get = |suffix: &str| declarations.get(&format!("border-{}-{suffix}", EDGES[index]));
        BorderSide {
            width: get("width")
                .and_then(|d| width(&d.value, viewport))
                .unwrap_or(3.0),
            style: get("style")
                .map(|d| border_style(&d.value))
                .unwrap_or(BorderStyle::None),
            color: get("color")
                .and_then(|d| parse_render_color(&d.value))
                .unwrap_or(Color::BLACK),
        }
    })
}

fn css_color(color: Color) -> String {
    if color.alpha == 255 {
        format!("rgb({}, {}, {})", color.red, color.green, color.blue)
    } else {
        format!(
            "rgba({}, {}, {}, {})",
            color.red,
            color.green,
            color.blue,
            f32::from(color.alpha) / 255.0
        )
    }
}

pub(super) fn resolve_inherited_borders(node: &mut RenderNode, parent: Option<LayoutStyle>) {
    let Some(style) = node.style.as_mut() else {
        return;
    };
    let foreground = node.foreground.unwrap_or(Color::BLACK);
    let mut computed = Vec::new();
    for (index, edge) in EDGES.into_iter().enumerate() {
        let color_key = format!("border-{edge}-color");
        let value = node
            .computed_style
            .get(&color_key)
            .map(|value| value.trim().to_ascii_lowercase());
        style.border[index].color = match value.as_deref() {
            Some("inherit") => parent.map(|p| p.border[index].color).unwrap_or(foreground),
            Some("currentcolor" | "initial" | "unset") | None => foreground,
            _ => style.border[index].color,
        };
        if value.is_some() {
            computed.push((color_key, css_color(style.border[index].color)));
        }
        let width_key = format!("border-{edge}-width");
        if node
            .computed_style
            .get(&width_key)
            .is_some_and(|value| value.eq_ignore_ascii_case("inherit"))
        {
            style.border[index].width = parent
                .map(|p| {
                    if matches!(
                        p.border[index].style,
                        BorderStyle::None | BorderStyle::Hidden
                    ) {
                        0.0
                    } else {
                        p.border[index].width
                    }
                })
                .unwrap_or(3.0);
        }
        let style_key = format!("border-{edge}-style");
        if node
            .computed_style
            .get(&style_key)
            .is_some_and(|value| value.eq_ignore_ascii_case("inherit"))
        {
            style.border[index].style = parent
                .map(|p| p.border[index].style)
                .unwrap_or(BorderStyle::None);
        }
        if node.computed_style.contains_key(&width_key) {
            let used = if matches!(
                style.border[index].style,
                BorderStyle::None | BorderStyle::Hidden
            ) {
                0.0
            } else {
                style.border[index].width
            };
            computed.push((width_key, format!("{used}px")));
        }
        if node.computed_style.contains_key(&style_key) {
            computed.push((
                style_key,
                format!("{:?}", style.border[index].style).to_ascii_lowercase(),
            ));
        }
    }
    if node
        .computed_style
        .get("box-sizing")
        .is_some_and(|value| value.eq_ignore_ascii_case("inherit"))
    {
        style.box_sizing = parent
            .map(|p| p.box_sizing)
            .unwrap_or(BoxSizing::ContentBox);
    }
    if node.computed_style.contains_key("box-sizing") {
        computed.push((
            "box-sizing".into(),
            match style.box_sizing {
                BoxSizing::ContentBox => "content-box",
                BoxSizing::BorderBox => "border-box",
            }
            .into(),
        ));
    }
    node.computed_style.extend(computed);
}
