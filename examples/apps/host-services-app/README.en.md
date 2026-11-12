<a id="宿主账号与参考支付示例"></a>
# Host Account and Reference Payment Example

[简体中文](README.md) · **English**


This mini-program works together with `tools/host-services-reference/scripts/demo-business-server.mjs` and the real host adapter. It demonstrates the business backend exchange of one-time login codes, independent identity/phone number authorization, app exit, and order creation → host channel → backend final state. The page does not contain host bearer, app client secret, merchant key, or reference callback secret.

First package, then register the **actual packaging root** to the reference backend's trusted installation record:

```sh
node tools/container-manifest/bin/container-pack.mjs examples/apps/host-services-app \
  --capabilities examples/apps/host-services-app/capabilities.json \
  --out /tmp/host-services-demo-pack
HOST_DEMO_PACK_ROOT=<manifest.json中的integrity.root> \
HOST_DEMO_CONTROL_TOKEN=<至少32字符的独立本地控制令牌> \
node tools/host-services-reference/scripts/demo-business-server.mjs
```

Host uses its own native HTTP client and control token to call `/demo/host` to obtain `application`, `account`, and `hostAccessToken`. The first two are used for container trust configuration; the token is only given to the native `HostServicesClient`. Reference identity allows only `demo-A` / `demo-B`; it cannot prove the identity of a real user. Host displays the profile/phone number UI and reference payment confirmation; backend confirmation is made only through native calls to `/demo/reference-confirm`, and guests cannot access the control token. See the backend README and [`宿主接入指南`](../../../docs/host-services/INTEGRATION.en.md).

The business origin of `app.js` must explicitly be added to the host network allowance list. The default service only listens on loopback;
Android uses task-specific adb reverse or explicit local development TLS endpoints and cannot open the control port to the local network to bypass Host/Origin validation. In browser scenarios, set the backend `HOST_DEMO_ALLOWED_ORIGINS` to the actual page origin and use same-origin proxy or controlled CORS. Deployment and ATS/Android cleartext switches are only included in standalone local example builds.

Fail explicitly when identity/payment processors are not installed. In this case, the WeChat Mini Program payment signature will not be passed to the App SDK, and automatic fallback to reference will not occur after failure in WeChat/Alipay. When request creation is uncertain, retry with the idempotency key; when order is pending, only query or reopen the same order, without creating a second charge.

When the host switches accounts, the old page and the business session within that page are destroyed together with the old JS owner;
the new account, upon re-entering the entry page, does not inherit query parameters, page stack, phone number, or order status. In this example, the business session is not written to unpartitioned persistent storage, and native payment callbacks are not considered valid payment confirmation.
