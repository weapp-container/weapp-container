<a id="dev-player-chrome-fixture"></a>
# Dev Player chrome 修复工具

**简体中文** · [English](README.en.md)


```sh
pnpm simulator:dev -- --project examples/apps/player-chrome-app --surface devices
```

使用一次性设备链接连接 preview.4 Player。该应用测试了
正常/自定义导航、动态标题/颜色、宿主 tabBar、胶囊几何形状、页面返回，以及在胶囊关闭/重新打开时的持久化存储。

打开工具保留计数；后退导航保留首页计数；
关闭/重新打开会重置页面内存但保留已保存的存储。旋转并检查报告的胶囊坐标是否与逻辑屏幕像素中的实际胶囊坐标一致。
原始微信输出在官方开发者工具中仍可正常使用。
