<a id="build-sdks-from-public-source"></a>
# 从公开源码构建 SDK

**简体中文** · [English](sdk-source-build.en.md)

本页使用核心仓库固定的 preview.7 子模块与构建器组合。公开运行库、iOS 和 Desktop 已发布，其他注册源状态见[发行记录](public-sdk-release.md)。源码构建与已发布归档保留各自提交身份，不能将新源码构建的收据绑定到历史二进制；始终使用相同版本和 ABI。


本页面向首次接入和维护 SDK 的开发者。当前源码可公开获取，不需要历史二进制仓库的凭据。源码构建、离线打包和真实设备验收是三个独立步骤；完成构建不会提升平台验收等级。

<a id="1-prepare-a-clean-checkout"></a>
## 1. 准备干净的 checkout

安装 Git、Node.js 24.18+（24.x）、pnpm 10.15.1、Rust stable、Python 3、Clang 和目标平台工具链。Skia 首次构建可能下载其公开依赖，并需要较长时间。Windows 使用 MSVC；Apple 平台在 macOS 上安装 Xcode 与对应 SDK；Android 使用 JDK 17、SDK/Build Tools 36、NDK 27.1.12297006 和 CMake 3.22.1。

```sh
git clone --recurse-submodules https://github.com/weapp-container/weapp-container.git
cd weapp-container
corepack enable
pnpm install --frozen-lockfile
node sdk/contract/fixtures/make-acceptance-pack.mjs --out artifacts/hello-pack
```

发布级构建要求源码已提交、工作树干净。用固定提交的 SDK 子模块，不混用不同预览版的 headers、运行库或收据。平台依赖、架构和许可说明见 [SDK 仓库](sdk-repositories.md)。

<a id="2-build-a-native-sdk"></a>
## 2. 构建原生 SDK

Android 构建脚本依次生成两种架构的运行库、许可清单、本地 Maven 仓库和 consumer：

```sh
pnpm sdk:build:android -- --pack artifacts/hello-pack
```

输出为 `artifacts/sdk/android/`。宿主应用引用其中 `maven/`，并按 [Android 嵌入说明](https://github.com/weapp-container/sdk-android/blob/main/docs/EMBEDDING.md)放置 portable pack 和挂载视图。

iOS 在 macOS 上构建 device/simulator 切片和 XCFramework：

```sh
pnpm sdk:build:ios -- --install-framework
```

分发目录为 `artifacts/sdk/ios/WeappContainer/`。在 Xcode 添加这个目录中的本地 Swift Package，资源包保留目录结构。真机运行需要应用自己的签名配置，详见 [iOS 接入](https://github.com/weapp-container/sdk-ios/blob/main/README.md)。

桌面先按目标 triple 构建运行库并收集 notices，再打包并运行 consumer。下面针对 Apple Silicon macOS：

```sh
pnpm sdk:build:native -- --target aarch64-apple-darwin --profile release
pnpm sdk:licenses -- --target aarch64-apple-darwin --features quickjs-native,skia-gpu-metal
pnpm sdk:build:desktop -- --target macos-arm64 --pack artifacts/hello-pack --verify
```

Intel macOS 使用 `x86_64-apple-darwin` / `macos-x64`。通用 macOS 包要求先构建两个 slice。Windows 在 Windows 上使用 `x86_64-pc-windows-msvc` / `windows-x64`；Linux 在 Linux 上使用 `x86_64-unknown-linux-gnu` / `linux-x64`，并安装 GTK/OpenGL 开发包。目标名称、最低系统和 CMake 接入见 [Desktop README](https://github.com/weapp-container/sdk-desktop/blob/main/README.md)。

<a id="3-native-inputs-for-flutter-and-react-native"></a>
## 3. Flutter 与 React Native 的原生输入

两种框架的包装层不隐式编译 Rust，也不绕过原生输入校验。它们需要与当前包装层匹配、带收据的 Android/iOS/Desktop SDK 安装。先完成上一节，再用 [运行库打包工具](../tools/runtime-artifacts/README.md)将 SDK 安装打成离线归档，并记录精确的源提交、平台、架构及 SHA-256。

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

针对其它 SDK 使用对应 `ios-sdk` 或 `desktop-sdk` component，并按真实切片设置 `--arch` 和 `--architectures`。iOS 三个 slice 的名称为 `arm64-device,arm64-simulator,x86_64-simulator`，`--install-dir` 指向 `artifacts/sdk/ios/WeappContainer`。桌面指向 `artifacts/sdk/desktop/macos-arm64` 等实际安装目录，单架构 macOS 的公开名称为 `arm64` 或 `x86_64`。不填写不存在的切片。打包器只接受与 `--source-commit` 匹配的干净构建及完整 notices；生成的 `manifest.json` 是本次本地构建的输入清单，不表示已经发布 GitHub Release。

Flutter 以 Android 为例，显式从这份清单和本地归档准备安装，再打包插件：

```sh
node sdk/flutter/tools/prepare-native.mjs \
  --platform android --arch universal \
  --manifest artifacts/local-release/manifest.json \
  --artifact-dir artifacts/local-release
pnpm sdk:build:flutter -- --platform android \
  --manifest artifacts/local-release/manifest.json
```

其它平台同样先准备确切安装。Flutter 3.47.7、平台插件、本地 package 路径、存储与 Controller 生命周期见 [Flutter README](https://github.com/weapp-container/sdk-flutter/blob/main/README.md)。

React Native 包同时要求 Android 和 iOS 的安装。把两者打到同一个本地清单后分别准备，再执行包装层构建：

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

本地清单中的版本、ABI、distribution profile、架构和安装收据必须一致。出现校验错误时修正构建输入，不删除检查或手改旧哈希。React Native 0.88.0 新架构、Codegen 与独立 consumer 见 [React Native README](https://github.com/weapp-container/sdk-react-native/blob/main/README.md)。

<a id="4-package-your-mini-program"></a>
## 4. 打包自己的小程序

原生小程序或已有框架的小程序构建输出可直接输入独立打包器。先确保目录中有 `app.json` 以及对应 JS/WXML/WXSS 等产物；TypeScript、Vue、React 源文件应先由原项目工具编译。

```sh
pnpm container:pack -- /absolute/mini-program-output --out artifacts/my-pack
```

`weapp-vite` 是可选构建集成。打包器和宿主 SDK 不要求使用它。包结构、能力和完整性说明见 [container-manifest](../tools/container-manifest/README.md)。

<a id="5-verify-and-troubleshoot"></a>
## 5. 验证与故障定位

先核对运行库版本、ABI、架构及 producer receipt，再检查 View 已挂载且实际尺寸为正。注册宿主方法后才加载 pack；异步处理 ready/error 事件；离开页面时持久化并关闭会话。不要在 UI 线程同步等待关闭或加载。

模拟器、真实 GPU surface、设备输入、权限、存储重开、前后台和签名分别验收。网页固定演示不能加载任意 pack。公开源码构建输出遵循对应源码与依赖许可；历史预编译二进制仍遵循自身的许可、哈希与访问权限，见 [历史迁移](runtime-artifacts-migration.md)。
