//! Local C ABI coverage. These tests execute the actual enabled JS providers;
//! they are not HarmonyOS simulator, device or GPU evidence.

use super::*;
use container_bridge::op;
use container_host_common::{FfiBuffer, FFI_ERR, FFI_INVALID_ARGUMENT, FFI_OK};
use serde_json::{json, Value};

struct Host(*mut HarmonyHost);

impl Host {
    fn new() -> Self {
        Self(ffi::weapp_container_harmony_host_new())
    }

    fn configured_load(&self, manifest: &[u8], config: &[u8]) -> (i32, Option<Value>) {
        let mut output = FfiBuffer::empty();
        let status = unsafe {
            ffi::weapp_container_harmony_host_load_manifest_with_config(
                self.0,
                manifest.as_ptr(),
                manifest.len(),
                config.as_ptr(),
                config.len(),
                &mut output,
            )
        };
        let value = if output.data.is_null() {
            assert_eq!(output.len, 0);
            None
        } else {
            Some(take_json(&mut output))
        };
        (status, value)
    }

    fn state(&self) -> Value {
        let mut output = FfiBuffer::empty();
        assert_eq!(
            unsafe { ffi::weapp_container_harmony_host_inspect_state(self.0, &mut output) },
            FFI_OK
        );
        take_json(&mut output)
    }

    fn batch(&self, operations: &[(&str, Value)]) -> Value {
        let messages = operations
            .iter()
            .enumerate()
            .map(|(index, (operation, payload))| {
                BridgeEnvelope::request(
                    "harmony-live",
                    format!("live-{index}"),
                    *operation,
                    payload.clone(),
                )
            })
            .collect();
        let bytes = serde_json::to_vec(&BridgeBatch::new(messages)).unwrap();
        let mut output = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_harmony_host_dispatch_batch_json(
                    self.0,
                    bytes.as_ptr(),
                    bytes.len(),
                    &mut output,
                )
            },
            FFI_OK
        );
        let batch = take_json(&mut output);
        assert!(
            batch["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|message| message["op"] != op::ERROR),
            "{batch}"
        );
        batch
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        unsafe { ffi::weapp_container_harmony_host_free(self.0) };
    }
}

fn take_json(output: &mut FfiBuffer) -> Value {
    assert!(!output.data.is_null());
    let parsed =
        serde_json::from_slice(unsafe { std::slice::from_raw_parts(output.data, output.len) });
    unsafe { ffi::weapp_container_harmony_buffer_free(output) };
    parsed.expect("FFI output is JSON")
}

fn engines() -> impl Iterator<Item = EngineKind> {
    [EngineKind::Quickjs, EngineKind::V8]
        .into_iter()
        .filter(|engine| engine_provider_compiled(*engine))
}

fn fixture() -> (Vec<u8>, Value) {
    let app = r#"
        App({
          onHide() { getCurrentPages().forEach(page => page.setData({backgrounds:page.data.backgrounds+1})); },
          onShow() { getCurrentPages().forEach(page => page.setData({foregrounds:page.data.foregrounds+1})); }
        });
    "#;
    let page = r#"
        Page({data:{loads:0,timers:0,microtasks:0,resizes:0,backgrounds:0,foregrounds:0},
          onLoad() {
            this.setData({loads:this.data.loads+1});
            setTimeout(() => {
              this.setData({timers:this.data.timers+1});
              Promise.resolve().then(() => this.setData({microtasks:this.data.microtasks+1}));
            }, 1);
          },
          onResize(event) { this.setData({resizes:this.data.resizes+1,size:event.size}); }
        });
    "#;
    let modules = json!([
        {"id":"module:app.js","source":app},
        {"id":"module:pages/index.js","source":page}
    ]);
    let manifest = json!({
        "schemaVersion":1,"protocolVersion":"1.0",
        "compiler":{"name":"weapp-vite","commit":"harmony-live-ffi","platform":"weapp"},
        "app":{"appJson":"app.json","entryModule":"app.js"},
        "routes":[{"id":"route:pages/index","path":"pages/index","kind":"page","entryModule":"pages/index.js"}],
        "modules":[
            {"id":"module:app.js","sha256":container_ir::hex_digest(app.as_bytes()),"format":"commonjs","scope":"app"},
            {"id":"module:pages/index.js","sha256":container_ir::hex_digest(page.as_bytes()),"format":"commonjs","scope":"page"}
        ],
        "capabilities":{"getCurrentPages":"partial","wx.timer":"partial"},
        "integrity":{"algorithm":"sha256","root":""}
    });
    (serde_json::to_vec(&manifest).unwrap(), modules)
}

fn config(engine: EngineKind) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "engine":engine,"session_id":"harmony-live",
        "host":{"platform":"harmony","windowWidth":360,"windowHeight":640}
    }))
    .unwrap()
}

#[test]
fn configured_load_rejects_unavailable_engine_without_fallback() {
    let (manifest, _) = fixture();
    for engine in [EngineKind::Quickjs, EngineKind::V8] {
        if engine_provider_compiled(engine) {
            continue;
        }
        let host = Host::new();
        let (status, output) = host.configured_load(&manifest, &config(engine));
        assert_eq!(status, FFI_ERR);
        assert_eq!(output.unwrap()["error"]["code"], "ERR_ENGINE");
        assert!(!unsafe { &*host.0 }.has_session());
    }
}

#[test]
fn configured_load_preserves_running_session_on_invalid_config_or_manifest() {
    let (manifest, modules) = fixture();
    for engine in engines() {
        let host = Host::new();
        assert_eq!(
            host.configured_load(&manifest, &config(engine)),
            (FFI_OK, None)
        );
        host.batch(&[
            (op::APP_INIT, json!({"modules":modules})),
            (op::APP_LIFECYCLE, json!({"event":"launch"})),
            (op::PAGE_PUSH, json!({"path":"pages/index"})),
        ]);
        let before = host.state();
        for invalid in [br#"{"engine":"not-an-engine"}"#.as_slice(), b"{"] {
            let (status, output) = host.configured_load(&manifest, invalid);
            assert_eq!(status, FFI_ERR);
            assert_eq!(output.unwrap()["error"]["code"], "ERR_ENGINE");
            assert_eq!(host.state(), before);
        }
        let mut invalid_config: Value = serde_json::from_slice(&config(engine)).unwrap();
        invalid_config["session_id"] = json!("");
        let (status, output) =
            host.configured_load(&manifest, &serde_json::to_vec(&invalid_config).unwrap());
        assert_eq!(status, FFI_ERR);
        assert_eq!(output.unwrap()["error"]["code"], "ERR_INVALID_REQUEST");
        assert_eq!(host.state(), before);
        let (status, output) = host.configured_load(b"{}", &config(engine));
        assert_eq!(status, FFI_ERR);
        assert_eq!(output.unwrap()["error"]["code"], "ERR_INVALID_MANIFEST");
        assert_eq!(host.state(), before);
    }
}

#[test]
fn ffi_live_modules_resize_timers_and_lifecycle_share_one_session() {
    let (manifest, modules) = fixture();
    for engine in engines() {
        let host = Host::new();
        assert_eq!(
            host.configured_load(&manifest, &config(engine)),
            (FFI_OK, None)
        );
        let loaded = host.state();
        assert_eq!(loaded["schemaVersion"], 1);
        assert_eq!(loaded["engine"], serde_json::to_value(engine).unwrap());
        assert_eq!(loaded["sessionId"], "harmony-live");
        assert!(loaded["page"].is_null());
        assert!(loaded.get("frame").is_none());
        host.batch(&[
            (op::APP_INIT, json!({"modules":modules})),
            (op::APP_LIFECYCLE, json!({"event":"launch"})),
            (op::PAGE_PUSH, json!({"path":"pages/index"})),
        ]);
        let first = host.state();
        assert_eq!(first["page"]["data"]["loads"], 1);
        assert_eq!(first["page"]["data"]["timers"], 0);
        assert_eq!(host.state(), first, "inspection must not advance timers");
        let page_id = first["page"]["id"].clone();
        let mut output = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_harmony_host_resize_viewport(host.0, 640, 360, &mut output)
            },
            FFI_OK
        );
        let resized = take_json(&mut output);
        assert!(resized["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["payload"]["type"] == "host.resize"));
        let state = host.state();
        assert_eq!(state["sessionId"], "harmony-live");
        assert_eq!(state["page"]["id"], page_id);
        assert_eq!(state["viewport"], json!({"width":640,"height":360}));
        assert_eq!(state["page"]["data"]["resizes"], 1);
        assert_eq!(
            state["page"]["data"]["size"],
            json!({"windowWidth":640,"windowHeight":360})
        );
        assert_eq!(
            unsafe {
                ffi::weapp_container_harmony_host_resize_viewport(host.0, 640, 360, &mut output)
            },
            FFI_OK
        );
        assert!(take_json(&mut output)["messages"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(host.state(), state);
        assert_eq!(
            unsafe {
                ffi::weapp_container_harmony_host_resize_viewport(host.0, 0, 360, &mut output)
            },
            FFI_ERR
        );
        take_json(&mut output);
        assert_eq!(
            host.state(),
            state,
            "invalid geometry cannot mutate the live session"
        );
        let now_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            .min(u64::MAX as u128) as u64;
        assert_eq!(
            unsafe {
                ffi::weapp_container_harmony_host_poll_timers(
                    host.0,
                    now_ns.saturating_add(10_000_000),
                    &mut output,
                )
            },
            FFI_OK
        );
        let polled = take_json(&mut output);
        assert!(
            polled["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|message| message["op"] != op::ERROR),
            "{polled}"
        );
        let timed = host.state();
        assert_eq!(timed["page"]["id"], page_id);
        assert_eq!(timed["page"]["data"]["timers"], 1);
        assert_eq!(timed["page"]["data"]["microtasks"], 1);
        for event in ["hide", "show"] {
            let request = format!("ffi-{event}");
            assert_eq!(
                unsafe {
                    ffi::weapp_container_harmony_host_lifecycle(
                        host.0,
                        request.as_ptr(),
                        request.len(),
                        event.as_ptr(),
                        event.len(),
                        &mut output,
                    )
                },
                FFI_OK
            );
            let lifecycle = take_json(&mut output);
            assert!(
                lifecycle["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|message| message["op"] != op::ERROR),
                "{lifecycle}"
            );
        }
        let resumed = host.state();
        assert_eq!(resumed["page"]["data"]["backgrounds"], 1);
        assert_eq!(resumed["page"]["data"]["foregrounds"], 1);
        assert_eq!(resumed["lifecycle"], "Active");
        assert_eq!(resumed["page"]["id"], page_id);
        for _ in 0..2 {
            assert_eq!(
                unsafe { ffi::weapp_container_harmony_host_unload(host.0) },
                FFI_OK
            );
        }
        assert!(!unsafe { &*host.0 }.has_session());
        assert!(!unsafe { &*host.0 }.is_initialized());
        assert_eq!(
            unsafe { ffi::weapp_container_harmony_host_inspect_state(host.0, &mut output) },
            FFI_ERR
        );
        assert_eq!(
            take_json(&mut output)["error"],
            "host session has no loaded manifest"
        );
        assert_eq!(
            host.configured_load(&manifest, &config(engine)),
            (FFI_OK, None)
        );
        assert!(
            host.state()["page"].is_null(),
            "unloaded host is reusable with fresh state"
        );
    }
}

#[test]
fn ffi_live_operations_validate_handles_and_empty_output_slots() {
    let host = Host::new();
    let mut output = FfiBuffer::empty();
    unsafe {
        assert_eq!(
            ffi::weapp_container_harmony_host_inspect_state(host.0, std::ptr::null_mut()),
            FFI_INVALID_ARGUMENT
        );
        assert_eq!(
            ffi::weapp_container_harmony_host_resize_viewport(host.0, 1, 1, std::ptr::null_mut()),
            FFI_INVALID_ARGUMENT
        );
        assert_eq!(
            ffi::weapp_container_harmony_host_load_manifest_with_config(
                host.0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null_mut()
            ),
            FFI_INVALID_ARGUMENT
        );
        assert_eq!(
            ffi::weapp_container_harmony_host_unload(std::ptr::null_mut()),
            FFI_INVALID_ARGUMENT
        );
        assert_eq!(
            ffi::weapp_container_harmony_host_inspect_state(std::ptr::null(), &mut output),
            FFI_ERR
        );
    }
    assert_eq!(take_json(&mut output)["error"], "host handle is null");
    assert_eq!(
        unsafe {
            ffi::weapp_container_harmony_host_resize_viewport(
                std::ptr::null_mut(),
                1,
                1,
                &mut output,
            )
        },
        FFI_ERR
    );
    assert_eq!(take_json(&mut output)["error"], "host handle is null");
    assert_eq!(
        unsafe { ffi::weapp_container_harmony_host_inspect_state(host.0, &mut output) },
        FFI_ERR
    );
    assert_eq!(
        take_json(&mut output)["error"],
        "host session has no loaded manifest"
    );
    assert_eq!(
        unsafe { ffi::weapp_container_harmony_host_resize_viewport(host.0, 1, 1, &mut output) },
        FFI_ERR
    );
    assert_eq!(
        take_json(&mut output)["error"],
        "host session has no loaded manifest"
    );
}

#[test]
fn abandon_gles_validates_handle_and_requires_explicit_feature() {
    assert_eq!(
        unsafe { ffi::weapp_container_harmony_host_abandon_gles_context(std::ptr::null_mut()) },
        FFI_INVALID_ARGUMENT
    );
    let host = Host::new();
    // No GL context/window or loaded runtime exists. Cleanup must never need
    // one; a feature-disabled binary reports that its GPU path is unavailable.
    for _ in 0..2 {
        assert_eq!(
            unsafe { ffi::weapp_container_harmony_host_abandon_gles_context(host.0) },
            if cfg!(feature = "skia-gpu-gles") {
                FFI_OK
            } else {
                FFI_ERR
            }
        );
    }
}

fn host_services(host: &Host, operation: &str, payload: Value) -> Result<Value, Value> {
    let command = serde_json::to_vec(&json!({"operation":operation,"payload":payload})).unwrap();
    let mut output = FfiBuffer::empty();
    let status = unsafe {
        ffi::weapp_container_harmony_host_services_json(
            host.0,
            command.as_ptr(),
            command.len(),
            &mut output,
        )
    };
    let value = take_json(&mut output);
    if status == FFI_OK {
        Ok(value)
    } else {
        Err(value)
    }
}

#[test]
fn ffi_host_services_execute_true_sync_and_async_files_in_the_same_real_js_owner() {
    for engine in engines() {
        let directory = std::env::temp_dir().join(format!(
            "weapp-harmony-ffi-files-{}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            engine
        ));
        std::fs::create_dir(&directory).unwrap();
        let host = Host::new();
        let (manifest, mut modules) = fixture();
        let mut manifest: Value = serde_json::from_slice(&manifest).unwrap();
        let source = r#"Page({data:{},onLoad(){
          const fs=wx.getFileSystemManager();
          fs.writeFileSync('wxfile://user/native.bin',new Uint8Array([0,128,255]).buffer);
          const bytes=fs.readFileSync('wxfile://user/native.bin');
          const stats=fs.statSync('wxfile://user/native.bin');
          fs.writeFileSync('wxfile://user/utf16.txt','\ud800A\udc00','utf16le');
          let escaped=false;try{fs.writeFileSync('/tmp/not-a-guest-path','no')}catch(error){escaped=true}
          this.setData({bytes:Array.from(new Uint8Array(bytes)),regular:stats.isFile(),escaped,camera:wx.getAppAuthorizeSetting().cameraAuthorized});
          fs.writeFile({filePath:'wxfile://user/async.txt',data:'native-async',success:()=>{
            fs.readFile({filePath:'wxfile://user/async.txt',encoding:'utf8',success:result=>this.setData({asyncResult:result.data})});
          }});
          fs.readFile({filePath:'wxfile://user/utf16.txt',encoding:'utf16le',success:result=>this.setData({asyncUtf16:Array.from(result.data).map(value=>value.charCodeAt(0))})});
        }});"#;
        modules[1]["source"] = json!(source);
        manifest["modules"][1]["sha256"] = json!(container_ir::hex_digest(source.as_bytes()));
        assert_eq!(
            host.configured_load(&serde_json::to_vec(&manifest).unwrap(), &config(engine)),
            (FFI_OK, None)
        );
        host_services(&host, "managedFilesRoot", json!({"root":directory})).unwrap();
        let configured=host_services(&host,"configure",json!({"application":{"hostAppId":"host","tenantId":"tenant","publisherId":"publisher","appId":"app","environment":"release","version":"1","packRoot":""},"account":{"principalId":"alice","epoch":"9007199254740993"},"apis":["wx.getFileSystemManager","object:FileSystemManager.writeFile","object:FileSystemManager.readFile","wx.getAppAuthorizeSetting"],"syncValues":{"wx.getAppAuthorizeSetting":{"cameraAuthorized":"denied"}}})).unwrap();
        assert_eq!(configured["sessionId"], "harmony-live");
        host.batch(&[
            (op::APP_INIT, json!({"modules":modules})),
            (op::PAGE_PUSH, json!({"path":"pages/index"})),
        ]);
        let initial = host.state();
        assert_eq!(initial["page"]["data"]["bytes"], json!([0, 128, 255]));
        assert_eq!(initial["page"]["data"]["regular"], true);
        assert_eq!(initial["page"]["data"]["escaped"], true);
        assert_eq!(initial["page"]["data"]["camera"], "denied");
        let mut old_context = None;
        for _ in 0..8 {
            let requests = host_services(&host, "take", json!({})).unwrap();
            let requests = requests["requests"].as_array().unwrap();
            if requests.is_empty() {
                break;
            }
            for request in requests {
                if request["kind"] != "call" {
                    continue;
                }
                let method = request["method"].as_str().unwrap();
                let payload = request["payload"].clone();
                let result = if method == "wx.getFileSystemManager" {
                    json!({"objectId":payload["objectId"]})
                } else {
                    old_context = Some(request["context"].clone());
                    host_services(
                        &host,
                        "managedFile",
                        json!({"context":request["context"],"method":method,"payload":payload}),
                    )
                    .unwrap()
                };
                host_services(
                    &host,
                    "complete",
                    json!({"callId":request["callId"],"result":result}),
                )
                .unwrap();
            }
        }
        assert_eq!(host.state()["page"]["data"]["asyncResult"], "native-async");
        assert_eq!(
            host.state()["page"]["data"]["asyncUtf16"],
            json!([55296, 65, 56320])
        );
        let scope = host_services(&host, "managedFileScope", json!({})).unwrap();
        let root = std::path::PathBuf::from(scope["root"].as_str().unwrap());
        assert_eq!(
            std::fs::read(root.join("native.bin")).unwrap(),
            vec![0, 128, 255]
        );
        assert_eq!(
            std::fs::read_to_string(root.join("async.txt")).unwrap(),
            "native-async"
        );
        host_services(&host, "revoke", json!({})).unwrap();
        assert!(host_services(&host,"managedFile",json!({"context":old_context.unwrap(),"method":"object:FileSystemManager.writeFile","payload":{"filePath":"wxfile://user/after-revoke","data":"denied"}})).is_err());
        assert!(!root.join("after-revoke").exists());
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
