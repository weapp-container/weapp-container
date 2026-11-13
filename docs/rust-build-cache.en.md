<a id="rust-构建与磁盘空间"></a>
# Rust Build and Disk Space

[简体中文](rust-build-cache.md) · **English**


This repository contains QuickJS, V8, Skia, platform-native libraries, and a large number of test programs. Debug information, incremental compilation, dependencies for different features/platforms, and static linking artifacts will increase the size of `target`. The worktree shares Git objects, but the Cargo build directories are not shared by default; each experiment creating its own `target` will continue to expand disk usage.

<a id="日常开发"></a>
## Daily Development

workspace and three independent Rust examples (desktop, desktop-metal, embed-runner) development/test
profile both use `debug = 1`, retaining minimal debugging information, reducing full type and local variable debugging data.
The development machine continues to use Cargo's default incremental compilation; the CI one-time runner sets `CARGO_INCREMENTAL=0`,
not preserving incremental cache that cannot be reused later. release profile and QuickJS development-mode optimizations retain existing settings.

Prioritize checking modified packages, then run relevant tests; complete workspace and cross-platform matrix used for delivery acceptance:

```sh
pnpm rust:check -p container-core
cargo test -p container-ir --locked
```

When complete debugging information is needed, you can override only the current development command, for example
`CARGO_PROFILE_DEV_DEBUG=2 cargo build -p container-core`. Do not apply such profile environment overrides
or globally inject `RUSTC_WRAPPER` for strict evidence builds; WASM builds will record these inputs and mark custom build environments as `partial`, and cannot be considered equivalent to default source code builds.

<a id="稳定缓存与显式路径"></a>
## Stable Caching and Explicit Path

Normal Cargo command defaults to the `target/` directory of the current workspace. Native SDK builds and native host builds use the same default directory, with path priority as:

1. `--target-dir <目录>`.
2. The `CARGO_TARGET_DIR` environment variable.
3. The current repository’s `target/` directory.

Product discovery, hash verification, and host linking use the same resolved directory. Specifying a cache directory will not close release
source verification, nor alter the final SDK output directory. The standalone Rust example remains a separate workspace and can be reused with dependency caching via `CARGO_TARGET_DIR`.

Performance matrix uses `performance-matrix/quickjs` and `performance-matrix/v8` as fixed directories under the cache root to avoid overwriting actively running development simulators; during each run, the executable file reported by Cargo is copied to the output directory for subsequent measurement. Directories are reused by engine, not by experiment iteration, and dependency caching is shared across experiments.

Stable absolute paths can be set for continuous builds within a single development session:

```sh
export CARGO_TARGET_DIR="$HOME/Library/Caches/weapp-container/cargo-local"
pnpm sdk:build:native -- --target aarch64-apple-darwin --profile dev
```

The above path is an example for macOS; Linux optionally uses `$HOME/.cache/weapp-container/cargo-local`, and Windows uses an optional user cache directory. Cargo handles dependency fingerprints and build directory locks, but shared directories may cause lock contention.
**Parallel worktrees/tasks should each use a separate cache root** to avoid one build replacing a final library or program shortly after another build has completed. Sequential tasks can reuse the same root; changes to toolchain, target, profile, and feature may still produce new compiled outputs. Long-term caching should not place evidence directories named by run count.

<a id="wasm-临时缓存的生命周期"></a>
## WASM Temporary Cache Lifecycle

`build:web-wasm` By default uses the `cargo-target` directory in the current output directory. After build completion, failure, or cancellation, it automatically deletes the directory once it confirms the child process has ended. The exact WASM in `raw/`, generated `pkg/`, source code snapshot, logs, and build reports are retained independently, and browser loading and evidence verification do not depend on the recycled cache.

For repeated builds, explicitly select a stable cache. Caches selected by arguments or environment variables belong to the caller and are never deleted by the script:

```sh
pnpm build:web-wasm -- --pack artifacts/reference --out-dir artifacts/web-run-1 \
  --llvm-bin /absolute/path/to/llvm/bin --target-dir /absolute/path/to/cargo-web-cache
```

When diagnosing compilation issues, add `--keep-cargo-cache` to retain the current default cache. The `cargoCache` field in `build-report.json` records the path, ownership, retention policy, and cleanup results. The report exposes failures if the cache path is replaced, cleanup fails, or the process end cannot be confirmed. It will not delete paths of unknown ownership to save space.

<a id="定期维护"></a>
## Periodic Maintenance

View the actual size of the development cache to avoid long-term retention of unused platform and feature combinations:

```sh
du -sh target
pnpm rust:cache:clean
```

`rust:cache:clean` invokes the standard `cargo clean`, cleaning the selected target in the current workspace; it cleans the directory specified by `CARGO_TARGET_DIR`. It does not inadvertently delete other worktrees, standalone examples, or historical artifacts.
First, terminate any build and run tasks using this cache, then proceed with cleanup; final libraries, programs, and receipts should be preserved in the published or artifact output directory. Standalone examples can use `cargo clean --manifest-path <示例目录>/Cargo.toml`.

It is recommended to check once when the cache reaches tens of GiB, after a large acceptance, or when a worktree ends, and to remove unused dedicated caches. The repository does not automatically delete shared persistent caches by date, avoiding deletion of build directories that are still in use. `sccache` can serve as an acceleration scheme for subsequent recompilations, but requires a capacity limit and evidence entry adaptation, and cannot replace the lifecycle management of temporary caches.
