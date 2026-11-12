// Isolated real-Worker boundary smoke. This harness never edits a built site
// or an existing server, and does not construct a presenter or send frame ACKs.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const WORKER_FILES = ['runtime-worker.mjs', 'worker-runtime.mjs', 'worker-session-client.mjs', 'render-inputs.mjs']
const HEX = /^[0-9a-f]{64}$/
const inside = (child, parent) => child === parent || child.startsWith(parent + sep)
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const utf8 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
const git = async (repository, args) => (await exec('rtk', ['proxy', 'git', ...args], {
  cwd: repository, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
})).stdout

export function parseArgs(args) {
  const options = { repository: process.cwd() }
  const names = { '--site-dir': 'siteDir', '--out-dir': 'outDir', '--repo': 'repository' }
  const seen = new Set()
  for (let index = 0; index < args.length; index++) {
    const name = names[args[index]]
    if (!name || !args[index + 1] || args[index + 1].startsWith('--') || seen.has(name)) throw new Error(`Invalid or duplicate argument: ${args[index]}`)
    options[name] = resolve(args[++index]); seen.add(name)
  }
  if (!options.siteDir || !options.outDir) throw new Error('Usage: node scripts/worker-wasm-browser-smoke.mjs --site-dir <passed-build> --out-dir <new-evidence-dir> [--repo <clean-repository>]')
  if (inside(options.siteDir, options.outDir) || inside(options.outDir, options.siteDir)) throw new Error('Input build and evidence output must be separate directories')
  return options
}

function localPath(root, path) {
  assert.equal(typeof path, 'string')
  assert.ok(path && !path.includes('\\') && !path.startsWith('/') && !path.split('/').includes('..'), `Unsafe retained path: ${path}`)
  const absolute = resolve(root, path)
  assert.ok(absolute.startsWith(root + sep))
  return absolute
}

async function regularBytes(root, path) {
  const absolute = localPath(root, path)
  assert.equal((await lstat(absolute)).isFile(), true, `Input must be a regular file: ${path}`)
  assert.ok((await realpath(absolute)).startsWith(root + sep), `Input symlink escapes its root: ${path}`)
  return readFile(absolute)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Capture immutable served bytes from one clean commit and one passed build.
 * The default builder still stages a main-thread app; none of that app is
 * loaded here. All additional browser code has separate source hashes.
 */
export async function stageWorkerSite(options, out) {
  const input = await realpath(options.siteDir), repository = await realpath(options.repository)
  const reportBytes = await regularBytes(input, 'build-report.json')
  const build = JSON.parse(reportBytes)
  assert.equal(build.status, 'passed', 'Only a passed clean-source WASM build is eligible')
  assert.equal(build.ready, true)
  assert.equal(build.buildStatus, 'passed')
  assert.equal(build.source?.status, 'passed')
  assert.equal(build.source?.workingTreeDirty, false)
  assert.equal(build.source?.sourceStable, true)
  const commit = (await git(repository, ['rev-parse', 'HEAD'])).toString().trim()
  assert.match(commit, /^[0-9a-f]{40}$/)
  assert.equal(build.source.sourceCommit, commit, 'Worker sources and WASM must use the same commit')
  assert.equal((await git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length, 0, 'Repository must be clean before staging')
  assert.equal(build.source.sourceSha256, digest(JSON.stringify(build.source.sourceFiles)), 'Invalid build source inventory digest')
  const sourceRoot = await realpath(resolve(input, 'source'))
  for (const [path, hash] of Object.entries(build.source.sourceFiles)) {
    assert.equal(digest(await regularBytes(sourceRoot, path)), hash, `Frozen build source changed: ${path}`)
  }
  const site = resolve(out, 'site')
  await mkdir(site)
  const inventory = {}
  const retain = async (path, bytes, provenance) => {
    const destination = localPath(site, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes, { flag: 'wx' })
    inventory[path] = { sha256: digest(bytes), size: bytes.length, provenance }
  }
  for (const file of WORKER_FILES) {
    const path = `examples/hosts/web-wasm/${file}`
    const committed = await git(repository, ['show', `${commit}:${path}`])
    assert.deepEqual(await regularBytes(repository, path), committed, `Worker checkout differs from commit: ${path}`)
    if (build.source.sourceFiles[path]) assert.equal(digest(committed), build.source.sourceFiles[path])
    await retain(file, committed, { source: 'git', commit, path })
  }
  const copyPackage = async directory => {
    for (const item of await readdir(resolve(input, directory), { withFileTypes: true })) {
      const path = `${directory}/${item.name}`
      assert.ok(item.isDirectory() || item.isFile(), `Generated package contains a symlink or special file: ${path}`)
      if (item.isDirectory()) await copyPackage(path)
      else await retain(path, await regularBytes(input, path), { source: 'passed-wasm-build', buildReportSha256: digest(reportBytes) })
    }
  }
  await copyPackage('pkg')
  for (const kind of ['glue', 'wasm']) {
    const artifact = build.artifacts?.[kind]
    assert.ok(artifact && HEX.test(artifact.sha256))
    assert.equal(inventory[artifact.path]?.sha256, artifact.sha256, `${kind} differs from its passed build report`)
  }
  assert.equal(build.artifacts.glue.path, 'pkg/container_host_web.js')
  assert.equal(build.artifacts.wasm.path, 'pkg/container_host_web_bg.wasm')
  const dependencies = build.rendererDependencies
  assert.equal(dependencies?.status, 'passed')
  assert.equal(dependencies?.retainedStatus, 'passed')
  const pinsPath = 'examples/hosts/web-wasm/renderer-dependency-pins.json'
  const pinBytes = await git(repository, ['show', `${commit}:${pinsPath}`])
  assert.equal(digest(pinBytes), build.source.sourceFiles[pinsPath])
  const pins = JSON.parse(pinBytes)
  for (const file of dependencies.files) {
    assert.equal(file.verified, true)
    assert.equal(file.sha256, pins[file.id]?.sha256, `Renderer dependency differs from committed pin: ${file.id}`)
    assert.equal(file.size, pins[file.id]?.size)
    const bytes = await regularBytes(input, file.url)
    assert.equal(digest(bytes), file.sha256)
    assert.equal(bytes.length, file.size)
    await retain(file.url, bytes, { source: 'build-report-and-committed-pin', executed: false })
  }
  const configuration = await regularBytes(input, dependencies.runtimeConfig.path)
  assert.equal(digest(configuration), dependencies.runtimeConfig.sha256)
  await retain(dependencies.runtimeConfig.path, configuration, { source: 'build-report', executed: false })
  const indexBytes = await regularBytes(input, 'pack-index.json'), index = JSON.parse(indexBytes)
  assert.deepEqual(index, build.pack)
  assert.equal(index.schemaVersion, 1)
  assert.ok(HEX.test(index.manifestSha256) && HEX.test(index.integrityRoot))
  const manifestBytes = await regularBytes(input, index.manifest), manifest = JSON.parse(manifestBytes)
  assert.equal(digest(manifestBytes), index.manifestSha256)
  assert.equal(manifest.integrity?.root, index.integrityRoot)
  assert.equal(digest(canonical({ ...manifest, integrity: { ...manifest.integrity, root: '' } })), index.integrityRoot)
  await retain('pack-index.json', indexBytes, { source: 'unchanged-original-build-pack' })
  await retain(index.manifest, manifestBytes, { source: 'unchanged-original-build-pack' })
  const blobBytes = new Map()
  for (const blob of index.blobs) {
    assert.ok(HEX.test(blob.sha256) && !blobBytes.has(blob.sha256))
    const bytes = await regularBytes(input, blob.url)
    assert.equal(bytes.length, blob.size)
    assert.equal(digest(bytes), blob.sha256)
    await retain(blob.url, bytes, { source: 'unchanged-original-build-pack' })
    blobBytes.set(blob.sha256, bytes)
  }
  const entryPath = manifest.app.entryModule.replace(/^module:/, '')
  const entry = manifest.modules.find(module => module.id.replace(/^module:/, '') === entryPath)
  assert.equal(entry?.format, 'commonjs', 'ERR_TEST_INFRASTRUCTURE: derived probe requires a fixed CommonJS app entry')
  const originalEntry = blobBytes.get(entry.sha256)
  assert.ok(originalEntry, 'Entry source blob is absent')
  assert.ok(!originalEntry.includes(Buffer.from('__workerSmoke')), 'Probe namespace collides with original app')
  const append = `\n// Harness-only derived AppService probe; never an upstream example assertion.\n`
    + `var __workerSmokeTicks = 0;\n`
    + `exports.__workerSmokeArmTimer = function () { __workerSmokeTicks = 0; setTimeout(function () { __workerSmokeTicks++; }, 50); return { ticks: __workerSmokeTicks, armed: true }; };\n`
    + `exports.__workerSmokeTimerState = function () { return { ticks: __workerSmokeTicks }; };\n`
    + `exports.__workerSmokeSpin = function () { for (;;) {} };\n`
  const changedEntry = Buffer.concat([originalEntry, utf8(append)]), entryHash = digest(changedEntry)
  const resource = utf8('Owned Worker resource boundary probe.\n'), resourceHash = digest(resource)
  const derived = structuredClone(manifest)
  derived.modules.find(module => module.id === entry.id).sha256 = entryHash
  const resourcePath = 'worker-smoke/owned-resource.txt'
  assert.ok(!derived.assets.some(asset => asset.path === resourcePath))
  derived.assets.push({ path: resourcePath, sha256: resourceHash, size: resource.length, mime: 'text/plain' })
  derived.integrity.root = ''
  derived.integrity.root = digest(canonical(derived))
  const derivedBytes = utf8(canonical(derived))
  // Original bytes remain in their original URLs. Relative ../ references are
  // confined by the static URL same-origin policy and resolve inside this site.
  const derivedIndex = { ...index, manifest: './manifest.json', manifestSize: derivedBytes.length, manifestSha256: digest(derivedBytes), integrityRoot: derived.integrity.root,
    blobs: [...index.blobs.map(blob => ({ ...blob, url: `../${blob.url}` })),
      { sha256: entryHash, size: changedEntry.length, url: `./blobs/${entryHash}` },
      { sha256: resourceHash, size: resource.length, url: `./blobs/${resourceHash}` }] }
  const derivedIndexBytes = utf8(derivedIndex)
  await retain('probe/manifest.json', derivedBytes, { source: 'derived-probe-manifest' })
  await retain(`probe/blobs/${entryHash}`, changedEntry, { source: 'derived-app-entry' })
  await retain(`probe/blobs/${resourceHash}`, resource, { source: 'derived-resource' })
  await retain('probe/pack-index.json', derivedIndexBytes, { source: 'derived-probe-index' })
  await writeFile(resolve(out, 'probe-append.js'), append, { flag: 'wx' })
  const provenance = { schemaVersion: 1, commit, buildReportSha256: digest(reportBytes), source: build.source,
    wasm: build.artifacts, rendererDependencies: { ...dependencies, execution: 'not-run' },
    originalPack: { indexSha256: digest(indexBytes), indexSize: indexBytes.length, manifestSha256: index.manifestSha256, integrityRoot: index.integrityRoot },
    derivedProbe: { classification: 'synthetic-derived-AppService-fixture', entryModuleId: entry.id,
      originalSourceSha256: entry.sha256, appendedSourceSha256: digest(append), derivedSourceSha256: entryHash,
      manifestSha256: digest(derivedBytes), integrityRoot: derived.integrity.root, indexSha256: digest(derivedIndexBytes), indexSize: derivedIndexBytes.length,
      resourceSha256: resourceHash, resourceSize: resource.length,
      transformation: 'Append explicit synchronous CommonJS timer/deadline exports; replace only entry module digest; add one declared asset; blank integrity.root, canonicalize UTF-8 keys and SHA-256; regenerate manifest and index. Original pack and all original blobs are retained unchanged.' } }
  assert.equal((await git(repository, ['rev-parse', 'HEAD'])).toString().trim(), commit)
  assert.equal((await git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length, 0, 'Repository changed during staging')
  return { site, inventory, provenance, retain }
}

/** Runs in the browser main thread. Only runtime-worker.mjs imports WASM. No
 * canvas, DOM presenter, frame ACK, main-thread host or app.mjs is constructed.
 */
async function browserProbe(inputs) {
  const result = { status: 'running', checks: {}, workers: [], events: [], failures: [],
    presentation: { status: 'not-run', acknowledgementSent: false, reason: 'Frame export and pending View resource checks only; no presenter.' } }
  const { WorkerRpcClient } = await import('./worker-session-client.mjs')
  const { routeStyleIds } = await import('./render-inputs.mjs')
  const owned = []
  let sequence = 0, beats = 0
  const pulse = setInterval(() => { beats++ }, 10)
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  const failure = error => ({ code: error.code, message: error.message || String(error) })
  const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
      : JSON.stringify(value)
  const rejected = async action => {
    try { await action(); throw new Error('Expected an explicit operation rejection') }
    catch (error) { if (error.message === 'Expected an explicit operation rejection') throw error; return failure(error) }
  }
  const start = label => {
    const record = { label, createdAt: performance.now(), terminateCount: 0, eventCount: 0 }
    const client = new WorkerRpcClient({ workerUrl: './runtime-worker.mjs', timeoutMs: 10_000, closeTimeoutMs: 2_000,
      workerFactory: (url, options) => {
        const worker = new Worker(url, options), terminate = worker.terminate.bind(worker)
        record.url = new URL(url, location.href).href; record.name = options.name; record.type = options.type
        worker.terminate = () => { record.terminateCount++; terminate() }
        return worker
      },
      onEvent: envelope => {
        record.eventCount++
        if (result.events.length < 256) result.events.push({ label, ...envelope })
      },
      onFailure: error => result.failures.push({ label, ...failure(error) }),
    })
    const handle = { client, record, label }
    owned.push(handle); result.workers.push(record)
    return handle
  }
  const close = async (handle, expectedFault = handle.expectedPriorFault ?? null) => {
    const closed = await handle.client.close()
    handle.record.close = { receipt: closed, state: handle.client.state, pendingCount: handle.client.pendingCount,
      inFlightBytes: handle.client.inFlightBytes, expectedPriorFault: [], cleanupErrors: [] }
    const classified = handle.record.close
    check(closed.closed === true, `${handle.label} has no correlated close receipt`)
    check(Array.isArray(closed.diagnostics), `${handle.label} close has no diagnostics array`)
    for (const diagnostic of closed.diagnostics) {
      if (!diagnostic || typeof diagnostic.phase !== 'string' || diagnostic.code !== undefined || diagnostic.message !== undefined
        || !Array.isArray(diagnostic.batch?.messages)) {
        classified.cleanupErrors.push(diagnostic); continue
      }
      for (const message of diagnostic.batch.messages) {
        if (message.payload?.ok !== false && message.kind !== 'error' && message.op !== 'error') continue
        const error = message.payload?.error ?? message.error
        const priorFault = diagnostic.phase === 'retire' && expectedFault?.code === 'ERR_TIMEOUT'
          && message.sessionId === handle.client.sessionId
        if (priorFault && error?.code === 'ERR_TIMEOUT' && stable(error) === stable(expectedFault)) {
          classified.expectedPriorFault.push({ classification: 'original-execution-fault', phase: diagnostic.phase, message })
        } else if (priorFault && message.protocolVersion === '1.0' && message.kind === 'response'
          && message.op === 'error' && message.requestId === '' && message.payload?.ok === false
          && message.payload.requiresRestart === true && error?.code === 'ERR_ENGINE'
          && error.message === `AppService requires a new session after ${expectedFault.code}: ${expectedFault.message}`
          && error.retryable === false && !Object.hasOwn(error, 'request_id')
          && Object.keys(error).sort().join(',') === 'code,message,retryable') {
          classified.expectedPriorFault.push({ classification: 'prior-fault-restart-rejection', phase: diagnostic.phase, message })
        } else classified.cleanupErrors.push({ phase: diagnostic.phase, message })
      }
    }
    check(classified.cleanupErrors.length === 0, `${handle.label} close cleanup failed: ${JSON.stringify(classified.cleanupErrors)}`)
    check(handle.client.state === 'closed', `${handle.label} did not close cleanly`)
    check(handle.record.terminateCount === 1, `${handle.label} did not terminate its exact Worker exactly once`)
    check(handle.client.pendingCount === 0 && handle.client.inFlightBytes === 0, `${handle.label} leaked request reservations`)
    return closed
  }
  const bridge = async (handle, op, payload) => {
    const requestId = `smoke-inner-${++sequence}`
    const batch = await handle.client.requestHost('bridge', { envelope: { protocolVersion: '1.0', sessionId: handle.client.sessionId,
      requestId, kind: 'request', op, payload } })
    const responses = batch.messages.filter(message => message.kind === 'response' && message.sessionId === handle.client.sessionId
      && message.requestId === requestId && message.op === op)
    check(responses.length === 1, `Missing correlated ${op} response`)
    return { batch, response: responses[0].payload }
  }
  const okay = value => { check(value.response.ok === true, JSON.stringify(value)); return value.response }
  const load = (handle, probe, renderer) => handle.client.requestHost('load', {
    indexUrl: probe ? './probe/pack-index.json' : './pack-index.json',
    indexSha256: probe ? inputs.derivedProbe.indexSha256 : inputs.originalPack.indexSha256,
    indexSize: probe ? inputs.derivedProbe.indexSize : inputs.originalPack.indexSize,
    renderer, engine: 'quickjs', viewport: { width: 375, height: 667 },
    engineExecution: { bootstrapTimeoutMs: 5000, turnTimeoutMs: 250 }, loadTimeoutMs: 30_000,
  }, { timeoutMs: 45_000 })
  window.__workerSmokeCleanup = async () => {
    const outcomes = []
    for (const handle of owned.toReversed()) {
      try {
        if (handle.client.state === 'open' || handle.client.state === 'closing') await close(handle)
        outcomes.push({ label: handle.label, state: handle.client.state, terminateCount: handle.record.terminateCount })
      } catch (error) { outcomes.push({ label: handle.label, state: handle.client.state, ...failure(error), terminateCount: handle.record.terminateCount }) }
    }
    return outcomes
  }
  try {
    const original = start('original-pack-frame-export')
    const loaded = await load(original, false, 'external-frame')
    check(loaded.capabilities.quickjs === true, 'Real QuickJS WASM provider absent')
    check(loaded.state.currentPage?.path === loaded.manifest.routes[0].path, 'Original route mismatch')
    check(loaded.state.sessionId === original.client.sessionId && !loaded.state.requiresRestart, 'Initial state is invalid')
    const frame = await original.client.requestHost('frame', {})
    check(frame.frame.root && frame.frame.viewport.width === 375 && frame.frame.viewport.height === 667, 'Missing actual runtime frame export')
    const unchanged = await original.client.requestHost('frame.current', {})
    check(JSON.stringify(unchanged.frame) === JSON.stringify(frame.frame), 'Read-only current frame changed')
    const metrics = await original.client.requestHost('metrics', { windowWidth: 667, windowHeight: 375, pixelRatio: 2,
      screenWidth: 667, screenHeight: 375, statusBarHeight: 0, screenTop: 0, deviceOrientation: 'landscape' })
    check(!metrics.messages.some(message => message.payload?.ok === false), 'Window metrics failed')
    const resized = await original.client.requestHost('frame', {})
    check(resized.frame.viewport.width === 667 && resized.frame.viewport.height === 375, 'Metrics did not update exported logical viewport')
    okay(await bridge(original, 'app.lifecycle', { event: 'hide' }))
    okay(await bridge(original, 'app.lifecycle', { event: 'show' }))
    result.checks.originalPack = { status: 'passed', loaded: { state: loaded.state, capabilities: loaded.capabilities, pack: loaded.pack },
      frame, resized, presentation: 'not-presented', close: await close(original) }

    const probe = start('derived-AppService-timer-deadline')
    const probeLoaded = await load(probe, true, 'external-frame')
    const call = name => bridge(probe, 'module.call', { moduleId: inputs.derivedProbe.entryModuleId, export: name, args: [] })
    const armed = okay(await call('__workerSmokeArmTimer')).result[0]
    check(armed.armed === true && armed.ticks === 0, 'Worker timer was not armed without firing synchronously')
    const timerStart = performance.now()
    let timerState
    do {
      await delay(25)
      timerState = okay(await call('__workerSmokeTimerState')).result[0]
      check(performance.now() - timerStart < 3_000, 'Worker timer did not fire without RAF')
    } while (timerState.ticks === 0)
    check(timerState.ticks === 1, 'Worker timer fired more than once')
    const ticksBefore = beats, attackStart = performance.now()
    const attack = await call('__workerSmokeSpin')
    const elapsed = performance.now() - attackStart, ticksDuring = beats - ticksBefore
    check(attack.response.ok === false && attack.response.error?.code === 'ERR_TIMEOUT' && attack.response.requiresRestart === true,
      `Unbounded call failed to produce the original deadline fault: ${JSON.stringify(attack.response)}`)
    check(ticksDuring > 0, 'Main-thread event loop made no progress while Worker AppService ran')
    const state = await probe.client.requestHost('state', {})
    check(state.requiresRestart && state.executionFault?.code === 'ERR_TIMEOUT', 'Fault state was not retained')
    probe.expectedPriorFault = state.executionFault
    const blockedFrame = await rejected(() => probe.client.requestHost('frame', {}))
    check(blockedFrame.code === 'ERR_ENGINE', 'Fault allowed a new frame')
    const diagnostic = await bridge(probe, 'diagnostic', { message: 'Worker smoke fault state inspection' })
    check(diagnostic.response.ok === true && diagnostic.response.executionFault?.code === 'ERR_TIMEOUT',
      'Pure diagnostic control did not preserve the execution fault')
    result.checks.derivedAppService = { status: 'passed', provenance: 'derived-probe-only', stateAtLoad: probeLoaded.state,
      armed, timerState, attack, state, blockedFrame, diagnostic, mainThreadTicksDuringAttack: ticksDuring,
      observedAttackWallMs: elapsed, wallTimeClassification: 'diagnostic-only-not-performance-acceptance', close: await close(probe) }

    const resources = start('derived-pending-View-resource')
    const resourceLoaded = await load(resources, true, 'browser-view')
    const route = resourceLoaded.manifest.routes.find(route => route.path === resourceLoaded.state.currentPage.path)
    const prepared = okay(await bridge(resources, 'view.prepare', { version: '1.0', surfaceGeneration: '1', render: {
      frameId: 1, templateId: `template:${route.path}.wxml`, useSessionResources: true,
      viewport: { x: 0, y: 0, width: 375, height: 667 }, styleIds: routeStyleIds(resourceLoaded.manifest, route),
    } }))
    const key = prepared.submission.key
    const resource = await resources.client.requestHost('resource', { key, sha256: inputs.derivedProbe.resourceSha256 })
    check(resource.bytes instanceof ArrayBuffer && resource.bytes.byteLength === inputs.derivedProbe.resourceSize, 'Resource transfer bytes are invalid')
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', resource.bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
    check(hash === inputs.derivedProbe.resourceSha256, 'Transferred resource hash mismatch')
    const stale = { ...key, surfaceGeneration: String(BigInt(key.surfaceGeneration) + 1n) }
    const staleError = await rejected(() => resources.client.requestHost('resource', { key: stale, sha256: hash }))
    check(staleError.code === 'ERR_CANCELLED', `Stale resource read returned an unexpected error: ${JSON.stringify(staleError)}`)
    const retained = await resources.client.requestHost('resource', { key, sha256: hash })
    check(retained.bytes instanceof ArrayBuffer && retained.bytes.byteLength === inputs.derivedProbe.resourceSize,
      'A rejected stale key invalidated the retained valid resource')
    const retainedHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', retained.bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
    check(retainedHash === hash, 'Valid resource bytes changed after a rejected stale read')
    const aborted = await resources.client.requestHost('view.abort', { key })
    check(aborted.messages.some(message => message.op === 'view.abort' && message.payload?.ok === true), 'Candidate abort was not accepted')
    const revokedError = await rejected(() => resources.client.requestHost('resource', { key, sha256: hash }))
    check(revokedError.code === 'ERR_CANCELLED', `Revoked resource read returned an unexpected error: ${JSON.stringify(revokedError)}`)
    const retired = await resources.client.requestHost('view.retire', { reason: 'smoke-without-presentation' })
    result.checks.derivedResources = { status: 'passed', provenance: 'derived-probe-only', presentation: 'prepared-only-never-acknowledged',
      key, bytes: resource.bytes.byteLength, sha256: hash, staleError,
      validReadAfterStaleFailure: { bytes: retained.bytes.byteLength, sha256: retainedHash }, revokedError, retired, close: await close(resources) }
    check(result.failures.length === 0, 'Worker transport recorded failures')
    result.status = 'passed'
  } catch (error) {
    result.status = 'failed'; result.error = error.stack || String(error)
  } finally {
    clearInterval(pulse)
    result.cleanup = await window.__workerSmokeCleanup()
    if (result.cleanup.some(value => value.state !== 'closed' || value.terminateCount !== 1 || value.code)) result.status = 'failed'
  }
  return result
}

/** Own one ephemeral server/browser/context/page. Native Playwright Worker
 * close events independently confirm the browser released created Workers.
 */
export async function runWorkerWasmSmoke(options, { chromium, signal = options.signal } = {}) {
  const out = resolve(await realpath(dirname(resolve(options.outDir))), basename(options.outDir))
  const sourceSite = await realpath(options.siteDir)
  assert.ok(!inside(out, sourceSite) && !inside(sourceSite, out), 'Resolved input and output paths must remain separate')
  await mkdir(out, { recursive: false })
  const report = { schemaVersion: 1, status: 'running', scope: 'real-module-Worker-QuickJS-WASM-boundary-smoke', headless: true,
    startedAt: new Date().toISOString(), requests: [], workerLifetimes: [], pageErrors: [], console: [], cleanup: {},
    limitations: ['Original pack load and frame export are separate from derived timer/deadline/resource probes.',
      'No presenter, frame ACK, DOM layout, CanvasKit/GPU, physical GPU, DevTools, seven-host conformance or performance acceptance.',
      'Worker cancellation cannot preempt executing WASM; the AppService execution deadline is the interruption boundary.'] }
  let server, browser, context, page, stage, cleanupFailed = false, abortClose
  const cleanup = async (name, action) => {
    try { report.cleanup[name] = await action() }
    catch (error) { cleanupFailed = true; report.cleanup[`${name}Error`] = error.stack || String(error) }
  }
  const abort = () => {
    report.cancellation ??= { reason: String(signal?.reason?.message ?? signal?.reason ?? 'aborted'), at: new Date().toISOString() }
    if (page && !page.isClosed() && !abortClose) abortClose = cleanup('cancelledPageClosed', async () => {
      await page.close({ runBeforeUnload: false }); return page.isClosed()
    })
  }
  const checkCancelled = () => { if (signal?.aborted) { abort(); throw new Error('ERR_CANCELLED: smoke cancelled') } }
  signal?.addEventListener('abort', abort)
  try {
    checkCancelled()
    stage = await stageWorkerSite(options, out)
    report.provenance = stage.provenance
    const pageSource = utf8(`window.__workerSmokeResult = null;\n(${browserProbe.toString()})(${JSON.stringify(stage.provenance)}).then(\n`
      + `value => { window.__workerSmokeResult = value; document.querySelector('pre').textContent = JSON.stringify(value, null, 2); },\n`
      + `error => { window.__workerSmokeResult = {status:'failed',error:error.stack || String(error)}; }\n);\n`)
    await stage.retain('smoke-page.mjs', pageSource, { source: 'this-harness-browserProbe', sha256: digest(pageSource) })
    await stage.retain('index.html', utf8('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Weapp Container Worker Boundary Smoke</title><pre>Running isolated Worker boundary smoke…</pre><script type="module" src="./smoke-page.mjs"></script>'), { source: 'this-harness' })
    await save(resolve(out, 'site-inventory.json'), stage.inventory)
    await save(resolve(out, 'provenance.json'), stage.provenance)
    checkCancelled()
    if (!chromium) {
      const modulePath = process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || resolve(options.repository, 'vendor/weapp-vite/node_modules/playwright/index.mjs')
      try { ({ chromium } = await import(pathToFileURL(resolve(modulePath)).href)) }
      catch (error) { throw new Error(`ERR_TEST_INFRASTRUCTURE: installed Playwright unavailable: ${error.message}`) }
    }
    server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1'), path = decodeURIComponent(url.pathname)
        if (report.requests.length >= 10_000) throw new Error('Request evidence budget exceeded')
        report.requests.push({ method: request.method, path })
        if (path.replaceAll('\\', '/').split('/').includes('api')) { response.writeHead(403).end('Runtime HTTP APIs are forbidden'); return }
        const file = path === '/' ? 'index.html' : path.slice(1)
        if (request.method !== 'GET' || !Object.hasOwn(stage.inventory, file)) { response.writeHead(404).end(); return }
        const bytes = await regularBytes(stage.site, file)
        assert.equal(digest(bytes), stage.inventory[file].sha256, 'Staged served bytes changed')
        response.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
          '.wasm': 'application/wasm', '.json': 'application/json', '.ttf': 'font/ttf' }[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(bytes)
      } catch (error) { report.serverError ??= error.stack || String(error); response.writeHead(500).end() }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    report.url = `http://127.0.0.1:${server.address().port}/`
    checkCancelled()
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    report.browserVersion = browser.version()
    checkCancelled()
    context = await browser.newContext({ viewport: { width: 1000, height: 700 }, serviceWorkers: 'block' })
    report.blockedRequests = []
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== new URL(report.url).origin || decodeURIComponent(url.pathname).replaceAll('\\', '/').split('/').includes('api')) {
        report.blockedRequests.push(url.href); await route.abort('blockedbyclient')
      } else await route.continue()
    })
    page = await context.newPage()
    page.on('worker', worker => {
      const record = { url: worker.url(), createdAt: new Date().toISOString(), closed: false }
      report.workerLifetimes.push(record)
      worker.on('close', () => { record.closed = true; record.closedAt = new Date().toISOString() })
    })
    page.on('pageerror', error => report.pageErrors.push(error.stack || String(error)))
    page.on('console', message => { if (report.console.length < 100) report.console.push({ type: message.type(), text: message.text() }) })
    checkCancelled()
    await page.goto(report.url, { waitUntil: 'load', timeout: 30_000 })
    await page.waitForFunction(() => !!window.__workerSmokeResult?.status && window.__workerSmokeResult.status !== 'running', null, { timeout: 120_000 })
    report.execution = await page.evaluate(() => window.__workerSmokeResult)
    await save(resolve(out, 'browser-execution.json'), report.execution)
    assert.equal(report.execution.status, 'passed', report.execution.error)
    assert.deepEqual(report.blockedRequests, [], 'The Worker attempted nonstatic /api or external runtime requests')
    assert.ok(report.requests.every(item => !item.path.replaceAll('\\', '/').split('/').includes('api')))
    assert.ok(report.requests.every(item => item.path !== '/app.mjs'), 'The smoke loaded the main-thread AppService app')
    assert.ok(report.requests.some(item => item.path === '/runtime-worker.mjs'))
    assert.ok(report.requests.some(item => item.path === '/pkg/container_host_web_bg.wasm'))
    assert.equal(report.workerLifetimes.length, 3)
    assert.equal(report.serverError, undefined)
    assert.deepEqual(report.pageErrors, [])
    checkCancelled()
    report.status = 'passed'
  } catch (error) {
    report.status = signal?.aborted ? 'cancelled' : /ERR_TEST_INFRASTRUCTURE/.test(error.message) ? 'blocked' : 'failed'
    report.error = error.stack || String(error)
  } finally {
    if (signal?.aborted) abort()
    if (abortClose) await abortClose
    if (!signal?.aborted && page && !page.isClosed()) await cleanup('workers', () => page.evaluate(async () => window.__workerSmokeCleanup?.() ?? []))
    if (context) await cleanup('contextClosed', async () => { await context.close(); return true })
    if (browser) await cleanup('browserClosed', async () => { await browser.close(); return !browser.isConnected() })
    if (server?.listening) await cleanup('serverClosed', async () => {
      await new Promise((done, reject) => {
        server.close(error => error ? reject(error) : done())
        server.closeAllConnections() // This one owned ephemeral server only.
      })
      return !server.listening
    })
    signal?.removeEventListener('abort', abort)
    if (report.workerLifetimes.some(worker => !worker.closed)) { cleanupFailed = true; report.cleanup.workerCloseUnverified = true }
    if (cleanupFailed) report.status = 'failed'
    else if (signal?.aborted) report.status = 'cancelled'
    report.finishedAt = new Date().toISOString()
    report.harness = { path: fileURLToPath(import.meta.url), sha256: digest(await readFile(fileURLToPath(import.meta.url))) }
    await save(resolve(out, 'execution.json'), report)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  const interrupt = signalName => () => controller.abort(Object.assign(new Error(`Received ${signalName}`), { signalName }))
  const onInt = interrupt('SIGINT'), onTerm = interrupt('SIGTERM')
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
  try {
    const report = await runWorkerWasmSmoke(parseArgs(process.argv.slice(2)), { signal: controller.signal })
    console.log(JSON.stringify({ status: report.status, error: report.error, cleanup: report.cleanup }))
    if (report.status !== 'passed') process.exitCode = report.status === 'cancelled' ? controller.signal.reason?.signalName === 'SIGTERM' ? 143 : 130 : 1
  } catch (error) { console.error(error.stack || String(error)); process.exitCode = 1 }
  finally { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm) }
}
