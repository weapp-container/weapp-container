import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const overflowCases = ['visible', 'hidden', 'axis-x-clip', 'axis-y-clip', 'axis-visible-hidden',
  'rounded-hidden', 'rounded-visible', 'nested', 'nested-next-frame', 'transformed',
  'retained-after-error', 'recovered-after-error'].sort()

// Inputs are accepted runtime frames emitted by overflow_clipping.rs, not a
// second hand-built scene. Pixel samples intentionally avoid antialiased edges.
export function runOverflowClippingSmoke(options) {
  return runAcceptedFrameSmoke({ ...options, expectedCases: overflowCases,
    title: 'Weapp Container overflow verification' })
}

// Shared lifecycle for accepted runtime frame suites. Each suite supplies its
// complete matrix explicitly; discovering only the available files can never
// turn a partial export into successful coverage.
export async function runAcceptedFrameSmoke(options) {
  const signal = options.signal
  const out = resolve(options.outDir)
  await mkdir(out, { recursive: false })
  const report = { schemaVersion: 1, status: 'running', headless: true,
    scope: 'accepted-Rust-frames-replayed-in-CanvasKit-WebGL2', startedAt: new Date().toISOString(),
    fixtures: [], cleanup: {}, limits: ['Local browser WebGL only; physical hardware is unknown.',
      'No official DevTools visual comparison, native GPU/device, scrolling or performance acceptance.'] }
  let server, browser, context, page, interruptedPageClose
  const interruptedCleanupErrors = []
  const checkCancelled = () => signal?.throwIfAborted()
  const onAbort = () => {
    report.cancellation = String(signal.reason?.message ?? signal.reason ?? 'aborted')
    // Interrupt only the page owned by this invocation. If launch is still
    // pending, the check after launch returns lets finally close its browser.
    if (page && !page.isClosed() && !interruptedPageClose) {
      interruptedPageClose = page.close().catch(error => interruptedCleanupErrors.push(String(error)))
    }
  }
  signal?.addEventListener('abort', onAbort)
  const save = (name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n')
  try {
    checkCancelled()
    assert.ok(Array.isArray(options.expectedCases) && options.expectedCases.length > 0
      && options.expectedCases.every(value => typeof value === 'string' && value.length > 0)
      && new Set(options.expectedCases).size === options.expectedCases.length,
    'A nonempty, unique explicit expected case matrix is required')
    const expectedCases = [...options.expectedCases].sort()
    const names = (await readdir(options.framesDir)).filter(name => name.endsWith('.json')).sort()
    assert.ok(names.length > 0, 'No accepted runtime frames supplied')
    const fixtures = await Promise.all(names.map(async name => {
      const bytes = await readFile(resolve(options.framesDir, name)), value = JSON.parse(bytes)
      assert.equal(value.schemaVersion, 1, name)
      assert.ok(['quickjs', 'v8'].includes(value.engine), name)
      assert.ok(value.frame && Array.isArray(value.samples) && value.samples.length > 0, name)
      return { name, sha256: sha256(bytes), value }
    }))
    for (const engine of ['quickjs', 'v8']) {
      const cases = fixtures.filter(({ value }) => value.engine === engine)
        .map(({ value }) => value.caseId ?? value.case).sort()
      assert.deepEqual(cases, expectedCases, `${engine}: missing, duplicated or unexpected fixture cases`)
    }
    report.expectedMatrix = { engines: ['quickjs', 'v8'], cases: expectedCases, fixtures: expectedCases.length * 2 }
    const dimensions = fixtures.map(({ value }) => [value.frame.viewport.width, value.frame.viewport.height])
    const [width, height] = dimensions[0]
    assert.ok(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)
    for (const size of dimensions) assert.deepEqual(size, [width, height], 'Fixtures must share one physical viewport')
    const resources = new Map()
    for (const [url, path, mime] of [
      ['/canvaskit.js', resolve(options.canvaskitDir, 'canvaskit.js'), 'text/javascript'],
      ['/canvaskit.wasm', resolve(options.canvaskitDir, 'canvaskit.wasm'), 'application/wasm'],
      ['/font.ttf', resolve(options.font), 'font/ttf'],
      ['/presenter.mjs', resolve(repository, 'examples/hosts/web-wasm/canvaskit-presenter.mjs'), 'text/javascript'],
      ['/text-flow-plan.mjs', resolve(repository, 'examples/hosts/web-wasm/text-flow-plan.mjs'), 'text/javascript'],
    ]) {
      const bytes = await readFile(path)
      resources.set(url, { bytes, mime })
      report.inputs ??= {}
      report.inputs[url] = { path, sha256: sha256(bytes), size: bytes.length }
    }
    const title = (options.title ?? 'Weapp Container frame verification').replace(/[&<>"']/g,
      character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
    const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
      <style>body{font:14px system-ui;margin:24px}canvas{display:block;margin-top:16px}</style>
      <h1>${title}</h1><p id="case"></p><canvas width="${width}" height="${height}"></canvas>
      <script src="/canvaskit.js"></script><script type="module">
      import { CanvasKitFramePresenter } from '/presenter.mjs';
      const CK=await CanvasKitInit({locateFile:()=>'/canvaskit.wasm'});
      const font=await (await fetch('/font.ttf')).arrayBuffer();
      window.presenter=await CanvasKitFramePresenter.create(CK,document.querySelector('canvas'),font);
      window.runFixture=fixture=>{
        document.querySelector('#case').textContent=fixture.engine+' / '+(fixture.caseId??fixture.case);
        const receipt=window.presenter.submit(fixture.frame), snapshot=window.presenter.snapshotEvidence();
        return {receipt,samples:fixture.samples.map(sample=>({x:sample.x,y:sample.y,
          rgba:Array.from(snapshot.rgba.slice((sample.y*${width}+sample.x)*4,(sample.y*${width}+sample.x)*4+4))}))};
      };
      window.ready=true;
      </script>`
    resources.set('/', { bytes: Buffer.from(html), mime: 'text/html' })
    server = createServer((request, response) => {
      const entry = request.method === 'GET' && resources.get(request.url)
      if (!entry) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'Content-Type': entry.mime, 'Cache-Control': 'no-store' }).end(entry.bytes)
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    checkCancelled()
    report.url = `http://127.0.0.1:${server.address().port}/`
    const { chromium } = await import(pathToFileURL(resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE
      || resolve(repository, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))).href)
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    checkCancelled()
    report.browserVersion = browser.version()
    context = await browser.newContext({ viewport: { width: 700, height: 500 } })
    checkCancelled()
    page = await context.newPage()
    checkCancelled()
    const pageErrors = report.pageErrors = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    await page.goto(report.url, { waitUntil: 'load', timeout: 30_000 })
    await page.waitForFunction(() => window.ready === true, null, { timeout: 30_000 })
    for (const fixture of fixtures) {
      checkCancelled()
      const result = await page.evaluate(value => window.runFixture(value), fixture.value)
      const record = { name: fixture.name, inputSha256: fixture.sha256, engine: fixture.value.engine,
        caseId: fixture.value.caseId ?? fixture.value.case, ...result }
      report.fixtures.push(record)
      assert.deepEqual(result.samples, fixture.value.samples.map(({ x, y, rgba }) => ({ x, y, rgba })), fixture.name)
      assert.equal(result.receipt.backend, 'canvaskit-webgl2')
      assert.equal(result.receipt.context.surfaceIsGpu, true)
      assert.equal(result.receipt.presentation.glError, 0)
      assert.deepEqual(result.receipt.runtimeBoundary, { frameBatches: 1, perNodeRuntimeCalls: 0, softwareRgbaUploads: 0 })
    }
    assert.deepEqual(pageErrors, [])
    await page.screenshot({ path: resolve(out, 'page.png') })
    checkCancelled()
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.error = error.stack || String(error)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (interruptedPageClose) await interruptedPageClose
    const cleanupErrors = interruptedCleanupErrors.map(error => ({ name: 'interruptedPageClose', error }))
    const cleanup = async (name, action) => {
      try { await action(); report.cleanup[name] = true }
      catch (error) { cleanupErrors.push({ name, error: String(error) }); report.cleanup[name] = false }
    }
    if (page && !page.isClosed()) await cleanup('presenterDisposed', () => page.evaluate(() => {
      window.presenter?.dispose()
      if (window.presenter && (!window.presenter.disposed || window.presenter.surface !== null || window.presenter.contextHandle !== 0))
        throw new Error('CanvasKit presenter resources remain live')
    }))
    if (page) await cleanup('pageClosed', async () => { await page.close(); assert.equal(page.isClosed(), true) })
    if (context) await cleanup('contextClosed', () => context.close())
    if (browser) await cleanup('browserClosed', async () => { await browser.close(); assert.equal(browser.isConnected(), false) })
    if (server) await cleanup('serverClosed', async () => {
      if (server.listening) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
      assert.equal(server.listening, false)
    })
    if (cleanupErrors.length) { report.status = 'failed'; report.cleanup.errors = cleanupErrors }
    report.finishedAt = new Date().toISOString()
    await save('report.json', report)
  }
  return report
}

export async function runFrameSmokeCli(run) {
  const options = {}, names = { '--frames-dir': 'framesDir', '--canvaskit-dir': 'canvaskitDir', '--font': 'font', '--out-dir': 'outDir' }
  for (let i = 2; i < process.argv.length; i++) {
    const key = names[process.argv[i]], value = process.argv[++i]
    if (!key || !value || value.startsWith('--') || options[key]) throw new Error('Expected --frames-dir --canvaskit-dir --font --out-dir, each once')
    options[key] = resolve(value)
  }
  if (Object.values(names).some(key => !options[key])) throw new Error('Missing required argument')
  const controller = new AbortController()
  const interrupt = signal => controller.abort(new Error(`ERR_CANCELLED: ${signal}`))
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM')
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm)
  try {
    const report = await run({ ...options, signal: controller.signal })
    console.log(JSON.stringify({ status: report.status, fixtures: report.fixtures.length, report: resolve(options.outDir, 'report.json'), error: report.error }))
    if (report.status !== 'passed') process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runFrameSmokeCli(runOverflowClippingSmoke)
}
