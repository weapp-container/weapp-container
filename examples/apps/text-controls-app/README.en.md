<a id="dom-文本编辑开发示例"></a>
# DOM Text Editing Development Example

[简体中文](README.md) · **English**


This ordinary `weapp-vite` project demonstrates text editing using real `input` and `textarea`,
`input/focus/blur/confirm` events, cursor/selection observation, disabled states, maxlength, password masking,
and AppService actively replacing value. No new dependencies are introduced, and the original WeChat product can still be opened using official tools.
The container-specific renderer is only enabled when `webview` is declared in `container.config.json`.

Run in the root directory of the repository:

```sh
pnpm simulator:dev -- --project examples/apps/text-controls-app \
  --surface web --renderer webview --web-runtime remote
```

This entry is executed by the native QuickJS, running the AppService/View, with the browser's isolated DOM document handling text editing.
V8 usage is the same as other development examples: enable the `v8-native` feature and pass `--engine v8`.

Suggest checking in sequence:

1. Edit a single-line text field, check the number of input events, echoed cursor/selection, and logs; press Enter to check confirm behavior.
2. Edit multi-line text and press Enter, check native line breaks and the multi-line value in AppService.
3. Use arrow keys and Shift to select text, then continue editing; observe the updated cursor and selection region.
4. Click Disable editors, confirm that neither editor can be edited; after re-enabling, continue typing.
5. Click Replace values from AppService, verify that changes to the declared value replace both fields.
6. Password field demonstrates native masking only; no value is sent to the application event log. Do not input real credentials.

Events are recorded in the bounded private log of the Page, with a maximum of 24 entries. focus/blur and input/confirm both invoke the real `setData` and update the counter, with a specific boundary preventing the restoration of focus from re-triggering application focus.
Focus restoration caused internally by controls does not increment the counter or trigger an infinite presentation loop.
Ordinary events passed from components have no browser handler, propagation path, or owner authorization; they are instead resolved according to declarations in the currently presented document by the shared runtime.

<a id="单独构建"></a>
## Standalone Build

```sh
TEXT_CONTROLS_REPO="$PWD"
cd examples/apps/text-controls-app
node "$TEXT_CONTROLS_REPO/vendor/weapp-vite/packages/weapp-vite/bin/weapp-vite.js" \
  build . -p weapp --outDir "$TEXT_CONTROLS_REPO/artifacts/text-controls-app/raw"
node "$TEXT_CONTROLS_REPO/tools/container-manifest/bin/container-pack.mjs" \
  "$TEXT_CONTROLS_REPO/artifacts/text-controls-app/raw" \
  --out "$TEXT_CONTROLS_REPO/artifacts/text-controls-app/pack" \
  --project "$PWD" \
  --compiler-commit 0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e
```

The compiler generates a managed TypeScript configuration in the project working directory; this location already has precise ignore rules.
Do not run project initialization from the main repository root directory or from a work directory of a fixed submodule.

<a id="当前边界"></a>
## Current boundary

This example is used for development and validation of a new DOM text control adapter; the example source code does not necessarily pass browser-specific testing.
Actual compiler, portable pack, QuickJS/V8, and browser results must be recorded in reports tied to specific source code.

Current cross-document updates for the presenter still replace native iframe/control; complete Chinese input method combination input
Updates proceed without interruption and require subsequent stabilization of native editing surfaces and editing lifecycle protocols. The `isComposing` flag is already in place.
Key protection, Chinese text input, or selection testing cannot substitute this acceptance.
This example does not grant equivalence to real mobile keyboards, native WebView, Skia text editing, or official WeChat, nor does it pass hardware or performance thresholds.
