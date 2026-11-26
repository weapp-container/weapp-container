# @weapp-conatiner/agent

MCP server and CLI for AI-driven mini-program development.

```sh
npm install @weapp-conatiner/agent
npx playwright install chromium
```

## CLI

```sh
pnpm container:agent init --project <project>
pnpm container:agent inspect --project <project>
pnpm container:agent build --project <project>
pnpm container:agent preview start --project <project>
pnpm container:agent preview status --project <project>
pnpm container:agent preview stop --project <project>
pnpm container:agent test run --project <project> --scenario scenario.json
pnpm container:agent job status --project <project> --job <job-id>
pnpm container:agent release prepare --project <project> --version 1.0.0
pnpm container:agent release commit --project <project> --version 1.0.0 --confirm
pnpm container:agent release publish --project <project> --version 1.0.0 --confirm --private-key /abs/path/private.key
pnpm container:agent job status --project <project> --job <job-id>
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
