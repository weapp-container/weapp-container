# One Worker, two actual renderer families

This is a hand-authored public mini-program fixture and a real-browser smoke
consumer. It is not an upstream `weapp-vite` build or an official WeChat
implementation. `pack.mjs` calls the real portable packer and records the raw
input hashes. Its sentinel compiler commit is `fixture-worker-dual-renderer-v1`;
the packer's existing fixed compiler-name label does not establish an upstream
compiler run.

The static startup opts into `rendererTransitions: {"version":"1.0"}` and the
manifest renderer policy. No URL flag, app replacement, second Worker, backend
fake or HTTP business API enables the transition. Ordinary simulator browser
auto remains a separate gate.

## Prepare and build

Run from a clean integration checkout containing the renderer transaction
implementation. Choose fresh, separate absolute paths outside fixture source
for `PACK`, `SITE` and `EVIDENCE`; their parents must exist. Do not point them at
the active developer preview or reuse another task's build output.

```sh
node scripts/fixtures/worker-dual-renderer/pack.mjs --out-dir /absolute/new/mixed-pack
node scripts/build-web-wasm.mjs \
  --pack /absolute/new/mixed-pack \
  --out-dir /absolute/new/mixed-site \
  --execution worker --renderer canvaskit \
  --startup-intent /absolute/repo/scripts/fixtures/worker-dual-renderer/startup-intent.json \
  --canvaskit-dir /absolute/pinned/canvaskit-wasm \
  --font-file /absolute/pinned/NotoSansSC.ttf \
  --font-license-file /absolute/pinned/OFL.txt \
  --llvm-bin /absolute/llvm/bin \
  --wasm-bindgen /absolute/wasm-bindgen
```

Use the repository's pinned CanvasKit 0.42.0 full JavaScript, WASM, package and
license, plus the pinned Noto Sans SC font and license. The builder verifies all
six sizes/hashes and retains them. A successful build does not establish
browser execution or hardware GPU use.

Record the exact `pack-index.json` SHA-256 and clean source commit in the
integration lane's build receipt **before** starting the browser consumer. Pass
those independently recorded values; the consumer never invents expected pins
by reading the file under test.

```sh
node scripts/worker-dual-renderer-browser-smoke.mjs \
  --site-dir /absolute/new/mixed-site \
  --index-sha256 EXACT_64_LOWERCASE_HEX_FROM_BUILD_RECEIPT \
  --expected-source-commit EXACT_40_LOWERCASE_HEX_CLEAN_BUILD_COMMIT \
  --out-dir /absolute/new/mixed-evidence
```

The runner uses installed Playwright from the pinned upstream dependency tree.
Set `WEAPP_CONTAINER_PLAYWRIGHT_MODULE` to an installed Playwright `index.mjs`
when that tree is not available. Chromium and the WASM toolchain must already
be installed. Missing infrastructure remains blocked or failed; it never
selects a software/fake renderer to make this smoke pass.

## Five real scenarios

1. Initial DOM: actual dedicated Worker/AppService, one launch, one `onReady`,
   real DOM click, `setData`, storage and visible screenshot change.
2. DOM to Skia: a real DOM handler calls `wx.navigateTo`; the original Worker,
   runtime owner, App token, storage and interval survive. The new CanvasKit
   WebGL2 surface accepts a real pointer and changes the expected visible pixel.
3. Skia back to DOM: a real canvas pointer calls `wx.navigateBack`; the original
   DOM page identity/data survive and `onReady` is not repeated. Detached old DOM
   and canvas events cannot change business state after disposal.
4. Resize and redirect: reopen Skia, apply 400×700 logical metrics, await the
   matching actual ACK/proof, repaint at 2× without changing template revision,
   and hit the same logical button. A real canvas handler then calls
   `wx.redirectTo` into a new DOM page; managed Skia scale is not a DOM startup
   option. Record both old/new bindings, lifetimes and accepted proofs.
5. Original-owner close: inspect bounded sampled raw status/proof, verify one
   actual Worker and no application WASM on Window, close idempotently, observe
   that exact Worker's termination, remove owned surfaces, and close the one
   temporary page/context/browser/server.

The containing document is navigated once. All app route changes use real
fixture `wx` handlers. Both directions must receive a new native presenter
binding and an actual accepted presentation before input is enabled. The
consumer independently verifies the static build/source/parser/package import
closure, original index/manifest/blob hashes, renderer dependencies and startup
bytes before serving an immutable allowlist on `127.0.0.1:0`.

## Evidence limits

`execution.json` reports the five scenarios, real Worker creation/close, raw
runtime/presenter identities, fixture state, ownership cleanup, browser and
renderer strings, and failures. PNGs are explicit diagnostic screenshots;
RGBA hashes/samples come from decoding those actual Chromium screenshots.
`presentation-observations.json` preserves bounded raw status samples.
`lossy-ui-trace.json` is explicitly a UI projection and is not an oracle.

Public `session.request('view.*')` is rejected before transport. This runner
records that as public owner-control rejection, **not** as stale native ACK or
input generation rejection. Synthetic events on retained detached elements
only test local listener disposal. `acceptance.nativeStaleRpc` therefore remains
`blocked` here, pending the separate native/source contract or a specifically
reviewed managed test peer. No private RPC injection or debug bypass is added.

WebGL2/SwiftShader strings and screenshots do not prove physical GPU completion,
release performance, other hosts, real devices or WeChat parity. Those gates
remain independent. Source authoring and syntax checks alone are `not-run` for
all browser scenarios; only the integration lane's saved execution may promote
a named scenario.
