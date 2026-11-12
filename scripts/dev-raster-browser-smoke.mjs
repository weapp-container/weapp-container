#!/usr/bin/env node
/** Owned experimental software-Raster HTTP/SSE/RAF smoke. Synthetic source is
 * packed by the real packer; this does not certify weapp-vite, GPU or latency. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connect } from 'node:net'
import { packContainer } from '../tools/container-manifest/src/index.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2), options = { engine: 'quickjs' }
for (let index = 0; index < args.length; index++) {
  const key = ({ '--binary': 'binary', '--out': 'out', '--engine': 'engine', '--playwright-module': 'playwright' })[args[index]]
  if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Usage: dev-raster-browser-smoke --binary PATH --out NEW-DIRECTORY [--engine quickjs|v8] [--playwright-module PATH]')
  options[key] = args[++index]
}
assert(options.binary && options.out && ['quickjs', 'v8'].includes(options.engine))
options.binary = resolve(options.binary); options.out = resolve(options.out)
const commit = execFileSync('rtk', ['proxy', 'git', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
await mkdir(options.out) // Never overwrite historical evidence.
const owned = await mkdtemp(join(tmpdir(), 'weapp-dev-raster-browser-'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const errorValue = error => ({ name: error.name, code: error.code, message: error.message, stack: error.stack })
const report = { schemaVersion: 1, status: 'failed', engine: options.engine,
  commit,
  scope: 'synthetic source, actual portable pack, native software Raster, owned HTTP/SSE and headless Chromium Canvas2D; no compiler/GPU/compositor/performance/official acceptance',
  environment: { platform: process.platform, arch: process.arch, node: process.version },
  resources: { owned, headless: true, maxPages: 2, preexistingPreviewTouched: false }, checks: {}, cleanup: { errors: [] } }
let child, exited = false, browser, context, url, exitResult, ending, childError
let childStopRequested = false, forceTermination
const closing = new Map()
let output = '', rejectAddress, resolveAddress
const address = new Promise((yes, no) => { resolveAddress = yes; rejectAddress = no })
// The address rejection is observed even if fixture setup fails first.
address.catch(() => {})
const signals = new AbortController()
function closeOwned(name, resource) {
  if (!resource) return
  if (!closing.has(name)) {
    // Keep the promise even when interruption starts closing before finally.
    closing.set(name, Promise.resolve().then(() => resource.close()).then(() => {
      report.cleanup[name] = 'closed'
    }, error => {
      report.cleanup[name] = 'failed'
      report.cleanup.errors.push({ resource: name, ...errorValue(error) })
    }))
  }
  return closing.get(name)
}
function signalChild(signal) {
  try {
    if (!child.kill(signal) && !exited) throw new Error(`could not send ${signal} to the owned example`)
  } catch (error) { report.cleanup.errors.push({ resource: 'process', ...errorValue(error) }) }
}
function stopChild() {
  if (!child || exited || childStopRequested) return
  childStopRequested = true
  signalChild('SIGINT')
  forceTermination = setTimeout(() => {
    if (!exited) { report.cleanup.forcedTermination = true; signalChild('SIGKILL') }
  }, 10_000)
}
function stop(reason) {
  if (signals.signal.aborted) return
  const error = reason instanceof Error ? reason : new Error('owned browser smoke interrupted')
  signals.abort(error)
  report.status = 'failed'; report.error ??= errorValue(error); report.cleanup.interrupted = true
  rejectAddress(error) // Do not leave startup waiting for its 120s deadline.
  stopChild()
  closeOwned('context', context)
  if (!context) closeOwned('browser', browser)
}
// Repeated signals must not restore Node's default exit during owned cleanup.
process.on('SIGINT', stop); process.on('SIGTERM', stop)

async function check(name, action) {
  signals.signal.throwIfAborted()
  const started = performance.now()
  try { const evidence = await action(); report.checks[name] = { status: 'passed', elapsedMs: performance.now() - started, ...evidence } }
  catch (error) { report.checks[name] = { status: 'failed', error: errorValue(error) }; throw error }
}
const state = page => page.evaluate(() => {
  const p = globalThis.__weappDevRasterPreview
  return { owner: p?.owner, inputEnabled: p?.inputEnabled, ticket: p?.presenter?.latest?.presentationTicket ?? p?.mirrorPresented ?? null }
})
async function ready(page, owner) {
  await page.waitForFunction(expected => {
    const p = globalThis.__weappDevRasterPreview
    return p && p.owner === expected && (expected ? p.inputEnabled : !!p.mirrorPresented)
  }, owner, { timeout: 15_000 })
  return state(page)
}
const pixel = page => page.evaluate(() => [...document.querySelector('canvas').getContext('2d').getImageData(40, 40, 1, 1).data])
async function portClosed() {
  const parsed = new URL(url)
  return new Promise((yes, no) => {
    const socket = connect({ host: parsed.hostname, port: Number(parsed.port) })
    socket.setTimeout(1500)
    socket.once('connect', () => { socket.destroy(); no(new Error('owned HTTP port remains open')) })
    socket.once('timeout', () => { socket.destroy(); no(new Error('owned port cleanup was unobservable')) })
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? yes(true) : no(error) })
  })
}

try {
  const raw = join(owned, 'raw'), pack = join(owned, 'pack')
  await mkdir(join(raw, 'pages/home'), { recursive: true })
  const sources = {
    'app.json': JSON.stringify({ pages: ['pages/home/index'], window: { navigationBarTitleText: 'Raster smoke' } }),
    'app.js': 'App({});', 'pages/home/index.json': '{}',
    'pages/home/index.js': 'Page({data:{count:0},onTap:function(){this.setData({count:this.data.count+1});}});',
    'pages/home/index.wxml': '<view id="tap" bindtap="onTap" style="position:absolute;left:20px;top:20px;width:80px;height:60px;background:{{count % 2 ? \'#2050a0\' : \'#a02030\'}}">{{count}}</view>',
  }
  for (const [name, source] of Object.entries(sources)) await writeFile(join(raw, name), source)
  await packContainer(raw, pack, { compilerCommit: 'synthetic-smoke-no-weapp-vite-build' })
  const manifestBytes = await readFile(join(pack, 'manifest.json'))
  await writeFile(join(options.out, 'fixture-manifest.json'), manifestBytes)
  report.fixture = { kind: 'synthetic-raw-input', sources: Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, sha256(value)])), manifestSha256: sha256(manifestBytes) }
  report.binary = { path: options.binary, sha256: sha256(await readFile(options.binary)) }
  signals.signal.throwIfAborted()
  child = spawn(options.binary, ['--pack', pack, '--engine', options.engine, '--port', '0', '--duration-seconds', '180'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  report.resources.pid = child.pid
  ending = new Promise(done => {
    child.once('error', error => { childError = errorValue(error); rejectAddress(error) })
    child.once('close', (code, signal) => { exited = true; exitResult = { code, signal, ...(childError ? { error: childError } : {}) }; rejectAddress(new Error(`owned example exited ${code}/${signal}`)); done(exitResult) })
  })
  const observe = bytes => {
    const chunk = bytes.toString()
    if (output.length + chunk.length > 1024 * 1024) {
      report.serverOutputOverflow = true
      const error = new Error('owned server output exceeded the bounded evidence budget')
      stop(error); return
    }
    output += chunk
    for (const line of output.split('\n')) {
      try { const value = JSON.parse(line); if (value.profile === 'ticketed-raster-v1' && typeof value.url === 'string') resolveAddress(value) } catch { /* Non-JSON diagnostic lines are retained. */ }
    }
  }
  child.stdout.on('data', observe); child.stderr.on('data', observe)
  let deadline
  try {
    const announcement = await Promise.race([address, new Promise((_, no) => { deadline = setTimeout(() => no(new Error('owned example did not announce within 120s')), 120_000) })])
    url = announcement.url; report.resources.url = url
    const parsed = new URL(url)
    assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(announcement.browserUiAttached, true); assert.equal(announcement.gpuEvidence, false)
  } finally { clearTimeout(deadline) }
  signals.signal.throwIfAborted()
  const { chromium } = await import(pathToFileURL(resolve(options.playwright ?? process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE ?? join(root, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))).href)
  signals.signal.throwIfAborted()
  browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
  signals.signal.throwIfAborted()
  context = await browser.newContext({ viewport: { width: 1000, height: 950 } })
  signals.signal.throwIfAborted()
  const primary = await context.newPage()
  const errors = []; report.browserErrors = errors
  const observePage = page => page.on('pageerror', error => errors.push(errorValue(error)))
  observePage(primary)
  await check('initialExactRafAck', async () => {
    await primary.goto(url); const result = await ready(primary, true)
    assert.deepEqual(await pixel(primary), [160, 32, 48, 255])
    return { state: result }
  })
  const original = await state(primary)
  await check('actualTapSetDataAndNewTicket', async () => {
    const bounds = await primary.locator('canvas').boundingBox(); assert(bounds)
    await primary.mouse.click(bounds.x + 40 * bounds.width / 375, bounds.y + 40 * bounds.height / 667)
    await primary.waitForFunction(previous => {
      const p = globalThis.__weappDevRasterPreview
      return p?.inputEnabled && p.presenter.latest.presentationTicket.target.sourceFrameId !== previous
    }, original.ticket.target.sourceFrameId, { timeout: 15_000 })
    assert.deepEqual(await pixel(primary), [32, 80, 160, 255])
    return { state: await state(primary) }
  })
  const mirror = await context.newPage(); observePage(mirror)
  await check('actualMirrorReadOnly', async () => {
    await mirror.goto(url); await mirror.bringToFront(); const result = await ready(mirror, false)
    assert.equal(result.inputEnabled, false); assert.deepEqual(await pixel(mirror), [32, 80, 160, 255])
    const code = await mirror.evaluate(async () => { try { await globalThis.__weappDevRasterPreview.events([{ type: 'tap', x: 40, y: 40 }]); return null } catch (error) { return error.code } })
    assert.equal(code, 'ERR_CANCELLED'); return { state: result, inputError: code }
  })
  await check('explicitPrimaryTransfer', async () => {
    await mirror.bringToFront()
    await mirror.getByRole('button', { name: 'Make primary', exact: true }).click()
    const result = await ready(mirror, true); await primary.bringToFront(); await ready(primary, false)
    assert.notEqual(result.ticket.target.previewGeneration, original.ticket.target.previewGeneration)
    return { newPrimary: result, previousPrimary: await state(primary) }
  })
  await check('actualEofRetirementAndReclaim', async () => {
    await mirror.bringToFront()
    await mirror.waitForFunction(() => {
      const p = globalThis.__weappDevRasterPreview
      return p?.inputEnabled && !p.connection.control
    })
    const renewalStarted = performance.now()
    const leaseDurationMs = await mirror.evaluate(async () => {
      const p = globalThis.__weappDevRasterPreview
      // Real token-bound control, resolved only by this socket's final SSE.
      // This refresh makes natural lease expiry distinguishable from EOF.
      const result = await p.control(p.connection, 'heartbeat')
      return result.preview.leaseDurationMs
    })
    await mirror.evaluate(() => globalThis.__weappDisposeDevRaster()); await mirror.close()
    await primary.bringToFront()
    await primary.waitForFunction(() => globalThis.__weappDevRasterPreview?.connection?.preview?.ownerClientId === null, null, { timeout: 15_000 })
    const eofObservedMs = performance.now() - renewalStarted
    assert(eofObservedMs < Math.min(5000, leaseDurationMs / 3), 'EOF must retire the freshly renewed owner before natural expiry can explain it')
    await primary.getByRole('button', { name: 'Make primary', exact: true }).click(); const result = await ready(primary, true)
    assert.deepEqual(await pixel(primary), [32, 80, 160, 255]); return { state: result, leaseDurationMs, eofObservedMs }
  })
  await primary.screenshot({ path: join(options.out, 'accepted-primary.png'), fullPage: true })
  assert.deepEqual(errors, []); assert(!report.serverOutputOverflow); signals.signal.throwIfAborted(); report.status = 'passed'
} catch (error) { report.error = errorValue(error) }
finally {
  try {
    await closeOwned('context', context)
    await closeOwned('browser', browser)
    stopChild()
    if (ending) {
      try {
        report.cleanup.process = await ending
        if (report.cleanup.process.code !== 0 || report.cleanup.process.error || report.cleanup.forcedTermination) throw new Error('owned example did not shut down normally')
      } catch (error) { report.cleanup.errors.push({ resource: 'process', ...errorValue(error) }) } finally { clearTimeout(forceTermination) }
    }
    if (url) try { report.cleanup.portClosed = await portClosed() } catch (error) { report.cleanup.errors.push({ resource: 'port', ...errorValue(error) }) }
    try { await rm(owned, { recursive: true }); report.cleanup.fixture = 'removed' } catch (error) { report.cleanup.errors.push({ resource: 'fixture', ...errorValue(error) }) }
    await writeFile(join(options.out, 'server.log'), output)
    if (report.cleanup.errors.length) report.status = 'failed'
    // An interruption during the evidence write must also reach the saved report.
    let savedInterrupted
    do {
      savedInterrupted = signals.signal.aborted
      await writeFile(join(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    } while (savedInterrupted !== signals.signal.aborted)
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  }
}
console.log(JSON.stringify({ status: report.status, checks: report.checks, cleanup: report.cleanup }))
if (report.status !== 'passed') process.exitCode = 1
