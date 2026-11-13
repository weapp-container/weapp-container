<a id="web-与-harmony-独立产物"></a>
# Web and Harmony Independent Products

[简体中文](platform-runtime-artifacts.md) · **English**


`scripts/platform-runtime-archives.mjs` generates Web/Harmony manifests and installation packages separate from the native SDK archive, versioning as unpublished `0.1.0-preview.6.0`. It only validates, copies, and archives existing release builds, without signing, installing to devices, or publishing release. Historical manifests and outputs are not overridden.

| Family | List | Coordinates | Entry |
| --- | --- | --- | --- |
| Web Worker | `web-runtime-artifacts.lock.json` | `web/worker/canvaskit` or `web/worker/software` | `index.html` |
| Web direct | `web-runtime-artifacts.lock.json` | `web/direct/canvaskit` or `web/direct/software` | `legacy.html` |
| Harmony | `harmony-runtime-artifacts.lock.json` | `harmony/arm64/unsigned` | `application-unsigned.hap` |

Each output a precise coordinate. Web direct corresponds to the old producer's `execution: "legacy"`, new receipt
Saves both `execution: "direct"` and `producerExecution: "legacy"`, cannot rename the Worker
build. The list format is `weapp-container-platform-artifacts/1`.

<a id="构建输入"></a>
## Build Input

Web must be a clean, stable build produced from successful release source code, with
`wasm,quickjs-native` enabled. The archiver revalidates frozen source code, fixes the Acorn parser, generates JS dependency closures, real WASM exports, renderer dependencies, portable pack, file digests, and lengths. Only browser-public resources, necessary pack/config, dependency declarations, and new distribution receipts are delivered; `source/`, `commands/`, original compiled outputs, validation tools, and private build reports are not included in the installer.

First collect complete Cargo dependency declarations with identical source code commit, target, and features:

```sh
node scripts/sdk-licenses.mjs \
  --source-root /absolute/clean-source \
  --package container-host-web \
  --target wasm32-unknown-unknown \
  --features wasm,quickjs-native \
  --out /absolute/new-web-notices
```

`--pins` is JSON independently reviewed and preserved by the caller, and cannot rely solely on the receipts from the installed package. Web
Requires `reportSha256`, `sourceCommit`, `sourceSha256`, `renderer`, `execution`, and `runtimeLicenseSha256`; the last two are respectively the SHA-256 of `worker|legacy` and the actual runtime license. When historical Web presenters did not record SDK preview versions, the distributed receipts explicitly document this limitation and do not revert the original production report.

```sh
node scripts/platform-runtime-archives.mjs \
  --family web \
  --producer /absolute/web-release-run \
  --pins /absolute/independently-reviewed-pins.json \
  --licenses /absolute/new-web-notices \
  --runtime-license /absolute/clean-source/LICENSE \
  --out /absolute/new-web-distribution
```

Apple's native static library with `restricted-showcase` uses LLVM `llvm-strip --strip-debug` to strip each archive member prior to computing production build product hashes. The tool is selected via `--llvm-strip /absolute/llvm-strip`; if omitted, it is looked up as `llvm-strip` in PATH. The builder verifies per-member that DWARF/STABS have been removed, and ensures consistency in non-debug sections, symbols, relocations, and linker metadata, then writes the pre- and post-strip hashes, tool version, and verification results into `artifactHardening`. Cargo's release strip setting does not override all precompiled dependencies and cannot replace this step. The product is not published if stripping or verification fails; the full configuration retains independent debugging and symbol policies.

Harmony's Rust and HAP must come from the same clean commit and separately record release profile.
Old debug artifacts, missing source code state, or old receipts without source or digest cannot be upgraded to release evidence:

```sh
node scripts/build-native-hosts.mjs \
  --source-root /absolute/clean-source \
  --build --platform harmony --profile release \
  --out /absolute/new-native-release-report.json

node scripts/build-harmony-hap.mjs \
  --source-root /absolute/clean-source \
  --profile release \
  --native-receipt /absolute/new-native-release-report.json \
  --rust-lib /absolute/clean-source/target/aarch64-unknown-linux-ohos/release/libcontainer_host_harmony.so \
  --out /absolute/new-harmony-hap
```

Current tools and source code can come from different working directories, with two identities and tool source code digests recorded separately. Output
should be placed outside the source code directory; compilation cache can be specified using `--target-dir` or `CARGO_TARGET_DIR`, defaulting to the `target/` directory under the source code root. When using external cache, pass the actual artifact path from the native receipt to HAP's `--rust-lib`; do not reuse the default path as in the previous example. Cache lifecycle is detailed in [Rust Build and Disk Space](rust-build-cache.en.md).
HAP re-verifies the member list, AArch64 ELF architecture, and exact bytes of the embedded Rust library, and does not accept source code, linking, or unreviewed members. Copied Hvigor configurations disable native strip, preserving the original bytes of the Rust producer; optimization remains determined by the release mode of Cargo/CMake. Officially generated `rpcid.sc` and `pkgContextInfo.json` respectively validate the capability binary format and exact field values, and reject duplicate fields in compilation inputs prior to normalization.
Harmony notices use `--package container-host-harmony`, `--target aarch64-unknown-linux-ohos`, `--features harmony,arkui,skia-gpu-gles,quickjs-native-harmony`.

HAP includes the `libc++_shared.so` that also requires the complete NOTICE from the official SDK.
The Cargo build manifest remains unchanged and is collected separately from the actual SDK used by the HAP producer:

```sh
node scripts/harmony-platform-notices.mjs \
  --producer /absolute/new-harmony-hap \
  --sdk /absolute/official-sdk/openharmony \
  --out /absolute/new-harmony-platform-notices
```

Collector rechecks HAP, requiring the SDK C++ library to be byte-for-byte identical to the library within the package, and binding SDK metadata,
complete `native/NOTICE.txt`, source code commits, and the HAP production report digest. The archive only adds fixed
files under `platform-notices/`: `identity.json`, `OHOS-NATIVE-NOTICE.txt`, and
`OHOS-NATIVE-SDK.json`; any unknown files, incorrect SDK, modified NOTICE, or library digest is rejected.

Then run the same archive command, changing it to `--family harmony`, and appending
`--platform-notices /absolute/new-harmony-platform-notices`. The parameter is required when the actual HAP includes a C++ runtime; Cargo notices cannot be used instead. Harmony pins include `reportSha256`, `sourceCommit`, `runtimeLicenseSha256`; additionally, when a C++ runtime is included, the `platformNoticesSha256` in the independent `identity.json` must be reviewed separately. Rewriting NOTICEs or the digests in the local identity cannot circumvent this pin.

<a id="从归档全新安装"></a>
## Fresh Install from Archive

Output contains `.tar.gz`, `SHA256SUMS`, and platform lock. First compute the SHA-256 of the entire lock independently in a trusted channel, then install into a new directory:

```sh
node scripts/platform-runtime-archives.mjs \
  --manifest /absolute/distribution/web-runtime-artifacts.lock.json \
  --manifest-sha256 INDEPENDENT_LOCK_SHA256 \
  --artifact-dir /absolute/distribution \
  --coordinate web/worker/canvaskit \
  --install /absolute/new-installed-runtime
```

Installer verifies pin, coordinates, archive digest and length, limited expansion, complete file list, and source/production
Receipt binding. Existing directories are not reused or overwritten. Archive production first writes to a private staging area and independently unpacks and verifies, then publishes the files exclusively; on failure, existing distribution directories are not overwritten.

Record the compile, archive, runtime, and hardware details separately for `release-receipt.json`. Public
Protocol fields indicate build declarations and export boundaries; actual handshake, public SDK → transport → JS, account switching, device and merchant transactions must be accompanied by evidence of the corresponding environment and commands. Static archival installation, limited fixture testing, and Hvigor compilation cannot transform runtime/hardware state to passed.

Run `pnpm platform:artifacts:test` to verify format, byte closure, independent pins, direct/Worker mode, dirty/dev rejection, source code changes, as well as Harmony architecture, native summary, and SDK runtime library NOTICE constraints. This test entry uses limited fixtures and does not launch a browser, device, or merchant transaction.
