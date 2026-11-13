<a id="static-sites-original-lease-http-transfer"></a>
# 静态站点的原租约 HTTP 传输

**简体中文** · [English](browser-static-http.en.md)


> 本页记录底层阶段合同；这些 API 本身不启用开发 CLI。当前显式 Browser CLI 复用的完整 runner、启动参数及关闭限制见 [Browser 开发循环](browser-dev-loop.md)。


`serve_browser_stage` 将已验证的 runtime 和一个实际受管 stage 接到本机 HTTP。
它复用 `DevSupervisor` 的固定编译器、portable 输入、原资源字节和资源租约，
供检查静态描述符、索引与内容寻址 blob。该入口不执行 AppService、Worker、浏览器
或 presenter，也不授予站点发布、运行或输入权限。

<a id="running-example"></a>
## 运行示例

从仓库根目录执行，先完成[固定编译器与受管输入准备](browser-source-preparation.md)，
再准备一个独立选择并固定来源的已完成 Worker producer：

```sh
cargo run --release -p container-simulator --example serve_browser_stage -- \
  examples/apps/reference-app \
  /absolute/completed-worker-producer \
  /absolute/independent-pins.json \
  0 60000
```

位置参数如下：

| 参数 | 含义 |
| --- | --- |
| `project` | 原始小程序工程；使用固定 vendor compiler 和 QuickJS，不接受现代 View 的 `container.config.json`。 |
| `producer-directory` | 已完成的独立 producer 目录；支持 `software` 或 `canvaskit`，并须与项目、输出及准备根分离。 |
| `independent-pins.json` | 启动消费者前选定的 producer 身份，文件不超过 16 KiB。 |
| `port` | 可选，默认 `0`，由系统分配；示例只绑定 `127.0.0.1`。 |
| `duration-ms` | 可选，从 HTTP 启动后计算，范围 `1..=86400000`；省略则等待 Ctrl-C。要指定时长，仍须提供前一个 port 参数。 |

pin 文件结构与 [runtime 输入](browser-dev-artifacts.md#监督器的静态-runtime-准备)
相同。以下值是占位符，必须替换为独立 producer 执行记录中的原值：

```json
{
  "expected": {
    "reportSha256": "<原 build-report.json 字节的 SHA-256>",
    "sourceCommit": "<producer 的 source commit>",
    "sourceSha256": "<producer 报告中的 source inventory SHA-256>",
    "renderer": "canvaskit"
  }
}
```

`sourceSha256` 采用 producer 的 inventory recipe，不是 `source-snapshot.json` 文件
哈希。不能在消费者运行时从待验证目录回填预期 pin。具体来源与字节校验见
[runtime artifact 合同](browser-dev-artifacts.md)。

示例等待静态 runtime、真实 portable 和 stage 回执，准备阶段共用 180 秒 deadline。
成功后先打印 `StageArtifact`，再输出单行 ready JSON，包含以下字段：

```json
{
  "event": "static-http-ready",
  "address": "127.0.0.1:<port>",
  "descriptorUrl": "http://127.0.0.1:<port>/__weapp/site/<run>/<site>/site.json",
  "indexUrl": "http://127.0.0.1:<port>/__weapp/pack/<run>/<site>/pack-index.json",
  "runtimeBaseUrl": "http://127.0.0.1:<port>/__weapp/runtime/<bundle-sha256>/",
  "runtimeReady": false,
  "presentedReady": false,
  "publicationAuthorized": false,
  "sourceFreshness": "not-checked-after-stage"
}
```

使用实际输出的 `descriptorUrl` 或 `indexUrl` 获取原字节。`runtimeBaseUrl` 是资源前缀，
不是目录列表或可打开的小程序页面；应请求 allowlist 中的具体资源。示例不会自动打开
浏览器；该静态示例本身不启用 watch CLI。当前受管 Browser runner 的显式 CLI 入口见[开发循环](browser-dev-loop.md)。

<a id="url-and-request-boundary"></a>
## URL 和请求边界

资源专用入口只接受以下三类命名空间中的 GET：

| URL | 原资源来源 |
| --- | --- |
| `/__weapp/runtime/<bundle-sha256>/<path>` | 已保留 runtime receipt 的精确 serve allowlist。 |
| `/__weapp/pack/<run>/<site>/pack-index.json` | 当前固定 stage 的原索引。 |
| `/__weapp/pack/<run>/<site>/worker-product-config.json` | 已验证的原 startup JSON。 |
| `/__weapp/pack/<run>/<site>/portable-pack/manifest.json` | 已验证的原 manifest。 |
| `/__weapp/pack/<run>/<site>/portable-pack/blobs/sha256/<hash>` | 已验证的内容寻址 blob。 |
| `/__weapp/site/<run>/<site>/site.json` | 当前固定 stage 的原描述符。 |

run、site 和 bundle 必须与示例实际保留的身份相等，site 使用规范的正十进制 u64，
哈希使用 64 位小写十六进制。URL 不映射成本地文件路径；语法合法也不能替代原 store
的资源 allowlist。生成的 `worker-product-config.mjs`、runtime source、producer 报告及 parser 不对外服务。
`/`、旧模拟器 UI、`/api/bridge`、SSE 和 coordinator 控制入口均未开放。

新入口在原始请求上验证 `GET ... HTTP/1.1` 和一个 Host；Content-Length 只能缺省
或唯一字面值 `0`，拒绝重复长度、Transfer-Encoding、Expect、Upgrade 和已收到的尾部。
URL 不接受 query、fragment、百分号编码、反斜杠、空段、`.`/`..` 或非 ASCII 路径。
该检查只覆盖已经读入的字节，不预测后续 TCP 数据；每个响应关闭其连接。
资源响应不继承旧入口的 wildcard CORS，并发送 `nosniff` 与 `same-origin` resource policy。

<a id="owner-loop-and-exit"></a>
## Owner loop 与退出

`WebSurface::bind_resource_only` 显式启用资源队列；普通 `bind` 保留旧模拟器路由，
保留的控制命名空间在旧 OPTIONS／CORS 之前明确拒绝。resource-only 缺省也不开放控制；
受信任 owner 可在首次 accept 前通过[控制 seam](browser-control-http.md)显式启用，
本静态示例没有调用它。
同一 owner lane 按下列顺序推进：

```text
surface.poll
  → surface.resolve_resource_requests
  → surface.poll
  → supervisor.poll
  → surface.wait
```

resolver 只比对固定身份，并从同一个监督器调用 `browser_runtime_resource` 或
`browser_stage_resource`，返回原来的非 Clone borrower。它不启动新监督器、不读取
本地文件、不重新 stage/pack，也不建立第二份资源缓存或账本。待解析请求存在时，
`wait` 立即返回；嵌入方必须执行 resolver，不能只运行 `poll → wait`。

待解析请求、响应与其他连接共用原 64 连接上限。资源请求从 accept 到 owner lookup、
最终写出共用原 5 秒截止时间，交接不会续期。实际 response 持有原 runtime/stage 租约，
写出只借用原字节 slice；artifact payload 保持原费用，HTTP 仅额外记录小 header。
现有 256 KiB 写出 quantum 与 2 ms 公平调度继续推进，慢读者不阻塞整个监督器。

完整写出、断连、deadline 或释放 surface 后，响应才释放其 borrower。退休会撤销新
借用，已经在途的原字节仍阻止 stage、输入和父目录提前清理。退出先 drop HTTP surface
释放所有 socket/body，再在同一个 `DevSupervisor` 上重试 `try_shutdown()`；不能一边
保留自己的 HTTP borrower，一边等待原 owner 清空。示例在 15 秒内重试清理，超时明确
报告失败，不把 Drop 或日志当作清理完成证明。资源生命周期详见
[受管 consuming stage](browser-consuming-stage.md)。

<a id="fixed-sites-and-evidence-meaning"></a>
## 固定站点与证据含义

初次 source check 只用于取得 stage ticket，期间的原 Diagnostic 会输出到终端。stage
捕获后，示例继续推进 watcher 并打印构建诊断，但固定的 run/site/pack 不会随新源码
自动替换，也不重新检查其可发布性。后续源码变化、构建失败或新 portable 出现后，
这些 URL 仅提供旧的不可变静态诊断字节；不能据此断言它们代表当前源码或允许激活。

因此 ready JSON 明确保持 `publicationAuthorized: false`、
`sourceFreshness: "not-checked-after-stage"`、`runtimeReady: false` 和
`presentedReady: false`。HTTP 成功只证明相应字节经该传输读取。真实 Worker 启动、
preview lease、激活前 source barrier、控制回执、呈现 ACK、输入、热更新和关闭屏障
仍需分别接线与验收；静态服务不产生浏览器、CanvasKit、GPU、官方 DevTools 或七宿主
通过结论。本页不填入尚未观测的测试结果。
