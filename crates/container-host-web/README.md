# container-host-web

Web lifecycle boundary. `load_manifest_json` validates and owns one shared
`container-runtime::Session`; `dispatch_json` crosses WASM/JavaScript in complete
bridge batches. `wasm,quickjs-native` builds a browser cdylib that executes the same portable
modules inside QuickJS/WASM. See [`web-wasm` app example](../../examples/hosts/web-wasm/README.md)
for a static deployment and build command. `canvas-kit` remains a reserved
rendering boundary; it does not attach a CanvasKit or GPU context. Capability
metadata and native host tests do not establish browser conformance.

`start_session` sends `app.init`, while `dispatch_lifecycle` routes ordered
launch/show/hide/unload transitions through the core state machine.
`poll_timers` lets the browser event loop provide Unix epoch nanoseconds and
receive one JSON batch containing all callbacks due at that instant. Pass a
checked `BigInt(Date.now()) * 1_000_000n`, rather than RAF's relative timestamp;
the [shared timer clock contract](../container-host-common/README.md) defines
the range and clock domain.

After `render.commit`, `render_snapshot_json` returns one JSON `RenderSnapshot`
with tightly packed premultiplied RGBA8 pixels. The WASM wrapper exposes the
same method so CanvasKit/ImageData upload remains one boundary crossing.
For hot frames, `render_snapshot_rgba` returns the same pixels as a typed
`Uint8Array`-compatible buffer and avoids JSON number expansion; width, height
and stride remain available in the metadata method.

The `quickjs-native` and `v8-native` features enable providers in the shared
runtime. Capability metadata reflects that runtime's compiled providers, including
features enabled by another workspace consumer. V8 requests fail with
`ERR_ENGINE` when the shared runtime has no V8 provider; they never select another
engine.

`WebWasmHost::load_manifest_json_with_config` accepts serialized `SessionConfig`
with an explicit engine and session id. The WASM wrapper requires an actual
compiled provider; an unavailable engine returns `ERR_ENGINE` before changing
the existing session. The default loading method requires manifest integrity.

Browser clocks use `web-time`; QuickJS receives a local clock import through
wasm-bindgen. LLVM clang and llvm-ar are required for QuickJS WASM objects on
macOS. A native `ar` that discards WASM objects cannot produce a runnable
module even when an rlib-only check succeeds. The dev profile optimizes the C
interpreter to avoid a host stack overflow while retaining Rust debug symbols.
