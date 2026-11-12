/** Original standalone factory projection. Full production fixture/oracle
 * validation must precede this reader; synthetic inputs grant no execution. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { descriptor } from '../../../conformance/recipes/issue1182-descriptor.mjs'
import { generatedMemberIdentities, loadSourcePlanEnvelope } from './source-plan-static.mjs'
const require = (ok, message) => { if (!ok) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const issue1182AssertionIds = Object.freeze(descriptor.plans.map(plan => plan.fullName))

export async function projectIssue1182Standalone({ checkpoint, fixtureBuild, compilerBuild, compilerUse, read, json }) {
  const build = checkpoint.build, checkout = compilerUse.checkout, project = build?.projectPath
  require(typeof checkout === 'string' && isAbsolute(checkout) && resolve(checkout) === checkout && !checkout.includes('\\')
    && typeof project === 'string' && dirname(project) === join(checkout, '.tmp/e2e-projects')
    && /^issue-1182-[A-Za-z0-9]{6}$/.test(basename(project)) && resolve(project) === project,
  'Issue1182 actual standalone project does not belong to its source factory')
  require(build.cwd === checkout && build.status === 'built' && build.exitCode === 0 && !build.signal && build.outputAbsent === true
    && build.outputCaptured === true && build.outputRoot === join(project, 'dist') && build.outputRelative === 'dist'
    && Array.isArray(build.command) && build.command.length === 6 && typeof build.command[0] === 'string'
    && isDeepStrictEqual(build.command.slice(1), [join(checkout, 'packages/weapp-vite/bin/weapp-vite.js'), 'build', project, '--platform', 'weapp']),
  'Issue1182 did not execute the original five-argument direct CLI/cwd/output')
  require(!checkpoint.producerTransaction && checkpoint.runtimeGenerated === undefined && build.producerProfile === undefined
    && ['staticCliProfile', 'sourceRoot', 'sourceOutputRelative', 'runtimeProjectPath', 'runtimeProjectConfig', 'projectOutput'].every(key => build[key] === undefined),
  'Issue1182 direct build contains unrelated snapshot/template metadata')
  require(isDeepStrictEqual(checkpoint.compilerBuild, fixtureBuild.compilerBuild) && isDeepStrictEqual(checkpoint.compilerBuild, compilerUse.compilerBuild)
    && isDeepStrictEqual(checkpoint.consumerGuard, compilerUse.before), 'Issue1182 standalone compiler/consumer guard binding differs')
  const guards = await json(compilerUse.before)
  require(Array.isArray(guards.members), 'Issue1182 actual consumer member closure is absent')
  const sources = new Map((compilerBuild.source?.files ?? []).map(file => [file.path, file]))
  for (const [path, sha256] of Object.entries({ [descriptor.caseSourcePath]: descriptor.sourceSha256, ...descriptor.sourceGuards })) {
    const source = sources.get(path)
    require(source && ['100644', '100755'].includes(source.mode) && source.artifact?.sha256 === sha256,
      `Issue1182 pinned original helper/source differs: ${path}`)
    await read(source.artifact)
    if ([descriptor.caseSourcePath, 'e2e/utils/issueRegressionProject.ts'].includes(path)) {
      const actual = guards.members.filter(item => item.path === path)
      require(actual.length === 1 && actual[0].kind === 'file' && actual[0].origin === 'source' && actual[0].sha256 === sha256,
        `Issue1182 actual standalone factory/source was replaced: ${path}`)
    }
  }
  require(Array.isArray(build.sourceBefore) && build.sourceBefore.length === descriptor.fixtureInputs.length + 3,
    'Issue1182 standalone source closure is not its exact nine-file/three-link fixture')
  const before = new Map(build.sourceBefore.map(item => [item.path, item]))
  require(before.size === build.sourceBefore.length, 'Issue1182 standalone source closure has duplicate paths')
  for (const file of descriptor.fixtureInputs) {
    const actual = before.get(file.path), original = sources.get('e2e-apps/github-issues/fixtures/issue-1182/' + file.path)
    require(actual?.kind === 'file' && actual.artifact?.sha256 === file.sha256 && actual.artifact.bytes === file.bytes
      && original && ['100644', '100755'].includes(original.mode) && original.artifact?.sha256 === file.sha256 && original.artifact.bytes === file.bytes,
    `Issue1182 standalone copied fixture bytes differ: ${file.path}`)
    await read(actual.artifact); await read(original.artifact)
  }
  for (const [path, target] of [['node_modules/weapp-vite', 'packages/weapp-vite'], ['node_modules/wevu', 'packages-runtime/wevu'], ['node_modules/@weapp-vite/web', 'packages-runtime/web']]) {
    const item = before.get(path)
    require(item?.kind === 'consumer-link' && item.target === target && isDeepStrictEqual(item.consumerGuard, checkpoint.consumerGuard)
      && guards.members.some(member => member.path.startsWith(target + '/')),
    `Issue1182 standalone actual workspace link is absent or reassigned: ${path}`)
  }
  require(isDeepStrictEqual(before.get('project.config.json').artifact, build.projectConfig), 'Issue1182 source project config differs from actual direct launch')
  const runtime = await json(checkpoint.runtimeObservation), config = await json(build.projectConfig)
  require(runtime.projectPath === project && resolve(project, config.miniprogramRoot) === build.outputRoot,
    'Issue1182 actual direct SDK project differs from its built standalone target')
  const closure = generatedMemberIdentities(build.generated)
  require(isDeepStrictEqual(generatedMemberIdentities(await json(fixtureBuild.before)), closure)
    && isDeepStrictEqual(generatedMemberIdentities(await json(fixtureBuild.after)), closure),
  'Issue1182 executed pack did not consume the unchanged direct CLI generation')
  const logs = []
  for (const reference of compilerUse.logs ?? []) {
    const lines = (await read(reference)).toString('utf8').trim().split('\n')
    logs.push(...lines.filter(Boolean).map(line => JSON.parse(line)))
  }
  const starts = logs.filter(event => event.kind === 'start' && event.pid === build.pid && event.threadId === 0)
  require(starts.length === 1 && isDeepStrictEqual(starts[0].argv, build.runtimeArgv) && isDeepStrictEqual(build.runtimeArgv.slice(1), build.command.slice(1))
    && starts[0].cwd === checkout && starts[0].ppid === checkpoint.observer?.pid,
  'Issue1182 five-argument CLI lacks its actual process startup')
  const bridges = logs.filter(event => event.kind === 'start' && event.bridgeProject?.projectPath === project)
  require(bridges.length === 1, 'Issue1182 actual direct SDK bridge project is absent or duplicated')
  const payload = JSON.parse(bridges[0].argv?.[2]), observed = bridges[0].bridgeProject
  require(payload.projectPath === project && observed.configFile === join(project, 'project.config.json')
    && typeof observed.configSource === 'string' && hash(Buffer.from(observed.configSource)) === build.projectConfig.sha256
    && Buffer.byteLength(observed.configSource) === build.projectConfig.bytes,
  'Issue1182 actual direct bridge opened another source project/config')
  const generated = new Map(build.generated.map(item => [item.path, item])), files = []
  for (const path of descriptor.compiledFiles) {
    const member = generated.get(path)
    require(member?.kind === 'file', `Issue1182 original stat/read target is not a regular generated file: ${path}`)
    const bytes = await read(member.artifact)
    files.push({ path, bytes, sha256: hash(bytes), length: bytes.length })
  }
  return files
}

export async function loadIssue1182Inputs(options) {
  const envelope = await loadSourcePlanEnvelope({ ...options, descriptor, assertionIds: issue1182AssertionIds })
  const { execution, checkpoint, fixtureBuild, fixture, trace, read, json, references } = envelope
  require(isDeepStrictEqual(execution.compilerBuild, fixtureBuild.compilerBuild) && isDeepStrictEqual(execution.compilerUse, fixtureBuild.compilerUse),
    'Issue1182 original execution/fixture compiler references differ')
  const compilerBuild = await json(execution.compilerBuild), compilerUse = await json(execution.compilerUse)
  const files = await projectIssue1182Standalone({ checkpoint, fixtureBuild, compilerBuild, compilerUse, read, json })
  return { trace, staticInputs: { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256,
    manifestIntegrity: fixture.manifest.integrity.root, files }, references: [...references.values()] }
}

export function assertIssue1182StaticOutputs(input) {
  require(input?.caseId === descriptor.caseId && input.sourceSha256 === descriptor.sourceSha256
    && Array.isArray(input.files) && input.files.length === descriptor.compiledFiles.length, 'Issue1182 original static coverage is incomplete')
  for (const [at, path] of descriptor.compiledFiles.entries()) {
    const file = input.files[at]
    require(file?.path === path && Buffer.isBuffer(file.bytes) && file.length === file.bytes.length && file.sha256 === hash(file.bytes),
      'Issue1182 original stat/read target changed')
  }
  require(isDeepStrictEqual(JSON.parse(input.files[0].bytes.toString('utf8')).pages, ['pages/index/index']),
    'Issue1182 original app.pages assertion failed')
  return { caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256, manifestIntegrity: input.manifestIntegrity,
    originalReadFiles: 1, originalStatFiles: 3, originalStaticExpectations: 4,
    assertionCoverage: ['app.pages', 'pages/index/index.js/isFile', 'pages/index/index.json/isFile', 'pages/index/index.wxml/isFile'],
    files: input.files.map(({ path, sha256, length: bytes }) => ({ path, sha256, bytes })) }
}
