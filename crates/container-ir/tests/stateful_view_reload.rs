use container_ir::{Asset, ContainerManifestV1, Style, StyleScope, Template, ViewScriptModule};
use std::collections::BTreeMap;

fn manifest() -> ContainerManifestV1 {
    let mut manifest = ContainerManifestV1::default();
    manifest.templates.push(Template {
        id: "template:pages/index.wxml".into(),
        wxml_ast: format!("sha256:{}", "a".repeat(64)),
        bindings: Vec::new(),
        wxs_modules: BTreeMap::new(),
    });
    manifest
}

#[test]
fn stateful_view_documents_require_restart_without_a_heap_fork() {
    for marker in 0..3 {
        let mut original = manifest();
        match marker {
            0 => original.view_scripts.push(ViewScriptModule {
                id: "wxs:helpers/tools.wxs".into(),
                sha256: "b".repeat(64),
                dependencies: Vec::new(),
            }),
            1 => {
                original.templates[0]
                    .wxs_modules
                    .insert("tools".into(), "wxs:helpers/tools.wxs".into());
            }
            _ => original.assets.push(Asset {
                path: "helpers/tools.wxs".into(),
                sha256: "b".repeat(64),
                mime: "application/javascript".into(),
                size: 1,
            }),
        }
        let mut changed = original.clone();
        changed.templates[0].wxml_ast = format!("sha256:{}", "c".repeat(64));
        assert!(
            !original.can_replace_presentation_with(&changed),
            "marker={marker}"
        );
        assert!(
            !changed.can_replace_presentation_with(&original),
            "marker={marker}"
        );
        let mut added = original.clone();
        added.templates.push(Template {
            id: "template:shared/new.wxml".into(),
            ..original.templates[0].clone()
        });
        assert!(!original.can_replace_presentation_with(&added));
        assert!(!added.can_replace_presentation_with(&original));
        let mut renamed = original.clone();
        renamed.templates[0].id = "template:pages/renamed.wxml".into();
        assert!(!original.can_replace_presentation_with(&renamed));

        let mut presentation = original.clone();
        presentation.styles.push(Style {
            id: "style:app.wxss".into(),
            wxss_ir: format!("sha256:{}", "d".repeat(64)),
            scope: StyleScope::App,
        });
        presentation.assets.push(Asset {
            path: "images/icon.png".into(),
            sha256: "e".repeat(64),
            mime: "image/png".into(),
            size: 2,
        });
        assert!(
            original.can_replace_presentation_with(&presentation),
            "marker={marker}"
        );
    }
}

#[test]
fn stateless_document_edits_keep_the_existing_presentation_reload_contract() {
    let original = manifest();
    let mut changed = original.clone();
    changed.templates[0].wxml_ast = format!("sha256:{}", "c".repeat(64));
    assert!(original.can_replace_presentation_with(&changed));
}
