<a id="harmonyos-host-sample"></a>
# HarmonyOS 宿主示例

**简体中文** · [English](README.en.md)


此 DevEco Studio/ArkUI 示例为每个执行实例嵌入一个稳定的账户控制器，并为每个实例配备独立的原生拥有者。`Index.ets` 管理其 ArkUI 绘制表面，并将窗口、指针和前台事件转发给当前的 `session/LiveSession.ts`；`session/PortablePack.ts` 加载捆绑的便携包。`native_bridge.cpp` 通过一个 N-API 模块暴露 Rust 宿主。所有原生句柄操作均保留在 ArkUI 执行线程上，与 Rust 运行时的线程亲和性保持一致。

启动时在替换原生会话前会验证完整包，选择请求的路由（或第一个声明的路由），并发送 `app.init → app.lifecycle(launch) → page.push → render.commit`。渲染请求包含已验证的资源批次和视口，不包含伪造的页面数据对象。AppService 提供当前页面状态；`inspectState()` 是回执路由、数据和已提交帧的权威来源。原生确认必须与会话、请求、操作和协议匹配。如果引擎不可用或交易被拒绝，将暂停所有者并提供诊断信息，而不是发布成功帧。

第一个安装的运行时暴露了 Skia 字形缺失的问题，并且在操作系统触摸后未观察到页面状态变化。其
[原始失败证据](../../../docs/archived-evidence.md)
仍被保留。宿主现在在发布会话前会先安装公共平台字体字节，并使用一个透明的 ArkUI 输入平面，其几何形状与原生绘制表面完全一致。仅凭 `ready` 回执仍不能证明视觉正确性或用户交互。
后续的 QuickJS 参考运行通过了实际的 OS 输入、定时器以及同会话背景/恢复操作，并能显示可读的拉丁文字；原始失败情况、截图及源码绑定限制详见
[字体和交互证据](../../../docs/archived-evidence.md)。

渲染器拥有解码后的字体面以及有界正/负字形缓存，其生命周期与会话一致，由页面、Canvas 和原生 GPU 绘制共享。Harmony 会在每个宿主中读取一次 `/system/fonts/HarmonyOS_Sans.ttf` 和 `/system/fonts/HarmonyOS_Sans_SC.ttf`，并进行有界的常规文件验证。缺少或无法解码的字体将拒绝替换会话并返回 `ERR_RENDER`；前一个会话保持不变。字体文件是系统资源，而非仓库、小程序或 HAP 资产。所检查的 `nativeFonts` 字段描述了已解码的字体面，但不声称包含未经测试的字形。

示例明确选择了 QuickJS。宿主只有在其 Rust 库使用相应的引擎构建时，才能在会话选项中选择 V8；不存在静默降级。兼容性入口点 `loadManifest`、`start`、`dispatch`、`snapshot` 和 `canvasSnapshot` 仍然可用，但活跃的所有者使用 `loadManifestWithConfig`，并负责启动和关闭。

样本的 `entry/src/main/resources/rawfile` 包含一个小型已检出的可移植包，该包由标准的 `artifacts/reference` 包生成。启动时，包加载器读取 `manifest.json` 以及每个声明的模块、模板、样式、资产、WXS 源代码和可执行 View 资源，通过 `resourceManager.getRawFileContentSync`。在打开原生会话之前，它会检查每个数据块的 SHA-256 值；Rust 仍然是manifest架构、完整性根和运行时验证的权威。桥接操作通过 N-API 发送整个批次，没有节点级调用。在生成新包后，通过以下方式刷新资源包：

```sh
node scripts/sync-harmony-pack.mjs --pack artifacts/reference
node scripts/sync-harmony-pack.mjs --pack artifacts/reference --check
```

每个 manifest `render.commit` 都携带了该包已验证的资源闭包，
包括指针输入、定时器、前台变化和调整大小之后的情况。一个仅宿主的资源复用标志无法替代运行时的实际 manifest 渲染合约。宿主省略了页面数据，因此 AppService 在这些刷新中始终是其所有者。

pack sync 命令在复制之前会验证清单架构、完整性根以及每个模块/模板/样式/资产引用。它仅会修改生成的 `rawfile/manifest.json` 和 `rawfile/blobs/sha256` 文件；其他 Harmony 资源保持不变。复制的包是宿主烟雾测试的输入fixture，不会将软件快照或 ArkUI 设备上下文探针转化为 GPU/设备一致性证据。

示例导入了 N-API 绘制表面，使用 `import * as native from 'libentry.so'`。
ArkTS 编译器目前会发出一个关于未验证模块的信息性警告；命名空间导入会编译并运行在打包的 N-API 模块上。

原生库明确提供给 CMake。仓库构建入口发现 DevEco、rustup 目标工具链和 OpenHarmony clang：

```sh
node scripts/build-native-hosts.mjs --build --platform harmony \
  --out artifacts/native-host-build-harmony.json
```

该集成命令启用了 `quickjs-native-harmony`（rquickjs bindgen）以及 GLES 渲染器。只有当 OHOS 编译器、sysroot 和宿主工具链覆盖均生成有效产物时，才会记录传入的目标构建；但该结果仍不能证明模拟器或设备行为的正确性。它强制使用 Cargo.lock 固定的 Skia 源码构建，包含捆绑的 FreeType 和自定义空字体管理器，并在平台默认值之后使用上游 `SKIA_GN_ARGS` 钩子。外部 Skia 源码/库覆盖和仅用于文档的伪绑定均被拒绝。不会对已安装的 Cargo 仓库源进行修补。对于此条目，保持 `CARGO_TARGET_DIR` 未设置：当前产物发现使用仓库的默认 `target` 目录。

使用官方 SDK 编译 ArkTS 并打包一个未签名的 HAP，每次运行都使用一个新的输出目录：

```sh
node scripts/build-harmony-hap.mjs \
  --out artifacts/harmony-hap-local \
  --pack artifacts/reference \
  --bundle com.sonofmagic.weappcontainer.local \
  --sdk /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony \
  --rust-lib target/aarch64-unknown-linux-ohos/debug/libcontainer_host_harmony.so
```

构建器将项目快照到运行目录中，创建一个私有的、版本化的 SDK 布局，指向已安装的 SDK，并使用官方的 Hvigor 工具调用 `--no-daemon`。它记录命令日志、源码/Rust 库的哈希值以及未签名 HAP 的哈希值到 `build-report.json` 中。它保留源项目，并不进行安装、签名或启动 HAP。`--pack`、`--bundle` 和 `--rust-lib` 选择明确的输入项；只有在官方编译器生成预期的 HAP 后，打包才会成功。SDK 编译证明了编译/打包的边界；运行时、操作系统交互和 GPU 验收需要各自独立的证据。

对于可分发的预览归档包，使用 `--profile release` 从同一个干净提交构建两个层。HAP 生产器还要求在 `build-native-hosts.mjs` 中使用 `--native-receipt PATH`；调试库和没有源码、配置文件及制品哈希值的旧回执将被拒绝。两个工具都接受 `--source-root PATH` 以读取单独的干净源码检出，同时独立记录归档/构建工具的身份。请将输出保留在该检出目录之外，以免生成的报告污染其源码身份。独立的 HAP 说明文件、精确字节安装器以及剩余设备验收边界在
[`docs/platform-runtime-artifacts.md`](../../../docs/platform-runtime-artifacts.md) 中有详细说明。

构建器将复制模块的
`buildOption.externalNativeOptions.arguments` 设置为所选的 Rust 库。
Hvigor 的通用 `-p nativeArgs` 属性不会将该值传递给 CMake；否则，仓库内构建可能会意外使用 CMake 的仓库相对默认值成功。隔离构建没有这样的备用方案。

该命令是可重现的集成入口，而非设备声明。DevEco 必须提供 OpenHarmony NDK 和 ArkUI/N-API 库；CI 在缺少这些 SDK 时使用 Rust 跨目标检查，并验证项目文件。

实时会话行为契约在没有设备的情况下运行：

```sh
node --test scripts/harmony-live-session.test.mjs scripts/sync-harmony-pack.test.mjs scripts/harmony-native-surface.test.mjs
```

这些测试从生产会话/包 TypeScript 中移除类型，并在仪器化的原生边界上执行它。
它们涵盖启动顺序、检查页面状态、批处理指针事件、定时器时钟、生命周期、尺寸调整和故障清理。
它们不能替代官方的 ArkTS/NDK 构建、已安装 HAP 的运行、Skia GPU 证据或设备交互。
原生绘制表面测试使用宿主 C++ 编译器，将未修改的生产 `RenderSurface` 函数编译到一个仪器化的 EGL 边界中。它在尺寸调整销毁、分配、绑定和查询失败后检查所有权身份；它不打开原生窗口，也不是驱动执行的证据。
它们使用 Node 的原生 `stripTypeScriptTypes` API（Node 22.13+），执行后会移除临时模块；无需安装上游 npm 依赖。清单 CI 任务运行 `pnpm host:harmony:live:test`，该任务也使用宿主 C++ 编译器编译和执行原生小数参数解析器合约。

对于已安装应用的交互烟雾测试，构建一个专用的 HAP，包含之前不存在的包，例如 `com.sonofmagic.weapp.container.smoke1234abcd`，然后运行：

```sh
node scripts/harmony-app-smoke.mjs \
  --target 127.0.0.1:5557 \
  --hap /absolute/path/to/entry-default-unsigned.hap \
  --build-receipt /absolute/path/to/build-report.json \
  --bundle com.sonofmagic.weapp.container.smoke1234abcd \
  --out-dir artifacts/harmony-os-interaction \
  --tap-x 250 --tap-y 520 --engine quickjs
```

使用包含 `count`、`timerCount`、`microtaskCount` 和 `lifecycleTrace` 的参考交互包；默认检入的包不是该测试用例。为连接的设备选择物理点击坐标。该工具包在实际操作系统输入之前，会检查 HAP 哈希、SDK 回执、唯一拥有的 PID/启动时钟、前台布局和绘制表面边界。它会验证输入/定时器状态以及同一会话中的显示/隐藏操作，并保存操作系统的 PNG 图片以便独立进行视觉审查。其 `finally` 清理操作仅移除该运行之前不存在的包和精确的远程捕获路径，保留借来的模拟器、现有应用和全局日志。它从不将捕获的截图重新标记为视觉上通过。模拟所有权、失败、PNG完整性及清理合约在运行 `pnpm host:harmony:app:test` 时执行，且不会替换已安装的运行。

为了生成运行时证据，从 DevEco 构建并安装 HAP，并在模拟器或设备上与示例交互时捕获会话回执。检查启动、输入、定时器、隐藏/显示和调整大小操作是否保持相同的会话，且被检查的页面/帧版本应与呈现的帧一致。回执记录了观察到的原生状态和有限操作历史；它并不能证明操作系统事件已发生。`hdc shell echo` 仅能证明目标可达，不是原生容器证据。

样本的 `XComponent({ type: 'surface', libraryname: 'entry' })` 从 `XComponentController` 获取表面 ID。`attachSurface` 创建一个 `OHNativeWindow`、EGL ES 3 上下文和窗口表面；`renderSurface` 提交最新的 Rust Skia 帧并调用 `eglSwapBuffers`。逻辑视口的更改会先经过原生重置边界，再进行下一次显式渲染。表面的物理像素尺寸与逻辑视口保持独立。宿主目前发布观测到的逻辑视口，而系统信息（包括像素比、屏幕尺寸、状态栏高度和安全区域）仍不完整，可能使用提供方的默认值。单指触控的按下/移动/抬起/取消事件通过桥接作为 `event.batch`；拥有者可识别有限范围的轻触。多点触控、滚动和长按手势识别需要进一步实现和合规性证据。

前景轮询使用以 Unix 时间戳纳秒表示的十进制字符串，
该字符串由经过验证的整数时间戳毫秒推导而来，在 JavaScript 数值中不会丢失精度。
后台会话不会轮询或接受指针输入；恢复时会发送 `show` 指令并渲染相同的会话。
这属于前景定时器策略，而非对后台调度的认证。
关闭操作会停止输入和定时器工作，尽可能地分发 `unload` 事件，脱离绘制表面并销毁所拥有的原生句柄。
即使交易失败，清理工作仍需完成。
原生资源退役时，首先在当前上下文存在的情况下脱离 Skia，或在上下文丢失后放弃其句柄。
被拒绝的放弃操作会阻止 EGL 销毁。
每个拥有者会借入进程的 EGL 显示，仅释放其自身的上下文和表面；它永远不会终止兄弟容器或 ArkUI 的显示。
EGL 上下文/表面销毁错误仍被视为失败；已释放的句柄将单独清除，因此无法通过另一次显式重试来二次销毁它们。
调整大小仅在 EGL 表面成功销毁后，或 `EGL_BAD_SURFACE` 证明其已不存在时才会替换该表面。
其他销毁错误会保留旧身份；绑定/查询失败会保留任何替换以供清理。
不可恢复的最终化失败会被记录，并保留无法安全释放的拥有者，而不是在存在活动句柄的情况下进行释放。
仅一个已关闭的 ArkTS 回执并不能证明所有驱动资源均已释放。
原生错误将保留在以 `ERR_ENGINE` 开头的诊断字符串中，包含内部原生错误；这并不能建立结构化错误码的等价性。

如果 ArkUI 在 EGL 报告匹配的 drawable 大小之前已交付了新的大小，显式原生 `surface-size-not-ready` 状态会使所有者处于 `waiting-surface` 状态。其前台泵会重试附加/呈现操作；输入保持暂停，直到当前已提交的帧被呈现，而原生业务定时器即使没有绘制表面也会继续运行。连续的定时器更新不会导致附加重试被饿死。终端绘制表面或呈现-ACK 失败会设置 `presentationSuspended`，保留诊断信息并暂停输入和自动重绘，而定时器和生命周期操作继续运行。嵌入式所有者在解决故障后显式调用 `HarmonyLiveSession.retryPresentation()`；该操作首先退掉已附加的失败绘制表面/上下文，保留 XComponent 绘制表面 ID 和几何信息，并在渲染前附加新的原生身份。退掉失败会阻止该重试，但业务定时器继续运行。只有在成功提交并收到 ACK 后才会恢复输入。严重的运行时/协议故障会设置 `runtimeFailed` 并单独停止定时器泵。

当前页面发出紧凑的 `WEAPP_CONTAINER_LIVE_STATE` 观测和初始的 `WEAPP_CONTAINER_SMOKE` 回执。这些区别于操作系统截图和交互证据，能够区分 SDK 构建、运行时状态和原生帧提交。软件渲染模拟器上的成功附加或 `ready` 状态，并不能证明物理 GPU 验收或视觉正确性。行为契约、SDK 编译和软件快照也不能证明官方微信 DevTools 一致性、物理设备行为、七宿主一致性或性能验收门限。

账户替换现在通过 `session/HostAccountManager.ts` 进行，该机制保持公共控制器的稳定性，并在创建新虚拟机之前退役旧的原生/存储所有者。有关可信身份、后端注入、显式清理重试、新启动数据以及验收边界的内容，请参见 [ACCOUNTS.md](ACCOUNTS.md)。新的多所有者原生和账户凭证具有独立且与源绑定的证据；历史单会话设备回执无法证明这些凭证。
