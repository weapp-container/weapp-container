import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { EXECUTION_HOSTS, MOBILE_EXECUTION_HOSTS, collectPackExecutionEvidence, inspectExecutionFixture, inspectPackExecutionMatrix, inspectPackExecutionReceipt } from './pack-execution-evidence.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const expectedCommit = git(['rev-parse', 'HEAD'])
const expectedCompilerCommit = git(['rev-parse', 'HEAD:vendor/weapp-vite'])
const options = { root, expectedCommit, expectedCompilerCommit }
const digest = 'a'.repeat(64)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)

function seal(manifest) {
  manifest.integrity = { algorithm: 'sha256', root: '' }
  manifest.integrity.root = createHash('sha256').update(canonical(manifest)).digest('hex')
  return manifest
}

function fixture() {
  return { id: 'reference-app', manifest: seal({
    schemaVersion: 1,
    protocolVersion: '1.0',
    compiler: { name: 'weapp-vite', commit: expectedCompilerCommit, platform: 'weapp' },
    app: { appJson: 'app.json', entryModule: 'app.js' },
    routes: [{ id: 'route:pages/index/index', path: 'pages/index/index', kind: 'page', entryModule: 'pages/index/index.js' }],
    modules: ['app.js', 'pages/index/index.js'].map(path => ({ id: `module:${path}`, sha256: digest, format: 'commonjs', scope: path === 'app.js' ? 'app' : 'page' })),
    templates: [{ id: 'template:pages/index/index.wxml', wxmlAst: `sha256:${digest}`, bindings: [] }],
    styles: [], components: [], assets: [], capabilities: {},
  }) }
}

test('fixture schema selection validates renderer v3 and modern v2/v3 requirements', () => {
  const program = fixture()
  program.manifest.schemaVersion = 3
  program.manifest.rendering = { version: '1.0', default: 'skia', pages: { 'pages/index/index': 'webview' } }
  seal(program.manifest)
  assert.equal(inspectExecutionFixture(program, expectedCompilerCommit).status, 'passed')
  for (const mutation of [
    manifest => { manifest.rendering.version = '2.0' },
    manifest => { manifest.rendering.pages['pages/index/index'] = 'skyline' },
    manifest => { manifest.rendering.pages = { missing: 'webview' } },
    manifest => { delete manifest.rendering },
  ]) {
    const bad = structuredClone(program)
    mutation(bad.manifest)
    seal(bad.manifest)
    assert.equal(inspectExecutionFixture(bad, expectedCompilerCommit).status, 'incomplete')
  }
  program.manifest.modernView = { compiler: 'weapp-container-modern-view', version: '1.0.0', abi: '1.0', target: 'es2022',
    units: [{ id: `modern:${digest}`, executableSha256: digest, sourceMapSha256: digest,
      sources: [{ path: 'view/main.view.ts', sha256: digest }],
      documents: [{ documentId: 'pages/index/index.wxml', aliases: ['main'] }] }] }
  seal(program.manifest)
  assert.equal(inspectExecutionFixture(program, expectedCompilerCommit).status, 'passed')
  program.manifest.schemaVersion = 2
  const empty = structuredClone(program)
  empty.manifest.modernView.units = []
  delete empty.manifest.rendering
  seal(empty.manifest)
  assert.equal(inspectExecutionFixture(empty, expectedCompilerCommit).checks.schema, false)
  delete program.manifest.rendering
  seal(program.manifest)
  assert.equal(inspectExecutionFixture(program, expectedCompilerCommit).status, 'passed')
  program.manifest.modernView.units[0].documents[0].documentId = 'missing.wxml'
  seal(program.manifest)
  assert.equal(inspectExecutionFixture(program, expectedCompilerCommit).checks.relations, false)
})

function receipt(program, host = 'android', engine = 'quickjs') {
  const manifestIntegrity = program.manifest.integrity.root
  const sessionId = `${host}-${engine}-session`
  const operations = {}
  const operation = (op, payload, result) => {
    const request = { protocolVersion: '1.0', sessionId, requestId: `${op}-${host}-${engine}`, kind: 'request', op, payload }
    operations[op] = {
      status: 0, requestJson: JSON.stringify(request),
      json: JSON.stringify({ messages: [{ ...request, kind: 'response', payload: { ok: true, ...result } }] }),
    }
  }
  operation('app.init', { manifest: program.manifest }, {
    engine, engineProviderAvailable: true, appLaunchInvoked: true, sessionId,
    loadedModules: program.manifest.modules.length, manifest: { integrity: manifestIntegrity },
    host: { kind: ['macos', 'windows', 'linux'].includes(host) ? 'desktop' : host, platform: host },
  })
  operation('app.lifecycle', { event: 'launch' }, {})
  operation('page.push', { path: 'pages/index/index' }, { page: { path: 'pages/index/index' }, pageId: 1 })
  operation('render.commit', { templateId: 'template:pages/index/index.wxml' }, {
    committed: true, source: 'manifest', frameId: 1, templateId: 'template:pages/index/index.wxml',
  })
  operations['render.snapshot'] = {
    status: 0, sessionId, json: JSON.stringify({ frame_id: 1, width: 1, height: 1, format: 'rgba8-premultiplied', pixelCount: 4, sha256: digest }),
  }
  return {
    status: 'passed', host, engine, fixtureId: program.id, manifestIntegrity,
    sourceCommit: expectedCommit, artifactSha256: digest,
    build: { status: 'passed', sourceCommit: expectedCommit, workingTreeDirty: false, host, engine, artifactSha256: digest },
    target: { host, id: `${host}-test-target`, kind: MOBILE_EXECUTION_HOSTS.includes(host) ? 'official-simulator' : host === 'web' ? 'browser' : 'native-window' },
    sessionId, route: 'pages/index/index', operations,
    surfaceProbe: {
      schemaVersion: 1, status: 'passed', host, engine, sessionId, manifestIntegrity, frameId: 1,
      snapshotSha256: digest,
      hostSurfaceAttached: true, containerSurfaceAttached: true, gpuSurface: true,
      rendererBackend: ['ios', 'macos'].includes(host) ? 'skia-gpu-metal' : host === 'web' ? 'skia-gpu-canvaskit' : 'skia-gpu-gles',
      evidenceBoundary: ['ios', 'macos'].includes(host) ? 'rust-skia-metal-drawable' : host === 'web' ? 'runtime-skia-canvaskit-surface' : 'runtime-skia-gles-framebuffer',
    },
  }
}

function report(hosts = MOBILE_EXECUTION_HOSTS) {
  const program = fixture()
  return { path: '<synthetic-receipt-test>', value: {
    sourceCommit: expectedCommit,
    executionEvidence: {
      schemaVersion: 1, fixture: program,
      receipts: hosts.flatMap(host => ['quickjs', 'v8'].map(engine => receipt(program, host, engine))),
    },
  } }
}

function patchResponse(value, op, patch) {
  const batch = JSON.parse(value.operations[op].json)
  Object.assign(batch.messages[0].payload, patch)
  value.operations[op].json = JSON.stringify(batch)
}

function sourceHistory(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'weapp-pack-source-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  git(['init', '-q'])
  git(['config', 'user.name', 'Weapp Container provenance test'])
  git(['config', 'user.email', 'weapp-test@example.invalid'])
  const commit = (path, content) => {
    mkdirSync(dirname(resolve(directory, path)), { recursive: true })
    writeFileSync(resolve(directory, path), content)
    git(['add', '--', path])
    git(['commit', '-qm', path])
    return git(['rev-parse', 'HEAD'])
  }
  // Real repository HEAD may be an evidence-only commit or a shallow clone.
  // This local history proves a product input changed, then records a separate
  // archive commit whose parent remains a valid measured source revision.
  const productPath = 'crates/container-runtime/src/lib.rs'
  const outdated = commit(productPath, 'pub const RUNTIME_VERSION: u32 = 1;\n')
  const measured = commit(productPath, 'pub const RUNTIME_VERSION: u32 = 2;\n')
  const archived = commit('docs/evidence/synthetic-source/report.json', '{}\n')
  return { root: directory, outdated, measured, archived, productPath }
}

function bindReportSource(evidence, sourceCommit) {
  evidence.value.sourceCommit = sourceCommit
  for (const receipt of evidence.value.executionEvidence.receipts) {
    receipt.sourceCommit = sourceCommit
    receipt.build.sourceCommit = sourceCommit
  }
  return evidence
}

test('same-fixture receipts cover every mobile pair, independently of GPU proof', () => {
  const evidence = report()
  const matrix = inspectPackExecutionMatrix([evidence], { ...options, hosts: MOBILE_EXECUTION_HOSTS })
  assert.equal(matrix.status, 'passed')
  assert.equal(matrix.gpu.status, 'passed')
  assert.equal(matrix.expectedPairs.length, 6)
  evidence.value.executionEvidence.receipts[0].surfaceProbe.sessionId = 'another-session'
  const independent = inspectPackExecutionMatrix([evidence], { ...options, hosts: MOBILE_EXECUTION_HOSTS })
  assert.equal(independent.status, 'passed')
  assert.equal(independent.gpu.status, 'incomplete')
  assert.deepEqual(independent.gpu.missingPairs, ['android/quickjs'])
})

test('single-engine and status-only legacy reports never satisfy a dual-engine matrix', () => {
  const evidence = report()
  evidence.value.executionEvidence.receipts = evidence.value.executionEvidence.receipts.filter(receipt => receipt.engine === 'quickjs')
  const matrix = inspectPackExecutionMatrix([evidence], { ...options, hosts: MOBILE_EXECUTION_HOSTS })
  assert.equal(matrix.status, 'incomplete')
  assert.deepEqual(matrix.missingPairs, ['android/v8', 'ios/v8', 'harmony/v8'])
  const legacy = inspectPackExecutionMatrix([{ value: { expectedEngine: 'quickjs', platforms: MOBILE_EXECUTION_HOSTS.map(platform => ({ platform, status: 'passed' })) } }], { ...options, hosts: MOBILE_EXECUTION_HOSTS })
  assert.equal(legacy.status, 'incomplete')
  assert.equal(legacy.missingPairs.length, 6)
})

test('seven-host execution requires fourteen actual-target receipts and cannot reuse bridge/provider statuses', () => {
  const all = report(EXECUTION_HOSTS)
  assert.equal(inspectPackExecutionMatrix([all], options).status, 'passed')
  assert.equal(inspectPackExecutionMatrix([all], options).gpu.status, 'passed')
  const bridgeOnly = { value: { commit: expectedCommit, status: 'passed', gates: { bridge: 'passed', engineProviders: 'passed' }, hosts: EXECUTION_HOSTS.map(platform => ({ platform, bridgeBatch: 'passed' })) } }
  const result = inspectPackExecutionMatrix([report(), bridgeOnly], options)
  assert.equal(result.status, 'incomplete')
  assert.equal(result.missingPairs.length, 8)
})

test('wrong engine, non-native provider, arbitrary manifest roots and zero modules are rejected', () => {
  for (const patch of [
    { engine: 'v8' }, { engineProviderAvailable: false }, { loadedModules: 0 },
    { loadedModules: 1 }, { manifest: { integrity: 'b'.repeat(64) } },
  ]) {
    const program = fixture()
    const value = receipt(program)
    patchResponse(value, 'app.init', patch)
    assert.equal(inspectPackExecutionReceipt(value, program, options).status, 'incomplete', JSON.stringify(patch))
  }
})

test('a new harness commit cannot launder an old binary source or unknown dirty build', t => {
  const history = sourceHistory(t)
  const localOptions = { ...options, root: history.root, expectedCommit: history.archived }
  const program = fixture()
  const value = receipt(program)
  value.sourceCommit = history.archived
  value.build.sourceCommit = history.measured
  const archived = inspectPackExecutionReceipt(value, program, localOptions)
  assert.equal(archived.status, 'passed', 'archiving evidence does not change the measured binary inputs')
  assert.equal(archived.buildSourceRevision.archiveOnly, true)
  value.build.sourceCommit = history.outdated
  const outdated = inspectPackExecutionReceipt(value, program, localOptions)
  assert.equal(outdated.status, 'incomplete')
  assert.equal(outdated.checks.source, false)
  assert.equal(outdated.sourceRevision.exact, true, 'a current harness cannot conceal an old binary')
  assert.deepEqual(outdated.buildSourceRevision.nonEvidencePaths, [history.productPath])
  value.build.sourceCommit = history.measured
  for (const patch of [{ status: 'unknown' }, { workingTreeDirty: true }, { artifactSha256: 'b'.repeat(64) }, { host: 'linux' }, { engine: 'v8' }]) {
    const invalid = structuredClone(value)
    Object.assign(invalid.build, patch)
    assert.equal(inspectPackExecutionReceipt(invalid, program, localOptions).checks.build, false)
  }
})

test('stale report source and conflicting fixture roots remain incomplete', t => {
  const history = sourceHistory(t)
  const localOptions = { ...options, root: history.root, expectedCommit: history.archived, hosts: MOBILE_EXECUTION_HOSTS }
  const one = bindReportSource(report(), history.measured)
  assert.equal(inspectPackExecutionMatrix([one], localOptions).status, 'passed', 'an evidence-only archive keeps the measured report valid')
  one.value.sourceCommit = history.outdated
  const stale = inspectPackExecutionMatrix([one], localOptions)
  assert.equal(stale.status, 'incomplete')
  assert.deepEqual(stale.inputs[0].sourceRevision.nonEvidencePaths, [history.productPath])
  assert.ok(Object.values(stale.pairs).every(pair => pair.receipts[0].checks.source), 'only the report source is stale; current binary receipts cannot launder it')
  const android = report(['android'])
  const rest = report(['ios', 'harmony'])
  rest.value.executionEvidence.fixture.manifest.capabilities['wx.test'] = 'partial'
  seal(rest.value.executionEvidence.fixture.manifest)
  rest.value.executionEvidence.receipts = ['ios', 'harmony'].flatMap(host => ['quickjs', 'v8'].map(engine => receipt(rest.value.executionEvidence.fixture, host, engine)))
  const mismatch = inspectPackExecutionMatrix([android, rest], { ...options, hosts: MOBILE_EXECUTION_HOSTS })
  assert.equal(mismatch.status, 'incomplete')
  assert.equal(mismatch.inputs[1].fixtureMatches, false)
})

test('fixture identity ignores producer diagnostics while verifying UTF-8 canonical manifest integrity', () => {
  const android = report(['android'])
  const rest = report(['ios', 'harmony'])
  rest.value.executionEvidence.fixture.sourceCommit = 'some-fixture-build-annotation'
  rest.value.executionEvidence.fixture.extraDiagnostic = 'another producer'
  assert.equal(inspectPackExecutionMatrix([android, rest], { ...options, hosts: MOBILE_EXECUTION_HOSTS }).status, 'passed')
  const program = fixture()
  program.manifest.components.push({ id: 'components:app.json', owner: 'app.json', usingComponents: { '\ue000': './a', '\u{10000}': './b' } })
  seal(program.manifest)
  assert.equal(inspectExecutionFixture(program, expectedCompilerCommit).status, 'passed')
  const utf16 = value => Array.isArray(value) ? `[${value.map(utf16).join(',')}]` : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${utf16(value[key])}`).join(',')}}` : JSON.stringify(value)
  const wrongInput = { ...program.manifest, integrity: { algorithm: 'sha256', root: '' } }
  program.manifest.integrity.root = createHash('sha256').update(utf16(wrongInput)).digest('hex')
  assert.equal(inspectExecutionFixture(program, expectedCompilerCommit).checks.manifestIntegrity, false)
})

test('request/session correlation, manifest-backed render and complete snapshot are mandatory', () => {
  const program = fixture()
  for (const mutate of [
    value => { const batch = JSON.parse(value.operations['page.push'].json); batch.messages[0].requestId = 'other-request'; value.operations['page.push'].json = JSON.stringify(batch) },
    value => { const batch = JSON.parse(value.operations['app.init'].json); batch.messages[0].sessionId = 'old-session'; value.operations['app.init'].json = JSON.stringify(batch) },
    value => patchResponse(value, 'render.commit', { source: 'frame' }),
    value => patchResponse(value, 'render.commit', { templateId: 'template:other.wxml' }),
    value => patchResponse(value, 'page.push', { page: { path: 'pages/other/index' }, pageId: 2 }),
    value => { const request = JSON.parse(value.operations['app.init'].requestJson); request.payload.manifest = { integrity: { root: program.manifest.integrity.root } }; value.operations['app.init'].requestJson = JSON.stringify(request) },
    value => { value.operations['render.snapshot'].sessionId = 'other-session' },
    value => { value.operations['render.snapshot'].json = JSON.stringify({ frame_id: 2, width: 1, height: 1, pixelCount: 4, format: 'rgba8-premultiplied' }) },
    value => { value.target.kind = 'host-crate-unit-test' },
    value => patchResponse(value, 'app.init', { host: { kind: 'desktop', platform: 'linux' } }),
  ]) {
    const value = receipt(program)
    mutate(value)
    assert.equal(inspectPackExecutionReceipt(value, program, options).status, 'incomplete')
  }
})

test('a successful startup acknowledgement cannot hide a failed sibling response in the same batch', () => {
  const program = fixture()
  for (const operation of ['app.init', 'app.lifecycle', 'page.push', 'render.commit']) {
    for (const before of [false, true]) {
      const value = receipt(program)
      const batch = JSON.parse(value.operations[operation].json)
      const failure = {
        protocolVersion: '1.0', sessionId: value.sessionId, requestId: 'other-request',
        kind: 'response', op: 'api.call', payload: { ok: false, error: { code: 'ERR_ENGINE', message: 'startup effect failed' } },
      }
      if (before) batch.messages.unshift(failure)
      else batch.messages.push(failure)
      value.operations[operation].json = JSON.stringify(batch)
      const result = inspectPackExecutionReceipt(value, program, options)
      assert.equal(result.operations[operation].checks.response, true, 'the correlated acknowledgement itself succeeded')
      assert.equal(result.operations[operation].checks.errors, false)
      assert.equal(result.status, 'incomplete')
      assert.equal(result.gpu.status, 'incomplete')
    }
  }
})

test('blank or unrelated GPU probes and software upload never become actual-pack GPU proof', () => {
  const program = fixture()
  for (const mutate of [
    value => patchResponse(value, 'app.init', { loadedModules: 0 }),
    value => { value.surfaceProbe.manifestIntegrity = 'b'.repeat(64) },
    value => { value.surfaceProbe.sessionId = 'unrelated' },
    value => { value.surfaceProbe.frameId = 2 },
    value => { value.surfaceProbe.snapshotSha256 = 'b'.repeat(64) },
    value => { value.surfaceProbe.engine = 'v8' },
    value => { value.surfaceProbe.host = 'ios' },
    value => { value.surfaceProbe.evidenceBoundary = 'device-context-only' },
    value => { value.surfaceProbe.evidenceBoundary = 'runtime-snapshot-upload' },
    value => { value.surfaceProbe.rendererBackend = 'skia-raster' },
    value => { value.surfaceProbe.rendererBackend = 'skia-gpu-invented' },
    value => { value.surfaceProbe.rendererBackend = 'skia-gpu-metal'; value.surfaceProbe.evidenceBoundary = 'rust-skia-metal-drawable' },
  ]) {
    const value = receipt(program)
    mutate(value)
    assert.equal(inspectPackExecutionReceipt(value, program, options).gpu.status, 'incomplete')
  }
})

test('schema and cross-table validation reject malformed fixtures even after their root is recalculated', () => {
  for (const mutate of [
    program => { delete program.manifest.app.appJson },
    program => { program.manifest.modules[0].scope = 'invented' },
    program => { program.manifest.modules[0].dependencies = ['module:missing.js'] },
    program => { program.manifest.routes[0].kind = 'invented' },
    program => { program.manifest.viewCompilation = { compiler: 'invented', version: '99', abi: '99', modules: [], documents: [] } },
    program => { program.manifest.viewCompilation = { compiler: 'weapp-container-wxs', version: '1.0.0', abi: '1.0', modules: [], documents: [] } },
    program => { program.manifest.templates[0].wxsModules = { tools: 'wxs:missing.wxs' } },
    program => { program.manifest.assets = [{ path: 'same.png', sha256: digest, mime: 'image/png', size: 1 }, { path: 'same.png', sha256: digest, mime: 'image/png', size: 2 }] },
  ]) {
    const program = fixture()
    mutate(program)
    seal(program.manifest)
    assert.equal(inspectExecutionFixture(program, expectedCompilerCommit).status, 'incomplete')
    assert.equal(inspectPackExecutionReceipt(receipt(program), program, options).status, 'incomplete')
  }
})

test('snapshot digests bind full validated bytes or a valid summary to the presented program frame', () => {
  const program = fixture()
  const full = receipt(program)
  const pixels = [10, 20, 30, 255]
  const pixelSha256 = createHash('sha256').update(Buffer.from(pixels)).digest('hex')
  full.operations['render.snapshot'].json = JSON.stringify({ frame_id: 1, width: 1, height: 1, format: 'rgba8-premultiplied', pixels })
  full.surfaceProbe.snapshotSha256 = pixelSha256
  assert.equal(inspectPackExecutionReceipt(full, program, options).gpu.status, 'passed')
  for (const patch of [
    { pixelCount: 4, pixels: [-1, 'not-a-byte', null, 999], sha256: 'invalid' },
    { pixelCount: 4, pixels: [10, 20, 30, 255], sha256: 'b'.repeat(64) },
    { pixelCount: 4, sha256: 'invalid' },
    { pixelCount: 4 },
    { pixelCount: 5, sha256: digest },
  ]) {
    const value = receipt(program)
    value.operations['render.snapshot'].json = JSON.stringify({ frame_id: 1, width: 1, height: 1, format: 'rgba8-premultiplied', ...patch })
    const result = inspectPackExecutionReceipt(value, program, options)
    assert.equal(result.checks.snapshot, false, JSON.stringify(patch))
    assert.equal(result.gpu.status, 'incomplete')
  }
})

test('duplicate or unexpected host/engine receipts cannot be selected opportunistically', () => {
  const evidence = report()
  evidence.value.executionEvidence.receipts.push(structuredClone(evidence.value.executionEvidence.receipts[0]))
  const duplicate = inspectPackExecutionMatrix([evidence], { ...options, hosts: MOBILE_EXECUTION_HOSTS })
  assert.equal(duplicate.status, 'incomplete')
  assert.deepEqual(duplicate.duplicatePairs, ['android/quickjs'])
  evidence.value.executionEvidence.receipts.at(-1).engine = 'host'
  const unexpected = inspectPackExecutionMatrix([evidence], { ...options, hosts: MOBILE_EXECUTION_HOSTS })
  assert.equal(unexpected.status, 'incomplete')
  assert.deepEqual(unexpected.unexpectedPairs, ['android/host'])
})

test('collection records the observed artifact and target without laundering unknown binary provenance', () => {
  const program = fixture()
  const raw = { schemaVersion: 1, ...receipt(program), fixture: program, sourceCommit: null, build: { status: 'unknown' } }
  const evidence = collectPackExecutionEvidence([{ executionReceipt: raw, artifactSha256: 'b'.repeat(64), executionTarget: { host: 'android', id: 'emulator-owned', kind: 'official-simulator' } }])
  assert.equal(evidence.receipts.length, 1)
  assert.equal(evidence.receipts[0].sourceCommit, null)
  assert.equal(evidence.receipts[0].build.status, 'unknown')
  assert.equal(evidence.receipts[0].artifactSha256, 'b'.repeat(64))
  assert.equal(evidence.receipts[0].target.id, 'emulator-owned')
  assert.equal(inspectPackExecutionReceipt(evidence.receipts[0], evidence.fixture, options).status, 'incomplete')
})

test('aggregate CLI accepts repeated independent execution files, reuses mobile receipts and deduplicates a repeated path', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'weapp-pack-gate-'))
  try {
    const evidence = report(EXECUTION_HOSTS)
    const path = resolve(directory, 'execution.json')
    const aggregatePath = resolve(directory, 'aggregate.json')
    writeFileSync(path, JSON.stringify(evidence.value))
    const result = spawnSync(process.execPath, ['scripts/check-near-parity-gates.mjs',
      '--mobile', resolve(directory, 'missing-mobile.json'), '--host-bridge', resolve(directory, 'missing-bridge.json'),
      '--host-execution', path, '--host-execution', path,
      '--out', aggregatePath,
    ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 8 * 1024 * 1024 })
    // Release reports grow with archived evidence. Buffering stdout previously
    // killed this child with ENOBUFS/SIGTERM at 8 MiB (status null), before its
    // expected incomplete exit. Read the written report without buffering a
    // second copy; stderr still retains command failures for diagnosis.
    assert.ifError(result.error)
    assert.equal(result.signal, null, result.stderr)
    assert.equal(result.status, 1, 'unrelated real release gates must remain incomplete')
    const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'))
    assert.equal(aggregate.gates.mobileModuleExecution.status, 'passed')
    assert.equal(aggregate.gates.hostModuleExecution.status, 'passed')
    assert.equal(aggregate.gates.hostPackGpu.status, 'passed')
    assert.deepEqual(aggregate.gates.hostModuleExecution.duplicatePairs, [])
    assert.equal(aggregate.gates.mobile.status, 'passed')
    assert.equal(aggregate.gates.mobile.legacySurface.status, 'incomplete')
    assert.equal(aggregate.releaseReady, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Android collector validates the complete receipt, preserves unknown source and clears its previous launch file', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'weapp-android-collector-'))
  try {
    const program = fixture()
    const value = { schemaVersion: 1, ...receipt(program), fixture: program, sourceCommit: null, build: { status: 'unknown' } }
    // This is a fake adb executable and synthetic receipt test, never device
    // evidence. No emulator, GUI or actual package is installed or launched.
    const rawPath = resolve(directory, 'receipt.json')
    const commands = resolve(directory, 'commands.jsonl')
    const apk = resolve(directory, 'synthetic.apk')
    writeFileSync(rawPath, JSON.stringify(value))
    writeFileSync(apk, 'synthetic artifact for receipt collector unit test')
    writeFileSync(resolve(directory, 'adb'), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_ADB_COMMANDS, JSON.stringify(args) + '\\n');
if (args[0] === 'devices') console.log('List of devices attached\\nemulator-owned\\tdevice');
else if (args.includes('am') && args.includes('start')) writeFileSync(process.env.TEST_ADB_SESSION, args[args.indexOf('weappContainerSessionId') + 1]);
else if (args.includes('cat')) process.stdout.write(readFileSync(process.env.TEST_ADB_RECEIPT, 'utf8').split('android-quickjs-session').join(readFileSync(process.env.TEST_ADB_SESSION, 'utf8')));
else if (args.includes('logcat') && args.includes('-d')) {
  for (const op of ['app.init', 'render.commit', 'render.snapshot', 'canvas.draw', 'canvas.snapshot', 'api.call']) {
    const data = op === 'canvas.draw' ? { name:'wx.canvas.draw', canvasId:'main' }
      : op === 'canvas.snapshot' ? { format:'rgba8-premultiplied',pixels:[10,20,30,255] }
      : op === 'api.call' ? { name:'wx.canIUse',result:true } : {};
    console.log('WEAPP_CONTAINER_SMOKE ' + op + ' ' + JSON.stringify(data));
  }
}
`, { mode: 0o755 })
    // The fixture executable uses ESM syntax even when the temp directory is
    // outside the repository's package.json boundary.
    writeFileSync(resolve(directory, 'package.json'), '{"type":"module"}')
    const result = spawnSync(process.execPath, ['scripts/mobile-runtime-smoke.mjs', '--platform', 'android', '--android-apk', apk], {
      cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, WEAPP_CONTAINER_ANDROID_SERIAL: 'emulator-owned', TEST_ADB_RECEIPT: rawPath, TEST_ADB_COMMANDS: commands, TEST_ADB_SESSION: resolve(directory, 'session') },
    })
    assert.equal(result.status, 0, result.stderr)
    const aggregate = JSON.parse(result.stdout)
    const android = aggregate.platforms[0]
    assert.equal(android.checks.realPortablePack, true)
    assert.equal(android.checks.renderSnapshotRgba8, true)
    assert.equal(android.executionReceiptInspection.checks.build, false)
    assert.equal(aggregate.executionEvidence.receipts[0].sourceCommit, null)
    const invoked = readFileSync(commands, 'utf8').trim().split('\n').map(JSON.parse)
    const clear = invoked.findIndex(args => args.includes('rm') && args.includes('files/portable-pack-execution.json'))
    const start = invoked.findIndex(args => args.includes('am') && args.includes('start'))
    const read = invoked.findIndex(args => args.includes('cat') && args.includes('files/portable-pack-execution.json'))
    assert.ok(clear >= 0 && clear < start && start < read)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
