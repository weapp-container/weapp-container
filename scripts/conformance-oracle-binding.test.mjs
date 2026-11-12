import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { bindMatrixOracle, executeMatrixDriver } from './conformance-matrix-runner.mjs'
import { conformanceArtifactReference } from './conformance-recipes.mjs'
import { run as runNative, runDiagnostic } from '../examples/hosts/conformance-desktop/driver.mjs'

const sourceSha256 = 'a'.repeat(64)
const job = { caseId: 'ide-oracle-binding-test', sourceSha256, host: 'web', engine: 'quickjs' }
const reference = (path, sha256 = 'b'.repeat(64), bytes = 12) => ({ path, sha256, bytes })
const oracle = () => ({ trace: reference('official/trace.json'), execution: reference('official/execution.json') })
const input = () => ({ job: { ...job }, recipe: { caseId: job.caseId, sourceSha256 },
  admittedOracle: { caseId: job.caseId, sourceSha256, oracle: oracle() } })

test('binding uses exact admitted refs when recipe omits oracle and detaches both copies', () => {
  const value = input()
  const bound = bindMatrixOracle(value)
  assert.deepEqual(bound.recipe.oracle, value.admittedOracle.oracle)
  assert.deepEqual(bound.admittedOracle, value.admittedOracle)
  assert.notEqual(bound.recipe, value.recipe)
  assert.notEqual(bound.recipe.oracle, bound.admittedOracle.oracle)
  value.admittedOracle.oracle.trace.path = 'changed/trace.json'
  bound.recipe.oracle.execution.bytes++
  assert.equal(bound.admittedOracle.oracle.trace.path, 'official/trace.json')
  assert.equal(bound.admittedOracle.oracle.execution.bytes, 12)
  assert.equal(value.recipe.oracle, undefined)
})

test('binding rejects each trace/execution path, digest and byte substitution', async t => {
  for (const kind of ['trace', 'execution']) for (const field of ['path', 'sha256', 'bytes']) {
    await t.test(`${kind}.${field}`, () => {
      const value = input()
      value.recipe.oracle = structuredClone(value.admittedOracle.oracle)
      value.recipe.oracle[kind][field] = field === 'path' ? `other/${kind}.json` : field === 'sha256' ? 'c'.repeat(64) : 13
      assert.throws(() => bindMatrixOracle(value), /differs from the admitted oracle identity/)
    })
  }
})

test('binding rejects changed case/source and malformed or augmented canonical identities', async t => {
  const changes = {
    'binding case': v => { v.admittedOracle.caseId = 'ide-other' },
    'binding source': v => { v.admittedOracle.sourceSha256 = 'd'.repeat(64) },
    'job source': v => { v.job.sourceSha256 = 'd'.repeat(64) },
    'recipe source': v => { v.recipe.sourceSha256 = 'd'.repeat(64) },
    'recipe case': v => { v.recipe.caseId = 'ide-other' },
    'extra binding key': v => { v.admittedOracle.passed = true },
    'extra oracle key': v => { v.admittedOracle.oracle.passed = true },
    'extra ref key': v => { v.admittedOracle.oracle.trace.passed = true },
    'missing execution': v => { delete v.admittedOracle.oracle.execution },
    'invalid hash': v => { v.admittedOracle.oracle.trace.sha256 = 'B'.repeat(64) },
    'fractional bytes': v => { v.admittedOracle.oracle.trace.bytes = 1.5 },
    'negative bytes': v => { v.admittedOracle.oracle.trace.bytes = -1 },
    'absolute path': v => { v.admittedOracle.oracle.trace.path = '/outside/trace.json' },
    'dotdot path': v => { v.admittedOracle.oracle.trace.path = 'official/../trace.json' },
    'backslash path': v => { v.admittedOracle.oracle.trace.path = 'official\\trace.json' },
    'NUL path': v => { v.admittedOracle.oracle.trace.path = 'official/trace\0.json' },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const value = input(); change(value)
    assert.throws(() => bindMatrixOracle(value), /malformed or belongs to another source/)
  })
})

test('binding accepts equal explicit refs but never accepts an oracle without admission', () => {
  const value = input(); value.recipe.oracle = structuredClone(value.admittedOracle.oracle)
  assert.deepEqual(bindMatrixOracle(value).recipe.oracle, value.recipe.oracle)
  assert.throws(() => bindMatrixOracle({ ...value, admittedOracle: undefined }), /no admitted oracle identity/)
  const synthetic = { caseId: job.caseId, sourceSha256 }
  assert.equal(bindMatrixOracle({ job, recipe: synthetic }).recipe, synthetic)
})

test('executor rejects mismatched or missing admission before driver lookup, fixture preparation or child creation', async () => {
  for (const missing of [false, true]) {
    const value = input(); value.recipe.oracle = oracle()
    if (!missing) value.recipe.oracle.execution.path = 'unadmitted/execution.json'
    let driverReads = 0
    const driver = { get module() { driverReads++; throw new Error('driver was touched') } }
    await assert.rejects(executeMatrixDriver({ ...value, admittedOracle: missing ? undefined : value.admittedOracle,
      root: '/unavailable-before-oracle-binding', outputDirectory: '/unavailable-before-oracle-binding/output', driver }),
    missing ? /no admitted oracle identity/ : /differs from the admitted oracle identity/)
    assert.equal(driverReads, 0)
  }
})

async function fixture(t, source) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'oracle-binding-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(resolve(root, 'scripts'))
  await mkdir(resolve(root, 'official'))
  await mkdir(resolve(root, 'output'))
  await writeFile(resolve(root, 'scripts/conformance-matrix-driver.mjs'), await readFile(new URL('./conformance-matrix-driver.mjs', import.meta.url)))
  await writeFile(resolve(root, 'driver.mjs'), source)
  await writeFile(resolve(root, 'collector.mjs'), 'export const createCollector=()=>({attach(){}});\n')
  const fixtureValue = { manifest: { integrity: { root: 'f'.repeat(64) } } }
  await writeFile(resolve(root, 'fixture.json'), JSON.stringify(fixtureValue))
  await writeFile(resolve(root, 'official/trace.json'), '{"synthetic":"trace"}\n')
  await writeFile(resolve(root, 'official/execution.json'), '{"synthetic":"execution"}\n')
  const ref = path => conformanceArtifactReference(root, resolve(root, path))
  const admittedOracle = { caseId: job.caseId, sourceSha256,
    oracle: { trace: await ref('official/trace.json'), execution: await ref('official/execution.json') } }
  return { root, outputDirectory: resolve(root, 'output'), job: { ...job }, admittedOracle,
    driver: { module: await ref('driver.mjs'), inputs: [], timeoutMs: 1000 },
    recipe: { caseId: job.caseId, sourceSha256, fixture: await ref('fixture.json'), fixtureValue,
      resources: {}, collector: await ref('collector.mjs'), collectorInputs: [] } }
}

const dispose = 'export const dispose=async()=>({ownedResourcesReleased:true,borrowedResourcesPreserved:true});'

test('synthetic child receives canonical refs in host context while passive runtime recipe excludes oracle evidence', async t => {
  const setup = await fixture(t, `import {readFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
export async function run({recipe,admittedOracle}) {
const archived=JSON.parse(await readFile(recipe.runtimeRecipePath,'utf8'));
if(!isDeepStrictEqual(recipe.oracle,admittedOracle.oracle)) throw new Error('canonical refs missing');
if('oracle' in archived||'admittedOracle' in archived) throw new Error('host oracle entered passive runtime recipe');
return {testOnly:true,oracle:recipe.oracle,admittedOracle};
}
${dispose}`)
  const executed = await executeMatrixDriver(setup)
  assert.equal(executed.status, 'executed', executed.errors.join('\n'))
  assert.deepEqual(executed.candidate.oracle, setup.admittedOracle.oracle)
  assert.deepEqual(executed.candidate.admittedOracle, setup.admittedOracle)
  for (const ref of Object.values(setup.admittedOracle.oracle)) assert.ok(executed.inputs.some(value => JSON.stringify(value) === JSON.stringify(ref)))
  const request = JSON.parse(await readFile(resolve(setup.outputDirectory, 'request.json'), 'utf8'))
  assert.deepEqual(request.context.recipe.oracle, request.context.admittedOracle.oracle)
})

test('changed admitted bytes fail before driver snapshot/child and create no output', async t => {
  const setup = await fixture(t, `export const run=async()=>({unexpected:true});\n${dispose}`)
  await writeFile(resolve(setup.root, setup.admittedOracle.oracle.trace.path), 'changed after admission')
  let touched = false
  setup.driver = { get module() { touched = true; throw new Error('driver was touched') } }
  await assert.rejects(executeMatrixDriver(setup), /artifact hash\/size differs/)
  assert.equal(touched, false)
  assert.deepEqual(await readdir(setup.outputDirectory), [])
})

test('consumed admitted artifact mutation fails with canonical refs and cleanup evidence retained', async t => {
  for (const kind of ['trace', 'execution']) await t.test(kind, async t => {
    const setup = await fixture(t, `import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function run({root,admittedOracle}) {await writeFile(resolve(root,admittedOracle.oracle.${kind}.path),'changed consumed oracle');return {testOnly:true}}
${dispose}`)
    const executed = await executeMatrixDriver(setup)
    assert.equal(executed.process.exitCode, 0)
    assert.equal(executed.status, 'failed')
    assert.match(executed.errors.join('\n'), /artifact hash\/size differs/)
    assert.deepEqual(executed.cleanup, { ownedResourcesReleased: true, borrowedResourcesPreserved: true })
    assert.ok(executed.inputs.some(ref => ref.path === setup.admittedOracle.oracle[kind].path && ref.sha256 === setup.admittedOracle.oracle[kind].sha256))
    assert.ok(executed.result && executed.log)
  })
})

const wxmlSource = '697e7f72f545f1c8df358930c5ecca297d8888bb16f0cf01a4bc88084392d4a2'
const nativeHostRejection = { name: 'Error', message: process.arch !== 'arm64'
  ? 'macOS requires native aarch64 Metal'
  : process.platform !== 'darwin' ? 'Native macos driver requires a real darwin/arm64 execution host'
    : 'Native driver cannot substitute the requested host' }
const nativeContext = () => ({ root: '/unavailable-before-native-oracle-binding', outputDirectory: '/unavailable-before-native-oracle-binding/output',
  job: { caseId: 'ide-wxml-transform-runtime', sourceSha256: wxmlSource, host: 'web', engine: 'quickjs' },
  recipe: { caseId: 'ide-wxml-transform-runtime', sourceSha256: wxmlSource, oracle: oracle(),
    get collector() { throw new Error('native loader was touched') } } })

test('formal native trace profile rejects missing or substituted binding before host/file/build work', async t => {
  for (const kind of ['missing', 'trace', 'execution', 'case', 'source']) await t.test(kind, async () => {
    const context = nativeContext()
    if (kind !== 'missing') {
      context.admittedOracle = { caseId: context.job.caseId, sourceSha256: wxmlSource, oracle: oracle() }
      if (kind === 'trace' || kind === 'execution') context.admittedOracle.oracle[kind].path = `unadmitted/${kind}.json`
      if (kind === 'case') context.admittedOracle.caseId = 'ide-other'
      if (kind === 'source') context.admittedOracle.sourceSha256 = 'e'.repeat(64)
    }
    await assert.rejects(runNative(context), /differs from its admitted source\/trace\/execution identity/)
  })
})

test('direct native diagnostics keep their diagnostic-only path; supplied mismatches still fail early', async () => {
  const context = nativeContext()
  await assert.rejects(runDiagnostic(context), nativeHostRejection)
  context.admittedOracle = { caseId: context.job.caseId, sourceSha256: wxmlSource, oracle: oracle() }
  context.admittedOracle.oracle.execution.bytes++
  await assert.rejects(runDiagnostic(context), /differs from its admitted source\/trace\/execution identity/)
  await assert.rejects(access(resolve(context.outputDirectory, 'native-session.json')), { code: 'ENOENT' })
})

test('formal native profiles without a trace projection also require admitted source/oracle identity', async () => {
  const context = nativeContext()
  context.job.caseId = context.recipe.caseId = 'ide-issue-1058-template-tags-runtime'
  context.job.sourceSha256 = context.recipe.sourceSha256 = '00adf03eed85511cd47f33867ed6e1dc897ade9c043671ff6f05a361feb180ea'
  await assert.rejects(runNative(context), /differs from its admitted source\/trace\/execution identity/)
  context.admittedOracle = { caseId: context.job.caseId, sourceSha256: context.job.sourceSha256, oracle: oracle() }
  await assert.rejects(runNative(context), nativeHostRejection)
})
