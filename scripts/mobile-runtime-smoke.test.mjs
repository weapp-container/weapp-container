import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('Android smoke does not run an already installed package after APK installation fails', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-mobile-smoke-install-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const commands = join(directory, 'commands.jsonl')
  const adb = join(directory, 'adb')
  const apk = join(directory, 'release-unsigned.apk')
  writeFileSync(apk, 'unsigned APK fixture')
  writeFileSync(adb, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_ADB_COMMANDS, JSON.stringify(args) + '\\n');
if (args[0] === 'devices') console.log('List of devices attached\\nemulator-owned\\tdevice');
else if (args.includes('install')) { console.error('INSTALL_PARSE_FAILED_NO_CERTIFICATES'); process.exit(1); }
`, { mode: 0o755 })
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}')

  const result = spawnSync(process.execPath, ['scripts/mobile-runtime-smoke.mjs', '--platform', 'android',
    '--android-apk', apk], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, WEAPP_CONTAINER_ANDROID_SERIAL: 'emulator-owned', TEST_ADB_COMMANDS: commands },
  })
  assert.equal(result.status, 0, result.stderr)
  const aggregate = JSON.parse(result.stdout)
  const android = aggregate.platforms[0]
  assert.equal(android.status, 'blocked')
  assert.equal(android.gate, 'blocked-install')
  assert.equal(android.probes.length, 2)
  const invoked = readFileSync(commands, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(invoked.map(args => args[0]), ['devices', '-s'])
  assert.equal(invoked.some(args => args.includes('start') || args.includes('force-stop') || args.includes('-c')), false)
})

test('Android smoke blocks non-debuggable APKs before clearing receipts or launching', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-mobile-smoke-receipt-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const commands = join(directory, 'commands.jsonl')
  const adb = join(directory, 'adb')
  const apk = join(directory, 'release-debug-signed.apk')
  writeFileSync(apk, 'signed release APK fixture')
  writeFileSync(adb, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_ADB_COMMANDS, JSON.stringify(args) + '\\n');
if (args[0] === 'devices') console.log('List of devices attached\\nemulator-owned\\tdevice');
else if (args.includes('run-as') && args.at(-1) === 'id') { console.error('package not debuggable'); process.exit(1); }
`, { mode: 0o755 })
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}')

  const result = spawnSync(process.execPath, ['scripts/mobile-runtime-smoke.mjs', '--platform', 'android',
    '--android-apk', apk], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, WEAPP_CONTAINER_ANDROID_SERIAL: 'emulator-owned', TEST_ADB_COMMANDS: commands },
  })
  assert.equal(result.status, 0, result.stderr)
  const aggregate = JSON.parse(result.stdout)
  const android = aggregate.platforms[0]
  assert.equal(android.status, 'blocked')
  assert.equal(android.gate, 'blocked-runtime-receipt')
  assert.equal(android.probes.length, 3)
  const invoked = readFileSync(commands, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(invoked.map(args => args[0]), ['devices', '-s', '-s'])
  assert.equal(invoked.some(args => args.includes('start') || args.includes('force-stop') || args.includes('-c')
    || args.includes('portable-pack-execution.json')), false)
})
