//! Source-level test additions; no execution is implied by this module.
use super::*;
#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_render_skia::Renderer;
use container_render_skia::{Rect, RenderNode};

fn pixels(id: u64) -> RenderSnapshot {
    RenderSnapshot {
        frame_id: id,
        width: 2,
        height: 1,
        stride: 8,
        format: "rgba8-premultiplied".into(),
        pixels: vec![64, 32, 16, 128, 0, 0, 0, 0],
    }
}

fn frame() -> RenderFrame {
    let viewport = Rect {
        x: 0.0,
        y: 0.0,
        width: 2.0,
        height: 1.0,
    };
    RenderFrame {
        frame_id: 7,
        viewport,
        root: RenderNode::new("retained", viewport),
        images: Default::default(),
    }
}

#[test]
fn dropped_encoded_raster_keeps_old_picture_settings_sequence_and_sse() {
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle
        .publish_frame_with_revision("session", 1, 2.0, 1.0, &pixels(1), 1)
        .unwrap();
    let (old, next_event, next_transport, settings) = {
        let shared = handle.shared.lock().unwrap();
        (
            Arc::clone(&shared.frame.as_ref().unwrap().response),
            shared.next_event_id,
            shared.next_transport_frame,
            shared.presentation.clone(),
        )
    };
    let prepared = handle
        .reserve_frame("session", 2, 2.0, 1.0, 2, 1)
        .unwrap()
        .prepare(&pixels(2), 2, 0.25)
        .unwrap()
        .with_presentation(json!({"generation":2}));
    // Pixels and notification have both been encoded, yet no publication is
    // visible when the candidate is abandoned before renderer acceptance.
    drop(prepared);
    let shared = handle.shared.lock().unwrap();
    assert!(Arc::ptr_eq(&old, &shared.frame.as_ref().unwrap().response));
    assert_eq!(shared.next_event_id, next_event);
    assert_eq!(shared.next_transport_frame, next_transport);
    assert_eq!(shared.presentation, settings);
    assert_eq!(shared.events.len(), 1);
}

#[test]
fn sse_preparation_failure_keeps_raster_and_external_publications() {
    for external in [false, true] {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        if external {
            handle
                .publish_render_frame_at_scale("session", 1, &frame(), 1, 0.0, 1.0)
                .unwrap();
        } else {
            handle
                .publish_frame_with_revision("session", 1, 2.0, 1.0, &pixels(1), 1)
                .unwrap();
        }
        let (old, seq, settings) = {
            let mut shared = handle.shared.lock().unwrap();
            shared.next_event_id = u64::MAX;
            let old = if external {
                Arc::clone(&shared.render_frame.as_ref().unwrap().response)
            } else {
                Arc::clone(&shared.frame.as_ref().unwrap().response)
            };
            (
                old,
                shared.next_transport_frame,
                shared.presentation.clone(),
            )
        };
        let result = if external {
            handle.prepare_render_frame_at_scale("session", 2, &frame(), 2, 0.0, 2.0)
        } else {
            handle
                .reserve_frame("session", 2, 2.0, 1.0, 2, 1)
                .unwrap()
                .prepare(&pixels(2), 2, 0.0)
        };
        assert!(matches!(&result,Err(error) if error.contains("SSE event sequence exhausted")));
        drop(result);
        let shared = handle.shared.lock().unwrap();
        let current = if external {
            &shared.render_frame.as_ref().unwrap().response
        } else {
            &shared.frame.as_ref().unwrap().response
        };
        assert!(Arc::ptr_eq(&old, current));
        assert_eq!(shared.next_event_id, u64::MAX);
        assert_eq!(shared.next_transport_frame, seq);
        assert_eq!(shared.presentation, settings);
        assert_eq!(shared.events.len(), 1);
    }
}

#[test]
fn external_candidate_checks_transport_exhaustion_before_installation() {
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle
        .publish_render_frame_at_scale("session", 1, &frame(), 1, 0.0, 1.0)
        .unwrap();
    let old = {
        let mut shared = handle.shared.lock().unwrap();
        shared.next_transport_frame = u64::MAX;
        Arc::clone(&shared.render_frame.as_ref().unwrap().response)
    };
    let result = handle.prepare_render_frame_at_scale("session", 2, &frame(), 2, 0.0, 2.0);
    assert!(matches!(&result,Err(error) if error.contains("sequence exhausted")));
    drop(result);
    let shared = handle.shared.lock().unwrap();
    assert!(Arc::ptr_eq(
        &old,
        &shared.render_frame.as_ref().unwrap().response
    ));
    assert_eq!(shared.next_transport_frame, u64::MAX);
}

#[test]
fn final_install_moves_exact_prepared_straight_alpha_bytes_and_settings() {
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    let settings = json!({"revision":2,"generation":2});
    let prepared = handle
        .reserve_frame("session", 2, 2.0, 1.0, 2, 1)
        .unwrap()
        .prepare(&pixels(7), 11, 0.75)
        .unwrap()
        .with_presentation(settings.clone());
    prepared.install();
    let shared = handle.shared.lock().unwrap();
    let cached = shared.frame.as_ref().unwrap();
    assert_eq!(cached.render_revision, 11);
    assert_eq!(shared.presentation, settings);
    assert_eq!(shared.next_transport_frame, 2);
    assert_eq!(shared.next_event_id, 2);
    assert_eq!(
        &cached.response[cached.response.len() - 8..],
        &[128, 64, 32, 128, 0, 0, 0, 0]
    );
    assert_eq!(cached.snapshot, pixels(7));
    assert_eq!(shared.events.len(), 1);
    assert_eq!(shared.events[0].kind, "snapshot");
}

#[test]
fn render_candidate_budget_includes_old_raster_source_and_slow_client_responses() {
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle
        .publish_frame_with_revision("session", 1, 2.0, 1.0, &pixels(1), 1)
        .unwrap();
    let held = Arc::new(vec![0_u8]);
    let old = {
        let mut shared = handle.shared.lock().unwrap();
        // Model a still-live slow-client buffer. The ledger owns accounting,
        // not the pixel allocation, so no 64 MiB test allocation is required.
        shared.retained_response_bytes.push(RetainedResponseBytes {
            bytes: Arc::downgrade(&held),
            length: MAX_FRAME_CACHE_BYTES,
        });
        Arc::clone(&shared.frame.as_ref().unwrap().response)
    };
    let result = handle.prepare_render_frame_at_scale("session", 2, &frame(), 2, 0.0, 2.0);
    assert!(matches!(&result,Err(error) if error.contains("cache budget")));
    drop(result);
    let shared = handle.shared.lock().unwrap();
    assert!(Arc::ptr_eq(&old, &shared.frame.as_ref().unwrap().response));
    assert!(shared.render_frame.is_none());
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
pub(super) mod fixture {
    use super::*;
    use container_ir::{
        parse_wxml, AppInfo, CompilerInfo, ContainerManifestV1, Route, RouteKind, Template,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    pub(in crate::web) struct Pack(pub(in crate::web) std::path::PathBuf);
    impl Drop for Pack {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).expect("clean owned joint-density fixture");
        }
    }
    pub(in crate::web) fn engine() -> container_core::EngineKind {
        #[cfg(feature = "quickjs-native")]
        {
            container_core::EngineKind::Quickjs
        }
        #[cfg(not(feature = "quickjs-native"))]
        {
            container_core::EngineKind::V8
        }
    }
    /// Reuse the checked-in compiled WXS fixture without invoking a compiler.
    /// Only its AppService page hook changes; its stateful View program stays
    /// byte-for-byte identical to the verified golden executable.
    pub(in crate::web) fn with_stateful_view(on_resize: &str) -> Pack {
        let pack = new();
        let golden: Value = serde_json::from_str(include_str!(
            "../../../conformance/fixtures/isolated-view-render/golden-program.json"
        ))
        .unwrap();
        let mut manifest: ContainerManifestV1 =
            serde_json::from_value(golden["manifest"].clone()).unwrap();
        for (hash, source) in golden["blobs"].as_object().unwrap() {
            std::fs::write(
                pack.0.join("blobs/sha256").join(hash),
                source.as_str().unwrap(),
            )
            .unwrap();
        }
        let source = format!(
            "Page({{data:{}, onResize:function(){{wx.setStorageSync('c5-resize-calls',(wx.getStorageSync('c5-resize-calls') || 0)+1);{on_resize}}}}});",
            golden["render"]["data"],
        );
        let module = manifest
            .modules
            .iter_mut()
            .find(|module| module.id == "module:pages/index/index.js")
            .unwrap();
        module.sha256 = container_ir::hex_digest(source.as_bytes());
        std::fs::write(pack.0.join("blobs/sha256").join(&module.sha256), source).unwrap();
        manifest.refresh_integrity().unwrap();
        std::fs::write(
            pack.0.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        pack
    }

    pub(in crate::web) fn new() -> Pack {
        let pack = loop {
            let path = std::env::temp_dir().join(format!(
                "weapp-joint-density-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&path) {
                Ok(()) => break Pack(path),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("reserve joint-density fixture: {error}"),
            }
        };
        std::fs::create_dir(pack.0.join("blobs")).unwrap();
        std::fs::create_dir(pack.0.join("blobs/sha256")).unwrap();
        let ast = parse_wxml("<view>retained</view>")
            .unwrap()
            .canonical_json()
            .unwrap();
        let hash = container_ir::hex_digest(&ast);
        std::fs::write(pack.0.join("blobs/sha256").join(&hash), ast).unwrap();
        let route = "pages/index/index";
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "joint-density".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            routes: vec![Route {
                id: format!("route:{route}"),
                path: route.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: "page.js".into(),
            }],
            templates: vec![Template {
                id: format!("template:{route}.wxml"),
                wxml_ast: format!("sha256:{hash}"),
                bindings: vec![],
                wxs_modules: Default::default(),
            }],
            ..Default::default()
        };
        manifest.refresh_integrity().unwrap();
        std::fs::write(
            pack.0.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        pack
    }
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn joint_density_transport_failure_retains_native_and_web_owners_without_compensation() {
    use crate::{
        presentation::{PresentationSettings, RenderScale},
        Simulator, SimulatorConfig,
    };
    use container_render_skia::PageRenderMode;
    let pack = fixture::new();
    for engine in enabled_native_test_engines() {
        for mode in [
            PageRenderMode::ExternalFrame,
            #[cfg(feature = "skia-raster")]
            PageRenderMode::Raster,
        ] {
            let mut simulator = Simulator::from_pack_dir(
                &pack.0,
                SimulatorConfig {
                    engine,
                    page_render_mode: mode,
                    ..Default::default()
                },
            )
            .unwrap();
            simulator.run().unwrap();
            let surface = WebSurface::localhost(0).unwrap();
            let handle = surface.handle();
            let original = PresentationSettings::default();
            handle.set_presentation(serde_json::to_value(&original).unwrap());
            let revision = simulator.host().render_revision();
            if mode == PageRenderMode::Raster {
                handle
                    .publish_frame_with_revision(
                        simulator.session_id(),
                        1,
                        375.0,
                        667.0,
                        simulator.host().render_snapshot_ref().unwrap(),
                        revision,
                    )
                    .unwrap();
            } else {
                handle
                    .publish_render_frame_at_scale(
                        simulator.session_id(),
                        1,
                        simulator
                            .host()
                            .session()
                            .unwrap()
                            .renderer()
                            .last_frame()
                            .unwrap(),
                        revision,
                        0.0,
                        1.0,
                    )
                    .unwrap();
            }
            let (old, event, transport) = {
                let mut shared = handle.shared.lock().unwrap();
                shared.next_event_id = u64::MAX;
                let response = if mode == PageRenderMode::Raster {
                    &shared.frame.as_ref().unwrap().response
                } else {
                    &shared.render_frame.as_ref().unwrap().response
                };
                (
                    Arc::clone(response),
                    shared.next_event_id,
                    shared.next_transport_frame,
                )
            };
            let before_trace = simulator.trace();
            let before_frame = simulator
                .host()
                .session()
                .unwrap()
                .renderer()
                .last_frame()
                .unwrap()
                .clone();
            let before_pixels = (mode == PageRenderMode::Raster)
                .then(|| simulator.host().render_snapshot().unwrap());
            let before_input = simulator
                .host()
                .session()
                .unwrap()
                .last_frame_input(revision)
                .cloned();
            let candidate = PresentationSettings {
                revision: 2,
                generation: 2,
                render_scale: RenderScale::Fixed(2.0),
                effective_scale: 2.0,
                ..Default::default()
            };
            let error = simulator
                .apply_web_density(&handle, &candidate, true)
                .unwrap_err();
            assert!(error.contains("SSE event sequence exhausted"));
            assert_eq!(simulator.host().render_revision(), revision);
            assert_eq!(simulator.render_scale(), 1.0);
            assert_eq!(simulator.trace(), before_trace);
            assert_eq!(
                simulator.host().session().unwrap().renderer().last_frame(),
                Some(&before_frame)
            );
            assert_eq!(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .last_frame_input(revision),
                before_input.as_ref()
            );
            if let Some(pixels) = before_pixels {
                assert_eq!(simulator.host().render_snapshot().unwrap(), pixels);
            }
            let shared = handle.shared.lock().unwrap();
            let current = if mode == PageRenderMode::Raster {
                &shared.frame.as_ref().unwrap().response
            } else {
                &shared.render_frame.as_ref().unwrap().response
            };
            assert!(Arc::ptr_eq(&old, current));
            assert_eq!(
                shared.presentation,
                serde_json::to_value(&original).unwrap()
            );
            assert_eq!(shared.next_event_id, event);
            assert_eq!(shared.next_transport_frame, transport);
        }
    }
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn same_target_numeric_density_publishes_a_new_runtime_revision_without_view_replay() {
    use crate::{
        presentation::{PresentationSettings, RenderScale},
        Simulator, SimulatorConfig,
    };
    use container_render_skia::PageRenderMode;
    let pack = fixture::new();
    let viewport = Rect {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    };
    let mut simulator = Simulator::from_pack_dir(
        &pack.0,
        SimulatorConfig {
            engine: fixture::engine(),
            page_render_mode: PageRenderMode::ExternalFrame,
            viewport,
            render_scale: 1.5,
            ..Default::default()
        },
    )
    .unwrap();
    simulator.run().unwrap();
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    let original = PresentationSettings {
        logical_width: 1,
        logical_height: 1,
        render_scale: RenderScale::Fixed(1.5),
        effective_scale: 1.5,
        ..Default::default()
    };
    handle.set_presentation(serde_json::to_value(&original).unwrap());
    let revision = simulator.host().render_revision();
    handle
        .publish_render_frame_at_scale(
            simulator.session_id(),
            1,
            simulator
                .host()
                .session()
                .unwrap()
                .renderer()
                .last_frame()
                .unwrap(),
            revision,
            0.0,
            1.5,
        )
        .unwrap();
    let candidate = PresentationSettings {
        generation: 2,
        revision: 2,
        render_scale: RenderScale::Fixed(2.0),
        effective_scale: 2.0,
        ..original
    };
    let trace = simulator.trace();
    simulator
        .apply_web_density(&handle, &candidate, true)
        .unwrap();
    assert_eq!(simulator.host().render_revision(), revision + 1);
    assert_eq!(simulator.trace(), trace);
    assert_eq!(simulator.render_scale(), 2.0);
    let shared = handle.shared.lock().unwrap();
    let exported = shared.render_frame.as_ref().unwrap();
    assert_eq!(exported.generation, 2);
    assert_eq!(exported.revision, revision + 1);
    let start = find_bytes(&exported.response, b"\r\n\r\n").unwrap() + 4;
    let envelope: Value = serde_json::from_slice(&exported.response[start..]).unwrap();
    assert_eq!(envelope["width"], 2);
    assert_eq!(envelope["height"], 2);
    assert_eq!(
        shared.presentation,
        serde_json::to_value(&candidate).unwrap()
    );
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn fps_only_acceptance_keeps_pixels_render_time_and_transport_sse_sequences() {
    use crate::{presentation::PresentationSettings, Simulator, SimulatorConfig};
    use container_render_skia::PageRenderMode;
    let pack = fixture::new();
    let mut simulator = Simulator::from_pack_dir(
        &pack.0,
        SimulatorConfig {
            engine: fixture::engine(),
            page_render_mode: PageRenderMode::ExternalFrame,
            ..Default::default()
        },
    )
    .unwrap();
    simulator.run().unwrap();
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    let original = PresentationSettings::default();
    handle.set_presentation(serde_json::to_value(&original).unwrap());
    let revision = simulator.host().render_revision();
    handle
        .publish_render_frame_at_scale(
            simulator.session_id(),
            1,
            simulator
                .host()
                .session()
                .unwrap()
                .renderer()
                .last_frame()
                .unwrap(),
            revision,
            0.0,
            1.0,
        )
        .unwrap();
    let (response, transport, event, render_ms) = {
        let shared = handle.shared.lock().unwrap();
        (
            Arc::clone(&shared.render_frame.as_ref().unwrap().response),
            shared.next_transport_frame,
            shared.next_event_id,
            simulator.host().render_duration_ms().unwrap(),
        )
    };
    let candidate = PresentationSettings {
        revision: 2,
        fps: 120,
        ..original
    };
    let trace = simulator.trace();
    simulator
        .apply_web_density(&handle, &candidate, false)
        .unwrap();
    assert_eq!(simulator.trace(), trace);
    assert_eq!(simulator.host().render_revision(), revision);
    assert_eq!(simulator.host().render_duration_ms().unwrap(), render_ms);
    let shared = handle.shared.lock().unwrap();
    assert!(Arc::ptr_eq(
        &response,
        &shared.render_frame.as_ref().unwrap().response
    ));
    assert_eq!(shared.next_transport_frame, transport);
    assert_eq!(shared.next_event_id, event);
    assert_eq!(
        shared.presentation,
        serde_json::to_value(&candidate).unwrap()
    );
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn no_current_scene_jointly_stages_settings_without_initializing_or_publishing_old_route() {
    use crate::{
        presentation::{PresentationSettings, RenderScale},
        Simulator, SimulatorConfig,
    };
    use container_render_skia::PageRenderMode;
    let pack = fixture::new();
    let mut simulator = Simulator::from_pack_dir(
        &pack.0,
        SimulatorConfig {
            engine: fixture::engine(),
            page_render_mode: PageRenderMode::ExternalFrame,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        !simulator
            .host()
            .page_render_status()
            .unwrap()
            .page_object_initialized
    );
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle
        .publish_render_frame_at_scale("old-route-session", 1, &frame(), 8, 0.0, 1.0)
        .unwrap();
    let (old, transport, event) = {
        let shared = handle.shared.lock().unwrap();
        (
            Arc::clone(&shared.render_frame.as_ref().unwrap().response),
            shared.next_transport_frame,
            shared.next_event_id,
        )
    };
    let candidate = PresentationSettings {
        generation: 2,
        revision: 2,
        render_scale: RenderScale::Fixed(2.0),
        effective_scale: 2.0,
        ..Default::default()
    };
    let trace = simulator.trace();
    simulator
        .apply_web_density(&handle, &candidate, true)
        .unwrap();
    assert!(
        !simulator
            .host()
            .page_render_status()
            .unwrap()
            .page_object_initialized
    );
    assert_eq!(simulator.trace(), trace);
    assert_eq!(simulator.host().render_revision(), 0);
    assert_eq!(simulator.render_scale(), 2.0);
    {
        let shared = handle.shared.lock().unwrap();
        assert!(Arc::ptr_eq(
            &old,
            &shared.render_frame.as_ref().unwrap().response
        ));
        assert_eq!(shared.next_transport_frame, transport);
        assert_eq!(shared.next_event_id, event);
        assert_eq!(
            shared.presentation,
            serde_json::to_value(&candidate).unwrap()
        );
    }
    simulator.run().unwrap();
    assert_eq!(
        simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .accepted_render_target()
            .unwrap()
            .width,
        750
    );
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn poisoned_web_store_rejects_before_lazy_target_or_simulator_configuration_changes() {
    use crate::{
        presentation::{PresentationSettings, RenderScale},
        Simulator, SimulatorConfig,
    };
    use container_render_skia::PageRenderMode;
    let pack = fixture::new();
    let mut simulator = Simulator::from_pack_dir(
        &pack.0,
        SimulatorConfig {
            engine: fixture::engine(),
            page_render_mode: PageRenderMode::ExternalFrame,
            ..Default::default()
        },
    )
    .unwrap();
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    let poison = Arc::clone(&handle.shared);
    let outcome = std::thread::spawn(move || {
        let _guard = poison.lock().unwrap();
        panic!("deliberate density Web store poison");
    })
    .join();
    assert!(outcome.is_err());
    let candidate = PresentationSettings {
        generation: 2,
        revision: 2,
        render_scale: RenderScale::Fixed(2.0),
        effective_scale: 2.0,
        ..Default::default()
    };
    let trace = simulator.trace();
    let error = simulator
        .apply_web_density(&handle, &candidate, true)
        .unwrap_err();
    assert!(error.contains("Web surface unavailable"));
    assert_eq!(simulator.render_scale(), 1.0);
    assert_eq!(simulator.trace(), trace);
    assert_eq!(simulator.host().render_revision(), 0);
    assert!(
        !simulator
            .host()
            .page_render_status()
            .unwrap()
            .page_object_initialized
    );
    // A later ordinary render proves that even the lazy pending target stayed
    // at its original 1× value; checking config alone would miss that mutation.
    simulator.run().unwrap();
    assert_eq!(
        simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .accepted_render_target()
            .unwrap()
            .width,
        375
    );
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn fps_hint_cannot_suppress_a_density_repaint_when_staged_config_matches() {
    use crate::{
        presentation::{PresentationSettings, RenderScale},
        Simulator, SimulatorConfig,
    };
    use container_render_skia::PageRenderMode;
    let pack = fixture::new();
    let mut simulator = Simulator::from_pack_dir(
        &pack.0,
        SimulatorConfig {
            engine: fixture::engine(),
            page_render_mode: PageRenderMode::ExternalFrame,
            ..Default::default()
        },
    )
    .unwrap();
    simulator.run().unwrap();
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    let revision = simulator.host().render_revision();
    handle
        .publish_render_frame_at_scale(
            simulator.session_id(),
            1,
            simulator
                .host()
                .session()
                .unwrap()
                .renderer()
                .last_frame()
                .unwrap(),
            revision,
            0.0,
            1.0,
        )
        .unwrap();
    // Model a staged target returning to a retained current-page picture:
    // config and renderer staging are 2×, accepted target/frame remain 1×.
    let viewport = simulator.viewport();
    simulator
        .host_mut()
        .stage_skia_render_target(viewport, 2.0)
        .unwrap();
    simulator.config.render_scale = 2.0;
    assert_eq!(
        simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .accepted_render_target()
            .unwrap()
            .width,
        375
    );
    let candidate = PresentationSettings {
        generation: 2,
        revision: 2,
        fps: 120,
        render_scale: RenderScale::Fixed(2.0),
        effective_scale: 2.0,
        ..Default::default()
    };
    let trace = simulator.trace();
    simulator
        .apply_web_density(&handle, &candidate, false)
        .unwrap();
    assert_eq!(simulator.trace(), trace);
    assert_eq!(simulator.host().render_revision(), revision + 1);
    let shared = handle.shared.lock().unwrap();
    let exported = shared.render_frame.as_ref().unwrap();
    assert_eq!(exported.revision, revision + 1);
    assert_eq!(exported.generation, 2);
    let start = find_bytes(&exported.response, b"\r\n\r\n").unwrap() + 4;
    let envelope: Value = serde_json::from_slice(&exported.response[start..]).unwrap();
    assert_eq!(envelope["width"], 750);
    assert_eq!(shared.next_transport_frame, 3);
    assert_eq!(
        shared.presentation,
        serde_json::to_value(&candidate).unwrap()
    );
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn runtime_ticket_and_transport_prepare_consume_the_same_borrowed_observation() {
    use crate::{Simulator, SimulatorConfig};
    use container_runtime::DevRasterPresentationTarget;
    let pack = fixture::new();
    for engine in enabled_native_test_engines() {
        let mut simulator = Simulator::from_pack_dir(
            &pack.0,
            SimulatorConfig {
                engine,
                page_render_mode: container_render_skia::PageRenderMode::Raster,
                viewport: container_render_skia::Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 2.0,
                    height: 1.0,
                },
                ..Default::default()
            },
        )
        .unwrap();
        simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .enable_dev_raster_presentation()
            .unwrap();
        simulator.run().unwrap();
        let session_id = simulator.session_id().to_owned();
        let session = simulator.host_mut().session_mut().unwrap();
        let (source_frame, revision, pixel_pointer) = {
            let observed = session.accepted_page_observation().unwrap();
            (
                observed.frame.frame_id,
                observed.render_revision,
                observed.snapshot.unwrap().pixels.as_ptr(),
            )
        };
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.shared.lock().unwrap().preview.epoch = 1;
        let reservation = handle
            .reserve_frame(&session_id, 1, 2.0, 1.0, 2, 1)
            .unwrap();
        let identity = reservation.identity();
        let target = DevRasterPresentationTarget {
            session_id: identity.session_id().to_owned(),
            preview_id: "test-owner".into(),
            preview_generation: identity.preview_epoch(),
            frame_id: identity.frame_id(),
            source_frame_id: source_frame,
            render_revision: revision,
            config_generation: identity.config_generation(),
            logical_width: identity.logical_width() as u32,
            logical_height: identity.logical_height() as u32,
            width: identity.width(),
            height: identity.height(),
        };
        let prepared_runtime = session.prepare_dev_raster_presentation(target).unwrap();
        let ticket = prepared_runtime.ticket().clone();
        let observed = prepared_runtime.accepted_page_observation();
        let snapshot = observed.snapshot.unwrap();
        assert_eq!(snapshot.pixels.as_ptr(), pixel_pointer);
        let prepared_transport = reservation
            .prepare(snapshot, observed.render_revision, 0.0)
            .unwrap();
        let receipt = prepared_runtime.accept();
        prepared_transport.install();
        drop(receipt);
        assert!(
            !session.is_current_frame_presented(),
            "publication does not acknowledge the browser"
        );
        session
            .acknowledge_dev_raster_presentation(&ticket)
            .unwrap();
        assert!(session.is_current_frame_presented());
        assert_eq!(
            session
                .accepted_page_observation()
                .unwrap()
                .snapshot
                .unwrap()
                .pixels
                .as_ptr(),
            pixel_pointer
        );
        let shared = handle.shared.lock().unwrap();
        let metadata = &shared.frame.as_ref().unwrap().metadata;
        assert_eq!(metadata["sessionId"], ticket.target.session_id);
        assert_eq!(metadata["frameId"], ticket.target.frame_id);
        assert_eq!(metadata["sourceFrameId"], ticket.target.source_frame_id);
        assert_eq!(metadata["renderRevision"], ticket.target.render_revision);
        assert_eq!(
            metadata["configGeneration"],
            ticket.target.config_generation
        );
    }
}
