<a id="wxss-边框和盒子约束"></a>
# WXSS border and box contract

[简体中文](wxss-borders.md) · **English**


`style-border-001` covers a local end-to-end contract, from verified manifest
WXML/WXSS through real QuickJS/V8 AppService and View execution, layout, pixels
and coordinate input. `view.wxml-wxss` remains **partial** on all seven hosts.

<a id="级联和使用值"></a>
## Cascade and used values

The IR expands `border`, side shorthands, and width/style/colour quads before
specificity, importance and source-order comparison. Omitted shorthand values
reset width to `medium` (3px), style to `none`, and colour to `currentcolor`.
`thin`/`medium`/`thick` use 1/3/5px; nonnegative length units use the portable
viewport conversion. Percent border widths and invalid declarations do not
replace an earlier valid declaration. Parenthesized colour functions remain
one value. Colours support the shared colour parser, including alpha.

`initial`, `inherit` and `unset` are resolved after component projection;
border properties are not inherited by default. `currentcolor` uses the node's
resolved inherited foreground. Explicit `border-color:inherit` uses the
parent's computed border colour even when the child's foreground differs.
`none`/`hidden` have zero used width. `solid` is painted. Legal `dashed`,
`dotted`, `double`, `groove`, `ridge`, `inset` and `outset` currently produce a
renderer error naming `border-style`; they never silently become solid.

<a id="一个几何体用于布局绘制和输入"></a>
## One geometry for layout, paint and input

WXSS defaults to `content-box`: explicit width/height exclude padding and
border. `border-box` includes them, with a zero-content floor at the sum of
the insets. Auto flow dimensions count insets once. Flow children and text
start at the content edge. Positioned ancestors expose their padding box as
the absolute containing block; fixed coordinates retain the viewport boundary.
The default page border box remains the host viewport.

`LayoutStyle.border` contains top/right/bottom/left `{width,style,color}` edges.
`box_sizing` uses `content-box`/`border-box`. Existing hand-authored frame JSON
without these additive fields keeps zero borders and its previous border-box
sizing; this legacy frame default is separate from the WXSS default.

Software rasterization, native Skia and CanvasKit draw the outer rounded ring,
partitioned into four side regions. The inner hole preserves previously
painted content; painting never clears it or fills it with an invented
background. Opposing widths in a legacy undersized rectangle are proportionally
clamped to the available extent. Inner corner radii subtract the adjacent used
border widths and are normalized to the inner rectangle. Border painting is
binary at the boundary (no edge antialiasing); background antialiasing remains
backend-specific. Transforms and ancestor clips apply to the entire ring.
Each border side keeps its colour's intrinsic alpha while the complete node
subtree is painted. Node and ancestor `opacity` then composite their respective
groups once; overlap with backgrounds, text, images or descendants does not
multiply opacity into each primitive. See [the opacity contract](compositing.en.md)
for nested groups, invisible input and resource admission. CanvasKit consumes
one complete Rust frame; no per-node runtime calls or software-pixel upload are
introduced.

Overflow clips descendants at the inner border edge with inner radii. It does
not remove the node's own outer-border hit target. Unsupported/invalid frame
validation happens before accepted pixels and input state change.

<a id="证据和待办工作"></a>
## Evidence and remaining work

The saved official baseline is
[`shared-styles-3173`](archived-evidence.en.md):
IDE `2.02.2608080`, base library `3.17.3`, fixed upstream commit
`0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e`. Its main/ordinary-subpackage
checkpoints report a 2px border and `rgb(15,118,110)`. The local fixture paints
those values; that is a limited saved-value comparison, not a new official run
or a screenshot comparison of the original project.

`crates/container-runtime/tests/border_box.rs` exercises both native engines
and exports the actual accepted frames with `WEAPP_CONTAINER_BORDER_EVIDENCE_DIR`.
The browser replay checks CanvasKit WebGL readback for those exact frames.
Source-bound reports record backend/driver and cleanup; browser WebGL on a
software driver is not physical GPU evidence.

Still incomplete: the other border styles, border-image, CSS-wide
revert/revert-layer and cascade layers, full containing-block/percentage and
fixed escape rules, pixel-perfect antialiased corner joins, text shaping and
full typography, official visual differential runs, all seven current host
build/device proofs and the performance budgets. These limitations remain
release gates rather than being inferred from portable unit tests.
