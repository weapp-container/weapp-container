/** Explicit offline reader tests. All process/SDK receipts are synthetic and
 * no compiler, loader, packer, DevTools or native target executes. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveCompilerBuildBytes } from '../conformance-compiler-build.mjs'
import { inspectConformanceFixtureBuildEvidence } from '../conformance-fixture-build.mjs'
import { TEMPLATE_STATIC_CASES } from '../conformance-static-cli-profile.mjs'
import { createSyntheticPinnedCompilerBuild } from './conformance-compiler-build.mjs'
import { createSyntheticCompilerUse } from './conformance-compiler-use.mjs'
import { createSyntheticFixtureBuild } from './conformance-fixture-build.mjs'

const project = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const baseline = JSON.parse(readFileSync(join(project, 'docs/conformance/baseline-v1.json')))
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)

test('synthetic reader fixture preserves both exact template transactions and direct fixtures', async t => {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-template-reader-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'artifacts/synthetic-only')
  const put = bytes => archiveCompilerBuildBytes({ root, directory, bytes: typeof bytes === 'string' || Buffer.isBuffer(bytes) ? bytes : JSON.stringify(bytes) })
  const read = ref => JSON.parse(readFileSync(join(root, ref.path)))
  const { compilerBuild } = createSyntheticPinnedCompilerBuild({ root, source: join(project, 'vendor/weapp-vite'), commit: baseline.compiler.commit,
    directory: join(root, 'artifacts/synthetic-build') })
  const modules = ['App({});', 'Page({});'].map(put), template = put('{"schemaVersion":1,"nodes":[]}')
  const manifest = { schemaVersion: 1, protocolVersion: baseline.protocolVersion, compiler: baseline.compiler,
    app: { appJson: 'app.json', entryModule: 'app.js' }, routes: [{ id: 'route:pages/index/index', path: 'pages/index/index', kind: 'page', entryModule: 'pages/index/index.js' }],
    modules: modules.map((item, index) => ({ id: `module:${index ? 'pages/index/index.js' : 'app.js'}`, sha256: item.sha256, format: 'commonjs', scope: index ? 'page' : 'app' })),
    templates: [{ id: 'template:pages/index/index.wxml', wxmlAst: `sha256:${template.sha256}`, bindings: [] }],
    styles: [], components: [], assets: [], capabilities: {}, integrity: { algorithm: 'sha256', root: '' } }
  manifest.integrity.root = hash(canonical(manifest))
  const fixture = { id: 'synthetic-template-reader-only', manifest }, resources = Object.fromEntries([...modules, template].map(ref => [ref.sha256, ref]))
  const direct = JSON.parse(readFileSync(join(project, 'docs/conformance/case-index-v1.json'))).cases.find(item => !TEMPLATE_STATIC_CASES.some(value => value.caseId === item.id))
  const identities = [...TEMPLATE_STATIC_CASES, { caseId: direct.id, caseSourcePath: direct.source, sourceSha256: direct.sourceSha256 }]
  for (const identity of identities) await t.test(identity.caseId, async t => {
    const runtime = { recordedAt: '2026-10-21T10:00:00.000Z', installationId: 'a'.repeat(64), projectPath: join(root, 'SYNTHETIC-NOT-EXECUTED/project'),
      tool: { version: baseline.devtoolsVersion }, system: { SDKVersion: baseline.baseLibraryVersion } }
    const initial = createSyntheticCompilerUse({ root, directory, compilerBuild, ...identity, startedAt: runtime.recordedAt, endedAt: runtime.recordedAt })
    const generated = createSyntheticFixtureBuild({ root, directory, compilerBuild, compilerUse: initial.reference, fixture, resources, runtimeObservation: runtime })
    const inspect = (reference = generated.reference) => inspectConformanceFixtureBuildEvidence({ root, reference, compilerBuild,
      compilerUse: generated.compilerUse, expectedCommit: baseline.compiler.commit, caseId: identity.caseId, sourceSha256: identity.sourceSha256,
      fixture, resources, runtimeObservation: generated.runtimeObservation ? read(generated.runtimeObservation) : runtime })
    assert.deepEqual(inspect().errors, [])
    const captured = read(generated.attestation.checkpoint), summary = read(generated.attestation.recorderSummary)
    if (identity === identities.at(-1)) {
      assert.equal(generated.attestation.producerProfile, undefined)
      assert.equal(captured.producerTransaction, undefined)
      return
    }
    assert.equal(generated.attestation.producerProfile, 'template-native-static-snapshot-v1')
    assert.equal(generated.attestation.producerInputs.length, 5)
    assert.deepEqual(captured.build.command.slice(-3), ['--platform', 'weapp', '--skipNpm'])
    assert.ok(captured.build.sourceBefore.length > 5)
    assert.equal(captured.build.projectOutput.filter(item => item.path.startsWith('weapp/dist/')).length, captured.build.generated.length)
    assert.equal(summary.producerCandidates.length, 1)
    assert.equal(summary.producerFinal.length, 1)
    assert.equal(summary.finalGuard, 'same-source-and-generated-closure')
    const transaction = read(captured.producerTransaction), phase = read(captured.runtimeConfiguration), guards = read(captured.generationGuards)
    assert.deepEqual(transaction.launchProjectConfig, { setting: { skylineRenderEnable: false }, libVersion: '3.17.3' })
    assert.equal(phase.phase, 'sdk-checkpoint')
    assert.deepEqual(phase.runtimeObservation, captured.runtimeObservation)
    assert.deepEqual(summary.producerFinal[0].runtimeConfiguration, captured.runtimeConfiguration)
    assert.deepEqual(Object.keys(guards.closures).sort(), ['generated', 'project', 'runtime', 'source'])
    assert.deepEqual(phase.afterFiles.filter((item, index) => item.artifact.sha256 !== phase.beforeFiles[index].artifact.sha256).map(item => item.path), ['project.config.json'])
    const fixtureMutation = update => {
      const value = structuredClone(generated.attestation); update(value); return inspect(put(value)).errors.join('\n')
    }
    await t.test('incomplete producer module closure is rejected', () => {
      assert.match(fixtureMutation(value => value.producerInputs.pop()), /snapshot closure differs/)
    })
    await t.test('missing snapshot transaction is rejected', () => {
      assert.match(fixtureMutation(value => {
        const checkpoint = structuredClone(captured); delete checkpoint.producerTransaction; value.checkpoint = put(checkpoint)
      }), /checkpoint fields are incomplete/)
    })
    await t.test('unsettled original snapshot removal is rejected', () => {
      assert.match(fixtureMutation(value => {
        const changed = structuredClone(summary), cleanup = read(changed.producerFinal[0].cleanup)
        cleanup.originalRemoval.status = 'rejected'; changed.producerFinal[0].cleanup = put(cleanup); value.recorderSummary = put(changed)
      }), /original snapshot removal boundary is missing/)
    })
    await t.test('missing post-launch runtime configuration is rejected', () => {
      assert.match(fixtureMutation(value => {
        const checkpoint = structuredClone(captured); delete checkpoint.runtimeConfiguration; value.checkpoint = put(checkpoint)
      }), /omitted the actual launch configuration transaction/)
    })
    await t.test('incomplete generation operands are rejected', () => {
      assert.match(fixtureMutation(value => {
        const checkpoint = structuredClone(captured), guards = read(checkpoint.generationGuards)
        delete guards.closures.generated; checkpoint.generationGuards = put(guards); value.checkpoint = put(checkpoint)
      }), /generation operand set is incomplete/)
    })
  })
})
