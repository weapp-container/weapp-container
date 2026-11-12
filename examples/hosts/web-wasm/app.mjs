import init, { WebWasmHost } from './pkg/container_host_web.js'
import { routeStyleIds } from './render-inputs.mjs'
import { attachSurfaceInput } from './surface-input.mjs'

const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('')
const check = (value, message) => { if (!value) throw new Error(message) }
/** poll_timers uses Unix epoch ns, matching Rust SystemTime and JS Date.now(). */
export function unixTimerNanos(nowMillis = Date.now()) {
  check(Number.isSafeInteger(nowMillis) && nowMillis >= 0, 'ERR_ENGINE: invalid Unix timer clock milliseconds')
  // Multiplication in Number would lose nanosecond precision at today's dates.
  const nowNs = BigInt(nowMillis) * 1_000_000n
  check(nowNs <= 0xffff_ffff_ffff_ffffn, 'ERR_ENGINE: Unix timer clock exceeds u64 nanoseconds')
  return nowNs
}
const diagnostic = error => ({ code: error?.code || String(error).match(/ERR_[A-Z_]+/)?.[0] || 'ERR_ENGINE',
  message: error?.message || String(error), stack: error?.stack, ...(error?.nodeId ? { nodeId: error.nodeId } : {}) })
function cancellable(promise, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('ERR_CANCELLED: application closed while loading'))
    if (signal.aborted) { cancel(); return }
    signal.addEventListener('abort', cancel, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}
async function bytesAt(url, signal) {
  const response = await fetch(url, { signal })
  check(response.ok, `HTTP ${response.status}: ${url}`)
  return new Uint8Array(await response.arrayBuffer())
}

async function verifiedRendererResource(resource, signal, limit = Infinity) {
  check(resource && /^[0-9a-f]{64}$/.test(resource.sha256) && Number.isSafeInteger(resource.size) && resource.size > 0,
    'ERR_RENDER: missing renderer resource integrity')
  check(resource.size <= limit, 'ERR_RENDER: renderer resource exceeds byte budget')
  let bytes
  if (Number.isFinite(limit)) {
    const response = await fetch(new URL(resource.url, location.href), { signal })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      check(false, 'ERR_RENDER: bounded renderer response unavailable')
    }
    const reader = response.body.getReader(), chunks = []; let total = 0
    try {
      const advertised = response.headers.get('content-length')
      check(advertised === null || Number(advertised) === resource.size, 'ERR_RENDER: renderer content-length differs from pin')
      while (true) {
        const { value, done } = await reader.read(); if (done) break
        total += value.byteLength
        check(total <= resource.size && total <= limit, 'ERR_RENDER: renderer response exceeds byte budget')
        chunks.push(value)
      }
    } catch (error) { await reader.cancel(error).catch(() => {}); throw error }
    finally { reader.releaseLock() }
    bytes = new Uint8Array(total); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  } else bytes = await bytesAt(new URL(resource.url, location.href), signal)
  check(bytes.length === resource.size && await hash(bytes) === resource.sha256, `ERR_RENDER: resource integrity mismatch: ${resource.url}`)
  return bytes
}

// One verified CanvasKit module is shared for this page. Each application still
// owns and disposes its surface, context and font. It does not export AppService
// calls to the renderer, and no unverified script URL executes.
const canvasKitModules = new Map()
async function canvasKitModule(config, signal) {
  check(config?.version === '0.42.0' && config.variant === 'full', 'ERR_RENDER: unsupported CanvasKit version or variant')
  const key = `${config.javascript.sha256}:${config.wasm.sha256}`
  if (!canvasKitModules.has(key)) {
    const module = (async () => {
      const [javascript, wasm] = await Promise.all([
        // This cache belongs to the page, rather than its first application.
        // Closing one application cancels only its wait, never another caller.
        verifiedRendererResource(config.javascript), verifiedRendererResource(config.wasm),
      ])
      const url = URL.createObjectURL(new Blob([javascript, '\nexport default CanvasKitInit;\n'], { type: 'text/javascript' }))
      const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }))
      try {
        const { default: initialize } = await import(url)
        check(typeof initialize === 'function', 'ERR_RENDER: CanvasKit initializer is unavailable')
        // This pinned optimized build exports locateFile, but not wasmBinary.
        // Resolve only its known WASM request to our already verified bytes.
        return await initialize({ locateFile: name => {
          check(name === 'canvaskit.wasm', `ERR_RENDER: unexpected CanvasKit resource: ${name}`)
          return wasmUrl
        } })
      } finally { URL.revokeObjectURL(url); URL.revokeObjectURL(wasmUrl) }
    })()
    canvasKitModules.set(key, module)
    module.catch(() => canvasKitModules.delete(key))
  }
  return cancellable(canvasKitModules.get(key), signal)
}

/** App-owned wrapper around a single WASM session; all bridge traffic is batched. */
export class WeappWebSession {
  constructor(canvas, onBatch = () => {}) {
    this.canvas = canvas
    this.context = null
    this.presenter = null
    this.presentation = null
    this.renderedViewRevision = null
    this.renderedRenderRevision = null
    this.renderedViewport = null
    this.abortController = new AbortController()
    this.onBatch = onBatch
    this.sessionId = `web-${crypto.randomUUID()}`
    this.sequence = 0
    this.frameId = 0
    this.host = null
    this.closed = false
    this.state = 'new'
    this.suspended = false
    this.frameRequest = null
    this.visibility = () => {
      if (this.state !== 'ready') return
      try { this.request('app.lifecycle', { event: document.hidden ? 'hide' : 'show' }) }
      catch (error) { this.onBatch({ error: diagnostic(error) }) }
    }
  }

  async load({ indexUrl = './pack-index.json', route, engine = 'quickjs', rendererConfig = { schemaVersion: 1, renderer: 'software', fallback: 'error' } } = {}) {
    check(this.state === 'new', 'Create a new wrapper for each application session')
    // Claim this wrapper synchronously, before the first await. Concurrent
    // loads must never overwrite another load's host, renderer or RAF handle.
    this.state = 'loading'
    try {
      await init()
      check(!this.closed, 'ERR_CANCELLED: application closed while loading')
      check(rendererConfig.schemaVersion === 1 && rendererConfig.fallback === 'error'
        && ['software', 'canvaskit'].includes(rendererConfig.renderer), 'ERR_RENDER: invalid renderer configuration')
      this.rendererConfig = rendererConfig
      const signal = this.abortController.signal
      const indexLocation = new URL(indexUrl, location.href)
      const index = JSON.parse(new TextDecoder().decode(await bytesAt(indexLocation, signal)))
      const manifestBytes = await bytesAt(new URL(index.manifest, indexLocation), signal)
      check(await hash(manifestBytes) === index.manifestSha256, 'Manifest differs from the pack index')
      const manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)
      this.manifest = JSON.parse(manifestText)
      check(this.manifest.integrity.root === index.integrityRoot, 'Pack index root differs')
      this.blobs = {}
      check(Array.isArray(index.blobs), 'Invalid blob index')
      await Promise.all(index.blobs.map(async blob => {
        check(/^[0-9a-f]{64}$/.test(blob.sha256), 'Invalid blob address')
        const bytes = await bytesAt(new URL(blob.url, indexLocation), signal)
        check(bytes.length === blob.size && await hash(bytes) === blob.sha256, `Blob integrity mismatch: ${blob.sha256}`)
        this.blobs[`sha256:${blob.sha256}`] = Array.from(bytes)
      }))
      check(!this.closed, 'ERR_CANCELLED: application closed while loading')
      this.host = new WebWasmHost()
      let font = null, fontIdentity = null
      if (rendererConfig.renderer === 'canvaskit') {
        check(rendererConfig.font?.binary?.size <= 32 * 1024 * 1024, 'ERR_RENDER: text font exceeds the bounded SFNT budget')
        font = await verifiedRendererResource(rendererConfig.font?.binary, signal, 32 * 1024 * 1024)
        check(!this.closed, 'ERR_CANCELLED: application closed while loading text font')
        check(typeof this.host.configure_text_font === 'function', 'ERR_PROTOCOL_VERSION: runtime has no verified text font ingress')
        fontIdentity = JSON.parse(this.host.configure_text_font(font, rendererConfig.font.binary.sha256))
      }
      this.host.load_manifest_json_with_config(manifestText, JSON.stringify({ session_id: this.sessionId, engine, require_integrity: true,
        renderer_mode: rendererConfig.renderer === 'canvaskit' ? 'external-frame' : 'software' }))
      this.capabilities = JSON.parse(this.host.capabilities_json())
      this.route = this.manifest.routes.find(item => item.path === route) || (!route && this.manifest.routes[0])
      check(this.route, `Unknown route: ${route}`)
      if (rendererConfig.renderer === 'canvaskit') {
        const [{ CanvasKitFramePresenter }, CanvasKit] = await Promise.all([
          import('./canvaskit-presenter.mjs'), canvasKitModule(rendererConfig.canvaskit, signal),
        ])
        check(!this.closed, 'ERR_CANCELLED: application closed while loading renderer')
        this.presenter = await CanvasKitFramePresenter.create(CanvasKit, this.canvas, font.buffer, { typography: 'native-v1', fontIdentity })
        if (this.closed) { this.presenter.dispose(); throw new Error('ERR_CANCELLED: application closed while creating renderer') }
      } else {
        this.context = this.canvas.getContext('2d')
        check(this.context, 'ERR_RENDER: Canvas 2D is unavailable')
      }
      const modules = this.manifest.modules.map(item => {
        const bytes = this.blobs[`sha256:${item.sha256}`]
        check(bytes, `Missing module: ${item.id}`)
        return { id: item.id, bytes }
      })
      const initialized = this.request('app.init', { blobs: this.blobs, modules, launchOptions: {} })
      check(initialized.engineProviderAvailable === true, 'ERR_ENGINE: provider did not execute')
      this.request('app.lifecycle', { event: 'launch', options: {} })
      this.launched = true
      this.request('page.push', { path: this.route.path, data: {}, query: {} })
      this.render()
      check(!this.closed, 'ERR_CANCELLED: application closed during initialization')
      this.input = attachSurfaceInput(this.canvas, {
        session: () => this.sessionId, active: () => this.state === 'ready' && !this.suspended,
        send: events => { this.request('event.batch', { events }); this.render() },
        onError: error => this.onBatch({ error: diagnostic(error) }),
      })
      document.addEventListener('visibilitychange', this.visibility)
      this.state = 'ready'
      this.tick = () => {
        this.frameRequest = null
        if (!this.host || this.closed) return
        try {
          // RAF's argument is a relative monotonic timestamp, not a timer
          // deadline. Sample wall time after delayed/background delivery too.
          const batch = JSON.parse(this.host.poll_timers(unixTimerNanos()))
          this.#consumeBatch(batch)
          if (!this.host || this.closed) return
          if (!this.suspended) {
            const dirty = this.presenter && (this.host.view_revision() !== this.renderedViewRevision
              || this.host.render_revision() !== this.renderedRenderRevision
              || this.canvas.width !== this.renderedViewport?.width
              || this.canvas.height !== this.renderedViewport?.height)
            if (batch.messages.length || dirty) {
              try { this.render() }
              catch (error) { this.onBatch({ error: diagnostic(error) }) }
            }
          }
          this.scheduleTimers()
        } catch (error) {
          this.onBatch({ error: diagnostic(error) })
          this.close()
        }
      }
      this.scheduleTimers()
      return this
    } catch (error) { this.close(); throw error }
  }

  request(op, payload) {
    check(!this.closed, 'Application is unloaded')
    check(this.host, 'Application is unloaded')
    check(!this.suspended || op !== 'event.batch',
      'ERR_RENDER: presentation failed; render successfully before sending more input')
    return this.#dispatch(op, payload)
  }

  #dispatch(op, payload) {
    const requestId = `web-${++this.sequence}`
    const request = { protocolVersion: '1.0', sessionId: this.sessionId, requestId, kind: 'request', op, payload }
    const batch = JSON.parse(this.host.dispatch_json(JSON.stringify(request)))
    const responses = batch.messages.filter(message => message.kind === 'response' && message.requestId === requestId)
    check(responses.length === 1 && responses[0].sessionId === this.sessionId && responses[0].op === op, `Uncorrelated ${op} response`)
    this.#consumeBatch(batch)
    check(responses[0].payload.ok === true, JSON.stringify(responses[0].payload))
    return responses[0].payload
  }

  #consumeBatch(batch) {
    check(Array.isArray(batch.messages), 'ERR_ENGINE: invalid bridge batch')
    if (batch.messages.length) this.onBatch(batch)
    const failure = batch.messages.find(message => message.op === 'error' || message.payload?.ok === false)
    if (failure) {
      const error = failure.payload?.error || failure.payload
      throw Object.assign(new Error(error?.message || JSON.stringify(error)), { code: error?.code || 'ERR_ENGINE' })
    }
  }

  render() {
    try { this.present(); this.suspended = false; this.scheduleTimers() }
    catch (error) {
      // Rust already committed the new hit tree. A rejected presentation keeps
      // the old pixels, so suspend input and automatic redraws until an
      // explicit render succeeds. Business timers and lifecycle keep running.
      this.suspended = true
      this.scheduleTimers()
      throw error
    }
  }

  scheduleTimers() {
    if (this.state === 'ready' && !this.closed && this.frameRequest === null && this.tick) {
      this.frameRequest = requestAnimationFrame(this.tick)
    }
  }

  present() {
    const viewport = { x: 0, y: 0, width: this.canvas.width, height: this.canvas.height }
    // A native Canvas draw may publish a retained repaint without changing
    // View input. Submit that accepted picture without reevaluating the tree.
    const sameViewport = value => value && ['x', 'y', 'width', 'height'].every(key => value[key] === viewport[key])
    const retainedPaint = this.presenter && this.host.view_revision() === this.renderedViewRevision
      && this.host.render_revision() !== this.renderedRenderRevision && sameViewport(this.renderedViewport)
    let retainedFrame = null
    if (retainedPaint) {
      const frame = JSON.parse(this.host.render_frame_json())
      if (sameViewport(frame.viewport)) retainedFrame = frame
    }
    if (!retainedFrame) this.request('render.commit', { blobs: this.blobs, frameId: ++this.frameId,
      templateId: `template:${this.route.path}.wxml`, viewport,
      styleIds: routeStyleIds(this.manifest, this.route) })
    if (this.presenter) {
      // Exactly one complete laid-out tree crosses the AppService/WASM boundary.
      // CanvasKit draws locally; software RGBA is not read or uploaded.
      const revision = this.host.render_revision()
      check(typeof revision === 'bigint' && revision > 0n, 'ERR_RENDER: invalid renderer revision')
      this.renderedViewRevision = this.host.view_revision()
      const frame = retainedFrame || JSON.parse(this.host.render_frame_json())
      const receipt = this.presenter.submit(frame)
      this.renderedRenderRevision = revision
      this.renderedViewport = { ...frame.viewport }
      // submit() returns after CanvasKit flush. This confirms queue submission,
      // not GPU completion, and never uses the user-supplied frameId as a token.
      this.presentation = { ...receipt, renderRevision: revision.toString(), gpuCompletion: 'not-waited' }
      const effects = JSON.parse(this.host.acknowledge_presentation(revision))
      this.#consumeBatch(effects)
      this.onBatch({ presentation: this.presentation })
      return
    }
    // Read current Page/Component state from Rust. Never reconstruct setData in
    // browser code. One typed RGBA buffer crosses the boundary for each frame.
    const pixels = this.host.render_snapshot_rgba()
    check(pixels.length === viewport.width * viewport.height * 4, 'Invalid RGBA frame size')
    const straight = new Uint8ClampedArray(pixels)
    for (let i = 0; i < straight.length; i += 4) {
      const alpha = straight[i + 3]
      for (let c = 0; c < 3; c++) straight[i + c] = alpha ? Math.min(255, Math.round(straight[i + c] * 255 / alpha)) : 0
    }
    this.context.putImageData(new ImageData(straight, viewport.width, viewport.height), 0, 0)
    this.presentation = { backend: 'software-rgba', frameId: this.frameId, gpuSurface: false }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.state = 'closed'
    this.abortController.abort()
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest)
    this.frameRequest = null
    this.input?.dispose()
    document.removeEventListener('visibilitychange', this.visibility)
    const host = this.host
    if (host) {
      try {
        if (this.launched) this.#dispatch('app.lifecycle', { event: 'unload' })
      } catch (error) { this.onBatch({ error: diagnostic(error), phase: 'unload' }) }
      finally {
        this.host = null
        try { host.unload() } finally {
          try { host.free() } finally { this.presenter?.dispose() }
        }
      }
    } else this.presenter?.dispose()
  }
}

const canvas = document.querySelector('#surface')
if (canvas) {
  const summary = document.querySelector('#summary')
  const status = document.querySelector('#status')
  const errorNode = document.querySelector('#error')
  const logs = []
  const showError = error => { errorNode.style.display = 'block'; errorNode.textContent = typeof error === 'object' ? JSON.stringify(error instanceof Error ? diagnostic(error) : error, null, 2) : String(error); status.textContent = '运行失败' }
  const application = window.weapp = new WeappWebSession(canvas, batch => {
    logs.push(batch)
    if (logs.length > 32) logs.shift()
    window.weappTrace = logs
    summary.textContent = JSON.stringify({ sessionId: application.sessionId, route: application.route?.path, frameId: application.frameId,
      capabilities: application.capabilities, presentation: application.presentation, lastBatch: batch }, null, 2)
    if (batch.error) showError(batch.error)
  })
  window.weappReady = bytesAt('./runtime-config.json', application.abortController.signal)
    .then(bytes => application.load({ route: new URLSearchParams(location.search).get('route') || undefined,
      rendererConfig: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }))
    .then(() => { status.textContent = `ready · ${application.route.path}`; document.querySelector('#dispose').disabled = false; return true })
    .catch(error => { application.close(); showError(error); return false })
  document.querySelector('#dispose').addEventListener('click', () => { application.close(); status.textContent = '已卸载'; document.querySelector('#dispose').disabled = true })
  addEventListener('pagehide', () => application.close(), { once: true })
}
