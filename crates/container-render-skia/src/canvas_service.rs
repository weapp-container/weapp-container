//! Canvas command histories, pixels and native drawing resources.
//!
//! Independent surfaces use their legacy string map. Page surfaces use a
//! separate typed-owner map and publish through a prepared page transaction.
//! A service exists before a page renderer and moves into that renderer on
//! explicit page use. Both stores share one native font provider.

#[cfg(all(test, feature = "skia-backend"))]
use super::canvas_work_probes;
#[cfg(not(feature = "skia-backend"))]
use super::rasterize_prepared_canvas;
use super::{
    canvas_batch::PreparedCanvasBatch, CanvasCommand, CanvasFrame, RenderError, RenderSnapshot,
};
#[cfg(feature = "skia-backend")]
use super::{
    canvas_batch::PreparedCanvasCommand, native_raster, CanvasLineCap, CanvasLineJoin, CanvasPoint,
    CanvasRasterState, CanvasTextAlign, CanvasTextBaseline, CanvasTransform, NativeFontData,
    NativeFontInfo, NativeFonts,
};
#[cfg(feature = "skia-backend")]
use skia_safe as skia;
use std::collections::BTreeMap;

/// One owned Canvas state, independent of page layout and GPU contexts.
#[cfg_attr(not(feature = "skia-backend"), derive(Default))]
pub struct CanvasService {
    pub(super) portable_font: Option<super::PortableFontData>,
    pub(super) commands: BTreeMap<String, Vec<CanvasCommand>>,
    snapshots: BTreeMap<String, RenderSnapshot>,
    batch_starts: BTreeMap<String, Vec<usize>>,
    pub(super) owned: super::owned_canvas::OwnedCanvasSurfaces,
    #[cfg(feature = "skia-backend")]
    pub(super) native_fonts: NativeFonts,
}

#[cfg(feature = "skia-backend")]
impl Default for CanvasService {
    fn default() -> Self {
        Self {
            portable_font: None,
            commands: BTreeMap::new(),
            snapshots: BTreeMap::new(),
            batch_starts: BTreeMap::new(),
            owned: BTreeMap::new(),
            #[cfg(feature = "skia-backend")]
            native_fonts: NativeFonts::new(),
        }
    }
}

impl CanvasService {
    pub fn install_portable_text_font(
        &mut self,
        font: super::PortableFontData,
    ) -> Result<super::PortableFontIdentity, RenderError> {
        if self.portable_font.is_some() {
            return Err(RenderError::InvalidFont(
                "external text font is immutable for this owner".into(),
            ));
        }
        let identity = font.identity();
        self.portable_font = Some(font);
        Ok(identity)
    }

    /// Validate and render one complete batch before publishing its history.
    pub fn commit(&mut self, frame: CanvasFrame) -> Result<RenderSnapshot, RenderError> {
        self.commit_with_backend(frame, Self::render_prepared_canvas)
    }

    pub fn snapshot(&self, id: &str) -> Option<RenderSnapshot> {
        self.snapshots.get(id).cloned()
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.snapshots.keys().map(String::as_str)
    }

    #[cfg(feature = "skia-backend")]
    pub fn install_native_fonts(
        &mut self,
        sources: &[NativeFontData],
    ) -> Result<NativeFontInfo, RenderError> {
        self.native_fonts.install(sources)
    }

    /// Install the complete native font set before any Canvas/page work and
    /// disable system fallback. The same provider moves into the page owner.
    #[cfg(feature = "skia-backend")]
    pub fn install_native_fonts_only(
        &mut self,
        sources: &[NativeFontData],
    ) -> Result<NativeFontInfo, RenderError> {
        self.native_fonts.install_only(sources)
    }

    #[cfg(feature = "skia-backend")]
    pub fn native_font_info(&self) -> NativeFontInfo {
        self.native_fonts.info()
    }

    pub(super) fn commit_with_backend(
        &mut self,
        mut frame: CanvasFrame,
        render: impl FnOnce(&mut Self, &PreparedCanvasBatch) -> Result<RenderSnapshot, RenderError>,
    ) -> Result<RenderSnapshot, RenderError> {
        if frame.canvas_id.trim().is_empty() {
            return Err(RenderError::InvalidCanvas("canvasId is required".into()));
        }
        let previous_len = if frame.reserve {
            self.commands.get(&frame.canvas_id).map_or(0, Vec::len)
        } else {
            0
        };
        let mut batch_starts = if frame.reserve {
            self.batch_starts
                .get(&frame.canvas_id)
                .cloned()
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        // Empty draws create no replay boundary or unbounded marker history.
        if previous_len > 0 && !frame.commands.is_empty() {
            batch_starts.push(previous_len);
        }
        let mut history = if frame.reserve {
            self.commands
                .get(&frame.canvas_id)
                .cloned()
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        // Reject command-count growth before extending the retained allocation.
        if previous_len
            .checked_add(frame.commands.len())
            .and_then(|count| count.checked_add(batch_starts.len()))
            .is_none_or(|count| count > PreparedCanvasBatch::MAX_COMMANDS)
        {
            return Err(RenderError::InvalidCanvas(
                "canvas command budget exceeded".into(),
            ));
        }
        history.append(&mut frame.commands);
        frame.commands = history.clone();
        // Guest decoding, normalization and all replay budgets precede entry
        // into the backend. ResetState cannot be supplied through CanvasCommand.
        let prepared = PreparedCanvasBatch::prepare_batches(&frame, &batch_starts)?;
        let snapshot = render(self, &prepared)?;
        // Font installation becomes immutable with a published native image,
        // including successful readback. A rejected first transaction must
        // not permanently freeze the owner's previously installable fonts.
        #[cfg(feature = "skia-backend")]
        self.native_fonts.begin_render();
        self.batch_starts
            .insert(frame.canvas_id.clone(), batch_starts);
        self.commands.insert(frame.canvas_id.clone(), history);
        self.snapshots.insert(frame.canvas_id, snapshot.clone());
        Ok(snapshot)
    }

    pub(super) fn prepare_owned_update(
        &mut self,
        owner: &super::CanvasOwnerKey,
        mut frame: CanvasFrame,
    ) -> Result<super::owned_canvas::PreparedOwnedCanvasUpdate, RenderError> {
        use super::owned_canvas::{self, OwnedCanvasSurface, PreparedOwnedCanvasUpdate};
        owner.validate()?;
        if frame.canvas_id.trim().is_empty() {
            return Err(RenderError::InvalidCanvas("canvasId is required".into()));
        }
        if !self.owned.contains_key(owner) && self.owned.len() >= owned_canvas::MAX_OWNED_CANVASES {
            return Err(RenderError::InvalidCanvas(
                "owned canvas count budget exceeded".into(),
            ));
        }
        let previous = self.owned.get(owner).cloned();
        let mut history = if frame.reserve {
            previous
                .as_ref()
                .map(|surface| surface.history.clone())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let mut batch_starts = if frame.reserve {
            previous
                .as_ref()
                .map(|surface| surface.batch_starts.clone())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        if !history.is_empty() && !frame.commands.is_empty() {
            batch_starts.push(history.len());
        }
        if history
            .len()
            .checked_add(frame.commands.len())
            .and_then(|count| count.checked_add(batch_starts.len()))
            .is_none_or(|count| count > PreparedCanvasBatch::MAX_COMMANDS)
        {
            return Err(RenderError::InvalidCanvas(
                "canvas command budget exceeded".into(),
            ));
        }
        history.append(&mut frame.commands);
        frame.commands = history.clone();
        let prepared = PreparedCanvasBatch::prepare_batches(&frame, &batch_starts)?;
        let retained_bytes = owned_canvas::retained_bytes(
            owner,
            &history,
            history.capacity(),
            batch_starts.capacity(),
            prepared.byte_len,
        )?;
        let total = self
            .owned
            .iter()
            .filter(|(key, _)| *key != owner)
            .try_fold(retained_bytes, |total, (_, surface)| {
                total.checked_add(surface.retained_bytes)
            })
            .filter(|bytes| *bytes <= owned_canvas::MAX_OWNED_CANVAS_BYTES);
        if total.is_none() {
            return Err(RenderError::InvalidCanvas(
                "owned canvas total byte budget exceeded".into(),
            ));
        }
        let snapshot = self.render_prepared_canvas(&prepared)?;
        let image = owned_canvas::image_from_snapshot(&snapshot)?;
        let surface = std::sync::Arc::new(OwnedCanvasSurface {
            history,
            batch_starts,
            snapshot,
            image,
            retained_bytes,
        });
        let mut surfaces = self.owned.clone();
        surfaces.insert(owner.clone(), surface);
        Ok(PreparedOwnedCanvasUpdate {
            owner: owner.clone(),
            surfaces,
        })
    }

    fn render_prepared_canvas(
        &mut self,
        frame: &PreparedCanvasBatch,
    ) -> Result<RenderSnapshot, RenderError> {
        #[cfg(feature = "skia-backend")]
        {
            let mut surface = render_native_canvas(frame, &mut self.native_fonts)?;
            #[cfg(test)]
            canvas_work_probes::native_readback();
            let snapshot = native_raster::readback_native(
                &mut surface,
                frame.frame_id,
                frame.width,
                frame.height,
            )?;
            debug_assert_eq!(snapshot.stride, frame.stride);
            debug_assert_eq!(snapshot.pixels.len(), frame.byte_len);
            Ok(snapshot)
        }
        #[cfg(not(feature = "skia-backend"))]
        Ok(rasterize_prepared_canvas(frame))
    }
}

#[cfg(feature = "skia-backend")]
fn render_native_canvas(
    frame: &PreparedCanvasBatch,
    fonts: &mut NativeFonts,
) -> Result<skia::Surface, RenderError> {
    if frame.width > i32::MAX as u32 || frame.height > i32::MAX as u32 {
        return Err(RenderError::InvalidCanvas(
            "canvas dimensions exceed Skia limits".into(),
        ));
    }
    // Reject known compound limitations before allocating a surface or
    // looking up any earlier glyph. Save/restore affects the dash state.
    let mut dashed = false;
    let mut dash_stack = Vec::new();
    for command in &frame.commands {
        match command {
            PreparedCanvasCommand::ResetState => {
                dashed = false;
                dash_stack.clear();
            }
            PreparedCanvasCommand::SetLineDash { pattern, .. } => dashed = !pattern.is_empty(),
            PreparedCanvasCommand::Save => dash_stack.push(dashed),
            PreparedCanvasCommand::Restore => {
                if let Some(saved) = dash_stack.pop() {
                    dashed = saved;
                }
            }
            PreparedCanvasCommand::StrokeText { .. } if dashed => {
                return Err(RenderError::UnsupportedCanvasCommand(
                    "strokeText with line dash".into(),
                ));
            }
            _ => {}
        }
    }
    let size = (frame.width.max(1) as i32, frame.height.max(1) as i32);
    #[cfg(test)]
    canvas_work_probes::native_surface();
    let mut surface = skia::surfaces::raster_n32_premul(size)
        .ok_or(RenderError::Unsupported("skia-canvas-surface"))?;
    surface.canvas().clear(skia::Color::TRANSPARENT);
    execute_native_canvas(surface.canvas(), frame, fonts)?;
    Ok(surface)
}

#[cfg(feature = "skia-backend")]
fn execute_native_canvas(
    canvas: &skia::Canvas,
    frame: &PreparedCanvasBatch,
    fonts: &mut NativeFonts,
) -> Result<(), RenderError> {
    // The guard belongs to this executor. Guest restore/reset never crosses
    // the caller's save/clip/CTM boundary, even if this independent surface is
    // later reused by a page compositor.
    let initial_save_count = canvas.save_count();
    let initial_matrix = canvas.local_to_device();
    canvas.save();
    let result = (|| {
        let mut state = CanvasRasterState::default();
        let mut path = skia::PathBuilder::new();
        for command in &frame.commands {
            match command {
                PreparedCanvasCommand::PendingArcTo(_) => {
                    return Err(RenderError::InvalidCanvas(
                        "unresolved canvas arcTo reached native replay".into(),
                    ));
                }
                PreparedCanvasCommand::ResetState => {
                    canvas.restore_to_count(initial_save_count);
                    canvas.save();
                    canvas.set_matrix(&initial_matrix);
                    state = CanvasRasterState::default();
                    path.reset();
                }
                PreparedCanvasCommand::SetFillStyle(color) => state.fill = *color,
                PreparedCanvasCommand::SetStrokeStyle(color) => state.stroke = *color,
                PreparedCanvasCommand::SetLineWidth(width) => state.line_width = *width,
                PreparedCanvasCommand::SetLineDash { pattern, offset } => {
                    state.line_dash = pattern.clone().into();
                    state.line_dash_offset = *offset;
                }
                PreparedCanvasCommand::SetLineCap(cap) => state.line_cap = *cap,
                PreparedCanvasCommand::SetLineJoin(join) => state.line_join = *join,
                PreparedCanvasCommand::SetMiterLimit(limit) => state.miter_limit = *limit,
                PreparedCanvasCommand::SetGlobalAlpha(alpha) => state.global_alpha = *alpha,
                PreparedCanvasCommand::SetFontSize(size) => state.font_size = *size,
                PreparedCanvasCommand::SetTextAlign(align) => state.text_align = *align,
                PreparedCanvasCommand::SetTextBaseline(baseline) => state.text_baseline = *baseline,
                PreparedCanvasCommand::Save => {
                    canvas.save();
                    state.stack.push(state.saved());
                }
                PreparedCanvasCommand::Restore => {
                    if let Some(saved) = state.stack.pop() {
                        canvas.restore();
                        state.restore_saved(saved);
                    }
                }
                PreparedCanvasCommand::Translate([x, y]) => {
                    canvas.translate((*x, *y));
                    state.transform = state.transform.multiply(CanvasTransform {
                        e: *x,
                        f: *y,
                        ..CanvasTransform::IDENTITY
                    });
                }
                PreparedCanvasCommand::Rotate(angle) => {
                    let rotation = CanvasTransform {
                        a: angle.cos(),
                        b: angle.sin(),
                        c: -angle.sin(),
                        d: angle.cos(),
                        e: 0.0,
                        f: 0.0,
                    };
                    canvas.concat(&rotation.native());
                    state.transform = state.transform.multiply(rotation);
                }
                PreparedCanvasCommand::Scale([x, y]) => {
                    canvas.scale((*x, *y));
                    state.transform = state.transform.multiply(CanvasTransform {
                        a: *x,
                        d: *y,
                        ..CanvasTransform::IDENTITY
                    });
                }
                PreparedCanvasCommand::SetTransform(values) => {
                    state.transform = CanvasTransform::from_values(*values);
                    // The public operation replaces only the guest CTM.
                    canvas.set_matrix(&initial_matrix);
                    canvas.concat(&state.transform.native());
                }
                PreparedCanvasCommand::Transform(values) => {
                    let transform = CanvasTransform::from_values(*values);
                    canvas.concat(&transform.native());
                    state.transform = state.transform.multiply(transform);
                }
                PreparedCanvasCommand::Clip => {
                    // Path vertices already captured their construction-time
                    // guest CTM. Keep the clip while restoring only the matrix;
                    // a save/restore pair here would undo the new clip.
                    let matrix = canvas.local_to_device();
                    canvas.set_matrix(&initial_matrix);
                    canvas.clip_path(&path.clone().detach(), None, true);
                    canvas.set_matrix(&matrix);
                }
                PreparedCanvasCommand::FillRect(rect)
                | PreparedCanvasCommand::StrokeRect(rect)
                | PreparedCanvasCommand::ClearRect(rect) => {
                    if matches!(command, PreparedCanvasCommand::StrokeRect(_))
                        && (state.line_width == 0.0 || state.transform.inverse().is_none())
                    {
                        continue;
                    }
                    let rect = skia::Rect::from_xywh(rect[0], rect[1], rect[2], rect[3]);
                    if matches!(command, PreparedCanvasCommand::ClearRect(_)) {
                        let mut paint = skia::Paint::default();
                        paint.set_blend_mode(skia::BlendMode::Clear);
                        canvas.draw_rect(rect, &paint);
                    } else {
                        let color = if matches!(command, PreparedCanvasCommand::FillRect(_)) {
                            state.color(state.fill)
                        } else {
                            state.color(state.stroke)
                        };
                        let mut paint = skia::Paint::new(
                            skia::Color4f::from(skia::Color::from_argb(
                                color[3], color[0], color[1], color[2],
                            )),
                            None,
                        );
                        paint.set_anti_alias(true);
                        if matches!(command, PreparedCanvasCommand::StrokeRect(_)) {
                            configure_native_stroke(&mut paint, &state)?;
                            draw_native_canvas_path(canvas, &skia::Path::rect(rect, None), &paint)?;
                        } else {
                            canvas.draw_rect(rect, &paint);
                        }
                    }
                }
                PreparedCanvasCommand::BeginPath => {
                    path.reset();
                }
                PreparedCanvasCommand::MoveTo([x, y]) => {
                    let point = state.transform.apply(CanvasPoint { x: *x, y: *y });
                    path.move_to((point.x, point.y));
                }
                PreparedCanvasCommand::LineTo([x, y]) => {
                    let point = state.transform.apply(CanvasPoint { x: *x, y: *y });
                    if path.is_empty() {
                        path.move_to((point.x, point.y));
                    } else {
                        path.line_to((point.x, point.y));
                    }
                }
                PreparedCanvasCommand::ClosePath => {
                    path.close();
                }
                PreparedCanvasCommand::ConicArcTo(arc) => {
                    // These points captured the construction CTM in shared
                    // admission; the conic weight is affine-invariant.
                    path.line_to((arc.start.x, arc.start.y));
                    path.conic_to(
                        (arc.control.x, arc.control.y),
                        (arc.end.x, arc.end.y),
                        arc.weight,
                    );
                }
                PreparedCanvasCommand::QuadraticCurveTo([cx, cy, x, y]) => {
                    let control = state.transform.apply(CanvasPoint { x: *cx, y: *cy });
                    let end = state.transform.apply(CanvasPoint { x: *x, y: *y });
                    if path.is_empty() {
                        path.move_to((control.x, control.y));
                    }
                    path.quad_to((control.x, control.y), (end.x, end.y));
                }
                PreparedCanvasCommand::BezierCurveTo([cx1, cy1, cx2, cy2, x, y]) => {
                    let c1 = state.transform.apply(CanvasPoint { x: *cx1, y: *cy1 });
                    let c2 = state.transform.apply(CanvasPoint { x: *cx2, y: *cy2 });
                    let end = state.transform.apply(CanvasPoint { x: *x, y: *y });
                    if path.is_empty() {
                        path.move_to((c1.x, c1.y));
                    }
                    path.cubic_to((c1.x, c1.y), (c2.x, c2.y), (end.x, end.y));
                }
                PreparedCanvasCommand::Arc {
                    center,
                    radius,
                    start,
                    sweep,
                } => {
                    let [cx, cy] = *center;
                    let radius = *radius;
                    // Unit geometry avoids overflowing 2*radius before CTM.
                    let oval = skia::Rect::from_xywh(-1.0, -1.0, 2.0, 2.0);
                    let mut arc = skia::PathBuilder::new();
                    arc.move_to((start.cos(), start.sin()));
                    if *sweep != 0.0 {
                        let half = sweep.to_degrees() * 0.5;
                        arc.arc_to(oval, start.to_degrees(), half, false);
                        arc.arc_to(oval, start.to_degrees() + half, half, false);
                    }
                    let circle = CanvasTransform {
                        a: radius,
                        b: 0.0,
                        c: 0.0,
                        d: radius,
                        e: cx,
                        f: cy,
                    };
                    path.add_path_with_transform(
                        &arc.detach(),
                        &state.transform.multiply(circle).native(),
                        skia::path::AddPathMode::Extend,
                    );
                }
                PreparedCanvasCommand::Rect(rect) => {
                    let [x, y, width, height] = *rect;
                    let points = [
                        (x, y),
                        (x + width, y),
                        (x + width, y + height),
                        (x, y + height),
                    ]
                    .map(|(x, y)| state.transform.apply(CanvasPoint { x, y }));
                    path.move_to((points[0].x, points[0].y));
                    for point in &points[1..] {
                        path.line_to((point.x, point.y));
                    }
                    path.close();
                }

                PreparedCanvasCommand::Fill | PreparedCanvasCommand::Stroke => {
                    let color = if matches!(command, PreparedCanvasCommand::Fill) {
                        state.color(state.fill)
                    } else {
                        state.color(state.stroke)
                    };
                    let mut paint = skia::Paint::new(
                        skia::Color4f::from(skia::Color::from_argb(
                            color[3], color[0], color[1], color[2],
                        )),
                        None,
                    );
                    paint.set_anti_alias(true);
                    let path_snapshot = path.clone().detach();
                    if matches!(command, PreparedCanvasCommand::Stroke) {
                        if state.line_width == 0.0 {
                            continue;
                        }
                        let Some(inverse) = state.transform.inverse() else {
                            continue;
                        };
                        let Some(user_path) = path_snapshot.try_make_transform(&inverse.native())
                        else {
                            return Err(RenderError::InvalidCanvas(
                                "canvas stroke transform overflow".into(),
                            ));
                        };
                        configure_native_stroke(&mut paint, &state)?;
                        draw_native_canvas_path(canvas, &user_path, &paint)?;
                    } else {
                        // Path points capture each path command's CTM. Fill uses
                        // only the host baseline instead of transforming again.
                        canvas.save();
                        canvas.set_matrix(&initial_matrix);
                        let drawn = draw_native_canvas_path(canvas, &path_snapshot, &paint);
                        canvas.restore();
                        drawn?;
                    }
                }
                PreparedCanvasCommand::FillText { text, position }
                | PreparedCanvasCommand::StrokeText { text, position } => {
                    let color = if matches!(command, PreparedCanvasCommand::FillText { .. }) {
                        state.color(state.fill)
                    } else {
                        state.color(state.stroke)
                    };
                    let mut paint = skia::Paint::new(
                        skia::Color4f::from(skia::Color::from_argb(
                            color[3], color[0], color[1], color[2],
                        )),
                        None,
                    );
                    paint.set_anti_alias(true);
                    if matches!(command, PreparedCanvasCommand::StrokeText { .. }) {
                        if state.line_width == 0.0 || state.transform.inverse().is_none() {
                            continue;
                        }
                        if !state.line_dash.is_empty() {
                            // Skia's glyph drawing API cannot report a rejected
                            // dash filter. Keep this compound operation explicit
                            // until glyph outlines use the checked path route.
                            return Err(RenderError::UnsupportedCanvasCommand(
                                "strokeText with line dash".into(),
                            ));
                        }
                        configure_native_stroke(&mut paint, &state)?;
                    }
                    draw_native_canvas_text(
                        canvas,
                        text,
                        (position[0], position[1]),
                        &state,
                        fonts,
                        &paint,
                    )?;
                }
            }
        }
        Ok(())
    })();
    canvas.restore_to_count(initial_save_count);
    canvas.set_matrix(&initial_matrix);
    result
}

#[cfg(feature = "skia-backend")]
fn configure_native_stroke(
    paint: &mut skia::Paint,
    state: &CanvasRasterState,
) -> Result<(), RenderError> {
    paint.set_style(skia::PaintStyle::Stroke);
    paint.set_stroke_width(state.line_width);
    paint.set_stroke_cap(match state.line_cap {
        CanvasLineCap::Butt => skia::PaintCap::Butt,
        CanvasLineCap::Round => skia::PaintCap::Round,
        CanvasLineCap::Square => skia::PaintCap::Square,
    });
    paint.set_stroke_join(match state.line_join {
        CanvasLineJoin::Miter => skia::PaintJoin::Miter,
        CanvasLineJoin::Round => skia::PaintJoin::Round,
        CanvasLineJoin::Bevel => skia::PaintJoin::Bevel,
    });
    paint.set_stroke_miter(state.miter_limit);
    if !state.line_dash.is_empty() {
        // Preparation has already rejected invalid intervals and overflowing
        // cycles. A native allocation failure must reject this transaction,
        // rather than silently publishing a solid stroke.
        let effect = skia::PathEffect::dash(&state.line_dash, state.line_dash_offset)
            .ok_or(RenderError::Unsupported("skia-canvas-line-dash"))?;
        paint.set_path_effect(effect);
    }
    Ok(())
}

#[cfg(feature = "skia-backend")]
fn draw_native_canvas_path(
    canvas: &skia::Canvas,
    path: &skia::Path,
    paint: &skia::Paint,
) -> Result<(), RenderError> {
    if let Some(effect) = paint.path_effect() {
        let Some(cull) = canvas.local_clip_bounds() else {
            return Ok(());
        };
        let stroke = skia::StrokeRec::from_paint(paint, None, None);
        // Skia limits dash expansion to a million segments. Its Canvas draw
        // method has no result channel for that rejection, so run the effect
        // once explicitly and publish no bitmap/history when it fails.
        let (mut filtered, stroke) = effect
            .filter_path(path, &stroke, cull)
            .ok_or(RenderError::Unsupported("skia-canvas-dash-complexity"))?;
        let mut filtered_paint = paint.clone();
        filtered_paint.set_path_effect(None);
        stroke.apply_to_paint(&mut filtered_paint);
        canvas.draw_path(&filtered.detach(), &filtered_paint);
    } else {
        canvas.draw_path(path, paint);
    }
    Ok(())
}

#[cfg(feature = "skia-backend")]
fn draw_native_canvas_text(
    canvas: &skia::Canvas,
    text: &str,
    origin: (f32, f32),
    state: &CanvasRasterState,
    fonts: &mut NativeFonts,
    paint: &skia::Paint,
) -> Result<(), RenderError> {
    for (line_index, line) in text.split('\n').enumerate() {
        let mut width = 0.0_f64;
        let mut ascent = 0.0_f32;
        let mut descent = 0.0_f32;
        for character in line.chars() {
            if character == '\r' {
                continue;
            }
            if character == '\t' {
                width += f64::from(state.font_size) * 2.0;
                continue;
            }
            if let Some(font) = fonts.for_character(character, state.font_size) {
                let mut encoded = [0; 4];
                let advance = font
                    .measure_str(character.encode_utf8(&mut encoded), Some(paint))
                    .0;
                let metrics = font.metrics().1;
                if !advance.is_finite()
                    || !metrics.ascent.is_finite()
                    || !metrics.descent.is_finite()
                {
                    return Err(RenderError::InvalidCanvas(
                        "native canvas text metrics exceed finite scalar limits".into(),
                    ));
                }
                width += f64::from(advance);
                ascent = ascent.max(-metrics.ascent);
                descent = descent.max(metrics.descent);
            } else {
                // Match the existing per-character missing-glyph renderer.
                width += f64::from(state.font_size) * 0.75;
                ascent = ascent.max(state.font_size);
            }
        }
        let x = match state.text_align {
            CanvasTextAlign::Start | CanvasTextAlign::Left => f64::from(origin.0),
            CanvasTextAlign::Center => f64::from(origin.0) - width * 0.5,
            CanvasTextAlign::End | CanvasTextAlign::Right => f64::from(origin.0) - width,
        };
        // FontMetrics uses an alphabetic origin. Hanging and ideographic use
        // the conventional ascent/descent fallback because Skia's metrics
        // do not expose script-specific BASE table baselines.
        let baseline_offset = match state.text_baseline {
            CanvasTextBaseline::Alphabetic => 0.0,
            CanvasTextBaseline::Top => ascent,
            CanvasTextBaseline::Hanging => ascent * 0.8,
            CanvasTextBaseline::Middle => (ascent - descent) * 0.5,
            CanvasTextBaseline::Ideographic | CanvasTextBaseline::Bottom => -descent,
        };
        let y = f64::from(origin.1)
            + f64::from(baseline_offset)
            + line_index as f64 * f64::from(state.font_size) * 1.2;
        if [
            width,
            x,
            y,
            x + width,
            y - f64::from(state.font_size),
            y + f64::from(descent),
        ]
        .iter()
        .any(|value| !value.is_finite() || value.abs() > f64::from(f32::MAX))
        {
            return Err(RenderError::InvalidCanvas(
                "native canvas text layout exceeds finite scalar limits".into(),
            ));
        }
        native_raster::draw_native_text(
            canvas,
            line,
            (x as f32, y as f32),
            state.font_size,
            fonts,
            paint,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CanvasRasterState, PageRenderMode, Renderer, SkiaRenderer, ValidatedPageRenderMode,
    };

    fn style_frame(commands: &[(&str, serde_json::Value)]) -> CanvasFrame {
        CanvasFrame {
            frame_id: 1,
            canvas_id: "native-styles".into(),
            width: 64,
            height: 48,
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

    #[test]
    fn reserve_preserves_pixels_but_resets_style_path_ctm_and_save_stack() {
        use serde_json::json;
        let mut service = CanvasService::default();
        service
            .commit(style_frame(&[
                ("setFillStyle", json!(["red"])),
                ("fillRect", json!([0, 0, 2, 2])),
                ("moveTo", json!([0, 20])),
                ("lineTo", json!([20, 20])),
                ("save", json!([])),
                ("translate", json!([32, 0])),
                ("setGlobalAlpha", json!([0.25])),
                ("setLineDash", json!([[2, 2]])),
            ]))
            .unwrap();
        let mut next = style_frame(&[
            ("restore", json!([])),
            ("fillRect", json!([4, 0, 2, 2])),
            ("stroke", json!([])),
        ]);
        next.reserve = true;
        let image = service.commit(next).unwrap();
        let pixel = |x: usize, y: usize| &image.pixels[(y * 64 + x) * 4..(y * 64 + x) * 4 + 4];
        assert_eq!(pixel(0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(4, 0), [0, 0, 0, 255]);
        assert_eq!(pixel(36, 0), [0, 0, 0, 0]);
        assert_eq!(pixel(10, 20), [0, 0, 0, 0]);
        assert_eq!(service.batch_starts["native-styles"], [8]);
        let mut empty = style_frame(&[]);
        empty.reserve = true;
        service.commit(empty).unwrap();
        assert_eq!(
            service.batch_starts["native-styles"],
            [8],
            "empty reserve must not grow markers"
        );
    }

    #[test]
    fn history_and_save_budgets_reject_before_backend_and_preserve_accepted_state() {
        use serde_json::json;
        let mut service = CanvasService::default();
        let accepted = style_frame(&[
            ("setFillStyle", json!(["red"])),
            ("fillRect", json!([0, 0, 2, 2])),
        ]);
        let image = service.commit(accepted.clone()).unwrap();
        let mut rejected = style_frame(&[]);
        rejected.reserve = true;
        rejected.commands = vec![
            CanvasCommand {
                op: "save".into(),
                args: vec![]
            };
            257
        ];
        assert_eq!(
            service.commit_with_backend(rejected, |_, _| panic!("save budget entered backend")),
            Err(RenderError::InvalidCanvas(
                "canvas save depth budget exceeded".into()
            ))
        );
        let mut rejected = style_frame(&[]);
        rejected.reserve = true;
        rejected.commands = vec![
            CanvasCommand {
                op: "restore".into(),
                args: vec![]
            };
            PreparedCanvasBatch::MAX_COMMANDS - 2
        ];
        assert_eq!(
            service.commit_with_backend(rejected, |_, _| panic!("history budget entered backend")),
            Err(RenderError::InvalidCanvas(
                "canvas command budget exceeded".into()
            ))
        );
        let rejected = style_frame(&[(
            "fillText",
            json!(["a".repeat(PreparedCanvasBatch::MAX_COMMAND_BYTES), 0, 0]),
        )]);
        assert_eq!(
            service.commit_with_backend(rejected, |_, _| panic!("byte budget entered backend")),
            Err(RenderError::InvalidCanvas(
                "canvas command byte budget exceeded".into()
            ))
        );
        assert_eq!(service.snapshot("native-styles"), Some(image));
        assert_eq!(service.commands["native-styles"], accepted.commands);
        assert!(service.batch_starts["native-styles"].is_empty());
    }

    #[test]
    fn cumulative_geometry_and_draw_work_reject_before_backend_and_preserve_pixels() {
        use serde_json::json;
        let mut service = CanvasService::default();
        let accepted = style_frame(&[("fillRect", json!([0, 0, 2, 2]))]);
        let image = service.commit(accepted.clone()).unwrap();
        let mut curves = style_frame(&[]);
        for _ in 0..1000 {
            curves.commands.extend(
                style_frame(&[
                    ("moveTo", json!([0, 0])),
                    ("bezierCurveTo", json!([0, 1000, 1000, 1000, 1000, 0])),
                ])
                .commands,
            );
        }
        assert_eq!(
            service.commit_with_backend(curves, |_, _| panic!("geometry budget entered backend")),
            Err(RenderError::InvalidCanvas(
                "canvas geometry vertex budget exceeded".into()
            ))
        );
        for op in ["fillRect", "clearRect", "strokeRect"] {
            let mut frame = style_frame(&[]);
            frame.width = 1024;
            frame.height = 1024;
            frame.commands = vec![
                CanvasCommand {
                    op: op.into(),
                    args: vec![json!(0), json!(0), json!(1), json!(1)]
                };
                60
            ];
            assert_eq!(
                service.commit_with_backend(frame, |_, _| panic!(
                    "rectangle work budget entered backend"
                )),
                Err(RenderError::InvalidCanvas(
                    "canvas geometry work budget exceeded".into()
                ))
            );
        }
        for op in ["fill", "stroke"] {
            let mut frame = style_frame(&[("rect", json!([0, 0, 1, 1]))]);
            frame.width = 1024;
            frame.height = 1024;
            frame.commands.extend(vec![
                CanvasCommand {
                    op: op.into(),
                    args: vec![]
                };
                60
            ]);
            assert_eq!(
                service
                    .commit_with_backend(frame, |_, _| panic!("path work budget entered backend")),
                Err(RenderError::InvalidCanvas(
                    "canvas geometry work budget exceeded".into()
                ))
            );
        }
        for op in ["fillText", "strokeText"] {
            let mut frame = style_frame(&[
                ("setFontSize", json!([512])),
                (op, json!(["a".repeat(100), 0, 0])),
            ]);
            frame.width = 1024;
            frame.height = 1024;
            assert_eq!(
                service
                    .commit_with_backend(frame, |_, _| panic!("text work budget entered backend")),
                Err(RenderError::InvalidCanvas(
                    "canvas geometry work budget exceeded".into()
                ))
            );
        }
        assert_eq!(service.snapshot("native-styles"), Some(image));
        assert_eq!(service.commands["native-styles"], accepted.commands);
        assert!(service.batch_starts["native-styles"].is_empty());
    }

    #[test]
    fn surface_admission_counts_native_placeholder_axes_and_preserves_previous_frame() {
        let mut service = CanvasService::default();
        let accepted = style_frame(&[("fillRect", serde_json::json!([0, 0, 2, 2]))]);
        let image = service.commit(accepted.clone()).unwrap();
        for (width, height) in [(4096, 1025), (4_194_305, 0), (0, 4_194_305)] {
            let mut frame = style_frame(&[]);
            frame.width = width;
            frame.height = height;
            assert_eq!(
                service.commit_with_backend(frame, |_, _| panic!("surface budget entered backend")),
                Err(RenderError::InvalidCanvas(
                    "canvas surface byte budget exceeded".into()
                ))
            );
        }
        for (width, height, bytes) in [
            (4096, 1024, 16 * 1024 * 1024),
            (4_194_304, 0, 0),
            (0, 4_194_304, 0),
            (0, 0, 0),
            (1, 1, 4),
        ] {
            let mut frame = style_frame(&[]);
            frame.width = width;
            frame.height = height;
            let prepared = PreparedCanvasBatch::prepare(&frame).unwrap();
            assert_eq!(prepared.byte_len, bytes);
            assert_eq!(prepared.width, width);
            assert_eq!(prepared.height, height);
        }
        assert_eq!(service.snapshot("native-styles"), Some(image));
        assert_eq!(service.commands["native-styles"], accepted.commands);
    }

    #[test]
    fn derived_coordinate_and_inverse_overflow_reject_but_singular_stroke_is_empty() {
        use serde_json::json;
        let mut service = CanvasService::default();
        for commands in [
            vec![("scale", json!([f32::MAX, 1])), ("scale", json!([2, 1]))],
            vec![
                ("scale", json!([2, 1])),
                ("quadraticCurveTo", json!([f32::MAX, 0, 1, 1])),
            ],
            vec![
                ("scale", json!([2, 1])),
                ("bezierCurveTo", json!([1, 1, f32::MAX, 0, 1, 1])),
            ],
            vec![("fillRect", json!([f32::MAX, 0, f32::MAX, 1]))],
            vec![
                ("scale", json!([2, 1])),
                (
                    "arc",
                    json!([
                        0,
                        0,
                        f32::MAX,
                        std::f64::consts::FRAC_PI_2,
                        std::f64::consts::FRAC_PI_2
                    ]),
                ),
            ],
            vec![("scale", json!([1e-40, 1])), ("stroke", json!([]))],
            vec![
                ("moveTo", json!([f32::MAX, 0])),
                ("lineTo", json!([f32::MAX, 1])),
                ("scale", json!([0.5, 1])),
                ("stroke", json!([])),
            ],
            vec![
                ("moveTo", json!([0, 0])),
                ("bezierCurveTo", json!([0, 1e30, 1e30, 1e30, 1e30, 0])),
            ],
            vec![("arc", json!([0, 0, 1e30, 0, std::f64::consts::TAU]))],
        ] {
            assert!(matches!(
                service.commit_with_backend(style_frame(&commands), |_, _| panic!(
                    "derived invalid geometry entered backend"
                )),
                Err(RenderError::InvalidCanvas(_))
            ));
        }
        assert!(service.commands.is_empty());
        assert!(service.snapshots.is_empty());
        let frame = style_frame(&[
            ("moveTo", json!([2, 2])),
            ("lineTo", json!([32, 2])),
            ("scale", json!([0, 1])),
            ("stroke", json!([])),
        ]);
        let image = service.commit(frame).unwrap();
        assert!(image.pixels.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn save_budget_restarts_at_each_host_only_draw_boundary() {
        let mut service = CanvasService::default();
        for reserve in [false, true] {
            let mut frame = style_frame(&[]);
            frame.reserve = reserve;
            frame.commands = vec![
                CanvasCommand {
                    op: "save".into(),
                    args: vec![]
                };
                PreparedCanvasBatch::MAX_SAVE_DEPTH
            ];
            service.commit(frame).unwrap();
        }
        assert_eq!(service.batch_starts["native-styles"], [256]);
        for op in ["ResetState", "resetState"] {
            assert_eq!(
                CanvasCommand::from_value(&serde_json::json!({"op":op,"args":[]})),
                Err(RenderError::UnsupportedCanvasCommand(op.into()))
            );
        }
        assert_eq!(CanvasRasterState::default().font_size, 10.0);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_internal_reset_preserves_callers_clip_matrix_and_save_depth() {
        use serde_json::json;
        let mut surface = skia::surfaces::raster_n32_premul((64, 56)).unwrap();
        let canvas = surface.canvas();
        canvas.clear(skia::Color::TRANSPARENT);
        canvas.save();
        canvas.translate((8, 0));
        canvas.clip_rect(skia::Rect::from_xywh(0.0, 0.0, 8.0, 8.0), None, false);
        let depth = canvas.save_count();
        let matrix = canvas.local_to_device();
        let clip = canvas.local_clip_bounds();
        let frame = style_frame(&[
            ("setFillStyle", json!(["red"])),
            ("save", json!([])),
            ("translate", json!([100, 0])),
            ("restore", json!([])),
            ("restore", json!([])),
            ("fillRect", json!([0, 0, 64, 56])),
        ]);
        let prepared = PreparedCanvasBatch::prepare_batches(&frame, &[4]).unwrap();
        execute_native_canvas(canvas, &prepared, &mut NativeFonts::new()).unwrap();
        assert_eq!(canvas.save_count(), depth);
        assert_eq!(canvas.local_to_device(), matrix);
        assert_eq!(canvas.local_clip_bounds(), clip);
        let image = native_raster::readback_native(&mut surface, 1, 64, 56).unwrap();
        assert_eq!(
            &image.pixels[(2 * 64 + 10) * 4..(2 * 64 + 10) * 4 + 4],
            [0, 0, 0, 255]
        );
        assert_eq!(image.pixels[(2 * 64 + 2) * 4 + 3], 0);
        assert_eq!(image.pixels[(2 * 64 + 20) * 4 + 3], 0);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_error_restores_callers_clip_matrix_and_save_depth() {
        use serde_json::json;
        let mut surface = skia::surfaces::raster_n32_premul((64, 56)).unwrap();
        let canvas = surface.canvas();
        canvas.save();
        canvas.translate((8, 0));
        canvas.clip_rect(skia::Rect::from_xywh(0.0, 0.0, 8.0, 8.0), None, false);
        let depth = canvas.save_count();
        let matrix = canvas.local_to_device();
        let clip = canvas.local_clip_bounds();
        let frame = style_frame(&[
            ("save", json!([])),
            ("translate", json!([1, 0])),
            ("setLineDash", json!([[1e-8, 1e-8]])),
            ("moveTo", json!([0, 2])),
            ("lineTo", json!([64, 2])),
            ("stroke", json!([])),
        ]);
        let prepared = PreparedCanvasBatch::prepare(&frame).unwrap();
        assert_eq!(
            execute_native_canvas(canvas, &prepared, &mut NativeFonts::new()),
            Err(RenderError::Unsupported("skia-canvas-dash-complexity"))
        );
        assert_eq!(canvas.save_count(), depth);
        assert_eq!(canvas.local_to_device(), matrix);
        assert_eq!(canvas.local_clip_bounds(), clip);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_zero_width_strokes_match_software_zero_coverage() {
        use serde_json::json;
        let frame = style_frame(&[
            ("setLineWidth", json!([0])),
            ("moveTo", json!([2, 2])),
            ("lineTo", json!([30, 2])),
            ("stroke", json!([])),
            ("strokeRect", json!([4, 4, 20, 20])),
            ("strokeText", json!(["A", 4, 20])),
        ]);
        let software = crate::rasterize_canvas(&frame).unwrap();
        let native = CanvasService::default().commit(frame).unwrap();
        assert!(software.pixels.iter().all(|value| *value == 0));
        assert_eq!(native.pixels, software.pixels);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_dashed_line_matches_software_interior_pixels_and_restores_saved_style() {
        use serde_json::json;

        for offset in [-2.0, 0.0, 2.0] {
            let frame = style_frame(&[
                ("setLineWidth", json!([2])),
                ("setLineDash", json!([[2, 2], offset])),
                ("save", json!([])),
                ("setLineDash", json!([[]])),
                ("beginPath", json!([])),
                ("moveTo", json!([0, 6])),
                ("lineTo", json!([16, 6])),
                ("stroke", json!([])),
                ("restore", json!([])),
                ("beginPath", json!([])),
                ("moveTo", json!([0, 2])),
                ("lineTo", json!([16, 2])),
                ("stroke", json!([])),
            ]);
            let expected = crate::rasterize_canvas(&frame).unwrap();
            let actual = CanvasService::default().commit(frame).unwrap();
            let alpha = |snapshot: &RenderSnapshot, x: usize, y: usize| {
                snapshot.pixels[(y * snapshot.width as usize + x) * 4 + 3]
            };
            for x in 0..16 {
                assert_eq!(alpha(&actual, x, 1), alpha(&expected, x, 1));
                assert_eq!(alpha(&actual, x, 5), 255);
            }
            assert!((0..16).any(|x| alpha(&actual, x, 1) == 0));
            assert!((0..16).any(|x| alpha(&actual, x, 1) == 255));
        }
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_text_alignment_and_baselines_apply_to_fill_and_stroke_and_restore() {
        use serde_json::json;

        // Use the renderer's explicit missing-font path: the glyph oracle is
        // deterministic and all positioning is independent of OS font choice.
        let draw = |commands: &[(&str, serde_json::Value)]| {
            let mut service = CanvasService {
                native_fonts: NativeFonts::from_manager(skia::FontMgr::empty()),
                ..Default::default()
            };
            service.commit(style_frame(commands)).unwrap()
        };
        for text_op in ["fillText", "strokeText"] {
            for (align, x) in [
                ("start", 32.0),
                ("left", 32.0),
                ("center", 20.0),
                ("end", 8.0),
                ("right", 8.0),
            ] {
                for (baseline, y) in [
                    ("alphabetic", 16.0),
                    ("top", 32.0),
                    ("hanging", 28.8),
                    ("middle", 24.0),
                    ("ideographic", 16.0),
                    ("bottom", 16.0),
                ] {
                    let actual = draw(&[
                        ("setFontSize", json!([16])),
                        ("setTextAlign", json!([align])),
                        ("setTextBaseline", json!([baseline])),
                        (text_op, json!(["AA", 32, 16])),
                    ]);
                    let expected =
                        draw(&[("setFontSize", json!([16])), (text_op, json!(["AA", x, y]))]);
                    assert_eq!(
                        actual.pixels, expected.pixels,
                        "native {text_op}/{align}/{baseline} positioning"
                    );
                    assert!(actual.pixels.chunks(4).any(|pixel| pixel[3] != 0));
                }
            }
            let restored = draw(&[
                ("setFontSize", json!([16])),
                ("save", json!([])),
                ("setTextAlign", json!(["right"])),
                ("setTextBaseline", json!(["top"])),
                ("restore", json!([])),
                (text_op, json!(["AA", 8, 16])),
            ]);
            let expected = draw(&[
                ("setFontSize", json!([16])),
                (text_op, json!(["AA", 8, 16])),
            ]);
            assert_eq!(restored.pixels, expected.pixels);
        }
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_style_frames_preserve_atomic_history_and_service_isolation() {
        use serde_json::json;

        let mut first = CanvasService::default();
        let mut accepted = style_frame(&[
            ("setLineDash", json!([[2, 2]])),
            ("setTextAlign", json!(["center"])),
            ("setTextBaseline", json!(["middle"])),
            ("fillRect", json!([0, 0, 4, 4])),
        ]);
        let snapshot = first.commit(accepted.clone()).unwrap();
        let second = CanvasService::default();
        assert!(second.snapshot("native-styles").is_none());
        accepted.frame_id = 2;
        accepted.reserve = true;
        accepted.commands.push(CanvasCommand {
            op: "setLineDash".into(),
            args: vec![json!([1e100, 1])],
        });
        canvas_work_probes::reset();
        assert!(matches!(
            first.commit(accepted),
            Err(RenderError::InvalidCanvas(_))
        ));
        assert_eq!(canvas_work_probes::counts(), Default::default());
        assert_eq!(first.snapshot("native-styles"), Some(snapshot));
        assert_eq!(first.commands["native-styles"].len(), 4);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_dash_expansion_rejection_preserves_committed_history_and_pixels() {
        use serde_json::json;

        let mut service = CanvasService::default();
        let accepted = style_frame(&[("fillRect", json!([0, 0, 4, 4]))]);
        let snapshot = service.commit(accepted.clone()).unwrap();
        for commands in [
            vec![
                ("setLineDash", json!([[1e-8, 1e-8]])),
                ("beginPath", json!([])),
                ("moveTo", json!([0, 2])),
                ("lineTo", json!([64, 2])),
                ("stroke", json!([])),
            ],
            vec![
                ("setLineDash", json!([[1e-8, 1e-8]])),
                ("strokeRect", json!([0, 0, 32, 32])),
            ],
        ] {
            let mut rejected = style_frame(&commands);
            rejected.reserve = true;
            assert_eq!(
                service.commit(rejected),
                Err(RenderError::Unsupported("skia-canvas-dash-complexity"))
            );
            assert_eq!(service.snapshot("native-styles"), Some(snapshot.clone()));
            assert_eq!(service.commands["native-styles"], accepted.commands);
        }
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_compound_text_rejections_never_replace_committed_pixels_or_history() {
        use serde_json::json;

        let mut service = CanvasService {
            native_fonts: NativeFonts::from_manager(skia::FontMgr::empty()),
            ..Default::default()
        };
        let accepted = style_frame(&[("fillRect", json!([0, 0, 4, 4]))]);
        let snapshot = service.commit(accepted.clone()).unwrap();
        let dashed_text = style_frame(&[
            ("setLineDash", json!([[2, 2]])),
            ("strokeText", json!(["A", 8, 16])),
        ]);
        assert_eq!(
            service.commit(dashed_text),
            Err(RenderError::UnsupportedCanvasCommand(
                "strokeText with line dash".into()
            ))
        );
        let oversized_text = style_frame(&[
            ("setFontSize", json!([f32::MAX])),
            ("fillText", json!(["AA", 0, 16])),
        ]);
        assert!(matches!(
            service.commit(oversized_text),
            Err(RenderError::InvalidCanvas(_))
        ));
        assert_eq!(service.snapshot("native-styles"), Some(snapshot));
        assert_eq!(service.commands["native-styles"], accepted.commands);
    }

    #[test]
    fn owned_transfer_preserves_allocations_and_the_borrowed_ids_api() -> Result<(), RenderError> {
        let mut service = CanvasService::default();
        let accepted = service.commit(CanvasFrame {
            frame_id: 1,
            canvas_id: "owned".into(),
            width: 1,
            height: 1,
            reserve: false,
            commands: vec![
                CanvasCommand {
                    op: "setFillStyle".into(),
                    args: vec![serde_json::json!("red")],
                },
                CanvasCommand {
                    op: "fillRect".into(),
                    args: vec![
                        serde_json::json!(0),
                        serde_json::json!(0),
                        serde_json::json!(1),
                        serde_json::json!(1),
                    ],
                },
            ],
        })?;
        let pixels = service
            .snapshots
            .get("owned")
            .map(|frame| frame.pixels.as_ptr());
        let commands = service.commands.get("owned").map(|batch| batch.as_ptr());
        assert!(pixels.is_some());
        assert!(commands.is_some());
        let mode = ValidatedPageRenderMode::new(PageRenderMode::ExternalFrame)?;
        let renderer = SkiaRenderer::new_with_validated_mode_and_canvas(mode, service);
        assert_eq!(
            renderer
                .canvas
                .snapshots
                .get("owned")
                .map(|frame| frame.pixels.as_ptr()),
            pixels
        );
        assert_eq!(
            renderer
                .canvas
                .commands
                .get("owned")
                .map(|batch| batch.as_ptr()),
            commands
        );
        assert_eq!(renderer.canvas_snapshot("owned"), Some(accepted));
        assert_eq!(renderer.canvas_ids().collect::<Vec<_>>(), ["owned"]);
        assert_eq!(renderer.snapshot_revision(), 0);
        assert!(renderer.last_frame().is_none());
        assert!(!renderer.has_native_surface());
        assert!(!renderer.has_gpu_surface());
        Ok(())
    }
}

#[cfg(all(test, feature = "skia-backend"))]
#[path = "canvas_affine_native_tests.rs"]
mod affine_native_tests;

#[cfg(all(test, feature = "skia-backend"))]
#[path = "canvas_arcto_native_tests.rs"]
mod arcto_native_tests;
