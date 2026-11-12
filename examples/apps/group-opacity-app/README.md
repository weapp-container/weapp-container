# Group opacity fixture

```sh
pnpm simulator:dev -- --project examples/apps/group-opacity-app --viewport 320x300
```

The group at (10, 20) has a red background and overlapping green/blue children.
Its opacity applies once to the complete painted group. A separate nested
pair of half-opacity groups at (160, 20) checks composition across layers.
There is no text, so complete expected RGBA is independent of fonts.

The invisible group at (10, 150) contains a blue child. A coordinate tap at
(30, 170) must still target that child and bubble to its invisible parent.
The real Page handler uses `setData` to restore the group to opacity 1 and
make the first group opaque. The dark control at (10, 240) hides it again.
The grey control at (100, 240) records actual selector geometry, computed
opacity, lifecycle, dataset and hits in `group-opacity:observation`.

`node scripts/group-opacity-smoke.mjs --simulator-bin <native-dual-engine-binary>
--compiler-root <verified-pinned-compiler> --compiler-dist-hashes <dist-map.json>
--out <report.json>` drives these four states in one session per engine:
initial, restored, hidden-again, restored-again. The supervisor must publish
frames automatically after real taps. The collector does not send data
patches, `render.commit`, resolved layout or injected JavaScript. It archives
and checks every RGBA channel against an independent rectangle plan with
one byte of alpha-quantization tolerance, then compares engines exactly.

`node scripts/group-opacity-browser-oracle.mjs --package <path/to/package.json>
--out <report.json>` captures a separately implemented HTML/CSS model in an
owned headless Chromium context. It records native computed CSS, real
coordinate clicks, geometry, screenshots and decoded full RGBA. This is an
auxiliary CSS oracle; it is not a WeChat baseline or strict conformance run.

Both collectors are auxiliary evidence. They do not certify official
DevTools, GPU, devices, performance or near-parity. The tourist AppID is for
local development; an official oracle run needs its own real AppID and the
fixed IDE/SDK baseline.
