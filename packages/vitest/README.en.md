# @weapp-container/vitest

[简体中文](README.md) · **English**

The Vite plugin owns compilation and immutable pack generations for each Vitest project. Fixtures create a separate real QuickJS subprocess per test. Use Vitest 5, Node 24.22.2 and weapp-vite 7.5+.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { weappContainerTest } from '@weapp-container/vitest/config'

export default defineConfig({
  plugins: [weappContainerTest({ build: { cwd: '.' } })],
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

`build` accepts `weapp-vite/test` options: `cwd`, `configFile`, `outDir`, `mode`, `projectConfigPath`, `skipNpm`. Its default cwd is the project root. Tests execute in Node; business artifacts execute in QuickJS.

Use `createContainerTest({ host, syncValues, ... })` for test mocks, or call `container.mock(...)` before mounting. Config `container` accepts serializable options; function handlers stay inside the test worker. Existing packs can use `createContainerTest({ pack, artifact })` directly.

Watch publishes complete artifacts before rerunning the owning project. Active tests continue using their original generation. Compilation errors enter Vitest's error state and provide a failure descriptor to fixtures, preventing fallback to stale output. Shutdown waits for compilation, reruns and fixture cleanup before deleting owned generations.

Custom compilers accept `artifact: { build, watch? }`. Build returns `{ packPath, sourceRoot, generationRoot? }`; watch returns `{ artifact, close, generations? }` and publishes through callbacks. The plugin cleans generations created by `packArtifact`; custom factories own their paths. Set `disposeArtifacts: false` for external lifecycle management.

See the Node SDK README for APIs, clocks, mocks, node snapshots and testing limits. The integration uses a standard Node environment and fixtures without a custom pool.
