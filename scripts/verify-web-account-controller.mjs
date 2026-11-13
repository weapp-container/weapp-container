#!/usr/bin/env node
// Independent finite account-controller acceptance; never promotes active API claims.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { arch, release } from 'node:os'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createWebIdentityReferenceFixture } from '../tools/host-services-reference/test/fixtures/browser-reference.mjs'
import { REFERENCE_IDENTITY_GUEST } from './lib/web-reference-identity-browser.mjs'
import { ACCOUNT_CONTROLLER_GUEST } from './lib/web-account-controller-browser.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',')}}`
  : JSON.stringify(value)
const safe = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !/[\\\x00-\x20\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
const describe = (path, bytes) => ({ path, sha256: sha(bytes), size: bytes.length })
const METRICS = { windowWidth: 375, windowHeight: 667, pixelRatio: 1, screenWidth: 1100, screenHeight: 900, statusBarHeight: 0, screenTop: 0, deviceOrientation: 'portrait' }
let execution

async function boundedFile(path, expected) {
  const info = await lstat(path)
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= 256 * 1024 * 1024, `Not a bounded ordinary file: ${path}`)
  const bytes = await readFile(path)
  if (expected) { assert.equal(bytes.length, expected.size ?? expected.bytes, `File size changed: ${path}`); assert.equal(sha(bytes), expected.sha256, `File digest changed: ${path}`) }
  return bytes
}
async function put(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: 'wx' }) }
async function writeJson(path, value) { await put(path, jsonBytes(value)) }

async function installation(candidate, mode, sourceCommit, freshInstalled) {
  const producer = resolve(candidate, `web-${mode}-release`), distribution = resolve(candidate, `web-${mode}-distribution`), installed = freshInstalled
  const reportBytes = await boundedFile(resolve(producer, 'build-report.json')), report = JSON.parse(reportBytes)
  assert.equal(report.status, 'passed'); assert.equal(report.plan.profile, 'release')
  assert.equal(report.plan.target, 'wasm32-unknown-unknown')
  assert.deepEqual([...report.plan.features].sort(), ['quickjs-native', 'wasm'])
  assert.equal(report.source.sourceCommit, sourceCommit); assert.equal(report.source.workingTreeDirty, false)
  assert.equal(report.source.sourceStable, true); assert.equal(report.source.status, 'passed')
  assert.equal(Object.keys(report.customBuildEnvironment ?? {}).length, 0)
  assert(report.commands.length && report.commands.every(command => command.status === 'passed'))
  const manifestBytes = await boundedFile(resolve(distribution, 'web-runtime-artifacts.lock.json')), manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.format, 'weapp-container-platform-artifacts/1'); assert.equal(manifest.family, 'web'); assert.equal(manifest.runtimeVersion, '0.1.0-preview.6.0')
  const artifacts = manifest.artifacts.filter(artifact => artifact.coordinate === `web/${mode}/canvaskit`)
  assert.equal(artifacts.length, 1)
  const artifact = artifacts[0]
  assert(safe(artifact.fileName) && !artifact.fileName.includes('/'))
  assert.equal(artifact.sourceCommit, sourceCommit); assert.equal(artifact.producerReportSha256, sha(reportBytes))
  const archive = await boundedFile(resolve(distribution, artifact.fileName), artifact)
  const installBytes = await boundedFile(resolve(installed, '.runtime-install.json')), install = JSON.parse(installBytes)
  assert.equal(install.schemaVersion, 1)
  assert.equal(install.archiveSha256, artifact.sha256, 'Installation receipt refers to another archive')
  assert.deepEqual(install.identity, { coordinate: artifact.coordinate, family: 'web', runtimeVersion: manifest.runtimeVersion })
  const normalized = files => files.filter(file => file.sha256).map(({ path, size, sha256 }) => ({ path, size, sha256 })).sort((a, b) => a.path.localeCompare(b.path))
  assert.deepEqual(normalized(install.files), normalized(artifact.files), 'Fresh installation differs from archive manifest')
  const files = new Map()
  for (const file of artifact.files) {
    assert(safe(file.path), 'Unsafe installed file path')
    assert(!files.has(file.path), 'Duplicate installed file')
    files.set(file.path, await boundedFile(resolve(installed, file.path), file))
  }
  const receiptBytes = files.get('release-receipt.json'), receipt = JSON.parse(receiptBytes)
  assert.equal(receipt.source.sourceCommit, sourceCommit); assert.equal(receipt.source.sourceDirty, false)
  assert.equal(receipt.sdkVersion, manifest.runtimeVersion); assert.equal(receipt.execution, mode)
  assert.equal(receipt.coordinate, artifact.coordinate); assert.equal(receipt.producerReceipt.sha256, sha(reportBytes))
  assert.equal(receipt.archiveTool.sourceCommit, sourceCommit); assert.equal(receipt.archiveTool.sourceDirty, false)
  assert.equal(receipt.producerReceipt.size, reportBytes.length)
  assert.deepEqual(normalized(receipt.files), normalized(artifact.files.filter(file => file.path !== 'release-receipt.json')))
  for (const [path, expected] of Object.entries(report.source.sourceFiles)) {
    assert(safe(path))
    assert.equal(sha(await boundedFile(resolve(report.source.snapshotDirectory, path))), expected, `Producer source snapshot changed: ${path}`)
  }
  return { mode, sourceCommit, producer, distribution, installed, reportBytes, report, manifestBytes, artifact, archive, installBytes, receiptBytes, receipt, files }
}

async function sourceClosure(installs, commit, extraPaths) {
  const modules = execFileSync('rtk', ['proxy', 'git', 'show', `${commit}:.gitmodules`], { cwd: ROOT, encoding: 'utf8' })
  const repositories = [...modules.matchAll(/^\s*path\s*=\s*(\S+)\s*$/gm)].map(match => match[1]).sort((a, b) => b.length - a.length)
  const pins = new Map()
  const files = new Map()
  for (const install of installs) for (const [path, digest] of Object.entries(install.report.source.sourceFiles)) {
    assert(!files.has(path) || files.get(path).digest === digest, 'Two producers disagree on source bytes')
    files.set(path, { digest, commit })
  }
  for (const install of installs) for (const source of install.receipt.archiveTool.files) {
    assert(safe(source.path) && /^[a-f0-9]{64}$/.test(source.sha256), 'Invalid archive tool source binding')
    assert(!files.has(source.path) || files.get(source.path).digest === source.sha256, 'Producer and archive tool disagree on source bytes')
    files.set(source.path, { digest: source.sha256, commit: install.receipt.archiveTool.sourceCommit })
  }
  const testCommit = execFileSync('rtk', ['proxy', 'git', 'rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  for (const path of extraPaths) {
    const digest = sha(await boundedFile(resolve(ROOT, path)))
    assert(!files.has(path) || files.get(path).digest === digest, 'Test source overlaps changed product source')
    if (!files.has(path)) files.set(path, { digest, commit: testCommit })
  }
  const closure = []
  for (const [path, { digest, commit: fileCommit }] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const repository = repositories.find(repository => path.startsWith(repository + '/')) ?? '.'
    let sourceCommit = fileCommit, sourcePath = path
    if (repository !== '.') {
      const key = `${fileCommit}:${repository}`
      if (!pins.has(key)) pins.set(key, execFileSync('rtk', ['proxy', 'git', 'rev-parse', key], { cwd: ROOT, encoding: 'utf8' }).trim())
      sourceCommit = pins.get(key); sourcePath = path.slice(repository.length + 1)
    }
    const committed = execFileSync('rtk', ['proxy', 'git', 'show', `${sourceCommit}:${sourcePath}`], { cwd: resolve(ROOT, repository), maxBuffer: 16 * 1024 * 1024 })
    assert.equal(sha(committed), digest, `Source is not committed in candidate: ${path}`)
    assert.equal(sha(await boundedFile(resolve(ROOT, path))), digest, `Current source differs from candidate: ${path}`)
    closure.push({ repository, path: sourcePath, commit: sourceCommit, sha256: digest })
  }
  return closure
}

function derivePack(install, guest, policies = {}) {
  const index = JSON.parse(install.files.get('pack-index.json')), manifest = JSON.parse(install.files.get(`portable-pack/manifest.json`))
  assert.equal(sha(install.files.get('portable-pack/manifest.json')), index.manifestSha256)
  const entry = manifest.modules.find(module => module.id.replace(/^module:/, '') === manifest.app.entryModule.replace(/^module:/, ''))
  assert.equal(entry.format, 'commonjs')
  const module = Buffer.concat([install.files.get(`portable-pack/blobs/sha256/${entry.sha256}`), Buffer.from('\n'), Buffer.from(guest)])
  entry.sha256 = sha(module)
  Object.assign(manifest.capabilities, policies)
  manifest.integrity.root = ''; manifest.integrity.root = sha(Buffer.from(canonical(manifest)))
  const manifestBytes = Buffer.from(canonical(manifest))
  const blobs = [...index.blobs.filter(blob => blob.sha256 !== sha(module)), { sha256: sha(module), url: `portable-pack/blobs/sha256/${sha(module)}`, size: module.length }]
  const nextIndex = { ...index, manifestSha256: sha(manifestBytes), integrityRoot: manifest.integrity.root, blobs }
  const files = new Map([['pack-index.json', jsonBytes(nextIndex)], ['portable-pack/manifest.json', manifestBytes]])
  for (const blob of blobs) {
    const bytes = blob.sha256 === sha(module) ? module : install.files.get(blob.url)
    assert(bytes && sha(bytes) === blob.sha256 && bytes.length === blob.size)
    files.set(blob.url, bytes)
  }
  return { files, root: manifest.integrity.root, moduleSha256: sha(module), guestSha256: sha(Buffer.from(guest)) }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { 'candidate-root': { type: 'string' }, 'source-commit': { type: 'string' }, out: { type: 'string' }, 'playwright-module': { type: 'string' }, 'prepare-only': { type: 'boolean' } }, strict: true })
  assert(values['candidate-root'] && values.out && /^[a-f0-9]{40}$/.test(values['source-commit'] ?? ''), '--candidate-root --source-commit --out are required')
  assert.equal(process.versions.node.split('.')[0], '24', 'Acceptance requires the locked Node.js 24 reference backend')
  const candidate = await realpath(resolve(values['candidate-root'])), sourceCommit = values['source-commit'], out = resolve(values.out), outRelative = relative(ROOT, out)
  assert(safe(outRelative) && outRelative.startsWith('docs/host-services/evidence/'), 'A new repository evidence directory is required')
  await mkdir(out)
  execution = { out, command: ['rtk', 'proxy', 'node', 'scripts/verify-web-account-controller.mjs', ...argv], sourceCommit, startedAt: new Date().toISOString(), browserStarted: false }
  const manifest = JSON.parse(await boundedFile(resolve(candidate, 'web-worker-distribution/web-runtime-artifacts.lock.json')))
  const artifact = manifest.artifacts.find(artifact => artifact.coordinate === 'web/worker/canvaskit')
  assert(artifact && safe(artifact.fileName) && !artifact.fileName.includes('/'))
  const freshInstalled = resolve(candidate, 'controller-installs', basename(out))
  await mkdir(dirname(freshInstalled), { recursive: true })
  execFileSync('rtk', ['proxy', 'python3', 'sdk/contract/tools/unpack-runtime.py', '--archive', resolve(candidate, 'web-worker-distribution', artifact.fileName), '--destination', freshInstalled, '--sha256', artifact.sha256, '--identity-json', JSON.stringify({ coordinate: artifact.coordinate, family: 'web', runtimeVersion: '0.1.0-preview.6.0' })], { cwd: ROOT, maxBuffer: 1024 * 1024 })
  const install = await installation(candidate, 'worker', sourceCommit, freshInstalled)
  const testPaths = ['scripts/verify-web-account-controller.mjs', 'scripts/lib/web-account-controller-browser.mjs', 'scripts/lib/web-acceptance-scope-browser.mjs', 'scripts/lib/web-reference-identity-browser.mjs', 'tools/host-services-reference/test/fixtures/browser-reference.mjs', ...['service', 'server', 'crypto', 'errors', 'providers', 'consent-v2'].map(name => `tools/host-services-reference/src/${name}.ts`)]
  const sources = await sourceClosure([install], sourceCommit, testPaths)
  const pack = derivePack(install, REFERENCE_IDENTITY_GUEST + ACCOUNT_CONTROLLER_GUEST, Object.fromEntries(['wx.login', 'wx.checkSession', 'wx.request', 'wx.getLaunchOptionsSync', 'wx.createSelectorQuery', 'getCurrentPages', 'weappContainer.identity.getState', 'weappContainer.identity.onChange', 'weappContainer.identity.offChange', 'weappContainer.identity.logout'].map(api => [api, 'full'])))
  const files = new Map([...install.files].map(([path, bytes]) => [`/worker/${path}`, bytes]))
  for (const [path, bytes] of pack.files) files.set(`/packs/controller/${path}`, bytes)
  files.set('/probe.html', Buffer.from('<!doctype html><meta charset="utf-8"><title>Installed Worker account controller acceptance</title><style>body{margin:0;background:#edf1f5}section{overflow:hidden}</style>'))
  files.set('/favicon.ico', Buffer.alloc(0))
  files.set('/catalog.json', await boundedFile(resolve(ROOT, 'crates/container-runtime/src/host-api-catalog.json')))
  for (const name of ['web-account-controller-browser', 'web-acceptance-scope-browser']) files.set(`/harness/${name}.mjs`, await boundedFile(resolve(ROOT, `scripts/lib/${name}.mjs`)))
  for (const [path, bytes] of [['build-report.json', install.reportBytes], ['release-receipt.json', install.receiptBytes], ['runtime-artifacts.lock.json', install.manifestBytes], ['runtime-install.json', install.installBytes]]) await put(resolve(out, 'origin', path), bytes)
  for (const path of ['pack-index.json', 'portable-pack/manifest.json', `portable-pack/blobs/sha256/${pack.moduleSha256}`]) await put(resolve(out, 'fixture', path), pack.files.get(path))
  await writeJson(resolve(out, 'source-inputs.json'), { sourceCommit, sources })
  await writeJson(resolve(out, 'packaging.json'), { classification: 'fresh-unmodified-worker-release-installation', sourceCommit, coordinate: artifact.coordinate, archive: describe(artifact.fileName, install.archive), runtime: describe('pkg/container_host_web_bg.wasm', install.files.get('pkg/container_host_web_bg.wasm')), installedFiles: install.files.size, fixture: { integrityRoot: pack.root, moduleSha256: pack.moduleSha256, guestSha256: pack.guestSha256 }, sourceOverlay: false })
  if (values['prepare-only']) { await writeJson(resolve(out, 'prepared.json'), { status: 'prepared-only', browserStarted: false, acceptance: 'not-run' }); return }
  const report = { schemaVersion: 1, status: 'running', classification: 'finite-installed-worker-account-controller-presentation', sourceCommit, startedAt: new Date().toISOString(), headless: true, environment: { node: process.versions.node, os: { name: 'macOS', version: execFileSync('rtk', ['proxy', 'sw_vers', '-productVersion'], { encoding: 'utf8' }).trim(), kernel: release(), architecture: arch() } }, requests: [], pageErrors: [], realInputs: [], cleanup: { status: 'pending', resources: [] } }
  const resources = report.cleanup.resources
  const own = (kind, id) => resources.push({ kind, id, ownership: 'created', terminal: 'open' })
  const saveOwnership = () => writeFile(resolve(out, 'ownership.json'), jsonBytes({ owner: 'next_web_scope', resources }))
  let browser, context, page, server, fixture, origin, timer
  try {
    fixture = createWebIdentityReferenceFixture({ applications: ['controller-worker-one', 'controller-worker-two'].map(miniAppId => ({ miniAppId, packRoot: pack.root })) })
    own('reference-backend', 'Node24-SQLite-account-controller-fixture')
    server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname, entry = { path, method: request.method, status: 'pending' }
      report.requests.push(entry)
      response.once('finish', () => { entry.status = response.statusCode })
      response.once('close', () => { if (entry.status === 'pending') entry.status = response.writableFinished ? response.statusCode : 'client-aborted' })
      try {
        if (await fixture.handle(request, response)) { entry.kind = 'reference-backend'; return }
        entry.kind = 'installed-static'
        const bytes = files.get(path)
        if (!bytes) { response.writeHead(404); response.end('outside exact installed closure'); return }
        Object.assign(entry, describe(path, bytes))
        response.writeHead(200, { 'Content-Type': ({ js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', json: 'application/json', html: 'text/html', ttf: 'font/ttf' })[path.split('.').at(-1)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(bytes)
      } catch (error) { entry.error = String(error); response.writeHead(500); response.end('acceptance server failed') }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`
    own('loopback-server', origin); fixture.bindOrigin(origin); await saveOwnership()
    const playwright = await import(values['playwright-module'] ? pathToFileURL(resolve(values['playwright-module'])).href : process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE ?? 'playwright-core')
    browser = await playwright.chromium.launch({ channel: 'chrome', headless: true }); execution.browserStarted = true; own('browser', `standalone-headless-Chrome-${browser.version()}`); await saveOwnership()
    context = await browser.newContext({ viewport: { width: 1100, height: 900 } }); own('context', 'one-isolated-account-controller-context'); await saveOwnership()
    page = await context.newPage(); own('page', `${origin}/probe.html`); await saveOwnership(); page.setDefaultTimeout(45000)
    page.on('pageerror', error => report.pageErrors.push(String(error)))
    page.on('dialog', async dialog => { report.pageErrors.push(`Unexpected ${dialog.type()} dialog`); await dialog.dismiss() })
    await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin) return route.continue(); report.requests.push({ path: url.href, status: 'blocked-off-origin' }); return route.abort() })
    await page.exposeBinding('__accountControllerClick', async (_source, coordinate) => {
      assert(Number.isFinite(coordinate.x) && Number.isFinite(coordinate.y) && coordinate.x > 0 && coordinate.x < 1100 && coordinate.y > 0 && coordinate.y < 900)
      const path = `screenshots/real-input-${report.realInputs.length + 1}.png`
      await mkdir(resolve(out, 'screenshots'), { recursive: true })
      await page.screenshot({ path: resolve(out, path) })
      await page.mouse.click(coordinate.x, coordinate.y)
      report.realInputs.push({ coordinate, screenshot: describe(`${outRelative}/${path}`, await boundedFile(resolve(out, path))), mechanism: 'real Playwright mouse pointer through the original canvas input helper and native event.batch' })
    })
    await page.goto(`${origin}/probe.html`)
    report.environment.browser = { name: 'Chrome', version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent) }
    const indexSha256 = sha(pack.files.get('pack-index.json'))
    report.scope = await Promise.race([
      page.evaluate(async ({ metrics, controlToken, indexSha256 }) => { globalThis.__accountControllerIndexSha256 = indexSha256; return (await import('/harness/web-account-controller-browser.mjs')).runAccountController({ metrics, controlToken }) }, { metrics: METRICS, controlToken: fixture.controlToken, indexSha256 }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Account controller browser scope exceeded 180 seconds')), 180000) }),
    ])
    clearTimeout(timer)
    assert.equal(report.scope.status, 'passed'); assert.equal(report.scope.closedAllOwners, true)
    assert.equal(report.scope.owners.length, 5); assert.equal(report.scope.cleanup.length, 5)
    assert.equal(report.realInputs.length, 2)
    assert(report.scope.cleanup.every(resource => resource.terminal === 'closed'))
    assert.deepEqual(report.pageErrors, [])
    assert(report.requests.filter(request => request.kind === 'installed-static').every(request => request.status === 200))
    assert(!report.requests.some(request => request.status === 'blocked-off-origin' || request.error))
    await sourceClosure([install], sourceCommit, testPaths)
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack ?? error)
    if (page && !page.isClosed()) try { report.scope ??= await page.evaluate(() => globalThis.__accountControllerScope) } catch (partialError) { report.partialReadError = String(partialError) }
  } finally {
    clearTimeout(timer)
    const failures = []
    for (const [kind, close, verify] of [
      ['page', async () => { if (page && !page.isClosed()) await page.close() }, () => !page || page.isClosed()],
      ['context', async () => { if (context) await context.close() }, () => !context || context.pages().length === 0],
      ['browser', async () => { if (browser) await browser.close() }, () => !browser || !browser.isConnected()],
      ['reference-backend', async () => { if (fixture) { await fixture.close(); report.backend = fixture.observations() } }, () => !fixture || fixture.observations().activeRequests === 0 && !fixture.observations().delay.pending],
      ['loopback-server', async () => { if (server?.listening) await new Promise((done, failed) => server.close(error => error ? failed(error) : done())) }, () => !server?.listening],
    ]) {
      const entry = resources.find(resource => resource.kind === kind)
      try { await close(); assert(verify()); if (entry) entry.terminal = 'closed' }
      catch (error) { failures.push({ kind, error: String(error) }); if (entry) { entry.terminal = 'failed'; entry.error = String(error) } }
    }
    report.cleanup.status = failures.length ? 'failed' : 'complete'; report.cleanup.errors = failures
    if (failures.length) report.status = 'failed'
    report.finishedAt = new Date().toISOString(); await saveOwnership()
    await writeJson(resolve(out, 'controller-report.json'), report)
    await put(resolve(out, 'browser-execution.log'), jsonBytes(report))
  }
  assert.equal(report.status, 'passed', `Account controller acceptance failed; retained ${out}: ${report.error ?? JSON.stringify(report.cleanup.errors)}`)
  await writeJson(resolve(out, 'acceptance-summary.json'), { schemaVersion: 1, classification: report.classification, status: report.status, sourceCommit, runtime: describe('pkg/container_host_web_bg.wasm', install.files.get('pkg/container_host_web_bg.wasm')), sdk: { coordinate: artifact.coordinate, ...describe(artifact.fileName, install.archive) }, sources, execution: { command: execution.command, exitCode: 0, log: describe(`${outRelative}/browser-execution.log`, jsonBytes(report)) }, checks: report.scope.checks, limitations: report.scope.limitations, environment: report.environment, cleanup: { status: 'complete', resources: [...report.scope.cleanup, ...resources] } })
  console.log(JSON.stringify({ status: report.status, out, ownerCount: report.scope.owners.length, inputCount: report.realInputs.length, cleanup: report.cleanup.status }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(async error => {
  console.error(error.stack ?? error); process.exitCode = 1
  if (execution) await writeJson(resolve(execution.out, 'runner-failure.json'), { schemaVersion: 1, status: 'failed', ...execution, finishedAt: new Date().toISOString(), exitCode: 1, error: String(error.stack ?? error), cleanup: execution.browserStarted ? 'See controller-report.json and ownership.json' : { status: 'complete', resources: [] } })
})
