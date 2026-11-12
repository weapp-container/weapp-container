/** Explicit recipes connect an indexed upstream case to its real portable
 * fixture and authored observation collector. No inferred fixture, assertion
 * status, provider, or host substitutes for missing execution evidence. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { assertSourcePollEvidence } from './conformance-source-poll-evidence.mjs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'
import { CONFORMANCE_BASELINE as baseline, schemaErrors } from './conformance-evidence.mjs'
import { inspectExecutionFixture } from './pack-execution-evidence.mjs'
import { inspectConformanceFixtureBuildEvidence } from './conformance-fixture-build.mjs'
import { assertOfficialSelection, inspectConformanceAttempt } from './conformance-devtools-attempt.mjs'

const recipeSchema = JSON.parse(await readFile(new URL('../schemas/conformance-case-recipes-v1.schema.json', import.meta.url), 'utf8'))
const traceSchema = JSON.parse(await readFile(new URL('../schemas/conformance-trace-v1.schema.json', import.meta.url), 'utf8'))
const oracleSchema = JSON.parse(await readFile(new URL('../schemas/conformance-oracle-execution-v1.schema.json', import.meta.url), 'utf8'))
const runtimeSchema = JSON.parse(await readFile(new URL('../schemas/conformance-runtime-observation-v1.schema.json', import.meta.url), 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const CAPTURED_STATIC_FIXTURE = 'captured-static-v1'
const require = (condition, message) => { if (!condition) throw Object.assign(new Error(message), { code: 'CONFORMANCE_RECIPE_INVALID', stage: 'runner' }) }
const json = async (file, value) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }) }
const baselineFields = Object.fromEntries(['id', 'devtoolsVersion', 'baseLibraryVersion', 'protocolVersion', 'manifestVersion'].map(key => [key, baseline[key]]))

function assertJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { require(Number.isFinite(value), 'Observed number is not JSON-finite'); return }
  require(value && typeof value === 'object' && !ancestors.has(value)
    && (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value))), 'Observed value is not plain acyclic JSON')
  ancestors.add(value)
  require(Object.getOwnPropertySymbols(value).length === 0, 'Observed value has symbol keys')
  if (Array.isArray(value)) {
    require(Object.keys(value).length === value.length, 'Observed array has non-index keys or holes')
    for (let at = 0; at < value.length; at++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, at)
      require(descriptor && Object.hasOwn(descriptor, 'value'), 'Observed array has a hole or accessor')
      assertJson(descriptor.value, ancestors)
    }
  }
  else for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    require(Object.hasOwn(descriptor, 'value'), 'Observed value contains an accessor')
    assertJson(descriptor.value, ancestors)
  }
  ancestors.delete(value)
}

async function safeArtifact(root, path) {
  require(typeof path === 'string' && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe recipe artifact path: ${path}`)
  let file = root
  const parts = path.split('/')
  for (const [index, part] of parts.entries()) {
    file = resolve(file, part)
    const info = await lstat(file)
    require(!info.isSymbolicLink() && (index === parts.length - 1 ? info.isFile() : info.isDirectory()), `Recipe artifact is not a regular file: ${path}`)
  }
  return file
}

export async function conformanceArtifactReference(root, file) {
  const path = relative(root, resolve(file)).replaceAll('\\', '/')
  const bytes = await readFile(await safeArtifact(root, path))
  require(bytes.length <= 1024 ** 3, `Recipe artifact exceeds 1 GiB: ${path}`)
  return { path, sha256: hash(bytes), bytes: bytes.length }
}

export async function readConformanceArtifact(root, reference, { json: parse = false } = {}) {
  require(reference && Object.keys(reference).sort().join(',') === 'bytes,path,sha256', 'Malformed recipe artifact reference')
  const file = await safeArtifact(root, reference.path)
  const bytes = await readFile(file)
  require(bytes.length <= 1024 ** 3 && bytes.length === reference.bytes && hash(bytes) === reference.sha256, `Recipe artifact hash/size differs: ${reference.path}`)
  require(!parse || bytes.length <= 64 * 1024 ** 2, 'Recipe JSON exceeds 64 MiB')
  return parse ? JSON.parse(bytes.toString('utf8')) : bytes
}

function requiredBlobs(manifest) {
  const hashes = new Set()
  const walk = (value, key = '') => {
    if (Array.isArray(value)) value.forEach(child => walk(child))
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => walk(child, key))
    else if (typeof value === 'string') {
      if (['sha256', 'sourceSha256', 'executableSha256'].includes(key) && /^[0-9a-f]{64}$/.test(value)) hashes.add(value)
      if (['wxmlAst', 'wxssIr'].includes(key) && /^sha256:[0-9a-f]{64}$/.test(value)) hashes.add(value.slice(7))
    }
  }
  walk(manifest)
  return [...hashes].sort()
}

export async function readConformanceRecipes({ root, index, file }) {
  const document = JSON.parse(await readFile(file, 'utf8'))
  require(schemaErrors(document, recipeSchema).length === 0, `Recipe registry schema: ${schemaErrors(document, recipeSchema).join('; ')}`)
  require(document.baselineId === baseline.id && document.compilerCommit === baseline.compiler.commit, 'Recipe registry baseline/compiler differs')
  const indexed = new Map(index.cases.map(item => [item.id, item]))
  const recipes = new Map()
  for (const recipe of document.recipes) {
    require(indexed.get(recipe.caseId)?.sourceSha256 === recipe.sourceSha256 && !recipes.has(recipe.caseId), `Unknown, duplicate, or changed case recipe: ${recipe.caseId}`)
    let fixtureValue
    if (recipe.fixtureProfile !== CAPTURED_STATIC_FIXTURE) {
      fixtureValue = await readConformanceArtifact(root, recipe.fixture, { json: true })
      require(inspectExecutionFixture(fixtureValue, baseline.compiler.commit).status === 'passed', `Recipe fixture is not a pinned portable pack: ${recipe.caseId}`)
      require(JSON.stringify(Object.keys(recipe.resources).sort()) === JSON.stringify(requiredBlobs(fixtureValue.manifest)), `Recipe blob closure differs: ${recipe.caseId}`)
      for (const [sha256, ref] of Object.entries(recipe.resources)) {
        require(ref.sha256 === sha256, 'Recipe resource key differs from its hash')
        await readConformanceArtifact(root, ref)
      }
      for (const asset of fixtureValue.manifest.assets) require(recipe.resources[asset.sha256]?.bytes === asset.size, 'Recipe asset byte length differs')
    }
    const modules = [recipe.collector, ...recipe.collectorInputs]
    require(recipe.collector.path.endsWith('.mjs') && new Set(modules.map(ref => ref.path)).size === modules.length,
      'Collector entry must be .mjs and its executable/data inputs must be unique explicit artifacts')
    for (const ref of modules) await readConformanceArtifact(root, ref)
    recipes.set(recipe.caseId, { ...recipe, ...(fixtureValue ? { fixtureValue } : {}) })
  }
  return recipes
}

export async function prepareConformanceRecipe({ root, recipe, directory, snapshotDirectory = 'recipe-inputs' }) {
  require(['recipe-inputs', 'runner-inputs'].includes(snapshotDirectory), 'Unsupported recipe snapshot directory')
  const copied = new Map()
  const copy = async reference => {
    if (copied.has(reference.path)) return copied.get(reference.path)
    const bytes = await readConformanceArtifact(root, reference)
    const file = resolve(directory, snapshotDirectory, reference.path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes, { flag: 'wx' })
    const ref = await conformanceArtifactReference(root, file)
    copied.set(reference.path, ref)
    return ref
  }
  const captured = recipe.fixtureProfile === CAPTURED_STATIC_FIXTURE
  const fixture = captured ? undefined : await copy(recipe.fixture)
  const resources = captured ? undefined : Object.fromEntries(await Promise.all(Object.entries(recipe.resources).map(async ([sha, ref]) => [sha, await copy(ref)])))
  const collector = await copy(recipe.collector)
  const collectorInputs = await Promise.all(recipe.collectorInputs.map(copy))
  const runtimeRecipePath = resolve(directory, 'runtime-recipe.json')
  const value = { caseId: recipe.caseId, sourceSha256: recipe.sourceSha256,
    ...(captured ? { fixtureProfile: CAPTURED_STATIC_FIXTURE } : { manifestIntegrity: recipe.fixtureValue.manifest.integrity.root }),
    collectorPath: resolve(root, collector.path), collectorInputPaths: collectorInputs.map(ref => resolve(root, ref.path)) }
  await json(runtimeRecipePath, value)
  return { ...recipe, ...(captured ? {} : { fixture, resources }), collector, collectorInputs, runtimeRecipePath,
    collectorSnapshotPaths: [value.collectorPath, ...value.collectorInputPaths] }
}

/** Loaded only inside the case worker. Import resolution is restricted to
 * the explicit snapshotted collector closure and Node builtins. This is
 * provenance isolation for reviewed code, not a JavaScript security sandbox. */
export async function createRuntimeTraceCollector({ recipePath, outputFile }) {
  if (!recipePath) return { observeExpectPoll: () => {}, bindFixtureCheckpoint: () => {}, routePageMethod: (_context, invoke) => invoke(), exceptionAuxiliary: (_context, invoke) => invoke(), readinessStart: () => undefined, readinessEnd: () => {}, attach: async () => {}, checkpoint: async () => {}, flush: async () => {} }
  const recipe = JSON.parse(await readFile(recipePath, 'utf8'))
  const captured = recipe.fixtureProfile === CAPTURED_STATIC_FIXTURE
  require(recipe.fixtureProfile === undefined || captured, 'Unsupported runtime fixture profile')
  require(!captured || !Object.hasOwn(recipe, 'manifestIntegrity'), 'Captured fixture cannot declare a precomputed manifest identity')
  const collectorPath = await realpath(recipe.collectorPath)
  const canonicalPaths = await Promise.all([collectorPath, ...recipe.collectorInputPaths].map(path => realpath(path)))
  const allowed = new Set(canonicalPaths.map(path => pathToFileURL(path).href))
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (!allowed.has(context.parentURL) || specifier.startsWith('node:')) return next(specifier, context)
    const target = new URL(specifier, context.parentURL).href
    require(allowed.has(target), `Collector import is outside its snapshot closure: ${specifier}`)
    return next(specifier, context)
  } })
  const events = []
  const failures = []
  let flushed = false
  let fixtureCheckpoint
  const emit = event => {
    try {
      require(!captured || fixtureCheckpoint, 'Observed event preceded actual fixture checkpoint binding')
      assertJson(event)
      const candidate = { ...event, seq: events.length }
      const probe = { schemaVersion: 1, caseId: recipe.caseId, oracle: 'wechat-devtools',
        run: { status: 'passed', host: 'devtools', engine: 'wechat', protocolVersion: baseline.protocolVersion, manifestVersion: baseline.manifestVersion }, events: [candidate] }
      require(schemaErrors(probe, traceSchema).length === 0, 'Collector emitted an invalid normalized event')
      // Freeze the captured value now: later guest or collector mutations must
      // not rewrite previously observed events.
      events.push(JSON.parse(JSON.stringify(candidate)))
    } catch (error) { failures.push(error.message); throw error }
  }
  let collector
  try {
    const module = await import(pathToFileURL(collectorPath).href)
    require(typeof module.createCollector === 'function', 'Collector must export createCollector')
    collector = await module.createCollector({ emit, context: { caseId: recipe.caseId, sourceSha256: recipe.sourceSha256, manifestIntegrity: recipe.manifestIntegrity } })
    require(typeof collector?.attach === 'function', 'Collector must return attach(miniProgram, context)')
  } catch (error) { hooks.deregister(); throw error }
  return {
    exceptionAuxiliary: (context, invoke) => {
      if (flushed) { failures.push('Exception auxiliary operation followed collector flush'); return invoke() }
      return collector.exceptionAuxiliary ? collector.exceptionAuxiliary(context, invoke) : invoke()
    },
    observeExpectPoll: (expect, flag) => { require(!flushed, 'Collector was already flushed'); collector.observeExpectPoll?.(expect, flag) },
    routePageMethod: async (context, invoke) => {
      require(!flushed, 'Collector was already flushed')
      // Actual helper rejections remain owned by its unchanged retry loop.
      // The collector retains observation failures and reports them on flush.
      return await (collector.routePageMethod ? collector.routePageMethod(context, invoke) : invoke())
    },
    readinessStart: context => {
      try { require(!flushed, 'Collector was already flushed'); return collector.readinessStart?.(context) }
      catch (error) { failures.push(error.message); return undefined }
    },
    readinessEnd: token => {
      try { require(!flushed, 'Collector was already flushed'); collector.readinessEnd?.(token) }
      catch (error) { failures.push(error.message) }
    },
    bindFixtureCheckpoint: reference => {
      try {
        if (!captured) return
        require(!flushed && !events.length, 'Fixture checkpoint binding followed observation or flush')
        require(!fixtureCheckpoint && reference && Object.keys(reference).sort().join(',') === 'bytes,path,sha256'
          && typeof reference.path === 'string' && reference.path && !isAbsolute(reference.path)
          && !reference.path.includes('\\') && reference.path.split('/').every(part => part && part !== '.' && part !== '..')
          && /^[0-9a-f]{64}$/.test(reference.sha256) && Number.isSafeInteger(reference.bytes) && reference.bytes > 0,
        'Actual fixture checkpoint binding is missing, duplicate or malformed')
        fixtureCheckpoint = structuredClone(reference)
      } catch (error) { failures.push(error.message); throw error }
    },
    attach: async (miniProgram, context) => {
      try {
        require(!flushed, 'Collector was already flushed')
        require(!captured || fixtureCheckpoint, 'Collector attachment preceded actual fixture checkpoint binding')
        await collector.attach(miniProgram, context)
      }
      catch (error) { failures.push(error.message); throw error }
    },
    checkpoint: async (observation, context) => {
      try {
        require(!flushed, 'Collector was already flushed')
        await collector.checkpoint?.(structuredClone(observation), context)
      } catch (error) { failures.push(error.message) }
    },
    flush: async () => {
      if (flushed) return
      flushed = true
      try { await collector.flush?.() } catch (error) { failures.push(error.message) }
      finally { hooks.deregister() }
      if (typeof collector.diagnostics === 'function') await json(resolve(dirname(outputFile), 'collector-query-diagnostics.json'), collector.diagnostics())
      await json(outputFile, { schemaVersion: 1, kind: 'conformance-observed-events', caseId: recipe.caseId,
        sourceSha256: recipe.sourceSha256,
        ...(captured ? { fixtureProfile: CAPTURED_STATIC_FIXTURE, fixtureCheckpoint } : { manifestIntegrity: recipe.manifestIntegrity }),
        status: failures.length || !events.length ? 'blocked' : 'passed', events, failures })
      require(!failures.length && events.length, 'Collector produced no complete observations')
    },
  }
}

/** A successful diagnostic attempt is necessary, but only an explicit recipe,
 * captured nonempty observations, actual assertions and complete cleanup can
 * produce the separate formal receipt. Reviewed index promotion stays manual. */
export async function finalizeOfficialConformance({ root, directory, attempt, selectionPath, recipe, compilerBuild, compilerUse, fixtureBuild }) {
  require(attempt.status === 'passed' && inspectConformanceAttempt(attempt).status === 'passed', 'Formal receipt requires a valid passed diagnostic attempt')
  const observations = JSON.parse(await readFile(resolve(directory, 'observed-events.json'), 'utf8'))
  require(observations.status === 'passed' && observations.caseId === attempt.caseId && observations.sourceSha256 === attempt.source.sha256
    && Array.isArray(observations.events) && observations.events.length > 0, 'Captured observations differ from the recipe/case')
  const captured = recipe.fixtureProfile === CAPTURED_STATIC_FIXTURE
  require(captured ? observations.fixtureProfile === CAPTURED_STATIC_FIXTURE && !Object.hasOwn(observations, 'manifestIntegrity')
    : observations.fixtureProfile === undefined && observations.manifestIntegrity === recipe.fixtureValue.manifest.integrity.root,
  'Captured observations differ from the recipe fixture profile/identity')
  const suite = JSON.parse(await readFile(resolve(directory, 'vitest.json'), 'utf8'))
  const results = suite.testResults?.filter(value => value.name?.replaceAll('\\', '/').endsWith(`/${attempt.source.path}`)) ?? []
  const assertions = results[0]?.assertionResults ?? []
  require(suite.success === true && results.length === 1 && results[0].status === 'passed' && assertions.length
    && assertions.every(value => value.status === 'passed' && typeof value.fullName === 'string' && value.fullName.trim())
    && new Set(assertions.map(value => value.fullName)).size === assertions.length, 'Actual Vitest assertions are absent, skipped, duplicate or failed')
  const selection = JSON.parse(await readFile(selectionPath, 'utf8'))
  assertOfficialSelection(selection)
  const actual = attempt.runtimeObservations[0]
  const runtimeValue = { schemaVersion: 1, kind: 'wechat-devtools-runtime-baseline', status: 'passed', ...actual }
  require(schemaErrors(runtimeValue, runtimeSchema).length === 0 && actual.installationId === selection.installationId
    && isAbsolute(actual.projectPath) && Date.parse(actual.recordedAt) >= Date.parse(attempt.run.startedAt)
    && Date.parse(actual.recordedAt) <= Date.parse(attempt.run.endedAt), 'Actual SDK observation is incomplete, from another installation, or outside the run')
  require(compilerBuild, 'Fresh compiler build evidence is required; retained dist is unverified')
  require(compilerUse, 'Actual compiler consumption is required')
  require(fixtureBuild, 'Actual case fixture build is required; a hand-authored pack is insufficient')
  const built = inspectConformanceFixtureBuildEvidence({ root, reference: fixtureBuild, compilerUse, compilerBuild,
    expectedCommit: baseline.compiler.commit, caseId: attempt.caseId, sourceSha256: attempt.source.sha256,
    ...(captured ? {} : { fixture: recipe.fixtureValue, resources: recipe.resources }), runtimeObservation: actual })
  require(built.errors.length === 0, `Actual case fixture provenance: ${built.errors.join('; ')}`)
  if (captured) require(canonicalReference(observations.fixtureCheckpoint) === canonicalReference(built.attestation.checkpoint),
    'Observed events are bound to a different actual fixture checkpoint')
  const fixtureValue = captured ? await readConformanceArtifact(root, built.attestation.fixture, { json: true }) : recipe.fixtureValue
  const resources = captured ? built.attestation.resources : recipe.resources
  const consumed = built.compilerUseAttestation
  require(consumed.process.pid === attempt.run.pid && Date.parse(consumed.startedAt) >= Date.parse(attempt.run.startedAt)
    && Date.parse(consumed.endedAt) <= Date.parse(attempt.run.endedAt), 'Compiler consumption belongs to another process or execution interval')
  const traceValue = { schemaVersion: 1, caseId: attempt.caseId, oracle: 'wechat-devtools', run: {
    status: 'passed', host: 'devtools', engine: 'wechat', protocolVersion: baseline.protocolVersion, manifestVersion: baseline.manifestVersion,
    startedAt: attempt.run.startedAt, endedAt: attempt.run.endedAt,
    environment: { baselineId: baseline.id, compilerCommit: baseline.compiler.commit, caseSourceSha256: attempt.source.sha256,
      manifestIntegrity: fixtureValue.manifest.integrity.root } }, events: observations.events,
    assertions: assertions.map(value => ({ id: value.fullName, passed: true })) }
  require(schemaErrors(traceValue, traceSchema).length === 0 && observations.events.every((event, index) => event.seq === index), 'Captured trace schema/sequence is invalid')
  let sourcePollJournal
  if (traceValue.events.some(event => event.op === 'method.poll')) {
    const journalFile = resolve(directory, 'collector-query-diagnostics.json')
    const journal = JSON.parse(await readFile(journalFile, 'utf8'))
    const checkpoint = await readConformanceArtifact(root, built.attestation.checkpoint, { json: true })
    assertSourcePollEvidence({ trace: traceValue, journal, build: checkpoint.build, load: reference => readFileSync(resolve(root, reference.path)) })
    sourcePollJournal = await conformanceArtifactReference(root, journalFile)
  }
  const traceFile = resolve(directory, 'official-trace.json')
  await json(traceFile, traceValue)
  const trace = await conformanceArtifactReference(root, traceFile)
  const runtimeFile = resolve(directory, 'runtime-observation.json')
  await json(runtimeFile, runtimeValue)
  const executionValue = { schemaVersion: 1, kind: 'wechat-devtools-case-execution', status: 'passed', provider: 'wechat-devtools',
    caseId: attempt.caseId, sourceSha256: attempt.source.sha256, compilerCommit: baseline.compiler.commit, baseline: baselineFields,
    sourceUnchanged: true, sourceBefore: attempt.source.before, sourceAfter: attempt.source.after,
    manifestIntegrity: fixtureValue.manifest.integrity.root, traceSha256: trace.sha256,
    observedDevtoolsVersion: actual.tool.version, observedBaseLibraryVersion: actual.system.SDKVersion,
    run: { exitCode: 0, pid: attempt.run.pid, startedAt: attempt.run.startedAt, endedAt: attempt.run.endedAt }, resources: {
      owner: attempt.resources.owner, leaseAcquired: attempt.resources.machineLeaseAcquired && attempt.resources.hostLeaseAcquired,
      leaseReleased: attempt.resources.machineLeaseReleased && attempt.resources.hostLeaseReleased,
      ownedResourcesReleased: attempt.resources.ownedResourcesReleased, borrowedResourcesPreserved: attempt.resources.borrowedResourcesPreserved },
    log: await conformanceArtifactReference(root, resolve(directory, 'official.log')),
    selection: await conformanceArtifactReference(root, selectionPath),
    runtimeObservation: await conformanceArtifactReference(root, runtimeFile), compilerBuild, compilerUse, fixtureBuild,
    ...(sourcePollJournal ? { sourcePollJournal } : {}),
    suiteReport: await conformanceArtifactReference(root, resolve(directory, 'vitest.json')) }
  require(schemaErrors(executionValue, oracleSchema).length === 0, 'Formal official receipt schema is invalid')
  const executionFile = resolve(directory, 'official-execution.json')
  await json(executionFile, executionValue)
  const oracle = { trace, execution: await conformanceArtifactReference(root, executionFile) }
  return { caseId: attempt.caseId, sourceSha256: attempt.source.sha256, fixture: fixtureValue, resources,
    oracle, containers: [], executionRecipe: { caseId: attempt.caseId, sourceSha256: attempt.source.sha256,
      fixture: captured ? built.attestation.fixture : recipe.fixture, resources, collector: recipe.collector, collectorInputs: recipe.collectorInputs, oracle } }
}

function canonicalReference(reference) {
  require(reference && Object.keys(reference).sort().join(',') === 'bytes,path,sha256', 'Actual fixture checkpoint reference is malformed')
  return JSON.stringify([reference.path, reference.sha256, reference.bytes])
}
