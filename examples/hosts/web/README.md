# Web embedding example

This page is a small app-side Web host. It consumes the simulator's public
batch boundary, paints one complete RGBA snapshot to a canvas, and listens for
`ready`, `reload`, `snapshot`, `diagnostic`, `error`, and `shutdown` events over
SSE. It never walks WXML nodes or sends one bridge call per pixel/node.
With `state.presentation`, the page fetches `/api/frame` binary RGBA batches
and checks their session, configuration generation and logical viewport.
Input uses logical dimensions independently of canvas density and display
zoom. A logical resize cancels queued input and suspends the old picture until
the matching frame is presented. One fetch stays in flight; later notices
coalesce. Older adapters without presentation metadata can still use
`/api/snapshot` JSON and full snapshot events. The server bounds binary frame
storage to 64 MiB, SSE replay to 256 events / 2 MiB, and SSE connections to 16.

Start the development simulator with a local Web surface:

```sh
cargo run -p container-simulator --features quickjs-native -- \
  dev --project examples/apps/reference-app --surface web
```

Open [http://127.0.0.1:5179/embed](http://127.0.0.1:5179/embed). The page is
served by the simulator so it uses the same origin and session as the built-in
inspector. Edit a WXML/WXSS file to observe an in-place reload; edit JavaScript
or app configuration to observe a session restart.

The endpoint is a development adapter for `container-host-web`. A production
browser host can replace the HTTP calls with the `WebWasmHost` methods while
keeping the same `load_manifest → start_session → dispatch_batch →
render_snapshot_rgba` ordering. This example does not claim CanvasKit GPU,
DevTools, emulator, or device conformance.

For execution inside the browser itself, use the separate
[`WebAssembly embedding example`](../web-wasm/README.md). It owns a QuickJS/WASM
session and loads portable modules from static files without the simulator's
HTTP runtime endpoints. Its current software renderer has explicit text and
CanvasKit limitations.
