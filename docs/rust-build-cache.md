# Rust 构建与磁盘空间

本仓库包含 QuickJS、V8、Skia、多平台原生库和大量测试程序。调试信息、增量编译、
不同 feature/平台的依赖以及静态链接产物都会增加 `target` 的大小。worktree 共享 Git
对象库，但默认不会共享 Cargo 构建目录；每个实验另建一个 `target` 会继续放大占用。

## 日常开发

workspace 与三个独立 Rust 示例（desktop、desktop-metal、embed-runner）的 dev/test
profile 均使用 `debug = 1`，保留精简调试信息，减少完整类型和局部变量调试数据。
开发机继续使用 Cargo 默认的增量编译；CI 的一次性 runner 设置 `CARGO_INCREMENTAL=0`，
不保存随后无法复用的增量缓存。release profile 和 QuickJS 的开发态优化覆盖保持原有设置。

优先检查修改的包，再运行相关测试；完整 workspace 和跨平台矩阵用于交付验收：

```sh
pnpm rust:check -p container-core
cargo test -p container-ir --locked
```

需要完整调试信息时，可仅对当前开发命令覆盖，例如
`CARGO_PROFILE_DEV_DEBUG=2 cargo build -p container-core`。不要把这类 profile 环境覆盖
或 `RUSTC_WRAPPER` 全局注入严格证据构建；WASM 构建会记录这些输入，并将自定义构建环境
标为 `partial`，不能当作默认源码构建通过。

## 稳定缓存与显式路径

普通 Cargo 命令默认使用当前 workspace 的 `target/`。SDK 原生构建和 native host
构建使用相同默认目录，路径优先级为：

1. `--target-dir <目录>`。
2. `CARGO_TARGET_DIR` 环境变量。
3. 当前仓库的 `target/`。

产物发现、哈希校验和宿主链接使用同一个已解析的目录。指定缓存目录不会关闭 release
源码校验，也不会改变最终 SDK 输出目录。独立 Rust 示例仍是单独的 workspace，可在
需要时通过 `CARGO_TARGET_DIR` 复用依赖缓存。

性能矩阵在这个缓存根下使用 `performance-matrix/quickjs` 和 `performance-matrix/v8`
两条固定目录，避免覆盖正在运行的开发模拟器；每轮运行还会把当次 Cargo 报告的可执行文件
复制到输出目录，供后续测量使用。目录按引擎复用，不按实验次数新增一套依赖缓存。

可以在单个开发会话中为连续构建设置稳定的绝对路径：

```sh
export CARGO_TARGET_DIR="$HOME/Library/Caches/weapp-container/cargo-local"
pnpm sdk:build:native -- --target aarch64-apple-darwin --profile dev
```

上面的路径是 macOS 示例；Linux 可选 `$HOME/.cache/weapp-container/cargo-local`，Windows
可选用户缓存目录。Cargo 会处理依赖指纹和构建目录锁，但共享目录可能导致锁等待。
**并行 worktree/任务应各用独立缓存根**，避免一个构建刚完成时，另一个构建替换同名最终
库或程序。连续任务可复用相同根；toolchain、target、profile 和 feature 变化仍可能产生
新的编译产物。长期缓存不要放进按运行次数命名的证据目录。

## WASM 临时缓存的生命周期

`build:web-wasm` 默认使用本次新输出目录中的 `cargo-target`。构建完成、失败或取消后，
在确认子进程已结束的情况下自动删除该目录。`raw/` 中的精确 WASM、生成的 `pkg/`、源码
快照、日志及构建报告独立保留，浏览器加载和证据校验不依赖被回收的缓存。

需要重复构建时可显式指定稳定缓存；显式参数和环境指定的缓存归调用者所有，脚本不会删除：

```sh
pnpm build:web-wasm -- --pack artifacts/reference --out-dir artifacts/web-run-1 \
  --llvm-bin /absolute/path/to/llvm/bin --target-dir /absolute/path/to/cargo-web-cache
```

诊断编译问题时可加 `--keep-cargo-cache`，保留本次默认缓存。`build-report.json` 的
`cargoCache` 字段记录路径、所有权、保留策略及清理结果。缓存路径被替换、清理失败或无法
确认进程结束时，报告会暴露失败，不会为了省空间删除归属不明的路径。

## 定期维护

查看开发缓存的实际大小，避免长期保留用不到的平台和 feature 组合：

```sh
du -sh target
pnpm rust:cache:clean
```

`rust:cache:clean` 调用标准 `cargo clean`，清理当前 workspace 选中的 target；设置了
`CARGO_TARGET_DIR` 时清理该目录。它不会顺带删除其他 worktree、独立示例或历史证据。
先结束使用该缓存的构建和运行任务，再清理；需要的最终库、程序和收据应保存在发布或证据
输出目录。独立示例可使用 `cargo clean --manifest-path <示例目录>/Cargo.toml`。

建议在缓存达到几十 GiB、完成大型验收或结束一个 worktree 时检查一次，并移除不再需要的
专用缓存。仓库不会按日期自动删除共享的持久缓存，避免回收仍有使用者的构建目录。
`sccache` 可作为后续的重复编译加速方案，但需要容量上限和证据入口适配，也不能代替
临时缓存的生命周期管理。
