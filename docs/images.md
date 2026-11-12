# Packaged images

`image` uses a shared decoded resource table in the committed `RenderFrame`.
The runtime resolves `src` against the declaring WXML document, including
custom components and projected slots. Root paths start at the portable app
root. It reads only manifest-declared assets and SHA-256-verified blobs;
images never cause a renderer to read the host filesystem or fetch a URL.

Static PNG, JPEG and WebP are decoded by the pinned Rust `image` dependency.
Repeated uses of the same encoded SHA share an `Arc<ImageResource>`, including
frame clones. Generated frames pass directly to the renderer without a JSON
serialization/deserialization round trip. Resource authorization still belongs
to the current manifest and session; development manifest replacement requires
freshly verified resources.

The frame wire format adds an optional `images` map. Each value is
`{width, height, pixels}`, where pixels are tightly packed, straight RGBA8 bytes.
`RenderNode.image` is `{resource, mode}`; resource names the exact map key.
Manifest-generated keys are `sha256:<encoded asset hash>`. Raw-frame producers
are responsible for their own pixel provenance: a resource name alone is not
proof of an encoded asset's authenticity. Legacy frames without images retain
their previous wire format.

All 14 mode strings are recognized: `scaleToFill`, `aspectFit`, `aspectFill`,
`widthFix`, `heightFix`, `top`, `bottom`, `center`, `left`, `right`, `top left`,
`top right`, `bottom left` and `bottom right`. Aspect modes preserve the source
ratio, crop modes align original pixels, and width/height fix modes carry the
intrinsic ratio through the layout solver. An image's default content box is
300 × 225 logical pixels. Explicit dimensions, percentages, flex constraints,
borders and padding feed the same geometry used by selectors and input.

Software, native Skia and CanvasKit use nearest sampling and clip image content
at the content box and the node's outer rounded boundary. Transforms, ancestor
overflow and scrolling apply to images. An image keeps its intrinsic RGBA
alpha inside the painted subtree; the node's and ancestors' `opacity` values
apply to their complete groups, after backgrounds, borders, images, text and
descendants have been combined. They are not multiplied into every image or
primitive independently. Nested group composition and its resource budget are
documented in [the opacity contract](compositing.md). This sampling choice is
deterministic local behavior; official interpolation quality and exact
DevTools pixels remain unverified.

One encoded asset is limited to 8 MiB, each dimension to 8,192, and one decoded
image to 16,777,216 pixels (64 MiB RGBA). A frame accepts at most 1,024 resources
and 128 MiB total image bytes. Invalid dimensions, lengths, resource IDs or
references reject before replacing the accepted frame. Runtime decode caching
is bounded and session-local. Rejected candidates keep the prior pixels,
selector geometry and resource authorization usable.

These limits bound encoded input and accepted decoded payloads. Codec scratch
memory and JSON parsing of explicit raw frames are separate allocations; this
is not a measured peak-memory or process RSS limit.

This is the packaged static-image boundary. Remote/data/file/provider URLs,
animated PNG/WebP/GIF, SVG, asynchronous `load`/`error` events, lazy loading and
image menus still require implementations and official observations. Component
and image-subproperty discovery through `wx.canIUse` is not yet registered;
unknown feature strings continue to return false. Requests
for those behaviors fail explicitly rather than being treated as successful
image loads. Empty `src` retains an empty image box. A corrupt packaged image
or missing declared blob is a render error; a provider/format/event capability
outside this boundary returns `ERR_UNSUPPORTED_CAPABILITY`.

Run the development fixture after preparing the pinned compiler as described
in [the simulator guide](simulator.md):

```bash
pnpm simulator:dev -- --project examples/apps/image-contract-app --surface web
```

The fixture keeps the original `weapp-vite` output loadable by official DevTools.
The container owns portable packing, resource verification and rendering.
There are no added chunk, subpackage or upstream compiler changes.

For native dual-engine validation, build the simulator and run:

```bash
cargo build -p container-simulator --features v8-native --locked --jobs 2
pnpm runtime:image:smoke -- \
  --simulator-bin target/debug/weapp-simulator \
  --compiler-root <verified-pinned-compiler> \
  --compiler-dist-hashes <compiler-dist-sha256.json> \
  --out artifacts/images.json
```

The smoke builds actual artifacts, verifies unchanged compiler/output bytes,
executes the same Page handlers in QuickJS and V8, compares all mode geometry
and pixel samples, and checks a source swap, rejected remote source, retained
frame and recovery. Resource transmission remains one table per frame; no
per-node Rust/JS bridge has been added. Performance budgets require separate
measurements. These local checks do not change official case, GPU or device
acceptance statuses.

Inventory case `view-image-static-001` maps to this smoke and
`crates/container-runtime/tests/image_render.rs`; its local evidence does not
promote the `view.wxml-wxss` group's partial support status.
