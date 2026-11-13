# @weapp-container/node

在 Node 中驱动真实 Rust + QuickJS 小程序运行时。每个容器拥有独立子进程、Session、存储和业务堆；页面与组件从验证过的 portable pack 加载。

```ts
import { createContainer } from '@weapp-container/node'
import { packArtifact, disposeArtifact } from '@weapp-container/node/artifact'

const artifact = await packArtifact({ projectPath: './dist-project' })
const container = await createContainer({ pack: artifact.packPath, artifact })
try {
  const page = await container.renderPage('/pages/counter/index')
  await (await page.query('#increment')).tap()
  console.log(await page.data('count'))
} finally {
  await container.dispose()
  await disposeArtifact(artifact)
}
```

`projectPath` 指向含 `project.config.json` 的项目根；也可直接提供 `miniprogramRootPath`。使用 weapp-vite 源码项目时，安装 `weapp-vite >= 7.5.0`，调用 `buildWeappViteArtifact({ cwd })` 或由 Vitest 插件统一编译。

## API

- `renderPage(route, options)` 创建新 Session 并启动 App / 页面；重复调用会回收旧 Session。`options` 进入真实启动与页面生命周期。
- `renderComponent(path, { properties, slots, events })` 在生成 pack 前加入测试宿主页，返回真实组件实例句柄。支持 `data`、`callMethod`、`query`、`setProperties`、`emitted`。更新的属性必须在初始 `properties` 中声明；事件名称在 `events` 中声明。默认 slot 名为 `default`。
- `navigateTo`、`redirectTo`、`navigateBack`、`currentPage`、`lifecycle(visible)` 走现有导航与生命周期协议。
- `page.data(path?)` 返回 JSON 数据，支持 `items[0].title`；`callMethod(name, ...args)` 调用同步方法并收敛异步副作用。当前不接收方法返回的 Promise；可从同步方法启动异步任务，再观察数据。
- `query` 找不到节点时报错；`queryAll` 返回数组。节点提供只读 `snapshot`、`text`、`tap()`、`input(value)`、`trigger(type, detail)`。事件沿已提交 View 的真实路径传播。
- 页面句柄绑定原 Session 和 PageId。节点是当前 View 修订的快照；渲染更新后需要重新查询，旧节点会拒绝操作。
- `diagnostics()` 返回结构化业务日志与错误。未捕获异常、未匹配 mock、默认的 `console.error` 会使操作或回收失败。可用 `failOnConsoleError: false` 放宽控制台策略。
- `dispose()` 幂等，停止新操作，取消 host signal，等待在途操作、mock 与子进程退出；清理失败会抛出 `AggregateError`。也支持 `await using`。

## mock、时间与 flush

```ts
const container = await createContainer({
  pack: artifact.packPath,
  artifact,
  nowMs: 1000,
  syncValues: { 'wx.getDeviceInfo': { model: 'test' } },
  host: {
    'wx.request': async (payload, { signal }) => ({
      statusCode: 200, header: {}, data: { count: 42 },
    }),
  },
})
await container.clock.advanceBy(10)
const { pendingHostCalls } = await container.flush()
```

host handler 在业务执行前安装，覆盖 App 启动期请求。同步 API 使用 `syncValues`；异步 API 使用现有 provider 完成协议。未匹配的 `wx.request` 默认失败；不会发出真实网络请求。其他 mock API 应在首次挂载前声明，之后可替换已声明 handler。handler 必须响应取消 signal 或最终完成，回收会等待它。

`flush()` 处理 microtask、setData、已经完成的 host 回调和 View 更新，直到当前就绪工作收敛；不会推进未来 timer，也不会等待尚未完成的外部 mock。返回 `pendingHostCalls` 便于断言；超过 `flushBudget`（默认 100 轮）则失败。`clock.advanceBy` 推进会话 Date、guest `performance.now()` 与 timer 时间，随后 flush。不会覆盖真实执行预算、provider deadline、进程 watchdog 或 Node 的时间。

普通 wx 请求在页面卸载后仍遵守现有回调兼容性契约，迟到结果不能重用新页面实例。RequestTask 显式 abort 与容器销毁会取消宿主工作。

默认单轮执行预算 1000 ms、启动预算 5000 ms、RPC / 回收 watchdog 10000 ms，分别通过 `turnTimeoutMs`、`bootstrapTimeoutMs`、`timeout` 设置。无限执行中断后该 Session 必须重建。

## 二进制

npm 可选平台包提供 macOS arm64、Linux x64 glibc 二进制，安装不需要 Rust。可通过 `binaryPath` 或 `WEAPP_CONTAINER_TEST_BINARY` 指定二进制。源码 checkout 使用 `pnpm testing:build`；SDK 不会隐式调用 Cargo。

测试验证容器中的逻辑行为与逻辑树，不能替代微信兼容性认证、设备能力或浏览器像素测试。Node 的 `vi.mock`、`vi.useFakeTimers`、默认覆盖率不会自动作用于 QuickJS 业务产物。
