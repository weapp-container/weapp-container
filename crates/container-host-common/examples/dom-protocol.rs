//! Verification-only portable-pack host for the transactional DOM presenter.
//!
//! Build with `--features container-runtime/quickjs-native` (or `v8-native`).
//! The first stdout line is bootstrap metadata; subsequent lines are complete
//! BridgeBatch values in response to stdin BridgeEnvelope lines. HostSession
//! stays on this thread. Application resources use a separate binary channel
//! in the companion browser smoke, never a fabricated ViewDocument.

use container_bridge::{op, BridgeBatch, BridgeEnvelope, EnvelopeKind};
use container_core::EngineKind;
use container_host_common::HostSession;
use container_ir::{ContainerManifestV1, RendererProfile};
use container_runtime::{BrowserLiveViewSubmission, BrowserViewSubmission, SessionConfig};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn declared_blobs(manifest: &ContainerManifestV1) -> BTreeSet<String> {
    let mut hashes = BTreeSet::new();
    if let Some(modern) = &manifest.modern_view {
        hashes.extend(modern.blob_hashes().map(|hash| format!("sha256:{hash}")));
    }
    if let Some(compiled) = &manifest.view_compilation {
        for module in &compiled.modules {
            hashes.insert(format!("sha256:{}", module.source_sha256));
            hashes.insert(format!("sha256:{}", module.executable_sha256));
        }
        for document in &compiled.documents {
            hashes.insert(document.wxml_ast.clone());
            hashes.extend(
                document
                    .expressions
                    .iter()
                    .map(|expression| format!("sha256:{}", expression.executable_sha256)),
            );
        }
    }
    hashes.extend(manifest.templates.iter().map(|item| item.wxml_ast.clone()));
    hashes.extend(manifest.styles.iter().map(|item| item.wxss_ir.clone()));
    hashes.extend(
        manifest
            .modules
            .iter()
            .map(|item| format!("sha256:{}", item.sha256)),
    );
    hashes.extend(
        manifest
            .view_scripts
            .iter()
            .map(|item| format!("sha256:{}", item.sha256)),
    );
    hashes.extend(
        manifest
            .assets
            .iter()
            .map(|item| format!("sha256:{}", item.sha256)),
    );
    hashes
}

fn load_blobs(root: &Path, manifest: &ContainerManifestV1) -> Result<BTreeMap<String, Vec<u8>>> {
    let mut blobs = BTreeMap::new();
    for entry in fs::read_dir(root.join("blobs/sha256"))? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "non-UTF-8 blob name")?;
        if !entry.file_type()?.is_file() || !container_ir::is_sha256(&name) {
            return Err(format!("ERR_INVALID_MANIFEST: unexpected blob entry {name:?}").into());
        }
        let bytes = fs::read(entry.path())?;
        if container_ir::hex_digest(&bytes) != name {
            return Err(format!("ERR_INVALID_MANIFEST: blob SHA-256 mismatch: {name}").into());
        }
        blobs.insert(format!("sha256:{name}"), bytes);
    }
    for pointer in declared_blobs(manifest) {
        if !blobs.contains_key(&pointer) {
            return Err(format!("ERR_INVALID_MANIFEST: missing blob {pointer}").into());
        }
    }
    Ok(blobs)
}

fn observation(host: &HostSession) -> Result<Value> {
    let session = host.session().ok_or("session unloaded")?;
    Ok(json!({
        "page": session.app_service().pages().current(),
        "browserPresented": session.is_browser_view_presented(),
        "viewRevision": session.view().revision.to_string(),
        "templateRevision": session.view().template_revision.to_string(),
        "skiaFramePresent": session.accepted_page_observation().map(|observation| observation.frame).is_some(),
        "skiaSnapshotRevision": session.render_revision().to_string(),
        "liveTransactionRetention": session.browser_live_transaction_retention(),
    }))
}

fn successful_payload(mut payload: &Value) -> Option<&Value> {
    loop {
        if payload["ok"] == true {
            return Some(payload);
        }
        // Retaining an exact final can fail after the operation has taken
        // effect. Keep the original runtime result authoritative in that case.
        payload = payload.get("originalResult")?;
    }
}

fn dispatch(host: &mut HostSession, envelope: BridgeEnvelope) -> Result<BridgeBatch> {
    let request_id = envelope.request_id.clone();
    let session_id = host
        .session()
        .ok_or("session unloaded")?
        .config()
        .session_id
        .clone();
    let mut batch = host.dispatch(envelope)?;
    // Resource authority originates in the evaluated runtime submission. The
    // companion host may expose only these SHA-256 values, and checks bytes
    // again before serving. Executable/style hashes never grant access.
    let mut authorizations = Vec::new();
    for message in &batch.messages {
        if message.kind == EnvelopeKind::Response
            && matches!(
                message.op.as_str(),
                op::VIEW_PREPARE | op::VIEW_LIVE_PREPARE
            )
        {
            let Some(payload) = successful_payload(&message.payload) else {
                continue;
            };
            let (key, resources) = if message.op == op::VIEW_LIVE_PREPARE {
                let submission: BrowserLiveViewSubmission =
                    serde_json::from_value(payload["submission"].clone())?;
                (submission.key, submission.document.resources)
            } else {
                let submission: BrowserViewSubmission =
                    serde_json::from_value(payload["submission"].clone())?;
                (submission.key, submission.document.resources)
            };
            for resource in &resources {
                let hash = &resource.sha256;
                let bytes = host.browser_view_resource(&key, hash)?;
                if container_ir::hex_digest(bytes) != *hash || resource.size != bytes.len() as u64 {
                    return Err("ERR_INVALID_MANIFEST: runtime resource verification failed".into());
                }
            }
            authorizations.push(json!({"key": key, "resources": resources}));
        }
    }
    for authorization in authorizations {
        batch.messages.push(BridgeEnvelope::event(
            &session_id,
            "host.resources.authorized",
            authorization,
        ));
    }
    batch.messages.push(BridgeEnvelope::event(
        &session_id,
        "host.dom.observation",
        json!({"afterRequestId": request_id, "state": observation(host)?}),
    ));
    Ok(batch)
}

fn require_success(batch: &BridgeBatch, operation: &str) -> Result<()> {
    for message in &batch.messages {
        if message.payload.get("ok") == Some(&Value::Bool(false)) || message.op == op::ERROR {
            return Err(format!("{operation}: {}", message.payload).into());
        }
    }
    if !batch.messages.iter().any(|message| {
        message.kind == EnvelopeKind::Response
            && message.op == operation
            && message.payload["ok"] == true
    }) {
        return Err(format!("{operation}: missing successful runtime response").into());
    }
    Ok(())
}

fn emit(output: &mut impl Write, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *output, value)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut pack: Option<PathBuf> = None;
    let mut engine = EngineKind::Quickjs;
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or("usage: dom-protocol --pack <dir> --engine quickjs|v8")?;
        match flag.as_str() {
            "--pack" => pack = Some(value.into()),
            "--engine" => {
                engine = match value.as_str() {
                    "quickjs" => EngineKind::Quickjs,
                    "v8" => EngineKind::V8,
                    _ => return Err("ERR_ENGINE: expected quickjs or v8".into()),
                };
            }
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    let pack = pack.ok_or("usage: dom-protocol --pack <dir> --engine quickjs|v8")?;
    let bytes = fs::read(pack.join("manifest.json"))?;
    let manifest: ContainerManifestV1 = serde_json::from_slice(&bytes)?;
    manifest.validate()?;
    manifest.verify_integrity()?;
    let blobs = load_blobs(&pack, &manifest)?;
    let route = manifest
        .routes
        .first()
        .ok_or("pack has no routes")?
        .path
        .clone();
    let template_id = format!("template:{route}.wxml");
    if !manifest
        .templates
        .iter()
        .any(|template| template.id == template_id)
    {
        return Err(format!("pack has no template for {route}").into());
    }
    let session_id = format!("dom-protocol-{}", std::process::id());
    let mut host = HostSession::from_manifest_json(
        &bytes,
        SessionConfig {
            session_id: session_id.clone(),
            engine,
            renderer_override: Some(RendererProfile::WebView),
            browser_view_enabled: true,
            require_integrity: true,
            ..SessionConfig::default()
        },
    )?;
    if !host
        .session()
        .ok_or("session unloaded")?
        .engine_provider_available()
    {
        return Err(format!("ERR_ENGINE: requested {engine:?} provider is not compiled").into());
    }
    let modules: Vec<Value> = manifest
        .modules
        .iter()
        .map(|module| json!({"id":module.id,"bytes":blobs[&format!("sha256:{}",module.sha256)]}))
        .collect();
    let startup = [
        (
            op::APP_INIT,
            json!({"modules": modules,"blobs":blobs,"launchOptions":{"path":route,"query":{}}}),
        ),
        (op::APP_LIFECYCLE, json!({"event":"launch"})),
        (op::PAGE_PUSH, json!({"path":route,"query":{}})),
    ];
    let mut startup_batches = Vec::new();
    for (index, (operation, payload)) in startup.into_iter().enumerate() {
        let batch = dispatch(
            &mut host,
            BridgeEnvelope::request(&session_id, format!("startup-{index}"), operation, payload),
        )?;
        require_success(&batch, operation)?;
        startup_batches.push(batch);
    }
    let render_payload = json!({
        "templateId":template_id,"useSessionResources":true,
        "styleIds":manifest.route_style_ids(&route)?,
        "viewport":{"x":0,"y":0,"width":375,"height":667},
    });
    let mut output = io::stdout().lock();
    emit(
        &mut output,
        &json!({
            "kind":"bootstrap","version":"1.0","sessionId":session_id,
            "engine":engine,"route":route,"viewport":{"width":375,"height":667},
            "renderPayload":render_payload,"manifestSha256":container_ir::hex_digest(&bytes),
            "integrityRoot":manifest.integrity.root,"blobCount":blobs.len(),
            "startup":startup_batches,"observation":observation(&host)?,
        }),
    )?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let envelope: BridgeEnvelope = serde_json::from_str(&line)?;
        let batch = dispatch(&mut host, envelope)?;
        emit(&mut output, &serde_json::to_value(batch)?)?;
    }
    host.unload();
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("dom-protocol: {error}");
        std::process::exit(1);
    }
}
