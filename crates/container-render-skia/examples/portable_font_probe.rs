//! Real face conformance input for scripts/test-web-font-metrics.mjs.
use container_render_skia::{
    CanvasService, DisplayMode, LayoutStyle, PageRenderMode, PortableFontData, Rect, RenderNode,
    SkiaRenderer, TextFlowStyle, TextStyle, ValidatedPageRenderMode, WordBreak,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).ok_or("font path is required")?;
    let bytes: Arc<[u8]> = std::fs::read(path)?.into();
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let font = PortableFontData::new(bytes, &digest)?;
    let mut renderer = SkiaRenderer::new_frame_export_only();
    renderer.install_portable_text_font(font.clone())?;
    assert!(renderer.install_portable_text_font(font.clone()).is_err());
    assert!(renderer
        .configure_page_render_mode(PageRenderMode::Raster)
        .is_err());
    let viewport = Rect {
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 100.0,
    };
    let mut hidden = RenderNode::new("hidden", viewport)
        .with_text("\u{10ffff}")
        .with_style(LayoutStyle {
            display: DisplayMode::None,
            ..LayoutStyle::default()
        });
    hidden
        .children
        .push(RenderNode::new("hidden-child", viewport).with_text("\u{10ffff}"));
    renderer.layout_tree(&mut hidden, viewport)?;
    assert!(hidden.text_layout.is_none());
    let mut owner = CanvasService::default();
    owner.install_portable_text_font(font)?;
    let mut moved = SkiaRenderer::new_with_validated_mode_and_canvas(
        ValidatedPageRenderMode::new(PageRenderMode::ExternalFrame)?,
        owner,
    );
    let mut text = RenderNode::new("moved", viewport).with_text("微信");
    moved.layout_tree(&mut text, viewport)?;
    assert!(text.text_layout.is_some());
    let mut cases = Vec::new();
    for (text, width) in [
        ("微信", 256.0),
        ("WWii汉字", 256.0),
        ("e\u{0301}汉W", 256.0),
        ("微信Wi汉字", 37.0),
    ] {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width,
            height: 300.0,
        };
        let mut root = RenderNode::new("root", viewport).with_style(LayoutStyle::default());
        root.children.push(
            RenderNode::new(
                "label",
                Rect {
                    width: 0.0,
                    height: 0.0,
                    ..viewport
                },
            )
            .with_style(LayoutStyle {
                width: Some(width),
                ..LayoutStyle::default()
            })
            .with_text(text)
            .with_text_style(TextStyle {
                font_size: 16.0,
                flow: Some(TextFlowStyle {
                    word_break: WordBreak::BreakAll,
                    ..TextFlowStyle::default()
                }),
                ..TextStyle::default()
            }),
        );
        renderer.layout_tree(&mut root, viewport)?;
        cases.push(serde_json::json!({"text":text,"width":width,"bounds":root.children[0].bounds,"layout":root.children[0].text_layout}));
    }
    let mut missing = RenderNode::new(
        "missing",
        Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        },
    )
    .with_text("\u{10ffff}");
    let unchanged = missing.clone();
    let missing_rejected = renderer
        .layout_tree(
            &mut missing,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        )
        .is_err();
    assert_eq!(
        missing, unchanged,
        "missing glyph preflight must preserve the caller tree"
    );
    println!(
        "{}",
        serde_json::json!({"fontSha256":digest,"cases":cases,"missingRejected":missing_rejected})
    );
    Ok(())
}
