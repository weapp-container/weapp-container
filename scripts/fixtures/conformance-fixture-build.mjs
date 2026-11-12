/** TEST ONLY. These explicitly synthetic offline receipts execute no CLI,
 * packer, DevTools or native target. They exercise full real-pin admission
 * logic, while conformance-fixture-build.test.mjs separately runs actual tiny
 * compiler/packer children. Never import this from a production runner. */
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archiveCompilerBuildBytes } from '../conformance-compiler-build.mjs'
import { reviewedFixturePackerClosure } from '../conformance-fixture-build.mjs'
import { createSyntheticTemplateFixtureState } from './conformance-template-fixture-build.mjs'

const shared = new Map()
// TEST ONLY: reuse large immutable synthetic seed inputs while constructing
// the 172-case validator fixture. Production readers still hash every proof.
const syntheticSeeds = new Map()
const modulePath = fileURLToPath(new URL('../conformance-fixture-build.mjs', import.meta.url))
const preloadPath = fileURLToPath(new URL('../conformance-fixture-packer-preload.mjs', import.meta.url))
const CLI = 'packages/weapp-vite/bin/weapp-vite.js', PACKER = 'tools/container-manifest/bin/container-pack.mjs'

export function createSyntheticFixtureBuild({ root, directory, compilerBuild, compilerUse, fixture, fixtureValue,
  resources, runtimeObservation, expectedCommit, fixtureCliPath = CLI }) {
  const requestedRoot = resolve(root); root = realpathSync(root); directory = resolve(root, relative(requestedRoot, resolve(directory)))
  const put = bytes => archiveCompilerBuildBytes({ root, directory, bytes: typeof bytes === 'string' || Buffer.isBuffer(bytes) ? bytes : JSON.stringify(bytes) })
  const read = ref => JSON.parse(readFileSync(join(root, ref.path)))
  let use = read(compilerUse), runtime = runtimeObservation.path ? read(runtimeObservation) : runtimeObservation
  fixtureValue ??= fixture?.manifest ? fixture : read(fixture)
  const fixtureReference = fixture?.path ? fixture : put(JSON.stringify(fixtureValue, null, 2) + '\n')
  const seedKey = JSON.stringify([root, ...[compilerBuild, use.before].map(ref => [ref.path, ref.sha256, ref.bytes])])
  let seed = syntheticSeeds.get(seedKey)
  if (!seed) {
    seed = { commit: read(compilerBuild).source.commit, members: new Map(read(use.before).members.map(item => [item.path, item])) }
    syntheticSeeds.set(seedKey, seed)
  }
  expectedCommit ??= seed.commit
  const at = runtime.recordedAt, cliPid = use.process.pid + 1, packerPid = use.process.pid + 2
  const existing = use.logs.flatMap(ref => readFileSync(join(root, ref.path), 'utf8').trim().split('\n').map(line => JSON.parse(line)))
  const rootStartup = existing.find(event => event.kind === 'start' && event.pid === use.process.pid && event.threadId === 0)
  if (!rootStartup?.argv?.[0]) throw new Error('Synthetic fixture reader test needs its original consumer Node identity')
  const buildCommand = [rootStartup.argv[0], join(use.checkout, fixtureCliPath), 'build', runtime.projectPath]
  const members = seed.members
  const entry = existing.find(event => event.kind === 'load' && event.classification === 'bound' && members.get(event.path)?.origin === 'output')
  if (!entry) throw new Error('Synthetic fixture reader test needs an archived synthetic compiler load')
  const ownerId = randomUUID(), projectConfig = put({ miniprogramRoot: 'dist/' })
  const generated = [
    { path: 'app.js', kind: 'file', artifact: put('// SYNTHETIC READER FIXTURE; NO COMPILER RAN\nApp({});') },
    { path: 'app.json', kind: 'file', artifact: put({ pages: ['pages/index/index'] }) },
    { path: 'pages/index/index.js', kind: 'file', artifact: put('Page({});') },
    { path: 'pages/index/index.wxml', kind: 'file', artifact: put('<view/>') },
  ].sort((a, b) => a.path.localeCompare(b.path))
  const sources = [{ path: 'project.config.json', kind: 'file', artifact: projectConfig }, { ...generated[0], path: 'src/app.js' }]
  let build = { status: 'built', action: 'static-build', command: buildCommand, cwd: use.checkout, projectPath: runtime.projectPath,
    outputRoot: join(runtime.projectPath, 'dist'), outputRelative: 'dist', projectConfig, outputAbsent: true,
    environment: { NODE_OPTIONS: use.nodeOptions, NODE_PATH: '', WEAPP_CONTAINER_COMPILER_USE_CONFIG: '/SYNTHETIC-NOT-EXECUTED/compiler-use-config.json' },
    sourceBefore: sources, sourceAfter: sources, generatedSupport: [], startedAt: at, endedAt: at,
    pid: cliPid, exitCode: 0, signal: null, outputCaptured: true, observer: { pid: use.process.pid, threadId: 0 },
    stdout: put('SYNTHETIC OFFLINE FIXTURE: no CLI was executed.\n'), stderr: put(''), generated }
  const template = createSyntheticTemplateFixtureState({ root, put, read, compilerBuild, use, runtime, build })
  if (template) { use = template.use; runtime = template.runtime; build = template.build }
  const base = { runId: use.ownerId, caseId: use.caseId, sourceSha256: use.sourceSha256, caseSourcePath: use.caseSourcePath,
    pid: cliPid, ppid: use.process.pid, threadId: 0, isMainThread: true, at }
  const cliLog = put([
    { ...base, kind: 'start', argv: build.command, ...(template ? { cwd: build.cwd } : {}), execArgv: [], nodeOptions: use.nodeOptions, preloadSha256: use.preload.sha256 },
    { ...entry, ...base },
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const modifiedUse = { ...use, logs: [...use.logs, cliLog, ...(template ? [template.bridgeLog] : [])] }
  const modifiedCompilerUse = put(JSON.stringify(modifiedUse, null, 2) + '\n')
  const checkpointValue = { schemaVersion: 1, kind: 'weapp-container.static-generated-checkpoint', profile: 'static-cli-v1', status: 'captured', ownerId,
    runId: use.ownerId, caseId: use.caseId, sourceSha256: use.sourceSha256, caseSourcePath: use.caseSourcePath, compilerBuild,
    consumerGuard: use.before, checkpointId: 'static-initial', observer: build.observer, recorderDirectory: directory,
    staticProfileInputs: ['conformance-static-cli-profile.mjs', 'conformance-fixture-project.mjs'].map(name => ({ path: `scripts/${name}`, artifact: put(readFileSync(new URL(`../${name}`, import.meta.url))) })),
    runtimeObservation: template?.runtimeObservation ?? (runtimeObservation.path ? runtimeObservation : put(runtime)), capturedAt: at, cliRelativePath: fixtureCliPath, build,
    ...(template?.checkpointFields ?? {}) }
  const checkpoint = put(JSON.stringify(checkpointValue, null, 2) + '\n')
  const recorderSummary = put({ schemaVersion: 1, kind: 'weapp-container.static-recorder-summary', profile: 'static-cli-v1', status: 'complete',
    ownerId, runId: use.ownerId, caseId: use.caseId, sourceSha256: use.sourceSha256, checkpoint,
    observedCliSpawns: 1, recordingEndedAt: at, actions: [build], finalGuard: 'owned-project-cleaned-after-captured-generation',
    ...(template?.summaryFields(checkpointValue) ?? {}) })
  const key = JSON.stringify([root, directory])
  let closure = shared.get(key)
  if (!closure) {
    closure = { modules: reviewedFixturePackerClosure().map(item => ({ path: item.path, artifact: put(item.bytes) })),
      preload: put(readFileSync(preloadPath)), producer: put(readFileSync(modulePath)) }
    shared.set(key, closure)
  }
  const executor = join(directory, 'SYNTHETIC-NOT-EXECUTED', 'packer-executor'), input = join(dirname(executor), 'packer-input'), output = join(dirname(executor), 'packer-output')
  const command = [process.execPath, '--import', join(dirname(executor), 'packer-preload.mjs'), join(executor, PACKER), input, '--out', output, '--compiler-commit', expectedCommit]
  const config = put({ log: join(dirname(executor), 'packer-loads.jsonl'), files: closure.modules.map(item => ({ file: join(executor, item.path), sha256: item.artifact.sha256, bytes: item.artifact.bytes })) })
  const packerEntry = closure.modules.find(item => item.path === PACKER).artifact
  const loads = put(JSON.stringify({ file: join(executor, PACKER), sha256: packerEntry.sha256, bytes: packerEntry.bytes,
    pid: packerPid, at, sourceSha256: packerEntry.sha256 }) + '\n')
  const before = put(generated)
  const outputFiles = [{ path: 'manifest.json', kind: 'file', artifact: put(JSON.stringify(fixtureValue.manifest, null, 2) + '\n') },
    ...Object.entries(resources).map(([sha256, artifact]) => ({ path: `blobs/sha256/${sha256}`, kind: 'file', artifact }))]
  const value = { schemaVersion: 1, kind: 'weapp-container.fixture-build', profile: 'static-cli-v1', status: 'built', ownerId,
    caseId: use.caseId, sourceSha256: use.sourceSha256, compilerBuild, compilerUse: modifiedCompilerUse, checkpoint, recorderSummary,
    producer: closure.producer, ...(template ? { producerProfile: template.producerProfile, producerInputs: template.producerInputs } : {}), staticProfileInputs: ['conformance-static-cli-profile.mjs', 'conformance-fixture-project.mjs'].map(name => ({ path: `scripts/${name}`, artifact: put(readFileSync(new URL(`../${name}`, import.meta.url))) })), packer: { ...closure, executor, input, output, config, command, loads,
      run: { exitCode: 0, signal: null, pid: packerPid, timedOut: false, startedAt: at, endedAt: at,
        stdout: put('SYNTHETIC OFFLINE FIXTURE: no packer was executed.\n'), stderr: put('') } },
    before, after: before, outputFiles, fixture: fixtureReference, resources }
  delete value.packer.producer
  const reference = put(JSON.stringify(value, null, 2) + '\n')
  return { reference, fixtureBuild: reference, compilerUse: modifiedCompilerUse, fixture: fixtureReference, fixtureValue, resources, attestation: value, ...(template ? { runtimeObservation: template.runtimeObservation } : {}) }
}
