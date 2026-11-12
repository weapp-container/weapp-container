import { instrumentGithubAutomator, instrumentGithubSharedRuntime } from './conformance-github-producer.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONFORMANCE_BASELINE as baseline } from './conformance-evidence.mjs'

function replaceExactly(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Pinned runner instrumentation anchor is missing or ambiguous: ${before.slice(0, 100)}`)
  return source.replace(before, after)
}

/** Instrument runner helpers only. Indexed case/assertion bytes are untouched.
 * The patch must be archived with the attempt and is never applied to vendor. */
export function instrumentPinnedAutomator(source) {
  return instrumentGithubAutomator(source, baseline.baseLibraryVersion)
}

/** The session's independently owned close already waits for bounded native
 * window destruction, port release and a durable project journal. Do not race
 * it against a shorter generic Automator timeout and abandon that transaction. */
export function instrumentPinnedSharedRuntime(source, identity) {
  return instrumentGithubSharedRuntime(source, identity)
}

/** Ownership belongs to the current transport, while the fixture's Proxy
 * reference remains stable across reconnect. Reading it must not clear it. */
export function instrumentPinnedRecoverableSession(source) {
  return replaceExactly(source, `  return {\n    session,\n    replace(next: T) {`,
    `  return {\n    session,\n    current: requireCurrent,\n    replace(next: T) {`)
}

export function instrumentPinnedDomAcceptance(source) {
  const result = replaceExactly(source, '      plan.evidence.push(evidence)\n      return evidence',
    '      plan.evidence.push(evidence)\n      await recordConformanceDomCheckpoint({ fixture: plan.fixture, provider: plan.provider, runtime: plan.runtime, evidence }, { session, page })\n      return evidence')
  return `import { recordConformanceDomCheckpoint } from '../conformanceEvidence.mjs'\n${result}`
}

/** Global setup imports automator helpers without a current Vitest suite.
 * Evidence collection has no test-hook side effects until worker setup owns
 * its final flush; scoped project cleanup still runs if that flush fails. */
export function createConformanceEvidenceModule(helper) {
  return `import { persistOpenedAutomatorSession } from 'weapp-ide-cli'
import { writeFile } from 'node:fs/promises'
import { createOfficialSessionRecorder } from ${JSON.stringify(pathToFileURL(helper).href)}
import { createRuntimeTraceCollector } from ${JSON.stringify(pathToFileURL(join(dirname(helper), 'conformance-recipes.mjs')).href)}
import { installStaticFixtureBuildRecorder, captureOfficialFixtureCheckpoint, captureOwnedSnapshot, captureOwnedSnapshotCleanup } from ${JSON.stringify(pathToFileURL(join(dirname(helper), 'conformance-fixture-build.mjs')).href)}
const recorder = createOfficialSessionRecorder({ directory: process.env.WEAPP_CONTAINER_CONFORMANCE_SESSION_DIR, cliPath: process.env.WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH, installationId: process.env.WEAPP_CONTAINER_CONFORMANCE_INSTALLATION_ID, persistOpenedAutomatorSession })
const collector = await createRuntimeTraceCollector({ recipePath: process.env.WEAPP_CONTAINER_CONFORMANCE_RECIPE, outputFile: process.env.WEAPP_CONTAINER_CONFORMANCE_EVENTS })
let fixture = null
const observationFailures = []
const recordObservationFailure = (error, code = 'CONFORMANCE_FIXTURE_PROVENANCE_FAILED') => observationFailures.push({ code: error?.code ?? code, message: error?.message ?? String(error), ...(error?.snapshotCandidate ? { snapshotCandidate: error.snapshotCandidate, snapshotValidation: error.snapshotValidation } : {}) })
export function startConformanceEvidence() {
  if (fixture || !process.env.WEAPP_CONTAINER_CONFORMANCE_FIXTURE_DIR) return
  fixture = installStaticFixtureBuildRecorder({
  root: process.env.WEAPP_CONTAINER_CONFORMANCE_ROOT, directory: process.env.WEAPP_CONTAINER_CONFORMANCE_FIXTURE_DIR,
  compilerUseConfigPath: process.env.WEAPP_CONTAINER_COMPILER_USE_CONFIG,
  compilerBuild: JSON.parse(process.env.WEAPP_CONTAINER_CONFORMANCE_COMPILER_BUILD),
  expectedCommit: ${JSON.stringify(baseline.compiler.commit)},
  ...JSON.parse(process.env.WEAPP_CONTAINER_CONFORMANCE_CASE),
  })
}
export const recordConformanceSnapshot = async observation => {
  if (fixture) try { await captureOwnedSnapshot({ recorder: fixture, observation }) }
  catch (error) { recordObservationFailure(error) }
}
export const recordConformanceSnapshotCleanup = async observation => {
  if (fixture) try { await captureOwnedSnapshotCleanup({ recorder: fixture, observation }) }
  catch (error) { recordObservationFailure(error) }
}
export const observeConformanceExpectPoll = (expect, flag) => collector.observeExpectPoll(expect, flag)
export const recordConformanceRoutePageMethod = (context, invoke) => collector.routePageMethod(context, invoke)
export const recordConformanceReadinessStart = context => collector.readinessStart(context)
export const recordConformanceReadinessEnd = token => collector.readinessEnd(token)
export const recordConformanceExceptionAuxiliary = (context, invoke) => collector.exceptionAuxiliary(context, invoke)
export const recordConformanceSession = recorder.onSessionMetadata
export const recordConformanceDomCheckpoint = (observation, context) => collector.checkpoint(observation, context)
export const recordConformanceRuntime = async (program, context) => {
  const observation = await recorder.observeRuntime(program, context)
  if (fixture) {
    try {
      const captured = await captureOfficialFixtureCheckpoint({ recorder: fixture, runtimeObservation: observation })
      collector.bindFixtureCheckpoint(captured.reference)
    }
    catch (error) { recordObservationFailure(error) }
  }
  try { await collector.attach(program, context) }
  catch (error) { recordObservationFailure(error, 'CONFORMANCE_TRACE_COLLECTOR_ATTACH_FAILED') }
  return observation
}
export const flushConformanceEvidence = async () => {
  try {
    await recorder.flush()
    try { await collector.flush() }
    catch (error) { recordObservationFailure(error, 'CONFORMANCE_TRACE_COLLECTOR_FLUSH_FAILED') }
  }
  finally {
    try { await fixture?.flush() } catch (error) { recordObservationFailure(error) }
    finally {
      fixture?.dispose()
      if (process.env.WEAPP_CONTAINER_CONFORMANCE_OBSERVER_FAILURES) await writeFile(process.env.WEAPP_CONTAINER_CONFORMANCE_OBSERVER_FAILURES,
        JSON.stringify({ schemaVersion: 1, kind: 'conformance-observer-observation', ...JSON.parse(process.env.WEAPP_CONTAINER_CONFORMANCE_CASE), failures: observationFailures }) + '\\n')
    }
  }
}
`
}

export function instrumentPinnedIdeSetup(source) {
  let result = `import { expect as conformanceExpect, chai as conformanceChai } from 'vitest'\nimport { startConformanceEvidence, flushConformanceEvidence, observeConformanceExpectPoll } from './utils/conformanceEvidence.mjs'\nstartConformanceEvidence()\nobserveConformanceExpectPoll(conformanceExpect, conformanceChai.util.flag)\n${source}`
  result = replaceExactly(result, `afterAll(async () => {\n  if (devtoolsJournalPath) {\n    // IDE suites 串行；日志也包含本 worker 启动并已退出的 bridge CLI 所登记的窗口。\n    await cleanupOwnedDevtoolsProcesses({ journalPath: devtoolsJournalPath, scope: 'journal' })\n  }\n}, 120_000)`,
    `afterAll(async () => {\n  const failures: unknown[] = []\n  try { await flushConformanceEvidence() } catch (error) { failures.push(error) }\n  try {\n    if (devtoolsJournalPath) await cleanupOwnedDevtoolsProcesses({ journalPath: devtoolsJournalPath, scope: 'journal' })\n  } catch (error) { failures.push(error) }\n  if (failures.length) throw new AggregateError(failures, 'Official evidence flush or scoped project cleanup failed')\n}, 120_000)`)
  return result
}

async function optionalStat(path) { try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }

/** Inventory retained build bytes, without claiming that ignored outputs were
 * built from the pinned sources. Literal local helper imports/data are copied
 * for review; a linked node_modules tree remains an unverified dependency. */
export async function inventoryRetainedBuildInputs({ checkout, archive, helper, buildDirectories = [], dependencyLinks = [] }) {
  const record = async (file, path) => {
    const bytes = await readFile(file)
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
  }
  const buildArtifacts = []
  const walk = async directory => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile()) buildArtifacts.push(await record(file, relative(checkout, file).replaceAll('\\', '/')))
      else buildArtifacts.push({ path: relative(checkout, file).replaceAll('\\', '/'), kind: 'unverified-link', target: await readlink(file) })
    }
  }
  for (const directory of buildDirectories) await walk(directory)
  const helperInputs = []
  const helperDirectoryContexts = []
  const visited = new Set()
  const visitHelper = async file => {
    if (visited.has(file)) return
    visited.add(file)
    const bytes = await readFile(file)
    const item = { path: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    const snapshot = `helper-inputs/${String(helperInputs.length).padStart(4, '0')}-${file.split(/[\\/]/).at(-1)}`
    await mkdir(dirname(join(archive, snapshot)), { recursive: true })
    await writeFile(join(archive, snapshot), bytes)
    helperInputs.push({ ...item, snapshot })
    if (!/\.[cm]?js$/.test(file)) return
    const source = bytes.toString('utf8')
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\bfrom\s+)?['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) await visitHelper(resolve(dirname(file), match[1]))
      else if (match[1].startsWith('file:')) await visitHelper(fileURLToPath(match[1]))
    }
    for (const match of source.matchAll(/new URL\(['"]([^'"]+)['"],\s*import\.meta\.url\)/g)) {
      if (!match[1].startsWith('.')) continue
      const target = resolve(dirname(file), match[1])
      if ((await lstat(target)).isDirectory()) {
        if (!helperDirectoryContexts.some(item => item.path === target)) helperDirectoryContexts.push({
          path: target, kind: 'directory-context', contentVerified: false,
        })
      } else await visitHelper(target)
    }
  }
  await visitHelper(resolve(helper))
  const inventory = {
    schemaVersion: 1, compilerCommit: baseline.compiler.commit, retainedBuildProvenance: 'unverified', diagnosticOnly: true,
    boundary: 'Hashes identify retained copied dist and literal local helper inputs only. They do not prove that ignored dist was built from the pinned commit, or attest the linked node_modules/dynamic input closure. An isolated reproducible compiler build is still required for formal compiler-bound evidence.',
    buildArtifacts, helperInputs, helperDirectoryContexts, dependencyLinks: await Promise.all(dependencyLinks.map(async path => ({
      path: relative(checkout, path).replaceAll('\\', '/'), target: await readlink(path), contentVerified: false,
    }))),
  }
  await writeFile(join(archive, 'retained-build-inputs.json'), JSON.stringify(inventory, null, 2) + '\n')
  return inventory
}

/** Choose this worker's helper bytes from the unchanged selected source tuple.
 * Each sequential case gets a fresh transform of pinned Git bytes, so an earlier
 * import-meta case cannot leave readiness hooks in a different case's guard. */
export async function selectOfficialCaseSharedRuntime({ checkout, archive, identity }) {
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim() !== baseline.compiler.commit
    || !identity || typeof identity.caseId !== 'string' || !identity.caseId
    || typeof identity.caseSourcePath !== 'string' || !/^e2e\/ide\/[^/]+\.test\.ts$/.test(identity.caseSourcePath)
    || !/^[a-f0-9]{64}$/.test(identity.sourceSha256 ?? '')) throw new Error('Official helper selection requires an exact pinned case source identity')
  const selectedSource = await readFile(join(checkout, identity.caseSourcePath))
  const pinnedSource = execFileSync('git', ['show', `${baseline.compiler.commit}:${identity.caseSourcePath}`], { cwd: checkout })
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  if (hash(selectedSource) !== identity.sourceSha256 || hash(pinnedSource) !== identity.sourceSha256) {
    throw new Error('Official helper selection source differs from its unchanged pinned case')
  }
  const path = 'e2e/ide/github-issues.runtime.shared.ts'
  const original = execFileSync('git', ['show', `${baseline.compiler.commit}:${path}`], { cwd: checkout })
  const observed = Buffer.from(instrumentPinnedSharedRuntime(original.toString('utf8'), identity))
  await writeFile(join(checkout, path), observed)
  await mkdir(archive, { recursive: true })
  await writeFile(join(archive, 'shared-runtime.ts'), observed, { flag: 'wx' })
  const selection = { schemaVersion: 1, kind: 'official-case-shared-runtime-selection',
    identity: { caseId: identity.caseId, caseSourcePath: identity.caseSourcePath, sourceSha256: identity.sourceSha256 },
    helper: { path, originalSha256: hash(original), observedSha256: hash(observed), bytes: observed.length } }
  await writeFile(join(archive, 'shared-runtime-selection.json'), JSON.stringify(selection, null, 2) + '\n', { flag: 'wx' })
  return selection
}

/** Retained package outputs support diagnostic runs without vendor writes.
 * Their inventory does not prove a pinned compiler build. All mutable fixtures
 * and generated project files live in the detached clone. */
export async function prepareOfficialCheckout({ vendor, checkout, archive, helper, selectedCase }) {
  await mkdir(dirname(checkout), { recursive: true })
  execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', vendor, checkout], { stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('git', ['checkout', '--quiet', '--detach', baseline.compiler.commit], { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'] })
  const buildDirectories = []
  const dependencyLinks = []
  async function attachInputs(source, destination, depth = 0) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (!entry.isDirectory() || ['.git', '.tmp', '.cache', '.turbo', '.output'].includes(entry.name)) continue
      const from = join(source, entry.name)
      const to = join(destination, entry.name)
      if (entry.name === 'node_modules') {
        if (!await optionalStat(to)) { await symlink(from, to, 'junction'); dependencyLinks.push(to) }
      } else if (entry.name === 'dist' && depth > 0) {
        if (!await optionalStat(to)) { await cp(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE }); buildDirectories.push(to) }
      } else if (depth < 3 && await optionalStat(to)) await attachInputs(from, to, depth + 1)
    }
  }
  await attachInputs(vendor, checkout)
  await mkdir(archive, { recursive: true })
  await inventoryRetainedBuildInputs({ checkout, archive, helper, buildDirectories, dependencyLinks })
  return await instrumentOfficialCheckout({ checkout, archive, helper, selectedCase,
    inputProvenance: { dependencySource: vendor,
      dependencyMode: 'read dependencies from original installation; copy package dist with copy-on-write',
      retainedBuildProvenance: 'unverified', retainedBuildInventory: 'retained-build-inputs.json' } })
}

/** Instrument only an already-owned checkout. Formal callers reconstruct its
 * source/build/dependency closure before this step and separately attest use.
 * This patch record alone never proves compiler provenance. */
export async function instrumentOfficialCheckout({ checkout, archive, helper, inputProvenance, selectedCase }) {
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim() !== baseline.compiler.commit) {
    throw new Error('Official instrumentation requires the pinned compiler checkout.')
  }
  await mkdir(archive, { recursive: true })
  const automator = join(checkout, 'e2e/utils/automator.ts')
  await writeFile(automator, instrumentPinnedAutomator(await readFile(automator, 'utf8')))
  await writeFile(join(checkout, 'e2e/utils/conformanceEvidence.mjs'), createConformanceEvidenceModule(helper))
  const setup = join(checkout, 'e2e/vitest.e2e.ide.setup.ts')
  await writeFile(setup, instrumentPinnedIdeSetup(await readFile(setup, 'utf8')))
  const sharedRuntime = join(checkout, 'e2e/ide/github-issues.runtime.shared.ts')
  await writeFile(sharedRuntime, instrumentPinnedSharedRuntime(await readFile(sharedRuntime, 'utf8')))
  if (selectedCase) await selectOfficialCaseSharedRuntime({ checkout, archive: join(archive, 'selected-case'), identity: selectedCase })
  const domAcceptance = join(checkout, 'e2e/utils/domAcceptance/index.ts')
  await writeFile(domAcceptance, instrumentPinnedDomAcceptance(await readFile(domAcceptance, 'utf8')))
  const recoverableSession = join(checkout, 'e2e/utils/recoverableSession.ts')
  await writeFile(recoverableSession, instrumentPinnedRecoverableSession(await readFile(recoverableSession, 'utf8')))
  // The installed fixture default must agree with the launch override, while
  // the actual wx observation above is still required after every connect.
  const configs = execFileSync('git', ['ls-files', '-z', '*project.config.json', '*project.private.config.json'], { cwd: checkout }).toString('utf8').split('\0').filter(Boolean)
  for (const path of configs) {
    const file = join(checkout, path)
    const value = JSON.parse(await readFile(file, 'utf8'))
    if ('libVersion' in value) { value.libVersion = baseline.baseLibraryVersion; await writeFile(file, JSON.stringify(value, null, 2) + '\n') }
  }
  const patch = execFileSync('git', ['diff', '--binary'], { cwd: checkout, maxBuffer: 32 * 1024 * 1024 })
  await writeFile(join(archive, 'runner.patch'), patch)
  await cp(join(checkout, 'e2e/utils/conformanceEvidence.mjs'), join(archive, 'conformanceEvidence.mjs'))
  await writeFile(join(archive, 'checkout.json'), JSON.stringify({ compilerCommit: baseline.compiler.commit,
    checkout, ...inputProvenance,
    indexedCaseSourcesModified: false, patchedFiles: execFileSync('git', ['diff', '--name-only'], { cwd: checkout, encoding: 'utf8' }).trim().split('\n').filter(Boolean) }, null, 2) + '\n')
  return { checkout, patch: join(archive, 'runner.patch') }
}
