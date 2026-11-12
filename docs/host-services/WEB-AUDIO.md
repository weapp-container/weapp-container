# Web 音频接入与资源归属

`BrowserHostServices` 使用浏览器实际 `Audio` 解码器实现 `wx.createInnerAudioContext`。
每个 owner 最多 8 个 context；每次替换 `src` 都创建新的解码器。旧解码器的事件、
播放算法、来源拉取及 URL 仍属于旧 source incarnation，不能进入新 source 或新账号。

## 三类来源

- `https://` / `http://`：只允许宿主配置的 `allowedOrigins`。通过显式
  `fetch({credentials:'omit',redirect:'error',mode:'cors'})` 有界读取，最多 32 MiB，
  完成后把 owned Blob URL 交给解码器。不会把远程地址直接赋给 Audio，因而不会继承
  宿主站点 cookie 或授权头；跨域仍需服务端允许 CORS。
- `wxfile://user/...`：通过当前应用、环境和用户的私有文件层读取并持有准确 URL，
  销毁或替换时释放。文件层保持可用，直到所有解码器和晚到的文件读取完成清理。
- 包内路径：以小程序包根为起点，支持 `/assets/tone.wav` 和 `assets/tone.wav`。
  runtime 从准确的未结算 `object:InnerAudioContext.src` 调用中取原始来源；宿主只传
  `ApiCallContext`，不能另传路径或哈希选择资源。必须是 manifest 声明的 asset，
  每次读取核对实际大小和 SHA-256，最多 **16 MiB 减 64 KiB**（16,711,680 字节）。
  不会拼接宿主网页 URL。

包内 API 资源新增独立能力 `packagedApiResources:'1.0'`，通过 WASM 的
`host_api_resource(contextJson)` 及 Worker 的 `native.api-resource` 字节通道传递。
Worker 在普通 owner lane 执行校验，复制后使用 transfer list 传出 ArrayBuffer；
不会 detach WASM 内存。旧 runtime 或未协商该能力时明确返回 unsupported。
既有 C ABI 的结构与符号保持不变。

这个新增协议的字节上限为 16 MiB wire message 预留 64 KiB 元数据。资源读取不执行
guest JS、不改变 presentation；成功的 `native.api-resource` 响应只传字节，不附加
可独立占满消息预算的 observation。既有组件、视频及通用资源协议保留各自限制。

来源、账号、session、call ID、API、deadline 等上下文必须与 runtime 保存的未结算
调用完全相同。已取消、结算、过期或撤销 owner 的调用不能继续读取资源；知道 asset
哈希不能获得读取权限。包的内容完整性不替代宿主对发行者的安装认证。

## 播放与回收

`src/startTime/autoplay/loop/volume/playbackRate` 按 facade 的属性缓存合同提交，
只读值来自当前真实解码器。`play` 等方法以及 `Play/Pause/Stop/Ended/Error/Canplay/
TimeUpdate/Waiting/Seeking/Seeked` 事件经所属 owner 队列回到 JS。
来源读取失败通过当前 context 的 Error 订阅报告，保留原始公开错误字段。
浏览器自动播放策略、解码格式、输出设备及用户激活仍会影响实际播放结果。

取消等待中的 `play()` 会移除来源并调用 `load()` 终止准确的原生播放算法；source
替换、后台、销毁、换号同样阻止旧事件。资源释放按阶段记录：成功的 pause、移除
source、终止加载及移除 listener 不重复执行；失败的准确 URL/解码器保留到显式 close
重试。晚到的文件 URL 在取得后仍需释放，不能因为早先 disposer 未见到 URL 就丢失。

通用队列先接收 runtime 已提交的取消，再分发完成结果；每次 guest 回调后再次读取
取消。已 take 的新调用保留在 owner backlog，完成传输失败不会使其丢失。handler 的
取消对象保留到最后一次 native take，覆盖原生成功而 guest 尚未收到结果的窗口。

## 验证边界

`browser-audio-lifecycle.test.mjs` 覆盖真实 loopback HTTP、来源更换、晚到文件 URL、
取消、传输失败、精确释放重试和背压。`host_services_contract` 在真实 QuickJS/V8 中
验证包内 API 资源权限。浏览器探针另行记录实际 Audio 解码/播放及 WASM/Worker 链路。
这些记录均不等于物理扬声器、麦克风、移动浏览器后台策略或七端设备验收。

## 浏览器探针复现

先完成包含新 WASM 与 probe 的 Web 构建，再为该构建生成独立 fixture；输出目录必须不存在：

```sh
rtk proxy node scripts/create-host-services-audio-fixture.mjs \
  --pack examples/hosts/android/app/src/main/assets/portable-pack \
  --out /absolute/path/to/web-build/audio-probe
```

生成器验证原 manifest 的 canonical root 和每个源 blob，给入口追加明确的测试 exports，
加入 4 秒、22050 Hz、单声道 16-bit PCM WAV，再生成新的 manifest root、blob 与 index。
原始包保持独立；`fixture-report.json` 记录原 root、派生 root、WAV 和 index 摘要。

在根负责的同一个后台浏览器会话中加载构建页面后执行：

```js
const { runHostServicesAudioBrowserProbe } = await import('./host-services-audio-browser-probe.mjs')
const report = await runHostServicesAudioBrowserProbe({ catalog })
```

默认同时执行 direct QuickJS/WASM 和 Worker 通道。探针使用实际 `HTMLAudioElement`，
音量设为 0；验证包内 WAV 的真实 duration、播放时钟、暂停、guest 事件、Blob 来源销毁，
以及未配置宿主、旧协议、错误或已结算的资源上下文拒绝。不会将合成波形的解码结果写成
物理扬声器或麦克风验收。探针创建的 Worker、解码器、URL 和唯一测试 cookie 均在 finally 收尾。

远程音频另外检查实际 fetch 的 `credentials:'omit'`、`redirect:'error'` 和 `mode:'cors'`。
需要验证线上请求确实没带 cookie 时，测试服务器读取请求 query 中的 `probeCookie` 名称，
只检查该唯一测试 cookie 是否出现，并在响应中给出
`X-Weapp-Probe-Cookie-Present: true|false`。再传入 `requireCookieEcho:true`；探针仅接受
`false`。普通静态服务器不提供该头时，报告保留 `wireCookieVerified:false`，不能据此声称
完成了网络层 cookie 验证。服务器不应把其他 cookie 内容写进响应或日志。
