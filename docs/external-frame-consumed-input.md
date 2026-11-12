# External frame consumed-input provenance

Generated frames retain the `BrowserPageInput` captured by
`load_manifest_view_input` immediately before cloning root page data. The
existing name remains for API compatibility; the same snapshot now follows
`ManifestViewInput → PreparedViewFrame → successful renderer.commit`. It does
not sample current state after component hooks, completed effects or ACK.

`Session::last_frame_input(render_revision)` returns the exact retained input
only for the current nonzero renderer-owned revision and live page/lifecycle.
The application's frameId is not that token. Later setData and ready hooks may
advance template input while this snapshot deliberately remains older.

`Session`, `WebHost` and `WebWasmHost` expose
`last_frame_input_json(render_revision)`. WASM takes the existing u64/BigInt
revision token. The read-only response is:

```json
{
  "version": "1.0",
  "sessionId": "session-1",
  "renderRevision": "8",
  "consumedInput": {
    "pageId": "1",
    "routePath": "pages/index/index",
    "templateRevision": "5",
    "viewport": { "x": 0, "y": 0, "width": 375, "height": 667 }
  }
}
```

Stale/zero render tokens fail with `ERR_CANCELLED`; they never report the latest
frame. A current frame without authoritative input has `consumedInput: null`.
That includes manual frames, explicit data (even equal to current data),
detached development previews and retired proofs. Page/template/render IDs
are canonical decimal strings. Rect is directly serialized as f32, exactly as
in RenderFrame; the browser DOM submission's f64 viewport conversion must not
be substituted for this external-frame wire contract.

Scale and scroll repaint accepted layout without reevaluating View. Their
successful new render revision inherits the previous input snapshot; rejection
keeps the old revision and proof. Diagnostic capture retains proof without
advancing it. HostSession uses these Session APIs instead of an unrestricted
renderer borrow. `renderer_mut` conservatively retires proof because a caller
can replace its entire renderer/revision namespace.

The shared page/visibility/manifest/coordinate invalidation boundaries retire
proof while retaining old pixels for diagnostics. Returning to the same page,
showing an app, or reusing an application frameId cannot revive it. A source
page retired by a component hook is not given a hidden proof on commit that
could become live later. Failed render work never records a new proof; it may
still have executed application hooks, and makes no claim of rolling them back.

These facts describe preparation and are separate from presentation/ACK and
input authority. Consumers must capture frame bytes, their exact revision and
this metadata on the serialized owner lane before ACK; they must not await an
ACK and then use runtime_state_json as the baseline. A frame.current/scale
path retains the consumed baseline; it never supplies current page data as a
new one. New product scheduling must negotiate the capability and validate
version/session/revision/viewport before relying on it. This patch adds the
runtime/host primitive, not Worker product negotiation or scheduler wiring.

The Rust tests cover real QuickJS/V8 root-clone vs attached/ACK writes,
retained scroll/scale, rejection, explicit/manual frames, detached previews,
lifetime invalidation, and the WebHost wire with fractional viewport values.
Their executed results are recorded separately from the contract. They are not
real browser, GPU, device or performance evidence.
