<a id="工作者静态准入和绘制资源租用"></a>
# Worker static admission and drawing-resource leases

[简体中文](worker-admission-loader.md) · **English**


`worker-admission-loader.mjs` exports two product functions. Neither imports `app.mjs`, `pkg/`, AppService WASM or the runtime Worker, executes application modules, reads application blobs, or uses a runtime `/api` endpoint. `createWorkerAdmissionLoader(dependencies)` supplies an isolated service for explicit base URLs and finite fake-resource contracts.

```js
import { admitWorkerPack, loadPinnedCanvasKit } from './worker-admission-loader.mjs'
const admission = await admitWorkerPack({
  indexUrl: './pack-index.json',
  indexSha256: expectedPackIndexHash, // mandatory trusted expected pin
  indexSize: expectedIndexSize,      // optional exact size
  route: requestedRoute,             // optional: resolve real first route
  rendererPolicy: { mode: 'manifest' },
  signal,
})
// Send admission.route and the same expected index pin/policy to the Worker.
// The Worker must independently verify the entire pack before app.init.
```

The immutable result is `{version:'1.0', route, rendererPolicy, transportBackend, declaredProfile, effectiveProfile, manifest, provenance:{indexSha256,manifestSha256,integrityRoot,indexUrl,manifestUrl,downloadedBytes,blobsDownloaded:0}}`. `rendererPolicy` is explicit `{mode:'manifest'}` or `{mode:'force',profile:'skia'|'skyline-compat'|'webview'}`. Force preserves the independently reported declared profile. Only effective `webview` selects `browser-view`; the other profiles select `external-frame`. A missing requested route fails before any app executes. This result proves pinned metadata and policy admission, not full runtime conformance or successful application execution.

Admission fetches only index and manifest. It verifies the mandatory expected SHA-256 of the exact index bytes, the manifest byte SHA-256, and the normalized UTF-8 JSON integrity root using UTF-8 key ordering. It validates schema/rendering declarations, canonical distinct routes, module-to-declared-blob references and index blob descriptors without downloading those blobs. The metadata read budgets are 2 MiB for the index and 8 MiB for the manifest; node/depth limits are 262,144/128. Declared blobs are limited to 16,384 and 128 MiB. Same-origin HTTP(S), no credentials/hash/redirects, and decoded `/api` exclusion apply to every descriptor, including unrequested blob URLs.

The caller obtains the expected index hash from trusted build/deployment metadata. Computing the expected pin from the same unverified response would discard this admission boundary. The independent Worker verification remains mandatory even after admission.

<a id="固定绘图加载器"></a>
## Pinned drawing loader

After the exact Worker load succeeds, an external owner may acquire drawing resources:

```js
const lease = await loadPinnedCanvasKit({ owner, loadResult, rendererAssets, signal })
// Capture ownership of a returned lease before checking cancellation again.
// Pass lease.CanvasKit and lease.fontData to the external CanvasKit adapter.
// After scheduler/adapter disposal completes its actual last use:
await lease.dispose()
```

`owner` is `{workerEpoch,sessionId,packSha256,transportBackend:'external-frame'}`; `packSha256` identifies the verified pack **index**. `loadResult.pack.indexSha256`, `loadResult.state.sessionId`, both transport fields and the exact external-presentation four-field 1.0 descriptor must match. Browser-view owners cannot allocate the drawing module through this API.

`rendererAssets` accepts the existing `schemaVersion:1, renderer:'canvaskit', fallback:'error'` runtime configuration: `canvaskit:{version:'0.42.0',variant:'full',javascript,wasm,license,package}` and `font:{binary,license}`. Each descriptor requires `{url,sha256,size}`. All six SHA-256/size pairs must equal the compiled pins copied from `renderer-dependency-pins.json`; a caller cannot select another executable or relabel a font. CanvasKit is version 0.42.0 full. Noto Sans SC comes from Google Fonts commit `a85815a42757630ce188fdad368c2dfc444d4773`. Both licenses and pinned `package.json` bytes verify before importing any drawing JS. Package metadata must independently name `canvaskit-wasm` 0.42.0. URL addresses may vary within the same-origin static boundary; integrity/version pins may not.

The renderer download budget is 32 MiB in total, with exact pinned per-resource lengths. Content-Length and actual streamed bytes are checked before allocation/continuation. For compressed HTTP responses, Content-Length describes encoded wire bytes; exact size/hash verification applies to the decoded stream returned by fetch, while the wire header remains within the total byte budget. Readers own their chunks, cancel incomplete streams and release locks; cleanup failures remain observable. The initializer may locate only `canvaskit.wasm`, resolved to already verified local Blob bytes. No fallback CDN or additional initializer resource is admitted.

This function **does execute CanvasKit drawing JavaScript and its drawing WASM on the main thread**. That is a renderer dependency, not an AppService engine or an application execution path. This distinction does not establish GPU acceptance: the real adapter must still require its WebGL2 surface and real submission evidence.

<a id="取消缓存和租约边界"></a>
## Cancellation, cache and lease boundary

A service retains at most one successful pinned drawing-module/font cache. Concurrent callers share that initialization; one caller cancelling cannot abort another active caller. If all pending callers cancel, the service aborts resource fetches. A replacement initialization waits for the actual prior import/initializer and URL cleanup to settle. Dynamic import and CanvasKit initialization have no genuine abort primitive, so cancellation does not invent an early last-use barrier. An uncooperative injected fetch/import/initializer may keep the operation pending; this is reported as an incomplete barrier rather than false cleanup success.

Temporary script/WASM Blob URLs remain live through actual import and initialization and are then revoked exactly once, including failure/abort. The default `locateFile` cannot fetch an unverified resource. A lease exposes `{version:'1.0', owner, provenance, CanvasKit, fontData, dispose}`. Font data is an independent owned ArrayBuffer copy; mutating one lease cannot corrupt the cached font or another lease. `dispose()` returns the same promise, drops that lease's references and invalidates subsequent getters. It never closes borrowed Worker/RPC/bridge resources or disposes another owner's surfaces. The owner must dispose the adapter's typefaces/surfaces before releasing this font/module lease.

The single service-level CanvasKit module/cache remains available for later sessions until its page/service is collected. Lease disposal does not claim deterministic unloading of browser ESM caches or a WebAssembly heap. Consumers retaining borrowed CanvasKit/font references can prolong their lifetime; the owner last-use contract still applies. Download/cache bounds are not host RSS, GPU memory, FPS or package-size acceptance. The candidate does not establish any of those performance gates.

<a id="现有配置生成器不一致"></a>
## Existing configuration producer discrepancy

The retained `artifacts/dual-renderer-dev-assets/runtime-config.json`, `prepare-canvaskit-dev` and native RendererAssets verifier already include the pinned CanvasKit package descriptor. The static `build-web-wasm::rendererRuntimeConfig` producer omitted that descriptor, despite its input stage already verifying and copying the file. The separate `worker-renderer-package-config.patch` adds the real fixed descriptor and a contract assertion. Integrate that producer patch with the new loader. The loader deliberately rejects the older incomplete configuration; it does not synthesize an unverified success or weaken its six-resource boundary. The retained configuration snapshot is evidence of its bytes only, not of a browser successfully loading the new implementation.

<a id="候选检查和剩余集成"></a>
## Candidate checks and remaining integration

The accompanying Node cases are **unexecuted drafts**. Pack cases use real Node SHA-256 over tiny fixture metadata. Drawing cases deliberately inject a fake SHA provider, finite fake drawing module and fake Blob URLs; their large byte lengths exercise bounds and ownership, and do not prove the pinned vendor bytes, CanvasKit execution, a real browser, WebGL or performance. Drafts cover expected-index failure, route/force policy, Unicode canonicalization, roots, redirects/API/origin/size, stream abort/release, pin drift, independent font leases, import cancellation, peer-owner isolation and cleanup failure.

Root must integrate the product owner/entry, add new modules to the static packaging inventory, run these drafts and existing checks, rebuild the independently verified Worker exports, and obtain real retained-site/GPU/input/performance evidence. No test, build, formatter, browser, WASM operation or service replacement was run while authoring this candidate.
