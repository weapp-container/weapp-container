# Web 与 Harmony 独立产物

`scripts/platform-runtime-archives.mjs` 生成与原生 SDK 归档分开的 Web/Harmony
清单和安装包，版本为未发布的 `0.1.0-preview.6.0`。它只验证、复制、归档既有
release 构建，不签名、安装到设备或发布 release。历史清单和产物不覆盖。

| 家族 | 清单 | 坐标 | 入口 |
| --- | --- | --- | --- |
| Web Worker | `web-runtime-artifacts.lock.json` | `web/worker/canvaskit` 或 `web/worker/software` | `index.html` |
| Web direct | `web-runtime-artifacts.lock.json` | `web/direct/canvaskit` 或 `web/direct/software` | `legacy.html` |
| Harmony | `harmony-runtime-artifacts.lock.json` | `harmony/arm64/unsigned` | `application-unsigned.hap` |

每次输出一个精确坐标。Web direct 对应旧生产器的 `execution: "legacy"`，新回执
同时保存 `execution: "direct"` 和 `producerExecution: "legacy"`，不能把 Worker
构建重新命名为 direct。清单格式是 `weapp-container-platform-artifacts/1`。

## 构建输入

Web 必须是干净、稳定源码产生的成功 release 构建，启用
`wasm,quickjs-native`。归档器重新核验冻结源码、固定 Acorn parser、生成 JS
依赖闭包、真实 WASM 导出、渲染器依赖、portable pack、文件摘要和长度。只交付
浏览器公开资源、必要的 pack/config、依赖声明和新分发回执；`source/`、
`commands/`、原始编译输出、验证工具和私有构建报告不进入安装包。

先按相同源码提交、target 和 features 收集完整 Cargo 依赖声明：

```sh
node scripts/sdk-licenses.mjs \
  --source-root /absolute/clean-source \
  --package container-host-web \
  --target wasm32-unknown-unknown \
  --features wasm,quickjs-native \
  --out /absolute/new-web-notices
```

`--pins` 是调用者独立审查并保存的 JSON，不能仅信任安装包中的回执。Web
需要 `reportSha256`、`sourceCommit`、`sourceSha256`、`renderer`、`execution`
和 `runtimeLicenseSha256`；后两项分别是 `worker|legacy` 和实际运行时许可证的
SHA-256。历史 Web 生产器未记录 SDK preview 版本时，分发回执明确记录该限制，
不反写原始生产报告。

```sh
node scripts/platform-runtime-archives.mjs \
  --family web \
  --producer /absolute/web-release-run \
  --pins /absolute/independently-reviewed-pins.json \
  --licenses /absolute/new-web-notices \
  --runtime-license /absolute/clean-source/LICENSE \
  --out /absolute/new-web-distribution
```

`restricted-showcase` 的 Apple 原生静态库在生产器计算产物哈希前，使用 LLVM
`llvm-strip --strip-debug` 裁剪每个 archive 成员。通过 `--llvm-strip /absolute/llvm-strip`
选择工具，省略时从 PATH 查找 `llvm-strip`。生产器逐成员确认 DWARF/STABS 已移除，
非调试 sections、symbols、relocations 和 linker metadata 保持一致，并将裁剪前后
哈希、工具版本及验证结果写入 `artifactHardening`。Cargo 的 release strip 设置
本身不覆盖所有预编译依赖，不能替代这个步骤。裁剪或验证失败时不发布该产物；
full 配置保留独立的调试与符号策略。

Harmony 的 Rust 与 HAP 必须来自同一干净提交，并分别记录 release profile。
旧 debug 产物、缺少源码状态或摘要的旧 receipt 不能升级为 release 证据：

```sh
node scripts/build-native-hosts.mjs \
  --source-root /absolute/clean-source \
  --build --platform harmony --profile release \
  --out /absolute/new-native-release-report.json

node scripts/build-harmony-hap.mjs \
  --source-root /absolute/clean-source \
  --profile release \
  --native-receipt /absolute/new-native-release-report.json \
  --rust-lib /absolute/clean-source/target/aarch64-unknown-linux-ohos/release/libcontainer_host_harmony.so \
  --out /absolute/new-harmony-hap
```

当前工具与源码可以来自不同工作目录，两个身份及工具源码摘要分别记录。输出
应放在源码目录外；编译缓存可用 `--target-dir` 或 `CARGO_TARGET_DIR` 指定，默认使用
源码根目录的 `target/`。使用外置缓存时，按 native receipt 中的实际 artifact 路径传入
HAP 的 `--rust-lib`，不要沿用上例的默认路径。缓存生命周期见 [Rust 构建与磁盘空间](rust-build-cache.md)。
HAP 重新检查成员清单、
AArch64 ELF 架构及内含 Rust 库的精确字节，不接收源码、链接或未审查成员。
复制出的 Hvigor 配置禁用 native strip，保留 Rust 生产器原字节；优化仍由
Cargo/CMake 的 release 模式决定。官方生成的 `rpcid.sc` 和 `pkgContextInfo.json`
分别验证能力二进制格式及精确字段，编译输入重复字段在规范化之前拒绝。
Harmony notices 使用 `--package container-host-harmony`、
`--target aarch64-unknown-linux-ohos`、
`--features harmony,arkui,skia-gpu-gles,quickjs-native-harmony`。

HAP 随包携带的 `libc++_shared.so` 还需要对应官方 SDK 的完整 NOTICE。
Cargo 收集清单保持原样，单独从实际 HAP 生产器使用的 SDK 收集：

```sh
node scripts/harmony-platform-notices.mjs \
  --producer /absolute/new-harmony-hap \
  --sdk /absolute/official-sdk/openharmony \
  --out /absolute/new-harmony-platform-notices
```

收集器重新检查 HAP，要求 SDK C++ 库与包内库逐字节一致，并绑定 SDK 元数据、
完整 `native/NOTICE.txt`、源码提交和 HAP 生产报告摘要。归档中只增加固定的
`platform-notices/` 下的 `identity.json`、`OHOS-NATIVE-NOTICE.txt` 和
`OHOS-NATIVE-SDK.json`；未知文件、错误 SDK、修改的 NOTICE 或库摘要均拒绝。

随后运行相同归档命令，改为 `--family harmony`，追加
`--platform-notices /absolute/new-harmony-platform-notices`。实际 HAP 含 C++ 运行库
时该参数必填；不能用 Cargo notices 代替。Harmony pins 包含
`reportSha256`、`sourceCommit`、`runtimeLicenseSha256`，随包含 C++ 运行库时还需
独立审查固定 `identity.json` 的 `platformNoticesSha256`。重写 NOTICE 和本地
identity 中的摘要也不能绕过该 pin。

## 从归档全新安装

输出包含 `.tar.gz`、`SHA256SUMS` 和平台 lock。先在可信渠道独立固定整个 lock
的 SHA-256，再向一个新目录安装：

```sh
node scripts/platform-runtime-archives.mjs \
  --manifest /absolute/distribution/web-runtime-artifacts.lock.json \
  --manifest-sha256 INDEPENDENT_LOCK_SHA256 \
  --artifact-dir /absolute/distribution \
  --coordinate web/worker/canvaskit \
  --install /absolute/new-installed-runtime
```

安装器验证清单 pin、坐标、归档摘要与长度、有限展开、完整文件清单及源码/生产
回执绑定。已有目录不复用、不覆盖。归档生产先在私有暂存区写入并独立解包校验，
最后以独占方式发布文件；失败不覆盖已有分发目录。

`release-receipt.json` 的 compile、archive、runtime、hardware 分开记录。公开
协议字段表示构建声明和导出边界；真实握手、公开 SDK → transport → JS、账号
切换、设备与商户交易必须另附对应环境和命令的证据。静态归档安装、有限 fixture
测试及 Hvigor 编译均不能把 runtime/hardware 状态变为通过。

运行 `pnpm platform:artifacts:test` 可验证格式、字节闭包、独立 pins、direct/Worker
模式、dirty/dev 拒绝、源码变化以及 Harmony 架构、native 摘要和 SDK 运行库 NOTICE
约束。该测试入口
使用有限 fixture，不启动浏览器、设备或商户交易。
