# @weapp-container/vite

为 Vite 和 Vitest 生成 Weapp Container 使用的不可变 portable pack。小程序源码由 `weapp-vite` 编译，容器插件负责把测试产物转换为 `@weapp-container/node` artifact，并管理 watch 代际。

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

Vitest 会使用同一插件配置生成 artifact。watch 模式下每次编译都会发布完整的新代际，当前测试完成后才重跑所属 project。编译错误会进入 Vitest 错误状态，不会回退到旧产物。

默认编译器通过 `weapp-vite/test` 的 `buildTestArtifact` 和 `watchTestArtifact` 工作。也可以传入 `artifact` 覆盖产物工厂，或传入 `compiler` 适配其他等价的测试编译器。

Vite 开发模式会启动 artifact watcher，产物通过 `onArtifact` 暴露。所有由 `packArtifact` 创建的代际会在 Vite/Vitest 关闭时清理。外部工厂可设置 `disposeArtifacts: false` 自行管理路径。
