<a id="harmony-account-execution-boundary"></a>
# Harmony 账户执行边界

**简体中文** · [English](ACCOUNTS.en.md)


`session/HostAccountManager.ts` 管理一个宿主/租户账户域及其所有小程序控制器。示例 `Index.ets` 在其实际的 ArkUI 启动、输入、呈现和关闭流程中使用了该管理器。其初始账户为匿名。宿主应用提供已认证的主体；示例不自行创建登录、手机号或支付凭证。

<a id="trusted-application-and-native-owner"></a>
## 可信应用和原生拥有者

传递 `hostAppId`、`tenantId`、`publisherId`、`appId`、`environment`、`version` 和 `packRoot` 从宿主的可信安装记录中。在附加之前，将已验收的包绑定到该记录上。匹配的 SHA-256 可以证明包字节内容，而不是其发布者。捆绑的示例的固定身份描述的是宿主安装的固定组件，而不是用于验证下载代码的机制。`HarmonyHostServices.configure()` 和 Rust 会验证已验收的包根。

`createOwner(context)` 必须为每个实例调用 `createWeappContainer()`，构建一个新的 `HarmonyHostServices`，重新安装所有适配器，并返回一个未启动的 `HarmonyLiveSession`。`Index.ets` 通过管理文件、网络、Socket、系统、BLE 和录音适配器展示了这一过程。该工厂即使适配器设置失败，也必须返回其确切的会话，以便管理器可以释放资源。如果设置失败，应在返回会话前报告该会话的失败。管理器会验证其真实的执行身份，启动一次会话，并等待真实的呈现确认后才启用输入。一个已解析的任意等待器无法使未呈现的会话就绪。

新的工厂需要原生的 `createOwner` 导出；较老的库会抛出 `ERR_PROTOCOL_VERSION`。新实例使用独立的原生句柄、VM状态、宿主服务配置和存储租约。它们的GPU绘制表面借用进程EGL显示，但会释放自己的上下文/表面；终止一个实例不会终止另一个实例或ArkUI使用的显示。

<a id="stable-controller-fresh-session"></a>
## 稳定的控制器，新的会话

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

`controller` 保持稳定。旧的纪元会同步关闭所有相关控制器的输入/调用门，包括等待呈现的候选者。状态观察器在该共享门之后运行，因此重新进入的较新切换无法将兄弟控制器留在较旧的纪元中。纪元算术永远不会经过 JavaScript 数值。在宿主身份变更时，纪元必须严格递增；快速变更会为较旧的操作发布 `superseded`。

有序的边界会撤销旧的回调，取消设备工作，等待实际资源释放和GPU解绑，关闭原生所有者及其存储锁，然后调用新的所有者工厂。启动时会获得一个全新的会话ID、路由、查询、场景和额外数据；不会复用旧的页面栈或JS状态。替换失败会阻断输入，并且永远不会恢复之前的用户。示例中为失败的替换提供了明确的重试按钮。

在替换期间，`invoke()` 会拒绝包含业务命令的请求，返回 `ERR_IDENTITY_SWITCHING`；替换之后到达的结果将被拒绝，返回 `ERR_CANCELLED`。`state`、`query()`、`cancel()` 和 `close()` 仍然可用。`ready` 和切换回执携带操作 ID 和终端阶段。`cancel()` 会撤销候选者，但不会撤销账户选择。在解决启动或退休失败后，调用 `controller.retry()`。

<a id="real-cleanup-and-retained-failure"></a>
## 真正的清理和保留的失败

`HarmonyLiveSession.revokeIdentity()` 立即阻塞输入、定时器、前台重新进入、启动和宿主回调。`closeAndDrain()` 在销毁其所有者之前会等待确切的原生清理承诺。 detach 失败、设备释放、临时文件清理或原生撤销均保留其原始所有者和释放操作。`cleanupComplete` 保持为 false，回执状态为 `closing`，直到原生销毁真正成功。后续重试会重新执行失败的操作；成功释放和卸载钩子不会重复执行。

在宿主域的认证生命周期内保持管理器的存在，超出单个页面或 ArkUI 组件的范围。被拒绝的 `controller.close()` 会保留该控制器在该管理器中。请重试 `controller.close()` 或 `manager.retryRetirements()`；不要丢弃管理器，也不要因锁失败而在同一命名空间中重新打开。示例模块级别的管理器在其组件被销毁后，仍会保留失败的关闭屏障。其操作系统前台、绘制表面和呈现回调与具体的候选者绑定；延迟的旧回执永远不会更新新的视图。

<a id="backend-grants-and-user-namespaces"></a>
## 后端、权限和用户命名空间

宿主凭据保留在宿主或其后端。`refreshCredentials()` 为仅限宿主的回调提供一个账户副本和一个 `current()` 保护。仅在该保护为真时才提交刷新的凭据；过期的完成将被拒绝。正常的同用户凭据刷新不会重建虚拟机。不会将宿主令牌注入到任意 `wx.request` 调用中。

工厂在 `configure()` 之前调用可选的 [参考宿主组件](REFERENCE_HOST.md)。
配置其真实的 HTTPS 后端和原生令牌关闭逻辑，或在此处安装你自己的真实登录/检查会话、资料、手机号和支付处理程序。
与宿主后端通信时，必须使用上下文的精确账户、应用、操作和取消边界。
生成应用级的单次使用登录码，并保留提供方错误；不要返回未经验证的占位符，也不要将其标记为微信凭证。
用户资料、手机号和设备权限需要独立的宿主授权和后端记录。
手机号权限是一个按钮事件合约，而不是虚构的 `wx.getPhoneNumber`。

在后端授予该应用权限后，调用受保护的 `context.grantApplication()`。应用登出时，撤销该应用的后端授权，并调用 `context.requestLogout(freshLaunch)`；它仅重建该应用的实例。主机账户和其他应用保持登录状态。旧版本的钩子在登出或主机切换后将被拒绝。管理器的内存授权状态是一个执行门控；后端仍是持久的授权权威。

`harmonyStorageScope()` 描述了宿主、租户、发布者、应用、环境和主体。Rust 计算实际的私有路径并拥有存储锁。合法的版本/包升级保留此命名空间。账户变更会隔离该命名空间。旧版未分区的数据永远不会被自动导入；需提供独立的显式迁移工具，并指定源/目标。

`deleteAccount()` 需要明确的后端撤销和本地数据删除回调。它会保留主体以防止并发恢复，将当前账户切换为匿名，等待实际所有者完全退出，然后清除所有已知的应用程序范围，包括已经解离的控制器。原生退休失败将阻止删除。宿主删除回调必须在锁释放后移除确切的 Rust 管理的命名空间，而不是其他无关的账户数据。

<a id="validation-boundary"></a>
## 验证边界

node --test scripts/harmony-account-manager.test.mjs
scripts/harmony-host-services.test.mjs scripts/harmony-live-session.test.mjs
scripts/harmony-recorder-lifecycle.test.mjs scripts/harmony-bluetooth-lifecycle.test.mjs
对生产管理器/会话/服务代码进行测试，以应对有限的原生边界。它涵盖了兄弟网关、快速和重入切换、过期完成、应用登出、刷新、删除、真实释放屏障和重试。
LiveSession 集成使用了真实的管理器和服务分发器，并需要当前的呈现确认。

源绑定的官方 API 24 未签名 HAP 构建记录于
`docs/host-services/evidence/2026-11-02-harmony-account`。单独的
`2026-11-02-harmony-native-owners` 证据在宿主上运行生产环境 N-API C++ 对 Rust QuickJS 进行验证，并检查原生所有者隔离和 GPU 故障路径。
既没有有限适配器测试，也没有 SDK 编译来证明物理 Harmony 账户/绘制表面切换、设备权限、BLE 或录制功能。这些检查仍处于 **验收中**，同时还需要一个实际配置的账户/支付后端。现有的历史安装设备回执仍绑定到其原始来源。
