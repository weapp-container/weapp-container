# @weapp-container/agent

小程序开发 CLI 和 MCP 服务。独立安装、新建品牌项目和宿主接入见[厂商快速开始](https://github.com/weapp-container/weapp-container/blob/main/docs/vendor-onboarding.md)。

运行浏览器场景测试之前安装 Chromium，命令为 `npx playwright install chromium`。

## CLI

```sh
npx weapp-container-agent init --project <project>
npx weapp-container-agent create --project <new-project> --name <display-name>
npx weapp-container-agent inspect --project <project>
npx weapp-container-agent build --project <project> --out <pack-directory>
npx weapp-container-agent preview start --project <project> --simulator-bin /abs/path/weapp-simulator
npx weapp-container-agent preview status --project <project>
npx weapp-container-agent preview stop --project <project>
npx weapp-container-agent test run --project <project> --scenario scenario.json
npx weapp-container-agent job status --project <project> --job <job-id>
npx weapp-container-agent release prepare --project <project> --version 1.0.0
npx weapp-container-agent release commit --project <project> --version 1.0.0 --confirm
npx weapp-container-agent release publish --project <project> --version 1.0.0 --confirm --private-key /abs/path/private.key
```

`build` uses the project's `weapp-vite` installation. `preview start` uses a locally built simulator from this repository, or the executable passed through `--simulator-bin` / `WEAPP_CONTAINER_SIMULATOR_BIN` when installed as a package.

`build --platform <target>` runs one compiler target. It creates a container portable pack only for `weapp`; other targets return their compiler output directory for validation with the matching platform tools.

对于已有的原生微信小程序，先运行 `inspect`。输出中的 `compatibility.findings` 会扫描 JavaScript/TypeScript、WXML 和 WXSS 的实际使用点，并为每条记录提供文件、行号、`full`/`partial`/`unsupported`/`unknown` 状态、证据和修复建议。它是迁移预检，不会把静态扫描结果当成官方 DevTools 或真机通过。

最快的本地闭环如下：

```sh
npx weapp-container-agent inspect --project ./my-miniprogram
npx weapp-container-agent build --project ./my-miniprogram
npx weapp-container-agent preview start --project ./my-miniprogram --simulator-bin /abs/path/weapp-simulator
npx weapp-container-agent test run --project ./my-miniprogram --scenario scenario.json
npx weapp-container-agent preview stop --project ./my-miniprogram
```

`preview start` owns the simulator through a loopback daemon with a random token. `preview stop` refuses to guess ownership from a stale PID. Test jobs are persisted under `.weapp-container/agent/jobs` and return a job ID before the scenario runs.

The MCP tool set also exposes project inspection, file listing, bounded source reads and atomic project-relative writes. This lets an AI client edit source, invoke a build, start a preview, drive a browser scenario, inspect durable job events, and prepare or upload a release through one project-scoped connection.

Scenario steps support `state`, `snapshot`, `bridge`, `browser`, and `wait`. Browser steps reuse one headless Playwright page and support `goto`, `locator`, `click`, `fill`, `press`, `wait`, and `screenshot`. Screenshots are written under `.weapp-container/agent/artifacts/<job-id>` and every `expect` object checks expected fields recursively.

```json
{
  "browser": { "viewport": { "width": 390, "height": 844 } },
  "steps": [
    { "op": "browser", "action": "fill", "selector": "#todo-input", "value": "Review checkout" },
    { "op": "browser", "action": "click", "selector": "#todo-submit" },
    { "op": "browser", "action": "locator", "selector": ".todo-item", "property": "text", "expect": { "value": "Review checkout" } },
    { "op": "browser", "action": "screenshot", "path": "todo-created.png" }
  ]
}
```

`release prepare` records the pack digest and simulator runtime smoke evidence. `release commit`, `release rollback`, and `release publish` require `--confirm`. Publish revalidates the committed source and pack, then calls `wv build --upload`. For WeChat, install `miniprogram-ci` in the mini-program project and set `WEAPP_CI_PRIVATE_KEY_PATH` to the code-upload key. The operation creates a developer upload. Review submission and public release still happen in the platform console.

## MCP

Run `pnpm container:agent mcp --project <project>` and connect an MCP client over newline-delimited JSON-RPC. The server implements `initialize`, `tools/list`, and `tools/call` for project inspection, build, preview, testing jobs, and local release lifecycle.
