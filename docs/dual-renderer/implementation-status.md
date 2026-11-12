# 双渲染实施进度

目标与验收范围由 [冻结清单](README.md) 管理。下面记录实现阶段，不能替代清单中的官方、宿主、设备或性能门禁。目标尚未完成，执行状态以应用中的 goal 记录为准。

新增显式实验 [Live Document v2](browser-live-document-v2.md)：原生 QuickJS/V8 提供私有
接收者 incarnation，runtime 先发无几何 document permit，再原子校验 live geometry
和最终 ACK；浏览器客户端按 typed patch 复用 Document/root/节点，丢失最终结果时
仅重发原 envelope。普通 CLI/Worker 保持 v1。该阶段声明 `nativeEditing:false`，
更新期间使用原生 inert 冻结输入，原生编辑 lease、延后事件 token 校验和中文 IME
连续性仍未完成。32 请求／8 MiB 保留容量有明确拒绝边界，尚非无限 watch 的生产协议。
实现 `dbe26e4` 已通过 2,406 项 Rust workspace 检查、严格 Clippy、双原生引擎各 6 项
真实浏览器用例及新 release WASM 的 3 项 Worker DOM 回归；输入固定、失败历史和
清理范围见[本轮证据](../archived-evidence.md)。279 项发布门禁保持 unknown。

后续新增显式 [Live 2.1 消费扩展](browser-live-consumption.md)：runtime 发行独立 lane，
业务请求使用单调规范序号，完整 final 带收据；纯 owner 元数据消费只原子回收已知
Complete 前缀，永久保留已消费水位。客户端等待 terminal candidate、实际 transport
与资源结算后才发送消费，丢回复保留原请求并显式恢复。默认 2.0、普通 CLI／Worker
入口及 `nativeEditing:false` 不变；生产编辑、IME、其他宿主和发布门禁继续待完成。

后续 v2 已将 accepted document 与 touch contact 绑定到真实 receiver snapshot，
使用双引擎 native 保留的 dispatcher，在每个 listener 前及可能重入的 getter、返回值
序列化之后重新校验；microtask checkpoint 后也复核实例。实际退休撤销旧画面的
硬输入权限，先前完成的 callback/setData 效果继续保留。该阶段仍声明
`nativeEditing:false`，lease、延后编辑队列、source-edit 因果和 IME 连续性继续待实现。
验证结果及精确源码见 [receiver dispatch 证据](../archived-evidence.md)，不沿用旧提交的完整工作区结论。

最终 `2f64f5f` 另将 guarded handler 路径解析改为私有字符扫描，防止应用覆写 split
改变可信处理器，并在每段 getter 后停止已退休接收者的后续读取。最终源码的
双引擎专项各 13 项、browser integration 44 项、所选 Node 782 项、严格 Clippy、
release WASM 及 native/Worker 真实浏览器回归均通过；完整范围和原字节绑定见
[handler routing 证据](../archived-evidence.md)。
本轮未重新运行完整 workspace 测试，不授予 IME、硬件、官方或性能通过。

## 当前可运行路径

- manifest v3 支持默认及逐页 `skia`、`webview`、`skyline-compat` profile。旧 v1/v2 继续可读；不支持的 profile 在加载时明确拒绝。
- 已求值模板可投影为布局无关的 `ViewDocument`，保留稳定节点、组件来源、事件声明、样式与资源。Skia 的准备、布局与候选接受由 `SkiaPageBackend` 管理，Session 保留求值、资源与输入授权、滚动协调及最终呈现权限；普通 DOM 路径不创建页面 Skia 对象。具体边界见 [Skia 页面后端](skia-backend-boundary.md)，只读 typed host observation 已接入；backend-neutral coordinator 与剩余宿主 mutation 仍待拆分。
- Skia 分离 raster、外部场景、原生 GPU 三种呈现模式。外部/原生 GPU 的普通提交不先生成 CPU 整页像素，截图属于显式诊断。
- 开发模拟器的 Web remote 路径将场景批次和独立内容寻址图片交给浏览器 CanvasKit。资源采用固定版本、哈希校验和有界缓存。软件页面传输必须显式选择 `--software`。
- 呈现回执先进入队列，再由运行时线程核定。外部呈现的 ready、selector 与输入等待有效回执；HTTP 202 不代表已呈现。CanvasKit flush 和 Metal command submission 也不代表 GPU 执行完毕或屏幕扫描完成。
- macOS 开发窗口接入 Metal；Android、iOS、鸿蒙样例接入 GPU 提交后的 revision 确认。平台自身的执行证据分别管理。
- DOM presenter 已能在隔离 iframe 中使用浏览器布局、样式、图片、输入与滚动；新增共享 runtime 的文档事务及 `DomSessionClient`，通过 `view.prepare → view.prepare.commit → view.presented` 连接实际 AppService/View 与浏览器。详细协议见 [Browser presentation v1](browser-presentation.md)。
- 新增 `container-host-common` 的 `dom-protocol` 验证示例：加载并校验真实 portable pack，在单个所属线程运行 QuickJS 或 V8 的 `HostSession`，通过 JSONL 接收完整 bridge envelope、返回完整 batch。配套 browser smoke 使用自己的临时 HTTP server 和 headless Chromium，直接加载 reference/modern View pack，检验 DOM 点击引起的 AppService `setData` 与后续文档呈现；不是模拟器的新运行入口。
- 开发 CLI 已接入 `--surface web --renderer webview --web-runtime remote`：同一监督器负责 watch、portable pack、DOM 请求版本、资源发布和最终 ACK。`auto` 按页面 profile 选择 CanvasKit 或 DOM。Browser CLI 显式支持 `web + quickjs + webview|skia`，需独立 runtime/pins；Skia 要求固定的 CanvasKit Worker producer。Browser Skia 已支持启动时的 `--render-scale auto|1|1.5|2|3|4`，auto 只在所属预览启动时采样，按实际 DPR 创建目标，超过像素预算时明确失败；Browser 实时设置面板、跨屏幕自动更新和 FPS 调节尚未接入。Browser 的 auto、V8、native surfaces、software、显式 `--fps`、renderer assets 等组合与原生 WebView adapter 仍明确拒绝；原有 live 服务的版本与替换证据另行记录。
- 新增独立的 `serve_browser_stage` 静态 HTTP 示例和显式 resource-only 库入口，通过同一监督器借出已验证 runtime 与固定 stage 的原字节；它不开放 browser watch CLI，也不执行 Worker、AppService 或 presenter。参数、URL 与生命周期见[静态 HTTP](browser-static-http.md)。
- 实验入口 `serve_browser_dev` 已接通固定编译器 watch、受管 portable/stage、原串行 owner、鉴权 HTTP 控制和开发 UI，由浏览器 QuickJS Worker 执行应用并使用隔离 DOM 呈现。普通 CLI 已通过同一个 runner 复用这些边界；启动、容量和关闭限制见[浏览器开发循环](browser-dev-loop.md)。
- Browser Skia 面板记录有界 `submitted` 回执，并仅在与当前 accepted proof、逻辑 surface、页面和 viewport 匹配时显示 `accepted`。元数据不授予输入权限；硬件为 `unknown`，GPU 完成为 `not-waited`。普通 Browser CLI 的 DOM 与 CanvasKit 两条真实开发循环现均通过：实际点击驱动 AppService `setData`、12 次更新与 13 个 Worker、构建失败后继续交互及 Stop 清理。CanvasKit 实际使用 SwiftShader；活动 owner 已观察上下文的绘制没有 `finish/readPixels`，全局 15 次退役同步及调用栈原样保留。精确范围、失败历史和最终源码见[双路径执行证据](../archived-evidence.md)，不授予硬件、性能或七宿主发布通过。
- 后续 controls 集成 r6 在 `4f753cab` 上通过 DOM 查询、原生 Button 和 Skia 恢复三组真实开发循环。查询记录 15 组原始观测及严格 G/M 水位校验；Button 通过 11 项交互检查。三组各完成 12 次更新与 13 个 Worker 的关闭，历史失败保留于[集成证据](../archived-evidence.md)。这次 Skia 全生命周期仍记录 19 次 `finish`，活动热路径与完整生命周期分别报告。
- 后端拆分后的 `ff22b577` 重新完成 release CLI、独立 release WASM producer 和上述三组真实浏览器开发循环：查询 15 组原始观测、Button 11 项检查、Skia 两次上下文恢复及 40 项活动路径检查；每组均完成 12 次更新、13 个 Worker 与自有页面、浏览器和服务的关闭。Skia 本次完整生命周期记录 19 次 `finish`、0 次 `readPixels` 和 0 次整页 RGBA 上传，活动上下文检查单独保持零同步调用；实际驱动为 SwiftShader，不授予硬件或性能通过。原生 workspace 为 2123 项通过、0 失败、11 忽略，格式及全部 target/feature 的严格 Clippy 通过；无 native engine 的 CLI 构建保留 11 条既有 warning。旧失败与本轮精确源码、产物和清理记录见[后端拆分证据](../archived-evidence.md)。后续 README 修订属于文档变更，不改变这份执行记录绑定的 `ff22b577`。

本 checkpoint 将 Canvas 单一所有权、被动帧观察、typed target staging 与 Web remote 倍率事务整合到 `9354c828`。格式和严格 Clippy 通过，完整 workspace 2173 项通过、0 失败、11 忽略，75 项必选全通过；独立 release CLI、完整 WASM/Worker 和三组真实浏览器用例通过。DOM 查询有 15 组证明，DOM/Skia 各完成 12 次更新、13 个 Worker 关闭；Skia 40 项 live context 检查零 finish/readPixels/整页 RGBA，但完整生命周期仍有 19 次退役 finish。Remote 倍率/FPS 不重复求值和预算拒绝后交互通过。原始结果及失败历史见[本次证据](../archived-evidence.md)。

实际驱动为 SwiftShader，不授予硬件、性能、官方或七宿主通过。下一步仍是逻辑 resize 补偿、font mutation 和 backend-neutral coordinator；Windows/Linux GPU、七宿主 WebView、混合组件及设备门禁继续保留。

后续 `e96e7095` 已整合真实页面 paint-ready 准备、私有完整宿主环境安装、锁外 Web 容量预留，以及开发 Raster 精确票据与倍率共同发布的基础边界。该版本的格式、软件渲染、无原生引擎运行时、双原生引擎且无 Skia 的独立检查通过；完整工作区在执行预算测试中有两项失败，Clippy 未启动。两项旧测试仍以可被应用覆写的全局同步函数制造超时，与新的私有安装入口不符，并随后调用未定义的 `finite`。原始失败、52/76 必选实际执行结果与未启动项保留于[本次归档](../archived-evidence.md)；更早的无原生引擎 fixture 失败独立保留于[前次归档](../archived-evidence.md)。这些记录不授予完整工作区通过。真实 Web owner／SSE／RAF 精确回执仍未默认接线，逻辑尺寸的事务修复继续在独立候选中审查；冻结的 279 项发布门禁保持原状。

后续预算 fixture 修正后的 `bc9ce7d8` 完整工作区回归通过：2250 项通过、0 失败、11 忽略，76 项必选全部通过；独立执行预算为 29 项通过、1 项原有 helper 忽略。该次严格 Clippy 因一处 `Option` 替换写法失败，原始结果保留于[工作区归档](../archived-evidence.md)，更早的单项 capability fixture 失败另存[预算归档](../archived-evidence.md)。仅将该写法改为等价的 `Option::replace` 后，`3148a124` 的格式、完整渲染器库 259 项测试及全工作区／全部 target／全部 feature 的严格 Clippy 全部通过；未为这一行等价修正重复完整工作区，两个源码版本的结果分别绑定，见[修正验证](../archived-evidence.md)。本轮未新增浏览器、GPU、设备或性能通过。

远端 `8164aa21` 的两份 CI 共有 13 项失败、3 项跳过；13 项失败均因 GitHub 付款或支出限额条件而未启动，未分配 runner、没有执行步骤。[原始记录与分诊](../archived-evidence.md)仅说明这两次历史执行的基础设施阻塞，不能作为新源码的编译或测试结论。逻辑 resize、共享预览及实际 Web Raster 精确回执仍按后续 checkpoint 推进，279 项发布门禁保持原状。

后续 `f07d0d5d` 完成逻辑尺寸调整和共享预览发布边界：先更新宿主几何并执行一次应用回调，再准备新布局与实际像素，最终与 Web 缓存共同接受。失败保留旧画面及已发生的 JS 副作用；几何补偿不会覆盖独立宿主信息，新页面、资源或生命周期变化会使旧候选失效。倍率重绘保留原来实际消费的数据版本，普通帧观察保持只读。

该固定源码的六项本地门禁全部通过：格式、严格 workspace/all-targets/all-features Clippy、软件 renderer、两个 runtime 特性组合与完整 workspace。完整工作区为 **2291 项通过、0 失败、11 项既有忽略**，原方法的 140 项工作区必选用例全部唯一通过。各特性组合的结果有重叠，不相加作为独立覆盖。原始 r4/r5/r6 失败、r7 成功、源码快照、日志哈希与全部自有进程组退出记录保存在[本轮归档](../archived-evidence.md)。

远端 `9a7a3873` 的两次 CI 同样因付款或支出限额条件而未启动，未分配 runner 或执行步骤；这与本地通过结论分开记录。上述验证只绑定 `f07d0d5d`，不覆盖后续实际 SSE 绑定、二进制 v2、strict HTTP 与新浏览器入口。没有新增真实浏览器、硬件 GPU、官方、设备或性能通过，冻结的 279 项发布门禁保持原状。

后续 `2ad61746` 增加显式 ticketed Raster HTTP/SSE owner、二进制 v2 帧、精确运行时票据及独立的实验浏览器入口，普通 CLI 和默认 CanvasKit/DOM 路径保持原入口。该源码的格式、严格 Clippy、软件 renderer（213 项）和无原生引擎 runtime（344 项）通过。双原生引擎且无 Skia 的运行时库为 **404 项通过、1 项失败**：非性能生命周期 fixture 在 `app.init` 的冷 View 准备阶段耗尽默认 50 ms 预算，尚未进入待测滚动断言；其后外部 harness 与完整 workspace 均未启动。原始失败、全部未运行门禁、源码快照与进程退出记录见[失败归档](../archived-evidence.md)，不能作为完整工作区通过。

随后 `95b06293` 为 Raster 客户端增加专用 HTTP 排队收据边界，完整响应只从当前 SSE 连接进入。冻结源提交 `926ef15` 的 49 项 Node 合同通过，六个执行文件与该主仓提交字节一致，见[独立证据](../archived-evidence.md)；它不替代上述 Rust 失败，也不授予真实浏览器、GPU、设备或性能通过。冻结的 279 项发布门禁保持原状。

`a8a4d8ec` 增加可配置的有限 `SessionConfig.view_execution`：省略时仍为 50 ms，显式值限制为 1–86,400,000 ms，并继续受剩余 AppService turn、bridge deadline、frontier 和取消约束。开发 Raster 的非性能生命周期 fixture 显式采用 2 s 预算；生产默认值及性能验收门槛没有调整。新增六项策略测试已分别在无 native 引擎和双 native 引擎组合唯一通过，但没有因此获得完整 workspace 通过。

该源码的 R3 使用保留全部旧必选顺序的 R10 方法：格式、严格 Clippy、软件 renderer（213 项，13 项必选）和无 native 引擎 runtime（350 项，47 项必选）通过。双 native 引擎且无 Skia 的五个 harness 分别为库 411 项通过、AppService budget 30 项通过及 1 项原有 watchdog helper 忽略、组件 15 项通过、宿主几何 7 项通过、触摸 12 项通过及 **1 项失败**。失败的必选 `developer_owner_retirement_error_consumes_every_lease_and_preserves_set_data_effects` 在 `touch_capture.rs:733` 预期预览退休返回错误，却收到成功；该步骤 80 项必选中 79 项唯一通过。完整 workspace 及其 217 项必选 **未启动**。使用同一原始二进制的[孤立 control](../archived-evidence.md) 也在同一断言失败，保持独立证据，不能覆盖套件失败。原始日志、零字节格式日志、源码快照及全部自有进程退出记录由[本次失败归档](../archived-evidence.md)管理；旧 `2ad61746` 的 R1/R2 失败保持原样，R3 不代表完整回归通过。

独立 Worker 渲染家族切换候选 `0698320a` 的注入式 Node r3 为 **134 项通过、0 失败、0 跳过**；其后 `a969c253` 的 post-assignment 合同扩展 r4 为 **135 项通过、0 失败、0 跳过**。此前 `72cab8b8` 的 132 项中 6 项失败、`d8d6208c` 的 133 项中 1 项失败均完整保留。四份结果各自绑定候选源码，不相加为独立覆盖；候选未进入上述 `a8a4d8ec` 的 Rust 回归，新增两项 native QuickJS 测试定义尚未编译执行。这些仅是注入 Worker/native transport 的协议合同，没有执行真实 Rust/WASM、Worker 产品入口或浏览器呈现，不证明同 session 渲染器切换产品接线、硬件、性能或七宿主通过。冻结的 279 项发布门禁保持原状。

本 checkpoint 的 `1dbbec38` 已通过六项完整本地门禁：格式、严格 workspace/all-targets/all-features Clippy、软件 renderer、无 native runtime、双 native 且无 Skia runtime及完整工作区。工作区为 **2,382 项通过、0 失败、11 项忽略**，231 项必选全部唯一通过。生产 View 默认仍为 50 ms；只有非性能测试 fixture 显式采用有限初始化预算。

同一产品源码的 release WASM 静态入口已在一个真实 Worker 内完成 DOM／Skia 切换、输入、返回、resize／2× 与关闭检查。后续 `6d15d84f` 只增加测试采样修正、示例和文档，Rust 源码未变；三组 Node 回归及 all-features release CLI 通过。[双渲染开发示例](../../examples/apps/dual-renderer-app/README.md) 使用真实固定编译器 watch 和 portable pack，在 QuickJS、V8 remote 开发循环中分别通过页面实例、共享存储、同一 App 定时器和严格呈现版本检查。每次在两个指定端点捕获 65 个完整响应，退出前无读取错误或在途请求。

本地 `58730` 预览已更新到该固定 release，并经实际 CUA 点击确认 modern View 的 Update 2、共享 ESM 2/2 和 750×1334 输出。旧标签已不存在，本轮创建并保留一个最终预览页。原始失败、取证脚本修正、精确源码／产物及资源归属记录见[本轮证据](../archived-evidence.md)。自动化浏览器使用 SwiftShader，截图诊断含显式 readback；没有新增硬件 GPU、性能、官方或七宿主通过，279 项发布门禁保持原状，goal 继续 active。

启动方法见 [模拟器文档](../simulator.md)。默认 Web remote 需要先准备固定的 CanvasKit/font 资源；缺少资源时不会下载或降级为软件。

## DOM 文本控件基础里程碑

DOM 路径新增真实 input／textarea、标量与选区预检、按语义身份恢复本地编辑、
焦点和滚动，以及恢复焦点不重复上报业务事件的边界。runtime 从已接受文档校验
禁用控件及有界 UTF-16 编辑事实，整批验证后才调用实际 Page handler。
可直接构建的 [文本控件示例](../../examples/apps/text-controls-app/README.md)
保留真实 focus／blur 中的 setData，不用移除业务回调规避反馈循环。

本轮 Rust 源码的完整 workspace 为 **2,387 项通过、0 失败、11 项既有忽略**；
格式及严格全 target／feature Clippy 通过。最终 DOM 资产另经真实 Chromium 的
12 项 presenter 检查，以及固定 weapp-vite 产物在 native QuickJS／V8 中各 15 项
实际 runtime 浏览器检查。两个 runtime 报告的 page-ready case 各保持 unknown，
因为该示例未插桩 ready；测试显式调度呈现，不宣称自动 watch 或 Worker 产品入口
已执行本示例。多行填充逐条核对原生 input、wire 消息和 Page 回调，而非假定
一次自动化操作只产生一个原生事件。

本轮仍整份替换 iframe／Document，不能连续保留跨重绘的真实中文 IME；处理器
返回字符串覆盖值及官方完整非冒泡语义也未完成。边界见
[文本控件契约](dom-text-controls.md)。原始失败、测试源码与后续滚动修复的版本
区分由[专项归档](../archived-evidence.md)管理。
没有新增官方、硬件、移动键盘或性能通过；冻结的 279 项发布门禁保持 unknown，
原 `58730` 预览服务未因本轮验证而替换。

## Worker 原生输入生命周期接收加固

`8c4c4593` 将 `inputLifetimeRevision` 保留到 scheduler demand，并纳入 DOM adapter
和 scheduler 的硬输入边界。已建立的 token 回退、消失或耗尽会先撤销旧输入权限；
同一 token 的普通数据更新保持原有行为。真实 Worker 生产者原本就同时推进
surface generation，本轮没有复现或宣称修复 native hide→show 缺陷。

最终 Node r3 为 Worker **1,070 项通过**、Web WASM **517 项通过／2 项既有跳过**、
WebView **195 项通过**。该固定源码的 release QuickJS/WASM 构建通过，受检源码干净且起止一致；
显式 DOM adapter 浏览器 harness 的 3 项真实用例覆盖输入→setData、hide/show
最终观察撤销旧 key，以及新最终 ACK 后输入恢复。旧输入是在 Worker dispatch 前
被拒绝，不能把它记成 Rust 内部回调拒绝证明。自有 Worker、浏览器和临时服务全部关闭。

浏览器首轮因旧测试工具的资产清单漏列 input ledger 而在启动前失败；`293ad21`
改为共享构建清单后，保留每文件哈希检查并通过真实浏览器重跑及 Web WASM 回归。
WASM 与 staged browser 源码仍绑定 `8c4c4593`；测试工具修正单独绑定，未伪报重建。
原始失败、成功、源码和清理见[本轮证据](../archived-evidence.md)。

跨呈现中文 IME 仍未实现；[稳定原生编辑设计](native-editing-continuity.md) 定义了
后续 persistent Document、文档 permit、live geometry 最终接受和有限 editing lease，
目前只是待实现提案。没有新增产品 watch、官方、硬件、其他宿主或性能通过。
279 项发布门禁保持 unknown，goal 继续 active；现有 `58730` 预览未替换。

## 已实现的 DOM 事务边界

基础 DOM `button` adapter 已新增：真实 native button、受限外观属性、保留子树、
disabled 祖先输入栅栏、loading 与基础 ARIA；宿主特殊能力仍明确拒绝。实现与 Node
合同的边界见 [DOM button 基础适配](dom-button.md)。专项 `--fixture button` 已在
controls 集成 r6 通过真实浏览器原生输入与重建退休验证；下文历史 fixture 的失败保持原样。

以下共享边界已有代码与针对性验证入口，不表示所有 WebView 能力或宿主验收完成：

1. DOM 准备复用已求值模板与组件文档，跳过 Rust WXSS 级联、图片光栅缓存、Taffy 布局、Skia 页面 commit 和像素 readback。它仍执行真实 View 程序，不能以静态 DOM fixture 代替。
2. 独立 `PresentationKey` 绑定 session、page、document revision、presentation revision、surface generation 和 profile；协议中的 u64 使用十进制字符串。准备、许可、浏览器提交和最终 ACK 分开，HTTP 排队收据不能提前触发 ready 或开放输入。
3. runtime 从已求值 `ViewDocument` 建立权威事件拓扑；浏览器提交 occurrence target、坐标、触点与其他事实，不能指定 handler、传播路径或组件 owner。批次先验证，每个事件的导航和数据副作用在后续事件前生效。
4. `view.geometry` 保存浏览器实际布局，校验完整 occurrence 集合及 epoch。DOM SelectorQuery 提供受显式 recipient 协商的异步 partial 实现，已通过对应 native 回归及 controls r6 真实浏览器 fixture；查询测量水位与输入几何授权分别验证，不等于完整微信 SelectorQuery 兼容。IntersectionObserver 和滚动命令 adapter 仍明确 unsupported。媒体查询单独使用宿主有效的逻辑宽高；它不等待 DOM 首帧或读取旧 Skia 几何。
5. pending/accepted 文档与资源按事务保留，manifest、resize、页面及应用生命周期等变更撤销旧授权。准备阶段已经发生的组件/JS 副作用不承诺回滚；旧画面可保留，失效输入须阻断。页面 `inputEnabled:false` 也不等于交互验收通过。
6. 内容寻址图片通过独立资源接口传输，以完整 `PresentationKey` 和声明的 SHA-256 授权；内部脚本或样式 blob 不因知道哈希就开放给浏览器。传输端仍须独立执行资源预算、迟到请求和连接清理规则。

运行时在复制根页面数据时捕获 `BrowserPageInput`，随候选文档与已呈现文档保留；它与 `ViewDocument.revision` 独立。开发模拟器以这份实际消费版本判断是否还需重绘：触摸取消后的重读被正确记录，后续组件及 ready 写入仍会触发下一轮。显式 `render.data`、开发预览及不同逻辑视口不冒充当前页面的自动渲染结果。快照只是本地调度信息，不能替代呈现许可、可见性 lease 或异步几何授权。

媒体查询保留共享 observer 的注册、批量回调及生命周期契约；页面隐藏时订阅保留，可继续接收宿主逻辑尺寸变化，组件销毁、页面卸载或显式 disconnect 后清理。无有效宿主尺寸时保持等待，倍率、DPR 和显示缩放不被当作逻辑尺寸变化。此行为尚不等于官方 oracle 验收。

事务、取消、迟到 ACK、资源释放及慢通道故障由专项测试管理。实际 browser smoke 的 `passed` 仅限该报告绑定的源码/二进制与已执行检查；未观测的生命周期、有效图片传输、连续滚动或性能行为不能从一次点击结果推导。

## Worker 呈现基础边界

Worker 已增加可选的 ordered-observation 与 external-presentation 协商：前者保留运行时所属线程分配的 sequence、逻辑 surface generation 和不可复用的输入生命周期；后者返回具体帧实际消费的页面数据版本、物理目标尺寸及真实最终 ACK。倍率重绘保留消费版本，ready 后的数据变化不会倒写旧帧来源；故障、退后台、页面往返和逻辑 resize 则撤销旧输入授权。协议见 [ordered observations](../worker-ordered-observations.md) 和 [external presentation](../worker-external-presentation.md)。

纯 [presentation scheduler](../worker-presentation-scheduler.md) 合并最新需求，并区分模板执行与只重绘。DOM client 提供 prepare／present／release 分阶段入口；取消和关闭等待实际 population、图片解码、资源租约及异步 disposer，超时保留 pending 状态。真实 iframe RAF 取消 smoke 使用后台 Chromium，测试资源已清理。

静态 Web 构建的默认 `index.html` 现已接入 `worker-app.mjs` 和异步 `WorkerWebSession`，由一个 Dedicated Worker 执行 QuickJS；Window 按已校验 manifest 使用 DOM 或 CanvasKit。精确 pack-index、生成 glue/snippet 闭包与固定 Acorn 解析器字节均在构建阶段校验。旧同步 `app.mjs` 保留在显式 `--execution legacy` 的入口。运行时 ready 与实际最终呈现分别等待，倍率重绘不重放 View，逻辑尺寸变更使用同步输入栅栏。新增 owner、适配器、admission、入口和构建器合同已在最初集成时的生产源码上通过 1,057 项检查。真实默认入口验证另由 [Worker 产品证据](../archived-evidence.md) 记录；合同和独立 Worker 探针不替代该验证，该静态产品阶段当时尚未开放开发 CLI 的 browser watch；当前受管入口见下文。

真实默认入口随后暴露并修正了 Worker 首条加载消息的监听竞态，以及 CanvasKit 在高密度下把物理尺寸当作 CSS 盒尺寸的问题。修正后的 287 项定向检查通过；最终后台浏览器在两份干净 release WASM 静态站上验证了 DOM/CanvasKit 实际点击、AppService 状态与像素变化、resize、倍率、前后台和关闭。CanvasKit 的 400×700 逻辑盒在 2× 后仍保持相同 CSS 尺寸，800×1400 backing 上的点击正确。全部失败尝试和最终资源清理保留在产品证据中；硬件 GPU、性能、同 session 家族切换和 watch 不据此授予通过。

此前呈现合同阶段的完整工作区／全部 feature 回归为 1,739 项通过、0 项失败、4 项忽略，557 个受检查源码文件在执行期间未变；格式检查及全部 target/feature 的严格 Clippy 通过。定向 Rust 检查为 382 项通过、1 项忽略；Web／Worker 合同为 411 项通过；Web 构建与输入等补充合同为 412 项通过、2 项缺省依赖路径跳过，显式使用固定依赖的 CanvasKit CPU API 套件随后 233 项全部通过；manifest 为 136 项通过。数字覆盖范围重叠，不相加作为独立验收覆盖。最终源码绑定及后续真实产品验证分别记录在 [呈现合同归档](../archived-evidence.md)。冻结的 279 项发布门禁未因此升级。

## 浏览器开发态构建边界

监督器新增 `DevPackConsumer::BrowserWorker`，只构建和校验 portable pack，不创建 native `HostSession` 或执行 AppService；`PortableReady` 与 runtime/presented ready 分开。发布屏障强制刷新编译回执、配置及现代依赖，并检查合法 raw 源码修改，绕过日常 watch 防抖；失效 token 不得覆盖新错误，旧 pack 仍保留。该基础阶段未接入 browser CLI；后续实验入口另见下文。

新增可复用 runtime bundle／pack generation helper，保留独立 pin 的 clean Worker producer 原始报告和源码字节，重新验证 pkg、Acorn、WASM exports、renderer 与资源清单。app-only generation 不执行 Cargo/bindgen，不重新执行 AppService，也不授予发布或呈现权限。输出创建前校验 canonical 目录，输入以有界读取捕获到私有 snapshot。接口与限制见[开发态构建资源](browser-dev-artifacts.md)。这些构建边界不代表 browser watch、七宿主或性能门禁通过。

本次基础变更的完整 Rust 工作区／全部 feature 回归为 1,748 项通过、0 项失败、4 项忽略，576 个受检查源码文件在运行期间未变；格式及全部 target／feature 的严格 Clippy 通过，最终 Web／Worker 合同为 481 项通过、0 项失败、0 项跳过。真实 clean release runtime 完成 retain/open 和三份 app-only generation 的复用验证，未执行新的 AppService、Worker、浏览器或 watch。原始失败、通过结果和精确源码绑定见[构建基础证据](../archived-evidence.md)；冻结的 279 项发布门禁保持原状。

开发监督器现可显式准备独立 pin 的 runtime producer：在自己的有限作业中读取固定工具和产物，校验原始回执，通过有界共享资源借用提供字节，并在借用释放后重试清理原 owner。实际 software／CanvasKit 两个静态消费者验证了 64 个共享字节借用、在途借用阻止清理及释放后的目录删除，原 producer 文件树在执行前后相同。该阶段未重建旧 producer，`runtimeReady`、`presentedReady` 均保持 false，当时尚未接入 stage、HTTP 或 browser watch。完整工作区／全部 feature 为 1,876 项通过、0 项失败、6 项忽略；592 个受检查源码文件执行期间未变，格式与严格 Clippy 通过。[静态准备证据](../archived-evidence.md)保留原始失败和最终提交绑定，不授予 Worker、GPU、七宿主或性能门禁通过。

## 受管输入与静态站点

固定编译器 watch、不可变 raw generation 和 portable 打包进程已复用原 aggregate 账本；writer-done ACK 或同一 watcher 的真实进程树屏障解除写入权。构建失败保留旧 pack，容量恢复复用同一个 compiler context。该阶段的[受管源码证据](../archived-evidence.md)保留 1,904 项 Rust 执行结果，同时明确记录：workspace 记录器因执行期间 CI 测试参数变化而失败，不能当作起止源码一致的通过。

当前新增显式 `managed_browser_stages` 库入口，将实际 portable 与 retained runtime 的原始租约交给真实有限 `stage-pack` 作业。两个站点槽与运行时、raw、portable 共用原账本及唯一有限作业槽；输出被借用时，退休站点继续占槽并阻止父目录清理。receipt 核验实际请求、completion、run/ticket、startup 原字节哈希、manifest、blob 和完整文件清单。构造失败保留原 recovery 并报告实际原因，输出损坏保留同一清理 owner；不会以新建 owner 代替失败状态。

真实 software 与 CanvasKit 两份独立固定 producer 已分别通过静态 watch 用例：WXML 更新、JS 构建失败保留旧站点、跨 run 拒绝、65 次同语义不同原始 startup 字节拒绝后正常构建、已有目录不被接管、退出码为零但输出被篡改的拒绝、第三站点在建目录前拒绝，以及借用阻止退出和释放后的清理。两份 producer 与本地 compiler dist 均保存前后完整文件树哈希。这些是静态产物与生命周期检查，未执行新 Worker、HTTP、浏览器、GPU 或设备验收。接口见[受管 portable 到静态站点](browser-consuming-stage.md)；`runtimeReady`、`presentedReady` 继续为 false。

该阶段的最终源码通过模拟器全部 feature 回归：420 项通过、0 项失败、4 项忽略；严格 workspace／全部 target／全部 feature Clippy、格式、37 项 Node 合同和 136 项 manifest 检查通过。669 个受检查源码文件在各次最终验证中一致。历史全工作区 1,940 项通过、8 项忽略发生在三处私有结果布局的 Box 修复之前，原始字节及精确 diff 保留；修复后重跑受影响的模拟器与两份真实静态 stage，未把历史工作区结果重新标为最终源码通过。完整记录见[受管站点证据](../archived-evidence.md)。

## 静态站点的 HTTP 传输

`WebSurface::bind_resource_only` 已将静态资源接到实际 HTTP 队列；`poll → resolve_resource_requests → wait` 在同一 owner lane 完成原身份匹配与资源借用。runtime、pack、site 使用独立的不可变 URL 命名空间，严格检查原 GET/framing，不继承旧入口的 wildcard CORS，也不开放旧 UI、bridge、SSE 或控制 mutation。普通 WebSurface 路由保持原有行为。

实际 response 直接持有非 Clone 的原 runtime/stage borrower，写出只借用原字节；artifact payload 仍占原费用，HTTP 仅增加小 header。待 owner 解析的请求也计入原 64 连接上限，从 accept 到最终写出共用原 5 秒截止时间；公平写出、断连、过期和 surface 释放沿用原队列。退出先释放 HTTP socket/body，再重试同一个监督器的清理，不能让自己的在途借用阻止原 owner 退出。

可运行示例 `serve_browser_stage` 支持 loopback 端口和可选服务时长，先通过真实 preparation/stage 路径捕获资源，再提供固定站点的诊断字节。ready JSON 明确保持 `runtimeReady:false`、`presentedReady:false`、`publicationAuthorized:false` 和 `sourceFreshness:"not-checked-after-stage"`。stage 后继续观察 watcher 事件但不更新这个 site，也不重查其可发布性；后续源码变化、构建失败或新 portable 不能使旧 URL 获得当前发布授权。接口、参数与精确 allowlist 见[静态 HTTP 合同](browser-static-http.md)。

本 checkpoint 已确认格式检查、workspace 严格 Clippy 通过；模拟器 library 检查为 372 项通过、4 项忽略。software／CanvasKit 两份独立固定 producer 随后分别通过同一真实 managed runtime + stage → TCP exact 用例，各 1 项通过、0 项失败：验证原字节、8 MiB body 回压、断连释放、实际 5 秒 deadline 与同一个监督器的最终清理。deadline 指标采用第二个 stage 首次被观察到退休的耗时，包含 poll/清理延迟，不是精确的 body drop 时间。这些是实际 HTTP 资源与租约生命周期结果，未执行 Worker、浏览器或 presenter；完整命令及原始结果见[静态 HTTP 证据](../archived-evidence.md)。

该静态 HTTP checkpoint 当时仍需连接 Worker owner manager、发布前 source barrier、HTTP 控制适配器和实际呈现回执。HTTP 发送完成不能充当控制 final 的客户端 ACK，断连或超时也不能证明 Worker 已关闭。该阶段的 CLI browser 模式仍拒绝，冻结的 279 项发布门禁保持原状；该阶段未授予 Worker、browser watch、GPU、设备或性能通过。

控制收据新增绑定原请求和原 final 字节 SHA-256 的 ACK 入口，复用同一账本及原 borrower 屏障，区分首次压缩、幂等重试和 retired/unseen。manager 增加可选 `control.acknowledge`，只在采纳并保留 final 后发送；每 command 一项实际请求、有限全局在途量，状态计数为常数时间，显式重试按原 command iterator 限制扫描量。ACK 故障不重执行 mutation，也不阻止必要 owner close；`close/recover/status` 仍报告未完成 ACK 与 `transportDrained`。该 ACK 阶段尚无 HTTP 控制路由，原始 body 关联与实际网络清理当时待 transport 接入。详见 [ACK 合同](browser-control-ack.md)。

控制 ACK 阶段在同一份 673 文件源码上的定向检查：Rust 控制账本 35 项、manager 63 项、Web 构建合同 98 项通过，格式检查及 workspace/all-target/all-feature/locked strict Clippy 通过。manager 的 transport、DOM、RPC 与 presenter 为 doubles，构建合同使用受控工具；该阶段未重新运行完整 workspace/simulator 测试，也没有新增实际 HTTP 控制、Worker、浏览器或 GPU 证据。原始日志与源码绑定见 [ACK 证据](../archived-evidence.md)。

新增独立 `BrowserDevHttpControl` 客户端，保留原请求字节与 raw-final SHA，以原 parsed 对象关联 ACK；禁止自动重发 mutation、自动 ACK 和静默逐出。普通 invoke、cleanup invoke、精确 replay/recovery、ACK 使用独立的有界工作预算，entry 接纳时预收 final，普通/ACK 饱和不能挤占清理或恢复预留。取消信号的可重入属性访问在 actual job 与 ACK promise 登记后执行；关闭等待真实 fetch/hash/reader/relay 结算。该客户端阶段未接入生产 HTTP owner、预览鉴权或 bootstrap，未进入固定 Worker bundle，browser CLI 当时保持关闭。协议和容量见 [HTTP 客户端](browser-control-http.md)。

HTTP 客户端阶段的最终 677 文件源码通过模拟器全部 feature 回归：439 项通过、0 项失败、6 项按原条件忽略；新增真实 TCP 用例另行 opt-in 执行，1 项通过、0 项忽略。客户端 54 项、manager 63 项和受控 Web 构建 98 项合同通过，格式检查、脚本语法与严格 workspace Clippy 通过，各次所选记录的起止源码一致。真实 TCP 将客户端接到原 Rust ledger/coordinator，验证错误鉴权拒绝、原 Arc final、丢失回复后的重放、held body 阻止 ACK、精确 hash 与丢 ACK 后幂等；它使用隔离测试 listener 和形状测试 pins，不是生产 WebSurface 鉴权、实际 Worker/pack/呈现或 GPU 证据。详见 [客户端证据](../archived-evidence.md)。发布清单仍为 279 项 unknown。

生产 `WebSurface` 新增首次 accept 前显式启用的控制队列。trusted context 固定实际
监听地址、run/client、Origin 和 secret；严格 POST framing 在旧路由、OPTIONS/CORS
之前检查，已知静态资源仍走原 GET owner lane。请求只借给串行 resolver，final 移动原
ledger Arc 到实际响应，HTTP 只额外记小 header，接纳到写出共用原 deadline 和公平 writer。
停止接纳及 socket 排空状态与 listener 端口释放、ACK 交付、Worker close 分别表示。
该控制服务阶段的 seam 尚未连接实际浏览器 owner、source barrier、preview bootstrap 或 Worker
关闭关联，browser watch CLI 当时仍关闭。详见 [HTTP 控制合同](browser-control-http.md)。

该 seam 的最终 680 文件源码通过完整 simulator/all-feature/locked 单线程回归：475 项
通过、0 失败、6 项按原条件忽略；其中新增 19 项真实 loopback TCP 与 17 项 parser/auth
用例。格式、215 项客户端／manager／受控 Web build 合同和 workspace/all-target/all-feature
严格 Clippy 通过，各次起止源码一致。[控制服务证据](../archived-evidence.md)
保留首轮、最终日志及独立源码审查。TCP 使用原账本与形状 fixture pins；near-expiry
测试注入时钟并等待短回调，不冒充真实五秒观测。未运行实际浏览器 owner、Worker
替换闭环或七宿主／GPU／性能验收，279 项发布门禁保持 unknown。

后续新增 `BrowserDevOwner` 串行库入口，持有原监督器、coordinator、控制账本和最多两个
stage 元数据，将即时 source barrier、真实静态 stage、HTTP invoke/replay/ACK 与原资源
借用接在同一个 owner 上。启动许可在 final 发送前保护 exact owner／site／actual stage；
重放保持纯读取，未保留 final 只能由原 ticket 恢复或封存不确定，不能重新执行命令。
初始化失败返还原监督器；停止重试继续清理未保护 replacement，并等待原 borrower。
该串行 owner 阶段固定使用 `NoActualBrowser`，拒绝全部成功 close 报告；实际 elected manager／Worker
关闭关联、bootstrap 与 browser watch CLI 当时未交付。接口边界见[控制 HTTP](browser-control-http.md)。

该串行 owner 的最终 683 文件源码通过完整 simulator/all-feature/locked 回归：475 项
通过、0 失败、7 项按原条件忽略；215 项 Web 合同、格式和严格 workspace Clippy 通过。
两份独立固定 producer 的真实 managed compiler／portable／stage → 原 owner → TCP
专项分别显式执行，覆盖原 final 重放、ACK、Prepared final 的纯重放与显式恢复，以及
原 body 借用阻止同一 owner 提前清理。Prepared 状态由原账本显式注入，不冒充自然
故障；这些静态测试没有 Worker、浏览器呈现或 GPU。原始尝试、最终执行与提交绑定见
[串行 owner 证据](../archived-evidence.md)。279 项发布门禁未升级。

关闭回执现携带真实 session 已捕获的 RPC epoch／session 和可空的 pack owner tuple；
Rust 使用版本化 typed receipt，显式区分字段缺失和合法 null。manager 等待原构造与
关闭 barrier，核对原 site 和每个已知 tuple，才上报 browser-reported finishClose。
构造前取消、已构造但未 load、RPC 已创建但尚未 admission，以及 admission 后 load
未就绪均有独立边界；null owner 不再可能冒充 never-constructed。该回执 slice 的成功报告服务端
授权仍关闭，bootstrap、实际 manager／Worker 关闭闭环与 browser watch CLI 当时未交付。

此 slice 的完整 simulator/all-feature/locked 回归为 482 项通过、0 失败、7 项忽略；
Worker／manager／HTTP 客户端／构建合约合计 666 项通过，格式和严格 workspace
Clippy 通过。它们不运行新闭环的真实
Worker／浏览器／GPU，不升级原发布门禁。原始开发失败及最终源码绑定另见
[关闭身份回执证据](../archived-evidence.md)。

## 实验 Browser 开发循环：真实有限 watch 已验证

独立 `serve_browser_dev` example 已连接同一个监督器、串行 owner、鉴权控制与开发 UI，
浏览器主线程负责 DOM 呈现，真实 Dedicated Worker 负责 QuickJS AppService/View。
`observe` 仅轮询原 owner 的状态；新 stage 必须经过原控制 final、Worker 启动和实际呈现，
才能开放输入。Stop 先关闭原 manager/Worker，再排空 final ACK 和客户端 transport；
服务端等待同一 owner 的关闭屏障、ledger 清理与 HTTP drain，不以静默或断连代替。

最终真实尝试 r5 完成七步开发循环：独立 producer 校验、原服务启动、A 的 Worker/DOM
就绪、真实点击引发 `setData`、WXML 更新为 B 并关闭 A、编译失败后 B 继续交互，以及
UI Stop 后原 Worker/浏览器/服务退出。两个实际 Worker 的 realm、关闭事件和 terminate
调用分别记录；原 owner 关闭、ledger ACK 和 HTTP drain 完成，原服务退出码为 0。
正常 INFO 诊断不再伪报 `ERR_ENGINE`。r1–r4 原样保留，其中 r4 的历史通过不授予
最终源码事实。源码、测试、实际二进制和浏览器报告的关联见
[开发循环证据](../archived-evidence.md)。

最终模拟器全部 feature 回归为 506 项通过、0 项失败、7 项按原条件忽略；Worker 合同
614 项通过，Web 构建等合同 495 项通过、2 项缺省依赖路径跳过，显式固定依赖的
CanvasKit CPU API 为 233 项通过，manifest 为 138 项通过，共享 WXML 的 Rust
定向合同为 1 项通过。各所选执行记录的 688 文件源码清单起止一致；这些覆盖有重叠，
不能相加作为官方验收比例。格式检查、脚本语法和全部 target/feature 的严格 workspace
Clippy 均通过；这些是当前平台的源码检查，不替代七宿主实际运行。

早期 checkpoint 的打包器已经保留 `button` 的文本、嵌套绑定和事件，但当时尚无
DOM `button` adapter；真实 r3 在 runtime-ready 后因此呈现失败，原证据保持失败。
当前源码已加入受限的原生 DOM button 适配：文本、外观、disabled、loading、焦点及
原生点击/键盘激活，并显式拒绝未支持的属性、事件和交互子控件组合。其专项真实浏览器
执行必须单独绑定源码和结果；历史 `view + bindtap` fixture 的通过不能代替 button 验收，
也不授予微信完整 button、宿主或冻结清单通过。

该实验 checkpoint 当时尚未开放普通 CLI。普通 `weapp-simulator dev` 随后复用同一个
Browser runner，显式选择 `web + quickjs + webview + browser` 并提供独立 producer/pins；
路由、初始数据和逻辑视口绑定不可变 startup intent。normal 同时保留预算仍有限，
已 ACK 前缀通过显式退休归还预算，serial high-water 不重置。硬刷新或页面丢失不能接管
旧 manager/Worker；无限可靠运行、崩溃恢复、现代 View 项目接入仍未交付。
普通 CLI 的无 native engine 构建已完成真实 headless 浏览器验证：12 次 WXML 更新、
13 个实际 Worker，逐代核对第二路由、初始数据与 `414×736` Worker/DOM 视口；
编译失败保留交互，Stop 后原服务与自有浏览器资源关闭。最终 simulator 为 536 项
通过、0 失败、7 项按原条件忽略，无 native CLI 为 5 项通过；Worker 合同 667 项
通过，Web 构建合同 495 项通过、2 项缺省依赖路径跳过，manifest 138 项通过。
相同 690 文件清单的格式、严格全 target/feature Clippy 与 submodule 检查均通过。
执行记录、失败历史与提交绑定见[普通 CLI 证据](../archived-evidence.md)。
详见[浏览器开发循环](browser-dev-loop.md)。七宿主、硬件 GPU、性能与官方 oracle
门禁未变，冻结的 279 项发布项仍为 unknown。

## Canvas 批处理与开发诊断

Canvas2D 先把完整命令批次校验为后端共用的 typed commands，native 路径省去原先仅为校验而丢弃的软件绘制。原生 CPU Skia 绘制与一次 RGBA 读回继续保留；这不表示 Canvas 已接入零读回 GPU 合成。共享 arc 准备接受有限 f64 角度，将方向、整圈与反向余数规整后才交给 f32 后端，避免极大角度的逐圈循环无法结束。其他坐标与数值参数保留原有边界，极大角度不承诺任意精度或官方像素等价。

开发面板现在接纳 runtime 的 `payload.errors[]`、单错误与失败 response，保留原 owner 归属以及有界的名称、来源和纯文本 stack。消息、名称／错误码与 stack 分别限制为 2048、128 和 8192 UTF-8 字节，单批和 UI 历史各最多 32 条，超量有明确提示。普通对象 getter 不参与诊断投影；引擎异常提取、业务 drain 与 source map 行为没有因此变更。

实现提交与本次 renderer/runtime 双配置、严格 workspace Clippy、格式及 Node 合约结果见[Canvas 与诊断证据](../archived-evidence.md)。本次没有执行新源码的真实浏览器或官方／设备／性能验收；上一个浏览器里程碑继续绑定其原提交，不能转移通过结论。

## 尚未交付的必需范围

Session 已通过 `SkiaPageBackend` 管理按需创建的页面 Skia 对象，只读宿主调用已迁移到 passive typed observation/status；目标 validation/staging 和当前 scene 重绘也有窄接口。Web remote 倍率共同接受、逻辑 resize 恢复及 Worker 同 session 渲染家族切换已由上文后续 checkpoint 交付，不再列为待实现。font mutation 及 backend-neutral coordinator 仍待完成。DOM SelectorQuery 的 partial adapter 和基础 button adapter 已实现；controls r6 在 `4f753cab` 上完成其真实 QuickJS Worker 查询与按钮用例，不能把该历史结果转移到后来源码。Remote 首次 `onLoad` 查询等待、DOM intersection/scroll adapter、button 的其余宿主能力仍待实现；Browser CLI 开放显式 QuickJS Worker + DOM/Skia 的受管原始源码 profile，DOM/Skia 有限真实开发循环已有上述绑定源码的证据，硬件与性能仍待验收。实验 example 保持 WebView，有限 watch 循环已完成其所选源码的真实浏览器验证，尚无无限运行或刷新接管。静态 Worker 导出已有默认产品入口，实际执行和发布门禁分别记录。开发 WebView 已接入 owner-thread 租约、主预览切换、只读镜像、独立编码资源服务和异步 ACK；每项实际 E2E 结果由绑定源码的报告给出，不能仅因接口存在而授予通过。Rust reload 预检覆盖 IR、资源与模板投影，浏览器特有的 CSS/解码失败仍可能发生在 manifest 接纳之后：保留旧图并冻结失效输入，不能称为完整浏览器预检回滚。GPU 配置失败也仍需完整的 pending/failed 配置回滚事务。

DOM 异步查询的前置边界采用两种引擎共用的同步 API 调用上下文。页面／组件生命周期、原生事件、自定义事件及 observer 回调在各自所属实例上下文中执行，嵌套调用和抛错后恢复外层上下文；上下文与用户函数的 `this` 分开。严格捕获只接受仍在实例表中的同一个对象，不从当前页补填归属；既有 observer 在上下文之外回退当前页的兼容行为独立保留。DOM selector 的 partial 实现已接入该归属边界；它不向任意 Promise／async continuation 自动传播归属。异步请求还校验 runtime 呈现版本、可见性、deadline 和取消。已执行的原生回归与 QuickJS Worker 测量 fixture 按实际源码保存在 [controls 集成证据](../archived-evidence.md)；Remote 启动等待、固定微信 oracle、七宿主及性能验收仍未完成。

SelectorQuery 的语法与有序树匹配已抽到 `container-core::selector`，Skia 通过只读 adapter 复用；observer 的语法检查不再构造空 RenderFrame。新增 `container-runtime::view_query` 直接读取已求值的 ViewDocument，单独表示查询用的 page 根，保留文档顺序和组件声明归属。它只负责匹配；新异步队列及浏览器 sampler 在其上增加真实测量、呈现授权和 JS 完成。只有显式连接的 recipient 可获 partial 能力，未连接宿主保持关闭；详见[DOM 查询边界](browser-selector-queries.md)。现有 SelectorQuery 子集与 WXSS 语法仍分别管理，提取本身不扩展 CSS 支持。

Windows/Linux GPU presenter、七宿主原生 WebView adapter、混合组件合成、真实 IME/video/camera/MapLibre、七宿主植入样例，以及全部硬件与性能门禁继续在目标内。缺少设备或 runner 的项目保持 unknown/blocked。该阶段不会发布 near-parity 或双渲染完成 tag。

## 本地验证记录

早先浏览器观测阶段的完整工作区、全部 feature 回归通过：1,660 项通过、0 项失败、2 项既有性能测试忽略，执行期间 2,167 个源码文件哈希保持一致；全部 target/feature 的严格 Clippy 和格式检查通过。新增 DOM 媒体查询及画面输入快照的专项回归为 55 项通过，浏览器协议契约为 84 项通过。后续只调整了两个 Node 命名策略文件，精确登记历史缓存排除路径，其 7 项策略测试及仓库命名检查通过，Rust 实现没有后续变化。[本轮证据](../archived-evidence.md) 保留原始成功、失败、源码快照和变更边界。

同一份全部 feature release 二进制完成 9 组真实浏览器开发循环：QuickJS/V8 各自的媒体查询、reference DOM、modern View DOM 和 DOM／CanvasKit 混合页面，以及 QuickJS modern View CanvasKit。各组源码在运行期间未变，浏览器、SSE、临时项目、模拟器进程和监听端口正常清理。双引擎开发二进制包含桌面依赖，不能拿它的整体大小判定 QuickJS 增量包体预算；这些功能结果也不授予物理 GPU、设备、性能或官方 oracle 门禁通过。

共享选择器与调用归属的 [历史阶段证据](../archived-evidence.md) 保留 1,647 项完整回归、原生及 Node VM 测试、235,520 次旧实现差分以及源码快照。该阶段提交 `724a54f3` 已通过严格 Clippy 并推送私仓。

此前完整回归的 1,616 项通过、10 项 View 超时失败、2 项忽略仍保存在 [开发循环证据](../archived-evidence.md)。生产 deadline 未放宽，本次未复现不证明已经修复超时根因。远端 Actions 对提交 `b20aa669` 的作业因账户支付／预算限制未开始执行，不能视为源码测试结果。live 服务的版本与替换结果另由交付记录管理。

[基础阶段证据归档](../archived-evidence.md) 保留成功与失败尝试及原始哈希。该历史阶段的完整 Rust 工作区回归 1,338 项通过、1 项性能取证测试按设计忽略；QuickJS/V8 呈现专项 4 项、全 feature Clippy 和 manifest 127 项通过。真实浏览器 remote reference/modern 示例及 macOS Metal 窗口完成了各自记录的功能观察。该归档中的 DOM 仅为独立合成输入测试；Android/iOS/鸿蒙为合约与 SDK 检查。这些历史结果不自动覆盖新增事务代码，也不更新冻结的官方、设备或性能门禁。

[提交后交付记录](../archived-evidence.md) 包含干净工作区 release 构建、现代 View 浏览器验证和本任务 live 服务替换结果。该服务已采用 CanvasKit remote；七宿主及 DOM 开发循环进度仍以上述边界为准。

本轮新增 `pnpm host:webview:test` 和 `scripts/dom-runtime-browser-smoke.mjs`；`modern-view` CI 已配置 reference/modern 两份真实 pack 与 QuickJS/V8 四个浏览器组合。CI 配置不代表远端执行通过。

[DOM runtime 事务证据](../archived-evidence.md) 记录工作区 1,379 项通过、1 项既有性能取证测试忽略，runtime 双引擎 570 项通过。最终格式及全 feature Clippy 通过，重建后的双引擎专项 36 项及四组真实 pack 浏览器测试通过。现代示例未插桩的 ready case 仍为 unknown；有效图片传输及性能等未观测范围也未授予通过。清理验证限正常完成与被捕获的异常，不覆盖信号中断、强制终止或崩溃恢复。归档保留失败尝试、最终构建 provenance、清理前后源码差异和提交后的源码哈希核对，冻结门禁保持未完成。

本轮开发监督器已取得六组真实浏览器功能结果：reference、modern View 分别在 QuickJS/V8 上通过 DOM 开发循环；同 session 的 DOM → CanvasKit → DOM 混合页面也在两种引擎上通过。四组 DOM 记录覆盖编码图片加载、点击、倍率不重复求值、resize、WXML/WXSS 热更新、构建失败保留、JS 重启、镜像、主预览转移和重连；两组混合记录覆盖页面状态保留、倍率切换期间的输入、旧输入拒绝及后续 watch 更新。报告保留失败尝试与所属浏览器、SSE、模拟器进程、监听端口和临时项目的清理结果，正常页面传输未使用整页 CPU RGBA。

这六份成功报告绑定同一 debug 二进制及构建源码清单，已包含页面实例身份、输入 epoch 和焦点修复；最终提交、release 构建及服务替换仍分别绑定交付证据。它们只证明所执行场景的开发功能，不授予硬件 GPU、性能预算、微信官方 near-parity、七宿主或 Web Worker 门禁通过。截图、WebGL context 和软件呈现也不能代替这些验收；未执行范围继续保持 unknown/blocked。
