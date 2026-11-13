<a id="web-画面容量预留"></a>
# Web Interface Capacity Reservation

[简体中文](web-frame-reservation.md) · **English**


`WebSurfaceHandle::reserve_frame` pre-allocates candidate RGBA, binary response, and ledger capacity, returning a lease without holding the Web mutex. During application hooking, rendering, and pixel conversion, the same surface continues to handle HTTP, diagnostics, and other publications. The lease preserves verified publication epoch, transport session, and the next sequence number, though it does not consume the sequence number in advance.

Only after completing application and rendering work does `prepare` acquire the final publication lock, revalidating identity and budget. Other operations such as surface changes, configuration updates, profile modifications, session transitions, or retirement actions cause prior leases to explicitly fail. Routine read operations and diagnostics do not alter surface identity. Only after successfully obtaining `PreparedWebPresentation` can the caller proceed with a failure-free runtime acceptance; subsequent calls to `install` may then move the prepared fields. It is not permitted to first accept the runtime and then process the Web preparation.

<a id="容量与释放"></a>
## Capacity and Release

Candidates are recorded in a private Weak account within a shared 64 MiB budget, including actual response/source capacity, ledger, captured strings, and bounded metadata overhead. Raster, CanvasKit, and HTTP/resource responses all account for active leases; final admission is re-verified within the same lock that governs byte registration. Only the cost associated with the current Arc is excluded; no other candidates are excluded based on repeatable session/generation values.

Cancellation does not acquire the mutex; budget credentials are released after the candidate allocation, including store poison and early validation failures. Both candidates and transiently retired source accounts are individually limited to 16 entries. During installation, large resources from old pages are first moved out of Shared, and the Web guard is released before destruction; during the brief window from unlock to destruction, retired Raster sources are still billed under pre-allocated retirement credentials. Responses and resources held by slow clients continue to be accounted for under the original Weak response account.

This is the guarantee provided by `PreparedWebPresentation` for release. Legacy independent setter and retirement APIs retain their original behavior; this change does not impose a common publication semantics on all Web operations.

<a id="验证范围"></a>
## Validation Scope

Source code tests cover surface-level HTTP re-entry, concurrent publication, ABA, budget, and real queue admission, cancellation/poison, sequence and epoch exhaustion, and the actual installation and cancellation window release order. Execution must be bound to a main branch commit for validation.

This interface does not roll back application effects, does not enable development-mode Raster exact replay, nor does it complete logical resize ownership. The one-time execution of resize hooks, repair of old host images, shared surface acceptance, and actual browser rendering still require joint integration and cannot be used as justification for GPU, performance, or seven-host pass-through.
