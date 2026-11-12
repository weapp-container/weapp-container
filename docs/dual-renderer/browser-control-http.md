# 浏览器开发态 HTTP 控制客户端

`crates/container-simulator/src/browser-dev-http-control.mjs` 提供
`BrowserDevHttpControl`，供受信任的本机 owner 接入现有
`BrowserDevOwnerManager`。它不领取预览 lease、不启动 Worker。`WebSurface` 现提供
显式 opt-in 的控制队列与独立 opt-in 的开发 UI，缺省 resource-only 服务继续仅提供已允许的静态 GET。普通 Browser watch CLI 和实验 example 共用同一个显式 runner；固定的 Worker producer 和 bundle 清单保持独立。

初始化必须显式提供根 `baseUrl`、`runId`、`clientId` 和 `secret`。浏览器内要求当前
页面同源；POST 禁止重定向，并检查最终响应 URL。三个命令端点为：

- `/__weapp/control/invoke`
- `/__weapp/control/replay`
- `/__weapp/control/acknowledge`

`/__weapp/control/observe` 接受相同鉴权及固定 `{"version":"1.0"}`，只读取原 owner 的
typed snapshot，不占用命令 ledger、serial、final 或 ACK；响应仍受 HTTP 容量与 deadline 限制。

每个请求发送 `X-Weapp-Run-Id`、`X-Weapp-Client-Id`、`X-Weapp-Dev-Secret`。
服务端使用本机 owner 在首次 accept 前固定的身份、Origin/Host 和 secret 鉴权；这些
客户端 header 不授予权限。底层客户端不负责 owner、预览选举与 Worker 关闭关联；
`serve_browser_dev` 和普通 CLI 的显式 Browser profile 复用同一个 runner 接通这些边界；详见[开发循环](browser-dev-loop.md)。

## 显式服务端接入

先创建 `WebSurface::bind_resource_only`，再于首次 accept 前调用
`enable_control(ControlHttpAuth)`。同一个实例只可启用一次，不接受从请求选择 run、
client 或新建 ledger；普通旧模拟器 surface 无法启用。auth 必须匹配实际 plain-HTTP
监听地址，TLS／代理配置明确拒绝。IPv4／IPv6 默认 HTTP 80、HTTPS 443 的 trusted
authority 按浏览器规范省略默认端口，收到的 Host／Origin 仍必须精确匹配。
浏览器不支持的 IPv6 zone，以及与 Rust Host 拼写不一致的 IPv4-mapped IPv6，初始化
明确拒绝；普通 IPv6（例如 `::1`）可用。

原 owner lane 按 `poll → resolve_control_requests → resolve_resource_requests → poll → wait`
推进。resolver 借用原请求与固定 auth，负责对**原** `ControlLedger` 调用 admit／lookup／ACK；
这层服务不执行 coordinator mutation，也没有伪造成功的 Worker close。ACK 必须直接调用
`acknowledge_final`，不能先 lookup 增加一个会阻止自身压缩的 final borrower。

控制命名空间在旧 Content-Length、OPTIONS 和 wildcard CORS 之前拦截。首行收齐后
才分类，避免分片的 `/__weapp/run` 被误判、破坏合法 runtime GET。POST 必须采用精确
HTTP/1.1、这些固定路径、唯一 framing／auth header 及规范 Content-Length；完整 header
到达时立即检查身份和声明长度，不等待未授权 body。拒绝 Transfer-Encoding、Trailer、
Expect、Upgrade、query、编码路径和已收到的尾部字节；错误回复不反射 secret 或本地路径。
控制响应采用同源 policy、nosniff、no-store，无 wildcard CORS。

header 上限 16 KiB，invoke／replay body 上限 64 KiB，ACK body 上限 129 KiB；
内部原请求仍限 64 KiB。每个 opt-in incoming socket 预分配有界 wire buffer，并保守预留
四倍最大 wire 空间，涵盖原 buffer、ACK 解码 scratch 与 strings；状态中的
`control_request_reserved_bytes` 是保守记账，不是 RSS。owner 队列、半请求和响应共用
原 64 连接上限，resolver 返回后不保留原请求副本。正常、恢复与清理在底层 transport
共享有限 socket 容量；本层不承诺饱和时的无限清理进度。

`WebControlResponse::Final` 把原 ledger 的 `Arc<Vec<u8>>` 移入实际响应 body，HTTP 只另计
小 header，不复制或重新编码 final。ACK 回复编码器自身限 4 KiB。accept 到 owner lookup、
写出共用原 5 秒 deadline；沿用 256 KiB quantum／2 ms round-robin writer。完成、断连、
超时或 drop 此 surface 才释放实际 body borrower，HTTP 发送完成不等于客户端已采纳结果。

`stop_admission()` 只停止新 accept；旧请求、回复和清理仍可按原 deadline 推进。
`drain_status().is_drained()` 仅表示停止接纳且已接受 socket 全部释放，不能证明 ACK
交付、Worker 关闭或监督器清理完成。listener 端口直到 drop 这个 surface 才释放；有意
放弃交付时也只能 drop 所属 surface，再在原 supervisor 上重试退出。

## 原始结果与 ACK

`invoke(request, {signal})` 只允许一次，网络失败或实际工作容量不足也不能再次 invoke。
`replay(request, {signal})` 只查询已接纳的同一个请求。客户端保存首次序列化的 UTF-8
字节，后续请求必须完全相同；不会自动重排、逐出或重发 mutation。

请求上限 64 KiB，final 上限 256 KiB，ACK 回复上限 4 KiB。流式读取核对实际长度、
Content-Length、UTF-8、响应类型与结果身份。SHA-256 针对原始 final 字节；解析结果
深度冻结，以 WeakMap 关联原 request 和哈希。重新序列化的 JSON 不能代替原哈希。

manager 完整采纳并保留结果后才调用
`acknowledge(request, originalParsedFinal, {signal})`。副本不能授权 ACK；同一请求
最多一个实际 ACK，成功后复用已验证回执，失败只允许显式重试。ACK body 为：

```json
{"version":"1.0","originalRequest":"<首次请求的原字符串>","finalSha256":"<原始 final SHA-256>"}
```

服务端回复只包含相同 `version`、`requestId`、`finalSha256` 与
`outcome: "compacted" | "already-compacted"`。因 originalRequest 再次 JSON 转义，
ACK body 可以超过 64 KiB，服务端须单独设置有界上限；内部原请求仍受 64 KiB 限制。
ACK 自身不退休服务端 tombstone，不证明 Worker 关闭或当前画面已呈现。

## 可选前缀退休协议 1.0

`BrowserDevOwner::enable_control_retirement()` 在首次命令前显式开启，重复开启或已有
high-water 时拒绝。受信任 UI 使用 `enable_browser_dev_app_with_retirement` 发出
`bootstrap.retirementVersion: "1.0"`，客户端构造时传相同值，manager 才能使用
`retryControlRetirements({maxOperations})`。旧入口与无协商客户端保持禁用。

`retire(originalRequests)` 使用原请求对象，选取同 lane 的最早已 ACK 前缀，最多 64 条；
已有实际 fetch、hash、reader、abort relay 或未结算 manager 事务时拒绝释放。
它不消费新 command serial，也不重复 invoke。新增端点 `POST /__weapp/control/retire`
使用原鉴权和严格 framing，body、回复各限 4096 字节：

```json
{"version":"1.0","lane":"normal","previousThrough":"0","throughSerial":"7","prefixSha256":"<SHA-256>"}
```

摘要按 UTF-8 逐字节拼接下列 transcript，末尾保留换行。实际记录按 serial 递增；
数字空洞不添加行，末端必须是存在的已 compacted 记录。

```text
weapp-control-retirement-v1\n
{runId}\n
{clientId}\n
{normal|cleanup}\n
{previousThrough}\n
{throughSerial}\n
{requestId}:{originalFinalSha256}\n
...
```

服务端完整预检前缀后才删除记录。回复精确包含 `version,runId,clientId,lane,
previousThrough,throughSerial,prefixSha256,retiredCount,outcome`，其中 outcome 为
`retired`。normal/cleanup 各有独立游标、永久 admission high-water 和最近一次精确
request/reply；总共四个 wire projection 各不超过 4 KiB。回执丢失后的完全相同重试
返回原回执，不二次修改；冲突游标、摘要、旧事务或未 ACK 前缀拒绝。

客户端每 lane 保留一个未决事务，失败后只能重试原批次。成功 promise 包含原请求的
清理完成，之后才释放字节和容量；调用方保留原 promise/receipt，不能再次提交已释放
ID。旧序号、high-water 以下空洞和 `u64` 溢出永久拒绝，不重置 serial。
manager 仅可另行删除已证明从未传输且事务结束的本地预留，不能伪造远端 ACK。

`status.highWater`、`status.retirements.{normal,cleanup}.throughSerial` 与 manager 的
`controlRetirements` 区分保留数、在途和失败。未决或失败退休不授权 Worker 清理；
Stop 必须继续原关闭流程，transport drain 仍等待已登记的实际退休工作。
`manager.drainControlWork()` 额外等待调用时已登记的 ACK/退休在 manager 层完成状态
采用、失败记账及通知；它不启动重试或新请求。HTTP drain 可能早于 manager 工作启动或
结果采用，不能单独作为读取 ACK pending 状态的屏障。

## 容量与关闭

原 entry Map 依据校验后的 command 固定 normal/cleanup 身份；首次接纳就预收最大
final 的保留费用。实际工作使用独立预算，不允许 normal 或 ACK 借用清理预留：

| 工作 | 默认在途数 | 默认逻辑字节预算 | 保留 entry 上限 |
| --- | --- | --- | --- |
| normal invoke | 8 | 16 MiB | 512 |
| cleanup invoke | 2 | 4 MiB | 128 |
| exact replay/recovery | 2 | 4 MiB | 不创建 entry |
| ACK | 8 | 4 MiB | 不创建 entry |
| prefix retirement | 2 | 256 KiB | 每 lane 一个未决事务及最近回执 |

字节预算包括原 entry 的保留费用及实际工作的临时预留；entry 已预收 final，因此
从 recovery 收到的 normal final 不占用 cleanup/recovery 保留空间。实际有效 entry
容量可能先受字节预算限制。各预算之和是逻辑记账上限，不是浏览器 RSS 保证。
cleanup/recovery 自身耗尽或适配器不响应时仍明确失败或保持 pending，不保证无限
清理进度。接入 owner 时还需协调 manager、transport 与 ledger 的有界保留容量；未协商退休时仍为有限 lifetime。

`status` 分别显示各类实际在途量、保留和临时费用。底层没有后台队列、重试 timer、
抢占或静默逐出。每个实际请求拥有 AbortController、父信号 relay 与 body reader；
包括 signal 属性访问在内的可重入适配器调用均在登记工作后进行。

`close()`/`dispose()` 返回同一个 barrier：先拒绝新工作，取消所属请求，再等待实际
fetch、hash、reader cancellation 与 relay 清理。忽略取消的适配器使关闭继续等待；
清理失败返回 `closed:false`，不会伪造成功。调用方须先关闭实际 Worker manager，
再等待 transport；传输关闭不是 owner close 或服务端 body borrower 排空证明。

## 串行 owner 库入口

`browser_dev_owner::BrowserDevOwner` 将原 `DevSupervisor`、coordinator 与
`ControlLedger` 移入一个串行 owner。它要求已准备好的独立固定 runtime、真实 managed
stage 策略，以及受信任启动上下文提供的 client／preview；初始化失败会将同一个
supervisor 连同错误返回，调用方继续重试该 owner 的清理。

`stage_latest` 和 `poll_stages` 在原监督器上执行源码屏障、静态 stage 与完成校验，
最多保留两个 stage 元数据。`enable_control` 只在显式 resource-only surface 上开启；
`resolve_controls` 同步连接原 ledger，`resolve_resource` 从原 stage/runtime 借用字节。
source 事件交给调用方的日志／诊断 sink，不在控制命令中递归开始新构建。

成功 `startOwner` 在返回 final 前登记 exact owner／site／actual stage 保护，Starting
与尚未构造的 intent 也占用保护。断连、源码失效或停止不会解除它。默认的
`enable_control` 继续使用 `NoActualBrowser`，拒绝全部成功 close 报告。

受信任本地启动方可以在首次 accept 前显式调用
`enable_browser_reported_control`，将同一 owner 的 run、client、preview 和本次
surface 对象生命周期身份绑定到 browser-reported 关闭策略。该身份不增持监听器或
资源；surface 移动后保持身份，销毁后在相同端口重新绑定也不能继承策略。启用控制失败不会开启策略；
HTTP 请求不能开启它。启动方必须把同一凭据交给唯一实际 manager，保留原 inert
entry 的身份和真实构造／关闭 barrier。每个 entry 的 ownerId 必须在首次创建时唯一，
同一请求重放保持原值；不能让两个 manager 共享确定性序号后各自采纳同一 start final。

策略比对服务器在 startOwner 时保存的原 binding、client、site index 和 backend；
已有 runtimeReady 时还要求完整 tuple 一致。原 coordinator 仍校验完整 CloseTicket，
只有该原始票据的成功状态转换才能解除保护及退休对应 actual stage。这是对可信
manager 报告的关联接受，不是服务端独立观察 Worker termination 的证明。
实际 bootstrap 和浏览器闭环由独立 `serve_browser_dev` example 接线并验证，见
[开发循环](browser-dev-loop.md)；本接口本身不开放普通 watch CLI、选举或 takeover endpoint。

`try_shutdown` 只在原 owner 上重试；未保护 stage 的 retirement、原 body borrower
排空与 supervisor 清理分别等待。`false`／错误不是完成。调用方应先完成实际
Worker 的精确关闭，再停止 HTTP admission；过早停止会阻断后续 cleanup／ACK。
listener drop 和 socket drain 仍不证明 Worker 已关闭。

## 关闭回执中的实际身份

`outcome: "closed"` 的 `receipt` 是版本化的 `BrowserWorkerCloseReceipt`：
`version: "1.0"`、`closed`、`workerClosed`、`ownedMountRemoved` 必须为真，
并显式包含可空的 `owner`、`rpcIdentity` 和 `workerFinal`。`owner` 使用既有
Worker tuple（epoch、session、pack index hash、backend）；`rpcIdentity` 来自真实
owner 捕获的 RPC epoch／session。非空 tuple 必须与 RPC、原 offered site 及已知
runtime tuple 一致。服务端 DTO 校验形状，仍不把报告当作关闭授权。

尚未调用 load 的已构造 session 可以返回三个空字段；已创建 RPC、但还未通过 pack
校验时可以返回空 `owner` 与非空 `rpcIdentity`／`workerFinal`；pack 已校验、load
尚未就绪时必须保留实际 tuple。这些状态都属于已构造 session 的真实关闭，不能
改写为 `never-constructed`。后者仍仅允许原 inert entry 证明构造从未尝试。

真实 `WorkerWebSession.close()` 继续等待原加载、adapter、资源、bridge、RPC 与
mount 清理。manager 只有等待该 barrier、核对身份并保留回执后才发送 finishClose；
失败会保留原注册及不确定状态。HTTP 内容仍是 browser-reported；默认
`NoActualBrowser` 保持拒绝，只有上述显式启动策略可以接受关联成功。未记录
runtimeReady 时，实际 RPC-only 回执可以完成清理；不能为此填造 runtimeReady。
接口代码与单测本身不证明 bootstrap、真实 Worker 关闭或 browser watch 已通过。

`owner.control_cleanup_ready()` 是原 ledger 的只读交付清理门禁：必须没有
`unresolved_final`，且两个 lane 的保留 entry 全部为已 ACK 的 `FinalCompacted`
tombstone；空 ledger 或已退休的 compacted entry 不阻塞。Queued、Executing、Prepared、
未 ACK Final、ExecutionUncertain 均阻塞。NeverExecuted 虽证明没有执行，仍没有已采纳
的 final，故不能当作交付清理完成。查询不会消费 ACK、压缩结果或移除 tombstone。
停服必须同时满足原 owner 的 `try_shutdown` 成功、该门禁通过，以及原 HTTP 队列实际
排空；固定宽限时间或 socket 断开不能代替这些条件。

## 可信开发 UI 服务接缝

原 owner 启用控制后，可在同一 resource-only surface 首次 accept 前调用
`surface.enable_browser_dev_app(&owner.preview())`。只允许 loopback，且每个 surface
只能成功启用一次；未开启控制、已接收连接、停止接纳或普通旧模拟器 surface 均拒绝。
该 API 仅提供 UI 字节，不执行 Worker、不选举 preview，也不改变默认关闭策略。

根 `GET /` 的 inert `application/json` 包含
`{bootstrap:{version,baseUrl,runId,clientId,preview},secret}`；run、client、secret、origin
只取自原 `ControlHttpAuth`，preview 由受信任调用方传入并核对 run／版本／lease。
嵌入前转义 `<>&`，不写入 URL、Debug 或错误消息。页面移除配置节点后由原 HTTP
客户端保留凭据，页面状态不输出 secret。

固定脚本仅通过 `/__weapp/dev/` 下的 `browser-dev-app.mjs`、
`browser-dev-owner-manager.mjs`、`browser-dev-http-control.mjs`、
`worker-session-client.mjs`、`browser-dev-entry.mjs` 与 `dev.css` 提供。
它们来自编译时源码，不存在磁盘路径或任意文件 fallback。根和资产精确匹配原路径，
与 immutable resource GET 共用严格 framing parser；UI 启用后所有这类 GET 必须精确
匹配原 auth Host，query、编码／遍历路径、非 GET、尾部 body／pipeline 均不授予 UI。

HTML 和固定资产预编码后原子加入原 HTTP 内存预算；实际写出沿用原 accepted-at
deadline、连接上限和 writer。响应使用 no-store、nosniff、same-origin CORP、
no-referrer 和 `frame-ancestors 'none'`，不添加 wildcard CORS。测试该服务接缝不代表
浏览器 bootstrap、Worker 或呈现门禁已通过；CLI 仍需单独接线。

## 执行证据范围

`scripts/test-browser-dev-http-control.mjs` 使用受控 fetch/stream 测试字节、容量、
回执、取消和同步重入。它不运行 Rust、HTTP 服务、Worker、浏览器、presenter 或 GPU。
实际 TCP 与原 Rust ledger 的专项测试另行显式执行，证据按源码和执行范围绑定；
七宿主、性能与官方 oracle 门禁继续独立管理。

```bash
NODE_BIN="$(command -v node)" cargo test -p container-simulator \
  --test browser_control_http --all-features --locked -j4 -- \
  --ignored --exact real_tcp_transport_uses_original_control_ledger_and_arc_body_barrier \
  --test-threads=1 --nocapture
```

本阶段结果与实际命令见 [客户端证据](../archived-evidence.md)。
