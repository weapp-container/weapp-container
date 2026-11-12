<a id="weapp-vite-product-matrix-verification"></a>
# weapp-vite 产物矩阵验证

**简体中文** · [English](weapp-vite-matrix.en.md)


`verify-weapp-vite-matrix.mjs` 是容器仓库与 `vendor/weapp-vite` 之间的构建回归入口。它先核对 superproject 记录的 submodule SHA 与本地 checkout，再列出容器首版要求的六个小程序产物目标：`weapp`、`alipay`、`swan`、`tt`、`jd`、`xhs`。

这条检查只验证构建侧产物。它不能把构建结果推断为微信开发者工具、第三方开发者工具、模拟器、模拟设备或真机运行时通过。

<a id="runtime-mode"></a>
## 运行方式

安全的计划检查不会启动上游 E2E：

```bash
pnpm run weapp-vite:matrix
# 等价于
node scripts/verify-weapp-vite-matrix.mjs --dry-run
```

执行上游完整构建 gate，并按串行规则写入 JSON 报告：

```bash
pnpm run weapp-vite:matrix:run
# 等价于
node scripts/verify-weapp-vite-matrix.mjs --run
```

默认会在 `vendor/weapp-vite` 中执行容器包装脚本：以固定 lockfile 安装依赖、运行上游 `build:pkgs` 生成被忽略的 `dist` 文件，再运行 `pnpm run e2e:platform:build`。结果写入 `artifacts/weapp-vite-matrix.json`。这个上游命令自身覆盖所选构建矩阵，因此报告会保留一条 aggregate evidence，并将相同的实际退出状态映射到每个所选目标。只有子进程退出码为 0 时才会出现 `passed`；dry-run 使用 `planned`，submodule 不一致使用 `blocked`，命令失败使用 `failed`，不会伪造通过。

可用选项：

```bash
# 只报告两个目标
node scripts/verify-weapp-vite-matrix.mjs --dry-run \
  --target weapp --target alipay

# 自定义聚合命令
node scripts/verify-weapp-vite-matrix.mjs --run \
  --command 'node ../../scripts/build-weapp-vite-platforms.mjs' \
  --report artifacts/matrix-custom.json

# 自定义按目标命令。{platform} 会被替换，并严格串行执行六次。
node scripts/verify-weapp-vite-matrix.mjs --run \
  --command 'node ./scripts/build-one.mjs --platform {platform}'
```

也可以用 `CONTAINER_WEAPP_VITE_MATRIX_COMMAND` 提供项目命令。自定义命令在上游 submodule 根目录执行，并会收到 `E2E_FULL_MATRIX=1`、`E2E_PLATFORM` 和 `CONTAINER_MATRIX_PLATFORM` 环境变量。命令输出、退出码、信号、错误和耗时都会原样写入报告；请将报告作为 CI artifact 保存。

<a id="target-agreement"></a>
## 目标契约

| 目标 | 主要模板 | 主要样式 | 项目配置 |
| --- | --- | --- | --- |
| `weapp` | `.wxml` | `.wxss` | `project.config.json` |
| `alipay` | `.axml` | `.acss` | `mini.project.json` |
| `swan` | `.swan` | `.css` | `project.swan.json` |
| `tt` | `.ttml` | `.ttss` | `project.config.json` |
| `jd` | `.jxml` | `.jxss` | `project.config.json` |
| `xhs` | `.xhsml` | `.css` | `project.config.json` |

上表是容器矩阵的目标清单和产物方向，具体文件断言由固定在 submodule commit 的上游 `e2e:platform:build` 完成。目标清单不是对当前运行时能力的声明；运行时能力仍需在对应官方工具和设备门禁中单独验收。

<a id="ci-constraints"></a>
## CI 约束

- 每次运行必须使用与 superproject index 匹配的 `vendor/weapp-vite` commit；不匹配时不会启动构建。
- 运行是串行的，避免并行启动多个小程序工具或共享的 E2E 资源。
- `--run` 返回非零表示 submodule 不一致、命令启动失败或至少一个执行记录没有 `passed`。
- 报告中的 `passed` 只表示配置的构建命令返回 0。它不等价于跨端容器已经完成真实 DevTools、模拟器或真机验收。

