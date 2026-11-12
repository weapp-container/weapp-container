//! Shared development reload policy for verified portable packs.
//!
//! Native SDKs and simulator surfaces use this same conservative classifier.
//! Template changes that can rerun retained View state or remount components
//! require a fresh runtime; presentation-only replacements may retain state.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DevReloadKind {
    InPlace,
    Restart,
}

impl crate::Session {
    /// A failed AppService or isolated View turn cannot safely reuse its JS
    /// heap, including when a reload supplies exactly the same portable pack.
    pub fn requires_dev_restart(&self) -> bool {
        self.engine_execution_is_faulted()
            || self.view_execution_is_faulted()
            || self.navigation_requires_restart()
    }
}

pub fn classify_manifest_reload(
    previous: &container_ir::ContainerManifestV1,
    next: &container_ir::ContainerManifestV1,
) -> DevReloadKind {
    if previous.can_replace_presentation_with(next) {
        DevReloadKind::InPlace
    } else {
        DevReloadKind::Restart
    }
}

pub fn classify_pack_reload(
    previous: &container_ir::ContainerManifestV1,
    previous_blobs: &std::collections::BTreeMap<String, Vec<u8>>,
    next: &container_ir::ContainerManifestV1,
    next_blobs: &std::collections::BTreeMap<String, Vec<u8>>,
) -> DevReloadKind {
    if classify_manifest_reload(previous, next) == DevReloadKind::InPlace
        && !requires_view_script_restart(previous, previous_blobs, next, next_blobs)
        && !requires_component_restart(previous, previous_blobs, next, next_blobs)
    {
        DevReloadKind::InPlace
    } else {
        DevReloadKind::Restart
    }
}

use container_ir::{decode_wxml, ContainerManifestV1, ModuleScope};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Legacy v1 packs can contain inline WXS without a module table. Inspect
/// executable declarations before the component-only safety check, including
/// documents that have no custom components. Any changed document can execute
/// retained View module state again; without a heap fork it starts a fresh
/// session even when the WXS declaration itself is unchanged.
pub fn requires_view_script_restart(
    previous: &ContainerManifestV1,
    previous_blobs: &BTreeMap<String, Vec<u8>>,
    next: &ContainerManifestV1,
    next_blobs: &BTreeMap<String, Vec<u8>>,
) -> bool {
    let documents = |manifest: &ContainerManifestV1, blobs: &BTreeMap<String, Vec<u8>>| {
        manifest
            .templates
            .iter()
            .map(|template| {
                let bytes = blobs.get(&template.wxml_ast)?;
                let ast = decode_wxml(bytes).ok()?;
                let value = serde_json::from_slice::<Value>(bytes)
                    .ok()
                    .or_else(|| serde_json::to_value(ast).ok())?;
                let mut scripts = Vec::new();
                collect_wxs(value.get("nodes")?.as_array()?, &mut scripts);
                Some((template.id.clone(), (template.wxml_ast.clone(), scripts)))
            })
            .collect::<Option<BTreeMap<_, _>>>()
    };
    match (
        documents(previous, previous_blobs),
        documents(next, next_blobs),
    ) {
        (Some(previous), Some(next)) => {
            let has_scripts = previous
                .values()
                .chain(next.values())
                .any(|(_, scripts)| !scripts.is_empty());
            has_scripts && previous != next
        }
        _ => true,
    }
}

fn collect_wxs(nodes: &[Value], scripts: &mut Vec<Value>) {
    for node in nodes {
        if node.get("kind").and_then(Value::as_str) != Some("element") {
            continue;
        }
        if node.get("tag").and_then(Value::as_str) == Some("wxs") {
            // Preserve unknown IR fields rather than dropping future execution
            // inputs during typed decoding.
            scripts.push(node.clone());
        } else if let Some(children) = node.get("children").and_then(Value::as_array) {
            collect_wxs(children, scripts);
        }
    }
}

/// A structural/input edit is started in an isolated candidate session before
/// publication. Presentation-only edits can retain the existing component heap.
pub fn requires_component_restart(
    previous: &ContainerManifestV1,
    previous_blobs: &BTreeMap<String, Vec<u8>>,
    next: &ContainerManifestV1,
    next_blobs: &BTreeMap<String, Vec<u8>>,
) -> bool {
    let component_module = previous
        .modules
        .iter()
        .chain(&next.modules)
        .any(|module| module.scope == ModuleScope::Component);
    let component_reference = previous
        .components
        .iter()
        .chain(&next.components)
        .any(|component| !component.using_components.is_empty());
    if !component_module && !component_reference {
        return false;
    }
    let previous_templates = previous
        .templates
        .iter()
        .map(|template| (template.id.as_str(), template.wxml_ast.as_str()))
        .collect::<BTreeMap<_, _>>();
    let next_templates = next
        .templates
        .iter()
        .map(|template| (template.id.as_str(), template.wxml_ast.as_str()))
        .collect::<BTreeMap<_, _>>();
    if previous_templates.keys().ne(next_templates.keys()) {
        return true;
    }
    previous_templates
        .into_iter()
        .any(|(id, previous_pointer)| {
            let next_pointer = next_templates[id];
            if previous_pointer == next_pointer {
                return false;
            }
            let previous_fingerprint = previous_blobs
                .get(previous_pointer)
                .and_then(|bytes| template_fingerprint(bytes, previous));
            let next_fingerprint = next_blobs
                .get(next_pointer)
                .and_then(|bytes| template_fingerprint(bytes, next));
            match (previous_fingerprint, next_fingerprint) {
                (Some(previous), Some(next)) => previous != next,
                _ => true,
            }
        })
}

fn template_fingerprint(bytes: &[u8], manifest: &ContainerManifestV1) -> Option<Value> {
    let ast = decode_wxml(bytes).ok()?;
    // Shared include/import fragments may be instantiated in a caller's
    // component namespace. Preserve tags declared anywhere in the pack rather
    // than treating a builtin shadowed by such a caller as presentation-only.
    let custom_tags = manifest
        .components
        .iter()
        .flat_map(|component| component.using_components.keys().cloned())
        .collect::<BTreeSet<_>>();
    // Keep unknown/new IR fields in the fingerprint. Only known harmless
    // presentation fields are removed, so evolving IR fails conservatively.
    let mut value = serde_json::from_slice::<Value>(bytes)
        .ok()
        .or_else(|| serde_json::to_value(ast).ok())?;
    for node in value.get_mut("nodes")?.as_array_mut()? {
        strip_presentation(node, &custom_tags);
    }
    Some(value)
}

fn strip_presentation(node: &mut Value, custom_tags: &BTreeSet<String>) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("text") => {
            object.remove("value");
            object.remove("bindings");
        }
        Some("comment") => {
            object.remove("value");
        }
        Some("element") => {
            let tag = object.get("tag").and_then(Value::as_str).unwrap_or("");
            // Inline WXS is executable source rather than display text.
            if tag == "wxs" {
                return;
            }
            let native = native_builtin(tag) && !custom_tags.contains(tag);
            if native {
                for key in ["attrs", "boundValues", "bound_values"] {
                    if let Some(attrs) = object.get_mut(key).and_then(Value::as_object_mut) {
                        attrs.retain(|name, _| !presentation_attribute(name));
                    }
                }
            }
            // Attribute and text expressions remain represented by their
            // source fields; this aggregate list is derived parser metadata.
            object.remove("bindings");
            if let Some(children) = object.get_mut("children").and_then(Value::as_array_mut) {
                for child in children {
                    strip_presentation(child, custom_tags);
                }
            }
        }
        _ => {}
    }
}

fn presentation_attribute(name: &str) -> bool {
    matches!(name, "style" | "class" | "id" | "hidden")
        || name.starts_with("data-")
        || name.starts_with("mark-")
        || name.starts_with("mark:")
}

fn native_builtin(tag: &str) -> bool {
    // Structural nodes (block/template/import/include/wxs/slot), registered
    // custom tags and unknown tags retain every attribute. A builtin can also
    // be shadowed by usingComponents, in which case its props are significant.
    matches!(
        tag,
        "view"
            | "text"
            | "button"
            | "image"
            | "scroll-view"
            | "swiper"
            | "swiper-item"
            | "movable-area"
            | "movable-view"
            | "cover-view"
            | "cover-image"
            | "icon"
            | "progress"
            | "rich-text"
            | "form"
            | "input"
            | "textarea"
            | "label"
            | "picker"
            | "picker-view"
            | "picker-view-column"
            | "checkbox"
            | "checkbox-group"
            | "radio"
            | "radio-group"
            | "slider"
            | "switch"
            | "navigator"
            | "audio"
            | "video"
            | "camera"
            | "live-player"
            | "live-pusher"
            | "map"
            | "canvas"
            | "web-view"
            | "ad"
            | "ad-custom"
            | "official-account"
            | "open-data"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_ir::{hex_digest, parse_wxml, Component, Module, ModuleFormat, Template};

    fn pack(source: &str) -> (ContainerManifestV1, BTreeMap<String, Vec<u8>>) {
        let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", hex_digest(&bytes));
        let manifest = ContainerManifestV1 {
            modules: vec![Module {
                id: "module:components/counter/index.js".into(),
                sha256: "0".repeat(64),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::Component,
                dependencies: vec![],
            }],
            components: vec![Component {
                id: "components:pages/home/index.json".into(),
                owner: "pages/home/index.json".into(),
                using_components: BTreeMap::from([(
                    "counter".into(),
                    "components/counter/index".into(),
                )]),
                multiple_slots: None,
            }],
            templates: vec![Template {
                id: "template:pages/home/index.wxml".into(),
                wxml_ast: pointer.clone(),
                bindings: vec![],
                wxs_modules: BTreeMap::new(),
            }],
            ..Default::default()
        };
        (manifest, BTreeMap::from([(pointer, bytes)]))
    }

    fn needs_restart(previous: &str, next: &str) -> bool {
        let (previous, previous_blobs) = pack(previous);
        let (next, next_blobs) = pack(next);
        requires_component_restart(&previous, &previous_blobs, &next, &next_blobs)
    }

    #[test]
    fn new_recursive_occurrence_and_structural_changes_restart() {
        for (previous, next) in [
            ("<view/>", "<view><counter/></view>"),
            // Appending even a builtin changes the structural fingerprint.
            // A browser smoke must not label this conservative restart in-place.
            ("<counter/>", "<counter/><text id=\"hot\">new</text>"),
            ("<counter/>", "<counter><counter/></counter>"),
            ("<view><counter/></view>", "<text><counter/></text>"),
            (
                "<view wx:if=\"{{old}}\"><counter/></view>",
                "<view wx:if=\"{{next}}\"><counter/></view>",
            ),
            ("<template is=\"a\"/>", "<template is=\"b\"/>"),
            ("<include src=\"a.wxml\"/>", "<include src=\"b.wxml\"/>"),
            ("<import src=\"a.wxml\"/>", "<import src=\"b.wxml\"/>"),
            (
                "<wxs module=\"util\">module.exports.value = 1</wxs>",
                "<wxs module=\"util\">module.exports.value = 2</wxs>",
            ),
        ] {
            assert!(needs_restart(previous, next), "{previous} -> {next}");
        }
    }

    #[test]
    fn custom_properties_and_presentation_named_props_restart() {
        for name in [
            "config",
            "class",
            "style",
            "id",
            "hidden",
            "data-value",
            "mark-value",
        ] {
            assert!(
                needs_restart(
                    &format!("<counter {name}=\"{{{{old}}}}\"/>"),
                    &format!("<counter {name}=\"{{{{next}}}}\"/>")
                ),
                "custom {name} is an input"
            );
        }
    }

    #[test]
    fn text_and_native_presentation_edits_preserve_the_heap() {
        assert!(!needs_restart(
            "<view class=\"a\" id=\"old\" style=\"color:red\" hidden=\"{{old}}\" data-x=\"old\" mark:label=\"old\"><text>{{old}}</text><counter config=\"{{config}}\"/></view>",
            "<view class=\"{{next}}\" id=\"new\" style=\"color:blue\" hidden=\"{{next}}\" data-x=\"next\" mark:label=\"next\"><text>Edited {{next}}</text><counter config=\"{{config}}\"/></view>"
        ));
        let (previous, previous_blobs) = pack("<counter/>");
        let mut next = previous.clone();
        next.styles.push(container_ir::Style {
            id: "style:changed.wxss".into(),
            wxss_ir: format!("sha256:{}", "1".repeat(64)),
            scope: container_ir::StyleScope::Page,
        });
        assert!(!requires_component_restart(
            &previous,
            &previous_blobs,
            &next,
            &previous_blobs
        ));
    }

    #[test]
    fn missing_new_or_invalid_template_is_conservative() {
        let (previous, previous_blobs) = pack("<counter/>");
        let (mut next, mut next_blobs) = pack("<counter config=\"new\"/>");
        let pointer = next.templates[0].wxml_ast.clone();
        next_blobs.insert(pointer.clone(), b"invalid WXML <".to_vec());
        assert!(requires_component_restart(
            &previous,
            &previous_blobs,
            &next,
            &next_blobs
        ));
        next_blobs.remove(&pointer);
        assert!(requires_component_restart(
            &previous,
            &previous_blobs,
            &next,
            &next_blobs
        ));
        next.templates.clear();
        assert!(requires_component_restart(
            &previous,
            &previous_blobs,
            &next,
            &next_blobs
        ));
        assert!(requires_component_restart(
            &next,
            &next_blobs,
            &previous,
            &previous_blobs
        ));
    }

    #[test]
    fn global_custom_tags_override_builtin_presentation_rules() {
        let (mut previous, previous_blobs) = pack("<view class=\"old\"/>");
        let (mut next, next_blobs) = pack("<view class=\"new\"/>");
        for manifest in [&mut previous, &mut next] {
            manifest.components.push(Component {
                id: "components:app.json".into(),
                owner: "app.json".into(),
                using_components: BTreeMap::from([(
                    "view".into(),
                    "components/custom-view/index".into(),
                )]),
                multiple_slots: None,
            });
        }
        assert!(requires_component_restart(
            &previous,
            &previous_blobs,
            &next,
            &next_blobs
        ));
    }

    #[test]
    fn packs_without_component_modules_or_references_keep_existing_classification() {
        let (mut previous, previous_blobs) = pack("<view/>");
        let (mut next, next_blobs) = pack("<view><counter/></view>");
        previous.modules.clear();
        next.modules.clear();
        previous.components.clear();
        next.components.clear();
        assert!(!requires_component_restart(
            &previous,
            &previous_blobs,
            &next,
            &next_blobs
        ));
        previous.modules = pack("<view/>").0.modules;
        assert!(requires_component_restart(
            &previous,
            &previous_blobs,
            &next,
            &next_blobs
        ));
    }

    #[test]
    fn legacy_inline_wxs_changes_restart_without_components() {
        let source = "<wxs module=\"util\">module.exports.value = 1</wxs><text>old</text>";
        for next in [
            "<wxs module=\"util\">module.exports.value = 2</wxs><text>old</text>",
            "<wxs module=\"renamed\">module.exports.value = 1</wxs><text>old</text>",
            "<text>old</text>",
        ] {
            let (mut previous, previous_blobs) = pack(source);
            let (mut next, next_blobs) = pack(next);
            for manifest in [&mut previous, &mut next] {
                manifest.modules.clear();
                manifest.components.clear();
            }
            assert!(requires_view_script_restart(
                &previous,
                &previous_blobs,
                &next,
                &next_blobs
            ));
            assert!(requires_view_script_restart(
                &next,
                &next_blobs,
                &previous,
                &previous_blobs
            ));
        }
        let (previous, previous_blobs) = pack(source);
        let (next, next_blobs) =
            pack("<wxs module=\"util\">module.exports.value = 1</wxs><text>new</text>");
        assert!(requires_view_script_restart(
            &previous,
            &previous_blobs,
            &next,
            &next_blobs
        ));
        assert!(!requires_view_script_restart(
            &previous,
            &previous_blobs,
            &previous,
            &previous_blobs
        ));
    }

    #[test]
    fn page_reference_to_app_scoped_widget_without_own_relation_is_guarded() {
        let (mut previous, previous_blobs) = pack("<counter config=\"{{old}}\"/>");
        let (mut next, next_blobs) = pack("<counter config=\"{{next}}\"/>");
        for manifest in [&mut previous, &mut next] {
            manifest.modules[0].id = "module:widgets/counter.js".into();
            manifest.modules[0].scope = ModuleScope::App;
            manifest.components[0]
                .using_components
                .insert("counter".into(), "widgets/counter".into());
            assert_eq!(
                manifest.components.len(),
                1,
                "the leaf has no relation table"
            );
        }
        assert!(requires_component_restart(
            &previous,
            &previous_blobs,
            &next,
            &next_blobs
        ));
    }

    #[test]
    fn unknown_ir_fields_are_not_discarded_by_typed_decoding() {
        fn future_pack(rule: &str) -> (ContainerManifestV1, BTreeMap<String, Vec<u8>>) {
            let (mut manifest, blobs) = pack("<view><counter/></view>");
            let mut value: Value =
                serde_json::from_slice(&blobs[&manifest.templates[0].wxml_ast]).unwrap();
            value["nodes"][0]["futureMountRule"] = Value::String(rule.into());
            let bytes = serde_json::to_vec(&value).unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates[0].wxml_ast = pointer.clone();
            (manifest, BTreeMap::from([(pointer, bytes)]))
        }
        let (previous, previous_blobs) = future_pack("old");
        let (next, next_blobs) = future_pack("next");
        assert!(requires_component_restart(
            &previous,
            &previous_blobs,
            &next,
            &next_blobs
        ));
    }
}
