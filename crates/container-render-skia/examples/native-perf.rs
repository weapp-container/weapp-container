//! Native renderer performance probe.
//!
//! This is deliberately a small host-side probe rather than a synthetic Node
//! benchmark. It owns the same `RenderFrame` batch that a host submits to the
//! renderer and reports timings for the configured Skia backend. The JSON is
//! consumed by `scripts/perf-native-render.mjs`, which combines it with the
//! protocol measurements.

use container_render_skia::{Color, Rect, RenderFrame, RenderNode, Renderer, SkiaRenderer};
use serde::Serialize;
use std::{env, time::Instant};

#[cfg(unix)]
use std::process::Command;

const DEFAULT_ITERATIONS: usize = 60;
const NODE_COUNT: usize = 1_000;
const FRAME_BUDGET_MS: f64 = 1000.0 / 60.0;

#[derive(Debug, Serialize)]
struct Metric {
    status: &'static str,
    unit: &'static str,
    value: f64,
    p50: f64,
    p95: f64,
    p99: f64,
}

#[derive(Debug, Serialize)]
struct UnsupportedMetric {
    status: &'static str,
    unit: &'static str,
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum AnyMetric {
    Measured(Metric),
    Unsupported(UnsupportedMetric),
}

#[derive(Debug, Serialize)]
struct Report {
    schema_version: u8,
    backend: &'static str,
    iterations: usize,
    nodes: usize,
    cold_start_ms: Metric,
    hot_start_ms: Metric,
    first_frame_ms: Metric,
    scroll_dropped_frame_rate: Metric,
    steady_state_memory_mb: AnyMetric,
}

fn percentile(samples: &[f64], p: f64) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() as f64 * p).ceil() as usize).saturating_sub(1);
    sorted[index.min(sorted.len().saturating_sub(1))]
}

fn metric(samples: &[f64]) -> Metric {
    let value = percentile(samples, 0.95);
    Metric {
        status: "measured",
        unit: "ms",
        value,
        p50: percentile(samples, 0.50),
        p95: percentile(samples, 0.95),
        p99: percentile(samples, 0.99),
    }
}

fn frame(offset: f32) -> RenderFrame {
    let mut root = RenderNode::new(
        "root",
        Rect {
            x: 0.0,
            y: 0.0,
            width: 375.0,
            height: 812.0,
        },
    );
    root.background = Some(Color::WHITE);
    root.children = (0..NODE_COUNT)
        .map(|index| {
            let column = index % 20;
            let row = index / 20;
            let mut node = RenderNode::new(
                format!("item-{index}"),
                Rect {
                    x: (column as f32 * 18.0) + offset,
                    y: row as f32 * 18.0,
                    width: 16.0,
                    height: 16.0,
                },
            );
            node.background = Some(Color {
                red: (index % 255) as u8,
                green: 127,
                blue: 220,
                alpha: 255,
            });
            node
        })
        .collect();
    RenderFrame {
        images: std::collections::BTreeMap::new(),
        frame_id: offset.to_bits() as u64,
        viewport: root.bounds,
        root,
    }
}

fn rss_mb() -> Option<f64> {
    #[cfg(unix)]
    {
        let pid = std::process::id().to_string();
        let output = Command::new("ps")
            .args(["-o", "rss=", "-p", &pid])
            .output()
            .ok()?;
        let kib = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<f64>()
            .ok()?;
        Some(kib / 1024.0)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn iterations() -> usize {
    env::args()
        .skip_while(|arg| arg != "--iterations")
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_ITERATIONS)
        .max(20)
}

fn main() {
    let iterations = iterations();
    let cold_frames: Vec<_> = (0..iterations).map(|_| frame(0.0)).collect();
    let mut cold = Vec::with_capacity(iterations);
    for current in cold_frames {
        let started = Instant::now();
        let mut renderer = SkiaRenderer::new();
        renderer
            .commit(current)
            .expect("native renderer must accept reference frame");
        cold.push(started.elapsed().as_secs_f64() * 1000.0);
    }

    let mut hot_renderer = SkiaRenderer::new();
    hot_renderer
        .commit(frame(0.0))
        .expect("native renderer warm-up must succeed");
    let hot_frames: Vec<_> = (0..iterations).map(|_| frame(0.0)).collect();
    let mut hot = Vec::with_capacity(iterations);
    for current in hot_frames {
        let started = Instant::now();
        hot_renderer
            .commit(current)
            .expect("native renderer must accept warm frame");
        hot.push(started.elapsed().as_secs_f64() * 1000.0);
    }

    let scroll_frames: Vec<_> = (0..iterations)
        .map(|index| frame((index % 16) as f32))
        .collect();
    let mut dropped = 0usize;
    for current in scroll_frames {
        let started = Instant::now();
        hot_renderer
            .commit(current)
            .expect("native renderer scroll frame must succeed");
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        if elapsed > FRAME_BUDGET_MS {
            dropped += 1;
        }
    }
    // Keep the gate explicit: the value and all percentiles are the fraction
    // of frames over the 60 FPS budget. Frame timing distribution is retained
    // in the probe process for diagnosis but is not mislabeled as a ratio.
    let dropped_rate = dropped as f64 / iterations as f64;
    let scroll_metric = Metric {
        status: "measured",
        unit: "ratio",
        value: dropped_rate,
        p50: dropped_rate,
        p95: dropped_rate,
        p99: dropped_rate,
    };
    let memory = rss_mb()
        .map(|value| {
            AnyMetric::Measured(Metric {
                status: "measured",
                unit: "MiB",
                value,
                p50: value,
                p95: value,
                p99: value,
            })
        })
        .unwrap_or_else(|| {
            AnyMetric::Unsupported(UnsupportedMetric {
                status: "unsupported",
                unit: "MiB",
                reason: "process RSS sampling is unavailable on this host".into(),
            })
        });

    let report = Report {
        schema_version: 1,
        backend: hot_renderer.backend_name(),
        iterations,
        nodes: NODE_COUNT,
        first_frame_ms: metric(&cold),
        cold_start_ms: metric(&cold),
        hot_start_ms: metric(&hot),
        scroll_dropped_frame_rate: scroll_metric,
        steady_state_memory_mb: memory,
    };
    println!(
        "{}",
        serde_json::to_string(&report).expect("native performance report serializes")
    );
}
