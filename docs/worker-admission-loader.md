<a id="worker-static-admission-and-drawing-resource-leases"></a>
# 工作者静态准入和绘制资源租用

**简体中文** · [English](worker-admission-loader.en.md)


`worker-admission-loader.mjs` 导出两个产品功能。其中任何一个都不导入 `app.mjs`、`pkg/`、AppService WASM 或运行时 Worker，不执行应用程序模块，不读取应用程序数据块，也不使用运行时的 `/api` 端点。`createWorkerAdmissionLoader(dependencies)` 提供一个独立的服务，用于显式的基础 URL 和有限的假资源合约。

```js
import { admitWorkerPack, loadPinnedCanvasKit } from './worker-admission-loader.mjs'
const admission = await admitWorkerPack({
  indexUrl: './pack-index.json',
  indexSha256: expectedPackIndexHash, // mandatory trusted expected pin
  indexSize: expectedIndexSize,      // optional exact size
  route: requestedRoute,             // optional: resolve real first route
  rendererPolicy: { mode: 'manifest' },
  signal,
})
// Send admission.route and the same expected index pin/policy to the Worker.
// The Worker must independently verify the entire pack before app.init.
```

不可变的结果是 `{version:'1.0', route, rendererPolicy, transportBackend, declaredProfile, effectiveProfile, manifest, provenance:{indexSha256,manifestSha256,integrityRoot,indexUrl,manifestUrl,downloadedBytes,blobsDownloaded:0}}`。`rendererPolicy` 显式为 `{mode:'manifest'}` 或 `{mode:'force',profile:'skia'|'skyline-compat'|'webview'}`。Force 保留独立报告的声明配置文件。只有有效 `webview` 选择 `browser-view`；其他配置文件选择 `external-frame`。缺失的请求路由在任何应用执行前都会失败。该结果证明了固定元数据和策略准入，而不是完整的运行时合规性或应用执行成功。

准入仅获取索引和清单。它验证了索引字节的精确 SHA-256、清单字节的 SHA-256 以及使用 UTF-8 键排序的标准化 UTF-8 JSON 完整性根。它在不下载这些数据块的情况下，验证了模式/渲染声明、标准唯一路由、模块到声明数据块的引用以及索引数据块描述符。元数据读取预算为索引 2 MiB、清单 8 MiB；节点/深度限制为 262,144/128。声明的数据块限制为 16,384 和 128 MiB。所有描述符（包括未请求的数据块 URL）均适用相同源的 HTTP(S)、无凭据/哈希/重定向，以及排除 `/api` 解码路径。

调用方从可信的构建/部署元数据中获取预期的索引哈希。从同一未经验证的响应中计算预期的PIN将丢弃这一准入边界。即使在准入之后，独立的Worker验证仍必须执行。

<a id="pinned-drawing-loader"></a>
## 固定绘图加载器

在 Worker 加载精确成功后，外部拥有者可能获取绘制资源：

```js
const lease = await loadPinnedCanvasKit({ owner, loadResult, rendererAssets, signal })
// Capture ownership of a returned lease before checking cancellation again.
// Pass lease.CanvasKit and lease.fontData to the external CanvasKit adapter.
// After scheduler/adapter disposal completes its actual last use:
await lease.dispose()
```

`owner` 是 `{workerEpoch,sessionId,packSha256,transportBackend:'external-frame'}`；`packSha256` 识别已验证的包 **索引**。`loadResult.pack.indexSha256`、`loadResult.state.sessionId`，以及传输字段和精确的外部呈现四字段 1.0 描述符必须匹配。浏览器视图所有者无法通过此 API 分配绘制模块。

`rendererAssets` 接受现有的 `schemaVersion:1, renderer:'canvaskit', fallback:'error'` 运行时配置：`canvaskit:{version:'0.42.0',variant:'full',javascript,wasm,license,package}` 和 `font:{binary,license}`。每个描述符都需要 `{url,sha256,size}`。所有六个 SHA-256/size 对必须等于从 `renderer-dependency-pins.json` 复制的编译 pins；调用方不能选择其他可执行文件或重命名字体。CanvasKit 版本为 0.42.0 完整版。Noto Sans SC 来自 Google Fonts 提交 `a85815a42757630ce188fdad368c2dfc444d4773`。许可证和钉住的 `package.json` 字节在导入任何绘制 JS 之前必须经过验证。包元数据必须独立地命名 `canvaskit-wasm` 0.42.0。在同一源域静态边界内，URL 地址可以变化；但完整性/版本 pins 不得变化。

渲染器下载预算总共为 32 MiB，每个资源的精确固定长度已确定。在分配或继续之前，会检查 Content-Length 和实际流式传输的字节数。对于压缩的 HTTP 响应，Content-Length 描述的是编码后的传输字节；对 fetch 返回的解码流进行精确大小/哈希验证，而传输头仍包含在总字节预算内。读取者拥有自己的数据块，取消不完整的流并释放锁；清理失败仍可被观察到。初始化器只能定位 `canvaskit.wasm`，并将其解析为已验证的本地 Blob 字节。不接受备用 CDN 或额外的初始化资源。

该函数**在主线程上执行 CanvasKit 绘图 JavaScript 及其绘图 WASM**。这属于渲染器依赖，而不是 AppService 引擎或应用程序执行路径。这种区别并不能证明 GPU 验收：真正的适配器仍需要求其 WebGL2 绘制表面和真实的提交证据。

<a id="cancellation-cache-and-lease-boundary"></a>
## 取消、缓存和租约边界

一个服务最多保留一个成功的固定绘图模块/字体缓存。多个调用者共享该初始化过程；一个调用者取消无法中止另一个活跃调用者。如果所有待处理调用者都取消，服务将中止资源获取操作。一个替换初始化会等待实际的先前导入/初始化器和URL清理操作完成。动态导入和CanvasKit初始化没有真正的中止原语，因此取消操作不会产生一个早期的最后使用屏障。一个不合作的注入获取/导入/初始化器可能会保持操作待处理；这种情况将被报告为不完整的屏障，而不是错误的清理成功。

临时脚本/WASM Blob URL 在实际导入和初始化期间保持有效，之后将被精确撤销一次，包括失败或中止情况。默认的 `locateFile` 无法获取未经验证的资源。一个租约暴露了 `{version:'1.0', owner, provenance, CanvasKit, fontData, dispose}`。字体数据是独立拥有的 ArrayBuffer 复制；修改一个租约不会损坏缓存的字体或其他租约。`dispose()` 返回相同的承诺，释放该租约的引用并使后续获取操作无效。它从不关闭借来的 Worker/RPC/桥接资源，也不释放其他所有者的绘制表面。在释放此字体/模块租约前，所有者必须先销毁适配器的字体和绘制表面。

单个服务级 CanvasKit 模块/缓存将在其页面/服务被回收前持续可用。租约释放不会确定性地卸载浏览器 ESM 缓存或 WebAssembly 堆。保留借用的 CanvasKit/字体引用的消费者可以延长其生命周期；所有者最后使用协议仍然适用。下载/缓存限制并不等于宿主 RSS、GPU 内存、FPS 或包大小的验收。该候选方案并未建立任何这些性能门限。

<a id="existing-configuration-producer-discrepancy"></a>
## 现有配置生成器不一致

保留的 `artifacts/dual-renderer-dev-assets/runtime-config.json`、`prepare-canvaskit-dev` 和原生 RendererAssets 验证器已经包含了锁定的 CanvasKit 包描述符。静态的 `build-web-wasm::rendererRuntimeConfig` 生成器遗漏了该描述符，尽管其输入阶段已经验证并复制了该文件。单独的 `worker-renderer-package-config.patch` 增加了真实的固定描述符和一个契约断言。将该生成器补丁与新加载器集成。加载器故意拒绝较旧的不完整配置；它不会合成未经验证的成功，也不会削弱其六资源边界。保留的配置快照仅证明其字节内容，而不证明浏览器成功加载了新实现。

<a id="candidate-checks-and-remaining-integration"></a>
## 候选检查和剩余集成

随附的 Node 案例是 **未执行的草稿**。包案例使用真实的 Node SHA-256 哈希值，而非微小的固定元数据。绘制案例故意注入一个伪造的 SHA 提供者、有限的伪造绘制模块和伪造的 Blob URL；其庞大的字节长度用于测试边界和所有权，且无法证明锁定的厂商字节、CanvasKit 执行、真实浏览器、WebGL 或性能表现。草稿案例涵盖了预期索引失败、路由/强制策略、Unicode 标准化、根节点、重定向/API/来源/尺寸、流中止/释放、锁定漂移、独立字体租约、导入取消、同级所有者隔离以及清理失败。

Root 必须集成产品负责人/入口，将新模块添加到静态打包清单中，运行这些草案和现有检查，重新构建已独立验证的 Worker 导出内容，并获取真实的现场/GPU/输入/性能证据。在编写此候选方案时，未运行任何测试、构建、格式化、浏览器、WASM 操作或服务替换。
