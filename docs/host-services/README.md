# 宿主能力协议与验收台账

语义基线固定为微信基础库 **3.17.3**，类型输入固定为
`miniprogram-api-typings@5.2.3`。清单记录每份输入声明的 SHA-256，不从在线最新版
推导兼容范围。`scripts/generate-host-api-catalog.mjs` 生成 runtime 使用的
[`host-api-catalog.json`](../../crates/container-runtime/src/host-api-catalog.json)：
495 个 `wx` 全局方法、756 个 Task/Context/对象成员、6 个容器扩展、8 个原生组件
或组件授权入口，共 1265 项。`cloud`、`env`、`router`、`worklet` 四个非函数全局
属性单独列入 `globalProperties`，不会伪装成可注册的函数。`env.USER_DATA_PATH`
属于运行时受管路径；宿主用户身份不进入 `getAccountInfoSync`。

全量七端台账见 [`api-matrix.csv`](./api-matrix.csv) 与
[`api-matrix.json`](./api-matrix.json)，每项均有七个平台单元格。生成命令：

```sh
node scripts/generate-host-api-catalog.mjs /absolute/path/to/miniprogram-api-typings
node scripts/generate-host-services-matrix.mjs
node scripts/generate-host-services-matrix.mjs --check
```

矩阵同时记录实现来源和验收状态。`present` 表示存在具体平台源码，参数范围仍以
实现和下文限制为准；`delegated` 表示必须安装接入方自己的身份或支付服务；
`runtimeOwned` 表示受核心保护的责任边界；`absent` 明确表示尚未找到平台实现。
后两者均不等于已完成。`pendingAcceptance` 覆盖缺少实现或缺少真实环境证据的
条目，不能解释为“代码已全部完成，只差设备”。`implementedAndAccepted` 必须有
对应版本的真实环境证据；`platformNotApplicable` 必须有平台限制依据，不能用于
掩盖实现缺失。生成器不会自动把源码或测试成功升级为设备验收；已有明确官方
平台依据的限制记录在 [platform-constraints.json](./platform-constraints.json)，
逐项进入矩阵。部分参数不可用时保留独立的 `parameterLimit`，不把整个 API 判为不适用。

来源身份的复核方式见 [API 来源审定](./source-review.md)。原始构建日志保存在
[私有历史档案](../archived-evidence.md)，公开矩阵的 `evidence` 不引用缺失的旧文件。
当前公开验收账本没有可分发的实际验收报告，所有平台均无
`implementedAndAccepted` 单元格。下文提到的旧执行记录只描述历史，不是当前源码的验收凭据。

矩阵 v2 保留 `owner` 的注册与安全边界，新增独立的 `responsibility`，按运行时、
设备适配器、宿主业务服务及微信生态服务清点全部 1265 项。
[`api-responsibilities.json`](./api-responsibilities.json) 用固定名称摘要校验完整性，
不会因为工作归属改变运行时允许宿主注册的范围。
`implementationState` 独立记录 `missing`、`partial`、`available` 或
`requiresHostService`。核心实现、JS facade、同步桥、受保护边界和平台数据来源
分别标记；例如 `getDeviceInfo` 的公共 SDK 已投影宿主提供的非空平台与系统字段，
但完整设备字段仍为 `partial`。`StrictHostProvider` 接收宿主快照，不采集操作系统
数据。清单同时计入 SDK 的 `NativeProvider`、核心窗口校验与共享投影，不能因为
平台没有重复注册窗口 API 而漏记核心已有实现。
`owner:runtime` 本身不证明实现完整；Canvas/Editor/Worker 等按具体成员清点。

`getWindowInfo` 和胶囊矩形直接使用核心已接受的完整显示/布局观测。仅有渲染尺寸
不构成物理屏幕、DPR 或安全区；首次观测前明确不支持。系统快照保留真实 OS 字段，
几何字段统一由当前观测覆盖，未知品牌、型号及宿主 App 版本不填默认值。
`host` 的值为可信安装记录中的 `{ appId }`，不会把宿主种类或账号 ID 当成应用 ID。
基础接口与已注册扩展的同步快照共用 owner 原子安装缓存，更新、热更新及换号重建
均不绕过这条路径。显式异步 `getSystemInfo` 处理器完成时同样采用当前已接受几何，
不能用请求发起时的旧尺寸覆盖已发生的 resize。源码可用状态不表示所有 SDK 已传入
观测，也不替代七端验收。

验收由 [`acceptance-contracts.json`](./acceptance-contracts.json) 声明逐项审查的
参数、平台条件及 SDK/引擎范围，再由 [`acceptance-ledger.json`](./acceptance-ledger.json)
引用绑定源码、产物、日志与清理记录的报告。生成器验证这些证据后才允许升级状态，
不从旧构建记录自动导入验收结果。历史台账曾记录 Web Base64 链路，以及 `wx.canIUse`、`wx.getWindowInfo`、
`wx.getSystemSetting`、`wx.getAppBaseInfo`、`wx.getDeviceInfo` 的有限参数范围；这些原始证据未随公开源码分发，当前台账不保留其已验收评级。真实 SDK、硬件和商户证据仍需分别提供。格式和检查规则见
[ACCEPTANCE.md](./ACCEPTANCE.md)。

Android/iOS/鸿蒙台账从实际适配器的 `supportedApis` 和注册语句读取；桌面从
公共文件/授权实现及各 OS 的实际注册语句读取；Web 从具体实现可注册的功能分支
读取，同时保留环境协商条件。生成器发现锁定清单之外的显式注册会直接失败。
这些操作只是源码清点，不请求设备权限，也不把 feature shell 视作硬件证据。
宏观分组或旧发布包的成功记录不能覆盖新协议中的缺项。

| 平台 | 已有具体源码 | 仍需完成或验收 |
| --- | --- | --- |
| Android / iOS | 系统服务、BLE/Beacon、录音、Wi-Fi 公开能力、联系人/日历、扫码、隔离文件、原生相机/视频帧、宿主账号客户端和官方 App 支付接入 | Android 部分模拟器链路已有实际记录；物理资源和 iOS 签名权限仍需逐项验收；NFC 参数范围及缺项以矩阵为准 |
| 鸿蒙 | API24 HTTPS/WSS、隔离同步文件、系统 UI、定位、传感器、BLE、录音、显式配置的 NFC 原始标签；独立 native owner、账号换号、原生资料/手机号授权、参考账号及渠道协议 | 官方编译和真实本地 QuickJS/SQLite 链路已验证；设备权限/硬件、官方钱包渠道及商户交易仍待验收 |
| Web | fetch、Socket、异步 OPFS、WGS84、传感器、显式授权的 BLE GATT、InnerAudioContext、DOM/单画布媒体组件和宿主身份/支付协议 | 浏览器/硬件/用户激活限制；同步持久文件和当前 wx NFC 合同未注册 |
| macOS | NSURLSession HTTPS/WSS、私有文件、AppKit UI、CoreLocation、CoreWLAN、CoreBluetooth GATT、AVFoundation 录音和 AVPlayer 帧、Contacts/EventKit、认证检测、屏幕常亮、电量 | 单 canvas 合成与具体设备/权限验收；未实现分组仍为 absent |
| Windows | WinHTTP HTTPS/WSS、Win32 UI/剪贴板/屏幕常亮/电量、WinRT 前台定位、BLE GATT、加速度/陀螺仪/罗盘、MediaPlayer InnerAudioContext、私有文件与应用授权 | 音频支持受管文件和可信包内 PCM/IEEE-float WAV；真实 Windows SDK 源码编译已通过，完整 runtime 链路和设备验收待完成，其余分组仍为 absent |
| Linux | GTK UI/剪贴板、GIO 网络状态、私有文件与应用授权；libcurl HTTPS/WSS；显式 desktop ID 的 GeoClue 定位 | 实际发行版、桌面 portal 与硬件验收；未实现分组仍为 absent |

矩阵中的源码存在性不等同于全部参数或硬件均可用。Linux 的网络注册还取决于
编译时是否找到 `libcurl>=7.85`；WSS 另需至少 8.16、实际链接的 WebSocket 符号及
TLS 协议支持。实际安装 API 必须以运行时能力协商为准。

## 注册与执行边界

`registerApiHandler` 仅接收清单中 `owner:host` 的条目。导航、页面栈、布局、
存储事务与核心查询对象不能被宿主覆盖；`registerHostMethod` 继续作为业务扩展。
组件条目仅声明可用性，原生回调经专门组件入口校验当前已接受节点。

协议区分同步快照、同步本地操作、异步调用、可取消任务、持续订阅和长寿命对象。
同步快照进入运行时统一原子安装的 JS 私有缓存，普通同步本地方法不能通过异步 handler 冒充。对象属性
有明确读写元数据：读取已接受快照；可写属性在 guest 记录 desired value，异步
提交原生操作，失败回滚并报告错误。只读属性根据锁定声明中的只读语义识别，不能
因类型声明缺少 TypeScript `readonly` 就允许写入。

每次调用都携带 runtime 生成的可信应用安装、已接受 pack、用户 epoch、session、
call ID、截止时间与取消信息。`epoch`、序号和纳秒时间使用十进制字符串传输，
避免 JavaScript number 丢失 `u64` 精度。设备回调只写有界队列，只有所属 runtime
线程 drain 时才能进入 QuickJS。原始 `errCode`、`errMsg` 保留在错误公开字段中。
对象/订阅属于创建它们的 owner，取消和账号变更会撤销这些资源。

Web 二进制存储具备 owner 作用域、引用计数、过期、传出失效和总字节上限。
当前 WASM 桥以 `__weappBinary` 把数据恢复为真正的 guest ArrayBuffer，每块最多
1 MiB；Worker 通道通过显式 `binaryTransfer: "1.0"` 协商，将保留标记中的字节转换成
独占的 ArrayBuffer 后转移，接收端恢复现有 native JSON 协议。每个 wire 批次二进制
总计最多 8 MiB，普通数组继续使用节点预算；失败重试复用原始 native 值，不复用已
转移的缓冲区。WASM/guest 边界仍是有界复制，尚不能作为零拷贝可转移帧的验收证据。Socket 队列溢出
关闭对应生产者，传感器等最新值事件允许合并。公开协议版本不匹配时明确拒绝，
不会静默降级到旧 runtime。

## Web 接入

[`BrowserHostServices`](../../examples/hosts/web-wasm/browser-host-services.mjs)
实现浏览器设备边界；
[`loadBrowserHostServices`](../../examples/hosts/web-wasm/worker-host-services.mjs)
在 Worker 的 `app.init` 之前安装配置，并通过现有 owner 观察通道送回完成和事件。
它借用 `WorkerWebSession`，不会自行创建浏览器、标签页或第二个 Worker。

```js
const native = await loadBrowserHostServices({
  session, catalog,
  trusted: { application: trustedInstallation, account: { principalId, epoch: String(epoch) } },
  loadOptions,
  identity: hostIdentityHandlers,
  payment: hostPaymentHandlers,
  allowedOrigins: ['https://api.example.com'],
  onError: showHostRecovery,
})
// 回收顺序：撤销能力/停止设备并等待 drain，然后关闭它借用的 session。
await native.close()
await session.close()
```

Web 音频来源、取消和包内资源合同见 [WEB-AUDIO.md](./WEB-AUDIO.md)；蓝牙的显式
设备授权与独占 handoff 见 [WEB-BLUETOOTH.md](./WEB-BLUETOOTH.md)。

这里的 `trustedInstallation` 必须来自宿主已验证发行者的安装记录，绑定实际 pack。
内容哈希只验证完整性；不能用 guest 上传的 appId/publisherId 声明替代安装认证。
`hostIdentityHandlers` 在宿主保留凭据，向参考后端或现有后端申请一次性应用 code。
普通 `wx.request` 使用 `credentials:omit` 和允许的 origin，不附加宿主 bearer。
生产 `WebHost` 默认使用严格 provider；未配置的登录、支付和设备方法失败。
历史开发 fixture 可明确选择 `developmentSandbox:true`，不能与生产 hostServices
同时启用，也不能据此记录设备或商户验收成功。

`BrowserHostAccountManager` 保持公共 controller 稳定，内部 owner 每次换号重建。
先同步封锁所有 sibling owner 的输入/回调，再等待设备、GPU 和文件锁 drain；
然后用新身份和宿主新启动参数创建 owner，真正画面确认后恢复输入。失败保持
封锁。宿主账号保留，应用退出只撤销对应应用的 grant 并重建其全部实例。同一
用户刷新凭据通过宿主回调完成，通常不触发重载。工厂的 `revoke` 必须同步关闭
输入，`detachSurface` / `close` 必须等待真实资源屏障，不能用空操作满足合同。

Web 具体限制是能力协商的一部分：

- 相机与视频元素自动挂到已接受 DOM 文档中的真实 WXML 节点，布局、裁剪、变换、
  层级与输入由该节点的 DOM 上下文承担。节点卸载和 owner 关闭会停止流、销毁
  Context；迟到的相机授权也会停止新返回的流。Skia 路径读取 runtime 实际接受的
  `HostComponentSnapshot`，使用离屏解码元素和 OffscreenCanvas 提取 RGBA，再通过
  `componentFrames: "1.0"` 独立字节通道交回同一渲染树的普通 image paint slot。
  不创建 DOM 覆盖层；裁剪、变换、透明度和 sibling 层级采用既有绘制计划。
  帧长边最多 512、单帧最多 1 MiB，单组件只保留一帧，队列最多 16 MiB；卸载、
  隐藏、后台和撤销停止真实媒体资源。完整浏览器/硬件验收按对应证据单独记录。
- Skia 视频支持 Context 播放、暂停、跳转和倍速；浏览器原生 controls 和独立视频
  fullscreen 尚不提供等价单画布 UI，后者明确拒绝。DOM 路径使用真实原生 controls。
  包内视频由 runtime 按已接受组件、文档归属和清单哈希读取；待呈现几何会重试，
  不回退到宿主页相对 URL。网络媒体显式不带凭据读取，禁止重定向，解码资源限
  16 MiB；超限明确失败，流媒体协议不据此宣称已验收。
- 手机号采用真实 `button open-type="getPhoneNumber"` 的点击 → runtime 节点验证
  → 宿主授权 → `bindgetphonenumber` 链路。不存在虚构的 `wx.getPhoneNumber`。
- 浏览器持久文件采用 OPFS 异步写入，等待关闭/flush 后才确认；不注册同步持久
  文件方法。没有 OPFS 时仅提供本 owner 的临时内存文件，不声称持久成功。
- 地理坐标仅原生 WGS84；GCJ02 必须另外配置合规转换。BLE 只连接 host 已授予的
  deviceId；不伪造无限制扫描。Web NFC 的 NDEF 消息与当前冻结 wx NFC 的原始
  记录及标签连接合同不同，因此默认不注册 wx NFC；具体限制和未来可行范围见
  [Web NFC 合同说明](WEB-NFC.md)。
- 录音严格检查请求的 mp3/aac/wav 编码，浏览器没有该编码时明确拒绝，不能把
  WebM 数据换扩展名。音频静音开关等浏览器不能落实的属性不注册。
- 权限结果独立于接口存在性；安全上下文、用户激活、操作系统授权、设备和浏览器
  均可能进一步限制调用。后台关闭资源，不注册后台定位能力。

## 原生接入与构建边界

鸿蒙 `HarmonyHostServices` 在 ArkTS owner 线程统一 drain NAPI 完成、事件和取消；
系统回调只入队。`HarmonyDeviceApis` 显式安装真实 API24 系统服务，权限原始错误
保留，隐藏停止传感器，关闭恢复该 owner 改变前的窗口设置。`getAppAuthorizeSetting`
在 app.init 前读取系统 PermissionStatus 同步快照，分别保留未决定、拒绝和已授权；
只获近似位置时明确返回 locationReducedAccuracy，授权返回及前台恢复时刷新。
生物识别能力与录入状态来自 UserIAM，未录入和硬件不支持分别处理；查询不生成
SOTER 签名，`startSoterAuthentication` 保持未注册。
传感器、扫描与 GATT 通知在入队时携带本次原生资源的分发条件，owner drain 前再次
检查；停止、后台、通知撤销或旧实例销毁后，已排队的数据也不再进入 JS。窗口亮度、
常亮和 Toast 操作按资源串行执行；迟到的创建先实际释放，恢复或关闭失败时保留
同一个句柄供 `retryResourceCleanup()` 重试，成功释放的资源不会重复关闭。
账号切换先调用
`revokeIdentity()` 阻断输入，再等待 `waitForHostServicesDrain()`，才能销毁和重建
内部会话。普通关闭仍执行 guest 生命周期；身份撤销后的关闭跳过旧 guest hooks。
`closeAndDrain()` 先封锁输入并解绑 surface，再等待实际异步资源退出，最后销毁
native owner 和释放文件租约；清理失败保留已封锁 owner，不能带着旧资源进入新账号。

鸿蒙 [账号管理器](../../examples/hosts/harmony/ACCOUNTS.md) 已在示例工厂中实际创建
新 `createWeappContainer()`，重放全部适配器，等待新画面确认后开放输入。
同一进程的 owner 独立拥有 EGL context/surface，但默认 display 属于宿主共享资源，
退出不会调用 `eglTerminate`。失败的设备释放、surface 解绑和 native 销毁均保留
准确对象用于重试，不能将“已经请求关闭”等同于释放成功。

[参考账号装配](../../examples/hosts/harmony/REFERENCE_HOST.md) 默认关闭；宿主显式
配置固定 HTTPS 后端和 native token provider 后，登录复用既有宿主账号，资料和
手机号分别读取服务端登记的用途及权限版本，再显示原生 ArkUI 授权。
`ComponentContent` 的精确关闭、`onDidDisappear` 和内容销毁都进入换号屏障。
一次性 code 交给小程序业务后端兑换，不返回宿主 bearer、手机号明文或客户端密钥。
支付仅安装宿主明确注入的官方渠道，接受可信 `orderId`，拒绝 guest 签名。钱包
回调不能证明订单支付完成；服务端确认之前不会返回成功。取消只停止调用方等待，
进程仍保留原钱包回调的归属，不能由新账号接收旧交易结果。

`HarmonySystemApis` 通过系统联系人选择器、联系人编辑器和日历编辑器接通
`chooseContact`、`addPhoneContact`、`addPhoneCalendar`、`addPhoneRepeatCalendar`。
不申请整本通讯录或日历数据库权限，保存由用户在系统 UI 中确认。系统编辑器本身
可能暂时遮挡 UIAbility；已有交互保持等待，新调用要求前台。官方 UI 没有可用的
取消句柄时，换号屏障等待编辑器真正返回并丢弃旧结果，不把调用取消解释为撤销
用户已经保存的联系人或事件。头像只从当前受管文件作用域读取，限制编码和解码
大小；图片实际释放失败会阻止退休完成。日历按 Unix 秒转换，重复周期和提醒
显式映射；系统只支持整分钟的提醒会拒绝有损转换，微信 session_key 签名跳转
在未配置专门宿主签名器时明确拒绝。API24 编译与未签名 HAP 通过，真机 UI 待验收。

`HarmonyManagedFiles` 从核心取得 `root` / `auxiliaryRoot`，仅接受 `wxfile://user/`
虚拟路径。异步文件方法与真实同步方法复用同一 Rust 受管文件层和 OS 操作锁，
同步成功仅在 flush/rename 和父目录同步完成后返回。保存记录只列出通过 saveFile
保存的文件，按应用、用户和环境持久化；合法包升级保持作用域，旧账号不会导入。
当前逐块读写上限为 1 MiB、scope 文件总额 32 MiB，路径、符号链接及操作数量有界。

`HarmonyNetworkApis` 使用 API24 实际 HTTP 流，实现取消、响应头、分块及上传/下载
进度；上传读取受管文件，下载写入受管目录。`HarmonySocketApis` 使用实际 WSS，
支持 Task send/close 与四种事件。HTTPS/WSS 分别显式配置 exact origin，默认空表
拒绝；HTTP 不跟随重定向、不复用共享响应缓存、不会安装宿主 cookie 或 bearer。
TLS 验证保持开启。队列按实际 UTF-8 字节计数，并为一次终结失败保留容量；
背压停止对应生产者。迟到的连接在清理屏障内关闭，不能发布旧身份的 Open。

鸿蒙已通过实际 OHOS Rust 交叉构建、C++ NAPI 链接，以及 DevEco API24 ArkTS
编译和未签名 HAP 打包；[build-evidence.json](../archived-evidence.md) 记录具体源码和
产物哈希。这证明构建链路，不证明已在设备安装或设备 API 通过验收。

Flutter 三个桌面插件共享原生 Registry，通过可注入的设备工厂复用 Desktop
`DeviceApis`，不额外建立运行时。先配置可信身份，获取核心租约给出的受管文件
目录，再安装实际 API 和同步快照。native 账号清理握手完成后，新 driver 绑定最新
接受包、epoch 和内部 incarnation；旧 OS 资源和 GPU texture 完整退休后才换号。
准备分发包时三个平台都校验并复制 Desktop wrapper archive 和公开 device header，
macOS CocoaPods、Windows/Linux CMake 显式链接对应系统依赖。

## 可复现验证与真实证据

```sh
node --test examples/hosts/web-wasm/browser-host-services.test.mjs \
  examples/hosts/web-wasm/browser-host-account-manager.test.mjs \
  examples/hosts/web-wasm/worker-host-services.test.mjs
node --test scripts/dom-presenter.test.mjs scripts/worker-runtime.test.mjs \
  scripts/worker-session-client.test.mjs
cargo test -p container-host-web --features quickjs-native
node --test scripts/harmony-host-services.test.mjs scripts/harmony-live-session.test.mjs \
  scripts/harmony-network-lifecycle.test.mjs
cargo test -p container-host-harmony --features quickjs-native
node sdk/flutter/native_desktop/tests/prepare_receipts.mjs
npm --prefix tools/host-services-reference test
```

HTTP 测试使用真实本地服务器验证取消、完成顺序和凭据隔离；Worker 的有限注入
host 只验证协议和生命周期。设备、相机、支付 SDK 与七端产物必须另附实际版本、
硬件/系统、命令、授权过程和输出证据。没有这些记录时矩阵保持待验收。
参考账号、订单及官方渠道后端的配置与验签范围见
[`tools/host-services-reference/README.md`](../../tools/host-services-reference/README.md)。
本地参考支付可复现成功不表示真实商户交易；真实交易另需商户凭据和正式平台宿主。

新增的 [Web 媒体证据](../archived-evidence.md)
在真实 Headless Chrome、QuickJS/WASM 与 CanvasKit 中检查视频、相机、前景 sibling
及祖先裁剪的实际像素，并验证后台、卸载、撤销资源和 Worker ArrayBuffer 转移。
相机输入来自测试拥有的 canvas 流，视频由真实 MediaRecorder 编码；这证明媒体
传输和同画布合成链路，物理相机仍待验收。构建记录的 `buildStatus:passed`、
`ready:true` 与整体 `status:partial` 保持原样，不据此宣称完整发布通过。

本次资源退役补充见 [Web 生命周期证据](../archived-evidence.md)：
实际 Headless Chrome + QuickJS/WASM 验证了 callback/Promise 顺序、Worker 字节传输，
以及 260 次调用在 256 个待处理调用上限和完成结果容量限制下全部结算。设备事件与调用
完成结果分别有界；超出的完成结果转成明确错误，传输暂时失败时保留原终态供 owner 重试。
关闭会话会等待权限获取、原生录音终结和精确资源释放；释放失败保留句柄，文件空间保持
可用以便完成旧录音删除，随后才关闭文件 owner。小程序主动退出返回操作 ID，宿主通过
账号管理器查询完成状态，避免处理器等待自己的 owner 关闭。物理设备验收状态不由这些测试更新。

原生 NFC 的完整 66 叶子清单和 iOS 公开框架限制分别记录在 Android/iOS SDK 的
`examples/host-services/NFC-CONTRACT.json`；它们包含锁定类型和官方头文件摘要。
鸿蒙 Wi-Fi 需显式配置用途和权限版本，详见 [接入说明](../../examples/hosts/harmony/WIFI.md)。
默认未配置时不注册；连接仅操作本 owner 创建的候选网络，取消和换号等待真实系统结果与清理。
Web 录音要求真实编码器支持请求的格式和参数，完整文件写入私有持久目录后才发布 Stop；
详见 [录音协议证据](../archived-evidence.md)。
后续 WAV 后端按实际格式协商，并使用有界 AudioWorklet PCM 与 RIFF 文件，接入与验收
边界见 [Web 录音说明](./WEB-RECORDER.md)。历史证据继续绑定原源码版本。
