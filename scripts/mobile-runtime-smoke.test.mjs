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

test('Harmony smoke requires correlated runtime, direct surface and GPU context evidence', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-mobile-smoke-harmony-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  const commands = join(directory, 'commands.jsonl')
  const hdc = join(directory, 'hdc')
  const hap = join(directory, 'smoke.hap')
  const digest = 'a'.repeat(64)
  const logs = [
    `WEAPP_CONTAINER_SMOKE app.init ${JSON.stringify({ messages: [{ op: 'app.init', kind: 'response', payload: { ok: true, engine: 'quickjs', engineProviderAvailable: true, loadedModules: 1, manifest: { integrity: digest } } }] })}`,
    `WEAPP_CONTAINER_SMOKE render.commit ${JSON.stringify({ messages: [{ op: 'render.commit', kind: 'response', payload: { ok: true, frameId: 1, backend: 'skia-gpu-pending' } }] })}`,
    `WEAPP_CONTAINER_SMOKE render.snapshot ${JSON.stringify({ frame_id: 1, width: 1, height: 1, stride: 4, format: 'rgba8-premultiplied', pixelCount: 4, sha256: digest, pixels: [1, 2, 3, 255] })}`,
    `WEAPP_CONTAINER_SMOKE canvas.draw ${JSON.stringify({ messages: [{ op: 'api.call', kind: 'response', payload: { ok: true, name: 'wx.canvas.draw', result: { canvasId: 'main' } } }] })}`,
    `WEAPP_CONTAINER_SMOKE canvas.snapshot ${JSON.stringify({ frame_id: 1, width: 1, height: 1, stride: 4, format: 'rgba8-premultiplied', pixels: [10, 20, 30, 255] })}`,
    `WEAPP_CONTAINER_SMOKE api.call ${JSON.stringify({ messages: [{ op: 'api.call', kind: 'response', payload: { ok: true, result: true } }] })}`,
    `WEAPP_CONTAINER_SURFACE_PROBE ${JSON.stringify({ schemaVersion: 1, status: 'passed', hostSurfaceAttached: true, containerSurfaceAttached: true, gpuSurface: true, rendererBackend: 'skia-gpu-gles', width: 1, height: 1, evidenceBoundary: 'runtime-skia-gles-framebuffer' })}`,
    `WEAPP_CONTAINER_GPU_PROBE ${JSON.stringify({ schemaVersion: 1, status: 'passed', contextCreated: true, hardwareAccelerated: false, containerSurfaceAttached: false, evidenceBoundary: 'device-context-only' })}`,
  ].join('\n')
  writeFileSync(hap, 'HAP fixture')
  writeFileSync(hdc, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_HDC_COMMANDS, JSON.stringify(args) + '\\n');
if (args[0] === 'list' && args[1] === 'targets') console.log('emulator-owned');
else if (args.includes('param') && args.at(-1) === 'const.product.model') console.log('emulator');
else if (args.includes('param') && args.at(-1) === 'const.product.name') console.log('emulator');
else if (args.includes('hilog') && args.at(-1) === '-x') {
  const commands = readFileSync(process.env.TEST_HDC_COMMANDS, 'utf8').trim().split('\\n').map(JSON.parse);
  const start = commands.find(command => command.includes('start'));
  const sessionKey = start.indexOf('weappContainerSessionId');
  const sessionId = start[sessionKey + 1];
  console.log(process.env.TEST_HDC_LOGS + '\\nWEAPP_CONTAINER_EXECUTION_RECEIPT ' + JSON.stringify({ path: '/data/storage/el2/base/files/portable-pack-execution.json', sessionId }));
}
`, { mode: 0o755 })
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}')

  const output = join(directory, 'smoke.json')
  const result = spawnSync(process.execPath, ['scripts/mobile-runtime-smoke.mjs', '--platform', 'harmony', '--out', output], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      WEAPP_CONTAINER_HARMONY_HAP: hap,
      WEAPP_CONTAINER_HARMONY_BUNDLE: 'com.example.smoke',
      WEAPP_CONTAINER_HARMONY_ABILITY: 'EntryAbility',
      WEAPP_CONTAINER_HARMONY_TARGET: 'emulator-owned',
      WEAPP_CONTAINER_HARMONY_WAIT_MS: '20',
      TEST_HDC_COMMANDS: commands,
      TEST_HDC_LOGS: logs,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  const aggregate = JSON.parse(result.stdout)
  const harmony = aggregate.platforms[0]
  assert.equal(harmony.status, 'passed')
  assert.deepEqual(harmony.missingOperations, [])
  assert.deepEqual(harmony.failedChecks, [])
  assert.equal(harmony.surfaceProbe.containerSurfaceAttached, true)
  assert.equal(harmony.gpuProbe.contextCreated, true)
  assert.equal(harmony.gpuProbe.hardwareAccelerated, false)
  assert.equal(harmony.executionTarget.kind, 'official-simulator')
  assert.equal(harmony.targetInfo.kind, 'official-simulator')
  const invoked = readFileSync(commands, 'utf8').trim().split('\n').map(JSON.parse)
  const start = invoked.find(args => args.includes('start'))
  assert.ok(start)
  assert.ok(start.includes('--pb') && start.includes('weappContainerSmoke') && start.includes('true'))
  assert.ok(start.includes('--ps') && start.includes('weappContainerSessionId'))
  assert.ok(start.includes('--ps') && start.includes('weappContainerFixtureId') && start.includes('portable-pack-reference-v1'))
  assert.ok(start.includes('--ps') && start.includes('weappContainerEngine') && start.includes('quickjs'))
  assert.ok(invoked.some(args => args.includes('file') && args.includes('recv') && args.includes('/data/storage/el2/base/files/portable-pack-execution.json')))
  assert.ok(invoked.some(args => args.includes('force-stop')))
  assert.equal(invoked.some(args => args.includes('hilog') && args.includes('-r')), false)
})
