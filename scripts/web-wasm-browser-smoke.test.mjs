import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { inspectBuiltSite, parseArgs, runBrowserSmoke } from './web-wasm-browser-smoke.mjs'

async function eligibleSite(directory) {
  const siteDir = resolve(directory, 'site')
  await mkdir(siteDir)
  const artifacts = {}
  for (const [kind, path, bytes] of [
    ['wasm', 'module.wasm', Buffer.from('0061736d01000000', 'hex')],
    ['glue', 'module.js', Buffer.from('export default function init() {}')],
  ]) {
    await writeFile(resolve(siteDir, path), bytes)
    artifacts[kind] = { path, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  await writeFile(resolve(siteDir, 'build-report.json'), JSON.stringify({ status: 'passed', ready: true, artifacts }))
  await writeFile(resolve(siteDir, 'runtime-config.json'), JSON.stringify({ schemaVersion: 1, renderer: 'software', fallback: 'error' }))
  return { siteDir, outDir: resolve(directory, 'evidence') }
}

test('browser smoke CLI requires separate explicit input/output paths', () => {
  assert.throws(() => parseArgs([]), /Usage:/)
  assert.throws(() => parseArgs(['--site-dir']), /Missing value/)
  assert.throws(() => parseArgs(['--port', '1']), /Unknown argument/)
  assert.throws(() => parseArgs(['--site-dir', '/site', '--site-dir', '/site2']), /Duplicate/)
  assert.throws(() => parseArgs(['--site-dir', '/site', '--out-dir', '/site/out']), /separate/)
  assert.throws(() => parseArgs(['--site-dir', '/site/out', '--out-dir', '/site']), /separate/)
  assert.deepEqual(parseArgs(['--site-dir', '/site', '--out-dir', '/evidence']), { siteDir: '/site', outDir: '/evidence' })
})

test('preflight binds eligible source artifacts and refuses changed WASM before launching a browser', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'web-browser-smoke-contract-'))
  try {
    const siteDir = resolve(directory, 'site'), outDir = resolve(directory, 'evidence')
    await mkdir(siteDir)
    const digest = bytes => createHash('sha256').update(bytes).digest('hex')
    const wasm = Buffer.from('0061736d01000000', 'hex'), glue = Buffer.from('export default function init() {}')
    await writeFile(resolve(siteDir, 'module.wasm'), wasm)
    await writeFile(resolve(siteDir, 'module.js'), glue)
    const build = { status: 'passed', ready: true, artifacts: {
      wasm: { path: 'module.wasm', sha256: digest(wasm) }, glue: { path: 'module.js', sha256: digest(glue) },
    } }
    await writeFile(resolve(siteDir, 'build-report.json'), JSON.stringify(build))
    await writeFile(resolve(siteDir, 'runtime-config.json'), JSON.stringify({ schemaVersion: 1, renderer: 'canvaskit', fallback: 'error' }))
    assert.equal((await inspectBuiltSite(siteDir)).config.renderer, 'canvaskit')
    await writeFile(resolve(siteDir, 'module.wasm'), 'changed bytes')
    let launches = 0
    const report = await runBrowserSmoke({ siteDir, outDir }, { chromium: { launch() { launches++; throw new Error('must not launch') } } })
    assert.equal(launches, 0)
    assert.equal(report.status, 'failed')
    assert.match(report.error, /wasm differs from its build report/)
    assert.deepEqual(report.cleanup, {})
    assert.equal(JSON.parse(await readFile(resolve(outDir, 'execution.json'))).status, 'failed')
    build.status = 'partial'
    await writeFile(resolve(siteDir, 'build-report.json'), JSON.stringify(build))
    await assert.rejects(inspectBuiltSite(siteDir), /Only a clean passed build/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('pre-aborted smoke records cancellation without creating browser/server resources', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'web-browser-smoke-aborted-'))
  try {
    const options = await eligibleSite(directory), controller = new AbortController()
    controller.abort(new Error('Received SIGINT'))
    let launches = 0
    const report = await runBrowserSmoke(options, { signal: controller.signal,
      chromium: { launch() { launches++; throw new Error('must not launch') } } })
    assert.equal(report.status, 'cancelled')
    assert.equal(launches, 0)
    assert.match(report.cancellation.reason, /SIGINT/)
    assert.deepEqual(report.cleanup, {})
    assert.equal(JSON.parse(await readFile(resolve(options.outDir, 'execution.json'))).status, 'cancelled')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('legacy smoke selects explicit legacy.html and refuses Worker product plans before launch', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'web-browser-smoke-entry-'))
  try {
    const options = await eligibleSite(directory), path = resolve(options.siteDir, 'build-report.json')
    const build = JSON.parse(await readFile(path))
    build.plan = { execution: 'legacy' }; build.browserAssets = { entry: 'legacy.html' }
    await writeFile(path, JSON.stringify(build))
    assert.equal((await inspectBuiltSite(options.siteDir)).entry, 'legacy.html')
    build.plan.execution = 'worker'; build.browserAssets.entry = 'index.html'
    await writeFile(path, JSON.stringify(build))
    await assert.rejects(inspectBuiltSite(options.siteDir), /explicit legacy gate/)
    let launches = 0
    const report = await runBrowserSmoke(options, { chromium: { launch() { launches++; throw new Error('must not launch') } } })
    assert.equal(report.status, 'failed')
    assert.equal(launches, 0)
    assert.match(report.error, /explicit legacy gate/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('cancellation during launch waits for its owned browser, then closes it and the server', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'web-browser-smoke-launch-cancel-'))
  try {
    const options = await eligibleSite(directory), controller = new AbortController()
    let connected = true, browserCloses = 0, contextCreates = 0
    const browser = { isConnected: () => connected,
      async close() { browserCloses++; connected = false },
      async newContext() { contextCreates++; throw new Error('cancelled browser must not create a context') } }
    const report = await runBrowserSmoke(options, { signal: controller.signal, chromium: {
      async launch() { controller.abort(new Error('Received SIGTERM')); await Promise.resolve(); return browser },
    } })
    assert.equal(report.status, 'cancelled')
    assert.equal(browserCloses, 1)
    assert.equal(contextCreates, 0)
    assert.equal(report.cleanup.browserClosed, true)
    assert.equal(report.cleanup.serverClosed, true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const closeFails of [false, true]) test(`page-wait cancellation owns cleanup and ${closeFails ? 'reports page-close failure' : 'releases every resource'}`, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'web-browser-smoke-page-cancel-'))
  try {
    const options = await eligibleSite(directory), controller = new AbortController(), calls = []
    let pageClosed = false, connected = true, rejectGoto
    const page = {
      isClosed: () => pageClosed, on() {},
      goto() {
        return new Promise((_resolve, reject) => {
          rejectGoto = reject
          controller.abort(new Error('Received SIGINT'))
          if (closeFails) reject(new Error('cancelled wait'))
        })
      },
      async close() {
        calls.push('page.close')
        if (closeFails) throw new Error('owned page close failed')
        pageClosed = true
        rejectGoto(new Error('Owned page closed during goto'))
      },
    }
    const context = { async newPage() { return page }, async close() { calls.push('context.close') } }
    const browser = { version: () => 'ownership-test-double', isConnected: () => connected,
      async newContext() { return context }, async close() { calls.push('browser.close'); connected = false } }
    const report = await runBrowserSmoke(options, { signal: controller.signal, chromium: { async launch() { return browser } } })
    assert.equal(report.status, closeFails ? 'failed' : 'cancelled')
    assert.deepEqual(calls, ['page.close', 'context.close', 'browser.close'])
    assert.equal(report.cleanup.contextClosed, true)
    assert.equal(report.cleanup.browserClosed, true)
    assert.equal(report.cleanup.serverClosed, true)
    if (closeFails) assert.match(report.cleanup.cancellationPageCloseError, /owned page close failed/)
    else {
      assert.equal(report.cleanup.cancellationPageClosed, true)
      assert.match(report.cleanup.runtime, /explicit runtime unload not observed/)
    }
    assert.equal(JSON.parse(await readFile(resolve(options.outDir, 'execution.json'))).status, report.status)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
