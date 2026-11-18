#!/usr/bin/env node

/** Browser-only acceptance for the Morrow Supply shop flow. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connectDevEvents, installSmokeSignals, startDevSimulator } from './simulator-dev-harness.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PROJECT = resolve(ROOT, 'examples/apps/shop-demo')
const DEFAULT_OUT = resolve(ROOT, 'artifacts/shop-demo-browser')
const VIEWPORTS = [{ width: 375, height: 667 }, { width: 1024, height: 768 }]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorValue = error => ({ name: error.name, message: error.message, stack: error.stack })
const canRead = async path => { try { await access(path); return true } catch { return false } }

function parseArgs(args) {
  const options = { out: DEFAULT_OUT, pack: resolve(ROOT, 'artifacts/shop-demo/pack'), timeoutMs: 120000 }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--out' || argument === '--pack' || argument === '--timeout') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
      if (argument === '--out') options.out = resolve(ROOT, value)
      else if (argument === '--pack') options.pack = resolve(ROOT, value)
      else options.timeoutMs = Number(value)
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('--timeout must be an integer >= 1000')
  return options
}

async function waitFor(read, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try { last = await read(); if (last) return last } catch (error) { last = error }
    await pause(50)
  }
  throw new Error(`${label} timed out${last instanceof Error ? `: ${last.message}` : ''}`)
}

async function runViewport({ viewport, out, chromium, timeoutMs, signal }) {
  const label = `${viewport.width}x${viewport.height}`
  const report = { viewport, status: 'failed', checks: {}, requests: [], pageErrors: [], console: [], cleanup: {}, headless: true }
  let simulator, stream, browser, context, page
  try {
    simulator = await startDevSimulator({ root: ROOT, project: PROJECT, port: 0, engine: 'quickjs', renderer: 'webview', viewport: label, timeoutMs, signal })
    stream = await connectDevEvents(simulator.url, timeoutMs, { signal })
    const playwrightPath = resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || join(ROOT, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))
    ;({ chromium } = chromium ? { chromium } : await import(pathToFileURL(playwrightPath).href))
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
    page = await context.newPage()
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.origin === new URL(simulator.url).origin) report.requests.push({ method: request.method(), path: url.pathname })
    })
    page.on('pageerror', error => report.pageErrors.push(errorValue(error)))
    page.on('console', message => report.console.push({ type: message.type(), text: message.text() }))
    await page.goto(simulator.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    const dom = () => page.frameLocator('#domScreen iframe:visible')
    const ready = await waitFor(async () => {
      const frame = dom()
      const button = frame.locator('#open-cart')
      return await button.count() ? frame : null
    }, 'home DOM', timeoutMs)
    assert.equal(await ready.locator('#open-cart').count(), 1)
    report.checks.home = 'passed'
    await page.screenshot({ path: join(out, 'home.png'), fullPage: true })

    await ready.locator('.product-card').first().click()
    await waitFor(async () => await dom().locator('#add-detail').count() ? true : null, 'detail page', timeoutMs)
    report.checks.detail = 'passed'
    await dom().locator('#add-detail').click()
    await waitFor(async () => (await dom().locator('.detail-title').textContent())?.includes('Atlas'), 'detail add', timeoutMs)
    await dom().locator('.back-link').click()
    await waitFor(async () => await dom().locator('#open-cart').count() ? true : null, 'catalog after back', timeoutMs)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await waitFor(async () => await dom().locator('#open-cart').count() ? true : null, 'catalog reload', timeoutMs)
    report.checks.reloadRetainedSession = 'passed'

    await dom().locator('#open-cart').click()
    await waitFor(async () => (await dom().locator('.cart-name').textContent())?.includes('Atlas'), 'cart item', timeoutMs)
    const quantity = dom().locator('.quantity-value')
    assert.equal(await quantity.textContent(), '1')
    await dom().locator('.quantity-button').filter({ hasText: '+' }).click()
    await waitFor(async () => await quantity.textContent() === '2', 'quantity update', timeoutMs)
    report.checks.cart = { quantity: await quantity.textContent(), item: await dom().locator('.cart-name').textContent() }
    await dom().locator('#checkout').click()
    await waitFor(async () => await dom().locator('#place-order').count() ? true : null, 'checkout page', timeoutMs)
    await dom().locator('#place-order').click()
    await waitFor(async () => (await dom().locator('.panel-title').textContent())?.includes('Order received'), 'order completion', timeoutMs)
    report.checks.order = 'passed'
    await dom().locator('.secondary-button').click()
    await waitFor(async () => await dom().locator('#open-cart').count() ? true : null, 'home after order', timeoutMs)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await waitFor(async () => await dom().locator('#open-cart').count() ? true : null, 'home persistence reload', timeoutMs)
    await dom().locator('#open-cart').click()
    await waitFor(async () => await dom().locator('.empty').count() ? true : null, 'cleared cart', timeoutMs)
    assert.match(await dom().locator('.empty').textContent(), /cart is clear/i)
    report.checks.clearedAfterOrder = 'passed'
    await page.screenshot({ path: join(out, 'order-complete.png'), fullPage: true })
    assert.deepEqual(report.pageErrors, [])
    report.status = 'passed'
  } catch (error) {
    report.error = errorValue(error)
    if (page && !page.isClosed()) {
      try { await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }) } catch {}
    }
  } finally {
    const cleanup = async (name, operation) => { try { report.cleanup[name] = await operation() ?? true } catch (error) { report.cleanup[name] = { error: errorValue(error) }; report.status = 'failed' } }
    if (page) await cleanup('page', async () => { if (!page.isClosed()) await page.close(); assert.equal(page.isClosed(), true) })
    if (context) await cleanup('context', () => context.close())
    if (browser) await cleanup('browser', async () => { await browser.close(); assert.equal(browser.isConnected(), false) })
    if (stream) await cleanup('sse', () => stream.close())
    if (simulator) await cleanup('simulator', () => simulator.stop())
  }
  return report
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { console.log('Usage: node scripts/shop-demo-browser-smoke.mjs [--pack DIR] [--out DIR] [--timeout MS]'); return }
  await mkdir(options.out, { recursive: true })
  const manifestBytes = await readFile(resolve(options.pack, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  const report = { schemaVersion: 1, scope: 'shop-demo-browser-flow', status: 'failed', generatedAt: new Date().toISOString(), pack: options.pack, manifestSha256: sha256(manifestBytes), integrityRoot: manifest.integrity?.root, viewports: [], limitations: ['Headless Chromium and the development WebView surface are auxiliary evidence; this does not certify official DevTools, GPU or physical-device behavior.'] }
  const signals = installSmokeSignals()
  let chromium
  try {
    const playwrightPath = resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || join(ROOT, 'vendor/weapp-vite/node_modules/playwright/index.mjs'))
    if (!await canRead(playwrightPath)) {
      report.status = 'blocked'
      report.blockedReason = `Playwright module is unavailable: ${playwrightPath}`
      await writeFile(resolve(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
      console.log(JSON.stringify({ status: report.status, report: resolve(options.out, 'report.json'), blockedReason: report.blockedReason }, null, 2))
      return
    }
    ;({ chromium } = await import(pathToFileURL(playwrightPath).href))
    for (const viewport of VIEWPORTS) {
      const viewportOut = resolve(options.out, `${viewport.width}x${viewport.height}`)
      await rm(viewportOut, { recursive: true, force: true }); await mkdir(viewportOut, { recursive: true })
      report.viewports.push(await runViewport({ viewport, out: viewportOut, chromium, timeoutMs: options.timeoutMs, signal: signals.signal }))
    }
    report.status = report.viewports.every(item => item.status === 'passed') ? 'passed' : 'failed'
  } catch (error) {
    report.error = errorValue(error)
  } finally {
    signals.dispose()
    await writeFile(resolve(options.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify({ status: report.status, report: resolve(options.out, 'report.json'), viewports: report.viewports.map(item => ({ viewport: item.viewport, status: item.status })) }, null, 2))
  if (report.status === 'failed') process.exitCode = 1
}

try { await main() } catch (error) { console.error(error.stack || error); process.exitCode = 1 }
