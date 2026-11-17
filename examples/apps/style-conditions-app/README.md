<a id="wxss-condition-fixture"></a>
# WXSS 条件固定装置

**简体中文** · [English](README.en.md)


从仓库根目录运行：

```sh
cargo run -p container-simulator -- dev --project examples/apps/style-conditions-app --surface web --viewport 200x200
```

`srcMiniprogramRoot: "."` 声明了 App/Page 的源代码，而
`miniprogramRoot: "dist/"` 则将编译器拥有的输出与源代码分离。将两者都指向 `.`，可以让编译器输出清理工具移除自己的输入。本示例使用了与参考应用相同的固定编译器和源/输出边界；它不需要子包或分块的更改。双引擎验证命令和编译器来源要求详见 [WXSS 指南](../../../docs/wxss-ir.md#reproduce-the-native-sample)。

面板在 100×200 时为红色，200×100 时为蓝色，200×200 时为绿色。一个条件性的本地导入会为宽度至少为 150 逻辑像素的第二个方块上色。点击面板，然后检查：真实的页面数据、选择器几何信息和生命周期观察值存储在 `styles:observation` 下。调整大小或重新渲染应保留会话和计数器。`print` 和未知的否定特性分支不得覆盖面板。此测试用例是容器回归测试；官方 DevTools、GPU/设备和性能验收是独立的审核门禁。
