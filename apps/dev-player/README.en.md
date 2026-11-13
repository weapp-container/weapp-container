<a id="weapp-容器开发玩家"></a>
# Weapp Container Dev Player

[简体中文](README.md) · **English**


Private Flutter application for **local QuickJS + native Skia** execution on
Android, iOS, macOS, Windows and Linux. Flutter supplies the connection and
diagnostic UI; mini-program frames are produced by the native SDK. No remote
frame stream or GitHub credential is installed on a device. Private iOS
Simulator DEBUG packages contain Dart source and local paths; they are for
private simulator validation, not production distribution.

This source targets **`0.1.0-preview.6.0+1`**. It retains the preview.5
protocol for complete atomic host layout, measured navigation and durable
development-operation receipts, and requires the prepared-restart measurement
adapter capability. Unsupported older adapters are explicitly rejected.
Poisoned View retirement invalidates native ownership without entering guest
cleanup again. Proven older-session teardown diagnostics remain bounded history;
they cannot replace the active error or authorize input on the new session.
The matching preview.6.0 native archives, App1 build/package and device
regression remain pending. Version declarations and source/unit checks do not
establish a new binary, installability or device acceptance.

<a id="宿主服务"></a>
## Host services

The Player installs actual device adapters before guest startup using the
certificate-pinned paired publisher, verified project/pack and an anonymous
development account. It authorizes each verified update before loading it.
Pairing tokens stay in the Player and are never added to guest HTTP requests.
Login/payment require an embedding host's own `PlayerHostServices` implementation;
the default does not create a synthetic user or payment result. It explicitly
rejects old runtime artifacts lacking host services 1.0.

`PlayerModel(hostServices: ...)` is the host injection seam. Install trusted
identity/payment handlers there before the first load; authorize future pack
updates without replacing the public controller. Account changes use the SDK's
shared account manager and cleanup/presentation barriers. See
[`host-services/INTEGRATION.md`](../../docs/host-services/INTEGRATION.en.md) and the
[`host-services-app`](../../examples/apps/host-services-app/README.en.md) reference.
Allowed media/network origins are explicit and empty by default.

<a id="准备并运行"></a>
## Prepare and run

Use the fixed Flutter **3.47.7** toolchain and the repository's SDK submodule
commits. Node/Python and the GitHub read credential are needed only on the build
computer while obtaining reviewed runtime binaries. An authorized offline archive
directory is supported. The source requires **preview.6.0 / ABI 1**; the SDKs'
retained preview.5.3 default locks are historical and cannot satisfy it. Until
matching archives and a reviewed preview.6.0 manifest actually exist, preparation
must fail rather than reuse old libraries. Do not edit old locks or producer
receipts to make their versions appear current.

```sh
cd apps/dev-player
node tools/prepare.mjs --platform macos \
  --manifest /absolute/reviewed-preview6.0-lock.json \
  --artifact-dir /absolute/authorized-preview6.0-archives
flutter pub get --enforce-lockfile
flutter run -d macos
```

The private archive producer supports `--platform android|ios|macos|windows|linux`.
It requires successful release runtime and SDK receipts, exact native feature
sets and one clean runtime source commit across the selected platforms. The
wrapper producer's commit and `SOURCE-INVENTORY.json` authorize the exact Swift,
Kotlin and public desktop header bytes; missing, changed or additional wrappers
are rejected. Each SDK archive retains that inventory and its digest. Windows
and Linux use `x86_64` archives; multi-architecture SDKs use `universal`.
Harmony HAP and Web WASM use separate artifact manifests.

```sh
pnpm dev-player:archives -- --runtime-root artifacts/dev-player/runtime \
  --platform macos --platform ios --platform android \
  --out artifacts/dev-player/runtime-archives-preview6.0
```

Run each SDK producer on its supported host, collect its exact native outputs
and license inventories, and select only platforms with complete inputs. This
command verifies archives with the public contract installer and prepares a new
private output directory. It does not publish a release or update consumer locks.
The finite archive tests exercise format, source closure and offline extraction;
they do not establish native transport, device, GPU or merchant acceptance.

Desktop acceptance can create its own fresh installation from the pinned archive:

```sh
node scripts/sdk-desktop-consumer.mjs \
  --manifest /absolute/reviewed-preview6.0-lock.json \
  --artifact-dir /absolute/authorized-preview6.0-archives \
  --consumer-source /absolute/exact-desktop-sdk-source --arch arm64
```

Use `--arch x64` on x64 runners or for the macOS Rosetta path. The external SDK
source repository must contain the wrapper producer's exact commit and reviewed
inventory. Only the seven explicitly reviewed consumer source files are staged;
the installed archive supplies all headers, libraries and CMake exports. Runtime
archives keep excluding examples and core sources. `--sdk <directory>` remains
available for directory relocation checks, which are recorded separately from
fresh archive installation evidence.

The following preview.5.3 / App12 results are historical and do not validate
preview.6.0 or the current Player source.

The preview.5.3 private runtime release contains ten reviewed archives, pinned by
manifest SHA-256 `ee393000b5726172755b24a31812f9b55051e710c2714edadb9b3ac287b95388`.
Independent archive review, authenticated fresh downloads, strict installations
and cache revalidations each passed for all ten coordinates. Native producers
remain `012400d43cb20b4d91a73fbbde7e1cf11bd0bb6a`; Android, iOS and desktop wrapper
producers are respectively `e4fa84e784edc1a80d972655eea347537ca40774`,
`159b7e2e66aa83e952e2af43edcd771344829379` and
`ae67dde1a104587968e2db37a9636b8776328607`. Lock-pinning commits do not replace
those producers. App12 packages were built and independently audited. Selected
SE, Pro Max and iPad Simulator tests passed fifteen stages, thirty C013 rounds
and three actual rejected-candidate/restore cycles. Android Small still has an
unresolved normal View timeout; Large retains both its stock hierarchy-collector
failure and a preview-cancellation failure in the explicitly changed no-idle
rerun. Tablet and foldable reruns remain pending. See the
[bound device summary](../../docs/archived-evidence.en.md).

The following producer identities belong to the historical preview.5.2 generation.
Its `prepare.mjs` required the reviewed `0.1.0-preview.5.2` distribution lock,
SHA-256 `10cf2f084601c9d0e2f06c54dcce4810527035beeee760f075b414651c67d829`, which pins ten exact archives.
The native Rust runtime remains **preview.5.1**, produced by
`747d0b02131d7f67b3adbdd7127abcd5e21ffdbe`. Android/iOS wrapper SDKs are
preview.5.2, produced respectively by `c8241b83017d7f5f7fd614dc34bd9fbf00230c0f`
and `f8af959868b009b6b627c370c28983c410be7e9e`; the desktop SDK remains
preview.5.1. Pin commits and Player builds do not replace those producers.
Archive validation, private publication, Player installation and actual GPU/device
acceptance are separate gates. Unsupported targets fail without older fallback.
That historical archive qualification did not establish App12 device acceptance.

The iOS wrapper's strict whole-XCFramework byte comparison failed because the
`Info.plist` library array order changed. A separate qualification verified all
six native library/header/modulemap members byte-for-byte and the plist content
semantically. The strict failure remains recorded; it is not a device pass.
Historical preview.5/5.1 runtime and Player receipts keep their original source
commits and hashes. See the [P0 correctness milestone](../../docs/dev-player/p0-preview5.en.md)
for scope and separately bound results, including the original App10 failures.
The [preview.4 report](../../docs/archived-evidence.en.md)
remains historical. Build success does not complete the five-platform release.

Supported deployment baselines are Android **8.0 / API 26+**, iOS 16, macOS 12, Windows
10 x64 and Ubuntu 22.04 x64. iOS real-device development signing requires the
selected Apple Team and device provisioning. Android release scaffolding uses
a development key and is not a production signing identity. macOS notarization,
Windows signing and AppImage assembly require their own distribution steps.

Android also requires a **64-bit system ABI**, `arm64-v8a` or `x86_64`.
Android 7.x and the 32-bit `armeabi-v7a`/`armeabi` ABIs are unsupported. A
64-bit-capable CPU running a 32-bit Android system does not satisfy this
requirement. Check the selected USB device, replacing `DEVICE_SERIAL` with its
serial and retaining `-s` on every command:

```sh
adb -s DEVICE_SERIAL shell getprop ro.build.version.release
adb -s DEVICE_SERIAL shell getprop ro.build.version.sdk
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abi
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist64
adb -s DEVICE_SERIAL shell getprop ro.product.cpu.abilist32
```

The SDK level must be at least `26`, and the system ABI list must include
`arm64-v8a` or `x86_64`. An L2 device reporting API 25 and only 32-bit system
ABIs actually rejected installation with `INSTALL_FAILED_NO_MATCHING_ABIS`;
lowering `minSdk` alone cannot supply the missing native ABI. The native SDK
must also create and present a GLES GPU surface. Missing drivers, contexts or
surfaces fail explicitly without software fallback. These prerequisites do
not establish installation, interaction or performance acceptance. See
[Android requirements](../../docs/dev-player.en.md#android-安装要求) for details.

The [Xiaomi physical-device run](../../docs/archived-evidence.en.md)
records actual USB installation, interaction and reload observations for the
preview.3 APK, along with blocked cases and a high whole-process memory sample.
It does not pass the complete physical-device or performance release matrix.

From the repository root, `pnpm dev-player:build -- --platform android` builds
the release APK and `pnpm dev-player:build -- --platform ios --simulator` builds
the debug Simulator application. `pnpm dev-player:package -- --help` describes
source-bound APK, Simulator ZIP and desktop packaging. An iOS Simulator ZIP
cannot be installed on a physical iPhone. Packaging keeps existing signing
state and records checks separately from device/GPU acceptance.

The [source-bound package report](../../docs/archived-evidence.en.md)
records the final Android APK and Simulator ZIP, exact hashes, dependency pins,
and actual installation/interaction observations. The final ZIP was extracted
and its relocated App installed on the owned official iOS Simulator. Android
execution was on an arm64 Emulator; x86_64 is packaged but not executed.
Physical devices, LAN/VPN, hardware GPU/performance and Windows/Linux windows
remain unverified. macOS Player currently requires an unavailable development
signing identity. See the [platform status](../../docs/dev-player.en.md) before
treating a source adapter or an archive as a usable platform release.

Windows/Linux require the new native GPU preview bridge. Their previous
pixel-buffer preview is not silently used by `gpuRequired:true`. A native
desktop GPU presenter alone does not establish hardware GPU execution; these
platforms remain unverified until the actual window and driver are exercised.

<a id="连接项目"></a>
## Connect a project

On the development computer:

```sh
pnpm simulator:dev -- --project /absolute/project --surface devices
```

Open the Player's project screen and paste the complete development
connection link. Android/iOS can scan its QR code. Camera rejection leaves
manual connection available. A shared LAN or an existing private VPN is needed;
there is no public relay.

<a id="接口语言"></a>
## Interface language

[简体中文](README.md) · **English**
Use `语言 / Language` in the project/development tools interface to switch.
The choice takes effect immediately and is saved for the next launch; the
Player does not replace it with the operating system language.

Changing the Player language keeps the running mini-program session, pairing,
page data and storage. Mini-program titles, tab labels and page content remain
owned by the project. Technical identifiers, error codes, business console
output and original diagnostics retain their source text. Operating-system
permission dialogs follow the platform's language rules.

The [language validation report](../../docs/archived-evidence.en.md)
records Xiaomi switching/restart observations and exact APK hashes separately
from other-platform execution and runtime release gates.

<a id="小程序窗口"></a>
## Mini-program window

The active mini-program fills the available screen/window. Mobile system bars
and desktop window decorations remain; the Player title, permanent tools tabs,
fixed aspect ratio and preview margins do not occupy mini-program space.
The top-right capsule opens development tools or closes the current mini-program.
Normal navigation uses resolved app/page configuration; custom navigation keeps
the capsule over the content. A configured system tabBar delegates to the runtime.

Closing the capsule releases that mini-program instance and its surface, then
returns to the project screen. It keeps the connection, verified downloads and
persistent wx storage. Updates remain available without reopening the program;
opening it again creates a fresh instance. Opening tools only covers the preview,
and does not represent an application background lifecycle transition.

See [chrome contract and validation](../../docs/dev-player/chrome.en.md) and the
[runnable fixture](../../examples/apps/player-chrome-app/README.en.md).

The connection URI carries a HTTPS origin, exact certificate SHA-256, project
identity and a short-lived pairing code. Each HTTPS/WSS socket pins that exact
certificate. Redirects and cleartext endpoints are rejected. The resulting
device credential is stored in the OS secure store; if the store is unavailable
the connection remains memory-only with a visible message. Pairing links and
device tokens are not added to connection history, logs or pack files.

Android and Apple URL schemes are configured. Windows/Linux users can paste a
connection link without any URL-scheme registration. Registering the optional
`weapp-container:` scheme in an installer is a separate packaging operation;
the native runners contain link-forwarding support for an already running app.

<a id="更新和诊断语义"></a>
## Update and diagnostics semantics

- The native device owns its AppService, View realm, page stack and permissions.
  Storage is isolated by authenticated server and project identity.
- The server publishes a run identity and exact decimal generation. A new
  server run resets generation comparison; older in-flight HTTP results are
  ignored. New source updates supersede unfinished downloads.
- Manifest original bytes, canonical integrity root, exact blob inventory,
  asset sizes and SHA-256 are checked before publication. Only complete immutable
  pack directories reach the native SDK, which verifies them again.
- The transfer limit is 10,000 blobs and 256 MiB for manifest plus blobs. A
  manifest is bounded at 8 MiB and an individual blob at 256 MiB; descriptor
  responses remain bounded at 2 MiB.
  Downloads have two workers. Retained cache storage is capped at 1 GiB; a new
  install exceeding the bound is rejected and the current app remains active.
- Safe view changes use `applyDevPack` and retain state. Script/structural
  changes restart. Download, validation and startup failures retain the accepted
  instance. A GPU error after activation is not described as an automatic
  restoration of old JS memory; **Previous pack** explicitly restarts that pack.
- `started` and `native-acknowledged` are distinct. Native ACK requires the
  matching generation/frame revision, native input authorization and
  `gpuSurface=true`. Reports carry an explicit `presentationStage` and
  `screenPresented:false`: macOS proves Flutter consumed its GPU-backed texture
  (`flutter-texture-consumed`); other current adapters expose
  `native-frame-acknowledged`. These receipts do not prove a physical screen
  presentation timestamp or measured FPS. A method result or WebSocket message
  never grants native ACK.
- A GPU failure from the active preview, including Metal and texture errors,
  hides/detaches the preview and pauses native input. **Retry preview** remounts
  that session and requires a new frame receipt; **Previous pack** restarts the
  earlier pack. Download and uncommitted candidate failures keep the accepted
  app running. Foregrounding cannot silently resume a paused GPU preview.
- Disconnecting or backgrounding does not destroy the running app. Backgrounding
  stops reconnect timers and invalidates unfinished updates; foregrounding
  reconnects and fetches the latest generation. Desktop exit awaits SDK close.
- The inspector fetches page data only on request. Process RSS is reported as
  process memory, including Flutter. FPS remains **Not measured** until actual
  native presentation telemetry is provided; it is not inferred from polling.

**Clear downloaded packs** closes the native session and removes that project's
download cache; it retains wx storage. **Clear this project's wx storage** uses
the native storage command and awaits its flush; existing page memory remains
until an explicit restart. An older runtime lacking either command fails
explicitly.

Device `localhost` means the device itself. Point development backend requests
at the computer's LAN/VPN address. The Player does not rewrite application URLs
or proxy arbitrary requests through the development server.

<a id="测试"></a>
## Tests

```sh
flutter analyze --no-pub
flutter test --no-pub
```

Tests cover malformed pairing links, version and size limits, manifest/hash/root
verification, renderer rejection, CAS reuse, canceled/corrupt updates retaining
old bytes, server-run identity, and installed-file tampering. Real ephemeral
HTTPS/WSS tests cover certificate pinning, bearer scope, redirect refusal,
revocation and response bounds. They create and remove only their own temporary
certificates/listeners. Coordinator tests combine this real transport with an
injected native boundary: method completion cannot impersonate presentation,
startup console is retained only for accepted candidates, and a failed project
switch keeps the accepted controller. Application heartbeat acknowledgments keep
idle connections alive; retained projects cannot report through or roll back
under another project's pairing. Native diagnostic collection is opt-in
for this development Player. These tests do not execute native runtimes, scanners, GPU
windows, mobile devices, keychains, signing or performance acceptance.
