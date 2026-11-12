//! Resolve local group opacity once after projection. Paint consumers receive
//! a numeric value; selector reads share the same non-inherited computed value.

use super::{BridgeError, BridgeErrorCode, RenderNode};
use container_ir::{parse_wxss_opacity, WxssOpacity};

pub(super) fn resolve_tree(node: &mut RenderNode) -> Result<(), BridgeError> {
    resolve(node, 1.0)
}

fn resolve(node: &mut RenderNode, parent: f32) -> Result<(), BridgeError> {
    node.opacity = match node.computed_style.get("opacity") {
        None => 1.0,
        Some(value) => match parse_wxss_opacity(value) {
            Ok(WxssOpacity::Number(value)) => value,
            Ok(WxssOpacity::Inherit) => parent,
            Ok(WxssOpacity::Initial | WxssOpacity::Unset) | Err(_) => 1.0,
            Ok(WxssOpacity::Unsupported(_)) => {
                return Err(BridgeError::new(
                    BridgeErrorCode::UnsupportedCapability,
                    format!("unsupported WXSS opacity: {value}"),
                ));
            }
        },
    };
    if node.computed_style.contains_key("opacity") {
        node.computed_style
            .insert("opacity".into(), node.opacity.to_string());
    }
    for child in &mut node.children {
        resolve(child, node.opacity)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_render_skia::Rect;

    const BOUNDS: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    };

    #[test]
    fn opacity_defaults_are_not_inherited_but_explicit_inherit_is() {
        let mut root = RenderNode::new("root", BOUNDS);
        root.computed_style.insert("opacity".into(), "50%".into());
        for value in [
            None,
            Some("inherit"),
            Some("unset"),
            Some("initial"),
            Some("-20%"),
            Some("200%"),
            Some("invalid"),
        ] {
            let mut child = RenderNode::new(format!("{value:?}"), BOUNDS);
            if let Some(value) = value {
                child.computed_style.insert("opacity".into(), value.into());
            }
            root.children.push(child);
        }
        resolve_tree(&mut root).unwrap();
        assert_eq!(root.opacity, 0.5);
        assert_eq!(root.computed_style["opacity"], "0.5");
        assert_eq!(
            root.children
                .iter()
                .map(|node| node.opacity)
                .collect::<Vec<_>>(),
            [1.0, 0.5, 1.0, 1.0, 0.0, 1.0, 1.0]
        );
        assert!(!root.children[0].computed_style.contains_key("opacity"));
    }

    #[test]
    fn deferred_valid_values_do_not_silently_become_opaque() {
        for value in ["calc(.2 + .3)", "var(--alpha)", "revert", "revert-layer"] {
            let mut node = RenderNode::new("root", BOUNDS);
            node.computed_style.insert("opacity".into(), value.into());
            assert_eq!(
                resolve_tree(&mut node).unwrap_err().code,
                BridgeErrorCode::UnsupportedCapability
            );
        }
    }
}
