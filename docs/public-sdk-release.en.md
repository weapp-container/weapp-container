# Weapp Container 0.1.0-preview.7.0 release status

[简体中文](public-sdk-release.md) · **English**

Contract npm, the Flutter platform interface, core runtime, iOS and Desktop GitHub prereleases and the organization’s public CocoaPods Specs source are available. **Publication of the complete SDK set is unfinished**: Android Central, React Native, the five Flutter platform packages and the main package have the blockers below.

## Public entry points

| Distribution | Public entry | Validation |
| --- | --- | --- |
| Contract | [npm 0.1.0-preview.7.0](https://www.npmjs.com/package/@weapp-container/sdk-contract/v/0.1.0-preview.7.0) | Preview tag, exact anonymous tarball bytes, fresh anonymous installation, types/tool exports, authored fixture and all 14 public runtime pins passed; trusted publisher configured and read back |
| Flutter interface | [pub.dev 0.1.0-preview.7.0](https://pub.dev/packages/weapp_container_platform_interface/versions/0.1.0-preview.7.0) | Exact anonymous archive bytes, fresh hosted resolution, static analysis and both transport consumer tests passed; GitHub OIDC configured; interface only |
| Core runtime | [runtime-v0.1.0-preview.7.0](https://github.com/weapp-container/weapp-container/releases/tag/runtime-v0.1.0-preview.7.0) | All 14 archives downloaded anonymously and passed SHA-256 checks, fresh offline installation, cache verification and wrong-hash rejection |
| iOS | [v0.1.0-preview.7.0](https://github.com/weapp-container/sdk-ios/releases/tag/v0.1.0-preview.7.0) | Both ZIPs downloaded anonymously; public SwiftPM simulator/device compilation; final arm64 simulator interaction XCTest passed |
| Desktop | [v0.1.0-preview.7.0](https://github.com/weapp-container/sdk-desktop/releases/tag/v0.1.0-preview.7.0) | Three archives downloaded anonymously; public macOS/Linux/Windows CI consumers and local ARM/Rosetta consumers passed |
| CocoaPods | [weapp-container/Specs](https://github.com/weapp-container/Specs) | Both Pods passed remote lint, fresh public Specs resolution, iOS simulator/macOS build/link and macOS C API execution; no Trunk submission |

```sh
npm install @weapp-container/sdk-contract@0.1.0-preview.7.0
```

```swift
.package(url: "https://github.com/weapp-container/sdk-ios.git", exact: "0.1.0-preview.7.0")
```

```ruby
source 'https://github.com/weapp-container/Specs.git'
source 'https://cdn.cocoapods.org/'
pod 'WeappContainer', '0.1.0-preview.7.0' # iOS
# macOS target: pod 'WeappContainerDesktop', '0.1.0-preview.7.0'
```

iOS compilation requires Xcode 27.2+; the deployment minimum is iOS 16. Device-target compilation is not physical-device execution acceptance.

## Implementation and validation

The core producer is `51aadc009e0c2540bebca497779bada600cb9d9e`; C ABI 1. Both Android ABIs, iOS device and two simulator architectures, both macOS architectures, and Linux/Windows x86_64 were produced from that clean commit. Public provenance records sources, toolchains, licenses, sizes and hashes. Historical versions, tags, locks and assets remain unchanged.

PRs for the five SDK default locks and regression checks have merged; the Contract public lock merged earlier. Release verification now uses the release ID returned on creation to validate drafts, avoiding 404 responses for unpublished tags. Existing-version/draft refusal and full hash validation remain in place.

Android release AAR/POM/sources/javadoc, R8, both ABIs, 16KB alignment and API 36 arm64 simulator interaction acceptance passed. Final iOS archives passed arm64 device and x86_64 simulator compilation and complete arm64 simulator interaction acceptance. Physical-device execution remains unverified. Desktop public archive consumers passed on all three OSes ([CI 43305230931](https://github.com/weapp-container/sdk-desktop/actions/runs/43305230931)), covering download, checksums, extraction, directory relocation, compilation, linking and interactive execution. Rosetta is not Intel hardware acceptance.

The six SDK source/tool suites passed 263 tests (Contract 39, Android 50, iOS 48, Desktop 45, Flutter 35, RN 46). Complete submodule identity and public-lock closure checks passed.

The public Contract version passed fresh anonymous installation, TypeScript 6.0.3 type checks, tool exports, all 14 public-lock entries and authored-fixture checks. Its public archive SHA-256 is `232330e1234a70a27e7d9d6e1d4c61233cecb580cd1703fcc4bb9ae169465853`. The public Flutter interface archive SHA-256 is `777e97fd7ca14aebc6aac851d9a9d20135960216658ef16a4180b1cb63bef1e1`; static analysis and both public transport consumer tests passed.

The Contract downloader installed from public npm downloaded and installed the macOS arm64 runtime without GitHub credentials or Authorization headers. With network access disabled, cache verification and installation reuse passed. Wrong versions and hashes were rejected without attempting a fallback.

All five Flutter platform candidates passed dependency resolution, static analysis and publication dry-runs with zero warnings. Archives containing the same validated bytes are frozen. Platform packages exclude repository tests and alternate changelogs, and installed documentation links point to an immutable source commit. These checks cover packaging only; the candidates remain unpublished and native consumer acceptance is incomplete.

## Deferred work and blockers

- CocoaPods Trunk registration and PGP signing configuration are deferred; no Trunk submission was made.
- The Maven Central namespace is verified, but Portal credentials, signing and real upload are unfinished. Public Maven dependencies for React Native and Flutter Android are therefore unavailable.
- First pub.dev login is complete and the interface is public. Continue in the agreed order with the Android package; its public Maven dependency remains unavailable. The five platform packages and main package remain unpublished.
- Public Flutter consumption on five platforms, React Native consumption on two platforms, and Android/iOS physical-device execution remain incomplete.
- Published Desktop archives retain the stale `WEAPP_DESKTOP_VERSION` C header macro `0.1.0-preview.6.0`; package metadata and runtime are `0.1.0-preview.7.0`. Current source fixes it and adds a coordination test. Published bytes are immutable; a corrected distribution needs a new version.
- The core repository now pins the six SDK public locks and publication configurations; full submodule identity verification passed.

A distribution is recorded as published only after its registry entry exists, anonymous download works and its consumer validation passes. Compilation, simulator and physical-device results are recorded separately.


<a id="order"></a>
## Release order

1. Core `public-native.yml` builds nine native targets from one commit, collects licenses, validates hashes and packages the runtime. Download `public-runtime` and use the existing publisher’s `--execute` only after offline verification passes.
2. Android, iOS and Desktop `build-public.yml` select that successful core run ID. Source inventories and producer receipts bind native inputs. Retain the original verified archive bytes.
3. Publish Android to Central and iOS/Desktop prereleases to GitHub, then import HTTP/hash-pinned Podspecs into `weapp-container/Specs`. Trunk registration is deferred for this release; record it as not submitted.
4. Update current default runtime locks with the verified core manifest; retain historical locks under separate filenames. Pin iOS URLs/checksums with `--pin`, review and commit, then `--finalize` the original archives.
5. Publish Contract, React Native, then Flutter platform interface, five platform packages and main package. Validate public consumers from fresh directories without GitHub authentication. Record build, simulator and physical-device results separately.

<a id="authentication"></a>
## Publication authentication

First npm publication requires an npm user with publish access to `@weapp-container`, browser login/2FA and `--access public --tag preview`. Configure npm trusted publishing for `publish-npm.yml` after the first publication.

First pub.dev publication requires human login for each new package; configure package-specific GitHub OIDC after creation. Maven Central requires verified `io.github.weapp-container`, Portal user-token credentials and a publicly discoverable PGP signing key. Put `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `WEAPP_SIGNING_KEY` and optional `WEAPP_SIGNING_PASSWORD` in the local process environment or repository secrets; never commit values. CocoaPods Trunk registration and email verification belong to the account owner.

<a id="acceptance"></a>
## Release acceptance

Verify each archive’s SHA-256/size, architecture, dynamic dependencies and licenses. Exercise interrupted downloads, hash/version mismatches and offline cache with no fallback. Run npm pack and installed exports/types checks, Flutter analyze/publish dry-run, Pod lint, SwiftPM consumption and Central validation. Real consumers must load, display, interact, exchange host messages, navigate and close with the authored test pack. CI software rendering does not establish hardware or device acceptance.
