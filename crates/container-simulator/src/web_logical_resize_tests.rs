//! Proposed C5 regression tests. Execution belongs to the integration lane.
use super::*;
#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_render_skia::PageRenderMode;
use container_render_skia::{Rect, RenderNode};

fn snapshot(id: u64) -> RenderSnapshot {
    RenderSnapshot {
        frame_id: id,
        width: 1,
        height: 1,
        stride: 4,
        format: "rgba8".into(),
        pixels: vec![10, 20, 30, 255],
    }
}

fn exported(id: u64) -> RenderFrame {
    let viewport = Rect {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    };
    RenderFrame {
        frame_id: id,
        viewport,
        root: RenderNode::new("root", viewport),
        images: Default::default(),
    }
}

#[test]
fn final_control_validation_rejects_configuration_transport_and_profile_supersession() {
    for external in [false, true] {
        for change in ["settings", "transport", "profile"] {
            let surface = WebSurface::localhost(0).unwrap();
            let handle = surface.handle();
            handle.set_presentation(json!({"revision":1,"generation":1}));
            let control = handle.capture_presentation_control(&json!({})).unwrap();
            match change {
                "settings" => handle.set_presentation(json!({"revision":2,"generation":2})),
                "transport" => {
                    handle
                        .publish_frame_with_revision("new-session", 1, 1.0, 1.0, &snapshot(1), 1)
                        .unwrap();
                }
                "profile" => handle
                    .set_renderer_profile(container_ir::RendererProfile::SkylineCompat)
                    .unwrap(),
                _ => unreachable!(),
            }
            let (settings, sequence, epoch) = {
                let shared = handle.shared.lock().unwrap();
                (
                    shared.presentation.clone(),
                    shared.next_transport_frame,
                    shared.publication_epoch,
                )
            };
            let prepared = if external {
                handle.prepare_render_frame_at_scale("session", 2, &exported(2), 2, 0.0, 1.0)
            } else {
                handle
                    .reserve_frame("session", 2, 1.0, 1.0, 1, 1)
                    .unwrap()
                    .prepare(&snapshot(2), 2, 0.0)
            }
            .unwrap();
            let result = prepared
                .with_presentation(json!({"revision":3,"generation":3}))
                .validate_control(&control);
            assert!(matches!(result, Err(error) if error.contains("control lease")));
            let shared = handle.shared.lock().unwrap();
            assert_eq!(shared.presentation, settings);
            assert_eq!(shared.next_transport_frame, sequence);
            assert_eq!(shared.publication_epoch, epoch);
        }
    }
}

#[test]
fn matching_control_installs_export_and_settings_together() {
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    let before = json!({"revision":1,"generation":1});
    let after = json!({"revision":2,"generation":2});
    handle.set_presentation(before);
    let control = handle.capture_presentation_control(&json!({})).unwrap();
    let frame = exported(2);
    handle
        .prepare_render_frame_at_scale("session", 2, &frame, 2, 0.0, 2.0)
        .unwrap()
        .with_presentation(after.clone())
        .validate_control(&control)
        .unwrap()
        .install();
    let shared = handle.shared.lock().unwrap();
    assert_eq!(shared.presentation, after);
    assert_eq!(shared.render_frame.as_ref().unwrap().generation, 2);
    assert_eq!(shared.render_frame.as_ref().unwrap().revision, 2);
    assert!(shared.frame.is_none());
}

#[test]
fn equal_value_control_from_another_surface_cannot_authorize_prepared_install() {
    for kind in ["settings", "raster", "export"] {
        let a = WebSurface::localhost(0).unwrap();
        let b = WebSurface::localhost(0).unwrap();
        let a = a.handle();
        let b = b.handle();
        let settings = json!({"revision":1,"generation":1});
        a.set_presentation(settings.clone());
        b.set_presentation(settings.clone());
        let control = b.capture_presentation_control(&json!({})).unwrap();
        let prepared = match kind {
            "settings" => a.prepare_presentation(json!({"revision":2,"generation":2})),
            "raster" => a
                .reserve_frame("session", 2, 1.0, 1.0, 1, 1)
                .unwrap()
                .prepare(&snapshot(2), 2, 0.0),
            "export" => a.prepare_render_frame_at_scale("session", 2, &exported(2), 2, 0.0, 1.0),
            _ => unreachable!(),
        }
        .unwrap();
        let result = prepared.validate_control(&control);
        assert!(matches!(result, Err(error) if error.contains("another Web surface")));
        for handle in [&a, &b] {
            let shared = handle.shared.lock().unwrap();
            assert_eq!(shared.presentation, settings);
            assert!(shared.frame.is_none());
            assert!(shared.render_frame.is_none());
            assert_eq!(shared.next_transport_frame, 1);
            assert_eq!(shared.live_frame_claim_bytes(None), 0);
        }
    }
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn cross_surface_resize_admission_rejects_before_hooks_and_releases_charge_unlocked() {
    use crate::{presentation::PresentationSettings, Simulator, SimulatorConfig};
    use std::sync::atomic::{AtomicBool, Ordering};
    let pack = super::density_tests::fixture::new();
    for no_scene in [false, true] {
        for mode in [
            PageRenderMode::ExternalFrame,
            #[cfg(feature = "skia-raster")]
            PageRenderMode::Raster,
        ] {
            for (foreign_control, foreign_reservation) in
                [(true, false), (false, true), (true, true)]
            {
                let mut simulator = Simulator::from_pack_dir(
                    &pack.0,
                    SimulatorConfig {
                        engine: super::density_tests::fixture::engine(),
                        page_render_mode: mode,
                        ..Default::default()
                    },
                )
                .unwrap();
                simulator.run().unwrap();
                if no_scene {
                    simulator
                        .dispatch(container_bridge::BridgeEnvelope::request(
                            simulator.session_id(),
                            "foreign-no-scene",
                            container_bridge::op::PAGE_PUSH,
                            json!({"path":"pages/index/index"}),
                        ))
                        .unwrap();
                    assert!(!simulator.has_current_skia_scene());
                }
                let a_surface = WebSurface::localhost(0).unwrap();
                let b_surface = WebSurface::localhost(0).unwrap();
                let a = a_surface.handle();
                let b = b_surface.handle();
                let settings = PresentationSettings::default();
                for handle in [&a, &b] {
                    handle.set_presentation(serde_json::to_value(&settings).unwrap());
                }
                let a_control = a.capture_presentation_control(&json!({})).unwrap();
                let b_control = b.capture_presentation_control(&json!({})).unwrap();
                let mut next = settings.clone();
                next.logical_width = 667;
                next.logical_height = 375;
                next.revision += 1;
                next.generation += 1;
                let origin = if foreign_reservation { &a } else { &b };
                let mut reservation = origin
                    .reserve_frame(
                        simulator.session_id(),
                        next.generation,
                        next.logical_width as f32,
                        next.logical_height as f32,
                        next.logical_width,
                        next.logical_height,
                    )
                    .unwrap();
                let released = Arc::new(AtomicBool::new(false));
                let probe_released = Arc::clone(&released);
                let probe_handle = (*origin).clone();
                reservation.cancellation_probe =
                    Some(FrameReservationDropProbe(Some(Box::new(move || {
                        assert!(
                            probe_handle.shared.try_lock().is_ok(),
                            "cancellation drops outside Web lock"
                        );
                        probe_released.store(true, Ordering::SeqCst);
                    }))));
                let before_trace = simulator.trace_summary().total_records;
                let before_revision = simulator.host().render_revision();
                let control = if foreign_control {
                    &a_control
                } else {
                    &b_control
                };
                let error = simulator
                    .apply_web_logical_resize(&b, &next, control, Some(reservation))
                    .unwrap_err();
                assert!(error.contains("another Web surface"));
                assert!(released.load(Ordering::SeqCst));
                assert_eq!(simulator.trace_summary().total_records, before_trace);
                assert_eq!(simulator.host().render_revision(), before_revision);
                assert_eq!(simulator.viewport().width, 375.0);
                assert_eq!(
                    simulator
                        .host()
                        .session()
                        .unwrap()
                        .config()
                        .host
                        .window_width,
                    375
                );
                for handle in [&a, &b] {
                    let shared = handle.shared.lock().unwrap();
                    assert_eq!(
                        shared.presentation,
                        serde_json::to_value(&settings).unwrap()
                    );
                    assert!(shared.frame.is_none());
                    assert!(shared.render_frame.is_none());
                    assert_eq!(shared.live_frame_claim_bytes(None), 0);
                }
            }
        }
    }
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn cloned_surface_handle_authorizes_same_owner_with_or_without_current_scene() {
    use crate::{presentation::PresentationSettings, Simulator, SimulatorConfig};
    let pack = super::density_tests::fixture::new();
    for no_scene in [false, true] {
        for mode in [
            PageRenderMode::ExternalFrame,
            #[cfg(feature = "skia-raster")]
            PageRenderMode::Raster,
        ] {
            let mut simulator = Simulator::from_pack_dir(
                &pack.0,
                SimulatorConfig {
                    engine: super::density_tests::fixture::engine(),
                    page_render_mode: mode,
                    ..Default::default()
                },
            )
            .unwrap();
            simulator.run().unwrap();
            if no_scene {
                simulator
                    .dispatch(container_bridge::BridgeEnvelope::request(
                        simulator.session_id(),
                        "clone-no-scene",
                        container_bridge::op::PAGE_PUSH,
                        json!({"path":"pages/index/index"}),
                    ))
                    .unwrap();
            }
            let surface = WebSurface::localhost(0).unwrap();
            let handle = surface.handle();
            let cloned = handle.clone();
            let settings = PresentationSettings::default();
            handle.set_presentation(serde_json::to_value(&settings).unwrap());
            let control = cloned.capture_presentation_control(&json!({})).unwrap();
            let mut next = settings;
            next.logical_width = 667;
            next.logical_height = 375;
            next.revision += 1;
            next.generation += 1;
            let reservation = cloned
                .reserve_frame(
                    simulator.session_id(),
                    next.generation,
                    667.0,
                    375.0,
                    667,
                    375,
                )
                .unwrap();
            simulator
                .apply_web_logical_resize(&handle, &next, &control, Some(reservation))
                .unwrap();
            assert_eq!(handle.presentation(), serde_json::to_value(&next).unwrap());
            assert_eq!(cloned.presentation(), handle.presentation());
            assert_eq!(simulator.viewport().width, 667.0);
            assert_eq!(simulator.viewport().height, 375.0);
            assert_eq!(simulator.has_current_skia_scene(), !no_scene);
            let shared = handle.shared.lock().unwrap();
            assert_eq!(shared.live_frame_claim_bytes(None), 0);
            if no_scene {
                assert!(shared.frame.is_none());
                assert!(shared.render_frame.is_none());
            } else if mode == PageRenderMode::Raster {
                assert!(shared.frame.is_some());
            } else {
                assert!(shared.render_frame.is_some());
            }
        }
    }
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn logical_resize_sse_failure_keeps_both_visual_owners_and_next_attempt_succeeds() {
    use crate::{presentation::PresentationSettings, Simulator, SimulatorConfig};
    let pack = super::density_tests::fixture::new();
    for mode in [
        PageRenderMode::ExternalFrame,
        #[cfg(feature = "skia-raster")]
        PageRenderMode::Raster,
    ] {
        let mut simulator = Simulator::from_pack_dir(
            &pack.0,
            SimulatorConfig {
                engine: super::density_tests::fixture::engine(),
                page_render_mode: mode,
                ..Default::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let settings = PresentationSettings::default();
        handle.set_presentation(serde_json::to_value(&settings).unwrap());
        let before_revision = simulator.host().render_revision();
        let before_frame = simulator
            .host()
            .session()
            .unwrap()
            .accepted_page_observation()
            .unwrap()
            .frame
            .clone();
        if mode == PageRenderMode::Raster {
            handle
                .publish_frame_with_revision(
                    simulator.session_id(),
                    settings.generation,
                    settings.logical_width as f32,
                    settings.logical_height as f32,
                    simulator.host().render_snapshot_ref().unwrap(),
                    before_revision,
                )
                .unwrap();
        } else {
            handle
                .publish_render_frame_at_scale(
                    simulator.session_id(),
                    settings.generation,
                    &before_frame,
                    before_revision,
                    0.0,
                    settings.effective_scale,
                )
                .unwrap();
        }
        let (old_response, next_event) = {
            let shared = handle.shared.lock().unwrap();
            let response = if mode == PageRenderMode::Raster {
                Arc::clone(&shared.frame.as_ref().unwrap().response)
            } else {
                Arc::clone(&shared.render_frame.as_ref().unwrap().response)
            };
            (response, shared.next_event_id)
        };
        let mut next = settings.clone();
        next.logical_width = 667;
        next.logical_height = 375;
        next.revision += 1;
        next.generation += 1;
        let control = handle.capture_presentation_control(&json!({})).unwrap();
        handle.shared.lock().unwrap().next_event_id = u64::MAX;
        let error = simulator
            .apply_web_logical_resize(&handle, &next, &control, None)
            .unwrap_err();
        assert!(error.contains("SSE event sequence exhausted"));
        assert_eq!(simulator.host().render_revision(), before_revision);
        assert_eq!(simulator.viewport(), before_frame.viewport);
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .config()
                .host
                .window_width,
            375
        );
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .config()
                .host
                .window_height,
            667
        );
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .accepted_page_observation()
                .unwrap()
                .frame,
            &before_frame
        );
        assert_eq!(
            handle.presentation(),
            serde_json::to_value(&settings).unwrap()
        );
        {
            let shared = handle.shared.lock().unwrap();
            let response = if mode == PageRenderMode::Raster {
                &shared.frame.as_ref().unwrap().response
            } else {
                &shared.render_frame.as_ref().unwrap().response
            };
            assert!(Arc::ptr_eq(&old_response, response));
        }

        handle.shared.lock().unwrap().next_event_id = next_event;
        let control = handle.capture_presentation_control(&json!({})).unwrap();
        simulator
            .apply_web_logical_resize(&handle, &next, &control, None)
            .unwrap();
        assert_eq!(simulator.viewport().width, 667.0);
        assert_eq!(simulator.viewport().height, 375.0);
        assert_eq!(handle.presentation(), serde_json::to_value(&next).unwrap());
        let shared = handle.shared.lock().unwrap();
        if mode == PageRenderMode::Raster {
            assert!(shared.frame.is_some());
            assert!(shared.render_frame.is_none());
        } else {
            assert!(shared.render_frame.is_some());
            assert!(shared.frame.is_none());
        }
    }
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn logical_resize_before_new_page_first_pump_publishes_settings_without_old_scene() {
    use crate::{presentation::PresentationSettings, Simulator, SimulatorConfig};
    use container_bridge::{op, BridgeEnvelope};
    let pack = super::density_tests::fixture::new();
    for mode in [
        PageRenderMode::ExternalFrame,
        #[cfg(feature = "skia-raster")]
        PageRenderMode::Raster,
    ] {
        let mut simulator = Simulator::from_pack_dir(
            &pack.0,
            SimulatorConfig {
                engine: super::density_tests::fixture::engine(),
                page_render_mode: mode,
                ..Default::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();
        let before = simulator
            .host()
            .session()
            .unwrap()
            .accepted_page_observation()
            .unwrap()
            .frame
            .clone();
        let before_revision = simulator.host().render_revision();
        let old_page = simulator.host().view_document().unwrap().unwrap().page_id;
        simulator
            .dispatch(BridgeEnvelope::request(
                simulator.session_id(),
                "logical-new-page",
                op::PAGE_PUSH,
                json!({"path":"pages/index/index"}),
            ))
            .unwrap();
        assert!(!simulator.has_current_skia_scene());
        let new_page = simulator
            .host()
            .session()
            .unwrap()
            .app_service()
            .pages()
            .current()
            .unwrap()
            .id
            .0;
        assert_ne!(new_page, old_page);
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let settings = PresentationSettings::default();
        handle.set_presentation(serde_json::to_value(&settings).unwrap());
        if mode == PageRenderMode::Raster {
            handle
                .publish_frame_with_revision(
                    simulator.session_id(),
                    settings.generation,
                    settings.logical_width as f32,
                    settings.logical_height as f32,
                    simulator.host().render_snapshot_ref().unwrap(),
                    before_revision,
                )
                .unwrap();
        } else {
            handle
                .publish_render_frame_at_scale(
                    simulator.session_id(),
                    settings.generation,
                    &before,
                    before_revision,
                    0.0,
                    settings.effective_scale,
                )
                .unwrap();
        }
        let mut next = settings.clone();
        next.logical_width = 667;
        next.logical_height = 375;
        next.revision += 1;
        next.generation += 1;
        let control = handle.capture_presentation_control(&json!({})).unwrap();
        simulator
            .apply_web_logical_resize(&handle, &next, &control, None)
            .unwrap();
        assert!(!simulator.has_current_skia_scene());
        assert_eq!(simulator.host().render_revision(), before_revision);
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .accepted_page_observation()
                .unwrap()
                .frame,
            &before
        );
        assert_eq!(
            simulator.host().view_document().unwrap().unwrap().page_id,
            old_page
        );
        assert_eq!(handle.presentation(), serde_json::to_value(&next).unwrap());
        {
            let shared = handle.shared.lock().unwrap();
            if mode == PageRenderMode::Raster {
                assert_eq!(
                    shared.frame.as_ref().unwrap().metadata["configGeneration"],
                    settings.generation
                );
                assert!(shared.render_frame.is_none());
            } else {
                assert_eq!(
                    shared.render_frame.as_ref().unwrap().generation,
                    settings.generation
                );
                assert!(shared.frame.is_none());
            }
        }
        simulator.pump(0).unwrap();
        assert!(simulator.has_current_skia_scene());
        assert_eq!(
            simulator.host().view_document().unwrap().unwrap().page_id,
            new_page
        );
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .accepted_page_observation()
                .unwrap()
                .frame
                .viewport,
            simulator.viewport()
        );
    }
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
fn accepted_text(simulator: &crate::Simulator) -> String {
    fn visit(node: &RenderNode, text: &mut String) {
        if let Some(value) = &node.text {
            text.push_str(value);
        }
        for child in &node.children {
            visit(child, text);
        }
    }
    let mut text = String::new();
    visit(
        &simulator
            .host()
            .session()
            .unwrap()
            .accepted_page_observation()
            .unwrap()
            .frame
            .root,
        &mut text,
    );
    text
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn real_wxs_input_survives_web_publication_failure_without_reexecution() {
    use crate::{presentation::PresentationSettings, Simulator, SimulatorConfig};
    use container_bridge::{op, BridgeEnvelope};
    let pack = super::density_tests::fixture::with_stateful_view("");
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
            assert!(accepted_text(&simulator).contains("0=A:1;2=C:2;"));
            let page = simulator
                .host()
                .session()
                .unwrap()
                .app_service()
                .pages()
                .current()
                .unwrap()
                .id
                .0;
            let patch = |id: &str, title: &str, simulator: &mut Simulator| {
                let batch = simulator.dispatch(BridgeEnvelope::request(
                    simulator.session_id(), id, op::DATA_PATCH_BATCH,
                    json!({"pageId":page,"patches":[{"path":"title","op":"set","value":title}]}),
                )).unwrap();
                assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
            };
            // This is actual dirty View input; no host pump has evaluated it.
            patch("wxs-pending", "pending", &mut simulator);
            let surface = WebSurface::localhost(0).unwrap();
            let handle = surface.handle();
            let settings = PresentationSettings::default();
            handle.set_presentation(serde_json::to_value(&settings).unwrap());
            let before_revision = simulator.host().render_revision();
            let before = simulator
                .host()
                .session()
                .unwrap()
                .accepted_page_observation()
                .unwrap()
                .frame
                .clone();
            if mode == PageRenderMode::Raster {
                handle
                    .publish_frame_with_revision(
                        simulator.session_id(),
                        settings.generation,
                        375.0,
                        667.0,
                        simulator.host().render_snapshot_ref().unwrap(),
                        before_revision,
                    )
                    .unwrap();
            } else {
                handle
                    .publish_render_frame_at_scale(
                        simulator.session_id(),
                        settings.generation,
                        &before,
                        before_revision,
                        0.0,
                        1.0,
                    )
                    .unwrap();
            }
            let next_event = handle.shared.lock().unwrap().next_event_id;
            let control = handle.capture_presentation_control(&json!({})).unwrap();
            handle.shared.lock().unwrap().next_event_id = u64::MAX;
            let mut next = settings.clone();
            next.logical_width = 667;
            next.logical_height = 375;
            next.revision += 1;
            next.generation += 1;
            let error = simulator
                .apply_web_logical_resize(&handle, &next, &control, None)
                .unwrap_err();
            assert!(error.contains("SSE event sequence exhausted"));
            assert_eq!(simulator.host().render_revision(), before_revision);
            assert_eq!(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .accepted_page_observation()
                    .unwrap()
                    .frame,
                &before
            );
            assert_eq!(
                handle.presentation(),
                serde_json::to_value(&settings).unwrap()
            );
            assert_eq!(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .app_service()
                    .storage()
                    .get("c5-resize-calls"),
                Some(&json!(1))
            );
            handle.shared.lock().unwrap().next_event_id = next_event;
            let control = handle.capture_presentation_control(&json!({})).unwrap();
            simulator
                .apply_web_logical_resize(&handle, &next, &control, None)
                .unwrap();
            let retried = accepted_text(&simulator);
            assert!(
                retried.contains("0=A:3;2=C:4;"),
                "same consumed WXS input ran again: {engine:?}/{mode:?}: {retried}"
            );
            assert!(retried.contains("page:pending"));
            assert_eq!(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .app_service()
                    .storage()
                    .get("c5-resize-calls"),
                Some(&json!(2)),
                "one irreversible page resize hook per control attempt"
            );
            // A genuinely new data input must execute the same stateful WXS
            // again, proving that the prior assertion did not disable View.
            patch("wxs-next", "next", &mut simulator);
            simulator.pump(0).unwrap();
            let dirty = accepted_text(&simulator);
            assert!(
                dirty.contains("0=A:5;2=C:6;"),
                "new WXS input did not run: {dirty}"
            );
            assert!(dirty.contains("page:next"));
        }
    }
}

#[cfg(all(
    feature = "skia-raster",
    any(feature = "quickjs-native", feature = "v8-native")
))]
#[test]
fn logical_resize_owner_keeps_committed_frame_when_observer_callback_reports_failure() {
    use crate::{presentation::PresentationSettings, Simulator, SimulatorConfig};
    let pack = super::density_tests::fixture::with_stateful_view(
        "wx.createIntersectionObserver(this).relativeToViewport().observe('view',function(){throw new Error('c5 committed observer failure');});"
    );
    for engine in enabled_native_test_engines() {
        let mut simulator = Simulator::from_pack_dir(
            &pack.0,
            SimulatorConfig {
                engine,
                page_render_mode: PageRenderMode::Raster,
                ..Default::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let mut next = PresentationSettings::default();
        handle.set_presentation(serde_json::to_value(&next).unwrap());
        let control = handle.capture_presentation_control(&json!({})).unwrap();
        let old_revision = simulator.host().render_revision();
        next.logical_width = 667;
        next.logical_height = 375;
        next.revision += 1;
        next.generation += 1;
        let batch = simulator
            .apply_web_logical_resize(&handle, &next, &control, None)
            .expect("post-publication callback failure must retain accepted settings/frame");
        assert!(
            batch
                .messages
                .iter()
                .any(|message| message.op == container_bridge::op::ERROR
                    && message
                        .payload
                        .get("errors")
                        .and_then(Value::as_array)
                        .is_some_and(|errors| errors
                            .iter()
                            .any(|error| error["message"] == "c5 committed observer failure"))),
            "{engine:?}: {batch:?}"
        );
        assert_eq!(handle.presentation(), serde_json::to_value(&next).unwrap());
        assert_eq!(simulator.host().render_revision(), old_revision + 1);
        assert_eq!(simulator.viewport().width, 667.0);
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .config()
                .host
                .window_width,
            667
        );
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .accepted_page_observation()
                .unwrap()
                .frame
                .viewport,
            simulator.viewport()
        );
        let shared = handle.shared.lock().unwrap();
        assert_eq!(
            shared.frame.as_ref().unwrap().render_revision,
            old_revision + 1
        );
        assert_eq!(
            shared.frame.as_ref().unwrap().metadata["configGeneration"],
            next.generation
        );
    }
}
