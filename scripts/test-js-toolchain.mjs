// Portable source/contract checks. Device, browser and release acceptance keep
// their explicit commands; node:test never runs through Vitest discovery.
import { spawnSync } from 'node:child_process'

const files = [
  'ci-plan', 'check-open-source', 'check-doc-links', 'verify-submodule',
  'sdk-licenses', 'sdk-native-build', 'check-toolchain', 'check-product-naming',
  'core-api-inventory', 'host-api-matrix', 'host-api-matrix-io',
  'api-completion-compat', 'api-owner-context', 'nexttick-api-owner',
  'nexttick-contract', 'route-transaction', 'scheduler-canvas-owner',
  'scheduler-framework-boundaries', 'turn-scheduler-candidate',
  'harmony-reference-services', 'modern-view-host-pack',
  'conformance-fixture-build', 'runtime-artifacts-migration', 'runtime-release',
].map(name => `scripts/${name}.test.mjs`)
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
