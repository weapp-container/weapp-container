import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {"index": "src/index.ts", "config": "src/config.ts"},
  format: ["esm"],
  dts: true,
  clean: true,
  target: 'node24',
  shims: true,
  failOnWarn: true,
})
