<a id="web-host-reference-identity-client"></a>
# Web 宿主参考身份客户端

**简体中文** · [English](reference-identity-client.en.md)


`reference-identity-client.mjs` 将 `tools/host-services-reference` 的账号协议接入
`BrowserHostServices.identity`，用于 direct 和 Worker 宿主。客户端在宿主 realm
运行，使用浏览器原生 fetch；它不导入 Node 模块，也不将凭据放入配置、Worker
消息或任意小程序 `wx.request`。

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

回调属于接入方宿主代码，示例中的 `secureHostSession`、`hostConsentDialog` 和
`accountManager` 由接入方提供。`hostToken` 接收冻结的可信上下文和取消信号，
返回原始短期 bearer 字符串；不得返回 `Bearer ` 前缀。应用身份取自可信安装记录，
已接受的 `packRoot` 只表示包完整性，发行者认证仍由宿主安装策略负责。

返回对象提供七个已绑定方法，签名均为 `(payload, call)`：`getState`、`login`、
`checkSession`、`getUserProfile`、`getUserInfo`、`authorizePhone` 和 `logout`。
`call.context` 必须来自当前 owner，包含 application、account 及原始会话信息；
客户端在异步操作前复制并冻结它。`appId` 映射为后端 `miniAppId`，连同 `packRoot`、
`expectedPrincipalId` 和精确的 `expectedPrincipalEpoch` 发送。guest payload
不能替换这些字段，也不能替换登记的授权用途。

`login` 只签发应用作用域的一次性 code。小程序业务后端用自己的 confidential
client 兑换；客户端不执行兑换、不包含 client secret、不返回宿主 bearer，也
不把 code 签发视为应用会话建立。兑换后宿主可用 `identity.getState({}, call)`
读取当前 owner 的状态，再调用 `services.setApplicationIdentityState(state)`
刷新同步快照。`BrowserHostServices` 的身份处理 wrapper 也负责成功和指定失败
后的状态刷新；客户端本身不提交快照。

宿主账号 `principalId: null` 时，`getState` 本地返回四个 false，不调用凭据
provider 或网络。宿主登录、应用会话、资料授权和手机号授权分别表示：授权可以
先于应用登录，退出应用后授权仍可保留。`getUserInfo` 只读取已有授权，不弹窗或
自动授予。`getUserProfile` 和 `authorizePhone` 先取得后端登记的 purpose/version，
由宿主确认后记录明确允许或拒绝。手机号返回一次性授权 code，由业务后端兑换，
不直接返回手机号。

资料与手机号披露会在读取前后检查最新授权及 `authorizationVersion`，拒绝撤回
或新 revision 后迟到的结果。同一客户端内同 scope 新授权也会使旧授权流程失效。
授权版本按 256 KiB 总响应字节预算约束，不附加 1024 字符限制。跨进程的瞬间
竞态仍以服务端校验为准，手机号 code 的最终兑换由服务端绑定当前授权 revision。

`logout` 先请求 `/v1/host/app-logout` 撤销该应用的会话和未使用 code，随后立即
调用 `requestLogout`。该回调必须同步启动宿主 owner 替换并返回可查询的操作
receipt，例如 `BrowserHostAccountManager.requestApplicationLogout`；不得返回
owner 销毁 Promise，否则会等待当前处理函数自身退出。客户端不退出宿主账号，
也不撤销其他小程序。即使 owner 在回调中同步取消当前 signal，客户端仍返回
receipt；旧 guest 的完成结果可由运行时正常丢弃。

固定 endpoint 必须是无用户信息、路径、query 和 fragment 的 HTTPS origin。
本地开发可显式设置 `allowLoopbackHTTP: true` 使用 localhost、127.0.0.1 或 ::1。
所有请求固定为 POST，使用 `redirect: 'error'`、`credentials: 'omit'` 和
`cache: 'no-store'`，响应以流读取，JSON 与错误响应合计最多 256 KiB UTF-8 字节。
默认 `timeoutMs: 15000` 覆盖凭据 provider、宿主确认及 HTTP 全流程，可设置
1..120000 毫秒。`call.signal` 与可选 UNIX 纳秒 `deadlineNs` 都会取消等待；
客户端不自动重试授权、code 签发或退出。

后端错误按 envelope、envelope.details、error.details、error 的顺序合并公开
非 null 字段，排除 code/message/error/details 结构键。原始 `errCode`、`errMsg`
和公开扩展进入 `ReferenceIdentityError.details`；容器分类使用五种 canonical
类别，兼容对应 ERR_*、授权错误和 ERR_UNSUPPORTED_CAPABILITY。原后端分类保留
在 `error.backendCode`，供 wrapper 判断是否刷新快照。服务端必须遵守公开错误
响应不包含凭据的契约；客户端不会附加 host-token provider 的原始异常内容。

运行有限 Node 24 验证：

```sh
node --test --test-timeout=10000 examples/hosts/web-wasm/reference-identity-client.test.mjs
```

测试使用真实 Node HTTP 服务和临时 SQLite 数据库，覆盖授权、code 兑换、退出、
取消、迟到数据、凭据域和传输限制；它不替代浏览器 direct/Worker 安装链路、
QuickJS/V8 或设备验收。测试只关闭自身创建的服务和连接，删除自身数据库与目录。
