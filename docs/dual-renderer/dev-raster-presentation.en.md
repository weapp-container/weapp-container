<a id="开发态-raster-呈现所有权"></a>
# Development Mode Raster Ownership

[简体中文](dev-raster-presentation.md) · **English**


`Session::enable_dev_raster_presentation()` is explicitly enabled for precise receipt mode prior to `app.init`, page creation, and page renderer initialization. It does not introduce additional mandatory fields for `SessionConfig`; existing headless and embedded calls continue to use synchronous Raster semantics by default. The current development CLI has not yet enabled this mode.

After receiving the frame at runtime, input, selector geometry, intersection observer, and page/component ready events remain suspended. The surface owner must perform the following steps:

1. Bind the currently received frame to a unique active preview and an immutable Web frame publication.
2. Prepare a ticket via `prepare_dev_raster_presentation`, complete the response encoding only after it is successfully prepared, and accept the frame exactly as received. `arm_dev_raster_presentation` remains as a compatibility entry for immediate acceptance; neither performs JavaScript execution nor grants rendering privileges.
3. Upon the browser rendering the corresponding pixels in the next RAF (Request Animation Frame), it returns the ticket. The owner validates the preview lease and then, in the runtime thread, calls `acknowledge_dev_raster_presentation`. HTTP enqueue or send completion does not substitute this receipt.
4. On disconnection, surface loss, or publication expiration, invoke `suspend_dev_raster_presentation`. Retain diagnostic pixels and immediately revoke rendering privileges. This operation does not enter JavaScript, does not replay lifecycle, and does not stop business timers.

The ticket is precisely bound to session, preview, and generation, transmission frame, source frame, render revision, configuration generation, and logical/physical dimensions. All u64 identities are serialized as canonical decimal strings in JSON to avoid browser numeric precision loss. Duplicate ACKs for the same ticket are not re-executed; even if pixels and revision match after disconnection, a new epoch must be generated. New leases allow previously suspended observers to complete, while ready events are still executed only once per page lifecycle. Legacy revision-only ACKs are explicitly rejected under this mode.

`pageScrollTo({ selector })` consumes actual layout and uses the same rendering predicate. Without a valid receipt, it enters fail/complete via `ERR_RENDER` and cannot parse the old tree or report success. The numeric value `scrollTop` preserves the business intent of scrolling, and timers and explicit numeric scrolling continue to execute; new scrolling frames require their own rendering receipt.

Both accepted frames and scale candidates support ticket preparation. `PreparedDevDensity::prepare_raster_presentation` validates unaccepted candidate frames; `accept_with_retirement` combines mobile frame, input, and lease state. Discarded candidates do not consume an epoch and do not replace prior ACKs. Receipt retains old pixels and input/ticket allocations, and the Web publisher must release them only after the store is unlocked. Existing `Simulator::apply_web_density` already uses this release order and has not yet been integrated with tickets.

The renderer separately tracks staged and actual accepted scale factors. Identical accepted scale factors maintain the current precise ACK; changes in numeric scale—even if ceilinged to the same physical size—trigger an update to render revision and retirement of old privileges, with real pixels being reusable. Scale operations do not evaluate View state or replay ready events.

The ready/observer privileges described herein belong to runtime APIs. Unimplemented Web owner hooks include opt-in prior to startup or restart, disassociation between unique preview and SSE, binary header ticket, RAF ACK, and ticket preparation prior to joint scale publication. Existing DOM leases contain DOM-specific state and cannot be directly converted into Raster leases. ACKs may invoke application callbacks, but such callbacks must be called outside the Web store lock.

Logical resize hooks, host mirroring fixes, paint-ready candidates, and unblocked cross-hook capacity reserving remain handled by independent boundaries. Batched scrolling inputs preserve existing batch semantics; silent discarding of subsequent deltas is not performed on a per-event basis. These APIs cannot serve as evidence for Web connectivity, hardware GPU, performance, or seven-host acceptance.

Source code `ef4fb81fac9088e404839a1bfa2054defa17cb77` has passed formatting checks, runtime complete library (373 passed, 0 failed), strict Clippy in runtime and host-common, and complete host-common library (24 passed, 0 failed). All 17 runtime mandatory use cases and 24 host-common mandatory use cases have been successfully implemented, covering dual-engine ready, reconnect observer, and timer-triggered selector scrolling. Raw failed attempts and final results are available in [Verification Records](../archived-evidence.en.md). This checkpoint did not re-run the full workspace or browser, nor was the development CLI's receipt integration enabled.
