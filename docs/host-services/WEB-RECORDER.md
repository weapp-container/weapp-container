<a id="web-recording-format-and-resource-ownership"></a>
# Web 录音格式与资源归属

**简体中文** · [English](WEB-RECORDER.en.md)


`BrowserHostServices` 在配置 owner 时冻结录音格式清单，并通过
`capabilities().recordingFormats` 返回实际安装的格式。默认处理器需要 `getUserMedia`
和当前账号的私有持久文件目录。格式清单不查询或申请麦克风权限；用户拒绝授权在调用时
单独返回，不能据此把一个已安装的接口变成不存在。

<a id="format-negotiation"></a>
## 格式协商

`MediaRecorder.isTypeSupported` 必须明确支持基线输出：MP3 对应 `audio/mpeg`，
AAC 对应 `audio/aac`，WAV 对应 `audio/wav` 或 `audio/x-wav`。只支持 WebM/Opus
不能宣称已经实现 AAC 或 MP3。调用时再次校验实际 MIME、码率、轨道采样率和声道。

安全上下文具备真实 `AudioContext`、`AudioWorkletNode` 及所需图操作时，WAV 可使用
独立的 PCM 后端。没有任何可用格式时，默认处理器不注册整个 `RecorderManager` 组。
宿主显式注册的自定义实现仍可保留自己的合同。

WAV PCM 后端要求显式 `format:'wav'`，支持基线采样率列表及单声道、双声道。输入
设备可以使用不同采样率；原生 Web Audio 在输出 context 中重采样，context 的实际
采样率必须等于请求值。当前仍要求输入轨道实际声道数匹配请求，不能把未满足的声道
约束当作成功。

```js
const recorder = wx.getRecorderManager()
recorder.onStop(result => {
  // tempFilePath 属于当前应用、环境和用户的私有文件空间。
  console.log(result.tempFilePath, result.duration)
})
recorder.start({ format: 'wav', sampleRate: 16000, numberOfChannels: 1 })
```

输出为 RIFF WAV、交错的 signed 16-bit little-endian PCM。WAV 不接受显式
`encodeBitRate`，因为它不能满足压缩码率合同；返回 `unsupported`，不会把参数静默
忽略。Stop 的公开扩展给出真实 `sampleRate`、`numberOfChannels`、
`pcmBitsPerSample:16` 和 `pcmBitRate: sampleRate * channels * 16`。默认格式仍为
基线的 AAC；只有 WAV 的浏览器需要显式选择 WAV。

`frameSize`、特定 `audioSource` 和非默认 `audioMode` 尚未满足对应合同，明确拒绝。
这里的 WAV 后端没有用无头浏览器的成功替代物理麦克风授权、后台录音或移动系统验收。

<a id="bounded-pcm-and-completion-order"></a>
## 有界 PCM 与完成顺序

可信静态 `browser-wav-recorder-worklet.mjs` 在原生音频线程读取实际输入，每 2048 帧
传输一个 PCM chunk，最多 4 个待确认 chunk。主线程按准确序号确认；消费停顿超过
四个 chunk 时终止录音并报告背压，不丢帧后发布有缺口的文件。原生平台回调与 Worklet
消息都先进入宿主 owner 队列，由 runtime 所属线程进入 guest JS。

时长上限由原生 Worklet 的实际 PCM 帧数控制，暂停不累计采样。完整 WAV 最多
32 MiB，其中 44 字节为文件头；PCM 计数在写入前检查上限。溢出、处理器故障、原生
context 中断以及空录音都不会发布成功 Stop。

停止后先取得最后一块 PCM 和准确帧数，完成原生 graph、port、listener 和 track
释放，再将完整文件写入私有持久目录，最后发布 Stop。取消、后台、换号及 owner 关闭
会阻止旧事件和旧文件发布。进行中的原生 `addModule` / `resume` 和晚到的 stream
仍须到达实际终态；原生释放失败保留准确句柄，供显式 close 重试。取消一个已原生
成功、尚未传回 guest 的调用，同样撤销该次录音。

<a id="reproduction-and-acceptance-boundaries"></a>
## 复现与验收边界

有限测试使用生产 Worklet 源码和可转移的真实 Node MessageChannel，图句柄、权限和
私有文件采用受控测试实现。它们验证 PCM 字节、RIFF、背压、实际帧上限、初始化取消、
关闭重试以及完整宿主协议；结果见 [有限测试证据](../archived-evidence.md)。
这份记录不宣称已完成真实浏览器、物理麦克风或七端验收。

先构建当前 Web 产物，再向一个尚不存在的目录生成独立探针包：

```sh
node scripts/create-host-services-recorder-fixture.mjs \
  --pack examples/hosts/android/app/src/main/assets/portable-pack \
  --out /absolute/path/to/web-build/recorder-probe
```

生成器先验证源包完整性，追加明确的测试 exports，再重新计算入口 blob、manifest 和
index。原始包不修改；派生 root 不表示源包发行者认证。通过同源 HTTP(S) 提供构建，
在任务已有浏览器会话中运行：

```js
const { runHostServicesRecorderBrowserProbe } =
  await import('./host-services-recorder-browser-probe.mjs')
const report = await runHostServicesRecorderBrowserProbe({ catalog })
```

探针同时运行 direct QuickJS/WASM 和 Worker 全链路。它只替换麦克风输入为自己拥有
的原生 48 kHz oscillator stream，录音 context、AudioWorklet、消息传输、8 kHz
PCM、浏览器解码器和 OPFS 均使用真实实现。检查暂停、完整 WAV、guest 文件读取删除、
主线程消费停顿、owner 关闭和准确原生终态。浏览器自动播放策略可能要求用户激活。

另外以原生 Worklet 验证精确 150 ms 帧数和缩小的 4096 字节 PCM 预算。报告明确标记
完整 32 MiB 录音 `not-run`；缩小预算不能当作完整大小验收。物理麦克风和音频输出也
保持 `not-run`。探针在 finally 关闭自己创建的 graph、Worker、stream，并只删除
UUID 所有者对应的私有目录；fallback 清理被使用时报告失败。

<a id="worker-binary-transfer"></a>
## Worker 二进制传输

录音文件通过保留的 `__weappBinary:{type:'ArrayBuffer',bytes:[...]}` 标记进入原生
协议。`host-api-binary-wire.mjs` 只把这些规范字节数组转换成新建的完整 ArrayBuffer，
供 Worker 使用 transfer list；接收后恢复 JSON 字节数组，再交给 WASM。每次打包都
拥有独立 backing，原 completion/event 和原始 JSON 字符串不会被修改或 detach，
传输失败可以从原结果重新打包。handle 标记继续由 runtime 验证，不在传输层解析句柄。
整棵树仍接受验证；没有转换的对象、数组及 handle 标记保留原引用和冻结状态，只有
包含实际字节转换的祖先重建，避免破坏既有准确 frame clone 的归属证明。

单个标记最多 1 MiB；一个 wire batch 最多 8 MiB 二进制和 256 个标记，以容纳多个
分别受 runtime 约束的 API payload。元数据保留 16,384 节点、64 层和 16 MiB 的
Worker 预算。普通大数组不能冒充二进制绕过节点限制，字节中的空洞、getter、无效
数值、额外标记字段以及循环都拒绝。

已有普通 ArrayBuffer、typed view 和 DataView 保持原引用，由调用方继续管理自己的
transfer list；传输层按完整 backing 计费，不用小切片掩盖大缓冲区。保留标记的接收
字节必须使用完整、未 detach、非共享 backing。实际 MessagePort、失败重试及边界
测试另记在 [二进制 wire 证据](../archived-evidence.md)。
