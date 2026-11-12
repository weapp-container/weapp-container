#!/usr/bin/env node
/**
 * Exercise the Android native build recovery path with a deterministic fake
 * CMake executable. The first configure fails with the stale Ninja database
 * diagnostic; the second configure and build succeed. Rust still builds the
 * real Android cdylib, so this test does not turn a fake platform build into
 * device or APK conformance evidence.
 */
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const temp = mkdtempSync(resolve(tmpdir(), 'weapp-native-recovery-'))
const fakeBin = resolve(temp, 'bin')
const state = resolve(temp, 'cmake-state')
const out = resolve(temp, 'report.json')
mkdirSync(fakeBin, { recursive: true })

const fakeCmake = resolve(fakeBin, 'cmake')
writeFileSync(fakeCmake, `#!/bin/sh
set -eu
if printf '%s\\n' "$@" | grep -q -- '--build'; then
  exit 0
fi
if [ ! -f "${state}" ]; then
  : > "${state}"
  echo 'ninja: error: failed recompaction: No such file or directory' >&2
  exit 1
fi
exit 0
`, 'utf8')
chmodSync(fakeCmake, 0o755)

try {
  const result = spawnSync(process.execPath, [
    resolve(root, 'scripts/build-native-hosts.mjs'),
    '--build',
    '--platform',
    'android',
    '--out',
    out,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    },
    timeout: 10 * 60 * 1000,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`native build recovery command exited ${result.status}\n${result.stdout}\n${result.stderr}`)
  }
  const report = JSON.parse(readFileSync(out, 'utf8'))
  const platform = report.platforms?.find(entry => entry.platform === 'android')
  if (!platform || platform.status !== 'passed') {
    throw new Error(`expected Android platform to pass: ${JSON.stringify(platform)}`)
  }
  const recovery = platform.appIntegration?.recovery
  if (!recovery || recovery.action !== 'remove-stale-cmake-build-and-reconfigure') {
    throw new Error(`missing recovery evidence: ${JSON.stringify(platform.appIntegration)}`)
  }
  if (recovery.initialConfigure?.status !== 'failed' || recovery.retryConfigure?.status !== 'passed') {
    throw new Error(`unexpected configure recovery statuses: ${JSON.stringify(recovery)}`)
  }
  if (platform.appIntegration.configure?.status !== 'passed' || platform.appIntegration.build?.status !== 'passed') {
    throw new Error(`final Android integration did not pass: ${JSON.stringify(platform.appIntegration)}`)
  }
  process.stdout.write(`native build recovery smoke passed (${out})\n`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
