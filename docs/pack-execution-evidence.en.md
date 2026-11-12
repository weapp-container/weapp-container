<a id="可携式包执行证据-v1"></a>
# Portable-pack execution evidence v1

[简体中文](pack-execution-evidence.md) · **English**


The actual program execution gatekeeping requirement for the Weapp Container mandates that the same portable fixture runs separately in each host, with either QuickJS or V8.
The mobile end includes 6 combinations: Android, iOS, HarmonyOS; the full matrix also includes Web, macOS, Windows, and Linux, totaling 14 combinations. Individual engine reports, host crate unit tests, engine feature availability, and independent GPU contexts cannot compensate for the missing combinations.

Multiple independent execution reports can be directly aggregated without rewriting or merging old evidence:

```sh
node scripts/check-near-parity-gates.mjs \
  --host-execution artifacts/android-quickjs.json \
  --host-execution artifacts/android-v8.json \
  --host-execution artifacts/ios-quickjs/execution-evidence.json \
  --host-execution artifacts/ios-v8/execution-evidence.json
```

`--host-execution` is repeatable. The same absolute path is read only once; repeating the declaration of the same host/engine combination across different files will keep that combination as `incomplete`. The command will still check the existing real DevTools, build, bridge, performance, and evidence ledger gateways; combinations not provided in this case will not be marked as passed.

Report uses the following structure. `fixture.manifest` saves the complete manifest; `fixture.id` and the revalidated manifest root serve as program identity shared across hosts. Additional build instructions do not alter fixture identity.

```ts
interface PackExecutionReportV1 {
  sourceCommit: string;
  executionEvidence: {
    schemaVersion: 1;
    fixture: { id: string; manifest: ContainerManifestV1 };
    receipts: Array<{
      host: "web" | "macos" | "windows" | "linux" | "android" | "ios" | "harmony";
      engine: "quickjs" | "v8";
      status: "passed" | "failed" | "blocked" | "unknown";
      fixtureId: string;
      manifestIntegrity: string;
      sourceCommit: string | null;
      artifactSha256: string | null;
      build: {
        status: "passed" | "unknown";
        sourceCommit?: string;
        workingTreeDirty?: boolean;
        workingTreeScope?: string[];
        host?: string;
        engine?: string;
        artifactSha256?: string;
      };
      target: {
        host: string;
        id: string;
        kind: "official-simulator" | "device" | "browser" | "native-window";
      };
      sessionId: string;
      route: string;
      operations: Record<string, {
        status: number;
        requestJson?: string;
        request?: BridgeEnvelope;
        json: string;
        sessionId?: string;
      }>;
      surfaceProbe?: Record<string, unknown>;
    }>;
  };
}
```

`operations` must contain `app.init`, `app.lifecycle`, `page.push`, `render.commit`, and `render.snapshot`. The first four save the successful ABI status, original request and response batch, requestId, sessionId, protocolVersion, and operation must correspond, and errors must not be present in the batch. Either `request` or `requestJson` is required, with the latter facilitating the preservation of the original transport JSON.

The complete request manifest for `app.init` must be equal to the fixture after normalization, not just preserve the same root.
The manifest is validated against the repository JSON Schema for structure, and checks module dependencies closure, WXS and template relationships, and compilation mappings; if the schema encounters a new keyword not supported by audit, it fails, and does not silently ignore it.
The full runtime semantics, actual module/blob byte closure, AST, and executable validation are still performed by the corresponding Rust loader from the source build; audit does not replace this loader, nor does it generate execution results based on manifest metadata.
`app.init` must actually enable the specified engine, invoke App launch, load a number of modules equal to the number specified in the manifest, and return the same manifest root and host identity. The manifest itself is normalized in UTF-8 key order, recalculated with SHA-256 root, and verified against the fixed weapp-vite submodule commit in the repository.
`page.push` must point to a route in the fixture; `render.commit` must publish the WXML template for that route, returning `committed: true`, `source: "manifest"`, and the actual frameId. Hand-drawn frames cannot substitute for programmatic rendering.

`render.snapshot` saves for the same sessionId; its JSON must have frame_id equal to commit frame,
width and height are positive integers, format is `rgba8-premultiplied`. All pixels must be valid
RGBA bytes, audit recalculates SHA-256; if both sha256 is specified, it must match the computed result. It is also possible
for the host to save exact `pixelCount = width × height × 4` and full RGBA `sha256` digest after verifying all snapshot bytes. The digest represents the identity of this runtime snapshot, and it cannot claim that the screenshot matches the official display.

GPU is verified independently. The `surfaceProbe` must contain schemaVersion 1, a successful status, host, engine, sessionId, manifestIntegrity, and frameId, and must pass the same validation as above; hostSurfaceAttached, containerSurfaceAttached, and gpuSurface must all be true. snapshotSha256 must equal the snapshot digest from the above runtime; it binds the program frame identity and cannot substitute for independent GPU readback pixel comparison. The backend and evidenceBoundary must belong to a clear combination of the host, for example, Android's `skia-gpu-gles` / `runtime-skia-gles-framebuffer`, iOS's `skia-gpu-metal` / `rust-skia-metal-drawable`, Web's `skia-gpu-canvaskit` / `runtime-skia-canvaskit-surface`. Only raster snapshots, device-context-only, GPU frames from other sessions, or zero-module empty frames are not accepted.

Build and runtime sources are recorded separately. `build.artifactSha256` must equal the hash of the actual runtime artifact,
the host, engine, and verified source commit of the build must correspond; the workingTreeDirty of build input must be false, and the true compilation input can be verified via workingTreeScope. Only the HEAD of the test script is known, and thus the source commit for precompiled APK, App, or HAP cannot be filled in based on this. Missing sources remain as `unknown` / `incomplete`, even if the runtime view or GPU submission succeeded.

Android collector supports `--engine quickjs|v8`, selecting the engine via startup parameters and using a unique session nonce for each run. It first deletes the old `files/portable-pack-execution.json` file from the current app, then reads the complete receipt atomically saved by the GPU callback upon startup. Logcat is only for auxiliary purposes and avoids misinterpreting truncated long lines as complete executions. Failures to read, nonce mismatch, uncompiled specified engine, or unknown build source will not result in a successful publication.

Old reports continue to show in `legacyPlatforms` and `legacySurface`. They do not automatically generate missing
V8, fixture, binary source, or GPU frame proofs. `mobileModuleExecution`,
`hostModuleExecution` checks for execution; `mobile` / `mobilePackGpu` and `hostPackGpu` check
for associated GPU submissions. All results are limited to the listed fixture and do not represent the complete API, real account service, performance, true device coverage, or near-parity completed.
