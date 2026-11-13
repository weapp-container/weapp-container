<a id="skia-页面后端与被动宿主观察边界"></a>
# Skia Page Backend and Passive Host Observation Boundary

[简体中文](skia-backend-boundary.md) · **English**


`container-runtime::render_backend` manages Skia page preparation and acceptance within the owner thread.
The Session is responsible for AppService/View evaluation, page and resource authorization, scroll state coordination, input provenance, presentation permissions, ready state, and effects. The backend does not receive `&mut Session` callbacks, does not execute JavaScript, and does not own any window.
Public bridge, ViewDocument schema, host ABI, and rendering-mode-specific presentation semantics remain within their original boundaries.

<a id="准备与接受"></a>
## Preparation and Acceptance

1. The Session validates the manifest, target, template, and resources, and captures a page input snapshot.
2. `SkiaPageBackend::preflight` parses the original native WXSS cascade; failure occurs prior to the View/component hooks during this render.
   `SkiaStylePreflight` binds the frame, template, logical viewport, and immutable resource Arcs.
3. The Session completes a View/component evaluation, projects the result into a `ViewDocument`, and returns a `PreparedViewDocument`, then reads the page scroll configuration in original order. The evaluated AST does not cross the page backend boundary.
4. The backend performs a preflight identity check, traverses only the `ViewDocument` to generate native nodes, executes style, image, transform, and layout preparation, and produces a `PreparedSkiaFrame`. Image lexical sources are bound to occurrences within the same document; duplicate public IDs do not share resources. Image decode cache is a candidate copy; resource bytes and decoded pixels continue to be shared via Arc.
5. The Session coordinates scroll on the candidate frame. The backend invokes the original renderer's commit via `accept`. Only upon successful commit is the candidate's decode cache published, and a `AcceptedSkiaFrame` is returned along with metadata for the manifest that can be published by the Session.
6. The Session publishes the corresponding document, verified resource store, and clone-time input proof, then proceeds to the original Raster or external/native rendering flow. Acceptance of a frame does not equate to external surface presentation.

Failure during backend preparation, scroll coordination, or commit does not result in the publication of a new cache/document/input proof. Executed JS hooks are not rolled back. The existing commit transaction of the underlying SkiaRenderer remains the precondition for atomicity of frame and pixel failure.
The Session continues to decide the final ACK, repeated ACK, page switch, input lifetime, and ready/effects; the backend does not grant these permissions.

Explicit RenderFrame also follows the typed accept path, but without a manifest candidate, it does not replace the decode cache or authorize new manifest resources. In development preview, a detached Session accepts its own candidate but cannot publish live page input proof.
When a manifest is changed, the backend clears reusable decode cache; the pixel Arc from the previously accepted frame remains valid.

<a id="renderer-的实际画面准备"></a>
## Actual Frame Preparation by Renderer

`SkiaRenderer::prepare_page_frame` exclusively borrows the current renderer, completing frame, image, and target validation, as well as actual Raster drawing and pixel readback before returning the candidate. `PreparedPageFrame::accept` only moves existing page fields and updates flags; the returned `AcceptedPageFrame` holds the old frame, pixels, images, and surface. Any caller that jointly publishes must retain the receipt until the Web store is unlocked before releasing it; the old page resources must not be destroyed within the publish lock. Canvas, fonts, and GPU context remain exclusively owned by the original renderer. Independent font cache growth from actual drawing is not rolled back.

Standard `Renderer::commit` reuses this preparation/acceptance path and immediately releases the receipt. `PageFrameTargetPolicy::Legacy` retains the original backend behavior, including the 4097×1 page for no Skia software Raster; `Development { scale }` enables explicit development-mode dimensions, pixel budget, and scaling capability validation. Revision exhaustion results in explicit denial and no reuse of saturated values. ExternalFrame/NativeGpu candidates do not undergo full-page CPU rasterization or readback; acceptance of a candidate does not constitute evidence of actual GPU presentation.

This interface only completes the renderer layer. Upper-layer `PreparedSkiaFrame`, application-hooked resize logic, Web reservation, and scaling-specific candidate resource release have not yet been merged into a common transaction. The atomicity of renderer candidate failure cannot be extended to JS state rollback or full resize validation.

<a id="dom-与后续工作"></a>
## DOM and Subsequent Work

The raw stylesheet graph, browser layout, geometry, permit, and final ACK path remain independent and do not invoke Skia preflight/materialize/Taffy. This component does not convert DOM into RenderFrame and does not unify the layout results between the two.

The current Skia path has been split into preparation, lazy page object, and read-only host observation. The following boundaries and gaps still require separate management:

- `PreparedViewDocument` carries only the `ViewRenderInputs` and `ViewDocument` without AST; the original AST transformer is retained solely in `cfg(test)` for regression reference. Slot owner projection remains incomplete.
- Read-only host frame/snapshot/status/target queries have been migrated to a typed facade: `accepted_page_observation` enables a single passive peek by borrowing an already-accepted frame and current pixels; `page_render_status` and Metal context queries do not allocate resources. Target validation/staging has narrow interfaces; configuration is only saved prior to first draw. Concrete getters continue to support explicit legacy initialization and mutation, but the boundaries for logical resize recovery and font installation remain ununified.
- SkiaRenderer continues to create explicitly via `ensure/ensure_mut` on demand, without implicit `Deref` initialization. Page objects are not created for normal DOM, passive state reads, empty screenshots, detach/reset, or independent Canvas operations; routing and feature support validation still occurs prior to initialization. CanvasService is moved en masse to the renderer during the first page initialization, retaining the same history/snapshot/font/cache/lock; thereafter, the current renderer becomes the sole owner. After a full renderer replacement, retired store instances must not be revived. This represents an improvement in object and capability boundaries, and no performance gains are claimed based on this change.
- Backend-neutral receipt/coordinator, full-host WebView adaptation, GPU/real device and performance gatekeeping are not validated by this code refactoring.

<a id="已接受帧不是呈现授权"></a>
## Accepted Frames Are Not Presentation Authorization

`AcceptedPageObservation` describes only the accepted revision, frame, submission target, and optional cached snapshot from the same renderer; an old frame may belong to a previous route. When a renderer is replaced, the observation naturally follows the frame/revision/pin carried by the replacement object—no additional clearing occurs, and no second Session pin is retained.
`render_target_for_revision` rejects zero and expired revisions; frameId and DOM revision cannot be substituted.
The target is only issued upon successful submission; staging, failure, Canvas, and diagnostic capture do not alter it.
It is not evidence of measured framebuffer, ready, input, or browser presentation. Existing Session authorization checks—by page, document, profile, consumed input, permit, and ACK—remain independently enforced.

Unconstrained `renderer_mut` retires the Session's scene association, consumed input, external presentation receipts, pending ready, and observer geometry authorizations to prevent inheritance of credentials when a replacement object reuses the same revision number.
Passive frame/target observation of the replacement object remains valid; Raster retains its existing synchronization semantics, and external presentation must be reauthorized through a normal submission.

<a id="开发态倍率事务"></a>
## Development-Mode Scaling Transactions

`validate_skia_render_target` and `stage_skia_render_target` do not create page objects, do not modify the accepted target, and do not revoke DOM permit.
`repaint_current_skia_page` only redraws the current Skia scene belonging to the Session, and determines whether an update is needed based on the accepted physical target; staged scaling values cannot override unaccepted pixel changes.

Web remote updates to the same logical size use `Simulator::apply_web_density`:

1. Exclusively borrows the current scene, preserving the actual input proof consumed by the frame; does not re-evaluate View or invoke lifecycle callbacks.
2. Performs physical layer budget validation, native Raster drawing, and readback within the candidate. External/NativeGpu does not generate full-page pixel output.
3. Prepares a complete Web response, resource, and cache accounting, and acquires the final store lock before accepting the candidate.
4. Publishes the runtime view and Web configuration/response based on the prepared fields; no rollback entry for the previous frame is available after publication.

Failure to prepare or discarding a candidate preserves the old view, target, revision, and Web configuration; the independent font lookup cache may grow, but Canvas, font, GPU context, and counters are not rolled back. In the absence of a current scene, only the settings and next-frame target are jointly submitted, without publishing the previous route's old view.
Views with the same physical dimensions may reuse the accepted view, but a new configuration generation must still be correctly published.

This transaction only applies to scaling/FPS and other settings that do not alter logical geometry. A complete [host environment mirroring](host-environment.en.md) is provided for trusted repair prior to entering application code; callbacks for logical resize, provider geometry recovery, and shared view acceptance remain unconnected and pending joint integration.
Explicit runtime APIs for Raster precision receipts are available via [explicit runtime API](dev-raster-presentation.en.md); Web owner/binary/RAF connections remain unactivated. Rollback or GPU validation cannot be inferred from this boundary.

<a id="验证入口"></a>
## Verification Entry

This checkpoint passes `9354c828` through format, strict Clippy, and full workspace validation (2173 passed, 0 failed, 11 skipped, 75 required items all passed), with three independent source code bindings passing browser regression tests. Skia completes two context recoveries; 40 checks on liveContextIds-filtered contexts and activeContexts show zero finish/readPixels/full-page RGBA uploads—all lifecycle events are separately logged: 19 retirements with finish, 0 readPixels, 0 full-page RGBA uploads. These results cannot be conflated into a full lifecycle zero-synchronization. Raw commands, skipped items, failures, and cleanup records are available in [this evidence](../archived-evidence.en.md). The driver is SwiftShader; logical resize compensation, font mutation, hardware/performance, and other host validations remain pending.

`ff22b577`'s native and browser regression results, and `4f753cab`'s historical browser results, are preserved in their original bindings and cannot substitute the source code validation of this checkpoint, nor can they be overwritten by subsequent results.

New backend unit tests add validation that candidates are not prematurely accepted, commit failures retain frame/revision/cache, Arc reuse, explicit frame and manifest cache separation, manifest cache reset, and preflight identity rejection.
`session_render_resources` introduces that failed native and style pre-checks do not trigger component hooks, and when image evaluation fails after evaluation, the old frame/document/input proof is retained, along with previously executed hooks.
Style use cases hide components during navigation, display only via explicit render data, and confirm hook execution through independent, valid style-based positive validation; it does not misinterpret a statically created component under `page.push` as a render pre-check failure.
Execution results must be tied to the actual tested commit; isolation branch pre-check and main repository integration validation shall be separately documented, and format parsing or source code review shall not be considered as passed.

The following test cases shall be retained: browser_presentation, external_frame_input/recovery, image_render, presentation_reload, touch/scroll/observer/slot, and host-based testing. Evidence from browser, GPU, device, and performance must be separately linked to the actual executed source code.
