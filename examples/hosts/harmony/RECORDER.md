# HarmonyOS RecorderManager

`HarmonyRecorderApis.ets` implements the API24 `AVRecorder` path and is
reinstalled by `Index.ets` for every native owner. Registration requires the
actual `SystemCapability.Multimedia.Media.AVRecorder` system capability;
microphone authorization is requested separately. The existing module declares
the in-use `ohos.permission.MICROPHONE` permission.

Installed APIs are `wx.getRecorderManager`, `start`, `stop`, `pause`, `resume`,
and the catalog's real `onStart`, `onStop`, `onPause`, `onResume`, `onError` and
`onInterruptionBegin` methods. Listener cancellation uses the subscription
protocol; no public `off` method is invented. `AVRecorder` does not expose
encoded frame callbacks or a reliable interruption-ended signal, so
`onFrameRecorded` and `onInterruptionEnd` are not registered. The native audio
interruption error `5400107` produces `InterruptionBegin` and preserves the
original error code/message before retiring the recorder.

The adapter first presents application consent with the trusted application
and publisher identity, then requests actual OS microphone permission. The
consent is scoped to the current account/application owner and is requested
again for a new recording; no host account credentials enter the recorder or
guest JS. Pending consent, permission and native creation are all guarded by
the exact object, account owner, generation and cancellation signal.

AAC uses the native AAC encoder and **AAC ADTS** container, with an `.aac`
extension. MP3 uses the native MP3 encoder/container, with an `.mp3` extension.
The requested codec, sample rate, channel count and bitrate are checked against
`getAvailableEncoder()` before preparing the actual recording. Missing
encoders fail explicitly; there is no codec substitution or renamed container.

The [official RecorderManager.start parameter table](https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.start.html)
supplies the defaults: duration 60,000 ms, sample rate 8,000 Hz, two channels,
bitrate 48,000 bits/s, format `aac`, source `auto` and audio mode `default`.
The adapter validates all nine baseline sample rates and their published
bitrate ranges, then the device encoder's narrower constraints. Duration is
1–600,000 ms and recorded output is bounded to four MiB. Only the system-routed
`auto` microphone source and `default` audio processing mode are installed.
WAV/PCM, `frameSize`, platform-specific microphone routes and non-default
processing modes fail explicitly. The `audioMode` option entered the official
docs in baseline 3.17.3 although the pinned 5.2.3 type package omits it; this
adapter validates it without advertising unimplemented processing modes.

The Rust-managed scope supplies a host-private staging directory. Guest paths
are never joined onto a physical directory. The recorder writes to an exact,
uniquely created, non-symlink file descriptor. Stop waits for queued SDK
operations, actual native stop and release, imports the bounded bytes through
`HarmonyManagedFiles`, closes the descriptor and removes the staging file,
then enqueues one Stop event with a virtual path, byte size and active duration.
Pause time is excluded using the platform's monotonic uptime clock.

Backgrounding, revocation, object cancellation, account replacement, permission
withdrawal and queue backpressure retire the exact producer and discard its
output. They do not silently enable background recording. Native callbacks
only enqueue events through `HarmonyHostServices`; only its owning ArkTS
executor drains into N-API/QuickJS. Obsolete state and error callbacks cannot
affect a replacement recording.

Cleanup waits for actual pending SDK results and `release()` completion.
Native release errors, undrained operations and staging cleanup failures retain
the recorder/file barrier for retry. A new recording cannot bypass that barrier.
An already imported file remains confined to its old account/application's
managed namespace; revocation never publishes its path to another owner.

Run the production-owner contracts with:

```sh
node --test scripts/harmony-recorder-lifecycle.test.mjs
```

The 14 contracts cover capability registration, late permission and native
creation, exact native state events, default/encoder validation, pause duration,
managed binary import, real pending stop/pause/release barriers, interruption
errors, permission revocation, obsolete callbacks, native synchronous failures,
staging cleanup retry and event backpressure. They execute the production ArkTS
against finite SDK callbacks and do not claim actual microphone capture.

The official API24 build on 2026-11-02 produced an unsigned HAP with SHA-256
`f2f8f67fefb77337617e414f4ef3d37e2f0c938d028caf391432937989579979`.
Source hashes, build and test receipts are retained in
[`docs/host-services/evidence/2026-11-02-harmony-recorder`](../../../docs/archived-evidence.md).
Compiler warnings include throwable SDK APIs, deprecated dialog helpers and
the existing unverified N-API module; packaging succeeded without signing.

Physical microphone permission UI, audible AAC/MP3 recording and decoding,
device-specific encoder constraints, route changes, actual audio focus
interruption, OS backgrounding and hardware permission withdrawal remain
**pending device acceptance**. Official SDK compilation and lifecycle tests
are recorded separately from those hardware results.
