# Flutter SDK consumer

This application consumes the sibling `packages/weapp_container` distribution.
Keep `consumer` and `packages` together when moving the distribution. No Rust
checkout or Rust compiler is required. Use Flutter 3.47.7 stable and the normal
native development tools for the selected target.

```sh
flutter pub get
flutter analyze lib
flutter run -d <device-id>
```

For Android, install platform SDKs 35 and 36, NDK 27.1.12297006, and CMake 3.22.1.
The app and its native plugin modules select that NDK. The Gradle wrapper pins
9.4.1 and verifies its distribution checksum. Build the two supported ABIs with:

```sh
flutter build apk --debug --target-platform android-arm64,android-x64
```

iOS requires iOS 16 or later; macOS requires macOS 12 or later. Check the sibling
`distribution.json` for packaged targets. A blocked target needs its native SDK
artifact before it can build; this preview does not include a Windows binary.

The app displays a bounded native mini-program view. Tap its first button and
scroll the list to start the remaining lifecycle, navigation, Unicode, host
method, remount, reload, and durable-storage checks. Results appear on screen
and in `sdk-flutter-report.json` inside the app's application-support directory.
Automation runners and fixture generation are maintained in the source
repository's `scripts/sdk-flutter-*` and `sdk/flutter/native_desktop/tests`.
