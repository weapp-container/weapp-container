<a id="ios-embedding-ui-interaction"></a>
# iOS 嵌入 UI 交互

**简体中文** · [English](README.en.md)


该目标通过 Apple 的 XCUITest 运行器嵌入了一个真实的 Weapp 容器应用。协调器在不启动应用的情况下构建应用，调用 `xcodebuild build-for-testing` 生成 UI 运行器及其 XCTest 启动文件，然后在显式选择的、已启动的模拟器上运行一个串行的 `test-without-building` 测试序列。

模拟器执行会保留官方生成的 `TestHostPath`、`TestBundlePath` 及其依赖的运行器产品，且 `UseUITargetAppProvidedByTests = true`。`UseDestinationArtifacts` 是设备专用选项，不会被使用。测试通过 `XCUIApplication(bundleIdentifier:)` 控制其 App，使用协调器传递的唯一 AUT 识别身份。在协调器安装和记录之前，AUT 和运行器都必须不存在。Xcode 在 `test-without-building` 阶段可能会重新安装相同的运行器，但无法选择其他 App。

```sh
scripts/ios-embedding-ui-smoke \
  --udid <already-booted-simulator-UDID> \
  --pack /absolute/path/to/ios-interaction-app/portable-pack \
  --engine quickjs
```

使用从 `examples/apps/ios-interaction-app` 构建的经过验证的便携式包。
固定件的按钮占据逻辑坐标 `(0, 0, 200, 80)`；运行器在应用的可访问绘制表面上相对位置 `(40, 40)` 处点击。固定件递增 `count`，安排一个真实的 JS 定时器来递增 `timerCount`，并排队一个 Promise 微任务来递增 `microtaskCount`。一个单独的显式 `--engine v8` 调用在没有引擎回退的情况下运行相同的序列。

源代码树必须已提交且干净，以通过现有的构建回执门控。
所选的模拟器是借用的：工具包不会启动、擦除、关闭，或拥有它。输出默认位于 `artifacts/ios-embedding-ui/` 下的唯一目录中；`--out-dir` 必须选择位于 `artifacts/` 下的新目录。`--timeout-seconds` 限制单次测试的时长（默认 180 秒，范围 30–900 秒）。

运行器按以下顺序执行这些操作：

1. 启动唯一安装的 App 一次，并观察其第一个完成的帧。
2. 使用 `XCUICoordinate.tap` 点击，并等待计数更新。
3. 等待真实的前台 JS 定时器和 Promise 微任务。
4. 使用 `XCUIDevice.press(.home)` 按下主页键，并观察 App 的后台状态。
5. 使用 `XCUIApplication.activate` 恢复，保持 PID、会话和页面状态。
6. 更改 `XCUIDevice.orientation` 并观察实际绘制表面的缩放。
7. 恢复原始方向和逻辑视口。

方向证据来自 App 的公共 `UIWindowScene.interfaceOrientation`，该属性在 AX 绘制表面中以只读形式暴露。
初始设备传感器值是单独记录的，可能为 `unknown`；
宿主从不根据屏幕尺寸猜测初始界面方向。它将 portrait 映射为设备 portrait，将 interface landscape-left 映射为设备 landscape-right，将 interface landscape-right 映射为设备 landscape-left。未知或不支持的界面方向会明确失败。旋转和恢复需要观察到的界面值、视口几何形状以及已完成的呈现一致；恢复失败时， teardown 会尝试完全相同的恢复操作。

运行器在销毁时记录XCTest的失败次数。只有在`xcodebuild test-without-building`成功退出且持久化的报告通过验证后，才会进行验收；在销毁过程仍在执行时，`XCTestRun.hasSucceeded`并不最终确定。

单个 `weapp-container-surface` 可访问元素暴露了只读状态。它无法执行 JavaScript、高级定时器、注入事件或调用桥接。其观察结果必须与官方 XCTest 执行成功、操作系统截图以及应用的原生输入/生命周期/缩放/渲染追踪一同验收。不使用私有 HID 事件或手动构建的 XCTest 启动程序。

证据包括：

- 原始生成并配置的 `.xctestrun` 文件，未修改的 `.xcresult` 文件，以及每条命令的日志，包含退出状态、信号和 SHA-256 值。
- 签名的 App 可执行文件/构建回执、运行器可执行文件、测试包和完整 App/运行器资源指纹，在执行后再次验证。
- 输入的可移植包的验证清单根和数据块身份，与实际安装到 App 中的包进行比对。
- Rust、Swift、运行时和交互固定源文件的执行前后的哈希值。
- 七张操作系统截图和按相同目标 PID/会话排序的 UI 回执。
- 第一次 Metal 呈现证据和最终观察帧中的原生跟踪，无丢失或截断的操作记录。
- App/运行器安装确认的精确记录、观察到的 PIDs、清理回执以及对每个模拟器 UI 会话的释放。

只有被确认为任务拥有的应用才能被清理。如果安装或替换 PID 存在歧义，则保留并报告该信息；仍会尝试清理其他拥有的应用。运行时从不会窃取过期的租约。SIGINT/SIGTERM 仅在收集证据和清理确切拥有的包之前取消活动命令的进程组。现有输出永远不会被覆盖。

在没有 Xcode 或模拟器访问的情况下运行平台无关的合约：

```sh
node --test scripts/ios-ui-test-contracts.test.mjs
```

一个通过的合同测试并不能说明模拟器运行成功。一次成功的运行环境测试仅能确认该源码、引擎、包和设备对应的官方模拟器操作系统交互记录。它并不能证明后台定时器调度、物理设备GPU行为、DevTools一致性、跨平台兼容性或性能验收。现有的仅运行时轨迹限制依然存在；单独的UI报告将携带这些交互证据。
