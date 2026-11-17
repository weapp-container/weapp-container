//! Real App/Page, setData and selector coverage of the shared text-flow plan.
//! These tests explicitly perform a host render refresh after Page effects;
//! they do not certify the development supervisor, DevTools, GPU or shaping.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope, EnvelopeKind, PROTOCOL_VERSION};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, CapabilitySupport, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Style, StyleScope, Template,
};
use container_render_skia::{RenderFrame, RenderNode, Renderer};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Write;

const SESSION: &str = "text-flow-contract";
const TEMPLATE: &str = "template:pages/index/index.wxml";
const PAGE: &str = "module:pages/index/index.js";
const RAW: &str = "  A  \tB\r\n C  ";
const PAGE_JS: &str = r#"var current;
Page({
  data:{text:__INITIAL_TEXT__,whiteSpace:'normal',wordBreak:'normal',textAlign:'start',toggles:0},
  onLoad:function(){current=this;getApp().trace.push('load');},
  onShow:function(){getApp().trace.push('show');},
  onReady:function(){getApp().trace.push('ready');},
  onToggle:function(){
    var changed=this.data.toggles%2===0;
    this.setData({whiteSpace:changed?'break-spaces':'normal',wordBreak:changed?'break-all':'normal',
      textAlign:changed?'right':'start',toggles:this.data.toggles+1});
  },
  onInspect:function(){
    var self=this,query=wx.createSelectorQuery();
    query.selectAll('.probe').fields({id:true,rect:true,size:true,
      computedStyle:['white-space','word-break','text-align']});
    query.exec(function(values){wx.setStorageSync('text-flow:observation',{
      text:self.data.text,toggles:self.data.toggles,trace:getApp().trace.slice(),geometry:values[0]});});
  }
});
exports.patch=function(patch){current.setData(patch);};"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

struct Fixture {
    session: Session,
    sequence: u64,
    engine: EngineKind,
}

impl Fixture {
    fn new(engine: EngineKind, text: &str, markup: &str, styles: &str) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "local-text-flow-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.routes.push(Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "pages/index/index.js".into(),
        });
        for capability in [
            "wx.createSelectorQuery",
            "wx.setStorageSync",
            "wx.getStorageSync",
        ] {
            manifest
                .capabilities
                .insert(capability.into(), CapabilitySupport::Full);
        }
        let page_source = PAGE_JS.replace("__INITIAL_TEXT__", &json!(text).to_string());
        let mut modules = Vec::new();
        for (id, source, scope) in [
            ("module:app.js", "App({trace:[]});", ModuleScope::App),
            (PAGE, page_source.as_str(), ModuleScope::Page),
        ] {
            manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
            modules.push(json!({"id":id,"bytes":source.as_bytes()}));
        }
        let controls =
            r#"<view id="toggle" bindtap="onToggle"/><view id="inspect" bindtap="onInspect"/>"#;
        let template = parse_wxml(&format!("{markup}{controls}"))
            .unwrap()
            .canonical_json()
            .unwrap();
        let template_pointer = format!("sha256:{}", hex_digest(&template));
        manifest.templates.push(Template {
            id: TEMPLATE.into(),
            wxml_ast: template_pointer.clone(),
            bindings: vec![
                "text".into(),
                "whiteSpace".into(),
                "wordBreak".into(),
                "textAlign".into(),
            ],
            wxs_modules: BTreeMap::new(),
        });
        let style = parse_wxss(&format!(
            "page{{background:white;font-size:16px;line-height:20px}}\
             #toggle,#inspect{{position:absolute;top:640px;width:144px;height:32px}}\
             #toggle{{left:8px}}#inspect{{left:168px}}{styles}"
        ))
        .unwrap()
        .canonical_json()
        .unwrap();
        let style_pointer = format!("sha256:{}", hex_digest(&style));
        manifest.styles.push(Style {
            id: "style:pages/index/index.wxss".into(),
            wxss_ir: style_pointer.clone(),
            scope: StyleScope::Page,
        });
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    session_id: SESSION.into(),
                    ..SessionConfig::default()
                },
            )
            .unwrap(),
            sequence: 0,
            engine,
        };
        let blobs = BTreeMap::from([(template_pointer, template), (style_pointer, style)]);
        let initialized = fixture.ok(op::APP_INIT, json!({"modules":modules,"blobs":blobs}));
        assert_eq!(initialized["engineProviderAvailable"], true, "{engine:?}");
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(op::PAGE_PUSH, json!({"path":"pages/index/index"}));
        let rendered = fixture.refresh();
        fixture.assert_ok(op::RENDER_COMMIT, &rendered);
        fixture
    }

    fn request(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let request_id = format!("text-flow-{}", self.sequence);
        let batch = self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            request_id.as_str(),
            operation,
            payload,
        ));
        // One dispatch may also publish normal lifecycle/diagnostic events.
        // Correlate the response without filtering out foreign responses or
        // asynchronous errors that would otherwise make the test look green.
        for message in &batch.messages {
            assert_eq!(message.session_id, SESSION, "{:?}", batch.messages);
            assert_eq!(
                message.protocol_version, PROTOCOL_VERSION,
                "{:?}",
                batch.messages
            );
            assert_ne!(message.op, op::ERROR, "{:?}", batch.messages);
            match message.kind {
                EnvelopeKind::Response => {
                    assert!(message.payload["ok"].is_boolean(), "{:?}", batch.messages);
                }
                EnvelopeKind::Event => {
                    assert_ne!(message.payload["ok"], false, "{:?}", batch.messages);
                    assert_ne!(message.payload["severity"], "error", "{:?}", batch.messages);
                    assert!(
                        message.payload.get("error").is_none(),
                        "{:?}",
                        batch.messages
                    );
                }
                _ => panic!("unexpected runtime message: {:?}", batch.messages),
            }
        }
        let responses = batch
            .messages
            .iter()
            .filter(|message| message.kind == EnvelopeKind::Response)
            .collect::<Vec<_>>();
        assert_eq!(
            responses.len(),
            1,
            "{:?} {operation}: {:?}",
            self.engine,
            batch.messages
        );
        let response = responses[0];
        assert_eq!(response.request_id, request_id, "{:?}", batch.messages);
        assert_eq!(response.op, operation, "{:?}", batch.messages);
        if response.payload["ok"] == false {
            assert!(
                response.payload["error"]["code"]
                    .as_str()
                    .is_some_and(|code| code.starts_with("ERR_")),
                "{:?}",
                batch.messages
            );
        }
        response.payload.clone()
    }

    fn assert_ok(&self, operation: &str, response: &Value) {
        assert_eq!(
            response["ok"], true,
            "{:?} {operation}: {response}",
            self.engine
        );
    }

    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let response = self.request(operation, payload);
        self.assert_ok(operation, &response);
        response
    }

    fn refresh(&mut self) -> Value {
        // This is the public host refresh boundary, using the verified pack
        // and live Page data. No geometry or substitute data is injected.
        let frame_id = self.sequence + 1;
        self.request(
            op::RENDER_COMMIT,
            json!({
                "templateId":TEMPLATE,"frameId":frame_id,"useSessionResources":true,
                "viewport":{"width":320,"height":680}
            }),
        )
    }

    fn patch(&mut self, value: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":"patch","args":[value]}),
        );
        self.refresh()
    }

    fn tap(&mut self, x: f32, y: f32) {
        let before = self.session.view().revision;
        self.ok(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":x,"y":y}]}),
        );
        assert!(self.session.view().revision > before);
        let rendered = self.refresh();
        self.assert_ok(op::RENDER_COMMIT, &rendered);
    }

    fn observation(&mut self) -> Value {
        self.tap(180.0, 650.0);
        self.ok(
            op::API_CALL,
            json!({"name":"wx.getStorageSync","key":"text-flow:observation"}),
        )["result"]
            .clone()
    }

    fn frame(&self) -> &RenderFrame {
        self.session.renderer().last_frame().unwrap()
    }

    fn export_frame(&self, phase: &str) {
        let Some(directory) = std::env::var_os("WEAPP_CONTAINER_TEXT_FLOW_FRAMES_DIR") else {
            return;
        };
        // Optional observation only: serialize the exact accepted frame. Never
        // change fixture data, text, glyphs or font coverage for a consumer.
        let directory = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&directory).expect("create owned text-flow frame directory");
        let engine = match self.engine {
            EngineKind::Quickjs => "quickjs",
            EngineKind::V8 => "v8",
        };
        let path = directory.join(format!("{engine}-{phase}.frame.json"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap_or_else(|error| {
                panic!("refuse to overwrite text-flow frame {path:?}: {error}")
            });
        serde_json::to_writer_pretty(&mut file, self.frame()).expect("serialize accepted frame");
        file.write_all(b"\n").expect("finish accepted frame JSON");
    }

    fn node(&self, selector: &str) -> &RenderNode {
        let nodes = self.frame().query(selector, true).unwrap();
        assert_eq!(nodes.len(), 1, "{selector}");
        nodes[0]
    }

    fn leaf(&self, selector: &str) -> &RenderNode {
        fn find(node: &RenderNode) -> Option<&RenderNode> {
            if node.text.is_some() {
                return Some(node);
            }
            node.children.iter().find_map(find)
        }
        find(self.node(selector)).expect("the selected sample retains a bound text leaf")
    }
}

fn flow_style(node: &RenderNode) -> Value {
    serde_json::to_value(node.text_style.unwrap()).unwrap()["flow"].clone()
}

/// Check the accepted plan independently against original UTF-8 source bytes.
fn assert_source_plan(node: &RenderNode, expected: &str) -> Value {
    let source = node.text.as_deref().unwrap();
    assert_eq!(
        source, expected,
        "layout cannot trim or rewrite observable bound source"
    );
    let layout = node.text_layout.as_ref().unwrap();
    layout.validate(source).unwrap();
    let flow = serde_json::to_value(layout).unwrap()["flow"].clone();
    assert_eq!(flow["version"], 1);
    assert_eq!(flow["source_sha256"], hex_digest(source.as_bytes()));
    assert_eq!(flow["style"], flow_style(node));
    let spans = flow["glyph_sources"].as_array().unwrap();
    assert_eq!(spans.len(), layout.glyphs.len());
    let mut last_end = 0;
    for (glyph, span) in layout.glyphs.iter().zip(spans) {
        let start = span["start"].as_u64().unwrap() as usize;
        let end = span["end"].as_u64().unwrap() as usize;
        assert!(start >= last_end && end > start && end <= source.len());
        assert!(source.is_char_boundary(start) && source.is_char_boundary(end));
        let original = &source[start..end];
        if glyph.character == ' ' {
            assert!(original
                .chars()
                .all(|c| matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{000c}')));
        } else {
            assert_eq!(original, glyph.character.to_string());
        }
        last_end = end;
    }
    let lines = flow["lines"].as_array().unwrap();
    assert_eq!(lines.len(), layout.metrics.line_count as usize);
    if lines.is_empty() {
        assert_eq!(flow["empty_source"], json!({"start":0,"end":source.len()}));
        assert!(layout.glyphs.is_empty());
        assert_eq!(layout.metrics.height, 0.0);
    } else {
        assert_eq!(flow["empty_source"], Value::Null);
        let mut source_end = 0;
        let mut glyph_end = 0;
        for line in lines {
            assert_eq!(line["source_start"], source_end);
            assert_eq!(line["glyph_start"], glyph_end);
            source_end = line["source_end"].as_u64().unwrap();
            glyph_end = line["glyph_end"].as_u64().unwrap();
        }
        assert_eq!(source_end as usize, source.len());
        assert_eq!(glyph_end as usize, layout.glyphs.len());
    }
    flow
}

#[test]
fn real_page_tap_changes_the_plan_while_selectors_and_storage_keep_original_source() {
    for engine in engines() {
        let mut fixture = Fixture::new(
            engine,
            RAW,
            r#"<text id="sample" class="probe" style="white-space:{{whiteSpace}};word-break:{{wordBreak}};text-align:{{textAlign}}">{{text}}</text>"#,
            ".probe{display:block;width:64px}",
        );
        let before = assert_source_plan(fixture.leaf("#sample"), RAW);
        assert_eq!(
            before["style"],
            json!({"white_space":"normal","word_break":"normal","text_align":"start"})
        );
        assert_eq!(
            fixture
                .leaf("#sample")
                .text_layout
                .as_ref()
                .unwrap()
                .glyphs
                .iter()
                .map(|g| g.character)
                .collect::<String>(),
            "A B C"
        );
        fixture.export_frame("source-initial");
        let first = fixture.observation();
        assert_eq!(first["text"], RAW);
        assert_eq!(first["toggles"], 0);
        assert_eq!(first["trace"], json!(["load", "show", "ready"]));
        fixture.tap(20.0, 650.0);
        let after = assert_source_plan(fixture.leaf("#sample"), RAW);
        assert_eq!(
            after["style"],
            json!({"white_space":"break-spaces","word_break":"break-all","text_align":"right"})
        );
        assert_ne!(before["lines"], after["lines"]);
        fixture.export_frame("source-changed");
        let observed = fixture.observation();
        assert_eq!(observed["text"], RAW);
        assert_eq!(observed["toggles"], 1);
        assert_eq!(observed["geometry"][0]["white-space"], "break-spaces");
        assert_eq!(observed["geometry"][0]["word-break"], "break-all");
        assert_eq!(observed["geometry"][0]["text-align"], "right");
        fixture.tap(20.0, 650.0);
        assert_eq!(assert_source_plan(fixture.leaf("#sample"), RAW), before);
        fixture.export_frame("source-restored");
    }
}

#[test]
fn whitespace_modes_preserve_source_and_only_pre_or_nowrap_disable_soft_wrapping() {
    for engine in engines() {
        let mut fixture = Fixture::new(
            engine,
            "  AA  BB\tCC\r\n DD  EE  ",
            r#"<text id="sample" class="probe" style="white-space:{{whiteSpace}};word-break:break-all">{{text}}</text>"#,
            ".probe{display:block;width:24px}",
        );
        for mode in [
            "normal",
            "nowrap",
            "pre",
            "pre-wrap",
            "pre-line",
            "break-spaces",
        ] {
            let rendered = fixture.patch(json!({"whiteSpace":mode}));
            fixture.assert_ok(op::RENDER_COMMIT, &rendered);
            let plan = assert_source_plan(fixture.leaf("#sample"), "  AA  BB\tCC\r\n DD  EE  ");
            let kinds: Vec<_> = plan["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|line| line["break_kind"].as_str().unwrap())
                .collect();
            if ["nowrap", "pre"].contains(&mode) {
                assert!(!kinds.contains(&"soft"), "{engine:?} {mode}");
                assert_eq!(kinds.len(), if mode == "pre" { 2 } else { 1 });
            } else {
                assert!(kinds.contains(&"soft"), "{engine:?} {mode}");
            }
            assert_eq!(
                kinds.contains(&"hard"),
                !["normal", "nowrap"].contains(&mode),
                "{engine:?} {mode}"
            );
            fixture.export_frame(&format!("whitespace-{mode}"));
        }
        let rendered = fixture.patch(json!({"text":" \t\r\n ","whiteSpace":"normal"}));
        fixture.assert_ok(op::RENDER_COMMIT, &rendered);
        let empty = assert_source_plan(fixture.leaf("#sample"), " \t\r\n ");
        assert_eq!(empty["lines"], json!([]));
        fixture.export_frame("whitespace-empty");
    }
}

#[test]
fn normal_does_not_split_a_long_latin_word_and_keep_all_keeps_a_cjk_sequence() {
    for engine in engines() {
        for source in ["Supercalifragilisticexpialidocious", "甲乙丙丁戊己庚辛壬癸"] {
            let mut fixture = Fixture::new(
                engine,
                source,
                r#"<text id="sample" class="probe" style="word-break:{{wordBreak}}">{{text}}</text>"#,
                ".probe{display:block;width:32px}",
            );
            let original = assert_source_plan(fixture.leaf("#sample"), source);
            if source.is_ascii() {
                assert_eq!(original["lines"].as_array().unwrap().len(), 1);
            } else {
                assert!(original["lines"].as_array().unwrap().len() > 1);
            }
            let kind = if source.is_ascii() { "latin" } else { "cjk" };
            fixture.export_frame(&format!("words-{kind}-normal"));
            let rendered = fixture.patch(json!({"wordBreak":"break-all"}));
            fixture.assert_ok(op::RENDER_COMMIT, &rendered);
            assert!(
                assert_source_plan(fixture.leaf("#sample"), source)["lines"]
                    .as_array()
                    .unwrap()
                    .len()
                    > 1
            );
            fixture.export_frame(&format!("words-{kind}-break-all"));
            let rendered = fixture.patch(json!({"wordBreak":"keep-all"}));
            fixture.assert_ok(op::RENDER_COMMIT, &rendered);
            assert_eq!(
                assert_source_plan(fixture.leaf("#sample"), source)["lines"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            fixture.export_frame(&format!("words-{kind}-keep-all"));
        }
    }
}

#[test]
fn break_all_never_breaks_inside_combining_zwj_or_regional_indicator_graphemes() {
    for engine in engines() {
        let source = "A\u{0301}👩\u{200d}💻🇨🇳";
        let fixture = Fixture::new(
            engine,
            source,
            r#"<text id="sample" class="probe">{{text}}</text>"#,
            ".probe{display:block;width:2px;word-break:break-all}",
        );
        let plan = assert_source_plan(fixture.leaf("#sample"), source);
        assert_eq!(plan["lines"].as_array().unwrap().len(), 3);
        let glyphs = &fixture.leaf("#sample").text_layout.as_ref().unwrap().glyphs;
        let mut start = 0;
        let mut previous = None;
        for count in [2, 3, 2] {
            let group = &glyphs[start..start + count];
            assert!(group
                .iter()
                .all(|glyph| glyph.baseline_y == group[0].baseline_y));
            if let Some(before) = previous {
                assert!(group[0].baseline_y > before);
            }
            previous = Some(group[0].baseline_y);
            start += count;
        }
        assert_eq!(start, glyphs.len());
        fixture.export_frame("graphemes");
    }
}

#[test]
fn alignment_uses_the_available_content_width_and_inheritance_is_computed() {
    for engine in engines() {
        let fixture = Fixture::new(engine, "AB",
            r#"<view id="parent"><text id="inherited" class="probe">{{text}}</text><text id="explicit" class="probe" style="white-space:inherit;word-break:inherit;text-align:inherit">{{text}}</text><text id="initial" class="probe" style="white-space:initial;word-break:initial;text-align:initial">{{text}}</text><text id="unset" class="probe" style="white-space:unset;word-break:unset;text-align:unset">{{text}}</text></view>"#,
            "#parent{white-space:pre-wrap;word-break:keep-all;text-align:right}.probe{display:block;width:120px;padding-left:10px;padding-right:6px;box-sizing:border-box}");
        for id in ["inherited", "explicit", "unset"] {
            assert_eq!(
                flow_style(fixture.node(&format!("#{id}"))),
                json!({"white_space":"pre-wrap","word_break":"keep-all","text_align":"right"})
            );
        }
        assert_eq!(
            flow_style(fixture.node("#initial")),
            json!({"white_space":"normal","word_break":"normal","text_align":"start"})
        );
        fixture.export_frame("inheritance");
        for align in ["start", "end", "left", "right", "center"] {
            let fixture = Fixture::new(engine, "AB",
                r#"<text id="sample" class="probe">{{text}}</text>"#,
                &format!(".probe{{display:block;width:120px;padding-left:10px;padding-right:6px;box-sizing:border-box;text-align:{align}}}"));
            let plan = assert_source_plan(fixture.leaf("#sample"), "AB");
            let available = plan["available_width"].as_f64().unwrap();
            assert!(
                (available - 104.0).abs() < 0.01,
                "{engine:?} {align}: {plan}"
            );
            let line = &plan["lines"][0];
            let free = available - line["width"].as_f64().unwrap();
            assert!(free > 0.0);
            let expected = match align {
                "end" | "right" => free,
                "center" => free / 2.0,
                _ => 0.0,
            };
            assert!(
                (line["x"].as_f64().unwrap() - expected).abs() < 0.01,
                "{engine:?} {align}: {line}"
            );
            fixture.export_frame(&format!("alignment-{align}"));
        }
    }
}

#[test]
fn invalid_flow_declarations_fall_back_and_deferred_values_retain_the_accepted_frame() {
    for engine in engines() {
        let mut fixture = Fixture::new(
            engine,
            RAW,
            r#"<text id="sample" class="probe" style="white-space:{{whiteSpace}}">{{text}}</text>"#,
            ".probe{display:block;width:64px;white-space:pre}",
        );
        let rendered = fixture.patch(json!({"whiteSpace":"banana"}));
        fixture.assert_ok(op::RENDER_COMMIT, &rendered);
        assert_eq!(flow_style(fixture.node("#sample"))["white_space"], "pre");
        fixture.export_frame("invalid-fallback");
        let accepted = fixture.frame().clone();
        let pixels = fixture.session.renderer().snapshot();
        for (phase, value) in [
            ("var", "var(--text-flow)"),
            ("revert", "revert"),
            ("revert-layer", "revert-layer"),
        ] {
            let rejected = fixture.patch(json!({"whiteSpace":value}));
            assert_eq!(rejected["ok"], false, "{engine:?} {value}: {rejected}");
            assert_eq!(
                rejected["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
                "{engine:?} {value}: {rejected}"
            );
            assert_eq!(fixture.frame(), &accepted);
            assert_eq!(fixture.session.renderer().snapshot(), pixels);
            fixture.export_frame(&format!("rejected-{phase}-retained"));
        }
        let repaired = fixture.patch(json!({"whiteSpace":"normal"}));
        fixture.assert_ok(op::RENDER_COMMIT, &repaired);
        assert_eq!(flow_style(fixture.node("#sample"))["white_space"], "normal");
        assert_source_plan(fixture.leaf("#sample"), RAW);
        fixture.export_frame("repaired");
    }
}
