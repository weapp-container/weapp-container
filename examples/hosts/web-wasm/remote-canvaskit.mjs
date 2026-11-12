import { CanvasKitFramePresenter } from './canvaskit-presenter.mjs'

const MAX_RESOURCE_BYTES = 64 * 1024 * 1024
const fail = message => { throw new Error(`ERR_RENDER: ${message}`) }
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
const digestPattern = /^[0-9a-f]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const identity = value => Number.isSafeInteger(value) && value >= 0
const accessibleCanvasAttributes = new Set(['role', 'title', 'accesskey', 'lang', 'dir', 'inert'])

function inheritCanvasAccessibility(source, candidate) {
  candidate.tabIndex = source.tabIndex
  for (const { name, value } of source.attributes) {
    if (name.startsWith('aria-') || accessibleCanvasAttributes.has(name)) candidate.setAttribute(name, value)
  }
}

export function validateRemoteFrame(value) {
  if (!value || value.schemaVersion !== 1 || value.protocolVersion !== '1.0' || value.format !== 'render-frame-v1'
    || typeof value.sessionId !== 'string' || !value.sessionId || !identity(value.frameId)
    || !identity(value.configGeneration) || !identity(value.renderRevision) || !identity(value.sourceFrameId)
    || ![value.width, value.height, value.logicalWidth, value.logicalHeight].every(positive)
    || value.width > 4096 || value.height > 4096 || value.width * value.height * 4 > 16 * 1024 * 1024
    || value.frame?.frame_id !== value.sourceFrameId || value.frame.viewport?.x !== 0 || value.frame.viewport?.y !== 0
    || value.frame.viewport.width !== value.logicalWidth || value.frame.viewport.height !== value.logicalHeight
    || !value.resources || typeof value.resources !== 'object' || Array.isArray(value.resources)
    || Object.keys(value.frame.images || {}).length) fail('invalid remote render frame')
  const entries = Object.entries(value.resources)
  if (entries.length > 1024) fail('render resource count exceeded')
  let total = 0
  for (const [id, resource] of entries) {
    if (!id || id.length > 256 || !resource || !digestPattern.test(resource.sha256)
      || resource.format !== 'rgba8' || !positive(resource.width) || !positive(resource.height)
      || resource.width > 8192 || resource.height > 8192 || resource.byteLength !== resource.width * resource.height * 4
      || typeof resource.url !== 'string'
      || !new RegExp(`^/api/render-resources/[0-9a-f]{64}/${value.configGeneration}/${value.renderRevision}/${resource.sha256}$`).test(resource.url)) fail('invalid remote render resource')
    total += resource.byteLength
    if (total > MAX_RESOURCE_BYTES) fail('render resource byte budget exceeded')
  }
  return value
}

async function verifiedBytes(resource, fetcher, signal, expectedSize = resource.size) {
  if (!digestPattern.test(resource.sha256) || !positive(expectedSize) || expectedSize > MAX_RESOURCE_BYTES
    || typeof resource.url !== 'string' || !resource.url.startsWith('/') || resource.url.startsWith('//')) fail('invalid resource descriptor')
  const response = await fetcher(resource.url, { signal, cache: 'no-store' })
  if (!response.ok) fail(`resource unavailable (${response.status}): ${resource.url}`)
  const declared = response.headers?.get('content-length')
  if (declared !== null && declared !== undefined && Number(declared) !== expectedSize) fail('resource content length mismatch')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length !== expectedSize || await hash(bytes) !== resource.sha256) fail('resource integrity mismatch')
  return bytes
}

export class RemoteRenderResources {
  constructor(fetcher = fetch, { budgetBytes = MAX_RESOURCE_BYTES } = {}) {
    if (!identity(budgetBytes) || budgetBytes > MAX_RESOURCE_BYTES) fail('invalid resource cache budget')
    this.fetcher = fetcher; this.budgetBytes = budgetBytes; this.cache = new Map(); this.bytes = 0
  }
  async hydrate(envelope, signal) {
    validateRemoteFrame(envelope)
    const sessionKey = await hash(new TextEncoder().encode(envelope.sessionId))
    const images = Object.create(null), staged = new Map()
    for (const [id, resource] of Object.entries(envelope.resources)) {
      if (!resource.url.startsWith(`/api/render-resources/${sessionKey}/`)) fail('resource belongs to a different session')
      let bytes = this.cache.get(resource.sha256) || staged.get(resource.sha256)
      if (!bytes) { bytes = await verifiedBytes(resource, this.fetcher, signal, resource.byteLength); staged.set(resource.sha256, bytes) }
      if (bytes.length !== resource.byteLength) fail('resource digest reused with inconsistent dimensions')
      images[id] = { width: resource.width, height: resource.height, pixels: bytes }
    }
    if (signal?.aborted) throw new Error('ERR_CANCELLED: render preparation cancelled')
    // No cache mutation until every resource has verified successfully.
    const next = new Map(this.cache)
    for (const resource of Object.values(envelope.resources)) {
      const bytes = this.cache.get(resource.sha256) || staged.get(resource.sha256)
      next.delete(resource.sha256)
      if (bytes.length <= this.budgetBytes) next.set(resource.sha256, bytes)
    }
    let retained = [...next.values()].reduce((sum, bytes) => sum + bytes.length, 0)
    for (const [key, bytes] of next) {
      if (retained <= this.budgetBytes && next.size <= 1024) break
      next.delete(key); retained -= bytes.length
    }
    this.cache = next; this.bytes = retained
    return { ...envelope, renderFrame: { ...envelope.frame, images } }
  }
  clear() { this.cache.clear(); this.bytes = 0 }
}

async function loadRenderer(fetcher, signal) {
  const response = await fetcher('/api/renderer-config', { signal, cache: 'no-store' })
  if (!response.ok) fail('pinned renderer assets are not configured')
  const config = await response.json()
  if (config.schemaVersion !== 1 || config.renderer !== 'canvaskit' || config.fallback !== 'error'
    || config.canvaskit?.version !== '0.42.0' || config.canvaskit.variant !== 'full') fail('unsupported renderer configuration')
  const [javascript, wasm, font] = await Promise.all([
    verifiedBytes(config.canvaskit.javascript, fetcher, signal), verifiedBytes(config.canvaskit.wasm, fetcher, signal),
    verifiedBytes(config.font.binary, fetcher, signal),
  ])
  const scriptUrl = URL.createObjectURL(new Blob([javascript, '\nexport default CanvasKitInit;\n'], { type: 'text/javascript' }))
  const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }))
  try {
    const { default: initialize } = await import(scriptUrl)
    const CanvasKit = await initialize({ locateFile: name => {
      if (name !== 'canvaskit.wasm') fail('unexpected renderer dependency')
      return wasmUrl
    } })
    if (signal.aborted) throw new Error('ERR_CANCELLED: renderer load cancelled')
    return { CanvasKit, font }
  } finally { URL.revokeObjectURL(scriptUrl); URL.revokeObjectURL(wasmUrl) }
}

/** One browser-owned presenter. Runtime, input and timers remain on the server. */
export class RemoteCanvasKitRenderer {
  constructor(canvas, { fetcher = fetch, onLost = () => {}, onRestore = () => {} } = {}) {
    this.canvas = canvas; this.fetcher = fetcher; this.onLost = onLost; this.onRestore = onRestore
    this.abort = new AbortController(); this.resources = new RemoteRenderResources(fetcher)
    this.presenter = null; this.assets = null; this.closed = false; this.cleanupErrors = []
    this.lost = event => { event.preventDefault(); this.onLost() }
    this.restored = () => { if (!this.closed) this.onRestore() }
  }
  async prepare(envelope) {
    if (this.closed) throw new Error('ERR_CANCELLED: renderer closed')
    this.assets ||= loadRenderer(this.fetcher, this.abort.signal).catch(error => { this.assets = null; throw error })
    const [prepared] = await Promise.all([this.resources.hydrate(envelope, this.abort.signal), this.assets])
    return prepared
  }
  async present(prepared, isCurrent = () => true) {
    if (this.closed || !isCurrent()) return null
    const { CanvasKit, font } = await this.assets
    if (this.closed || !isCurrent()) return null
    let candidate = null, presenter = this.presenter
    const recreate = !presenter || presenter.lost || this.canvas.width !== prepared.width || this.canvas.height !== prepared.height
    if (recreate) {
      // Allocate and draw into a replacement canvas before changing the
      // visible one. Resize/allocation/preflight failures retain old pixels.
      candidate = this.canvas.ownerDocument.createElement('canvas')
      candidate.width = prepared.width; candidate.height = prepared.height
      candidate.id = this.canvas.id; candidate.className = this.canvas.className; candidate.style.cssText = this.canvas.style.cssText
      presenter = await CanvasKitFramePresenter.create(CanvasKit, candidate, font.buffer, { typography: 'native-v1' })
    }
    if (this.closed || !isCurrent()) { if (candidate) presenter.dispose(); return null }
    let receipt
    try { receipt = presenter.submit(prepared.renderFrame) }
    catch (error) { if (candidate) presenter.dispose(); throw error }
    if (candidate) {
      const previous = this.presenter, oldCanvas = this.canvas
      oldCanvas.removeEventListener('webglcontextlost', this.lost); oldCanvas.removeEventListener('webglcontextrestored', this.restored)
      candidate.addEventListener('webglcontextlost', this.lost); candidate.addEventListener('webglcontextrestored', this.restored)
      inheritCanvasAccessibility(oldCanvas, candidate)
      // Preparation may yield while the user moves focus to settings or a
      // different application. Only the focused, foreground old canvas owns a
      // focus transfer, sampled at the replacement boundary rather than start.
      const document = oldCanvas.ownerDocument
      const restoreFocus = document.hasFocus() && !document.hidden && document.activeElement === oldCanvas
      oldCanvas.replaceWith(candidate); this.canvas = candidate; this.presenter = presenter
      if (restoreFocus) candidate.focus({ preventScroll: true })
      try { previous?.dispose() }
      catch (error) { this.cleanupErrors.push(String(error?.message || error)) }
      candidate.dispatchEvent(new Event('weapp-surface-replaced', { bubbles: true }))
    }
    this.lastReceipt = { ...receipt, sessionId: prepared.sessionId, renderRevision: prepared.renderRevision, configGeneration: prepared.configGeneration,
      cleanupErrors: [...this.cleanupErrors] }
    return this.lastReceipt
  }
  snapshotEvidence() { if (!this.presenter) fail('presenter unavailable'); return this.presenter.snapshotEvidence() }
  dispose() {
    if (this.closed) return
    this.closed = true; this.abort.abort(); this.resources.clear()
    this.canvas.removeEventListener('webglcontextlost', this.lost); this.canvas.removeEventListener('webglcontextrestored', this.restored)
    const presenter = this.presenter; this.presenter = null
    try { presenter?.dispose() } catch (error) { this.cleanupErrors.push(String(error?.message || error)) }
    if (this.cleanupErrors.length) throw new Error(`ERR_RENDER: renderer cleanup failed: ${this.cleanupErrors.join('; ')}`)
  }
}
