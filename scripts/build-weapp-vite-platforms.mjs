#!/usr/bin/env node
/**
 * Prepare and run the pinned upstream platform build gate.
 *
 * The submodule keeps generated `dist` files ignored, so a clean checkout
 * needs its package workspace built before the E2E command can load the CLI.
 * Both steps stay in one process boundary and are deliberately serial: the
 * upstream tests own the E2E/DevTools lease and must not be overlapped.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const submodule = path.join(root, 'vendor', 'weapp-vite')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const env = { ...process.env, E2E_FULL_MATRIX: '1' }

function run(args) {
  const result = spawnSync(pnpm, args, {
    cwd: submodule,
    env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    return false
  }
  return true
}

// Install is safe to repeat and makes the entrypoint reproducible on CI and
// after a fresh clone. The lockfile belongs to the submodule and is never
// modified by this command.
if (!run(['install', '--frozen-lockfile'])) process.exit(process.exitCode)
// Build every package selected by upstream's core build graph. This produces
// the ignored dist files consumed by weapp-vite, wevu and the automator.
if (!run(['run', 'build:pkgs'])) process.exit(process.exitCode)
if (!run(['run', 'e2e:platform:build'])) process.exit(process.exitCode)
