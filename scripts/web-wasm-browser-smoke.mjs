import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export function parseArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const key = { '--site-dir': 'siteDir', '--out-dir': 'outDir' }[args[i]]
    if (!key) throw new Error(`Unknown argument: ${args[i]}`)
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}`)
    if (options[key]) throw new Error(`Duplicate argument: ${args[i]}`)
    options[key] = resolve(args[++i])
  }
  if (!options.siteDir || !options.outDir) throw new Error('Usage: node scripts/web-wasm-browser-smoke.mjs --site-dir <built-static-site> --out-dir <new-evidence-directory>')
  if (options.siteDir === options.outDir || options.outDir.startsWith(options.siteDir + sep)
    || options.siteDir.startsWith(options.outDir + sep)) throw new Error('Site and evidence directories must be separate')
  return options
}

export async function inspectBuiltSite(siteDir) {
  const bytes = await readFile(resolve(siteDir, 'build-report.json')), build = JSON.parse(bytes)
  assert.equal(build.status, 'passed', 'Only a clean passed build is browser-gate eligible')
  assert.equal(build.ready, true)
  assert.notEqual(build.plan?.execution, 'worker',
    'The synchronous browser smoke is an explicit legacy gate; use a real default Worker product browser gate')
  assert.notEqual(build.browserAssets?.execution, 'worker', 'Worker browser assets cannot be certified by the legacy smoke')
  const entry = build.browserAssets?.entry || 'index.html'
  assert.ok(['index.html', 'legacy.html'].includes(entry), 'Unknown legacy browser entry')
  for (const kind of ['glue', 'wasm']) {
    const artifact = build.artifacts?.[kind]
    assert.ok(artifact?.path && /^[0-9a-f]{64}$/.test(artifact.sha256), `Missing ${kind} artifact provenance`)
    const path = resolve(siteDir, artifact.path)
    assert.ok(path.startsWith(siteDir + sep), 'Artifact path must remain within the built site')
    assert.equal(sha256(await readFile(path)), artifact.sha256, `${kind} differs from its build report`)
  }
  const config = JSON.parse(await readFile(resolve(siteDir, 'runtime-config.json')))
  assert.equal(config.schemaVersion, 1)
  assert.ok(['software', 'canvaskit'].includes(config.renderer))
  assert.equal(config.fallback, 'error')
  return { config, entry, build: { status: build.status, reportSha256: sha256(bytes), source: build.source, artifacts: build.artifacts,
    execution: 'legacy', entry } }
}

/** Own exactly one local server, browser, context and page, and release all of
 * them before reporting success. The caller can inject an installed Chromium
 * launcher for tests; no browser/dependency installation occurs here.
 */
export async function runBrowserSmoke(options, { chromium, signal = options.signal } = {}) {
  const siteDir = await realpath(options.siteDir), out = resolve(options.outDir)
  await mkdir(out, { recursive: false })
  const report = { schemaVersion: 1, status: 'running', scope: 'static-WebAssembly-embedding-reference-smoke',
    product: 'Weapp Container', headless: true, startedAt: new Date().toISOString(), requests: [], checks: {}, cleanup: {},
    limitations: ['Reference fixture only; no DevTools visual differential, physical device, Web V8 or performance acceptance.',
      'WebGL driver identity is recorded; physical hardware remains unknown.'] }
  const errors = [], consoleMessages = []
  let server, browser, context, page
  let cancellationPageClose = null, cleanupFailed = false
  const save = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n')
  const onAbort = () => {
    report.cancellation ??= { reason: String(signal.reason?.message ?? signal.reason ?? 'aborted'), receivedAt: new Date().toISOString() }
    // Closing only this run's page interrupts Playwright waits/evaluations.
    // Never race browser.launch: its owned browser must first be returned so
    // the normal finally block can release it after an interrupted launch.
    if (page && !page.isClosed() && !cancellationPageClose) {
      cancellationPageClose = Promise.resolve().then(() => page.close({ runBeforeUnload: false })).then(() => {
        report.cleanup.cancellationPageClosed = page.isClosed()
        if (!page.isClosed()) throw new Error('Owned page remained open after cancellation close')
      }).catch(error => {
        report.cleanup.cancellationPageCloseError = error.stack || String(error)
        cleanupFailed = true
      })
    }
  }
  const checkCancelled = () => {
    if (!signal?.aborted) return
    onAbort()
    throw new Error(`ERR_CANCELLED: ${report.cancellation.reason}`)
  }
  signal?.addEventListener('abort', onAbort)
  try {
    checkCancelled()
    const inspected = await inspectBuiltSite(siteDir)
    checkCancelled()
    report.build = inspected.build
    report.rendererConfig = inspected.config
    if (!chromium) {
      const modulePath = process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE
        || resolve(repository, 'vendor/weapp-vite/node_modules/playwright/index.mjs')
      try { ({ chromium } = await import(pathToFileURL(resolve(modulePath)).href)) }
      catch (error) { throw new Error(`ERR_TEST_INFRASTRUCTURE: installed Playwright unavailable at ${modulePath}: ${error.message}`) }
    }
    checkCancelled()
    server = createServer(async (request, response) => {
      let path
      try {
        const pathname = new URL(request.url, 'http://localhost').pathname
        report.requests.push({ method: request.method, pathname })
        path = resolve(siteDir, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname))
        if (!path.startsWith(siteDir + sep) || !(await realpath(path)).startsWith(siteDir + sep)) {
          response.writeHead(403).end(); return
        }
        const bytes = await readFile(path)
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
          '.wasm': 'application/wasm', '.ttf': 'font/ttf' }[extname(path)] || 'application/octet-stream'
        response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }).end(bytes)
      } catch { response.writeHead(404).end() }
    })
    checkCancelled()
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    checkCancelled()
    report.url = `http://127.0.0.1:${server.address().port}/${inspected.entry === 'index.html' ? '' : inspected.entry}`
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    checkCancelled()
    report.browserVersion = browser.version()
    context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
    checkCancelled()
    page = await context.newPage()
    page.on('console', message => { consoleMessages.push({ type: message.type(), text: message.text() }); if (consoleMessages.length > 50) consoleMessages.shift() })
    checkCancelled()
    page.on('pageerror', error => errors.push(error.stack || String(error)))
    await page.goto(report.url, { waitUntil: 'load', timeout: 30_000 })
    assert.equal(await page.evaluate(() => window.weappReady), true, await page.locator('#error').textContent())
    report.title = await page.title()
    assert.match(report.title, /^Weapp Container/)
    const initial = await page.evaluate(() => {
      const app = window.weapp, frame = JSON.parse(app.host.render_frame_json())
      const walk = node => [node, ...node.children.flatMap(walk)]
      return { sessionId: app.sessionId, route: app.route.path, capabilities: app.capabilities,
        presentation: app.presentation, frame, nodes: walk(frame.root), trace: window.weappTrace }
    })
    report.checks.startup = { sessionId: initial.sessionId, route: initial.route, capabilities: initial.capabilities, presentation: initial.presentation }
    assert.equal(initial.route, 'pages/home/index')
    assert.ok(initial.nodes.some(node => node.text === 'Weapp Container 微信小程序容器'))
    const messages = initial.trace.flatMap(batch => batch.messages || [])
    for (const op of ['app.init', 'app.lifecycle', 'page.push', 'render.commit']) {
      assert.ok(messages.some(message => message.op === op && message.kind === 'response' && message.payload.ok === true), op)
    }
    const initialized = messages.find(message => message.op === 'app.init' && message.kind === 'response').payload
    assert.equal(initialized.engineProviderAvailable, true)
    report.checks.appInit = initialized
    await save('frame-before.json', initial.frame)
    await save('trace-before.json', initial.trace)
    report.checks.loadOwnership = await page.evaluate(async () => {
      const { WeappWebSession } = await import('./app.mjs')
      const detached = document.createElement('canvas')
      detached.width = 375; detached.height = 667
      const app = new WeappWebSession(detached)
      const settle = promise => promise.then(() => ({ accepted: true }), error => ({ error: String(error) }))
      // Both calls occur before the first load can resume past await init().
      const first = settle(app.load()), second = settle(app.load())
      app.close()
      try {
        const [initialLoad, concurrentLoad] = await Promise.all([first, second])
        return { initialLoad, concurrentLoad, state: app.state, hostReleased: app.host === null, rafReleased: app.frameRequest === null }
      } finally { app.close() }
    })
    assert.match(report.checks.loadOwnership.initialLoad.error || '', /ERR_CANCELLED/)
    assert.match(report.checks.loadOwnership.concurrentLoad.error || '', /new wrapper/i)
    assert.equal(report.checks.loadOwnership.state, 'closed')
    assert.equal(report.checks.loadOwnership.hostReleased, true)
    assert.equal(report.checks.loadOwnership.rafReleased, true)

    const sampleVisible = () => page.evaluate(async () => {
      const app = window.weapp, frame = JSON.parse(app.host.render_frame_json())
      const walk = node => [node, ...node.children.flatMap(walk)]
      const component = walk(frame.root).find(node => node.background?.red === 237 && node.background?.green === 246 && node.background?.blue === 240)
      if (!component) throw new Error('Missing green component render node')
      const width = app.canvas.width, height = app.canvas.height
      const readback = app.presenter?.snapshotEvidence()
      const pixels = readback ? readback.rgba : app.context.getImageData(0, 0, width, height).data
      const at = (x, y) => ({ x, y, rgba: Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4)) })
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), byte => byte.toString(16).padStart(2, '0')).join('')
      return { source: app.presenter ? 'CanvasKit GPU surface readback' : 'Canvas 2D software RGBA', width, height, sha256: hash,
        gpuCompletion: readback?.gpuCompletion ?? null,
        corners: [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)],
        component: at(Math.floor(component.bounds.x + component.bounds.width - 4), Math.floor(component.bounds.y + component.bounds.height / 2)),
        presentation: app.presentation }
    })
    report.checks.visualBefore = await sampleVisible()
    for (const sample of report.checks.visualBefore.corners) assert.deepEqual(sample.rgba, [243, 244, 246, 255])
    assert.deepEqual(report.checks.visualBefore.component.rgba, [237, 246, 240, 255])

    const button = initial.nodes.find(node => node.id === 'increment'), canvas = await page.locator('#surface').boundingBox()
    assert.ok(button?.bounds.width > 0 && canvas)
    await page.mouse.click(canvas.x + (button.bounds.x + button.bounds.width / 2) * canvas.width / initial.frame.viewport.width,
      canvas.y + (button.bounds.y + button.bounds.height / 2) * canvas.height / initial.frame.viewport.height)
    await page.waitForFunction(() => {
      const walk = node => [node, ...node.children.flatMap(walk)]
      return walk(JSON.parse(window.weapp.host.render_frame_json()).root).some(node => node.text === '点击次数：1')
    }, null, { timeout: 5_000 })
    report.checks.canvasClick = 'QuickJS WXML listener -> setData -> committed page count 1'
    const componentButton = initial.nodes.find(node => node.id === 'component-increment')
    assert.ok(componentButton?.bounds.width > 0)
    await page.mouse.click(canvas.x + (componentButton.bounds.x + componentButton.bounds.width / 2) * canvas.width / initial.frame.viewport.width,
      canvas.y + (componentButton.bounds.y + componentButton.bounds.height / 2) * canvas.height / initial.frame.viewport.height)
    await page.waitForFunction(() => {
      const walk = node => [node, ...node.children.flatMap(walk)]
      const texts = walk(JSON.parse(window.weapp.host.render_frame_json()).root).map(node => node.text)
      return ['点击次数：1', '组件计数：1', '页面 slot：1'].every(text => texts.includes(text))
    }, null, { timeout: 5_000 })
    report.checks.componentClick = 'Component listener -> independent count 1; page count and projected slot remain 1'
    report.checks.v8ExplicitFailure = await page.evaluate(() => {
      const app = window.weapp, before = app.host.render_frame_json(), capabilities = app.host.capabilities_json()
      let error
      try { app.host.load_manifest_json_with_config(JSON.stringify(app.manifest), JSON.stringify({ session_id: 'unavailable-v8', engine: 'v8', require_integrity: true })) }
      catch (failure) { error = String(failure) }
      return { error, preserved: before === app.host.render_frame_json(), capabilitiesPreserved: capabilities === app.host.capabilities_json() }
    })
    assert.match(report.checks.v8ExplicitFailure.error || '', /ERR_ENGINE/)
    assert.equal(report.checks.v8ExplicitFailure.preserved, true)
    assert.equal(report.checks.v8ExplicitFailure.capabilitiesPreserved, true)
    report.checks.lifecycle = await page.evaluate(() => ({
      hide: window.weapp.request('app.lifecycle', { event: 'hide' }), show: window.weapp.request('app.lifecycle', { event: 'show' }),
    }))
    assert.equal(report.checks.lifecycle.hide.ok, true)
    assert.equal(report.checks.lifecycle.show.ok, true)
    report.checks.rafPolling = await page.evaluate(async () => {
      const host = window.weapp.host, original = host.poll_timers.bind(host)
      let calls = 0
      host.poll_timers = (...args) => { calls++; return original(...args) }
      try { await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); return { calls, scheduledTimerFixture: false } }
      finally { host.poll_timers = original }
    })
    assert.ok(report.checks.rafPolling.calls > 0)

    if (inspected.config.renderer === 'canvaskit') {
      assert.equal(initial.capabilities.renderer, 'external-frame-export')
      assert.equal(initial.capabilities.gpuSurface, false, 'Rust IR export does not claim the external GPU')
      const receipt = initial.presentation
      assert.equal(receipt.backend, 'canvaskit-webgl2')
      assert.equal(receipt.context.surfaceIsGpu, true)
      assert.equal(receipt.context.contextLost, false)
      assert.deepEqual(receipt.runtimeBoundary, { frameBatches: 1, perNodeRuntimeCalls: 0, softwareRgbaUploads: 0 })
      assert.equal(receipt.presentation.glError, 0)
      assert.equal(receipt.presentation.pictureSubmissions, 1)
      assert.equal(receipt.presentation.flushes, 1)
      assert.equal(receipt.presentation.gpuCompletion, 'not-waited')
      assert.equal(report.checks.visualBefore.gpuCompletion, 'gl.finish')
      assert.equal(receipt.context.api, 'webgl2')
      assert.equal(receipt.context.physicalHardware, 'unknown')
      assert.equal(receipt.parityStatus, 'partial')
      assert.ok(receipt.textNodes > 0 && receipt.glyphs > 0)
      report.checks.noSoftwarePixels = await page.evaluate(() => {
        const app = window.weapp, original = app.host.render_snapshot_rgba, before = app.frameId
        let calls = 0
        app.host.render_snapshot_rgba = () => { calls++; throw new Error('Software pixels forbidden in CanvasKit smoke') }
        try { app.render(); return { calls, frameBefore: before, frameAfter: app.frameId, backend: app.presentation.backend } }
        finally { app.host.render_snapshot_rgba = original }
      })
      assert.equal(report.checks.noSoftwarePixels.calls, 0)
      assert.ok(report.checks.noSoftwarePixels.frameAfter > report.checks.noSoftwarePixels.frameBefore)
      assert.equal(report.checks.noSoftwarePixels.backend, 'canvaskit-webgl2')
      report.checks.rejectedFrame = await page.evaluate(async () => {
        const app = window.weapp, frame = JSON.parse(app.host.render_frame_json()), before = app.presenter.lastReceipt
        const digest = async pixels => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), n => n.toString(16).padStart(2, '0')).join('')
        const pixels = await digest(app.presenter.snapshotEvidence().rgba)
        // Keep the typed frame valid so capability rejection cannot be confused
        // with a malformed node. Image nodes now have a real resource contract.
        frame.viewport.x = 1
        let error
        try { app.presenter.submit(frame) } catch (failure) { error = failure.toJSON?.() ?? { message: String(failure) } }
        return { error, receiptPreserved: app.presenter.lastReceipt === before, readbackPreserved: pixels === await digest(app.presenter.snapshotEvidence().rgba) }
      })
      assert.equal(report.checks.rejectedFrame.error?.code, 'ERR_UNSUPPORTED_CAPABILITY')
      assert.equal(report.checks.rejectedFrame.receiptPreserved, true)
      assert.equal(report.checks.rejectedFrame.readbackPreserved, true)
      report.checks.invalidImage = await page.evaluate(async () => {
        const app = window.weapp, frame = JSON.parse(app.host.render_frame_json()), before = app.presenter.lastReceipt
        const digest = async pixels => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), n => n.toString(16).padStart(2, '0')).join('')
        const pixels = await digest(app.presenter.snapshotEvidence().rgba)
        frame.root.image = { resource: 'missing-smoke-image', mode: 'scaleToFill' }
        let error
        try { app.presenter.submit(frame) } catch (failure) { error = failure.toJSON?.() ?? { message: String(failure) } }
        return { error, receiptPreserved: app.presenter.lastReceipt === before, readbackPreserved: pixels === await digest(app.presenter.snapshotEvidence().rgba) }
      })
      assert.equal(report.checks.invalidImage.error?.code, 'ERR_RENDER')
      assert.equal(report.checks.invalidImage.receiptPreserved, true)
      assert.equal(report.checks.invalidImage.readbackPreserved, true)
      report.checks.presentationRecovery = await page.evaluate(async () => {
        const app = window.weapp, previous = app.presenter.options.typography
        const pollTimers = app.host.poll_timers
        let error, blockedInput, suspended, automaticRedrawStopped, timerPolls = 0
        app.host.poll_timers = (...args) => { timerPolls++; return pollTimers.apply(app.host, args) }
        try {
          // Controlled negative fixture: the reference declares 40rpx/700,
          // which the shared native-v1 layout cannot honor in strict mode.
          app.presenter.options.typography = 'strict-css'
          try { app.render() } catch (failure) { error = failure.toJSON?.() ?? { message: String(failure) } }
          suspended = app.suspended
          const failedFrame = app.frameId
          try { app.request('event.batch', { events: [] }) } catch (failure) { blockedInput = String(failure) }
          // Suspension stops presentation, while the owner keeps polling guest
          // timers and lifecycle. Observe actual RAF turns instead of assuming
          // an absent RAF handle means that input and redraws are suspended.
          for (let turn = 0; turn < 3; turn++) await new Promise(done => requestAnimationFrame(done))
          automaticRedrawStopped = app.frameId === failedFrame
        } finally { app.presenter.options.typography = previous; app.host.poll_timers = pollTimers }
        app.render()
        return { error, suspended, automaticRedrawStopped, timerPolls, blockedInput, recovered: !app.suspended, rafResumed: app.frameRequest !== null }
      })
      assert.equal(report.checks.presentationRecovery.error?.code, 'ERR_UNSUPPORTED_CAPABILITY')
      assert.equal(report.checks.presentationRecovery.suspended, true)
      assert.equal(report.checks.presentationRecovery.automaticRedrawStopped, true)
      assert.ok(report.checks.presentationRecovery.timerPolls >= 2)
      assert.match(report.checks.presentationRecovery.blockedInput || '', /ERR_RENDER/)
      assert.equal(report.checks.presentationRecovery.recovered, true)
      assert.equal(report.checks.presentationRecovery.rafResumed, true)
    } else {
      assert.equal(initial.presentation.backend, 'software-rgba')
      report.limitations.push('Software RGBA has no WXML text rasterization; this run does not establish CanvasKit or GPU rendering.')
    }
    report.checks.visualAfter = await sampleVisible()
    assert.deepEqual(report.checks.visualAfter.component.rgba, [237, 246, 240, 255])
    const after = await page.evaluate(() => ({ frame: JSON.parse(window.weapp.host.render_frame_json()), trace: window.weappTrace }))
    await save('frame-after.json', after.frame)
    await save('trace-after.json', after.trace)
    await page.screenshot({ path: resolve(out, 'page.png'), fullPage: true })
    assert.equal(await page.locator('#error').isVisible(), false)
    assert.equal(report.requests.some(request => request.pathname.startsWith('/api/')), false)
    assert.deepEqual(errors, [])

    if (inspected.config.renderer === 'canvaskit') {
      const supported = await page.evaluate(() => {
        const extension = window.weapp.presenter.gl.getExtension('WEBGL_lose_context')
        if (!extension) return false
        extension.loseContext(); return true
      })
      if (!supported) throw new Error('ERR_TEST_INFRASTRUCTURE: WEBGL_lose_context unavailable; context-loss gate blocked')
      await page.waitForFunction(() => window.weapp.presenter.lost, null, { timeout: 5_000 })
      report.checks.contextLoss = await page.evaluate(() => {
        try { window.weapp.render(); return { accepted: true } }
        catch (failure) { return { error: failure.toJSON?.() ?? { message: String(failure) } } }
      })
      assert.equal(report.checks.contextLoss.error?.code, 'ERR_RENDER')
      assert.match(report.checks.contextLoss.error.message, /context lost|unavailable/)
    }
    await page.evaluate(() => {
      const app = window.weapp, original = app.onBatch
      const probe = window.__weappSmokeUnloadProbe = { callbackCalls: 0 }
      window.__weappSmokeOriginalBatch = original
      app.onBatch = batch => {
        original(batch)
        if (batch.messages?.some(message => message.kind === 'response' && message.op === 'app.lifecycle' && message.payload.event === 'unload')) {
          probe.callbackCalls++
          try { app.request('event.batch', { events: [] }); probe.accepted = true }
          catch (error) { probe.error = String(error) }
        }
      }
    })
    await page.locator('#dispose').click()
    await page.waitForFunction(() => window.weapp.closed && window.weapp.host === null, null, { timeout: 5_000 })
    report.checks.dispose = await page.evaluate(async () => {
      const app = window.weapp
      await app.close()
      const unloadReentry = window.__weappSmokeUnloadProbe
      app.onBatch = window.__weappSmokeOriginalBatch
      delete window.__weappSmokeUnloadProbe
      delete window.__weappSmokeOriginalBatch
      let error
      try { app.request('render.commit', {}) } catch (failure) { error = String(failure) }
      return { closed: app.closed, hostReleased: app.host === null, presenterDisposed: app.presenter ? app.presenter.disposed : null,
        unloadReentry, afterCloseError: error }
    })
    assert.equal(report.checks.dispose.closed, true)
    assert.equal(report.checks.dispose.hostReleased, true)
    if (inspected.config.renderer === 'canvaskit') assert.equal(report.checks.dispose.presenterDisposed, true)
    assert.equal(report.checks.dispose.unloadReentry.callbackCalls, 1)
    assert.match(report.checks.dispose.unloadReentry.error || '', /unloaded|closed/i)
    assert.match(report.checks.dispose.afterCloseError, /unloaded|closed/i)
    assert.deepEqual(errors, [])
    checkCancelled()
    report.status = 'passed'
  } catch (error) {
    report.status = signal?.aborted ? 'cancelled' : /ERR_TEST_INFRASTRUCTURE/.test(error.message) ? 'blocked' : 'failed'
    report.error = error.stack || String(error)
    if (!signal?.aborted && page && !page.isClosed()) {
      try {
        report.failureState = await page.evaluate(() => ({ error: document.querySelector('#error')?.textContent,
          status: document.querySelector('#status')?.textContent, state: window.weapp?.state,
          capabilities: window.weapp?.capabilities, presentation: window.weapp?.presentation, trace: window.weappTrace }))
        await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true })
      } catch (failure) { report.failureCaptureError = failure.stack || String(failure) }
    }
  } finally {
    const cleanup = async (name, action) => {
      try { report.cleanup[name] = await action() }
      catch (error) { report.cleanup[`${name}Error`] = error.stack || String(error); cleanupFailed = true }
    }
    if (signal?.aborted) onAbort()
    if (cancellationPageClose) await cancellationPageClose
    if (signal?.aborted && page?.isClosed()) report.cleanup.runtime = 'page teardown on cancellation; explicit runtime unload not observed'
    if (!signal?.aborted && page && !page.isClosed()) await cleanup('runtime', () => page.evaluate(async () => {
      await window.weapp?.close()
      return { closed: window.weapp?.closed, hostReleased: window.weapp?.host === null }
    }))
    if (cancellationPageClose) await cancellationPageClose
    if (context) await cleanup('contextClosed', async () => { await context.close(); return true })
    if (browser) await cleanup('browserClosed', async () => { await browser.close(); return !browser.isConnected() })
    if (server?.listening) await cleanup('serverClosed', async () => {
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
      return !server.listening
    })
    signal?.removeEventListener('abort', onAbort)
    if (cleanupFailed) report.status = 'failed'
    else if (signal?.aborted) report.status = 'cancelled'
    report.pageErrors = errors
    report.consoleMessages = consoleMessages
    report.finishedAt = new Date().toISOString()
    await save('execution.json', report)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController()
  const interrupt = name => () => {
    if (!controller.signal.aborted) controller.abort(Object.assign(new Error(`Received ${name}`), { signalName: name }))
  }
  const onInterrupt = interrupt('SIGINT'), onTerminate = interrupt('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  try {
    const report = await runBrowserSmoke(parseArgs(process.argv.slice(2)), { signal: controller.signal })
    console.log(JSON.stringify({ status: report.status, error: report.error, cleanup: report.cleanup }))
    if (report.status !== 'passed') process.exitCode = report.status === 'cancelled'
      ? controller.signal.reason?.signalName === 'SIGTERM' ? 143 : 130 : 1
  } catch (error) { console.error(error.stack || String(error)); process.exitCode = 1 }
  finally {
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onTerminate)
  }
}
