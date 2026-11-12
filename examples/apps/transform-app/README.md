# Transform interaction mini-program

This native mini-program drives typed 2D transforms through real Page handlers,
`setData`, WXSS, selector queries, coordinate input, and sandbox storage. It uses
the pinned `vendor/weapp-vite` builder and has no bundled runtime dependency.

```sh
pnpm --dir vendor/weapp-vite exec wv build \
  "$PWD/examples/apps/transform-app" -p weapp --outDir dist
pnpm container:pack -- examples/apps/transform-app/dist \
  --out artifacts/transform-app/pack \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
cargo run -p container-simulator -- \
  dev --project examples/apps/transform-app --surface web
```

The stage starts at page coordinate `(0, 0)` and is `320 × 280` CSS pixels.
Use a viewport at least 320 pixels wide. Coordinates are page/client logical
pixels, not physical device pixels. Navigation chrome is outside this contract.

| Phase | Action | `#box` bounding rectangle `(left, top, width, height)` | Interior sample |
| --- | --- | --- | --- |
| small | Initial | `(134, 104, 52, 32)` | `(150, 112)` blue |
| large | Tap `(150, 112)` on `#box`, or `#toggle-size` | `(114, 94, 92, 52)` | `(150, 112)` green |
| small again | Tap `(150, 112)` | `(134, 104, 52, 32)` | `(150, 112)` blue |
| rotated small | Tap `#cycle-transform` once | `(134, 136, 32, 52)` | `(150, 160)` blue |
| no transform | Tap `#cycle-transform` again | `(160, 120, 52, 32)` | `(176, 136)` blue |
| reset | Tap `#reset` | `(134, 104, 52, 32)` | `(150, 112)` blue |

The content size is `40 × 20` or `80 × 40`; padding and border add 12 pixels to
each dimension. The `-50%` translation uses that final border box. Initial red
border sample: `(134, 116)`. Initial yellow corner: `(138, 108)`. White outside
sample: `(132, 112)`. Control centers are `(52, 22)`, `(148, 22)`, `(244, 22)`.
The static order probes have rectangles `(60, 220, 40, 10)` in red and
`(210, 220, 40, 10)` in blue, distinguishing translate/scale function order.

`data.taps` counts only size changes; `data.lastTarget` records the actual event
target, and tapping the yellow corner targets `corner` before bubbling to the
box handler. Each accepted size/mode/reset change writes `transform-app-state`
with `{large,width,height,mode,transform,taps,lastTarget}`. `onInspect` queries
the accepted `#box` geometry and copies the saved value into `data.persisted`.
It can be called explicitly after the host publishes a new frame; a selector
query inside the `setData` callback can still observe the previously published
frame until that host boundary completes. `data.lifecycle` records App/Page
hooks and is independent of the visual transform state.

The fixed official target is DevTools `2.02.2608080` / library `3.17.3`.
Opening a built fixture, a local pixel check, or CanvasKit replay does not by
itself establish official visual parity, a physical GPU run, or device parity.
Official automation must use a real authorized AppID and the repository's
single-window machine lease and owned-resource cleanup rules.
