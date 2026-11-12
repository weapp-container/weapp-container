<a id="host-validation-boundary"></a>
# 主机验证边界

**简体中文** · [English](host-validation.en.md)


GitHub Actions 的 `container-ci` 与 `modern-view` 两个 workflow 都只接受手动运行，
push 和 pull request 不会自动启动。CI 验证所选的构建、协议、语义或浏览器场景；
Android、iOS、HarmonyOS 以及真实桌面 GPU/窗口验证仍需要各自的官方 SDK、模拟器或真机。
未选择的组保持未执行，不能由一次绿色的部分运行推断全部门禁通过。

<a id="manual-ci"></a>
## 手动 CI

在仓库的 **Actions → container-ci → Run workflow** 中选择分支和 `scope`。
默认 `quick` 只运行现有的证据/near-parity 审计与 manifest 检查，按需选择较重的组：

| `scope` | 执行范围 |
| --- | --- |
| `quick` | near-parity/evidence 审计、manifest 与相关 Node 合约检查 |
| `rust` | Rust 格式、编译、Clippy、测试及宿主 feature smoke |
| `engines` | QuickJS/V8 conformance、原生 V8 与引擎 feature forwarding |
| `upstream` | 固定 weapp-vite 六平台构建、mpcore conformance |
| `native` | 原生 Skia 与移动端工具链/构建边界检查 |
| `performance` | 协议基准与 simulator 性能矩阵 |
| `full` | 上述全部任务，强制完整 Rust 与 Skia OS 矩阵 |

`engines` 与 `performance` 会先运行其依赖的 manifest 检查。

`rust_os` 可选 `linux`（默认）、`macos`、`windows` 或 `all`；`skia_os` 可选
`linux`（默认）、`macos` 或 `all`。两项仅控制对应任务的 runner，`full` 会忽略
单平台选择并强制全矩阵。Linux 编译通过不代表 macOS/Windows 或设备运行通过。

GitHub CLI 可以执行相同选择；省略 `--ref` 时使用仓库默认分支，需要其他分支时显式添加：

```bash
gh workflow run ci.yml -f scope=quick
gh workflow run ci.yml -f scope=rust -f rust_os=macos
gh workflow run ci.yml -f scope=native -f skia_os=all
gh workflow run ci.yml -f scope=full
```

现代 View 的构建、浏览器与相对性能任务由 **Actions → modern-view → Run workflow**
单独选择 `suite=browser|performance|full`，默认 `browser`；`performance` 只跑专项性能，
`full` 同时运行两组。它取代旧的 `performance` 布尔输入，命令见
[现代 View CI](modern-view.md#ci-专项验证)。`container-ci` 的 `full` 不会隐式触发另一个 workflow；
需要两套完整检查时，分别运行 `scope=full` 和 `suite=full`。

常规运行按 workflow、ref、组和平台选择去重，同类新运行会取消旧运行；不同组或平台选择
互不取消。`full` 和 `performance` 不取消正在执行的同类运行，GitHub 的并发队列仍可能
替换尚未开始的 pending 运行。普通 artifact 保留 7 天，性能 artifact 保留 30 天；
需要长期审查的报告应在到期前下载并按既有证据流程归档。

缓存仅用于依赖下载，不保存 Cargo `target`、生成 pack 或验收报告；命中缓存不代表重新验证。
手动选组、构建成功、headless 测试和工具链检测均不会授予新的官方 DevTools、GPU、
模拟器、真机或 near-parity 通过状态，既有证据与冻结门禁的边界保持不变。

<a id="local-checks"></a>
## 本地检查

```bash
node scripts/check-toolchain.mjs --json
cargo fmt --all -- --check
cargo test --workspace
bash scripts/host-feature-smoke.sh
node scripts/perf-baseline.mjs --out artifacts/perf-baseline.json
```

`check-toolchain.mjs --json` 会同时记录环境变量、默认安装位置、工具版本和
必需目录是否齐全，并记录 Rust 的 Apple/Android/OpenHarmony target 是否安装。macOS
上会探测 `~/Library/Android/sdk`、Xcode 的
`xcodebuild`/iPhoneSimulator SDK，以及 DevEco Studio 的 OpenHarmony native
toolchain；“detected”只代表工具存在，不能替代目标平台编译或模拟器/真机
运行证据。`--strict` 要求每个可选 SDK 的必需目录齐全。

`container-render-skia` 的 `skia-backend` feature 固定在 `skia-safe 0.153.3`，并启用
`ganesh + metal + pdf`，与 rust-skia 发布的内容寻址二进制 bundle 对齐。这样在
支持的目标上会直接下载并校验预编译 Skia；若 bundle 不存在，构建会明确进入源码
路径，此时必须提供 Python、Clang 和 Ninja，不能静默退回 software renderer。可复核
原生编译边界：

```bash
cargo check -p container-render-skia --features skia-backend
```

桌面与移动 host 的 `window`/`android`/`ios`/`harmony` feature 只启用平台边界；
只有显式附加 `skia-backend` 时，`HostInfo` 才会报告 Skia raster surface；这不是 GPU
上下文。GPU 资格必须由宿主附加真实 platform surface 并报告 `skia-gpu-*`，避免 feature
metadata 把软件读回误报成 GPU renderer。例如桌面本机检查使用
`cargo check -p container-host-desktop --features window,skia-backend`。

这条命令只证明 Skia 原生库可链接并能执行 CPU raster readback，不代表窗口、GPU
surface 或设备 conformance。
原生 renderer 基准会实际提交 1000 节点 `RenderFrame`，并生成完整性能报告：

```bash
pnpm perf:native -- --iterations 60 --out artifacts/native-performance-report.json
pnpm perf:check artifacts/native-performance-report.json --require-complete
```

报告中的 renderer 首帧、滚动丢帧率和进程 RSS 来自 Rust/Skia probe；它们是当前构建
机器的 host 证据，不能代替 Android、iOS、鸿蒙模拟器或真机测量。

桌面 host 还提供了一个可重复的原生 surface smoke。它通过
`DesktopHost::dispatch(render.commit)` 提交一棵真实 frame tree，随后由
`render_snapshot_json` 从 Skia raster surface 执行一次 `read_pixels`，并断言
返回的 RGBA8 字节、frame id 和 `has_native_surface()` 状态：

```bash
cargo test -p container-host-desktop --features window,skia-backend
```

这条 smoke 已覆盖 Skia raster surface 和 host 的批量提交/读回循环；它仍然不
替代具体平台的 winit 窗口、GPU context、合成器或真机验收。

在有图形会话的 macOS、Windows 或 Linux 主机上，可以进一步运行一次真实的
`winit + softbuffer` 窗口 smoke：

```bash
pnpm host:desktop:surface -- --out artifacts/desktop/native-window-surface.json
```

该命令会创建平台窗口、附着 `softbuffer::Surface` 并提交一张固定 2×2 RGBA
帧，然后保存 `nativeSurface: true`、`presentedFrame: true`、像素 SHA-256 和
`surfaceBackend: "softbuffer-raster"`。这比离屏读回多证明了窗口/呈现边界，
但 softbuffer 仍是 CPU 路径，报告中的 `gpuSurface` 必须保持 `false`，不能把它
当成 Skia GPU、Metal、Vulkan、官方 DevTools 或真机证据。没有可用图形会话时，
命令会输出 `status: "blocked"`；可在 CI 等无窗口环境使用
`--allow-blocked` 保留阻断报告并返回成功退出码。

macOS 还提供显式的 Skia Ganesh Metal surface smoke。它使用 `metal-window`
feature 创建 AppKit 窗口和 `CAMetalLayer`，把 `MTLDevice`/`MTLCommandQueue`
附着到同一个 `HostSession`，再将每个 `CAMetalDrawable` 的 texture 直接包装成
Skia Metal render target。只有 runtime 在该 drawable 上完成 `render.commit`、
flush 并由 presenter `presentDrawable`/`commit` 后，报告才会写入
`rendererBackend: "skia-gpu-metal"`、`containerSurfaceAttached: true` 和
`gpuSurface: true`：

```bash
cargo run --manifest-path examples/hosts/desktop-metal/Cargo.toml --release
```

报告可保存到 `artifacts/desktop/metal-window-surface.json`；该文件记录 macOS、
GPU、Rust/Skia 构建信息和一次性 frame/surface 证据。窗口创建失败、drawable
不可用或没有图形会话时保持 `status: "blocked"`，不会把软件 raster surface
升级为 GPU 通过。一次 macOS smoke 只覆盖该平台的 surface ownership，不能替代
Windows/Linux GPU、DevTools、完整 API conformance、性能或真机门禁。

当前 host crate 已提供同一套 `load_manifest_json`、`dispatch_json` 和 `unload`
边界。它们会把批量 bridge envelope 交给唯一的 `container-runtime::Session`，
因此 host 不会维护第二份页面栈；JSON 边界适合 WASM、JNI、Swift/Objective-C
和 ArkTS/N-API 绑定。该边界测试证明了 manifest 校验、app.init 批量响应和失败
reload 保留运行中 session，但不代表原生窗口、GPU、模拟器或真机 conformance。

`dispatch_json` 同时接受兼容的单个 `BridgeEnvelope` 和规范的
`{"messages":[...]}` `BridgeBatch`。跨平台绑定也可调用显式的
`dispatch_batch_json`/`weapp_container_*_host_dispatch_batch_json` 入口；host 会在第一条消息
进入 runtime 前校验 session、protocol、request id、deadline 和 cancellation 相关
字段，避免跨消息 session/protocol 错误留下半初始化页面栈；单条 operation payload
仍由 runtime 按顺序返回结构化错误。批次中的 deadline 过期和取消会
分别返回 `ERR_TIMEOUT`、`ERR_CANCELLED`，而 C ABI 输出 buffer 必须通过匹配的
`weapp_container_*_buffer_free` 释放，释放后指针和长度都会清零。

可重复运行共享 host bridge smoke 并保存 JSON 报告：

```bash
pnpm host:bridge:smoke -- --out artifacts/host-bridge-smoke.json
```

该报告的 `bridge` 门禁覆盖 Web、桌面、Android、iOS 和鸿蒙 host crate 的批次、
deadline/cancel 和 buffer ownership 测试；`nativeGpu` 明确保持 `blocked`，因为
这条 smoke 不附着平台 GPU surface，也不将 software fallback 或性能结果升级为
设备证据。

报告同时包含 `engines.quickjs` 和 `engines.v8` 两个 feature 矩阵。它们分别以
`--no-default-features --features quickjs-native|v8-native` 编译五个平台 adapter，
并断言 host capability metadata 与 `container-runtime` 的 provider 状态一致。该
矩阵证明 feature forwarding 和显式能力协商；模块执行语义仍由
`engine:conformance` 覆盖，缺少真实 GPU、模拟器或设备时不会改变 `nativeGpu` 的
`blocked` 状态。

`render.commit` 成功后，宿主可调用 `render_snapshot_json` 一次性取得
`RenderSnapshot`（frame id、宽高、stride 和 premultiplied RGBA8 像素）。这建立了
从统一 Skia renderer 到 CanvasKit、桌面窗口、GLES/Vulkan、Metal 和 ArkUI surface
的可审计批量交接点；它仍然不等同于对应设备 GPU 或真机验收。

Android、iOS 和鸿蒙的 C ABI 还提供 `weapp_container_*_host_canvas_snapshot`：调用方传入
UTF-8 `canvasId`，即可一次性读取对应 `wx.canvas.draw` surface 的
`RenderSnapshot`。页面 snapshot 与 Canvas 2D snapshot 拥有独立生命周期；该接口
避免把 Canvas 命令或像素逐节点/逐调用跨 JNI、Swift 或 N-API 边界传输。它只证明
Rust renderer 已提交该 surface，仍不能把 software/raster 读回升级为 GPU 证据。

三套移动 C ABI 还提供只读的 `weapp_container_*_host_capabilities`。它返回一个
`schemaVersion: 1` JSON，分开列出 `build`（编译出的 renderer/provider）和
`runtime`（当前 session 是否加载、是否产生 native raster surface、是否附加 GPU
surface）。调用方应在创建原生窗口、`CAMetalLayer`、GLES/Vulkan 或 ArkUI surface
后重新读取这份报告；`runtime.gpuSurface: false` 必须保持为 false，直到平台适配器
真正接管 GPU context。该查询只是一条能力协商边界，不会把 `skia-raster` 或
`software-fallback` 变成移动 GPU 证据。

<a id="native-app-integration-skeletons"></a>
## 原生应用集成骨架

`examples/hosts/android`、`examples/hosts/ios` 和 `examples/hosts/harmony`
分别提供 JNI/CMake、Swift Package/C header、ArkTS/N-API/CMake 的最小入口。
三套 Rust host crate 现在同时导出 `rlib` 与平台 FFI 库，并提供同一组
`new`、`load_manifest`、`start`、`dispatch_json` 和 `buffer_free` 函数。所有
跨语言调用都传输一个完整的 JSON batch；每个平台的 ABI header 记录了指针和
长度的所有权规则。

先运行结构和目标检查：

```sh
pnpm native:check -- --out artifacts/native-hosts.json
```

有对应 SDK 时可构建 Rust native artifact：

```sh
pnpm native:build -- --platform android
cargo build -p container-host-ios --features ios,metal,quickjs-native-ios --target aarch64-apple-ios-sim
cargo build -p container-host-harmony --features harmony --target aarch64-unknown-linux-ohos
swift build --package-path examples/hosts/ios
```

Android 示例可以在可用 Android Gradle Plugin/Gradle 安装时，使用生成的 Rust 产物来编译其 JNI 共享库：

```sh
# Run from the repository root; supply your installed Gradle executable.
pnpm native:build -- --platform android
gradle --project-dir examples/hosts/android :app:assembleDebug \
  -PweappContainerAndroidRustLib="$PWD/target/aarch64-linux-android/debug/libcontainer_host_android.so"
```

iOS 包装检查会构建 `WeappContainerHost` 库产品。可选的模拟器烟雾可执行文件会显式链接相应的静态库：

```sh
# Run from the repository root.
WEAPP_CONTAINER_IOS_RUST_LIB="$PWD/target/aarch64-apple-ios-sim/debug/libcontainer_host_ios.a" \
swift build --package-path examples/hosts/ios \
  --triple arm64-apple-ios-simulator --product WeappContainerSmoke
```

Android Gradle、Xcode 应用和 DevEco 工程必须显式链接脚本输出的 Rust
`cdylib`/`staticlib`，并由各自 SDK 负责签名与安装。`native:check` 的通过只证明
项目文件、FFI 符号和 Rust cross-target 能编译；`native:build` 也只证明 native
artifact 生成；当 Android NDK 存在时它还会链接 JNI/CMake sample，当 Xcode
SwiftPM 存在时会检查 Swift bridge。两者都不能替代 Android/iOS/Harmony
模拟器或真机运行证据。
默认 workspace 构建不会下载 V8，因此各 host metadata 仍将 `v8` 标为不可用，避免
静默回退。`container-engine-v8` 提供显式的 `v8-native` 构建路径；它会链接 pinned
`rusty_v8` provider 并执行隔离的 CommonJS/批量调用 conformance。只有 host 将该
provider 编译进目标产物并通过自己的运行时测试后，才能把对应 host 的 V8 capability
标记为可用。

当前五个 host crate 覆盖七个发布 surface：Web、桌面 macOS/Windows/Linux、Android、
iOS 和鸿蒙。五个 crate 都提供 `quickjs-native` 与 `v8-native` forwarding features，且
`HostInfo.capabilities` 只在对应 provider 被编译时报告可用；桌面三个目标共享
`container-host-desktop` 的事件和窗口边界，不能因此把一次桌面检查扩展成三个 GPU
或设备通过证据。`Session::new` 会再次
初始化并检查 provider；其中 V8 缺失时返回稳定的 `ERR_ENGINE`，不会回退到另一个引擎。

```bash
cargo test -p container-engine-v8 --no-default-features --features v8-native
```

当前环境可用时，可以运行只读设备表面探针：

```bash
pnpm host:device:smoke -- --out artifacts/host-device-smoke.json
# Treat all three emulator surfaces as a hard gate when the host matrix is required.
pnpm host:device:smoke -- --require-all --out artifacts/host-device-smoke-required.json
```

该报告只证明 Android/iOS/Harmony 模拟器 shell 可达，不证明容器运行时、渲染、API
或性能通过。默认模式用于采集可诊断的可用性报告，即使某个平台未启动也会返回报告；
`--require-all` 会在任一平台状态不是 `passed` 时以非零退出，适合 CI 或设备门禁。

需要验证容器确实在模拟器中启动并执行 bridge smoke 时，使用
`native:runtime:smoke`。这个入口会安装并启动 Android APK，解析
`WEAPP_CONTAINER_SMOKE` 的 `app.init`、`render.commit`、RGBA snapshot 和 `api.call` 四项输出；
对 iOS 则安装 `.app` 并保存 `simctl launch --console` 的同一组输出。鸿蒙需要先
由 DevEco 生成 HAP，并通过环境变量提供包名和 Ability：

```sh
pnpm native:runtime:smoke -- --out artifacts/mobile-runtime-smoke.json

WEAPP_CONTAINER_HARMONY_HAP=entry/build/default/outputs/default/entry-default-signed.hap \
WEAPP_CONTAINER_HARMONY_BUNDLE=com.sonofmagic.weapp.container \
WEAPP_CONTAINER_HARMONY_ABILITY=EntryAbility \
pnpm native:runtime:smoke -- --require-all \
  --out artifacts/mobile-runtime-smoke-required.json
```

Harmony 的运行时分支会在安装后清空目标设备的 `hilog` 缓冲区、停止旧进程，再启动指定
Ability。启动命令返回成功并不足以通过：脚本轮询
`hdc shell hilog -x -e WEAPP_CONTAINER_SMOKE`，要求同一轮运行输出四条可解析的批量证据：
`app.init`、`render.commit`、`render.snapshot` 和 `api.call`。每项都会校验成功 payload、
帧号/后端或 RGBA8 读回数据；缺失项写入 `missingOperations`，失败项写入
`failedChecks`。采集结束后脚本会停止该 bundle，避免把本任务启动的 Ability 留在共享模拟器
前台。可用 `WEAPP_CONTAINER_HARMONY_WAIT_MS`（默认 5 秒）和 `WEAPP_CONTAINER_HARMONY_POLL_MS`（默认 250 ms）
调整等待窗口。

报告中的 `passed` 只表示选定应用 smoke 在选定模拟器/设备上运行完成并且返回了原生
Skia surface backend；它不代表生产签名、完整 API conformance 或性能门槛。bridge 和
RGBA snapshot 已经执行、但 renderer 仍为 `software-fallback` 时，报告会保留
`runtimeStatus: "passed"` 作为诊断证据，同时把 gate `status` 规范化为 `blocked`，并
记录 `reason`、`nativeSurface: false` 和目标环境。缺少 APK、iOS app bundle、DevEco
HAP、在线设备或模拟器时同样记录为 `blocked`，不会被 shell 可达性探针静默提升为通过。
旧的通用 Android/iOS smoke harness 仍可能使用 software fallback renderer，RGBA snapshot
是 2×2 读回证据；这种报告的 gate 保持 `blocked`，不能据此宣称 GLES/Vulkan 或 Metal
surface 已验收。当前 Android direct GLES harness 和 app-backed iOS Metal harness 另有
独立门禁，只有报告中的 `containerSurfaceAttached=true`、`gpuSurface=true` 和
`rendererBackend=skia-gpu-*` 同时出现时才会升级对应 native surface。Harmony 若 Ability
能启动但发生 ArkTS/N-API 异常或没有 `WEAPP_CONTAINER_SMOKE` 记录，报告状态为 `failed`，不能依据安装
和启动探针推断容器通过。

移动 smoke 还会保存独立的 `gpuProbe`。Android 示例创建一个短生命周期 EGL pbuffer，
iOS 示例调用 `MTLCreateSystemDefaultDevice()`；这两条记录只能证明选定模拟器/设备能
创建平台图形上下文，并保留 vendor/renderer/version 和 `hardwareAccelerated`。它们明确
写入 `containerSurfaceAttached: false`，不能把设备上下文、系统合成器或软件 SwiftShader
提升为 Weapp Container renderer 的 GPU 证据。鸿蒙若示例没有 ArkUI surface probe，则记录
`status: "unavailable"` 和原因。`check-near-parity-gates.mjs` 会把缺少上下文、软件
上下文或试图越权声明 `containerSurfaceAttached` 的报告继续保持 incomplete；只有平台
adapter 自己提交 `skia-gpu-*` backend 并提供真实 surface 生命周期证据，才可能通过 GPU gate。

Android sample 还会创建实际的 `SurfaceView` EGL window surface，并将一次完整
`render.snapshot` 作为 GLES texture 上传后交换到窗口。报告中的 `surfaceProbe` 会记录
`hostSurfaceAttached: true`、`backend: "gles-window-blit"` 和
`evidenceBoundary: "runtime-snapshot-upload"`，证明宿主窗口拥有呈现 surface；同时继续
保留 `containerSurfaceAttached: false`、`gpuSurface: false` 和
`rendererBackend: "software-fallback"`。这条证据改善了 surface ownership 覆盖，但仍
不能替代 Rust renderer 直接拥有 Skia GLES/Vulkan context 的 GPU 门禁。

当前 Android direct GLES 路径也可将窗口 framebuffer 交给 Rust Skia renderer，
记录 `backend: "skia-gpu-gles"` 与 `evidenceBoundary: "runtime-skia-gles-framebuffer"`。
[窗口指标回归记录](archived-evidence.md)保存了精确提交的
QuickJS App 启动、页面/组件/slot 点击、尺寸/密度变化及后台恢复验证，并保留上一版启动失败。
模块和回调中的窗口 API 与实际 `wm size/density` 对照；会话和数据保持，测试资源清理通过。
该历史记录中的缩小窗口截图有位置偏移和下部裁剪问题。后续
[EGL drawable 回归记录](archived-evidence.md)实测确认：
Surface 已缩小，但绘制时 EGL 仍持有旧尺寸，直到 swap 才更新。修复在绘制前重建
不匹配的 EGLSurface，保留 EGLContext 与 JS 会话；本地参考应用的 11 阶段背景几何
和缩放后真实点击通过。一次恢复截图的重影候选被拒绝，原图及随后通过的候选均保留。
官方视觉状态仍为 `unknown`；这两份 Android 官方模拟器记录不构成微信像素等价、
真机、Android V8 或性能验收。

iOS 的 standalone `MetalSnapshotPresenter` 接收 app-owned `CAMetalLayer`，把同一个完整
`render.snapshot` 上传为 `MTLTexture` 并提交 Metal drawable；它仍使用软件 fallback，
因此 `source: "ios-metal-layer"` 的 surface ownership 证据不会升级为 Skia Metal GPU
通过。需要验证容器自己拥有 Skia Metal surface 时运行：

```bash
scripts/ios-app-smoke
```

该 app-backed harness 创建真实 `UIWindow`/view-backed `CAMetalLayer`，把 drawable
texture 直接交给 Rust Skia Ganesh，并要求 `source: "ios-skia-metal-app"`、
`containerSurfaceAttached=true`、`gpuSurface=true`、`rendererBackend="skia-gpu-metal"`。
它只证明选定 iOS Simulator 上的 QuickJS surface；不替代 V8、真机、完整 API
conformance 或性能门禁。没有 UIView/window 的 standalone smoke 如果 `nextDrawable()`
不可用，会保留 `surfaceProbe.status: "blocked"`，要求嵌入 app 传入 view-backed layer。

<a id="evidence-required-for-a-future-device-gate"></a>
## 后续设备验收所需证据

在发布前运行聚合门禁检查。它只接受完整的 DevTools case index、六平台构建矩阵、
移动端真实 runtime/GPU 证据、七宿主×双引擎性能报告和结构完整的 evidence ledger；
软件 fallback、shell probe、headless 结果和缺失 artifact 会保持 `incomplete`，命令以
非零状态退出：

```bash
pnpm near-parity:gates -- \
  --matrix artifacts/weapp-vite-matrix-final.json \
  --mobile artifacts/mobile-runtime-smoke-required.json \
  --performance artifacts/performance-report.json \
  --performance artifacts/native-performance-report.json \
  --out artifacts/near-parity-gates.json
```

检查结果中的 `releaseReady: true` 只适用于固定版本和列出的证据文件，不会把未观测的
微信私有行为升级为通过。

每个宿主都要保存宿主版本、引擎、manifest commit、冷/热启动、首帧、bridge p50/p95/p99、
内存和帧率，并区分 emulator 与 physical device。只有官方工具完成并且产物日志可复核时，
才可将 capability 从 `partial` 更新为 `full`。

`web-host-perf` 的软件诊断会按 `--iterations` 重建 session 并记录完整 pack 校验、
引擎创建、生命周期与首帧时间；`startupSampleCount` 显示实际样本数。随后通过真实
WebSurface HTTP bridge 每次提交 10,000 个不同值的数据 patch，并检查 runtime 的
`changed=10000`。`setDataSampleCount` 与 `setDataEntries` 保留样本范围；延迟包含
HTTP、JSON 解析与 Rust 数据更新，不包含后续布局/绘制。合并后的性能报告使用这些
宿主实测值重新判断 setData 与 bridge 门槛，超标会退出失败。该 probe 仍是软件
surface 诊断，未测浏览器帧时钟、长列表丢帧、热启动和包体；参考 pack 也必须另行
核对是否包含规定的 1000 节点场景。
