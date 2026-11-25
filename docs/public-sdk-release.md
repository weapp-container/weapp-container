# SDK 公开发行状态

**简体中文** · [English](public-sdk-release.en.md)

核验日期：2026-11-25。当前可见发行均为预览版，没有正式稳定版本。源代码公开、注册源可下载、构建通过和设备验收是不同状态。

| SDK / 发行物 | `0.1.0-preview.7.1` 状态 | 当前限制 |
| --- | --- | --- |
| 核心运行库 | GitHub `runtime-v0.1.0-preview.7.1` prerelease 可匿名下载 | 不是稳定版 |
| DevTools | GitHub `devtools-v0.1.0-preview.7.2` prerelease 可匿名下载 | macOS 与 Windows 包未签名；不是稳定版 |
| Android | Maven Central 坐标 `io.github.weapp-container:weapp-container-android:0.1.0-preview.7.1` 可解析 | 仅预览版 |
| Contract | npm `@weapp-container/sdk-contract@0.1.0-preview.7.1` 可安装，`preview` dist-tag 已指向该版本 | `latest` 仍是历史 `0.1.0-preview.7.0`，不是稳定版 |
| React Native | npm `@weapp-container/react-native@0.1.0-preview.7.1` 可安装，`preview` dist-tag 指向该版本；Android 依赖可解析 | `latest` 也指向预览版；iOS 原生依赖的固定归档 URL 尚不可用 |
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

```sh
npm install @weapp-container/sdk-contract@0.1.0-preview.7.1
```

```yaml
dependencies:
  weapp_container: 0.1.0-preview.7.1
```

Android、Flutter、Contract 和 React Native 包版本已通过 Maven Central、pub.dev、npm 的匿名元数据请求核对。Contract 的 `preview` dist-tag 指向 `0.1.0-preview.7.1`，`latest` 仍保留历史 `0.1.0-preview.7.0`，因此当前只能使用精确版本或 `preview`。iOS / Desktop 安装状态也检查了对应 GitHub release、CocoaPods Specs 和固定归档 URL。未观测到 CocoaPods Trunk 上的 `WeappContainer` 或 `WeappContainerDesktop` 条目。

## 示例应用

每个 SDK 示例以同版本的 portable fixture 演示宿主集成。先查看平台 README 中的系统要求和发行限制，再按示例目录中的命令生成 fixture、构建应用并启动设备或模拟器。

- [Android reference app](../sdk/android/consumer/README.md)
- [iOS UIKit consumer](../sdk/ios/examples/consumer/README.md)
- [React Native consumer](../sdk/react-native/example/README.md)
- [Flutter consumer](../sdk/flutter/example/README.md)
- [Desktop consumer](../sdk/desktop/consumer/README.md)
- [Contract C ABI host consumer](../sdk/contract/examples/consumer/README.md)

## 发布渠道

发布工具按 SDK 语义版本选择渠道。`X.Y.Z` 创建 GitHub 稳定版并设为 latest，带 prerelease 标识的版本创建 GitHub prerelease。npm 包分别使用 `latest` 和 `preview` dist-tag；Maven Central、CocoaPods 与 pub.dev 继续按不可变版本号发布。当前公开版本仍是上表所列的 prerelease，尚未生成稳定版本的安装坐标。

## 维护者凭据

申请和配置时按下表处理。Apple 与 Windows 证书由外部机构签发；Maven Central、CocoaPods 需要注册账号或生成 token；GPG 和 DevTools 更新密钥由维护者在本地生成；npm 与 pub.dev 使用 GitHub OIDC，不需要长期发布 token。

| 凭据 | 申请或生成方式 | 用途 |
| --- | --- | --- |
| Apple Developer ID `.p12` | 组织负责人先加入 Apple Developer Program，再在 Certificates, Identifiers & Profiles 创建 Developer ID Application 证书，并从 Keychain Access 导出证书与私钥 | macOS DevTools 代码签名 |
| App Store Connect `.p8` | 在 App Store Connect 的 Users and Access > Integrations 创建 Team API key。下载时记录 Key ID 和 Issuer ID | macOS DevTools 公证 |
| Windows Authenticode `.pfx` | 向受信任的代码签名 CA 申请组织证书。下单前确认私钥可导出为 PFX | Windows DevTools 签名 |
| Maven Central User Token | 登录 Central Portal，验证 `io.github.weapp-container` 命名空间，再从账户设置生成 User Token | Android SDK 发布 |
| CocoaPods Trunk token | 运行 `pod trunk register` 并完成邮件验证。CocoaPods 将凭据保存在 `~/.netrc` | iOS 和 Desktop Pod 发布 |
| OpenPGP 签名密钥 | 维护者本机运行 `gpg --full-generate-key`，发布公钥到公开 keyserver | Maven Central 工件签名 |
| GitHub fine-grained token | 仅在使用冻结的历史私有运行库归档时创建，只授予归档仓库 Contents: read | 本地历史归档下载 |
| npm / pub.dev 发布权限 | npm 包和 pub.dev 包分别配置 GitHub trusted publisher | 自动发布，通过 OIDC 短期授权 |
| DevTools 更新签名密钥 | 维护者本机生成 Ed25519 密钥对并加密备份私钥 | 更新清单签名 |

私钥、导出密码和 token 通过密码管理器与 GitHub Secrets 分发，不要贴入 issue、PR、日志或消息。

### macOS DevTools 签名与公证

由组织负责人加入 [Apple Developer Program](https://developer.apple.com/programs/enroll/)。组织注册通常需要法定实体信息、D-U-N-S 编号和有权代表组织签署协议的人员。加入组织后，在 Apple Developer 的 **Certificates, Identifiers & Profiles** 创建 **Developer ID Application** 证书。使用 Keychain Access 创建 CSR，下载证书并安装到签名 Mac，再从 Keychain Access 将证书和对应私钥导出为带密码的 `.p12`。`WEAPP_DEVTOOLS_MACOS_SIGNING_IDENTITY` 使用 `security find-identity -v -p codesigning` 显示的完整 identity。

由有权限的 App Store Connect 管理员打开 **Users and Access > Integrations > App Store Connect API**，创建 **Team API key**，下载 `.p8` 并记录 Key ID、Issuer ID。Apple 只允许下载一次 `.p8`，应在创建时完成加密备份。它用于 Apple 公证服务，不是 Developer ID 证书。

### Windows DevTools 签名

向受 Windows 信任的 CA 申请组织 Authenticode 代码签名证书，并按 CA 要求提交组织登记资料、联系人验证和 CSR。不同证书产品对私钥的存放方式不同，下单前书面确认私钥可以导出为包含私钥的 `.pfx`，因为当前 workflow 在临时 Windows runner 上直接导入 PFX。仅能通过硬件令牌或云签名服务调用的证书不能直接用于当前 workflow。证书签发后导出 PFX，并单独保存导出密码。

### SDK 注册源凭据

按实际发布顺序准备凭据：

1. **先发布 Android**：组织负责人在 Central Portal 验证 `io.github.weapp-container` 命名空间并生成 User Token；维护者在本地生成 GPG 密钥并公开发布公钥。把 User Token 写入 `sdk-android` 的 `MAVEN_CENTRAL_USERNAME` / `MAVEN_CENTRAL_PASSWORD`，把 ASCII-armored 私钥写入 `WEAPP_SIGNING_KEY`，有口令时再写入 `WEAPP_SIGNING_PASSWORD`。
2. **再发布 iOS / Desktop Pod**：账号所有者运行 `pod trunk register`，完成邮件验证后从 `~/.netrc` 读取 `trunk.cocoapods.org` 的 password 字段。将同一个 Trunk token 分别写入 `sdk-ios` 和 `sdk-desktop` 的 `COCOAPODS_TRUNK_TOKEN`。两个仓库的 token secret 相互独立配置。
3. **发布 Contract / React Native npm**：首次创建包时由拥有 npm 发布权限的维护者登录并完成 2FA，使用 `npm publish --access public --tag preview`。包创建后，在 npm 包设置中绑定准确的 GitHub 仓库和 workflow，后续由 OIDC 发布，不再申请长期 npm token。
4. **发布 Flutter pub.dev**：每个包首次发布由包 owner 完成人工登录；包存在后，在 pub.dev 的 Automated publishing 中绑定 `weapp-container/sdk-flutter`、发布 workflow 和包名，后续使用 GitHub OIDC，不保存 pub.dev token。
5. **签名 DevTools**：Apple Developer ID、App Store Connect API key 和 Windows Authenticode 证书只能由对应组织账号或证书机构签发。它们分别用于 macOS 签名、公证和 Windows 签名，不能用 GPG 或 DevTools 更新密钥替代。

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

GitHub CLI 可从受保护的本地文件写入 secret，不会把 secret 值放进命令参数或终端输出。先登录有仓库管理权限的账号，并设置仅维护者可读的 `SECURE_DIR`，再执行对应命令：

```sh
base64 < "$SECURE_DIR/developer-id.p12" | tr -d '\n' | gh secret set WEAPP_DEVTOOLS_MACOS_CERTIFICATE_BASE64 --repo weapp-container/weapp-container
base64 < "$SECURE_DIR/notary-api-key.p8" | tr -d '\n' | gh secret set WEAPP_DEVTOOLS_MACOS_NOTARY_KEY_BASE64 --repo weapp-container/weapp-container
base64 < "$SECURE_DIR/windows-authenticode.pfx" | tr -d '\n' | gh secret set WEAPP_DEVTOOLS_WINDOWS_SIGNING_CERTIFICATE_BASE64 --repo weapp-container/weapp-container
gh secret set WEAPP_SIGNING_KEY --repo weapp-container/sdk-android < "$SECURE_DIR/weapp-signing-private.asc"
```

证书密码、Key ID、Issuer ID、签名 identity、Trunk token 和 GPG 口令可在 GitHub 仓库设置页面中直接粘贴。macOS 与 Windows DevTools 签名字段写入核心仓库；Maven Central 字段写入 `sdk-android`；CocoaPods token 分别写入 `sdk-ios` 和 `sdk-desktop`。每项 secret 都需要在实际运行发布 workflow 的仓库配置。

申请入口：[Apple Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)、[App Store Connect API keys](https://developer.apple.com/help/app-store-connect/manage-keys/create-api-keys-for-app-store-connect-api/)、[Sonatype Central user tokens](https://central.sonatype.org/publish/generate-portal-token/)、[GnuPG key management](https://www.gnupg.org/documentation/manuals/gnupg/OpenPGP-Key-Management.html)、[npm trusted publishers](https://docs.npmjs.com/trusted-publishers)、[pub.dev automated publishing](https://dart.dev/tools/pub/automated-publishing)、[CocoaPods Trunk setup](https://guides.cocoapods.org/making/getting-setup-with-trunk.html) 和 [GitHub Actions secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)。

## 稳定版发行门槛

稳定发行需要独立稳定版本、每个 SDK 的固定安装归档、匿名安装消费验证，以及对应包管理器的目标平台构建记录。当前 `.7.1` 是 prerelease，不能作为稳定版记录。iOS / Desktop 的 GitHub 归档未发布，因此引用这些归档的 SPM、CocoaPods 和 React Native iOS 安装路径也不能报告可用。
