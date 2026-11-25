# SDK Source Build Guide

[简体中文](sdk-source-build.md) · **English**

The core repository pins the Android, iOS, Desktop, Flutter, React Native, and Contract SDK submodules. For an initial integration, build the runtime from one core revision and validate the platform wrapper with the matching consumer example in its SDK README.

## Check Out the Source and Create a Portable Pack

```sh
git clone --recurse-submodules https://github.com/weapp-container/weapp-container.git
cd weapp-container
corepack enable
pnpm install --frozen-lockfile
node sdk/contract/fixtures/make-acceptance-pack.mjs --out artifacts/hello-pack
```

A portable pack must use a format supported by the runtime. An ordinary mini-program source directory is not a valid SDK input. Existing native or framework build outputs can be packaged with the corresponding pack tool; weapp-vite is not required.

## Platform Targets

| SDK | Required development environment | Build entry and example |
| --- | --- | --- |
| Android | JDK 17, Android SDK / NDK, Gradle 8.13 | [Android SDK README](../sdk/android/README.en.md#1-obtain-the-runtime-library) · [reference app](../sdk/android/consumer/README.en.md) |
| iOS | macOS, Xcode 27.2, Swift 5.9+ | [iOS SDK README](../sdk/ios/README.en.md#1-obtain-runtime-library) · [UIKit consumer](../sdk/ios/examples/consumer/README.en.md) |
| Desktop | CMake 3.21+, C++17, target-system toolchain | [Desktop SDK README](../sdk/desktop/README.en.md#obtain-runtime-and-build) · [consumer](../sdk/desktop/consumer/README.en.md) |
| Flutter | Flutter 3.47.7, Dart 3.3+, target-platform toolchain | [Flutter SDK README](../sdk/flutter/README.en.md#2-build-a-distribution-and-run-the-example) · [example app](../sdk/flutter/example/README.en.md) |
| React Native | Node.js 24, React Native 0.88, Android or Apple native toolchain | [React Native SDK README](../sdk/react-native/README.en.md#build-a-distribution-from-source) · [example app](../sdk/react-native/example/README.en.md) |
| Contract C ABI | CMake 3.21+, target-system C compiler | [Contract SDK README](../sdk/contract/README.en.md) · [C ABI host example](../sdk/contract/examples/consumer/README.en.md) |

The core repository has no `pnpm sdk:build:*` commands. Source builds use the runtime builder, license collector, and each SDK wrapper's build tool as separate steps. The following copyable examples cover Android, iOS, and macOS arm64. Use the matching Rust target and platform toolchain for other targets.

### Android

```sh
node scripts/sdk-native-build.mjs --target aarch64-linux-android --out artifacts/sdk/native
node scripts/sdk-licenses.mjs --target aarch64-linux-android --features quickjs-native-android,skia-gpu-gles
node scripts/sdk-native-build.mjs --target x86_64-linux-android --out artifacts/sdk/native
node scripts/sdk-licenses.mjs --target x86_64-linux-android --features quickjs-native-android,skia-gpu-gles
node sdk/android/tools/build.mjs --native-root artifacts/sdk/native \
  --licenses-root artifacts/sdk/licenses --pack artifacts/hello-pack \
  --out artifacts/sdk/android
```

### iOS

```sh
node scripts/sdk-native-build.mjs --target aarch64-apple-ios --out artifacts/sdk/native
node scripts/sdk-licenses.mjs --target aarch64-apple-ios --features quickjs-native-ios,skia-gpu-metal
node scripts/sdk-native-build.mjs --target aarch64-apple-ios-sim --out artifacts/sdk/native
node scripts/sdk-licenses.mjs --target aarch64-apple-ios-sim --features quickjs-native-ios,skia-gpu-metal
node scripts/sdk-native-build.mjs --target x86_64-apple-ios --out artifacts/sdk/native
node scripts/sdk-licenses.mjs --target x86_64-apple-ios --features quickjs-native-ios,skia-gpu-metal
node sdk/ios/tools/build.mjs --native-root artifacts/sdk/native \
  --licenses-root artifacts/sdk/licenses --out artifacts/sdk/ios --install-framework
```

### Desktop on Apple Silicon

```sh
node scripts/sdk-native-build.mjs --target aarch64-apple-darwin --out artifacts/sdk/native
node scripts/sdk-licenses.mjs --target aarch64-apple-darwin --features quickjs-native,skia-gpu-metal
node sdk/desktop/tools/build.mjs --target macos-arm64 \
  --native-root artifacts/sdk/native --licenses-root artifacts/sdk/licenses \
  --pack artifacts/hello-pack --out artifacts/sdk/desktop --verify
```

The `sdk-native-build.mjs` script defaults to a release profile and writes a versioned `build.json` beside each target's libraries. The license collector defaults to `artifacts/sdk/licenses/<target>`. Pass `--out` to choose another location, then provide the same locations to the wrapper build.

The React Native example consumes the published npm prerelease:

```sh
mkdir -p /tmp/weapp-rn-package
npm pack @weapp-container/react-native@0.1.0-preview.7.1 --pack-destination /tmp/weapp-rn-package
node sdk/react-native/tools/create-consumer.mjs \
  --package /tmp/weapp-rn-package/weapp-container-react-native-0.1.0-preview.7.1.tgz \
  --out /tmp/weapp-rn-consumer
```

The Flutter example uses the sibling `weapp_container` path package:

```sh
cd sdk/flutter/example
flutter pub get
flutter analyze lib
flutter run -d <device-id>
```

### Contract C ABI

The Contract example consumes a C ABI static library built for the local target. The following commands use Apple Silicon macOS. Use the matching Rust target and output directory for another platform:

```sh
node scripts/sdk-native-build.mjs --target aarch64-apple-darwin --out artifacts/sdk/native
cmake -S sdk/contract/examples/consumer -B artifacts/sdk/contract-consumer \
  -DWEAPP_CONTAINER_SDK_INCLUDE_DIR="$PWD/artifacts/sdk/native/aarch64-apple-darwin" \
  -DWEAPP_CONTAINER_SDK_LIBRARY="$PWD/artifacts/sdk/native/aarch64-apple-darwin/libweapp_container_sdk.a"
cmake --build artifacts/sdk/contract-consumer --config Release
artifacts/sdk/contract-consumer/contract_consumer "$PWD/artifacts/hello-pack"
```

This command-line consumer checks the ABI, registers and completes the sample host method, waits for a frame and inspects its pixels, then waits for the session's close event. Contract defines native host interfaces and does not provide a platform UI.

Each SDK page describes platform flags, installation layout, host services, and lifecycle handling. Run the smallest relevant build before the consumer example. Compilation alone does not establish device, GPU, or performance acceptance.

## Build Records

Release builds must use clean, committed source and retain build receipts, runtime and SDK versions, target architectures, and notices. Verify prebuilt archives against their manifests for version, architecture, size, and SHA-256. Default locks for historical private archives are not download instructions for new users. See the [public SDK release status](public-sdk-release.en.md) for artifact availability.
