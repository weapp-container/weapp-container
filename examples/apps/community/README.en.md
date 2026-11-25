# Open-source mini-program examples

[简体中文](README.md) · **English**

This directory contains runnable snapshots curated from upstream open-source repositories for container builds, packaging, and simulator use. The upstream MIT licenses are retained. [`SOURCES.json`](SOURCES.json) records each pinned commit, source directory, and local adaptation.

| Example | Source | Demonstrates |
| --- | --- | --- |
| `miniprogram-demo-text` | Upstream `miniprogram-demo` snapshot | Text list, scroll view, and add/remove interaction |
| `ant-design-button` | Ant Design Mini `3.4.3` | Button variants, disabled/loading states, and container component |
| `taro-blended` | Taro `examples/blended-basic` | Mini-program page and custom component from a blended Taro project |

Run these commands from the repository root to build and run one sample. Replace `<name>` with a directory name from the table.

```sh
pnpm --dir vendor/weapp-vite exec wv build \
  "$PWD/examples/apps/community/<name>" -p weapp \
  --outDir "$PWD/artifacts/community/<name>/raw"
pnpm container:pack -- "artifacts/community/<name>/raw" \
  --out "artifacts/community/<name>/pack" \
  --compiler-commit "$(git -C vendor/weapp-vite rev-parse HEAD)"
cp "examples/apps/community/<name>/LICENSE.upstream" \
  "artifacts/community/<name>/pack/LICENSE.upstream"
cargo run -p container-simulator --features quickjs-native -- \
  dev --project "examples/apps/community/<name>" --surface web
```

The interactive command keeps the simulator development server running and prints a local Web URL. Build output and portable packs go under the ignored `artifacts/` directory. To check build, in-place WXSS reload, JS restart, diagnostics, and recovery, run `pnpm simulator:dev:smoke -- --project "examples/apps/community/<name>"`. Simulator and headless browser checks validate this software runtime path and do not establish WeChat DevTools, GPU, or device compatibility.

The Taro sample is based on the upstream blended-basic mini-program-side files. Navigation to omitted Taro output pages and subpackages was removed, and the repository-pinned `weapp-vite` build is used. The Ant Design Mini sample copies the local dependency closure required by the published `antd-mini@3.4.3` button component. Component directory references were adjusted to lowercase local paths, CSS custom-property fallbacks were expanded to literal values for the container's supported WXSS subset, and the remote icon-font request plus unused Alipay-branded glyph declarations were removed. The text sample retains the upstream component list and scrolling interaction while removing demo navigation and external asset dependencies.
