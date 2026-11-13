<a id="wxss-border-and-box-contract"></a>
# WXSS 边框和盒子约束

**简体中文** · [English](wxss-borders.en.md)


`style-border-001` 包含本地端到端合约，从已验证的清单 WXML/WXSS 经过真实的 QuickJS/V8 AppService 和 View 执行、布局、像素及坐标输入。`view.wxml-wxss` 在所有七个宿主上仍保持**部分**状态。

<a id="cascade-and-used-values"></a>
## 级联和使用值

IR 在特定性、重要性和源顺序比较之前，扩展 `border`、侧边简写和宽/样/色四元组。省略的简写值会将宽度重置为 `medium`（3px），样式重置为 `none`，颜色重置为 `currentcolor`。`thin`/`medium`/`thick` 分别使用 1/3/5px；非负长度单位使用可移植的视口转换。百分比边框宽度和无效声明不会替代之前的有效声明。括号内的颜色函数仍保持一个值。颜色支持共享的颜色解析器，包括 alpha。

`initial`、`inherit` 和 `unset` 在组件投影之后被解析；
边框属性默认不继承。`currentcolor` 使用节点解析后的继承前景色。显式设置 `border-color:inherit` 会使用父元素的计算边框颜色，即使子元素的前景色不同。`none`/`hidden` 的使用宽度为零。`solid` 会被绘制。合法的 `dashed`、`dotted`、`double`、`groove`、`ridge`、`inset` 和 `outset` 目前会产生命名 `border-style` 的渲染器错误；它们永远不会静默地变为实线。

<a id="one-geometry-for-layout-paint-and-input"></a>
## 一个几何体用于布局、绘制和输入

WXSS 默认值为 `content-box`：明确的宽度/高度不包含内边距和边框。`border-box` 包含这些值，且内容区域为内边距之和。自动流动的尺寸只计算一次内边距。流动子元素和文本从内容边缘开始。定位的父级元素将其内边距框作为绝对定位容器；固定坐标保留视口边界。页面的默认边框框仍为宿主视口。

`LayoutStyle.border` 包含顶部/右侧/底部/左侧的 `{width,style,color}` 边框。
`box_sizing` 使用 `content-box`/`border-box`。现有手动编写的帧 JSON 在没有这些附加字段的情况下保持零边框及其之前的 border-box 尺寸；此旧版帧的默认设置与 WXSS 默认设置是分开的。

软件光栅化，原生 Skia 和 CanvasKit 绘制外层的圆角环形区域，该区域被划分为四个侧边区域。内部空洞保留之前绘制的内容；绘制过程从不会清除它，也不会用虚构的背景填充它。在传统遗留矩形中，对边的宽度会按比例限制在可用范围内。内角圆角会减去相邻的边框宽度，并归一化到内矩形中。边框绘制在边界处为二值（无边缘抗锯齿）；背景抗锯齿仍由后端决定。变换和祖先裁剪作用于整个环形区域。每一边框保持其颜色的固有透明度，而整个节点子树将被绘制。节点及其祖先的 `opacity` 会分别组合其各自组；与背景、文本、图像或后代的重叠不会将透明度乘以每个原始元素。有关嵌套组、不可见输入和资源准入的详情，请参见 [透明度协议](compositing.md)。CanvasKit 消耗一个完整的 Rust 帧；不会引入每个节点的运行时调用或软件像素上传。

溢出剪裁在内边框边缘处使用内圆角。它不会移除节点自身外边框的点击目标。在接收像素和输入状态变更之前，会触发不支持/无效的帧验证。

<a id="evidence-and-remaining-work"></a>
## 证据和待办工作

已保存的官方基线是
[`shared-styles-3173`](archived-evidence.md)：
IDE `2.02.2608080`，基础库 `3.17.3`，上游固定提交
`0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e`。其 main/ordinary-subpackage
检查点报告 2px 边框和 `rgb(15,118,110)`。本地测试用例绘制了这些值；这是一种有限的保存值对比，而不是新的官方运行或原始项目的截图对比。

`crates/container-runtime/tests/border_box.rs` 同时测试了原生引擎，并通过 `WEAPP_CONTAINER_BORDER_EVIDENCE_DIR` 导出了实际接收的帧。浏览器回放会检查 CanvasKit WebGL 读取回放中每一帧的精确内容。基于源的报告记录了后端/驱动程序和清理信息；浏览器中使用软件驱动的 WebGL 并不能作为物理 GPU 的证据。

仍不完整：其他边框样式、border-image、CSS-wide revert/revert-layer 和级联图层、完整的包含块/百分比和固定逃逸规则、像素级抗锯齿角连接、文本形状和完整排版、官方视觉差异运行、当前所有七种宿主构建/设备验证以及性能预算。这些限制仍然是发布门禁，而不是从可移植单元测试中推断出来的。
