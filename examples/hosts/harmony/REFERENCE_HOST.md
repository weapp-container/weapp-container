<a id="harmony-reference-account-and-payment-host"></a>
# Harmony 参考账户和支付宿主

**简体中文** · [English](REFERENCE_HOST.en.md)


`native/HarmonyReferenceHost.ets` 是实际由 `Index.ets` 主工厂使用的仅宿主组件。它结合了参考后端适配器、专用的 HTTPS 传输和真实的 ArkUI 提示对话框。其默认配置为 `null`：示例在宿主安装账户或支付提供者之前不会宣传任何账户或支付提供者。匿名宿主身份不会变成伪造的登录。

在附加账户控制器之前，从受信任的本地应用程序启动时进行配置。宿主维护真实的账户管理器和承载存储；令牌回调必须检查请求的精确主体和纪元：

```ts
configureHarmonyReferenceHost({
  origin: 'https://accounts.example.com',
  hostToken: (call: HarmonyApiCall): Promise<string> =>
    hostAccountStore.tokenFor(call.context.account),
  paymentChannels: officialChannels,
  onError: reportHostAccountError,
});
```

`hostAccountStore`、`officialChannels` 和 `reportHostAccountError` 由嵌入式应用程序提供。不包含生产令牌、商户或钱包备用方案。将 `null` 配置以禁用后续所有者的集成。配置更改仅在新所有者上生效；它们不会修改正在运行的虚拟机。

示例的管理器以匿名方式启动。集成必须拥有其应用根目录的 `HarmonyHostAccountManager`，并使用递增的十进制 u64 时钟周期向前传递已恢复的登录、登出和账户变更。用宿主验证的安装记录替换固定测试用例中的可信应用记录。有关完整切换和重试边界详情，请参见 [ACCOUNTS.md](ACCOUNTS.md)。

<a id="reference-service-and-trusted-scope"></a>
## 引用服务和可信范围

Node.js 24 ESM + SQLite 服务位于
`tools/host-services-reference`。其服务/服务器模块管理登录代码的签发与回收，注册目的/权限版本策略，应用授权，资料/手机号码代码，订单所有权和通知验证。请参考该目录的 README 文件了解注册、凭证及通道配置方法。Harmony 传输需要 HTTPS；为设备测试，需通过宿主控制的 HTTPS 端点暴露一个本地运行的参考服务器，并使用平台信任的证书。它不会禁用 TLS 检查，也不会接受 HTTP 源来使示例成功。

适配器将小程序 ID、已接受的包根路径、预期的主体和精确的纪元传递给后端。后端会将此选择与已认证的宿主令牌和可信安装进行验证。该凭证仅在原生传输中可用，永远不会出现在 JS 快照、小程序凭证或任意 `wx.request` 请求头中。

`HarmonyReferenceIdentity.prepare()` 在原生配置和 VM 加载前获取真实的标识状态。因此，同步标识读取会使用已准备好的快照。匿名宿主账号在不调用令牌回调的情况下会获得错误状态。适配器对公共快照和昵称/头像字段进行白名单允许；后端私有资料字段保持原生状态。

`wx.login` 返回一个应用级的单次使用代码。小程序后端使用独立的客户端凭证兑换该代码。参考凭证不是微信的 `openid` 或 `session_key`。`wx.checkSession`、用户资料请求、应用登出和身份订阅使用相应的服务端点。后端代码兑换、授权变更或同用户凭证刷新后，需刷新已安装的身份适配器；返回的安装包中包含此类宿主驱动刷新的适配器。

<a id="disclosure-and-cancellation"></a>
## 信息披露和取消

配置和手机号获取获取后端注册的策略。访客
字符串不能替代其用途或权限版本。对话框中显示受信任的应用/发布者和策略，并提供明确的允许和拒绝操作。手机号码使用真实的按钮 `open-type="getPhoneNumber"` 路径和事件；未添加 `wx.getPhoneNumber`。

`HarmonyDisclosurePrompts` 保留进程级披露租约，直到准确的 `ComponentContent` 消失并完成释放。API 24 原生驱动使用 `PromptAction.openCustomDialog` 和 `closeCustomDialog`，观察 `onDidDisappear`，只把文档明确规定的无对应内容错误视为不存在。关闭或释放失败会保留句柄供实际重试。旧账号的对话框不能在新账号 owner 上方继续接受交互。

预检可以在管理器收到候选会话之前运行。
因此，`installHarmonyReferenceHost` 在等待 HTTP 请求时注册了所有者的取消门闩，取消操作将撤销宿主服务并关闭其确切的传输/UI 资源。晚到的身份响应无法配置或启动旧的虚拟机。应用登出会触发管理器边界，而无需等待其自身处理器的退役，从而避免了自循环依赖。

<a id="native-http-ownership"></a>
## 原生 HTTP 所有权

`HarmonyAccountHttpsTransport` 接受一个确切的 HTTPS 源地址，仅支持身份端点和受信任的订单启动查找。它使用 POST 方法，禁用重定向和缓存，并强制请求和响应流的 UTF-8 字节大小均为 256 KiB。无效的 UTF-8 或非对象的 JSON 将被拒绝。每个请求都有一个总截止时间，包括原生凭证解析；响应流不能无限期地延长该截止时间。受信任的纳秒值在转换为毫秒前以小数字符串形式进行分割。

取消立即拒绝消费调用。资源清理仍等待真实 `requestInStream` 终止、成功流的 `dataEnd` 以及成功原生 `destroy()`。如果销毁失败，则保留原始请求并报告失败屏障；显式清理重试将重新执行该操作。它在原生调用实际返回之前从不会标记 `destroyed`。取消后，无法在回调中创建请求。同一传输可被身份和支付共享；`close()` 操作是幂等的，并共享正在进行中的尝试。

<a id="explicit-payment-channels"></a>
## 显式支付通道

支付仅在宿主提供明确的
`HarmonyNativePaymentChannel` 实现时才会被注册。每个通道会指定提供商、产品和启动类型，并调用相应的官方原生 SDK/UI。
`pay` 承诺必须代表该原生 SDK 操作的真正终端回调，包括取消/错误情况。仅因为打开了意图或外部页面，不得简单地完成该承诺。

将可信的 `orderId` 传递给 `weappContainer.payment.request` 或兼容的 `wx.requestPayment` 处理程序。拒绝来自客方的签名。适配器会获取后端拥有的订单，该订单与启动的应用程序/用户/纪元相关联，要求精确配置的提供商/产品/类型，并启动其官方通道，然后轮询同一订单以获取服务器确认。仅钱包成功并不表示订单已支付。不会自动触发第二个钱包调用或替换通道。

调用取消/账户变更会停止 JS 等待，但在进程级钱包回调租约分配给旧操作直到正式终端到达之前，该租约仍保持有效。旧的 SDK 回调无法处理新用户的请求。取消此等待不会取消或撤销金融交易。超时后，需先查询原始后端订单，再启动新的订单。真实的商户凭证、SDK 权限以及已签名的通知验收仍属于宿主/通道配置和独立的交易验收。

<a id="reproducible-evidence"></a>
## 可重现的证据

`harmony-reference-services.test.mjs` 使用真实的 SQLite 参考后端执行生产服务适配器。
`harmony-disclosure-prompts.test.mjs` 通过有限的驱动边界检查原生 UI 生命周期。
`harmony-account-transport.test.mjs` 使用有限的原生回调执行生产 HTTP 和装配代码，包括后期令牌、流配额、释放失败重试、总体截止时间以及预飞行期间的所有者取消。
这些测试不证明物理网络、UI 或钱包的存在。

官方 API 24 编译器/未签名 HAP 报告以及精确的测试/源码哈希值
位于 `docs/host-services/evidence/2026-11-02-harmony-reference`。物理 Harmony 信息披露、经过认证的后端/TLS 交互、手机按钮 UI 以及配置的官方支付通道仍**待验收**。历史设备回执和早期的 HAP 无法证明这些新版本源码的合法性。
