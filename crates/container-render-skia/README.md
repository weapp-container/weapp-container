# container-render-skia

`RenderNode.dataset` and `RenderNode.mark` carry JSON values rather than only
strings. Legacy string entries and omitted maps remain valid frame input;
typed output requires an updated consumer. The runtime supplies these values
from WXML and uses the accepted tree for selectors and input. The renderer does
not infer JSON from attribute strings. See
[event metadata](../../docs/event-metadata.md) for compatibility and evidence limits.

Rendering contract for the portable container. `SoftwareRenderer` is the deterministic
headless fallback used in CI. `SkiaRenderer` is the stable host-facing type; enabling
`skia-backend` enables `skia-safe` 0.153.3. Raster mode draws the accepted frame
tree to a CPU surface; external-frame and native-GPU modes retain their distinct
presenter contracts without normal full-page CPU raster/readback. The feature
is opt-in because it downloads or builds the large Skia
toolchain; provide a matching `skia-binaries` cache or source build for each target.
The default build stays deterministic and headless. Native Skia/device validation is
reported separately from the software tests.

## Image resources

`RenderFrame.images` shares decoded straight RGBA8 resources by ID;
`RenderNode.image` references a resource and one of the 14 image modes.
Software, native Skia and CanvasKit use the same content-box crop/fit geometry
and nearest sampling, with existing transform, opacity, radius and overflow
boundaries. Resources and references are validated before publication. See
[the image contract](../../docs/images.md) for limits, provenance and remaining
asynchronous/provider differences.

## WXSS layout contract

`LayoutStyle.flow` carries typed Block/Flex input for the shared Taffy 0.15
solver. The runtime converts physical, font-relative and viewport units;
percentages and `auto` survive until their actual containing block is known.
Explicit Flex defaults to a row; ordinary view nodes use Block. The accepted
absolute rectangles and allocated-width text plans feed painting, selectors,
input and scrolling. Static and relative nodes stay in the parent's flow,
absolute nodes use the nearest positioned ancestor, and fixed nodes use the viewport.
`top`, `right`, `bottom` and `left` remain optional so opposite-side constraints
can stretch an out-of-flow node and negative offsets remain observable. A
`display:none` node is removed from flow and its stale bounds are cleared before
the next hit-test or snapshot.

Older serialized frames with no `flow` use their original physical-pixel
layout path. See [the flow contract](../../docs/layout-flow.md) for supported
values and remaining inline/text differences; a solver integration alone does
not prove official WXSS equivalence.

`LayoutStyle.border` holds typed top/right/bottom/left `BorderSide` values,
each with its own width, color and style. `solid` paints the outer rounded
rectangle minus its inner rounded rectangle; different side colors meet at
diagonals joining the corresponding outer and inner corners. The transparent
inner hole is never filled to simulate a border. `none` and `hidden` use zero
width and paint nothing. Other CSS border styles are recognized in the wire
format but return an explicit unsupported error; negative or nonfinite widths
reject the frame. Validation completes before the previous frame is replaced.

`box_sizing` is `border-box` for older absolute-frame producers; the WXSS runtime
explicitly supplies the CSS initial `content-box`. Content-box width and height
exclude padding and used borders. Border-box dimensions cannot be smaller than
those insets. Auto fill and measured heights count the insets once, including
after relayout. `LayoutStyle::border_insets`, `padding_box` and `content_box`
expose this shared geometry to hosts. Flow children and text use the content
box; positioned descendants use the padding box as their containing block.

Explicit overflow clips descendants at the inner border edge, with inner
corner radii derived from the outer radii and the adjacent side widths. The
element's own border remains paintable and hit-testable outside that clip.
Software and native Skia paint the same four side regions under transforms,
ancestor clips and opacity. Sharp shared diagonals avoid compositing translucent
side colors twice. Their local readbacks do not establish official DevTools
visual agreement or physical GPU/device acceptance.

`RenderNode.scroll_container` (wire `scrollContainer`, default false) marks a
resolved scrolling viewport. Its `scrollOffset` translates descendants in local
coordinates after a fixed padding-box clip; its background, border and own
geometry stay fixed. Software, native Skia, hit paths and `node_geometries` use
the same composition, including nested transforms and scroll containers.
Unmarked offsets retain their legacy metadata meaning. Negative or nonfinite
offsets reject before replacing the committed frame. `scroll_viewport()` and
`scroll_content_extent()` expose the padding viewport and unscrolled descendant
border-box extents to the runtime, which owns axis selection, clamping and events.
`scroll_target_offset()` resolves a descendant in the container's unscrolled
local coordinates, including nested transforms/scrolling; `world_transform`
on node geometry lets input providers invert viewport-space deltas.
The extent helper excludes hidden subtrees and nested scrolling contents. It
does not establish full CSS scrollWidth, fixed-descendant or glyph-ink overflow
semantics, gesture recognition, inertia or official scroll-event parity.

`transform` is represented as an affine matrix (`matrix`, `translate`, `scale`,
`rotate` and `skew` forms), while `transform-origin` retains percentage or pixel
units in the frame. Layout bounds stay in the pre-transform coordinate space;
the software and Skia backends apply the resolved matrix to paint and hit-test
the same world-space quadrilateral. Pointer coordinates therefore remain aligned
with pixels when a view is translated, rotated or scaled.

With `skia-backend`, `SkiaRenderer::snapshot()` reads committed pixels back
from the CPU raster surface through Skia's `read_pixels` API. The
`native_skia_raster_surface_returns_real_rgba_readback` test asserts the frame
id, dimensions and RGBA bytes, and `has_native_surface()` lets host diagnostics
distinguish a committed Skia raster surface from a software fallback. The
`has_gpu_surface()` query remains false until a platform adapter attaches a
real GPU context; host/device gates must require a `skia-gpu-*` backend.

## Canvas batch execution

`commit_canvas` merges retained command history, then validates and normalizes
the complete JSON batch into private typed commands. Preparation checks pixel
layout metadata without allocating pixels, building paths or touching fonts.
Only the selected backend paints: native Skia no longer performs a discarded
software rasterization before its own draw. Native unsupported commands fail
before surface allocation, after shared argument validation completes.

Accepted command history and snapshots are published only after the backend
and snapshot succeed. `reserve` still replays the full retained history, and
the public JSON wire format and RGBA snapshot contract are unchanged. Native
Canvas continues to use a CPU Skia raster surface and one pixel readback;
this change does not establish GPU or device performance results.

Arc start/end angles accept finite JSON f64 values. Shared preparation reduces
their direction and turn count before converting bounded start/sweep values to
f32; neither backend loops once per turn or converts unbounded angles to
degrees. Forward spans of at least one turn draw a full circle; reverse spans
wrap within one turn, with exact reverse whole turns and equal endpoints
producing a zero sweep. This extends the previous f32 angle range; canvas
coordinates, radius and other numeric arguments retain their existing range.
Very large angles have deterministic floating-point phase reduction rather
than a claim of exact arbitrary-precision geometry.

`CanvasService` owns command history, snapshots and native font state independently
of a page object. A Session can draw or inspect Canvas before Skia page access;
first explicit page initialization moves that exact service into its renderer.
The move preserves decoded faces, glyph-cache identity and render/installation
locks. Once initialized, the current renderer is the sole authority, including
after legacy whole-renderer replacement; no retired pre-page history returns.

`accepted_render_target()` is the target pinned by a successful page commit.
Configuring density, failed commits, independent Canvas and diagnostic capture
do not change that pin. GPU diagnostics use the accepted target, not a later
staged density. This submission fact is not a host framebuffer measurement or
presentation receipt.

## Native font ownership

Hosts with no discoverable system font manager can read their public installed
font files once, keep the bytes in `Arc<[u8]>`, and pass ordered
`NativeFontData::new(bytes, collection_index)` values to
`SkiaRenderer::install_native_fonts` before the first native render. Every face
is decoded before the set is published. Invalid bytes or collection indexes
return `RenderError::InvalidFont` without changing the working provider.
`native_font_info()` reports only the installed face count and family names.

System fallback discovery is lazy: constructing native or export-only renderers,
reading font diagnostics, and laying out or committing rectangle-only frames do
not initialize the `NativeFonts` system manager. Character lookup checks its
cache and installed faces first; the first unresolved glyph initializes system
fallback once, including a manager with no default face. Text measurement can
still require that lookup, including normal line metrics for empty text.
Explicit font decoding remains separate and uses
`FontMgr::custom_empty().unwrap_or_default()`; its platform fallback may discover
system fonts. This does not establish scan-free installation on every platform
or a startup performance result. First-frame measurements must include deferred
font discovery, decoding, text layout and presentation.

One Canvas/font owner retains the decoded faces and positive/negative glyph
lookup cache for Canvas text, page rasterization and GLES/Metal target drawing.
It begins in the independent service and moves without re-decoding into the
page renderer on first explicit page access. Injected
faces have priority in the supplied order, followed by verified system glyph
fallback; a missing glyph affects only that character. Skia takes one owned
copy for each newly decoded face, with no font reads or byte copies per frame.
The session-long glyph lookup cache is bounded to 8,192 characters; eviction
only causes a later lookup to repeat and does not change selected glyphs.
Identical installations reuse decoded faces. After native rendering begins,
changing the font set is rejected to keep accepted frames and snapshots
consistent; an identical installation remains idempotent. Dynamic font loading
and complete WXSS typography are outside this initialization contract.
