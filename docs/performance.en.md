<a id="性能证据与门槛"></a>
# Performance Evidence and Thresholds

[简体中文](performance.md) · **English**


Performance thresholds are divided into protocol layer and host layer. `scripts/perf-baseline.mjs` runs repeatable protocol layer benchmarks on all CI runners: 1000-node reference app metadata, 10000 items of batch `setData`, batch bridge envelope, and writes the submitted SHA, engine, host, and runtime environment into the `performance-report-v1` report. `scripts/check-performance-report.mjs` enforces the following measurable thresholds:

- 10000-item `setData`: p95 ≤ 8 ms;
- bridge p99 ≤ 2 ms (Web/desktop) or ≤ 5 ms (Android/iOS/HarmonyOS).

Cold start, first frame, long list drop rate, steady-state memory, and QuickJS bundle size must be written by the host harness to the same schema's `metrics`. The current general Node benchmark marks these values as `not_measured` and reports status as `incomplete`; this will not be considered passed by either the host or the device. After the host harness completes all metrics, it uses `--require-complete` to execute the checker, and only when all metrics are `measured` and meet the thresholds will the status be accepted as `status: passed`.

Run protocol baseline and verify:

```bash
pnpm perf:baseline -- --out artifacts/performance-report.json
pnpm perf:check artifacts/performance-report.json
```

On a machine that has the native Skia bundle (or the Python/Clang/Ninja build toolchain) installed, run
host renderer probe. It will merge the Rust/Skia 1000-node submission, first frame, scroll frame budget, and process RSS into the same schema and can use full gate checks:

```bash
pnpm perf:native -- --iterations 60 --out artifacts/native-performance-report.json
pnpm perf:check artifacts/native-performance-report.json --require-complete
```

`native-performance-report.json`'s `nativeHost: passed` only indicates that the probe indeed used
`backend: "skia-gpu-*"` and met the thresholds of the current build machine. Currently, `skia-backend` only produces
`skia-raster` CPU offscreen reads back, thus it does not enter native/GPU performance evidence; the report makes no claims regarding
any mobile device or GPU driver.

Fixed release matrix includes seven hosts (Web, macOS, Windows, Linux, Android, iOS, HarmonyOS) and two
engines (QuickJS, V8). Up to 14 auditable reports and `index.json` can be generated at once:

```bash
pnpm perf:matrix -- --iterations 30 --allow-incomplete --out-dir artifacts/performance-matrix
```

Matrix commands will run protocol benchmarks for each host/engine and mark rows lacking a host lifecycle, render frame clock, memory sampler, or device/GPU harness as `availability: "unavailable"`. This step only generates evidence gaps and cannot promote a compile success, emulator connectivity, or software fallback to pass. Promoting a row to `available` requires the corresponding host harness to write complete cold/heat startup, first frame, scroll, RSS, and payload data, followed by execution of `pnpm perf:check <report> --require-complete`. The command defaults to a non-zero exit if the matrix is not fully completed; `--allow-incomplete` is used solely to preserve the current gap report.

The development machine can optionally pass in a pre-packaged reference application, enabling the matrix to run QuickJS/V8 simulator probes for each of the four surface types (Web, macOS, Windows, Linux):

```bash
pnpm perf:matrix -- \
  --pack artifacts/reference \
  --iterations 20 --allow-incomplete \
  --out-dir artifacts/performance-matrix
```

This pattern establishes isolated Cargo target directories for each of the two engines. The Web row simultaneously builds and runs `web-host-perf`, enabling the `Simulator` and `WebSurface` to measure host process cold start, runtime snapshot first frame, lifecycle state, HTTP bridge, peak RSS, and snapshot metadata within the same process; the macOS/Windows/Linux row continues to repeatedly launch `weapp-simulator run` for software process probing. All rows reuse the same 10000-item `setData` protocol benchmark. These fields are located in the optional `hostProbe` section of the report, facilitating regression identification; the availability of the Web host probe is marked as `availability: "available"`, but remains `status: "incomplete"` as it lacks browser CanvasKit, desktop window, or GPU frame sampler. The macOS/Windows/Linux process probe continues to retain `availability: "blocked"`, while the mobile row maintains `availability: "unavailable"`. Only after actual host access to lifecycle, GPU/frame clock, RSS, and full engine harness can a row be upgraded to `available` and pass `--require-complete`.

Process and snapshot values for `hostProbe.mode: "simulator-process"` are development runtime evidence. They do not establish native-window, CanvasKit, Skia GPU, emulator, or physical-device performance. The performance checker rejects `nativeSurfaceAttached` or `gpuFrameSamplerAttached` claims in this mode, preserving the evidence boundary when reports are copied.

The report schema is located at [`schemas/performance-report-v1.schema.json`](../schemas/performance-report-v1.schema.json), and the matrix index schema is located at [`schemas/performance-matrix-v1.schema.json`](../schemas/performance-matrix-v1.schema.json). Each performance regression should save a JSON artifact and retain `commit`, `host`, `engine`, and `environment` (including platform, architecture, branch, and whether the working tree is clean), to differentiate code changes, host differences, and measurement environment variations.

Run `pnpm near-parity:gates` to select a performance gate based on the current `HEAD`: prioritize indexes with exact commit matches, otherwise select the most recent record by `generatedAt` from `artifacts/performance-*` and committed `docs/performance-evidence/*/matrix/index.json`, and log candidates, selection reasons, and whether the commit matches in `performanceDiscovery`. If a committed evidence index still points to an ignored `artifacts` directory, the gate will preferentially read a tracking copy from the same `matrix/` directory to ensure reproducibility in new checkouts. The generated `<dir>/index.json` from local `perf:matrix --out-dir <dir>` will also be discovered to prevent the current matrix from being obscured by an outdated conventional `artifacts/performance-matrix-current` index. Before aggregation, all reports claiming `status: "passed"` will be revalidated against the `perf:check --require-complete` schema, metric, threshold, and native evidence checks; if no record exists for the current commit, or if the record contains only software/protocol/blocked evidence, the performance gate remains `incomplete`; these states will not be automatically upgraded. To review a specific index, explicitly pass `--performance-index <path>`, and to review a specific report file, repeatedly pass `--performance <path>`.

API inventory also has an independent canonical golden validation:

```bash
pnpm api:inventory:verify
```

This command checks seven types of hosts, two engines, coverage per API, and conformance numbers, and compares against `docs/api-inventory-v1.sha256`. The golden hash must be updated simultaneously when the inventory is modified, and CI capabilities changes must be re-reviewed.
