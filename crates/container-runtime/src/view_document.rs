//! Pure projection of evaluated WXML and verified style IR, before layout.
use super::{components::RenderOwnership, keyed_wxml_path_segment, lookup_render_blob};
use container_bridge::{BridgeError, BridgeErrorCode};
use container_ir::{
    decode_wxss, ContainerManifestV1, StyleScope, ViewDocument, ViewEventBinding, ViewEventPhase,
    ViewNode, ViewOwnership, ViewStyleSheet, WxmlAst, WxmlNode, WxssIr, WxssRule,
    VIEW_DOCUMENT_VERSION,
};
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct ViewDocumentInput<'a> {
    pub ast: &'a WxmlAst,
    pub ownership: &'a BTreeMap<String, RenderOwnership>,
    pub manifest: &'a ContainerManifestV1,
    pub blobs: &'a BTreeMap<String, Vec<u8>>,
    pub style_roots: &'a [String],
    pub session_id: &'a str,
    pub page_id: u64,
    pub revision: u64,
    pub route_path: &'a str,
}

fn error(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Render, message)
}

/// No expressions, lifecycle hooks, image decoding or geometry work occurs
/// here. The caller publishes the result only after its render transaction.
pub(super) fn project_view_document(
    input: ViewDocumentInput<'_>,
) -> Result<ViewDocument, BridgeError> {
    let mut projection = Projection {
        input: &input,
        component_documents: BTreeMap::new(),
        node_count: 0,
    };
    let nodes = projection.nodes(&input.ast.nodes, "", 0)?;
    let (style_roots, styles) = project_styles(&input, &projection.component_documents)?;
    let document = ViewDocument {
        version: VIEW_DOCUMENT_VERSION.into(),
        session_id: input.session_id.into(),
        page_id: input.page_id,
        revision: input.revision,
        route_path: input.route_path.into(),
        profile: input.manifest.renderer_profile_for_route(input.route_path),
        nodes,
        style_roots,
        styles,
        resources: input.manifest.assets.clone(),
    };
    document
        .validate()
        .map_err(|cause| error(cause.to_string()))?;
    Ok(document)
}

struct Projection<'a, 'b> {
    input: &'a ViewDocumentInput<'b>,
    component_documents: BTreeMap<String, String>,
    node_count: usize,
}

impl Projection<'_, '_> {
    fn register_component(
        &mut self,
        scope: &str,
        document: Option<&str>,
    ) -> Result<(), BridgeError> {
        let document = document
            .ok_or_else(|| error(format!("component scope {scope} has no resolved document")))?;
        let document = document
            .strip_prefix("template:")
            .unwrap_or(document)
            .to_owned();
        if !self
            .input
            .manifest
            .templates
            .iter()
            .any(|template| template.id == format!("template:{document}"))
        {
            return Err(error(format!(
                "component scope {scope} has no declared template"
            )));
        }
        if self
            .component_documents
            .insert(scope.into(), document.clone())
            .is_some_and(|previous| previous != document)
        {
            return Err(error("component scope has conflicting declaration owners"));
        }
        Ok(())
    }

    fn nodes(
        &mut self,
        nodes: &[WxmlNode],
        parent: &str,
        depth: usize,
    ) -> Result<Vec<ViewNode>, BridgeError> {
        if depth > 256 {
            return Err(error("ViewDocument tree depth exceeded"));
        }
        let mut output = Vec::new();
        for (index, node) in nodes.iter().enumerate() {
            self.node_count += 1;
            if self.node_count > 100_000 {
                return Err(error("ViewDocument node budget exceeded"));
            }
            let segment = match node {
                WxmlNode::Element {
                    key: Some(key),
                    key_scope,
                    ..
                } => keyed_wxml_path_segment(key_scope.as_deref(), key),
                _ => index.to_string(),
            };
            let path = if parent.is_empty() {
                segment
            } else {
                format!("{parent}.{segment}")
            };
            let source_owner = self.input.ownership.get(&path);
            if let Some(owner) = source_owner {
                if let Some(scope) = &owner.event_owner {
                    self.register_component(scope, owner.event_owner_document.as_deref())?;
                }
                if let Some(scope) = &owner.component_scope {
                    self.register_component(scope, owner.component_document.as_deref())?;
                }
            }
            let document_id = node
                .lexical_origin()
                .map(|origin| origin.document_id.clone())
                .or_else(|| {
                    source_owner.map(|owner| {
                        owner
                            .template
                            .strip_prefix("template:")
                            .unwrap_or(&owner.template)
                            .to_owned()
                    })
                })
                .unwrap_or_else(|| format!("{}.wxml", self.input.route_path));
            let ownership = ViewOwnership {
                event_owner: source_owner.and_then(|owner| owner.event_owner.clone()),
                component_scope: source_owner.and_then(|owner| owner.component_scope.clone()),
                slot_owner: None,
                document_id,
            };
            match node {
                WxmlNode::Comment { .. } => {}
                WxmlNode::Text { value, .. } => output.push(ViewNode::Text {
                    occurrence_id: format!("event:{path}"),
                    value: value.clone(),
                    ownership,
                }),
                WxmlNode::Element {
                    tag,
                    attrs,
                    bound_values,
                    key,
                    children,
                    ..
                } => {
                    let children = self.nodes(children, &path, depth + 1)?;
                    if tag == "block" {
                        output.extend(children);
                        continue;
                    }
                    output.push(ViewNode::Element {
                        occurrence_id: format!("event:{path}"),
                        tag: tag.clone(),
                        attrs: attrs.clone(),
                        typed_attrs: bound_values.clone(),
                        key: key.clone(),
                        ownership,
                        events: event_bindings(attrs),
                        children,
                    });
                }
            }
        }
        Ok(output)
    }
}

fn event_bindings(attrs: &BTreeMap<String, String>) -> Vec<ViewEventBinding> {
    let mut candidates = BTreeSet::new();
    for name in attrs.keys() {
        for (prefix, capture) in [
            ("capture-catch", true),
            ("capture-bind", true),
            ("catch", false),
            ("bind", false),
        ] {
            let Some(suffix) = name.strip_prefix(prefix) else {
                continue;
            };
            let event = suffix.strip_prefix(':').unwrap_or(suffix);
            if event.is_empty()
                || (!suffix.starts_with(':')
                    && !event
                        .chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_'))
            {
                continue;
            }
            candidates.insert((event.to_owned(), capture));
        }
    }
    candidates
        .into_iter()
        .filter_map(|(event, capture)| {
            let prefix = if capture { "capture-" } else { "" };
            for (kind, catches) in [("catch", true), ("bind", false)] {
                for separator in ["", ":"] {
                    if separator.is_empty()
                        && !event
                            .chars()
                            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
                    {
                        continue;
                    }
                    if let Some(handler) = attrs
                        .get(&format!("{prefix}{kind}{separator}{event}"))
                        .map(|value| value.trim())
                        .filter(|value| !value.is_empty())
                    {
                        return Some(ViewEventBinding {
                            event,
                            handler: handler.into(),
                            phase: if capture {
                                ViewEventPhase::Capture
                            } else {
                                ViewEventPhase::Bubble
                            },
                            catch: catches,
                        });
                    }
                }
            }
            None
        })
        .collect()
}

fn stylesheet_imports(ir: &WxssIr) -> Result<Vec<String>, BridgeError> {
    fn visit(
        rules: &[WxssRule],
        output: &mut Vec<String>,
        depth: usize,
    ) -> Result<(), BridgeError> {
        if depth > 128 {
            return Err(error("ViewDocument stylesheet depth exceeded"));
        }
        for rule in rules {
            if let Some(prelude) = &rule.at_rule {
                let value = prelude.trim().strip_prefix('@').unwrap_or("");
                let end = value
                    .find(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-' && ch != '_')
                    .unwrap_or(value.len());
                if value[..end].eq_ignore_ascii_case("import") {
                    output.push(super::styles::parse_import(value[end..].trim())?.0.into());
                }
            }
            visit(&rule.nested, output, depth + 1)?;
        }
        Ok(())
    }
    let mut output = ir
        .imports
        .iter()
        .map(|prelude| {
            super::styles::parse_import(prelude).map(|(reference, _)| reference.to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    visit(&ir.rules, &mut output, 0)?;
    Ok(output)
}

fn project_styles(
    input: &ViewDocumentInput<'_>,
    components: &BTreeMap<String, String>,
) -> Result<(Vec<String>, Vec<ViewStyleSheet>), BridgeError> {
    let records = input
        .manifest
        .styles
        .iter()
        .map(|style| (style.id.clone(), style))
        .collect::<BTreeMap<_, _>>();
    let mut selected_roots = Vec::new();
    let mut pending = Vec::new();
    let component_styles = input
        .manifest
        .components
        .iter()
        .flat_map(|entry| entry.using_components.values())
        .flat_map(|target| {
            let target = target.strip_suffix(".wxml").unwrap_or(target);
            [
                format!("style:{target}.wxss"),
                format!("style:{target}/index.wxss"),
            ]
        })
        .collect::<BTreeSet<_>>();
    for id in input.style_roots {
        let record = records.get(id).ok_or_else(|| {
            error(format!(
                "ViewDocument stylesheet root is not declared: {id}"
            ))
        })?;
        let scopes = components
            .iter()
            .filter(|(_, document)| {
                format!(
                    "style:{}.wxss",
                    document.strip_suffix(".wxml").unwrap_or(document)
                ) == *id
            })
            .map(|(scope, _)| Some(scope.clone()))
            .collect::<Vec<_>>();
        if record.scope == StyleScope::Component || component_styles.contains(id) {
            if scopes.is_empty() {
                continue;
            }
            for scope in scopes {
                pending.push((id.clone(), scope));
            }
        } else {
            pending.push((id.clone(), None));
        }
        selected_roots.push(id.clone());
    }
    let mut selected = BTreeMap::new();
    let mut bytes_read = 0usize;
    while let Some((id, scope)) = pending.pop() {
        if selected.contains_key(&(id.clone(), scope.clone())) {
            continue;
        }
        if selected.len() >= 16_384 {
            return Err(error("ViewDocument stylesheet count exceeded"));
        }
        let record = records.get(&id).ok_or_else(|| {
            error(format!(
                "ViewDocument imported stylesheet is not declared: {id}"
            ))
        })?;
        let bytes = lookup_render_blob(input.blobs, &record.wxss_ir)?;
        bytes_read = bytes_read
            .checked_add(bytes.len())
            .filter(|size| *size <= 32 * 1024 * 1024)
            .ok_or_else(|| error("ViewDocument stylesheet byte budget exceeded"))?;
        let ir = decode_wxss(bytes).map_err(|cause| error(cause.to_string()))?;
        for reference in stylesheet_imports(&ir)? {
            let owner = id
                .strip_prefix("style:")
                .ok_or_else(|| error("invalid stylesheet id"))?;
            let path = super::styles::resolve_path(owner, &reference)?;
            let target = format!("style:{path}");
            // A raw conditional import can legitimately be inactive for the
            // accepted Rust render. Preserve its reference without inventing
            // a sheet, or evaluating browser conditions in this projection.
            if records.contains_key(&target) {
                pending.push((target, scope.clone()));
            }
        }
        selected.insert(
            (id.clone(), scope.clone()),
            ViewStyleSheet {
                id,
                scope_id: scope,
                ir,
            },
        );
    }
    Ok((selected_roots, selected.into_values().collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_ir::{parse_wxml, parse_wxss, RendererProfile, RendererProfiles, Style};
    use serde_json::json;

    fn add_style(
        manifest: &mut ContainerManifestV1,
        blobs: &mut BTreeMap<String, Vec<u8>>,
        path: &str,
        source: &str,
        scope: StyleScope,
    ) -> String {
        let bytes = parse_wxss(source).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", container_ir::hex_digest(&bytes));
        let id = format!("style:{path}");
        manifest.styles.push(Style {
            id: id.clone(),
            wxss_ir: pointer.clone(),
            scope,
        });
        blobs.insert(pointer, bytes);
        id
    }

    fn project(
        ast: &WxmlAst,
        ownership: &BTreeMap<String, RenderOwnership>,
        manifest: &ContainerManifestV1,
        blobs: &BTreeMap<String, Vec<u8>>,
        roots: &[String],
    ) -> Result<ViewDocument, BridgeError> {
        project_view_document(ViewDocumentInput {
            ast,
            ownership,
            manifest,
            blobs,
            style_roots: roots,
            session_id: "test",
            page_id: 1,
            revision: 2,
            route_path: "page",
        })
    }

    #[test]
    fn event_policy_matches_runtime_precedence_and_preserves_capture() {
        let attrs = BTreeMap::from([
            ("bindtap".into(), "ignored".into()),
            ("catch:tap".into(), "colon".into()),
            ("catchtap".into(), "compact".into()),
            ("capture-bind:tap".into(), "capture".into()),
            ("bind:my-event".into(), "custom".into()),
            ("bindmy-event".into(), "invalid".into()),
        ]);
        let bindings = event_bindings(&attrs);
        assert_eq!(bindings.len(), 3);
        assert!(bindings
            .iter()
            .any(|event| event.event == "tap" && event.handler == "compact" && event.catch));
        assert!(bindings
            .iter()
            .any(|event| event.handler == "capture" && event.phase == ViewEventPhase::Capture));
        assert!(bindings
            .iter()
            .any(|event| event.event == "my-event" && event.handler == "custom"));
    }

    #[test]
    fn projection_keeps_typed_values_key_identity_and_raw_conditional_styles() {
        let mut manifest = ContainerManifestV1 {
            rendering: Some(RendererProfiles {
                default: RendererProfile::WebView,
                ..RendererProfiles::default()
            }),
            ..ContainerManifestV1::default()
        };
        let mut ast =
            parse_wxml("<block><view data-value='false'>{{literal}}</view></block>").unwrap();
        if let WxmlNode::Element { children, .. } = &mut ast.nodes[0] {
            if let WxmlNode::Element {
                bound_values,
                key,
                key_scope,
                ..
            } = &mut children[0]
            {
                bound_values.insert("data-value".into(), json!({"value": false}));
                *key = Some("stable".into());
                *key_scope = Some("loop".into());
            }
        }
        let ir = parse_wxss("@media (min-width: 500px) { view { width: 10rpx } }").unwrap();
        let bytes = ir.canonical_json().unwrap();
        let pointer = format!("sha256:{}", container_ir::hex_digest(&bytes));
        manifest.styles.push(Style {
            id: "style:app.wxss".into(),
            wxss_ir: pointer.clone(),
            scope: StyleScope::App,
        });
        // An unrelated declared stylesheet needs no blob for this document.
        manifest.styles.push(Style {
            id: "style:other.wxss".into(),
            wxss_ir: format!("sha256:{}", "a".repeat(64)),
            scope: StyleScope::Page,
        });
        let blobs = BTreeMap::from([(pointer, bytes)]);
        let roots = vec!["style:app.wxss".into()];
        let ownership = BTreeMap::new();
        let result = project_view_document(ViewDocumentInput {
            ast: &ast,
            ownership: &ownership,
            manifest: &manifest,
            blobs: &blobs,
            style_roots: &roots,
            session_id: "test",
            page_id: 1,
            revision: 2,
            route_path: "page",
        })
        .unwrap();
        assert_eq!(result.nodes.len(), 1);
        assert_eq!(
            result.nodes[0].occurrence_id(),
            format!(
                "event:0.{}",
                keyed_wxml_path_segment(Some("loop"), "stable")
            )
        );
        assert_eq!(result.styles[0].ir, ir);
        let ViewNode::Element {
            typed_attrs,
            children,
            ..
        } = &result.nodes[0]
        else {
            panic!("element")
        };
        assert_eq!(typed_attrs["data-value"], json!({"value": false}));
        let ViewNode::Text { value, .. } = &children[0] else {
            panic!("text")
        };
        assert_eq!(
            value, "{{literal}}",
            "projection never evaluates text again"
        );
    }

    #[test]
    fn scoped_styles_follow_resolved_owners_and_imports_without_unscoped_copies() {
        let ast = parse_wxml("<card><view/></card><view/>").unwrap();
        let component = "template:widgets/card.wxml";
        let mut manifest = ContainerManifestV1::default();
        manifest.templates.push(container_ir::Template {
            id: component.into(),
            wxml_ast: format!("sha256:{}", "a".repeat(64)),
            bindings: Vec::new(),
            wxs_modules: BTreeMap::new(),
        });
        let ownership = BTreeMap::from([
            (
                "0".into(),
                RenderOwnership {
                    component_scope: Some("first".into()),
                    component_document: Some(component.into()),
                    template: "shared/imported.wxml".into(),
                    ..RenderOwnership::default()
                },
            ),
            (
                "0.0".into(),
                RenderOwnership {
                    event_owner: Some("first".into()),
                    event_owner_document: Some(component.into()),
                    template: "shared/body.wxml".into(),
                    ..RenderOwnership::default()
                },
            ),
            // A declarative component no longer has a physical host node.
            (
                "1".into(),
                RenderOwnership {
                    event_owner: Some("second".into()),
                    event_owner_document: Some(component.into()),
                    template: "shared/body.wxml".into(),
                    ..RenderOwnership::default()
                },
            ),
        ]);
        let mut blobs = BTreeMap::new();
        let app = add_style(
            &mut manifest,
            &mut blobs,
            "app.wxss",
            "page { color: black }",
            StyleScope::App,
        );
        let card = add_style(
            &mut manifest,
            &mut blobs,
            "widgets/card.wxss",
            "@import'../shared/theme.css'; view { color: red }",
            StyleScope::Component,
        );
        add_style(
            &mut manifest,
            &mut blobs,
            "shared/theme.css",
            "@media (min-width: 600px) { view { color: blue } }",
            StyleScope::Page,
        );
        let hidden = add_style(
            &mut manifest,
            &mut blobs,
            "widgets/hidden.wxss",
            "view { color: green }",
            StyleScope::Component,
        );
        let result = project(
            &ast,
            &ownership,
            &manifest,
            &blobs,
            &[app.clone(), card.clone(), hidden],
        )
        .unwrap();
        assert_eq!(result.style_roots, [app, card]);
        assert_eq!(result.styles.len(), 5);
        for scope in ["first", "second"] {
            for path in ["widgets/card.wxss", "shared/theme.css"] {
                assert!(result
                    .styles
                    .iter()
                    .any(|sheet| sheet.id == format!("style:{path}")
                        && sheet.scope_id.as_deref() == Some(scope)));
            }
        }
        assert_eq!(
            result
                .styles
                .iter()
                .filter(|sheet| sheet.scope_id.is_none())
                .count(),
            1
        );
        let ViewNode::Element {
            children,
            ownership,
            ..
        } = &result.nodes[0]
        else {
            panic!("component host")
        };
        assert_eq!(ownership.document_id, "shared/imported.wxml");
        assert_eq!(
            children[0].ownership().event_owner.as_deref(),
            Some("first")
        );
        assert!(
            children[0].ownership().slot_owner.is_none(),
            "slot origin cannot be guessed from ancestry"
        );
    }

    #[test]
    fn raw_styles_keep_inactive_unresolved_imports_but_verify_declared_blobs() {
        let ast = parse_wxml("<view/>").unwrap();
        let mut manifest = ContainerManifestV1::default();
        let mut blobs = BTreeMap::new();
        let root = add_style(
            &mut manifest,
            &mut blobs,
            "app.wxss",
            "@import './unavailable.wxss' print; view { color: red }",
            StyleScope::App,
        );
        let result = project(
            &ast,
            &BTreeMap::new(),
            &manifest,
            &blobs,
            std::slice::from_ref(&root),
        )
        .unwrap();
        assert_eq!(
            stylesheet_imports(&result.styles[0].ir).unwrap(),
            ["./unavailable.wxss"]
        );
        assert_eq!(result.styles.len(), 1);
        manifest.styles.push(Style {
            id: "style:unavailable.wxss".into(),
            wxss_ir: format!("sha256:{}", "a".repeat(64)),
            scope: StyleScope::Page,
        });
        assert!(project(&ast, &BTreeMap::new(), &manifest, &blobs, &[root]).is_err());
    }

    #[test]
    fn ambiguous_or_missing_component_documents_fail_instead_of_widening_scope() {
        let ast = parse_wxml("<card/>").unwrap();
        let ownership = BTreeMap::from([(
            "0".into(),
            RenderOwnership {
                component_scope: Some("first".into()),
                template: "page.wxml".into(),
                ..RenderOwnership::default()
            },
        )]);
        let error = project(
            &ast,
            &ownership,
            &ContainerManifestV1::default(),
            &BTreeMap::new(),
            &[],
        )
        .unwrap_err();
        assert!(error.message.contains("no resolved document"));
    }
}
