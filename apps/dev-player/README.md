<a id="weapp-container-dev-player"></a>
# Weapp 容器开发玩家

**简体中文** · [English](README.en.md)


专为 **本地运行 QuickJS + 原生 Skia** 设计的 Flutter 应用程序，支持 Android、iOS、macOS、Windows 和 Linux。Flutter 提供连接和诊断 UI；小程序帧由原生 SDK 生成。设备上未安装远程帧流或 GitHub 凭证。私有 iOS 模拟器 DEBUG 包包含 Dart 源码和本地路径，仅用于私有模拟器验证，不用于生产分发。

此源码针对 **`0.1.0-preview.6.0+1`**。它保留了 preview.5 协议以实现完整的原子化宿主布局、测量导航和持久化的开发-运行回执，并要求具备准备重启测量适配器能力。不支持的旧版适配器将被明确拒绝。
被污染的视图退役将取消原生所有权，而无需再次进入客体清理流程。已验证的旧会话终止诊断仍仅限于历史记录范围；它们无法替代当前错误，或在新会话中授权输入。
匹配的 preview.6.0 原生归档、App1 构建/包及设备回归测试仍待处理。版本声明和源码/单元测试无法确立新的二进制文件、安装性或设备验收。

<a id="host-services"></a>
## 宿主服务

玩家在Guest启动前，使用证书绑定的配对发布者、已验证的项目/包和匿名开发账户安装实际的设备适配器。它在加载每个已验证更新前会授权该更新。配对令牌保留在玩家中，永远不会添加到Guest的HTTP请求中。登录/支付需要嵌入式宿主提供自己的`PlayerHostServices`实现；默认实现不会创建虚拟用户或支付结果。它明确拒绝缺少宿主服务1.0的旧运行时构件。

`PlayerModel(hostServices: ...)` 是宿主注入的入口。在首次加载前，需在此处安装可信的身份/支付处理器；未来包更新的授权无需替换公共控制器。账户变更使用 SDK 的共享账户管理器，并通过清理/呈现屏障进行处理。参见 [`host-services/INTEGRATION.md`](../../docs/host-services/INTEGRATION.md) 和 [`host-services-app`](../../examples/apps/host-services-app/README.md) 参考文档。允许的媒体/网络源默认为空且明确指定。

<a id="prepare-and-run"></a>
## 准备并运行

使用固定的 Flutter **3.47.7** 工具链和仓库的 SDK 子模块提交
在构建计算机上获取已审核的运行时二进制文件时，需要 Node/Python 和 GitHub 读取凭据。支持授权的离线归档目录。源码要求 **preview.6.0 / ABI 1**；SDK 保留的 preview.5.3 默认锁定是历史遗留的，无法满足该要求。在匹配的归档文件和已审核的 preview.6.0 清单实际存在之前，准备必须失败，而不是重用旧库。不要编辑旧的锁定文件或生产回执以使其版本看起来是当前的。

```sh
cd apps/dev-player
node tools/prepare.mjs --platform macos \
  --manifest /absolute/reviewed-preview6.0-lock.json \
  --artifact-dir /absolute/authorized-preview6.0-archives
flutter pub get --enforce-lockfile
flutter run -d macos
```

私有归档生成器支持 `--platform android|ios|macos|windows|linux`。
它需要成功发布的运行时和 SDK 回执、精确的原生功能集，以及在选定平台上的一个干净运行时源码提交。包装器生成器的提交和 `SOURCE-INVENTORY.json` 会授权精确的 Swift、Kotlin 和公共桌面头文件字节；缺少、更改或额外的包装器将被拒绝。每个 SDK 归档都会保留该库存及其摘要。Windows 和 Linux 使用 `x86_64` 归档；多架构 SDK 使用 `universal`。
Harmony HAP 和 Web WASM 使用独立的 artifact 说明文件。

```sh
pnpm dev-player:archives -- --runtime-root artifacts/dev-player/runtime \
  --platform macos --platform ios --platform android \
  --out artifacts/dev-player/runtime-archives-preview6.0
```

在支持的宿主上运行每个 SDK 提供商，收集其精确的原生输出和许可证清单，并仅选择输入完整的平台。该命令使用公共合同安装程序验证归档文件，并准备一个新的私有输出目录。它不会发布版本或更新消费者锁。有限归档测试验证了格式、源封闭性和离线提取；它们不建立原生传输、设备、GPU 或商户验收。

桌面验收可以从未绑定的归档文件中创建自己的全新安装：

```sh
node scripts/sdk-desktop-consumer.mjs \
  --manifest /absolute/reviewed-preview6.0-lock.json \
  --artifact-dir /absolute/authorized-preview6.0-archives \
  --consumer-source /absolute/exact-desktop-sdk-source --arch arm64
```

使用 `--arch x64` 时，适用于 x64 运行器或 macOS Rosetta 路径。外部 SDK 源代码仓库必须包含包装生产者的确切提交版本和已审核的清单。仅将七个明确审核过的消费者源文件纳入构建；已安装的归档文件提供所有头文件、库文件和 CMake 导出。运行时归档文件会排除示例和核心源码。`--sdk <directory>` 仍可用于目录重定位检查，这些检查结果与新归档文件安装证据分开记录。

以下 preview.5.3 / App12 的结果为历史数据，无法验证 preview.6.0 或当前 Player 源码。

预览.5.3 版本私有运行时发布包含十个经过审核的归档文件，由清单 SHA-256 `ee393000b5726172755b24a31812f9b55051e710c2714edadb9b3ac287b95388` 固定。
每个独立归档文件的审核、经过身份验证的全新下载、严格安装以及缓存重新验证均通过了所有十个坐标。原生生产者仍为 `012400d43cb20b4d91a73fbbde7e1cf11bd0bb6a`；Android、iOS 和桌面包装生产者分别为 `e4fa84e784edc1a80d972655eea347537ca40774`、`159b7e2e66aa83e952e2af43edcd771344829379` 和 `ae67dde1a104587968e2db37a9636b8776328607`。锁定-固定提交不会替换这些生产者。App12 包装已构建并独立审计。选定的 SE、Pro Max 和 iPad 模拟器测试通过了十五个阶段、三十个 C013 轮次和三个实际的被拒候选/恢复周期。Android Small 仍存在未解决的正常 View 超时问题；Large 保留了其原有的标准层次收集器故障，以及在明确修改的无空闲重跑中出现的预览取消故障。平板和可折叠设备的重跑仍待处理。详情参见 [绑定设备摘要](../../docs/archived-evidence.md)。

以下的生产者身份属于历史预览版本 5.2。
其 `prepare.mjs` 需要经过审核的 `0.1.0-preview.5.2` 分布式锁定，
SHA-256 值为 `10cf2f084601c9d0e2f06c54dcce4810527035beeee760f075b414651c67d829`，该值锁定十个精确的归档文件。
原生 Rust 运行时仍为 **preview.5.1**，由
`747d0b02131d7f67b3adbdd7127abcd5e21ffdbe` 生成。Android/iOS 封装 SDK 分别为 preview.5.2，分别由 `c8241b83017d7f5f7fd614dc34bd9fbf00230c0f` 和 `f8af959868b009b6b627c370c28983c410be7e9e` 生成；桌面 SDK 仍为 preview.5.1。锁定提交和播放器构建不会替代这些生产者。
归档验证、私有发布、播放器安装以及实际 GPU/设备的验收是独立的审核环节。不支持的目标在无旧版本回退的情况下将无法通过。该历史归档资格并未建立 App12 设备的验收。

iOS 包装器的严格全 XCFramework 字节比对失败，因为 `Info.plist` 库数组顺序发生了变化。单独的验证确认了六个原生库/头文件/modulemap 成员逐字节一致，且 plist 内容在语义上一致。严格的失败记录仍然存在；这并非设备通过。历史预览。5/5.1 运行时和 Player 回执保留了原始源提交和哈希值。有关范围及单独绑定结果，包括原始 App10 失败，请参见 [P0 正确性里程碑](../../docs/dev-player/p0-preview5.md)。[预览.4 报告](../../docs/archived-evidence.md) 仍为历史记录。构建成功并不完成五平台发布。

支持的部署基线为 Android **8.0 / API 26+**，iOS 16，macOS 12，Windows 10 x64 和 Ubuntu 22.04 x64。iOS 实际设备开发需要选择 Apple 团队和设备配置文件进行签名。Android 发布构建使用开发密钥，不是生产环境签名身份。macOS 验证、Windows 签名和 AppImage 打包需要各自独立的分发步骤。

Android 也要求一个 **64位系统 ABI**，支持 `arm64-v8a` 或 `x86_64`。
Android 7.x 以及 32 位的 `armeabi-v7a`/`armeabi` ABI 不被支持。运行 32 位 Android 系统的 64 位 CPU 不满足此要求。检查所选的 USB 设备，将 `DEVICE_SERIAL` 替换为其序列号，并在每条命令中保留 `-s` 选项：

```sh
adb -s DEVICE_SERIAL shell getprop ro.build.version.release
adb -s DEVICE_SERIAL shell getprop ro.build.version.sdk
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abi
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist64
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist32
```

SDK 版本必须至少为 `26`，且系统 ABI 列表必须包含 `arm64-v8a` 或 `x86_64`。一个报告 API 25 且仅包含 32 位系统 ABI 的 L2 设备实际上会因 `INSTALL_FAILED_NO_MATCHING_ABIS` 拒绝安装；仅降低 `minSdk` 无法提供缺失的原生 ABI。原生 SDK 还必须创建并呈现一个 GLES GPU 绘制表面。缺少驱动程序、上下文或绘制表面将明确失败，且不会提供软件回退。这些前提条件并不能保证安装、交互或性能验收。详情请参见 [Android 要求](../../docs/dev-player.md#android-安装要求)。

[Xiaomi 物理设备运行](../../docs/archived-evidence.md)
记录了 preview.3 APK 的实际 USB 安装、交互和重新加载观察结果，以及被阻断的案例和一个完整的全过程内存样本。
它未能通过完整的物理设备或性能发布矩阵。

从仓库根目录，`pnpm dev-player:build -- --platform android` 构建发布版 APK，`pnpm dev-player:build -- --platform ios --simulator` 构建调试版模拟器应用。`pnpm dev-player:package -- --help` 描述了源绑定 APK、模拟器 ZIP 和桌面打包。iOS 模拟器 ZIP 无法安装到物理 iPhone 上。打包会保留现有的签名状态，并将设备/GPU 验收记录分开记录。

[绑定源的包报告](../../docs/archived-evidence.md)
记录了最终的 Android APK 和模拟器 ZIP 文件、精确哈希值、依赖项锁定版本，以及实际安装/交互观察结果。最终的 ZIP 文件已提取，并在其上安装了重新定位的 App，该 App 安装在官方 iOS 模拟器上。Android 执行在 arm64 模拟器上进行；x86_64 版本已打包但未执行。物理设备、局域网/VPN、硬件 GPU/性能以及 Windows/Linux 窗口均未验证。macOS 播放器目前需要一个不可用的开发签名身份。在将源适配器或归档视为可用平台发布之前，请查看 [平台状态](../../docs/dev-player.md)。

Windows/Linux需要新的原生GPU预览桥接。它们之前的像素缓冲预览不会被`gpuRequired:true`自动使用。仅有一个原生桌面GPU呈现器并不能建立硬件GPU执行；这些平台在实际窗口和驱动被使用之前仍无法验证。

<a id="connect-a-project"></a>
## 连接项目

在开发计算机上：

```sh
pnpm simulator:dev -- --project /absolute/project --surface devices
```

打开播放器项目屏幕，并粘贴完整的开发连接链接。Android/iOS 可以扫描其二维码。摄像头拒绝后仍可手动连接。需要共享的局域网或现有的私有 VPN；没有公共中继。

<a id="interface-language"></a>
## 接口语言

**简体中文** · [English](README.en.md)
使用 `语言 / Language` 在项目/开发工具界面中切换。
该设置立即生效，并在下次启动时保留；播放器不会将其更改为操作系统语言。

更改播放器语言会保留运行中的小程序会话、配对、页面数据和存储。小程序标题、标签页标签和页面内容仍归属于该项目。技术标识符、错误码、业务控制台输出和原始诊断信息保留其源语言。操作系统权限对话框遵循平台的语言规则。

[语言验证报告](../../docs/archived-evidence.md)
记录了小米切换/重启观察结果以及与其他平台执行和运行时版本发布门禁分开的精确 APK 哈希值。

<a id="mini-program-window"></a>
## 小程序窗口

正在运行的小程序填充可用屏幕/窗口。移动系统栏和桌面窗口装饰保持不变；播放器标题、永久工具标签页、固定长宽比和预览边距不占用小程序空间。右上角胶囊可打开开发工具或关闭当前小程序。常规导航使用解析后的应用/页面配置；自定义导航保持胶囊覆盖在内容之上。配置的系统工具栏委托给运行时。

关闭胶囊会释放该小程序实例及其绘制表面，然后返回到项目屏幕。它保持连接、已验证的下载和持久化的 wx 存储。无需重新打开程序即可继续获取更新；再次打开程序将创建一个新实例。打开工具仅覆盖预览，不表示应用后台生命周期的切换。

见 [Chrome 合同和验证](../../docs/dev-player/chrome.md) 和
[可运行的测试用例](../../examples/apps/player-chrome-app/README.md)

连接 URI 包含 HTTPS 源、精确的证书 SHA-256、项目身份和一个短期配对代码。每个 HTTPS/WSS 会话都会绑定该精确证书。重定向和明文端点将被拒绝。生成的设备凭证将存储在操作系统安全存储中；如果存储不可用，连接将仅保留在内存中，并显示可见消息。配对链接和设备令牌不会添加到连接历史、日志或包文件中。

Android 和 Apple 的 URL 方案已配置。Windows/Linux 用户可以直接粘贴连接链接，无需进行 URL 方案注册。在安装程序中注册可选的 `weapp-container:` 方案是独立的打包操作；原生运行器已包含链接转发支持，可用于已运行应用。

<a id="update-and-diagnostics-semantics"></a>
## 更新和诊断语义

- 本地设备拥有其 AppService、View 域、页面栈和权限。
  存储通过认证服务器和项目身份进行隔离。
- 服务器发布运行身份和精确的小数生成版本。新的服务器运行会重置生成版本比对；旧的中继 HTTP 结果将被忽略。新的源更新将取代未完成的下载。
- 在发布前会检查清单原始字节、标准完整性根、精确的 blob 清单、资源大小和 SHA-256。只有完整的不可变包目录能到达原生 SDK，SDK 会再次验证它们。
- 传输限制为最多 10,000 个 blob 和 256 MiB（包含清单和 blob）。清单大小上限为 8 MiB，单个 blob 大小上限为 256 MiB；描述符响应大小仍限制在 2 MiB。
  下载使用两个工作线程。保留的缓存存储上限为 1 GiB；新安装若超过限制将被拒绝，当前应用保持激活状态。
- 安全的视图变更使用 `applyDevPack` 并保留状态。脚本/结构变更将重启应用。下载、验证和启动失败仍保留已接受的实例。激活后出现 GPU 错误不会被描述为自动恢复旧的 JS 内存；**Previous pack** 明确会重启该包。
- `started` 和 `native-acknowledged` 是不同的。原生 ACK 需要匹配的生成/帧修订版本、原生输入授权和 `gpuSurface=true`。报告中明确包含 `presentationStage` 和 `screenPresented:false`：macOS 证明 Flutter 消费了其 GPU 支持的纹理（`flutter-texture-consumed`）；其他当前适配器暴露 `native-frame-acknowledged`。这些回执不能证明物理屏幕的呈现时间戳或测量的 FPS。方法结果或 WebSocket 消息永远不会授予原生 ACK。
- 来自活动预览的 GPU 故障（包括 Metal 和纹理错误）会隐藏/脱离预览并暂停原生输入。**重试预览** 会重新挂载该会话并要求新的帧回执；**Previous pack** 会重启之前的包。下载和未提交候选失败仍保持已接受应用的运行。前台化无法静默恢复暂停的 GPU 预览。
- 断开连接或后台运行不会销毁正在运行的应用。后台运行会停止重连定时器并使未完成的更新失效；前台运行会重新连接并获取最新生成版本。桌面退出等待 SDK 关闭。
- 检查器仅在请求时获取页面数据。进程 RSS 被报告为进程内存，包括 Flutter。FPS 保持为 **未测量**，直到实际的原生呈现遥测数据提供；它不会通过轮询推断得出。

**清除下载的包** 会关闭原生会话并删除该项目的下载缓存；它保留 wx 存储。**清除本项目的 wx 存储** 使用原生存储命令并等待其持久化；现有页面内存会保留，直到显式重启。缺少任一命令的旧版本运行时将明确失败。

设备 `localhost` 指的是该设备本身。将开发后端请求指向计算机的局域网/VPN地址。播放器不会重写应用 URL 或通过开发服务器代理任意请求。

<a id="tests"></a>
## 测试

```sh
flutter analyze --no-pub
flutter test --no-pub
```

测试涵盖错误的配对链接、版本和大小限制、清单/哈希/根验证、渲染器拒绝、CAS重用、已取消/损坏的更新保留旧字节、服务器运行身份，以及已安装文件的篡改。真实的临时 HTTPS/WSS 测试涵盖证书固定、承载范围、重定向拒绝、撤销和响应边界。它们仅创建和移除自己的临时证书/监听器。协调器测试将此真实传输与注入的原生边界结合：方法完成无法冒充呈现，启动控制台仅保留已接受的候选者，失败的项目切换会保留已接受的控制器。应用心跳确认保持空闲连接存活；保留的项目不能在其他项目的配对下进行报告或回滚。原生诊断收集对本开发版播放器为可选。这些测试不执行原生运行时、扫描器、GPU 窗口、移动设备、钥匙串、签名或性能验收。
