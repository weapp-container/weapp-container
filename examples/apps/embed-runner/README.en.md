<a id="应用嵌入示例"></a>
# App embedding example

[简体中文](README.md) · **English**


`embed-runner` is a small application process that embeds the same runtime
boundary used by the Web, desktop and native host adapters. It loads a packed
mini-program from an asset directory, starts the app, sends one capability
request and reads one complete RGBA snapshot. A real Activity, view controller,
ArkUI Ability or browser worker can use this sequence with its own surface
presenter.

Run it after building the reference app pack:

```sh
cargo run --manifest-path examples/apps/embed-runner/Cargo.toml -- \
  artifacts/reference-app/pack artifacts/reference-app/embed-report.json
```

The package script accepts the usual pnpm separator as well:

```sh
pnpm embed:reference -- \
  artifacts/reference-app/pack artifacts/reference-app/embed-report.json
```

The runner ignores that standalone `--` so the two forms are equivalent.

The output is a diagnostic artifact. It does not claim native GPU, emulator or
WeChat DevTools conformance. Platform hosts should replace the sample's
`render_snapshot()` read with their one-shot CanvasKit/Skia/Metal/ArkUI upload,
while keeping the bridge batch and resource ownership rules unchanged.
