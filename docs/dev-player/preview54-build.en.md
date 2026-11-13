<a id="preview54-构建与诊断"></a>
# preview.5.4 Build and Diagnostics

[简体中文](preview54-build.md) · **English**


The source code SDK/runtime version is `0.1.0-preview.5.4`, Player is `0.1.0-preview.5.4+13`, and the C ABI remains at 1.

`scripts/sdk-native-build.mjs --view-diagnostics off|cpu|atrace` is enabled by default with `off`. `cpu` explicitly enables `view-batch-diagnostics`; `atrace` is restricted to Android and simultaneously enables `android-view-atrace`. These opt-in features are forwarded through runtime, SDK, and FFI layers and do not alter the default engine or default build. Build receipts record both `viewDiagnostics` and the complete set of features passed to Cargo. The wrapper layer retains both identities, and consumers must reject receipts that do not match.

Each SDK retains the preview.5.3 bytecode and historical hashes for `runtime-artifacts.lock.json`. These cannot meet the runtime requirements of this version. After completing a real preview.5.4 binary build, review, and obtaining a new manifest, explicit use of `--manifest <preview.5.4-manifest.json>` is required when resolving dependencies. It is not permissible to simply increment the version number or reuse old libraries to pretend an upgrade. Installation will fail in the absence of a new manifest. New artifacts are stored in a separate directory and do not overwrite preview.5.3 builds.

Example: Android diagnostics build

```bash
node scripts/sdk-native-build.mjs --target aarch64-linux-android --out artifacts/sdk/preview54-atrace --view-diagnostics atrace
```

Source code and receipt testing do not constitute validation of native libraries, install packages, GPU, devices, or performance. Separate records are maintained for diagnostic builds and baseline builds without diagnostics and must not be mixed when evaluating performance results.

The Player provides the most recent 16 controlled View operation diagnostics to the paired read-only inspector, with fields being optional `playerViewDiagnostics`. The record includes operations, View lease, operation and record sequence numbers, error codes, containment reasons, and controller roles; no UI logs, native error messages, or application data are exported. Sequence numbers and discard counts are transmitted as decimal strings. Responses still adhere to the original 48 KiB limit: records older than the current state are truncated, marked with `responseTruncated`, and internal records are retained; if even the minimal encapsulation cannot fit, the field is omitted. The absence of this field does not imply no failure. Diagnostics are for attribution only and cannot be used to prove recovery or reauthorization of input.

This record belongs to the Player process history and is retained across project connections and page instance restarts. `controllerRole` indicates the role at the time of event occurrence and cannot be assigned to all historical records based solely on the accepted pack in the current snapshot. For continuous use cases, `lastSequence` must be recorded before and after the relevant range; upon Player process restart, sequence numbers are reset and cannot be used across processes for deduplication.
