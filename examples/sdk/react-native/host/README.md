<a id="native-host-integration-acceptance"></a>
# 本地宿主集成验收

**简体中文** · [English](README.en.md)


此工具与可分发的示例分离。它安装了精确的 npm 归档，验证每个 SDK 文件与其清单的一致性，并仅向新的独立消费者添加固定版本的 React Navigation native-stack 依赖项。它不会修改 SDK 代码或主示例。

```sh
node scripts/sdk-react-native-host-consumer.mjs --package PATH_TO_SDK.tgz --out /tmp/weapp-rn-host-consumer
node scripts/sdk-react-native-host-smoke.mjs --consumer /tmp/weapp-rn-host-consumer --platform ios --device EXISTING_SIMULATOR_ID --out /tmp/rn-host-ios-evidence
node scripts/sdk-react-native-host-smoke.mjs --consumer /tmp/weapp-rn-host-consumer --platform android --device EXISTING_EMULATOR_ID --out /tmp/rn-host-android-evidence
```

该应用将控制器置于原生宿主导航栈之上，并将原生绘制表面嵌入 React Native `ScrollView` 中。测试在实际执行宿主的 push/pop 操作的同时，保持小程序自身的页面栈和状态不变，可分别拖动父区域和嵌入的滚动区域，并在手指仍按在屏幕上时推送宿主路由。最后一种情况需要原生 `touchcancel`，避免意外点击，并在返回后成功检测到新的触摸事件。

该测试用例通过触摸事件观察扩展了共享的验收包。其独特的内容哈希值记录在回执中。iOS 运行三个 XCTest 方法，并导出每个测试的 JSON 和截图。Android 使用设备输入运行已安装的发布版 APK，并记录其回执、截图和应用进程日志。仅构建本身并不等同于通过设备测试。在诊断失败时，iOS 可通过 `--test testHostRoute`、`--test testNestedScroll` 或 `--test testTouchCancellationOnHostPush` 选择一个方法。

为每次运行使用一个全新的证据目录。运行器仅卸载其自身的应用和XCTest运行器，并保留借来的设备。绝不与其他任务的设备交互同时运行。
