<p align="center"><img src="assets/brand/weapp-container-mark.svg" width="96" height="96" alt="Weapp Container" /></p>

# Weapp Container

[简体中文](README.md) · **English**


Embed mini-programs in your own applications. Weapp Container provides a Rust runtime, portable pack tooling, a development simulator, and integration layers for Android, iOS, C++ Desktop, Flutter, and React Native.

[Documentation](https://container.weapp.dev/en/docs/) · [Live demo](https://container.weapp.dev/en/demo/) · [Source documentation](docs/README.en.md) · [Contributing](CONTRIBUTING.en.md)

[![Public source checks](https://github.com/weapp-container/weapp-container/actions/workflows/public-ci.yml/badge.svg)](https://github.com/weapp-container/weapp-container/actions/workflows/public-ci.yml)

Start with a native mini-program directory or an existing framework build. Integration does not require weapp-vite. The packer produces a verified manifest, IR, and content-addressed resources; the runtime manages JavaScript execution, pages, navigation, storage, and host messaging. QuickJS is the primary engine. V8, Skia, and browser presentation paths depend on the selected configuration and host capabilities.

The project is in **preview**. Source is public and can be built locally. Build, installation, runtime, and acceptance results are recorded separately for each platform; complete WeChat compatibility is not claimed. Read the [capability matrix](docs/capability-matrix.en.md), [platform status](https://container.weapp.dev/en/docs/platforms/), and [validation methodology](docs/conformance/README.en.md) before choosing a target.

Core runtime, iOS, Desktop and CocoaPods Specs downloads for `0.1.0-preview.7.0` are public. npm, Maven Central and pub.dev publication is incomplete; see the [release status](docs/public-sdk-release.en.md) for installation commands, validation scope and blockers.

<a id="选择你的入口"></a>
## Choose a starting point

| Your goal | Start here |
| --- | --- |
| Try the runtime | [Fixed browser demo](https://container.weapp.dev/en/demo/); mini-program content is Chinese, and orders and payments are simulated |
| Embed a mini-program | [Quick start](https://container.weapp.dev/en/docs/start/) and [platform integrations](https://container.weapp.dev/en/docs/integrations/) |
| Package a native mini-program or existing build | [Portable packs](https://container.weapp.dev/en/docs/pack/) and the [standalone packer](tools/container-manifest/README.en.md) |
| Modify the runtime or build a host | [Architecture](docs/architecture.en.md), [SDK contracts](https://github.com/weapp-container/sdk-contract/blob/main/README.en.md), and the [engineering index](docs/README.en.md) |
| Investigate compatibility | [API records](docs/api-runtime-conformance.en.md), [host services](docs/host-services/README.en.md), and [conformance](docs/conformance/README.en.md) |

<a id="从源码开始"></a>
## Build from source

Install Git, Node.js **24.18+ / 24.x**, pnpm **10.15.1**, Rust stable, and a host C/C++ toolchain. macOS requires Xcode Command Line Tools. The headless path below uses QuickJS and software rendering without building Skia. Visual previews and native SDKs also download public Skia dependencies; see [Rust build requirements](docs/rust-build-cache.en.md).

```sh
git clone --recurse-submodules https://github.com/weapp-container/weapp-container.git
cd weapp-container
corepack enable
pnpm install --frozen-lockfile
pnpm submodule:verify
pnpm container:pack -- fixtures/reference-app --out artifacts/reference
cargo run --locked -p container-simulator --no-default-features --features quickjs-native -- run --pack artifacts/reference \
  --trace artifacts/simulator/trace.json \
  --snapshot artifacts/simulator/snapshot.json \
  --report artifacts/simulator/report.json
```

This path uses the repository's native mini-program fixture and builds the current runtime from source. It needs no historical runtime archive, download token, or weapp-vite installation. It produces a trace, state snapshot, and execution report. See the [simulator guide](docs/simulator.en.md) for visual development previews.

<a id="可选使用-weapp-vite-开发示例"></a>
### Optional: develop the weapp-vite examples

Some development examples use the pinned upstream builder. Prepare it only when choosing those examples:

```sh
pnpm --dir vendor/weapp-vite install --frozen-lockfile
pnpm --dir vendor/weapp-vite build:pkgs
pnpm simulator:dev -- --project examples/apps/reference-app --surface web --software
```

The default address is `127.0.0.1:5179`. CanvasKit, browser Workers, desktop windows, and device debugging need additional setup described in the [simulator guide](docs/simulator.en.md).

<a id="目录与接入"></a>
## Repository layout and integrations

| Location | Purpose |
| --- | --- |
| `tools/container-manifest`, `schemas` | Pack validation, manifests, content-addressed resources, and IR |
| `crates/container-runtime` | Sessions, lifecycle, navigation, host calls, and input state |
| `crates/container-engine-*` | QuickJS and explicit V8 provider boundaries |
| `crates/container-render-skia`, `container-host-*` | Rendering and Web/native host adapters |
| `crates/container-simulator`, `apps/dev-player` | Development simulator and device clients |
| `sdk/*` | Independent contracts and Android, iOS, Desktop, Flutter, and React Native wrappers |
| `website` | Documentation and demonstration website |
| `tools/runtime-artifacts` | [Runtime packaging, offline verification, and release tools](tools/runtime-artifacts/README.en.md) |

The SDKs, website, and `vendor/weapp-vite` are pinned submodules. Commit changes in the owning repository before updating its pointer here. Historical prebuilt locks may still reference old releases; use the [SDK source build guide](docs/sdk-repositories.en.md) for current integration.

<a id="检查"></a>
## Checks

```sh
pnpm opensource:check
pnpm docs:check
pnpm naming:check
pnpm naming:test
pnpm container:manifest:test
pnpm sdk:contracts:test
pnpm sdk:test
cargo fmt --all -- --check
cargo check --workspace --all-targets --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked -- --test-threads=1
```

Baseline PR checks use public dependencies. The full platform matrix, official development tools, devices, GPUs, and performance validation have explicit manual entry points. Unit tests do not establish real-device behavior or complete compatibility.

<a id="许可与历史"></a>
## License and history

Repository-authored source uses **Apache-2.0**. `container-core`, `container-ir`, and `container-bridge` retain **MIT OR Apache-2.0**; third-party components retain their own licenses. New builds include `RUNTIME-LICENSE` and dependency notices. See [licensing](docs/licensing.en.md) and [NOTICE](NOTICE).

Public Git history starts from a prepared source snapshot. Earlier development history and large build records remain in private archives. Necessary regression fixtures stay in source; see [archived evidence](docs/archived-evidence.en.md).

Historical runtime archives retain their shipped licenses and exact hashes, and some default download pins are currently unavailable. Source licensing does not relicense old binaries. Prefer [building matching source](docs/sdk-repositories.en.md); historical downloader compatibility is described in the [migration guide](docs/runtime-artifacts-migration.en.md).
