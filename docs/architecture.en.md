<a id="容器架构"></a>
# Container Architecture

[简体中文](architecture.md) · **English**


```text
原生小程序目录 / 任意兼容框架的构建产物
    ├── 原始微信目录（供官方 DevTools）
    └── container-manifest pack（独立打包工具）
            └── manifest v1 + content-addressed blobs
                    └── Rust container-core
                            ├── AppService（QuickJS / V8）
                            ├── View tree + batched data patches
                            └── Skia renderer
                                    ├── Web / CanvasKit WASM
                                    ├── Desktop / native window
                                    ├── Android / NDK
                                    ├── iOS / staticlib
                                    └── Harmony / FFI
```

Packaging and host integration do not depend on weapp-vite. It can serve as one of the upstream builders; existing native directories or compatibility products from other frameworks can be directly included in the same portable pack path.

AppService, View, and Renderer are connected through batched bridge envelopes. The JS runtime submits only batches of state changes and events, while the renderer completes layout, rendering, and compositing on the native side, avoiding round-trips across languages per node.

The host can set an [execution deadline](appservice-execution.en.md) for the entire QuickJS operation, including presentation acknowledgements, resize, and cleanup entry points that indirectly execute JS. An interrupted session requires explicit replacement.

WXSS layout values are written into the shared `LayoutStyle` after being converted to physical pixels based on the current viewport at runtime. Static/relative positioning participates in the parent's flex flow; absolute positioning is relative to the nearest positioned ancestor, and fixed positioning is relative to the viewport; the four inset edges remain optional to preserve negative values and relative side constraints. `display:none` clears the node's geometry during layout and removes it from the flow, ensuring consistency across selectors, hit testing, and host screenshot observations. `flex-direction` values of `row-reverse`/`column-reverse` place child nodes at the end of the main axis, while preserving the WXML tree order for event and selector usage.

The mobile host accesses the same `Session` via the pointer/length ABI of `container-host-common::FfiBuffer`: Android's JNI/CMake, iOS's Swift/C header, and HarmonyOS's ArkTS/N-API examples only manage thread ownership, surface lifecycle, and byte ownership; the page stack and protocol state are still exclusively maintained by the Rust runtime. The corresponding project is located at `examples/hosts/`, and can be structured and cross-target checked using `scripts/build-native-hosts.mjs`.

<a id="版本与边界"></a>
## Version and Boundaries

- manifest schema and bridge protocol are versioned independently; version and capability matrix are negotiated at startup.
- The original WeChat product is always retained; portable IR is a reconstructable derivative.
- The Rust native path must retain JS/headless fallback, and differential testing is performed against the observable behavior of `@mpcore/simulator` and real DevTools.
- Android, iOS, HarmonyOS, and desktop are container hosts and are not included in the weapp-vite mini-program compilation platform registry.
