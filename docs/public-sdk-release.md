# Public preview release 0.1.0-preview.7.0

Status: partially published. ABI remains 1. Contract npm, the Flutter platform interface, Core/iOS/Desktop prereleases and the public CocoaPods Specs source are available. Central, React Native and the six remaining Flutter packages remain blocked as recorded below. [中文状态与安装](public-sdk-release.zh-CN.md).

| Distribution | Public entry | Verified scope |
| --- | --- | --- |
| Contract | [npm 0.1.0-preview.7.0](https://www.npmjs.com/package/@weapp-container/sdk-contract/v/0.1.0-preview.7.0) | preview tag, exact anonymous tarball bytes, fresh anonymous installation, TypeScript types, tool exports, authored fixture and all 14 public runtime pins; trusted publisher configured and read back |
| Flutter interface | [pub.dev 0.1.0-preview.7.0](https://pub.dev/packages/weapp_container_platform_interface/versions/0.1.0-preview.7.0) | Exact anonymous archive bytes, fresh hosted resolution, static analysis and both JSON transport consumer tests; GitHub OIDC configured; interface only |
| Core runtime | [runtime-v0.1.0-preview.7.0](https://github.com/weapp-container/weapp-container/releases/tag/runtime-v0.1.0-preview.7.0) | All 14 archives anonymously downloaded, size/SHA-256 checked, fresh offline installation and wrong-hash rejection passed |
| iOS | [v0.1.0-preview.7.0](https://github.com/weapp-container/sdk-ios/releases/tag/v0.1.0-preview.7.0) | Both ZIPs downloaded anonymously; remote SwiftPM simulator/device compilation; final arm64 simulator interaction acceptance |
| Desktop | [v0.1.0-preview.7.0](https://github.com/weapp-container/sdk-desktop/releases/tag/v0.1.0-preview.7.0) | Three archives downloaded anonymously; public macOS/Linux/Windows CI consumption and local arm64/Rosetta consumption |
| CocoaPods | [weapp-container/Specs](https://github.com/weapp-container/Specs) | Both Pods passed remote lint, fresh public Specs resolution, iOS simulator/macOS build/link and macOS C API execution; Trunk not submitted |

```sh
npm install @weapp-container/sdk-contract@0.1.0-preview.7.0
```

```swift
.package(url: "https://github.com/weapp-container/sdk-ios.git", exact: "0.1.0-preview.7.0")
```

```ruby
source 'https://github.com/weapp-container/Specs.git'
source 'https://cdn.cocoapods.org/'
pod 'WeappContainer', '0.1.0-preview.7.0' # iOS target
# macOS target: pod 'WeappContainerDesktop', '0.1.0-preview.7.0'
```

The iOS wrapper requires Xcode 27.2+ to compile, in Swift 5.9 language mode; the deployment minimum remains iOS 16. The [fresh public Specs consumer](https://github.com/weapp-container/Specs/actions/runs/43305915732) uses an isolated CocoaPods home/cache and disables Git credentials. The first public iOS Podspec explicitly flattens its ZIP parent directory. Published archives and tags remain unchanged.

Frozen core producer: `51aadc009e0c2540bebca497779bada600cb9d9e`. iOS wrapper producer: `330ba95abce016c671356c2e276f9af433341d4f`, install metadata producer: `0ef7c94a43d97ca70fdb6759479388730121c22f`. Desktop producer: `4aa61aa1c8c1f4cb2b03f42114730220148524ea`. New default locks use this public core release; historical locks retain their original bytes.

Android packaging and API 36 arm64 simulator interaction acceptance passed. iOS device and x86_64 simulator compile/link checks and arm64 simulator interaction acceptance passed. Physical-device execution is not recorded. Rosetta execution is not Intel hardware acceptance. The [anonymous Desktop consumer matrix](https://github.com/weapp-container/sdk-desktop/actions/runs/43305230931) passed public download, checksum validation, unpacking, directory relocation, compilation, linking and interaction execution on all three OSes.

Published Desktop erratum: the immutable `0.1.0-preview.7.0` archives contain a stale `WEAPP_DESKTOP_VERSION` C header macro (`0.1.0-preview.6.0`). Package metadata and linked runtime are `0.1.0-preview.7.0`, ABI 1. Current source corrects the macro and adds a version coordination test; a corrected distribution requires a new version. Existing tags, archives and hashes are retained.

Remaining blockers: Central Portal credentials and PGP signing are unavailable; the maintainer deferred PGP configuration and Trunk registration. React Native and Flutter Android therefore lack their public Maven dependency. Contract is public with the preview tag and GitHub trusted publishing. Its anonymous tarball matches the validated SHA-256 `232330e1234a70a27e7d9d6e1d4c61233cecb580cd1703fcc4bb9ae169465853`. pub.dev first login succeeded; the public platform interface matches SHA-256 `777e97fd7ca14aebc6aac851d9a9d20135960216658ef16a4180b1cb63bef1e1` and passed fresh hosted consumption. The next package in the agreed order is Android, whose public Maven dependency remains unavailable; the five platform packages and main package are unpublished. Complete hosted dependency publication, Flutter/RN public consumption and physical-device acceptance before reporting the entire release complete.

Run from clean committed source. Historical tags, locks, ORIGIN and evidence are immutable. New builds use one clean core production commit. Never overwrite an existing tag, version, asset or checksum. A failed published version requires a new version.

## Order

1. Core `public-native.yml` builds nine native targets from one commit, collects licenses, validates hashes and packages the runtime. Download `public-runtime` and run the existing runtime publisher with `--execute` only after its offline verification passes.
2. Android, iOS and Desktop `build-public.yml` select that successful core run ID. Their source inventory and producer receipts bind the native input. Retain the original verified archive bytes.
3. Publish Android to Central, iOS/desktop prereleases to GitHub, then import their HTTP/hash-pinned Podspecs into `weapp-container/Specs`. Trunk registration is deferred by the maintainer for this release; record it as not submitted.
4. Update current default runtime locks using the actual verified core manifest; preserve old locks under historical filenames. Pin iOS URLs/checksums with `--pin`, commit reviewed changes, and `--finalize` the original archives.
5. Publish Contract, React Native, then Flutter platform interface, five platform packages, and main package. Validate public consumers from fresh directories without GitHub authentication. Record build, simulator and real device results independently.

## Authentication

First npm publication requires an npm user with publish access to `@weapp-container`, browser login/2FA and `--access public --tag preview`. Configure npm trusted publishing for `publish-npm.yml` after the first publication.

First pub.dev publication requires human login for each new package; configure package-specific GitHub OIDC after creation. Maven Central needs verified `io.github.weapp-container`, Portal user-token credentials and a publicly discoverable PGP signing key. Set `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `WEAPP_SIGNING_KEY`, and optional `WEAPP_SIGNING_PASSWORD` in the local process or repository secrets; never commit values. CocoaPods Trunk registration/email verification belongs to the account owner.

## Acceptance

Verify every archive SHA-256/size, architecture, dynamic dependency and license. Exercise interrupted downloads, mismatched hash/version and offline cache without fallback. Run npm pack and installed exports/types, Flutter analyze/publish dry-run, Pod lint, SwiftPM consumer and Central validation. Real consumers must load, display, interact, exchange host messages, navigate and close with the authored test pack. CI software rendering does not prove hardware or device acceptance.
