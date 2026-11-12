# API 来源审定

API 清单的来源身份保存在 [检查器](../../scripts/core-api-inventory.mjs) 中。完整文件摘要统一由 `reviewedSourceSha256` 保存，各项能力检查选择自己的固定来源集合；JavaScript 的控制流身份使用固定 Acorn 版本计算的规范 AST 摘要。源码变化必须重新审阅，不能在生成 matrix 时自动接受当前摘要。

这些身份只说明指定源码经过复核。它们不证明编译后的全部行为、官方 API 完整兼容、真机执行、商户交易或各 SDK 的实际验收。平台状态仍由独立的 [验收账本](./acceptance-ledger.json) 和 [验收契约](./acceptance-contracts.json) 决定。

## 2026-11-12 复核范围

本次以公开源码快照中的实现为目标，逐文件比较之前审定的原始内容与当前内容。更新了 20 个完整文件身份，以及通知 hub、安装器、生命周期、宿主桥接和 Promise 拒绝处理的 AST 身份。未改变能力评级、验收契约或验收账本。

| 来源 | 变化与保留的边界 |
| --- | --- |
| `container-engine-quickjs/src/lib.rs`、`container-engine-v8/src/lib.rs` | 组件数据提交回执与测试专用观测接收器；使用私有传输和既有执行预算，不从应用可写全局获取权限，不额外排空任务。 |
| `container-runtime/src/lib.rs` | 开发包在隔离候选中装载，接受后原子提交；模块注册与成功执行分开记录，失败的入口需要显式重试。宿主几何变化撤销旧输入权限。受限演示发行继续拒绝调试和模块调用。 |
| `container-runtime/src/route_transaction.rs` | 导航前检查真实页面模块的 Page 定义是否就绪；未装载的路由不能借其他页面的定义执行。 |
| `container-runtime/src/host_services.rs` | 宿主布局通知加入运行时拥有的 API 集合；平台 provider 不能替换该所有权。 |
| `container-core/src/lib.rs`、`container-core/Cargo.toml` | 观测模块和出口由显式测试 feature 控制，默认关闭。 |
| `container-core/src/finite-notifications.js`、`container-core/src/host-bridge.js` | 对象镜像更新必须在订阅、序列和 owner 准入之后；镜像更新不成为通知授权来源。 |
| `container-core/src/host-environment-install.js`、`container-core/src/lifecycle-notifications.js` | 可信安装、分发及退出阶段管理宿主布局通知的所有者。 |
| `container-core/src/host_environment.rs` | 安装布局与组件回执，测试专用日志保持私有；回执捕获失败不能破坏正常应用写入。完整 bootstrap 字节身份继续是硬性门禁。 |
| `container-sdk/src/lib.rs` | 不可变帧快照绑定实际接受的物理目标和输入生命周期，开发重载使用原子替换；受限演示继续禁止开发装载入口。 |
| `container-host-web/src/lib.rs` | 有界二进制帧使用既有 renderer/frame 授权；sandbox 必须显式选择 development，受限发行拒绝该选项。 |
| `examples/hosts/web-wasm/worker-runtime.mjs` | 有界并发取包、逐项哈希和整组取消；字体缓存读取后仍校验哈希。帧传输和调度保留预算、排他令牌及失败清理。 |
| `container-host-common/src/lib.rs`、`container-runtime/src/browser_view.rs`、`container-runtime/src/render_backend.rs` | 开发候选接受后才发布元数据；失败只能恢复仍拥有对应页面、surface 与生命周期的旧帧。取消操作不恢复旧坐标输入权限。 |
| `Cargo.toml`、`Cargo.lock` | 工作区源码许可及开发调试信息配置；Harmony 宿主加入已有 SHA-256 依赖。旧发行资产的许可和摘要不因此改变。 |
| `container-core/src/unhandled-rejections.js` | 测试观测区间可持续到退出后的最终 checkpoint；公开监听分发在退出时立即退休，handled 取消仍有效。默认关闭观测时不保留退出后的通知。 |
| `container-core/src/error-notifications.js` | 递归报告先使日志和异常观测失效，再停止嵌套报告。检查器验证可达的直接递归保护，避免将丢失的嵌套报告记录为完整证据。 |

表中 crate 路径均位于 `crates/`。对应的来源、调用方、配置和失败路径应一起审阅，不能只看方法体或关键词是否存在。

浏览器 owner、浏览器呈现协议和原生 selector 的非性能测试夹具显式使用有限的
2 s View 批次预算。这些用例曾在进入所有权断言前触及 50 ms 初始化期限；
夹具将协议语义验证与该性能门槛分开，不据此判定超时的具体成因。
生产默认值仍为 50 ms，SDK 的默认装载路径仍使用该值；配置默认值、外层截止时间、
取消、中断和故障后权限撤销继续由专门测试验证。夹具结果不证明 50 ms 性能门槛通过。

## 2026-11-12 桌面 GL 宿主复核

以本次 PR 的基线逐文件复核以下差异，更新 `runtime`、`commonHost`、
`workspaceLock` 三个完整来源身份。能力评级、验收契约与验收账本保持不变。

| 来源 | 变化与保留的边界 |
| --- | --- |
| `container-runtime/src/lib.rs` | 增加被动 GL 附着查询，只读取已存在的 renderer；不创建 GPU 状态，不改变调度器、预算或呈现权限。 |
| `container-host-common/src/lib.rs` | 转发被动查询及显式 GL loader；未装载会话继续报错，GL context 的线程、current 状态及 teardown 仍由宿主管理。 |
| `container-render-skia/src/lib.rs` | 显式 GL loader 拒绝非 GL 函数名，避免 GLX/WGL 对 EGL 名称返回不可调用的非空地址；原生 EGL 附着入口保留原有路径。 |
| `Cargo.lock` | 为桌面呈现加入 glutin/glow 及其传递依赖，既有依赖版本不变；重名 Objective-C 依赖显式标注版本。 |

复核同时覆盖独立桌面宿主的 resize、零尺寸失效、重载、呈现回执及退出清理。
Linux Xvfb/Mesa 集成测试验证真实 GL drawable 的像素、resize、重载和 detach；
该结果不代表 Windows、Wayland 或物理设备验收，也不提升任何 SDK 验收状态。

## 后续更新

1. 找到上次审定的完整来源，审阅到当前文件的差异，确认授权、所有权、生命周期、预算及失败语义。
2. 先修实现或检查器中失效的假设。保留反向 mutation 测试；fixture 的替换必须命中真实且数量确定的锚点。
3. 只更新复核过的来源摘要和 AST 身份。共享身份只能保留一份，各能力范围继续显式选择来源。
4. 运行 `node --test scripts/core-api-inventory.test.mjs`、`pnpm host:services:test` 及受影响模块的行为测试，再生成和核验 matrix。比较所有能力状态，来源更新本身不能提升评级。
5. 实际平台或交易验收必须另外提供满足契约的证据；没有执行的项目继续标为未验收。
