import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {"index": "src/index.ts", "cli": "src/cli.ts", "json-integrity": "src/json-integrity.mjs", "rendering": "src/rendering.mjs", "wxs-compiler": "src/wxs-compiler.ts", "wxs-dependencies": "src/wxs-dependencies.ts", "modern-view": "src/modern-view.ts"},
  format: ["esm"],
  dts: true,
  clean: true,
  target: 'node24',
  shims: true,
  failOnWarn: true,
})
