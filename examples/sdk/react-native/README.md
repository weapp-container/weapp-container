<a id="independent-react-native-consumer"></a>
# 独立的 React Native 消费者

**简体中文** · [English](README.en.md)


准备示例：`scripts/sdk-react-native-consumer.mjs --package /absolute/path/to/package.tgz --out /tmp/your-consumer`。它使用官方 React Native 0.88 模板，安装精确的 npm 归档文件，验证其内容清单，并包含共享的便携式测试数据。公共 `App.tsx` 调用两个原生 GPU 会话。

运行 `scripts/sdk-react-native-smoke.mjs --consumer /tmp/your-consumer --platform ios|android --device EXISTING_DEVICE_ID --out FRESH_EVIDENCE_DIRECTORY`。Release 是默认值。`--development` 使用真实的 Metro 快速刷新和完整的 React 运行时重新加载。Android 支持 `--refresh-rounds 1..20`。

在 iOS 发布时，默认的 `--rotation device` 使用 XCTest 设备方向。单独的 `--rotation scene` 可以启用原生消费者专属的旋转宿主按钮，调用 UIKit 场景几何 API，并检查实际界面方向/窗口尺寸以及 SDK 绘制表面 resize 事件。它不会修改 SDK 视口 API 或 `App.tsx`，且场景通过不会认证设备方向注入。两种模式都会执行完整生命周期和持久重开门控。

运行时在测试执行失败时保留已执行测试的数量和附件，删除其应用和运行时，恢复临时源代码的变更，并关闭其拥有的 Metro 进程。它从不关闭借来的设备。

导出一个便携示例，使用 `scripts/sdk-react-native-example.mjs --consumer /tmp/your-consumer --out /directory/beside/the/tgz/example --rotation device|scene`。导出会验证离线 `npm ci`，移除已安装的依赖，并记录确切的归档和测试数据哈希值。

`host/` 是一个独立的原生栈、父级 ScrollView 和触摸取消处理组件。
