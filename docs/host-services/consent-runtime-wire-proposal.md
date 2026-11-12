# Consent revocation 1.0：下一批运行时与 SDK wire 提案

状态：**设计提案，合同修订中，尚未完成实现、尚未验收，不 advertise 能力**。仅补充现有 `docs/host-services/consent-revocation-design.md` 的运行时合同，不改变完整 API 矩阵或任何验收状态。下文 capability 是拟议合同，不能当作当前可用声明。

源码核对基线为主仓库 `281070dc6c28f07228017d9e98e600633d617c23`。共享工作目录仍在变化；实现前以最终干净提交复核引用。本修订纳入[独立审查记录](../archived-evidence.md)的 5 项合同修正；该记录审查的是原始提案，不是本修订的通过记录。本文未执行新的运行时测试、未操作浏览器、未提交或推送。

## 0. 下一次最小完整实现批次（先不改各 SDK 版本）

建议把下一批限定为 **runtime schema + 现有 Rust manager 的共享 fence + core/两种引擎异步最终 claim 与逐次同步身份 gate + 真实 QuickJS/V8 验证**，包含必要的 `container-sdk` Rust command 路由/manager plumbing；不同时更新 Android/iOS/Desktop/Flutter/RN 发布版本、锁、归档或消费者。Web/Worker 最终 broker、各平台 HTTP v2/UI/future、产物安装与真实 SDK 验收列为后续批次，不能因本批有限测试提升它们的验收状态。

本批的完整边界是：受保护调用从 runtime 入队、共享撤回、原生完成、settling、微任务 claim、一次终态、owner retirement 全链路可执行；strict wire 与 old-runtime拒绝行为冻结，manager操作可查询且清理失败保持blocked。协议 schema可先全量冻结，但未完成的 transport组合拒绝严格配置，不能先advertise已启用。证据和 main 推送门禁未结束前只保留本提案，不修改上一批 source closure 的产品文件。

当前工作分支已开始实现其中的原生基础层：`NativeConsentAuthority`、有界
`NativeConsentDelivery` 和 QuickJS/V8 的最终 claim hook。它们还没有接到 Session、
共享账号 manager、同步身份读取、手机号组件或 SDK command。本文的 JSON 命令、
requirements 和 capability 仍是提案；不能用这些原语的有限测试推断公开链路已可用。
旧 C/T 验收 ledger 已按原字节保存，新源码待新归档真实执行后再登记。

## 1. 必须保持的边界

- 保留 C ABI `1`、host-services base `1.0`；新增 JSON requirement、context、命令及内部 continuation，不变更既有 C 符号签名或结构布局。
- 复用已有 `HostAccountManager::for_domain(hostAppId, tenantId, account)`。授权协调器属于这个共享账号域，不建立第二套账号 epoch 注册表。
- 同一宿主/租户内，同一用户、publisher、app、environment 的 profile/phone 各自共享 fence；合法版本/包升级保持该持久域，执行 owner 则仍校验完整已接受包、epoch、session 和 incarnation。
- 活 owner 的授权失效必须一次结算为 fail → complete → Promise rejection；已退休 owner 延续既有静默取消与资源排空，不运行旧 JS。
- 普通 snapshot 更新不是授权命令，不能授予、推进 generation 或解除撤回阻塞。runtime 的最终检查不能仅信任 SDK 转发的 JSON fence。
- revoke 的返回值区分“已受理”和“撤回完成”。只有共享准入关闭、所有关联 owner 的边界/投影安装完成、后端提交及真实资源终结均完成，native revoke future 才成功。

## 2. 现有源码归属与为什么不能只修改 current()

以下路径均相对 `/path/to/weapp-container`：

| 位置 | 当前事实 | 必须落下的更改 |
| --- | --- | --- |
| `crates/container-runtime/src/host_services.rs:98` | `HostServicesConfig`、`HostApiCallContext` 使用 `deny_unknown_fields`；配置目前只有 application/account/apis/syncValues | 新增精确 requirements、consent context；保留旧 runtime 对未知 requirements 的拒绝 |
| `crates/container-runtime/src/host_services.rs:1552` | configure 只允许 app.init 前执行，验证已接受 pack root 并安装 provider | 要求授权协调器已绑定；严格模式初始为 unknown/blocked，不能由旧 syncValues 注入 userInfo |
| `crates/container-runtime/src/host_services.rs:1608` | snapshot 更新可直接覆盖 replay config.syncValues | 对受保护身份投影使用独立、带 observation/fence 的命令；普通入口不得覆盖它们 |
| `crates/container-runtime/src/host_services.rs:1743` | call context 由 runtime 的真实 pending call 铸造，包含可信 application/account/session/callId | 同处捕获协调器生成的 consent fence，并保存于 pending，不采用 guest 参数 |
| `crates/container-runtime/src/async_host.rs:435` | finish 先移除 pending，再发布 API_RESULT 并调用 engine resolver/phone event | 将“原生完成”与“guest 终结交付”分开；live revoke 同样能替换已排队、尚未 claim 的成功 |
| `crates/container-runtime/src/async_host.rs:564` | rich completion 在 owner turn **之前**校验资源并物化二进制 | 在物化前核对 fence；敏感结果在 terminal claim 前留 native，有界保存并可撤回 |
| `crates/container-engine-quickjs/src/lib.rs:1515` / `crates/container-engine-v8/src/lib.rs:1444` | resolver 删除 JS pending 后，用 `Promise.resolve().then(...)` 延后执行 success/fail、complete、resolve/reject | 必须覆盖这个微任务窗口；只在 Rust finish 前检查不充分 |
| `crates/container-core/src/host-bridge.js:435` | wrapper 在调用原 resolver 前 decodeNative | 严格保护调用的结果由 terminal claim 返回，再解码；不能提前把失效二进制展开进 JS |
| `crates/container-runtime/src/engine_turn.rs:163` | owner turn 有嵌套执行预算与故障边界，但没有共享 consent admission | 准入 permit 的生命周期覆盖实际披露微任务至当前执行段结束；故障/退休释放 permit 且不继续旧 JS |
| `crates/container-sdk/src/account.rs:15`、`:114`、`:218` | 共享 AccountState、host/tenant registry、准确 application scope 撤销已存在 | 增加按 durable scope/kind 的授权状态、关联 owner、operation；保留现有 account/app retirement |
| `crates/container-sdk/src/lib.rs:1134` | app logout 成功先撤销 application scope，再 poll owner replacement | 不把 kind revoke 接到此退休路径；kind revoke 应保留 owner 和其他权限 |
| `crates/container-sdk/src/lib.rs:2103`、`:2572` | native snapshot 有可信 owner 检查，但没有同 owner 内 consent 次序 | 沿用 owner 验证，另加不可省略的 observation/fence；不是要求旧 call 仍 pending |
| `crates/container-sdk-ffi/src/lib.rs:19`、`:262` | ABI_VERSION=1；session_command 已支持 op/payload JSON | 复用该通道，新增 command 路由和纯查询白名单 |
| `crates/container-host-web/src/lib.rs:472`、`:492`、`:563` | Web 直接调用 runtime，而不经过 container-sdk；completion schema 同样 deny_unknown_fields | 显式支持新增 schema/commands，不能只改 native SDK |
| `examples/hosts/web-wasm/worker-runtime.mjs:22`、`:1431`、`:1451` | HOST_OPS 白名单、owner 串行 lane、native.complete/native.snapshots | 单独增加 host-only consent 操作及控制配额；不能由 guest bridge mint fence |
| `examples/hosts/web-wasm/browser-host-account-manager.mjs:52` | 已有稳定 controller、可替换 owner 和同步账号撤销 | 增加同域 consent coordinator，关联所有 direct/Worker owner，不再使用每 client 私有代际作为总边界 |

这里最容易漏掉的是 **Rust 已完成，但 JS 回调尚在微任务队列中** 的状态。新合同必须覆盖 `pending → settling → claimed → terminal`，而不是仅覆盖 `pending → removed`。

## 3. 版本协商与严格配置

新增 capability：

```json
{
  "hostServices": {
    "protocolVersion": "1.0",
    "consentRevocation": "1.0",
    "consentRevocationScope": "associatedOwners",
    "consentDeliveryClaim": "1.0"
  }
}
```

含义：`associatedOwners` 覆盖同一 host/tenant 根 registry 中同 D 的**全部实际 owner**，包括不同版本、候选 owner、legacy/旧 runtime 和 direct/Worker；不能按是否实现 hooks 缩小集合。每个 owner 在 app.init 前必须登记，严格配置先核对整个 D 的现存 owner：无法参加同步 gate、最终 claim 和真实 ACK 的 owner，必须先退休并完成实际排空、再按新合同重建；此前拒绝该 D 的 strict admission。缺少完整 owner 登记/清点本身也不能启用严格配置。legacy fixture 可保留在明确独立的 legacy 域，不获得新保证。

此范围不等于任意其他进程/设备的即时撤回。SDK 还应公开当前 runtime/transport 实际启用状态；未完成 binding、逐次同步 gate、最终 claim 或全 owner 门禁的组合不能 advertise 可用。普通异步 Worker broker 不满足本提案的 `consentDeliveryClaim:"1.0"`，详见 §9。

严格配置只增加：

```json
{
  "application": "<既有完整 TrustedApplication 对象>",
  "account": "<既有 HostAccount 对象>",
  "apis": [],
  "syncValues": {},
  "requirements": { "consentRevocation": "1.0" }
}
```

- 例中的字符串仅用于省略既有对象，不是有效生产配置。
- 新 `HostServicesRequirements` 同样 `deny_unknown_fields`；当前只接受精确字符串 `"1.0"`，未知版本或 requirement 失败。
- requirement 缺省保留历史合同。启用严格参考身份 provider 必须带此 requirement；不能因旧 runtime 失败而删字段重试，也不能回退 v1 后端。
- 旧 runtime 对 `requirements` 的未知字段拒绝即 fail closed；不要在 SDK 预处理时删掉字段。C ABI 版本通过不代表该扩展通过。
- configure 时检查支持的底层 hooks、逐次同步身份 gate、coordinator binding 和同 D 的全 owner 门禁；缺少就报 `ERR_PROTOCOL_VERSION`，不能先允许 app.init 再补 fence。已登记但无法参与的 legacy owner 未退休排空前同样拒绝。
- `syncValues` 不承载 generation/revision/challenge。严格模式中，身份的 profile/phone 授权与 userInfo 投影只能由下述受保护入口建立；错误配置明确拒绝，不能静默截断 userInfo 后当作成功配置。

## 4. 域、数字与 runtime 内部 authority

```text
D = (hostAppId, tenantId, publisherId, principalId, appId, environment)
C = (D, kind)                       kind = profile | phone
E = (accepted TrustedApplication, account.epoch, sessionId, ownerRevision)
```

- principal 为 null 时不能建立已授权的 C；披露返回未登录错误。
- `scopeId = lowercaseHex(SHA256(UTF8(JSON.stringify(["consent-scope-v1",hostAppId,tenantId,publisherId,principalId,appId,environment]))))`，只作关联标识，不是权限凭证。D 由 manager 绑定的可信配置和当前账号计算，任何 command 都不能靠传入 scopeId 选另一个域。
- `generation` 是协调器的每 C 本地、单调撤回代际；`revision` 是 v2 后端的每 C 持久版本，二者不可互换。scope state 在关联 owner 存活时不能被删除后重置；状态重新建立须使用新的 coordinator binding/owner registration。
- generation、revision、ownerRevision 以及计数全部使用 `"0"` 或不带前导零的十进制 u64 字符串，禁止 JSON number、double、回绕。generation 耗尽后永久阻断该绑定，要求新协调器/owner，并保留 pending 清理。
- `authorizationVersion` 仍是 opaque guest 状态标识，绝不排序、作为 CAS 或作为 generation。
- runtime 定义小型 `ConsentAuthority` trait/handle（runtime 不能依赖 SDK），SDK manager 提供实现。handle 提供 register-owner、capture、begin-revoke、claim-delivery、claim-identity-snapshot、release-turn、owner-ack 等受限操作。runtime 持有绑定 handle；JSON 不能替代这个关联。
- shared manager 的 Mutex 只保护短状态转换，不在 JS、UI、HTTP、await、资源取消或 owner ACK 等待期间持锁。通过逻辑 admission permit 和 owner lane 完成跨线程屏障，不用持写锁阻塞等 JS 返回。

每 C 状态至少包含：`generation, backendRevision?, granted, authorityStatus, activeRevocation?, latestRevocation?, cleanupPending, owners, admittedTurns`。`authorityStatus` 为 `uninitialized | current | fenced | reconciliationRequired`。后端 revision 未初始化时不允许敏感披露；同步接口按 §7.2 立即生成安全快照，不等待网络/UI。

本地撤回和重新授权采用以下唯一转换，不允许凭 generation/revision 相等推导额外转换：

| 原状态 | 接纳条件 | 新状态及准入 |
| --- | --- | --- |
| `uninitialized` | §6.1 的首次可信初始化，期间无本地撤回 | `current`；仅有效 grant 可披露 |
| 任一状态 | 新的 begin revoke | generation 递增，`fenced`、false、关闭披露和新 grant 决策准入 |
| `fenced` | 最新 revoke 的后端提交、全部 owner 边界/安全投影 ACK、已入场 permit 和实际资源排空全部完成 | 原子记录最新 operation/attempt 为 complete，清除 activeRevocation，进入 `current(false)`；generation 不回退 |
| `fenced` | 后端、owner 或 cleanup 失败；或某项仍 pending | 保持 `fenced(false)`，可查可重试；不得 prepare/commit grant |
| `current` | 无未终结 revoke、无 cleanup 债务；若曾 revoke，最新 revoke 已完整 complete；当前用户新决定的 attempt 在此边界之后登记 | commit 时再次校验同一条件及 E/generation/revision，才可进入 `current(true)` |

更新的 revoke 可以取代旧 operation 的控制权，但旧 operation 的 permit/资源/owner 清理债务必须纳入最新完成屏障，不能通过 superseded 丢弃。旧 operation 的 complete 或迟到 receipt 不能使最新 fenced 状态进入 current。`reconciliationRequired`、policy 失效和到期不能作为 grant 的绕行入口；确定的 deny/policy 撤回仍走相同 fence/ACK 屏障。外部 grant 推送不属于 strict 1.0 的授予路径。

屏障还必须计入同 C 所有更早未查明的后端决定，包括没有 live owner 的管理操作。
网络失败只结束一次 attempt，不证明 deny 事务未执行。新的撤回不能在旧 HTTP 仍可能
执行时完成或允许新 grant；可信 provider 必须重查或重提旧 decisionId 并接纳该决定
的幂等事务回执。不同 deny 的执行顺序可能不同于本地 begin 顺序，deny 不使用 grant
的 expectedRevision+1 CAS；只接纳高于该决定起始已知 revision 的可信回执，共享
authority 保留最高已验证 revision。操作自己的回执 revision 与当前 authority revision
分别记录，乱序回执不能回退 authority。旧失败决定的重试只清理该债务，不恢复最新
operation 的控制权；同一已失败 attempt 的首次原始错误保持不变。

## 5. Call context、protected API 与 completion wire

在既有 `HostApiCallContext` 上追加可选的 `consent`；只在启用扩展且属于受保护调用时存在：

```json
{
  "consent": {
    "protocolVersion": "1.0",
    "scopeId": "<64 lowercase hex>",
    "kind": "profile",
    "generation": "7",
    "revision": "12",
    "ownerRevision": "41"
  }
}
```

这份对象由 runtime 铸造，同时保存于 Rust pending。SDK 必须完整透传，不允许重新从当前 snapshot 拼装。要求平台收到不认识的严格 context 时失败，而不是忽略并继续旧实现。

第一批保护清单是明确的内部策略，不由 guest 自报：

- profile：`wx.getUserProfile`，以及注册的 `wx.getUserInfo` 的资料披露部分；适用的 identity state/userInfo 投影及通知。
- phone：runtime 内部 `weappContainer.identity.authorizePhone` / `button open-type="getPhoneNumber"` 的授权和 `bindgetphonenumber` 成功事件。
- `wx.authorize({scope:"scope.userInfo"})` 如仍是实际授予入口，也必须进入 profile 的 grant 决策合同；其他 scope 不误归入 profile。
- 登录 code、应用登录授权、payment、另一个 kind 不因 kind revoke 而取消。无公开 `wx.getPhoneNumber`。

扩展现有 `completeHostCall` 和 Web Completion JSON；legacy 调用保持现有 result/error。严格受保护成功必须带 metadata：

```json
{
  "callId": "<原 callId>",
  "result": { "userInfo": "<白名单公开资料>" },
  "consent": {
    "protocolVersion": "1.0",
    "kind": "profile",
    "generation": "7",
    "revision": "12"
  }
}
```

metadata 不进入 guest result。runtime 核对原 pending 的 E/C/generation、共享 authority 当前 revision/grant；缺失、跨 kind、旧 revision 或多余字段为协议错误/撤回失败，绝不当作普通成功。错误 completion 无需伪造 grant metadata；仍检查 owner/terminal 状态，保留原始 provider `errCode/errMsg/details`。

自己的 grant 会提升 revision，不能简单要求“永远等于入口 revision”。使用下一节的已登记 decision attempt：仅该 call 可以将自己的 acceptedRevision 从 expectedRevision 更新至被协调器接纳的新 revision；generation 必须完全不变。不得仅根据 HTTP 2xx 或 result 中的新 revision 自动追上共享状态。其他旧调用按旧 revision 失效，必要时由新调用重新获取。

## 6. 最小新增 host-only 命令合同

所有对象严格拒绝未知字段。以下命名是建议冻结名，尚非已存在入口；通过现有 session_command JSON 和等价 Web exports/Worker `native.consent.*` 传输。

共同对象的规范字段如下（`?`表示字段可省略，其他均必需，额外字段拒绝）：

```text
ConsentState = { revision: CanonicalU64, granted: boolean, expiresIn: u32-seconds }
ConsentStates = { profile: ConsentState, phone: ConsentState }
IdentityProjection = {
  hostLoggedIn: boolean, appLoggedIn: boolean,
  profileAuthorized: boolean, phoneAuthorized: boolean,
  authorizationVersion?: nonempty-string(max 512 UTF8 bytes),
  userInfo?: public-profile-object(max 256 KiB JSON)
}
```

`expiresIn`使用可精确表示的u32整数秒，deny时为0；grant若剩余为0即不允许披露。runtime把期限锚定在observation/decision-attempt捕获时的本地单调时钟，而非收到迟到响应的时刻；同revision的重放最多缩短已有期限，不得延长。完整v2后端对象先由host白名单映射，`consentExpiresIn`分别映射至states两个kind；不复制其他字段。userInfo的具体公开字段沿用现有profile白名单，不允许手机号、token或任意backend扩展。

### 6.1 初始化与 observation

`captureConsentObservation { "kinds":["profile","phone"] }` 返回：

```json
{
  "observationId": "<runtime minted opaque id>",
  "owner": { "application":"<完整可信对象>", "account":"<完整账号>", "sessionId":"<实际 session>", "ownerRevision":"41" },
  "fences": {
    "profile": {"generation":"7","revision":"12"},
    "phone": {"generation":"3","revision":"8"}
  }
}
```

runtime 保存 observation 的真实 owner/fences/deadline；同一 owner最多 64 个，使用/过期释放。初始化允许 revision=null；这不意味着允许披露。native refresh 在 HTTP 前 capture，不能等响应到达后再捕获当前 fence。

`initializeConsentAuthority {observationId, identityProtocol:"2.0", states:ConsentStates, identityState}`：仅当 C 是 uninitialized，且观察后没有本地 revoke、owner/epoch 变化时可建立一次权威基线。v2 capabilities/HTTP 验证由可信 host provider 完成；runtime 校验 schema、scope、代际和安全投影。不把 bearer、challenge、decision body 或原始后端对象送 Worker/guest。已知域的旧配置或新 owner不能再次初始化、重置或解除 fence。

`applyConsentObservation {observationId, identityProtocol:"2.0", states:{...}, identityState}`：仅能发布与协调器当前 generation/revision/grant 一致的投影，不能推进 authority。旧观测拒绝并清除敏感临时结果。观测到更高 revision/状态冲突时返回 `ERR_CONSENT_RECONCILIATION_REQUIRED`，保持安全投影并阻止本次披露；由可信 provider 启动显式权威同步，不能按 opaque authorizationVersion 排序或无限刷新。

`reconcileConsentAuthority {observationId, identityProtocol:"2.0", states:{...}}` 是**显式**权威同步命令，不能与普通 snapshot API 混同：接受精确单调 revision；已确认的更高 revision 的 deny/policy失效推进该 kind generation 并走相同 owner fence/ACK；相同 revision 的状态冲突拒绝。strict 1.0 中，已撤回/blocked 的 false→true 只接受下述本地已登记 grant decision，普通查询/重建不解除阻塞。要支持其他进程授权授予的推送，须另冻结认证事件合同，不能顺手把 refresh 升格成任意 grant 权威。

`identityState` 必须符合上述IdentityProjection。runtime复核profileAuthorized对应profile的有效grant、phoneAuthorized对应phone；非授权状态必须移除userInfo。期限和重放按共同ConsentState规则处理。

### 6.2 本次 UI grant 的登记与接纳

`prepareConsentDecision {callId, decisionId, expectedRevision}`：call 必须仍属当前 E/C/generation，kind 从 pending 获取，expectedRevision 等于共享当前值。authority 必须为 current，无未终结 revoke、无 cleanup 债务；若存在历史 revoke，最新 operation 必须已完整 complete。fenced/reconciliationRequired 及撤回失败待重试期间明确拒绝登记，不能仅以新 generation 创建一个“新授权”越过撤回。保存有界 attempt，返回 runtime-minted `decisionAttemptId`，同时绑定登记时已完成的最新撤回边界。decisionId 满足后端 v2 合同，challenge 只留可信 host client。弹窗展示、决定、发 HTTP 前仍各核对该 attempt；过期或撤回需要重新展示并取得新 decision，不能替换 revision 自动重提允许。

`commitConsentDecision {decisionAttemptId, identityProtocol:"2.0", decisionId, granted:true, revision, expiresIn}`：校验 attempt 未用/未过期、E 当前、generation 未变、后端 expectedRevision→revision 严格递增一步、decisionId 匹配；并原子复核 authority 仍为 current、无未终结 revoke/cleanup，登记时的最新完整撤回边界仍相同。任一撤回开始即失效旧 grant attempt；必须等最新 revoke 完整完成后重新展示并登记新决定，不能让 grant 取代进行中或失败待清理的 revoke。满足条件才原子接纳 authority 与该 call 的 acceptedRevision，然后发布 snapshot/返回披露。响应丢失按原 decisionId 查询/重提，不能新造决定；迟到 receipt、superseded 或错误结果不接纳。false 决定使用 revoke/deny 合同，不绕过 generation fence。

### 6.3 撤回与可查询终态

`beginConsentRevocation {kind, decisionId, context}`：context 沿用现有 native SnapshotOwner 的完整 application/account/session 归属检查；scope 从绑定中算出。共享 manager 的对应 typed API也允许没有 live owner 的 native 管理操作，仍须使用可信安装 scope，不接收 guest 选域。

在任何 HTTP/await **之前**，协调器原子地关闭该 C 的新披露 admission、递增 generation、置 granted=false 并记录 operation。此时所有关联 owner（包括不同版本、direct/Worker、新建候选 owner）都会在最终 claim 处读到新代际，不能等逐 owner command到达才开始阻断。命令立即返回 received receipt，包含 runtime-minted `operationId` 和首个 opaque `attemptId`；可执行后端 deny，与本地 fence ACK/资源取消并行推进。

重复同一 decisionId、同一请求归属返回原 operation；同 ID 不同 kind/scope/请求摘要拒绝。真正新的 revoke 再提升 generation；retry 同一 operation不重复提升、不新造后端 decision。

`commitConsentRevocation {operationId, attemptId, identityProtocol:"2.0", decisionId, revision, granted:false}`：attemptId 必须是 runtime 为该 operation 当前活动 attempt 铸造的精确 opaque 标识，并绑定已登记的 scope、generation 和 decisionId；缺失、跨 operation、已终结或旧 attempt 的命令明确拒绝，不能修改当前 attempt 或投影。只在此条件下接纳后端 receipt，revision 单调且符合事务返回；本地 generation 保持原 fence 或更高值，不因旧 receipt 回退。若有更新的 revoke，旧 operation 的受信资源终结只能满足其被最新 operation 继承的清理债务，不能覆盖最新投影。

原始后端失败使用 `failConsentRevocation {operationId,attemptId,error}`，同样仅接纳当前活动 attempt，并保留原始错误和已关闭的 fence。所有可改变 attempt 阶段/终态的 host-only 进度入口也必须携 attemptId。迟到旧 attempt 的错误一律拒绝；旧 backend 成功也不直接合并为新 attempt 的成功，可信 host 须以当前 attempt 重查或重提同一 decisionId，验证当前后端状态后重新 commit。旧真实资源的完成/取消 ACK 仍按内部 resource/tombstone 身份清理，但不改变旧 attempt 的不可变终态，也不终结新 attempt。

`queryConsentOperation {operationId}` 返回安全 receipt，不进入 JS、不需要 app 健康或当前页面；账号切换/失败恢复期间仍可读。例：

```json
{
  "operationId":"<opaque>", "kind":"profile", "generation":"8",
  "attempt":"1", "attemptId":"<runtime minted opaque attempt>",
  "status":"pending", "phase":"draining",
  "backend":"committed", "revision":"13",
  "owners":[{"ownerRevision":"41","status":"acknowledged"}],
  "cleanup":{"pending":"1"}, "error":null
}
```

状态：`pending | complete | failed | superseded`；phase：`fencing | backend | draining | publishing | complete`。不暴露 userInfo、手机号、code、challenge、bearer。`retryConsentOperation {operationId}` 由 runtime 为可重试的失败操作新建 opaque attemptId 和递增 attempt 序号，只重试未完成阶段，返回新 attempt receipt；同一 operation 最多一个活动 attempt。活动 attempt 尚在执行时重复 retry 返回该活动 receipt，已 complete 的操作返回已有终态、不新建 attempt。原 attempt 的 terminal receipt 不可改写，所有后续 commit/fail 必须使用新 attemptId。被更新 revoke 取代的操作不能通过 retry 恢复控制权；未完成清理债务由最新 operation 的屏障继续管理。失败仍 fence closed；最新 epoch/operation 永不被较旧重试恢复。

public native `revoke(kind)` future 等待**实际 terminal receipt**，成功必须 status=complete，失败抛保留 operationId 的结构化错误。public `refresh()` 同样必须成功/失败/取消，不允许 stale return 后永不结算。取消 native 等待只取消 waiter，带 operationId 返回；不撤销已开始的 revoke、不回滚 fence、不意味着 backend 未提交。query继续有效，后端/清理继续推进。future 不得在 owner 当前 JS handler 内阻塞等待自己的 drain，使用受理 receipt、host事件和异步 continuation。

每域最多 64 个运行中 operation；满额拒绝新操作，不能丢弃 pending。已终结 receipt 保留最近 64 个/显式宿主持久化；已驱逐 ID 返回明确 not-found，不假装完成。native tombstone资源计数另受 MAX_PENDING 同等有界预算约束。

## 7. 最终交付 claim、微任务与原子性

建议的根本修复是运行时 `ConsentDelivery`，不把 generation 条件塞进 adapter `current()`：

```text
pending(native I/O)
  -> settling(native result held; JS continuation queued)
  -> claimed(one authoritative disclosure or one failure)
  -> terminal(guest settled; real native drain separately tracked)
```

1. strict protected completion先检查真实 pending owner/fence，再验证 payload。被拒绝的敏感二进制不物化；释放句柄/缓冲所有权。结果在 runtime的有界 settling record中保存；仍占调用/结果预算。
2. `finish_host_call` 对这些调用不提前发布含成功数据的 API_RESULT，也不把结果传入 JS。它登记 runtime-minted opaque delivery ticket，并让 resolver 排队一个不带敏感 payload的 continuation。PhoneButton同样走这个机制，不能另有未经 claim 的成功组件事件。
3. 两个 engine resolver 增加内部可选第四参数 delivery ticket（legacy 路径不变）；实际 Promise微任务执行时通过同步 native hook claim ticket。**此刻**原子核对绑定 E、共享 generation、accepted revision、grant、有效期与 terminal winner。JSON 完整抄回 fence不能使无效 ticket有效。
4. 若 revoke先关闭 admission，claim得到一个不含敏感数据的撤回/权限失败；若 claim先取得 permit，披露在这个原子点线性化在 revoke之前。permit在该执行段的 finally/owner turn guard中释放，revoke future等它及 owner ACK排空。不得在持 Mutex 时调用 JS，不做同步等 owner线程返回的写锁等待。
5. 只有 claim后的结果才 decodeNative并执行既有 success/fail → complete → resolve/reject。guest 可缓存已披露资料，撤回不能擦除它；保证是撤回 fence之后**未被 claim 的队列项**不再成为成功，以及 revoke完成后无旧终结回调继续开始。已经获得 permit的同步执行段是前序披露，不能声称撤回能中断已开始的 JS语句。
6. active permit/claim必须有结构化 RAII故障收尾。JS抛错、微任务超时、engine fault、owner退休不遗留可阻塞永久的 permit；正常错误继续使用既有 callback异常处理顺序。V8/QuickJS必须测试同一个状态图，不接受一端只有 pre-finish检查。
7. live owner的 revoke sweep包括 pending与settling；对应成功结果替换为一次撤回失败，安排终结微任务，同时丢弃旧成功数据/二进制。取消、超时、用户原始拒绝和撤回使用单一 terminal winner：已完成的不重开；已因deadline/cancel确定失败不改为成功；已有原始provider拒绝不因后续刷新失败被覆盖。
8. 移除旧结果不等于释放真实 HTTP/UI/设备资源。资源进入 native-draining tombstone，直到真实完成/取消ACK；调用的新名额与 native资源预算分别计数，不能因guest拒绝提前把未终结资源当作已释放。重复/迟到completion只做tombstone清理，不产生第二个JS终态。
9. owner已退休（换号/应用退出/close/故障）的 ticket在同一生命周期边界全部无效，沿 `revoke_host_services()`取消排空，**不**为了满足kind的live规则再进入旧guest。live转retired发生在settling期间也按retired处理。

原生基础层在进入 settling 时便取得一个按 owner/kind 复用的 terminal reservation，
因此尚未执行的成功、拒绝和超时回调都阻止提前完成撤回。该 reservation 不授予
数据读取；每个成功仍在真实微任务入口单独校验自己的 stamp。检查点结束只释放
既无未消费 ticket、又无正在该检查点执行回调的 reservation；丢弃未排队 ticket 或
退休 owner 时也不得抹掉正在执行的回调计数。pending I/O、实际资源排空与投影 ACK
需要 Session 另外接入，不能由 settling reservation 代替。

Session 的 resolver 调用与随后 checkpoint 目前共用一个 Result。若 resolver 已接纳
ticket，但同一 checkpoint 的另一微任务抛错，最终 Err 不能证明 ticket 未入队。
只有确定返回 false 才能直接 discard；接纳状态不明时须保留 reservation，或先真正
退休 owner 后清理。集成 checkpoint finalizer 不能为此额外 pump 原本无 checkpoint
的 host-event/environment 读取入口。

线性化点必须写进实现测试：不是HTTP结束、SDK enqueue或Rust pending删除，而是最终guest交付claim。单纯“在调用resolver前再比较一次”仍未覆盖当前两种engine的Promise微任务。

### 7.1 已核对的 turn/checkpoint 可复用性与死锁约束

本次源码检索没有发现字面名为 `run_on_owner_thread` 的函数；实际边界是 `call_engine_with_error_code`（`crates/container-runtime/src/lib.rs:7209`）及 `with_engine_host_turn_deadline`（`engine_turn.rs:163`）。前者两端都在 JsEngine::call 后执行 drain_microtasks；普通throw也checkpoint，QuickJS已fault则跳过。QuickJS checkpoint在 `container-engine-quickjs/src/lib.rs:3757` 明确要求 execute_pending_job在 Context::with之外，因为后者持有runtime锁；V8 `:3383`在isolate lock内做显式checkpoint。

结论：**可复用既有外层 owner turn/调用后的 checkpoint 作为 permit 的 drain/RAII寿命边界；不能仅靠在进入整个 turn 时取得一个permit来授权本turn所有后续微任务。** 同一checkpoint内较早的微任务可能发起revoke，后面的旧success仍须在各自claim时读最新generation。turn只保有已claim披露的in-flight计数，不授予后续claim越过fence的权利。

具体安全实现：

1. native claim hook仅捕获独立的 `Arc<ConsentAuthority/DeliveryLedger>`，短锁核对/取走ticket数据、增加in-flight计数后立刻解锁。不得捕获 `&mut Session`，也不经FFI递归调用session.command。独立hook参照已有SyncHostApi的非重入边界（`container-core/src/lib.rs:417`），但属于runtime私有终结协议，不加入可由宿主注册的wx同步API清单。
2. `call_engine_with_error_code`/外层turn在call + checkpoint全部返回（含error）后释放本执行段获得的permits；panic/放弃guard由纯Rust Drop释放。Drop只更新计数/唤醒owner mailbox，不运行JS、UI或等待后端。permit不跨异步await，不把manager MutexGuard带过engine call或checkpoint。
3. 回调内部调用受信native hook发起revoke时，manager可立即短锁关门、增代际并返回**received/pending receipt**。它不能同步等当前turn的permit/自身owner ACK；该owner在checkpoint/turn退出后ACK，再异步完成native future。相同checkpoint后续旧delivery claim立即失败；已经成功claim的当前回调可完成其前序终态。
4. 现有FFI `SdkSession::enter`（`crates/container-sdk-ffi/src/lib.rs:56`）已用busy位拒绝 `ERR_REENTRANT`；不要为此新增reentrant mutex或绕开busy对同一Session重新借用。若宿主adapter回调只能调用session_command，必须排队到owner下一次drain；可用的同步共享gate应通过独立manager authority句柄完成，不能靠递归进入VM。
5. 测试必须包含“success callback内部通过受信native测试hook begin revoke；同checkpoint另一个待交付profile成功被拒绝；revoke waiter不阻塞且turn结束后终结”，以及throw/interrupt清理。该测试用真实两引擎证明锁序和最终claim，不能只有Rust coordinator单测。

因此不能把现有rquickjs Context锁/V8 isolate锁当作跨owner授权锁，也不能把一个account manager Mutex持有到JS结束。共享authority只在短临界区线性化；owner lane和独立的计数permit负责执行屏障。

### 7.2 strict 同步身份快照的逐次原生 gate

`weappContainer.identity.getState()` 是同步披露入口，不因当前 turn 已装过 snapshot 就获得后续读取许可。当前 `container-core/src/host-bridge.js:86,357` 调用 `__container_sync_api`；QuickJS `src/lib.rs:224` 和 V8 `src/lib.rs:152` 会直接 clone JS 中的 per-turn cache。严格模式必须改走 runtime 私有的同步 `claim-identity-snapshot` hook，普通设备同步快照与 legacy 合同不受此私有入口影响。

每次读取都由 hook 通过独立 `Arc<ConsentAuthority/ProjectionLedger>`，在短临界区内从真实绑定取得 E/D，原子检查当前 owner/epoch、两个 kind 的 generation/revision、authorityStatus、grant 和单调 expiry，并与原生保存的白名单投影核对。撤回/过期/未初始化的 kind 立即返回 false 的安全投影；profile 失效必须移除 userInfo，另一个 kind 和可信 app login 按当前值保留。owner 已退休则沿生命周期错误处理，不能返回旧账号投影。

只有当次 gate 接纳的公开资料才在解锁后转换为 JS 对象；披露为 true 的 kind 同时取得执行段 permit，按 §7.1 的 call + checkpoint guard 释放。revoke 先关门则本次只能返回安全投影；读取先取得 permit则属于撤回前的披露，revoke future 等该执行段和实际 owner ACK。一个回调内 begin revoke 后，即便该回调已有旧 permit，再次 getState 仍须重新过 gate，不能复用旧许可。guest 先前保存的对象不予追溯擦除。

strict userInfo 必须留在受管原生投影中，不能预先放入普通 `__container_sync_api_values` 或任何可被 snapshot facade 直接 clone 的 JS cache。turn 入口刷新、更新 snapshot 和 owner-lane ACK 只维护投影/完成屏障，不能代替逐次检查。hook 不捕获 `&mut Session`，不递归进入 session.command，不等待 HTTP/UI/owner 线程，也不跨 JS 持锁。任一 engine、SDK 或 transport 未接入该同步 hook 时，strict configure 在 app.init 前以 `ERR_PROTOCOL_VERSION` 拒绝；不能回退普通 cache，也不能 advertise consentRevocation/consentDeliveryClaim 1.0。

## 8. owner ACK 与 snapshot/event 清理

host/tenant 根 registry 必须登记同 D 的全部实际 owner，登记不能以是否支持新 hooks 为过滤条件。无法参加严格门禁的 legacy/旧 runtime owner 必须先真实退休并排空；在此之前拒绝整个 D 的 strict admission，不能删掉 owner 或从 ACK 集合中省略。候选 owner 和普通异步 Worker 也遵循此规则。

协调器注册的 owner记录至少有 `ownerRevision, E, installedGeneration[kind], activePermits, cleanupPending`。每个owner由其所属线程执行fence安装；等待该 lane 期间 §7.2 的逐次同步 gate 已按共享 authority 返回安全投影：

- 阻止该kind的新请求、旧UI决定、旧grant attempt、旧observation和旧delivery ticket成功。
- 同步替换该owner的安全身份快照及replay状态，去除已撤回profile的userInfo；另一个kind和app login不变。
- 清除已队列但尚未claim的旧身份成功事件，按当前状态重建至多一次change通知；普通event入口必须带受保护原生上下文且使用同一claim，不能另行把整个backend object广播到guest。
- 给live待结算调用产生一次失败；等待已入场执行段、实际native资源终结，并向manager确认installedGeneration。ACK是内部受信owner lane产物，不接受宿主随手把ownerRevision列为已确认。
- owner退休则按现有close/drain屏障确认retired；不能仅从set中删掉就当作ACK。新owner在注册时加入最新fence，初始化前就blocked；操作进行中创建的owner不能落在目标快照之外。

只有 latest generation 对应的安全投影已安装、同 D 全部相关 owner 确认、后端提交及被继承的旧清理债务也实际终结，最新 operation/attempt 才原子进入 complete，并允许 authority 转为 current(false)。错误可查询、重试，不恢复授权。已关闭/engine fault的query走Rust manager状态，不把mutating命令一起列为passive。`queryConsentOperation`应加入SDK的账号替换允许列表以及FFI故障被动命令的精确白名单。

## 9. 重建与SDK/Worker重放

- 公共controller保持稳定；每次新owner从manager取得全新的ownerRevision和当前每kind状态，先绑定authority，再验证requirements，再安装安全快照，最后app.init/输入。不能从旧config.syncValues复制grant/userInfo来跳过初始化。
- `services_for_pack`、preload候选、热更新失败恢复、账号切换的重新构造都重放requirements与adapter注册；accepted version/root变更不改D，但旧E的observations/attempts/tickets不得继承。
- app退出重用现有application retirement，持久consent保留；同用户new epoch可恢复当前durable grant，但先校验新host bearer与backend revision，旧epoch请求/challenge/code始终无效。账号删除委托后端清理D，并销毁本地对应协调状态；无可信映射的legacy授权不迁移。
- Android/iOS/Desktop/Harmony、Flutter/RN桥必须原样透传consent context/completion metadata和requirements，不能只更新最底层Rust lock。各native handler的await/UI之后仍检查，最终runtime claim是最后一道防线，不替代host端阻止旧grant HTTP。
- Web direct与Worker共享BrowserHostAccountManager中的host-realm协调器。host bearer/challenge/原始decision请求不得进入Worker。Worker只收到非秘密fence/receipt/ticket和白名单投影。
- Worker lane增量建议名：`native.consent.capture`、`.initialize`、`.observe`、`.reconcile`、`.prepareDecision`、`.commitDecision`、`.beginRevoke`、`.commitRevoke`、`.failRevoke`、`.query`、`.retry`。revoke/fence/ACK使用单独控制配额，不被普通completion积压饿死；仍只在owner lane触碰JS。
- **普通异步 Worker broker 不支持 `consentDeliveryClaim:"1.0"`。** 每个 Worker 的独立 WASM 内存不能读取主 realm 的原生共享 authority；Promise 微任务中的同步 hook 不能等待 postMessage，又继续处理本 Worker 的撤回消息。提前向 broker 请求并缓存 permit 会把线性化点前移，不能等价替代 §7 的最终同步 claim 或 §7.2 的逐次同步身份 gate。仅记录 issued permit 为 active、等待 ACK 可以延后 revoke future，却不能使同步 hook 知道 permit 已被主 realm 撤销。
- 因此，未取得经过验证的等价最终原子检查与同步 gate 的 Worker transport 必须在 app.init 前拒绝严格 requirements，不能 advertise consentRevocation/consentDeliveryClaim 1.0，也不能因主 realm 有 coordinator 或控制队列而跳过。此类 Worker 若已在同 D 运行，按 §3/§8 阻止 strict admission，直至其真实退休排空；不能从 owner 集合排除。
- 后续 Worker 支持须先另行冻结可执行的协议和能力协商：共享原子 authority 路线应定义跨内存的读取/提交线性化、owner 归属、permit/expiry 与释放；异步交付路线须明确 request、授予/commit、撤销、ACK 丢失、队列溢出、terminate/重建的状态图，并解决同步 identity snapshot 的相同边界。协议必须说明如何满足 §7/§7.2，或以明确的新合同表达差异，不能冒用 1.0。冻结、实现和真实验证前普通 broker 保持不支持；postMessage、一次主 realm 检查或一个本地 generation Map 都不是原子共享检查。

## 10. 最小、保持系统边界的实现顺序

1. **类型/协议/拒绝优先**：runtime新建consent模块及strict schema；capability、requirements、context/completion、owner-only命令；旧runtime拒绝、新runtime无binding拒绝、旧后端拒绝的测试先落地。此时不advertise已可用。
2. **共享manager authority**：在现有AccountState增C/kind状态、注册owner与有界operation；runtime trait实现、单调数字/溢出、账号/app retirement互操作。先证明不同publisher/user/app/env隔离与合法pack升级共享。
3. **terminal claim 根本修复**：pending/settling/tombstone、二进制物化次序、QuickJS/V8 真实微任务 claim、逐次同步 identity 原生 gate、PhoneButton 事件、原始错误/一次结算；native 模拟多个 owner 线程做精确 gate。必须测试“Rust 完成已排微任务、revoke 再发生”和“长 turn 内兄弟 owner 撤回后再次同步读取”的窗口。
4. **authority 与 projection 命令**：observation/decision/revoke 操作、retry 与带 attemptId 的 commit/fail、native future/query/取消 wait、原生 snapshot/event 安全投影、全 owner ACK 与重建重放。普通 snapshot 通道尝试覆盖授权必须失败；最新 revoke 完整完成前不接纳 grant。
5. **每SDK先一条完整竖向链路**：先Desktop三端共用adapter/现有参考HTTP v2，再Android/iOS/Harmony/Web direct/Worker，随后Flutter/RN。native UI与全部await点接入相同attempt/fence，不把每端另建私有generation当共享实现。
6. **产物与真实证据**：严格归档清单纳入新增模块与平台源码；同一干净提交构建runtime/SDK，更新锁，归档全新安装。有限引擎/HTTP回归与真实系统UI/SDK链路分层，缺平台保持待验收。

不能先以adapter端窄补丁声称完成，再后补最终JS边界：这会保留当前settling微任务漏洞，也会使每SDK重复实现一套终结规则。

## 11. 此批必须写出的可复现断言

- profile/phone真实响应生成后gate；两个同D的live owner，一个先撤回，另一个队列成功被替换为一次fail/complete/rejection；无userInfo/code/旧snapshot/旧event。
- Rust完成先进入settling、QuickJS/V8微任务尚未执行，再begin revoke；失败由最终claim决定。反向顺序claim先取得permit，revoke在permit/owner ACK前保持pending，完成后无旧回调开始。
- UI已显示、允许尚未发HTTP；HTTP事务前；grant提交后receipt暂停；snapshot刷新前后；native enqueue之后各精确gate。旧attempt不得重新授予或接纳新revision。
- 重复completion、重复revoke/notification、同decisionId改body、超时与撤回竞争、provider拒绝后refresh又失败；恰好一次结算且原错误不丢。
- phone真实button链路；live kind撤回不退休page，app退出/账号切换/close发生在settling时不调用旧page。
- native资源迟到、取消不响应、cleanup失败及retry、队列/settling/tombstone溢出、engine fault；预算有界，query可达，不虚报资源已释放。
- 同用户new epoch、不同用户、两个app/发行者/环境、合法升级/preload/失败恢复；config与adapter重放，旧snapshot/ticket不能写入新owner。
- 新旧runtime/transport/SDK的严格要求矩阵，缺任一能力失败；普通snapshot、guest bridge、任意metadata不能mint或推进authority。
- 最新 revoke 在 backend、owner ACK、permit 或 cleanup 任一阶段仍 pending/failed 时，prepare/commit grant 均拒绝；完整完成后只接纳新展示并登记的决定。旧 revoke receipt 不能解除新 fence，superseded 不丢清理债务。
- attempt 1 失败后 retry 创建 attempt 2；旧 attempt 的迟到 commit/fail 明确拒绝，新 attempt receipt/原始错误不被污染。真实资源迟到 ACK 只清 tombstone，不重写 terminal receipt。
- 两个真实 engine 的长 turn/checkpoint 中，兄弟 owner begin revoke 后再次同步 getState，只得安全投影；同步 hook 未接入时 strict configure 失败，JS 普通 snapshot cache 不含未 claim userInfo。
- 同 D 有 legacy/旧 runtime owner 或候选 Worker 时，不能省略其登记/ACK；strict admission 失败，真实退休排空后才能启用。不同明确 legacy 域保持历史合同。
- 普通异步 Worker broker 明确不支持 1.0，严格配置失败且不 advertise；后续另冻结协议才可验证旧 completion 排队、控制队列饱和、重建/terminate/ACK 丢失。任何支持路径均不得在缺最终 owner 确认时使 revoke 成功。记录本任务资源关闭/失败清理。

所有证据仍绑定API/参数kind、干净源码提交、安装产物摘要、OS/浏览器/SDK、实际命令、结果及清理。本文不预填通过，不替代系统UI或真实平台验收。

## 12. 明确保留的跨进程/设备范围

该扩展只在同一 host/tenant 根 registry 的保证边界内启用；同 D 的全部实际 owner 必须已关联且具备共享协调、逐次同步 gate、最终 claim 与 ACK，或已真实退休排空。不能用“具备能力”过滤仍活跃的 owner 再宣称全域撤回完成。另一个进程/设备已经缓存的资料，无法因SQLite revision变化自动回收；取消当前HTTP也不能撤销已提交grant或已生成资料。

要提供跨进程/设备的撤回完成语义，仍须独立冻结并实现：后端认证owner lease、按C有序且可重放的change log、lease过期时本地停止披露、每owner对generation/revision的fence ACK、断线恢复先同步后准入、未ACK/失联owner的pending与租约超时语义，以及账户删除的授权/资源回收。服务端HTTP 200、轮询一次、WebSocket发送成功或本地event已入队均不是owner fence ACK。

本提案不定义这些远端lease字段、不advertise跨设备即时撤回，也不将缺失通知/资质/设备登记为平台不适用。后端v2、关联owner runtime/SDK与跨设备lease三层验收分别保留；全部适用功能及真实证据齐备前goal不能完成。
