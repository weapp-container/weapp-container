//! Purpose-built local fixture, not an official IDE source or oracle.
use container_ir::{
    hex_digest, parse_wxml, wxml_bindings, CapabilitySupport, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Template,
};
#[path = "../pack.rs"]
mod pack;

use std::collections::BTreeMap;
use std::path::PathBuf;

const APP: &str = "App({});";
const HOME: &str = r#"
const states=new WeakMap();let calls=0;
Page({data:{value:1,calls:0},onLoad(){states.set(this,{value:1});},onUnload(){states.delete(this);},
increment(){calls++;const state=states.get(this);state.value++;this.setData({value:state.value,calls});wx.setStorageSync('actual-method-count',calls);},
snapshot(){return {calls,value:states.get(this).value,stored:wx.getStorageSync('actual-method-count')};},
array(){return [0,false,'',null,[1,2]];},
pending(ms){calls++;return new Promise(resolve=>setTimeout(()=>{const state=states.get(this);state.value++;this.setData({value:state.value,calls});wx.setStorageSync('actual-method-count',calls);resolve({calls,value:state.value});},ms));},
never(){calls++;this.setData({calls});return new Promise(()=>{});},
throws(){calls++;throw 'actual primitive throw';}
});
"#;
const OTHER: &str = "Page({data:{value:'other'}});";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let first = args.next().ok_or("output directory required")?;
    if first == "--verify" {
        let target = PathBuf::from(args.next().ok_or("pack directory required")?);
        if args.next().is_some() {
            return Err("unexpected verification argument".into());
        }
        let loaded = pack::Pack::read(&target)?;
        println!(
            "{}",
            serde_json::json!({"pack":target,"strictPackRead":true,
            "manifestIntegrity":loaded.manifest.integrity.root,"official":false})
        );
        return Ok(());
    }
    if args.next().is_some() {
        return Err("unexpected generation argument".into());
    }
    let target = PathBuf::from(first);
    std::fs::create_dir(&target)?;
    std::fs::create_dir_all(target.join("blobs/sha256"))?;
    let mut manifest = ContainerManifestV1::default();
    // The protocol requires this identity. Local authorship is recorded below;
    // this hand-authored pack is not official compiler output.
    manifest.compiler.name = "weapp-vite".into();
    manifest.compiler.commit = "local-fixture-not-official-compiler-output".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    for (path, source, scope) in [
        ("app.js", APP, ModuleScope::App),
        ("home.js", HOME, ModuleScope::Page),
        ("other.js", OTHER, ModuleScope::Page),
    ] {
        let digest = hex_digest(source.as_bytes());
        std::fs::write(target.join("blobs/sha256").join(&digest), source)?;
        manifest.modules.push(Module {
            id: format!("module:{path}"),
            sha256: digest,
            format: ModuleFormat::Commonjs,
            scope,
            dependencies: vec![],
        });
    }
    for (route, wxml) in [
        (
            "home",
            r##"<view style="width:300px;height:220px;background-color:#eeeeee"><text id="value">{{value}}</text><text id="calls">{{calls}}</text><view id="increment" bindtap="increment" style="width:160px;height:60px;background-color:#88ccaa">Increment</view></view>"##,
        ),
        ("other", r#"<text id="other">other</text>"#),
    ] {
        manifest.routes.push(Route {
            id: format!("route:{route}"),
            path: route.into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: format!("{route}.js"),
        });
        let ast = parse_wxml(wxml)?;
        let bindings = wxml_bindings(&ast);
        let bytes = ast.canonical_json()?;
        let digest = hex_digest(&bytes);
        std::fs::write(target.join("blobs/sha256").join(&digest), bytes)?;
        manifest.templates.push(Template {
            id: format!("template:{route}.wxml"),
            wxml_ast: format!("sha256:{digest}"),
            bindings,
            wxs_modules: BTreeMap::new(),
        });
    }
    for name in [
        "wx.getStorageSync",
        "wx.setStorageSync",
        "wx.reLaunch",
        "wx.navigateTo",
        "wx.navigateBack",
        "wx.timer",
    ] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Partial);
    }
    manifest.validate()?;
    manifest.refresh_integrity()?;
    manifest.verify_integrity()?;
    std::fs::write(
        target.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    std::fs::write(
        target.join("local-fixture-provenance.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
        "kind":"local-method-owner-native-fixture-v2","official":false,
        "authorship":"hand-authored local fixture; protocol compiler identity is not generator provenance",
        "generator":"weapp-conformance-desktop/src/bin/method-fixture.rs","guestModuleSha256":hex_digest(HOME.as_bytes()),
        "expectedInitialPrivateValue":1,"expectedInitialMethodCounter":0,"manifestIntegrity":manifest.integrity.root}))?,
    )?;
    let loaded = pack::Pack::read(&target)?;
    println!(
        "{}",
        serde_json::json!({"pack":target,"manifestIntegrity":loaded.manifest.integrity.root,"strictPackRead":true,"official":false})
    );
    Ok(())
}
