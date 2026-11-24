# SDK 公开发行状态

**简体中文** · [English](public-sdk-release.en.md)

核验日期：2026-11-25。当前可见发行均为预览版，没有正式稳定版本。源代码公开、注册源可下载、构建通过和设备验收是不同状态。

| SDK / 发行物 | `0.1.0-preview.7.1` 状态 | 当前限制 |
| --- | --- | --- |
| 核心运行库 | GitHub `runtime-v0.1.0-preview.7.1` prerelease 可匿名下载 | 不是稳定版 |
| DevTools | GitHub `devtools-v0.1.0-preview.7.2` prerelease 可匿名下载 | macOS 与 Windows 包未签名；不是稳定版 |
| Android | Maven Central 坐标 `io.github.weapp-container:weapp-container-android:0.1.0-preview.7.1` 可解析 | 仅预览版 |
| React Native | npm `@weapp-container/react-native@0.1.0-preview.7.1` 可安装；Android 依赖可解析 | iOS 原生依赖的固定归档 URL 尚不可用 |
| Flutter | 七个 hosted package 的 `.7.1` 均已发布到 pub.dev | 各平台原生构建结果仍需按目标分别验证 |
| iOS | 核心 prerelease 含 iOS SDK tarball | `sdk-ios` 的 SwiftPM 与 CocoaPods 固定归档 URL 返回 404；其独立 GitHub release 尚不存在 |
| Desktop | 核心 prerelease 含 macOS、Linux、Windows SDK tarball | `sdk-desktop` 独立 GitHub release 尚不存在；公开 CocoaPods Specs 中的 macOS 归档 URL 返回 404 |

可直接使用的预览安装入口如下：

```kotlin
implementation("io.github.weapp-container:weapp-container-android:0.1.0-preview.7.1")
```

```sh
npm install @weapp-container/react-native@0.1.0-preview.7.1
```

```yaml
dependencies:
  weapp_container: 0.1.0-preview.7.1
```

Android、Flutter 和 React Native 包版本已通过 Maven Central、pub.dev、npm 的匿名元数据请求核对。iOS / Desktop 安装状态也检查了对应 GitHub release、CocoaPods Specs 和固定归档 URL。未观测到 CocoaPods Trunk 上的 `WeappContainer` 或 `WeappContainerDesktop` 条目。

## 示例应用

每个 SDK 示例以同版本的 portable fixture 演示宿主集成。先查看平台 README 中的系统要求和发行限制，再按示例目录中的命令生成 fixture、构建应用并启动设备或模拟器。

- [Android reference app](../sdk/android/consumer/README.md)
- [iOS UIKit consumer](../sdk/ios/examples/consumer/README.md)
- [React Native consumer](../sdk/react-native/example/README.md)
- [Flutter consumer](../sdk/flutter/example/README.md)
- [Desktop consumer](../sdk/desktop/consumer/README.md)

## 稳定版发行门槛

稳定发行需要独立稳定版本、每个 SDK 的固定安装归档、匿名安装消费验证，以及对应包管理器的目标平台构建记录。当前 `.7.1` 是 prerelease，不能作为稳定版记录。iOS / Desktop 的 GitHub 归档未发布，因此引用这些归档的 SPM、CocoaPods 和 React Native iOS 安装路径也不能报告可用。
