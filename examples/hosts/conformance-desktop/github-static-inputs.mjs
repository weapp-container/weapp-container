/** Shared immutable original-output projection. Full production oracle/fixture
 * admission remains mandatory; synthetic wrappers grant no formal evidence. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const COMMIT = '0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e'
const BASELINE = 'wechat-devtools-2.02.2609250-sdk-3.17.3'
const require = (condition, message) => { if (!condition) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const safe = path => typeof path === 'string' && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..')
const identities = members => {
  require(Array.isArray(members), 'GitHub generated members are absent')
  const paths = new Set()
  return members.map(item => {
    require(item?.kind === 'file' && safe(item.path) && !paths.has(item.path) && /^[a-f0-9]{64}$/.test(item.artifact?.sha256)
      && Number.isSafeInteger(item.artifact.bytes) && item.artifact.bytes >= 0, 'GitHub generated members are malformed or duplicated')
    paths.add(item.path)
    return { path: item.path, sha256: item.artifact.sha256, bytes: item.artifact.bytes }
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'))
}


const directDirectoryMember = (path, directory) => path.startsWith(directory.path + '/')
  && !path.slice(directory.path.length + 1).includes('/') && path.endsWith(directory.extension)

export function validateGithubStaticInputs({ input, descriptor, label }) {
  require(input?.sourceSha256 === descriptor.sourceSha256 && Array.isArray(input.files), `${label} original static assertion coverage is incomplete`)
  const directories = descriptor.compiledDirectories ?? [], observed = input.directories ?? []
  require(Array.isArray(observed) && observed.length === directories.length, `${label} original static directory coverage is incomplete`)
  for (const [index, directory] of directories.entries()) {
    const value = observed[index]
    require(value && Object.keys(value).sort().join(',') === 'extension,members,path' && value.path === directory.path && value.extension === directory.extension
      && Array.isArray(value.members) && value.members.every(path => safe(path) && directDirectoryMember(path, directory))
      && new Set(value.members).size === value.members.length && isDeepStrictEqual([...value.members].sort(), value.members),
    `${label} original static directory membership is malformed`)
  }
  const paths = [...descriptor.compiledFiles, ...observed.flatMap(directory => directory.members)]
  require(paths.length === input.files.length && new Set(paths).size === paths.length, `${label} original static assertion coverage is incomplete`)
  for (const [index, path] of paths.entries()) {
    const file = input.files[index]
    require(file?.path === path && Buffer.isBuffer(file.bytes) && file.length === file.bytes.length && file.sha256 === hash(file.bytes),
      `${label} original static assertion input changed after capture`)
  }
}

export async function loadGithubStaticInputs({ recipe, loadArtifact, descriptor, assertionIds: ids, label }) {
  const CASE = descriptor.caseId
  const references = new Map()
  const read = async reference => {
    require(reference && Object.keys(reference).sort().join(',') === 'bytes,path,sha256' && safe(reference.path)
      && /^[a-f0-9]{64}$/.test(reference.sha256) && Number.isSafeInteger(reference.bytes) && reference.bytes >= 0,
    `${label} actual artifact reference is malformed`)
    const prior = references.get(reference.path)
    require(!prior || isDeepStrictEqual(prior, reference), `${label} actual artifact path has conflicting identities`)
    const bytes = await loadArtifact(reference)
    require(Buffer.isBuffer(bytes) && bytes.length === reference.bytes && hash(bytes) === reference.sha256,
      `${label} actual artifact bytes differ from their frozen reference`)
    references.set(reference.path, structuredClone(reference))
    return bytes
  }
  const json = async reference => JSON.parse((await read(reference)).toString('utf8'))
  require(recipe?.caseId === CASE && recipe.sourceSha256 === descriptor.sourceSha256 && recipe.fixtureValue?.manifest?.compiler?.commit === COMMIT
    && recipe.oracle?.trace && recipe.oracle?.execution, `${label} replay requires its actual pinned fixture and official oracle references`)
  const trace = await json(recipe.oracle.trace), execution = await json(recipe.oracle.execution)
  require(trace.schemaVersion === 1 && trace.caseId === CASE && trace.oracle === 'wechat-devtools' && trace.run?.status === 'passed'
    && trace.run.host === 'devtools' && trace.run.engine === 'wechat' && trace.run.environment?.baselineId === BASELINE
    && trace.run.environment.compilerCommit === COMMIT && trace.run.environment.caseSourceSha256 === descriptor.sourceSha256
    && trace.run.environment.manifestIntegrity === recipe.fixtureValue.manifest.integrity.root,
  `${label} original trace belongs to another actual case/source/compiler/fixture`)
  require(execution.schemaVersion === 1 && execution.kind === 'wechat-devtools-case-execution' && execution.status === 'passed'
    && execution.caseId === CASE && execution.sourceSha256 === descriptor.sourceSha256 && execution.sourceUnchanged === true
    && execution.compilerCommit === COMMIT && execution.baseline?.id === BASELINE && execution.traceSha256 === recipe.oracle.trace.sha256
    && execution.manifestIntegrity === recipe.fixtureValue.manifest.integrity.root && execution.observedDevtoolsVersion === '2.02.2609250'
    && execution.observedBaseLibraryVersion === '3.17.3', `${label} original execution source/version/trace/fixture binding differs`)
  const suite = await json(execution.suiteReport)
  const sources = suite?.testResults?.filter(result => typeof result?.name === 'string'
    && result.name.replaceAll('\\', '/').endsWith('/' + descriptor.caseSourcePath)) ?? []
  require(suite.success === true && suite.testResults.length === 1 && sources.length === 1 && sources[0].status === 'passed'
    && Array.isArray(sources[0].assertionResults) && sources[0].assertionResults.length === descriptor.plans.length
    && isDeepStrictEqual(sources[0].assertionResults.map(result => ({ id: result.fullName, passed: result.status === 'passed' })), ids.map(id => ({ id, passed: true })))
    && isDeepStrictEqual(trace.assertions, ids.map(id => ({ id, passed: true }))),
  `${label} original ${descriptor.plans.length === 2 ? 'two' : 'four'} non-skipped it results do not match the actual runner source/trace`)
  const fixtureBuild = await json(execution.fixtureBuild)
  require(fixtureBuild.schemaVersion === 1 && fixtureBuild.kind === 'weapp-container.fixture-build' && fixtureBuild.status === 'built'
    && fixtureBuild.caseId === CASE && fixtureBuild.sourceSha256 === descriptor.sourceSha256,
  `${label} original static fixture-build is absent or belongs to another source`)
  const checkpoint = await json(fixtureBuild.checkpoint), fixture = await json(fixtureBuild.fixture)
  require(checkpoint.schemaVersion === 1 && checkpoint.kind === 'weapp-container.static-generated-checkpoint' && checkpoint.status === 'captured'
    && checkpoint.caseId === CASE && checkpoint.sourceSha256 === descriptor.sourceSha256 && isDeepStrictEqual(fixture, recipe.fixtureValue),
  `${label} actual generated checkpoint or executed pack differs from its original fixture`)
  require(checkpoint.build?.producerProfile?.profile === 'github-static-snapshot-v1'
    && checkpoint.build.producerProfile.caseId === CASE && checkpoint.build.producerProfile.sourceSha256 === descriptor.sourceSha256
    && checkpoint.build.producerProfile.caseSourcePath === descriptor.caseSourcePath && checkpoint.producerTransaction,
  `${label} static checkpoint has no exact reviewed GitHub snapshot producer`)
  const transaction = await json(checkpoint.producerTransaction), runtimeObservation = await json(checkpoint.runtimeObservation)
  require(transaction.schemaVersion === 1 && transaction.kind === 'weapp-container.github-producer-transaction'
    && transaction.profile === 'github-static-snapshot-v1' && transaction.runtimeRoot === transaction.runtimeProjectPath
    && runtimeObservation.projectPath === transaction.runtimeProjectPath,
  `${label} runtime generation belongs to another actual SDK snapshot`)
  const runtime = checkpoint.runtimeGenerated
  require(isDeepStrictEqual(identities(runtime), identities(transaction.snapshotFiles.filter(item => !['project.config.json', 'project.private.config.json'].includes(item.path)))),
    `${label} checkpoint generation differs from its actual producer snapshot`)
  const cli = checkpoint.build?.generated, before = await json(fixtureBuild.before), after = await json(fixtureBuild.after)
  require(isDeepStrictEqual(identities(before), identities(runtime)) && isDeepStrictEqual(identities(after), identities(runtime)),
    `${label} packer did not consume the unchanged actual runtime generation`)
  identities(cli)
  require(!cli.some(item => ['project.config.json', 'project.private.config.json'].includes(item.path)),
    `${label} CLI generation contains reserved snapshot config paths`)
  const cliByPath = new Map(cli.map(item => [item.path, item])), runtimeByPath = new Map(runtime.map(item => [item.path, item]))
  const directories = (descriptor.compiledDirectories ?? []).map(directory => {
    const paths = members => members.filter(item => directDirectoryMember(item.path, directory)).map(item => item.path).sort()
    const members = paths(cli)
    require(isDeepStrictEqual(members, paths(runtime)), `${label} original static directory differs from its actual runtime generation`)
    return { ...directory, members }
  })
  const files = []
  for (const path of [...descriptor.compiledFiles, ...directories.flatMap(directory => directory.members)]) {
    const original = cliByPath.get(path), actual = runtimeByPath.get(path)
    require(original && actual && original.artifact.sha256 === actual.artifact.sha256 && original.artifact.bytes === actual.artifact.bytes,
      `${label} original static member is absent or changed before actual launch/pack: ${path}`)
    const bytes = await read(original.artifact)
    await read(actual.artifact)
    files.push({ path, bytes, sha256: hash(bytes), length: bytes.length })
  }
  return { trace, staticInputs: { caseId: CASE, sourceSha256: descriptor.sourceSha256, manifestIntegrity: fixture.manifest.integrity.root, files, ...(directories.length ? { directories } : {}) },
    references: [...references.values()] }
}

