# weapp-container 0.1.0-preview.7.0 发布状态

已公开核心运行库、iOS 和 Desktop 的 GitHub prerelease，以及组织公开 CocoaPods Specs 源。**全部 SDK 发布尚未完成**；Contract npm 正等待新的 publish 两步验证，Android Central、React Native 和 Flutter 仍有具体阻塞。

## 已公开入口

| 发行物 | 公开入口 | 验证 |
|---|---|---|
| 核心运行库 | [runtime-v0.1.0-preview.7.0](https://github.com/weapp-container/weapp-container/releases/tag/runtime-v0.1.0-preview.7.0) | 14 个归档匿名下载及 SHA-256 全通过；全新离线安装、缓存复验、错误哈希拒绝全通过 |
| iOS | [v0.1.0-preview.7.0](https://github.com/weapp-container/sdk-ios/releases/tag/v0.1.0-preview.7.0) | 双 ZIP 匿名下载；公开 SwiftPM 模拟器/真机目标构建；最终字节 arm64 模拟器交互 XCTest 通过 |
| Desktop | [v0.1.0-preview.7.0](https://github.com/weapp-container/sdk-desktop/releases/tag/v0.1.0-preview.7.0) | 三端归档匿名下载；公开 macOS/Linux/Windows CI 消费全部通过；本机 ARM/Rosetta 消费通过 |
| CocoaPods | [weapp-container/Specs](https://github.com/weapp-container/Specs) | 两个 Pod 远端 lint、全新公开 Specs 解析、iOS 模拟器/macOS 编译链接及 macOS C API 执行通过；Trunk 未投稿 |

```swift
.package(url: "https://github.com/weapp-container/sdk-ios.git", exact: "0.1.0-preview.7.0")
```

```ruby
source 'https://github.com/weapp-container/Specs.git'
source 'https://cdn.cocoapods.org/'
pod 'WeappContainer', '0.1.0-preview.7.0' # iOS
# macOS target: pod 'WeappContainerDesktop', '0.1.0-preview.7.0'
```

iOS 编译要求 Xcode 27.2+，部署最低版本 iOS 16；真机目标编译通过不代表真机运行验收。

## 实现与验证

核心生产提交 `51aadc009e0c2540bebca497779bada600cb9d9e`；C ABI 1。Android 两 ABI、iOS 真机和两种模拟器、macOS 双架构、Linux/Windows x86_64 已从同一干净提交生产，来源、工具链、许可、大小和哈希均记录在公开 provenance 中。历史版本、标签、锁文件和资产保持原样。

五个 SDK 的新默认锁及回归测试已通过 PR 合并；Contract 的公开锁已提前合并。发布工具已改用创建时返回的 Release ID 校验草稿，避免未公开 tag 查询返回 404；保留已有版本/草稿拒绝与完整哈希检查。

Android 正式 AAR/POM/sources/javadoc、R8、双 ABI、16KB 对齐和 API 36 arm64 模拟器交互验收通过。iOS 最终归档通过 arm64 真机及 x86_64 模拟器编译、arm64 模拟器完整交互验收。真机运行均未完成。Desktop 三 OS 公开归档消费者通过（[CI 43305230931](https://github.com/weapp-container/sdk-desktop/actions/runs/43305230931)），覆盖下载、哈希、解压、迁移目录、编译、链接和交互执行；Rosetta 不计作 Intel 真机验收。

六个 SDK 的源码/工具测试共 258 项通过（Contract 36、Android 50、iOS 48、Desktop 45、Flutter 33、RN 46）；完整 submodule 指针校验和公开锁闭合检查通过。

Contract 最终 npm 候选通过全新目录安装、类型检查、工具导出、14 项公开锁与 authored fixture 校验。Flutter 七包已按公开 Desktop URL/SHA-256 打包，platform interface publish dry-run 为 0 警告。

## 暂缓与阻塞

- 按用户要求暂缓 CocoaPods Trunk 注册与 PGP 签名配置，未进行 Trunk 投稿。
- Maven Central 命名空间已验证，但 Portal token、签名和真实上传未完成。因此 React Native 和 Flutter Android 的公开 Maven 依赖尚未满足。
- npm publish 要求新的两步验证；首次授权会话已过期，未发布任何 Contract 版本。trusted publishing 须在首次发布后配置。
- pub.dev 首次授权未完成：accounts.google.com 的 IPv4/默认连接均超时。七个包名未占用，但版本尚未发布；其余六包的真实 hosted 依赖与发布验证须按顺序进行。
- Flutter 五端、RN 双端的实际公开消费，以及 Android/iOS 真机运行仍未完成。
- Desktop 已发布归档的 C 头文件 `WEAPP_DESKTOP_VERSION` 仍为 `0.1.0-preview.6.0`，包元数据和运行库是 `0.1.0-preview.7.0`。当前源码已修正并新增版本协调测试；已发布字节保留，修正版须使用新版本。
- 主仓库已同步六个 SDK 的当前公开锁和发布配置，完整 submodule 指针校验通过。

只有注册源可查、匿名可下载并通过对应消费验证的项目才记录为发布完成。编译、模拟器和真机结果分别记录。
