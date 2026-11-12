#!/usr/bin/env bash
set -euo pipefail

# Compile all host skeletons and explicit feature combinations. Native SDK/device
# validation is intentionally separate and must never be inferred from this smoke.
cargo check -p container-host-web --features wasm,canvas-kit
cargo check -p container-host-desktop --features window,metal,vulkan,direct2d
cargo check -p container-host-android --features android,gles,vulkan,skia-gpu-gles
cargo check -p container-host-ios --features ios,metal,quickjs-native-ios
cargo check -p container-host-harmony --features harmony,arkui
cargo test -p container-render-skia -p container-engine-quickjs -p container-engine-v8
