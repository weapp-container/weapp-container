# Reference mini-program

This is the small app used by the simulator and host embedding examples. It
exercises app and page lifecycle hooks, query data, WXML bindings, WXSS layout,
events and `setData`.

`data.lifecycleTrace` records callbacks executed by the App and Page themselves.
The initial trace is `app:launch → app:show → page:load → page:show → page:ready`;
background/resume adds `app:hide → page:hide → app:show → page:show`.
`onResize` also copies the actual `wx.getWindowInfo()` result into
`data.windowInfo`. `moduleScopeHostInfo` captures window, device, system and
settings APIs before `App(...)` executes; `resizeHostInfo` captures them inside
the resize callback, `tapHostInfo` captures them on a real page tap, and
`showHostInfo` captures them during page foreground callbacks.
Android verification compares these snapshots with independent `adb shell wm
size` and `wm density` observations, including density changes and restoration
of any pre-existing display overrides. A density change while paused also checks
that the new snapshot is available before `onShow`. Host labels alone do not prove these
callbacks ran or that the initial JS cache was installed before module loading.
The combined callback order is a runtime regression contract; the separate
existing DevTools App/Page traces do not yet prove the combined background
order on the fixed official baseline.

The native `components/managed-counter` example receives an object-valued
`config` property, keeps its own counter, and renders page-owned slot content.
Click `#component-increment` to update only the component count; click the
slotted `#component-slot` text to update the page count through its page handler.
The original page controls and IDs remain available for simulator smoke tests.

Build it from the repository root with the fixed `weapp-vite` submodule:

```sh
pnpm --dir vendor/weapp-vite exec wv build \
  "$PWD/examples/apps/reference-app" -p weapp \
  --outDir dist
pnpm container:pack -- examples/apps/reference-app/dist \
  --out artifacts/reference-app/pack \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
```

The resulting `artifacts/reference-app/pack` directory contains
`manifest.json` and `blobs/sha256`. It is the portable input shared by the
headless simulator and the native embedding example.
