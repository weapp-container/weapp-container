<a id="web-录音格式与资源归属"></a>
# Web recording format and resource ownership

[简体中文](WEB-RECORDER.md) · **English**


`BrowserHostServices` freezes the recording format list when configuring owner and passes
`capabilities().recordingFormats` returns the actual installed format. Default processor requires `getUserMedia`
and the current account’s private persistent file directory. Format list does not query or apply for microphone permission; user refuses authorization when calling
Return alone and cannot make an installed interface non-existent.

<a id="格式协商"></a>
## Format negotiation

`MediaRecorder.isTypeSupported` must explicitly support baseline output: MP3 corresponds to `audio/mpeg`,
AAC corresponds to `audio/aac`, WAV corresponds to `audio/wav` or `audio/x-wav`. Only supports WebM/Opus
Cannot claim to have implemented AAC or MP3. When called, the actual MIME, bitrate, track sample rate, and audio channels are again verified.

WAV can be used when the security context has real `AudioContext`, `AudioWorkletNode` and the required graph operations
Independent PCM backend. The default processor does not register the entire `RecorderManager` group when no format is available.
Custom implementations registered explicitly by the host can still retain their own contracts.

WAV PCM backend requires explicit `format:'wav'` and supports baseline sample rate list and mono and dual channels. input
Devices can use different sampling rates; native Web Audio is resampled in the output context, and the actual context
The sample rate must be equal to the requested value. Currently it is still required that the actual number of channels in the input track matches the request, and unsatisfied channels cannot be
The constraint is treated as successful.

```js
const recorder = wx.getRecorderManager()
recorder.onStop(result => {
  // tempFilePath 属于当前应用、环境和用户的私有文件空间。
  console.log(result.tempFilePath, result.duration)
})
recorder.start({ format: 'wav', sampleRate: 16000, numberOfChannels: 1 })
```

Output is RIFF WAV, interleaved signed 16-bit little-endian PCM. WAV does not accept explicit
`encodeBitRate`, because it cannot meet the compression code rate contract; return `unsupported`, the parameters will not be silenced
Ignore. The public extension of Stop gives the true `sampleRate`, `numberOfChannels`,
`pcmBitsPerSample:16` and `pcmBitRate: sampleRate * channels * 16`. The default format remains
Baseline AAC; WAV-only browsers need to explicitly select WAV.

`frameSize`, specific `audioSource` and non-default `audioMode` have not yet satisfied the corresponding contract and are explicitly rejected.
The WAV backend here does not replace physical microphone authorization, background recording, or mobile system acceptance with the success of a headless browser.

<a id="有界-pcm-与完成顺序"></a>
## Bounded PCM and completion order

Trusted static `browser-wav-recorder-worklet.mjs` reads the actual input in the native audio thread, every 2048 frames
Transmit a PCM chunk, up to 4 pending chunks. The main thread confirms the exact sequence number; the consumption pause exceeds
Terminate recording and report back pressure when four chunks are reached, and publish files with gaps without losing frames. Native platform callbacks and worklets
Messages first enter the host owner queue, and then enter guest JS from the thread to which the runtime belongs.

The upper limit of the duration is controlled by the actual PCM frame number of the native Worklet, and pauses do not accumulate samples. Full WAV Max
32 MiB, of which 44 bytes are header; PCM count checked against upper limit before writing. Overflow, processor failure, native
Context interruption and empty recording will not issue a successful Stop.

After stopping, first obtain the last piece of PCM and the accurate number of frames, and complete the native graph, port, listener and track
Release, then write the complete file to the private persistent directory, and finally issue Stop. Cancel, background, number change and owner close
will prevent old events and old files from being published. In-progress native `addModule` / `resume` and late-arriving streams
The actual final state must still be reached; native release failure retains the exact handle for explicit close retry. Cancel a native
If the call is successful and has not yet been returned to the guest, the recording will also be cancelled.

<a id="复现与验收边界"></a>
## Reproduction and Acceptance Boundaries

Limited testing using production Worklet source and portable real Node MessageChannel, graph handles, permissions and
Private files are implemented using controlled testing. They verify PCM bytes, RIFF, backpressure, actual frame caps, initialization cancellation,
Turn off retries and full hosting protocol; see [Limited Test Evidence](../archived-evidence.en.md) for results.
This record does not claim completion of real browser, physical microphone, or seven-end acceptance.

First build the current web product, and then generate an independent probe package to a directory that does not yet exist:

```sh
node scripts/create-host-services-recorder-fixture.mjs \
  --pack examples/hosts/android/app/src/main/assets/portable-pack \
  --out /absolute/path/to/web-build/recorder-probe
```

The generator first verifies the integrity of the source package, adds explicit test exports, and then recalculates the entry blob, manifest and
index. The original package is not modified; the derived root does not indicate source package publisher certification. Serving builds over same-origin HTTP(S),
To run the task in an existing browser session:

```js
const { runHostServicesRecorderBrowserProbe } =
  await import('./host-services-recorder-browser-probe.mjs')
const report = await runHostServicesRecorderBrowserProbe({ catalog })
```

The probe runs direct QuickJS/WASM and Worker full link at the same time. It only replaces the microphone input with its own
’s native 48 kHz oscillator stream, recording context, AudioWorklet, message transmission, 8 kHz
PCM, browser codecs, and OPFS all use real implementations. Check pause, full WAV, guest file read delete,
Main thread consumption pause, owner shutdown and accurate native final state. Browser autoplay policies may require user activation.

Additionally verify exact 150 ms frame rate and reduced 4096 byte PCM budget with native worklet. Report clearly marked
Full 32 MiB recording `not-run`; reduced budget cannot be considered full size acceptance. Physical microphone and audio output also
Keep `not-run`. The probe finally closes the graph, Worker, and stream it created and only deletes them.
UUID The private directory corresponding to the owner; report failure when fallback cleanup is used.

<a id="worker-二进制传输"></a>
## Worker binary transfer

The recording file enters native through the reserved `__weappBinary:{type:'ArrayBuffer',bytes:[...]}` mark
Agreement. `host-api-binary-wire.mjs` just converts these canonical byte arrays into a new, complete ArrayBuffer,
For Worker to use transfer list; after receiving, restore the JSON byte array and then hand it to WASM. Every time I pack
With independent backing, the original completion/event and original JSON string will not be modified or detached.
If the transmission fails, you can repackage it from the original result. The handle tag continues to be verified by the runtime, the handle is not resolved at the transport layer.
The entire tree is still subject to verification; unconverted objects, arrays, and handle tags retain their original references and frozen status, only
Include ancestral reconstruction of actual byte conversions to avoid breaking the proof of ownership of an existing accurate frame clone.

Up to 1 MiB for a single tag; up to 8 MiB for a wire batch binary and 256 tags to accommodate multiple
API payloads subject to runtime constraints respectively. Metadata reserves 16,384 nodes, 64 layers, and 16 MiB of
Worker budget. Ordinary large arrays cannot pretend to be binary to bypass node restrictions, holes, getters, and invalid bytes.
Numeric values, extra marker fields, and loops are rejected.

There are already ordinary ArrayBuffer, typed view and DataView. Keep the original reference, and the caller will continue to manage its own
transfer list; the transport layer is billed according to the complete backing, and no small slices are needed to cover up the large buffer. Retention mark reception
bytes must use full, undetached, non-shared backing. Actual MessagePort, failed retries and boundaries
The test is documented separately in [Binary wire evidence](../archived-evidence.en.md).
