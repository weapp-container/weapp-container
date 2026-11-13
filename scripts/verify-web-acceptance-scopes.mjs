#!/usr/bin/env node
// Real browser acceptance from a new, independently installed clean release.
// Historical reports are test specifications only; none are rewritten/relabelled.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { arch, release } from 'node:os'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createWebIdentityReferenceFixture } from '../tools/host-services-reference/test/fixtures/browser-reference.mjs'
import { REFERENCE_IDENTITY_GUEST } from './lib/web-reference-identity-browser.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let executionContext
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',')}}`
  : JSON.stringify(value)
const safe = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !/[\\\x00-\x20\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
const describe = (path, bytes) => ({ path, sha256: sha(bytes), size: bytes.length })
const METRICS = { windowWidth: 1100, windowHeight: 900, pixelRatio: 1, screenWidth: 1100, screenHeight: 900, statusBarHeight: 0, screenTop: 0, deviceOrientation: 'landscape' }
const HISTORY = 'docs/host-services/evidence/2026-11-03-web-base64-scope'
const HELP = `Usage: rtk proxy node scripts/verify-web-acceptance-scopes.mjs
  --candidate-root <new release/archive/install root> --source-commit <clean 40-hex commit>
  --out <new repository evidence directory> [--scopes existing|identity|all]
  [--playwright-module <playwright-core module>] [--prepare-only] [--typography]

The candidate must contain web-{direct,worker}-release/build-report.json,
web-{direct,worker}-distribution/web-runtime-artifacts.lock.json and independent
web-{direct,worker}-installed directories. No source overlay or old evidence output
is accepted. --prepare-only never starts a browser or emits acceptance reports.
`
const SCOPE_API = {
  'window-info': 'wx.getWindowInfo', 'system-setting': 'wx.getSystemSetting',
  'app-base-info': 'wx.getAppBaseInfo', 'device-info': 'wx.getDeviceInfo',
  'app-authorize-setting': 'wx.getAppAuthorizeSetting', network: 'wx.getNetworkType',
  clipboard: 'wx.setClipboardData', 'get-clipboard': 'wx.getClipboardData', 'get-setting': 'wx.getSetting',
}
const SCOPE_CHECKS = {
  codec: ['synchronousReturns', 'allByteValues', 'lengthResidues', 'browserOracle', 'paddedAndUnpadded', 'invalidParameters', 'capabilityDenial', 'privateHelpers', 'globalSpoofIgnored', 'ownerReloadIsolation', 'canIUseFiniteSchemas'],
  'window-info': ['synchronousReturns', 'completeWindowInfoShape', 'currentMetricsMatch'],
  'system-setting': ['synchronousReturns', 'completeSystemSettingShape', 'currentOrientationMatch'],
  'app-base-info': ['synchronousReturns', 'completeAppBaseInfoShape', 'currentMetadataMatch'],
  'device-info': ['synchronousReturns', 'completeDeviceInfoShape', 'currentDeviceInfoMatch'],
  'app-authorize-setting': ['synchronousReturns', 'finiteAuthorizeSettingShape', 'currentPermissionSnapshotMatch'],
  network: ['asyncResult', 'mappedNetworkType'], clipboard: ['asyncResult', 'clipboardRoundTrip'],
  'get-clipboard': ['asyncResult', 'clipboardRead'], 'get-setting': ['asyncResult', 'permissionSnapshot'],
}
const IDENTITY_CHECKS = ['realReferenceBackend', 'singleUse', 'wrongApplicationRejectedWithoutConsumption', 'redeemedSession', 'independentConsentBeforeLogin', 'profileDeniedThenGranted', 'previousConsentRevokedOnDenial', 'backendLogoutSnapshotFalse', 'rawInvalidSessionPreserved', 'checkSessionRefreshesTrue', 'retainedConsentAfterLogout', 'siblingAppUnaffected', 'pairwiseAppUsers', 'sameOwnerCredentialRefresh', 'oldOwnerGuestDataDiscarded', 'delayedRealBackendResultRetired', 'newAccountIsolated']
function identityContracts(sources, commit) {
  const parameters = {
    'wx.login': 'No-argument login using callback/complete and Promise with a trusted installed application, Alice/Bob and exact decimal epochs 9007199254740993/9007199254740994. A real Node24/SQLite one-time code is issued, confidentially exchanged by a same-origin business backend, rejected for a different application without consumption and rejected on reuse. A delayed issued response is retired before Bob starts. No WeChat openid/session_key, production authentication, phone, arbitrary timeout values or real-time expiry wait is claimed.',
    'wx.checkSession': 'No-argument callback/Promise check against the real reference service: code issuance without exchange fails; confidential exchange succeeds and refreshes the synchronous identity snapshot; independent business-backend logout preserves the original invalid_app_session error while refreshing appLoggedIn=false; reauthentication restores true; app1 retirement leaves app2 live. This partial reference scope does not claim production host credentials, every backend error or full account-controller/presentation switching.',
    'wx.getUserProfile': 'A desc string and callback/Promise request use the real browser confirm dialog and the registered backend purpose/profile-v1. Alice is denied, granted, denied again after prior consent, and reauthorized. Denial carries errCode 2001, revokes the old snapshot/disclosure and keeps host login; authorized nickName is Alice even before application login. App logout retains separately granted consent. No arbitrary profile fields, real production identity, phone or system permission UI is claimed.',
  }
  return Object.entries(parameters).map(([api, parameters]) => ({ host: 'web', api,
    review: { status: 'pending', basis: 'New finite source/archive-bound real-browser scope; independent review is required before promotion.' }, baselineCoverage: 'partialScope',
    profiles: [{ id: `web-reference-${api.slice(3).toLowerCase()}-finite-installed-${commit.slice(0, 8)}`, parameters,
      platformConditions: ['', 'QuickJS executes through the original installed direct WebWasmHost or WorkerRpcClient -> runtime-worker.mjs with its own installed BrowserHostServices/reference identity client.', '', 'Real same-origin HTTP and SQLite use controlled reference principal records and confidential Node-side app credentials. Native owners close/recreate explicitly; no controller/presentation, physical hardware, production identity, phone or merchant acceptance is claimed.'],
      sdks: ['direct', 'worker'], engines: ['quickjs'], requiredChecks: [...IDENTITY_CHECKS, 'directChain', 'workerChain', 'exactFreshArtifactBytes', 'completeExecutedModuleClosure', 'noAmbientDependencies'], requiredCapabilities: [], sources: sources.map(({ repository, path }) => ({ repository, path })) }],
  }))
}

async function boundedFile(path, expected) {
  const info = await lstat(path)
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= 256 * 1024 * 1024, `Not a bounded ordinary file: ${path}`)
  const bytes = await readFile(path)
  if (expected) { assert.equal(bytes.length, expected.size ?? expected.bytes, `File size changed: ${path}`); assert.equal(sha(bytes), expected.sha256, `File digest changed: ${path}`) }
  return bytes
}
async function put(path, bytes) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: 'wx' }) }
async function writeJson(path, value) { await put(path, jsonBytes(value)) }

async function installation(candidate, mode, sourceCommit) {
  const producer = resolve(candidate, `web-${mode}-release`), distribution = resolve(candidate, `web-${mode}-distribution`), installed = resolve(candidate, `web-${mode}-installed`)
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
function guestFor(scope) {
  const api = SCOPE_API[scope]
  if (!['network', 'clipboard', 'get-clipboard', 'get-setting'].includes(scope)) return `exports.__acceptanceProbe=function(){return ${api}();};`
  const payload = scope === 'clipboard' ? "{data:'weapp-clipboard-scope',success:good,fail:bad}" : '{success:good,fail:bad}'
  return `var __acceptanceValue=null,__acceptanceError=null;exports.__acceptanceProbe=function(){function good(v){__acceptanceValue=v;}function bad(e){__acceptanceError=e;}${api}(${payload});return {started:true};};exports.__acceptanceRead=function(){return {value:__acceptanceValue,error:__acceptanceError};};`
}

async function codecInstallation(installs, out, sourceCommit) {
  const files = new Map(), worker = installs.find(install => install.mode === 'worker'), direct = installs.find(install => install.mode === 'direct')
  const visit = path => {
    if (files.has(path)) return
    assert(safe(path)); const bytes = worker.files.get(path); assert(bytes, `Missing codec dependency: ${path}`)
    assert.equal(sha(bytes), sha(direct.files.get(path)), 'Public direct/Worker codec modules differ')
    files.set(path, bytes)
    for (const match of bytes.toString('utf8').matchAll(/\b(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      assert(match[1].startsWith('./') || match[1].startsWith('../'), 'Ambient codec module import')
      visit(relative('/sdk', resolve('/sdk', dirname(path), match[1])))
    }
  }
  for (const path of ['pkg/container_host_web.js', 'worker-session-client.mjs', 'runtime-worker.mjs']) visit(path)
  assert.deepEqual([...files.keys()].sort(), ['host-api-binary-wire.mjs', 'input-causal-ledger.mjs', 'pkg/container_host_web.js', 'render-inputs.mjs', 'runtime-worker.mjs', 'worker-frame-wire.mjs', 'worker-runtime.mjs', 'worker-session-client.mjs'])
  const runtime = worker.files.get('pkg/container_host_web_bg.wasm')
  assert.equal(sha(runtime), sha(direct.files.get('pkg/container_host_web_bg.wasm')))
  for (const path of ['pkg/container_host_web.d.ts', 'pkg/container_host_web_bg.wasm.d.ts', ...[...worker.files.keys()].filter(path => path === 'RUNTIME-LICENSE' || path.startsWith('licenses/'))]) files.set(path, worker.files.get(path))
  for (const install of installs) files.set(`origin/${install.mode}-release-receipt.json`, install.receiptBytes)
  const scopeManifest = { schemaVersion: 1, kind: 'unmodified-public-sdk-execution-closure', sourceCommit, publicEntries: ['pkg/container_host_web.js#WebWasmHost', 'worker-session-client.mjs#WorkerRpcClient->runtime-worker.mjs'], runtime: describe('pkg/container_host_web_bg.wasm', runtime), files: [...files].map(([path, bytes]) => describe(path, bytes)), excludedDependencies: ['CanvasKit', 'font', 'presenter', 'WorkerWebSession'] }
  files.set('scope-manifest.json', jsonBytes(scopeManifest))
  const stage = resolve(out, 'codec/staging')
  for (const [path, bytes] of files) await put(resolve(stage, path), bytes)
  const archive = resolve(out, 'artifacts/public-base64-sdk-closure.tar.gz')
  const python = `import gzip,hashlib,io,json,pathlib,sys,tarfile
j=json.load(sys.stdin)
with open(j['archive'],'xb') as raw:
 with gzip.GzipFile(fileobj=raw,mode='wb',mtime=0,filename='') as gz:
  with tarfile.open(fileobj=gz,mode='w') as tar:
   for f in j['files']:
    b=(pathlib.Path(j['stage'])/f['path']).read_bytes();assert len(b)==f['size'] and hashlib.sha256(b).hexdigest()==f['sha256']
    i=tarfile.TarInfo(f['path']);i.size=len(b);i.mode=0o644;tar.addfile(i,io.BytesIO(b))
for mode in ['direct','worker']:
 root=pathlib.Path(j['out'])/('codec/'+mode+'-installed');assert not root.exists();root.mkdir(parents=True)
 with tarfile.open(j['archive'],'r:gz') as tar:
  members=tar.getmembers();assert set(m.name for m in members)==set(f['path'] for f in j['files'])
  expected={f['path']:f for f in j['files']}
  for m in members:
   assert m.isfile() and not m.name.startswith('/') and all(p not in ['', '.', '..'] for p in m.name.split('/'))
   b=tar.extractfile(m).read();f=expected[m.name];assert len(b)==f['size'] and hashlib.sha256(b).hexdigest()==f['sha256']
   dest=root/m.name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(b)
`
  execFileSync('rtk', ['proxy', 'python3', '-c', python], { input: JSON.stringify({ stage, archive, out, files: [...files].map(([path, bytes]) => describe(path, bytes)) }), maxBuffer: 1024 * 1024 })
  const installed = new Map()
  for (const mode of ['direct', 'worker']) {
    await put(resolve(out, `codec/${mode}-installed/pkg/container_host_web_bg.wasm`), runtime)
    for (const [path, expected] of new Map([...files, ['pkg/container_host_web_bg.wasm', runtime]])) installed.set(`/${mode}/${path}`, await boundedFile(resolve(out, `codec/${mode}-installed`, path), describe(path, expected)))
  }
  return { files: installed, archive: await boundedFile(archive), manifest: scopeManifest }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { 'candidate-root': { type: 'string' }, 'source-commit': { type: 'string' }, out: { type: 'string' }, scopes: { type: 'string', default: 'all' }, 'playwright-module': { type: 'string' }, 'prepare-only': { type: 'boolean' }, typography: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true })
  if (values.help) { console.log(HELP); return }
  assert(values['candidate-root'] && values.out && /^[a-f0-9]{40}$/.test(values['source-commit'] ?? ''), HELP)
  assert(['existing', 'identity', 'all'].includes(values.scopes), 'Unknown scope selection')
  assert.equal(process.versions.node.split('.')[0], '24', 'Acceptance requires the locked Node.js 24 reference backend')
  const existingSelected = values.scopes !== 'identity', identitySelected = values.scopes !== 'existing'
  const sourceCommit = values['source-commit'], candidate = await realpath(resolve(values['candidate-root'])), out = resolve(values.out), outRelative = relative(ROOT, out)
  assert(safe(outRelative) && outRelative.startsWith('docs/host-services/evidence/'), 'Evidence output must be a new repository evidence directory')
  await mkdir(out); await mkdir(resolve(out, 'artifacts'))
  executionContext = { out, sourceCommit, command: ['rtk', 'proxy', 'node', 'scripts/verify-web-acceptance-scopes.mjs', ...argv], startedAt: new Date().toISOString(), browserStarted: false }
  const installs = await Promise.all(['direct', 'worker'].map(mode => installation(candidate, mode, sourceCommit)))
  assert.equal(sha(installs[0].files.get('pkg/container_host_web_bg.wasm')), sha(installs[1].files.get('pkg/container_host_web_bg.wasm')))
  const testPaths = ['scripts/verify-web-acceptance-scopes.mjs', 'scripts/lib/web-acceptance-scope-browser.mjs', 'scripts/lib/web-reference-identity-browser.mjs', `${HISTORY}/binary-browser-probe.mjs`, `${HISTORY}/binary-guest-fixture.js`, 'tools/host-services-reference/test/fixtures/browser-reference.mjs', ...['service', 'server', 'crypto', 'errors', 'providers', 'consent-v2'].map(name => `tools/host-services-reference/src/${name}.ts`)]
  if (values.typography) testPaths.push('scripts/lib/web-font-browser-scope.mjs')
  const sources = await sourceClosure(installs, sourceCommit, testPaths)
  const report = { schemaVersion: 1, status: 'running', classification: 'new-clean-release-real-installed-public-web-sdk-scopes', sourceCommit, candidate, startedAt: new Date().toISOString(), headless: true, selection: values.scopes, environment: { node: process.versions.node, os: { name: 'macOS', version: execFileSync('rtk', ['proxy', 'sw_vers', '-productVersion'], { encoding: 'utf8' }).trim(), kernel: release(), architecture: arch() } }, installations: {}, scopes: {}, requests: [], pageErrors: [], cleanup: { status: 'pending', resources: [] } }
  const fileMap = new Map([['/probe.html', Buffer.from('<!doctype html><title>Installed Web SDK acceptance</title>')], ['/favicon.ico', Buffer.alloc(0)]])
  if (values.typography) fileMap.set('/harness/web-font-browser-scope.mjs', await boundedFile(resolve(ROOT, 'scripts/lib/web-font-browser-scope.mjs')))
  const fixtureRecords = {}, derivedPacks = new Map(), applications = []
  const addPack = (prefix, fixture) => {
    fixtureRecords[prefix] = { integrityRoot: fixture.root, moduleSha256: fixture.moduleSha256, guestSha256: fixture.guestSha256 }
    derivedPacks.set(prefix, fixture)
    for (const [path, bytes] of fixture.files) fileMap.set(`${prefix}/${path}`, bytes)
  }
  for (const install of installs) {
    for (const [path, bytes] of install.files) fileMap.set(`/${install.mode}/${path}`, bytes)
    if (existingSelected) for (const scope of Object.keys(SCOPE_API)) addPack(`/fixtures/${scope}/${install.mode}`, derivePack(install, guestFor(scope)))
    if (identitySelected) {
      const identityPack = derivePack(install, REFERENCE_IDENTITY_GUEST, Object.fromEntries(['wx.login', 'wx.checkSession', 'wx.getUserProfile', 'wx.request', 'weappContainer.identity.getState', 'weappContainer.identity.onChange', 'weappContainer.identity.offChange', 'weappContainer.identity.logout'].map(api => [api, 'full'])))
      addPack(`/fixtures/identity/${install.mode}`, identityPack)
      for (const suffix of ['one', 'two']) applications.push({ miniAppId: `reference-${install.mode}-${suffix}`, packRoot: identityPack.root })
    }
    await put(resolve(out, `origin/${install.mode}-build-report.json`), install.reportBytes)
    await put(resolve(out, `origin/${install.mode}-release-receipt.json`), install.receiptBytes)
    await put(resolve(out, `origin/${install.mode}-runtime-artifacts.lock.json`), install.manifestBytes)
    await put(resolve(out, `origin/${install.mode}-runtime-install.json`), install.installBytes)
    await put(resolve(out, 'artifacts', install.artifact.fileName), install.archive)
    report.installations[install.mode] = { coordinate: install.artifact.coordinate, archiveSha256: sha(install.archive), producerReportSha256: sha(install.reportBytes), receiptSha256: sha(install.receiptBytes), files: install.files.size }
  }
  const catalogBytes = await boundedFile(resolve(ROOT, 'crates/container-runtime/src/host-api-catalog.json'))
  fileMap.set('/catalog.json', catalogBytes)
  fileMap.set('/harness/web-acceptance-scope-browser.mjs', await boundedFile(resolve(ROOT, 'scripts/lib/web-acceptance-scope-browser.mjs')))
  fileMap.set('/harness/web-reference-identity-browser.mjs', await boundedFile(resolve(ROOT, 'scripts/lib/web-reference-identity-browser.mjs')))
  const codec = await codecInstallation(installs, out, sourceCommit)
  const binaryGuest = await boundedFile(resolve(ROOT, `${HISTORY}/binary-guest-fixture.js`))
  for (const policy of ['enabled', 'denied']) addPack(`/binary/${policy}`, derivePack(installs[0], binaryGuest, { 'wx.arrayBufferToBase64': policy === 'enabled' ? 'full' : 'unsupported', 'wx.base64ToArrayBuffer': policy === 'enabled' ? 'full' : 'unsupported', 'wx.canIUse': 'full' }))
  const codecMap = new Map([...codec.files, ...[...fileMap].filter(([path]) => path.startsWith('/binary/') || path === '/probe.html' || path === '/favicon.ico')])
  codecMap.set('/binary-browser-probe.mjs', await boundedFile(resolve(ROOT, `${HISTORY}/binary-browser-probe.mjs`)))
  await writeJson(resolve(out, 'source-inputs.json'), { sourceCommit, sources })
  await writeJson(resolve(out, 'fixture-inputs.json'), fixtureRecords)
  // Preserve each changed fixture byte; unchanged blobs remain in the exact
  // copied SDK archive and are referenced by their original digest.
  for (const [prefix, fixture] of derivedPacks) for (const path of ['pack-index.json', 'portable-pack/manifest.json', `portable-pack/blobs/sha256/${fixture.moduleSha256}`]) await put(resolve(out, 'fixtures', prefix.slice(1), path), fixture.files.get(path))
  await writeJson(resolve(out, 'codec/packaging.json'), codec.manifest)
  if (values['prepare-only']) { await writeJson(resolve(out, 'prepared.json'), { status: 'prepared-only', sourceCommit, browserStarted: false, acceptance: 'not-run', installations: report.installations }); console.log(JSON.stringify({ status: 'prepared-only', out })); return }
  let browser, context, page, server, fixture, activeFiles = existingSelected ? codecMap : fileMap, currentScope = existingSelected ? 'codec' : 'identity', origin
  const dialogs = [], decisions = identitySelected ? [false, true, false, true, false, true, false, true] : []
  const resources = report.cleanup.resources
  const own = (kind, id) => resources.push({ kind, id, ownership: 'created', terminal: 'open' })
  const saveOwnership = () => writeFile(resolve(out, 'ownership.json'), jsonBytes({ owner: 'next_web_scope', resources }))
  try {
    if (identitySelected) fixture = createWebIdentityReferenceFixture({ applications })
    server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      const entry = { scope: currentScope, path, method: request.method, status: 'pending' }
      report.requests.push(entry)
      response.once('finish', () => { entry.status = response.statusCode })
      response.once('close', () => { if (entry.status === 'pending') entry.status = response.writableFinished ? response.statusCode : 'client-aborted' })
      try {
        if (fixture && await fixture.handle(request, response)) { entry.kind = 'reference-backend'; return }
        entry.kind = 'installed-static'
        const bytes = activeFiles.get(path)
        if (!bytes) { response.writeHead(404); response.end('not in exact installed scope'); return }
        Object.assign(entry, { sha256: sha(bytes), size: bytes.length })
        response.writeHead(200, { 'Content-Type': ({ js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', json: 'application/json', html: 'text/html', ttf: 'font/ttf' })[path.split('.').at(-1)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(bytes)
      } catch (error) { entry.error = String(error); response.writeHead(500); response.end('acceptance server failed') }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`
    own('loopback-server', origin)
    if (fixture) { fixture.bindOrigin(origin); own('reference-backend', 'Node24-SQLite-fixture') }
    await saveOwnership()
    const playwright = await import(values['playwright-module'] ? pathToFileURL(resolve(values['playwright-module'])).href : process.env.WEAPP_CONTAINER_PLAYWRIGHT_MODULE ?? 'playwright-core')
    browser = await playwright.chromium.launch({ channel: 'chrome', headless: true }); executionContext.browserStarted = true; own('browser', `standalone-headless-Chrome-${browser.version()}`); await saveOwnership()
    context = await browser.newContext({ viewport: { width: METRICS.windowWidth, height: METRICS.windowHeight } }); own('context', 'one-isolated-web-acceptance-context'); await saveOwnership()
    page = await context.newPage(); own('page', `${origin}/probe.html`); await saveOwnership(); page.setDefaultTimeout(45000)
    page.on('pageerror', error => report.pageErrors.push(String(error)))
    page.on('dialog', async dialog => {
      const accept = currentScope === 'identity' && decisions.length ? decisions.shift() : null
      dialogs.push({ type: dialog.type(), message: dialog.message(), accepted: accept })
      if (accept === true) await dialog.accept(); else await dialog.dismiss()
    })
    await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin) return route.continue(); report.requests.push({ scope: currentScope, path: url.href, status: 'blocked-off-origin' }); return route.abort() })
    await page.goto(`${origin}/probe.html`)
    report.environment.browser = { name: 'Chrome', version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent) }
    if (existingSelected) {
      report.scopes.codec = await page.evaluate(async () => (await import('/binary-browser-probe.mjs')).runBinaryBrowserProbe())
      assert.equal(report.scopes.codec.status, 'passed'); assert.equal(report.scopes.codec.cleanup.length, 4)
      assert(report.scopes.codec.cleanup.every(resource => resource.terminal === 'closed'))
      const codecRequests = report.requests.filter(request => request.scope === 'codec')
      assert(codecRequests.every(request => request.status === 200))
      assert(!codecRequests.some(request => /canvaskit|fonts|presenter/i.test(request.path)), 'Codec scope imported undeclared renderer dependency')
      assert.equal(new Set(codecRequests.filter(request => /\.(?:mjs|js)$/.test(request.path) && request.path !== '/binary-browser-probe.mjs').map(request => request.path)).size, 8)
      activeFiles = fileMap
      for (const scope of Object.keys(SCOPE_API)) {
        currentScope = scope
        await context.clearPermissions()
        if (scope === 'clipboard' || scope === 'get-clipboard') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
        if (scope === 'get-setting') await context.grantPermissions(['camera', 'microphone', 'geolocation'], { origin })
        await page.goto(`${origin}/probe.html`)
        report.scopes[scope] = await page.evaluate(async input => (await import('/harness/web-acceptance-scope-browser.mjs')).runBrowserScope(input), { scope, metrics: METRICS })
        assert(report.scopes[scope].cleanup.every(resource => resource.terminal === 'closed'))
        console.log(JSON.stringify({ scope, status: 'passed', modes: Object.keys(report.scopes[scope].modes) }))
      }
    }
    if (identitySelected) {
      currentScope = 'identity'; activeFiles = fileMap
      await context.clearPermissions(); await page.goto(`${origin}/probe.html`)
      report.scopes.identity = await page.evaluate(async input => (await import('/harness/web-reference-identity-browser.mjs')).runReferenceIdentity(input), { metrics: METRICS, controlToken: fixture.controlToken })
      assert.equal(report.scopes.identity.status, 'passed')
      assert.equal(report.scopes.identity.cleanup.length, 16)
      assert(report.scopes.identity.cleanup.every(resource => resource.terminal === 'closed'))
      assert.equal(decisions.length, 0); assert.equal(dialogs.length, 8)
      assert(dialogs.every(dialog => dialog.type === 'confirm' && typeof dialog.accepted === 'boolean' && dialog.message === 'profile (profile-v1): Display the authorized profile in this application'))
      report.dialogs = dialogs
      report.backend = fixture.observations()
      assert.equal(report.backend.delayedLoginResponses, 2)
      assert.equal(report.backend.delay.pending, false)
      console.log(JSON.stringify({ scope: 'identity', status: 'passed', modes: Object.keys(report.scopes.identity.modes) }))
    }
    if (values.typography) {
      currentScope = 'typography'; activeFiles = fileMap
      const screenshots = []
      await page.exposeFunction('__captureInstalledFontScreenshot', async ({ index, text }) => {
        assert.equal(index, screenshots.length + 1); assert(index <= 4)
        const path = `typography-${index}.png`
        await page.screenshot({ path: resolve(out, path) })
        screenshots.push({ index, text, ...describe(path, await boundedFile(resolve(out, path))) })
      })
      await context.clearPermissions(); await page.goto(`${origin}/direct/legacy.html`)
      report.scopes.typography = await page.evaluate(async () => (await import('/harness/web-font-browser-scope.mjs')).runInstalledFontScope())
      assert.equal(report.scopes.typography.status, 'passed'); assert.equal(screenshots.length, 4)
      report.scopes.typography.screenshots = screenshots
      console.log(JSON.stringify({ scope: 'typography', status: 'passed', samples: 4 }))
    }
    assert.deepEqual(report.pageErrors, [])
    assert(report.requests.filter(request => request.kind === 'installed-static').every(request => request.status === 200))
    assert(!report.requests.some(request => request.status === 'blocked-off-origin' || request.error))
    await sourceClosure(installs, sourceCommit, testPaths)
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.error = String(error?.stack ?? error)
    if (page && !page.isClosed()) try {
      const partial = await page.evaluate(() => ({ ordinary: globalThis.__webAcceptanceScope, identity: globalThis.__webReferenceIdentityScope, codec: globalThis.binaryProbeReport, typography: globalThis.__installedFontScope }))
      report.scopes[currentScope] ??= currentScope === 'identity' ? partial.identity : currentScope === 'codec' ? partial.codec : currentScope === 'typography' ? partial.typography : partial.ordinary
    } catch (partialError) { report.partialReadError = String(partialError) }
  }
  finally {
    const failures = []
    for (const [kind, close, verify] of [
      ['page', async () => { if (page && !page.isClosed()) await page.close() }, () => !page || page.isClosed()],
      ['context', async () => { if (context) await context.close() }, () => !context || context.pages().length === 0],
      ['browser', async () => { if (browser) await browser.close() }, () => !browser || !browser.isConnected()],
      ['reference-backend', async () => { if (fixture) { await fixture.close(); report.backendAfterClose = fixture.observations() } }, () => !fixture || fixture.observations().activeRequests === 0 && fixture.observations().delay.pending === false],
      ['loopback-server', async () => { if (server?.listening) await new Promise((done, failed) => server.close(error => error ? failed(error) : done())) }, () => !server?.listening],
    ]) {
      const entry = resources.find(resource => resource.kind === kind)
      try { await close(); assert(verify()); if (entry) entry.terminal = 'closed' }
      catch (error) { failures.push({ kind, error: String(error) }); if (entry) { entry.terminal = 'failed'; entry.error = String(error) } }
    }
    report.cleanup.status = failures.length ? 'failed' : 'complete'; report.cleanup.errors = failures
    if (failures.length) report.status = 'failed'
    report.finishedAt = new Date().toISOString(); await saveOwnership()
    await writeJson(resolve(out, 'browser-report.json'), report)
    await put(resolve(out, 'browser-execution.log'), jsonBytes(report))
  }
  if (report.status !== 'passed') throw new Error(`Web acceptance failed: ${report.error ?? JSON.stringify(report.cleanup.errors)}; evidence retained at ${out}`)
  await emitReports({ out, outRelative, sourceCommit, installs, sources, codec, report, argv })
  console.log(JSON.stringify({ status: report.status, out, reports: (existingSelected ? 24 : 0) + (identitySelected ? 6 : 0), cleanup: report.cleanup.status }))
}

async function emitReports({ out, outRelative, sourceCommit, installs, sources, codec, report, argv }) {
  const contracts = JSON.parse(await readFile(resolve(ROOT, 'docs/host-services/acceptance-contracts.json')))
  const ledger = { schemaVersion: 1, catalogNamesSha256: contracts.catalogNamesSha256, catalogSha256: contracts.catalogSha256, reports: [] }
  const runtimeBytes = installs[0].files.get('pkg/container_host_web_bg.wasm')
  await put(resolve(out, 'artifacts/container_host_web_bg.wasm'), runtimeBytes)
  const artifact = async (role, mode, bytes, path, architecture, suffix = '') => {
    const receiptPath = `${outRelative}/receipts/${role}-${mode}${suffix}.json`
    const value = { role, host: 'web', version: '0.1.0-preview.6.0', architecture, features: ['wasm', 'quickjs-native'], protocolVersion: '1.0', repository: '.', sourceCommit, ...describe(path, bytes), ...(role === 'sdk' ? { sdk: mode } : {}) }
    const receiptBytes = jsonBytes({ ...value, cleanSource: true, profile: 'release', producerReport: { path: `${outRelative}/origin/${mode}-build-report.json`, sha256: sha(installs.find(install => install.mode === mode).reportBytes) } })
    await put(resolve(ROOT, receiptPath), receiptBytes)
    return { ...value, buildReceipt: describe(receiptPath, receiptBytes) }
  }
  const artifacts = {}
  for (const install of installs) artifacts[install.mode] = {
    runtime: await artifact('runtime', install.mode, runtimeBytes, `${outRelative}/artifacts/container_host_web_bg.wasm`, 'wasm32-unknown-unknown'),
    sdk: await artifact('sdk', install.mode, install.archive, `${outRelative}/artifacts/${install.artifact.fileName}`, 'web-javascript'),
    codec: await artifact('sdk', install.mode, codec.archive, `${outRelative}/artifacts/public-base64-sdk-closure.tar.gz`, 'web-javascript', '-codec'),
  }
  const log = describe(`${outRelative}/browser-execution.log`, jsonBytes(report))
  if (report.selection === 'identity') contracts.contracts = []
  else contracts.contracts = contracts.contracts.filter(contract => !['wx.login', 'wx.checkSession', 'wx.getUserProfile'].includes(contract.api))
  if (report.scopes.identity) contracts.contracts.push(...identityContracts(sources, sourceCommit))
  for (const contract of contracts.contracts) {
    assert.equal(contract.profiles.length, 1, 'Review new profile selection before accepting additional profiles')
    const profile = contract.profiles[0]
    const scope = ['wx.login', 'wx.checkSession', 'wx.getUserProfile'].includes(contract.api) ? 'identity' : ['wx.arrayBufferToBase64', 'wx.base64ToArrayBuffer', 'wx.canIUse'].includes(contract.api) ? 'codec' : Object.keys(SCOPE_API).find(scope => SCOPE_API[scope] === contract.api)
    assert(scope, `Unreviewed acceptance contract: ${contract.api}`)
    if (scope !== 'identity') profile.id += `-installed-${sourceCommit.slice(0, 8)}`
    profile.sources = sources.map(({repository, path}) => ({repository, path}))
    profile.platformConditions[0] = `Web host on macOS ${report.environment.os.version} ${report.environment.os.architecture} with standalone headless Chrome ${report.environment.browser.version}; loopback server is the only origin.`
    if (scope !== 'codec') profile.platformConditions[2] = `Each chain was freshly installed from the clean ${sourceCommit} direct/Worker release archive and uses its exact original WASM and SDK bytes. No source overlay, ambient package, remote origin, hardware or merchant service is used.`
    for (const mode of ['direct', 'worker']) {
      const checks = Object.fromEntries(['publicSdk', 'nativeTransport', 'realJs', 'completionToJs', 'directChain', 'workerChain', 'exactFreshArtifactBytes', 'completeExecutedModuleClosure', 'noAmbientDependencies', ...(SCOPE_CHECKS[scope] ?? IDENTITY_CHECKS)].map(key => [key, true]))
      for (const key of profile.requiredChecks) assert(checks[key] === true, `Assertion not implemented: ${contract.api}/${key}`)
      const data = { schemaVersion: 1, kind: 'real-sdk-chain', catalogNamesSha256: contracts.catalogNamesSha256, catalogSha256: contracts.catalogSha256, claim: { host: 'web', api: contract.api, profile: profile.id, sdk: mode, engine: 'quickjs' }, parameters: profile.parameters, platformConditions: profile.platformConditions, result: 'passed', execution: { command: ['rtk', 'proxy', 'node', 'scripts/verify-web-acceptance-scopes.mjs', ...argv].map(value => /[^A-Za-z0-9_./=:-]/.test(value) ? `'${value.replaceAll("'", "'\\''")}'` : value).join(' '), exitCode: 0, log }, checks, environment: report.environment, capabilities: {}, sources, artifacts: { runtime: artifacts[mode].runtime, sdk: scope === 'codec' ? artifacts[mode].codec : artifacts[mode].sdk }, cleanup: { status: 'complete', resources: [...report.scopes[scope].cleanup, ...report.cleanup.resources] } }
      const bytes = jsonBytes(data), path = `${outRelative}/reports/${contract.api.replace('wx.', '')}-${mode}.json`
      await put(resolve(ROOT, path), bytes); ledger.reports.push(describe(path, bytes))
    }
  }
  assert.equal(ledger.reports.length, (report.selection === 'identity' ? 0 : 24) + (report.scopes.identity ? 6 : 0))
  if (report.scopes.identity) await writeJson(resolve(out, 'reference-identity.json'), { schemaVersion: 1, classification: 'finite-reference-native-owner-chain', sourceCommit, ...report.scopes.identity, environment: report.environment, backend: report.backend, dialogs: report.dialogs, sources, artifacts, cleanup: report.cleanup })
  await writeJson(resolve(out, 'contracts-proposed.json'), contracts)
  await writeJson(resolve(out, 'ledger-proposed.json'), ledger)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(async error => {
  console.error(error.stack ?? error); process.exitCode = 1
  if (executionContext) await writeJson(resolve(executionContext.out, 'runner-failure.json'), { schemaVersion: 1, status: 'failed', ...executionContext, finishedAt: new Date().toISOString(), exitCode: 1, error: String(error.stack ?? error), cleanup: executionContext.browserStarted ? 'See browser-report.json and ownership.json' : { status: 'complete', resources: [] } })
})
