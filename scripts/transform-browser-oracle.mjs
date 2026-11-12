#!/usr/bin/env node
/** Auxiliary native HTML/CSS oracle; never a WeChat or container Web-host run. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { TRANSFORM_FRAME_CASES } from './transform-frame-replay.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const options = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1]
  assert.ok(['--frames', '--package', '--out'].includes(name) && value && !options[name], 'each named path is required once')
  options[name] = resolve(value)
}
for (const name of ['--frames', '--out']) assert.ok(options[name], name)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const installed = createRequire(options['--package'] ?? resolve(ROOT, 'vendor/weapp-vite/package.json'))
const { chromium } = installed('playwright'), out = options['--out']
await mkdir(out)
const cases = TRANSFORM_FRAME_CASES.filter(name => !name.startsWith('retained-unsupported-'))
const report = { schemaVersion: 1, status: 'failed', startedAt: new Date().toISOString(), cases: [], inputs: {},
  boundary: 'Auxiliary headless Chromium rendering of the same authored WXML-shaped HTML and WXSS with fixture Page data. Uses native CSS, elementFromPoint and actual PNG pixels; it does not execute AppService, WXML, the container Web host or official WeChat DevTools. Retained rejected frames have candidate Page data and are intentionally outside this HTML model.',
  excludedCases: TRANSFORM_FRAME_CASES.filter(name => !cases.includes(name)),
  ownership: { owner: '/root', label: 'transform1022', cwd: ROOT, entrypoint: 'standalone Playwright; no CDP/profile/extension', taskCreated: true, headlessRequested: true, retainedResources: [] },
  claims: { officialDevtools: false, containerWebHost: false, gpu: false, physicalDevice: false, performanceAcceptance: false },
  cleanup: {} }
let browser, context
const save = async (name, bytes) => {
  await writeFile(resolve(out, name), bytes, { flag: 'wx' })
  return { path: name, sha256: sha256(bytes), bytes: bytes.length }
}
const sources = async () => Object.fromEntries(await Promise.all([
  'scripts/transform-browser-oracle.mjs', 'scripts/transform-frame-replay.mjs',
].map(async path => [path, sha256(await readFile(resolve(ROOT, path)))])))
try {
  report.sourceBefore = await sources()
  const pkgPath = installed.resolve('playwright/package.json'), pkg = await readFile(pkgPath)
  const executable = chromium.executablePath()
  report.dependencies = { playwright: { path: pkgPath, sha256: sha256(pkg), version: JSON.parse(pkg).version }, chromium: { path: executable, sha256: sha256(await readFile(executable)) } }
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(String(error)))
  report.browser = { version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent) }
  assert.match(report.browser.userAgent, /HeadlessChrome\//)
  report.ownership.effectiveHeadless = true
  for (const name of cases) {
    const filename = `quickjs-${name}.json`, raw = await readFile(resolve(options['--frames'], filename)), fixture = JSON.parse(raw)
    assert.equal(fixture.case, name); assert.equal(fixture.engine, 'quickjs')
    const runtimeName = `quickjs-${name}.runtime.rgba`, runtime = await readFile(resolve(options['--frames'], runtimeName))
    assert.equal(sha256(runtime), fixture.snapshot.runtimeSha256)
    report.inputs[filename] = sha256(raw); report.inputs[runtimeName] = sha256(runtime)
    await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:256px;height:256px;overflow:hidden}page{display:block;position:relative;width:256px;height:256px}view{display:block}</style></head><body><page id="page"></page></body></html>')
    const observed = await page.evaluate(({ source, samples }) => {
      const data = source.pageData, evaluate = value => value.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression) => String(Function(...Object.keys(data), `return (${expression});`)(...Object.values(data))))
      const xml = new DOMParser().parseFromString(`<fixture>${source.wxml}</fixture>`, 'application/xml')
      if (xml.querySelector('parsererror')) throw new Error('fixture XML parsing failed')
      const build = sourceNode => {
        if (sourceNode.nodeType === Node.TEXT_NODE) return document.createTextNode(evaluate(sourceNode.textContent))
        if (sourceNode.nodeType !== Node.ELEMENT_NODE) return document.createComment('non-element')
        const node = document.createElement(sourceNode.tagName)
        for (const attribute of sourceNode.attributes) node.setAttribute(attribute.name, evaluate(attribute.value))
        for (const child of sourceNode.childNodes) node.append(build(child))
        return node
      }
      const root = document.getElementById('page')
      for (const child of xml.documentElement.childNodes) root.append(build(child))
      const style = document.createElement('style'); style.textContent = source.wxss; document.head.append(style)
      return { hits: samples.map(sample => ({ x: sample.x, y: sample.y, target: document.elementFromPoint(sample.x + .5, sample.y + .5)?.id })),
        geometry: [...root.querySelectorAll('[id]')].map(node => {
          const rect = node.getBoundingClientRect(), css = getComputedStyle(node)
          return { id: node.id, left: rect.left, top: rect.top, width: rect.width, height: rect.height, transform: css.transform, origin: css.transformOrigin }
        }) }
    }, { source: fixture.source, samples: fixture.samples })
    const entry = { case: name, observed, status: 'failed', geometryStatus: 'observed-only' }; report.cases.push(entry)
    entry.hitDifferences = fixture.samples.flatMap((sample, index) => observed.hits[index].target === sample.target ? []
      : [{ x: sample.x, y: sample.y, runtime: sample.target, chromium: observed.hits[index].target ?? null }])
    entry.hitStatus = entry.hitDifferences.length ? 'failed' : 'passed'
    const png = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', caret: 'hide', scale: 'css' })
    entry.png = await save(`${name}.png`, png)
    const decoded = await page.evaluate(async base64 => {
      const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
      return { width: canvas.width, height: canvas.height, pixels: [...ctx.getImageData(0, 0, canvas.width, canvas.height).data] }
    }, png.toString('base64'))
    assert.equal(decoded.width, 256); assert.equal(decoded.height, 256)
    const actual = Buffer.from(decoded.pixels); assert.equal(actual.length, runtime.length)
    entry.rgba = await save(`${name}.rgba`, actual)
    let maximumRgbError = 0, maximumAlphaError = 0, channelsOverTolerance = 0, differingChannels = 0
    const firstDifferences = []
    for (let index = 0; index < actual.length; index++) {
      const error = Math.abs(actual[index] - runtime[index]), alpha = index % 4 === 3
      if (error) differingChannels++
      if (alpha) maximumAlphaError = Math.max(maximumAlphaError, error)
      else maximumRgbError = Math.max(maximumRgbError, error)
      if (error > (alpha ? 0 : 1)) {
        channelsOverTolerance++
        if (firstDifferences.length < 16) firstDifferences.push({ x: Math.floor(index / 4) % 256, y: Math.floor(index / 1024), channel: index % 4, chromium: actual[index], runtime: runtime[index] })
      }
    }
    entry.pixelComparison = { rgbTolerance: 1, alphaTolerance: 0, maximumRgbError, maximumAlphaError, channelsOverTolerance, differingChannels, firstDifferences }
    entry.pixelStatus = channelsOverTolerance ? 'failed' : 'passed'
    entry.status = entry.pixelStatus === 'passed' && entry.hitStatus === 'passed' ? 'passed' : 'failed'
  }
  assert.deepEqual(errors, [])
  report.status = report.cases.length === cases.length && report.cases.every(entry => entry.status === 'passed') ? 'passed' : 'failed'
} catch (error) { report.error = error.stack || String(error) }
finally {
  const errors = []
  try { if (context) { await context.close(); report.cleanup.contextClosed = true } } catch (error) { errors.push(String(error)) }
  try { if (browser) { await browser.close(); assert.equal(browser.isConnected(), false); report.cleanup.browserClosed = true } } catch (error) { errors.push(String(error)) }
  try {
    report.sourceAfter = await sources(); assert.deepEqual(report.sourceBefore, report.sourceAfter)
    for (const [name, hash] of Object.entries(report.inputs)) assert.equal(sha256(await readFile(resolve(options['--frames'], name))), hash)
    report.cleanup.inputsUnchanged = true
  } catch (error) { errors.push(String(error)) }
  if (errors.length) { report.status = 'failed'; report.cleanup.errors = errors }
  report.finishedAt = new Date().toISOString()
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
}
process.stdout.write(JSON.stringify({ status: report.status, cases: report.cases.length, report: resolve(out, 'report.json'), cleanup: report.cleanup }) + '\n')
if (report.status !== 'passed') process.exitCode = 1
