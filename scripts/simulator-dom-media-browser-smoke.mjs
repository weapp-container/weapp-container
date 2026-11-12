#!/usr/bin/env node
/** Real development-loop media observations. Importing creates no resources. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { release, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connectDevEvents, installSmokeSignals, startDevSimulator } from './simulator-dev-harness.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const errorValue = error => ({ name: error.name, message: error.message, stack: error.stack })
const sameKey = (a, b) => a && b && ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile'].every(key => a[key] === b[key])
const copyFilter = path => !['node_modules', 'dist', '.weapp-vite', '.weapp-container'].includes(basename(path))
const requiredChecks = ['firstCallback', 'logicalResize', 'sameDimensions', 'renderScaleOnly', 'disconnect', 'disconnectedResize', 'geometryGates']
async function bounded(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

export function parseOptions(args) {
  const options = { binary: join(root, 'target/release/weapp-simulator'), engine: 'quickjs', timeoutMs: 120000 }
  const fields = { '--binary': 'binary', '--engine': 'engine', '--out': 'out', '--wv-bin': 'wvBin', '--timeout': 'timeoutMs' }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') return { help: true }
    const field = fields[args[index]], value = args[++index]
    if (!field || !value || value.startsWith('--')) throw new Error('Expected --binary, --engine, --out, --wv-bin or --timeout with a value')
    options[field] = value
  }
  if (!options.out) throw new Error('--out must identify a new evidence directory')
  if (!['quickjs', 'v8'].includes(options.engine)) throw new Error('Invalid engine')
  options.timeoutMs = Number(options.timeoutMs)
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('Invalid timeout')
  for (const field of ['binary', 'out', 'wvBin']) if (options[field]) options[field] = resolve(options[field])
  return options
}

/** Only the owned reference-app copy receives these six overrides. */
export async function createMediaFixture(project) {
  const files = {
    'app.js': 'App({})\n',
    'app.wxss': '',
    'pages/home/index.json': '{}\n',
    'pages/home/index.js': `Page({
  data: { matches: 'pending', count: 0, unbound: false, disconnected: false,
    mediaSupported: false, selectorSupported: true, intersectionSupported: true },
  onLoad() {
    const page = this
    this.setData({ mediaSupported: wx.canIUse('createMediaQueryObserver'),
      selectorSupported: wx.canIUse('createSelectorQuery'),
      intersectionSupported: wx.canIUse('createIntersectionObserver') })
    this.mediaObserver = wx.createMediaQueryObserver()
    this.mediaObserver.observe({ minWidth: 500 }, function(result) {
      'use strict'
      page.setData({ matches: result.matches, count: page.data.count + 1, unbound: this === undefined })
    })
  },
  disconnect() {
    this.mediaObserver.disconnect()
    this.setData({ disconnected: true })
  },
  onUnload() { if (this.mediaObserver) this.mediaObserver.disconnect() }
})\n`,
    'pages/home/index.wxml': `<view class="panel">
  <text id="media-supported">media={{mediaSupported}}</text>
  <text id="media-state">matches={{matches}};count={{count}};unbound={{unbound}};disconnected={{disconnected}}</text>
  <text id="geometry-gates">selector={{selectorSupported}};intersection={{intersectionSupported}}</text>
  <view id="disconnect" class="button" bindtap="disconnect">Disconnect observer</view>
</view>\n`,
    'pages/home/index.wxss': 'page{background:#f3f4f6}.panel{padding:20px}text{display:block;margin-bottom:16px;font-size:16px;color:#102030}.button{width:230px;padding:12px;background:#2050a0;color:white}\n',
  }
  for (const [path, source] of Object.entries(files)) await writeFile(join(project, path), source)
  return files
}

async function inventory(directory) {
  const result = []
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) { const bytes = await readFile(absolute); result.push({ path: relative(directory, absolute), sha256: digest(bytes), size: bytes.length }) }
    }
  }
  await visit(directory)
  return result.sort((a, b) => a.path.localeCompare(b.path))
}

/** One owned watch-built app, process, SSE, context and headless page. No
 * existing simulator address, browser tab or original app is accessed. */
export async function runDomMediaSmoke(options, { chromium, signal, startSimulator = startDevSimulator } = {}) {
  await mkdir(dirname(options.out), { recursive: true })
  await mkdir(options.out)
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: 'failed', engine: options.engine,
    scope: 'watch-built portable app, real JS engine and remote DOM browser presentation', headless: true,
    environment: { platform: process.platform, osRelease: release(), arch: process.arch, node: process.version },
    coverage: { requiredChecks, densityTransition: 'renderScale only; actual browser DPR is fixed at 2' },
    checks: {}, presentationRequests: [], pageErrors: [], console: [], cleanup: {}, resources: { createdByThisRun: true, maxPages: 1 },
    limitations: ['No actual browser DPR transition, DevTools parity, timing, native/GPU or device acceptance.'] }
  let owned, simulator, stream, browser, context, page, cancellationClose
  let sequence = 0
  const save = (name, value) => writeFile(join(options.out, name), `${JSON.stringify(value, null, 2)}\n`)
  const checkCancelled = () => signal?.throwIfAborted()
  const onAbort = () => { if (context) { cancellationClose ||= context.close(); cancellationClose.catch(() => {}) } }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    checkCancelled()
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    report.commit = git(['rev-parse', 'HEAD'])
    report.workingTree = git(['status', '--porcelain'])
    report.submodule = { sha: git(['-C', 'vendor/weapp-vite', 'rev-parse', 'HEAD']), status: git(['-C', 'vendor/weapp-vite', 'status', '--porcelain']) }
    const bytes = await readFile(options.binary)
    report.binary = { path: options.binary, sha256: digest(bytes), size: bytes.length }
    report.scriptSha256 = digest(await readFile(fileURLToPath(import.meta.url)))
    const sources = ['Cargo.toml', 'Cargo.lock', 'crates/container-runtime/src/lib.rs', 'crates/container-runtime/src/observers.rs',
      'crates/container-runtime/src/browser_view.rs', 'crates/container-simulator/src/lib.rs', 'crates/container-simulator/src/main.rs', 'crates/container-simulator/src/dev.rs',
      'crates/container-simulator/src/web.rs', 'crates/container-simulator/src/web_dom.rs', 'crates/container-simulator/src/web-ui.html',
      'crates/container-engine-quickjs/src/lib.rs', 'crates/container-engine-v8/src/lib.rs',
      'scripts/simulator-dev-harness.mjs', 'examples/hosts/web-wasm/remote-dom.mjs', 'examples/hosts/web-wasm/dom-session-client.mjs',
      'examples/hosts/web-wasm/dom-presenter.mjs']
    report.sourceInputs = await Promise.all(sources.map(async path => { const source = await readFile(join(root, path)); return { path, sha256: digest(source), size: source.length } }))
    report.wv = { requested: options.wvBin ?? 'fixed vendor discovery', submoduleSha: report.submodule.sha }
    if (options.wvBin) report.wv.sha256 = digest(await readFile(options.wvBin))
    owned = await mkdtemp(join(tmpdir(), 'weapp-dom-media-'))
    const project = join(owned, 'reference-app')
    report.resources.project = project
    await cp(join(root, 'examples/apps/reference-app'), project, { recursive: true, filter: copyFilter })
    await createMediaFixture(project)
    report.fixture = { source: 'owned reference-app copy with inline media fixture', files: await inventory(project) }
    await cp(project, join(options.out, 'fixture'), { recursive: true, filter: copyFilter })
    simulator = await startSimulator({ root, project, port: 0, engine: options.engine, renderer: 'webview', viewport: '375x667',
      wvBin: options.wvBin, timeoutMs: options.timeoutMs, signal, launcher: { mode: 'simulator', command: options.binary } })
    report.resources.simulator = { pid: simulator.child.pid, url: simulator.url, staging: simulator.staging }
    await save('owned-resources.json', report.resources)
    stream = await connectDevEvents(simulator.url, options.timeoutMs, { signal })
    const waitFor = async (read, label) => {
      const deadline = Date.now() + options.timeoutMs
      do {
        checkCancelled()
        const result = await read()
        if (result) return result
        await new Promise(done => setTimeout(done, 30))
      } while (Date.now() < deadline)
      throw new Error(`Timed out waiting for ${label}`)
    }
    if (!chromium) ({ chromium } = await import(pathToFileURL(resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || join(root, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))).href))
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    report.environment.browser = browser.version()
    checkCancelled()
    context = await browser.newContext({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2 })
    checkCancelled()
    page = await context.newPage()
    page.setDefaultTimeout(Math.min(options.timeoutMs, 10000))
    page.on('pageerror', error => report.pageErrors.push(errorValue(error)))
    page.on('console', message => { report.console.push({ type: message.type(), text: message.text() }); if (report.console.length > 150) report.console.shift() })
    const waitPresented = () => waitFor(async () => {
      const state = await simulator.json('/api/state')
      const ui = await page.evaluate(() => ({ receipt: globalThis.__weappDomReceipt, owner: globalThis.__weappDomSurface?.isOwner,
        accepted: globalThis.__weappDomSurface?.client.accepted, authority: globalThis.__weappDomSurface?.authority, dpr: devicePixelRatio }))
      return state.webRenderer === 'webview' && ui.owner === true && ui.receipt?.phase === 'presented'
        && sameKey(ui.receipt.key, state.viewPresented?.key) && state.viewInputEnabled === true && ui.accepted?.inputEnabled === true
        && sameKey(ui.accepted.key, state.viewPresented.key) && ui.authority?.previewEpoch === state.preview.epoch ? { state, ui } : null
    }, 'runtime-confirmed owner DOM frame')
    const dom = () => page.frameLocator('#domScreen iframe:visible')
    const readMedia = async () => {
      const text = await dom().locator('#media-state').textContent()
      const match = text.match(/^matches=(pending|true|false);count=(\d+);unbound=(true|false);disconnected=(true|false)$/)
      assert.ok(match, `Unexpected media state: ${text}`)
      return { text, matches: match[1], count: Number(match[2]), unbound: match[3] === 'true', disconnected: match[4] === 'true' }
    }
    const waitMedia = (count, matches, disconnected = false) => waitFor(async () => {
      const value = await readMedia()
      return value.count === count && value.matches === matches && value.disconnected === disconnected && value.unbound ? value : null
    }, `media callback state ${count}/${matches}/${disconnected}`)
    // No-change checks observe a bounded interval over several live host polls.
    // The final configuration event and confirmed presentation are prerequisites.
    const assertStable = async expected => {
      const observations = []
      for (let sample = 0; sample < 5; sample++) {
        checkCancelled(); await new Promise(done => setTimeout(done, 60))
        const observed = await readMedia()
        assert.deepEqual(observed, expected)
        observations.push({ elapsedSample: sample + 1, observed })
      }
      return observations
    }
    const apply = async patch => {
      const before = await simulator.json('/api/state'), requestId = `dom-media-settings-${++sequence}`
      const body = await page.evaluate(value => globalThis.__weappDomSurface.fence(value), { requestId, revision: before.presentation.revision, ...patch })
      const record = { body }; report.presentationRequests.push(record)
      const finalEvent = stream.nextEvent('presentation', value => value.requestId === requestId)
      finalEvent.catch(() => {})
      const receipt = await simulator.json('/api/presentation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      record.receipt = receipt
      assert.equal(receipt.queued, true)
      const committed = await finalEvent
      record.committed = committed
      assert.equal(committed.ok, true, JSON.stringify(committed))
      assert.ok(committed.presentation.revision > before.presentation.revision)
      for (const [key, value] of Object.entries(patch)) assert.equal(committed.presentation[key], value)
      const after = await waitPresented()
      assert.equal(after.state.sessionId, before.sessionId, 'presentation must preserve the AppService session')
      return after
    }
    await page.goto(simulator.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
    const initial = await waitPresented(), initialMedia = await waitMedia(1, 'false')
    assert.equal(initial.state.engine, options.engine)
    assert.equal(initial.state.presentation.logicalWidth, 375)
    assert.equal(initial.state.presentation.logicalHeight, 667)
    assert.equal(initial.ui.dpr, 2)
    assert.equal(await dom().locator('#media-supported').textContent(), 'media=true')
    report.checks.firstCallback = { initial, media: initialMedia, stable: await assertStable(initialMedia) }
    assert.equal(await dom().locator('#geometry-gates').textContent(), 'selector=false;intersection=false')
    report.checks.geometryGates = { selector: false, intersection: false }
    await page.screenshot({ path: join(options.out, 'initial.png'), fullPage: true })
    const resized = await apply({ logicalWidth: 667, logicalHeight: 375 })
    assert.equal(resized.state.viewPresented.viewport.width, 667)
    assert.equal(resized.state.viewPresented.viewport.height, 375)
    const matched = await waitMedia(2, 'true')
    report.checks.logicalResize = { state: resized, media: matched }
    const repeated = await apply({ logicalWidth: 667, logicalHeight: 375 })
    report.checks.sameDimensions = { revision: repeated.state.presentation.revision, stable: await assertStable(matched) }
    const densityBefore = (await waitPresented()).state
    const densityAfter = await apply({ renderScale: 1.5 })
    assert.deepEqual(densityAfter.state.viewPresented, densityBefore.viewPresented, 'DOM density preferences must not evaluate another View')
    report.checks.renderScaleOnly = { presentation: densityAfter.state.presentation, stable: await assertStable(matched) }
    await dom().locator('#disconnect').click()
    const disconnected = await waitMedia(2, 'true', true)
    await waitPresented()
    report.checks.disconnect = { media: disconnected, stable: await assertStable(disconnected) }
    const afterDisconnect = await apply({ logicalWidth: 375, logicalHeight: 667 })
    report.checks.disconnectedResize = { state: afterDisconnect, stable: await assertStable(disconnected) }
    assert.equal(await dom().locator('#geometry-gates').textContent(), 'selector=false;intersection=false')
    assert.deepEqual(report.pageErrors, [])
    assert.ok(requiredChecks.every(name => report.checks[name]), 'Every declared case must complete')
    assert.equal(report.console.some(value => /cleanup failed/i.test(value.text)), false)
    await page.screenshot({ path: join(options.out, 'final.png'), fullPage: true })
    await save('final-state.json', await simulator.json('/api/state'))
    report.status = 'passed'
  } catch (error) {
    report.error = errorValue(error); report.outputTail = simulator?.outputTail()
    if (simulator) try { await save('failure-state.json', await simulator.json('/api/state')) } catch (failure) { report.failureStateError = errorValue(failure) }
    if (page && !page.isClosed()) try { await page.screenshot({ path: join(options.out, 'failure.png'), fullPage: true }) } catch (failure) { report.failureScreenshotError = errorValue(failure) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    const failures = []
    const cleanup = async (name, operation) => { try { report.cleanup[name] = await bounded(Promise.resolve().then(operation), 20000, `cleanup ${name}`) ?? true } catch (error) { failures.push({ resource: name, ...errorValue(error) }) } }
    if (cancellationClose) await cleanup('cancellationContext', () => cancellationClose)
    if (page) await cleanup('page', async () => {
      if (!page.isClosed()) {
        try { await bounded(page.evaluate(async () => { if (typeof closeEventStream === 'function') closeEventStream(); await globalThis.__weappCleanupPromise }), 3000, 'browser lifecycle cleanup') }
        finally { await page.close() }
      }
      assert.ok(page.isClosed())
    })
    if (context) await cleanup('context', () => context.close())
    if (browser) await cleanup('browser', async () => { await browser.close(); assert.equal(browser.isConnected(), false) })
    if (stream) await cleanup('sse', () => stream.close())
    if (simulator) await cleanup('packEvidence', async () => {
      const archive = join(options.out, 'staging')
      await cp(simulator.staging, archive, { recursive: true })
      report.packEvidence = await inventory(archive)
      return { archived: true, files: report.packEvidence.length }
    })
    if (simulator) await cleanup('simulator', () => simulator.stop())
    if (owned) await cleanup('project', () => rm(owned, { recursive: true, force: true }))
    if (report.console.some(value => /cleanup failed/i.test(value.text))) failures.push({ resource: 'browser lifecycle', message: 'Browser logged a cleanup failure; see console evidence' })
    if (failures.length) { report.cleanup.errors = failures; report.status = 'failed' }
    report.completedAt = new Date().toISOString()
    await save('report.json', report)
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const signals = installSmokeSignals()
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.help) console.log('node scripts/simulator-dom-media-browser-smoke.mjs --binary <release simulator> --out <new directory> [--engine quickjs|v8] [--wv-bin <builder>]')
    else { const result = await runDomMediaSmoke(options, { signal: signals.signal }); console.log(JSON.stringify({ status: result.status, report: join(options.out, 'report.json'), checks: Object.keys(result.checks), error: result.error }, null, 2)); if (result.status !== 'passed') process.exitCode ||= 1 }
  } catch (error) { console.error(error.stack || error); process.exitCode ||= 1 }
  finally { signals.dispose() }
}
