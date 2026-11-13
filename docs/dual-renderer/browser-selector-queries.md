<a id="dom-selectorquery-partial-implementation-and-evidence-boundary"></a>
# DOM SelectorQuery（partial 实现与证据边界）

**简体中文** · [English](browser-selector-queries.en.md)


DOM 查询由 Rust 匹配已求值的 `ViewDocument`，浏览器批量测量当前实际可见的同一文档，再由运行时完成原 JS 请求。它不读取保留的 Skia frame，不重新执行 WXML/WXS/现代 View，也不把先前的 `view.geometry` 缓存当作调用时测量。

能力始终为 `partial`。历史编译、原生回归与真实 QuickJS Worker 查询结果按实际受测源码保存在 [controls 集成证据](../archived-evidence.md)；controls r6 的浏览器通过绑定 `4f753cab`，不自动覆盖后来的 backend/lazy 源码。固定微信版本、GPU、设备与性能验收尚未完成，冻结的 279 项发布清单不变。Remote 启动等待、IntersectionObserver 和 `pageScrollTo` 的 DOM gate 继续关闭。

<a id="negotiation-and-startup"></a>
## 协商与启动

- Worker：默认真实 DOM adapter 工厂在 load 中显式请求 `browserQueries: {version: "1.0"}`。运行时在 `app.init` 前执行 `view.query.enable`，payload 为 `{version: "1.0", scope: "session"}`。缺少契约或 native 拒绝时明确失败；注入 adapter 工厂必须显式声明同一能力，旧 fake 不会自动获能。
- Remote：初始 `onLoad` 时还没有真实预览 recipient，仍返回 unsupported。预览在实际 ACK/confirm 后，通过已有主预览 lease 发送 `{version: "1.0", scope: "presentation", key}`；该 key 退休后能力关闭，新 owner/新呈现不能继承。Remote 启动阶段的等待执行仍是后续必需项，不能宣称与 Worker 启动语义等价。
- `{version: "1.0", scope: "disabled"}` 显式撤销。成功 final 包含 `ok`, `version`, `scope`, `enabled`, `key`；HTTP 排队收据不算成功。

已协商 Worker 的 `onLoad` 可以调用 `exec`：运行时有界保存原 page/component owner、input lifetime 和首次绝对 deadline，定时器继续运行。首个合法 ACK 后才匹配其实际 `ViewDocument` 并发起测量。普通 candidate 重试不延长预算；hide、unload、逻辑 resize、manifest/session 边界、组件销毁和超时取消等待，不借用后来当前页的身份。

<a id="query-protocol-v10"></a>
## 查询协议 v1.0

运行时输出一个 `view.query.request` event：

```json
{
  "version": "1.0",
  "requestId": "dom-query:1",
  "key": {
    "sessionId": "session-1",
    "pageId": "1",
    "documentRevision": "1",
    "presentationRevision": "1",
    "surfaceGeneration": "1",
    "profile": "webview"
  },
  "afterEpoch": "0",
  "deadlineNs": "Unix 纳秒的规范 u64 十进制字符串",
  "occurrenceIds": ["Rust 匹配的 occurrence id"]
}
```

`requestId` 在 session 内严格递增；epoch 和 deadline 不经 JavaScript Number 转换。浏览器不比较不共享的时钟，最终 deadline 由 Rust 校验。选择范围由 Rust 决定，浏览器不会执行用户提供的 CSS selector。

浏览器在原事务 lane 中对当前 confirmed/interactive candidate 做一次完整 geometry 测量，并在测量前后核对相同 key、连接和主预览输入 fence。`view.query.result` 成功 payload 是 `{version, requestId, key, geometry, viewportScroll: {x, y}}`。geometry 必须包含完整文档 occurrence 集合，epoch 必须大于请求的 `afterEpoch`，且大于同一完整 key 最近原子接纳的 query measurement epoch。运行时分别保留输入 geometry 和一个有界的 query epoch 高水位，不允许跨请求或同 key 重新协商重放旧测量。若并发结果乱序，旧 epoch 整批拒绝且保留 pending，仍可在原 deadline 内以更高 epoch 重试；无效批次不推进高水位。此快照不覆盖输入 geometry/cache；下一次正常 geometry 更新仍使用单调 epoch。

失败 payload 与成功互斥：`{version, requestId, key, error: {code, message}}`。仅接纳 `ERR_RENDER`、`ERR_CANCELLED`、`ERR_TIMEOUT`、`ERR_INVALID_REQUEST`；不接纳任意宿主错误码。所有结果先验证 request/key/epoch/当前呈现/owner/取消和 deadline，完整成功后才原子移除 pending 并进入 JS。无效批次不部分执行 callback；重复或迟到结果不能二次完成。

<a id="support-scope-and-budget"></a>
## 支持范围与预算

支持现有 portable selector 子集、source order、`select`/`selectAll`/`selectViewport`、`boundingClientRect`、`scrollOffset` 和 `fields` 中的 rect/size/几何字段、id、dataset、mark。元数据保留原声明的 JSON 值；`properties` 仅支持声明中可验证的 `id`、`class`。`computedStyle`、node/context handle、input.value 等实时平台属性明确 unsupported。缺失单选保留 `null`，缺失多选保留 `[]`。

query owner 与 `.in(...)` 范围独立。两引擎捕获仍位于实例表中的同一个真实对象，回调逐个检查并同步恢复其 owner；任意 Promise/async continuation 不自动继承。销毁或 ID 复用不复活旧 owner。直接 bridge `api.call` 没有可信 JS owner，因此 DOM SelectorQuery 明确 unsupported。

Native 与浏览器同为最多 32 个请求、每个 request 256 KiB、总队列 1 MiB。Native 还限制每批最多 256 个操作及 100,000 个匹配，按序列化 wire payload、保留 options、匹配 ID 和捕获的取消 token 字节计入预算。首个 deadline 默认最多 5 秒，并受原 bridge deadline 缩短；候选重试、timer tick 和队列提升不重置它。

运行时在原 bridge turn 的首次引擎调用之前安装请求作用域，捕获其 `cancelToken`；若内部 query options 另带 token，两条 fence 任一取消都使原查询失败。首帧等待提升直接搬运首次 deadline/token，不继承后来的 ACK/result transport token 或 deadline；turn 退出后恢复原作用域，不污染下一条 bridge 消息。`cancel` 继续只更新纯控制状态，查询回调在下一次正常 owner effect drain 完成。结果完整校验及投影后、原子消费 pending 和进入 JS 之前，再次校验原 deadline 和取消状态。超过预算返回结构化错误，不退回旧缓存。

<a id="verification-status"></a>
## 验证状态

新增 Rust 用例覆盖显式协商、首帧等待与定时器、hide/unload、真正 fresh batch、输入 epoch 独立、无效/迟到结果、旧 key 不继承及不支持字段。集成审计又补充原 bridge 取消和作用域恢复、首 ACK 前取消、ACK transport 不重绑首次 fence、waiting/pending deadline、跨请求/同 key 协商重放和乱序结果可重试；32 个并发请求的 fixture 使用递增测量 epoch。这些用例的实际执行结果须按受测源码核对上述集成归档；历史结果不代替当前提交自己的完整回归。

先前隔离分支的 Node 记录位于 `artifacts/browser-selector-node-20261025-r2/`，归档到 `docs/evidence/2026-10-25-dom-selector/`：23 个测试文件执行期间 24 个变更文件的源码哈希一致，1,012 项通过；既有 mixed renderer smoke suite 因该 checkout 缺少 `acorn` 无法加载，未安装依赖或把它记为通过。初次运行的 1,005 项通过及相同依赖阻塞也原样保留。这些历史结果不覆盖后来集成和 fence 修复后的源码；集成审计需重新绑定最终源码与原始日志。Node 用例验证协议和提取的 JS bootstrap，不代表原生 QuickJS/V8 执行通过。后续 native、实际 Remote/Worker 测量与性能结果须绑定最终源码另行保存，不能用 Node fake 取代。

<a id="explicit-real-time-worker-query-smoke-entry"></a>
## 显式真实 Worker 查询 smoke 入口

`scripts/browser-dev-loop-smoke.mjs` 可追加 `--server-kind cli --renderer webview --dom-queries true`。仍须显式提供 `--server-bin`、`--producer-dir`、`--pins`、`--node-bin` 和一个全新的 `--out-dir`；脚本不会构建 runtime、生成信任 pins、复用已有预览或把运行失败覆盖为成功。默认不启用查询检查，Skia／context recovery 流程不启用此参数。

fixture 在真实小程序 `onLoad` 内调用 `wx.createSelectorQuery().select('#tap').boundingClientRect()` 和 viewport `scrollOffset`，首个 `exec` 回调再创建第二个查询。无 `setData` 夹在两次测量之间，以验证回调原实例归属、同一 presentation key、独立 query epoch 及不变的输入 epoch；第二次回调才 `setData`，并等待真实后续 accepted 文档显示状态。`onLoad-return` 必须早于查询回调，零延迟定时器须实际运行，不要求其与首 ACK 的调度竞态有固定顺序。

已呈现页面的真实 increment 点击改变布局；随后对实际 `#tap` 加入测试专用 `translateX(13px)`，在同一 accepted key 上经真实 tap 再调用 `wx` 查询。返回坐标须与独立读取的浏览器 DOM 一致，且反映输入几何缓存尚未包含的 13px 位移。浏览器测量只用作独立 oracle 和测试扰动，不能替代 `wx` 调用或提交伪造的 query result。

审计只观察原 Worker 的实际 send/event/final，按 owner/session/key/request id 关联原生协商、呈现 ACK、query request、完整测量、原生结果和后续 accepted proof。记录最多 512 条、每条 256 KiB、总计 2 MiB；任何截断、超时、拒绝、错误或无法证明的边界都会使 smoke 失败。热更新、构建失败保留和 Stop 的原资源归属／关闭门禁继续执行。`dom-query-*.json` 保存各次闭环事实，最终报告保存统一清理结果。

本入口已在 controls r6 的真实 QuickJS Worker 开发循环执行：`4f753cab` 保存 15 组查询 proof 与对应原始观测，并完成 12 次更新、13 个实际 Worker 的关闭及原服务清理；早先失败尝试原样保留。相应 Node 用例只验证测试入口、bootstrap 与报告校验器，不替代这些真实观测，也不授予官方等价性、硬件、性能、其他引擎或宿主通过。
