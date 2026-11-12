<a id="react-native-从精确归档安装"></a>
# React Native Installation from Accurate Archive

[简体中文](sdk-react-native-archive-consumer.md) · **English**


React Native preparation and packaging must use the same independently reviewed runtime checklist.
The preview.5.3 history lock in the SDK repository remains intact; the preview.6 source code does not accept it.

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

The default input after preparation is SDK `native/ios`, `native/android`. Also available via
`--ios`, `--android` point to separate, summary-isolated installation directories in the preparation log.
The archive directory is used for re-examination of the original archive; when omitted, only the download cache of the corresponding summary is checked.
Standalone manifest summary, Android/iOS archive summary, npm package summary, wrapper/native source code identity
Retained separately in their respective receipts. The selection list cannot relax the installation content, path, permissions, version, and ABI
Or bounded unpacking checks, and Rust compilation will not be called.

The preparation of independent consumers only proves npm installation and verification of files in the package.
Android Gradle and iOS CocoaPods/Xcode compilation, real SDK→JS callback, simulator interaction,
Physical equipment and merchant transactions are inspected and accepted separately. The new output uses a separate directory and does not overwrite old packages or old acceptance records.

The actual archived consumer for preview6 has been installed and built on macOS arm64: SDK submitted as
`9b75a3dd31d422906e5f82ba54b9ef35dd055b5e`, npm package SHA-256 is
`0acf2335cb49d40a1ac5060027d5982e27370fe7d5ca755d84a59ff5c33ca6e5`。Android
`assembleRelease` and iOS CocoaPods/Xcode `build-for-testing` all pass; complete command,
See Product Summary and Cleanup Boundaries
[`react-native-archive-consumer-r4.json`](archived-evidence.en.md)。
