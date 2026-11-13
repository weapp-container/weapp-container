<a id="wxss-2d-transformation"></a>
# WXSS 2D 变换

**简体中文** · [English](transforms.en.md)


Weapp Container 将变换解析、布局和绘制分成三个步骤，避免在节点尚无尺寸时把
`translate(-50%, -50%)` 错按整个 viewport 计算。

1. IR 在级联前验证 `transform` 和 `transform-origin`。非法声明整条丢弃，包括
   后置 `!important`；有效但尚未实现的值保留，运行时显式失败。
2. 字体继承完成后，运行时冻结 `em`、物理长度、`rpx` 和 viewport 单位。
   百分比保留到布局完成。非 `none` 变换即使为 identity，也建立定位包含块。
3. 布局完成后，以每个节点最终的 border box 计算百分比，按声明顺序生成同一份
   affine matrix。绘制、selector、observer、滚动范围和坐标命中共用它；CanvasKit
   消费已经接受的数值矩阵，不重新解析 WXSS。

例如内容宽 40px、高 20px、padding 4px、border 2px 的节点，其 border box 为
52×32。`translate(-50%, -50%)` 的平移是 (-26px, -16px)，不会取 viewport 的一半。
Flex 分配、自动高度、窗口尺寸或 `setData` 改变尺寸后，下一帧重新计算使用值。

支持 `matrix`、translate/scale 的二维及单轴形式、rotate、skew/skewX/skewY 和
有序列表。角度可用 deg/rad/grad/turn，字面零允许省略角度单位。origin 支持长度、
百分比和 left/right/top/bottom/center，包括 `bottom left` 与 `left bottom`。
第三个零长度可省略；非零 Z 仍明确不支持。

变换与 origin 默认不继承；`initial`、`unset` 使用初始值，显式 `inherit` 复制父
计算值。例如父的 `translate(1em, 50%)` 在 10px 字体下冻结横向 10px；孩子即使
改用 20px 字体，继承的横向仍是 10px，纵向百分比则依据孩子自身的 border box。
selector 的 transform 序列化为自身使用的 `matrix(...)`，origin 为相对自身盒子的
像素位置。旧直接 wire frame 的数值矩阵接口保持可用。

识别出的 deferred math/substitution、3D、perspective、revert/revert-layer 等尚未
实现值返回 `ERR_UNSUPPORTED_CAPABILITY`。长度换算、矩阵合成、origin conjugation、
跨祖先/scroll 累计或变换后的几何超出有限范围时返回 `ERR_RENDER`，不会把它当成
不可见节点而静默跳过。拒绝帧保留原画面、selector 和输入目标。`scale(0)` 是合法
的不可见变换，不是渲染错误。

小而非零的 determinant 不按 epsilon 当作零缩放。矩阵乘加和求逆使用 double
中间值；接受的矩阵及其逆矩阵必须能由宿主的 f32 坐标表达。非零累计值下溢为零时
显式拒绝，避免把失败帧伪装成合法的 `scale(0)`。

transform 祖先与 viewport-fixed 后代的组合仍明确不支持，identity 也相同。
完整 3D、动画插值、跨祖先 stacking context、官方视觉等价和各宿主证据继续单列；
本片二维实现不会将这些门禁标为通过。
transform 创建 stacking context 的绘制顺序仍有差异：变换的 Flex 元素与普通兄弟
元素重叠时，当前按兄弟顺序绘制，Chromium 辅助 fixture 的命中与像素对照保持失败。

开发示例：

```sh
pnpm simulator:dev -- --project examples/apps/transform-app --viewport 320x400
```

点击蓝框切换内容尺寸，点击 Transform 切换百分比平移、90° 旋转与 none。红色边框、
黄色角标和轴线便于观察最终盒子、origin 与命中变化。示例的 selector 和 storage
由真实 Page handler 驱动；开发监督器负责自动重绘。

`style-transform-2d-001` 关联 IR parser/cascade 测试、runtime 模块与真实 App/Page
双引擎测试、renderer 的拒绝原子性测试。设置
`WEAPP_CONTAINER_TRANSFORM_EVIDENCE_DIR` 可导出每引擎 25 个实际接受帧及 CPU/software
RGBA，再运行 `pnpm runtime:transform:frame-replay` 用固定 CanvasKit CPU 回放完整帧。
完整像素比较不经过截图缩放；此证据仍不代表官方 DevTools、WebGL/GPU 或设备通过。

`pnpm runtime:transform:browser-oracle -- --frames <导出目录> --out <新目录>` 另外使用
后台 Chromium 的原生 HTML/CSS 检查同源 fixture 的固定命中点和完整像素。几何和
computed style 仅记录为观察值；该辅助模型不执行 AppService，也不作为容器 Web
宿主或真实微信通过的证明。失败候选数据对应的 retained 帧不纳入这个 HTML 模型。
