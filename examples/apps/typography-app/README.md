<a id="typography-fixture"></a>
# 字体固定装置

**简体中文** · [English](README.en.md)


运行 `pnpm simulator:dev -- --project examples/apps/typography-app --surface web`。
两个顶部标签继承了数值或百分比的行高。“resize text” 通过实际的页面处理器更改父元素的字体大小；“inspect” 将已提交的选择器结果存储在 `typography:observation` 中。

该测试输入还包含显式的新行符，可见墨水的零行高，以及零字体大小。`pnpm runtime:typography:smoke -- --simulator-bin …
--compiler-root … --compiler-dist-hashes … --out …` 使用固定版本的编译器进行构建，并与原生 QuickJS/V8 运行结果进行对比。这是本地运行时的证据；官方微信排版、完整字体 shaping、GPU 以及设备一致性仍为独立的验收要求。
