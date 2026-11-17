<a id="flex-order-fixture"></a>
# Flex 订单固定装置

**简体中文** · [English](README.en.md)


```sh
pnpm simulator:dev -- --project examples/apps/flex-order-app --viewport 320x280
```

位置为(10, 220)的暗色控件运行页面的`onToggle`处理程序，使用`setData`将红色项目`order`的值从2更改为-1。位置为(100, 220)的灰色控件在`flex-order:observation`中存储实际选择器的几何信息、DOM选择顺序、生命周期和指针命中信息。行、列及包裹项目会移动；位置为(10, 150)的重叠正方形会更改其顶部绘制项目和坐标点击目标。在两种状态下，选择器都保持声明顺序。

`node scripts/flex-order-smoke.mjs --simulator-bin <native-dual-engine-binary>
--compiler-root <verified-pinned-compiler> --compiler-dist-hashes <dist-map.json>
--out <report.json>` 在没有浏览器的情况下驱动开发 HTTP 绘制表面。
每个引擎为两个阶段使用一个会话。监督器必须在实际点击后自动发布帧；测试从未发送 `render.commit`、数据补丁或注入的 JavaScript。空的实心控件保持完整的 320 × 280 预期 RGBA，与字体无关。

这是辅助本地开发/Skia CPU 证据。它不执行官方 DevTools、浏览器/GPU、设备或严格符合性矩阵。
该旅游 AppID 用于此本地环境；官方验证需要单独配置的实装 AppID 和固定 IDE/SDK 基线。
