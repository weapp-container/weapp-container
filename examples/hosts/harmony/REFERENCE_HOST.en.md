<a id="harmony-参考账户和支付宿主"></a>
# Harmony reference account and payment host

[简体中文](REFERENCE_HOST.md) · **English**


`native/HarmonyReferenceHost.ets` is the host-only assembly used by the actual
`Index.ets` owner factory. It combines the reference backend adapter, a dedicated
HTTPS transport and real ArkUI disclosure dialogs. Its default configuration is
`null`: the sample advertises no account or payment provider until the host
installs one. Anonymous host identity does not become a fabricated login.

Configure it from trusted native application startup, before attaching an
account controller. The host maintains the real account manager and bearer
store; a token callback must check the exact requested principal and epoch:

```ts
configureHarmonyReferenceHost({
  origin: 'https://accounts.example.com',
  hostToken: (call: HarmonyApiCall): Promise<string> =>
    hostAccountStore.tokenFor(call.context.account),
  paymentChannels: officialChannels,
  onError: reportHostAccountError,
});
```

`hostAccountStore`, `officialChannels` and `reportHostAccountError` are supplied
by the embedding application. No production token, merchant or wallet fallback
is included. Configure `null` to disable the integration for subsequent owners.
Configuration changes apply on a fresh owner; they do not mutate a running VM.

The sample's manager starts anonymous. Integrations must own their app-root
`HarmonyHostAccountManager` and forward restored login, logout and account
changes with increasing decimal u64 epochs. Replace the fixture's trusted
application record with the host's verified installation record. See
[ACCOUNTS.md](ACCOUNTS.en.md) for the complete switch and retry boundary.

<a id="引用服务和可信范围"></a>
## Reference service and trusted scope

The Node.js 24 ESM + SQLite service lives in
`tools/host-services-reference`. Its service/server modules own login code
issuance and redemption, registered purpose/permission-version policies,
application grants, profile/phone codes, order ownership and notification
verification. Follow that directory's README for enrollment, credentials and
channel configuration. The Harmony transport requires HTTPS; expose a locally
running reference server through a host-controlled HTTPS endpoint with a
platform-trusted certificate for device testing. It does not disable TLS checks
or accept an HTTP origin to make an example succeed.

The adapter passes the mini-program ID, accepted package root, expected
principal and exact epoch to the backend. The backend validates this selection
against the authenticated host token and trusted installation. The bearer is
available only inside the native transport. It is never included in a JS
snapshot, mini-program credential or arbitrary `wx.request` headers.

`HarmonyReferenceIdentity.prepare()` fetches the real identity state before
native configure and VM load. Synchronous identity reads therefore use an
already prepared snapshot. Host accounts that are anonymous get a false state
without invoking the token callback. The adapter allowlists the public snapshot
and nickname/avatar fields; backend private profile fields stay native.

`wx.login` returns an application-scoped single-use code. The mini-program
backend redeems it with independent client credentials. The reference credential
is not a WeChat `openid` or `session_key`. `wx.checkSession`, profile requests,
application logout and identity subscriptions use the corresponding service
endpoints. Refresh the installed identity adapter after backend code redemption,
authorization changes or same-user credential refresh; the returned installation
contains the adapter for such host-driven refreshes.

<a id="信息披露和取消"></a>
## Disclosure and cancellation

Profile and phone disclosure fetch the backend's registered policy. Guest
strings cannot replace its purpose or permission version. The dialog shows the
trusted app/publisher and policy, with explicit Allow and Deny actions. Phone
codes use the real button `open-type="getPhoneNumber"` path and event; no
`wx.getPhoneNumber` is added.

`HarmonyDisclosurePrompts` retains a process-wide disclosure lease until the
exact `ComponentContent` has disappeared and is disposed. The API 24 native
driver uses `PromptAction.openCustomDialog` and `closeCustomDialog`, observes
`onDidDisappear`, and treats only the documented no-corresponding-content error
as absence. Failed close/disposal retains its handle for actual retry. Old
account dialogs cannot remain interactive over a new account owner.

Preflight can run before the manager has received a candidate session.
`installHarmonyReferenceHost` therefore registers the owner cancellation gate
before awaiting HTTP: cancellation revokes host services and closes their exact
transport/UI resources. A late identity response cannot configure or start the
old VM. Application logout initiates the manager boundary without awaiting its
own handler's retirement, avoiding a self-drain dependency.

<a id="原生-http-所有权"></a>
## Native HTTP ownership

`HarmonyAccountHttpsTransport` accepts one exact HTTPS origin and only the
identity endpoints and trusted order-launch lookup. It uses POST, disables
redirects and caching, and enforces 256 KiB on both UTF-8 request bytes and
streamed response bytes. Invalid UTF-8/non-object JSON is rejected. Every
request has a total deadline, including native credential resolution; response
streaming cannot extend that deadline indefinitely. Trusted nanoseconds are
divided as decimal strings before conversion to milliseconds.

Cancellation rejects the consuming call immediately. Resource cleanup still
waits for the real `requestInStream` terminal, the successful stream's
`dataEnd`, and a successful native `destroy()`. A destroy failure preserves the
exact request and reports a failed barrier; explicit cleanup retry re-executes
that action. It never marks `destroyed` before the native call actually returns.
A late token callback cannot create a request after cancellation. The same
transport can be shared by identity and payment; `close()` is idempotent and
shares an in-flight attempt.

<a id="显式支付通道"></a>
## Explicit payment channels

Payment is registered only when the host supplies explicit
`HarmonyNativePaymentChannel` implementations. Each channel names the provider,
product and launch kind and invokes the corresponding official native SDK/UI.
The `pay` promise must represent that exact SDK operation's real terminal
callback, including cancellation/error. It must not resolve merely because an
intent or external page was opened.

Pass a trusted `orderId` to `weappContainer.payment.request` or the compatible
`wx.requestPayment` handler. Guest-supplied signatures are rejected. The adapter
fetches a backend-owned order bound to the initiating application/user/epoch,
requires an exact configured provider/product/kind, launches its official
channel once and polls that same order for server confirmation. Wallet success
alone does not mark the order paid. No automatic second wallet invocation or
replacement channel is attempted.

A caller cancellation/account change stops JS waiting while the process-wide
wallet callback lease remains assigned to its old operation until the official
terminal arrives. The old SDK callback cannot settle a new user's request.
Cancelling this wait does not cancel or reverse the financial transaction.
After a timeout, query the original backend order before starting another one.
Real merchant credentials, SDK entitlements and signed notification acceptance
remain host/channel configuration and independent transaction acceptance.

<a id="可重现的证据"></a>
## Reproducible evidence

`harmony-reference-services.test.mjs` executes the production service adapter
against the real SQLite reference backend. `harmony-disclosure-prompts.test.mjs`
checks native UI lifecycle through finite driver boundaries.
`harmony-account-transport.test.mjs` executes the production HTTP and assembly
code with finite native callbacks, including late tokens, stream quotas,
failed release retry, total deadlines and owner cancellation during preflight.
These tests do not certify a physical network, UI or wallet.

The official API 24 compiler/unsigned HAP report and exact test/source hashes
are in `docs/host-services/evidence/2026-11-02-harmony-reference`. Physical
Harmony disclosure, authenticated backend/TLS interaction, phone button UI and
a configured official payment channel remain **pending acceptance**. Historical device
receipts and earlier HAPs do not attest to these new source versions.
