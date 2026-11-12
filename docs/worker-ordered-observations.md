# Worker ordered observations 1.0

This is an optional Worker/runtime contract. It does not wire the product entry,
install a presenter, or establish browser/GPU/performance acceptance.

## Negotiation and legacy compatibility

Opt in on load with `observation: { version: "1.0" }`. Missing means legacy:
load/state/frame/ACK/batch shapes and dirty events gain no observation fields, and
no new host exports are probed. External presentation 1.0 and observation 1.0 are
independent options; the Worker product should negotiate both for external-frame.

Before `app.init`, the Worker requires:

```js
host.observation_contract_json()
// exactly { version: '1.0', inputLifetime: '1.0' }
host.observation_state_json()
// { version:'1.0', inputLifetimeRevision:'0', state:<legacy runtime state> }
```

Handshake is pure and does not require a loaded session. The state export is
pure and is validated after manifest load but before application JS. Missing/old
exports, invalid request versions and missing lifetime tokens fail explicitly.
The original `runtime_state_json` export/shape remains unchanged. State export
before loading returns NotLoaded.

The successful load adds:

```js
observationContract: {
  version:'1.0', sequence:'u64', surfaceGeneration:'1.0', inputLifetime:'1.0',
},
observation: {
  version:'1.0', sequence:'1',
  state: {
    // all pure runtime/policy/fault observations, plus:
    owner: { workerEpoch, sessionId, packSha256, transportBackend },
    surfaceGeneration:'1', inputLifetimeRevision:'...',
    viewport:{ x:0, y:0, width:375, height:667 },
  },
}
```

packSha256 is the verified pack-index digest, not an arbitrary manifest digest.
Initialization state (Created, before launch/page) does not mint public sequences
or generations. Initial capture is tentative until complete load validation;
failed startup discards it, enables no ordinary work and starts no timer pump.
One Worker/session cannot reload. New session creation is the only namespace
reset after successful admission.

## One owner lane, original sequences

The serialized Worker lane exclusively assigns canonical u64 strings. Each
changed authoritative snapshot gets the next checked sequence. A no-op state
request reuses the existing sequence. Page-side response arrival order, RAF,
config revisions and viewRevision never manufacture sequences.

After an entered atomic host call, a finally refresh reads the pure native state
and hard-lifetime token. This includes bridge turns/batches, frame preparation,
retained frame reads, metrics, density, ACK effects, timers and error paths. The
original result/error/batch is retained; application callbacks are not replayed
for refresh. A successful response adds `.observation` alongside its old fields.
An error adds `.error.observation` alongside original error fields. Dirty events
carry `.payload.observation` with that exact snapshot/sequence. Load/state/frame/
ACK/metrics/scale can therefore refer to the same sequence: it is reused, not
renumbered for each transport path.

Runtime/owner/policy faults on the opt-in lane defer the single reserved fault
publication until finally refresh, then carry that observation on the fault.
This delivers committed timer-error state without needing normal event credit.
Fault publication still freezes consumers; it never grants presentation/input.
Admission-only errors/cancelled queued work reuse the last genuine snapshot and
never enter native state or advance counters. State requests retain control
admission for diagnostics. Shutdown samples committed unload state before
disposal, stops the lane and never lets a late response reactivate it.

copyOrderedObservation performs bounded plain-data copy/validation/freeze after
structured clone and preserves the exact source sequence. The page owner must
feed only newer sequences to its scheduler; a delayed response cannot overwrite
a newer dirty/fault observation. Observe outer response metadata before passing
its inner batch or ACK through compatibility helpers which may select only their
own known fields. onEvent must remain prompt and must not await presentation.

If a refresh itself fails after irreversible work, the response preserves the
original error details or committedResult plus observationRefreshError, and the
owner faults. It does not pretend rollback. Original batches are preserved only
within the complete response's existing byte/node/depth budget; an oversized
response can only deliver a bounded budget error, not a guaranteed full batch.

## Logical generation and native lifetime

surfaceGeneration starts at 1 and advances by one if the logical hard signature
changes: current page id/path, logical viewport, Active/non-Active authority or
the native input-lifetime token. Native token changes catch hidden same-turn
hide/show and push/pop returning to the old page. A token delta is not used as
the generation delta. Density, CSS zoom, ordinary data, ready setData, retained
repaints and diagnostic capture do not change logical generation. They may
change observation sequence because data/render state changed.

Session owns input_lifetime_revision: Option<u64>, starting Some(0). Hard
retirement uses checked_add. None is permanently exhausted: no wrap, old proof
or keyed input may recover; engine-turn admission fails. The new pure state
export reports null and the Worker enters restart-required. Worker sequence and
generation counters also check u64 bounds; exhaustion faults the owner without
minting a reused token. The last genuine observation can accompany the terminal
fault, but no fabricated next snapshot is advertised.

## Hard/soft invalidation call-site inventory

The following inventory covers the pinned runtime source, including unchanged
components.rs callers. Line numbers may shift on root formatting; function and
reason identify each call site.

| Call site | Class | Reason |
| --- | --- | --- |
| browser_view::invalidate_browser_page -> invalidate_browser_presentation | Hard when page is current or owns frame/browser proof | Cached PageId cannot revive retired authority; unrelated background page is a no-op. |
| browser_view::retire_browser_contacts_before_host_mutation -> invalidate_browser_presentation | Hard | Explicit host lifetime revocation after contact settlement. |
| browser_view::retire_browser_preview unhealthy branch -> invalidate_browser_presentation | Hard | Faulted preview revoke without running JS. |
| browser_view::retire_browser_preview_within_turn storage-sync error -> invalidate_browser_presentation | Hard | Explicit retire remains effective despite sync failure. |
| browser_view::retire_browser_preview_within_turn normal branch -> retire_browser_contacts_before_host_mutation | Hard | Explicit surface lease retirement. |
| browser_view::prepare_browser_view_within_turn after contact settlement | Soft, now invalidate_browser_candidate | Ordinary preparation replaces graph authority; no coordinate/lifetime generation. |
| browser_view::handle_browser_operation VIEW_PREPARE non-quiescent effects | Soft, now invalidate_browser_candidate | Revoke incomplete candidate only; real hard effects/faults already increment through their own boundary. |
| lib::replace_manifest changed manifest -> retire_browser_contacts_before_host_mutation("manifest-replaced") | Hard | New graph/resources retire prior input lifetime. |
| lib::app_service_mut normal -> retire_browser_contacts_before_host_mutation("host-state-mutated") | Hard | Unrestricted mutation can replace pages/lifecycle with identical local counters. |
| lib::app_service_mut retirement failure -> invalidate_browser_presentation | Hard fallback | Revoke despite callback failure; token need only be unequal, not one increment per API. |
| lib::renderer_mut -> invalidate_browser_presentation (new) | Hard | Unrestricted borrow can replace renderer/revision namespace. Product retained paths must use known Session APIs. |
| lib::notify_window_metrics_within_turn changed logical viewport -> invalidate_browser_presentation | Hard | Committed logical coordinates change before resize hooks, including thrown callbacks. |
| lib::handle_lifecycle Hide/Unload -> invalidate_browser_presentation | Hard | Foreground input lifetime ends even if later hook fails or same batch shows again. |
| lib::unbind_page -> invalidate_browser_page | Hard if owned/current | Page departure/disposal. |
| lib::invoke_page_hook_for_id onHide/onUnload -> invalidate_browser_page | Hard if owned/current | Lifecycle paths, including early failure. |
| lib::invoke_page_hook_for_id_with_index onHide/onUnload -> invalidate_browser_page | Hard if owned/current | Concrete instance path; duplicate revocation is safe and monotonic. |
| components::invalidate_component_page -> invalidate_browser_page | Hard if owned/current | Incomplete managed graph acknowledgement makes previous receiver unsafe. |
| components::dispose_page_components -> invalidate_browser_page | Hard if owned/current | Disposed component/event graph cannot resume. |
| engine_turn::record_execution_fault -> invalidate_browser_presentation | Hard | Interrupted realm has no presentation/input authority. |
| Session::set_render_scale | Neither | Known retained repaint preserves input token and clone proof. |
| Session::capture_render_snapshot | Neither | Diagnostic readback does not replace accepted layout/input. |
| ordinary setData/data patch, browser geometry/permit failure, abort of one key | Neither | Template/transaction changes use existing exact key/retired-through semantics; no hard token is invented. |

invalidate_browser_candidate retains the old pixels/resources for diagnostics,
revokes pending/old event authorization and clears frame proof as before. It
intentionally does not advance the hard token. Native prepare captures the hard
lifetime before cancellation/evaluation and rejects if it changes during either
stage, even if the page returns to the same identity. Hard effects after prepare
already retire the pending key through existing exact runtime key checks.

## DOM generation admission

In the opt-in browser-view lane, view.prepare must supply the current Worker
surfaceGeneration. view.prepare.commit, view.presented, view.geometry and
view.events must carry matching generation/session/page/profile in their exact
key. Stale operations fail before entering WASM. Exact abort/retire remains
available for cleanup. Future/guessed generations are not accepted.

One keyed surface operation is admitted per atomic native bridge call. A mixed
batch with keyed DOM work is rejected without splitting or executing it: a
hide/show or leave/return earlier inside that batch must not make a later stale
key appear valid. Ordinary batches retain their native indivisible semantics.
A hard effect during preparation is rejected natively or is reflected by the
finally observation; subsequent old-generation commit/input cannot enter. DOM
adapters must process that observation before publishing a candidate.

This is a wire/runtime generation boundary. It does not bind an actual DOM or
CanvasKit adapter, implement external event generation fencing, or prove a
page-level presenter/owner cleanup flow. Those remain product integration gates.

## Authored verification and limits

Authored native tests cover same atomic batch hide/show and push/pop returning
to old page, repeated real DOM prepare without a hard-token loop, ready setData/
density/diagnostic capture, failed resize with committed dimensions/token and
exactly one callback, pure export negotiation, and terminal native overflow.
Fake-host Node tests cover the opt-in wire, all observation result paths, original
sequence reuse, stale DOM generations, mixed batch rejection, timer fault/error
refresh, startup admission, u64 precision and shared-DAG freeze behavior.

These tests are drafts until root executes them. No builds, test commands,
WASM, browser, service replacement, GPU or performance acceptance ran during
candidate authoring. Product-entry wiring and real retained-site validation
remain independent requirements.
