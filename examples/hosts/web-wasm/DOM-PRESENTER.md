<a id="browser-dom-presenter-boundary"></a>
# 浏览器 DOM 呈现器边界

**简体中文** · [English](DOM-PRESENTER.en.md)


`dom-presenter.mjs` 是一个独立的呈现器，用于处理评估的 `container-ir::ViewDocument` 版本 `1.0`，并明确使用 `webview` 配置文件。
它创建一个单独的、禁用脚本的 iframe。浏览器负责布局真实的 DOM 和 CSS；输入中不包含任何 Rust 限制，且呈现器会拒绝 RenderFrame 的几何字段。它从不会评估 WXML、WXS、现代 View 代码或来自应用的 HTML 字符串。

```js
const presenter = new DomViewPresenter(container, {
  resolveResource: async (descriptor, context) => {
    // The host loads descriptor.sha256, verifies bytes, then owns this lease.
    return { url: verifiedBlobUrl, release: () => URL.revokeObjectURL(verifiedBlobUrl) }
  },
  onEventBatch: batch => host.acceptDomEvents(batch),
  onError: error => diagnostics.push(error),
})
const receipt = await presenter.submit(evaluatedDocument, {
  viewport: { width: 375, height: 667 },
  frameId: 1,
  configGeneration: 0,
  signal,
  isCurrent: () => generationIsCurrent,
})
presenter.dispose()
```

初始组件集为 `view`、`text`、位图 `image`、`scroll-view` 和文本/密码 `input`。解析后的自定义组件宿主可以保留其已展开的子组件和所有权。原生输入元素保留浏览器焦点、编辑、禁用状态以及伪类行为。图片模式为 `scaleToFill`、`aspectFit` 和 `aspectFill`；其他模式会明确失败。

WXSS 由原始规则 IR 生成。保留了导入顺序、条件分组和实例作用域，`rpx` 使用逻辑视口的 750 单位网格，普通 CSS 布局仍由浏览器拥有。选择器使用零特异性的所有权限定符来保持作用域边界，而不增加选择器特异性。源属性或 CSS 中的位图 URL 必须解析到精确的清单资源，并通过宿主解析器。呈现器从不授权任意的源 URL。宿主解析器仍需负责验证内容哈希、字节大小、访问策略和资源租约。

每个提交会生成一个隐藏的候选项，并等待其图像、字体和浏览器布局。只有在准备成功后，才会发布一个几何批次和相应的回执。失败、取消和过时的修订会保留已验收的绘制表面。在成功替换时，会恢复兼容的输入值、焦点/选择状态和滚动状态。`measure()` 在原生滚动后返回更新的浏览器几何信息。调用 `dispose()` 可释放所拥有的 iframe、监听器和资源租约。

事件通过文档监听器收集。一个批次包含目标 ID、数据集值以及有序的捕获/冒泡监听器计划和声明所有权。`catch` 同步阻止事件传播。宿主在分发此批次之前必须验证会话、页面、版本和目标 ID；它不能将浏览器提供的处理器名称作为独立权威来信任。

不支持的组件、事件、输入模式、图像模式、嵌套/延迟导入、
CSS 嵌套、转义选择器语法、动画/过渡和字体面规则会抛出 `ERR_UNSUPPORTED_CAPABILITY`。此子集不实现完整的
微信组件 CSS 隔离、原生 IME/键盘策略、所有触摸/默认操作、插槽声明发现，或平台 WebView 适配器。当提供时，`slotOwner` 会被保留，从 DOM 祖先中 never 推断。浏览器 CSS 支持将根据实际的 iframe 环境进行检查；它不是官方的微信兼容性检测标准。

验证命令：

```bash
node --test scripts/dom-presenter.test.mjs
node scripts/dom-presenter-browser-smoke.mjs --out artifacts/dual-renderer/dom-browser-new
```

浏览器烟雾使用了一个**合成评估的 ViewDocument**。它验证了实际的浏览器布局、作用域样式、资源解码、可信的点击/输入/滚动交互、状态保留、候选失败、逻辑缩放和清理。它保存了精确的输入/源哈希值、几何回执、JSON报告和一张截图。其结果是**独立的呈现器证据**，而不是运行时端到端测试、官方微信对比、GPU声明、原生WebView/设备验收、可访问性审计或性能门限。运行时准入必须在独立的DOM会话/几何/事件/ACK适配器及其相应证据实现之前保持不可用。
