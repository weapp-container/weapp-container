//! Native DevTools app shell.
//!
//! The launcher service remains implemented in Node so the GUI, CLI and
//! packaged distributions share the same project validation and lifecycle.
//! This binary owns the application window and embeds that service in the
//! platform WebView.

use std::env;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};

use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use wry::{NewWindowResponse, WebViewBuilder};

struct LauncherProcess {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
}

impl LauncherProcess {
    fn close(&mut self) {
        self.stdin.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
    }
}

impl Drop for LauncherProcess {
    fn drop(&mut self) {
        self.close();
    }
}

fn open_external_url(url: &str) {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return;
    }
    let (program, arguments): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(windows) {
        ("cmd", vec!["/C", "start", "", url])
    } else {
        ("xdg-open", vec![url])
    };
    let _ = Command::new(program).args(arguments).spawn();
}

fn distribution_root() -> Result<PathBuf, String> {
    let executable =
        env::current_exe().map_err(|error| format!("无法定位 DevTools 安装目录：{error}"))?;
    executable
        .ancestors()
        .find(|directory| directory.join("weapp-devtools.json").is_file())
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位 DevTools 安装目录".into())
}

fn node_path(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("node/node.exe")
    } else {
        root.join("node/bin/node")
    }
}

fn start_launcher(root: &Path) -> Result<(LauncherProcess, String), String> {
    let mut child = Command::new(node_path(root))
        .arg(root.join("scripts/devtools-launcher.mjs"))
        .arg("native")
        .current_dir(root)
        .env("WEAPP_DEVTOOLS_ROOT", root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("启动 DevTools 服务失败：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "DevTools 服务没有输出启动地址".to_owned())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "DevTools 服务关闭通道不可用".to_owned())?;
    let mut line = String::new();
    if let Err(error) = BufReader::new(stdout).read_line(&mut line) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("读取 DevTools 服务地址失败：{error}"));
    }
    if !line.starts_with("http://127.0.0.1:") {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("DevTools 服务地址无效：{}", line.trim()));
    }
    Ok((
        LauncherProcess {
            child: Some(child),
            stdin: Some(stdin),
        },
        line.trim().to_owned(),
    ))
}

fn run() -> Result<(), String> {
    let root = distribution_root()?;
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Weapp Container DevTools")
        .with_inner_size(tao::dpi::LogicalSize::new(900_u32, 720_u32))
        .build(&event_loop)
        .map_err(|error| format!("创建 DevTools 窗口失败：{error}"))?;

    #[cfg(target_os = "linux")]
    gtk::init().map_err(|error| format!("初始化 Linux WebView 失败：{error}"))?;

    let (mut launcher, page) = start_launcher(&root)?;
    let builder = WebViewBuilder::new()
        .with_url(&page)
        .with_devtools(cfg!(debug_assertions))
        .with_new_window_req_handler(|url, _| {
            open_external_url(&url);
            NewWindowResponse::Deny
        });

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let _webview = builder
        .build(&window)
        .map_err(|error| format!("创建 DevTools WebView 失败：{error}"))?;

    #[cfg(target_os = "linux")]
    let _webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder
            .build_gtk(
                window
                    .default_vbox()
                    .ok_or_else(|| "Linux WebView 容器不可用".to_owned())?,
            )
            .map_err(|error| format!("创建 DevTools WebView 失败：{error}"))?
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            launcher.close();
            *control_flow = ControlFlow::Exit;
        }
    });
}

fn main() {
    if env::args().any(|argument| argument == "--help" || argument == "-h") {
        println!("Weapp Container DevTools native app shell");
        return;
    }
    if let Err(error) = run() {
        eprintln!("weapp-devtools-native: {error}");
        std::process::exit(1);
    }
}
