#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connectDevEvents, installSmokeSignals, startDevSimulator } from './simulator-dev-harness.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const errorValue = error => ({ name: error.name, message: error.message, stack: error.stack })
const pause = ms => new Promise(done => setTimeout(done, ms))
const sameKey = (a, b) => a && b && ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile'].every(key => a[key] === b[key])

export function parseOptions(args) {
  const options = { binary: join(root, 'target/release/weapp-simulator'), engine: 'quickjs', scenario: 'reference', timeoutMs: 120000 }
  const fields = { '--binary': 'binary', '--engine': 'engine', '--scenario': 'scenario', '--out': 'out', '--wv-bin': 'wvBin', '--timeout': 'timeoutMs' }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true }
    const field = fields[args[i]], value = args[++i]
    if (!field || !value || value.startsWith('--')) throw new Error('Expected --binary, --engine, --scenario, --out, --wv-bin or --timeout with a value')
    options[field] = value
  }
  if (!options.out) throw new Error('--out must identify a new evidence directory')
  if (!['quickjs', 'v8'].includes(options.engine) || !['reference', 'modern'].includes(options.scenario)) throw new Error('Invalid engine or scenario')
  options.timeoutMs = Number(options.timeoutMs)
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('Invalid timeout')
  for (const field of ['binary', 'out', 'wvBin']) if (options[field]) options[field] = resolve(options[field])
  return options
}

/** The copied source tree, ephemeral server and two headless tabs belong only
 * to this run. The second tab exists solely to test primary-preview transfer. */
export async function runDomDevSmoke(options, { chromium, signal, startSimulator = startDevSimulator } = {}) {
  await mkdir(dirname(options.out), { recursive: true })
  await mkdir(options.out)
  const modern = options.scenario === 'modern'
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: 'failed',
    scope: 'development supervisor with remote DOM presentation', engine: options.engine, scenario: options.scenario,
    headless: true, environment: { platform: process.platform, arch: process.arch, node: process.version },
    checks: {}, requests: [], pageErrors: [], console: [], cleanup: {}, resources: { createdByThisRun: true, maxPages: 2 },
    limitations: ['No native host, physical GPU, hardware or performance acceptance.', 'These fixtures do not establish WeChat parity.'] }
  let owned, simulator, browser, context, page, mirror, stream, cancellationClose
  const save = (name, value) => writeFile(join(options.out, name), `${JSON.stringify(value, null, 2)}\n`)
  const checkCancelled = () => signal?.throwIfAborted()
  const onAbort = () => { if (context) { cancellationClose ||= context.close(); cancellationClose.catch(() => {}) } }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    checkCancelled()
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    report.commit = git(['rev-parse', 'HEAD']); report.dirtySource = git(['status', '--porcelain']).length > 0
    report.submodule = { sha: git(['-C', 'vendor/weapp-vite', 'rev-parse', 'HEAD']), dirty: git(['-C', 'vendor/weapp-vite', 'status', '--porcelain']).length > 0 }
    const binary = await readFile(options.binary)
    report.binary = { path: options.binary, sha256: digest(binary), size: binary.length }
    report.scriptSha256 = digest(await readFile(fileURLToPath(import.meta.url)))
    owned = await mkdtemp(join(tmpdir(), 'weapp-dom-dev-'))
    const projectName = modern ? 'modern-view-app' : 'reference-app', project = join(owned, projectName)
    report.resources.project = project
    await cp(join(root, 'examples/apps', projectName), project, { recursive: true, filter: path => !['node_modules', 'dist', '.weapp-vite', '.weapp-container'].includes(basename(path)) })
    const home = join(project, 'pages/home/index'), wxml = `${home}.wxml`, wxss = `${home}.wxss`, script = `${home}.js`, appJson = join(project, 'app.json')
    await mkdir(join(project, 'assets'), { recursive: true })
    await cp(join(root, 'examples/apps/image-contract-app/assets/grid.png'), join(project, 'assets/grid.png'))
    await writeFile(wxml, `${await readFile(wxml, 'utf8')}\n<image id="dom-resource" src="/assets/grid.png" style="width:16px;height:16px"/>\n<text id="dom-hot">DOM before update</text>\n`)
    const original = { wxml: await readFile(wxml, 'utf8'), wxss: await readFile(wxss, 'utf8'), script: await readFile(script, 'utf8'), appJson: await readFile(appJson, 'utf8') }
    await cp(project, join(options.out, 'fixture'), { recursive: true })
    simulator = await startSimulator({ root, project, port: 0, engine: options.engine, renderer: 'webview', wvBin: options.wvBin,
      timeoutMs: options.timeoutMs, signal, launcher: { mode: 'simulator', command: options.binary } })
    report.resources.simulator = { pid: simulator.child.pid, url: simulator.url, staging: simulator.staging }
    await save('owned-resources.json', report.resources)
    stream = await connectDevEvents(simulator.url, options.timeoutMs, { signal })
    let sequence = 0
    const api = async (name, args = {}) => {
      const state = await simulator.json('/api/state'), requestId = `dom-smoke-${++sequence}`
      const response = stream.nextEvent('bridge', batch => batch.messages?.some(value => value.requestId === requestId && value.kind === 'response'))
      response.catch(() => {})
      await simulator.json('/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: '1.0', sessionId: state.sessionId, requestId, kind: 'request', op: 'api.call', payload: { name, ...args } }) })
      const result = (await response).messages.find(value => value.requestId === requestId && value.kind === 'response').payload
      assert.equal(result.ok, true, JSON.stringify(result)); return result.result
    }
    const waitFor = async (read, label) => {
      const deadline = Date.now() + options.timeoutMs
      do { checkCancelled(); const result = await read(); if (result) return result; await pause(30) } while (Date.now() < deadline)
      throw new Error(`Timed out waiting for ${label}`)
    }
    if (!chromium) ({ chromium } = await import(pathToFileURL(resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || join(root, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))).href))
    checkCancelled()
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    report.environment.browser = browser.version()
    checkCancelled(); context = await browser.newContext({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2 })
    const attach = async label => {
      const target = await context.newPage()
      target.on('request', request => {
        if (new URL(request.url()).origin !== new URL(simulator.url).origin || report.requests.length >= 8192) return
        const path = new URL(request.url()).pathname
        report.requests.push({ page: label, method: request.method(), path,
          ...(['/api/bridge', '/api/preview', '/api/presentation'].includes(path) && request.method() === 'POST' ? { body: request.postDataJSON() } : {}) })
      })
      target.on('pageerror', error => report.pageErrors.push({ page: label, ...errorValue(error) }))
      target.on('console', message => { report.console.push({ page: label, type: message.type(), text: message.text() }); if (report.console.length > 150) report.console.shift() })
      return target
    }
    page = await attach('primary')
    const observed = target => target.evaluate(() => ({ receipt: globalThis.__weappDomReceipt, clientId: globalThis.__weappDomSurface?.clientId,
      owner: globalThis.__weappDomSurface?.isOwner, accepted: globalThis.__weappDomSurface?.client.accepted,
      authority: globalThis.__weappDomSurface?.authority, status: document.querySelector('#status')?.textContent,
      overlay: document.querySelector('#overlay')?.textContent, overlayVisible: document.querySelector('#overlay')?.style.display !== 'none' }))
    const waitPresented = (target = page, owner = true) => waitFor(async () => {
      const state = await simulator.json('/api/state'), ui = await observed(target)
      return state.webRenderer === 'webview' && ui.owner === owner && ui.receipt?.phase === 'presented'
        && sameKey(ui.receipt.key, state.viewPresented?.key)
        && (owner ? state.viewInputEnabled === true && ui.accepted?.inputEnabled === true
          && sameKey(ui.accepted.key, state.viewPresented.key) && ui.authority?.previewEpoch === state.preview.epoch : ui.receipt.inputEnabled === false)
        ? { state, ui } : null
    }, owner ? 'runtime-confirmed owner DOM frame' : 'read-only DOM mirror')
    const dom = target => target.frameLocator('#domScreen iframe:visible')
    await page.goto(simulator.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
    const initial = await waitPresented()
    await page.evaluate(() => {
      globalThis.__domSmokeBridge = []
      events.addEventListener('bridge', event => {
        globalThis.__domSmokeBridge.push(JSON.parse(event.data))
        if (globalThis.__domSmokeBridge.length > 256) globalThis.__domSmokeBridge.shift()
      })
    })
    assert.equal(initial.state.engine, options.engine)
    report.checks.initial = initial
    await page.screenshot({ path: join(options.out, 'initial.png'), fullPage: true })
    const image = await dom(page).locator('#dom-resource').evaluate(element => ({ complete: element.complete, width: element.naturalWidth, src: element.src }))
    assert.equal(image.complete, true); assert.ok(image.width > 0); assert.ok(image.src.startsWith('blob:'))
    assert.ok(report.requests.some(value => value.path.startsWith('/api/view-resources/')))
    report.checks.encodedResource = image
    const expected = modern ? 'Update: 2' : '点击次数：1', countSelector = modern ? '#increment' : '#count'
    await dom(page).locator('#increment').click()
    await waitFor(async () => (await dom(page).locator(countSelector).textContent()) === expected, 'click setData')
    const clicked = await waitPresented()
    report.checks.click = clicked.ui.receipt
    const densityBefore = clicked.state
    assert.equal(await page.locator('#renderScale').isDisabled(), true, 'DOM physical density is owned by the browser')
    const changePresentation = async patch => {
      const current = await simulator.json('/api/state')
      const body = await page.evaluate(value => globalThis.__weappDomSurface.fence(value), { requestId: `dom-smoke-presentation-${++sequence}`, revision: current.presentation.revision, ...patch })
      return simulator.json('/api/presentation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    }
    await changePresentation({ renderScale: 1.5 })
    await waitFor(async () => (await simulator.json('/api/state')).presentation?.effectiveScale === 1.5, 'density preference')
    const densityAfter = (await waitPresented()).state
    assert.deepEqual(densityAfter.viewPresented, densityBefore.viewPresented)
    assert.deepEqual(densityAfter.viewRequest, densityBefore.viewRequest)
    report.checks.densityDoesNotEvaluateView = { before: densityBefore.viewAuthority, after: densityAfter.viewAuthority }
    await changePresentation({ logicalWidth: 414, logicalHeight: 736 })
    await waitFor(async () => { const state = await simulator.json('/api/state'); return state.presentation?.logicalWidth === 414 && state.viewPresented?.viewport.width === 414 }, 'logical resize')
    const resized = await waitPresented()
    assert.equal(resized.state.sessionId, initial.state.sessionId)
    assert.equal(resized.state.viewPresented.viewport.height, 736)
    const windowInfo = await api('wx.getWindowInfo')
    assert.equal(windowInfo.windowWidth, 414); assert.equal(windowInfo.windowHeight, 736)
    report.checks.resize = { authority: resized.state.viewAuthority, windowInfo }
    await writeFile(wxss, `${original.wxss}\n#increment{background:#9c2468}\n`)
    await waitFor(async () => (await simulator.json('/api/state')).revision > resized.state.revision, 'WXSS watcher reload')
    const styled = await waitPresented()
    assert.equal(styled.state.sessionId, initial.state.sessionId)
    assert.equal(await dom(page).locator(countSelector).textContent(), expected)
    assert.equal(await dom(page).locator('#increment').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(156, 36, 104)')
    report.checks.wxssInPlace = { revision: styled.state.revision, sessionId: styled.state.sessionId }
    await writeFile(wxml, original.wxml.replace('DOM before update', 'DOM hot update'))
    await waitFor(async () => (await simulator.json('/api/state')).revision > styled.state.revision, 'WXML watcher reload')
    const templated = await waitPresented()
    // A document containing stateful modern/WXS code is an execution input:
    // its safe reload restarts the realm. Plain display-text changes preserve
    // the managed component heap and page data in the reference application.
    if (modern) assert.notEqual(templated.state.sessionId, styled.state.sessionId, 'stateful View document edits restart the session')
    else assert.equal(templated.state.sessionId, styled.state.sessionId, 'display-only WXML edits preserve the live session')
    assert.equal(await dom(page).locator(countSelector).textContent(), modern ? 'Update: 1' : expected)
    assert.equal(await dom(page).locator('#dom-hot').textContent(), 'DOM hot update')
    report.checks.wxmlReload = { kind: modern ? 'restart' : 'in-place', revision: templated.state.revision, previous: styled.state.sessionId, sessionId: templated.state.sessionId }
    const beforeBroken = (await waitPresented()).state
    await writeFile(appJson, '{ invalid DOM development test JSON')
    await waitFor(async () => (await simulator.json('/api/state')).diagnostics?.some(value => value.code === 'BUILD_FAILED'), 'build failure')
    const broken = await simulator.json('/api/state')
    assert.equal(broken.sessionId, beforeBroken.sessionId); assert.equal(broken.revision, beforeBroken.revision)
    assert.deepEqual(broken.viewPresented, beforeBroken.viewPresented)
    await waitPresented()
    await dom(page).locator('#increment').click()
    await waitFor(async () => (await dom(page).locator(countSelector).textContent()) === (modern ? 'Update: 2' : '点击次数：2'), 'input while build failed')
    report.checks.buildFailureRetainsLiveView = true
    await writeFile(appJson, original.appJson)
    await waitFor(async () => !(await simulator.json('/api/state')).diagnostics?.length, 'build error recovery')
    const recovered = await waitPresented()
    await writeFile(script, `${original.script}\nglobalThis.__domDevRestart = 1;\n`)
    await waitFor(async () => (await simulator.json('/api/state')).sessionId !== recovered.state.sessionId, 'script restart')
    const restarted = await waitPresented()
    assert.equal(await dom(page).locator(countSelector).textContent(), modern ? 'Update: 1' : '点击次数：0')
    report.checks.jsRestart = { previous: recovered.state.sessionId, next: restarted.state.sessionId }
    mirror = await attach('mirror')
    await mirror.goto(simulator.url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
    const mirrored = await waitPresented(mirror, false)
    assert.equal(mirrored.state.sessionId, restarted.state.sessionId)
    report.checks.mirror = mirrored.ui.receipt
    const oldFence = { clientId: restarted.ui.clientId, epoch: mirrored.state.preview.epoch, requestRevision: restarted.state.viewRequest.revision }
    await mirror.locator('#claimPreview').click()
    const transferred = await waitPresented(mirror, true)
    await waitPresented(page, false)
    assert.equal(transferred.state.sessionId, restarted.state.sessionId)
    assert.notEqual(transferred.state.preview.epoch, oldFence.epoch)
    const stale = await fetch(new URL('/api/bridge', simulator.url), { method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ protocolVersion: '1.0', sessionId: restarted.state.sessionId, requestId: 'dom-stale-owner', kind: 'request', op: 'view.prepare', preview: oldFence,
        payload: { version: '1.0', surfaceGeneration: restarted.state.viewAuthority.surfaceGeneration, render: restarted.state.viewRequest.render } }) })
    assert.equal(stale.status, 409)
    report.checks.transfer = { epoch: transferred.state.preview.epoch, staleOwnerStatus: stale.status, response: await stale.json() }
    await dom(mirror).locator('#increment').click()
    await waitPresented(mirror, true); await waitPresented(page, false)
    await waitFor(async () => (await dom(page).locator(countSelector).textContent()) === (modern ? 'Update: 2' : '点击次数：1'), 'mirror follows primary event')
    await mirror.close(); mirror = null
    await waitFor(async () => (await simulator.json('/api/state')).preview.ownerClientId === null, 'owner release on tab close')
    await page.locator('#claimPreview').click(); await waitPresented()
    const beforeReconnect = (await simulator.json('/api/state')).preview.epoch
    await page.reload({ waitUntil: 'domcontentloaded', timeout: options.timeoutMs })
    const reconnected = await waitPresented()
    assert.notEqual(reconnected.state.preview.epoch, beforeReconnect)
    assert.equal(reconnected.state.sessionId, restarted.state.sessionId)
    report.checks.reconnect = reconnected.ui.receipt
    const readback = await fetch(new URL('/api/snapshot', simulator.url), { signal })
    assert.equal(readback.status, 409); report.checks.noCpuSnapshot = await readback.json()
    assert.equal(report.requests.some(value => ['/api/frame', '/api/snapshot', '/api/render-frame'].includes(value.path)), false)
    report.checks.noPagePixelTransport = true
    assert.deepEqual(report.pageErrors, [])
    await page.screenshot({ path: join(options.out, 'final.png'), fullPage: true })
    await save('final-state.json', await simulator.json('/api/state'))
    assert.equal(report.console.some(value => /cleanup failed/i.test(value.text)), false, 'browser cleanup failures cannot pass silently')
    report.status = 'passed'
  } catch (error) {
    report.error = errorValue(error); report.outputTail = simulator?.outputTail()
    if (simulator) try { await save('failure-state.json', await simulator.json('/api/state')) } catch (failure) { report.failureStateError = errorValue(failure) }
    if (page && !page.isClosed()) try { report.failureUi = await page.evaluate(() => ({ receipt: globalThis.__weappDomReceipt,
      accepted: globalThis.__weappDomSurface?.client.accepted, authority: globalThis.__weappDomSurface?.authority,
      bridge: globalThis.__domSmokeBridge, meta: document.querySelector('#meta')?.textContent, overlay: document.querySelector('#overlay')?.textContent })); await page.screenshot({ path: join(options.out, 'failure.png'), fullPage: true }) } catch (failure) { report.failureUiError = errorValue(failure) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    const failures = []
    const cleanup = async (name, operation) => { try { report.cleanup[name] = await operation() ?? true } catch (error) { failures.push({ resource: name, ...errorValue(error) }) } }
    if (cancellationClose) await cleanup('cancellationContext', () => cancellationClose)
    for (const [name, target] of [['mirror', mirror], ['page', page]]) if (target) await cleanup(name, async () => {
      if (!target.isClosed()) {
        await target.evaluate(async () => { if (typeof closeEventStream === 'function') closeEventStream(); await globalThis.__weappCleanupPromise })
        await target.close()
      }
      assert.ok(target.isClosed())
    })
    if (context) await cleanup('context', () => context.close())
    if (browser) await cleanup('browser', async () => { await browser.close(); assert.equal(browser.isConnected(), false) })
    if (stream) await cleanup('sse', () => stream.close())
    if (simulator) await cleanup('simulator', () => simulator.stop())
    if (owned) await cleanup('project', () => rm(owned, { recursive: true, force: true }))
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
    if (options.help) console.log('node scripts/simulator-dom-browser-smoke.mjs --binary <simulator> --out <new directory> [--engine quickjs|v8] [--scenario reference|modern]')
    else { const result = await runDomDevSmoke(options, { signal: signals.signal }); console.log(JSON.stringify({ status: result.status, report: join(options.out, 'report.json'), checks: Object.keys(result.checks), error: result.error }, null, 2)); if (result.status !== 'passed') process.exitCode ||= 1 }
  } catch (error) { console.error(error.stack || error); process.exitCode ||= 1 }
  finally { signals.dispose() }
}
