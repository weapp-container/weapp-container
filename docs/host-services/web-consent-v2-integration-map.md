Web consent v2 接入只读映射（尚未实现）

读取基线：主仓库 `281070dc6c28f07228017d9e98e600633d617c23`；工作目录 `/path/to/weapp-container`。以下位置按此次源码读取记录；未运行浏览器、未修改源码、未执行新的验收。本文件中的新方法名均为待冻结的接口建议，不能视为现有可调用 API。

当前后端已有真实 `/v2/host/*`、challenge/CAS、持久 revision 和严格 app 门禁；Web 客户端及 runtime 仍为旧路径。必须共同补齐“后端原子决定、宿主跨实例协调、runtime 最终交付”三段，单独替换 HTTP URL 不能兑现撤回语义。

**现有链路和已确定的缺口**

| 位置 | 现有行为 | 最小必要改变 |
| --- | --- | --- |
| `reference-identity-client.mjs:108` 的工厂、`run` | `activeScopes` 在工厂内；key 包含 epoch；active 降到零就删除。不同 client 对象、不同模块版本及重建 owner 没有共享代际。 | strict v2 必须接入宿主根对象提供的同一个协调器；实例本地 map 只能保留调用计数，不能承担持久授权 fence。旧 v1 单独显式选择。 |
| 同文件 `capture/request` | 可信 app 校验包含 publisher，但发往后端的 selection 只有 miniAppId、packRoot、principal 和 epoch。 | v2 selection 加 `expectedPublisherId`；不能把整个 app、call context 或 guest payload 展开到严格请求中。每条路由按字段白名单组包。 |
| 同文件 `authorize/disclose/state` | v1 purpose/version 确认；v1 consent 写入；前后比较 opaque authorizationVersion。`run` 最后是无 kind 的 `guard()`。 | 精确协商 v2；challenge/expectedRevision/decisionId；按 kind 精确 revision 披露；最后的 action 返回、Promise continuation 仍检查具体 kind，而非仅 signal。 |
| `browser-host-services.mjs:244–296` configure | 异步初始化文件，读取初始 identity state，再 await battery/permission，最后构造 syncValues 配置。preflight context 的 sessionId 固定为 `native-preflight`。 | 创建 owner 前登记 admission；准备过程携带共享 authority 版本；每次 await 后校验；app.init 前安装当前 fence 和投影快照。preflight 标识不能冒充实际 session/incarnation。 |
| 同文件 `setApplicationIdentityState/#applyIdentityState:318–326` | 外部更新增加本实例 `#identityHostRevision`，随后分别排 snapshot 和 IdentityChange；无 per-kind backend revision。 | 增加 host-only、带来源类型的 authority 更新入口；普通观察与权威撤回分开；先 fence，再状态投影。保留旧方法的 legacy 行为，strict 模式不能用四个布尔值提升权威代际。 |
| 同文件身份 handler `703–751` | handler 返回后 refresh；本实例 revision 冲突最多重读三次；有 getState 才验证授权。失败后刷新保留原错误，这点应保留。 | 包括 custom provider 在内，捕获共享 kind stamp；每次 await、刷新接受和返回都检查。getState 缺失不能让 strict 自定义 handler 绕过 fence。 |
| 同文件 `#start:516–543` | handler 在 Promise continuation 开始；成功/失败再进入另一组 `.then/.catch` 后入队。signal aborted 时静默不结算。 | 区分 owner 退休和存活 owner 授权失效；在 handler continuation、成功入队前及实际入 native 前都核验 stamp。授权失效必须生成一次失败，不能复用会使 catch 也被跳过的 owner-abort 判断。 |
| 同文件 `#enqueue/#emit/drain:337–505` | completion 只有 callId/data；snapshots 只有 values；IdentityChange 没有 authority stamp。drain 每项前会 await takeNativeRequests，随后再 await native.complete/snapshots/event。 | 所有敏感队列项携不可变 host-only stamp；异步间隙后重新核验。snapshot/event 失效可丢弃/替换为新投影，completion 失效须保留终态预算并转换为失败。 |
| `worker-host-services.mjs` | 捕获 configuration 并在 load 前转交；activate 仅验 hostServices 1.0；native.complete/result、snapshots、event 都不传 fence；adapter 只会整 owner revoke。 | 完整透传 requirements、初始 authority、context/completion/event/snapshot witness 和独立 fence/ACK 命令。activate 必须拒绝缺少新能力的 runtime。 |
| `worker-web-session.mjs:334–345,1211` 与 `worker-runtime.mjs:1183–1199,1429–1457` | hostServices 作为 load 配置复制；native op 使用显式 allowlist；Worker 在 app.init 前配置 native。 | 两端 allowlist、参数白名单、observed RPC 和 actual-final 处理同时扩展；不能借 guest bridge 路径传 authority。配置、协商或 owner 注册失败须停止启动并排空。 |
| `browser-host-account-manager.mjs:51–160,190–236` | host/tenant 域账号管理、epoch 提升和旧 owner drain 已存在；factory 收 incarnation/storageScope 等；不持有授权协调器。 | 注入宿主根协调器并把同一个对象传给每个 owner/client；注册/注销 owner 参加共享 fence ACK。保留账号 epoch 和 consent generation 两套独立语义。 |
| `container-runtime/src/host_services.rs:99–125`、`container-host-web/src/lib.rs:472–516` | config/context 均 deny_unknown_fields；Completion 仅 result/error；当前没有 consent requirements/context。 | 正式冻结兼容 JSON 扩展与 Web WASM exports；旧 runtime 拒绝 strict requirements，不能删除字段后重试。 |
| `container-runtime/src/async_host.rs:412–431,564–617`；QuickJS `src/lib.rs:1515`、V8 `src/lib.rs:1444` | Rust 完成后调用 `__container_resolve_api`；JS 先删 pending，然后在 `Promise.resolve().then` 捕获旧 result，再 success/fail → complete → resolve/reject。 | Rust 队列核验之后，真实 JS 披露微任务入口仍须核验不能由 guest 篡改的 fence。只改 Rust 完成入口无法撤回已经排队的 JS closure。手机号按钮的 finish/event 分支同样需要检查。 |

**共享域、对象归属和最小 host 接口**

持久域 `D = [hostAppId, tenantId, publisherId, principalId, appId, environment]`；每 kind 的 `C = [D, profile|phone]`。`version`、`packRoot`、epoch、sessionId 不进入持久 consent key；可信安装仍在每次执行验证。执行绑定 `E` 单独包含 D、epoch、实际 sessionId 和 owner/incarnation。用户换号提升 epoch、退休旧 E；同用户新 epoch 可读取仍有效的 durable grant，旧 challenge/code/调用不得跨过。应用退出保留 consent；删除用户才清理相应 durable 域。

同宿主内所有 client 实例、合法升级版本、direct/Worker owner 必须取得同一协调器；不能每个 createReferenceIdentityClient、manager 或 URL 副本各建一个 map。建议由 host root 注入受协议约束的共享对象，strict v2 缺失该对象立即拒绝。若允许多个 manager，它们也必须使用同一 host/tenant 根 registry。不要以 endpoint URL、包版本或新 epoch 切断同一持久域。仅用模块级变量还会因重复 module URL/不同 bundle 版本产生第二套状态。严格域中若已有不能参与 fence 的 v1/旧 runtime owner，必须拒绝其 strict admission 或先完成退休/重建；不能让它保留缓存披露队列、从 ACK 集合中省略，再声称“所有 client 已撤回”。legacy fixture 可继续运行自己的显式 legacy app，但不获得新撤回保证。

最小协调器语义可归并为五类接口，具体命名待 runtime wire 一起冻结：

1. `attachOwner(E, requirements, nativeLane)` 返回有界 registration；owner 进入 app.init 前必须安装并 ACK 当前 authority。`detachOwner` 只释放这个 E，不删除 C 的 revision。close 等待本 owner 的 fence/mailbox 终结，不等待整个宿主所有 owner 关闭。
2. `capture(C,E)` / `assertCurrent(ticket)`：ticket 保存 kind 本地 generation、后端 canonical revision、权威通知 generation 和 owner incarnation；不存 bearer/challenge。原生 pending call 的 stamp 必须由可信 runtime context/host admission 导出，不能从 payload 生成。
3. `observeState(E,envelope)`：校验 v2 identityProtocol、per-kind revisions、expiresIn 和白名单公开 state；按 BigInt 比较 revision、以单调时钟维护本地 expiry；普通 refresh 不能提升权威通知 generation，也不能覆盖更晚撤回。版本冲突只在原 deadline 内有限次重读。
4. `beginRevoke(C)` / `commitRevoke(operation,backendReceipt)`：调用 begin 时同步提升本地 kind generation，失效所有旧弹窗/请求/排队项；向所有关联 native owner 安装 fence；再提交后端 revoke。future 仅在实际 owner ACK、后端提交、投影完成后成功；部分失败保留 blocked/pending/failed 与重试阶段，不能重新启用旧 ticket。
5. `adoptOwnGrant(ticket,decisionReceipt)`：仅在 generation 未变、decisionId/challenge 对应当前操作、receipt revision 为协调器认可的当前值时接纳自身新 revision。不能遇到 2xx 就覆盖预期值，也不能把被撤回的旧 grant receipt 当作一次普通 refresh。

reference provider 现有公开 handler 名称可以保留。需新增 host-only 准备/读取 authority envelope 与 revoke/refresh 操作，让 BrowserHostServices 得到内部 revisions，而 guest `getState` 仍只看到四项布尔、不透明 authorizationVersion 和已授权公开 userInfo。可用独立 `getStateEnvelope/prepare/revoke` 方法或等价受类型约束协议；不要把内部字段塞入 userInfo 或给所有 caller 返回 raw backend object。严格模式下还应收紧 BrowserHostServices 的 userInfo 白名单：当前自定义 provider 的 userInfo 会 safeValue 全量复制，只有 reference provider 自己做 nickName/avatarUrl 投影。

账号 manager 的 owner factory 应重放同一协调器、requirements 与 provider 配置，而非把协调器序列化进 launchOptions。`replace()` 的旧 owner drain → factory → start → waitForPresentation 边界继续沿用；factory/start 任一失败保持阻塞。same-user refreshCredentials 不重启，也不删除 consent。logout 仅退休 app owner；当前 reference `change:logout` 的实例计数不能直接改成持久 profile/phone revoke。

**v2 客户端 wire 的最小变更**

| 操作 | 必须做的处理 |
| --- | --- |
| prepare/capabilities | 对可信 selection POST `/v2/host/identity-capabilities`，精确要求 identityProtocol 2.0、consentRevision 1.0、scopeSchema 2.0、profile/phone 和 256KiB 限额；404/缺字段/旧协议为不支持，不尝试 v1 grant。匿名 host snapshot 不取 token、不发 HTTP，但不能因此免除 runtime requirements。 |
| state | `/v2/host/identity-state` 精确解析 consentRevisions 两个 canonical u64 字符串（允许零，拒绝数字/前导零/溢出）、consentExpiresIn 和公开 state；authorizationVersion 只当 opaque。返给 guest 前剥离内部协议/expiry/revision 数据。 |
| policy/UI | `/v2/host/authorization-policy` 校验 kind、purpose、permissionVersion、revision、challengeId、expiresIn；challenge 只留 host realm。确认 UI 只需要显示 policy 与可信 app，通常无需看到 challenge。每次 await/决定后重查 ticket 与 expiry。 |
| grant | 宿主生成至少 128 位随机 decisionId；提交原 challenge、expectedRevision、purpose/version 和 granted:true。响应丢失只能用同 decisionId、同 body 核对；不能生成新 ID 自动重新同意。428、challenge/policy/409 冲突使本次失败，重新展示新 policy 才可再 grant。 |
| deny/revoke | granted:false 不携旧 challenge/revision；相同 decisionId 精确重放；本地先 fence，后端提升 revision。拒绝后的状态刷新尽力执行但不能替换原 errCode/errMsg/backendCode。 |
| profile/phone | `/v2/host/profile` 和 `/v2/host/phone-codes` 带 expectedConsentRevision，校验 identityProtocol、kind、revision 与 ticket；state 前后检查只能作观察，不能替代 stamp/CAS。只给 guest 公开 userInfo 或一次性 phone code。 |
| login/check/logout | 后端目前仍保留 `/v1/host/login-codes`、`check-session`、`app-logout`；没有相应 v2 路由，不应生造或机械改 URL。其 selection 白名单与 v2 分开，不能把 expectedPublisherId 自动加给严格拒未知字段的旧路由。操作后的状态刷新走 v2 authority。 |
| business exchange | `/v2/apps/profile` 为 POST；`/v2/apps/exchange-phone` 使用业务 confidential client 和 appAccessToken。这些继续留业务后端，Web 客户端不拿 clientSecret/最终手机号来替代 button code。 |

hostToken、issuer/client secret、challengeId、decision body、原始 policy envelope 都不能进入 guest、Worker load config、RPC event、URL、日志或错误 details。Worker 可得到公开投影、requirements 与不含秘密的 fence witness；challenge 和 host bearer 必须留 UI 所在 host realm。当前 backendError 会收集响应扩展字段，strict v2 应对白名单公开错误字段投影，避免新 challenge/revision 调试字段被透传给 guest。

**runtime 和重建的必需合同**

保留 base hostServices 1.0 和既有 C ABI；新增精确 `consentRevocation:1.0` capability 及 `hostServices.requirements:{consentRevocation:"1.0"}`（名称沿现有设计，仍需冻结完整 schema）。还需定义：初始 per-kind authority、call context stamp、completion witness、snapshot/event 的 authority vector，以及 host-only apply/fence 命令的 operationId/阶段/终态/ACK。不能把 authority 更新伪装为旧 `native.snapshots`。

需要同时变更 HostServicesConfig、normalize/configure、HostApiCallContext、HostApiEvent/Completion、WASM host exports 和 host_services_protocol_json；Web direct 和 Worker adapter 都校验并透传。旧 Completion 的 deny_unknown_fields 意味着不能今天先发新 witness 然后假装旧 runtime 接受了 fence。snapshot native provider 在同步读取时也要验证当前 authority，不能用等待异步 UI/HTTP 的办法实现同步状态。

Worker 的 `nativeHostServices` allowlist、WorkerRuntime execute switch、WorkerHostServicesTransport 和 load/activate handshake 必须一起更新。新命令要走 trusted native lane，不向 `session.request`/guest bridge 开放。命令取消不等于底层 fence 未执行；保留 actual final，撤回失败可查可重试，close 不吞掉未 ACK 的操作。有限队列的溢出不能丢弃安全 fence 或唯一失败终态。

每个 Worker 有独立 WASM instance/内存，不能把 Rust static 当作跨 Worker 共享授权表。共享 coordinator 在 host realm 维护 D/C，再为每个真实 owner 安装并等待本地 runtime barrier。已经在 Worker 执行的同步 JS 不会因 main realm 一个 map 自增而自动停止；需明确撤回的线性化点以及已排 native.complete/JS microtask 的最终核验机制。若要求“beginRevoke 返回的同一同步瞬间起，其他 Worker 已执行中的旧 JS 也不可见任何数据”，现有异步 postMessage 不能证明，需要额外共享 authority/调度屏障设计，不能只写两个 Map。至少不能在所有 ACK 到达前宣称撤回 future 成功。

预加载有一个独立窗口：services.configure 读取旧 state → battery/permission awaits → 返回捕获 config → session.load 下载/初始化 → Worker configure → app.init 可同步读取旧 userInfo。只在 load 返回后 activate/refresh 已经太晚。应在 start 前注册 candidate、携 current stamp 并使重载/热更新重放 requirements；必要时将 native inert-load 与 app.init 拆成明确 admission 两阶段，或采用经验证的等价 barrier。重建不得把 requirement 丢掉或把最新 fence 归零。旧 owner cleanup failure 时，新 owner 保持 blocked；不恢复旧 snapshot。

各个敏感边界最少应为：入口/原生 request 入队；hostToken await 后；fetch/每次 reader.read 后；policy 与 UI await 后；grant 发送前和 receipt 后；disclose/state await 后；snapshot 应用前；handler 成功 continuation；completion/event/snapshot 入 host 队列；每次 drain await 后；native command 真正执行；Rust complete/phone/button/event；最后真实 JS 披露微任务。callback option getter、toJSON、success/complete callback 重入和微任务也不能略过。`__container_resolve_api` 当前提前删除 pending 的行为需配合新的单次结算状态，不能 fence 失败后既找不到 pending 又不释放预算。

必须单独定义一次结算的不可逆点：success callback 已读过资料后不能声称撤回使它“从未发生”；success callback 内发起 revoke 时，随后 complete/Promise 的规则需冻结并测试，不能同时返回一次成功又追加一次 fail，或错误地复活原 Promise。撤回前尚未进入成功披露的活 owner，必须 fail → complete → Promise rejection 一次终结；owner 已退休则沿现有关闭路径禁止旧 JS。当前 controller.signal aborted 分支只适用于后者，不能覆盖前者。

UI 与 HTTP 的实际资源终结也需独立记录：现有 wait(promptPromise,signal) 仅使等待者拒绝，不证明原生 prompt 已 dismiss。strict presenter 应提供可取消和可等待的真实关闭回执（或等价受约束接口），close/revoke 跟踪该回执，保留失败重试；不能把永久 pending 的旧 UI promise 丢掉后视为已清理。

**公开链路测试点与保留内容**

所有下表均是待补测试，不是已通过记录。fake 单元测试只证明协议/生命周期；归档真实 QuickJS/CanvasKit、button/UI、硬件分别记录。

| 层级/入口 | 必须构造的竞争和断言 |
| --- | --- |
| reference client + 真 HTTP/SQLite | v2 精确协商；未知字段/数字 revision/旧服务拒绝；grant CAS、policy 更新、到期、同 decision 重放、grant receipt 迟到；所有响应与日志无 token/challenge/secret。 |
| 两个 client、两个 manager/owner、两个合法 pack | 同 D 同 kind revoke 阻止另一个实例披露；epoch/pack/version 不分裂持久 fence；phone/profile 分离；publisher/app/user/environment/tenant 不同不互相撤回。 |
| 授权弹窗 | UI 决定前撤回、决定后 grant 发送前撤回、grant 事务前 gate、提交后 receipt gate；旧“允许”不能重新授权。实际 dismiss/终结另有证据。 |
| 资料/phone 生成后响应 gate | 先让真实服务生成响应，再 revoke，再放行；活 owner 一次 fail/complete/Promise reject；无 userInfo/code 成功、旧 IdentityChange 或旧 snapshot；phone 业务后端兑换也失败。 |
| getState/refresh | 两个观察响应乱序、旧 authorized state 迟到、权威撤回先于普通 refresh；expiry 接近零；有限次数冲突重读不延长 native deadline。 |
| BrowserHostServices completion 队列 | handler 已返回后，成功入队前/队列已有 success/drain 等 native.take 时/异步 native.complete 等待中分别撤回；completion reservation 释放且 controller 不泄漏。不得仅检查 handler await 内的 case。 |
| 自定义 identity provider | 无 getState 或自定义 registerApiHandler 的 disclosure 也受 strict runtime fence；缺 coordinator/requirements 拒绝；原始错误后刷新再失败保留原始 errCode/errMsg。 |
| 真实引擎 | QuickJS 和 V8 的 resolver 已排微任务后再 revoke；callback getter/toJSON/reentrant success/complete/Promise 顺序；不允许 duplicate settle 或永悬。WASM Web 只可声称实际使用的 QuickJS，V8 需另跑 native 真实引擎。 |
| direct 公开 SDK | 已安装新归档 → BrowserHostServices → WebWasmHost configure/host request → 真实 guest API → host queue → WASM complete/event → 真 JS 结果。不是直接调用 provider 返回值。 |
| Worker 公开 SDK | 已安装新归档 → loadBrowserHostServices/WorkerWebSession → WorkerRpc/native trusted lane → WebWasmHost → QuickJS → host callback → native.complete/fence → JS；确认 postMessage 从未含 host token/challenge/client secret。 |
| 真实手机号按钮 | 原页面 button open-type=getPhoneNumber → 接受的布局/输入 → native.phone → runtime target → host authorizePhone → bindgetphonenumber；撤回时旧 button result 不能落到新页面/owner。不得增加 wx.getPhoneNumber。 |
| preload/热更新/恢复 | configure 的 state 生成后撤回；下载/wasm初始化时撤回；两阶段 admission；owner factory 重建完整 requirements；旧 runtime 1.0 缺 fence、失败重载/清理重试不静默降级。 |
| 账号与关闭 | Alice→Bob、同用户新 epoch、app logout、delete、连续换号、credential refresh；旧 epoch 请求/code/challenge 拒绝，durable grants 策略一致；close 与 revoke 并发保留真正 native ACK/终态。 |

现有 `reference-identity-client.test.mjs:35` 与历史 browser/account scopes 已明确注册 `identityProtocol:"1.0"` 的 legacy backend fixture，应保留其用途和历史证据。将新工厂默认切 strict v2 时，旧 client fixture 也应显式选择 v1，而不是把整套测试 silently 升成 v2 或自动 fallback。新增独立 v2 fixture 和上述 gate，旧接口的 session/login/logout、公开错误投影和 once-settlement 回归继续运行。已锁旧归档和既有验收不覆盖写。

建议实施次序：先冻结 runtime requirements/context/fence/ACK 和真实 JS 微任务结算 schema，再实现 host root coordinator 与 direct/Worker transports；接 v2 reference provider；补 preflight/重建/自定义 handler 路径；运行有限生命周期与真 HTTP/SQLite测试；最后以同一 clean C 构建新归档，从公开链路跑 direct/Worker 与真实按钮/UI 验收。此映射本身不提升任何 API 或 goal 完成状态。
