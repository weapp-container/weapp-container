<a id="ios-interaction-fixture"></a>
# iOS 交互固定装置

**简体中文** · [English](README.en.md)


该小程序由固定化的 `weapp-vite` 编译器构建，并由普通容器打包器打包。按钮占据逻辑坐标 `(0, 0, 200,
80)`。其实际页面监听器会递增 `count` 并安排一个 100 毫秒的 JS 超时；该超时会递增 `timerCount`，然后其 Promise 会递增 `microtaskCount`。测试用例记录了 App/Page 的前台和尺寸变化钩子。

官方 XCUITest 运行器相对于原生绘制表面定位 `(40, 40)`，
按下主页键，激活同一进程并旋转设备。在验证应用构建中显式启用了只读观察。
它既未调用会话输入 API，也未从 Swift 提供测试数据。

这是本地 iOS 模拟器的证据。它不能证明微信官方等效性、物理设备验收或七宿主一致性。
