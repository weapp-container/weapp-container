# preview.5.4 构建与诊断

本代源码 SDK／运行库版本为 `0.1.0-preview.5.4`，Player 为 `0.1.0-preview.5.4+13`，C ABI 仍为 1。

`scripts/sdk-native-build.mjs --view-diagnostics off|cpu|atrace` 默认 `off`。`cpu` 显式启用 `view-batch-diagnostics`；`atrace` 仅允许 Android，并同时启用 `android-view-atrace`。这些 opt-in feature 经 runtime、SDK、FFI 转发，不改变默认引擎或默认构建。构建收据记录 `viewDiagnostics` 和传给 Cargo 的完整 feature 集合；包装层保留两项身份，消费者拒绝不匹配的收据。

各 SDK 中既有 `runtime-artifacts.lock.json` 保留 preview.5.3 原字节与历史哈希。它们不能满足本代源码的运行库要求。完成真实 preview.5.4 二进制构建、审核并取得新 manifest 后，准备依赖时显式使用 `--manifest <preview.5.4-manifest.json>`；不得仅改版本号或复用旧库假装升级。没有新 manifest 时安装应失败。新产物另存目录，不覆盖 preview.5.3。

例如 Android 诊断构建：

```bash
node scripts/sdk-native-build.mjs --target aarch64-linux-android --out artifacts/sdk/preview54-atrace --view-diagnostics atrace
```

源码与收据测试不代表原生库、安装包、GPU、设备或性能验收。诊断构建与关闭诊断的基线分别记录，不能混用性能结果。

Player 将最近 16 条受控 View 操作诊断提供给已配对的只读 inspector，字段为可选的 `playerViewDiagnostics`。记录包含操作、View lease、操作及记录序号、错误码、封闭原因和控制器角色；不导出任意 UI 日志、原生错误正文或应用数据。序号和丢弃计数以十进制字符串传输。响应仍遵守原有 48 KiB 上限：必要时仅裁掉该响应中的旧记录，标记 `responseTruncated`，不清除内部记录；连最小封装都放不下时省略该字段。没有该字段不能解释为没有故障。诊断只用于归属，不能证明恢复或重新授权输入。

该记录属于 Player 进程历史，跨项目连接、页面实例重启仍保留。`controllerRole` 表示事件发生时的角色，不能依据当前 snapshot 的 accepted pack 将全部历史记录归给它。连续用例应记录 `lastSequence` 前后范围；Player 进程重启后序号重新开始，不能跨进程仅凭序号去重。
