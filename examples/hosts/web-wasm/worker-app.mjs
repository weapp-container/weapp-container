import { WorkerWebSession } from './worker-web-session.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const problem = (code, message) => Object.assign(new Error(message), { code })
const requireValue = (condition, code, message) => { if (!condition) throw problem(code, message) }
const freeze = value => {
  if (record(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

export function workerProductOptions(config, route) {
  requireValue(record(config) && config.schemaVersion === 1 && config.execution === 'worker',
    'ERR_INVALID_MANIFEST', 'a builder-generated Worker product configuration is required')
  requireValue(config.engine === 'quickjs', 'ERR_ENGINE', 'the Worker product requires QuickJS; V8 is unavailable')
  requireValue(record(config.index) && config.index.url === './pack-index.json'
    && /^[0-9a-f]{64}$/.test(config.index.sha256) && Number.isSafeInteger(config.index.size)
    && config.index.size > 0 && config.index.size <= 2 * 1024 * 1024,
  'ERR_INVALID_MANIFEST', 'the expected exact pack-index SHA-256 and size are required')
  requireValue(record(config.rendererPolicy) && (config.rendererPolicy.mode === 'manifest'
    && Object.keys(config.rendererPolicy).length === 1 || config.rendererPolicy.mode === 'force'
    && Object.keys(config.rendererPolicy).length === 2 && ['skia', 'skyline-compat', 'webview'].includes(config.rendererPolicy.profile)),
  'ERR_UNSUPPORTED_CAPABILITY', 'the product requires an explicit verified manifest or force renderer policy')
  requireValue(config.rendererTransitions === undefined || record(config.rendererTransitions)
    && Object.keys(config.rendererTransitions).length === 1 && config.rendererTransitions.version === '1.0'
    && config.rendererPolicy.mode === 'manifest', 'ERR_PROTOCOL_VERSION', 'renderer transitions require explicit 1.0 and manifest policy')
  requireValue(record(config.viewport) && ['width', 'height'].every(key => Number.isInteger(config.viewport[key])
    && config.viewport[key] > 0 && config.viewport[key] <= 4096), 'ERR_RENDER', 'invalid product logical viewport')
  requireValue(config.renderScale === undefined || config.renderScale === 'auto' || [1, 1.5, 2, 3, 4].includes(config.renderScale),
    'ERR_RENDER', 'product renderScale must be auto, 1, 1.5, 2, 3 or 4')
  requireValue(config.renderScale === undefined || config.rendererPolicy.mode !== 'force' || config.rendererPolicy.profile !== 'webview',
    'ERR_UNSUPPORTED_CAPABILITY', 'DOM density belongs to the browser')
  requireValue(route === undefined || typeof route === 'string' && route.length > 0 && route.length <= 4096,
    'ERR_INVALID_MANIFEST', 'route must be a nonempty manifest route path')
  // The owner independently admits the route/profile and all renderer bytes.
  const selected = route ?? config.route
  requireValue(selected === undefined || typeof selected === 'string' && selected.length > 0 && selected.length <= 4096,
    'ERR_INVALID_MANIFEST', 'configured route must be a nonempty manifest route path')
  const options = { engine: 'quickjs', indexUrl: config.index.url,
    indexSha256: config.index.sha256, indexSize: config.index.size, viewport: config.viewport,
    rendererPolicy: config.rendererPolicy, rendererAssets: config.rendererAssets,
    ...(selected === undefined ? {} : { route: selected }) }
  for (const key of ['rendererTransitions', 'renderScale', 'metrics', 'data', 'query', 'launchOptions']) if (config[key] !== undefined) options[key] = config[key]
  return freeze(structuredClone(options))
}

const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, failed) => { resolve = done; reject = failed })
  // A debug Promise may be inspected after a startup/close error; retain rejection.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
// UI diagnostics are a separate, lossy lane. Never retain the original native
// batch/error here or stringify arbitrary application objects. Capture the few
// intrinsics used by this lane before developer code can change prototypes.
const uiOwn = Object.getOwnPropertyDescriptor, uiHasOwn = Object.hasOwn
const uiCreate = Object.create, uiDefine = Object.defineProperty, uiFreeze = Object.freeze
const uiSetPrototype = Object.setPrototypeOf, uiIsArray = Array.isArray
const uiIsFinite = Number.isFinite, uiIsSafeInteger = Number.isSafeInteger
const uiApply = Reflect.apply, uiSlice = String.prototype.slice, uiJson = JSON.stringify
const uiWeakHas = WeakSet.prototype.has, uiWeakAdd = WeakSet.prototype.add
const uiWeakSet = WeakSet
const uiFields = uiFreeze(['ok', 'engineProviderAvailable', 'code', 'message', 'name', 'stack', 'phase', 'op', 'kind', 'status', 'requestId',
  'sessionId', 'workerEpoch', 'packSha256', 'transportBackend', 'presenterGeneration', 'generation', 'runtimeOwner', 'presenterBinding', 'presenterTransition', 'transitionRequired', 'sequence', 'revision', 'version', 'protocolVersion',
  'runtimeReady', 'inputEnabled', 'requiresRestart', 'closed', 'workerClosed', 'ownedMountRemoved',
  'owner', 'observation', 'state', 'presentation', 'accepted', 'currentPage', 'pageId', 'path', 'viewport',
  'width', 'height', 'surfaceGeneration', 'templateRevision', 'renderRevision', 'viewRevision', 'lifecycle',
  'metricsPending', 'metricsFence', 'fault', 'diagnostics', 'messages', 'payload', 'error', 'details',
  'errMsg', 'count', 'size', 'byteLength', 'length', 'result', 'data'])
export const WORKER_UI_TRACE_LIMITS = uiFreeze({ entries: 128, bytes: 128 * 1024, entryBytes: 4096,
  nodes: 48, depth: 4, items: 6, stringUnits: 160 })
const uiRecord = () => uiCreate(null)
const uiPut = (target, key, value, enumerable = true) => {
  const descriptor = uiRecord(); descriptor.value = value; descriptor.enumerable = enumerable
  uiDefine(target, key, descriptor); return target
}
const uiGetter = (target, key, get) => {
  const descriptor = uiRecord(); descriptor.get = get; descriptor.configurable = true
  uiDefine(target, key, descriptor)
}
const uiArray = () => { const value = []; uiSetPrototype(value, null); return value }
const uiString = (value, units) => uiApply(uiSlice, value, [0, units])
function uiProperty(value, key) {
  try {
    const descriptor = uiOwn(value, key)
    if (!descriptor) return { found: false, value: undefined, truncated: false }
    return uiHasOwn(descriptor, 'value') ? { found: true, value: descriptor.value, truncated: false }
      : { found: true, value: '[accessor]', truncated: true }
  } catch { return { found: true, value: '[unreadable]', truncated: true } }
}

/** Finite fixed-field projection: no key enumeration, getter, toJSON or coercion. */
function uiProject(root, budget) {
  const { nodes, depth, items, stringUnits } = WORKER_UI_TRACE_LIMITS
  const seen = new uiWeakSet(), context = { remaining: nodes, truncated: false }
  const text = (value, available) => {
    // Six ASCII bytes per UTF-16 unit bounds JSON escaping and UTF-8, including
    // lone surrogates. This is an upper bound, not a JavaScript heap/RSS metric.
    let count = ((available - 2) / 6) | 0
    if (count > stringUnits) count = stringUnits
    if (count < 0) count = 0
    if (value.length > count) context.truncated = true
    const result = uiString(value, count)
    return { value: result, bytes: 2 + result.length * 6 }
  }
  const visit = (value, level, available) => {
    if (available < 8) { context.truncated = true; return { value: null, bytes: 4 } }
    if (--context.remaining < 0) { context.truncated = true; return text('[node limit]', available) }
    if (value === null) return { value: null, bytes: 4 }
    if (typeof value === 'string') return text(value, available)
    if (typeof value === 'boolean') return { value, bytes: value ? 4 : 5 }
    if (typeof value === 'number') {
      if (uiIsFinite(value)) return available >= 32 ? { value, bytes: 32 } : text('[number]', available)
      context.truncated = true; return text('[non-finite number]', available)
    }
    if (typeof value !== 'object') {
      context.truncated = true
      // Converting an arbitrarily large BigInt to decimal is itself unbounded.
      return text(`[${typeof value}]`, available)
    }
    if (level >= depth) { context.truncated = true; return text('[depth limit]', available) }
    if (uiApply(uiWeakHas, seen, [value])) { context.truncated = true; return text('[shared or circular]', available) }
    uiApply(uiWeakAdd, seen, [value])
    let array
    try { array = uiIsArray(value) } catch { context.truncated = true; return text('[unreadable]', available) }
    const output = array ? uiArray() : uiRecord()
    let used = 2, count = 0
    const append = (key, raw, overhead) => {
      if (context.remaining <= 0 || available - used - overhead < 8) { context.truncated = true; return false }
      const child = visit(raw.value, level + 1, available - used - overhead)
      if (raw.truncated) context.truncated = true
      uiPut(output, key, child.value); used += overhead + child.bytes; count++; return true
    }
    if (array) {
      const length = uiProperty(value, 'length')
      if (!length.found || !uiIsSafeInteger(length.value) || length.value < 0) {
        context.truncated = true; return text('[unreadable array]', available)
      }
      let maximum = length.value
      if (maximum > items) { maximum = items; context.truncated = true }
      for (let index = 0; index < maximum; index++) {
        const raw = uiProperty(value, index)
        if (!append(index, raw.found ? raw : { value: null, truncated: false }, count ? 1 : 0)) break
      }
    } else {
      for (let index = 0; index < uiFields.length; index++) {
        const key = uiFields[index], raw = uiProperty(value, key)
        if (raw.found && (key === 'ok' || key === 'engineProviderAvailable') && typeof raw.value !== 'boolean') {
          raw.value = '[invalid boolean]'; raw.truncated = true
        }
        if (raw.found && !append(key, raw, key.length + 3 + (count ? 1 : 0))) break
      }
    }
    return { value: uiFreeze(output), bytes: used }
  }
  const result = visit(root, 0, budget)
  return { ...result, truncated: context.truncated }
}

/** Snapshots expose safe metadata; only this closure owns the bounded ring. */
export function createWorkerUiTrace() {
  const limits = WORKER_UI_TRACE_LIMITS, ring = uiArray()
  let head = 0, length = 0, retainedBytes = 0, evicted = 0
  return uiFreeze({
    add(kind, value) {
      kind = typeof kind === 'string' ? uiString(kind, 32) : 'trace'
      // Reserve 512 bytes for the fixed fact keys, 32-unit kind and counters.
      const projected = uiProject(value, limits.entryBytes - 512), bytes = 512 + projected.bytes
      const fact = uiRecord()
      uiPut(fact, 'profile', 'ui-metadata-v1')
      uiPut(fact, 'kind', kind); uiPut(fact, 'value', projected.value)
      uiPut(fact, 'truncated', projected.truncated); uiPut(fact, 'byteUpperBound', bytes); uiFreeze(fact)
      while (length && (length >= limits.entries || retainedBytes + bytes > limits.bytes)) {
        retainedBytes -= ring[head].byteUpperBound; ring[head] = null
        head = (head + 1) % limits.entries; length--; evicted++
      }
      ring[(head + length) % limits.entries] = fact; length++; retainedBytes += bytes
      return fact
    },
    snapshot() {
      const output = []
      // A normal frozen Array keeps familiar inspection helpers. Shadow an
      // inherited toJSON; its elements are already immutable null-prototype data.
      uiPut(output, 'toJSON', undefined, false)
      for (let index = 0; index < length; index++) uiPut(output, index, ring[(head + index) % limits.entries])
      return uiFreeze(output)
    },
    stats() {
      const result = uiRecord()
      uiPut(result, 'schemaVersion', 1); uiPut(result, 'entries', length)
      uiPut(result, 'retainedByteUpperBound', retainedBytes); uiPut(result, 'evicted', evicted)
      uiPut(result, 'maxEntries', limits.entries); uiPut(result, 'maxBytes', limits.bytes)
      uiPut(result, 'maxEntryBytes', limits.entryBytes); return uiFreeze(result)
    },
  })
}
function errorFact(error) {
  const fact = uiRecord(), code = error && typeof error === 'object' ? uiProperty(error, 'code') : { value: undefined }
  const message = error && typeof error === 'object' ? uiProperty(error, 'message') : { value: error }
  uiPut(fact, 'code', typeof code.value === 'string' ? uiString(code.value, 64) : 'ERR_ENGINE')
  uiPut(fact, 'message', typeof message.value === 'string' ? uiString(message.value, 384) : 'Worker operation failed')
  return uiFreeze(fact)
}
const json = value => uiJson(value, null, 2)

/** One owner per bootstrap; replacement must await this handle's close barrier. */
export function bootstrapWorkerApp({ config, route, document = globalThis.document,
  createSession = options => new WorkerWebSession(options), onTrace } = {}) {
  const surfaceRoot = document?.querySelector('#surface-root')
  const statusElement = document?.querySelector('#status'), summary = document?.querySelector('#summary')
  const errorElement = document?.querySelector('#error'), dispose = document?.querySelector('#dispose')
  requireValue(surfaceRoot && statusElement && summary && errorElement && dispose,
    'ERR_RENDER', 'the Worker product entry is missing its owned controls or borrowed surface root')
  const options = workerProductOptions(config, route), first = deferred()
  const trace = createWorkerUiTrace()
  let session = null, retired = false, firstSettled = false, firstAccepted = false, closePromise = null
  const add = (kind, value) => {
    const fact = trace.add(kind, value)
    try { onTrace?.(fact) } catch { /* A debug observer cannot own runtime lifetime. */ }
    return fact
  }
  const fail = error => {
    const fact = errorFact(error)
    add('error', fact); errorElement.textContent = json(fact); errorElement.hidden = false
    statusElement.textContent = `错误：${fact.message}`
    if (!firstSettled) { firstSettled = true; first.reject(error) }
  }
  const state = value => {
    const fact = add('state', value)
    if (retired) return
    const rendered = uiRecord()
    uiPut(rendered, 'execution', 'worker'); uiPut(rendered, 'state', fact.value)
    summary.textContent = json(rendered)
    if (['closing', 'closed'].includes(value.phase)) {
      dispose.disabled = true
      if (!firstSettled) { firstSettled = true; first.reject(problem('ERR_CANCELLED', 'owner closed before first presentation')) }
      statusElement.textContent = value.phase === 'closed' ? '已卸载小程序' : '正在卸载…'
      if (value.phase === 'closed') { retired = true; dispose.removeEventListener('click', onDispose) }
      return
    }
    if (value.fault) { fail(value.fault); return }
    if (value.requiresRestart) {
      fail(problem('ERR_UNSUPPORTED_CAPABILITY', '当前路由需要替换渲染会话；请卸载后重新启动'))
      return
    }
    if (value.presenterTransition?.phase === 'blocked') {
      statusElement.textContent = '渲染器切换受阻；业务运行时继续运行，可显式重试'
      errorElement.hidden = false; errorElement.textContent = json(errorFact(value.presenterTransition.error))
      return
    }
    const accepted = value.presentation?.accepted
    if (!firstSettled && value.runtimeReady && accepted && value.inputEnabled === true) {
      firstSettled = true; firstAccepted = true; first.resolve(Object.freeze({ owner: value.owner, accepted }))
      add('first-presentation', { owner: value.owner, accepted })
    }
    statusElement.textContent = firstAccepted && value.inputEnabled === true
      ? `已呈现 · ${value.owner?.transportBackend ?? ''}`
      : value.runtimeReady ? '运行时已就绪，等待有效画面…' : 'Worker 加载中…'
  }
  const close = () => {
    if (closePromise) return closePromise
    retired = true; dispose.disabled = true; dispose.removeEventListener('click', onDispose)
    if (!firstSettled) { firstSettled = true; first.reject(problem('ERR_CANCELLED', 'closed before an accepted presentation')) }
    // Publish the barrier before invoking a potentially reentrant owner.
    closePromise = Promise.resolve().then(() => session?.close()).then(result => {
      add('closed', result); statusElement.textContent = '已卸载小程序'; return result
    }, error => { fail(error); throw error })
    void closePromise.catch(() => {})
    return closePromise
  }
  const onDispose = () => { void close().catch(() => {}) }
  dispose.addEventListener('click', onDispose)
  try {
    session = createSession({ surfaceRoot, onState: state, onBatch: batch => add('batch', batch),
      onDiagnostic: error => add('diagnostic', errorFact(error)), onError: fail })
    requireValue(session && typeof session.load === 'function' && typeof session.close === 'function',
      'ERR_PROTOCOL_VERSION', 'session factory must transfer one async Worker owner')
  } catch (error) {
    dispose.removeEventListener('click', onDispose); firstSettled = true; first.reject(error)
    fail(error); throw error
  }
  const ready = Promise.resolve().then(() => {
    if (retired) throw problem('ERR_CANCELLED', 'closed before Worker load')
    return session.load(options)
  }).then(result => {
    if (retired) throw problem('ERR_CANCELLED', 'Worker load completed after entry retirement')
    dispose.disabled = false; add('runtime-ready', result)
    state(session.status); return result
  }).catch(async error => {
    fail(error)
    try { await close() } catch (cleanup) { add('cleanup-error', errorFact(cleanup)) }
    throw error
  })
  void ready.catch(() => {})
  // No additional timer RAF, visibility listener, pagehide owner or bridge path.
  return Object.freeze({ session, ready, presented: first.promise,
    get trace() { return trace.snapshot() }, get traceStats() { return trace.stats() }, close })
}

if (typeof window !== 'undefined' && document.querySelector('[data-worker-product-entry]')) {
  try {
    const { WORKER_PRODUCT_CONFIG } = await import('./worker-product-config.mjs')
    const query = new URL(window.location.href).searchParams
    for (const key of ['engine', 'renderer', 'execution', 'index', 'indexUrl', 'indexSha256']) {
      requireValue(!query.has(key), 'ERR_PERMISSION_DENIED', `${key} cannot override the pinned product policy`)
    }
    requireValue(query.getAll('route').length <= 1, 'ERR_INVALID_MANIFEST', 'route may be specified once')
    const app = bootstrapWorkerApp({ config: WORKER_PRODUCT_CONFIG, route: query.get('route') ?? undefined })
    window.weapp = app.session
    window.weappReady = app.ready
    window.weappPresented = app.presented
    uiGetter(window, 'weappTrace', () => app.trace)
    uiGetter(window, 'weappTraceStats', () => app.traceStats)
    window.weappClose = app.close
  } catch (error) {
    const target = document.querySelector('#error')
    target.hidden = false; target.textContent = json(errorFact(error))
    document.querySelector('#status').textContent = '启动失败'
    const failed = Promise.reject(error); void failed.catch(() => {})
    window.weappReady = failed; window.weappPresented = failed
  }
}
