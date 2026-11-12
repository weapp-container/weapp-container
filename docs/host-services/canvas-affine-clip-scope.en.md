<a id="canvas-仿射矩阵与当前路径裁剪"></a>
# Canvas Affine Matrix and Current Path Clipping

[简体中文](canvas-affine-clip-scope.md) · **English**


Fixed baseline is WeChat Foundation Library 3.17.3, `miniprogram-api-typings@5.2.3`, still using 1265 API × seven platforms = 8855 units. Product submission `ba98455f1fb53c8de1a6d3b1f5af5de4ec4e2126` implements legacy `CanvasContext.setTransform`, `transform`, `clip`, all three marked as Partial across seven platforms, with Available and accepted increments both at 0. Current status is available1504 / partial1091 / requiresHostService86 / missing6174, still 5580 short of 7084 Available; platformNotApplicable87 is not deducted from denominator.

<a id="实现边界"></a>
## Implementation Boundary

Two matrix methods accept six finite native scalars and return void, `clip` being a zero-argument void method. Contexts associated with real Canvas nodes are submitted via a private owner pathway; contexts without an owner and offscreen contexts retain independent event pathways, and each pathway's batch is drawn only after undergoing a complete typed batch precheck. `setTransform` replaces the guest CTM; `transform` combines the current × incoming. Parameters are used as `(a,b,c,d,e,f)`, with points mapped to `x'=a*x+c*y+e`, `y'=b*x+d*y+f`. Paths constructed retain their coordinates at the time of construction, and subsequent CTMs do not retransform previously constructed paths. Singular matrices may be accepted, but prechecks reject accumulated matrices and geometry that are no longer finite.

`clip()` uses the full current path, nonzero winding, and implicit closure, intersecting with existing clip. portable replay uses an immutable packed mask, shares and restores the mask via save/restore, and clears the boundary CTM, path, clip, and save stack via ResetState. Existing pixel-consumption paths such as fill, stroke, clear, and text also perform clipping. native Skia establishes a clip under the caller's baseline matrix, restores only the matrix while preserving the clip; upon exit, restores the caller's state and guard.

Shared pre-check validates the complete command stream before pixel allocation or publication, including up to 16MiB of instantaneous clip-mask payload, 256Mi of geometric work units, and existing Canvas limits. Late budget or geometric rejections cannot override already accepted images. `draw(true)` retains existing pixels and historical commands, but the new command starts from the default drawing state; the Promise returned is container extension.

<a id="每项剩余范围"></a>
## Remaining Range per Item

| Member | Implemented Scope | Retained Gaps |
| --- | --- | --- |
| `setTransform` | Six-parameter CTM replacement, caller-basis transformation matrix protection | Input and preparation values are constrained by the limited range and precision of f32, and do not cover the full JavaScript number domain |
| `transform` | six-parameter current × incoming combination | same; overflow in the f32 combination of a finite input sequence will reject the entire draw, even if a subsequent setTransform can recover |
| `clip` | Zero-argument current path clipping, intersection, save/restore and reset | portable covers single-bit pixel centers, native Skia covers antialiased edges; edge coverage with fixed 3.17.3 has not been verified |

Fixed declaration matrix methods all take six required number parameters and return void; `clip():void` has no evenodd or Path2D overload. In the local DevTools cache, a package marked as 3.17.3 in the manifest, whose static source code supports matrix parameter order and combination direction; no independent verification of the download chain or package signature of this cache has been performed, and no runtime pixel, invalid parameter, or erroneous behavior oracle or fixed version clip implementation evidence has been established. Do not treat local negative case container error policies as WeChat error contracts, or claim that a fixed version's anti-aliasing inconsistency has been proven.

Count only these three items with independent source code, parameters, and remaining range checks. factory, draw, existing Canvas members, and the original gaps in offscreen are retained; no new SDK acceptance contracts are added. The 8855 format complete comparison only changes 21 entries in these three items, while the remaining 8834 entries of the complete object remain unchanged, with all status, coverage, implementation responsibilities, and contract, ledger byte values unchanged.

<a id="验证与产物范围"></a>
## Verification and Product Scope

Node Canvas 74/74、Root workspace count/matrix/IO 568/568、Generation and `--check` passed. Actual QuickJS and V8 Canvas filter each passed 27 tests, including 24 Canvas and 3 nextTick Canvas; the two sets of commands cannot be cumulatively counted as independent coverage. Portable and Skia affine tests each passed 13 tests, native caller protection 3 tests passed. owned-page 13 tests and browser-permit 1 test belong to adjacent regression, not individually proving new member execution.

fmt、workspace all-targets locked check、full features strict Clippy all pass. all-features runtime lib is 757 passed / 0 failed / 2 ignored; four-thread workspace yields 132 result blocks, 3022 passed / 0 failed / 10 ignored. These commands overlap and are not cumulatively counted as independent test numbers. Two separate counting scripts are applied during Cargo execution; 497 build inputs remain frozen in bytes, and 1766 non-documentation inputs' before-and-after comparisons allow changes to only these two scripts.

First native test compilation failed due to integer scale literal in the test not conforming to f32 type; original log is retained; subsequent fixes only corrected the test literal and added curve, empty clip, stroke clipping, and rejection of atomic assertions. Isolation review revealed an old source-count assertion; 539 passed / 1 failed; its stdout was overridden by later runs, and only observations explicitly marked with source are retained, thus cannot be considered raw original logs. The corrected isolation passed 540/540, while the root workspace passed 568/568, belonging to different command scopes.

direct/Worker release CanvasKit build, strict archive, empty directory official installation and standalone 2119 input bytes verified, 497 build input bindings private snapshot dab7c69e6fc0d3dd97a7ad656c76f6b8c522f9da; reusing existing Cargo target. This snapshot is not a parent repository product commit.

Browser v1, v2, v3 currently all fail and cannot infer access granted from the visual output. v1 fails after two paths complete five stages, with strict network access logs recording three ERR_ABORTED; v2 direct path passes five stages, but fails when the Worker returns prematurely due to asynchronous fixture waiting at ready=0; v3, after switching to explicit await of actual guest state, passes the direct five-stage path, but reports ERR_ABORTED for font requests during initialization, prior to owner closure. Successful full-byte reading and SHA validation cannot eliminate this network failure; the root cause is still under investigation. v4, after adding raw CDP, server response, and Chrome netlog observations, still fails: direct five-stage passes, with font request logging 18 CDP dataReceived events and network service logging 275 filtered-byte reads, both cumulatively totaling 17,772,300 bytes; network service request end and server finish/close show no errors, yet CDP reports canceled=true / ERR_ABORTED. This result narrows the investigation to the renderer loader and DevTools lifecycle after full transmission, with the cause still undetermined and no cancellation exemption established. Each page/context/browser/server instance, the currently created Worker, and the diagnostic CDP session have all been closed, with no page retained.

Source code testing, private build snapshots, and limited synthetic browser execution do not replace the publicly available SDK, devices, fixed version runtime oracle, or merchant acceptance; preview.6.0 was not production released.

Strong reference comparison failed in both groups, ownership modification of Response is not supported. In the reader comparison, the baseline group and the strong retention group passed, while the delayed release group reported cancellation prior to the native releaseLock; the behavior exhibits instability and cannot be attributed to GC or used to propose a production fix. All controls were marked with diagnosticOnly and finalSelectionEligible=false; the native arrayBuffer consumption control only preserved drafts without execution, and explicitly lacks incremental read budget, making it unsuitable for product implementation.

This batch's final validation `FINAL-VALIDATION.status=failed`: source code, Node/Rust, build, archive, and installation gates passed, but the browser installation gate failed. Font loading source code and submitted bytes are identical, and located outside of 14 product diffs; this does not prove the failure is unrelated to this batch's behavior, nor does it prove it's a Chrome bug. Three implementation baselines remain Partial based on specific test results; no accidental success controls are selected for promotion, and no final-browser-selection is created. Full failure details, diagnostics, source code binding, and sealing plan are available at [this batch's evidence](../archived-evidence.en.md).
