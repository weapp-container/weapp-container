<a id="external-frame-consumed-input-provenance"></a>
# 外部帧消耗输入来源

**简体中文** · [English](external-frame-consumed-input.en.md)


生成的帧保留了在克隆根页面数据之前由 `load_manifest_view_input` 捕获的 `BrowserPageInput`。现有名称仍保留以保持 API 兼容性；现在快照在 `ManifestViewInput → PreparedViewFrame → successful renderer.commit` 之后产生。它不会在组件钩子、完成的副作用或 ACK 之后采样当前状态。

`Session::last_frame_input(render_revision)` 返回当前非零渲染器拥有的修订版和活动页面/生命周期的精确保留输入
应用的 frameId 并非该令牌。后续的 setData 和 ready 回调可能更新模板输入，而该快照故意保持更早的状态。

`Session`、`WebHost` 和 `WebWasmHost` 暴露 `last_frame_input_json(render_revision)`。WASM 使用现有的 u64/BigInt 修订令牌。只读响应如下：

```json
{
  "version": "1.0",
  "sessionId": "session-1",
  "renderRevision": "8",
  "consumedInput": {
    "pageId": "1",
    "routePath": "pages/index/index",
    "templateRevision": "5",
    "viewport": { "x": 0, "y": 0, "width": 375, "height": 667 }
  }
}
```

过期/零渲染令牌会报 `ERR_CANCELLED`；它们永远不会报告最新帧。没有权威输入的当前帧具有 `consumedInput: null`。这包括手动帧、显式数据（即使等于当前数据）、脱离的开发预览和已退役的证明。页面/模板/渲染 ID 是标准十进制字符串。Rect 直接序列化为 f32，与 RenderFrame 中完全一致；浏览器 DOM 提交的 f64 视口转换不得替代此外部帧协议。

缩放和滚动重绘接受布局而无需重新评估视图。其成功的新的渲染修订版继承了之前的输入快照；拒绝则保持旧的修订版和证明。诊断捕获保留证明而不会推进它。HostSession 使用这些会话 API 代替无限制的渲染器借用。`renderer_mut` 守慎地退化证明，因为调用者可以替换其整个渲染器/修订版命名空间。

共享页面/可见性/清单/坐标无效化的边界在放弃证明的同时保留旧像素用于诊断。返回到同一页面、显示应用或重用应用帧ID都无法使其恢复。由组件钩子退化的源页面在提交时不会获得隐藏证明，该证明以后无法变为有效。失败的渲染工作永远不会记录新的证明；它可能仍执行了应用钩子，但不声称回滚这些钩子。

这些事实描述了准备过程，与呈现/回执和输入权限无关。消费者必须在发出回执之前，捕获帧字节、其确切版本以及该元数据，保存在序列化所有者通道中；他们不得等待回执，然后以运行时状态 JSON 作为基线。帧.current/scale 路径保留了已消费的基线；它从不提供当前页面数据作为新数据。新产品调度必须协商能力，并在依赖之前验证版本/会话/修订版/视口。此补丁增加了运行时/宿主原语，而不是工作程序产品协商或调度器连接。

Rust 测试涵盖了真实场景下的 QuickJS/V8 根克隆与附加/ACK 写入操作、保留的滚动/缩放、拒绝、显式/手动帧、分离的预览、生命周期失效，以及 WebHost 通信线程中带有分数视口值的情况。
其执行结果与合约分开记录。这些结果并非真实的浏览器、GPU、设备或性能证据。
