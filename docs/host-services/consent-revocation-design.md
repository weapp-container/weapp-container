<a id="data-phone-number-authorization-revocation-and-late-result-isolation"></a>
# 资料、手机号授权撤回与迟到结果隔离

**简体中文** · [English](consent-revocation-design.en.md)


状态：**后端 v2 原子授权已实现；共享宿主 fence、SDK 接入和真实 UI/产物链路待实现、待验收**。
`tools/host-services-reference/src/consent-v2.ts` 与 service/server 已提供本文 v2 路径、可信
持久域、单调 TEXT revision、challenge/CAS、decision 幂等及 strict legacy 门禁。
真实 HTTP/SQLite 测试分别在提交前和响应生成后设 gate；这不代表 SDK 已具备迟到结果隔离，
本文也不提升任何完整 API 验收状态。

诊断基线为主仓库 `1c95746ef789303e08387c1d5ba671d6263a601b`、Desktop SDK `2bf1e3adc0ff5f59e974440201c3171833c34965`。其他 SDK 的错误投影、失败后刷新修复属于独立批次；本文说明的是这些修复不能替代的授权生命周期边界。

需要实现两个相互配合的边界：后端以事务阻止旧确认请求重新授予已撤回的权限；宿主以共享授权代际阻止已生成的资料、手机号 code 和快照进入仍然存活的旧调用。取消 HTTP 或检查账号 epoch，分别只能解决其中一部分。

<a id="existing-root-causes-and-existing-boundaries"></a>
## 现有根因和已有边界

[Desktop adapter](../../sdk/desktop/src/host_services_adapter.cpp) 的 `current(call)` 验证账号、安装、session 和取消状态，没有资料或手机号的授权代际。`disclosure()` 保存成功响应后调用 `refresh_call()`；后者刷新同步快照，然后无条件继续完成原调用。由此可构造：

1. 已授权的 `/v1/host/profile` 在服务端生成资料，响应暂不送达。
2. 宿主 `HostServices::revoke(Profile)` 完成，快照变为 `profileAuthorized:false`。
3. 旧资料响应到达，账号和 session 仍相同。再次刷新即使取得未授权状态，也仍会把保存的 `userInfo` 返回 JS。

手机号 code、并发 `HostServices::refresh()` 也缺少对应检查。`revoke()` 没有使既有授权弹窗失效；旧弹窗的“允许”回调还能提交 `granted:true`。失败路径另外存在两个关联问题：`consent_required` 不一定刷新旧快照；原始拒绝后刷新再次失败，可能用第二个错误替换用户拒绝。错误刷新应尽力执行，不能覆盖原始拒绝，也不能绕过授权检查。

[参考服务](../../tools/host-services-reference/src/service.ts) 的 `setConsent()` 只比较当前 `purpose`、`permissionVersion`，每次写入产生随机 `revision`。`authorizationVersion` 是资料和手机号状态的组合哈希，属于不透明版本，不能排序，也不是写入条件。旧的 `granted:true` 请求若在 `granted:false` 之后才被后端处理，仍会成功。客户端取消连接不能证明后端没有执行该写入。

以下机制已经存在，应继续使用：

- [共享账号管理器](../../crates/container-sdk/src/account.rs) 在账号切换时先提升 epoch；[调用完成路径](../../crates/container-sdk/src/lib.rs) 在应用退出成功时先撤销准确的 application scope，再处理 guest 后续执行。同范围的兄弟版本会退休，其他 app、publisher、environment 保留。
- native snapshot owner context 防止旧 session、旧账号或旧安装写入新 owner；它没有定义同一 owner 内的授权撤回顺序。
- [Web reference client](../../examples/hosts/web-wasm/reference-identity-client.mjs) 已有客户端实例内的资料/手机号代际，以及披露前后检查。[BrowserHostServices](../../examples/hosts/web-wasm/browser-host-services.mjs) 已区分外部宿主通知与内部刷新，防止迟到刷新覆盖通知，并对不透明版本冲突重新读取。这些保护不构成后端原子写入，也没有建立所有客户端实例共用的持久授权域。

<a id="persistent-authorization-domain-and-execution-owner"></a>
## 持久授权域与执行 owner

持久授权域建议定义为：

```text
D = (hostAppId, tenantId, publisherId, principalId, appId, environment)
C = (D, kind)                  kind = profile | phone
E = (D, principalEpoch, sessionId, incarnation/ownerRevision)
```

`C` 是后端记录和同一宿主内所有实例共享的授权域；`E` 是一次执行及其异步结果的归属。`purpose` 和 `permissionVersion` 是授权合同的一部分，由后端当前 policy 决定，随授权记录保存、校验。它们改变时撤销原授权并提升该 kind 的 revision。

持久授权默认不绑定 `principalEpoch`。同一用户恢复登录或更新凭据不应因此丢失全部资料、手机号授权。epoch 必须绑定 host bearer、确认 challenge、手机号 code 和执行上下文；旧 epoch 的请求始终拒绝。同一用户新 epoch 可读取仍有效的持久授权，但旧请求、旧 challenge 和旧 code 不能继续使用。应用退出保留持久 consent；账号删除则清理该用户所有授权和 challenge。

`version`、`packRoot` 不进入 `D` 或 `C`，合法升级沿用授权。每次请求仍必须验证当前包在可信安装记录内；哈希本身不证明发行者身份。不同 publisher、用户、app、租户或环境绝不能合并授权代际。

当前参考服务的 `consentKey()` 复用含 epoch 的 `ownerKey()`，注册表还没有独立的 publisher 字段；`miniAppId` 在一个服务实例内全局唯一。以上是现有选择，不等同于新域已实现。迁移须单独审查：

- 新注册表须登记可信 `publisherId`，并核对 native context 的 publisher，不能接受 guest 自报。已有 appId 的重新绑定须显式拒绝或迁移。
- 旧 consent 的哈希键和记录没有完整可恢复的授权域，不能凭 appId、最新登录账号或现存包哈希猜测归属。没有经过宿主验证的映射与迁移入口时，v2 重新授权。
- 是否迁移同一用户旧 epoch 的已确认 grant、如何证明其归属，仍待实现批次确定。不能自动跨账号导入，也不能为迁移顺便改变已有 pairwise app user ID。

<a id="protocol-version-and-old-client-gatekeeping"></a>
## 协议版本和旧客户端门禁

当前 HTTP `/health` 只返回健康状态；没有独立的身份协议协商。`/v1/host/consents` 不会因为未知 JSON 字段而拒绝请求。**仅添加可选 `revision` 字段不安全**：新客户端可能被旧服务忽略，旧客户端也可能继续无条件授予。

建议新增下列独立合同，名称均为提案：

| 层 | 拟议门禁 | 不满足时的行为 |
| --- | --- | --- |
| 后端 | `/v2/host/identity-capabilities` 返回 `identityProtocol:"2.0"`、`consentRevision:"1.0"`、`scopeSchema:"2.0"` | 新客户端初始化失败，不回退 `/v1` 授权或披露 |
| app 注册 | `identityProtocol:"2.0"` 严格模式；建议作为新注册默认值 | 该 app 的 v1 授予、资料披露、手机号发码/兑换返回 `426 identity_protocol_required` |
| runtime | `capabilities.hostServices.consentRevocation === "1.0"`；Web runtime 入口提供等价能力 | 没有能力不能宣称具备新撤回语义，也不能加载要求该能力的配置 |
| 配置/归档 | `hostServices.requirements:{consentRevocation:"1.0"}`，SDK 与 runtime 同提交系列构建并锁摘要 | 检查或配置失败即终止，不删除 requirements 后继续 |

base host services `1.0`、C ABI `1` 可以保留，新增 JSON 能力及命令表达扩展。[现有 `HostServicesConfig`](../../crates/container-runtime/src/host_services.rs) 使用 `deny_unknown_fields`；旧 runtime 收到新增的 `requirements` 字段会拒绝，不能只把要求藏在旧 runtime 会接受的 `syncValues` 内。新 runtime、所有 SDK 和 preflight/重建配置重放都须保留并检查该字段。这里没有修改现有 schema。

严格模式还必须覆盖可信进程内调用。服务的直接 `setConsent()`、`profile()`、`hostProfile()`、`phoneCode()`、`exchangePhone()` 不能成为 HTTP v2 之外的无 revision 绕行入口。旧签名仅可供明确标识的 legacy app 使用；严格 app 必须走 v2 方法或得到 `identity_protocol_required`。

迁移时允许 legacy app 暂时继续 v1，但它不具备本设计的撤回保证，不能用于新能力验收。严格 app 的 v1 **撤回/拒绝**可以保留 deny-only 兼容入口：内部必须调用相同的事务撤回，提升 v2 revision 并发出撤回事件；不能调用旧写法。v1 登录、查会话和应用退出可保持原合同，它们不能授予资料或手机号。

新客户端访问旧服务的 v2 路径得到 404、拿不到精确协议或收到缺失字段的 2xx，都应作为协议不支持/无效响应处理。新服务对缺失 revision/challenge 的 grant 返回非 2xx，不能先授予再给兼容警告。HTTP 版本、包版本和 runtime 能力都不是相互替代的证明。

<a id="backend-atomic-revision-and-confirmation-challenge"></a>
## 后端原子 revision 与确认 challenge

<a id="data-and-validity-period"></a>
### 数据和有效期

每个 `C` 保存一个持久、单调 revision。在线传输使用规范十进制 u64 字符串，初始为 `"0"`；不得经 JSON number、double 或 SQLite 浮点转换。SQLite 存 TEXT，在 `BEGIN IMMEDIATE` 事务内以 `BigInt` 比较、递增；超过 u64 上限拒绝写入，不能回绕。`authorizationVersion` 继续是不透明的公开快照标识，禁止将其当作这个计数器。

建议的数据对象如下，具体表名可以在实现时调整，语义不能省略：

| 对象 | 必需数据 |
| --- | --- |
| 同意状态 | `C`、修订、已授予、目的、许可版本、策略摘要、expiresAt |
| challenge | 只存随机 token 的哈希；`C`、host session ID、principalEpoch、expectedRevision、policyDigest、expiresAt、consumed 标记 |
| decision | `(C, decisionId)` 唯一、请求摘要、所用 challenge、提交 revision 与结果；用于丢失响应后的幂等核对 |
| change record | `C`、revision、granted、来源 decisionId、可恢复的事件序号；不包含资料、号码、bearer |

challenge 建议有效期 60 秒，并且不得超过父 host session；token 至少 256 位随机。它只交付可信宿主授权执行器，不能进入 guest、Worker、URL 或日志。后端仍信任宿主展示真实 UI；challenge 不能证明用户点击过按钮。

policy 更新、删除和 grant 到期须在检查时成为原子状态转换：将授权失效、只提升对应 kind 的 revision，并使旧 challenge 失效。policy 的当前版本也须属于同一个事务可见的数据，不能一边校验内存旧 policy、一边写入新状态。重新配置或重启不得把 revision 重置为零。

<a id="v2-paths-and-fields"></a>
### v2 路径和字段

除业务入口外，下面的路径使用 host bearer，POST JSON。沿用可信 selection 的 `miniAppId,packRoot,expectedPrincipalId,expectedPrincipalEpoch`，并新增 `expectedPublisherId`。后端分别从 bearer、注册表和可信安装记录取得权威身份，再验证这些预期值；不以 body 选择另一个用户或发行者。v2 请求须拒绝未知字段，2xx 响应必须包含精确的 `identityProtocol:"2.0"`；保留原有 256 KiB 请求/响应上限。

| 路径 | 请求增量 | 响应合同 |
| --- | --- | --- |
| `/v2/host/identity-capabilities` | 可信 selection | 三项精确协议；支持的 kind 和服务端请求/响应限制 |
| `/v2/host/authorization-policy` | `kind` | `identityProtocol:"2.0",kind,purpose,permissionVersion,revision,challengeId,expiresIn` |
| `/v2/host/consents` | `kind,granted,decisionId`；grant 另需 `challengeId,expectedRevision,purpose,permissionVersion` | `identityProtocol:"2.0",kind,granted,revision,decisionId`；grant 带剩余授权有效期 |
| `/v2/host/identity-state` | 可信 selection | 四项布尔值、不透明 `authorizationVersion`、每 kind 的 `consentRevisions` 和剩余有效期；仅资料有效时带公开 `userInfo` |
| `/v2/host/profile` | `expectedConsentRevision` | `identityProtocol:"2.0",kind:"profile",revision,userInfo`，资料只含公开字段 |
| `/v2/host/phone-codes` | `expectedConsentRevision` | `identityProtocol:"2.0",kind:"phone",revision,code,expiresIn` |
| `/v2/apps/profile` | app bearer；`expectedConsentRevision`，scope 从该 session 与可信注册表取得 | 与 host profile 相同的 revision 和公开资料合同；不能绕回 v1 app profile |
| `/v2/apps/exchange-phone` | 业务 confidential client；`code,appAccessToken` | 真实已验证号码；事务内同时检查 code 归属、epoch、当前 phone revision 和 grant |

`decisionId` 使用宿主生成的至少 128 位随机、不透明标识，接受 `[A-Za-z0-9_-]{22,128}`。challengeId 使用 32 字节随机 token 的无填充 base64url 编码；两者均不含账号或包信息。全部 revision 字段接受 `0..18446744073709551615` 的规范十进制字符串，拒绝数字、符号、前导零和溢出。

资料/手机号请求的 expected revision 必须等于当前值且该 kind 已授权。冲突返回 `409 consent_revision_changed`，未授权返回 `403 consent_required`。发出的手机号 code 同时绑定 v2 标记、`C`、principalEpoch、phone revision 和包安装身份；跨应用、跨账号、跨 epoch、撤回、重新授权或 policy 改变均不能兑换。严格 app 的旧无 revision 手机号 code 明确拒绝，不能补成“当前 revision”。错误归属不消耗其他用户的 code。

`consentRevisions` 是宿主协议的检查数据。各 SDK 必须按白名单投影 guest 快照，不能把整个 backend object 原样交给 JS。guest 公开 schema 仍是四项授权状态、不透明版本和已授权的公开资料；host token、challenge、decision 和内部 owner 信息不属于快照。

<a id="grant-transaction"></a>
### grant 事务

以下步骤处于同一事务内，中途失败不改变授权，也不消耗他人的 challenge：

1. 验证 host session、当前 principalEpoch、publisher、应用和安装；归一化 `C`，处理该 kind 的 policy/到期状态转换。
2. 查 `(C, decisionId)`。相同 ID 配不同请求摘要返回 `409 consent_decision_conflict`。已成功的完全相同请求仅在当前 revision 仍等于该提交 revision 时重放成功；若已被后续决定取代，返回 `409 consent_decision_superseded`，不能返回旧的 granted:true 成功凭证。
3. 校验未过期、未使用的 challenge，其 `C`、host session、principalEpoch、policyDigest 与请求完全一致，`expectedRevision` 与 challenge 及当前 state 的 revision 完全一致。其他调用不能复用该 challenge。
4. 比较 UI 已确认的 purpose/version 与当前 policy。原子写入 `granted:true` 和 `revision + 1`，消费 challenge，记录 decision 和 change record，再提交。

缺少 challenge/revision 为 `428 consent_precondition_required`；已用、过期或身份不匹配的 challenge 为 `401 invalid_consent_challenge`；policy 改变为 `409 authorization_policy_changed`。客户端不得在这些错误后静默刷新 revision 并重提“允许”；必须重新展示当前 policy 并取得新决定。

响应丢失可以用相同 decisionId、相同 body 查询/重提原决定，不能新建一个 ID 自动重复授予。重放并不保证仍授权，必须按上面的 superseded 规则和当前状态处理。

<a id="revoke--deny-transaction"></a>
### revoke / deny 事务

`granted:false` 不要求旧 challenge 或旧 revision，policy 已删除时仍能撤回。事务校验当前可信账号/应用后，提升该 kind revision，写入 false，记录 decision 和 change record。旧 challenge 因 expected revision 不再匹配而失效，不允许“撤回后旧允许请求”成功。

相同 decisionId 重放同样遵守请求摘要和 superseded 规则。后续真正的新授权需要新的 UI、challenge 和 decisionId。profile 撤回不提升 phone revision，phone 撤回不改变 profile、app 登录、其他用户或其他应用；也不撤销已经发生的支付交易。

后端提交点的保证是：旧 grant 无法再写入，后续读取/兑换按新 revision 拒绝。已经生成、缓存在某个宿主的响应，还需下一节的执行隔离。

<a id="host-asynchronous-checks-and-one-time-settlement"></a>
## 宿主异步检查与一次结算

共享授权协调器应归属于已有 host/tenant 账号域，按 `C` 保存每 kind 的本地 generation、当前 backend revision 和权威通知代际。它是授权协调状态，不是第二套账号 epoch 注册表。所有同范围 session、不同版本、不同客户端对象必须接入同一协调器；不同 `C` 分开。native 回调仅入队，由各 owner 所在线程执行。

一次披露调用在入口捕获 `E`、kind generation 和 backend revision，随后在下列位置重新检查：请求入队前、每次 await/平台回调后、弹窗决定后、发送 grant 前、应用 snapshot 前、进入 native completion 队列前，以及最终进入 JS 前。只在返回数据处补一个判断，会留下旧快照和旧授权写入。

宿主发起 revoke 时，先提升相应 kind 的本地 generation，阻止旧请求、旧弹窗和已排队的旧结果；再提交 backend revoke，发布新 revision 和快照。native 撤回 future 必须在相关 owner 已安装隔离边界、后端提交和本地状态投影均完成后才成功。后端或清理失败须返回可查询失败/待清理状态，旧请求不能恢复；重试只做未完成阶段。

自身 grant 也会推进 revision。发起调用只有在 decisionId/challenge 与自身相符、调用 generation 未被撤回改变、结果 revision 仍是协调器认可的当前 revision 时，才能接纳该提交作为自己的新授权。不能仅因 HTTP 返回 2xx 就“更新预期 revision”，从而越过期间发生的撤回。

外部宿主撤回通知是权威事件，普通状态查询是观察。普通 refresh 不能提升权威通知 generation，也不能覆盖更晚的权威撤回。每 kind 十进制 revision 可以精确比较；不透明 `authorizationVersion` 不能比较大小。并发读取互相冲突时，在原 deadline 内有限次重读；持续冲突就拒绝当前调用，不无限重试。

必须区分两个结果：

- **owner 已退休**：换号、应用退出或关闭后沿现有路径取消和排空，旧结果不进入新 JS。
- **owner 仍存活但授权失效**：在该 owner 上一次结算取消/权限拒绝，释放调用预算；callback fail → complete → Promise rejection 保持现有顺序。不能把 generation 失败直接并入 `current()` 后悄悄 return，也不能先取消到 `fail()` 自己也无法发送终态。

用户拒绝、backend 原始错误和公开 `errCode/errMsg` 保留。状态刷新失败作为第二个诊断记录，不能替换原始拒绝。原生弹窗、HTTP 和订阅的真实终结仍需排空；不会因为 JS 已拒绝就把尚未终结的资源算作已释放。Native `refresh()` / `revoke()` futures 同样必须有成功、失败或取消终态。

新 runtime 扩展需在现有 command/context 通道上定义授权 fence 和权威更新，所有 SDK 完整透传，运行时在最终完成处复核。普通 `updateHostServiceSnapshots` 不能充当推进共享授权代际的授权命令；旧 runtime 也不能因接受四个布尔值就被视为支持 fence。具体命令 schema 与 context 扩展是实现前必须冻结的产物，本文不把任何未定义命令当作已可调用 API。

同一宿主内的所有已关联 owner 属于本批共享 fence 的保证范围。其他进程或设备的后端撤回需要宿主提供认证通知/恢复机制。若它没有收到通知，已经缓存在那里的资料不能仅靠服务端 revision 被“收回”。要承诺跨进程撤回成功后绝无迟到交付，还需后端 owner lease、事件重放和 fence ACK：未 ACK 的活 owner 使撤回操作保持 pending，断线 owner 在租约过期后必须本地阻断披露，重连先同步再恢复。这一通知/租约合同尚未确定，不能把轮询或一次 HTTP 200 写成跨设备即时撤回验收。

<a id="affected-client-paths"></a>
## 受影响的客户端路径

下表是待改范围，不是实现或验收完成表。

| 客户端 | 当前路径 | 需补齐的边界 |
| --- | --- | --- |
| Web direct / Worker | `reference-identity-client.mjs` 的 `authorize/disclose/run`；`browser-host-services.mjs` 的 handler/refresh/外部 state；`browser-host-account-manager.mjs` | v2 协商、challenge/CAS、每 kind revision、跨 client/owner 共享 fence；保留当前 owner/外部通知保护。host token/challenge 留 host realm，不能传 Worker；自定义 identity provider 即使没有 getState 也要检查 fence |
| Android | [HostServicesClient.kt](../../sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/HostServicesClient.kt) 的 transport、`AndroidHostIdentity.install/refreshState/prepareAccountState`、原生 AlertDialog | transport 当前只接受 `/v1/`，须显式增加精确 v2 路径；公开 native future、handler、UI 决定、snapshot/event 与完成队列都检查；拒绝时保留原错误。不能只改错误分支 |
| iOS | [HostServicesClient.swift](../../sdk/ios/Sources/WeappContainer/HostServicesClient.swift) 的 `WeappHostIdentity.install/refresh/confirm`、`WeappHostIdentitySnapshot` | transport 同样限制 `/v1/`，须增加精确 v2 路径；每次 await 和 UIAlertController continuation 后检查；共享域与 revision/CAS；避免刷新覆写或二次失败替换原拒绝；重建后重放严格要求 |
| Harmony | [ReferenceHostServices.ts](../../examples/hosts/harmony/entry/src/main/ets/session/ReferenceHostServices.ts) 的 `HarmonyReferenceIdentity.invoke/profile/refresh`；`HostServices.ts` 的完成队列 | 现有 refreshSequence 只表示本实例请求顺序，不能充当后端授权 revision；补 v2 challenge、共享 fence、披露后检查和真实按钮事件隔离 |
| Desktop 三端 | `sdk/desktop/src/host_services.cpp` 的 client/parser；`host_services_adapter.cpp` 的 `disclosure/authorize/refresh_call/refresh/revoke`；平台 consent presenter | 修复本文根因，区分 owner 与授权检查；原始 wire context、native futures 和 mailbox 全程保留 fence；macOS/Windows/Linux 共享相同语义，原生 UI 各自排空 |
| Flutter / React Native | 对应公开 API handler、native transport、preflight 与重建配置重放；Flutter 桌面 registry 与其引用的 Desktop 源码 | 不能只更新下层 SDK 锁而丢弃 requirements、context 或授权终态；归档内实际源码与公开跨语言链路均须验收。自定义宿主业务实现需遵守同一 v2 合同 |

同步身份快照仍须在加载前准备，不能用等待 UI/网络的方式伪造同步接口。手机号验收必须保留真实 `button open-type="getPhoneNumber"` → runtime 绑定 → native 授权 → `bindgetphonenumber` 链路，不新增虚构的 `wx.getPhoneNumber`。

<a id="acceptance-set-the-gate-after-real-response-generation-is-completed"></a>
## 验收：在真实响应生成后设置 gate

现有 Desktop `run-host-services-reference.mjs` 的普通 delay 在执行 handler **之前**等待，不能证明“资料已生成/code 已签发后的迟到响应”。Web 独立 fixture 已有 login-code 处理完成后的 gate，但还没有完成本设计的 profile、phone、state 或 stale grant 验收。新增夹具应分别提供两种 gate，不能混用：

1. **生成后响应 gate**：实际 HTTP handler 已完成鉴权、SQLite 操作和响应生成，随后只暂停发送；状态查询只返回 sequence、阶段、pending/issued 等布尔或计数，绝不返回被截留的资料、code 或凭据。按精确 sequence 释放，错误 sequence 返回冲突。用于迟到披露、code、state 和 grant receipt。
2. **提交前请求 gate**：实际 HTTP 已接收并解析，尚未执行 grant 事务；让 revoke 先提交，再恢复旧 grant，证明 CAS 在服务端拒绝旧决定。不能用 mock 替换 service，也不能把第一种 gate 当作事务竞争证明。

gate 必须有界，支持原调用取消、超时和服务关闭。清理先释放/终结 gate，再等待自有 HTTP server 关闭；不能为了通过测试遗留挂起请求。fixture 的 control、host bearer、client secret 和 business app bearer 不写日志、不进 guest。错误断言也只输出阶段、状态码、计数或布尔值。

| 必测场景 | 通过条件 |
| --- | --- |
| 旧 profile / phone 响应生成后撤回，再释放 | 活 owner 一次拒绝；没有 userInfo/code 成功、旧事件或旧 snapshot；手机号 backend 兑换也拒绝 |
| 旧同意请求在事务前暂停，先撤回再释放 | backend CAS 非 2xx；grant 保持 false；旧 UI 决定不能重新授权 |
| grant 已提交但 receipt 暂停，期间再撤回 | receipt 不被收养为新 revision；不能恢复 grant 或返回披露；重复 decision 也不能重放旧成功 |
| 弹窗、刷新、完成队列各阶段撤回 | 分别覆盖每个 await 与队列边界；原生 UI/HTTP 终结后预算释放，未终结资源明确 pending |
| 并发两个 refresh，版本/响应顺序相反 | 以每 kind 精确 revision 和权威 generation 收敛；不按 opaque 字符串排序；不无限重试 |
| 同范围两个 owner/客户端、合法升级包 | 撤回同 kind 的所有实例；其他 kind 保留；publisher/app/user/env 不同的实例不受影响 |
| 同用户新 epoch、不同用户、应用退出、账号删除 | 持久授权按最终迁移策略处理；旧 epoch challenge/code/请求拒绝；退出保留 consent；删除清理 durable domain |
| challenge 与 decision 重放、过期、串用、请求摘要改变 | 单次、归属、policy、idempotency 均由 SQLite 事务验证，错误请求不消耗别人的 challenge/code |
| policy 改变/删除、grant 到期、服务重启 | 对应 kind revision 单调、旧授权失效，revision 不因重启重置；另一个 kind 不受影响 |
| 新旧服务、新旧客户端、新旧 runtime 的组合 | 严格 app 的无 revision grant 永不成功；旧后端/旧产物明确不支持；不能自动退回 v1 |
| 拒绝、撤回或校验失败后，state 刷新也失败 | 原始拒绝/业务错误保留；native future 与 JS Promise 均终结；不留下旧成功快照 |
| 连续撤回/重新授权、换号、关闭与重载失败 | 最新决定有效；旧调用不继承到新 owner；清理失败可重试，不能恢复旧身份 |

验收分层记录，不能互相替代：

- 后端：Node.js 24、真实 loopback HTTP、SQLite 事务及重开，覆盖上表 CAS/旧客户端门禁；认证秘密只留服务端。
- 有限客户端回归：公开 native future、callback/Promise 顺序、取消和有界队列。受控 consent presenter 只证明生命周期，不能证明系统授权 UI。
- 真实 SDK 链路：从可安装归档全新安装，经过公开 SDK → native transport → QuickJS/V8 → 实际完成/事件 → JS，绑定 SDK、runtime 摘要与 OS。Web direct/Worker 分别记录。
- 组件与平台 UI：Desktop 当前完整 reference fixture 仅创建 Session，未附实际 View；不能把跳过手机号步骤的通过记录成组件呈现成功。须附真实原生 View、正常布局/呈现和按钮输入后再验收。Android/iOS/Harmony 同样要求真实按钮与宿主 UI；缺少平台条件时保留待验收。

执行命令与新增 gate/模式名称须在实现后写入证据，不能预填“通过”。已有入口包括参考服务 `node --test test/*.test.mjs`，Desktop CMake 的 `desktop_host_services_reference`、`desktop_host_services_backend_errors`，以及各端现有身份集成测试；已有错误投影测试通过不代表本设计完成。

每条记录绑定 API、kind/参数范围、源码提交、安装产物摘要、OS/浏览器、SDK、实际命令、断言结果和清理记录。缺外部通知、系统 UI、设备或归档条件的条目保持待验收；本文不会改变其状态。

<a id="implementation-dependencies-and-pending-items"></a>
## 实施依赖与待决项

持久域与 v2 HTTP 字段已按本文冻结并实现；`/v2/apps/profile` 为 POST，状态有效期字段为
`consentExpiresIn:{profile,phone}`。旧 epoch/v1 consent 不自动迁移，v2 重新授权；
应用可信域重绑定与 strict→legacy 降级均拒绝。下一步冻结新 runtime command/context
schema，再接入共享协调器与各 SDK。每批同步示例、文档、严格产物清单并用新归档验收；
历史产物与旧证据保留。

仍须明确共享 fence 在 native/runtime 的具体 wire schema，以及跨进程/设备通知是否要求
lease/ACK 及其恢复合同。旧授权没有可信映射时重新授权；如需迁移，另交付显式可信迁移入口。
在共享 fence、SDK 和各端验收完成前，不能把整个撤回合同标为已实现，也不能标记 goal 完成。
