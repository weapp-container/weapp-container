//! Lower an already evaluated declaration tree into native layout inputs.
//! No source templates, page data, expressions or component planner metadata
//! are available here. The runtime projection already flattened WXML blocks.

use crate::{
    apply_render_declarations,
    node_metadata::{project_dataset, project_mark},
};
use container_bridge::BridgeError;
use container_ir::{
    parse_inline_wxss, resolve_wxss_style_for_node_with_inline, ViewNode, WxssIr, WxssSelectorNode,
};
use container_render_skia::{DisplayMode, Rect, RenderNode};

/// Preserve the existing generated native ids. The occurrence suffix is an
/// opaque identity: keyed scopes/values may contain dots and colons, so never
/// parse or reconstruct it from the flattened physical tree.
fn legacy_id(prefix: &str, occurrence: &str) -> String {
    format!(
        "{prefix}:{}",
        occurrence.strip_prefix("event:").unwrap_or(occurrence)
    )
}

pub(super) fn materialize_nodes(
    nodes: &[ViewNode],
    styles: &WxssIr,
    viewport: Rect,
    ancestors: &[WxssSelectorNode],
) -> Result<Vec<RenderNode>, BridgeError> {
    let sibling_count = nodes
        .iter()
        .filter(|node| matches!(node, ViewNode::Element { .. }))
        .count();
    let mut element_index = 0;
    let mut output = Vec::with_capacity(nodes.len());
    for node in nodes {
        let render = match node {
            ViewNode::Text {
                occurrence_id,
                value,
                ownership,
            } => {
                let mut render = RenderNode::new(legacy_id("text", occurrence_id), empty_bounds())
                    .with_text(value.clone());
                // Anonymous paint text is never a public event target.
                render.hit_testable = false;
                render.event_identity = Some(occurrence_id.clone());
                render.event_owner_scope_id = ownership.event_owner.clone();
                render
            }
            ViewNode::Element {
                occurrence_id,
                tag,
                attrs,
                typed_attrs,
                key,
                ownership,
                children,
                ..
            } => {
                element_index += 1;
                let id = attrs
                    .get("id")
                    .filter(|id| !id.is_empty())
                    .cloned()
                    .unwrap_or_else(|| legacy_id("node", occurrence_id));
                let classes: Vec<String> = attrs
                    .get("class")
                    .map(|value| value.split_whitespace().map(str::to_owned).collect())
                    .unwrap_or_default();
                let selector = WxssSelectorNode {
                    tag: Some(tag.clone()),
                    id: attrs.get("id").cloned(),
                    classes: classes.clone(),
                    child_index: Some(element_index),
                    sibling_count: Some(sibling_count),
                };
                let inline = attrs
                    .get("style")
                    .map(|style| parse_inline_wxss(style))
                    .unwrap_or_default();
                let declarations =
                    resolve_wxss_style_for_node_with_inline(styles, &selector, ancestors, &inline);
                let mut render = RenderNode::new(id, empty_bounds());
                render.key = key.clone();
                render.event_identity = Some(occurrence_id.clone());
                render.event_owner_scope_id = ownership.event_owner.clone();
                render.component_scope_id = ownership.component_scope.clone();
                render.tag = Some(tag.clone());
                render.classes = classes;
                render.dataset = project_dataset(attrs, typed_attrs);
                render.mark = project_mark(attrs, typed_attrs);
                render.attributes = attrs.clone();
                apply_render_declarations(&mut render, &declarations, viewport);
                if attrs
                    .get("hidden")
                    .is_some_and(|value| value.is_empty() || value.eq_ignore_ascii_case("true"))
                {
                    if let Some(style) = render.style.as_mut() {
                        style.display = DisplayMode::None;
                    }
                }
                let mut child_ancestors = ancestors.to_vec();
                child_ancestors.push(selector);
                render.children = materialize_nodes(children, styles, viewport, &child_ancestors)?;
                render
            }
        };
        output.push(render);
    }
    Ok(output)
}

fn empty_bounds() -> Rect {
    Rect {
        x: 0.0,
        y: 0.0,
        width: 0.0,
        height: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{components::RenderOwnership, view_document, wxml_nodes_to_render_with_context};
    use container_ir::{parse_wxml, parse_wxss, ContainerManifestV1, WxmlNode};
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn flattened_document_preserves_keyed_ids_text_siblings_and_typed_metadata() {
        let mut ast = parse_wxml(
            r#"<!--before--><block><view id="a"/><!--gap--><text data-number="legacy" mark-active="legacy">label</text></block><view id="b"/>"#,
        )
        .unwrap();
        let WxmlNode::Element {
            key,
            key_scope,
            children,
            ..
        } = &mut ast.nodes[1]
        else {
            panic!("keyed block fixture");
        };
        *key = Some("dot.:value".into());
        *key_scope = Some("source.with:punctuation".into());
        let WxmlNode::Element { bound_values, .. } = &mut children[2] else {
            panic!("text element fixture");
        };
        bound_values.insert("data-number".into(), json!(7));
        bound_values.insert("mark-active".into(), json!(false));
        let block = crate::keyed_wxml_path_segment(Some("source.with:punctuation"), "dot.:value");
        let mut ownership = BTreeMap::new();
        for path in [
            "0".into(),
            block.clone(),
            format!("{block}.0"),
            format!("{block}.1"),
            format!("{block}.2"),
            format!("{block}.2.0"),
            "2".into(),
        ] {
            ownership.insert(
                path,
                RenderOwnership {
                    template: "pages/home/index.wxml".into(),
                    ..Default::default()
                },
            );
        }
        let manifest = ContainerManifestV1::default();
        let document = view_document::project_view_document(view_document::ViewDocumentInput {
            ast: &ast,
            ownership: &ownership,
            manifest: &manifest,
            blobs: &BTreeMap::new(),
            style_roots: &[],
            session_id: "document-lowering",
            page_id: 1,
            revision: 1,
            route_path: "pages/home/index",
        })
        .unwrap();
        let styles = parse_wxss(
            "view:first-child{width:11px} text:nth-child(2){width:22px} view:last-child{width:33px}",
        )
        .unwrap();
        let viewport = Rect {
            width: 120.0,
            height: 80.0,
            ..empty_bounds()
        };
        // The legacy AST adapter is test-only. This compares observable
        // lowering without making it a second production materialization path.
        let legacy = wxml_nodes_to_render_with_context(
            &ast.nodes,
            &styles,
            viewport,
            "",
            &[],
            None,
            &ownership,
        )
        .unwrap();
        let lowered = materialize_nodes(&document.nodes, &styles, viewport, &[]).unwrap();
        assert_eq!(lowered, legacy);
        assert_eq!(lowered.len(), 3);
        assert_eq!(lowered[1].id, format!("node:{block}.2"));
        assert_eq!(lowered[1].dataset["number"], json!(7));
        assert_eq!(lowered[1].mark["active"], json!(false));
        let text = &lowered[1].children[0];
        assert_eq!(text.id, format!("text:{block}.2.0"));
        assert!(!text.hit_testable);
        assert_eq!(lowered[0].style.unwrap().width, Some(11.0));
        assert_eq!(lowered[1].style.unwrap().width, Some(22.0));
        assert_eq!(lowered[2].style.unwrap().width, Some(33.0));
    }
}
