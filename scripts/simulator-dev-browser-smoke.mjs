#!/usr/bin/env node
/**
 * Browser smoke for the development simulator Web surface.
 *
 * This is intentionally a software/headless development check. It proves that
 * a real browser can render the supplied canvas, observe the simulator state,
 * and receive the same SSE hot-reload revision that /api/state exposes. It
 * does not certify DevTools, GPU, emulator, or device behavior.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { installSmokeSignals, startDevSimulator } from './simulator-dev-harness.mjs'
import { assertDiagnosticResponse } from './simulator-dev-assertions.mjs'
import { verifyReferenceFixture } from './simulator-reference-fixture.mjs'
import { startSimulatorSseProxy } from './simulator-sse-proxy.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const gitOutput = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const provenance = {
  commit: gitOutput(['rev-parse', 'HEAD']),
  workspaceVendorCommit: gitOutput(['-C', 'vendor/weapp-vite', 'rev-parse', 'HEAD']),
  workspaceVendorDirty: gitOutput(['-C', 'vendor/weapp-vite', 'status', '--porcelain']).length > 0,
  environment: { platform: process.platform, arch: process.arch, node: process.version },
}
const args = process.argv.slice(2)
const valueAfter = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: pnpm simulator:dev:browser-smoke -- [options]

Options:
  --project <dir>   weapp-vite project (default: examples/apps/reference-app)
  --port <number>   Web surface port (default: 0, allocated by OS)
  --engine <name>   quickjs (default) or v8
  --reference-fixture verify an external project's tracked source against HEAD reference-app; enable full reference interaction checks
  --timeout <ms>    wait timeout (default: 120000)
  --out <file>      JSON report path
  --screenshot <file> save the reloaded simulator page as a PNG
  --keep            preserve simulator staging output`)
  process.exit(0)
}

const project = resolve(valueAfter('--project', 'examples/apps/reference-app'))
const port = Number(valueAfter('--port', '0'))
const engine = valueAfter('--engine', 'quickjs')
const timeoutMs = Number(valueAfter('--timeout', '120000'))
const reportPath = valueAfter('--out', null)
const screenshotPath = valueAfter('--screenshot', null)
const keep = args.includes('--keep')
if (!existsSync(project)) throw new Error(`project does not exist: ${project}`)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port: ${port}`)
if (!['quickjs', 'v8'].includes(engine)) throw new Error(`invalid --engine: ${engine}`)
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error(`invalid --timeout: ${timeoutMs}`)
// External copies need explicit identity proof before they receive the full
// reference-only text, page/component input and slot-owner assertions.
// Keep the original path's established behavior for existing callers.
const referenceFixture = args.includes('--reference-fixture') ? verifyReferenceFixture(root, project) : null
const isReferenceFixture = project === resolve(root, 'examples/apps/reference-app') || referenceFixture?.verified === true

function firstSourceWxss(directory) {
  const ignored = new Set(['.git', '.weapp-container', 'dist', 'node_modules'])
  const result = []
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignored.has(entry.name)) visit(resolve(current, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.wxss')) result.push(resolve(current, entry.name))
    }
  }
  visit(directory)
  result.sort()
  return result[0] ?? null
}

const source = firstSourceWxss(project)
if (!source) throw new Error('fixture has no source WXSS file')
let simulator
const apiState = () => simulator.json('/api/state')
const waitForState = (predicate, label) => simulator.waitForState(predicate, label)

const startedAt = Date.now()
const signals = installSmokeSignals()
let original = null
let expectedSource = null
let browser = null
let context = null
let transportProxy = null
let report
let closingContext
let closingBrowser
const closeContext = () => context ? (closingContext ||= context.close()) : Promise.resolve()
const closeBrowser = () => browser ? (closingBrowser ||= browser.close()) : Promise.resolve()
let abortBrowserCleanup
const abortBrowser = () => {
  // Closing owned Playwright resources wakes pending waits; await the same
  // cleanup below before restoring handlers or finishing the report.
  abortBrowserCleanup ||= (async () => {
    const errors = []
    try { await closeContext() } catch (error) { errors.push(error) }
    try { await closeBrowser() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, `browser cancellation cleanup failed: ${errors.map(error => error.message).join('; ')}`)
  })()
  // The rejection is reported by finally, without becoming unhandled first.
  abortBrowserCleanup.catch(() => {})
}
signals.signal.addEventListener('abort', abortBrowser, { once: true })
try {
  simulator = await startDevSimulator({ root, project, port, engine, timeoutMs, signal: signals.signal,
    onOutput: (text, stderr) => (stderr ? process.stderr : process.stdout).write(text) })
  const playwrightPath = pathToFileURL(resolve(root, 'vendor/weapp-vite/node_modules/playwright/index.mjs')).href
  const { chromium } = await import(playwrightPath)
  original = readFileSync(source, 'utf8')
  const initial = await waitForState(value => Number(value.revision) > 0 && value.status === 'ready', 'initial ready generation')
  transportProxy = await startSimulatorSseProxy(simulator.url)
  signals.signal.throwIfAborted()
  browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
  signals.signal.throwIfAborted()
  context = await browser.newContext()
  signals.signal.throwIfAborted()
  const page = await context.newPage()
  await page.goto(transportProxy.url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'ready', null, { timeout: timeoutMs })
  await page.waitForFunction(requireContent => {
    const canvas = document.querySelector('#screen')
    const pixels = canvas?.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
    if (!pixels?.some((value, index) => index % 4 === 3 && value > 0)) return false
    // A uniform white canvas used to pass smoke while the rectangle-only
    // fallback silently omitted all text from the reference application.
    let inkPixels = 0
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100 && pixels[index + 3] > 0) inkPixels++
    }
    return !requireContent || inkPixels > 32
  }, isReferenceFixture, { timeout: timeoutMs })
  const initialDom = await page.evaluate(() => ({
    canvas: { width: document.querySelector('#screen')?.width, height: document.querySelector('#screen')?.height },
    route: document.querySelector('#route')?.textContent,
    meta: document.querySelector('#meta')?.textContent,
    overlay: getComputedStyle(document.querySelector('#overlay')).display,
  }))
  if (!initialDom.canvas.width || !initialDom.canvas.height) throw new Error('browser canvas has invalid dimensions')
  if (!initialDom.route?.includes(initial.route)) throw new Error(`browser route does not include ${initial.route}`)
  if (initial.lifecycleState !== 'Active' || !initialDom.route.includes('Active')) throw new Error('browser lifecycle is not Active')
  if (initial.engine !== engine || !initialDom.meta?.includes(engine)) throw new Error('browser engine does not match the requested engine provider')
  if (!initial.renderer || !initialDom.meta.includes(initial.renderer)) throw new Error('browser renderer does not match the runtime')
  if (initialDom.overlay !== 'none') throw new Error('browser error overlay visible on initial generation')
  const verifyIdleReconnect = async label => {
    const before = await apiState()
    try {
      // Chromium offline emulation leaves established EventSource sockets
      // alive. Break only this test's SSE transports, while keeping HTTP
      // state/snapshot/bridge available for authoritative recovery.
      transportProxy.setEventsOnline(false)
      await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'disconnected', null, { timeout: 15000 })
    } finally {
      transportProxy.setEventsOnline(true)
    }
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'ready' &&
      getComputedStyle(document.querySelector('#overlay')).display === 'none', null, { timeout: timeoutMs })
    const after = await apiState()
    if (before.sessionId !== after.sessionId || before.revision !== after.revision) {
      throw new Error(`${label} reconnect changed the running session/generation`)
    }
    return 'passed'
  }
  const inspectorReconnect = await verifyIdleReconnect('inspector')
  if (screenshotPath) {
    mkdirSync(dirname(resolve(screenshotPath)), { recursive: true })
    await page.screenshot({ path: resolve(screenshotPath), fullPage: true })
  }
  let pointerSetData = 'not_checked'
  let managedComponents = 'not_checked'
  let inspectorSubmissionResult = 'not_checked'
  let referenceInputPixels = null
  if (isReferenceFixture) {
    let querySequence = 0
    const queryBounds = async selector => {
      const requestId = `browser-bounds-${++querySequence}`
      // The supervisor acknowledges HTTP submission before it drives the
      // thread-affine engine. Correlate the eventual SSE response by request
      // id through the same inspector adapter used by developers.
      await page.locator('#bridge').fill(JSON.stringify({
        protocolVersion: '1.0', sessionId: initial.sessionId,
        requestId, kind: 'request', op: 'api.call',
        payload: { name: 'wx.createSelectorQuery', selector },
      }))
      // Hold the first HTTP acknowledgement until its real SSE runtime
      // response has arrived. This deterministically exercises the order
      // which used to overwrite the result with {queued:true}.
      const delayed = querySequence === 1
      let release
      const acknowledgement = new Promise(done => { release = done })
      const holdAcknowledgement = async route => {
        const response = await route.fetch()
        await acknowledgement
        await route.fulfill({ response })
      }
      if (delayed) await page.route('**/api/bridge', holdAcknowledgement)
      let batch
      try {
        await page.locator('#send').click()
        await page.waitForFunction(id => {
          try {
            return JSON.parse(document.querySelector('#bridgeResult').textContent).messages
              ?.some(value => value.requestId === id && value.kind === 'response')
          } catch { return false }
        }, requestId, { timeout: timeoutMs })
        batch = JSON.parse(await page.locator('#bridgeResult').textContent())
      } finally {
        release()
        if (delayed) await page.unrouteAll({ behavior: 'wait' })
      }
      await page.waitForFunction(() => {
        try { return JSON.parse(document.querySelector('#submission').textContent).queued === true }
        catch { return false }
      }, null, { timeout: timeoutMs })
      if (JSON.stringify(JSON.parse(await page.locator('#bridgeResult').textContent())) !== JSON.stringify(batch)) {
        throw new Error('HTTP submission acknowledgement overwrote the inspector runtime response')
      }
      if (delayed) inspectorSubmissionResult = 'passed'
      const result = batch.messages.find(value => value.requestId === requestId && value.kind === 'response')?.payload
      if (!result?.ok || !(result.result?.width > 0 && result.result?.height > 0)) {
        throw new Error(`selector ${selector} failed: ${JSON.stringify(result)}`)
      }
      return result.result
    }
    const target = await queryBounds('#increment')
    const frameBeforeInput = await simulator.json('/api/snapshot')
    const canvas = page.locator('#screen')
    const bounds = await canvas.boundingBox()
    // Hit the actual committed selector geometry through the canvas input
    // adapter so font/layout changes do not turn this into a guessed click.
    await canvas.click({ position: {
      x: (target.left + target.width / 2) * bounds.width / frameBeforeInput.width,
      y: (target.top + target.height / 2) * bounds.height / frameBeforeInput.height,
    } })
    await page.waitForFunction(async frameId => {
      const response = await fetch('/api/snapshot', { cache: 'no-store' })
      return response.ok && (await response.json()).frame_id > frameId
    }, frameBeforeInput.frame_id, { timeout: timeoutMs })
    const frameAfterInput = await simulator.json('/api/snapshot')
    if (JSON.stringify(frameBeforeInput.pixels) === JSON.stringify(frameAfterInput.pixels)) {
      throw new Error(`reference tap produced no visible setData change: ${JSON.stringify({
        target, beforeFrame: frameBeforeInput.frame_id, afterFrame: frameAfterInput.frame_id,
        state: await apiState(), bridgeResult: await page.locator('#bridgeResult').textContent(),
      })}`)
    }
    pointerSetData = 'passed'
    referenceInputPixels = frameAfterInput.pixels
    const countBounds = await queryBounds('#count')
    const componentCountBounds = await queryBounds('#component-count')
    const region = (snapshot, rect) => {
      const pixels = []
      for (let y = Math.max(0, Math.floor(rect.top)); y < Math.min(snapshot.height, Math.ceil(rect.bottom)); y++) {
        const start = (y * snapshot.width + Math.max(0, Math.floor(rect.left))) * 4
        const end = (y * snapshot.width + Math.min(snapshot.width, Math.ceil(rect.right))) * 4
        pixels.push(...snapshot.pixels.slice(start, end))
      }
      return JSON.stringify(pixels)
    }
    const tapSelector = async selector => {
      const target = await queryBounds(selector)
      const before = await simulator.json('/api/snapshot')
      const canvasBounds = await canvas.boundingBox()
      await canvas.click({ position: {
        x: (target.left + target.width / 2) * canvasBounds.width / before.width,
        y: (target.top + target.height / 2) * canvasBounds.height / before.height,
      } })
      await page.waitForFunction(async frameId => (await (await fetch('/api/snapshot')).json()).frame_id > frameId,
        before.frame_id, { timeout: timeoutMs })
      return (await simulator.json('/api/snapshot'))
    }
    const componentFrame = await tapSelector('#component-increment')
    if (region(componentFrame, componentCountBounds) === region(frameAfterInput, componentCountBounds)) {
      throw new Error('component-owned tap did not update its counter pixels')
    }
    if (region(componentFrame, countBounds) !== region(frameAfterInput, countBounds)) {
      throw new Error('component-owned tap changed the page counter')
    }
    const slotFrame = await tapSelector('#component-slot')
    if (region(slotFrame, countBounds) === region(componentFrame, countBounds)) {
      throw new Error('projected slot tap did not reach its page owner')
    }
    if (region(slotFrame, componentCountBounds) !== region(componentFrame, componentCountBounds)) {
      throw new Error('projected slot tap changed component-owned counter state')
    }
    managedComponents = { independentSetData: 'passed', slotDeclarationOwner: 'passed' }
    referenceInputPixels = slotFrame.pixels
  }
  // Exercise the actual inspector input and asynchronous bridge/SSE error
  // path, then require a successful reload to clear the visible overlay.
  await page.locator('#bridge').fill(JSON.stringify({
    protocolVersion: '1.0', sessionId: initial.sessionId,
    requestId: 'browser-smoke-unsupported-api', kind: 'request', op: 'api.call',
    payload: { name: 'wx.__weappContainerBrowserSmokeUnsupported' },
  }))
  await page.locator('#send').click()
  await page.waitForFunction(() => {
    const overlay = document.querySelector('#overlay')
    return getComputedStyle(overlay).display !== 'none' && overlay.textContent.length > 0
  }, null, { timeout: timeoutMs })
  const failedState = await apiState()
  if (!failedState.diagnostics?.some(value => value.code === 'ERR_UNSUPPORTED_CAPABILITY')) {
    throw new Error('unsupported API did not reach the structured runtime diagnostic stream')
  }
  const retainedError = failedState.diagnosticHistory?.records?.find(value => value.code === 'ERR_UNSUPPORTED_CAPABILITY')
  if (failedState.diagnosticHistory?.schemaVersion !== 1 || !retainedError) {
    throw new Error('runtime error was not retained in versioned diagnostic history')
  }
  const reloadPromise = page.waitForFunction(revision => Number(document.querySelector('#meta')?.textContent.match(/rev (\d+)/)?.[1] || 0) > revision, initial.revision, { timeout: timeoutMs })
  reloadPromise.catch(() => {})
  signals.signal.throwIfAborted()
  if (readFileSync(source, 'utf8') !== original) throw new Error(`source changed concurrently; refusing overwrite: ${source}`)
  expectedSource = `${original}\n/* weapp browser smoke ${Date.now()} */\n`
  writeFileSync(source, expectedSource)
  const reloaded = await waitForState(value => Number(value.revision) > Number(initial.revision), 'browser hot reload')
  if (reloaded.sessionId !== initial.sessionId) throw new Error('WXSS reload replaced the active session')
  if (reloaded.diagnostics?.length) throw new Error('successful reload left active diagnostics')
  if (!reloaded.diagnosticHistory?.records?.some(value => JSON.stringify(value) === JSON.stringify(retainedError))) {
    throw new Error('successful reload erased diagnostic history')
  }
  await reloadPromise
  if (referenceInputPixels) {
    const reloadedSnapshot = await simulator.json('/api/snapshot')
    if (JSON.stringify(reloadedSnapshot.pixels) !== JSON.stringify(referenceInputPixels)) throw new Error('WXSS comment reload lost the visible page state')
  }
  const reloadedDom = await page.evaluate(() => ({
    meta: document.querySelector('#meta')?.textContent,
    overlay: getComputedStyle(document.querySelector('#overlay')).display,
    status: document.querySelector('#status')?.textContent,
  }))
  if (reloadedDom.status !== 'ready') throw new Error(`browser status after reload: ${reloadedDom.status}`)
  if (reloadedDom.overlay !== 'none') throw new Error('browser error overlay visible after successful reload')
  if (!(await page.locator('#log').textContent()).includes('ERR_UNSUPPORTED_CAPABILITY')) {
    throw new Error('browser log lost the historical runtime error after overlay recovery')
  }
  if (screenshotPath) {
    mkdirSync(dirname(resolve(screenshotPath)), { recursive: true })
    await page.screenshot({ path: resolve(screenshotPath), fullPage: true })
  }
  // Reuse the same tab to exercise the app-side embedding client against
  // the existing session rather than booting a second runtime/browser.
  await page.goto(new URL('/embed', transportProxy.url).href, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#screen')
    const pixels = canvas?.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
    return document.querySelector('#status')?.textContent === 'ready' &&
      pixels?.some((value, index) => index % 4 === 3 && value > 0)
  }, null, { timeout: timeoutMs })
  const embeddingState = await apiState()
  if (embeddingState.sessionId !== reloaded.sessionId) throw new Error('embedding created a second runtime session')
  if (!(await page.locator('#route').textContent()).includes(reloaded.route)) throw new Error('embedding route differs from inspector')
  const [submitted] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/bridge') && response.request().method() === 'POST'),
    page.locator('#send').click(),
  ])
  if (!submitted.ok()) throw new Error('embedding diagnostic bridge request failed')
  const diagnosticRequest = submitted.request().postDataJSON()
  if (diagnosticRequest.op !== 'diagnostic' || diagnosticRequest.sessionId !== embeddingState.sessionId) {
    throw new Error('embedding submitted an unexpected diagnostic request')
  }
  await page.waitForFunction(request => {
    try {
      return JSON.parse(document.querySelector('#bridgeResult').textContent).messages?.some(message =>
        message.requestId === request.requestId && message.sessionId === request.sessionId &&
        message.op === request.op && message.kind === 'response')
    } catch { return false }
  }, diagnosticRequest, { timeout: timeoutMs })
  assertDiagnosticResponse(JSON.parse(await page.locator('#bridgeResult').textContent()), diagnosticRequest)
  if (await page.locator('#overlay').isVisible()) throw new Error('embedding diagnostic request showed an error overlay')
  const embeddingReconnect = await verifyIdleReconnect('embedding')
  report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'simulator-dev-browser-smoke',
    ...provenance,
    status: 'passed',
    url: simulator.url,
    browserUrl: transportProxy.url,
    transportFaultInjection: 'owned-loopback-proxy-drops-sse',
    staging: simulator.staging,
    project,
    referenceFixture,
    source: relative(project, source),
    surface: 'web-browser-headless',
    headless: true,
    engine: initial.engine,
    compiler: initial.compiler,
    renderer: initial.renderer,
    lifecycleState: initial.lifecycleState,
    runtimeErrorOverlay: 'ERR_UNSUPPORTED_CAPABILITY',
    overlayClearedAfterReload: true,
    diagnosticHistoryRetainedAfterReload: true,
    pointerSetData,
    managedComponents,
    inspectorSubmissionResult,
    idleReconnect: { inspector: inspectorReconnect, embedding: embeddingReconnect },
    embedding: { path: '/embed', sharedSession: true, diagnosticBatch: 'passed' },
    initialRevision: initial.revision,
    reloadRevision: reloaded.revision,
    canvas: initialDom.canvas,
    browserMeta: reloadedDom.meta,
    screenshot: screenshotPath ? resolve(screenshotPath) : null,
    elapsedMs: Date.now() - startedAt,
    evidence: 'development simulator only; no DevTools/GPU/device gate',
  }
} catch (error) {
  report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    scope: 'simulator-dev-browser-smoke',
    ...provenance,
    status: 'failed',
    project,
    referenceFixture,
    source: relative(project, source),
    elapsedMs: Date.now() - startedAt,
    error: String(error?.stack || error),
    outputTail: simulator?.outputTail(),
  }
  process.exitCode ||= 1
} finally {
  const cleanupErrors = []
  const cleanup = async (resource, action) => {
    try { return await action() } catch (error) { cleanupErrors.push(`${resource}: ${error?.stack || error}`) }
  }
  await cleanup('source restoration', () => {
    if (expectedSource != null) {
      if (readFileSync(source, 'utf8') !== expectedSource) throw new Error(`source changed concurrently; refusing restoration: ${source}`)
      writeFileSync(source, original, 'utf8')
    }
  })
  await cleanup('browser cancellation', async () => { if (abortBrowserCleanup) await abortBrowserCleanup })
  await cleanup('browser context', closeContext)
  await cleanup('browser', closeBrowser)
  report.transportProxyCleanup = await cleanup('SSE transport proxy', async () => {
    if (!transportProxy) return null
    const result = await transportProxy.close()
    if (!result.listenerClosed || result.activeRequests || result.activeEventStreams || result.activeSockets) {
      throw new Error(`proxy did not release its transports: ${JSON.stringify(result)}`)
    }
    return result
  })
  if (report.status === 'passed') {
    await cleanup('server after browser disconnect', async () => {
      const state = await apiState()
      if (state.status !== 'ready') throw new Error(`unexpected server status: ${state.status}`)
    })
  }
  report.cleanup = await cleanup('simulator', async () => simulator?.stop({ keep }))
  if (cleanupErrors.length) {
    report.status = 'failed'
    report.cleanupErrors = cleanupErrors
    process.exitCode = 1
  }
  signals.signal.removeEventListener('abort', abortBrowser)
  signals.dispose()
}
const serialized = `${JSON.stringify(report, null, 2)}\n`
process.stdout.write(serialized)
if (reportPath) {
  const absoluteReport = resolve(reportPath)
  mkdirSync(dirname(absoluteReport), { recursive: true })
  writeFileSync(absoluteReport, serialized, 'utf8')
}
if (report.status !== 'passed') process.exitCode ||= 1
