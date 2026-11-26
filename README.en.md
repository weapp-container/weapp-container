# Weapp Container

[简体中文](README.md) · **English**

An independent open-source portable runtime for loading mini-program-shaped pages, components, scripts, and styles in a controlled process. It also accepts unpacked, unencrypted mini-game output through a schema-v4 manifest, with a Canvas 2D subset and host-delivered platform-neutral game events. The repository contains a manifest packer, Rust runtime, QuickJS/V8 engines, a simulator, and Node test bindings.

This community-developed project is not affiliated with, officially authorized or endorsed by, or commercially partnered with Tencent/WeChat, Ant Group/Alipay, or their platforms and services. Platform names, marks, and API identifiers describe compatibility targets or upstream sample sources. All rights in those marks remain with their respective owners. Third-party open-source code is distributed under the licenses included with each component.

## Download and use

Use the desktop DevTools from the [download page](https://container.weapp.dev/downloads/). Choose the installer for your operating system and processor, then open an existing mini-program project. You can also try fixed samples in the [online demo](https://container.weapp.dev/) without downloading project source.

For application integration, start with the public SDK package or release archive for your platform. See the [SDK release status](docs/public-sdk-release.en.md).

## Repository development checks

These commands are for maintainers and contributors, not required to install or preview the application.

```sh
pnpm install
pnpm container:manifest:test
pnpm conformance:verify
pnpm api:inventory:verify
```

The Node bindings consume source directories or prebuilt portable packs. Callers choose and manage any compiler, host service, or external network integration themselves.

Application developers can start with the [mini-program development loop](docs/mini-program-closed-loop.en.md), which connects inspection, compilation, preview, scenario testing, and auditable release in one path.

## Native SDK Examples and Release Status

Reference consumers for Android, iOS, React Native, Flutter, and Desktop live in the `sdk/` submodules. They cover pack loading, sessions, views, messages, navigation, storage, and lifecycle ownership. Public registries currently provide the `0.1.0-preview.7.1` prerelease, and no stable version is available. See the [SDK release status](docs/public-sdk-release.en.md) and each SDK README for normal installation methods, limitations, and runnable examples. The [source build guide](docs/sdk-source-build.en.md) is for SDK maintainers rebuilding release artifacts.

- [Android example app](sdk/android/consumer/README.en.md)
- [iOS UIKit example app](sdk/ios/examples/consumer/README.en.md)
- [React Native example app](sdk/react-native/example/README.en.md)
- [Flutter example app](sdk/flutter/example/README.en.md)
- [Desktop consumer example](sdk/desktop/consumer/README.en.md)
- [Contract C ABI host example](sdk/contract/examples/consumer/README.en.md)

## DevTools preview

The desktop DevTools packages include pinned Node.js, weapp-vite, the manifest packer and the simulator. After installation, choose a project directory. The launcher checks `project.config.json`, the source `app.json`, the compiler compatibility matrix and project dependencies before starting the Web Player or Desktop Player. The current production samples are `examples/apps/community/miniprogram-demo-text`, `ant-design-button`, `taro-blended`, and `examples/apps/shop-demo`.

Each package includes `weapp-devtools.json` with source, compiler, Node, compatibility and file-hash metadata. Stable releases use a signed update manifest, Developer ID signing and notarization for macOS, and Authenticode signing for Windows MSI. The release workflow fails before publishing when stable signing inputs are missing. Preview releases do not participate in stable updates. Release signing, platform installation and official-tool evidence remain platform-specific and are not replaced by local headless checks.

Maintainers can exercise the launcher, project preflight, Web Player rendering and interaction, in-place WXSS reload, JS restart, failed-build retention and recovery with the repository's minimal project:

```sh
pnpm devtools:loop:smoke
```

The report defaults to `~/.codex/private-validation/weapp-container/devtools-loop/report.json`. Pass `--project <dir>` to preflight, launch and inspect the first screen of another supported project. The full hot-reload regression uses the repository's minimal project. This check uses the locally built simulator and headless Chromium. It covers the local Web development loop. The official WeChat DevTools baseline and real devices remain separate gates.

### Launch unsigned prereleases

The current GitHub prerelease macOS and Windows installers are not platform-signed, so the first launch may show an operating-system warning. Download only from the matching GitHub Release and compare the file with the `SHA256SUMS` entry published there before removing the download marker.

On macOS, choose the `.dmg` that matches the processor architecture. Choose `macos-arm64` for Apple Silicon and `macos-x86_64` for Intel Macs. Open the DMG, drag `Weapp Container DevTools.app` to Applications, then run:

```sh
shasum -a 256 "$HOME/Downloads/weapp-container-devtools-macos-arm64.dmg"
xattr -dr com.apple.quarantine "/Applications/Weapp Container DevTools.app"
open "/Applications/Weapp Container DevTools.app"
```

The website marks the matching DMG when the browser exposes a reliable architecture hint. Safari and browsers without a reliable hint show both options for manual selection. Portable `.tar.gz` and `.zip` archives remain in the GitHub Release, while the website exposes only directly installable DMG, DEB, and MSI packages.

`xattr` removes only this app's macOS quarantine metadata. It does not create a signature or notarization. Replace the path when the app is installed elsewhere. Do not disable Gatekeeper globally to run a prerelease.

For the Windows MSI, verify the hash, remove that file's Zone Identifier, and start it from PowerShell:

```powershell
Get-FileHash "$env:USERPROFILE\Downloads\weapp-container-devtools-windows-x86_64.msi" -Algorithm SHA256
Unblock-File -Path "$env:USERPROFILE\Downloads\weapp-container-devtools-windows-x86_64.msi"
Start-Process "$env:USERPROFILE\Downloads\weapp-container-devtools-windows-x86_64.msi"
```

For a ZIP package, run `Unblock-File` on the ZIP before extracting it. If SmartScreen still appears, choose **More info** > **Run anyway** only after the release source and hash have been verified. `Unblock-File` removes only the downloaded file's Zone Identifier. It does not create an Authenticode signature. Do not disable Defender or SmartScreen globally. Platform-signed stable packages, with notarization on macOS, should not require these manual steps.

## Mini-games

Pack and run an unpacked mini-game build with the QuickJS simulator:

```sh
pnpm container:pack -- ./game-dist --game --out ./artifacts/game
cargo run -p container-simulator --features quickjs-native -- \
  run --pack ./artifacts/game --snapshot ./artifacts/game/snapshot.json
```

This path requires `game.json` and `game.js`. It does not decrypt platform packages. The portable game runtime provides a Canvas 2D subset, frame scheduling, and normalized host events through `game.event` for touch, keyboard, sensor, audio interruption and memory warnings. App visibility uses `app.lifecycle`; viewport updates resize the game Canvas and notify `wx.onWindowResize`. Event payloads follow [`schemas/game-event-v1.schema.json`](schemas/game-event-v1.schema.json). API support remains capability-negotiated. Official DevTools, GPU and device parity remain unverified.

## Open-source mini-program examples

`examples/apps/community/` contains three curated runnable snapshots: an upstream `miniprogram-demo` text page, an Ant Design Mini button component, and a Taro blended-basic page. Each sample retains its upstream MIT license. Its directory guide and `SOURCES.json` record the repository, pinned commit, and local adaptations.

```sh
pnpm --dir vendor/weapp-vite exec wv build \
  "$PWD/examples/apps/community/miniprogram-demo-text" -p weapp \
  --outDir "$PWD/artifacts/community/miniprogram-demo-text/raw"
pnpm container:pack -- artifacts/community/miniprogram-demo-text/raw \
  --out artifacts/community/miniprogram-demo-text/pack \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
cp examples/apps/community/miniprogram-demo-text/LICENSE.upstream \
  artifacts/community/miniprogram-demo-text/pack/LICENSE.upstream
pnpm simulator:dev:smoke -- \
  --project examples/apps/community/miniprogram-demo-text
```

Replace `miniprogram-demo-text` with `ant-design-button` or `taro-blended` for the other samples. See [`examples/apps/community/README.en.md`](examples/apps/community/README.en.md) for the complete sample list, commands, and source records.

To keep the simulator running in a browser:

```sh
cargo run -p container-simulator --features quickjs-native -- \
  dev --project examples/apps/community/miniprogram-demo-text --surface web
```

## License

Apache-2.0. See [NOTICE](NOTICE) and [SECURITY](SECURITY.en.md).
