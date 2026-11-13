<a id="透明度与子树合成"></a>
# Transparency and Subtree Compositing

[简体中文](compositing.md) · **English**


`opacity` takes effect on the entire subtree of a node after it has been rendered. The background, border, text, images, and descendants of a node are first composited into a transparent layer in rendering order, and then the layer is composited into the parent layer at the node's opacity. Thus, overlapping opaque red and blue nodes within the same `opacity:.5` container have their intersection first fully covered by blue, and finally the entire area is covered by semi-transparent blue. It is not possible to multiply `.5` separately to the red and blue primitives; doing so would cause the already obscured red to reappear in the overlapping region.

When both parent and child nodes declare opacity, each creates its own compositing boundary. With parent `.5`, child `.5`, and otherwise transparent content, the child’s visible contribution is approximately `.25`. If the parent also has an opaque background, composite the child group onto that background before applying parent opacity. Do not simply multiply every primitive’s alpha by `.25`.

<a id="属性解析"></a>
## Attribute Parsing

WXSS validates `opacity` before cascade, then parses valid declarations into a unified `RenderNode.opacity`:

| Declaration | Computation Result |
| --- | --- |
| Default, `initial`, `unset` | `1` |
| Values, percentages | Normalize and clip to `[0,1]`, for example `.5` and `50%` both equal `.5` |
| `inherit` | Copy the parent node's compute transparency, child nodes still have their own compositing boundaries |
| Illegal declaration | Discarded before cascade, does not override previously valid declarations |
| Recognized `calc()`, `var()`, `env()`, `revert`, `revert-layer` | Explicitly returns `ERR_UNSUPPORTED_CAPABILITY` |

Legal values are clipped before being stored in `f32`; `1e39` becomes `1`, `-1e39` and `1e-46` become `0`,
no earlier declarations are exposed due to the range limitations of the font value parser. Percentage values in multiplication and division retain their type; for example, `calc(50% / 2)` is a valid but currently unsupported value and must be explicitly rejected, not discarded as an invalid declaration.

Opacity is not inherited by default. When the parent has `.5` and the child does not declare opacity, the child's node field remains `1`; its pixels are blended to appear faded by the parent's composition. Only when the child explicitly sets `inherit` does its own field become `.5`, thus creating a second compositing boundary.

An explicit wire frame is a rendered protocol that has been parsed, requiring each `opacity` to be a finite value in the range `[0,1]`. It does not perform WXSS value clipping; for example, directly submitting `opacity:2` will return `ERR_RENDER`. Invalid frames will not replace already accepted frames, snapshots, selector geometries, or input hit trees.

<a id="布局和输入"></a>
## Layout and Input

`opacity:0` skips pixel drawing and transparent layer allocation, nodes and their descendants still participate in layout, selector queries, and hit testing. Tap coordinates are still dispatched to the original target's Page/Component listener. Existing touch contacts will not be canceled solely due to the target or ancestor becoming transparent; existing input invalidation boundaries such as node removal or page unloading are still handled according to their respective rules. The layout and input behavior for `display:none` is an independent attribute behavior.

Synthetic boundaries do not alter the WXML document order, event parent chain, Flex order, or existing sibling rendering order.
Descendants of viewport-fixed remain part of the ancestor's transparency group; they detach from the ancestor's scrolling and overflow clip.

<a id="各绘制路径与资源限制"></a>
## Various rendering paths and resource limitations

The software renderer uses premultiplied RGBA8 layers; native Skia and Web CanvasKit use separate save-layers. Each path draws the complete subtree before compositing it into the parent target with SrcOver. Group opacity is uniformly quantized as `round(opacity * 255)`, and nested groups are quantized separately. Native/software pixel comparisons allow a rounding difference of at most 1 byte per channel. This tolerance does not extend to geometry, targets, or drawing order.

Native N32 uses a layer restore filter that only scales alpha to enable Skia to use the floating-point compositing pipeline. Direct use of
the old sprite blitter's `save_layer_alpha` will undergo an approximation of `(alpha + 1) / 256`; a semi-transparent white background color can save 1 byte, and 2 bytes when nested. This implementation chooses not to alter the layer format or expand pixel tolerance.

Before submission, check the compositing budget against the target size and the depth of coexisting semi-transparent groups:

- Up to 32 layers of visible nested semi-transparent groups.
- Additional simultaneous RGBA8 layer budget of 64 MiB; estimated conservatively based on full target area.
- `opacity:1` does not create new transparent groups; `opacity:0` and `display:none` subtree does not consume layer budget.
- Software renderer reuses already allocated layer storage among sibling groups.

This budget only constrains additional transparent layers and does not include the target surface, snapshot, font, image, or Skia internal overhead, nor does it represent an upper limit on the entire process or GPU memory. Candidate frames exceeding the budget are rejected, and the previously accepted frame is retained; no silent degradation occurs on a per-primitive basis or by ignoring transparency.

Current boundary covers the compositing of transparent subtrees within the existing composition tree. It does not fully address the complete CSS stacking context, and there remain gaps regarding cross-ancestor z-index, blend mode, filter, backdrop-filter, and other properties. The current result does not constitute a pass for GPU, seven-host, real device, or performance thresholds.

<a id="本地回归"></a>
## Local Regression

`crates/container-runtime/tests/group_opacity.rs` Uses a real CommonJS `App` / `Page`
module, validated WXML/WXSS blob, QuickJS/V8, and actual Page `setData`. Tests read the current Page data from the host
at the publish boundary to generate a frame, and pass the same accepted frame to an independent software
renderer for replay, covering:

- The final pixel when overlapping descendants are updated between `.5`, `.25`, and `1`.
- Continuity of selector geometry, coordinate tap, page data, and captured touch when `opacity:0`.
- Nested compositing of a parent group with background and a child group with transparency.
- Percentage, explicitly inherited, `initial`, `unset`, and default values.
- Clamping of extreme max and min values, rejection of valid but currently unsupported expressions, and subsequent recovery of valid updates.
- After explicit frame rejection, the original snapshot, input tree, and query results remain available.

```sh
cargo test -p container-runtime --locked \
  --features quickjs-native,v8-native,container-render-skia/skia-backend \
  --test group_opacity
```

Omitting `container-render-skia/skia-backend` allows the runtime renderer to use software paths;
the output will retain the actual backend name and cannot be misrepresented as native Skia or GPU acceptance. Both native JS
engines also require their respective features, and failures cannot be masked by switching engines.

Set `WEAPP_CONTAINER_OPACITY_EVIDENCE_DIR=/absolute/path` to export, per-engine and per-stage, actual frames, sampled expectations, runtime backend, RGBA hashes, and original snapshots of `.runtime.rgba` and `.software.rgba`. The exported data represents only these local contracts; explicit refreshes in tests cannot replace the developer's own refresh cycle in development mode, nor can they be considered true DevTools comparisons.

The export directory can be handed over to a fixed-version real CanvasKit CPU replay; it will require a complete 31-stage ×
two engines, verify the original snapshot hash, and compare complete RGBA:

```sh
pnpm runtime:opacity:frame-replay --frames /absolute/runtime-frames \
  --canvaskit-dir /absolute/canvaskit-0.42.0 --out /absolute/new-replay-directory
```

This replay only invokes the real CanvasKit CPU rendering APIs, without initializing WebGL or running a web host. Independent
Chromium HTML/CSS maintains separate screenshots, complete RGBA, semantic, and pixel state; auxiliary results may exhibit differences due to native rasterization rounding and cannot be passed as valid, nor can they replace WeChat's final oracle.


<a id="开发态真实产物与辅助-css-oracle"></a>
## Development-time True Product and Auxiliary CSS Oracle

`style-opacity-group-001` associates the above runtime contract, renderer/CanvasKit unit tests, and
`examples/apps/group-opacity-app` development execution chain. The `view.wxml-wxss`, seven host and
QuickJS/V8 inventory support levels remain `partial`.

First, follow [Simulator Builder Preparation Steps](simulator.en.md#开发态监督器) to prepare the fixed commit of the `weapp-vite` source code, compile the dist and generate the corresponding SHA-256 manifest, then run directly:

```sh
pnpm simulator:dev -- --project examples/apps/group-opacity-app --viewport 320x300
```

Top-left semi-transparent group contains a red parent background with overlapping green and blue children; top-right is a nested pair of semi-transparent groups.
A click at coordinate `(30,170)` in the invisible area still hits descendants and bubbles up to the parent node; Page handler
Restores visible state via `setData`, simultaneously making the top-left group opaque. Click `(20,250)` to hide again,
Click `(110,250)` to save the selector, style calculation, lifecycle, dataset, and event observation to
`group-opacity:observation`. The example contains no text, and pixel expectations do not depend on host font.

Automatically execute real watch/build, portable pack, and HTTP/SSE input:

```sh
cargo build -p container-simulator --no-default-features \
  --features quickjs-native,v8-native,container-render-skia/skia-backend --locked
pnpm runtime:opacity:smoke -- \
  --simulator-bin target/debug/weapp-simulator \
  --compiler-root <verified-pinned-compiler> \
  --compiler-dist-hashes <compiler-dist-sha256.json> \
  --out artifacts/group-opacity.json
```

Each engine observes initial, restored, hidden-again, and restored-again in sequence within the same session.
Each input sends only the actual tap coordinates; redrawing is automatically triggered by the supervisor; collector does not send data patches, `render.commit`, handwritten frames, or injected JavaScript. Reports preserve the original compiler output, complete portable pack, independent re-packaged comparison, Page storage/selector, HTTP/SSE journal, and full RGBA per stage. All RGB channels with independent rectangle compositing allow at most 1-byte quantization difference, alpha is exact; the full results from QuickJS and V8 must be identical. Failed attempts still retain the original observations and logs.

Another entry point runs an independent HTML/CSS model, using the headless Chromium for this task:

```sh
pnpm runtime:opacity:browser-oracle -- \
  --package <path/to/package.json-with-playwright> \
  --out artifacts/group-opacity-chromium.json
```

It records native computation CSS, real mouse coordinate clicks, geometry, PNG screenshot, and fully decoded RGBA,
and closes the context/browser it created. The HTML model does not load a container and does not represent WeChat WXML execution;
it serves as auxiliary CSS observation and cannot be used as the official DevTools baseline. Neither collector alters
the official cases, GPU, real devices, performance, or near-parity gatekeeping status.

Related rendering contracts: [image resources](images.en.md), [borders and box model](wxss-borders.en.md),
[layout](layout-flow.en.md) and [scrolling and input](scrolling.en.md).
