# Typography in the portable frame

WXSS font size and line height are computed after component/slot projection,
before layout. The page box, elements and anonymous WXML text leaves all carry
the resolved `text_style`. Selector `computedStyle` reads the same computed
font size and used line height; `normal` remains the keyword `normal`.

`font-size` supports nonnegative CSS lengths in px, rpx, em, rem, viewport units,
percentages and physical units, plus zero, medium and initial/inherit/unset.
Percentages and em use the parent font size. The portable CSS root used by rem
is 16 logical pixels; the virtual `page` element does not change that root.
rpx uses the logical viewport width divided by 750. Relative keyword sizes and
unimplemented deferred calculations return `ERR_UNSUPPORTED_CAPABILITY`.
Malformed primitive declarations are discarded before cascade comparison, so
they cannot overwrite an earlier valid value, including an important value.
Font shorthand is parsed at the cascade boundary but remains explicitly
unsupported by the runtime; it cannot silently retain a stale longhand size.
The parser covers a bounded grammar and finite f32 values. Numeric overflow
and nonzero underflow are rejected; full CSS numeric range and grammar parity
remain incomplete.

Line height keeps its inherited value type: a unitless multiplier is applied
to each descendant's own font size, while a percentage/em/length computes to
pixels on the declaring node and inherits that length. `initial` resets to
`normal`; `inherit` and `unset` inherit. Zero font size produces no glyph ink.
Zero line height still paints ink outside its line box, subject to ancestor
overflow clipping.

`SkiaRenderer::layout_tree` measures with the renderer's installed/system font
provider. Advances, ascent, descent and leading come from that provider; the
same provider remains fixed after the first native layout/render. Layout
creates `text_layout`, containing the measurement origin (`native` or
`fallback`), line metrics and Unicode scalar positions relative to the content
box. Native CPU/GLES/Metal drawing and CanvasKit replay consume these accepted
positions without independently wrapping the text. The entire frame crosses
the bridge as one batch.

The free `layout_tree` and software-only builds use the deterministic metrics
provider. Its origin is explicitly `fallback`; its half-em advances are not
evidence of installed-font or WeChat geometry. Web/WASM currently uses that
provider in Rust. CanvasKit can draw its own supplied face at accepted positions,
but identical glyph outlines across different host font sets are unproven.
An explicit typed frame without a plan can be drawn with local font metrics;
its receipt distinguishes that local path from a committed native plan.

Both fields are optional additions to the render-frame contract. Existing
absolute frame producers without them retain their previous 16px text path.
Invalid style/plan data, text mismatches, finite-coordinate overflow and text
budgets fail before publication, preserving the previous accepted frame.
This does not guarantee rollback of JS component topology: component projection
can run before a later layout validation rejects the candidate frame.

Runtime text leaves now use a version-one horizontal, left-to-right flow profile.
`TextStyle.flow` holds the resolved `white_space`, `word_break` and `text_align`;
`TextLayout.flow` holds the accepted source-to-glyph and line plan. The parser
discards malformed primitive declarations before cascade comparison. The three
properties inherit, including `inherit`/`unset`; `initial` restores
`normal`, `normal` and `start`. Recognized but unimplemented values, deferred
keyword substitutions, `revert` and `revert-layer` fail explicitly with
`ERR_UNSUPPORTED_CAPABILITY` rather than reviving an earlier declaration.

| Property | Current flow profile |
| --- | --- |
| `white-space` | `normal`, `nowrap`, `pre`, `pre-wrap`, `pre-line`, `break-spaces` |
| `word-break` | `normal`, `break-all`, `keep-all` |
| `text-align` | `start`, `end`, `left`, `right`, `center`; start/end use LTR |

The Rust planner combines Unicode UAX #14 line-break opportunities with extended
grapheme boundaries, then applies the selected word-break and whitespace mode.
`normal` does not force a long unbreakable Latin word to fit; `keep-all` suppresses
breaks within CJK runs, while `break-all` adds eligible grapheme-boundary breaks.
CR/LF/CRLF, collapsible spaces, preserved tabs, hard breaks, hanging spaces and
`break-spaces` have separate normalization/layout rules. Preserved tabs use
eight-space tab stops. This profile has no language metadata: segment breaks
collapse to a space even between CJK letters. Alignment uses the allocated
content width after padding; overwide lines use the start position.

Each evaluated WXML text leaf keeps its original string. The plan binds its
UTF-8 SHA-256, computed style, available width, metrics and offsets. Every painted
scalar has a half-open UTF-8 source span; a collapsed space maps to its entire
source whitespace run. Line spans partition all source bytes, including omitted
controls and trimmed whitespace. Empty or wholly collapsed text has no line box
and records `empty_source` instead. Normalization never rewrites Page data or the
observable text into a pretrimmed display string. The existing WXML formatting
filter is unchanged: outside a `text` ancestor, a source-only text node without
bindings is omitted when it is wholly whitespace and contains CR or LF. Text
subtrees, single-line spaces and binding results remain explicit text leaves.

Native rendering and CanvasKit consume the accepted scalar positions without
measuring or wrapping again. Rust validates the full line-break opportunities at
the commit boundary. The browser replay validator checks the source hash,
normalization/source mapping, grapheme boundaries, complete source/glyph
partitions, style binding and finite geometry. It does not embed a second full
UAX #14 table, so its checks alone do not certify every Unicode line-break choice.
Legacy typed frames without flow retain their previous scalar-layout contract;
a typed flow style requires its matching committed flow plan.

This remains partial typography support. Grapheme-safe breaking does not provide
OpenType shaping: glyphs are still positioned as individual Unicode scalars.
Kerning/ligatures, bidi, nested inline formatting, font family/weight selection,
variable fonts, language-sensitive break tailoring, discretionary-hyphen rewriting
and official typography defaults remain incomplete. RTL and
non-normal bidi declarations are explicitly unsupported. Font availability can
also differ by host; missing glyph coverage cannot be repaired by removing source
characters or substituting a different accepted plan.

`examples/apps/typography-app` exercises actual Page events, relative font size,
numeric versus percentage inheritance, explicit newlines and zero values.
`pnpm runtime:typography:smoke` builds the fixture with a separately verified
pinned weapp-vite compiler, runs QuickJS/V8 and compares selector results and
complete native RGBA snapshots. Renderer tests compare shared plans to native
font measurements. CanvasKit tests include actual WASM CPU pixel replay when
the pinned test runtime/font paths are supplied. These remain auxiliary local
evidence; DevTools, GPU, devices, seven-host coverage and performance need their
own current-source receipts.

`examples/apps/text-flow-app` adds bound CRLF/tab text, long Latin/CJK runs,
combining marks, ZWJ emoji and regional-indicator pairs. Its buttons use actual
Page handlers and `setData` to switch whitespace, breaking and alignment, then
store public selector observations in `text-flow:observation`.

```sh
pnpm simulator:dev -- --project examples/apps/text-flow-app --viewport 320x680
```

`pnpm runtime:text-flow:smoke` accepts the same `--simulator-bin`,
`--compiler-root`, `--compiler-dist-hashes` and `--out` arguments as the layout
smokes. It checks QuickJS/V8 through the development HTTP/SSE surface, actual
coordinate taps, the supervisor's automatic render loop, selector/storage and
complete native Skia CPU RGBA. Rust integration tests separately inspect accepted
flow plans; their explicit public `render.commit` refresh is not evidence for the
automatic simulator loop. `pnpm runtime:text-flow:browser-oracle -- --out
/absolute/path/browser.json` records auxiliary headless Chromium CSS observations.
Current-source results and limitations belong in the
[text-flow evidence](archived-evidence.md); none of these local
lanes upgrades real DevTools, GPU, devices, host parity or performance status.
