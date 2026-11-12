#!/usr/bin/env node
/** Real, one-page Browser development loop. This runner never builds a runtime,
 * derives producer trust pins, connects to remote CDP, or borrows an existing preview.
 * A failed attempt is retained as failed; choose a fresh --out-dir to retry. */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as pause } from 'node:timers/promises'
import { screenshotPixels } from './worker-product-browser-smoke.mjs'
import { INTERACTIVE_DOM_SURFACE_SELECTOR, installDomSurfaceProbe } from './browser-dev-dom-surface.mjs'
import { buttonSmokeFiles, buttonSmokeWxml, installButtonNativeAudit, runButtonSmoke } from './browser-dev-button-fixture.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHA = /^[a-f0-9]{64}$/, COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const execFileAsync = promisify(execFile)
const LIMITS = Object.freeze({ pins: 16 * 1024, report: 16 * 1024 * 1024,
  sourceFile: 64 * 1024 * 1024, sourceTotal: 512 * 1024 * 1024, sourceCount: 4096,
  binary: 512 * 1024 * 1024, evidence: 4 * 1024 * 1024, screenshot: 16 * 1024 * 1024,
  log: 2 * 1024 * 1024, line: 1024 * 1024, serverEvents: 512, requests: 4096, workers: 24 })
const SOURCE_FILES = ['scripts/browser-dev-loop-smoke.mjs', 'scripts/browser-dev-dom-surface.mjs', 'scripts/browser-dev-button-fixture.mjs', 'scripts/worker-product-browser-smoke.mjs', 'crates/container-simulator/examples/serve_browser_dev.rs',
  'crates/container-simulator/src/browser_dev_runner.rs', 'crates/container-simulator/src/main.rs',
  'crates/container-simulator/src/lib.rs', 'crates/container-simulator/src/browser_dev_stage_receipt.rs',
  'crates/container-simulator/src/browser_dev_owner.rs', 'crates/container-simulator/src/browser_dev_control_lane.rs',
  'crates/container-simulator/src/browser_dev_control.rs',
  'crates/container-simulator/src/web.rs', 'crates/container-simulator/src/web_control.rs',
  'crates/container-simulator/src/web_control_surface.rs', 'crates/container-simulator/src/web_dev_app.rs',
  'crates/container-simulator/src/web_resources.rs', 'crates/container-simulator/src/browser-dev-http-control.mjs',
  'examples/hosts/web-wasm/browser-dev-app.mjs', 'examples/hosts/web-wasm/browser-dev-entry.mjs',
  'examples/hosts/web-wasm/browser-dev.css', 'tools/container-manifest/src/index.mjs',
  'examples/hosts/web-wasm/browser-dev-owner-manager.mjs', 'examples/hosts/web-wasm/worker-session-client.mjs',
  'examples/hosts/web-wasm/worker-canvaskit-adapter.mjs', 'examples/hosts/web-wasm/canvaskit-presenter.mjs',
  'examples/hosts/web-wasm/worker-web-session.mjs', 'examples/hosts/web-wasm/worker-runtime.mjs', 'examples/hosts/web-wasm/surface-input.mjs',
  'examples/hosts/web-wasm/input-causal-ledger.mjs',
  'examples/hosts/web-wasm/dom-presenter.mjs', 'examples/hosts/web-wasm/dom-session-client.mjs',
  'examples/hosts/web-wasm/worker-dom-adapter.mjs', 'examples/hosts/web-wasm/worker-bridge-transport.mjs',
  'crates/container-runtime/src/browser_query.rs', 'crates/container-runtime/src/browser_view.rs',
  'crates/container-runtime/src/lib.rs', 'crates/container-runtime/src/view_query.rs', 'crates/container-runtime/src/view_topology.rs',
  'crates/container-bridge/src/lib.rs', 'crates/container-core/src/api-owner.js', 'crates/container-engine-quickjs/src/lib.rs', 'crates/container-engine-v8/src/lib.rs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); void promise.catch(() => {}); return { promise, resolve, reject } }
const scrub = text => String(text).replace(/("(?:secret|x-weapp-dev-secret)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
  .replace(/(x-weapp-dev-secret\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
const failure = error => ({ name: String(error?.name ?? 'Error').slice(0, 128), code: String(error?.code ?? 'ERR_TEST').slice(0, 128),
  message: scrub(error?.message ?? error).slice(0, 8192), stack: scrub(error?.stack ?? '').slice(0, 16 * 1024) })

export function parseArgs(args) {
  const names = new Map([['--server-bin', 'serverBin'], ['--producer-dir', 'producerDir'], ['--pins', 'pins'],
    ['--out-dir', 'outDir'], ['--node-bin', 'nodeBin'], ['--reloads', 'reloads'], ['--server-kind', 'serverKind'], ['--renderer', 'renderer'],
    ['--context-recovery', 'contextRecovery'], ['--dom-queries', 'domQueries'], ['--fixture', 'fixture']]), options = {}
  for (let i = 0; i < args.length; i++) {
    const key = names.get(args[i]), value = args[i + 1]
    assert.ok(key && value && !value.startsWith('--'), `Unknown option or missing value: ${args[i]}`)
    assert.equal(options[key], undefined, `Duplicate option: ${args[i]}`)
    if (key === 'reloads') {
      assert.match(String(value), /^(?:[1-9]|1[0-6])$/, 'Reload count must be 1..16')
      options[key] = Number(value)
    } else if (key === 'contextRecovery' || key === 'domQueries') {
      assert.ok(['true', 'false'].includes(value), `${key === 'domQueries' ? 'DOM queries' : 'Context recovery'} must be true or false`)
      options[key] = value === 'true'
    } else if (key === 'fixture') {
      assert.ok(['reference', 'button'].includes(value), 'Fixture must be reference or button')
      options[key] = value
    } else if (key === 'serverKind') {
      assert.ok(['example', 'cli'].includes(value), 'Server kind must be example or cli')
      options[key] = value
    } else if (key === 'renderer') {
      assert.ok(['webview', 'skia'].includes(value), 'Renderer must be webview or skia')
      options[key] = value
    } else options[key] = resolve(value)
    i++
  }
  for (const key of names.values()) if (!['reloads', 'serverKind', 'renderer', 'contextRecovery', 'domQueries', 'fixture'].includes(key)) assert.ok(options[key], `Missing required ${key}`)
  options.reloads ??= 1
  options.serverKind ??= 'example'
  options.renderer ??= 'webview'
  options.contextRecovery ??= false
  options.domQueries ??= false
  options.fixture ??= 'reference'
  assert.ok(options.fixture !== 'button' || options.renderer === 'webview' && options.serverKind === 'cli', 'Button fixture requires CLI WebView')
  assert.ok(!options.domQueries || options.fixture === 'reference', 'DOM queries require the reference fixture')
  assert.ok(options.renderer !== 'skia' || options.serverKind === 'cli', 'Skia smoke requires the CLI server')
  assert.ok(!options.contextRecovery || options.renderer === 'skia', 'Context recovery smoke requires Skia')
  assert.ok(!options.domQueries || options.serverKind === 'cli' && options.renderer === 'webview', 'DOM query smoke requires CLI + WebView')
  for (const input of ['serverBin', 'producerDir', 'pins', 'nodeBin'])
    assert.ok(options[input] !== options.outDir && !options[input].startsWith(options.outDir + sep), 'Evidence output cannot contain an input')
  assert.ok(!options.outDir.startsWith(options.producerDir + sep), 'Evidence output must be outside the original producer')
  return options
}

/** Only the original validated listening identity chooses the shutdown report.
 * Server output cannot redirect the consumer to an unrelated report file. */
export function serverSummaryPath(options, runId) {
  assert.ok(typeof runId === 'string' && /^[a-zA-Z0-9-]{1,256}$/.test(runId), 'Invalid original server run id')
  assert.ok(['example', 'cli'].includes(options.serverKind), 'Server kind must be example or cli')
  return options.serverKind === 'cli'
    ? resolve(options.outDir, 'server/runs', runId, 'browser-dev-summary.json')
    : resolve(options.outDir, 'server/serve-browser-dev-summary.json')
}

export function validatedSummaryPath(options, listening) {
  const expected = serverSummaryPath(options, listening.runId)
  assert.equal(listening.summaryPath, expected, 'Original listening event selected an unauthorized summary path')
  return expected
}

async function regularFile(path, limit) {
  const stat = await lstat(path)
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && await realpath(path) === path, `Expected a regular, canonical file: ${path}`)
  assert.ok(stat.size >= 0 && stat.size <= limit, `File exceeds its finite budget: ${path}`)
  return stat
}

async function futureCanonicalPath(path) {
  const missing = []; let current = path
  while (true) {
    try { return resolve(await realpath(current), ...missing) }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(current) === current) throw error
      missing.unshift(basename(current)); current = dirname(current)
    }
  }
}

async function boundedRead(path, limit) {
  const before = await regularFile(path, limit), bytes = await readFile(path), after = await lstat(path)
  assert.equal(bytes.length, before.size, `File changed during read: ${path}`)
  assert.equal(after.ino, before.ino); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs)
  return bytes
}

async function fileHash(path, limit) {
  const before = await regularFile(path, limit), digest = createHash('sha256'); let bytes = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    bytes += chunk.length; assert.ok(bytes <= limit, `File grew beyond its bound: ${path}`); digest.update(chunk)
  }
  const after = await lstat(path)
  assert.equal(bytes, before.size); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs)
  return { sha256: digest.digest('hex'), bytes }
}

function sourcePath(root, name) {
  assert.ok(typeof name === 'string' && name.length <= 2048 && !isAbsolute(name) && !/[\\%?#\x00-\x1f]/.test(name)
    && name.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid producer source inventory path')
  const path = resolve(root, name)
  assert.ok(path.startsWith(root + sep), 'Producer source path escaped its original root')
  return path
}

/** Pins are read BEFORE report/source consumption and remain independent.
 * The managed server subsequently performs the full runtime admission check. */
async function inspectProducer(options) {
  const pinBytes = await boundedRead(options.pins, LIMITS.pins), pins = JSON.parse(pinBytes), expected = pins.expected
  assert.ok(record(expected) && SHA.test(expected.reportSha256) && COMMIT.test(expected.sourceCommit)
    && SHA.test(expected.sourceSha256) && ['software', 'canvaskit'].includes(expected.renderer), 'Independent report/source/renderer pins are required')
  if (options.renderer === 'skia') assert.equal(expected.renderer, 'canvaskit', 'Skia requires an independently pinned CanvasKit producer')
  const bytes = await boundedRead(resolve(options.producerDir, 'build-report.json'), LIMITS.report), report = JSON.parse(bytes)
  assert.equal(hash(bytes), expected.reportSha256, 'Original build-report differs from the independent pin')
  assert.equal(report.schemaVersion, 1); assert.equal(report.status, 'passed'); assert.equal(report.buildStatus, 'passed'); assert.equal(report.ready, true)
  assert.equal(report.plan?.execution, 'worker'); assert.equal(report.plan?.renderer, expected.renderer)
  assert.equal(report.source?.status, 'passed'); assert.equal(report.source?.workingTreeDirty, false); assert.equal(report.source?.sourceStable, true)
  assert.equal(report.source?.sourceCommit, expected.sourceCommit); assert.equal(report.source?.sourceSha256, expected.sourceSha256)
  const files = report.source?.sourceFiles
  assert.ok(record(files) && Object.keys(files).length > 0 && Object.keys(files).length <= LIMITS.sourceCount, 'Producer source inventory must be nonempty and bounded')
  assert.equal(hash(JSON.stringify(files)), expected.sourceSha256, 'Independent producer source inventory hash mismatch')
  let total = 0
  for (const [name, expectedSha] of Object.entries(files)) {
    assert.match(expectedSha, SHA)
    const actual = await fileHash(sourcePath(resolve(options.producerDir, 'source'), name), LIMITS.sourceFile)
    total += actual.bytes; assert.ok(total <= LIMITS.sourceTotal, 'Producer source inventory exceeds its retained-byte budget')
    assert.equal(actual.sha256, expectedSha, `Original retained source differs from its pin: ${name}`)
  }
  return { directory: options.producerDir, pinsPath: options.pins, pinsSha256: hash(pinBytes), expected: structuredClone(expected),
    reportSha256: hash(bytes), sourceFiles: Object.keys(files).length, sourceBytes: total,
    verification: 'independent report and every original retained source file; full runtime admission remains owned by the server' }
}

async function git(args, cwd = ROOT) {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: LIMITS.evidence })
  return result.stdout.trim()
}

async function sourceVersion() {
  const files = {}
  for (const path of SOURCE_FILES) files[path] = await fileHash(resolve(ROOT, path), LIMITS.sourceFile)
  return { commit: await git(['rev-parse', 'HEAD']), workingTreeStatus: await git(['status', '--porcelain=v1', '--untracked-files=normal']),
    vendorCommit: await git(['rev-parse', 'HEAD'], resolve(ROOT, 'vendor/weapp-vite')), files,
    sourceSha256: hash(JSON.stringify(files)), binarySourceAssociation: 'binary hash and observed checkout are separate; this consumer does not fabricate a build receipt' }
}

/** A deadline rejects only the wait, without closing the page or pretending
 * that the underlying job ended. finally gets the first original app.close. */
async function deadline(action, ms, label, signal) {
  let timer, abort
  const actual = Promise.resolve().then(action); void actual.catch(() => {})
  const gate = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`ERR_TIMEOUT: ${label} exceeded ${ms} ms; actual work may remain pending`), { code: 'ERR_TIMEOUT' })), ms)
    abort = () => reject(signal.reason ?? Object.assign(new Error('Smoke interrupted'), { code: 'ERR_CANCELLED' }))
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([actual, gate]) }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

async function atomicWrite(path, content) {
  const temporary = resolve(dirname(path), `.${relative(dirname(path), path)}.smoke-next`)
  let handle
  try {
    handle = await open(temporary, 'wx'); await handle.writeFile(content); await handle.sync(); await handle.close(); handle = null
    await rename(temporary, path)
  } catch (error) {
    if (handle) await handle.close()
    try { await unlink(temporary) } catch (cleanup) { if (cleanup.code !== 'ENOENT') throw new AggregateError([error, cleanup], 'Atomic fixture write cleanup failed') }
    throw error
  }
}

function wxml(build, serverKind, renderer = 'webview', contextRecovery = false, domQueries = false, fixture = 'reference') {
  if (fixture === 'button') return buttonSmokeWxml(build)
  const marker = serverKind === 'cli' ? '<text id="startup-marker">{{marker}}</text>' : ''
  const feedback = renderer === 'skia' ? '<view id="feedback" style="background-color:{{count === 7 ? \'#1f4b99\' : \'#1e8449\'}}"></view>' : ''
  const probe = contextRecovery ? '<wxs module="recoveryProbe">var calls = 0; module.exports = { next: function() { calls++; return "View calls: " + calls; } };</wxs>' : ''
  const viewCalls = contextRecovery ? '<text id="view-calls">{{recoveryProbe.next()}}</text>' : ''
  const queries = domQueries ? '<view id="tap" class="button" style="margin-left:{{count === 7 ? 0 : 37}}px" bindtap="measureTap">Measure</view><text id="query-status">Query {{queryStatus}}</text>' : ''
  return `${probe}<view class="page"><text id="build">Build ${build}</text><text id="count">Count: {{count}}</text>${marker}<view id="increment" class="button" bindtap="increment">Increment</view>${feedback}${viewCalls}${queries}</view>\n`
}

/** The CLI fixture deliberately differs from all startup defaults. Its first
 * route is a decoy, and rendered data must override the Page declaration. */
export function smokeFixture(serverKind = 'example', renderer = 'webview', contextRecovery = false, domQueries = false, fixture = 'reference') {
  assert.ok(['reference', 'button'].includes(fixture), 'Fixture must be reference or button')
  assert.ok(fixture !== 'button' || serverKind === 'cli' && renderer === 'webview', 'Button fixture requires CLI WebView')
  assert.ok(!domQueries || fixture === 'reference', 'DOM queries require the reference fixture')
  assert.ok(['example', 'cli'].includes(serverKind), 'Server kind must be example or cli')
  assert.ok(['webview', 'skia'].includes(renderer), 'Renderer must be webview or skia')
  assert.ok(renderer !== 'skia' || serverKind === 'cli', 'Skia smoke requires the CLI server')
  assert.equal(typeof contextRecovery, 'boolean')
  assert.ok(!contextRecovery || renderer === 'skia', 'Context recovery fixture requires Skia')
  assert.equal(typeof domQueries, 'boolean')
  assert.ok(!domQueries || serverKind === 'cli' && renderer === 'webview', 'DOM query fixture requires CLI + WebView')
  const cli = serverKind === 'cli', route = 'pages/home/index', diagnosticModuleId = 'module:browser-dev-smoke-state.js'
  const data = cli ? { count: 7, marker: 'cli-startup-data-observed' } : { count: 0 }
  const viewport = cli ? { width: 414, height: 736 } : { width: 375, height: 667 }
  // Keep emitted source acceptable to the official toolchain. The public
  // CLI renderer policy deliberately overrides this declaration for Skia.
  const files = { 'app.js': 'App({})\n', 'app.json': JSON.stringify({ pages: cli ? ['pages/decoy/index', route] : [route], renderer: 'webview',
    window: { navigationBarTitleText: 'Browser development loop smoke' } }, null, 2) + '\n',
  'app.wxss': '.page { padding: 24px; } text { display: block; margin-bottom: 16px; color: #17324d; font-size: 22px; } .button { width: 240px; height: 56px; background: #2463b8; color: #fff; }\n',
  'project.config.json': JSON.stringify({ compileType: 'miniprogram', appid: 'touristappid', miniprogramRoot: 'dist/', srcMiniprogramRoot: '.',
    setting: { es6: true, minified: false, postcss: false, enhance: true } }, null, 2) + '\n',
  'pages/home/index.js': `Page({ data: { count: 0${cli ? ", marker: 'page-default-marker'" : ''} }, increment() { this.setData({ count: this.data.count + 1 }) } })\n`,
  'pages/home/index.json': '{}\n', 'pages/home/index.wxml': wxml('A', serverKind, renderer, contextRecovery, domQueries, fixture), 'pages/home/index.wxss': '' }
  if (domQueries) {
    files['public/browser-dev-smoke-state.js'] = "exports.browserDevSmokeQueryState = function() { var pages = getCurrentPages(); var page = pages[pages.length - 1]; return { fixture: 'browser-dev-loop-dom-queries-v1', route: page.route, count: page.data.count, marker: page.data.marker, queryStatus: page.data.queryStatus, query: page.__domQueries }; };\n"
    files['pages/home/index.js'] = `Page({
  data: { count: 0, marker: 'page-default-marker', queryStatus: 'pending' },
  onLoad() {
    this.__domQueries = { log: ['onLoad-enter'], results: [], errors: [], timerFired: false };
    var self = this;
    setTimeout(function() { self.__domQueries.timerFired = true; self.__domQueries.log.push('timer'); }, 0);
    this.measure('startup');
    this.__domQueries.log.push('onLoad-return');
  },
  increment() { this.setData({ count: this.data.count + 1 }); },
  measureTap() { this.measure('tap'); },
  measure(label) {
    var self = this;
    function current() { var pages = getCurrentPages(); return pages[pages.length - 1] === self; }
    function failed(error) {
      self.__domQueries.errors.push({ label: label, code: error.code, message: error.errMsg || error.message });
      self.setData({ queryStatus: 'failed' });
    }
    var first = wx.createSelectorQuery();
    first.select('#tap').boundingClientRect();
    first.selectViewport().scrollOffset();
    first.exec(function(values) {
      self.__domQueries.log.push(label + ':first');
      var entry = { label: label, count: self.data.count, first: values, callbackPageCurrent: current() };
      // This new builder must inherit the original synchronous callback owner.
      // No setData or layout mutation occurs between the two measurements.
      var nested = wx.createSelectorQuery();
      nested.select('#tap').boundingClientRect();
      nested.selectViewport().scrollOffset();
      nested.exec(function(second) {
        self.__domQueries.log.push(label + ':nested');
        entry.nested = second; entry.completionPageCurrent = current();
        self.__domQueries.results.push(entry);
        self.setData({ queryStatus: label + ' ' + self.__domQueries.results.length });
      }).catch(failed);
    }).catch(failed);
  }
});\n`
  }
  if (renderer === 'skia') {
    files['public/browser-dev-smoke-state.js'] = "exports.browserDevSmokeState = function() { var pages = getCurrentPages(); var page = pages[pages.length - 1]; return { fixture: 'browser-dev-loop-skia-v1', count: page.data.count, marker: page.data.marker, route: page.route }; };\n"
    files['app.wxss'] = '.page { position: relative; width: 414px; height: 736px; background-color: #ffffff; } text { position: absolute; left: 24px; color: #17324d; font-size: 22px; } #build { top: 24px; } #count { top: 64px; } #startup-marker { top: 104px; font-size: 12px; } #increment { position: absolute; left: 24px; top: 144px; width: 240px; height: 56px; background-color: #2463b8; color: #ffffff; } #feedback { position: absolute; left: 24px; top: 224px; width: 240px; height: 72px; }\n'
    if (contextRecovery) {
      files['public/browser-dev-smoke-state.js'] += "exports.browserDevSmokeDirtyTimer = function() { var pages = getCurrentPages(); var page = pages[pages.length - 1]; page.setData({ count: page.data.count + 1 }); setTimeout(function() { page.setData({ count: page.data.count + 1 }); }, 100); return 'timer-armed'; };\n"
      files['app.wxss'] += '#view-calls { top: 320px; }\n'
    }
  }
  if (fixture === 'button') Object.assign(files, buttonSmokeFiles())
  if (cli) Object.assign(files, { 'pages/decoy/index.js': 'Page({ data: { count: -1 } })\n',
    'pages/decoy/index.json': '{}\n', 'pages/decoy/index.wxml': '<view id="decoy">Wrong default route</view>\n', 'pages/decoy/index.wxss': '' })
  return { route, data, viewport, files,
    ...(fixture === 'button' ? { buttonStateQuery: { moduleId: 'module:browser-dev-button-state.js', export: 'browserDevButtonState', args: [] } } : {}),
    ...(domQueries ? { queryStateQuery: { moduleId: diagnosticModuleId, export: 'browserDevSmokeQueryState', args: [] } } : {}),
    ...(renderer === 'skia' ? {
    // weapp-vite bundles App entry exports inside a private wrapper. A public
    // asset preserves this diagnostic module's CommonJS exports byte-for-byte;
    // it still queries the live AppService realm through getCurrentPages().
    appStateQuery: { moduleId: diagnosticModuleId, export: 'browserDevSmokeState', args: [] },
    ...(contextRecovery ? { dirtyTimerQuery: { moduleId: diagnosticModuleId, export: 'browserDevSmokeDirtyTimer', args: [] } } : {}),
    canvas: { button: { x: 96, y: 172 }, feedback: { x: 100, y: 260 },
    before: [31, 75, 153, 255], after: [30, 132, 73, 255] } } : {}) }
}

/** Serialized by Playwright for both polling and the final read. This must
 * use the public owner-bound bridge and actual AppService export every time. */
export async function readSkiaSmokeState({ query, expectedCount }) {
  const app = window.weappContainerDev, ownerKey = app.status.manager.executing.ownerKey
  const response = await app.request({ ownerKey, op: 'module.call', payload: query })
  if (response?.stale || response?.result?.ok !== true || !Array.isArray(response.result.result)
    || response.result.result.length !== 1) throw new Error('Actual AppService smoke state query failed')
  const state = response.result.result[0]
  return expectedCount === undefined || state?.count === expectedCount ? state : null
}

/** Keep asynchronous RPC polling in its Node owner. A Promise is truthy to
 * Playwright's waitForFunction predicate, even when it eventually yields null.
 * Timeout/cancellation ends this wait, not the underlying RPC or its owner. */
export async function pollSmokeValue(read, ready, { label = 'actual Worker observation', timeoutMs = 15_000, intervalMs = 50, signal } = {}) {
  assert.equal(typeof read, 'function')
  assert.equal(typeof ready, 'function')
  assert.ok(typeof label === 'string' && label.length > 0 && label.length <= 256)
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 20_000)
  assert.ok(Number.isFinite(intervalMs) && intervalMs > 0 && intervalMs <= timeoutMs)
  const expires = performance.now() + timeoutMs
  const timeout = () => Object.assign(new Error(`ERR_TIMEOUT: ${label} did not arrive; actual work may remain pending`), { code: 'ERR_TIMEOUT' })
  try {
    for (;;) {
      signal?.throwIfAborted()
      const remaining = expires - performance.now()
      if (remaining <= 0) throw timeout()
      const state = await deadline(() => {
        signal?.throwIfAborted()
        if (performance.now() >= expires) throw timeout()
        return read()
      }, remaining, label, signal)
      signal?.throwIfAborted()
      if (performance.now() >= expires) throw timeout()
      const accepted = ready(state)
      assert.equal(typeof accepted, 'boolean', 'Polling readiness must be a synchronous boolean')
      if (accepted) return state
      const delay = Math.min(intervalMs, expires - performance.now())
      if (delay <= 0) throw timeout()
      await pause(delay, undefined, { signal })
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('Smoke interrupted'), { code: 'ERR_CANCELLED' })
    throw error
  }
}

export function pollSkiaSmokeCount(read, expectedCount, options) {
  assert.ok(Number.isSafeInteger(expectedCount) && expectedCount >= 0)
  return pollSmokeValue(read, state => state?.count === expectedCount, { ...options, label: `actual Worker count ${expectedCount}` })
}

/** Both DOM polling and final evidence reads serialize this same public
 * bridge operation, with the catalog query supplied as a browser argument. */
export async function readDomQuerySmokeState({ query, label, cycle }) {
  const app = window.weappContainerDev, manager = app.status.manager, owner = manager.executing.owner
  const response = await app.request({ ownerKey: manager.executing.ownerKey, op: 'module.call', payload: query })
  if (response?.stale || response?.result?.ok !== true || !Array.isArray(response.result.result)
    || response.result.result.length !== 1) throw new Error('Actual query fixture state read failed')
  const state = response.result.result[0]
  if (state?.query?.errors?.length) throw new Error(`Actual wx query failed: ${JSON.stringify(state.query.errors)}`)
  if (label !== undefined && !(state?.query?.timerFired === true && state.query.results.length === cycle
    && state.queryStatus === `${label} ${cycle}`)) return null
  const selected = window.__browserDevDomSurface.current({ owner })
  if (label !== undefined && !selected) return null
  return { state, audit: window.__browserDevSmokeAudit.read().domQueries, accepted: selected?.observation ?? null }
}

/** Serialized into the browser with its owner and optional catalog query.
 * Observe the real loss event; do not invoke adapter or recovery internals. */
export function loseSkiaSmokeContext({ dirtyQuery, ownerKey }) {
  const canvas = document.querySelector('#dev-surface [data-worker-web-session] canvas')
  const gl = canvas.getContext('webgl2'), extension = gl.getExtension('WEBGL_lose_context')
  if (!extension || gl.isContextLost()) throw new Error('WEBGL_lose_context requires a live real WebGL2 surface')
  const probe = { lost: false, inputBlocked: false, recovery: null, owner: null, dirty: null, error: null,
    contextLost: false, gpuAtLoss: null }
  window.__contextRecoverySmoke = probe
  const capture = event => {
    if (event.target !== canvas) return
    window.removeEventListener('webglcontextlost', capture, true)
    // Capture before the target adapter can drain/dispose its old GrContexts.
    // These immutable counters are the final live-surface checkpoint, not a
    // caller label claiming later synchronization was native destruction.
    probe.contextLost = gl.isContextLost()
    probe.gpuAtLoss = window.__browserDevGpuAudit.read(gl)
    if (dirtyQuery) {
      probe.dirty = 'pending'
      void window.weappContainerDev.request({ ownerKey, op: 'module.call', payload: dirtyQuery }).then(value => {
        if (value?.stale || value?.result?.ok !== true || !Array.isArray(value.result.result)
          || value.result.result.length !== 1 || value.result.result[0] !== 'timer-armed') throw new Error('Actual loss-time AppService mutation failed')
        probe.dirty = 'acknowledged'
      }).catch(error => { probe.error = { code: String(error.code ?? ''), message: String(error.message) } })
    }
  }
  // This target listener is installed after the actual adapter listener;
  // read its synchronous fence before the event dispatch can finish.
  canvas.addEventListener('webglcontextlost', () => {
    const current = window.weappContainerDev.status.manager.executing
    probe.lost = true; probe.inputBlocked = current.inputEnabled === false
    probe.recovery = current.surfaceRecovery; probe.owner = current.owner
  }, { once: true })
  window.addEventListener('webglcontextlost', capture, true)
  extension.loseContext()
}

export function serverArguments(options, project) {
  const common = ['--project', project, '--node-bin', options.nodeBin, '--out-dir', resolve(options.outDir, 'server'), '--port', '0']
  if (options.serverKind === 'example') return [...common, '--producer-dir', options.producerDir, '--pins', options.pins, '--duration-seconds', '300']
  assert.equal(options.serverKind, 'cli', 'Server kind must be example or cli')
  const fixture = smokeFixture('cli', options.renderer ?? 'webview', options.contextRecovery ?? false, options.domQueries ?? false, options.fixture ?? 'reference')
  return ['dev', '--web-runtime', 'browser', '--renderer', options.renderer ?? 'webview', '--surface', 'web', ...common,
    '--browser-runtime-dir', options.producerDir, '--browser-runtime-pins', options.pins,
    '--route', fixture.route, '--data-json', JSON.stringify(fixture.data), '--viewport', `${fixture.viewport.width}x${fixture.viewport.height}`]
}

async function createProject(project, serverKind, renderer, contextRecovery, domQueries, fixture) {
  const { files } = smokeFixture(serverKind, renderer, contextRecovery, domQueries, fixture)
  const inventory = {}
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(resolve(project, path)), { recursive: true })
    await writeFile(resolve(project, path), content, { flag: 'wx' }); inventory[path] = { bytes: Buffer.byteLength(content), sha256: hash(content) }
  }
  return inventory
}

/** Count actual page WebGL calls without replacing their result or triggering
 * a readback. Browser screenshots remain explicit out-of-page diagnostics. */
export function installGpuAudit(target = globalThis) {
  if (!target.document || target.top !== target) return
  const prototype = target.WebGL2RenderingContext?.prototype
  const counters = () => ({ finishCalls: 0, readPixelsCalls: 0, fullFrameRgbaUploads: 0 })
  const state = { installed: false, ...counters(), contexts: [], droppedContexts: 0, uploads: [], droppedUploads: 0,
    synchronizationCalls: [], droppedSynchronizationCalls: 0 }
  const contexts = new WeakMap()
  const contextState = context => {
    if (!prototype || !(context instanceof target.WebGL2RenderingContext)) return null
    let record = contexts.get(context)
    if (!record) {
      record = { contextId: state.contexts.length < 64 ? state.contexts.length + 1 : null, ...counters() }
      if (record.contextId === null) state.droppedContexts++; else state.contexts.push(record)
      contexts.set(context, record)
    }
    return record
  }
  Object.defineProperty(target, '__browserDevGpuAudit', { value: Object.freeze({ read: context => {
    const activeContext = contextState(context)
    return structuredClone({ ...state, activeContext, nonActiveContextSynchronization: activeContext === null ? null : {
      finishCalls: state.finishCalls - activeContext.finishCalls, readPixelsCalls: state.readPixelsCalls - activeContext.readPixelsCalls } })
  } }) })
  if (!prototype) return
  for (const name of ['finish', 'readPixels', 'texImage2D', 'texSubImage2D']) {
    const original = prototype[name]
    if (typeof original !== 'function') return
    Object.defineProperty(prototype, name, { configurable: true, writable: true, value: function (...args) {
      const record = contextState(this)
      if (name === 'finish') { state.finishCalls++; if (record) record.finishCalls++ }
      if (name === 'finish' || name === 'readPixels') {
        const call = { contextId: record?.contextId ?? null, method: name, stack: new Error('Observed WebGL synchronization').stack?.slice(0, 8192) ?? null }
        if (state.synchronizationCalls.length < 64) state.synchronizationCalls.push(call); else state.droppedSynchronizationCalls++
      }
      if (name === 'readPixels') { state.readPixelsCalls++; if (record) record.readPixelsCalls++ }
      if (name === 'texImage2D' || name === 'texSubImage2D') {
        const sub = name === 'texSubImage2D', width = args[sub ? 4 : 3], height = args[sub ? 5 : 4], format = args[6], pixels = args[8]
        if (args.length >= 9 && Number.isSafeInteger(width) && Number.isSafeInteger(height)
          && width === this.canvas?.width && height === this.canvas?.height && format === this.RGBA && pixels !== null && pixels !== undefined) {
          state.fullFrameRgbaUploads++; if (record) record.fullFrameRgbaUploads++
          const fact = { contextId: record?.contextId ?? null, method: name, width, height, source: ArrayBuffer.isView(pixels) ? 'typed-array' : typeof pixels }
          if (state.uploads.length < 64) state.uploads.push(fact); else state.droppedUploads++
        }
      }
      return Reflect.apply(original, this, args)
    } })
  }
  state.installed = true
}

/** Totals never reset across owner/context retirement. Even explicit teardown
 * may not hide page readbacks, full-page uploads or incomplete observations. */
export function assertGpuLifetimeAudit(value) {
  assert.equal(value?.installed, true)
  for (const key of ['readPixelsCalls', 'fullFrameRgbaUploads', 'droppedContexts', 'droppedUploads', 'droppedSynchronizationCalls'])
    assert.equal(value[key], 0, `WebGL lifetime audit used ${key}`)
  assert.ok(Array.isArray(value.contexts) && value.contexts.length > 0 && value.contexts.length <= 64)
  for (const key of ['finishCalls', 'readPixelsCalls', 'fullFrameRgbaUploads']) {
    assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0)
    assert.equal(value.contexts.reduce((total, context) => total + context[key], 0), value[key], `WebGL ${key} context attribution is incomplete`)
  }
  assert.equal(value.synchronizationCalls.length, value.finishCalls + value.readPixelsCalls)
  for (const call of value.synchronizationCalls) {
    assert.ok(value.contexts.some(context => context.contextId === call.contextId), 'Synchronization has no observed context')
    assert.ok(typeof call.stack === 'string' && call.stack.length > 0 && call.stack.length <= 8192)
  }
}

/** Every context belonging to the current accepted surface must remain
 * asynchronous for its whole lifetime, including while another buffer is front. */
export function assertGpuHotPath(value, { liveContextIds = [] } = {}) {
  assertGpuLifetimeAudit(value)
  const active = value.activeContext
  assert.ok(Number.isSafeInteger(active?.contextId) && active.contextId > 0, 'Current real canvas has no attributed WebGL context')
  assert.deepEqual(value.contexts.find(context => context.contextId === active.contextId), active)
  for (const id of new Set([active.contextId, ...liveContextIds])) {
    const context = value.contexts.find(context => context.contextId === id)
    assert.ok(context, 'Live owner context is missing from the lifetime audit')
    for (const key of ['finishCalls', 'readPixelsCalls']) assert.equal(context[key], 0, `Live WebGL context ${id} used ${key}`)
  }
  assert.deepEqual(value.nonActiveContextSynchronization, { finishCalls: value.finishCalls - active.finishCalls,
    readPixelsCalls: value.readPixelsCalls - active.readPixelsCalls })
  return value
}

/** An accepted manager proof must identify the exact local queue submission;
 * a context or HTTP receipt alone cannot pass this consumer check. */
export function assertSkiaSubmission(value, { owner, route, viewport }) {
  assert.equal(value?.phase, 'accepted')
  assert.equal(Object.hasOwn(value, 'receipt'), false, 'Legacy submission receipt shape is not the manager contract')
  const receipt = value.value, proof = value.proof, logical = { x: 0, y: 0, ...viewport }
  assert.equal(receipt?.version, '1.0'); assert.equal(receipt.status, 'submitted')
  assert.equal(receipt.backend, 'canvaskit-webgl2'); assert.deepEqual(receipt.owner, owner)
  assert.equal(proof?.version, '1.0'); assert.deepEqual(proof.owner, owner)
  for (const key of ['attemptId', 'surfaceGeneration']) assert.equal(receipt[key], proof[key])
  assert.equal(proof.publication?.kind, 'external-frame'); assert.equal(receipt.renderRevision, proof.publication.renderRevision)
  for (const value of [receipt.attemptId, receipt.surfaceGeneration, receipt.renderRevision, proof.consumedInput?.pageId, proof.consumedInput?.templateRevision])
    assert.match(value, /^[1-9][0-9]*$/, 'Positive original runtime revision required')
  assert.equal(proof.consumedInput.routePath, route); assert.deepEqual(proof.consumedInput.viewport, logical)
  assert.deepEqual(receipt.viewport, logical); assert.deepEqual(receipt.physicalSize, viewport)
  assert.ok(Number.isSafeInteger(receipt.frameId) && receipt.frameId > 0)
  assert.ok(Number.isSafeInteger(receipt.presenterGeneration) && receipt.presenterGeneration > 0)
  assert.equal(receipt.context?.api, 'webgl2'); assert.equal(receipt.context.surfaceIsGpu, true)
  assert.equal(receipt.context.contextLost, false); assert.equal(receipt.context.physicalHardware, 'unknown')
  assert.deepEqual(receipt.runtimeBoundary, { frameBatches: 1, perNodeRuntimeCalls: 0, softwareRgbaUploads: 0 })
  assert.deepEqual(receipt.presentation, { pictureSubmissions: 1, flushes: 1, gpuCompletion: 'not-waited', glError: 0 })
  return value
}

/** A final real loss-event checkpoint plus an accepted publication/native ACK
 * retire a former surface, even when recovery keeps the Worker/session owner.
 * Context counters and the complete-run audit remain immutable across this
 * transition; a reused old context retains its old facts. Post-loss finish
 * calls remain raw synchronization observations, not presumed disposal. */
export function createGpuSurfaceLifetimeTracker() {
  const owners = new Map()
  const ownerKey = owner => JSON.stringify([owner?.workerEpoch, owner?.sessionId, owner?.packSha256, owner?.transportBackend])
  return Object.freeze({ recordLoss(loss) {
    const prior = owners.get(ownerKey(loss?.owner)), lossId = loss?.recovery?.lossId
    assert.ok(prior, 'Actual loss requires a previously checked live owner')
    assert.equal(loss?.lost, true); assert.equal(loss.inputBlocked, true); assert.equal(loss.contextLost, true)
    assert.equal(loss.recovery?.version, '1.0'); assert.match(lossId, /^[1-9][0-9]*$/)
    assert.ok(!prior.lastLossId || BigInt(lossId) > BigInt(prior.lastLossId), 'Stale GPU surface loss')
    assert.equal(prior.pendingLoss, null, 'GPU surface loss already awaits a new accepted generation')
    assert.ok(prior.liveContextIds.has(loss.gpuAtLoss?.activeContext?.contextId), 'Loss canvas is not part of the checked live surface')
    assertGpuHotPath(loss.gpuAtLoss, { liveContextIds: prior.liveContextIds })
    prior.pendingLoss = lossId
    return { lossId, surfaceGeneration: prior.surfaceGeneration, liveContextIds: [...prior.liveContextIds] }
  }, observe({ owner, submission, acknowledgement, gpu }, { route, viewport }) {
    assertSkiaSubmission(submission, { owner, route, viewport })
    const receipt = submission.value, ack = acknowledgement
    assert.equal(ack?.direction, 'receive'); assert.equal(ack?.op, 'ack')
    assert.equal(ack.workerEpoch, owner.workerEpoch); assert.equal(ack.sessionId, owner.sessionId)
    assert.deepEqual(ack.acknowledgement, { version: '1.0', sessionId: owner.sessionId,
      renderRevision: receipt.renderRevision, acknowledged: true, inputEnabled: true, requiresRestart: false })
    assert.equal(ack.runtimeState?.surfaceGeneration, receipt.surfaceGeneration)
    assert.equal(ack.runtimeState?.renderRevision, receipt.renderRevision)
    const key = ownerKey(owner)
    const prior = owners.get(key), generation = receipt.surfaceGeneration
    assert.ok(!prior || BigInt(generation) >= BigInt(prior.surfaceGeneration), 'Stale accepted surface generation')
    const sameSurface = prior?.surfaceGeneration === generation
    if (prior && !sameSurface) assert.ok(prior.pendingLoss, 'New same-owner surface generation requires an actual checked context loss')
    if (sameSurface) assert.equal(prior.pendingLoss, null, 'Lost surface cannot resume under its old generation')
    const liveContextIds = sameSurface ? new Set(prior.liveContextIds) : new Set()
    const retiredContextIds = prior && !sameSurface ? [...prior.liveContextIds] : []
    if (Number.isSafeInteger(gpu.activeContext?.contextId)) liveContextIds.add(gpu.activeContext.contextId)
    assertGpuHotPath(gpu, { liveContextIds })
    assert.ok(owners.has(key) || owners.size < 64, 'Accepted GPU owner audit exceeded its finite budget')
    owners.set(key, { surfaceGeneration: generation, liveContextIds, pendingLoss: null,
      lastLossId: prior?.pendingLoss ?? prior?.lastLossId ?? null })
    return { surfaceGeneration: generation, liveContextIds: [...liveContextIds],
      retiredSurfaceGeneration: retiredContextIds.length ? prior.surfaceGeneration : null, retiredContextIds,
      retirementLossId: prior && !sameSurface ? prior.pendingLoss : null }
  } })
}

/** Reconstruct the two independent native watermarks from original messages.
 * G is acknowledged input geometry; M is a successful query measurement. A
 * query requests max(G, M), never G alone. This is wire evidence, not a native
 * getter for the runtime's private input geometry state. */
export function assertDomQueryWatermarks(wire, requests, viewport) {
  const sameKey = (a, b) => record(a) && record(b) && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(name => a[name] === b[name])
  const epoch = value => {
    assert.ok(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && value.length <= 20)
    const parsed = BigInt(value); assert.ok(parsed <= 18446744073709551615n); return parsed
  }
  let sequence = -1
  const batchIndices = new Map()
  for (const fact of wire) {
    assert.ok(Number.isSafeInteger(fact.sequence) && fact.sequence > sequence, 'Original query wire order is incomplete or ambiguous')
    assert.ok(Number.isSafeInteger(fact.messageIndex) && fact.messageIndex >= 0 && typeof fact.outerRequestId === 'string' && fact.outerRequestId)
    const batch = `${fact.direction}:${fact.outerRequestId}`, previousIndex = batchIndices.get(batch)
    assert.ok(previousIndex === undefined || fact.messageIndex > previousIndex, 'Original native batch message order is incomplete or ambiguous')
    batchIndices.set(batch, fact.messageIndex)
    sequence = fact.sequence
  }
  const sent = (op, predicate = () => true) => wire.filter(fact => fact.direction === 'send'
    && fact.message.kind === 'request' && fact.message.op === op && predicate(fact))
  const finalFor = request => {
    const finals = wire.filter(fact => fact.direction === 'receive' && fact.message.kind === 'response'
      && fact.message.op === request.message.op && fact.message.requestId === request.message.requestId)
    assert.equal(finals.length, 1, 'An admission/measurement requires its unique original native final')
    const final = finals[0]
    assert.ok(final.sequence > request.sequence && final.id === request.id && final.message.payload.ok === true
      && final.message.payload.queued !== true, 'An admission/measurement did not complete successfully')
    assert.ok(final.outerRequestId === request.outerRequestId && final.outerOp === 'bridge'
      && final.outerStatus === 'ok', 'Native final does not belong to the original atomic Worker bridge turn')
    return final
  }
  const beforeRequest = (final, request) => final.sequence < request.sequence
    // A callback may issue the nested event inside the same atomic native
    // result turn, before its final is delivered. Require that original turn,
    // rather than treating unrelated later success as prior acceptance.
    || Boolean(final.outerRequestId && final.outerRequestId === request.outerRequestId
      && final.outerOp === request.outerOp && ['bridge', 'batch'].includes(final.outerOp)
    )
  const geometry = (value, key) => {
    assert.equal(value?.version, '1.0'); assert.ok(sameKey(value.key, key)); epoch(value.epoch)
    assert.deepEqual(value.viewport, viewport); assert.ok(Array.isArray(value.nodes) && value.nodes.length > 0)
    return value
  }
  const transactions = requests.map(request => {
    const matches = sent('view.query.result', fact => fact.message.payload.requestId === request.message.payload.requestId)
    assert.equal(matches.length, 1, 'A query requires exactly one original browser result')
    const sample = matches[0], final = finalFor(sample)
    assert.ok(sample.sequence > request.sequence && sameKey(sample.message.payload.key, request.message.payload.key))
    assert.equal(final.message.payload.requestId, request.message.payload.requestId)
    return { request, sample, final, geometry: geometry(sample.message.payload.geometry, request.message.payload.key) }
  })
  const inputFor = transaction => {
    const { request, sample } = transaction, key = request.message.payload.key
    const presentations = sent('view.presented', fact => fact.sequence < request.sequence && sameKey(fact.message.payload.key, key))
    assert.ok(presentations.length, 'Query input has no original presentation permit request')
    const presentation = presentations.at(-1), acknowledgement = finalFor(presentation), permit = presentation.message.payload
    assert.equal(permit.version, '1.0'); epoch(permit.epoch); assert.ok(typeof permit.permitId === 'string' && permit.permitId.length > 0)
    assert.ok(acknowledgement.message.payload.inputEnabled === true && sameKey(acknowledgement.message.payload.key, key)
      && beforeRequest(acknowledgement, request) && acknowledgement.sequence < sample.sequence,
    'Input geometry has no enabled native presentation ACK in or before the original query turn')
    const preparations = sent('view.prepare.commit', fact => fact.sequence < presentation.sequence && sameKey(fact.message.payload.key, key))
    assert.ok(preparations.length, 'Input geometry has no original prepare/commit request')
    const preparation = preparations.at(-1), prepared = finalFor(preparation)
    assert.ok(prepared.sequence < presentation.sequence, 'A presentation cannot use a permit before its native final')
    assert.deepEqual(prepared.message.payload.permit, permit, 'Presented permit differs from the exact native prepare/commit final')
    let admitted = geometry(preparation.message.payload, key)
    assert.equal(admitted.epoch, permit.epoch)
    const updates = sent('view.geometry', fact => fact.sequence > presentation.sequence && fact.sequence < request.sequence)
    for (const update of updates) {
      assert.ok(sameKey(update.message.payload.key, key), 'Input admission crossed the current query key')
      const final = finalFor(update)
      assert.ok(beforeRequest(final, request), 'Input geometry completion is ambiguous at query scheduling')
      const next = geometry(update.message.payload, key)
      assert.ok(epoch(next.epoch) >= epoch(admitted.epoch), 'Input geometry epoch regressed')
      if (next.epoch === admitted.epoch) assert.deepEqual(next, admitted, 'Same-epoch input replay changed geometry')
      admitted = next
    }
    return { admitted, preparation, prepared, presentation, acknowledgement }
  }
  const watermarks = transactions.map(transaction => {
    const input = inputFor(transaction), key = transaction.request.message.payload.key
    let measurement = 0n
    for (const prior of transactions) if (prior !== transaction && prior.sample.sequence < transaction.request.sequence
      && sameKey(prior.request.message.payload.key, key) && beforeRequest(prior.final, transaction.request)) {
      const observed = epoch(prior.geometry.epoch); if (observed > measurement) measurement = observed
    }
    const inputEpoch = epoch(input.admitted.epoch), after = inputEpoch > measurement ? inputEpoch : measurement
    assert.equal(transaction.request.message.payload.afterEpoch, String(after), 'Query afterEpoch must equal max(acknowledged input geometry, successful measurement watermark)')
    assert.ok(epoch(transaction.geometry.epoch) > after, 'Query sample is not newer than its exact native watermark')
    return { ...transaction, input, measurement }
  })
  const pair = watermarks.slice(-2), [first, second] = pair
  assert.equal(pair.length, 2); assert.ok(sameKey(first.request.message.payload.key, second.request.message.payload.key))
  assert.ok(beforeRequest(first.final, second.request), 'Nested query has no prior successful original native result turn')
  assert.deepEqual(second.input.admitted, first.input.admitted, 'Input geometry changed between query requests')
  const replays = sent('view.geometry', fact => fact.sequence > first.request.sequence && fact.sequence < second.final.sequence)
  for (const replay of replays) {
    assert.deepEqual(replay.message.payload, first.input.admitted, 'Query interval contains changed input geometry')
    assert.ok(finalFor(replay).sequence < second.final.sequence, 'Query input replay has no completed native final in the interval')
  }
  assert.equal(wire.some(fact => fact.sequence > first.request.sequence && fact.sequence < second.final.sequence
    && fact.message.op === 'view.presented' && !sameKey(fact.message.payload.key, first.request.message.payload.key)), false,
  'Query interval crossed a presentation boundary')
  return { inputGeometryWireStable: true, inputGeometry: first.input,
    idempotentInputReplays: replays, measurementWatermarks: pair.map(value => ({
      requestId: value.request.message.payload.requestId, inputEpoch: value.input.admitted.epoch,
      previousMeasurementEpoch: String(value.measurement), afterEpoch: value.request.message.payload.afterEpoch,
      measuredEpoch: value.geometry.epoch, nativeFinalRequestId: value.final.message.requestId,
    })) }
}

/** Persist the unverified original observation before any consumer assertion.
 * An invalid observation remains evidence of failure, never a success proof. */
export async function captureAndAssertDomQueryEvidence(value, expected, save) {
  await save({ schemaVersion: 1, kind: 'unverified-dom-query-observation', expected, observed: value })
  if (expected.marker !== undefined) assert.equal(value.state.marker, expected.marker)
  return assertDomQueryEvidence(value, expected)
}

/** Compare actual wx callbacks and their native wire with an independent DOM
 * observation. This consumer never supplies a query result to the runtime. */
export function assertDomQueryEvidence(value, { owner, route, viewport, label, cycle, expectedCount }) {
  const { audit, state, oracle, accepted } = value
  assert.equal(audit?.version, '1.0'); assert.equal(audit.dropped, 0)
  assert.ok(audit.retainedBytes <= 2 * 1024 * 1024 && audit.wire.length <= 512)
  assert.equal(state?.fixture, 'browser-dev-loop-dom-queries-v1'); assert.equal(state.route, route)
  assert.equal(state.count, expectedCount); assert.equal(state.queryStatus, `${label} ${cycle}`)
  assert.deepEqual(state.query.errors, []); assert.equal(state.query.timerFired, true)
  assert.equal(state.query.results.length, cycle)
  const result = state.query.results.at(-1), log = state.query.log
  assert.equal(result.label, label); assert.equal(result.count, expectedCount)
  assert.equal(result.callbackPageCurrent, true); assert.equal(result.completionPageCurrent, true)
  assert.ok(log.indexOf('onLoad-return') > log.indexOf('onLoad-enter'))
  assert.ok(log.indexOf('startup:first') > log.indexOf('onLoad-return'), 'onLoad must return before its asynchronous query callback')
  assert.equal(log.filter(value => value === `${label}:first`).length, 1)
  assert.equal(log.filter(value => value === `${label}:nested`).length, 1)
  assert.ok(log.indexOf(`${label}:nested`) > log.indexOf(`${label}:first`))
  const wire = audit.wire.filter(value => value.workerEpoch === owner.workerEpoch && value.sessionId === owner.sessionId)
  for (const fact of wire) {
    assert.equal(fact.message.protocolVersion, '1.0'); assert.equal(fact.message.sessionId, owner.sessionId)
  }
  const sameKey = (a, b) => record(a) && record(b) && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(name => a[name] === b[name])
  assert.ok(wire.some(value => value.direction === 'receive' && value.message.op === 'view.query.enable'
    && value.message.kind === 'response' && value.message.payload.ok === true && value.message.payload.version === '1.0'
    && value.message.payload.scope === 'session' && value.message.payload.enabled === true && value.message.payload.key === null), 'No actual native session query enable final')
  const unique = new Map()
  for (const fact of wire.filter(value => value.direction === 'receive' && value.message.op === 'view.query.request' && value.message.kind === 'event')) {
    const request = fact.message.payload
    assert.match(request.requestId, /^dom-query:[1-9][0-9]*$/)
    if (unique.has(request.requestId)) assert.deepEqual(request, unique.get(request.requestId).message.payload, 'Conflicting query event replay')
    else unique.set(request.requestId, fact)
  }
  assert.equal(unique.size, cycle * 2, 'Each lifecycle/tap cycle must execute exactly two real queries')
  const pair = [...unique.values()].slice(-2), exchanges = []
  assert.equal(pair.length, 2)
  for (const [index, requestFact] of pair.entries()) {
    const request = requestFact.message.payload
    assert.equal(request.version, '1.0'); assert.equal(request.key.sessionId, owner.sessionId); assert.equal(request.key.profile, 'webview')
    assert.ok(Array.isArray(request.occurrenceIds) && request.occurrenceIds.length === 1)
    assert.match(request.afterEpoch, /^(0|[1-9][0-9]*)$/); assert.match(request.deadlineNs, /^[1-9][0-9]*$/)
    const sent = wire.filter(value => value.direction === 'send' && value.message.op === 'view.query.result'
      && value.message.payload.requestId === request.requestId)
    assert.equal(sent.length, 1, 'Missing or repeated real browser query result')
    const observation = sent[0].message.payload, geometry = observation.geometry
    assert.equal(observation.version, '1.0'); assert.equal(observation.error, undefined)
    assert.ok(sameKey(observation.key, request.key) && sameKey(geometry?.key, request.key))
    assert.ok(BigInt(geometry.epoch) > BigInt(request.afterEpoch)); assert.ok(sent[0].sequence > requestFact.sequence)
    // BrowserGeometryBatch carries a ViewViewport (size only). The consumed
    // page input below remains a Rect and must independently preserve origin.
    assert.deepEqual(geometry.viewport, viewport)
    const ack = wire.find(value => value.direction === 'receive' && value.message.op === 'view.presented'
      && value.message.kind === 'response' && value.message.payload.ok === true && value.message.payload.inputEnabled === true
      && sameKey(value.message.payload.key, request.key) && value.sequence < sent[0].sequence)
    assert.ok(ack, 'Query must use an actual acknowledged browser presentation')
    const final = wire.find(value => value.direction === 'receive' && value.message.op === 'view.query.result'
      && value.message.kind === 'response' && value.message.requestId === sent[0].message.requestId
      && value.message.payload.ok === true && value.message.payload.requestId === request.requestId && value.sequence > sent[0].sequence)
    assert.ok(final, 'No exact successful native query result final')
    const node = geometry.nodes.find(value => value.occurrenceId === request.occurrenceIds[0])
    assert.ok(node, 'Native match is absent from the actual browser geometry')
    const callback = index === 0 ? result.first : result.nested
    assert.ok(Array.isArray(callback) && callback.length === 2)
    for (const [name, observed] of Object.entries({ left: node.borderBox.x, top: node.borderBox.y, width: node.borderBox.width, height: node.borderBox.height })) {
      assert.ok(Number.isFinite(callback[0]?.[name]) && Math.abs(callback[0][name] - observed) <= 0.5, `wx ${name} differs from real query wire`)
      assert.ok(Math.abs(callback[0][name] - oracle.rect[name]) <= 0.5, `wx ${name} differs from actual DOM oracle`)
    }
    assert.equal(callback[0].id, 'tap')
    assert.equal(request.includeViewportExtent, true, 'Native must explicitly request the additive viewport extent field')
    assert.deepEqual(callback[1], { id: '', dataset: {}, scrollLeft: observation.viewportScroll.x, scrollTop: observation.viewportScroll.y,
      scrollWidth: observation.viewportExtent?.width, scrollHeight: observation.viewportExtent?.height })
    assert.deepEqual(callback[1], { id: '', dataset: {}, scrollLeft: oracle.scroll.x, scrollTop: oracle.scroll.y,
      scrollWidth: oracle.extent?.width, scrollHeight: oracle.extent?.height })
    assert.ok(['width', 'height'].every(field => Number.isFinite(observation.viewportExtent?.[field]) && observation.viewportExtent[field] >= 0), 'Missing real browser viewport content extent')
    exchanges.push({ request: requestFact, observation: sent[0], nativeFinal: final, presentationAck: ack })
  }
  const [first, second] = exchanges
  assert.ok(sameKey(first.request.message.payload.key, second.request.message.payload.key))
  const watermarkProof = assertDomQueryWatermarks(wire, [...unique.values()], viewport)
  assert.ok(BigInt(second.observation.message.payload.geometry.epoch) > BigInt(first.observation.message.payload.geometry.epoch))
  // The first native result turn may publish its nested request in the same
  // final batch. Its receive order is not an application continuation clock.
  assert.ok(first.observation.sequence < second.request.sequence, 'Nested query must originate after delivery of the first actual browser result')
  assert.equal(accepted?.kind, 'observed-dom-final')
  const callback = accepted.value
  assert.deepEqual(callback.owner, owner)
  assert.equal(callback.consumedInput.routePath, route); assert.deepEqual(callback.consumedInput.viewport, { x: 0, y: 0, ...viewport })
  for (const name of ['sessionId', 'pageId', 'profile', 'surfaceGeneration'])
    assert.equal(callback.key[name], first.request.message.payload.key[name], 'Callback accepted document crossed the query owner/surface')
  assert.equal(callback.consumedInput.pageId, callback.key.pageId)
  assert.ok(BigInt(callback.key.documentRevision) > BigInt(first.request.message.payload.key.documentRevision), 'Query callback setData did not reach a subsequent accepted document')
  const callbackPreparation = wire.find(value => value.direction === 'receive' && value.message.op === 'view.prepare'
    && value.message.kind === 'response' && value.message.payload.ok === true && value.message.requestId === callback.nativePreparation.requestId
    && sameKey(value.message.payload.key, callback.key) && sameKey(value.message.payload.scheduling.key, callback.key))
  assert.ok(callbackPreparation, 'Callback document has no original key-bound native preparation')
  assert.equal(callbackPreparation.message.payload.scheduling.version, '1.0')
  assert.deepEqual(callbackPreparation.message.payload.scheduling.consumedInput, callback.consumedInput)
  const callbackAck = wire.find(value => value.direction === 'receive' && value.message.op === 'view.presented'
    && value.message.kind === 'response' && value.message.payload.ok === true && value.message.payload.inputEnabled === true
    && value.message.requestId === callback.nativeFinal.requestId && sameKey(value.message.payload.key, callback.key)
    && value.sequence > callbackPreparation.sequence && value.sequence > second.nativeFinal.sequence)
  assert.ok(callbackAck, 'Callback document lacks a newer original successful presentation ACK')

  if (oracle.perturbation) {
    assert.equal(label, 'tap'); assert.equal(oracle.perturbation.translateX, 13)
    assert.ok(Math.abs(oracle.rect.left - oracle.perturbation.before.left - 13) <= 0.5)
    assert.ok(sameKey(oracle.perturbation.key, first.request.message.payload.key), 'Freshness perturbation crossed a presentation boundary')
    const request = first.request.message.payload
    const cachedNode = watermarkProof.inputGeometry.admitted.nodes.find(value => value.occurrenceId === request.occurrenceIds[0])
    assert.ok(cachedNode && Math.abs(cachedNode.borderBox.x - oracle.perturbation.before.left) <= 0.5, 'Missing unchanged admitted pre-perturbation geometry')
    assert.ok(Math.abs(first.observation.message.payload.geometry.nodes.find(value => value.occurrenceId === request.occurrenceIds[0]).borderBox.x - cachedNode.borderBox.x - 13) <= 0.5,
      'Query must sample a same-key browser transform absent from admitted input geometry')
  }
  return { label, cycle, owner, state, oracle, exchanges, callbackAccepted: accepted,
    ...watermarkProof, source: 'actual wx calls, native bridge finals and independently observed browser DOM; input geometry stability is reconstructed from original wire' }
}

/** Observational wrapper around the actual native Worker, never a fake.
 * Retain protocol and fixed runtime route/geometry metadata only; never
 * application message data, bootstrap bytes or credentials. */
/** Uses the observed retained AppService result; Worker lifetime counts stay
 * in the independent Worker constructor/terminate audit. */
export function retainedCompileFailureCount(observed, expectedCount) {
  assert.equal(observed?.fixture, 'browser-dev-loop-skia-v1')
  assert.ok(Number.isSafeInteger(observed.count) && observed.count >= 0)
  assert.equal(observed.count, expectedCount)
  return { retainedAppCount: observed.count }
}

export function installWorkerAudit({ domQueries = false } = {}) {
  if (globalThis !== globalThis.top) return
  const NativeWorker = globalThis.Worker, events = [], traces = [], workers = new WeakMap()
  const queryWire = [], queryOps = new Set(['view.query.enable', 'view.query.request', 'view.query.result', 'view.prepare', 'view.prepare.commit', 'view.presented', 'view.geometry', 'view.events'])
  let sequence = 0, serial = 0, droppedEvents = 0, droppedTraces = 0, frameMessages = 0, fullFramePixelTransfers = 0, incompleteFrameInspections = 0, queryBytes = 0, droppedQueries = 0
  const text = value => typeof value === 'string' ? value.slice(0, 4096) : null
  const presentationKey = value => Object.fromEntries(['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile']
    .map(field => [field, text(value?.[field])]))
  const permitMetadata = value => value && { version: text(value.version), key: presentationKey(value.key), epoch: text(value.epoch), permitId: text(value.permitId) }
  const preparation = (message, messageIndex = 0) => {
    if (message?.op !== 'view.prepare' || message.kind !== 'response' || message.payload?.ok !== true
      || message.payload.queued === true || message.payload.submission?.key?.profile !== 'webview') return null
    const source = message.payload.scheduling, input = source?.consumedInput
    const key = value => Object.fromEntries(['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile']
      .map(field => [field, text(value?.[field])]))
    return { requestId: text(message.requestId), messageIndex, key: key(message.payload.submission.key), scheduling: {
      version: text(source?.version), key: key(source?.key), consumedInput: input && {
        pageId: text(input.pageId), routePath: text(input.routePath), templateRevision: text(input.templateRevision),
        viewport: input.viewport && Object.fromEntries(['x', 'y', 'width', 'height'].map(field => [field, Number.isFinite(input.viewport[field]) ? input.viewport[field] : null])) } } }
  }
  const event = value => { if (events.length < 256) events.push({ sequence: ++sequence, at: performance.now(), ...value }); else droppedEvents++ }
  const trace = (id, direction, value) => {
    if (!value || typeof value !== 'object') return
    if (traces.length >= 8192) { droppedTraces++; return }
    const batch = value.op === 'batch' && Array.isArray(value.payload?.messages) ? value.payload.messages : []
    if (domQueries) {
      const messages = direction === 'send' && value.op === 'bridge'
        ? value.payload?.envelope ? [value.payload.envelope] : value.payload?.batch?.messages ?? []
        : value.op === 'batch' ? batch : value.payload?.result?.messages ?? []
      for (const [messageIndex, message] of messages.entries()) {
        if (!queryOps.has(message?.op)) continue
        try {
          const original = message.payload, prepared = preparation(message), payload = prepared ? { ok: true, ...prepared } : message.op.startsWith('view.query.')
            || message.kind === 'request' && ['view.prepare.commit', 'view.geometry'].includes(message.op) ? structuredClone(original)
            : message.op === 'view.presented' && message.kind === 'request' ? permitMetadata(original)
            : { ...Object.fromEntries(['key', 'epoch', 'inputEnabled', 'ok'].filter(key => original?.[key] !== undefined).map(key => [key, structuredClone(original[key])])),
              ...(message.op === 'view.prepare.commit' && original?.permit ? { permit: permitMetadata(original.permit) } : {}),
              ...(original?.error ? { error: { code: text(original.error.code), message: text(original.error.message) } } : {}) }
          const fact = { sequence: ++sequence, messageIndex, id, direction, at: performance.now(), workerEpoch: text(value.workerEpoch), sessionId: text(value.sessionId),
            outerRequestId: text(value.requestId), outerOp: text(value.op), outerStatus: text(value.payload?.status),
            message: { protocolVersion: text(message.protocolVersion), sessionId: text(message.sessionId), requestId: text(message.requestId),
              kind: text(message.kind), op: text(message.op), payload } }
          const bytes = new TextEncoder().encode(JSON.stringify(fact)).length
          if (queryWire.length >= 512 || bytes > 256 * 1024 || queryBytes + bytes > 2 * 1024 * 1024) { droppedQueries++; continue }
          queryBytes += bytes; queryWire.push(fact)
        } catch { droppedQueries++ }
      }
    }
    const domBatch = value.op === 'bridge' && Array.isArray(value.payload?.result?.messages) ? value.payload.result.messages : batch
    const domPresentations = domBatch.flatMap((message, messageIndex) => message?.op === 'view.presented' && message.kind === 'response'
      && message.payload?.ok === true && message.payload.queued !== true && message.payload.key?.profile === 'webview'
      ? [{ requestId: text(message.requestId), messageIndex, inputEnabled: message.payload.inputEnabled === true,
        key: Object.fromEntries(['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile']
          .map(key => [key, text(message.payload.key[key])])) }] : [])
    const observation = value.payload?.result?.observation ?? value.payload?.observation
    const state = observation?.state
    const runtimeState = state && typeof state === 'object' ? { currentPage: state.currentPage ? {
      pageId: text(state.currentPage.pageId), path: text(state.currentPage.path) } : null,
    viewport: state.viewport && typeof state.viewport === 'object' ? Object.fromEntries(['x', 'y', 'width', 'height']
      .map(key => [key, Number.isFinite(state.viewport[key]) ? state.viewport[key] : null])) : null,
    lifecycle: text(state.lifecycle), rendererProfile: text(state.rendererProfile), declaredRendererProfile: text(state.declaredRendererProfile),
    ...Object.fromEntries(['surfaceGeneration', 'inputLifetimeRevision', 'templateRevision', 'renderRevision'].map(key => [key, text(state[key])])) } : null
    const result = value.payload?.result, frame = result?.frame
    let frameMetadata = null
    if (frame && typeof frame === 'object') {
      frameMessages++
      const minimum = Number(frame.viewport?.width) * Number(frame.viewport?.height) * 4
      const pending = [{ value: result, depth: 0 }], seen = new Set(), fixtureText = []
      let visited = 0, pixelBuffers = 0
      while (pending.length && visited++ < 4096) {
        const entry = pending.pop(), item = entry.value
        if (!item || typeof item !== 'object' || seen.has(item)) continue
        seen.add(item)
        if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
          if (minimum > 0 && item.byteLength >= minimum) pixelBuffers++
          continue
        }
        if (Array.isArray(item) && minimum > 0 && item.length >= minimum
          && item.slice(0, 16).every(value => typeof value === 'number')) { pixelBuffers++; continue }
        if (typeof item.text === 'string' && /^(?:Build (?:A|B(?:[2-9]|1[0-6])?)|Count: [0-9]+|View calls: [0-9]+|cli-startup-data-observed)$/.test(item.text)
          && fixtureText.length < 32) fixtureText.push(item.text)
        if (entry.depth >= 32) { incompleteFrameInspections++; continue }
        for (const value of Object.values(item)) if (value && typeof value === 'object') pending.push({ value, depth: entry.depth + 1 })
      }
      if (pending.length) incompleteFrameInspections++
      fullFramePixelTransfers += pixelBuffers
      frameMetadata = { frameId: frame.frame_id, renderRevision: text(result.renderRevision), fixtureText, pixelBuffers }
    }
    traces.push({ id, direction, at: performance.now(), version: text(value.version), workerEpoch: text(value.workerEpoch), sessionId: text(value.sessionId),
      requestId: text(value.requestId), kind: text(value.kind), op: text(value.op), status: text(value.payload?.status),
      runtimeState, frame: frameMetadata, domPresentations, domPreparations: domBatch.map(preparation).filter(Boolean),
      recovery: result?.recovery ? Object.fromEntries(['version', 'kind', 'sessionId', 'previousRenderRevision', 'renderRevision',
        'previousInputLifetimeRevision', 'inputLifetimeRevision'].map(key => [key, text(result.recovery[key])])) : null,
      acknowledgement: value.op === 'ack' ? direction === 'send' ? { requestedRevision: text(value.payload?.renderRevision) }
        : result && { version: text(result.version), sessionId: text(result.sessionId), renderRevision: text(result.renderRevision),
          acknowledged: result.acknowledged === true, inputEnabled: result.inputEnabled === true, requiresRestart: result.requiresRestart === true } : null,
      messages: batch.slice(0, 256).map(message => ({ op: text(message?.op), kind: text(message?.kind),
        sessionId: text(message?.sessionId), ok: typeof message?.payload?.ok === 'boolean' ? message.payload.ok : null })) })
  }
  let AuditedWorker
  AuditedWorker = new Proxy(NativeWorker, { construct(target, args, newTarget) {
    const id = `worker-${++serial}`, url = text(String(args[0])), name = text(args[1]?.name)
    const worker = Reflect.construct(target, args, newTarget === AuditedWorker ? target : newTarget)
    workers.set(worker, id); event({ kind: 'construct', id, url, name })
    worker.addEventListener('message', message => trace(id, 'receive', message.data))
    return worker
  } })
  const terminate = NativeWorker.prototype.terminate, postMessage = NativeWorker.prototype.postMessage
  Object.defineProperty(NativeWorker.prototype, 'terminate', { configurable: true, writable: true,
    value: function (...args) { const result = Reflect.apply(terminate, this, args); event({ kind: 'terminate', id: workers.get(this) ?? 'unobserved' }); return result } })
  Object.defineProperty(NativeWorker.prototype, 'postMessage', { configurable: true, writable: true,
    value: function (...args) { const result = Reflect.apply(postMessage, this, args); trace(workers.get(this) ?? 'unobserved', 'send', args[0]); return result } })
  globalThis.Worker = AuditedWorker
  Object.defineProperty(globalThis, '__browserDevSmokeAudit', { value: Object.freeze({ read: () => structuredClone({ events, traces, droppedEvents, droppedTraces,
    frameMessages, fullFramePixelTransfers, incompleteFrameInspections,
    ...(domQueries ? { domQueries: { version: '1.0', wire: queryWire, retainedBytes: queryBytes, dropped: droppedQueries,
      limits: { messages: 512, messageBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024 } } } : {}) }) }) })
}

function boundedLog() {
  let text = '', used = 0, received = 0, dropped = 0
  return { append(line) { const clean = scrub(line), size = Buffer.byteLength(clean); received += size
    if (size <= LIMITS.log - used) { text += clean; used += size } else dropped += size },
  value: () => ({ text, retainedBytes: used, receivedBytes: received, droppedBytes: dropped }) }
}

function spawnServer(options, project, producer, onFailure) {
  const args = serverArguments(options, project)
  const child = spawn(options.serverBin, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  const listening = deferred(), exited = deferred(), stdout = boundedLog(), stderr = boundedLog(), events = []
  let exit = null, pending = '', errorPending = '', overflow = false, expectedExit = false, originalSummaryPath = null, originalRunId = null
  const fail = error => { onFailure(error); listening.reject(error) }
  child.on('error', error => { fail(error); exit = { code: null, signal: null, spawnError: failure(error) }; exited.resolve(exit) })
  child.on('close', (code, signal) => { exit = { code, signal }; exited.resolve(exit)
    if (!expectedExit) fail(new Error(`Original server exited before the explicit smoke Stop: ${code}/${signal}`))
    if (!events.some(event => event.event === 'listening')) listening.reject(new Error(`Original server exited before listening: ${code}/${signal}`)) })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    if (overflow) return
    pending += chunk
    if (Buffer.byteLength(pending) > LIMITS.line) { overflow = true; pending = ''; fail(new Error('Server stdout line exceeded its finite capture budget')); return }
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1)
      // Redact whole bounded lines, including labels split across pipe chunks.
      stdout.append(line + '\n')
      if (stdout.value().droppedBytes) { overflow = true; fail(new Error('Server stdout exceeded its finite capture budget')); return }
      if (!line.trim().startsWith('{')) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (!['listening', 'staged', 'shutdown'].includes(event.event)) continue
      if (events.length >= LIMITS.serverEvents) { fail(new Error('Server event count exceeded its finite budget')); return }
      // Current server output has no credential projection. Fail closed rather
      // than retain a newly added secret-bearing event in the evidence JSON.
      if (/"(?:secret|x-weapp-dev-secret)"\s*:/i.test(line)) { fail(new Error('Server unexpectedly projected a control credential')); return }
      events.push(event)
      if (event.event === 'listening') {
        try {
          assert.equal(events.filter(value => value.event === 'listening').length, 1)
          const url = new URL(event.url)
          assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash)
          assert.equal(event.runtimeLocation, 'browser'); assert.equal(event.engine, 'quickjs'); assert.equal(event.renderer, options.renderer); assert.equal(event.gpuClaimed, false)
          const summaryPath = validatedSummaryPath(options, event)
          assert.equal(event.producer?.pinsSha256, producer.pinsSha256); assert.equal(event.producer?.reportSha256, producer.reportSha256)
          assert.equal(event.producer?.sourceCommit, producer.expected.sourceCommit); assert.equal(event.producer?.sourceSha256, producer.expected.sourceSha256)
          originalSummaryPath = summaryPath; originalRunId = event.runId
          listening.resolve(event)
        } catch (error) { fail(error) }
      }
    }
  })
  child.stdout.on('end', () => { if (pending) stdout.append(pending); pending = '' })
  child.stderr.on('data', chunk => {
    errorPending += chunk
    if (Buffer.byteLength(errorPending) > LIMITS.line) { errorPending = ''; fail(new Error('Server stderr line exceeded its finite capture budget')); return }
    let end
    while ((end = errorPending.indexOf('\n')) >= 0) {
      stderr.append(errorPending.slice(0, end + 1)); errorPending = errorPending.slice(end + 1)
      if (stderr.value().droppedBytes) fail(new Error('Server stderr exceeded its finite capture budget'))
    }
  })
  child.stderr.on('end', () => { if (errorPending) stderr.append(errorPending); errorPending = '' })
  return { child, args, listening: listening.promise, exited: exited.promise, get exit() { return exit },
    get summaryPath() { return originalSummaryPath }, get runId() { return originalRunId }, expectExit() { expectedExit = true }, events, stdout, stderr }
}

export async function runBrowserDevLoop(input) {
  const options = parseArgs(Object.entries(input).flatMap(([key, value]) => [({ serverBin: '--server-bin', producerDir: '--producer-dir',
    pins: '--pins', outDir: '--out-dir', nodeBin: '--node-bin', reloads: '--reloads', serverKind: '--server-kind', renderer: '--renderer',
    contextRecovery: '--context-recovery', domQueries: '--dom-queries', fixture: '--fixture' })[key] ?? `--invalid-${key}`, String(value)]))
  for (const key of ['serverBin', 'producerDir', 'pins', 'nodeBin']) options[key] = await realpath(options[key])
  options.outDir = await futureCanonicalPath(options.outDir)
  assert.ok(options.outDir !== options.producerDir && !options.outDir.startsWith(options.producerDir + sep)
    && !options.producerDir.startsWith(options.outDir + sep), 'Canonical producer/output directories overlap')
  for (const key of ['serverBin', 'pins', 'nodeBin'])
    assert.ok(options[key] !== options.outDir && !options[key].startsWith(options.outDir + sep), 'Canonical evidence output contains an input')
  await mkdir(dirname(options.outDir), { recursive: true })
  await mkdir(options.outDir) // Deliberately rejects ALL existing output, including an earlier failure.
  options.outDir = await realpath(options.outDir)
  const report = { schemaVersion: 1, kind: 'real-browser-dev-loop', status: 'running', startedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version, runtimeLocation: 'browser', engine: 'quickjs', renderer: options.renderer,
      headless: true, onePage: true, browserConnection: options.fixture === 'button' ? 'owned Playwright launch; touch CDP only on owned context/page, no remote connection' : 'owned Playwright launch, no CDP' },
    evidenceBoundary: `Real fixed-wv compiler, retained producer, QuickJS WASM Worker and ${options.renderer === 'skia' ? 'CanvasKit WebGL2 surface with browser submission and explicit screenshot evidence; physical hardware and GPU completion remain unknown' : 'browser DOM; no GPU claim'}. ${options.fixture === 'button' ? 'Optional real native button fixture; each check requires actual input and original Worker observations.' : 'Tap uses the existing reference-app view/bindtap subset; historical smoke-r3 button failure remains retained as failed.'} No performance, seven-host, WeChat oracle or near-parity claim.`,
    serverKind: options.serverKind, reloads: options.reloads, contextRecovery: options.contextRecovery, fixture: options.fixture, domQueries: options.domQueries,
    startupProofs: [], steps: [], requests: [], workers: [], console: [], pageErrors: [], cleanup: [], resources: [], failure: null }
  const fixture = smokeFixture(options.serverKind, options.renderer, options.contextRecovery, options.domQueries, options.fixture), initialCount = `Count: ${fixture.data.count}`, clickedCount = `Count: ${fixture.data.count + 1}`
  const skia = options.renderer === 'skia'
  const project = resolve(options.outDir, 'project'), fatal = deferred(), controller = new AbortController()
  let server, browser, context, page, interrupted = null, observedFatal = null, browserClosed = false, contextClosed = false, pageClosed = false, appCloseSucceeded = false
  const fail = error => { observedFatal ??= error; fatal.reject(error) }, signal = controller.signal
  const interrupt = name => { interrupted ??= Object.assign(new Error(`Smoke interrupted by ${name}`), { code: 'ERR_CANCELLED' }); controller.abort(interrupted); fail(interrupted) }
  const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm)
  const save = async (name, value, limit = LIMITS.evidence) => { const text = JSON.stringify(value, null, 2) + '\n'; assert.ok(Buffer.byteLength(text) <= limit, `Evidence exceeds its finite budget: ${name}`)
    await writeFile(resolve(options.outDir, name), text, { flag: 'wx' }) }
  const guard = (action, timeoutMs, label) => deadline(() => Promise.race([Promise.resolve().then(action), fatal.promise]), timeoutMs, label, signal)
  const evaluate = (fn, arg) => guard(() => page.evaluate(fn, arg), 30_000, 'page evaluation')
  const step = async (name, action) => { const fact = { name, status: 'running', startedAt: new Date().toISOString() }; report.steps.push(fact)
    try { const value = await action(); fact.status = 'passed'; fact.finishedAt = new Date().toISOString(); return value }
    catch (error) { fact.status = 'failed'; fact.error = failure(error); throw error } }
  const waitReady = async (previous, label) => {
    await guard(() => page.waitForFunction(({ old, backend }) => {
      const app = window.weappContainerDev?.status, executing = app?.manager?.executing
      return app?.phase === 'watching' && executing?.runtimeReady === true && executing?.hasPresented === true && executing?.inputEnabled === true
        && executing.owner?.transportBackend === backend && (!old || executing.identity?.siteId !== old.siteId && executing.owner.sessionId !== old.sessionId)
    }, { old: previous ?? null, backend: skia ? 'external-frame' : 'browser-view' }, { timeout: 90_000 }), 95_000, label)
    return evaluate(() => window.weappContainerDev.status)
  }
  const snapshot = async name => {
    const value = await evaluate(() => ({ state: window.weappContainerDev?.status ?? null, audit: window.__browserDevSmokeAudit?.read(),
      gpuAudit: window.__browserDevGpuAudit?.read() ?? null, diagnostics: document.querySelector('#dev-diagnostics')?.textContent?.slice(0, 32 * 1024) ?? '',
      statusText: document.querySelector('#dev-status')?.textContent?.slice(0, 16 * 1024) ?? '' }))
    assert.equal(value.audit?.droppedEvents, 0); assert.equal(value.audit?.droppedTraces, 0)
    await save(`${name}.json`, value)
    const png = await guard(() => page.screenshot({ path: resolve(options.outDir, `${name}.png`), fullPage: false, timeout: 30_000 }), 35_000, `${name} screenshot`)
    assert.ok(png.length <= LIMITS.screenshot, 'Screenshot exceeded its finite budget')
    return value
  }
  const canvasSurface = () => page.locator('#dev-surface [data-worker-web-session] canvas')
  const frame = () => page.frameLocator(INTERACTIVE_DOM_SURFACE_SELECTOR)
  const waitText = (selector, expected) => guard(() => page.waitForFunction(({ selector, expected }) => {
    const surface = window.__browserDevDomSurface.current()
    const element = surface?.frame.contentDocument.querySelector(selector)
    return element?.textContent === expected && element.getClientRects().length > 0
  }, { selector, expected }, { timeout: 30_000 }), 35_000, `Current accepted DOM ${selector} = ${expected}`)
  const domQueryOracle = perturb => pollSmokeValue(() => evaluate(({ perturb }) => {
    const selected = window.__browserDevDomSurface.current(), surface = selected?.frame
    if (!selected) return null
    const element = surface.contentDocument.querySelector('#tap')
    if (!element) throw new Error('Actual DOM query target or accepted key is unavailable')
    const rect = () => { const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, width: box.width, height: box.height } }
    const before = rect()
    if (perturb) element.style.transform = 'translateX(13px)'
    const scroller = surface.contentDocument.scrollingElement
    return { rect: rect(), scroll: { x: surface.contentWindow.scrollX, y: surface.contentWindow.scrollY },
      extent: { width: scroller?.scrollWidth, height: scroller?.scrollHeight },
      ...(perturb ? { perturbation: { translateX: 13, before, key: selected.key } } : {}) }
  }, { perturb }), value => value !== null, { signal, label: 'Current accepted DOM query oracle' })
  const waitDomQueryFrame = () => guard(() => page.waitForFunction(() => {
    const manager = window.weappContainerDev?.status.manager, owner = manager?.executing?.owner
    if (!owner || !window.__browserDevDomSurface.current()) return false
    const latest = window.__browserDevSmokeAudit.read().traces.findLast(value => value.direction === 'receive'
      && value.workerEpoch === owner.workerEpoch && value.sessionId === owner.sessionId && value.runtimeState)
    const selected = window.__browserDevDomSurface.current()
    return Boolean(selected && latest && selected.observation.value.consumedInput.templateRevision === latest.runtimeState.templateRevision
      && selected.key.surfaceGeneration === latest.runtimeState.surfaceGeneration)
  }, null, { timeout: 15_000 }), 20_000, 'Current actual DOM input/accepted proof catches up with runtime')
  const verifyDomQueries = async (owner, label, cycle, expectedCount, oracle) => {
    if (!options.domQueries) return
    await pollSmokeValue(() => Promise.race([
      page.evaluate(readDomQuerySmokeState, { query: fixture.queryStateQuery, label, cycle }), fatal.promise,
    ]), value => value !== null, { signal, label: `${label} actual wx query callbacks and timer` })
    await waitText('#query-status', `Query ${label} ${cycle}`)
    await waitDomQueryFrame()
    await guard(() => page.waitForFunction(() => {
      const manager = window.weappContainerDev?.status.manager, owner = manager?.executing?.owner
      if (!owner || !window.__browserDevDomSurface.current()) return false
      const query = window.__browserDevSmokeAudit.read().domQueries.wire.findLast(value => value.direction === 'receive'
        && value.workerEpoch === owner.workerEpoch && value.sessionId === owner.sessionId && value.message.op === 'view.query.request')
      const selected = window.__browserDevDomSurface.current()
      return query && selected && BigInt(selected.key.documentRevision) > BigInt(query.message.payload.key.documentRevision)
    }, null, { timeout: 15_000 }), 20_000, `${label} query callback setData accepted document`)
    const observed = await evaluate(readDomQuerySmokeState, { query: fixture.queryStateQuery })
    const observationName = `dom-query-observation-${(report.domQueryObservations?.length ?? 0) + 1}-${label}-${cycle}.json`
    const proof = await captureAndAssertDomQueryEvidence({ ...observed, oracle: oracle ?? await domQueryOracle(false) },
      { owner, label, cycle, expectedCount, marker: fixture.data.marker, route: fixture.route, viewport: fixture.viewport }, async raw => {
        await save(observationName, raw)
        ;(report.domQueryObservations ??= []).push({ label, cycle, path: observationName, kind: raw.kind })
      })
    ;(report.domQueryProofs ??= []).push(proof)
    await save(`dom-query-${report.domQueryProofs.length}-${label}.json`, proof)
  }
  const readSkiaState = () => evaluate(readSkiaSmokeState, { query: fixture.appStateQuery })
  const waitSkiaCount = async expected => {
    const value = await pollSkiaSmokeCount(() => Promise.race([
      page.evaluate(readSkiaSmokeState, { query: fixture.appStateQuery }), fatal.promise,
    ]), expected, { signal })
    assert.equal(value.fixture, 'browser-dev-loop-skia-v1'); assert.equal(value.count, expected)
    assert.equal(value.marker, fixture.data.marker); assert.equal(value.route, fixture.route)
    return value
  }
  const captureSkiaSurface = async (name, expectedColor) => {
    const png = await guard(() => canvasSurface().screenshot({ path: resolve(options.outDir, `${name}.png`), timeout: 30_000 }), 35_000, `${name} explicit canvas screenshot`)
    assert.ok(png.length <= LIMITS.screenshot)
    const pixels = screenshotPixels(png), point = fixture.canvas.feedback
    const x = Math.floor(point.x * pixels.width / fixture.viewport.width), y = Math.floor(point.y * pixels.height / fixture.viewport.height)
    const sample = Array.from(pixels.rgba.subarray((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4))
    assert.deepEqual(sample, expectedColor, 'Actual canvas feedback pixels disagree with AppService count')
    return { path: `${name}.png`, width: pixels.width, height: pixels.height, pngSha256: hash(png), rgbaSha256: pixels.sha256, sample,
      source: 'explicit Playwright surface screenshot decoded in Node; no page WebGL readback', physicalHardware: 'unknown', gpuCompletion: 'unknown' }
  }
  const gpuSurfaceLifetimes = createGpuSurfaceLifetimeTracker()
  const assertHotPath = async label => {
    if (!skia) return
    const observed = await evaluate(() => {
      const canvases = document.querySelectorAll('#dev-surface [data-worker-web-session] canvas')
      if (canvases.length !== 1) throw new Error('Hot-path audit requires exactly one actual current CanvasKit canvas')
      const gl = canvases[0].getContext('webgl2')
      if (!gl || gl.isContextLost()) throw new Error('Hot-path audit requires the actual live WebGL2 context')
      const executing = window.weappContainerDev.status.manager.executing, worker = window.__browserDevSmokeAudit.read()
      const acknowledgement = worker.traces.findLast(value => value.direction === 'receive' && value.op === 'ack'
        && value.workerEpoch === executing.owner.workerEpoch && value.sessionId === executing.owner.sessionId
        && value.acknowledgement?.renderRevision === executing.submission?.value.renderRevision)
      return { owner: executing.owner, submission: executing.submission, acknowledgement,
        gpu: window.__browserDevGpuAudit.read(gl), worker }
    })
    const surface = gpuSurfaceLifetimes.observe(observed, { route: fixture.route, viewport: fixture.viewport })
    ;(report.hotPathObservations ??= []).push({ label, owner: observed.owner, ...surface, gpu: observed.gpu })
    assert.equal(observed.worker.fullFramePixelTransfers, 0); assert.equal(observed.worker.incompleteFrameInspections, 0)
    assert.ok(observed.worker.frameMessages > 0)
    assert.equal(report.requests.some(value => /\/api\/(?:frame|snapshot)(?:$|[?#])/.test(value.url)), false)
    const value = { label, owner: observed.owner, ...surface, gpu: observed.gpu, worker: { frameMessages: observed.worker.frameMessages,
      fullFramePixelTransfers: observed.worker.fullFramePixelTransfers, incompleteFrameInspections: observed.worker.incompleteFrameInspections } }
    ;(report.hotPathChecks ??= []).push(value)
    return value
  }
  const assertStartup = async (ownerState, build) => {
    let appState = null
    if (skia) appState = await waitSkiaCount(fixture.data.count)
    else {
      await waitText('#build', `Build ${build}`); await waitText('#count', initialCount)
      if (options.serverKind === 'cli') await waitText('#startup-marker', fixture.data.marker)
    }
    const owner = ownerState.manager.executing.owner
    const observed = await pollSmokeValue(() => evaluate(({ workerEpoch, sessionId, skia }) => {
      const selected = skia ? null : window.__browserDevDomSurface.current()
      if (!skia && !selected) return null
      const frames = skia ? [...document.querySelectorAll('iframe[title="Weapp Container DOM surface"]')] : [selected.frame]
      const canvases = [...document.querySelectorAll('#dev-surface [data-worker-web-session] canvas')]
      if (frames.length !== (skia ? 0 : 1) || canvases.length !== (skia ? 1 : 0)) throw new Error('Expected exactly one actual selected surface and no renderer fallback')
      const element = skia ? canvases[0] : frames[0], rect = element.getBoundingClientRect()
      const current = window.weappContainerDev.status.manager, history = current.history
      const traces = window.__browserDevSmokeAudit.read().traces.filter(value => value.direction === 'receive'
        && value.workerEpoch === workerEpoch && value.sessionId === sessionId)
      const geometry = { width: rect.width, height: rect.height, ...(skia ? { physicalWidth: element.width, physicalHeight: element.height }
        : { innerWidth: element.contentWindow.innerWidth, innerHeight: element.contentWindow.innerHeight }) }
      let webgl = null
      if (skia) {
        const gl = element.getContext('webgl2')
        if (!gl || gl.isContextLost()) throw new Error('Actual CanvasKit surface has no live WebGL2 context')
        webgl = { liveWebgl2: true, physicalHardware: 'unknown', gpuCompletion: 'unknown' }
      }
      return { geometry, webgl, domSurfaces: selected ? { interactive: 1, totalOwned: selected.allFrameCount, key: selected.key } : null, submission: current.executing.submission ?? null,
        runtimeTrace: traces.filter(value => value.runtimeState?.currentPage && value.runtimeState !== null).at(-1),
        frameTrace: traces.filter(value => value.frame !== null && value.frame !== undefined).at(-1) ?? null,
        accepted: history.findLast(value => value.kind === 'accepted-proof' && value.value?.proof?.owner?.workerEpoch === workerEpoch
          && value.value.proof.owner.sessionId === sessionId) ?? null }
    }, { workerEpoch: owner.workerEpoch, sessionId: owner.sessionId, skia }), value => value !== null, { signal, label: 'Atomic current accepted startup surface observation' })
    assert.equal(observed.runtimeTrace?.runtimeState.currentPage?.path, fixture.route, 'Original Worker did not execute the selected route')
    assert.equal(observed.runtimeTrace.runtimeState.lifecycle, 'Active'); assert.equal(observed.runtimeTrace.runtimeState.rendererProfile, options.renderer)
    assert.equal(observed.runtimeTrace.runtimeState.declaredRendererProfile, 'webview', 'Original legal source declaration must survive the runtime override')
    assert.deepEqual(observed.runtimeTrace.runtimeState.viewport, { x: 0, y: 0, ...fixture.viewport })
    assert.equal(observed.accepted?.value.proof.consumedInput.routePath, fixture.route)
    assert.deepEqual(observed.accepted.value.proof.consumedInput.viewport, { x: 0, y: 0, ...fixture.viewport })
    if (skia) {
      assertSkiaSubmission(observed.submission, { owner, route: fixture.route, viewport: fixture.viewport })
      assert.equal(observed.frameTrace?.frame.frameId, observed.submission.value.frameId)
      assert.equal(observed.frameTrace.frame.renderRevision, observed.submission.value.renderRevision)
      for (const text of [`Build ${build}`, initialCount, fixture.data.marker]) assert.ok(observed.frameTrace.frame.fixtureText.includes(text), `Actual frame lacks ${text}`)
      await assertHotPath(`startup-${build}`)
    }
    assert.deepEqual(observed.geometry, { width: fixture.viewport.width, height: fixture.viewport.height,
      ...(skia ? { physicalWidth: fixture.viewport.width, physicalHeight: fixture.viewport.height } : { innerWidth: fixture.viewport.width, innerHeight: fixture.viewport.height }) })
    report.startupProofs.push({ build, owner, route: fixture.route, renderedCount: initialCount,
      renderedMarker: options.serverKind === 'cli' ? fixture.data.marker : null, appState, ...observed })
    await verifyDomQueries(owner, 'startup', 1, fixture.data.count)
  }
  const clickSurface = async (name, label, expectedCount = fixture.data.count + 1) => {
    if (!skia) {
      await guard(() => frame().locator(options.fixture === 'button' ? '#increment-child' : '#increment').click(), 35_000, label)
      await waitText('#count', clickedCount)
      if (options.domQueries) {
        const ready = await waitReady(null, 'Query tap uses the accepted post-increment document')
        await waitDomQueryFrame()
        const oracle = await domQueryOracle(true)
        await guard(() => frame().locator('#tap').click(), 35_000, 'Actual DOM tap invokes wx.createSelectorQuery')
        await verifyDomQueries(ready.manager.executing.owner, 'tap', 2, expectedCount, oracle)
      }
      return
    }
    await assertHotPath(`${name}-before-click`)
    const previous = await evaluate(() => window.weappContainerDev.status.manager.executing)
    assertSkiaSubmission(previous.submission, { owner: previous.owner, route: fixture.route, viewport: fixture.viewport })
    const previousFrame = options.contextRecovery ? await acceptedCanvas() : null
    const before = await captureSkiaSurface(`${name}-canvas-before`, expectedCount - 1 === fixture.data.count ? fixture.canvas.before : fixture.canvas.after)
    const box = await guard(() => canvasSurface().boundingBox(), 15_000, 'actual CanvasKit surface geometry')
    assert.ok(box?.width > 0 && box.height > 0)
    const point = { x: box.x + fixture.canvas.button.x * box.width / fixture.viewport.width,
      y: box.y + fixture.canvas.button.y * box.height / fixture.viewport.height }
    await guard(() => page.mouse.click(point.x, point.y), 35_000, label)
    const appState = await waitSkiaCount(expectedCount)
    await guard(() => page.waitForFunction(old => {
      const current = window.weappContainerDev.status.manager.executing, submission = current?.submission
      return current?.owner?.workerEpoch === old.owner.workerEpoch && current.owner.sessionId === old.owner.sessionId && current.inputEnabled
        && submission?.phase === 'accepted' && submission.proof?.publication?.kind === 'external-frame'
        && BigInt(submission.proof.consumedInput.templateRevision) > BigInt(old.submission.proof.consumedInput.templateRevision)
    }, previous, { timeout: 30_000 }), 35_000, 'actual updated accepted CanvasKit proof')
    const current = await evaluate(() => window.weappContainerDev.status.manager.executing)
    assertSkiaSubmission(current.submission, { owner: previous.owner, route: fixture.route, viewport: fixture.viewport })
    assert.ok(BigInt(current.submission.value.renderRevision) > BigInt(previous.submission.value.renderRevision))
    const after = await captureSkiaSurface(`${name}-canvas-after`, expectedCount === fixture.data.count ? fixture.canvas.before : fixture.canvas.after)
    assert.notEqual(after.rgbaSha256, before.rgbaSha256, 'Actual canvas pixels did not change after pointer input')
    if (options.contextRecovery) {
      const currentFrame = await acceptedCanvas()
      const counter = frame => Number(frame.frameTrace?.frame.fixtureText.find(value => /^View calls: [0-9]+$/.test(value))?.slice(12))
      assert.ok(Number.isSafeInteger(counter(previousFrame)))
      assert.equal(counter(currentFrame), counter(previousFrame) + 1, 'A single genuine tap must evaluate the WXS probe exactly once')
    }
    ;(report.canvasInteractions ??= []).push({ label, owner: previous.owner, logicalPointer: fixture.canvas.button,
      browserPointer: point, box, appState, before, after, previousSubmission: previous.submission, submission: current.submission })
    await assertHotPath(name)
    return appState
  }
  const acceptedCanvas = () => evaluate(() => {
    const executing = window.weappContainerDev.status.manager.executing
    const audit = window.__browserDevSmokeAudit.read()
    const frameTrace = audit.traces.findLast(value => value.direction === 'receive'
      && value.workerEpoch === executing.owner.workerEpoch && value.sessionId === executing.owner.sessionId
      && value.frame?.renderRevision === executing.submission?.value.renderRevision)
    return { executing, frameTrace, constructs: audit.events.filter(value => value.kind === 'construct').length }
  })
  const recoverActualContext = async (kind, expectedCount) => {
    const before = await acceptedCanvas(), owner = before.executing.owner
    assertSkiaSubmission(before.executing.submission, { owner, route: fixture.route, viewport: fixture.viewport })
    await assertHotPath(`recovery-${kind}-before-context-loss`)
    const viewCall = before.frameTrace?.frame.fixtureText.find(value => /^View calls: [0-9]+$/.test(value))
    assert.ok(viewCall, 'Recovery fixture must observe an actual stateful WXS result')
    const beforePixels = await captureSkiaSurface(`recovery-${kind}-before`, fixture.canvas.after)
    // Register a Window capture observer before the target adapter sees the
    // real browser loss. A genuine AppService request dirties the second case;
    // no session callback, scheduler result or native receipt is fabricated.
    await evaluate(loseSkiaSmokeContext, { dirtyQuery: kind === 'render-required' ? fixture.dirtyTimerQuery : null,
      ownerKey: before.executing.ownerKey })
    await guard(() => page.waitForFunction(() => window.__contextRecoverySmoke?.lost, null, { timeout: 15_000 }), 20_000, 'actual browser contextlost event')
    const loss = await evaluate(() => window.__contextRecoverySmoke)
    assert.equal(loss.inputBlocked, true, 'Context loss did not synchronously block input')
    assert.deepEqual(loss.owner, owner)
    assert.equal(loss.recovery?.version, '1.0')
    const lossBoundary = gpuSurfaceLifetimes.recordLoss(loss)
    if (kind === 'render-required') {
      await guard(() => page.waitForFunction(() => window.__contextRecoverySmoke?.dirty === 'acknowledged'
        || window.__contextRecoverySmoke?.error, null, { timeout: 15_000 }), 20_000, 'genuine loss-time AppService response')
      assert.equal((await evaluate(() => window.__contextRecoverySmoke)).error, null)
    }
    const appState = await waitSkiaCount(expectedCount)
    await guard(() => page.waitForFunction(({ owner, oldGeneration, expectedCount }) => {
      const value = window.weappContainerDev.status.manager.executing
      const frame = window.__browserDevSmokeAudit.read().traces.findLast(trace => trace.direction === 'receive'
        && trace.workerEpoch === owner.workerEpoch && trace.sessionId === owner.sessionId
        && trace.frame?.renderRevision === value?.submission?.value.renderRevision)
      return value?.owner?.workerEpoch === owner.workerEpoch && value.owner.sessionId === owner.sessionId
        && value.inputEnabled && value.submission?.phase === 'accepted' && value.surfaceRecovery === null
        && BigInt(value.submission.value.surfaceGeneration) > BigInt(oldGeneration)
        && frame?.frame.fixtureText.includes(`Count: ${expectedCount}`)
    }, { owner, oldGeneration: before.executing.submission.value.surfaceGeneration, expectedCount }, { timeout: 30_000 }), 35_000, 'actual replacement surface and native ACK')
    const after = await acceptedCanvas()
    assert.deepEqual(after.executing.owner, owner)
    assert.equal(after.constructs, before.constructs, 'Context recovery replaced the actual Worker')
    assertSkiaSubmission(after.executing.submission, { owner, route: fixture.route, viewport: fixture.viewport })
    assert.ok(BigInt(after.executing.submission.value.renderRevision) > BigInt(before.executing.submission.value.renderRevision))
    const recovery = await evaluate(({ workerEpoch, sessionId, oldRevision, kind }) => {
      return window.__browserDevSmokeAudit.read().traces.findLast(value => value.direction === 'receive'
        && value.workerEpoch === workerEpoch && value.sessionId === sessionId && value.op === 'surface.recover'
        && value.recovery?.kind === kind && BigInt(value.recovery.previousRenderRevision) >= BigInt(oldRevision))
    }, { ...owner, oldRevision: before.executing.submission.value.renderRevision, kind })
    assert.equal(recovery?.recovery.kind, kind, 'No genuine native recovery outcome for the requested branch')
    assert.equal(recovery.recovery.previousInputLifetimeRevision, before.frameTrace.runtimeState.inputLifetimeRevision)
    assert.equal(BigInt(recovery.recovery.inputLifetimeRevision), BigInt(recovery.recovery.previousInputLifetimeRevision) + 1n)
    assert.equal(recovery.runtimeState.inputLifetimeRevision, recovery.recovery.inputLifetimeRevision)
    assert.equal(after.frameTrace.runtimeState.inputLifetimeRevision, recovery.recovery.inputLifetimeRevision)
    assert.equal(recovery.runtimeState.surfaceGeneration, after.executing.submission.value.surfaceGeneration)
    assert.equal(BigInt(recovery.runtimeState.surfaceGeneration), BigInt(before.frameTrace.runtimeState.surfaceGeneration) + 1n)
    const acknowledgement = await evaluate(({ workerEpoch, sessionId, renderRevision }) => {
      const traces = window.__browserDevSmokeAudit.read().traces
      const response = traces.findLast(value => value.direction === 'receive' && value.op === 'ack'
        && value.workerEpoch === workerEpoch && value.sessionId === sessionId
        && value.acknowledgement?.renderRevision === renderRevision)
      const request = response && traces.find(value => value.direction === 'send' && value.op === 'ack'
        && value.workerEpoch === workerEpoch && value.sessionId === sessionId && value.requestId === response.requestId)
      return { request, response }
    }, { ...owner, renderRevision: after.executing.submission.value.renderRevision })
    assert.equal(acknowledgement.request?.acknowledgement.requestedRevision, after.executing.submission.value.renderRevision)
    assert.deepEqual(acknowledgement.response?.acknowledgement, { version: '1.0', sessionId: owner.sessionId,
      renderRevision: after.executing.submission.value.renderRevision, acknowledged: true, inputEnabled: true, requiresRestart: false })
    assert.equal(acknowledgement.response.runtimeState.inputLifetimeRevision, recovery.recovery.inputLifetimeRevision)
    assert.equal(acknowledgement.response.runtimeState.surfaceGeneration, after.executing.submission.value.surfaceGeneration)
    const afterViewCall = after.frameTrace?.frame.fixtureText.find(value => /^View calls: [0-9]+$/.test(value))
    if (kind === 'retained') {
      assert.equal(after.frameTrace.frame.frameId, before.frameTrace.frame.frameId)
      assert.deepEqual(after.frameTrace.frame.fixtureText, before.frameTrace.frame.fixtureText)
      assert.equal(afterViewCall, viewCall, 'Retained recovery re-executed the stateful WXS function')
      assert.equal(after.executing.submission.proof.consumedInput.templateRevision,
        before.executing.submission.proof.consumedInput.templateRevision)
    } else {
      assert.ok(BigInt(after.executing.submission.proof.consumedInput.templateRevision)
        > BigInt(before.executing.submission.proof.consumedInput.templateRevision))
      assert.ok(after.frameTrace.frame.fixtureText.includes(`Count: ${expectedCount}`))
      assert.ok(Number(afterViewCall?.slice(12)) > Number(viewCall.slice(12)), 'Dirty recovery did not execute the new template')
    }
    const afterPixels = await captureSkiaSurface(`recovery-${kind}-after`, fixture.canvas.after)
    if (kind === 'retained') assert.equal(afterPixels.rgbaSha256, beforePixels.rgbaSha256)
    const fact = { kind, owner, actualLoss: loss, lossBoundary, before, after, appState, recovery, acknowledgement, beforePixels, afterPixels,
      physicalHardware: 'unknown', gpuCompletion: 'unknown', performance: 'not-measured' }
    ;(report.contextRecoveries ??= []).push(fact)
    await assertHotPath(`recovery-${kind}`)
    await snapshot(`recovery-${kind}`)
    await clickSurface(`recovery-${kind}-clicked`, `Actual input on recovered ${kind} surface`, expectedCount + 1)
  }
  try {
    report.producerBefore = await step('independent-producer-pins-and-source', () => inspectProducer(options))
    report.serverBinary = { path: options.serverBin, ...await fileHash(options.serverBin, LIMITS.binary) }
    await regularFile(options.nodeBin, LIMITS.binary)
    report.sourceBefore = await sourceVersion()
    report.project = { directory: project, route: fixture.route, initialData: fixture.data, viewport: fixture.viewport,
      files: await createProject(project, options.serverKind, options.renderer, options.contextRecovery, options.domQueries, options.fixture) }
    const playwrightPath = resolve(ROOT, 'vendor/weapp-vite/node_modules/playwright/index.mjs')
    const { chromium } = await import(pathToFileURL(playwrightPath).href)
    server = spawnServer(options, project, report.producerBefore, fail)
    report.resources.push({ resource: 'server', createdByThisRun: true, pid: server.child.pid ?? null, binary: options.serverBin, output: resolve(options.outDir, 'server') })
    report.serverArguments = server.args
    const listening = await step('real-server-listening', () => guard(() => server.listening, 200_000, 'real compiler/runtime preparation'))
    report.listening = listening; assert.equal(listening.compileSource?.compilerCommit, report.sourceBefore.vendorCommit)
    // Playwright owns its launch timeout/teardown. Do not race away a late
    // browser handle before finally can close the actual launched process.
    browser = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, timeout: 30_000 })
    signal.throwIfAborted(); if (observedFatal) throw observedFatal
    report.environment.browserVersion = browser.version()
    context = await guard(() => browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block', ...(options.fixture === 'button' ? { hasTouch: true } : {}) }), 15_000, 'owned browser context')
    context.on('request', request => {
      const fact = { method: request.method(), url: request.url() }
      if (report.requests.length >= LIMITS.requests || fact.url.length > 4096) { fail(new Error('Request evidence exceeded its finite budget')); return }
      report.requests.push(fact) // Never inspect headers, postData, bootstrap HTML or credential bytes.
    })
    const origin = new URL(listening.url).origin
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin || url.username || url.password || url.search || url.hash) {
        fail(new Error('Unexpected nonlocal or noncanonical browser request')); await route.abort('blockedbyclient'); return
      }
      if (skia && ['/api/frame', '/api/snapshot'].includes(url.pathname)) {
        fail(new Error('CanvasKit development loop requested a CPU RGBA frame/snapshot transport')); await route.abort('blockedbyclient'); return
      }
      await route.continue()
    })
    page = await guard(() => context.newPage(), 15_000, 'single owned page')
    report.resources.push({ resource: 'browser-context-and-single-page', createdByThisRun: true, url: listening.url, retained: false })
    page.setDefaultTimeout(30_000)
    await page.addInitScript(installWorkerAudit, { domQueries: options.domQueries })
    await page.addInitScript(installDomSurfaceProbe)
    if (options.fixture === 'button') await page.addInitScript(installButtonNativeAudit)
    if (skia) await page.addInitScript(installGpuAudit)
    context.on('page', extra => { if (extra !== page) { fail(new Error('Development smoke created an unexpected second page')); void extra.close().catch(fail) } })
    page.on('pageerror', error => { if (report.pageErrors.length < 64) report.pageErrors.push(failure(error)); else fail(new Error('Page error evidence exceeded its finite budget')) })
    page.on('console', message => { if (report.console.length < 128) report.console.push({ type: message.type(), text: scrub(message.text()).slice(0, 4096) })
      else fail(new Error('Console evidence exceeded its finite budget')) })
    page.on('worker', worker => {
      if (report.workers.length >= LIMITS.workers) { fail(new Error('Dedicated Worker count exceeded its finite budget')); return }
      const fact = { url: worker.url().slice(0, 4096), createdAt: new Date().toISOString(), closed: false, realm: null }
      report.workers.push(fact)
      worker.on('close', () => { fact.closed = true; fact.closedAt = new Date().toISOString() })
      void deadline(() => worker.evaluate(() => ({ constructor: self.constructor.name,
        dedicated: typeof DedicatedWorkerGlobalScope === 'function' && self instanceof DedicatedWorkerGlobalScope,
        hasDocument: typeof document !== 'undefined', name: self.name })), 15_000, 'actual DedicatedWorkerGlobalScope observation', signal)
        .then(realm => { fact.realm = realm }, error => { fact.realmError = failure(error); fail(error) })
    })
    let a, b, currentBuild = 'B'
    const executedOwners = []
    await step(`A-real-worker-and-${skia ? 'CanvasKit' : 'DOM'}-ready`, async () => {
      await guard(() => page.goto(listening.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }), 35_000, 'owned page navigation')
      a = await waitReady(null, 'A runtime/presentation/input readiness')
      executedOwners.push(a.manager.executing.owner)
      await assertStartup(a, 'A')
      if (skia) assert.equal(await page.locator('iframe[title="Weapp Container DOM surface"]').count(), 0)
      else await waitText('#build', 'Build A')
      const saved = await snapshot('01-A-ready')
      assert.ok(!saved.diagnostics.includes('Browser dev operation failed'), 'A ready contains a synthesized diagnostic failure')
      const audit = await evaluate(() => window.__browserDevSmokeAudit.read())
      assert.equal(audit.events.filter(value => value.kind === 'construct').length, 1)
      const messages = audit.traces.filter(value => value.direction === 'receive' && value.kind === 'event' && value.op === 'batch').flatMap(value => value.messages)
      let position = -1
      for (const op of ['app.init', 'app.lifecycle', 'page.push']) {
        const next = messages.findIndex((message, index) => index > position && message.op === op && message.kind === 'response' && message.ok === true)
        assert.ok(next > position, `No ordered real AppService startup ${op} was observed`); position = next
      }
    })
    await step(`A-real-${skia ? 'CanvasKit' : 'DOM'}-click-setData`, async () => {
      await clickSurface('02-A-clicked', `A actual ${skia ? 'CanvasKit coordinate' : 'DOM'} click`)
      await snapshot('02-A-clicked')
    })
    if (options.fixture === 'button') await step('actual-native-button-contract-and-retirement', async () => {
      report.button = {}
      try {
        await runButtonSmoke({ page, context, frame, guard, evaluate, snapshot, query: fixture.buttonStateQuery, route: fixture.route,
          initialCount: fixture.data.count, save, resources: report.resources, cleanup: report.cleanup,
          release: (action, timeout, label) => deadline(action, timeout, label), result: report.button })
      } catch (error) { report.button.status = 'failed'; throw error }
    })
    if (options.contextRecovery) {
      await step('actual-WebGL-context-loss-retains-Worker-state-and-WXS-frame', () => recoverActualContext('retained', fixture.data.count + 1))
      await step('actual-WebGL-context-loss-dirty-input-and-live-AppService-timer', () => recoverActualContext('render-required', fixture.data.count + 4))
    }
    await step('atomic-WXML-B-replaces-exact-A-owner', async () => {
      await assertHotPath('A-before-owner-retirement')
      await atomicWrite(resolve(project, 'pages/home/index.wxml'), wxml('B', options.serverKind, options.renderer, options.contextRecovery, options.domQueries, options.fixture))
      b = await waitReady({ siteId: a.manager.executing.identity.siteId, sessionId: a.manager.executing.owner.sessionId }, 'B new site/session readiness')
      executedOwners.push(b.manager.executing.owner)
      await assertStartup(b, 'B')
      const saved = await snapshot('03-B-reloaded'), old = a.manager.executing
      assert.ok(!saved.diagnostics.includes('Browser dev operation failed'), 'B ready contains a synthesized diagnostic failure')
      const closed = saved.state.manager.history.find(value => value.kind === 'owner-closed' && value.identity?.siteId === old.identity.siteId)
      assert.equal(closed?.value?.outcome, 'closed'); assert.equal(closed.value.receipt?.version, '1.0')
      for (const key of ['closed', 'workerClosed', 'ownedMountRemoved']) assert.equal(closed.value.receipt[key], true)
      assert.deepEqual(closed.value.receipt.owner, old.owner); assert.equal(closed.value.receipt.workerFinal?.closed, true)
      assert.equal(closed.value.receipt.rpcIdentity?.workerEpoch, old.owner.workerEpoch); assert.equal(closed.value.receipt.rpcIdentity?.sessionId, old.owner.sessionId)
      const constructed = saved.audit.events.filter(value => value.kind === 'construct')
      assert.equal(constructed.length, 2)
      assert.equal(constructed[0].name, `container-${old.owner.workerEpoch}`)
      assert.equal(constructed[1].name, `container-${b.manager.executing.owner.workerEpoch}`)
      const terminated = saved.audit.events.filter(value => value.kind === 'terminate' && value.id === constructed[0].id)
      assert.equal(terminated.length, 1); assert.ok(terminated[0].sequence < constructed[1].sequence, 'B was constructed before the actual A Worker terminate call')
      assert.notEqual(b.manager.executing.identity.siteId, old.identity.siteId); assert.notEqual(b.manager.executing.owner.sessionId, old.owner.sessionId)
      report.replacement = { A: old, B: b.manager.executing, closeReceipt: closed, oldTerminate: terminated[0], newConstruct: constructed[1] }
    })
    if (options.reloads > 1) await step('bounded-watch-exceeds-legacy-control-capacity', async () => {
      const generations = []
      for (let revision = 2; revision <= options.reloads; revision++) {
        const old = b.manager.executing
        await assertHotPath(`${currentBuild}-before-owner-retirement`)
        currentBuild = `B${revision}`
        await atomicWrite(resolve(project, 'pages/home/index.wxml'), wxml(currentBuild, options.serverKind, options.renderer, options.contextRecovery, options.domQueries, options.fixture))
        b = await waitReady({ siteId: old.identity.siteId, sessionId: old.owner.sessionId }, `watch revision ${revision}`)
        executedOwners.push(b.manager.executing.owner)
        await assertStartup(b, currentBuild)
        const audit = await evaluate(() => window.__browserDevSmokeAudit.read())
        const constructs = audit.events.filter(value => value.kind === 'construct')
        const previous = constructs.find(value => value.name === `container-${old.owner.workerEpoch}`)
        const next = constructs.find(value => value.name === `container-${b.manager.executing.owner.workerEpoch}`)
        const closes = audit.events.filter(value => value.kind === 'terminate' && value.id === previous?.id)
        assert.equal(closes.length, 1); assert.ok(closes[0].sequence < next.sequence)
        generations.push({ revision, siteId: b.manager.executing.identity.siteId, sessionId: b.manager.executing.owner.sessionId,
          normalRequestsRetained: b.transport.lanes.normal.requests, normalRetainedBytes: b.transport.lanes.normal.retainedBytes,
          highWater: b.transport.highWater, retirements: b.transport.retirements })
      }
      if (options.reloads >= 12) {
        await guard(() => page.waitForFunction(() => {
          const transport = window.weappContainerDev?.status.transport
          return BigInt(transport?.highWater?.normal ?? '0') > 64n
            && BigInt(transport?.retirements?.normal?.throughSerial ?? '0') > 0n
        }, null, { timeout: 15_000 }), 20_000, 'real ACKed retirement beyond legacy normal capacity')
      }
      const saved = await snapshot('03-long-watch-retired')
      assert.equal(saved.audit.events.filter(value => value.kind === 'construct').length, options.reloads + 1)
      assert.equal(saved.state.manager.controlRetirements.enabled, true)
      assert.ok(saved.state.transport.lanes.normal.retainedBytes < saved.state.transport.lanes.normal.maxRetainedBytes)
      report.longWatch = { generations, finalTransport: saved.state.transport,
        finalRetirements: saved.state.manager.controlRetirements, exactRetirementRequests: report.requests.filter(value => value.url.endsWith('/__weapp/control/retire')).length }
      assert.ok(report.longWatch.exactRetirementRequests > 0)
    })
    await step('real-compiler-error-keeps-B-interactive', async () => {
      const beforeFailure = await assertHotPath('B-before-compiler-failure')
      await atomicWrite(resolve(project, 'pages/home/index.js'), 'Page({ data: { count: 0 }, increment() { this.setData({ count: this.data.count + 1 }) }\n')
      await guard(() => page.waitForFunction(() => {
        const value = window.weappContainerDev?.status
        return value?.observation?.portableCurrent === false && value.observation.sourceDiagnostic
          && typeof value.observation.sourceDiagnostic.code === 'string' && typeof value.observation.sourceDiagnostic.message === 'string'
      }, null, { timeout: 60_000 }), 65_000, 'real compiler failure diagnostic')
      const state = await evaluate(() => window.weappContainerDev.status)
      assert.equal(state.manager.executing.identity.siteId, b.manager.executing.identity.siteId)
      assert.equal(state.manager.executing.owner.sessionId, b.manager.executing.owner.sessionId); assert.equal(state.manager.executing.inputEnabled, true)
      if (skia) {
        const retained = await assertHotPath('B-owner-and-context-retained-after-compiler-failure')
        assert.deepEqual(retained.owner, beforeFailure.owner)
        assert.equal(retained.gpu.activeContext.contextId, beforeFailure.gpu.activeContext.contextId,
          'Compiler failure replaced the actual current WebGL context')
      }
      if (skia) await waitSkiaCount(fixture.data.count)
      else {
        await waitText('#build', `Build ${currentBuild}`); await waitText('#count', initialCount)
        if (options.serverKind === 'cli') await waitText('#startup-marker', fixture.data.marker)
      }
      const retainedApp = await clickSurface('04-build-error-B-retained', `B retained ${skia ? 'CanvasKit coordinate' : 'DOM'} click after compile failure`)
      const saved = await snapshot('04-build-error-B-retained')
      assert.equal(saved.audit.events.filter(value => value.kind === 'construct').length, options.reloads + 1, 'Compiler error constructed an extra Worker')
      assert.ok(saved.diagnostics.length > 0, 'Real build failure is missing from the diagnostic panel')
      report.compileFailure = { diagnostic: state.observation.sourceDiagnostic, retainedSite: state.manager.executing.identity,
        retainedOwner: state.manager.executing.owner, ...(skia ? retainedCompileFailureCount(retainedApp, fixture.data.count + 1) : { realDOMCount: clickedCount }) }
    })
    await step('explicit-UI-Stop-and-original-server-exit', async () => {
      await assertHotPath('B-before-explicit-owner-retirement')
      server.expectExit()
      await guard(() => page.locator('#dev-stop').click(), 35_000, 'explicit UI Stop')
      await guard(() => page.waitForFunction(() => window.weappContainerDev?.status.phase === 'closed', null, { timeout: 60_000 }), 65_000, 'actual app owner/control close')
      const saved = await snapshot('05-stopped'); appCloseSucceeded = true
      if (skia) {
        assertGpuLifetimeAudit(saved.gpuAudit)
        report.finalGpuLifetimeAudit = saved.gpuAudit
      }
      assert.equal(saved.state.manager.executing, null); assert.equal(saved.state.transport.pendingActual, 0)
      assert.equal(saved.state.transport.phase, 'closed')
      const constructs = saved.audit.events.filter(value => value.kind === 'construct')
      assert.equal(constructs.length, options.reloads + 1)
      for (const value of constructs) assert.equal(saved.audit.events.filter(event => event.kind === 'terminate' && event.id === value.id).length, 1)
      await guard(async () => {
        // Bound the actual poll as well as its caller's wait. A rejected realm
        // observation must not leave a timer loop alive after failure cleanup.
        const expires = performance.now() + 14_000
        while (report.workers.some(worker => !worker.closed || !worker.realm)) {
          signal.throwIfAborted()
          if (observedFatal) throw observedFatal
          assert.ok(performance.now() < expires, 'Actual Worker realm/close observation did not settle before its deadline')
          await new Promise(done => setTimeout(done, 20))
        }
      }, 15_000, 'actual Worker realm and close events')
      assert.equal(report.workers.length, options.reloads + 1)
      for (const value of report.workers) {
        assert.equal(value.realm.dedicated, true); assert.equal(value.realm.hasDocument, false); assert.equal(value.realm.constructor, 'DedicatedWorkerGlobalScope')
        assert.equal(new URL(value.url).origin, origin); assert.match(new URL(value.url).pathname, /^\/__weapp\/runtime\/[a-f0-9]{64}\/runtime-worker\.mjs$/)
      }
      assert.deepEqual(report.workers.map(value => value.realm.name).sort(),
        executedOwners.map(value => `container-${value.workerEpoch}`).sort())
      report.independentBrowserClose = { appPhase: saved.state.phase, controlPhase: saved.state.transport.phase,
        pendingActual: saved.state.transport.pendingActual, actualWorkerCloseEvents: report.workers.filter(value => value.closed).length,
        actualTerminateCalls: saved.audit.events.filter(value => value.kind === 'terminate').length }
      const exit = await guard(() => server.exited, 60_000, 'original server actual exit')
      assert.equal(exit.code, 0); assert.equal(exit.signal, null)
      assert.equal(server.summaryPath, validatedSummaryPath(options, listening))
      const summary = JSON.parse(await boundedRead(server.summaryPath, LIMITS.report))
      assert.equal(summary.event, 'shutdown'); assert.equal(summary.runId, listening.runId)
      for (const key of ['ownerShutdown', 'sameOwnerTryShutdown', 'controlCleanupReady', 'httpDrained', 'producerReportUnchanged']) assert.equal(summary[key], true, `Original shutdown did not prove ${key}`)
      assert.equal(summary.failure, null); assert.equal(summary.finalSnapshot.stopped, true); assert.equal(summary.finalSnapshot.ownerKey, null)
      assert.equal(summary.gpuClaimed, false); report.shutdown = summary; report.serverExit = exit
      assert.ok(server.events.some(value => value.event === 'shutdown' && value.runId === listening.runId))
    })
    assert.equal(report.pageErrors.length, 0, 'Unexpected real page exceptions were observed')
    report.producerAfter = await inspectProducer(options)
    assert.deepEqual(report.producerAfter, report.producerBefore, 'Original producer/pins/source changed during this consumer run')
    report.sourceAfter = await sourceVersion()
    assert.deepEqual(report.sourceAfter.files, report.sourceBefore.files, 'Development loop implementation changed during the smoke')
    assert.equal(report.sourceAfter.commit, report.sourceBefore.commit)
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.failure = failure(error)
    if (page && !page.isClosed()) {
      try {
        const value = await deadline(() => page.evaluate(() => ({ state: window.weappContainerDev?.status ?? null,
          audit: window.__browserDevSmokeAudit?.read() ?? null, diagnostics: document.querySelector('#dev-diagnostics')?.textContent?.slice(0, 32 * 1024) ?? '' })),
        5000, 'bounded failure-state observation')
        await save('failure-state.json', value)
        report.failureObservation = { path: 'failure-state.json', kind: 'unverified-original-browser-failure-observation' }
      } catch (observationError) { report.failureObservation = failure(observationError) }
    }
  }
  finally {
    // Cancellation never closes the page before this original owner gets a
    // genuine close attempt. A timeout records uncertainty, not completion.
    if (page && !page.isClosed()) {
      try {
        const result = await deadline(() => page.evaluate(async () => {
          if (!window.weappContainerDev) return { available: false }
          return { available: true, result: await window.weappContainerDev.close(), phase: window.weappContainerDev.status.phase }
        }), 45_000, 'finally original app.close')
        appCloseSucceeded = result.available === true && result.phase === 'closed' && result.result?.closed === true
        report.cleanup.push({ resource: 'original-app', result, actuallyClosed: appCloseSucceeded })
        if (!appCloseSucceeded) throw new Error('Original application close was unavailable or unproven')
      } catch (error) { report.cleanup.push({ resource: 'original-app', status: 'unresolved', error: failure(error) }); report.status = 'failed' }
    }
    for (const [name, resource, close] of [['page', page, () => page.close({ runBeforeUnload: false })],
      ['context', context, () => context.close()], ['browser', browser, () => browser.close()]]) {
      if (!resource) continue
      try {
        await deadline(close, 15_000, `finally owned ${name}.close`)
        if (name === 'page') pageClosed = page.isClosed()
        if (name === 'context') contextClosed = true
        if (name === 'browser') browserClosed = !browser.isConnected()
        report.cleanup.push({ resource: name, status: 'closed' })
      } catch (error) { report.status = 'failed'; report.cleanup.push({ resource: name, status: 'unresolved', error: failure(error) }) }
    }
    if (server && !server.exit) {
      server.expectExit()
      const delivered = server.child.kill('SIGINT') // Only this run's exact ChildProcess. Never kill by process name or group.
      report.cleanup.push({ resource: 'original-server', action: 'SIGINT', pid: server.child.pid ?? null, delivered })
      try { report.serverExit = await deadline(() => server.exited, 45_000, 'finally original server shutdown') }
      catch (error) {
        report.status = 'failed'; report.cleanup.push({ resource: 'original-server', status: 'retained', pid: server.child.pid ?? null,
          project, output: resolve(options.outDir, 'server'), error: failure(error),
          limitation: 'Original owner/process remains unresolved; no SIGKILL, global cleanup or fabricated Worker/owner shutdown was used.' })
        server.child.unref(); server.child.stdout.unref?.(); server.child.stderr.unref?.()
      }
    }
    if (server) {
      report.serverExit ??= server.exit
      report.serverEvents = server.events
      if (server.summaryPath && server.exit && !report.shutdown) {
        try {
          const summary = JSON.parse(await boundedRead(server.summaryPath, LIMITS.report))
          assert.equal(summary.event, 'shutdown'); assert.equal(summary.runId, server.runId)
          report.cleanupShutdown = { path: server.summaryPath, summary }
        } catch (error) { report.status = 'failed'; report.cleanup.push({ resource: 'original-server-summary', status: 'unproven', error: failure(error) }) }
      }
      for (const [name, log] of [['server-stdout', server.stdout], ['server-stderr', server.stderr]]) {
        const value = log.value(); report[`${name}Capture`] = { retainedBytes: value.retainedBytes, receivedBytes: value.receivedBytes, droppedBytes: value.droppedBytes }
        await writeFile(resolve(options.outDir, `${name}.log`), value.text, { flag: 'wx' })
        if (value.droppedBytes) report.status = 'failed'
      }
    }
    try {
      if (report.producerBefore && !report.producerAfter) report.producerAfter = await inspectProducer(options)
      if (report.producerBefore) assert.deepEqual(report.producerAfter, report.producerBefore)
    } catch (error) { report.status = 'failed'; report.cleanup.push({ resource: 'original-producer-immutability', status: 'failed', error: failure(error) }) }
    report.resourceCleanup = { appCloseSucceeded, pageClosed, contextClosed, browserClosed, serverActuallyExited: Boolean(server?.exit),
      retainedServerPid: server && !server.exit ? server.child.pid ?? null : null }
    if (interrupted) { report.status = 'failed'; report.interruption = failure(interrupted) }
    report.finishedAt = new Date().toISOString()
    process.off('SIGINT', sigint); process.off('SIGTERM', sigterm)
    await save('browser-dev-loop-report.json', report, 64 * 1024 * 1024)
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runBrowserDevLoop(parseArgs(process.argv.slice(2)))
    process.stdout.write(JSON.stringify({ status: report.status, report: resolve(parseArgs(process.argv.slice(2)).outDir, 'browser-dev-loop-report.json'),
      retainedServerPid: report.resourceCleanup.retainedServerPid }) + '\n')
    if (report.status !== 'passed') process.exitCode = 1
  } catch (error) { process.stderr.write(JSON.stringify({ status: 'failed', error: failure(error) }) + '\n'); process.exitCode = 1 }
}
