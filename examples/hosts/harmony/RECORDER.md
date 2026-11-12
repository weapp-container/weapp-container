# HarmonyOS RecorderManager

**简体中文** · [English](RECORDER.en.md)


`HarmonyRecorderApis.ets` 实现了 API24 `AVRecorder` 路径，并由 `Index.ets` 在每次原生拥有者时重新安装。注册需要实际的 `SystemCapability.Multimedia.Media.AVRecorder` 系统能力；麦克风授权单独请求。现有模块声明了正在使用的 `ohos.permission.MICROPHONE` 权限。

已安装的 API 为 `wx.getRecorderManager`、`start`、`stop`、`pause`、`resume`，以及目录中实际的 `onStart`、`onStop`、`onPause`、`onResume`、`onError` 和 `onInterruptionBegin` 方法。监听器取消使用订阅协议；未发明公共的 `off` 方法。`AVRecorder` 不暴露编码帧回调或可靠的中断结束信号，因此未注册 `onFrameRecorded` 和 `onInterruptionEnd`。原生音频中断错误 `5400107` 会生成 `InterruptionBegin`，并在回收录制器前保留原始错误码/消息。

适配器首先使用可信的应用和发布者身份展示应用同意，然后请求实际的操作系统麦克风权限。该同意范围限定在当前账户/应用所有者，并在新录制时再次请求；宿主账户凭据不会进入录制器或来宾 JS。在同意、权限和原生创建过程中，均由精确的对象、账户所有者、生成版本和取消信号进行保护。

AAC 使用原生 AAC 编码器和 **AAC ADTS** 容器，文件扩展名为 `.aac`。MP3 使用原生 MP3 编码器/容器，文件扩展名为 `.mp3`。在实际录制前，会将请求的编解码器、采样率、通道数和比特率与 `getAvailableEncoder()` 进行对比。缺少编解码器会明确报错；不会进行编解码器替换或容器重命名。

[官方 RecorderManager.start 参数表](https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.start.html)
提供了默认值：持续时间 60,000 毫秒，采样率 8,000 Hz，双通道，位率 48,000 位/秒，格式 `aac`，源 `auto` 和音频模式 `default`。
适配器验证了所有九种基础采样率及其发布的位率范围，然后是设备编码器更严格的限制。持续时间范围为 1–600,000 毫秒，录制输出被限制在 4 MiB。仅支持系统路由的 `auto` 麦克风源和 `default` 音频处理模式。WAV/PCM、`frameSize`、平台特定的麦克风路由和非默认处理模式会明确失败。`audioMode` 选项在基础版本 3.17.3 中进入官方文档，尽管固定版本 5.2.3 的类型包中省略了该选项；本适配器会验证该选项，但不会宣传未实现的处理模式。

Rust 管理的范围提供了一个宿主私有的暂存目录。客体路径永远不会被连接到物理目录上。记录器会写入一个精确的、唯一创建的、非符号链接的文件描述符。停止操作会等待已排队的 SDK 操作、实际的原生停止和释放，通过 `HarmonyManagedFiles` 导入有限字节，关闭描述符并删除暂存文件，然后将一个停止事件加入队列，该事件包含虚拟路径、字节数和活跃时长。暂停时间使用平台的单调运行时时钟进行排除。

后台运行、撤销、对象取消、账号替换、权限撤回和队列背压会完全移除生产者并丢弃其输出。它们不会静默地启用后台录制。原生回调仅通过 `HarmonyHostServices` 入队事件；只有其所属的 ArkTS 执行器会将事件传递给 N-API/QuickJS。已废弃的状态和错误回调无法影响替换后的录制。

Cleanup 等待实际的待处理 SDK 结果和 `release()` 完成。
原生释放错误、未 drained 的操作以及 staging 清理失败会保留记录器/文件屏障以供重试。新的录制无法绕过该屏障。
已导入的文件仍被限制在其旧账户/应用的管理命名空间内；撤销操作永远不会将它的路径发布给其他所有者。

使用生产所有者合同运行：

```sh
node --test scripts/harmony-recorder-lifecycle.test.mjs
```

14 个合同涵盖能力注册、延迟权限和原生创建、精确的原生状态事件、默认/编码器验证、暂停时长、管理二进制导入、真实的待处理停止/暂停/释放屏障、中断错误、权限撤销、过时的回调、原生同步失败、阶段清理重试和事件背压。它们在有限的 SDK 回调环境下执行生产版 ArkTS，但不声称实际的麦克风捕获。

官方 API24 版本于 2026-11-02 发布了一个未签名的 HAP，其 SHA-256 值为
`f2f8f67fefb77337617e414f4ef3d37e2f0c938d028caf391432937989579979`。
源码哈希值、构建和测试回执保留在
[`docs/host-services/evidence/2026-11-02-harmony-recorder`](../../../docs/archived-evidence.md)。
编译警告包括可抛出的 SDK API、已弃用的对话辅助类以及现有的未经验证的 N-API 模块；打包成功但未签名。

物理麦克风权限 UI、可听见的 AAC/MP3 记录和解码，
设备特定编码器限制、路由变更、实际音频焦点中断、操作系统后台运行和硬件权限撤销仍**待设备验收**。官方 SDK 编译和生命周期测试与硬件测试结果分别记录。
