# SDK 源码构建指南

**简体中文** · [English](sdk-source-build.en.md)

核心仓库固定了 Android、iOS、Desktop、Flutter、React Native 和 Contract SDK 子模块。首次接入建议从同一核心提交构建运行库，并使用 SDK README 中对应的消费示例验证平台封装。

## 准备源码与 portable pack

```sh
git clone --recurse-submodules https://github.com/weapp-container/weapp-container.git
cd weapp-container
corepack enable
pnpm install --frozen-lockfile
node sdk/contract/fixtures/make-acceptance-pack.mjs --out artifacts/hello-pack
```

portable pack 必须是运行库支持的格式。普通小程序源目录不能直接作为 SDK 输入。已有原生或框架构建产物可以用对应 pack 工具打包，不要求使用 weapp-vite。

## 目标平台

| SDK | 必需的开发环境 | 构建入口与示例 |
| --- | --- | --- |
| Android | JDK 17、Android SDK / NDK、Gradle 8.13 | [Android SDK README](../sdk/android/README.md#1-获取运行库) · [reference app](../sdk/android/consumer/README.md) |
| iOS | macOS、Xcode 27.2、Swift 5.9+ | [iOS SDK README](../sdk/ios/README.md#1-获取运行库) · [UIKit consumer](../sdk/ios/examples/consumer/README.md) |
| Desktop | CMake 3.21+、C++17、目标系统工具链 | [Desktop SDK README](../sdk/desktop/README.md#获取运行库并构建) · [consumer](../sdk/desktop/consumer/README.md) |
| Flutter | Flutter 3.47.7、Dart 3.3+、目标平台工具链 | [Flutter SDK README](../sdk/flutter/README.md#2-生成分发包并运行示例) · [example app](../sdk/flutter/example/README.md) |
| React Native | Node.js 24、React Native 0.88、Android 或 Apple 原生工具链 | [React Native SDK README](../sdk/react-native/README.md#从源码生成分发包) · [example app](../sdk/react-native/example/README.md) |
| Contract C ABI | CMake 3.21+、目标系统 C 编译器 | [Contract SDK README](../sdk/contract/README.md) · [C ABI host example](../sdk/contract/examples/consumer/README.md) |

核心仓库没有 `pnpm sdk:build:*` 命令。源码构建由 runtime、license collector 和各 SDK 的包装层工具分步完成。下面给出可复制的 Android、iOS 和 macOS arm64 示例，其他目标使用对应的 Rust target 和平台工具链。

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

### Apple Silicon 上的 Desktop

```sh
node scripts/sdk-native-build.mjs --target aarch64-apple-darwin --out artifacts/sdk/native
node scripts/sdk-licenses.mjs --target aarch64-apple-darwin --features quickjs-native,skia-gpu-metal
node sdk/desktop/tools/build.mjs --target macos-arm64 \
  --native-root artifacts/sdk/native --licenses-root artifacts/sdk/licenses \
  --pack artifacts/hello-pack --out artifacts/sdk/desktop --verify
```

`sdk-native-build.mjs` 默认使用 release profile，并在每个目标的运行库旁写入带版本的 `build.json`。许可收集器默认写入 `artifacts/sdk/licenses/<target>`。如需改用其他目录，可通过 `--out` 指定，并在 SDK 包装层构建时传入相同路径。

React Native 示例使用已发布的 npm 预览包：

```sh
mkdir -p /tmp/weapp-rn-package
npm pack @weapp-container/react-native@0.1.0-preview.7.1 --pack-destination /tmp/weapp-rn-package
node sdk/react-native/tools/create-consumer.mjs \
  --package /tmp/weapp-rn-package/weapp-container-react-native-0.1.0-preview.7.1.tgz \
  --out /tmp/weapp-rn-consumer
```

Flutter 示例通过相邻的 `weapp_container` path package 使用 SDK：

```sh
cd sdk/flutter/example
flutter pub get
flutter analyze lib
flutter run -d <device-id>
```

### Contract C ABI

Contract 示例消费本机编译的 C ABI 静态库。以下命令以 Apple Silicon macOS 为例，其他目标使用对应的 Rust target 和生成目录：

```sh
node scripts/sdk-native-build.mjs --target aarch64-apple-darwin --out artifacts/sdk/native
cmake -S sdk/contract/examples/consumer -B artifacts/sdk/contract-consumer \
  -DWEAPP_CONTAINER_SDK_INCLUDE_DIR="$PWD/artifacts/sdk/native/aarch64-apple-darwin" \
  -DWEAPP_CONTAINER_SDK_LIBRARY="$PWD/artifacts/sdk/native/aarch64-apple-darwin/libweapp_container_sdk.a"
cmake --build artifacts/sdk/contract-consumer --config Release
artifacts/sdk/contract-consumer/contract_consumer "$PWD/artifacts/hello-pack"
```

该命令行消费者会验证 ABI、注册并完成示例主机方法、等待首帧并检查像素缓冲区，最后等待会话关闭事件。Contract SDK 定义原生宿主接口，不提供平台 UI。

各 SDK 页面包含完整的平台参数、安装结构、宿主服务和生命周期用法。先执行最小目标构建，再运行 consumer；编译通过不代表设备、GPU 或性能验收通过。

## 构建记录

发行构建必须从干净且已提交的源码运行，保留构建回执、运行库与 SDK 版本、目标架构和 notices。预编译归档需按随附 manifest 校验版本、架构、大小和 SHA-256。历史私有归档的默认锁不是新用户的下载入口；发行可用性见[SDK 公开发行状态](public-sdk-release.md)。
