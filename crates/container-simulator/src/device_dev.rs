//! Native device development owns one build supervisor and no local runtime.
//! The HTTPS/WSS sidecar owns its sockets; only this owner supplies validated,
//! immutable compiler publications over an anonymous stdin pipe.
use container_simulator::dev::{DevConfig, DevEvent, DevPackConsumer, DevSupervisor};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{atomic::Ordering, mpsc};
use std::time::{Duration, Instant};

pub struct DeviceOptions {
    pub host: String,
    pub port: u16,
    pub admin_port: u16,
    pub advertise_host: Option<String>,
    pub open: bool,
}

struct DeviceService {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<String>,
    reader: Option<std::thread::JoinHandle<()>>,
}

impl DeviceService {
    fn spawn(
        config: &DevConfig,
        options: &DeviceOptions,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/device-dev-server.mjs");
        if !script.is_file() {
            return Err("ERR_DEV_TOOLS: device-dev-server.mjs is absent".into());
        }
        let mut command = Command::new(&config.node_bin);
        command
            .arg(script)
            .arg("--project")
            .arg(&config.project)
            .arg("--pack-root")
            .arg(&config.output_dir)
            .arg("--identity-root")
            .arg(config.project.join(".weapp-container/device-server"))
            .arg("--host")
            .arg(&options.host)
            .arg("--port")
            .arg(options.port.to_string())
            .arg("--admin-port")
            .arg(options.admin_port.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some(host) = &options.advertise_host {
            command.arg("--advertise-host").arg(host);
        }
        let mut child = command.spawn()?;
        let input = child.stdin.take();
        let stdout = child.stdout.take().ok_or("ERR_DEV_SERVER: missing pipe")?;
        let (sender, output) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) if line.len() <= 65536 => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        });
        Ok(Self {
            child,
            input,
            output,
            reader: Some(reader),
        })
    }
    fn send(&mut self, value: &Value) -> std::io::Result<()> {
        if let Some(input) = &mut self.input {
            serde_json::to_writer(&mut *input, value)?;
            input.write_all(b"\n")?;
            input.flush()
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "device server closed",
            ))
        }
    }
    fn stop(&mut self) {
        let _ = self.send(&json!({"type":"shutdown"}));
        self.input.take();
        let until = Instant::now() + Duration::from_secs(3);
        while Instant::now() < until {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
impl Drop for DeviceService {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn run(
    mut config: DevConfig,
    options: DeviceOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    config.pack_consumer = DevPackConsumer::ExternalDevice;
    // Bind before starting a watcher: port/tool failures cannot leak a build.
    std::fs::create_dir_all(&config.output_dir)?;
    let mut service = DeviceService::spawn(&config, &options)?;
    let shutdown = crate::install_shutdown_handler()?;
    let startup = Instant::now();
    loop {
        if shutdown.load(Ordering::Relaxed) {
            return Ok(());
        }
        if service.child.try_wait()?.is_some() {
            return Err("ERR_DEV_SERVER: device service exited before ready".into());
        }
        if startup.elapsed() > Duration::from_secs(15) {
            return Err("ERR_DEV_SERVER: device service startup timeout".into());
        }
        if let Ok(line) = service.output.recv_timeout(Duration::from_millis(50)) {
            let value: Value = serde_json::from_str(&line)?;
            if value["type"] == "ready" {
                if let Some(url) = value["dashboard"].as_str() {
                    eprintln!("weapp-simulator: device dashboard {url}");
                    if options.open {
                        crate::open_browser(url);
                    }
                }
                if let Some(uri) = value["pairing"]["uri"].as_str() {
                    eprintln!("weapp-simulator: one-use pairing (120s): {uri}");
                }
                break;
            }
        }
    }
    let (mut supervisor, _) = DevSupervisor::spawn(config)?;
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        while !shutdown.load(Ordering::Relaxed) {
            if service.child.try_wait()?.is_some() {
                return Err("ERR_DEV_SERVER: device service exited".into());
            }
            if let Some(event) = supervisor.poll()? {
                match event {
                    DevEvent::PortableReady { report, .. } => {
                        let check = supervisor.check_portable_publication(&report);
                        for event in check.events {
                            if let DevEvent::Diagnostic(diagnostic) = event {
                                service
                                    .send(&json!({"type":"diagnostic","diagnostic":diagnostic}))?;
                            }
                        }
                        if check.authorized {
                            service.send(&json!({"type":"publish","report":report}))?;
                        }
                    }
                    DevEvent::Diagnostic(diagnostic) => {
                        service.send(&json!({"type":"diagnostic","diagnostic":diagnostic}))?;
                    }
                    DevEvent::Exited(status) => {
                        if status.success() {
                            break;
                        }
                        return Err(format!("ERR_DEV_BUILD: watcher exited {status}").into());
                    }
                    _ => {}
                }
            }
            for _ in 0..16 {
                let Ok(line) = service.output.try_recv() else {
                    break;
                };
                let value: Value = serde_json::from_str(&line)?;
                match value["type"].as_str() {
                    Some("published") => eprintln!(
                        "weapp-simulator: device generation {} published",
                        value["revision"]
                    ),
                    Some("rejected") => eprintln!(
                        "weapp-simulator: device publication rejected: {}",
                        value["code"]
                    ),
                    _ => {}
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    })();
    // Close artifact readers before the supervisor removes its owned pack tree.
    service.stop();
    supervisor.shutdown();
    result
}
