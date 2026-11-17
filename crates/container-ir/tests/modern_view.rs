use container_ir::{
    ContainerManifestV1, ModernViewCompilation, ModernViewDocument, ModernViewSource,
    ModernViewUnit,
};

fn fixture() -> ContainerManifestV1 {
    let mut manifest = ContainerManifestV1 {
        schema_version: 2,
        ..Default::default()
    };
    // Use a minimal declared template; integrity is tested separately below.
    manifest.compiler.commit = "modern-test".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.templates = vec![container_ir::Template {
        id: "template:pages/index/index.wxml".into(),
        wxml_ast: format!("sha256:{}", "a".repeat(64)),
        bindings: vec![],
        wxs_modules: Default::default(),
    }];
    manifest.modern_view = Some(ModernViewCompilation {
        compiler: "weapp-container-modern-view".into(),
        version: "1.0.0".into(),
        abi: "1.0".into(),
        target: "es2022".into(),
        units: vec![ModernViewUnit {
            id: format!("modern:{}", "b".repeat(64)),
            executable_sha256: "c".repeat(64),
            source_map_sha256: "d".repeat(64),
            sources: vec![ModernViewSource {
                path: "view/main.view.ts".into(),
                sha256: "e".repeat(64),
            }],
            documents: vec![ModernViewDocument {
                document_id: "pages/index/index.wxml".into(),
                aliases: vec!["tools".into()],
            }],
        }],
    });
    manifest
}

#[test]
fn modern_requires_explicit_version_and_unique_document_ownership() {
    let manifest = fixture();
    manifest.validate().unwrap();
    assert!(manifest.is_modern_document("template:pages/index/index.wxml"));
    let mut old = manifest.clone();
    old.schema_version = 1;
    assert!(
        old.validate().is_err(),
        "old loaders must reject modern packs"
    );
    let mut missing = manifest.clone();
    missing.modern_view = None;
    assert!(missing.validate().is_err());
    let mut duplicate = manifest.clone();
    let unit = &mut duplicate.modern_view.as_mut().unwrap().units[0];
    unit.documents.push(unit.documents[0].clone());
    assert!(duplicate.validate().is_err());
    let mut mixed = manifest.clone();
    mixed.templates[0]
        .wxs_modules
        .insert("tools".into(), "wxs:tools.wxs".into());
    assert!(mixed.validate().is_err());
}

#[test]
fn modern_program_sources_and_modes_belong_to_integrity_and_reload_identity() {
    let manifest = fixture();
    let bytes = manifest.canonical_json().unwrap();
    let decoded: ContainerManifestV1 = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(manifest, decoded);
    assert_eq!(
        manifest.modern_view.as_ref().unwrap().blob_hashes().count(),
        3
    );
    let mut changed = manifest.clone();
    changed.modern_view.as_mut().unwrap().units[0].executable_sha256 = "f".repeat(64);
    assert_ne!(
        manifest.computed_integrity_root().unwrap(),
        changed.computed_integrity_root().unwrap()
    );
    assert!(!manifest.can_replace_presentation_with(&changed));
    changed = manifest.clone();
    changed.templates[0].wxml_ast = format!("sha256:{}", "f".repeat(64));
    assert!(!manifest.can_replace_presentation_with(&changed));
    changed = manifest.clone();
    changed.styles.clear();
    assert!(manifest.can_replace_presentation_with(&changed));
}
