//! Explicit developer Raster binary v2 publication. This library primitive
//! pins a real runtime ticket and validates the existing preview ledger; it
//! neither enables strict CLI input nor acknowledges browser presentation.
use super::{
    CapturedWebFrameIdentity, PreparedWebPresentation, PreviewOwnerFence, WebFrameReservation,
};
use container_runtime::{DevRasterPresentationTicket, PreparedDevRasterPresentation};
use serde_json::json;

impl<'a> WebFrameReservation<'a> {
    /// Encode the pixels borrowed from an actual prepared runtime ticket.
    /// Accept the runtime candidate only after this succeeds, then install the
    /// Web publication and release the retired runtime receipt after unlock.
    /// Neither HTTP delivery nor this publication grants a browser RAF ACK.
    /// The library caller still owns session creation/restart and all input
    /// admission; the ordinary simulator CLI continues to use binary v1.
    pub fn prepare_dev_raster(
        mut self,
        runtime: &PreparedDevRasterPresentation<'_>,
        preview: &PreviewOwnerFence,
        render_ms: f64,
    ) -> Result<PreparedWebPresentation<'a>, String> {
        let ticket = runtime.ticket();
        let target = &ticket.target;
        let identity = &self.identity;
        // The runtime guard validates page/input lifetime and pins the actual
        // accepted frame. The reservation supplies the real allocation and
        // next transport sequence; equal values from another surface do not
        // establish owner authority (checked under the final guard below).
        if target.session_id != identity.session_id
            || target.frame_id != identity.frame_id
            || target.config_generation != identity.config_generation
            || target.preview_id != preview.client_id()
            || target.preview_generation != preview.epoch()
            || target.preview_generation != identity.preview_epoch
            || target.logical_width as f32 != identity.logical_width
            || target.logical_height as f32 != identity.logical_height
            || target.width != identity.width
            || target.height != identity.height
        {
            return Err(
                "ERR_CANCELLED: runtime ticket does not match the reserved Web frame".into(),
            );
        }
        let observed = runtime.accepted_page_observation();
        let snapshot = observed
            .snapshot
            .ok_or("ERR_RENDER: prepared developer Raster ticket has no actual pixels")?;
        if snapshot.frame_id != target.source_frame_id
            || observed.frame.frame_id != target.source_frame_id
            || observed.render_revision != target.render_revision
        {
            return Err(
                "ERR_CANCELLED: runtime ticket does not name the pinned Raster observation".into(),
            );
        }
        // Every u64 identity is a canonical decimal string in v2. Numeric
        // geometry and timing retain their measurement types. Reuse the same
        // bounded response/source buffers, alpha conversion and capacity lease.
        self.metadata = ticketed_metadata(identity, ticket);
        // Metadata may grow when an escaped session is repeated inside the
        // ticket. The common bounded writer rejects it before publication; it
        // cannot grow the reserved response or silently downgrade to v1.
        let prepared = self.prepare_encoded(snapshot, observed.render_revision, render_ms, true)?;
        preview.validate_locked(&prepared.owner, &prepared.shared.preview)?;
        Ok(prepared)
    }
}

impl crate::Simulator {
    /// Publish the currently accepted explicit developer Raster picture and
    /// its exact runtime ticket together. Returns false for an identical live
    /// publication, including one still waiting for the browser draw receipt.
    /// `generation` is the owner's committed presentation configuration.
    /// This library operation executes no View/JS, initializes no renderer and
    /// grants no RAF acknowledgment; default/headless/CLI policy is unchanged.
    /// Preview ids must satisfy the runtime's existing Raster identity profile.
    pub fn publish_dev_raster_frame(
        &mut self,
        handle: &super::WebSurfaceHandle,
        preview: &PreviewOwnerFence,
        generation: u64,
    ) -> Result<bool, String> {
        handle.validate_preview_owner(preview)?;
        let session = self
            .host()
            .session()
            .ok_or("ERR_ENGINE: session is not loaded")?;
        if session.raster_presentation_policy()
            != container_runtime::RasterPresentationPolicy::ExplicitDev
            || session.page_render_mode() != container_render_skia::PageRenderMode::Raster
            || self.current_renderer_profile() == container_ir::RendererProfile::WebView
        {
            return Err(
                "ERR_UNSUPPORTED_CAPABILITY: explicit developer Raster publication is required"
                    .into(),
            );
        }
        if generation == 0 {
            return Err(
                "ERR_RENDER: developer Raster configuration generation must be positive".into(),
            );
        }
        if session.execution_fault().is_some()
            || session.app_service().lifecycle().state() != container_core::LifecycleState::Active
            || !self.has_current_skia_scene()
        {
            return Err("ERR_CANCELLED: no active accepted developer Raster scene".into());
        }
        if let Some(ticket) = session
            .current_dev_raster_presentation_ticket()
            .filter(|ticket| {
                ticket.target.config_generation == generation
                    && ticket.target.preview_id == preview.client_id()
                    && ticket.target.preview_generation == preview.epoch()
            })
        {
            // Serialize only the small issued identity outside the Web mutex.
            // The cached private immutable packet must agree with the actual
            // runtime lease. Neither side alone proves a joint publication.
            let value = serde_json::to_value(ticket).map_err(|error| error.to_string())?;
            let shared = handle
                .shared
                .lock()
                .map_err(|_| "Web surface unavailable")?;
            preview.validate_locked(&std::sync::Arc::downgrade(&handle.shared), &shared.preview)?;
            if shared.frame.as_ref().is_some_and(|frame| {
                frame.metadata["schemaVersion"] == 2
                    && frame.render_revision == ticket.target.render_revision
                    && frame.metadata["presentationTicket"] == value
                    && shared.transport_session == ticket.target.session_id
            }) {
                return Ok(false);
            }
        }
        let observed = session
            .accepted_page_observation()
            .ok_or("ERR_RENDER: accepted developer Raster observation is unavailable")?;
        let snapshot = observed
            .snapshot
            .ok_or("ERR_RENDER: accepted developer Raster pixels are unavailable")?;
        let source_frame_id = snapshot.frame_id;
        let render_revision = observed.render_revision;
        let render_ms = session.page_render_status().last_render_ms;
        let logical_width = session.config().host.window_width;
        let logical_height = session.config().host.window_height;
        let reservation = handle.reserve_frame(
            self.session_id(),
            generation,
            logical_width as f32,
            logical_height as f32,
            observed.target.width,
            observed.target.height,
        )?;
        let id = reservation.identity();
        let target = container_runtime::DevRasterPresentationTarget {
            session_id: id.session_id().to_owned(),
            preview_id: preview.client_id().to_owned(),
            preview_generation: preview.epoch(),
            frame_id: id.frame_id(),
            source_frame_id,
            render_revision,
            config_generation: id.config_generation(),
            logical_width,
            logical_height,
            width: id.width(),
            height: id.height(),
        };
        let runtime = self
            .host_mut()
            .session_mut()
            .ok_or("ERR_ENGINE: session is not loaded")?
            .prepare_dev_raster_presentation(target)
            .map_err(|error| error.to_string())?;
        let transport = reservation.prepare_dev_raster(&runtime, preview, render_ms)?;
        // Only prepared moves occur between these two accepts. Do not insert
        // logging, callbacks, allocations or an early presentation ACK here.
        let retired = runtime.accept();
        transport.install();
        drop(retired); // transport already released the Web mutex
        Ok(true)
    }
}

fn ticketed_metadata(
    identity: &CapturedWebFrameIdentity,
    ticket: &DevRasterPresentationTicket,
) -> serde_json::Value {
    let target = &ticket.target;
    json!({
        "schemaVersion":2, "protocolVersion":"2.0",
        "sessionId":identity.session_id, "frameId":identity.frame_id.to_string(),
        "sourceFrameId":target.source_frame_id.to_string(),
        "renderRevision":target.render_revision.to_string(),
        "configGeneration":identity.config_generation.to_string(),
        "logicalWidth":target.logical_width, "logicalHeight":target.logical_height,
        "width":identity.width, "height":identity.height, "stride":identity.width * 4,
        "format":"rgba8", "byteLength":identity.width as usize * identity.height as usize * 4,
        "renderMs":0, "url":"/api/frame", "presentationTicket":ticket
    })
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
    use container_runtime::DevRasterPresentationTarget;
    use std::sync::Weak;

    #[test]
    fn maximum_escaped_session_and_decimal_identities_fit_the_reserved_header() {
        // Encoding-only conservative boundary fixture, not an owner proof or
        // runtime-issued publication. Source/render ids need no engine here.
        let identity = CapturedWebFrameIdentity {
            owner: Weak::new(),
            session_id: "\0".repeat(super::super::MAX_FRAME_SESSION_BYTES),
            frame_id: u64::MAX - 1,
            config_generation: u64::MAX,
            logical_width: u32::MAX as f32,
            logical_height: u32::MAX as f32,
            width: 4096,
            height: 1024,
            preview_epoch: u64::MAX,
        };
        let ticket = DevRasterPresentationTicket {
            version: "1.0".into(),
            presentation_epoch: u64::MAX.to_string(),
            target: DevRasterPresentationTarget {
                session_id: identity.session_id.clone(),
                preview_id: "x".repeat(128),
                preview_generation: u64::MAX,
                frame_id: identity.frame_id,
                source_frame_id: u64::MAX,
                render_revision: u64::MAX,
                config_generation: u64::MAX,
                logical_width: u32::MAX,
                logical_height: u32::MAX,
                width: identity.width,
                height: identity.height,
            },
        };
        let mut metadata = ticketed_metadata(&identity, &ticket);
        metadata["renderMs"] = f64::MAX.into();
        let mut header = std::io::Cursor::new([0_u8; super::super::MAX_FRAME_METADATA_BYTES]);
        serde_json::to_writer(&mut header, &metadata)
            .expect("bounded v2 schema outgrew its reservation");
        let decoded: serde_json::Value =
            serde_json::from_slice(&header.get_ref()[..header.position() as usize]).unwrap();
        assert_eq!(
            decoded["presentationTicket"],
            serde_json::to_value(ticket).unwrap()
        );
        assert_eq!(decoded["sessionId"], identity.session_id);
        assert_eq!(decoded["frameId"], (u64::MAX - 1).to_string());
        assert_eq!(decoded["configGeneration"], u64::MAX.to_string());
    }
}

#[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
mod tests {
    use super::*;
    use crate::web::{sse_preview_tests, PreviewFence, WebSurface, WebSurfaceHandle};
    use crate::{Simulator, SimulatorConfig};
    use container_core::EngineKind;
    use container_render_skia::{PageRenderMode, Rect};
    use container_runtime::DevRasterPresentationTarget;
    use std::{
        io::{Read, Write},
        net::TcpStream,
        time::{Duration, Instant},
    };

    fn engines() -> Vec<EngineKind> {
        vec![
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ]
    }

    fn start(pack: &std::path::Path, engine: EngineKind) -> Simulator {
        let mut simulator = Simulator::from_pack_dir(
            pack,
            SimulatorConfig {
                engine,
                page_render_mode: PageRenderMode::Raster,
                viewport: Rect {
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
        simulator
    }

    fn resolve(handle: &WebSurfaceHandle, simulator: &mut Simulator) {
        handle
            .resolve_preview_controls(|retirement| {
                simulator
                    .retire_dev_preview(retirement.reason())
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .unwrap();
    }

    fn connect(
        surface: &mut WebSurface,
        handle: &WebSurfaceHandle,
        simulator: &mut Simulator,
    ) -> (TcpStream, PreviewOwnerFence) {
        let (peer, _) = sse_preview_tests::open(surface, "owner");
        resolve(handle, simulator);
        let epoch = handle.shared.lock().unwrap().preview.epoch;
        let proof = handle
            .capture_preview_owner(&PreviewFence {
                client_id: "owner".into(),
                epoch: epoch.to_string(),
                request_revision: None,
            })
            .unwrap();
        (peer, proof)
    }

    fn retire(
        surface: &mut WebSurface,
        handle: &WebSurfaceHandle,
        simulator: &mut Simulator,
        peer: TcpStream,
        proof: &PreviewOwnerFence,
    ) {
        drop(peer);
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            surface.poll().unwrap();
            resolve(handle, simulator);
            if handle.validate_preview_owner(proof).is_err() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "actual EOF did not retire the preview"
            );
            std::thread::yield_now();
        }
        assert!(handle.shared.lock().unwrap().preview.owner.is_none());
    }

    fn target(
        reservation: &WebFrameReservation<'_>,
        preview: &PreviewOwnerFence,
        session: &container_runtime::Session,
    ) -> DevRasterPresentationTarget {
        let id = reservation.identity();
        let observed = session.accepted_page_observation().unwrap();
        DevRasterPresentationTarget {
            session_id: id.session_id().to_owned(),
            preview_id: preview.client_id().into(),
            preview_generation: preview.epoch(),
            frame_id: id.frame_id(),
            source_frame_id: observed.frame.frame_id,
            render_revision: observed.render_revision,
            config_generation: id.config_generation(),
            logical_width: id.logical_width() as u32,
            logical_height: id.logical_height() as u32,
            width: id.width(),
            height: id.height(),
        }
    }

    fn get_frame(surface: &mut WebSurface) -> Vec<u8> {
        let mut peer = TcpStream::connect(surface.local_addr()).unwrap();
        peer.write_all(b"GET /api/frame HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .unwrap();
        peer.set_nonblocking(true).unwrap();
        let mut wire = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            surface.poll().unwrap();
            let mut chunk = [0_u8; 4096];
            match peer.read(&mut chunk) {
                Ok(0) => return wire,
                Ok(count) => wire.extend_from_slice(&chunk[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => panic!("actual frame TCP response: {error}"),
            }
            assert!(
                Instant::now() < deadline,
                "actual frame TCP response did not close"
            );
            std::thread::yield_now();
        }
    }

    #[test]
    fn actual_v2_http_preserves_exact_runtime_ticket_and_full_u64_without_early_ack() {
        let pack = crate::web::density_tests::fixture::new();
        for engine in engines() {
            let mut simulator = start(&pack.0, engine);
            let (mut surface, handle) = sse_preview_tests::setup();
            let (peer, proof) = connect(&mut surface, &handle, &mut simulator);
            let session_id = simulator.session_id().to_owned();
            {
                let mut shared = handle.shared.lock().unwrap();
                shared.transport_session = session_id.clone();
                shared.next_transport_frame = u64::MAX - 1;
            }
            let session = simulator.host_mut().session_mut().unwrap();
            let reservation = handle
                .reserve_frame(&session_id, u64::MAX, 2.0, 1.0, 2, 1)
                .unwrap();
            let target = target(&reservation, &proof, session);
            let runtime = session.prepare_dev_raster_presentation(target).unwrap();
            let ticket = runtime.ticket().clone();
            let observed = runtime.accepted_page_observation();
            let pixels = observed.snapshot.unwrap().pixels.clone();
            let pointer = observed.snapshot.unwrap().pixels.as_ptr();
            let transport = reservation
                .prepare_dev_raster(&runtime, &proof, 1.25)
                .unwrap();
            let retired = runtime.accept();
            transport.install();
            drop(retired);
            assert!(
                !session.is_current_frame_presented(),
                "Web publication is not RAF"
            );
            let wire = get_frame(&mut surface);
            let split = wire
                .windows(4)
                .position(|bytes| bytes == b"\r\n\r\n")
                .unwrap();
            let header = std::str::from_utf8(&wire[..split]).unwrap();
            assert!(header.starts_with("HTTP/1.1 200"));
            assert!(header.contains("Content-Type: application/vnd.weapp.frame.v2"));
            let body = &wire[split + 4..];
            let length = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
            let metadata: serde_json::Value = serde_json::from_slice(&body[4..4 + length]).unwrap();
            assert_eq!(metadata["schemaVersion"], 2);
            assert_eq!(metadata["protocolVersion"], "2.0");
            assert_eq!(
                metadata["presentationTicket"],
                serde_json::to_value(&ticket).unwrap()
            );
            assert_eq!(metadata["frameId"], (u64::MAX - 1).to_string());
            assert_eq!(metadata["configGeneration"], u64::MAX.to_string());
            assert_eq!(
                metadata["sourceFrameId"],
                ticket.target.source_frame_id.to_string()
            );
            assert_eq!(
                metadata["renderRevision"],
                ticket.target.render_revision.to_string()
            );
            assert_eq!(&body[4 + length..], pixels);
            assert!(
                !session.is_current_frame_presented(),
                "HTTP delivery is not RAF"
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
                pointer
            );
            retire(&mut surface, &handle, &mut simulator, peer, &proof);
            assert!(!simulator
                .host()
                .session()
                .unwrap()
                .is_current_frame_presented());
        }
    }

    #[test]
    fn other_surface_owner_cannot_publish_equal_ticket_values_or_consume_authority() {
        let pack = crate::web::density_tests::fixture::new();
        for engine in engines() {
            let mut simulator = start(&pack.0, engine);
            let (mut surface, handle) = sse_preview_tests::setup();
            let (mut other, other_handle) = sse_preview_tests::setup();
            let (peer, proof) = connect(&mut surface, &handle, &mut simulator);
            let (other_peer, foreign) = connect(&mut other, &other_handle, &mut simulator);
            assert_eq!(proof.client_id(), foreign.client_id());
            assert_eq!(proof.epoch(), foreign.epoch());
            let session_id = simulator.session_id().to_owned();
            let session = simulator.host_mut().session_mut().unwrap();
            let reservation = handle
                .reserve_frame(&session_id, 1, 2.0, 1.0, 2, 1)
                .unwrap();
            let expected = target(&reservation, &proof, session);
            let runtime = session
                .prepare_dev_raster_presentation(expected.clone())
                .unwrap();
            let ticket = runtime.ticket().clone();
            let rejected = reservation.prepare_dev_raster(&runtime, &foreign, 0.0);
            assert!(matches!(&rejected, Err(error) if error.contains("another Web surface")));
            drop(rejected);
            drop(runtime);
            {
                let shared = handle.shared.lock().unwrap();
                assert!(shared.frame.is_none());
                assert_eq!(shared.next_transport_frame, 1);
                assert_eq!(shared.live_frame_claim_bytes(None), 0);
            }
            let retry = session.prepare_dev_raster_presentation(expected).unwrap();
            assert_eq!(
                retry.ticket(),
                &ticket,
                "failed publication spent runtime epoch"
            );
            drop(retry);
            retire(
                &mut other,
                &other_handle,
                &mut simulator,
                other_peer,
                &foreign,
            );
            retire(&mut surface, &handle, &mut simulator, peer, &proof);
        }
    }

    #[test]
    fn coordinated_publication_is_atomic_and_deduplicates_pending_and_acknowledged_frames() {
        let pack = crate::web::density_tests::fixture::new();
        for engine in engines() {
            let mut simulator = start(&pack.0, engine);
            let (mut surface, handle) = sse_preview_tests::setup();
            let (peer, proof) = connect(&mut surface, &handle, &mut simulator);
            let pointer = simulator
                .host()
                .session()
                .unwrap()
                .accepted_page_observation()
                .unwrap()
                .snapshot
                .unwrap()
                .pixels
                .as_ptr();
            assert!(simulator
                .publish_dev_raster_frame(&handle, &proof, 1)
                .unwrap());
            let ticket = simulator
                .host()
                .session()
                .unwrap()
                .current_dev_raster_presentation_ticket()
                .unwrap()
                .clone();
            let (response, sequence) = {
                let shared = handle.shared.lock().unwrap();
                (
                    std::sync::Arc::clone(&shared.frame.as_ref().unwrap().response),
                    shared.next_transport_frame,
                )
            };
            assert!(!simulator
                .host()
                .session()
                .unwrap()
                .is_current_frame_presented());
            assert!(!simulator
                .publish_dev_raster_frame(&handle, &proof, 1)
                .unwrap());
            {
                let shared = handle.shared.lock().unwrap();
                assert!(std::sync::Arc::ptr_eq(
                    &response,
                    &shared.frame.as_ref().unwrap().response
                ));
                assert_eq!(shared.next_transport_frame, sequence);
            }
            let wire = get_frame(&mut surface);
            assert_eq!(
                wire.as_slice(),
                response.as_slice(),
                "actual TCP served different committed bytes"
            );
            let session = simulator.host_mut().session_mut().unwrap();
            assert_eq!(
                session.current_dev_raster_presentation_ticket(),
                Some(&ticket)
            );
            session
                .acknowledge_dev_raster_presentation(&ticket)
                .unwrap();
            assert!(session.is_current_frame_presented());
            assert!(!simulator
                .publish_dev_raster_frame(&handle, &proof, 1)
                .unwrap());
            assert_eq!(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .current_dev_raster_presentation_ticket(),
                Some(&ticket)
            );
            // Configuration generation is part of the immutable publication,
            // even when the existing pixels and View result remain identical.
            assert!(simulator
                .publish_dev_raster_frame(&handle, &proof, 2)
                .unwrap());
            let session = simulator.host_mut().session_mut().unwrap();
            let next = session
                .current_dev_raster_presentation_ticket()
                .unwrap()
                .clone();
            assert_eq!(next.target.config_generation, 2);
            assert_eq!(next.target.frame_id, ticket.target.frame_id + 1);
            assert_ne!(next.presentation_epoch, ticket.presentation_epoch);
            assert_eq!(next.target.render_revision, ticket.target.render_revision);
            assert_eq!(
                session
                    .accepted_page_observation()
                    .unwrap()
                    .snapshot
                    .unwrap()
                    .pixels
                    .as_ptr(),
                pointer
            );
            assert!(!session.is_current_frame_presented());
            assert!(session
                .acknowledge_dev_raster_presentation(&ticket)
                .is_err());
            assert_eq!(
                session.current_dev_raster_presentation_ticket(),
                Some(&next)
            );
            assert!(!simulator
                .publish_dev_raster_frame(&handle, &proof, 2)
                .unwrap());
            retire(&mut surface, &handle, &mut simulator, peer, &proof);
            assert!(simulator
                .host()
                .session()
                .unwrap()
                .current_dev_raster_presentation_ticket()
                .is_none());
        }
    }

    #[test]
    fn coordinated_preflight_failure_keeps_old_publication_and_never_promotes_default_policy() {
        let pack = crate::web::density_tests::fixture::new();
        for engine in engines() {
            let mut simulator = start(&pack.0, engine);
            let (mut surface, handle) = sse_preview_tests::setup();
            let (mut other, other_handle) = sse_preview_tests::setup();
            let (peer, proof) = connect(&mut surface, &handle, &mut simulator);
            let (other_peer, foreign) = connect(&mut other, &other_handle, &mut simulator);
            assert!(simulator
                .publish_dev_raster_frame(&handle, &proof, 1)
                .unwrap());
            let ticket = simulator
                .host()
                .session()
                .unwrap()
                .current_dev_raster_presentation_ticket()
                .unwrap()
                .clone();
            let (response, sequence) = {
                let shared = handle.shared.lock().unwrap();
                (
                    std::sync::Arc::clone(&shared.frame.as_ref().unwrap().response),
                    shared.next_transport_frame,
                )
            };
            let error = simulator
                .publish_dev_raster_frame(&handle, &foreign, 2)
                .unwrap_err();
            assert!(error.contains("another Web surface"), "{error}");
            // Real non-wrapping counter exhaustion exercises reservation failure
            // before runtime preparation. This is not a fake allocator hook.
            handle.shared.lock().unwrap().publication_epoch = None;
            let error = simulator
                .publish_dev_raster_frame(&handle, &proof, 2)
                .unwrap_err();
            assert!(error.contains("exhaust"), "{error}");
            {
                let shared = handle.shared.lock().unwrap();
                assert!(std::sync::Arc::ptr_eq(
                    &response,
                    &shared.frame.as_ref().unwrap().response
                ));
                assert_eq!(shared.next_transport_frame, sequence);
                assert_eq!(shared.live_frame_claim_bytes(None), 0);
            }
            let session = simulator.host_mut().session_mut().unwrap();
            assert_eq!(
                session.current_dev_raster_presentation_ticket(),
                Some(&ticket)
            );
            session
                .acknowledge_dev_raster_presentation(&ticket)
                .unwrap();
            assert!(session.is_current_frame_presented());
            retire(
                &mut other,
                &other_handle,
                &mut simulator,
                other_peer,
                &foreign,
            );
            retire(&mut surface, &handle, &mut simulator, peer, &proof);

            let mut default = Simulator::from_pack_dir(
                &pack.0,
                SimulatorConfig {
                    engine,
                    page_render_mode: PageRenderMode::Raster,
                    ..Default::default()
                },
            )
            .unwrap();
            let (mut surface, handle) = sse_preview_tests::setup();
            let (peer, proof) = connect(&mut surface, &handle, &mut default);
            assert!(
                !default
                    .host()
                    .session()
                    .unwrap()
                    .page_render_status()
                    .page_object_initialized
            );
            let error = default
                .publish_dev_raster_frame(&handle, &proof, 1)
                .unwrap_err();
            assert!(error.contains("ERR_UNSUPPORTED_CAPABILITY"), "{error}");
            assert!(
                !default
                    .host()
                    .session()
                    .unwrap()
                    .page_render_status()
                    .page_object_initialized
            );
            assert!(handle.shared.lock().unwrap().frame.is_none());
            retire(&mut surface, &handle, &mut default, peer, &proof);
        }
    }
}
