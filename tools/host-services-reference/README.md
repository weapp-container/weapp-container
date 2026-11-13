<a id="host-account-and-payment-reference-backend"></a>
# 宿主账号与支付参考后端

**简体中文** · [English](README.en.md)


这是独立运行的 Node.js 24.22.2 ESM 服务，使用内置 `node:sqlite`，没有 npm 依赖。
它提供宿主身份、一次性小程序登录码、独立的资料/手机号授权、支付订单与验签回调的
可执行参考。代码沿用仓库根目录的许可；此包不单独授予额外商业使用权。

```sh
npm --prefix tools/host-services-reference test
npm --prefix tools/host-services-reference run demo
```

`demo` 在内存数据库中完成本地 reference 支付流程，只输出公开资料和订单，不输出
令牌或密钥。它不调用微信/支付宝，不代表发生真实交易。

<a id="local-business-example-service"></a>
## 本地业务示例服务

`HOST_DEMO_CONTROL_TOKEN` 通过后端/原生 debug 环境注入，至少 32 字符；不放入 pack、
guest 配置、URL 或命令行参数。`HOST_DEMO_PACK_ROOT` 是实际编译示例 pack 的完整
SHA-256 root。其他可注入变量为 `HOST_DEMO_PORT`（默认 8787）、
`HOST_DEMO_HOST_APP_ID`、`HOST_DEMO_TENANT_ID`、`HOST_DEMO_PUBLISHER_ID`、
`HOST_DEMO_APP_ID`、`HOST_DEMO_ENVIRONMENT`。默认应用为 `host-services-demo`、环境 develop。

```sh
node tools/host-services-reference/scripts/demo-business-server.mjs
```

此服务只监听 127.0.0.1，校验实际 loopback Host；默认拒绝有 Origin 的请求。Web
调试可以用 `HOST_DEMO_ALLOWED_ORIGINS` 显式列出完整 origin（逗号分隔），仅向这些
origin 返回 CORS。Android 模拟器使用任务专属 `adb reverse tcp:8787 tcp:8787`，
原生 debug target 只对 loopback 开放明文；结束测试删除该 reverse。iOS 模拟器使用
同一 loopback origin 和 debug 专属 ATS local networking 配置。不要关闭全局网络安全策略。

| 路径 | 调用方 | 合同 |
| --- | --- | --- |
| `POST /demo/host` | 原生，control bearer | `{principalId:"demo-A"或"demo-B",principalEpoch:十进制字符串}` → `hostAccessToken,application,account`；只模拟开发账号 |
| `POST /demo/login` | guest/业务客户端 | `{code}` → `businessSession,appUserId,expiresIn`；app bearer 留在业务服务内存 |
| `POST /demo/orders` | guest/业务客户端 | `{businessSession,productId:"reference-item",idempotencyKey}` → 服务端固定 1 分的 reference 订单；不返回 launch |
| `GET /demo/orders/:id` | businessSession bearer | 查询本账号订单状态 |
| `POST /demo/phone` | guest/业务客户端 | `{businessSession,code}` → 已明确授权、与当前业务用户匹配的手机号；错用户不会消耗别人的码 |
| `POST /demo/logout` | guest/业务客户端 | `{businessSession}` → 退出该 app，保留宿主账号 |
| `POST /demo/reference-confirm` | 原生，control bearer | `{hostAccessToken,orderId,selection}` → 先校验可信账号和订单，再由后端签名处理 reference 通知；只能确认 reference 订单 |

`selection` 包含 `miniAppId,packRoot,expectedPrincipalId,expectedPrincipalEpoch`。
`/v1/host/*` 与订单 launch 仍使用宿主 bearer。正式微信/支付宝失败不会回退 reference。
示例服务每次启动创建临时密钥和内存数据库；不提供真实宿主登录、手机号核验或资金交易。
Android/iOS 的可编译安装示例位于各 SDK 的 `examples/host-services/`。

<a id="startup-and-configuration"></a>
## 启动和配置

将 `config.example.mjs` 复制到后端的私有配置目录，设置环境变量，再启动：

```sh
pnpm --dir tools/host-services-reference build
HOST_SERVICES_CONFIG=/absolute/private/config.mjs \
  npm --prefix tools/host-services-reference start
```

配置中的 issuer、pairwise ID、app client 和 reference callback secret 分别生成，均至少
32 字符，并在后端密钥管理中保存。`identitySecret` 需稳定保存；轮换会改变各小程序的
用户标识。`database` 指向持久存储；SQLite 文件及 WAL 含个人资料和令牌哈希，按后端
私有数据管理。示例默认绑定 `127.0.0.1:8787`；公网使用时在宿主现有后端接入 TLS、
身份网关、限流、审计、备份和数据保留策略。此处没有公网部署脚本。

每个 `applications` 项是**服务端注册**的小程序，包含 `miniAppId`、宿主/租户/环境、
独立 `clientId` / `clientSecret`、经验证的 pack SHA-256 根和允许的支付通道。
新注册默认 `identityProtocol:"2.0"`，还必须登记可信 `publisherId`；示例配置显式使用
这两个字段。已有 v1 客户端须显式配置 `identityProtocol:"1.0"`，不会自动获得 v2
撤回保证。本地原生/浏览器业务夹具仍明确使用 legacy v1；独立 `demo` 展示 v2 后端调用。
一个服务实例中的 `miniAppId` 全局唯一。`miniAppId` 对应 runtime 可信安装信息的
`application.appId`；宿主、租户和环境也必须与安装上下文一致，环境使用
`develop`、`trial` 或 `release`。注册表与 pack allowlist 由运营后端维护，不从 guest 更新。
调用端将 Rust `u64` account epoch **转成十进制字符串**传入 `principalEpoch`，避免
JavaScript JSON number 丢失精度；值域为 `1..18446744073709551615`。

下述 v1 调用说明只适用于显式 legacy app。`authorizationPolicies.profile` / `.phone` 分别配置 `{purpose,permissionVersion}`，用途
来自服务端注册表，不能使用 guest 自报的说明替代。未配置某类 policy 时该类授权
不可申请，静默登录仍可使用。原生先请求 `/v1/host/authorization-policy`，展示返回的
用途，用户确认后将同一 `purpose`、`permissionVersion` 传回 `/v1/host/consents`。
弹窗期间 policy 变化返回 `authorization_policy_changed`，必须重新展示并取得确认；
不能自动接受新版本。拒绝/撤销使用 `granted:false`，不要求旧 policy 仍存在。

示例仅启用 reference 通道。启用微信或支付宝时还要在该 app 的
`allowedPaymentChannels` 中显式加入 `wechat` / `alipay`。真实通道失败时不会退回 reference。

<a id="strict-v2-authorization-protocol"></a>
## 严格 v2 授权协议

v2 后端已实现 SQLite 原子授权前提；SDK/运行时共享授权 fence 和跨进程通知仍待接入。
它不能收回已经生成并进入网络的资料响应。不能仅凭 v2 HTTP 成功宣称旧结果不会进入 JS。
完整设计和未完成边界见 [授权撤回合同](../../docs/host-services/consent-revocation-design.md)。

持久授权按 `(hostAppId,tenantId,publisherId,principalId,miniAppId,environment,kind)` 分区；
合法升级和同用户新 epoch 保留授权。host bearer、challenge、手机号 code 仍绑定执行 epoch
和可信安装。旧 v1 哈希记录无法还原完整授权域，v2 要求重新授权，不猜测迁移；pairwise
app user ID 算法保持原合同。持久注册表拒绝应用可信域重绑定和 strict→legacy 降级。

host 请求均为 POST，携带完整可信选择
`miniAppId,packRoot,expectedPrincipalId,expectedPrincipalEpoch,expectedPublisherId`。
后端分别校验 bearer、注册表和当前可信包，不接受 guest 选择身份。请求拒绝未知字段；
进程内调用也拒绝继承协议字段、accessor 和 Proxy。所有 2xx 包含 `identityProtocol:"2.0"`。

| 路径 | 请求增量 | 结果 |
| --- | --- | --- |
| `/v2/host/identity-capabilities` | 无 | 精确 `identityProtocol:"2.0",consentRevision:"1.0",scopeSchema:"2.0"`、kind 和 256 KiB 请求/响应上限 |
| `/v2/host/authorization-policy` | `kind` | 当前用途/版本、`revision,challengeId,expiresIn`；challenge 最长 60 秒且不超过 host session |
| `/v2/host/consents` | `kind,granted,decisionId`；grant 还需 `challengeId,expectedRevision,purpose,permissionVersion` | `kind,granted,revision,decisionId`；grant 带剩余授权有效期 |
| `/v2/host/identity-state` | 无 | 四项状态、opaque `authorizationVersion`、`consentRevisions`、`consentExpiresIn`；仅有效资料授权带公开 `userInfo` |
| `/v2/host/profile` | `expectedConsentRevision` | `kind:"profile",revision,userInfo` |
| `/v2/host/phone-codes` | `expectedConsentRevision` | `kind:"phone",revision,code,expiresIn` |
| `/v2/apps/profile` | app bearer；`expectedConsentRevision` | 同资料合同，作用域来自已认证 session |
| `/v2/apps/exchange-phone` | confidential client Basic；`code,appAccessToken` | 同用户/应用/epoch/包、有效 phone revision 的已验证号码；错归属不消耗他人 code |

revision 为规范十进制 u64 字符串，SQLite TEXT + BigInt 比较，不经 number/浮点；
初始 `"0"`，上限拒绝写入且不回绕。事务内校验一次性 challenge、当前 policy 和 revision，
再授予并提升 revision。`granted:false` 不要求旧 challenge/policy，仍提升对应 kind revision，
使旧 UI 决定失效。policy 变更/删除、授权到期也单调提升 revision，重启不归零；
两个活 service 读取同一数据库的当前 policy/可信包，不使用旧内存 policy 继续授权。

`decisionId` 是可信宿主生成的至少 128 位随机 base64url 标识，22–128 字符。相同 ID
和完全相同请求可重放当前提交；请求改变返回 `consent_decision_conflict`，被后续决定
取代返回 `consent_decision_superseded`。缺前提为 428，challenge 失效为 401，revision/policy
冲突为 409。客户端不能自动取得新 revision 后重提旧“允许”；须重新展示用途并取得决定。

严格 app 的 v1 grant、policy、identity-state、资料及手机号发码/兑换（含直接方法）均返回
426 `identity_protocol_required`。v1 deny-only 入口在事务内重新认证并推进同一 v2 revision；
v1 登录、查会话、应用退出保留。旧 runtime/客户端尚无本批 fence 能力，不得静默降级。
challenge、decision、revision 检查数据留在可信宿主/后端，不能把 backend object 原样交 guest。

<a id="trust-and-account-lifecycle"></a>
## 信任与账号生命周期

| 调用方 | 所持凭据 | 可执行操作 |
| --- | --- | --- |
| 宿主身份后端 | issuer secret | 根据自身已验证登录签发宿主短期 bearer、递增 principal epoch |
| 可信原生宿主 | 宿主短期 bearer | 为匹配安装的 app 申请登录码、确认/撤销授权、申请手机号码、获取本用户订单 launch |
| 小程序业务后端 | 该 app 的 confidential client secret；交换后的 app bearer | 交换码、读取已授权资料、创建/查询自己的订单、退出 app |
| 小程序 guest | 一次性 app 登录码或手机号码；业务订单 ID | 交给自己的业务后端交换/处理；不持有以上长期凭据 |
| 支付平台 | 自身签名私钥 | 向固定 callback URL 发送验签后接收的交易通知 |

issuer endpoint 是**后端到后端**入口。原生 App 不持有 issuer secret，不自行声明
principal/profile/phone；宿主现有身份后端验证实际登录后才调用签发接口，并将短期
host bearer 安全交付原生宿主。资料和号码来自这份可信快照，原生授权接口不能上传
任意号码。此服务没有实现短信验证、微信 OAuth、Apple 登录或宿主的真实账号系统。

宿主 bearer 只交给可信原生代码，不能进入 guest bridge。guest 的 `wx.login` 经
native handler 取得 app-specific、60 秒有效、单次使用的 `code`；业务后端用自己的
client secret 交换 app session。错误 app 的交换不会消耗别人的码。app bearer 最长
1 小时，且不会超过父 host session；app 用户标识按宿主、租户、用户、app、环境生成
pairwise HMAC，不暴露跨 app 的宿主 principal ID。

宿主已有登录可静默复用，但**不自动授予资料或手机号**。可信 native handler 应展示
明确授权 UI；确认后才调用 `host/consents`。后端将原生宿主视为可信授权执行者，
不会声称 bearer 本身证明已发生一次真实 UI 点击。`profile` 和 `phone` 是独立授权，
最长 30 天；资料接口只返回 `nickName` / `avatarUrl`。手机号先取得独立的一次性码，
再由该 app 后端交换；撤销或重新授权会使此前手机号码失效。
HTTP `/v1/apps/exchange-phone` 强制要求该 app 当前业务会话的 `appAccessToken`，防止同一
业务后端把被盗的一次性码交给另一位用户；只有受信的进程内 `HostServices` 调用才保留
省略第四参数的兼容形式，不能作为公网接口使用。
授权记录同时绑定注册用途和权限版本；任何一个变化后旧授权立即不再允许披露，
已有 app 登录保持。此前没有用途/版本字段的历史记录也需要重新授权，不自动升级。

app logout 撤销同一宿主、租户、principal、epoch、环境下该 app 的所有 session 和待交换码
（包括同一用户的其他 host token 所签发者），保留宿主登录及
既有 consent。显式撤销授权用 `granted: false`。host logout 撤销本 host session 的
全部后代；`principal-epochs` 递增 epoch 后，该宿主/租户/用户/环境下所有旧 epoch
session 失效，不能用旧 epoch 重新登录。这是服务端撤销，与 SDK 的本地账号切换、
旧实例取消/关闭及存储 namespace 切换共同使用，不能替代本地生命周期隔离。
账号删除使用 issuer 的 `principal-delete`，在提升 epoch 的同一事务中删除该 principal
在本参考服务中的宿主、应用会话、登录/手机号 code、授权记录、订单和已记录的支付事件；
其他 principal 不受影响。删除是不可恢复的数据清理，业务后端仍须按自身保留策略处理外部账号、
日志和支付平台记录，并向支付平台查询/撤销尚未完成的交易。

<a id="http-contract"></a>
## HTTP 合同

JSON 请求使用 `Content-Type: application/json`；响应禁止缓存。请求体最大 256 KiB。
除注明外均为 `POST`。`H` 表示 `Authorization: Bearer <host token>`，`A` 表示 app
bearer，`I` 表示 issuer secret bearer，`C` 表示 `Basic base64(clientId:clientSecret)`。
Basic 凭据和 app bearer 仅用于业务后端连接。所有 native 选择请求在 `{miniAppId,packRoot}`
之外还必须携带可信上下文中的 `expectedPrincipalId` 与十进制字符串 `expectedPrincipalEpoch`，
后端将其与 bearer 的账号绑定核对，防止账号切换后错用旧 token。

| 路径 | 身份 | 请求与结果 |
| --- | --- | --- |
| `/v1/issuer/host-sessions` | I | `{hostAppId,tenantId,environment,principalId,principalEpoch,profile?,phone?,expiresIn?}` → `hostAccessToken,expiresIn,principalEpoch`；TTL 1–86400 秒 |
| `/v1/issuer/principal-epochs` | I | 同上身份字段和更大 `principalEpoch` → 新 epoch |
| `/v1/issuer/principal-delete` | I | 同上身份字段和更大 `principalEpoch` → 删除该宿主/租户/用户/环境的本地参考服务数据并提升 epoch；旧 host/app bearer、登录码、订单和支付事件立即失效；不可恢复 |
| `/v1/host/identity-state` | H | 可信选择 → `hostLoggedIn,appLoggedIn,profileAuthorized,phoneAuthorized,authorizationVersion,userInfo?`；仅存在已兑换且有效的 app session 才将 appLoggedIn 设为 true |
| `/v1/host/check-session` | H | 可信选择 → 校验当前 app session；发码而未兑换不算登录 |
| `/v1/host/authorization-policy` | H | 可信选择及 `kind:"profile"\|"phone"` → `kind,purpose,permissionVersion`，供原生确认 UI |
| `/v1/host/login-codes` | H | `{miniAppId,packRoot}` → `code,expiresIn` |
| `/v1/apps/exchange-login` | C | `{code}` → `accessToken,tokenType,expiresIn,appUserId` |
| `/v1/host/consents` | H | `{miniAppId,packRoot,kind:"profile"\|"phone",granted:boolean,purpose?,permissionVersion?}` → consent receipt；授予时必须携带 UI 已确认的当前 policy |
| `/v1/apps/profile` (`GET`) | A | 返回已授权的公开资料 |
| `/v1/host/profile` | H | `{miniAppId,packRoot}` → 已明确授权的公开资料，供可信 native handler 交付 guest |
| `/v1/host/phone-codes` | H | `{miniAppId,packRoot}` → `code,expiresIn`；需要 phone consent |
| `/v1/apps/exchange-phone` | C | `{code,appAccessToken}` → `phoneNumber`；`appAccessToken` 必须是该 app 当前业务用户的 bearer，服务端会校验手机号 code 与其宿主/租户/principal/epoch/app 完全一致；后端再按自身业务策略交付 guest |
| `/v1/apps/logout` | A | 退出本 app，保留 host session |
| `/v1/host/app-logout` | H | `{miniAppId,packRoot}` → native 退出指定 app，保留 host session |
| `/v1/host/logout` | H | 退出本 host session |
| `/v1/payments/orders` | A | 服务端订单参数，见下文 → order |
| `/v1/payments/orders/:id` (`GET`) | A | 读取本 app、本用户、本 epoch 订单 |
| `/v1/payments/orders/:id/launch` | H | `{miniAppId,packRoot}` → 属于当前宿主用户/安装 app 的 launch |
| `/v1/payments/orders/:id/reconcile` | A | 向真实渠道签名查询并验签结果；reference 无查询渠道 |
| `/v1/payments/orders/:id/cancel-wait` | A | 标记客户端停止等待；不关闭/退款交易 |
| `/v1/payments/callbacks/reference` | HMAC | 原始 JSON 与 `x-reference-timestamp/signature`，返回 JSON acknowledgement |
| `/v1/payments/callbacks/wechat` | 微信平台 RSA | 原始加密 JSON；成功持久化后 `204` |
| `/v1/payments/callbacks/alipay` | 支付宝 RSA2 | 原始 URL-encoded form；成功持久化后返回字面量 `success` |

HTTP 错误是 `{error,message}`，不返回凭据、平台原始响应、个人号码或密钥。
`401` 表示凭据/码失效，`403` 表示 scope/consent 不满足，`409` 表示幂等或事件冲突。
其他路径 `404`；健康检查为 `GET /health`。未实现 CORS，页面不能据此直接调用敏感入口。

<a id="payment-and-native-integration"></a>
## 支付与 native 对接

业务后端按自身商品/金额/买方身份创建订单，不能把 guest 传入金额直接作为权威金额：

```json
{
  "idempotencyKey": "business-order-123",
  "channel": "wechat",
  "product": "app",
  "amount": 123,
  "currency": "CNY",
  "description": "由业务后端确定的商品"
}
```

`amount` 为整数分，当前仅支持 CNY。微信 JSAPI 的 `paymentContext.openid`、支付宝
JSAPI 的 `paymentContext.buyerId` 来自业务后端已验证的平台身份；不能使用容器的
pairwise app user ID 代替。微信 H5 需要后端确定的 `paymentContext.payerClientIp`。

业务后端将 `orderId` 给 guest。native payment handler 只接收该服务端订单 ID，
从冻结的可信安装/账号上下文调用 `/launch`，再按 launch `kind` 分派给平台原生 SDK。
只有 `wechat-app` / `alipay-app` 才用于对应原生 APP SDK；JSAPI/H5/QR 使用各自
官方能力，不把 prepay ID、二维码或 H5 URL 伪装成原生 APP 参数。
服务提供**后端合同和支付 launch 参数**；iOS/Android 的真实 SDK、URL Scheme、
Universal Links、签名和回跳由宿主平台实现，不能把本服务的测试当作设备验收。

| 产品 | 微信 v3 | 支付宝 RSA2 | 返回 kind |
| --- | --- | --- | --- |
| `app` | `/v3/pay/transactions/app`，APP 专用签名最后一行为原始 prepay ID | `alipay.trade.app.pay` / `QUICK_MSECURITY_PAY` | `wechat-app` / `alipay-app` |
| `jsapi` | `/v3/pay/transactions/jsapi`，JSAPI 签名使用 `prepay_id=...` | `alipay.trade.create`，返回 trade number | `wechat-jsapi` / `alipay-jsapi` |
| `h5` | `/v3/pay/transactions/h5` | `alipay.trade.wap.pay` / `QUICK_WAP_WAY` | `wechat-h5` / `alipay-h5` |
| `native` | `/v3/pay/transactions/native`，二维码支付 | `alipay.trade.precreate`，二维码支付 | `wechat-qr` / `alipay-qr` |

同一 app/用户/epoch 的同一幂等键与相同参数复用同一持久化订单，不同参数返回 409。
外部请求前先写入订单；并发或重启后的重试不会重新提交新商户单号。网络失败返回
`payment_submission_uncertain`，原订单保留 `uncertain`：按幂等键重取后再查询渠道。
提交状态 `submission` 与财务状态 `status` 独立；初次请求不确定时，后续可信回调仍
可将财务状态推进为 paid。native 成功/取消回调不直接标记付款，业务以此后端的
验签查询/通知为准。SDK account switch 取消等待不会退款，也不会阻止已提交交易最终入账。

微信 HTTP 请求使用 API v3 RSA Authorization；HTTP 响应也按已配置平台序列号验签。
通知先验证原始 JSON 的平台签名和 5 分钟时间窗口，再用 32 字节 API v3 key 进行
AES-256-GCM 认证解密。平台证书/公钥由后端显式 pin；不自动信任下载到的新证书，
生产运维需要按微信官方流程更新 allowlist 和轮换密钥。

支付宝请求签名前排序包含 `sign_type` 的原始字段，签名后才 URL encode；通知验签
排序 decoded fields 并排除 `sign`/`sign_type`，只接受 RSA2，拒绝重复 form 字段。
服务端响应验证**原始嵌套 JSON value 字节**，不经 parse/stringify 重建。
可配置官方生产网关或支付宝官方 sandbox 网关；不支持证书模式，仅显式公钥模式。

所有渠道核对商户/app、商户订单号、精确分金额、币种和交易号。通知 event ID 与
authenticated payload hash 持久绑定；重复事件只确认一次，另一个事件 ID 指向
已付款交易也不会再次产生 `becamePaid`。已付款不被较晚的 pending/closed 回调降级；
创建请求晚于通知返回也不会覆盖已付款状态。实际发货需业务后端自己的持久幂等
订单/发货账本；此参考服务没有跨服务原子发货、退款 API、对账调度或 outbox。

<a id="validation-scope"></a>
## 验证范围

`npm test` 覆盖真实 loopback HTTP、SQLite 重开、host/app/epoch/pack 隔离、码过期/
单次使用/错误 app 不消耗、独立 consent 与撤销、用途/版本变更及待兑换码失效、退出、订单所有权和并发幂等、
通知重复/冲突/乱序/先于 create 返回、超时不盲目重提、微信请求/APP/JSAPI/响应
RSA 及 AES-GCM、支付宝 RSA2 request/notify/raw JSON response 和防篡改。
平台测试使用即时生成 RSA 测试密钥和注入 fetch，完全不接触真实商户。

尚需真实商户凭据、产品开通及 iOS/Android 签名宿主来验收：实际预下单、平台支付 UI、
回跳、真实回调、支付后查询、商户对账和设备账号切换。不在没有凭据时声称交易通过。
参考后端也不提供自动证书更新、分布式锁、后台重试任务、真实账号/手机号验证、
生产数据库迁移和支付平台 SDK；这些沿宿主现有后端与发布体系补齐。

官方接口依据：[微信支付文档](https://pay.weixin.qq.com/doc/v3/merchant/4012062524)、
[支付宝开放平台 API](https://opendocs.alipay.com/apis)。产品权限、平台 SDK 和商户上线
仍按各平台当前要求配置。
