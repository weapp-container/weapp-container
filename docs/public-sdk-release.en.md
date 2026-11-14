# Weapp Container 0.1.0-preview.7.1 release status

[简体中文](public-sdk-release.md) · **English**

This page records the actual registry state for the `.7.1` preview. The core runtime, iOS, Desktop, public Specs source and Flutter platform interface are published and anonymously verified. The Contract interface is unchanged, so the published npm `.7.0` package remains in use and is not republished. Android Central, CocoaPods Trunk, React Native npm and the remaining Flutter packages remain blocked by owner authentication or dependency prerequisites.

## Registry status

| Distribution | Published version | `.7.1` status and validation |
|---|---|---|
| Core runtime | `.7.1` | [GitHub Release](https://github.com/weapp-container/weapp-container/releases/tag/runtime-v0.1.0-preview.7.1) is public. All 17 assets passed anonymous download and SHA-256 checks; 14 installation archives passed offline install, cache reuse and wrong-hash rejection. |
| Contract | npm `.7.0` | The [published Contract package](https://www.npmjs.com/package/@weapp-container/sdk-contract/v/0.1.0-preview.7.0) remains the supported package. The C ABI and interface are unchanged, so `.7.1` is not republished. |
| Android | None | The Maven Central `.7.1` coordinate returns 404 anonymously. Candidate build [43473194455](https://github.com/weapp-container/sdk-android/actions/runs/43473194455) passed; the Central workflow is still on the publication branch and the repository has no Central/signing secrets. |
| iOS | GitHub `.7.1` | The [iOS GitHub Release](https://github.com/weapp-container/sdk-ios/releases/tag/v0.1.0-preview.7.1) is public; build [43473195791](https://github.com/weapp-container/sdk-ios/actions/runs/43473195791), finalize [43476990650](https://github.com/weapp-container/sdk-ios/actions/runs/43476990650) and publication [43477207833](https://github.com/weapp-container/sdk-ios/actions/runs/43477207833) passed. CocoaPods Trunk `.7.1` is not registered because `COCOAPODS_TRUNK_TOKEN` is missing. |
| Desktop | GitHub `.7.1` | The [Desktop GitHub Release](https://github.com/weapp-container/sdk-desktop/releases/tag/v0.1.0-preview.7.1) is public; the three-platform build/finalize [43473197471](https://github.com/weapp-container/sdk-desktop/actions/runs/43473197471) and publication [43475623344](https://github.com/weapp-container/sdk-desktop/actions/runs/43475623344) passed. CocoaPods Trunk `.7.1` is not registered because `COCOAPODS_TRUNK_TOKEN` is missing. |
| CocoaPods Specs | Specs `.7.1` | The [public Specs source](https://github.com/weapp-container/Specs/commit/650112e) contains the iOS/Desktop `.7.1` Podspecs; both release archives were downloaded anonymously and matched their manifest SHA-256 values. Trunk version queries return 404. |
| React Native | None | The npm `.7.1` version returns 404 anonymously. The source, Android Maven dependency and default runtime lock use `.7.1`; the bridge package waits for its native releases. |
| Flutter | interface `.7.1` | [platform interface `.7.1`](https://pub.dev/packages/weapp_container_platform_interface/versions/0.1.0-preview.7.1) is public; staging [43490236246](https://github.com/weapp-container/sdk-flutter/actions/runs/43490236246) and publication [43490337704](https://github.com/weapp-container/sdk-flutter/actions/runs/43490337704) passed, with anonymous archive SHA-256 `c3eabcc357977df5d440f12a6a22adf58a09263e95ceb589a77773550c0a0a36`. First-time Linux/Windows package uploads were rejected by pub.dev (`Only users are allowed to upload new packages`); Android/iOS/macOS plugins and the main package still wait for their native registry dependencies. |

Existing public packages can still be installed at their published versions:

```sh
npm install @weapp-container/sdk-contract@0.1.0-preview.7.0
```

The `.7.1` SDK installation examples become active after each registry entry and anonymous consumer verification pass. Source, build, simulator, registry-download and physical-device acceptance are separate evidence; one cannot stand in for another.

## Verification record

The runtime verification summary is bound to `runtime-v0.1.0-preview.7.1`, with core source commit `fbd8cfcc44011b1250c4e987b02f9217ce1a64d0`. All 17 public assets match the release manifest in size and SHA-256. The evidence is stored under `artifacts/published-runtime-verification/`.

Android, iOS, Desktop, Flutter and React Native source trees and runtime locks now select `.7.1`. iOS/Desktop GitHub releases, Specs and the Flutter platform interface were anonymously downloaded and matched to their release hashes; Android Maven, CocoaPods Trunk, React Native npm, new Flutter Linux/Windows packages and the remaining Flutter plugin/main packages are not yet publicly registered, so their consumer publication checks are not reported as passed. Contract npm `.7.0` is a previously published version whose interface is unchanged.

The repository owner can continue the workflows after GitHub Actions/OIDC is configured. The checked repositories currently expose no relevant secrets, so Central signing/upload and Trunk submission cannot complete. iOS SwiftPM/Pod lint and Desktop three-platform consumers passed; fresh public Flutter five-platform and React Native two-platform checks still wait for their registry entries. Physical-device and hardware-GPU results remain separate.

<a id="order"></a>
## Release order

1. Build Android, iOS and Desktop SDKs from the public verified runtime lock; verify source identity, archive hashes, licenses and consumer results.
2. Publish Android to Maven Central and the matching GitHub release; publish iOS and Desktop GitHub prereleases. Never overwrite a tag or archive.
3. Update the public Specs source with exact release URLs and SHA-256 values. After owner registration and email verification, submit both Pods to CocoaPods Trunk and verify them anonymously.
4. Publish the React Native npm package with exact iOS/Android release identities and OIDC provenance after its Maven and Pod dependencies are public.
5. Publish Flutter in interface, Android/iOS/macOS/Linux/Windows plugin, then main-package order. Tags are `<package>-v0.1.0-preview.7.1`; every job validates staging bytes and previously published dependencies.
6. Run fresh anonymous installs and consumer checks for every registry, then update this page and the Website snapshot. Contract remains `.7.0`.

<a id="automated-prerelease"></a>
## Publication automation

The core runtime `.7.1` release is public. Future candidates continue through `public-native.yml`, offline artifact verification and manual review; existing tags, drafts, archives and checksums are never overwritten. SDK producers bind the exact runtime lock, source inventory and successful producer run. Central, npm, pub.dev and CocoaPods jobs each verify the registry response and archive bytes; an upload alone is not consumer verification.

<a id="authentication"></a>
## Publication authentication

The Android Central workflow requires repository secrets `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `WEAPP_SIGNING_KEY`, and optional `WEAPP_SIGNING_PASSWORD`. npm and pub.dev use GitHub OIDC; package owners complete trusted-publisher binding and any one-time account verification before the first publication. The owner registers CocoaPods Trunk and verifies the email before configuring `COCOAPODS_TRUNK_TOKEN`. Credentials belong only in repository or organization secrets, never in source, logs or chat.

<a id="acceptance"></a>
## Release acceptance

For every version, confirm that the registry entry exists, anonymous downloads match the verified archive SHA-256 and a clean directory completes the relevant consumer resolution, build and run checks. Keep separate records for Android, iOS, Desktop, five Flutter platforms, two React Native platforms, SwiftPM and CocoaPods. Simulator, CI software rendering, physical-device and hardware-GPU evidence are distinct; unexecuted checks remain unverified.
