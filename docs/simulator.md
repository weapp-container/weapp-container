# Weapp Container 模拟器

仓库提供 `container-simulator` 作为开发和验证工具，支持 Web、桌面窗口及 headless 运行。它
消费 `container-pack` 目录中的 `manifest.json` 与
`blobs/sha256/<sha256>`，通过与原生宿主相同的 `HostSession` 驱动 AppService、
View、Renderer 和 bridge。生产运行时只依赖声明的构建组件，开发验证工具独立运行。

## 快速运行

需要现代 JS/TS 视图时，参见[现代 View](modern-view.md)，运行
`pnpm simulator:dev -- --project examples/apps/modern-view-app --surface web`。
它显式选择标准 JS 语义，使用独立 realm，支持现代源单独构建和失败保留旧 generation；
原始 WXS 与官方 DevTools 对照仍使用各自的兼容门禁。

```sh
pnpm container:pack -- ./path/to/weapp-dist --out artifacts/reference
cargo run -p container-simulator -- run --pack artifacts/reference \
  --trace artifacts/simulator/trace.json \
  --snapshot artifacts/simulator/snapshot.json \
  --report artifacts/simulator/report.json
```

`run` 的固定顺序是：

1. 验证 manifest、完整性和所有声明 blob 的 SHA-256；
2. 用一个 batched `app.init` 加载入口、依赖模块和供组件预挂载使用的 blob；
3. 发送 `app.lifecycle(launch)`；
4. 推送配置中指定的页面（默认第一条 route）；
5. 发送 manifest-backed `render.commit`，通过所选引擎的独立 View realm 求值 WXML，解析 WXSS 并生成
   一个 RGBA snapshot。

`--viewport WIDTHxHEIGHT` 可改变逻辑视口，默认是 375×667。`--route` 可选择
初始页面，`--data-json` 可提供首帧 WXML 数据对象。渲染使用所有 manifest styles；页面数据也可以由宿主在后续
`data.patch.batch` 中提交。输出的 snapshot 是 JSON 元数据和紧凑 RGBA8 像素，
便于 golden 比较或上传到 CanvasKit/native surface。

## DOM 文本编辑示例

[`text-controls-app`](../examples/apps/text-controls-app/README.md) 使用真实 input／textarea，
演示编辑、选择区、focus／blur／confirm、disabled、密码遮罩和 AppService 替换 value：

```sh
pnpm simulator:dev -- --project examples/apps/text-controls-app \
  --surface web --renderer webview --web-runtime remote
```

控件的身份匹配、焦点恢复和事件预算见[文本控件契约](dual-renderer/dom-text-controls.md)。
普通更新仍会重建 iframe，跨更新保持原生 IME 会话尚未完成；不要将快照恢复视为该能力通过。

## 组件关系开发示例

除了 reference-app，还可以运行带自定义组件关系的交互 fixture：

```sh
cargo run -p container-simulator -- dev \
  --project conformance/fixtures/component-relations --surface web --port 0
```

点击红色子组件会通过 `getRelationNodes` 返回的活实例调用方法并变蓝；Remove 和
Restore 分别移除与重建子组件。父组件通过 slot 和原生 view 接收子组件，两端在
linked 前发布关系，detached 期间可读取旧关系，unlinked 期间关系已清空。
`Component.relations`、`getRelationNodes` 和 `hasBehavior` 当前均为 partial；
`linkChanged` 因缺少可靠移动元数据而显式返回 `ERR_UNSUPPORTED_CAPABILITY`。
此示例可用于开发态验证，不增加真实 DevTools、GPU 或设备通过状态。

## 开发态监督器

首次克隆后，先初始化 submodule，并准备其固定版本的构建器依赖：

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm --dir vendor/weapp-vite install --frozen-lockfile
pnpm --dir vendor/weapp-vite run build:pkgs
pnpm submodule:verify
```

Node 和 pnpm 版本遵循 `vendor/weapp-vite/package.json` 的声明。已有依赖和构建产物
可直接使用下面的开发命令。`--project` 可以指向仓库外的独立小程序项目；工具仓库
从启动目录、可执行文件祖先、项目祖先依次定位。嵌入监督器时，
`DevConfig.workspace_root` 可显式固定工具仓库，相对路径以启动目录为准。

需要边写边看时，使用 `dev` 子命令。独立 Node 适配层使用固定版本 weapp-vite 的公开
`createCompilerContext` API 启动 watcher，在完成事件中同步冻结输出并原子发布版本化
receipt。监督器只对这些独立快照执行 `container-pack`，经过校验后再原子发布 generation
并切换同一个 runtime session；150 ms 防抖只合并已经成功的 receipt，不将目录暂时安静
当作本轮构建完成证明：

```sh
pnpm simulator:dev -- \
  --project examples/apps/reference-app \
  --surface web
```

源码监听后端由 `WEAPP_CONTAINER_SIMULATOR_WATCH_BACKEND=auto|native|polling` 选择，
默认 `auto`：macOS 使用轮询，其余系统使用原生文件事件。macOS 上采用原生 FSEvents
的监听链路曾在原子替换保存后超过 120 秒才观察到变更；因此 macOS 默认优先保证更新能被观察。
轮询使用固定 150 ms 文本、300 ms 二进制间隔，会增加文件检查开销，大项目可显式选
`native` 并验证所在文件系统的保存行为。其他系统在网络盘或虚拟文件系统上也可显式选
`polling`。无效值在构建器启动前失败，不静默退回另一后端。

该设置只配置现有公开编译器 context 的 source watcher，不增加第二个 watcher、定时重建
或伪造完成事件。适配器同时提供 `server.watch` 与 `build.watch.chokidar` 配置，并仅在
其拥有的 Node 子进程内归一化 `CHOKIDAR_USEPOLLING`、`CHOKIDAR_INTERVAL`、
`CHOKIDAR_BINARY_INTERVAL`；容器选择优先于继承的同名 Chokidar 设置。这样也覆盖固定
Vite 内嵌 Chokidar 对环境变量的优先处理，以及 classic host server 未保留部分 inline
watch 字段的行为。父进程、其他服务和自定义构建器的环境不变。END、不可变 snapshot、
source credit 和生成物校验仍是独立的发布条件；轮询事件本身不授予发布权限。

可单独运行真实固定编译器的原子保存检查，不启动 runtime 或设备：

```sh
node scripts/simulator-watch-backend-smoke.mjs \
  --out artifacts/watch-backend-smoke/local-01 --backend auto
```

该入口只创建自己的新目录，连续十轮原子替换 JS、WXML 和 WXSS，核对成功 receipt、
不可变旧 snapshot 和实际 watcher options；失败立即停止，不重试。日志与报告保留在指定
目录，退出时关闭其拥有的编译器。此项结果只证明构建监听链路，不代替设备热更新、
50 ms View、GPU 或性能门禁。

日常入口默认使用 release 构建，应用源码仍由 watcher 热更新；需要调试 Rust 时使用
`pnpm simulator:dev:debug -- ...`。等价的 Cargo 入口是：

```sh
cargo run --release -p container-simulator -- \
  dev --project examples/apps/reference-app \
  --surface web --host 127.0.0.1 --port 5179
```

桌面和 Web 共用一个 session 时，启用桌面 feature 后运行：

```sh
cargo run -p container-simulator --features desktop-window -- \
  dev --project examples/apps/reference-app --surface both
```

将 `--surface both` 改为 `--surface desktop` 可只打开桌面窗口。

可用参数如下：

- `--project <dir>`：`weapp-vite` 项目目录，必填。
- `--surface web|desktop|both`：默认 `web`。`desktop` 和 `both` 需要
  `--features desktop-window`（也可以使用 `pnpm simulator:dev:desktop`）。
- `--engine quickjs|v8`：默认 QuickJS；V8 必须在编译时启用 `v8-native`，不可用
  时显式返回 `ERR_ENGINE`。
- `--route <path>`、`--data-json <json>`、`--viewport <WxH>`：初始页面选项。
- `--render-scale auto|1|1.5|2|3|4`：独立的物理渲染密度；auto 依据活跃预览的
  屏幕 DPR，最高 2×。它不会更改布局或模拟设备的 `pixelRatio`。
- `--fps 15|30|60|120`：自动绘制和浏览器呈现的目标帧率，默认 60；浏览器刷新率和
  真实渲染开销仍会限制实际 FPS，不改变 JS 定时器或显式 bridge 操作语义。
- `--host <ip>`、`--port <u16>`：Web surface 监听地址和端口，默认
  `127.0.0.1:5179`。监督器不会默认暴露到局域网。
- `--out-dir <dir>`：pack generation 和发布 staging 的目录，默认是项目下的
  `.weapp-container/dev`。
- `--wv-bin <path>`、`--node-bin <path>`：覆盖自动发现的构建器和 Node 可执行文件。
- `--open`：在 Web surface 启动后请求系统默认浏览器打开 URL，仅用于 `web` 或
  `both`。启动器在后台回收，失败会在终端保留可手动打开的 URL，不阻塞模拟器运行。
  该选项不影响 headless 或 DevTools 门禁。

每次启动在输出目录内原子保留独立的 run namespace，并生成独立 session id。
重复使用同一个 `--out-dir` 时不会覆盖历史 generation；不同实例也不会共用 staging
或 pack 发布路径。编译器的 `.build-output`、不可变 raw 快照和现代源码快照放在项目外
的本轮专属 OS 临时目录，保留项目原有 `dist`；源码快照采用只读缓冲复制，避免 macOS
文件克隆向源目录发出变更事件。run 中的 `dev-session.json` 记录这些目录及拥有它们的
PID，工具据此定位原始产物。revision 在本轮运行内递增，退出回收本轮临时资源；
收据记录中的临时路径随后失效，已发布 pack 继续保留。

Web surface 提供以下本地接口：

| 地址 | 用途 |
| --- | --- |
| `GET /` | canvas、route、生命周期、engine、trace 和错误 overlay |
| `GET /api/state` | 当前 revision、route、session 和 simulator report |
| `GET /api/frame` | 版本化二进制 RGBA 帧，浏览器默认使用 |
| `GET /api/snapshot` | 按需编码的原始 premultiplied RGBA snapshot JSON，保留兼容 |
| `GET /api/presentation` | 已提交的逻辑视口、密度、目标 FPS、revision 和 generation |
| `POST /api/presentation` | 入队设置修改，HTTP 收据与 runtime 最终确认分开 |
| `POST /api/bridge` | 提交一个 envelope 或 `{"messages": [...]}` 批次 |
| `GET /api/events` | SSE；推送 `state`、`ready`、`snapshot`、`reload`、`diagnostic`、`error`、`presentation` 和 `shutdown` |

页面设置面板支持逻辑宽高、横竖屏切换、自动或固定密度、适应窗口或 25%–200%
显示缩放，以及目标 FPS。逻辑视口默认 375×667；密度默认 auto；显示缩放默认适应窗口。
逻辑尺寸影响布局、rpx 和命中坐标；密度只重新栅格化已提交树，不重启 session、执行
有状态 WXS/现代 View 表达式或改变模拟设备的 `pixelRatio`。显示缩放仅影响浏览器 CSS。
逻辑尺寸通过现有 runtime resize 边界更新布局和生命周期。切换期间旧画面的输入暂停，
匹配新 session/config generation 的帧到达后恢复。输入始终映射到逻辑坐标，不使用
canvas backing 像素作为触摸、滚轮或手势阈值的坐标。

已提交开发设置保存到项目忽略目录 `.weapp-container/presentation.json`，显示缩放只保存
在当前浏览器。启动优先级为显式 CLI 参数、项目保存值、均衡默认值。只有 `dev` 读取
项目偏好；`run`、`dispatch` 和 headless fixture 不会被本地开发偏好改变。单帧物理尺寸
取 `ceil(logical × scale)`，边长不超过 4096，紧凑 RGBA 不超过 16 MiB；无效目标、
不支持密度的 backend、分配或缓存预算失败均显式拒绝，保留已接受的配置和画面。
Web remote 的倍率更新先准备真实画面与完整 Web 响应，再共同接受配置；失败不重新执行
View 或 resize 来恢复旧状态。具体边界见 [开发态倍率事务](dual-renderer/skia-backend-boundary.md#开发态倍率事务)。
逻辑 resize 会调用应用生命周期，当前失败路径仍尝试恢复宿主几何与旧画面；回调导航后的
候选失效、Provider/引擎环境补偿尚未完成，应用已产生的 JS 副作用也无法事务回滚。

`9354c828` 的倍率事务原生 runtime 定向 3 项及模拟器 12 项新增必选测试通过；既有 watcher 回归另行必选，完整模拟器 library 为 486 项通过、5 忽略。真实 remote CanvasKit 用例通过 6 组 UI 202 入队及匹配 final SSE：倍率 2/1.5/1、FPS 120/30/60 期间 modern View 计数保持 1；点击变 2，超预算拒绝保留旧图后仍可点击变 3，无整页 RGBA 请求。自有页面、浏览器、SSE、模拟器/listener/staging 和临时项目均清理。SwiftShader 结果不替代 WXS 官方语义、逻辑 resize、连续滚动、输入 p95 或硬件验收；见[本次证据](archived-evidence.md)。

`GET /api/presentation` 返回以下 v1 模型（计数仅是示例）：

```json
{
  "schemaVersion": 1,
  "revision": 3,
  "generation": 2,
  "logicalWidth": 375,
  "logicalHeight": 667,
  "renderScale": "auto",
  "effectiveScale": 2,
  "fps": 60
}
```

`POST /api/presentation` 必须携带当前 `revision`，其他可选字段为 `requestId`、
`logicalWidth`、`logicalHeight`、`renderScale`、`fps` 和 `devicePixelRatio`。
过期 revision 返回 HTTP 409；有效请求返回 HTTP 202 `{queued:true,requestId,revision}`，
只表示入队，不表示 runtime 已修改。runtime 所在线程按序验证和应用，再发送
`presentation` SSE `{requestId,ok,presentation,error?}`。成功修改递增 revision；
物理目标或逻辑尺寸变化才递增 generation。16 个待处理设置请求之外返回 HTTP 503。
多个预览共享已提交配置；auto 密度由活跃预览报告 DPR，默认最高 2×。

`GET /api/frame` 使用 `application/vnd.weapp.frame.v1`，body 顺序如下：

1. 4 字节 little-endian `u32`，表示元数据 UTF-8 JSON 字节数；
2. 元数据 JSON：`schemaVersion:1`、`sessionId`、`frameId`、`configGeneration`、
   `sourceFrameId`、`renderRevision`、`logicalWidth`、`logicalHeight`、`width`、`height`、`stride`、`format:"rgba8"`、
   `byteLength`、`renderMs` 和 `url:"/api/frame"`；
3. 紧凑、逐行排列的 straight-alpha RGBA8，`stride = width × 4`。

原始 Skia 像素仍是 premultiplied RGBA；二进制发布时只转换一次，透明 alpha=0 的
RGB 归零，其他分量按 alpha 还原并取整、饱和，浏览器可以直接交给 ImageData。
旧 `/api/snapshot` 保留原始 premultiplied 值并只在请求时编码；普通浏览器路径不再
构建巨大的 JSON 数字数组。不可变 response buffer 由客户端共享，相同 session、
renderer revision 和 generation 不重复发布。`frameId` 是会话内递增的传输序号，
`sourceFrameId` 保留原始渲染帧编号；滚动和密度重绘即使沿用原始编号，也会递增
`renderRevision` 并发布新的传输帧。Web 全帧缓存及待发送响应共享 64 MiB 上限，包含
慢客户端持有的旧帧及切换前后的源/呈现像素；超额拒绝新目标，不静默降低密度。

`snapshot` SSE 只发上述小型元数据和 URL，不保存历史像素。客户端仅保留一个在途
拉帧请求和一个待呈现最新帧，RAF 按目标 FPS 呈现；拒绝迟到 session 或 generation。
通知按 session、generation 和 frameId 合并；若在途响应已包含通知要求的新帧，不再
重复拉取同一份像素。显式重连和不带帧游标的旧通知仍可刷新当前画面。
尺寸未变时复用 canvas，不逐帧重置 backing 尺寸。面板分别显示逻辑尺寸、真实像素、
当前密度、目标与实际 FPS，并报告 raster/readback、传输、解码、呈现耗时和帧字节数。
实际 FPS 表示实际收到并呈现的新帧，静态页面不会为了显示目标 FPS 反复绘制。
内部逐帧指标完整保留，面板文字每 250 ms 更新；几何不变时不重复测量预览布局。

`ViewState.revision` 继续统计事件和状态活动，`template_revision` 只追踪模板输入失效。
自动重绘依据后者：纯滚动复用已求值的树，不再次执行 WXS/现代 View 表达式；
页面或组件数据、properties、导航变化仍触发模板更新，包括滚动处理函数中的 `setData`。

实际 Web 性能回归可运行 `pnpm simulator:presentation:smoke -- --out artifacts/presentation/report.json`。
脚本使用 release 模拟器、真实 Chromium 输入和 HTTP 取帧链路，保留环境、二进制哈希、
50 次输入到像素呈现的样本，以及完整滚动输入、呈现和独立 RAF 记录。输入驱动由
浏览器 RAF 经绑定发送真实 CDP wheel，按实际 DPR 换算成每次 3 CSS px；不使用
独立 Node 节拍或合成 DOM 事件，不追赶补发，最多四个在途，真实 trusted 事件另作门禁。
滚动固定先输入
60 次暖机，以实际输入索引 60 到 240 定义不含结束点的测量窗口；总计请求 241 次输入。
首个输入前观察到的独立 RAF timestamp 固定显示相位，按 60 Hz 编号显示机会；应用帧
用同一 RAF timestamp 绑定机会，缺失 RAF 保留空号。`measurementVersion: 2` 只计算
完整落在实际窗口内的机会：机会起点必须不早于窗口起点，下一 deadline 必须不晚于
窗口终点。因此起点索引取 `ceil((start - phase) / period)`，结束排他索引取
`floor((end - phase) / period)`；仅在整数边界处理浮点舍入，不按结果拟合相位。
首尾不完整机会无论完成得快、慢或未完成都不计入分母或分子。180 是输入间隔数，
完整显示机会数由实际窗口决定；分母不按成功帧或观察到的 RAF 数量缩减。
完成时间仍须在实际窗口内并早于原机会 deadline，窗口外画面不能修补内部漏帧。
首个未变化且像素 revision 为零的画面也不计为进度，必须实际观察到变化像素。
没有完整机会时明确失败。版本 1 在终点使用 `ceil` 并截断完成时间，末端残缺机会可能
只有不足一周期的预算；其原始报告和失败结论保留，新版口径须另行运行并保存报告。
整体输入与测量窗口输入频率分别要求 57–63 Hz，显示环境也独立检查；暖机慢与后续
追赶不能相互抵消。窗口外补帧、重复帧、重复机会或固定像素条未变化的提交均不能补足
漏帧。像素检查仅比较一条固定窄列，并保存采样方法与开销。输入到呈现 p95 ≤ 50 ms、
滚动丢帧率 ≤ 1% 的门槛保持不变。失败报告仍保存，不将辅助单测或目标 FPS 当作实际
性能通过。

当前 release 的完整复测与限制见
[Web 清晰度与流畅度最终证据](archived-evidence.md)。
其中输入时延边界为 DOM pointerup 回调到 Canvas `putImageData` 返回，不包含
OS 输入排队或屏幕合成器显示；静态页面的实际 FPS 为零并不表示输入处理停止。

当前 UI 将上述软件端点明确命名为 `drawCompletedAt`，协议完成命名为
`transactionCompletedAt`，不再用全局 `lastInputAt` 关联下一帧。历史报告保持原字节。
Worker CanvasKit 的独立因果诊断及缺失的 compositor 门禁见
[输入因果诊断](dual-renderer/input-causal-diagnostics.md)；这些辅助阶段均不能声明
输入到屏幕 p95 或 GPU 滚动丢帧率通过。

显示设置的实际浏览器回归另行运行：

```sh
node scripts/simulator-presentation-controls-smoke.mjs \
  --simulator-bin target/release/weapp-simulator \
  --out artifacts/presentation/controls-attempt1
```

输出目录必须尚不存在。该脚本用独立临时项目验证偏好恢复、CLI 优先级、headless
默认值、显示缩放下的真实点击/触摸/滚轮、高密度热更新和活跃预览的自动倍率；
结束后关闭所属浏览器、服务与临时资源，保留 JSON 和截图。功能结果与上述性能门禁
分别报告。

SSE replay 最多 256 条、合计 2 MiB；慢客户端共享编码并仅保留一个待发送批次，
最多允许 16 个 SSE 连接。超过单事件字节预算时发送 `ERR_DEV_EVENT_TOO_LARGE`。
HTTP 请求和响应始终使用非阻塞 socket，每个客户端每轮最多写 256 KiB；网络可写
就绪立即推进下一轮，不再为每个写预算额外等待 16 ms。HTTP 与 SSE 总连接数最多 64，
未完成请求和响应在 5 秒后关闭。慢客户端不阻塞其他请求、runtime pump、热更新或退出。

`GET /embed` 是一个可直接打开的 Web 植入示例，位于
[`examples/hosts/web`](../examples/hosts/web)。它与 simulator 共享同源的
`/api/state`、`/api/snapshot`、`/api/bridge` 和 `/api/events`，用一个 canvas
接收完整 RGBA snapshot，并以批量 envelope 发送诊断请求。生产 Web 宿主应将这套
顺序替换为 `container-host-web::WebWasmHost` 的 WASM 调用；该页面只证明开发态
HTTP/Canvas 适配，不代表 CanvasKit GPU、真实 DevTools 或设备通过。

`POST /api/bridge` 会先返回已入队响应，实际处理结果通过 SSE `bridge`/`state`
事件回传，以保持 bridge 批量化并避免逐节点浏览器往返。页面默认只连接本机地址。
画布支持 pointer 输入：浏览器 `pointerup` 会发送带逻辑坐标的批量 `event.batch`。
桌面发送 pointer move/down，左键释放发送小程序 `tap`，其他鼠标键释放发送 pointerup。
桌面滚轮发送 `wheel`（包含 delta、phase 和 modifiers），键盘发送 `keydown` /
`keyup`（包含 physical code、logical key、repeat、text 和 modifiers）。键盘没有指针
坐标，会以最近一次提交渲染帧的 root 作为 focused target/path。runtime 从当前渲染树
完成 pointer hit-test，并补齐 `target`、`path` 和 `dataset`，再按声明归属调用页面或组件处理器。
`/api/state` 的 `sessionId` 用于宿主构造同一会话的输入 envelope。
桌面采用固定逻辑 viewport，窗口 resize 按物理像素 1:1 裁剪或补黑，不缩放画面；
可用 `--viewport` 选择启动尺寸。窗口尺寸变化不会改变 runtime viewport 或触发组件 resize。

watch 构建错误或无效 pack 不会破坏上一份有效 generation；诊断会进入同一条
`DevDiagnostic` 流，并在页面中显示 overlay。只有验证通过的 pack 才能触发 reload。
WXSS、静态资源与安全的 WXML 展示变化使用原地替换并保留页面数据、storage、计时器和
session；JS、JSON、app 配置、路由、组件关系或依赖图变化会重新创建 session，并轮换
`sessionId` 让旧输入失效。含 WXS 的 pack 中，WXML 文档、WXS 源码、依赖图和声明文件的 alias 绑定变化均属于重启输入，
即使页面没有自定义组件。旧版 pack 中的 `.wxs` 资源和 inline `<wxs>` 也按执行输入检查。
`viewCompilation` 的 compiler/version/ABI 或 module 可执行程序变化也要求重启；存在
WXS 状态时 document 执行程序变化同样重启。没有 WXS 状态的文档表达式仍可在独立候选
中验证后原地更新。源码与执行哈希参与各自的校验及 reload identity，不能沿用旧执行程序。
含 component-scope 脚本模块或 `usingComponents` 声明的 pack
还会比较变更 WXML 的源
IR：纯文本值及原生内置节点的 `style/class/id/hidden/data-/mark-` 属性变化可原地更新；
元素或子节点结构、指令、template/import/include、组件属性变化，以及模板新增、缺失或
无法解码则使用独立候选 session 完整启动，成功后才发布。自定义组件即使使用这些展示
属性名，也会作为输入保守重启。当前引擎无法回滚组件堆，这个边界避免候选挂载或属性
更新失败后破坏上一份实例；完整重启会重置页面与 JS 状态。重新加载成功后
旧错误 overlay 会清除，trace 与诊断历史仍保留。`/api/state.diagnostics` 表示当前
overlay；独立的 `diagnosticHistory` 使用 schemaVersion 1，包含 records、totalRecords、
droppedRecords 与 complete。历史最多保留最近 256 条及 512 KiB 编码诊断，超大记录与
被淘汰记录计入 droppedRecords；界面日志会标明截断。启动回调与定时器的异步错误也
进入同一诊断流。桌面窗口在 runtime 错误后保持错误标题，成功构建恢复时才清除。

原地更新的候选画面使用当前页面数据和组件的不可变快照构建，不加载应用脚本，
不执行 microtask、observer 或生命周期。组件依赖自身数据选择 `template is` 时，
文本和样式更新也保留该数据上下文；预览发现组件输入或实例拓扑变化时会拒绝候选。
候选同时验证完整的 manifest/blob 闭包、样式级联和首帧；原 session 接受同一份候选，
并原子发布 manifest、资源、画面和内部 generation，不重复求值。候选失败不会修改原
session 的画面、输入权限、选择器索引或 bridge trace。组件尚未绘制的 `setData` 使用
正常写入完成时保存的私有数据与版本回执，候选只读取该记录并刷新自己的组件图副本，
接受首帧时才一起发布；预览不访问活实例的 getter 或 `toJSON`。无法生成完整回执的
组件仍须先完成正常渲染，避免用过期组件状态替换画面。
组件选择器和自定义事件的索引也由候选树生成，通过私有元数据事务随首帧发布；
`id`、`class`、dataset 和 mark 的展示更新不会留下旧索引，也不重放组件准备或生命周期。
Skia 候选只在隔离 realm 中求值文档，再使用当前 renderer 的宿主字体提供者完成排版；
注入的 portable/native 字体、Canvas/GPU owner 与密度设置不会被候选的默认配置替换。
排版和解码仍先生成候选资源，接受首帧时才发布；缺字或渲染失败保留已接受的布局和目标。

Browser 路径把同一份隔离候选保留至现有 v1/v2 呈现 ACK。准备、资源解码、CSS、布局
与适配器处理期间，runtime 和模拟器的已接受 manifest、资源、组件图与 generation 均不
提前发布；监督器先返回 `staged` 更新，收到确切 ACK 后才发送 `PackReady`。候选只求值
一次。失败中止丢弃候选；旧页面、surface、原生 receiver incarnation 和输入 lifetime
仍匹配时，回执带有旧 key 与 lifetime 的恢复证明，host 清理候选后才恢复原 DOM 输入。
导航、隐藏、逻辑 resize、owner 断连或故障已经撤销的权限不会因中止而复活。permit 前
会先结束旧触点；取消回调的真实写入被保留，若改变候选输入则拒绝该候选。ACK 后的
ready 与回调错误仍属于已提交 generation。这些 owner 协议和 DOM 事务回归不代表已
通过官方基线、真实 WebView 或微信 DevTools 的完整一致性验收。

画面提交后发生的 ready hook 或回调错误属于已接受的 generation：runtime 返回
`render.commit` 的 `committed: true` 确认，再发送结构化错误，模拟器保留新 manifest
和新画面并显示 overlay。只有提交前的失败才保留旧 generation。ready 中的 `setData`
仍会在下一次 pump 刷新画面，不会被误标为已经绘制。嵌入方直接调用
`Session::replace_manifest` 时也不能替换执行模块或配置，必须创建新 session。

packer 为 WXS 生成独立的 `viewScripts` 内容寻址模块图，模板的 `wxsModules` 保存该文件
的 alias → module id；它们不进入 AppService 的 `modules`。inline WXS 正文按 raw text
保留，不解析其中的比较符、伪标签或 mustache。源 blob 和 graph 会验证。
原生 QuickJS/V8 构建中的 Session 通过独立 View realm 批量求值 WXML 和已声明 WXS，
不向该 realm 注入 AppService 的 `wx`、生命周期、存储或计时器。没有可信模块元数据的
旧 WXS pack 仍返回 `ERR_UNSUPPORTED_CAPABILITY`，未编入所选 provider 时返回 `ERR_ENGINE`。
静态 graph 提取器使用 lockfile 固定版本的 Acorn 解析 Script / ECMAScript 2020 语法，
区分除法、正则、注释与字符串，并解析转义标识符和字符串中的真实静态 `require`。
动态或别名词法 `require`、loader 重绑定、`eval`、`Function`、`with` 和 import 等无法形成
该静态图的输入会明确失败。这里的语法接受范围不是官方 WXS 方言承诺，也不是反射安全
沙箱；运行时仍按已声明的依赖白名单解析每次模块加载。首次运行先执行根目录的
`pnpm install --frozen-lockfile`，不能依赖 vendor 中偶然存在的解析器。
例如工厂的 `arguments[2]` 能间接取得 loader，静态分析不会提取这条边；运行时会拒绝
未声明的加载，共享 QuickJS/V8 测试覆盖该拒绝和显式声明后的成功路径。
WXML 与 WXS 输入要求有效 UTF-8，非法字节不会替换后继续打包。
packer 同时生成 `viewCompilation`：`weapp-container-wxs` compiler `1.0.0`、helper ABI
`1.0`，模块记录 `id/sourceSha256/executableSha256/helper`，文档记录
`documentId/wxmlAst` 与各表达式的 `source/shorthand/executableSha256/helper`。
原始 WXS 字节和 WXML AST 保持不变，另存执行 blob；metadata 和执行哈希纳入 manifest
integrity root。移动 App 植入示例复制并验证完整资源闭包，在 `app.init` 一次提交原始
与编译 View bytes，不依赖逐资源 JNI/N-API 调用。

编译后的 WXS 和 WXML 属性读取通过 hygienic lexical helper 返回八种标准字符串
`constructor`，保留 own/inherited override、getter、receiver、参数顺序与写入时序。
原生 prototype constructor 不被替换，Array 的 map/filter/slice/concat/splice 继续执行。
直接 View API 未提供编译元数据时仍采用 ECMAScript 属性语义。
无法正确 lowering 的语法返回 `ERR_UNSUPPORTED_WXS_SYNTAX`：lexical eval/Function、with、
import、optional、async/generator、tagged template、class、destructuring、spread/rest
和 for-of；这不是完整官方 WXS 方言或反射安全沙箱。
bare `wx:key` 是对象 item 的 own 属性名，keyword 与连字符不会被误当 JS；primitive
bare key 为 null，取 item 自身使用 `*this`。既有 dotted loop-scope expression 扩展
继续支持，但不视为官方行为证明。
开发态加载此类候选失败时，上一份可运行 generation 继续响应 bridge；这不是 WXS HMR
或官方 shared-template-WXS case 通过的证据。

QuickJS/V8 现已提供独立的批量 `ViewEngine` 执行边界：分离的 runtime/isolate、词法模块
绑定、实例缓存、逐次调用参数复制、特殊值编码，以及超时/取消后的域回收。
Session 保留已求值输入，避免组件发现过程重放有状态 WXS；超时或不可信回执要求重启，
不会静默回退。执行子集、测试和限制见
[独立 View 执行器](isolated-view-engine.md)。

`pnpm runtime:wxs-graph:smoke` 会打包包含除法、正则和转义 require 的 raw fixture，
验证源码 blob 未改写、依赖图没有字符串/正则产生的伪边，并在原生 QuickJS/V8 中读取
实际 WXML 绑定的 dataset；它不替代官方 DevTools 或 weapp-vite 构建回归。
`pnpm runtime:wxs-dialect:smoke` 验证编译身份、原始/执行 blob 哈希、八种 constructor、
原生 Array 方法、computed/own 属性、inline/external WXS、WXML-global 与 for-in 写入，
并比较 QuickJS/V8 实际 dataset。官方 constructor/datatype oracle 仍为 `unknown`；本地
检查不是七宿主、GPU/设备、浏览器或性能门禁通过证据。

Web 和桌面共用同一个时钟 pump：JS 定时器、页面事件中的 `setData` 和 bridge
数据 patch 会在数据 revision 变化后提交新 frame，无需等待构建。空闲 tick 不生成
新 snapshot 或 trace；JS 异步异常进入相同的诊断与 overlay 流。首帧使用 JS 页面
启动及 `onLoad` 执行后的真实数据。自行植入长期运行的宿主时，应在事件循环调用
`Simulator::pump(now_ns)`，参数使用 Unix 时间的纳秒值；`dev` 已自动调用。

原始 bridge 调试或 App 植入时，manifest-backed `render.commit` 省略 `data` 会读取
当前 Page 的 AppService 数据，包括已接受的 `setData`；显式传入 `data` 仍作为覆盖。
inline `style` 与 WXSS 共用 cascade，再将同一份结果用于 computedStyle、布局和绘制。
普通 inline 不能覆盖 stylesheet 的 `!important`，尺寸变化也会更新点击命中范围。

```bash
pnpm runtime:boundary:smoke -- --out artifacts/style-module-boundary.json
```

这个独立 fixture 经过正式 packer 和双引擎，分别检查初始画面与真实点击后
`setData` 的几何、样式、RGBA 像素和 CommonJS/JSON 模块结果。它不启动现有开发服务，
不修改业务项目；临时 pack 与子进程在退出时清理。报告属于本地 runtime 证据，
不会提升官方 DevTools、GPU、真机或七宿主状态。

开发态 Web 默认使用本机运行时 + 浏览器 CanvasKit/WebGL2：传输场景批次及独立图片资源，
常规帧不生成或传输整页 RGBA。需要一次性准备固定 CanvasKit/font 资源，详见
[`container-simulator/README.md`](../crates/container-simulator/README.md#local-gpu-scene-presentation)。
`--renderer-assets` 或 `WEAPP_CONTAINER_RENDERER_ASSETS` 指定资源目录，缺失时显式失败。
`--software` 显式启用旧 CPU RGBA 预览；headless `run/dispatch` 默认不变。

WebView 开发预览可直接运行：

```bash
pnpm simulator:dev -- --project examples/apps/reference-app \
  --surface web --renderer webview --web-runtime remote
```

该模式用隔离 DOM 文档承担 CSS 布局，业务与 View 程序由本机 QuickJS/V8 执行；无需
CanvasKit 资源。`auto` 则保留默认及逐页配置，并准备 CanvasKit 以允许页面间切换。
一个标签页持有主预览租约，其余显示只读镜像；“设为主预览”先取消旧触点和呈现授权，
待新布局最终确认后才开放输入。`POST /api/preview` 返回排队收据，SSE 才返回提交结果。
失效租约及迟到的视图请求版本不能继续操作 runtime。

DOM 倍率由浏览器 DPR 决定，界面会禁用 Skia 密度选择器；逻辑宽高、显示缩放及目标更新
FPS 保持可调。倍率偏好变化不重新求值 View，逻辑尺寸变化会触发 resize 并等待新的
浏览器几何。`/api/view-resources/` 按完整呈现标识传输经过哈希校验的编码图片，不传整页
RGBA。普通 DOM 绘制没有 Skia snapshot，诊断截图需从实际浏览器采集。

成功的样式/资源 pack 走原地更新，脚本更新重启 session；构建或 IR 预检失败保留当前
实例。仅浏览器可判定的 CSS、组件或解码错误仍可能晚于 manifest 接纳，此时保留旧画面并
冻结失效输入，不承诺回滚业务副作用。DOM selector/observer/scroll 命令适配仍待完成。
上述可调面板属于 remote 模式。Browser 模式使用同一个受管 runner，显式选择
`--surface web --engine quickjs --web-runtime browser`，并明确指定 `--renderer webview`
或 `--renderer skia`，提供 `--browser-runtime-dir` 与独立的 `--browser-runtime-pins`。
Skia 只接受已完成且 pins 的 `renderer` 为 `canvaskit` 的 Worker producer；WebView
接受独立固定的 software 或 CanvasKit producer。入口在创建凭据、监听器和 watcher 前
校验报告原字节哈希、成功/ready 状态、Worker 执行方式与稳定干净的源码身份。
它支持初始 `--route`、
对象 `--data-json` 和整数 `--viewport`（默认 375×667，每边不超过 4096），不读取 remote
保存的显示偏好，也不依赖 native QuickJS feature。Skia 支持
`--render-scale auto|1|1.5|2|3|4`，默认由拥有运行实例的预览读取屏幕密度并最高 2×。
2× 的 375×667 逻辑视口导出 750×1334 物理目标；倍率不改变模拟设备 `pixelRatio`，
复用已接受布局时不重跑 JS/WXS。上述倍率属于启动设置，auto 在所属预览启动时
采样一次；跨屏幕动态密度、Browser 实时设置面板和 FPS 调节尚未接入，不能套用上文
remote 面板的能力。WebView 使用浏览器密度并拒绝显式倍率。
当前仍拒绝 renderer `auto`、显式 `--fps`、renderer
assets 及其环境覆盖、自定义 `--wv-bin`、现代 View 配置、V8、原生 surface 和 software 组合，
避免接受后忽略；监听地址仅支持 IPv4 loopback。
每次运行单独保留 `runs/<runId>/browser-dev-summary.json`，顺序重启可复用输出根。
原始预览需保持打开直到 Stop 清理完成；刷新或崩溃后接管尚未实现。完整命令和 producer
准备见 [Browser 开发循环](dual-renderer/browser-dev-loop.md)。原生 `desktop|both` WebView
及 `--software` 与 WebView 的组合继续拒绝。remote 协议见[呈现事务](dual-renderer/browser-presentation.md)。

Browser 面板将运行时位置、渲染器、物理尺寸、WebGL2 surface/驱动和回执分别显示。
Skia 的 `submitted` 表示本地 picture/flush 已提交；只有它与当前 scheduler accepted proof
及页面、surface、viewport 匹配时才显示 `accepted`，诊断本身不授予输入权限。
`physicalHardware: unknown` 和 `gpuCompletion: not-waited` 保留为明确状态，不能据此推导
物理 GPU、实际完成、性能或其他宿主通过；新增 Skia CLI 路径的实测记录单独管理。

Browser 诊断面板兼容单个 `payload.error` 和 runtime 的 `payload.errors[]`，逐条保留
owner 归属、错误名、引擎来源和可用的纯文本 stack；诊断不会触发额外业务调用或重启。
每次通知最多展开 32 条，超量会显示省略数量；消息、错误码/名称、stack 分别限制为
2048、128、8192 UTF-8 字节，历史最多 32 条。仅读取已有的纯数据字段，不求值 getter、
不遍历业务数据。这里修复的是展示与规范化，不改变引擎的原生异常提取，也不证明真实
浏览器异常或源代码位置已经验收。

桌面开发态在 macOS 使用 Metal，Windows/Linux 使用 `winit + glutin` 创建
OpenGL 3.3 core 窗口，通过共享 Skia GL 接口直接绘制到 drawable；Linux 分别接入
X11/GLX 和 Wayland/EGL。缺少驱动、上下文或窗口配置时明确失败，已知软件 GL 驱动
不能满足默认 GPU 路径；`--software` 可显式选择 `winit + softbuffer`。
OpenGL 提交和 swap 成功只表示提交完成，不表示硬件执行、GPU completion 或屏幕扫描输出。两者复用同一 supervisor 和 `HostSession` 呈现
窗口；窗口标题包含 revision、route 和错误状态。`--surface both` 不会创建第二份
页面状态。受控退出（信号、窗口关闭、watcher 退出或返回错误）显式执行同一顺序：
停止并 reap watch、结束输出 reader、停止并 reap pack、清理准备文件、关闭 Web listener，
最后释放桌面 presenter/window。监听器关闭前尝试一次非阻塞 `shutdown` SSE flush；
慢客户端不保证收到最后事件，也不能阻塞退出。未完成的构建
不会被当作通过证据。

默认构建器通过仓库中的 `scripts/simulator-watch.mjs` 适配固定 vendor 的公开 API，
不修改 vendor。显式 `--wv-bin` 若可定位相邻 weapp-vite 安装，则使用同一适配器；
其他自定义构建器必须实现下面的 receipt 协议。没有 receipt 时只报告
`BUILD_RECEIPT_REQUIRED`，不会将可打包但尚未完成的输出当作成功 generation。

自定义构建器继承 `WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR` 和 `WEAPP_CONTAINER_SIMULATOR_SESSION_ID` 环境变量。
先在 receipt 根目录的 `snapshots/<unique>` 写入完整快照，冻结后通过原子 rename 发布
`receipts/<sequence>.json`，内容为：

```json
{
  "protocolVersion": "1.0",
  "sessionId": "环境变量中的会话值",
  "sequence": 1,
  "kind": "success",
  "snapshot": "snapshots/唯一快照目录"
}
```

`sequence` 是递增正整数；`kind` 可为 `building`、`success` 或 `error`，仅 `success`
包含 `snapshot`。失败可附带 `message`。快照发布后必须保持不可变；building/error
保留上一份 runtime。该协议和同步冻结步骤用于隔离构建写入与 pack 读取。

`success` 可附带 `compilerCommit`，格式为 40 或 64 位小写十六进制 Git commit。
公开 API 适配器从实际发现的 weapp-vite 安装目录解析 HEAD，且仅在该目录的
`package.json` 已纳入该提交时发送；普通 npm 安装或无法确定 Git 基准时省略。
该 SHA 仅记录源码基准，不证明工作树、依赖或生成的 dist 字节干净。
监督器中显式 `DevConfig.compiler_commit` 优先于 receipt；缺少两者时记录 `unknown`，
不借用其他 vendor 的 SHA。协议仍为 `1.0`，未提供该字段的旧自定义构建器继续兼容。
`/api/state` 与 simulator report 的 `compiler` 来自当前已验证 pack；smoke report
使用 `workspaceVendorCommit` / `workspaceVendorDirty` 单独记录旁边的 vendor 工作树。

packer 以监督器拥有的异步子进程推进，主循环通过 `try_wait` 检查完成，等待期间继续
处理 bridge、Web/SSE、桌面输入和 runtime pump。单次 pack 的绝对 deadline 为 120 秒；
超时或被后续构建取代时终止其拥有的进程并保留上一份运行实例。Unix 中 watch 与 pack 使用各自独立
进程组；退出依次停止 watch、pack 并清理临时快照和 staging。Windows 在执行子进程
代码前将挂起的进程纳入独立 Job Object，再恢复执行；归属失败直接报错，不回退到
无归属模式。包装层退出后 worker 仍归该 Job 管理。pack 取消和完成清理通过非阻塞
查询推进，等待全部 worker 退出后才释放 staging；显式 shutdown 提供退出屏障。

仓库还提供一个可选的一次性 Web smoke：它启动同一开发命令，等待首个 generation，
临时修改参考应用的一份 WXSS 验证原地更新，再修改 app 脚本验证 session 重启，制造无效 app.json 验证构建失败、旧实例的 bridge 响应和恢复：

```sh
pnpm simulator:dev:smoke -- \
  --engine quickjs --out artifacts/simulator/dev-smoke.json
```

smoke 默认使用 `--port 0`，由操作系统分配端口；`dev` 命令自身仍默认使用 5179。
脚本只使用本轮子进程公告的 URL，不会把已有开发服务作为
本次启动成功的证据。每轮在 OS 临时目录的 `weapp-simulator-smokes` 下用 `mkdtemp` 创建独立的
`simulator-smoke-*` staging，退出时仅清理本轮目录与进程；`--keep` 可保留该目录供排查。
`--port <number>` 可显式指定端口，`--engine quickjs|v8` 选择要编译并实际运行的
引擎，默认 QuickJS；构建失败或运行时 `ERR_ENGINE` 都报告失败，不会切换其他引擎。

该脚本会在退出时终止 watcher 并清理 staging；默认从项目源目录自动选择第一个
`.wxss` 文件，也可以使用 `--wxss pages/home/index.wxss` 指定要编辑的源文件。
脚本在退出时恢复自己修改的 WXSS、app 脚本和 app.json；如果文件被其他进程同时修改，会保留后来的内容并明确报告恢复冲突，不覆盖并发编辑。
SIGINT / SIGTERM 会取消正在等待的 HTTP、SSE 和浏览器操作，再恢复源码并关闭本轮资源。
只有精确匹配 sessionId、requestId、op 且 `ok/accepted` 均为 true 的 bridge 响应才算验证通过。
报告只表示开发模拟器的
Web/software surface 热更新链路可运行，不表示真实 DevTools、GPU、官方模拟器或真机
门禁通过。

如需验证真实浏览器页面（canvas、状态栏、SSE 热更新和错误 overlay），可以运行
Playwright headless smoke。脚本复用固定的 `vendor/weapp-vite` Playwright 依赖，结束时
会关闭浏览器、watcher 并恢复被临时修改的 WXSS：

首次运行浏览器 smoke 前，用 vendor 声明的 Node/pnpm 版本安装该固定 Playwright
依赖对应的 Chromium；仅安装 pnpm 依赖不会准备浏览器可执行文件：

```sh
pnpm --dir vendor/weapp-vite exec playwright install chromium
```

Linux CI runner 若还缺少浏览器系统库，可改用
`pnpm --dir vendor/weapp-vite exec playwright install --with-deps chromium`。
该 smoke 显式使用 headless 浏览器和软件 RGBA surface，结果仍只是开发模拟器证据。

```sh
pnpm simulator:dev:browser-smoke -- \
  --engine quickjs \
  --out artifacts/simulator/dev-browser-smoke.json \
  --screenshot artifacts/simulator/dev-browser-smoke.png
```

测试独立复制的参考应用时可加 `--reference-fixture --project <copy>`。
脚本会在启动前逐字节校验副本与当前提交的参考源码，拒绝额外源码和符号链接，
再运行完整的文字、点击、组件与 slot 检查；无需修改正在开发的参考项目。

浏览器 smoke 使用相同的独立 staging、公告 URL 和端口归属规则，默认也是
`--port 0` 与 `--engine quickjs`。切换为 `--engine v8` 可运行同一浏览器链路的 V8
版本；报告记录实际选择的引擎，不能以另一引擎的结果代替。

参考应用还会通过 selector 几何点击按钮，验证 `bindtap → setData → RGBA` 的可见变化，
再检查样式更新保留该画面；同一标签页随后打开 `/embed`，验证共享 session 的诊断请求。

该报告仍然只代表开发模拟器 Web software surface；它不会升级为 DevTools、GPU、官方
模拟器或真机证据。

## 自定义组件执行子集

WXML 求值时忽略普通布局中的源码换行缩进；原始 AST/blob 不变，稳定 identity
仍使用原始源码位置。显式单行空格、`<text>` 子树及动态绑定产生的换行保留。
只有格式缩进的组件子节点不会遮挡 slot fallback。自动高度统一由 renderer
按最终内容宽度测量。Block/Flex 共用 typed 布局求解，显式 Flex 默认横排；
百分比保留到实际父容器尺寸确定后再求值，隐藏及 absolute/fixed 节点不撑高父节点。
伸缩、换行、对齐与边界见 [布局约定](layout-flow.md)。这仍是开发面布局子集。

manifest 中的 `usingComponents` 与实际 WXML occurrence 共同决定组件实例；加载一个
组件模块本身不会挂载页面实例。session 负责组件图，按批次向 JS 引擎提交创建、属性
更新、挂载、ready 和释放操作。各实例有独立的 `data`、properties 和 scope identity，
组件 `setData` 也会使当前页面重新提交 frame。

模拟器在 `app.init` 中附带已校验的 `blobs`，使页面首次推入时能在 `page.onLoad` 前
发现并 attach 组件；首次 `render.commit` 后再调用组件 ready。自行使用 bridge 的宿主
也可提供这个可选字段。只在后续 `render.commit` 提供 blob 的旧宿主仍可渲染，但不能
据此证明组件在页面 onLoad 前已完成挂载。

纯 mustache 属性通过可选的 WXML IR `boundValues` 保留 JSON 类型，避免把布尔值、
数字、对象或数组先转为字符串再作为组件 properties。已有字符串 `attrs` 仍保留供
渲染和旧 v1 消费者使用。模板使用组件实例自身数据；投影进 slot 的内容则保留声明侧
数据、`usingComponents` 解析位置和事件 handler 归属，fallback 使用接收组件的上下文。
组件内部事件以对应组件作为 `this`，页面声明的 slot handler 继续使用页面实例；
selector 的组件 scope 防止同名节点串到其他实例。

循环组件的 identity 包含声明位置、祖先循环和已编码 key。更新或重排可复用仍存在的
实例；条件删除、页面移除或会话结束会释放对应实例，之后重新出现使用新实例。
这些语义用于把组件状态、渲染与输入接到同一个 runtime 生命周期。

受管组件与无 JS 注册的声明式组件共用 occurrence/slot 展开器：投影节点按声明方
解析 `usingComponents`，未投影内容不创建实例，成功更新会释放已移除的求值缓存。
直接在 `page.push` 前渲染也使用独立的 session 缓存。声明式路径仍将自定义 host
展开为子节点，不执行组件 JS 生命周期；这只是 headless 展示契约。
声明的本地组件缺少模板时返回 `ERR_MODULE_LOAD`；不可用 plugin/npm 目标返回
`ERR_UNSUPPORTED_CAPABILITY`，不再作为普通内置节点静默呈现。

组件更新或清理缺少引擎确认时，runtime 保留原始错误及仍归属本页的 scope，
将该受管页面标记为需要 session 重启；后续渲染与组件生命周期发现不会自动重放。
确认必须包含完整批次的唯一实例与 snapshot；销毁还须确认全部请求 scope，
包括幂等重试中已不存在的 scope。返回 `null` 或残缺成功结果同样视为缺少确认。
已确认释放的 scope 不会因后续关系更新失败而恢复。普通模板求值失败仍保留上一帧
及求值结果，数据修正后可以继续。AppService 仍可用于诊断和卸载；这些规则不回滚
任意 JS 副作用，也不冻结全部 AppService 输入。
runtime 单独记录成功 prepare 的原始父绑定输入；输入变化时先批量同步父组件，再
发现后代，不以归一化 properties 或本地 `setData` 覆盖该记录，避免失败更新修复时
短暂重建已销毁的子组件。

顺序参考来自真实微信开发者工具 `2.02.2608080` / 基础库 `3.17.3` 的
[`component-instance-apis` 观测](archived-evidence.md)：
该 fixture 中 parent、child 的 attached 先于页面 onLoad，ready 晚于 onLoad。
这份记录是实现顺序的 oracle 来源；当前自动组件子集并未因此通过该完整官方 case。
组件 `pageLifetimes.show/hide` 接入页面导航与 App 前后台切换；session 统一跟踪可见性，
缓存 tab、被覆盖的页面与已销毁实例不会收到错误通知。可见页面中新挂载的组件只补发
一次 show；回调抛错会进入结构化错误流，继续通知同批其他组件，且不会在下一帧重复调用。
双引擎使用专用批量入口，只调用 pageLifetimes，不会误选同名普通 methods。
两条 reLaunch 入口均释放活动页面与缓存 tab 的组件。
[`lifecycle-compare` 观测](archived-evidence.md)
确认 tab 往返后的 show/hide；本地测试尚不能证明所有跨回调的官方精确顺序。
当前没有正式的 runtime resize 生命周期消息，窗口 resize 不会伪造组件 resize 通知。

Page/Component 的 `selectComponent`、`selectAllComponents` 与嵌套组件
`selectOwnerComponent` 使用活实例的声明树索引；slot 保留声明 owner，普通节点也参与
首匹配，虚拟 `block` 不成为查询节点。当前支持 ID/class、子代、后代与并集；
export、跨组件 `>>>`、tag/属性模式仍显式返回 unsupported。顶层组件 owner 的
固定基础库真值尚未取得；这些选择 API 保持 partial，详见
[`API 语义与证据边界`](api-runtime-conformance.md)。

受管组件的 `triggerEvent` 使用 partial `Component.triggerEvent` capability。
session 在生命周期与输入回调前将事件图批量发布给所选引擎；直接 listener 和嵌套
自定义事件在同一个 JavaScript turn 内调用，保留本地 `detail` 对象身份，无需等待
首帧绘制或逐祖先跨 bridge 调用。`capturePhase`、`bubbles`、`composed` 默认关闭；
显式捕获独立于冒泡，非 composed 传播停在所属组件边界，catch 阻止后续传播。
listener 按声明 owner 执行，slot 保留声明侧归属。
已保存的 `lifecycle-compare` 真值只覆盖 `bind`/`bind:` 优先级与 hyphen/underscore
命名，不覆盖这些 option、detail 身份、同步顺序或生命周期内发事件。
上游 `issue-1126-1128` 包含相应传播断言，但官方 case 仍为 unknown。
`relations`、完整 WXS 方言、property 类型规则与官方组件兼容性仍未完成。本地双引擎、
渲染和生命周期测试不升级真实 DevTools 或 near-parity 门禁。

## JSONL 调试脚本

```sh
cargo run -p container-simulator -- dispatch \
  --pack artifacts/reference --script scripts/simulator.jsonl
```

每个非空行都是一个 bridge envelope，或者是包含 `messages` 数组的完整批次；
`#` 开头的行会被忽略。每行都会进入 normalized trace，trace 同时记录输入
envelope 和完整响应批次，因此可以用于和 DevTools、mpcore、QuickJS/V8 的
行为差分。所有 API、错误、取消和超时仍由现有 protocol/error boundary 判定。

`run`、`dispatch` 和 `Simulator::from_pack_dir` 默认使用 `TraceRetention::Full`，
保留完整 normalized trace。开发监督器默认使用 `TraceRetention::development()`：
最多保留 1,024 条记录和 8 MiB 编码后的 payload，先淘汰较旧记录；单条超过整个
预算的记录不会保留。存储采用紧凑 JSON 字节，避免每次 `render.commit` 把所有
blob 字节作为展开的 `serde_json::Value` 永久留存。记录数量同时限制队列元数据开销。

`report`、`/api/state` 和 `write_trace` 导出的 `traceSummary` 包含 retention、
`totalRecords`、`retainedRecords`、`retainedBytes`、`droppedRecords`、`droppedBytes`、
首尾 sequence 和 `complete`。发生过丢弃后会明确显示 `TRACE_HISTORY_TRUNCATED`，
Web 状态栏也标注 `history truncated`；即使后来改成 Full，完整性也不会恢复为 true。
截断只影响留存历史，返回给调用者的 bridge batch、页面状态和当前帧保持完整。
sequence 和 simulator request ID 按总计数递增，经过淘汰和完整重载也不会复用。

Rust embedder 可调用 `simulator.set_trace_retention(...)` 调整策略；开发监督器的
`DevConfig.trace_retention` 可显式设置为 Full 以捕获完整证据。完整策略没有内存上限，
应使用独立且有终点的 conformance 运行；截断的开发历史不能作为完整差分证据。
这些门禁只界定 trace 的留存，不证明 runtime 的总 RSS、GPU 或性能指标达标。

## App 植入边界

开发监督器提供显式 `DevSupervisor::shutdown()`：按上述顺序停止它拥有的构建资源，
之后 `poll` 和 `pump_runtime` 不再执行工作，`run_until_exit` 返回 `DevError::Shutdown`。
该操作和后续 Drop 幂等，避免再次向已释放、可能复用 PID 的进程组发信号；最后有效的
Simulator 仍可读取报告。宿主应先调用此屏障，再关闭自己的 Web/原生 surface。

宿主应用应复用同一个顺序：

```text
Simulator::from_pack_dir / HostSession::from_manifest_json
        │
        ├─ app.init + modules[]
        ├─ app.lifecycle(launch/show/hide/unload)
        ├─ page.push / page.pop / data.patch.batch / event.batch
        ├─ render.commit → 场景 / 原生 GPU surface → 呈现回执
        └─ render_snapshot(_json) → 显式截图或软件 surface
```

各示例使用同一 JSON bridge，但实际资源入口不同：

| 示例 | pack 与运行入口 |
| --- | --- |
| [`examples/apps/embed-runner`](../examples/apps/embed-runner/README.md) | 接收 pack 目录参数，在应用进程中加载 manifest/blob、启动 session 并读取完整 RGBA snapshot。 |
| [`examples/hosts/web`](../examples/hosts/web/README.md) | 开发态 `/embed` 复用 supervisor 已验证的 pack 与同一 session；生产 Web 宿主改接 `WebWasmHost` 的 manifest、批量模块与 blob 加载。 |
| [`examples/hosts/android`](../examples/hosts/android/README.md) | 从 `app/src/main/assets/portable-pack` 读取资源；用 `node scripts/sync-android-portable-pack.mjs --source artifacts/reference` 同步。 |
| [`examples/hosts/harmony`](../examples/hosts/harmony/README.md) | 从 `entry/src/main/resources/rawfile` 读取资源；用 `node scripts/sync-harmony-pack.mjs --pack artifacts/reference` 同步。 |
| [`examples/hosts/ios`](../examples/hosts/ios/README.md) / [`ios-app`](../examples/hosts/ios-app/README.md) | 共享 Swift portable-pack loader 校验 bundle 中的 manifest 与全部 blob，执行真实模块和页面启动；`ios-app` 将 manifest-backed frame 提交给 UIKit/Metal surface。构建/链接与设备/GPU 执行证据分别记录，详见 [iOS pack 接入](ios-portable-pack.md)。 |

Android 默认 native 构建启用 `quickjs-native-android`，可加载 pack 并执行真实模块和页面；
请求未编译的引擎时返回 `ERR_ENGINE`，不自动切换引擎。
[交互归档](archived-evidence.md)保留了真实 `weapp-vite`
pack 在官方 Android 模拟器中的 QuickJS、Skia GLES、实际触摸、窗口变化与前后台恢复证据。
记录绑定其中明确列出的提交；截图人工检查覆盖示例内容，精确像素对照及联合 App/Page
回调顺序的官方 oracle 仍为 `unknown`。
官方 DevTools 精确语义、双引擎宿主覆盖、物理真机／硬件 GPU 和性能仍需分别验收。

业务宿主应在 `app.init` 中批量提供模块与预挂载所需 blob，再将场景批次
交给 CanvasKit 或已实现的原生 Skia GPU surface，并提交对应 revision 的呈现回执。
remote WebView 使用 `view.prepare → view.prepare.commit → view.presented`；原生
WebView adapter 仍待接入。完整 snapshot 仅用于显式截图或软件 surface。
禁止逐节点 JNI、N-API 或 Swift 往返。示例入口与构建通过不代表完整宿主兼容性通过。

## 证据边界

开发面和 `/embed` 共用批量输入适配器，支持滚轮与单指触摸输入；滚动状态、
画面、命中和查询由同一个 Session 管理。可直接运行
`--project examples/apps/scroll-contract-app --viewport 240x200` 检查。
状态保留、错误与当前支持限制见 [Session scrolling](scrolling.md)。

模拟器报告中的 `status=passed` 仅表示该固定 pack 在 headless session 中完成
了请求和渲染。它不会升级真实 DevTools、GPU、模拟器或真机门禁；这些结果仍
须在对应宿主的受管测试和 evidence ledger 中单独记录。QuickJS 是默认构建
feature，V8 通过 `--engine v8` 和 `v8-native` feature 显式选择，缺少 provider
时必须保留 `ERR_ENGINE`。


本轮双渲染进度按 [`dual-renderer/`](dual-renderer/README.md) 的冻结清单验收。
当前 `auto|skia|webview + remote` 已接入开发监督器，`auto` 根据当前页面 profile
选择 CanvasKit 或隔离 DOM。显式 `webview|skia + browser + web + quickjs` 已复用受管
Browser runner；需独立 producer/pins，Skia 要求 CanvasKit producer，能力边界见上文。
原生 WebView adapter 尚未接入，相应组合显式拒绝。remote CanvasKit 呈现须先通过
`/api/render-presented` 队列，再等 runtime 所属线程发出 `presented` SSE；
旧 session/generation/revision 输入不会作用于新画面。GPU 提交成功只表示已交给
平台呈现队列，不宣称显示器已扫描到该帧；硬件与输入到呈现性能仍单独实测。

混合页面开发回归使用真实 watch 构建及同一个 session，验证 DOM 点击导航到
CanvasKit、返回后页面状态保留、旧画面输入拒绝与后续 WXML 热更新：

需要直接开发自己的混合页面时，可以使用
[`dual-renderer-app`](../examples/apps/dual-renderer-app/README.md)。三个普通
`weapp-vite` 页面演示 DOM → Skia → 新 DOM、返回保留页面计数，以及共享存储和
App 时钟。保持 `--renderer auto --web-runtime remote` 并提供固定绘制资源；
项目内 `container.config.json` 负责逐页选择，无需修改 runtime 或上游构建器。

```sh
pnpm host:dual-renderer:dev-smoke --binary target/release/weapp-simulator \
  --renderer-assets artifacts/dual-renderer-dev-assets --engine quickjs \
  --out artifacts/mixed-development-quickjs
```

`--out` 必须是新目录；V8 单独用 `--engine v8` 和另一个输出目录执行。脚本拥有
独立项目副本、模拟器、SSE 和一个 headless 浏览器页面，结束时清理并保存结果。
这项功能回归不代替性能、物理 GPU、微信官方或其他宿主验收。
