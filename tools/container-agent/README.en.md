# @weapp-container/agent

MCP server and CLI for AI-driven mini-program development.

```sh
npm install --save-dev @weapp-container/agent weapp-vite
npx playwright install chromium
```

## CLI

```sh
npx weapp-container-agent init --project <project>
npx weapp-container-agent inspect --project <project>
npx weapp-container-agent build --project <project>
npx weapp-container-agent preview start --project <project> --simulator-bin /abs/path/weapp-simulator
npx weapp-container-agent preview status --project <project>
npx weapp-container-agent preview stop --project <project>
npx weapp-container-agent test run --project <project> --scenario scenario.json
npx weapp-container-agent job status --project <project> --job <job-id>
npx weapp-container-agent release prepare --project <project> --version 1.0.0
npx weapp-container-agent release commit --project <project> --version 1.0.0 --confirm
npx weapp-container-agent release publish --project <project> --version 1.0.0 --confirm --private-key /abs/path/private.key
```

`build` uses the project's `weapp-vite` installation. `preview start` uses a locally built simulator from this repository, or the executable passed with `--simulator-bin` / `WEAPP_CONTAINER_SIMULATOR_BIN` when installed as a package.

Run `inspect` first for an existing native WeChat mini-program. The `compatibility.findings` field scans the actual JavaScript/TypeScript, WXML, and WXSS use sites and reports a file, line, `full`/`partial`/`unsupported`/`unknown` status, evidence, and a recommendation for each finding. This is a migration preflight. Static findings are not official DevTools or device conformance results.

The shortest local loop is:

```sh
npx weapp-container-agent inspect --project ./my-miniprogram
npx weapp-container-agent build --project ./my-miniprogram
npx weapp-container-agent preview start --project ./my-miniprogram --simulator-bin /abs/path/weapp-simulator
npx weapp-container-agent test run --project ./my-miniprogram --scenario scenario.json
npx weapp-container-agent preview stop --project ./my-miniprogram
```

`preview start` owns the simulator through a loopback daemon with a random token. `preview stop` refuses to guess ownership from a stale PID. Test jobs are persisted under `.weapp-container/agent/jobs` and return a job ID before the scenario runs.

The MCP tool set exposes project inspection, file listing, bounded source reads and atomic project-relative writes. An AI client can edit source, invoke a build, start a preview, drive a browser scenario, inspect durable job events, and prepare or upload a release through one project-scoped connection.

Scenario steps support `state`, `snapshot`, `bridge`, `browser`, and `wait`. Browser steps reuse one headless Playwright page and support `goto`, `locator`, `click`, `fill`, `press`, `wait`, and `screenshot`.

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
