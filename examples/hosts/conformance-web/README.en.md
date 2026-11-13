<a id="网页兼容性诊断"></a>
# Web conformance diagnostics

[简体中文](README.md) · **English**


This internal, opt-in example observes an actual QuickJS Worker and CanvasKit
session. It requires `enabled: true`, a separately built host/guest WASM runtime,
an exact portable pack index and verified renderer assets. It does not register
a formal matrix driver or grant a conformance receipt.

`createWebQuickjsCandidate` in `web-controller.mjs` creates the genuine session.
`replay1058({ request })` runs the reviewed Node actions and assertions. Bridge
only operation addresses to `controller.request(op, payload)`; expected results
stay in Node assertions. Always await `controller.close()` and retain its actual
receipt before releasing owned browser/server resources.

`frame-observer.mjs` requires the actual scoped frame reply, current observation,
accepted presentation and genuine input ACK before a query or coordinate tap.
Negative input ACKs remain observable, and cannot authorize input. The generated
WASM is a pure Rust selector projector, separate from the application engine.
It compiles the shared desktop `observation.rs`; its loader checks exact bytes.

The fixed baseline is DevTools 2.02.2609250, SDK 3.17.3 and compiler
0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e. A retained real browser diagnostic
matched all ten 1058 events and both assertions, ignoring only event top-level
`atNs`. It used the archived candidate bytes and host build recorded in
`artifacts/conformance-web/actual-1058-r7-webdiag-v1`; relocation and subsequent
projector rebuild do not rebind that observation to new source. Formal pairs
remain zero. Hardware GPU use and intermediate rendered pixels were unverified.

Run the synthetic boundary and real-projector tests from the repository root:

```sh
node --test examples/hosts/conformance-web/frame-observer.test.mjs examples/hosts/conformance-web/projection-wasm.test.mjs examples/hosts/conformance-web/transition-contract.test.mjs
```

Rebuild only the pure projector with `build-projection.mjs --cargo <absolute>
--rustc <absolute> --wasm-bindgen <absolute>`, using Rust with the WASM target and
wasm-bindgen 0.2.129. The build records complete source, tool and output hashes in
`projection-build.json`. Its report and synthetic tests are not runtime evidence.
Web/V8 is unavailable and rejected explicitly.
