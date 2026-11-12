# iOS P0 runner

This is a new XCTest harness for `examples/apps/player-correctness-app`.
It does not modify or reuse the old form-factor test binaries/evidence.
Preparing or describing the runner does not build, boot, install, pair, or
start a server. No device pass is claimed by these source files.

```sh
python3 scripts/dev-player-ios-p0/run.py describe
python3 scripts/dev-player-ios-p0/run.py prepare \
  --out artifacts/dev-player/p0-preview5/ios/harness
```

The resource owner then explicitly builds the test harness. This builds only
the independent UIKit test host, with no runtime linked into it:

```sh
python3 scripts/dev-player-ios-p0/run.py build \
  --project artifacts/dev-player/p0-preview5/ios/harness \
  --out artifacts/dev-player/p0-preview5/ios/harness-build
```

Copy `config.example.json` into the new evidence directory and replace every
placeholder. Pin the already paired Player device ID for each task-owned SE,
Pro Max and iPad simulator, the dashboard loopback URL, and the SHA-256 of the
new Player executable, runtime lock and source-binding manifest. The runner
checks the installed executable against that exact binding. Missing or old
artifacts stop execution. Historical preview.3/4 binaries remain historical.
Also bind the existing source-bound Player `build.json` as `playerBuildReceipt`
and this harness build's `harness-build.json` as `harnessBuildReceipt`.
The Player build verifier checks the current reviewed sources and complete
prepared `.app` inventory. The installed `.app` must match every file, including
Flutter `App.framework/App` and native libraries; a matching `Runner` alone is
insufficient. By default every member, byte hash, size, link identity and
executable flag must match. No installer-generated file is implicitly ignored.
Harness build receipts bind the copied source preparation, successful build
command, generated plist and complete actual runner/test-product hashes. A stale
test binary cannot be rebound to the current source by copying its plist.
Preparation also archives and hashes `run.py`, `installer_policy.py`, the policy
JSON, the screen-input geometry helper and its host-only Swift/Python checks.
Changes to an imported verifier or its
tests therefore require a new preparation and harness build, just as changes
to the Swift tests do. These copies are source evidence; use the canonical
repository runner to execute them. Old preparations/builds stay historical.

## Explicit simulator installer metadata policy

The independently preserved Xcode 27.1 / iOS 27.0 simulator observation has 76
prepared and installed members, no additions, no missing members and no byte
changes. Exactly these six regular files lost their executable flag:

- `Frameworks/App.framework/App`
- `Frameworks/Flutter.framework/Flutter`
- `Frameworks/flutter_secure_storage.framework/flutter_secure_storage`
- `Frameworks/objective_c.framework/objective_c`
- `Runner.debug.dylib`
- `__preview.dylib`

For this reviewed installer behavior only, opt in by adding the following
top-level field and three entries to the existing `bindings` array. Keep all
five normal app/runtime/source/build bindings. The default example deliberately
omits the opt-in and remains strict.

```json
{
  "installerMetadataPolicy": "ios27-simctl-executable-bit-removal-observed-se-v1",
  "bindings": [
    {
      "role": "installerPolicy",
      "path": "/absolute/repository/scripts/dev-player-ios-p0/installer-policy-ios27-simctl-v1.json",
      "sha256": "9d617e94451d8cff9fe70c6cc02926fdb39152133fbf9df186043707fc6c8eb9"
    },
    {
      "role": "installerObservation",
      "path": "/absolute/preserved/installed-inventory-diff.json",
      "sha256": "e3e9669f52be9c3fed551b111ac1aa48c4c1b9d16899131515b525767f1392ea"
    },
    {
      "role": "installerOriginalFailure",
      "path": "/absolute/preserved/pair-preflight-failure.json",
      "sha256": "5864b016c9251bf3b07e12a8000d8e451e630fd1bf2872c0c2f6a8195d4ac3c3"
    }
  ]
}
```

The preserved original inputs are under
`artifacts/dev-player/p0-preview5/ios/execution-source832e99d5/iphone-se/`.
Keep or transfer those exact bytes with their historical evidence. Missing,
reconstructed or changed proof is refused even if its new hash is placed in
config; the reviewed proof hashes are pinned in the canonical verifier. The
original strict failure remains a failure before pairing or product tests.
External ignored overlays cannot activate the canonical policy.

The opt-in allows only `executable: true → false` at the six listed paths, with
the same regular-file kind, bytes, size and all other metadata. The current
installed application may exhibit a subset of these changes. The main app
executable stays completely strict, as do every member and link. This policy
has no application-version exemption: each new Player must first pass the
unchanged source/producer build verifier against its own actual build receipt.
It never rebinds the original producer receipt to a new source revision.

`installed-payload.json` preserves the complete raw prepared and installed
inventories with their distinct hashes, the current producer receipt binding,
the selected policy/proof/implementation hashes and every actual transformation.
The resource-ownership receipt also binds the complete reviewed harness source
inventory and canonical runner/helper hashes. Nothing normalizes or rewrites
the app, installed files, either inventory or the producer receipt. Acceptance
here means consumer installer metadata only; it does not pass C013, lifecycle,
C012, C018 or any product/platform gate.

Pure regression tests launch no Node build, simulator, device, service or
pairing. Synthetic proof hashes are scoped to their fixtures and cannot replace
the production pins:

```sh
python3 -B scripts/dev-player-ios-p0/test_installer_policy.py -v
python3 -B scripts/dev-player-ios-p0/test_run.py -v
python3 -B scripts/dev-player-ios-p0/test_input_probe.py -v
```

The last command compiles only the Foundation/CoreGraphics geometry helper
with the host `swiftc`, then runs numerical refusal/coordinate checks. It does
not build a Player or XCTest harness, launch an app, or contact a device.

## Owned device execution

Run each profile separately, against the fresh built `.xctestrun`:

```sh
python3 scripts/dev-player-ios-p0/run.py run \
  --config artifacts/dev-player/p0-preview5/ios/config.json \
  --profile iphone-se --stage C013 \
  --xctestrun artifacts/dev-player/p0-preview5/ios/harness-build/derived/Build/Products/SDKConsumer_iphonesimulator27.1-arm64-x86_64.xctestrun \
  --out artifacts/dev-player/p0-preview5/ios/iphone-se/C013-run1
```

The selected simulator must already be booted and the new Player installed,
connected, and showing the correctness fixture's home page. The runner never
selects a device by model, list position or “only connected device”. It uses
one exclusive lease for its explicit UDID. Outputs refuse overwrite. Each
run preserves the invocation, timestamps, log hash, exact source/app/runtime
bindings, `.xcresult`, attachments and test-result summary. Exit failure
remains failure even when attachments can be exported.
The frozen profile definition and iOS 27.0 runtime are checked against the actual
UDID. A stage passes only when the exported summary records exactly one passed
test on that UDID, zero skips and zero expected or actual failures. The final
`stage-result.json` preserves refusal/failure even if `xcodebuild` itself exits 0.

| Stage | Checks |
| --- | --- |
| `C013` | Ten portrait→landscape→portrait cycles, each with all newly appended `onResize` callback geometries, normal and custom navigation, back, current layout identity, first `onLoad` geometry, real selector-based touch, and native ACK/input eligibility. Pack identity stays fixed. |
| `lifecycle` | Save persistent data, tools round trip, close/reopen, fresh session, first geometry and actual restored native frame. |
| `C012` | Red WXS fault button, sticky execution health, disabled input, continuing 250 ms AppService timer, tools recovery, retry creating a fresh accepted session. |
| `C018-baseline` | Capture immutable accepted pack identity before an externally orchestrated failed candidate. |
| `C018-rejected` | Require the pinned baseline identity, then prove retained old owner/layout, native ACK, working input and timer. |

Run C013 and lifecycle before C012. C013 keeps the complete journal for all
ten cycles; use a fresh session for another full run. Ordinary taps resolve the
fixture's `.p0-control` selector rectangles against the current native view
and logical viewport. No historical pixel offsets or remote guest mutation
commands are used. UIKit/XCTest logical screen bounds must independently match
the committed content rectangle and viewport before direct selector offsets
are used; an adaptive guest/native scale factor cannot hide a wrong size.
Each rotation and navigation requires increasing observation/layout revisions.
Before asserting each rotation, its complete before/after callback journal is
attached. Every new `onResize` argument must match its synchronous window query;
window/display/safe-area/orientation and capsule must jointly match a complete
native layout, with at least one callback matching the newly presented layout.
An intermediate tuple without its own native receipt fails conservatively and
retains all samples; a correct last frame cannot hide an earlier mixed tuple.

For C012's blocked-input probe, the harness freezes the increment selector's
screen point before triggering the fault. An attachment records the independent
AX surface/app frames, accepted content frame, logical screen point, app offset,
orientation and native pack/session/layout identity. After the expected fault,
the native view may be hidden from AX. The probe therefore uses the stable
`XCUIApplication` anchor and checks that the app frame/orientation and native
identity are unchanged; it never resolves the hidden surface again. The fault
snapshot, screenshot and AX tree are attached before the real screen tap.
Afterward, sticky View health and disabled input must remain, AppService ticks
must advance, and the count and complete `increment.*` journal must stay fixed.
This proves the visible fault state prevents business input; it does not claim
the hidden native surface itself received the gesture. Recovery/Retry begins
only after these assertions. An old element-anchored probe failure remains a
failed historical run and cannot be relabeled by preparing this new harness.

`snapshot.state` and guest traces come from the same
read-only inspection, so screenshots alone cannot pass geometry/identity.

C018 is intentionally split around host-controlled source edits. After the
baseline, the resource owner substitutes
`scripts/fixtures/player-correctness-startup-failure/app.js`, waits for the
real candidate rejection, saves the build/Player error evidence, then runs
the rejected stage with `c018ExpectedAccepted` copied from the baseline and
`c018ExpectedCandidate` copied from the actual candidate descriptor (root,
generation, runId). The harness reads the actual native receipt directly from
`inspection.snapshot.developmentAttempt`; it does not accept a manually
constructed receipt file. It requires the matching rejected owner/attempt,
candidate root/generation/run, stable `ERR_*` code and original
`P0_CANDIDATE_STARTUP_FAILURE` message, while `acceptedPack` and native state
still identify the original pack. That snapshot is exported in the XCTest
attachments. Unknown or pending observations cannot pass as rejection.

The source must be restored and the next accepted generation checked
separately. The rejected UI stage alone does **not** prove candidate failure
or classify an attempt: without the associated failure evidence, C018 remains
incomplete. Lost native replies/receipt eviction require the separate native
and Player coordination tests; this runner does not simulate them via UI.

Credentials stay only in process memory. The runner does not pair, revoke,
shutdown a simulator, stop the service, close a user app or kill other jobs.
It removes only its own lease. The original resource owner retains explicit
responsibility for app/connection/service/simulator cleanup and records that
separately. No current task resources have been created just by adding this
harness. Device execution waits for the current reviewed app, matching fresh
harness build and service.
