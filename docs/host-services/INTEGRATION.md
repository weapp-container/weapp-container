<a id="host-integration-guide"></a>
# 宿主接入指南

**简体中文** · [English](INTEGRATION.en.md)


本指南对应 `0.1.0-preview.6.0` 源码和 host services 协议 `1.0`，C ABI 仍为 `1`。
历史 runtime archive/ORIGIN/验收记录没有更新，旧二进制不能运行本功能。先构建匹配
此源码的 runtime 和 SDK，再通过 `capabilities.hostServices.protocolVersion` 判断可用；
配置、注册或能力检查失败应直接终止接入，不能退回开发沙箱登录或支付。

<a id="installation-and-account"></a>
## 安装和账号

宿主先验证发行者、安装许可及包内容，形成 `TrustedApplication`。`packRoot` 必须
匹配将加载包的完整性根；只有哈希相同不表示发行者可信。更新用宿主安装策略授权
`authorizeInstalledPack`，不能接受小程序自己传入的 publisherId 或账号。

初始化顺序是：

1. 用已有宿主登录恢复真实用户，取得单调递增十进制字符串 `epoch`；没有登录时
   使用 `principalId:null`。宿主 token 留在宿主安全存储或现有身份后端。
2. 创建 controller，并配置 `application`、`account` 和已取得的同步快照。资料/手机号
   grant 初始值来自授权后端；不能用“宿主已登录”推断这两项已授权。
3. 安装 identity/payment handlers、实际设备工具组及明确允许的网络 origin，再加载包。
   `registerApiHandler` 只接受锁定清单内宿主所有的 API，业务扩展用 `registerHostMethod`。
4. 收到 native presentation 后放开输入。页面 ready、源码编译成功和原生支付 SDK 回调
   均不是画面或最终财务验收。

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

`getAccountInfoSync` 仍返回小程序信息。小程序通过 `wx.login` 得到应用作用域的一次性
code，交给自己的业务后端用 confidential client 兑换。参考服务的 `appUserId` 是应用
隔离标识，不是微信 openid；参考服务也不签发微信 session_key。

资料授权经 `wx.getUserProfile` / 已授权的 `wx.getUserInfo`；手机号走真实
`button open-type="getPhoneNumber"` → native 授权 → `bindgetphonenumber`，由业务
后端兑换号码 code。不存在 `wx.getPhoneNumber`。授权绑定用户、app、环境、用途和
授权版本；撤销时同时更新后端和当前 owner 的快照/事件。
参考服务的用途和权限版本由后端 `authorizationPolicies` 登记。Android/iOS 原生
适配器先读取 policy 并展示用途，再提交用户确认的原版本；弹窗期间 policy 改变会
拒绝此次授予。用途或版本变更让旧授权和待兑换手机号码失效，重新授权后也不能
复活旧 code。未配置 policy 的类别不可申请；旧无版本记录不自动升级。

`weappContainer.identity.getState()` 同步返回应用状态，`onChange/offChange` 订阅相同
schema。`identity.logout()` 只撤销该应用登录并重建该应用的所有实例，宿主账号和其他
app 保留。退出时不能只改一个 JS 布尔值；旧 owner 的请求、资源及存储租约必须退休。
应用登录和资料、手机号 consent 分别管理：授权可以先于 code 兑换，应用退出保留
consent。`hostLoggedIn:false` 时三项应用/授权状态均为 false。快照可携带不透明
`authorizationVersion`；`userInfo` 只在资料授权有效时出现。宿主仍须显式刷新或推送
授权变化，不能凭缓存判断后端当前是否允许披露。

<a id="web-reference-identity-backend"></a>
### Web 参考身份后端

Web 归档提供 `reference-identity-client.mjs`，由宿主页面创建客户端后传入
`BrowserHostServices({ identity })`。固定 `endpoint` 指向参考服务；部署时由同源
反向代理挂载 `/v1/host/*`。跨域部署需要服务端明确允许宿主 origin，参考服务不自动
开放 CORS。`allowLoopbackHTTP:true` 仅供显式启用的本地开发；其他 endpoint 使用 HTTPS。

`hostToken` 从宿主安全凭据接口按可信 application/account 取 token。客户端只在宿主
页面内执行，不将 token 放入 Worker 初始化参数、同步快照或小程序 `wx.request`。
`confirmAuthorization` 由宿主展示服务端登记的 kind、purpose、permissionVersion 并返回
用户的明确选择；`wx.getUserInfo` 读取既有授权，不自动弹窗或授予。

`wx.login` 只签发 code。小程序将 code 发给自己的业务后端，后端用独立 confidential
client 凭据兑换；这些凭据不属于 Web 客户端配置。兑换后 `wx.checkSession` 会刷新
当前 owner 的同步状态。应用退出先撤销后端应用会话，再通过 `requestLogout` 同步
启动账号管理器的应用退出操作，返回可查询 receipt；该回调不能等待正在退休的
owner 自身关闭。关闭、换号或超时后的结果不会写回新 owner。

<a id="number-swapping-and-resource-cleanup"></a>
## 换号与资源清理

原生 SDK 的 `HostAccountManager` 按 host/tenant 共享。宿主的换号操作提升共享 epoch，
所有关联 controller 立即阻断旧输入和结果。公共 controller 不变，内部 sessionId 更新。
新启动参数从 `switchAccount` 的 `launches` 或 `updateAccountSwitchLaunch` 提供；页面栈、
旧 query 和 JS 数据不继承。快速换号只允许最新 epoch 继续。

换号操作返回 `operationId`；通过 `queryAccountSwitch` 读取阶段和终态。清理期间只
接受状态、取消、关闭及专门的恢复命令；普通业务命令失败。旧 GPU surface 真正解绑、
设备/媒体/文件工作排空后才能 acknowledge cleanup，随后刷存储并释放锁，再启动新
owner。新布局/画面未呈现或重载失败时保持阻塞，绝不恢复旧账号。

Flutter 和 React Native 可用 `registerAccountCleanupHandler` 注册自定义资源清理。
处理器必须等待真正的停止/释放，支持取消且可重复调用。失败会保持阻塞，由
`retryAccountCleanup` 显式重试。关闭也等待全部处理器，关闭失败可再次 `close()`；
失败后的 controller 继续拒绝业务命令。`operationId` 是不透明标识，关闭时也会传入
独立操作标识，不能把它解析成账号。原生 SDK 对应 `accountCleanupHandler` /
`onAccountCleanup` 异步 hook。

清理旧账号时，核心会清空账号相关同步快照。宿主用
`prepareAccountHostServiceSnapshots{operationId,values}` 为**当前尚未确认的**操作准备
新快照，让新 JS 的第一条同步读取就看到新状态。旧操作不能刷新快照。凭据刷新如果
用户未变，直接更新宿主客户端和已授权快照，通常无需重启。

宿主删除账号时先切走并关闭所有持有旧租约的实例，再调用 `deleteAccountData`。
仍持锁时返回 `ERR_STORAGE_LOCKED`。本地成功后仍需宿主身份后端撤销该用户所有
app grants/token；返回的后端撤销要求不能被忽略。不要记录用户 token 或手机号到
诊断日志。

<a id="files-events-and-native-components"></a>
## 文件、事件与原生组件

持久键值、文件和 native 授权记录按宿主/租户、小程序、环境、用户分区。合法版本
升级复用分区；旧未分区数据不会自动导入，明确调用 `migrateLegacyStorage` 才迁移。
即使键值存储选择 memory-only，原生文件也使用宿主设置的 `managedFilesRoot`。

guest 的 `identity.logout` 仅撤销当前 host/tenant/publisher/app/environment 范围，
同一应用的合法升级沿用这个范围。不同发行者或环境使用相同 appId 不会被一起退出。
Rust 宿主可以显式调用 `revoke_application_scope` 撤销准确范围；原有
`revoke_application(app_id)` 保留为宿主主动跨环境撤销的入口。超时的退出结果不触发
本地账号重建；后端实际已经撤销的授权仍由后续状态恢复/校验处理。

原生 `managedFileScope` 命令返回持租约的 `root`（guest 文件）和 `auxiliaryRoot`
（native consent 等）；二者只给 native，不能传给 guest。guest 只见
`wx.env.USER_DATA_PATH === 'wxfile://user'`。所有路径拒绝越界/符号链接以及 `.weapp-*`
内部路径。同步文件由独立 Rust 同步 callback 在 VM 所在线程执行，写入真正落盘后
才返回；与异步文件事务共享系统文件锁。没有同步持久化能力的 Web 不注册这些方法。

平台回调只进入有界邮箱，所属 runtime 线程 drain 后再进 JS。事件携带当前
`sessionId/accountEpoch/subscriptionId/sequence`；对象、订阅和二进制句柄只能属于
创建它们的 owner。取消、超时、换号、销毁后迟到结果不再结算旧 Promise 或触发回调。
callback → complete → Promise 的顺序与原始 `errCode/errMsg` 都经过双引擎合约检查。

原生 SDK 的 `capabilities.hostServices.apiResourceChunks === '1.0'` 表示可调用
`hostApiResource({context,offset,length})`。每次最多读取 1 MiB，返回 `bytes` 和
`totalBytes`；资源总量最多 16 MiB 减 64 KiB。`context` 必须是尚未结算的
`InnerAudioContext.src` setter 原始可信上下文，来源由 runtime 从该调用中选择，
宿主不能另传 path 或 hash。每块读取都重新验证调用、期限、manifest 大小与摘要，
换号、取消或结算后不再可读。底层沿用既有 C ABI 的 command 通道；旧 runtime
未协商该扩展时明确拒绝包内来源。这个入口只交付资源字节，格式解码能力仍以各端
实际安装的后端及其参数范围为准。

`hostComponents` 给出已接受节点的 page/node/owner scope、几何、裁剪、层级和可见性。
Context 的 `context.componentTarget` 由 runtime 解析，native 不接受 guest 自称的节点
身份。相机/视频输出 `hostComponentFrame` 插入正常 Skia 绘制位置，沿用裁剪、透明度、
变换和 sibling 层级；不能把独立窗口当作组件。节点卸载、隐藏、后台、换号和关闭
均停止对应资源。格式为 rgba8，单帧/总保留量有界，旧帧序号直接丢弃。

<a id="payment-and-example"></a>
## 支付与示例

推荐 guest 只调用 `weappContainer.payment.request({orderId})`。宿主从冻结的 app/用户/
epoch 上下文向自己的后端取得 launch，再交给明确配置的渠道。`wx.requestPayment`
仍有宿主注册入口，但微信小程序签名不能交给 App SDK，不能验证/映射时必须拒绝。

微信 App、支付宝签名订单、JSAPI、H5 和扫码 launch 分开。没有开通产品或平台无
对应 SDK 时不静默切换。订单绑定应用、用户、epoch 和幂等键。取消等待、换号或
超时不会撤销支付，不能自动重试扣款。native SDK 成功后还需要后端验签通知/查单
确认；订单最终状态以后台为准。

可运行的本地闭环包括：

- [示例小程序](../../examples/apps/host-services-app/README.md)：code 兑换、授权和订单 UI。
- [参考后端](../../tools/host-services-reference/README.md)：Node.js 24 ESM + SQLite，
  真实 HTTP/事务/验签测试；控制凭据和商户凭据不下发 guest。
- Android/iOS 的 `HostServicesClient`、identity 与官方 App payment adapter；Flutter/RN
  的 `installNativeDeviceApis` 安装 OS 工具组，自定义身份/支付业务仍由宿主提供。
- Web 的 `BrowserHostServices` / `BrowserHostAccountManager` 接收宿主处理器，与
  Worker 共用一个内部 owner；生产默认严格拒绝未安装能力。

reference 仅为明确配置的本地参考通道，不会发生真实交易。真实商户验收需另提供
已开通的产品、签名宿主、密钥与回跳配置，按后端 README 的验签流程独立执行。

完整清单和七端状态见 [台账](README.md)。`present` 只说明具体源码存在；每个 API
的参数范围、OS 条件、真实硬件证据和当前产物版本都必须另行核对。
