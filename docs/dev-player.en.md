<a id="五端原生开发客户端"></a>
# Five-end Native Development Client

[简体中文](dev-player.md) · **English**


Weapp Container Dev Player uses Flutter to provide connection, project, log, and settings interfaces. The mini-program runs natively on the device using QuickJS plus Skia SDK. Source code is available for Android, iOS, macOS, Windows, and Linux; platform installation, hardware GPU, interaction, and performance pass/fail are determined by the [frozen acceptance checklist](dev-player/gates-v1.json) and its individual evidence items.

Current Player is `0.1.0-preview.5.7+17` (App17), native archive, Android APK, and iOS Simulator ZIP have been actually built. Six types of simulation devices—small screen, large screen, tablet, iPhone SE, Pro Max, and iPad—have completed selected P0 use cases; universal fold, Pixel Fold are still pending ten rounds of acceptance after test methods are corrected; the entire phase is not yet complete. preview.5.7 has not been released, independent private downloads are not completed, and six SDKs still default to preview.5.3. Precise sources and limitations are detailed in [2026-11-02 Stage Record](archived-evidence.en.md); this release continues implementation of [Complete Layout, Navigation, View Failure, and Development Update Correctness Milestones](dev-player/p0-preview5.en.md).

The following preview.5.3/App12 is historical and does not override this release: preview.5.3 private runtime and App12 have completed distribution and installer review; SE, Pro Max, iPad Simulator, fifteen selected stages passed, including thirty navigation rotation cycles and three failed candidates with recovery attempts. Android small-screen normal View timeout and large-screen preview cancellation remain failures; new package rollbacks for tablets and foldables have not yet been executed. [Evidence for this round](archived-evidence.en.md) retains original failure records, installation eligibility explanations, and accurate source code bindings, and cannot replace all device and performance gates. The original evidence for the [mini-program-style full-screen interface and capsule](dev-player/chrome.en.md) introduced in preview.4 is retained. Repository and deliverables remain private; CI is triggered manually only.

[preview.4 Test Records](archived-evidence.en.md) on 2026-10-29 include Xiaomi real devices and iOS official simulators, private runtime libraries release, and accurate source code binding. Full-screen, capsule, navigation, close-and-reenter, and secure hot updates have been tested; however, real failures still exist in capsule API observation during rotation and version recovery after startup failure. macOS lacks development signing, and Windows/Linux lack actual window environments, so the current version has not passed full five-end acceptance.

Prior to the preview.3 delivery and acceptance boundaries were as follows; they are not upgraded to the current interface acceptance:

| Platform | Current Result | Pending |
| --- | --- | --- |
| Android | ARM64/x86_64 APK generated; official arm64 emulator connected, clicked, hot-reloaded, and background recovery performed once | Phone in real device, x86_64 executed in real environment, LAN/VPN, hardware GPU and performance |
| iOS | ARM64/X86_64 Simulator ZIP generated; installed from final ZIP and physically connected and clicked on official Simulator, with hot update observation | Development signing for physical device installation, LAN/VPN, hardware GPU and performance |
| macOS | Source project and fixed Metal SDK have been integrated | No valid development signing identity available on host, Player build and actual window acceptance are blocked |
| Windows | child HWND/WGL preview adapter and packaging entry point source code available | preview.3 runtime, Windows build, real window/driver and installer package |
| Linux | GtkGLArea preview adapter and AppImage packaging entry point source code | preview.3 runtime, Ubuntu build, X11/Wayland window/driver and AppImage |

These are itemized assistive observations; 46 frozen access controls still consist of 40 unknown and 6 blocked; full five-end acceptance has not been achieved.

<a id="界面语言"></a>
## Interface Language

[简体中文](dev-player.md) · **English**

Switch language without restarting the running mini-program, nor changing paired, page data, or persistent storage. The mini-program's title, tab text, and page content are determined by the project. Technical identifiers, error codes, business console logs, and original diagnostics remain unchanged; system permission pop-ups follow the operating system's language rules. Local validation for language features is recorded separately and does not alter the above historical device evidence or the five-end release gate.

[Archived Evidence Record](archived-evidence.en.md) includes screenshots of switching, restarting, and upgrade recovery on Xiaomi, as well as exact APK hashes; all 113 test cases for Player have passed. Actual UI acceptance for other platforms still needs to be performed separately.

Subsequent [multi-resolution, tablet, and foldable screen acceptance](archived-evidence.en.md) will separately record real-world interactions and version bindings between Android Emulator and iOS Simulator. The host tabBar and regular navigation bar expand according to actual accessible font line heights; the content area and input origin retain the same measurement results. The 128 Flutter test cases from this historical version passed, and historical language acceptance remains bound to its original version. Window/capsule atomicity in rotation callbacks and native View timeout issues are listed as failures separately and are not upgraded due to passing UI tests.

<a id="启动构建与设备服务"></a>
## Start up build and device services

First, prepare a fixed version of `vendor/weapp-vite` and its build dependencies according to the [simulator documentation](simulator.en.md#开发态监督器). On the development machine run:

```sh
pnpm simulator:dev -- --project examples/apps/reference-app --surface devices
```

This entry reuses the release build script and the same `DevSupervisor` watcher; the modern View coordinates, immutable snapshot, and pack validation are completed before publication. It does not launch the AppService or preview window on computer startup, and each device owns its own session, page stack, data, timers, permissions, and storage.

Default device HTTPS/WSS listens on `0.0.0.0:5180`, while the management panel only listens on `127.0.0.1:5179`. Explicitly select client-reachable addresses when multiple network cards or VPNs are in use:

```sh
pnpm simulator:dev -- --project /absolute/project --surface devices \
  --device-host 0.0.0.0 --device-port 5180 \
  --device-advertise-host 192.168.1.20 --port 5179 --open
```

`--device-host` is the service-bound IP; `--device-advertise-host` is the LAN/VPN address within a pairing connection; `--port` is the local management panel port. The first non-internal IPv4 is selected if no advertise address is specified; please verify the endpoint printed on the terminal. `--wv-bin`, `--node-bin`, `--route`, and `--out-dir` can be explicitly specified. `--engine v8`, WebView/browser/software modes, and desktop-side viewport/render-scale/fps/data-json overrides are explicitly rejected and not started in device mode; devices provide actual window, density, and startup status.

First-time startup generates a one-time connection valid within two minutes. The "Generate Pairing Connection" in the management panel generates a new QR code/connection and replaces old credentials. Scanning is only supported for Android/iOS; manual paste is still possible after camera permission is denied. Paste the connection directly on desktop.

The service certificate and the token hash of paired devices are saved in the project ignored directory `.weapp-container/device-server/`. Each connection performs fixed verification of the certificate carried by the QR code, using SHA-256, without requiring changes to the system CA or disabling TLS verification. Device credentials are independent and revocable, and the management panel can revoke devices and disable their WSS. The GitHub token is used solely for downloading the runtime library on build machines; device connections, packing, logs, and package installations do not carry it.

<a id="准备和启动-player"></a>
## Prepare and Start the Player

Fix Flutter to **3.47.7**. Current source code requires **preview.5.7 / ABI 1**, along with full layout, navigation readiness, execution health, development operation receipts, and prepared-restart measurement capabilities; the Chrome protocol 1.0 alone is insufficient for the current Player. User devices do not require Rust, Node, core source code, or GitHub login; the following commands run on the build machine.

App17 and the matching preview.5.7 native archive have been built and completed local offline review, new private release and independent authorization download are not yet completed. The default locks for each SDK remain at preview.5.3 and cannot be used with current source code; local preparation requires explicit provision of the reviewed preview.5.7 manifest and corresponding archive, and only modifying the old lock version or reusing old binaries is not permitted. Old locks, original producers, and historical evidence retain their original bytes; local offline installation does not substitute for genuine authentication download.

The builder provides runtime-only private repository credentials via `WEAPP_CONTAINER_RUNTIME_TOKEN`. After acquiring the actual new lock, use the new output directory and explicitly pass it:

```sh
pnpm dev-player:build -- --platform android \
  --manifest /absolute/reviewed-preview5.7-lock.json \
  --out artifacts/dev-player/player-preview57-v1
pnpm dev-player:build -- --platform ios --simulator \
  --manifest /absolute/reviewed-preview5.7-lock.json \
  --out artifacts/dev-player/player-preview57-v1
pnpm dev-player:build -- --platform macos \
  --manifest /absolute/reviewed-preview5.7-lock.json \
  --out artifacts/dev-player/player-preview57-v1
```

The above path refers to the locally authored files on the build machine for actual review, not preview.5.7, which is now available for remote download. Offline preparation requires retransmission via `--artifact-dir /absolute/authorized-preview5.7-archives`; actual version, ABI, SHA-256, and slice validation is still performed, with explicit failure if matching artifacts are missing. iOS `--simulator` builds generate a debug Simulator App and do not produce a device IPA; device and desktop signing remain validated per platform. If an authorized preview.5.7 desktop SDK already exists locally:

```sh
node sdk/flutter/native_desktop/prepare.mjs \
  --target macos --from /absolute/preview5.7-desktop-sdk
cd apps/dev-player
flutter pub get --enforce-lockfile
flutter run -d macos
```

SDK Download and Installation Caching Isolated by Verified Version, Components, Platform, Architecture, and SHA-256. Upgrades do not reuse old platform directories or overwrite old caches; the packaging layer is atomically replaced only after a new installation succeeds. Package verification and default archive revalidation follow the same addressing rules; corrupted caches or incorrect hashes still result in explicit failures.

<a id="android-安装要求"></a>
### Android Installation Requirements

The current Player requires **Android 8.0 / API 26 or higher**, and supports **64-bit Android system ABIs** for `arm64-v8a` or `x86_64`. Android 7.x, `armeabi-v7a`, and `armeabi` are not supported. CPU nominal 64-bit support does not mean that the installed Android system can run 64-bit applications; some devices using 64-bit CPUs with 32-bit systems are still unable to install the current APK.

Check the system version and the actual ABI exposed by the system for the target USB device before installation. Replace `DEVICE_SERIAL` with the serial number of the target device, retain `-s` for each command to avoid accidentally selecting multiple devices:

```sh
adb -s DEVICE_SERIAL shell getprop ro.build.version.release
adb -s DEVICE_SERIAL shell getprop ro.build.version.sdk
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abi
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist64
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist32
```

`ro.build.version.sdk` must be at least `26`, and the system ABI list must include `arm64-v8a` or `x86_64` provided by the APK. The system is incompatible if it only exposes `armeabi-v7a`/`armeabi`; CPU model or "64-bit processor" marketing cannot substitute for ABI checks. An existing L2 real device pre-installation check has already identified API 25 and systems with only 32-bit system ABIs, which actually return `INSTALL_FAILED_NO_MATCHING_ABIS` during installation; lowering `minSdk` alone cannot compensate for missing native ABIs and will not make the device meet current support requirements.

Player also requires the native SDK to create and present a GLES GPU surface. Explicit failure occurs when GPU drivers, contexts, or surfaces are unavailable, with no automatic fallback to software rendering. Meeting version and ABI only indicates passing the pre-installation requirements; installation, first frame, interaction, and performance still require individual device validation.

Xiaomi / HyperOS's "USB installation" is a switch independent of "USB debugging". Initially, the device returned `INSTALL_FAILED_USER_RESTRICTED` and did not show an installation confirmation popup; after the user enabled USB installation on the phone, normal installation succeeded. System authorization must be completed on the device, and retrying on the computer does not lift the restriction. The APK's `targetSdk 36` is the target version, while the minimum installation requirement remains at the aforementioned `minSdk 26`.

[ Xiaomi real device report ](archived-evidence.en.md) on 2026-10-29 binds to the same preview.3 APK: 16 passed, 9 blocked, 28 unknown out of 53 use cases. Native first frame, page/component/slot touch, scroll, navigation, background resume, hot update, interaction with old page on build failure, version pairing and undo pairing have been tested. USB connection does not replace LAN/VPN, camera, or performance acceptance. Single memory sample PSS is approximately 464 MiB, RSS is approximately 599 MiB, still not meeting mobile memory thresholds; the freeze release gatekeeping remains unchanged.

Android defaults to using the fixed NDK declared by Flutter. The build machine can explicitly select an exact version that is installed and independently verified:

```sh
pnpm dev-player:build -- --platform android \
  --manifest /absolute/reviewed-preview5.7-lock.json \
  --android-ndk-version 27.1.12297006
```

This option is only valid for Android, passes through the Gradle property `weappContainerNdkVersion`, and writes to `androidNdkOverride` in `build.json`. Explicitly selects via AGP's `finalizeDsl` and applies to both the App and all Android library subprojects, including JNI plugins, to avoid each selecting a different NDK; does not modify third-party source code. The field is `null` by default if not specified, retaining Flutter's default value. The script does not automatically downgrade to available versions upon detection, and builds will still fail if the selected version is missing. Selecting a different NDK does not override the native AAR's ABI, 16 KiB alignment, or device GPU acceptance.

Player Android wrapper explicitly fixes **Gradle 9.4.1 `bin`**, replacing the original 9.3.1 `all`, and verifies the official release SHA-256. The `bin` package includes build tools, eliminating the need to download source code and documentation; this is an explicit tool upgrade and does not use unverified historical download fragments. AGP 9.1.0 requires a minimum Gradle of 9.3.1; the [Kotlin official compatibility table](https://kotlinlang.org/docs/gradle-configure-project.html) specifies that KGP 2.4.0 supports Gradle 7.6.3–9.5.0 and AGP 8.5.2–9.1.0. Locally decompressed Gradle cache is not re-verified by the wrapper for archive hashes; new downloads use `distributionSha256Sum` for verification, while compilation and device acceptance are separately recorded.

The final APK includes only `arm64-v8a` and `x86_64`. Flutter’s default fat-APK ABI list overrides ordinary DSL filtering, so Player explicitly sets the official `disable-abi-filtering` property and uses its own `defaultConfig.ndk.abiFilters`. Archive checks retain the initial ineffective-filter failure; subsequent final APK checks confirm only those two ABIs. Installation and interaction on 2026-10-28 used an arm64 Android Emulator; the 2026-10-29 report below separately records a Xiaomi arm64 physical device. Neither establishes x86_64 device interaction acceptance.

Android, iOS, Windows, Linux engineering, setup scripts, and platform limitations are described in [Player README](../apps/dev-player/README.en.md). Android requires API 26+ (Android 8.0+) and the 64-bit system ABI mentioned above; other platforms have baseline requirements of iOS 16, macOS 12, Windows 10 x64, and Linux Ubuntu 22.04 x64. Windows uses child HWND/WGL OpenGL 3.3, Linux uses GtkGLArea/OpenGL 3.3, native preview and Flutter tool panel are split into tabs; clear driver failure occurs without proper drivers. Apple uses Metal, Android uses GLES; the Player explicitly requires GPU, and software paths cannot substitute for acceptance.

iOS physical devices require Apple Team, signing, and provisioning; the current development signing for APK does not represent production signing. macOS notarization, Windows signing, and Linux AppImage assembly each require acceptance. Distribution logging is blocked without certificates, and system security settings are not altered. Build scripts only record compilation and cannot be used to report installation or first frame pass.

<a id="已生成的移动安装包"></a>
### Mobile installer already generated

The package table and release failure for preview.3 is historical. Retain the original bytes and conclusions. The package identity and restricted acceptance for current App17 are seen in [staged record](archived-evidence.en.md). The old package in the table cannot be used as a substitute.

Build, packaging, dependency, and installation evidence for commit `ad67b974` is available in the [installation package report](archived-evidence.en.md). Large binaries are stored in ignored `artifacts/dev-player/packages-final/` and are not committed to Git history. Both packages use the exact preview.3 lock from a submodule:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `android/WeappContainerDevPlayer-android.apk` | 92,423,918 | `80d3e8414af9bfda7a1cd3c2d87498493b3dafb4dad61b87e7bf12f1bc635b7d` |
| `ios/WeappContainerDevPlayer-ios-simulator.zip` | 78,199,120 | `e22833af389819c0966476efa10abc8f085468624ab93e462cf8e0e8ad7bb718` |

Independent Player private release `dev-player-v0.1.0-preview.3` not completed: [release failure receipt](archived-evidence.en.md) records Android GitHub asset size and SHA-256 verified; iOS received HTTP 408 after all bytes sent, no complete receipt confirmation. This release remains in draft status, no further assets uploaded, no full package retry initiated. The table above shows local complete installer identity, not serving as evidence of successful remote download; the released `runtime-v0.1.0-preview.3` is a separate runtime release, unaffected by this Player upload failure.

Android APK's v2 signature and 16 KiB ZIP alignment have actual verification; the signature identity is Android Debug. The bundler itself does not perform signature verification, so it retains the original `package.json`'s `not-verified`, without rewriting it as passed. The final APK matches byte-for-byte with the previously running APK at commit `721d14b9`; the old UI observation remains bound to the original source code.

iOS ZIP uses ad-hoc signing, containing Simulator debug App; it cannot be installed on a physical iPhone. After decompression, it is installed with the officially selected Simulator UDID, without operating on any other simulators:

```sh
ditto -x -k WeappContainerDevPlayer-ios-simulator.zip /absolute/player-extracted
xcrun simctl install <已启动的模拟器-UDID> /absolute/player-extracted/Runner.app
```

Android can select a target Emulator in the Device Manager of Android Studio, then drag the APK into its window; phone installation requires user device authorization. After Player startup, paste the connection printed by the build service in Tools & console, or use a camera to scan the pairing code. Installation and pairing do not grant GitHub access permissions.

<a id="下载运行和热更新"></a>
## Download, Run, and Hot Update

Connection protocol see [Device Protocol v1](dev-player/protocol-v1.en.md). The Player only downloads missing CAS blobs, verifies the original manifest hash, normalized root, exact references/sizes, and blob SHA-256, then atomically publishes the local generation. Two download workers, 256 MiB per pack / 10,000 blobs, single blob 256 MiB, with a 1 GiB cache upper limit are explicit boundaries; any overflow retains the previously running version.

`runId` distinguishes each service startup; within a run, generation monotonically increases and is resynchronized across runs. Late HTTP results, old downloads, and old presentation receipts cannot override new states. After a disconnection, the service continues processing accepted packs, and upon reconnection, it fetches the latest updates; background pause causes reconnection, invalidating pending updates, and foreground re-synchronization. After service shutdown, watchers, sidecars, and associated connections exit in sequence.

The SDK's `pack.devReload.protocolVersion="1.0"` is a required capability. A shared classifier determines safe modifications to WXML/WXSS/static resources using `inPlace`, preserving JS/session, page stack, data, storage, and timers; modifications to scripts, configurations, component/dependency graphs, or insecure WXS/component relationships use `restart`, preserving persistent storage. When an old runtime lacks this capability, it explicitly rejects the request.

Download, verify, and start before failure: retain current instance; new instance fails on GPU: pause input, show retry/previous package entry. Previous package will restart and cannot recover old JS memory. "Connected", "Downloaded", "Verified", "Started", "Presented" reported separately; HTTP/SDK method success cannot serve as actual GPU presentation credential.

"Clear download package" first closes the session, removes only the download cache of the current project, and retains wx storage; "clear project wx storage" executes the original command and waits for persistence, and changes in memory of the current page only occur after restart. Storage keys on different devices are isolated by authentication service and project identity.

<a id="日志检查和性能边界"></a>
## Logs, Checks, and Performance Boundaries

Player explicitly enables `devDiagnostics:true` to receive bounded logs from the real business console; ordinary SDK session defaults to disabling this collection. Candidate startup logs are displayed only after pack acceptance, and failed candidates do not contaminate the current project. The computer panel displays connection stages and reporting records by deviceId; local logs/errors are truncated and hide connection strings and device credentials.

Page data inspection retrieves `devState` via user actions, read-only, no remote JS execution. After selecting a device in the computer management interface, click "View Data" to read page data of accepted items through a single batch request to the device; request receipts, waiting, failure, and results are separately displayed. Inspection binds to project/run/generation; if disconnection or update occurs, old snapshots become invalid; one in-flight request per device, timeout 5 seconds, result up to 48 KiB, 32 pages, 2,048 nodes, and 12 layers. Sensitive keys and known credential text are obscured, no storage, configuration, or any runtime library state is exported, and snapshots are not logged. Rules cannot identify any business secrets within ordinary fields; do not place sensitive business data into page data.

Device service retains the original error stack and provides limited source-map localization based on accepted project/run/generation and verified CAS; supports exact module paths with identical `.map` files and modern View, explicitly retains unmapped eval/basename frames. See [Protocol Boundary](dev-player/protocol-v1.en.md#只读-source-map-定位). Acceptance of source code breakpoints and desktop localization on actual devices is still pending. Current stage metrics are download + verification, runtime library apply and downloaded bytes; process RSS includes Flutter. FPS displays "not measured" in the absence of real-time presentation telemetry and cannot be inferred from polling rate. Input to presentation, GPU, package, and performance thresholds still requires real device/window samples.

The business network originates directly from the device. The `localhost` on a phone refers to the phone itself; for PC backend development, the interface should be bound to an accessible address, and the mini-program should use the PC LAN/VPN address. The Player does not rewrite URLs, does not proxy any network, and does not provide public network relaying.

<a id="验收与交付"></a>
## Acceptance and Delivery

This round has recorded a set of [auxiliary verification evidence](archived-evidence.en.md): `78663746` App displays a reference mini-program in the official iOS Simulator; actual clicking causes changes in page and component counts; WXML generation 2 retains the count, JS generation 3 restarts and resets the count, and after rotation, the page receives `onResize`. These observations are tied to the original App/native/SDK and original screenshots, and therefore cannot be used to upgrade real device, hardware driver, screen presentation timestamps, or FPS acceptance. Long build errors in the old UI cause RenderFlex overflow, and the failed screenshots are fully preserved and do not count as a pass for "old preview remains usable".

Subsequent recovery of commit/rollback/unknown status for `eda22875` has 54 model tests, and bounded diagnostic area for `f6901699` has 57 model and widget tests; corresponding iOS build receipts are recorded separately. Release/installation of old archive checkpoints remain as-is in the original text, new results are separately recorded, and re-binding of old screenshots for submission is not allowed.

[New Dual Device Evidence](archived-evidence.en.md) includes `f6901699` iOS long build error still allows clicking the old preview, Android/iOS both receive generation 4 WXML updates and retain their individual counters, and after generation 5 JS updates, respectively restart and reset to zero. `721d14b9` Android APK is installed on arm64 API 30 Emulator, with real clicks and counter retention after one background recovery; development signature, ZIP alignment, and exact APK hash are independently recorded. Android connectivity uses the `adb reverse` from this task, while iOS uses the local Simulator; this is not LAN/VPN or physical device validation. Official complete package verification, installation, and failure/interruption history for NDK 28.2.13676358 is seen in [toolchain receipt](archived-evidence.en.md).

[Private Publication and Independent SDK Verification](archived-evidence.en.md) separately records 10 real read-only remote downloads, 10 cache revalidations, 104 SDK Node regressions, and 27 offline installations/rejections in independent clones; they are not mutually substitutable and do not indicate device execution success. [Resource Cleanup Receipt](archived-evidence.en.md) logs pairing revocation, emulator, and service shutdown, retaining the original device and `58730` service; the DeviceHub window close result remains unknown.

macOS signing, Windows/Linux genuine window and installation, LAN/VPN, physical devices, hardware GPU and performance still pending corresponding environments and evidence. 46 frozen gatekeeping checks still have incomplete reviews, and these auxiliary observations do not elevate the five-end release approval.

Freeze list divided by protocol, macOS, mobile, Windows/Linux, five-end integration in four stages; only evidence corresponding to source binding can change the status. Unit tests for Rust/Flutter/Node cannot replace real device, window, driver, installation, signing, or performance testing. The preview.2 report cannot be tied to new source code. This round does not upgrade WeChat near-parity or complete the dual-rendering status of seven hosts.

<a id="preview5-正确性里程碑"></a>
## preview.5 Correctness Milestone

The complete layout transaction, goal navigation measurement, execution health, and development update receipts are available at [P0 Implementation and Acceptance](dev-player/p0-preview5.en.md). New source code must use the matching preview.5 binary and SDK; version declarations do not indicate completion of release or device acceptance—specific statuses are subject to the page and source-bound receipts. The preview.4 original artifacts and failure evidence remain retained.
