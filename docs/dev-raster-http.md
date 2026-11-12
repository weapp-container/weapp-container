<a id="explicit-developer-raster-http-owner"></a>
# 显式开发者位图 HTTP 所有者

**简体中文** · [English](dev-raster-http.en.md)


`container_simulator::web::DevRasterWebSession` 是一个可选的库所有者，负责一个原始的 `Simulator` 和一个实际的 `WebSurface`。它连接了现有的显式开发者 Raster 策略、实际的 SSE 连接日志、不可变二进制帧 v2 发布、运行时发放的呈现票据以及原始运行时的 ACK/输入通道。它不会创建第二个会话、所有者日志或 Web 线程。

此切片不启用正常的模拟器 CLI，也不更改无头模式的默认设置。
显式所有者在 `/` 路径上提供一个独立的实验性浏览器 UI，其包含二进制解码器、RAF 呈现器和连接管理器作为本地模块资源。
它提供连接状态、显式主预览声明、断开连接和点击输入功能。此处未实现连续手势和设置控制。
普通绘制表面继续提供其现有的 UI。帧表示此处所选的软件绘制表面；既没有 HTTP 传输，也没有 Canvas2D RAF 绘图返回，无法证明 GPU 或合成器呈现。浏览器、性能、GPU、原生宿主和设备门禁仍保持独立。

<a id="explicit-entry"></a>
## 显式入口

```rust,no_run
use container_simulator::{SimulatorConfig, web::DevRasterWebSession};
use std::{net::{IpAddr, Ipv4Addr}, time::Duration};
# fn main() -> Result<(), Box<dyn std::error::Error>> {
let mut owner = DevRasterWebSession::bind_from_pack_dir(
    "target/reference-pack", SimulatorConfig::default(),
    IpAddr::V4(Ipv4Addr::LOCALHOST), 0,
)?;
println!("{}", owner.url());
owner.poll(0, true)?; // production clock is Unix nanoseconds, not this example 0
owner.wait(Duration::from_millis(10))?;
let cancellation_effects = owner.shutdown()?;
# let _ = cancellation_effects;
# Ok(())
# }
```

对于一个单独拥有的实验性进程：

```sh
cargo run --release -p container-simulator --example serve_dev_raster -- \
  --pack target/reference-pack --port 0 --duration-seconds 60
```

示例报告了自身的地址、明确的配置文件和附加的实验性UI。仅凭此源连接并不能建立成功的浏览器运行。没有现有的模拟器、端口或浏览器被替换。引擎特性保持明确；不可用的QuickJS/V8组合将返回现有引擎错误。必须使用`PageRenderMode::Raster`。在所有者启动或接受替换包之前，将拒绝有效的WebView路由；明确的现有Skia覆盖将被认可。

只有调用者拥有的不可变包应传递给 `apply_dev_pack`。它在调用原始重载路径之前会验证候选包。WXML/style 更新保持其原有的就地更新策略；模块或配置更新使用其已验证的重启身份，并保留显式 Raster 策略。它会发布新的原始追踪响应批次和一个 `reload` 报告。截断的原始追踪覆盖率会发出明确的诊断信息，且不能被视为完整效果的证据。

<a id="actual-connection-and-wire"></a>
## 实际连接和数据线

1. 打开 `GET /api/events?clientId=<bounded-id>&since=0` 并保留该实际的 SSE 通道。其私有 `preview-init` 包含 `version`、`clientId`、`connectionToken`、`committed:false`。它不包含 epoch，且永远不会被放入全局状态/回放中。
   此严格配置仅接受 `clientId` 为 1..128 个 ASCII 字母、数字、连字符和下划线。SSE 端点在任何拥有者准入前都会拒绝其他 ID；旧版预览标识符规则保持不变。
2. 读取公共 `state.preview.epoch`。在运行时拥有者消耗连接后，提交一个精确的令牌绑定的 `/api/preview` 心跳：

   ```json
   {"version":"1.0","requestId":"confirm-1","clientId":"preview-1","op":"heartbeat","epoch":"1","connectionToken":"<actual-private-init-token>"}
   ```

3. HTTP 202 仅确认已入队。在使用实际绑定之前，需等待匹配的最终 SSE `preview` 事件且其 `ok:true`。仅因为公共所有者 ID 匹配，并不会自动提交新令牌。镜像会确认其连接，但不会隐式声称输入。
4. `GET /api/frame` 返回 `application/vnd.weapp.frame.v2`：一个小端 `u32` 元数据字节长度，UTF-8 JSON 元数据和 RGBA 字节。v2 版本中的每个运行时身份均使用标准十进制字符串。使用其未经修改的 `presentationTicket`；不要从公共帧值中重建它。

严格桥接单次请求是标准协议 1.0 请求信封，包含一个外层 `preview:{clientId,epoch,connectionToken}`。批处理请求为 `{preview, messages:[...envelopes]}`。每条消息的栅栏覆盖和未知信封字段将被拒绝。初始操作白名单为 `dev.raster.presented`、`event.batch`、`diagnostic`。

ACK 载荷：

```json
{"presentationTicket":"<the original ticket object>","draw":{"endpoint":"canvas2d-raf-draw-return"}}
```

上面的占位符表示原始对象，而不是要发送的字符串。draw 对象接受 exactly 一个 endpoint 字段。在该第一版配置中，明确不支持 ACK 取消/截止时间元数据。输入数据包在 `events` 和 `logicalViewport:{width,height}` 中附加相同的票据。视口必须与逻辑票据的尺寸匹配，且确切的租约必须已经完成其运行时 ACK。

每个信封都在原始拥有者通道上执行，并重新验证其实际连接 `Arc`、拥有者时钟、原始运行时当前票据和不可变的缓存 v2 公布。一个较早的回执可能导航、抛出或以其他方式终止基础；同一体中稍后的信封则必须关闭失败。会话、版本、帧、EOF 和重连更改永远不会使旧输入恢复。

HTTP 202 表示已入队。最终的 SSE `bridge` 事件是一个标准的关联 `BridgeBatch`：响应类型，相同会话/请求/操作。确认成功回复会精确回传 `presentationTicket` 和一个经过钩子函数完成后重新检查的 `inputEnabled` 布尔值。带类型的运行时确认错误会变为 `ok:false` 的关联错误；它们不会让调用方等待一个永远无法到达的响应。

如果发布成功且存在就绪/观察者效应但随后失败，则最终结果为
`ok:false, committed:true`。它保留了精确的票据、当前输入状态、原始错误码及其阶段；错误的请求 ID 与回执相关联。原始诊断/效应批次保持不变。该最终结果不会回滚已验收的像素或 JS 侧效应。一个当前仍有效的票据副本会确认现有发布，而不会重新运行其钩子；已退役的票据保持被拒绝状态。
类型化的终端错误优先于之前的原始 JS 诊断。重启需求仍然明确，并在最终结果中禁用输入；所有原始诊断保持在批次中的原始顺序。
预览退役会撤销旧的回执，同时保留当前呈现场景的来源和待处理的就绪工作。一个新接受的票据可完成该工作一次；旧的回执和手动帧无法提供就绪权限。

<a id="limits-and-cleanup"></a>
## 限制和清理

现有的 64 请求 / 8 MiB 桥接队列被重用。每个严格体最多有 16 个唯一的有界请求 ID；在任何 VM 执行之前，会话/请求/追踪/取消元数据都会被限制。准入证明完全最小的相关故障批次符合已预留的最终预算。所有者每次轮询最多消耗四个请求体，而原始定时器语义继续有效。初始会话 ID 最多为 228 个 UTF-8 字节，为原始检查的 `-reload-<u64>` 附加部分保留了空间，该部分在 256 字节的帧身份限制内。

每个最终事件的大小限制在 256 KiB 以内，总大小不超过现有的 2 MiB SSE 重放预算。过大结果仍与 `ERR_RENDER` 和 `operationMayHaveCommitted:true` 保持关联；它不会触发回滚或重新运行操作。运行时效果记录在原始边界处。原始开发追踪最多限制为 1,024 条记录 / 8 MiB；调用方必须检查 `trace_summary()` 以确认是否存在数据丢失。SSE 重放仍保持在边界内，读取速度较慢的客户端必须遵守现有的重放重置行为。

控制轮次与发布之间发生自然租约过期或实际的 EOF，将导致发布处于待处理状态，并在下一次原始拥有者轮询时被废弃；这不会停止服务。渲染器、分配/预算和引擎故障仍会返回错误。未类型化的传输故障使用稳定的 `ERR_*` 错误码。

遗留的回调、原始队列抽取、旧的 `/api/render-presented`，
`/api/render-frame` 以及呈现突变无法绕过此配置文件。
`GET /api/presentation` 保持只读；突变明确返回不支持。
默认传输方式在未启用此库的情况下保持不变。

调用 `shutdown()`。它首先关闭此所有者的实际套接字和监听器，然后在相同的原始运行时上消耗实际的 EOF 退场，并返回取消效果。如果钩子失败，输入保持被撤销，端口保持释放，原始会话诊断信息仍可通过 `drain_diagnostics()` 获取，且可重试 shutdown。`Drop` 仅在销毁运行时之前关闭所拥有的套接字；它在析构过程中故意不执行任意的 JS 代码，也不声明取消效果的交付。

源定义测试涵盖所拥有的 TCP/SSE、实际运行时钩子和故障路径。
它们不替代已执行的编译/测试报告或浏览器/GPU 证据。
