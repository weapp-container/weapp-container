<a id="typography-in-the-portable-frame"></a>
# 移动帧中的字体排版

**简体中文** · [English](typography.en.md)


WXSS 字体大小和行高在组件/插槽投影之后、布局之前计算。页面盒子、元素以及匿名 WXML 文本都会携带已解析的 `text_style`。选择器的 `computedStyle` 读取相同的计算字体大小和使用的行高；`normal` 保持关键字 `normal`。

`font-size` 支持非负的 CSS 长度单位，包括 px、rpx、em、rem、视口单位、百分比和物理单位，以及零、中等和初始/继承/未设置值。百分比和 em 使用父元素的字体大小。rem 所使用的可移植 CSS 根是 16 个逻辑像素；虚拟的 `page` 元素不会改变该根值。rpx 使用逻辑视口宽度除以 750。相对关键字大小和未实现的延迟计算返回 `ERR_UNSUPPORTED_CAPABILITY`。错误的原始声明在级联比较之前被丢弃，因此无法覆盖前面的有效值，包括重要值。字体简写在级联边界处被解析，但运行时明确不支持；它不能静默保留过时的单个属性值。解析器覆盖了有限的语法和有限的 f32 值。数值溢出和非零下溢被拒绝；完整的 CSS 数值范围和语法一致性仍不完整。

行高保持其继承的值类型：一个无单位的乘数会被应用于每个后代元素自身的字体大小，而百分比/em/长度值则在声明节点处计算为像素，并继承该长度。`initial` 会重置为 `normal`；`inherit` 和 `unset` 会继承。字体大小为零时不会生成任何字符墨迹。行高为零时仍会在其行框外绘制墨迹，但会受到祖先溢出裁剪的影响。

`SkiaRenderer::layout_tree` 使用渲染器安装/系统字体提供者进行测量
升度、降度和行间距来自该提供者；在首次原生布局/渲染后，该提供者保持固定。布局创建 `text_layout`，包含测量原点（`native` 或 `fallback`）、行度量和相对于内容框的 Unicode 标量位置。原生 CPU/GLES/Metal 绘制和 CanvasKit 重放使用这些已接受的位置，不会独立包裹文本。整个帧作为一批次通过桥梁传输。

免费的 `layout_tree` 和纯软件版本使用确定性度量提供者。其来源明确为 `fallback`；其半推进的前进并非安装字体或微信几何的证据。Web/WASM 当前在 Rust 中使用该提供者。CanvasKit 可以在其接受的位置绘制自己提供的字面，但不同宿主字体集合之间的相同字形轮廓尚未得到证实。一个没有计划的显式类型帧可以使用本地字体度量绘制；其回执可将该本地路径与已提交的原生计划区分开来。

这两个字段是渲染帧合约的可选附加项。没有这些字段的绝对帧生成器仍保留其之前的 16px 文本路径。无效的样式/计划数据、文本不匹配、有限坐标溢出以及文本预算在发布前都会失败，从而保留之前已验收的帧。这并不能保证 JavaScript 组件拓扑结构的回滚：组件投影可能在后续布局验证拒绝候选帧之前就已经运行。

运行时文本现在采用版本一的水平、从左到右的流程。
`TextStyle.flow` 包含已解析的 `white_space`、`word_break` 和 `text_align`；
`TextLayout.flow` 包含已接受的源到字形及行规划。解析器在级联比较前会丢弃格式错误的原始声明。这三个属性会继承，包括 `inherit`/`unset`；`initial` 会恢复为 `normal`、`normal` 和 `start`。已识别但尚未实现的值、延迟的关键词替换、`revert` 和 `revert-layer` 会明确抛出 `ERR_UNSUPPORTED_CAPABILITY` 错误，而不是恢复之前的声明。

| 属性 | 当前流配置 |
| --- | --- |
| `white-space` | `normal`, `nowrap`, `pre`, `pre-wrap`, `pre-line`, `break-spaces` |
| `word-break` | `normal`, `break-all`, `keep-all` |
| `text-align` | `start`, `end`, `left`, `right`, `center`; start/end 使用 LTR |

Rust 规划器结合 Unicode UAX #14 行断机会与扩展的图形边界，然后应用选定的单词断开和空白模式。
`normal` 不会强制将长的不可断开的拉丁词填满；`keep-all` 抑制 CJK 运行中的断开，而 `break-all` 在符合条件的图形边界处增加断开。
CR/LF/CRLF、可压缩空格、保留制表符、硬断开、悬挂空格和 `break-spaces` 有独立的归一化/布局规则。保留制表符使用八空格制表位。此配置没有语言元数据：段落断开在 CJK 字母之间也会归并为一个空格。对齐使用填充后的内容宽度；超宽行使用起始位置。

每个评估的 WXML 文本叶保留其原始字符串。该计划绑定其 UTF-8 SHA-256 值、计算出的样式、可用宽度、度量和偏移量。每帧绘制的标量值都有一个半开的 UTF-8 源跨度；一个合并的空格映射到其整个源白空间运行。行跨度将所有源字节进行分区，包括被省略的控制字符和被修剪的空白字符。空文本或完全合并的文本没有行盒，而是记录 `empty_source`。归一化过程从不将页面数据或可观察文本重写为预修剪的显示字符串。现有的 WXML 格式化过滤器保持不变：在 `text` 祖先节点之外，如果文本节点仅包含源内容且无绑定，且完全为空白字符（包括换行符或回车符），则该文本节点将被省略。文本子树、单行空格和绑定结果仍保持为明确的文本叶。

原生渲染和CanvasKit在不重新测量或包装的情况下使用已接受的标量位置。Rust在提交边界处验证完整的换行机会。浏览器回放验证器检查源哈希、规范化/源映射、连字边界、完整的源/字形分区、样式绑定和有限的几何信息。它不嵌入第二个完整的UAX #14表，因此仅靠其检查无法认证每一个Unicode换行选择。没有流动特性的旧式帧保留其之前的标量布局协议；带有流动样式的帧需要其匹配的已提交流动计划。

这仍仅部分支持字体排版。安全的图形单元断行不提供 OpenType 字形处理：字形仍以单个 Unicode 标量形式进行定位。字间距/连字、双向文本（bidi）、嵌套内联格式、字体族/粗细选择、变量字体、语言敏感的断行优化、可选连字符重写以及官方排版默认值仍不完整。RTL 和非正常双向文本声明明确不支持。不同宿主的字体可用性也可能存在差异；缺失的字形覆盖无法通过移除源字符或替换为其他被接受的计划来修复。

`examples/apps/typography-app` 测试实际的页面事件、相对字体大小、数值与百分比继承、显式换行和零值。
`pnpm runtime:typography:smoke` 使用独立验证的固定 weapp-vite 编译器构建测试用例，运行 QuickJS/V8 并比较选择器结果和完整的原生 RGBA 快照。渲染器测试将共享计划与原生字体测量结果进行对比。CanvasKit 测试在提供固定测试运行时/字体路径时包含实际的 WASM CPU 像素回放。这些仍为辅助性的本地证据；开发者工具、GPU、设备、七宿主覆盖率和性能需要各自独立的当前源回执。

`examples/apps/text-flow-app` 添加了绑定的 CRLF/制表符文本、长拉丁文/中文字符连写、组合标记、ZWJ emoji 和区域指示符配对。其按钮使用实际的页面处理器和 `setData` 来切换空白符、断字和对齐，然后将公共选择器观察结果存储在 `text-flow:observation` 中。

```sh
pnpm simulator:dev -- --project examples/apps/text-flow-app --viewport 320x680
```

`pnpm runtime:text-flow:smoke` 支持与布局烟雾相同的 `--simulator-bin`、`--compiler-root`、`--compiler-dist-hashes` 和 `--out` 参数。它通过开发 HTTP/SSE 接口、实际坐标点击、监督器的自动渲染循环、选择器/存储以及完整的原生 Skia CPU RGBA 进行检测。Rust 集成测试单独检查接受的流计划；其公开的 `render.commit` 刷新行为并不能作为自动模拟器循环的证据。`pnpm runtime:text-flow:browser-oracle -- --out
/absolute/path/browser.json` 记录辅助的无头 Chromium CSS 观测结果。当前源结果和限制详见 [text-flow evidence](archived-evidence.md)；这些本地通道并未提升真实的 DevTools、GPU、设备、主机同步性或性能状态。
