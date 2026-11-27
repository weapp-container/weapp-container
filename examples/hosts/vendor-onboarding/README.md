# 厂商小程序接入 / Vendor mini-program hosts

两个示例使用同一份 portable pack。小程序调用 `company.getProfile`，Android 和 iOS 宿主各自注册方法，成功时返回 `{ "displayName": "…" }`，拒绝时返回宿主权限错误。接入业务时，把示例返回值替换为宿主经过授权的业务数据。

Both hosts use the same portable pack. The mini-program calls `company.getProfile`. Each host registers the method before loading the pack and returns a display name or a permission error. Replace the sample response with data from your host application.

## Android

使用 JDK 17、Gradle 8.13、Android SDK 36 和 API 26+ 的设备或模拟器。示例从 Maven Central 获取 Android SDK `0.1.0-preview.7.1`，构建时把指定的 pack 放进应用资源。

Use JDK 17, Gradle 8.13, Android SDK 36, and an API 26+ device or emulator. The project resolves the Android SDK from Maven Central and bundles the specified pack.

```sh
gradle -p android assembleDebug -PportablePack=/absolute/path/to/portable-pack
adb -s <serial> install -r android/build/outputs/apk/debug/VendorMiniProgram-debug.apk
adb -s <serial> shell am start -n dev.weapp.vendor/.MainActivity
```

## iOS

从核心 Release 获取 `ios-sdk-0.1.0-preview.7.1-ios-universal.tar.gz` 和 `SHA256SUMS`。核对 SHA-256 后解包到名为 `WeappContainer` 的目录。准备脚本复用 SDK 仓库的 UIKit consumer 项目生成器。 [核心 Release / Core release](https://github.com/weapp-container/weapp-container/releases/tag/runtime-v0.1.0-preview.7.1)

Download the iOS SDK and checksum from the core release. Verify the archive before extracting it into a directory named `WeappContainer`. From this directory, generate and open a UIKit app.

```sh
node prepare-ios.mjs /absolute/path/to/WeappContainer /absolute/path/to/portable-pack /absolute/path/to/ios-demo
open /absolute/path/to/ios-demo/SDKConsumer.xcodeproj
```

Choose an iOS Simulator in Xcode and run the `SDKConsumer` scheme. If you use a source checkout, initialize the `sdk/ios` submodule for the project generator.

## 体验步骤 / Try the host integration

1. Tap the profile button in the mini-program. Check for **Android host** or **iOS host**.
2. Tap **Reject profile** in the native toolbar. Tap the profile button again and check for **Profile access denied**.
3. Switch back to **Allow profile** and tap **重试** in the mini-program. Background and resume the app, then use **Reopen** to verify a fresh session.
