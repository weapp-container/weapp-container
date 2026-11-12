# Dev Player 设备协议 v1

本协议独立于业务 bridge 和 SDK C ABI。当前 wire version 为 `"1.0"`，仅服务 LAN/已有 VPN。客户端本地执行 QuickJS＋Skia；协议传输构建产物、控制和诊断，不传帧，不运行任意远程 JS。当前双方要求精确版本 `1.0`，不兼容返回 `ERR_PROTOCOL_VERSION`；不能静默降级。

源定义为 `scripts/device-dev-server.mjs`、`scripts/lib/device-dev/`、`apps/dev-player/lib/src/protocol.dart` 和 `pack_store.dart`。本文件记录该实现契约，不表示五端已实测通过。

## 身份、TLS 与配对

服务默认 `https://<LAN-IP>:5180`，最低 TLS 1.2。项目忽略目录 `.weapp-container/device-server/identity.json` 保存自签名 EC 证书、私钥和稳定 `serverId`；`devices.json` 保存设备 token 哈希和期限。私钥不进入 pack。证书到期明确失败；更换证书必须重新配对，不能放宽 pin。

连接串形状如下，所有 query 值按 URL 编码：

```text
weapp-container://connect?endpoint=https%3A%2F%2F192.168.1.20%3A5180&fingerprint=<64-lowercase-hex>&code=<one-use-base64url>&project=<project-id>
```

`fingerprint` 为叶证书 DER 原始字节 SHA-256。客户端每个 HTTPS/WSS socket 固定该证书，不接受 cleartext、外部 redirect 或系统证书例外。`projectId` 为规范项目绝对路径 SHA-256 前 32 位；它不是秘密。连接串和 token 必须视为凭据，不能加入历史、业务日志、pack 或安装包。

配对凭证为 24 个随机字节 base64url，120 秒有效，只可使用一次；重新生成替换旧凭证。`POST /v1/pair` 不要求 bearer，JSON 为：

```json
{"protocolVersion":"1.0","code":"<one-use>","deviceId":"<stable-id>","name":"My phone","platform":"ios"}
```

平台仅 `android|ios|macos|windows|linux`；deviceId/name 是 1–100 字符且无控制字符。每地址每分钟最多 5 次尝试，尝试表最多 256 地址；最多 32 个有效设备。一次性凭证在异步存储前消耗，不能并发复用。成功响应：

```json
{"protocolVersion":"1.0","deviceToken":"<32-random-bytes-base64url>","projectId":"<id>","serverId":"<id>"}
```

设备凭据 30 天有效，服务仅保存哈希。客户端使用 OS secure store；不可用时显式显示 memory-only，不伪装持久化成功。设备所有后续 HTTP/WSS 请求携带 `Authorization: Bearer <deviceToken>`。撤销后新请求拒绝、现有 WSS 关闭；凭据不放 URL。重新配对同 deviceId 替换旧凭据。

## 产物发布与 HTTPS

Rust `DevSupervisor` 是唯一 watcher 和构建所有者。portable publication 完成后，经匿名 stdin 向 sidecar 提交成功收据；sidecar 再校验目录归属、manifest 原始 SHA-256、规范化完整性 root 及所有 blob。URL 不能选任意文件。构建失败只发送诊断，当前 generation 不变。

| 接口 | 成功响应 |
| --- | --- |
| `GET /v1/project` | 当前 descriptor；尚无成功构建为 204 |
| `GET /v1/generations/<generation>/manifest.json` | manifest 原始 UTF-8 bytes，immutable 私有缓存与哈希 ETag |
| `GET /v1/blobs/<sha256>` | 原始 blob bytes，Content-Length，immutable 私有缓存与哈希 ETag |
| `GET /v1/events` upgrade | 已鉴权 WSS，RFC 6455 version 13 |

JSON 错误为 `{error:"ERR_*"}`，401 为未鉴权，协议不匹配配对为 409，配对限频为 429。HTTPS 服务不提供业务控制或任意文件代理。请求 JSON body 上限 64 KiB。

Descriptor 例子：

```json
{
  "protocolVersion":"1.0",
  "projectId":"<stable-project>",
  "runId":"<32-hex-per-server-run>",
  "generation":"7",
  "manifestSha256":"<64-hex>",
  "integrityRoot":"<64-hex>",
  "manifestPath":"/v1/generations/7/manifest.json",
  "blobsPath":"/v1/blobs/",
  "compiler":{"name":"weapp-vite","commit":"<pinned>","platform":"weapp"},
  "schemaVersion":3,
  "route":"pages/home/index",
  "blobs":[{"sha256":"<64-hex>","size":1234}]
}
```

generation 是正十进制字符串，不用 JSON 浮点表示身份；服务仅接受安全整数 revision。每次 sidecar 启动产生新的 runId，不能跨 run 比较 generation 数值。相同 run 中旧/重复 publication 不会覆盖当前包。当前服务最多保留三个 generation。

服务限制 manifest 8 MiB、descriptor 2 MiB、pack 256 MiB、10,000 blob。Player 限制单 blob 256 MiB，两个并发下载 worker，项目下载缓存上限 1 GiB。客户端只下载缺失 CAS，重新校验缓存字节、完整引用图及资源尺寸；不信任本地 receipt 自称有效。所有资源就绪后 staging 原子发布，原生 SDK 再验证。迟到下载、服务 run 变化、后台或 project 切换使旧任务失效，失败不改变已接受包。

## WSS 更新与报告

服务器先发送：

```json
{"protocolVersion":"1.0","type":"ready","serverId":"<id>","projectId":"<id>","runId":"<run>"}
```

已存在成功构建时随后发送 `pack`。通知只包含身份，客户端用 `/v1/project` 获取完整、当前 descriptor：

```json
{"protocolVersion":"1.0","type":"pack","runId":"<run>","generation":"7"}
```

其他服务器类型：`diagnostic`（构建诊断）、`heartbeat`、`command`（name=`reload|rollback`）和 `shutdown`。heartbeat 每 15 秒，60 秒无响应的 peer 关闭；最多 16 个同时连接 peer。WSS 文本消息上限 64 KiB，客户端须 mask，支持有界文本 fragmentation；不接受 binary、压缩扩展或 64-bit payload 长度。慢 peer 写队列超过 1 MiB 时断开，不阻塞其他设备。

客户端发送 `heartbeat` 或：

```json
{"protocolVersion":"1.0","type":"report","projectId":"<project>","runId":"<run>","generation":"7","phase":"started","details":{"reloadKind":"inPlace"}}
```

允许 phase 为 `connected|downloading|downloaded|verified|starting|started|presented|error|diagnostic|metrics|log`；带 generation 的报告必须带当前 runId。`projectId` 存在时必须匹配配对项目；旧客户端可省略。`details` 为有界诊断数据，不授予运行能力。电脑的命令入队 202 只代表收到，不是客户端完成。

`started` 是原生候选被接受。当前 Player 在 SDK generation、有效 frameRevision、inputEnabled 和实际 gpuSurface 匹配后发送 `diagnostic`，其 `code=NATIVE_FRAME_ACKNOWLEDGED`、`presentationStage` 和 `screenPresented:false` 明确 ACK 边界。macOS 为 `flutter-texture-consumed`，只证明 Flutter 消费了 GPU 纹理；其他当前适配器为 `native-frame-acknowledged`。这些信息不能证明最终屏幕呈现时间或实际 FPS，因此当前 Player 不发送 `presented`。协议保留 `presented` 供具备额外显示收据的后续客户端使用。旧/迟到收据不能恢复输入；GPU 暂停后的重试必须等待新 frameRevision。服务展示的报告是设备声明，网络日志不能替代硬件显示与交互证据。

### 只读 source-map 定位

`error|diagnostic|log` 可在 `details.stack` 或 `details.error.stack` 携带原始栈，也可用 `details.error.{file,line,column}` 报告位置（行、列从 1 开始）。服务保留原始 `details`，仅在管理面历史中新增 `sourceMapping`，包含 `version: "1.0"`、`status: mapped|partial|unmapped`、`frames`、可选 `mappedStack` 及失败 `reason`。它不接受读文件、下载 URL 或执行 JS 的命令。

映射绑定当前连接最近声明接受的 project/run/generation；`starting` 不切换身份，迟到的 `presented` 不覆盖另一个已接受 generation。最新构建发布不会改变旧实例的 map。候选报告标为 `unaccepted-generation`，已淘汰 generation 标为 `generation-unavailable`。只有带身份的 `started` 或初次 `presented` 能建立接受身份；这仍然只是设备声明。

普通脚本按 manifest 模块的完整路径与同名 `<module>.map` asset 精确关联，只支持完整模块路径或 `module:<path>` 执行文件名。modern View 使用 `weapp-view:///modern:<SHA>.js` 和 manifest 的 `sourceMapSha256`，按现有运行库包装偏移 3 行定位；已带 `[generated ...]` 的栈不重复改写。`<input>`、eval、仅 basename 或自定义 `sourceMappingURL` 不猜测模块，保留未映射结果。

map 仅从已校验 CAS 读取，打开时禁止 symlink，限制读取长度并再次校验 SHA-256；编译后保持只读缓存，随最多三个 generation 一起淘汰。每代最多 128 份 map、每份 2 MiB、总计 8 MiB、100,000 行和 100,000 segment；每份最多 4,096 source 和 16,384 name。单次栈最多 16 KiB、64 个位置，超限明确标记 budget，禁止部分猜测。支持普通 source-map v3 与 VLQ，拒绝 indexed map、非空 `sourceRoot`、绝对路径、URL 和逃出项目标签空间的路径。modern source 必须在 manifest allowlist 或是受限 virtual ID。`sourcesContent`、names 和 map 的 `file` 不展示、不作为别名；源码断点调试仍未提供。

## 本机管理面

管理 HTTP 仅绑定 `127.0.0.1`，默认 5179，与 TLS 设备端口分开。`GET /` 生成页面与每次进程随机管理 secret，其余接口要求 bearer、精确 Host 和同源 Origin：

| 接口 | 内容 |
| --- | --- |
| `GET /state` | 已配对设备、连接 phase、当前 descriptor、有界历史 |
| `POST /pair` | 新一次性连接、过期时间和二维码 data URL |
| `POST /revoke` | `{deviceId}`；撤销 credential 并关闭 peer |
| `POST /command` | `{deviceId,name:"reload"|"rollback"}`；仅入队 |
| `POST /inspect` | `{deviceId}`；派发唯一只读 `pages.read` 请求，202 仅代表等待设备响应 |
| `GET /inspections/{requestId}` | 读取 pending／错误／有效结果；快照不写入历史日志 |

管理 secret 和设备 token 权限分开，设备无法调用旧 Web 模拟器 `/api/bridge`。电脑面板不提供任意远程求值。只读 inspector 绑定当前 peer 和已接受 project/run/generation，Player 一次批量调用 `devState`，提取页面数据及白名单中的被动 SDK 状态、accepted pack 和开发操作收据；不导出 storage、原生私有配置或任意命令。每设备一个在途请求、5 秒超时，结果最多 48 KiB、32 页、2,048 节点、12 层；敏感键及凭据文本遮盖，快照不进入历史日志。断线、实例更新或身份不匹配会使旧请求/快照失效；未知操作不得调用运行库。管理面分别展示 pending、失败和有效结果。

可选 `playerViewDiagnostics` 是 Player 进程拥有的版本 1 诊断记录，最多 16 项。它只含受控操作、View lease、操作及记录序号、错误码、封闭原因、退休标记和事件发生时的 controller 角色，不含原生错误正文、stack 或任意 UI 日志。`lastSequence`、`droppedCount`、`sequence` 为最长 128 位的规范十进制字符串；lease 和操作序号为正 u64 字符串。服务重新校验完整字段、枚举和顺序，拒绝未知字段及非规范数字。该有界 scalar 记录不占页面节点配额，但计入同一个 48 KiB 字节上限；不足时只从响应副本删除最旧记录并设置 `responseTruncated`，最小封装也放不下则明确返回 `ERR_DEV_INSPECT_LIMIT`。新 Player 在首次失败前也发送 `lastSequence="0"`、`droppedCount="0"`、`entries=[]` 的封装；旧 Player 缺字段仍表示观察不可用，不能补为零。该记录只覆盖 Player 观察到的异步 View 操作失败，不证明全部原生事件或诊断无丢失。跨项目、重启页面的历史不因当前 pack 归属而重新归因；Player 进程重启后记录序号重新开始。

iOS 的布局测量取消使用闭合 `{schemaVersion:1, reason}` 细节传播九种实际分支原因。只有 `ERR_CANCELLED` 与严格匹配的字段、整数版本及原因组合才可进入记录；非法细节保持 `unclassified`，不回退到错误正文推断。空细节仍兼容旧 Android 的已知精确错误正文。取消原因仅描述失败来源，不授予输入、证明安全恢复或改写历史未分类错误。

`state.viewExecutionMetrics` 可携带文档注册计数、输入字节及 opt-in 原生 `lastBatch`。原生时钟和线程身份保持十进制字符串，无法测量的值保持 `null`，不填充虚构的零。独立可选 `lastBatchBreakdown` 版本 1 必须匹配相邻 `lastBatch` 的引擎、profile、操作、批次和线程身份；其 QuickJS 阶段分别记录 context 调用、原生 JSON stringify API、UTF-8 复制、最终 deadline 检查和 poisoned realm 销毁，以及实际输出字节。阶段允许嵌套，不能相加；stringify API 含包装层 Value 释放，不能声称纯序列化 CPU 时间。现代 profile 的私有 writer 属于执行阶段，V8 不填充 QuickJS 阶段。关闭诊断时省略该可选字段，原 `lastBatch` v1 字段不变；完整约定见 SDK 契约 `PREVIEW5.md`。这些指标仍受原有页面／状态共享预算约束。诊断和指标不改变健康状态、输入权限、开发操作结果或实际呈现状态。断点调试尚未提供；本地与 WSS/HTTP 测试不替代真实设备的数据检查、错误定位和性能验收。

## reload、失败和退出

SDK `pack.devReload.protocolVersion="1.0"` 是必需能力；旧库明确拒绝。共享分类器决定 `inPlace|restart`。保状态只覆盖确认安全的 View/资源变化；结构/脚本变化完整重启并保留持久存储。下载、验证和启动接受前失败保留当前实例。接受后的 GPU 失败暂停输入并允许重试/上一包，上一包重新启动，不保证旧 JS heap 恢复。

断线不销毁本地 app，后台停止重连并取消当前更新，前台重新同步。退出先停止设备 reader/connection，再停止唯一 supervisor watcher 和自有 staging；本任务不关闭其他开发服务或用户设备。验收必须分别记录连接、下载、验证、启动、呈现、重试、退出及资源释放。
