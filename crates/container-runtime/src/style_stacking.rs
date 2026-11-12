//! Lower cascaded stacking values without confusing their computed value with
//! their applicability. A static block keeps its authored integer for selector
//! queries and explicit inheritance; the shared paint compiler decides whether
//! positioning or flex-item membership makes that integer participate.

use super::{BridgeError, BridgeErrorCode, RenderNode};
use container_ir::{
    parse_wxss_isolation, parse_wxss_stacking_effect, parse_wxss_z_index, WxssIsolation,
    WxssStackingEffect, WxssZIndex,
};

const EFFECTS: &[(&str, &str)] = &[
    ("mix-blend-mode", "normal"),
    ("contain", "none"),
    ("will-change", "auto"),
    ("perspective", "none"),
];

fn unsupported(property: &str, value: &str) -> BridgeError {
    BridgeError::new(
        BridgeErrorCode::UnsupportedCapability,
        format!("unsupported WXSS {property}: {value}"),
    )
}

pub(super) fn apply_tree(node: &mut RenderNode) -> Result<(), BridgeError> {
    apply(node, None, false)
}

fn apply(
    node: &mut RenderNode,
    parent_z_index: Option<i32>,
    parent_isolation: bool,
) -> Result<(), BridgeError> {
    let mut inherited_z_index = parent_z_index;
    let mut inherited_isolation = parent_isolation;
    // This pass is exclusive to new WXSS frames. Typed/absolute legacy
    // producers retain their original z_index contract and local ordering.
    if let Some(mut style) = node.style.filter(|style| style.flow.is_some()) {
        let z_index = match node.computed_style.get("z-index") {
            None => None,
            Some(source) => match parse_wxss_z_index(source) {
                Ok(WxssZIndex::Integer(value)) => Some(value),
                Ok(WxssZIndex::Inherit) => parent_z_index,
                Ok(WxssZIndex::Auto | WxssZIndex::Initial | WxssZIndex::Unset) | Err(_) => None,
                Ok(WxssZIndex::Unsupported(_)) => return Err(unsupported("z-index", source)),
            },
        };
        let isolation = match node.computed_style.get("isolation") {
            None => false,
            Some(source) => match parse_wxss_isolation(source) {
                Ok(WxssIsolation::Isolate) => true,
                Ok(WxssIsolation::Inherit) => parent_isolation,
                Ok(WxssIsolation::Auto | WxssIsolation::Initial | WxssIsolation::Unset)
                | Err(_) => false,
                Ok(WxssIsolation::Unsupported(_)) => return Err(unsupported("isolation", source)),
            },
        };
        // These properties all have a non-inherited no-effect initial value.
        // If an ancestor carried another value it has already failed this
        // candidate frame, so explicit inherit also resolves to that initial.
        // Properties without a reliable IR parser are not guessed here.
        for (property, initial) in EFFECTS {
            if let Some(source) = node.computed_style.get(*property) {
                match parse_wxss_stacking_effect(property, source) {
                    Ok(WxssStackingEffect::Unsupported(_)) => {
                        return Err(unsupported(property, source));
                    }
                    Ok(_) => {
                        node.computed_style
                            .insert((*property).into(), (*initial).into());
                    }
                    Err(_) => {}
                }
            }
        }
        style.z_index = z_index;
        style.isolation = isolation;
        node.style = Some(style);
        // Preserve the public legacy field's numeric observation. It does not
        // decide CSS stacking: None and Some(0) remain distinct in LayoutStyle.
        node.z_index = z_index.unwrap_or(0);
        inherited_z_index = z_index;
        inherited_isolation = isolation;
        if node.computed_style.contains_key("z-index") {
            node.computed_style.insert(
                "z-index".into(),
                z_index.map_or_else(|| "auto".into(), |value| value.to_string()),
            );
        }
        if node.computed_style.contains_key("isolation") {
            node.computed_style.insert(
                "isolation".into(),
                if isolation { "isolate" } else { "auto" }.into(),
            );
        }
    }
    for child in &mut node.children {
        apply(child, inherited_z_index, inherited_isolation)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_render_skia::{FlowStyle, LayoutStyle, PositionMode, Rect};

    const BOUNDS: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 40.0,
        height: 40.0,
    };

    fn node(id: &str, declarations: &[(&str, &str)]) -> RenderNode {
        let mut node = RenderNode::new(id, BOUNDS);
        node.style = Some(LayoutStyle {
            flow: Some(FlowStyle::default()),
            ..LayoutStyle::default()
        });
        node.computed_style = declarations
            .iter()
            .map(|(name, value)| ((*name).into(), (*value).into()))
            .collect();
        node
    }

    #[test]
    fn automatic_and_zero_computed_values_have_distinct_typed_contracts() {
        let mut root = node("root", &[("z-index", "+0007"), ("isolation", "isolate")]);
        for value in [
            None,
            Some("auto"),
            Some("0"),
            Some("initial"),
            Some("unset"),
            Some("inherit"),
            Some("invalid"),
        ] {
            let mut child = node(&format!("{value:?}"), &[]);
            if let Some(value) = value {
                child.computed_style.insert("z-index".into(), value.into());
                child.computed_style.insert(
                    "isolation".into(),
                    if value == "inherit" {
                        "inherit"
                    } else {
                        "auto"
                    }
                    .into(),
                );
            }
            root.children.push(child);
        }
        apply_tree(&mut root).unwrap();
        assert_eq!(root.style.unwrap().z_index, Some(7));
        assert_eq!(root.computed_style["z-index"], "7");
        assert!(root.style.unwrap().isolation);
        assert_eq!(
            root.children
                .iter()
                .map(|child| child.style.unwrap().z_index)
                .collect::<Vec<_>>(),
            [None, None, Some(0), None, None, Some(7), None]
        );
        assert!(!root.children[0].computed_style.contains_key("z-index"));
        assert_eq!(root.children[1].computed_style["z-index"], "auto");
        assert_eq!(root.children[2].computed_style["z-index"], "0");
        assert!(root.children[5].style.unwrap().isolation);
        assert_eq!(root.children[5].computed_style["isolation"], "isolate");
        assert!(root
            .children
            .iter()
            .enumerate()
            .all(|(index, child)| index == 5 || !child.style.unwrap().isolation));
    }

    #[test]
    fn static_blocks_preserve_computed_integer_for_explicit_inherit() {
        let mut root = node("static", &[("z-index", "-3")]);
        root.children.push(node("child", &[("z-index", "inherit")]));
        apply_tree(&mut root).unwrap();
        assert_eq!(root.style.unwrap().position, PositionMode::Static);
        assert_eq!(root.style.unwrap().z_index, Some(-3));
        assert_eq!(root.children[0].style.unwrap().z_index, Some(-3));
        assert_eq!(root.children[0].computed_style["z-index"], "-3");
        assert_eq!(root.z_index, -3);
    }

    #[test]
    fn initial_values_are_not_inherited_and_legacy_subtrees_are_untouched() {
        let mut root = node("root", &[("z-index", "3"), ("isolation", "isolate")]);
        for value in ["initial", "unset", "auto", "bad"] {
            root.children
                .push(node(value, &[("z-index", value), ("isolation", value)]));
        }
        let mut legacy = RenderNode::new("legacy", BOUNDS);
        legacy.z_index = 9;
        legacy
            .computed_style
            .insert("z-index".into(), "calc(1)".into());
        legacy.style = Some(LayoutStyle::default());
        root.children.push(legacy.clone());
        apply_tree(&mut root).unwrap();
        assert!(
            root.children[..4]
                .iter()
                .all(|child| child.style.unwrap().z_index.is_none()
                    && !child.style.unwrap().isolation)
        );
        assert_eq!(root.children[4], legacy);
    }

    #[test]
    fn valid_unsupported_values_fail_instead_of_becoming_an_automatic_context() {
        for (property, value) in [
            ("z-index", "2147483648"),
            ("z-index", "calc(1 + 2)"),
            ("z-index", "var(--layer)"),
            ("isolation", "var(--boundary)"),
            ("isolation", "revert-layer"),
            ("mix-blend-mode", "multiply"),
            ("contain", "paint layout"),
            ("will-change", "opacity, transform"),
            ("perspective", "100px"),
        ] {
            let mut node = node("unsupported", &[(property, value)]);
            let error = apply_tree(&mut node).unwrap_err();
            assert_eq!(
                error.code,
                BridgeErrorCode::UnsupportedCapability,
                "{property}:{value}"
            );
            assert!(error.message.contains(property), "{error:?}");
        }
    }

    #[test]
    fn reliable_effect_grammars_distinguish_initial_inherit_and_invalid_values() {
        let mut root = node(
            "root",
            &[
                ("mix-blend-mode", "inherit"),
                ("contain", "initial"),
                ("will-change", "unset"),
                ("perspective", "none"),
            ],
        );
        root.children.push(node(
            "invalid",
            &[
                ("mix-blend-mode", "not-a-mode"),
                ("contain", "size inline-size"),
                ("will-change", "opacity transform"),
                ("perspective", "-1px"),
            ],
        ));
        apply_tree(&mut root).unwrap();
        for (property, initial) in EFFECTS {
            assert_eq!(root.computed_style[*property], *initial);
        }
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    mod native {
        use super::*;
        use crate::{Session, SessionConfig};
        use container_bridge::{op, BridgeEnvelope};
        use container_core::EngineKind;
        use container_ir::{
            hex_digest, parse_wxml, parse_wxss, ContainerManifestV1, Module, ModuleFormat,
            ModuleScope, Route, RouteKind, Style, StyleScope, Template,
        };
        use container_render_skia::{RenderFrame, Renderer};
        use serde_json::{json, Value};
        use std::collections::BTreeMap;

        const SESSION: &str = "typed-stacking-runtime";
        const TEMPLATE: &str = "template:pages/index/index.wxml";
        const PAGE: &str = "module:pages/index/index.js";
        const PAGE_JS: &str = r#"var page;
Page({data:{z:'auto',isolation:'auto',transform:'none'},onLoad:function(){page=this;}});
exports.patch=function(data){page.setData(data);};"#;

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
        }

        impl Fixture {
            fn new(engine: EngineKind, markup: &str, styles: &str) -> Self {
                let mut manifest = ContainerManifestV1::default();
                manifest.compiler.commit = "local-stacking-runtime-contract".into();
                manifest.app.app_json = "app.json".into();
                manifest.app.entry_module = "app.js".into();
                manifest.routes.push(Route {
                    id: "route:index".into(),
                    path: "pages/index/index".into(),
                    kind: RouteKind::Page,
                    config: None,
                    entry_module: "pages/index/index.js".into(),
                });
                let mut modules = Vec::new();
                for (id, source, scope) in [
                    ("module:app.js", "App({});", ModuleScope::App),
                    (PAGE, PAGE_JS, ModuleScope::Page),
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
                let template = parse_wxml(markup).unwrap().canonical_json().unwrap();
                let template_pointer = format!("sha256:{}", hex_digest(&template));
                let style = parse_wxss(&format!("page{{background:white}}{styles}"))
                    .unwrap()
                    .canonical_json()
                    .unwrap();
                let style_pointer = format!("sha256:{}", hex_digest(&style));
                manifest.templates.push(Template {
                    id: TEMPLATE.into(),
                    wxml_ast: template_pointer.clone(),
                    bindings: vec!["z".into(), "isolation".into(), "transform".into()],
                    wxs_modules: BTreeMap::new(),
                });
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
                };
                let blobs = BTreeMap::from([(template_pointer, template), (style_pointer, style)]);
                let init = fixture.ok(op::APP_INIT, json!({"modules":modules,"blobs":blobs}));
                assert_eq!(init["engineProviderAvailable"], true, "{engine:?}");
                fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
                fixture.ok(op::PAGE_PUSH, json!({"path":"pages/index/index"}));
                let result = fixture.refresh();
                assert_eq!(result["ok"], true, "{engine:?}: {result}");
                fixture
            }

            fn request(&mut self, operation: &str, payload: Value) -> Value {
                self.sequence += 1;
                self.session
                    .dispatch(BridgeEnvelope::request(
                        SESSION,
                        format!("stacking-{}", self.sequence),
                        operation,
                        payload,
                    ))
                    .messages[0]
                    .payload
                    .clone()
            }

            fn ok(&mut self, operation: &str, payload: Value) -> Value {
                let result = self.request(operation, payload);
                assert_eq!(result["ok"], true, "{operation}: {result}");
                result
            }

            fn refresh(&mut self) -> Value {
                self.request(op::RENDER_COMMIT, json!({"templateId":TEMPLATE,"frameId":self.sequence+1,"useSessionResources":true,"viewport":{"width":64,"height":64}}))
            }

            fn patch(&mut self, patch: Value) -> Value {
                self.ok(
                    op::MODULE_CALL,
                    json!({"moduleId":PAGE,"export":"patch","args":[patch]}),
                );
                self.refresh()
            }

            fn frame(&self) -> &RenderFrame {
                self.session.renderer().last_frame().unwrap()
            }

            fn node(&self, id: &str) -> &RenderNode {
                fn find<'a>(node: &'a RenderNode, id: &str) -> Option<&'a RenderNode> {
                    if node.id == id {
                        Some(node)
                    } else {
                        node.children.iter().find_map(|child| find(child, id))
                    }
                }
                find(&self.frame().root, id).unwrap()
            }

            fn check(&self, rgba: [u8; 4], target: &str) {
                let snapshot = self.session.renderer().snapshot().unwrap();
                let offset = snapshot.stride as usize * 4 + 4 * 4;
                assert_eq!(&snapshot.pixels[offset..offset + 4], &rgba);
                assert_eq!(self.frame().root.hit_test(4.5, 4.5).unwrap().id, target);
            }
        }

        #[test]
        fn real_page_bindings_keep_auto_zero_isolation_and_transform_contexts_distinct() {
            for engine in engines() {
                let mut fixture = Fixture::new(engine,
                    "<view class='row'><view id='item' style='z-index:{{z}};isolation:{{isolation}};transform:{{transform}}'><view id='raised'/></view></view><view id='peer'/>",
                    ".row{display:flex;width:40px;height:40px} #item{width:40px;height:40px;flex-shrink:0} #raised{position:absolute;left:0;top:0;width:20px;height:20px;background:red;z-index:2} #peer{position:absolute;left:0;top:0;width:20px;height:20px;background:blue;z-index:1}");
                assert_eq!(fixture.node("item").style.unwrap().z_index, None);
                fixture.check([255, 0, 0, 255], "raised");
                for patch in [
                    json!({"z":"0"}),
                    json!({"z":"auto","isolation":"isolate"}),
                    json!({"isolation":"auto","transform":"translateX(0px)"}),
                ] {
                    let result = fixture.patch(patch);
                    assert_eq!(result["ok"], true, "{engine:?}: {result}");
                    fixture.check([0, 0, 255, 255], "peer");
                }
                let result =
                    fixture.patch(json!({"z":"auto","isolation":"auto","transform":"none"}));
                assert_eq!(result["ok"], true);
                fixture.check([255, 0, 0, 255], "raised");
                for patch in [
                    json!({"z":"calc(1 + 2)"}),
                    json!({"z":"auto","isolation":"var(--boundary)"}),
                ] {
                    let accepted = fixture.frame().clone();
                    let pixels = fixture.session.renderer().snapshot();
                    let view = fixture.session.view().last_frame_id;
                    let result = fixture.patch(patch);
                    assert_eq!(
                        result["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
                        "{engine:?}: {result}"
                    );
                    assert_eq!(fixture.frame(), &accepted);
                    assert_eq!(fixture.session.renderer().snapshot(), pixels);
                    assert_eq!(fixture.session.view().last_frame_id, view);
                    fixture.check([255, 0, 0, 255], "raised");
                }
            }
        }

        #[test]
        fn real_static_blocks_ignore_stack_level_but_preserve_computed_inheritance() {
            for engine in engines() {
                let fixture = Fixture::new(engine,
                    "<view id='first'><view id='inherited'/></view><view id='second'/>",
                    "#first{width:40px;height:40px;background:red;z-index:9} #inherited{z-index:inherit} #second{width:40px;height:40px;margin-top:-40px;background:blue}");
                assert_eq!(
                    fixture.node("first").style.unwrap().position,
                    PositionMode::Static
                );
                assert_eq!(fixture.node("first").style.unwrap().z_index, Some(9));
                assert_eq!(fixture.node("inherited").style.unwrap().z_index, Some(9));
                assert_eq!(fixture.node("inherited").computed_style["z-index"], "9");
                fixture.check([0, 0, 255, 255], "second");
            }
        }
    }
}
