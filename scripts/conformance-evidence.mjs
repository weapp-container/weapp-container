import { assertSourcePollEvidence } from './conformance-source-poll-evidence.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { inspectEvidenceSource } from './evidence-source.mjs'
import { inspectExecutionFixture, inspectPackExecutionReceipt } from './pack-execution-evidence.mjs'
import { createCompilerUseBuildCache } from './conformance-compiler-use.mjs'
import { inspectConformanceFixtureBuildEvidence } from './conformance-fixture-build.mjs'

export const CONFORMANCE_BASELINE = Object.freeze(JSON.parse(readFileSync(new URL('../docs/conformance/baseline-v1.json', import.meta.url), 'utf8')))
const INDEX_SCHEMA = JSON.parse(readFileSync(new URL('../schemas/conformance-case-index-v1.schema.json', import.meta.url), 'utf8'))
const TRACE_SCHEMA = JSON.parse(readFileSync(new URL('../schemas/conformance-trace-v1.schema.json', import.meta.url), 'utf8'))
const REPORT_SCHEMA = JSON.parse(readFileSync(new URL('../schemas/conformance-differential-v1.schema.json', import.meta.url), 'utf8'))
const ORACLE_SCHEMA = JSON.parse(readFileSync(new URL('../schemas/conformance-oracle-execution-v1.schema.json', import.meta.url), 'utf8'))
const RUNTIME_SCHEMA = JSON.parse(readFileSync(new URL('../schemas/conformance-runtime-observation-v1.schema.json', import.meta.url), 'utf8'))
const HASH = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const STATUS = ['passed', 'failed', 'blocked', 'unknown']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const equal = (left, right) => canonical(left) === canonical(right)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const SCHEMA_KEYS = new Set(['$schema', '$id', '$defs', 'title', 'description', '$ref', 'type', 'const', 'enum', 'required', 'properties',
  'additionalProperties', 'items', 'uniqueItems', 'minItems', 'maxItems', 'minLength', 'pattern', 'minimum', 'format', 'oneOf'])

// The release baseline is intentionally historical. A newer official release
// is informational only after the exact installed/accepted version was opted
// into explicitly; a bare latest-version mismatch is never an exception.
export function acceptsOfficialVersionPolicy(selection) {
  return selection?.officialVersionMatches === true
    || selection?.officialVersionMatches === false && selection.versionPolicy === 'selected-version-opt-in'
      && selection.selectedChannel === 'stable' && /^\d+(?:\.\d+){2,}$/.test(selection.officialVersion ?? '')
      && selection.officialVersion !== CONFORMANCE_BASELINE.devtoolsVersion
}

function require(condition, message) { if (!condition) throw new Error(message) }
function git(root, args, options = {}) {
  return execFileSync('git', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options })
}

// This audit is intentionally dependency-free so CI can run it before pnpm
// installation. Unknown schema keywords fail closed rather than being ignored.
export function schemaErrors(value, schema, at = '$', document = schema) {
  if (schema === true) return []
  if (schema === false || !object(schema)) return [`${at}: false/invalid schema`]
  const errors = Object.keys(schema).filter(key => !SCHEMA_KEYS.has(key)).map(key => `${at}: unsupported schema keyword ${key}`)
  if ('oneOf' in schema) {
    if (!Array.isArray(schema.oneOf) || !schema.oneOf.length) errors.push(`${at}: invalid oneOf alternatives`)
    else {
      const alternatives = schema.oneOf.map(branch => schemaErrors(value, branch, at, document))
      // An unsupported alternative has unknown matching semantics; it cannot
      // be silently treated as false to admit another alternative.
      errors.push(...alternatives.flat().filter(error => error.includes(': unsupported ')))
      if (alternatives.filter(branch => branch.length === 0).length !== 1)
        errors.push(`${at}: oneOf requires exactly one matching alternative`)
    }
  }
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) return [...errors, `${at}: unsupported external schema reference`]
    const target = schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], document)
    errors.push(...schemaErrors(value, target, at, document))
  }
  if ('const' in schema && !equal(value, schema.const)) errors.push(`${at}: const mismatch`)
  if (schema.enum && !schema.enum.some(option => equal(value, option))) errors.push(`${at}: enum mismatch`)
  if (schema.type) {
    const matches = schema.type === 'object' ? object(value) : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'integer' ? Number.isSafeInteger(value) : schema.type === 'null' ? value === null : typeof value === schema.type
    if (!matches) return [...errors, `${at}: expected ${schema.type}`]
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${at}: too short`)
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: pattern mismatch`)
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) errors.push(`${at}: invalid date-time`)
    else if (schema.format && schema.format !== 'date-time') errors.push(`${at}: unsupported format ${schema.format}`)
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum`)
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: too few items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: too many items`)
    if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) errors.push(`${at}: duplicate items`)
    if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items, `${at}[${index}]`, document)))
  }
  if (object(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: missing`)
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) errors.push(...schemaErrors(child, schema.properties[key], `${at}.${key}`, document))
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: additional property`)
      else if (object(schema.additionalProperties)) errors.push(...schemaErrors(child, schema.additionalProperties, `${at}.${key}`, document))
    }
  }
  return errors
}

function caseId(source) {
  const stem = source.replace(/^e2e\/ide\//, '').replace(/\.test\.(ts|tsx|js|jsx|mts|mjs)$/i, '').replace(/\.(ts|tsx|js|jsx|mts|mjs)$/i, '')
  return `ide-${stem.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}`
}

function pinnedSources(root, commit) {
  const directory = resolve(root, 'vendor/weapp-vite')
  const entries = git(directory, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', 'e2e/ide']).toString('utf8').split('\0').filter(Boolean)
    .map(record => { const [header, path] = record.split('\t'); const [mode, type, oid] = header.split(' '); return { mode, type, oid, path } })
    .filter(entry => entry.path.split('/').at(-1).includes('.test.') && /\.(ts|tsx|js|jsx|mts|mjs)$/.test(entry.path))
  require(entries.length === CONFORMANCE_BASELINE.sourceCount, `pinned test set has ${entries.length} files; baseline requires ${CONFORMANCE_BASELINE.sourceCount}`)
  require(entries.every(entry => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)), 'pinned test source contains a non-regular Git blob')
  const batch = git(directory, ['cat-file', '--batch'], { input: entries.map(entry => entry.oid).join('\n') + '\n' })
  let offset = 0
  const sources = entries.map(entry => {
    const newline = batch.indexOf(10, offset)
    require(newline !== -1, 'truncated pinned Git object header')
    const [oid, type, sizeText] = batch.subarray(offset, newline).toString('utf8').split(' ')
    const size = Number(sizeText)
    require(oid === entry.oid && type === 'blob' && Number.isSafeInteger(size) && size >= 0, 'invalid pinned Git object')
    const bytes = batch.subarray(newline + 1, newline + 1 + size)
    require(bytes.length === size && batch[newline + 1 + size] === 10, 'truncated pinned Git source bytes')
    offset = newline + 2 + size
    return { source: entry.path, id: caseId(entry.path), sourceSha256: digest(bytes) }
  })
  require(offset === batch.length && new Set(sources.map(source => source.id)).size === sources.length, 'ambiguous pinned test source set')
  return sources
}

function safeFile(root, path) {
  require(nonempty(path) && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0')
    && path.split('/').every(part => part && part !== '.' && part !== '..'), `unsafe artifact path: ${path}`)
  let current = root
  const parts = path.split('/')
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index])
    const info = lstatSync(current)
    require(!info.isSymbolicLink(), `symlink artifact: ${path}`)
    require(index === parts.length - 1 ? info.isFile() : info.isDirectory(), `not a regular artifact: ${path}`)
  }
  return current
}

export function artifactReader(root) {
  const artifacts = new Map()
  const load = (reference, label, json = false) => {
    require(object(reference) && Object.keys(reference).sort().join(',') === 'bytes,path,sha256'
      && HASH.test(reference.sha256 || '') && Number.isSafeInteger(reference.bytes) && reference.bytes >= 0, `${label}: malformed artifact reference`)
    const key = canonical(reference)
    let artifact = artifacts.get(key)
    if (!artifact) {
      const path = safeFile(root, reference.path)
      const before = statSync(path)
      require(before.size === reference.bytes && before.size <= 1024 * 1024 * 1024, `${label}: artifact byte length differs or exceeds 1 GiB`)
      const hash = createHash('sha256')
      const fd = openSync(path, 'r')
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      try { for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) !== 0;) hash.update(buffer.subarray(0, count)) } finally { closeSync(fd) }
      const after = statSync(path)
      require(before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `${label}: artifact changed during hashing`)
      require(hash.digest('hex') === reference.sha256, `${label}: artifact SHA-256 differs`)
      artifact = { path, stat: after }
      artifacts.set(key, artifact)
    }
    if (!json) return artifact
    require(reference.bytes <= 64 * 1024 * 1024, `${label}: JSON artifact exceeds 64 MiB`)
    if (!Object.hasOwn(artifact, 'json')) artifact.json = JSON.parse(readFileSync(artifact.path, 'utf8'))
    return artifact.json
  }
  const loadBytes = (reference, label) => {
    const artifact = load(reference, label)
    const bytes = readFileSync(artifact.path)
    require(bytes.length === reference.bytes && digest(bytes) === reference.sha256, `${label}: artifact changed while reading bytes`)
    return bytes
  }
  return { root, compilerUseBuildCache: createCompilerUseBuildCache(), load, loadBytes, stable: () => [...artifacts.values()].every(({ path, stat }) => {
    try { const current = statSync(path); return current.ino === stat.ino && current.size === stat.size && current.mtimeMs === stat.mtimeMs && current.ctimeMs === stat.ctimeMs } catch { return false }
  }), size: () => artifacts.size }
}

function baselineFields(value) {
  return object(value) && equal(value, Object.fromEntries(['id', 'devtoolsVersion', 'baseLibraryVersion', 'protocolVersion', 'manifestVersion'].map(key => [key, CONFORMANCE_BASELINE[key]])))
}

function checkTrace(trace, item, oracle, host, engine, fixture, sourceCommit) {
  const errors = schemaErrors(trace, TRACE_SCHEMA)
  require(errors.length === 0, `trace schema: ${errors.slice(0, 4).join('; ')}`)
  require(trace.caseId === item.id && trace.oracle === oracle && trace.run.status === 'passed'
    && trace.run.host === host && trace.run.engine === engine, 'trace case/provider/host/engine/status differs')
  require(trace.run.protocolVersion === CONFORMANCE_BASELINE.protocolVersion && trace.run.manifestVersion === CONFORMANCE_BASELINE.manifestVersion, 'trace protocol/manifest baseline differs')
  require(Number.isFinite(Date.parse(trace.run.startedAt)) && Number.isFinite(Date.parse(trace.run.endedAt))
    && Date.parse(trace.run.endedAt) >= Date.parse(trace.run.startedAt), 'trace timestamps missing or reversed')
  const environment = trace.run.environment
  require(environment?.baselineId === CONFORMANCE_BASELINE.id && environment?.compilerCommit === CONFORMANCE_BASELINE.compiler.commit
    && environment?.caseSourceSha256 === item.sourceSha256 && environment?.manifestIntegrity === fixture.manifest.integrity.root, 'trace baseline/source/input identity differs')
  if (sourceCommit !== undefined) require(trace.run.commit === sourceCommit, 'trace runtime source differs from execution build')
  require(trace.events.length > 0, 'trace has no observations')
  let sequence = -1
  for (const event of trace.events) { require(event.seq > sequence, 'trace sequence is not strictly increasing'); sequence = event.seq }
  require(Array.isArray(trace.assertions) && trace.assertions.length > 0 && trace.assertions.every(assertion => assertion.passed === true)
    && new Set(trace.assertions.map(assertion => assertion.id)).size === trace.assertions.length, 'trace assertions are empty, duplicate or failed')
  return {
    events: trace.events.map(({ atNs: _atNs, ...event }) => event),
    assertions: trace.assertions.map(assertion => assertion.id),
  }
}

function checkOracle(execution, traceReference, trace, item, fixture, fixtureResources, reader) {
  const errors = schemaErrors(execution, ORACLE_SCHEMA)
  require(errors.length === 0, `oracle execution schema: ${errors.slice(0, 4).join('; ')}`)
  require(execution?.schemaVersion === 1 && execution.kind === 'wechat-devtools-case-execution' && execution.status === 'passed', 'oracle execution receipt is missing/legacy')
  require(execution.caseId === item.id && execution.sourceSha256 === item.sourceSha256
    && execution.compilerCommit === CONFORMANCE_BASELINE.compiler.commit && baselineFields(execution.baseline)
    && execution.manifestIntegrity === fixture.manifest.integrity.root && execution.traceSha256 === traceReference.sha256, 'oracle execution identity differs')
  require(execution.sourceUnchanged === true && execution.sourceBefore === item.sourceSha256 && execution.sourceAfter === item.sourceSha256,
    'oracle executed source guard differs from pinned Git bytes')
  require(execution.provider === 'wechat-devtools' && execution.observedDevtoolsVersion === CONFORMANCE_BASELINE.devtoolsVersion
    && execution.observedBaseLibraryVersion === CONFORMANCE_BASELINE.baseLibraryVersion, 'official runtime baseline was not observed')
  require(execution.run?.exitCode === 0 && execution.run.startedAt === trace.run.startedAt && execution.run.endedAt === trace.run.endedAt, 'oracle command/timestamps differ')
  const resources = execution.resources
  require(nonempty(resources?.owner) && resources.leaseAcquired === true && resources.leaseReleased === true
    && resources.ownedResourcesReleased === true && resources.borrowedResourcesPreserved === true, 'oracle resource lease/cleanup is incomplete')
  reader.load(execution.log, 'oracle raw log')
  const selection = reader.load(execution.selection, 'official installation selection', true)
  require(selection.selectedVersion === CONFORMANCE_BASELINE.devtoolsVersion && selection.acceptedVersion === CONFORMANCE_BASELINE.devtoolsVersion
    && selection.packageVersion === CONFORMANCE_BASELINE.devtoolsVersion && selection.baseLibraryVersion === CONFORMANCE_BASELINE.baseLibraryVersion
    && acceptsOfficialVersionPolicy(selection) && HASH.test(selection.installationId || '')
    && Number.isFinite(Date.parse(selection.queriedAt)) && /^https:\/\/(?:developers\.weixin\.qq\.com|devtools\.wxqcloud\.qq\.com\.cn)\//.test(selection.source || ''), 'oracle installation selection is incomplete or from another baseline')
  const runtime = reader.load(execution.runtimeObservation, 'official Tool/wx runtime observation', true)
  require(schemaErrors(runtime, RUNTIME_SCHEMA).length === 0, 'oracle Tool/wx runtime observation is missing or malformed')
  require(runtime.installationId === selection.installationId && isAbsolute(runtime.projectPath)
    && runtime.tool.version === CONFORMANCE_BASELINE.devtoolsVersion
    && runtime.tool.SDKVersion === CONFORMANCE_BASELINE.baseLibraryVersion
    && runtime.system.SDKVersion === CONFORMANCE_BASELINE.baseLibraryVersion,
  'oracle actual Tool/wx runtime baseline or installation differs')
  require(Date.parse(runtime.recordedAt) >= Date.parse(execution.run.startedAt)
    && Date.parse(runtime.recordedAt) <= Date.parse(execution.run.endedAt), 'oracle runtime observation is outside the executed run')
  require(execution.compilerBuild, 'official compiler build evidence is required; retained dist is unverified')
  require(execution.compilerUse, 'oracle actual compiler consumption is required')
  require(execution.fixtureBuild, 'oracle actual case fixture build is required')
  const { schemaVersion: _version, kind: _kind, status: _status, ...actualRuntime } = runtime
  // One verifier owns the complete compiler-build/use/checkpoint/packer chain.
  // Every returned artifact stays in this audit's final stability guard.
  const built = inspectConformanceFixtureBuildEvidence({ root: reader.root, reference: execution.fixtureBuild,
    compilerUse: execution.compilerUse, compilerBuild: execution.compilerBuild, expectedCommit: CONFORMANCE_BASELINE.compiler.commit,
    caseId: item.id, sourceSha256: item.sourceSha256, fixture, resources: fixtureResources,
    runtimeObservation: actualRuntime, compilerBuildCache: reader.compilerUseBuildCache })
  require(built.errors.length === 0, `oracle actual fixture/compiler provenance: ${built.errors.join('; ')}`)
  for (const reference of built.artifactReferences) reader.load(reference, 'oracle fixture build input')
  if (trace.events.some(event => event.op === 'method.poll') || execution.sourcePollJournal) {
    require(execution.sourcePollJournal, 'normalized source poll is missing its complete actual raw journal reference')
    const journal = reader.load(execution.sourcePollJournal, 'source poll complete raw journal', true)
    const checkpoint = reader.load(built.attestation.checkpoint, 'source poll actual build checkpoint', true)
    assertSourcePollEvidence({ trace, journal, build: checkpoint.build, load: reference => reader.loadBytes(reference, 'source poll audited guest source') })
  }
  const consumed = built.compilerUseAttestation
  require(consumed.process.pid === execution.run.pid
    && Date.parse(consumed.startedAt) >= Date.parse(execution.run.startedAt)
    && Date.parse(consumed.endedAt) <= Date.parse(execution.run.endedAt), 'oracle compiler consumption process or execution interval differs')
  const suite = reader.load(execution.suiteReport, 'official runner suite JSON', true)
  require(suite.success === true && Array.isArray(suite.testResults), 'oracle runner JSON does not contain successful test results')
  const result = suite.testResults.filter(result => typeof result?.name === 'string' && result.name.replaceAll('\\', '/').endsWith(`/${item.source}`))
  require(result.length === 1 && result[0].status === 'passed' && Array.isArray(result[0].assertionResults) && result[0].assertionResults.length > 0, 'oracle runner JSON does not contain exactly this passed source file')
  const assertions = result[0].assertionResults
  require(assertions.every(assertion => nonempty(assertion.fullName) && assertion.status === 'passed')
    && new Set(assertions.map(assertion => assertion.fullName)).size === assertions.length
    && equal(assertions.map(assertion => assertion.fullName), trace.assertions.map(assertion => assertion.id)), 'oracle trace assertions do not cover the runner test results')
}

function checkResources(entry, reader) {
  const required = new Set()
  const walk = (value, key = '') => {
    if (Array.isArray(value)) value.forEach(child => walk(child))
    else if (object(value)) Object.entries(value).forEach(([key, child]) => walk(child, key))
    else if (typeof value === 'string') {
      if (['sha256', 'sourceSha256', 'executableSha256'].includes(key) && HASH.test(value)) required.add(value)
      if (['wxmlAst', 'wxssIr'].includes(key) && /^sha256:[0-9a-f]{64}$/.test(value)) required.add(value.slice(7))
    }
  }
  walk(entry.fixture.manifest)
  require(object(entry.resources) && equal(Object.keys(entry.resources).sort(), [...required].sort()), 'fixture resource closure differs from manifest references')
  for (const [sha256, reference] of Object.entries(entry.resources)) {
    require(reference.sha256 === sha256, 'fixture resource key differs from blob hash')
    reader.load(reference, `fixture blob ${sha256}`)
  }
  for (const asset of entry.fixture.manifest.assets) require(entry.resources[asset.sha256]?.bytes === asset.size, 'fixture asset byte length differs from manifest')
}

function checkContainerPair(item, entry, candidate, options, reader, observed) {
  const { root, expectedCommit, sourceCommit, host, engine } = options
  const receipt = candidate?.execution
  require(CONFORMANCE_BASELINE.hosts.includes(receipt?.host) && CONFORMANCE_BASELINE.engines.includes(receipt?.engine), 'unexpected container pair')
  if (host !== undefined || engine !== undefined) require(receipt.host === host && receipt.engine === engine, 'driver substituted the requested host/engine pair')
  const checked = inspectPackExecutionReceipt(receipt, entry.fixture, { root, expectedCommit, expectedCompilerCommit: CONFORMANCE_BASELINE.compiler.commit })
  require(checked.status === 'passed', `actual-pack execution is incomplete: ${checked.missing.join(', ')}`)
  require(receipt.sourceCommit === sourceCommit && receipt.build.sourceCommit === sourceCommit, 'execution and report build sources differ')
  reader.load(candidate.artifact, 'container build artifact')
  require(candidate.artifact.bytes > 0, 'container build artifact is empty')
  require(candidate.artifact.sha256 === receipt.artifactSha256 && candidate.artifact.sha256 === receipt.build.artifactSha256, 'actual build artifact hash differs')
  require(receipt.conformance?.caseId === item.id && receipt.conformance?.sourceSha256 === item.sourceSha256
    && receipt.conformance?.traceSha256 === candidate.trace.sha256 && receipt.conformance?.baselineId === CONFORMANCE_BASELINE.id, 'startup receipt is not bound to this case and trace')
  const trace = reader.load(candidate.trace, 'container normalized trace', true)
  const actual = checkTrace(trace, item, 'container', receipt.host, receipt.engine, entry.fixture, receipt.sourceCommit)
  require(trace.run.environment.sessionId === receipt.sessionId && trace.run.environment.artifactSha256 === candidate.artifact.sha256, 'normalized trace and actual startup session/build differ')
  require(equal(actual, observed), 'normalized observations/assertion coverage differ from official oracle')
  return { status: 'passed', traceSha256: candidate.trace.sha256, sessionId: receipt.sessionId }
}

export function checkReviewedExecutionLink(item, reference, reader) {
  if (item.evidence.includes(reference.path)) return
  for (const path of item.evidence) {
    if (!path.startsWith('docs/conformance/evidence/') || !path.endsWith('/report.json')) continue
    const bytes = readFileSync(safeFile(reader.root, path))
    const review = reader.load({ path, bytes: bytes.length, sha256: digest(bytes) }, 'reviewed case evidence', true)
    if (!/^reviewed-r\d+[a-z]?-official-result$/.test(review?.kind || '') || review.case?.caseId !== item.id) continue
    require(review.case.status === 'passed' && review.case.sourceSha256 === item.sourceSha256,
      'reviewed case evidence identity or official status differs')
    require(review.baseline?.id === CONFORMANCE_BASELINE.id
      && review.baseline.devtoolsVersion === CONFORMANCE_BASELINE.devtoolsVersion
      && review.baseline.baseLibraryVersion === CONFORMANCE_BASELINE.baseLibraryVersion
      && review.baseline.compilerCommit === CONFORMANCE_BASELINE.compiler.commit,
    'reviewed case evidence baseline differs')
    require(review.independentReader?.status === 'passed'
      && review.cleanup?.ownedResourcesReleased === true && review.cleanup?.borrowedResourcesPreserved === true,
    'reviewed case evidence reader or cleanup review is incomplete')
    require(equal(review.receipts?.officialExecution, reference),
      'reviewed case evidence does not link the exact official execution receipt')
    return
  }
  require(false, 'official execution receipt is not linked by reviewed case evidence')
}

function checkCaseOracle(item, entry, reader) {
  require(entry?.sourceSha256 === item.sourceSha256 && entry?.caseId === item.id, 'differential case source identity differs')
  require(item.status === 'passed', 'official case index has not passed this case')
  const fixtureCheck = inspectExecutionFixture(entry.fixture, CONFORMANCE_BASELINE.compiler.commit)
  require(fixtureCheck.status === 'passed', `invalid actual-pack fixture: ${fixtureCheck.missing.join(', ')}`)
  checkResources(entry, reader)
  const oracle = reader.load(entry.oracle.trace, 'official normalized trace', true)
  const observed = checkTrace(oracle, item, 'wechat-devtools', 'devtools', 'wechat', entry.fixture)
  checkOracle(reader.load(entry.oracle.execution, 'official execution receipt', true), entry.oracle.trace, oracle, item, entry.fixture, entry.resources, reader)
  checkReviewedExecutionLink(item, entry.oracle.execution, reader)
  return observed
}

/** Shared admission checks for execution tooling. These do not replace the
 * full index/Git-source audit or establish that a complete matrix exists. */
export function inspectConformanceCaseOracle(item, entry, options) {
  try {
    const reader = artifactReader(realpathSync(options.root))
    checkCaseOracle(item, entry, reader)
    require(reader.stable(), 'referenced artifacts changed during audit')
    return { status: 'passed' }
  } catch (error) { return { status: 'incomplete', error: error.message } }
}

export function inspectConformanceContainerPair(item, entry, candidate, options) {
  try {
    const root = realpathSync(options.root)
    const reader = artifactReader(root)
    const observed = checkCaseOracle(item, entry, reader)
    const result = checkContainerPair(item, entry, candidate, { ...options, root }, reader, observed)
    require(reader.stable(), 'referenced artifacts changed during audit')
    return result
  } catch (error) { return { status: 'incomplete', error: error.message } }
}

/** Inspect full pinned-source, oracle and 7 × 2 differential evidence. Status
 * labels alone are never sufficient. This verifies recorded bytes and scope;
 * it does not attest that an arbitrary author could not fabricate those bytes.
 */
export function inspectConformanceEvidence(indexFile, reportFile, options) {
  const { expectedCommit } = options
  const indexedCases = Array.isArray(indexFile?.value?.cases) ? indexFile.value.cases : []
  const counts = Object.fromEntries(STATUS.map(status => [status, indexedCases.filter(item => item?.status === status).length]))
  const expectedPairs = CONFORMANCE_BASELINE.hosts.flatMap(host => CONFORMANCE_BASELINE.engines.map(engine => `${host}/${engine}`))
  const result = {
    status: 'incomplete', reason: 'pinned-source and differential evidence is incomplete',
    scope: 'pinned-upstream-cases-seven-host-dual-engine-differential',
    primaryOracle: 'wechat-devtools', baseline: CONFORMANCE_BASELINE.id,
    total: Array.isArray(indexFile?.value?.cases) ? indexFile.value.cases.length : 0,
    counts, officialObservations: { counts, meaning: 'Official-case observations; these are not container differential passes.' },
    expectedPairs, sourceValidation: { status: 'incomplete', errors: [] },
    differential: { status: 'incomplete', report: reportFile?.path || null,
      cases: indexedCases.map(item => ({ caseId: item?.id || null, status: 'incomplete', oracle: 'missing', missingPairs: [...expectedPairs], pairs: {}, errors: [] })),
      errors: [], artifactCount: 0 },
    evidenceBoundary: 'Integrity and declared scope of recorded artifacts only. Official provenance and complete assertion capture remain reviewable evidence, not cryptographic execution attestation. Other release gates independently require GPU, device and performance evidence.',
  }
  let root
  try {
    root = realpathSync(options.root)
    require(COMMIT.test(expectedCommit || ''), 'current source revision is missing/invalid')
    require(!indexFile?.error, indexFile?.error || 'missing case index')
    const index = indexFile.value
    const errors = schemaErrors(index, INDEX_SCHEMA)
    require(errors.length === 0, `index schema: ${errors.slice(0, 8).join('; ')}`)
    const pin = git(root, ['rev-parse', `${expectedCommit}:vendor/weapp-vite`]).toString('utf8').trim()
    require(pin === CONFORMANCE_BASELINE.compiler.commit && equal(index.compiler, CONFORMANCE_BASELINE.compiler), 'index/compiler Git pin differs from fixed baseline')
    require(index.oracle.devtoolsVersion === CONFORMANCE_BASELINE.devtoolsVersion && index.oracle.baseLibraryVersion === CONFORMANCE_BASELINE.baseLibraryVersion, 'oracle version differs from fixed baseline')
    require(index.generatedFrom.fileCount === CONFORMANCE_BASELINE.sourceCount && index.cases.length === CONFORMANCE_BASELINE.sourceCount, 'index does not cover all baseline source files')
    const bytes = readFileSync(indexFile.path)
    require(equal(JSON.parse(bytes), index), 'case index bytes differ from parsed input')
    const indexSha256 = digest(bytes)
    const golden = git(root, ['show', `${expectedCommit}:docs/conformance/case-index-v1.sha256`]).toString('utf8').trim()
    require(golden === `${indexSha256}  case-index-v1.json`, 'case index differs from committed golden hash')
    const sources = pinnedSources(root, pin)
    const bySource = new Map(index.cases.map(item => [item.source, item]))
    require(bySource.size === sources.length && new Set(index.cases.map(item => item.id)).size === sources.length, 'duplicate or missing index source/case id')
    for (const source of sources) {
      const item = bySource.get(source.source)
      require(item && item.id === source.id && item.sourceSha256 === source.sourceSha256, `pinned source identity/hash differs: ${source.source}`)
      require(item.oracles.includes('wechat-devtools'), `missing primary oracle: ${item.id}`)
      require(item.status === 'unknown' || (Array.isArray(item.evidence) && item.evidence.length > 0), `reviewed official status has no evidence: ${item.id}`)
      for (const path of item.evidence || []) safeFile(root, path)
    }
    result.sourceValidation = { status: 'passed', compilerCommit: pin, indexSha256, sourceFiles: sources.length, source: 'pinned Git blobs, independent of dirty vendor checkout' }
  } catch (error) {
    result.sourceValidation.errors.push(error.message)
    return result
  }
  if (reportFile?.error || !reportFile?.value) {
    result.differential.errors.push(reportFile?.error || 'missing --conformance-report; official status counts cannot prove container parity')
    return result
  }
  const reader = artifactReader(root)
  try {
    const report = reportFile.value
    const errors = schemaErrors(report, REPORT_SCHEMA)
    require(errors.length === 0, `differential schema: ${errors.slice(0, 8).join('; ')}`)
    require(report.indexSha256 === result.sourceValidation.indexSha256 && baselineFields(report.baseline), 'report index or fixed baseline differs')
    const source = inspectEvidenceSource(root, report.sourceCommit, expectedCommit)
    result.differential.sourceRevision = source
    require(source.compatible, 'differential runtime build is stale/unavailable')
    require(report.cases.length === indexFile.value.cases.length && new Set(report.cases.map(item => item.caseId)).size === report.cases.length, 'differential case set is incomplete or duplicated')
    const entries = new Map(report.cases.map(item => [item.caseId, item]))
    for (const item of indexFile.value.cases) {
      const entry = entries.get(item.id)
      const inspected = result.differential.cases.find(inspected => inspected.caseId === item.id)
      inspected.oracle = 'incomplete'
      try {
        const observed = checkCaseOracle(item, entry, reader)
        inspected.oracle = 'passed'
        const seen = new Set()
        for (const candidate of entry.containers) {
          const receipt = candidate.execution
          const pair = `${receipt?.host}/${receipt?.engine}`
          require(expectedPairs.includes(pair) && !seen.has(pair), `unexpected or duplicate container pair: ${pair}`)
          seen.add(pair)
          try {
            inspected.pairs[pair] = checkContainerPair(item, entry, candidate, { root, expectedCommit, sourceCommit: report.sourceCommit }, reader, observed)
          } catch (error) { inspected.pairs[pair] = { status: 'incomplete', error: error.message } }
        }
        inspected.missingPairs = expectedPairs.filter(pair => inspected.pairs[pair]?.status !== 'passed')
        if (inspected.missingPairs.length === 0) inspected.status = 'passed'
      } catch (error) { inspected.errors.push(error.message) }
    }
    require(reader.stable(), 'referenced artifacts changed during audit')
    result.differential.artifactCount = reader.size()
    if (result.differential.cases.every(item => item.status === 'passed')) {
      result.status = 'passed'
      result.reason = 'all pinned cases match the official oracle on every required host/engine pair'
      result.differential.status = 'passed'
    }
  } catch (error) { result.differential.errors.push(error.message) }
  return result
}
