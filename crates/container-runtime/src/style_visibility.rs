//! Resolve CSS visibility once after projection. Paint, input and later
//! accepted-frame observers consume the same value without removing layout.
use super::{BridgeError, BridgeErrorCode, RenderNode};
use container_ir::{parse_wxss_visibility, WxssVisibility};
use container_render_skia::Visibility;

pub(super) fn resolve_tree(node: &mut RenderNode) -> Result<(), BridgeError> {
    resolve(node, Visibility::Visible)
}

fn resolve(node: &mut RenderNode, inherited: Visibility) -> Result<(), BridgeError> {
    let value = match node.computed_style.get("visibility") {
        None => inherited,
        Some(source) => match parse_wxss_visibility(source) {
            Ok(WxssVisibility::Visible | WxssVisibility::Initial) => Visibility::Visible,
            Ok(WxssVisibility::Hidden) => Visibility::Hidden,
            Ok(WxssVisibility::Inherit | WxssVisibility::Unset) | Err(_) => inherited,
            Ok(WxssVisibility::Unsupported(_)) => {
                return Err(BridgeError::new(
                    BridgeErrorCode::UnsupportedCapability,
                    format!("unsupported WXSS visibility: {source}"),
                ))
            }
        },
    };
    node.visibility = value;
    node.computed_style
        .insert("visibility".into(), value.as_css().into());
    for child in &mut node.children {
        resolve(child, value)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_render_skia::Rect;
    #[test]
    fn visibility_is_inherited_with_explicit_visible_and_initial_overrides() {
        let bounds = Rect {
            x: 0.0,
            y: 0.0,
            width: 30.0,
            height: 20.0,
        };
        let mut root = RenderNode::new("root", bounds);
        root.computed_style
            .insert("visibility".into(), "hidden".into());
        for source in [
            None,
            Some("inherit"),
            Some("unset"),
            Some("visible"),
            Some("initial"),
        ] {
            let mut child = RenderNode::new(format!("{source:?}"), bounds);
            if let Some(source) = source {
                child
                    .computed_style
                    .insert("visibility".into(), source.into());
            }
            root.children.push(child);
        }
        resolve_tree(&mut root).unwrap();
        assert_eq!(root.visibility, Visibility::Hidden);
        assert_eq!(root.bounds, bounds);
        assert_eq!(
            root.children
                .iter()
                .map(|n| n.visibility)
                .collect::<Vec<_>>(),
            [
                Visibility::Hidden,
                Visibility::Hidden,
                Visibility::Hidden,
                Visibility::Visible,
                Visibility::Visible
            ]
        );
        for child in &root.children {
            assert_eq!(
                child.computed_style["visibility"],
                child.visibility.as_css()
            );
            assert_eq!(child.bounds, bounds);
        }
    }
    #[test]
    fn visibility_collapse_and_substitutions_never_become_hidden_or_visible_defaults() {
        for source in [
            "collapse",
            "revert",
            "revert-layer",
            "var(--v)",
            "env(visibility,hidden)",
            "var(--empty) visible",
            "hidden env(visibility,)",
        ] {
            let mut root = RenderNode::new(
                "root",
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
            );
            root.computed_style
                .insert("visibility".into(), source.into());
            assert_eq!(
                resolve_tree(&mut root).unwrap_err().code,
                BridgeErrorCode::UnsupportedCapability
            );
        }
    }
}
