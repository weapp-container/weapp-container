import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { inspectBuildReceipt, inspectForegroundLayout, parseArgs, parseLiveStates, processIdentity, runHarmonyAppSmoke, validateObservation } from './harmony-app-smoke.mjs'

const bundle = 'com.sonofmagic.weapp.container.smoke1234abcd'
const uuid = '12345678-abcd-1234-abcd-123456789abc'
const sessionId = `harmony-smoke-${uuid.replace(/-/g, '')}`
const expected = { sessionId, engine: 'quickjs', route: 'pages/home/index' }
const clone = value => JSON.parse(JSON.stringify(value))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const success = text => ({ status: 0, stdout: Buffer.from(text || ''), stderr: Buffer.alloc(0) })
const failed = text => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(text) })
const initialTrace = ['app:launch', 'app:show', 'page:load', 'page:show', 'page:ready']
const log = (state, pid = 3456, traced = false) => `10-21 09:15:31.123 ${pid} ${pid} I A03d00/JSAPP: ${traced ? '[a92ab10cf51f9db, 10a105c, 2b0c4b9] ' : ''}WEAPP_CONTAINER_LIVE_STATE ${JSON.stringify(state)}\n`
// Exact app-owned resumed record from the 2026-10-21 OS interaction receipt.
// The failed receipt is immutable; this fixture only documents its log form.
const actualResumedLog = '10-21 08:53:09.178 27917 27917 I A03d00/JSAPP: [a92ab10cf51f9db, 10a105c, 2b0c4b9] WEAPP_CONTAINER_LIVE_STATE {"schemaVersion":1,"sessionId":"harmony-smoke-c5c798830c2848b38bf663c94301e22f","engine":"quickjs","status":"ready","foreground":true,"revision":7,"route":"pages/home/index","frameId":5,"presentedFrameId":5,"presentationSequence":5,"width":377,"height":685,"surfaceWidth":1320,"surfaceHeight":2398,"page":{"data":{"count":1,"lifecycleTrace":["app:launch","app:show","page:load","page:show","page:ready","app:hide","page:hide","app:show","page:show"],"microtaskCount":1,"timerCount":1,"windowInfo":null},"id":1,"route":"pages/home/index"},"viewRevision":11,"diagnostics":[],"nativeFonts":{"families":["HarmonyOS Sans","HarmonyOS Sans SC"],"installedFaces":2},"evidenceBoundary":"sample-runtime-observation"}'

function observation() {
  return { schemaVersion: 1, ...expected, status: 'ready', foreground: true, revision: 2, frameId: 1,
    presentedFrameId: 1, presentationSequence: 1, width: 377, height: 685, surfaceWidth: 1320, surfaceHeight: 2398,
    page: { id: 1, route: expected.route, data: { count: 0, timerCount: 0, microtaskCount: 0, lifecycleTrace: initialTrace, windowInfo: null } },
    viewRevision: 4, diagnostics: [], evidenceBoundary: 'sample-runtime-observation' }
}

function layout(focusedBundle = bundle, withInputPlane = true) {
  // Mirrors the unfiltered OS dump shape observed on 2026-10-21: the root owns
  // focus; its XComponent has empty id/key and descendants inherit the bundle.
  return { attributes: {}, children: [
    { attributes: { bundleName: focusedBundle, focused: 'true', visible: 'true', enabled: 'true', type: 'root', bounds: '[0,137][1320,2856]' }, children: [
      { attributes: { focused: 'true', visible: 'true', enabled: 'true', type: 'Column' }, children: [
        { attributes: { id: '', key: '', accessibilityId: '7', type: 'XComponent', focused: 'false', visible: 'true', enabled: 'true', bounds: '[0,360][1320,2758]' } },
        ...(withInputPlane ? [{ attributes: { id: 'weapp-container-input', type: 'Column', focused: 'false', visible: 'true', enabled: 'true', bounds: '[0,360][1320,2758]' } }] : []),
      ] },
    ] },
    { attributes: { bundleName: 'com.ohos.sceneboard', focused: 'false', visible: 'true', enabled: 'true', type: 'root' } },
  ] }
}

function png() {
  const crc32 = bytes => {
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(data.length + 12)
    bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4); data.copy(bytes, 8)
    bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4)
    return bytes
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(2 * (1 + 2 * 4)))), chunk('IEND', Buffer.alloc(0))])
}

async function fixture(verify, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'weapp-harmony-app-'))
  const hap = join(root, 'input.hap'), buildReceipt = join(root, 'build-report.json'), outDir = join(root, 'run')
  const bytes = Buffer.from('instrumented task HAP bytes')
  writeFileSync(hap, bytes)
  const build = { schemaVersion: 1, scope: 'harmony-hap-build', status: 'passed', bundle,
    artifact: { sha256: sha256(bytes) }, sourceFiles: [{ path: 'source.ets', sha256: 'a'.repeat(64) }],
    rustLibrary: { sha256: 'b'.repeat(64) } }
  if (overrides.mutateBuild) overrides.mutateBuild(build)
  writeFileSync(buildReceipt, JSON.stringify(build))
  let clock = 0, installed = overrides.preexisting || false, running = false, pid = 3456, state = null, timerDue = false
  const remote = new Map(), calls = [], emitted = []
  const controller = new AbortController()
  function publish(traced = false) { state.revision += 1; emitted.push(log(clone(state), pid, traced)) }
  function execute(command, args, options) {
    calls.push({ command, args: [...args], options })
    if (command === 'unzip') {
      assert.deepEqual(args, ['-p', hap, 'module.json'])
      return success(JSON.stringify({ app: { bundleName: overrides.packagedBundle || bundle }, module: { name: 'entry' } }))
    }
    assert.equal(command, 'test-hdc')
    assert.deepEqual(args.slice(0, 2), ['-t', 'borrowed-test-target'])
    const argv = args.slice(2), text = argv.join(' ')
    if (text === 'shell bm dump -a') return success(`all bundle names:\ncom.example.user\n${installed ? bundle : ''}\n`)
    if (text === `install ${hap}`) {
      installed = true
      return success(overrides.installFailureText ? 'error: install permission denied' : 'install bundle successfully.')
    }
    if (argv.slice(0, 4).join(' ') === 'shell aa start -a') {
      assert.equal(installed, true)
      if (!running) {
        assert.ok(argv.includes('weappContainerSessionId'))
        assert.equal(argv[argv.indexOf('weappContainerSessionId') + 1], sessionId)
        assert.equal(argv[argv.indexOf('weappContainerEngine') + 1], 'quickjs')
        running = true
        state = observation()
        emitted.push(log(clone(state), pid))
      } else {
        assert.equal(argv.includes('--ps'), false, 'resume must not replace launch parameters')
        if (overrides.restartOnResume) pid += 1
        state.foreground = true; state.status = 'ready'; state.frameId += 1
        state.presentedFrameId = state.frameId; state.presentationSequence += 1
        state.page.data.lifecycleTrace = [...state.page.data.lifecycleTrace, 'app:show', 'page:show']
        publish(Boolean(overrides.traceOnResume))
      }
      return success('start ability successfully.')
    }
    if (text === `shell pidof ${bundle}`) return success(running ? `${pid}\n` : '')
    if (argv[0] === 'shell' && argv[1] === 'cat' && argv[2] === `/proc/${pid}/stat`) {
      const fields = Array(20).fill('0'); fields[19] = '912345'
      return success(`${pid} (task process name) ${fields.join(' ')}\n`)
    }
    if (text === `shell hilog -x -P ${pid}`) {
      const source = overrides.onlyForeignSession ? emitted.map(line => line.replaceAll(sessionId, 'old-session')).join('') : emitted.join('')
      return success(log({ ...observation(), sessionId: 'unrelated' }, 9911) + source)
    }
    if (argv.slice(0, 4).join(' ') === 'shell uitest dumpLayout -p') {
      assert.deepEqual(argv.slice(5), ['-m', 'true'], 'foreground proof must be an unfiltered OS layout')
      remote.set(argv[4], Buffer.from(JSON.stringify(layout(overrides.foregroundBundle || bundle))))
      return success(`Dump saved to ${argv[4]}`)
    }
    if (argv.slice(0, 4).join(' ') === 'shell uitest screenCap -p') {
      let bytes = overrides.corruptPng ? Buffer.from('not a screenshot') : png()
      if (overrides.truncatePng) bytes = bytes.subarray(0, 33)
      if (overrides.corruptPngChecksum) { bytes = Buffer.from(bytes); bytes[29] ^= 1 }
      remote.set(argv[4], bytes)
      return success(`Screen saved to ${argv[4]}`)
    }
    if (argv[0] === 'file' && argv[1] === 'recv') {
      assert.ok(remote.has(argv[2]), `unknown remote input ${argv[2]}`)
      writeFileSync(argv[3], remote.get(argv[2]))
      if (overrides.restartDuringCapture && argv[2].endsWith('.png')) pid += 1
      return success('FileTransfer finish')
    }
    if (argv.slice(0, 4).join(' ') === 'shell uitest uiInput click') {
      assert.deepEqual(argv.slice(4), ['250', '520'])
      assert.equal(state.foreground, true)
      if (!overrides.noTapUpdate) {
        state.page.data.count += 1; state.frameId += 1; state.presentedFrameId = state.frameId; state.presentationSequence += 1
        publish(); timerDue = true
      }
      if (overrides.abortAfterClick) controller.abort()
      return success(overrides.clickRejected ? 'Error: injected OS input rejection' : 'No Error')
    }
    if (text === 'shell uitest uiInput keyEvent Home') {
      state.foreground = false; state.status = 'suspended'
      state.page.data.lifecycleTrace = [...state.page.data.lifecycleTrace, 'app:hide', 'page:hide']
      publish()
      return success('No Error')
    }
    if (text === `shell aa force-stop ${bundle}`) { running = false; return success('force stop process successfully.') }
    if (text === `uninstall ${bundle}`) {
      if (!overrides.uninstallFailure) installed = false
      return success(overrides.uninstallFailure ? 'error: uninstall failed' : 'uninstall app successfully.')
    }
    if (argv.slice(0, 3).join(' ') === 'shell rm -f') {
      assert.match(argv[3], /^\/data\/local\/tmp\/weapp-harmony-12345678abcd1234abcd123456789abc-/)
      if (!overrides.remoteCleanupFailure) remote.delete(argv[3])
      return success('')
    }
    if (argv.slice(0, 2).join(' ') === 'shell ls') return remote.has(argv[2]) ? success(`${argv[2]}\n`) : failed(`ls: ${argv[2]}: No such file or directory`)
    assert.fail(`Unexpected or unsafe command: ${command} ${args.join(' ')}`)
  }
  const wait = async ms => {
    clock += ms
    if (timerDue && !overrides.noTimerUpdate) {
      timerDue = false
      state.page.data.timerCount += 1; state.page.data.microtaskCount += 1
      state.frameId += 1; state.presentedFrameId = state.frameId; state.presentationSequence += 1
      publish()
    }
  }
  try {
    const options = { target: 'borrowed-test-target', hap, buildReceipt, bundle, outDir, tapX: '250', tapY: '520',
      timeoutMs: '500', pollMs: '50', hdc: 'test-hdc', ...(overrides.options || {}) }
    await verify({ options, execute, wait, now: () => clock, uuid: () => uuid, signal: controller.signal,
      calls, root, outDir, buildReceipt, hap, remote, get installed() { return installed } })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('Harmony argument parsing requires explicit target, unique bundle and coordinates, never chooses a device', async () => {
  assert.deepEqual(parseArgs(['--target', 'device', '--engine', 'v8']), { target: 'device', engine: 'v8' })
  assert.throws(() => parseArgs(['--target', 'x', '--target', 'y']), /Duplicate/)
  assert.throws(() => parseArgs(['--unknown', 'x']), /Unknown/)
  await fixture(async f => {
    for (const options of [{ target: '' }, { bundle: 'com.example.user' }, { tapX: '-1' }, { timeoutMs: '0' }, { engine: 'fallback' }]) {
      await assert.rejects(() => runHarmonyAppSmoke({ ...f.options, ...options }, f), /Missing required|unique|physical|timeout|engine/)
    }
    assert.equal(f.calls.length, 0)
  })
})

test('Harmony log parser binds complete live records to both exact PID and session', () => {
  const state = observation()
  const text = log(state) + log(state, 1111) + log({ ...state, sessionId: 'old-session' })
    + '10-21 09:15:31.123 3456 3456 I A03d00/JSAPP: WEAPP_CONTAINER_LIVE_STATE {"sessionId":\n'
  assert.deepEqual(parseLiveStates(text, 3456, sessionId), [state])
  assert.equal(parseLiveStates(`WEAPP_CONTAINER_LIVE_STATE ${JSON.stringify(state)}`, 3456, sessionId).length, 0)
})

test('Harmony real resumed HiLog trace tuple retains exact PID, session and complete observation identity', () => {
  const actualSession = 'harmony-smoke-c5c798830c2848b38bf663c94301e22f'
  const parsed = parseLiveStates(actualResumedLog, 27917, actualSession)
  assert.equal(parsed.length, 1)
  const state = validateObservation(parsed[0], { sessionId: actualSession, engine: 'quickjs', route: 'pages/home/index' })
  assert.equal(state.revision, 7)
  assert.equal(state.status, 'ready')
  assert.equal(state.foreground, true)
  assert.deepEqual([state.page.data.count, state.page.data.timerCount, state.page.data.microtaskCount], [1, 1, 1])
  assert.deepEqual(state.page.data.lifecycleTrace.slice(-2), ['app:show', 'page:show'])
  assert.equal(parseLiveStates(actualResumedLog, 27918, actualSession).length, 0)
  assert.equal(parseLiveStates(actualResumedLog, 27917, 'another-session').length, 0)
  assert.equal(parseLiveStates(actualResumedLog.replace('A03d00/JSAPP:', 'A03d00/OTHER:'), 27917, actualSession).length, 0)
})

test('Harmony optional trace grammar rejects pseudo markers and arbitrary prefixes rather than scanning for evidence', () => {
  const state = observation()
  const ordinary = log(state).trimEnd()
  const traced = log(state, 3456, true).trimEnd()
  for (const line of [
    ordinary.replace(': WEAPP_CONTAINER', ': unrelated WEAPP_CONTAINER'),
    traced.replace('[a92ab10cf51f9db, 10a105c, 2b0c4b9]', '[arbitrary, trace, text]'),
    traced.replace('[a92ab10cf51f9db, 10a105c, 2b0c4b9]', '[a92ab10cf51f9db, 10a105c]'),
    traced.replace('[a92ab10cf51f9db, 10a105c, 2b0c4b9]', '[a92ab10cf51f9db00, 10a105c, 2b0c4b9]'),
    traced.replace('[a92ab10cf51f9db, 10a105c, 2b0c4b9]', '[a92ab10cf51f9db, 10a105c00, 2b0c4b9]'),
    traced.replace('] WEAPP_CONTAINER', '] untrusted WEAPP_CONTAINER'),
    traced.replace('WEAPP_CONTAINER_LIVE_STATE', 'PREFIX_WEAPP_CONTAINER_LIVE_STATE'),
    ordinary.replace('A03d00/JSAPP:', 'A03d00/JSAPP-fake:'),
    ordinary.replace(' I ', ' E '),
    `prefix ${ordinary}`, `${ordinary} trailing text`,
    `10-21 09:15:31.123 3456 3456 I A03d00/JSAPP: ${JSON.stringify({ text: ordinary })}`,
  ]) assert.equal(parseLiveStates(line, 3456, sessionId).length, 0, line)
  assert.equal(parseLiveStates(`${ordinary}\n${traced}`, 3456, sessionId).length, 2)
})

test('Harmony /proc process identity handles spaces and rejects absent or foreign start ticks', () => {
  assert.deepEqual(processIdentity(`32 (task process) ${Array(19).fill('0').join(' ')} 123`, 32), { pid: 32, startTicks: '123' })
  assert.throws(() => processIdentity('31 (task) 123', 32), /owned PID/)
  assert.throws(() => processIdentity('32 (task) 123', 32), /start ticks/)
})

test('Harmony OS layout proof requires own focused bundle and point inside one own XComponent', () => {
  const proof = inspectForegroundLayout(layout(), bundle, null, { x: 250, y: 520 })
  assert.deepEqual(proof.bounds, { left: 0, top: 360, right: 1320, bottom: 2758 })
  assert.deepEqual(proof.inputPlane, proof.bounds)
  assert.equal(inspectForegroundLayout(layout(bundle, false), bundle).inputPlane, null, 'older single-surface layouts remain observable')
  assert.throws(() => inspectForegroundLayout(layout('com.example.user'), bundle), /foreground/)
  assert.throws(() => inspectForegroundLayout(layout(), bundle, null, { x: 0, y: 359 }), /outside/)
  const unproven = layout(); delete unproven.children[0].attributes.focused
  assert.throws(() => inspectForegroundLayout(unproven, bundle), /foreground/)
  assert.throws(() => inspectForegroundLayout(layout(), bundle, 'weapp-container-surface'), /exactly one/)
})

test('Harmony OS input plane must be unique, active and coextensive with the owned native surface', () => {
  const invalid = [
    value => { value.children[0].children[0].children[1].attributes.bounds = '[0,400][1320,2758]' },
    value => { value.children[0].children[0].children[1].attributes.enabled = 'false' },
    value => { value.children[0].children[0].children.push(clone(value.children[0].children[0].children[1])) },
    value => { value.children[0].children[0].children.push(clone(value.children[0].children[0].children[0])) },
    value => { value.children[0].children[0].children[0].attributes.visible = 'false' },
  ]
  for (const mutate of invalid) {
    const value = layout(); mutate(value)
    assert.throws(() => inspectForegroundLayout(value, bundle), /input plane|XComponent/)
  }
})

test('Harmony observation cannot substitute another engine, missing frame or diagnostics for evidence', () => {
  assert.equal(validateObservation(observation(), expected).page.data.count, 0)
  for (const mutate of [value => { value.engine = 'v8' }, value => { value.frameId = 0 }, value => { value.page.data.timerCount = 9 },
    value => { value.diagnostics = ['ERR_RENDER'] }, value => { value.presentedFrameId = 2 }]) {
    const value = observation(); mutate(value)
    assert.throws(() => validateObservation(value, expected))
  }
})

test('Harmony installed-app harness exercises OS input, timer/microtask and Home/resume with owned captures and exact cleanup', async () => fixture(async f => {
  const report = await runHarmonyAppSmoke(f.options, f)
  assert.equal(report.status, 'passed', JSON.stringify(report.diagnostics))
  assert.equal(report.cleanup.status, 'passed')
  assert.equal(report.cleanup.packageAbsent, true)
  assert.equal(report.cleanup.processAbsent, true)
  assert.equal(f.remote.size, 0)
  assert.equal(f.installed, false)
  assert.deepEqual(Object.keys(report.screenshots), ['initial', 'timer', 'resumed'])
  assert.ok(Object.values(report.screenshots).every(value => value.visualStatus === 'unknown' && value.processBefore.pid === value.processAfter.pid))
  assert.ok(Object.values(report.phases).every(value => value.process.pid === 3456 && value.process.startTicks === '912345'))
  const resumed = JSON.parse(readFileSync(join(f.outDir, 'resumed.state.json')))
  assert.equal(resumed.sessionId, sessionId)
  assert.equal(resumed.page.data.count, 1)
  assert.equal(resumed.page.data.timerCount, 1)
  assert.equal(resumed.page.data.microtaskCount, 1)
  assert.deepEqual(resumed.page.data.lifecycleTrace.slice(-4), ['app:hide', 'page:hide', 'app:show', 'page:show'])
  assert.ok(f.calls.some(call => call.args.join(' ').includes('uiInput click 250 520')))
  assert.ok(f.calls.some(call => call.args.join(' ').includes('uiInput keyEvent Home')))
  assert.ok(f.calls.every(call => !/hilog -r|target boot|kill-server|clear-data|uninstall com\.example/.test(call.args.join(' '))))
}))

test('Harmony harness completes resume when the owned newest HiLog observation has its system trace tuple', async () => fixture(async f => {
  const report = await runHarmonyAppSmoke(f.options, f)
  assert.equal(report.status, 'passed', JSON.stringify(report.diagnostics))
  assert.equal(report.phases.resumed.status, 'passed')
  assert.equal(report.screenshots.resumed.status, 'captured')
  assert.equal(report.cleanup.status, 'passed')
}, { traceOnResume: true }))

test('Harmony existing bundle is preserved without launching, installing or uninstalling', async () => fixture(async f => {
  const report = await runHarmonyAppSmoke(f.options, f)
  assert.equal(report.status, 'failed')
  assert.match(report.diagnostics[0].message, /already installed/)
  assert.equal(f.installed, true)
  assert.equal(report.cleanup.status, 'not-needed')
  assert.ok(f.calls.every(call => !['install', 'uninstall'].includes(call.args[2])))
}, { preexisting: true }))

for (const [label, overrides, expectedFailure] of [
  ['wrong HAP bundle', { packagedBundle: 'com.example.user' }, /Packaged HAP/],
  ['shell success code with install failure text', { installFailureText: true }, /install.*success/],
  ['unrelated foreground window', { foregroundBundle: 'com.example.user' }, /foreground/],
  ['PID replacement during screenshot', { restartDuringCapture: true }, /restarted|reused/],
  ['foreign-session logs', { onlyForeignSession: true }, /Deadline/],
  ['input accepted without handler update', { noTapUpdate: true }, /Deadline.*tap/],
  ['missing timer/microtask update', { noTimerUpdate: true }, /Deadline.*timer/],
  ['OS click rejection', { clickRejected: true }, /OS click.*rejected/],
  ['process restart on resume', { restartOnResume: true }, /restarted|reused/],
  ['corrupt OS screenshot', { corruptPng: true }, /PNG/],
  ['truncated OS screenshot', { truncatePng: true }, /PNG/],
  ['corrupt screenshot checksum', { corruptPngChecksum: true }, /PNG/],
  ['abort after click', { abortAfterClick: true }, /aborted/],
]) {
  test(`Harmony ${label} cannot pass and preserves evidence while cleaning its owned bundle`, async () => fixture(async f => {
    const report = await runHarmonyAppSmoke(f.options, f)
    assert.equal(report.status, 'failed')
    assert.ok(report.diagnostics.some(value => expectedFailure.test(value.message)), JSON.stringify(report.diagnostics))
    assert.equal(report.cleanup.status, label === 'wrong HAP bundle' ? 'not-needed' : 'passed', JSON.stringify(report.cleanup))
    assert.equal(f.installed, false)
    assert.equal(f.remote.size, 0)
    assert.ok(report.commands.length > 0)
    assert.equal(JSON.parse(readFileSync(join(f.outDir, 'report.json'))).status, 'failed')
    if (label === 'unrelated foreground window') assert.ok(!f.calls.some(call => call.args.includes('uiInput')))
  }, overrides))
}

for (const [label, overrides] of [['uninstall', { uninstallFailure: true }], ['remote capture', { remoteCleanupFailure: true }]]) {
  test(`Harmony ${label} cleanup failure remains failed even after interaction checks pass`, async () => fixture(async f => {
    const report = await runHarmonyAppSmoke(f.options, f)
    assert.equal(report.phases.resumed.status, 'passed')
    assert.equal(report.status, 'failed')
    assert.equal(report.cleanup.status, 'failed')
    assert.ok(report.cleanup.failures.length > 0)
  }, overrides))
}

test('Harmony mismatched HAP provenance stops before device commands', async () => fixture(async f => {
  assert.throws(() => inspectBuildReceipt(f.buildReceipt, sha256(readFileSync(f.hap)), bundle), /HAP bytes/)
  const report = await runHarmonyAppSmoke(f.options, f)
  assert.equal(report.status, 'failed')
  assert.equal(f.calls.length, 0)
}, { mutateBuild: value => { value.artifact.sha256 = '0'.repeat(64) } }))
