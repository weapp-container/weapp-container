<a id="逻辑帧和物理渲染目标"></a>
# Logical frames and physical render targets

[简体中文](renderer-target-scaling.md) · **English**


Committed render trees use the logical dimensions in `RenderFrame.viewport`.
Host-owned GLES framebuffers and Metal drawable textures supply physical pixel
dimensions. Both adapters draw through the same `draw_frame_to_target` helper,
which scales each axis by physical target size divided by logical viewport
size, then restores the canvas transform.

This is required on a Retina display: a 375-point viewport presented through a
1125-pixel drawable needs a 3× transform. Drawing with an identity transform
would put the page in the upper-left third of that drawable. Independent X/Y
ratios also handle a target whose aspect ratio differs during a resize. A zero
logical dimension clears the target without drawing; a positive fractional
dimension is used as supplied rather than clamped to one.

The regression tests execute this shared drawing helper on a CPU Skia surface
and read actual RGBA pixels. Four colored quadrants must fill every pixel at
2×, 3×, nonuniform scaling, and fractional viewport sizes. A subsequent 1-pixel
physical mark checks that the helper restores its transform. A separate test
checks the empty viewport behavior.

```bash
cargo test -p container-render-skia --features skia-backend --locked native_target_scaling
```

These CPU raster tests validate the coordinate transform and readback. They do
not prove GPU execution, drawable presentation, screenshot equivalence, or
device behavior; those require the corresponding host evidence.
