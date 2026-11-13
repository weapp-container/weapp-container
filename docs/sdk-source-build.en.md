<a id="从公开源码构建-sdk"></a>
# Build SDKs from public source

[简体中文](sdk-source-build.md) · **English**

This page uses the core checkout’s pinned preview.7 submodules and builders. Public runtime, iOS and Desktop archives are available; see the [release record](public-sdk-release.en.md) for other registries. Source builds and published archives retain distinct producer identities. Never bind new source receipts to historical binary bytes; always match versions and ABI.


This guide covers initial integration and SDK maintenance. Current source is public and does not require credentials for historical binary archives. Building, offline packaging, and device acceptance are separate steps. A successful build does not change a platform's acceptance status.

<a id="1-准备干净的-checkout"></a>
## 1. Prepare a clean checkout

Install Git, Node.js 24.18+ (24.x), pnpm 10.15.1, stable Rust, Python 3, Clang, and the target platform's toolchain. An initial Skia build can download public dependencies and take considerable time. Windows requires MSVC. Apple targets require macOS, Xcode, and the relevant SDKs. Android requires JDK 17, SDK/Build Tools 36, NDK 27.1.12297006, and CMake 3.22.1.

```sh
git clone --recurse-submodules https://github.com/weapp-container/weapp-container.git
cd weapp-container
corepack enable
pnpm install --frozen-lockfile
node sdk/contract/fixtures/make-acceptance-pack.mjs --out artifacts/hello-pack
```

Release builds require committed source and a clean working tree. Use the pinned SDK submodules; do not combine headers, runtimes, or receipts from different preview versions. See [SDK repositories](sdk-repositories.en.md) for platform dependencies, architectures, and licensing.

<a id="2-构建原生-sdk"></a>
## 2. Build a native SDK

The Android script builds both runtime architectures, collects notices, and creates a local Maven repository and consumer:

```sh
pnpm sdk:build:android -- --pack artifacts/hello-pack
```

Output goes to `artifacts/sdk/android/`. Reference its `maven/` directory from the host application and follow the [Android embedding guide](https://github.com/weapp-container/sdk-android/blob/main/docs/EMBEDDING.en.md) to add a portable pack and mount the view.

On macOS, build the iOS device/simulator slices and XCFramework:

```sh
pnpm sdk:build:ios -- --install-framework
```

The distribution is `artifacts/sdk/ios/WeappContainer/`. Add that local Swift Package in Xcode and preserve pack resource directories. Physical devices need the application's signing configuration. See the [iOS integration guide](https://github.com/weapp-container/sdk-ios/blob/main/README.en.md).

For desktop, build the target runtime and notices first, then package and run the consumer. This example targets Apple Silicon macOS:

```sh
pnpm sdk:build:native -- --target aarch64-apple-darwin --profile release
pnpm sdk:licenses -- --target aarch64-apple-darwin --features quickjs-native,skia-gpu-metal
pnpm sdk:build:desktop -- --target macos-arm64 --pack artifacts/hello-pack --verify
```

Intel macOS uses `x86_64-apple-darwin` / `macos-x64`. A universal macOS package requires both slices. Build Windows targets on Windows using `x86_64-pc-windows-msvc` / `windows-x64`; build Linux targets on Linux using `x86_64-unknown-linux-gnu` / `linux-x64` with GTK/OpenGL development packages. The [Desktop README](https://github.com/weapp-container/sdk-desktop/blob/main/README.en.md) lists target names, minimum systems, and CMake integration.

<a id="3-flutter-与-react-native-的原生输入"></a>
## 3. Native inputs for Flutter and React Native

These framework wrappers do not compile Rust implicitly or bypass native input verification. They require Android/iOS/Desktop SDK installations with receipts that match the current wrapper. Complete the previous section, then use the [runtime packaging tools](../tools/runtime-artifacts/README.en.md) to create offline SDK archives with exact source commits, platforms, architectures, and SHA-256 hashes.

```sh
# Run in a clean checkout. Replace SOURCE_COMMIT with the output of git rev-parse HEAD.
pnpm runtime:package -- \
  --source-commit SOURCE_COMMIT \
  --native-root artifacts/sdk/native --licenses-root artifacts/sdk/licenses \
  --component android-sdk --platform android --arch universal \
  --architectures arm64-v8a,x86_64 \
  --install-dir artifacts/sdk/android \
  --out-dir artifacts/local-release
```

For other SDKs, use the `ios-sdk` or `desktop-sdk` component and declare the actual slices through `--arch` and `--architectures`. The three iOS slice names are `arm64-device,arm64-simulator,x86_64-simulator`; its `--install-dir` is `artifacts/sdk/ios/WeappContainer`. Desktop installations use directories such as `artifacts/sdk/desktop/macos-arm64`, and public single-slice macOS architecture names are `arm64` and `x86_64`. Do not declare missing slices. The packager requires clean builds and complete notices matching `--source-commit`. The generated `manifest.json` describes local inputs; it does not indicate that a GitHub Release was published.

For Flutter Android, explicitly prepare the installation from this manifest and the local archives, then package the plugin:

```sh
node sdk/flutter/tools/prepare-native.mjs \
  --platform android --arch universal \
  --manifest artifacts/local-release/manifest.json \
  --artifact-dir artifacts/local-release
pnpm sdk:build:flutter -- --platform android \
  --manifest artifacts/local-release/manifest.json
```

Prepare exact installations for other platforms in the same way. See the [Flutter README](https://github.com/weapp-container/sdk-flutter/blob/main/README.en.md) for Flutter 3.47.7, platform plugins, local package paths, storage, and Controller lifecycle.

The React Native package requires both Android and iOS installations. Package both into one local manifest, prepare each installation, and build the wrapper:

```sh
node sdk/react-native/tools/prepare-native.mjs \
  --platform android --arch universal \
  --manifest artifacts/local-release/manifest.json \
  --artifact-dir artifacts/local-release
node sdk/react-native/tools/prepare-native.mjs \
  --platform ios --arch universal \
  --manifest artifacts/local-release/manifest.json \
  --artifact-dir artifacts/local-release
pnpm sdk:build:react-native -- \
  --manifest artifacts/local-release/manifest.json \
  --artifact-dir artifacts/local-release
```

Manifest versions, ABI, distribution profile, architectures, and installation receipts must match. Fix build inputs when verification fails; do not remove checks or edit historical hashes. See the [React Native README](https://github.com/weapp-container/sdk-react-native/blob/main/README.en.md) for React Native 0.88.0, the new architecture, Codegen, and independent consumers.

<a id="4-打包自己的小程序"></a>
## 4. Package your mini-program

The standalone packer accepts native mini-programs or existing mini-program build output. The input must contain `app.json` and the relevant JS/WXML/WXSS artifacts. Compile TypeScript, Vue, or React sources with the original project's tools first.

```sh
pnpm container:pack -- /absolute/mini-program-output --out artifacts/my-pack
```

`weapp-vite` is an optional build integration. Neither the packer nor host SDK requires it. See [container-manifest](../tools/container-manifest/README.en.md) for pack structure, capabilities, and integrity.

<a id="5-验证与故障定位"></a>
## 5. Verify and troubleshoot

Check the runtime version, ABI, architecture, and producer receipt first. Confirm that the View is mounted with a positive actual size. Register host methods before loading the pack, handle ready/error events asynchronously, and persist and close the session when leaving the page. Do not synchronously wait for loading or closing on the UI thread.

Verify simulators, real GPU surfaces, device input, permissions, storage reopening, foreground/background transitions, and signing separately. The fixed browser demo cannot load arbitrary packs. Source builds follow their source and dependency licenses; historical binaries retain their own licenses, hashes, and access requirements. See [historical migration](runtime-artifacts-migration.en.md).
