//! Run the shared managed Browser development loop with independently pinned inputs.
use container_simulator::browser_dev_runner::{
    run_browser_dev, BrowserDevReportLocation, BrowserDevRunConfig,
};
use std::ffi::OsString;
use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const USAGE: &str = "serve_browser_dev --project PATH --producer-dir PATH --pins FILE [--node-bin PATH] [--out-dir PATH] [--port U16] [--duration-seconds 1..86400]";

struct Options {
    project: PathBuf,
    producer: PathBuf,
    pins: PathBuf,
    node: PathBuf,
    output: PathBuf,
    port: u16,
    duration: Option<Duration>,
}

impl Options {
    fn parse() -> Result<Option<Self>> {
        let mut values = std::collections::BTreeMap::new();
        let mut args = std::env::args_os().skip(1);
        while let Some(flag) = args.next() {
            if flag == "--help" || flag == "-h" {
                println!("{USAGE}");
                return Ok(None);
            }
            let key = flag.to_str().ok_or("option must be UTF-8")?;
            if ![
                "--project",
                "--producer-dir",
                "--pins",
                "--node-bin",
                "--out-dir",
                "--port",
                "--duration-seconds",
            ]
            .contains(&key)
            {
                return Err(format!("unknown option {key}; usage: {USAGE}").into());
            }
            let value = args.next().ok_or_else(|| format!("{key} needs a value"))?;
            if values.insert(key.to_owned(), value).is_some() {
                return Err(format!("duplicate option {key}").into());
            }
        }
        let required = |key| -> Result<PathBuf> {
            values
                .get(key)
                .map(PathBuf::from)
                .ok_or_else(|| format!("missing {key}; usage: {USAGE}").into())
        };
        let project = fs::canonicalize(required("--project")?)?;
        let producer = fs::canonicalize(required("--producer-dir")?)?;
        let pins = fs::canonicalize(required("--pins")?)?;
        let number = |key: &str| -> Result<Option<u64>> {
            values
                .get(key)
                .map(|value| {
                    value
                        .to_str()
                        .ok_or_else(|| format!("{key} must be UTF-8"))?
                        .parse::<u64>()
                        .map_err(|_| format!("invalid {key}").into())
                })
                .transpose()
        };
        let port = u16::try_from(number("--port")?.unwrap_or(0))?;
        let duration = number("--duration-seconds")?
            .map(|seconds| {
                if !(1..=86_400).contains(&seconds) {
                    Err("duration must be 1..86400 seconds")
                } else {
                    Ok(Duration::from_secs(seconds))
                }
            })
            .transpose()?;
        let output = values
            .get("--out-dir")
            .map(PathBuf::from)
            .unwrap_or_else(|| project.join(".weapp-container/browser-dev"));
        let output = std::env::current_dir()?.join(output);
        let node = PathBuf::from(
            values
                .get("--node-bin")
                .cloned()
                .unwrap_or_else(|| OsString::from("node")),
        );
        Ok(Some(Self {
            project,
            producer,
            pins,
            node,
            output,
            port,
            duration,
        }))
    }
}

fn main() -> Result<()> {
    let Some(options) = Options::parse()? else {
        return Ok(());
    };
    // Signals are installed before the shared runner creates any resource.
    let shutdown = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&shutdown);
    ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))?;
    run_browser_dev(
        BrowserDevRunConfig {
            project: options.project,
            producer_directory: options.producer,
            pins_file: options.pins,
            node_bin: options.node,
            output_dir: options.output,
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: options.port,
            startup_intent: br#"{"schemaVersion":1,"execution":"worker","engine":"quickjs","viewport":{"width":375,"height":667},"rendererPolicy":{"mode":"force","profile":"webview"}}"#.to_vec(),
            duration: options.duration,
            report_location: BrowserDevReportLocation::FreshOutput,
        },
        shutdown,
        |_| {},
    )
}
