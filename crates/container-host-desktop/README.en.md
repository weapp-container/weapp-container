# container-host-desktop

[简体中文](README.md) · **English**


Host metadata and lifecycle boundary for macOS, Windows and Linux. The host loads
one validated portable manifest and exposes batch `dispatch_json` calls to the
native event loop. `window` and GPU features are explicit integration points;
with a window, either `skia-backend` or `skia-gpu-metal` makes metadata report
the compiled Skia raster boundary. The default build is deterministic and
carries no claim of native GPU/window validation.

`build.nativeSurface`/`build.renderer` describe compiled support. The
`gpu_surface` bit remains `false` until a platform drawable is rendered; a
`metal-window` build therefore reports `skia-raster` before first presentation
and `skia-gpu-metal` only after the Metal drawable path succeeds.

`start_session` and `dispatch_lifecycle` keep app initialization and lifecycle
ordering in the shared runtime rather than in a second desktop page stack.
`poll_timers` lets the desktop event loop provide Unix epoch nanoseconds and
receive one batch containing all callbacks due at that instant. Uptime and
elapsed `Instant` values are not deadlines; see the
[shared timer clock contract](../container-host-common/README.en.md).

Native pointer, wheel and keyboard events can be normalized with
`DesktopInputEvent` and sent as one `event.batch` through
`DesktopHost::dispatch_input_batch`. Pointer coordinates stay in logical
viewport units; the runtime performs hit testing and adds target/path/dataset
fields before invoking page handlers. This keeps AppKit, Win32 and winit
adapters on the same event contract:

```rust,no_run
use container_host_desktop::{
    DesktopHost, DesktopInputEvent, DesktopModifiers, DesktopPointerPhase,
    DesktopTarget,
};

let mut host = DesktopHost::new(DesktopTarget::Linux);
// load_manifest_json(...) and start_session(...) happen before input.
let _batch = host.dispatch_input_batch(
    "pointer-1",
    [DesktopInputEvent::Pointer {
        phase: DesktopPointerPhase::Down,
        x: 24.0,
        y: 32.0,
        button: Some(0),
        buttons: 1,
        modifiers: DesktopModifiers::default(),
    }],
)?;
# Ok::<(), container_host_common::HostSessionError>(())
```

The `quickjs-native` and `v8-native` features enable providers in the shared
runtime. Capability metadata reflects that runtime's compiled providers, including
features enabled by another workspace consumer. V8 requests fail with
`ERR_ENGINE` when the shared runtime has no V8 provider; they never select another
engine.

The runtime renderer is also owned by this host session. After a
`render.commit`, `renderer_backend()` reports the selected backend and
`has_native_surface()` reports whether that frame reached a native Skia raster
surface. `render_snapshot_json()` performs one synchronous RGBA8 readback from
that surface. Native presenters can call `render_snapshot()` directly to skip
JSON encode/decode; the desktop smoke test checks actual pixels rather than
only feature metadata:

```bash
cargo test -p container-host-desktop --features window,skia-backend
```

This is an offscreen surface/host-loop smoke. It verifies the Skia raster
commit and readback boundary; a platform window, GPU context and compositor
still require the corresponding macOS, Windows or Linux integration runner.

<a id="可选的桌面开发窗口"></a>
## Optional desktop development window

The `window` feature adds an opt-in `DesktopWindowPresenter` backed by
`winit` and `softbuffer`. It accepts one complete `RenderSnapshot` at a time,
so a development simulator can reuse the same `DesktopHost` session and
present frames from its event loop without making per-node bridge calls:

```rust,no_run
use container_host_desktop::DesktopWindowPresenter;
use container_render_skia::RenderSnapshot;
use winit::event_loop::EventLoop;

fn main() -> Result<(), Box<dyn std::error::Error>> {
let event_loop = EventLoop::new()?;
let mut presenter = DesktopWindowPresenter::new(&event_loop, "Weapp Container simulator", 375, 667)?;
// On WindowEvent::RedrawRequested:
let snapshot = RenderSnapshot {
    frame_id: 1,
    width: 375,
    height: 667,
    stride: 375 * 4,
    format: "rgba8-premultiplied".into(),
    pixels: vec![0; 375 * 667 * 4],
};
presenter.present(&snapshot)?;
Ok(())
}
```

The event loop remains owned by the embedding application; it should route
`WindowEvent::Resized` to `presenter.resize(...)` and request redraws after a
new runtime frame. The presenter is a CPU software surface and does not claim
Skia GPU, DevTools, emulator, or device parity. Build it explicitly with:

```bash
cargo check -p container-host-desktop --features window
```

The repository also includes a one-shot native window smoke for a machine with
a graphical session:

```bash
pnpm host:desktop:surface -- --out artifacts/desktop/native-window-surface.json
```

It creates a real `winit` window, attaches `softbuffer`, presents one fixed
RGBA frame, and records `nativeSurface: true`, `presentedFrame: true`, and a
pixel SHA-256. Its `surfaceBackend` is `softbuffer-raster` and `gpuSurface`
remains `false`; a CPU window presentation cannot satisfy a Skia/Metal/Vulkan
GPU gate. On a headless runner the report is `blocked`, which is distinct from
either a passed native window or a failed runtime.

<a id="windows-和-linux-原生-gl-窗口"></a>
## Native GL windows on Windows and Linux

`gl-window` adds `GlWindowPresenter` using winit 0.30 and glutin 0.32. It owns
an OpenGL 3.3 core context and single-sample window drawable. Windows uses WGL;
Linux uses GLX/EGL on X11 and EGL on Wayland. No GTK dependency is introduced
for the standalone window. The existing C/C++ Desktop SDK remains a separate
embedding adapter (including its GTK 3 parent-view contract).

The presenter receives the application's existing `HostSession`. It attaches
the context through the shared explicit GL symbol resolver and renders the
retained scene directly to framebuffer 0 before swapping buffers. It queries
the actual renderer attachment after hot reload instead of caching a session
id. A minimized zero-size drawable revokes the submitted-frame flag; it must
receive a new frame after restoring/resizing.

All calls and session replacement/destruction must stay on the event-loop
thread. Call `detach_session` before dropping the presenter or its loaded
session: it drains submitted commands and releases Skia while GL is current.
If the context is lost, it abandons the Skia handles and returns the error.
The context and surface are destroyed before their window. The simulator
performs this teardown on both normal exit and event-loop failure.

Known CPU GL drivers are rejected by the public constructor. Driver detection
does not establish hardware execution. `has_gpu_surface` means a frame was
submitted to the GL drawable and swap succeeded; it does not claim GPU
completion or screen presentation. `--software` remains the explicit CPU
choice in the simulator.

Compile the integration and run its display test on Linux:

```sh
cargo check -p container-simulator --features desktop-window --locked
LIBGL_ALWAYS_SOFTWARE=1 xvfb-run -a cargo test -p container-host-desktop -p container-simulator \
  --features container-simulator/desktop-window --locked x11_gl_drawable_renders_resizes_reloads_and_detaches \
  -- --ignored --test-threads=1 --nocapture
```

Only that in-module test permits a CPU GL driver. It checks window framebuffer pixels before swap,
minimize/resize, runtime replacement, detach, and the public driver's rejection
policy. Xvfb/Mesa results cover X11 GL integration; Windows, Wayland and physical
GPU execution require their own runners.
