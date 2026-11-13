<a id="宿主账号与支付参考后端"></a>
# Host Account and Payment Reference Backend

[简体中文](README.md) · **English**


This is a standalone Node.js 24.22.2 ESM service using built-in `node:sqlite`, with no npm dependencies.
It provides host identity, one-time mini-program login codes, independent profile/phone number authorization, payment order processing, and signature verification callback.
The code follows the license from the root directory of the repository; this package does not grant additional commercial usage rights separately.

```sh
npm --prefix tools/host-services-reference test
npm --prefix tools/host-services-reference run demo
```

`demo` Completes a local reference payment flow in an in-memory database, outputting only public data and orders, without outputting tokens or keys. It does not integrate with WeChat/Alipay and does not represent a real transaction.

<a id="本地业务示例服务"></a>
## Local Business Example Service

`HOST_DEMO_CONTROL_TOKEN` is injected via backend/native debug environment, at least 32 characters long; not included in pack, guest configuration, URL, or command line arguments. `HOST_DEMO_PACK_ROOT` is the complete SHA-256 root of the actual compiled example pack. Other injectable variables are `HOST_DEMO_PORT` (default 8787), `HOST_DEMO_HOST_APP_ID`, `HOST_DEMO_TENANT_ID`, `HOST_DEMO_PUBLISHER_ID`, `HOST_DEMO_APP_ID`, `HOST_DEMO_ENVIRONMENT`. Default application is `host-services-demo`, environment: develop.

```sh
node tools/host-services-reference/scripts/demo-business-server.mjs
```

This service only listens to 127.0.0.1, verifying the actual loopback host; it defaults to rejecting requests with an Origin. Web
Debugging can explicitly list complete origins via `HOST_DEMO_ALLOWED_ORIGINS` (comma-separated), returning CORS only to these origins. Android emulators use task-specific `adb reverse tcp:8787 tcp:8787`, while native debug targets only allow plaintext for loopback; remove the reverse upon test completion. iOS simulators use the same loopback origin and debug-specific ATS local networking configuration. Do not disable global network security policies.

| Path | Caller | Contract |
| --- | --- | --- |
| `POST /demo/host` | native, control bearer | `{principalId:"demo-A"或"demo-B",principalEpoch:十进制字符串}` → `hostAccessToken,application,account`; simulates only development accounts |
| `POST /demo/login` | guest/business client | `{code}` → `businessSession,appUserId,expiresIn`; app bearer stays in business service memory |
| `POST /demo/orders` | guest/business client | `{businessSession,productId:"reference-item",idempotencyKey}` → server fixed 1-minute reference order; does not return launch |
| `GET /demo/orders/:id` | businessSession bearer | query order status for current account |
| `POST /demo/phone` | guest/business client | `{businessSession,code}` → an explicitly authorized phone number matching the current business user; a mismatched user does not consume someone else’s code |
| `POST /demo/logout` | guest/business client | `{businessSession}` → logout from the app, retain host account |
| `POST /demo/reference-confirm` | Native, control bearer | `{hostAccessToken,orderId,selection}` → First verify the trusted account and order, then the backend signs the reference notification; can only confirm the reference order |

`selection` contains `miniAppId,packRoot,expectedPrincipalId,expectedPrincipalEpoch`.
`/v1/host/*` continues to use host bearer for order launch. Official WeChat/Alipay failures will not fall back to reference.
Each example service creates a temporary key and an in-memory database upon startup; it does not provide real host login, phone number verification, or financial transactions.
Android/iOS compile-installation examples are located in the `examples/host-services/` directory of each SDK.

<a id="启动和配置"></a>
## Startup and Configuration

Copy `config.example.mjs` to the backend's private configuration directory, set environment variables, and start:

```sh
pnpm --dir tools/host-services-reference build
HOST_SERVICES_CONFIG=/absolute/private/config.mjs \
  npm --prefix tools/host-services-reference start
```

In the configuration, the issuer, pairwise ID, app client, and reference callback secret are each generated and are at least 32 characters long, and are saved in the backend key management. `identitySecret` must be preserved stably; rotation will change the user identities of each mini-program. `database` points to persistent storage; SQLite files and WAL contain profile information and token hashes, managed according to backend private data policies. The example defaults to binding `127.0.0.1:8787`; when used over the public internet, TLS, identity gateway, rate limiting, auditing, backup, and data retention policies are integrated into the host's existing backend infrastructure. There is no public internet deployment script provided here.

Each `applications` entry is a **server-side registered** mini-app, containing `miniAppId`, host/tenant/environment,
independent `clientId` / `clientSecret`, verified pack SHA-256 root and allowed payment channels.
New registrations default to `identityProtocol:"2.0"`, and must also register a trusted `publisherId`; example configuration explicitly uses these fields. Existing v1 clients must explicitly configure `identityProtocol:"1.0"`, and will not automatically receive v2 revocation guarantees. Local native/browser stubs continue to use legacy v1; independent `demo` showcases v2 backend calls.
The `miniAppId` is globally unique within a service instance. The `miniAppId` corresponds to the runtime's trusted installation information under `application.appId`; the host, tenant, and environment must also match the installation context, with environment using `develop`, `trial`, or `release`. The registration table and pack allowlist are maintained by operations backend and are not updated from guest.
The calling end converts the Rust `u64` account epoch **into a decimal string** and passes it into `principalEpoch`, to avoid loss of precision from JavaScript JSON numbers; the value range is `1..18446744073709551615`.

The following v1 call specifications apply only to explicit legacy app. `authorizationPolicies.profile` / `.phone` are respectively configured with `{purpose,permissionVersion}`, where the purpose
comes from the server-side registry and cannot be replaced by guest-provided justifications. When a certain policy is not configured, authorization for that type cannot be requested, though silent login remains available. Native code first requests `/v1/host/authorization-policy` to display the purpose returned, and upon user confirmation, submits the same `purpose` and `permissionVersion` to `/v1/host/consents`. During the popup, if the policy changes, a `authorization_policy_changed` is returned, requiring re-display and user confirmation; new versions cannot be automatically accepted. Rejection or revocation uses `granted:false`, with no requirement that the old policy still exists.

The example only enables the reference channel. When enabling WeChat or Alipay, you must explicitly add `wechat` / `alipay` to the `allowedPaymentChannels` of the app. On channel failure, no refund will be issued for the reference channel.

<a id="严格-v2-授权协议"></a>
## Strict v2 Authorization Protocol

v2 backend has implemented SQLite atomic authorization premise; SDK/runtime shared authorization fence and cross-process notifications are still pending integration.
It cannot recall data responses already generated and entered the network. It cannot solely rely on v2 HTTP success to claim that old results will not enter JS.
Complete design and unfinished boundaries are available in [Authorization Revocation Contract](../../docs/host-services/consent-revocation-design.en.md).

Persistent authorization is partitioned by `(hostAppId,tenantId,publisherId,principalId,miniAppId,environment,kind)`;
Valid upgrades and new epoch authorizations for the same user are retained. host bearer, challenge, and phone number code remain bound to the execution epoch and trusted installation. Old v1 hash records cannot reconstruct the full authorization domain; v2 requires reauthorization and does not assume migration; the pairwise app user ID algorithm retains the original contract. The persistent registration table rejects rebinding of application trusted domains and strict→legacy downgrade.

host requests are all POST and carry the complete trusted selection
`miniAppId,packRoot,expectedPrincipalId,expectedPrincipalEpoch,expectedPublisherId`.
The backend separately validates bearer, the registry, and the current trusted package, and does not accept guest-selected identities. Requests reject unknown fields;
in-process calls also reject inheritance of protocol fields, accessor, and Proxy. All 2xx responses include `identityProtocol:"2.0"`.

| Path | Request Increment | Result |
| --- | --- | --- |
| `/v2/host/identity-capabilities` | none | exact `identityProtocol:"2.0",consentRevision:"1.0",scopeSchema:"2.0"`、kind and 256 KiB request/response size limit |
| `/v2/host/authorization-policy` | `kind` | Current usage/version, `revision,challengeId,expiresIn`; challenge maximum 60 seconds and no more than host session |
| `/v2/host/consents` | `kind,granted,decisionId`；grant requires `challengeId,expectedRevision,purpose,permissionVersion` | `kind,granted,revision,decisionId`；grant with remaining authorization validity period |
| `/v2/host/identity-state` | none | four-state, opaque `authorizationVersion`, `consentRevisions`, `consentExpiresIn`; valid only with public `userInfo` in authorized data |
| `/v2/host/profile` | `expectedConsentRevision` | `kind:"profile",revision,userInfo` |
| `/v2/host/phone-codes` | `expectedConsentRevision` | `kind:"phone",revision,code,expiresIn` |
| `/v2/apps/profile` | app bearer; `expectedConsentRevision` | Same as data contract, scope comes from authenticated session |
| `/v2/apps/exchange-phone` | confidential client Basic; `code,appAccessToken` | Verified phone number for the same user/app/epoch/pack and a valid phone revision; ownership mismatches do not consume someone else’s code |

revision is a normalized decimal u64 string, SQLite TEXT + BigInt comparison performed without number/float conversion;
initial value is `"0"`, write operations to upper limit are rejected and no wraparound occurs. Within a transaction, a one-time challenge, current policy, and revision are validated, then the revision is granted and incremented. `granted:false` does not require the old challenge/policy, still increments the revision for the corresponding kind, rendering the old UI decision invalid. Policy changes/deletions and authorization expirations also monotonically increase revision; upon restart, revision does not reset to zero;
two active services reading the current policy/trusted package from the same database, do not use the old in-memory policy for further authorization.

`decisionId` is a base64url-encoded random identifier, at least 128 bits, generated by the trusted host, 22–128 characters long. The same ID and an identical request can be replayed to submit the current decision; if the request changes, it returns `consent_decision_conflict`, and if a subsequent decision is made, it returns `consent_decision_superseded`. Default status is 428, challenge expires with 401, revision/policy conflict returns 409. The client cannot automatically re-submit an old "allow" after a new revision; it must re-present the purpose and obtain a new decision.

Strictly, the v1 grant, policy, identity-state, profile, and phone number verification/swap (including direct methods) all return
426 `identity_protocol_required`. The v1 deny-only entry re-authenticates within the transaction and advances to the same v2 revision;
v1 login, session query, and app exit are retained. Old runtime/client lacks the fence capability of this batch, and silent downgrade is not permitted.
Challenge, decision, and revision check data remain within the trusted host/backend and must not pass the backend object intact to the guest.

<a id="信任与账号生命周期"></a>
## Trust and Account Lifecycle

| Caller | Credentials held | Operations allowed |
| --- | --- | --- |
| Host Identity Backend | issuer secret | Issues host short-lived bearer tokens, incrementing principal epoch upon verified login |
| Trusted Native Host | Host Short-term Bearer | Apply for login code for installed app, confirm/revoke authorization, apply for phone number, retrieve user's order launch |
| Mini-program business backend | The app's confidential client secret; the app bearer obtained after exchange | Exchange code, retrieve authorized user information, create/query own orders, exit app |
| MiniProgram guest | one-time app login code or phone number; business order ID | passes to its business backend for exchange/processing; does not hold the above long-term credentials |
| Payment Platform | Own signature private key | Sends transaction notification after signing to a fixed callback URL and receives it |

issuer endpoint is the **backend-to-backend** entry point. Native apps do not hold issuer secrets nor do they self-declare principal/profile/phone; the host's existing identity backend validates actual login before invoking the issuance interface, and securely delivers a short-lived host bearer token to the native host. The information and phone numbers come from this trusted snapshot, and the native authorization interface cannot upload arbitrary numbers. This service does not implement SMS verification, WeChat OAuth, Apple Login, or the host's real account system.

bearer host only passes to trusted native code and cannot enter guest bridge. The guest's `wx.login` is handled by native handler to obtain an app-specific, 60-second valid, one-time-use `code`; the business backend exchanges the app session using its own client secret. Incorrect app exchange will not consume another app's code. The app bearer is at most one hour long and does not exceed the parent host session; app user identifiers are generated via pairwise HMAC using host, tenant, user, app, and environment, without exposing the host principal ID across apps.

The host already has login credentials that can be silently reused, but **no data or phone number is automatically granted**. A trusted native handler should display
a clear authorization UI; only after confirmation should it call `host/consents`. The backend treats the native host as a trusted authorization actor,
and will not claim that the bearer itself proves a real UI click occurred. `profile` and `phone` are independently authorized, with a maximum duration of 30 days; the profile interface only returns `nickName` / `avatarUrl`. The phone number first obtains an independent one-time code, then exchanged by the app backend; revocation or reauthorization will invalidate the previous phone number.
HTTP `/v1/apps/exchange-phone` strictly requires the current business session's `appAccessToken`, preventing a business backend from passing a stolen one-time code to another user; only trusted in-process `HostServices` calls are retained.
The compatibility form omitting the fourth parameter is not available for public use.
Authorization records are simultaneously bound to registration purposes and permission versions; once any change occurs, the old authorization immediately stops allowing disclosure, and existing app logins are preserved. Historical records without purpose/version fields also require reauthorization and are not automatically upgraded.

app logout revokes all sessions and pending code exchanges for this app within the same host, tenant, principal, epoch, and environment (including sessions issued by other host tokens belonging to the same user), while preserving host login and existing consent. Explicit revocation of authorization is done via `granted: false`. host logout revokes all descendant sessions of the current host; after incrementing `principal-epochs`, all previous epoch sessions for the host/tenant/user/environment become invalid and cannot be reauthenticated using the old epoch. This is a server-side revocation, used in conjunction with SDK-local account switching, cancellation/closing of old instances, and namespace switching, and cannot replace local lifecycle isolation. Account deletion uses the issuer's `principal-delete`, which deletes the principal's host, app sessions, login/phone number code, authorization records, orders, and recorded payment events within this reference service during the same epoch-incrementing transaction; all other principals are unaffected. Deletion is irreversible data cleanup, and backend services must still handle external account, log, and payment platform records according to their own retention policies, and must query or revoke pending transactions from the payment platform.

<a id="http-合同"></a>
## HTTP Contract

JSON request uses `Content-Type: application/json`; responses must not be cached. Request body size limit is 256 KiB.
All entries are `POST` unless otherwise specified. `H` denotes `Authorization: Bearer <host token>`, `A` denotes app bearer, `I` denotes issuer secret bearer, `C` denotes `Basic base64(clientId:clientSecret)`.
Basic credentials and app bearer are used only for business backend connections. All native request selections must include `expectedPrincipalId` and a decimal string `expectedPrincipalEpoch` from the trusted context in addition to `{miniAppId,packRoot}`, and the backend will verify these against the account bound to the bearer to prevent misuse of old tokens after account switching.

| Path | Identity | Request and Response |
| --- | --- | --- |
| `/v1/issuer/host-sessions` | I | `{hostAppId,tenantId,environment,principalId,principalEpoch,profile?,phone?,expiresIn?}` → `hostAccessToken,expiresIn,principalEpoch`; TTL 1–86400 seconds |
| `/v1/issuer/principal-epochs` | I | Same identity field and larger `principalEpoch` → new epoch |
| `/v1/issuer/principal-delete` | I | Same principal field and larger `principalEpoch` → Delete local reference service data for the host/tenant/user/environment and increment epoch; old host/app bearer, login tokens, orders, and payment events become immediately invalid; irreversible |
| `/v1/host/identity-state` | H | Trusted selection → `hostLoggedIn,appLoggedIn,profileAuthorized,phoneAuthorized,authorizationVersion,userInfo?`; appLoggedIn will be set to true only if an exchanged and valid app session exists |
| `/v1/host/check-session` | H | Trusted selection → verify current app session; issuing a code without redemption does not count as login |
| `/v1/host/authorization-policy` | H | Trusted selection and `kind:"profile"\|"phone"` → `kind,purpose,permissionVersion`, for native confirmation UI |
| `/v1/host/login-codes` | H | `{miniAppId,packRoot}` → `code,expiresIn` |
| `/v1/apps/exchange-login` | C | `{code}` → `accessToken,tokenType,expiresIn,appUserId` |
| `/v1/host/consents` | H | `{miniAppId,packRoot,kind:"profile"\|"phone",granted:boolean,purpose?,permissionVersion?}` → consent receipt; a UI confirmation of the current policy must be provided when granting |
| `/v1/apps/profile` (`GET`) | A | Returns the authorized public profile |
| `/v1/host/profile` | H | `{miniAppId,packRoot}` → Public data explicitly authorized, for trusted native handler to deliver guest |
| `/v1/host/phone-codes` | H | `{miniAppId,packRoot}` → `code,expiresIn`; requires phone consent |
| `/v1/apps/exchange-phone` | C | `{code,appAccessToken}` → `phoneNumber`; `appAccessToken` must be a bearer token of the current business user of the app, and the server will verify that the phone number code matches exactly with the host/tenant/principal/epoch/app; the backend will then deliver the guest according to its own business logic |
| `/v1/apps/logout` | A | Logout from this app, retain host session |
| `/v1/host/app-logout` | H | `{miniAppId,packRoot}` → native exit specified app, retain host session |
| `/v1/host/logout` | H | Logout from this host session |
| `/v1/payments/orders` | A | server-side order parameters, see below → order |
| `/v1/payments/orders/:id` (`GET`) | A | Retrieve the order of this app, this user, this epoch |
| `/v1/payments/orders/:id/launch` | H | `{miniAppId,packRoot}` → launch of the mini app belonging to the current host user/app installation |
| `/v1/payments/orders/:id/reconcile` | A | Query and verify signature with the real channel; reference does not query channel |
| `/v1/payments/orders/:id/cancel-wait` | A | Mark client stop waiting; does not close/refund transaction |
| `/v1/payments/callbacks/reference` | HMAC | Raw JSON with `x-reference-timestamp/signature`, returns JSON acknowledgement |
| `/v1/payments/callbacks/wechat` | WeChat Platform RSA | Raw encrypted JSON; returns `204` after successful persistence |
| `/v1/payments/callbacks/alipay` | Alipay RSA2 | Original URL-encoded form; returns literal `success` after successful persistence |

HTTP errors are `{error,message}`, no credentials, platform raw response, personal number, or key is returned.
`401` indicates expired credentials/code, `403` indicates insufficient scope/consent, `409` indicates idempotency or event conflict.
Other paths return `404`; health check is `GET /health`. CORS is not implemented, pages cannot directly invoke sensitive endpoints based on this.

<a id="支付与-native-对接"></a>
## Payment and native integration

The business backend creates orders based on its own goods/pricing/buyer identity; it cannot directly use the guest-provided amount as the authoritative amount:

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

`amount` is in integer fen, currently only CNY is supported. The `paymentContext.openid` from WeChat JSAPI and the `paymentContext.buyerId` from Alipay JSAPI come from the business backend-verified platform identity; the container's pairwise app user ID must not be used instead. WeChat H5 requires the backend-determined `paymentContext.payerClientIp`.

The business backend passes the `orderId` to the guest. The native payment handler only receives the server-side order ID and calls `/launch` from a frozen trusted installation/account context, then routes it to the platform native SDK based on the `kind` of launch. Only `wechat-app` / `alipay-app` are used for their corresponding native APP SDKs; JSAPI/H5/QR use their respective official capabilities and do not pretend the prepay ID, QR code, or H5 URL as native APP parameters.
The service provides **backend contracts and payment launch parameters**; the real iOS/Android SDKs, URL Schemes, Universal Links, signatures, and return handling are implemented by the host platform and cannot treat this service's testing as device acceptance.

| Product | WeChat v3 | Alipay RSA2 | Return kind |
| --- | --- | --- | --- |
| `app` | `/v3/pay/transactions/app`, APP-specific signature last row is the original prepay ID | `alipay.trade.app.pay` / `QUICK_MSECURITY_PAY` | `wechat-app` / `alipay-app` |
| `jsapi` | `/v3/pay/transactions/jsapi`, JSAPI signature uses `prepay_id=...` | `alipay.trade.create`, returns trade number | `wechat-jsapi` / `alipay-jsapi` |
| `h5` | `/v3/pay/transactions/h5` | `alipay.trade.wap.pay` / `QUICK_WAP_WAY` | `wechat-h5` / `alipay-h5` |
| `native` | `/v3/pay/transactions/native`, QR code payment | `alipay.trade.precreate`, QR code payment | `wechat-qr` / `alipay-qr` |

The same app/user/epoch with the same idempotency key and identical parameters reuses the same persistent order; different parameters return 409.
Before external requests, write the order; concurrent or retry after restart will not resubmit a new merchant order. On network failure, return `payment_submission_uncertain`, retain the original order as `uncertain`: retrieve the channel again by idempotency key.
Submission status `submission` and financial status `status` are independent; when the initial request is uncertain, subsequent trusted callbacks may still advance the financial status to paid. Native success/cancellation callbacks do not directly mark payment; business logic relies on backend signature verification query/notifications. SDK account switch cancellation does not trigger refund and does not prevent the submitted transaction from ultimately being credited.

WeChat HTTP requests use API v3 RSA Authorization; HTTP responses are also signed with the platform serial number as configured.
Notifications first verify the platform signature and 5-minute time window of the original JSON, then perform AES-256-GCM authentication decryption using a 32-byte API v3 key. Platform certificates/keys are explicitly pinned by the backend; new certificates downloaded are not automatically trusted. Production operations and maintenance require updating the allowlist and rotating keys according to WeChat's official procedures.

Alipay request signature sorting includes the original field `sign_type` before signing, and URL encoding is applied only after signing; notification verification
Sort decoded fields and exclude `sign`/`sign_type`, only accept RSA2, reject duplicate form fields.
Server-side response validation of the **original nested JSON value bytes**, without parsing and stringifying reconstruction.
Configurable with official production gateway or Alipay official sandbox gateway; certificate mode is not supported, only explicit public key mode.

All channels verify merchant/app, merchant order number, exact amount breakdown, currency, and transaction ID. Notify event ID with authenticated payload hash persistently bound; a repeated event is acknowledged only once, and another event ID pointing to a paid transaction will not generate a `becamePaid` again. A paid status is not downgraded by later pending/closed callbacks; a request created after the notification is returned will not override an already paid status. Actual shipment must be managed by the business backend's own persistent idempotent order/shipping ledger; this reference service does not provide cross-service atomic shipping, refund APIs, reconciliation scheduling, or outbox.

<a id="验证范围"></a>
## Validation Scope

`npm test` covers real loopback HTTP, SQLite restart, host/app/epoch/pack isolation, token expiration/one-time use/incorrect app not consumption, independent consent and revocation, purpose/version change and unclaimed code expiration, exit, order ownership and concurrency idempotency,
notification duplication/conflict/out-of-order/preceding create response, timeout not blindly retry, WeChat request/APP/JSAPI/response
RSA and AES-GCM, Alipay RSA2 request/notify/raw JSON response and anti-tampering.
Platform testing uses on-the-fly generated RSA test keys and injects fetch, with no contact to real merchants.

Still requires real merchant credentials, product activation, and iOS/Android signing host for acceptance: actual pre-order, platform payment UI,
redirect, genuine callback, post-payment query, merchant reconciliation, and device account switching. Does not claim transaction success without credentials.
Reference backend does not provide automatic certificate renewal, distributed locks, background retry tasks, real account/phone number verification,
production database migration, and payment platform SDK; these are supplemented by the existing backend and release infrastructure of the host.

Official API Reference: [WeChat Pay Documentation](https://pay.weixin.qq.com/doc/v3/merchant/4012062524), [Alipay Open Platform API](https://opendocs.alipay.com/apis). Product permissions, platform SDKs, and merchant onboarding remain configured according to current platform requirements.
