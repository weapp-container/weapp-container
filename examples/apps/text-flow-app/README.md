<a id="text-flow-fixture"></a>
# 文本流固定装置

**简体中文** · [English](README.en.md)


```sh
pnpm simulator:dev -- --project examples/apps/text-flow-app --viewport 320x680
```

位置为 `(8, 600)` 的控件运行页面的 `onToggle` 事件处理程序。`setData` 将前两个样式的值从 `normal / normal / start` 更改为 `break-spaces / break-all / right`；再次点击可恢复初始样式。位置为 `(168, 600)` 的控件将实际选择器几何信息、计算出的流式样式、页面数据和生命周期历史存储到 `text-flow:observation` 中。

每个示例都在 `<text>` 中使用了绑定。原始未修改的源代码包含首尾和重复的空格、制表符、CRLF、一个长的拉丁词、CJK字符以及组合/零宽Joiner/区域指示符序列。静态示例涵盖了六种空白值、三种断字值和五种文本对齐值。视口和所有示例的宽度都固定不变；宿主不会注入几何信息或替换页面数据。

这些示例演示了共享文本计划和源映射。它们不建立完整的内联格式化、双向文本（bidi）、字体形状、官方字形度量或一致性。位于 `<text>` 之外的未绑定格式化空白空间保留现有的 WXML 过滤边界。旅游应用 ID 用于本地开发；官方 oracle 必须将未修改的构建复制到拥有真实 AppID 的项目中，并验证 IDE `2.02.2608080` / SDK `3.17.3`，并保留自身的观察结果。
