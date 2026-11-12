<a id="dom-preparation-consumed-input-metadata"></a>
# DOM 准备消耗输入元数据

**简体中文** · [English](dom-consumed-input.en.md)


一个成功的最终桥 `view.prepare` 响应可能包含一个可选的 `scheduling` 字段，位于不变的 `submission` 字段旁边：

```json
{
  "ok": true,
  "submission": { "...": "existing BrowserViewSubmission v1" },
  "scheduling": {
    "version": "1.0",
    "key": { "...": "exact submission.key" },
    "consumedInput": {
      "pageId": "1",
      "routePath": "pages/home",
      "templateRevision": "42",
      "viewport": { "x": 0, "y": 0, "width": 375, "height": 667 }
    }
  }
}
```

运行时在准备之后立即读取 `Session::browser_page_input(&submission.key)`。该候选值已经持有根数据克隆边界快照；组件钩子、后续效果、几何信息和确认回执都无法替代它所消耗的内容。页面/模板 ID 保持为标准的十进制 u64 字符串。完整的 `Rect` 被保留，因为非零的 x/y 值是被接受的。其 f32 值在传输过程中提升为 f64，与实际提交的宽度/高度完全一致。

显式渲染数据产生 `consumedInput: null`，包括等于当前页面的数据。脱离开发准备没有权威的页面快照，无法产生已消耗的证明。整个调度字段的缺失仍与现有客户端/服务器兼容；这并不意味着该准备已消耗了当前页面。未来的产物调度器在依赖此可选元数据前，必须先要求声明调度能力。本补丁不添加此类产物协商，也不启用 Worker 产物。

`DomSessionClient` 验证元数据版本、完整的呈现键（精确全键）、规范化的 ID、路由（对比 `submission.document.routePath`），以及宽高（对比 `submission.viewport`）。它保留有限的 x/y 值，并从 `present()` 返回一个独立的、冻结的 `scheduling` 对象。缺失或为空的证明保持缺失或为空；后续 ACK 中的元数据被忽略。无效元数据在呈现器准备之前失败，并中止精确运行时候选。

这些是调度事实，与呈现/输入权威无关。它们不进入许可、ACK有效载荷、应用数据或DOM观察租约。现有的 `prepare → commit → presented` 事务仍控制输入。它们不是截图、物理显示、浏览器或性能证据。

外部 Skia 帧的 consumed-input 来源尚未实现。必须在完整变更中将 `ManifestViewInput.page_input` 传递到 `PreparedViewFrame`，并提交发布，将其与确切的渲染版本绑定，保留用于保留的滚动/缩放绘制，对显式帧和分离预览不返回证明，并在 manifest/session 更换时废弃该信息。在帧/ACK 之后采样运行时状态将丢失克隆边界保证。这种更广泛的运行时/宿主变更故意位于此独立的 DOM 修补之外。
