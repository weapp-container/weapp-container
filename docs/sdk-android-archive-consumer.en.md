<a id="android-sdk-归档的独立消费者"></a>
# Independent consumer of the Android SDK archive

[简体中文](sdk-android-archive-consumer.md) · **English**


`scripts/sdk-android-consumer.mjs` Freshly install Maven from the exact SDK archive and build separately
Android release app and instrumentation APK. It doesn't run SDK library, JNI, Rust
or Maven publication builds, do not read the ignored `build/` product in the SDK working directory.
The original `sdk:build:android` still belongs to the process of producing SDK/AAR and cannot replace the archiving acceptance of this entry.

```sh
pnpm sdk:consumer:android \
  --manifest /absolute/runtime-artifacts.lock.json \
  --manifest-sha256 INDEPENDENT_LOCK_SHA256 \
  --artifact-dir /absolute/archives \
  --consumer-source /absolute/sdk-android-git-repository \
  --out /absolute/never-existing-consumer-run \
  --offline
```

`--manifest`, `--out` must be provided explicitly. `--manifest-sha256` can pin the entire independently reviewed
Inventory, receipt always records a summary of the actual inventory. `--artifact-dir` Explicitly selects local archive; when not provided
Follow the version and access credential rules for public contract downloaders. `--offline` is passed to Gradle,
Controlled separately from archive source. The default consumer source code repository is `sdk/android`, which can also be specified explicitly
`--gradle` and `--android-sdk`. Gradle is fixed in 8.9, Android build-tools is fixed in 36.0.0.

The output directory must not previously exist. Public contract's downloader/unpacker verification
`android-sdk/android/universal`, version, ABI, length and summary, and must be returned
`installation.reused: false`. Installation directory, download copy, original lock, log and failure receipt
Stay under this output; retry using another new directory on failure.

`distribution.json` in the installation package is bound to SDK submission and `sourceInventorySha256`.
The tool reads `SOURCE-INVENTORY.json` from this exact commit via Git and the 8 under review
consumer files, verifying mode, length and SHA-256 one by one. Source code modifications in the actual working directory,
wrapper, CMake, Cargo, JNI and historical build directories will not be copied to the consumer project.
Additional consumer source code must first update explicit censored closures.

Independent Gradle init harness records the source code summary separately. It limits the SDK coordinates to this newly installed
Maven, record each dependency and summary of the actual `releaseRuntimeClasspath`, and retain the original
`libweapp_container_android.so` bytes. The original consumer has retained runtime and libc++,
This addition only controls the consumer wrapper; the SDK archive and its precise consumer source code remain intact.
Gradle uses `--no-daemon --no-build-cache`, and the R8 release mapping must actually be generated.

After building, check again that the entire installation directory and Maven closure have not changed, and verify:

- The original AAR is consistent with the AAR digest actually selected by Gradle.
- The six libraries of runtime, JNI wrapper, and libc++ in arm64-v8a/x86_64 are byte consistent in AAR/APK.
- ELF64 architecture, 16 KB load alignment, portable SONAME and dynamic dependencies.
- `zipalign -c -P 16 4` passes for the actual release APK.
- All declared resources of the original AAR, as well as public contract fixtures, are byte identical in the APK.
- release/test APK, R8 mapping, dependencies, consumers, build tools and commands are all logged in summary.

`validation.json` can be directly handed over to the existing device for execution:

```sh
node scripts/sdk-android-smoke.mjs \
  --serial EXPLICIT_ALREADY_RUNNING_TARGET \
  --artifacts /absolute/consumer-run \
  --out /absolute/new-device-evidence
```

The consumer builder itself does not operate the device. `deviceExecution` maintains `not-run`, device and host capabilities
and the physical hardware status remains pending acceptance. APK build, R8, limited fixture testing and full device execution respectively
Records cannot be substituted for each other.

Run `pnpm sdk:consumer:android:test` to verify the limited archive installation of the real contract, existing
Directory rejection, Maven tampering, exact committed consumer closure, native/notice byte tampering,
ELF/16 KB Constraints, dependency replacement and failure receipts. These tests do not execute Gradle, Rust, or devices.
