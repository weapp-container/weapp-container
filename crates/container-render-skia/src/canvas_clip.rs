//! Device-space current-path clipping. Admission tracks mask generations without
//! allocating pixels; portable replay intersects immutable packed coverage masks.

use super::canvas_batch::{PreparedCanvasBatch, PreparedCanvasCommand};
use super::RenderError;

pub(super) struct Budget {
    current: Option<usize>,
    saved: Vec<Option<usize>>,
    generation: usize,
    mask_bytes: u64,
}

impl Budget {
    pub(super) fn new(pixels: u64) -> Self {
        Self {
            current: None,
            saved: Vec::new(),
            generation: 0,
            mask_bytes: pixels.div_ceil(64) * 8,
        }
    }

    pub(super) fn has_clip(&self) -> bool {
        self.current.is_some()
    }

    pub(super) fn admit(&mut self, command: &PreparedCanvasCommand) -> Result<(), RenderError> {
        match command {
            PreparedCanvasCommand::ResetState => {
                self.current = None;
                self.saved.clear();
            }
            PreparedCanvasCommand::Save => self.saved.push(self.current),
            PreparedCanvasCommand::Restore => {
                if let Some(saved) = self.saved.pop() {
                    self.current = saved;
                }
            }
            PreparedCanvasCommand::Clip => {
                let live = self
                    .saved
                    .iter()
                    .copied()
                    .chain(std::iter::once(self.current))
                    .flatten()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len() as u64;
                // Vec -> Arc<[u64]> copies into a new allocation. Charge both
                // new buffers while all old live masks still exist.
                if (live + 2) * self.mask_bytes > PreparedCanvasBatch::MAX_CLIP_BYTES {
                    return Err(RenderError::InvalidCanvas(
                        "canvas clip memory budget exceeded".into(),
                    ));
                }
                self.generation += 1;
                self.current = Some(self.generation);
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(any(not(feature = "skia-backend"), test))]
pub(super) fn allows(mask: Option<&[u64]>, index: usize) -> bool {
    mask.is_none_or(|mask| mask[index / 64] & (1 << (index % 64)) != 0)
}

#[cfg(any(not(feature = "skia-backend"), test))]
fn contains(path: &super::CanvasPath, x: f64, y: f64) -> bool {
    let mut winding = 0i32;
    for contour in &path.subpaths {
        if contour.len() < 3 {
            continue;
        }
        // All fill contours close implicitly. Sum across contours so opposite
        // winding makes holes and repeated same-direction contours stay filled.
        for index in 0..contour.len() {
            let a = contour[index];
            let b = contour[(index + 1) % contour.len()];
            let (ax, ay, bx, by) = (
                f64::from(a.x),
                f64::from(a.y),
                f64::from(b.x),
                f64::from(b.y),
            );
            let cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
            if ay <= y && by > y && cross > 0.0 {
                winding += 1;
            } else if ay > y && by <= y && cross < 0.0 {
                winding -= 1;
            }
        }
    }
    winding != 0
}

#[cfg(any(not(feature = "skia-backend"), test))]
pub(super) fn intersect(
    path: &super::CanvasPath,
    previous: Option<&[u64]>,
    width: u32,
    height: u32,
) -> std::sync::Arc<[u64]> {
    let count = width as usize * height as usize;
    let mut mask = vec![0u64; count.div_ceil(64)];
    for y in 0..height {
        for x in 0..width {
            let index = y as usize * width as usize + x as usize;
            if allows(previous, index) && contains(path, f64::from(x) + 0.5, f64::from(y) + 0.5) {
                mask[index / 64] |= 1 << (index % 64);
            }
        }
    }
    mask.into()
}
