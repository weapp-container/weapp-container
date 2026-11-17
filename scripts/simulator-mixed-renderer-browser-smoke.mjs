#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connectDevEvents, installSmokeSignals, startDevSimulator } from './simulator-dev-harness.mjs'
import { assertNoRgbaTransport, assertRendererReceipt, presentationMatchesFrame } from './simulator-canvaskit-browser-smoke.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const digest = value => createHash('sha256').update(value).digest('hex')
const errorValue = error => ({ name: error.name, message: error.message, stack: error.stack, ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}) })
const sameKey = (a, b) => a && b && ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile'].every(field => a[field] === b[field])
const copyFilter = path => !['node_modules', 'dist', '.weapp-vite', '.weapp-container'].includes(basename(path))

/** Observation only: keep the real EventSource and its normal dispatch order. */
export function installMixedSmokeObserver() {
  const NativeEventSource = globalThis.EventSource
  const log = globalThis.__mixedSmokeEvents = { events: [], counts: {}, dropped: 0 }
  globalThis.EventSource = class extends NativeEventSource {
    constructor(...args) {
      super(...args)
      for (const type of ['state', 'bridge', 'preview', 'diagnostic', 'error', 'presentation', 'presented', 'presentation-rejected', 'reload', 'shutdown']) {
        this.addEventListener(type, event => {
          if (typeof event.data !== 'string') return
          log.counts[type] = (log.counts[type] || 0) + 1
          let payload
          try { payload = event.data.length <= 131072 ? JSON.parse(event.data) : { truncated: true, characters: event.data.length } }
          catch { payload = { invalidJson: true, characters: event.data.length } }
          const document = globalThis.document, element = document?.activeElement
          log.events.push({ type, at: Date.now(), payload, hasFocus: document?.hasFocus?.() ?? null,
            hidden: document?.hidden ?? null, activeElement: element ? { tagName: element.tagName, id: element.id } : null,
            dpr: globalThis.devicePixelRatio ?? null })
          if (log.events.length > 512) { log.events.shift(); log.dropped++ }
        })
      }
    }
  }
}

/** Serialize the live UI's ownership and density state without changing it. */
export function readMixedInputState() {
  const element = document.activeElement
  return { profile: state.webRenderer, sessionId: state.sessionId, currentPageId: state.currentPageId, route: state.route,
    ready: Boolean(rendererInputReady()), inputSuspended, pendingPresentation, rendererBlocked, surfaceInputAttached: Boolean(surfaceInput),
    transportConnected: Boolean(rasterBridgeTransport?.connected), pointerSequence, receipt: globalThis.__weappRasterInput,
    autoPresentationWanted, activePreview: activePreview(), hasFocus: document.hasFocus(), hidden: document.hidden,
    activeElement: element ? { tagName: element.tagName, id: element.id } : null, observedDensity, dpr: devicePixelRatio,
    confirmedRendererIdentity, frame: lastFrame && { sessionId: lastFrame.sessionId, frameId: lastFrame.frameId,
      renderRevision: lastFrame.renderRevision, configGeneration: lastFrame.configGeneration },
    presentation: { ...presentation }, overlay: document.querySelector('#overlay')?.textContent }
}

async function deadline(promise, milliseconds, label, details) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${label} exceeded ${milliseconds} ms`), { code: 'ERR_SMOKE_OPERATION_TIMEOUT', details })), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

export function parseOptions(args) {
  const options = { binary: join(root, 'target/release/weapp-simulator'), engine: 'quickjs', timeoutMs: 120000 }
  const fields = { '--binary': 'binary', '--engine': 'engine', '--renderer-assets': 'rendererAssets', '--out': 'out', '--timeout': 'timeoutMs', '--wv-bin': 'wvBin' }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') return { help: true }
    const field = fields[args[index]], value = args[++index]
    if (!field || !value || value.startsWith('--')) throw new Error('Expected --binary, --engine, --renderer-assets, --out, --timeout or --wv-bin with a value')
    options[field] = value
  }
  if (!options.rendererAssets || !options.out) throw new Error('--renderer-assets and a new --out directory are required')
  if (!['quickjs', 'v8'].includes(options.engine)) throw new Error('--engine requires quickjs or v8')
  options.timeoutMs = Number(options.timeoutMs)
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('--timeout must be integer milliseconds >= 1000')
  for (const field of ['binary', 'rendererAssets', 'out', 'wvBin']) if (options[field]) options[field] = resolve(options[field])
  return options
}

/** The fixture keeps source page JSON untouched by the packer's renderer map. */
export async function createMixedRendererFixture(project) {
  const home = 'pages/home/index', skia = 'pages/skia/index'
  const app = { pages: [home, skia], window: { navigationBarTitleText: 'Mixed renderer verification', backgroundColor: '#f3f4f6' } }
  const config = { renderer: { default: 'webview', pages: { [home]: 'webview', [skia]: 'skia' } } }
  const css = `page{background:#f3f4f6}.tap{position:absolute;left:20px;top:20px;width:200px;height:44px;background:#2050a0;color:white}.count{position:absolute;left:20px;top:80px;width:280px;height:30px;color:#102030}.nav{position:absolute;left:20px;top:135px;width:230px;height:44px;background:#257247;color:white}.watch{position:absolute;left:20px;top:200px;width:280px;height:30px;color:#102030}\n`
  const homeScript = `Page({data:{count:0},onLoad(){wx.setStorageSync('mixed:domLoads',(wx.getStorageSync('mixed:domLoads')||0)+1);wx.setStorageSync('mixed:domCount',0);},onIncrement(){this.setData({count:this.data.count+1});wx.setStorageSync('mixed:domCount',this.data.count);},onNavigate(){wx.navigateTo({url:'/pages/skia/index'});}})\n`
  const skiaScript = `Page({data:{count:0},onLoad(){wx.setStorageSync('mixed:skiaLoads',(wx.getStorageSync('mixed:skiaLoads')||0)+1);},onIncrement(){this.setData({count:this.data.count+1});wx.setStorageSync('mixed:skiaCount',this.data.count);},onBack(){wx.navigateBack({delta:1});}})\n`
  const homeWxml = '<view id="dom-increment" class="tap" bindtap="onIncrement">DOM increment</view><text id="dom-count" class="count">DOM count: {{count}}</text><view id="dom-to-skia" class="nav" bindtap="onNavigate">Open Skia page</view><text id="dom-watch" class="watch">watch-initial</text>\n'
  const skiaWxml = '<view id="skia-increment" class="tap" bindtap="onIncrement">Skia increment</view><text id="skia-count" class="count">Skia count: {{count}}</text><view id="skia-back" class="nav" bindtap="onBack">Return to DOM page</view>\n'
  for (const route of [home, skia]) await mkdir(dirname(join(project, route)), { recursive: true })
  const files = { 'app.json': `${JSON.stringify(app, null, 2)}\n`, 'app.js': 'App({})\n', 'app.wxss': '',
    'container.config.json': `${JSON.stringify(config, null, 2)}\n`, [`${home}.js`]: homeScript, [`${skia}.js`]: skiaScript,
    [`${home}.wxml`]: homeWxml, [`${skia}.wxml`]: skiaWxml,
    [`${home}.wxss`]: css, [`${skia}.wxss`]: css, [`${home}.json`]: '{}\n', [`${skia}.json`]: '{}\n' }
  for (const [path, contents] of Object.entries(files)) await writeFile(join(project, path), contents)
  return { routes: { webview: home, skia }, files: Object.fromEntries(Object.entries(files).map(([path, source]) => [path, { sha256: digest(source), size: Buffer.byteLength(source) }])) }
}

async function fileInventory(directory) {
  const files = []
  const visit = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) { const bytes = await readFile(absolute); files.push({ path: relative(directory, absolute), sha256: digest(bytes), size: bytes.length }) }
    }
  }
  await visit(directory)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** Importing this module creates no processes, listeners or browser resources.
 * Explicit execution owns a copied project, watcher, SSE and one headless tab. */
export async function runMixedRendererDevSmoke(options, { chromium, signal, startSimulator = startDevSimulator } = {}) {
  await mkdir(dirname(options.out), { recursive: true })
  await mkdir(options.out)
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: 'failed', engine: options.engine,
    scope: 'real watch-built app with automatic per-page WebView/Skia switching', renderer: 'auto', headless: true,
    environment: { platform: process.platform, arch: process.arch, node: process.version }, checks: {}, requests: [], responses: [], driverBridge: [], inputActions: [], phases: [], pageErrors: [], console: [], cleanup: {},
    resources: { createdByThisRun: true, maxPages: 1 }, limitations: ['Browser GPU context does not establish physical GPU/device acceptance.', 'No timing, WeChat parity or other-host acceptance.'] }
  let owned, simulator, stream, browser, context, page, cancellationClose
  const responseTasks = new Set(), operationBudget = Math.min(options.timeoutMs ?? 120000, 10000)
  const save = (name, value) => writeFile(join(options.out, name), `${JSON.stringify(value, null, 2)}\n`)
  const phase = value => { report.phase = value; report.phases.push({ phase: value, at: new Date().toISOString() }) }
  const checkCancelled = () => signal?.throwIfAborted()
  const onAbort = () => { if (context) { cancellationClose ||= context.close(); cancellationClose.catch(() => {}) } }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    phase('provenance')
    checkCancelled()
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    report.commit = git(['rev-parse', 'HEAD']); report.dirtySource = git(['status', '--porcelain']).length > 0
    report.submodule = { sha: git(['-C', 'vendor/weapp-vite', 'rev-parse', 'HEAD']), dirty: git(['-C', 'vendor/weapp-vite', 'status', '--porcelain']).length > 0 }
    const bytes = await readFile(options.binary)
    report.binary = { path: options.binary, sha256: digest(bytes), size: bytes.length }
    const sources = ['Cargo.toml', 'Cargo.lock', 'crates/container-simulator/src/main.rs', 'crates/container-simulator/src/lib.rs',
      'crates/container-simulator/src/web.rs', 'crates/container-simulator/src/web_dom.rs', 'crates/container-simulator/src/web-ui.html',
      'crates/container-runtime/src/browser_view.rs', 'crates/container-host-common/src/lib.rs', 'examples/hosts/web-wasm/remote-dom.mjs',
      'examples/hosts/web-wasm/dom-session-client.mjs', 'examples/hosts/web-wasm/dom-presenter.mjs', 'examples/hosts/web-wasm/remote-canvaskit.mjs',
      'scripts/simulator-dev-harness.mjs', 'scripts/simulator-mixed-renderer-browser-smoke.mjs']
    report.sourceInputs = await Promise.all(sources.map(async path => { const source = await readFile(join(root, path)); return { path, sha256: digest(source), size: source.length } }))
    report.rendererAssets = { path: options.rendererAssets, files: await fileInventory(options.rendererAssets), config: JSON.parse(await readFile(join(options.rendererAssets, 'runtime-config.json'))) }
    owned = await mkdtemp(join(tmpdir(), 'weapp-mixed-renderer-'))
    const project = join(owned, 'reference-app')
    report.resources.project = project
    await cp(join(root, 'examples/apps/reference-app'), project, { recursive: true, filter: copyFilter })
    report.fixture = await createMixedRendererFixture(project)
    await cp(project, join(options.out, 'fixture-initial'), { recursive: true, filter: copyFilter })
    phase('start-supervisor')
    simulator = await startSimulator({ root, project, port: 0, engine: options.engine, renderer: 'auto', rendererAssets: options.rendererAssets,
      wvBin: options.wvBin, timeoutMs: options.timeoutMs, signal, launcher: { mode: 'simulator', command: options.binary } })
    report.resources.simulator = { pid: simulator.child.pid, url: simulator.url, staging: simulator.staging }
    await save('owned-resources.json', report.resources)
    stream = await connectDevEvents(simulator.url, options.timeoutMs, { signal })
    const waitFor = async (read, label, milliseconds = options.timeoutMs) => {
      const until = Date.now() + milliseconds
      do { checkCancelled(); const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)) } while (Date.now() < until)
      throw Object.assign(new Error(`Timed out waiting for ${label}`), { code: 'ERR_SMOKE_STATE_TIMEOUT', details: { phase: report.phase, label, milliseconds } })
    }
    let sequence = 0
    const dispatch = async (op, payload, preview) => {
      const state = await simulator.json('/api/state'), requestId = `mixed-${++sequence}`
      const envelope = { protocolVersion: '1.0', sessionId: state.sessionId, requestId, kind: 'request', op, payload, ...(preview ? { preview } : {}) }
      const evidence = { at: Date.now(), phase: report.phase, envelope }; report.driverBridge.push(evidence)
      const timeoutSignal = AbortSignal.timeout(operationBudget), requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      const response = await fetch(new URL('/api/bridge', simulator.url), { method: 'POST', headers: { 'content-type': 'application/json' }, signal: requestSignal,
        body: JSON.stringify(envelope) })
      const receipt = await response.json()
      evidence.status = response.status; evidence.receipt = receipt
      if (!response.ok) return { status: response.status, phase: 'http', payload: receipt }
      // The owned SSE reader buffers bytes until consumed. Start a read only
      // after queue admission: HTTP rejection must not leave a second reader.
      const batch = await deadline(stream.nextEvent('bridge', batch => batch.messages?.some(message => message.sessionId === envelope.sessionId && message.requestId === requestId && message.op === op && message.kind === 'response' && message.payload?.queued !== true)), operationBudget, 'driver runtime response', { phase: report.phase, envelope })
      const result = batch.messages.find(message => message.requestId === requestId && message.kind === 'response')
      evidence.final = result
      return { status: response.status, phase: 'runtime', payload: result.payload }
    }
    const api = async (name, args = {}) => { const result = await dispatch('api.call', { name, ...args }); assert.equal(result.payload.ok, true, JSON.stringify(result)); return result.payload.result }
    if (!chromium) ({ chromium } = await import(pathToFileURL(resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || join(root, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))).href))
    checkCancelled(); browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    report.environment.browser = browser.version()
    checkCancelled(); context = await browser.newContext({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2 })
    await context.addInitScript(installMixedSmokeObserver)
    checkCancelled(); page = await context.newPage()
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin !== new URL(simulator.url).origin || report.requests.length >= 8192) return
      const evidence = { at: Date.now(), method: request.method(), path: url.pathname }
      if (request.postData()) { try { evidence.body = request.postDataJSON() } catch { evidence.body = request.postData() } }
      report.requests.push(evidence)
    })
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.origin !== new URL(simulator.url).origin || !['/api/bridge', '/api/presentation', '/api/preview', '/api/render-presented'].includes(url.pathname)) return
      const task = (async () => {
        const evidence = { at: Date.now(), path: url.pathname, status: response.status() }
        try { evidence.body = await response.json() } catch (error) { evidence.readError = errorValue(error) }
        report.responses.push(evidence)
      })()
      responseTasks.add(task); task.finally(() => responseTasks.delete(task)).catch(() => {})
    })
    page.on('pageerror', error => report.pageErrors.push(errorValue(error)))
    page.on('console', message => { report.console.push({ type: message.type(), text: message.text() }); if (report.console.length > 200) report.console.shift() })
    const waitDom = () => waitFor(async () => {
      const state = await simulator.json('/api/state')
      const ui = await page.evaluate(() => ({ receipt: globalThis.__weappDomReceipt, owner: globalThis.__weappDomSurface?.isOwner,
        accepted: globalThis.__weappDomSurface?.client.accepted, authority: globalThis.__weappDomSurface?.authority,
        iframeCount: document.querySelectorAll('#domScreen iframe').length, remoteRaster: Boolean(globalThis.__weappRemoteRenderer) }))
      return state.webRenderer === 'webview' && state.route === report.fixture.routes.webview && state.viewInputEnabled === true && ui.owner === true
        && ui.receipt?.phase === 'presented' && ui.accepted?.inputEnabled === true && ui.authority?.previewEpoch === state.preview?.epoch
        && sameKey(ui.receipt.key, state.viewPresented?.key) && sameKey(ui.accepted.key, state.viewPresented?.key)
        && ui.iframeCount === 1 && !ui.remoteRaster ? { state, ui } : null
    }, 'exact accepted DOM presentation and retired CanvasKit resources')
    const readInputState = () => page.evaluate(readMixedInputState)
    const waitSkia = (effectiveScale = 2) => waitFor(async () => {
      const state = await simulator.json('/api/state')
      if (state.webRenderer !== 'canvaskit' || state.route !== report.fixture.routes.skia || state.presentation?.effectiveScale !== effectiveScale) return null
      let current
      try { current = await simulator.json('/api/render-frame') } catch (error) { if (error.status === 404) return null; throw error }
      const ui = await page.evaluate(() => ({ ready: document.querySelector('#status')?.textContent === 'ready' && Boolean(rendererInputReady()) && !inputSuspended && pendingPresentation === null && Boolean(surfaceInput) && Boolean(rasterBridgeTransport?.connected),
        receipt: globalThis.__weappRendererReceipt, metrics: { frameId: globalThis.__weappPresentationMetrics?.frameId,
          sessionId: globalThis.__weappPresentationMetrics?.sessionId, configGeneration: globalThis.__weappPresentationMetrics?.configGeneration },
        domDisposed: !globalThis.__weappDomSurface && document.querySelectorAll('#domScreen iframe').length === 0 }))
      if (!ui.domDisposed || !presentationMatchesFrame(ui, current)) return null
      assertRendererReceipt(ui.receipt); return { state, current, ui }
    }, 'exact confirmed CanvasKit frame and retired DOM resources')
    const dom = () => page.frameLocator('#domScreen iframe:visible')
    const assertRejected = result => { assert.ok(result.status === 409 || result.payload.ok === false, JSON.stringify(result)); assert.match(JSON.stringify(result.payload), /ERR_CANCELLED|ERR_UNSUPPORTED_CAPABILITY/) }
    phase('initial-dom')
    await page.goto(simulator.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
    const initial = await waitDom(); assert.equal(initial.state.engine, options.engine)
    report.checks.initialDom = initial
    await dom().locator('#dom-increment').click()
    await waitFor(async () => await dom().locator('#dom-count').textContent() === 'DOM count: 1', 'DOM setData before navigation')
    await waitDom()
    const oldDom = await page.evaluate(() => {
      const surface = globalThis.__weappDomSurface, entry = surface.presenter.currentEntry
      const walk = nodes => nodes.flatMap(node => [node, ...walk(node.children || [])])
      const node = walk(entry.plan.document.nodes).find(node => node.attrs?.id === 'dom-increment')
      if (!node) throw Error('missing DOM occurrence')
      return { version: '1.0', key: entry.key, epoch: entry.geometry.epoch,
        events: [{ type: 'tap', targetOccurrenceId: node.occurrenceId, detail: { x: 40, y: 40 }, timeStamp: 1 }] }
    })
    await page.screenshot({ path: join(options.out, 'dom-before.png'), fullPage: true })
    phase('dom-to-skia')
    await dom().locator('#dom-to-skia').click()
    const skia = await waitSkia()
    assert.equal(skia.state.sessionId, initial.state.sessionId)
    assert.equal(await api('wx.getStorageSync', { key: 'mixed:domCount' }), 1)
    assert.equal(await api('wx.getStorageSync', { key: 'mixed:domLoads' }), 1)
    report.driver = assertRendererReceipt(skia.ui.receipt)
    report.checks.domToSkia = skia
    const skiaTarget = async selector => {
      const ready = await waitSkia(), queried = await api('wx.createSelectorQuery', { selector })
      const geometry = Array.isArray(queried) ? queried[0] : queried
      assert.ok(geometry.width > 0 && geometry.height > 0, selector)
      const canvas = page.locator('#screen'), bounds = await canvas.boundingBox(); assert.ok(bounds)
      const position = { x: (geometry.left + geometry.width / 2) * bounds.width / ready.state.presentation.logicalWidth,
        y: (geometry.top + geometry.height / 2) * bounds.height / ready.state.presentation.logicalHeight }
      return { canvas, bounds, position, geometry, receipt: ready.ui.receipt, logicalViewport: { width: ready.state.presentation.logicalWidth, height: ready.state.presentation.logicalHeight } }
    }
    const skiaClick = async (selector, { allowRetirement = false } = {}) => {
      const target = await skiaTarget(selector), before = await readInputState()
      const action = { selector, before, geometry: target.geometry }; report.inputActions.push(action)
      await target.canvas.click({ position: target.position })
      try {
        action.after = await waitFor(async () => {
          const input = await readInputState(), receipt = input.receipt
          if (!receipt || receipt.sequence <= before.pointerSequence) return null
          const final = await page.evaluate(envelope => globalThis.__mixedSmokeEvents?.events.flatMap(event => event.type === 'bridge' ? event.payload?.messages || [] : [])
            .find(message => message.kind === 'response' && message.sessionId === envelope?.sessionId && message.requestId === envelope?.requestId && message.op === envelope?.op && message.payload?.queued !== true), receipt.envelope)
          if (!final) {
            if (receipt.phase === 'error' && !receipt.error?.localCancellation) throw Object.assign(new Error('Raster input failed before a final runtime response'), { code: receipt.error.code, details: input })
            return null
          }
          if (final.payload?.ok !== true || (receipt.phase === 'error' && !(allowRetirement && receipt.error?.localCancellation))) {
            throw Object.assign(new Error('Raster input was rejected by the runtime or retired locally'), { code: final.payload?.error?.code ?? receipt.error?.code ?? 'ERR_SMOKE_INPUT_REJECTED', details: { input, final } })
          }
          if (!allowRetirement && receipt.phase !== 'applied') return null
          return { input, final }
        }, `final runtime application of ${selector}`, operationBudget)
      } catch (error) {
        action.failureInput = await readInputState()
        error.details = { ...error.details, action }
        throw error
      }
      return target
    }
    phase('pointer-density-race')
    const raceTarget = await skiaTarget('#skia-increment'), raceBefore = await readInputState()
    await page.mouse.move(raceTarget.bounds.x + raceTarget.position.x, raceTarget.bounds.y + raceTarget.position.y)
    await page.mouse.down()
    let pendingRace
    try {
      pendingRace = await page.evaluate(() => { document.querySelector('#renderScale').value = '1.5'; void submitPresentation(); return { pendingPresentation, ready: Boolean(rendererInputReady()), pointerSequence } })
      assert.ok(pendingRace.pendingPresentation, 'the trusted pointerdown spans an actual pending density request')
      assert.equal(pendingRace.ready, false)
    } finally { await page.mouse.up() }
    const densityFrame = await waitSkia(1.5), raceAfter = await readInputState()
    assert.equal(raceAfter.pointerSequence, raceBefore.pointerSequence, 'configuration retirement must discard the old contact')
    assert.equal(await api('wx.getStorageSync', { key: 'mixed:skiaCount' }) || 0, 0)
    report.checks.pointerDensityRace = { before: raceBefore, pending: pendingRace, after: raceAfter, frame: densityFrame.ui.receipt, count: 0 }
    await page.selectOption('#renderScale', '2')
    await waitSkia(2)
    phase('skia-increment')
    await skiaClick('#skia-increment')
    assert.equal(await api('wx.getStorageSync', { key: 'mixed:skiaCount' }), 1, 'the synchronous input handler must update storage before its final response')
    await waitSkia()
    report.checks.skiaClick = { count: 1 }
    await page.screenshot({ path: join(options.out, 'skia.png'), fullPage: true })
    phase('skia-to-dom')
    const back = await skiaClick('#skia-back', { allowRetirement: true })
    const returned = await waitDom()
    assert.equal(returned.state.sessionId, initial.state.sessionId)
    assert.equal(await dom().locator('#dom-count').textContent(), 'DOM count: 1')
    assert.equal(await api('wx.getStorageSync', { key: 'mixed:domLoads' }), 1)
    report.checks.skiaToDomStateRetained = returned
    phase('retired-input-rejection')
    const currentFence = await page.evaluate(() => globalThis.__weappDomSurface.fence({}).preview)
    const staleDom = await dispatch('view.events', oldDom, currentFence)
    assertRejected(staleDom)
    const staleSkia = await dispatch('event.batch', { logicalViewport: back.logicalViewport, renderRevision: back.receipt.renderRevision,
      configGeneration: back.receipt.configGeneration, events: [{ type: 'tap', x: back.geometry.left + 10, y: back.geometry.top + 10 }] })
    assertRejected(staleSkia)
    assert.equal(await api('wx.getStorageSync', { key: 'mixed:domCount' }), 1)
    assert.equal(await api('wx.getStorageSync', { key: 'mixed:skiaCount' }), 1)
    report.checks.retiredInputsRejected = { dom: staleDom, skia: staleSkia }
    phase('watch-reload')
    const source = join(project, `${report.fixture.routes.webview}.wxml`)
    await writeFile(source, (await readFile(source, 'utf8')).replace('watch-initial', 'watch-updated'))
    await waitFor(async () => (await simulator.json('/api/state')).revision > returned.state.revision, 'real WXML watcher generation')
    const watched = await waitDom()
    assert.equal(watched.state.sessionId, initial.state.sessionId)
    assert.equal(await dom().locator('#dom-watch').textContent(), 'watch-updated')
    assert.equal(await dom().locator('#dom-count').textContent(), 'DOM count: 1')
    await dom().locator('#dom-increment').click()
    await waitFor(async () => await dom().locator('#dom-count').textContent() === 'DOM count: 2', 'DOM input after watcher and renderer replacement')
    await waitDom()
    report.checks.watchAndFinalInput = { revision: watched.state.revision, count: 2 }
    assertNoRgbaTransport(report.requests)
    assert.ok(report.requests.some(value => value.path === '/api/preview'))
    report.checks.noCpuPageTransport = true
    assert.deepEqual(report.pageErrors, [])
    await page.screenshot({ path: join(options.out, 'dom-returned.png'), fullPage: true })
    await save('final-state.json', await simulator.json('/api/state'))
    await cp(project, join(options.out, 'fixture-final'), { recursive: true, filter: copyFilter })
    phase('completed')
    report.status = 'passed'
  } catch (error) {
    report.error = errorValue(error); report.outputTail = simulator?.outputTail()
    if (simulator) try { await save('failure-state.json', await simulator.json('/api/state')) } catch (failure) { report.failureStateError = errorValue(failure) }
    if (page && !page.isClosed()) try { await page.screenshot({ path: join(options.out, 'failure.png'), fullPage: true }); report.failureUi = await page.evaluate(() => ({ meta: document.querySelector('#meta')?.textContent, overlay: document.querySelector('#overlay')?.textContent,
      events: globalThis.__mixedSmokeEvents })); report.failureUi.input = await page.evaluate(readMixedInputState) } catch (failure) { report.failureUiError = errorValue(failure) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    const failures = []
    const cleanup = async (name, operation) => { try { report.cleanup[name] = await operation() ?? true } catch (error) { failures.push({ resource: name, ...errorValue(error) }) } }
    if (cancellationClose) await cleanup('cancellationContext', () => cancellationClose)
    if (page) {
      await cleanup('browserEvidence', async () => { if (!page.isClosed()) report.browserEvents = await page.evaluate(() => globalThis.__mixedSmokeEvents) })
      await cleanup('pageLifecycle', async () => { if (!page.isClosed()) await page.evaluate(async () => { if (typeof closeEventStream === 'function') closeEventStream(); await globalThis.__weappCleanupPromise }) })
      await cleanup('page', async () => { if (!page.isClosed()) await page.close(); assert.ok(page.isClosed()) })
    }
    if (context) await cleanup('context', () => context.close())
    if (browser) await cleanup('browser', async () => { await browser.close(); assert.equal(browser.isConnected(), false) })
    if (stream) await cleanup('sse', () => stream.close())
    if (simulator) {
      await cleanup('archiveStaging', async () => { const archive = join(options.out, 'staging'); await cp(simulator.staging, archive, { recursive: true }); report.packEvidence = await fileInventory(archive) })
      await cleanup('simulator', () => simulator.stop())
    }
    if (owned) await cleanup('project', () => rm(owned, { recursive: true, force: true }))
    await Promise.allSettled([...responseTasks])
    if (report.console.some(value => /cleanup failed/i.test(value.text))) failures.push({ resource: 'browser lifecycle', message: 'Browser logged a cleanup failure; see console evidence' })
    if (failures.length) { report.cleanup.errors = failures; report.status = 'failed' }
    await save('report.json', report)
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const signals = installSmokeSignals()
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.help) console.log('node scripts/simulator-mixed-renderer-browser-smoke.mjs --binary <simulator> --renderer-assets <assets> --out <new evidence directory> [--engine quickjs|v8] [--timeout ms] [--wv-bin path]')
    else { const report = await runMixedRendererDevSmoke(options, { signal: signals.signal }); console.log(JSON.stringify({ status: report.status, report: join(options.out, 'report.json'), checks: Object.keys(report.checks), error: report.error }, null, 2)); if (report.status !== 'passed') process.exitCode ||= 1 }
  } catch (error) { console.error(error.stack || error); process.exitCode ||= 1 }
  finally { signals.dispose() }
}
