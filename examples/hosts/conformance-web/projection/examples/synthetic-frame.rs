// Typed synthetic scene for projection serialization tests, never host evidence.
use container_render_skia::{Rect, RenderFrame, RenderNode};
fn main() {
    let viewport = Rect { x: 0.0, y: 0.0, width: 100.0, height: 100.0 };
    let mut root = RenderNode::new("synthetic-root", viewport);
    let mut selected = RenderNode::new("synthetic-button", Rect { x: 10.0, y: 20.0, width: 40.0, height: 30.0 });
    selected.attributes.insert("id".into(), "synthetic-button".into());
    selected.attributes.insert("data-source".into(), "synthetic-typed-tree".into());
    selected.text = Some("  supplied synthetic tree  ".into());
    root.children.push(selected);
    let frame = RenderFrame { frame_id: 7, viewport, root, images: Default::default() };
    println!("{}", serde_json::to_string(&frame).unwrap());
}
