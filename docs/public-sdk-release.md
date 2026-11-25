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

### macOS DevTools 签名与公证

由组织负责人加入 [Apple Developer Program](https://developer.apple.com/programs/enroll/)。在 Apple Developer 的 **Certificates, Identifiers & Profiles** 创建 **Developer ID Application** 证书，使用 Keychain Access 生成 CSR，下载证书并安装到签名 Mac。将证书和对应私钥一起导出为带密码的 `.p12`。`WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY` 使用 `security find-identity -v -p codesigning` 显示的完整 identity。

在 App Store Connect 的 **Users and Access > Integrations > App Store Connect API** 创建 **Team API key**，下载 `.p8` 并记录 Key ID、Issuer ID。Apple 只允许下载一次 `.p8`，应在创建时完成加密备份。它用于 Apple 公证服务，不是 Developer ID 证书。

### Windows DevTools 签名

向公开信任的 CA 申请 Authenticode 代码签名证书，并完成 CA 要求的组织身份核验。下单前确认私钥可以导出为包含私钥的 `.pfx`，因为当前 workflow 在临时 Windows runner 上直接导入 PFX。仅能通过硬件令牌或云签名服务调用的证书不兼容当前 workflow，需要先实现对应签名集成。

### SDK 注册源凭据

- **Maven Central（`sdk-android`）**：在 Central Portal 验证命名空间 `io.github.weapp-container`，然后从账户设置生成 **User Token**。将 token 的 username/password 分别作为 `MAVEN_CENTRAL_USERNAME`、`MAVEN_CENTRAL_PASSWORD`。它们是 CI 发布凭据，不是 Central Portal 登录密码。另用 GnuPG 生成可用于分离签名的 OpenPGP 密钥，将公钥发布到公开 keyserver，并把 ASCII-armored 私钥设为 `WEAPP_SIGNING_KEY`；私钥有口令时再设置 `WEAPP_SIGNING_PASSWORD`。Android workflow 在 `sdk-android` 仓库读取这些 Actions secrets。
- **历史运行库私有归档**：只有 manifest 指向冻结历史版本时才需要 `WEAPP_CONTAINER_RUNTIME_TOKEN`。先请仓库维护者授予 `weapp-container/runtime-artifacts-private-archive` 读取权限，再创建仅对该仓库有 **Contents: read** 权限的 fine-grained GitHub token，并通过环境变量注入。当前 preview.7.1 和源码构建不需要它。
- **CocoaPods（`sdk-ios`、`sdk-desktop`）**：安装 CocoaPods 后运行 `pod trunk register maintainer@example.com "Maintainer Name"`，打开验证邮件中的链接。Trunk 账户生成的 token 会保存在用户 `~/.netrc` 的 `trunk.cocoapods.org` 项中。将该项的 token 分别设为两个仓库的 `COCOAPODS_TRUNK_TOKEN` secret。首次发布 Pod 的账号会成为 owner，后续维护者由该 owner 管理。
- **npm（`sdk-contract`、`sdk-react-native`）**：发布账号必须拥有对应 `@weapp-container` 包的发布权限。首次创建新包时由维护者登录 npm 并完成 2FA 发布。包可用后，在 npm 包设置中为准确的 GitHub repository 和 `publish-npm.yml` 配置 trusted publisher。发布 workflow 已使用 OIDC，后续不需要长期 npm token。
- **pub.dev（`sdk-flutter`）**：维护者需要有七个包的发布权限。现有包在各自 pub.dev 管理页配置 GitHub trusted publisher，指向 `weapp-container/sdk-flutter`。发布 workflow 使用 OIDC，不需要把 pub.dev token 存入 GitHub。新增包首次发布仍由包所有者进行人工发布，再配置 trusted publisher。

首次创建 Maven 签名密钥时，在本机生成并导出到仓库外的受保护目录，再把公钥发布到公开 keyserver：

```sh
gpg --full-generate-key
gpg --list-secret-keys --keyid-format LONG
umask 077
gpg --armor --export-secret-keys YOUR_KEY_ID > /secure/path/weapp-signing-private.asc
gpg --armor --export YOUR_KEY_ID > /secure/path/weapp-signing-public.asc
gpg --keyserver hkps://keys.openpgp.org --send-keys YOUR_KEY_ID
```

将 `YOUR_KEY_ID` 替换为刚创建密钥的 ID，并将 `/secure/path` 替换为仅维护者可读的目录。把私钥文件内容作为 `WEAPP_SIGNING_KEY` secret 保存。

### DevTools 更新密钥

更新清单使用项目维护者生成的 Ed25519 密钥，不需要向证书机构申请。在仓库外的受保护目录运行以下 Node.js 24 命令：

```sh
node --input-type=module <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync('weapp-devtools-update-private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync('weapp-devtools-update-public.pem', publicKey.export({ type: 'spki', format: 'pem' }));
NODE
```

加密备份私钥，并在整个稳定更新周期沿用同一密钥对。把私钥内容设为核心仓库 secret `WEAPP_DEVTOOLS_UPDATE_PRIVATE_KEY`，公钥内容设为 variable `WEAPP_DEVTOOLS_UPDATE_PUBLIC_KEY`。新 DevTools 客户端会内置该公钥来验证更新。丢失私钥会导致后续更新无法由已发布客户端信任。

### GitHub 配置位置

在各仓库的 **Settings > Secrets and variables > Actions** 添加 secrets；公钥添加为 repository variable。文件与字段的对应关系如下：`.p12` 的 Base64 内容写入 `WEAPP_DEVTOOLS_MACOS_CERTIFICATE_BASE64`，`.p8` 的 Base64 内容写入 `WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_BASE64`，`.pfx` 的 Base64 内容写入 `WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_BASE64`。三个证书导出密码分别写入对应 `*_PASSWORD` 字段；Mac identity 写入 `WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY`；API Key 的 Key ID 和 Issuer ID 写入同名 secrets。为 `WEAPP_DEVTOOLS_MACOS_KEYCHAIN_PASSWORD` 另生成强随机密码并存入 password manager。文件先编码为单行 Base64，工作流会在临时 runner 还原。不要提交证书、`.netrc`、GPG 私钥或密钥文件。

截至 2026-11-25，核心仓库仍缺 DevTools secrets `WEAPP_DEVTOOLS_MACOS_CERTIFICATE_BASE64`、`WEAPP_DEVTOOLS_MACOS_CERTIFICATE_PASSWORD`、`WEAPP_DEVTOOLS_MACOS_KEYCHAIN_PASSWORD`、`WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY`、`WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_BASE64`、`WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_ID`、`WEAPP_DEVTOOLS_MACOS_NOTARY_ISSUER`、`WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_BASE64` 和 `WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_PASSWORD`。DevTools 更新密钥 `WEAPP_DEVTOOLS_UPDATE_PRIVATE_KEY` 和变量 `WEAPP_DEVTOOLS_UPDATE_PUBLIC_KEY` 已配置。Android Maven secrets 已配置；`sdk-ios` 和 `sdk-desktop` 尚未配置 `COCOAPODS_TRUNK_TOKEN`。npm 和 pub.dev 发布流程使用 GitHub OIDC，不需要长期保存发布 token。

申请入口：[Apple Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)、[App Store Connect API keys](https://developer.apple.com/help/app-store-connect/manage-keys/create-api-keys-for-app-store-connect-api/)、[Sonatype Central user tokens](https://central.sonatype.org/publish/generate-portal-token/)、[GnuPG key management](https://www.gnupg.org/documentation/manuals/gnupg/OpenPGP-Key-Management.html)、[npm trusted publishers](https://docs.npmjs.com/trusted-publishers)、[pub.dev automated publishing](https://dart.dev/tools/pub/automated-publishing)、[CocoaPods Trunk setup](https://guides.cocoapods.org/making/getting-setup-with-trunk.html) 和 [GitHub Actions secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)。

## 稳定版发行门槛

稳定发行需要独立稳定版本、每个 SDK 的固定安装归档、匿名安装消费验证，以及对应包管理器的目标平台构建记录。当前 `.7.1` 是 prerelease，不能作为稳定版记录。iOS / Desktop 的 GitHub 归档未发布，因此引用这些归档的 SPM、CocoaPods 和 React Native iOS 安装路径也不能报告可用。
