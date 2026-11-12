import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFORMANCE_BASELINE as baseline, artifactReader, inspectConformanceEvidence, inspectConformanceCaseOracle, inspectConformanceContainerPair } from './conformance-evidence.mjs'
import { createSyntheticPinnedCompilerBuild } from './fixtures/conformance-compiler-build.mjs'
import { createSyntheticCompilerUse } from './fixtures/conformance-compiler-use.mjs'
import { createSyntheticFixtureBuild } from './fixtures/conformance-fixture-build.mjs'

const project = resolve(fileURLToPath(new URL('..', import.meta.url)))
const hash = value => createHash('sha256').update(value).digest('hex')
const clone = value => structuredClone(value)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const baselineFields = Object.fromEntries(['id', 'devtoolsVersion', 'baseLibraryVersion', 'protocolVersion', 'manifestVersion'].map(key => [key, baseline[key]]))
const startedAt = '2026-10-21T10:00:00.000Z'
const endedAt = '2026-10-21T10:00:01.000Z'

// Synthetic records prove validator behavior only. No fixture in this file is
// an official run, executable build, host/device or actual conformance result.
function syntheticArchive(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'weapp-conformance-gate-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false) })
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  }).trim()
  const put = (path, bytes) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true })
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    writeFileSync(resolve(root, path), data)
    return { path, sha256: hash(data), bytes: data.length }
  }
  const json = (path, value) => put(path, JSON.stringify(value, null, 2) + '\n')
  git(['init', '-q'])
  git(['config', 'user.name', 'Weapp Container conformance gate test'])
  git(['config', 'user.email', 'weapp-conformance@example.invalid'])
  put('.gitignore', 'artifacts/\n')
  put('crates/container-runtime/src/lib.rs', 'pub const SYNTHETIC: bool = true;\n')
  json('docs/conformance/baseline-v1.json', baseline)
  mkdirSync(resolve(root, 'vendor'), { recursive: true })
  execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', resolve(project, 'vendor/weapp-vite'), resolve(root, 'vendor/weapp-vite')], { stdio: ['ignore', 'pipe', 'pipe'] })
  const { compilerBuild } = createSyntheticPinnedCompilerBuild({ root,
    source: resolve(project, 'vendor/weapp-vite'), commit: baseline.compiler.commit,
    directory: resolve(root, 'artifacts/synthetic-compiler-build') })
  git(['add', '.gitignore', 'crates', 'docs'])
  git(['update-index', '--add', '--cacheinfo', `160000,${baseline.compiler.commit},vendor/weapp-vite`])
  git(['commit', '-qm', 'synthetic measured source'])
  const measured = git(['rev-parse', 'HEAD'])
  const artifact = put('artifacts/build/native-runtime', 'synthetic native artifact; never executed\n')
  const log = put('docs/conformance/evidence/synthetic/official.log', 'synthetic runner raw output; not actual official evidence\n')
  const selection = json('docs/conformance/evidence/synthetic/selection.json', {
    queriedAt: startedAt, source: 'https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/config.json',
    selectedVersion: baseline.devtoolsVersion, acceptedVersion: baseline.devtoolsVersion, packageVersion: baseline.devtoolsVersion,
    baseLibraryVersion: baseline.baseLibraryVersion, officialVersionMatches: true, installationId: hash('synthetic installation'),
  })
  const actualRuntime = { recordedAt: startedAt,
    installationId: hash('synthetic installation'), projectPath: resolve(root, 'SYNTHETIC-OFFLINE-CONSUMER-NOT-EXECUTED/.tmp/upstream-project'),
    tool: { version: baseline.devtoolsVersion, SDKVersion: baseline.baseLibraryVersion },
    system: { SDKVersion: baseline.baseLibraryVersion, platform: 'devtools' },
  }
  const runtimeObservation = json('docs/conformance/evidence/synthetic/runtime.json', {
    schemaVersion: 1, kind: 'wechat-devtools-runtime-baseline', status: 'passed', ...actualRuntime,
  })
  const moduleContents = ['App({});', 'Page({});']
  const template = JSON.stringify({ schemaVersion: 1, nodes: [] })
  const blobs = [...moduleContents, template, ''].map((content, index) => put(`docs/conformance/evidence/synthetic/blobs/${index}`, content))
  const manifest = {
    schemaVersion: 1, protocolVersion: baseline.protocolVersion, compiler: baseline.compiler,
    app: { appJson: 'app.json', entryModule: 'app.js' },
    routes: [{ id: 'route:pages/index/index', path: 'pages/index/index', kind: 'page', entryModule: 'pages/index/index.js' }],
    modules: moduleContents.map((_, index) => ({ id: `module:${index ? 'pages/index/index.js' : 'app.js'}`, sha256: blobs[index].sha256, format: 'commonjs', scope: index ? 'page' : 'app' })),
    templates: [{ id: 'template:pages/index/index.wxml', wxmlAst: `sha256:${blobs[2].sha256}`, bindings: [] }],
    styles: [], components: [], assets: [{ path: 'empty.txt', sha256: blobs[3].sha256, mime: 'text/plain', size: 0 }], capabilities: {}, integrity: { algorithm: 'sha256', root: '' },
  }
  manifest.integrity.root = hash(canonical(manifest))
  const fixture = { id: 'synthetic-conformance', manifest }
  const resources = Object.fromEntries(blobs.map(blob => [blob.sha256, blob]))
  const index = clone(JSON.parse(readFileSync(resolve(project, 'docs/conformance/case-index-v1.json'), 'utf8')))
  const cases = index.cases.map(item => {
    const assertions = [{ id: `${item.id}: synthetic runner test`, passed: true }]
    const events = [{ seq: 0, kind: 'lifecycle', op: 'synthetic.case', payload: { caseId: item.id, count: 1 } }]
    const trace = (host, engine) => ({
      schemaVersion: 1, caseId: item.id, oracle: host === 'devtools' ? 'wechat-devtools' : 'container',
      run: { status: 'passed', host, engine, protocolVersion: baseline.protocolVersion, manifestVersion: baseline.manifestVersion, startedAt, endedAt,
        ...(host === 'devtools' ? {} : { commit: measured }),
        environment: { baselineId: baseline.id, compilerCommit: baseline.compiler.commit, caseSourceSha256: item.sourceSha256,
          manifestIntegrity: manifest.integrity.root, ...(host === 'devtools' ? {} : { sessionId: `${item.id}-${host}-${engine}`, artifactSha256: artifact.sha256 }) } },
      events: clone(events), assertions: clone(assertions),
    })
    const officialTrace = trace('devtools', 'wechat')
    const official = json(`docs/conformance/evidence/synthetic/${item.id}/official-trace.json`, officialTrace)
    const suiteReport = json(`docs/conformance/evidence/synthetic/${item.id}/vitest.json`, {
      success: true, testResults: [{ name: `/synthetic/upstream/${item.source}`, status: 'passed', assertionResults: assertions.map(assertion => ({ fullName: assertion.id, status: 'passed' })) }],
    })
    const initialUse = createSyntheticCompilerUse({ root, directory: resolve(root, 'artifacts/synthetic-compiler-use'),
      compilerBuild, caseId: item.id, sourceSha256: item.sourceSha256, caseSourcePath: item.source, startedAt, endedAt, pid: 10101 })
    const { compilerUse, fixtureBuild, runtimeObservation: fixtureRuntimeObservation } = createSyntheticFixtureBuild({ root, directory: resolve(root, 'artifacts/synthetic-fixture-build'),
      compilerBuild, compilerUse: initialUse.reference, fixture, resources, runtimeObservation: actualRuntime })
    const execution = json(`docs/conformance/evidence/synthetic/${item.id}/official-execution.json`, {
      schemaVersion: 1, kind: 'wechat-devtools-case-execution', status: 'passed', provider: 'wechat-devtools',
      caseId: item.id, sourceSha256: item.sourceSha256, compilerCommit: baseline.compiler.commit, baseline: baselineFields,
      sourceUnchanged: true, sourceBefore: item.sourceSha256, sourceAfter: item.sourceSha256,
      manifestIntegrity: manifest.integrity.root, traceSha256: official.sha256,
      observedDevtoolsVersion: baseline.devtoolsVersion, observedBaseLibraryVersion: baseline.baseLibraryVersion,
      run: { exitCode: 0, pid: 10101, startedAt, endedAt },
      resources: { owner: 'synthetic gate test', leaseAcquired: true, leaseReleased: true, ownedResourcesReleased: true, borrowedResourcesPreserved: true },
      log, selection, runtimeObservation: fixtureRuntimeObservation ?? runtimeObservation, suiteReport, compilerBuild, compilerUse, fixtureBuild,
    })
    item.status = 'passed'
    const reviewEvidence = json(`docs/conformance/evidence/synthetic/${item.id}/report.json`, {
      schemaVersion: 1, kind: 'reviewed-r1-official-result', recordedAt: endedAt,
      baseline: { id: baseline.id, devtoolsVersion: baseline.devtoolsVersion, baseLibraryVersion: baseline.baseLibraryVersion,
        compilerCommit: baseline.compiler.commit },
      case: { caseId: item.id, sourceSha256: item.sourceSha256, status: 'passed' },
      independentReader: { status: 'passed' },
      cleanup: { ownedResourcesReleased: true, borrowedResourcesPreserved: true },
      receipts: { officialExecution: execution },
    })
    item.evidence = [reviewEvidence.path]
    const containers = baseline.hosts.flatMap(host => baseline.engines.map(engine => {
      const sessionId = `${item.id}-${host}-${engine}`
      const operations = {}
      const operation = (op, payload, result) => {
        const request = { protocolVersion: baseline.protocolVersion, sessionId, requestId: `${sessionId}-${op}`, kind: 'request', op, payload }
        operations[op] = { status: 0, request, json: JSON.stringify({ messages: [{ ...request, kind: 'response', payload: { ok: true, ...result } }] }) }
      }
      operation('app.init', { manifest }, { engine, engineProviderAvailable: true, appLaunchInvoked: true, sessionId, loadedModules: manifest.modules.length,
        manifest: { integrity: manifest.integrity.root }, host: { kind: ['macos', 'windows', 'linux'].includes(host) ? 'desktop' : host, platform: host } })
      operation('app.lifecycle', { event: 'launch' }, {})
      operation('page.push', { path: 'pages/index/index' }, { page: { path: 'pages/index/index' }, pageId: 1 })
      operation('render.commit', { templateId: 'template:pages/index/index.wxml' }, { committed: true, source: 'manifest', frameId: 1, templateId: 'template:pages/index/index.wxml' })
      operations['render.snapshot'] = { status: 0, sessionId, json: JSON.stringify({ frame_id: 1, width: 1, height: 1, format: 'rgba8-premultiplied', pixels: [0, 0, 0, 0] }) }
      const normalized = json(`docs/conformance/evidence/synthetic/${item.id}/${host}-${engine}.json`, trace(host, engine))
      const receipt = {
        status: 'passed', host, engine, fixtureId: fixture.id, manifestIntegrity: manifest.integrity.root, sourceCommit: measured,
        artifactSha256: artifact.sha256, build: { status: 'passed', sourceCommit: measured, workingTreeDirty: false, host, engine, artifactSha256: artifact.sha256 },
        target: { host, id: `synthetic-${host}`, kind: ['android', 'ios', 'harmony'].includes(host) ? 'official-simulator' : host === 'web' ? 'browser' : 'native-window' },
        sessionId, route: 'pages/index/index', operations,
        conformance: { caseId: item.id, sourceSha256: item.sourceSha256, traceSha256: normalized.sha256, baselineId: baseline.id },
      }
      return { trace: normalized, execution: receipt, artifact }
    }))
    return { caseId: item.id, sourceSha256: item.sourceSha256, fixture, resources, oracle: { trace: official, execution }, containers }
  })
  const indexPath = resolve(root, 'docs/conformance/case-index-v1.json')
  const indexReference = json('docs/conformance/case-index-v1.json', index)
  put('docs/conformance/case-index-v1.sha256', `${indexReference.sha256}  case-index-v1.json\n`)
  const report = { schemaVersion: 1, kind: 'weapp-container-differential', suite: baseline.suite, generatedAt: endedAt,
    indexSha256: indexReference.sha256, sourceCommit: measured, baseline: baselineFields, cases }
  const reportPath = resolve(root, 'docs/conformance/evidence/synthetic/report.json')
  json('docs/conformance/evidence/synthetic/report.json', report)
  git(['add', 'docs/conformance'])
  git(['commit', '-qm', 'synthetic differential archive'])
  const head = git(['rev-parse', 'HEAD'])
  const inspect = (candidate = clone(report), candidateIndex = clone(index), expectedCommit = head) => inspectConformanceEvidence(
    { path: indexPath, value: candidateIndex, error: null }, candidate === null ? null : { path: reportPath, value: candidate, error: null }, { root, expectedCommit })
  const alterArtifact = (reference, update, body) => {
    const path = resolve(root, reference.path)
    const bytes = readFileSync(path)
    try {
      const value = JSON.parse(bytes)
      update(value)
      const replacement = Buffer.from(JSON.stringify(value, null, 2) + '\n')
      writeFileSync(path, replacement)
      return body({ path: reference.path, sha256: hash(replacement), bytes: replacement.length })
    } finally { writeFileSync(path, bytes) }
  }
  const reviewedIndex = (change, body) => {
    const value = clone(index)
    change(value)
    const reference = json('docs/conformance/case-index-v1.json', value)
    put('docs/conformance/case-index-v1.sha256', `${reference.sha256}  case-index-v1.json\n`)
    git(['add', 'docs/conformance/case-index-v1.json', 'docs/conformance/case-index-v1.sha256'])
    git(['commit', '-qm', 'synthetic invalid reviewed index'])
    try { return body(value, git(['rev-parse', 'HEAD'])) } finally { git(['reset', '--hard', head]) }
  }
  return { root, git, head, measured, index, report, inspect, alterArtifact, reviewedIndex, json, put }
}

test('full conformance gate rejects missing, stale and substituted evidence', async t => {
  const fixture = syntheticArchive(t)
  const pair = baseline.hosts.flatMap(host => baseline.engines.map(engine => `${host}/${engine}`))
  const first = fixture.index.cases[0].id
  await t.test('synthetic complete matrix demonstrates the positive validation path only', () => {
    const result = fixture.inspect()
    assert.equal(result.status, 'passed', JSON.stringify(result.differential.cases.find(item => item.status !== 'passed') || result.differential.errors))
    assert.equal(result.sourceValidation.sourceFiles, 172)
    assert.equal(result.differential.cases.length, 172)
    assert.ok(result.differential.cases.every(item => Object.keys(item.pairs).length === 14))
    assert.match(result.officialObservations.meaning, /not container differential passes/)
  })
  await t.test('execution admission shares the exact oracle and pair checks', () => {
    const item = fixture.index.cases[0]
    const entry = fixture.report.cases[0]
    const options = { root: fixture.root, expectedCommit: fixture.head, sourceCommit: fixture.measured, host: 'web', engine: 'quickjs' }
    assert.equal(inspectConformanceCaseOracle(item, entry, options).status, 'passed')
    assert.equal(inspectConformanceContainerPair(item, entry, entry.containers[0], options).status, 'passed')
    assert.match(inspectConformanceContainerPair(item, entry, entry.containers[1], options).error, /substituted/)
    const unreviewed = { ...item, evidence: [] }
    assert.match(inspectConformanceCaseOracle(unreviewed, entry, options).error, /reviewed/)
    const otherCase = { ...item, id: 'ide-other-case' }
    assert.match(inspectConformanceContainerPair(otherCase, entry, entry.containers[0], options).error, /identity/)
    const stale = { ...options, sourceCommit: '0'.repeat(40) }
    assert.match(inspectConformanceContainerPair(item, entry, entry.containers[0], stale).error, /build sources/)
  })
  await t.test('formal oracle rejects retained dist without a verified compiler build', () => {
    const item = fixture.index.cases[0]
    const entry = clone(fixture.report.cases[0])
    fixture.alterArtifact(entry.oracle.execution, execution => { delete execution.compilerBuild }, reference => {
      entry.oracle.execution = reference
      const result = inspectConformanceCaseOracle(item, entry, { root: fixture.root })
      assert.equal(result.status, 'incomplete')
      assert.match(result.error, /compiler build evidence is required/)
    })
  })
  await t.test('a valid fresh build cannot replace actual per-case compiler consumption', () => {
    const item = fixture.index.cases[0]
    const original = fixture.report.cases[0]
    for (const change of [execution => { delete execution.compilerUse }, execution => { execution.run.pid++ }]) {
      fixture.alterArtifact(original.oracle.execution, change, reference => {
        const entry = clone(original); entry.oracle.execution = reference
        const result = inspectConformanceCaseOracle(item, entry, { root: fixture.root })
        assert.equal(result.status, 'incomplete')
        assert.match(result.error, /compiler consumption|consumer/i)
      })
    }
  })
  await t.test('formal oracle requires actual case generation and packer provenance', () => {
    const item = fixture.index.cases[0]
    const original = fixture.report.cases[0]
    fixture.alterArtifact(original.oracle.execution, execution => { delete execution.fixtureBuild }, reference => {
      const entry = clone(original); entry.oracle.execution = reference
      const result = inspectConformanceCaseOracle(item, entry, { root: fixture.root })
      assert.equal(result.status, 'incomplete')
      assert.match(result.error, /actual case fixture build is required/)
    })
  })
  await t.test('compiler evidence rejects a failed build and tampered output bytes', () => {
    const item = fixture.index.cases[0]
    const original = fixture.report.cases[0]
    const execution = JSON.parse(readFileSync(resolve(fixture.root, original.oracle.execution.path)))
    fixture.alterArtifact(execution.compilerBuild, build => { build.status = 'failed' }, reference => {
      fixture.alterArtifact(execution.fixtureBuild, value => { value.compilerBuild = reference }, fixtureBuild => {
        fixture.alterArtifact(original.oracle.execution, value => { value.compilerBuild = reference; value.fixtureBuild = fixtureBuild }, receipt => {
          const entry = clone(original); entry.oracle.execution = receipt
          const result = inspectConformanceCaseOracle(item, entry, { root: fixture.root })
          assert.equal(result.status, 'incomplete')
          assert.match(result.error, /compiler build is failed/)
        })
      })
    })
    const build = JSON.parse(readFileSync(resolve(fixture.root, execution.compilerBuild.path)))
    const file = resolve(fixture.root, build.outputs[0].artifact.path), bytes = readFileSync(file)
    try {
      writeFileSync(file, Buffer.concat([bytes, Buffer.from('tampered')]))
      const result = inspectConformanceCaseOracle(item, original, { root: fixture.root })
      assert.equal(result.status, 'incomplete')
      assert.match(result.error, /hash\/size differs/)
    } finally { writeFileSync(file, bytes) }
  })
  await t.test('all official statuses passed still cannot replace the differential report', () => {
    const result = fixture.inspect(null)
    assert.equal(result.status, 'incomplete')
    assert.equal(result.counts.passed, 172)
    assert.equal(result.differential.cases.length, 172)
    assert.deepEqual(result.differential.cases[0].missingPairs, pair)
  })
  await t.test('malformed cases do not crash the aggregate audit', () => {
    const result = fixture.inspect(null, { ...fixture.index, cases: {} })
    assert.equal(result.status, 'incomplete')
    assert.match(result.sourceValidation.errors.join('\n'), /schema/)
  })
  await t.test('a rewritten golden cannot hide an omitted pinned upstream case', () => fixture.reviewedIndex(index => { index.cases.pop(); index.generatedFrom.fileCount-- }, (index, head) => {
    const result = fixture.inspect(null, index, head)
    assert.match(result.sourceValidation.errors.join('\n'), /all baseline source files/)
  }))
  await t.test('a reviewed but duplicated case/source is rejected', () => fixture.reviewedIndex(index => { index.cases[0] = clone(index.cases[1]) }, (index, head) => {
    const result = fixture.inspect(null, index, head)
    assert.match(result.sourceValidation.errors.join('\n'), /duplicate|missing index/)
  }))
  await t.test('a rewritten golden cannot substitute another source hash', () => fixture.reviewedIndex(index => { index.cases[0].sourceSha256 = 'a'.repeat(64) }, (index, head) => {
    const result = fixture.inspect(null, index, head)
    assert.match(result.sourceValidation.errors.join('\n'), /pinned source identity\/hash differs/)
  }))
  await t.test('the caller cannot select another DevTools or SDK baseline', () => fixture.reviewedIndex(index => { index.oracle.baseLibraryVersion = '3.99.9' }, (index, head) => {
    const result = fixture.inspect(null, index, head)
    assert.match(result.sourceValidation.errors.join('\n'), /fixed baseline/)
  }))
  await t.test('changing an index without its committed golden is rejected', () => {
    const index = clone(fixture.index)
    index.cases[0].status = 'unknown'
    assert.equal(fixture.inspect(null, index).sourceValidation.status, 'incomplete')
  })
  await t.test('legacy reports, missing cases and a wrong index hash do not pass', () => {
    assert.equal(fixture.inspect({ schemaVersion: 1, status: 'passed' }).status, 'incomplete')
    const report = clone(fixture.report)
    report.cases.pop()
    assert.match(fixture.inspect(report).differential.errors.join('\n'), /case set/)
    report.cases.push(clone(report.cases[0]))
    assert.match(fixture.inspect(report).differential.errors.join('\n'), /case set/)
    report.indexSha256 = 'b'.repeat(64)
    assert.match(fixture.inspect(report).differential.errors.join('\n'), /index or fixed baseline/)
  })
  await t.test('missing host/engine pairs remain explicit', () => {
    const report = clone(fixture.report)
    report.cases[0].containers = report.cases[0].containers.filter(item => item.execution.host !== 'ios')
    const result = fixture.inspect(report)
    assert.equal(result.status, 'incomplete')
    assert.deepEqual(result.differential.cases[0].missingPairs, ['ios/quickjs', 'ios/v8'])
  })
  await t.test('duplicate pairs cannot count as a complete matrix', () => {
    const report = clone(fixture.report)
    report.cases[0].containers[13] = clone(report.cases[0].containers[0])
    const result = fixture.inspect(report)
    assert.equal(result.status, 'incomplete')
    assert.match(result.differential.cases[0].errors.join('\n'), /duplicate container pair/)
  })
  await t.test('an unrelated actual-pack startup receipt cannot be relabeled as a case', () => {
    const report = clone(fixture.report)
    report.cases[0].containers[0].execution.conformance.caseId = fixture.index.cases[1].id
    assert.match(fixture.inspect(report).differential.cases[0].pairs['web/quickjs'].error, /bound to this case/)
  })
  await t.test('the exact source and pair sets reject extra and substituted identities', () => {
    const report = clone(fixture.report)
    report.cases.push(clone(report.cases[0]))
    assert.match(fixture.inspect(report).differential.errors.join('\n'), /case set/)
    report.cases.pop()
    report.cases[0].caseId = 'ide-unrelated-source'
    assert.match(fixture.inspect(report).differential.cases[0].errors.join('\n'), /source identity/)
    report.cases[0] = clone(fixture.report.cases[0])
    report.cases[0].containers.push(clone(report.cases[0].containers[0]))
    assert.match(fixture.inspect(report).differential.cases[0].errors.join('\n'), /duplicate container pair/)
    report.cases[0].containers.at(-1).execution.host = 'headless'
    assert.match(fixture.inspect(report).differential.cases[0].errors.join('\n'), /unexpected.*headless/)
  })
  await t.test('native provider, real artifact bytes and snapshot/startup receipts are required', () => {
    const report = clone(fixture.report)
    const receipt = report.cases[0].containers[0].execution
    const response = JSON.parse(receipt.operations['app.init'].json)
    response.messages[0].payload.engineProviderAvailable = false
    receipt.operations['app.init'].json = JSON.stringify(response)
    assert.match(fixture.inspect(report).differential.cases[0].pairs['web/quickjs'].error, /actual-pack execution/)
    report.cases[0].containers[0] = clone(fixture.report.cases[0].containers[0])
    report.cases[0].containers[0].artifact.sha256 = 'c'.repeat(64)
    assert.match(fixture.inspect(report).differential.cases[0].pairs['web/quickjs'].error, /SHA-256 differs/)
  })
  await t.test('trace file corruption is rejected before differential comparison', () => {
    const report = clone(fixture.report)
    report.cases[0].containers[0].trace.sha256 = 'd'.repeat(64)
    report.cases[0].containers[0].execution.conformance.traceSha256 = 'd'.repeat(64)
    assert.match(fixture.inspect(report).differential.cases[0].pairs['web/quickjs'].error, /SHA-256 differs/)
  })
  await t.test('empty resource blobs are valid but an empty executable artifact is not', () => {
    const report = clone(fixture.report)
    const empty = fixture.put('artifacts/build/empty-runtime', '')
    report.cases[0].containers[0].artifact = empty
    report.cases[0].containers[0].execution.artifactSha256 = empty.sha256
    report.cases[0].containers[0].execution.build.artifactSha256 = empty.sha256
    assert.match(fixture.inspect(report).differential.cases[0].pairs['web/quickjs'].error, /build artifact is empty/)
  })
  await t.test('rehashing a semantically different trace still fails automatic diff', () => {
    const report = clone(fixture.report)
    fixture.alterArtifact(report.cases[0].containers[0].trace, trace => { trace.events[0].payload.count = 2 }, reference => {
      report.cases[0].containers[0].trace = reference
      report.cases[0].containers[0].execution.conformance.traceSha256 = reference.sha256
      assert.match(fixture.inspect(report).differential.cases[0].pairs['web/quickjs'].error, /observations\/assertion coverage differ/)
    })
  })
  await t.test('a reused trace cannot swap its session, engine or source identity', () => {
    const report = clone(fixture.report)
    fixture.alterArtifact(report.cases[0].containers[0].trace, trace => { trace.run.environment.sessionId = 'unrelated' }, reference => {
      report.cases[0].containers[0].trace = reference
      report.cases[0].containers[0].execution.conformance.traceSha256 = reference.sha256
      assert.match(fixture.inspect(report).differential.cases[0].pairs['web/quickjs'].error, /startup session\/build differ/)
    })
  })
  await t.test('empty/failed assertions and unordered events cannot masquerade as equal', () => {
    const report = clone(fixture.report)
    fixture.alterArtifact(report.cases[0].containers[0].trace, trace => { trace.assertions = []; trace.events.push(clone(trace.events[0])) }, reference => {
      report.cases[0].containers[0].trace = reference
      report.cases[0].containers[0].execution.conformance.traceSha256 = reference.sha256
      assert.match(fixture.inspect(report).differential.cases[0].pairs['web/quickjs'].error, /sequence|assertions/)
    })
  })
  await t.test('oracle receipt must bind the exact trace, baseline, runner assertions and cleanup', () => {
    const report = clone(fixture.report)
    fixture.alterArtifact(report.cases[0].oracle.execution, execution => { execution.resources.leaseReleased = false }, reference => {
      report.cases[0].oracle.execution = reference
      assert.match(fixture.inspect(report).differential.cases[0].errors.join('\n'), /resources|lease\/cleanup/)
    })
  })
  await t.test('official runner coverage cannot omit or skip an assertion', () => {
    const report = clone(fixture.report)
    fixture.alterArtifact(report.cases[0].oracle.execution, execution => {
      execution.suiteReport = fixture.json('artifacts/synthetic-skipped-vitest.json', {
        success: true, testResults: [{ name: `/synthetic/upstream/${fixture.index.cases[0].source}`, status: 'passed',
          assertionResults: [{ fullName: 'not actually run', status: 'skipped' }] }],
      })
    }, reference => {
      report.cases[0].oracle.execution = reference
      assert.match(fixture.inspect(report).differential.cases[0].errors.join('\n'), /runner test results/)
    })
  })
  await t.test('declared SDK labels cannot replace the actual Tool/wx runtime observation', () => {
    for (const mutation of [
      execution => { delete execution.runtimeObservation },
      execution => {
        execution.runtimeObservation = fixture.json('artifacts/synthetic-wrong-runtime.json', {
          schemaVersion: 1, kind: 'wechat-devtools-runtime-baseline', status: 'passed', recordedAt: startedAt,
          installationId: hash('synthetic installation'), projectPath: '/synthetic/upstream/project',
          tool: { version: baseline.devtoolsVersion, SDKVersion: baseline.baseLibraryVersion },
          system: { SDKVersion: '3.13.2', platform: 'devtools' },
        })
      },
      execution => {
        const runtime = JSON.parse(readFileSync(resolve(fixture.root, execution.runtimeObservation.path), 'utf8'))
        runtime.installationId = 'f'.repeat(64)
        execution.runtimeObservation = fixture.json('artifacts/synthetic-foreign-runtime.json', runtime)
      },
      execution => {
        const runtime = JSON.parse(readFileSync(resolve(fixture.root, execution.runtimeObservation.path), 'utf8'))
        runtime.recordedAt = '2026-10-20T10:00:00.000Z'
        execution.runtimeObservation = fixture.json('artifacts/synthetic-stale-runtime.json', runtime)
      },
    ]) {
      const report = clone(fixture.report)
      fixture.alterArtifact(report.cases[0].oracle.execution, mutation, reference => {
        report.cases[0].oracle.execution = reference
        assert.match(fixture.inspect(report).differential.cases[0].errors.join('\n'), /runtime observation|Tool\/wx runtime baseline/)
      })
    }
  })
  await t.test('a newer official release requires an explicit exact historical baseline selection', () => {
    const futureVersion = '2.02.9912310' // Synthetic newer release, never the active baseline.
    const historical = {
      versionPolicy: 'selected-version-opt-in', selectedChannel: 'stable', officialVersionMatches: false,
      officialVersion: futureVersion,
    }
    for (const [change, accepted] of [
      [historical, true],
      [{ ...historical, versionPolicy: 'installed-stable' }, false],
      [{ ...historical, selectedChannel: 'nightly' }, false],
      [{ ...historical, officialVersion: null }, false],
      [{ ...historical, selectedVersion: futureVersion }, false],
      [{ ...historical, acceptedVersion: futureVersion }, false],
    ]) {
      const report = clone(fixture.report)
      fixture.alterArtifact(report.cases[0].oracle.execution, execution => {
        const selection = JSON.parse(readFileSync(resolve(fixture.root, execution.selection.path), 'utf8'))
        execution.selection = fixture.json('artifacts/synthetic-historical-selection.json', { ...selection, ...change })
      }, reference => {
        report.cases[0].oracle.execution = reference
        // The synthetic review must bind the changed receipt as strictly as a real review.
        fixture.alterArtifact({ path: fixture.index.cases[0].evidence[0] }, review => {
          review.receipts.officialExecution = reference
        }, () => {
          const result = fixture.inspect(report)
          if (accepted) assert.equal(result.status, 'passed', JSON.stringify(result.differential.cases[0].errors))
          else assert.match(result.differential.cases[0].errors.join('\n'), /installation selection/)
        })
      })
    }
  })
  await t.test('rehashing receipts cannot substitute executed test bytes or another runner source', () => {
    const report = clone(fixture.report)
    fixture.alterArtifact(report.cases[0].oracle.execution, execution => { execution.sourceBefore = 'f'.repeat(64) }, reference => {
      report.cases[0].oracle.execution = reference
      assert.match(fixture.inspect(report).differential.cases[0].errors.join('\n'), /executed source guard/)
    })
    report.cases[0].oracle.execution = clone(fixture.report.cases[0].oracle.execution)
    fixture.alterArtifact(report.cases[0].oracle.execution, execution => {
      execution.suiteReport = fixture.json('artifacts/synthetic-other-source-vitest.json', {
        success: true, testResults: [{ name: `/synthetic/upstream/${fixture.index.cases[1].source}`, status: 'passed',
          assertionResults: [{ fullName: `${first}: synthetic runner test`, status: 'passed' }] }],
      })
    }, reference => {
      report.cases[0].oracle.execution = reference
      assert.match(fixture.inspect(report).differential.cases[0].errors.join('\n'), /exactly this passed source/)
    })
  })
  await t.test('official version metadata cannot silently switch to an auxiliary provider', () => {
    const report = clone(fixture.report)
    fixture.alterArtifact(report.cases[0].oracle.execution, execution => { execution.provider = 'mpcore' }, reference => {
      report.cases[0].oracle.execution = reference
      assert.match(fixture.inspect(report).differential.cases[0].errors.join('\n'), /oracle execution schema|official runtime baseline/)
    })
  })
  await t.test('fixture blobs cannot be replaced by hash-shaped metadata', () => {
    const report = clone(fixture.report)
    const key = Object.keys(report.cases[0].resources)[0]
    delete report.cases[0].resources[key]
    assert.match(fixture.inspect(report).differential.cases[0].errors.join('\n'), /resource closure/)
  })
  await t.test('path traversal artifact escapes fail closed', () => {
    const report = clone(fixture.report)
    report.cases[0].containers[0].artifact.path = '../outside'
    assert.match(fixture.inspect(report).differential.cases[0].pairs['web/quickjs'].error, /unsafe artifact path/)
  })
  await t.test('artifact symlinks are rejected even when their target bytes match', () => {
    const report = clone(fixture.report)
    const target = report.cases[0].containers[0].artifact
    const link = resolve(fixture.root, 'artifacts/build/symlink-runtime')
    symlinkSync(resolve(fixture.root, target.path), link)
    try {
      report.cases[0].containers[0].artifact.path = 'artifacts/build/symlink-runtime'
      assert.match(fixture.inspect(report).differential.cases[0].pairs['web/quickjs'].error, /symlink artifact/)
    } finally { rmSync(link) }
  })
  await t.test('runtime source changes invalidate old source/build receipts', () => {
    fixture.put('crates/container-runtime/src/lib.rs', 'pub const SYNTHETIC: bool = false;\n')
    fixture.git(['add', 'crates'])
    fixture.git(['commit', '-qm', 'synthetic runtime change'])
    try {
      const result = fixture.inspect(clone(fixture.report), clone(fixture.index), fixture.git(['rev-parse', 'HEAD']))
      assert.equal(result.status, 'incomplete')
      assert.match(result.differential.errors.join('\n'), /build is stale/)
    } finally { fixture.git(['reset', '--hard', fixture.head]) }
  })
  await t.test('missing pinned Git objects cannot be substituted by a dirty working tree', () => {
    const source = resolve(fixture.root, 'vendor/weapp-vite')
    renameSync(source, source + '-hidden')
    try { assert.equal(fixture.inspect(null).sourceValidation.status, 'incomplete') } finally { renameSync(source + '-hidden', source) }
  })
  assert.equal(fixture.index.cases[0].id, first)
  // The shared clone intentionally has no checked-out upstream working tree;
  // no test edits it. All owned main-repository inputs must be restored.
  assert.equal(fixture.git(['status', '--porcelain', '--ignore-submodules=all']), '')
})

test('artifact reader returns verified bytes for source-bound evidence', t => {
  const root = mkdtempSync(resolve(tmpdir(), 'weapp-conformance-reader-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false) })
  const path = 'objects/guest-source.vue'
  const file = resolve(root, path)
  mkdirSync(dirname(file), { recursive: true })
  const bytes = Buffer.from('<script setup>return { value: true }</script>\n')
  writeFileSync(file, bytes)
  const reference = { path, bytes: bytes.length, sha256: hash(bytes) }
  const reader = artifactReader(root)
  assert.deepEqual(reader.loadBytes(reference, 'audited guest source'), bytes)
  assert.equal(reader.stable(), true)

  writeFileSync(file, Buffer.from('changed guest source'))
  assert.throws(() => reader.loadBytes(reference, 'audited guest source'), /artifact (?:SHA-256 differs|changed while reading bytes)/)
  assert.equal(reader.stable(), false)
})

test('actual repository index and official observations cannot satisfy a missing differential matrix', () => {
  const indexPath = resolve(project, 'docs/conformance/case-index-v1.json')
  const bytes = readFileSync(indexPath)
  const index = { path: indexPath, value: JSON.parse(bytes), error: null }
  const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim()
  const options = { root: project, expectedCommit }
  const missing = inspectConformanceEvidence(index, null, options)
  const committedGolden = execFileSync('git', ['show', `${expectedCommit}:docs/conformance/case-index-v1.sha256`], { cwd: project, encoding: 'utf8' }).trim()
  const reviewed = committedGolden === `${hash(bytes)}  case-index-v1.json`
  assert.equal(missing.sourceValidation.status, reviewed ? 'passed' : 'incomplete', JSON.stringify(missing.sourceValidation))
  if (reviewed) assert.equal(missing.sourceValidation.sourceFiles, 172)
  else assert.deepEqual(missing.sourceValidation.errors, ['case index differs from committed golden hash'])
  assert.equal(missing.status, 'incomplete')
  assert.equal(missing.differential.cases.length, 172)
  assert.ok(missing.differential.cases.every(item => item.status === 'incomplete' && item.missingPairs.length === 14))
  if (reviewed) assert.match(missing.differential.errors.join('\n'), /missing --conformance-report/)
  const authoredCounts = inspectConformanceEvidence(index, {
    path: 'not-an-archived-report', error: null,
    value: { schemaVersion: 1, kind: 'weapp-container-differential', status: 'passed', total: 172, passed: 172, hosts: 7, engines: 2 },
  }, options)
  assert.equal(authoredCounts.status, 'incomplete')
  if (reviewed) assert.match(authoredCounts.differential.errors.join('\n'), /differential schema/)
  else assert.deepEqual(authoredCounts.sourceValidation, missing.sourceValidation)
  assert.deepEqual(readFileSync(indexPath), bytes, 'negative audit must never alter official statuses')
})
