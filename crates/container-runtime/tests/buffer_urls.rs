//! Exact-declaration and real resource consumer contracts. These local tests
//! do not establish physical-device, official SDK or browser acceptance.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeEnvelope};
use container_core::{BufferUrlStore, EngineKind};
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat,
    ModuleScope, RendererProfile, Route, RouteKind, Template,
};
use container_runtime::{Session, SessionConfig};
use image::{ExtendedColorType, ImageEncoder};
use serde_json::{json, Value};
use std::collections::BTreeMap;
const APP: &str = "module:app.js";
const TEMPLATE: &str = "template:home.wxml";
const SOURCE: &str = r#"
App({});
function page(){const pages=getCurrentPages();return pages[pages.length-1];}
exports.create=function(bytes,type){
  const padded=new ArrayBuffer(bytes.length+16),all=new Uint8Array(padded);all.set(bytes,8);
  let value;
  if(type==='ArrayBuffer')value=new Uint8Array(bytes).buffer;
  else {const Type=globalThis[type];value=new Type(padded,8,bytes.length/Type.BYTES_PER_ELEMENT);}
  const url=wx.createBufferURL(value);all.fill(0);page().setData({src:url});return url;
};
exports.use=function(url){page().setData({src:url});};
exports.revoke=function(url){return wx.revokeBufferURL(url)===undefined;};
exports.forge=function(name){__container_capabilities['wx.'+name]='full';return exports.denied(name);};
exports.denied=function(name){try{wx[name](name==='createBufferURL'?new ArrayBuffer(0):'unknown');return null;}catch(error){return error.code;}};
"#;
fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}
fn png() -> Vec<u8> {
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(&[0, 128, 255, 255], 1, 1, ExtendedColorType::Rgba8)
        .unwrap();
    let remainder = out.len() % 8;
    if remainder != 0 {
        // Keep the exact PNG decodable while making its byte length divisible
        // by every declared TypedArray width. Trailing zero bytes are not a
        // valid PNG chunk, so insert a small valid tEXt ancillary chunk before
        // IEND and compute its CRC instead.
        let mut payload_len = (4usize + 8 - remainder) % 8;
        while payload_len < 2 {
            payload_len += 8;
        }
        let mut payload = vec![b'p', 0];
        payload.extend(std::iter::repeat_n(0, payload_len - 2));
        let mut chunk = Vec::with_capacity(12 + payload_len);
        chunk.extend_from_slice(&(payload_len as u32).to_be_bytes());
        chunk.extend_from_slice(b"tEXt");
        chunk.extend_from_slice(&payload);
        let mut crc = 0xffff_ffffu32;
        for byte in chunk[4..].iter().copied() {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        chunk.extend_from_slice(&(!crc).to_be_bytes());
        let iend = out.len() - 12;
        out.splice(iend..iend, chunk);
    }
    out
}
struct Fixture {
    session: Session,
    sequence: u64,
}
impl Fixture {
    fn new(engine: EngineKind, browser: bool, create: bool, revoke: bool) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "buffer-url-native-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        let page = "Page({data:{src:''}});";
        let mut modules = Vec::new();
        for (id, source, scope) in [
            (APP, SOURCE, ModuleScope::App),
            ("module:home.js", page, ModuleScope::Page),
        ] {
            manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: vec![],
            });
            modules.push(json!({"id":id,"source":source}));
        }
        manifest.routes.push(Route {
            id: "route:home".into(),
            path: "home".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "home.js".into(),
        });
        let ast =
            parse_wxml(r#"<image id="lease-image" src="{{src}}" style="width:8px;height:8px"/>"#)
                .unwrap()
                .canonical_json()
                .unwrap();
        let pointer = format!("sha256:{}", hex_digest(&ast));
        manifest.templates.push(Template {
            id: TEMPLATE.into(),
            wxml_ast: pointer.clone(),
            bindings: vec!["src".into()],
            wxs_modules: Default::default(),
        });
        manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Full);
        if create {
            manifest
                .capabilities
                .insert("wx.createBufferURL".into(), CapabilitySupport::Full);
        }
        if revoke {
            manifest
                .capabilities
                .insert("wx.revokeBufferURL".into(), CapabilitySupport::Full);
        }
        manifest.refresh_integrity().unwrap();
        let mut f = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    browser_view_enabled: browser,
                    renderer_override: browser.then_some(RendererProfile::WebView),
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
        };
        f.ok(
            op::APP_INIT,
            json!({"modules":modules,"blobs":BTreeMap::from([(pointer,ast)])}),
        );
        f.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        f.ok(op::PAGE_PUSH, json!({"path":"home"}));
        f
    }
    fn raw(&mut self, op: &str, payload: Value) -> Value {
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("buffer-url-{}", self.sequence),
            op,
            payload,
        ));
        batch.messages[0].payload.clone()
    }
    fn ok(&mut self, op: &str, payload: Value) -> Value {
        let result = self.raw(op, payload);
        assert_eq!(result["ok"], true, "{result}");
        result
    }
    fn call(&mut self, name: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":name,"args":args}),
        )["result"][0]
            .clone()
    }
    fn payload(frame: u64) -> Value {
        json!({"templateId":TEMPLATE,"useSessionResources":true,"frameId":frame,"viewport":{"width":8,"height":8}})
    }
}
#[test]
fn all_declared_binary_inputs_reach_the_owned_browser_resource_reader_and_revoke_blocks_new_reads()
{
    for engine in engines() {
        let mut f = Fixture::new(engine, true, true, true);
        let bytes = png();
        for (index, kind) in [
            "ArrayBuffer",
            "Int8Array",
            "Uint8Array",
            "Uint8ClampedArray",
            "Int16Array",
            "Uint16Array",
            "Int32Array",
            "Uint32Array",
            "Float32Array",
            "Float64Array",
        ]
        .iter()
        .enumerate()
        {
            let url = f
                .call("create", json!([bytes, kind]))
                .as_str()
                .unwrap()
                .to_owned();
            let path = BufferUrlStore::resource_path(&url).unwrap();
            let view = f
                .session
                .prepare_browser_view(&Fixture::payload(index as u64 + 1), 1)
                .unwrap();
            let asset = view
                .document
                .resources
                .iter()
                .find(|asset| asset.path == path)
                .unwrap();
            assert_eq!(asset.sha256, hex_digest(&bytes));
            assert_eq!(
                f.session
                    .browser_view_resource_at_path(&view.key, &asset.sha256, &path)
                    .unwrap(),
                bytes
            );
            assert!(
                f.session
                    .browser_view_resource(&view.key, &asset.sha256)
                    .is_err(),
                "digest alone must not authorize dynamic bytes"
            );
            let mut stale = view.key.clone();
            stale.surface_generation += 1;
            assert!(f
                .session
                .browser_view_resource_at_path(&stale, &asset.sha256, &path)
                .is_err());
            assert_eq!(f.call("revoke", json!([url])), true);
            assert!(f
                .session
                .browser_view_resource_at_path(&view.key, &asset.sha256, &path)
                .is_err());
            f.session.abort_browser_view(&view.key).unwrap();
        }
    }
}
#[test]
fn decoded_native_cache_never_authorizes_a_revoked_or_foreign_lease() {
    for engine in engines() {
        let bytes = png();
        let mut f = Fixture::new(engine, false, true, true);
        let url = f.call("create", json!([bytes, "Uint8Array"]));
        f.ok(op::RENDER_COMMIT, Fixture::payload(1));
        f.ok(op::RENDER_COMMIT, Fixture::payload(2));
        let before = f.session.render_snapshot().unwrap();
        assert_eq!(&before.pixels[..4], &[0, 128, 255, 255]);
        assert_eq!(f.call("revoke", json!([url])), true);
        assert_eq!(f.raw(op::RENDER_COMMIT, Fixture::payload(3))["ok"], false);
        assert_eq!(
            f.session.render_snapshot().unwrap().pixels,
            before.pixels,
            "published immutable frame survives failed replacement"
        );
        let next = f.call("create", json!([bytes, "Uint8Array"]));
        assert_ne!(url, next);
        f.ok(op::RENDER_COMMIT, Fixture::payload(4));
        let mut other = Fixture::new(engine, false, true, true);
        other.call("use", json!([next]));
        assert_eq!(
            other.raw(op::RENDER_COMMIT, Fixture::payload(1))["ok"],
            false
        );
    }
}
#[test]
fn independent_admission_and_terminal_owner_retirement_cannot_be_bypassed() {
    for engine in engines() {
        let mut create_denied = Fixture::new(engine, false, false, true);
        assert_eq!(
            create_denied.call("forge", json!(["createBufferURL"])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        assert_eq!(
            create_denied.call("denied", json!(["createBufferURL"])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        assert_eq!(create_denied.call("revoke", json!(["unknown"])), true);
        let mut revoke_denied = Fixture::new(engine, false, true, false);
        assert_eq!(
            revoke_denied.call("forge", json!(["revokeBufferURL"])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        let bytes = png();
        let url = revoke_denied.call("create", json!([bytes, "ArrayBuffer"]));
        assert_eq!(
            revoke_denied.call("denied", json!(["revokeBufferURL"])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        revoke_denied.ok(op::RENDER_COMMIT, Fixture::payload(1));
        revoke_denied.session.cancel_host_calls().unwrap();
        assert_eq!(
            revoke_denied.raw(op::RENDER_COMMIT, Fixture::payload(2))["ok"],
            false,
            "terminal retirement must revoke resources even when public revoke was denied"
        );
        let mut replacement = Fixture::new(engine, false, true, true);
        let new_url = replacement.call("create", json!([bytes, "ArrayBuffer"]));
        assert_ne!(
            url, new_url,
            "same public Session ID cannot reuse the lease incarnation"
        );
        replacement.call("use", json!([url]));
        assert_eq!(
            replacement.raw(op::RENDER_COMMIT, Fixture::payload(1))["ok"],
            false
        );
    }
}

#[test]
fn page_and_visibility_retirement_preserve_app_scoped_buffer_leases() {
    for engine in engines() {
        let mut f = Fixture::new(engine, false, true, true);
        let bytes = png();
        let url = f.call("create", json!([bytes, "Uint8Array"]));
        f.ok(op::RENDER_COMMIT, Fixture::payload(1));
        f.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
        f.ok(op::APP_LIFECYCLE, json!({"event":"show"}));
        f.ok(op::RENDER_COMMIT, Fixture::payload(2));
        f.ok(op::PAGE_POP, json!({}));
        f.ok(op::PAGE_PUSH, json!({"path":"home"}));
        f.call("use", json!([url]));
        f.ok(op::RENDER_COMMIT, Fixture::payload(3));
    }
}
