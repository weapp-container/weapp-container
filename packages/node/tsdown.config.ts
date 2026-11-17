import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {"index": "src/index.ts", "artifact": "src/artifact.ts"},
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: 'node24',
  shims: true,
  failOnWarn: true,
  // CJS is an explicitly supported consumer entry.
  checks: { legacyCjs: false },
})
