import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { CONFORMANCE_BASELINE as baseline, schemaErrors } from './conformance-evidence.mjs'
import { conformanceArtifactReference, createRuntimeTraceCollector, finalizeOfficialConformance,
  prepareConformanceRecipe, readConformanceArtifact, readConformanceRecipes } from './conformance-recipes.mjs'
import { createSyntheticPinnedCompilerBuild } from './fixtures/conformance-compiler-build.mjs'
import { createSyntheticCompilerUse } from './fixtures/conformance-compiler-use.mjs'
import { createSyntheticFixtureBuild } from './fixtures/conformance-fixture-build.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)

test('exclusive fixture schema alternatives fail on zero, multiple or unsupported matches', () => {
  assert.deepEqual(schemaErrors('value', { oneOf: [{ type: 'string' }, { type: 'integer' }] }), [])
  assert.notDeepEqual(schemaErrors(false, { oneOf: [{ type: 'string' }, { type: 'integer' }] }), [])
  assert.notDeepEqual(schemaErrors('value', { oneOf: [{ type: 'string' }, true] }), [])
  assert.notDeepEqual(schemaErrors('value', { oneOf: [{ type: 'string' }, { unknownConstraint: true }] }), [])
  assert.notDeepEqual(schemaErrors('value', { oneOf: [] }), [])
})

// These synthetic fixtures validate the producer contract. They are never
// indexed official observations or evidence that an actual host was executed.
async function fixture(t, { undeclared = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'conformance-recipe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path, bytes) => {
    const file = join(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes)
    return await conformanceArtifactReference(root, file)
  }
  const json = (path, value) => put(path, JSON.stringify(value, null, 2) + '\n')
  const blobs = await Promise.all(['App({})', 'Page({})', JSON.stringify({ schemaVersion: 1, nodes: [] })].map((value, index) => put(`blobs/${index}`, value)))
  const manifest = { schemaVersion: 1, protocolVersion: '1.0', compiler: baseline.compiler,
    app: { appJson: 'app.json', entryModule: 'app.js' },
    routes: [{ id: 'route:pages/index/index', path: 'pages/index/index', kind: 'page', entryModule: 'pages/index/index.js' }],
    modules: ['app.js', 'pages/index/index.js'].map((name, index) => ({ id: `module:${name}`, sha256: blobs[index].sha256, format: 'commonjs', scope: index ? 'page' : 'app' })),
    templates: [{ id: 'template:pages/index/index.wxml', wxmlAst: `sha256:${blobs[2].sha256}`, bindings: [] }],
    styles: [], components: [], assets: [], capabilities: {}, integrity: { algorithm: 'sha256', root: '' } }
  manifest.integrity.root = hash(canonical(manifest))
  const dep = await put('collector/dependency.mjs', "export const tag='captured-snapshot';\n")
  const collector = await put('collector/main.mjs', `import {tag} from './dependency.mjs';
    export function createCollector({emit}) { return { attach(program) { emit({kind:'event',op:'test.observed',payload:{tag,value:program.value}}); } }; }
  `)
  const recipe = { caseId: 'ide-test', sourceSha256: hash('synthetic pinned source'), fixture: await json('fixture.json', { id: 'synthetic-recipe', manifest }),
    resources: Object.fromEntries(blobs.map(ref => [ref.sha256, ref])), collector, collectorInputs: undeclared ? [] : [dep] }
  const registry = { schemaVersion: 1, kind: 'weapp-container-case-recipes', baselineId: baseline.id, compilerCommit: baseline.compiler.commit, recipes: [recipe] }
  const file = join(root, 'registry.json')
  await json('registry.json', registry)
  const index = { cases: [{ id: recipe.caseId, sourceSha256: recipe.sourceSha256 }] }
  return { root, recipe, registry, file, index, put, json }
}

test('recipes bind exact indexed sources and full portable fixture blob closure', async t => {
  const f = await fixture(t)
  const recipes = await readConformanceRecipes(f)
  assert.equal(recipes.size, 1)
  assert.equal(recipes.get('ide-test').fixtureValue.manifest.compiler.commit, baseline.compiler.commit)
  await f.put('blobs/0', 'changed byte')
  await assert.rejects(readConformanceRecipes(f), /hash\/size differs/)
})

test('recipe registry rejects duplicate, substituted and omitted-blob cases', async t => {
  const f = await fixture(t)
  for (const change of [r => r.recipes.push(structuredClone(r.recipes[0])), r => r.recipes[0].sourceSha256 = '0'.repeat(64),
    r => delete r.recipes[0].resources[Object.keys(r.recipes[0].resources)[0]]]) {
    const registry = structuredClone(f.registry); change(registry); await f.json('registry.json', registry)
    await assert.rejects(readConformanceRecipes(f), /duplicate|changed case|blob closure/)
  }
})

test('captured static recipes bind source and collector without precomputing run-specific executable bytes', async t => {
  const f = await fixture(t)
  const { fixture: _, resources: __, ...captured } = f.recipe
  captured.fixtureProfile = 'captured-static-v1'
  await f.json('registry.json', { ...f.registry, recipes: [captured] })
  const recipe = (await readConformanceRecipes(f)).get('ide-test')
  assert.equal(recipe.fixtureValue, undefined)
  const prepared = await prepareConformanceRecipe({ ...f, recipe, directory: join(f.root, 'captured-run') })
  const runtime = JSON.parse(await readFile(prepared.runtimeRecipePath, 'utf8'))
  assert.equal(runtime.fixtureProfile, 'captured-static-v1')
  assert.equal(Object.hasOwn(runtime, 'manifestIntegrity'), false)
  for (const mutation of [
    value => { value.fixture = f.recipe.fixture },
    value => { value.resources = f.recipe.resources },
    value => { value.oracle = { trace: f.recipe.fixture, execution: f.recipe.fixture } },
    value => { value.fixtureProfile = 'unreviewed-watch-profile' },
  ]) {
    const changed = structuredClone(captured); mutation(changed)
    await f.json('registry.json', { ...f.registry, recipes: [changed] })
    await assert.rejects(readConformanceRecipes(f), /Recipe registry schema/)
  }
})

test('captured collectors require one actual checkpoint before observing and freeze its reference', async t => {
  for (const variant of ['bound', 'missing', 'duplicate', 'bad-path']) {
    const f = await fixture(t), { fixture: _, resources: __, ...captured } = f.recipe
    captured.fixtureProfile = 'captured-static-v1'
    await f.json('registry.json', { ...f.registry, recipes: [captured] })
    const recipe = (await readConformanceRecipes(f)).get('ide-test')
    const directory = join(f.root, 'run'), prepared = await prepareConformanceRecipe({ ...f, recipe, directory })
    const outputFile = join(directory, 'observed-events.json')
    const collector = await createRuntimeTraceCollector({ recipePath: prepared.runtimeRecipePath, outputFile })
    const checkpoint = await f.json('actual-checkpoint.json', { diagnosticTestOnly: true })
    if (variant !== 'missing') {
      if (variant === 'bad-path') assert.throws(() => collector.bindFixtureCheckpoint({ ...checkpoint, path: '../checkpoint.json' }), /malformed/)
      else {
        collector.bindFixtureCheckpoint(checkpoint)
        if (variant === 'duplicate') assert.throws(() => collector.bindFixtureCheckpoint(checkpoint), /duplicate/)
      }
    }
    if (['missing', 'bad-path'].includes(variant)) await assert.rejects(collector.attach({ value: 8 }), /preceded actual fixture/)
    else await collector.attach({ value: 8 })
    const original = structuredClone(checkpoint); checkpoint.sha256 = 'f'.repeat(64)
    if (variant === 'bound') {
      await collector.flush()
      const observed = JSON.parse(await readFile(outputFile, 'utf8'))
      assert.deepEqual(observed.fixtureCheckpoint, original)
      assert.equal(Object.hasOwn(observed, 'manifestIntegrity'), false)
      assert.throws(() => collector.bindFixtureCheckpoint(original), /followed observation or flush/)
    } else {
      await assert.rejects(collector.flush(), /no complete observations/)
      assert.equal(JSON.parse(await readFile(outputFile, 'utf8')).status, 'blocked')
    }
  }
})

test('collector executes its snapshot closure and freezes observations at emission', async t => {
  const f = await fixture(t)
  const recipe = (await readConformanceRecipes(f)).get('ide-test')
  const directory = join(f.root, 'run')
  const prepared = await prepareConformanceRecipe({ ...f, recipe, directory })
  await f.put('collector/dependency.mjs', "throw Error('mutated live helper must not execute')")
  const outputFile = join(directory, 'observed-events.json')
  const collector = await createRuntimeTraceCollector({ recipePath: prepared.runtimeRecipePath, outputFile })
  const program = { value: { count: 1 } }
  await collector.attach(program); program.value.count = 2
  await collector.flush(); await collector.flush()
  const captured = JSON.parse(await readFile(outputFile, 'utf8'))
  assert.equal(captured.status, 'passed')
  assert.deepEqual(captured.events, [{ seq: 0, kind: 'event', op: 'test.observed', payload: { tag: 'captured-snapshot', value: { count: 1 } } }])
  assert.ok(Buffer.isBuffer(await readConformanceArtifact(f.root, prepared.collector)))
})

test('collector refuses imports outside its explicitly hashed closure', async t => {
  const f = await fixture(t, { undeclared: true })
  const recipe = (await readConformanceRecipes(f)).get('ide-test')
  const prepared = await prepareConformanceRecipe({ ...f, recipe, directory: join(f.root, 'run') })
  await assert.rejects(createRuntimeTraceCollector({ recipePath: prepared.runtimeRecipePath, outputFile: join(f.root, 'events.json') }), /outside its snapshot closure/)
})

test('collector closure uses canonical file identities through a directory alias', async t => {
  const f = await fixture(t)
  const recipe = (await readConformanceRecipes(f)).get('ide-test')
  const directory = join(f.root, 'run')
  const prepared = await prepareConformanceRecipe({ ...f, recipe, directory })
  const alias = join(f.root, 'run-alias')
  await symlink(await realpath(directory), alias, process.platform === 'win32' ? 'junction' : 'dir')
  const runtimeRecipe = JSON.parse(await readFile(prepared.runtimeRecipePath, 'utf8'))
  runtimeRecipe.collectorPath = join(alias, 'recipe-inputs', recipe.collector.path)
  runtimeRecipe.collectorInputPaths = recipe.collectorInputs.map(reference => join(alias, 'recipe-inputs', reference.path))
  const aliasedRecipe = join(f.root, 'aliased-runtime-recipe.json')
  await writeFile(aliasedRecipe, JSON.stringify(runtimeRecipe))
  const collector = await createRuntimeTraceCollector({ recipePath: aliasedRecipe, outputFile: join(directory, 'aliased-events.json') })
  await collector.attach({ value: 'canonical dependency' })
  await collector.flush()
  const observed = JSON.parse(await readFile(join(directory, 'aliased-events.json'), 'utf8'))
  assert.equal(observed.events[0].payload.value, 'canonical dependency')

  const undeclared = await fixture(t, { undeclared: true })
  const undeclaredRecipe = (await readConformanceRecipes(undeclared)).get('ide-test')
  const incomplete = await prepareConformanceRecipe({ ...undeclared, recipe: undeclaredRecipe, directory: join(undeclared.root, 'run') })
  const incompleteAlias = join(undeclared.root, 'run-alias')
  await symlink(await realpath(join(undeclared.root, 'run')), incompleteAlias, process.platform === 'win32' ? 'junction' : 'dir')
  const runtimeIncomplete = JSON.parse(await readFile(incomplete.runtimeRecipePath, 'utf8'))
  runtimeIncomplete.collectorPath = join(incompleteAlias, 'recipe-inputs', undeclaredRecipe.collector.path)
  const incompleteFile = join(undeclared.root, 'aliased-runtime-recipe.json')
  await writeFile(incompleteFile, JSON.stringify(runtimeIncomplete))
  await assert.rejects(createRuntimeTraceCollector({ recipePath: incompleteFile, outputFile: join(undeclared.root, 'events.json') }), /outside its snapshot closure/)
})

test('collector keeps the closure enforced for imports during runtime attachment', async t => {
  const f = await fixture(t)
  await f.put('collector/main.mjs', `export function createCollector({emit}) {return {async attach(){
    const {tag}=await import('./dependency.mjs'); emit({kind:'event',op:'test.observed',payload:{tag}})
  }}}`)
  f.registry.recipes[0].collector = await conformanceArtifactReference(f.root, join(f.root, 'collector/main.mjs'))
  f.registry.recipes[0].collectorInputs = []
  await f.json('registry.json', f.registry)
  const recipe = (await readConformanceRecipes(f)).get('ide-test')
  const directory = join(f.root, 'run')
  const prepared = await prepareConformanceRecipe({ ...f, recipe, directory })
  const collector = await createRuntimeTraceCollector({ recipePath: prepared.runtimeRecipePath, outputFile: join(directory, 'events.json') })
  await assert.rejects(collector.attach({}), /outside its snapshot closure/)
  await assert.rejects(collector.flush(), /no complete observations/)
  assert.equal(JSON.parse(await readFile(join(directory, 'events.json'), 'utf8')).status, 'blocked')
})

test('collector refuses silent JSON loss and cannot finalize an empty observation', async t => {
  const f = await fixture(t)
  await f.put('collector/main.mjs', `export function createCollector({emit}) {return {attach(){emit({kind:'event',op:'test.invalid',payload:NaN})}}}`)
  f.registry.recipes[0].collector = await conformanceArtifactReference(f.root, join(f.root, 'collector/main.mjs'))
  await f.json('registry.json', f.registry)
  const recipe = (await readConformanceRecipes(f)).get('ide-test')
  const directory = join(f.root, 'run')
  const prepared = await prepareConformanceRecipe({ ...f, recipe, directory })
  const collector = await createRuntimeTraceCollector({ recipePath: prepared.runtimeRecipePath, outputFile: join(directory, 'events.json') })
  await assert.rejects(collector.attach({}), /JSON-finite/)
  await assert.rejects(collector.flush(), /no complete observations/)
  assert.equal(JSON.parse(await readFile(join(directory, 'events.json'), 'utf8')).status, 'blocked')
})

test('formal receipt binds actual captured events, Vitest assertions and released resources', async t => {
  const f = await fixture(t)
  const indexed = JSON.parse(await readFile(new URL('../docs/conformance/case-index-v1.json', import.meta.url), 'utf8')).cases[0]
  f.registry.recipes[0].sourceSha256 = indexed.sourceSha256
  f.index.cases[0].sourceSha256 = indexed.sourceSha256
  await f.json('registry.json', f.registry)
  const recipe = (await readConformanceRecipes(f)).get('ide-test')
  const directory = join(f.root, 'run')
  const prepared = await prepareConformanceRecipe({ ...f, recipe, directory })
  const collector = await createRuntimeTraceCollector({ recipePath: prepared.runtimeRecipePath, outputFile: join(directory, 'observed-events.json') })
  await collector.attach({ value: 7 }); await collector.flush()
  await f.put('run/official.log', 'synthetic executed command output')
  await f.json('run/vitest.json', { success: true, testResults: [{ name: `/isolated/${indexed.source}`, status: 'passed',
    assertionResults: [{ fullName: 'synthetic contract assertion', status: 'passed' }] }] })
  const selectionPath = join(f.root, 'selection.json'); await f.json('selection.json', {
    selectedVersion: baseline.devtoolsVersion, acceptedVersion: baseline.devtoolsVersion, packageVersion: baseline.devtoolsVersion,
    baseLibraryVersion: baseline.baseLibraryVersion, compilerCommit: baseline.compiler.commit, installationId: '1'.repeat(64),
    officialVersionMatches: true, queriedAt: '2026-11-07T00:59:00Z', source: 'https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html' })
  const attempt = { schemaVersion: 1, kind: 'wechat-devtools-case-attempt', caseId: recipe.caseId, status: 'passed', provider: 'wechat-devtools',
    baselineId: baseline.id, compilerCommit: baseline.compiler.commit,
    source: { path: indexed.source, sha256: recipe.sourceSha256, before: recipe.sourceSha256, after: recipe.sourceSha256 },
    run: { startedAt: '2026-11-07T01:00:00Z', endedAt: '2026-11-07T01:00:01Z', exitCode: 0, pid: 10101 },
    runtimeObservations: [{ recordedAt: '2026-11-07T01:00:00.500Z', projectPath: join(f.root, 'SYNTHETIC-OFFLINE-CONSUMER-NOT-EXECUTED/.tmp/upstream-project'), installationId: '1'.repeat(64),
      tool: { version: baseline.devtoolsVersion, SDKVersion: baseline.baseLibraryVersion }, system: { SDKVersion: baseline.baseLibraryVersion, platform: 'devtools' } }],
    resources: { owner: 'synthetic unit test', machineLeaseAcquired: true, machineLeaseReleased: true, hostLeaseAcquired: true, hostLeaseReleased: true,
      ownedResourcesReleased: true, borrowedResourcesPreserved: true }, failures: [] }
  const incomplete = structuredClone(attempt); incomplete.resources.hostLeaseReleased = false
  await assert.rejects(finalizeOfficialConformance({ ...f, directory, attempt: incomplete, selectionPath, recipe: prepared }), /valid passed diagnostic/)
  const wrongInstallation = structuredClone(attempt); wrongInstallation.runtimeObservations[0].installationId = '2'.repeat(64)
  await assert.rejects(finalizeOfficialConformance({ ...f, directory, attempt: wrongInstallation, selectionPath, recipe: prepared }), /another installation/)
  await assert.rejects(finalizeOfficialConformance({ ...f, directory, attempt, selectionPath, recipe: prepared }), /compiler build evidence is required/)
  const { compilerBuild } = createSyntheticPinnedCompilerBuild({ root: f.root,
    source: fileURLToPath(new URL('../vendor/weapp-vite', import.meta.url)), commit: baseline.compiler.commit,
    directory: join(f.root, 'artifacts/synthetic-compiler-build') })
  await assert.rejects(finalizeOfficialConformance({ ...f, directory, attempt, selectionPath, recipe: prepared, compilerBuild }), /Actual compiler consumption is required/)
  const initialUse = createSyntheticCompilerUse({ root: f.root, directory: join(f.root, 'artifacts/synthetic-compiler-use'),
    compilerBuild, caseId: recipe.caseId, sourceSha256: recipe.sourceSha256, caseSourcePath: indexed.source,
    startedAt: attempt.run.startedAt, endedAt: attempt.run.endedAt, pid: attempt.run.pid })
  await assert.rejects(finalizeOfficialConformance({ ...f, directory, attempt, selectionPath, recipe: prepared, compilerBuild,
    compilerUse: initialUse.reference }), /Actual case fixture build is required/)
  const { compilerUse, fixtureBuild } = createSyntheticFixtureBuild({ root: f.root, directory: join(f.root, 'artifacts/synthetic-fixture-build'),
    compilerBuild, compilerUse: initialUse.reference, fixture: recipe.fixtureValue, resources: recipe.resources,
    runtimeObservation: attempt.runtimeObservations[0] })
  const formal = await finalizeOfficialConformance({ ...f, directory, attempt, selectionPath, recipe: prepared, compilerBuild, compilerUse, fixtureBuild })
  const trace = await readConformanceArtifact(f.root, formal.oracle.trace, { json: true })
  const execution = await readConformanceArtifact(f.root, formal.oracle.execution, { json: true })
  assert.equal(trace.events[0].payload.value, 7)
  assert.deepEqual(trace.assertions, [{ id: 'synthetic contract assertion', passed: true }])
  assert.equal(execution.traceSha256, formal.oracle.trace.sha256)
  assert.equal(execution.runtimeObservation.sha256.length, 64)
  assert.deepEqual(execution.compilerBuild, compilerBuild)
  assert.deepEqual(execution.compilerUse, compilerUse)
  assert.deepEqual(execution.fixtureBuild, fixtureBuild)

  // Captured authoring is separate from the exact pack produced by this run.
  // The bound registry must preserve every emitted byte for later hosts.
  const { fixture: _, resources: __, fixtureValue: ___, ...capturedRecipe } = recipe
  capturedRecipe.fixtureProfile = 'captured-static-v1'
  const capturedDirectory = join(f.root, 'captured-run')
  const capturedPrepared = await prepareConformanceRecipe({ ...f, recipe: capturedRecipe, directory: capturedDirectory })
  const capturedCollector = await createRuntimeTraceCollector({ recipePath: capturedPrepared.runtimeRecipePath,
    outputFile: join(capturedDirectory, 'observed-events.json') })
  const attestation = await readConformanceArtifact(f.root, fixtureBuild, { json: true })
  capturedCollector.bindFixtureCheckpoint(attestation.checkpoint)
  await capturedCollector.attach({ value: 91 }); await capturedCollector.flush()
  await f.put('captured-run/official.log', 'synthetic captured command output')
  await f.put('captured-run/vitest.json', await readFile(join(directory, 'vitest.json')))
  const capturedObservations = JSON.parse(await readFile(join(capturedDirectory, 'observed-events.json'), 'utf8'))
  for (const mutate of [
    value => { value.fixtureCheckpoint.sha256 = 'f'.repeat(64) },
    value => { value.fixtureCheckpoint.path += '-another-run' },
    value => { delete value.fixtureCheckpoint },
    value => { value.manifestIntegrity = recipe.fixtureValue.manifest.integrity.root },
    value => { value.fixtureProfile = 'unreviewed-watch-profile' },
  ]) {
    const changed = structuredClone(capturedObservations); mutate(changed)
    await f.json('captured-run/observed-events.json', changed)
    await assert.rejects(finalizeOfficialConformance({ ...f, directory: capturedDirectory, attempt, selectionPath,
      recipe: capturedPrepared, compilerBuild, compilerUse, fixtureBuild }), /checkpoint|profile\/identity/)
  }
  await f.json('captured-run/observed-events.json', capturedObservations)
  const capturedFormal = await finalizeOfficialConformance({ ...f, directory: capturedDirectory, attempt, selectionPath,
    recipe: capturedPrepared, compilerBuild, compilerUse, fixtureBuild })
  assert.deepEqual(capturedFormal.fixture, recipe.fixtureValue)
  assert.deepEqual(capturedFormal.resources, recipe.resources)
  assert.deepEqual(capturedFormal.executionRecipe.fixture, attestation.fixture)
  assert.equal(Object.hasOwn(capturedFormal.executionRecipe, 'fixtureProfile'), false)
  const capturedTrace = await readConformanceArtifact(f.root, capturedFormal.oracle.trace, { json: true })
  assert.equal(capturedTrace.events[0].payload.value, 91)
  assert.equal(capturedTrace.run.environment.manifestIntegrity, recipe.fixtureValue.manifest.integrity.root)
  const registryFile = join(f.root, 'execution-recipes.json')
  await f.json('execution-recipes.json', { ...f.registry, recipes: [capturedFormal.executionRecipe] })
  const bound = (await readConformanceRecipes({ ...f, file: registryFile })).get(recipe.caseId)
  assert.deepEqual(bound.fixtureValue, recipe.fixtureValue)
  assert.deepEqual(bound.resources, recipe.resources)

  const secondAttempt = structuredClone(attempt)
  secondAttempt.run = { ...attempt.run, pid: 20202, startedAt: '2026-11-07T01:00:02Z', endedAt: '2026-11-07T01:00:03Z' }
  secondAttempt.runtimeObservations[0].recordedAt = '2026-11-07T01:00:02.500Z'
  secondAttempt.runtimeObservations[0].projectPath += '-second-random-directory'
  const secondFixture = structuredClone(recipe.fixtureValue)
  const changedModule = await f.put('second-run/page.js', '// /temporary/second-random-directory/src/page.vue\nPage({});')
  const previousHash = secondFixture.manifest.modules[1].sha256
  secondFixture.manifest.modules[1].sha256 = changedModule.sha256
  secondFixture.manifest.integrity.root = ''
  secondFixture.manifest.integrity.root = hash(canonical(secondFixture.manifest))
  const secondResources = { ...recipe.resources, [changedModule.sha256]: changedModule }
  delete secondResources[previousHash]
  const secondUse = createSyntheticCompilerUse({ root: f.root, directory: join(f.root, 'artifacts/second-synthetic-compiler-use'),
    compilerBuild, caseId: recipe.caseId, sourceSha256: recipe.sourceSha256, caseSourcePath: indexed.source,
    startedAt: secondAttempt.run.startedAt, endedAt: secondAttempt.run.endedAt, pid: secondAttempt.run.pid })
  const secondBuild = createSyntheticFixtureBuild({ root: f.root, directory: join(f.root, 'artifacts/second-synthetic-fixture-build'),
    compilerBuild, compilerUse: secondUse.reference, fixture: secondFixture, resources: secondResources,
    runtimeObservation: secondAttempt.runtimeObservations[0] })
  const secondDirectory = join(f.root, 'second-captured-run')
  const secondPrepared = await prepareConformanceRecipe({ ...f, recipe: capturedRecipe, directory: secondDirectory })
  const secondCollector = await createRuntimeTraceCollector({ recipePath: secondPrepared.runtimeRecipePath,
    outputFile: join(secondDirectory, 'observed-events.json') })
  secondCollector.bindFixtureCheckpoint(secondBuild.attestation.checkpoint)
  await secondCollector.attach({ value: 92 }); await secondCollector.flush()
  await f.put('second-captured-run/official.log', 'synthetic second command output')
  await f.put('second-captured-run/vitest.json', await readFile(join(directory, 'vitest.json')))
  const secondObservations = JSON.parse(await readFile(join(secondDirectory, 'observed-events.json'), 'utf8'))
  for (const [name, own, foreign, args] of [
    ['captured-run', capturedObservations, secondObservations, { attempt, recipe: capturedPrepared, compilerUse, fixtureBuild }],
    ['second-captured-run', secondObservations, capturedObservations, { attempt: secondAttempt, recipe: secondPrepared,
      compilerUse: secondBuild.compilerUse, fixtureBuild: secondBuild.fixtureBuild }],
  ]) {
    await f.json(`${name}/observed-events.json`, { ...own, fixtureCheckpoint: foreign.fixtureCheckpoint })
    await assert.rejects(finalizeOfficialConformance({ ...f, directory: join(f.root, name), selectionPath, compilerBuild, ...args }),
      /different actual fixture checkpoint/)
    await f.json(`${name}/observed-events.json`, own)
  }
  const secondFormal = await finalizeOfficialConformance({ ...f, directory: secondDirectory, attempt: secondAttempt, selectionPath,
    recipe: secondPrepared, compilerBuild, compilerUse: secondBuild.compilerUse, fixtureBuild: secondBuild.fixtureBuild })
  assert.deepEqual(secondFormal.fixture, secondFixture)
  assert.deepEqual(secondFormal.resources, secondResources)
  assert.notEqual(secondFormal.executionRecipe.fixture.sha256, capturedFormal.executionRecipe.fixture.sha256)
  const secondTrace = await readConformanceArtifact(f.root, secondFormal.oracle.trace, { json: true })
  assert.equal(secondTrace.events[0].payload.value, 92)
  assert.equal(secondTrace.run.environment.manifestIntegrity, secondFixture.manifest.integrity.root)
  assert.notEqual(secondTrace.run.environment.manifestIntegrity, capturedTrace.run.environment.manifestIntegrity)
})

test('passive checkpoint errors preserve the original check and fail evidence on flush', async t => {
  const f = await fixture(t)
  const module = await f.put('collector/checkpoint.mjs', `export const createCollector=({emit})=>({
    attach(){},checkpoint(observation){emit({kind:'render',op:'dom.checkpoint',payload:{text:observation.evidence.text}});observation.evidence.text='mutated';throw new Error('observation failed');}
  });`)
  f.registry.recipes[0].collector = module
  f.registry.recipes[0].collectorInputs = []
  await f.json('registry.json', f.registry)
  const recipe = (await readConformanceRecipes(f)).get('ide-test')
  const directory = join(f.root, 'run')
  const prepared = await prepareConformanceRecipe({ ...f, recipe, directory })
  const output = join(directory, 'events.json')
  const collector = await createRuntimeTraceCollector({ recipePath: prepared.runtimeRecipePath, outputFile: output })
  const actual = { evidence: { text: 'observed DOM' } }
  await collector.checkpoint(actual, {})
  assert.equal(actual.evidence.text, 'observed DOM')
  await assert.rejects(collector.flush(), /no complete observations/)
  const recorded = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(recorded.status, 'blocked')
  assert.equal(recorded.events[0].payload.text, 'observed DOM')
  assert.deepEqual(recorded.failures, ['observation failed'])
})
