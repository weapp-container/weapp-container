<a id="weapp-container-browser-worker-and-legacy-embedding-examples"></a>
# Weapp 容器浏览器 Worker 以及传统嵌入示例

**简体中文** · [English](README.en.md)


<a id="default-worker-product-entry"></a>
## 默认工作程序产品入口

`index.html` 加载 `worker-app.mjs`，其中包含一个异步的 `WorkerWebSession`。AppService/QuickJS 运行在专用工作线程中。页面拥有 DOM 演示器（`webview`）或固定 CanvasKit 演示器（`skia`/`skyline-compat`），由已验证的清单选择。应用粘合层不会被默认窗口图加载。CanvasKit 绘图 WASM 可以在窗口中运行，它与 AppService WASM 是分离的。

使用 `--execution worker`（新默认值）。包含任何外部帧路由的包都需要显式指定 `--renderer canvaskit`、`--canvaskit-dir`、`--font-file` 和 `--font-license-file` 输入（如下所示）。
纯 WebView 包不需要 CanvasKit 资产；旧版 `software` 默认值仅是资产打包的选择，从不会选择 Worker 软件呈现器。
缺少资产将明确报错，且不会提供引擎、HTTP 或主线程的降级支持。

构建器会发出包含预期 SHA-256 和大小的 `worker-product-config.mjs`，其内容精确匹配保留的 `pack-index.json` 字节，包括其末尾的换行符。
所有者和工作程序独立验证 pin 和清单。可通过 `?route=pages/home/index` 选择路由；引擎、渲染器、执行和 pin 查询的覆盖被拒绝。该配置是静态部署的信任根，不能防止整个部署被替换。

构建器单独保留静态源文件、生成的配置/index文件以及所有常规生成的 `pkg/` 文件，包括片段。计划中的 Worker 构建记录 `plannedAppServiceThread: "worker"`，`appServiceThread: "unknown"`，`workerProductEnabled: false` 以及产品执行 `not-run`。构建和接口检查并不能证明产品执行。实际的默认入口浏览器证据、已接受的呈现/输入、GPU 和性能仍为独立的验证环节；仅通过这种连接无法声称新的成功。

页面暴露实际的异步所有者为 `window.weapp`，运行时加载 Promise 为 `window.weappReady`，首次接受当前启用输入的呈现为 `window.weappPresented`，绑定的观察为 `window.weappTrace`，入口的可等待关闭屏障为 `window.weappClose`。仅运行时就绪并不能保证可见帧。所有者已拥有业务定时器轮询、可见性及页面隐藏的处理。启动流程不会添加第二个 RAF 或生命周期所有者。每个启动流程接受一个应用；在创建替换前必须等待关闭。当客端模块初始化需要窗口/系统快照时，应在 `WorkerWebSession.load` 中传递宿主的完整 `metrics` 观察，包括使用 `hostServices`。加载传输在任何客端模块运行之前，会将其 `pixelRatio`、屏幕范围、方向和可选的安全区域安装到原生会话中。窗口尺寸必须与 `viewport` 一致。在每个新所有者创建时，需提供示例或明确指定这些值，包括预飞行和恢复阶段；渲染缩放和所有者的布局默认值并不能建立显示观察。没有 `metrics` 时，不可用的原生快照字段将保持不可用，而不是继承旧所有者的值。

`revokeHostIdentity()` 会永久阻止该所有者的输入、业务调用、延迟应用结果和宿主批量回调。其可查询的 `status.identityRevocation` 记录待处理/已撤销/失败的控制尝试；正常退场会保持 `status.fault` 为空，可成功关闭。原生撤销失败将保持执行门关闭，并允许对相同控制进行显式重试。在会话的 `close()` 之前，必须等待 `BrowserHostServices.close()`，以便失败的设备/文件释放能保留其精确句柄，从而可进行显式服务关闭重试。现有的执行故障和真实的原生或清理失败仍会拒绝关闭；新账户需要新的所有者。在没有显式启用渲染器转换的情况下，所有者将保持其初始家族不变，并将跨家族导航报告为需要新所有者。静态产品可显式协商与同一 Worker 的 DOM/Skia 事务，使用 [`rendererTransitions: {"version":"1.0"}`](../../../docs/worker-presenter-transactions.md)。此启用操作不会启用普通模拟器浏览器自动功能。

`node --test scripts/worker-product-entry.test.mjs` 检查直接启动和错误域合约。这些编写的测试使用所有者代理，不能代表实际保留的默认入口浏览器网关。之前的独立 Worker 探针使用自己的运行时环境，不建立产品呈现。

<a id="default-entry-contracts-and-browser-smoke"></a>
## 默认入口合同和浏览器烟雾

`pnpm host:web-worker:test` 包含了所有者、准入、DOM/CanvasKit 适配器、修订 fencing 和入口合约。`pnpm host:web-wasm:test` 包含生成的包/解析器闭包和产品浏览器运行器合约。这两个命令由现有的 manifest CI 任务调用；它们不会启动实际的产品浏览器或申请 GPU 验收。`pnpm host:web-worker:smoke` 仍保持为早期的独立 Worker 探测。

构建器需要从 `tools/container-manifest/node_modules/acorn` 获取已安装的、由锁定文件固定版本的 Acorn 8.15.0 依赖项。首先运行 `pnpm install --frozen-lockfile`。它会验证执行解析器和许可证字节的精确性，并将它们保存在 `validation/generated-module-parser/` 目录下，同时在评估其连接代码之前会检查整个生成的 JavaScript 包。npm 的完整性是来源元数据；构建器不声称能验证下载的归档文件。

实际的默认入口网关需要两个新鲜的、源码稳定的站点，由同一个干净提交构建而成：一个 `webview` 包和一个单独的 `skia` 包。专用的 `fixtures/worker-product-browser` 测试 fixture 提供渲染器配置文件。每个包均使用当前固定的编译器 SHA 及其对应的配置进行打包：

```sh
node tools/container-manifest/bin/container-pack.mjs fixtures/worker-product-browser --out DOM_PACK_DIR --compiler-commit FIXED_COMPILER_SHA --project fixtures/worker-product-browser --config dom.container.config.json
node tools/container-manifest/bin/container-pack.mjs fixtures/worker-product-browser --out CANVAS_PACK_DIR --compiler-commit FIXED_COMPILER_SHA --project fixtures/worker-product-browser --config canvaskit.container.config.json
```

使用 `--execution worker --renderer software` 构建 DOM，使用 `--execution worker --renderer canvaskit` 和显式依赖输入构建 CanvasKit。
DOM 的 `software` 包装标签不会选择 CPU 像素呈现器。
独立保留每个精确的 `pack-index.json` 的 SHA-256 值，然后运行：

```sh
pnpm host:web-worker:product-smoke --dom-site-dir DOM_SITE_DIR --dom-index-sha256 DOM_EXACT_INDEX_SHA256 --canvas-site-dir CANVAS_SITE_DIR --canvas-index-sha256 CANVAS_EXACT_INDEX_SHA256 --out-dir NEW_PRODUCT_EVIDENCE_DIR
```

运行器访问未更改的默认入口，使用其真实的 Worker 和呈现器。
它验证实际输入、已接受的呈现、尺寸调整、2x 重绘、可见性以及所拥有的清理操作；它在两个站点间保持一个无头浏览器/页面。不允许使用 API 服务器或跨源网络降级。除非 `WEAPP_CONTAINER_PLAYWRIGHT_MODULE` 指定了另一个明确安装的模块，否则安装的 Playwright 模块来自固定的供应商依赖。
原始的 fixture 打包不会建立 weapp-vite 监听执行。驱动身份、物理 GPU、时序、其他宿主以及官方一致性仍保持独立的验收门禁。旧的同步 `web-wasm-browser-smoke.mjs` 明确拒绝这些 Worker 站点，仅用于 `--execution legacy` 构建。

<a id="explicit-legacy-import-and-detailed-integration-notes"></a>
## 显式旧版导入和详细集成说明

使用 `--execution legacy` 构建，然后打开报告的显式 `legacy.html` 入口。`app.mjs` 保持同步的 `WeappWebSession` 和 `unixTimerNanos` 导出不变。其 AppService 运行在 Window 上，且在构建元数据中仍为 `main / false`。旧的同步浏览器烟雾测试会选择此显式入口，并拒绝 Worker 构建计划。没有执行元数据的历史构建将保留其旧的索引入口。以下关于软件/Canvas 2D 和同步包装器的说明适用于此遗留通道。

此示例将一个便携包加载到 Rust `WebWasmHost` 中，该宿主编译为实际浏览器的 WebAssembly 模块，并在该模块内部使用 QuickJS 提供商。默认的 Canvas 2D 呈现器每渲染一次接收一帧带类型 RGBA 数据。可选的 CanvasKit 呈现器接收一帧完整的布局数据，并在 WebGL2 上绘制。两种模式均无法实现完整的微信兼容性或 Web V8 支持。

首先构建一个可移植包，然后构建一个新的静态输出目录：

```sh
node scripts/build-web-wasm.mjs \
  --execution legacy \
  --pack /absolute/path/to/portable-pack \
  --out-dir /absolute/path/to/new-web-output \
  --llvm-bin /opt/homebrew/opt/llvm/bin \
  --wasm-bindgen /absolute/path/to/wasm-bindgen
```

所选的 rustup 工具链必须安装了 `wasm32-unknown-unknown`。
LLVM 必须提供带有 WASM 后端的 `clang` 和 `llvm-ar`；脚本会在 Cargo 之前实际使用一个 WASM C 对象/归档文件来探测这两个组件。`wasm-bindgen --version` 的版本必须与保留的 `Cargo.lock` 文件中的 `wasm-bindgen` 版本完全一致。
还可以通过设置 `WEAPP_CONTAINER_LLVM_BIN` 和 `WEAPP_CONTAINER_WASM_BINDGEN` 来指定路径。该脚本从不安装或更改工具。

要构建 CanvasKit 变体，需添加这些显式本地输入：

```sh
  --renderer canvaskit \
  --canvaskit-dir /absolute/path/to/canvaskit-wasm-0.42.0 \
  --font-file /absolute/path/to/NotoSansSC.ttf \
  --font-license-file /absolute/path/to/OFL.txt
```

构建器固定了完整的 CanvasKit JavaScript/WASM 包元数据和 BSD 许可证，以及原始的 Noto Sans SC 变体字体和 OFL 许可证，通过精确的 SHA-256 值和大小。有关所需字节和公开源 URL，请参见构建脚本中的 `RENDERER_DEPENDENCY_PINS`。它会暂存这些依赖项以及 `runtime-config.json`；如果输入无效或缺失，将无法进行渲染器回退。依赖项由调用方提供，而不是由构建器下载。提取文件的验证与归档验证是分开记录的。

相同的固定文件也可以为原生开发模拟器进行准备：

```sh
node scripts/prepare-canvaskit-dev.mjs \
  --canvaskit-dir /absolute/path/to/canvaskit-wasm-0.42.0 \
  --font-file /absolute/path/to/NotoSansSC.ttf \
  --font-license-file /absolute/path/to/OFL.txt \
  --out-dir /absolute/path/to/new-renderer-assets
cargo run --release -p container-simulator -- dev \
  --project examples/apps/reference-app --surface web \
  --renderer-assets /absolute/path/to/new-renderer-assets
```

准备者在发布输出目录前会验证六个共享哈希和大小。模拟器会再次验证这些内容，并仅提供该允许列表。它不会获取依赖项。此开发模式保持一个 AppService 和一个运行时在 Rust 中；`remote-canvaskit.mjs` 会接收完整的渲染帧并在浏览器中绘制它。它不会启动另一个 WASM 应用会话。开发网页渲染默认需要这些资源。显式指定 `--software` 会保留 CPU RGBA 诊断模式；CanvasKit 失败情况永远不会静默地选择该路径。

`GET /api/render-frame` 包含会话、配置生成和渲染修订版本以及图像描述符。图像字节使用解码后的 RGBA SHA-256 值，当前会话/生成/修订版本的 URL 由系统授权。客户端验证哈希值，并维护一个有界的解码资源缓存。服务器撤销旧的 URL，同时允许已批准的不可变响应完成。`POST /api/render-presented` 仅排队一个 CanvasKit 提交回执。输入在运行时所有者通过 `presented` 事件确认相同身份后恢复；过期或未确认的 `event.batch` 请求将返回 `ERR_CANCELLED`。这确认了运行时和浏览器状态的匹配，而不是物理 GPU 的完成。上下文丢失会暂停输入，恢复时会先重绘，然后再重新启用输入。

运行拥有开发浏览器网关时使用
`node scripts/simulator-canvaskit-browser-smoke.mjs --binary
/absolute/path/to/release/weapp-simulator --renderer-assets
/absolute/path/to/renderer-assets --out /absolute/path/to/new-evidence`。
它会将参考项目复制到自己的临时目录中，启动一个临时模拟器和一个无头浏览器页面，然后记录就绪/输入/2×密度/过期收据检查和清理操作。浏览器GPU收据和显式读回证据保持独立；SwiftShader被识别为软件驱动，物理硬件仍未知。该脚本从不触及用户现有的模拟器监听器或浏览器标签页。

默认配置为 `release`。使用 `--profile dev` 进行开发，使用 `--offline` 要求使用缓存的 Cargo 依赖项，或使用 `--target-dir` 重用显式 Cargo 缓存。Cargo 默认会并行构建 cdylib，使用四个作业；`--jobs 1` 到 `--jobs 256` 会明确在构建计划中记录不同的并行性限制。请改用此选项代替导出 `CARGO_BUILD_JOBS`：自定义 Cargo 环境设置仍保留其原有的来源限制。编译配置为 `--no-default-features --features wasm,quickjs-native --target
wasm32-unknown-unknown --locked`；`cargo check` 和原生主机二进制文件无法满足此构建要求。复制的 WASM 必须导出实际的 `WebWasmHost` 入口点作为函数，可以不带后缀，或带有 wasm-bindgen 的 16 位十六进制后缀；描述符导出和类似前缀的名称无法满足该接口。一个拥有 Node 进程导入生成的 JavaScript 并检查其默认初始化器和 `WebWasmHost` 方法，而无需初始化 WASM 或构造主机。其反射接口保留在 `build-report.json` 中。`SDKROOT` 和 `SDKTARGETSYSROOT` 仅从子构建工具环境移除，保留调用者的 SDK 设置。

输出目录必须不存在。它保留了已验证的 `portable-pack/`、`pack-index.json`、`pkg/container_host_web.js`、`pkg/container_host_web_bg.wasm`、`index.html` 和 `app.mjs`。使用静态 HTTP 服务器提供此目录；不涉及原生容器服务器：

```sh
python3 -m http.server 5181 --bind 127.0.0.1 --directory /absolute/path/to/new-web-output
```

打开 `http://127.0.0.1:5181/legacy.html` 在浏览器中。该应用从 `pack-index.json` 中检查 manifest/blob 的哈希值，启动一个运行时会话，并呈现其帧。`app.mjs` 中的 `WeappWebSession` 是嵌入包装器。示例暴露了 `window.weappReady`、`window.weapp` 和受限的 `window.weappTrace` 用于烟雾验证。关闭按钮会卸载会话并释放其 WASM 所有者。定时器轮询、输入和页面可见性使用批量桥接调用。定时器轮询传递 Unix 时间戳纳秒，与 Rust 的 `SystemTime` 和 AppService 的 `Date.now()` 截止时间匹配。RAF 的相对时间戳仅用于调度泵。每次轮询都会采样 `Date.now()`，验证整数毫秒，并转换为 `BigInt`，然后乘以 `1_000_000n`，对于超出无符号 64 位纳秒范围的值会拒绝，而不是循环或丢失精度。每个包装器只接受一次加载；并发或重复加载将立即失败。加载过程中关闭将中止应用资源并取消该调用者对 CanvasKit 的等待。已验证的 CanvasKit 模块将被缓存整个页面生命周期内；关闭一个应用将释放其自身的绘制表面/上下文/字体，而不是共享模块。如果在 Rust 提交新命中树后呈现失败，输入和自动呈现将暂停，直到显式渲染成功，从而防止对不可见节点的输入。业务定时器轮询将独立于呈现继续运行。诊断保留结构化错误码。

`source/` 是一个经过字节验证的、作用域内 Rust/workspace/build/sample 输入快照。Cargo 编译该快照，因此对原始检出的修改不能在不通知的情况下改变正在进行的构建。`source-snapshot.json` 绑定了提交、各个 SHA-256 值、作用域和脏状态。`raw/` 保留了 Cargo 链接的 WASM；`build-report.json` 记录了精确的原始/绑定生成 WASM 哈希值、工具版本、命令和限制。完整的命令输出保存在 `commands/` 目录下。取消或超时仅终止该命令所拥有的进程组。

构建器在验证或复制可移植包之前会冻结源代码。它仅从该快照中导入验证器：`portable-pack.mjs`，其现代视图资源辅助函数以及仅 Node 环境的 `json-integrity.mjs` 辅助函数。该闭包不需要 npm 编译器依赖项，也从不执行原始检出代码中的验证器辅助函数。`build-report.json.packValidator` 记录其入口点、各个文件的哈希值以及合并后的源码哈希值。构建器在导入前会检查这些字节，并在报告就绪前重新检查整个快照。

`WEB_SAMPLE_FILES` 是单个浏览器源码/预发布库存。输出内容还包括完整的 Worker 基础设施（`runtime-worker.mjs`，及其所有者和 RPC 客户端），Worker 桥接适配器和 DOM 呈现器/会话客户端闭包。`browser-assets.json` 列出每个复制文件的冻结源路径、SHA-256 值和大小；`build-report.json.browserAssets` 将该库存的精确字节绑定，并记录最终保留文件的验证结果。缺少或更改了闭包文件将导致构建失败，无法报告就绪状态。

这些文件为显式入口图进行了打包。
`legacy.html` 加载 `app.mjs`，该文件在页面主线程上导入并构建 WASM。传统库存和报告明确记录 `appServiceThread: "main"` 和 `workerProductEnabled: false`。默认工作线程入口和构建计划元数据如上所述；仅打包本身并不能确立实际产品的执行或性能。
生成的 `pkg/` 附加件/WASM 和固定渲染器/字体资源保留其原有的哈希和接口门控。

一个稳定的脏快照或继承的自定义编译标志可以生成可用的产物，但其报告为 `partial`，且命令退出码不为零。失败或被取消的输出会保留诊断信息，永远不会报告已准备就绪。一个干净的 `passed` 构建仅验证了编译和打包的完整性；浏览器执行、输入、CanvasKit/GPU、设备和性能验收需要单独的测试。

<a id="canvaskit-frame-presenter"></a>
## CanvasKit 帧呈现器

`canvaskit-presenter.mjs` 每次接受一个完整的 Rust `RenderFrame`：

```js
const presenter = await CanvasKitFramePresenter.create(CanvasKit, canvas, fontArrayBuffer, {
  typography: 'native-v1',
})
const receipt = presenter.submit(JSON.parse(host.render_frame_json()))
// After input/setData: dispatch and commit in Rust, then submit the new frame.
const readback = presenter.snapshotEvidence() // explicit GPU readback, not the hot path
presenter.dispose() // before disposing/replacing the canvas or its dimensions
```

在使用此呈现器时，在 `WebWasmHost.load_manifest_json_with_config(...)` 中选择 `renderer_mode: 'external-frame'`。
Rust 会验证并保留每个完整帧，而不会在每次提交时都对软件位图进行光栅化。原生嵌入使用 `WebSessionOptions { renderer_mode: WebRendererMode::ExternalFrame }` 配合 `WebHost::load_manifest_json_with_options`。默认值仍为 `software`；无效的模式值将报错 `ERR_RENDER`。Rust 的能力及提交回执将报告 `external-frame-export` 且不附带 GPU。该模式下的显式快照请求为软件诊断；CanvasKit 的实际 GPU 回执和读取仍保持独立。

对于附加的 DOM 呈现器，宿主 API 也接受
`renderer_mode: 'browser-view'`。此明确模式启用视图事务并强制使用 WebView proifle；它报告 `browser-view-export`，而不声明一个活跃的 DOM 绘制表面或 GPU。使用 `view.prepare`、`view.prepare.commit` 和 `view.presented` 及其完整的呈现键。Skia 帧、软件快照、密度和渲染器回执 API 在此模式下被拒绝。此宿主选项本身不会在 `app.mjs` 中添加 DOM 入口点，或实现页面级混合渲染。

`runtime_state_json()` 提供了权威的当前路由/页面、逻辑视口、有效配置文件、精确的小数字符串视图/渲染修订版本、生命周期和执行故障信息。它不暴露页面数据，也不认证呈现。窗口观察、授权二进制资产和预览退役使用 `notify_window_metrics_json`、`browser_view_resource` 和 `retire_browser_preview`；资源读取需要完整的授权密钥。
Worker 宿主必须明确配置有限的启动和终止限制，如 [AppService 执行](../../../docs/appservice-execution.md) 所述。
旧版示例在其主线程上拥有自己的 WASM 宿主。
Worker 所有者和传输在 [Browser Worker 传输](../../../docs/browser-worker-transport.md) 中有文档说明；通过运行 `pnpm host:web-worker:test` 执行本地合约。当前默认入口使用异步所有者，而此旧版画布示例仍保持独立。
Worker 基础部分限制了待处理事件，通过控制通道确认客户端消费，并在事件背压时明确失败。事件回执不授权呈现。其总启动超时使用单调时钟；定时器轮询仍使用 Unix 时间。

调用方提供经过验证的 CanvasKit `0.42.0` 和包含所需字形覆盖的字体。呈现器没有下载器、包加载器或运行时依赖安装程序。它需要 `GetWebGLContext → MakeWebGLContext → MakeOnScreenGLSurface`，并检查绘制表面是否为 GPU 支持的表面。不可用的 WebGL、丢失的上下文和不支持的帧会抛出结构化的 `ERR_RENDER`/`ERR_UNSUPPORTED_CAPABILITY` 错误；它从不选择 CPU 表面。驱动字符串与物理硬件证据保持分离。调整画布大小需要销毁并重新创建呈现器。其清理操作会释放字体、图片、表面和所拥有的上下文。

在录制图片之前会检查完整帧；录制完成之前，可见绘制表面不会发生变化。无效/不支持的帧会保留上一帧。在实际提交过程中出现驱动故障，无法保证回滚。回执记录一帧批次，每个节点运行时调用为零，软件RGBA上传为零。CanvasKit 自身的本地绘制绑定仍按每条绘制命令执行。

正常提交不会调用 `gl.finish` 来清空待处理的绘制操作；其回执显示为 `gpuCompletion: 'not-waited'`，因此提交的帧不会声称 GPU 完成或显示呈现。`snapshotEvidence()` 会明确进行同步并读取绘制表面，返回 `gpuCompletion: 'gl.finish'`。回执读取与常规绘制分离，且不应在每个动画帧中调用。

解码的 RGBA 图像在已接受的帧之间被缓存。资源 ID 仅是查找键：重用还要求尺寸相等，且每个 RGBA 字节必须与独立拥有的副本完全匹配。任何资源的变更（包括在哈希值不变的 ID 下调用方的突变）都会创建新的图像。缓存发布和 LRU 访问更新仅在提交成功且临时图像清理完成后发生；准备或录制失败时会释放新图像，同时保留旧条目。缓存最多保留 1024 个条目，默认为 64 MiB 的账单预算，用于 RGBA 验证副本，以及同等大小的 SkImage 像素估算值。此估算不包括驱动程序开销和排队的 GPU 工作。在创建呈现器时，将 `imageCacheBytes` 设置为较小的整数（包括零）；超过 64 MiB 的值将失败。超大图像仍可作为临时资源在现有每帧限制内绘制。上下文丢失和 `dispose()` 会在销毁 GPU 上下文前释放缓存的图像；清理失败仍可被观察到，且销毁操作不会对拥有者进行重复删除。

Web/WASM CanvasKit 产品所有者现在在 `app.init` 之前安装确切的允许字体。Rust 读取其 SFNT 指标用于布局、换行、正常行高和基线；已提交的计划携带 `{font:{sha256,face_index:0,
profile:"sfnt-unhinted-v1"}}`。绘制器验证相同的字节并使用线性、无提示指标而无需重排。直接应用和默认的 `WorkerWebSession` 会自动从固定渲染器资源中协商此配置。低级别直接主机在加载前调用一次 `configure_text_font(Uint8Array, sha256)`，并将返回的身份作为呈现器 `fontIdentity` 传递。低级别 Worker 加载提供 `textFont:{version:"1.0",profile:"sfnt-unhinted-v1",url,
sha256,size}`；Worker 在加载应用 JS 前验证并安装该字体。字体入口大小限制为 32 MiB。缺少字形、字体/配置不匹配和原地字体替换失败；必须重新选择字体以获取新的所有者。

此配置文件使用 face zero 和默认变体轴，以及标量字形推进值。复杂的排版、双向文本（bidi）、CSS 字体族/粗细以及独立的远程原生预览字体路径仍待处理。未绑定的旧版帧保留其原有的度量协议。有限的字体表/CanvasKit 对比与浏览器安装后的视觉验收是分开的。回执仍为 `partial`。
`solid` 边框使用指定的四边边框 `style.border` 协议（顶部/右侧/底部/左侧，每边包含宽度、RGBA 颜色和样式）；`none` 和 `hidden` 的使用宽度为零。最终的 `node.bounds` 为边框盒，因此呈现器不会再次应用 `box_sizing`。背景覆盖外层圆角盒；边框绘制外层减内层的环形区域，按加权边距距离划分，以保持内角圆角部分被填充，透明连接部分可自然融合。文本从使用边框和内边距的内部开始。后代溢出裁剪使用内边距边缘和内圆角，包括独立轴和累积的变换。当 Rust 忽略四条默认的指定边时，完整的计算宽度/样式长手值决定边框是否为静止状态；颜色长手值不会导致零/无/隐藏边框不被支持。没有指定协议的非零实边框将失败。

显式设置 `scrollContainer: true` 的帧会在固定 padding-box 剪裁后，根据解析的 `scrollOffset` 移动其后代元素，背景/边框保持不变。嵌套的变换和剪裁使用与 Rust 绘图和命中相同的组合方式；未带标志的原始偏移元数据不会触发移动。无效的偏移在图片录制前会被拒绝。轴选择、边界、手势输入和事件保留在运行时中；呈现器不会从 WXML 属性中推断这些内容。

Typed image resources 重放运行时解码的 RGBA 像素、裁剪/适应几何形状和最近邻采样。背景图片、非实心边框样式和阴影绘制目前不支持。原生渲染器和 DevTools 视觉结果需独立提供一致性证据。

使用 `node --test scripts/canvaskit-presenter.test.mjs` 运行合约测试。
真实的 CanvasKit CPU API 预检需要显式指定 `WEAPP_CONTAINER_TEST_CANVASKIT_DIR`（解压后的包目录）和 `WEAPP_CONTAINER_TEST_CANVASKIT_FONT`（锁定的 Noto Sans SC 文件）。它会验证实际的依赖哈希，并测试 picture/glyph/border/rounded-clip 的读回；缺少路径将导致跳过。此 CPU 预检和测试代理所有权测试并不能确立浏览器、WebGL 或 GPU 的验收。

运行实际的静态嵌入烟雾测试，使用完成的构建，命令为：
`node scripts/web-wasm-browser-smoke.mjs --site-dir /absolute/path/to/new-web-output
--out-dir /absolute/path/to/new-smoke-output`。它使用一个已拥有的无头浏览器和临时的本地服务器，并保存截图、运行时轨迹、驱动收据和清理结果。一个无头WebGL驱动可能使用软件；其报告的GPU表面并不能证明物理硬件的存在。

`scripts/border-box-browser-smoke.mjs` 重新播放 `container-runtime/tests/border_box.rs` 中精确接受的 Rust 帧 exports；在运行该测试时同时启用真实引擎特性，并设置 `WEAPP_CONTAINER_BORDER_EVIDENCE_DIR`。浏览器门禁要求 QuickJS 和 V8 的所有 14 个案例（共 28 个测试用例），包括默认边距序列化、动态更新、被拒绝提交的保留、填充裁剪、变换以及有限保存的 DevTools 共享样式值：

```sh
node scripts/border-box-browser-smoke.mjs \
  --frames-dir /absolute/path/to/accepted-border-frames \
  --canvaskit-dir /absolute/path/to/canvaskit/bin/full \
  --font /absolute/path/to/NotoSansSC.ttf \
  --out-dir /absolute/path/to/new-border-browser-report
```

运行器在不启动浏览器的情况下导入。显式调用会拥有一个无头浏览器和临时回环服务器，保留输入哈希和回执，处理取消操作，并在报告前关闭其资源。缺少、重复或意外情况在分配浏览器之前会失败；此本地 WebGL 证据并不能证明官方的视觉或物理设备一致性。
