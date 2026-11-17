<a id="flex-layout-fixture"></a>
# Flex 布局测试 fixture

**简体中文** · [English](README.en.md)


在开发模拟器中运行应用：

```sh
pnpm simulator:dev -- --project examples/apps/flex-layout-app --viewport 360x800
```

固定的 360 × 800 验证视口覆盖了默认的行流向、比例增长、缩小、换行、对齐、嵌套容器框的百分比、最小/最大约束、指定宽度文本测量以及绝对/固定框。

底部控件使用实际的页面处理器来更改换行宽度、滚动页面 100px，并将选择器/生命周期结果记录到 `flex:observation` 存储中。

滚动后，蓝色的固定视口方块仍可点击。在滚动阶段不会注入渲染提交，因此它还检查自动帧更新。

`pnpm runtime:flex:smoke` 使用经过验证的固定编译器生成原始输出，并对比三个 QuickJS/V8 阶段和完整的原生 CPU RGBA。请根据命令的必选项提供编译器和模拟器路径。
该本地测试用例使用 `touristappid`；它不是官方 DevTools 运行。
官方执行需要单独配置的真正 AppID 以及固定的 IDE/SDK 基线。仅凭此测试用例无法获得 GPU、设备、性能或接近一致的结果。
