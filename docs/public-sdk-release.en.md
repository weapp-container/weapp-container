# Public SDK Release Status

[简体中文](public-sdk-release.md) · **English**

Checked on 2026-11-25. Every currently visible release is a prerelease. There is no stable version. Source availability, anonymous registry downloads, successful builds, and device acceptance are separate states.

| SDK / artifact | `0.1.0-preview.7.1` status | Current limitation |
| --- | --- | --- |
| Core runtime | GitHub prerelease `runtime-v0.1.0-preview.7.1` is anonymously downloadable | Prerelease only |
| DevTools | GitHub prerelease `devtools-v0.1.0-preview.7.2` is anonymously downloadable | macOS and Windows packages are unsigned; prerelease only |
| Android | Maven Central coordinate `io.github.weapp-container:weapp-container-android:0.1.0-preview.7.1` resolves | Prerelease only |
| React Native | npm package `@weapp-container/react-native@0.1.0-preview.7.1` installs, and its Android dependency resolves | The pinned iOS native archive URL is unavailable |
| Flutter | All seven hosted `.7.1` packages are published on pub.dev | Native builds still require platform-specific verification |
| iOS | The core prerelease contains an iOS SDK tarball | The pinned SwiftPM and CocoaPods archive URLs in `sdk-ios` return 404; its GitHub release does not exist |
| Desktop | The core prerelease contains macOS, Linux, and Windows SDK tarballs | The standalone `sdk-desktop` GitHub release does not exist; the macOS archive URL in the public CocoaPods Specs returns 404 |

The available prerelease installation entries are:

```kotlin
implementation("io.github.weapp-container:weapp-container-android:0.1.0-preview.7.1")
```

```sh
npm install @weapp-container/react-native@0.1.0-preview.7.1
```

```yaml
dependencies:
  weapp_container: 0.1.0-preview.7.1
```

Android, Flutter, and React Native package versions were checked through anonymous Maven Central, pub.dev, and npm metadata requests. The iOS and Desktop status also checks their GitHub releases, CocoaPods Specs, and pinned archive URLs. No `WeappContainer` or `WeappContainerDesktop` entry was found on CocoaPods Trunk.

## Example Applications

Each SDK example uses a portable fixture with a matching runtime version. Review the platform requirements and release limitations in its SDK README, then follow the example directory's commands to create the fixture, build the application, and launch a device or simulator.

- [Android reference app](../sdk/android/consumer/README.en.md)
- [iOS UIKit consumer](../sdk/ios/examples/consumer/README.en.md)
- [React Native consumer](../sdk/react-native/example/README.en.md)
- [Flutter consumer](../sdk/flutter/example/README.en.md)
- [Desktop consumer](../sdk/desktop/consumer/README.en.md)

## Stable Release Requirements

A stable release needs a distinct stable version, immutable installation archives for each SDK, anonymous installation-consumer verification, and target-platform build records for each package manager. `.7.1` is a prerelease and cannot be recorded as stable. The iOS and Desktop GitHub archives are unpublished, so SPM, CocoaPods, and React Native iOS paths that reference those archives cannot be reported as available.
