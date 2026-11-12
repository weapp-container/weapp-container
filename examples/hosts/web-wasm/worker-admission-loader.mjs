/** Static pack admission and pinned CanvasKit drawing resources only.
 * This module never imports runtime-worker/app/pkg, creates an AppService,
 * executes application JS, downloads pack blobs or contacts a runtime /api. */
export const WORKER_RENDERER_PINS = Object.freeze({
  "javascript": {
    "sha256": "894815b2d39b24de2eacdb01453778d83e0b6c418b034e3b728e80956ac2a9d5",
    "size": 123707
  },
  "wasm": {
    "sha256": "aca7fa6019f95d3de98d4a49ae60a3d66a09e9d5ca74091fbc369b9be959f959",
    "size": 8242911
  },
  "license": {
    "sha256": "d27678cba0d529e77201e2d2a053628143e986aad8f1e77f7039ad4366c8f978",
    "size": 1635
  },
  "package": {
    "sha256": "81ecbaba46a245d6e7d317c805462f2efc21ec252577eae88ff99ed406928997",
    "size": 2359
  },
  "font": {
    "sha256": "916bd5146cd1099aff18931fd0c85f4f3fd1ff7b2c966cb3cc22a4e5a6216983",
    "size": 10595952
  },
  "fontLicense": {
    "sha256": "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9",
    "size": 4388
  }
})
for (const pin of Object.values(WORKER_RENDERER_PINS)) Object.freeze(pin)

export class WorkerAdmissionError extends Error {
  constructor(code, message, details) {
    super(message); this.name = 'WorkerAdmissionError'; this.code = code
    if (details !== undefined) this.details = details
  }
}
const fail = (code, message, details) => { throw new WorkerAdmissionError(code, message, details) }
const check = (condition, code, message) => { if (!condition) fail(code, message) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const profiles = new Set(['skia', 'skyline-compat', 'webview'])
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true })
const FONT_CACHE_NAME = 'weapp-container-showcase-font-v1'
export const WORKER_RENDERER_LEASE_LIMITS = Object.freeze({
  preparationWaiters: 16, staticLeases: 16, ownerLeases: 3,
  ownerFontBytes: 64 * 1024 * 1024, initializations: 4,
})
export const WORKER_ADMISSION_LIMITS = Object.freeze({
  indexBytes: 2 * 1024 * 1024, manifestBytes: 8 * 1024 * 1024,
  declaredPackBytes: 128 * 1024 * 1024, rendererBytes: 32 * 1024 * 1024,
  blobCount: 16384, jsonNodes: 262144, jsonDepth: 128,
})
const defaultSha256 = async bytes => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)),
  value => value.toString(16).padStart(2, '0')).join('')
const cancelled = signal => signal?.aborted
  ? new WorkerAdmissionError('ERR_CANCELLED', 'static admission or renderer resource lease was cancelled', { reason: String(signal.reason ?? '') }) : null
const ensureActive = signal => { const error = cancelled(signal); if (error) throw error }
function validateSignal(signal) {
  check(signal === undefined || signal !== null && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function',
  'ERR_INVALID_REQUEST', 'signal must be an AbortSignal')
  ensureActive(signal)
}
function freezeData(root) {
  const stack = [root], seen = new WeakSet()
  while (stack.length) {
    const value = stack.pop()
    if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value)
      for (const child of Object.values(value)) stack.push(child)
      Object.freeze(value)
    }
  }
  return root
}
function validateJson(value) {
  const stack = [{ value, depth: 0 }]; let nodes = 0
  while (stack.length) {
    const entry = stack.pop(); nodes++
    check(nodes <= WORKER_ADMISSION_LIMITS.jsonNodes && entry.depth <= WORKER_ADMISSION_LIMITS.jsonDepth,
      'ERR_INVALID_MANIFEST', 'JSON exceeds the node/depth admission budget')
    if (entry.value && typeof entry.value === 'object') {
      for (const child of Object.values(entry.value)) stack.push({ value: child, depth: entry.depth + 1 })
    } else check(entry.value === null || ['string', 'boolean'].includes(typeof entry.value)
      || typeof entry.value === 'number' && Number.isFinite(entry.value),
      'ERR_INVALID_MANIFEST', 'admission requires finite JSON data')
  }
  return value
}
function parseJson(bytes) {
  let value
  try { value = JSON.parse(decoder.decode(bytes)) }
  catch { fail('ERR_INVALID_MANIFEST', 'static metadata must be valid UTF-8 JSON') }
  return validateJson(value)
}
function canonicalJson(value) {
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).map(key => ({ key, bytes: encoder.encode(key) }))
  keys.sort((a, b) => {
    for (let index = 0; index < Math.min(a.bytes.length, b.bytes.length); index++) {
      if (a.bytes[index] !== b.bytes[index]) return a.bytes[index] - b.bytes[index]
    }
    return a.bytes.length - b.bytes.length
  })
  return `{${keys.map(({ key }) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}
function staticUrl(input, base, origin) {
  let url, decoded
  try {
    check(typeof input === 'string' && input.length > 0 && input.length <= 8192,
      'ERR_PERMISSION_DENIED', 'static resource URL is invalid')
    url = new URL(input, base)
    decoded = url.pathname
    // Reject nested encoding instead of allowing an encoded runtime endpoint.
    for (let count = 0; count < 16; count++) {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
      check(count < 15, 'ERR_PERMISSION_DENIED', 'static URL encoding exceeds its validation budget')
    }
  } catch (error) {
    if (error instanceof WorkerAdmissionError) throw error
    fail('ERR_PERMISSION_DENIED', 'static resource URL cannot be decoded')
  }
  check(['http:', 'https:'].includes(url.protocol) && url.origin === origin && !url.username && !url.password && !url.hash,
    'ERR_PERMISSION_DENIED', 'admission requires same-origin static HTTP(S) URLs')
  check(!decoded.replaceAll('\\', '/').split('/').some(part => part.toLowerCase() === 'api'),
    'ERR_PERMISSION_DENIED', 'static admission cannot access runtime /api endpoints')
  return url
}
function withCleanup(error, failures) {
  if (!failures.length) return error
  if (!error) return new WorkerAdmissionError('ERR_RENDER', 'static resource cleanup failed', { cleanupErrors: failures.map(String) })
  return new WorkerAdmissionError(error.code || 'ERR_RENDER', error.message || String(error), {
    ...(error.details === undefined ? {} : { originalDetails: error.details }), cleanupErrors: failures.map(String),
  })
}
async function boundedBytes(fetchResource, url, { signal, limit, expected, budget, cacheable = false, verifyCachedBytes }) {
  ensureActive(signal)
  let response, reader, complete = false, error, output, cache, fromNetwork = false
  const chunks = []; let length = 0
  try {
    // Await the real fetch/read/cancel lifecycle. An injected implementation
    // which ignores abort cannot provide an early successful cleanup barrier.
    // Immutable static resources may already have been fetched by the worker.
    // Respect HTTP cache headers while independently verifying every returned
    // byte, including cached responses, against the exact size/SHA-256 pin.
    if (cacheable && globalThis.caches?.open) {
      try { cache = await globalThis.caches.open(FONT_CACHE_NAME); response = await cache.match(url.href) } catch { cache = undefined }
    }
    if (!response) {
      response = await fetchResource(url.href, { signal, redirect: 'error', credentials: 'same-origin', cache: 'default' })
      fromNetwork = true
    }
    check(typeof response?.body?.getReader === 'function', 'ERR_INVALID_MANIFEST', 'static resource requires a bounded readable stream')
    reader = response.body.getReader()
    ensureActive(signal)
    check(response.ok, 'ERR_INVALID_MANIFEST', `static resource returned HTTP ${response.status}`)
    check(!response.redirected && (!response.url || new URL(response.url).href === url.href),
      'ERR_PERMISSION_DENIED', 'static resource redirected')
    const header = response.headers?.get('content-length')
    if (header !== null && header !== undefined) {
      check(/^(?:0|[1-9][0-9]*)$/.test(header), 'ERR_INVALID_MANIFEST', 'invalid static Content-Length')
      const count = Number(header)
      const encoding = response.headers?.get('content-encoding')?.trim().toLowerCase()
      const identity = !encoding || encoding === 'identity'
      // Browser fetch exposes decoded bytes; an encoded response's wire size
      // cannot equal the decoded content pin. Exactness remains on actual bytes.
      check(Number.isSafeInteger(count) && count <= (identity ? limit : budget.limit)
        && (!identity || expected === undefined || count === expected),
        'ERR_INVALID_MANIFEST', 'static Content-Length differs from its exact pin or byte budget')
    }
    while (true) {
      ensureActive(signal)
      const part = await reader.read()
      ensureActive(signal)
      if (part.done) { complete = true; break }
      check(part.value instanceof Uint8Array, 'ERR_INVALID_MANIFEST', 'static stream returned non-byte data')
      length += part.value.byteLength; budget.bytes += part.value.byteLength
      check(length <= limit && budget.bytes <= budget.limit && (expected === undefined || length <= expected),
        'ERR_INVALID_MANIFEST', 'static stream exceeds its exact pin or byte budget')
      // Own each chunk: a custom stream may reuse/mutate its transfer buffer.
      chunks.push(part.value.slice())
    }
    check(expected === undefined || length === expected, 'ERR_INVALID_MANIFEST', 'static resource length differs from its exact pin')
    output = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  } catch (failure) { error = cancelled(signal) || failure }
  const failures = []
  if (reader) {
    if (!complete) { try { await reader.cancel(error) } catch (failure) { failures.push(failure) } }
    try { reader.releaseLock() } catch (failure) { failures.push(failure) }
  } else if (response?.body && typeof response.body.cancel === 'function') {
    try { await response.body.cancel(error) } catch (failure) { failures.push(failure) }
  }
  error = withCleanup(error, failures)
  if (error) throw error
  ensureActive(signal)
  if (cacheable) {
    try { await verifyCachedBytes(output) } catch (error) { await cache?.delete(url.href).catch(() => {}); throw error }
    if (cache && fromNetwork) await cache.put(url.href, new Response(output, { headers: { 'content-length': String(output.length), 'content-type': 'font/ttf' } })).catch(() => {})
  }
  return output
}
function policy(value) {
  check(record(value), 'ERR_INVALID_REQUEST', 'rendererPolicy must be explicit')
  if (value.mode === 'manifest' && Object.keys(value).length === 1) return Object.freeze({ mode: 'manifest' })
  if (value.mode === 'force' && Object.keys(value).length === 2 && profiles.has(value.profile)) {
    return Object.freeze({ mode: 'force', profile: value.profile })
  }
  fail('ERR_INVALID_REQUEST', 'rendererPolicy must be {mode:manifest} or {mode:force,profile}')
}
function routePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[?#\\\u0000-\u001f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..')
}
function declaredProfile(manifest, route) {
  check([1, 2, 3].includes(manifest.schemaVersion), 'ERR_INVALID_MANIFEST', 'unsupported manifest schema version')
  const rendering = manifest.rendering
  check((manifest.schemaVersion === 3) === (rendering !== undefined && rendering !== null),
    'ERR_INVALID_MANIFEST', 'rendering declarations require manifest schema 3')
  if (rendering === undefined || rendering === null) return 'skia'
  check(record(rendering) && rendering.version === '1.0' && profiles.has(rendering.default) && record(rendering.pages),
    'ERR_INVALID_MANIFEST', 'invalid manifest rendering declaration')
  for (const [path, profile] of Object.entries(rendering.pages)) {
    check(manifest.routes.some(item => item.path === path) && profiles.has(profile),
      'ERR_INVALID_MANIFEST', 'rendering declaration names an absent route or unsupported profile')
  }
  return Object.hasOwn(rendering.pages, route) ? rendering.pages[route] : rendering.default
}
function rendererDescriptors(config, base) {
  check(record(config) && config.schemaVersion === 1 && config.renderer === 'canvaskit' && config.fallback === 'error'
    && config.canvaskit?.version === '0.42.0' && config.canvaskit.variant === 'full',
    'ERR_RENDER', 'only pinned CanvasKit 0.42.0 full with explicit error fallback is admitted')
  const raw = { javascript: config.canvaskit.javascript, wasm: config.canvaskit.wasm,
    license: config.canvaskit.license, package: config.canvaskit.package, font: config.font?.binary, fontLicense: config.font?.license }
  const result = {}
  for (const [key, pin] of Object.entries(WORKER_RENDERER_PINS)) {
    const descriptor = raw[key]
    check(record(descriptor) && descriptor.sha256 === pin.sha256 && descriptor.size === pin.size,
      'ERR_RENDER', `renderer ${key} must match the compiled version/size/SHA-256 pin`)
    result[key] = Object.freeze({ ...pin, location: staticUrl(descriptor.url, base, base.origin) })
  }
  check(Object.values(WORKER_RENDERER_PINS).reduce((sum, pin) => sum + pin.size, 0) <= WORKER_ADMISSION_LIMITS.rendererBytes,
    'ERR_RENDER', 'compiled renderer resources exceed the loader byte budget')
  return result
}
function rendererOwner(owner, result, attachment) {
  check(record(owner) && ['workerEpoch', 'sessionId'].every(key => typeof owner[key] === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner[key])) && digest(owner.packSha256)
    && owner.transportBackend === 'external-frame', 'ERR_PROTOCOL_VERSION', 'renderer lease needs the exact external Worker owner')
  if (attachment !== undefined) {
    const runtime = attachment?.runtimeOwner, binding = attachment?.presenterBinding, observation = attachment?.observation
    const contract = result?.rendererTransitions, required = ['version', 'runtimeOwner', 'presenterBinding', 'inputLifetime', 'transitionFinal', 'observation']
    const decimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)
      && value.length <= 20 && BigInt(value) <= 18446744073709551615n
    check(record(attachment) && Object.keys(attachment).length === 4 && attachment.version === '1.0'
      && record(runtime) && Object.keys(runtime).length === 3 && record(result.runtimeOwner)
      && Object.keys(result.runtimeOwner).length === 3
      && ['workerEpoch', 'sessionId', 'packSha256'].every(key => runtime[key] === owner[key] && runtime[key] === result.runtimeOwner[key])
      && result.pack?.indexSha256 === owner.packSha256 && record(contract) && Object.keys(contract).length === required.length
      && required.every(key => contract[key] === (key === 'observation' ? '2.0' : '1.0'))
      && record(binding) && Object.keys(binding).length === 4 && binding.version === '1.0'
      && binding.sessionId === owner.sessionId && binding.transportBackend === 'external-frame'
      && decimal(binding.generation) && binding.generation !== '0' && binding.generation === owner.presenterGeneration
      && record(observation) && observation.version === '2.0' && decimal(observation.sequence)
      && observation.sequence !== '0' && record(observation.state?.owner)
      && Object.keys(observation.state.owner).length === 3
      && ['workerEpoch', 'sessionId', 'packSha256'].every(key => observation.state.owner[key] === runtime[key])
      && observation.state.sessionId === owner.sessionId && observation.state.transportBackend === 'external-frame'
      && record(observation.state.presenterBinding) && Object.keys(binding).every(key => binding[key] === observation.state.presenterBinding[key])
      && observation.state.transitionRequired === false && observation.state.requiresRestart === false,
    'ERR_PROTOCOL_VERSION', 'renderer attachment needs the committed generation of the original negotiated Worker')
    check(record(result.externalPresentation) && Object.keys(result.externalPresentation).length === 4
      && ['version', 'consumedInput', 'ackOutcome', 'physicalTarget'].every(key => result.externalPresentation[key] === '1.0'),
    'ERR_PROTOCOL_VERSION', 'renderer attachment requires pre-init external presentation negotiation')
    return
  }
  check(record(result) && result.transportBackend === 'external-frame' && result.pack?.indexSha256 === owner.packSha256
    && result.state?.sessionId === owner.sessionId && result.state.transportBackend === 'external-frame'
    && record(result.externalPresentation) && Object.keys(result.externalPresentation).length === 4
    && ['version', 'consumedInput', 'ackOutcome', 'physicalTarget'].every(key => result.externalPresentation[key] === '1.0'),
    'ERR_PROTOCOL_VERSION', 'renderer lease must follow the matching verified external Worker load')
}

/** A page-scoped service; its one successful pinned drawing module is shared.
 * Dependencies are only for finite fake-resource contracts, never evidence of
 * real SHA verification, module execution, CanvasKit, WebGL or font rendering. */
export function createWorkerAdmissionLoader({ fetch: fetchResource = globalThis.fetch?.bind(globalThis), sha256 = defaultSha256,
  baseUrl = globalThis.location?.href, importModule = url => import(url),
  createObjectURL = blob => globalThis.URL.createObjectURL(blob), revokeObjectURL = url => globalThis.URL.revokeObjectURL(url),
  makeBlob = (parts, options) => new Blob(parts, options), rendererLeaseLimits = WORKER_RENDERER_LEASE_LIMITS } = {}) {
  check(record(rendererLeaseLimits) && Object.keys(rendererLeaseLimits).length === Object.keys(WORKER_RENDERER_LEASE_LIMITS).length
    && Object.entries(WORKER_RENDERER_LEASE_LIMITS).every(([key, limit]) => Number.isSafeInteger(rendererLeaseLimits[key])
      && rendererLeaseLimits[key] > 0 && rendererLeaseLimits[key] <= limit), 'ERR_INVALID_REQUEST', 'finite renderer lease limits are required')
  const leaseLimits = Object.freeze({ ...rendererLeaseLimits }), waiters = new Set(), staticLeases = new Set(), ownerLeases = new Set(), preparations = new WeakMap()
  let rendererJob = null, initializationCount = 0, ownerFontBytes = 0, cleanupFault = null
  function baseLocation() {
    let base
    try { base = new URL(baseUrl) } catch { fail('ERR_INVALID_REQUEST', 'static loader needs an absolute page baseUrl') }
    check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password,
      'ERR_PERMISSION_DENIED', 'static loader base must use HTTP(S)')
    check(typeof fetchResource === 'function' && typeof sha256 === 'function', 'ERR_ENGINE', 'static fetch/SHA-256 providers are unavailable')
    return base
  }
  async function verify(bytes, expected, signal, label) {
    const actual = await sha256(bytes)
    ensureActive(signal)
    check(digest(actual) && actual === expected, 'ERR_INVALID_MANIFEST', `${label} SHA-256 mismatch`)
  }
  async function admitWorkerPack({ indexUrl = './pack-index.json', indexSha256, indexSize, route, rendererPolicy, signal } = {}) {
    validateSignal(signal)
    check(digest(indexSha256), 'ERR_INVALID_MANIFEST', 'expected pack index SHA-256 is mandatory')
    check(indexSize === undefined || Number.isSafeInteger(indexSize) && indexSize > 0 && indexSize <= WORKER_ADMISSION_LIMITS.indexBytes,
      'ERR_INVALID_MANIFEST', 'pack index size is outside its admission budget')
    check(route === undefined || routePath(route), 'ERR_INVALID_MANIFEST', 'requested route is not a canonical page path')
    const selectedPolicy = policy(rendererPolicy), base = baseLocation()
    const location = staticUrl(indexUrl, base, base.origin)
    const budget = { bytes: 0, limit: WORKER_ADMISSION_LIMITS.indexBytes + WORKER_ADMISSION_LIMITS.manifestBytes }
    const indexBytes = await boundedBytes(fetchResource, location, { signal, limit: WORKER_ADMISSION_LIMITS.indexBytes, expected: indexSize, budget })
    await verify(indexBytes, indexSha256, signal, 'pack index')
    const index = parseJson(indexBytes)
    check(record(index) && index.schemaVersion === 1 && digest(index.manifestSha256) && digest(index.integrityRoot)
      && Array.isArray(index.blobs) && index.blobs.length <= WORKER_ADMISSION_LIMITS.blobCount,
      'ERR_INVALID_MANIFEST', 'invalid pinned pack index')
    check(index.manifestSize === undefined || Number.isSafeInteger(index.manifestSize) && index.manifestSize > 0
      && index.manifestSize <= WORKER_ADMISSION_LIMITS.manifestBytes, 'ERR_INVALID_MANIFEST', 'manifest declaration exceeds its byte budget')
    const blobs = new Map(); let declaredBytes = 0
    for (const item of index.blobs) {
      check(record(item) && digest(item.sha256) && !blobs.has(item.sha256) && Number.isSafeInteger(item.size) && item.size >= 0,
        'ERR_INVALID_MANIFEST', 'invalid or duplicate declared blob')
      declaredBytes += item.size
      check(declaredBytes <= WORKER_ADMISSION_LIMITS.declaredPackBytes, 'ERR_INVALID_MANIFEST', 'declared pack exceeds 128 MiB')
      staticUrl(item.url, location, base.origin)
      blobs.set(item.sha256, item.size)
    }
    const manifestUrl = staticUrl(index.manifest, location, base.origin)
    const manifestBytes = await boundedBytes(fetchResource, manifestUrl, { signal, limit: WORKER_ADMISSION_LIMITS.manifestBytes, expected: index.manifestSize, budget })
    await verify(manifestBytes, index.manifestSha256, signal, 'manifest')
    const manifest = parseJson(manifestBytes)
    check(record(manifest) && manifest.integrity?.algorithm === 'sha256' && manifest.integrity.root === index.integrityRoot
      && Array.isArray(manifest.routes) && manifest.routes.length > 0 && Array.isArray(manifest.modules),
      'ERR_INVALID_MANIFEST', 'invalid verified manifest metadata')
    await verify(encoder.encode(canonicalJson({ ...manifest, integrity: { ...manifest.integrity, root: '' } })), index.integrityRoot, signal, 'manifest integrity root')
    const paths = new Set(), modules = new Set()
    for (const item of manifest.routes) {
      check(record(item) && routePath(item.path) && !paths.has(item.path), 'ERR_INVALID_MANIFEST', 'invalid or duplicate manifest route')
      paths.add(item.path)
    }
    for (const item of manifest.modules) {
      check(record(item) && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 4096
        && !modules.has(item.id) && digest(item.sha256) && blobs.has(item.sha256),
        'ERR_INVALID_MANIFEST', 'module is missing its declared content-addressed blob')
      modules.add(item.id)
    }
    const resolvedRoute = route ?? manifest.routes[0].path
    check(paths.has(resolvedRoute), 'ERR_INVALID_MANIFEST', 'requested route is absent from the pinned manifest')
    const declared = declaredProfile(manifest, resolvedRoute)
    const effective = selectedPolicy.mode === 'force' ? selectedPolicy.profile : declared
    ensureActive(signal)
    return freezeData({ version: '1.0', route: resolvedRoute, rendererPolicy: selectedPolicy,
      declaredProfile: declared, effectiveProfile: effective,
      transportBackend: effective === 'webview' ? 'browser-view' : 'external-frame', manifest,
      provenance: { indexSha256, manifestSha256: index.manifestSha256, integrityRoot: index.integrityRoot,
        indexUrl: location.href, manifestUrl: manifestUrl.href, downloadedBytes: budget.bytes, blobsDownloaded: 0 } })
  }
  async function initializeRenderer(descriptors, signal) {
    check([importModule, createObjectURL, revokeObjectURL, makeBlob].every(value => typeof value === 'function'),
      'ERR_RENDER', 'renderer module/object-URL providers are unavailable')
    const budget = { bytes: 0, limit: WORKER_ADMISSION_LIMITS.rendererBytes }, resources = {}
    for (const [key, item] of Object.entries(descriptors)) {
      resources[key] = await boundedBytes(fetchResource, item.location, { signal, limit: item.size, expected: item.size, budget, cacheable: key === 'font',
        verifyCachedBytes: bytes => verify(bytes, item.sha256, signal, `renderer ${key}`) })
      await verify(resources[key], item.sha256, signal, `renderer ${key}`)
    }
    const metadata = parseJson(resources.package)
    check(metadata.name === 'canvaskit-wasm' && metadata.version === '0.42.0', 'ERR_RENDER', 'pinned renderer package version differs')
    let scriptUrl, wasmUrl, value, error
    const cleanup = []
    try {
      scriptUrl = createObjectURL(makeBlob([resources.javascript, '\nexport default CanvasKitInit;\n'], { type: 'text/javascript' }))
      wasmUrl = createObjectURL(makeBlob([resources.wasm], { type: 'application/wasm' }))
      check(typeof scriptUrl === 'string' && scriptUrl.startsWith('blob:') && typeof wasmUrl === 'string' && wasmUrl.startsWith('blob:'),
        'ERR_RENDER', 'verified drawing bytes require owned local Blob URLs')
      ensureActive(signal)
      const module = await importModule(scriptUrl)
      ensureActive(signal)
      check(typeof module?.default === 'function', 'ERR_RENDER', 'pinned CanvasKit initializer is missing')
      const CanvasKit = await module.default({ locateFile(name) {
        check(name === 'canvaskit.wasm', 'ERR_RENDER', 'CanvasKit requested an unpinned additional resource')
        return wasmUrl
      } })
      ensureActive(signal)
      check(record(CanvasKit), 'ERR_RENDER', 'pinned CanvasKit initialization returned no drawing module')
      check(typeof CanvasKit.Typeface?.MakeTypefaceFromData === 'function', 'ERR_RENDER', 'pinned drawing module cannot decode the static font')
      const typeface = CanvasKit.Typeface.MakeTypefaceFromData(resources.font.buffer)
      check(record(typeface), 'ERR_RENDER', 'pinned static font could not be decoded')
      if (typeof typeface.delete !== 'function') {
        cleanup.push(new Error('temporary typeface has no verified delete operation'))
        fail('ERR_RENDER', 'temporary typeface cannot be released')
      }
      // The temporary handle is never a page/presenter resource. Delete exactly
      // once; a throw may mean uncertain native ownership and blocks reuse.
      try { typeface.delete() } catch (failure) { cleanup.push(failure) }
      check(cleanup.length === 0, 'ERR_RENDER', 'temporary typeface cleanup failed')
      ensureActive(signal)
      value = { CanvasKit, fontData: resources.font.buffer, provenance: freezeData({ version: '0.42.0', variant: 'full',
        fontCommit: 'a85815a42757630ce188fdad368c2dfc444d4773', pins: WORKER_RENDERER_PINS,
        downloadedBytes: budget.bytes, staticFontDecoded: true, gpuSurfaceValidated: false }) }
    } catch (failure) { error = cancelled(signal) || failure }
    for (const url of [scriptUrl, wasmUrl]) if (url !== undefined) {
      try { await revokeObjectURL(url) } catch (failure) { cleanup.push(failure) }
    }
    error = withCleanup(error, cleanup)
    if (error) throw error
    return value
  }
  function descriptorKey(descriptors) {
    return canonicalJson(Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key,
      { sha256: value.sha256, size: value.size, url: value.location.href }])))
  }
  function startRenderer(descriptors) {
    check(!cleanupFault, 'ERR_RENDER', 'uncertain renderer resource cleanup blocks initialization')
    check(initializationCount < leaseLimits.initializations, 'ERR_RENDER', 'renderer initialization lifetime budget exhausted; reopen preview')
    initializationCount++
    const job = { key: descriptorKey(descriptors), controller: new AbortController(), clients: new Set(), settled: false, value: null, promise: null }
    job.promise = Promise.resolve().then(() => initializeRenderer(descriptors, job.controller.signal)).then(value => {
      job.settled = true; job.value = value; return value
    }, error => {
      job.settled = true
      if (error?.details?.cleanupErrors?.length) cleanupFault ??= error
      if (rendererJob === job && !cleanupFault) rendererJob = null
      throw error
    })
    void job.promise.catch(() => {})
    rendererJob = job
    return job
  }
  async function preparePinnedRendererAssets({ rendererAssets, signal } = {}) {
    validateSignal(signal)
    const descriptors = rendererDescriptors(rendererAssets, baseLocation()), key = descriptorKey(descriptors)
    if (cleanupFault) throw cleanupFault
    check(waiters.size < leaseLimits.preparationWaiters && staticLeases.size + waiters.size < leaseLimits.staticLeases,
      'ERR_RENDER', 'renderer preparation waiter/static lease capacity exhausted')
    const token = { aborted: false, job: null }; waiters.add(token)
    let allocatedLease = null
    const abort = () => {
      token.aborted = true
      const job = token.job
      if (job && !job.settled && [...job.clients].every(client => client.aborted)) job.controller.abort('all renderer preparation waiters cancelled')
    }
    try {
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      // A canceled import/initializer owns its resources until actual settlement.
      // New preparation cannot overlap or fabricate cleanup of that old job.
      while (rendererJob?.controller.signal.aborted && !rendererJob.settled) {
        try { await rendererJob.promise } catch { /* exact job completed its cleanup */ }
        ensureActive(signal)
      }
      if (cleanupFault) throw cleanupFault
      ensureActive(signal)
      check(!rendererJob || rendererJob.key === key, 'ERR_RENDER', 'retained renderer module belongs to a different exact resource configuration')
      const job = rendererJob ?? startRenderer(descriptors); token.job = job; job.clients.add(token)
      if (signal?.aborted) abort()
      const shared = await job.promise
      ensureActive(signal)
      const cell = { key, shared, disposed: false, promise: null, removeAbort: null }
      let lease
      const dispose = () => {
        if (!cell.promise) {
          let resolve, reject
          // Install a stable barrier before a duck-typed signal can call back
          // synchronously. Release owned accounting even if its cleanup throws.
          cell.promise = new Promise((yes, no) => { resolve = yes; reject = no })
          void cell.promise.catch(() => {})
          cell.disposed = true
          const removeAbort = cell.removeAbort; cell.removeAbort = null
          cell.shared = null; staticLeases.delete(cell)
          try {
            removeAbort?.()
            resolve(Object.freeze({ disposed: true, staticLeaseReleased: true,
              moduleDisposal: 'not-supported', cachedModuleRetained: Boolean(rendererJob?.value) }))
          } catch (failure) {
            const error = withCleanup(null, [failure]); cleanupFault ??= error; reject(error)
          }
        }
        return cell.promise
      }
      lease = Object.freeze({ version: '1.0', kind: 'static-renderer-assets',
        scope: 'drawing-resources-only', provenance: shared.provenance,
        get disposed() { return cell.disposed }, dispose })
      preparations.set(lease, cell); staticLeases.add(cell); allocatedLease = lease
      try {
        if (signal) {
          const release = () => { void dispose() }
          signal.addEventListener('abort', release, { once: true }); cell.removeAbort = () => signal.removeEventListener('abort', release)
          if (signal.aborted) release()
        }
        ensureActive(signal)
        return lease
      } catch (failure) {
        await dispose()
        throw failure
      }
    } finally {
      let listenerFailure
      try { signal?.removeEventListener('abort', abort) } catch (failure) { listenerFailure = failure }
      finally {
        const job = token.job
        job?.clients.delete(token); waiters.delete(token)
        if (job && !job.settled && job.clients.size === 0) job.controller.abort('renderer initialization has no waiters')
      }
      if (listenerFailure) {
        const failures = [listenerFailure]
        if (allocatedLease) { try { await allocatedLease.dispose() } catch (failure) { failures.push(failure) } }
        const error = withCleanup(null, failures); cleanupFault ??= error; throw error
      }
    }
  }
  function borrowPrepared(owner, preparedRendererAssets, descriptors) {
    const prepared = preparations.get(preparedRendererAssets)
    check(prepared && !prepared.disposed && prepared.shared && prepared.key === descriptorKey(descriptors),
      'ERR_RENDER', 'prepared renderer assets must be a live exact-config lease from this loader')
    const shared = prepared.shared, fontBytes = shared.fontData.byteLength
    check(ownerLeases.size < leaseLimits.ownerLeases && ownerFontBytes + fontBytes <= leaseLimits.ownerFontBytes,
      'ERR_RENDER', 'owner renderer/font lease capacity exhausted')
    const cell = { CanvasKit: shared.CanvasKit, fontData: null, disposed: false, promise: null }
    ownerLeases.add(cell); ownerFontBytes += fontBytes
    try { cell.fontData = shared.fontData.slice(0) }
    catch (failure) { ownerLeases.delete(cell); ownerFontBytes -= fontBytes; fail('ERR_RENDER', `owner font allocation failed: ${String(failure)}`) }
    return Object.freeze({ version: '1.0', owner: Object.freeze({ workerEpoch: owner.workerEpoch, sessionId: owner.sessionId,
      packSha256: owner.packSha256, transportBackend: 'external-frame',
      ...(owner.presenterGeneration === undefined ? {} : { presenterGeneration: owner.presenterGeneration }) }), provenance: shared.provenance,
      get CanvasKit() { check(!cell.disposed, 'ERR_CANCELLED', 'renderer resource lease is disposed'); return cell.CanvasKit },
      get fontData() { check(!cell.disposed, 'ERR_CANCELLED', 'renderer resource lease is disposed'); return cell.fontData },
      dispose() {
        if (!cell.promise) {
          cell.disposed = true; cell.CanvasKit = null; cell.fontData = null
          ownerLeases.delete(cell); ownerFontBytes -= fontBytes
          cell.promise = Promise.resolve(Object.freeze({ disposed: true }))
        }
        return cell.promise
      } })
  }
  async function loadPinnedCanvasKit({ owner, loadResult, attachment, rendererAssets, preparedRendererAssets, signal } = {}) {
    validateSignal(signal); rendererOwner(owner, loadResult, attachment)
    const descriptors = rendererDescriptors(rendererAssets, baseLocation())
    let implicit = null, borrowed = null
    try {
      if (preparedRendererAssets === undefined) implicit = await preparePinnedRendererAssets({ rendererAssets, signal })
      ensureActive(signal)
      borrowed = borrowPrepared(owner, preparedRendererAssets ?? implicit, descriptors)
      if (implicit) { await implicit.dispose(); implicit = null }
      ensureActive(signal)
      return borrowed
    } catch (error) {
      if (borrowed) await borrowed.dispose()
      throw error
    } finally { if (implicit) await implicit.dispose() }
  }
  function rendererResourceStatus() {
    return freezeData({ version: '1.0', preparationWaiters: waiters.size, staticLeases: staticLeases.size,
      ownerLeases: ownerLeases.size, ownerFontBytes, initializations: initializationCount,
      pendingInitialization: Boolean(rendererJob && !rendererJob.settled),
      cachedModuleRetained: Boolean(rendererJob?.value), moduleDisposal: 'not-supported',
      cleanupFault: cleanupFault ? { code: cleanupFault.code || 'ERR_RENDER', message: cleanupFault.message || String(cleanupFault) } : null,
      limits: leaseLimits, gpuSurfaceValidated: false })
  }
  return Object.freeze({ admitWorkerPack, preparePinnedRendererAssets, loadPinnedCanvasKit, rendererResourceStatus })
}
const defaultLoader = createWorkerAdmissionLoader()
export const admitWorkerPack = options => defaultLoader.admitWorkerPack(options)
export const preparePinnedRendererAssets = options => defaultLoader.preparePinnedRendererAssets(options)
export const loadPinnedCanvasKit = options => defaultLoader.loadPinnedCanvasKit(options)
