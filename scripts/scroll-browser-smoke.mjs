#!/usr/bin/env node
/** Real browser input against a source-built development session. Auxiliary
 * software/host evidence only; never an official DevTools or GPU pass. */
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connectDevEvents, installSmokeSignals, startDevSimulator } from './simulator-dev-harness.mjs'
import { sha256, sourceHashes } from './simulator-cli-harness.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
if (args.includes('--help')) {
  console.log('Usage: node scripts/scroll-browser-smoke.mjs --wv-bin <verified compiler bin> --out <new directory> [--engine quickjs|v8] [--simulator-bin <verified binary>]')
  process.exit(0)
}
assert.ok(option('--out'), '--out must name a new evidence directory')
assert.ok(option('--wv-bin'), '--wv-bin must explicitly select the compiler')
const out = resolve(option('--out')), wvBin = resolve(option('--wv-bin')), engine = option('--engine', 'quickjs')
const simulatorBin = option('--simulator-bin') ? resolve(option('--simulator-bin')) : resolve(root, 'target/debug/weapp-simulator')
assert.ok(['quickjs', 'v8'].includes(engine))
await mkdir(out) // Refuse to replace historical evidence.
const project = resolve(out, 'project')
await cp(resolve(root, 'examples/apps/scroll-contract-app'), project, { recursive: true })
const sourceBefore = await sourceHashes(project)
const toolPaths = ['scripts/scroll-browser-smoke.mjs', 'scripts/simulator-dev-harness.mjs', 'scripts/simulator-cli-harness.mjs']
const toolHashes = () => Promise.all(toolPaths.map(async path => [path, sha256(await readFile(resolve(root, path)))]))
const signals = installSmokeSignals()
let simulator, stream, browser, context, page
const report = { schemaVersion: 1, status: 'failed', engine, host: 'native-dev-web', headed: false,
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  evidence: 'real headless Chromium input; native runtime; software snapshot; no official/GPU/device claim',
  compiler: { path: wvBin, binSha256: sha256(await readFile(wvBin)),
    limitation: 'full compiler provenance must be verified separately; a bin hash alone does not attest its dependencies' },
  sourceBefore, toolSourcesBefore: Object.fromEntries(await toolHashes()),
  bridge: [], browserInputs: [], browserErrors: [], snapshots: {}, cleanup: {} }
const save = async () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
let requestSequence = 0
try {
  simulator = await startDevSimulator({ root, project, engine, wvBin, viewport: '240x200',
    ...(option('--simulator-bin') ? { launcher: { mode: 'simulator', command: simulatorBin } } : {}),
    timeoutMs: 180_000, signal: signals.signal,
    onOutput: (text, stderr) => (stderr ? process.stderr : process.stdout).write(text) })
  const initial = await simulator.waitForState(value => value.revision > 0 && value.status === 'ready', 'source-built session')
  report.initialState = initial
  report.simulator = { pid: simulator.child.pid, url: simulator.url,
    binaryPath: simulatorBin, binarySha256: sha256(await readFile(simulatorBin)) }
  stream = await connectDevEvents(simulator.url, 120_000, { signal: signals.signal })
  async function bridge(op, payload) {
    const requestId = `scroll-browser-${++requestSequence}`
    const response = stream.nextEvent('bridge', batch => batch.messages?.some(message => message.requestId === requestId))
    const request = { protocolVersion: '1.0', sessionId: initial.sessionId, requestId, kind: 'request', op, payload }
    await simulator.json('/api/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
    const batch = await response
    assert.ok(!batch.messages.some(message => message.op === 'error'), JSON.stringify(batch))
    const matched = batch.messages.filter(message => message.requestId === requestId && message.kind === 'response' && message.op === op)
    assert.equal(matched.length, 1)
    assert.equal(matched[0].payload.ok, true, JSON.stringify(batch))
    report.bridge.push({ request, batch })
    return matched[0].payload
  }
  async function storage(key) { return (await bridge('api.call', { name: 'wx.getStorageSync', key })).result }
  const { chromium } = await import(pathToFileURL(resolve(root, 'vendor/weapp-vite/node_modules/playwright/index.mjs')).href)
  browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
  context = await browser.newContext({ hasTouch: true })
  page = await context.newPage()
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/bridge')) return
    const envelope = request.postDataJSON()
    if (envelope?.op === 'event.batch') report.browserInputs.push(envelope)
  })
  const browserErrors = report.browserErrors
  page.on('pageerror', error => browserErrors.push(error.message))
  const canvas = page.locator('#screen')
  async function point(x, y) {
    const bounds = await canvas.boundingBox()
    assert.ok(bounds)
    return { x: bounds.x + x * bounds.width / 240, y: bounds.y + y * bounds.height / 200 }
  }
  async function click(x, y) {
    const previous = report.browserInputs.length
    const p = await point(x, y)
    await page.mouse.click(p.x, p.y)
    const matchingInput = () => report.browserInputs.slice(previous).find(request => request.payload.events.some(event =>
      event.type === 'tap' && Math.abs(event.x - x) < 0.01 && Math.abs(event.y - y) < 0.01))
    for (let attempt = 0; !matchingInput() && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const input = matchingInput()
    assert.ok(input, 'canvas click must produce an actual browser bridge request')
    const batch = await stream.nextEvent('bridge', batch => batch.messages?.some(message => message.requestId === input.requestId))
    assert.ok(!batch.messages.some(message => message.op === 'error'), JSON.stringify(batch))
    assert.equal(batch.messages.find(message => message.kind === 'response' && message.requestId === input.requestId)?.payload.ok, true)
    report.bridge.push({ request: input, batch })
  }
  async function pixel(x, y, rgba) {
    await page.waitForFunction(({ x, y, rgba }) => {
      const c = document.querySelector('#screen')
      return c?.width === 240 && c.height === 200 && Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data).every((value, index) => value === rgba[index])
    }, { x, y, rgba }, { timeout: 15_000 })
  }
  async function inspect() {
    await click(42, 122)
    const value = await storage('scroll:query')
    assert.ok(value?.geometry, `Page inspection did not finish: ${JSON.stringify(value)}`)
    return value
  }
  async function snapshot(label) {
    const value = await simulator.json('/api/snapshot')
    await writeFile(resolve(out, `${label}.rgba.json`), JSON.stringify(value))
    await canvas.screenshot({ path: resolve(out, `${label}.png`) })
    report.snapshots[label] = { width: value.width, height: value.height, frameId: value.frameId,
      pixelsSha256: sha256(Buffer.from(value.pixels)) }
  }
  await page.goto(simulator.url, { waitUntil: 'domcontentloaded' })
  await pixel(90, 50, [229, 57, 53, 255])
  await snapshot('initial')
  const wheelPoint = await point(30, 30)
  await page.mouse.move(wheelPoint.x, wheelPoint.y)
  // Surface is scaled by CSS; deliver deltas in CSS pixels for 20x40 logical pixels.
  const bounds = await canvas.boundingBox()
  await page.mouse.wheel(20 * bounds.width / 240, 40 * bounds.height / 200)
  await pixel(90, 50, [0, 160, 96, 255])
  await snapshot('wheel-a')
  const first = await inspect()
  assert.equal(first.geometry[0].scrollLeft, 20)
  assert.equal(first.geometry[0].scrollTop, 40)
  assert.equal(first.geometry[1].scrollTop, 0)
  assert.equal(first.geometry[2].left, 60)
  assert.equal(first.geometry[2].top, 30)
  assert.ok(first.trace.some(event => event[0] === 'a:scroll' && event[1] === 20 && event[2] === 40), 'real A scroll callback')
  await click(75, 45)
  assert.equal((await storage('scroll:taps'))?.at(-1)?.owner, 'a')
  // Actual Chromium touch input traverses the same pointer adapter as devices.
  const cdp = await context.newCDPSession(page)
  const start = await point(30, 65), end = await point(30, 45)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x, y: start.y, id: 9 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: end.x, y: end.y, id: 9 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  await pixel(90, 20, [0, 160, 96, 255])
  await snapshot('touch-a')
  const touched = await inspect()
  assert.equal(touched.geometry[0].scrollTop, 60)
  assert.equal((await storage('scroll:taps')).length, 1, 'drag cannot synthesize a tap')
  // Reuse one page and one session while switching to the App embedding UI.
  await page.goto(new URL('/embed', simulator.url).href, { waitUntil: 'domcontentloaded' })
  await pixel(90, 20, [0, 160, 96, 255])
  const bPoint = await point(150, 30), bBounds = await canvas.boundingBox()
  await page.mouse.move(bPoint.x, bPoint.y)
  await page.mouse.wheel(40 * bBounds.width / 240, 20 * bBounds.height / 200)
  await pixel(190, 70, [255, 204, 0, 255])
  await snapshot('embed-wheel-b')
  const embedded = await inspect()
  assert.equal(embedded.geometry[0].scrollTop, 60)
  assert.equal(embedded.geometry[1].scrollLeft, 40)
  assert.equal(embedded.geometry[1].scrollTop, 20)
  assert.ok(embedded.trace.some(event => event[0] === 'b:scroll' && event[1] === 40 && event[2] === 20), 'real B scroll callback')
  await click(182, 122) // Real Page handler -> wx.pageScrollTo(duration:0).
  await pixel(30, 150, [128, 64, 192, 255])
  await snapshot('page-scroll')
  const scrolled = await storage('scroll:query')
  assert.equal(scrolled.geometry[4].scrollTop, 120)
  assert.ok(scrolled.trace.some(event => event[0] === 'index:scroll' && event[1] === 120))
  await click(40, 155)
  assert.equal((await storage('scroll:taps')).at(-1).owner, 'page')
  const catchCdp = await context.newCDPSession(page)
  const catchStart = await point(180, 160), catchEnd = await point(170, 145)
  await catchCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: catchStart.x, y: catchStart.y, id: 42 }] })
  await catchCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: catchEnd.x, y: catchEnd.y, id: 42 }] })
  await catchCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await catchCdp.detach()
  await click(42, 2) // Scrolled inspector control invokes selector callbacks.
  const caught = await storage('scroll:catch')
  assert.equal(caught.scrollLeft, 0)
  assert.equal(caught.scrollTop, 0)
  assert.ok((await storage('scroll:query')).trace.includes('c:catchtouchmove'), 'real catch handler suppresses drag')
  await snapshot('catch-touch')
  const final = await simulator.json('/api/state')
  assert.equal(final.sessionId, initial.sessionId)
  assert.deepEqual(final.diagnostics, [])
  assert.deepEqual(browserErrors, [])
  assert.ok(report.browserInputs.some(request => request.payload.events.some(event => event.type === 'wheel')))
  assert.ok(report.browserInputs.some(request => request.payload.events.some(event => event.type === 'touchmove')))
  Object.assign(report, { status: 'passed', first, touched, embedded, scrolled, caught, finalState: final, browserErrors })
} catch (error) {
  report.error = { message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  const errors = []
  for (const [name, resource] of [['context', context], ['browser', browser], ['sse', stream]]) {
    try { if (resource) await resource.close(); report.cleanup[name] = 'closed' }
    catch (error) { errors.push(`${name}: ${error.message}`) }
  }
  try { if (simulator) report.cleanup.simulator = await simulator.stop() } catch (error) { errors.push(error.message) }
  signals.dispose()
  try {
    report.sourceAfter = Object.fromEntries(await Promise.all(Object.keys(sourceBefore).map(async path => [path, sha256(await readFile(resolve(project, path)))])))
    if (JSON.stringify(report.sourceAfter) !== JSON.stringify(sourceBefore)) errors.push('fixture sources changed during verification')
    report.toolSourcesAfter = Object.fromEntries(await toolHashes())
    if (JSON.stringify(report.toolSourcesAfter) !== JSON.stringify(report.toolSourcesBefore)) errors.push('smoke tools changed during verification')
  } catch (error) { errors.push(`source verification: ${error.message}`) }
  if (errors.length) { report.status = 'failed'; report.cleanup.errors = errors; process.exitCode = 1 }
  await save()
  console.log(JSON.stringify({ status: report.status, report: resolve(out, 'report.json'), error: report.error, cleanup: report.cleanup }, null, 2))
}
