# container-ir

**简体中文** · [English](README.en.md)


可移植的清单、WXML 和 WXSS 数据模型，由打包器、运行时和宿主适配器共享。该 crates 不包含引擎或渲染器句柄。

<a id="wxss-blob-versions"></a>
## WXSS blob 版本

`parse_wxss` 发出 WXSS 中间表示 v2。导入项为空体的 `WxssRule` 条目，其 `atRule: "@import ..."` 位于原始源位置和嵌套位置；旧版 `imports` 数组为空。组体和声明体保持独立，因此仅包含导入的媒体组不会被提升，且 `@font-face` 描述符不会被解析为选择器。未知的 at-规则仍可被检查。

`decode_wxss` 和 `validate_wxss` 接受 v1 和 v2。v1 的单独导入列表中不包含足够的信息来重建源代码顺序或包含条件。v2 拒绝了模糊的非空导入列表以及包含声明或嵌套子元素的导入规则。Blob 版本独立于外部清单模式版本，后者仍为 1。

选择器级联会跳过未解析的规则组子树。运行时必须首先解析导入并展开匹配的条件组；否则，假的媒体分支和关键帧选择器可能意外变成普通元素样式。Rust 和 JavaScript 压缩工具共享标准 JSON 测试数据。有关条件求值和剩余解析/运行时边界，请参见 [WXSS 合约](../../docs/wxss-ir.md)。

<a id="border-declarations-and-cascade"></a>
## 边界声明和级联

渲染样式解析器在比较重要性、选择器特异性、内联声明和源顺序之前，会展开 `border`、`border-top/right/bottom/left` 以及 `border-width/style/color` 四元组。获胜的渲染属性是十二个长手属性：`border-{top|right|bottom|left}-{width|style|color}`。简写属性仍可供检查；绘制必须消耗独立级联的长手属性，而不是按映射顺序重新应用这些简写属性。

每个整体边框或边缘简写会将省略的组件重置为 `3px`（`medium`）、`none` 和 `currentcolor`。宽度关键字会标准化为 `thin=1px`、`medium=3px` 和 `thick=5px`。支持的长度子集为非负的 `px`、`rpx`、`rem`、`vw`、`vh` 以及无单位的零。百分比、`auto`、负宽度和非零无单位宽度会被拒绝。错误的简写或长写不会产生渲染声明，因此无效的后期 `!important` 无法擦除前面有效的值。源 IR 仍保留其原始声明。

四元组按照上/右/下/左的顺序排列，包括单值、双值和三值的复制。值标记保留嵌套函数、引号字符串和转义字符；`rgb(...)` 或 `rgba(...)` 内部的空白字符不能将颜色拆分为多个边框组件。注释用于分隔声明标记。

共享颜色解析器接受 CSS 命名颜色（包括别名和`rebeccapurple`）、`transparent`，3/4/6/8 位十六进制，旧式逗号分隔的 RGB/RGBA 和现代空格分隔的 RGB/RGBA（可选斜杠表示 alpha）。数值和百分比通道使用 CSS 限制并四舍五入为 8 位 RGBA。旧式通道单位必须保持一致。`currentcolor` 作为符号边界值被保留：运行时样式计算会将其与元素的前景颜色进行对比；无上下文的 RGBA 解析器故意对该关键字返回无颜色。

前景 `color` 声明使用了相同的便携式颜色集加上
`currentcolor`、`initial`、`inherit` 和 `unset`。无效的前景声明不会进入渲染级联：后续的错误颜色值无法替换先前的有效值，也无法阻止从父元素继承。其他合法的 CSS 颜色空间，如 HSL、Lab 和 display-P3，不属于此便携式集合，也不会进入渲染级联；它们不会被渲染为黑色。源 IR 保留这些声明以便检查和未来功能的使用。

`initial`、`inherit` 和 `unset` 会扩展为相应的边距长手属性。
它们的继承值或初始计算值属于运行时样式解析器。
`box-sizing` 接受 `content-box`、`border-box` 以及这三个全局关键字；
无效值无法在可移植的层叠中获胜。

<a id="explicit-boundaries"></a>
## 显式边界

IR 保留了所有十种标准边框样式。当前绘画功能仅支持
`solid`、`none` 和 `hidden`。`dotted`、`dashed`、`double`、`groove`、`ridge`、`inset` 和 `outset` 仍为独立值，因此渲染器可以明确报告不支持的行为，而不是将其渲染为实线。

这是一个有边界的渲染级联，而不是完整的 CSS 实现：

- `border-image` 以及边框简写属性对边框-image 个别属性的 CSS 重置未被建模。边框-image 的渲染和重置符合性被排除。
- `revert` 和 `revert-layer` 不参与可移植边框级联。由于不存在来源/层回滚模型，因此它们不能通过初始值重置来近似。
- `calc`、自定义属性替换、其他长度单位、HSL 以及其他颜色空间、相对颜色以及 `none` 通道关键字不被本边框归一化子集接受。
- 逻辑边框、表格的合并边框规则以及浏览器特定默认值需要单独的能力和证据。

解析器和级联单元测试建立了此 IR 合约。它们并不建立微信 DevTools 一致性、原生 GPU 渲染或设备行为。
