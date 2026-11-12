<a id="five-end-native-development-client"></a>
# 五端原生开发客户端

**简体中文** · [English](dev-player.en.md)


Weapp Container Dev Player 使用 Flutter 提供连接、项目、日志和设置界面，小程序在设备本地通过原生 QuickJS＋Skia SDK 执行。Android、iOS、macOS、Windows、Linux 均有源工程；各平台安装、硬件 GPU、交互和性能是否通过，以[冻结验收清单](dev-player/gates-v1.json)及其逐项证据为准。

当前 Player 为 `0.1.0-preview.5.7+17`（App17），匹配的原生归档、Android APK 与 iOS Simulator ZIP 已实际构建。Android 小屏、大屏、平板和 iPhone SE、Pro Max、iPad 六类模拟设备已完成选定 P0 用例；通用折叠屏、Pixel Fold 仍待修正测试方法后的十轮验收，整个阶段尚未完成。preview.5.7 尚未发布，独立私有下载未完成，六 SDK 默认锁仍为 preview.5.3。精确来源与限制见 [2026-11-02 阶段记录](archived-evidence.md)；本代继续实施[完整布局、导航、View 故障与开发更新正确性里程碑](dev-player/p0-preview5.md)。

以下 preview.5.3／App12 为历史记录，不覆盖本代：preview.5.3 私有运行库及 App12 已完成分发和安装包审查；SE、Pro Max、iPad Simulator 共十五个选定阶段通过，包含三十轮导航旋转与三次失败候选及恢复。Android 小屏正常 View 超时、大屏预览取消仍为失败，平板及折叠屏新包回归尚未执行。[本轮限定证据](archived-evidence.md)保留原失败、安装资格说明及准确源码绑定，不能替代全部设备与性能门禁。此前 preview.4 引入[小程序式全屏界面与胶囊](dev-player/chrome.md)，其原始证据继续保留。仓库及交付物保持私有，CI 仅手动触发。

2026-10-29 的 [preview.4 实测记录](archived-evidence.md)包含小米真机与 iOS 官方模拟器、私有运行库发布和准确源码绑定。全屏、胶囊、导航、关闭重进与安全热更新已有实测；旋转时胶囊 API 观测和启动失败后的接受版本恢复仍有真实失败项。macOS 缺开发签名，Windows/Linux 缺实际窗口环境，因此当前不是五端完整验收通过版本。

此前 preview.3 的交付和验收边界如下；它们不升级为本轮界面验收：

| 平台 | 本轮结果 | 尚需完成 |
| --- | --- | --- |
| Android | 已生成 arm64/x86_64 APK；arm64 官方 Emulator 实际连接、点击、热更新及一次后台恢复 | 手机真机、x86_64 实际执行、LAN/VPN、硬件 GPU 与性能 |
| iOS | 已生成 arm64/x86_64 Simulator ZIP；从最终 ZIP 安装并在官方 Simulator 实际连接、点击，另有热更新观察 | 开发签名真机安装、LAN/VPN、硬件 GPU 与性能 |
| macOS | 源工程及固定 Metal SDK 已接入 | 本机无有效开发签名身份，Player 构建与实际窗口验收受阻 |
| Windows | child HWND/WGL 预览适配及打包入口已有源码 | preview.3 运行库、Windows 构建、真实窗口/驱动及安装包 |
| Linux | GtkGLArea 预览适配及 AppImage 打包入口已有源码 | preview.3 运行库、Ubuntu 构建、X11/Wayland 窗口/驱动及 AppImage |

这些是分项辅助观察，46 项冻结门禁仍为 40 项 unknown、6 项 blocked；尚未通过五端完整验收。

<a id="interface-language"></a>
## 界面语言

Player 默认使用**简体中文**，也支持 **English**。在项目／开发工具界面的“语言 / Language”入口切换后立即生效，并保存选择供下次启动恢复；不会根据系统语言自动改选。

切换语言不重启正在运行的小程序，也不改变配对、页面数据或持久存储。小程序自身的标题、tab 文案和页面内容由项目决定。技术标识、错误码、业务 console 和原始诊断保持原文；系统权限弹窗遵循操作系统的语言规则。语言功能的本地验证单独记录，不改变上述历史设备证据或五端发布门禁。

[中英文验收记录](archived-evidence.md)包含小米上的切换、重启及升级恢复截图和精确 APK 哈希；本轮 Player 113 项测试通过。其他平台的实际界面验收仍须分别执行。

后续[多分辨率、平板与折叠屏验收](archived-evidence.md)单独记录 Android Emulator 与 iOS Simulator 的真实项目交互及版本绑定。宿主 tabBar 和普通导航栏按实际无障碍字体行高扩展；内容区域和输入原点沿用同一测量结果。该历史版本的 128 项 Flutter 测试通过，历史语言验收仍绑定其原版本。旋转回调的窗口／胶囊原子性及原生 View 超时另列失败，不因界面测试通过而升级。

<a id="start-up-build-and-device-services"></a>
## 启动构建与设备服务

先按[模拟器文档](simulator.md#开发态监督器)准备固定版本的 `vendor/weapp-vite` 及其构建依赖。在开发电脑运行：

```sh
pnpm simulator:dev -- --project examples/apps/reference-app --surface devices
```

该入口复用 release 构建脚本与同一个 `DevSupervisor` watcher；modern View 协调、不可变 snapshot、pack 校验完成后才发布。它不在电脑启动 AppService 或预览窗口，每台设备拥有自己的 session、页面栈、数据、定时器、权限和存储。

默认设备 HTTPS/WSS 监听 `0.0.0.0:5180`，管理面板只监听 `127.0.0.1:5179`。多网卡或 VPN 时显式选择客户端可达地址：

```sh
pnpm simulator:dev -- --project /absolute/project --surface devices \
  --device-host 0.0.0.0 --device-port 5180 \
  --device-advertise-host 192.168.1.20 --port 5179 --open
```

`--device-host` 是服务绑定 IP；`--device-advertise-host` 是配对连接内的 LAN/VPN 地址；`--port` 是本机管理面板端口。未指定 advertise 地址时选第一个非内部 IPv4；请核对终端打印的 endpoint。`--wv-bin`、`--node-bin`、`--route` 和 `--out-dir` 可显式指定。`--engine v8`、WebView/browser/software 模式，以及电脑侧 viewport/render-scale/fps/data-json 覆盖在 devices 模式中明确拒绝，且不启动 watcher；设备提供实际窗口、密度及启动状态。

首次启动打印两分钟内有效的一次性连接。管理面板的“生成配对连接”会生成新二维码/连接并替换旧凭证。扫码仅用于 Android/iOS；拒绝相机权限后仍可手动粘贴。桌面直接粘贴连接。

服务证书和已配对设备的 token 哈希保存在项目忽略目录 `.weapp-container/device-server/`。每个连接固定验证二维码携带的证书 SHA-256，无需更改系统 CA 或关闭 TLS 验证。设备凭据独立、可撤销，管理面板可撤销设备并关闭其 WSS。GitHub token 只用于构建机下载运行库；设备连接、pack、日志和安装包不携带它。

<a id="prepare-and-start-the-player"></a>
## 准备和启动 Player

固定 Flutter 为 **3.47.7**。当前源码要求 **preview.5.7 / ABI 1**，以及完整布局、导航准备、执行健康、开发操作收据和 prepared-restart 测量能力；只有 chrome 协议 1.0 不足以满足当前 Player。用户设备无需 Rust、Node、核心源码或 GitHub 登录；下列命令运行在构建机。

App17 与匹配的 preview.5.7 原生归档已构建并完成本地离线审查，尚未完成新版本私有发布及独立授权下载。各 SDK 的默认锁仍为 preview.5.3，不能用于当前源码；本地准备须显式提供已审查的 preview.5.7 manifest 与对应归档，不得仅改旧锁版本或复用旧二进制。旧锁、原始生产者和历史证据保留原字节；本地离线安装不代替真实鉴权下载。

构建机通过 `WEAPP_CONTAINER_RUNTIME_TOKEN` 提供仅运行库私仓读取凭据。取得实际新锁后，使用新的输出目录并显式传入它：

```sh
pnpm dev-player:build -- --platform android \
  --manifest /absolute/reviewed-preview5.7-lock.json \
  --out artifacts/dev-player/player-preview57-v1
pnpm dev-player:build -- --platform ios --simulator \
  --manifest /absolute/reviewed-preview5.7-lock.json \
  --out artifacts/dev-player/player-preview57-v1
pnpm dev-player:build -- --platform macos \
  --manifest /absolute/reviewed-preview5.7-lock.json \
  --out artifacts/dev-player/player-preview57-v1
```

上述路径指构建机上实际审核的本地文件，不表示 preview.5.7 已可从远端下载。离线准备须再传入 `--artifact-dir /absolute/authorized-preview5.7-archives`；仍校验实际版本、ABI、SHA-256 和切片，缺少匹配产物时明确失败。iOS `--simulator` 构建生成 debug Simulator App，不产生真机 IPA；真机和桌面签名仍按平台单独验收。已有经过验证的本地 preview.5.7 桌面 SDK 时：

```sh
node sdk/flutter/native_desktop/prepare.mjs \
  --target macos --from /absolute/preview5.7-desktop-sdk
cd apps/dev-player
flutter pub get --enforce-lockfile
flutter run -d macos
```

SDK 下载与安装缓存按已验证的版本、组件、平台、架构和 SHA-256 隔离。升级不会复用旧平台目录或覆盖旧缓存；包装层只在新安装通过后原子替换。包校验与默认归档重验采用同一寻址规则，损坏缓存或错误哈希仍明确失败。

<a id="android-installation-requirements"></a>
### Android 安装要求

当前 Player 要求 **Android 8.0 / API 26 或更高版本**，以及支持 `arm64-v8a` 或 `x86_64` 的 **64 位 Android 系统 ABI**。Android 7.x、`armeabi-v7a` 和 `armeabi` 不受支持。CPU 标称支持 64 位不等于已安装的 Android 系统能运行 64 位应用；部分设备使用 64 位 CPU 搭配 32 位系统，仍无法安装当前 APK。

安装前对目标 USB 设备检查系统版本和系统实际公开的 ABI。将 `DEVICE_SERIAL` 替换为目标设备的序列号，每条命令保留 `-s`，避免多设备时误选：

```sh
adb -s DEVICE_SERIAL shell getprop ro.build.version.release
adb -s DEVICE_SERIAL shell getprop ro.build.version.sdk
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abi
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist64
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist32
```

`ro.build.version.sdk` 必须至少为 `26`，系统 ABI 列表需包含 APK 提供的 `arm64-v8a` 或 `x86_64`。系统只公开 `armeabi-v7a`/`armeabi` 时不兼容，不能用 CPU 型号或“64 位处理器”宣传替代 ABI 检查。已有 L2 实机安装前置检查同时发现 API 25 和仅 32 位系统 ABI，实际安装返回 `INSTALL_FAILED_NO_MATCHING_ABIS`；单独降低 `minSdk` 无法补齐缺失的原生 ABI，也不会让该设备满足当前支持要求。

Player 还要求原生 SDK 能创建并呈现 GLES GPU surface。GPU 驱动、上下文或 surface 不可用时明确失败，不自动回退到软件渲染。满足版本与 ABI 只表示通过安装前置要求；安装、首帧、交互和性能仍需逐台设备验证。

小米 / HyperOS 的“USB 安装”是独立于“USB 调试”的开关。本次设备最初返回 `INSTALL_FAILED_USER_RESTRICTED` 且没有安装确认弹窗；用户在手机上开启 USB 安装后，正常安装成功。需要在设备上完成系统授权，电脑重试本身不会解除限制。APK 的 `targetSdk 36` 是目标版本，最低安装要求仍为上述 `minSdk 26`。

2026-10-29 的[小米实机报告](archived-evidence.md)绑定同一份 preview.3 APK：53 个用例中 16 个通过、9 个阻塞、28 个 unknown。已实测原生首帧、页面／组件／slot 触摸、滚动、导航、后台恢复、热更新、构建失败时旧页面交互、上一版本及撤销配对。USB 连接没有替代 LAN/VPN、相机或性能验收。混合场景单次内存样本 PSS 约 464 MiB、RSS 约 599 MiB，尚未满足移动端内存门槛；冻结的发布门禁保持原状态。

Android 默认使用固定 Flutter 声明的 NDK。构建机可显式选择已安装并独立验证的精确版本：

```sh
pnpm dev-player:build -- --platform android \
  --manifest /absolute/reviewed-preview5.7-lock.json \
  --android-ndk-version 27.1.12297006
```

该选项只对 Android 有效，透传 Gradle 属性 `weappContainerNdkVersion`，并写入 `build.json` 的 `androidNdkOverride`。显式选择通过 AGP 的 `finalizeDsl` 同时应用于 App 和全部 Android library 子项目，包括 JNI 插件，避免它们各自选择不同 NDK；不修改第三方源码。未指定时该字段为 `null`，保留 Flutter 默认值。脚本不会探测可用版本后自动降级，选定版本缺失时构建仍须失败。选择其他 NDK 不替代原生 AAR 的 ABI、16 KiB 对齐及设备 GPU 验收。

Player Android wrapper 明确固定 **Gradle 9.4.1 `bin`**，替换原 9.3.1 `all`，并校验官方发行 SHA-256。`bin` 包含构建所需工具，省去源码与文档下载；这属于显式工具升级，不使用未校验的历史下载片段。AGP 9.1.0 的最低 Gradle 为 9.3.1；[Kotlin 官方兼容表](https://kotlinlang.org/docs/gradle-configure-project.html)规定 KGP 2.4.0 支持 Gradle 7.6.3–9.5.0、AGP 8.5.2–9.1.0。已解压的本地 Gradle 缓存不会被 wrapper 重新校验归档哈希；新下载使用 `distributionSha256Sum` 校验，编译与设备验收另外记录。

最终 APK 只打包 `arm64-v8a`、`x86_64`。Flutter 的默认 fat-APK ABI 清单会覆盖普通 DSL 过滤，因此 Player 显式设置官方 `disable-abi-filtering` 属性，使用自身的 `defaultConfig.ndk.abiFilters`。归档检查保留了首次过滤无效的失败，后续最终 APK 已验证只含这两种 ABI；2026-10-28 的安装交互验证使用 arm64 Android Emulator；下述 2026-10-29 报告另行记录小米 arm64 实机，均不能据此宣称 x86_64 设备交互通过。

Android、iOS、Windows、Linux 的工程、准备脚本和平台限制见 [Player README](../apps/dev-player/README.md)。Android 为 8.0 / API 26+ 且需上述 64 位系统 ABI；其他平台基线为 iOS 16、macOS 12、Windows 10 x64、Linux Ubuntu 22.04 x64。Windows 使用 child HWND/WGL OpenGL 3.3，Linux 使用 GtkGLArea/OpenGL 3.3，原生预览与 Flutter 工具面板分栏；缺合格驱动明确失败。Apple 使用 Metal，Android 使用 GLES；Player 显式要求 GPU，软件路径不能代替验收。

iOS 真机需要 Apple Team、签名和 provisioning；APK 当前开发签名不代表生产签名。macOS notarization、Windows 签名、Linux AppImage 组装分别验收。没有证书时记录分发阻塞，不改变系统安全设置。构建脚本只记录编译，不能据此报告安装或首帧通过。

<a id="mobile-installer-already-generated"></a>
### 已生成的移动安装包

以下包表与发布失败为 preview.3 历史记录，保留原字节与结论。当前 App17 的安装包身份和限定验收见[阶段记录](archived-evidence.md)，不能使用下表旧包替代。

最终源码 `ad67b974` 的构建、打包、依赖和安装证据见[安装包报告](archived-evidence.md)。大型二进制保存在忽略的 `artifacts/dev-player/packages-final/`，不进入 Git 历史。两份包均使用 submodule 的精确 preview.3 锁：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `android/WeappContainerDevPlayer-android.apk` | 92,423,918 | `80d3e8414af9bfda7a1cd3c2d87498493b3dafb4dad61b87e7bf12f1bc635b7d` |
| `ios/WeappContainerDevPlayer-ios-simulator.zip` | 78,199,120 | `e22833af389819c0966476efa10abc8f085468624ab93e462cf8e0e8ad7bb718` |

独立 Player 私有发布 `dev-player-v0.1.0-preview.3` 尚未完成：[发布失败回执](archived-evidence.md)记录 Android 已获 GitHub 资产大小及 SHA-256 确认；iOS 全部字节发送后收到 HTTP 408，未获完整接收确认。该发布保持 draft，后续资产未继续上传，未启动整包重试。上表是本地完整安装包身份，不能作为远端下载成功的证据；已发布的 `runtime-v0.1.0-preview.3` 是另一份运行库发布，不受本次 Player 上传失败影响。

Android APK 的 v2 签名和 16 KiB ZIP 对齐另有实际校验；签名身份为 Android Debug。打包器本身不执行签名验证，所以保留原 `package.json` 的 `not-verified`，不改写为通过。最终 APK 与此前 `721d14b9` 实际运行的 APK 字节一致；旧 UI 观察仍绑定原源码。

iOS ZIP 使用 ad-hoc 签名，包含 Simulator debug App；它不能安装到物理 iPhone。解压后以已选择的官方 Simulator UDID 安装，不操作其他模拟器：

```sh
ditto -x -k WeappContainerDevPlayer-ios-simulator.zip /absolute/player-extracted
xcrun simctl install <已启动的模拟器-UDID> /absolute/player-extracted/Runner.app
```

Android 可在 Android Studio 的 Device Manager 选择目标 Emulator，再将 APK 拖入其窗口；手机安装另需用户的设备授权。Player 启动后，在 Tools & console 粘贴构建服务打印的连接，或使用相机扫描配对码。安装和配对不会授予 GitHub 访问权限。

<a id="download-run-and-hot-update"></a>
## 下载、运行和热更新

连接协议见[设备协议 v1](dev-player/protocol-v1.md)。Player 只下载缺失 CAS blob，校验原始 manifest 哈希、规范化 root、精确引用/尺寸和 blob SHA-256，再原子发布本地 generation。两个下载 worker、每 pack 256 MiB/10,000 blob、单 blob 256 MiB、缓存 1 GiB 上限均为显式边界，超限保留已运行版本。

`runId` 区分服务每次启动；同一 run 内 generation 单调增加，跨 run 重新同步。迟到 HTTP 结果、旧下载和旧呈现收据不能覆盖新状态。断线继续运行已接受 pack，重连补齐最新；后台暂停重连、使未完成更新失效，前台重新同步。服务关闭后 watcher、sidecar 和所属连接依次退出。

SDK 的 `pack.devReload.protocolVersion="1.0"` 是必需能力。共享分类器判定安全的 WXML/WXSS/静态资源修改使用 `inPlace`，保留 JS/session、页面栈、数据、storage 和定时器；脚本、配置、组件/依赖图或不安全 WXS/组件关系变更使用 `restart`，保留持久存储。旧运行库无此能力时明确拒绝。

下载、校验和启动接受前失败保留当前实例；新实例接受后的 GPU 失败暂停输入，显示重试/上一包入口。上一包会重新启动，不能恢复旧 JS 内存。“已连接”“已下载”“已验证”“已启动”“已呈现”分开报告；HTTP/SDK 方法成功都不能作为实际 GPU 呈现凭据。

“清除下载包”先关闭 session，只移除当前项目下载缓存，保留 wx storage；“清除项目 wx storage”走原生命令并等待持久化，当前页面内存直到重启才改变。各设备的 storage key 按认证服务和项目身份隔离。

<a id="logs-checks-and-performance-boundaries"></a>
## 日志、检查和性能边界

Player 显式启用 `devDiagnostics:true`，从真实业务 console 接收有界日志；普通 SDK session 默认关闭此采集。候选启动日志仅在 pack 接受后展示，失效候选不会污染当前项目。电脑面板按 deviceId 展示连接阶段及上报记录；本地日志/错误会裁剪并隐去连接串和设备凭据。

页面数据检查按用户操作获取 `devState`，只读，不提供任意远程 JS 执行。电脑管理面选择设备后点击“查看数据”，通过该设备的一次批量请求读取已接受项目的页面数据；请求收据、等待、失败和结果分别展示。检查绑定 project/run/generation，断线或更新后旧快照失效；每设备一个在途请求，超时 5 秒，结果最多 48 KiB、32 页、2,048 节点及 12 层。敏感键和已知凭据文本遮盖，不导出 storage、配置或任意运行库状态，快照不进入日志。规则无法识别普通字段中的任意业务秘密；请勿将敏感业务数据放入页面 data。

设备服务保留原始错误栈，并按已接受的 project/run/generation 和已验证 CAS 提供受限 source-map 定位；支持精确模块路径的同名 `.map` 及 modern View，不能识别的 eval/basename 帧明确保留未映射。详见[协议边界](dev-player/protocol-v1.md#只读-source-map-定位)。源码断点和真实设备的电脑端定位验收仍未完成。当前阶段指标是下载＋校验、运行库 apply 与下载字节；进程 RSS 包括 Flutter。FPS 在缺少真实呈现遥测时显示“未测量”，不能以轮询率推算。输入到呈现、GPU、包体和性能门槛仍需真实设备/窗口样本。

业务网络从设备直接发出。手机上的 `localhost` 指手机本身；电脑开发后端应绑定可访问接口，并让小程序使用电脑 LAN/VPN 地址。Player 不改写 URL，不代理任意网络，也不提供公网中继。

<a id="acceptance-and-delivery"></a>
## 验收与交付

本轮已记录一组[辅助验证证据](archived-evidence.md)：`78663746` App 在官方 iOS Simulator 中显示参考小程序，实际点击使页面及组件计数变化；WXML generation 2 保留计数，JS generation 3 重启并重置计数，旋转后页面收到 `onResize`。这些观察绑定原 App/native/SDK 与原始截图，不能据此升级真机、硬件驱动、屏幕呈现时间戳或 FPS 验收。旧 UI 的长构建错误导致 RenderFlex 溢出，失败截图完整保留，不算“旧预览仍可用”通过。

后续 `eda22875` 的提交/取消/未知状态恢复有 54 项模型测试，`f6901699` 的有界诊断区有 57 项模型及 widget 测试；对应 iOS 编译收据分别记录。旧归档检查点的发布/安装待办保持原文，新结果分别记录，不能给旧截图重新绑定提交。

[新双设备证据](archived-evidence.md)包含 `f6901699` iOS 长构建错误下仍可点击旧预览、Android/iOS 同时接收 generation 4 的 WXML 更新并保留各自计数，以及 generation 5 JS 更新后分别重启归零。`721d14b9` Android APK 已安装到 arm64 API 30 Emulator，真实点击与一次后台恢复保持计数；开发签名、ZIP 对齐及精确 APK 哈希独立记录。Android 的连接使用本任务 `adb reverse`，iOS 为本机 Simulator；这不是 LAN/VPN 或物理设备验收。NDK 28.2.13676358 的官方完整包校验、安装及失败/中断历史见[工具链回执](archived-evidence.md)。

[私有发布与独立 SDK 验证](archived-evidence.md)分别记录 10 个真实只读远端下载、10 个缓存复验、104 项 SDK Node 回归，以及独立克隆中的 27 次离线安装/拒绝检查；它们不能互相替代，也不表示设备执行通过。[资源清理回执](archived-evidence.md)记录本任务配对撤销、模拟器和服务退出，原有设备及 `58730` 服务保留；DeviceHub 窗口关闭结果仍为 unknown。

macOS 签名、Windows/Linux 真实窗口与安装、LAN/VPN、物理设备、硬件 GPU 及性能仍待相应环境和证据。46 项冻结门禁仍有未完成检查，不因这些辅助观察升级为五端发布通过。

冻结清单分协议、macOS、移动端、Windows/Linux、五端联调四阶段；只有源绑定的相应证据才能改变状态。Rust/Flutter/Node 单测不能替代真机、窗口、驱动、安装、签名或性能，preview.2 报告不能绑定新源码。本轮不升级微信 near-parity 或七宿主双渲染完成状态。

<a id="preview5-correctness-milestone"></a>
## preview.5 正确性里程碑

本轮完整布局事务、目标导航测量、执行健康与开发更新收据见 [P0 实施与验收](dev-player/p0-preview5.md)。新源码必须使用匹配的 preview.5 二进制和 SDK；版本声明不代表已经完成发布或设备验收，具体状态以该页及 source-bound 回执为准。preview.4 原始产物与失败证据继续保留。
