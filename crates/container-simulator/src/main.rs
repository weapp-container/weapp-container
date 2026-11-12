use container_bridge::{op, BridgeBatch, BridgeEnvelope, EnvelopeKind};
use container_core::EngineKind;
use container_ir::{PresentationKey, RendererProfile};
use container_render_skia::PageRenderMode;

#[cfg(feature = "desktop-window")]
mod desktop;
mod device_dev;
use container_runtime::engine_provider_compiled;
use container_simulator::browser_dev_runner::{
    run_browser_dev, BrowserDevReportLocation, BrowserDevRunConfig,
};
use container_simulator::dev::{DevConfig, DevEvent, DevSupervisor};
use container_simulator::presentation::{
    FrameCadence, PresentationRequest, PresentationSettings, RenderScale,
};
use container_simulator::web::{DevDiagnostic as WebDiagnostic, WebSurface};
use container_simulator::{Simulator, SimulatorConfig};
use serde_json::json;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

fn usage() {
    eprintln!("Usage: weapp-simulator <run|dispatch> --pack <dir> [options]\n       weapp-simulator dev --project <dir> [options]\n\nRun/dispatch options:\n  --pack <dir>       container-pack output directory\n  --engine <name>    quickjs (default) or v8\n  --route <path>     initial page route\n  --viewport <WxH>   logical viewport (default 375x667)\n  --data-json <json> initial WXML data object\n  --trace <file>     write normalized JSON bridge trace\n  --snapshot <file>  write RGBA snapshot JSON\n  --report <file>    write simulator report JSON\n  --script <file>    JSONL bridge fixture; run executes after startup, dispatch is complete input; '-' reads stdin\n\nDev options:\n  --project <dir>    weapp-vite project root\n  --surface <name>   web, desktop, both, or devices\n  --engine <name>    quickjs (default) or v8\n  --route <path>     initial page route\n  --viewport <WxH>   logical viewport (default 375x667)\n  --data-json <json> initial WXML data object\n  --render-scale <value> auto (display DPR, explicit target budget), 1, 1.5, 2, 3 or 4\n  --renderer <name> auto (default), skia or webview\n  --web-runtime <name> remote (default) or browser\n  --browser-runtime-dir <dir> completed, independently pinned Worker producer\n  --browser-runtime-pins <file> independent producer pins (required with browser)\n  --renderer-assets <dir> pinned CanvasKit/font asset bundle\n  --software         explicitly use legacy CPU raster + RGBA preview\n  --fps <number>    automatic presentation target: 15, 30, 60 (default), 120\n  --host <address>   Web surface bind address (default: 127.0.0.1)\n  --port <number>    Web surface port (default: 5179)\n  --device-host <ip> native device bind (default: 0.0.0.0)\n  --device-port <n> native device TLS port (default: 5180)\n  --device-advertise-host <host> LAN/VPN address for pairing\n  --wv-bin <path>    wv executable (default: wv)\n  --node-bin <path>  node executable (default: node)\n  --out-dir <dir>    pack generations directory\n  --open             open the Web surface in the default browser\n\nThe desktop surface requires `--features desktop-window`; `both` requires the\nsame feature and shares one simulator session with the Web surface.\nBrowser development requires web + quickjs + explicit webview or skia and IPv4\nloopback. Skia requires an independently pinned CanvasKit runtime producer. It uses --viewport/default 375x667, not saved remote presentation\npreferences. Skia accepts --render-scale (default auto, display DPR with explicit target budget); DOM uses browser density. It rejects --software, --wv-bin, renderer assets and FPS.\nKeep its original preview open until Stop reports closed; page loss has no takeover.");
}

fn main() {
    if let Err(error) = run_cli() {
        eprintln!("weapp-simulator: {error}");
        std::process::exit(1);
    }
}

// Package managers may forward their argument separator unchanged (for
// example `pnpm simulator:dev -- --project ...`). This CLI has no positional
// operands after the subcommand, so separators between options are optional.
// Only skip while reading an option/command; option values are read directly
// so literal values such as `--route --` are not silently rewritten.
fn next_cli_option(args: &mut impl Iterator<Item = String>) -> Option<String> {
    args.find(|argument| argument != "--")
}

fn run_cli() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let command = next_cli_option(&mut args).unwrap_or_else(|| "run".into());
    if command == "--help" || command == "-h" {
        usage();
        return Ok(());
    }
    if command == "dev" {
        return run_dev_cli(args.collect());
    }
    if command != "run" && command != "dispatch" {
        usage();
        return Err(format!("unknown command {command}").into());
    }
    let mut pack: Option<PathBuf> = None;
    let mut config = SimulatorConfig::default();
    let mut trace = None;
    let mut snapshot = None;
    let mut report = None;
    let mut script = None;
    while let Some(arg) = next_cli_option(&mut args) {
        match arg.as_str() {
            "--pack" => pack = Some(PathBuf::from(args.next().ok_or("--pack requires a path")?)),
            "--engine" => {
                config.engine = match args
                    .next()
                    .ok_or("--engine requires quickjs or v8")?
                    .as_str()
                {
                    "quickjs" | "quick-js" => EngineKind::Quickjs,
                    "v8" => EngineKind::V8,
                    value => return Err(format!("unknown engine {value}").into()),
                }
            }
            "--route" => config.route = Some(args.next().ok_or("--route requires a path")?),
            "--data-json" => {
                config.initial_data = serde_json::from_str(
                    &args.next().ok_or("--data-json requires a JSON object")?,
                )?;
                if !config.initial_data.is_object() {
                    return Err("--data-json must be a JSON object".into());
                }
            }
            "--viewport" => {
                let value = args.next().ok_or("--viewport requires WIDTHxHEIGHT")?;
                let (width, height) = value
                    .split_once('x')
                    .ok_or("--viewport must be WIDTHxHEIGHT")?;
                config.viewport.width = width.parse()?;
                config.viewport.height = height.parse()?;
            }
            "--trace" => trace = Some(PathBuf::from(args.next().ok_or("--trace requires a path")?)),
            "--snapshot" => {
                snapshot = Some(PathBuf::from(
                    args.next().ok_or("--snapshot requires a path")?,
                ))
            }
            "--report" => {
                report = Some(PathBuf::from(
                    args.next().ok_or("--report requires a path")?,
                ))
            }
            "--script" => script = Some(args.next().ok_or("--script requires a path")?),
            "--help" | "-h" => {
                usage();
                return Ok(());
            }
            value => return Err(format!("unknown option {value}").into()),
        }
    }
    let pack = pack.ok_or("--pack is required")?;
    let mut simulator = Simulator::from_pack_dir(pack, config)?;
    if command == "run" {
        let result = simulator.run()?;
        println!("{}", serde_json::to_string_pretty(&result)?);
        // A run may be followed by a deterministic JSONL bridge fixture. This
        // keeps the canonical startup lifecycle in one place while allowing
        // engine/host conformance to exercise API calls against the live
        // session. Each line remains one complete envelope or batch, so no
        // per-node boundary is introduced.
        if let Some(script) = script {
            let source = if script == "-" {
                let mut source = String::new();
                io::stdin().read_to_string(&mut source)?;
                source
            } else {
                fs::read_to_string(script)?
            };
            for batch in simulator.dispatch_jsonl(&source)? {
                println!("{}", serde_json::to_string(&batch)?);
            }
        }
    } else {
        let script = script.ok_or("dispatch requires --script <file|->")?;
        let source = if script == "-" {
            let mut source = String::new();
            io::stdin().read_to_string(&mut source)?;
            source
        } else {
            fs::read_to_string(script)?
        };
        for batch in simulator.dispatch_jsonl(&source)? {
            println!("{}", serde_json::to_string(&batch)?);
        }
    }
    if let Some(path) = trace {
        simulator.write_trace(path)?;
    }
    if let Some(path) = snapshot {
        simulator.write_snapshot(path)?;
    }
    if let Some(path) = report {
        let value = if command == "run" {
            simulator.report("passed")
        } else {
            simulator.report("dispatched")
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_vec_pretty(&value)?)?;
    }
    Ok(())
}

fn run_dev_cli(arguments: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut project = None;
    let mut wv_bin = None;
    let mut node_bin = None;
    let mut out_dir = None;
    let mut browser_runtime_dir = None;
    let mut browser_runtime_pins = None;
    let mut config = SimulatorConfig::default();
    let mut surface = "web".to_owned();
    let mut host = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
    let mut port: u16 = 5179;
    let mut device_host = "0.0.0.0".to_owned();
    let mut device_port: u16 = 5180;
    let mut device_advertise_host = None;
    let mut open = false;
    let mut software = false;
    let mut renderer_assets = env::var_os("WEAPP_CONTAINER_RENDERER_ASSETS").map(PathBuf::from);
    let mut web_runtime = "remote".to_owned();
    let mut renderer = "auto".to_owned();
    let mut explicit_viewport = false;
    let mut explicit_scale = None;
    let mut explicit_fps = None;
    let mut args = arguments.into_iter();
    while let Some(arg) = next_cli_option(&mut args) {
        match arg.as_str() {
            "--project" => {
                project = Some(PathBuf::from(
                    args.next().ok_or("--project requires a path")?,
                ))
            }
            "--wv-bin" => {
                wv_bin = Some(PathBuf::from(
                    args.next().ok_or("--wv-bin requires a path")?,
                ))
            }
            "--node-bin" => {
                node_bin = Some(PathBuf::from(
                    args.next().ok_or("--node-bin requires a path")?,
                ))
            }
            "--out-dir" => {
                out_dir = Some(PathBuf::from(
                    args.next().ok_or("--out-dir requires a path")?,
                ))
            }
            "--browser-runtime-dir" => {
                let path =
                    PathBuf::from(args.next().ok_or("--browser-runtime-dir requires a path")?);
                if browser_runtime_dir.replace(path).is_some() {
                    return Err("duplicate --browser-runtime-dir".into());
                }
            }
            "--browser-runtime-pins" => {
                let path = PathBuf::from(
                    args.next()
                        .ok_or("--browser-runtime-pins requires a file")?,
                );
                if browser_runtime_pins.replace(path).is_some() {
                    return Err("duplicate --browser-runtime-pins".into());
                }
            }
            "--surface" => {
                surface = args
                    .next()
                    .ok_or("--surface requires web, desktop, both, or devices")?
            }
            "--host" => {
                let value = args.next().ok_or("--host requires an IP address")?;
                host = value
                    .parse()
                    .map_err(|_| format!("invalid --host address: {value}"))?;
            }
            "--port" => {
                let value = args.next().ok_or("--port requires a number")?;
                port = value
                    .parse()
                    .map_err(|_| format!("invalid --port: {value}"))?;
            }
            "--device-host" => {
                device_host = args.next().ok_or("--device-host requires an IP address")?;
                let _: std::net::IpAddr = device_host.parse()?;
            }
            "--device-port" => {
                device_port = args
                    .next()
                    .ok_or("--device-port requires a port")?
                    .parse()?;
            }
            "--device-advertise-host" => {
                device_advertise_host = Some(
                    args.next()
                        .ok_or("--device-advertise-host requires a hostname or IP")?,
                );
            }
            "--open" => open = true,
            "--software" => software = true,
            "--renderer-assets" => {
                renderer_assets = Some(PathBuf::from(
                    args.next().ok_or("--renderer-assets requires a path")?,
                ))
            }
            "--web-runtime" => {
                web_runtime = args
                    .next()
                    .ok_or("--web-runtime requires remote or browser")?
            }
            "--renderer" => {
                renderer = args
                    .next()
                    .ok_or("--renderer requires auto, skia or webview")?
            }
            "--engine" => {
                config.engine =
                    parse_engine(&args.next().ok_or("--engine requires quickjs or v8")?)?;
            }
            "--route" => config.route = Some(args.next().ok_or("--route requires a path")?),
            "--data-json" => {
                config.initial_data =
                    serde_json::from_str(&args.next().ok_or("--data-json requires JSON")?)?;
                if !config.initial_data.is_object() {
                    return Err("--data-json must be a JSON object".into());
                }
            }
            "--viewport" => {
                explicit_viewport = true;
                let value = args.next().ok_or("--viewport requires WIDTHxHEIGHT")?;
                let (width, height) = value
                    .split_once('x')
                    .ok_or("--viewport must be WIDTHxHEIGHT")?;
                config.viewport.width = width.parse()?;
                config.viewport.height = height.parse()?;
            }
            "--render-scale" => {
                explicit_scale = Some(RenderScale::parse(
                    &args
                        .next()
                        .ok_or("--render-scale requires auto or a number")?,
                )?);
            }
            "--fps" => {
                explicit_fps = Some(
                    args.next()
                        .ok_or("--fps requires 15, 30, 60 or 120")?
                        .parse::<u32>()?,
                );
            }
            "--help" | "-h" => {
                usage();
                return Ok(());
            }
            value => return Err(format!("unknown dev option {value}").into()),
        }
    }
    let project = project.ok_or("dev requires --project <path>")?;
    if !matches!(surface.as_str(), "web" | "desktop" | "both" | "devices") {
        return Err(
            format!("unknown surface {surface}; expected web, desktop, both, or devices").into(),
        );
    }
    if surface == "devices" {
        if config.engine != EngineKind::Quickjs {
            return Err(
                "ERR_ENGINE: native Dev Player requires quickjs; no watcher was started".into(),
            );
        }
        if web_runtime != "remote"
            || renderer == "webview"
            || software
            || browser_runtime_dir.is_some()
            || browser_runtime_pins.is_some()
            || renderer_assets.is_some()
            || explicit_viewport
            || explicit_scale.is_some()
            || explicit_fps.is_some()
            || config.initial_data != json!({})
        {
            return Err("ERR_UNSUPPORTED_CAPABILITY: devices own their native GPU, viewport and startup state; browser/software/presentation overrides are unavailable; no watcher was started".into());
        }
        if !matches!(renderer.as_str(), "auto" | "skia") {
            return Err("--renderer requires auto or skia for devices".into());
        }
        let mut dev = DevConfig::new(project, config);
        if let Some(value) = wv_bin {
            dev.wv_bin = value;
        }
        if let Some(value) = node_bin {
            dev.node_bin = value;
        }
        if let Some(value) = out_dir {
            dev.output_dir = value;
        }
        return device_dev::run(
            dev,
            device_dev::DeviceOptions {
                host: device_host,
                port: device_port,
                admin_port: port,
                advertise_host: device_advertise_host,
                open,
            },
        );
    }
    if !matches!(web_runtime.as_str(), "remote" | "browser") {
        return Err("--web-runtime requires remote or browser; no watcher was started".into());
    }
    if !matches!(renderer.as_str(), "auto" | "skia" | "webview") {
        return Err("--renderer requires auto, skia or webview; no watcher was started".into());
    }
    if web_runtime == "browser" {
        if config.engine != EngineKind::Quickjs {
            return Err("ERR_ENGINE: Browser development requires the pinned quickjs-wasm Worker; v8 is unavailable; no watcher was started".into());
        }
        if surface != "web" || !matches!(renderer.as_str(), "webview" | "skia") || software {
            return Err("ERR_UNSUPPORTED_CAPABILITY: Browser development requires --surface web --renderer webview|skia without --software; auto and native surfaces are not attached; no watcher was started".into());
        }
        if !matches!(host, std::net::IpAddr::V4(address) if address.is_loopback()) {
            return Err("ERR_UNSUPPORTED_CAPABILITY: Browser development requires an IPv4 loopback --host; no watcher was started".into());
        }
        if wv_bin.is_some() {
            return Err("ERR_UNSUPPORTED_CAPABILITY: Browser development uses the fixed vendor compiler and does not accept --wv-bin; no watcher was started".into());
        }
        if renderer_assets.is_some() {
            return Err("ERR_UNSUPPORTED_CAPABILITY: Browser development uses its pinned runtime producer and does not accept --renderer-assets or WEAPP_CONTAINER_RENDERER_ASSETS; no watcher was started".into());
        }
        if explicit_fps.is_some() {
            return Err("ERR_UNSUPPORTED_CAPABILITY: Browser development does not yet apply --fps; no watcher was started".into());
        }
        if renderer == "webview" && explicit_scale.is_some() {
            return Err("ERR_UNSUPPORTED_CAPABILITY: DOM density belongs to the browser; --render-scale requires --renderer skia; no watcher was started".into());
        }
        let producer_directory = browser_runtime_dir
            .ok_or("Browser development requires --browser-runtime-dir; no watcher was started")?;
        let pins_file = browser_runtime_pins
            .ok_or("Browser development requires --browser-runtime-pins; no watcher was started")?;
        // The browser owns presentation. Do not read the remote raster
        // surface's density/FPS preferences and silently ignore them.
        // Its logical viewport is explicitly supplied or the fixed default.
        let profile = if renderer == "skia" {
            RendererProfile::Skia
        } else {
            RendererProfile::WebView
        };
        let startup_intent = browser_startup_intent(
            &config,
            profile,
            (renderer == "skia").then(|| explicit_scale.unwrap_or_default()),
        )?;
        let output_dir =
            out_dir.unwrap_or_else(|| DevConfig::new(&project, config.clone()).output_dir);
        // Install the cooperative handler before the runner creates a listener,
        // credential process, preparation owner, compiler or immutable store.
        let shutdown = install_shutdown_handler()?;
        return run_browser_dev(
            BrowserDevRunConfig {
                project,
                producer_directory,
                pins_file,
                node_bin: node_bin.unwrap_or_else(|| PathBuf::from("node")),
                output_dir,
                host,
                port,
                startup_intent,
                duration: None,
                report_location: BrowserDevReportLocation::RunDirectory,
            },
            shutdown,
            |url| {
                if open {
                    open_browser(url);
                }
            },
        );
    }
    if browser_runtime_dir.is_some() || browser_runtime_pins.is_some() {
        return Err("--browser-runtime-dir and --browser-runtime-pins require --web-runtime browser; no watcher was started".into());
    }
    let mut presentation = PresentationSettings::load(&project)?;
    if explicit_viewport {
        if !config.viewport.width.is_finite()
            || !config.viewport.height.is_finite()
            || config.viewport.width.fract() != 0.0
            || config.viewport.height.fract() != 0.0
            || config.viewport.width <= 0.0
            || config.viewport.height <= 0.0
        {
            return Err("dev logical viewport must have positive integer dimensions".into());
        }
        presentation.logical_width = config.viewport.width as u32;
        presentation.logical_height = config.viewport.height as u32;
    }
    if let Some(scale) = explicit_scale {
        presentation.render_scale = scale;
    }
    if let Some(fps) = explicit_fps {
        presentation.fps = fps;
    }
    presentation.effective_scale = presentation.render_scale.effective(1.0)?;
    presentation.validate()?;
    config.viewport.width = presentation.logical_width as f32;
    config.viewport.height = presentation.logical_height as f32;
    config.render_scale = presentation.effective_scale;
    if open && surface == "desktop" {
        return Err("--open requires --surface web or both; no watcher was started".into());
    }
    if !engine_provider_compiled(config.engine) {
        let engine = match config.engine {
            EngineKind::Quickjs => "quickjs-native",
            EngineKind::V8 => "v8-native",
        };
        return Err(format!(
            "ERR_ENGINE: requested engine provider is not compiled: enable `--features {engine}`; no watcher was started"
        )
        .into());
    }
    #[cfg(not(feature = "desktop-window"))]
    if matches!(surface.as_str(), "desktop" | "both") {
        return Err(format!(
            "{surface} surface requires `--features desktop-window`; no watcher was started"
        )
        .into());
    }
    config.renderer_override = match renderer.as_str() {
        "skia" => Some(RendererProfile::Skia),
        "webview" => Some(RendererProfile::WebView),
        _ => None,
    };
    if renderer == "webview" && (surface != "web" || software) {
        return Err("ERR_UNSUPPORTED_CAPABILITY: the attached DOM presenter requires --surface web without --software; native WebView adapters are not yet attached; no watcher was started".into());
    }
    config.browser_view_enabled = surface == "web" && !software;
    if !software && surface != "web" {
        #[cfg(feature = "desktop-window")]
        desktop::DesktopPresenter::ensure_supported(false)?;
    }
    config.page_render_mode = if software {
        PageRenderMode::Raster
    } else if surface == "web" {
        PageRenderMode::ExternalFrame
    } else {
        PageRenderMode::NativeGpu
    };
    // Validate assets and bind before launching any owned watch process.
    let mut web_surface = if surface != "desktop" {
        Some(WebSurface::bind(host, port)?)
    } else {
        None
    };
    if config.browser_view_enabled {
        if let Some(web) = web_surface.as_mut() {
            web.handle().configure_browser_view();
        }
    }
    if !software && renderer != "webview" {
        if let Some(web) = web_surface.as_mut() {
            let asset_path = renderer_assets.unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../artifacts/dual-renderer-dev-assets")
            });
            web.configure_canvaskit_assets(&asset_path)?;
        }
    }
    let mut dev = DevConfig::new(project, config);
    if let Some(path) = wv_bin {
        dev.wv_bin = path;
    }
    if let Some(path) = node_bin {
        dev.node_bin = path;
    }
    if let Some(path) = out_dir {
        dev.output_dir = path;
    }
    let (supervisor, first_event) = DevSupervisor::spawn(dev)?;
    // A terminated CLI process cannot run `Drop` handlers automatically. Use
    // a cooperative signal flag so the event loop returns normally and drops
    // the supervisor, which in turn terminates the long-running `wv` child.
    let shutdown = install_shutdown_handler()?;
    match surface.as_str() {
        "web" => {
            let web = web_surface
                .take()
                .expect("web surface prepared before watcher");
            let url = web.url();
            eprintln!("weapp-simulator: web surface {url}");
            if open {
                open_browser(&url);
            }
            run_web_dev(supervisor, web, first_event, shutdown, presentation)
        }
        "desktop" => {
            #[cfg(feature = "desktop-window")]
            {
                run_desktop_dev(
                    supervisor,
                    None,
                    first_event,
                    shutdown,
                    presentation,
                    software,
                )
            }
            #[cfg(not(feature = "desktop-window"))]
            {
                let _ = (supervisor, first_event);
                Err("desktop surface requires `--features desktop-window`".into())
            }
        }
        "both" => {
            let web = web_surface
                .take()
                .expect("web surface prepared before watcher");
            let url = web.url();
            eprintln!("weapp-simulator: web surface {url}");
            if open {
                open_browser(&url);
            }
            #[cfg(feature = "desktop-window")]
            {
                run_desktop_dev(
                    supervisor,
                    Some(web),
                    first_event,
                    shutdown,
                    presentation,
                    software,
                )
            }
            #[cfg(not(feature = "desktop-window"))]
            {
                let _ = (supervisor, first_event, web);
                Err("both surfaces require `--features desktop-window`".into())
            }
        }
        _ => unreachable!(),
    }
}

fn browser_startup_intent(
    config: &SimulatorConfig,
    profile: RendererProfile,
    render_scale: Option<RenderScale>,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if !matches!(profile, RendererProfile::Skia | RendererProfile::WebView) {
        return Err("ERR_UNSUPPORTED_CAPABILITY: Browser development requires an explicit webview or skia renderer; no watcher was started".into());
    }
    if !config.initial_data.is_object() {
        return Err("--data-json must be a JSON object; no watcher was started".into());
    }
    let viewport = config.viewport;
    if [viewport.width, viewport.height]
        .into_iter()
        .any(|size| !size.is_finite() || size <= 0.0 || size.fract() != 0.0 || size > 4096.0)
    {
        return Err("Browser logical viewport must have positive integer dimensions up to 4096; no watcher was started".into());
    }
    let mut intent = json!({
        "schemaVersion": 1,
        "execution": "worker",
        "engine": "quickjs",
        "viewport": { "width": viewport.width as u32, "height": viewport.height as u32 },
        "rendererPolicy": { "mode": "force", "profile": profile },
        "data": config.initial_data,
    });
    if let Some(scale) = render_scale {
        if profile == RendererProfile::WebView {
            return Err("ERR_UNSUPPORTED_CAPABILITY: DOM density belongs to the browser; no watcher was started".into());
        }
        let effective = scale.effective(1.0)?;
        container_render_skia::RenderTargetSize::for_viewport(viewport, effective)?;
        intent["renderScale"] = json!(scale);
    }
    if let Some(route) = &config.route {
        // CLI routes accept a single conventional leading slash. The shared
        // stage parser validates the canonical result before any side effects.
        intent["route"] = json!(route.strip_prefix('/').unwrap_or(route));
    }
    Ok(serde_json::to_vec(&intent)?)
}

fn install_shutdown_handler() -> Result<Arc<AtomicBool>, Box<dyn std::error::Error>> {
    let shutdown = Arc::new(AtomicBool::new(false));
    let flag = shutdown.clone();
    ctrlc::set_handler(move || {
        flag.store(true, Ordering::SeqCst);
    })?;
    Ok(shutdown)
}

fn parse_engine(value: &str) -> Result<EngineKind, Box<dyn std::error::Error>> {
    Ok(match value {
        "quickjs" | "quick-js" => EngineKind::Quickjs,
        "v8" => EngineKind::V8,
        other => return Err(format!("unknown engine {other}").into()),
    })
}

#[cfg(feature = "desktop-window")]
fn report_dev_event(event: DevEvent, supervisor: &mut DevSupervisor) -> bool {
    match event {
        DevEvent::BuildStarted => {
            eprintln!("weapp-simulator: watching weapp-vite project");
            false
        }
        DevEvent::BrowserRuntimePrepared { .. } => {
            eprintln!("weapp-simulator: verified static browser runtime; execution and presentation are not ready");
            false
        }
        DevEvent::PortableReady { revision, .. } => {
            eprintln!("weapp-simulator: ERR_UNSUPPORTED_CAPABILITY: portable generation {revision} requires a browser Worker coordinator; no local runtime was started");
            true
        }
        DevEvent::PackReady {
            revision,
            reload,
            report,
        } => {
            let kind = reload
                .map(|value| format!(" ({value:?})"))
                .unwrap_or_default();
            println!(
                "{}",
                serde_json::json!({"event":"reload", "revision":revision, "kind":kind, "report":report})
            );
            let batch = supervisor
                .simulator_mut()
                .map(|simulator| simulator.take_dev_errors())
                .unwrap_or_else(|| BridgeBatch::new(Vec::new()));
            let diagnostics = runtime_error_diagnostics(&batch);
            for (code, message) in &diagnostics {
                eprintln!("weapp-simulator: {code}: {message}");
            }
            !diagnostics.is_empty()
        }
        DevEvent::Diagnostic(diagnostic) => {
            eprintln!(
                "weapp-simulator: {}: {}",
                diagnostic.code, diagnostic.message
            );
            diagnostic.severity == "error"
        }
        DevEvent::RuntimeUpdated {
            revision, batch, ..
        } => {
            println!(
                "{}",
                json!({"event": "runtime", "revision": revision, "batch": batch})
            );
            let diagnostics = runtime_error_diagnostics(&batch);
            for (code, message) in &diagnostics {
                eprintln!("weapp-simulator: {code}: {message}");
            }
            !diagnostics.is_empty()
        }
        DevEvent::Exited(status) => {
            eprintln!("weapp-simulator: watch process exited with {status}");
            true
        }
    }
}

#[cfg(feature = "desktop-window")]
fn desktop_error_status(previous: bool, recovered: bool, has_errors: bool) -> bool {
    has_errors || (previous && !recovered)
}

#[cfg(feature = "desktop-window")]
fn publish_desktop_shutdown(web: &mut Option<WebSurface>, reason: &str) {
    let Some(surface) = web.as_mut() else {
        return;
    };
    surface
        .handle()
        .publish("shutdown", json!({"reason": reason}));
    // The winit callback is the last opportunity to flush the event before
    // the shared Web listener is dropped. Ignore a peer disconnect here: the
    // desktop surface is already terminating and its owner must still close
    // the listener and native window.
    let _ = surface.poll();
}

#[cfg(feature = "desktop-window")]
fn finish_desktop_shutdown(
    supervisor: &mut DevSupervisor,
    web: &mut Option<WebSurface>,
    reason: &str,
) {
    supervisor.shutdown();
    publish_desktop_shutdown(web, reason);
    drop(web.take());
}

fn run_web_dev(
    mut supervisor: DevSupervisor,
    mut surface: WebSurface,
    first_event: DevEvent,
    shutdown: Arc<AtomicBool>,
    mut presentation: PresentationSettings,
) -> Result<(), Box<dyn std::error::Error>> {
    let handle = surface.handle();
    handle.set_presentation(serde_json::to_value(&presentation)?);
    let mut cadence = FrameCadence::new(presentation.fps);
    let mut shutdown_reason = "error";
    // Keep all `?` exits inside this scope so cleanup order does not depend
    // on the reverse Drop order of function parameters.
    let result: Result<(), Box<dyn std::error::Error>> = (|| {
        publish_dev_event(&handle, &mut supervisor, first_event);
        loop {
            if shutdown.load(Ordering::SeqCst) {
                shutdown_reason = "signal";
                break;
            }
            surface.poll()?;
            apply_web_preview_requests(&mut supervisor, &handle);
            apply_web_presentation(&mut supervisor, &handle, &mut presentation);
            dispatch_web_requests(&mut supervisor, &handle);
            let redraw = cadence.due(std::time::Instant::now(), presentation.fps);
            if let Some(event) = supervisor.pump_runtime_with_render(now_ns(), redraw)? {
                publish_dev_event(&handle, &mut supervisor, event);
            }
            if let Some(event) = supervisor.poll()? {
                let exited = matches!(event, DevEvent::Exited(_));
                publish_dev_event(&handle, &mut supervisor, event);
                if exited {
                    shutdown_reason = "wv-exited";
                    break;
                }
            }
            surface.wait(Duration::from_millis(1))?;
        }
        Ok(())
    })();
    supervisor.shutdown();
    handle.publish("shutdown", json!({"reason": shutdown_reason}));
    // One nonblocking best-effort flush preserves the terminal SSE event for
    // writable clients; slow clients cannot delay the cleanup barrier.
    let shutdown_flush = surface.poll();
    drop(surface);
    result?;
    shutdown_flush?;
    Ok(())
}

/// Preview leases are host state, but retiring their contacts and presentation
/// authority must happen on the same owner thread as every runtime operation.
fn apply_web_preview_requests(
    supervisor: &mut DevSupervisor,
    handle: &container_simulator::web::WebSurfaceHandle,
) {
    for request in handle.take_preview_requests() {
        let result = (|| -> Result<(), String> {
            let transfer = handle.preview_transfer_required(&request)?;
            if transfer {
                if let Some(simulator) = supervisor.simulator_mut() {
                    let batch = simulator
                        .retire_browser_preview("preview-owner-changed")
                        .map_err(|error| error.to_string())?;
                    if !batch.messages.is_empty() {
                        handle
                            .publish("bridge", serde_json::to_value(&batch).expect("bridge JSON"));
                    }
                    for (code, message) in runtime_error_diagnostics(&batch) {
                        publish_diagnostic(
                            handle,
                            supervisor.revision(),
                            "preview",
                            &code,
                            message,
                        );
                    }
                }
            }
            handle.commit_preview_request(&request, transfer)?;
            publish_simulator_state(handle, supervisor, "ready");
            Ok(())
        })();
        if let Err(error) = result {
            handle.reject_preview_request(&request, &error);
        }
    }
}

fn apply_web_presented(
    supervisor: &mut DevSupervisor,
    handle: &container_simulator::web::WebSurfaceHandle,
) {
    for receipt in handle.take_render_presented() {
        let result = (|| -> Result<BridgeBatch, String> {
            let simulator = supervisor.simulator_mut().ok_or("runtime not ready")?;
            if receipt["sessionId"].as_str() != Some(simulator.session_id()) {
                return Err("ERR_CANCELLED: stale presentation session".into());
            }
            let revision = receipt["renderRevision"]
                .as_u64()
                .ok_or("missing renderRevision")?;
            if revision != simulator.host().render_revision() {
                return Err("ERR_CANCELLED: stale presentation revision".into());
            }
            let batch = simulator
                .acknowledge_presentation(revision)
                .map_err(|error| error.to_string())?;
            handle.confirm_render_presented(&receipt)?;
            Ok(batch)
        })();
        match result {
            Ok(batch) => {
                handle.publish("presented", receipt);
                publish_simulator_state(handle, supervisor, "ready");
                for (code, message) in runtime_error_diagnostics(&batch) {
                    publish_diagnostic(
                        handle,
                        supervisor.revision(),
                        "presentation",
                        &code,
                        message,
                    );
                }
                if !batch.messages.is_empty() {
                    handle.publish("bridge", serde_json::to_value(batch).expect("bridge JSON"));
                }
            }
            Err(error) => {
                handle.publish(
                    "presentation-rejected",
                    json!({"receipt":receipt,"error":error}),
                );
            }
        }
    }
}

fn dispatch_web_requests(
    supervisor: &mut DevSupervisor,
    handle: &container_simulator::web::WebSurfaceHandle,
) -> bool {
    apply_web_presented(supervisor, handle);
    let mut has_errors = false;
    let requests = handle.take_fenced_bridge_requests();
    let handled_requests = !requests.is_empty();
    for request in requests {
        let mut diagnostics = Vec::new();
        let result = dispatch_web_bridge(&request.body, &handle.presentation(), |envelope| {
            // Return correlated final errors: a queued HTTP receipt must not
            // leave the browser waiting until its timeout on a stale lease.
            if let Err(error) = handle
                .validate_preview_envelope(&request, &envelope)
                .and_then(|()| handle.validate_render_input(&envelope))
            {
                return Ok(rejected_web_envelope(envelope, &error));
            }
            let simulator = supervisor
                .simulator_mut()
                .ok_or_else(|| "simulator is not ready".to_owned())?;
            let abort_key = (envelope.op == op::VIEW_ABORT)
                .then(|| serde_json::from_value::<PresentationKey>(envelope.payload.clone()).ok())
                .flatten();
            let result = simulator.dispatch(envelope);
            let mut batch = match result {
                Ok(batch) => batch,
                Err(error) => {
                    synchronize_browser_retained_state(handle, simulator);
                    return Err(error.to_string());
                }
            };
            synchronize_browser_publication(handle, simulator, &mut batch, abort_key.as_ref());
            diagnostics.extend(runtime_error_diagnostics(&batch));
            Ok(batch)
        });
        match result {
            Ok(batch) => {
                let payload =
                    serde_json::to_value(&batch).unwrap_or_else(|_| json!({"messages": []}));
                handle.publish("bridge", payload);
                for (code, message) in diagnostics {
                    has_errors = true;
                    publish_diagnostic(handle, supervisor.revision(), "runtime", &code, message);
                }
            }
            Err(error) => {
                has_errors = true;
                publish_diagnostic(
                    handle,
                    supervisor.revision(),
                    "bridge",
                    "BRIDGE_FAILED",
                    error,
                );
            }
        }
    }
    // Responses preserve every operation's semantics. Presentation is a
    // latest-value stream: encode only the final accepted pixels of this
    // runtime turn, rather than copying intermediate frames for each input.
    if handled_requests {
        publish_simulator_state(handle, supervisor, "ready");
    }
    has_errors
}

fn rejected_web_envelope(mut envelope: BridgeEnvelope, error: &str) -> BridgeBatch {
    envelope.kind = EnvelopeKind::Response;
    let code = error
        .split(':')
        .next()
        .filter(|code| code.starts_with("ERR_"))
        .unwrap_or("ERR_RENDER");
    envelope.payload = json!({"ok":false,"error":{"code":code,"message":error}});
    BridgeBatch::new(vec![envelope])
}

/// Publish bytes before exposing a preparation response. A document only grants
/// access to its declared encoded resources, never arbitrary pack blobs.
fn synchronize_browser_publication(
    handle: &container_simulator::web::WebSurfaceHandle,
    simulator: &mut Simulator,
    batch: &mut BridgeBatch,
    abort_key: Option<&PresentationKey>,
) {
    let mut cleanup_messages = Vec::new();
    for message in &mut batch.messages {
        if message.kind != EnvelopeKind::Response || message.payload["ok"] != true {
            continue;
        }
        let result = (|| -> Result<(), String> {
            match message.op.as_str() {
                op::VIEW_PREPARE => {
                    let submission = message.payload["submission"].clone();
                    let key: PresentationKey = serde_json::from_value(submission["key"].clone())
                        .map_err(|error| error.to_string())?;
                    handle.publish_view_submission(submission, |hash| {
                        simulator
                            .host()
                            .browser_view_resource(&key, hash)
                            .map_err(|error| error.to_string())
                    })
                }
                op::VIEW_PRESENTED => {
                    let key: PresentationKey =
                        serde_json::from_value(message.payload["key"].clone())
                            .map_err(|error| error.to_string())?;
                    handle.confirm_view_presented(&key, message.payload["inputEnabled"] == true)
                }
                op::VIEW_ABORT => {
                    if let Some(key) = abort_key {
                        handle.abort_view_submission(key);
                    }
                    Ok(())
                }
                _ => Ok(()),
            }
        })();
        if let Err(error) = result {
            let cleanup = if message.op == op::VIEW_PREPARE {
                let key = message.payload["submission"]["key"].clone();
                if let Ok(parsed) = serde_json::from_value::<PresentationKey>(key.clone()) {
                    handle.abort_view_submission(&parsed);
                }
                simulator.dispatch(BridgeEnvelope::request(
                    simulator.session_id(),
                    format!("{}-resource-abort", message.request_id),
                    op::VIEW_ABORT,
                    key,
                ))
            } else {
                simulator.retire_browser_preview("host-publication-failed")
            };
            match cleanup {
                Ok(cleanup) => cleanup_messages.extend(cleanup.messages),
                Err(cleanup) => cleanup_messages.push(BridgeEnvelope::event(
                    simulator.session_id(), op::ERROR,
                    json!({"code":"ERR_RENDER","message":format!("publication cleanup failed: {cleanup}")}),
                )),
            }
            message.payload = json!({"ok":false,"error":{"code":"ERR_RENDER","message":error}});
        }
    }
    batch.messages.extend(cleanup_messages);
    synchronize_browser_retained_state(handle, simulator);
}

fn synchronize_browser_retained_state(
    handle: &container_simulator::web::WebSurfaceHandle,
    simulator: &Simulator,
) {
    handle.retain_browser_pending(|key| {
        simulator
            .host()
            .is_browser_view_pending(key)
            .unwrap_or(false)
    });
    handle.set_browser_input_enabled(
        simulator
            .host()
            .is_browser_view_presented()
            .unwrap_or(false),
    );
}

// The Web boundary accepts both the individual envelope and BridgeBatch wire
// forms. Decode the entire input before dispatching so a malformed batch
// cannot partially mutate the runtime. Validate each input at this boundary;
// headless dispatch intentionally does not depend on browser presentation.
fn dispatch_web_bridge(
    input: &[u8],
    presentation: &serde_json::Value,
    mut dispatch: impl FnMut(BridgeEnvelope) -> Result<BridgeBatch, String>,
) -> Result<BridgeBatch, String> {
    let value: serde_json::Value =
        serde_json::from_slice(input).map_err(|error| error.to_string())?;
    let requests = if value.get("messages").is_some() {
        serde_json::from_value::<BridgeBatch>(value)
            .map_err(|error| error.to_string())?
            .messages
    } else {
        vec![serde_json::from_value::<BridgeEnvelope>(value).map_err(|error| error.to_string())?]
    };
    let mut messages = Vec::new();
    for mut request in requests {
        let stale_input = request.op == op::EVENT_BATCH
            && request.payload.get("logicalViewport").is_some_and(|size| {
                size["width"] != presentation["logicalWidth"]
                    || size["height"] != presentation["logicalHeight"]
            });
        if stale_input {
            request.kind = EnvelopeKind::Response;
            request.payload = json!({"ok":false,"error":{
                "code":"ERR_CANCELLED",
                "message":"input belongs to a previous logical viewport"
            }});
            messages.push(request);
        } else {
            messages.extend(dispatch(request)?.messages);
        }
    }
    Ok(BridgeBatch::new(messages))
}

fn apply_web_presentation(
    supervisor: &mut DevSupervisor,
    handle: &container_simulator::web::WebSurfaceHandle,
    settings: &mut PresentationSettings,
) {
    for mut value in handle.take_presentation_requests() {
        let request_id = value
            .get("requestId")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let result = (|| -> Result<PresentationSettings, String> {
            let control = handle.capture_presentation_control(&value)?;
            let accepted_settings = serde_json::to_value(&*settings).map_err(|e| e.to_string())?;
            if handle.presentation() != accepted_settings {
                return Err("ERR_PRESENTATION_REVISION: owner settings were superseded".into());
            }
            if let Some(object) = value.as_object_mut() {
                object.remove("preview");
            }
            let request: PresentationRequest =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
            let candidate = settings.candidate(&request)?;
            let viewport = container_render_skia::Rect {
                x: 0.0,
                y: 0.0,
                width: candidate.logical_width as f32,
                height: candidate.logical_height as f32,
            };
            let simulator = supervisor
                .simulator_mut()
                .ok_or("ERR_PRESENTATION_NOT_READY: simulator is not ready")?;
            let batch = apply_web_presentation_candidate_with_control(
                handle,
                simulator,
                &candidate,
                candidate.generation != settings.generation,
                &control,
                reserve_web_presentation,
            )?;
            let errors = runtime_error_diagnostics(&batch);
            for (code, message) in errors {
                publish_diagnostic(handle, supervisor.revision(), "runtime", &code, message);
            }
            supervisor.set_presentation_config(viewport, candidate.effective_scale);
            Ok(candidate)
        })();
        match result {
            Ok(candidate) => {
                *settings = candidate;
                if let Err(error) = settings.save(supervisor.project()) {
                    publish_diagnostic(
                        handle,
                        supervisor.revision(),
                        "presentation",
                        "ERR_PRESENTATION_PERSIST",
                        error.to_string(),
                    );
                }
                // Skia joint publication already installed matching settings
                // and frame. DOM remains a separate asynchronous transaction.
                let committed = serde_json::to_value(&*settings).expect("presentation is JSON");
                if handle.presentation() != committed {
                    handle.set_presentation(committed);
                }
                handle.publish(
                    "presentation",
                    json!({"requestId":request_id,"ok":true,"presentation":settings}),
                );
                publish_simulator_state(handle, supervisor, "ready");
            }
            Err(error) => {
                handle.publish("presentation",json!({"requestId":request_id,"ok":false,"presentation":settings,"error":{"code":"ERR_PRESENTATION_CONFIG","message":error}}));
                // Failed preparation preserves accepted pixels and any real hook effects.
                publish_simulator_state(handle, supervisor, "ready");
            }
        }
    }
}

fn reserve_web_presentation<'a>(
    handle: &'a container_simulator::web::WebSurfaceHandle,
    session_id: &str,
    candidate: &PresentationSettings,
) -> Result<container_simulator::web::WebFrameReservation<'a>, String> {
    handle.reserve_frame(
        session_id,
        candidate.generation,
        candidate.logical_width as f32,
        candidate.logical_height as f32,
        (f64::from(candidate.logical_width) * candidate.effective_scale).ceil() as u32,
        (f64::from(candidate.logical_height) * candidate.effective_scale).ceil() as u32,
    )
}

/// Keep recoverable Web resource failures on the safe side of application
/// resize callbacks. The injectable reservation operation also lets the main
/// runtime boundary exercise allocation rejection deterministically.
#[cfg(test)]
fn apply_web_presentation_candidate<'a>(
    handle: &'a container_simulator::web::WebSurfaceHandle,
    simulator: &mut Simulator,
    candidate: &PresentationSettings,
    frame_changed: bool,
    reserve: impl FnOnce(
        &'a container_simulator::web::WebSurfaceHandle,
        &str,
        &PresentationSettings,
    ) -> Result<container_simulator::web::WebFrameReservation<'a>, String>,
) -> Result<BridgeBatch, String> {
    let control = handle.capture_presentation_control(&json!({}))?;
    apply_web_presentation_candidate_with_control(
        handle,
        simulator,
        candidate,
        frame_changed,
        &control,
        reserve,
    )
}

fn apply_web_presentation_candidate_with_control<'a>(
    handle: &'a container_simulator::web::WebSurfaceHandle,
    simulator: &mut Simulator,
    candidate: &PresentationSettings,
    frame_changed: bool,
    control: &container_simulator::web::PresentationControlFence,
    reserve: impl FnOnce(
        &'a container_simulator::web::WebSurfaceHandle,
        &str,
        &PresentationSettings,
    ) -> Result<container_simulator::web::WebFrameReservation<'a>, String>,
) -> Result<BridgeBatch, String> {
    if simulator.current_renderer_profile() == RendererProfile::WebView {
        candidate.validate()?;
        return simulator
            .apply_presentation(
                container_render_skia::Rect {
                    x: 0.0,
                    y: 0.0,
                    width: candidate.logical_width as f32,
                    height: candidate.logical_height as f32,
                },
                candidate.effective_scale,
            )
            .map_err(|error| error.to_string());
    }
    if simulator.viewport().width == candidate.logical_width as f32
        && simulator.viewport().height == candidate.logical_height as f32
    {
        return simulator.apply_web_density(handle, candidate, frame_changed);
    }
    candidate.validate()?;
    let mode = simulator
        .host()
        .session()
        .ok_or("ERR_ENGINE: runtime session is not loaded")?
        .page_render_mode();
    // Existing fault injection stays at preflight; neither export/GPU nor the
    // final acceptance receives an arbitrary caller-supplied callback.
    let reservation = if mode == PageRenderMode::Raster && simulator.has_current_skia_scene() {
        Some(reserve(handle, simulator.session_id(), candidate)?)
    } else {
        None
    };
    simulator.apply_web_logical_resize(handle, candidate, control, reservation)
}

/// Extract structured runtime failures from a successful bridge dispatch.
///
/// The runtime represents operation failures as `ok: false` response
/// envelopes so the transport itself remains healthy.  Development surfaces
/// still need those failures in the same diagnostic stream as build/reload
/// errors; otherwise capability and permission errors are only visible in the
/// raw bridge panel and never reach the overlay or `/api/state`.
fn runtime_error_diagnostics(batch: &BridgeBatch) -> Vec<(String, String)> {
    batch
        .messages
        .iter()
        .flat_map(|message| {
            let mut errors = Vec::new();
            if message
                .payload
                .get("ok")
                .and_then(serde_json::Value::as_bool)
                == Some(false)
            {
                errors.extend(message.payload.get("error"));
            }
            // Timer callbacks and other asynchronous JS failures are emitted
            // as error events after the batched engine effects are drained.
            if message.op == container_bridge::op::ERROR {
                if let Some(values) = message
                    .payload
                    .get("errors")
                    .and_then(serde_json::Value::as_array)
                {
                    errors.extend(values);
                }
            }
            errors
        })
        .map(|error| {
            let code = error
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("ERR_RUNTIME")
                .to_owned();
            let message = error
                .get("message")
                .or_else(|| error.get("errMsg"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_else(|| {
                    error
                        .get("code")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("runtime bridge request failed")
                })
                .to_owned();
            (code, message)
        })
        .collect()
}

/// Dispatch one host pointer event through the live simulator session.  The
/// runtime resolves `x`/`y` against the committed render tree and fills the
/// target/path/dataset fields before invoking the page handlers, so desktop
/// input follows the same hit-test path as Web input.
#[cfg(feature = "desktop-window")]
struct DesktopPointerEvent<'a> {
    event_type: &'a str,
    x: f32,
    y: f32,
    button: Option<u8>,
    buttons: u16,
    modifiers: winit::keyboard::ModifiersState,
}

#[cfg(feature = "desktop-window")]
fn dispatch_pointer_event(
    supervisor: &mut DevSupervisor,
    request_id: &mut u64,
    pointer: DesktopPointerEvent<'_>,
    scale: (f64, f64),
) -> Result<BridgeBatch, String> {
    dispatch_input_event(
        supervisor,
        request_id,
        json!({
            "type": pointer.event_type,
            "x": pointer.x,
            "y": pointer.y,
            "detail": {"x": pointer.x, "y": pointer.y},
            "button": pointer.button,
            "buttons": pointer.buttons,
            "modifiers": modifier_value(pointer.modifiers),
            "bubbles": true
        }),
        scale,
    )
}

#[cfg(feature = "desktop-window")]
fn dispatch_input_event(
    supervisor: &mut DevSupervisor,
    request_id: &mut u64,
    mut event: serde_json::Value,
    scale: (f64, f64),
) -> Result<BridgeBatch, String> {
    let simulator = supervisor
        .simulator_mut()
        .ok_or_else(|| "simulator is not ready".to_owned())?;
    desktop_event_to_logical(&mut event, scale)?;
    // Keyboard events do not have pointer coordinates from which the runtime
    // can infer a target. Route them to the committed root so they still use
    // the same capture/target/bubble event contract as Web input. Hosts can
    // add focus tracking later by supplying an explicit target/path here.
    let event_type = event.get("type").and_then(serde_json::Value::as_str);
    if matches!(event_type, Some("keydown" | "keyup")) {
        let has_target = event
            .get("target")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|target| !target.is_empty());
        if !has_target {
            let root_id = simulator
                .host()
                .render_root_id()
                .map_err(|error| error.to_string())?;
            let object = event
                .as_object_mut()
                .ok_or_else(|| "desktop input event must be an object".to_owned())?;
            object.insert("target".into(), serde_json::Value::String(root_id.clone()));
            object.insert(
                "path".into(),
                serde_json::Value::Array(vec![serde_json::Value::String(root_id)]),
            );
            object.entry("detail").or_insert_with(|| json!({}));
        }
    }
    *request_id = request_id.saturating_add(1);
    let envelope = BridgeEnvelope::request(
        simulator.session_id(),
        format!("desktop-event-{request_id}"),
        op::EVENT_BATCH,
        json!({"events": [event]}),
    );
    simulator
        .dispatch(envelope)
        .map_err(|error| error.to_string())
}

/// The desktop surface owns physical pixels; runtime hit testing and wheel
/// geometry use logical pixels. Line/page wheel units remain unit counts.
#[cfg(any(feature = "desktop-window", test))]
fn desktop_event_to_logical(
    event: &mut serde_json::Value,
    scale: (f64, f64),
) -> Result<(), String> {
    if !scale.0.is_finite() || scale.0 <= 0.0 || !scale.1.is_finite() || scale.1 <= 0.0 {
        return Err("desktop input render scale must be finite and positive".into());
    }
    let pixel_wheel = event.get("type").and_then(serde_json::Value::as_str) == Some("wheel")
        && event
            .get("deltaMode")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
            == 0;
    let divide = |object: &mut serde_json::Value, key: &str| {
        if let Some(value) = object.get_mut(key) {
            if let Some(number) = value.as_f64() {
                let axis = if matches!(key, "x" | "deltaX") {
                    scale.0
                } else {
                    scale.1
                };
                *value = json!(number / axis);
            }
        }
    };
    for key in ["x", "y"] {
        divide(event, key);
    }
    if let Some(detail) = event.get_mut("detail") {
        for key in ["x", "y"] {
            divide(detail, key);
        }
    }
    if pixel_wheel {
        for key in ["deltaX", "deltaY"] {
            divide(event, key);
        }
    }
    Ok(())
}

#[cfg(feature = "desktop-window")]
fn publish_desktop_batch(
    web_handle: &Option<container_simulator::web::WebSurfaceHandle>,
    revision: u64,
    batch: BridgeBatch,
) -> bool {
    let diagnostics = runtime_error_diagnostics(&batch);
    let has_errors = !diagnostics.is_empty();
    if let Some(handle) = web_handle {
        handle.publish(
            "bridge",
            serde_json::to_value(&batch).unwrap_or_else(|_| json!({"messages": []})),
        );
        for (code, message) in &diagnostics {
            publish_diagnostic(handle, revision, "runtime", code, message);
        }
    } else {
        println!("{}", json!({"event": "input", "batch": batch}));
    }
    for (code, message) in diagnostics {
        eprintln!("weapp-simulator: {code}: {message}");
    }
    has_errors
}

#[cfg(feature = "desktop-window")]
fn mouse_button_index(button: winit::event::MouseButton) -> u8 {
    match button {
        winit::event::MouseButton::Left => 0,
        winit::event::MouseButton::Middle => 1,
        winit::event::MouseButton::Right => 2,
        winit::event::MouseButton::Back => 3,
        winit::event::MouseButton::Forward => 4,
        winit::event::MouseButton::Other(value) => value.min(u16::from(u8::MAX)) as u8,
    }
}

#[cfg(feature = "desktop-window")]
fn modifier_value(modifiers: winit::keyboard::ModifiersState) -> serde_json::Value {
    json!({
        "shift": modifiers.shift_key(),
        "ctrl": modifiers.control_key(),
        "alt": modifiers.alt_key(),
        "meta": modifiers.super_key(),
    })
}

#[cfg(feature = "desktop-window")]
fn physical_key_name(key: winit::keyboard::PhysicalKey) -> String {
    format!("{key:?}")
}

#[cfg(feature = "desktop-window")]
fn logical_key_name(key: &winit::keyboard::Key) -> String {
    use winit::keyboard::Key;
    match key {
        Key::Character(value) => value.to_string(),
        Key::Named(value) => format!("{value:?}"),
        Key::Unidentified(value) => format!("{value:?}"),
        Key::Dead(value) => value
            .map(|character| character.to_string())
            .unwrap_or_else(|| "Dead".to_owned()),
    }
}

#[cfg(feature = "desktop-window")]
fn touch_phase_name(phase: winit::event::TouchPhase) -> &'static str {
    match phase {
        winit::event::TouchPhase::Started => "started",
        winit::event::TouchPhase::Moved => "moved",
        winit::event::TouchPhase::Ended => "ended",
        winit::event::TouchPhase::Cancelled => "cancelled",
    }
}

fn publish_dev_event(
    handle: &container_simulator::web::WebSurfaceHandle,
    supervisor: &mut DevSupervisor,
    event: DevEvent,
) -> bool {
    match event {
        DevEvent::BuildStarted => {
            handle.clear_diagnostics();
            let engine = match supervisor.engine() {
                EngineKind::Quickjs => "quickjs",
                EngineKind::V8 => "v8",
            };
            let state = json!({
                "schemaVersion": 1,
                "revision": 0,
                "status": "starting",
                "engine": engine,
            });
            handle.set_state_json(state.clone());
            handle.publish("state", handle.state());
            false
        }
        DevEvent::BrowserRuntimePrepared { .. } => {
            eprintln!("weapp-simulator: verified static browser runtime; execution and presentation are not ready");
            false
        }
        DevEvent::PortableReady { revision, .. } => {
            publish_diagnostic(
                handle,
                revision,
                "pack",
                "ERR_UNSUPPORTED_CAPABILITY",
                "portable generation requires a browser Worker coordinator; no local runtime was started",
            );
            true
        }
        DevEvent::PackReady {
            revision,
            reload,
            report,
        } => {
            handle.clear_diagnostics();
            publish_simulator_report(handle, supervisor, revision, &report, "ready");
            handle.publish("ready", json!({"revision": revision, "report": report}));
            handle.publish(
                "reload",
                json!({"revision": revision, "kind": reload.map(|kind| format!("{kind:?}")), "report": report}),
            );
            // Emit route fallback after the successful reload so the warning
            // remains visible while stale build errors are already cleared.
            if let Some(diagnostic) = supervisor.take_route_warning() {
                publish_web_diagnostic(handle, diagnostic, false);
            }
            let batch = supervisor
                .simulator_mut()
                .map(|simulator| simulator.take_dev_errors())
                .unwrap_or_else(|| BridgeBatch::new(Vec::new()));
            let diagnostics = runtime_error_diagnostics(&batch);
            for (code, message) in &diagnostics {
                publish_diagnostic(handle, revision, "runtime", code, message);
            }
            !diagnostics.is_empty()
        }
        DevEvent::Diagnostic(diagnostic) => {
            let has_errors = diagnostic.severity == "error";
            publish_web_diagnostic(handle, diagnostic, true);
            has_errors
        }
        DevEvent::RuntimeUpdated {
            revision,
            batch,
            report,
        } => {
            handle.publish(
                "bridge",
                serde_json::to_value(&batch).unwrap_or_else(|_| json!({"messages": []})),
            );
            publish_simulator_report(handle, supervisor, revision, &report, "ready");
            let diagnostics = runtime_error_diagnostics(&batch);
            for (code, message) in &diagnostics {
                publish_diagnostic(handle, revision, "runtime", code, message);
            }
            !diagnostics.is_empty()
        }
        DevEvent::Exited(status) => {
            handle.publish(
                "error",
                json!({"code":"BUILD_EXITED","message":status.to_string()}),
            );
            // Publish the terminal state as an SSE event as well as storing it
            // for /api/state. Otherwise a connected browser keeps rendering
            // the last `ready` header forever when the watch process exits.
            let state = json!({
                "schemaVersion": 1,
                "revision": supervisor.revision(),
                "status": "stopped",
            });
            handle.set_state_json(state.clone());
            handle.publish("state", handle.state());
            true
        }
    }
}

fn publish_web_diagnostic(
    handle: &container_simulator::web::WebSurfaceHandle,
    diagnostic: container_simulator::dev::DevDiagnostic,
    publish_error: bool,
) {
    let message = diagnostic.message.clone();
    let code = diagnostic.code.clone();
    handle.publish_diagnostic(WebDiagnostic {
        schema_version: diagnostic.schema_version,
        revision: diagnostic.revision,
        phase: diagnostic.phase,
        severity: diagnostic.severity,
        code: code.clone(),
        file: diagnostic.file,
        message: message.clone(),
        stack: diagnostic.stack,
        timestamp: diagnostic.timestamp_ms.to_string(),
    });
    if publish_error {
        handle.publish("error", json!({"code": code, "message": message}));
    }
}

fn publish_simulator_state(
    handle: &container_simulator::web::WebSurfaceHandle,
    supervisor: &DevSupervisor,
    status: &str,
) {
    if let Some(simulator) = supervisor.simulator() {
        let report = simulator.report(status);
        publish_simulator_report(handle, supervisor, supervisor.revision(), &report, status);
    }
}

fn publish_simulator_report(
    handle: &container_simulator::web::WebSurfaceHandle,
    supervisor: &DevSupervisor,
    revision: u64,
    report: &container_simulator::SimulatorReport,
    status: &str,
) {
    publish_simulator_report_with_runtime(handle, supervisor.simulator(), revision, report, status);
}

fn publish_simulator_report_with_runtime(
    handle: &container_simulator::web::WebSurfaceHandle,
    simulator: Option<&Simulator>,
    revision: u64,
    report: &container_simulator::SimulatorReport,
    status: &str,
) {
    let mut state = serde_json::to_value(report).unwrap_or_else(|_| json!({}));
    if let Some(object) = state.as_object_mut() {
        object.insert("revision".into(), json!(revision));
        object.insert("status".into(), json!(status));
        // Page instances, including repeated visits to one route, own input
        // gestures. Read current runtime authority rather than the retained
        // render document, which may still belong to a previous page.
        let page_id = simulator
            .and_then(|simulator| simulator.host().session())
            .and_then(|session| session.app_service().pages().current())
            .map(|page| page.id.0.to_string());
        object.insert("currentPageId".into(), json!(page_id));
    }
    if let Some(simulator) = simulator {
        let publication = handle
            .set_renderer_profile(simulator.current_renderer_profile())
            .and_then(|()| {
                if let Some(request) = simulator.browser_render_request() {
                    handle.set_browser_view_request(simulator.session_id(), request)
                } else {
                    Ok(())
                }
            });
        if let Err(error) = publication {
            publish_diagnostic(handle, revision, "presentation", "ERR_RENDER", error);
        }
        synchronize_browser_retained_state(handle, simulator);
    }
    handle.set_state_json(state.clone());
    handle.publish("state", handle.state());
    if let Some(simulator) = simulator {
        if simulator.current_renderer_profile() == RendererProfile::WebView {
            // Browser layout and presentation are acknowledged by view.*.
            // No Skia frame or CPU page snapshot exists on this path.
            return;
        }
        if !simulator.has_current_skia_scene() {
            // State/configuration notifications can precede the visible page's
            // next render in every Skia mode. Retain diagnostic pixels without
            // publishing them as that page under a new transport identity.
            return;
        }
        if let Some(session) = simulator
            .host()
            .session()
            .filter(|s| s.page_render_mode() != PageRenderMode::Raster)
        {
            if let Some(frame) = session
                .accepted_page_observation()
                .map(|observation| observation.frame)
            {
                let generation = handle.presentation()["generation"].as_u64().unwrap_or(1);
                if let Err(error) = handle.publish_render_frame(
                    simulator.session_id(),
                    generation,
                    frame,
                    simulator.host().render_revision(),
                    simulator.host().render_duration_ms().unwrap_or(0.0),
                ) {
                    publish_diagnostic(handle, revision, "presentation", "ERR_RENDER_FRAME", error);
                }
            }
            return;
        }
        if let Ok(snapshot) = simulator.host().render_snapshot_ref() {
            let viewport = simulator.viewport();
            handle.set_render_time(simulator.host().render_duration_ms().unwrap_or(0.0));
            let generation = handle
                .presentation()
                .get("generation")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(1);
            if let Err(error) = handle.publish_frame_with_revision(
                simulator.session_id(),
                generation,
                viewport.width,
                viewport.height,
                snapshot,
                simulator.host().render_revision(),
            ) {
                publish_diagnostic(handle, revision, "presentation", "ERR_FRAME", error);
            }
        }
    }
}

fn publish_diagnostic(
    handle: &container_simulator::web::WebSurfaceHandle,
    revision: u64,
    phase: &str,
    code: &str,
    message: impl Into<String>,
) {
    let message = message.into();
    let diagnostic = WebDiagnostic {
        schema_version: 1,
        revision,
        phase: phase.to_owned(),
        severity: "error".to_owned(),
        code: code.to_owned(),
        file: None,
        message: message.clone(),
        stack: None,
        timestamp: format!("{}", now_ms()),
    };
    handle.publish_diagnostic(diagnostic);
    handle.publish("error", json!({"code": code, "message": message}));
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_ns() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u128::from(u64::MAX)) as u64
}

fn open_browser(url: &str) {
    let result = browser_open_command(std::env::consts::OS, url)
        .and_then(|command| spawn_browser_opener(command, url.to_owned()));
    if let Err(error) = result {
        eprintln!("weapp-simulator: cannot request browser opening: {error}; open {url} manually");
    }
    // Detach only the reaper thread. Some desktop launchers remain attached
    // until the browser closes; neither the runtime loop nor its shutdown may
    // wait for that user-owned window, and we must never terminate it.
}

fn browser_open_command(platform: &str, url: &str) -> io::Result<std::process::Command> {
    // WebSurface builds this exact URL shape from a numeric SocketAddr. Keep
    // that boundary explicit before passing anything through Windows `start`,
    // whose arguments are interpreted by cmd rather than by an ordinary argv
    // parser. Query strings, fragments and shell metacharacters are not input
    // to this convenience launcher.
    url.strip_prefix("http://")
        .and_then(|address| address.strip_suffix('/'))
        .and_then(|address| address.parse::<std::net::SocketAddr>().ok())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "expected an HTTP listener URL")
        })?;
    let mut command = match platform {
        "macos" => std::process::Command::new("open"),
        "linux" => std::process::Command::new("xdg-open"),
        "windows" => {
            let mut command = std::process::Command::new("cmd");
            // Disable cmd AutoRun, separate the /C switch from its command,
            // and supply start's empty window title before the URL.
            command.args(["/D", "/C", "start", ""]);
            command
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!("default browser opening is unavailable on {platform}"),
            ))
        }
    };
    command.arg(url);
    Ok(command)
}

fn spawn_browser_opener(
    mut command: std::process::Command,
    url: String,
) -> io::Result<std::thread::JoinHandle<io::Result<std::process::ExitStatus>>> {
    let program = command.get_program().to_string_lossy().into_owned();
    std::thread::Builder::new()
        .name("weapp-browser-opener".into())
        .spawn(move || {
            // Spawn inside the worker so a thread-creation failure cannot
            // leave an unowned Child. status() always waits/reaps a started
            // launcher without blocking the surface/runtime thread.
            let result = command.stdin(std::process::Stdio::null()).status();
            match &result {
                Ok(status) if !status.success() => eprintln!(
                    "weapp-simulator: browser launcher {program} exited with {status}; open {url} manually"
                ),
                Err(error) => eprintln!(
                    "weapp-simulator: browser launcher {program} failed: {error}; open {url} manually"
                ),
                _ => {}
            }
            result
        })
}

#[cfg(feature = "desktop-window")]
#[allow(deprecated)]
fn run_desktop_dev(
    mut supervisor: DevSupervisor,
    mut web: Option<WebSurface>,
    first_event: DevEvent,
    shutdown: Arc<AtomicBool>,
    mut presentation: PresentationSettings,
    software: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use desktop::DesktopPresenter;
    use winit::event::{ElementState, Event, MouseScrollDelta, WindowEvent};
    use winit::event_loop::{ControlFlow, EventLoop};
    use winit::keyboard::ModifiersState;

    let web_handle = web.as_ref().map(WebSurface::handle);
    if let Some(handle) = &web_handle {
        handle.set_presentation(serde_json::to_value(&presentation)?);
    }
    let mut cadence = FrameCadence::new(presentation.fps);
    let mut window_error = if let Some(handle) = &web_handle {
        publish_dev_event(handle, &mut supervisor, first_event)
    } else {
        report_dev_event(first_event, &mut supervisor)
    };
    let event_loop = match EventLoop::new() {
        Ok(event_loop) => event_loop,
        Err(error) => {
            finish_desktop_shutdown(&mut supervisor, &mut web, "initialization-error");
            return Err(error.into());
        }
    };
    let (viewport_width, viewport_height) = supervisor.viewport_size();
    let mut presenter = match DesktopPresenter::new(
        &event_loop,
        "Weapp Container simulator",
        viewport_width,
        viewport_height,
        software,
    ) {
        Ok(presenter) => presenter,
        Err(error) => {
            finish_desktop_shutdown(&mut supervisor, &mut web, "initialization-error");
            return Err(error.into());
        }
    };
    let mut last_cursor = (0.0_f32, 0.0_f32);
    let mut pointer_request_id = 0_u64;
    let mut pressed_buttons = 0_u16;
    let mut modifiers = ModifiersState::default();
    let mut last_presented_frame = None;
    let mut last_title = String::new();
    let mut shutdown_reason = "event-loop-exit";
    let mut web_error = None;
    let mut detach_result = None;
    // winit 0.30 permits a borrowed callback. Retain ownership outside it so
    // a run error that skips LoopExiting still has the same cleanup barrier.
    let run_result = event_loop.run(|event, target| match event {
        Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            window_id,
        } if window_id == presenter.window_id() => {
            // In `--surface both`, the browser is a peer of the desktop
            // window and must observe the same terminal lifecycle event. The
            // terminal event is flushed after watcher/packer shutdown in
            // LoopExiting, while the native window is still owned here.
            shutdown_reason = "window-closed";
            target.exit();
        }
        Event::WindowEvent {
            event: WindowEvent::Resized(size),
            window_id,
        } if window_id == presenter.window_id() => {
            if let Err(error) = presenter.resize(size) {
                window_error = true;
                if let Some(handle) = &web_handle {
                    publish_diagnostic(
                        handle,
                        supervisor.revision(),
                        "render",
                        "ERR_RENDER",
                        error.to_string(),
                    );
                }
                eprintln!("weapp-simulator: desktop resize failed: {error}");
            }
            // Resizing invalidates the native buffer even when the logical
            // runtime frame has not changed.
            presenter.request_redraw();
        }
        Event::WindowEvent {
            event: WindowEvent::RedrawRequested,
            window_id,
        } if window_id == presenter.window_id() => {
            if let Some(simulator) = supervisor.simulator_mut() {
                if simulator.host().render_revision() > 0 {
                    match presenter.present(simulator.host_mut()) {
                        Ok(()) => {
                            last_presented_frame = Some((
                                simulator.session_id().to_owned(),
                                simulator.host().render_revision(),
                            ));
                        }
                        Err(error) => {
                            window_error = true;
                            eprintln!("weapp-simulator: desktop presentation failed: {error}");
                        }
                    }
                }
            }
        }

        Event::WindowEvent {
            event: WindowEvent::CursorMoved { position, .. },
            window_id,
        } if window_id == presenter.window_id() => {
            let Ok(input_scale) = presenter.input_scale() else {
                return;
            };
            if supervisor
                .simulator()
                .map(|s| (s.session_id().to_owned(), s.host().render_revision()))
                != last_presented_frame
            {
                return;
            }
            last_cursor = (position.x as f32, position.y as f32);
            match dispatch_pointer_event(
                &mut supervisor,
                &mut pointer_request_id,
                DesktopPointerEvent {
                    event_type: "pointermove",
                    x: last_cursor.0,
                    y: last_cursor.1,
                    button: None,
                    buttons: pressed_buttons,
                    modifiers,
                },
                input_scale,
            ) {
                Ok(batch) => {
                    window_error |=
                        publish_desktop_batch(&web_handle, supervisor.revision(), batch);
                }
                Err(error) => {
                    window_error = true;
                    if let Some(handle) = &web_handle {
                        publish_diagnostic(
                            handle,
                            supervisor.revision(),
                            "event",
                            "EVENT_FAILED",
                            &error,
                        );
                    }
                    eprintln!("weapp-simulator: pointer event failed: {error}");
                }
            }
        }
        Event::WindowEvent {
            event: WindowEvent::ModifiersChanged(next),
            window_id,
        } if window_id == presenter.window_id() => {
            modifiers = next.state();
        }
        Event::WindowEvent {
            event: WindowEvent::MouseInput { state, button, .. },
            window_id,
        } if window_id == presenter.window_id() => {
            let Ok(input_scale) = presenter.input_scale() else {
                return;
            };
            if supervisor
                .simulator()
                .map(|s| (s.session_id().to_owned(), s.host().render_revision()))
                != last_presented_frame
            {
                return;
            }
            let button_index = mouse_button_index(button);
            let bit = 1_u16.checked_shl(u32::from(button_index)).unwrap_or(0);
            if state == ElementState::Pressed {
                pressed_buttons |= bit;
            } else {
                pressed_buttons &= !bit;
            }
            // Keep the mini-program-facing tap event for the common left
            // button release while exposing pointer phases for other mouse
            // buttons. This preserves existing bindtap fixtures and still
            // gives desktop adapters the richer key/mouse stream.
            let event_type = if state == ElementState::Pressed {
                "pointerdown"
            } else if button_index == 0 {
                "tap"
            } else {
                "pointerup"
            };
            match dispatch_pointer_event(
                &mut supervisor,
                &mut pointer_request_id,
                DesktopPointerEvent {
                    event_type,
                    x: last_cursor.0,
                    y: last_cursor.1,
                    button: Some(button_index),
                    buttons: pressed_buttons,
                    modifiers,
                },
                input_scale,
            ) {
                Ok(batch) => {
                    window_error |=
                        publish_desktop_batch(&web_handle, supervisor.revision(), batch);
                }
                Err(error) => {
                    window_error = true;
                    if let Some(handle) = &web_handle {
                        publish_diagnostic(
                            handle,
                            supervisor.revision(),
                            "event",
                            "EVENT_FAILED",
                            error,
                        );
                    } else {
                        eprintln!("weapp-simulator: pointer event failed: {error}");
                    }
                }
            }
        }
        Event::WindowEvent {
            event: WindowEvent::MouseWheel { delta, phase, .. },
            window_id,
        } if window_id == presenter.window_id() => {
            let Ok(input_scale) = presenter.input_scale() else {
                return;
            };
            if supervisor
                .simulator()
                .map(|s| (s.session_id().to_owned(), s.host().render_revision()))
                != last_presented_frame
            {
                return;
            }
            let (delta_x, delta_y, delta_mode) = match delta {
                // winit positive deltas move content down/right; the bridge
                // uses DOM wheel signs (positive increases scroll offset).
                MouseScrollDelta::LineDelta(x, y) => (-f64::from(x), -f64::from(y), 1_u8),
                MouseScrollDelta::PixelDelta(position) => (-position.x, -position.y, 0_u8),
            };
            let payload = json!({
                "type": "wheel",
                "x": last_cursor.0,
                "y": last_cursor.1,
                "deltaX": delta_x,
                "deltaY": delta_y,
                "deltaMode": delta_mode,
                "phase": touch_phase_name(phase),
                "modifiers": modifier_value(modifiers),
                "bubbles": true,
            });
            match dispatch_input_event(
                &mut supervisor,
                &mut pointer_request_id,
                payload,
                input_scale,
            ) {
                Ok(batch) => {
                    window_error |=
                        publish_desktop_batch(&web_handle, supervisor.revision(), batch);
                }
                Err(error) => {
                    window_error = true;
                    if let Some(handle) = &web_handle {
                        publish_diagnostic(
                            handle,
                            supervisor.revision(),
                            "event",
                            "EVENT_FAILED",
                            error,
                        );
                    } else {
                        eprintln!("weapp-simulator: wheel event failed: {error}");
                    }
                }
            }
        }
        Event::WindowEvent {
            event: WindowEvent::KeyboardInput { event, .. },
            window_id,
        } if window_id == presenter.window_id() => {
            let Ok(input_scale) = presenter.input_scale() else {
                return;
            };
            if supervisor
                .simulator()
                .map(|s| (s.session_id().to_owned(), s.host().render_revision()))
                != last_presented_frame
            {
                return;
            }
            let event_type = match event.state {
                ElementState::Pressed => "keydown",
                ElementState::Released => "keyup",
            };
            let payload = json!({
                "type": event_type,
                "code": physical_key_name(event.physical_key),
                "key": logical_key_name(&event.logical_key),
                "text": event.text.as_ref().map(ToString::to_string),
                "repeat": event.repeat,
                "modifiers": modifier_value(modifiers),
                "bubbles": true,
            });
            match dispatch_input_event(
                &mut supervisor,
                &mut pointer_request_id,
                payload,
                input_scale,
            ) {
                Ok(batch) => {
                    window_error |=
                        publish_desktop_batch(&web_handle, supervisor.revision(), batch);
                }
                Err(error) => {
                    window_error = true;
                    if let Some(handle) = &web_handle {
                        publish_diagnostic(
                            handle,
                            supervisor.revision(),
                            "event",
                            "EVENT_FAILED",
                            error,
                        );
                    } else {
                        eprintln!("weapp-simulator: keyboard event failed: {error}");
                    }
                }
            }
        }
        Event::AboutToWait => {
            // Timers, file watching and the shared Web listener need regular
            // turns even when no OS input/redraw events arrive. Waking the
            // pump is independent from presenting a new frame.
            target.set_control_flow(ControlFlow::WaitUntil(
                std::time::Instant::now() + Duration::from_millis(1),
            ));
            if shutdown.load(Ordering::SeqCst) {
                shutdown_reason = "signal";
                if web_handle.is_none() {
                    eprintln!("weapp-simulator: shutting down after signal");
                }
                target.exit();
                return;
            }
            if let Some(surface) = web.as_mut() {
                if let Err(error) = surface.poll() {
                    if let Some(handle) = &web_handle {
                        publish_diagnostic(
                            handle,
                            supervisor.revision(),
                            "web",
                            "WEB_SURFACE_FAILED",
                            error.to_string(),
                        );
                    }
                    eprintln!("weapp-simulator: shared Web surface failed: {error}");
                    shutdown_reason = "web-error";
                    web_error = Some(error);
                    target.exit();
                    return;
                }
                if let Some(handle) = &web_handle {
                    apply_web_presentation(&mut supervisor, handle, &mut presentation);
                    window_error |= dispatch_web_requests(&mut supervisor, handle);
                }
            }
            let redraw = cadence.due(std::time::Instant::now(), presentation.fps);
            match supervisor.pump_runtime_with_render(now_ns(), redraw) {
                Ok(Some(event)) => {
                    let recovered = matches!(&event, DevEvent::PackReady { .. });
                    let has_errors = if let Some(handle) = &web_handle {
                        publish_dev_event(handle, &mut supervisor, event)
                    } else {
                        report_dev_event(event, &mut supervisor)
                    };
                    window_error = desktop_error_status(window_error, recovered, has_errors);
                }
                Ok(None) => {}
                Err(error) => {
                    window_error = true;
                    if let Some(handle) = &web_handle {
                        publish_diagnostic(
                            handle,
                            supervisor.revision(),
                            "runtime",
                            "DEV_FAILED",
                            error.to_string(),
                        );
                    } else {
                        eprintln!("weapp-simulator: {error}");
                    }
                }
            }
            match supervisor.poll() {
                Ok(Some(event)) => {
                    let exited = matches!(event, DevEvent::Exited(_));
                    let pack_ready = matches!(&event, DevEvent::PackReady { .. });
                    let has_errors = if let Some(handle) = &web_handle {
                        publish_dev_event(handle, &mut supervisor, event)
                    } else {
                        let has_errors = report_dev_event(event, &mut supervisor);
                        if pack_ready {
                            if let Some(diagnostic) = supervisor.take_route_warning() {
                                eprintln!(
                                    "weapp-simulator: {}: {}",
                                    diagnostic.code, diagnostic.message
                                );
                            }
                        }
                        has_errors
                    };
                    window_error = desktop_error_status(window_error, pack_ready, has_errors);
                    if exited {
                        shutdown_reason = "wv-exited";
                        target.exit();
                        return;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    window_error = true;
                    if let Some(handle) = &web_handle {
                        publish_diagnostic(
                            handle,
                            supervisor.revision(),
                            "supervisor",
                            "DEV_FAILED",
                            error.to_string(),
                        );
                    } else {
                        eprintln!("weapp-simulator: {error}");
                    }
                }
            }
            let route = supervisor
                .simulator()
                .and_then(|simulator| simulator.report("ready").route)
                .unwrap_or_else(|| "—".into());
            let status = if window_error {
                "error"
            } else if supervisor.simulator().is_some() {
                "ready"
            } else {
                "starting"
            };
            let title = format!(
                "Weapp Container simulator · rev {} · {} · {}",
                supervisor.revision(),
                route,
                status
            );
            if title != last_title {
                presenter.set_title(&title);
                last_title = title;
            }
            let current_frame = supervisor.simulator().and_then(|simulator| {
                let revision = simulator.host().render_revision();
                (revision > 0).then(|| (simulator.session_id().to_owned(), revision))
            });
            if current_frame.is_some() && current_frame != last_presented_frame {
                presenter.request_redraw();
            }
        }
        Event::LoopExiting => {
            detach_result = Some(match supervisor.simulator_mut() {
                Some(simulator) => presenter.detach(simulator.host_mut()),
                None => Ok(()),
            });
            finish_desktop_shutdown(&mut supervisor, &mut web, shutdown_reason);
        }
        _ => {}
    });
    // Idempotent fallback for a controlled winit error without LoopExiting.
    // The supervisor still owns the runtime; detach its Skia resources before
    // dropping the window/context, and preserve teardown failures for callers.
    let detach_result = detach_result.unwrap_or_else(|| match supervisor.simulator_mut() {
        Some(simulator) => presenter.detach(simulator.host_mut()),
        None => Ok(()),
    });
    finish_desktop_shutdown(&mut supervisor, &mut web, shutdown_reason);
    drop(presenter);
    run_result?;
    detach_result?;
    if let Some(error) = web_error {
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::dispatch_web_bridge;
    use super::next_cli_option;
    use super::parse_engine;
    #[cfg(feature = "desktop-window")]
    use super::publish_desktop_shutdown;
    use super::runtime_error_diagnostics;
    use container_bridge::{op, BridgeBatch, BridgeEnvelope, EnvelopeKind};
    use container_core::EngineKind;
    #[cfg(feature = "desktop-window")]
    use container_simulator::web::WebSurface;
    use serde_json::json;

    #[test]
    fn browser_startup_pins_explicit_cli_inputs_without_remote_raster_settings() {
        let mut config = container_simulator::SimulatorConfig {
            route: Some("/pages/secondary/index".into()),
            initial_data: json!({"count": 41, "title": "Worker data"}),
            render_scale: 4.0,
            ..container_simulator::SimulatorConfig::default()
        };
        config.viewport.width = 412.0;
        config.viewport.height = 732.0;
        for profile in [
            container_ir::RendererProfile::WebView,
            container_ir::RendererProfile::Skia,
        ] {
            let bytes =
                super::browser_startup_intent(&config, profile, None).expect("valid Worker intent");
            let intent: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                intent,
                json!({
                    "schemaVersion":1, "execution":"worker", "engine":"quickjs",
                    "viewport":{"width":412,"height":732},
                    "rendererPolicy":{"mode":"force","profile":profile},
                    "route":"pages/secondary/index",
                    "data":{"count":41,"title":"Worker data"},
                })
            );
        }
        config.route = None;
        let intent: serde_json::Value = serde_json::from_slice(
            &super::browser_startup_intent(&config, container_ir::RendererProfile::Skia, None)
                .unwrap(),
        )
        .unwrap();
        assert!(
            intent.get("route").is_none(),
            "default route stays pack-authoritative"
        );
    }

    #[test]
    fn browser_startup_refuses_invalid_logical_sizes_before_float_conversion() {
        for size in [f32::NAN, f32::INFINITY, -1.0, 0.0, 1.5, 4097.0] {
            let mut config = container_simulator::SimulatorConfig::default();
            config.viewport.width = size;
            assert!(
                super::browser_startup_intent(&config, container_ir::RendererProfile::Skia, None)
                    .is_err(),
                "{size}"
            );
            config.viewport.width = 375.0;
            config.viewport.height = size;
            assert!(
                super::browser_startup_intent(&config, container_ir::RendererProfile::Skia, None)
                    .is_err(),
                "{size}"
            );
        }
    }

    #[test]
    fn browser_skia_startup_binds_scale_without_changing_simulated_metrics() {
        let config = container_simulator::SimulatorConfig::default();
        for scale in [
            super::RenderScale::default(),
            super::RenderScale::Fixed(2.0),
        ] {
            let bytes = super::browser_startup_intent(
                &config,
                container_ir::RendererProfile::Skia,
                Some(scale),
            )
            .unwrap();
            let intent: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(intent["renderScale"], json!(scale));
            assert_eq!(intent["viewport"], json!({"width":375,"height":667}));
            assert!(intent.get("metrics").is_none());
        }
        assert!(super::browser_startup_intent(
            &config,
            container_ir::RendererProfile::WebView,
            Some(super::RenderScale::Fixed(2.0)),
        )
        .is_err());
        let mut large = config;
        large.viewport.width = 1000.0;
        large.viewport.height = 1000.0;
        assert!(super::browser_startup_intent(
            &large,
            container_ir::RendererProfile::Skia,
            Some(super::RenderScale::Fixed(3.0)),
        )
        .is_err());
    }

    #[test]
    fn browser_startup_refuses_an_unattached_compatibility_profile() {
        assert!(super::browser_startup_intent(
            &container_simulator::SimulatorConfig::default(),
            container_ir::RendererProfile::SkylineCompat,
            None,
        )
        .is_err());
    }

    #[test]
    fn web_stale_input_rejection_preserves_flat_response_correlation() {
        let mut request = BridgeEnvelope::request(
            "web-session",
            "pointer-1",
            op::EVENT_BATCH,
            json!({"logicalViewport":{"width":375,"height":667},"events":[{"type":"tap"}]}),
        );
        request.protocol_version = "1.1".into();
        request.cancel_token = Some("pointer-cancel".into());
        request.deadline_ns = Some(100);
        request.trace_id = Some("pointer-trace".into());
        let batch = dispatch_web_bridge(
            &serde_json::to_vec(&request).unwrap(),
            &json!({"logicalWidth":667,"logicalHeight":375}),
            |_| panic!("stale input must not enter the runtime"),
        )
        .unwrap();
        let response = &batch.messages[0];
        assert_eq!(batch.messages.len(), 1);
        assert_eq!(response.kind, EnvelopeKind::Response);
        assert_eq!(response.protocol_version, request.protocol_version);
        assert_eq!(response.session_id, request.session_id);
        assert_eq!(response.request_id, request.request_id);
        assert_eq!(response.op, request.op);
        assert_eq!(response.cancel_token, request.cancel_token);
        assert_eq!(response.deadline_ns, request.deadline_ns);
        assert_eq!(response.trace_id, request.trace_id);
        assert_eq!(response.payload["ok"], false);
        assert_eq!(response.payload["error"]["code"], "ERR_CANCELLED");
    }

    #[test]
    fn web_batch_guards_every_input_and_preserves_dispatch_and_response_order() {
        let operations = [
            ("patch", op::DATA_PATCH_BATCH, json!({"patches":[]})),
            (
                "stale-a",
                op::EVENT_BATCH,
                json!({"logicalViewport":{"width":375,"height":667}}),
            ),
            (
                "current",
                op::EVENT_BATCH,
                json!({"logicalViewport":{"width":667,"height":375}}),
            ),
            (
                "stale-b",
                op::EVENT_BATCH,
                json!({"logicalViewport":{"width":500,"height":500}}),
            ),
            ("render", op::RENDER_COMMIT, json!({})),
        ];
        let requests = BridgeBatch::new(
            operations
                .into_iter()
                .map(|(id, op, payload)| BridgeEnvelope::request("session", id, op, payload))
                .collect(),
        );
        let mut dispatched = Vec::new();
        let batch = dispatch_web_bridge(
            &serde_json::to_vec(&requests).unwrap(),
            &json!({"logicalWidth":667,"logicalHeight":375}),
            |mut request| {
                dispatched.push(request.request_id.clone());
                request.kind = EnvelopeKind::Response;
                request.payload = json!({"ok":true});
                let event = BridgeEnvelope::event(
                    "session",
                    op::DIAGNOSTIC,
                    json!({"after":request.request_id}),
                );
                Ok(BridgeBatch::new(vec![request, event]))
            },
        )
        .unwrap();
        assert_eq!(dispatched, ["patch", "current", "render"]);
        let responses = batch
            .messages
            .iter()
            .map(|message| {
                if message.kind == EnvelopeKind::Event {
                    format!("after:{}", message.payload["after"].as_str().unwrap())
                } else {
                    message.request_id.clone()
                }
            })
            .collect::<Vec<_>>();
        assert_eq!(
            responses,
            [
                "patch",
                "after:patch",
                "stale-a",
                "current",
                "after:current",
                "stale-b",
                "render",
                "after:render"
            ]
        );
        for index in [2, 5] {
            assert_eq!(batch.messages[index].payload["ok"], false);
            assert_eq!(
                batch.messages[index].payload["error"]["code"],
                "ERR_CANCELLED"
            );
        }
    }

    #[test]
    fn web_inputs_without_viewport_remain_backward_compatible() {
        let request = BridgeEnvelope::request(
            "session",
            "legacy-input",
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":10,"y":20}]}),
        );
        let result = dispatch_web_bridge(
            &serde_json::to_vec(&request).unwrap(),
            &json!({"logicalWidth":667,"logicalHeight":375}),
            |received| {
                assert_eq!(received, request);
                Ok(BridgeBatch::new(vec![received]))
            },
        )
        .unwrap();
        assert_eq!(result.messages, vec![request]);
    }

    #[test]
    fn malformed_web_batch_is_rejected_before_any_operation_is_dispatched() {
        let request = BridgeEnvelope::request("session", "patch", op::DATA_PATCH_BATCH, json!({}));
        let malformed = json!({"messages":[request,{"op":"event.batch"}]});
        assert!(dispatch_web_bridge(
            &serde_json::to_vec(&malformed).unwrap(),
            &json!({"logicalWidth":375,"logicalHeight":667}),
            |_| panic!("malformed batch must be decoded before dispatch"),
        )
        .is_err());
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn permitted_dom_candidate_survives_new_request_until_runtime_ack_or_abort() {
        use container_ir::*;
        use container_runtime::BrowserViewSubmission;
        use container_simulator::web::WebSurface;
        use container_simulator::{Simulator, SimulatorConfig};
        use serde_json::Value;
        use std::{fs, path::PathBuf};
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).expect("remove owned DOM ACK fixture");
            }
        }
        let fixture = Fixture(std::env::temp_dir().join(format!(
            "weapp-dom-ack-race-{}-{}",
            std::process::id(),
            super::now_ns()
        )));
        fs::create_dir_all(fixture.0.join("blobs/sha256")).unwrap();
        let blob = |bytes: &[u8]| {
            let hash = hex_digest(bytes);
            fs::write(fixture.0.join("blobs/sha256").join(&hash), bytes).unwrap();
            hash
        };
        let route = "pages/index/index";
        let mut manifest = ContainerManifestV1 {
            schema_version: RENDERING_MANIFEST_SCHEMA_VERSION,
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "dom-ack-race-test".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "module:app.js".into(),
            },
            routes: vec![Route {
                id: format!("route:{route}"),
                path: route.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: format!("module:{route}.js"),
            }],
            rendering: Some(RendererProfiles {
                default: RendererProfile::WebView,
                ..Default::default()
            }),
            ..Default::default()
        };
        for (id,source,scope) in [
            ("module:app.js","App({readies:0});",ModuleScope::App),
            ("module:pages/index/index.js","Page({data:{value:0},onReady(){getApp().readies++}});exports.inspect=()=>getApp().readies;",ModuleScope::Page)
        ] {manifest.modules.push(Module{id:id.into(),sha256:blob(source.as_bytes()),format:ModuleFormat::Commonjs,scope,dependencies:vec![]});}
        let ast = parse_wxml("<view>retained candidate</view>").unwrap();
        manifest.templates.push(Template {
            id: format!("template:{route}.wxml"),
            wxml_ast: format!("sha256:{}", blob(&ast.canonical_json().unwrap())),
            bindings: vec![],
            wxs_modules: Default::default(),
        });
        let resource = b"encoded image retained across a new input request";
        manifest.assets.push(Asset {
            path: "retained.png".into(),
            sha256: blob(resource),
            mime: "image/png".into(),
            size: resource.len() as u64,
        });
        manifest.refresh_integrity().unwrap();
        fs::write(
            fixture.0.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let mut simulator = Simulator::from_pack_dir(
            &fixture.0,
            SimulatorConfig {
                browser_view_enabled: true,
                ..Default::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.configure_browser_view();
        handle
            .set_renderer_profile(RendererProfile::WebView)
            .unwrap();
        handle
            .set_browser_view_request(
                simulator.session_id(),
                simulator.browser_render_request().unwrap(),
            )
            .unwrap();
        fn synced(
            simulator: &mut Simulator,
            handle: &container_simulator::web::WebSurfaceHandle,
            id: &str,
            operation: &str,
            payload: Value,
        ) -> BridgeBatch {
            let abort = (operation == op::VIEW_ABORT)
                .then(|| serde_json::from_value::<PresentationKey>(payload.clone()).unwrap());
            let mut batch = simulator
                .dispatch(BridgeEnvelope::request(
                    simulator.session_id(),
                    id,
                    operation,
                    payload,
                ))
                .unwrap();
            super::synchronize_browser_publication(handle, simulator, &mut batch, abort.as_ref());
            batch
        }
        fn response(batch: &BridgeBatch) -> &Value {
            &batch
                .messages
                .iter()
                .find(|message| message.kind == EnvelopeKind::Response)
                .expect("correlated response")
                .payload
        }
        let request = simulator.browser_render_request().unwrap().clone();
        let generation = handle.state()["viewAuthority"]["surfaceGeneration"].clone();
        let prepared = synced(
            &mut simulator,
            &handle,
            "prepare-a",
            op::VIEW_PREPARE,
            json!({"version":"1.0","surfaceGeneration":generation,"render":request.render}),
        );
        assert_eq!(response(&prepared)["ok"], true);
        let submission: BrowserViewSubmission =
            serde_json::from_value(response(&prepared)["submission"].clone()).unwrap();
        assert!(simulator
            .host()
            .is_browser_view_pending(&submission.key)
            .unwrap());
        let mut work: Vec<_> = submission.document.nodes.iter().collect();
        let mut nodes = Vec::new();
        while let Some(node) = work.pop() {
            nodes.push(BrowserNodeGeometry {
                occurrence_id: node.occurrence_id().into(),
                border_box: ViewRect {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 30.0,
                },
                scroll_offset: ViewPoint { x: 0.0, y: 0.0 },
                scroll_extent: ViewSize {
                    width: 100.0,
                    height: 30.0,
                },
                client_size: ViewSize {
                    width: 100.0,
                    height: 30.0,
                },
            });
            if let ViewNode::Element { children, .. } = node {
                work.extend(children);
            }
        }
        let geometry = BrowserGeometryBatch {
            version: "1.0".into(),
            key: submission.key.clone(),
            epoch: 0,
            viewport: submission.viewport,
            nodes,
        };
        let permission = synced(
            &mut simulator,
            &handle,
            "permit-a",
            op::VIEW_PREPARE_COMMIT,
            serde_json::to_value(geometry).unwrap(),
        );
        let permit = response(&permission)["permit"].clone();
        assert_eq!(response(&permission)["ok"], true);
        let inspected = synced(
            &mut simulator,
            &handle,
            "inspect-before",
            op::MODULE_CALL,
            json!({"moduleId":"module:pages/index/index.js","export":"inspect","args":[]}),
        );
        assert_eq!(response(&inspected)["result"][0], 0);

        // A timer/setData turn publishes a newer desired input after the
        // browser received its permit but before its visible-frame ACK arrives.
        let patched = synced(
            &mut simulator,
            &handle,
            "patch-between",
            op::DATA_PATCH_BATCH,
            json!({"pageId":submission.key.page_id,"patches":[{"path":"value","op":"set","value":1}]}),
        );
        assert_eq!(response(&patched)["ok"], true);
        simulator.pump(0).unwrap();
        assert_ne!(
            simulator.browser_render_request().unwrap().revision,
            request.revision
        );
        handle
            .set_browser_view_request(
                simulator.session_id(),
                simulator.browser_render_request().unwrap(),
            )
            .unwrap();
        super::synchronize_browser_retained_state(&handle, &simulator);
        let acknowledged = synced(
            &mut simulator,
            &handle,
            "ack-a",
            op::VIEW_PRESENTED,
            permit.clone(),
        );
        assert_eq!(
            response(&acknowledged)["ok"],
            true,
            "runtime accepted ACK must not be rewritten as a cache error: {acknowledged:?}"
        );
        assert_eq!(
            handle.state()["viewPresented"]["key"],
            serde_json::to_value(&submission.key).unwrap()
        );
        let repeated = synced(
            &mut simulator,
            &handle,
            "ack-a-again",
            op::VIEW_PRESENTED,
            permit,
        );
        assert_eq!(response(&repeated)["ok"], true);
        let inspected = synced(
            &mut simulator,
            &handle,
            "inspect-after",
            op::MODULE_CALL,
            json!({"moduleId":"module:pages/index/index.js","export":"inspect","args":[]}),
        );
        assert_eq!(
            response(&inspected)["result"][0],
            1,
            "onReady occurs once across late and repeated ACKs"
        );

        // A genuine runtime abort revokes the cache, unlike a newer desired
        // request. Reconciliation also applies when retirement is host-driven.
        let request = simulator.browser_render_request().unwrap().clone();
        let next = synced(
            &mut simulator,
            &handle,
            "prepare-b",
            op::VIEW_PREPARE,
            json!({"version":"1.0","surfaceGeneration":generation,"render":request.render}),
        );
        let next_key: PresentationKey =
            serde_json::from_value(response(&next)["submission"]["key"].clone()).unwrap();
        assert!(simulator.host().is_browser_view_pending(&next_key).unwrap());
        let mut retained = false;
        handle.retain_browser_pending(|key| {
            retained = key == &next_key;
            true
        });
        assert!(retained);
        simulator
            .dispatch(BridgeEnvelope::request(
                simulator.session_id(),
                "abort-b",
                op::VIEW_ABORT,
                serde_json::to_value(&next_key).unwrap(),
            ))
            .unwrap();
        super::synchronize_browser_retained_state(&handle, &simulator);
        assert!(!simulator.host().is_browser_view_pending(&next_key).unwrap());
        handle.retain_browser_pending(|_| panic!("runtime-aborted cache must already be removed"));
        assert_eq!(
            handle.state()["viewPresented"]["key"],
            serde_json::to_value(&submission.key).unwrap()
        );
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    #[test]
    fn external_presentation_stages_pending_page_without_publishing_the_previous_scene() {
        presentation_stages_pending_page_without_publishing_the_previous_scene(
            container_render_skia::PageRenderMode::ExternalFrame,
        );
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    #[test]
    fn software_presentation_stages_pending_page_without_relabeling_retained_pixels() {
        presentation_stages_pending_page_without_publishing_the_previous_scene(
            container_render_skia::PageRenderMode::Raster,
        );
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn presentation_stages_pending_page_without_publishing_the_previous_scene(
        mode: container_render_skia::PageRenderMode,
    ) {
        use super::{
            apply_web_presentation_candidate, publish_simulator_report_with_runtime,
            reserve_web_presentation,
        };
        use container_ir::*;
        use container_render_skia::{PageRenderMode, Renderer};
        use container_simulator::presentation::{PresentationSettings, RenderScale};
        use container_simulator::web::WebSurface;
        use container_simulator::{Simulator, SimulatorConfig};
        use serde_json::Value;
        use std::{
            fs,
            io::{Read, Write},
            net::TcpStream,
            path::PathBuf,
            time::{Duration, Instant},
        };

        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).expect("remove owned pending-scene fixture");
            }
        }
        #[derive(Debug, PartialEq)]
        struct PublishedFrame {
            metadata: Value,
            response_hash: String,
            response_bytes: usize,
        }
        fn response(surface: &mut WebSurface, mode: PageRenderMode) -> Vec<u8> {
            let address = surface.local_addr();
            let client = std::thread::spawn(move || {
                let mut stream = TcpStream::connect(address).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let request: &[u8] = if mode == PageRenderMode::Raster {
                    b"GET /api/frame HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
                } else {
                    b"GET /api/render-frame HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
                };
                stream.write_all(request).unwrap();
                let mut bytes = Vec::new();
                stream.read_to_end(&mut bytes).unwrap();
                bytes
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            while !client.is_finished() && Instant::now() < deadline {
                surface.poll().unwrap();
                std::thread::sleep(Duration::from_millis(1));
            }
            client.join().unwrap()
        }
        fn frame(surface: &mut WebSurface, mode: PageRenderMode) -> PublishedFrame {
            let bytes = response(surface, mode);
            assert!(bytes.starts_with(b"HTTP/1.1 200"));
            let body = bytes
                .windows(4)
                .position(|value| value == b"\r\n\r\n")
                .unwrap()
                + 4;
            let metadata = if mode == PageRenderMode::Raster {
                let header_bytes =
                    u32::from_le_bytes(bytes[body..body + 4].try_into().unwrap()) as usize;
                let metadata: Value =
                    serde_json::from_slice(&bytes[body + 4..body + 4 + header_bytes]).unwrap();
                assert_eq!(
                    bytes.len() - body - 4 - header_bytes,
                    metadata["byteLength"].as_u64().unwrap() as usize
                );
                metadata
            } else {
                serde_json::from_slice(&bytes[body..]).unwrap()
            };
            PublishedFrame {
                metadata,
                response_hash: hex_digest(&bytes),
                response_bytes: bytes.len(),
            }
        }
        let fixture = Fixture(std::env::temp_dir().join(format!(
            "weapp-pending-scene-{}-{}",
            std::process::id(),
            super::now_ns()
        )));
        fs::create_dir_all(fixture.0.join("blobs/sha256")).unwrap();
        let blob = |bytes: &[u8]| {
            let hash = hex_digest(bytes);
            fs::write(fixture.0.join("blobs/sha256").join(&hash), bytes).unwrap();
            hash
        };
        let route = "pages/index/index";
        let ast = parse_wxml("<view id=\"retained\">current scene</view>").unwrap();
        let mut manifest = ContainerManifestV1 {
            schema_version: RENDERING_MANIFEST_SCHEMA_VERSION,
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "pending-scene-test".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "module:app.js".into(),
            },
            routes: vec![Route {
                id: format!("route:{route}"),
                path: route.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: format!("module:{route}.js"),
            }],
            templates: vec![Template {
                id: format!("template:{route}.wxml"),
                wxml_ast: format!("sha256:{}", blob(&ast.canonical_json().unwrap())),
                bindings: vec![],
                wxs_modules: Default::default(),
            }],
            ..Default::default()
        };
        for (id, source, scope) in [
            ("module:app.js", "App({});", ModuleScope::App),
            (
                "module:pages/index/index.js",
                "Page({});",
                ModuleScope::Page,
            ),
        ] {
            manifest.modules.push(Module {
                id: id.into(),
                sha256: blob(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: vec![],
            });
        }
        for engine in [EngineKind::Quickjs, EngineKind::V8]
            .into_iter()
            .filter(|engine| container_runtime::engine_provider_compiled(*engine))
        {
            for profile in [RendererProfile::Skia, RendererProfile::SkylineCompat] {
                manifest.rendering = Some(RendererProfiles {
                    default: profile,
                    ..Default::default()
                });
                manifest.refresh_integrity().unwrap();
                fs::write(
                    fixture.0.join("manifest.json"),
                    serde_json::to_vec(&manifest).unwrap(),
                )
                .unwrap();
                let mut simulator = Simulator::from_pack_dir(
                    &fixture.0,
                    SimulatorConfig {
                        engine,
                        page_render_mode: mode,
                        ..Default::default()
                    },
                )
                .unwrap();
                let mut surface = WebSurface::localhost(0).unwrap();
                let handle = surface.handle();
                let before_startup_trace = simulator.trace_summary().total_records;
                assert!(simulator
                    .host()
                    .session()
                    .unwrap()
                    .renderer_if_initialized()
                    .is_none());
                publish_simulator_report_with_runtime(
                    &handle,
                    Some(&simulator),
                    0,
                    &simulator.report("starting"),
                    "starting",
                );
                assert_eq!(handle.state().get("currentPageId"), Some(&Value::Null));
                assert_eq!(
                    simulator.trace_summary().total_records,
                    before_startup_trace
                );
                assert!(simulator
                    .host()
                    .session()
                    .unwrap()
                    .renderer_if_initialized()
                    .is_none());
                assert!(response(&mut surface, mode).starts_with(b"HTTP/1.1 404"));
                simulator.run().unwrap();
                assert!(simulator.has_current_skia_scene());
                let first_page = simulator.host().view_document().unwrap().unwrap().page_id;
                let settings = PresentationSettings::default();
                handle.set_presentation(serde_json::to_value(&settings).unwrap());
                publish_simulator_report_with_runtime(
                    &handle,
                    Some(&simulator),
                    1,
                    &simulator.report("passed"),
                    "ready",
                );
                assert_eq!(handle.state()["currentPageId"], first_page.to_string());
                let initial = frame(&mut surface, mode);
                let patched = simulator
                    .dispatch(BridgeEnvelope::request(
                        simulator.session_id(),
                        "ordinary-page-update",
                        op::DATA_PATCH_BATCH,
                        json!({"pageId":first_page,"patches":[{"path":"updated","op":"set","value":true}]}),
                    ))
                    .unwrap();
                assert!(!patched
                    .messages
                    .iter()
                    .any(|message| message.payload["ok"] == false));
                // Pending data on the same page does not retire its accepted
                // scene. Publication must not depend on pump's input-dedup key.
                assert!(simulator.has_current_skia_scene());
                let pending_data_trace = simulator.trace_summary().total_records;
                publish_simulator_report_with_runtime(
                    &handle,
                    Some(&simulator),
                    1,
                    &simulator.report("passed"),
                    "ready",
                );
                assert_eq!(simulator.trace_summary().total_records, pending_data_trace);
                assert_eq!(frame(&mut surface, mode), initial);
                // A fresh transport has no cached frame to hide an incorrect
                // rejection of the same page's still-accepted scene.
                {
                    let mut pending_surface = WebSurface::localhost(0).unwrap();
                    let pending_handle = pending_surface.handle();
                    pending_handle.set_presentation(serde_json::to_value(&settings).unwrap());
                    publish_simulator_report_with_runtime(
                        &pending_handle,
                        Some(&simulator),
                        1,
                        &simulator.report("passed"),
                        "ready",
                    );
                    assert_eq!(
                        frame(&mut pending_surface, mode).metadata["sourceFrameId"],
                        initial.metadata["sourceFrameId"]
                    );
                    assert_eq!(simulator.trace_summary().total_records, pending_data_trace);
                }
                simulator.pump(0).unwrap();
                publish_simulator_report_with_runtime(
                    &handle,
                    Some(&simulator),
                    1,
                    &simulator.report("passed"),
                    "ready",
                );
                assert_eq!(handle.state()["currentPageId"], first_page.to_string());
                let previous = frame(&mut surface, mode);
                let pushed = simulator
                    .dispatch(BridgeEnvelope::request(
                        simulator.session_id(),
                        "push-new-instance",
                        op::PAGE_PUSH,
                        json!({"path":route}),
                    ))
                    .unwrap();
                assert!(!pushed
                    .messages
                    .iter()
                    .any(|message| message.payload["ok"] == false));
                assert!(!simulator.has_current_skia_scene());
                let next_page = simulator
                    .host()
                    .session()
                    .unwrap()
                    .app_service()
                    .pages()
                    .current()
                    .unwrap()
                    .id
                    .0;
                assert_ne!(next_page, first_page);
                let retained_snapshot =
                    simulator.host().render_snapshot_ref().ok().map(|snapshot| {
                        (
                            snapshot.frame_id,
                            snapshot.pixels.as_ptr(),
                            snapshot.pixels.len(),
                        )
                    });
                assert_eq!(retained_snapshot.is_some(), mode == PageRenderMode::Raster);
                let pending_page_trace = simulator.trace_summary().total_records;
                publish_simulator_report_with_runtime(
                    &handle,
                    Some(&simulator),
                    1,
                    &simulator.report("passed"),
                    "ready",
                );
                assert_eq!(handle.state()["currentPageId"], next_page.to_string());
                assert_eq!(simulator.trace_summary().total_records, pending_page_trace);
                assert_eq!(frame(&mut surface, mode), previous);
                let mut candidate = settings.clone();
                candidate.effective_scale = 2.0;
                candidate.generation += 1;
                candidate.revision += 1;
                let before_trace = simulator.trace_summary().total_records;
                let applied = apply_web_presentation_candidate(
                    &handle,
                    &mut simulator,
                    &candidate,
                    true,
                    |_, _, _| panic!("a pending page must not reserve CPU pixels"),
                )
                .unwrap();
                assert!(applied.messages.is_empty());
                assert_eq!(simulator.render_scale(), 2.0);
                assert_eq!(simulator.trace_summary().total_records, before_trace);
                assert_eq!(frame(&mut surface, mode), previous);
                // This is the immediate state publication after a successful
                // candidate. It must not export old geometry under the newly
                // accepted config generation before the normal render pump.
                handle.set_presentation(serde_json::to_value(&candidate).unwrap());
                publish_simulator_report_with_runtime(
                    &handle,
                    Some(&simulator),
                    1,
                    &simulator.report("passed"),
                    "ready",
                );
                assert_eq!(handle.state()["currentPageId"], next_page.to_string());
                assert_eq!(handle.state()["route"], route);
                assert_eq!(frame(&mut surface, mode), previous);
                assert_eq!(simulator.trace_summary().total_records, before_trace);
                assert_eq!(
                    simulator.host().render_snapshot_ref().ok().map(|snapshot| {
                        (
                            snapshot.frame_id,
                            snapshot.pixels.as_ptr(),
                            snapshot.pixels.len(),
                        )
                    }),
                    retained_snapshot
                );
                let mut over_budget = candidate.clone();
                over_budget.logical_width = 4096;
                over_budget.effective_scale = 4.0;
                over_budget.render_scale = RenderScale::Fixed(4.0);
                assert!(apply_web_presentation_candidate(
                    &handle,
                    &mut simulator,
                    &over_budget,
                    true,
                    reserve_web_presentation,
                )
                .unwrap_err()
                .contains("ERR_PRESENTATION_BUDGET"));
                assert_eq!(simulator.render_scale(), 2.0);
                assert_eq!(simulator.viewport().width, 375.0);
                assert_eq!(simulator.trace_summary().total_records, before_trace);
                assert_eq!(frame(&mut surface, mode), previous);

                simulator.pump(0).unwrap();
                assert!(simulator.has_current_skia_scene());
                let document = simulator.host().view_document().unwrap().unwrap();
                assert_ne!(document.page_id, first_page);
                assert_eq!(document.page_id, next_page);
                assert_eq!(document.profile, profile);
                publish_simulator_report_with_runtime(
                    &handle,
                    Some(&simulator),
                    1,
                    &simulator.report("passed"),
                    "ready",
                );
                let current = frame(&mut surface, mode);
                assert_eq!(current.metadata["configGeneration"], candidate.generation);
                assert_eq!(current.metadata["width"], 750);
                assert_eq!(current.metadata["height"], 1334);
                assert_ne!(current.metadata["frameId"], previous.metadata["frameId"]);
                assert_eq!(
                    current.metadata["sourceFrameId"],
                    simulator
                        .host()
                        .session()
                        .unwrap()
                        .renderer()
                        .last_frame()
                        .unwrap()
                        .frame_id
                );

                candidate.generation += 1;
                candidate.revision += 1;
                candidate.effective_scale = 1.5;
                candidate.render_scale = RenderScale::Fixed(1.5);
                let before_trace = simulator.trace_summary().total_records;
                apply_web_presentation_candidate(
                    &handle,
                    &mut simulator,
                    &candidate,
                    true,
                    reserve_web_presentation,
                )
                .unwrap();
                assert_eq!(simulator.trace_summary().total_records, before_trace);
                let repainted = frame(&mut surface, mode);
                assert_eq!(repainted.metadata["configGeneration"], candidate.generation);
                assert_eq!(repainted.metadata["width"], 563);
                assert_eq!(repainted.metadata["height"], 1001);
                assert_eq!(handle.state()["currentPageId"], next_page.to_string());
                publish_simulator_report_with_runtime(
                    &handle,
                    None,
                    2,
                    &simulator.report("stopped"),
                    "stopped",
                );
                assert_eq!(handle.state().get("currentPageId"), Some(&Value::Null));
            }
        }
    }

    #[cfg(all(feature = "skia-raster", feature = "quickjs-native"))]
    #[test]
    fn web_reservation_rejection_precedes_runtime_mutation_and_the_next_request_succeeds() {
        use super::{apply_web_presentation_candidate, now_ns, reserve_web_presentation};
        use container_ir::{
            parse_wxml, AppInfo, CompilerInfo, ContainerManifestV1, Integrity, Route, RouteKind,
            Template,
        };
        use container_render_skia::Renderer;
        use container_simulator::presentation::PresentationSettings;
        use container_simulator::web::WebSurface;
        use container_simulator::{Simulator, SimulatorConfig};
        use sha2::{Digest, Sha256};
        use std::{env, fs, path::PathBuf};

        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).expect("remove owned presentation fixture");
            }
        }
        let fixture = Fixture(env::temp_dir().join(format!(
            "weapp-presentation-reservation-{}-{}",
            std::process::id(),
            now_ns()
        )));
        fs::create_dir_all(fixture.0.join("blobs/sha256")).unwrap();
        let template = parse_wxml("<view id=\"retained\">unchanged</view>")
            .unwrap()
            .canonical_json()
            .unwrap();
        let digest = format!("{:x}", Sha256::digest(&template));
        fs::write(fixture.0.join("blobs/sha256").join(&digest), template).unwrap();
        let route = "pages/index/index";
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "reservation-test".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            routes: vec![Route {
                id: format!("route:{route}"),
                path: route.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: "page.js".into(),
            }],
            templates: vec![Template {
                id: format!("template:{route}.wxml"),
                wxml_ast: format!("sha256:{digest}"),
                bindings: vec![],
                wxs_modules: Default::default(),
            }],
            integrity: Integrity {
                algorithm: "sha256".into(),
                root: String::new(),
            },
            ..Default::default()
        };
        manifest.refresh_integrity().unwrap();
        fs::write(
            fixture.0.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let mut simulator =
            Simulator::from_pack_dir(&fixture.0, SimulatorConfig::default()).unwrap();
        simulator.run().unwrap();
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let settings = PresentationSettings::default();
        handle.set_presentation(serde_json::to_value(&settings).unwrap());
        let before_snapshot = simulator.host().render_snapshot().unwrap();
        handle
            .publish_frame_with_revision(
                simulator.session_id(),
                settings.generation,
                settings.logical_width as f32,
                settings.logical_height as f32,
                &before_snapshot,
                simulator.host().render_revision(),
            )
            .unwrap();
        let before_trace = simulator.trace();
        let before_session = simulator.session_id().to_owned();
        let before_viewport = simulator.viewport();
        let before_tree = simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .unwrap()
            .clone();
        let before_settings = handle.presentation();
        let before_state = handle.state();
        let mut candidate = settings.clone();
        candidate.logical_width = 667;
        candidate.logical_height = 375;
        candidate.effective_scale = 2.0;
        candidate.generation += 1;
        candidate.revision += 1;

        // This is the coordinator used by apply_web_presentation, with the
        // fallible reservation boundary replaced rather than the runtime.
        for failure in [
            "response allocation",
            "source allocation",
            "cache ledger allocation",
            "cache budget",
            "sequence exhausted",
        ] {
            let error = apply_web_presentation_candidate(
                &handle,
                &mut simulator,
                &candidate,
                true,
                |_, _, _| Err(format!("injected {failure}")),
            )
            .unwrap_err();
            assert!(error.contains(failure));
            assert_eq!(simulator.trace(), before_trace);
            assert_eq!(simulator.session_id(), before_session);
            assert_eq!(simulator.viewport(), before_viewport);
            assert_eq!(simulator.render_scale(), 1.0);
            assert_eq!(simulator.host().render_snapshot().unwrap(), before_snapshot);
            assert_eq!(
                simulator.host().session().unwrap().renderer().last_frame(),
                Some(&before_tree)
            );
            assert_eq!(handle.presentation(), before_settings);
            assert_eq!(handle.state(), before_state);
        }

        // A renderer-contract violation rejects before either visual owner
        // accepts. Geometry restores without replaying the resize hook.
        let mismatch = apply_web_presentation_candidate(
            &handle,
            &mut simulator,
            &candidate,
            true,
            |handle, session, candidate| {
                handle.reserve_frame(session, candidate.generation, 1.0, 1.0, 1, 1)
            },
        );
        assert!(mismatch.unwrap_err().contains("reserved frame contract"));
        assert_eq!(simulator.viewport(), before_viewport);
        assert_eq!(simulator.render_scale(), 1.0);
        assert_eq!(simulator.host().render_snapshot().unwrap(), before_snapshot);
        assert_eq!(
            simulator.host().session().unwrap().renderer().last_frame(),
            Some(&before_tree)
        );
        assert_eq!(handle.presentation(), before_settings);

        apply_web_presentation_candidate(
            &handle,
            &mut simulator,
            &candidate,
            true,
            reserve_web_presentation,
        )
        .unwrap();
        assert_eq!(simulator.session_id(), before_session);
        assert_eq!(simulator.viewport().width, 667.0);
        assert_eq!(simulator.render_scale(), 2.0);
        assert_eq!(simulator.host().render_snapshot_ref().unwrap().width, 1334);
        // Settings and pixels are installed by the same prepared publication.
        assert_eq!(
            handle.presentation(),
            serde_json::to_value(&candidate).unwrap()
        );
    }

    #[test]
    fn forwarded_separators_do_not_rewrite_option_values() {
        let mut args = ["--", "--route", "--", "--", "--help"]
            .map(str::to_owned)
            .into_iter();
        assert_eq!(next_cli_option(&mut args).as_deref(), Some("--route"));
        assert_eq!(args.next().as_deref(), Some("--"));
        assert_eq!(next_cli_option(&mut args).as_deref(), Some("--help"));
        assert_eq!(next_cli_option(&mut args), None);
    }

    #[test]
    fn browser_opening_only_accepts_generated_listener_urls() {
        for url in [
            "http://127.0.0.1:5179/",
            "http://[::1]:5179/",
            "http://0.0.0.0:5179/",
        ] {
            let command = super::browser_open_command("windows", url).expect("listener URL");
            let arguments = command.get_args().collect::<Vec<_>>();
            assert_eq!(arguments, ["/D", "/C", "start", "", url]);
        }
        for url in [
            "https://127.0.0.1:5179/",
            "http://localhost:5179/",
            "http://127.0.0.1:5179/?x=&start calc",
            "http://127.0.0.1:5179/\" & start calc & \"",
            "http://127.0.0.1:5179/\n",
        ] {
            assert_eq!(
                super::browser_open_command("windows", url)
                    .expect_err("only the numeric listener URL is permitted")
                    .kind(),
                std::io::ErrorKind::InvalidInput
            );
        }
        assert_eq!(
            super::browser_open_command("unsupported", "http://127.0.0.1:5179/")
                .expect_err("unsupported platform")
                .kind(),
            std::io::ErrorKind::Unsupported
        );
    }

    #[test]
    fn missing_browser_launcher_is_reported_without_failing_the_caller() {
        let command = std::process::Command::new(
            std::env::temp_dir().join(format!("weapp-no-browser-launcher-{}", super::now_ns())),
        );
        let worker = super::spawn_browser_opener(command, "http://127.0.0.1:5179/".into())
            .expect("worker starts independently of the launcher");
        let error = worker
            .join()
            .expect("worker handles the launch failure")
            .expect_err("missing launcher must remain an observable error");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn browser_launcher_runs_off_thread_and_is_reaped_after_failure() {
        use nix::errno::Errno;
        use nix::sys::wait::{waitpid, WaitPidFlag};
        use nix::unistd::Pid;

        struct Fixture(std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                std::fs::remove_dir_all(&self.0).expect("remove owned opener fixture");
            }
        }
        let fixture = Fixture(std::env::temp_dir().join(format!(
            "weapp-browser-opener-{}-{}",
            std::process::id(),
            super::now_ns()
        )));
        std::fs::create_dir(&fixture.0).expect("create owned opener fixture");
        let pid_file = fixture.0.join("pid");
        let release_file = fixture.0.join("release");
        let mut command = std::process::Command::new("sh");
        command
            .args([
                "-c",
                "printf '%s' \"$$\" > \"$1\"; n=0; while [ ! -f \"$2\" ]; do n=$((n + 1)); if [ \"$n\" -ge 100 ]; then exit 9; fi; sleep 0.01; done; exit 7",
                "weapp-browser-opener-fixture",
            ])
            .arg(&pid_file)
            .arg(&release_file);
        let worker = super::spawn_browser_opener(command, "http://127.0.0.1:5179/".into())
            .expect("start background opener");
        // A synchronous opener would expire its bounded gate and exit 9
        // before this caller could release it. No actual browser is opened.
        std::fs::write(&release_file, b"release").expect("release fake launcher");
        let status = worker
            .join()
            .expect("worker returns")
            .expect("launcher ran");
        assert_eq!(status.code(), Some(7), "preserve the launcher's failure");
        let pid: i32 = std::fs::read_to_string(pid_file)
            .expect("fake launcher pid")
            .parse()
            .expect("numeric pid");
        assert_eq!(
            waitpid(Pid::from_raw(pid), Some(WaitPidFlag::WNOHANG)),
            Err(Errno::ECHILD),
            "the reaper must already have waited for the child"
        );
    }

    #[test]
    fn runtime_errors_are_projected_into_dev_diagnostics() {
        let batch = BridgeBatch::new(vec![
            BridgeEnvelope::request(
                "session-1",
                "api-1",
                op::API_RESULT,
                json!({
                    "ok": false,
                    "error": {
                        "code": "ERR_PERMISSION_DENIED",
                        "message": "location permission denied"
                    }
                }),
            ),
            BridgeEnvelope::request(
                "session-1",
                "api-2",
                op::API_RESULT,
                json!({"ok": true, "result": {"errMsg": "ok"}}),
            ),
        ]);

        assert_eq!(
            runtime_error_diagnostics(&batch),
            vec![(
                "ERR_PERMISSION_DENIED".to_owned(),
                "location permission denied".to_owned()
            )]
        );
    }

    #[test]
    fn runtime_diagnostic_falls_back_to_error_code_when_message_is_missing() {
        let batch = BridgeBatch::new(vec![BridgeEnvelope::request(
            "session-1",
            "api-1",
            op::API_RESULT,
            json!({"ok": false, "error": {"code": "ERR_ENGINE"}}),
        )]);

        assert_eq!(
            runtime_error_diagnostics(&batch),
            vec![("ERR_ENGINE".to_owned(), "ERR_ENGINE".to_owned())]
        );
    }

    #[test]
    fn asynchronous_engine_errors_share_the_dev_diagnostic_stream() {
        let batch = BridgeBatch::new(vec![BridgeEnvelope::event(
            "session-1",
            op::ERROR,
            json!({"source":"quickjs","errors":[
                {"name":"Error","message":"timer callback failed","stack":"at timer"},
                {"code":"ERR_UNSUPPORTED_CAPABILITY","errMsg":"wx.camera:fail unsupported"}
            ]}),
        )]);
        assert_eq!(
            runtime_error_diagnostics(&batch),
            vec![
                ("ERR_RUNTIME".to_owned(), "timer callback failed".to_owned()),
                (
                    "ERR_UNSUPPORTED_CAPABILITY".to_owned(),
                    "wx.camera:fail unsupported".to_owned()
                )
            ]
        );
    }

    #[cfg(feature = "desktop-window")]
    #[test]
    fn desktop_runtime_error_remains_visible_until_successful_generation() {
        let batch = BridgeBatch::new(vec![BridgeEnvelope::event(
            "desktop-session",
            op::ERROR,
            json!({"errors":[{"message":"timer callback failed"}]}),
        )]);
        let timer_failed = !runtime_error_diagnostics(&batch).is_empty();
        let after_timer = super::desktop_error_status(false, false, timer_failed);
        assert!(after_timer, "timer errors must mark the native title");
        assert!(
            super::desktop_error_status(after_timer, false, false),
            "an ordinary frame or build-start event cannot hide the error"
        );
        assert!(
            !super::desktop_error_status(after_timer, true, false),
            "a successful generation clears the old error"
        );
        assert!(
            super::desktop_error_status(after_timer, true, timer_failed),
            "an accepted generation with startup errors still displays error"
        );
    }

    #[cfg(feature = "desktop-window")]
    #[test]
    fn desktop_input_errors_reach_shared_web_diagnostics_and_window_status() {
        let surface = WebSurface::localhost(0).expect("bind shared surface");
        let handle = surface.handle();
        let batch = BridgeBatch::new(vec![
            BridgeEnvelope::request(
                "desktop-session",
                "pointer-1",
                op::EVENT_BATCH,
                json!({"ok":false,"error":{
                    "code":"ERR_ENGINE", "message":"pointer handler failed"
                }}),
            ),
            BridgeEnvelope::event(
                "desktop-session",
                op::ERROR,
                json!({"errors":[{"message":"component handler failed"}]}),
            ),
        ]);
        assert!(super::publish_desktop_batch(
            &Some(handle.clone()),
            7,
            batch
        ));
        let state = handle.state();
        let diagnostics = state["diagnostics"].as_array().expect("diagnostics");
        assert_eq!(diagnostics.len(), 2);
        assert_eq!(diagnostics[0]["revision"], 7);
        assert_eq!(diagnostics[0]["phase"], "runtime");
        assert_eq!(diagnostics[0]["code"], "ERR_ENGINE");
        assert_eq!(diagnostics[1]["message"], "component handler failed");
        assert!(!super::publish_desktop_batch(
            &Some(handle),
            7,
            BridgeBatch::new(Vec::new())
        ));
        assert!(super::publish_desktop_batch(
            &None,
            7,
            BridgeBatch::new(vec![BridgeEnvelope::event(
                "desktop-session",
                op::ERROR,
                json!({"errors":[{"message":"standalone desktop failed"}]}),
            )])
        ));
    }

    #[test]
    fn desktop_physical_input_uses_current_density_without_changing_wheel_units() {
        let physical = json!({"type":"tap","x":180,"y":240,"detail":{"x":180,"y":240},"button":0});
        for scale in [1.0, 1.5, 2.0, 3.0, 4.0] {
            let mut event = physical.clone();
            super::desktop_event_to_logical(&mut event, (scale, scale)).unwrap();
            assert_eq!(event["x"], 180.0 / scale);
            assert_eq!(event["y"], 240.0 / scale);
            assert_eq!(event["detail"]["x"], 180.0 / scale);
            assert_eq!(event["detail"]["y"], 240.0 / scale);
            assert_eq!(event["button"], 0);
        }
        // Both events use the same saved physical cursor after changing density.
        let mut before = physical.clone();
        let mut after = physical.clone();
        super::desktop_event_to_logical(&mut before, (1.0, 1.0)).unwrap();
        super::desktop_event_to_logical(&mut after, (2.0, 2.0)).unwrap();
        assert_eq!(before["x"], 180.0);
        assert_eq!(after["x"], 90.0);
        for mode in [0, 1, 2] {
            let mut wheel =
                json!({"type":"wheel","x":180,"y":240,"deltaX":-8,"deltaY":20,"deltaMode":mode});
            super::desktop_event_to_logical(&mut wheel, (2.0, 2.0)).unwrap();
            assert_eq!(wheel["x"], 90.0);
            assert_eq!(wheel["y"], 120.0);
            assert_eq!(wheel["deltaX"], if mode == 0 { -4.0 } else { -8.0 });
            assert_eq!(wheel["deltaY"], if mode == 0 { 10.0 } else { 20.0 });
            assert_eq!(wheel["deltaMode"], mode);
        }
        let mut keyboard = json!({"type":"keydown","key":"a","target":"root"});
        let original = keyboard.clone();
        super::desktop_event_to_logical(&mut keyboard, (2.0, 2.0)).unwrap();
        assert_eq!(keyboard, original);
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let mut event = physical.clone();
            assert!(super::desktop_event_to_logical(&mut event, (scale, scale)).is_err());
            assert_eq!(event, physical);
        }
    }

    #[test]
    fn engine_flag_is_explicit_and_does_not_fallback() {
        assert_eq!(parse_engine("quickjs").unwrap(), EngineKind::Quickjs);
        assert_eq!(parse_engine("quick-js").unwrap(), EngineKind::Quickjs);
        assert_eq!(parse_engine("v8").unwrap(), EngineKind::V8);
        let error = parse_engine("javascript").unwrap_err().to_string();
        assert!(error.contains("unknown engine javascript"));
    }

    #[cfg(feature = "desktop-window")]
    #[test]
    fn desktop_shutdown_is_flushed_to_shared_web_surface() {
        use std::io::{ErrorKind, Read, Write};
        use std::net::TcpStream;
        use std::thread;
        use std::time::{Duration, Instant};

        let mut web = Some(WebSurface::localhost(0).expect("bind web surface"));
        let address = web.as_ref().expect("web surface").local_addr();
        let mut client = TcpStream::connect(address).expect("connect SSE client");
        client
            .write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .expect("write SSE request");
        client
            .set_nonblocking(true)
            .expect("set SSE client nonblocking");

        // Accept the request before publishing the terminal event. A newly
        // accepted SSE client starts at the current event tail by design.
        let mut wire = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline && !wire.windows(4).any(|part| part == b"\r\n\r\n") {
            web.as_mut().expect("web surface").poll().expect("poll SSE");
            let mut chunk = [0_u8; 1024];
            match client.read(&mut chunk) {
                Ok(read) => wire.extend_from_slice(&chunk[..read]),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => panic!("SSE header read failed: {error}"),
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert!(wire.windows(4).any(|part| part == b"\r\n\r\n"));

        publish_desktop_shutdown(&mut web, "signal");
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline
            && !wire
                .windows(b"event: shutdown\n".len())
                .any(|part| part == b"event: shutdown\n")
        {
            web.as_mut()
                .expect("web surface")
                .poll()
                .expect("poll shutdown");
            let mut chunk = [0_u8; 1024];
            match client.read(&mut chunk) {
                Ok(read) => wire.extend_from_slice(&chunk[..read]),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => panic!("SSE shutdown read failed: {error}"),
            }
            thread::sleep(Duration::from_millis(2));
        }
        let text = String::from_utf8_lossy(&wire);
        assert!(
            text.contains("event: shutdown\n"),
            "missing shutdown event: {text}"
        );
        assert!(
            text.contains("\"reason\":\"signal\""),
            "missing shutdown reason: {text}"
        );
    }
}
