<a id="transparency-and-subtree-compositing"></a>
# 透明度与子树合成

**简体中文** · [English](compositing.en.md)


`opacity` 对节点已经绘制完成的整棵子树生效。节点自己的背景、边框、文本、图片
与后代先按绘制顺序合成到透明图层，再将图层按该节点的透明度合成到父图层。
因此，同一个 `opacity:.5` 容器中相互重叠的不透明红、蓝节点，交叠区域先由蓝色
完全覆盖红色，最后整体以半透明蓝色覆盖底色。不能将 `.5` 分别乘到红、蓝两个
primitive 上；那样会让已经被遮住的红色重新出现在交叠区域。

父子节点都声明透明度时，分别形成合成边界。父 `.5`、子 `.5`、其他部分透明的
情况下，子节点的可见贡献约为 `.25`。如果父节点还有不透明背景，必须先将子组
合成到这个背景上，再处理父组透明度，不能直接把所有 primitive 的 alpha 乘为 `.25`。

<a id="attribute-parsing"></a>
## 属性解析

WXSS 在级联之前校验 `opacity`，再将有效声明解析到统一 `RenderNode.opacity`：

| 声明 | 计算结果 |
| --- | --- |
| 缺省、`initial`、`unset` | `1` |
| 数值、百分比 | 归一化并裁剪到 `[0,1]`，例如 `.5` 与 `50%` 均为 `.5` |
| `inherit` | 复制父节点的计算透明度，子节点仍有自己的合成边界 |
| 非法声明 | 级联前丢弃，不覆盖此前有效声明 |
| 已识别的 `calc()`、`var()`、`env()`、`revert`、`revert-layer` | 显式返回 `ERR_UNSUPPORTED_CAPABILITY` |

合法数值在存入 `f32` 前先裁剪；`1e39` 得到 `1`，`-1e39`、`1e-46` 得到 `0`，
不会因为字体数值解析器的范围限制而露出更早的声明。百分比的数值乘除保持类型，
例如 `calc(50% / 2)` 是有效但暂不支持的值，必须显式拒绝，不能按非法声明丢弃。

透明度默认不继承。父 `.5`、子未声明透明度时，子节点字段仍为 `1`，它的像素
由父组合成变淡；子显式 `inherit` 时自身字段才为 `.5`，从而形成第二个合成边界。

显式 wire frame 是已经解析完成的渲染协议，要求每个 `opacity` 为有限的 `[0,1]`
数值。它不执行 WXSS 值裁剪；例如直接提交 `opacity:2` 会返回 `ERR_RENDER`。
无效帧不会替换已经接受的 frame、snapshot、selector 几何或输入命中树。

<a id="layout-and-input"></a>
## 布局和输入

`opacity:0` 跳过像素绘制与透明图层分配，节点与后代仍参与布局、selector 查询
和命中测试。坐标 tap 仍分发到原目标的 Page/Component listener。已有 touch
contact 不会仅因目标或祖先变透明而取消；移除节点、页面卸载等原有输入失效边界
仍按各自规则处理。`display:none` 的布局和输入规则是独立属性的行为。

合成边界不改变 WXML 文档顺序、事件父链、Flex order 或现有兄弟绘制次序。
viewport-fixed 后代仍属于祖先透明度组；它脱离的是祖先滚动和 overflow clip。

<a id="various-rendering-paths-and-resource-limitations"></a>
## 各绘制路径与资源限制

软件 renderer 使用预乘 RGBA8 图层，原生 Skia 和 Web CanvasKit 使用独立
save-layer。各路径均先绘制完整子树，再以 SrcOver 合成到父目标；组透明度统一
量化为 `round(opacity * 255)`。嵌套组分别量化。原生与软件像素比较允许每通道
最多 1 个字节的舍入差异，不把这种容差扩展为几何、目标或绘制次序容差。

原生 N32 使用仅缩放 alpha 的图层恢复 filter，使 Skia 走浮点合成管线。直接使用
旧 sprite blitter 的 `save_layer_alpha` 会经过 `(alpha + 1) / 256` 近似，白底半透明
颜色可少 1 字节，嵌套时可少 2 字节。该实现选择不改变图层格式或扩大像素容差。

提交前按目标尺寸与同时存活的半透明组深度检查合成预算：

- 最多 32 层可见的嵌套半透明组。
- 额外同时存活的 RGBA8 图层预算为 64 MiB；按完整目标面积保守估计。
- `opacity:1` 不新增透明组，`opacity:0` 与 `display:none` 子树不占用图层预算。
- 软件 renderer 在兄弟组之间复用已经分配的图层存储。

这个预算仅约束额外透明图层，不包含目标 surface、snapshot、字体、图片和 Skia
内部开销，也不是整个进程或 GPU 内存的上限。超过预算的候选帧被拒绝，保留上一份
接受的画面；不会以逐 primitive 透明度或忽略透明度进行静默降级。

当前边界覆盖已有绘制树中的透明子树合成。它没有补齐完整 CSS stacking context，
跨祖先的 z-index、blend mode、filter、backdrop-filter 等仍有独立缺口。本轮结果
也不构成 GPU、七宿主、真实设备或性能门槛通过。

<a id="local-regression"></a>
## 本地回归

`crates/container-runtime/tests/group_opacity.rs` 使用真实 CommonJS `App` / `Page`
模块、校验后的 WXML/WXSS blob、QuickJS/V8 与实际 Page `setData`。测试在宿主
发布边界读取当前 Page 数据生成 frame，并把同一份已接受 frame 交给独立软件
renderer 回放，覆盖：

- 重叠后代在 `.5`、`.25` 与 `1` 之间更新时的最终像素。
- `opacity:0` 时 selector 几何、坐标 tap、Page 数据与已捕获 touch 的连续性。
- 有背景的父组与半透明子组的嵌套合成。
- 百分比、显式继承、`initial`、`unset` 与缺省值。
- 极大、极小数值裁剪，以及有效但暂不支持的表达式拒绝与后续有效更新恢复。
- 非法显式帧拒绝后，原 snapshot、输入树和查询结果保持可用。

```sh
cargo test -p container-runtime --locked \
  --features quickjs-native,v8-native,container-render-skia/skia-backend \
  --test group_opacity
```

省略 `container-render-skia/skia-backend` 时，runtime 的 renderer 可以使用软件路径；
输出会保留真实 backend 名称，不能将其记为原生 Skia 或 GPU 验收。两个原生 JS
引擎也分别要求对应 feature，不通过切换引擎掩盖失败。

设置 `WEAPP_CONTAINER_OPACITY_EVIDENCE_DIR=/absolute/path` 可导出每个引擎、每个
阶段的实际 frame、采样预期、runtime backend、RGBA 哈希，以及 `.runtime.rgba`
和 `.software.rgba` 原始快照。导出数据仅代表这些本地 contract；测试中的显式
refresh 不能替代开发态监督器自己的刷新循环，也不能记为真实 DevTools 对照。

导出目录可以交给固定版本的真实 CanvasKit CPU 回放；它会要求完整的 31 阶段 ×
两个引擎，校验原始快照哈希，并比较完整 RGBA：

```sh
pnpm runtime:opacity:frame-replay --frames /absolute/runtime-frames \
  --canvaskit-dir /absolute/canvaskit-0.42.0 --out /absolute/new-replay-directory
```

该回放只调用真实 CanvasKit CPU 绘制 API，不初始化 WebGL 或运行 Web 宿主。独立
Chromium HTML/CSS 对照另外保存截图、完整 RGBA、语义与像素状态；辅助结果可以
因其本机光栅化舍入而出现差分，不能改写为通过，也不能替代微信最终 oracle。


<a id="development-time-true-product-and-auxiliary-css-oracle"></a>
## 开发态真实产物与辅助 CSS oracle

`style-opacity-group-001` 关联上述 runtime contract、renderer/CanvasKit 单测，以及
`examples/apps/group-opacity-app` 的开发态执行链。`view.wxml-wxss`、七个宿主与
QuickJS/V8 的 inventory 支持级别继续为 `partial`。

先按 [模拟器构建器准备步骤](simulator.md#开发态监督器) 准备固定 commit 的
`weapp-vite` 源码、编译 dist 与对应 SHA-256 清单，然后直接运行：

```sh
pnpm simulator:dev -- --project examples/apps/group-opacity-app --viewport 320x300
```

左上半透明组包含红色父背景与重叠的绿、蓝后代，右上是嵌套的两个半透明组。
在不可见区域坐标 `(30,170)` 点击仍会命中后代并冒泡到父节点；Page handler
通过 `setData` 恢复可见状态，同时将左上组改为不透明。点击 `(20,250)` 再次隐藏，
点击 `(110,250)` 将 selector、计算样式、lifecycle、dataset 与事件观察保存到
`group-opacity:observation`。示例没有文字，像素预期不依赖宿主字体。

自动执行两种引擎的真实 watch/build、portable pack 与 HTTP/SSE 输入：

```sh
cargo build -p container-simulator --no-default-features \
  --features quickjs-native,v8-native,container-render-skia/skia-backend --locked
pnpm runtime:opacity:smoke -- \
  --simulator-bin target/debug/weapp-simulator \
  --compiler-root <verified-pinned-compiler> \
  --compiler-dist-hashes <compiler-dist-sha256.json> \
  --out artifacts/group-opacity.json
```

每个引擎在同一 session 中依次观察 initial、restored、hidden-again 和 restored-again。
每次输入只发送实际坐标 tap，重绘由 supervisor 自动触发；collector 不发送数据补丁、
`render.commit`、手写 frame 或注入 JavaScript。报告保存原始 compiler 输出、完整
portable pack、独立重新打包的比较、Page storage/selector、HTTP/SSE journal 和每阶段
完整 RGBA。全部 RGB 通道与独立矩形合成预期允许最多 1 字节量化差，alpha 精确；
QuickJS 与 V8 的完整结果必须一致。失败尝试仍保留原始观察和日志。

另一个入口只运行独立 HTML/CSS 模型，使用本任务所有的 headless Chromium：

```sh
pnpm runtime:opacity:browser-oracle -- \
  --package <path/to/package.json-with-playwright> \
  --out artifacts/group-opacity-chromium.json
```

它记录原生计算 CSS、真实鼠标坐标点击、几何、PNG screenshot 及解码后的完整 RGBA，
并关闭自己创建的 context/browser。HTML 模型不加载容器，也不代表微信 WXML 执行；
它是辅助 CSS 观察，不能写成官方 DevTools baseline。两份 collector 都不改变
官方 case、GPU、真机、性能或 near-parity 门禁状态。

相关绘制合同：[图片资源](images.md)、[边框与盒模型](wxss-borders.md)、
[布局](layout-flow.md) 和 [滚动与输入](scrolling.md)。
