<a id="react-native-installation-from-accurate-archive"></a>
# React Native 从精确归档安装

**简体中文** · [English](sdk-react-native-archive-consumer.en.md)


React Native 准备和打包必须使用同一份独立审查的 runtime 清单。
SDK 仓库内的 preview.5.3 历史锁保持原样；preview.6 源码不接受它。

```sh
node sdk/react-native/tools/prepare-native.mjs --platform android --arch universal \
  --manifest /absolute/reviewed-lock.json --artifact-dir /absolute/archives
node sdk/react-native/tools/prepare-native.mjs --platform ios --arch universal \
  --manifest /absolute/reviewed-lock.json --artifact-dir /absolute/archives
node scripts/sdk-react-native-build.mjs \
  --manifest /absolute/reviewed-lock.json --manifest-sha256 INDEPENDENT_LOCK_SHA256 \
  --artifact-dir /absolute/archives --out /absolute/new-rn-package
node sdk/react-native/tools/create-consumer.mjs \
  --package /absolute/new-rn-package/weapp-container-react-native-0.1.0-preview.6.0.tgz \
  --out /absolute/new-independent-rn-consumer
```

准备后的默认输入为 SDK `native/ios`、`native/android`。也可通过
`--ios`、`--android` 指向准备日志中的独立、按摘要隔离的安装目录。
归档目录用于原归档重验；省略时只查对应摘要的准备下载缓存。
独立清单摘要、Android/iOS 归档摘要、npm 包摘要、wrapper/native 源码身份
在各自收据中分别保留。选择清单不能放宽安装内容、路径、权限、版本、ABI
或有界解包检查，也不会调用 Rust 编译。

独立 consumer 的准备只证明 npm 安装及包内文件校验。
Android Gradle 和 iOS CocoaPods/Xcode 编译、真实 SDK→JS 回调、模拟器交互、
物理设备和商户交易分别验收。新输出使用独立目录，不重写旧包或旧验收记录。

preview6 的实际归档 consumer 已在 macOS arm64 上完成安装和构建：SDK 提交为
`9b75a3dd31d422906e5f82ba54b9ef35dd055b5e`，npm 包 SHA-256 为
`0acf2335cb49d40a1ac5060027d5982e27370fe7d5ca755d84a59ff5c33ca6e5`。Android
`assembleRelease` 和 iOS CocoaPods/Xcode `build-for-testing` 均通过；完整命令、
产物摘要与清理边界见
[`react-native-archive-consumer-r4.json`](archived-evidence.md)。
