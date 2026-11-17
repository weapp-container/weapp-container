#!/usr/bin/env node
/** Auxiliary CSS observations. Never a WeChat/runtime conformance verdict. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const run = promisify(execFile)
const options = Object.fromEntries(process.argv.slice(2).reduce((items, value, index, all) => {
  if (index % 2 === 0) { assert.ok(['--package', '--out'].includes(value) && all[index + 1]); items.push([value.slice(2), all[index + 1]]) }
  return items
}, []))
assert.ok(options.out, '--out is required')
const out = resolve(options.out)
const installed = createRequire(resolve(options.package ?? resolve(ROOT, 'vendor/weapp-vite/package.json')))
const { chromium } = installed('playwright')
const inputs = []
const add = (id, text, whiteSpace, wordBreak = 'normal', textAlign = 'start', width = 30) =>
  inputs.push({ id, text, whiteSpace, wordBreak, textAlign, width })
for (const whiteSpace of ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces']) {
  for (const [label, text] of [['collapse', '  AA  BB  '], ['crlf-tab', 'A\r\nB\tC'],
    ['trailing-newline', 'AA\n'], ['newlines', '\nAA\n\n'], ['empty', ''], ['spaces', '   '],
    ['latin', 'abcdefghij'], ['cjk', '你好世界'], ['grapheme', 'e\u0301e\u0301e\u0301']]) add(`${whiteSpace}-${label}`, text, whiteSpace)
}
for (const wordBreak of ['normal', 'break-all', 'keep-all']) {
  for (const [label, text] of [['latin', 'abcdefghij'], ['cjk', '你好世界'], ['punctuation', '你好，世界。'],
    ['nbsp', 'AA\u00a0BB'], ['zwsp', 'AB\u200bCD'], ['combining', 'e\u0301e\u0301e\u0301'], ['emoji', '👩‍💻👩‍💻']]) {
    add(`${wordBreak}-${label}`, text, 'normal', wordBreak, 'start', 15)
  }
}
for (const align of ['left', 'right', 'center', 'start', 'end']) {
  add(`align-${align}`, 'AA\nA', 'pre', 'normal', align, 60)
  add(`overflow-${align}`, 'ABCDEFGHIJ', 'nowrap', 'normal', align, 15)
}
for (const whiteSpace of ['normal', 'nowrap', 'pre-line']) {
  for (const [label, text] of [['cjk-newline', '你\n好'], ['cjk-latin-newline', '你\nA'],
    ['latin-cjk-newline', 'A\n好'], ['cjk-spaced-newline', '你 \n 好'], ['form-feed', 'A\fB']])
    add(`${whiteSpace}-${label}`, text, whiteSpace, 'normal', 'start', 100)
}
for (const whiteSpace of ['pre', 'pre-wrap', 'break-spaces']) {
  add(`${whiteSpace}-tab-at-stop`, '12345678\tA', whiteSpace, 'normal', 'start', 200)
  add(`${whiteSpace}-tab-before-stop`, '1234567\tA', whiteSpace, 'normal', 'start', 200)
  add(`${whiteSpace}-hanging-space-right`, 'AA   ', whiteSpace, 'normal', 'right', 20)
  add(`${whiteSpace}-hanging-space-center`, 'AA   ', whiteSpace, 'normal', 'center', 70)
  add(`${whiteSpace}-mincontent`, 'AA   BB ', whiteSpace, 'normal', 'start', 'min-content')
  add(`${whiteSpace}-maxcontent`, 'AA   BB ', whiteSpace, 'normal', 'start', 'max-content')
  add(`${whiteSpace}-trailing-maxcontent`, 'AA   ', whiteSpace, 'normal', 'start', 'max-content')
  add(`${whiteSpace}-trailing-mincontent`, 'AA   ', whiteSpace, 'normal', 'start', 'min-content')
}
for (const whiteSpace of ['normal', 'pre-line', 'pre-wrap']) {
  for (const [label, text] of [['space-combining-start', ' \u0301A'], ['space-combining-middle', 'A  \u0301B'],
    ['space-combining-end', 'A \u0301 '], ['tab-combining', '\t\u0301A']])
    add(`${whiteSpace}-${label}`, text, whiteSpace, 'normal', 'start', 100)
}
const report = { schemaVersion: 1, status: 'failed', startedAt: new Date().toISOString(),
  boundary: 'Auxiliary headless Chromium CSS text-flow observations only. No container, WeChat DevTools, GPU/device or performance verdict.',
  ownership: { owner: '/root', label: 'text1022', cwd: ROOT, entrypoint: 'standalone Playwright; no CDP/profile/extension',
    headlessRequested: true, taskCreated: true, retainedResources: [] },
  sourceBefore: sha(await readFile(fileURLToPath(import.meta.url))), cases: [], cleanup: { errors: [] } }
let browser, context, contextClosed = false, browserClosed = false
const sessions = async () => (await run('rtk', ['proxy', 'playwright-cli', 'list'], { cwd: ROOT })).stdout
try {
  report.sessionsBefore = await sessions()
  const pkg = installed.resolve('playwright/package.json'), executable = chromium.executablePath()
  const pkgBytes = await readFile(pkg)
  report.dependencies = { playwright: { path: pkg, version: JSON.parse(pkgBytes).version, sha256: sha(pkgBytes) },
    chromium: { path: executable, sha256: sha(await readFile(executable)) } }
  browser = await chromium.launch({ headless: true })
  browser.once('disconnected', () => { browserClosed = true })
  context = await browser.newContext({ viewport: { width: 400, height: 800 }, deviceScaleFactor: 1 })
  context.once('close', () => { contextClosed = true })
  const page = await context.newPage()
  report.browser = { version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent) }
  assert.match(report.browser.userAgent, /HeadlessChrome\//)
  report.ownership.effectiveHeadless = true
  for (const input of inputs) {
    await page.setContent('<!doctype html><meta charset="utf-8"><style>html,body{margin:0}#sample{font:10px/20px monospace;direction:ltr;overflow:visible}</style><div id="sample"></div>')
    const observed = await page.evaluate(input => {
      const element = document.getElementById('sample')
      Object.assign(element.style, { width: typeof input.width === 'number' ? `${input.width}px` : input.width, whiteSpace: input.whiteSpace, wordBreak: input.wordBreak, textAlign: input.textAlign })
      element.textContent = input.text
      const bounds = element.getBoundingClientRect(), style = getComputedStyle(element), source = element.firstChild
      const glyphs = []
      let offset = 0
      for (const character of input.text) {
        const range = document.createRange(); range.setStart(source, offset); offset += character.length; range.setEnd(source, offset)
        glyphs.push({ character, utf16End: offset, rects: [...range.getClientRects()].map(r => ({ x: r.x - bounds.x, y: r.y - bounds.y, width: r.width, height: r.height })) })
      }
      return { originalText: element.textContent, width: bounds.width, height: bounds.height, lineCount: bounds.height / 20,
        computed: { whiteSpace: style.whiteSpace, wordBreak: style.wordBreak, textAlign: style.textAlign }, glyphs }
    }, input)
    assert.equal(observed.originalText, input.text)
    assert.equal(observed.computed.whiteSpace, input.whiteSpace)
    assert.equal(observed.computed.wordBreak, input.wordBreak)
    assert.equal(observed.computed.textAlign, input.textAlign)
    report.cases.push({ input, observed })
    assert.equal(context.pages().length, 1)
  }
  report.status = 'passed'
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  try { if (context) await context.close() } catch (error) { report.cleanup.errors.push(`context: ${error.message}`) }
  try { if (browser) await browser.close() } catch (error) { report.cleanup.errors.push(`browser: ${error.message}`) }
  report.cleanup.contextClosed = contextClosed; report.cleanup.browserDisconnected = browserClosed
  try { report.sessionsAfter = await sessions(); assert.equal(report.sessionsAfter, report.sessionsBefore) }
  catch (error) { report.cleanup.errors.push(`sessions: ${error.message}`) }
  if (!contextClosed || !browserClosed || report.cleanup.errors.length) { report.status = 'failed'; process.exitCode = 1 }
  report.sourceAfter = sha(await readFile(fileURLToPath(import.meta.url)))
  if (report.sourceAfter !== report.sourceBefore) { report.status = 'failed'; process.exitCode = 1 }
  report.endedAt = new Date().toISOString()
  await mkdir(dirname(out), { recursive: true }); await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, cleanup: report.cleanup, out }))
}
