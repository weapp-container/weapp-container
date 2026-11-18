#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const VIEWPORTS = [{ width: 375, height: 667 }, { width: 1024, height: 768 }]
const STORAGE_KEY = 'weapp-container:storage:v1:morrow-supply-shop'
const pause = ms => new Promise(done => setTimeout(done, ms))

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--') continue
    if (name === '--help' || name === '-h') return { help: true }
    if (name !== '--site-dir' && name !== '--out-dir') throw new Error(`unknown argument: ${name}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    const key = name === '--site-dir' ? 'siteDir' : 'outDir'
    if (options[key]) throw new Error(`duplicate argument: ${name}`)
    options[key] = resolve(value)
  }
  if (!options.siteDir || !options.outDir) throw new Error('Usage: node scripts/shop-demo-static-browser-smoke.mjs --site-dir <built-site> --out-dir <new-evidence-dir>')
  if (options.siteDir === options.outDir || options.siteDir.startsWith(options.outDir + sep) || options.outDir.startsWith(options.siteDir + sep)) {
    throw new Error('site and evidence directories must be separate')
  }
  return options
}

async function waitFor(read, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try { last = await read(); if (last) return last } catch (error) { last = error }
    await pause(50)
  }
  throw new Error(`${label} timed out${last instanceof Error ? `: ${last.message}` : ''}`)
}

async function runViewport({ browser, url, outDir, viewport }) {
  const result = { viewport, status: 'failed', checks: {}, pageErrors: [], consoleErrors: [], headless: true }
  let context, page
  try {
    context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
    page = await context.newPage()
    page.on('pageerror', error => result.pageErrors.push(error.stack || String(error)))
    page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()) })
    await page.goto(url, { waitUntil: 'load', timeout: 60000 })
    await page.waitForFunction(() => window.weappReady && window.weappPresented, null, { timeout: 60000 })
    await page.evaluate(() => Promise.all([window.weappReady, window.weappPresented]))
    const app = page.frameLocator('#surface-root iframe')
    await waitFor(async () => await app.locator('.product-card').count() > 0, 'shop home')
    result.checks.startup = await page.locator('#status').textContent()
    await page.screenshot({ path: resolve(outDir, `${viewport.width}x${viewport.height}-home.png`), fullPage: true })

    await app.locator('.product-card').first().click()
    await waitFor(async () => await app.locator('#add-detail').count() === 1, 'product detail')
    await app.locator('#add-detail').click()
    await app.locator('.back-link').click()
    await waitFor(async () => await app.locator('.product-card').count() > 0, 'catalog after add')
    await waitFor(() => page.evaluate(() => localStorage.getItem('weapp-container:storage:v1:morrow-supply-shop')), 'persisted cart snapshot')
    await page.reload({ waitUntil: 'load', timeout: 60000 })
    await page.evaluate(() => Promise.all([window.weappReady, window.weappPresented]))
    await app.locator('#open-cart').click()
    await waitFor(async () => (await app.locator('.cart-name').textContent())?.includes('Atlas'), 'restored cart after reload')
    const quantity = app.locator('.quantity-value')
    assert.equal(await quantity.textContent(), '1')
    result.checks.reloadRestoredCart = { item: await app.locator('.cart-name').textContent(), quantity: await quantity.textContent() }
    await app.locator('.quantity-button').filter({ hasText: '+' }).click()
    await waitFor(async () => await quantity.textContent() === '2', 'cart quantity update')
    await app.locator('#checkout').click()
    await waitFor(async () => await app.locator('#place-order').count() === 1, 'checkout')
    await app.locator('#place-order').click()
    await waitFor(async () => (await app.locator('.panel-title').textContent())?.includes('Order received'), 'order completion')
    result.checks.order = 'passed'
    await app.locator('.secondary-button').click()
    await waitFor(async () => await app.locator('.product-card').count() > 0, 'catalog after order')
    await waitFor(() => page.evaluate(() => localStorage.getItem('weapp-container:storage:v1:morrow-supply-shop')), 'cleared cart snapshot')
    await page.reload({ waitUntil: 'load', timeout: 60000 })
    await page.evaluate(() => Promise.all([window.weappReady, window.weappPresented]))
    await app.locator('#open-cart').click()
    await waitFor(async () => await app.locator('.empty').count() === 1, 'empty cart after reload')
    assert.match(await app.locator('.empty').textContent(), /cart is clear/i)
    result.checks.orderClearSurvivesReload = 'passed'
    await page.screenshot({ path: resolve(outDir, `${viewport.width}x${viewport.height}-empty-cart.png`), fullPage: true })
    assert.deepEqual(result.pageErrors, [])
    assert.deepEqual(result.consoleErrors, [])
    result.status = 'passed'
  } catch (error) {
    result.error = { name: error.name, message: error.message, stack: error.stack }
    if (page && !page.isClosed()) {
      try { await page.screenshot({ path: resolve(outDir, `${viewport.width}x${viewport.height}-failure.png`), fullPage: true }) } catch {}
    }
  } finally {
    if (context) {
      try { await context.close(); result.contextClosed = true }
      catch (error) { result.contextClosed = false; result.cleanupError = String(error); result.status = 'failed' }
    }
  }
  return result
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/shop-demo-static-browser-smoke.mjs --site-dir <built-site> --out-dir <new-evidence-dir>')
    return
  }
  const siteDir = await realpath(options.siteDir)
  const report = { schemaVersion: 1, scope: 'packaged-shop-web-wasm-storage-reload', status: 'failed',
    generatedAt: new Date().toISOString(), siteDir, viewports: [], headless: true,
    limitations: ['Headless Chromium is auxiliary browser evidence; this does not certify official DevTools, GPU or physical-device behavior.'] }
  let server, browser
  try {
    await mkdir(options.outDir, { recursive: false })
    const playwrightPath = resolve(process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE || 'vendor/weapp-vite/node_modules/playwright/index.mjs')
    try { await access(playwrightPath) } catch { throw new Error(`Playwright module is unavailable: ${playwrightPath}`) }
    const { chromium } = await import(pathToFileURL(playwrightPath).href)
    server = createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
        const path = resolve(siteDir, `.${pathname === '/' ? '/index.html' : pathname}`)
        if (!path.startsWith(siteDir + sep) || !(await realpath(path)).startsWith(siteDir + sep)) {
          response.writeHead(403).end(); return
        }
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
          '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' }[extname(path)] || 'application/octet-stream'
        response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }).end(await readFile(path))
      } catch { response.writeHead(404).end() }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    report.url = `http://127.0.0.1:${server.address().port}/`
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false })
    report.browserVersion = browser.version()
    for (const viewport of VIEWPORTS) report.viewports.push(await runViewport({ browser, url: report.url, outDir: options.outDir, viewport }))
    report.status = report.viewports.every(result => result.status === 'passed') ? 'passed' : 'failed'
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack }
  } finally {
    if (browser) {
      try { await browser.close(); report.browserClosed = !browser.isConnected() }
      catch (error) { report.browserClosed = false; report.cleanupError = String(error); report.status = 'failed' }
    }
    if (server) {
      try { await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); report.serverClosed = true }
      catch (error) { report.serverClosed = false; report.cleanupError = String(error); report.status = 'failed' }
    }
    await writeFile(resolve(options.outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(JSON.stringify({ status: report.status, report: resolve(options.outDir, 'report.json'),
    viewports: report.viewports.map(result => ({ viewport: result.viewport, status: result.status })) }, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
}

try { await main() } catch (error) { console.error(error.stack || error); process.exitCode = 1 }
