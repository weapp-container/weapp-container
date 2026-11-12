#!/usr/bin/env node
/** Serialized, fixed-baseline official reruns. All instrumentation and fixture
 * writes happen in a detached clone; vendor and official assertions stay intact. */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONFORMANCE_BASELINE as baseline } from './conformance-evidence.mjs'
import { assertOfficialSelection, classifyConformanceFailure, inspectConformanceAttempt } from './conformance-devtools-attempt.mjs'
import { prepareOfficialCheckout, instrumentOfficialCheckout, selectOfficialCaseSharedRuntime } from './conformance-devtools-isolation.mjs'
import { materializeCompilerUse, forkCompilerUse, sealCompilerUse, finishCompilerUse } from './conformance-compiler-use.mjs'
import { finalizeStaticFixtureBuild } from './conformance-fixture-build.mjs'
import { REVIEWED_PRODUCER_INPUTS } from './conformance-producer-revisions.mjs'
import { templateSfcCollectorDependencies } from '../examples/hosts/conformance-desktop/template-sfc-format-inputs.mjs'
import { uniqueCollectorInputs } from '../examples/hosts/conformance-desktop/collector-inputs.mjs'
import { templateCollectorDependencies } from '../examples/hosts/conformance-desktop/template-format-inputs.mjs'
import { conformanceArtifactReference, readConformanceArtifact, readConformanceRecipes, prepareConformanceRecipe, finalizeOfficialConformance } from './conformance-recipes.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const vendor = join(root, 'vendor/weapp-vite')
// Each case consumes the sealed installation directly. Persisted test results
// and bundled temporary configs would add unarchived executable/cache inputs
// after that seal. Vite's runner loads the original pinned config graph.
export const OFFICIAL_VITEST_EXECUTION_ARGS = ['--no-cache', '--no-fsModuleCache', '--configLoader', 'runner']
// Audited local execution/data closure. Package dist and linked dependencies
// have a separate retained-build inventory and remain unverified build inputs.
export const RUNNER_INPUTS = [
  ...REVIEWED_PRODUCER_INPUTS,
  'examples/hosts/conformance-desktop/collector-inputs.mjs',
  'examples/hosts/conformance-desktop/template-sfc-format-inputs.mjs',
  'examples/hosts/conformance-desktop/template-multi-platform-sfc-replay.mjs',
  'examples/hosts/conformance-desktop/template-multi-platform-sfc-static.mjs',
  'conformance/recipes/template-multi-platform-sfc-collector.mjs',
  'examples/hosts/conformance-desktop/template-format-inputs.mjs',
  'examples/hosts/conformance-desktop/template-multi-platform-replay.mjs',
  'examples/hosts/conformance-desktop/template-multi-platform-static.mjs',
  'conformance/recipes/template-multi-platform-collector.mjs',
  ...uniqueCollectorInputs([...templateCollectorDependencies, ...templateSfcCollectorDependencies]).map(input => relative(root, fileURLToPath(new URL(input.path, new URL('../examples/hosts/conformance-desktop/template-format-inputs.mjs', import.meta.url))))),
  'scripts/conformance-devtools-runner.mjs', 'scripts/conformance-devtools-attempt.mjs',
  'scripts/conformance-devtools-isolation.mjs', 'scripts/conformance-evidence.mjs',
  'scripts/conformance-source-poll-evidence.mjs',
  'scripts/conformance-source-tap-evidence.mjs', 'scripts/conformance-source-tap-evidence.test.mjs',
  'conformance/recipes/issue1009-descriptor.mjs', 'conformance/recipes/issue1009-source-policy.mjs',
  'conformance/recipes/issue1009-source-assertions.mjs', 'conformance/recipes/issue1009-pure-read.mjs',
  'conformance/recipes/issue1011-collector.mjs', 'conformance/recipes/issue1011-descriptor.mjs',
  'conformance/recipes/issue1011-original-values.mjs', 'conformance/recipes/issue1011-pure-read.mjs',
  'conformance/recipes/issue1011-source-assertions.mjs', 'conformance/recipes/issue1011-source-policy.mjs',
  'conformance/recipes/issue1011-tap-source.mjs', 'examples/hosts/conformance-desktop/issue1011-replay.mjs',
  'examples/hosts/conformance-desktop/issue1011-static.mjs', 'examples/hosts/conformance-desktop/source-plan-replay.mjs',
  'examples/hosts/conformance-desktop/fixtures/issue1011-host-inputs.mjs',
  'conformance/recipes/ordered-steps-collector-core.mjs',
  'conformance/recipes/passive-query-context.mjs',
  'examples/hosts/conformance-desktop/native-program.mjs',
  'examples/hosts/conformance-desktop/opaque-native-nodes.mjs',
  'conformance/recipes/source-exception-capture.mjs',
  'conformance/recipes/source-runtime-log-capture.mjs',
  'examples/hosts/conformance-desktop/native-exception-channel.mjs',
  'conformance/recipes/source-method-values.mjs',
  'scripts/conformance-recipes.mjs', 'schemas/conformance-case-recipes-v1.schema.json',
  'scripts/conformance-compiler-build.mjs', 'schemas/conformance-compiler-build-v1.schema.json',
  'scripts/conformance-compiler-use.mjs', 'scripts/conformance-compiler-use-preload.cjs', 'schemas/conformance-compiler-use-v1.schema.json',
  'scripts/conformance-compiler-observation.mjs', 'scripts/conformance-compiler-observation-v1.json',
  'scripts/conformance-compiler-macro-observer.mjs', 'scripts/conformance-compiler-macro-validator.mjs',
  'scripts/conformance-github-producer.mjs',
  'scripts/conformance-wxml-producer.mjs',
  'scripts/conformance-temporary-project-producer.mjs',
  'scripts/conformance-issue1034-producer.mjs',
  'scripts/conformance-snapshot-transport.mjs',
  'scripts/conformance-fixture-build.mjs', 'scripts/conformance-static-cli-profile.mjs', 'scripts/conformance-fixture-project.mjs', 'scripts/conformance-fixture-packer-preload.mjs', 'schemas/conformance-fixture-build-v1.schema.json',
  'scripts/evidence-source.mjs', 'scripts/pack-execution-evidence.mjs', 'scripts/modern-view-pack-resources.mjs',
  'schemas/conformance-attempt-v1.schema.json', 'schemas/conformance-case-index-v1.schema.json',
  'schemas/conformance-trace-v1.schema.json', 'schemas/conformance-differential-v1.schema.json',
  'schemas/conformance-oracle-execution-v1.schema.json', 'schemas/conformance-runtime-observation-v1.schema.json',
  // pack-execution-evidence loads these three through a computed URL.
  'schemas/container-manifest-v1.schema.json', 'schemas/container-manifest-v2.schema.json', 'schemas/container-manifest-v3.schema.json',
  'docs/conformance/baseline-v1.json', 'docs/conformance/case-index-v1.json', 'docs/conformance/case-index-v1.sha256',
  'package.json', '.gitignore',
]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n') }
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).trim()

export async function snapshotRunnerInputs(sourceRoot, out) {
  return await Promise.all(RUNNER_INPUTS.map(async path => {
    const bytes = await readFile(join(sourceRoot, path))
    const snapshot = join('runner-inputs', path)
    await mkdir(dirname(join(out, snapshot)), { recursive: true })
    await writeFile(join(out, snapshot), bytes, { flag: 'wx' })
    return { path, snapshot, sha256: hash(bytes), bytes: bytes.length }
  }))
}

/** The worker's content-addressed reference is the observation identity. The
 * named checkpoint is only an inspectable alias, never a new parent identity. */
export async function readOfficialFixtureHandoff({ root, directory, caseId, sourceSha256 }) {
  const ensure = (condition, message) => {
    if (!condition) throw Object.assign(new Error(message), { code: 'CONFORMANCE_FIXTURE_CHECKPOINT_INVALID', stage: 'runner' })
  }
  const capture = join(directory, 'fixture-capture')
  const recorderSummary = await conformanceArtifactReference(root, join(capture, 'static-recorder-summary.json'))
  const summary = await readConformanceArtifact(root, recorderSummary, { json: true })
  ensure(summary.schemaVersion === 1 && summary.kind === 'weapp-container.static-recorder-summary'
    && summary.profile === 'static-cli-v1' && summary.status === 'complete'
    && summary.caseId === caseId && summary.sourceSha256 === sourceSha256,
  'Fixture handoff requires the completed recorder summary for this exact case/source')
  const checkpoint = summary.checkpoint
  ensure(checkpoint && Object.keys(checkpoint).sort().join(',') === 'bytes,path,sha256'
    && typeof checkpoint.sha256 === 'string' && /^[0-9a-f]{64}$/.test(checkpoint.sha256)
    && Number.isSafeInteger(checkpoint.bytes) && checkpoint.bytes > 0 && checkpoint.bytes <= 64 * 1024 ** 2
    && checkpoint.path === relative(root, join(capture, 'objects/sha256', checkpoint.sha256)).replaceAll('\\', '/'),
  'Fixture handoff checkpoint is not the exact owned worker reference')
  const bytes = await readConformanceArtifact(root, checkpoint)
  const alias = await conformanceArtifactReference(root, join(capture, 'static-checkpoint.json'))
  ensure(bytes.equals(await readConformanceArtifact(root, alias)), 'Named fixture checkpoint differs from the worker checkpoint bytes')
  const value = JSON.parse(bytes.toString('utf8'))
  ensure(value.schemaVersion === 1 && value.kind === 'weapp-container.static-generated-checkpoint'
    && value.profile === summary.profile && value.status === 'captured'
    && value.caseId === caseId && value.sourceSha256 === sourceSha256
    && typeof value.ownerId === 'string' && value.ownerId && value.ownerId === summary.ownerId
    && typeof value.runId === 'string' && value.runId && value.runId === summary.runId,
  'Fixture handoff checkpoint belongs to another recorder, run, case or source')
  return { checkpoint, recorderSummary }
}

/** The official CLI writes Default/.cli on its first user-info call. A newly
 * extracted selected installation needs its empty directory first; account
 * data and settings from another installation are never copied here. */
export async function prepareSelectedDevtoolsProfile(target) {
  if (!isAbsolute(target?.profileDir ?? '')) throw new Error('Selected DevTools profile directory must be absolute.')
  const directory = join(target.profileDir, 'Default')
  const existing = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('Selected DevTools Default profile path must be a directory, not a symlink or file.')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return { directory, created: !existing, accountDataCopied: false, existingFilesPreserved: true }
}

export function parseOfficialArguments(argv) {
  const options = { cases: [], focus: null, out: null, recipes: null, compilerBuild: null, cliPath: process.env.WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH ?? '/Applications/wechatwebdevtools.app/Contents/MacOS/cli', prepareOnly: false, keepCheckout: false, borrowSelectedHost: false }
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]
    const value = () => {
      const next = argv[++at]
      if (typeof next !== 'string' || !next.trim() || next.startsWith('--')) throw new Error(`${arg} requires a value`)
      return next
    }
    if (arg === '--') continue
    else if (arg === '--case') options.cases.push(value())
    else if (arg === '--focus') options.focus = value()
    else if (arg === '--out') options.out = resolve(root, value())
    else if (arg === '--recipes') options.recipes = resolve(root, value())
    else if (arg === '--compiler-build') options.compilerBuild = resolve(root, value())
    else if (arg === '--cli') options.cliPath = value()
    else if (arg === '--prepare-only') options.prepareOnly = true
    else if (arg === '--keep-checkout') options.keepCheckout = true
    else if (arg === '--borrow-selected-host') options.borrowSelectedHost = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (options.focus && !['failed-blocked', 'all'].includes(options.focus)) throw new Error('--focus must be failed-blocked or all')
  return options
}

/** Upstream single-case fixtures use this value for both their working
 * directory and compiler scope. A Vitest filename filter alone is insufficient. */
export function createOfficialCaseEnvironment(source, environment = {}) {
  if (typeof source !== 'string' || !/^e2e\/(?:[^/]+\/)+[^/]+\.test\.[cm]?[jt]sx?$/.test(source)
    || source.split('/').some(part => part === '.' || part === '..') || source.includes('\\')) {
    throw new Error('Official case environment requires an exact indexed e2e test source.')
  }
  return { ...environment, WEAPP_VITE_E2E_TARGET_FILE: source.slice('e2e/'.length) }
}

/** Signals request a stop at the next owned-resource boundary. runChild
 * forwards them to the active child; the coordinator still awaits cleanup. */
export function createOfficialStopController(signals = process) {
  let requested = null
  const listeners = ['SIGINT', 'SIGTERM'].map(signal => {
    const listener = () => { requested ??= { signal, requestedAt: new Date().toISOString() } }
    signals.on(signal, listener)
    return [signal, listener]
  })
  return {
    get requested() { return requested },
    throwIfRequested() {
      if (requested) throw Object.assign(new Error(`Official run stopped by ${requested.signal} after owned-resource cleanup.`),
        { code: 'CONFORMANCE_RUN_STOP_REQUESTED', stage: 'runner', stopRequested: { ...requested } })
    },
    dispose() { for (const [signal, listener] of listeners) signals.off(signal, listener) },
  }
}

const hostFailure = message => Object.assign(new Error(message), { code: 'WECHAT_DEVTOOLS_HOST_IDENTITY_MISMATCH', stage: 'lease' })
const targetFields = ['cliPath', 'appPath', 'profileDir', 'installationId', 'version', 'channel']
function sameOfficialTarget(expected, actual) {
  return targetFields.every(key => typeof expected?.[key] === 'string' && expected[key] && expected[key] === actual?.[key])
}
function officialHostIdentities(snapshot) {
  if (snapshot?.state !== 'selected' || !Array.isArray(snapshot.identities) || !snapshot.identities.length) throw hostFailure('Borrowed DevTools host is not an identified selected installation.')
  const keys = snapshot.identities.map(identity => {
    if (!Number.isSafeInteger(identity?.pid) || identity.pid <= 0 || !identity.started || typeof identity.started !== 'string'
      || !identity.executable || typeof identity.executable !== 'string') throw hostFailure('Borrowed DevTools host process identity is incomplete.')
    return JSON.stringify([identity.pid, identity.started, identity.executable])
  })
  return [...new Set(keys)].sort()
}

/** A selected running host can be borrowed only inside the real machine lease.
 * Its immutable installation/process identity grants project-scoped use, never
 * host shutdown authority. The default path still requires a cold host. */
export async function acquireOfficialHost({ target, borrowSelectedHost = false, machineLease, hostLifecycle, resolveSelectedTarget }) {
  if (!machineLease || machineLease.released !== false || typeof machineLease.createChildScope !== 'function') throw hostFailure('An active machine E2E lease is required before using DevTools.')
  const before = borrowSelectedHost ? await hostLifecycle.inspectDevtoolsHost(target) : null
  if (!borrowSelectedHost || before.state === 'cold') {
    const lease = await hostLifecycle.claimDevtoolsHost(target.cliPath)
    if (!sameOfficialTarget(target, lease.target)) throw hostFailure('Selected DevTools installation changed before host claim.')
    return { ...lease, mode: 'cold-owned' }
  }
  const identities = officialHostIdentities(before)
  const currentTarget = await resolveSelectedTarget(target.cliPath)
  if (!sameOfficialTarget(target, currentTarget)) throw hostFailure('Selected DevTools installation changed before borrowing.')
  const verified = await hostLifecycle.inspectDevtoolsHost(target)
  if (JSON.stringify(identities) !== JSON.stringify(officialHostIdentities(verified))) throw hostFailure('Selected DevTools host changed before borrowing.')
  return { mode: 'borrowed-selected', target: structuredClone(target), initial: structuredClone(verified), claimedAt: new Date().toISOString() }
}

export async function assertOfficialHostContinuity(host, { hostLifecycle, resolveSelectedTarget }) {
  if (host.mode !== 'borrowed-selected') return null
  const target = await resolveSelectedTarget(host.target.cliPath)
  if (!sameOfficialTarget(host.target, target)) throw hostFailure('Borrowed DevTools installation changed; preserve it and stop the IDE lane.')
  const after = await hostLifecycle.inspectDevtoolsHost(target)
  if (JSON.stringify(officialHostIdentities(host.initial)) !== JSON.stringify(officialHostIdentities(after))) throw hostFailure('Borrowed DevTools host process changed; preserve it and stop the IDE lane.')
  return after
}

export async function releaseOfficialHost(host, context) {
  if (host.mode === 'borrowed-selected') return { hostAfter: await assertOfficialHostContinuity(host, context), borrowedResourcesPreserved: true }
  if (host.mode !== 'cold-owned') throw hostFailure('Unknown DevTools host ownership; no host was closed.')
  await context.hostLifecycle.quitClaimedDevtoolsHost(host)
  return { hostAfter: await context.hostLifecycle.inspectDevtoolsHost(host.target), borrowedResourcesPreserved: true }
}

export async function runChild(command, args, options, log) {
  // Both descriptors share this one file offset. There is no parent-side pipe
  // buffer to truncate when exit fires before stdout/stderr have closed.
  const file = await open(log, 'wx')
  let forward
  let timer
  let timedOut = false
  try {
    const child = spawn(command, args, { ...options, timeout: 0, stdio: ['ignore', file.fd, file.fd] })
    if (options.timeout > 0) timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, options.timeout)
    forward = () => child.kill('SIGTERM')
    process.once('SIGINT', forward); process.once('SIGTERM', forward)
    return await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => accept({ pid: child.pid, exitCode: code ?? 1, signal, ...(timedOut ? { timedOut: true } : {}) }))
    })
  } finally {
    clearTimeout(timer)
    if (forward) { process.off('SIGINT', forward); process.off('SIGTERM', forward) }
    await file.close()
  }
}

/** One global prerequisite observation prevents repeating a machine/profile
 * failure in every case. An exit code or a successful command alone cannot
 * establish login: the selected official CLI must return one explicit value. */
export function inspectOfficialLoginPreflight(output, result = {}) {
  const text = String(output ?? '')
  if (/IDE service port disabled|工具的服务端口已关闭|服务端口.*(?:未开启|关闭)/i.test(text)) {
    throw Object.assign(new Error('Selected official DevTools service port is disabled; no case assertions were executed.'), { code: 'CONFORMANCE_SERVICE_PORT_DISABLED', stage: 'connection' })
  }
  if (result.timedOut) throw Object.assign(new Error('Selected official DevTools prerequisite query timed out; no case assertions were executed.'), { code: 'CONFORMANCE_PREREQUISITE_TIMEOUT', stage: 'connection' })
  const states = [...text.matchAll(/"login"\s*:\s*(true|false)/gi)].map(match => match[1].toLowerCase() === 'true')
  if (!states.length || states.some(value => value !== states[0]) || result.exitCode !== 0) {
    throw Object.assign(new Error('Selected official DevTools did not return one successful, unambiguous login observation; inspect prerequisite.log.'), { code: 'CONFORMANCE_LOGIN_UNOBSERVED', stage: 'connection' })
  }
  if (!states[0]) throw Object.assign(new Error('Selected official DevTools profile requires login; no case assertions were executed.'), { code: 'CONFORMANCE_LOGIN_REQUIRED', stage: 'connection' })
  return { status: 'passed', login: true }
}

async function readRuntimeObservations(directory) {
  const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  return await Promise.all(names.filter(name => name.startsWith('runtime-')).sort().map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))))
}

async function main() {
  const options = parseOfficialArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('Usage: node scripts/conformance-devtools-runner.mjs (--case <id|source> ... | --focus failed-blocked|all) [--out directory] [--cli path] [--recipes registry.json --compiler-build compiler-build.json] [--borrow-selected-host] [--prepare-only] [--keep-checkout]\n')
    return
  }
  const index = JSON.parse(await readFile(join(root, 'docs/conformance/case-index-v1.json'), 'utf8'))
  if (options.recipes && !options.compilerBuild) throw new Error('Formal recipes require --compiler-build from a fresh pinned build; retained dist is diagnostic only.')
  const recipes = options.recipes ? await readConformanceRecipes({ root, index, file: options.recipes }) : new Map()
  const preparedRecipes = new Map()
  const compilerUses = new Map()
  const cases = index.cases.filter(item => options.focus === 'all' || options.focus === 'failed-blocked' && ['failed', 'blocked'].includes(item.status)
    || options.cases.includes(item.id) || options.cases.includes(item.source))
  if (!cases.length || options.cases.some(value => !cases.some(item => item.id === value || item.source === value))) throw new Error('Select at least one exact indexed case or --focus; unknown/substituted cases are not accepted.')
  if (git(vendor, ['rev-parse', 'HEAD']) !== baseline.compiler.commit || git(vendor, ['status', '--porcelain'])) throw new Error('vendor/weapp-vite must be clean at the fixed compiler commit before official reruns.')
  const out = options.out ?? join(root, 'artifacts/conformance-official', new Date().toISOString().replaceAll(/[:.]/g, '-'))
  const checkout = join(out, 'checkout')
  const report = { schemaVersion: 1, kind: 'wechat-devtools-rerun', status: 'blocked', baselineId: baseline.id, compilerCommit: baseline.compiler.commit,
    invocation: [process.execPath, ...process.argv.slice(1)], sourceCommit: git(root, ['rev-parse', 'HEAD']),
    startedAt: new Date().toISOString(), cases: [], resources: { owner: `conformance-${process.pid}`, machineLeaseAcquired: false, machineLeaseReleased: false,
      hostLeaseAcquired: false, hostLeaseReleased: false, ownedResourcesReleased: false, borrowedResourcesPreserved: true },
    boundary: 'Diagnostic official attempts only. Does not promote reviewed case status or replace official normalized trace/execution receipts.' }
  await mkdir(dirname(out), { recursive: true })
  await mkdir(out)
  const runnerInputs = await snapshotRunnerInputs(root, out)
  await json(join(out, 'plan.json'), { baseline, cases: cases.map(({ id, source, sourceSha256, status }) => ({ id, source, sourceSha256, previousStatus: status })) })
  const compilerBuild = options.compilerBuild ? await conformanceArtifactReference(root, options.compilerBuild) : null
  const compilerContext = compilerBuild ? await materializeCompilerUse({ root, directory: join(out, 'compiler-inputs'),
    checkout, compilerBuild, expectedCommit: baseline.compiler.commit, sourceRepo: vendor, observeMacros: true }) : null
  const instrumentation = { checkout, archive: join(out, 'instrumentation'), helper: join(out, 'runner-inputs/scripts/conformance-devtools-attempt.mjs'),
    ...(cases.length === 1 ? { selectedCase: { caseId: cases[0].id, caseSourcePath: cases[0].source, sourceSha256: cases[0].sourceSha256 } } : {}) }
  if (compilerContext) await instrumentOfficialCheckout({ ...instrumentation,
    inputProvenance: { dependencyMode: 'materialized archived compiler source, dependencies and fresh outputs', compilerBuild,
      boundary: 'Per-case compiler use guards and observed module loads are still required.' } })
  else await prepareOfficialCheckout({ vendor, ...instrumentation })
  const compilerPatches = compilerContext ? [...new Set([
    ...git(checkout, ['diff', '--name-only']).split('\n').filter(Boolean), 'e2e/utils/conformanceEvidence.mjs',
  ])] : []
  if (options.prepareOnly) {
    await json(join(out, 'run.json'), { ...report, status: 'prepared', endedAt: new Date().toISOString(), checkout, runnerInputs })
    process.stdout.write(`Official runner prepared: ${out}\n`)
    return
  }
  const helperRoot = compilerContext ? checkout : vendor
  const { register } = await import(pathToFileURL(join(helperRoot, 'node_modules/tsx/dist/esm/api/index.mjs')).href)
  const unregister = register()
  const [{ withMachineE2ELease }, hostLifecycle, selectionHelpers, ownership, scopeCleanup, publicOwnership] = await Promise.all([
    import(pathToFileURL(join(helperRoot, 'packages/devtools-runtime/src/lease/machine.ts')).href),
    import(pathToFileURL(join(helperRoot, 'e2e/utils/devtoolsHostLifecycle.ts')).href),
    import(pathToFileURL(join(helperRoot, 'e2e/utils/devtoolsSelection.ts')).href),
    import(pathToFileURL(join(helperRoot, 'e2e/utils/devtoolsProcessOwnership.ts')).href),
    import(pathToFileURL(join(helperRoot, 'e2e/utils/devtoolsScopeCleanup.ts')).href),
    import(pathToFileURL(join(helperRoot, 'packages/weapp-ide-cli/src/devtoolsProjectOwnership/index.ts')).href),
  ])
  const previousEnvironment = { ...process.env }
  Object.assign(process.env, { WEAPP_VITE_E2E_RUNTIME_PROVIDER: 'devtools', WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH: options.cliPath,
    WEAPP_IDE_CLI_PATH: options.cliPath, WEAPP_VITE_E2E_DEVTOOLS_CHANNEL: 'stable', WEAPP_VITE_E2E_ACCEPTED_DEVTOOLS_CHANNEL: 'stable',
    WEAPP_VITE_E2E_DEVTOOLS_VERSION: baseline.devtoolsVersion, WEAPP_VITE_E2E_ACCEPTED_DEVTOOLS_VERSION: baseline.devtoolsVersion,
    WEAPP_VITE_E2E_REQUIRE_OFFICIAL_LATEST: '0', WEAPP_IDE_REQUIRE_OFFICIAL_LATEST: '0' })
  let machineLease
  let host
  let journalPath
  let phase = 'lease'
  const stop = createOfficialStopController()
  try {
    stop.throwIfRequested()
    await withMachineE2ELease(async lease => {
      machineLease = lease
      report.resources.machineLeaseAcquired = true
      Object.assign(process.env, lease.environment)
      try {
        phase = 'selection'
        const target = await selectionHelpers.preflightSelectedWechatDevtools()
        const policy = selectionHelpers.readDevtoolsVersionPolicy()
        const selection = { selectedVersion: target.version, acceptedVersion: baseline.devtoolsVersion, packageVersion: target.version,
          baseLibraryVersion: baseline.baseLibraryVersion, compilerCommit: baseline.compiler.commit, installationId: target.installationId,
          queriedAt: policy.officialQueriedAt, source: policy.officialSource, officialVersionMatches: policy.officialVersionMatches,
          officialVersion: policy.officialVersion, selectedChannel: target.channel, versionPolicy: policy.mode, cliPath: target.cliPath }
        assertOfficialSelection(selection)
        report.selection = selection
        await json(join(out, 'selection.json'), selection)
        phase = 'lease'
        host = await acquireOfficialHost({ target, borrowSelectedHost: options.borrowSelectedHost, machineLease: lease, hostLifecycle,
          resolveSelectedTarget: selectionHelpers.resolveSelectedWechatDevtools })
        report.resources.hostLeaseAcquired = true
        report.hostBefore = host.initial
        await json(join(out, 'host-lease.json'), host)
        report.profilePreparation = await prepareSelectedDevtoolsProfile(target)
        journalPath = await ownership.createDevtoolsProjectJournal(undefined, join(out, 'journals'))
        Object.assign(process.env, { [hostLifecycle.DEVTOOLS_HOST_CLAIMED_ENV]: '1', [publicOwnership.MANAGED_PROJECT_JOURNAL_ENV]: journalPath })
        phase = 'connection'
        const prerequisiteLog = join(out, 'prerequisite.log')
        const prerequisite = await runChild(target.cliPath, ['islogin'], { cwd: checkout, env: process.env, timeout: 30_000 }, prerequisiteLog)
        report.prerequisite = { command: [target.cliPath, 'islogin'], recordedAt: new Date().toISOString(), ...prerequisite,
          log: 'prerequisite.log', assertionsExecuted: false }
        Object.assign(report.prerequisite, inspectOfficialLoginPreflight(await readFile(prerequisiteLog, 'utf8'), prerequisite))
        for (const item of cases) {
          stop.throwIfRequested()
          if (host.mode === 'borrowed-selected') {
            try { (report.borrowedHostChecks ??= []).push({ at: new Date().toISOString(), phase: 'before-case', caseId: item.id,
              snapshot: await assertOfficialHostContinuity(host, { hostLifecycle, resolveSelectedTarget: selectionHelpers.resolveSelectedWechatDevtools }) }) }
            catch (error) { report.resources.borrowedResourcesPreserved = false; throw error }
          }
          const directory = join(out, item.id)
          await mkdir(directory, { recursive: true })
          const source = join(checkout, item.source)
          const attempt = { schemaVersion: 1, kind: 'wechat-devtools-case-attempt', caseId: item.id, status: 'blocked', provider: 'wechat-devtools',
            baselineId: baseline.id, compilerCommit: baseline.compiler.commit,
            source: { path: item.source, sha256: item.sourceSha256, before: hash(await readFile(source)), after: item.sourceSha256 },
            run: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: 1 }, runtimeObservations: [],
            resources: { ...report.resources }, failures: [] }
          if (attempt.source.before !== item.sourceSha256) throw Object.assign(new Error(`Pinned case source changed before execution: ${item.source}`), { stage: 'source' })
          await selectOfficialCaseSharedRuntime({ checkout, archive: join(directory, 'instrumentation'),
            identity: { caseId: item.id, caseSourcePath: item.source, sourceSha256: item.sourceSha256 } })
          const scope = await lease.createChildScope({ cleanupKey: journalPath })
          const sessionDirectory = join(directory, 'sessions')
          const recipe = recipes.get(item.id)
          if (recipe) preparedRecipes.set(item.id, await prepareConformanceRecipe({ root, recipe, directory,
            ...(compilerContext ? { snapshotDirectory: 'runner-inputs' } : {}) }))
          const vitestArgs = [join(checkout, 'node_modules/vitest/vitest.mjs'), 'run', ...OFFICIAL_VITEST_EXECUTION_ARGS, '-c', './e2e/vitest.e2e.devtools.config.ts', item.source,
            '--reporter=default', '--reporter=json', '--reporter=./e2e/scripts/domAcceptanceReport/reporter.ts', `--outputFile.json=${join(directory, 'vitest.json')}`, '--hookTimeout=180000', '--testTimeout=300000']
          const command = process.platform === 'darwin' ? 'caffeinate' : process.execPath
          const args = process.platform === 'darwin' ? ['-dimsu', '--', process.execPath, ...vitestArgs] : vitestArgs
          attempt.run.command = [command, ...args]
          process.stdout.write(`Official case starting: ${item.id}\n`)
          try {
            phase = 'runner'
            const useContext = compilerContext ? forkCompilerUse({ context: compilerContext, directory: join(directory, 'compiler-use') }) : null
            const use = useContext ? await sealCompilerUse({ context: useContext, caseId: item.id, sourceSha256: item.sourceSha256,
              caseSourcePath: item.source, patches: compilerPatches, allowedModuleRoots: [join(out, 'runner-inputs'),
                ...(recipe ? [join(directory, 'runner-inputs')] : [])] }) : null
            const result = await runChild(command, args, { cwd: checkout, env: createOfficialCaseEnvironment(item.source, { ...process.env, ...scope.environment,
              ...use?.environment,
              WEAPP_CONTAINER_CONFORMANCE_SESSION_DIR: sessionDirectory, WEAPP_CONTAINER_CONFORMANCE_INSTALLATION_ID: target.installationId,
              WEAPP_CONTAINER_CONFORMANCE_RECIPE: preparedRecipes.get(item.id)?.runtimeRecipePath ?? '',
              WEAPP_CONTAINER_CONFORMANCE_EVENTS: join(directory, 'observed-events.json'),
              WEAPP_CONTAINER_CONFORMANCE_ROOT: root,
              WEAPP_CONTAINER_CONFORMANCE_COMPILER_BUILD: compilerBuild ? JSON.stringify(compilerBuild) : '',
              WEAPP_CONTAINER_CONFORMANCE_CASE: JSON.stringify({ caseId: item.id, sourceSha256: item.sourceSha256, caseSourcePath: item.source }),
              WEAPP_CONTAINER_CONFORMANCE_FIXTURE_DIR: compilerContext && recipe ? join(directory, 'fixture-capture') : '',
              WEAPP_CONTAINER_CONFORMANCE_OBSERVER_FAILURES: compilerContext && recipe ? join(directory, 'observer-observation.json') : '',
              // The selected parent already observed islogin successfully.
              // Avoid opening a separate global-setup login fixture before
              // the indexed case supplies its actual runtime observation.
              WEAPP_VITE_E2E_SKIP_DEVTOOLS_LOGIN_CHECK: '1',
              WEAPP_VITE_E2E_DOM_REPORT_PATH: join(directory, 'dom-acceptance.json'), WEAPP_VITE_E2E_IDE_WARNING_REPORT_PATH: join(directory, 'ide-warnings.json') }) }, join(directory, 'official.log'))
            attempt.run.exitCode = result.exitCode
            attempt.run.pid = result.pid
            if (result.signal) attempt.run.signal = result.signal
            if (result.timedOut) attempt.run.timedOut = true
            if (compilerContext && recipe) {
              const observed = await readFile(join(directory, 'observer-observation.json'), 'utf8').then(JSON.parse).catch(() => null)
              if (observed?.kind !== 'conformance-observer-observation' || observed.caseId !== item.id || observed.sourceSha256 !== item.sourceSha256 || !Array.isArray(observed.failures)) {
                attempt.failures.push(classifyConformanceFailure(Object.assign(new Error('Case evidence observation did not complete in the owned worker.'),
                  { code: 'CONFORMANCE_OBSERVER_OBSERVATION_INCOMPLETE' }), { stage: 'runner' }))
              } else for (const failure of observed.failures) attempt.failures.push(classifyConformanceFailure(
                Object.assign(new Error(failure.message), { code: failure.code }), { stage: 'runner' }))
            }
            if (useContext) {
              const used = await finishCompilerUse({ context: useContext, processResult: result })
              compilerUses.set(item.id, used.reference)
              if (used.attestation.status !== 'used') attempt.failures.push(classifyConformanceFailure(
                new Error(`Fresh compiler consumption was not verified: ${used.attestation.failure}`), { stage: 'runner' }))
            }
            const captures = await readRuntimeObservations(sessionDirectory)
            attempt.runtimeObservations = captures.filter(value => value.status === 'passed').map(({ schemaVersion: _schema, kind: _kind, status: _status, ...observation }) => observation)
            const mismatch = captures.find(value => value.status !== 'passed')
            if (mismatch) attempt.failures.push(classifyConformanceFailure(Object.assign(new Error(mismatch.error.message), { code: mismatch.error.code }), { stage: 'baseline' }))
            else if (!attempt.runtimeObservations.length) attempt.failures.push(classifyConformanceFailure(Object.assign(new Error('No actual Tool and wx.getSystemInfoSync SDK observation reached the fixed baseline.'), { code: 'CONFORMANCE_RUNTIME_BASELINE_UNOBSERVED' })))
            const suite = await readFile(join(directory, 'vitest.json'), 'utf8').then(JSON.parse).catch(() => null)
            const exactSources = suite?.testResults?.filter(value => value.name?.replaceAll('\\', '/') === source.replaceAll('\\', '/')) ?? []
            const sourcePassed = suite?.success === true && exactSources.length === 1 && exactSources[0].status === 'passed'
              && exactSources[0].assertionResults?.length > 0 && exactSources[0].assertionResults.every(value => value.status === 'passed')
            if (result.exitCode !== 0) {
              const failed = suite?.testResults?.flatMap(result => result.assertionResults ?? []).filter(result => result.status === 'failed') ?? []
              const details = failed.flatMap(result => result.failureMessages ?? []).join('\n') || await readFile(join(directory, 'official.log'), 'utf8')
              attempt.failures.push(classifyConformanceFailure(new Error(details.slice(-32_000)), { stage: failed.length && attempt.runtimeObservations.length ? 'assertion' : 'connection' }))
            } else if (!sourcePassed) attempt.failures.push(classifyConformanceFailure(Object.assign(new Error('Runner JSON is missing exactly this passed source and its non-skipped assertions.'), { code: 'CONFORMANCE_ASSERTION_COVERAGE_INCOMPLETE' })))
            else if (!attempt.failures.length) attempt.status = 'passed'
          } catch (error) { attempt.failures.push(classifyConformanceFailure(error, { stage: phase })) }
          finally {
            Object.assign(process.env, lease.environment)
            try { await scopeCleanup.cleanupDevtoolsCommandScope(scope, journalPath); attempt.resources.ownedResourcesReleased = true }
            catch (error) { attempt.failures.push(classifyConformanceFailure(error, { stage: 'cleanup' })) }
            if (host.mode === 'borrowed-selected') {
              try { (report.borrowedHostChecks ??= []).push({ at: new Date().toISOString(), phase: 'after-case', caseId: item.id,
                snapshot: await assertOfficialHostContinuity(host, { hostLifecycle, resolveSelectedTarget: selectionHelpers.resolveSelectedWechatDevtools }) }) }
              catch (error) { report.resources.borrowedResourcesPreserved = false; attempt.failures.push(classifyConformanceFailure(error, { stage: 'cleanup' })) }
            }
            attempt.source.after = hash(await readFile(source))
            if (attempt.source.after !== item.sourceSha256) attempt.failures.push(classifyConformanceFailure(new Error('Pinned official assertion source changed during execution.'), { stage: 'source' }))
            attempt.run.endedAt = new Date().toISOString()
            if (attempt.failures.length) attempt.status = attempt.failures.some(value => value.status === 'blocked') ? 'blocked' : 'failed'
            report.cases.push(attempt)
            await json(join(directory, 'attempt.json'), attempt)
            process.stdout.write(`Official case ${attempt.status}: ${item.id}\n`)
          }
          // A cleanup failure owns the machine until evidence has been inspected;
          // do not launch another case over unresolved resources.
          if (attempt.failures.some(value => value.stage === 'cleanup')) break
          stop.throwIfRequested()
        }
      } catch (error) {
        // Preserve the phase that failed even while finally performs cleanup.
        // A selection or lease failure is not a cleanup failure.
        error.stage ??= phase
        throw error
      } finally {
        const cleanupErrors = []
        if (journalPath) {
          try {
            await ownership.cleanupOwnedDevtoolsProcesses({ journalPath, scope: 'journal' })
            report.projectRecords = await publicOwnership.readManagedWechatProjectRecords(journalPath)
            report.resources.ownedResourcesReleased = report.projectRecords.every(record => record.state === 'released')
          } catch (error) { cleanupErrors.push(error) }
        } else report.resources.ownedResourcesReleased = true
        // Each disposer gets an attempt even if journal cleanup failed.
        if (host) {
          try {
            const released = await releaseOfficialHost(host, { hostLifecycle, resolveSelectedTarget: selectionHelpers.resolveSelectedWechatDevtools })
            report.resources.hostLeaseReleased = true
            report.hostAfter = released.hostAfter
            report.resources.borrowedResourcesPreserved &&= released.borrowedResourcesPreserved
          }
          catch (error) { if (host.mode === 'borrowed-selected') report.resources.borrowedResourcesPreserved = false; cleanupErrors.push(error) }
        }
        if (cleanupErrors.length) throw Object.assign(new AggregateError(cleanupErrors, cleanupErrors.map(error => error.message ?? String(error)).join('; ')), { stage: 'cleanup' })
      }
    })
  } catch (error) {
    report.failure = classifyConformanceFailure(error, { stage: error.stage ?? phase })
    if (error.stopRequested) report.stopRequested = error.stopRequested
    if (!report.resources.machineLeaseAcquired) {
      const owner = await readFile(join(homedir(), '.local/state/weapp-agent/machine-e2e/owner.json'), 'utf8').then(JSON.parse).catch(() => null)
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        let live = false
        try { process.kill(owner.pid, 0); live = true } catch (error) { live = error.code !== 'ESRCH' }
        report.blockingLease = { ownerPid: owner.pid, live, ownership: 'another-task-or-unknown', preserved: true }
      }
    }
    // A preflight blocker belongs to every requested case, but is diagnostic
    // and does not change that case's reviewed official status.
    for (const item of cases.filter(item => !report.cases.some(attempt => attempt.caseId === item.id))) {
      const sourceHash = hash(await readFile(join(checkout, item.source)))
      report.cases.push({ schemaVersion: 1, kind: 'wechat-devtools-case-attempt', caseId: item.id, status: 'blocked', provider: 'wechat-devtools',
        baselineId: baseline.id, compilerCommit: baseline.compiler.commit,
        source: { path: item.source, sha256: item.sourceSha256, before: sourceHash, after: sourceHash },
        run: { startedAt: report.startedAt, endedAt: new Date().toISOString(), exitCode: 1, assertionsExecuted: false }, runtimeObservations: [],
        resources: { ...report.resources }, failures: [report.failure] })
    }
  }
  finally {
    stop.dispose()
    report.resources.machineLeaseReleased = machineLease?.released === true
    if (!machineLease) report.resources.ownedResourcesReleased = true
    report.endedAt = new Date().toISOString()
    report.status = report.failure ? 'blocked' : report.cases.length === cases.length && report.cases.every(item => item.status === 'passed') ? 'passed' : report.cases.some(item => item.status === 'failed') ? 'failed' : 'blocked'
    for (const attempt of report.cases) {
      attempt.resources = { ...report.resources }
      const checked = inspectConformanceAttempt(attempt)
      if (checked.status !== 'passed') { (report.validationErrors ??= {})[attempt.caseId] = checked.errors; report.status = 'blocked' }
      await json(join(out, attempt.caseId, 'attempt.json'), attempt)
    }
    const oracleCases = []
    const executionRecipes = []
    for (const attempt of report.cases.filter(attempt => attempt.status === 'passed')) {
      const recipe = preparedRecipes.get(attempt.caseId)
      if (!recipe) continue
      try {
        const handoff = await readOfficialFixtureHandoff({ root, directory: join(out, attempt.caseId),
          caseId: attempt.caseId, sourceSha256: attempt.source.sha256 })
        const built = await finalizeStaticFixtureBuild({ root, directory: join(out, attempt.caseId, 'fixture-build'),
          ...handoff, compilerBuild,
          compilerUse: compilerUses.get(attempt.caseId), expectedCommit: baseline.compiler.commit, fixtureId: recipe.fixtureValue?.id })
        const formal = await finalizeOfficialConformance({ root, directory: join(out, attempt.caseId), attempt,
          selectionPath: join(out, 'selection.json'), recipe, compilerBuild, compilerUse: compilerUses.get(attempt.caseId), fixtureBuild: built.fixtureBuild })
        oracleCases.push({ caseId: formal.caseId, sourceSha256: formal.sourceSha256, ...formal.oracle })
        executionRecipes.push(formal.executionRecipe)
      } catch (error) {
        (report.formalFailures ??= {})[attempt.caseId] = classifyConformanceFailure(error)
        report.status = 'blocked'
      }
    }
    await json(join(out, 'oracle-set.json'), { schemaVersion: 1, kind: 'wechat-devtools-oracle-set', baselineId: baseline.id, cases: oracleCases })
    await json(join(out, 'execution-recipes.json'), { schemaVersion: 1, kind: 'weapp-container-case-recipes',
      baselineId: baseline.id, compilerCommit: baseline.compiler.commit, recipes: executionRecipes })
    await json(join(out, 'run.json'), report)
    await json(join(out, 'vendor-after.json'), { commit: git(vendor, ['rev-parse', 'HEAD']), status: git(vendor, ['status', '--porcelain']), preserved: true })
    const artifacts = []
    const recordArtifacts = async (directory, prefix = '') => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'checkout' || entry.name === 'journals') continue
        const name = prefix + entry.name
        if (entry.isDirectory()) await recordArtifacts(join(directory, entry.name), name + '/')
        else if (entry.isFile()) { const bytes = await readFile(join(directory, entry.name)); artifacts.push({ path: name, sha256: hash(bytes), bytes: bytes.length }) }
      }
    }
    await recordArtifacts(out)
    await json(join(out, 'artifacts.json'), { schemaVersion: 1, artifacts, runnerInputs })
    if (!options.keepCheckout && report.resources.ownedResourcesReleased && (!host || report.resources.hostLeaseReleased)) await rm(checkout, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key]
    Object.assign(process.env, previousEnvironment)
    unregister()
    process.stdout.write(`Official rerun ${report.status}: ${relative(root, join(out, 'run.json'))}\n`)
    if (report.status !== 'passed') process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main() } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 }
}
