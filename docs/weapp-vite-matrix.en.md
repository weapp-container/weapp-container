<a id="weapp-vite-产物矩阵验证"></a>
# weapp-vite product matrix verification

[简体中文](weapp-vite-matrix.md) · **English**


`verify-weapp-vite-matrix.mjs` is the build regression entry point between the container repository and `vendor/weapp-vite`. It first verifies the submodule SHA recorded in superproject against the local checkout, then lists the six mini-program product targets required by the container's first version: `weapp`, `alipay`, `swan`, `tt`, `jd`, `xhs`.

This check only validates build-side artifacts. It cannot infer that the build result has passed through the runtime of WeChat Developer Tool, third-party developer tools, emulators, simulated devices, or real devices.

<a id="运行方式"></a>
## Runtime Mode

Secure plan checks will not initiate upstream E2E:

```bash
pnpm run weapp-vite:matrix
# 等价于
node scripts/verify-weapp-vite-matrix.mjs --dry-run
```

Execute the upstream complete build gate and write the JSON report according to serial rules:

```bash
pnpm run weapp-vite:matrix:run
# 等价于
node scripts/verify-weapp-vite-matrix.mjs --run
```

By default, the container wrapper script will be executed in `vendor/weapp-vite`: installing dependencies with a fixed lockfile, running the upstream `build:pkgs` to generate the ignored `dist` files, and then running `pnpm run e2e:platform:build`. The result is written to `artifacts/weapp-vite-matrix.json`. The upstream command itself overrides the selected build matrix, so the report retains an aggregate evidence and maps the same actual exit status to each selected target. A `passed` status will only appear if the sub-process exit code is 0; dry-run uses `planned`, submodule inconsistencies use `blocked`, and command failure uses `failed`—no false passes are fabricated.

Available options:

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

Project commands can also be provided via `CONTAINER_WEAPP_VITE_MATRIX_COMMAND`. Custom commands are executed in the root directory of the upstream submodule and receive the environment variables `E2E_FULL_MATRIX=1`, `E2E_PLATFORM`, and `CONTAINER_MATRIX_PLATFORM`. Command output, exit code, signal, errors, and duration are all written verbatim into the report; please save the report as a CI artifact.

<a id="目标契约"></a>
## Target Agreement

| Target | Main Template | Main Style | Project Configuration |
| --- | --- | --- | --- |
| `weapp` | `.wxml` | `.wxss` | `project.config.json` |
| `alipay` | `.axml` | `.acss` | `mini.project.json` |
| `swan` | `.swan` | `.css` | `project.swan.json` |
| `tt` | `.ttml` | `.ttss` | `project.config.json` |
| `jd` | `.jxml` | `.jxss` | `project.config.json` |
| `xhs` | `.xhsml` | `.css` | `project.config.json` |

The table above lists the target manifest and product directions for the container matrix, with specific file assertions completed by the upstream `e2e:platform:build` fixed at a submodule commit. The target manifest is not a declaration of current runtime capabilities; runtime capabilities still require separate acceptance within the corresponding official tools and device gateways.

<a id="ci-约束"></a>
## CI Constraints

- Each run must use a `vendor/weapp-vite` commit matching the superproject index; a mismatch will prevent build startup.
- Runs are serialized to avoid parallel startup of multiple mini-program tools or shared E2E resources.
- `--run` returns a non-zero exit code if submodule inconsistencies exist, command startup fails, or at least one execution record lacks `passed`.
- The `passed` in the report indicates only that the configured build command returned 0. It does not equate to actual DevTools, emulator, or real device acceptance across platforms.
