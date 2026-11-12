<a id="web-宿主参考身份客户端"></a>
# Web Host Reference Identity Client

[简体中文](reference-identity-client.md) · **English**


`reference-identity-client.mjs` Connect the account protocol of `tools/host-services-reference`
`BrowserHostServices.identity`, for direct and Worker hosts. The client is in the host realm
Run, using the browser's native fetch; it does not import the Node module, nor does it put credentials into the configuration, Worker
Message or any applet `wx.request`.

```js
import { createReferenceIdentityClient } from './reference-identity-client.mjs'

const identity = createReferenceIdentityClient({
  endpoint: 'https://accounts.example.com',
  hostToken: async ({ context, signal }) => secureHostSession.tokenFor(context, signal),
  confirmAuthorization: async ({ kind, purpose, permissionVersion, application, signal }) => {
    // 这是宿主可见的真实授权 UI。展示服务端的用途与版本，返回明确 boolean。
    return hostConsentDialog({ kind, purpose, permissionVersion, application, signal })
  },
  requestLogout: ({ context }) => accountManager.requestApplicationLogout(context.application),
})

const services = new BrowserHostServices({ runtime, catalog, identity, environment: window })
await services.configure({ application: trustedInstallation, account: trustedAccount })
```

The callback belongs to the host code of the access party. In the example, `secureHostSession`, `hostConsentDialog` and
`accountManager` is provided by the access party. `hostToken` receives the frozen trusted context and cancellation signal,
Returns the original short-term bearer string; the `Bearer ` prefix must not be returned. The application identity is taken from trusted installation records,
Accepted `packRoot` only indicates package integrity, publisher authentication is still the responsibility of the host installation policy.

The returned object provides seven bound methods, all with signatures of `(payload, call)`: `getState`, `login`,
`checkSession`, `getUserProfile`, `getUserInfo`, `authorizePhone` and `logout`.
`call.context` must come from the current owner, including application, account and original session information;
The client copies and freezes the asynchronous operation before it. `appId` maps to backend `miniAppId`, along with `packRoot`,
`expectedPrincipalId` and exact `expectedPrincipalEpoch` are sent. guest payload
These fields cannot be replaced, nor can the registered authorized use be replaced.

`login` only issues application-scoped one-time codes. The mini-program business backend uses its own confidential
client redemption; the client does not perform redemption, does not include client secret, does not return the host bearer, and does not
Do not consider code signing as application session establishment. Host is available after redemption `identity.getState({}, call)`
Read the status of the current owner and then call `services.setApplicationIdentityState(state)`
Refresh synchronization snapshot. The identity handling wrapper of `BrowserHostServices` is also responsible for success and specified failure
Status refresh after
; the client itself does not commit the snapshot.

When the host account is `principalId: null`, `getState` returns four false locally and does not call the credentials.
provider or network. Host login, application session, data authorization and mobile phone number authorization respectively indicate: authorization can
Log in before the application, and the authorization will still be retained after exiting the application. `getUserInfo` only reads existing authorizations, no pop-ups or
Granted automatically. `getUserProfile` and `authorizePhone` first obtain the purpose/version registered by the backend,
Record explicit permission or denial after confirmation by the host. The mobile phone number returns a one-time authorization code, which is redeemed by the business backend.
Does not directly return the mobile phone number.

Information and mobile phone number disclosure will check the latest authorization and `authorizationVersion` before and after reading, and refuse to withdraw
or late results after a new revision. New authorization with the same scope in the same client will also invalidate the old authorization process.
Licensed versions are subject to a 256 KiB total response byte budget, with no additional 1024 character limit. cross-process moment
The competition situation is still subject to server-side verification, and the final redemption of the mobile phone number code is bound by the server-side to the current authorization revision.

`logout` first requests `/v1/host/app-logout` to revoke the application's session and unused code, then immediately
Call `requestLogout`. The callback must synchronously start the host owner replacement and return a queryable operation
receipt, such as `BrowserHostAccountManager.requestApplicationLogout`; must not be returned
The owner destroys the Promise, otherwise it will wait for the current handler function to exit. The client does not log out of the host account.
Nor will it cancel other mini-programs. Even if the owner synchronously cancels the current signal in the callback, the client still returns
receipt; completion results for old guests can be discarded gracefully by the runtime.

Fixed endpoint must be an HTTPS origin without user information, path, query and fragment.
Local development can explicitly set `allowLoopbackHTTP: true` using localhost, 127.0.0.1, or ::1.
All requests are fixed to POST, using `redirect: 'error'`, `credentials: 'omit'` and
`cache: 'no-store'`, response read as stream, JSON and error response combined up to 256 KiB UTF-8 bytes.
The default `timeoutMs: 15000` covers the entire process of credential provider, host confirmation and HTTP, and can be set
1..120000 milliseconds. `call.signal` and the optional UNIX nanosecond `deadlineNs` both cancel the wait;
The client does not automatically retry authorization, code issuance or exit.

Backend errors are merged and disclosed in the order of envelope, envelope.details, error.details, and error.
Non-null fields, excluding code/message/error/details structure keys. Original `errCode`, `errMsg`
and public extensions enter `ReferenceIdentityError.details`; container classification uses five canonical
category, compatible with ERR_*, authorization errors and ERR_UNSUPPORTED_CAPABILITY. The original backend classification is retained
In `error.backendCode`, for wrapper to determine whether to refresh the snapshot. Servers must comply with public errors
Response to a contract that does not include credentials; the client does not append the host-token provider's original exception content.

Running limited Node 24 verification:

```sh
node --test --test-timeout=10000 examples/hosts/web-wasm/reference-identity-client.test.mjs
```

Test using real Node HTTP service and temporary SQLite database, covering authorization, code redemption, exit,
Cancellation, late data, credential fields and transfer restrictions; it does not replace the browser direct/Worker installation link,
QuickJS/V8 or equipment acceptance. The test only closes the services and connections created by itself, and deletes its own database and directory.
