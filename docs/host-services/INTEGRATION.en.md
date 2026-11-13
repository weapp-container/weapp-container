<a id="宿主接入指南"></a>
# Host Integration Guide

[简体中文](INTEGRATION.md) · **English**


This guide corresponds to `0.1.0-preview.6.0` source code and host services protocol `1.0`, C ABI remains at `1`.
Historical runtime archive/ORIGIN/acceptance records have not been updated; old binaries cannot run this feature. First build a matching runtime and SDK, then determine availability via `capabilities.hostServices.protocolVersion`; configuration, registration, or capability checks failures should immediately terminate access and cannot revert to developer sandbox login or payment.

<a id="安装和账号"></a>
## Installation and Account

The host first verifies the publisher, installation license, and package content to form a `TrustedApplication`. `packRoot` must match the integrity root of the package being loaded; identical hashes do not imply trustworthiness of the publisher. Updates use the host's installation policy to authorize `authorizeInstalledPack`, and it cannot accept a publisherId or account provided by the mini-program itself.

Initialization order is:

1. Log in with an existing host to recover the real user and obtain a monotonically increasing decimal string `epoch`; when no login is performed, use `principalId:null`. The host token remains in the host's secure storage or existing identity backend.
2. Create a controller and configure `application`, `account`, and the obtained synchronized snapshot. Contact/phone number grants use initial values from the authorization backend; the presence of a logged-in host cannot be used to infer that these items have been authorized.
3. Install identity/payment handlers, actual device tool groups, and explicitly allowed network origins, then load the package. `registerApiHandler` accepts only APIs locked in the whitelist of the host; business extensions use `registerHostMethod`.
4. Release input upon receiving native presentation. Page ready, source code compilation success, and native payment SDK callbacks are not equivalent to a visual or final financial acceptance.

```json
{
  "application": {
    "hostAppId":"my-host", "tenantId":"tenant", "publisherId":"verified-publisher",
    "appId":"miniapp", "environment":"release", "version":"2",
    "packRoot":"<宿主已验证的实际包根>"
  },
  "account":{"principalId":"host-user-id","epoch":"9007199254740993"},
  "apis":[],
  "syncValues":{
    "weappContainer.identity.getState":{
      "hostLoggedIn":true,"appLoggedIn":false,
      "profileAuthorized":false,"phoneAuthorized":false
    }
  }
}
```

`getAccountInfoSync` still returns mini-program information. The mini-program obtains a one-time code through `wx.login` and then passes it to its business backend for exchange using a confidential client. The `appUserId` in the reference service is an application-level isolation identifier, not a WeChat openid; the reference service also does not issue a WeChat session_key.

Authorization data obtained via `wx.getUserProfile` / authorized `wx.getUserInfo`; phone number is verified in real time
`button open-type="getPhoneNumber"` → native authorization → `bindgetphonenumber`, handled by business backend to exchange code for phone number. There is no `wx.getPhoneNumber`. Authorization binds user, app, environment, purpose, and authorization version; upon revocation, both backend and current owner's snapshot/event are updated.
Service purposes and permission versions referenced by backend `authorizationPolicies`. Android/iOS native adapters first read policy and display purpose, then submit the original version confirmed by user; during popup, if policy changes, the authorization is rejected. Changes in purpose or version invalidate previous authorizations and pending phone number codes, and old codes cannot be revived upon reauthorization. Categories without configured policy cannot apply; no automatic version upgrades for previous records without version history.

`weappContainer.identity.getState()` synchronously returns the app state, `onChange/offChange` subscribes to the same schema. `identity.logout()` only revokes the app's login and rebuilds all instances of the app; the host account and other apps are retained. It is not possible to simply change one JS boolean value upon exit; requests, resources, and storage leases of the old owner must be retired. App login and profile, phone number consent are managed separately: authorization can precede code exchange, and app exit retains consent. When `hostLoggedIn:false`, all three app/authorization states are false. Snapshot may carry opaque `authorizationVersion`; `userInfo` appears only when profile authorization is valid. The host must still explicitly refresh or push authorization changes and cannot determine from cache whether the backend currently permits disclosure.

<a id="web-参考身份后端"></a>
### Web Reference Identity Backend

Web archive provides `reference-identity-client.mjs`, created by the host page and passed into `BrowserHostServices({ identity })`. The fixed `endpoint` points to the reference service; during deployment, the same-origin reverse proxy mounts `/v1/host/*`. Cross-origin deployment requires the server to explicitly allow the host origin, and the reference service does not automatically enable CORS. `allowLoopbackHTTP:true` is for explicit local development only; all other endpoints use HTTPS.

`hostToken` retrieves a token from the host's secure credential interface via a trusted application/account. The client executes only within the host page and does not include the token in Worker initialization parameters, synchronous snapshots, or mini-program `wx.request`.
`confirmAuthorization` presents the server-registered kind, purpose, and permissionVersion to the host and returns the user's explicit choice; `wx.getUserInfo` reads existing authorization and does not automatically popup or grant permissions.

`wx.login` issues only a code. The mini-program sends the code to its business backend, where it exchanges the code for a token using a dedicated confidential client credential; these credentials do not belong to the Web client configuration. After exchange, `wx.checkSession` refreshes the synchronization status of the current owner. Before application exit, the backend session is revoked, then `requestLogout` is used to synchronize and initiate the application exit operation of the account manager, returning a queryable receipt; this callback cannot wait for the closure of the owner being retired. Results from closure, account change, or timeout are not written back to the new owner.

<a id="换号与资源清理"></a>
## Number Swapping and Resource Cleanup

The native SDK's `HostAccountManager` is shared by host/tenant.
The account switch operation in a host advances the shared epoch,
all associated controllers immediately block old input and results. Public controllers remain unchanged, internal sessionId is updated.
New launch parameters are provided from `launches` of `switchAccount` or `updateAccountSwitchLaunch`; page stack,
old query and JS data are not inherited. Quick account switching only allows the latest epoch to continue.

The cancel operation returns `operationId`; the `queryAccountSwitch` reads the stage and final state. During cleanup, only state, cancel, close, and special recovery commands are accepted; ordinary business commands fail. The old GPU surface is truly unbound, and device/media/file work is drained before acknowledging cleanup; thereafter, flush storage and release the lock, then start a new owner. Block until the new layout/viewport is presented or reload fails; never recover the old account.

Flutter and React Native can use `registerAccountCleanupHandler` to register custom resource cleanup.
The handler must wait for actual stop/release, support cancellation and be callable repeatedly. Failures will cause blocking, and can be explicitly retried via `retryAccountCleanup`. Closing also waits for all handlers; if closing fails, it can be retried with another `close()`; after failure, the controller continues to reject business commands. `operationId` is an opaque identifier and is passed in during close, but cannot be parsed into an account. The native SDK corresponds to `accountCleanupHandler` / `onAccountCleanup` async hook.

When cleaning up old accounts, the core will clear the account-related sync snapshots. The host uses
`prepareAccountHostServiceSnapshots{operationId,values}` to prepare new snapshots for **currently unconfirmed** operations, so the first sync read by the new JS will see the new state. Old operations cannot refresh snapshots. Credential refresh, if the user remains unchanged, directly updates the host client and authorized snapshots, typically without requiring a restart.

When the host deletes an account, it first detaches and shuts down all instances holding the old lease, then calls `deleteAccountData`.
If a lock is still held, return `ERR_STORAGE_LOCKED`. After local success, the host backend must revoke all app grants/tokens for the user; the backend revocation request returned must not be ignored. Do not record the user's token or phone number in diagnostic logs.

<a id="文件事件与原生组件"></a>
## Files, Events, and Native Components

Persistent key-value, files, and native authorization records are organized by host/tenant, mini-program, environment, and user partition. Valid versions
Upgrade reuses partition; old unpartitioned data will not be automatically imported and must explicitly call `migrateLegacyStorage` to migrate.
Even if key-value storage is set to memory-only, native files use the host's configured `managedFilesRoot`.

The guest's `identity.logout` only revokes the current host/tenant/publisher/app/environment scope,
legitimate upgrades within the same application inherit this scope. Different publishers or environments using the same appId will not be logged out simultaneously.
A Rust host can explicitly call `revoke_application_scope` to revoke a precise scope; the original
`revoke_application(app_id)` is retained as the entry point for the host to proactively revoke across environments. Timeout logout results do not trigger
local account reconstruction; backend-actually-revoked authorizations are still handled by subsequent state recovery/validation.

Native `managedFileScope` command returns the `root` (guest file) and `auxiliaryRoot` (native consent, etc.) with lease; both are only available to native and cannot be passed to guest. Guest only sees `wx.env.USER_DATA_PATH === 'wxfile://user'`. All path accesses reject boundary violations/symbolic links and internal paths like `.weapp-*`. Synchronous files are processed by an independent Rust synchronous callback running in the VM's thread, and return only after the actual write is committed to disk; shared system file locks with asynchronous file transactions. Web without synchronous persistence capability does not register these methods.

Platform callbacks only enter bounded mailbox; they enter JS after the runtime thread drain. Events carry the current
`sessionId/accountEpoch/subscriptionId/sequence`; objects, subscriptions, and binary handles can only belong to the owner that created them. Late results after cancellation, timeout, reauthentication, or destruction do not settle old Promises or trigger callbacks.
callback → complete → Promise order passes double-engine contract verification, as do the original `errCode/errMsg`.

The native SDK's `capabilities.hostServices.apiResourceChunks === '1.0'` indicates that `hostApiResource({context,offset,length})` can be called. Up to 1 MiB can be read per call, returning `bytes` and `totalBytes`; the total resource size is at most 16 MiB minus 64 KiB. The `context` must be an uncommitted, trusted original context from the `InnerAudioContext.src` setter, selected by the runtime from this call, and the host cannot provide a path or hash. Each read operation revalidates the call, expiration, manifest size, and digest; after a switch, cancellation, or settlement, the resource becomes unreadable. The underlying uses the existing C ABI command channel; older runtimes explicitly reject package-origin sources when this extension has not been negotiated. This entry only delivers resource bytes; format decoding capabilities remain dependent on the actual backend installed and its parameter ranges on each end.

`hostComponents` provides the page/node/owner scope, geometry, clipping, z-order, and visibility of accepted nodes.
The context's `context.componentTarget` is resolved by the runtime; native does not accept guest-node identities claimed by the guest.
Camera/video output `hostComponentFrame` is inserted at the normal Skia drawing location, inheriting clipping, transparency, transformation, and sibling z-order; independent windows cannot be treated as components. Resources corresponding to node unmounting, hiding, going to background, switching, and closing are stopped. Formatted as rgba8, per-frame and total retention are bounded, and old frame numbers are directly discarded.

<a id="支付与示例"></a>
## Payment and Example

Recommend that guest only call `weappContainer.payment.request({orderId})`. The host retrieves the launch from the frozen app/user/epoch context and passes it to its backend, then hands it over to the explicitly configured channel. `wx.requestPayment` still has a host registration entry point, but the WeChat mini-program signature cannot be passed to the App SDK and must be rejected if verification or mapping is not possible.

WeChat App, Alipay signature order, JSAPI, H5, and scan-to-launch are separated. No silent switching when product or platform is not activated or corresponding SDK is not available. Order binds application, user, epoch, and idempotency key. Canceling waiting, switching phone number, or timeout does not reverse payment, and automatic retry for deduction is not supported. After native SDK succeeds, backend signature verification notification or order query confirmation is still required; the final order status is determined by the backend.

Runnable local closed-loop includes:

- [Sample Mini-App](../../examples/apps/host-services-app/README.en.md): Code exchange, authorization, and order UI.
- [Reference Backend](../../tools/host-services-reference/README.en.md): Node.js 24 ESM + SQLite, real HTTP/transaction/signing tests; control credentials and merchant credentials are not delivered to guest.
- Android/iOS `HostServicesClient`, identity, and official App payment adapter; Flutter/RN `installNativeDeviceApis` installs OS tooling suite, custom identity/payment business still provided by host.
- Web `BrowserHostServices` / `BrowserHostAccountManager` receives host processor and shares a single internal owner with Worker; production defaults to strict denial of uninstalled capabilities.

reference is only a local reference channel explicitly configured and does not involve actual transactions. Actual merchant acceptance requires separate provision.
Products, signature host, keys, and return URL configurations are independently verified according to the backend README's signing procedure.

Complete list and seven-end status see [logbook](README.en.md). `present` only indicates that the source code exists; the parameter ranges, OS conditions, real hardware evidence, and current product version for each API must be verified separately.
