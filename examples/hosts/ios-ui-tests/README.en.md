<a id="ios-嵌入-ui-交互"></a>
# iOS embedding UI interaction

[简体中文](README.md) · **English**


This target exercises a real Weapp Container embedding App through Apple's
XCUITest runner. The coordinator builds the App without launching it, asks
`xcodebuild build-for-testing` to generate the UI runner and its XCTest bootstrap,
then runs one serial `test-without-building` sequence on an explicitly selected,
already booted simulator.

Simulator execution keeps the official generated `TestHostPath`, `TestBundlePath`
and dependent runner products, with `UseUITargetAppProvidedByTests = true`.
`UseDestinationArtifacts` is a device-only option and is not used. The test
controls its App through `XCUIApplication(bundleIdentifier:)`, using the unique
AUT identity passed by the coordinator. Both AUT and runner must be absent before
the coordinator installs and records them. Xcode may reinstall that same owned
runner during `test-without-building`; it cannot select an unrelated App.

```sh
scripts/ios-embedding-ui-smoke \
  --udid <already-booted-simulator-UDID> \
  --pack /absolute/path/to/ios-interaction-app/portable-pack \
  --engine quickjs
```

Use a validated portable pack built from `examples/apps/ios-interaction-app`.
The fixture's button occupies logical `(0, 0, 200, 80)`; the runner taps `(40, 40)`
relative to the App's accessible surface. The fixture increments `count`,
schedules a real JS timeout that increments `timerCount`, and queues a Promise
microtask that increments `microtaskCount`. A separate explicit `--engine v8`
invocation runs the identical sequence without engine fallback.

The source tree must be committed and clean for the existing build receipt gate.
The selected simulator is borrowed: the harness does not boot, erase, shut down,
or own it. Output defaults to a unique directory under
`artifacts/ios-embedding-ui/`; `--out-dir` must select a new directory under
`artifacts/`. `--timeout-seconds` bounds the single test (default 180, range
30–900).

The runner performs these actions in order:

1. Launch the uniquely installed App once and observe its first completed frame.
2. Tap using `XCUICoordinate.tap` and wait for the count update.
3. Wait for the real foreground JS timer and Promise microtask.
4. Press Home with `XCUIDevice.press(.home)` and observe the App's background state.
5. Resume using `XCUIApplication.activate`, preserving PID, session and page state.
6. Change `XCUIDevice.orientation` and observe the actual surface resize.
7. Restore the original orientation and logical viewport.

Orientation evidence comes from the App's public
`UIWindowScene.interfaceOrientation`, exposed read-only in the AX surface.
The initial device sensor value is recorded separately and may be `unknown`;
the harness never guesses the initial interface from screen dimensions. It maps
portrait to device portrait, interface landscape-left to device landscape-right,
and interface landscape-right to device landscape-left. Unknown or unsupported
interface orientations fail explicitly. Rotation and restoration require the
observed interface value, viewport geometry and completed presentation to agree;
failure teardown attempts the same exact restoration.

The runner records XCTest's failure count during teardown. Completion is
accepted only after `xcodebuild test-without-building` exits successfully and
the persisted report passes validation; `XCTestRun.hasSucceeded` is not final
while teardown is still executing.

The single `weapp-container-surface` accessibility element exposes read-only
state. It cannot execute JavaScript, advance timers, inject events, or call the
bridge. Its observations are accepted only together with successful official
XCTest execution, OS screenshots and the App's native input/lifecycle/resize/
render trace. No private HID events or hand-built XCTest bootstrap are used.

Evidence includes:

- Original generated and configured `.xctestrun`, unmodified `.xcresult`, and
  per-command logs with exit status, signal and SHA-256.
- Signed App executable/build receipt, runner executable, test bundle and complete
  App/runner resource fingerprints, checked again after execution.
- The input portable pack's validated manifest root and blob identity against the
  pack actually installed in the App.
- Before/after hashes of Rust, Swift, harness and interaction fixture sources.
- Seven OS screenshots and ordered UI receipt with the same target PID/session.
- First Metal presentation evidence and native trace through the final observed
  frame, with no dropped/truncated operation records.
- Exact app/runner install acknowledgements, observed PIDs, cleanup receipts and
  release of the per-simulator UI lease.

Only acknowledged task-owned apps are eligible for cleanup. An ambiguous install
or replacement PID is preserved and reported; cleanup of the other owned app is
still attempted. The harness never steals a stale lease. SIGINT/SIGTERM cancel
only the active command's process group before collecting evidence and cleaning
the exact owned bundles. Existing output is never overwritten.

Run the platform-independent contracts without Xcode or simulator access:

```sh
node --test scripts/ios-ui-test-contracts.test.mjs
```

A passing contract test is not a successful simulator run. A successful harness
run establishes only the recorded official simulator OS interaction for that
source, engine, pack and device. It does not certify background timer scheduling,
physical-device GPU behavior, DevTools parity, all-platform conformance or
performance acceptance. Existing runtime-only trace limitations remain intact;
the separate UI report carries this interaction evidence.
