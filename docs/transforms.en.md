<a id="wxss-2d-变换"></a>
# WXSS 2D Transformation

[简体中文](transforms.md) · **English**


Weapp Container divides transformation parsing, layout, and rendering into three steps to avoid incorrectly calculating the entire viewport when applying `translate(-50%, -50%)` before nodes have dimensions.

1. IR validates `transform` and `transform-origin` before cascading. Invalid declarations are discarded entirely, including those with post-fixed `!important`; valid but unimplemented values are retained, resulting in explicit runtime failure.
2. After font inheritance completes, runtime freezes `em`, physical lengths, `rpx`, and viewport units. Percentages are retained until layout finishes. Non-`none` transformations, even if identity, establish a positioning containing block.
3. After layout completes, percentages are calculated based on each node's final border box, and a single affine matrix is generated in declaration order. Rendering, selector, observer, scroll range, and coordinate mapping all share this matrix; CanvasKit consumes the already-accepted numeric matrix and does not re-parse WXSS.

Example: a node with width 40px, height 20px, padding 4px, and border 2px has a border box of
52×32. The translation `translate(-50%, -50%)` is (-26px, -16px), which does not take half of the viewport.
Flex layout, automatic height, window size, or a `setData` call changing the size will cause the next frame to recalculate the used value.

Supports `matrix`, translate/scale in 2D and single-axis forms, rotate, skew/skewX/skewY, and ordered lists. Angles can be specified in deg/rad/grad/turn; the literal zero allows omission of the angle unit. origin supports length, percentage, and left/right/top/bottom/center, including `bottom left` and `left bottom`. The third zero-length can be omitted; non-zero Z is still explicitly unsupported.

Transformation and origin are not inherited by default; `initial`, `unset` use the initial value, explicit `inherit` copies the parent
computed value. For example, a parent's `translate(1em, 50%)` freezes the horizontal by 10px at a 10px font size; the child inherits the horizontal at 10px even if it switches to a 20px font, while the vertical percentage is based on the child's own border box.
The selector's transform is serialized into its own `matrix(...)`; origin is a pixel position relative to its own box. The old direct wire frame numeric matrix interface remains available.

Detected deferred math/substitution, 3D, perspective, revert/revert-layer, etc. are not yet implemented and return `ERR_UNSUPPORTED_CAPABILITY`. Return `ERR_RENDER` when length conversion, matrix composition, origin conjugation, or geometric accumulation across ancestors/scroll exceeds finite bounds, without treating it as an invisible node and silently skipping. Reject frame retention of original frame, selector, and input target. `scale(0)` is a valid invisible transformation and is not a rendering error.

A small but non-zero determinant is not considered zero when epsilon is applied. Matrix multiplication, addition, and inversion use double-precision intermediate values; the accepted matrix and its inverse must be expressible using the host's f32 coordinates. Explicit rejection occurs when a non-zero accumulated value underflows to zero, avoiding the misrepresentation of failed frames as valid `scale(0)` frames.

transform remains explicitly unsupported when combined with viewport-fixed descendants, and identity behaves the same.
Full 3D, animation interpolation, cross-ancestor stacking context, official visual equivalence, and host evidence continue to be listed separately;
the 2D implementation in this document will not mark these restrictions as passed.
The drawing order for transform-generated stacking contexts still exhibits differences: when transformed Flex elements overlap with regular sibling elements, current behavior draws them in sibling order, and the Chromium fixture's hit and pixel comparison test still fails.

Development Example:

```sh
pnpm simulator:dev -- --project examples/apps/transform-app --viewport 320x400
```

Click the blue box to toggle content size, click Transform to toggle percentage translation, 90° rotation, and none. Red border, yellow corner markers, and axes help observe the final box, origin, and hit change. The example's selector and storage are driven by a real Page handler; the developer monitor handles automatic redrawing.

`style-transform-2d-001` Associates IR parser/cascade tests, runtime module, and real App/Page
Dual-engine tests, renderer rejection atomicity tests. Settings
`WEAPP_CONTAINER_TRANSFORM_EVIDENCE_DIR` can export 25 actual accepted frames and CPU/software
RGBA per engine, then run `pnpm runtime:transform:frame-replay` to replay the complete frame using a fixed CanvasKit CPU.
Full pixel comparison does not go through screenshot scaling; this evidence still does not represent official DevTools, WebGL/GPU, or device passes.

`pnpm runtime:transform:browser-oracle -- --frames <导出目录> --out <新目录>` additionally uses native HTML/CSS in headless Chromium to check fixed hit points and complete pixels from the corresponding fixtures. Geometry and computed style are observations only. This auxiliary model does not execute AppService and establishes neither container Web-host acceptance nor real WeChat acceptance. Retained frames associated with failed candidate data are excluded from this HTML model.
