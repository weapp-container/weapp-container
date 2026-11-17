//! Tangent-circle construction shared by admission and both Canvas executors.
//!
//! Paths store construction-time transformed points. An arcTo's radius belongs
//! to its current user space, so recover the old endpoint through that CTM's
//! inverse and solve there in f64. A positive-weight rational quadratic exactly
//! represents the tangent arc and remains a conic under every affine transform.
//! Canonical replay stores the three transformed points and the invariant weight;
//! neither executor recomputes tangents, a circle center, or f32 start angles.

use super::{
    canvas_batch::PreparedCanvasCommand, CanvasPath, CanvasPoint, CanvasTransform, RenderError,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct TangentArc {
    pub(super) start: CanvasPoint,
    pub(super) control: CanvasPoint,
    pub(super) end: CanvasPoint,
    pub(super) weight: f32,
}

pub(super) fn lower(
    [x1, y1, x2, y2, radius]: [f32; 5],
    current: Option<CanvasPoint>,
    transform: CanvasTransform,
) -> Result<PreparedCanvasCommand, RenderError> {
    let Some(current) = current else {
        return Ok(PreparedCanvasCommand::MoveTo([x1, y1]));
    };
    // These cases need no inverse and remain defined under a singular CTM.
    if radius == 0.0 || (x1 == x2 && y1 == y2) {
        return Ok(PreparedCanvasCommand::LineTo([x1, y1]));
    }
    let [a, b, c, d, e, f] = [
        transform.a,
        transform.b,
        transform.c,
        transform.d,
        transform.e,
        transform.f,
    ]
    .map(f64::from);
    let determinant = a * d - b * c;
    if determinant == 0.0 || !determinant.is_finite() {
        return Err(invalid(
            "canvas arcTo requires an invertible current transform",
        ));
    }
    // Subtract the translation before division: materializing a rounded f32
    // inverse can overflow or lose an otherwise representable old endpoint.
    let px = f64::from(current.x) - e;
    let py = f64::from(current.y) - f;
    let p0 = [
        (d * px - c * py) / determinant,
        (a * py - b * px) / determinant,
    ];
    let p1 = [f64::from(x1), f64::from(y1)];
    let p2 = [f64::from(x2), f64::from(y2)];
    if p0.iter().any(|value| !value.is_finite()) {
        return Err(invalid("canvas arcTo inverse point exceeds numeric limits"));
    }
    let u = [p0[0] - p1[0], p0[1] - p1[1]];
    let v = [p2[0] - p1[0], p2[1] - p1[1]];
    let (u_len, v_len) = (u[0].hypot(u[1]), v[0].hypot(v[1]));
    if u_len == 0.0 || v_len == 0.0 {
        return Ok(PreparedCanvasCommand::LineTo([x1, y1]));
    }
    let u = [u[0] / u_len, u[1] / u_len];
    let v = [v[0] / v_len, v[1] / v_len];
    let cross = u[0] * v[1] - u[1] * v[0];
    let dot = (u[0] * v[0] + u[1] * v[1]).clamp(-1.0, 1.0);
    if cross == 0.0 {
        return Ok(PreparedCanvasCommand::LineTo([x1, y1]));
    }
    // cot(theta/2), choosing the stable identity at either end of (0, PI).
    // Tangent distances must not be clamped to the control segments.
    let cot_half = if dot > 0.0 {
        (1.0 + dot) / cross.abs()
    } else {
        cross.abs() / (1.0 - dot)
    };
    let distance = f64::from(radius) * cot_half;
    let start = [p1[0] + u[0] * distance, p1[1] + u[1] * distance];
    let end = [p1[0] + v[0] * distance, p1[1] + v[1] * distance];
    let weight = if dot > 0.0 {
        cross.abs() / (2.0 * (1.0 + dot)).sqrt()
    } else {
        ((1.0 - dot) * 0.5).sqrt()
    } as f32;
    if !weight.is_finite() || weight <= 0.0 {
        return Err(invalid(
            "canvas arcTo conic weight exceeds native scalar limits",
        ));
    }
    let map = |[x, y]: [f64; 2]| -> Result<CanvasPoint, RenderError> {
        let [x, y] = [a * x + c * y + e, b * x + d * y + f];
        if [x, y]
            .iter()
            .any(|value| !value.is_finite() || !(*value as f32).is_finite())
        {
            return Err(invalid("canvas arcTo tangent exceeds finite scalar limits"));
        }
        Ok(CanvasPoint {
            x: x as f32,
            y: y as f32,
        })
    };
    Ok(PreparedCanvasCommand::ConicArcTo(TangentArc {
        start: map(start)?,
        control: map(p1)?,
        end: map(end)?,
        weight,
    }))
}

/// Positive homogeneous weights keep each subdivision in the convex hull.
/// Projected-control distance to the chord segment bounds the rational curve;
/// f64 interpolation avoids products overflowing the finite f32 input domain.
pub(super) fn append(path: &mut CanvasPath, arc: TangentArc) {
    fn project([x, y, weight]: [f64; 3]) -> [f64; 2] {
        [x / weight, y / weight]
    }
    fn midpoint(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
        std::array::from_fn(|index| a[index] * 0.5 + b[index] * 0.5)
    }
    fn flatten(path: &mut CanvasPath, points: [[f64; 3]; 3], depth: u8) {
        if path.too_complex {
            return;
        }
        let [start, control, end] = points.map(project);
        let (dx, dy) = (end[0] - start[0], end[1] - start[1]);
        let (cx, cy) = (control[0] - start[0], control[1] - start[1]);
        let length = dx * dx + dy * dy;
        let t = if length == 0.0 {
            0.0
        } else {
            ((cx * dx + cy * dy) / length).clamp(0.0, 1.0)
        };
        if (cx - t * dx).hypot(cy - t * dy) <= 0.0625 {
            path.line_to(CanvasPoint {
                x: end[0] as f32,
                y: end[1] as f32,
            });
            return;
        }
        if depth == 12 {
            path.too_complex = true;
            return;
        }
        let left = midpoint(points[0], points[1]);
        let right = midpoint(points[1], points[2]);
        let middle = midpoint(left, right);
        flatten(path, [points[0], left, middle], depth + 1);
        flatten(path, [middle, right, points[2]], depth + 1);
    }
    path.line_to(arc.start);
    let w = f64::from(arc.weight);
    flatten(
        path,
        [
            [f64::from(arc.start.x), f64::from(arc.start.y), 1.0],
            [
                f64::from(arc.control.x) * w,
                f64::from(arc.control.y) * w,
                w,
            ],
            [f64::from(arc.end.x), f64::from(arc.end.y), 1.0],
        ],
        0,
    );
}

fn invalid(message: &str) -> RenderError {
    RenderError::InvalidCanvas(message.into())
}
