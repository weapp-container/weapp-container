<a id="dev-player-correctness-fixture-preview5-source"></a>
# 开发播放器正确性测试套件（预览版.5 源码）

**简体中文** · [English](README.en.md)


从普通的不可变生成开发流水线开始：

```sh
pnpm simulator:dev -- --project examples/apps/player-correctness-app --surface devices
```

仅使用经过审核的匹配预览。5 运行时。该测试用例为测试输入，而非已执行的平台或性能报告。它增加了正常的/自定义导航、标签页、滚动、状态/存储以及 250 毫秒的业务计时器。打开工具和关闭或重新打开小程序必须使用真实的 Player UI，而不是页面命令。

`data.first` 是不可变的首次生命周期样本。`data.events` 会追加带有全局序列、事件名称、详情和几何索引的 JSON 记录；在 `data.geometries` 中解析该索引，以获取完整的 `wx.getWindowInfo()` 以及该回调中实际捕获的胶囊矩形。几何字符串保留所有观察到的字段。`getApp().globalData.journal` 也保留完整的跨页面有序历史记录，并同步到可见页面的 `data.journal`。其 JSON 事件元组为 `[sequence, kind, instance, event, geometryIndex, detail]`；在 `journal.geometries` 中解析几何信息。隐藏页面仅丢弃此重复的日记镜像；其首次和自身生命周期记录仍保留。没有样本被覆盖或截断。页面卸载后，其完整的最终记录将传递到下一个显示页面的 `data.lastRetired`，从而使 `onHide`/`onUnload` 可观测。每个页面拒绝超过 256 条记录，因此在观察器达到上限前需要重新运行。10 周期的测试框架会将每个快照保存到磁盘；它不会从截图中重建事件，也不接受网络接收作为呈现确认。

显式红色 **触发视图超时** 控制在下一次渲染时进入隔离的 WXS 域内的 `while (true)` 中。它不会故意阻塞 AppService。
运行时报告持续的视图故障后，实际点击次数必须保持不变，而只读检查仍必须观察到业务定时器计数的递增。
需要一个新的已接受会话才能恢复。请不要在正常旋转/导航/存储情况完成之前按此操作。

`data.runMarker` 在 `App` 构建时产生，并在关闭/重新打开或故障恢复后标识一个全新的 AppService；它补充了权威的 SDK/会话回执，但不取代它们。

`scripts/dev-player-p0-android.py --describe` 在不读取或更改设备的情况下打印干计划。执行需要显式指定模拟器序列号、AVD 名称、已配对的设备 ID、本地管理员 URL 以及一个新鲜的证据目录。它从不启动或停止模拟器或服务器，并拒绝物理设备。

```sh
python3 scripts/dev-player-p0-android.py --execute \
  --serial emulator-5558 --avd YOUR_TASK_OWNED_AVD \
  --device-id ALREADY_PAIRED_DEVICE_ID --admin http://127.0.0.1:51791 \
  --apk-sha256 REVIEWED_INSTALLED_APK_SHA256 --out /new/task/evidence/profile
```

运行时检查已安装的 APK 字节和实际 AVD 名称，然后要求 SDK 的当前帧 `inputEnabled` 呈现条件以及精确的接受的包/会话/页面/所有者/绘制表面/布局身份。在映射真实输入之前，它独立比较 Android `wm density` 和 AX TextureView/胶囊边界与接受的逻辑几何形状。保留的服务器 `presented` 阶段和比例视口重缩放无法满足这些检查。它恢复旋转设置，并保持调用者的模拟器/服务运行。每个配置都需要单独运行。可折叠设备可使用 `--postures` 参数并明确检查支持的 `cmd device_state` ID；仅通过更改显示尺寸不会将手机重新标记为可折叠设备。测试创建的姿势覆盖在退出时会被重置。调用者必须为该 AVD 保留运行，以防止无关的姿势覆盖被覆盖。

候选启动失败使用以下独立输入：`scripts/fixtures/player-correctness-startup-failure`。使用相同的显式设备/APK参数，在新的证据目录中运行 `--stage c018-baseline`。这将保存 `c018-baseline.json`；捕获基线不会通过C018测试。将失败的输入通过任务所拥有的临时项目的现有观察器进行阶段化。然后使用另一个新的 `--out` 目录运行 `--stage c018-rejection --baseline <saved-c018-baseline.json>
--candidate-root <published-SHA256> --candidate-generation <published-generation>`。

拒绝阶段读取实际的玩家观察到的原生终端回执，检查其独特的已发布候选根/版本和原始启动异常，验证精确的旧验收所有权加上有效的实际输入以及持续运行的业务计时器。缺少、待处理、未知或无关的回执将失败。检查员 `acceptedPack` 会确定哪个构建拥有虚拟机页面，即使请求针对的是更新的候选版本。运行器从不更改项目源码或接受提供的回执。其默认的 `full` 交互阶段不包含 C018；GPU 资源泄漏自由性和性能保持独立的审核门禁。
