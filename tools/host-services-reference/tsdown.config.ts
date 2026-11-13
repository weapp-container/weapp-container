import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {"index": "src/index.ts", "cli": "src/cli.ts", "service": "src/service.ts", "server": "src/server.ts", "crypto": "src/crypto.ts", "consent-v2": "src/consent-v2.ts", "providers": "src/providers.ts", "errors": "src/errors.ts"},
  format: ["esm"],
  dts: true,
  clean: true,
  target: 'node24',
  shims: true,
  failOnWarn: true,
})
