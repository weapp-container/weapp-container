//! Trusted, opt-in browser development UI. No filesystem fallback, owner
//! construction, Worker execution or readiness acknowledgement lives here.

use super::*;
use crate::browser_dev_coordinator::PreviewLease;
use crate::web_control::{ControlHttpAuth, ControlHttpError};

// The surrounding executable HTML is fixed. Only the original auth context's
// escaped JSON can enter its inert script element.
const HTML_START: &str = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weapp Container · Browser 开发模拟器</title>
<link rel="stylesheet" href="/__weapp/dev/dev.css"></head><body>
<header><h1>Weapp Container</h1><span>Browser / QuickJS Worker</span><span id="dev-phase">idle</span></header>
<main><section id="dev-preview" aria-label="小程序预览"><div id="dev-surface"></div></section>
<aside><h2>运行状态</h2><pre id="dev-status">等待开发会话</pre>
<div class="actions"><button id="dev-refresh" type="button">检查更新</button>
<button id="dev-stop" type="button">停止会话</button>
<button id="dev-retry-surface" type="button" hidden>重试画面恢复</button>
<button id="dev-retry-cleanup" type="button" hidden>重试清理</button></div>
<p id="dev-cleanup">关闭页面前请先停止开发会话。</p>
<h2>诊断</h2><pre id="dev-diagnostics" aria-live="polite"></pre></aside></main>
<script id="weapp-dev-bootstrap" type="application/json">"#;
const HTML_END: &str = r#"</script>
<script type="module" src="/__weapp/dev/browser-dev-entry.mjs"></script></body></html>"#;
const POLICY_HEADERS: &[u8] = b"Content-Security-Policy: frame-ancestors 'none'; base-uri 'none'; object-src 'none'\r\nReferrer-Policy: no-referrer\r\n\r\n";

const ASSETS: &[(&str, &str, &[u8])] = &[
    (
        "/__weapp/dev/browser-dev-app.mjs",
        "text/javascript; charset=utf-8",
        include_bytes!("../../../examples/hosts/web-wasm/browser-dev-app.mjs"),
    ),
    (
        "/__weapp/dev/browser-dev-owner-manager.mjs",
        "text/javascript; charset=utf-8",
        include_bytes!("../../../examples/hosts/web-wasm/browser-dev-owner-manager.mjs"),
    ),
    (
        "/__weapp/dev/browser-dev-http-control.mjs",
        "text/javascript; charset=utf-8",
        include_bytes!("browser-dev-http-control.mjs"),
    ),
    (
        "/__weapp/dev/worker-session-client.mjs",
        "text/javascript; charset=utf-8",
        include_bytes!("../../../examples/hosts/web-wasm/worker-session-client.mjs"),
    ),
    (
        "/__weapp/dev/browser-dev-entry.mjs",
        "text/javascript; charset=utf-8",
        include_bytes!("../../../examples/hosts/web-wasm/browser-dev-entry.mjs"),
    ),
    (
        "/__weapp/dev/dev.css",
        "text/css; charset=utf-8",
        include_bytes!("../../../examples/hosts/web-wasm/browser-dev.css"),
    ),
];

// Deliberately no Debug or secret-bearing public accessors. The preencoded
// immutable bodies share the ordinary HTTP byte budget and die with surface.
pub(super) struct BrowserDevApp {
    responses: BTreeMap<&'static str, Arc<Vec<u8>>>,
}

impl BrowserDevApp {
    fn new(
        auth: &ControlHttpAuth,
        preview: &PreviewLease,
        retirement: bool,
    ) -> Result<Self, ControlHttpError> {
        let config = if retirement {
            auth.browser_dev_bootstrap_json_with_retirement(preview)?
        } else {
            auth.browser_dev_bootstrap_json(preview)?
        };
        let html = format!("{HTML_START}{config}{HTML_END}");
        let mut responses = BTreeMap::new();
        responses.insert("/", response("text/html; charset=utf-8", html.as_bytes()));
        for &(path, mime, bytes) in ASSETS {
            responses.insert(path, response(mime, bytes));
        }
        Ok(Self { responses })
    }

    pub(super) fn response(&self, target: &str) -> Option<Arc<Vec<u8>>> {
        self.responses.get(target).cloned()
    }
}

fn response(mime: &'static str, body: &[u8]) -> Arc<Vec<u8>> {
    let mut bytes = resources::response_header(200, mime, body.len());
    // Reuse the strict resource framing/security headers, inserting only the
    // UI-specific policy before the original final CRLF.
    bytes.truncate(bytes.len() - 2);
    bytes.extend_from_slice(POLICY_HEADERS);
    bytes.extend_from_slice(body);
    Arc::new(bytes)
}

/// Classification only, after the complete request line. The shared strict GET
/// parser still validates method, headers, body/pipeline and exact target. This
/// exception is used only while this surface's trusted UI opt-in is present.
pub(super) fn is_dev_namespace(wire: &[u8]) -> bool {
    let Some(end) = wire.iter().position(|byte| *byte == b'\n') else {
        return false;
    };
    wire[..end]
        .split(|byte| *byte == b' ')
        .nth(1)
        .is_some_and(|target| target.starts_with(b"/__weapp/dev/"))
}

impl WebSurface {
    /// Serve the fixed browser development UI on this original loopback-only
    /// resource surface, once, before any accept. Call `enable_control` first;
    /// the supplied lease must be the trusted owner's original preview. No
    /// request can choose bootstrap identity, credentials, files or runtime.
    /// This API only serves UI bytes; it neither constructs nor starts Worker.
    pub fn enable_browser_dev_app(
        &mut self,
        preview: &PreviewLease,
    ) -> Result<(), ControlHttpError> {
        self.enable_browser_dev_app_internal(preview, false)
    }

    /// Explicit trusted opt-in; the caller must enable retirement on the same
    /// original owner before serving this capability-bearing bootstrap.
    pub fn enable_browser_dev_app_with_retirement(
        &mut self,
        preview: &PreviewLease,
    ) -> Result<(), ControlHttpError> {
        self.enable_browser_dev_app_internal(preview, true)
    }

    fn enable_browser_dev_app_internal(
        &mut self,
        preview: &PreviewLease,
        retirement: bool,
    ) -> Result<(), ControlHttpError> {
        if !self.resource_only
            || !self.addr.ip().is_loopback()
            || !self.accepting
            || self.has_accepted
            || self.browser_dev_app.is_some()
            || !self.pending_requests.is_empty()
            || !self.pending_resource_requests.is_empty()
            || !self.pending_control_requests.is_empty()
            || !self.pending_responses.is_empty()
            || !self.clients.is_empty()
        {
            return Err(ControlHttpError::InvalidContext);
        }
        let auth = self
            .control_auth
            .as_ref()
            .filter(|auth| auth.matches_local_http(self.addr))
            .ok_or(ControlHttpError::InvalidContext)?;
        let app = BrowserDevApp::new(auth, preview, retirement)?;
        let mut shared = self
            .shared
            .lock()
            .map_err(|_| ControlHttpError::Unavailable)?;
        let bytes = app.responses.values().map(|bytes| bytes.len()).sum();
        shared
            .ensure_frame_capacity(0, 0, bytes)
            .map_err(|_| ControlHttpError::Unavailable)?;
        for bytes in app.responses.values() {
            shared.track_response(bytes);
        }
        drop(shared);
        self.browser_dev_app = Some(app);
        Ok(())
    }
}

#[cfg(test)]
#[path = "web_dev_app_tests.rs"]
mod tests;
