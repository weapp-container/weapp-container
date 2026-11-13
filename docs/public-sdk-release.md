# Weapp Container 0.1.0-preview.7.1 发布状态

**简体中文** · [English](public-sdk-release.en.md)

本页记录 `.7.1` 预览版各注册源的实际状态。核心 runtime、iOS、Desktop 和公开 Specs 已完成发布并匿名校验；Contract 接口未变，继续使用已发布的 npm `.7.0`，不重复发布。Android Central、CocoaPods Trunk、React Native npm 和 Flutter pub.dev 仍受账号侧认证或前置依赖阻塞。

## 注册源状态

| 分发项 | 已注册版本 | `.7.1` 状态与验证 |
|---|---|---|
| 核心 runtime | `.7.1` | [GitHub Release](https://github.com/weapp-container/weapp-container/releases/tag/runtime-v0.1.0-preview.7.1) 已公开。17 个资产匿名下载与 SHA-256 核验通过；14 个安装归档通过离线安装、缓存复验和错误哈希拒绝验证。 |
| Contract | npm `.7.0` | [已发布的 Contract 包](https://www.npmjs.com/package/@weapp-container/sdk-contract/v/0.1.0-preview.7.0)保持原版本；C ABI 与接口未变，不发布 `.7.1`。 |
| Android | 无 | Maven Central `.7.1` 坐标匿名查询返回 404。候选 build run [43473194455](https://github.com/weapp-container/sdk-android/actions/runs/43473194455) 通过；Central workflow 尚在发布分支，且仓库缺少 Central/signing secrets。 |
| iOS | GitHub `.7.1` | [iOS GitHub Release](https://github.com/weapp-container/sdk-ios/releases/tag/v0.1.0-preview.7.1) 已公开；build [43473195791](https://github.com/weapp-container/sdk-ios/actions/runs/43473195791)、finalize [43476990650](https://github.com/weapp-container/sdk-ios/actions/runs/43476990650) 和发布 [43477207833](https://github.com/weapp-container/sdk-ios/actions/runs/43477207833) 通过。CocoaPods Trunk `.7.1` 尚未注册，缺少 `COCOAPODS_TRUNK_TOKEN`。 |
| Desktop | GitHub `.7.1` | [Desktop GitHub Release](https://github.com/weapp-container/sdk-desktop/releases/tag/v0.1.0-preview.7.1) 已公开；三平台 build/finalize [43473197471](https://github.com/weapp-container/sdk-desktop/actions/runs/43473197471) 和发布 [43475623344](https://github.com/weapp-container/sdk-desktop/actions/runs/43475623344) 通过。CocoaPods Trunk `.7.1` 尚未注册，缺少 `COCOAPODS_TRUNK_TOKEN`。 |
| CocoaPods Specs | Specs `.7.1` | [公开 Specs 源](https://github.com/weapp-container/Specs/commit/650112e) 已导入 iOS/Desktop `.7.1` Podspec；两个 release archive 均匿名下载并与 manifest SHA-256 一致。Trunk 版本查询返回 404。 |
| React Native | 无 | npm `.7.1` 版本匿名查询返回 404。源码、Android Maven 依赖和默认 runtime lock 已升到 `.7.1`；对应原生发行物完成前不发布桥接包。 |
| Flutter | interface `.7.0` | [已发布的 `.7.0` interface](https://pub.dev/packages/weapp_container_platform_interface/versions/0.1.0-preview.7.0)继续可用。七个 `.7.1` 包尚未注册；Desktop staging [43477208452](https://github.com/weapp-container/sdk-flutter/actions/runs/43477208452) 通过，发布仍等待 pub.dev OIDC 和 Android 前置依赖。 |

现有可安装包仍可使用其原版本：

```sh
npm install @weapp-container/sdk-contract@0.1.0-preview.7.0
```

`.7.1` SDK 安装示例会在各自注册源和匿名消费者验证通过后启用。源码、构建、模拟器、注册源下载和真机验收分别记录；不能用其中一项代替另一项。

## 验证记录

runtime 验证摘要绑定 `runtime-v0.1.0-preview.7.1`，核心来源提交为 `fbd8cfcc44011b1250c4e987b02f9217ce1a64d0`。17 个公开资产的大小与 SHA-256 和发布清单一致，验证记录位于 `artifacts/published-runtime-verification/`。

Android、iOS、Desktop、Flutter 和 React Native 的源码与 runtime lock 已指向 `.7.1`。iOS/Desktop GitHub release 和 Specs 已匿名下载并验证归档哈希；Android Maven、CocoaPods Trunk、React Native npm 和 Flutter `.7.1` 的公开入口仍未注册，因此不报告其消费者发布验证。Contract npm `.7.0` 与 Flutter interface `.7.0` 是此前已发布版本。

仓库所有者可在 GitHub Actions/OIDC 配置就绪后继续执行发布。当前检查到相关仓库 secrets 列表为空，尚不能完成 Central 签名上传或 Trunk 投稿。iOS SwiftPM/Pod lint 与 Desktop 三平台消费者构建通过；Flutter 五平台和 RN 双端的本轮 `.7.1` 公开消费者验收仍待对应注册源发布。真机与硬件 GPU 结果继续单独标记。

<a id="order"></a>
## 发行顺序

1. 从已公开并核验的 runtime lock 构建 Android、iOS 和 Desktop SDK；校验源码提交、归档哈希、许可及消费者结果。
2. Android 发布 Maven Central 并发布绑定相同 producer 的 GitHub release；iOS 与 Desktop 发布 GitHub prerelease。任何版本或归档不可覆盖。
3. 使用精确 release URL 和 SHA-256 更新公开 Specs 源，完成 CocoaPods Trunk 首次注册/认证后逐个投稿并匿名验证。
4. 发布 React Native npm 包，使用精确的 iOS/Android release identity 与 OIDC provenance；要求其 Maven、Pod 依赖已经公开。
5. Flutter 按 platform interface、Android/iOS/macOS/Linux/Windows 插件、主包顺序发布。标签为 `<package>-v0.1.0-preview.7.1`，每次发布验证 staging 归档哈希和已发布依赖。
6. 对每个注册源执行全新匿名安装与消费者检查，再更新本页和 Website 快照。Contract 保持 `.7.0`。

<a id="automated-prerelease"></a>
## 发布自动化

核心 runtime 的 `.7.1` release 已发布。后续候选仍按 `public-native.yml`、生产产物离线验证和人工审核流程推进；不得覆盖已有 tag、草稿、归档或校验和。SDK producer 使用准确的 runtime 版本锁、源码清单和成功的生产 run ID。Central、npm、pub.dev 与 CocoaPods 投稿各自验证注册源的实际响应与归档字节，上传成功本身不代表消费者验证通过。

<a id="authentication"></a>
## 发布认证

Android Central workflow 需要仓库 secrets：`MAVEN_CENTRAL_USERNAME`、`MAVEN_CENTRAL_PASSWORD`、`WEAPP_SIGNING_KEY`，以及可选的 `WEAPP_SIGNING_PASSWORD`。npm 与 pub.dev 使用 GitHub OIDC；首次发布前由包所有者完成可信发布者绑定和必要的一次性账号验证。CocoaPods Trunk 首次投稿前由所有者完成注册与邮箱验证，并配置 `COCOAPODS_TRUNK_TOKEN`。凭据只存入对应仓库/组织 secrets，不写入源码、日志或聊天。

<a id="acceptance"></a>
## 发行验收

每个版本需确认注册源可查、匿名下载字节与已验证归档 SHA-256 一致，并在干净目录完成对应消费者解析、构建和运行检查。Android、iOS、Desktop、Flutter 五平台、React Native 双平台及 SwiftPM/CocoaPods 分别留存结果。模拟器、CI 软件渲染、真机和硬件 GPU 是不同证据等级；没有执行的项目标记为未验证。
