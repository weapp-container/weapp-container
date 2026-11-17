//! Hook-safe capacity ownership; these tests require no engine or browser.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;

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

fn external_frame() -> RenderFrame {
    let viewport = container_render_skia::Rect {
        x: 0.0,
        y: 0.0,
        width: 2.0,
        height: 1.0,
    };
    RenderFrame {
        frame_id: 1,
        viewport,
        root: container_render_skia::RenderNode::new("page", viewport),
        images: BTreeMap::new(),
    }
}

fn exchange(surface: &mut WebSurface, path: &str) -> Vec<u8> {
    let address = surface.local_addr();
    let wire = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n");
    let client = thread::spawn(move || {
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream.write_all(wire.as_bytes()).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        response
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    while !client.is_finished() && Instant::now() < deadline {
        surface.poll().unwrap();
        thread::sleep(Duration::from_millis(1));
    }
    client.join().unwrap()
}

#[test]
fn capacity_lease_allows_same_surface_http_and_owner_reentry_before_final_prepare() {
    let mut surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle
        .publish_frame("hooks", 1, 2.0, 1.0, &pixels(1))
        .unwrap();
    let reservation = handle.reserve_frame("hooks", 2, 2.0, 1.0, 2, 1).unwrap();
    assert!(
        handle.shared.try_lock().is_ok(),
        "hooks must not inherit a Web guard"
    );

    // The old picture and state remain readable while the owner prepares a
    // candidate. Ordinary diagnostics may append SSE entries during hooks.
    assert!(exchange(&mut surface, "/api/state").starts_with(b"HTTP/1.1 200"));
    assert!(exchange(&mut surface, "/api/frame").starts_with(b"HTTP/1.1 200"));
    handle.publish("diagnostic", json!({"phase":"resize-hook"}));
    let epoch = handle.shared.lock().unwrap().publication_epoch;
    let next_event = handle.shared.lock().unwrap().next_event_id;
    let prepared = reservation.prepare(&pixels(2), 2, 0.5).unwrap();
    prepared
        .with_presentation(json!({"generation":2}))
        .install();

    let shared = handle.shared.lock().unwrap();
    assert_eq!(shared.frame.as_ref().unwrap().snapshot, pixels(2));
    assert_eq!(shared.next_transport_frame, 3);
    assert_eq!(shared.next_event_id, next_event + 1);
    assert_eq!(shared.publication_epoch, epoch.map(|value| value + 1));
    assert_eq!(shared.live_frame_claim_bytes(None), 0);
}

#[test]
fn competing_publication_supersedes_a_capacity_lease_without_reusing_its_sequence() {
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle
        .publish_frame("race", 1, 2.0, 1.0, &pixels(1))
        .unwrap();
    let stale = handle.reserve_frame("race", 2, 2.0, 1.0, 2, 1).unwrap();
    let winner = handle.reserve_frame("race", 3, 2.0, 1.0, 2, 1).unwrap();
    winner.prepare(&pixels(3), 3, 0.0).unwrap().install();
    let accepted = {
        let shared = handle.shared.lock().unwrap();
        Arc::clone(&shared.frame.as_ref().unwrap().response)
    };
    let result = stale.prepare(&pixels(2), 2, 0.0);
    assert!(matches!(&result, Err(error) if error.contains("superseded")));
    drop(result);
    let shared = handle.shared.lock().unwrap();
    assert!(Arc::ptr_eq(
        &accepted,
        &shared.frame.as_ref().unwrap().response
    ));
    assert_eq!(shared.frame.as_ref().unwrap().metadata["frameId"], 2);
    assert_eq!(shared.next_transport_frame, 3);
    assert_eq!(shared.live_frame_claim_bytes(None), 0);
}

#[test]
fn settings_retirement_and_legacy_picture_aba_cannot_revive_captured_publication() {
    for mutation in 0..8 {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle
            .publish_frame("aba", 1, 2.0, 1.0, &pixels(1))
            .unwrap();
        let lease = handle.reserve_frame("aba", 2, 2.0, 1.0, 2, 1).unwrap();
        match mutation {
            0 => {
                handle.set_presentation(json!({"generation":2}));
                handle.set_presentation(json!({"generation":1}));
            }
            1 => {
                handle.clear_snapshot();
                handle
                    .publish_frame("aba", 1, 2.0, 1.0, &pixels(1))
                    .unwrap();
            }
            2 => handle.set_snapshot(json!({"pixels":[1,2,3,4]})),
            3 => {
                handle.publish("snapshot", json!({"pixels":[1,2,3,4]}));
            }
            4 => {
                handle
                    .publish_render_frame_at_scale("aba", 1, &external_frame(), 2, 0.0, 1.0)
                    .unwrap();
            }
            5 => handle
                .prepare_presentation(json!({"generation":2}))
                .unwrap()
                .install(),
            6 => {
                handle.configure_browser_view();
                handle
                    .set_renderer_profile(container_ir::RendererProfile::WebView)
                    .unwrap();
                handle
                    .set_renderer_profile(container_ir::RendererProfile::Skia)
                    .unwrap();
            }
            7 => {
                handle
                    .publish_frame("other-session", 1, 2.0, 1.0, &pixels(1))
                    .unwrap();
                handle
                    .publish_frame("aba", 1, 2.0, 1.0, &pixels(1))
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let result = lease.prepare(&pixels(2), 2, 0.0);
        assert!(
            matches!(&result, Err(error) if error.contains("superseded")),
            "mutation {mutation}"
        );
        drop(result);
        assert_eq!(
            handle.shared.lock().unwrap().live_frame_claim_bytes(None),
            0
        );
    }
}

#[test]
fn live_capacity_lease_is_charged_to_raster_external_http_and_legacy_json_admission() {
    let mut surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    let lease = handle.reserve_frame("budget", 1, 2.0, 1.0, 2, 1).unwrap();
    let claim_bytes = lease.claim.bytes;
    let slow_client = Arc::new(vec![0_u8]);
    {
        let mut shared = handle.shared.lock().unwrap();
        // Charge a live slow-client buffer without allocating 64 MiB here.
        shared.retained_response_bytes.push(RetainedResponseBytes {
            bytes: Arc::downgrade(&slow_client),
            length: MAX_FRAME_CACHE_BYTES - claim_bytes,
        });
    }
    assert!(handle.reserve_frame("other", 1, 2.0, 1.0, 2, 1).is_err());
    assert!(handle
        .prepare_render_frame_at_scale("other", 1, &external_frame(), 1, 0.0, 1.0)
        .is_err());
    assert!(
        exchange(&mut surface, "/api/state").is_empty(),
        "HTTP cannot spend the reserved capacity"
    );
    {
        let shared = handle.shared.lock().unwrap();
        let retained = shared
            .retained_response_bytes
            .iter()
            .map(|entry| entry.length)
            .sum::<usize>()
            + shared.live_frame_claim_bytes(None);
        assert!(bounded_snapshot_json(&pixels(1), retained).is_err());
    }
    // Finalization excludes only this exact Arc claim, rather than double
    // charging it or identifying it by a forgeable session/generation field.
    lease.prepare(&pixels(1), 1, 0.0).unwrap().install();
    let shared = handle.shared.lock().unwrap();
    assert_eq!(shared.live_frame_claim_bytes(None), 0);
    assert!(shared.frame.is_some());
}

#[test]
fn cancelled_capacity_leases_release_without_a_lock_even_when_the_store_is_poisoned() {
    for finalize in [false, true] {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let lease = handle.reserve_frame("poison", 1, 2.0, 1.0, 2, 1).unwrap();
        let claim = Arc::downgrade(&lease.claim);
        let shared = Arc::clone(&handle.shared);
        assert!(thread::spawn(move || {
            let _guard = shared.lock().unwrap();
            panic!("test-only Web store poison");
        })
        .join()
        .is_err());
        if finalize {
            let result = lease.prepare(&pixels(1), 1, 0.0);
            assert!(matches!(&result, Err(error) if error.contains("store unavailable")));
            drop(result);
        } else {
            drop(lease);
        }
        assert!(claim.upgrade().is_none());
    }
}

#[test]
fn capacity_lease_count_is_bounded_and_dropping_does_not_consume_transport_identity() {
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    let leases = (0..MAX_FRAME_RESERVATIONS)
        .map(|_| handle.reserve_frame("count", 1, 2.0, 1.0, 2, 1).unwrap())
        .collect::<Vec<_>>();
    assert!(
        matches!(handle.reserve_frame("count", 1, 2.0, 1.0, 2, 1), Err(error) if error.contains("lease count"))
    );
    drop(leases);
    {
        let shared = handle.shared.lock().unwrap();
        assert_eq!(shared.next_transport_frame, 1);
        assert_eq!(shared.transport_session, "");
        assert_eq!(shared.live_frame_claim_bytes(None), 0);
        assert_eq!(shared.publication_epoch, Some(1));
    }
    handle
        .reserve_frame("count", 1, 2.0, 1.0, 2, 1)
        .unwrap()
        .prepare(&pixels(1), 1, 0.0)
        .unwrap()
        .install();
    assert_eq!(
        handle
            .shared
            .lock()
            .unwrap()
            .frame
            .as_ref()
            .unwrap()
            .metadata["frameId"],
        1
    );
}

#[test]
fn publication_epoch_exhaustion_rejects_preparation_without_resurrecting_identity() {
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle.shared.lock().unwrap().publication_epoch = Some(u64::MAX);
    assert!(
        matches!(handle.reserve_frame("epoch", 1, 2.0, 1.0, 2, 1), Err(error) if error.contains("epoch exhausted"))
    );
    assert!(handle
        .prepare_presentation(json!({"generation":1}))
        .is_err());
    assert!(handle
        .prepare_render_frame_at_scale("epoch", 1, &external_frame(), 1, 0.0, 1.0)
        .is_err());
    handle.clear_snapshot();
    assert_eq!(handle.shared.lock().unwrap().publication_epoch, None);
    assert!(handle.reserve_frame("epoch", 1, 2.0, 1.0, 2, 1).is_err());
    assert_eq!(handle.shared.lock().unwrap().next_transport_frame, 1);
}

#[test]
fn replaced_picture_owners_release_after_the_publication_guard_is_unlocked() {
    struct LockOnDrop {
        shared: Arc<Mutex<Shared>>,
        released: Arc<AtomicBool>,
    }
    impl Drop for LockOnDrop {
        fn drop(&mut self) {
            assert!(
                self.shared.try_lock().is_ok(),
                "resource release must follow Web unlock"
            );
            self.released.store(true, Ordering::SeqCst);
        }
    }
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    let released = Arc::new(AtomicBool::new(false));
    let probe = LockOnDrop {
        shared: Arc::clone(&handle.shared),
        released: Arc::clone(&released),
    };
    release_after_web_unlock(handle.shared.lock().unwrap(), probe);
    assert!(released.load(Ordering::SeqCst));

    handle
        .publish_frame("retire", 1, 2.0, 1.0, &pixels(1))
        .unwrap();
    let slow_client = Arc::clone(
        &handle
            .shared
            .lock()
            .unwrap()
            .frame
            .as_ref()
            .unwrap()
            .response,
    );
    let previous = Arc::downgrade(&slow_client);
    handle
        .reserve_frame("retire", 2, 2.0, 1.0, 2, 1)
        .unwrap()
        .prepare(&pixels(2), 2, 0.0)
        .unwrap()
        .install();
    assert_eq!(
        Arc::strong_count(&slow_client),
        1,
        "only the real slow client retains old bytes"
    );
    assert!(handle.shared.try_lock().is_ok());
    drop(slow_client);
    assert!(previous.upgrade().is_none());
    assert_eq!(
        handle
            .shared
            .lock()
            .unwrap()
            .frame
            .as_ref()
            .unwrap()
            .snapshot,
        pixels(2)
    );
}

#[test]
fn real_install_keeps_retired_source_charged_until_its_unlocked_release() {
    struct ResetObserver;
    impl Drop for ResetObserver {
        fn drop(&mut self) {
            WEB_RETIREMENT_OBSERVER.with(|observer| {
                drop(observer.borrow_mut().take());
            });
        }
    }
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle
        .publish_frame("source-window", 1, 2.0, 1.0, &pixels(1))
        .unwrap();
    let (old_source_bytes, slow_client) = {
        let shared = handle.shared.lock().unwrap();
        let frame = shared.frame.as_ref().unwrap();
        (
            frame.snapshot.pixels.capacity(),
            Arc::clone(&frame.response),
        )
    };
    let lease = handle
        .reserve_frame("source-window", 2, 2.0, 1.0, 2, 1)
        .unwrap();
    let prepared = lease.prepare(&pixels(2), 2, 0.0).unwrap();
    let shared = Arc::clone(&handle.shared);
    let requested = Arc::new(AtomicUsize::new(0));
    let observed = Arc::new(AtomicBool::new(false));
    let requested_in_window = Arc::clone(&requested);
    let observed_in_window = Arc::clone(&observed);
    let _reset = ResetObserver;
    WEB_RETIREMENT_OBSERVER.with(|observer| {
        *observer.borrow_mut() = Some(Box::new(move || {
            let mut state = shared
                .try_lock()
                .expect("actual install must have unlocked");
            assert_eq!(state.live_frame_claim_count(FrameClaimKind::Candidate), 0);
            assert_eq!(
                state.live_frame_claim_count(FrameClaimKind::RetiredSource),
                1
            );
            assert_eq!(state.live_frame_claim_bytes(None), old_source_bytes);
            let accepted_bytes = state
                .retained_response_bytes
                .iter()
                .filter(|entry| entry.bytes.strong_count() > 0)
                .map(|entry| entry.length)
                .sum::<usize>()
                + state.frame.as_ref().unwrap().snapshot.pixels.capacity();
            let extra = MAX_FRAME_CACHE_BYTES - accepted_bytes;
            requested_in_window.store(extra, Ordering::SeqCst);
            assert!(
                state.ensure_frame_capacity(extra, 0, 0).is_err(),
                "the old source must remain charged after it leaves Shared.frame"
            );
            observed_in_window.store(true, Ordering::SeqCst);
        }));
    });
    prepared.install();
    assert!(observed.load(Ordering::SeqCst));
    let mut state = handle.shared.lock().unwrap();
    assert_eq!(state.live_frame_claim_bytes(None), 0);
    assert!(state
        .ensure_frame_capacity(requested.load(Ordering::SeqCst), 0, 0)
        .is_ok());
    drop(state);
    drop(slow_client);
}

#[test]
fn transient_retirement_charges_have_separate_bounds_and_dead_entries_do_not_block_reuse() {
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle
        .publish_frame("retirement-count", 1, 2.0, 1.0, &pixels(1))
        .unwrap();
    let retired = (0..MAX_FRAME_RESERVATIONS)
        .map(|_| {
            Arc::new(FrameCapacityClaim {
                bytes: 1,
                kind: FrameClaimKind::RetiredSource,
            })
        })
        .collect::<Vec<_>>();
    {
        let mut shared = handle.shared.lock().unwrap();
        shared
            .frame_capacity_claims
            .extend(retired.iter().map(Arc::downgrade));
    }
    // Retirement markers do not consume the separate candidate lease count,
    // but another replacement cannot exceed the retirement bookkeeping cap.
    let candidate = handle
        .reserve_frame("retirement-count", 2, 2.0, 1.0, 2, 1)
        .unwrap();
    let result = candidate.prepare(&pixels(2), 2, 0.0);
    assert!(matches!(&result, Err(error) if error.contains("retired source accounting count")));
    drop(result);
    assert_eq!(
        handle
            .shared
            .lock()
            .unwrap()
            .frame
            .as_ref()
            .unwrap()
            .snapshot,
        pixels(1)
    );
    drop(retired);
    handle
        .reserve_frame("retirement-count", 2, 2.0, 1.0, 2, 1)
        .unwrap()
        .prepare(&pixels(2), 2, 0.0)
        .unwrap()
        .install();
    let shared = handle.shared.lock().unwrap();
    assert_eq!(shared.live_frame_claim_count(FrameClaimKind::Candidate), 0);
    assert_eq!(
        shared.live_frame_claim_count(FrameClaimKind::RetiredSource),
        0
    );
    assert_eq!(shared.frame.as_ref().unwrap().snapshot, pixels(2));
}

#[test]
fn cancellation_keeps_its_weak_charge_alive_until_all_candidate_buffers_are_released() {
    for reject_contract in [false, true] {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let mut lease = handle
            .reserve_frame("cancel-window", 1, 2.0, 1.0, 2, 1)
            .unwrap();
        let weak = Arc::downgrade(&lease.claim);
        let weak_in_window = weak.clone();
        let expected = lease.claim.bytes;
        let shared = Arc::clone(&handle.shared);
        let observed = Arc::new(AtomicBool::new(false));
        let observed_in_window = Arc::clone(&observed);
        lease.cancellation_probe = Some(FrameReservationDropProbe(Some(Box::new(move || {
            // This field drops after response/source/metadata, but before the
            // final charge. The old claim-before-Vec layout fails this probe.
            assert!(weak_in_window.upgrade().is_some());
            let mut state = shared
                .try_lock()
                .expect("cancellation must not acquire a Web guard");
            assert_eq!(state.live_frame_claim_bytes(None), expected);
            assert!(state
                .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
                .is_err());
            observed_in_window.store(true, Ordering::SeqCst);
        }))));
        if reject_contract {
            let mut invalid = pixels(1);
            invalid.width = 1;
            let result = lease.prepare(&invalid, 1, 0.0);
            assert!(matches!(&result, Err(error) if error.contains("reserved frame contract")));
            drop(result);
        } else {
            drop(lease);
        }
        assert!(observed.load(Ordering::SeqCst));
        assert!(weak.upgrade().is_none());
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
            .is_ok());
    }
}

#[test]
fn shared_body_admission_charges_spare_capacity_without_spending_a_live_frame_lease() {
    let mut surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle
        .publish_frame("shared-body", 1, 2.0, 1.0, &pixels(1))
        .unwrap();
    let old = Arc::clone(
        &handle
            .shared
            .lock()
            .unwrap()
            .frame
            .as_ref()
            .unwrap()
            .response,
    );
    let lease = handle
        .reserve_frame("shared-body", 2, 2.0, 1.0, 2, 1)
        .unwrap();
    let slow_client = Arc::new(vec![0_u8]);
    {
        let mut shared = handle.shared.lock().unwrap();
        let charged = shared
            .retained_response_bytes
            .iter()
            .map(|entry| entry.length)
            .sum::<usize>()
            + shared.frame.as_ref().unwrap().snapshot.pixels.capacity()
            + shared.live_frame_claim_bytes(None);
        shared.retained_response_bytes.push(RetainedResponseBytes {
            bytes: Arc::downgrade(&slow_client),
            length: MAX_FRAME_CACHE_BYTES - charged - 2048,
        });
    }
    let mut oversized = Vec::with_capacity(4096);
    oversized.push(1_u8);
    let body = Arc::new(oversized);
    let body_weak = Arc::downgrade(&body);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let (stream, _) = listener.accept().unwrap();
    surface
        .queue_shared_body(&stream, 200, "application/octet-stream", Arc::clone(&body))
        .unwrap();
    drop(stream);
    let deadline = Instant::now() + Duration::from_secs(2);
    while !surface.pending_responses.is_empty() && Instant::now() < deadline {
        surface.flush_responses();
        thread::sleep(Duration::from_millis(1));
    }
    let mut response = Vec::new();
    peer.read_to_end(&mut response).unwrap();
    assert!(
        response.starts_with(b"HTTP/1.1 503"),
        "length alone would wrongly admit the body"
    );
    {
        let shared = handle.shared.lock().unwrap();
        assert!(!shared
            .retained_response_bytes
            .iter()
            .any(|entry| entry.bytes.ptr_eq(&body_weak)));
        assert!(Arc::ptr_eq(&old, &shared.frame.as_ref().unwrap().response));
    }
    lease.prepare(&pixels(2), 2, 0.0).unwrap().install();
    assert_eq!(
        handle
            .shared
            .lock()
            .unwrap()
            .frame
            .as_ref()
            .unwrap()
            .snapshot,
        pixels(2)
    );
}

#[test]
fn typed_frame_capture_matches_real_publication_and_actual_surface_allocation() {
    for next_session in ["retained", "replacement"] {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let other = WebSurface::localhost(0).unwrap();
        handle
            .publish_frame("retained", 1, 2.0, 1.0, &pixels(1))
            .unwrap();
        handle.shared.lock().unwrap().preview.epoch = 17;
        let reservation = handle
            .reserve_frame(next_session, u64::MAX, 2.0, 1.0, 2, 1)
            .unwrap();
        let frame_id = if next_session == "retained" { 2 } else { 1 };
        let identity = reservation.identity();
        assert!(identity.belongs_to(&handle));
        assert!(identity.belongs_to(&handle.clone()));
        assert!(!identity.belongs_to(&other.handle()));
        assert_eq!(identity.session_id(), next_session);
        assert_eq!(identity.frame_id(), frame_id);
        assert_eq!(identity.config_generation(), u64::MAX);
        assert_eq!(
            (identity.logical_width(), identity.logical_height()),
            (2.0, 1.0)
        );
        assert_eq!((identity.width(), identity.height()), (2, 1));
        assert_eq!(identity.preview_epoch(), 17);
        let before = {
            let shared = handle.shared.lock().unwrap();
            (
                shared.next_transport_frame,
                shared.live_frame_claim_bytes(None),
                shared.preview.epoch,
            )
        };
        for _ in 0..3 {
            assert_eq!(reservation.identity().frame_id(), frame_id);
        }
        {
            let shared = handle.shared.lock().unwrap();
            assert_eq!(
                (
                    shared.next_transport_frame,
                    shared.live_frame_claim_bytes(None),
                    shared.preview.epoch
                ),
                before
            );
        }
        reservation.prepare(&pixels(9), 10, 0.0).unwrap().install();
        let shared = handle.shared.lock().unwrap();
        let published = shared.frame.as_ref().unwrap();
        assert_eq!(published.metadata["sessionId"], next_session);
        assert_eq!(published.metadata["frameId"], frame_id);
        assert_eq!(published.metadata["configGeneration"], u64::MAX);
        assert_eq!(published.metadata["logicalWidth"], 2.0);
        assert_eq!(published.metadata["logicalHeight"], 1.0);
        assert_eq!(published.metadata["width"], 2);
        assert_eq!(published.metadata["height"], 1);
        assert_eq!(shared.transport_session, next_session);
        assert_eq!(shared.next_transport_frame, frame_id + 1);
    }
}

#[test]
fn typed_frame_capture_never_upgrades_a_superseded_reservation() {
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle
        .publish_frame("retained", 1, 2.0, 1.0, &pixels(1))
        .unwrap();
    let stale = handle.reserve_frame("retained", 2, 2.0, 1.0, 2, 1).unwrap();
    assert_eq!(stale.identity().frame_id(), 2);
    handle
        .reserve_frame("retained", 3, 2.0, 1.0, 2, 1)
        .unwrap()
        .prepare(&pixels(3), 3, 0.0)
        .unwrap()
        .install();
    assert_eq!(
        stale.identity().frame_id(),
        2,
        "captured facts do not become latest state"
    );
    let result = stale.prepare(&pixels(2), 2, 0.0);
    assert!(matches!(&result, Err(error) if error.contains("superseded")));
    drop(result);
    let shared = handle.shared.lock().unwrap();
    assert_eq!(shared.frame.as_ref().unwrap().render_revision, 3);
    assert_eq!(shared.next_transport_frame, 3);
    assert_eq!(shared.live_frame_claim_bytes(None), 0);
}

#[test]
fn bounded_ticketed_header_failure_preserves_old_frame_sequence_and_unlocked_capacity() {
    let surface = WebSurface::localhost(0).unwrap();
    let handle = surface.handle();
    handle
        .publish_frame("header-budget", 1, 2.0, 1.0, &pixels(1))
        .unwrap();
    let (old, sequence, epoch) = {
        let shared = handle.shared.lock().unwrap();
        (
            Arc::clone(&shared.frame.as_ref().unwrap().response),
            shared.next_transport_frame,
            shared.publication_epoch,
        )
    };
    let mut reservation = handle
        .reserve_frame("header-budget", 2, 2.0, 1.0, 2, 1)
        .unwrap();
    // Exercise the actual fixed-size writer, rather than a fake allocator or
    // passing a forged runtime ticket into the public prepared-ticket API.
    reservation.metadata["presentationTicket"] =
        json!({"oversized": "x".repeat(MAX_FRAME_METADATA_BYTES)});
    let rejected = reservation.prepare_encoded(&pixels(2), 2, 0.0, true);
    assert!(
        matches!(&rejected, Err(error) if error.contains("metadata exceeds its reserved bound"))
    );
    drop(rejected);
    let shared = handle
        .shared
        .try_lock()
        .expect("header error retained a Web lock");
    assert!(Arc::ptr_eq(&old, &shared.frame.as_ref().unwrap().response));
    assert_eq!(shared.next_transport_frame, sequence);
    assert_eq!(shared.publication_epoch, epoch);
    assert_eq!(shared.live_frame_claim_bytes(None), 0);
}
