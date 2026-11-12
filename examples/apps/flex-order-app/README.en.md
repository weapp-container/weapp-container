<a id="flex-订单固定装置"></a>
# Flex order fixture

[简体中文](README.md) · **English**


```sh
pnpm simulator:dev -- --project examples/apps/flex-order-app --viewport 320x280
```

The dark control at (10, 220) runs the Page's `onToggle` handler, changing the
red items' `order` from 2 to -1 with `setData`. The grey control at (100, 220)
stores real selector geometry, DOM selection order, lifecycle and pointer hits
in `flex-order:observation`. Row, column and wrapped items move; the overlapping
square at (10, 150) changes its top painted item and coordinate tap target.
Selectors keep declaration order in both states.

`node scripts/flex-order-smoke.mjs --simulator-bin <native-dual-engine-binary>
--compiler-root <verified-pinned-compiler> --compiler-dist-hashes <dist-map.json>
--out <report.json>` drives the development HTTP surface without a browser.
Each engine uses one session for both phases. The supervisor must automatically
publish the frame after the actual tap; the test never sends `render.commit`,
data patches or injected JavaScript. Empty solid controls keep the complete
320 × 280 expected RGBA independent of fonts.

This is auxiliary local development/Skia CPU evidence. It does not execute the
official DevTools, a browser/GPU, devices or the strict conformance matrix.
The tourist AppID is for this local fixture; official oracle runs require a
separately configured real AppID and the fixed IDE/SDK baseline.
