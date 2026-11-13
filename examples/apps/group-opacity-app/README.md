<a id="group-opacity-fixture"></a>
# 组透明度测试fixture

**简体中文** · [English](README.en.md)


```sh
pnpm simulator:dev -- --project examples/apps/group-opacity-app --viewport 320x300
```

位置为(10, 20)的组具有红色背景和重叠的绿色/蓝色子元素。
其不透明度对整个绘制组生效一次。位置为(160, 20)的嵌套一对半不透明度组独立检查各层之间的组合效果。
没有文本，因此预期的RGBA值与字体无关。

位置为(10, 150)的不可见组包含一个蓝色子元素。在(30, 170)处的坐标点击仍必须指向该子元素，并向其不可见父元素冒泡。
真实的页面处理器使用`setData`将组的不透明度恢复为1，并使第一个组变为不透明。位置为(10, 240)的深色控件再次将其隐藏。位置为(100, 240)的灰色控件在`group-opacity:observation`中记录实际选择器的几何信息、计算出的不透明度、生命周期、数据集和命中情况。

`node scripts/group-opacity-smoke.mjs --simulator-bin <native-dual-engine-binary>
--compiler-root <verified-pinned-compiler> --compiler-dist-hashes <dist-map.json>
--out <report.json>` 在每个引擎会话中驱动这四个状态：初始、恢复、再次隐藏、再次恢复。监督器必须在实际点击后自动发布帧。收集器不会发送数据补丁、`render.commit`、解析后的布局或注入的 JavaScript。它会将每个 RGBA 通道与一个独立的矩形计划进行归档和比对，允许一个字节的 alpha 量化容差，然后精确比较各个引擎。

`node scripts/group-opacity-browser-oracle.mjs --package <path/to/package.json>
--out <report.json>` 在一个独立的无头 Chromium 上下文中捕获了单独实现的 HTML/CSS 模型。它记录了原生计算的 CSS、真实坐标的点击、几何信息、屏幕截图以及解码后的完整 RGBA 值。这是一个辅助的 CSS 验证工具；它不是微信基线或严格符合性的运行。

两者都是辅助证据。它们不证明官方的 DevTools、GPU、设备、性能或近似性。旅游版 AppID 用于本地开发；正式的 Oracle 运行需要独立的实 际 AppID 和固定的 IDE/SDK 基线。
