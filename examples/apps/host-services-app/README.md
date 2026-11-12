# 宿主账号与参考支付示例

此小程序配合 `tools/host-services-reference/scripts/demo-business-server.mjs` 和真实宿主
适配器运行。它演示一次性登录 code 的业务后端兑换、独立资料/手机号授权、应用退出，
以及订单创建 → 宿主渠道 → 后端最终状态。页面没有宿主 bearer、应用 client secret、
商户密钥或 reference callback secret。

先打包，再把**实际打包根**注册到参考后端的可信安装记录：

```sh
node tools/container-manifest/bin/container-pack.mjs examples/apps/host-services-app \
  --capabilities examples/apps/host-services-app/capabilities.json \
  --out /tmp/host-services-demo-pack
HOST_DEMO_PACK_ROOT=<manifest.json中的integrity.root> \
HOST_DEMO_CONTROL_TOKEN=<至少32字符的独立本地控制令牌> \
node tools/host-services-reference/scripts/demo-business-server.mjs
```

宿主使用自己的 native HTTP 客户端、控制令牌调用 `/demo/host`，取得 `application`、
`account` 和 `hostAccessToken`。将前两者用于容器可信配置；token 只交给原生
`HostServicesClient`。参考身份仅允许 `demo-A` / `demo-B`；它不能证明真实用户身份。
资料/手机号 UI 和 reference 支付确认由宿主展示，后台确认只从 native 调用
`/demo/reference-confirm`，guest 不能访问控制令牌。参见后端 README 与
[`宿主接入指南`](../../../docs/host-services/INTEGRATION.md)。

`app.js` 的业务 origin 必须显式加入宿主网络允许列表。默认服务只监听 loopback；
Android 使用任务专属的 adb reverse 或显式本地开发 TLS 入口，不能把控制端口开放
到局域网来绕过 Host/Origin 校验。浏览器场景设置后端 `HOST_DEMO_ALLOWED_ORIGINS`
为实际页面 origin，并使用同源代理或受控 CORS。部署和 ATS/Android cleartext 开关
仅放在独立的本地示例构建中。

未安装身份/支付处理器时应明确失败。此例不会把微信小程序支付签名交给 App SDK，
也不会在微信/支付宝失败后自动切换 reference。创建请求不确定时保留幂等键重取，
订单待处理时只查询或再次打开同一订单，不创建第二笔扣款。

宿主切换账号时，旧页面和该页面内的 business session 随旧 JS owner 一起销毁；
新账号重新进入入口页，不继承 query、页面栈、手机号或订单状态。本示例不把业务
session 写入未分区持久存储，也不把 native 支付回调当作付款依据。
