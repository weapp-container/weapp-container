# SDK 仓库和源码构建

核心运行时和 SDK 自有源码采用 Apache-2.0，单独标识的双许可证 crate 和第三方组件保留原许可。SDK 继续独立维护，主仓库通过固定提交的 HTTPS submodule 组合它们。

| 仓库 | 路径 | 内容 |
| --- | --- | --- |
| [sdk-contract](https://github.com/weapp-container/sdk-contract) | `sdk/contract` | C ABI、TypeScript 类型和协议 |
| [sdk-android](https://github.com/weapp-container/sdk-android) | `sdk/android` | Kotlin / JNI / Gradle |
| [sdk-ios](https://github.com/weapp-container/sdk-ios) | `sdk/ios` | Swift / UIKit / SwiftPM / CocoaPods |
| [sdk-desktop](https://github.com/weapp-container/sdk-desktop) | `sdk/desktop` | C / C++ / CMake |
| [sdk-flutter](https://github.com/weapp-container/sdk-flutter) | `sdk/flutter` | Flutter 平台插件 |
| [sdk-react-native](https://github.com/weapp-container/sdk-react-native) | `sdk/react-native` | Fabric / TurboModule |

`website` 对应文档与展示仓库，运行库发行工具位于主仓库的 [tools/runtime-artifacts](../tools/runtime-artifacts/README.md)。旧 `runtime-artifacts` 仓库仅保留只读历史归档，不再作为 submodule 或新发行入口。`vendor/weapp-vite` 固定到审核过的上游提交。

## 当前源码构建

先完成根目录 README 的依赖安装。从当前主仓库构建运行库，不需要历史下载凭据。Apple Silicon macOS 的原生 SDK 示例：

```sh
pnpm sdk:build:native -- --target aarch64-apple-darwin --profile release
pnpm sdk:licenses -- --target aarch64-apple-darwin
```

Ubuntu 的 Skia 预编译缓存可能不覆盖当前 feature 组合；从源码编译前安装系统依赖：

```sh
sudo apt-get update
sudo apt-get install -y clang libclang-dev ninja-build pkg-config python3 libfontconfig1-dev libfreetype6-dev libgl1-mesa-dev libegl1-mesa-dev fonts-dejavu-core
```

CI 通过共享的 Linux 原生依赖 action 执行同样的准备，不依赖 runner 镜像碰巧携带开发头文件。

发布级原生构建要求干净、已提交的源码，并记录提交、feature、平台和产物哈希。其他目标见 `scripts/lib/sdk-native-features.mjs` 及[平台归档说明](platform-runtime-artifacts.md)。

各平台入口为 `pnpm sdk:build:android`、`pnpm sdk:build:ios`、`pnpm sdk:build:desktop`、`pnpm sdk:build:flutter` 和 `pnpm sdk:build:react-native`。按对应 SDK README 选择参数，并显式传入匹配的新构建运行库或安装目录。独立 SDK 不隐式寻找父仓库，也不静默退回旧归档。

## 预编译包和兼容性

现有锁文件记录历史归档的版本、ABI、平台、大小与 SHA-256。保留这些值及严格校验，历史下载的访问要求和随附许可保持原样。下载器仅兼容旧仓库已有的九个历史版本，不允许后续版本再使用旧仓库。

更新后的下载器将旧锁中的 `weapp-container/runtime-artifacts` 精确映射到
`weapp-container/runtime-artifacts-private-archive`，回执同时记录原标识和实际存储库。
没有跨仓库回退。旧版下载器和硬编码 URL 需要升级；同名新仓库不承载历史二进制。

新清单由主仓库生成，指向 `weapp-container/weapp-container` 的精确 `runtime-v<版本>`。使用 `pnpm runtime:package` 打包、`pnpm runtime:verify` 离线验证，再按[发行工具说明](../tools/runtime-artifacts/README.md)执行 `pnpm runtime:publish`。发布器拒绝覆盖已有 tag 或资产。独立 SDK 使用 `--manifest` 显式选取审核过的新清单，下载回执记录实际仓库，无跨仓库回退。

源码和发行流程迁移没有重新发布原生二进制；不能把旧锁的 repository 改成核心仓库并复用哈希。核心源码仓库现已公开，私有历史二进制仍需档案读取权限；Apache-2.0 源码许可不重新授权旧归档。

归档前发现部分旧默认 pin 已与同名远端资产不符，详见[历史 pin 审计](runtime-artifacts-migration.md)。这些下载继续失败并保留校验；接入时应构建匹配源码，或显式选择经过核验的配套清单。

保持 C ABI `1`、既有包名和公开类型。可选协议扩展继续查询能力版本。`ORIGIN.json` 保留历史来源，后续修改使用各 SDK 的 `SOURCE-INVENTORY.json` 刷新工具记录当前源码。

先在对应 SDK 验证并提交，再更新主仓库指针。公开 SDK 的 Git 历史保持连续，旧私有提取历史保存在私有档案。
