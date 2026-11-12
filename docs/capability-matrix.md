# 宿主能力矩阵

此矩阵描述当前代码中**声明的接口边界**。`feature-gated skeleton` 表示可编译的绑定入口，
不表示已经通过官方模拟器或真机；真实验收必须在对应宿主和官方工具中单独记录。

API inventory 使用七个明确的宿主键：`web`、`macos`、`windows`、`linux`、`android`、`ios`、`harmony`。
开发模拟器的 `desktop` surface 只是 macOS/Windows/Linux 共用的窗口别名，不代表三个桌面宿主已经分别通过门禁；`miniProgram` 仅出现在微信 API 返回对象（例如 `getAccountInfoSync`）中，不是宿主键。

| Host | Default build | Optional backend feature | JS engine adapters | Native/device validation |
| --- | --- | --- | --- | --- |
| Web | sandbox/provider + software metadata | `wasm`, `canvas-kit` | QuickJS/V8 boundaries | provider smoke；CanvasKit/浏览器权限待验收 |
| macOS | sandbox/provider + software metadata | `window`, `metal`, `skia-backend` | QuickJS/V8 boundaries | `host:desktop:surface` 可验证 winit/softbuffer native window；GPU 待验收 |
| Windows | sandbox/provider + software metadata | `window`, `gl-window`, `direct2d`, `skia-backend` | QuickJS/V8 boundaries | provider smoke；GL presenter 已接入，Windows 实机/GPU 待验收 |
| Linux | sandbox/provider + software metadata | `window`, `gl-window`, `vulkan`, `skia-backend` | QuickJS/V8 boundaries | provider smoke；GL presenter 与 X11 display 测试入口已接入，Wayland/硬件 GPU 待独立验收 |
| Android | sandbox/provider + software metadata | `android`, `gles`, `vulkan`, `skia-backend` | QuickJS/V8 boundaries | provider smoke；真机/GPU 待验收 |
| iOS | sandbox/provider + software metadata | `ios`, `metal`, `skia-backend` | QuickJS/V8 boundaries | provider smoke；真机/GPU 待验收 |
| HarmonyOS | sandbox/provider + software metadata | `harmony`, `arkui`, `skia-backend` | QuickJS/V8 boundaries | provider smoke；真机/GPU 待验收 |

## API 级别

独立桌面模拟器的 `gl-window` 使用现有 Skia GL backend；`direct2d`、`vulkan`
目前仍是预留 feature，不能据此声称对应 GPU presenter 已实现。Xvfb/Mesa display
测试只验证窗口、像素与生命周期，不改变物理硬件验收状态，见
[桌面跨平台架构](desktop-architecture.md)。

容器 capability key 应由 manifest 和 bridge 协商。首批 key 与语义如下：

| Capability | Level in skeleton | Unsupported behavior |
| --- | --- | --- |
| `lifecycle.navigation` / `getCurrentPages` | partial | Rust page stack synchronizes live QuickJS/V8 page objects, route/options snapshots and stack order, including distinct instances for repeated pushes of one route; native host lifecycle and tab-cache evidence remain required |
| `view.wxml-wxss` | partial | renderer 接收批量 `RenderFrame`；布局、`rpx`/`rem`、定位、变换、solid 四边边框与 content-box/border-box 共用软件/Skia/CanvasKit 几何，overflow 在 padding edge 裁后代且保留自身边框命中；其他合法 border-style 显式失败。`wx:key` 稳定生成节点路径；完整字体、图片、动画和 GPU/设备证据仍需宿主门禁 |
| `view.components-slots` | partial | Session 按实际 WXML occurrence 批量维护独立实例与 slot 声明归属；pageLifetimes.show/hide 与缓存 tab 清理已接入。Page/Component 选择支持 ID/class、子代/后代和并集，返回活实例并恢复失败 frontier 的旧选择树；native 首匹配返回 null。跨组件 >>>、export 等明确不支持，Page 直挂 owner 仍待固定 SDK 对照；relations、完整属性/样式隔离及宿主语义仍未完整通过 |
| `Component.triggerEvent` | partial | 预渲染批量事件树在同一 JS turn 内调用声明 owner；保留 detail 引用并支持显式 capture/bubbles/composed 与 catch。固定 SDK 证据只覆盖 bind 别名优先级与 hyphen/underscore 名称；传播、生命周期和七宿主仍需官方/设备对照；无协商、失效实例和缺少路由图显式失败 |
| `data.setData.batch` | partial | 只允许批量 patch，不保证原生小程序语义 |
| `event.bind-capture-bubble` | partial | bridge 接收批量事件并按 capture → target → bubble 顺序展开；原生树、组件事件和 selector 共享 JSON dataset/mark 投影，触摸保留已捕获的元数据快照。字符串不会猜测为 JSON；presence、官方类型与原生宿主仍需验收，见 [事件元数据](event-metadata.md) |
| `timer` / `animation` | partial | `TimerScheduler` 由宿主显式 poll；`wx.createAnimation` 在 QuickJS/V8 生成可序列化的批量 action queue，渲染帧时钟和变换插值仍由宿主提供 |
| `wx.createSelectorQuery` | partial | 查询最近一次 `render.commit` 的便携渲染树；支持 id/class/tag、viewport、组件作用域和关系选择器。`fields` 覆盖 rect/size/scrollOffset/id/dataset/mark/properties/computedStyle/node/context；复杂选择器返回 `ERR_INVALID_REQUEST`，未提交布局返回 `ERR_RENDER` |
| `canvas` / `canvas-offscreen` | partial | `createCanvasContext` 与 `createOffscreenCanvas({type: "2d", width, height})` 在 JS 侧批量收集 2D 命令；`draw()` 通过一次 `wx.canvas.draw` bridge 请求交给宿主 provider，sandbox 保存隔离 RGBA CPU raster；toDataURL、GPU 资源生命周期和原生 surface 仍需宿主证据 |
| `storage` | partial | session 内存存储和 `getStorageInfo*` 已实现；持久化由宿主通过 snapshot/restore 提供 |
| `filesystem` | partial | `HostApiProvider` 默认提供内存文件 sandbox；同步文件管理器使用显式权限作用域快照并批量提交写入/删除，宿主可替换为受权限控制的真实文件系统 |
| `network` / `system-info` / `ext-config` | partial | provider 提供可复现响应、host metadata 和第三方扩展配置快照；`wx.getSystemInfo`/`wx.getSystemInfoSync` 共享可注入的 typed snapshot（品牌、型号、像素比、语言、SDK、状态栏、方向、主题、字号），窗口几何与 platform/system/userAgent 随当前 HostMetadata 更新；`wx.getDeviceInfo` 使用校验过的设备身份快照，`wx.getWindowInfo` 输出同一 host 几何下的 screen/window/safeArea/top offsets，QuickJS/V8 共享字段投影；`wx.getExtConfigSync` 在模块求值前安装同步快照，`wx.getExtConfig` 通过同一 provider 边界异步返回；`wx.request`/`wx.uploadFile`/`wx.downloadFile` 通过同一边界返回 promise-compatible Task，支持 abort 与 response-header listener；`wx.connectSocket` 通过同一边界建模 SocketTask 的 OPEN、send 和 close 状态，真实传输与 inbound message 由宿主策略决定 |
| `wx.getAccountInfoSync` | **full（sandbox/QuickJS/V8）** | `SandboxProvider` 在模块求值前验证并注入完整 `{miniProgram, plugin}` 快照，每次 facade 调用返回独立克隆；七宿主的真实包身份注入仍按 host matrix 保持 partial，不能以 portable full 代替宿主证据 |
| `media.camera` / `location` | partial | chooseMedia/chooseImage/scanCode、`createCameraContext`（takePhoto/startRecord/stopRecord/onCameraFrame）以及 getLocation/位置更新通过 provider 要求显式相机/位置权限；拒绝时返回 `ERR_PERMISSION_DENIED`，sandbox 对获权但无设备的采集返回 `ERR_UNSUPPORTED_CAPABILITY`，不伪造路径或帧 |
| `media.inner-audio` | partial | `createInnerAudioContext` 与 `createAudioContext`（音频组件）保留 `src`/`volume`/`loop`/`playbackRate`/`currentTime`/`paused` 等可观察状态；play/pause/stop/seek/destroy 通过 `wx.innerAudioContext` 批量 provider 命令执行。sandbox 只模拟状态和校验，不宣称解码或输出音频；native provider 负责音频焦点、解码、路由和资源释放 |
| `media.video-context` | partial | `createVideoContext` 通过 `wx.videoContext` 批量建模播放、暂停、停止、seek、倍速、弹幕、全屏和状态栏状态；sandbox 只校验并记录状态，不伪造视频解码或渲染；native provider 负责 decoder、surface、方向和资源释放 |
| `permission.authorize` / `permission.openSetting` / `getAppAuthorizeSetting` | partial | provider 校验 scope 与显式授权状态；`openSetting` 返回稳定 `authSetting`，`getAppAuthorizeSetting` 返回各设备能力的 authorized/denied/not determined 状态，沙箱不弹窗也不隐式授权 |
| `auth.login` / `auth.checkSession` / `payment` | partial | provider 以显式 account permission 提供可复现 login code；`wx.login` 建立 account session，`wx.checkSession` 在登录前稳定失败、登录后成功，真实账号/支付由宿主适配器接入 |
| `clipboard` / `device` | partial | provider 维护剪贴板、网络类型、震动和保持屏幕常亮的结构化结果 |
| `ui.feedback` | partial | toast/loading/dialog/actionSheet/navigationBar 由 typed provider 处理；pageScrollTo 由 Session 驱动实际帧滚动（duration:0），缺少帧或动画未实现时显式报错。见 [scrolling](scrolling.md)；官方时序、原生 overlay 和各宿主交互仍需门禁 |

能力从 `partial` 或 `unsupported` 提升前，应新增 conformance case、宿主权限说明和性能报告。
