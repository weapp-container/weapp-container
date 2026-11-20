import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const smoke = resolve(root, 'scripts/mobile-runtime-smoke.mjs')

test('mobile runtime smoke help exits before probing or mutating a target', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-mobile-smoke-help-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const bin = join(directory, 'bin')
  const marker = join(directory, 'adb-was-called')
  const adb = join(bin, 'adb')
  const path = process.env.PATH || ''
  const markerLiteral = JSON.stringify(marker)
  const source = `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${markerLiteral}, 'called')\n`

  mkdirSync(bin)
  writeFileSync(adb, source)
  chmodSync(adb, 0o755)

  for (const flag of ['--help', '-h']) {
    const result = spawnSync(process.execPath, [smoke, flag], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${path}` },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Usage: node scripts\/mobile-runtime-smoke\.mjs/)
  }

  assert.equal(existsSync(marker), false)
})
