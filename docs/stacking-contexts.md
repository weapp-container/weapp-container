<a id="stacking-drawing-order-and-input"></a>
# 层叠、绘制顺序与输入

**简体中文** · [English](stacking-contexts.en.md)


Weapp Container 的 typed Block/Flex frame 按 CSS 层叠阶段组织绘制。
`RenderNode.children` 始终保存原 WXML 顺序；不能通过重排或重挂节点来实现 z-index。
这里描述当前可表达和验证的子集，不表示完整 CSS 或微信运行时视觉等价。

<a id="boundary-between-typed-and-old-frame"></a>
## Typed 与旧 frame 的边界

根节点的 `style.flow` 为 `Some(...)` 时，整个 frame 使用 CSS paint plan。
`LayoutStyle.z_index: Option<i32>` 区分 `None`（`auto`）和 `Some(0)`（显式零）；
`LayoutStyle.isolation` 表示 `isolation:isolate`。普通 static Block 的 z-index 不适用，
即使节点因 transform 或 opacity 创建了 context，也不能因此把它的静态 z-index 当作层级。

根节点缺少 typed `flow` 时保留旧绝对坐标 frame 的局部绘制约定：兄弟使用
`RenderNode.z_index`，递归绘制完整子树。该旧字段不能表达 CSS 的 `auto`/`0` 区别，
不应作为新 WXSS frame 的层叠语义来源。旧根不会导出 `paintPlan`。
若旧根下任意节点带有新的 `style.z_index:Some(...)` 或 `style.isolation:true`，
commit 与 frame 序列化均以 `Unsupported("typed-stacking-without-css-root")` 拒绝，
保留上一份画面；不让 Rust 按旧语义接受、CanvasKit 却按新语义拒绝同一份产物。
纯旧 `RenderNode.z_index` 继续兼容。

<a id="context-and-paint-phase"></a>
## Context 与 paint phase

当前 context 边界包括根节点、fixed 节点、非 `none` 的二维 transform、
`opacity < 1`、`isolation:isolate`，以及适用非 `auto` z-index 的定位节点或直接 Flex item。
identity transform 仍创建 context；`opacity:0.999` 也不能因为像素量化接近不透明而移除边界。
`opacity:0` 保留布局与命中，`display:none` 则隐藏整个子树。

relative/absolute 的 `z-index:auto` 是定位绘制组，后代仍可参与外层 context。
显式 `z-index:0` 创建独立 context，其后代无法用很大的 z-index 穿过该边界。
普通 static Flex item 类似 inline-block 原子绘制，但 `auto` item 的定位/context 后代
仍可与外部内容交错；显式零会隔离这些后代。`isolation` 自身不创建包含块或 overflow clip。

在当前 Block/Flex 子集中，一个 context 先画自己的背景和边框，随后处理负层级 context、
普通流背景与内容、定位 auto/零层级组、正层级 context。负值和正值按数值稳定排序；
相同层级保留相应的文档遍历顺序。负 z-index 后代可以在 context 自身背景之上，
同时位于中间非 context 祖先的背景之后。这要求背景和内容能独立进入 paint phase，
不能仅把整个祖先子树按 z-index 排序。

直接 Flex item 使用 order-modified document order。absolute/fixed 子节点的有效
ordinal group 为零，但先判断 paint phase，再在适用阶段比较 order。
例如普通 static item 的 `order:1` 不能盖住定位 auto 子节点；把该 item 改为 relative
或 identity transform 后，它进入零层级阶段，order 才能参与同阶段先后比较。
Block 子节点不受 order 影响。selector、事件父链和 DOM 查询顺序均不随 order 改变。

<a id="three-relationships-and-shared-plans"></a>
## 三种关系与共享计划

| 关系 | 用途 | 提升后代的绘制层级时 |
| --- | --- | --- |
| 原 DOM/事件父链 | selector、capture/target/bubble、组件归属 | 保持原父节点和子节点索引 |
| 空间链 | transform、scroll、包含块、overflow clip | 保持原空间变换与有效 clip |
| Stacking context 归属 | paint phase、z-index、opacity group | 可与直接 DOM 父节点不同 |

Rust 的 `PaintPlan` 编译器供软件绘制、Skia 绘制、命中与 `RenderFrame` 序列化使用。
每次建立 plan 时，空间投影通过一次文档树遍历计算父链、变换和链式 clip，随后生成绘制阶段。
这些调用当前不共享持久缓存，不能把共用编译器描述为跨调用只编译一次，也不代表性能门槛已通过。

Typed `RenderFrame` 序列化携带 `paintPlan` v1，命令为 `begin`、`background`、
`content`、`end`，路径使用原 DOM 子节点索引。CanvasKit 校验并回放该计划；
渲染顺序不能改变 wire tree 的父子关系。opacity 在完整 group 绘制后合成一次；
后代被提升到某个 context 的绘制阶段，不应导致祖先 opacity 重复应用或丢失。

输入按绘制顺序反向确定目标，再沿原 DOM 父链生成事件路径。除了矩形背景命中，
图片或文本内容还可能晚于其他普通 Block 的背景绘制，必须与空 content 区分。
透明度不改变 box 命中规则。无自身事件身份的匿名文本需要保留自身几何/clip 约束，
再映射到最近可命中的 DOM 祖先；不能只按祖先矩形扩展文本命中区域。
映射点还必须处于该 DOM 祖先自身的输入几何中；可见的匿名文字溢出不会扩大
公开 WXML 元素的事件区域。

<a id="clipabsolute-and-fixed"></a>
## Clip、absolute 与 fixed

overflow clip 约束空间关系，不能因 z-index promotion 丢弃。absolute 后代的包含块
在某个 overflow 祖先之外时，CSS 不让该中间 overflow 祖先裁剪这个 absolute 后代；
包含块自身及其祖先的有效 clip 仍保留。包含块位于 overflow 节点自身时则应裁剪。
因此验证 promotion 与 clip 的普通用例使用 relative clip 祖先，另设 static clip 祖先用例
验证包含块在外部的例外。

当前 viewport-fixed 后代脱离祖先 scroll translation 与 overflow clip，仍保留 DOM 事件父链、
opacity 及 context 归属。fixed 不能凭视口坐标越过一个 opacity 或 isolation context。
transform 祖先创建的 fixed 包含块尚未实现，包含 identity transform 的该组合仍显式拒绝；
fixed 自身的二维 transform 不属于这个限制。

<a id="verification-and-unreached-boundaries"></a>
## 验证与尚未达到的边界

`crates/container-render-skia/src/paint_tests.rs` 定义固定几何、无字体依赖的 corpus：
identity 与普通兄弟、static z-index 适用性、auto/零后代逃逸与隔离、负层级背景、
Flex item 原子组和 phase/order、透明命中、DOM 祖先、单次/嵌套 opacity、clip/scroll、
fixed、隐藏子树、图片 content 与透明图片命中，以及资源拒绝的原子性。
SoftwareRenderer 和 SkiaRenderer 使用独立指定的像素与目标预期；不从内部比较器生成预期。
Skia 未启用原生 backend 时的明确软件回退、原生 CPU readback、CanvasKit CPU 与 GPU
执行证据需分别记录。这份 corpus 本身不证明真实 DevTools、GPU、七宿主或真机通过。

设置 `WEAPP_CONTAINER_STACKING_EVIDENCE_DIR` 可把每次固定几何 case 导出到已存在的目录。
子目录以当前测试线程名和线程局部序号命名，目录和文件均拒绝覆盖。每份记录包含
完整 `frame.json`、独立指定的采样颜色与 DOM hit path、software/native 全幅 premultiplied
RGBA bytes、SHA-256、实际命中路径和 backend 标记；断言失败前先保存原始观察结果。
原生 Skia feature 启用时，此无字体、整数几何 corpus 还比较全部 native/software 像素。
这只是 backend 全幅一致性验证，独立颜色 oracle 仍限定为明确列出的采样点，
不能把采样或两个 backend 一致性冒充整幅画面的独立 CSS/DevTools oracle。

绘制预算在递归计划和 frame 序列化之前检查：最多 100,000 个节点、深度 256
（根深度为零）和 1,000,000 个累计 DOM path entries。拒绝使用
`RenderError::PaintBudgetExceeded`，保留 renderer 上一份已接受的 frame 和 snapshot；
不能先发布半份 frame 再报告预算错误。深度 257 的测试避免构造不受控的深树，
也不把其通过当作所有宿主的内存或耗时预算已达标。

以下仍未达到完整 parity，不能由当前 Block/Flex 结果推导为支持：

- float 及其专门绘制阶段、完整 inline formatting、行内拆分、bidi、table 的分层背景。
- Grid item 的布局和层叠，以及其它尚未支持的 formatting context。
- 三维变换、perspective、preserve-3d、backface 和三维深度排序。
- filter、backdrop-filter、blend mode、mask、clip-path、contain、will-change 等其它 effect/context 来源。
- 完整 outline、伪元素、top layer、平台原生组件合成和官方运行时的专有绘制行为。
- 完整字形形状、字体 shaping 与文本精确输入的跨平台一致性。

具体声明是否接受、丢弃或显式不支持，仍以对应 IR/runtime admission 为准；
不能因本文件列出某个 effect 就假定其 parser 或 renderer 已具备实现。

独立规则依据：

- [CSS2 Appendix E：绘制阶段](https://www.w3.org/TR/CSS22/zindex.html)。
- [Flexbox 4.3：Flex item 绘制与 context](https://drafts.csswg.org/css-flexbox-1/#painting)。
- [CSS Display 3：order 与 out-of-flow ordinal group](https://drafts.csswg.org/css-display-3/#order-property)。
- [CSS Transforms 1：非 none 变换创建 context/包含块](https://drafts.csswg.org/css-transforms-1/#transform-rendering)。
- [CSS Color 4：opacity 的组后处理和透明命中](https://drafts.csswg.org/css-color-4/#transparency)。
- [CSS2 overflow：absolute 包含块位于 clip 祖先外的例外](https://www.w3.org/TR/CSS22/visufx.html#overflow-clipping)。
- WPT [Flex item 定位与 order](https://github.com/web-platform-tests/wpt/blob/master/css/css-flexbox/flexbox-items-as-stacking-contexts-002.html)
  和 [非完整 context 的后代交错](https://github.com/web-platform-tests/wpt/blob/master/css/css-flexbox/flexbox-items-as-stacking-contexts-003.html)。

复现 fontless CPU corpus 时，在已有的空输出目录上设置导出变量，并启用原生 Skia：

```sh
WEAPP_CONTAINER_STACKING_EVIDENCE_DIR=/absolute/empty-frames \
  cargo test -p container-render-skia --locked --jobs 2 --features skia-backend paint_tests -- --test-threads=2
pnpm runtime:stacking:frame-replay --frames /absolute/empty-frames \
  --canvaskit-dir /absolute/pinned-canvaskit --out /absolute/new-replay-directory
```

CanvasKit 输入必须是脚本固定 SHA 的 0.42.0 full JS/WASM。回放核对源码测试清单、
51 份固定场景、每份输入 SHA、完整 premultiplied RGBA 和已记录的独立采样预期。
目录不完整、输入改变或像素不一致均报告失败；原始尝试不会被后续结果覆盖。

这些公开规范是独立辅助依据。真实微信开发者工具仍是最终行为 oracle；规范差异、
执行失败和未执行项应原样保留，不能以内部 backend 一致性覆盖外部差异。
