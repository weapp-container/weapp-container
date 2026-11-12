<a id="logmanager-bufferurl-and-file-encoding-implementation-scope"></a>
# LogManager、BufferURL 与文件编码实现范围

**简体中文** · [English](log-buffer-codec-implementation-scope.en.md)


产品提交 **`b9f53efe3ff1d919d23411f08d6eda6f5a92f345`** 把日志和临时字节资源放回实际 Session owner，同时补齐八项生命周期通知的独立准入和文件文本的 UTF-16 传输边界。统计口径仍为微信基础库 3.17.3、`miniprogram-api-typings@5.2.3`、1265 API × 七平台 = 8855 单元。源码实现、有限执行结果和完整 API 验收分别记录。

| 范围 | 本批台账变化 | 单元数 |
| --- | --- | ---: |
| `wx.getLogManager` 及 `LogManager.debug/info/log/warn` | Missing → Partial | 35 |
| `wx.createBufferURL`、`wx.revokeBufferURL` | Missing → Partial | 14 |
| 八项 App/页面卸载通知 | 修正准入与所有权，状态不变 | 0 |
| 四项同步文件文本 API × 六 native 平台 | 补编码传输，继续 Partial | 0 |

合计恰好 **49 个 Missing → Partial**，Available 增量为 0。合并后的源码矩阵为 Available **1504（16.98%）**、Partial **1070**、RequiresHostService **86**、Missing **6195**；accepted **0**、platformNotApplicable **87**。距离 7084 个 Available 仍差 **5580**。本批没有把有限浏览器结果导入正式 acceptance ledger，80% 阶段目标仍未完成，父全量验收 goal 保持 paused、未完成。

完整 8855 个 cell 对象比较共有 **129 个对象变化**：上述 49 个状态变化、24 个 codec 来源/范围说明和 56 个 lifecycle owner/来源说明；其余 **8726 个对象不变**，全部 acceptance 与 coverage 不变。acceptance contracts 和 ledger 仅重新绑定当前 canonical catalog 摘要，合同及空 reports 不变；清点与矩阵相关的最终 **513/513** 项测试、实际生成和 `--check` 均通过。

<a id="session-held-logmanager-logs"></a>
## Session 持有的 LogManager 日志

[`log-manager.js`](../../crates/container-core/src/log-manager.js) 提供独立的 runtime factory 和四个方法，QuickJS/V8 回调把记录写入 [`LogManagerJournal`](../../crates/container-core/src/log_manager.rs)。日志不借用 Console 的十六参数、2048 字符格式化器，也不依赖可写 guest effect/drain 全局。Session 从同一 native journal 取记录，投递到已有 native SDK Console consumer 和 Web 诊断 wire；只产生日志的调用和公开 `toJSON` 失败的调用仍能到达该 drain。

factory 和四个成员分别取 manifest、可信 host 和 provider 的最小等级，没有隐式授权；借用旧方法不能越过撤权。首次成功调用 factory 后开始记录。缺省或 `{level:0}` 同时记录显式调用、实际 App/Page hook 和已安装 `wx` 方法调用；`{level:1}` 只记录显式方法。当前返回一个 Session 共用 manager，后一次 factory 调用会更新自动记录策略。这是当前容器策略，尚未证明与固定微信版本的重复 factory 语义相同。

参数投影保留根参数顺序、对象重复引用和循环，并表示稀疏数组、BigInt、Symbol、Map、Set、ArrayBuffer、特殊 Number 及 own descriptor。普通 getter 和 `toJSON` 不执行；Proxy 的反射 trap 仍可能执行，因此入口用重入保护和 generation 复核阻止投影期间撤权后继续入队。孤立 surrogate 用带类型的 UTF-16 单元表示，避免 Rust/JSON 静默替换。投影最多 8192 个节点，最终投影 JSON 的 UTF-8 预算为 100 KiB；超限整条拒绝，后续健康日志仍可写入。

native journal 最多保留 5 MiB、8192 条易失记录，压力下移除最旧记录并报告 dropped。每次 drain 最多 128 条、256 KiB，预算包含诊断桥第二次 JSON 字符串编码；未消费尾部保留到后续宿主轮次。入队异常、poison 和清理异常不允许穿过 VM ABI，日志不能替换原调用的返回值或异常。

App 隐藏、页面销毁不终止应用级 journal。终态应用/host 调用关闭、账号/服务撤销、引擎 drop 或永久执行故障会关闭 native owner，丢弃残余记录；之后即使重新发布可信能力也不能复活该 incarnation。实现位于 [`async_host.rs`](../../crates/container-runtime/src/async_host.rs)、[QuickJS execution control](../../crates/container-engine-quickjs/src/execution.rs) 和 [`EngineTerminalResources`](../../crates/container-core/src/engine_terminal_resources.rs)。

五个 API 继续 Partial：任意值的官方投影、100 KiB 计费口径、重复 factory 策略、持久化/上传、Web/native 保留行为与固定微信版本的一致性均未完成。当前诊断 consumer 通过不等于微信日志服务验收。

<a id="immutable-byte-owner-of-bufferurl-and-image-consumption"></a>
## BufferURL 的不可变字节 owner 与图像消费

[`buffer-url.js`](../../crates/container-core/src/buffer-url.js) 同步接收 ArrayBuffer 和锁定声明中的九种 TypedArray，按其真实 `byteOffset/byteLength` 快照字节。DataView、BigInt TypedArray、共享缓冲区、伪造 receiver、已 detach 和超预算输入明确拒绝。create/revoke 独立准入，私有 native callback 在 bootstrap 后从全局删除，通用 host descriptor 不能替换这两个 runtime API。

[`BufferUrlStore`](../../crates/container-core/src/buffer_urls.rs) 为每次创建分配 native 192 位随机身份，字节为不可变 Arc；相同内容仍得到不同 URL。单租约上限 8 MiB、每 owner 32 MiB、1024 个租约。`revokeBufferURL` 同步返回 void，只移除当前 owner 地址对应的租约；重复、未知和其他 owner 的 URL 不会影响有效资源。限额与 URL 形态是容器策略，不能据此宣称完整官方参数域。

真实消费链目前覆盖 `<image>` 的 PNG、JPEG、WebP。[`buffer_urls.rs`](../../crates/container-runtime/src/buffer_urls.rs) 从同一 Session 的 live lease 生成 View resource descriptor；[`images.rs`](../../crates/container-runtime/src/images.rs) 在查每帧资源和 decoded cache 前重新验证租约，内容哈希相同不能替代授权。预览使用 live Session 的字节 owner，页面/组件重建不改写资源归属。

Web direct/WASM 和生产 Worker/DOM 通过 [`browser_view_resource_at_path`](../../crates/container-runtime/src/browser_view.rs) 按完整 presentation key、精确 descriptor path、SHA-256 和 size 读取。Worker 的 [`resource` RPC](../../examples/hosts/web-wasm/worker-runtime.mjs) 保留 path，[DOM adapter](../../examples/hosts/web-wasm/worker-dom-adapter.mjs) 在创建 Blob URL 前复核回包和实际 digest。动态资源不允许退回只凭 digest 的读取路径，旧 surface、撤销后地址和换 owner 后地址均不再授权新读取。

应用隐藏和 Page retirement 保留应用级租约。终态应用卸载、服务/账号撤销、terminal host-call shutdown、native engine drop/永久故障会排空 owner，即使公开 revoke 被拒绝也必须清理。已经成功发布的不可变 frame 或 DOM Blob lease 按现有最后使用者生命周期保留；撤销不追溯清除已发布像素，新的资源读取和 cache 使用必须重新过 gate。

两个 API 继续 Partial。当前没有证明 URL 的完整官方生命周期/限额语义，也没有把图像 consumer 扩大到 audio、video、文件或其他媒体 API；这些 consumer 必须分别实现和验收。有限 QuickJS/WASM 图像执行不能代替七端公开 SDK、其他引擎/OS、物理设备或微信 oracle 验收。

<a id="independent-admission-for-lifecycle-notifications"></a>
## 生命周期通知的独立准入

[`lifecycle-notifications.js`](../../crates/container-core/src/lifecycle-notifications.js) 为 `on/offAppShow`、`on/offAppHide`、`on/offBeforePageUnload`、`on/offAfterPageUnload` 各自保存私有准入；Session 先取该方法的 manifest 声明，再与可信 host/provider 求最小等级，保留 Partial，不借 counterpart 授权。通用 installer 的直接或 counterpart descriptor 都不能覆盖这些方法，篡改公开 capability map 不会授予权限。

撤销某个 on 方法只清除该事件 listener 并增加 generation，截断已捕获但未执行的尾部；重新授权不重放旧订阅。普通 off 仍按既有 emission snapshot 执行，不等同可信撤权。通知准入不删除内部 departure/receiver 状态，因此 before/after 能继续配对并完成实际页面退休；拒绝公开 show/hide listener 也不取消 scheduler 的暂停/恢复。终态 retire 清空全部 listener 和 pending departure，独立于公开 off 权限。这是已有通知实现的边界修复，不增加本批 Available。

<a id="file-text-encoding-and-utf-16-boundaries"></a>
## 文件文本编码与 UTF-16 边界

[`host-bridge.js`](../../crates/container-core/src/host-bridge.js) 在 `writeFileSync`、`appendFileSync`、`writeSync` 进入 Rust JSON 前，把原始 JS 字符串逐 code unit 投影成私有 `__weappSyncText`，并只序列化一次。真正的 ArrayBuffer 继续走二进制路径；`readSync` 仍修改并返回调用方原 buffer。私有标记不是新的公开输入类型，伪造普通对象或 TypedArray 写入不因此获得支持。

[`sync_file_codecs.rs`](../../crates/container-runtime/src/sync_file_codecs.rs) 支持锁定的全部 11 个别名：`ascii`、`base64`、`binary`、`hex`、`ucs2`、`ucs-2`、`utf16le`、`utf-16le`、`utf-8`、`utf8`、`latin1`。实际磁盘和 descriptor I/O 使用同一 codec。UTF-8 的替换、ASCII 读取高位掩码、hex 截断、Base64 空白/URL 字母表和 UTF-16LE 奇数字节处理以 Node Buffer 有限向量作实现对照，不能代替微信官方语义。

共享受管文件 owner 的文本读取保留 code-unit wire：同步 `readFileSync` 在 guest 返回处还原，异步 managed-file `readFile` 在 guest-facing `result.data` 处还原。Rust/JSON hop 不提前把 UTF-16LE 的孤立 surrogate 改成 Unicode scalar；Harmony 单元测试直接断言私有 units，live FFI 测试验证同步写入、异步读取的 guest 结果。此修正没有扩展 async write 的 lone-surrogate 输入域，也不修复 Storage 的完整 UTF-16/JSON 域。

四个同步 producer 在六 native host 的 24 个单元继续 Partial。managed-user 路径、单块/JSON/owner 预算、剩余锁定参数、跨 owner quota 和公开 SDK 验收仍单独保留；Web 同步文件持久化没有被 native `std::fs` 实现晋级。

<a id="achieved-verifications-and-pending-gateways"></a>
## 已取得的验证与未决门禁

本轮已报告通过 native engine/runtime 的定向门禁和 Node/catalog 门禁；最终 UTF-16 修正另通过 Harmony library **17 项**、目标 live FFI 测试、codec Node **7 项**。这七项已包含在随后四组 LogManager/BufferURL/lifecycle/codec Node **121/121** 的复验中，不能相加成唯一测试总数。`cargo check --workspace --all-targets --locked`、全 features Clippy `-D warnings` 和 `cargo fmt --all -- --check` 通过。

Web 从干净 snapshot **`134209101741e99c79ccdfe4df47903789b7ab4a`** 产生通过的 CanvasKit build；该构建绑定的 **479 个输入文件**逐字节对照当前产品源码全部一致，不扩大成全部仓库输入或所有平台产物的同一性。真实 headless QuickJS/WASM direct **10 个**、生产 Worker/DOM **10 个** BufferURL 图像场景均通过，覆盖 ArrayBuffer 和九种 TypedArray、descriptor/字节 digest、实际像素，以及 hash-only、stale surface、revoked 地址拒绝。浏览器 context/browser、Worker、server 和 sockets 均已关闭。该执行使用 synthetic rehashed fixture，安装的 WASM 与产品 Worker/DOM 文件字节保持原样；不扩大为完整 API acceptance。

浏览器 v2 fixture 在执行前被当前 validator 拒绝：它使用 schema 1 却带 `rendering` 对象。v3 successor 只修正所需的 schema 3 后实际执行并通过；原 v2 失败和 v3 provenance 均保留。原始 scratch 来源为 `/private/tmp/weapp-buffer-url-browser-evidence-v2`、`/private/tmp/weapp-buffer-url-browser-evidence-v3` 和 `/private/tmp/weapp-buffer-url-clean-build-v1`；稳定仓库副本、原始失败和来源关系见[本批证据](../archived-evidence.md)。

**完整四线程 workspace 复验通过，标准并行失败仍未归因。** `cargo test --workspace --locked -- --test-threads=4` 以 exit 0 结束，132 个结果块合计 **2927 passed、0 failed、10 ignored**，保留完整原始日志与摘要。标准并行运行先后出现 declarative View 与 `native_query` 的 deadline 失败；一次串行运行在 2145 passed、3 ignored 后停在 `tab_bar_transactions`，已中断。第三次标准运行的 runtime block 为 625 passed、3 failed、1 ignored，三项失败均为 `native_query` setup 的 `View frontier deadline expired`；随后全部 26 项 `native_query` 测试以 `--all-features --test-threads=1` 通过。四线程复验也通过了 `tab_bar_transactions`，但不确定先前停住的原因。各命令覆盖存在重叠，不相加为唯一测试总数；原失败和中断不因后继结果改写。

独立只读审计确认 fixture、`view_execution.rs`、双引擎 View 和 View bootstrap 与 HEAD 字节一致。50 ms frontier 包含首次隔离 View VM 的初始化；fixture 还在被测 Session 前额外启动并渲染 reference Session。新增 LogManager/BufferURL bootstrap 仅在 AppService 安装，BufferURL 文档投影在 View frontier 返回后执行，未发现新的直接锁或资源调用进入该计时区间。这使负载敏感性成为待查方向，仍不足以确定根因或证明失败与产品无关。本批未放宽 deadline、降低断言或改写夹具来取得通过；旧运行的部分原始日志已不可用，保留的结果记录明确标注来源与限制。

本批没有新的七端公开 SDK/设备/商户验收或生产发布。七个 gitlink 和两个历史 untracked 证据目录保持原归属；干净 Web snapshot 的结果不表示当前整个工作树干净，也不表示所有平台已交付。

产品提交只包含 58 个明确路径。四线程运行期间观察与结束后的 **1745 个非文档源码文件**逐字节一致，七个 gitlink 不变；本轮实际读取的两个历史证据目录共 **913 个文件**前后哈希一致，仍未纳入提交，不改写早期报告的计数口径。最终 matrix `--check` 在产品提交后再次通过。证据包保存原 union、独立审计、UTF-16 successor、source pins、浏览器失败与后继、干净构建和最终复验；归档完整性通过不扩大原始执行或验收范围。
