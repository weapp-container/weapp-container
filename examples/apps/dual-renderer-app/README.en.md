<a id="双渲染开发示例"></a>
# Dual Rendering Development Example

[简体中文](README.md) · **English**


This ordinary `weapp-vite` project contains three pages: DOM Home Page → Skia Page → New DOM Page.
Two presentation methods share one AppService. It is used for development and interactive inspection, does not indicate official WeChat, GPU performance, native WebView, or seven-host gate access has been passed.

Run in the root directory of the repository, first follow
[Resource Preparation Instructions](../../../crates/container-simulator/README.en.md#local-gpu-scene-presentation)
to prepare fixed-version CanvasKit and font resources:

```sh
pnpm simulator:dev -- --project examples/apps/dual-renderer-app \
  --surface web --renderer auto --web-runtime remote \
  --renderer-assets artifacts/dual-renderer-dev-assets
```

`auto` retains per-page selection and cannot be replaced by global `--renderer webview|skia`. This entry uses native
QuickJS with browser DOM/CanvasKit; the current browser standalone entry does not support `auto`, and native
desktop WebView has not yet been integrated. When V8 is available, enable the `v8-native` feature and pass `--engine v8`.

Suggest checking in the following order:

1. Click the home page twice to count, record the page instance, `ready` count, session, and timer ID.
2. Open the Skia page and click the counter. The page counter starts from zero, and shared clicks continue to accumulate.
3. Return to the home page: the original count and instance are retained, `ready` is not duplicated, and the display count increases.
4. Open the Skia page again and select "Replace with a new DOM page". This page uses a new instance; upon returning, the original home page is still retained. The session, app launch count, and timer ID should remain unchanged.
5. Wait, then click "Refresh shared storage and clock", confirming that the same app clock continues to increment.

The clock updates the App's logical state once per second and samples the display when a page appears or is manually refreshed, avoiding continuous, irrelevant rendering during demonstrations. Shared clicks are stored in `dual-renderer-app:taps`, and the current session identifier is stored in `dual-renderer-app:session`. Within the same session, page and renderer switching, as well as safe in-place reloads, preserve storage and App clock; page data remaining in the page stack is also retained.

The default development sandbox storage is kept in memory. A full JS session restart (including script hot updates) or simulator process restart will clear the sandbox; page counts, shared clicks, and app clock will be reset.
Cross-launch persistence requires the host to provide a persistent storage provider; this example does not integrate this capability.

<a id="构建与-renderer-配置"></a>
## Building and renderer configuration

Reuse the standard CLI and existing packer from a fixed submodule, without adding plugins or modifying upstream:

```sh
pnpm --dir vendor/weapp-vite exec wv build \
  "$PWD/examples/apps/dual-renderer-app" -p weapp \
  --outDir "$PWD/artifacts/dual-renderer-app/raw"
pnpm container:pack -- artifacts/dual-renderer-app/raw \
  --out artifacts/dual-renderer-app/pack \
  --project examples/apps/dual-renderer-app \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
```

`container.config.json` maps **output route path** to `webview → skia → webview`.
The packer must receive `--project` to load this configuration and generate schema 3's
`manifest.rendering`. The development supervisor is already responsible for passing in the source project; no additional configuration is needed.
The original `app.json` and page JSON do not write container-specific renderer values; they are directly run using official tools.
The original output is not enabled with the Skia path here, and is not equivalent to official Skyline acceptance.

Three pages reuse `shared-page.js`, with no additional npm dependencies, code splitting, or custom chunk strategies.
The original module and chunk outputs remain owned by Vite/Rolldown; the portable pack only transforms existing outputs.
State is displayed via the visibility field of the page, without relying on the compiler to retain extra module exports for the mini-program entry point.

<a id="当前验证范围"></a>
## Current validation scope

2026-10-26 Upstream SHA fixed
`0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e` actual execution of WeChat target's `wv build`,
then use existing packer to generate portable pack; two steps passed, schema 3 renderer correctly mapped for three routes, packer diagnostics empty. Build artifacts and logs saved in a separate build directory.

This round did not run the new application in the browser, nor did it run DevTools, the native host, or performance acceptance.
Existing hand-written static fixture records from the browser cannot be transferred into interaction records for this application.
