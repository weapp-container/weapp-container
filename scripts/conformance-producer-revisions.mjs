import { TEMPLATE_STATIC_CASES, templateStaticCase } from './conformance-static-cli-profile.mjs'
/** Exact reviewed producer groups. Archived JavaScript remains inert text;
 * only current strict semantic readers execute, including snapshot validation. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ensure = (condition, message) => { if (!condition) throw new Error(message) }
const hash = value => createHash('sha256').update(value).digest('hex')
const primaryFiles = Object.freeze({
  compilerUseProducer: './conformance-compiler-use.mjs', compilerUsePreload: './conformance-compiler-use-preload.cjs',
  fixtureBuildProducer: './conformance-fixture-build.mjs', fixturePackerPreload: './conformance-fixture-packer-preload.mjs',
  macroProducer: './conformance-compiler-observation.mjs', macroManifest: './conformance-compiler-observation-v1.json',
  macroObserver: './conformance-compiler-macro-observer.mjs', macroValidator: './conformance-compiler-macro-validator.mjs',
})
const snapshotFiles = Object.freeze({ githubProducer: './conformance-github-producer.mjs',
  wxmlProducer: './conformance-wxml-producer.mjs', snapshotTransport: './conformance-snapshot-transport.mjs',
  temporaryProjectProducer: './conformance-temporary-project-producer.mjs', issue1034Producer: './conformance-issue1034-producer.mjs' })
const staticProfileFiles = Object.freeze({ staticCliProfile: './conformance-static-cli-profile.mjs', fixtureProject: './conformance-fixture-project.mjs' })
const staticProfileKeys = Object.keys(staticProfileFiles)
const primaryKeys = Object.keys(primaryFiles), snapshotKeys = Object.keys(snapshotFiles)
const legacySnapshotKeys = Object.freeze(['githubProducer', 'wxmlProducer', 'snapshotTransport'])
const macroKeys = ['macroProducer', 'macroManifest', 'macroObserver', 'macroValidator']
const observationFields = { macroProducer: 'producer', macroManifest: 'manifest', macroObserver: 'observer', macroValidator: 'validator' }
const catalog = Object.freeze([
  Object.freeze({ directory: 'sealed-esm-v2-r3-v1', id: 'sealed-esm-v2-r3-reviewed-v1',
    profile: 'pinned-json-macro-esm-v2-rolldown-runtime', sha256: '1057e01eabd7880cb585612735e5fe97c65703c93d8ecbe87ea8fb5fdc2562fe', bytes: 4994, snapshots: false }),
  Object.freeze({ directory: 'cjs-v4-r5b-v1', id: 'cjs-v4-r5b-reviewed-v1',
    profile: 'pinned-json-macro-esm-cjs-v4-runtime-input', sha256: 'db8f87cf4d492fdc4d0a4bc61e6c4918e41aeff7a7358e45008c8edbb0774ce5', bytes: 7212, snapshots: true, snapshotKeys: legacySnapshotKeys }),
  Object.freeze({ directory: 'cjs-v4-r5c-v1', id: 'cjs-v4-r5c-reviewed-v1',
    profile: 'pinned-json-macro-esm-cjs-v4-runtime-input', sha256: '7bc84bf0d2ef5a6e47a237320fc03c5428ff34802973b9b71341ece9ba1931e5', bytes: 5653, snapshots: true, snapshotKeys: legacySnapshotKeys }),
  Object.freeze({ directory: 'cjs-v4-r5f-v1', id: 'cjs-v4-r5f-reviewed-v1',
    profile: 'pinned-json-macro-esm-cjs-v4-runtime-input', sha256: 'f9208cda04f64995422eef06e3e1dbd61b458fe0f7e2259d4132ff579a811db4', bytes: 8605, snapshots: true, snapshotKeys }),
  Object.freeze({ directory: 'cjs-v4-r6-v2', id: 'cjs-v4-r6-v2-reviewed-v1',
    profile: 'pinned-json-macro-esm-cjs-v4-runtime-input', sha256: '23dadf03f4f31054aea7fd6159de30612a83bf19a04fb243476c018f3a570c2a', bytes: 4523, snapshots: true, snapshotKeys, staticProfiles: true }),
  Object.freeze({ directory: 'cjs-v4-r7-v1', id: 'cjs-v4-r7-v1-reviewed-v1',
    profile: 'pinned-json-macro-esm-cjs-v4-runtime-input', sha256: 'a2b06a7f9364917d61ea1ede09e08b63a5092fd66b95e67982226316c697d7f7', bytes: 4835, snapshots: true, snapshotKeys, staticProfiles: true }),

  Object.freeze({ directory: 'cjs-v5-r8-before297-302-v1', id: 'cjs-v5-r8-before297-302-reviewed-v1',
    profile: 'pinned-json-macro-esm-cjs-v5-npm-support', sha256: 'e79477f057bb7ddc1ebb1f8b61bfa9ecdc767e1412b162f87330da9f87d4db63', bytes: 7471, snapshots: true, snapshotKeys, staticProfiles: true }),
  Object.freeze({ directory: 'cjs-v5-r9-before-readiness-v1', id: 'cjs-v5-r9-before-readiness-reviewed-v1',
    profile: 'pinned-json-macro-esm-cjs-v5-npm-support', sha256: '4cf90c202af781528d66db07186feae0317eca02bf98bad89b90bcfcd0db629c', bytes: 6081, snapshots: true, snapshotKeys, staticProfiles: true }),
  Object.freeze({ directory: 'cjs-v5-r10-before-core-transform-v1', id: 'cjs-v5-r10-before-core-transform-reviewed-v1',
    profile: 'pinned-json-macro-esm-cjs-v5-npm-support', sha256: 'b6bc03a56f8b9878151e7c499b56a77ffc0b1069ee272693336ebda298b9fb99', bytes: 5218, snapshots: true, snapshotKeys, staticProfiles: true }),
])
const snapshotProfiles = ['github-static-snapshot-v1', 'wxml-static-snapshot-v1', 'issue1034-static-snapshot-v1', 'template-native-static-snapshot-v1']
const canonicalKeys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : ''
const currentBytes = key => readFileSync(new URL(({ ...primaryFiles, ...snapshotFiles, ...staticProfileFiles })[key], import.meta.url))

function fixedFile(entry, path, expected) {
  ensure(typeof path === 'string' && path && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid fixed producer fixture path')
  let url = new URL('./', import.meta.url)
  const parts = ['fixtures', 'reviewed-producers', entry.directory, ...path.split('/')]
  for (let index = 0; index < parts.length; index++) {
    url = new URL(parts[index], url)
    const stat = lstatSync(fileURLToPath(url))
    ensure(!stat.isSymbolicLink(), 'Reviewed producer fixture cannot contain a symlink')
    if (index < parts.length - 1) {
      ensure(stat.isDirectory(), 'Reviewed producer fixture parent is not a regular directory')
      url = new URL(`${url.href}/`)
    } else ensure(stat.isFile(), 'Reviewed producer fixture is not a regular file')
  }
  const bytes = readFileSync(url)
  ensure(bytes.length === expected.bytes && hash(bytes) === expected.sha256, 'Fixed reviewed producer fixture hash/size differs')
  return bytes
}

function fixedRevision(entry) {
  const metadata = JSON.parse(fixedFile(entry, 'revision.json', entry))
  ensure(metadata.schemaVersion === 1 && metadata.kind === 'reviewed-producer-revision'
    && metadata.id === entry.id && metadata.profile === entry.profile, 'Unsupported fixed producer revision')
  const keys = [...primaryKeys, ...(entry.snapshots ? entry.snapshotKeys : []), ...(entry.staticProfiles ? staticProfileKeys : [])]
  ensure(Object.keys(metadata.sources).sort().join(',') === [...keys].sort().join(','), 'Fixed producer source closure differs')
  if (entry.snapshots) {
    ensure(Array.isArray(metadata.caseScopes) && metadata.caseScopes.length > 0
      && new Set(metadata.caseScopes.map(scope => scope.caseId)).size === metadata.caseScopes.length
      && metadata.caseScopes.every(scope => canonicalKeys(scope) === 'caseId,caseSourcePath,snapshotProfile,sourceSha256'
        && typeof scope.caseId === 'string' && typeof scope.caseSourcePath === 'string' && /^[a-f0-9]{64}$/.test(scope.sourceSha256)
        && (scope.snapshotProfile === null || snapshotProfiles.includes(scope.snapshotProfile))), 'Fixed producer case scope differs')
    ensure(JSON.stringify(metadata.snapshotModules) === JSON.stringify(entry.snapshotKeys.map(key => ({ key, path: 'scripts/' + snapshotFiles[key].slice(2) }))),
      'Fixed snapshot module order or paths differ')
  }
  ensure(entry.staticProfiles
    ? JSON.stringify(metadata.staticProfileModules) === JSON.stringify(staticProfileKeys.map(key => ({ key, path: 'scripts/' + staticProfileFiles[key].slice(2) })))
    : metadata.staticProfileModules === undefined, 'Fixed static profile module order or paths differ')
  const sources = Object.fromEntries(keys.map(key => [key, fixedFile(entry, metadata.sources[key].path, metadata.sources[key])]))
  for (const item of metadata.provenance) fixedFile(entry, item.copy, item)
  const manifest = JSON.parse(sources.macroManifest)
  ensure(manifest.profile === metadata.profile, 'Fixed producer manifest profile differs')
  return { id: metadata.id, profile: metadata.profile, sources, manifest, metadata, snapshotKeys: entry.snapshotKeys ?? [], staticProfileKeys: entry.staticProfiles ? staticProfileKeys : [] }
}

const fixedInputs = catalog.map(entry => ({ entry, metadata: fixedRevision(entry).metadata }))
export const REVIEWED_PRODUCER_INPUTS = Object.freeze(['scripts/conformance-producer-revisions.mjs',
  ...fixedInputs.flatMap(({ entry, metadata }) => {
    const prefix = `scripts/fixtures/reviewed-producers/${entry.directory}/`
    return [prefix + 'revision.json', ...Object.values(metadata.sources).map(item => prefix + item.path),
      ...metadata.provenance.map(item => prefix + item.copy)]
  })])

const matches = (reference, expected, load) => {
  if (!reference || reference.bytes !== expected.length || reference.sha256 !== hash(expected)) return false
  return Buffer.from(load(reference)).equals(expected)
}
const tuple = (sources, keys) => Object.freeze(keys.map(key => Object.freeze({ key, sha256: hash(sources[key]), bytes: sources[key].length })))
function revisions() {
  const sources = Object.fromEntries([...primaryKeys, ...snapshotKeys, ...staticProfileKeys].map(key => [key, currentBytes(key)]))
  const manifest = JSON.parse(sources.macroManifest)
  const current = { id: 'current-reviewed-source', profile: manifest.profile, sources, manifest, current: true, snapshotKeys, staticProfileKeys }
  // Equivalent historical bytes add no second interpretation of a current receipt.
  // All keys, order, profile and actual source bytes must match before collapsing.
  const sameSources = revision => {
    const keys = [...primaryKeys, ...revision.snapshotKeys, ...revision.staticProfileKeys]
    const currentKeys = [...primaryKeys, ...current.snapshotKeys, ...current.staticProfileKeys]
    return revision.profile === current.profile && JSON.stringify(keys) === JSON.stringify(currentKeys)
      && keys.every(key => revision.sources[key].equals(current.sources[key]))
  }
  return [current, ...catalog.map(fixedRevision).filter(revision => !sameSources(revision))]
}
const scopeFor = (revision, identity) => revision.metadata?.caseScopes?.find(scope => ['caseId', 'sourceSha256', 'caseSourcePath'].every(key => scope[key] === identity[key]))
const inScope = (revision, identity) => revision.current || (revision.metadata.caseScopes ? !!scopeFor(revision, identity) : revision.metadata.caseIds.includes(identity.caseId))
function macroRevisions(observation, load) {
  ensure(observation && typeof observation.profile === 'string', 'Unsupported compiler macro observation profile')
  const reviewed = revisions()
  ensure(reviewed.some(revision => revision.profile === observation.profile), 'Unsupported compiler macro observation profile')
  const matching = reviewed.filter(revision => revision.profile === observation.profile
    && macroKeys.every(key => matches(observation[observationFields[key]], revision.sources[key], load))
    && staticProfilePolicy(observation.profileInputs, revision, load))
  ensure(matching.length, 'Compiler macro helper identity tuple differs from reviewed implementation')
  return matching
}

const consumerSelections = new WeakMap(), fixtureSelections = new WeakMap()
export function reviewedMacroObservation(observation, load) {
  const revision = macroRevisions(observation, load)[0]
  return { id: revision.id, profile: revision.profile, manifest: revision.manifest }
}
export function reviewedCompilerProducer(attestation, load) {
  const hasMacroObservation = !!attestation.macroObservation
  const candidates = hasMacroObservation ? macroRevisions(attestation.macroObservation, load) : revisions().filter(revision => revision.current)
  const matching = candidates.filter(revision => inScope(revision, attestation)
    && matches(attestation.producer, revision.sources.compilerUseProducer, load)
    && matches(attestation.preload, revision.sources.compilerUsePreload, load)
    && staticProfilePolicy(attestation.staticProfileInputs, revision, load))
  ensure(matching.length > 0, 'Compiler consumer recorder differs from reviewed implementation or reviewed producer revision is unknown or mixed')
  const identity = Object.fromEntries(['caseId', 'sourceSha256', 'caseSourcePath'].map(key => [key, attestation[key]]))
  const selection = Object.freeze({ ...(matching.length === 1 ? { id: matching[0].id, identityTuple: tuple(matching[0].sources, primaryKeys) } : {}),
    ...(hasMacroObservation ? { profile: matching[0].profile } : {}) })
  consumerSelections.set(selection, { candidates: matching, identity, hasMacroObservation })
  return selection
}

function staticProfileClosure(inputs, revision, load) {
  return Array.isArray(inputs) && inputs.length === staticProfileKeys.length && staticProfileKeys.every((key, index) =>
    canonicalKeys(inputs[index]) === 'artifact,path' && inputs[index].path === 'scripts/' + staticProfileFiles[key].slice(2)
    && matches(inputs[index].artifact, revision.sources[key], load))
}
function staticProfilePolicy(inputs, revision, load) {
  return revision.staticProfileKeys.length ? staticProfileClosure(inputs, revision, load) : inputs === undefined
}
function templateFixtureClosure(attestation, revision, identity, load) {
  if (!revision.current) return staticProfilePolicy(attestation.staticProfileInputs, revision, load)
  if (!staticProfileClosure(attestation.staticProfileInputs, revision, load)) return false
  if (attestation.producerProfile !== 'template-native-static-snapshot-v1'
    && !TEMPLATE_STATIC_CASES.some(source => source.caseId === identity.caseId)) return true
  return Boolean(templateStaticCase(identity)) && attestation.sourceSha256 === identity.sourceSha256
    && attestation.producerProfile === 'template-native-static-snapshot-v1'
}
function snapshotClosure(attestation, revision, identity, load) {
  const profile = attestation.producerProfile, inputs = attestation.producerInputs
  if (profile === undefined && inputs === undefined) return !revision.metadata?.caseScopes || scopeFor(revision, identity)?.snapshotProfile === null
  if (!snapshotProfiles.includes(profile) || !Array.isArray(inputs) || inputs.length !== revision.snapshotKeys.length) return false
  if (!revision.current && scopeFor(revision, identity)?.snapshotProfile !== profile) return false
  return revision.snapshotKeys.every((key, index) => revision.sources[key] && canonicalKeys(inputs[index]) === 'artifact,path'
    && inputs[index].path === 'scripts/' + snapshotFiles[key].slice(2) && matches(inputs[index].artifact, revision.sources[key], load))
}

/** Complete the primary eight-member tuple and exact conditional module closure.
 * The returned token is opaque, case-bound and required by archived snapshot validation. */
export function assertReviewedFixtureProducer(attestation, selection, load) {
  const bound = consumerSelections.get(selection)
  ensure(bound, 'Fixture reviewed producer revision is unknown or mixed')
  const { candidates, identity, hasMacroObservation } = bound
  const matching = candidates.filter(revision => attestation.caseId === identity.caseId
    && (revision.current || hasMacroObservation && inScope(revision, identity)
      && (!revision.metadata.caseScopes || attestation.sourceSha256 === identity.sourceSha256))
    && matches(attestation.producer, revision.sources.fixtureBuildProducer, load)
    && matches(attestation.packer?.preload, revision.sources.fixturePackerPreload, load)
    && snapshotClosure(attestation, revision, identity, load)
    && templateFixtureClosure(attestation, revision, identity, load))
  ensure(matching.length === 1, 'Fixture recorder/packer/snapshot closure differs from reviewed implementation or reviewed producer revision is unknown or mixed')
  const revision = matching[0], snapshotProfile = attestation.producerProfile
  const completed = Object.freeze({ id: revision.id, identityTuple: tuple(revision.sources, primaryKeys),
    snapshotIdentityTuple: snapshotProfile ? tuple(revision.sources, revision.snapshotKeys) : Object.freeze([]),
    ...(snapshotProfile ? { snapshotProfile } : {}),
    ...(revision.staticProfileKeys.length ? { staticProfileIdentityTuple: tuple(revision.sources, revision.staticProfileKeys) } : {}) })
  fixtureSelections.set(completed, { revision, identity, snapshotProfile })
  return completed
}

/** Identity only: the caller must still run every current strict transaction,
 * helper transform, snapshot, packer and cleanup assertion. No old code executes. */
export function assertReviewedSnapshotProducer({ reference, profile, identity }, selection, load) {
  const bound = fixtureSelections.get(selection)
  ensure(bound && bound.snapshotProfile === profile && snapshotProfiles.includes(profile)
    && ['caseId', 'sourceSha256', 'caseSourcePath'].every(key => identity?.[key] === bound.identity[key]),
  'Snapshot complete producer revision is unknown, mixed or from another consumer')
  const key = { 'github-static-snapshot-v1': 'githubProducer', 'wxml-static-snapshot-v1': 'wxmlProducer',
    'issue1034-static-snapshot-v1': 'issue1034Producer', 'template-native-static-snapshot-v1': 'fixtureProject' }[profile]
  ensure(matches(reference, bound.revision.sources[key], load), 'Snapshot producer differs from its complete reviewed closure')
}

/** The complete same-case producer token also authenticates the archived
 * transport dependency. Current semantic validation still executes below. */
export function assertReviewedSnapshotTransport({ reference, profile, identity }, selection, load) {
  const bound = fixtureSelections.get(selection)
  ensure(bound && bound.snapshotProfile === profile && snapshotProfiles.includes(profile)
    && ['caseId', 'sourceSha256', 'caseSourcePath'].every(key => identity?.[key] === bound.identity[key]),
  'Snapshot transport complete producer revision is unknown, mixed or from another consumer')
  ensure(matches(reference, bound.revision.sources.snapshotTransport, load), 'Snapshot transport differs from its complete reviewed closure')
}
