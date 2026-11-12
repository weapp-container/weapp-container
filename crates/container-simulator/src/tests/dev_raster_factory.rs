//! Library policy/reload consumers. Tickets are issued by the real Session;
//! no HTTP/RAF/GPU/device acceptance is established by these definitions.
use super::*;

#[test]
fn developer_raster_factory_preserves_the_exact_compiled_engine_boundary() {
    let (root, _) = test_pack();
    for engine in [EngineKind::Quickjs, EngineKind::V8] {
        let result = Simulator::from_dev_raster_pack_dir(
            &root,
            SimulatorConfig {
                engine,
                ..Default::default()
            },
        );
        if engine_provider_compiled(engine) {
            let simulator = result.unwrap();
            let session = simulator.host().session().unwrap();
            assert!(!session.initialized());
            assert_eq!(
                session.raster_presentation_policy(),
                RasterPresentationPolicy::ExplicitDev
            );
            assert_eq!(session.config().engine, engine);
        } else {
            let error = result.unwrap_err();
            assert!(
                matches!(&error, SimulatorError::EngineUnavailable { engine: requested } if *requested == engine)
            );
            assert!(error.to_string().starts_with("ERR_ENGINE:"));
        }
    }
    fs::remove_dir_all(root).unwrap();
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
mod native {
    use super::*;
    use container_bridge::BridgeErrorCode;
    use container_render_skia::PageRenderMode;
    use container_runtime::{DevRasterPresentationTarget, DevRasterPresentationTicket};

    struct Pack(PathBuf);
    impl Drop for Pack {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    impl Pack {
        fn new(version: u32, route: &str, style: &str) -> Self {
            let (root, _) = test_pack();
            render_pack(
                &root,
                route,
                r#"<view id="target" bindtouchstart="start" bindtouchcancel="cancel">{{ready}}/{{ticks}}</view>"#,
                style,
            );
            install_app_modules(
                &root,
                r#"App({failCancel:false});
exports.armCancelFailure=function(){getApp().failCancel=true;return true;};
exports.scheduleTick=function(){var page=getCurrentPages()[0];setTimeout(function(){page.setData({ticks:page.data.ticks+1});},1);return true;};"#,
                &format!(
                    r#"Page({{data:{{version:{version},loaded:0,ready:0,ticks:0,cancels:0}},
onLoad(){{this.setData({{loaded:this.data.loaded+1}});}},
onReady(){{this.setData({{ready:this.data.ready+1}});}},start(){{}},
cancel(){{this.setData({{cancels:this.data.cancels+1}});if(getApp().failCancel)throw new Error('old strict retirement failed');}}
}});"#
                ),
            );
            let pack = Self(root);
            pack.manifest(|manifest| {
                for capability in ["getCurrentPages", "wx.timer"] {
                    manifest
                        .capabilities
                        .insert(capability.into(), container_ir::CapabilitySupport::Partial);
                }
            });
            pack
        }
        fn manifest(&self, change: impl FnOnce(&mut ContainerManifestV1)) {
            let path = self.0.join("manifest.json");
            let mut manifest: ContainerManifestV1 =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            change(&mut manifest);
            manifest.refresh_integrity().unwrap();
            manifest.validate().unwrap();
            fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        }
    }

    fn engines() -> Vec<EngineKind> {
        vec![
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ]
    }
    fn config(engine: EngineKind) -> SimulatorConfig {
        SimulatorConfig {
            engine,
            viewport: Rect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0,
            },
            ..Default::default()
        }
    }
    const STYLE: &str = "view {width:20px;height:20px;background-color:#fff}";
    const ROUTE: &str = "pages/index/index";
    fn data(simulator: &Simulator) -> &Value {
        &simulator
            .host()
            .session()
            .unwrap()
            .app_service()
            .pages()
            .current()
            .unwrap()
            .data
    }
    fn assert_ok(batch: &BridgeBatch) {
        assert!(
            batch.messages.iter().all(|message| message.op != op::ERROR),
            "{batch:?}"
        );
    }
    fn assert_rejected(batch: &BridgeBatch) {
        assert!(
            batch.messages.iter().any(|message| message.op == op::ERROR),
            "{batch:?}"
        );
    }
    fn issue(simulator: &mut Simulator, frame_id: u64) -> DevRasterPresentationTicket {
        let session_id = simulator.session_id().to_owned();
        let session = simulator.host_mut().session_mut().unwrap();
        let target = {
            let observed = session.accepted_page_observation().unwrap();
            DevRasterPresentationTarget {
                session_id,
                preview_id: "library-owner".into(),
                preview_generation: 1,
                frame_id,
                source_frame_id: observed.frame.frame_id,
                render_revision: observed.render_revision,
                config_generation: 1,
                logical_width: observed.frame.viewport.width as u32,
                logical_height: observed.frame.viewport.height as u32,
                width: observed.target.width,
                height: observed.target.height,
            }
        };
        let prepared = session.prepare_dev_raster_presentation(target).unwrap();
        let ticket = prepared.ticket().clone();
        drop(prepared.accept());
        ticket
    }
    fn ack(simulator: &mut Simulator, ticket: &DevRasterPresentationTicket) -> BridgeBatch {
        simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .acknowledge_dev_raster_presentation(ticket)
            .unwrap()
    }
    fn assert_ack_cancelled(simulator: &mut Simulator, ticket: &DevRasterPresentationTicket) {
        let error = simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .acknowledge_dev_raster_presentation(ticket)
            .unwrap_err();
        assert_eq!(error.code, BridgeErrorCode::Cancelled);
    }
    fn settle_ready(simulator: &mut Simulator) -> DevRasterPresentationTicket {
        assert_eq!(data(simulator)["ready"], 0);
        let first = issue(simulator, 1);
        assert_ok(&ack(simulator, &first));
        assert_eq!(
            data(simulator)["ready"],
            1,
            "real native Page.onReady writes data after the issued ACK"
        );
        assert_ok(&simulator.pump(0).unwrap());
        assert_ack_cancelled(simulator, &first);
        assert_eq!(
            data(simulator)["ready"],
            1,
            "a superseded publication cannot replay ready"
        );
        let settled = issue(simulator, 2);
        assert_ok(&ack(simulator, &settled));
        assert_ok(&ack(simulator, &settled));
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .is_current_frame_presented());
        assert_eq!(data(simulator)["ready"], 1);
        settled
    }
    fn touch(simulator: &mut Simulator) {
        let point = json!({"identifier":7,"clientX":5,"clientY":5,"pageX":5,"pageY":5});
        let batch = simulator
            .dispatch_request(
                op::EVENT_BATCH,
                json!({"events":[{
                    "type":"touchstart","x":5,"y":5,"timeStamp":100,
                    "touches":[point],"changedTouches":[point],"detail":{"x":5,"y":5}
                }]}),
            )
            .unwrap();
        assert_ok(&batch);
    }
    fn call(simulator: &mut Simulator, export: &str) {
        assert_ok(
            &simulator
                .dispatch_request(
                    op::MODULE_CALL,
                    json!({"moduleId":"module:app.js","export":export,"args":[]}),
                )
                .unwrap(),
        );
    }
    fn cancel_patches(record: &Value) -> usize {
        record["response"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|message| {
                message["payload"]["effects"]
                    .as_array()
                    .into_iter()
                    .flatten()
            })
            .flat_map(|effect| effect["events"].as_array().into_iter().flatten())
            .flat_map(|event| event["patches"].as_array().into_iter().flatten())
            .filter(|patch| patch["path"] == "cancels" && patch["value"] == 1)
            .count()
    }

    #[test]
    fn explicit_factory_and_repeated_js_configuration_restarts_defer_real_ready_until_issued_ack() {
        for engine in engines() {
            let pack = Pack::new(1, ROUTE, STYLE);
            let mut simulator =
                Simulator::from_dev_raster_pack_dir(&pack.0, config(engine)).unwrap();
            assert!(!simulator.host().session().unwrap().initialized());
            simulator.run().unwrap();
            assert_eq!(data(&simulator)["loaded"], 1);
            assert!(!simulator
                .host()
                .session()
                .unwrap()
                .is_current_frame_presented());
            let mut old_ticket = settle_ready(&mut simulator);
            let mut generations = Vec::new();
            for (index, version, route) in [
                (1, 2, ROUTE),
                (2, 3, ROUTE),
                (3, 3, "pages/alternate/index"),
            ] {
                touch(&mut simulator);
                let next = Pack::new(version, route, STYLE);
                let old_session = simulator.session_id().to_owned();
                assert_eq!(
                    simulator.apply_dev_pack(&next.0).unwrap().0,
                    DevReloadKind::Restart
                );
                assert_ne!(simulator.session_id(), old_session);
                assert_eq!(simulator.session_generation, index);
                assert_eq!(
                    simulator
                        .host()
                        .session()
                        .unwrap()
                        .raster_presentation_policy(),
                    RasterPresentationPolicy::ExplicitDev
                );
                assert_eq!(data(&simulator)["loaded"], 1);
                assert_eq!(data(&simulator)["ready"], 0);
                assert!(!simulator
                    .host()
                    .session()
                    .unwrap()
                    .is_current_frame_presented());
                assert_ack_cancelled(&mut simulator, &old_ticket);
                let trace = simulator.trace();
                let retired = trace
                    .iter()
                    .filter(|record| record["request"]["op"] == "view.retire")
                    .collect::<Vec<_>>();
                assert_eq!(retired.len(), index as usize);
                assert_eq!(
                    cancel_patches(retired.last().unwrap()),
                    1,
                    "each real old contact is cancelled once before its host is replaced"
                );
                let current = settle_ready(&mut simulator);
                assert_ack_cancelled(&mut simulator, &old_ticket);
                assert!(
                    simulator
                        .host()
                        .session()
                        .unwrap()
                        .is_current_frame_presented(),
                    "stale old-session ACK cannot revoke the new lease"
                );
                old_ticket = current;
                generations.push(next);
            }
            call(&mut simulator, "scheduleTick");
            let future = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                + std::time::Duration::from_secs(10))
            .as_nanos() as u64;
            assert_ok(&simulator.pump(future).unwrap());
            assert_eq!(
                data(&simulator)["ticks"],
                1,
                "the retained strict session still executes timers"
            );
        }
    }

    #[test]
    fn original_factory_stays_synchronous_and_cannot_be_upgraded_after_initialization() {
        for engine in engines() {
            let pack = Pack::new(1, ROUTE, STYLE);
            let mut simulator = Simulator::from_pack_dir(&pack.0, config(engine)).unwrap();
            simulator.run().unwrap();
            assert_eq!(data(&simulator)["ready"], 1);
            let session = simulator.host_mut().session_mut().unwrap();
            assert_eq!(
                session.raster_presentation_policy(),
                RasterPresentationPolicy::Synchronous
            );
            assert_eq!(
                session.enable_dev_raster_presentation().unwrap_err().code,
                BridgeErrorCode::InvalidRequest
            );
        }
    }

    #[test]
    fn runtime_preinit_opt_in_is_the_reload_policy_source_even_before_the_first_run() {
        for engine in engines() {
            let pack = Pack::new(1, ROUTE, STYLE);
            let next = Pack::new(2, ROUTE, STYLE);
            let mut simulator = Simulator::from_pack_dir(&pack.0, config(engine)).unwrap();
            simulator
                .host_mut()
                .session_mut()
                .unwrap()
                .enable_dev_raster_presentation()
                .unwrap();
            simulator.apply_dev_pack(&next.0).unwrap();
            assert_eq!(simulator.session_generation, 0);
            assert_eq!(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .raster_presentation_policy(),
                RasterPresentationPolicy::ExplicitDev
            );
            assert_eq!(data(&simulator)["version"], 2);
            assert_eq!(data(&simulator)["ready"], 0);
            assert!(!simulator
                .host()
                .session()
                .unwrap()
                .is_current_frame_presented());
            settle_ready(&mut simulator);
        }
    }

    #[test]
    fn manually_activated_session_reloads_with_a_new_identity_before_simulator_run_completed() {
        for engine in engines() {
            for explicit in [false, true] {
                let pack = Pack::new(1, ROUTE, STYLE);
                let mut simulator = if explicit {
                    Simulator::from_dev_raster_pack_dir(&pack.0, config(engine))
                } else {
                    Simulator::from_pack_dir(&pack.0, config(engine))
                }
                .unwrap();
                let init = json!({"modules":simulator.module_payload().unwrap(),"blobs":simulator.render_blobs_value()});
                assert_ok(&simulator.dispatch_request(op::APP_INIT, init).unwrap());
                assert_ok(
                    &simulator
                        .dispatch_request(op::APP_LIFECYCLE, json!({"event":"launch"}))
                        .unwrap(),
                );
                assert_ok(
                    &simulator
                        .dispatch_request(op::PAGE_PUSH, json!({"path":ROUTE}))
                        .unwrap(),
                );
                assert_ok(&simulator.render_current_page().unwrap());
                let old_ticket = if explicit {
                    let first = issue(&mut simulator, 1);
                    assert_ok(&ack(&mut simulator, &first));
                    assert_ok(&simulator.render_current_page().unwrap());
                    let current = issue(&mut simulator, 2);
                    assert_ok(&ack(&mut simulator, &current));
                    Some(current)
                } else {
                    None
                };
                assert!(!simulator.started);
                assert!(simulator.host().initialized());
                assert!(simulator
                    .host()
                    .session()
                    .unwrap()
                    .is_current_frame_presented());
                let old_session = simulator.session_id().to_owned();
                // Even an identical pack must not reuse the activated runtime
                // identity just because Simulator::run has not returned.
                assert_eq!(
                    simulator.apply_dev_pack(&pack.0).unwrap().0,
                    DevReloadKind::Restart
                );
                assert_ne!(simulator.session_id(), old_session);
                assert_eq!(simulator.session_generation, 1);
                let stale = simulator
                    .dispatch(BridgeEnvelope::request(
                        old_session,
                        "old-manual-session",
                        op::DIAGNOSTIC,
                        json!({}),
                    ))
                    .unwrap();
                assert_rejected(&stale);
                if let Some(ticket) = old_ticket {
                    assert_eq!(data(&simulator)["ready"], 0);
                    assert_ack_cancelled(&mut simulator, &ticket);
                    let current = settle_ready(&mut simulator);
                    assert_ne!(ticket.target.session_id, current.target.session_id);
                    assert_eq!(ticket.presentation_epoch, current.presentation_epoch);
                    assert_eq!(ticket.target.preview_id, current.target.preview_id);
                    assert_eq!(
                        ticket.target.preview_generation,
                        current.target.preview_generation
                    );
                    assert_eq!(ticket.target.frame_id, current.target.frame_id);
                    assert_eq!(
                        ticket.target.source_frame_id,
                        current.target.source_frame_id
                    );
                    assert_eq!(
                        ticket.target.render_revision,
                        current.target.render_revision
                    );
                    assert_eq!(
                        ticket.target.config_generation,
                        current.target.config_generation
                    );
                    assert_eq!(
                        (
                            ticket.target.logical_width,
                            ticket.target.logical_height,
                            ticket.target.width,
                            ticket.target.height
                        ),
                        (
                            current.target.logical_width,
                            current.target.logical_height,
                            current.target.width,
                            current.target.height
                        )
                    );
                    assert_ack_cancelled(&mut simulator, &ticket);
                    assert!(
                        simulator
                            .host()
                            .session()
                            .unwrap()
                            .is_current_frame_presented(),
                        "same-valued old ticket cannot replace or revoke a new-session lease"
                    );
                    assert_ok(&ack(&mut simulator, &current));
                } else {
                    assert_eq!(data(&simulator)["ready"], 1);
                }
            }
        }
    }

    #[test]
    fn in_place_reload_keeps_policy_and_requires_fresh_authority_while_invalid_pack_keeps_current_lease(
    ) {
        for engine in engines() {
            let pack = Pack::new(1, ROUTE, STYLE);
            let next = Pack::new(
                1,
                ROUTE,
                "view{width:20px;height:20px;background-color:#123456}",
            );
            let mut simulator =
                Simulator::from_dev_raster_pack_dir(&pack.0, config(engine)).unwrap();
            simulator.run().unwrap();
            let old = settle_ready(&mut simulator);
            let session_id = simulator.session_id().to_owned();
            assert_eq!(
                simulator.apply_dev_pack(&next.0).unwrap().0,
                DevReloadKind::InPlace
            );
            assert_eq!(simulator.session_id(), session_id);
            assert_eq!(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .raster_presentation_policy(),
                RasterPresentationPolicy::ExplicitDev
            );
            assert!(!simulator
                .host()
                .session()
                .unwrap()
                .is_current_frame_presented());
            assert_ack_cancelled(&mut simulator, &old);
            let current = issue(&mut simulator, 3);
            assert_ok(&ack(&mut simulator, &current));
            assert_eq!(data(&simulator)["ready"], 1);
            let invalid = Pack::new(2, ROUTE, STYLE);
            fs::write(invalid.0.join("manifest.json"), b"{}").unwrap();
            assert!(simulator.apply_dev_pack(&invalid.0).is_err());
            assert_eq!(simulator.session_id(), session_id);
            assert!(simulator
                .host()
                .session()
                .unwrap()
                .is_current_frame_presented());
            assert_ok(&ack(&mut simulator, &current));
        }
    }

    #[test]
    fn failed_candidate_startup_does_not_retire_the_live_strict_session() {
        for engine in engines() {
            let pack = Pack::new(1, ROUTE, STYLE);
            let next = Pack::new(2, ROUTE, STYLE);
            install_app_modules(
                &next.0,
                "throw new Error('candidate startup failed');",
                "Page({});",
            );
            let mut simulator =
                Simulator::from_dev_raster_pack_dir(&pack.0, config(engine)).unwrap();
            simulator.run().unwrap();
            let old = settle_ready(&mut simulator);
            let session_id = simulator.session_id().to_owned();
            touch(&mut simulator);
            assert!(simulator.apply_dev_pack(&next.0).is_err());
            assert_eq!(simulator.session_id(), session_id);
            assert_eq!(data(&simulator)["cancels"], 0);
            assert!(simulator
                .host()
                .session()
                .unwrap()
                .is_current_frame_presented());
            assert_ok(&ack(&mut simulator, &old));
        }
    }

    #[test]
    fn failed_old_retirement_rejects_restart_keeps_original_host_and_preserves_fail_closed_diagnostics(
    ) {
        for engine in engines() {
            let pack = Pack::new(1, ROUTE, STYLE);
            let next = Pack::new(2, ROUTE, STYLE);
            let mut simulator =
                Simulator::from_dev_raster_pack_dir(&pack.0, config(engine)).unwrap();
            simulator.run().unwrap();
            let old = settle_ready(&mut simulator);
            let session_id = simulator.session_id().to_owned();
            call(&mut simulator, "armCancelFailure");
            touch(&mut simulator);
            assert!(simulator.apply_dev_pack(&next.0).is_err());
            assert_eq!(simulator.session_id(), session_id);
            assert_eq!(simulator.session_generation, 0);
            assert_eq!(data(&simulator)["version"], 1);
            assert_eq!(data(&simulator)["cancels"], 1);
            assert!(!simulator
                .host()
                .session()
                .unwrap()
                .is_current_frame_presented());
            let diagnostics = simulator
                .dispatch_request(op::DIAGNOSTIC, json!({}))
                .unwrap();
            assert!(serde_json::to_string(&diagnostics)
                .unwrap()
                .contains("old strict retirement failed"));
            assert_ack_cancelled(&mut simulator, &old);
            simulator
                .retire_dev_preview("retry-after-failed-restart")
                .unwrap();
            assert_eq!(
                data(&simulator)["cancels"],
                1,
                "failed retirement already consumed every contact"
            );
        }
    }

    #[test]
    fn every_policy_rejects_restart_generation_exhaustion_before_retiring_or_reusing_a_session_id()
    {
        for engine in engines() {
            for explicit in [false, true] {
                let pack = Pack::new(1, ROUTE, STYLE);
                let next = Pack::new(2, ROUTE, STYLE);
                let mut simulator = if explicit {
                    Simulator::from_dev_raster_pack_dir(&pack.0, config(engine))
                } else {
                    Simulator::from_pack_dir(&pack.0, config(engine))
                }
                .unwrap();
                simulator.run().unwrap();
                let ticket = explicit.then(|| settle_ready(&mut simulator));
                touch(&mut simulator);
                simulator.session_generation = u64::MAX;
                let session_id = simulator.session_id().to_owned();
                let error = simulator.apply_dev_pack(&next.0).unwrap_err();
                assert!(error
                    .to_string()
                    .contains("ERR_RENDER: development session generation exhausted"));
                assert_eq!(simulator.session_id(), session_id);
                assert_eq!(simulator.session_generation, u64::MAX);
                assert_eq!(data(&simulator)["version"], 1);
                assert_eq!(data(&simulator)["cancels"], 0);
                assert!(simulator
                    .host()
                    .session()
                    .unwrap()
                    .is_current_frame_presented());
                if let Some(ticket) = ticket {
                    assert_ok(&ack(&mut simulator, &ticket));
                }
            }
        }
    }

    #[test]
    fn explicit_factory_rejects_non_raster_render_modes_without_synchronous_fallback() {
        for engine in engines() {
            let pack = Pack::new(1, ROUTE, STYLE);
            let error = Simulator::from_dev_raster_pack_dir(
                &pack.0,
                SimulatorConfig {
                    page_render_mode: PageRenderMode::ExternalFrame,
                    ..config(engine)
                },
            )
            .unwrap_err();
            assert!(
                matches!(error,SimulatorError::Bridge(ref error) if error.code == BridgeErrorCode::UnsupportedCapability)
            );
            assert!(Simulator::from_dev_raster_pack_dir(
                &pack.0,
                SimulatorConfig {
                    page_render_mode: PageRenderMode::NativeGpu,
                    ..config(engine)
                }
            )
            .is_err());
        }
    }

    #[test]
    fn browser_current_page_does_not_disable_raster_policy_during_restart() {
        for engine in engines() {
            let pack = Pack::new(1, ROUTE, STYLE);
            let next = Pack::new(2, ROUTE, STYLE);
            for candidate in [&pack, &next] {
                candidate.manifest(|manifest| {
                    manifest.schema_version = container_ir::RENDERING_MANIFEST_SCHEMA_VERSION;
                    manifest.rendering = Some(container_ir::RendererProfiles {
                        default: RendererProfile::WebView,
                        ..Default::default()
                    });
                });
            }
            let mut simulator = Simulator::from_dev_raster_pack_dir(
                &pack.0,
                SimulatorConfig {
                    browser_view_enabled: true,
                    ..config(engine)
                },
            )
            .unwrap();
            simulator.run().unwrap();
            assert!(simulator.browser_render_request().is_some());
            assert_eq!(
                simulator.apply_dev_pack(&next.0).unwrap().0,
                DevReloadKind::Restart
            );
            assert_eq!(
                simulator.current_renderer_profile(),
                RendererProfile::WebView
            );
            assert!(simulator.browser_render_request().is_some());
            assert_eq!(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .raster_presentation_policy(),
                RasterPresentationPolicy::ExplicitDev
            );
            assert_eq!(data(&simulator)["ready"], 0);
        }
    }
}
