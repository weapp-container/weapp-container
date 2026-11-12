import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runTextControlRuntimeCases } from './dom-text-controls-runtime-cases.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const keyOf = key => JSON.stringify([key.sessionId, key.pageId, key.documentRevision, key.presentationRevision, key.surfaceGeneration, key.profile])
function parseResourceKey(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let key
  try { key = JSON.parse(raw) } catch { return null }
  if (!key || typeof key !== 'object' || Array.isArray(key)
    || Object.keys(key).sort().join(',') !== 'documentRevision,pageId,presentationRevision,profile,sessionId,surfaceGeneration'
    || typeof key.sessionId !== 'string' || !key.sessionId || key.sessionId.length > 512 || key.profile !== 'webview') return null
  for (const field of ['pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration']) {
    if (typeof key[field] !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key[field]) || key[field].length > 20 || BigInt(key[field]) > 18446744073709551615n) return null
  }
  return key
}
const deadline = async (promise, ms, label) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })]) }
  finally { clearTimeout(timer) }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

// The child alone owns HostSession. This adapter transports complete envelopes
// and batches; neither it nor the HTTP/browser layer evaluates WXML or JS.
export function startDriver(binary, pack, engine, trace, report) {
  const child = spawn(binary, ['--pack', pack, '--engine', engine], { cwd: repository, stdio: ['pipe', 'pipe', 'pipe'] })
  const bootstrap = deferred(), closed = deferred(), pending = new Map(), authorities = new Map()
  let bootstrapped = false, stopping = false, stderr = '', acceptedKey = null, acceptedRevision = -1n
  report.resources.driver = { binary, pid: child.pid, createdByTask: true }
  const rejectAll = error => { if (!bootstrapped) bootstrap.reject(error); for (const item of pending.values()) item.reject(error); pending.clear() }
  child.on('error', rejectAll)
  child.stdin.on('error', error => { if (!stopping) rejectAll(error) })
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-1024 * 1024) })
  child.once('close', (code, signal) => { closed.resolve({ code, signal }); if (!stopping) rejectAll(new Error(`dom-protocol exited (${code ?? signal}): ${stderr}`)) })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', line => {
    try {
      if (line.length > 32 * 1024 * 1024) throw new Error('driver JSONL line exceeds verification budget')
      const value = JSON.parse(line)
      if (!bootstrapped) {
        assert.equal(value.kind, 'bootstrap'); assert.equal(value.version, '1.0')
        bootstrapped = true; trace.push({ direction: 'bootstrap', value }); bootstrap.resolve(value); return
      }
      assert.ok(Array.isArray(value.messages), 'driver must return complete BridgeBatch')
      trace.push({ direction: 'runtime', value })
      for (const message of value.messages) {
        if (message.op === 'host.resources.authorized') {
          const { key, resources } = message.payload
          assert.equal(key.sessionId, message.sessionId)
          authorities.set(keyOf(key), { key, resources })
        }
        if (message.kind !== 'response') continue
        const item = pending.get(message.requestId)
        if (!item) continue
        assert.equal(message.sessionId, item.envelope.sessionId); assert.equal(message.op, item.envelope.op)
        const results = []
        for (let result = message.payload; result && typeof result === 'object'; result = result.originalResult) results.push(result)
        const successful = results.find(result => result.ok === true)
        const committed = results.find(result => result.committed === true)
        if (successful && ['view.prepare', 'view.live.prepare'].includes(message.op)) {
          // The runtime replaces its pending candidate. Retain only the old
          // accepted surface until the new authorization event in this batch.
          for (const key of authorities.keys()) if (key !== acceptedKey) authorities.delete(key)
        }
        if ((successful || committed) && ['view.presented', 'view.live.presented'].includes(message.op)) {
          // Publication survives failures in ready/effect completion or final
          // retention. Never restore an older resource authority after commit.
          const key = committed?.key ?? successful?.key ?? results.find(result => result.key)?.key
          assert.ok(key, 'committed presentation must identify its runtime key')
          // A historical final proves its original outcome; it cannot make an
          // older presentation the current resource owner again.
          const revision = BigInt(key.presentationRevision)
          if (revision >= acceptedRevision) {
            const next = keyOf(key)
            assert.ok(revision !== acceptedRevision || acceptedKey === next, 'same accepted revision cannot identify another presentation')
            acceptedRevision = revision; acceptedKey = next
            for (const key of authorities.keys()) if (key !== acceptedKey) authorities.delete(key)
          }
        }
        if (successful && ['view.abort', 'view.live.abort'].includes(message.op)) {
          const aborted = keyOf(message.op === 'view.live.abort' ? item.envelope.payload.key : item.envelope.payload)
          if (aborted !== acceptedKey) authorities.delete(aborted)
        }
      }
      // Authorization events follow the response in the same batch; publish
      // the batch only after processing all events, before image fetching.
      for (const message of value.messages) {
        if (message.kind !== 'response') continue
        const item = pending.get(message.requestId)
        if (!item) continue
        pending.delete(message.requestId); item.resolve(value)
      }
    } catch (error) { rejectAll(error) }
  })
  return {
    bootstrap: deadline(bootstrap.promise, 20000, 'runtime bootstrap'), authorities,
    async request(envelope) {
      if (stopping || child.exitCode !== null || child.signalCode !== null) throw new Error('runtime driver is closed')
      assert.equal(typeof envelope.requestId, 'string'); assert.ok(!pending.has(envelope.requestId))
      const response = deferred(); pending.set(envelope.requestId, { ...response, envelope })
      trace.push({ direction: 'host', value: envelope })
      child.stdin.write(JSON.stringify(envelope) + '\n', error => { if (error) response.reject(error) })
      try { return await deadline(response.promise, 15000, `runtime ${envelope.op}`) }
      finally { pending.delete(envelope.requestId) }
    },
    async stop() {
      stopping = true; rejectAll(new Error('runtime driver stopping')); child.stdin.end()
      let result
      try { result = await deadline(closed.promise, 3000, 'runtime shutdown') }
      catch {
        report.cleanup.driverSignal = 'SIGTERM'; child.kill('SIGTERM')
        try { result = await deadline(closed.promise, 2000, 'runtime SIGTERM') }
        catch { report.cleanup.driverSignal = 'SIGKILL'; child.kill('SIGKILL'); result = await deadline(closed.promise, 2000, 'runtime SIGKILL') }
      }
      lines.close(); report.cleanup.driver = result; report.driverStderr = stderr
      if (result.code !== 0) throw new Error(`runtime driver did not exit cleanly (${result.code ?? result.signal})`)
    },
  }
}

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Portable pack DOM runtime verification</title>
<style>body{margin:20px;font:14px system-ui;background:#edf1f6}#surface{width:375px;height:667px;background:white}pre{white-space:pre-wrap}</style></head>
<body><p>Portable pack → native Rust runtime → browser DOM</p><div id="surface"></div><pre id="status">starting</pre>
<script type="module">
import {DomViewPresenter} from '/dom-presenter.mjs';
import {DomSessionClient,SseBridgeTransport} from '/dom-session-client.mjs';
window.states=[];window.diagnostics=[];window.batches=[];window.presentations=[];window.leases={created:0,released:0};
const diagnostic=value=>window.diagnostics.push({code:value?.code,message:value?.message??String(value)});
const bootstrap=await(await fetch('/api/bootstrap')).json();window.bootstrap=bootstrap;window.observation=bootstrap.observation;
const transport=new SseBridgeTransport({sessionId:bootstrap.sessionId,onDiagnostic:diagnostic,send:async(envelope,{signal})=>{
  const response=await fetch('/api/bridge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope),signal});
  if(!response.ok)throw new Error(await response.text());
  const batch=await response.json();window.batches.push({request:envelope,batch});
  for(const message of batch.messages)if(message.op==='host.dom.observation')window.observation=message.payload.state;
  return batch;
}});
const presenter=new DomViewPresenter(document.querySelector('#surface'),{onError:diagnostic});
window.presenter=presenter;
window.client=new DomSessionClient({presenter,transport,onDiagnostic:diagnostic,onState:state=>{
  window.states.push(state);document.querySelector('#status').textContent=JSON.stringify(state);
},resolveResource:async(resource,context)=>{
  const query=new URLSearchParams({key:JSON.stringify(context.presentationKey)});
  const response=await fetch('/resources/'+resource.sha256+'?'+query,{signal:context.signal});
  if(!response.ok)throw new Error('resource request rejected: '+response.status);
  const bytes=await response.arrayBuffer();
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(digest!==resource.sha256||bytes.byteLength!==resource.size)throw new Error('browser resource integrity mismatch');
  const url=URL.createObjectURL(new Blob([bytes],{type:resource.mime}));window.leases.created++;
  return {url,release(){URL.revokeObjectURL(url);window.leases.released++}};
}});
window.client.updateAuthority({sessionId:bootstrap.sessionId,revision:'1',surfaceGeneration:'0'});
window.present=async()=>{
  for(let attempt=0;attempt<4;attempt++){
    const before=window.observation.templateRevision;
    const result=await window.client.present(bootstrap.renderPayload);window.presentations.push(result);
    if(result.inputEnabled&&window.observation.templateRevision===before)return result;
  }
  throw new Error('ready lifecycle did not settle within four presentations');
};
window.harnessReady=true;
</script></body></html>`

/** Actual pack/HostSession/browser proof, deliberately separate from the
 * simulator CLI and from WASM/GPU/official-DevTools acceptance. */
export async function runDomRuntimeBrowserSmoke({ packDir, driverBinary, engine = 'quickjs', fixture = 'reference', outDir }) {
  assert.ok(['quickjs', 'v8'].includes(engine), 'engine must be quickjs or v8')
  assert.ok(['reference', 'text-controls'].includes(fixture), 'fixture must be reference or text-controls')
  const pack = resolve(packDir), binary = resolve(driverBinary), out = resolve(outDir)
  await mkdir(dirname(out), { recursive: true }); await mkdir(out, { recursive: false })
  const report = {
    schemaVersion: 1, status: 'running', headless: true, scope: 'portable-pack-native-runtime-browser-dom',
    startedAt: new Date().toISOString(), engine, fixture, pack, binary, cases: [], resources: {}, cleanup: {},
    limitations: ['Real native Rust engine and headless Chromium; not a WASM engine or native mobile WebView.', 'No official WeChat oracle, GPU, device, accessibility or performance acceptance.'],
  }
  const trace = [], serverErrors = [], sockets = new Set()
  let driver, server, browser, context, page, failure
  try {
    const [presenterSource, clientSource, binaryBytes, manifestBytes] = await Promise.all([
      readFile(resolve(repository, 'examples/hosts/web-wasm/dom-presenter.mjs')),
      readFile(resolve(repository, 'examples/hosts/web-wasm/dom-session-client.mjs')),
      readFile(binary), readFile(resolve(pack, 'manifest.json')),
    ])
    report.sources = { presenterSha256: sha(presenterSource), clientSha256: sha(clientSource), binarySha256: sha(binaryBytes), manifestSha256: sha(manifestBytes) }
    if (fixture === 'text-controls') report.sources.textControlCasesSha256 = sha(await readFile(resolve(repository, 'scripts/dom-text-controls-runtime-cases.mjs')))
    driver = startDriver(binary, pack, engine, trace, report)
    const bootstrap = await driver.bootstrap
    assert.equal(bootstrap.engine, engine, 'driver must use the requested engine')
    const initialized = bootstrap.startup.flatMap(batch => batch.messages).find(message => message.kind === 'response' && message.op === 'app.init')
    assert.equal(initialized?.payload.ok, true)
    assert.equal(initialized.payload.engine, engine)
    assert.equal(initialized.payload.engineProviderAvailable, true, 'engine evidence requires the actual native provider')
    assert.equal(bootstrap.manifestSha256, report.sources.manifestSha256)
    assert.equal(bootstrap.observation.browserPresented, false)
    assert.equal(bootstrap.observation.skiaFramePresent, false)
    assert.equal(bootstrap.observation.skiaSnapshotRevision, '0')
    const initialCount = bootstrap.observation.page.data.count
    if (fixture === 'reference') assert.equal(typeof initialCount, 'number', 'fixture must expose numeric page count')
    const hasLifecycleTrace = Array.isArray(bootstrap.observation.page.data.lifecycleTrace)
    if (hasLifecycleTrace) assert.ok(!bootstrap.observation.page.data.lifecycleTrace.includes('page:ready'))
    report.bootstrap = bootstrap
    const files = new Map([['/', [Buffer.from(html), 'text/html; charset=utf-8']], ['/dom-presenter.mjs', [presenterSource, 'text/javascript']], ['/dom-session-client.mjs', [clientSource, 'text/javascript']], ['/api/bootstrap', [Buffer.from(JSON.stringify(bootstrap)), 'application/json']]])
    server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1')
        if (request.method === 'POST' && url.pathname === '/api/bridge') {
          const chunks = []; let length = 0
          for await (const bytes of request) { length += bytes.length; if (length > 4 * 1024 * 1024) throw new Error('bridge request exceeds 4 MiB'); chunks.push(bytes) }
          const envelope = JSON.parse(Buffer.concat(chunks).toString())
          assert.equal(envelope.sessionId, bootstrap.sessionId)
          assert.ok(['view.prepare', 'view.prepare.commit', 'view.presented', 'view.abort', 'view.geometry', 'view.events'].includes(envelope.op))
          const batch = await driver.request(envelope)
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(batch)); return
        }
        if (request.method === 'GET' && /^\/resources\/[a-f0-9]{64}$/.test(url.pathname)) {
          const hash = url.pathname.slice('/resources/'.length)
          const key = parseResourceKey(url.searchParams.get('key'))
          const authority = key && driver.authorities.get(keyOf(key))
          if (!authority || !authority.resources.some(item => item.sha256 === hash)) { response.writeHead(403).end('Resource is not authorized by this runtime submission'); return }
          const resource = authority.resources.find(item => item.sha256 === hash)
          const bytes = await readFile(resolve(pack, 'blobs/sha256', hash))
          assert.equal(sha(bytes), hash); assert.equal(bytes.length, resource.size)
          response.writeHead(200, { 'Content-Type': resource.mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(bytes); return
        }
        const entry = request.method === 'GET' && files.get(url.pathname)
        if (!entry) { response.writeHead(404).end(); return }
        response.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' }).end(entry[0])
      } catch (error) {
        serverErrors.push(error.stack ?? String(error))
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' })
        response.end(String(error))
      }
    })
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    report.url = `http://127.0.0.1:${server.address().port}/`
    report.resources.server = { url: report.url, createdByTask: true }
    const { chromium } = await import(pathToFileURL(resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || resolve(repository, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))).href)
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    report.browser = browser.version()
    context = await browser.newContext({ viewport: { width: 900, height: 800 }, deviceScaleFactor: 2 })
    page = await context.newPage(); page.setDefaultTimeout(15000)
    report.resources.browser = { headless: true, pages: 1, createdByTask: true }
    const browserErrors = []; page.on('pageerror', error => browserErrors.push(error.stack ?? String(error)))
    await page.goto(report.url); await page.waitForFunction(() => window.harnessReady)
    const first = await page.evaluate(() => window.present())
    assert.equal(first.inputEnabled, true)
    let state = await page.evaluate(() => ({ observation: window.observation, batches: window.batches, states: window.states, diagnostics: window.diagnostics }))
    assert.equal(state.observation.browserPresented, true)
    assert.equal(state.observation.skiaFramePresent, false)
    assert.equal(state.observation.skiaSnapshotRevision, '0')
    const firstAck = state.batches.findIndex(entry => entry.request.op === 'view.presented')
    assert.ok(firstAck >= 2)
    if (hasLifecycleTrace) {
      for (const entry of state.batches.slice(0, firstAck)) {
        const observed = entry.batch.messages.find(message => message.op === 'host.dom.observation')?.payload.state
        if (observed) assert.ok(!observed.page.data.lifecycleTrace.includes('page:ready'), 'ready must wait for final browser ACK')
      }
      const observed = state.batches[firstAck].batch.messages.find(message => message.op === 'host.dom.observation').payload.state
      assert.equal(observed.page.data.lifecycleTrace.filter(value => value === 'page:ready').length, 1)
    }
    report.cases.push({ id: 'real-pack-prepare-permit-present-transaction', status: 'passed', firstAckIndex: firstAck, presentation: first })
    report.cases.push({ id: 'page-ready-after-final-ack', status: hasLifecycleTrace ? 'passed' : 'unknown', reason: hasLifecycleTrace ? 'Fixture lifecycleTrace observed before and after the final ACK.' : 'This pack does not instrument the page ready lifecycle.' })
    const frame = page.frameLocator('iframe')
    assert.equal(await page.locator('iframe').count(), 1)
    assert.equal(await page.locator('iframe').evaluate(element => element.inert), false)
    const beforeText = await frame.locator('body').innerText()
    await page.screenshot({ path: resolve(out, 'before.png') })
    if (fixture === 'text-controls') {
      await runTextControlRuntimeCases({ page, report, out, first })
      state = await page.evaluate(() => ({ observation: window.observation, batches: window.batches, states: window.states, diagnostics: window.diagnostics, presentations: window.presentations }))
    } else {
      await frame.locator('#increment').click()
      await page.waitForFunction(count => window.observation.page.data.count === count + 1 && window.states.some(state => state.phase === 'updated' && state.op === 'view.events'), initialCount)
      const second = await page.evaluate(() => window.present())
      assert.equal(second.inputEnabled, true)
      assert.ok(BigInt(second.key.documentRevision) > BigInt(first.key.documentRevision))
      const afterText = await frame.locator('body').innerText()
      assert.notEqual(afterText, beforeText)
      state = await page.evaluate(() => ({ observation: window.observation, batches: window.batches, states: window.states, diagnostics: window.diagnostics, presentations: window.presentations }))
      assert.equal(state.observation.page.data.count, initialCount + 1)
      assert.equal(state.observation.skiaFramePresent, false); assert.equal(state.observation.skiaSnapshotRevision, '0')
      const event = state.batches.find(entry => entry.request.op === 'view.events' && entry.request.payload.events.some(item => item.type === 'tap'))
      assert.ok(event, 'real DOM tap must reach runtime')
      assert.ok(event.request.payload.events.every(item => !('listeners' in item) && !('handler' in item)), 'runtime must own handler resolution')
      if (hasLifecycleTrace) assert.equal(state.observation.page.data.lifecycleTrace.filter(value => value === 'page:ready').length, 1)
      report.cases.push({ id: 'trusted-dom-click-appservice-setdata-second-document', status: 'passed', beforeText, afterText, count: state.observation.page.data.count, presentation: second })
    }
    const unauthorized = await page.evaluate(async () => (await fetch('/resources/' + '0'.repeat(64) + '?' + new URLSearchParams({key:JSON.stringify(window.presentations.at(-1).key)}))).status)
    assert.equal(unauthorized, 403)
    report.cases.push({ id: 'undeclared-blob-http-denied', status: 'passed' })
    report.layout = await frame.locator('[data-wc-id]').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { occurrenceId: element.getAttribute('data-wc-id'), id: element.id, tag: element.tagName, x: rect.x, y: rect.y, width: rect.width, height: rect.height } }))
    assert.ok(report.layout.length > 0)
    assert.ok(report.layout.some(node => node.id === (fixture === 'text-controls' ? 'single-line' : 'increment') && node.width > 0 && node.height > 0))
    await page.screenshot({ path: resolve(out, 'after.png') })
    await writeFile(resolve(out, 'browser-state.json'), JSON.stringify(state, null, 2) + '\n')
    assert.deepEqual(browserErrors, []); assert.deepEqual(serverErrors, []); assert.deepEqual(state.diagnostics, [])
    report.status = 'passed'
  } catch (error) { failure = error; report.status = 'failed'; report.error = error.stack ?? String(error) }
  finally {
    const cleanupErrors = []
    if (page && !page.isClosed()) try {
      report.cleanup.presenter = await deadline(page.evaluate(async () => { await window.client?.dispose(); return { frames: document.querySelectorAll('iframe').length, leases: window.leases } }), 10000, 'presenter dispose')
      assert.equal(report.cleanup.presenter.frames, 0)
      if (report.cleanup.presenter.leases) assert.equal(report.cleanup.presenter.leases.created, report.cleanup.presenter.leases.released)
    } catch (error) { cleanupErrors.push(`presenter: ${error}`) }
    if (context) try { await deadline(context.close(), 5000, 'context close'); report.cleanup.contextClosed = true } catch (error) { cleanupErrors.push(`context: ${error}`) }
    if (browser) try { await deadline(browser.close(), 5000, 'browser close'); report.cleanup.browserClosed = true } catch (error) { cleanupErrors.push(`browser: ${error}`) }
    if (server) try {
      const closing = new Promise((yes, no) => server.close(error => error ? no(error) : yes()))
      for (const socket of sockets) socket.destroy()
      await deadline(closing, 5000, 'server close'); report.cleanup.serverClosed = true
    } catch (error) { cleanupErrors.push(`server: ${error}`) }
    if (driver) try { await driver.stop() } catch (error) { cleanupErrors.push(`driver: ${error}`) }
    report.cleanup.errors = cleanupErrors; report.serverErrors = serverErrors
    if (cleanupErrors.length) { report.status = 'failed'; failure ??= new Error(cleanupErrors.join('; ')) }
    report.finishedAt = new Date().toISOString()
    await writeFile(resolve(out, 'trace.json'), JSON.stringify(trace, null, 2) + '\n')
    await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  }
  if (failure) throw failure
  return report
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const args = process.argv.slice(2), options = {}
  for (let index = 0; index < args.length; index += 2) {
    const field = { '--pack': 'packDir', '--driver': 'driverBinary', '--engine': 'engine', '--fixture': 'fixture', '--out': 'outDir' }[args[index]]
    if (!field || !args[index + 1]) throw new Error('Usage: node scripts/dom-runtime-browser-smoke.mjs --pack <portable-pack> --driver <dom-protocol-binary> [--engine quickjs|v8] [--fixture reference|text-controls] --out <new-directory>')
    options[field] = args[index + 1]
  }
  if (!options.packDir || !options.driverBinary || !options.outDir) throw new Error('--pack, --driver and --out are required')
  await runDomRuntimeBrowserSmoke(options)
  console.log('Portable-pack DOM runtime browser smoke passed; task-owned browser, server and runtime driver closed.')
}
