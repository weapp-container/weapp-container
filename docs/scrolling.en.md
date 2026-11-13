<a id="会话滚动"></a>
# Session scrolling

[简体中文](scrolling.md) · **English**


`Session` owns the accepted scroll state, keyed by PageId and rendered
occurrence. Public WXML `id` values are selector data, not state keys. A fresh
WXML/layout generation reconciles declaration changes and clamps retained
offsets to the current positive content extent. Unrelated `setData` updates
preserve scrolling; unload releases the page's entries.

Generated page roots and enabled `scroll-view` axes become explicit render
viewports. `RenderNode.scrollContainer` opts into descendant translation by
`-scrollOffset`, with a stationary padding-box clip and stationary border and
background. Legacy frames with only `scrollOffset` retain their metadata
meaning. Software, native Skia and CanvasKit use the same coordinate contract;
selector geometry and hit testing observe the translated world coordinates.
Candidate frames and state publish together after renderer acceptance.

Hosts send one `event.batch`, never node mutations:

```json
{"events":[{"type":"wheel","x":30,"y":30,"deltaX":20,"deltaY":40,"deltaMode":0,"bubbles":true}]}
```

Positive deltas increase scroll offsets. Coordinates and pixel deltas use the
render frame's logical coordinates. Numeric modes `0`, `1`, `2` mean pixels,
lines and pages; string `pixel`, `line`, `page` forms are accepted. Hosts should
normalize their own wheel convention. The Web adapter converts CSS pixels,
16-pixel lines and viewport-sized pages before batching. The desktop adapter
converts winit signs. Available movement is consumed from the hit container
towards scrolling ancestors; accepted state drives scroll callbacks and
observer measurements. Identified touch contacts retain their captured route.

The inspector, `/embed` and standalone Web wrapper share
[`surface-input.mjs`](../examples/hosts/web-wasm/surface-input.mjs). It serializes
bridge batches, preserves wheel event order, drops pending input for a
replaced session and releases its listeners/capture/RAF at teardown. A touch
drag does not synthesize a tap. Browser zoom gestures keep their normal host
behavior.

`wx.pageScrollTo` now requires a live page and that page's accepted frame.
Immediate scrolling uses `duration: 0`; positive duration returns
`ERR_UNSUPPORTED_CAPABILITY`. Missing frames return `ERR_RENDER`. Cancellation
and deadline checks precede mutation. A standalone sandbox provider returns
unsupported instead of recording a successful scroll without moving pixels.
This remains partial support: default animation timing, inertia, enhanced
scroll-view features, exact upper/lower thresholds, fixed-position escape,
glyph ink overflow and the full CSS scrollable overflow model need further
work and official evidence. A dispatched `catchtouchmove` suppresses the
default drag; ordinary `stopPropagation()` does not. Exact official ordering
and native default behavior still need differential evidence.

Intersection observers retain a rectangular geometry contract. Native-mode
scroll ancestors use their transformed padding boxes for axis-aligned scale
and reflection; rotated/sheared scrolling clips explicitly return
`ERR_UNSUPPORTED_CAPABILITY`. Rectangular intersection ratios do not measure
the visible pixel area of rounded corners.

Page style resources follow the manifest's App, current route and recursively
declared component graph. Startup, ordinary rendering and development reload
use the same Rust `route_style_ids` helper. A different page's identically
named class cannot enter a frame merely because both pages share a pack.
Component style isolation remains a separate View responsibility.
Local quoted and `url(...)` WXSS imports follow the selected style graph,
including relative and pack-root paths. Repeated imports retain their cascade
order. WXSS IR v2 records import rules at their source sites, preserving
conditional nesting. Leading imports can carry media queries; matched imports
and media groups resolve against the render frame's logical viewport before
the ordinary cascade. Rendering a new viewport re-evaluates those conditions.
False branches do not contribute rules or traverse their nested imports.
Active late/nested imports and unsupported active at-rules return
`ERR_UNSUPPORTED_CAPABILITY`; cycles, missing resources, escaping paths and
remote imports fail before frame publication. A rejected candidate preserves
the previously accepted frame.

Legacy WXSS IR v1 stores imports separately from local rules and loses their
original positions and nesting context. Its imports still expand before that
file's rules; imports hoisted from nested at-rules cannot recover their original
condition. V1 compatibility is not evidence of reconstructed source semantics.
The [WXSS contract](wxss-ir.en.md) records supported media features, unknown-query
behavior, metadata-only font/keyframe handling and remaining parser gaps.

The source fixture is [`scroll-contract-app`](../examples/apps/scroll-contract-app).
Run it interactively with:

```sh
cargo run -p container-simulator -- dev \
  --project examples/apps/scroll-contract-app --surface web --viewport 240x200
```

The repeatable native smoke validates an explicitly selected isolated compiler
against pinned Git objects and an independent dist hash receipt, then builds
the real application, packs it and runs both native engines:

```sh
node scripts/scrolling-smoke.mjs --simulator-bin target/debug/weapp-simulator \
  --compiler-root /path/to/verified/compiler \
  --compiler-dist-hashes /path/to/compiler-dist-sha256.json \
  --out /path/to/new-report.json
```

For actual browser wheel, touch and App embedding input:

```sh
node scripts/scroll-browser-smoke.mjs \
  --wv-bin /path/to/verified/compiler/packages/weapp-vite/bin/weapp-vite.js \
  --simulator-bin /path/to/verified/weapp-simulator \
  --engine quickjs --out /path/to/new-evidence-directory
```

The browser smoke creates its own development supervisor on an OS-allocated
loopback port and one headless page, then closes its page/context/browser,
SSE stream, compiler watcher and server. Its compiler-bin hash alone is not
full compiler provenance; use the native smoke's independent verification as
well. Native-runtime Web tests do not prove browser-WASM V8, native device
input, GPU execution, performance budgets or official DevTools equivalence.
