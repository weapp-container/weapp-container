# Mini-program testing runtime

[简体中文](testing-runtime.md) · **English**

`@weapp-container/node` provides a standalone Node SDK; `@weapp-container/vitest` provides a Vite compiler plugin and fixtures per test. The backend uses the `container-sdk` testing feature and `weapp-test-host`, always with real QuickJS.

```text
weapp-vite/test → 编译输出快照 → portable pack
Vitest / node:test → Node SDK → stdio RPC → ContainerSession / QuickJS / View
```

Testing controls compile only into testing distributions. Pack validation, module loading, event graphs, navigation, storage, host providers and cleanup reuse the production SDK. Stdout carries bounded JSONL RPC only; application logs return as structured events. Each container has one owner thread and subprocess.

Controlled Date and guest performance use session time, shared by timer registration and dispatch. Execution interruption, scheduling budgets, provider deadlines and watchdogs use real time. Ordinary SDK distributions have no testing commands.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm testing:test
pnpm testing:typecheck
cargo clippy --locked -p container-sdk --features testing --all-targets -- -D warnings
cargo test --locked -p container-sdk --features testing -- --test-threads=1
pnpm testing:package
pnpm testing:install:test
pnpm testing:bench
```

Integration tests cover real compiler output, pages and components, event propagation, controlled time, startup mocks, synchronous snapshots, parallel isolation, watch generations, compilation failures, callbacks after unload, interruption, process crashes and cleanup. Installation tests install tarballs outside the repository with install scripts disabled, execute the real binary and never invoke Rust tooling.

`testing:package -- --target <triple>` generates a release binary, SHA-256 metadata and complete third-party notices. Supported targets are `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu`. Platform prepack checks reject missing, corrupt or non-executable payloads. CI builds, tests, verifies installation and uploads distributions on both hosts, without publishing to npm.

`testing:bench` writes startup, mounting, operations, cleanup and RSS for four live containers to `artifacts/testing-runtime-benchmark.json`. Set `WEAPP_CONTAINER_BENCH_SAMPLES` for the sample count and use the release platform package for distribution measurements. Results describe only the measured host.

The 2026-11-13 macOS arm64 / Node 24.22.2 release baseline used 10 samples: first startup 119 ms, mean startup 14.5 ms (other samples approximately 2.6–3.2 ms), mean page mount 52.7 ms, method call including flush 8.6 ms, cleanup 4.6 ms. Each of four subprocesses used approximately 25 MiB RSS; Node used approximately 65 MiB. Linux measurements await CI and cannot be inferred from this baseline.

## JS toolchain

The main repository uses Node 24.22.2, pnpm 10.15.1 and published repoctl 6.6.1. Libraries and CLIs follow repoctl's tsdown templates, inherit shared TypeScript / ESLint configuration, and build in dependency order through Turbo. Root scripts stay `.mjs`; existing tests continue to run with `node:test`.

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm test:types
pnpm test
pnpm repo:check
```

`repo:check` runs lint, type checking, tests and builds in sequence; `test:types` validates generated declarations. Tests build the real Rust test host and require a local Rust toolchain. Installed consumers do not require Rust.

The Node SDK exports ESM / CJS and matching declarations from `dist`; the Vitest plugin remains ESM. The manifest and host-services tools also export from `dist`, with `container-pack` and `weapp-host-services` CLIs. Browser-shared pure JS modules retain their source semantics. Generated dist files, native binaries and tarballs stay out of Git. This change adds no automated publishing workflow.

## Current constraints

Initial queries inspect the logical tree, covering setData and events without screenshot or browser layout parity guarantees. The component host page is injected before pack hashing; properties and event bindings are declared at mount. Nodes are View revision snapshots and should be queried again after updates. Method return values currently support synchronous JSON; observe asynchronous business work through mocks, flush and data assertions.

Node mocks, fake timers and coverage affect only the test process. QuickJS uses container mocks and its clock. Process pools, business coverage, device validation and WeChat runtime parity remain future work.
