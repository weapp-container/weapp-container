<a id="session-scrolling"></a>
# 会话滚动

**简体中文** · [English](scrolling.en.md)


`Session` 负责管理已接受的滚动状态，按 PageId 和渲染实例进行键值索引。公共 WXML `id` 值是选择器数据，而非状态键。新的 WXML/布局生成会同步声明变更，并将保留的偏移量限制在当前正向内容范围之内。无关的 `setData` 更新会保留滚动状态；页面卸载时会释放页面条目。

生成的页面根节点和启用 `scroll-view` 轴成为显式的渲染视口。`RenderNode.scrollContainer` 通过 `-scrollOffset` 选择其后代的平移，其内边距框裁剪、边框和背景保持静止。仅包含 `scrollOffset` 的旧帧保留其元数据含义。软件、原生 Skia 和 CanvasKit 使用相同的坐标约定；选择器几何和点击检测遵循平移后的世界坐标。候选帧和状态在渲染器验收后一起发布。

宿主发送一个 `event.batch`，从不发送节点变更：

```json
{"events":[{"type":"wheel","x":30,"y":30,"deltaX":20,"deltaY":40,"deltaMode":0,"bubbles":true}]}
```

正向增量会增加滚动偏移量。坐标和像素增量使用渲染帧的逻辑坐标。数值模式 `0`、`1`、`2` 表示像素、行和页；字符串 `pixel`、`line`、`page` 形式也受支持。宿主应规范化自身的滚轮约定。Web 适配器在批处理前会将 CSS 像素、16 像素的行和视口大小的页进行转换。桌面适配器会转换 winit 的符号。可识别的触摸接触点会保留其捕获的路径。可用的移动量从命中容器向其滚动祖先消耗；接受的状态驱动滚动回调和观察器测量。

inspectors、`/embed` 和独立 Web 包装器共享
[`surface-input.mjs`](../examples/hosts/web-wasm/surface-input.mjs)。它序列化桥接批次，保留滚轮事件的顺序，丢弃被替换会话的待处理输入，并在销毁时释放其监听器/捕获/RAF。触摸拖动不会合成点击。浏览器缩放手势保持其正常的宿主行为。

`wx.pageScrollTo` 现在需要一个活动页面以及该页面已验收的帧。
立即滚动使用 `duration: 0`；正数 duration 返回 `ERR_UNSUPPORTED_CAPABILITY`。缺少帧返回 `ERR_RENDER`。取消和截止检查在变更之前进行。独立的沙箱提供者在没有移动像素的情况下不会记录成功滚动，而是返回不支持。
这仍属于部分支持：默认动画时长、惯性、增强的滚动视图功能、精确的上下阈值、固定位置逃逸、字符墨水溢出以及完整的 CSS 可滚动溢出模型仍需进一步工作和官方证据。已分发的 `catchtouchmove` 会抑制默认拖动；普通 `stopPropagation()` 无效。精确的官方顺序和原生默认行为仍需差分证据。

交集观察器保留了一个矩形几何契约。原生模式的滚动祖先使用其变换后的内边距框进行轴对齐的缩放和反射；旋转或剪切的滚动会明确返回 `ERR_UNSUPPORTED_CAPABILITY`。矩形交集比率无法测量圆角的可见像素面积。

页面样式资源遵循清单中的 App、当前路由以及递归声明的组件图。启动、普通渲染和开发重载均使用相同的 Rust `route_style_ids` 辅助函数。两个页面即使共享同一个包，仅因为名称相同，并不能使一个页面的类进入另一个页面的帧。组件样式隔离仍属于视图的独立职责。本地引用和 `url(...)` WXSS 导入遵循所选的样式图，包括相对路径和包根路径。重复导入保留其级联顺序。WXSS IR v2 在源位置记录导入规则，保留条件嵌套。首部导入可以携带媒体查询；匹配的导入和媒体组在普通级联之前，依据渲染帧的逻辑视口进行解析。渲染新的视口将重新评估这些条件。假分支不会贡献规则，也不会遍历其嵌套导入。活动的延迟/嵌套导入和不支持的激活 at-规则返回 `ERR_UNSUPPORTED_CAPABILITY`；循环、缺失资源、路径转义和远程导入在帧发布前均会失败。被拒绝的候选保留之前已接受的帧。

遗留的 WXSS IR v1 将导入规则与本地规则分开存储，并丢失了它们的原始位置和嵌套上下文。其导入规则仍会在该文件规则之前展开；从嵌套 at-规则中提升的导入无法恢复其原始条件。v1 兼容性并不能证明重构了源语义。
[WXSS 合约](wxss-ir.md) 记录了支持的媒体特性、未知查询行为、仅元数据字体/关键帧处理以及剩余的解析器缺陷。

源示例为 [`scroll-contract-app`](../examples/apps/scroll-contract-app)。
通过以下命令交互运行它：

```sh
cargo run -p container-simulator -- dev \
  --project examples/apps/scroll-contract-app --surface web --viewport 240x200
```

可重复的原生烟雾测试会验证一个明确选择的隔离编译器，该编译器针对固定 Git 对象和独立的分发哈希回执进行测试，然后构建真实应用，将其打包，并运行两个原生引擎：

```sh
node scripts/scrolling-smoke.mjs --simulator-bin target/debug/weapp-simulator \
  --compiler-root /path/to/verified/compiler \
  --compiler-dist-hashes /path/to/compiler-dist-sha256.json \
  --out /path/to/new-report.json
```

对于实际的浏览器滚轮、触摸和应用嵌入输入：

```sh
node scripts/scroll-browser-smoke.mjs \
  --wv-bin /path/to/verified/compiler/packages/weapp-vite/bin/weapp-vite.js \
  --simulator-bin /path/to/verified/weapp-simulator \
  --engine quickjs --out /path/to/new-evidence-directory
```

浏览器烟雾会在操作系统分配的回环端口上创建一个无头页面，并启动自己的开发监督程序，然后关闭其页面/上下文/浏览器、SSE流、编译器监视器和服务器。仅凭编译器-bin的哈希值并不能完整证明编译器的来源；还应使用原生烟雾的独立验证。原生运行时Web测试无法证明浏览器-WASM V8、原生设备输入、GPU执行、性能预算或官方DevTools等效性。
