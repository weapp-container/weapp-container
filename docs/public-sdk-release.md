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

## 发布渠道

发布工具按 SDK 语义版本选择渠道。`X.Y.Z` 创建 GitHub 稳定版并设为 latest，带 prerelease 标识的版本创建 GitHub prerelease。npm 包分别使用 `latest` 和 `preview` dist-tag；Maven Central、CocoaPods 与 pub.dev 继续按不可变版本号发布。当前公开版本仍是上表所列的 prerelease，尚未生成稳定版本的安装坐标。

## 维护者凭据

DevTools macOS 签名需要组织加入 [Apple Developer Program](https://developer.apple.com/programs/enroll/)。在 Apple Developer 账号创建 **Developer ID Application** 证书，在 Keychain Access 安装后导出含私钥的密码保护 `.p12`。签名 identity 使用 `security find-identity -v -p codesigning` 显示的完整名称。再到 App Store Connect 的 **Users and Access > Integrations > App Store Connect API** 创建 Team API key，下载 `.p8` 并记录 Key ID、Issuer ID。`.p8` 私钥只提供下载一次。

Windows 稳定安装包需要经过组织身份验证、可导出为 `.pfx` 且包含私钥的公开信任 Authenticode 证书。当前 workflow 直接导入 PFX。硬件令牌专用或云端签名证书需要先为 workflow 接入对应签名工具。

DevTools 更新清单使用项目维护者生成的 Ed25519 密钥，不需要向证书机构申请。在仓库外的受保护目录运行以下 Node.js 24 命令：

```sh
node --input-type=module <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync('weapp-devtools-update-private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync('weapp-devtools-update-public.pem', publicKey.export({ type: 'spki', format: 'pem' }));
NODE
```

加密备份私钥，并在整个稳定更新周期沿用同一密钥对。把私钥内容设为核心仓库 secret `WEAPP_DEVTOOLS_UPDATE_PRIVATE_KEY`，公钥内容设为 variable `WEAPP_DEVTOOLS_UPDATE_PUBLIC_KEY`。新 DevTools 客户端会内置该公钥来验证更新。

在 CocoaPods Trunk 注册发行账号并完成邮件验证：

```sh
pod trunk register maintainer@example.com "Maintainer Name"
pod trunk me
```

验证后，CocoaPods CLI 将认证 token 存在用户目录的 `.netrc` 中。将 `trunk.cocoapods.org` 条目里的 token 设置为 `sdk-ios` 和 `sdk-desktop` 两个仓库各自的 GitHub Actions secret `COCOAPODS_TRUNK_TOKEN`。不要把 `.netrc`、证书密码或密钥提交到仓库。

在相应仓库的 **Settings > Secrets and variables > Actions** 录入签名材料。`.p12`、`.p8`、`.pfx` 以 Base64 内容存入对应 secret；GitHub Actions workflow 会在临时 runner 上还原文件。`WEAPP_DEVTOOLS_MACOS_KEYCHAIN_PASSWORD` 是维护者在密码管理器中生成的强随机值。

核心仓库当前还需要 DevTools secrets `WEAPP_DEVTOOLS_MACOS_CERTIFICATE_BASE64`、`WEAPP_DEVTOOLS_MACOS_CERTIFICATE_PASSWORD`、`WEAPP_DEVTOOLS_MACOS_KEYCHAIN_PASSWORD`、`WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY`、`WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_BASE64`、`WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_ID`、`WEAPP_DEVTOOLS_MACOS_NOTARY_ISSUER`、`WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_BASE64`、`WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_PASSWORD` 和 `WEAPP_DEVTOOLS_UPDATE_PRIVATE_KEY`，以及变量 `WEAPP_DEVTOOLS_UPDATE_PUBLIC_KEY`。Android Maven secrets 已配置；npm 和 pub.dev 发布流程使用 GitHub OIDC，不需要长期保存发布 token。

申请入口：[Apple Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)、[App Store Connect API keys](https://developer.apple.com/help/app-store-connect/manage-keys/create-api-keys-for-app-store-connect-api/)、[CocoaPods Trunk setup](https://guides.cocoapods.org/making/getting-setup-with-trunk.html)、[GitHub Actions secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)。

## 稳定版发行门槛

稳定发行需要独立稳定版本、每个 SDK 的固定安装归档、匿名安装消费验证，以及对应包管理器的目标平台构建记录。当前 `.7.1` 是 prerelease，不能作为稳定版记录。iOS / Desktop 的 GitHub 归档未发布，因此引用这些归档的 SPM、CocoaPods 和 React Native iOS 安装路径也不能报告可用。
