# 浏览器开发态构建资源

这层实现将构建、可发布性与运行时准备分开。静态 Worker 产品已有真实执行证据；普通开发 CLI 的显式 `webview + browser + web + quickjs` 已复用同一个受管 runner，其他 Browser 组合仍明确拒绝。受管 stage、原 owner 的资源租约、认证控制和实验开发 UI 已通过独立 `serve_browser_dev` example 接线；最终 r5 已执行真实浏览器 bootstrap、watch、失败保留和精确关闭，证据与静态产品结果分别记录。实验入口及限制见 [Browser 开发循环](browser-dev-loop.md)。

## Pack 消费者

`DevConfig.pack_consumer` 默认为 `LocalRuntime`，保留 remote 模拟器行为。`BrowserWorker` 仅生成不可变 portable pack，复用本机模式的 manifest integrity root 与 blob 校验，发出 `DevEvent::PortableReady`。它不创建 native JS 引擎、会话或画面，`pump_runtime` 不执行工作。V8 在 watcher 启动前返回 `ERR_ENGINE`。

`PortablePackReport` 包含 pack 路径、manifest/root/compiler、路由和独立的 publication token。编译失败或新输入不会删除最后有效 pack。相同字节恢复可复用 generation，但必须获得新 token，旧完成结果仍失效。

## 监督器的静态 runtime 准备

嵌入方可为 `BrowserWorker` 设置 `DevConfig.browser_runtime = Some(BrowserRuntimePreparation { producer_directory, expected })`。`expected` 必须在启动消费者前从已完成的 Worker producer 记录独立选定，包含原报告 SHA-256、source commit、source inventory SHA-256 和 renderer。原 producer 须为 canonical 目录，并与项目、输出及临时准备根分离；错误配置在启动 watcher 前拒绝。默认 `None` 不创建这一资源链，也不改变原 pack-only 或 remote 路径。

`spawn` 只建立静态准备的元数据 owner；第一次 `poll` 才取得独占目录，冻结有界 producer 副本、创建嵌入工具快照，并在容量准入后启动真实 retain 作业。副本最多 256 MiB、16,384 个文件、2,048 个目录、64 层，单文件最多 64 MiB；拒绝 symlink、特殊文件和超长路径。固定输入／工具槽独立保留 512 MiB 内存及 512 MiB 磁盘的逻辑策略费用；runtime store 另有两个 namespace、一个有限作业槽和每 namespace 64 个资源借用，分别保留每槽 1 GiB 内存及 512 MiB 磁盘策略费用。这些费用不主动分配对应内存，也不是 allocator、Node RSS、文件系统 quota 或整个模拟器服务器的硬上限。

监督器在源事件早退前推进有限作业，消费真实 completion 并验证原始回执。成功发出 `DevEvent::BrowserRuntimePrepared`；其中 `runtimeReady`、`presentedReady` 均为 `false`。`browser_runtime()` 查询静态报告，`browser_runtime_resource(&mut self, path)` 只借出固定 allowlist 内的原始共享字节，不重新读取或复制整份 payload。source、report、parser 和旧 bootstrap 不通过此接口公开。此准备与应用源的新鲜度独立，不取代 `check_portable_publication` 或应用站点的 stage／activation。

失败诊断只报告一次，后续轮询继续推进原有限作业的 shutdown／cleanup；不因已报告错误就停止 deadline 和进程回收。producer／tools 根仍由原 owner 保留至显式关闭。正常退出调用 `try_shutdown()`：活跃资源借用使它返回 `Ok(false)`，清理错误返回 `Err`，两者都保留同一 owner。释放借用后可在已停止的监督器上重试，只有实际 store drain、tools 清理和独占根删除完成才返回 `Ok(true)`。原 `shutdown()` 保持可调用，未完成时输出需要重试的诊断；Drop 不是成功清理证明。

可运行的 embedding 示例：

```bash
cargo run -p container-simulator --example prepare_browser_runtime -- \
  examples/apps/reference-app /absolute/completed-worker-site /absolute/independent-pins.json
```

pin 文件采用 `{ "expected": { "reportSha256": "…", "sourceCommit": "…", "sourceSha256": "…", "renderer": "software|canvaskit" } }`。示例通过真实 `DevSupervisor` 准备并读取 runtime 配置，然后显式关闭；它不启动 HTTP、Worker、浏览器或 GPU。producer 副本、tools 和原始 job 始终由私有 owner 整体持有。后续受管 stage 已使用同一 aggregate ledger 的实际 portable/runtime input lease 和有限作业调度，不能把路径或 report 当作 lease；HTTP 和开发 UI 则由独立 opt-in 的原 `WebSurface` 接入。

调用 `check_portable_publication(&mut self, &report)` 后才可提供或激活新站点。它不受日常 watch 防抖限制，立即观测 receipt、源配置和现代 View 依赖；无待处理构建时也比对 raw 输入，合法 raw 修改必须等待新编译 receipt。返回的诊断事件须送入现有 overlay／历史流。它只证明检查时刻的新鲜度，不锁定文件系统、不暂停现有 Worker、不授予运行或输入权限。待处理 modern 构建自行验证完整依赖闭包，避免把新纯计算依赖误认为必须重建上游产物。

## 可复用 runtime

`scripts/browser-dev-artifacts.mjs` 提供三个内部构建 API：

- `retainBrowserRuntimeBundle` 从一个独立 pin 的 clean Worker build 保留 runtime 子集。
- `openBrowserRuntimeBundle` 重新验证已保留的描述符与完整文件清单，返回进程内 handle。
- `stageBrowserPackGeneration` 将新 pack 与已验证 runtime 配对，生成 pack-index、product config 和 `site.json`；不调用 Cargo/bindgen。

调用者提供原 build-report 精确 SHA-256、source commit/source hash 和 renderer。应从真实 producer 执行记录取得这些 pin；对任意目录自算哈希不构成 producer 真实性证明。helper 重新检查源码、生成 pkg/snippets、固定 Acorn、静态模块闭包、WASM exports、glue interface 原始回执、CanvasKit／字体 pin。它 compile WASM 检查 exports，不实例化应用 WASM，不重跑 glue interface，不运行 AppService。静态闭包检查不构成任意 JS 的安全沙箱。

协调器只保留实际存在的四项 runtime 身份：`bundleSha256` 是原始 `runtime-bundle.json` 字节哈希（不是逻辑 bundleId），`producerReportSha256` 是未修改的原始 `build-report.json` 字节哈希，`sourceCommit` 来自独立 producer pin，`sourceInventorySha256` 对应现有 producer 的 `sourceSha256`。后者采用 UTF-8 `JSON.stringify(report.source.sourceFiles)`，由固定 Node helper 校验；它不是 `source-snapshot.json` 原始文件哈希，也不能由 Rust 重新序列化替代。当前没有单独的 runtime sourcemap、toolchain 或 renderer aggregate 回执，接口不要求填造这类哈希。来源 pin 和 bundle 闭包校验仍须真实执行，字段 shape 校验不能代替它们。

原 build-report 原样保留，原报告内绝对路径仅作历史上下文。bundle 不是完整构建取证目录：命令日志、raw linker WASM、旧 pack-index 等继续由原 producer 归档保存。源文件、报告、parser 与旧 bootstrap 不进入 runtime 的 serve allowlist；资源读取返回副本。

输出必须是独占新目录，创建前检查现存祖先为 canonical、无符号链接，禁止与输入树重叠。读取本身有单文件／总字节／文件数限制，不依靠一次 stat 约束后续无界 readFile；portable 输入捕获到本次任务私有 snapshot，再交给已有 validator。调用期间输出目录及 runtime 源快照由本次操作独占，不得由其他写者替换。失败只清理本次新建目录，已有目标保持原样。

单文件 64 MiB、manifest 2 MiB、report 16 MiB、单次 retained inventory 256 MiB；这不是 RSS 上限或服务器全局缓存预算。受管 runtime、portable 输入、stage 作业和原 body lease 现由同一 aggregate ledger 保留费用及回收身份；HTTP 请求、控制和共享响应另受原 `WebSurface` 的有界预算、连接上限与 deadline 约束。两层合同不能混称为整个进程或文件系统的硬内存上限。

pack generation 的计数与 token 使用精确十进制 u64 字符串，避免浏览器 Number 精度损失。生成结果固定为 `publication: not-authorized`、`runtime: not-run`、`presentation: not-run`；Rust source barrier、预览租约、实际 Worker ready 和最终呈现 ACK 各自验收。构建失败保留旧 pack 与运行实例；旧 Worker 关闭后的新启动失败不能声称保留旧 JS heap。

## 发布与控制回执

`browser_dev_coordinator` 只维护一个 stage、offer、activation、可能执行中的 owner 及 close。它不读文件、不启动 Worker，也不释放资源。`accept_portable` 与 `finish_stage` 要求来自立即执行的 supervisor check 的 approval；接入 owner loop 时，`issueActivation`、`beginActivation` 和 `startOwner` 前同样必须立即检查源输入，不能仅依靠 watch 防抖或之前的许可。

启动意图的原始 UTF-8 JSON 哈希与实际生成的 `worker-product-config.json` 哈希不同：实际配置还绑定 pack-index 和监督器选定的有效路由。配置模块和 JSON 均进入生成文件清单，独立产品检查器要求二者内容一致。pack URL 使用 run/site 双重不可变命名空间；同一 pack 不能借用上次配置的 URL。

`browser_dev_control` 对同一注册 client 的有界请求作严格解码，保留精确 final 字节。HTTP 入队收据不是执行结果；重试必须查询原 requestId 的 final，不能重复执行原操作。正常命令使用 `<client>:control-N`，清理命令使用 `<client>:cleanup-N`，各自保留序号高水位、索引和容量预算；普通序号耗尽不能挡住清理，任何空间均不得回绕或重置。执行前预留最大 final 容量；请求号高水位防止被移除的旧命令再次变成新操作。已准备的 final 可以凭原执行 ticket 提交保留字节，不能重新执行原操作。认证 HTTP adapter 现提供 invoke、精确 replay 与原字节哈希 ACK，并在同一 `BrowserDevOwner` 上操作原 ledger。manager 完整采纳后才发 ACK，不得从发送成功自动压缩 final。独立 `observe` 只读原 typed snapshot，不占用命令 serial、final 或 ACK 容量。状态、重试和清理边界见 [HTTP 控制接入](browser-control-http.md)及 [final ACK](browser-control-ack.md)。

停止后仍允许精确 owner 清理。正常控制序号耗尽时使用独立 `terminalCleanupRevision` 排序清理状态，不能重新授予启动权限。浏览器的 ready、呈现与清理记录均标记为 `browser-reported`；控制 final 只确认协调器接受了该报告，不能作为独立设备证据。

## 有限工具作业

`browser_dev_artifact_job` 使用已编译进模拟器的五成员 Node 工具快照，执行单次 retain 或 stage。脚本、入口与完整静态依赖在私有目录内校验，应用 pack 和 retained runtime 是另外校验的数据输入。作业不执行 Cargo、应用 JS、Worker、浏览器或服务。请求最多 2 MiB、结果最多 16 MiB；输出只能是本作业独占目录内的 `output`，不能由 HTTP 请求指定清理路径。

作业有绝对 deadline、取消和 supersede 状态。退出码为零和迟到的完整结果不能撤销停止状态。Unix 在回收组长 PID 前请求终止所拥有的进程组，Windows 使用 Job Object；仅在实际组／Job 清理确认后才读取结果、转移文件 lease。Unix 合同要求可信工具不脱离进程组，并非任意程序的后代进程沙箱。

构造失败也必须保留清理 owner：私有目录填充失败返回该目录的 lease，启动子进程后的 owner marker 写入失败返回实际 job。Windows 在分配 Job 或恢复挂起线程之前先建立完整 owner；这些步骤失败时仍返回实际 Child／Job，清理同时尝试两个稳定句柄，并确认子进程退出及 Job 清空。调用方保留错误及其容量预留，重复调用 fallible cleanup，只有确认完成才释放本次作业预留。共享工具只释放本次借用；其他 owner 使用中的快照继续由其 lease 持有。Drop 日志或恢复路径不算清理完成。

作业 `poll` 的进程退出检查不阻塞；完成后的有界文件读取仍是同步 I/O，不能宣称整个作业轮询完全非阻塞。现有受管作业、generation、共享工具和断连后仍被 HTTP body 持有的 artifact lease 继续保留原 aggregate 费用；HTTP wire 与回复由 surface 单独记账。单作业上限、aggregate 逻辑预留和 HTTP 预算各有边界，不能互相替代或视作 RSS 证明。

## Rust 静态 runtime 回执

`browser_dev_runtime_receipt` 在轮询作业前，将 `PendingRuntimeReceipt` 绑定到实际作业的文件 owner、原始请求字节哈希和独立 producer pin。它消费该作业的真实 completion，核对退出／停止状态、原始 result、bundle 和 report 字节，以及固定消费者闭包的完整资源清单。result 中的目录只用于比较，不能授权读取其他目录；来源 inventory 仍由固定 Node helper 按原 recipe 验证，Rust 不重新序列化它来生成 pin。

成功回执保留原始 result、bundle、report 和已验证的不可变资源字节。资源借用持有实际文件 lease，因此回执退役后仍在发送的 body 会阻止独占清理；失败则返回原 completion，供 owner 显式重试清理。源文件、报告、parser 和旧 bootstrap 不进入资源 serve 清单。单次 capture 包含 descriptor，最多 256 MiB；单文件和清单另有限制。原资源现通过 `WebSurface` 的严格 immutable GET 排入原 owner lane，响应持有同一 store borrower 至实际写出、失败或超时，不复制为新的 artifact owner。这些已接入的费用与租约仍不是进程总内存上限。

作业和回执读取都先检查文件长度，再通过同一个 exact-size helper 分配并读取；额外字节只用栈上探针检测，文件增长不会触发 `Vec` 扩容。读取后继续验证元数据和文件身份。该路径仍是静态校验，不授予 publication、Worker ready、呈现或 GPU 权限；合成回执单测也不能代替独立 pin 的真实 producer 验证。

真实 producer 的独立集成入口为 `crates/container-simulator/tests/retained_runtime.rs`。默认测试将其标为 ignored；必须显式运行 `--ignored --exact independently_pinned_worker_runtime_is_retained_and_cleaned --test-threads=1`。入口要求 `WEAPP_CONTAINER_RETAINED_RUNTIME_` 前缀的 `BUILD_SITE`、`REPORT_SHA256`、`SOURCE_COMMIT`、`SOURCE_SHA256`、`RENDERER`、`NODE_BIN`、`EVIDENCE_PARENT` 和 `PIN_AUTHORITY`，显式运行缺失参数时失败。预期 pin 应在启动消费者之前从独立 producer 执行记录选定，不能从待验证目录或当前子进程回填。入口保留原字节证据，验证真实 Node 作业和 body 借用的清理屏障；只有实际执行结果才能标记该项通过。

## 浏览器 owner 与绘制资源

`browser-dev-owner-manager.mjs` 在 metadata admission 后、关闭旧 owner 前准备实际绘制资源。DOM 页面跳过 CanvasKit；外部帧路径通过同一个 admission loader 校验六份固定资源、初始化 CanvasKit 并验证临时字体的创建和释放。静态 preparation lease 不包含 owner 权限，只有真实 `WorkerWebSession` 的匹配 loadResult 才能借出独立绘制 lease。

loader 对等待者、静态 lease、owner lease、字体复制字节和初始化次数分别设限。取消等待实际初始化与清理结束，后来的 DOM 激活也不能绕过未完成的资源释放。模块保留在 loader cache 中；当前没有完整销毁 CanvasKit 模块的保证。初始化和字体准备不证明 GPU surface、实际呈现、输入或应用启动成功。

manager 保留精确控制请求及原 final，处理取消、迟到结果与不确定关闭。替换只有在旧 owner 的真实关闭 barrier 通过后才能启动新 owner。运行时 ready 与接受当前呈现分别报告；HTTP 成功、已创建 Worker、已产生 frame 或截图都不能替代呈现确认。manager 本身仍不承担页面和 HTTP 服务；新增 `BrowserDevApplication`、认证 HTTP 客户端与 opt-in `WebSurface` UI 将它接入开发循环；普通 CLI 复用该 runner，并未另建 owner 或放宽 artifact 准入。

## 实验开发页面与交付边界

受信任本机启动方可在原 resource-only loopback surface 首次 accept 前启用控制和
`enable_browser_dev_app`。根页面只嵌入原 auth 与原 preview 的 inert JSON；固定开发
资产不走文件系统 fallback，所有 UI／资源 GET 精确核对原 Host，响应沿用同一
HTTP 预算和 deadline。完整服务、凭据与关闭策略见 [HTTP 控制接入](browser-control-http.md)。

`serve_browser_dev` example 将固定编译器 watch、portable pack、stage 和原 owner
接到此页面；当前实验入口限定 QuickJS Worker + DOM/WebView，不自动打开浏览器。
真实 bootstrap、更新、输入、失败保留和原 manager 关闭已由最终 r5 执行，原始记录见
[开发循环证据](../archived-evidence.md)。这只验证所执行的有限
DOM/QuickJS 开发循环，编译、合同单测和之前的静态产品结果仍分别保留。

这是有限 lifetime 的开发循环。`observe` 不累计命令，但 owner 切换和 ready 报告
仍消耗有限命令及回执预算；不能靠后台逐出、重置 ledger 或重放 mutation 获得无限
watch。页面刷新、崩溃或丢失后，新页面无法恢复原 manager、Worker 和关闭 barrier，
没有 takeover 或断连自动释放。应在原页面停止并完成原 owner、ledger ACK 和 HTTP
drain 后再新开服务。启动步骤、预算及当前验证状态见 [Browser 开发循环](browser-dev-loop.md)。

## 验证

Node 合同包含 bundle pin／闭包重验、两个 pack 复用一个 runtime、错误与旧 generation、输出父 symlink、已有目标保留、超限输入，以及在 validator 开始时修改原输入仍使用捕获字节。Rust 合同验证不编译 native 引擎仍可产出 pack、V8 预拒绝、来源 token、无 receipt 的 modern/raw 修改和清理。真实 producer 复用另记录精确来源，不把 synthetic WASM 合同当作真实构建、浏览器、GPU、watch 或设备证据。
