<a id="桌面跨平台架构与后续方向"></a>
# Cross-platform desktop architecture and next steps

[简体中文](desktop-architecture.md) · **English**

Weapp Container needs both a standalone simulator and embedded SDKs. The existing layers—Rust runtime, batched bridge, Skia renderer, and platform hosts—serve both goals and should remain. GTK, Flutter, and winit address different host integration requirements; they do not need to become one GUI framework.

<a id="当前边界"></a>
## Current boundaries

```text
portable manifest / blobs
          │
          ▼
Rust Session：JS 引擎、页面栈、View、布局、渲染帧与输入权限
          │
          ├── 独立模拟器：winit + Metal / OpenGL / softbuffer
          ├── Desktop SDK：NSView / HWND / GTK 3 视图
          └── Flutter SDK：宿主控件与纹理接入
```

Session is the sole owner of mini-program state. The host handles the event loop, windows, input conversion, drawables, device permissions, and resource cleanup. Native GPU paths provide a drawing target to the shared Skia renderer; only software paths read RGBA snapshots. A Flutter shell may own connection and settings UI, but should not keep another mini-program navigation stack or copy rendering state node by node.

The Linux Desktop SDK currently requires GTK 3.24 and a `GtkContainer*` parent. This constrains the existing embedding adapter; the Rust runtime and standalone winit window do not require GTK. GTK 4/Qt hosts need their own adapters and cannot pass their widget pointers as GTK 3 widgets. Native parent views, external textures, and standalone windows also cannot be interchanged through one untyped handle.

<a id="这轮实现"></a>
## Current implementation

Previously, only macOS Metal provided native GPU presentation in the standalone simulator; Windows/Linux required explicit software mode. The Desktop SDK already used the shared GL renderer, but the standalone simulator had no corresponding window/context owner.

The new `container-host-desktop/gl-window` uses winit/glutin to create an OpenGL 3.3 core window: WGL on Windows, GLX/EGL on Linux X11, and EGL on Wayland. It attaches the existing renderer through `HostSession::attach_gl_context_with`, draws the current retained scene into the window framebuffer, and swaps buffers. The GL resolver only provides GL entry points so GLX/WGL cannot return invalid addresses for EGL functions probed by Skia. This path adds neither GTK nor a second Session.

Lifecycle rules:

- Context operations, presentation, session replacement, and destruction run on the event-loop thread. Hot reload queries the new renderer's actual GL attachment before rebinding; it does not infer validity from an old session id.
- Resize clears input geometry and presentation flags. Zero-size windows suspend presentation; restoring input requires a new frame after recovery.
- Native backends share revision ACKs. Input coordinate conversion is published only after the runtime accepts the presentation receipt.
- Normal exit and event-loop errors detach the session before releasing context, surface, and window. Failure to make the context current abandons Skia handles and returns an error; cleanup failure cannot merely be logged as success.
- The default GL constructor rejects known CPU drivers. `--software` remains the explicit software option. Successful GL submission and swap do not establish physical GPU execution, GPU completion, or screen scanout.

The new X11 display integration test uses a real GL drawable to check pixels, resize, session replacement, and detach, plus public-constructor rejection of software GL drivers. Only this test permits Mesa software drivers for protocol and lifecycle verification. Windows, Wayland, hardware GPU, and performance require independent acceptance. Commands are in the [desktop host guide](../crates/container-host-desktop/README.en.md#native-gl-windows-on-windows-and-linux).

<a id="后续优先级"></a>
## Next priorities

1. **Accept the existing desktop paths first.** Run the same presentation, minimize, DPI-switch, hot-reload, and close cases on physical Windows hosts, Linux X11/Wayland, and macOS. Record the actual driver and environment; capability features cannot replace these results.
2. **Converge GPU lifecycle contracts.** Rust standalone windows and the C++ SDK may own separate platform resources, but context attach/detach/abandon, frame revisions, presentation stages, and input permissions must retain shared runtime semantics. Verify both entry points with the same fixtures before adding backends.
3. **Add input methods and accessibility.** Keyboard events do not replace IME composition, and a Skia image does not automatically provide a system accessibility tree. Map shared View semantics to each host without rebuilding the business tree in platform code.
4. **Extend embedding for actual consumers.** Add explicitly named, independently built GTK 4/Qt adapters when required. Share Session and device providers, retain the host's main loop, and do not force a switch to winit or Flutter.
5. **Use measurements to choose GPU backends.** OpenGL 3.3 is the first step in reusing the existing Skia GL interface. Implement Vulkan/Direct3D resource and synchronization boundaries if driver coverage, latency, or deployment requirements justify them. The `vulkan` / `direct2d` feature names do not establish implemented presenters.

Extract later abstractions from constraints shared by at least two implemented backends. Adding a general GUI layer or another JS/Go runtime now would increase threading, ownership, build, and distribution costs without directly filling these gaps.
