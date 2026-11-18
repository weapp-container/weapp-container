#[cfg(feature = "accepted-frame-node-input")]
mod accepted_frame_nodes;
#[cfg(feature = "accepted-frame-observation")]
mod accepted_frame_observation;
#[cfg(all(test, target_os = "linux", feature = "conformance-observation"))]
mod linux_transport_tests;
mod observation;
mod pack;
#[cfg(target_os = "linux")]
mod presenter;
mod profile;
mod session;
#[cfg(target_os = "linux")]
mod software_owner;

#[cfg(feature = "conformance-observation")]
mod method_delivery;
#[cfg(all(
    feature = "conformance-observation",
    any(target_os = "macos", target_os = "linux")
))]
mod method_output;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod native;

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn main() -> pack::Result<()> {
    #[cfg(feature = "conformance-observation")]
    if std::env::args().nth(1).as_deref() == Some("--preflight") {
        let args: Vec<_> = std::env::args().skip(2).collect();
        if args.len() != 2 {
            return Err("--preflight requires pack and engine".into());
        }
        let engine = match args[1].as_str() {
            "quickjs" => container_core::EngineKind::Quickjs,
            "v8" => container_core::EngineKind::V8,
            _ => return Err("preflight engine must be quickjs or v8".into()),
        };
        let pack = pack::Pack::read(std::path::Path::new(&args[0]))?;
        println!("{}", session::preflight(pack, engine)?);
        return Ok(());
    }
    native::run()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn main() -> std::process::ExitCode {
    println!(
        "{}",
        serde_json::json!({"kind":"blocked","host":std::env::consts::OS,
        "reason":"this conformance target requires a supported native-window presenter"})
    );
    std::process::ExitCode::from(2)
}
