#!/usr/bin/env node
// Actual QuickJS/WASM + DOM adapter boundary probe. This is an explicit
// presenter harness, not the Worker product UI, watch loop or IME acceptance.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WORKER_PRODUCT_FILES, canonical, regularBytes, installWindowWasmAudit } from './worker-product-browser-smoke.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const save = (out, name, value) => writeFile(resolve(out, name), JSON.stringify(value, null, 2) + '\n')

async function inspectSite(directory, expectedCommit, expectedIndex) {
  const build = JSON.parse(await regularBytes(directory, 'build-report.json'))
  assert.equal(build.status, 'passed'); assert.equal(build.ready, true); assert.equal(build.buildStatus, 'passed')
  assert.equal(build.source.sourceCommit, expectedCommit); assert.equal(build.source.workingTreeDirty, false)
  assert.equal(build.source.sourceStable, true); assert.equal(build.source.status, 'passed')
  assert.equal(build.source.sourceSha256, sha(JSON.stringify(build.source.sourceFiles)))
  for (const [path, hash] of Object.entries(build.source.sourceFiles)) {
    assert.ok(hex(hash)); assert.equal(sha(await regularBytes(resolve(directory, 'source'), path)), hash, path)
  }
  assert.deepEqual(build.browserAssets.files.map(file => file.path), WORKER_PRODUCT_FILES)
  const files = new Map(), inventory = []
  let retained = 0
  const retain = async descriptor => {
    const path = descriptor.path ?? descriptor.url?.replace(/^\.\//, '')
    assert.ok(path && hex(descriptor.sha256) && !files.has(path))
    const bytes = await regularBytes(directory, path)
    assert.equal(bytes.length, descriptor.size); assert.equal(sha(bytes), descriptor.sha256, path)
    retained += bytes.length; assert.ok(retained <= 384 * 1024 * 1024)
    files.set(path, bytes); inventory.push({ path, size: bytes.length, sha256: sha(bytes) })
    return bytes
  }
  for (const file of build.browserAssets.files) {
    assert.equal(file.sha256, build.source.sourceFiles[`examples/hosts/web-wasm/${file.path}`])
    await retain(file)
  }
  assert.equal(build.generatedPackage.status, 'passed'); assert.equal(build.generatedPackage.retainedStatus, 'passed')
  for (const file of build.generatedPackage.files) { assert.ok(file.path.startsWith('pkg/')); await retain(file) }
  assert.equal(build.packIndex.sha256, expectedIndex)
  const indexBytes = await retain(build.packIndex), index = JSON.parse(indexBytes)
  assert.deepEqual(index, build.pack)
  const manifestBytes = await regularBytes(directory, index.manifest)
  const manifest = JSON.parse(await retain({ path: index.manifest, size: manifestBytes.length, sha256: index.manifestSha256 }))
  assert.equal(manifest.integrity.root, index.integrityRoot)
  assert.equal(sha(canonical({ ...manifest, integrity: { ...manifest.integrity, root: '' } })), index.integrityRoot)
  assert.deepEqual(manifest.routes.map(route => route.path), ['pages/home/index'])
  assert.equal(manifest.rendering.pages?.['pages/home/index'] ?? manifest.rendering.default, 'webview')
  for (const blob of index.blobs) await retain(blob)
  return { files, inventory, build, indexBytes, manifest }
}

// Runs on Window. The only application host is created inside the owned Worker.
async function startProbe(input) {
  const { WorkerRpcClient } = await import('/worker-session-client.mjs')
  const { WorkerDomAdapter } = await import('/worker-dom-adapter.mjs')
  const state = window.nativeLifetimeProbe = { trace: [], diagnostics: [], withheld: [], holding: false,
    nextAttempt: 0, nextRequest: 0, terminated: 0 }
  const rpc = state.rpc = new WorkerRpcClient({ workerUrl: './runtime-worker.mjs', timeoutMs: 15000,
    workerFactory: (url, options) => {
      const worker = new Worker(url, options), terminate = worker.terminate.bind(worker)
      worker.terminate = () => { state.terminated++; return terminate() }
      return worker
    },
    onEvent(message) {
      state.trace.push({ direction: 'event', message })
      if (state.holding) state.withheld.push(message)
      else state.adapter?.receiveEvent(message)
    },
    onFailure(error) { state.diagnostics.push({ code: error.code, message: error.message }) },
  })
  const request = state.request = async (op, payload) => {
    state.trace.push({ direction: 'request', op, payload })
    try {
      const result = await rpc.requestHost(op, payload)
      state.trace.push({ direction: 'response', op, result })
      return result
    } catch (error) {
      state.trace.push({ direction: 'rejected', op, code: error.code, message: error.message, details: error.details })
      throw error
    }
  }
  // Install ownership cleanup before load can allocate/fail an actual host.
  state.cleanup = async () => {
    const result = { errors: [] }
    try { if (state.adapter) result.adapter = await state.adapter.dispose() } catch (error) { result.errors.push(`adapter: ${error.stack}`) }
    try { result.worker = await rpc.close() } catch (error) { result.errors.push(`worker: ${error.stack}`) }
    result.terminated = state.terminated; result.rpcState = rpc.state
    result.pendingCount = rpc.pendingCount; result.inFlightBytes = rpc.inFlightBytes
    result.frames = document.querySelectorAll('iframe').length
    return result
  }
  const loaded = state.loaded = await request('load', {
    indexUrl: './pack-index.json', indexSha256: input.indexSha256, indexSize: input.indexSize,
    renderer: 'browser-view', engine: 'quickjs', viewport: { width: 375, height: 667 },
    observation: { version: '1.0' }, engineExecution: { bootstrapTimeoutMs: 5000, turnTimeoutMs: 250 },
  })
  state.adapter = new WorkerDomAdapter({ rpc, loadResult: loaded, container: document.querySelector('#surface'),
    onDiagnostic: error => state.diagnostics.push({ code: error.code, message: error.message }) })
  state.present = async () => {
    const adapter = state.adapter, demand = adapter.observation.state
    const controller = new AbortController()
    const context = { owner: adapter.owner, attemptId: String(++state.nextAttempt), surfaceGeneration: demand.surfaceGeneration,
      signal: controller.signal, isCurrent: () => !controller.signal.aborted }
    const candidate = await adapter.prepareTemplate(demand, context)
    let final
    try { final = await adapter.present(candidate, { ...context, proof: candidate.proof }); return { final, proof: candidate.proof } }
    finally { await adapter.release(candidate, { ...context, proof: candidate.proof, committed: !!final?.acknowledged, retired: false }) }
  }
  state.drain = async () => {
    await new Promise(resolve => requestAnimationFrame(resolve))
    await state.adapter.presenter.currentEntry?.geometryBarrier
    await state.adapter.client.turn
  }
  state.bridge = async (op, payload) => {
    const requestId = `lifetime-probe-${++state.nextRequest}`
    const batch = await request('bridge', { envelope: { protocolVersion: '1.0', sessionId: rpc.sessionId,
      requestId, kind: 'request', op, payload } })
    const response = batch.messages.find(message => message.kind === 'response' && message.requestId === requestId && message.op === op)
    if (!response) throw new Error('Missing exact native bridge response')
    return { batch, payload: response.payload }
  }
  return { capabilities: loaded.capabilities, observation: loaded.observation, owner: state.adapter.owner }
}

export async function runInputLifetimeBrowserSmoke({ siteDir, indexSha256, expectedSourceCommit, outDir }) {
  assert.ok(hex(indexSha256)); assert.match(expectedSourceCommit, /^[0-9a-f]{40}$/)
  const out = resolve(outDir); await mkdir(out, { recursive: false })
  const report = { schemaVersion: 1, status: 'running', headless: true, scope: 'explicit-native-Worker-DOM-text-lifetime-harness',
    startedAt: new Date().toISOString(), cases: [], resources: {}, cleanup: {},
    limitations: ['No product-entry/watch, IME continuity, official, GPU, other-host or performance acceptance.',
      'The receiver-only same-generation lifetime cases are unit tests. The genuine producer advances both native lifetime and logical surface generation.'] }
  let server, browser, context, page, failure
  const sockets = new Set(), pageErrors = [], workers = []
  try {
    const site = await inspectSite(resolve(siteDir), expectedSourceCommit, indexSha256)
    await save(out, 'site-inventory.json', site.inventory)
    await save(out, 'build-source.json', site.build.source)
    const script = await readFile(fileURLToPath(import.meta.url)); await writeFile(resolve(out, 'harness.mjs'), script)
    report.harnessSha256 = sha(script); report.sourceCommit = expectedSourceCommit
    const html = Buffer.from('<!doctype html><meta charset="utf-8"><title>Worker DOM input lifetime probe</title><style>#surface{width:375px;height:667px}</style><div id="surface"></div>')
    server = createServer((request, response) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname.slice(1)
      if (request.method !== 'GET') { response.writeHead(405).end(); return }
      if (path === 'favicon.ico') { response.writeHead(204).end(); return }
      const bytes = path === 'probe.html' ? html : site.files.get(path)
      if (!bytes) { response.writeHead(404).end(); return }
      const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }[extname(path)] ?? 'application/octet-stream'
      response.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' }).end(bytes)
    })
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    report.resources.server = `http://127.0.0.1:${server.address().port}/probe.html`
    const { chromium } = await import(pathToFileURL(resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE ?? resolve(ROOT, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))).href)
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    context = await browser.newContext({ viewport: { width: 900, height: 900 } })
    await context.addInitScript(installWindowWasmAudit)
    page = await context.newPage(); page.setDefaultTimeout(20000)
    page.on('pageerror', error => pageErrors.push(error.stack))
    page.on('worker', worker => { const record = { url: worker.url(), closed: false }; workers.push(record); worker.on('close', () => { record.closed = true }) })
    report.resources.browser = { headless: true, pages: 1, version: browser.version() }
    await page.goto(report.resources.server)
    report.load = await page.evaluate(startProbe, { indexSha256, indexSize: site.indexBytes.length })
    assert.equal(report.load.capabilities.quickjs, true)
    const first = await page.evaluate(() => window.nativeLifetimeProbe.present()); assert.equal(first.final.inputEnabled, true)
    const frame = page.frameLocator('iframe')
    await frame.locator('#single-line').focus(); await page.evaluate(() => window.nativeLifetimeProbe.drain())
    await page.evaluate(() => window.nativeLifetimeProbe.present())
    await frame.locator('#single-line').fill('Worker native edit')
    await page.evaluate(() => window.nativeLifetimeProbe.drain())
    const edited = await page.evaluate(() => window.nativeLifetimeProbe.present())
    assert.equal(edited.final.inputEnabled, true)
    assert.equal(await frame.locator('#single-line').inputValue(), 'Worker native edit')
    assert.match(await frame.locator('#event-count').innerText(), /^Input events: 1\s*·/)
    assert.match(await frame.locator('#focus-count').innerText(), /^Focus events: 1\s*·/)
    report.cases.push({ id: 'actual-Worker-QuickJS-input-setdata-and-DOM-presentation', status: 'passed', proof: edited.proof })
    await page.evaluate(() => window.nativeLifetimeProbe.drain())
    const boundary = await page.evaluate(async () => {
      const state = window.nativeLifetimeProbe, adapter = state.adapter, entry = adapter.presenter.currentEntry
      const before = adapter.observation, old = { version: '1.0', key: adapter.client.accepted.key,
        epoch: entry.geometryAdmitted.epoch, events: [{ type: 'input', targetOccurrenceId: entry.candidate.iframe.contentDocument.querySelector('#single-line').getAttribute('data-wc-id'),
          detail: { value: 'STALE MUST NOT APPLY', cursor: 0, selectionStart: 0, selectionEnd: 0 } }] }
      state.holding = true
      const hidden = await state.bridge('app.lifecycle', { event: 'hide' })
      const shown = await state.bridge('app.lifecycle', { event: 'show' })
      let stale
      try { await state.bridge('view.events', old); throw new Error('Old surface input unexpectedly succeeded') }
      catch (error) {
        if (error.code !== 'ERR_CANCELLED') throw error
        // This is the genuine outer Worker surface-admission failure before
        // host.dispatch, not a fabricated inner Rust bridge response.
        stale = { layer: 'Worker-surface-admission-before-native-dispatch', code: error.code, message: error.message, details: error.details }
      }
      // Deliver the genuine last final without rewriting its state or sequence.
      // Earlier receipts remain in trace; this isolates final-only ingress.
      adapter.receiveObservation(shown.batch.observation)
      state.holding = false
      const after = adapter.observation
      return { before, hidden, shown, stale, after, inputEnabled: adapter.client.accepted.inputEnabled,
        withheld: state.withheld, iframeInert: adapter.presenter.current.iframe.inert }
    })
    assert.equal(boundary.hidden.payload.ok, true); assert.equal(boundary.shown.payload.ok, true)
    assert.equal(boundary.stale.code, 'ERR_CANCELLED')
    assert.equal(boundary.before.state.lifecycle, boundary.after.state.lifecycle)
    assert.deepEqual(boundary.before.state.currentPage, boundary.after.state.currentPage)
    assert.deepEqual(boundary.before.state.viewport, boundary.after.state.viewport)
    assert.ok(BigInt(boundary.after.state.inputLifetimeRevision) > BigInt(boundary.before.state.inputLifetimeRevision))
    assert.ok(BigInt(boundary.after.state.surfaceGeneration) > BigInt(boundary.before.state.surfaceGeneration))
    assert.equal(boundary.inputEnabled, false); assert.equal(boundary.iframeInert, true)
    report.cases.push({ id: 'native-hide-show-final-only-ingress-retires-old-key', status: 'passed', boundary })
    const resumed = await page.evaluate(() => window.nativeLifetimeProbe.present()); assert.equal(resumed.final.inputEnabled, true)
    assert.match(await frame.locator('#event-count').innerText(), /^Input events: 1\s*·/)
    assert.equal(await frame.locator('#single-line').inputValue(), 'Worker native edit')
    await frame.locator('#single-line').focus(); await page.evaluate(() => window.nativeLifetimeProbe.drain())
    await page.evaluate(() => window.nativeLifetimeProbe.present())
    await frame.locator('#single-line').fill('Fresh lifetime edit'); await page.evaluate(() => window.nativeLifetimeProbe.drain())
    const fresh = await page.evaluate(() => window.nativeLifetimeProbe.present())
    assert.equal(fresh.final.inputEnabled, true); assert.match(await frame.locator('#event-count').innerText(), /^Input events: 2\s*·/)
    assert.equal(await frame.locator('#single-line').inputValue(), 'Fresh lifetime edit')
    report.cases.push({ id: 'new-authoritative-presentation-restores-native-input', status: 'passed', proof: fresh.proof })
    await page.screenshot({ path: resolve(out, 'surface.png') })
    const audit = await page.evaluate(() => window.__workerProductWasmAudit)
    assert.equal(audit.installed, true); assert.deepEqual(audit.violations, []); assert.deepEqual(audit.calls, [])
    report.mainThreadWasmAudit = audit
    assert.deepEqual(await page.evaluate(() => window.nativeLifetimeProbe.diagnostics), [])
    assert.deepEqual(pageErrors, []); report.status = 'passed'
  } catch (error) { failure = error; report.status = 'failed'; report.error = error.stack }
  finally {
    const cleanupErrors = []
    if (page && !page.isClosed()) try {
      report.cleanup.native = await page.evaluate(async () => window.nativeLifetimeProbe?.cleanup?.())
      await save(out, 'native-trace.json', await page.evaluate(() => ({ trace: window.nativeLifetimeProbe?.trace, diagnostics: window.nativeLifetimeProbe?.diagnostics })))
      const native = report.cleanup.native
      assert.deepEqual(native.errors, []); assert.equal(native.frames, 0); assert.equal(native.terminated, 1)
      assert.equal(native.rpcState, 'closed'); assert.equal(native.pendingCount, 0); assert.equal(native.inFlightBytes, 0)
    } catch (error) { cleanupErrors.push(`native: ${error.stack}`) }
    if (context) try { await context.close(); report.cleanup.contextClosed = true } catch (error) { cleanupErrors.push(`context: ${error.stack}`) }
    if (browser) try { await browser.close(); report.cleanup.browserClosed = true } catch (error) { cleanupErrors.push(`browser: ${error.stack}`) }
    if (server) try {
      const closing = new Promise((yes, no) => server.close(error => error ? no(error) : yes()))
      for (const socket of sockets) socket.destroy()
      await closing; report.cleanup.serverClosed = true
    } catch (error) { cleanupErrors.push(`server: ${error.stack}`) }
    if (report.status === 'passed' && (workers.length !== 1 || workers.some(worker => !worker.closed))) cleanupErrors.push('owned Worker close was not observed')
    report.workers = workers; report.pageErrors = pageErrors; report.cleanup.errors = cleanupErrors
    if (cleanupErrors.length) { report.status = 'failed'; failure ??= new Error(cleanupErrors.join('; ')) }
    report.finishedAt = new Date().toISOString(); await save(out, 'report.json', report)
  }
  if (failure) throw failure
  return report
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const names = { '--site-dir': 'siteDir', '--index-sha256': 'indexSha256', '--expected-source-commit': 'expectedSourceCommit', '--out-dir': 'outDir' }, options = {}
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]]
    assert.ok(name && args[i + 1] && options[name] === undefined, `Invalid/duplicate argument: ${args[i]}`)
    options[name] = args[i + 1]
  }
  for (const name of Object.values(names)) assert.ok(options[name], `Missing ${name}`)
  await runInputLifetimeBrowserSmoke(options)
  console.log('Native Worker DOM input lifetime smoke passed; owned Worker/browser/server closed.')
}
