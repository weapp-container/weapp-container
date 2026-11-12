#!/usr/bin/env node
/** Executes explicit recipes on actual host drivers. Missing code, targets,
 * reviewed oracles and receipts remain separate blocked jobs, never pairs. */
import { execFileSync, spawn } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONFORMANCE_BASELINE as baseline, inspectConformanceEvidence, inspectConformanceCaseOracle, inspectConformanceContainerPair, schemaErrors } from './conformance-evidence.mjs'
import { CAPTURED_STATIC_FIXTURE, conformanceArtifactReference, readConformanceArtifact, readConformanceRecipes, prepareConformanceRecipe } from './conformance-recipes.mjs'

const project = resolve(fileURLToPath(new URL('..', import.meta.url)))
const driverSchema = JSON.parse(await readFile(new URL('../schemas/conformance-host-drivers-v1.schema.json', import.meta.url), 'utf8'))
const baselineFields = Object.fromEntries(['id', 'devtoolsVersion', 'baseLibraryVersion', 'protocolVersion', 'manifestVersion'].map(key => [key, baseline[key]]))
const json = async (file, value) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }) }
const ensure = (condition, message) => { if (!condition) throw new Error(message) }
export const MATRIX_INPUTS = [
  'scripts/conformance-matrix-runner.mjs', 'scripts/conformance-matrix-driver.mjs', 'scripts/conformance-recipes.mjs',
  'scripts/conformance-evidence.mjs', 'scripts/conformance-devtools-attempt.mjs', 'scripts/evidence-source.mjs',
  'scripts/conformance-compiler-build.mjs',
  'scripts/conformance-compiler-use.mjs', 'scripts/conformance-compiler-use-preload.cjs',
  'scripts/conformance-github-producer.mjs',
  'scripts/conformance-wxml-producer.mjs',
  'scripts/conformance-temporary-project-producer.mjs',
  'scripts/conformance-issue1034-producer.mjs',
  'scripts/conformance-snapshot-transport.mjs',
  'scripts/conformance-fixture-build.mjs', 'scripts/conformance-static-cli-profile.mjs', 'scripts/conformance-fixture-project.mjs', 'scripts/conformance-fixture-packer-preload.mjs',
  'scripts/pack-execution-evidence.mjs', 'scripts/modern-view-pack-resources.mjs',
  ...['container-manifest-v1', 'container-manifest-v2', 'container-manifest-v3', 'conformance-case-index-v1',
    'conformance-trace-v1', 'conformance-differential-v1', 'conformance-oracle-execution-v1', 'conformance-runtime-observation-v1',
    'conformance-attempt-v1', 'conformance-case-recipes-v1', 'conformance-host-drivers-v1', 'conformance-compiler-build-v1', 'conformance-compiler-use-v1', 'conformance-fixture-build-v1'].map(name => `schemas/${name}.schema.json`),
  'docs/conformance/baseline-v1.json', 'docs/conformance/case-index-v1.json', 'docs/conformance/case-index-v1.sha256',
]

async function createOutputDirectory(root, out) {
  let current = root
  const parts = relative(root, out).split('/')
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part)
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    ensure(!info || info.isDirectory() && !info.isSymbolicLink(), 'Matrix output ancestor is a symlink or non-directory')
    if (index === parts.length - 1) ensure(!info, 'Matrix output directory already exists')
    if (!info) await mkdir(current)
  }
}

export function parseMatrixArguments(argv) {
  const options = { planOnly: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--plan-only') options.planOnly = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (['--out', '--recipes', '--drivers', '--oracles'].includes(arg)) {
      const value = argv[++index]
      ensure(value && !value.startsWith('--'), `${arg} requires a value`)
      ensure(!options[arg.slice(2)], `Duplicate option: ${arg}`)
      options[arg.slice(2)] = value
    } else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

export function planConformanceMatrix({ index, recipes = new Map(), drivers = new Map(), oracles = new Map(), sourceValidation }) {
  ensure(Array.isArray(index?.cases) && new Set(index.cases.map(item => item.id)).size === index.cases.length, 'Matrix case set is missing or duplicated')
  return index.cases.flatMap(item => baseline.hosts.flatMap(host => baseline.engines.map(engine => {
    const blockers = []
    if (!recipes.has(item.id)) blockers.push('missing-case-recipe')
    if (recipes.get(item.id)?.fixtureProfile === CAPTURED_STATIC_FIXTURE) blockers.push('unbound-case-fixture')
    if (!oracles.has(item.id)) blockers.push('missing-official-oracle')
    if (!drivers.has(`${host}/${engine}`)) blockers.push('missing-host-driver')
    if (sourceValidation && sourceValidation.status !== 'passed') blockers.push('source-validation-incomplete')
    return { caseId: item.id, sourceSha256: item.sourceSha256, host, engine, status: blockers.length ? 'blocked' : 'planned', blockers }
  })))
}

export async function readHostDrivers({ root, file }) {
  const document = JSON.parse(await readFile(file, 'utf8'))
  const errors = schemaErrors(document, driverSchema)
  ensure(!errors.length, `Host driver schema: ${errors.join('; ')}`)
  ensure(document.baselineId === baseline.id, 'Host driver baseline differs')
  const drivers = new Map()
  for (const driver of document.drivers) {
    const key = `${driver.host}/${driver.engine}`
    ensure(!drivers.has(key), `Duplicate host driver: ${key}`)
    ensure(driver.timeoutMs === undefined || driver.timeoutMs <= 1_800_000, 'Driver timeout exceeds 30 minutes')
    const modules = [driver.module, ...driver.inputs]
    ensure(driver.module.path.endsWith('.mjs') && new Set(modules.map(ref => ref.path)).size === modules.length,
      'Driver entry must be .mjs and its executable/data inputs must be unique explicit artifacts')
    for (const ref of modules) await readConformanceArtifact(root, ref)
    drivers.set(key, driver)
  }
  return drivers
}

export function readOracleSet(document, index) {
  ensure(document?.schemaVersion === 1 && document.kind === 'wechat-devtools-oracle-set' && document.baselineId === baseline.id && Array.isArray(document.cases), 'Official oracle set is missing or from another baseline')
  const indexed = new Map(index.cases.map(item => [item.id, item.sourceSha256]))
  const oracles = new Map()
  for (const oracle of document.cases) {
    ensure(oracle && Object.keys(oracle).sort().join(',') === 'caseId,execution,sourceSha256,trace', 'Malformed official oracle entry')
    ensure(indexed.get(oracle.caseId) === oracle.sourceSha256 && !oracles.has(oracle.caseId), 'Unknown, changed or duplicated official oracle')
    oracles.set(oracle.caseId, { trace: oracle.trace, execution: oracle.execution })
  }
  return oracles
}

async function snapshotDriver(root, driver, directory) {
  const modules = []
  for (const reference of [driver.module, ...driver.inputs]) {
    const bytes = await readConformanceArtifact(root, reference)
    const file = resolve(directory, 'driver-inputs', reference.path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes, { flag: 'wx' })
    modules.push(await conformanceArtifactReference(root, file))
  }
  return { module: resolve(root, modules[0].path), modules: modules.map(ref => resolve(root, ref.path)), references: modules }
}

/** The full oracle reader admits the source/fixture execution separately.
 * This boundary keeps that exact admitted identity in the driver context. */
export function bindMatrixOracle({ job, recipe, admittedOracle }) {
  if (admittedOracle === undefined) {
    ensure(recipe.oracle === undefined, 'Matrix recipe oracle has no admitted oracle identity')
    return { recipe, admittedOracle: undefined }
  }
  const reference = value => value && Object.keys(value).sort().join(',') === 'bytes,path,sha256'
    && typeof value.path === 'string' && !value.path.includes('\\') && !value.path.includes('\0')
    && value.path.split('/').every(part => part && part !== '.' && part !== '..')
    && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes >= 0
  ensure(admittedOracle && Object.keys(admittedOracle).sort().join(',') === 'caseId,oracle,sourceSha256'
    && admittedOracle.caseId === job.caseId && admittedOracle.caseId === recipe.caseId
    && admittedOracle.sourceSha256 === job.sourceSha256 && admittedOracle.sourceSha256 === recipe.sourceSha256
    && /^[a-f0-9]{64}$/.test(admittedOracle.sourceSha256)
    && admittedOracle.oracle && Object.keys(admittedOracle.oracle).sort().join(',') === 'execution,trace'
    && reference(admittedOracle.oracle.trace) && reference(admittedOracle.oracle.execution), 'Matrix admitted oracle identity is malformed or belongs to another source')
  ensure(recipe.oracle === undefined || isDeepStrictEqual(recipe.oracle, admittedOracle.oracle),
    'Matrix recipe oracle differs from the admitted oracle identity')
  const binding = structuredClone(admittedOracle)
  return { recipe: { ...recipe, oracle: structuredClone(binding.oracle) }, admittedOracle: binding }
}

export async function executeMatrixDriver({ root, driver, job, recipe, outputDirectory, signal, admittedOracle }) {
  const binding = bindMatrixOracle({ job, recipe, admittedOracle })
  recipe = binding.recipe
  ensure(recipe.fixtureProfile !== CAPTURED_STATIC_FIXTURE && recipe.fixtureValue && recipe.resources,
    'Matrix execution requires an official run execution-recipes registry with the exact captured fixture')
  for (const reference of Object.values(binding.admittedOracle?.oracle ?? {})) await readConformanceArtifact(root, reference)
  const held = await snapshotDriver(root, driver, outputDirectory)
  const preparedRecipe = await prepareConformanceRecipe({ root, recipe, directory: outputDirectory })
  const recipeInputReferences = [preparedRecipe.fixture, ...Object.values(preparedRecipe.resources), preparedRecipe.collector, ...preparedRecipe.collectorInputs,
    await conformanceArtifactReference(root, preparedRecipe.runtimeRecipePath),
    ...(binding.admittedOracle ? Object.values(binding.admittedOracle.oracle) : [])]
  const context = { root, outputDirectory, job, recipe: { ...preparedRecipe, fixtureValue: recipe.fixtureValue },
    ...(binding.admittedOracle ? { admittedOracle: binding.admittedOracle } : {}) }
  const request = resolve(outputDirectory, 'request.json')
  const resultPath = resolve(outputDirectory, 'result.json')
  await json(request, { driverModule: held.module, driverModules: held.modules,
    driverInputs: held.references.map(reference => ({ file: resolve(root, reference.path), sha256: reference.sha256, bytes: reference.bytes })), context })
  const requestReference = await conformanceArtifactReference(root, request)
  // The child entry has no repository imports. Execute its archived bytes too.
  const entrySource = await conformanceArtifactReference(root, resolve(root, 'scripts/conformance-matrix-driver.mjs'))
  const entry = resolve(outputDirectory, 'driver-entry.mjs')
  await writeFile(entry, await readConformanceArtifact(root, entrySource), { flag: 'wx' })
  const entryReference = await conformanceArtifactReference(root, entry)
  const log = await open(resolve(outputDirectory, 'driver.log'), 'wx')
  let timeout
  let forced
  let interrupted = false
  let timedOut = false
  let child
  const stop = () => {
    interrupted = true
    child?.kill('SIGTERM')
    if (!forced) forced = setTimeout(() => child?.kill('SIGKILL'), 5000)
  }
  let outcome
  try {
    ensure(!signal?.aborted, 'Matrix execution was interrupted')
    child = spawn(process.execPath, [entry, request, resultPath], { cwd: root, stdio: ['ignore', log.fd, log.fd] })
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    timeout = setTimeout(() => { timedOut = true; stop() }, driver.timeoutMs ?? 300_000)
    outcome = await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, terminalSignal) => accept({ exitCode: code, signal: terminalSignal }))
    })
  } finally {
    clearTimeout(timeout); clearTimeout(forced)
    signal?.removeEventListener('abort', stop)
    await log.close()
  }
  const retainedInputs = [...held.references, requestReference, entryReference, ...recipeInputReferences]
  const inputErrors = []
  for (const reference of retainedInputs) {
    try { await readConformanceArtifact(root, reference) } catch (error) { inputErrors.push(error.message) }
  }
  const resultRef = await conformanceArtifactReference(root, resultPath).catch(() => null)
  let result = null
  if (resultRef) {
    try { result = await readConformanceArtifact(root, resultRef, { json: true }) }
    catch (error) { inputErrors.push(error.message) }
  }
  const cleanup = result?.cleanup ?? { ownedResourcesReleased: false, borrowedResourcesPreserved: false }
  const errors = [...inputErrors]
  if (timedOut || interrupted || outcome.exitCode !== 0 || result?.error) errors.push(
    `Host driver failed: ${timedOut ? 'timeout; inspect resource cleanup' : result?.error || outcome.signal || outcome.exitCode}`)
  if (cleanup.ownedResourcesReleased !== true || cleanup.borrowedResourcesPreserved !== true) errors.push('Host driver resource cleanup is incomplete')
  return { candidate: result?.candidate, status: errors.length ? 'failed' : 'executed', errors, cleanup, result: resultRef,
    process: { ...outcome, timedOut, interrupted }, inputs: retainedInputs,
    log: await conformanceArtifactReference(root, resolve(outputDirectory, 'driver.log')) }
}

export async function runConformanceMatrix(options, { root = project, signal } = {}) {
  root = await realpath(root)
  const indexPath = resolve(root, 'docs/conformance/case-index-v1.json')
  const indexReference = await conformanceArtifactReference(root, indexPath)
  const index = await readConformanceArtifact(root, indexReference, { json: true })
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const indexFile = { path: indexPath, value: index }
  const sourceAudit = inspectConformanceEvidence(indexFile, null, { root, expectedCommit: sourceCommit })
  const sourceAdmitted = sourceAudit.sourceValidation.status === 'passed'
  const out = resolve(root, options.out ?? `artifacts/conformance-matrix/${new Date().toISOString().replaceAll(/[:.]/g, '-')}`)
  const relativeOut = relative(root, out)
  ensure(relativeOut && !isAbsolute(relativeOut) && !relativeOut.startsWith('..'), 'Matrix output must be a fresh directory within this repository')
  await createOutputDirectory(root, out)
  const runnerInputs = []
  for (const path of MATRIX_INPUTS) {
    const original = await conformanceArtifactReference(root, resolve(root, path))
    const file = resolve(out, 'runner-inputs', path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, await readConformanceArtifact(root, original), { flag: 'wx' })
    runnerInputs.push({ original, snapshot: await conformanceArtifactReference(root, file) })
  }
  const registryInputs = []
  for (const name of ['recipes', 'drivers', 'oracles']) {
    if (options[name]) {
      const original = await conformanceArtifactReference(root, resolve(root, options[name]))
      const file = resolve(out, `${name}-registry.json`)
      await writeFile(file, await readConformanceArtifact(root, original), { flag: 'wx' })
      registryInputs.push({ original, snapshot: await conformanceArtifactReference(root, file) })
    }
  }
  const recipes = options.recipes ? await readConformanceRecipes({ root, index, file: resolve(root, options.recipes) }) : new Map()
  const drivers = options.drivers ? await readHostDrivers({ root, file: resolve(root, options.drivers) }) : new Map()
  const oracles = options.oracles ? readOracleSet(JSON.parse(await readFile(resolve(root, options.oracles), 'utf8')), index) : new Map()
  const jobs = planConformanceMatrix({ index, recipes, drivers, oracles, sourceValidation: sourceAudit.sourceValidation })
  const entries = new Map()
  const admission = new Map(), admittedOracles = new Map()
  for (const item of index.cases) {
    const recipe = recipes.get(item.id)
    if (!recipe || recipe.fixtureProfile === CAPTURED_STATIC_FIXTURE || !oracles.has(item.id)) continue
    const entry = { caseId: item.id, sourceSha256: item.sourceSha256, fixture: recipe.fixtureValue, resources: recipe.resources, oracle: oracles.get(item.id), containers: [] }
    try {
      const binding = bindMatrixOracle({ job: { caseId: item.id, sourceSha256: item.sourceSha256 }, recipe,
        admittedOracle: { caseId: item.id, sourceSha256: item.sourceSha256, oracle: entry.oracle } })
      entries.set(item.id, entry)
      const inspected = inspectConformanceCaseOracle(item, entry, { root })
      admission.set(item.id, inspected)
      if (inspected.status === 'passed') admittedOracles.set(item.id, binding.admittedOracle)
    } catch (error) { admission.set(item.id, { status: 'failed', error: error.message }) }
  }
  const report = { schemaVersion: 1, kind: 'weapp-container-matrix-run', baselineId: baseline.id, sourceCommit, index: indexReference,
    startedAt: new Date().toISOString(), planOnly: options.planOnly === true, status: 'incomplete', sourceValidation: sourceAudit.sourceValidation, jobs, runnerInputs, registryInputs,
    boundary: 'Actual explicit drivers only. Planned or blocked jobs are not execution receipts. Local unit tests and headless runs cannot substitute for native/window/device pairs.' }
  await json(resolve(out, 'plan.json'), structuredClone(report))
  for (const job of jobs) {
    if (signal?.aborted) { job.status = 'blocked'; job.blockers.push('matrix-interrupted'); continue }
    if (admission.has(job.caseId) && admission.get(job.caseId).status !== 'passed') {
      job.blockers.push('official-oracle-not-admitted'); job.error = admission.get(job.caseId).error
    }
    if (job.blockers.length) { job.status = 'blocked'; continue }
    if (options.planOnly) continue
    const item = index.cases.find(item => item.id === job.caseId)
    const directory = resolve(out, job.caseId, `${job.host}-${job.engine}`)
    await mkdir(directory, { recursive: true })
    process.stdout.write(`Container case starting: ${job.caseId} ${job.host}/${job.engine}\n`)
    job.startedAt = new Date().toISOString()
    try {
      const executed = await executeMatrixDriver({ root, driver: drivers.get(`${job.host}/${job.engine}`), job, recipe: recipes.get(job.caseId), admittedOracle: admittedOracles.get(job.caseId), outputDirectory: directory, signal })
      const { candidate, ...attempt } = executed
      job.attempt = attempt
      ensure(executed.status === 'executed', executed.errors.join('; '))
      const inspected = inspectConformanceContainerPair(item, entries.get(job.caseId), executed.candidate, { root, expectedCommit: sourceCommit, sourceCommit, host: job.host, engine: job.engine })
      ensure(inspected.status === 'passed', inspected.error)
      job.status = 'passed'
      entries.get(job.caseId).containers.push(candidate)
    } catch (error) { job.status = 'failed'; job.error = error.message }
    finally { job.endedAt = new Date().toISOString() }
  }
  const inputErrors = []
  for (const reference of [indexReference, ...runnerInputs.flatMap(input => [input.original, input.snapshot]), ...registryInputs.flatMap(input => [input.original, input.snapshot])]) {
    try { await readConformanceArtifact(root, reference) } catch (error) { inputErrors.push(error.message) }
  }
  report.inputErrors = inputErrors
  let differentialFile = null
  if (sourceAdmitted && entries.size === index.cases.length) {
    const value = { schemaVersion: 1, kind: 'weapp-container-differential', suite: baseline.suite, generatedAt: new Date().toISOString(),
      indexSha256: indexReference.sha256, sourceCommit, baseline: baselineFields, cases: [...entries.values()] }
    const path = resolve(out, 'differential.json')
    await json(path, value)
    differentialFile = { path, value }
    report.differential = await conformanceArtifactReference(root, path)
  }
  const audit = inspectConformanceEvidence(indexFile, differentialFile, { root, expectedCommit: sourceCommit })
  report.status = !inputErrors.length && audit.status === 'passed' && jobs.every(job => job.status === 'passed') ? 'passed' : 'incomplete'
  report.endedAt = new Date().toISOString()
  report.counts = Object.fromEntries(['planned', 'blocked', 'failed', 'passed'].map(status => [status, jobs.filter(job => job.status === status).length]))
  await json(resolve(out, 'audit.json'), audit)
  await json(resolve(out, 'run.json'), report)
  return { out, report, audit }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseMatrixArguments(process.argv.slice(2))
    if (options.help) process.stdout.write('Usage: node scripts/conformance-matrix-runner.mjs [--recipes registry.json] [--drivers drivers.json] [--oracles oracle-set.json] [--out directory] [--plan-only]\n')
    else {
      const controller = new AbortController()
      const stop = () => controller.abort()
      process.once('SIGINT', stop); process.once('SIGTERM', stop)
      try {
        const { out, report } = await runConformanceMatrix(options, { signal: controller.signal })
        process.stdout.write(`Conformance matrix ${report.status}: ${out}\n`)
        if (report.status !== 'passed') process.exitCode = 1
      } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
    }
  } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 }
}
