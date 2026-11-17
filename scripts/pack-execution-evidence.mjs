import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { inspectEvidenceSource } from './evidence-source.mjs'
import { modernViewBlobHashes } from './modern-view-pack-resources.mjs'

export const EXECUTION_HOSTS = ['web', 'macos', 'windows', 'linux', 'android', 'ios', 'harmony']
export const EXECUTION_ENGINES = ['quickjs', 'v8']
export const MOBILE_EXECUTION_HOSTS = ['android', 'ios', 'harmony']
const HASH = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const GPU_BACKENDS = {
  web: ['skia-gpu-canvaskit'],
  macos: ['skia-gpu-metal', 'skia-gpu-window'],
  windows: ['skia-gpu-vulkan', 'skia-gpu-gles', 'skia-gpu-window'],
  linux: ['skia-gpu-vulkan', 'skia-gpu-gles', 'skia-gpu-window'],
  android: ['skia-gpu-gles', 'skia-gpu-vulkan'],
  ios: ['skia-gpu-metal'],
  harmony: ['skia-gpu-gles', 'skia-gpu-vulkan', 'skia-gpu-arkui'],
}
const GPU_BOUNDARIES = {
  'skia-gpu-canvaskit': ['runtime-skia-canvaskit-surface'],
  'skia-gpu-window': ['runtime-skia-window-surface'],
  'skia-gpu-gles': ['runtime-skia-gles-framebuffer'],
  'skia-gpu-vulkan': ['runtime-skia-vulkan-surface'],
  'skia-gpu-metal': ['rust-skia-metal-drawable'],
  'skia-gpu-arkui': ['runtime-skia-gles-framebuffer'],
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const sourceChecks = new Map()
const MANIFEST_SCHEMAS = new Map([1, 2, 3].map(version => [version,
  JSON.parse(readFileSync(new URL(`../schemas/container-manifest-v${version}.schema.json`, import.meta.url), 'utf8'))]))
const SCHEMA_KEYWORDS = new Set(['$schema', '$id', '$defs', 'title', 'description', '$ref', 'type', 'const', 'enum', 'allOf', 'not',
  'required', 'properties', 'additionalProperties', 'propertyNames', 'items', 'uniqueItems', 'minItems', 'minLength', 'pattern', 'minimum'])

function sourceCheck(root, source, expected) {
  const key = `${root}/${source}/${expected}`
  if (!sourceChecks.has(key)) sourceChecks.set(key, inspectEvidenceSource(root, source, expected))
  return sourceChecks.get(key)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function parsed(value) {
  if (object(value)) return value
  try { return JSON.parse(value) } catch { return null }
}

// The audit runs before dependency installation in CI. Interpret the exact
// keywords used by the checked-in schema, rejecting any new unsupported
// keyword rather than silently weakening validation when the schema evolves.
function schemaErrors(value, schema = MANIFEST_SCHEMAS.get(value?.schemaVersion), path = '$', rootSchema = schema) {
  if (schema === true) return []
  if (schema === false || !object(schema)) return [`${path}: invalid/false schema`]
  const errors = Object.keys(schema).filter(key => !SCHEMA_KEYWORDS.has(key)).map(key => `${path}: unsupported schema keyword ${key}`)
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) return [...errors, `${path}: unsupported nonlocal schema reference`]
    const target = schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], rootSchema)
    errors.push(...schemaErrors(value, target, path, rootSchema))
  }
  if ('const' in schema && canonical(value) !== canonical(schema.const)) errors.push(`${path}: const mismatch`)
  if (schema.enum && !schema.enum.some(option => canonical(option) === canonical(value))) errors.push(`${path}: enum mismatch`)
  if (schema.allOf) for (const item of schema.allOf) errors.push(...schemaErrors(value, item, path, rootSchema))
  if (schema.not && schemaErrors(value, schema.not, path, rootSchema).length === 0) errors.push(`${path}: forbidden value`)
  if (schema.type) {
    const matches = schema.type === 'object' ? object(value) : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'integer' ? Number.isSafeInteger(value) : schema.type === 'null' ? value === null : typeof value === schema.type
    if (!matches) return [...errors, `${path}: expected ${schema.type}`]
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${path}: too short`)
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: pattern mismatch`)
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`)
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`)
    if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) errors.push(`${path}: duplicate items`)
    if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items, `${path}[${index}]`, rootSchema)))
  }
  if (object(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: missing`)
    for (const [key, child] of Object.entries(value)) {
      if (schema.propertyNames) errors.push(...schemaErrors(key, schema.propertyNames, `${path} key ${key}`, rootSchema))
      if (Object.hasOwn(schema.properties || {}, key)) errors.push(...schemaErrors(child, schema.properties[key], `${path}.${key}`, rootSchema))
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional property`)
      else if (object(schema.additionalProperties)) errors.push(...schemaErrors(child, schema.additionalProperties, `${path}.${key}`, rootSchema))
    }
  }
  return errors
}

function manifestRelationsValid(manifest) {
  try { modernViewBlobHashes(manifest) } catch { return false }
  const modules = manifest.modules
  const viewScripts = manifest.viewScripts || []
  const templates = manifest.templates
  const ids = [...manifest.routes, ...modules, ...viewScripts, ...templates, ...manifest.styles, ...manifest.components].map(value => value.id)
  if (new Set(ids).size !== ids.length) return false
  const moduleIds = new Set(modules.map(value => value.id))
  const viewIds = new Set(viewScripts.map(value => value.id))
  if (modules.some(module => module.id.endsWith('.wxs') || (module.dependencies || []).some(id => !moduleIds.has(id)))) return false
  if (viewScripts.some(module => module.dependencies.some(id => !viewIds.has(id)))) return false
  for (const template of templates) {
    for (const [alias, target] of Object.entries(template.wxsModules || {})) {
      if (!viewIds.has(target)) return false
      if (target.includes('#') && target !== `wxs:${template.id.slice('template:'.length)}#${alias}`) return false
    }
  }
  for (const script of viewScripts) {
    if (!script.id.includes('#')) continue
    const [document, alias] = script.id.slice('wxs:'.length).split('#')
    if (!templates.some(template => template.id === `template:${document}` && template.wxsModules?.[alias] === script.id)) return false
  }
  const paths = manifest.assets.map(asset => asset.path)
  if (new Set(paths).size !== paths.length || paths.some(path => viewIds.has(`wxs:${path}`))) return false
  const modernDocuments = new Set((manifest.modernView?.units ?? []).flatMap(unit => unit.documents.map(document => document.documentId)))
  for (const document of modernDocuments) {
    const template = templates.find(template => template.id === `template:${document}`)
    if (!template || Object.keys(template.wxsModules ?? {}).length) return false
  }
  const compilation = manifest.viewCompilation
  if (compilation) {
    const sources = new Map(viewScripts.map(script => [script.id, script.sha256]))
    const compiledIds = compilation.modules.map(module => module.id)
    if (new Set(compiledIds).size !== compiledIds.length || compiledIds.length !== sources.size
      || compilation.modules.some(module => sources.get(module.id) !== module.sourceSha256)) return false
    const documents = new Map(templates.filter(template => !modernDocuments.has(template.id.slice('template:'.length)))
      .map(template => [template.id.slice('template:'.length), template.wxmlAst]))
    const compiledDocuments = compilation.documents.map(document => document.documentId)
    if (new Set(compiledDocuments).size !== compiledDocuments.length || compiledDocuments.length !== documents.size
      || compilation.documents.some(document => documents.get(document.documentId) !== document.wxmlAst
        || new Set(document.expressions.map(expression => canonical([expression.source, expression.shorthand]))).size !== document.expressions.length)) return false
  }
  return true
}

/**
 * executionEvidence v1 is deliberately separate from protocol/surface smokes.
 * One fixture manifest is shared by explicit host x engine receipts. Each
 * receipt binds the built artifact, actual target, startup requests/responses
 * and (separately) the presented GPU frame. Historical loose logs remain
 * diagnostics; missing fields cannot turn a default QuickJS run into a pair.
 */
export function inspectExecutionFixture(fixture, expectedCompilerCommit) {
  const manifest = fixture?.manifest
  const modules = Array.isArray(manifest?.modules) ? manifest.modules : []
  const ids = modules.map(module => module?.id)
  const root = manifest?.integrity?.root
  const validationErrors = schemaErrors(manifest)
  let calculatedRoot = null
  if (object(manifest)) {
    const input = { ...manifest, integrity: { algorithm: 'sha256', root: '' } }
    calculatedRoot = createHash('sha256').update(canonical(input), 'utf8').digest('hex')
  }
  const checks = {
    fixtureId: nonempty(fixture?.id),
    schema: validationErrors.length === 0,
    relations: validationErrors.length === 0 && manifestRelationsValid(manifest),
    manifestVersion: [1, 2, 3].includes(manifest?.schemaVersion) && manifest?.protocolVersion === '1.0',
    compiler: manifest?.compiler?.name === 'weapp-vite' && manifest?.compiler?.platform === 'weapp'
      && COMMIT.test(expectedCompilerCommit || '') && manifest.compiler.commit === expectedCompilerCommit,
    manifestIntegrity: manifest?.integrity?.algorithm === 'sha256' && HASH.test(root || '') && root === calculatedRoot,
    modules: modules.length > 0 && modules.every(module => nonempty(module?.id) && HASH.test(module?.sha256 || '')
      && ['commonjs', 'esm', 'json'].includes(module?.format)) && new Set(ids).size === ids.length,
    app: nonempty(manifest?.app?.entryModule) && ids.includes(`module:${manifest.app.entryModule}`),
    routes: Array.isArray(manifest?.routes) && manifest.routes.length > 0
      && manifest.routes.every(route => nonempty(route?.path) && nonempty(route?.entryModule)
        && ids.includes(`module:${route.entryModule}`)),
    templates: Array.isArray(manifest?.templates) && manifest.templates.length > 0
      && manifest.templates.every(template => nonempty(template?.id) && /^sha256:[0-9a-f]{64}$/.test(template?.wxmlAst || '')),
  }
  return {
    status: Object.values(checks).every(Boolean) ? 'passed' : 'incomplete',
    id: fixture?.id || null,
    manifestIntegrity: root || null,
    moduleCount: modules.length,
    calculatedRoot,
    schemaErrors: validationErrors,
    checks,
    missing: Object.keys(checks).filter(key => !checks[key]),
  }
}

function runtimeHostMatches(host, metadata) {
  if (['macos', 'windows', 'linux'].includes(host)) {
    return metadata?.kind === 'desktop' && (metadata?.platform === host || (host === 'macos' && metadata?.platform === 'darwin'))
  }
  // Harmony's Rust target reports linux, so host.kind is authoritative for
  // adapter identity. The target receipt proves the actual device boundary.
  return metadata?.kind === host
}

function inspectOperation(receipt, operation) {
  const record = receipt?.operations?.[operation]
  const request = parsed(record?.request ?? record?.requestJson)
  const batch = parsed(record?.json)
  const messages = Array.isArray(batch?.messages) ? batch.messages : []
  const responses = messages.filter(message => message?.kind === 'response' && message?.op === operation)
  const response = responses.length === 1 ? responses[0] : null
  const checks = {
    abiStatus: record?.status === 0,
    request: request?.kind === 'request' && request?.op === operation && nonempty(request?.requestId)
      && request?.sessionId === receipt?.sessionId && request?.protocolVersion === '1.0',
    response: response?.payload?.ok === true && response?.requestId === request?.requestId
      && response?.sessionId === receipt?.sessionId && response?.protocolVersion === '1.0',
    errors: !messages.some(message => message?.op === 'error' || message?.kind === 'error'
      || (message?.kind === 'response' && message?.payload?.ok === false)),
  }
  return { checks, request, response, status: Object.values(checks).every(Boolean) ? 'passed' : 'incomplete' }
}

export function inspectPackExecutionReceipt(receipt, fixture, options) {
  const { root, expectedCommit, expectedCompilerCommit } = options
  const fixtureCheck = inspectExecutionFixture(fixture, expectedCompilerCommit)
  const host = receipt?.host
  const engine = receipt?.engine
  const sourceRevision = sourceCheck(root, receipt?.sourceCommit, expectedCommit)
  const buildSourceRevision = sourceCheck(root, receipt?.build?.sourceCommit, expectedCommit)
  const operations = Object.fromEntries(['app.init', 'app.lifecycle', 'page.push', 'render.commit']
    .map(operation => [operation, inspectOperation(receipt, operation)]))
  const init = operations['app.init'].response?.payload
  const render = operations['render.commit'].response?.payload
  const routes = Array.isArray(fixture?.manifest?.routes) ? fixture.manifest.routes : []
  const templates = Array.isArray(fixture?.manifest?.templates) ? fixture.manifest.templates : []
  const route = routes.find(route => route?.path === receipt?.route)
  const templateId = `template:${receipt?.route}.wxml`
  const snapshotRecord = receipt?.operations?.['render.snapshot']
  const snapshot = parsed(snapshotRecord?.json)
  const pixelCount = snapshot?.width * snapshot?.height * 4
  const pixels = snapshot?.pixels
  const validPixels = pixels === undefined || (Array.isArray(pixels) && pixels.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255))
  const completePixels = Array.isArray(pixels) && pixels.length === pixelCount && validPixels
  const calculatedSnapshotSha256 = completePixels ? createHash('sha256').update(Buffer.from(pixels)).digest('hex') : null
  const snapshotSha256 = calculatedSnapshotSha256 || snapshot?.sha256 || null
  const snapshotBytesValid = validPixels && HASH.test(snapshotSha256 || '')
    && (snapshot?.sha256 === undefined || snapshot.sha256 === snapshotSha256)
    && (completePixels || (snapshot?.pixelCount === pixelCount && HASH.test(snapshot?.sha256 || '')
      && (pixels === undefined || pixels.length < pixelCount)))
  const requestIds = Object.values(operations).map(operation => operation.request?.requestId)
  const checks = {
    status: receipt?.status === 'passed',
    host: EXECUTION_HOSTS.includes(host),
    engine: EXECUTION_ENGINES.includes(engine),
    fixture: fixtureCheck.status === 'passed' && receipt?.fixtureId === fixture?.id,
    manifestIntegrity: receipt?.manifestIntegrity === fixtureCheck.manifestIntegrity,
    source: sourceRevision.compatible && buildSourceRevision.compatible,
    build: receipt?.build?.status === 'passed' && receipt.build.workingTreeDirty === false
      && receipt.build.host === host && receipt.build.engine === engine
      && HASH.test(receipt?.artifactSha256 || '') && receipt.build.artifactSha256 === receipt.artifactSha256,
    target: receipt?.target?.host === host && nonempty(receipt?.target?.id)
      && (MOBILE_EXECUTION_HOSTS.includes(host)
        ? ['official-simulator', 'device'].includes(receipt?.target?.kind)
        : receipt?.target?.kind === (host === 'web' ? 'browser' : 'native-window')),
    session: nonempty(receipt?.sessionId) && init?.sessionId === receipt.sessionId,
    operations: Object.values(operations).every(operation => operation.status === 'passed')
      && new Set(requestIds).size === requestIds.length,
    init: init?.engine === engine && init?.engineProviderAvailable === true && init?.appLaunchInvoked === true
      && runtimeHostMatches(host, init?.host) && init?.manifest?.integrity === fixtureCheck.manifestIntegrity
      && init?.loadedModules === fixtureCheck.moduleCount && fixtureCheck.moduleCount > 0
      && canonical(operations['app.init'].request?.payload?.manifest) === canonical(fixture?.manifest),
    lifecycle: operations['app.lifecycle'].request?.payload?.event === 'launch',
    route: Boolean(route) && operations['page.push'].request?.payload?.path === receipt?.route
      && operations['page.push'].response?.payload?.page?.path === receipt?.route
      && Number.isInteger(operations['page.push'].response?.payload?.pageId) && operations['page.push'].response.payload.pageId > 0,
    render: render?.committed === true && render?.source === 'manifest' && Number.isInteger(render?.frameId) && render.frameId > 0
      && render?.templateId === templateId && operations['render.commit'].request?.payload?.templateId === templateId
      && templates.some(template => template?.id === templateId),
    snapshot: snapshotRecord?.status === 0 && snapshotRecord?.sessionId === receipt?.sessionId
      && snapshot?.frame_id === render?.frameId && Number.isInteger(snapshot?.width) && snapshot.width > 0
      && Number.isInteger(snapshot?.height) && snapshot.height > 0
      && snapshot?.format === 'rgba8-premultiplied'
      && snapshotBytesValid,
  }
  const surface = receipt?.surfaceProbe
  const gpuChecks = {
    execution: Object.values(checks).every(Boolean),
    status: surface?.schemaVersion === 1 && surface?.status === 'passed',
    host: surface?.host === host && surface?.engine === engine,
    session: surface?.sessionId === receipt?.sessionId && surface?.manifestIntegrity === fixtureCheck.manifestIntegrity
      && surface?.frameId === render?.frameId,
    snapshot: HASH.test(snapshotSha256 || '') && surface?.snapshotSha256 === snapshotSha256,
    surface: surface?.hostSurfaceAttached === true && surface?.containerSurfaceAttached === true && surface?.gpuSurface === true,
    backend: Array.isArray(GPU_BACKENDS[host]) && GPU_BACKENDS[host].includes(surface?.rendererBackend)
      && Array.isArray(GPU_BOUNDARIES[surface?.rendererBackend]) && GPU_BOUNDARIES[surface.rendererBackend].includes(surface?.evidenceBoundary),
  }
  const missing = Object.keys(checks).filter(key => !checks[key])
  const gpuMissing = Object.keys(gpuChecks).filter(key => !gpuChecks[key])
  return {
    status: missing.length === 0 ? 'passed' : 'incomplete',
    host: host || null,
    engine: engine || null,
    fixtureId: receipt?.fixtureId || null,
    manifestIntegrity: receipt?.manifestIntegrity || null,
    sessionId: receipt?.sessionId || null,
    loadedModules: init?.loadedModules ?? null,
    observedEngine: init?.engine || null,
    snapshotSha256,
    sourceRevision,
    buildSourceRevision,
    checks,
    missing,
    operations: Object.fromEntries(Object.entries(operations).map(([op, value]) => [op, { status: value.status, checks: value.checks }])),
    gpu: { status: gpuMissing.length === 0 ? 'passed' : 'incomplete', checks: gpuChecks, missing: gpuMissing },
  }
}

/** Missing/legacy evidence is readable but cannot satisfy a required pair. */
export function inspectPackExecutionMatrix(files, options) {
  const hosts = options.hosts || EXECUTION_HOSTS
  const expectedPairs = hosts.flatMap(host => EXECUTION_ENGINES.map(engine => `${host}/${engine}`))
  const inspected = []
  const inputs = []
  let fixture = null
  let fixtureIdentity = null
  for (const file of files) {
    const report = file?.value
    const evidence = report?.executionEvidence
    if (file?.error || !evidence) {
      inputs.push({ path: file?.path || null, status: 'incomplete', reason: file?.error || 'legacy report has no executionEvidence v1 receipts' })
      continue
    }
    // Producers may add build/source diagnostics to the fixture. The shared
    // program identity is its explicit id and verified content root.
    const identity = canonical({ id: evidence.fixture?.id, manifestIntegrity: evidence.fixture?.manifest?.integrity?.root })
    const supported = evidence.schemaVersion === 1 && Array.isArray(evidence.receipts)
    const sourceRevision = sourceCheck(options.root, report?.sourceCommit || report?.commit, options.expectedCommit)
    if (!fixture && supported) { fixture = evidence.fixture; fixtureIdentity = identity }
    const fixtureMatches = identity === fixtureIdentity
    const inputOk = supported && fixtureMatches && sourceRevision.compatible
    inputs.push({ path: file?.path || null, status: inputOk ? 'passed' : 'incomplete', sourceRevision, fixtureMatches, supported })
    for (const receipt of Array.isArray(evidence.receipts) ? evidence.receipts : []) {
      if (!hosts.includes(receipt?.host) && EXECUTION_HOSTS.includes(receipt?.host)) continue
      const result = inspectPackExecutionReceipt(receipt, evidence.fixture, options)
      inspected.push({ ...result, path: file?.path || null, inputAccepted: inputOk })
    }
  }
  const fixtureCheck = inspectExecutionFixture(fixture, options.expectedCompilerCommit)
  const candidates = new Map(expectedPairs.map(pair => [pair, []]))
  const unexpectedPairs = []
  for (const receipt of inspected) {
    const pair = `${receipt.host}/${receipt.engine}`
    if (!candidates.has(pair)) unexpectedPairs.push(pair)
    else candidates.get(pair).push(receipt)
  }
  const duplicatePairs = [...candidates].filter(([, values]) => values.length > 1).map(([pair]) => pair)
  const pairs = Object.fromEntries([...candidates].map(([pair, values]) => [pair, {
    status: values.length === 1 && values[0].inputAccepted && values[0].status === 'passed' ? 'passed' : 'incomplete',
    gpuStatus: values.length === 1 && values[0].inputAccepted && values[0].gpu.status === 'passed' ? 'passed' : 'incomplete',
    receipts: values,
  }]))
  const missingPairs = expectedPairs.filter(pair => pairs[pair].status !== 'passed')
  const gpuMissingPairs = expectedPairs.filter(pair => pairs[pair].gpuStatus !== 'passed')
  const complete = fixtureCheck.status === 'passed' && missingPairs.length === 0 && duplicatePairs.length === 0 && unexpectedPairs.length === 0
  return {
    status: complete ? 'passed' : 'incomplete',
    reason: complete ? 'every required host/engine executed the same integrity-checked portable fixture' : 'same-fixture host/engine execution receipts are missing, stale or invalid',
    fixture: fixtureCheck,
    expectedPairs,
    pairs,
    missingPairs,
    duplicatePairs,
    unexpectedPairs,
    gpu: {
      status: complete && gpuMissingPairs.length === 0 ? 'passed' : 'incomplete',
      missingPairs: gpuMissingPairs,
      reason: 'GPU proof requires the executed manifest, session and committed frame on an attached container GPU surface; device contexts and blank frames cannot substitute.',
    },
    inputs,
    evidenceBoundary: 'Only the listed portable fixture and explicit host/engine receipts are covered. Protocol-only, software and legacy reports do not establish actual-pack or GPU conformance; this is not full API/device or near-parity approval.',
  }
}

/**
 * Assemble device-owned receipts without inventing their build provenance.
 * The harness knows which artifact and target it launched; it does not know
 * which source built that artifact unless the saved build record says so.
 */
export function collectPackExecutionEvidence(platforms) {
  let fixture = null
  const receipts = []
  for (const platform of platforms) {
    const raw = platform?.executionReceipt
    if (!object(raw) || raw.schemaVersion !== 1 || !object(raw.fixture)) continue
    if (!fixture) fixture = raw.fixture
    const { fixture: _fixture, ...receipt } = raw
    receipts.push({
      ...receipt,
      artifactSha256: platform.artifactSha256 || receipt.artifactSha256 || null,
      target: platform.executionTarget || receipt.target || null,
    })
  }
  return { schemaVersion: 1, fixture, receipts }
}
