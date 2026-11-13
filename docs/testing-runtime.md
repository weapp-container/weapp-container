# 小程序测试运行时

`@weapp-container/node` 提供独立 Node SDK，`@weapp-container/vitest` 提供 Vite 编译插件和每测试 fixture。后端是 `container-sdk` 的 `testing` feature 与 `weapp-test-host`，固定使用真实 QuickJS。

```text
weapp-vite/test → 编译输出快照 → portable pack
Vitest / node:test → Node SDK → stdio RPC → ContainerSession / QuickJS / View
```

测试控制接口只在 testing 分发中编译。pack 验证、模块加载、事件图、导航、存储、host provider 与回收复用生产 SDK。stdout 仅承载有边界的 JSONL RPC；业务日志作为结构化事件返回。一个容器对应一个 owner thread / 子进程。

受控 Date 与 guest performance 使用会话时间；timer 注册与触发共享该时间。执行中断、调度预算、provider deadline 和 watchdog 使用真实时间。普通 SDK 分发没有测试控制命令。

## 本地验证

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

集成测试验证真实编译输出、页面与组件、事件传播、受控时间、启动 mock、同步快照、并行隔离、watch 代际、编译失败、卸载后的回调、执行中断、进程崩溃和回收。安装测试在仓库外安装 tarball，禁用 install scripts，运行真实二进制，不调用 Rust 工具链。

`testing:package -- --target <triple>` 生成对应平台的 release 二进制、SHA-256 metadata 与完整第三方许可证；目前支持 `aarch64-apple-darwin`、`x86_64-unknown-linux-gnu`。平台 package 的 prepack 会拒绝缺失、损坏或不可执行的 payload。CI 在两个目标主机上构建、运行测试、验收安装并上传分发材料；此工作流不自动发布 npm。

`testing:bench` 将冷启动、挂载、操作、回收与四个存活容器的 RSS 写到 `artifacts/testing-runtime-benchmark.json`。通过 `WEAPP_CONTAINER_BENCH_SAMPLES` 设置样本数，使用 release 平台包测发布性能。结果仅代表运行该命令的主机。

2026-11-13 本机 macOS arm64 / Node 24.22.2 的 release 基线为 10 个样本：首次启动 119 ms，启动均值 14.5 ms（其余样本约 2.6–3.2 ms），页面挂载均值 52.7 ms，一次方法调用（含 flush）均值 8.6 ms，回收均值 4.6 ms。四个存活子进程各占约 25 MiB RSS，Node 进程约 65 MiB。Linux 数值待 CI 实测，不由这组结果外推。

## 当前约束

首期查询逻辑树，覆盖 setData 和事件，不提供截图 / 浏览器布局一致性保证。组件宿主页在 pack 哈希生成之前注入；属性与事件绑定在挂载时声明。节点是 View 修订快照，更新后应重新查询。方法返回值当前限定为同步 JSON；异步业务通过 mock、flush 与数据断言观察。

Node 的 mock、fake timer、覆盖率只覆盖测试进程；QuickJS 使用容器 mock 与时钟。进程池、业务覆盖率、设备与微信真机语义校验属于后续工作。
