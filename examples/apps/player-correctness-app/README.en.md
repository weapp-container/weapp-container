<a id="开发播放器正确性测试套件预览版5-源码"></a>
# Dev Player correctness fixture (preview.5 source)

[简体中文](README.md) · **English**


Start it with the ordinary immutable-generation development pipeline:

```sh
pnpm simulator:dev -- --project examples/apps/player-correctness-app --surface devices
```

Use only a reviewed matching preview.5 runtime. This fixture is test input, not
an executed platform or performance report. It adds normal/custom navigation,
tabs, scroll, state/storage and a 250 ms business timer. Opening tools and closing
or reopening the mini-program must use real Player UI, rather than a page command.

`data.first` is the immutable first lifecycle sample. `data.events` appends JSON
records with a global sequence, event name, detail and geometry index; resolve
that index in `data.geometries` to obtain the complete `wx.getWindowInfo()` and
actual capsule rectangle captured in that callback. Geometry strings preserve
all observed fields. `getApp().globalData.journal` also retains the complete ordered cross-page
history and is mirrored into the visible page's `data.journal`. Its JSON event
tuples are `[sequence, kind, instance, event, geometryIndex, detail]`; resolve
the geometry in `journal.geometries`. Hidden pages drop only this duplicate
journal mirror; their first and own lifecycle records remain. No samples are
overwritten or truncated. After a page is
unloaded, its complete final record is transferred to the next shown page's
`data.lastRetired`, making `onHide`/`onUnload` observable. Each page refuses more
than 256 records so a fresh run is required before the bounded inspector is full.
The 10-cycle harness saves each snapshot to disk; it does not reconstruct events
from screenshots or accept a network receipt as a presentation acknowledgement.

The explicit red **Trigger View Timeout** control enters `while (true)` inside the
isolated WXS realm on the next render. It does not block AppService intentionally.
After the runtime reports a sticky View fault, real taps must not change count,
while read-only inspection must still observe increasing business timer ticks.
A new accepted session is required to recover. Do not press this until the normal
rotation/navigation/storage cases are complete.

`data.runMarker` originates in `App` construction and distinguishes a fresh
AppService after close/reopen or fault recovery; it supplements the authoritative
SDK/session receipts and does not replace them.

`scripts/dev-player-p0-android.py --describe` prints the dry plan without reading
or changing a device. Execution requires an explicit emulator serial, AVD name,
already-paired device ID, local admin URL and a fresh evidence directory. It never
starts/stops an emulator or server and refuses physical devices.

```sh
python3 scripts/dev-player-p0-android.py --execute \
  --serial emulator-5558 --avd YOUR_TASK_OWNED_AVD \
  --device-id ALREADY_PAIRED_DEVICE_ID --admin http://127.0.0.1:51791 \
  --apk-sha256 REVIEWED_INSTALLED_APK_SHA256 --out /new/task/evidence/profile
```

The runner checks the installed APK bytes and actual AVD name, then requires the
SDK's current-frame `inputEnabled` presentation predicate and exact accepted
pack/session/page/owner/surface/layout identities. It independently compares
Android `wm density` and AX TextureView/capsule bounds with accepted logical
geometry before mapping real input. A retained server `presented` phase and
proportional viewport rescaling cannot satisfy these checks. It restores
rotation settings and leaves the caller's
emulator/service running. Each profile needs a separate run. A foldable may pass
`--postures` with explicitly inspected supported `cmd device_state` IDs; no phone
is relabeled as a foldable by changing only its display size. Posture overrides
created by the test are reset at exit. The caller must reserve that AVD for the
run so no unrelated posture override is overwritten.

Candidate startup rejection uses the separate input under
`scripts/fixtures/player-correctness-startup-failure`. With the same explicit
device/APK arguments, run `--stage c018-baseline` into a fresh evidence directory.
This saves `c018-baseline.json`; capturing a baseline does not pass C018. Stage
the failing input through a task-owned temporary project's existing watcher.
Then run `--stage c018-rejection --baseline <saved-c018-baseline.json>
--candidate-root <published-SHA256> --candidate-generation <published-generation>`
with another fresh `--out` directory.

The rejection stage reads the actual Player-observed native terminal receipt,
checks its distinct published candidate root/generation and original startup
exception, and verifies exact old accepted ownership plus working real input
and a continuing business timer. Missing, pending, unknown or unrelated receipts
fail. Inspector `acceptedPack` identifies which build owns guest pages even if
the request targets a newer candidate. The runner never changes project source
or accepts a supplied receipt. Its default `full` interaction stage does not
include C018; GPU resource leak freedom and performance remain separate gates.
