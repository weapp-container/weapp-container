# Android SDK 归档的独立消费者

`scripts/sdk-android-consumer.mjs` 从精确 SDK 归档全新安装 Maven，再单独构建
Android release 应用和 instrumentation APK。它不运行 SDK library、JNI、Rust
或 Maven publication 构建，不读取 SDK 工作目录中被忽略的 `build/` 产物。
原有 `sdk:build:android` 仍属于生产 SDK/AAR 的流程，不能替代本入口的归档验收。

```sh
pnpm sdk:consumer:android \
  --manifest /absolute/runtime-artifacts.lock.json \
  --manifest-sha256 INDEPENDENT_LOCK_SHA256 \
  --artifact-dir /absolute/archives \
  --consumer-source /absolute/sdk-android-git-repository \
  --out /absolute/never-existing-consumer-run \
  --offline
```

`--manifest`、`--out` 必须显式提供。`--manifest-sha256` 可固定整个已独立审查
清单，回执始终记录实际清单摘要。`--artifact-dir` 明确选择本地归档；不提供时
遵循公开 contract downloader 的版本与访问凭据规则。`--offline` 传给 Gradle，
与归档来源分开控制。默认 consumer 源码仓库为 `sdk/android`，还可显式指定
`--gradle` 和 `--android-sdk`。Gradle 固定 8.9，Android build-tools 固定 36.0.0。

输出目录必须此前不存在。公开 contract 的 downloader/unpacker 验证
`android-sdk/android/universal`、版本、ABI、长度及摘要，并且必须返回
`installation.reused: false`。安装目录、下载副本、原始 lock、日志及失败回执
保留在该输出下；失败重试使用另一个新目录。

安装包内 `distribution.json` 绑定 SDK 提交及 `sourceInventorySha256`。
工具通过 Git 从该精确提交读取 `SOURCE-INVENTORY.json` 与受审查的 8 个
consumer 文件，逐个核验模式、长度和 SHA-256。实际工作目录中的源码修改、
wrapper、CMake、Cargo、JNI 及历史构建目录不会复制到 consumer 项目。
额外 consumer 源码必须先更新明确的受审查闭包。

独立 Gradle init harness 单独记录源码摘要。它将 SDK 坐标限制到本次新安装的
Maven，记录实际 `releaseRuntimeClasspath` 的每个依赖及摘要，并保留原始
`libweapp_container_android.so` 字节。原 consumer 已保留 runtime 和 libc++，
此补充只控制 consumer 包装；SDK 归档及其精确 consumer 源码保持原样。
Gradle 使用 `--no-daemon --no-build-cache`，R8 release mapping 必须实际生成。

构建后再次检查整个安装目录和 Maven 闭包没有变化，并验证：

- 原始 AAR 与 Gradle 实际选中的 AAR 摘要一致。
- arm64-v8a/x86_64 的 runtime、JNI wrapper、libc++ 六个库在 AAR/APK 中字节一致。
- ELF64 架构、16 KB load alignment、可移植 SONAME 和动态依赖。
- `zipalign -c -P 16 4` 对实际 release APK 通过。
- 原始 AAR 的全部声明资源，以及公共 contract fixture，在 APK 中字节一致。
- release/test APK、R8 mapping、依赖、consumer、构建工具和命令均记录摘要。

`validation.json` 可直接交给现有设备执行入口：

```sh
node scripts/sdk-android-smoke.mjs \
  --serial EXPLICIT_ALREADY_RUNNING_TARGET \
  --artifacts /absolute/consumer-run \
  --out /absolute/new-device-evidence
```

消费者构建器本身不操作设备。`deviceExecution` 保持 `not-run`，设备、宿主能力
及物理硬件状态保持待验收。APK 构建、R8、有限 fixture 测试和完整设备执行分别
记录，不能互相替代。

运行 `pnpm sdk:consumer:android:test` 验证真实 contract 的有限归档安装、已有
目录拒绝、Maven 篡改、精确 committed consumer 闭包、native/notice 字节篡改、
ELF/16 KB 约束、依赖替换及失败回执。这些测试不执行 Gradle、Rust 或设备。
