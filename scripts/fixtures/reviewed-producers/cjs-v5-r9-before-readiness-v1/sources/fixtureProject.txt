import { createHash } from 'node:crypto'
import { verifyTemplateLaunchInputs, instrumentSnapshotAutomator, snapshotFileMap, verifySnapshotTransport, verifySnapshotCleanupFinal, verifySnapshotSourceFinal } from './conformance-snapshot-transport.mjs'
import { assertReviewedSnapshotProducer } from './conformance-producer-revisions.mjs'
/** Template source inputs and fresh generated project ownership. CLI labels
 * select this proof shape; immutable inputs and the complete output prove it. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TEMPLATE_STATIC_CASE, TEMPLATE_SFC_STATIC_CASE, TEMPLATE_STATIC_CASES, templateStaticCase, parseStaticCliInvocation, TEMPLATE_STATIC_CLI_PROFILE } from './conformance-static-cli-profile.mjs'

const ensure = (ok, message) => { if (!ok) throw new Error(message) }
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const equal = (left, right) => canonical(left) === canonical(right)
const slash = path => path.split(sep).join('/')
const exists = path => { try { lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const regular = path => {
  ensure(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && realpathSync(path) === path,
    'Template project config/input is not a regular physical file')
  return readFileSync(path)
}
const safe = path => typeof path === 'string' && path && !isAbsolute(path) && !/[\\\0]/.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..')
const sameBytes = (left, right) => left?.sha256 === right?.sha256 && left?.bytes === right?.bytes

export function readTemplateSourceProject(profile) {
  ensure(profile?.profile === TEMPLATE_STATIC_CLI_PROFILE && realpathSync(profile.sourceRoot) === profile.sourceRoot,
    'Template build source root differs from its physical owned checkout')
  const configPath = join(profile.sourceRoot, profile.sourceConfigRelative), configBytes = regular(configPath)
  const config = JSON.parse(configBytes)
  ensure(config.miniprogramRoot === 'dist' && config.compileType === 'miniprogram',
    'Template source config does not declare the exact separate dist mini-program root')
  ensure(!exists(join(profile.sourceRoot, profile.outputContainerRelative)),
    'Template project output container existed before this build')
  return { projectPath: profile.sourceRoot, sourceRoot: profile.sourceRoot, configPath, configBytes,
    outputRoot: profile.generatedRoot, outputRelative: profile.generatedRelative,
    sourceOutputRelative: profile.outputContainerRelative, runtimeProjectPath: profile.runtimeProjectPath,
    staticCliProfile: profile }
}

/** Unlike external copied fixtures, this source is part of the sealed compiler
 * checkout. Every original member and dependency link must be accounted for. */
export function verifyTemplateSourceMembers({ profile, sourceBefore, members, checkout, load }) {
  ensure(profile?.profile === TEMPLATE_STATIC_CLI_PROFILE && Array.isArray(sourceBefore) && Array.isArray(members),
    'Template immutable source/member closure is missing')
  const prefix = profile.templateRelativePath + '/', expected = new Map()
  for (const member of members) if (member.path?.startsWith(prefix)) {
    const path = member.path.slice(prefix.length)
    ensure(safe(path) && path !== profile.outputContainerRelative && !path.startsWith(profile.outputContainerRelative + '/'),
      'Template generated output overlaps an original compiler consumer member')
    ensure(!expected.has(path), 'Duplicate template consumer member')
    expected.set(path, member)
  }
  ensure(expected.size && expected.size === sourceBefore.length, 'Template source closure omits original members or contains unbound inputs')
  const seen = new Set()
  for (const item of sourceBefore) {
    ensure(safe(item.path) && !seen.has(item.path), 'Duplicate or unsafe template source input')
    seen.add(item.path)
    const member = expected.get(item.path)
    ensure(member, 'Template source input is outside the sealed consumer closure')
    if (item.kind === 'file') {
      const reviewedConfigPatch = member.origin === 'patch' && /^(?:config\/[^/]+\/)?project\.(?:private\.)?config\.json$/.test(item.path)
      ensure(member.kind === 'file' && (['source', 'dependency'].includes(member.origin) || reviewedConfigPatch)
        && sameBytes(item.artifact, member), 'Template original source/input bytes differ from the sealed consumer')
      load(item.artifact)
    } else {
      const target = member.kind === 'link' ? resolve(checkout, member.target)
        : member.kind === 'source-link' ? resolve(dirname(join(checkout, member.path)), member.target) : null
      ensure(item.kind === 'consumer-link' && target && item.target === slash(relative(checkout, target)),
        'Template dependency link differs from the sealed consumer')
    }
  }
  const config = sourceBefore.find(item => item.path === profile.sourceConfigRelative)
  ensure(config?.kind === 'file', 'Template source config is missing from original inputs')
  const packageFile = sourceBefore.find(item => item.path === 'package.json')
  ensure(packageFile?.kind === 'file', 'Template source package manifest is missing')
  const pkg = JSON.parse(load(packageFile.artifact))
  const sourceCase = TEMPLATE_STATIC_CASES.find(value => value.templateRelativePath === profile.templateRelativePath)
  ensure(sourceCase && pkg.name === sourceCase.templateRelativePath.slice('templates/'.length) && (!pkg.dependencies
    || typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies) && !Object.keys(pkg.dependencies).length),
    'Template skipNpm is not supported by its actual original package manifest')
}

export function verifyTemplateProjectEvidence({ build, profile, load, members, checkout }) {
  ensure(equal(build.staticCliProfile, profile) && build.sourceRoot === profile.sourceRoot
    && build.projectPath === profile.sourceRoot && build.outputRoot === profile.generatedRoot
    && build.outputRelative === profile.generatedRelative && build.sourceOutputRelative === profile.outputContainerRelative
    && build.runtimeProjectPath === profile.runtimeProjectPath && build.outputAbsent === true,
    'Template source/runtime/generated root mapping differs from the recognized invocation')
  verifyTemplateSourceMembers({ profile, sourceBefore: build.sourceBefore, members, checkout, load })
  const sourceConfig = build.sourceBefore.find(item => item.path === profile.sourceConfigRelative)
  ensure(equal(sourceConfig.artifact, build.projectConfig), 'Template source config reference differs from original source closure')
  const config = JSON.parse(load(build.projectConfig))
  ensure(config.miniprogramRoot === 'dist' && config.compileType === 'miniprogram', 'Template original project config mapping differs')
  ensure(Array.isArray(build.projectOutput) && build.projectOutput.length, 'Template full generated project output closure is missing')
  const projectFiles = new Map(), names = new Set()
  for (const item of build.projectOutput) {
    ensure(safe(item.path) && !names.has(item.path) && item.kind === 'file' && item.path.startsWith('weapp/'),
      'Template project output contains duplicate, foreign, linked or unsafe members')
    names.add(item.path); projectFiles.set(item.path.slice('weapp/'.length), item)
    load(item.artifact)
  }
  const runtimeConfig = projectFiles.get('project.config.json')
  ensure(runtimeConfig && equal(runtimeConfig.artifact, build.runtimeProjectConfig)
    && sameBytes(build.runtimeProjectConfig, build.projectConfig)
    && Buffer.from(load(build.runtimeProjectConfig)).equals(Buffer.from(load(build.projectConfig))),
  'Template actual generated project config differs from the original copied config')
  const actualConfig = JSON.parse(load(build.runtimeProjectConfig))
  ensure(actualConfig.miniprogramRoot === 'dist' && resolve(build.runtimeProjectPath, actualConfig.miniprogramRoot) === build.outputRoot,
    'Template fresh project config does not resolve to the captured generated mini-program')
  const generated = [...projectFiles].filter(([path]) => path.startsWith('dist/'))
    .map(([path, item]) => ({ ...item, path: path.slice('dist/'.length) }))
  ensure(equal(generated, build.generated), 'Template mini-program files are detached from the full fresh project output')
  const configPrefix = 'config/weapp/'
  const configSources = new Map(build.sourceBefore.filter(item => item.path.startsWith(configPrefix))
    .map(item => [item.path.slice(configPrefix.length), item]))
  for (const [path, item] of projectFiles) if (!path.startsWith('dist/')) {
    const original = configSources.get(path)
    ensure(original?.kind === 'file' && sameBytes(item.artifact, original.artifact),
      'Template generated project file is not an original platform config asset')
  }
  for (const [path, original] of configSources) ensure(original.kind === 'file'
    && sameBytes(projectFiles.get(path)?.artifact, original.artifact), 'Template output omitted or changed an original platform config asset')
}

// The original default Automator launch copies the generated IDE project into
// a separately owned SDK snapshot. Build-source and IDE-source stay distinct.
export const TEMPLATE_PRODUCER_PROFILE = 'template-native-static-snapshot-v1'
export const TEMPLATE_PRODUCER_GUARDS = Object.freeze([{"path":"e2e/ide/template-weapp-vite-multi-platform-template.test.ts","sha256":"5968eea1626e824c54b73555a0d655059e20e2fe87e3fff0908ca9e119da32e7"},{"path":"e2e/template-e2e.utils.ts","sha256":"d27900c5eac5f57d53c356be640c27a81fcca829fe05c5969870fbefbb893029"},{"path":"e2e/utils/automator.ts","sha256":"3389347206d95d6cbaa3fba9a0f72ab75519868032dc868810019599186f0938"},{"path":"e2e/utils/automatorBridgeFiles.ts","sha256":"f136b7809732b7fc6f66cb77ec33fe06ae94dca5b3fae12df492392095e2a95b"},{"path":"e2e/utils/buildLog.ts","sha256":"1c992ab9649f2a56fa6c37e3d7f9f4f02c254f3427999a51b26146e941419868"},{"path":"e2e/utils/templateAcceptance/native.ts","sha256":"012bef80e14db3cb472a91c183cb6337927c355a1ea25c4b9c4bec2c998d54a3"},{"path":"e2e/utils/templateAcceptance/index.ts","sha256":"a01cf4c5081342c59f6eb61cc410b4e73f629bd3c968e73f5ced3f9515df38a8"},{"path":"e2e/utils/templateAcceptance/format.ts","sha256":"5174ca7d280a7c70a22e00865aa4a44ad0ad4bfcaf1526970ab2fc50170d232f"}].map(item => Object.freeze(item)))
export const TEMPLATE_SFC_PRODUCER_GUARDS = Object.freeze([Object.freeze({ path: TEMPLATE_SFC_STATIC_CASE.caseSourcePath, sha256: TEMPLATE_SFC_STATIC_CASE.sourceSha256 }), ...TEMPLATE_PRODUCER_GUARDS.slice(1)])
export const templateProducerGuards = identity => {
  const sourceCase = templateStaticCase(identity)
  ensure(sourceCase, 'Template producer source identity is not reviewed')
  return sourceCase === TEMPLATE_STATIC_CASE ? TEMPLATE_PRODUCER_GUARDS : TEMPLATE_SFC_PRODUCER_GUARDS
}
export const templateProducerBytes = () => readFileSync(new URL('./conformance-fixture-project.mjs', import.meta.url))
export const templateProducerCase = templateStaticCase
export function templateProducerInvocation(options) {
  const profile = parseStaticCliInvocation(options)
  if (!profile || profile.profile !== TEMPLATE_STATIC_CLI_PROFILE) return null
  const sourceCase = templateProducerCase(options)
  return Object.freeze({ profile: TEMPLATE_PRODUCER_PROFILE,
    ...Object.fromEntries(['caseId', 'caseSourcePath', 'sourceSha256'].map(key => [key, sourceCase[key]])),
    sourceRoot: profile.sourceRoot, generatedRoot: profile.generatedRoot, sourceProjectPath: profile.runtimeProjectPath })
}
export function verifyTemplateProducerGuards({ guards, members, load, identity = TEMPLATE_STATIC_CASE }) {
  const expectedGuards = templateProducerGuards(identity)
  ensure(Array.isArray(guards) && guards.length === expectedGuards.length && Array.isArray(members), 'Template producer source guards are missing')
  const map = new Map(members.map(item => [item.path, item]))
  for (const [at, expected] of expectedGuards.entries()) {
    const guard = guards[at], original = load(guard.original), observed = load(guard.observed), member = map.get(expected.path)
    const digest = bytes => createHash('sha256').update(bytes).digest('hex')
    ensure(guard.path === expected.path && digest(original) === expected.sha256, 'Template original producer helper guard differs')
    const transformed = expected.path === 'e2e/utils/automator.ts' ? Buffer.from(instrumentSnapshotAutomator(original.toString('utf8'))) : original
    ensure(Buffer.from(observed).equals(transformed) && member?.kind === 'file' && member.sha256 === digest(observed) && member.bytes === observed.length
      && member.origin === (expected.path === 'e2e/utils/automator.ts' ? 'patch' : 'source'), 'Template observed helper is not the exact reviewed source/transform')
  }
}
export function verifyTemplateProducerTransaction({ transaction: t, build, checkout, members, load, identity, producerRevision }) {
  const profile = templateProducerInvocation({ args: build.command?.slice(1), cliPath: build.command?.[1], cwd: build.cwd, checkout, ...identity })
  ensure(profile && equal(profile, build.producerProfile) && templateProducerCase(identity), 'Template snapshot producer invocation/source tuple differs')
  ensure(t.schemaVersion === 1 && t.kind === 'weapp-container.template-producer-transaction' && t.profile === TEMPLATE_PRODUCER_PROFILE
    && t.sourceRoot === build.projectPath && t.sourceProjectPath === build.runtimeProjectPath && t.generatedRoot === build.outputRoot,
  'Template snapshot source/build/generated IDE roots differ')
  if (producerRevision === undefined) ensure(Buffer.from(load(t.producer)).equals(templateProducerBytes()), 'Template snapshot producer implementation differs')
  else assertReviewedSnapshotProducer({ reference: t.producer, profile: TEMPLATE_PRODUCER_PROFILE, identity }, producerRevision, load)
  verifyTemplateProducerGuards({ guards: t.guards, members, load, identity })
  verifyTemplateLaunchInputs(t, members, load)
  verifyTemplateProjectEvidence({ build, profile: build.staticCliProfile, checkout, members, load })
  ensure(equal(t.sourceRootIdentity, build.sourceRootIdentity) && equal(t.generatedProjectIdentity, build.runtimeRootIdentity)
    && equal(t.postHelperSource, build.sourceAfter) && equal(t.postHelperGenerated, build.generated)
    && equal(t.postHelperProjectOutput, build.projectOutput), 'Template original source/generated/project transition changed before SDK snapshot')
  snapshotFileMap(t.postHelperSource, load, true)
  const projectSource = t.postHelperProjectOutput.filter(item => !item.path.startsWith('weapp/dist/')).map(item => ({ ...item, path: item.path.slice('weapp/'.length) }))
  // The shared transport verifies the exact original bridge copy/config
  // algorithm over its actual generated IDE source. Projection changes names,
  // never bytes, and the full build-source transaction is checked above.
  const projectedBuild = { ...build, projectPath: build.runtimeProjectPath, outputRelative: 'dist', sourceRootIdentity: build.runtimeRootIdentity }
  const projected = { ...t, sourceRoot: build.runtimeProjectPath, sourceRootIdentity: build.runtimeRootIdentity, postHelperSource: projectSource }
  const runtimeGenerated = verifySnapshotTransport({ transaction: projected, build: projectedBuild,
    profile: { sourceRoot: build.runtimeProjectPath, generatedRoot: build.outputRoot }, checkout, load, label: 'Template', allowMissingPrivateConfig: true, producerRevision, producerProfile: TEMPLATE_PRODUCER_PROFILE, identity })
  return { profile, runtimeGenerated }
}
export function verifyTemplateSnapshotFinal(options) {
  return verifySnapshotCleanupFinal({ ...options, profile: TEMPLATE_PRODUCER_PROFILE, prefix: 'template', label: 'Template',
    verifyTransaction: transaction => verifyTemplateProducerTransaction({ ...options, transaction }) })
}
export const verifyTemplateSourceFinal = options => verifySnapshotSourceFinal({ ...options, label: 'Template', allowSourceLinks: true })
