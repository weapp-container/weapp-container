# @weapp-container/vite

Generate immutable portable packs for Weapp Container from Vite and Vitest. Mini-program sources are compiled by `weapp-vite`; this plugin adapts its test artifacts to `@weapp-container/node` and owns watch generations.

```ts
// vite.config.ts / vitest.config.ts
import { defineConfig } from 'vite'
import { weapp } from 'weapp-vite/vite'
import { weappContainer } from '@weapp-container/vite'

export default defineConfig({
  plugins: [weapp(), weappContainer()],
  test: { environment: 'node' },
})
```

Vitest uses the same plugin configuration to build an artifact. In watch mode each compilation publishes a complete new generation and reruns only the owning project after the active tests finish. Compilation errors enter Vitest's error state without falling back to stale output.

The default compiler uses `buildTestArtifact` and `watchTestArtifact` from `weapp-vite/test`. Pass `artifact` to provide a custom artifact factory, or `compiler` to adapt an equivalent test compiler.

Vite development mode starts an artifact watcher and exposes generations through `onArtifact`. Generations created by `packArtifact` are removed on Vite/Vitest shutdown. Set `disposeArtifacts: false` when an external factory owns its paths.
