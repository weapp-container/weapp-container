#!/usr/bin/env node
/** Pinned weapp-vite source -> real output -> pack -> native dual-engine scrolling. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { routeStyleIds } from '../examples/hosts/web-wasm/render-inputs.mjs'
import { createOwnedCommandRunner, matchedResponse, sha256, sourceHashes } from './simulator-cli-harness.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURE = resolve(ROOT, 'examples/apps/scroll-contract-app')
const VIEWPORT = { width: 240, height: 200 }
const PHASES = ['initial', 'attributes', 'wheel-a', 'touch-a', 'unrelated', 'wheel-b', 'page', 'catch-touch', 'relaunch', 'other-wheel']
const COLORS = { white: [255, 255, 255, 255], red: [229, 57, 53, 255], blue: [25, 118, 210, 255],
  green: [0, 160, 96, 255], yellow: [255, 204, 0, 255], purple: [128, 64, 192, 255], other: [32, 160, 160, 255] }

function request(requestId, op, payload) {
  return { protocolVersion: '1.0', sessionId: 'simulator-1', requestId, kind: 'request', op, payload }
}

function input(id, event) { return request(id, 'event.batch', { events: [event] }) }
function tap(id, x, y) { return input(id, { type: 'tap', x, y }) }
function wheel(id, x, y, deltaX, deltaY) { return input(id, { type: 'wheel', x, y, deltaX, deltaY, deltaMode: 'pixel' }) }
function drag(id, identifier, fromX, fromY, toX, toY) {
  return ['touchstart', 'touchmove', 'touchend'].map((type, index) => {
    const touch = { identifier, clientX: index ? toX : fromX, clientY: index ? toY : fromY,
      pageX: index ? toX : fromX, pageY: index ? toY : fromY }
    return input(`${id}-${type}`, { type, x: touch.clientX, y: touch.clientY,
      changedTouches: [touch], touches: type === 'touchend' ? [] : [touch] })
  })
}

function render(id, blobs, manifest, other = false) {
  const path = `pages/${other ? 'other' : 'index'}/index`
  const route = manifest.routes.find(route => route.path === path)
  assert.ok(route, 'fixture route exists in actual compiled manifest')
  return request(id, 'render.commit', { templateId: `template:${path}.wxml`,
    blobs, styleIds: routeStyleIds(manifest, route), viewport: VIEWPORT })
}

function observations(id, y = 122) {
  return [tap(`inspect-${id}`, 42, y),
    request(`read-${id}`, 'api.call', { name: 'wx.getStorageSync', key: 'scroll:query' }),
    request(`taps-${id}`, 'api.call', { name: 'wx.getStorageSync', key: 'scroll:taps' }),
    request(`catch-${id}`, 'api.call', { name: 'wx.getStorageSync', key: 'scroll:catch' })]
}

function scriptFor(phase, blobs, manifest) {
  const script = [tap('observe-initial', 42, 154), render('render-observe', blobs, manifest), ...observations('initial')]
  for (const current of PHASES.slice(1, PHASES.indexOf(phase) + 1)) {
    switch (current) {
      case 'attributes': script.push(tap('set-attributes', 112, 122), render('render-attributes', blobs, manifest)); break
      case 'wheel-a': script.push(wheel('wheel-a', 40, 40, 20, 10), tap('hit-moved-a', 35, 40), render('render-wheel-a', blobs, manifest)); break
      case 'touch-a': script.push(...drag('drag-a', 41, 45, 55, 35, 40), render('render-touch-a', blobs, manifest)); break
      case 'unrelated': script.push(tap('unrelated-patch', 112, 154), render('render-unrelated', blobs, manifest)); break
      case 'wheel-b': script.push(wheel('wheel-b', 180, 40, 60, 50), tap('hit-moved-b', 175, 45), render('render-wheel-b', blobs, manifest)); break
      case 'page': script.push(tap('page-scroll-command', 182, 122), tap('hit-page-target', 35, 150), render('render-page', blobs, manifest)); break
      case 'catch-touch': script.push(...drag('drag-catch', 42, 180, 160, 170, 145), render('render-catch-touch', blobs, manifest)); break
      case 'relaunch': script.push(tap('relaunch-page', 182, 66), render('render-relaunch', blobs, manifest, true)); break
      case 'other-wheel': script.push(wheel('wheel-other', 120, 60, 0, 30), render('render-other-wheel', blobs, manifest, true)); break
    }
    script.push(...observations(current, current === 'page' || current === 'catch-touch' ? 2 : 122))
  }
  return script
}

function near(actual, expected, label) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 0.001, `${label}: ${actual} != ${expected}`)
}

function inspectObservation(observation, phase, taps, caught) {
  assert.ok(observation && typeof observation === 'object', `${phase}: actual JS query saved its observation`)
  const index = PHASES.indexOf(phase)
  const other = index >= PHASES.indexOf('relaunch')
  assert.equal(observation.route, `pages/${other ? 'other' : 'index'}/index`, `${phase}: actual current page`)
  assert.ok(Array.isArray(observation.geometry) && observation.geometry.length === 5, `${phase}: all real selector callbacks ran`)
  const [a, b, aRect, bRect, viewport] = observation.geometry
  near(viewport.scrollLeft, 0, `${phase}: viewport horizontal offset`)
  const pageScrolled = phase === 'page' || phase === 'catch-touch'
  near(viewport.scrollTop, pageScrolled ? 120 : 0, `${phase}: viewport vertical offset`)
  const expectedTaps = [
    ...(index >= PHASES.indexOf('wheel-a') ? [{ id: 'target-a', owner: 'a', target: 'target-a' }] : []),
    ...(index >= PHASES.indexOf('wheel-b') ? [{ id: 'target-b', owner: 'b', target: 'target-b' }] : []),
    ...(index >= PHASES.indexOf('page') ? [{ id: 'page-target', owner: 'page', target: 'page-target' }] : []),
  ]
  assert.deepEqual(taps || [], expectedTaps, `${phase}: physical taps reach moved and clipped actual nodes`)
  assert.ok(Array.isArray(observation.intersections), `${phase}: real observer callbacks are saved`)
  if (other) {
    assert.deepEqual([a, b, aRect, bRect], [null, null, null, null], `${phase}: old page geometry is not addressable`)
    assert.equal(observation.data.other, true, `${phase}: new page executes its own JS`)
    assert.equal(caught, null, `${phase}: disposed catch container is no longer queryable`)
    assert.ok(observation.trace.includes('index:unload'), `${phase}: prior page unloaded`)
    const unloadIndex = observation.trace.indexOf('index:unload')
    assert.equal(observation.trace.slice(unloadIndex + 1).some(entry => Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].endsWith(':scroll')), false,
      `${phase}: new page input cannot invoke old page scrolling`)
    return observation
  }
  const aLeft = index >= PHASES.indexOf('touch-a') ? 70 : index >= PHASES.indexOf('wheel-a') ? 60 : index >= 1 ? 40 : 0
  const aTop = index >= PHASES.indexOf('touch-a') ? 55 : index >= PHASES.indexOf('wheel-a') ? 40 : index >= 1 ? 30 : 0
  const bLeft = index >= PHASES.indexOf('wheel-b') ? 60 : 0
  const bTop = index >= PHASES.indexOf('wheel-b') ? 50 : 0
  for (const [actual, expected, label] of [[a.scrollLeft, aLeft, 'A left'], [a.scrollTop, aTop, 'A top'],
    [b.scrollLeft, bLeft, 'B left'], [b.scrollTop, bTop, 'B top'],
    [aRect.left, 80 - aLeft, 'A target left'], [aRect.top, 70 - aTop - (pageScrolled ? 120 : 0), 'A target top'],
    [bRect.left, 220 - bLeft, 'B target left'], [bRect.top, 80 - bTop - (pageScrolled ? 120 : 0), 'B target top']]) {
    near(actual, expected, `${phase}: ${label}`)
  }
  assert.equal(observation.data.leftA, index >= 1 ? 40 : 0, `${phase}: wheel does not rewrite input attributes`)
  assert.equal(observation.data.topA, index >= 1 ? 30 : 0, `${phase}: input attribute state is retained`)
  assert.equal(observation.data.unrelated, index >= PHASES.indexOf('unrelated') ? 1 : 0, `${phase}: unrelated setData actually executes`)
  const scrollCallbacks = [
    ...(index >= PHASES.indexOf('attributes') ? [['a:scroll', 40, 30]] : []),
    ...(index >= PHASES.indexOf('wheel-a') ? [['a:scroll', 60, 40]] : []),
    ...(index >= PHASES.indexOf('touch-a') ? [['a:scroll', 70, 55]] : []),
    ...(index >= PHASES.indexOf('wheel-b') ? [['b:scroll', 60, 50]] : []),
  ]
  for (const expected of scrollCallbacks) {
    assert.ok(observation.trace.some(event => JSON.stringify(event) === JSON.stringify(expected)), `${phase}: actual bound scroll callback ${JSON.stringify(expected)}`)
  }
  near(caught.scrollLeft, 0, `${phase}: catch container horizontal position`)
  near(caught.scrollTop, 0, `${phase}: catch container vertical position`)
  if (index >= PHASES.indexOf('touch-a')) assert.ok(observation.trace.includes('a:stopped-propagation'), 'ordinary stopPropagation handler ran without cancelling drag scrolling')
  if (phase === 'catch-touch') assert.ok(observation.trace.includes('c:catchtouchmove'), 'catchtouchmove actually consumed the drag')
  assert.ok(observation.intersections.length >= (index >= 1 ? 2 : 1), `${phase}: committed scroll drives observer delivery`)
  near(observation.intersections[0].intersectionRatio, 0.375, `${phase}: initial observer honors both clip axes`)
  if (index >= 1) near(observation.intersections[1].intersectionRatio, 1, `${phase}: scroll reveals full target`)
  if (pageScrolled) {
    assert.ok(observation.trace.some(entry => Array.isArray(entry) && entry[0] === 'index:scroll' && entry[1] === 120), 'real page scroll callback')
    for (const event of ['pageScrollTo:success', 'pageScrollTo:complete']) {
      assert.ok(observation.trace.some(entry => Array.isArray(entry) && entry[0] === event && entry[1] === 'pageScrollTo:ok'), `real ${event} callback`)
    }
  }
  return observation
}

function inspectSnapshot(snapshot, phase) {
  assert.equal(snapshot.width, VIEWPORT.width)
  assert.equal(snapshot.height, VIEWPORT.height)
  assert.equal(snapshot.stride, VIEWPORT.width * 4)
  assert.ok(['rgba8', 'rgba8-premultiplied'].includes(snapshot.format))
  assert.equal(snapshot.pixels.length, VIEWPORT.width * VIEWPORT.height * 4)
  const index = PHASES.indexOf(phase)
  let samples
  if (index >= PHASES.indexOf('relaunch')) samples = [[5, 5, 'other'], [120, 50, 'other'], [230, 190, 'other']]
  else if (phase === 'page' || phase === 'catch-touch') samples = [[35, 150, 'purple'], [5, 150, 'white'], [35, 100, 'white'], [85, 150, 'white']]
  else samples = [[5, 40, 'white'], [115, 75, 'white'], [235, 85, 'white'],
    ...(phase === 'initial' ? [[85, 75, 'green'], [50, 40, 'red'], [225, 85, 'yellow']]
      : phase === 'attributes' ? [[45, 45, 'green'], [85, 75, 'red'], [225, 85, 'yellow']]
        : [[35, 40, 'green'], [85, 75, 'red'], [15, 35, index >= PHASES.indexOf('touch-a') ? 'green' : 'red'],
          [175, 45, index >= PHASES.indexOf('wheel-b') ? 'yellow' : 'blue']])]
  const result = samples.map(([x, y, color]) => {
    const rgba = snapshot.pixels.slice(y * snapshot.stride + x * 4, y * snapshot.stride + x * 4 + 4)
    assert.deepEqual(rgba, COLORS[color], `${phase}: actual clipped/moved RGBA at (${x},${y})`)
    return { x, y, rgba }
  })
  return { pixelSha256: sha256(Buffer.from(snapshot.pixels)), width: snapshot.width, height: snapshot.height, samples: result }
}

function parseArguments(argv) {
  const options = { out: resolve(ROOT, 'artifacts/scrolling.json'), timeoutMs: 120_000 }
  const values = new Map([['--simulator-bin', 'simulatorBin'], ['--compiler-root', 'compilerRoot'],
    ['--compiler-dist-hashes', 'compilerDistHashes'], ['--out', 'out'], ['--timeout', 'timeoutMs']])
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--') continue
    if (argv[index] === '--help' || argv[index] === '-h') return { help: true }
    const key = values.get(argv[index])
    if (!key) throw new Error(`Unknown option: ${argv[index]}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${argv[index - 1]} requires a value`)
    options[key] = key === 'timeoutMs' ? Number(value) : resolve(value)
  }
  for (const key of ['simulatorBin', 'compilerRoot', 'compilerDistHashes']) assert.ok(options[key], `${key} is required`)
  assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1000, '--timeout must be >= 1000 milliseconds')
  return options
}

export async function validateCompiler(options, command, commit) {
  const tree = await command('git', ['-C', resolve(ROOT, 'vendor/weapp-vite'), 'ls-tree', '-rz', '--full-tree', commit])
  const tracked = []
  const declaredEolConversions = []
  for (const entry of tree.stdout.split('\0').filter(Boolean)) {
    const match = /^(\d+) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry)
    assert.ok(match, `unsupported pinned compiler entry: ${entry}`)
    const [, mode, expected, path] = match
    const absolute = resolve(options.compilerRoot, path)
    assert.ok(absolute.startsWith(options.compilerRoot + sep), 'compiler source path stays in root')
    const info = await lstat(absolute)
    assert.equal(info.isSymbolicLink(), mode === '120000', `compiler source type: ${path}`)
    const bytes = mode === '120000' ? Buffer.from(await readlink(absolute)) : await readFile(absolute)
    const gitBlobHash = content => createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
    const gitHash = gitBlobHash(bytes)
    if (gitHash !== expected) {
      // git archive/checkout honors explicit eol=crlf attributes. Accept that
      // one declared conversion only after resolving attributes at the pin.
      const attributes = await command('git', ['-C', resolve(ROOT, 'vendor/weapp-vite'), 'check-attr',
        `--source=${commit}`, 'text', 'eol', '--', path])
      assert.ok(attributes.stdout.includes(`${path}: text: set\n`) && attributes.stdout.includes(`${path}: eol: crlf\n`),
        `compiler source differs without a pinned CRLF rule: ${path}`)
      const normalized = Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'))
      assert.deepEqual(bytes, Buffer.from(normalized.toString('utf8').replaceAll('\n', '\r\n')), `only the declared CRLF conversion: ${path}`)
      assert.equal(gitBlobHash(normalized), expected, `compiler source differs from pinned Git object after declared EOL conversion: ${path}`)
      declaredEolConversions.push({ path, pinnedAttribute: 'text eol=crlf', rawSha256: sha256(bytes), gitObject: expected })
    }
    tracked.push([path, sha256(bytes)])
  }
  const mapBytes = await readFile(options.compilerDistHashes)
  const dist = Object.entries(JSON.parse(mapBytes)).sort(([a], [b]) => a.localeCompare(b))
  assert.ok(dist.length > 0, 'independent prior compiler build dist hash map is not empty')
  const distRoots = new Set()
  for (const [path, hash] of dist) {
    const marker = path.indexOf('/dist/')
    assert.ok(marker > 0, `compiler dist receipt contains a dist resource: ${path}`)
    distRoots.add(path.slice(0, marker + '/dist'.length))
    const absolute = resolve(options.compilerRoot, path)
    assert.ok(absolute.startsWith(options.compilerRoot + sep), 'compiler dist path stays in root')
    assert.equal(sha256(await readFile(absolute)), hash, `compiler dist changed from independent build receipt: ${path}`)
  }
  const observedDist = {}
  for (const directory of [...distRoots].sort()) {
    Object.assign(observedDist, await sourceHashes(resolve(options.compilerRoot, directory), `${directory}/`))
  }
  const distDependencies = Object.entries(observedDist).filter(([path]) => path.split('/').includes('node_modules')).sort(([a], [b]) => a.localeCompare(b))
  const generatedDist = Object.entries(observedDist).filter(([path]) => !path.split('/').includes('node_modules')).sort(([a], [b]) => a.localeCompare(b))
  assert.deepEqual(generatedDist, dist,
    'compiler dist directories have no missing or unrecorded generated files')
  return { pinnedCommit: commit, trackedFiles: tracked.length, trackedSha256: sha256(JSON.stringify(tracked)),
    distFiles: dist.length, distSha256: sha256(JSON.stringify(dist)), distReceiptPath: options.compilerDistHashes,
    distReceiptSha256: sha256(mapBytes), gitSourceObjectsVerified: true, declaredEolConversions,
    reusedDistDependencyFiles: distDependencies.length, reusedDistDependencySha256: sha256(JSON.stringify(distDependencies)),
    reusedDistDependencies: Object.fromEntries(distDependencies) }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (options.help) {
    process.stdout.write('Usage: node scripts/scrolling-smoke.mjs --simulator-bin <dual-engine-binary> --compiler-root <isolated-pinned-compiler> --compiler-dist-hashes <independent-build-map.json> [--out <report.json>] [--timeout <ms>]\n')
    return
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'weapp-scroll-'))
  const artifactDirectory = `${options.out}.files`
  await mkdir(artifactDirectory, { recursive: true })
  const runner = createOwnedCommandRunner({ cwd: ROOT, timeoutMs: options.timeoutMs })
  const { command } = runner
  const report = { schemaVersion: 1, scope: 'compiled-scrolling', status: 'failed', generatedAt: new Date().toISOString(),
    fixture: { path: relative(ROOT, FIXTURE), kind: 'actual-weapp-vite-compiled-app' }, engines: [], comparison: { status: 'not-run' }, cleanup: {},
    sourceCommitScope: 'Harness checkout HEAD only. The supplied binary is identified by SHA-256; source/build binding requires its separate build receipt.',
    phaseExecution: 'Every phase starts a fresh native CLI process and replays all prior physical inputs and render commits. Only actual app JS mutates data. Observations use its wx selector callbacks and storage.',
    evidenceBoundary: 'Local pinned compiler output and native QuickJS/V8 software RGBA conformance only. The isolated compiler dist is reused from the supplied independent build receipt, not freshly rebuilt. Dependency installation is reused. No fresh official DevTools, browser, GPU, mobile, device or performance acceptance is claimed.' }
  async function save(name, bytes, compress = false) {
    const path = resolve(artifactDirectory, name + (compress ? '.gz' : ''))
    const encoded = compress ? gzipSync(bytes) : bytes
    await writeFile(path, encoded)
    return { path: relative(dirname(options.out), path), sha256: sha256(encoded),
      ...(compress ? { encoding: 'gzip', uncompressedSha256: sha256(bytes) } : {}) }
  }
  try {
    report.sourceCommit = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
    report.workingTreeDirty = Boolean((await command('git', ['status', '--short'])).stdout.trim())
    report.fixture.sha256 = await sourceHashes(FIXTURE)
    report.harness = {}
    for (const path of ['scripts/scrolling-smoke.mjs', 'scripts/simulator-cli-harness.mjs', 'examples/hosts/web-wasm/render-inputs.mjs']) {
      report.harness[path] = sha256(await readFile(resolve(ROOT, path)))
    }
    report.packer = { source: await sourceHashes(resolve(ROOT, 'tools/container-manifest/src')),
      bin: await sourceHashes(resolve(ROOT, 'tools/container-manifest/bin')) }
    report.simulator = { path: options.simulatorBin, sha256: sha256(await readFile(options.simulatorBin)) }
    const commit = (await command('git', ['rev-parse', 'HEAD:vendor/weapp-vite'])).stdout.trim()
    report.compiler = { directory: options.compilerRoot, before: await validateCompiler(options, command, commit) }
    const project = resolve(temporary, 'project')
    const dist = resolve(temporary, 'dist')
    const pack = resolve(temporary, 'pack')
    await cp(FIXTURE, project, { recursive: true })
    const built = await command(process.execPath, [resolve(options.compilerRoot, 'packages/weapp-vite/bin/weapp-vite.js'),
      'build', project, '-p', 'weapp', '--outDir', dist])
    report.build = { command: built.command, exitCode: built.exitCode, output: await save('compiler-build.json', Buffer.from(JSON.stringify(built, null, 2))) }
    report.compiler.after = await validateCompiler(options, command, commit)
    assert.deepEqual(report.compiler.after, report.compiler.before, 'pinned compiler source and dist stable across app compilation')
    report.rawOutput = { sha256: await sourceHashes(dist) }
    const packed = await command(process.execPath, ['tools/container-manifest/bin/container-pack.mjs', dist, '--out', pack, '--compiler-commit', commit])
    report.packCommand = packed.command
    const manifestBytes = await readFile(resolve(pack, 'manifest.json'))
    const manifest = JSON.parse(manifestBytes)
    assert.equal(manifest.compiler.commit, commit, 'actual verified compiler SHA declared')
    const blobs = {}
    for (const name of await readdir(resolve(pack, 'blobs/sha256'))) {
      const bytes = await readFile(resolve(pack, 'blobs/sha256', name))
      assert.equal(sha256(bytes), name, 'actual content-addressed blob integrity')
      blobs[`sha256:${name}`] = [...bytes]
    }
    report.pack = { compilerCommit: commit, integrityRoot: manifest.integrity.root,
      manifestSha256: sha256(manifestBytes), sha256: await sourceHashes(pack),
      manifest: await save('manifest.json', manifestBytes), rawOutputUnmodified: true }
    for (const engine of ['quickjs', 'v8']) {
      const entry = { engine, status: 'failed', phases: [] }
      report.engines.push(entry)
      for (const phase of PHASES) {
        const observation = { phase, status: 'failed' }
        entry.phases.push(observation)
        const prefix = resolve(temporary, `${engine}-${phase}`)
        try {
          const script = scriptFor(phase, blobs, manifest)
          assert.ok(script.every(message => message.op !== 'data.patch.batch' && message.op !== 'module.load'), 'no host-injected app state/code')
          assert.ok(script.filter(message => message.op === 'render.commit').every(message => !Object.hasOwn(message.payload, 'data') && !Object.hasOwn(message.payload, 'frame')), 'only real app state/IR renders')
          await writeFile(`${prefix}.jsonl`, script.map(message => JSON.stringify(message)).join('\n') + '\n')
          const executed = await command(options.simulatorBin, ['run', '--pack', pack, '--engine', engine, '--viewport', '240x200',
            '--script', `${prefix}.jsonl`, '--trace', `${prefix}.trace.json`, '--snapshot', `${prefix}.snapshot.json`, '--report', `${prefix}.report.json`])
          observation.process = Object.fromEntries(Object.entries(executed).filter(([key]) => key !== 'stdout'))
          const traceBytes = await readFile(`${prefix}.trace.json`)
          const snapshotBytes = await readFile(`${prefix}.snapshot.json`)
          const nativeReportBytes = await readFile(`${prefix}.report.json`)
          observation.artifacts = { trace: await save(`${engine}-${phase}.trace.json`, traceBytes, true),
            snapshot: await save(`${engine}-${phase}.snapshot.json`, snapshotBytes, true),
            report: await save(`${engine}-${phase}.report.json`, nativeReportBytes) }
          const trace = JSON.parse(traceBytes)
          const native = JSON.parse(nativeReportBytes)
          const records = trace.records ?? trace.events
          observation.native = { engine: native.engine, renderer: native.renderer, route: native.route,
            lifecycleState: native.lifecycleState, status: native.status }
          assert.equal(native.engine, engine, 'requested engine executes with no fallback')
          assert.equal(native.status, 'passed', 'canonical startup and inputs pass')
          assert.equal(native.lifecycleState, 'Active', 'actual JS lifecycle runs')
          assert.equal(native.route, `pages/${PHASES.indexOf(phase) >= PHASES.indexOf('relaunch') ? 'other' : 'index'}/index`, 'native page stack agrees with app JS')
          assert.deepEqual(records.slice(0, 4).map(record => record.request?.op), ['app.init', 'app.lifecycle', 'page.push', 'render.commit'])
          for (const record of records) matchedResponse(trace, record.request.requestId, record.request.op)
          observation.actual = matchedResponse(trace, `read-${phase}`, 'api.call').result
          observation.actualTaps = matchedResponse(trace, `taps-${phase}`, 'api.call').result
          observation.actualCatch = matchedResponse(trace, `catch-${phase}`, 'api.call').result
          observation.runtimeErrors = records.flatMap(record => (record.response?.messages ?? [])
            .filter(message => message.op === 'error' || message.payload?.ok === false)
            .map(message => ({ requestId: record.request.requestId, op: message.op, payload: message.payload })))
          const failures = observation.runtimeErrors.map(message => ({ check: 'runtime-error-envelope', error: JSON.stringify(message) }))
          try { observation.observation = inspectObservation(observation.actual, phase, observation.actualTaps, observation.actualCatch) }
          catch (error) { failures.push({ check: 'live-app-state-and-geometry', error: error.stack ?? String(error) }) }
          try { observation.snapshot = inspectSnapshot(JSON.parse(snapshotBytes), phase) }
          catch (error) { failures.push({ check: 'actual-rgba-movement-and-clipping', error: error.stack ?? String(error) }) }
          observation.checkFailures = failures
          assert.equal(failures.length, 0, `${phase}: ${failures.map(failure => `${failure.check}: ${failure.error.split('\n')[0]}`).join('; ')}`)
          observation.status = 'passed'
        } catch (error) {
          observation.error = error.stack ?? String(error)
          if (error.result) observation.process = error.result
          if (runner.interrupted) throw error
        }
      }
      if (entry.phases.every(phase => phase.status === 'passed')) entry.status = 'passed'
    }
    if (report.engines.every(entry => entry.status === 'passed')) {
      const projected = report.engines.map(entry => entry.phases.map(phase => ({ phase: phase.phase,
        observation: phase.observation, taps: phase.actualTaps, catchOffset: phase.actualCatch, snapshot: phase.snapshot })))
      // Observer timestamps are monotonic runtime facts, not cross-process equality assertions.
      const normalized = projected.map(entry => entry.map(phase => ({ ...phase,
        observation: { ...phase.observation, intersections: phase.observation.intersections.map(({ time, ...rest }) => rest) } })))
      assert.deepEqual(normalized[0], normalized[1], 'native QuickJS/V8 live app state, geometry, callbacks and actual RGBA agree')
      const final = normalized[0]
      assert.deepEqual(final.at(-1).observation.intersections, final.at(-2).observation.intersections, 'unloaded page observer receives no stale input notifications')
      report.comparison = { status: 'passed' }
      report.status = 'passed'
    }
    assert.deepEqual(await sourceHashes(FIXTURE), report.fixture.sha256, 'fixture source stable and no generated files written into checkout')
    for (const [path, hash] of Object.entries(report.harness)) assert.equal(sha256(await readFile(resolve(ROOT, path))), hash, `harness input stable: ${path}`)
  } catch (error) {
    report.error = error.stack ?? String(error)
    if (error.result) report.failedProcess = error.result
  } finally {
    if (runner.active) runner.stop()
    report.cleanup.childProcessClosed = runner.active === null
    try { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true }
    catch (error) { report.cleanup.temporaryRemoved = false; report.cleanup.error = String(error); report.status = 'failed' }
    report.cleanup.noListenerOrBrowserCreated = true
    if (runner.interrupted) { report.interrupted = runner.interrupted; report.status = 'failed' }
    report.finishedAt = new Date().toISOString()
    try { await mkdir(dirname(options.out), { recursive: true }); await writeFile(options.out, JSON.stringify(report, null, 2) + '\n') }
    finally { runner.dispose() }
  }
  process.stdout.write(JSON.stringify({ status: report.status, report: options.out,
    engines: report.engines.map(({ engine, status }) => ({ engine, status })), cleanup: report.cleanup }) + '\n')
  if (runner.interrupted) process.exitCode = runner.interrupted === 'SIGINT' ? 130 : 143
  else if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
