<a id="modern-jsts-view"></a>
# 现代 JS/TS View

**简体中文** · [English](modern-view.en.md)


现代 View 是容器显式开启的同步 ES2022 执行模式。原有 `.wxs` 继续使用
[WXS 兼容路径](isolated-view-engine.md)，两者分别创建独立 QuickJS/V8 realm。
现代模块使用标准 JS 属性、构造函数和对象身份语义，不经过 WXS helper 或逐函数参数复制。

<a id="direct-development"></a>
## 直接开发

在仓库根目录准备依赖后运行：

```sh
pnpm install --frozen-lockfile
pnpm modern:view:typecheck
cargo run -p container-simulator --features quickjs-native -- \
  dev --project examples/apps/modern-view-app --surface web
```

固定 vendor 构建器的准备步骤见[模拟器文档](simulator.md#开发态监督器)。
桌面窗口使用 `--features quickjs-native,desktop-window` 和 `--surface desktop`；
双面板使用 `--surface both`。V8 使用 `--features v8-native` 和 `--engine v8`。
未编入所选原生引擎时明确失败，不回退。

[示例](../examples/apps/modern-view-app)包含 TS、ESM 共享依赖、解构、可选链、
private fields、Map/Set、generator、enum、转为字符串的 BigInt，以及旧 WXS 子组件。
编辑 `view/format.view.ts` 可以触发现代源码单独更新。现代可执行程序变化会重启会话，
编译失败保留最近成功的 generation，并显示诊断。

<a id="select-document-and-module"></a>
## 选择文档与模块

项目根目录的 `container.config.json` 映射的是 **wv 产出 WXML 路径**：

```json
{
  "view": {
    "documents": {
      "pages/home/index.wxml": {
        "mode": "modern",
        "modules": { "fmt": "./view/format.view.ts" }
      }
    }
  }
}
```

WXML 使用 `{{fmt.format(value)}}`。无需添加 `<wxs>`；现代文档不能再声明 WXS。
一个文档及其可达的 import/include 图必须全部开启现代模式，构建器将整张图的 aliases
合为一个执行单元，保留共享依赖单例、ESM live binding 和循环依赖语义。
跨模式 import/include 或模块导入明确失败。现代页面与旧组件可以通过 props、事件和 slot
组合；投影内容保留声明文档的语义。

`.view.js` / `.view.ts` 是开发约定，模块由配置显式选入。现代源不经过上游 WXS 转译器。
纯计算 npm 依赖使用项目 node_modules 解析；Node 内建模块、网络导入和 `.wxs` 依赖禁止。
依赖同样接受同步语法检查，不能依赖浏览器、Node 或 AppService 全局。

模块导入支持相对路径（可以省略 JS/TS 扩展名）和 npm 包的公开入口。
现代打包不读取项目的 `tsconfig.json`，也不继承其中的 `paths`、`baseUrl` 或项目引用；
`container.config.json` 中的 alias 是 WXML 模块名称，不是模块路径别名。
这使冻结源快照无需复制 `.weapp-vite` 生成配置，也能得到相同的解析结果。

支持 ES2022 同步语法、静态 ESM、迭代器、同步 generator、TS 类型擦除和普通 enum 转换。
`tsc --noEmit` 单独负责类型检查，打包成功不代表类型检查通过。
async/await、Promise 任务调度、动态 import、顶层 await、装饰器、namespace、TSX 暂不支持。
网络、定时器和宿主能力由 AppService 承担。这些语言限制不构成不可信代码的安全沙箱。

<a id="data-and-execution-boundary"></a>
## 数据和执行边界

每个页面/组件批次只复制一次数据。现代函数可以修改本批快照，后续表达式会观察到修改；
AppService 原始数据不受影响。模块状态按页面/组件 occurrence 保留，移除实例时释放。
WXS 函数仍保留原有参数复制语义。

Map、Set、Date、RegExp、BigInt、类实例和函数可以在现代模块内部使用；进入渲染属性前必须
显式转为可验证的普通数据。函数、循环对象、BigInt、Map 等不能作为最终渲染值；不会通过
`toJSON` 静默转换。只提交完整成功的批次。保留上一帧不会回滚任意 JS 堆状态。
JS 内部仍使用 UTF-16；渲染输出中的孤立 surrogate 会明确返回
`ERR_VIEW_UNSUPPORTED_VALUE`，异常文本则保留可见转义，避免破坏跨语言传输。

传输层预先捕获内部操作并使用独立容器，允许标准内建对象被用户代码修改，同时保护后续验证、
错误报告和清理。两种 profile 按整文档 frontier 分组，使用同一总 deadline 和取消标记，
不会逐节点或逐函数往返 Rust。超时、取消或无法确认的清理要求重启 session。

<a id="pack-and-host"></a>
## Pack 与宿主

独立打包：

```sh
node tools/container-manifest/bin/container-pack.mjs path/to/raw-weapp \
  --project examples/apps/modern-view-app --out artifacts/modern-view \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
```

原始 `wv build` 目录保持原样，portable pack 另外保存现代程序、原始源和 sourcemap。
开发监督器将原始输出、收据快照和冻结源码放在项目外的专属临时目录，退出时回收；
用户指定的 `--out-dir` 只承载发布的 pack generation，可以保留默认的项目内目录；
构建临时文件不进入源码监听树。真实 watch smoke 分别覆盖项目内与项目外发布目录。
现代 pack 使用 schema v2，声明 `modernView` compiler `weapp-container-modern-view@1.0.0`、
ABI `1.0` 和 target `es2022`；纯旧模式继续使用 schema v1。旧 runtime 无法加载 v2。
所有源码、程序和 map 均使用 SHA-256 并纳入 manifest integrity。
模块、配置、profile、依赖图和有状态模板变化重启 session；安全样式/资源更新仍可原地替换。

原始微信产物仍可被官方工具打开；官方工具不会获得这个容器扩展。现代模式依据标准 JS、
双引擎和宿主测试验收，官方 WXS 兼容性仍单独依赖真实 DevTools oracle。
开发机测试不代表七宿主、GPU、真机或 near-parity 发布门禁通过。

<a id="verification"></a>
## 验证

```sh
pnpm container:manifest:test
pnpm modern:view:typecheck
node --test crates/container-core/tests/modern_view.test.mjs
cargo test -p container-runtime --test modern_session --locked \
  --features quickjs-native,v8-native
cargo test -p container-engine-quickjs -p container-engine-v8 --locked \
  --features container-engine-quickjs/quickjs-native,container-engine-v8/v8-native modern
```

专项性能目标是等价手写现代 JS 的热渲染 p95 开销不超过 5%，旧 WXS 稳定回退不超过 5%。
初始化、编译、批次传输/执行、内存和包体分别报告；开发机结果不替代原有宿主性能门槛。

[2026-10-22 实现与验证证据](archived-evidence.md)保留双引擎语义、
真实 watch、headless 画面/错误恢复和一次 release/1000 样本的相对性能报告，包含历史失败记录。


原生相对性能对照可直接复现：

```bash
pnpm modern:view:perf                         # 默认 release
pnpm modern:view:perf --profile debug         # 快速开发检查，报告明确标记 debug-test
pnpm modern:view:perf --samples 1000 --out-dir artifacts/modern-view-performance
```

脚本先验证 TS 与手写 JS fixture 确实来自同一公开编译器，再依次运行 QuickJS、V8
真实 ViewEngine。历史 WXS bootstrap 固定取自
`081f878808075cfe9c2f1e2025ca97f2a4a9f956`，临时副本在退出时清理。
两个引擎的 TS／手写 JS 与缓存后／历史 WXS 热渲染批次 p95 比值均须 ≤ 1.05，
超出任一门槛脚本返回失败；报告保留在输出目录的 `quickjs.json`、`v8.json`
和 `summary.json`。

计时分别包含 realm 初始化、完整 loadModules 和预热后的 render batch（传输、执行、
归一化及 Rust 解码），不等于纯 JS 函数执行时间。RSS 是包含四个引擎实例及分配器历史的
整个测试进程；测试二进制大小仅作诊断，不能当作生产 runtime 增量包体。
开发机上的相对回归检查不替代真实 DevTools、GPU、设备和各宿主的绝对性能验收。

<a id="ci-special-verification"></a>
## CI 专项验证

[`modern-view` workflow](../.github/workflows/modern-view.yml) 与 `container-ci` 都只接受
手动运行，push/PR 不会触发。进入仓库的 **Actions → modern-view → Run workflow**，
选择分支与 `suite`：`browser`（默认）执行开发态构建和浏览器回归，`performance` 只执行
release 相对性能，`full` 同时执行两组。`suite` 取代旧的 `performance` 布尔输入。

```bash
gh workflow run modern-view.yml -f suite=browser
gh workflow run modern-view.yml -f suite=performance
gh workflow run modern-view.yml -f suite=full
```

命令默认使用仓库默认分支，其他分支可添加 `--ref <branch>`。
`container-ci` 的 `scope` 与 OS 选择见[宿主验证文档](host-validation.md#手动-ci)；
两个 workflow 独立，运行其中一个的 `full` 不代表另一个已经执行。

浏览器组按固定 submodule 的 Node/pnpm 声明安装锁定依赖并执行 `build:pkgs`，
构建现代示例的原始微信产物，再单独生成 schema v2 pack。artifact 同时保留两者，
便于核对公开编译器输出和容器扩展边界。

同一个双引擎 simulator 二进制依次执行 QuickJS、V8 headless Chromium smoke，
检查首帧、现代源码重载、映射到 TS 的运行异常、上一帧保留和恢复。每次调用只创建
自己的临时项目、loopback server、browser/context/page，并在 `finally` 关闭，
报告记录 `headless: true` 和清理结果；清理失败同样使 job 失败。失败报告与截图始终上传。
该二进制显式启用 `skia-raster`，runner 安装 Fontconfig、FreeType 与 DejaVu 字体；
保留真实文字像素和改文案后的画面变化断言，不使用只绘制框和图片的软件 fallback。

release 性能测量选择 `suite=performance` 或 `suite=full`，
使用完整 Git 历史中的固定 WXS baseline 和 1000 次预热后批次样本。
QuickJS/V8 各自的 TS／手写 JS、缓存后／历史 WXS p95 比值超过 1.05，或构建、
报告校验失败，job 都会明确失败并上传已有 JSON，不静默接受回退或调大门槛。
共享 runner 的 CPU 调度和频率会影响结果，因此它作为可审查的专项诊断，
不作为每个 PR 的性能硬门禁；正式验收仍需固定机器复测。

`browser` 组的同 workflow/ref/suite 新运行会取消旧运行；`performance` 与 `full`
不取消正在运行的同类任务，但 GitHub 的并发队列可能替换尚未开始的 pending 运行。
下载缓存只复用依赖，不缓存构建产物或证据。浏览器 artifact 保留 7 天，性能 artifact
保留 30 天；长期证据仍需显式归档。未选择的 suite 不算通过。

这些报告仅证明实际执行的容器开发态画面和原生 View 批次场景，不增加真实 DevTools、
GPU、官方模拟器、真机或 near-parity 发布通过状态，也不改变已冻结的证据与门禁清单。
