<a id="browser-development-loop"></a>
# 浏览器开发循环

**简体中文** · [English](browser-dev-loop.en.md)


普通 `weapp-simulator dev --web-runtime browser` 和 `serve_browser_dev` example
现在复用同一个 runner：真实固定 `weapp-vite` watch、portable pack、受管 stage、
同一个 `BrowserDevOwner` 与浏览器开发 UI。当前明确支持 **浏览器 QuickJS Worker +
DOM/WebView 或 CanvasKit/Skia**，使用普通 CLI 显式选择 renderer。

默认 `auto + remote` 保持原行为。Browser 模式必须显式选择
`web + quickjs + webview|skia`，不会把 `auto` 静默映射为 renderer；也不提供 owner 接管
或恢复端点。Skia 必须使用独立固定的 CanvasKit Worker producer；WebView 可使用
software 或 CanvasKit producer，含 CanvasKit 依赖本身不证明实际执行 GPU 提交。
CLI 的 `--open` 可在原 owner 与
认证 UI 配置完成后打开默认浏览器；监听成功仍不等于 Worker 或画面 ready。

<a id="implementation-and-revalidation-of-state"></a>
## 实施与重验状态

Browser Skia CLI 和有界提交状态面板已接入；既有 DOM/CanvasKit 双路径记录见
[双路径执行证据](../archived-evidence.md)。下面的早期 DOM 记录
只证明各自绑定的源码和尝试。新增 selector、button、上下文恢复及集成验证必须保留
各自的原始执行结果，不能套用旧通过；硬件和性能仍单独验收，冻结的 279 项发布门禁
没有因此变化。

后续 [controls 集成 r6](../archived-evidence.md)
在 `4f753cab` 上完成查询、原生 Button 与 Skia 恢复三组完整真实开发循环，三组均通过。
查询有 15 组原始观测及独立输入几何／测量水位校验，Button 有 11 项交互检查；
每组均包含 12 次热更新、构建失败保留交互和 UI Stop 资源清理。历史失败及不同源码的
结果分别保留，SwiftShader 和完整生命周期的同步调用不被隐藏或当作硬件性能通过。

普通 CLI 的最终 `smoke-r1` 已通过真实固定编译器、QuickJS Worker/DOM 与 12 次
连续 WXML 热更新。服务使用关闭 native engine feature 的 CLI 构建；13 代均核对
第二路由 `pages/home/index`、初始 `count: 7`、独立 marker、Worker viewport 和
实际 iframe 的 `414×736` 几何，点击后为 `8`，完整重载后回到 `7`。编译失败保留
末代交互，Stop 后 13 个 Worker 均实际关闭并 terminate，原服务退出码为 `0`，
自有页面、context 和 browser 全部关闭。normal high-water 为 `78`，退休游标为
`72`，实际退休请求为 23 次。源码、无 native CLI 构建与逐代证据见
[普通 CLI 验证归档](../archived-evidence.md)。

此前实验入口的 `retirement-smoke-r2` 通过真实固定编译器、
QuickJS Worker/DOM 输入、连续 12 次 WXML 热更新、编译失败保留旧实例及 UI Stop
退出的八步流程。累计 normal serial 达到 78，退休游标达到 72；长循环采样时仅保留
6 条 normal 记录、1,590,840 字节。23 次真实退休请求完成，13 个实际 Dedicated
Worker 均观察到关闭，原 owner、ledger ACK 和 HTTP drain 完成，自有页面、context、
browser 和服务均已退出。执行记录、截图、源码与二进制绑定见
[退休与长循环证据](../archived-evidence.md)。

此前七步基线 `smoke-r5` 及其更早历史保持原样，见
[开发循环基线证据](../archived-evidence.md)。
本次长循环 r1 曾在 Stop 时因 manager ACK 采用尚未结算而失败；修复后 r2 重验，
原失败没有覆盖或升级。正常 INFO 诊断不会显示为 `ERR_ENGINE`。

早期 r3 中，打包器已保留 `button` 文本、嵌套绑定和事件，但当时 DOM `button`
adapter 仍为 unsupported，因此在 runtime-ready 后呈现失败；原失败和清理结果保留。
当前源码已加入受限原生 DOM button 适配及专项 fixture，支持文本、外观、disabled、
loading、焦点和原生点击/键盘激活，未支持组合仍明确拒绝。专项执行按其原始报告
单独验收；旧 `view + bindtap` 记录不能证明该 adapter，也不授予完整微信 button、
混合组件或冻结清单通过。

<a id="startup"></a>
## 启动

先完成[固定编译器和受管源码准备](browser-source-preparation.md)，并从已经完成的
Worker producer 执行记录中独立选定 pins。项目须为该受管 profile 支持的原始
小程序工程；当前不接受带现代 View `container.config.json` 的项目。

从仓库根目录使用普通 CLI：

```sh
cargo run --release -p container-simulator -- \
  dev --project /absolute/raw-mini-program-project \
  --surface web --engine quickjs --renderer webview --web-runtime browser \
  --browser-runtime-dir /absolute/completed-worker-producer \
  --browser-runtime-pins /absolute/independent-pins.json \
  --node-bin /absolute/node --port 0 \
  --route pages/home/index --data-json '{"count":7}' --viewport 414x736 --open
```

CLI 支持可选初始路由、对象数据及整数逻辑视口，每边为 `1..4096`，默认 `375×667`。
这些值经原严格 startup decoder 校验并绑定到不可变 intent，原监督器也用相同值打包；
不存在的路由按原 portable report 回退并报告 `ROUTE_FALLBACK`，不把有效 pack 标为构建失败。
Browser Worker 内含 QuickJS，因此该入口不要求 native QuickJS feature。

Skia 使用同一个 CLI 和监督器，替换 renderer 并提供独立 CanvasKit producer/pins：

```sh
cargo run --release -p container-simulator -- \
  dev --project /absolute/raw-mini-program-project \
  --surface web --engine quickjs --renderer skia --web-runtime browser \
  --browser-runtime-dir /absolute/completed-canvaskit-worker-producer \
  --browser-runtime-pins /absolute/independent-canvaskit-pins.json \
  --node-bin /absolute/node --port 0 --open
```

Browser 模式不读取 remote 的 `.weapp-container/presentation.json`。Skia 支持
`--render-scale auto|1|1.5|2|3|4`，默认 auto 在拥有运行实例的活跃预览中读取屏幕密度，按实际 DPR 创建目标，超过像素预算时明确失败；
WebView 使用浏览器密度，显式 `--render-scale` 会拒绝。
倍率只影响物理目标，不改变逻辑 viewport、模拟设备 `pixelRatio` 或 View/WXS 求值次数。
首个可呈现帧已包含倍率后的原生目标；375×667@2× 为 750×1334，禁止以拉伸旧像素替代。
目标超过 4096 边长或 16 MiB RGBA 预算时明确失败；运行中通过 owner 的 `setRenderScale`
切换时保留旧目标、布局与会话。auto 在本次 owner 启动时解析，跨屏幕动态更新和 Browser
开发设置面板尚未接入。此处 Node 合同不代表真实浏览器像素或性能验收。

auto 在原预览的替换预检阶段只采样一次，使用严格的 `captured-auto` 1.0 内部
profile 传给新 owner；1.25、1.75 等屏幕密度保持原值，低于 1× 或高于 2× 时截断。
这个内部 profile 不属于 CLI/startup JSON 的公开语法，公开数值仍只允许上述固定档位。
替换前除字节 pin 外还校验 producer 的 owner/Worker 两份显式 render-scale 1.0 ABI
声明；缺失、旧版、未知字段或预算不符均在关闭旧 owner 前失败，旧 owner 仍可响应 bridge。
Worker load 必须回执精确协议，但该回执只表示语义协商。首帧在一次原生 View 布局后
应用倍率，再验证原生目标的 session、render revision 和实际物理宽高，才允许导出。
这些检查不等于浏览器已经呈现或获得 GPU/像素验收。

替换遵循先关闭旧 owner、再启动新 owner 的单实例边界。已声明 ABI 的 producer 如果
在后续实际 load/frame 违约、报错或迟到，会显式失败并受现有 owner fencing 限制；
关闭后不会复活旧 JS heap，也不宣称能回滚到旧会话。
当前拒绝 `--fps`、`--software`、自定义 `--wv-bin`、`--renderer-assets` 及其环境
覆盖、`--renderer auto`、V8、desktop/both 和现代 View 配置，而不是接受后忽略。只监听 IPv4 loopback；
`--host ::1` 当前拒绝。Browser 专用 runtime 参数也不能用于 remote 模式。

普通 CLI 默认输出根为 `<project>/.weapp-container/dev`，每次由原监督器分配唯一运行根，
报告写到 `runs/<runId>/browser-dev-summary.json`。顺序重新启动可复用输出根，不会覆盖
上次报告；不要通过删除正在使用的运行目录强行重启。

兼容原有 example 的命令：

```sh
cargo run --release -p container-simulator --example serve_browser_dev -- \
  --project /absolute/mini-program-project \
  --producer-dir /absolute/completed-worker-producer \
  --pins /absolute/independent-pins.json \
  --node-bin /absolute/node \
  --out-dir /absolute/fresh-browser-dev-output \
  --port 0
```

| 参数 | 含义与默认值 |
| --- | --- |
| `--project PATH` | 必需，实际小程序源码目录。 |
| `--producer-dir PATH` | 必需，已完成的独立 Worker producer；与项目、输出和准备根分离。 |
| `--pins FILE` | 必需，启动消费者前选定的独立 producer pins；JSON 上限 16 KiB。 |
| `--node-bin PATH` | 可选，默认通过 `PATH` 使用 `node`；验证时应显式固定可执行文件。 |
| `--out-dir PATH` | 可选，默认 `<project>/.weapp-container/browser-dev`；运行根和最终报告保存在这里。 |
| `--port U16` | 可选，默认 `0`，由系统分配端口；只监听 `127.0.0.1`。 |
| `--duration-seconds N` | 可选，`1..86400`；从 HTTP 启动后计算，到期请求停止，不能强制跳过关闭屏障。 |
| `--help` | 输出参数说明。 |

工具 workspace 固定为编译该入口的仓库根目录，编译器必须匹配固定的
`vendor/weapp-vite` commit `0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e`。
应用目录可以位于仓库之外；不会从该应用另选未固定的上游编译器。

example 保持原有 WebView startup profile，不新增 renderer 参数，并仍要求每次使用新的
`--out-dir`。如果已有 `serve-browser-dev-summary.json`，
入口拒绝启动，避免覆盖历史证据；不要通过删除仍在使用的目录来重启。

<a id="independent-producer-identity"></a>
## 独立 producer 身份

pin 文件结构如下。占位符必须替换为独立 producer 执行记录中的原值：

```json
{
  "expected": {
    "reportSha256": "<原 build-report.json 字节的 SHA-256>",
    "sourceCommit": "<producer 的 source commit>",
    "sourceSha256": "<producer 的 source inventory SHA-256>",
    "renderer": "software"
  }
}
```

WebView 的 `renderer` 接受 `software` 或 `canvaskit`；Skia 必须为 `canvaskit`，不能使用
software pins 后静默回退。上述示例使用 software，Skia 须换为独立 CanvasKit producer
执行记录中的整组 pins，不能只改 renderer 字段。producer 身份验证不等于 GPU 验收。
`sourceSha256` 使用 producer 的 inventory recipe，不能用
`source-snapshot.json` 的文件哈希替代，也不能由消费者从待验证目录回填预期值。
任意目录自算哈希不证明它来自授权的完整 producer。

入口在生成凭据、绑定监听器和创建监督器前核对原 producer 报告哈希，要求
`status/buildStatus: passed`、`ready: true`、`execution: worker`，producer renderer 与
pins 一致，source 为 passed、stable、clean 且 commit/inventory SHA 与独立 pins 一致。
之后原监督器冻结有界副本并执行既有静态闭包校验。
原 producer 只读，退出时重新核对原报告。资源只能通过原 owner 的 allowlist 和真实
body lease 提供，不把 URL 解释为本地文件路径。完整字节与来源边界见
[runtime artifact 合同](browser-dev-artifacts.md)。

<a id="page-and-real-watch"></a>
## 页面与真实 watch

准备 runtime 和首个 portable pack 共用 180 秒 deadline。之后 stdout 输出单行
JSON，`event` 为 `listening`，包含 `url`、`runId`、`preview`、`producer`、
`compileSource` 和 `summaryPath`，并记录选择的 `renderer`、`runtimeLocation: browser`、
`engine: quickjs` 与 `gpuClaimed: false`。使用其中的实际 `url` 打开一个工作标签页。
监听成功只说明 HTTP 已配置，不是 Worker 或画面已经就绪。

凭据由受信任的本机启动方生成，只进入同源开发 UI 的 inert bootstrap 与原 HTTP
客户端；不出现在 URL、stdout 或最终报告中。不要把页面 bootstrap、控制 header
或凭据复制到其他页面。

同一个 `DevSupervisor` 管理真实源码 watcher、固定编译器、portable 输入与有限
stage 作业。同一个 owner 串行推进控制、资源、源码观察、stage 准入与完成；不会
在一次热更新中建立第二份监督器、ledger 或 AppService。浏览器页面的唯一 manager
负责实际 Worker 构造、启动、呈现和精确关闭。

静态 stage 完成会输出 `event: "staged"`。它不等于 runtime-ready 或
presented-ready；页面状态分别显示 Worker、画面与输入状态。自动观察只读取
`observe`，不占用命令 serial 或 final 预算。页面的“检查更新”按钮触发一次相同的
检查；它不是浏览器刷新按钮。

Skia 面板将运行时位置、renderer、物理尺寸、WebGL2 surface/驱动与提交状态分开显示。
`submitted` 是一次本地 picture/flush 的有界回执，尚不证明运行时已接纳；`accepted`
要求回执与当前 scheduler proof 的 Worker、attempt、surface generation、render revision、
页面、模板和 viewport 一致，且 metrics fence 已开放。旧/迟到回执不能升级当前状态，
诊断元数据也不授予输入权限；输入仍由原 owner/scheduler 的真实 ACK 路径控制。
硬件身份保持 `physicalHardware: unknown`，GPU 完成状态保持
`gpuCompletion: not-waited`。普通提交不以 `gl.finish()` 等同步等待证明完成，
WebGL2 context 和 `accepted` 也不能替代物理硬件、屏幕呈现或性能证据。

可选输入诊断的协商、逐输入因果记录及明确缺失的呈现端点见
[输入因果诊断](input-causal-diagnostics.md)。该接口始终阻止性能通过结论；
clone、GPU submit、canvas swap 和 runtime ACK 分开记录，不合并为屏幕呈现。

源码变化使已捕获 stage 失效时，`Unauthorized`、`Stale` 或 `Busy` 会作为诊断保留，
等待原 owner 的下一代产物或未完成转换。构建诊断不会冒充成功，也不会据此释放原
执行实例。其他 owner、控制、存储或 HTTP 错误进入停止和原 owner 清理流程。

<a id="stop-and-resource-ownership"></a>
## 停止与资源归属

优先点击页面“停止会话”，并保持原标签页打开，等待页面明确显示 `closed`。
关闭失败时保留原页面和会话，不要刷新页面或新建 manager。只有实际 owner 已关闭，
但 ACK 或传输清理失败时，才显示“重试清理”；它不能将未完成的 Worker close 变成成功。
Ctrl-C 或 `--duration-seconds` 到期也会请求停止；服务器继续提供原认证控制端点，
让同一个浏览器 manager 完成实际清理。

停止需要分别跨过以下屏障：

1. 原 manager 等待自身真实 Worker、加载、呈现器、bridge、mount 和传输工作关闭；
   对应回执必须匹配原注册身份和 close ticket。
2. 同一个 owner 的 `try_shutdown()` 返回 `true`，证明其原进程、stage 与资源借用
   达到现有清理合同。`false` 或错误保留原 owner，不能当作完成。
3. 原 ledger 的关闭检查确认没有待执行、不确定或未 ACK 的 final；真实 HTTP 队列
   排空后，再停止 admission 并确认原 socket drain。

空闲等待、socket 断开和 HTTP 200 都不能替代上述屏障。该入口显式启用
browser-reported close 策略：服务器关联可信 manager 的原始回执，仍不将这份报告
当作独立观测 Worker termination 或浏览器 transport.close 的证明。具体控制合同见
[HTTP 控制与 ACK](browser-control-http.md)。

页面强刷、崩溃、丢失或直接关闭后，新页面不能恢复原 manager、其实际 Worker 或
关闭 barrier。入口没有 takeover 或基于断连的自动释放。此时原 owner 与服务可能
持续保留，等待明确的原始清理证据；不能通过重绑端口、重放新 mutation、替换 owner
或伪造 `never-constructed` 回执声称清理成功。

<a id="bounded-records-and-explicit-recycling"></a>
## 有界记录与显式回收

实验入口在启动时同时启用原 owner、bootstrap 和客户端的 `retirementVersion: "1.0"`。
默认库入口保持关闭；不能靠 HTTP 请求升级能力。每次检查更新前，原 manager 有界
推进 ACK 和退休工作，即使产物未变化或编译失败也会推进。回收只适用于已经采纳
final、收到真实 ACK 且原 invoke/replay/ACK、事务工作全部结算的最早前缀。

normal 的默认逻辑字节预算仍为 16 MiB，每条首次命令预留最大 final 等费用，通常
约能**同时保留 60 条 normal 控制命令**，不是 60 次更新。退休成功后归还原记录的
容量；serial 和永久 high-water 不重置，旧 ID 与高水位以下的未见 ID 永久拒绝。
manager 从未传输的已终结本地预留可以独立释放，不伪造服务端 final、ACK 或退休。

每个 lane 最多保留一个待退休事务，1–64 条实际记录组成前缀，允许从未提交的数字
空洞。回执丢失时重试同一 digest/cursor，不能跳过未决事务。服务端每 lane 只保留
最近精确回执和永久游标；客户端须先完成原 reader/hash/abort relay 清理才释放记录。
协议、摘要 recipe 与各预算见[HTTP 控制与退休](browser-control-http.md)。

这移除了“每次运行只能累计约 60 条 normal 命令”的 lifetime 限制，但不承诺无限
可靠运行。未 ACK、冲突、不响应的工作或退休失败仍可阻塞前缀并耗尽保留预算，
`u64` serial 上限保持显式拒绝。cleanup、recovery、ACK 和退休工作各有独立预算。
停止优先关闭原 Worker/owner，等待已开始的退休工作，不在 Stop 后新发退休请求；
退休失败保留其失败状态，不妨碍必要的实际关闭，也不冒充成功回执。
Stop 的 ACK 检查同时等待 HTTP 实际工作和 manager 的 `drainControlWork()` 状态
结算屏障；网络完成不等于 manager 已经采用结果。

真实长循环 runner 可显式传 `--reloads 12`；它要求正常 serial 超过 64、存在真实
退休请求与成功游标，再验证编译失败保留、实际 Worker 逐代关闭和原服务退出。
`retirement-smoke-r2` 已完成上述八步，结果独立归档，不覆盖此前七步 r5 的结论。

<a id="reports-and-scope-pending-verification"></a>
## 报告与待验证范围

只有满足关闭 gate 后，入口才写入 `summaryPath` 并输出 `event: "shutdown"`。
报告记录同一 owner 的退出结果、原 ledger 清理状态、HTTP socket drain、producer
报告复核、编译器和源码绑定，以及实际观察过的 runtime/presentation 回执。
这些历史回执不表示当前画面仍在运行。

自有目录的存在性检查来自原监督器的 ownership record 和实际 portable 路径；
输出根中的归属记录与报告保留为证据，不会删除用户指定的整个输出目录。
当前公开 owner API 不提供 watcher PID 或最终进程 exit status，因此相关缺失项
明确标注，不能用编造的 PID 或退出码补齐。

| 验证项 | 当前状态 |
| --- | --- |
| 真实浏览器 bootstrap、Worker 首帧与输入 | 普通 CLI 的最终 r5 DOM 与 CanvasKit 均通过，使用真实 QuickJS WASM Worker。 |
| 真实 watch、失败保留与有界退休 | 两条 r5 路径均通过，分别执行 12 次更新、13 个不同 Worker，随后编译失败仍保留旧实例交互。 |
| ACK、原 owner 退出和自有目录清理 | 两条 r5 路径均通过；原服务退出码 0，自有 page/context/browser 已关闭，无保留测试服务。 |
| 测试命令、环境、源码哈希与执行记录 | 最终 690 文件起止不变；模拟器 543 通过、7 忽略，无 native CLI 7 通过，Worker 合同 767 通过；其余结果见归档。 |

格式检查及全部 target/feature 的严格 workspace Clippy 均通过；浏览器结果来自实际 r5
报告，不从编译或源码检查推导。完整记录见[普通 CLI 双路径证据](../archived-evidence.md)；
此前 [retirement r2](../archived-evidence.md) 保留其历史源码与结论。
最终 CanvasKit 使用 SwiftShader，活动 owner 已观察到的 context 在退役前没有同步读回或
`finish`；全局 15 次退役同步及原始调用栈完整保留。这个有限检查范围不能证明热更新销毁
没有等待，也不证明物理 GPU 或 GPU completion。

本页和入口代码本身不增加 GPU、CanvasKit 性能、输入延迟、微信 DevTools oracle、
其他宿主、官方模拟器或真机结论，也不完成七宿主 goal 或微信 near-parity 门禁。
冻结的 279 项发布门禁仍为 unknown；Skia CLI 的有限真实执行已有上述记录，性能仍未验收，
现代 View 开发配置和硬刷新接管仍未开放；有界退休不提供无限可靠性保证。

<a id="current-view-of-dom-smoke-and-retirement-evidence"></a>
## DOM smoke 的当前画面与退休证据

DOM presenter 在准备、提交与前一代清理之间允许多个 iframe 同时存在。
候选和退休画面保持 inert；harness 只能从当前自有 session mount 中选取唯一
非 inert、可见、连接到顶层文档且允许指针输入的画面。零个输入面表示等待，
多个输入面直接失败。标题匹配只用于全部候选的审计，不能使用 first/nth 代替输入权。

当前采样同时关联真实 Worker 的 `view.prepare` scheduling、同 key 的 enabled
`view.presented` final 和最新 runtime 的 page、viewport、template revision 与
surface generation。准备元数据只投影 key 和 consumed input，不记录 ViewDocument。
这类记录标为 `observed-dom-final`，是测试观察；manager history 中一次性的启动
`accepted-proof` 不会被当作每次渲染的新 proof，harness 也不写入运行时 authority。

旧 iframe 移除后，保存的子节点仍可能以旧 srcdoc Document 为根，因而其
`isConnected` 仍为 true。held Space 测试保留这个原始事实，验证实际 owning iframe
脱离顶层、Document/Element 来源、新旧焦点身份及旧 Document 无焦点，并验证
真实晚 keyup 没有回放点击、AppService 状态未改变，随后新 Space 只产生一次 tap。
native audit 继续观察全部候选和旧文档，不以当前面过滤审计来源。

编译失败报告中的 `retainedAppCount` 来自实际 AppService 观察；Worker 数量仍由
独立 constructor/terminate 记录计算。旧报告中的字段和失败结果保持原样。
这些 harness 边界测试不代替再次执行真实浏览器、设备或性能门禁。
