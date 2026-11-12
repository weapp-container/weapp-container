# Block / Flex 布局约定

原生 WXML 产物现在通过一份布局结果驱动绘制、selector、observer、命中与滚动。
普通 view 使用 Block；显式 `display:flex` 的初始方向为 row。先前将普通流当作
Flex column、将百分比提前按视口换算的行为，会导致兄弟元素位置和嵌套尺寸错误。

IR 在级联前验证长属性并展开 `flex`、`flex-flow`、`gap` 和四边 shorthand，保留
importance 与源码顺序。非法声明不会遮盖此前的有效声明。运行时在字体继承后生成
`LayoutStyle.flow`，物理／字体／视口单位转换为像素，百分比和 `auto` 保留到
Taffy 0.15 求解时。原始 pack 和编译器产物保持不变。

Shorthand 按整条声明验证，不能部分重置长属性。CSS-wide 关键字必须独占整个值，
例如 `gap:initial 10px`、`flex:1 inherit` 都会整条丢弃；非法的后置
`!important` 也不能覆盖此前有效值。显式 `inherit` 复制父节点计算值；其余布局属性
默认使用自身初始值。`em` 使用已解析的当前字体，`rem` 固定为 portable root 的
16 个逻辑像素，`rpx` 为逻辑视口宽度除以 750。百分比保留单位，由实际 containing
block 和轴决定结果；不会提前按整个视口计算嵌套宽高。
虚拟 page 的默认 host 尺寸由 formatter 在这些值解析后计算，不作为 CSS 宽高传给
`inherit`，避免页面字体或百分比 padding 改变后仍使用旧 content box。

| 值类别 | 当前边界 |
| --- | --- |
| 格式化 | `display:block/flex/none`；普通 view 默认 Block，Flex 默认 row |
| 尺寸 | 长度、百分比、`auto`、max 的 `none`；自动最小尺寸可用 `min-width:0` 或 `min-height:0` 覆盖 |
| 四边 | margin/padding/inset 长短属性；margin 和 inset 接受负值及 `auto`，padding 不接受 |
| 继承 | `initial`、`inherit`、`unset`；`revert/revert-layer` 显式不支持 |
| 延迟求值 | 已识别的 `calc/var/env` 和未知字体／容器单位保留为不支持值，避免静默使用旧值 |

当前实现覆盖 Block、Flex 的 row/column 与反向、grow/shrink/basis、wrap、gap、
justify/align、margin/padding、宽高 min/max 和 box-sizing。relative 保持流内空间，
absolute 使用最近定位祖先，fixed 使用视口。文本按分配后的内容宽度重新测量，再将
接受的字形位置交给原生 Skia 或 CanvasKit 回放。旧 wire frame 缺少 `flow` 时保留
原路径，不把旧绝对坐标重新解释为 CSS 尺寸。

合法但尚未实现的布局值会返回 `ERR_UNSUPPORTED_CAPABILITY`。`order` 使用有符号
32 位整数；直接 Flex item 按 order 稳定排序后参与布局、换行、绘制与命中，
相同值保留文档顺序。selector、组件与事件父链始终保持原 WXML 文档顺序。
Block 子节点不受 order 影响；absolute/fixed 子节点的绘制 ordinal group 固定为 0。
绘制先区分 CSS paint phase，再在适用阶段比较层级和 order：普通 static Flex item 的
正 order 不会盖过定位 auto 节点，非 `auto` z-index 也不会对普通 static Block 生效。
`auto` 与显式零的隔离区别、后代 promotion 和 clip 边界见
[层叠、绘制顺序与输入](stacking-contexts.md)。
`order` 默认不继承，显式 `inherit` 读取父计算值，
`initial`/`unset` 为 0。非法声明在级联前丢弃，超出 i32 范围或延迟求值的合法值保持
显式不支持。旧 wire 缺少 `flow` 或 `order` 时保留原行为。

WXML 文本使用独立 text leaf。手写 typed frame 若把自身 text 和子节点放在同一 Flex
节点，又对子节点使用非零有效 order，会返回 `ERR_UNSUPPORTED_CAPABILITY` 并保留上一帧；
这种私有匿名 text box 还没有统一的绘制／命中身份，不能仅排序布局就声明支持。
Grid、完整 inline formatting、float、writing-mode、CSS 动画以及完整字体塑形仍有缺口。
文本已在分配后的内容宽度内使用共享 flow plan：Rust 结合 UAX #14 和扩展字素边界，
支持六种 white-space、三种 word-break 及 LTR 的五种 text-align。
normal 下不可断的英文长词允许溢出，break-all 在可用字素边界断行，keep-all 抑制
CJK 连续文本内部断行。原始文本保留，空白折叠通过 UTF-8 source span 与行分区表达；
绘制与 CanvasKit 不重新断行。这仍不构成完整 CSS Text、shaping、bidi 或嵌套 inline
等价，具体属性、未实现值和验证边界见 [文本排版约定](typography.md)。
viewport-fixed 后代会脱离祖先滚动与 overflow clip，同时保留事件父链、继承透明度
和原有绘制顺序。transform 祖先也为 absolute 后代建立包含块，static 祖先的 inset
不改变其流内位置。祖先声明 transform 的 fixed 组合尚未实现，包含 identity transform
也会明确返回 `ERR_UNSUPPORTED_CAPABILITY`；fixed 自身的 transform 可以使用。
具体合法值的接受与错误边界以 IR/runtime 测试为准。
二维 transform 在字体继承后冻结长度、布局后按最终 border box 解析百分比；
origin、继承、数值范围与可运行示例见 [WXSS 2D 变换](transforms.md)。
例如 intrinsic `min-content/max-content/fit-content`、多关键字 display、sticky、
safe/unsafe alignment 和 last-baseline 均保持显式不支持。解析器采用有边界的属性
语法，并不声称识别全部 CSS 扩展。渲染拒绝时保留上一份接受的 frame。

IR 测试保存 112 个 Chrome 辅助语法输入，验证接受／丢弃与级联边界；runtime 的
QuickJS/V8 共用用例验证 Page tap → setData → flex 比例变化 → selector/storage，
并验证不支持的延迟布局值不替换已接受画面。双引擎 order 用例验证 Page tap → setData、
DOM 查询顺序、换行、重叠像素与命中；CanvasKit 对显式预期绘制顺序比较完整 RGBA。
它们不会被算作真实 DevTools 通过。

开发检查：

```sh
pnpm simulator:dev -- --project examples/apps/flex-layout-app --viewport 360x800
```

底部按钮通过真实 Page handler 将换行容器从 220px 改为 120px，另一个按钮将
selector 几何、页面数据和生命周期写入 `flex:observation`。滚动按钮调用真实
`wx.pageScrollTo`，随后按视口坐标点击 fixed 节点；这一阶段不注入 `render.commit`，
检查自动更新后的查询、命中和像素。固定场景包括伸缩、
换行、对齐、嵌套百分比、min/max、文本测量与 absolute/fixed。

双引擎验收使用已构建的原生 Skia CPU runner 与经校验的固定编译器：

```sh
pnpm runtime:flex:smoke -- \
  --simulator-bin /absolute/path/weapp-simulator \
  --compiler-root /absolute/path/pinned-weapp-vite \
  --compiler-dist-hashes /absolute/path/compiler-dist-sha256.json \
  --out /absolute/path/flex-report.json
```

脚本保留真实编译产物哈希、manifest/blob、完整 bridge trace、selector 结果和 RGBA；
检查 QuickJS/V8 一致，并记录自身源文件和清理结果。Chrome 的 CSS 坐标与语法探测
仅作辅助基线；真实 DevTools、七宿主、GPU、真机与性能门禁分别记录，不能由此升级。
可额外传 `--browser-corpus /absolute/path/browser-corpus.json` 对照同源 fixture 的
Chrome 几何。原始文本高度会保留，但不参与等价断言；该例外明确写入报告。

本轮源文件、构建、双引擎 trace、完整 RGBA、辅助浏览器记录与失败尝试归档在
[2026-10-21 布局证据](archived-evidence.md)。归档验证只检查
已记录输入和结果的一致性，不替代真实 DevTools、GPU、真机与性能门禁。

Flex order 的真实产物 smoke 使用独立示例，且不手工提交新 frame 来替代
模拟器自身的 Page/setData 刷新循环：

```sh
pnpm runtime:flex-order:smoke -- \
  --simulator-bin /absolute/path/weapp-simulator \
  --compiler-root /absolute/path/pinned-weapp-vite \
  --compiler-dist-hashes /absolute/path/compiler-dist-sha256.json \
  --out /absolute/path/order-report.json
```

本轮原始构建、双引擎开发态交互、完整 RGBA、CanvasKit CPU 和 Chromium 辅助记录见
[Flex order 证据](archived-evidence.md)。其中 compiler manifest 的
`unknown` 元数据保留原样，固定编译器字节的独立校验不会替换成官方运行时通过结论。
