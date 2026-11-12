# 运行库发行工具

核心仓库维护原生运行库与 SDK 的打包、离线验证和 GitHub Release 发布。工具及边界测试从 `runtime-artifacts` 的 `f50e26252b43c13ea68821154d5ebaaa40527b75` 迁入，源码采用 Apache-2.0。Node.js 24、Python 3 和发布时的 GitHub CLI 为必要环境，无额外 npm 依赖。

## 构建与打包

在核心仓库根目录操作。先从干净、已提交的源码构建原生库并收集各目标许可，详见 [SDK 源码构建](../../docs/sdk-repositories.md)。打包器不编译源码，所有切片必须有一致的完整源提交、成功构建收据、固定头文件和完整许可清单。

```sh
pnpm runtime:package -- \
  --source-commit <40位完整源提交> \
  --native-root /absolute/native \
  --licenses-root /absolute/licenses \
  --out-dir /absolute/release \
  --target aarch64-apple-darwin
```

`--target` 可传逗号分隔的明确目标，省略时选择输入目录已有的受支持目标。SDK 包使用 `--component android-sdk|ios-sdk|desktop-sdk --platform <平台> --arch <架构> --install-dir <已验证安装目录>`；通用包还须用 `--architectures` 列出真实切片。完整选项见 `pnpm runtime:package -- --help`。

输出包括 `manifest.json`、`provenance.json`、`SHA256SUMS` 和归档。相同版本可在本地增量添加目标，但同名归档不能改变字节。版本、ABI 和审核过的头文件/许可哈希位于 [policy.json](policy.json)，测试会与核心发行版本及独立 contract 同步校验。接口变更时先审核这些身份，再生成新的发行物。

## 验证与发布

```sh
pnpm runtime:verify -- \
  --contract-dir /absolute/sdk-contract \
  --release-dir /absolute/release \
  --work-dir /absolute/work \
  --report /absolute/offline-installation.json

# 默认只做本地验证和离线安装，不调用 GitHub。
pnpm runtime:publish -- --release-dir /absolute/release --notes-file /absolute/notes.md

# 从与生产收据一致的干净源码 checkout 显式发布。
pnpm runtime:publish -- --release-dir /absolute/release --notes-file /absolute/notes.md --execute
```

发布器只接受此打包器生成的 full 原生/SDK 清单；Web、Harmony 和 restricted-showcase 使用各自的发行与验收流程。它冻结输入字节、重验哈希和离线安装，拒绝已存在的 release/tag，再创建草稿、上传精确资产、核对服务端 SHA-256 后发布 prerelease，不改变 latest。上传失败保留草稿供人工检查；不要覆盖资产或仅改清单重试。未来重发应使用新版本和新构建证据。

新清单写入 `weapp-container/weapp-container` 与精确的 `runtime-v<版本>`。接入者下载该发行的 `manifest.json`，用 SDK 的 `--manifest` 显式选择即可。源码许可不代表仓库公开；私有核心仓库仍需有读取权限的 `WEAPP_CONTAINER_RUNTIME_TOKEN`，发布需具有内容写权限的 GitHub CLI 登录。仓库公开时，SDK 也支持匿名读取核心发行。

## 历史兼容

旧发行完整保存在私有的 `weapp-container/runtime-artifacts-private-archive`，新的同名 `runtime-artifacts` 仅保留停更工具源码。更新后的 SDK 下载器将九个冻结旧版本的原锁标识定向到私有档案，并记录实际仓库；旧版下载器需升级。不允许在旧档案创建新版本，也没有跨库回退。现有锁文件、`ORIGIN.json`、tag、资产、哈希、访问权限与随附许可保持原样。当前迁移没有生成或发布新的原生二进制，也不把历史二进制重新标为 Apache-2.0。

验证命令为根目录的 `pnpm runtime:artifacts:test` 和 `pnpm sdk:contracts:test`。离线字节校验不代表真机、GPU 或各平台能力已经验收。
