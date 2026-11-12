# Desktop Skia Metal surface smoke

This standalone macOS smoke exercises the explicit GPU ownership boundary:

1. create a winit AppKit window and `CAMetalLayer`;
2. initialize the runtime in `native-gpu` page mode, then create
   `MTLDevice`/`MTLCommandQueue` and attach them to that session;
3. wrap each `CAMetalDrawable` texture as a Skia Ganesh Metal render target;
4. render the committed `RenderFrame` with the runtime renderer, flush, and
   present/commit the drawable;
5. acknowledge its renderer-owned revision after command submission and verify
   no CPU page snapshot was cached before or after presentation;
6. detach the Metal context, unload the session, exit the event loop and drop
   the task-owned window.

Run it on a macOS graphical session:

```bash
cargo run --manifest-path examples/hosts/desktop-metal/Cargo.toml --release --locked
```

The JSON report may be `passed` only when the runtime reports
`rendererBackend: "skia-gpu-metal"`, `containerSurfaceAttached: true`, and
`gpuSurface: true`, both `cpuSnapshotAbsent*` checks, and a successful presentation
ACK. `frameId: 37` intentionally differs from the renderer revision. Submission
is observed; GPU completion and visual pixel correctness are not asserted.
Window creation failures emit a `blocked` report; drawable/presentation failures
emit `failed`. Linux and Windows builds emit the explicit blocked
shape; they do not turn the software presenter into GPU evidence.

The process exits after one presentation and owns no persistent service. The
report records context detachment, session unloading, event-loop return and
window-owner disposal. If interrupted externally, inspect the recorded process
and the uniquely titled `Weapp Container Skia Metal smoke` window before cleaning
up only those task-owned resources.
