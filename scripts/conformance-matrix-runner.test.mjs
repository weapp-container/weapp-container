import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFORMANCE_BASELINE as baseline } from './conformance-evidence.mjs'
import { conformanceArtifactReference } from './conformance-recipes.mjs'
import { executeMatrixDriver, parseMatrixArguments, planConformanceMatrix, readHostDrivers, readOracleSet, runConformanceMatrix } from './conformance-matrix-runner.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const first = { id: 'ide-first', sourceSha256: 'a'.repeat(64) }
const put = async (directory, path, contents) => { const file = resolve(directory, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, contents); return file }

test('every indexed case has exactly fourteen explicit jobs, including missing prerequisites', async () => {
  const index = JSON.parse(await readFile(resolve(root, 'docs/conformance/case-index-v1.json'), 'utf8'))
  const jobs = planConformanceMatrix({ index })
  assert.equal(jobs.length, 2408)
  assert.equal(new Set(jobs.map(job => `${job.caseId}/${job.host}/${job.engine}`)).size, 2408)
  assert.ok(jobs.every(job => job.status === 'blocked' && job.blockers.length === 3))
  const provided = planConformanceMatrix({ index: { cases: [first] }, recipes: new Map([[first.id, {}]]), oracles: new Map([[first.id, {}]]), drivers: new Map([['web/quickjs', {}]]) })
  assert.equal(provided.filter(job => job.status === 'planned').length, 1)
  assert.equal(provided.find(job => job.engine === 'v8').status, 'blocked')
  assert.throws(() => planConformanceMatrix({ index: { cases: [first, first] } }), /duplicated/)
})

test('unreviewed source blocks even otherwise runnable pairs before driver execution', () => {
  const jobs = planConformanceMatrix({ index: { cases: [first] }, recipes: new Map([[first.id, {}]]),
    oracles: new Map([[first.id, {}]]), drivers: new Map([['web/quickjs', {}]]),
    sourceValidation: { status: 'incomplete', errors: ['case index differs from committed golden hash'] } })
  assert.ok(jobs.every(job => job.status === 'blocked' && job.blockers.includes('source-validation-incomplete')))
  assert.deepEqual(jobs.find(job => job.host === 'web' && job.engine === 'quickjs').blockers, ['source-validation-incomplete'])
})

test('authoring descriptors cannot execute as matrix fixtures before the official run binds their actual pack', () => {
  const jobs = planConformanceMatrix({ index: { cases: [first] }, recipes: new Map([[first.id, { fixtureProfile: 'captured-static-v1' }]]),
    oracles: new Map([[first.id, {}]]), drivers: new Map([['web/quickjs', {}]]) })
  assert.ok(jobs.every(job => job.status === 'blocked' && job.blockers.includes('unbound-case-fixture')))
  assert.deepEqual(jobs.find(job => job.host === 'web' && job.engine === 'quickjs').blockers, ['unbound-case-fixture'])
})

test('matrix CLI forwards pnpm separator and rejects missing, repeated or unknown arguments', () => {
  assert.deepEqual(parseMatrixArguments(['--', '--recipes', 'recipes.json', '--drivers', 'drivers.json', '--oracles', 'official.json', '--out', 'artifacts/run', '--plan-only']),
    { planOnly: true, recipes: 'recipes.json', drivers: 'drivers.json', oracles: 'official.json', out: 'artifacts/run' })
  for (const args of [['--out'], ['--recipes', '--out'], ['--out', 'a', '--out', 'b'], ['--host', 'headless']]) assert.throws(() => parseMatrixArguments(args))
})

test('oracle registry rejects duplicate, changed and substituted cases before execution', () => {
  const entry = { caseId: first.id, sourceSha256: first.sourceSha256, trace: {}, execution: {} }
  const registry = { schemaVersion: 1, kind: 'wechat-devtools-oracle-set', baselineId: baseline.id, cases: [entry] }
  assert.equal(readOracleSet(registry, { cases: [first] }).size, 1)
  for (const cases of [[entry, entry], [{ ...entry, caseId: 'ide-other' }], [{ ...entry, sourceSha256: 'b'.repeat(64) }], [{ ...entry, passed: true }]]) {
    assert.throws(() => readOracleSet({ ...registry, cases }, { cases: [first] }))
  }
  assert.throws(() => readOracleSet({ ...registry, baselineId: 'latest' }, { cases: [first] }), /baseline/)
})

test('drivers require hashed explicit modules and exact distinct host-engine keys', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weapp-matrix-driver-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const module = await conformanceArtifactReference(directory, await put(directory, 'driver.mjs', 'export const run=()=>{};\n'))
  const registry = { schemaVersion: 1, kind: 'weapp-container-host-drivers', baselineId: baseline.id,
    drivers: [{ host: 'web', engine: 'quickjs', module, inputs: [] }] }
  const file = await put(directory, 'drivers.json', JSON.stringify(registry))
  assert.equal((await readHostDrivers({ root: directory, file })).size, 1)
  registry.drivers.push(registry.drivers[0])
  await writeFile(file, JSON.stringify(registry))
  await assert.rejects(readHostDrivers({ root: directory, file }), /Duplicate/)
  registry.drivers.pop()
  registry.drivers[0].host = 'headless'
  await writeFile(file, JSON.stringify(registry))
  await assert.rejects(readHostDrivers({ root: directory, file }), /schema/)
  registry.drivers[0].host = 'web'
  registry.drivers[0].timeoutMs = 1_800_001
  await writeFile(file, JSON.stringify(registry))
  await assert.rejects(readHostDrivers({ root: directory, file }), /30 minutes/)
  delete registry.drivers[0].timeoutMs
  await writeFile(file, JSON.stringify(registry))
  await writeFile(resolve(directory, 'driver.mjs'), 'changed')
  await assert.rejects(readHostDrivers({ root: directory, file }), /hash/)
})

test('child executes snapshot closure and always records scoped disposal on driver failure', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weapp-matrix-child-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const marker = resolve(directory, 'disposed')
  const driverModule = await put(directory, 'driver.mjs', `import {writeFile} from 'node:fs/promises';
export async function run(){throw new Error('actual driver unavailable')}
export async function dispose(){await writeFile(${JSON.stringify(marker)},'released');return {ownedResourcesReleased:true,borrowedResourcesPreserved:true}}\n`)
  const identity = await conformanceArtifactReference(directory, driverModule)
  const request = await put(directory, 'request.json', JSON.stringify({ driverModule, driverModules: [driverModule], driverInputs: [{ file: driverModule, sha256: identity.sha256, bytes: identity.bytes }], context: { job: first } }))
  const result = resolve(directory, 'result.json')
  const code = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'scripts/conformance-matrix-driver.mjs'), request, result], { stdio: 'pipe' })
    let stderr = ''
    child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', reject)
    child.once('close', code => { if (code === null) reject(new Error(stderr)); else accept(code) })
  })
  assert.equal(code, 1)
  await access(marker)
  const recorded = JSON.parse(await readFile(result, 'utf8'))
  assert.match(recorded.error, /actual driver unavailable/)
  assert.equal(recorded.cleanup.ownedResourcesReleased, true)
  assert.equal(recorded.candidate, undefined)
})

test('failed host attempts retain process, cleanup, log and immutable input references', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'weapp-matrix-attempt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await put(directory, 'scripts/conformance-matrix-driver.mjs', await readFile(resolve(root, 'scripts/conformance-matrix-driver.mjs')))
  const module = await conformanceArtifactReference(directory, await put(directory, 'failure.mjs',
    'export async function run(){throw new Error("host-not-connected")}\nexport async function dispose(){return {ownedResourcesReleased:false,borrowedResourcesPreserved:true}}\n'))
  const collector = await conformanceArtifactReference(directory, await put(directory, 'collector.mjs', 'export const createCollector=()=>({attach(){}})\n'))
  const fixtureValue = { id: 'test-structure-only', manifest: { integrity: { root: 'a'.repeat(64) } } }
  const fixture = await conformanceArtifactReference(directory, await put(directory, 'fixture.json', JSON.stringify(fixtureValue)))
  const outputDirectory = resolve(directory, 'attempt')
  await mkdir(outputDirectory)
  const result = await executeMatrixDriver({ root: directory, driver: { host: 'web', engine: 'quickjs', module, inputs: [], timeoutMs: 1000 },
    job: { caseId: first.id, host: 'web', engine: 'quickjs' }, recipe: { caseId: first.id, sourceSha256: first.sourceSha256, fixture, fixtureValue, resources: {}, collector, collectorInputs: [] }, outputDirectory })
  assert.equal(result.status, 'failed')
  assert.equal(result.process.exitCode, 1)
  assert.equal(result.cleanup.ownedResourcesReleased, false)
  assert.equal(result.cleanup.borrowedResourcesPreserved, true)
  assert.match(result.errors.join(';'), /host-not-connected/)
  assert.ok(result.result.path.endsWith('result.json'))
  assert.ok(result.log.path.endsWith('driver.log'))
  assert.ok(result.inputs.some(input => input.path.endsWith('driver-entry.mjs')))
  assert.equal(result.candidate, undefined)
})

test('real pinned-source plan archives all missing jobs and stays incomplete without launching hosts', async t => {
  await mkdir(resolve(root, 'artifacts'), { recursive: true })
  const directory = await mkdtemp(resolve(root, 'artifacts/matrix-plan-regression-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { report, audit, out } = await runConformanceMatrix({ out: resolve(directory, 'run'), planOnly: true }, { root })
  assert.equal(report.jobs.length, 2408)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.counts.blocked, 2408)
  assert.equal(report.counts.passed, 0)
  const bytes = await readFile(resolve(root, 'docs/conformance/case-index-v1.json'))
  const golden = execFileSync('git', ['show', 'HEAD:docs/conformance/case-index-v1.sha256'], { cwd: root, encoding: 'utf8' }).trim()
  const reviewed = golden === `${createHash('sha256').update(bytes).digest('hex')}  case-index-v1.json`
  assert.equal(audit.sourceValidation.status, reviewed ? 'passed' : 'incomplete')
  assert.deepEqual(report.sourceValidation, audit.sourceValidation)
  assert.ok(report.jobs.every(job => job.blockers.includes('source-validation-incomplete') === !reviewed))
  if (!reviewed) assert.deepEqual(audit.sourceValidation.errors, ['case index differs from committed golden hash'])
  assert.ok(report.jobs.every(job => !job.attempt))
  assert.ok(report.runnerInputs.length > 10)
  assert.deepEqual(report.inputErrors, [])
  assert.equal(report.differential, undefined)
  assert.equal(JSON.parse(await readFile(resolve(out, 'run.json'), 'utf8')).counts.blocked, 2408)
  await assert.rejects(access(resolve(out, 'differential.json')))
})
