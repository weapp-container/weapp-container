<a id="宿主能力协议与验收台账"></a>
# Host Capability Protocol and Acceptance Ledger

[简体中文](README.md) · **English**


Semantic baseline is fixed to WeChat Foundation Library **3.17.3**, and type input is fixed to
`miniprogram-api-typings@5.2.3`. The manifest records the SHA-256 of each input declaration and does not derive compatibility ranges from the latest online version. `scripts/generate-host-api-catalog.mjs` generates the [`host-api-catalog.json`](../../crates/container-runtime/src/host-api-catalog.json) used by runtime:
495 global `wx` methods, 756 Task/Context/object members, 6 container extensions, 8 native component or component authorization entry points, for a total of 1265 items. The global properties `cloud`, `env`, `router`, and `worklet` are listed separately under `globalProperties` and are not disguised as registrable functions. `env.USER_DATA_PATH` belongs to runtime-managed paths; the host user identity does not enter `getAccountInfoSync`.

Comprehensive seven-end inventory is available in [`api-matrix.csv`](./api-matrix.csv) and [`api-matrix.json`](./api-matrix.json), with seven platform cells for each entry. Generation command:

```sh
node scripts/generate-host-api-catalog.mjs /absolute/path/to/miniprogram-api-typings
node scripts/generate-host-services-matrix.mjs
node scripts/generate-host-services-matrix.mjs --check
```

The matrix simultaneously records the source of implementation and acceptance status. `present` indicates the existence of specific platform source code, with parameter ranges still subject to implementation and the following constraints; `delegated` indicates that the integrator’s own identity or payment service must be installed; `runtimeOwned` indicates a responsibility boundary under core protection; `absent` explicitly means that no platform implementation has been found. The latter two do not equate to completion. `pendingAcceptance` covers entries lacking implementation or lacking real-environment evidence, and cannot be interpreted as "all code is complete, only missing device." `implementedAndAccepted` must have corresponding real-environment evidence from a version; `platformNotApplicable` must have a platform restriction basis and cannot be used to conceal missing implementation. Generators will not automatically upgrade source code or test success to device acceptance; existing clear official platform-based restrictions are recorded in [platform-constraints.json](./platform-constraints.json) and are individually entered into the matrix. When certain parameters are unavailable, a standalone `parameterLimit` is retained, without deeming the entire API inapplicable.

The method for verifying source identity is described in [API Source Review](source-review.en.md). The original build logs are stored in
[Private Historical Archive](../archived-evidence.en.md), and public matrix `evidence` does not reference missing old files.
The current public acceptance ledger does not contain distributable actual acceptance reports, and all platforms lack
an `implementedAndAccepted` cell. The referenced prior execution records only describe historical events and are not acceptance credentials for the current codebase.

Matrix v2 retains the registration and security boundaries of `owner`, adds an independent `responsibility`, and counts all 1265 items by runtime, device adapter, host business service, and WeChat ecosystem service.
[`api-responsibilities.json`](./api-responsibilities.json) uses a fixed name to summarize and verify integrity, and does not alter the runtime's allowed host registration scope due to changes in work ownership.
`implementationState` independently records `missing`, `partial`, `available`, or `requiresHostService`. Core implementation, JS facade, synchronous bridge, protected boundary, and platform data sources are separately marked; for example, the public SDK for `getDeviceInfo` has projected non-empty platform and system fields provided by the host, but complete device fields remain marked as `partial`. `StrictHostProvider` receives a host snapshot and does not collect operating system data. The list also includes SDK's `NativeProvider`, core window validation, and shared projections, and cannot overlook existing core implementations simply because the platform did not redundantly register window APIs.
`owner:runtime` itself does not prove complete implementation; Canvas/Editor/Worker, and others are counted based on specific members.

`getWindowInfo` and capsule rectangle directly use the core-accepted complete display/layout observation. Render dimensions alone do not constitute physical screen, DPR, or safe area; support is explicitly unavailable prior to first observation. The system snapshot retains real OS fields, geometric fields are uniformly overridden by the current observation, and unknown brand, model, and host app version are left with default values.
The `host` value is the `{ appId }` from the trusted installation record, and the host type or account ID is not treated as the app ID.
The base interface and synchronized snapshot of registered extensions share the same owner atomic installation cache; updates, hot updates, and reinstallation do not bypass this path. The explicit asynchronous `getSystemInfo` handler adopts the current accepted geometry upon completion and cannot use the old dimensions from request initiation to override a previously occurred resize. Source code availability does not imply all SDKs have passed the observation, nor does it substitute for seven-end acceptance.

Acceptance is individually reviewed against the items declared in [`acceptance-contracts.json`](./acceptance-contracts.json), and then referenced by [`acceptance-ledger.json`](./acceptance-ledger.json) to bind source code, artifacts, logs, and cleanup records. The generator allows state upgrades only after verifying these evidences, and does not automatically import acceptance results from previous builds. Historical records previously included Web Base64 links, as well as limited parameter scopes for `wx.canIUse`, `wx.getWindowInfo`, `wx.getSystemSetting`, `wx.getAppBaseInfo`, and `wx.getDeviceInfo`; these original evidences were not distributed with the open-source code, and the historical ledger no longer retains their acceptance ratings. Actual SDK, hardware, and merchant evidence must still be provided separately. Format and validation rules are specified in [ACCEPTANCE.md](ACCEPTANCE.en.md).

Android/iOS/HUAWEI desktop logs read the `supportedApis` and registration statements from the actual adapter; desktop reads from public files/authorization implementations and actual registration statements per OS; Web reads from the specific feature branches that can be registered, while retaining environment negotiation conditions. Generators will directly fail if explicit registrations are found outside the locked list. These operations are merely source code audits and do not request device permissions, nor do they treat feature shell as hardware evidence. Success records from macro groupings or old release packages cannot override missing items in new protocols.

| Platform | Existing source code | Still needs completion or acceptance |
| --- | --- | --- |
| Android / iOS | System services, BLE/Beacon, recording, Wi-Fi public capabilities, contacts/calendar, QR code scanning, isolated file access, native camera/video frame access, host account client, and official App payment integration | Android emulator chain has actual records; physical resources and iOS signing permissions still require individual acceptance; NFC parameter ranges and missing items follow the matrix |
| HarmonyOS | API24 HTTPS/WSS, isolated sync files, system UI, location, sensors, BLE, recording, explicit NFC raw tag configuration; independent native owner, account switching, native data/phone number authorization, reference account and channel protocols | Official compilation and real local QuickJS/SQLite linkage verified; device permissions/hardware, official wallet channel, and merchant transactions still pending acceptance |
| Web | fetch、Socket、async OPFS、WGS84、sensors、explicitly authorized BLE GATT、InnerAudioContext、DOM/single-canvas media components and host identity/payment protocols | Browser/hardware/user activation limits; synchronous persistent file and current wx NFC contract not registered |
| macOS | NSURLSession HTTPS/WSS、private files、AppKit UI、CoreLocation、CoreWLAN、CoreBluetooth GATT、AVFoundation recording and AVPlayer frames、Contacts/EventKit、authentication detection、screen always-on、battery | Single canvas compositing and device-specific/permission acceptance; group separation not implemented remains absent |
| Windows | WinHTTP HTTPS/WSS, Win32 UI/Clipboard/Screen Brightness/Battery, WinRT Foreground Location, BLE GATT, Accelerometer/Gyroscope/Compass, MediaPlayer InnerAudioContext, Private Files and App Authorization | Audio support for managed files and trusted package PCM/IEEE-float WAV; Windows SDK source code compiled with managed runtime has passed, full runtime chain and device acceptance pending, other groups remain absent |
| Linux | GTK UI/Clipboard, GIO network status, private file and app authorization; libcurl HTTPS/WSS; GeoClue location with explicit desktop ID | Actual distribution, desktop portal, and hardware acceptance; grouped features still absent |

The presence of source code within a matrix does not equate to the availability of all parameters or hardware. Network registration on Linux also depends on whether `libcurl>=7.85` is found at compile time; WSS additionally requires at least 8.16, actual linkage to WebSocket symbols, and TLS protocol support. Actual API installation must be based on runtime capability negotiation.

<a id="注册与执行边界"></a>
## Registration and Execution Boundary

`registerApiHandler` accepts only entries in the manifest with `owner:host`. Navigation, page stack, layout, storage transactions, and core query objects cannot be overridden by the host; `registerHostMethod` continues as a business extension. Component entries declare only availability; native callbacks are validated through a dedicated component entry to ensure the current node is accepted.

The protocol distinguishes between synchronous snapshots, synchronous local operations, asynchronous calls, cancellable tasks, continuous subscriptions, and long-lived objects.
Synchronous snapshots enter the runtime's unified atomic installation JS private cache; ordinary synchronous local methods cannot pretend through an asynchronous handler. Object properties
have explicit read/write metadata: reads accept a snapshot; writable properties record the desired value in the guest, asynchronously submit native operations, fail back and report errors. Read-only properties are identified based on the read-only semantics in the lock declaration, and writing is not allowed merely because the TypeScript `readonly` is missing in the type declaration.

Each call carries a trusted application installation, accepted pack, user epoch, session,
call ID, deadline, and cancellation information generated by the runtime. `epoch`, sequence number, and nanosecond timestamp are transmitted as decimal strings, avoiding JavaScript number loss of `u64` precision. Device callbacks write only to a bounded queue and can only enter QuickJS when the owning runtime thread drains. The original `errCode`, `errMsg` are retained in the error public fields. Objects/subscriptions belong to the owner that created them; cancellation and account changes will revoke these resources.

Web binary storage features an owner scope, reference counting, expiration, outbound invalidation, and a total byte limit.
The current WASM bridge uses `__weappBinary` to restore data into a genuine guest ArrayBuffer, with each chunk at most
1 MiB; the Worker channel transfers byte data from the retention mark into a dedicated ArrayBuffer through explicit `binaryTransfer: "1.0"` negotiation, and the receiver restores the existing native JSON protocol. Each wire batch's binary data totals at most 8 MiB, with ordinary arrays continuing to use node budget; failed retries reuse the original native value, without reusing transferred buffers. The WASM/guest boundary still involves bounded copying and cannot currently serve as evidence of zero-copy transferable frames. Socket queue overflow triggers closure of the corresponding producer; events for latest sensor values allow merging. Clear rejection occurs when public protocol versions mismatch, without silently downgrading to an older runtime.

<a id="web-接入"></a>
## Web Access

[`BrowserHostServices`](../../examples/hosts/web-wasm/browser-host-services.mjs)
Implements browser device boundaries;
[`loadBrowserHostServices`](../../examples/hosts/web-wasm/worker-host-services.mjs)
Installs and configures before `app.init` in a Worker, and returns completion and events via the existing owner observation channel.
It leverages `WorkerWebSession`, and does not create browsers, tabs, or a second Worker itself.

```js
const native = await loadBrowserHostServices({
  session, catalog,
  trusted: { application: trustedInstallation, account: { principalId, epoch: String(epoch) } },
  loadOptions,
  identity: hostIdentityHandlers,
  payment: hostPaymentHandlers,
  allowedOrigins: ['https://api.example.com'],
  onError: showHostRecovery,
})
// 回收顺序：撤销能力/停止设备并等待 drain，然后关闭它借用的 session。
await native.close()
await session.close()
```

Web audio sources, cancellation, and in-package resource contracts see [WEB-AUDIO.md](WEB-AUDIO.en.md); Bluetooth's explicit device authorization and exclusive handoff see [WEB-BLUETOOTH.md](WEB-BLUETOOTH.en.md).

Here, `trustedInstallation` must come from the host's verified publisher's installation record, bound to the actual pack.
The content hash only verifies integrity; the guest-uploaded appId/publisherId declaration cannot substitute installation authentication.
`hostIdentityHandlers` retains credentials on the host and requests a one-time app code from a reference backend or existing backend.
Regular `wx.request` uses `credentials:omit` and allowed origin, without attaching the host's bearer.
Production `WebHost` defaults to a strict provider; login, payment, and device methods fail if not configured.
Historical development fixture can explicitly choose `developmentSandbox:true`, but it cannot be enabled simultaneously with production hostServices, and device or merchant acceptance cannot be recorded based on this.

`BrowserHostAccountManager` maintains the public controller stability, internally rebuilding the owner each time with a new identity.
First, synchronously block all sibling owner's input/callbacks, then wait for device, GPU, and file locks to drain;
then create the owner with the new identity and the host's new startup parameters, and restore input after true visual confirmation. On failure, maintain the block. The host account is retained; upon app exit, only revoke the corresponding app's grant and rebuild all its instances. Credential refresh for the same user is completed via host callbacks, typically without triggering reload. The factory's `revoke` must synchronously disable input, and `detachSurface` / `close` must wait for real resource barriers and cannot satisfy the contract with empty operations.

Web-specific limitations are part of the capability negotiation:

- Camera and video elements are automatically attached to the real WXML nodes within the accepted DOM document, with layout, cropping, transformation, layering, and input handled by the DOM context of the node. Unmounting and owner closure stop the stream and destroy the Context; delayed camera authorization also stops new returned streams. Skia path reading uses the actual `HostComponentSnapshot` accepted by the runtime, extracts RGBA via off-screen decoding elements and OffscreenCanvas, and returns the byte channels independently through `componentFrames: "1.0"` to the regular image paint slot within the same rendering tree. No DOM overlay is created; cropping, transformation, transparency, and sibling layering use the existing rendering plan. Maximum frame long side is 512, maximum per-frame size is 1 MiB, only one frame is retained per component, with a maximum queue size of 16 MiB; unmounting, hiding, backgrounding, and undo stop real media resources. Full browser/hardware acceptance is recorded separately based on corresponding evidence.

- Skia video supports Context play, pause, seek, and speed adjustment; native browser controls and independent video fullscreen are not provided with equivalent single-canvas UI, and the latter is explicitly denied. DOM paths use real native controls. Video within a package is read by the runtime based on the accepted component, document ownership, and manifest hash; pending geometry will be retried, without falling back to the host page's relative URL. Network media is explicitly read without credentials, redirects are forbidden, and decoding resources are limited to 16 MiB; exceeding limits results in explicit failure, and streaming protocols do not claim acceptance based on this.

- Phone number acquisition follows a real `button open-type="getPhoneNumber"` click → runtime node validation → host authorization → `bindgetphonenumber` flow. There is no fictitious `wx.getPhoneNumber`.

- Browser persistent file operations use OPFS for asynchronous writes, and confirmation occurs only after close/flush; no synchronous persistent file methods are registered. When OPFS is unavailable, only temporary in-memory files for the current owner are provided, with no claim of successful persistence.

- Geographic coordinates are only native WGS84; GCJ02 requires separate, compliant conversion configuration. BLE connects only to device IDs granted by the host; no unbounded scanning is faked. Web NFC NDEF messages differ from the original records and tag connection contracts of currently frozen wx NFC, so wx NFC is by default not registered; specific restrictions and future feasibility are detailed in [Web NFC Contract Specification](WEB-NFC.en.md).

- Audio recording strictly validates requested mp3/aac/wav encoding; if the browser does not support such encoding, it explicitly rejects the request, and WebM data cannot be renamed with different extensions. Browser-unsupported features such as audio mute toggle are not registered.

- Permission results are independent of interface existence; additional restrictions may apply from secure context, user activation, operating system authorization, device, and browser. Background resource closure and background location capability are not registered.

<a id="原生接入与构建边界"></a>
## Native Integration and Build Boundary

Harmony `HarmonyHostServices` drains NAPI completion, events, and cancellation uniformly in the ArkTS owner thread; system callbacks are only enqueued. `HarmonyDeviceApis` explicitly installs real API24 system services, retaining original permission errors. Sensor, sensor stop, and window settings are hidden and restored to the state prior to the owner change. `getAppAuthorizeSetting` reads system PermissionStatus before app.init, preserving snapshots of undecided, rejected, and authorized states; returns locationReducedAccuracy when approximate location is obtained, and refreshes upon authorization or foreground restoration. Biometric capabilities and enrollment status come from UserIAM; handle unenrolled and hardware unsupported cases separately; query does not generate SOTER signature, `startSoterAuthentication` remains unregistered. Sensors, scanning, and GATT notifications carry distribution conditions of the current native resource upon enqueuing, and are rechecked before owner drain; queued data is no longer passed to JS after stop, background, notification cancellation, or old instance destruction. Window brightness, always-on, and Toast operations are executed serially by resource; delayed creation releases resources first, and retains the same handle for `retryResourceCleanup()` retry upon failure to restore or close; successfully released resources are not closed repeatedly. Account switching first calls `revokeIdentity()` to block input, then waits for `waitForHostServicesDrain()` before destroying and rebuilding internal sessions. Normal close still executes guest lifecycle; close after identity revocation skips old guest hooks. `closeAndDrain()` first blocks input and unbinds surface, then waits for actual asynchronous resource exit, finally destroys the native owner and releases file leases; on cleanup failure, the locked owner is retained and cannot carry over old resources into a new account.

Harmony [Account Manager](../../examples/hosts/harmony/ACCOUNTS.en.md) has been practically instantiated in the example factory
New `createWeappContainer()`, replaying all adapters, opens input only after new frame confirmation.
The owner in the same process independently owns EGL context/surface, but the default display belongs to the host's shared resources,
exit does not invoke `eglTerminate`. Failures in device release, surface unbinding, and native destruction are retained
with accurate objects for retry; "already requested closure" cannot be equated to successful release.

[Reference Account Assembly](../../examples/hosts/harmony/REFERENCE_HOST.en.md) is disabled by default; the host explicitly configures a fixed HTTPS backend and native token provider, then logs in with the existing host account, and retrieves the service-side registered purposes and permission versions for the account and phone number separately, before displaying the native ArkUI authorization.
`ComponentContent` is precisely disabled, and both `onDidDisappear` and content destruction enter the number-change barrier.
A one-time code is passed to the mini-program business backend for exchange, without returning the host bearer token, phone number in plaintext, or client secret.
Payments are only accepted through official channels explicitly injected by the host, with trusted `orderId`s accepted and guest signatures rejected.
Wallet callbacks cannot prove that an order has been paid; success is not returned until confirmed by the server.
Cancellation only stops the calling party's wait; the process retains the original wallet callback ownership and cannot be received by a new account for previous transaction results.

`HarmonySystemApis` connects to the system contact selector, contact editor, and calendar editor via `chooseContact`, `addPhoneContact`, `addPhoneCalendar`, `addPhoneRepeatCalendar`.
No full contact or calendar database permissions are requested; data is saved only after user confirmation in the system UI. The system editor may temporarily obscure the UIAbility; existing interactions remain pending, and new calls require foreground execution. When the official UI has no available cancel handler, a number change barrier waits for the editor to fully return and discards the old result, not interpreting call cancellation as revocation of user-saved contacts or events. Avatars are read only from the current managed file scope, with encoding and decoding size restrictions; actual image release failure prevents retirement completion. Calendars are converted to Unix seconds, with explicit mapping for recurrence cycles and reminders; the system only supports minute-level reminders and rejects lossy conversions. We explicitly reject WeChat session_key signature redirection when a dedicated host signer is not configured. API24 compilation passes through unsigned HAPs; true device UI remains pending acceptance.

`HarmonyManagedFiles` obtains `root` / `auxiliaryRoot` from core, accepting only virtual paths of `wxfile://user/`. Asynchronous file methods reuse the same Rust managed file layer and OS operation locks as synchronous methods; success is returned only after flush/rename and parent directory synchronization completes. Saved records list only files saved via saveFile, persisting by application, user, and environment; valid package upgrades preserve scope, and old accounts are not imported. Current block read/write limits are capped at 1 MiB, with a total of 32 MiB for scope files, and bounded path, symbolic link, and operation counts.

`HarmonyNetworkApis` uses actual HTTP flow API24 to implement cancellation, response headers, chunking, and upload/download progress; reads managed files for upload and writes managed directories for download. `HarmonySocketApis` uses actual WSS, supporting Task send/close and four events. HTTPS/WSS are explicitly configured with exact origin, default empty table denial; HTTP does not follow redirects, does not reuse shared response cache, and will not install host cookies or bearer tokens. TLS verification remains enabled. Queues are counted by actual UTF-8 bytes and retain capacity for a single termination failure; backpressure stops the corresponding producer. Late connections are closed within the cleanup barrier and cannot publish an Open with old identity.

HarmonyOS has successfully completed actual OHOS Rust cross-compilation, C++ NAPI linking, and DevEco API24 ArkTS compilation along with unsigned HAP packaging; [build-evidence.json](../archived-evidence.en.md) records specific source code and product hash values. This proves the build pipeline, but does not prove installation on devices or API acceptance on devices.

Flutter three desktop plugins share a native Registry, reusing Desktop `DeviceApis` via an injectable device factory without additional runtimes. First configure a trusted identity to obtain the managed file directory granted by the core lease, then install the actual APIs and sync snapshot. After the native account handshake is completed, the new driver binds to the latest acceptance, epoch, and internal incarnation; only after the old OS resources and GPU texture are fully retired does the handover occur. When preparing the distribution package, all three platforms verify and copy the Desktop wrapper archive and public device header; macOS uses CocoaPods, Windows/Linux uses CMake to explicitly link the corresponding system dependencies.

<a id="可复现验证与真实证据"></a>
## Reproducible Verification and Tangible Evidence

```sh
node --test examples/hosts/web-wasm/browser-host-services.test.mjs \
  examples/hosts/web-wasm/browser-host-account-manager.test.mjs \
  examples/hosts/web-wasm/worker-host-services.test.mjs
node --test scripts/dom-presenter.test.mjs scripts/worker-runtime.test.mjs \
  scripts/worker-session-client.test.mjs
cargo test -p container-host-web --features quickjs-native
node --test scripts/harmony-host-services.test.mjs scripts/harmony-live-session.test.mjs \
  scripts/harmony-network-lifecycle.test.mjs
cargo test -p container-host-harmony --features quickjs-native
node sdk/flutter/native_desktop/tests/prepare_receipts.mjs
npm --prefix tools/host-services-reference test
```

HTTP testing uses a real local server to verify cancellation, completion ordering, and credential isolation; Limited injection of Workers
The host only validates protocol and lifecycle. Device, camera, payment SDK, and seven-end products must separately provide actual versions,
hardware/system, commands, authorization processes, and output evidence. Without these records, the matrix remains unaccepted.
Reference accounts, orders, and backend configuration and signing scope are detailed in
[`tools/host-services-reference/README.md`](../../tools/host-services-reference/README.en.md).
A locally reproducible successful payment does not imply a real merchant transaction; actual transactions require merchant credentials and an official platform host.

New [Web Media Evidence](../archived-evidence.en.md)
Inspecting actual pixels of video, camera input, foreground sibling, and ancestor clipping in real Headless Chrome, QuickJS/WASM, and CanvasKit; verifying background, unloading, undo resource and Worker ArrayBuffer transfers.
Camera input comes from a test-owned canvas stream, video is encoded by real MediaRecorder; this proves the media transmission and canvas compositing pipeline, physical camera remains to be accepted. The recorded `buildStatus:passed`, `ready:true` and overall `status:partial` remain unchanged, and no claim of full release passing is made based on this.

Resource retirement supplement see [Web Lifecycle Evidence](../archived-evidence.en.md):
Actual Headless Chrome + QuickJS/WASM verified callback/Promise ordering, Worker byte transmission,
and all settlements under 260 calls within a 256 pending call limit and completion result capacity bound.
Device events and call completion results are individually bounded; excess completion results are converted to explicit errors, and original terminal states are retained upon transient transmission failure for owner retry.
Session closure waits for permission acquisition, native recording termination, and precise resource release; failed release retains the handle, file space remains available to complete old recording deletion, and only then is the file owner closed.
Mini-program proactively exits returning operation ID; host queries completion status via account manager, avoiding processor waiting for its owner to close.
Physical device acceptance status is not updated by these tests.

A complete 66-item list of native NFC and iOS public framework limitations are separately recorded in the Android/iOS SDK's
`examples/host-services/NFC-CONTRACT.json`; they include locked types and official header file summaries.
HarmonyOS Wi-Fi requires explicit configuration of purpose and permission version; see [Access Instructions](../../examples/hosts/harmony/WIFI.en.md).
No registration occurs by default; connections operate only on candidate networks created by the current owner, and cancellation or handover waits for real system results and cleanup.
Web recording requires the actual encoder to support the requested format and parameters, and only after complete file writing to a private persistent directory is the Stop signal issued; see [Recording Protocol Evidence](../archived-evidence.en.md).
Subsequent WAV backend negotiation follows actual format, using bounded AudioWorklet PCM and RIFF files, with access and acceptance boundaries as defined in [Web Recorder Guidelines](WEB-RECORDER.en.md). Historical evidence continues to be tied to the original source code version.
