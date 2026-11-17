#!/usr/bin/env node
/** Real release-binary/browser evidence for presentation controls. The caller
 * owns this run; it never connects to or replaces an existing simulator. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, loadavg, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connectDevEvents, installSmokeSignals, readDevSessionPaths, startDevSimulator } from './simulator-dev-harness.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const sleep = ms => new Promise(done => setTimeout(done, ms))
const serializeError = error => ({ name: error.name, message: error.message, stack: error.stack })
const renderScales = [1, 1.5, 2, 3, 4]
const displayZooms = [.5, 1, 2]
const alphaCheckName = scale => `scale${scale}TransparentRgba`
const inputCheckName = (scale, zoom) => `scale${scale}Zoom${zoom}Input`
const requiredChecks = ['headlessFixedDefaults', 'savedPreferencesAfterRestart', 'explicitCliOverridesPreferences',
  ...renderScales.map(alphaCheckName),
  ...renderScales.flatMap(scale => displayZooms.map(zoom => inputCheckName(scale, zoom))),
  'restore2xBeforeHmr', 'browserZoomRestoresLocally', 'wxssHmrAt2x', 'wxmlHmrAt2x', 'samePreviewLiveDpr', 'activePreviewAutoDpr']

export function parseOptions(args) {
  const options = { binary: join(root, 'target', 'release', process.platform === 'win32' ? 'weapp-simulator.exe' : 'weapp-simulator'), engine: 'quickjs' }
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (name === '--help' || name === '-h') return { help: true }
    if (!['--simulator-bin', '--out', '--engine', '--wv-bin'].includes(name)) throw new Error(`unknown option: ${name}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    options[({ '--simulator-bin': 'binary', '--out': 'out', '--engine': 'engine', '--wv-bin': 'wvBin' })[name]] = value
  }
  if (!options.out) throw new Error('--out must name a new evidence directory')
  if (!['quickjs', 'v8'].includes(options.engine)) throw new Error('--engine requires quickjs or v8')
  for (const key of ['binary', 'out', 'wvBin']) if (options[key]) options[key] = resolve(options[key])
  return options
}

// exec preserves the harness-owned PID; quoting treats the path as data even
// when a local checkout contains spaces, quotes or shell metacharacters.
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`
export function explicitLauncherSource(binary) {
  return `#!/bin/sh\nexec ${shellQuote(binary)} "$@" --render-scale 2 --fps 60\n`
}

export function logicalPoint(bounds, point, viewport) {
  assert.ok(bounds?.width > 0 && bounds.height > 0 && viewport.width > 0 && viewport.height > 0)
  return { x: bounds.x + point.x * bounds.width / viewport.width,
    y: bounds.y + point.y * bounds.height / viewport.height }
}

export function exclusiveFocus(active, inactive) {
  return active.focused && active.visibility === 'visible' && !active.hidden && !inactive.focused
}

export const selectorFieldsQuery = selector => ({ selector, operation: 'fields', fields: { id: true, rect: true, size: true, scrollOffset: true } })
export function scrollTop(geometry) {
  assert.ok(Number.isFinite(geometry?.scrollTop), `selector scrollOffset must be finite: ${JSON.stringify(geometry)}`)
  return geometry.scrollTop
}
export function wheelDriverDelta(logicalDelta, cssSize, logicalSize, dpr) {
  assert.ok([logicalDelta, cssSize, logicalSize, dpr].every(Number.isFinite) && cssSize > 0 && logicalSize > 0 && dpr > 0)
  // Chromium's CDP wheel driver uses device pixels. The observed trusted DOM
  // wheel event below must independently prove the intended logical delta.
  return logicalDelta * cssSize / logicalSize * dpr
}

/** Failure diagnostics must retain independent runtime/browser observations
 * even when one surface is already unavailable. No observer may hide another. */
export async function collectObservedEvidence(collectors) {
  const entries = Object.entries(collectors)
  const results = await Promise.allSettled(entries.map(([, observe]) => Promise.resolve().then(observe)))
  return Object.fromEntries(results.map((result, index) => [entries[index][0], result.status === 'fulfilled'
    ? result.value : { observationError: serializeError(result.reason) }]))
}

const fixtureScript = `Page({
  data: { count: 0 },
  onLoad() { wx.setStorageSync('controls:count', 0); wx.setStorageSync('controls:loads', (wx.getStorageSync('controls:loads') || 0) + 1); },
  onTap() { this.setData({ count: this.data.count + 1 }); wx.setStorageSync('controls:count', this.data.count); },
  onScroll(event) { wx.setStorageSync('controls:scroll', { top: event.detail.scrollTop, left: event.detail.scrollLeft }); }
})\n`
const fixtureWxml = `<view id="tap" class="tap" bindtap="onTap">Increment</view>
<text id="counter" class="counter">Count: {{count}}</text>
<view id="hmr-marker" class="hmr-marker">HMR baseline</view>
<view id="alpha-half" class="alpha-half"/><view id="alpha-zero" class="alpha-zero"/><view id="alpha-opaque" class="alpha-opaque"/>
<scroll-view id="controls-scroll" class="controls-scroll" scroll-y bindscroll="onScroll"><view class="scroll-content">${Array.from({ length: 100 }, (_, index) => `<view class="stripe" style="background:${index % 2 ? '#167c63' : '#1c426a'}">Row ${index}</view>`).join('')}</view></scroll-view>\n`
const fixtureWxss = `.tap { position:absolute;left:20px;top:20px;width:180px;height:40px;background:#2050a0;color:white; }
.counter { position:absolute;display:block;left:20px;top:70px;width:250px;height:30px;font-size:22px;color:#102030; }
.hmr-marker { position:absolute;left:20px;top:105px;width:300px;height:26px;background:#112233;color:white;font-size:18px; }
.controls-scroll { position:absolute;left:20px;top:145px;width:320px;height:180px; }
.scroll-content { height:4000px; }
.stripe { height:40px;color:white; }
.alpha-half { position:absolute;left:20px;top:360px;width:40px;height:40px;background:rgba(255,0,0,0.5); }
.alpha-zero { position:absolute;left:80px;top:360px;width:40px;height:40px;background:rgba(10,200,100,0); }
.alpha-opaque { position:absolute;left:140px;top:360px;width:40px;height:40px;background:rgb(20,40,80); }\n`

async function runHeadless(binary, args, { cwd, signal, report }) {
  signal.throwIfAborted()
  const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', exited = false, spawnError
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-128 * 1024) })
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-128 * 1024) })
  const done = new Promise(resolve => {
    child.once('error', error => { spawnError = error; exited = true; resolve() })
    child.once('close', (code, exitSignal) => { exited = true; report.code = code; report.signal = exitSignal; resolve() })
  })
  const abort = () => { if (!exited) child.kill('SIGTERM') }
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => { report.timedOut = true; abort() }, 30_000)
  // A misbehaving owned subprocess must not outlive the script's finally.
  const forced = setTimeout(() => { if (!exited) { report.forcedTermination = true; child.kill('SIGKILL') } }, 35_000)
  report.pid = child.pid
  try {
    await done
    signal.throwIfAborted()
    if (spawnError) throw spawnError
    assert.ok(!report.timedOut, 'headless subprocess exceeded 30 second deadline')
    assert.equal(report.code, 0, output)
    return output
  } finally {
    clearTimeout(timeout); clearTimeout(forced); signal.removeEventListener('abort', abort)
    report.processExited = exited
    report.outputTail = output.slice(-4000)
  }
}

export async function runControlsSmoke(options) {
  await mkdir(options.out) // Refuse to overwrite historical evidence.
  const owned = await mkdtemp(join(tmpdir(), 'weapp-presentation-controls-'))
  const project = join(owned, 'reference-app')
  const signals = installSmokeSignals()
  let simulator, stream, browser, context, page, secondaryPage
  let requestSequence = 0
  const report = { schemaVersion: 1, status: 'failed', generatedAt: new Date().toISOString(),
    engine: options.engine, scope: 'real release CPU Skia + headless Chromium development controls; no official/GPU/device claim',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    environment: { platform: process.platform, arch: process.arch, node: process.version, cpu: cpus()[0]?.model, loadAverageStart: loadavg() },
    resources: { createdByThisRun: true, project, headless: true, maxPages: 2, simulatorRuns: [], bridgeSseCreated: 0 },
    coverage: { renderScales, displayZooms, inputCombinations: renderScales.length * displayZooms.length, requiredChecks },
    checks: {}, browserErrors: [], browserInputs: [], presentationRequests: [], presentationResponses: [], cleanup: { runs: [], errors: [], bridgeSseClosed: 0 } }
  const screenshot = async (target, name) => {
    const path = join(options.out, `${name}.png`)
    await target.screenshot({ path, fullPage: true })
    return { path, sha256: sha256(await readFile(path)) }
  }
  const check = async (name, fn) => {
    try { report.checks[name] = { status: 'passed', ...await fn() } }
    catch (error) { report.checks[name] = { ...report.checks[name], status: error.code === 'ERR_FOCUS_UNOBSERVABLE' ? 'blocked' : 'failed', error: serializeError(error) } }
  }
  async function stopRun() {
    const errors = []
    if (stream) {
      try { await stream.close(); report.cleanup.reloadSse = 'closed' } catch (error) { errors.push(error) }
      stream = undefined
    }
    if (simulator) {
      const ownedRun = simulator
      simulator = undefined
      try { report.cleanup.runs.push({ pid: ownedRun.child.pid, url: ownedRun.url, ...await ownedRun.stop() }) }
      catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '))
  }
  async function startRun(launcher = options.binary, viewport) {
    simulator = await startDevSimulator({ root, project, engine: options.engine, port: 0, timeoutMs: 120_000,
      launcher: { mode: 'simulator', command: launcher }, viewport, wvBin: options.wvBin, signal: signals.signal })
    const state = await simulator.waitForState(value => value.status === 'ready' && value.revision > 0, 'initial generation')
    report.resources.simulatorRuns.push({ pid: simulator.child.pid, url: simulator.url, launcher, viewport, initialState: state })
    return state
  }
  async function apply(patch) {
    const before = await simulator.json('/api/presentation')
    const requestId = `controls-settings-${++requestSequence}`
    const receipt = await simulator.json('/api/presentation', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...patch, revision: before.revision, requestId }) })
    assert.equal(receipt.queued, true)
    const state = await simulator.waitForState(value => value.presentation?.revision > before.revision, 'committed presentation')
    for (const [key, value] of Object.entries(patch)) if (key !== 'devicePixelRatio') assert.equal(state.presentation[key], value)
    return state.presentation
  }
  async function bridge(name, payload = {}) {
    const current = await simulator.json('/api/state')
    const requestId = `controls-api-${++requestSequence}`
    const responseStream = await connectDevEvents(simulator.url, 15_000, { signal: signals.signal })
    report.resources.bridgeSseCreated++
    try {
      const response = responseStream.nextEvent('bridge', batch => batch.messages?.some(message => message.requestId === requestId && message.kind === 'response'))
      response.catch(() => {})
      await simulator.json('/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocolVersion: '1.0', sessionId: current.sessionId, requestId, kind: 'request', op: 'api.call', payload: { name, ...payload } }) })
      const batch = await response
      const message = batch.messages.find(message => message.requestId === requestId && message.kind === 'response')
      assert.equal(message?.payload?.ok, true, JSON.stringify(batch))
      return message.payload.result
    } finally { await responseStream.close(); report.cleanup.bridgeSseClosed++ }
  }
  const storage = key => bridge('wx.getStorageSync', { key })
  async function query(selector) {
    const value = await bridge('wx.createSelectorQuery', selectorFieldsQuery(selector))
    const box = Array.isArray(value) ? value[0] : value
    assert.ok(box?.width > 0 && box.height > 0, JSON.stringify(value))
    return box
  }
  async function waitForPixels(target = page) {
    const current = await simulator.json('/api/state')
    await target.waitForFunction(({ sessionId, presentation: p }) => {
      const m = globalThis.__weappPresentationMetrics
      return m?.sessionId === sessionId && m.configGeneration === p.generation
        && m.width === Math.ceil(p.logicalWidth * p.effectiveScale) && m.height === Math.ceil(p.logicalHeight * p.effectiveScale)
    }, current, { timeout: 20_000 })
    return target.evaluate(() => ({ ...globalThis.__weappPresentationMetrics, frames: undefined, samples: undefined }))
  }
  async function point(x, y, target = page) {
    const p = await simulator.json('/api/presentation')
    return logicalPoint(await target.locator('#screen').boundingBox(), { x, y }, { width: p.logicalWidth, height: p.logicalHeight })
  }
  async function pixels(region, target = page) {
    return target.evaluate(region => {
      const canvas = document.querySelector('#screen'), metrics = globalThis.__weappPresentationMetrics
      const sx = canvas.width / metrics.logicalWidth, sy = canvas.height / metrics.logicalHeight
      const rgba = canvas.getContext('2d').getImageData(Math.floor(region.left * sx), Math.floor(region.top * sy),
        Math.max(1, Math.floor(region.width * sx)), Math.max(1, Math.floor(region.height * sy))).data
      let digest = 2166136261
      for (const value of rgba) digest = Math.imul(digest ^ value, 16777619) >>> 0
      return { digest, frameId: metrics.frameId, firstPixel: Array.from(rgba.subarray(0, 4)) }
    }, region)
  }
  async function waitForChange(region, previous) {
    const deadline = Date.now() + 15_000
    let current
    do {
      current = await pixels(region)
      if (current.digest !== previous.digest) return current
      await sleep(25); signals.signal.throwIfAborted()
    } while (Date.now() < deadline)
    assert.notEqual(current.digest, previous.digest, 'actual rendered pixel region must change')
  }
  async function waitScroll(expected) {
    assert.ok(Number.isFinite(expected), 'expected logical scroll offset must be finite before polling')
    const deadline = Date.now() + 15_000
    let geometry
    do {
      geometry = await query('#controls-scroll')
      if (Math.abs(scrollTop(geometry) - expected) < .2) return geometry
      await sleep(25); signals.signal.throwIfAborted()
    } while (Date.now() < deadline)
    assert.ok(Math.abs(geometry.scrollTop - expected) < .2, `logical scrollTop ${geometry.scrollTop}; expected ${expected}`)
  }
  async function clickCounter() {
    const before = await storage('controls:count'), counter = await query('#counter'), tap = await query('#tap')
    const previous = await pixels(counter), from = report.browserInputs.length
    const logical = { x: tap.left + tap.width / 2, y: tap.top + tap.height / 2 }
    const native = await point(logical.x, logical.y)
    await page.mouse.click(native.x, native.y)
    const deadline = Date.now() + 15_000
    let count
    do { count = await storage('controls:count'); if (count === before + 1) break; await sleep(25) } while (Date.now() < deadline)
    assert.equal(count, before + 1, 'real Page handler must increment once')
    const changed = await waitForChange(counter, previous)
    const request = report.browserInputs.slice(from).find(envelope => envelope.payload.events.some(event => event.type === 'tap'
      && Math.abs(event.x - logical.x) < .2 && Math.abs(event.y - logical.y) < .2))
    assert.ok(request, 'actual browser bridge coordinates must match logical hit geometry')
    return { count, logical, native, pixelBefore: previous, pixelAfter: changed, requestId: request.requestId }
  }
  const browserPresentationObservation = target => target.evaluate(() => ({
    focused: document.hasFocus(), hidden: document.hidden, visibility: document.visibilityState, dpr: devicePixelRatio,
    width: innerWidth, height: innerHeight,
    currentDprQueryMatches: matchMedia(`(resolution: ${devicePixelRatio}dppx)`).matches,
    probe: globalThis.__controlsDprProbe ? { ...globalThis.__controlsDprProbe } : null,
    client: typeof presentation === 'undefined' ? null : {
      presentation: { ...presentation }, pendingPresentation, pendingPresentationRevision, inputSuspended, eventStreamClosed, terminalShutdown,
      densityQuery: densityMedia?.media, densityMatches: densityMedia?.matches, densityListenerInstalled: typeof densityListener === 'function',
      observedDensity: typeof observedDensity === 'undefined' ? null : observedDensity,
      densityTimerActive: typeof densityTimer !== 'undefined' && densityTimer !== null,
    },
    canvas: (() => { const canvas = document.querySelector('#screen'); return canvas ? { width: canvas.width, height: canvas.height } : null })(),
    metrics: globalThis.__weappPresentationMetrics ? { ...globalThis.__weappPresentationMetrics, frames: undefined, samples: undefined } : null,
    overlay: document.querySelector('#overlay')?.textContent,
  }))
  async function captureCheckObservation(name, phase, targets = { main: page }) {
    const observed = await collectObservedEvidence({ runtime: () => simulator.json('/api/state'), presentation: () => simulator.json('/api/presentation'),
      ...Object.fromEntries(Object.entries(targets).filter(([, target]) => target).map(([key, target]) => [key, () => browserPresentationObservation(target)])) })
    const holder = report.checks[name] ??= {}
    ;(holder.observations ??= []).push({ phase, capturedAt: new Date().toISOString(), ...observed })
    return observed
  }
  try {
    const bytes = await readFile(options.binary)
    report.binary = { path: options.binary, sha256: sha256(bytes), bytes: bytes.length }
    report.sourceTree = { dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
      diffSha256: sha256(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root })) }
    report.tools = {}
    for (const path of ['scripts/simulator-presentation-controls-smoke.mjs', 'scripts/simulator-dev-harness.mjs']) report.tools[path] = sha256(await readFile(join(root, path)))
    await cp(join(root, 'examples/apps/reference-app'), project, { recursive: true,
      filter: path => !['dist', '.weapp-container', '.weapp-vite', 'node_modules'].includes(basename(path)) })
    const pageRoot = join(project, 'pages/home/index')
    await writeFile(join(project, 'app.js'), 'App({})\n')
    await writeFile(join(project, 'app.wxss'), 'page { background:transparent; }\n')
    await writeFile(`${pageRoot}.json`, '{}\n')
    await writeFile(`${pageRoot}.js`, fixtureScript)
    await writeFile(`${pageRoot}.wxml`, fixtureWxml)
    await writeFile(`${pageRoot}.wxss`, fixtureWxss)
    report.fixture = { base: 'examples/apps/reference-app', extension: 'deterministic JS counter, striped scroll, HMR marker and transparent/half-alpha/opaque swatches over a transparent render clear; no WXS/custom components',
      scriptSha256: sha256(fixtureScript), wxmlSha256: sha256(fixtureWxml), wxssSha256: sha256(fixtureWxss) }

    await startRun()
    const saved = await apply({ logicalWidth: 400, logicalHeight: 700, renderScale: 1.5, fps: 30 })
    const preferences = JSON.parse(await readFile(join(project, '.weapp-container/presentation.json'), 'utf8'))
    assert.equal(preferences.logicalWidth, 400); assert.equal(preferences.renderScale, 1.5); assert.equal(preferences.fps, 30)
    const state = await simulator.json('/api/state')
    const paths = readDevSessionPaths(simulator.staging, simulator.child.pid, project)
    const headlessPath = join(owned, 'headless-report.json'), processReport = {}
    await check('headlessFixedDefaults', async () => {
      await runHeadless(options.binary, ['run', '--pack', join(paths.runRoot, `generation-${state.revision}`), '--engine', options.engine, '--report', headlessPath],
        { cwd: project, signal: signals.signal, report: processReport })
      const result = JSON.parse(await readFile(headlessPath, 'utf8'))
      assert.equal(result.snapshot?.width, 375); assert.equal(result.snapshot?.height, 667)
      return { savedPreferences: preferences, snapshot: result.snapshot, process: processReport }
    })
    if (!report.checks.headlessFixedDefaults.process) report.checks.headlessFixedDefaults.process = processReport
    await stopRun()
    const restored = await startRun()
    await check('savedPreferencesAfterRestart', async () => {
      const p = restored.presentation
      for (const key of ['logicalWidth', 'logicalHeight', 'renderScale', 'fps']) assert.equal(p[key], saved[key])
      assert.equal(p.revision, 1); assert.equal(p.generation, 1)
      return { saved, restored: p }
    })
    await stopRun()
    const launcher = join(owned, 'explicit-presentation-launcher')
    await writeFile(launcher, explicitLauncherSource(options.binary)); await chmod(launcher, 0o700)
    const initial = await startRun(launcher, '375x667')
    await check('explicitCliOverridesPreferences', async () => {
      assert.equal(initial.presentation.logicalWidth, 375); assert.equal(initial.presentation.logicalHeight, 667)
      assert.equal(initial.presentation.renderScale, 2); assert.equal(initial.presentation.fps, 60)
      return { settings: initial.presentation, args: ['--viewport', '375x667', '--render-scale', '2', '--fps', '60'],
        launcher: { method: 'POSIX exec preserves harness-owned PID', sha256: sha256(await readFile(launcher)) } }
    })

    stream = await connectDevEvents(simulator.url, 600_000, { signal: signals.signal })
    const { chromium } = await import(pathToFileURL(join(root, 'vendor/weapp-vite/node_modules/playwright/index.mjs')).href)
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    report.environment.browser = browser.version()
    context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1500, height: 1400 }, hasTouch: true })
    page = await context.newPage()
    page.on('pageerror', error => report.browserErrors.push({ page: 'main', message: error.message }))
    page.on('request', request => {
      if (request.method() !== 'POST') return
      if (new URL(request.url()).pathname === '/api/presentation') {
        report.presentationRequests.push({ timestamp: new Date().toISOString(), page: 'main', body: request.postDataJSON() }); return
      }
      if (new URL(request.url()).pathname !== '/api/bridge') return
      const envelope = request.postDataJSON()
      if (envelope?.op === 'event.batch') report.browserInputs.push(envelope)
    })
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/api/presentation') report.presentationResponses.push({ timestamp: new Date().toISOString(), page: 'main',
        method: response.request().method(), status: response.status() })
    })
    await page.goto(simulator.url, { waitUntil: 'domcontentloaded' }); await page.bringToFront(); await waitForPixels()
    for (const scale of renderScales) await check(alphaCheckName(scale), async () => {
      const before = await simulator.json('/api/state'), count = await storage('controls:count'), logicalTap = await query('#tap')
      const settings = await apply({ renderScale: scale })
      const frame = await waitForPixels()
      assert.equal(settings.effectiveScale, scale)
      const swatches = {}
      for (const [name, x, rgba] of [['half', 40, [255, 0, 0, 128]], ['zero', 100, [0, 0, 0, 0]],
        ['opaque', 160, [20, 40, 80, 255]], ['clear', 220, [0, 0, 0, 0]]]) {
        const pixel = await pixels({ left: x, top: 380, width: 1, height: 1 })
        assert.deepEqual(pixel.firstPixel, rgba, `${name} real Canvas2D readback at ${scale}x must retain straight-alpha RGBA`)
        swatches[name] = pixel
      }
      assert.equal((await simulator.json('/api/state')).sessionId, before.sessionId)
      assert.equal(settings.logicalWidth, before.presentation.logicalWidth)
      assert.equal(settings.logicalHeight, before.presentation.logicalHeight)
      assert.equal(await storage('controls:count'), count)
      assert.deepEqual(await query('#tap'), logicalTap, 'render density must preserve logical geometry')
      return { method: 'native Skia transparent clear and CSS alpha swatches → binary frame → actual Canvas2D getImageData; CSS canvas background is excluded',
        scale, settings, physical: { width: frame.width, height: frame.height }, swatches,
        screenshot: await screenshot(page, `transparent-rgba-scale-${scale}`) }
    })
    await page.evaluate(() => {
      globalThis.__controlsTrustedWheels = []
      document.querySelector('#screen').addEventListener('wheel', event => globalThis.__controlsTrustedWheels.push({
        isTrusted: event.isTrusted, deltaY: event.deltaY, deltaMode: event.deltaMode,
        cssHeight: event.currentTarget.getBoundingClientRect().height,
      }), { capture: true, passive: true })
    })
    for (const scale of renderScales) for (const zoom of displayZooms) await check(inputCheckName(scale, zoom), async () => {
      const before = await simulator.json('/api/state'), count = await storage('controls:count')
      const logicalTap = await query('#tap'), logicalScroll = await query('#controls-scroll')
      const settings = before.presentation.renderScale === scale ? before.presentation : await apply({ renderScale: scale })
      const frame = await waitForPixels()
      assert.equal(settings.renderScale, scale); assert.equal(settings.effectiveScale, scale)
      assert.equal(settings.logicalWidth, before.presentation.logicalWidth)
      assert.equal(settings.logicalHeight, before.presentation.logicalHeight)
      const scaled = await simulator.json('/api/state')
      assert.equal(scaled.sessionId, before.sessionId)
      assert.equal(await storage('controls:count'), count, 'render density must not re-run the Page handler')
      assert.deepEqual(await query('#tap'), logicalTap, 'render density must preserve logical hit geometry')
      assert.deepEqual(await query('#controls-scroll'), logicalScroll, 'render density must preserve logical scroll geometry and offset')
      await page.locator('#zoom').selectOption(String(zoom))
      await page.waitForFunction(zoom => Math.abs(document.querySelector('#screen').getBoundingClientRect().width - 375 * zoom) < .1, zoom)
      assert.equal(await page.evaluate(() => localStorage.getItem('weapp-container:display-zoom')), String(zoom))
      const unchanged = await simulator.json('/api/state')
      assert.equal(unchanged.sessionId, before.sessionId); assert.deepEqual(unchanged.presentation, settings)
      assert.deepEqual(await query('#tap'), logicalTap, 'CSS zoom must not change logical geometry')
      assert.deepEqual(await query('#controls-scroll'), logicalScroll, 'CSS zoom must preserve logical scroll geometry and offset')
      assert.equal(await storage('controls:count'), count, 'display zoom must not re-run the Page handler')
      const click = await clickCounter()
      const scroll = await query('#controls-scroll'), pixelBefore = await pixels(scroll)
      const native = await point(scroll.left + 30, scroll.top + 70), bounds = await page.locator('#screen').boundingBox()
      const inputStart = report.browserInputs.length
      const trustedStart = await page.evaluate(() => globalThis.__controlsTrustedWheels.length)
      const dpr = await page.evaluate(() => devicePixelRatio)
      await page.mouse.move(native.x, native.y)
      const driverDelta = wheelDriverDelta(20, bounds.height, 667, dpr)
      await page.mouse.wheel(0, driverDelta)
      await page.waitForFunction(length => globalThis.__controlsTrustedWheels.length > length, trustedStart)
      const trustedWheel = await page.evaluate(() => globalThis.__controlsTrustedWheels.at(-1))
      assert.equal(trustedWheel.isTrusted, true); assert.equal(trustedWheel.deltaMode, 0)
      assert.ok(Math.abs(trustedWheel.deltaY * 667 / trustedWheel.cssHeight - 20) < .2, 'actual trusted browser wheel must request 20 logical pixels')
      const wheeled = await waitScroll(scrollTop(scroll) + 20)
      const wheelPixels = await waitForChange(scroll, pixelBefore)
      assert.ok(report.browserInputs.slice(inputStart).some(envelope => envelope.payload.events.some(event => event.type === 'wheel' && Math.abs(event.deltaY - 20) < .2)))
      const cdp = await context.newCDPSession(page)
      let touched
      try {
        const start = await point(scroll.left + 30, scroll.top + 120), end = await point(scroll.left + 30, scroll.top + 100)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x, y: start.y, id: 9 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: end.x, y: end.y, id: 9 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        touched = await waitScroll(scrollTop(wheeled) + 20)
      } finally { await cdp.detach() }
      const touchPixels = await waitForChange(scroll, wheelPixels)
      assert.equal(await storage('controls:count'), count + 1, 'touch drag must not synthesize a tap')
      const callback = await storage('controls:scroll')
      assert.ok(Math.abs(callback.top - touched.scrollTop) < .2, 'real JS scroll callback must observe logical offset')
      return { scale, zoom, settings, physical: { width: frame.width, height: frame.height }, sessionId: unchanged.sessionId,
        click, scrollBefore: scroll, wheel: { geometry: wheeled, pixels: wheelPixels, driverDelta, dpr, trustedWheel },
        touch: { geometry: touched, pixels: touchPixels, jsCallback: callback }, screenshot: await screenshot(page, `scale-${scale}-zoom-${zoom}`) }
    })
    await check('restore2xBeforeHmr', async () => {
      const before = await simulator.json('/api/state'), count = await storage('controls:count')
      const logicalTap = await query('#tap'), logicalScroll = await query('#controls-scroll')
      const settings = await apply({ renderScale: 2 })
      const frame = await waitForPixels()
      assert.equal(settings.renderScale, 2); assert.equal(settings.effectiveScale, 2)
      assert.equal(settings.logicalWidth, 375); assert.equal(settings.logicalHeight, 667)
      assert.equal((await simulator.json('/api/state')).sessionId, before.sessionId)
      assert.equal(await storage('controls:count'), count)
      assert.deepEqual(await query('#tap'), logicalTap)
      assert.deepEqual(await query('#controls-scroll'), logicalScroll)
      assert.equal(await page.locator('#zoom').inputValue(), '2')
      return { settings, physical: { width: frame.width, height: frame.height }, sessionId: before.sessionId, count,
        screenshot: await screenshot(page, 'restored-2x-before-hmr') }
    })
    await check('browserZoomRestoresLocally', async () => {
      const previous = await simulator.json('/api/state')
      await page.reload({ waitUntil: 'domcontentloaded' }); await waitForPixels()
      assert.equal(await page.locator('#zoom').inputValue(), '2')
      assert.equal((await simulator.json('/api/state')).sessionId, previous.sessionId)
      await page.locator('#zoom').selectOption('1')
      return { savedZoom: '2', sessionPreserved: true }
    })

    const marker = await query('#hmr-marker')
    for (const kind of ['wxss', 'wxml']) await check(`${kind}HmrAt2x`, async () => {
      const before = await simulator.json('/api/state'), count = await storage('controls:count'), previous = await pixels(marker)
      const reloadPromise = stream.nextEvent('reload', value => value.revision > before.revision)
      reloadPromise.catch(() => {})
      if (kind === 'wxss') await writeFile(`${pageRoot}.wxss`, fixtureWxss.replace('#112233', '#cc4422'))
      else await writeFile(`${pageRoot}.wxml`, fixtureWxml.replace('HMR baseline', 'HMR updated'))
      const after = await simulator.waitForState(value => value.status === 'ready' && value.revision > before.revision, `${kind} HMR`)
      const event = await reloadPromise
      assert.equal(event.kind, 'InPlace'); assert.equal(after.sessionId, before.sessionId)
      assert.equal(after.presentation.generation, before.presentation.generation); assert.equal(after.presentation.effectiveScale, 2)
      assert.equal(await storage('controls:count'), count); await waitForPixels()
      const changed = await waitForChange(marker, previous)
      if (kind === 'wxss') assert.deepEqual(changed.firstPixel, [204, 68, 34, 255])
      const click = await clickCounter()
      return { before: { revision: before.revision, sessionId: before.sessionId, presentation: before.presentation },
        after: { revision: after.revision, sessionId: after.sessionId, presentation: after.presentation }, event, pixels: changed, click,
        screenshot: await screenshot(page, `hmr-${kind}`) }
    })

    await check('samePreviewLiveDpr', async () => {
      await page.bringToFront()
      const before = await simulator.json('/api/presentation')
      await page.locator('#renderScale').selectOption('auto')
      await simulator.waitForState(value => value.presentation.revision > before.revision && value.presentation.renderScale === 'auto'
        && value.presentation.effectiveScale === 2, 'single active preview auto DPR2')
      await waitForPixels()
      const focus = () => page.evaluate(() => ({ focused: document.hasFocus(), hidden: document.hidden,
        visibility: document.visibilityState, dpr: devicePixelRatio }))
      const activeBefore = await focus()
      assert.ok(activeBefore.focused && !activeBefore.hidden && activeBefore.visibility === 'visible', 'real primary page must be active')
      const densityCdp = await context.newCDPSession(page)
      const evidence = { method: 'CDP Emulation.setDeviceMetricsOverride on the same active target; unchanged CSS viewport, real browser DPR/media events; independent of multi-preview focus support', activeBefore }
      report.checks.samePreviewLiveDpr = evidence
      await page.evaluate(() => {
        const probe = { width: innerWidth, height: innerHeight, resizes: 0, focuses: 0, mediaChanges: 0 }
        const media = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
        const resize = () => { probe.resizes++ }, focus = () => { probe.focuses++ }, change = () => { probe.mediaChanges++ }
        window.addEventListener('resize', resize); window.addEventListener('focus', focus); media.addEventListener('change', change)
        globalThis.__controlsDprProbe = probe
        globalThis.__disposeControlsDprProbe = () => { window.removeEventListener('resize', resize); window.removeEventListener('focus', focus); media.removeEventListener('change', change) }
      })
      try {
        await captureCheckObservation('samePreviewLiveDpr', 'before-live-dpr-change')
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        const settingsRequestStart = report.presentationRequests.length, changeStartedAt = Date.now()
        await densityCdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, mobile: false, deviceScaleFactor: 1.5 })
        await page.waitForFunction(() => devicePixelRatio === 1.5)
        await captureCheckObservation('samePreviewLiveDpr', 'browser-dpr-is-1.5-before-runtime-wait')
        const changed = await simulator.waitForState(value => value.presentation.effectiveScale === 1.5, 'same active page screen DPR1.5', 20_000)
        evidence.changed = changed.presentation
        evidence.frame = await waitForPixels()
        evidence.activeChanged = await focus()
        assert.ok(evidence.activeChanged.focused && !evidence.activeChanged.hidden)
        evidence.events = await page.evaluate(() => ({ ...globalThis.__controlsDprProbe, currentWidth: innerWidth, currentHeight: innerHeight }))
        assert.equal(evidence.events.currentWidth, viewport.width); assert.equal(evidence.events.currentHeight, viewport.height)
        assert.equal(evidence.events.focuses, 0, 'same active page must not require another focus event')
        evidence.browserAfterChange = await browserPresentationObservation(page)
        evidence.runtimeUpdateMs = Date.now() - changeStartedAt
        evidence.actualSettingsRequests = report.presentationRequests.slice(settingsRequestStart).filter(request => request.body?.devicePixelRatio === 1.5)
        assert.ok(evidence.actualSettingsRequests.length > 0, 'real page must submit its newly observed DPR to the runtime')
        evidence.delivery = evidence.events.mediaChanges === 0 && evidence.events.resizes === 0
          ? '250ms DPR fallback; no media, focus or resize event' : 'native media/resize event observed'
        if (evidence.delivery.startsWith('250ms')) {
          assert.equal(evidence.browserAfterChange.client.observedDensity, 1.5)
          assert.equal(evidence.browserAfterChange.client.densityTimerActive, true)
        }
        await densityCdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, mobile: false, deviceScaleFactor: 2 })
        await page.waitForFunction(() => devicePixelRatio === 2)
        const restored = await simulator.waitForState(value => value.presentation.effectiveScale === 2, 'rearmed active page DPR2', 20_000)
        evidence.restored = restored.presentation; evidence.restoredFrame = await waitForPixels()
        assert.equal(changed.sessionId, restored.sessionId)
        return evidence
      } finally {
        await captureCheckObservation('samePreviewLiveDpr', 'final-before-probe-cleanup-and-cdp-detach')
        await page.evaluate(() => { globalThis.__disposeControlsDprProbe?.(); delete globalThis.__disposeControlsDprProbe; delete globalThis.__controlsDprProbe })
        await densityCdp.detach(); report.cleanup.liveDprCdpDetached = true
        await captureCheckObservation('samePreviewLiveDpr', 'after-cdp-detach')
      }
    })
    await check('activePreviewAutoDpr', async () => {
      const focus = target => target.evaluate(() => ({ focused: document.hasFocus(), hidden: document.hidden,
        visibility: document.visibilityState, dpr: devicePixelRatio }))
      const focusRecords = []
      async function requireExclusive(active, inactive, label) {
        const deadline = Date.now() + 5000
        let observation
        do {
          observation = { label, active: await focus(active), inactive: await focus(inactive) }
          if (exclusiveFocus(observation.active, observation.inactive)) { focusRecords.push(observation); return }
          await sleep(100)
        } while (Date.now() < deadline)
        focusRecords.push(observation)
        ;(report.checks.activePreviewAutoDpr ??= {}).focusRecords = focusRecords
        const error = new Error(`headless Chromium did not expose exclusive real focus: ${JSON.stringify(observation)}`)
        error.code = 'ERR_FOCUS_UNOBSERVABLE'; throw error
      }
      await page.bringToFront()
      await apply({ renderScale: 'auto', devicePixelRatio: await page.evaluate(() => devicePixelRatio) })
      await waitForPixels()
      await captureCheckObservation('activePreviewAutoDpr', 'before-creating-secondary-page')
      secondaryPage = await context.newPage()
      const secondaryDprCdp = await context.newCDPSession(secondaryPage)
      await secondaryDprCdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1400, mobile: false, deviceScaleFactor: 1 })
      await captureCheckObservation('activePreviewAutoDpr', 'after-secondary-dpr-override-before-navigation', { main: page, secondary: secondaryPage })
      report.resources.secondaryPreview = { createdByThisRun: true, reason: 'one temporary DPR1 page in the same browser context for real active/inactive focus contract', url: simulator.url }
      secondaryPage.on('pageerror', error => report.browserErrors.push({ page: 'secondary', message: error.message }))
      try {
      await secondaryPage.goto(simulator.url, { waitUntil: 'domcontentloaded' }); await secondaryPage.bringToFront()
      await captureCheckObservation('activePreviewAutoDpr', 'after-secondary-navigation-before-exclusive-focus', { main: page, secondary: secondaryPage })
      await requireExclusive(secondaryPage, page, 'DPR1 active')
      const low = await simulator.waitForState(value => value.presentation.effectiveScale === 1, 'active DPR1')
      await waitForPixels(); await waitForPixels(secondaryPage)
      const lowFrames = { main: await waitForPixels(), secondary: await waitForPixels(secondaryPage) }
      await sleep(1000)
      assert.equal((await simulator.json('/api/presentation')).revision, low.presentation.revision, 'inactive DPR2 preview must not reclaim density')
      await page.bringToFront(); await requireExclusive(page, secondaryPage, 'DPR2 active')
      const high = await simulator.waitForState(value => value.presentation.effectiveScale === 2, 'active DPR2')
      const highFrames = { main: await waitForPixels(), secondary: await waitForPixels(secondaryPage) }
      await secondaryDprCdp.send('Emulation.setDeviceMetricsOverride', { width: 1501, height: 1400, mobile: false, deviceScaleFactor: 1 }) // Real inactive resize retaining DPR1.
      await requireExclusive(page, secondaryPage, 'DPR1 resized while inactive'); await sleep(1000)
      assert.equal((await simulator.json('/api/presentation')).revision, high.presentation.revision, 'inactive real resize must not submit DPR1')
      assert.equal(low.sessionId, high.sessionId)
      return { method: 'two actual pages in one Playwright context at DPR1/2, bringToFront + document.hasFocus/visibility; no mocked focus/DPR',
        observations: report.checks.activePreviewAutoDpr?.observations, focusRecords, low: low.presentation, lowFrames, high: high.presentation, highFrames,
        screenshots: { main: await screenshot(page, 'auto-dpr-main'), secondary: await screenshot(secondaryPage, 'auto-dpr-secondary') } }
      } finally {
        await captureCheckObservation('activePreviewAutoDpr', 'final-before-secondary-cdp-detach', { main: page, secondary: secondaryPage })
        await secondaryDprCdp.detach(); report.cleanup.secondaryDprCdpDetached = true
      }
    })
    if (secondaryPage) { await secondaryPage.close(); assert.equal(secondaryPage.isClosed(), true); secondaryPage = undefined; report.cleanup.secondaryPageClosed = true }
    report.finalState = await simulator.json('/api/state')
    assert.deepEqual(report.browserErrors, [])
    assert.deepEqual(report.finalState.diagnostics, [])
    report.status = Object.values(report.checks).every(value => value.status === 'passed') ? 'passed' : 'failed'
  } catch (error) {
    report.error = serializeError(error)
    report.outputTail = simulator?.outputTail()
  } finally {
    for (const [name, resource] of [['secondaryPage', secondaryPage], ['context', context], ['browser', browser]]) {
      if (!resource) continue
      try {
        await resource.close(); report.cleanup[name] = 'closed'
        if (name === 'context' && page) { assert.equal(page.isClosed(), true); report.cleanup.mainPageClosed = true }
        if (name === 'secondaryPage' && secondaryPage) { assert.equal(secondaryPage.isClosed(), true); report.cleanup.secondaryPageClosed = true }
        if (name === 'browser') { assert.equal(browser.isConnected(), false); report.cleanup.browserDisconnected = true }
      } catch (error) { report.cleanup.errors.push(`${name}: ${error.message}`) }
    }
    try { await stopRun() } catch (error) { report.cleanup.errors.push(`simulator/SSE: ${error.message}`) }
    try { await rm(owned, { recursive: true, force: true }); report.cleanup.temporaryProjectRemoved = true }
    catch (error) { report.cleanup.errors.push(`temporary project: ${error.message}`) }
    signals.dispose()
    for (const name of requiredChecks) {
      report.checks[name] ??= { status: 'blocked', reason: 'not reached after an earlier setup/transport failure' }
    }
    if (requiredChecks.some(name => report.checks[name].status !== 'passed')) report.status = 'failed'
    if (report.resources.bridgeSseCreated !== report.cleanup.bridgeSseClosed) report.cleanup.errors.push('not all per-request SSE streams were closed')
    if (report.cleanup.errors.length) report.status = 'failed'
    report.environment.loadAverageEnd = loadavg()
    await writeFile(join(options.out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.help) console.log('Usage: node scripts/simulator-presentation-controls-smoke.mjs --out <new evidence directory> [--simulator-bin <release binary>] [--engine quickjs|v8] [--wv-bin <compiler>]')
    else {
      const report = await runControlsSmoke(options)
      console.log(JSON.stringify({ status: report.status, report: join(options.out, 'report.json'), checks: Object.fromEntries(Object.entries(report.checks).map(([key, value]) => [key, value.status])), error: report.error, cleanup: report.cleanup }, null, 2))
      if (report.status !== 'passed') process.exitCode ||= 1
    }
  } catch (error) { console.error(error.stack || error); process.exitCode ||= 1 }
}
