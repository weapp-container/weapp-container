<a id="independent-uikit-consumer"></a>
# 独立的 UIKit 消费者

**简体中文** · [English](README.en.md)


烟雾运行程序将准备好的 Swift 包和共享的便携式固定装置复制到一个新的消费者目录中。它编译了设备 arm64 和模拟器 x86_64 目标，然后在现有的借来的 arm64 模拟器上运行一个 XCTest。它从不创建或关闭模拟器。

```sh
node scripts/sdk-ios-smoke.mjs \
  --distribution /absolute/path/to/WeappContainer \
  --simulator EXISTING_SIMULATOR_UDID \
  --out artifacts/sdk/ios/validation
```

默认的 `--rotation device` 使用 `XCUIDevice.orientation`。`--rotation scene` 分别测试宿主的旋转按钮、`setNeedsUpdateOfSupportedInterfaceOrientations()` 和 `UIWindowScene.requestGeometryUpdate`。两种模式都需要实际的界面方向和原生绘制表面尺寸发生改变并返回到纵向。场景模式的通过并不能证明设备方向注入；每条回执都会记录其模式。

两种模式都保留了相同的双会话、异步宿主调用、原生触摸/滚动、导航、后台运行、持久重开、父级/嵌入式滚动以及多点触摸门控。`--compile-only` 在不使用模拟器的情况下验证设备和x86_64的编译/链接；`--simulator-only` 仅构建和运行arm64模拟器客户端，跳过其他两个架构的检查。

SwiftPM 和 CocoaPods 运行器复制相同的 `Sources/Consumer.swift`。所有会话观察者明确处理每个公共事件，包括原生工具栏、关闭错误和版本化的原始事件。原始事件保留在有界的事件历史中。账户切换观察记录回执和当前 SDK 状态，在输入被阻塞时丢弃前拥有者的几何信息，并暴露失败情况；SDK 取消、清理和绘制表面重新绑定仍由 SDK 所有。记录这些事件并不能证明账户切换或宿主服务流程：当前的烟雾测试并未配置账户或支付服务。

回执包括分发库存摘要、可执行文件和消费者/测试源代码的哈希值、执行的测试数量以及已验证的应用程序清理。如果 XCTest 失败，运行器会在删除其应用和运行器之前保留 `last-consumer-result.json`。截图和 xcresult 会与回执一同保留。

生成的项目还提供了一个发布归档配置。从导出的消费者运行 `xcodebuild -project SDKConsumer.xcodeproj -scheme SDKConsumer -configuration Release -sdk iphoneos -destination generic/platform=iOS -archivePath /absolute/path/SDKConsumer.xcarchive CODE_SIGNING_ALLOWED=NO archive` 以生成未签名的归档文件。分发签名和真实设备执行是独立的步骤。
