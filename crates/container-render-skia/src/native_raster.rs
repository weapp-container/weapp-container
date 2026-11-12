//! Object-independent native raster/readback helpers shared by page and Canvas.

use super::{fallback_glyph, rgba_buffer_layout, NativeFonts, RenderError, RenderSnapshot};
use skia_safe as skia;

pub(super) fn readback_native(
    surface: &mut skia::Surface,
    frame_id: u64,
    width: u32,
    height: u32,
) -> Result<RenderSnapshot, RenderError> {
    readback_native_with_allocator(surface, frame_id, width, height, allocate_readback_pixels)
}

#[cfg(feature = "skia-backend")]
pub(super) fn allocate_readback_pixels(byte_len: usize) -> Result<Vec<u8>, RenderError> {
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(byte_len)
        .map_err(|_| RenderError::PixelBufferAllocationFailed)?;
    pixels.resize(byte_len, 0);
    Ok(pixels)
}

#[cfg(feature = "skia-backend")]
pub(super) fn readback_native_with_allocator(
    surface: &mut skia::Surface,
    frame_id: u64,
    width: u32,
    height: u32,
    allocate: impl FnOnce(usize) -> Result<Vec<u8>, RenderError>,
) -> Result<RenderSnapshot, RenderError> {
    let width_i32 = i32::try_from(width).map_err(|_| RenderError::InvalidViewport)?;
    let height_i32 = i32::try_from(height).map_err(|_| RenderError::InvalidViewport)?;
    let (stride, byte_len) = rgba_buffer_layout(width, height)?;
    if width == 0 || height == 0 {
        return Ok(RenderSnapshot {
            frame_id,
            width,
            height,
            stride,
            format: "rgba8-premultiplied".into(),
            pixels: Vec::new(),
        });
    }
    let info = skia::ImageInfo::new(
        (width_i32, height_i32),
        skia::ColorType::RGBA8888,
        skia::AlphaType::Premul,
        None,
    );
    // Reserve before initialization/readback so allocation rejection stays
    // inside the prepare/publish transaction instead of aborting the host.
    let mut pixels = allocate(byte_len)?;
    // Raster surfaces are synchronously readable.  Calling read_pixels
    // here is intentional: it gives host smoke tests evidence that the
    // submitted tree reached the Skia raster surface and not merely the
    // software mirror.
    if !surface
        .canvas()
        .read_pixels(&info, &mut pixels, stride as usize, (0, 0))
    {
        return Err(RenderError::Unsupported("skia-readback"));
    }
    Ok(RenderSnapshot {
        frame_id,
        width,
        height,
        stride,
        format: "rgba8-premultiplied".into(),
        pixels,
    })
}

pub(super) fn draw_native_text(
    canvas: &skia::Canvas,
    text: &str,
    baseline: (f32, f32),
    font_size: f32,
    fonts: &mut NativeFonts,
    paint: &skia::Paint,
) {
    let mut x = baseline.0;
    let mut y = baseline.1;
    for character in text.chars() {
        if character == '\n' {
            x = baseline.0;
            y += font_size * 1.2;
            continue;
        }
        if character == '\r' {
            continue;
        }
        if character == '\t' {
            x += font_size * 2.0;
            continue;
        }
        let mut encoded = [0; 4];
        let glyph: &str = character.encode_utf8(&mut encoded);
        if let Some(font) = fonts.for_character(character, font_size) {
            canvas.draw_str(glyph, (x, y), &font, paint);
            x += font.measure_str(glyph, Some(paint)).0;
        } else {
            // A missing glyph affects only that character. Keep other
            // Latin/CJK glyphs on their actual system faces, even in a
            // mixed string containing unsupported Unicode characters.
            let scale = font_size / 16.0;
            canvas.save();
            canvas.translate((x, y - font_size));
            canvas.scale((scale, scale));
            draw_fallback_text(canvas, glyph, (0.0, 0.0), paint);
            canvas.restore();
            x += 12.0 * scale;
        }
    }
}

#[cfg(feature = "skia-backend")]
pub(super) fn draw_fallback_text(
    canvas: &skia::Canvas,
    text: &str,
    origin: (f32, f32),
    paint: &skia::Paint,
) {
    const GLYPH_WIDTH: f32 = 2.0;
    const GLYPH_HEIGHT: f32 = 2.0;
    const ADVANCE: f32 = 12.0;
    let mut x = origin.0;
    let mut y = origin.1;
    for character in text.chars() {
        if character == '\n' {
            x = origin.0;
            y += 16.0;
            continue;
        }
        if character != ' ' {
            let rows = fallback_glyph(character);
            for (row, bits) in rows.iter().enumerate() {
                for column in 0..5 {
                    if bits & (1 << (4 - column)) != 0 {
                        canvas.draw_rect(
                            skia::Rect::from_xywh(
                                x + column as f32 * GLYPH_WIDTH,
                                y + row as f32 * GLYPH_HEIGHT,
                                GLYPH_WIDTH,
                                GLYPH_HEIGHT,
                            ),
                            paint,
                        );
                    }
                }
            }
        }
        x += ADVANCE;
    }
}
