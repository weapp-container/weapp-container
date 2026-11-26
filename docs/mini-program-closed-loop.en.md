# Mini-program development loop

This path covers project inspection, compilation, portable packs, preview, scenario tests, and an auditable release. The container currently consumes a WeChat-compatible `weapp` build artifact.

## 1. Install

The installation commands below require the packages to be available on npm. To try the current source, run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm simulator:build` from the repository root. Then use `pnpm container:agent <command> --project <project-directory>` to run the CLI from source. Run `pnpm testing:install:test` to verify the local Vite and Vitest tarballs.

When using published packages, run this in the mini-program project root:

```sh
pnpm add -D @weapp-container/agent @weapp-container/vite @weapp-container/vitest weapp-vite vitest
pnpm exec playwright install chromium
```

Use a Node version accepted by the repository and package engine constraints. `weapp-vite` must be installed in the mini-program project because the default artifact factory resolves `weapp-vite/test` from that project root.

Preview and the release runtime smoke require a separate `weapp-simulator` executable. Set `WEAPP_CONTAINER_SIMULATOR_BIN` to its path, or pass `--simulator-bin` to the preview command.

## 2. Configure Vite and Vitest

Create or update `vite.config.ts`:

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

Use the real container fixture in tests:

```ts
import { expect, test } from '@weapp-container/vitest'

test('the page completes an interaction', async ({ container }) => {
  const page = await container.renderPage('/pages/index/index')
  await (await page.query('#increment')).tap()
  expect(await page.data('count')).toBe(1)
})
```

`weappContainer()` participates in the Vite/Vitest lifecycle, calls `weapp-vite/test`, and turns each complete compilation generation into a container artifact. Watch mode reruns only the owning Vitest project after publishing a new generation. Compilation failures become test errors and never silently use stale output.

Projects with an existing compiler or a fixed pack can use `weappContainerTest({ artifact })` from `@weapp-container/vitest/config`. That is the explicit artifact-factory path for an existing build system.

## 3. Inspect, build, preview, and test

Run this sequence in the project root:

```sh
pnpm exec weapp-container-agent inspect --project .
pnpm exec weapp-container-agent build --project .
pnpm exec weapp-container-agent preview start --project . --simulator-bin /abs/path/weapp-simulator
pnpm exec weapp-container-agent test run --project . --scenario scenario.json
pnpm exec weapp-container-agent job status --project . --job <job-id>
pnpm exec weapp-container-agent preview stop --project .
```

`inspect` is a static source compatibility preflight. `build` defaults to `weapp` and reports both the compiler output and portable pack. Preview uses a loopback control endpoint and a random project-owned token. `test run` returns a job ID. Check its result with `job status` before stopping the preview. Use the browser `screenshot` action with the default WebView preview to save a screenshot in the job artifact directory.

Minimal browser scenario:

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

An MCP client can run `pnpm exec weapp-container-agent mcp --project .` and use the same project-scoped inspection, file, build, preview, scenario, and release operations.

## 4. Single-target compilation

Build each compiler target separately when the project supports it:

```sh
pnpm exec weapp-container-agent build --project . --platform weapp
pnpm exec weapp-container-agent build --project . --platform alipay
pnpm exec weapp-container-agent build --project . --platform swan
pnpm exec weapp-container-agent build --project . --platform tt
pnpm exec weapp-container-agent build --project . --platform jd
pnpm exec weapp-container-agent build --project . --platform xhs
```

These are independent single-target builds. The portable pack entry point and container runtime currently use the `weapp`-compatible output, so other targets need their platform-specific artifact and validation tools. Web, Desktop, Android, iOS, Harmony, Flutter, and React Native host checks are orthogonal to compiler targets and must not be presented as an unexecuted full cross-product matrix. Official developer tools, GPU, and physical-device results also require separate evidence.

## 5. Auditable release

Prepare and commit a local version:

```sh
pnpm exec weapp-container-agent release prepare --project . --version 0.1.0
pnpm exec weapp-container-agent release commit --project . --version 0.1.0 --confirm
```

`prepare` records source and pack digests, compiler identity, and runtime smoke evidence. `commit` revalidates the source and pack before updating the current-version pointer. Roll back with:

```sh
pnpm exec weapp-container-agent release rollback --project . --version 0.1.0 --confirm
```

With a code-upload private key and the project upload dependency installed, upload the developer version:

```sh
export WEAPP_CI_PRIVATE_KEY_PATH=/secure/path/private.key
pnpm exec weapp-container-agent release publish --project . --version 0.1.0 --confirm
```

The CLI waits for the upload receipt. When calling `container_release_publish` over MCP, query the returned job ID for its status. If the upload key is missing, the CLI returns `ERR_PUBLISH_CREDENTIALS` and the MCP job reports `blocked`. The upload is a developer-version submission. Review and public release remain platform-console operations.

## 6. Maintainer checks

Run the smallest repository baseline after changes:

```sh
pnpm conformance:verify
pnpm api:inventory:verify
node scripts/check-toolchain.mjs --strict --json
```

Then run the affected packages' build, typecheck, test, test:types, and lint commands before expanding to workspace checks. Auxiliary runtimes, headless browsers, and local tests do not replace official developer-tool or physical-device evidence.
