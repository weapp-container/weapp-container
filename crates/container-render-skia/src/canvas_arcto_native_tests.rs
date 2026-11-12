// Child of canvas_service: exercise canonical conics inside the actual caller guard.
use super::*;
use serde_json::{json, Value};

fn frame(commands: &[(&str, Value)]) -> CanvasFrame {
    CanvasFrame {
        frame_id: 1,
        canvas_id: "native-arcto".into(),
        width: 64,
        height: 56,
        reserve: false,
        commands: commands
            .iter()
            .map(|(op, args)| CanvasCommand {
                op: (*op).into(),
                args: args.as_array().unwrap().clone(),
            })
            .collect(),
    }
}
fn pixel(image: &RenderSnapshot, x: usize, y: usize) -> [u8; 4] {
    let offset = y * image.stride as usize + x * 4;
    image.pixels[offset..offset + 4].try_into().unwrap()
}

#[test]
fn arc_to_conic_clip_applies_nonunit_caller_baseline_once_and_restores_guard() {
    let mut surface = skia::surfaces::raster_n32_premul((64, 56)).unwrap();
    let canvas = surface.canvas();
    canvas.clear(skia::Color::TRANSPARENT);
    canvas.save();
    canvas.translate((8, 4));
    canvas.scale((2.0, 2.0));
    canvas.clip_rect(skia::Rect::from_xywh(0.0, 0.0, 20.0, 18.0), None, false);
    let depth = canvas.save_count();
    let matrix = canvas.local_to_device();
    let clip = canvas.local_clip_bounds();
    let prepared = PreparedCanvasBatch::prepare(&frame(&[
        ("setTransform", json!([1, 0, 0, 1, 2, 3])),
        ("moveTo", json!([0, 0])),
        ("lineTo", json!([4, 0])),
        ("arcTo", json!([8, 0, 8, 4, 4])),
        ("lineTo", json!([8, 8])),
        ("lineTo", json!([0, 8])),
        ("closePath", json!([])),
        ("setTransform", json!([0, 0, 0, 0, 0, 0])),
        ("clip", json!([])),
        ("setTransform", json!([1, 0, 0, 1, 0, 0])),
        ("setFillStyle", json!(["red"])),
        ("fillRect", json!([0, 0, 64, 56])),
    ]))
    .unwrap();
    assert!(prepared
        .commands
        .iter()
        .any(|command| matches!(command, PreparedCanvasCommand::ConicArcTo(_))));
    execute_native_canvas(canvas, &prepared, &mut NativeFonts::new()).unwrap();
    assert_eq!(canvas.save_count(), depth);
    assert_eq!(canvas.local_to_device(), matrix);
    assert_eq!(canvas.local_clip_bounds(), clip);
    let image = native_raster::readback_native(&mut surface, 1, 64, 56).unwrap();
    assert_eq!(pixel(&image, 18, 18), [255, 0, 0, 255]);
    assert_eq!(pixel(&image, 10, 18), [0; 4]);
    assert_eq!(pixel(&image, 27, 11), [0; 4]);
    assert_eq!(pixel(&image, 18, 28), [0; 4]);
}

#[test]
fn native_error_after_conic_clip_restores_callers_matrix_clip_and_save_depth() {
    let mut surface = skia::surfaces::raster_n32_premul((64, 56)).unwrap();
    let canvas = surface.canvas();
    canvas.save();
    canvas.translate((8, 4));
    canvas.scale((2.0, 2.0));
    canvas.clip_rect(skia::Rect::from_xywh(0.0, 0.0, 20.0, 18.0), None, false);
    let depth = canvas.save_count();
    let matrix = canvas.local_to_device();
    let clip = canvas.local_clip_bounds();
    let prepared = PreparedCanvasBatch::prepare(&frame(&[
        ("moveTo", json!([0, 0])),
        ("lineTo", json!([4, 0])),
        ("arcTo", json!([8, 0, 8, 4, 4])),
        ("lineTo", json!([8, 16])),
        ("lineTo", json!([0, 16])),
        ("closePath", json!([])),
        ("clip", json!([])),
        ("save", json!([])),
        ("setTransform", json!([1, 0, 0, 1, 1, 0])),
        ("setLineDash", json!([[1e-8, 1e-8]])),
        ("beginPath", json!([])),
        ("moveTo", json!([0, 8])),
        ("lineTo", json!([64, 8])),
        ("stroke", json!([])),
    ]))
    .unwrap();
    assert!(prepared
        .commands
        .iter()
        .any(|command| matches!(command, PreparedCanvasCommand::ConicArcTo(_))));
    assert_eq!(
        execute_native_canvas(canvas, &prepared, &mut NativeFonts::new()),
        Err(RenderError::Unsupported("skia-canvas-dash-complexity"))
    );
    assert_eq!(canvas.save_count(), depth);
    assert_eq!(canvas.local_to_device(), matrix);
    assert_eq!(canvas.local_clip_bounds(), clip);
}
