<a id="harmony-账户执行边界"></a>
# Harmony account execution boundary

[简体中文](ACCOUNTS.md) · **English**


`session/HostAccountManager.ts` owns one host/tenant account domain and all its
mini-program controllers. The example `Index.ets` uses the manager in its actual
ArkUI startup, input, presentation and close path. Its initial account is
anonymous. A host application supplies the authenticated principal; the sample
does not invent login, phone or payment credentials.

<a id="可信应用和原生拥有者"></a>
## Trusted application and native owner

Pass `hostAppId`, `tenantId`, `publisherId`, `appId`, `environment`, `version`
and `packRoot` from the host's trusted installation record. Bind the accepted
package to that record before attaching. A matching SHA-256 proves the package
bytes, not its publisher. The bundled sample's fixed identity describes a
host-installed fixture, not a mechanism for authenticating downloaded code.
`HarmonyHostServices.configure()` and Rust validate the accepted pack root.

`createOwner(context)` must call `createWeappContainer()` for every incarnation,
construct a new `HarmonyHostServices`, reinstall all adapters and return an
unstarted `HarmonyLiveSession`. `Index.ets` demonstrates this with managed files,
network, Socket, system, BLE and recorder adapters. The factory must return its
exact session even if adapter setup fails, so the manager can retire resources.
If setup fails, report failure on that session before returning it.
The manager validates its real execution identity, starts it once and waits for
a real presentation acknowledgement before enabling input. A resolved arbitrary
waiter cannot make an unpresented session ready.

The new factory requires the native `createOwner` export; an older library
rejects with `ERR_PROTOCOL_VERSION`. New instances use independent native
handles, VM state, host-service configuration and storage leases. Their GPU
surfaces borrow the process EGL display and release their own context/surface;
retiring one does not terminate the display used by another or by ArkUI.

<a id="稳定的控制器新的会话"></a>
## Stable controller, fresh session

```ts
const manager = new HarmonyHostAccountManager({
  principalId: hostAccount.id,
  epoch: hostAccount.epoch, // canonical positive u64 decimal string
}, {
  revokeBackend: revokeAllApplicationAuthorizations,
  clearLocalData: clearRetiredApplicationNamespace,
});
const controller = manager.attach({
  application: trustedInstall,
  launchOptions: { route: 'pages/home/index', query: { from: 'host' } },
  createOwner,
  onState: renderHostAccountStatus,
});
await controller.ready;
const operation = await manager.switchAccount(nextAccount, {
  [trustedInstall.appId]: { route: 'pages/home/index', query: { from: 'switch' } },
});
const receipt = manager.query(operation.operationId);
```

`controller` stays stable. The old epoch closes every associated controller's
input/call gate synchronously, including candidates awaiting presentation.
State observers run after this shared gate, so a reentrant newer switch cannot
leave a sibling on an older epoch. Epoch arithmetic never rounds through a
JavaScript number. Epochs must strictly increase for host identity changes;
rapid changes publish `superseded` for older operations.

The ordered boundary revokes old callbacks, cancels device work, waits actual
resource release and GPU detach, closes the native owner and its storage lock,
then invokes the fresh owner factory. Startup receives a fresh session ID,
route, query, scene and extra data; no old page stack or JS state is reused.
A failed replacement keeps input blocked and never restores the previous user.
The example offers an explicit retry button for a failed replacement.

During replacement, `invoke()` rejects business commands with
`ERR_IDENTITY_SWITCHING`; a result that arrives after replacement is rejected
with `ERR_CANCELLED`. `state`, `query()`, `cancel()` and `close()` remain usable.
`ready` and switch receipts carry operation IDs and terminal phases.
`cancel()` revokes the candidate without reversing the account selection.
Call `controller.retry()` after resolving a failed startup or retirement.

<a id="真正的清理和保留的失败"></a>
## Real cleanup and retained failure

`HarmonyLiveSession.revokeIdentity()` immediately blocks input, timers,
foreground reentry, startup and host callbacks. `closeAndDrain()` waits exact
native cleanup promises before destroying its owner. Failed detach, device
release, staging-file cleanup or native revocation retain their exact owner and
release action. `cleanupComplete` stays false and the receipt is `closing` until
native destruction actually succeeds. A later retry re-executes unsuccessful
actions; successful releases and unload hooks are not repeated.

Keep the manager at the authenticated host-domain lifetime, beyond a page or
ArkUI component. A rejected `controller.close()` retains the controller in that
manager. Retry it with `controller.close()` or `manager.retryRetirements()`;
do not discard the manager or open the same namespace around a failed lock.
The sample's module-level manager retains failed close barriers after its
component is destroyed. Its OS foreground, surface and presentation callbacks
are tied to the exact candidate; late old receipts never update the new view.

<a id="后端权限和用户命名空间"></a>
## Backend, grants and user namespaces

Host credentials stay in the host or its backend. `refreshCredentials()` gives
a host-only callback an account copy and a `current()` guard. Commit refreshed
credentials only while that guard is true; a stale completion rejects. Normal
same-user credential refresh does not rebuild the VM. No host token is injected
into arbitrary `wx.request` calls.

The factory calls the optional [reference-host assembly](REFERENCE_HOST.en.md)
before `configure()`. Configure its real HTTPS backend and native token closure,
or install your own genuine login/check-session, profile, phone and payment
handlers there. Use the context's exact account, application,
operation and cancellation boundary when talking to the host backend. Issue an
application-scoped single-use login code and preserve provider errors; do not
return an unverified placeholder or label it a WeChat credential. User profile,
phone and device permissions need independent host consent and backend records.
Phone permission is a button event contract, not an invented `wx.getPhoneNumber`.

After the backend grants this application, call the guarded
`context.grantApplication()`. On application logout, revoke that application's
backend authorization and call `context.requestLogout(freshLaunch)`; it rebuilds
only that application's instances. The host account and other applications
remain logged in. Old-incarnation hooks reject after logout or a host switch.
The manager's in-memory grant state is an execution gate; the backend remains
the durable authorization authority.

`harmonyStorageScope()` describes host, tenant, publisher, application,
environment and principal. Rust computes the actual private paths and owns the
storage lock. Legal version/package upgrades preserve this namespace. Account
changes isolate it. Legacy unpartitioned data is never automatically imported;
provide a separate explicit migration tool with a chosen source/destination.

`deleteAccount()` requires explicit backend revocation and local-data deletion
callbacks. It reserves the principal against concurrent restoration, switches a
current account to anonymous, waits actual owner drain and then clears every
known application scope, including controllers already detached. Failed native
retirement prevents deletion. The host deletion callback must remove the exact
Rust-managed namespace after its lock is released, not unrelated account data.

<a id="验证边界"></a>
## Validation boundary

`node --test scripts/harmony-account-manager.test.mjs
scripts/harmony-host-services.test.mjs scripts/harmony-live-session.test.mjs
scripts/harmony-recorder-lifecycle.test.mjs scripts/harmony-bluetooth-lifecycle.test.mjs`
exercises the production manager/session/service code against finite native
boundaries. It covers sibling gates, rapid and reentrant switches, stale
completions, app logout, refresh, deletion, real release barriers and retry.
The LiveSession integration uses the real manager and service dispatcher and
requires a current presentation acknowledgement.

The source-bound official API 24 unsigned HAP build is recorded under
`docs/host-services/evidence/2026-11-02-harmony-account`. The separate
`2026-11-02-harmony-native-owners` evidence executes production N-API C++ against
Rust QuickJS on the host and checks native owner isolation and GPU fault paths.
Neither finite adapter tests nor SDK compilation certify physical Harmony
account/surface switching, device permissions, BLE or recording. Those checks
remain **pending acceptance**, along with a real configured account/payment backend. Existing
historical installed-device receipts remain bound to their original sources.
