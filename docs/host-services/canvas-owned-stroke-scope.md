# Canvas stroke 状态与页面绘制

最终产品 `c058896f43e346f0c300bcbc6f6ab92ceea33466` 在已交付元数据 `6ea85300` 上实现共享 stroke 状态、页面与组件拥有的 Canvas 接收者，以及事务化页面重绘。固定微信 3.17.3、miniprogram-api-typings@5.2.3、1265 API × 七端 = 8855 单元保持不变。

`lineCap`、`lineJoin`、`miterLimit`、dash/offset、save/restore、路径与转换状态进入同一命令记录和 typed preparation，再由软件与 Skia 消费。`lineCap`、`lineDashOffset`、`lineJoin`、`miterLimit` 四条固定属性新增 28 个 partial 单元；非固定 `fontSize` 扩展未计入，font/composite/shadow 属性未由所属对象推断实现。当前完整 CanvasContext 仍不完整，本批 available 增量为 0。

页面 Canvas 以真实 Page/component 接收者、occurrence 和 incarnation 绑定。重复 canvas-id、分离组件、移除后重建、卸载或 renderer 借用不能复用旧权限。guest 的 canvasId/owner 字段不授予页面重绘权限。首帧前绘制等待声明被接受，setData 先于 draw 的 effect drain 发布；每次完成之后再处理下一次待执行 draw，使完成回调中的 setData 能先使节点失效。

绘制先验证整批、像素和资源预算，准备不可变 Canvas image 与页面候选，再共同发布 renderer、Canvas 绑定和 Session 的 input/authority/presentation 状态。旧图像和 surface 的 acceptance receipt 保留到联合发布后才释放；该规则同时覆盖主布局提交和 Canvas 单独重绘。失败不会覆盖旧像素或消耗待重试命令。重绘更新 render revision，保留页面 layout frameId、几何和输入来源。

捕获按实际聚合 wire 字节与 item 限额在 JS admission 前计算。真实 Session 压力测试提交 25 批、每批 50000 个 dash 标量：第一波接受 19 批，下一批同步拒绝；只重试该批并先检查蓝色像素，再提交后续批，最终 25 个 callback 与 Promise 均恰好完成。预算没有放宽。

## 验证与剩余范围

精确产品完成 47 阶段及前后完整 Git blob/gitlink/source/tool 绑定。测试包括实际 QuickJS/V8、软件/Skia raster、owner/退休/rollback/预算路径，以及真实 macOS offscreen Metal Session 提交与读回。Metal 是一个 Rust 测试循环两个引擎，确认同队列 GPU 完成后读取全部 BGRA 像素，检查旧纹理/Arc 不变以及 stale/current/duplicate revision ACK。ACK 本身仍是宿主顺序合同，不是 GPU 完成凭据。

Web direct/Worker release 完成独立 producer、构建、归档、空目录安装及逐字节验证；本轮没有浏览器执行。DOM/WebView 路由的页面 Canvas draw 明确 unsupported。Web Software 路由源码保留 RGBA 页面快照到 putImageData 的显示链；CanvasKit direct/external 与 Worker 路径仍被 presenter 的 canvas guard 拒绝，本轮未执行浏览器验证。shadow、gradient、完整字体/文字、极端 changed-CTM、固定 invalid/zero 行为的微信 oracle 等仍有缺口；不能由有限参数、注册、mock、构建或安装推断完整可用。

本机 macOS 结果不代替 Android/iOS/Harmony/Windows/Linux 的实际设备、公开 SDK 或微信验收。SDK/gitlink 本批未改，七项精确引用远端可达；accepted 仍为 0。完整命令、原始失败、源码修复和 raw/gzip hash 见[本批证据](../archived-evidence.md)。
