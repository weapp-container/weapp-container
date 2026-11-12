/** TEST ONLY. Fabricate explicit offline template receipts for the strict
 * reader. No CLI, SDK, loader, filesystem lifecycle or packer executes here. */
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compilerUseMemberClosure } from '../conformance-compiler-use.mjs'
import { parseStaticCliInvocation, templateStaticCase } from '../conformance-static-cli-profile.mjs'
import { TEMPLATE_PRODUCER_PROFILE, templateProducerGuards, templateProducerInvocation } from '../conformance-fixture-project.mjs'
import { instrumentSnapshotAutomator, snapshotConfigBytes, snapshotLaunchConfigurationBytes, snapshotClosureDifference,
  TEMPLATE_LAUNCH_CONFIGURATION, TEMPLATE_LAUNCH_HELPER } from '../conformance-snapshot-transport.mjs'

const producerFiles = ['conformance-github-producer.mjs', 'conformance-wxml-producer.mjs',
  'conformance-snapshot-transport.mjs', 'conformance-temporary-project-producer.mjs', 'conformance-issue1034-producer.mjs']
const directoryIdentity = inode => ({ device: '1', inode: String(inode), birthtimeNs: '1700000000000000000' })

export function createSyntheticTemplateFixtureState({ root, put, read, compilerBuild, use, runtime, build }) {
  const identity = templateStaticCase(use)
  if (!identity) return null
  const originalMembers = compilerUseMemberClosure(read(compilerBuild), ref => readFileSync(join(root, ref.path)))
  const originals = new Map(originalMembers.map(item => [item.path, item]))
  const members = new Map(read(use.before).members.map(item => [item.path, item]))
  const guards = templateProducerGuards(use).map(guard => {
    const original = originals.get(guard.path)?.artifact
    if (!original || original.sha256 !== guard.sha256) throw new Error('Synthetic template needs its actual pinned original helper bytes')
    const observed = guard.path === 'e2e/utils/automator.ts'
      ? put(instrumentSnapshotAutomator(readFileSync(join(root, original.path), 'utf8'))) : original
    if (guard.path === 'e2e/utils/automator.ts') members.set(guard.path, { path: guard.path, kind: 'file',
      sha256: observed.sha256, bytes: observed.bytes, origin: 'patch', executable: false })
    return { path: guard.path, original, observed }
  })
  const automator = guards.find(item => item.path === 'e2e/utils/automator.ts')
  const before = put({ ownerId: use.ownerId, checkout: use.checkout,
    members: [...members.values()].sort((a, b) => a.path.localeCompare(b.path)) })
  use = { ...use, patches: [{ path: automator.path, artifact: automator.observed, executable: false }], before, after: before,
    config: put({ ...read(use.config), membersReference: before }) }
  const sourceRoot = join(use.checkout, identity.templateRelativePath)
  const command = [build.command[0], build.command[1], 'build', sourceRoot, '--platform', 'weapp', '--skipNpm']
  const invocation = parseStaticCliInvocation({ args: command.slice(1), cliPath: command[1], cwd: sourceRoot, checkout: use.checkout, ...use })
  const prefix = identity.templateRelativePath + '/'
  const sources = [...members.values()].filter(item => item.path.startsWith(prefix)).map(item => {
    const path = item.path.slice(prefix.length), original = originals.get(item.path)
    if (item.kind === 'file') return { path, kind: 'file', artifact: original.artifact }
    const target = item.kind === 'link' ? resolve(use.checkout, item.target) : resolve(dirname(join(use.checkout, item.path)), item.target)
    return { path, kind: 'consumer-link', target: relative(use.checkout, target).replaceAll('\\', '/'), consumerGuard: before }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const projectConfig = sources.find(item => item.path === invocation.sourceConfigRelative).artifact
  const projectOutput = [...build.generated.map(item => ({ ...item, path: 'weapp/dist/' + item.path })),
    ...sources.filter(item => item.path.startsWith('config/weapp/')).map(item => ({ ...item, path: 'weapp/' + item.path.slice('config/weapp/'.length) }))]
    .sort((a, b) => a.path.localeCompare(b.path))
  build = { ...build, command, cwd: sourceRoot, projectPath: sourceRoot, sourceRoot,
    outputRoot: invocation.generatedRoot, outputRelative: invocation.generatedRelative,
    sourceOutputRelative: invocation.outputContainerRelative, runtimeProjectPath: invocation.runtimeProjectPath,
    staticCliProfile: invocation, producerProfile: templateProducerInvocation({ args: command.slice(1), cliPath: command[1], cwd: sourceRoot, checkout: use.checkout, ...use }),
    sourceBefore: sources, sourceAfter: sources, projectConfig, runtimeProjectConfig: projectConfig, projectOutput,
    sourceRootIdentity: directoryIdentity(101), runtimeRootIdentity: directoryIdentity(102) }
  const runtimeProjectPath = join(use.checkout, '.tmp/e2e-ide-bridge-projects', identity.templateRelativePath.includes('-sfc-') ? '53594e5448534643' : '53594e544e415456')
  runtime = { ...runtime, projectPath: runtimeProjectPath }
  const projectSource = projectOutput.filter(item => !item.path.startsWith('weapp/dist/')).map(item => ({ ...item, path: item.path.slice('weapp/'.length) }))
  const snapshotFiles = [...build.generated, ...[...snapshotConfigBytes({ sourceFiles: projectSource,
    load: ref => readFileSync(join(root, ref.path)), allowMissingPrivateConfig: true })].map(([path, bytes]) => ({ path, kind: 'file', artifact: put(bytes) }))]
    .sort((a, b) => a.path.localeCompare(b.path))
  const transaction = { schemaVersion: 1, kind: 'weapp-container.template-producer-transaction', profile: TEMPLATE_PRODUCER_PROFILE,
    buildPid: build.pid, observer: build.observer, sourceRoot, sourceProjectPath: build.runtimeProjectPath,
    generatedRoot: build.outputRoot, generatedProjectIdentity: build.runtimeRootIdentity, runtimeProjectPath, runtimeRoot: runtimeProjectPath,
    cliPath: '/SYNTHETIC-NOT-EXECUTED/selected-devtools/cli', capturedAt: runtime.recordedAt,
    launchProjectConfig: structuredClone(TEMPLATE_LAUNCH_CONFIGURATION),
    launchConfigurationOrigin: 'pinned-template-helper-input-and-forced-sdk',
    launchHelper: { path: TEMPLATE_LAUNCH_HELPER.path, artifact: originals.get(TEMPLATE_LAUNCH_HELPER.path).artifact },
    producer: put(readFileSync(new URL('../conformance-fixture-project.mjs', import.meta.url))),
    transport: put(readFileSync(new URL('../conformance-snapshot-transport.mjs', import.meta.url))), guards,
    sourceRootIdentity: build.sourceRootIdentity, runtimeRootIdentity: directoryIdentity(103),
    postHelperSource: sources, postHelperGenerated: build.generated, postHelperProjectOutput: projectOutput, snapshotFiles }
  const transactionReference = put(transaction), at = runtime.recordedAt
  const runtimeObservation = put({ schemaVersion: 1, kind: 'wechat-devtools-runtime-baseline', status: 'passed', ...runtime })
  const postLaunchFiles = [...snapshotLaunchConfigurationBytes(transaction, ref => readFileSync(join(root, ref.path)))]
    .map(([path, bytes]) => ({ path, kind: 'file', artifact: put(bytes) }))
  const closure = (root, files) => ({ root, expected: files, actual: files, diff: snapshotClosureDifference(files, files), passed: true })
  const physical = (root, value) => ({ root, expected: value, before: value, after: value, passed: true })
  const generationGuards = put({ schemaVersion: 1, kind: 'weapp-container.snapshot-generation-guards',
    transaction: transactionReference, observer: build.observer, captureStartedAt: at, captureCompletedAt: at,
    runtimePhase: 'post-launch', status: 'passed', launchConfigurationExpected: postLaunchFiles,
    closures: { source: closure(sourceRoot, sources), generated: closure(build.outputRoot, build.generated),
      runtime: closure(runtimeProjectPath, postLaunchFiles), project: closure(resolve(build.runtimeProjectPath, '..'), projectOutput) },
    identities: { source: physical(sourceRoot, transaction.sourceRootIdentity), runtime: physical(runtimeProjectPath, transaction.runtimeRootIdentity),
      project: physical(build.runtimeProjectPath, transaction.generatedProjectIdentity) } })
  const runtimeConfiguration = put({ schemaVersion: 1, kind: 'weapp-container.snapshot-runtime-configuration',
    profile: 'template-native-launch-config-v1', phase: 'sdk-checkpoint', transaction: transactionReference, observer: build.observer,
    runtimeProjectPath, runtimeRootIdentity: transaction.runtimeRootIdentity, configuration: transaction.launchProjectConfig,
    helper: transaction.launchHelper, beforeFiles: snapshotFiles, afterFiles: postLaunchFiles, generationGuards, runtimeObservation, capturedAt: at })
  const config = snapshotFiles.find(item => item.path === 'project.config.json').artifact
  const loaderPath = 'node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs'
  const loader = members.get(loaderPath), bridgePath = 'e2e/utils/automator.cli-bridge.ts', bridge = members.get(bridgePath)
  if (!loader || !bridge) throw new Error('Synthetic template needs the reviewed inert tsx/bridge member closure')
  const base = { runId: use.ownerId, caseId: use.caseId, caseSourcePath: use.caseSourcePath, sourceSha256: use.sourceSha256,
    pid: use.process.pid + 3, ppid: use.process.pid, threadId: 0, isMainThread: true, at }
  const boundLoad = (path, item) => ({ ...base, kind: 'load', file: join(use.checkout, path), path,
    sha256: item.sha256, bytes: item.bytes, loadedSourceSha256: item.sha256, format: 'module', classification: 'bound' })
  const bridgeLog = put([
    { ...base, kind: 'start', cwd: use.checkout, argv: [command[0], join(use.checkout, bridgePath), JSON.stringify({ projectPath: runtimeProjectPath,
      cliPath: transaction.cliPath, projectConfig: transaction.launchProjectConfig })], execArgv: ['--import', 'tsx'],
      nodeOptions: use.nodeOptions, preloadSha256: use.preload.sha256,
      bridgeProject: { projectPath: runtimeProjectPath, configFile: join(runtimeProjectPath, 'project.config.json'),
        configSource: readFileSync(join(root, config.path), 'utf8'), sha256: config.sha256, bytes: config.bytes } },
    { ...base, kind: 'resolve', specifier: 'tsx', url: pathToFileURL(join(use.checkout, loaderPath)).href, parentURL: pathToFileURL(use.checkout + '/').href },
    boundLoad(loaderPath, loader), boundLoad(bridgePath, bridge),
  ].map(item => JSON.stringify(item)).join('\n') + '\n')
  return { use, runtime, build, bridgeLog,
    runtimeObservation,
    producerProfile: TEMPLATE_PRODUCER_PROFILE,
    producerInputs: producerFiles.map(name => ({ path: 'scripts/' + name, artifact: put(readFileSync(new URL('../' + name, import.meta.url))) })),
    checkpointFields: { producerTransaction: transactionReference, runtimeGenerated: build.generated,
      sourceRootIdentity: transaction.sourceRootIdentity, runtimeRootIdentity: transaction.runtimeRootIdentity,
      generationGuards, runtimeConfiguration },
    summaryFields(checkpoint) {
      const candidate = put({ schemaVersion: 1, kind: 'weapp-container.snapshot-producer-candidate', profile: TEMPLATE_PRODUCER_PROFILE,
        ownerId: checkpoint.ownerId, runId: use.ownerId, caseId: use.caseId, caseSourcePath: use.caseSourcePath, sourceSha256: use.sourceSha256,
        observer: build.observer, consumerGuard: use.before, compilerBuild, build: put(build), observation: {
          sourceProjectPath: build.runtimeProjectPath, generatedRoot: build.outputRoot, projectPath: runtimeProjectPath,
          runtimeRoot: runtimeProjectPath, cliPath: transaction.cliPath }, captureStartedAt: at, captureCompletedAt: at, complete: true, transaction: transactionReference })
      const validation = put({ schemaVersion: 1, kind: 'weapp-container.snapshot-producer-validation', status: 'validated', candidate,
        transaction: transactionReference, completedAt: at })
      const beforeCleanup = put({ schemaVersion: 1, kind: 'weapp-container.template-snapshot-before-cleanup', profile: TEMPLATE_PRODUCER_PROFILE,
        transaction: transactionReference, observer: build.observer, runtimeProjectPath, runtimeRootIdentity: transaction.runtimeRootIdentity,
        snapshotFiles: postLaunchFiles, capturedAt: at })
      const cleanup = put({ schemaVersion: 1, kind: 'weapp-container.template-snapshot-cleanup', profile: TEMPLATE_PRODUCER_PROFILE,
        transaction: transactionReference, observer: build.observer, runtimeProjectPath, runtimeRootIdentity: transaction.runtimeRootIdentity,
        beforeCleanup, removedAt: at, projectAbsent: true, originalRemoval: { status: 'fulfilled', pathAbsent: true,
          boundary: 'identity-at-dispatch-original-remove-settlement-path-absence', dispatchedAt: at, settledAt: at, identityAtDispatch: transaction.runtimeRootIdentity } })
      return { finalGuard: 'same-source-and-generated-closure', producerCandidates: [{ candidate, validation }],
        producerFinal: [{ transaction: transactionReference, cleanup, runtimeConfiguration }], producerSourceFinal: { capturedAt: at, sourceRoot,
          generatedRoot: build.outputRoot, sourceRootIdentity: transaction.sourceRootIdentity, sourceFiles: sources, generatedFiles: build.generated },
        templateFinal: { capturedAt: at, sourceRoot, runtimeProjectPath: build.runtimeProjectPath, sourceRootIdentity: build.sourceRootIdentity,
          runtimeRootIdentity: build.runtimeRootIdentity, sourceAfter: sources, generated: build.generated, projectOutput } }
    } }
}
