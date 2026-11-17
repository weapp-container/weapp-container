<a id="dataset-and-mark-fixture"></a>
# 数据集和标记固定装置

**简体中文** · [English](README.en.md)


```sh
pnpm simulator:dev -- --project examples/apps/dataset-values-app --viewport 320x480
```

点击 `(24, 40)` 处处理普通页面事件，点击 `(24, 136)` 处处理组件内部原生事件。位于 `(184, 136)` 和 `(24, 392)` 的控件将组件作用域和页面作用域的选择器结果、实际处理器事件、页面数据和生命周期历史保存到 `dataset-values:component` 和 `dataset-values:page` 存储键中。

一个起始于 `(24, 264)` 的识别触摸操作会触发实际的页面处理程序，修改嵌套对象/数组的元数据，并将绿色目标向右移动 160 px。在旧坐标处释放相同的接触操作会检查捕获的目标及其祖先快照，而不是重新定位到红色底层。单独的坐标点击没有接触标识符；一个捕获的触控操作从 `touchstart` 开始，并在整个释放过程中携带相同的标识符。

纯绑定携带 JSON 值；字面量数字/布尔值/空值/JSON 写法、空字符串以及混合插值保持为字符串。父级和目标标记值存在故意冲突：事件标记使用最近的节点，而选择器 `fields({dataset:true, mark:true})` 返回每个节点自身的值。

双引擎运行器为 `pnpm runtime:dataset-values:smoke`；其所需的编译/二进制参数和限制已在
[`docs/event-metadata.md`](../../../docs/event-metadata.md) 中文档化。这是一个本地容器一致性测试环境。旅游类 AppID 无法确立官方 DevTools 行为、对象身份、未定义/存在语义、GPU、设备或性能验收。
