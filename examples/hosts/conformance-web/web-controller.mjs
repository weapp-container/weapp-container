/** Internal candidate only. No host-driver registration and no execution receipt. */
import { WorkerWebSession } from '../../../examples/hosts/web-wasm/worker-web-session.mjs'
import { WorkerCanvasKitAdapter } from '../../../examples/hosts/web-wasm/worker-canvaskit-adapter.mjs'
import { PresentedFrameObserver, WebConformanceError } from './frame-observer.mjs'
import { loadRustProjection } from './projection-loader.mjs'

const check = (condition, message) => { if (!condition) throw new WebConformanceError('ERR_CONFORMANCE_DRIVER', message) }
const routeOf = value => {
  check(typeof value === 'string' && value.trim() === value && !/[\\?#]/.test(value), 'a canonical page route is required')
  const route = value.replace(/^\/+|\/+$/g, '')
  check(route && route.split('/').every(part => part && part !== '.' && part !== '..'), 'a canonical page route is required')
  return route
}
const only = (value, keys) => check(value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).every(key => keys.includes(key)), 'operation contains an unsupported field')

// Dependency injection here serves explicitly synthetic boundary tests. The
// public candidate factory below always constructs the real Worker/session and
// CanvasKit adapter; this controller is not an admitted evidence producer.
export class WebConformanceController {
  #session; #observer; #project; #tail = Promise.resolve(); #closing = false; #closePromise = null; #timeout
  constructor({ session, observer, projectFrameJson, timeoutMs = 15000 }) {
    check(session && observer && typeof projectFrameJson === 'function', 'session, observer and Rust projection are required')
    check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, 'timeoutMs must be in 1..60000')
    this.#session = session; this.#observer = observer; this.#project = projectFrameJson; this.#timeout = timeoutMs
  }
  get status() { return { session: this.#session.status, observation: this.#observer.diagnostics } }
  async ready() { await this.#wait(); return this.status }
  async #wait(predicate = () => true) {
    const deadline = performance.now() + this.#timeout
    let lastFailure
    do {
      check(!this.#closing, 'candidate is closing')
      if (this.#observer.diagnostics.fault) throw this.#observer.diagnostics.fault
      const status = this.#session.status
      check(!status.requiresRestart && !status.fault && !['closing', 'closed'].includes(status.phase), 'actual session is faulted or retired')
      try { const snapshot = this.#observer.snapshot(this.#session); if (predicate(snapshot)) return snapshot }
      catch (error) { if (error.code !== 'ERR_CONFORMANCE_OBSERVATION') throw error; lastFailure = error }
      if (performance.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, Math.min(10, deadline - performance.now())))
    } while (performance.now() <= deadline)
    throw new WebConformanceError('ERR_CONFORMANCE_TIMEOUT', `current presented Worker frame unavailable: ${lastFailure?.message ?? 'required actual revision did not advance'}`)
  }
  #projectSnapshot(snapshot, op, payload) {
    const route = snapshot.observation.state.currentPage.path
    check(routeOf(payload.route) === route, 'query route differs from the actual current page')
    const projected = JSON.parse(this.#project(JSON.stringify(snapshot.frame), JSON.stringify({ ...payload, route, op })))
    check(projected?.status === 'ok' && projected.result && projected.result.route === route,
      `Rust accepted-tree projection failed: ${projected?.message ?? 'invalid result'}`)
    return projected.result
  }
  request(op, payload = {}) {
    check(!this.#closing, 'candidate is closing')
    const work = this.#tail.then(() => this.#request(op, payload))
    this.#tail = work.catch(() => {})
    return work
  }
  async #request(op, payload) {
    check(!this.#closing, 'candidate is closing')
    const before = await this.#wait()
    if (op === 'reLaunch') {
      only(payload, ['route'])
      const route = routeOf(payload.route)
      await this.#session.request('api.call', { name: 'wx.reLaunch', url: `/${route}` })
      const after = await this.#wait(snapshot => snapshot.observation.state.currentPage.path === route
        && snapshot.observation.state.currentPage.pageId !== before.observation.state.currentPage.pageId
        && BigInt(snapshot.renderRevision) > BigInt(before.renderRevision))
      return { path: after.observation.state.currentPage.path }
    }
    check(['query', 'query.text', 'query.attribute', 'checkpoint', 'tap'].includes(op), 'unsupported Web candidate operation')
    only(payload, op === 'checkpoint' ? ['route', 'checkpoint', 'selectors'] : ['route', 'selector', 'scope', 'has', 'fields', 'name', 'query'])
    const result = this.#projectSnapshot(before, op, payload)
    if (op !== 'tap') return result
    const point = result.point
    check(point && Number.isFinite(point.x) && Number.isFinite(point.y), 'accepted tree has no hittable actual coordinate')
    // A synchronous projection cannot cross an owner turn. Recheck the actual
    // authority before dispatch; coordinate hit-testing stays in the runtime.
    const current = this.#observer.snapshot(this.#session)
    check(current.observation.sequence === before.observation.sequence && current.renderRevision === before.renderRevision,
      'presented frame changed before coordinate input')
    await this.#session.request('event.batch', { events: [{ type: 'tap', x: point.x, y: point.y,
      detail: { x: point.x, y: point.y }, button: 0, buttons: 0, bubbles: true }] })
    await this.#wait(snapshot => snapshot.observation.state.currentPage.pageId === before.observation.state.currentPage.pageId
      && BigInt(snapshot.renderRevision) > BigInt(before.renderRevision))
    return { ...result, frameId: before.frame.frame_id, renderRevision: before.renderRevision, inputTransport: 'web-host-coordinate-event' }
  }
  close() {
    if (this.#closePromise) return this.#closePromise
    this.#closing = true
    this.#closePromise = (async () => {
      try {
        const receipt = await this.#session.close()
        await this.#tail
        this.#observer.verifyClosed(this.#session, receipt)
        return receipt
      } finally { this.#observer.close() }
    })()
    return this.#closePromise
  }
}

export async function createWebQuickjsCandidate({ enabled = false, engine = 'quickjs', surfaceRoot, loadOptions,
  timeoutMs } = {}) {
  // These checks precede constructing a Worker, canvas, runtime or asset lease.
  if (!enabled) throw new WebConformanceError('ERR_CONFORMANCE_DISABLED', 'explicit enabled:true is required')
  if (engine !== 'quickjs') throw new WebConformanceError('ERR_ENGINE', 'Web/V8 guest provider is unavailable in this candidate')
  check(loadOptions && loadOptions.engine === undefined && loadOptions.rendererTransitions === undefined
    && loadOptions.workerFactory === undefined && loadOptions.rpcOptions === undefined,
    'load options cannot override the fixed QuickJS/presenter contract')
  check(typeof loadOptions.workerUrl === 'string' && loadOptions.workerUrl.length > 0 || loadOptions.workerUrl instanceof URL,
    'explicit workerUrl from the separately verified actual host/guest build is required')
  const projectFrameJson = await loadRustProjection()
  const observer = new PresentedFrameObserver({ enabled: true, engine })
  const session = new WorkerWebSession({ surfaceRoot, factories: { canvasAdapter: options => {
    const rpc = observer.wrapRpc(options.rpc, options.owner)
    const adapter = new WorkerCanvasKitAdapter({ ...options, rpc })
    observer.attachAdapter(adapter)
    return adapter
  } } })
  const controller = new WebConformanceController({ session, observer, projectFrameJson, timeoutMs })
  try { await session.load(loadOptions); await controller.ready(); return controller }
  catch (error) {
    try { await controller.close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'candidate startup and actual cleanup failed') }
    throw error
  }
}
