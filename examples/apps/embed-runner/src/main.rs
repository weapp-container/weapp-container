//! Application-side embedding example.
//!
//! A real desktop/mobile app can replace this process with its Activity,
//! UIViewController, ArkUI Ability or browser worker. The important boundary
//! is the same: own one Simulator/HostSession, send complete bridge batches,
//! and upload one committed RGBA snapshot to the platform surface.

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_simulator::{Simulator, SimulatorConfig};
use serde_json::json;
use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // `pnpm run <script> -- ...` forwards its separator to the command
    // because the package script already contains Cargo's own `--`.  Ignore
    // standalone separators so both direct `cargo run ... -- pack` and the
    // conventional `pnpm embed:reference -- pack` form resolve the same pack.
    let arguments = positional_args(env::args().skip(1));
    let pack = arguments
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("artifacts/reference-app/pack"));
    let report_path = arguments
        .get(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("artifacts/reference-app/embed-report.json"));

    let mut simulator = Simulator::from_pack_dir(
        &pack,
        SimulatorConfig {
            engine: EngineKind::Quickjs,
            session_id: "embedded-app".into(),
            ..SimulatorConfig::default()
        },
    )?;

    // This is the app's startup path. It loads the real manifest/blob assets,
    // runs lifecycle/page/render in the same process, and leaves the latest
    // snapshot available to a native View or a CanvasKit adapter.
    let report = simulator.run()?;
    let capability = simulator.dispatch(BridgeEnvelope::request(
        "embedded-app",
        "embed-api-1",
        op::API_CALL,
        json!({"name": "wx.canIUse", "capability": "wx.getStorage"}),
    ))?;
    let snapshot = simulator.host().render_snapshot()?;

    let output = json!({
        "report": report,
        "capabilityBatch": capability,
        "snapshot": {
            "frameId": snapshot.frame_id,
            "width": snapshot.width,
            "height": snapshot.height,
            "format": snapshot.format,
            "pixelBytes": snapshot.pixels.len(),
        },
        "embedding": {
            "manifest": pack.join("manifest.json"),
            "bridge": "batched-json",
            "surfaceUpload": "one-rgba8-snapshot",
        },
    });
    if let Some(parent) = report_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&report_path, serde_json::to_vec_pretty(&output)?)?;
    println!("embedded app report: {}", report_path.display());
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

fn positional_args<I>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter().filter(|arg| arg != "--").collect()
}

#[cfg(test)]
mod tests {
    use super::positional_args;

    #[test]
    fn ignores_package_manager_separator() {
        assert_eq!(
            positional_args([
                "--".to_owned(),
                "artifacts/reference".to_owned(),
                "report.json".to_owned(),
            ]),
            vec!["artifacts/reference", "report.json"]
        );
    }
}
