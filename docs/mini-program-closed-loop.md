# 小程序开发闭环

这条路径面向普通小程序开发者，覆盖项目检查、编译、portable pack、预览、场景测试和可审计发布。容器当前使用 WeChat 兼容的 `weapp` 编译产物。

## 1. 安装

以下命令适用于相关包已发布到 npm 的版本。当前可在仓库根目录执行 `pnpm install --frozen-lockfile`、`pnpm build` 和 `pnpm simulator:build`，并用 `pnpm container:agent <命令> --project <项目目录>` 从源码运行 CLI。Vite 与 Vitest 包的本地 tarball 验证入口为 `pnpm testing:install:test`。

使用 npm 已发布的版本时，在小程序项目根目录执行：

```sh
pnpm add -D @weapp-container/agent @weapp-container/vite @weapp-container/vitest weapp-vite vitest
pnpm exec playwright install chromium
```

Node 版本应满足仓库和相关包的 engines 约束。`weapp-vite` 必须安装在小程序项目中，因为默认 artifact 工厂会从项目根目录解析 `weapp-vite/test`。

预览和发布前的运行时 smoke 需要单独准备 `weapp-simulator`。设置 `WEAPP_CONTAINER_SIMULATOR_BIN` 指向该可执行文件，或在预览命令中传入 `--simulator-bin`。

## 2. 接入 Vite 和 Vitest

在项目根目录创建或更新 `vite.config.ts`：

```ts
import { defineConfig } from 'vitest/config'
import { weapp } from 'weapp-vite/vite'
import { weappContainer } from '@weapp-container/vite'

export default defineConfig({
  plugins: [weapp(), weappContainer()],
  test: {
    environment: 'node',
  },
})
```

测试文件使用真实容器 fixture：

```ts
import { expect, test } from '@weapp-container/vitest'

test('页面可以完成一次交互', async ({ container }) => {
  const page = await container.renderPage('/pages/index/index')
  await (await page.query('#increment')).tap()
  expect(await page.data('count')).toBe(1)
})
```

`weappContainer()` 在 Vite/Vitest 生命周期中调用 `weapp-vite/test`，将每次编译得到的完整代际转换成容器 artifact。watch 模式下只重跑受影响的 Vitest project，编译失败会作为测试错误报告，不会继续使用旧产物。

如果项目已经有自定义编译器或固定 pack，可以使用 `@weapp-container/vitest/config` 的 `weappContainerTest({ artifact })`。这是显式 artifact 工厂路径，适合已有构建系统的项目。

## 3. 从检查到测试

在项目根目录执行：

```sh
pnpm exec weapp-container-agent inspect --project .
pnpm exec weapp-container-agent build --project .
pnpm exec weapp-container-agent preview start --project . --simulator-bin /abs/path/weapp-simulator
pnpm exec weapp-container-agent test run --project . --scenario scenario.json
pnpm exec weapp-container-agent job status --project . --job <job-id>
pnpm exec weapp-container-agent preview stop --project .
```

`inspect` 的兼容性结果是源码静态预检。`build` 默认选择 `weapp`，输出编译目录和 portable pack。预览服务通过 loopback 控制端点和随机 token 归属当前项目。`test run` 返回 job ID。通过 `job status` 确认结果后关闭预览。默认 WebView 的截图使用场景中的浏览器 `screenshot` 操作，输出写入对应 job 的 artifacts 目录。

最小浏览器场景示例：

```json
{
  "browser": { "viewport": { "width": 390, "height": 844 } },
  "steps": [
    { "op": "browser", "action": "goto", "url": "/" },
    { "op": "browser", "action": "click", "selector": "#increment" },
    { "op": "browser", "action": "locator", "selector": "#count", "property": "text", "expect": { "value": "1" } },
    { "op": "browser", "action": "screenshot", "path": "counter.png" }
  ]
}
```

也可以运行 `pnpm exec weapp-container-agent mcp --project .`，让 MCP 客户端通过同一项目范围执行检查、文件读写、构建、预览、场景任务和发布操作。

## 4. 单目标编译

编译器支持按目标分别执行构建：

```sh
pnpm exec weapp-container-agent build --project . --platform weapp
pnpm exec weapp-container-agent build --project . --platform alipay
pnpm exec weapp-container-agent build --project . --platform swan
pnpm exec weapp-container-agent build --project . --platform tt
pnpm exec weapp-container-agent build --project . --platform jd
pnpm exec weapp-container-agent build --project . --platform xhs
```

这些是独立的单目标编译。当前 portable pack 入口和容器运行时路径使用 `weapp` 兼容输出，因此其它目标需要使用对应平台的产物和验证工具。Web、Desktop、Android、iOS、Harmony、Flutter、React Native 等宿主验证与编译目标正交，不能将它们组合成未经执行的全交叉矩阵。官方开发者工具、GPU 和真机结果也需要单独记录。

## 5. 可审计发布

先准备并提交本地版本：

```sh
pnpm exec weapp-container-agent release prepare --project . --version 0.1.0
pnpm exec weapp-container-agent release commit --project . --version 0.1.0 --confirm
```

`prepare` 保存源码摘要、pack 摘要、编译器身份和运行时 smoke 证据。`commit` 会重新校验源码和 pack，并更新当前版本指针。需要撤回时执行：

```sh
pnpm exec weapp-container-agent release rollback --project . --version 0.1.0 --confirm
```

有微信代码上传私钥和项目中的上传依赖时，才执行开发者上传：

```sh
export WEAPP_CI_PRIVATE_KEY_PATH=/secure/path/private.key
pnpm exec weapp-container-agent release publish --project . --version 0.1.0 --confirm
```

CLI 等待上传完成并返回回执。通过 MCP 调用 `container_release_publish` 时，使用返回的 job ID 查询任务状态。缺少上传私钥时，CLI 返回 `ERR_PUBLISH_CREDENTIALS`，MCP 任务显示 `blocked`。上传只代表开发者版本提交，审核和公开发布仍由平台控制台完成。

## 6. 维护者检查

仓库改动完成后按以下顺序执行最小基线：

```sh
pnpm conformance:verify
pnpm api:inventory:verify
node scripts/check-toolchain.mjs --strict --json
```

随后运行相关包的 build、typecheck、test、test:types 和 lint，再扩展到工作区检查。辅助 runtime、headless 浏览器和本地测试不能替代官方开发者工具或物理设备证据。
