//! Pixel-bounded stroke coverage for complete Canvas subpaths.
//!
//! The geometry lives in the current user space. Path vertices were captured
//! in device space when commands ran, and are mapped back before stroking.
//! One coverage decision per pixel prevents translucent joins/intersections
//! from being blended once for every overlapping segment.

use super::{blend_pixel, CanvasLineCap, CanvasLineJoin, CanvasPath, CanvasPoint, CanvasTransform};

#[derive(Clone, Copy)]
pub(super) struct StrokeStyle<'a> {
    pub(super) color: [u8; 4],
    pub(super) width: f32,
    pub(super) cap: CanvasLineCap,
    pub(super) join: CanvasLineJoin,
    pub(super) miter_limit: f32,
    pub(super) dash: &'a [f32],
    pub(super) dash_offset: f32,
}

#[derive(Clone, Copy, Debug)]
struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn mapped(point: CanvasPoint, transform: CanvasTransform) -> Self {
        Self {
            x: f64::from(transform.a) * f64::from(point.x)
                + f64::from(transform.c) * f64::from(point.y)
                + f64::from(transform.e),
            y: f64::from(transform.b) * f64::from(point.x)
                + f64::from(transform.d) * f64::from(point.y)
                + f64::from(transform.f),
        }
    }
    fn add(self, other: Self) -> Self {
        Self {
            x: self.x + other.x,
            y: self.y + other.y,
        }
    }
    fn sub(self, other: Self) -> Self {
        Self {
            x: self.x - other.x,
            y: self.y - other.y,
        }
    }
    fn scale(self, value: f64) -> Self {
        Self {
            x: self.x * value,
            y: self.y * value,
        }
    }
    fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y
    }
    fn cross(self, other: Self) -> f64 {
        self.x * other.y - self.y * other.x
    }
    fn length(self) -> f64 {
        self.x.hypot(self.y)
    }
}

struct Segment {
    start: Point,
    direction: Point,
    length: f64,
    distance: f64,
}

struct Subpath {
    segments: Vec<Segment>,
    point: Point,
    closed: bool,
    length: f64,
}

impl Subpath {
    fn prepare(points: &[CanvasPoint], closed: bool, inverse: CanvasTransform) -> Option<Self> {
        if points.len() < 2 && !closed {
            return None;
        }
        let mut points: Vec<_> = points
            .iter()
            .copied()
            .map(|point| Point::mapped(point, inverse))
            .collect();
        points.dedup_by(|a, b| a.x == b.x && a.y == b.y);
        let point = *points.first()?;
        if closed
            && points.len() > 1
            && points
                .last()
                .is_some_and(|last| last.x != point.x || last.y != point.y)
        {
            points.push(point);
        }
        let mut segments = Vec::new();
        let mut distance = 0.0;
        for pair in points.windows(2) {
            let delta = pair[1].sub(pair[0]);
            let length = delta.length();
            if length > 0.0 && length.is_finite() {
                segments.push(Segment {
                    start: pair[0],
                    direction: delta.scale(1.0 / length),
                    length,
                    distance,
                });
                distance += length;
            }
        }
        Some(Self {
            segments,
            point,
            closed,
            length: distance,
        })
    }
}

struct Dash {
    ends: Vec<f64>,
    total: f64,
    offset: f64,
}

impl Dash {
    fn new(pattern: &[f32], offset: f32) -> Self {
        let mut total = 0.0;
        let ends = pattern
            .iter()
            .map(|value| {
                total += f64::from(*value);
                total
            })
            .collect();
        Self {
            ends,
            total,
            offset: f64::from(offset),
        }
    }
    fn solid(&self) -> bool {
        self.ends.is_empty() || self.total == 0.0
    }
    fn position(&self, distance: f64) -> f64 {
        let position = (distance + self.offset).rem_euclid(self.total);
        if position >= self.total {
            0.0
        } else {
            position
        }
    }
    fn on(&self, distance: f64, before: bool) -> bool {
        if self.solid() {
            return true;
        }
        let position = self.position(distance);
        let index = if before {
            if position == 0.0 {
                self.ends.partition_point(|end| *end < self.total)
            } else {
                self.ends.partition_point(|end| *end < position)
            }
        } else {
            self.ends.partition_point(|end| *end <= position)
        };
        index.min(self.ends.len() - 1).is_multiple_of(2)
    }
    // At most three candidates; never enumerate intervals along a huge path.
    // Zero-length on intervals remain candidates for round/square dash caps.
    fn candidates(&self, distance: f64) -> [Option<f64>; 3] {
        if self.solid() {
            return [Some(distance), None, None];
        }
        let position = self.position(distance);
        let index = self
            .ends
            .partition_point(|end| *end <= position)
            .min(self.ends.len() - 1);
        if index.is_multiple_of(2) {
            return [Some(distance), None, None];
        }
        [
            None,
            Some(distance - (position - self.ends[index - 1])),
            Some(distance + (self.ends[index] - position)),
        ]
    }
}

fn inside_polygon(point: Point, polygon: &[Point]) -> bool {
    let mut positive = false;
    let mut negative = false;
    for index in 0..polygon.len() {
        let a = polygon[index];
        let b = polygon[(index + 1) % polygon.len()];
        let cross = b.sub(a).cross(point.sub(a));
        positive |= cross > 1e-10;
        negative |= cross < -1e-10;
        if positive && negative {
            return false;
        }
    }
    true
}

fn join_contains(
    point: Point,
    previous: &Segment,
    next: &Segment,
    radius: f64,
    style: StrokeStyle<'_>,
) -> bool {
    let vertex = next.start;
    let delta = point.sub(vertex);
    let turn = previous.direction.cross(next.direction);
    let dot = previous.direction.dot(next.direction).clamp(-1.0, 1.0);
    if turn.abs() < 1e-12 {
        return dot < 0.0 && style.join == CanvasLineJoin::Round && delta.length() <= radius;
    }
    if style.join == CanvasLineJoin::Round {
        return delta.length() <= radius;
    }
    let side = if turn > 0.0 { -1.0 } else { 1.0 };
    let normal = |direction: Point| Point {
        x: -direction.y * side,
        y: direction.x * side,
    };
    let a = vertex.add(normal(previous.direction).scale(radius));
    let b = vertex.add(normal(next.direction).scale(radius));
    if style.join == CanvasLineJoin::Miter && 1.0 + dot > 1e-14 {
        let miter = vertex.add(
            normal(previous.direction)
                .add(normal(next.direction))
                .scale(radius / (1.0 + dot)),
        );
        if miter.sub(vertex).length() <= radius * f64::from(style.miter_limit) {
            return inside_polygon(point, &[vertex, a, miter, b]);
        }
    }
    inside_polygon(point, &[vertex, a, b])
}

fn covers(point: Point, path: &Subpath, radius: f64, style: StrokeStyle<'_>, dash: &Dash) -> bool {
    if path.segments.is_empty() {
        if !dash
            .candidates(0.0)
            .into_iter()
            .flatten()
            .any(|candidate| candidate == 0.0)
        {
            return false;
        }
        let point = point.sub(path.point);
        return match style.cap {
            CanvasLineCap::Butt => false,
            CanvasLineCap::Round => point.length() <= radius,
            CanvasLineCap::Square => point.x.abs() <= radius && point.y.abs() <= radius,
        };
    }
    for (index, segment) in path.segments.iter().enumerate() {
        let relative = point.sub(segment.start);
        let along = relative.dot(segment.direction);
        let perpendicular = relative.cross(segment.direction).abs();
        if perpendicular > radius {
            continue;
        }
        let target = segment.distance + along.clamp(0.0, segment.length);
        for candidate in dash.candidates(target).into_iter().flatten() {
            let local = candidate - segment.distance;
            if local < 0.0 || local > segment.length {
                continue;
            }
            if (0.0..=segment.length).contains(&along)
                && candidate == target
                && dash.on(candidate, false)
            {
                return true;
            }
            let at_start = local == 0.0;
            let at_end = local == segment.length;
            let continues_before = at_start
                && if index > 0 {
                    dash.on(candidate, true)
                } else {
                    path.closed && dash.on(path.length, true)
                };
            let continues_after = at_end
                && if index + 1 < path.segments.len() {
                    dash.on(candidate, false)
                } else {
                    path.closed && dash.on(0.0, false)
                };
            if continues_before || continues_after {
                continue;
            }
            let cap_distance = (along - local).abs();
            if match style.cap {
                CanvasLineCap::Butt => false,
                CanvasLineCap::Square => cap_distance <= radius,
                CanvasLineCap::Round => cap_distance.hypot(perpendicular) <= radius,
            } {
                return true;
            }
        }
    }
    for index in 1..path.segments.len() {
        let distance = path.segments[index].distance;
        if dash.on(distance, true)
            && dash.on(distance, false)
            && join_contains(
                point,
                &path.segments[index - 1],
                &path.segments[index],
                radius,
                style,
            )
        {
            return true;
        }
    }
    path.closed
        && dash.on(path.length, true)
        && dash.on(0.0, false)
        && join_contains(
            point,
            path.segments.last().unwrap(),
            &path.segments[0],
            radius,
            style,
        )
}

pub(super) fn draw(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    path: &CanvasPath,
    transform: CanvasTransform,
    clip: Option<&[u64]>,
    style: StrokeStyle<'_>,
) {
    if style.width <= 0.0 || style.color[3] == 0 {
        return;
    }
    let Some(inverse) = transform.inverse() else {
        return;
    };
    let paths: Vec<_> = path
        .subpaths
        .iter()
        .enumerate()
        .filter_map(|(index, points)| {
            Subpath::prepare(
                points,
                path.closed.get(index).copied().unwrap_or(false),
                inverse,
            )
        })
        .collect();
    if paths.is_empty() {
        return;
    }
    let radius = f64::from(style.width) * 0.5;
    let dash = Dash::new(style.dash, style.dash_offset);
    // Bounds are in device space; the row work is clipped to the actual target.
    let expansion = radius
        * f64::from(style.miter_limit.max(1.0))
        * f64::from(transform.a.abs() + transform.b.abs() + transform.c.abs() + transform.d.abs());
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for point in path.subpaths.iter().flatten() {
        bounds[0] = bounds[0].min(f64::from(point.x));
        bounds[1] = bounds[1].min(f64::from(point.y));
        bounds[2] = bounds[2].max(f64::from(point.x));
        bounds[3] = bounds[3].max(f64::from(point.y));
    }
    let left = (bounds[0] - expansion)
        .floor()
        .max(0.0)
        .min(f64::from(width)) as u32;
    let top = (bounds[1] - expansion)
        .floor()
        .max(0.0)
        .min(f64::from(height)) as u32;
    let right = (bounds[2] + expansion)
        .ceil()
        .max(0.0)
        .min(f64::from(width)) as u32;
    let bottom = (bounds[3] + expansion)
        .ceil()
        .max(0.0)
        .min(f64::from(height)) as u32;
    for y in top..bottom {
        for x in left..right {
            if !super::canvas_clip::allows(clip, y as usize * width as usize + x as usize) {
                continue;
            }
            let point = Point::mapped(
                CanvasPoint {
                    x: x as f32 + 0.5,
                    y: y as f32 + 0.5,
                },
                inverse,
            );
            if paths
                .iter()
                .any(|path| covers(point, path, radius, style, &dash))
            {
                let offset = (y as usize * width as usize + x as usize) * 4;
                blend_pixel(&mut pixels[offset..offset + 4], style.color);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CanvasCommand, CanvasFrame, RenderSnapshot};
    use serde_json::{json, Value};

    fn frame(commands: &[(&str, Value)]) -> CanvasFrame {
        CanvasFrame {
            frame_id: 1,
            canvas_id: "stroke-geometry".into(),
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
    fn alpha(image: &RenderSnapshot, x: usize, y: usize) -> u8 {
        image.pixels[(y * image.width as usize + x) * 4 + 3]
    }
    fn corner(join: &str, limit: f32) -> CanvasFrame {
        frame(&[
            ("setLineWidth", json!([16])),
            ("setLineJoin", json!([join])),
            ("setMiterLimit", json!([limit])),
            ("setLineCap", json!(["square"])),
            ("moveTo", json!([8, 32])),
            ("lineTo", json!([32, 32])),
            ("lineTo", json!([32, 8])),
            ("stroke", json!([])),
        ])
    }
    #[test]
    fn whole_polyline_uses_outer_join_and_miter_limit_instead_of_internal_caps() {
        for (join, limit, tip, rounded) in [
            ("miter", 10.0, 255, 255),
            ("miter", 1.0, 0, 0),
            ("bevel", 10.0, 0, 0),
            ("round", 10.0, 0, 255),
        ] {
            let image = crate::rasterize_canvas(&corner(join, limit)).unwrap();
            assert_eq!(alpha(&image, 38, 38), tip, "{join}/{limit} miter tip");
            assert_eq!(
                alpha(&image, 37, 36),
                rounded,
                "{join}/{limit} outer round quadrant"
            );
            assert_eq!(alpha(&image, 40, 40), 0);
            assert_eq!(alpha(&image, 20, 31), 255);
        }
    }
    #[test]
    fn true_endcaps_and_zero_length_dash_caps_have_independent_geometry() {
        for (cap, start, end, corner) in [
            ("butt", 0, 0, 0),
            ("round", 255, 255, 0),
            ("square", 255, 255, 255),
        ] {
            let image = crate::rasterize_canvas(&frame(&[
                ("setLineWidth", json!([8])),
                ("setLineCap", json!([cap])),
                ("moveTo", json!([12, 16])),
                ("lineTo", json!([28, 16])),
                ("stroke", json!([])),
            ]))
            .unwrap();
            assert_eq!(alpha(&image, 9, 16), start);
            assert_eq!(alpha(&image, 30, 16), end);
            assert_eq!(alpha(&image, 8, 12), corner);
        }
        for (cap, expected) in [("butt", 0), ("round", 255), ("square", 255)] {
            let image = crate::rasterize_canvas(&frame(&[
                ("setLineWidth", json!([2])),
                ("setLineCap", json!([cap])),
                ("setLineDash", json!([[0, 4]])),
                ("moveTo", json!([4, 4])),
                ("lineTo", json!([20, 4])),
                ("stroke", json!([])),
            ]))
            .unwrap();
            assert_eq!(
                alpha(&image, 8, 4),
                expected,
                "zero on interval retains {cap} cap"
            );
            assert_eq!(alpha(&image, 10, 4), 0);
        }
    }

    #[test]
    fn dash_phase_crosses_segment_boundary_and_each_subpath_restarts() {
        let image = crate::rasterize_canvas(&frame(&[
            ("setLineWidth", json!([2])),
            ("setLineDash", json!([[4, 4]])),
            ("moveTo", json!([2, 4])),
            ("lineTo", json!([7, 4])),
            ("lineTo", json!([7, 16])),
            ("moveTo", json!([15, 4])),
            ("lineTo", json!([15, 16])),
            ("stroke", json!([])),
        ]))
        .unwrap();
        assert_eq!(
            alpha(&image, 7, 6),
            0,
            "distance 7.5 stays inside the first gap"
        );
        assert_eq!(
            alpha(&image, 7, 7),
            255,
            "distance 8.5 enters the next dash"
        );
        assert_eq!(alpha(&image, 15, 6), 255, "new subpath resets phase");
    }
    #[test]
    fn translucent_join_and_self_intersection_are_one_stroke_coverage() {
        let image = crate::rasterize_canvas(&frame(&[
            ("setLineWidth", json!([8])),
            ("setGlobalAlpha", json!([0.5])),
            ("moveTo", json!([8, 8])),
            ("lineTo", json!([32, 32])),
            ("lineTo", json!([8, 32])),
            ("lineTo", json!([32, 8])),
            ("stroke", json!([])),
        ]))
        .unwrap();
        assert_eq!(alpha(&image, 20, 20), 128, "crossing must not blend twice");
        assert_eq!(alpha(&image, 29, 30), 128, "join must not blend twice");
    }
    #[test]
    fn close_only_closes_current_subpath_and_closed_seam_uses_join() {
        let image = crate::rasterize_canvas(&frame(&[
            ("setLineWidth", json!([16])),
            ("setLineCap", json!(["butt"])),
            ("moveTo", json!([16, 16])),
            ("lineTo", json!([48, 16])),
            ("lineTo", json!([48, 40])),
            ("lineTo", json!([16, 40])),
            ("closePath", json!([])),
            ("stroke", json!([])),
        ]))
        .unwrap();
        assert_eq!(
            alpha(&image, 9, 9),
            255,
            "closed seam has miter instead of two butt caps"
        );
        let mut path = CanvasPath::default();
        path.move_to(CanvasPoint { x: 1.0, y: 1.0 });
        path.line_to(CanvasPoint { x: 5.0, y: 1.0 });
        path.move_to(CanvasPoint { x: 8.0, y: 8.0 });
        path.line_to(CanvasPoint { x: 12.0, y: 8.0 });
        path.close();
        assert_eq!(path.closed, [false, true]);
        assert_eq!(path.subpaths[0].len(), 2);
    }
    #[test]
    fn command_ctm_is_captured_and_stroke_width_uses_current_ctm() {
        let image = crate::rasterize_canvas(&frame(&[
            ("save", json!([])),
            ("translate", json!([8, 0])),
            ("moveTo", json!([4, 10])),
            ("lineTo", json!([20, 10])),
            ("restore", json!([])),
            ("lineTo", json!([28, 28])),
            ("scale", json!([2, 1])),
            ("setLineWidth", json!([4])),
            ("stroke", json!([])),
        ]))
        .unwrap();
        assert_eq!(alpha(&image, 20, 10), 255);
        assert_eq!(
            alpha(&image, 30, 20),
            255,
            "vertical width is stretched by current x scale"
        );
        assert_eq!(
            alpha(&image, 56, 20),
            0,
            "previous path points must not be transformed twice"
        );
    }
    #[test]
    fn curves_flatten_to_device_tolerance_instead_of_a_fixed_twenty_segments() {
        let mut path = CanvasPath::default();
        path.move_to(CanvasPoint { x: 0.0, y: 0.0 });
        path.curve_to(&[
            CanvasPoint { x: 0.0, y: 1000.0 },
            CanvasPoint {
                x: 1000.0,
                y: 1000.0,
            },
            CanvasPoint { x: 1000.0, y: 0.0 },
        ]);
        assert!(path.subpaths[0].len() > 64);
        assert!(path.subpaths[0].len() <= 4097);
        assert_eq!(
            path.subpaths[0].last(),
            Some(&CanvasPoint { x: 1000.0, y: 0.0 })
        );
    }
    #[cfg(feature = "skia-backend")]
    #[test]
    fn skia_oracle_confirms_polyline_joins_dash_phase_and_mixed_ctm_interior_pixels() {
        let mut cases: Vec<_> = [
            ("miter", 10.0),
            ("miter", 1.0),
            ("bevel", 10.0),
            ("round", 10.0),
        ]
        .map(|(join, limit)| {
            (
                corner(join, limit),
                vec![(38, 38), (37, 36), (40, 40), (20, 31)],
            )
        })
        .into();
        cases.push((
            frame(&[
                ("setLineWidth", json!([2])),
                ("setLineDash", json!([[4, 4]])),
                ("moveTo", json!([2, 4])),
                ("lineTo", json!([7, 4])),
                ("lineTo", json!([7, 16])),
                ("stroke", json!([])),
            ]),
            vec![(7, 6), (7, 7), (7, 10)],
        ));
        cases.push((
            frame(&[
                ("save", json!([])),
                ("translate", json!([8, 0])),
                ("moveTo", json!([4, 10])),
                ("lineTo", json!([20, 10])),
                ("restore", json!([])),
                ("lineTo", json!([28, 28])),
                ("scale", json!([2, 1])),
                ("setLineWidth", json!([4])),
                ("stroke", json!([])),
            ]),
            vec![(20, 10), (30, 20), (56, 20)],
        ));
        cases.push((
            frame(&[
                ("setLineWidth", json!([16])),
                ("rect", json!([16, 16, 32, 24])),
                ("stroke", json!([])),
            ]),
            vec![(9, 9), (32, 16), (32, 28)],
        ));
        cases.push((
            frame(&[
                ("setLineWidth", json!([4])),
                ("moveTo", json!([4, 16])),
                (
                    "arc",
                    json!([20, 16, 8, std::f64::consts::PI, std::f64::consts::TAU]),
                ),
                ("stroke", json!([])),
            ]),
            vec![(8, 16), (20, 8), (20, 16)],
        ));
        for (frame, samples) in cases {
            let software = crate::rasterize_canvas(&frame).unwrap();
            let native = crate::CanvasService::default().commit(frame).unwrap();
            for (x, y) in samples {
                assert_eq!(
                    alpha(&native, x, y),
                    alpha(&software, x, y),
                    "oracle sample {x},{y}"
                );
            }
        }
    }
}
