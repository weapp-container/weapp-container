<a id="android-host-sample"></a>
# Android 宿主示例

**简体中文** · [English](README.en.md)


示例 `MainActivity` 拥有一个 JNI 处理句柄，并将完整的 JSON 批量数据发送到 Rust `container-host-android` cdylib。它还拥有一个 `SurfaceView`，包含一个 EGL/GLES 窗口绘制表面。当当前 EGL 上下文可用时，该表面将其附加到 Skia Ganesh，并请求运行时将已提交的清单帧直接绘制到窗口帧缓冲区中。只有在直接绘制成功且同一会话的运行时能力确认了 GPU 表面后，`WEAPP_CONTAINER_SURFACE_PROBE` 才会报告 `containerSurfaceAttached=true`、`gpuSurface=true` 和 `rendererBackend=skia-gpu-gles`。如果 Skia 无法附加，则示例将保留之前的单次 RGBA 纹理上传，并明确报告 `software-fallback`，并附带明确的证据边界。

该活动加载 `app/src/main/assets/portable-pack`，该文件是来自 `artifacts/reference` 的已检入可移植包。它使用无签名的 UTF-8 关键字排序和每个原始/可执行模块/模板/样式/资源块的 SHA-256 校验和来验证清单完整性根，然后再进行运行时变更。`PortablePack.start` 向一个原生句柄发送 `app.init → app.lifecycle(launch) → page.push →
render.commit`。`app.init` 调用 `App.onLaunch`，启动过渡在页面钩子之前调用初始的 `App.onShow`。渲染使用路由的清单模板和实时的 AppService 数据，包括 `onLoad/setData`；它不会替换为测试矩形。通过以下方式刷新已检入的固定数据：

```sh
node scripts/sync-android-portable-pack.mjs --source artifacts/reference
```

该包是宿主烟雾的输入构件。它并不能将 Android 软件或 EGL 探针转换为 GPU/设备一致性证据。

配置的加载器需要请求的原生引擎提供者。没有该提供者的构建在启动前会返回 `ERR_ENGINE`，并永远不会回退到其他引擎或空应用。较旧的默认加载 C ABI 仍可供现有调用者使用。`MainActivity` 接受意图字符串附加参数 `weappContainerEngine=quickjs|v8`、`weappContainerSessionId` 和 `weappContainerFixtureId`；省略的 fixture ID 为 `portable-pack-reference-v1`（与 iOS 相同的 fixture 识别身份）。省略引擎会选择 QuickJS，省略 session ID 会为 Activity 创建一个新 UUID。

在启动成功并得到确认后，示例应用会以原子方式将其自身的应用数据目录中的 `files/portable-pack-execution.json` 文件写入。它保留了完整的相关启动请求/响应、已验证的快照元数据、清单、引擎、会话和帧 ID。第一个成功交换的启动帧会将其与绘制表面的回执一起冻结该文件；后续的交互帧将不会覆盖启动身份。新的 Activity 会先清除之前的文件。这避免了依赖截断的日志记录。二进制构建身份在外部构建/安装工具证明之前仍为 `unknown`；应用不会从源码检出中推断其来源。

启动会等待实际的 `SurfaceView` 尺寸和根 `WindowInsets`。
`Display.getRealSize` 提供一个根据当前方向的屏幕尺寸；
`resources.displayMetrics.density` 提供观察到的像素比例。尺寸会除以该比例并四舍五入到最接近的逻辑像素，正数半舍入向上；无效或零值观察将失败，而不是使用默认比例或限制逻辑尺寸。这些值在任何应用模块运行之前会传递给宿主提供者。配置提供方向；它不会从视口宽高比推断得出。`screenTop` 使用装饰窗口观察到的上边缘，与 Surface 输入原点分开。状态栏内边距在 API 30+ 上使用 `getInsetsIgnoringVisibility`，排除 IME；API 26–29 使用稳定的顶部，并带有明确的诊断限制。这些是宿主映射合约，而不是已确立的固定 DevTools 等价关系。原始内边距仍为诊断性质：公共 `safeArea` 的纵向坐标原点未经证实，因此该字段被省略而不是合成。
`PortablePackSession` 随后在 Activity 主线程上拥有原生输入、生命周期、定时器和重渲染。每个 Android 输入批次通过 JNI 一次；Rust 对其已提交帧执行命中测试、捕获/目标/冒泡、数据集和组件处理器分发。表面本地触摸坐标会被缩放至该逻辑视口。实现了单指的开始/移动/结束/取消和轻点操作；多点触摸会取消当前手势。长按、滚动识别和原生指针目标捕获仍不完整。

表面尺寸变更会更新同一 Rust 会话的 `HostMetadata`，同步 `wx.getWindowInfo`/系统信息提供者、`Page.onResize` 以及生命周期组件的 `pageLifetimes.resize`，然后在不加载新隔离进程的情况下重建 manifest 帧。活动配置变更保留原拥有者。
一次完整的 JSON 观察以原子方式通过 JNI 执行，包括仅密度、屏幕尺寸或内边距变更的情况。仅用于显示的更新会刷新提供者值，而不会重放 `onResize`；重复的观察无任何操作。旧的仅尺寸的 C ABI 仍可用，并保留现有显示数据。
恢复/暂停会通过 App、当前页面及其生命周期组件发送去重的显示/隐藏过渡。内边距在默认装饰策略之前从传入的装饰分发中捕获；监听器调用该策略并返回其结果不变。消费内容的父组件不能阻塞此窗口级观察。
表面几何在布局后预绘制阶段才合并，实际持有帧、表面回调范围和视图布局保持一致。装饰重新附加需要新的内边距 epoch；仅表面重建可保留当前窗口的 epoch。
`WEAPP_CONTAINER_WINDOW_OBSERVATION` 会记录版本化的待处理/就绪诊断和分发/布局来源，而不将缓存的内边距视为新鲜数据。
恢复时首先强制执行一次完整的有效窗口观察，即使未发生变更，且在分发显示前刷新原生提供者值；无效观察将不会恢复用户钩子。此顺序是实现层面的回归契约；App/页面后台回调的联合顺序尚未由固定 DevTools 工具链确立。
Choreographer 仅在前台时轮询定时器。其运行时时间戳仅用于调度回调：每次实际轮询都会采样 `System.currentTimeMillis()`，并将 Unix 时代毫秒转换为纳秒，与 Rust `SystemTime` 和 AppService `Date.now()` 的截止时间保持一致。
表面提交或呈现回执失败将设置 `presentationSuspended`：输入和自动重绘停止，而业务定时器和前台生命周期继续运行。嵌入的拥有者可调用 `MainActivity.retryPresentation()` 以恢复其 EGL 上下文并显式提交当前状态；输入仅在匹配成功的呈现回执后才会恢复。致命的运行时/协议错误仍保持独立，并停止定时器泵。
转换在原生分发前拒绝负值或 JNI 溢出值，而不是将其截断或转换为其他日期。销毁操作在释放 EGL 和 JNI 处理句柄前会先卸载一次。持续的媒体查询观察器通知仍保持部分状态。

可调试的 APK 还会发布 `files/portable-pack-interaction.json`：
会话/完整性、逻辑视口、实际宿主尺寸、页面数据、完整的已提交 `RenderFrame`（`frame_id`）、有界操作/生命周期/错误历史，以及无像素快照摘要。绘制表面几何信息记录物理范围、密度和屏幕原点。顶层 `windowObservation` 记录原始显示/绘制表面范围、密度、旋转/配置、不同窗口/绘制表面原点和稳定边距，且会标注 Android API 源码名称。顶层 `displayMetrics` 来自 Rust 检查，与这些原始观测独立。冻结的启动回执和动态交互回执均包含此区别。`surface.presentedFrameId` 仅在 `eglSwapBuffers` 成功后才会递增，并且与已提交帧保持不同；绘制表面丢失会清除该身份和后端，直到下一次成功交换才恢复。相同尺寸的替换绘制表面在有效加入和成功原生同步后，会重新呈现上一个已提交帧，而无需重新加载会话或生成新帧。

在绘制之前，呈现器会查询当前的 EGL 可绘制分配。仅靠 SurfaceView 几何信息无法确定其后端尺寸：测试的模拟器可以在交换之前保持之前的分配。若出现不匹配，仅会退化并重新创建 EGLSurface，保留上下文和运行中的 JS 会话，并在调用渲染器前重新检查获取的尺寸。持续的不匹配将报告 `ERR_RENDER`；它无法接收成功呈现的回执。`surface.drawableObservation` v2 保留了转换前的目标纪元、分配和 GL 状态，以及绘制前后和交换后的状态。被认可的帧必须在整个过程中保持已接受的物理范围和当前 EGL 目标。EGL 处理句柄使用无符号十六进制字符串，以便 JSON 消费者保留所有指针位。这些标识符仅标识当前运行的进程，而不是可移植资源或跨启动的稳定身份。

零表示当前没有帧被呈现。后台和失败的会话会报告 `suspended`，并带有独立的 `foreground`、`runtimeFailed`、`presentationSuspended` 和诊断字段。空定时器轮询不会写入回执。页面/布局检查仅用于开发，且在发布版本中不会持久化。GPU 重绘制会传递已提交帧的元数据，而不会进行 RGBA 读回；启动截图仍作为明确的诊断信息保留。输入/帧延迟尚未通过性能门限。

首先构建原生构件：

```sh
pnpm native:build -- --platform android
```

原生构建器默认选择 `quickjs-native-android`。该功能使用 NDK/bindgen 绑定来实现实际的 Android ABI；不会复用桌面版 QuickJS 绑定。显式指定 `--engine v8` 会请求 V8，当该目标的原生提供者无法构建时必须失败；它永远不会替代 QuickJS。

在具备 Android Gradle Plugin、NDK 和已安装的 Gradle 包装器的情况下，通过显式传递构件来构建 arm64 APK：

```sh
./gradlew :app:assembleDebug \
  -PweappContainerAndroidRustLib="$PWD/../../../target/aarch64-linux-android/debug/libcontainer_host_android.so"
```

Gradle/CMake 项目是一个集成骨架。APK 签名、安装以及模拟器/设备验证仍保持独立的审核环节。

在仓库根目录中从指定的目标运行 APK：

```sh
pnpm host:android:app:smoke -- \
  --serial emulator-5572 --expected-avd YourTaskAvd \
  --apk /absolute/path/to/app-debug.apk \
  --engine quickjs --out-dir artifacts/android-app-run
```

输出目录必须为空，且该目标上不能存在该包。
运行时使用普通安装，一个唯一的会话，并轮询应用的原子回执，以匹配引擎、固定测试用例和附加的 Skia GLES 帧。
它在相同 PID/启动时间以及前台包之间检查时，捕获一次操作系统截图；命令字节、诊断信息和截图都会保留；运行时仅移除其已安装的应用，但保留目标设备的运行。
它从不选择第一个设备，不会替换现有应用，也不会清除 Logcat。

对于捆绑的参考测试用例，添加在选定的官方模拟器和可调试的 APK 上的显式交互计划：

```sh
pnpm host:android:app:smoke -- \
  --serial emulator-5572 --expected-avd YourTaskAvd \
  --apk /absolute/path/to/app-debug.apk \
  --engine quickjs --out-dir artifacts/android-reference-interaction \
  --interaction-plan reference
```

该计划在执行真实的 adb 页面/组件点击之前，会读取已提交的边界和实际绘制表面的屏幕原点，检查页面/组件/槽位的更新，使用 `wm size` 进行重尺寸，并在同一会话中验证视口/提供者的一致性，然后发送 HOME 按键并恢复该 App。它会恢复原始的显示尺寸/密度覆盖设置，并保存独立的交互回执和操作系统截图。初始帧、重尺寸帧、恢复帧、密度帧和恢复帧均会进行截图检查；重尺寸后额外的 OS 点击会验证新的命中坐标。截图捕获需要在捕获前后具有相同的帧、呈现顺序和 EGL 目标。最多五秒的重试允许临时合成器动画；每个候选 PNG、相关回执和失败情况都会被保留。本地几何检查会将不透明的参考页面/卡/组件背景与已提交的边界和颜色进行对比。它不包含文本内容，也不是官方截图基准；`visualStatus` 保持为 `unknown`。
每张截图都会明确标注其对应的精确 `*-screen.json` 验收回执。较早轮询到的回执会保持独立；后续输入在合成器稳定期间推进时，将使用已验收捕获帧。启动证据保持为冻结的首帧回执。这仅验证了已执行的模拟器交互；它并非 DevTools 一致性、物理设备/硬件证据或性能结果。

没有 `--build-receipt`，源出处仍为 `unknown`，报告无法通过源检查。可以使用 `--build-receipt` 提供已保存的 `apk-validation.json`；其原生输入和隔离的 Gradle 回执哈希链必须与 APK 完全匹配。`--expected-source-commit` 在测试旧版构件时选择一个明确的不可变基线；工具链提交和二进制源提交保持独立。默认基线为当前 HEAD。

截图捕获需要单独的视觉审核。附加的 Skia 绘制表面并不能证明硬件加速、触摸、调整大小、应用生命周期、真实设备或近似一致性符合性。使用 `pnpm host:android:app:test` 运行运行器的生命周期/所有权测试。

对于加载器/协议回归问题，从仓库根目录运行：

```sh
node scripts/android-pack-contract-test.mjs
```

此方案使用来自只读 Gradle 缓存的固定 Kotlin 2.0.21/JVM 依赖项，SDK 36，和 NDK 27.1.12297006。可通过 `--gradle-cache`、`--android-jar` 和 `--ndk` 覆盖其路径。它在录制运行时上运行生产加载器，使用 Android SDK 编译所有生产 Kotlin 代码，并使用 NDK 对 JNI 适配器进行类型检查。时钟测试涵盖时区保持、精确毫秒转换、无效输入以及在时区截止时刻的录制运行时回调；这些测试并未验证原生定时器的执行。其报告明确排除了原生 JS、Android 进程、EGL、GPU 和设备执行。
