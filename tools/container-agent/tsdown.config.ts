import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    target: 'node24',
    shims: true,
    failOnWarn: true,
    checks: { legacyCjs: false },
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    target: 'node24',
    shims: true,
    failOnWarn: true,
  },
])
