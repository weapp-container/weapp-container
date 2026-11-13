<a id="flutter-sdk-consumer"></a>
# Flutter SDK 消费者

**简体中文** · [English](README.en.md)


该应用消耗了兄弟包 `packages/weapp_container` 的分发版本。
移动分发版本时，请保持 `consumer` 和 `packages` 一起移动。无需检查出 Rust 代码或 Rust 编译器。使用 Flutter 3.47.7 稳定版本以及选定目标的常规原生开发工具。

```sh
flutter pub get
flutter analyze lib
flutter run -d <device-id>
```

对于 Android，安装平台 SDK 35 和 36、NDK 27.1.12297006 和 CMake 3.22.1。
应用及其原生插件模块选择该 NDK。Gradle 包装器固定为 9.4.1 并验证其分发校验和。使用以下命令构建两个支持的 ABIs：

```sh
flutter build apk --debug --target-platform android-arm64,android-x64
```

iOS 要求 iOS 16 或更高版本；macOS 要求 macOS  12 或更高版本。请查看同级的 `distribution.json` 以获取打包目标信息。被阻塞的目标在没有其原生 SDK 产物之前无法构建；本预览版本不包含 Windows 二进制文件。

该应用显示一个限定的原生小程序视图。点击其第一个按钮，然后滚动列表以启动剩余的生命周期、导航、Unicode、宿主方法、重新挂载、重新加载以及持久化存储的检查。结果将在屏幕上和应用支持目录中的 `sdk-flutter-report.json` 文件中显示。自动化运行器和测试用例生成维护在源代码仓库的 `scripts/sdk-flutter-*` 和 `sdk/flutter/native_desktop/tests` 目录中。
