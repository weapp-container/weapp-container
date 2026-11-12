# Desktop native surface smoke

This standalone example creates one `winit` window, attaches a
`softbuffer::Surface`, presents a deterministic 2×2 RGBA frame and emits a
JSON report. It is intended for macOS, Windows and Linux machines with a
usable graphical session:

```bash
pnpm host:desktop:surface -- --out artifacts/desktop/native-window-surface.json
```

The report records `nativeSurface: true`, `presentedFrame: true`, the pixel
SHA-256 and `surfaceBackend: "softbuffer-raster"`. `gpuSurface` remains
`false` because softbuffer is a CPU presentation path. A headless environment
is reported as `blocked`, and must not be interpreted as a GPU or device pass.
