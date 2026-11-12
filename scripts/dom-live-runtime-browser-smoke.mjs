import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startDriver } from './dom-runtime-browser-smoke.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const html = `<!doctype html><meta charset="utf-8"><title>Live DOM native runtime verification</title>
<style>body{margin:0}iframe{width:375px;height:667px;border:0}</style><iframe sandbox="allow-same-origin" srcdoc="<!doctype html><html><head></head><body><div id='mount'></div></body></html>"></iframe>
<script type="module">
import {DomLiveSessionClient,waitForDomLiveReady} from '/dom-live-session-client.mjs';
import {planDomEvent} from '/dom-presenter.mjs';
const frame=document.querySelector('iframe');
if(!frame.contentDocument?.querySelector('#mount'))await new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));
const doc=frame.contentDocument,mount=doc.querySelector('#mount');
window.original={frame,doc,mount};window.wires=[];window.batches=[];window.events=[];window.errors=[];window.deliveries=[];window.eventTurn=Promise.resolve();
const bootstrap=await(await fetch('/api/bootstrap')).json();window.bootstrap=bootstrap;window.observation=bootstrap.observation;
function observe(batch){for(const message of batch.messages){if(message.op==='host.dom.observation')window.observation=message.payload.state;if(message.op==='view.live.prepare'&&message.payload.ok)window.submission=message.payload.submission;}}
async function exchange(envelope){
 window.wires.push(envelope);const response=await fetch('/api/bridge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope)});
 if(!response.ok)throw Error(await response.text());const batch=await response.json();window.batches.push({request:envelope,batch});observe(batch);
 if(window.dropNextAck&&envelope.op==='view.live.presented'){window.dropNextAck=false;window.lostAck={envelope,batch};throw Error('verification transport lost the committed ACK');}
 if(window.dropNextConsume&&envelope.op==='view.live.consume'){window.dropNextConsume=false;window.lostConsume={envelope,batch};throw Error('verification transport lost the consumed metadata final');}
 if(window.holdNextOriginal&&envelope.op==='view.live.presented'){
  window.holdNextOriginal=false;let release;const pending=new Promise(resolve=>{release=resolve});
  window.heldOriginal={envelope,batch,release,settled:false};await pending;window.heldOriginal.settled=true;
 }
 // dom-protocol appends one passive verification observation to the actual
 // runtime batch. Preserve it above in raw evidence, but metadata consumers
 // receive only the runtime's single correlated final, never this diagnostic.
 return envelope.op==='view.live.consume'?{...batch,messages:batch.messages.filter(message=>message.op!=='host.dom.observation')}:batch;
}
window.client=new DomLiveSessionClient({document:doc,mount,sessionId:bootstrap.sessionId,liveVersion:bootstrap.liveVersion,dispatchEnvelope:exchange,
onBatch:batch=>{for(const message of batch.messages)if(message.kind==='response')window.deliveries.push({requestId:message.requestId,op:message.op});observe(batch);},
waitForReady:async options=>{await waitForDomLiveReady(options);if(window.failReadiness){window.failReadiness=false;throw Error('verification readiness failure');}},
resolveResource:async(resource,context)=>{const query=new URLSearchParams({key:JSON.stringify(context.presentationKey)});const response=await fetch('/resources/'+resource.sha256+'?'+query);if(!response.ok)throw Error('resource denied');const bytes=await response.arrayBuffer();const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(digest!==resource.sha256||bytes.byteLength!==resource.size)throw Error('invalid resource bytes');const url=URL.createObjectURL(new Blob([bytes],{type:resource.mime}));return{url,release(){URL.revokeObjectURL(url)}};}});
window.present=()=>window.client.prepareAndPresent({render:bootstrap.renderPayload,surfaceGeneration:'1'});
let sequence=0;
// Verification adapter: actual native facts only. The live protocol has no
// editing lease, so all native/business input is frozen during a transaction.
function native(event){
 if(!window.client.inputEnabled)return;
 const id=window.client.surface.occurrenceForNode(event.target);if(!id)return;
 const type=event.type==='click'?'tap':event.type;
 const detail=type==='input'||type==='focus'||type==='blur'?{value:event.target.value??'',cursor:event.target.selectionEnd??0,selectionStart:event.target.selectionStart??0,selectionEnd:event.target.selectionEnd??0}:{};
 const plan=planDomEvent(window.submission.document,id,type,detail);if(plan.disabled||!plan.listeners.length)return;
 if(plan.caught){event.stopPropagation();if(event.cancelable)event.preventDefault();}
 const accepted=window.client.accepted;
 const envelope={protocolVersion:'1.0',sessionId:bootstrap.sessionId,requestId:'native:'+ ++sequence,kind:'request',op:'view.events',payload:{version:'1.0',key:accepted.key,epoch:accepted.epoch,events:[{type,targetOccurrenceId:id,detail,timeStamp:event.timeStamp}]}};
 window.events.push({trusted:event.isTrusted,envelope});
 window.eventTurn=window.eventTurn.then(()=>exchange(envelope)).then(batch=>{const response=batch.messages.find(m=>m.kind==='response'&&m.requestId===envelope.requestId);if(response?.payload.ok!==true)throw Error(JSON.stringify(response));}).catch(error=>{window.errors.push(error.message);throw error;});window.eventTurn.catch(()=>{});
}
for(const name of ['focus','blur','input','click'])doc.addEventListener(name,native,true);
window.disposeHarness=async()=>{await window.eventTurn;for(const name of ['focus','blur','input','click'])doc.removeEventListener(name,native,true);const result=await window.client.disposeAsync();return{result,borrowedFrameRetained:frame.isConnected,borrowedDocumentRetained:frame.contentDocument===doc,borrowedMountRetained:mount.isConnected,rootRemoved:!window.client.surface.root.isConnected,inertRestored:mount.inert===false,errors:window.client.cleanupErrors.map(e=>e.message)}};
await window.client.negotiate();window.harnessReady=true;
</script>`

/** Real portable pack, native QuickJS/V8 and actual Chromium geometry. This is
 * an explicit v2 verification entry, not the production simulator/watch path. */
export async function runDomLiveRuntimeBrowserSmoke({ packDir, driverBinary, outDir, engines = ['quickjs', 'v8'], liveVersion = '2.0' }) {
  assert.ok(engines.length && engines.every(engine => ['quickjs', 'v8'].includes(engine)))
  assert.ok(['2.0', '2.1'].includes(liveVersion), 'liveVersion must be 2.0 or 2.1')
  const out = resolve(outDir), pack = resolve(packDir), binary = resolve(driverBinary)
  await mkdir(dirname(out), { recursive: true }); await mkdir(out)
  const report = { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), headless: true,
    scope: 'native-runtime-live-dom-v2', liveVersion, pack, binary, resources: {}, cleanup: {}, runs: [],
    limitations: ['nativeEditing:false; input freezes during prepare/apply/ACK. This does not prove IME or focus continuity.',
      'Explicit verification protocol with bounded retention; no production watch/Worker v2 activation.',
      'The driver appends passive host.dom.observation diagnostics; only this known diagnostic is removed from consume replies before client admission.',
      'No official WeChat, hardware GPU, other-host or performance acceptance.'] }
  const traces = [], sockets = new Set()
  let driver, bootstrap, server, browser, context, page, failure
  try {
    const names = ['dom-presenter.mjs', 'dom-live-patch.mjs', 'dom-live-session-client.mjs']
    const sources = await Promise.all(names.map(name => readFile(resolve(repository, 'examples/hosts/web-wasm', name))))
    report.sourceSha256 = Object.fromEntries(names.map((name, i) => [name, sha(sources[i])]))
    report.sourceSha256.driver = sha(await readFile(binary)); report.sourceSha256.manifest = sha(await readFile(resolve(pack, 'manifest.json')))
    report.sourceSha256.harness = sha(await readFile(fileURLToPath(import.meta.url)))
    report.sourceSha256.transport = sha(await readFile(resolve(repository, 'scripts/dom-runtime-browser-smoke.mjs')))
    const files = new Map(names.map((name, i) => ['/' + name, sources[i]]))
    server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1')
        if (request.method === 'GET' && url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }).end(html); return }
        if (request.method === 'GET' && files.has(url.pathname)) { response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(files.get(url.pathname)); return }
        if (request.method === 'GET' && url.pathname === '/api/bootstrap') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(bootstrap)); return }
        if (request.method === 'POST' && url.pathname === '/api/bridge') {
          const chunks = []; let bytes = 0
          for await (const chunk of request) { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) throw Error('bridge request exceeds budget'); chunks.push(chunk) }
          const envelope = JSON.parse(Buffer.concat(chunks).toString())
          assert.equal(envelope.sessionId, bootstrap.sessionId)
          assert.ok(['view.live.enable', 'view.live.prepare', 'view.live.permit', 'view.live.presented', 'view.live.abort', 'view.live.consume', 'view.events'].includes(envelope.op))
          const batch = await driver.request(envelope)
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(batch)); return
        }
        if (request.method === 'GET' && /^\/resources\/[a-f0-9]{64}$/.test(url.pathname)) {
          const hash = url.pathname.slice('/resources/'.length), requested = url.searchParams.get('key')
          const authority = [...driver.authorities.values()].find(value => JSON.stringify(value.key) === requested)
          const resource = authority?.resources.find(value => value.sha256 === hash)
          if (!resource) { response.writeHead(403).end('not authorized'); return }
          const bytes = await readFile(resolve(pack, 'blobs/sha256', hash)); assert.equal(sha(bytes), hash); assert.equal(bytes.length, resource.size)
          response.writeHead(200, { 'Content-Type': resource.mime }).end(bytes); return
        }
        response.writeHead(404).end()
      } catch (error) { response.writeHead(400).end(error.message) }
    })
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
    const url = `http://127.0.0.1:${server.address().port}/`
    report.resources.server = { url, createdByTask: true }
    const { chromium } = await import(pathToFileURL(resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || resolve(repository, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))).href)
    browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 900, height: 800 } }); page = await context.newPage()
    report.resources.browser = { headless: true, createdByTask: true, contexts: 1, pages: 1 }
    page.on('pageerror', error => report.pageErrors = [...(report.pageErrors ?? []), error.message])
    for (const engine of engines) {
      const run = { engine, resources: {}, cleanup: {}, cases: [] }; report.runs.push(run)
      const trace = []; traces.push({ engine, trace })
      driver = startDriver(binary, pack, engine, trace, run); bootstrap = { ...await driver.bootstrap, liveVersion }
      assert.equal(bootstrap.engine, engine); assert.equal(bootstrap.manifestSha256, report.sourceSha256.manifest)
      const initialized = bootstrap.startup.flatMap(batch => batch.messages).find(message => message.op === 'app.init' && message.kind === 'response')
      assert.equal(initialized.payload.engineProviderAvailable, true); assert.equal(bootstrap.observation.skiaFramePresent, false)
      await page.goto(url + '?engine=' + engine); await page.waitForFunction(() => window.harnessReady === true)
      assert.equal(await page.evaluate(() => window.client.contract.nativeEditing), false)
      assert.equal(await page.evaluate(() => window.client.contract.version), liveVersion)
      let consumedThrough = 0n
      const retentionSample = () => page.evaluate(() => ({ client: window.client.retention,
        runtime: window.observation.liveTransactionRetention, sessionId: window.client.accepted?.key.sessionId,
        pageId: String(window.observation.page.id), keyPageId: String(window.client.accepted?.key.pageId),
        singleValue: window.observation.page.data.singleValue, eventCount: window.observation.page.data.eventCount,
        sameDocument: window.original.doc === document.querySelector('iframe').contentDocument,
        sameRoot: !window.original.root || window.original.root === window.client.surface.root,
        sameEditor: !window.original.editor || window.original.editor === window.original.doc.querySelector('#single-line') }))
      const recordRetired = async label => {
        const sample = await retentionSample()
        assert.equal(sample.client.requests, 0, label + ': client retains no consumed business records')
        assert.equal(sample.client.inFlightExchanges, 0, label + ': actual transport settled')
        assert.equal(sample.runtime.retainedRequests, 0, label + ': runtime final entries reclaimed')
        assert.equal(sample.client.consumedThrough, sample.runtime.consumedThrough, label)
        assert.equal(sample.runtime.consumedThrough, sample.runtime.highestAdmitted, label)
        assert.ok(BigInt(sample.runtime.consumedThrough) >= consumedThrough, label + ': watermark cannot rewind')
        consumedThrough = BigInt(sample.runtime.consumedThrough)
        assert.equal(sample.sessionId, bootstrap.sessionId, label)
        assert.equal(sample.pageId, sample.keyPageId, label)
        for (const name of ['sameDocument', 'sameRoot', 'sameEditor']) assert.equal(sample[name], true, label + ': ' + name)
        const limits = await page.evaluate(() => ({ requests: window.client.contract.maxRetainedRequests, bytes: window.client.contract.maxRetainedBytes }))
        assert.ok(sample.client.bytes <= limits.bytes, label + ': client protocol byte budget')
        assert.ok(sample.runtime.retainedBytes <= limits.bytes, label + ': runtime protocol byte budget')
        run.retentionSamples ??= []; run.retentionSamples.push({ label, ...sample })
        return sample
      }
      const consumeTerminal = async label => {
        if (liveVersion !== '2.1') return null
        const before = await retentionSample()
        const limits = await page.evaluate(() => ({ requests: window.client.contract.maxRetainedRequests, bytes: window.client.contract.maxRetainedBytes }))
        assert.ok(before.client.requests <= limits.requests, label + ': bounded before consumption')
        assert.ok(before.client.bytes <= limits.bytes, label + ': bounded bytes before consumption')
        const owners = [...driver.authorities.values()].map(value => value.key)
        const final = await page.evaluate(() => window.client.consumeCompleted())
        assert.deepEqual(final, { ok: true, consumedThrough: before.runtime.highestAdmitted }, label)
        assert.deepEqual([...driver.authorities.values()].map(value => value.key), owners, label + ': metadata cannot change resource owner')
        const after = await recordRetired(label)
        run.maxClientRetainedRequests = Math.max(run.maxClientRetainedRequests ?? 0, before.client.requests)
        run.maxClientRetainedBytes = Math.max(run.maxClientRetainedBytes ?? 0, before.client.bytes)
        return after
      }
      const first = await page.evaluate(() => window.present()); assert.equal(first.inputEnabled, true)
      await consumeTerminal('initial-presentation')
      run.cases.push({ id: 'initial-live-geometry-ack', status: 'passed', final: first })
      const frame = page.frameLocator('iframe')
      await page.evaluate(() => { window.original.editor = window.original.doc.querySelector('#single-line'); window.original.root = window.client.surface.root })
      await frame.locator('#single-line').focus(); await page.evaluate(() => window.eventTurn)
      assert.equal(await page.evaluate(() => window.observation.page.data.focusCount), 1, 'real focus callback must retain its setData')
      const second = await page.evaluate(() => window.present()); assert.equal(second.inputEnabled, true)
      await consumeTerminal('focus-setdata-presentation')
      assert.equal(await page.evaluate(() => window.original.frame === document.querySelector('iframe') && window.original.doc === document.querySelector('iframe').contentDocument && window.original.root === window.client.surface.root && window.original.editor === window.original.doc.querySelector('#single-line')), true)
      run.cases.push({ id: 'focus-setdata-preserves-document-root-and-node', status: 'passed', final: second })
      const text = 'live 微信'
      await frame.locator('#single-line').fill(text); await page.evaluate(() => window.eventTurn)
      assert.equal(await page.evaluate(() => window.observation.page.data.singleValue), text)
      assert.equal(await page.evaluate(() => window.observation.page.data.eventCount), 1)
      await page.evaluate(() => { window.dropNextAck = true })
      const uncertain = await page.evaluate(async () => { try { await window.present(); return null } catch (error) { return { code: error.code, state: window.client.state, inert: window.original.mount.inert, enabled: window.client.inputEnabled, key: window.client.pendingRequest } } })
      assert.equal(uncertain.code, 'ERR_UNCERTAIN'); assert.equal(uncertain.state, 'uncertain'); assert.equal(uncertain.inert, true); assert.equal(uncertain.enabled, false)
      const recovered = await page.evaluate(() => window.client.recoverOriginalFinal()); assert.equal(recovered.inputEnabled, true)
      const replays = await page.evaluate(() => window.wires.filter(wire => wire.requestId === window.lostAck.envelope.requestId))
      assert.equal(replays.length, 2); assert.deepEqual(replays[0], replays[1])
      assert.equal(await page.evaluate(() => window.original.editor === window.original.doc.querySelector('#single-line')), true)
      assert.equal(await frame.locator('#single-line').inputValue(), text)
      await consumeTerminal('lost-original-final-recovered')
      run.cases.push({ id: 'actual-input-setdata-and-lost-final-exact-recovery', status: 'passed', final: recovered, replays })
      const beforeStale = await page.evaluate(() => window.observation.page.data)
      const stale = await page.evaluate(async first => {
        const envelope = { protocolVersion: '1.0', sessionId: bootstrap.sessionId, requestId: 'stale-key-probe', kind: 'request', op: 'view.events', payload: { version: '1.0', key: first.key, epoch: first.epoch, events: [{ type: 'input', targetOccurrenceId: window.client.surface.occurrenceForNode(window.original.editor), detail: { value: 'forged', cursor: 6, selectionStart: 6, selectionEnd: 6 } }] } }
        const response = await fetch('/api/bridge', { method: 'POST', body: JSON.stringify(envelope) }); return response.json()
      }, first)
      assert.equal(stale.messages[0].payload.ok, false); assert.equal(stale.messages[0].payload.error.code, 'ERR_CANCELLED')
      assert.deepEqual(stale.messages.find(message => message.op === 'host.dom.observation').payload.state.page.data, beforeStale)
      run.cases.push({ id: 'old-presentation-key-cannot-dispatch-input', status: 'passed' })
      const historical = await page.evaluate(async () => {
        const first = window.wires.find(wire => wire.op === 'view.live.presented')
        const response = await fetch('/api/bridge', { method: 'POST', body: JSON.stringify(first) }); return response.json()
      })
      if (liveVersion === '2.1') {
        assert.equal(historical.messages[0].payload.ok, false, 'consumed historical final must remain permanently non-executable')
        assert.ok(['ERR_CANCELLED', 'ERR_RENDER'].includes(historical.messages[0].payload.error.code))
        run.historicalFinal = { status: 'retired', code: historical.messages[0].payload.error.code }
      } else assert.equal(historical.messages[0].payload.committed, true, 'same-epoch historical final remains an outcome, not fresh authority')
      assert.deepEqual([...driver.authorities.values()].map(value => value.key), [recovered.key], 'historical ACK must not retire the current resource owner')
      run.cases.push({ id: 'historical-final-cannot-rewind-resource-ownership', status: 'passed' })
      const beforeFailure = await page.evaluate(() => ({ html: window.client.surface.root.outerHTML, key: window.client.accepted.key }))
      const rollback = await page.evaluate(async () => { window.failReadiness = true; try { await window.present(); return null } catch (error) { return { message: error.message, state: window.client.state, inert: window.original.mount.inert, html: window.client.surface.root.outerHTML, key: window.client.accepted.key } } })
      assert.match(rollback.message, /readiness failure/); assert.equal(rollback.inert, true); assert.equal(rollback.html, beforeFailure.html); assert.deepEqual(rollback.key, beforeFailure.key)
      assert.equal(await page.evaluate(() => window.original.editor === window.original.doc.querySelector('#single-line') && window.original.root === window.client.surface.root), true)
      await consumeTerminal('readiness-failure-aborted')
      const restored = await page.evaluate(() => window.present()); assert.equal(restored.inputEnabled, true)
      await consumeTerminal('readiness-recovery-presentation')
      run.cases.push({ id: 'failed-readiness-aborts-and-rolls-back-before-recovery', status: 'passed', final: restored })
      if (liveVersion === '2.1') {
        await page.evaluate(() => window.present())
        const beforeLostConsume = await retentionSample()
        const deliveredBeforeConsume = await page.evaluate(() => window.deliveries.length)
        const lostConsume = await page.evaluate(async () => {
          window.dropNextConsume = true
          try { await window.client.consumeCompleted(); return null }
          catch (error) { return { code: error.code, state: window.client.state, pending: window.client.pendingConsumption, retention: window.client.retention } }
        })
        assert.equal(lostConsume.code, 'ERR_UNCERTAIN')
        assert.equal(lostConsume.state, 'consumption-uncertain')
        assert.equal(lostConsume.retention.requests, beforeLostConsume.client.requests, 'lost metadata final retains local original records')
        assert.ok(lostConsume.retention.bytes >= beforeLostConsume.client.bytes, 'uncertain consumption remains charged')
        assert.equal((await retentionSample()).runtime.retainedRequests, 0, 'server already consumed while its metadata final was lost')
        const blockedByConsume = await page.evaluate(async () => {
          const before = window.wires.length
          try { await window.present(); return null }
          catch (error) { return { code: error.code, dispatched: window.wires.length - before } }
        })
        assert.deepEqual(blockedByConsume, { code: 'ERR_UNCERTAIN', dispatched: 0 })
        const recoveredConsumption = await page.evaluate(() => window.client.recoverConsumption())
        assert.deepEqual(recoveredConsumption, { ok: true, consumedThrough: beforeLostConsume.runtime.highestAdmitted })
        const consumeReplays = await page.evaluate(() => window.wires.filter(wire => wire.requestId === window.lostConsume.envelope.requestId))
        assert.equal(consumeReplays.length, 2); assert.deepEqual(consumeReplays[0], consumeReplays[1])
        assert.deepEqual(consumeReplays[0], lostConsume.pending)
        assert.equal(await page.evaluate(() => window.deliveries.length), deliveredBeforeConsume, 'metadata finals never enter business onBatch')
        const consumptionRetired = await recordRetired('lost-consume-final-recovered')
        run.cases.push({ id: 'lost-consume-final-exact-metadata-recovery', status: 'passed', final: recoveredConsumption,
          replays: consumeReplays, retainedWhileUncertain: lostConsume.retention, after: consumptionRetired })

        await frame.locator('#single-line').fill('late original 微信'); await page.evaluate(() => window.eventTurn)
        const beforeLate = await page.evaluate(() => ({ eventCount: window.observation.page.data.eventCount, value: window.observation.page.data.singleValue }))
        const uncertainOriginal = await page.evaluate(async () => {
          window.holdNextOriginal = true
          try { await window.present(); return null }
          catch (error) { return { code: error.code, state: window.client.state, held: !!window.heldOriginal, retention: window.client.retention } }
        })
        assert.equal(uncertainOriginal.code, 'ERR_UNCERTAIN'); assert.equal(uncertainOriginal.state, 'uncertain')
        assert.equal(uncertainOriginal.held, true); assert.equal(uncertainOriginal.retention.inFlightExchanges, 1)
        const originalRecovered = await page.evaluate(() => window.client.recoverOriginalFinal())
        assert.equal(originalRecovered.inputEnabled, true)
        const withLateTransport = await retentionSample()
        assert.equal(withLateTransport.client.inFlightExchanges, 1, 'exact recovery cannot settle the actual original transport')
        assert.ok(withLateTransport.client.requests > 0); assert.ok(withLateTransport.client.bytes > 0)
        assert.ok(withLateTransport.runtime.retainedRequests > 0)
        const blockedReclamation = await page.evaluate(async () => {
          const before = window.wires.filter(wire => wire.op === 'view.live.consume').length
          try { await window.client.consumeCompleted(); return null }
          catch (error) { return { code: error.code, dispatched: window.wires.filter(wire => wire.op === 'view.live.consume').length - before,
            retention: window.client.retention } }
        })
        assert.equal(blockedReclamation.code, 'ERR_UNCERTAIN'); assert.equal(blockedReclamation.dispatched, 0)
        assert.deepEqual(blockedReclamation.retention, withLateTransport.client, 'unsettled original cannot be compacted')
        const deliveredBeforeLateSettlement = await page.evaluate(() => window.deliveries.length)
        await page.evaluate(() => window.heldOriginal.release())
        await page.waitForFunction(() => window.heldOriginal.settled && window.client.retention.inFlightExchanges === 0)
        assert.equal(await page.evaluate(() => window.deliveries.length), deliveredBeforeLateSettlement, 'late original does not re-deliver onBatch')
        assert.deepEqual(await page.evaluate(() => ({ eventCount: window.observation.page.data.eventCount, value: window.observation.page.data.singleValue })), beforeLate)
        const lateRetired = await consumeTerminal('actual-original-transport-settled')
        const retiredOriginal = await page.evaluate(async () => {
          const response = await fetch('/api/bridge', { method: 'POST', body: JSON.stringify(window.heldOriginal.envelope) })
          return response.json()
        })
        assert.equal(retiredOriginal.messages[0].payload.ok, false)
        assert.ok(['ERR_CANCELLED', 'ERR_RENDER'].includes(retiredOriginal.messages[0].payload.error.code))
        assert.deepEqual([...driver.authorities.values()].map(value => value.key), [originalRecovered.key], 'retired request cannot re-publish historical authority')
        const lateReplays = await page.evaluate(() => window.wires.filter(wire => wire.requestId === window.heldOriginal.envelope.requestId))
        assert.equal(lateReplays.length, 2); assert.deepEqual(lateReplays[0], lateReplays[1])
        run.cases.push({ id: 'late-original-transport-blocks-compaction-until-settled', status: 'passed', final: originalRecovered,
          beforeSettlement: withLateTransport, refusedConsumption: blockedReclamation, after: lateRetired, replays: lateReplays })

        const sameSession = await retentionSample()
        let eventCount = sameSession.eventCount, lastWatermark = BigInt(sameSession.runtime.consumedThrough)
        const loop = []
        for (let cycle = 0; cycle < 128; cycle++) {
          const value = `same-session-${cycle}`
          await frame.locator('#single-line').fill(value); await page.evaluate(() => window.eventTurn)
          eventCount++
          assert.equal(await frame.locator('#single-line').inputValue(), value)
          assert.deepEqual(await page.evaluate(() => ({ value: window.observation.page.data.singleValue, eventCount: window.observation.page.data.eventCount })), { value, eventCount }, `actual native input/callback cycle ${cycle}`)
          const final = await page.evaluate(() => window.present()); assert.equal(final.inputEnabled, true)
          const after = await consumeTerminal(`same-session-cycle-${cycle}`)
          assert.equal(after.sessionId, sameSession.sessionId); assert.equal(after.pageId, sameSession.pageId)
          assert.equal(after.singleValue, value); assert.equal(after.eventCount, eventCount)
          assert.equal(await frame.locator('#single-line').inputValue(), value)
          assert.ok(BigInt(after.runtime.consumedThrough) > lastWatermark, `cycle ${cycle} watermark must advance`)
          lastWatermark = BigInt(after.runtime.consumedThrough)
          loop.push({ cycle, value, eventCount, sessionId: after.sessionId, pageId: after.pageId,
            client: after.client, runtime: after.runtime })
        }
        run.cases.push({ id: '128-actual-input-present-consume-cycles-in-one-session', status: 'passed', cycles: loop })
      }
      const deliveries = await page.evaluate(() => window.deliveries)
      const deliveredIds = new Set()
      for (const delivery of deliveries) {
        assert.equal(delivery.op === 'view.live.consume', false, 'metadata is not a business callback')
        assert.equal(deliveredIds.has(delivery.requestId), false, 'original/recovery/late final delivered the business batch twice: ' + delivery.requestId)
        deliveredIds.add(delivery.requestId)
      }
      run.businessDeliveries = deliveries
      assert.deepEqual(await page.evaluate(() => window.errors), [])
      const facts = await page.evaluate(() => window.events); assert.ok(facts.length >= 2 && facts.every(fact => fact.trusted)); run.nativeFacts = facts
      await page.screenshot({ path: resolve(out, `${engine}.png`) })
      run.cleanup.client = await page.evaluate(() => window.disposeHarness())
      for (const name of ['borrowedFrameRetained', 'borrowedDocumentRetained', 'borrowedMountRetained', 'rootRemoved', 'inertRestored']) assert.equal(run.cleanup.client[name], true, name)
      assert.deepEqual(run.cleanup.client.errors, [])
      await driver.stop(); driver = null; run.status = 'passed'
    }
    assert.deepEqual(report.pageErrors ?? [], []); report.status = 'passed'
  } catch (error) { failure = error; report.status = 'failed'; report.error = { message: error.message, stack: error.stack } }
  finally {
    const clean = async (name, action) => { try { await action(); report.cleanup[name] = 'closed' } catch (error) { report.cleanup[name] = { error: error.message }; failure ??= error; report.status = 'failed' } }
    if (context) await clean('context', () => context.close())
    if (browser) await clean('browser', () => browser.close())
    if (driver) await clean('driver', () => driver.stop())
    if (server) await clean('server', () => new Promise((yes, no) => { server.close(error => error ? no(error) : yes()); for (const socket of sockets) socket.destroy() }))
    report.cleanup.remainingSockets = sockets.size; report.finishedAt = new Date().toISOString()
    await writeFile(resolve(out, 'trace.json'), JSON.stringify(traces, null, 2)); await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2))
  }
  if (failure) throw failure
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {}
  for (let i = 0; i < args.length; i += 2) {
    const name = { '--pack': 'packDir', '--driver': 'driverBinary', '--out': 'outDir', '--live-version': 'liveVersion' }[args[i]]
    if (!name || !args[i + 1]) throw Error('Usage: node scripts/dom-live-runtime-browser-smoke.mjs --pack <text-controls-pack> [--driver <binary>] --out <new-directory> [--live-version 2.0|2.1]')
    options[name] = args[i + 1]
  }
  if (!options.packDir || !options.outDir) throw Error('--pack and --out are required')
  options.driverBinary ??= resolve(repository, 'target/debug/examples/dom-protocol')
  const report = await runDomLiveRuntimeBrowserSmoke(options)
  console.log(JSON.stringify({ status: report.status, runs: report.runs.map(run => ({ engine: run.engine, cases: run.cases.length })), cleanup: report.cleanup }))
}
