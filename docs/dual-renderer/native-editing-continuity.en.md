<a id="原生编辑连续性后续协议与实现设计"></a>
# Native Editing Continuity: Follow-up Protocols and Implementation Design

[简体中文](native-editing-continuity.md) · **English**


**Status: Native editing lease is still in design; explicit experimental implementation of document transactions has been added.**
The current actual wire name, identity, capacity, and limits are defined in [Live Document v2](browser-live-document-v2.en.md).
It declares `nativeEditing:false`, freezes native input during updates; regular simulators and Workers retain v1.

v2 has added native retained event dispatch entry points: full pre-check has accepted receiver snapshot, and checks the real instance before each listener lookup, after getter, before actual invocation, and after result serialization; runtime re-verifies at microtask checkpoint and revokes old input privileges upon retirement while preserving the JS effects that have already occurred. Touch cancellation also retains the original snapshot and cannot redirect to a new instance with the same name. This boundary already supports per-callback instance validation required by subsequent editing leases; lease issuance, deferment facts, and controlled echo causality have not yet been implemented.
The following describes the target design for complete editing continuity, without implying that all entry points, leases, or product wiring have been implemented.
Existing receiver / `inputLifetimeRevision` and document permits will not restore old presentation keys as valid, nor will they issue editing leases or retain native IME.

Current behavior and limitations remain as described in [DOM Text Controls](dom-text-controls.en.md) and
[Browser Presentation v1](browser-presentation.en.md). This design does not modify these v1 contracts,
does not certify test passes, and does not modify frozen 279 gateways. Web remote/browser, macOS, Windows,
Linux, Android, iOS, HarmonyOS remain within their original targets; QuickJS and existing V8 scope, official oracle,
actual host, device, hardware, and performance evidence are each individually accepted.

<a id="问题与选择"></a>
## Issues and Choices

Currently, the presenter creates an iframe per revision, snapshots the old controls, and then writes back the value, selection, and focus to the new controls.
The browser-held composition, undo stack, input method candidate window, and native editing context belong to the actual Document and controls and cannot be reconstructed from a snapshot. Even if the control value is correct and Enter is filtered, it does not prove that composition crosses the presentation continuity. A regular revision sets the iframe to inert, blocks all keydown default behaviors, or re-focuses, which may still prematurely end editing.

The following implementation adopts the following boundaries:

- The same live surface holds a stable iframe, Document, page root, and native controls.
- The preparation phase only generates frozen typed patches, resource preparation, and continuity determination, without attempting to modify the live tree.
- The runtime first authorizes an exact document change; the browser then samples the actual geometry after applying it.
- The runtime accepts the actual geometry and presentation ACK within the same final transaction, then restores business event privileges.
- The runtime grants a limited edit lease, enabling a precise receiver to continue native editing during ordinary presentation pauses; the lease does not grant permission to execute application callbacks, queries, or hit tests in advance.

Do not adopt a generic "temporary app → measure → undo" path. The absence of paint does not imply the absence of side effects:
changes to value/type/selection/disabled, ancestor removal or hiding, focus and inert state changes may have already terminated the IME,
changes to the undo stack, triggering native events, initiating resource requests, or launching CSS/native state transitions. Undoing DOM bytes
cannot undo these actions. Even if the currently authored animation is rejected, the base styles, browser default behaviors
and subsequent adapters cannot assume reversibility based on that.

hidden clone can be used for non-authoritative pre-check and cannot provide authoritative geometry with permit. It lacks the original control's real
`:focus`, `:focus-within`, `:focus-visible`, hover, native selection/scroll states;
an independent context may also have different font, viewport, media, and resource states. Moving the original control into the clone would damage the editing context that needs to be preserved. This design does not rewrite all dynamic CSS to simulate native states.

<a id="三个独立生命周期"></a>
## Three Independent Lifecycles

| Lifecycle | Identity and Permissions | Ordinary setData | Boundaries that Must End |
| --- | --- | --- | --- |
| Presentation transaction | Complete `PresentationKey`, permit, final ACK, geometry epoch; authorizes current business event and query | New key, old key continues to retire according to existing rules | Transaction cancellation, replacement, expiration, or final ACK |
| Hard Input Lifecycle | runtime owner/attachment、session、page instance、route、surface generation、`inputLifetimeRevision` | Kept only when the runtime proves no hard failure exists | owner/attachment retirement, page or app hide/unload, navigation, renderer switch, surface loss, logical metrics failure, receiver graph destruction, etc. |
| Native edit lease | Limited lease ID issued by runtime, bound to hard lifecycle and precise edit receiver | Can cross allowed successor documents; business dispatch still awaits new ACK | Expires, native blur, controlled state conflict, identity change, hard lifecycle failure, or explicit release |

Edit lease does not extend any presentation key. The old `view.events`, old geometry, old query response
must still be rejected; they cannot be replayed with new keys. The same value of `inputLifetimeRevision` also does not equal
The receiver is still alive, the runtime must still verify the actual continuity of the page, declaration, and component instance.

The receiver identity of a lease must at least be bound to: page instance and routePath, occurrenceId, declared document, tag/input type/key, eventOwner, componentScope, slotOwner, and the continuity token of the actual receiver instance in the runtime. Identical string IDs do not prove instance identity. Component reconstruction after removal, slot reassignment, navigation back to a cached page, or owner A → B → A cannot revive an old lease. The browser cannot submit a handler, owner, propagation path, or dataset to fabricate this identity.

Hard input failure first revokes local edit permission and queue, then runs possible reentrant cancellation, blur, cleanup, or notification.
It is not allowed to delay revocation in order to wait for compositionend, resource cleanup, or application callbacks. Reacquiring the same page name or size requires new permissions. Whether ordinary root-data updates are allowed to be continuous is determined by runtime based on actual lifecycle and receiver changes; browsers must not infer "no navigation" on their own.

<a id="显式协商与-v1-保持"></a>
## Explicit Negotiation and v1 Retention

The new contract requires runtime, bridging transport, session client, owner adapter, and presenter
All must be explicitly negotiated. It is recommended to separately register presentation v2 and native-editing v1 contracts, and explicitly require: document permit, live geometry finalization, precise handle, bounded lease, bounded queue, synchronized hard undo, and asynchronous release barrier. Final names and schema must be uniformly defined and strictly validated at implementation time.

Capabilities come from the actual contract result at the receiving end and cannot be inferred from the existence of a method, optional parameters, version number size, `isComposing`, example configuration, or test fixture. Continue using v1 until either end is complete; do not write unimplemented fields to loadResult, manifest, capability, or observation.

v1 preserves the strict order of "hide candidate actual layout → geometry permit → commit → ACK", errors, and the old permission denial behavior. v1 unknown fields, v2 requests, edit lease, and no geometry permit must be explicitly denied. v2 delayed geometry cannot be stuffed into v1 permit, empty geometry cannot be used as placeholder, and a more permissive authorization cannot be silently returned due to the other end's lack of support. Explicit selection of v1 still does not commit native continuity.

<a id="草案-api-与事务顺序"></a>
## Draft API and Transaction Order

The following names are used for the complete lease design data flow; the experimental implementation uses independent `view.live.*` naming, and no editing lease or edit flush/release wire entry is provided in this section.
u64 continues to use standard decimal string, all requests and responses use exact schema, overall budget, original request association, and immutable snapshot. Document token, permit ID, lease ID are issued by runtime.

| Draft Entry | Key Content in Request | Runtime Result and Meaning |
| --- | --- | --- |
| `view.prepare` v2 | current owner/attachment, surface generation, precise render request, optional active lease ID | evaluated document, complete new key, document token, base key, receiver continuity and controlled conflict determination; no input permission yet |
| `view.prepare.commit` v2 | New key, document token, base key, precise active lease ID or null | Limited document permit; authorizes only the application to access this document, does not claim that geometry has been measured or presentation has been accepted |
| `view.presented` v2 | precise document permit, live patch receipt, complete actual geometry batch, lease continuity result | atomic validation and acceptance of document and actual geometry, returns final ACK, inputEnabled, lease disposition, and effect |
| `view.abort` v2 | Exact key, document permit/receipt (if obtained), reason | Abort pending transactions; return authoritative recovery/disabling result, without recovering the old lease or key permissions |
| `view.edit.flush` draft | Currently ACKed key and epoch, lease ID, continuous edit sequence, bounded native facts | Revalidate receiver from current document and lease, dispatch in order after overall precheck; return exact consumption result |
| `view.edit.release` draft | Precise lease ID, sequence number, and release reason | Monotonic retirement of lease; idempotent repetition can only confirm the original release and cannot affect subsequent lease |

document permit must be bound to runtime current owner/attachment, hard input revision, base key,
new key, document token, continuity/conflict decision and finite deadline. token points to the exact evaluated document saved by runtime, and cannot merely compare a summary of client-reencoded JSON. typed patch is used only locally in the browser and is bound to a precise handle for freezing plan and permit, and cannot serve as authoritative wire dispatch.

It is recommended that only one live patch transaction exist at a time, while retaining a "latest pending request for preparation". Prior transactions must not be overridden by subsequent patches until an ACK/abort result is explicitly received; otherwise, the journal, receipt, or lease of the prior transaction shall not be overwritten.
An update received during submission only replaces the pending request for preparation and does not alter the identities already captured by the current transaction.

A transaction is executed in the following order:

1. Capture the currently accepted base, hard lifecycle, and active lease, pause ordinary business event entry; valid lease
   Native defaults for the same real editing control can continue. Register the transaction and drain first, then begin reentrant work.
2. Runtime evaluates and pre-checks the document, independently determines whether the original editor receiver is still the same instance, and checks for declaration conflicts.
   The browser prepares the typed patch, parses CSS, and resolves resource leases; the live Document remains unchanged.
3. Runtime issues a document-only permit. The browser synchronously rechecks owner, hard lifecycle, deadline, base, and precise handle; if any change occurs, the current candidate is released and the patch cannot be applied.
4. The browser decides on handling the editing lease based on continuity, then applies the typed patch **once** to the live Document.
   Retain old resources and rollback journal; business dispatch continues to be paused. At this point, the new view may already be visible and must be marked as committed/unacknowledged; it cannot be reported as accepted.
5. Wait for necessary stable points owned by this transaction, such as decode/font/RAF, sample the real geometry containing all occurrences. Wait for cancellable, with deadline; hard expiration immediately terminates editing and subsequent ingress.
6. `view.presented` rechecks all fences on the runtime owner thread, validates complete geometry, then publishes the document, initial geometry epoch, and final ACK in a single atomic acceptance step. No part is published if the geometry is invalid. Page ready effects execute after the acceptance point is reached; they cannot trigger rollback of already accepted presentations.
7. When processing the final result, the browser first registers "accepted and input closed", then processes lifecycle effects and reentry.
   Wait for the release barrier of prior real resources, and finally recheck current owner/hard revision/lease/new key before enabling ordinary input. The editing queue dispatches fresh accepted geometry separately; it cannot bypass the ACK using the document permit.

ACK loss or timeout results in undefined behavior and cannot be immediately rolled back. The transport must be able to achieve the same final result as the original request, or determine via explicit runtime result query/abort whether acceptance has occurred; this also requires new contract implementation. When ambiguity remains, input and editing must remain disabled, bounded resource retention must be maintained, and recovery must be requested—no further commit should be sent as a gamble on result. Cancellation notifications, HTTP 202, SSE snapshot, and local patch completion are all not final ACKs.

<a id="稳定-surface-与-typed-reconciliation"></a>
## Stable surface and typed reconciliation

surface holds the iframe/Document/page root, DOM occurrence map, native-node WeakMap,
a set of delegated listener, ResizeObserver, and surface-level async cleanup owner. revision candidate
only holds plan, typed operations, journal, resource leases, async tasks, and receipt.
The `dispose()` of the old candidate must not destroy shared iframes, listeners, observers, or editing controls of successors.
Actual replacement and shutdown of page/owner/surface trigger surface release for resources it owns.

typed operations should at least distinguish create/remove/move, text, attribute, inline style,
stylesheet, image binding, scroll, control value/selection/disabled. All values must first pass
existing semantics, CSS, resource, and budget validation; raw HTML, scripts, arbitrary URLs, or component
prop to DOM attribute shortcuts are not allowed. remove attribute must be an explicit operation and cannot be achieved by simply providing a new value.

Ordinary non-destructive updates must preserve the actual control and its retained ancestor's node identity, Document, connection relationships, and focus. No equivalent value/selection/type/disabled writes are performed, no focus/blur calls are made, no inert/display/visibility switches occur, and controls must not be moved via `replaceChildren`, fragment, or reconstruction of ancestors. Creation/removal of other branches and label modifications can be performed via patch. Reordering, if it requires moving the active editing branch, is by default considered a continuity boundary; additional contract extensions are only permitted if the host has verifiable continuity evidence for the corresponding native move primitive. Ordinary `insertBefore` is not assumed to preserve editing context.

CSS scope token allocation must be stable within a surface, or atomic with the entire stylesheet/attribute patch.
New styles and inline URL usage employ resource leases from the new plan; old styles, old image URLs, removed nodes, and decoders borrow retention until the end of the ACK/rollback decision. Browser CSS support pre-check is not actual layout evidence; true geometry is always captured after live apply.

CSS changes may still hide edit ancestors or trigger actual blur. The browser must check at apply and at each asynchronous recovery point whether the original node is still connected, `ownerDocument` is the same, activeElement is still the original node, and editable. On failure, report continuity ended and immediately close the lease; it is not possible to restore via refocusing or faking composition flags. Legal new documents can still be accepted, but continuity for that edit session cannot be reported. Arbitrary CSS changes do not imply continuity as promised by this proposal.

<a id="编辑-lease-的发放期限与队列"></a>
## Editing lease distribution, duration, and queue

It is recommended that each surface have at most one active focused-editor lease. The runtime shall issue a grant only based on verified focus facts from currently accepted documents; the grant returned in the event's actual final result, and not from the browser's own declared "in composition" field. If a focus handler triggers navigation, removes a component, or otherwise causes a hard failure, the final result must revoke or omit the grant. When processing results, adopt permission changes first, then schedule new presentation or deliver application effects, to prevent re-entry window usage of unverified grants.

grant must contain at least an opaque lease ID, runtime receiver token, hard lifecycle identity, starting ACK key, monotonic lease sequence, control source version, consumed edit sequence, runtime-limited TTL, queue upper bound, and allowed native fact types.
Suggested TTL upper bound **15 seconds**; runtime may issue shorter durations. Renewal requires the runtime to revalidate the same focused receiver in the currently acknowledged document and return a new sequence and deadline; heartbeat, repeated observation, input event, or local activity alone cannot extend the lease. No unbounded renewal or ACK-based suspension can extend the lease during suspension. The lease is immediately revoked upon expiration; late, expired renewals cannot resurrect a lease that has already expired or been released.

runtime independently verifies expiration using its own monotonic clock. Across processes, absolute clocks are not compared; the browser establishes a conservative deadline by adding the local monotonic time at request issuance to the TTL provided in the response, and it cannot restart the full TTL from the time of receiving the response. Verification is disabled and then revalidated when system recovery, owner reconnect, or unclear timing continuity occurs.

Suggested initial queue limit: up to **256** native facts not yet completed, totaling at most
**256 KiB UTF-8 encoded bytes**, with each edit value continuing up to **64 KiB UTF-8**.
The total must include full encoding of envelope, identity, sequence number, strings, and selection regions, and all copies pending, en route, or with unknown status are charged; existing Worker/transport overall payload limits still apply with a lower cap.
Runtime and browser both enforce count and aggregate-byte limits, and cannot bypass the count by sending a few events with large values, nor can they defer checking after copying large values. Implementation must define a single finite encoder and preflight order, and must cover multibyte, proxy pairs, metadata, and in-transit copy boundaries.

Each record is bound to a lease ID, hard lifecycle, receiver token, and a continuous native edit sequence,
as well as the actual native value/UTF-16 selection/time facts captured at the time of acquisition; composition and raw keyboard observations can be used for diagnostics, but are not credentials for transferring dispatch permissions. Records during pause periods have no available presentation epoch.
After final ACK, the fresh accepted geometry for the current key is bound to the pending batch; runtime then validates that the lease matches the current receiver, independently deriving the processor and propagation path. Old `view.events` batches cannot be swapped with a new key, old geometry epoch cannot be migrated, and the edit queue cannot be used for tap/touch/query.

Only one in-flight flush is allowed, and there is a bounded pending queue; all record and result fingerprints are subject to the same budget.
Idempotent confirmation is allowed only for the same sequence and original content; conflicting content indicates protocol failure, and consumed records must not be executed twice. A batch is first pre-checked, then executed individually; if any callback causes a hard failure, processing is immediately terminated for the remaining records.
No silent merging of input/focus/blur or discarding of selection history for capacity savings is permitted, as this would alter the semantics of application events.

On lease expiration, sequence exhaustion, TTL expiry, or unrecoverable transport failure, first revoke the lease
and close editing, then record explicit reasons and actual consumption/discard results, and release the bounded queue. Silent truncation
of text, drop-oldest, unbounded retries, or waiting for a future compositionend to resolve blockage is prohibited. Diagnostics shall not include
passwords or full edit text; password values without listeners must not be transmitted outside geometric or diagnostic channels.

<a id="native-defaults焦点与受控状态冲突"></a>
## native defaults, focus and controlled state conflicts

Business input gatekeeping and native editing permission must be separated. When business gatekeeping is closed, general pointer, tap, confirm, query, and business callbacks remain disabled; an active editing lease only allows the original active editor to continue browser input, selection, composition, and necessary keyboard default behaviors. Preventing default for all keydown events in this branch is not allowed, otherwise input method candidate selection will still be blocked. Single-line applications continue to filter real isComposing/keyCode 229, and textarea Enter continues to insert a newline via the browser.

lease does not authorize focus transfer to other controls. During presentation pause, the browser shall prevent the default click or Tab behavior from transferring focus to a new control; actual blur caused by system, window, assistive technology, or user cannot be faked as if it did not occur. True blur immediately terminates the local native edit lease, retaining only a bounded terminal fact awaiting a valid final ACK; if the lease/receiver/hard fence has expired, discard it directly with a clear result. A closing lease may only perform a single final dispatch to a still-living receiver within its duration and then release, and cannot continue collecting edits or accept subsequent renewals. Initial focus and subsequent real focus/blur events are dispatched only once; presentation ACK, scope updates, and resource cleanup do not generate synthetic focus/blur and do not automatically refocus.

Need to split the old `setInteractive()` into a business dispatch toggle and a hard native rollback operation. Ordinary revision
cannot make the retained surface inert, or modify pointerEvents/visibility and then refocus. Hard suspend
or lease rollback can terminate editing; before calling native blur, publish a local rollback state, and re-entering focusout
can only close the existing lease, not issue or restore permissions.

Controlled attributes adopt an explicit conflict strategy and cannot arbitrarily defer application state based on a composition flag. runtime
It is also necessary to output a monotonic source version and a verifiable source-edit acknowledgment for each control.
The latter can only come from edit events and synchronized data updates that the receiver has consumed, and requires that the newly declared value indeed
matches the value of the native fact; the browser cannot unilaterally claim "this is echo," and asynchronous or timer-based writes cannot automatically inherit the causal marker of prior events. Transformed values, writes without causal markers, or explicit resets are considered controlled overrides.
This is a new implementation requirement and cannot be inferred from an existing source-value equality comparison.

For example, the value for consumed sequence 10 is `拼`, and the browser has continued native editing to sequence 11 `拼音` while waiting for presentation. The application cannot revert `拼` for sequence 10 merely because it differs from the current native value, nor can it end the IME or discard sequence 11; it can only advance the acknowledged source baseline. Acknowledgement cannot exceed the runtime-consumed sequence number, nor can it cross a lease/receiver or rollback the source version.

| Change | Continuity and write rules |
| --- | --- |
| Normalized source value unchanged, local value has changed | Retain local value; regular revision does not write back to source, does not write selection |
| source value updated and equals the current native value | update source baseline; do not perform equivalent `.value` write |
| Trusted source-edit acknowledgement lags behind newer local edits | Only propagate confirmed baseline, retain the newer native value and queue; do not write back old echo |
| Other source value updates differ from current native value | permit explicitly returns end-and-apply; retire lease first, then apply new value in live commit, without waiting for compositionend |
| cursor/selection request matches previous declaration | Does not replicate static declarations to the native selection area in each revision |
| New explicit cursor/selection request | As a controlled selection area conflict, terminate the lease first, then apply the final value's UTF-16 range |
| disabled/type/password/semantic identity change, node removal | execute changes after lease ends, prohibit backward transfer of local editing or composition state |

If the native value changes again after a permit is issued but before live apply, the browser must re-evaluate the frozen conflict rules and cannot silently treat different values as echo. When the runtime's continuity decision is changed, the permit must be canceled and re-prepared, or an end-and-apply downgrade result explicitly allowed in the contract; no client-side boolean value should be used to expand the permit. The new declarative focus capability is not implicitly opened here; current strict rejection remains until its independent contract and evidence is completed.

<a id="状态转换回滚与清理"></a>
## State Transitions, Rollback and Cleanup

presentation state recommendation is `accepted → preparing → permitted → applied →
finalizing → accepted`; any unaccepted stage can enter `aborting`, unknown result enters `uncertain`, hard failure enters `retired`. editor status is independently `none → active → paused` (paused only for business dispatch, native editing remains valid) `→ active`, or enters `closing/revoked/expired`. lease's retired state is monotonic, subsequent receivers with the same name can only hold new grant.

| Failure Point | Recoverable Content | Permission and Resource Handling |
| --- | --- | --- |
| permit before | live tree unchanged | discard staged patch, precisely release new resources; validity of original permission still determined by runtime |
| after apply, explicitly not ACK | journal can recover DOM/styles/resources | measure old content after recovery; restore business input only if runtime explicitly confirms base is still valid |
| destructive editing change rollback | recoverable value and DOM representation | ended IME, undo stack, or focus cannot claim recovery; old lease does not revive |
| final result unknown | retain applied state and required predecessor resources | input close, query original final; cannot infer unACKed or directly restore old key |
| runtime finally ACKed | New document, actual geometry and acceptance identity | Rollback disabled; predecessor cleanup failure retains new frame but input closed, reports true cleanup failure |
| hard revoke/shutdown | retain diagnostic views | synchronously revoke all ingress, wait for actual async cleanup by ownership, cannot wait for edit end before revoking |

journal only guarantees recovery of DOM/style/resource references it owns, and does not guarantee reversal of native/CSS/network side effects.
Perform possible failing semantic and structural validation before applying; record each applied operation individually, even if an error occurs mid-way;
know actual ownership. On rollback failure, enter faulted/disabled and retain checkable cleanup outcome;
Prohibit claiming recovery success while leaving a mixture of old and new plan.

All asynchronous entry points first publish the exact handle, state, shared promise, and drain, then invoke resolver, presenter, transport, or an external callback. After each await returns, recheck the captured identity, and do not re-acquire the key from a mutable latest/current. Synchronous hard revocation takes precedence over release, onDiagnostic, and application effects. A callback returning a Promise cannot be treated as a synchronous boolean fence; exceptions cannot be granted as input.

ACK's irreversible acceptance point first registers, then cleans up predecessors. Predecessor resources dispose, late decoder, old abort, and release timeout only affect their exact owner; do not remove nodes still used by a new plan, clear surface listeners, modify successor.inert, release successor URL, or rollback new receipt.
Shared surface is managed with explicit borrowing/reference ownership and a final-use barrier, not by looking up release via "current iframe".
Preserve the real drain of existing `releaseCandidate`/`drainCandidate`/`confirmAsync`/shutdown:
Timeouts indicate cleanup pending and cannot be faked as released. Reentrant calls return the same operation promise; resources are released only once; actual late failures remain in the original drain and final shutdown result.

<a id="具体实现接缝"></a>
## Concrete Implementation Gaps

- `dom-presenter.mjs`: Splits `createBrowserCandidate()` into surface owner and revision candidate; replaces per-revision populate/snapshot/restore paths with typed diff/apply/rollback and live measurement. Delegates listener/observer handling to the surface; the authoritative entry point for events switches with final acceptance; regular prepare no longer hard-disables valid editors.
- `DomViewPresenter.prepare/commit/confirmAsync/abort`: v2 uses independent state branches and contracts, without modifying v1's geometric permit assertions. The precise handle/receipt and cleanup barriers remain preserved.
- `dom-session-client.mjs`, `worker-dom-adapter.mjs`, `remote-dom.mjs` and their respective transports: negotiate new contracts, transfer runtime lease, separate regular presentation cancellation from hard rollback, bind to actual finality, manage bounded native-fact queues and ACK uncertainty recovery. Hard circumvention of the owner fence cannot be achieved by merely modifying the presenter.
- Runtime/host browser presentation, receiver, and observation boundaries: preserve bounded permit/lease/idempotent records, prove continuous actual instance existence, atomic acceptance of live geometry and final ACK, and output synchronized rollback facts. Both Worker and remote must implement identical semantics, without deriving topology authority from the browser.
- Native seven-host adapter: provides separate lifecycle, focus/keyboard, and release implementations for real editing objects. Evidence of node stability in Web iframes cannot be upgraded to capabilities of WKWebView, WebView2, WebKitGTK, Android WebView, ArkWeb, or Skia native controls through record-keeping.

<a id="实施后的真实-ime-证据要求"></a>
## Real IME Evidence Requirements After Implementation

The following scenarios must be executed, and are not already passed. Unit tests can verify state, budget, reentrancy, and failure paths. DOM double cannot prove composition. Synthetic composition events and manually setting `isComposing` can only validate filtering branches and cannot serve as evidence of native continuity.

1. In a real runtime-driven input and textarea, preserve actual iframe, Document, node, and activeElement references. Begin Chinese composition with the real OS input method, and during active composition, execute unrelated setData via Page handler/timer to complete new final ACK, continuing candidate/input selection. Record node and Document references as always identical, without additional focus/blur, real composition/native key raw events, final value, selection range, and AppService consumption order. It is not permissible to end composition before updating.

2. Override multiple ordinary revision, bindfocus → setData, input echo, irrelevant label/CSS changes, IME Enter input selection, and subsequent non-composition confirm, as well as native newline in textarea. Retain original observations such as event `isTrusted`; browser CDP native composition can serve as explicit labeling browser auxiliary evidence, but cannot replace actual OS candidate window interaction and seven host interactions.

3. Continue native editing during permit, live apply, geometry/final ACK waiting, and predecessor asynchronous cleanup stages. Validate queue count/byte billing, full batch pre-check, order, repetition of final/flush idempotency, new geometry dispatched before dispatch, and continuous rejection of old key, old epoch, and old receiver.

4. Inject preparation failure, apply interruption, actual geometry rejection, explicit abort, final loss, ACK post-cleanup failure, late decode, and release timeout. Distinguish between roll-backable and non-recoverable edit states; acknowledged new content must not be cleared by late abort or old disposer, and native lease must not be incorrectly restored.

5. During active composition, change source value, selection, disabled, type, owner/slot, key, remove/rebuild edit components, execute page/renderer/owner switch, logical resize, hide, disconnect, TTL expiry, and queue overflow. Validate undo before side effects, correct controlled value, no infinite waiting, no late events/renewal resurrection, and do not treat "explicit end of edit" as continuity passed.

6. For the same route and owner A → B → A, cached page return, and same occurrence reuse, preserve original runtime identity and sequence. Old lease, old queued facts, and old receipt must be rejected. After real user blur and subsequent refocus, a new grant is required; old rights cannot be retained merely because the Document remains.

Each piece of evidence must be bound to precise source code/products, host/runtime/engine/renderer, negotiation results, owner/hard input revision, permit/lease status, item-by-item verification, original logs/snapshots, and resource ownership and cleanup results.
Text content will be de-identified as needed; passwords will not be archived. Execution personnel or browser owner shall only shut down resources for this task; report failures and actual retained resources. Before these implementations and actual tests are completed, native cross-presenter editing continuity remains unimplemented and unverified; receiver hardening or any existence mentioned in this document does not alter this status.
