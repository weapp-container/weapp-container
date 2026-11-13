<a id="block--flex-布局约定"></a>
# Block/Flex Layout Conventions

[简体中文](layout-flow.md) · **English**


The native WXML product now drives draw, selector, observer, hits and scrolling via a single layout result.
Ordinary view uses Block; the initial direction of explicit `display:flex` is row. Previously ordinary streams were treated as
Flex column and the behavior of converting percentages according to the viewport in advance will cause errors in the position and nested size of sibling elements.

IR validates long attributes before cascading and expands `flex`, `flex-flow`, `gap` and four-sided shorthand, retained
Importance and source code order. Illegal claims do not override previously valid claims. Runtime generated after font inheritance
`LayoutStyle.flow`, physical/font/viewport units converted to pixels, percentages and `auto` retained to
Taffy 0.15 when solving. The original pack and compiler artifacts remain unchanged.

Shorthand is verified according to the entire statement, and long attributes cannot be partially reset. The CSS-wide keyword must occupy the entire value,
For example, `gap:initial 10px` and `flex:1 inherit` will be discarded entirely; illegal postfix
`!important` cannot overwrite the previous valid value. Explicit `inherit` copies parent node calculated value; remaining layout properties
Use its own initial value by default. `em` uses the current parsed font, `rem` is fixed to portable root
16 logical pixels, `rpx` is the logical viewport width divided by 750. Percent reserved units, determined by the actual containing
The block and axis determine the result; the nested width and height will not be calculated in advance for the entire viewport.
The default host size of the virtual page is calculated by the formatter after parsing these values, and is not passed as CSS width and height.
`inherit`, avoid using the old content box after the page font or percentage padding is changed.

| Value Category | Current Bounds |
| --- | --- |
| Formatting | `display:block/flex/none`; Normal view defaults to Block, Flex defaults to row |
| Dimensions | length, percentage, `auto`, max of `none`; automatic minimum size can be overridden with `min-width:0` or `min-height:0` |
| Four sides | margin/padding/inset long and short attributes; margin and inset accept negative values and `auto`, padding does not accept |
| Inheritance | `initial`, `inherit`, `unset`; `revert/revert-layer` not explicitly supported |
| Lazy evaluation | Recognized `calc/var/env` and unknown font/container units are retained as unsupported values to avoid silent use of old values |

The current implementation covers Block, Flex’s row/column and reverse, grow/shrink/basis, wrap, gap,
justify/align, margin/padding, width and height min/max and box-sizing. relative maintains space within the stream,
absolute uses the nearest positioned ancestor, fixed uses the viewport. The text is remeasured to the allocated content width, and then
Accepted glyph positions are passed to native Skia or CanvasKit playback. Reserved when old wire frames are missing `flow`
Original path, do not reinterpret old absolute coordinates into CSS dimensions.

Legal but not yet implemented layout values ​​return `ERR_UNSUPPORTED_CAPABILITY`. `order` uses signed
32-bit integer; directly sort Flex items according to order and then participate in layout, line wrapping, drawing and hitting.
Identical values preserve document order. The selector, component and event parent chain always maintain the original WXML document order.
Block child nodes are not affected by order; the drawing ordinal group of absolute/fixed child nodes is fixed to 0.
When drawing, first distinguish the CSS paint phase, and then compare the level and order in the applicable phase: ordinary static Flex item
Positive order will not override the positioning of auto nodes, and non-`auto` z-index will not take effect on ordinary static Blocks.
`auto` See isolation differences from explicit zero, descendant promotion and clip boundaries
[Layering, draw order and input](stacking-contexts.en.md).
`order` is not inherited by default, explicit `inherit` reads the parent calculated value,
`initial`/`unset` is 0. Illegal declarations are discarded before cascading, legal values outside i32 range or lazily evaluated are retained
Explicitly not supported. Old wire retains behavior when missing `flow` or `order`.

WXML text uses a separate text leaf. Handwritten typed frame If you put its own text and child nodes in the same Flex
node, and using non-zero valid order for child nodes, will return `ERR_UNSUPPORTED_CAPABILITY` and retain the previous frame;
This kind of private anonymous text box does not yet have a unified draw/hit identity, and it cannot be declared to support only the sorted layout.
There are still gaps for Grid, full inline formatting, float, writing-mode, CSS animations, and full font shaping.
Text already within allocated content width using shared flow plan: Rust combined with UAX #14 and extended grapheme boundaries,
Supports six kinds of white-space, three kinds of word-break and five kinds of text-align of LTR.
Under normal, long English words that cannot be broken are allowed to overflow, break-all breaks lines at available grapheme boundaries, and keep-all suppresses
CJK Continuous text is broken internally. The original text is preserved, and whitespace folding is expressed through UTF-8 source span and line partitioning;
Drawing with CanvasKit does not re-break lines. This still does not constitute full CSS Text, shaping, bidi or nested inline
Equivalent, see [Text Typography Conventions](typography.en.md) for specific attributes, unimplemented values, and validation boundaries.
viewport-fixed descendants will break away from ancestor scrolling and overflow clip, while retaining the event parent chain and inherited transparency.
and the original drawing order. The transform ancestor also creates a containing block for absolute descendants, and the static ancestor's inset
does not change its in-stream position. Ancestor declares fixed composition of transform not yet implemented, including identity transform
will also explicitly return `ERR_UNSUPPORTED_CAPABILITY`; fixed's own transform can be used.
The acceptance and error boundaries of specific legal values ​​are subject to the IR/runtime test.
Two-dimensional transform freezes the length after font inheritance, and resolves the percentage according to the final border box after layout;
Origin, inheritance, numerical ranges, and runnable examples are available in [WXSS 2D Transformations](transforms.en.md).
For example, intrinsic `min-content/max-content/fit-content`, multiple keywords display, sticky,
Both safe/unsafe alignment and last-baseline remain explicitly unsupported. Parser takes bounded attributes
syntax and does not claim to recognize all CSS extensions. Keep the last accepted frame when rendering rejects.

IR test saves 112 Chrome auxiliary syntax inputs, verifying accept/drop and cascade boundaries; runtime
QuickJS/V8 Common use case verification Page tap → setData → flex proportion change → selector/storage,
And verify that unsupported deferred layout values do not replace accepted frames. Dual engine order use case verification Page tap → setData,
DOM query order, line wrapping, overlapping pixels and hits; CanvasKit Compare RGBA to explicit expected draw order.
They will not be counted as true DevTools passes.

Development Check:

```sh
pnpm simulator:dev -- --project examples/apps/flex-layout-app --viewport 360x800
```

The bottom button changes the line wrap container from 220px to 120px via the real Page handler, and the other button
selector geometry, page data, and lifecycle are written to `flex:observation`. scroll button call true
`wx.pageScrollTo`, and then click the fixed node according to the viewport coordinates; `render.commit` is not injected at this stage.
Check automatically updated queries, hits and pixels. Fixed scenarios include telescopic,
Wrapping, alignment, nesting percentage, min/max, text measurement and absolute/fixed.

Dual engine acceptance using built native Skia CPU runner with proven fixed compiler:

```sh
pnpm runtime:flex:smoke -- \
  --simulator-bin /absolute/path/weapp-simulator \
  --compiler-root /absolute/path/pinned-weapp-vite \
  --compiler-dist-hashes /absolute/path/compiler-dist-sha256.json \
  --out /absolute/path/flex-report.json
```

The script retains the real compilation product hash, manifest/blob, complete bridge trace, selector results and RGBA;
Check that QuickJS/V8 is consistent, and record its own source files and cleaning results. Chrome’s CSS coordinate and syntax detection
It is only used as an auxiliary baseline; the real DevTools, seven hosts, GPU, physical device and performance access control are recorded separately and cannot be upgraded from this.
You can additionally pass `--browser-corpus /absolute/path/browser-corpus.json` to compare with the same source fixture
Chrome Geometry. The original text height is preserved but does not participate in equivalence assertions; the exception is explicitly written into the report.

This round of source files, builds, dual-engine traces, full RGBA, secondary browser logs and failed attempts are archived in
[2026-10-21 Layout Evidence](archived-evidence.en.md). Archive validation only checks
The consistency of input and results has been recorded and does not replace the real DevTools, GPU, physical device and performance gate.

The real product of Flex order, smoke, uses independent examples and does not manually submit new frames instead.
The simulator’s own Page/setData refresh cycle:

```sh
pnpm runtime:flex-order:smoke -- \
  --simulator-bin /absolute/path/weapp-simulator \
  --compiler-root /absolute/path/pinned-weapp-vite \
  --compiler-dist-hashes /absolute/path/compiler-dist-sha256.json \
  --out /absolute/path/order-report.json
```

This round of original build, dual-engine development state interaction, complete RGBA, CanvasKit CPU and Chromium auxiliary records are available here
[Flex order evidence](archived-evidence.en.md). where compiler manifest's
`unknown` metadata is left as is, and independent verification of fixed compiler bytes is not replaced with official runtime passing conclusions.
