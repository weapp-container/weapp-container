# @weapp-container/vitest

**简体中文** · [English](README.en.md)

Vitest fixture 为每个测试创建独立的 QuickJS 子进程。普通项目应在 Vite 配置中使用 `@weapp-container/vite` 的 `weappContainer()`，由项目中的 `weapp-vite` 自动生成 artifact 代际：

```ts
import { defineConfig } from 'vitest/config'
import { weapp } from 'weapp-vite/vite'
import { weappContainer } from '@weapp-container/vite'

export default defineConfig({ plugins: [weapp(), weappContainer()] })
```

已有自定义编译器的项目可以使用下面的显式 artifact 工厂配置，编译器生命周期由调用方管理。

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { weappContainerTest } from '@weapp-container/vitest/config'

export default defineConfig({
  plugins: [weappContainerTest({ artifact: { build: () => loadPortablePack() } })],
  test: { environment: 'node' },
})
```

```ts
import { test, expect } from '@weapp-container/vitest'

test('点击增加计数', async ({ container }) => {
  const page = await container.renderPage('/pages/counter/index')
  await (await page.query('#increment')).tap()
  expect(await page.data('count')).toBe(1)
})
```

`artifact` 接收调用方提供的 `build()` 及可选 `watch()`。测试文件在 Node 运行，业务产物在 QuickJS 运行。

需要测试级 mock 时使用 `createContainerTest({ host, syncValues, ... })`，或在挂载前调用 fixture 的 `container.mock(...)`。配置中的 `container` 只能包含可序列化的普通选项；函数 handler 保留在测试 worker 中。已经生成的 pack 可通过 `createContainerTest({ pack, artifact })` 直接使用。

watch 发布完整产物后仅重跑所属项目；正在执行的测试继续使用原代际。编译失败进入 Vitest 错误状态并把失败描述符传给 fixture，禁止回退使用旧产物。结束时等待编译、重跑与 fixture 回收，再删除本插件创建的代际。

自定义编译器可传 `artifact: { build, watch? }`：build 返回 `{ packPath, sourceRoot, generationRoot? }`，watch 返回 `{ artifact, close, generations? }` 并通过回调发布新产物。内置 `packArtifact` 创建的代际由插件清理；自有路径由自定义 factory 管理。可设置 `disposeArtifacts: false` 保留产物供外部生命周期管理。

完整 SDK API、时钟、mock、节点快照与测试边界见 `@weapp-container/node` 的 README。默认采用普通 Node 环境与 fixture，没有 custom pool。
