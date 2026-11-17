//! Fixed basic selector result shape, shared by native and browser geometry.
use super::*;

pub(super) fn basic_selector_geometry(
    identity: Option<(&str, &BTreeMap<String, Value>)>,
    rect: [f64; 4],
    scroll: [f64; 2],
    scroll_extent: Option<[f64; 2]>,
    operation: &str,
) -> Value {
    let [left, top, width, height] = rect;
    let mut result = if operation == "scrollOffset" {
        json!({"scrollLeft":scroll[0],"scrollTop":scroll[1]})
    } else {
        json!({"left":left,"top":top,"right":left+width,"bottom":top+height,
            "width":width,"height":height,"x":left,"y":top})
    };
    let object = result.as_object_mut().expect("selector result object");
    if operation == "scrollOffset" {
        if let Some([width, height]) = scroll_extent {
            object.insert("scrollWidth".into(), json!(width));
            object.insert("scrollHeight".into(), json!(height));
        }
    }
    // Viewport identity is synthetic; it never borrows the render-root id.
    object.insert("id".into(), json!(identity.map(|(id, _)| id).unwrap_or("")));
    object.insert(
        "dataset".into(),
        identity
            .map(|(_, dataset)| json!(dataset))
            .unwrap_or_else(|| json!({})),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn basic_projection_keeps_typed_dataset_public_id_and_display_rect() {
        let data = BTreeMap::from([
            ("count".into(), json!(7)),
            ("enabled".into(), json!(false)),
            ("payload".into(), json!({"a":[1,null]})),
        ]);
        let bounds = basic_selector_geometry(
            Some(("", &data)),
            [-2.5, 11.0, 20.0, 30.0],
            [4.0, 9.0],
            Some([200.0, 300.0]),
            "boundingClientRect",
        );
        assert_eq!(bounds["id"], json!(""));
        assert_eq!(bounds["dataset"], json!(data));
        assert_eq!(
            (bounds["left"].clone(), bounds["right"].clone()),
            (json!(-2.5), json!(17.5))
        );
        let scroll = basic_selector_geometry(
            Some(("repeat", &data)),
            [0.0; 4],
            [4.0, 9.0],
            Some([200.0, 300.0]),
            "scrollOffset",
        );
        assert_eq!(
            scroll,
            json!({"id":"repeat","dataset":data,"scrollLeft":4.0,"scrollTop":9.0,"scrollWidth":200.0,"scrollHeight":300.0})
        );
    }
    #[test]
    fn viewport_is_a_display_boundary_and_never_inherits_root_identity() {
        assert_eq!(
            basic_selector_geometry(
                None,
                [0.0, 0.0, 320.0, 480.0],
                [4.0, 9.0],
                Some([640.0, 960.0]),
                "scrollOffset"
            ),
            json!({"id":"","dataset":{},"scrollLeft":4.0,"scrollTop":9.0,"scrollWidth":640.0,"scrollHeight":960.0})
        );
        let result = basic_selector_geometry(
            None,
            [0.0, 0.0, 320.0, 480.0],
            [0.0; 2],
            None,
            "boundingClientRect",
        );
        assert_eq!(result["id"], json!(""));
        assert_eq!(result["dataset"], json!({}));
        assert_eq!(result["width"], json!(320.0));
    }
    #[test]
    fn native_scroll_projection_uses_accepted_content_extent_and_field_projection() {
        let mut node = container_render_skia::RenderNode::new(
            "private-occurrence",
            container_render_skia::Rect {
                x: 0.0,
                y: 0.0,
                width: 80.0,
                height: 40.0,
            },
        );
        node.attributes.insert("id".into(), "scroll".into());
        node.scroll_container = true;
        node.scroll_offset = Some(container_render_skia::ScrollOffset {
            scroll_left: 7.0,
            scroll_top: 11.0,
        });
        node.children.push(container_render_skia::RenderNode::new(
            "content",
            container_render_skia::Rect {
                x: 0.0,
                y: 0.0,
                width: 160.0,
                height: 120.0,
            },
        ));
        let first = selector_result(&node, None, "scrollOffset");
        assert_eq!(
            first,
            json!({"id":"scroll","dataset":{},"scrollLeft":7.0,"scrollTop":11.0,
            "scrollWidth":160.0,"scrollHeight":120.0})
        );
        node.scroll_offset.as_mut().unwrap().scroll_top = 50.0;
        let changed = selector_result(&node, None, "scrollOffset");
        assert_eq!(changed["scrollHeight"], first["scrollHeight"]);
        assert_eq!(changed["scrollTop"], json!(50.0));
        let fields = parse_selector_fields(Some(&json!({"scrollOffset":true})))
            .unwrap()
            .unwrap();
        let selected = selector_result(&node, Some(&fields), "fields");
        assert_eq!(selected["scrollWidth"], first["scrollWidth"]);
        assert_eq!(selected["scrollHeight"], first["scrollHeight"]);
        assert!(selected.get("id").is_none());
    }
}
