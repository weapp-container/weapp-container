<a id="层叠绘制顺序与输入"></a>
# Stacking, Drawing Order, and Input

[简体中文](stacking-contexts.md) · **English**


The WeApp Container's typed Block/Flex frame organizes rendering according to the CSS stacking phase.
`RenderNode.children` always preserves the original WXML order; z-index cannot be achieved through reordering or reattaching nodes.
This section describes the currently expressible and verifiable subset, without implying completeness of CSS or WeChat runtime visual equivalence.

<a id="typed-与旧-frame-的边界"></a>
## Boundary between Typed and Old Frame

When the `style.flow` of the root node is `Some(...)` , the entire frame uses the CSS paint plan.
`LayoutStyle.z_index: Option<i32>` distinguishes `None` (`auto`) from `Some(0)` (explicit zero);
`LayoutStyle.isolation` represents `isolation:isolate`. The z-index of a regular static Block does not apply,
even if the node creates a context due to transform or opacity, its static z-index cannot be considered as a layer.

The root node retains the old local painting convention with absolute coordinates for frames when the typed `flow` is missing: siblings use `RenderNode.z_index`, recursively painting the entire subtree. This old field cannot express the difference between CSS `auto`/`0`, and should not be used as the stacking semantics source for new WXSS frames. The old root does not export `paintPlan`.
If any node under the old root has a new `style.z_index:Some(...)` or `style.isolation:true`, both commit and frame serialization reject with `Unsupported("typed-stacking-without-css-root")`, preserving the previous frame; Rust accepts it under the old semantics while CanvasKit rejects the same output under new semantics.
Pure old `RenderNode.z_index` continues to be compatible.

<a id="context-与-paint-phase"></a>
## Context and paint phase

Current context boundaries include the root node, fixed nodes, non-`none` 2D transforms,
`opacity < 1`, `isolation:isolate`, and positioned nodes with non-`auto` z-index or direct Flex items.
Identity transforms still create context; `opacity:0.999` cannot be removed due to pixel quantization proximity to opaque.
`opacity:0` retains layout and hit testing, while `display:none` hides the entire subtree.

relative/absolute with `z-index:auto` creates a positioning context for the group, and descendants can still intersect with outer content.
An explicit `z-index:0` creates an isolated context, where descendants cannot pass through this boundary with a large z-index.
A regular static Flex item behaves similarly to an inline-block atomic render, but descendants of `auto` items can still intersect with external content; an explicit zero isolates these descendants. `isolation` itself does not create a containing block or overflow clip.

In the current Block/Flex subset, a context first draws its own background and border, then processes negative-level context, regular flow background and content, auto/zero-level group positioning, and positive-level context. Negative and positive values are sorted stably by numeric value; contexts at the same level retain the document traversal order. Descendants with negative z-index can appear on top of the context's own background, yet after the background of intermediate non-context ancestors. This requires that backgrounds and content can independently enter the paint phase, and does not allow sorting the entire ancestor subtree solely by z-index.

Direct Flex item uses the order-modified document order. Absolute/fixed child nodes have an effective ordinal group of zero, but the paint phase is first evaluated, and then the order is compared during applicable phases.
For example, a static item with `order:1` cannot cover a child node with auto positioning; after changing the item to relative or identity transform, it enters the zero-level phase, and only then can the order participate in phase-based precedence comparisons.
Block child nodes are unaffected by order. Selector, event parent chain, and DOM query order remain unchanged regardless of order.

<a id="三种关系与共享计划"></a>
## Three Relationships and Shared Plans

| Relationship | Purpose | When elevating the drawing hierarchy of descendants |
| --- | --- | --- |
| Original DOM/event parent chain | selector, capture/target/bubble, component ownership | retain original parent and child node indices |
| Spatial Chain | transform, scroll, containing block, overflow clip | Retains original spatial transform and effective clip |
| Stacking context belonging | paint phase、z-index、opacity group | Can differ from direct DOM parent node |

Rust's `PaintPlan` compiler is used for software painting, Skia painting, hit testing, and `RenderFrame` serialization.
Each time a plan is established, spatial projection computes the parent chain, transformations, and chained clip through a single document tree traversal, followed by the painting phase.
These calls currently do not share persistent caching, and thus cannot be considered as having a compiler description that is compiled only once across calls; it does not represent that performance barriers have been crossed.

Typed `RenderFrame` serialization carries `paintPlan` v1, commands as `begin`, `background`,
`content`, `end`, path uses original DOM child node indices. CanvasKit validates and replays this plan;
rendering order cannot alter the parent-child relationships in the wire tree. opacity is composited once after full group rendering;
descendants promoted to a certain context's rendering phase should not cause ancestor opacity to be reapplied or lost.

Determine the target in reverse order of rendering, then generate the event path along the original DOM parent chain. In addition to rectangular background hits, image or text content may be rendered after other ordinary Block background rendering and must be distinguished from empty content. Transparency does not alter box hit rules. Anonymous text without its own event identity must retain its own geometric/clip constraints and be mapped to the nearest hitable DOM ancestor; the text hit area cannot be expanded merely by extending to the ancestor's rectangle. The mapped point must also lie within the input geometry of the DOM ancestor itself; visible anonymous text overflow does not expand the event region of public WXML elements.

<a id="clipabsolute-与-fixed"></a>
## Clip、absolute and fixed

overflow clip constrains spatial relationships and cannot be discarded due to z-index promotion. The containing block for descendants of absolute positioning
When outside of an overflow ancestor, CSS does not allow the intermediate overflow ancestor to clip this absolute descendant;
the effective clip of the containing block and its ancestors is still preserved. When the containing block is at the overflow node itself, clipping should occur.
Therefore, standard use cases for promotion and clip use relative clip ancestors, and a separate static clip ancestor use case
to validate exceptions when the containing block is outside.

Currently, descendants with viewport-fixed are detached from the ancestor's scroll translation and overflow clip, but retain the DOM event parent chain, opacity, and context ownership. A fixed element cannot traverse beyond an opacity or isolation context using viewport coordinates. The fixed containing block created by a transform ancestor has not yet been implemented; combinations involving an identity transform are still explicitly rejected; the two-dimensional transform of the fixed element itself is exempt from this restriction.

<a id="验证与尚未达到的边界"></a>
## Verification and Unreached Boundaries

`crates/container-render-skia/src/paint_tests.rs` defines a fixed geometry, font-agnostic corpus:
identity with regular siblings, static z-index applicability, auto/zero child escape and isolation, negative layer backgrounds,
Flex item atomic groups and phase/order, transparent hits, DOM ancestors, single/nested opacity, clip/scroll,
fixed, hidden subtrees, image content and transparent image hits, and atomicity of resource denials.
SoftwareRenderer and SkiaRenderer use independently specified pixels and expected targets; expectations are not generated by internal comparators.
Explicit software fallback when Skia native backend is disabled, native CPU readback, CanvasKit CPU and GPU
execution evidence must be recorded separately. This corpus alone does not prove real DevTools, GPU, seven hosts, or real device passes.

Set `WEAPP_CONTAINER_STACKING_EVIDENCE_DIR` to export each fixed geometry case to an existing directory.
Subdirectories are named after the current test thread name and thread-local sequence number; neither directories nor files are allowed to overwrite existing content. Each record includes
a complete `frame.json`, independently specified sample colors and DOM hit path, full software/native premultiplied RGBA bytes, SHA-256, actual hit path, and backend flags; original observation results are saved prior to assertion failure.
When native Skia features are enabled, this fontless, integer geometry corpus is compared against all native/software pixels.
This is only a backend full-frame consistency validation, and the independent color oracle remains restricted to explicitly listed sample points, and sampling or two-backend consistency cannot be misrepresented as an independent CSS/DevTools oracle for the entire frame.

Check render budget before recursive planning and frame serialization: up to 100,000 nodes, depth 256 (root depth zero) and 1,000,000 cumulative DOM path entries. Reject use of `RenderError::PaintBudgetExceeded`, retain one accepted frame and snapshot on the renderer; do not publish a half-frame first before reporting budget error. Tests at depth 257 avoid constructing uncontrolled deep trees, and do not consider them as proof that all host memory or timing budgets are met.

The following still falls short of full parity and cannot be inferred from current Block/Flex results as being supported:

- float and its dedicated rendering phase, complete inline formatting, inline splitting, bidi, and table layer background.
- Grid item layout and stacking, as well as other formatting contexts currently not supported.
- 3D transformations, perspective, preserve-3d, backface, and 3D depth sorting.
- filter, backdrop-filter, blend mode, mask, clip-path, contain, will-change, and other effect/context sources.
- complete outline, pseudo-elements, top layer, platform-native component compositing, and proprietary rendering behavior of the official runtime.
- complete glyph shaping, font shaping, and cross-platform consistency in precise text input.

Whether specific declarations are accepted, discarded, or explicitly not supported remains subject to the corresponding IR/runtime admission;
It cannot be assumed that a parser or renderer has the implementation merely because a particular effect is listed in this document.

Independent rule basis:

- [CSS2 Appendix E: Painting phase](https://www.w3.org/TR/CSS22/zindex.html).
- [Flexbox 4.3: Flex item painting and context](https://drafts.csswg.org/css-flexbox-1/#painting).
- [CSS Display 3: order and out-of-flow ordinal group](https://drafts.csswg.org/css-display-3/#order-property).
- [CSS Transforms 1: Non-none transformations create context/containing block](https://drafts.csswg.org/css-transforms-1/#transform-rendering).
- [CSS Color 4: Post-processing of opacity and transparency hits](https://drafts.csswg.org/css-color-4/#transparency).
- [CSS2 overflow: Exception for absolute containing blocks outside clip ancestors](https://www.w3.org/TR/CSS22/visufx.html#overflow-clipping).
- WPT [Flex item positioning and order](https://github.com/web-platform-tests/wpt/blob/master/css/css-flexbox/flexbox-items-as-stacking-contexts-002.html)
  and [interleaving of descendants in non-complete context](https://github.com/web-platform-tests/wpt/blob/master/css/css-flexbox/flexbox-items-as-stacking-contexts-003.html).

When reproducing fontless CPU corpus, set export variables on an existing empty output directory and enable native Skia:

```sh
WEAPP_CONTAINER_STACKING_EVIDENCE_DIR=/absolute/empty-frames \
  cargo test -p container-render-skia --locked --jobs 2 --features skia-backend paint_tests -- --test-threads=2
pnpm runtime:stacking:frame-replay --frames /absolute/empty-frames \
  --canvaskit-dir /absolute/pinned-canvaskit --out /absolute/new-replay-directory
```

CanvasKit input must be the script-fixed SHA of 0.42.0 full JS/WASM. Replay verifies source code test suite,
51 fixed scenarios, input SHA per scenario, complete premultiplied RGBA, and recorded independent sample expectations.
Incomplete directory, changed input, or pixel inconsistency all report failure; original attempts are not overridden by subsequent results.

These public specifications are independent auxiliary references. The actual WeChat Developer Tool remains the final behavioral oracle; differences in specifications, execution failures, and unexecuted items should be retained as-is and cannot be overridden by internal backend consistency to cover external differences.
