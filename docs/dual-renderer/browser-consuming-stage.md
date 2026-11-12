<a id="managed-portable-to-static-site"></a>
# 受管 portable 到静态站点

**简体中文** · [English](browser-consuming-stage.en.md)


> 本页记录底层阶段合同；这些 API 本身不启用开发 CLI。当前显式 Browser CLI 复用的完整 runner、启动参数及关闭限制见 [Browser 开发循环](browser-dev-loop.md)。


`DevConfig.managed_browser_stages = true` 将真实 `stage-pack` 接到现有
`DevSupervisor`。它要求同时启用 `managed_browser_sources`、BrowserWorker、
QuickJS、固定 vendor compiler 和独立选择的 producer pins。默认 profile 仍只准备
runtime 或 raw/portable；这个选项明确增加站点准入容量。

入口为：

```sh
cargo run -p container-simulator --example prepare_browser_stage -- \
  <project> <completed-producer-directory> <independent-pins.json>
```

该示例通过同一个监督器取得 runtime pins 和实际 portable，再创建 coordinator ticket、
启动有限 stage 作业、借用静态资源并执行可重试清理。不会创建本机 AppService。
现有 `dev --web-runtime browser` 继续明确拒绝，HTTP、Worker 和呈现还需要后续接线。

调用顺序为：

1. 使用 `browser_stage_run_id()`、已验证 runtime pins 和原 startup JSON 的 SHA-256
   创建 `BrowserDevCoordinator`。通过即时 `check_portable_publication` 交付所有 source
   events，再 mint/consume `PublicationApproval` 并创建 `StageTicket`。
2. 调用 `begin_browser_stage(ticket, original_startup_bytes)`。监督器再次即时观察 source；
   `SourcePending` 返回的事件必须先交付，再用新 ticket 重试。只有实际 current portable
   的完整 report 与 ticket 相等，才借用原 source owner；原 runtime receipt 的同一 charge
   同时随 stage 保留。
3. `poll()` 始终推进 stage 的真实进程和 deadline，独立于编译器事件。调用
   `poll_browser_stage` 取得 `CapturedStatic` 或明确错误。`StageArtifact` 只是经过验证的
   静态元数据；完成后的发布仍须重新观察 source，不能复用启动 stage 时的批准。
4. `browser_stage_resource` 借用捕获的原字节。allowlist 排除生成的 executable config MJS，
   不暴露 runtime source、原输入路径或可自行 clone 的裸 Arc。`retire_browser_stage`
   立即撤销新借用，已有资源在完整释放后才允许原输出清理、输入释放和原 reservation 退款。
5. 正常退出重试 `try_shutdown()` 直到 `true`。顺序为 watcher 实际屏障、stage 输出与
   borrower、raw/portable 输入、runtime、tools、parent。失败时保留同一个 owner，不能用
   新建监督器或全局删除代替清理。

stage receipt 将实际 `ArtifactJob::request_binding()`、原 completion/files identity、
ticket、独立 producer pins、manifest/内容寻址 blobs、精确文件集合、site/index/startup
原字节哈希逐一核对。startup intent、生成 JSON 和生成 MJS 是三个独立哈希域。
JSON 语义比较按 Node 有限 IEEE754 数字处理，保留原字节，拒绝重复 key、未知字段和超预算。
更改数字的书写方式不会被错误判成配置变化，也不会通过重新序列化制造原字节证明。

stage profile 共用原账本及唯一有限作业槽，预留 4 GiB memory/disk、114,768 files、
14,386 directories、8 namespaces。配方包括一个 runtime、一个控制根、两个 raw、
两个 portable、两个 stage。每个 stage 预留 512 MiB memory/disk、16,392 files、
2,050 directories、一个 namespace；进程退役仅释放 finite 槽，其余预算直到最终清理。
退休但仍被 HTTP 等未来消费者借用的站点继续占槽。以上是逻辑准入策略，不是 RSS 测量或
文件系统硬 quota，实际峰值与跨平台性能仍须独立验证。

本接口的 `runtime_ready`、`presented_ready` 始终为 false。静态站点成功不能作为 Worker、
浏览器、CanvasKit、GPU、官方 DevTools 或七宿主验收证据。冻结发布清单保持原样。
