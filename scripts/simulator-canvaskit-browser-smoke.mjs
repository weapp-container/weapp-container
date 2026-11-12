#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connectDevEvents, installSmokeSignals, startDevSimulator } from './simulator-dev-harness.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const errorValue = error => ({ name: error.name, message: error.message, stack: error.stack })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export function parseOptions(args) {
  const options = { binary: join(root, 'target/release/weapp-simulator'), engine: 'quickjs', scenario: 'reference', timeoutMs: 120_000 }
  const keys = { '--binary': 'binary', '--renderer-assets': 'rendererAssets', '--out': 'out', '--wv-bin': 'wvBin', '--engine': 'engine', '--timeout': 'timeoutMs', '--scenario': 'scenario' }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') return { help: true }
    const key = keys[args[index]], value = args[++index]
    if (!key || !value || value.startsWith('--')) throw new Error('Expected --binary, --renderer-assets, --out, --wv-bin, --engine, --scenario or --timeout with a value')
    options[key] = value
  }
  if (!options.rendererAssets || !options.out) throw new Error('--renderer-assets and a new --out directory are required')
  if (!['quickjs', 'v8'].includes(options.engine)) throw new Error('--engine requires quickjs or v8')
  if (!['reference', 'modern'].includes(options.scenario)) throw new Error('--scenario requires reference or modern')
  options.timeoutMs = Number(options.timeoutMs)
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('--timeout must be integer milliseconds >= 1000')
  for (const key of ['binary', 'rendererAssets', 'out', 'wvBin']) if (options[key]) options[key] = resolve(options[key])
  return options
}

export function assertRendererReceipt(receipt) {
  assert.equal(receipt?.backend, 'canvaskit-webgl2')
  assert.equal(receipt.context?.api, 'webgl2')
  assert.equal(receipt.context?.surfaceIsGpu, true)
  assert.equal(receipt.context?.physicalHardware, 'unknown')
  assert.equal(receipt.presentation?.gpuCompletion, 'not-waited')
  assert.equal(receipt.runtimeBoundary?.frameBatches, 1)
  assert.equal(receipt.runtimeBoundary?.perNodeRuntimeCalls, 0)
  assert.equal(receipt.runtimeBoundary?.softwareRgbaUploads, 0)
  assert.deepEqual(receipt.cleanupErrors, [])
  return { driver: receipt.context.unmaskedRenderer || receipt.context.renderer,
    softwareDriver: /swiftshader|llvmpipe|software/i.test(receipt.context.unmaskedRenderer || receipt.context.renderer || ''),
    physicalHardware: 'unknown' }
}

export function assertNoRgbaTransport(requests) {
  assert.ok(requests.some(value => value.path === '/api/render-frame'), 'browser must receive actual RenderFrame batches')
  assert.ok(requests.some(value => value.path === '/api/render-presented'), 'browser must submit a correlated presentation receipt')
  assert.equal(requests.some(value => ['/api/frame', '/api/snapshot'].includes(value.path)), false, 'normal drawing cannot download CPU page rasters')
}

export function presentationMatchesFrame(observed, current) {
  const receipt = observed?.receipt, metrics = observed?.metrics
  return Boolean(observed?.ready && receipt && metrics
    && receipt.sessionId === current.sessionId && receipt.configGeneration === current.configGeneration
    && receipt.renderRevision === current.renderRevision && receipt.frameId === current.sourceFrameId
    && metrics.sessionId === current.sessionId && metrics.configGeneration === current.configGeneration
    && metrics.frameId === current.frameId)
}

const fixtureScript = `Page({data:{count:0},onLoad(){wx.setStorageSync('canvaskit:count',0);},onTap(){this.setData({count:this.data.count+1});wx.setStorageSync('canvaskit:count',this.data.count);}})\n`
const fixtureWxml = `<view id="tap" class="tap" bindtap="onTap">Increment</view><text id="counter" class="counter">Count: {{count}}</text><view id="color" class="color"/>\n`
const fixtureWxss = `.tap{position:absolute;left:20px;top:20px;width:180px;height:40px;background:#2050a0;color:white}.counter{position:absolute;left:20px;top:75px;width:250px;height:30px;color:#102030}.color{position:absolute;left:20px;top:130px;width:80px;height:80px;background:#14a050}\n`

/** Importing this module does not launch anything. Explicit invocation owns
 * one simulator, browser/context/page, SSE connection and copied source tree. */
export async function runCanvasKitDevSmoke(options, { chromium, signal, startSimulator = startDevSimulator } = {}) {
  await mkdir(options.out)
  const modern = options.scenario === 'modern'
  const report = { schemaVersion: 1, status: 'failed', generatedAt: new Date().toISOString(),
    scope: 'remote CanvasKit development surface', engine: options.engine, scenario: modern ? 'modern' : 'reference', headless: true,
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    limitations: ['No physical GPU/device or performance acceptance.', 'CanvasKit flush acknowledgement is not display/GPU completion.', 'Fixture checks do not establish WeChat parity.'],
    checks: {}, requests: [], pageErrors: [], console: [], cleanup: {}, resources: { createdByThisRun: true, maxPages: 1 } }
  let owned, simulator, browser, context, page, stream, cancellationClose
  const checkCancelled = () => signal?.throwIfAborted()
  const onAbort = () => {
    // Only close an already returned page. Never abandon an in-flight launch.
    if (page && !page.isClosed()) {
      cancellationClose ||= page.close({ runBeforeUnload: false })
      cancellationClose.catch(() => {})
    }
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const save = (name, value) => writeFile(join(options.out, name), `${JSON.stringify(value, null, 2)}\n`)
  try {
    checkCancelled()
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    report.commit = git(['rev-parse', 'HEAD'])
    report.dirtySource = git(['status', '--porcelain']).length > 0
    const binary = await readFile(options.binary)
    report.binary = { path: options.binary, sha256: sha256(binary), size: binary.length }
    report.rendererConfig = JSON.parse(await readFile(join(options.rendererAssets, 'runtime-config.json')))
    owned = await mkdtemp(join(tmpdir(), 'weapp-canvaskit-smoke-'))
    const projectName = modern ? 'modern-view-app' : 'reference-app'
    const project = join(owned, projectName)
    report.resources.project = project
    await cp(join(root, 'examples/apps', projectName), project, { recursive: true,
      filter: path => !['dist', '.weapp-container', '.weapp-vite', 'node_modules'].includes(basename(path)) })
    const home = join(project, 'pages/home/index')
    if (!modern) {
      await writeFile(join(project, 'app.js'), 'App({})\n')
      await writeFile(join(project, 'app.wxss'), 'page{background:#f3f4f6}\n')
      for (const [extension, source] of [['js', fixtureScript], ['wxml', fixtureWxml], ['wxss', fixtureWxss], ['json', '{}\n']]) await writeFile(`${home}.${extension}`, source)
    }
    report.fixture = { project: projectName, scriptSha256: sha256(await readFile(`${home}.js`)),
      wxmlSha256: sha256(await readFile(`${home}.wxml`)), wxssSha256: sha256(await readFile(`${home}.wxss`)) }
    checkCancelled()
    simulator = await startSimulator({ root, project, port: 0, engine: options.engine, timeoutMs: options.timeoutMs,
      rendererAssets: options.rendererAssets, wvBin: options.wvBin, signal,
      launcher: { mode: 'simulator', command: options.binary } })
    report.resources.simulator = { pid: simulator.child.pid, url: simulator.url, staging: simulator.staging }
    // Remote readiness requires the browser. Do not wait for ready here.
    stream = await connectDevEvents(simulator.url, options.timeoutMs, { signal })
    let sequence = 0
    const api = async (name, extra = {}) => {
      const state = await simulator.json('/api/state'), requestId = `remote-smoke-${++sequence}`
      const response = stream.nextEvent('bridge', batch => batch.messages?.some(value => value.requestId === requestId && value.kind === 'response'))
      response.catch(() => {})
      await simulator.json('/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocolVersion: '1.0', sessionId: state.sessionId, requestId, kind: 'request', op: 'api.call', payload: { name, ...extra } }) })
      const result = (await response).messages.find(value => value.requestId === requestId && value.kind === 'response').payload
      assert.equal(result.ok, true, JSON.stringify(result))
      return result.result
    }
    if (!chromium) ({ chromium } = await import(pathToFileURL(resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || join(root, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))).href))
    checkCancelled()
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    checkCancelled()
    report.browserVersion = browser.version()
    context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 1 })
    checkCancelled()
    page = await context.newPage()
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin === new URL(simulator.url).origin && report.requests.length < 4096) report.requests.push({ method: request.method(), path: url.pathname })
    })
    page.on('pageerror', error => report.pageErrors.push(errorValue(error)))
    page.on('console', message => { report.console.push({ type: message.type(), text: message.text() }); if (report.console.length > 100) report.console.shift() })
    await page.goto(simulator.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
    const waitFor = async (read, label) => {
      const deadline = Date.now() + options.timeoutMs
      do {
        checkCancelled()
        const result = await read()
        if (result) return result
        await sleep(25)
      } while (Date.now() < deadline)
      throw new Error(`Timed out waiting for ${label}`)
    }
    const waitPresented = async () => {
      const receipt = await waitFor(async () => {
        let current
        try { current = await simulator.json('/api/render-frame') }
        catch (error) { if (error.status === 404) return null; throw error }
        const observed = await page.evaluate(() => ({
          ready: document.querySelector('#status')?.textContent === 'ready'
            && globalThis.__weappRendererReceipt?.backend === 'canvaskit-webgl2' && Boolean(rendererInputReady()) && !inputSuspended,
          receipt: globalThis.__weappRendererReceipt,
          metrics: { frameId: globalThis.__weappPresentationMetrics?.frameId, sessionId: globalThis.__weappPresentationMetrics?.sessionId,
            configGeneration: globalThis.__weappPresentationMetrics?.configGeneration },
        }))
        // Network work lives in Node: async waitForFunction predicates are
        // treated as immediately truthy promises by some installed versions.
        return presentationMatchesFrame(observed, current) ? observed.receipt : null
      }, 'the exact server frame to be presented and confirmed')
      assertRendererReceipt(receipt)
      return receipt
    }
    const waitFrameText = text => waitFor(async () => {
      const value = await simulator.json('/api/render-frame')
      const walk = node => [node, ...(node.children || []).flatMap(walk)]
      return walk(value.frame.root).some(node => node.text === text) ? value : null
    }, `committed text ${text}`)
    const initialReceipt = await waitPresented()
    const initial = await simulator.json('/api/state')
    assert.equal(initial.engine, options.engine)
    assert.equal(initial.webRenderer, 'canvaskit')
    report.driver = assertRendererReceipt(initialReceipt)
    report.checks.ready = { state: initial, receipt: initialReceipt }
    const readback = () => page.evaluate(async () => {
      const result = globalThis.__weappRemoteRenderer.snapshotEvidence()
      return { gpuCompletion: result.gpuCompletion, source: result.source, samples: result.samples,
        width: document.querySelector('#screen').width, height: document.querySelector('#screen').height,
        sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', result.rgba)), byte => byte.toString(16).padStart(2, '0')).join('') }
    })
    const before = await readback()
    assert.equal(before.gpuCompletion, 'gl.finish')
    await page.screenshot({ path: join(options.out, 'initial.png'), fullPage: true })
    const geometry = await api('wx.createSelectorQuery', { selector: modern ? '#increment' : '#tap' })
    const tap = Array.isArray(geometry) ? geometry[0] : geometry
    assert.ok(tap.width > 0 && tap.height > 0)
    const click = async () => {
      await waitPresented()
      const canvas = page.locator('#screen'), bounds = await canvas.boundingBox(), state = await simulator.json('/api/state')
      await canvas.click({ position: { x: (tap.left + tap.width / 2) * bounds.width / state.presentation.logicalWidth,
        y: (tap.top + tap.height / 2) * bounds.height / state.presentation.logicalHeight } })
    }
    await click()
    await waitFrameText(modern ? 'Update: 2' : 'Count: 1')
    await waitPresented()
    if (!modern) assert.equal(await api('wx.getStorageSync', { key: 'canvaskit:count' }), 1)
    const afterClick = await readback()
    assert.notEqual(afterClick.sha256, before.sha256)
    report.checks.click = { before, after: afterClick, count: modern ? 2 : 1 }
    const beforeDensity = await simulator.json('/api/render-frame')
    const oldReceipt = await page.evaluate(() => globalThis.__weappRendererReceipt)
    await page.locator('#renderScale').selectOption('2')
    await page.waitForFunction(() => presentation.effectiveScale === 2 && rendererInputReady()
      && document.querySelector('#screen').width === presentation.logicalWidth * 2
      && document.querySelector('#screen').height === presentation.logicalHeight * 2, null, { timeout: options.timeoutMs })
    await waitPresented()
    const density = await simulator.json('/api/state'), densityPixels = await readback()
    assert.equal(density.sessionId, initial.sessionId)
    assert.equal(density.presentation.logicalWidth, initial.presentation.logicalWidth)
    assert.equal(densityPixels.width, initial.presentation.logicalWidth * 2)
    assert.equal(densityPixels.height, initial.presentation.logicalHeight * 2)
    if (!modern) assert.equal(await api('wx.getStorageSync', { key: 'canvaskit:count' }), 1)
    // The modern fixture calls a shared stateful ESM counter during View
    // evaluation. Identical accepted scene data proves a density change did
    // not re-run that document; only its physical target changed.
    const afterDensity = await simulator.json('/api/render-frame')
    assert.deepEqual(afterDensity.frame, beforeDensity.frame)
    report.checks.densityRetainsAcceptedScene = true
    await click()
    await waitFrameText(modern ? 'Update: 3' : 'Count: 2')
    await waitPresented()
    if (!modern) assert.equal(await api('wx.getStorageSync', { key: 'canvaskit:count' }), 2)
    report.checks.density2x = { presentation: density.presentation, readback: densityPixels, inputCount: modern ? 3 : 2, sessionPreserved: true }
    const staleResponse = await fetch(new URL('/api/render-presented', simulator.url), { method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ sessionId: oldReceipt.sessionId, configGeneration: oldReceipt.configGeneration,
        renderRevision: oldReceipt.renderRevision, backend: oldReceipt.backend, gpuSurface: true }) })
    assert.equal(staleResponse.status, 409)
    report.checks.lateReceipt = { status: staleResponse.status, response: await staleResponse.json(), accepted: false }
    const diagnosticResponse = await fetch(new URL('/api/snapshot', simulator.url), { signal })
    assert.equal(diagnosticResponse.status, 409)
    const diagnostic = await diagnosticResponse.json()
    assert.equal(diagnostic.error.code, 'ERR_UNSUPPORTED_CAPABILITY')
    report.checks.noCpuSnapshot = diagnostic
    assertNoRgbaTransport(report.requests)
    report.checks.transport = { pageRgbaRequests: 0, perNodeRuntimeCalls: 0, frameBatches: true }
    await page.screenshot({ path: join(options.out, 'density-2x.png'), fullPage: true })
    await save('final-frame.json', await simulator.json('/api/render-frame'))
    await save('final-state.json', await simulator.json('/api/state'))
    assert.deepEqual(report.pageErrors, [])
    report.status = 'passed'
  } catch (error) {
    report.error = errorValue(error)
    report.outputTail = simulator?.outputTail()
    if (page && !page.isClosed()) {
      try { report.failureUi = await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, overlay: document.querySelector('#overlay')?.textContent, meta: document.querySelector('#meta')?.textContent })) }
      catch (observedError) { report.failureUi = { error: errorValue(observedError) } }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    const failures = []
    const cleanup = async (name, fn) => {
      try { report.cleanup[name] = await fn() }
      catch (error) { failures.push({ resource: name, ...errorValue(error) }) }
    }
    if (cancellationClose) await cleanup('cancellationPage', () => cancellationClose)
    if (page) await cleanup('page', async () => { if (!page.isClosed()) await page.close({ runBeforeUnload: false }); assert.ok(page.isClosed()); return { closed: true } })
    if (context) await cleanup('context', async () => { await context.close(); return { closed: true } })
    if (browser) await cleanup('browser', async () => { await browser.close(); assert.equal(browser.isConnected(), false); return { closed: true } })
    if (stream) await cleanup('sse', async () => { await stream.close(); return { closed: true } })
    if (simulator) await cleanup('simulator', () => simulator.stop())
    if (owned) await cleanup('project', async () => { await rm(owned, { recursive: true, force: true }); return { removed: true } })
    if (failures.length) { report.status = 'failed'; report.cleanup.errors = failures }
    await save('report.json', report)
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const signals = installSmokeSignals()
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.help) console.log('node scripts/simulator-canvaskit-browser-smoke.mjs --binary <release simulator> --renderer-assets <verified assets> --out <new evidence directory> [--engine quickjs|v8] [--scenario reference|modern] [--wv-bin path]')
    else {
      const report = await runCanvasKitDevSmoke(options, { signal: signals.signal })
      console.log(JSON.stringify({ status: report.status, report: join(options.out, 'report.json'), checks: Object.keys(report.checks), error: report.error }, null, 2))
      if (report.status !== 'passed') process.exitCode ||= 1
    }
  } catch (error) { console.error(error.stack || error); process.exitCode ||= 1 }
  finally { signals.dispose() }
}
