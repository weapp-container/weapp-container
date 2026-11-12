import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { catalogNamesDigest, catalogDigest, sha256, validateResponsibilities, validateAcceptanceLedger, buildApiCells, cellAcceptance, resolveImplementation } from './host-api-matrix.mjs'

const catalog = { protocolVersion: '1.0', baseline: { baseLibrary: '3.17.3' }, apis: [{ name: 'wx.fixture', owner: 'host', kind: 'async' }] }
const namesHash = catalogNamesDigest(catalog), catalogHash = catalogDigest(catalog)
const sourceCommit = 'a'.repeat(40), sourceBytes = Buffer.from('production implementation')
const source = { repository: '.', path: 'runtime.js', commit: sourceCommit, sha256: sha256(sourceBytes) }
const responsibility = { schemaVersion: 1, baseLibrary: '3.17.3', catalogNamesSha256: namesHash, catalogSha256: catalogHash, apis: [{ name: 'wx.fixture', responsibility: 'device', group: 'device/test', basis: 'locked-documentation' }] }

function fixture() {
  const files = new Map(), put = (path, bytes) => { bytes = Buffer.from(typeof bytes === 'string' ? bytes : JSON.stringify(bytes)); files.set(path, bytes); return { path, sha256: sha256(bytes) } }
  const profile = { id: 'supported-options', parameters: 'All locked fixture options, including permission denial', platformConditions: ['macOS 15; configured fixture permission'], sdks: ['native', 'flutter'], engines: ['quickjs', 'v8'], requiredChecks: ['deniedPermission', 'accountSwitch', 'lateResult', 'cancel'], requiredCapabilities: [], sources: [{ repository: '.', path: 'runtime.js' }] }
  const contracts = { schemaVersion: 1, catalogNamesSha256: namesHash, catalogSha256: catalogHash, contracts: [{ api: 'wx.fixture', host: 'macos', baselineCoverage: 'completeApplicableScope', review: { status: 'reviewed', reviewer: 'test fixture', date: '2026-11-02' }, profiles: [profile] }] }
  const reports = []
  for (const sdk of profile.sdks) for (const engine of profile.engines) {
    const artifact = role => {
      const data = { ...put(`artifacts/${sdk}-${engine}-${role}.bin`, `${sdk}/${engine}/${role}`), role, host: 'macos', version: '0.1.0-preview.6.0', architecture: 'aarch64', features: [engine], protocolVersion: '1.0', repository: '.', sourceCommit, ...(role === 'sdk' ? { sdk } : {}) }
      const receipt = { ...data, cleanSource: true, profile: 'release' }
      return { ...data, buildReceipt: put(`artifacts/${sdk}-${engine}-${role}-build.json`, receipt) }
    }
    reports.push({ schemaVersion: 1, kind: 'real-sdk-chain', catalogNamesSha256: namesHash, catalogSha256: catalogHash, claim: { host: 'macos', api: 'wx.fixture', profile: profile.id, sdk, engine }, parameters: profile.parameters, platformConditions: profile.platformConditions, result: 'passed', execution: { command: `fixture --sdk ${sdk} --engine ${engine}`, exitCode: 0, log: put(`logs/${sdk}-${engine}.log`, 'actual process output') }, checks: Object.fromEntries(['publicSdk', 'nativeTransport', 'realJs', 'completionToJs', ...profile.requiredChecks].map(name => [name, true])), environment: { os: { name: 'macOS', version: '15.0' } }, capabilities: {}, sources: [structuredClone(source)], artifacts: { runtime: artifact('runtime'), sdk: artifact('sdk') }, cleanup: { status: 'complete', resources: [{ kind: 'test-process', id: `${sdk}/${engine}`, ownership: 'created', terminal: 'closed' }, { kind: 'host-account', id: 'fixture', ownership: 'borrowed', terminal: 'preserved', reason: 'test-owned account retained by caller' }] } })
  }
  const seal = () => ({ schemaVersion: 1, catalogNamesSha256: namesHash, catalogSha256: catalogHash, reports: reports.map((report, index) => put(`evidence/report-${index}.json`, report)) })
  const input = () => ({ catalog, contracts, ledger: seal(), load: async path => { assert(files.has(path), `Missing fixture ${path}`); return files.get(path) }, readSource: async () => sourceBytes, readCommittedSource: async () => sourceBytes, verifyCommit: async () => true })
  return { files, put, profile, contracts, reports, input }
}

test('all 1265 responsibilities remain exact and wire ownership is not changed', async () => {
  const realCatalog = JSON.parse(await readFile(new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url)))
  const manifest = JSON.parse(await readFile(new URL('../docs/host-services/api-responsibilities.json', import.meta.url)))
  const before = JSON.stringify(realCatalog.apis.map(api => [api.name, api.owner, api.kind]))
  const entries = validateResponsibilities(realCatalog, manifest)
  assert.equal(entries.size, 1265)
  assert.equal(entries.get('wx.getDeviceInfo').responsibility, 'device')
  assert.equal(entries.get('wx.createCanvasContext').responsibility, 'runtime')
  assert.equal(entries.get('wx.login').responsibility, 'hostService')
  assert.equal(entries.get('object:UserCryptoManager.getLatestUserKey').responsibility, 'ecosystem')
  assert.equal(before, JSON.stringify(realCatalog.apis.map(api => [api.name, api.owner, api.kind])))
})

test('responsibility list rejects duplicate, unknown, missing and changed baseline entries', () => {
  for (const mutate of [
    value => value.apis.push(value.apis[0]),
    value => { value.apis[0].name = 'wx.unknown' },
    value => { value.apis = [] },
    value => { value.baseLibrary = '3.18.0' },
    value => { value.catalogNamesSha256 = 'b'.repeat(64) },
  ]) {
    const value = structuredClone(responsibility); mutate(value)
    assert.throws(() => validateResponsibilities(catalog, value))
  }
})

test('empty evidence cannot accept any API and exposes required public SDK chains', async () => {
  const empty = { schemaVersion: 1, catalogNamesSha256: namesHash, catalogSha256: catalogHash }
  const evidence = await validateAcceptanceLedger({ catalog, contracts: { ...empty, contracts: [] }, ledger: { ...empty, reports: [] } })
  const cell = cellAcceptance('macos', 'wx.fixture', evidence)
  assert.equal(cell.status, 'pendingAcceptance')
  assert.equal(cell.coverage.contractReviewed, false)
  assert.deepEqual(cell.coverage.requiredSdkChains, ['native', 'flutter'])
})

test('a fixed name list does not allow changed signatures to inherit acceptance', async () => {
  const value = fixture(), input = value.input()
  input.catalog = structuredClone(catalog)
  input.catalog.apis[0].signatures = [{ parameters: [{ name: 'newRequiredOption', optional: false }] }]
  assert.equal(catalogNamesDigest(input.catalog), namesHash)
  await assert.rejects(validateAcceptanceLedger(input), /catalog digest mismatch/)
})

test('only complete matching SDK/engine/profile reports can promote a cell', async () => {
  const value = fixture(), evidence = await validateAcceptanceLedger(value.input())
  assert.equal(cellAcceptance('macos', 'wx.fixture', evidence).status, 'implementedAndAccepted')
  value.reports.pop()
  const incomplete = await validateAcceptanceLedger(value.input())
  assert.equal(cellAcceptance('macos', 'wx.fixture', incomplete).status, 'pendingAcceptance')
  assert.equal(cellAcceptance('macos', 'wx.fixture', incomplete).coverage.profiles[0].chains.filter(chain => chain.status === 'implementedAndAccepted').length, 3)
  assert.equal(cellAcceptance('linux', 'wx.fixture', incomplete).status, 'pendingAcceptance')
})

test('a reviewed partial parameter scope can accept its chains but cannot accept the whole API', async () => {
  const value = fixture()
  value.contracts.contracts[0].baselineCoverage = 'partialScope'
  const evidence = await validateAcceptanceLedger(value.input()), cell = cellAcceptance('macos', 'wx.fixture', evidence)
  assert.equal(cell.status, 'pendingAcceptance')
  assert.equal(cell.coverage.baselineCoverage, 'partialScope')
  assert(cell.coverage.profiles[0].chains.every(chain => chain.status === 'implementedAndAccepted'))
})

test('a partial scope may record a reviewed subset of public SDK chains', async () => {
  const value = fixture()
  value.contracts.contracts[0].baselineCoverage = 'partialScope'
  value.contracts.contracts[0].profiles[0].sdks = ['native']
  value.reports.splice(2)
  const evidence = await validateAcceptanceLedger(value.input())
  const cell = cellAcceptance('macos', 'wx.fixture', evidence)
  assert.equal(cell.status, 'pendingAcceptance')
  assert.deepEqual(cell.coverage.requiredSdkChains, ['native', 'flutter'])
  assert.deepEqual(cell.coverage.profiles[0].chains.map(chain => [chain.sdk, chain.engine, chain.status]), [
    ['native', 'quickjs', 'implementedAndAccepted'],
    ['native', 'v8', 'implementedAndAccepted'],
  ])
})

test('source inventory, builds and harness evidence cannot impersonate SDK acceptance', async () => {
  for (const kind of ['source-inventory', 'build-and-protocol-only', 'harness', 'simulator']) {
    const value = fixture(); value.reports[0].kind = kind
    await assert.rejects(validateAcceptanceLedger(value.input()), /not SDK acceptance/)
  }
})

test('scope, denial/lifecycle, environment, physical and execution omissions reject', async () => {
  for (const mutate of [
    value => { value.reports[0].claim.host = 'windows' },
    value => { value.reports[0].claim.sdk = 'direct' },
    value => { value.reports[0].claim.engine = 'javascript-stub' },
    value => { value.reports[0].parameters = 'happy path only' },
    value => { value.reports[0].platformConditions = ['different OS'] },
    value => { delete value.reports[0].checks.nativeTransport },
    value => { delete value.reports[0].checks.deniedPermission },
    value => { delete value.reports[0].checks.lateResult },
    value => { delete value.reports[0].environment.os.version },
    value => { value.reports[0].execution.exitCode = 1 },
    value => { value.profile.requiredCapabilities = ['physicalHardware'] },
    value => { value.profile.requiredCapabilities = ['merchantTransaction'] },
    value => { value.contracts.contracts[0].review.status = 'draft' },
    value => { value.profile.sdks = ['native'] },
  ]) {
    const value = fixture(); mutate(value)
    await assert.rejects(validateAcceptanceLedger(value.input()))
  }
})

test('Web evidence requires actual browser name and version', async () => {
  const value = fixture()
  value.contracts.contracts[0].host = 'web'
  value.profile.sdks = ['direct', 'worker']
  for (const report of value.reports) {
    report.claim.host = 'web'
    report.claim.sdk = report.claim.sdk === 'native' ? 'direct' : 'worker'
  }
  await assert.rejects(validateAcceptanceLedger(value.input()), /Missing browser evidence/)
})

test('report, log, artifact and build receipt hashes are binding', async () => {
  for (const which of ['report', 'log', 'runtime', 'sdk', 'build']) {
    const value = fixture(), input = value.input()
    const reference = which === 'report' ? input.ledger.reports[0] : which === 'log' ? value.reports[0].execution.log : which === 'build' ? value.reports[0].artifacts.sdk.buildReceipt : value.reports[0].artifacts[which]
    value.files.set(reference.path, Buffer.from('changed bytes'))
    await assert.rejects(validateAcceptanceLedger(input), /digest mismatch/)
  }
})

test('source closure, committed bytes, current bytes and reachable commits are binding', async () => {
  const changes = [
    input => { input.readSource = async () => Buffer.from('uncommitted source') },
    input => { input.readCommittedSource = async () => Buffer.from('different committed source') },
    input => { input.verifyCommit = async () => false },
  ]
  for (const mutate of changes) {
    const value = fixture(), input = value.input(); mutate(input)
    await assert.rejects(validateAcceptanceLedger(input))
  }
  const value = fixture(); value.profile.sources.push({ repository: 'sdk/desktop', path: 'native.cpp' })
  await assert.rejects(validateAcceptanceLedger(value.input()), /Missing source closure/)
})

test('artifacts must be release, clean, source-bound and match platform/protocol/SDK', async () => {
  for (const mutate of [
    value => { value.reports[0].artifacts.runtime.sourceCommit = 'c'.repeat(40) },
    value => { value.reports[0].artifacts.sdk.sdk = 'direct' },
    value => { value.reports[0].artifacts.runtime.protocolVersion = '0.9' },
    value => { value.reports[0].artifacts.runtime.host = 'linux' },
    value => { const artifact = value.reports[0].artifacts.runtime; artifact.buildReceipt = value.put('dirty.json', { ...artifact, cleanSource: false, profile: 'release' }) },
    value => { const artifact = value.reports[0].artifacts.runtime; artifact.buildReceipt = value.put('debug.json', { ...artifact, cleanSource: true, profile: 'debug' }) },
  ]) {
    const value = fixture(); mutate(value)
    await assert.rejects(validateAcceptanceLedger(value.input()))
  }
})

test('created resources must close; borrowed resources must remain preserved with a reason', async () => {
  for (const mutate of [
    value => { value.reports[0].cleanup.status = 'failed' },
    value => { value.reports[0].cleanup.resources[0].terminal = 'preserved' },
    value => { value.reports[0].cleanup.resources[1].terminal = 'closed' },
    value => { delete value.reports[0].cleanup.resources[1].reason },
  ]) {
    const value = fixture(); mutate(value)
    await assert.rejects(validateAcceptanceLedger(value.input()), /cleanup/i)
  }
})

test('unsafe paths and duplicate records fail closed', async () => {
  const value = fixture(), input = value.input()
  input.ledger.reports.push(input.ledger.reports[0])
  await assert.rejects(validateAcceptanceLedger(input), /Duplicate acceptance report/)
  const unsafe = fixture(); unsafe.reports[0].execution.log.path = '../secret'
  await assert.rejects(validateAcceptanceLedger(unsafe.input()), /Invalid Execution log reference/)
})

test('core-only snapshot bridges remain partial and cannot be accepted as native providers', () => {
  const value = fixture(), responsibilityMap = validateResponsibilities(catalog, responsibility)
  const cells = buildApiCells({ catalog, responsibilityMap, implementation: () => ({ implementation: 'absent', implementationState: 'partial', sources: [{ role: 'runtimeBridge', path: 'runtime.js' }], missing: ['platformSnapshotProvider'] }) })
  assert.equal(cells.length, 1)
  assert.equal(cells[0].hosts.android.implementationState, 'partial')
  assert.equal(cells[0].hosts.android.status, 'pendingAcceptance')
  assert.equal(cells[0].owner, 'host')
})

test('source roles distinguish runtime implementation, missing providers and security ownership', () => {
  const api = catalog.apis[0], bridge = { sources: [{ id: 'core', role: 'runtimeBridge' }], missing: ['platformSnapshotProvider'] }
  const snapshot = resolveImplementation({ api, core: bridge })
  assert.equal(snapshot.implementationState, 'partial')
  assert.equal(snapshot.implementation, 'absent')
  const installed = resolveImplementation({ api, core: bridge, registeredSources: [{ id: 'native' }] })
  assert.equal(installed.implementationState, 'available')
  assert.equal(installed.missing, undefined)
  const boundary = resolveImplementation({ api: { ...api, owner: 'runtime' }, core: { sources: [{ id: 'boundary', role: 'protectedBoundary' }] } })
  assert.equal(boundary.implementation, 'runtimeOwned')
  assert.equal(boundary.implementationState, 'missing')
  const implemented = resolveImplementation({ api, core: { sources: [{ id: 'core', role: 'runtimeImplementation' }] } })
  assert.equal(implemented.implementationState, 'available')
  const limited = resolveImplementation({ api, registeredSources: [{ id: 'native' }], parameterLimit: { reason: 'partial native support' } })
  assert.equal(limited.implementationState, 'partial')
  const hostService = resolveImplementation({ api, registeredSources: [{ id: 'host-client' }], delegated: true })
  assert.equal(hostService.implementationState, 'requiresHostService')
})

test('accepted report and platform-not-applicable cannot hide absent or partial implementation', async () => {
  const value = fixture(), evidence = await validateAcceptanceLedger(value.input()), responsibilityMap = validateResponsibilities(catalog, responsibility)
  assert.throws(() => buildApiCells({ catalog, responsibilityMap, evidence, implementation: () => ({ implementationState: 'partial' }) }), /incomplete implementation/)
  assert.throws(() => buildApiCells({ catalog, responsibilityMap, implementation: () => ({ implementationState: 'available' }), restrictions: new Map([[JSON.stringify(['macos', 'wx.fixture']), { reason: 'missing credentials are not platform restriction' }]]) }), /Restriction conflicts/)
})

test('generated matrix preserves all API and host cells with separate implementation and SDK scope', async () => {
  const load = async relative => JSON.parse(await readFile(new URL('../'+relative, import.meta.url)))
  const realCatalog = await load('crates/container-runtime/src/host-api-catalog.json')
  const matrix = await load('docs/host-services/api-matrix.json')
  const ledger = await load('docs/host-services/acceptance-ledger.json')
  assert.equal(matrix.apis.length, 1265)
  assert.equal(matrix.hosts.length, 7)
  assert.deepEqual(matrix.apis.map(api => api.name), realCatalog.apis.map(api => api.name))
  const cells = matrix.apis.flatMap(api => Object.entries(api.hosts).map(([host, cell]) => ({ host, cell })))
  assert.equal(cells.length, 8855)
  for (const { host, cell } of cells) {
    assert.deepEqual(cell.coverage.requiredSdkChains, matrix.sdkChains[host])
    assert(['missing', 'partial', 'available', 'requiresHostService'].includes(cell.implementationState))
    assert(['implementedAndAccepted', 'pendingAcceptance', 'platformNotApplicable'].includes(cell.status))
    if (cell.status === 'platformNotApplicable') assert(cell.restriction.officialSources.length > 0)
  }
  if (ledger.reports.length === 0) assert(!cells.some(({ cell }) => cell.status === 'implementedAndAccepted'))
  const find = name => matrix.apis.find(api => api.name === name)
  for (const cell of Object.values(find('wx.getDeviceInfo').hosts)) {
    assert(cell.sources.some(source => source.role === 'runtimeBridge'))
    assert(cell.sources.some(source => source.id === 'nativeProvider' && source.role === 'runtimeImplementation'))
    assert(cell.missing.includes('fullDeviceSnapshotFields'))
  }
  for (const name of ['wx.getWindowInfo', 'wx.getMenuButtonBoundingClientRect']) {
    for (const cell of Object.values(find(name).hosts)) {
      assert(cell.sources.some(source => source.id === 'geometry' && source.role === 'runtimeImplementation'))
      assert.equal(cell.implementationState, 'available')
      assert(!cell.missing?.includes('platformSnapshotProvider'))
    }
  }
  for (const name of ['wx.batchSetStorage', 'wx.batchSetStorageSync']) {
    for (const cell of Object.values(find(name).hosts)) {
      assert.equal(cell.implementationState, 'partial')
      assert.equal(cell.status, 'pendingAcceptance')
      assert(cell.sources.some(source => source.id === 'storageTransactions' && source.role === 'runtimeImplementation'))
      assert.deepEqual(cell.missing, ['storageJsonStringParity', 'storageBoundedValueScope', 'storagePlainAccountingParity'])
    }
  }
  for (const name of ['wx.batchGetStorage', 'wx.batchGetStorageSync']) {
    for (const cell of Object.values(find(name).hosts)) assert.equal(cell.implementationState, 'missing')
  }
  for (const name of ['wx.setStorage', 'wx.getStorage', 'wx.setStorageSync']) {
    for (const cell of Object.values(find(name).hosts)) {
      assert.equal(cell.implementationState, 'partial')
      assert.equal(cell.status, 'pendingAcceptance')
      assert(cell.missing.some(gap => gap.startsWith('storage')))
      assert(cell.sources.some(source => source.role === 'runtimeImplementation'))
    }
  }
  for (const name of ['wx.onAppShow', 'wx.offAppShow', 'wx.onAppHide', 'wx.offAppHide', 'wx.onBeforePageUnload', 'wx.offBeforePageUnload', 'wx.onAfterPageUnload', 'wx.offAfterPageUnload']) {
    for (const cell of Object.values(find(name).hosts)) {
      assert.equal(cell.implementationState, 'available')
      assert.equal(cell.status, 'pendingAcceptance')
      assert(cell.sources.some(source => source.id === 'lifecycleNotifications' && source.role === 'runtimeImplementation'))
      assert(cell.sources.some(source => source.id === 'runtimeLifecycle'))
    }
  }
  for (const name of ['wx.nextTick', 'wx.onError', 'wx.onPageNotFound']) {
    for (const cell of Object.values(find(name).hosts)) {
      assert.equal(cell.implementationState, 'partial')
      assert.equal(cell.status, 'pendingAcceptance')
      assert(cell.sources.some(source => source.id === 'quickjs'))
      assert(cell.sources.some(source => source.id === 'v8'))
    }
  }
  for (const [name, source] of [['wx.offError', 'errorNotifications'], ['wx.offPageNotFound', 'pageNotFoundNotifications'], ['wx.getRandomValues', 'randomValuesRuntime']]) {
    const api = find(name)
    assert.equal(api.owner, 'runtime')
    assert.equal(Object.keys(api.hosts).length, 7)
    for (const cell of Object.values(api.hosts)) {
      assert.equal(cell.implementationState, 'available')
      assert.equal(cell.status, 'pendingAcceptance')
      assert.equal(cell.missing, undefined)
      assert(cell.sources.some(entry => entry.id === source && entry.role === 'runtimeImplementation'))
      assert(cell.sources.some(entry => entry.id === 'quickjs'))
      assert(cell.sources.some(entry => entry.id === 'v8'))
    }
  }
  for (const host of ['macos', 'windows', 'linux']) {
    for (const name of ['wx.login', 'wx.requestPayment', 'weappContainer.identity.getState', 'component:button.bindgetphonenumber']) {
      const cell = find(name).hosts[host]
      assert.equal(cell.implementationState, 'requiresHostService')
      assert.equal(cell.status, 'pendingAcceptance')
      assert(cell.sources.some(source => source.path === 'sdk/desktop/src/host_services_adapter.cpp'))
    }
  }
  assert.equal(find('object:MapContext.moveToLocation').responsibility, 'runtime')
  assert.equal(find('object:MapContext.moveToLocation').owner, realCatalog.apis.find(api => api.name === 'object:MapContext.moveToLocation').owner)
})

test('retained event removals are complete while producer parity gaps remain explicit', async () => {
  const matrix = JSON.parse(await readFile(new URL('../docs/host-services/api-matrix.json', import.meta.url)))
  const gaps = {
    onUnhandledRejection: ['fixedUnhandledRejectionCheckpointTiming', 'fixedUnhandledRejectionReasonDeclarationParity', 'fixedUnhandledRejectionCaptureBudgetParity'],
    offUnhandledRejection: [],
    onWindowResize: ['fixedWindowResizeCallbackPolicyParity'],
    offWindowResize: [],
  }
  for (const [method, missing] of Object.entries(gaps)) {
    const api = matrix.apis.find(api => api.name === `wx.${method}`)
    assert.equal(api.owner, 'runtime')
    assert.deepEqual(Object.keys(api.hosts), matrix.hosts)
    const source = method.endsWith('WindowResize') ? 'windowResizeNotifications' : 'unhandledRejections'
    for (const cell of Object.values(api.hosts)) {
      assert.equal(cell.implementationState, missing.length ? 'partial' : 'available')
      assert.equal(cell.status, 'pendingAcceptance')
      assert.deepEqual(cell.missing ?? [], missing)
      for (const id of [source, 'quickjs', 'v8', 'runtime', 'hostServices', 'manifestPacker']) {
        assert(cell.sources.some(entry => entry.id === id && entry.role === 'runtimeImplementation'))
      }
    }
  }
})
