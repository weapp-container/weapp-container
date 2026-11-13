# @weapp-container/node

[简体中文](README.md) · **English**

Drive the real Rust + QuickJS mini-program runtime from Node. Each container owns an isolated subprocess, Session, storage and business heap. Pages and components load from verified portable packs.

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

`projectPath` points to a project containing `project.config.json`; alternatively provide `miniprogramRootPath`. For weapp-vite source projects, install `weapp-vite >= 7.5.0` and call `buildWeappViteArtifact({ cwd })`, or let the Vitest plugin compile.

## API

- `renderPage(route, options)` creates a new Session and starts App/page lifecycles. Repeated calls retire the previous Session. Options enter real startup and page lifecycles.
- `renderComponent(path, { properties, slots, events })` adds a test host page before pack generation and returns a real component handle with `data`, `callMethod`, `query`, `setProperties` and `emitted`. Updated properties must appear in initial `properties`; declare event names in `events`. The default slot name is `default`.
- `navigateTo`, `redirectTo`, `navigateBack`, `currentPage` and `lifecycle(visible)` use existing navigation and lifecycle protocols.
- `page.data(path?)` returns JSON and supports paths such as `items[0].title`. `callMethod(name, ...args)` calls synchronous methods and flushes asynchronous effects. Promise return values are currently unsupported; start asynchronous tasks from synchronous methods and inspect data afterward.
- `query` throws for a missing node; `queryAll` returns an array. Nodes expose readonly `snapshot`, `text`, `tap()`, `input(value)` and `trigger(type, detail)`. Events follow the committed View's real propagation path.
- Page handles belong to their original Session and PageId. Node handles snapshot a View revision; query again after updates, since stale nodes reject operations.
- `diagnostics()` returns structured application logs and errors. Uncaught exceptions, unmatched mocks and default `console.error` fail operations or cleanup. Set `failOnConsoleError: false` to relax console policy.
- `dispose()` is idempotent, stops new operations, cancels host signals and waits for in-flight operations, mocks and subprocess exit. Cleanup failures throw `AggregateError`. `await using` is supported.

## Mocks, time and flush

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

Handlers install before business execution, including App startup requests. Synchronous APIs use `syncValues`; asynchronous APIs use the provider completion protocol. Unmatched `wx.request` calls fail without real network access. Declare other mock APIs before the first mount; existing handlers can then be replaced. Handlers must observe cancellation or eventually finish, because disposal waits for them.

`flush()` processes microtasks, setData, completed host callbacks and View updates until ready work converges. It neither advances future timers nor waits for unfinished external mocks. It returns `pendingHostCalls` for assertions and fails after `flushBudget` rounds (default 100). `clock.advanceBy` advances session Date, guest `performance.now()` and timers, then flushes. Real execution budgets, provider deadlines, process watchdogs and Node time remain independent.

Ordinary wx requests preserve the existing callback compatibility contract after page unload; late results cannot reuse a new page instance. Explicit RequestTask abort and container disposal cancel host work.

Default turn execution budget is 1000 ms, bootstrap budget 5000 ms, and RPC/cleanup watchdog 10000 ms. Configure them with `turnTimeoutMs`, `bootstrapTimeoutMs` and `timeout`. A Session interrupted for infinite execution must be recreated.

## Binaries

Optional npm platform packages provide macOS arm64 and Linux x64 glibc binaries without requiring Rust. Override with `binaryPath` or `WEAPP_CONTAINER_TEST_BINARY`. Source checkouts use `pnpm testing:build`; the SDK never invokes Cargo implicitly.

Tests validate container logic and the logical tree. They do not replace WeChat certification, device capability checks or browser pixel tests. Node `vi.mock`, `vi.useFakeTimers` and default coverage do not automatically affect QuickJS business artifacts.
