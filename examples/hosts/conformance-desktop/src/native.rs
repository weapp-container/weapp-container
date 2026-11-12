//! Native window ownership and IPC. Nothing in this module opens a browser.
use crate::observation::Query;
use crate::pack::{Pack, Result};
#[cfg(target_os = "linux")]
use crate::presenter::SoftwareWindowPresenter as NativePresenter;
use crate::profile::PresenterProfile;
use crate::session::NativeSession;
use container_core::EngineKind;
#[cfg(target_os = "macos")]
use container_host_desktop::MetalWindowPresenter as NativePresenter;
use serde_json::{Value, json};
#[cfg(not(feature = "conformance-observation"))]
use std::io::Write;
use std::io::{self, BufRead};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use winit::event::{Event, WindowEvent};
use winit::event_loop::{ControlFlow, EventLoop};

enum Input {
    Request(Value),
    Invalid(String),
    Eof,
}

#[cfg(feature = "conformance-observation")]
type Output = crate::method_output::Output;
#[cfg(not(feature = "conformance-observation"))]
struct Output;
#[cfg(not(feature = "conformance-observation"))]
impl Output {
    fn stdout() -> std::result::Result<Self, String> {
        Ok(Self)
    }
    fn failure(&self) -> Option<String> {
        None
    }
    fn finish(&mut self) -> std::result::Result<(), String> {
        Ok(())
    }
    fn is_idle(&self) -> bool {
        true
    }
}
fn emit(output: &mut Output, value: Value) -> Result<()> {
    #[cfg(feature = "conformance-observation")]
    {
        output
            .enqueue(&value, Instant::now() + Duration::from_secs(5))
            .map(|_| ())
            .map_err(Into::into)
    }
    #[cfg(not(feature = "conformance-observation"))]
    {
        let _ = output;
        let mut output = io::stdout().lock();
        serde_json::to_writer(&mut output, &value)?;
        output.write_all(b"\n")?;
        output.flush()?;
        Ok(())
    }
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("IPC requires nonempty {field}").into())
}

struct Options {
    pack: PathBuf,
    profile: PresenterProfile,
    engine: EngineKind,
    session: String,
    width: u32,
    height: u32,
    timeout: Duration,
}

fn release(
    native: &mut NativeSession,
    presenter: &mut NativePresenter,
    detached: &mut bool,
    unloaded: &mut bool,
) -> Option<String> {
    if *unloaded {
        return None;
    }
    let error = match presenter.detach_session(&mut native.host) {
        Ok(()) => {
            *detached = true;
            None
        }
        Err(error) => {
            #[cfg(target_os = "macos")]
            {
                Some(format!("Metal detach failed: {error}"))
            }
            #[cfg(target_os = "linux")]
            {
                Some(format!("software presenter retirement failed: {error}"))
            }
        }
    };
    native.host.unload();
    *unloaded = !native.host.has_session();
    error
}

impl Options {
    fn parse() -> Result<Self> {
        let mut values = std::collections::BTreeMap::new();
        let mut args = std::env::args().skip(1);
        while let Some(key) = args.next() {
            if ![
                "--pack",
                "--presenter",
                "--engine",
                "--session",
                "--width",
                "--height",
                "--timeout-ms",
            ]
            .contains(&key.as_str())
            {
                return Err(format!("unknown option: {key}").into());
            }
            let value = args
                .next()
                .filter(|value| !value.starts_with("--"))
                .ok_or("option needs one value")?;
            if values.insert(key, value).is_some() {
                return Err("duplicate native host option".into());
            }
        }
        let required = |key: &str| {
            values
                .get(key)
                .cloned()
                .ok_or_else(|| format!("missing {key}"))
        };
        let engine = match required("--engine")?.as_str() {
            "quickjs" => EngineKind::Quickjs,
            "v8" => EngineKind::V8,
            _ => return Err("engine must be quickjs or v8".into()),
        };
        let width = values
            .get("--width")
            .map(String::as_str)
            .unwrap_or("375")
            .parse()?;
        let height = values
            .get("--height")
            .map(String::as_str)
            .unwrap_or("667")
            .parse()?;
        let timeout_ms: u64 = values
            .get("--timeout-ms")
            .map(String::as_str)
            .unwrap_or("120000")
            .parse()?;
        if !(1000..=600000).contains(&timeout_ms) {
            return Err("native host timeout must be 1–600 seconds".into());
        }
        let profile = PresenterProfile::select(
            std::env::consts::OS,
            values.get("--presenter").map(String::as_str),
        )?;
        Ok(Self {
            profile,
            pack: PathBuf::from(required("--pack")?),
            engine,
            session: required("--session")?,
            width,
            height,
            timeout: Duration::from_millis(timeout_ms),
        })
    }
}

#[allow(deprecated)]
pub fn run() -> Result<()> {
    let options = Options::parse()?;
    let mut output = Output::stdout()?;
    let pack = Pack::read(&options.pack)?;
    let event_loop = EventLoop::new()?;
    let mut presenter = NativePresenter::new(
        &event_loop,
        format!(
            "Weapp conformance · {} · {:?}",
            options.session, options.engine
        ),
        options.width,
        options.height,
    )?;
    #[cfg(target_os = "macos")]
    let _ = presenter
        .window()
        .request_inner_size(winit::dpi::LogicalSize::new(options.width, options.height));
    #[cfg(target_os = "linux")]
    let _ = presenter
        .window()
        .request_inner_size(winit::dpi::PhysicalSize::new(options.width, options.height));
    let target_id = format!(
        "{}:{}:{:?}",
        options.profile.host(),
        std::process::id(),
        presenter.window_id()
    );
    let target = json!({"host":options.profile.host(),"kind":"native-window","id":target_id,"pid":std::process::id(),
        "windowId":format!("{:?}",presenter.window_id())});
    let mut native = NativeSession::new_with_profile(
        pack,
        options.engine,
        options.session,
        options.width,
        options.height,
        options.profile,
    )?;
    presenter.attach_session(&mut native.host)?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&shutdown);
    ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let input = match line {
                Ok(line) if line.len() <= 1024 * 1024 => match serde_json::from_str(&line) {
                    Ok(value) => Input::Request(value),
                    Err(error) => Input::Invalid(error.to_string()),
                },
                Ok(_) => Input::Invalid("IPC request exceeded 1 MiB".into()),
                Err(error) => Input::Invalid(error.to_string()),
            };
            if sender.send(input).is_err() {
                return;
            }
        }
        let _ = sender.send(Input::Eof);
    });

    let started = Instant::now();
    let mut ready = false;
    let mut presented = 0;
    let mut pending: Option<(Value, Value)> = None;
    #[cfg(feature = "conformance-observation")]
    let mut ipc_owners = std::collections::BTreeSet::new();
    let mut close_id = None;
    let mut failure: Option<String> = None;
    let mut detached = false;
    let mut unloaded = false;
    let mut reason = "event-loop-returned";
    // Keep the real owner outside the callback, so run errors still cross the
    // detach/unload/drop barrier before a terminal cleanup response is emitted.
    let run_result = event_loop.run(|event,event_target| {
        event_target.set_control_flow(ControlFlow::WaitUntil(Instant::now()+Duration::from_millis(2)));
        match event {
            Event::WindowEvent {window_id,event:WindowEvent::CloseRequested} if window_id == presenter.window_id() => {
                reason = "window-close"; event_target.exit();
            }
            Event::WindowEvent {window_id,event:WindowEvent::Resized(size)} if window_id == presenter.window_id() => {
                #[cfg(target_os="macos")]
                presenter.resize(size);
                #[cfg(target_os="linux")]
                if let Err(error)=presenter.resize(size,&mut native.host) { failure=Some(error.to_string());event_target.exit(); }
                presented = 0;
            }
            Event::AboutToWait => {
                if shutdown.load(Ordering::SeqCst) || started.elapsed() >= options.timeout {
                    reason = if shutdown.load(Ordering::SeqCst) { "signal" } else { "timeout" };
                    failure.get_or_insert_with(|| format!("native host stopped: {reason}"));
                    event_target.exit(); return;
                }
                let step = (|| -> Result<()> {
                    let now_ns = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos().min(u64::MAX as u128) as u64;
                    #[cfg(feature = "conformance-observation")]
                    {
                        let mut output_error = None;
                        // Retire every completion already removed from the
                        // writer queue before exiting on the first failure.
                        for report in output.poll() {
                            if let Err(error) = native.complete_method_output(&report) {
                                output_error.get_or_insert_with(|| error.to_string());
                            }
                            if let Err(error) = report.result { output_error.get_or_insert(error); }
                        }
                        if let Some(error) = output_error { return Err(error.into()); }
                    }
                    if let Some(error) = output.failure() { return Err(error.into()); }
                    native.pump(now_ns)?;
                    // A pending guest Promise is independent from the existing
                    // reLaunch/tap presentation slot. Keep polling its actual
                    // opaque invocation while the renderer/event loop advances.
                    #[cfg(feature = "conformance-observation")]
                    if let Some(response) = native.poll_method()? { emit(&mut output,response)?; }
                    let revision = native.host.render_revision();
                    if !native.exception_closed() && revision > 0 && revision != presented {
                        #[cfg(target_os="macos")]
                        {
                            presenter.present_session(&mut native.host)?;
                            native.acknowledge(revision)?;
                        }
                        #[cfg(target_os="linux")]
                        {
                            let submission=presenter.present_session(&mut native.host)?;
                            native.acknowledge_software(&mut presenter,submission)?;
                        }
                        presented = revision;
                    }
                    if !native.exception_closed() && !native.stable() { return Ok(()); }
                    if !ready {
                        let startup = native.startup(&target,presenter.has_native_surface(),presenter.has_gpu_surface())?;
                        emit(&mut output,json!({"kind":"ready","startup":startup}))?;
                        ready = true;
                    }
                    if let Some((id,mut result)) = pending.take() {
                        result["completion"] = native.completion()?;
                        emit(&mut output,json!({"id":id,"ok":true,"result":result}))?;
                        // A subsequent request must cross another owner pump,
                        // even when the caller queued it before this response.
                        return Ok(());
                    }
                    // Keep pumping/presenting while output is backpressured.
                    // Subsequent source operations wait until all authorized
                    // frames complete; queued operations before enqueue retain
                    // the original route-revocation ordering below.
                    if !output.is_idle() { return Ok(()); }
                    match receiver.try_recv() {
                        Ok(Input::Request(request)) => {
                            let id = request.get("id").filter(|id| id.is_string() || id.is_u64()).cloned().ok_or("IPC request needs id")?;
                            #[cfg(feature = "conformance-observation")]
                            {
                                let identity = id.as_u64().map(crate::method_delivery::RequestId::Number)
                                    .unwrap_or_else(|| crate::method_delivery::RequestId::Text(id.as_str().unwrap().into()));
                                if ipc_owners.len() >= 4096 || !ipc_owners.insert(identity) {
                                    // A reused id cannot receive another
                                    // response, even an error response. Exit
                                    // through the owned cleanup barrier.
                                    return Err("IPC owner reused or ledger exhausted".into());
                                }
                            }
                            let operation = string(&request,"op")?;
                            let action = (|| -> Result<Value> {
                                if native.exception_closed() && !matches!(operation, "inspect" | "close") { return Err("source close retired native Session".into()); }
                                if matches!(operation,"tap"|"query"|"query.text"|"query.attribute"|"checkpoint") && request.get("route").is_some() {
                                    native.assert_route(string(&request,"route")?)?;
                                }
                                match operation {
                                #[cfg(feature = "conformance-exception-channel")]
                                "exceptions.begin" => native.begin_exceptions(&request),
                                #[cfg(feature = "conformance-exception-channel")]
                                "exceptions.end" => native.end_exceptions(&request),
                                "reLaunch" => native.relaunch(string(&request,"route")?),
                                #[cfg(feature = "conformance-observation")]
                                "method.call" => { native.begin_method(&request)?; Ok(Value::Null) },
                                #[cfg(feature = "conformance-observation")]
                                "data.read" => native.read_data(&request),
                                #[cfg(feature = "conformance-observation")]
                                "runtime.logs" => native.runtime_logs(&request),
                                #[cfg(feature = "conformance-observation")]
                                "runtime.logs.close" => native.close_runtime_logs(&request),
                                "tap" => native.tap(&Query::parse_request(&request)?),
                                "query" => native.query(&Query::parse_request(&request)?,false),
                                "query.text" => native.query(&Query::parse_request(&request)?,true),
                                "query.attribute" => native.query_attribute(&Query::parse_request(&request)?,string(&request,"name")?),
                                #[cfg(feature = "accepted-frame-observation")]
                                "accepted-frame.capabilities.v1" => native.accepted_frame_capabilities(&request),
                                #[cfg(feature = "accepted-frame-observation")]
                                "accepted-frame.observe.v1" => native.accepted_frame_observe(&request),
                                #[cfg(feature = "accepted-frame-node-input")]
                                "accepted-frame.nodes.capabilities.v1" => native.node_capabilities(&request),
                                #[cfg(feature = "accepted-frame-node-input")]
                                "accepted-frame.nodes.acquire.v1" => native.acquire_nodes(&request),
                                #[cfg(feature = "accepted-frame-node-input")]
                                "accepted-frame.nodes.tap.v1" => native.tap_node(&request),
                                "currentPage" => native.current_page(),
                                "render.settle" => native.completion(),
                                "checkpoint" => {
                                    let selectors = request.get("selectors").and_then(Value::as_array).ok_or("checkpoint needs selectors")?
                                        .iter().map(Query::parse).collect::<Result<Vec<_>>>()?;
                                    native.checkpoint(string(&request,"checkpoint")?,&selectors)
                                }
                                "inspect" => Ok(json!({"target":target,"route":native.inspection_route()?,"transcript":native.transcript()})),
                                "close" => Ok(Value::Null),
                                _ => Err(format!("unknown IPC operation: {operation}").into())
                            } })();
                            match action {
                                Ok(_) if operation == "close" => {close_id=Some(id);reason="requested";event_target.exit();},
                                Ok(result) if matches!(operation,"reLaunch"|"tap"|"accepted-frame.nodes.tap.v1") => pending=Some((id,result)),
                                Ok(_) if operation == "method.call" && cfg!(feature = "conformance-observation") => {},
                                Ok(result) => emit(&mut output,json!({"id":id,"ok":true,"result":result}))?,
                                Err(error) => emit(&mut output,json!({"id":id,"ok":false,"error":error.to_string()}))?,
                            }
                        }
                        Ok(Input::Invalid(error)) => return Err(format!("invalid native IPC: {error}").into()),
                        Ok(Input::Eof) | Err(mpsc::TryRecvError::Disconnected) => {reason="stdin-eof";event_target.exit();},
                        Err(mpsc::TryRecvError::Empty) => {},
                    }
                    // Process already queued source operations before final
                    // delivery. Route/input changes can revoke a consumed
                    // terminal during its mandatory next owner pump.
                    #[cfg(feature = "conformance-observation")]
                    if close_id.is_none() && native.stable() {
                        native.emit_method(|value, deadline| output.enqueue(&value, deadline))?;
                    }
                    Ok(())
                })();
                if let Err(error) = step { failure=Some(error.to_string());event_target.exit(); }
            }
            Event::LoopExiting => {
                if let Some(error) = release(&mut native,&mut presenter,&mut detached,&mut unloaded) {failure.get_or_insert(error);}
            },
            _ => {}
        }
    });
    if let Some(error) = release(&mut native, &mut presenter, &mut detached, &mut unloaded) {
        failure.get_or_insert(error);
    }
    if let Err(error) = run_result {
        failure.get_or_insert_with(|| error.to_string());
    }
    drop(presenter);
    let released = detached && unloaded;
    let mut result = json!({"ownedResourcesReleased":released,"borrowedResourcesPreserved":true,
        "metalContextDetached":detached,"sessionUnloaded":unloaded,"eventLoopReturned":true,"windowOwnerDropped":true,"reason":reason});
    if options.profile == PresenterProfile::LinuxSoftware {
        result
            .as_object_mut()
            .unwrap()
            .remove("metalContextDetached");
        result["softwarePresenterRetired"] = json!(detached);
        result["presenterProfile"] = json!(options.profile.name());
    }
    // Resource ownership ends before any terminal stdout drain. This can
    // wait only after the UI loop has returned and its native window dropped.
    #[cfg(feature = "conformance-observation")]
    for report in output.drain() {
        if let Err(error) = native.complete_method_output(&report) {
            failure.get_or_insert_with(|| error.to_string());
        }
        if let Err(error) = report.result {
            failure.get_or_insert(error);
        }
    }
    if output.failure().is_none() {
        emit(
            &mut output,
            json!({"kind":"cleanup","target":target,"cleanup":result,"error":failure}),
        )?;
        if let Some(id) = close_id {
            emit(
                &mut output,
                json!({"id":id,"ok":failure.is_none() && released,"result":result}),
            )?;
        }
        #[cfg(feature = "conformance-observation")]
        for report in output.drain() {
            if let Err(error) = report.result {
                failure.get_or_insert(error);
            }
        }
    }
    // Sticky failures have no stdout recovery path. main reports an error to
    // stderr; the harness independently persists native returncode/resources.
    if let Err(error) = output.finish() {
        failure.get_or_insert(error);
    }
    if let Some(error) = failure {
        return Err(error.into());
    }
    if !released {
        return Err("native host resource cleanup incomplete".into());
    }
    Ok(())
}
