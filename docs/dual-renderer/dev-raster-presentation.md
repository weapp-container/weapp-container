<a id="development-mode-raster-ownership"></a>
# 开发态 Raster 呈现所有权

**简体中文** · [English](dev-raster-presentation.en.md)


`Session::enable_dev_raster_presentation()` 在 `app.init`、页面创建和页面 renderer 初始化前显式开启精确回执模式。它不增加 `SessionConfig` 必填字段；现有 headless 和植入调用默认仍使用同步 Raster 语义。当前开发 CLI 尚未启用此模式。

运行时接收画面后仍暂停输入、selector 几何、intersection observer 和页面／组件 ready。surface owner 需要执行以下步骤：

1. 将当前已接受画面绑定到唯一活跃 preview，以及不可变的 Web 帧发布。
2. 用 `prepare_dev_raster_presentation` 预备 ticket，完成可失败的响应编码后再接受，并随该帧原样交付。`arm_dev_raster_presentation` 保留为立即接受的兼容入口；两者都不执行 JS，也不授予呈现权限。
3. 浏览器在 RAF 中绘制对应像素后回传 ticket。owner 验证 preview 租约，再在运行时线程调用 `acknowledge_dev_raster_presentation`。HTTP 入队或发送完成不能代替这个回执。
4. 断连、surface 丢失或发布失效时调用 `suspend_dev_raster_presentation`，保留诊断像素并立即撤销呈现权限。该操作不进入 JS，不重放生命周期，不停止业务计时器。

ticket 精确绑定 session、preview 及 generation、传输 frame、源 frame、render revision、配置 generation 和逻辑／物理尺寸。所有 u64 身份在 JSON 中使用规范十进制字符串，避免浏览器数字精度丢失。相同 ticket 的重复 ACK 不重复执行 effects；断连后即使像素与 revision 相同，也必须生成新 epoch。新租约允许之前暂停的 observer 完成，ready 仍按页面生命周期只执行一次。旧的仅 revision ACK 在此模式下明确拒绝。

`pageScrollTo({ selector })` 消耗实际布局，使用同一呈现谓词。没有有效回执时以 `ERR_RENDER` 进入 fail/complete，不能解析旧树并报告成功。数值 `scrollTop` 保留业务滚动意图语义，计时器和显式数值滚动继续执行；新的滚动画面需要自己的呈现回执。

已接受画面和倍率候选均支持 ticket 预准备。`PreparedDevDensity::prepare_raster_presentation` 验证尚未接受的候选画面，`accept_with_retirement` 联合移动画面、输入与租约；丢弃候选不消耗 epoch，不替换旧 ACK。receipt 保留旧像素和输入／票据分配，Web publisher 必须在 store 解锁后再释放。现有 `Simulator::apply_web_density` 已使用该释放顺序，尚未接入 ticket。

renderer 分别记录 staged 与实际 accepted 倍率。相同已接受倍率保持当前精确 ACK；数值倍率变化即使向上取整后物理尺寸相同，也更新 render revision 并退休旧权限，真实像素可以复用。倍率操作不求值 View、不重放 ready。

这里的 ready/observer 权限属于运行时 API；尚未实现的 Web owner 接线包括启动与 restart 前的 opt-in、唯一 preview 与 SSE 断开关联、binary header ticket、RAF ACK，以及调用倍率共同发布前的 ticket 预准备。现有 DOM 租约包含 DOM 专属状态，不能直接启用为 Raster 租约。ACK 可执行应用回调，必须在 Web store 锁外调用。

逻辑 resize 的 hook、宿主镜像修复、paint-ready 候选和无锁跨 hook 的容量预留仍由独立边界处理。同批滚动输入保持现有批次语义，本次不以逐事件呈现检查静默丢弃后续 delta。这些 API 不能作为 Web 接线、硬件 GPU、性能或七宿主验收证据。

源码 `ef4fb81fac9088e404839a1bfa2054defa17cb77` 已通过格式检查、runtime 完整 library（373 通过、0 失败）、runtime／host-common 严格 Clippy 和 host-common 完整 library（24 通过、0 失败）。17 项 runtime 必选用例与 24 项 host-common 必选用例均实际通过，覆盖双引擎 ready、重连 observer 和 timer 触发的 selector 滚动。原始失败尝试及最终结果见[验证记录](../archived-evidence.md)。本检查点未重跑完整 workspace 或浏览器，也未启用开发 CLI 的回执接线。
