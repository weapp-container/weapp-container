<a id="web-音频接入与资源归属"></a>
# Web Audio Access and Resource Ownership

[简体中文](WEB-AUDIO.md) · **English**


`BrowserHostServices` uses the browser's actual `Audio` decoder to implement `wx.createInnerAudioContext`.
Each owner can have at most 8 contexts; a new decoder is created each time `src` is replaced. Events, playback algorithms, source pulling, and URLs of the old decoder still belong to the previous source incarnation and cannot be transferred to a new source or new account.

<a id="三类来源"></a>
## Three Sources of Origin

- `https://` / `http://`: Only allows origins configured by the host via `allowedOrigins`. Reads are bounded by explicitly `fetch({credentials:'omit',redirect:'error',mode:'cors'})`, up to 32 MiB, and after completion, passes the owned Blob URL to the decoder. Does not directly assign remote addresses to Audio, thus does not inherit the host site's cookies or authorization headers; CORS must still be allowed by the server.
- `wxfile://user/...`: Reads and holds the accurate URL from the private file layer of the current app, environment, and user; releases upon destruction or replacement. The file layer remains available until all decoders and subsequent file readers complete cleanup.
- Package-relative paths: Starts from the root of the mini-program package, supports `/assets/tone.wav` and `assets/tone.wav`. The runtime retrieves the original source from an accurate, uncommitted `object:InnerAudioContext.src`; the host only passes `ApiCallContext` and cannot additionally pass a path or hash to select resources. Must be an asset declared in the manifest; each read verifies the actual size and SHA-256, up to **16 MiB minus 64 KiB** (16,711,680 bytes). Does not concatenate the host website URL.

New independent capability `packagedApiResources:'1.0'` added for package internal API resources, passed via WASM's `host_api_resource(contextJson)` and Worker's `native.api-resource` byte channel.
The Worker performs validation on the ordinary owner lane, copies data, and exports ArrayBuffer via transfer list; no WASM memory is detached. Explicitly returns unsupported for old runtime or when the capability is not negotiated.
The existing C ABI structure and symbols remain unchanged.

The byte upper limit of this new protocol is 16 MiB, reserving 64 KiB for metadata. Resource reads do not execute guest JS or alter presentation; a successful `native.api-resource` response only transfers bytes without additional observations that can independently consume the message budget. Existing components, video, and general resource protocols retain their individual limits.

Source, account, session, call ID, API, deadline, and other context must exactly match the unsatisfied calls saved at runtime. Calls that have been canceled, settled, expired, or revoked by the owner cannot continue to read resources; knowledge of the asset hash does not grant read permissions. Package content integrity does not substitute for the host's installation authentication by the publisher.

<a id="播放与回收"></a>
## Playback and Recycling

`src/startTime/autoplay/loop/volume/playbackRate` submit contract caching via facade properties,
read-only values come from current real decoder. `play` and similar methods as well as `Play/Pause/Stop/Ended/Error/Canplay/
TimeUpdate/Waiting/Seeking/Seeked` events are returned to JS via owner queue.
Source read failure is reported via Error subscription of current context, retaining original public error field.
Browser auto-play policies, decoding format, output device, and user activation still affect actual playback results.

Canceling a pending `play()` removes the source and invokes `load()` to terminate the accurate native playback algorithm;source
Replacement, background, destruction, and number change likewise prevent old events. Resource release is recorded in stages: successful pause, removal of source, termination of loading, and removal of listener are not repeated; failed accurate URL/decoder is retained until explicit close retry. Late-arriving file URL must still be released, and cannot be lost simply because the earlier disposer did not see the URL.

The general queue first receives runtime-submitted cancellations, then distributes completion results; it reads cancellations again after each guest callback. New calls that have been taken are retained in the owner backlog and are not lost upon transmission failure. The handler's cancellation object is retained until the last native take, covering the window where native success occurs but the guest has not yet received the result.

<a id="验证边界"></a>
## Verification Boundary

`browser-audio-lifecycle.test.mjs` covers real loopback HTTP, source switching, late file URL, cancellation, transmission failure, precise release retry, and backpressure. `host_services_contract` validates package-level API resource permissions in real QuickJS/V8. Browser probes separately record actual Audio decoding/playback and WASM/Worker chain links. These records do not equate to physical speakers, microphones, mobile browser background policies, or seven-end device acceptance.

<a id="浏览器探针复现"></a>
## Browser Probe Reproduction

First complete the Web build with the new WASM and probe, then generate a standalone fixture for that build; the output directory must not exist:

```sh
node scripts/create-host-services-audio-fixture.mjs \
  --pack examples/hosts/android/app/src/main/assets/portable-pack \
  --out /absolute/path/to/web-build/audio-probe
```

Generator verifies the canonical root and each source blob of the original manifest, appends explicit test exports to the entry,
adds a 4-second, 22050 Hz, mono 16-bit PCM WAV, then generates a new manifest root, blob, and index.
The original package remains isolated; `fixture-report.json` records the original root, derived root, WAV, and index digests.

After loading the built page in the same background browser session managed by the root:

```js
const { runHostServicesAudioBrowserProbe } = await import('./host-services-audio-browser-probe.mjs')
const report = await runHostServicesAudioBrowserProbe({ catalog })
```

Default execution of direct QuickJS/WASM and Worker channels simultaneously. Probe uses the actual `HTMLAudioElement`, with volume set to 0; validates the true duration, playback clock, pause, guest events, and Blob source destruction within the WAV package, and rejects resource contexts without a host, old protocol, error, or already-settled. Synthetic waveform decoding results are not written to physical speakers or microphone acceptance. Workers, decoders, URLs, and unique test cookies created by the probe are cleaned up in finally.

Remote audio also verifies the actual fetch's `credentials:'omit'`, `redirect:'error'`, and `mode:'cors'`.
When verifying that online requests indeed do not carry cookies, the test server reads the `probeCookie` name from the request query,
checks only for the presence of this unique test cookie, and returns
`X-Weapp-Probe-Cookie-Present: true|false` in the response. Then pass in `requireCookieEcho:true`; the probe only accepts
`false`. For ordinary static servers that do not provide this header, retain `wireCookieVerified:false`, and cannot claim completion of network-layer cookie verification. The server should not include any other cookie content in the response or logs.
