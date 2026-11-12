import { BrowserHostServices } from './browser-host-services.mjs'
import { packHostApiWire } from './host-api-binary-wire.mjs'

/** Host-side proxy onto the Worker's serialized native lane. Configuration is
 * captured before load and installed by the Worker before its app.init turn.
 */
export class WorkerHostServicesTransport {
  #session; #configuration = null; #active = false; #closed = false; #retiring = false; #revocation = null; #packagedApiResources = false; #binaryTransfer = false
  constructor(session) {
    if (typeof session?.nativeHostServices !== 'function' || typeof session?.revokeHostIdentity !== 'function') throw Object.assign(new Error('Worker owner does not implement host services 1.0'), { code: 'ERR_PROTOCOL_VERSION' })
    this.#session = session
  }
  host_services_protocol_json() { return JSON.stringify({ version: '1.0', pendingNegotiation: !this.#active, componentFrames: '1.0', ...(this.#packagedApiResources?{packagedApiResources:'1.0'}:{}) }) }
  configure_host_services_json(config) {
    if (this.#configuration || this.#active) throw new Error('configure before loading the Worker')
    this.#configuration = JSON.parse(config)
  }
  get configuration() { return structuredClone(this.#configuration) }
  activate(loadResult) {
    if (loadResult?.hostServices?.version !== '1.0' || loadResult.hostServices.trustedContext !== true || loadResult.hostServices.ownerThreadCompletion !== true) throw Object.assign(new Error('loaded runtime rejected native host services protocol'), { code: 'ERR_PROTOCOL_VERSION' })
    if (this.#configuration?.apis?.some(name => ['component:camera','component:video'].includes(name)) && loadResult.hostServices.componentFrames !== '1.0') throw Object.assign(new Error('loaded runtime rejected bounded media frames'), {code:'ERR_PROTOCOL_VERSION'})
    this.#packagedApiResources = loadResult.hostServices.packagedApiResources === '1.0'
    this.#binaryTransfer = loadResult.hostServices.binaryTransfer === '1.0'
    this.#active = true
  }
  #requireActive() { if (!this.#active || this.#closed || this.#retiring) throw Object.assign(new Error('native Worker transport is retired'), { code: 'ERR_CANCELLED' }) }
  #nativeJson(op,payload) {
    this.#requireActive()
    const wire=packHostApiWire(payload)
    if(wire.transfer.length&&!this.#binaryTransfer)throw Object.assign(new Error('loaded Worker does not implement host binary transfers'),{code:'ERR_PROTOCOL_VERSION'})
    return this.#session.nativeHostServices(op,wire.value,{transfer:wire.transfer})
  }
  async take_host_requests_json() { this.#requireActive(); return JSON.stringify((await this.#session.nativeHostServices('native.take')).requests) }
  async complete_host_api_call_json(callId, completion) { return JSON.stringify((await this.#nativeJson('native.complete', { callId, completion: JSON.parse(completion) })).batch) }
  async dispatch_host_api_event_json(event) { return JSON.stringify((await this.#nativeJson('native.event', { event: JSON.parse(event) })).batch) }
  async authorize_phone_button_json(nodeId) { this.#requireActive(); return JSON.stringify((await this.#session.nativeHostServices('native.phone',{nodeId})).batch) }
  async dispatch_host_component_event_json(event) { return JSON.stringify((await this.#nativeJson('native.component',{event:JSON.parse(event)})).batch) }
  async update_host_service_snapshots_json(values) { await this.#nativeJson('native.snapshots',{values:JSON.parse(values)}) }
  async host_component_snapshots_json() { this.#requireActive(); return JSON.stringify((await this.#session.nativeHostServices('native.components')).components) }
  async host_component_resource(target) { this.#requireActive(); const result = await this.#session.nativeHostServices('native.media-resource',{target:JSON.parse(target)}); return result.pending ? null : new Uint8Array(result.bytes) }
  async host_api_resource(context) {
    this.#requireActive()
    if (!this.#packagedApiResources) throw Object.assign(new Error('loaded runtime does not implement verified API resources'),{code:'unsupported'})
    return new Uint8Array((await this.#session.nativeHostServices('native.api-resource',{context:JSON.parse(context)})).bytes)
  }
  async submit_host_component_frame(metadata, pixels) {
    this.#requireActive()
    if (!(pixels instanceof Uint8Array) || pixels.byteLength > 1024 * 1024) throw new Error('bounded RGBA bytes required')
    // Capture owns this exact buffer; transferring relinquishes it immediately.
    const bytes = pixels.byteOffset === 0 && pixels.byteLength === pixels.buffer.byteLength ? pixels : pixels.slice()
    return (await this.#session.nativeHostServices('native.frame', {metadata:JSON.parse(metadata),pixels:bytes}, {transfer:[bytes.buffer]})).accepted
  }
  revoke_host_services_json() {
    if (this.#closed) return Promise.resolve('[]')
    if (this.#revocation) return this.#revocation
    this.#retiring = true
    if (!this.#active) { this.#closed = true; return Promise.resolve('[]') }
    let resolve, reject
    const pending = new Promise((done, failed) => { resolve = done; reject = failed })
    this.#revocation = pending
    const failed = error => { this.#revocation = null; reject(error) }
    // Keep the transport blocked after a failed revoke, but retain the real
    // operation for an explicit close retry. Never report a failed release as
    // an already successful close on the next call.
    try {
      Promise.resolve(this.#session.revokeHostIdentity()).then(result => {
        try {
          if (!Array.isArray(result?.cancellations)) throw Object.assign(new Error('native revoke omitted its cancellation final'), { code: 'ERR_PROTOCOL_VERSION' })
          this.#closed = true; resolve(JSON.stringify(result.cancellations))
        } catch (error) { failed(error) }
      }, failed)
    } catch (error) { failed(error) }
    return pending
  }
}

/** Creates no browser, window, worker or surface of its own. The borrowed
 * WorkerWebSession remains the sole owner of those resources and their close.
 */
export async function loadBrowserHostServices({ session, catalog, trusted, loadOptions, environment = globalThis,
  onError = () => {}, ...options }) {
  const transport = new WorkerHostServicesTransport(session)
  let timer = null, running = null, stopped = false
  const tick = () => {
    if (stopped || timer !== null || running) return
    timer = environment.setTimeout(() => {
      timer = null
      if (stopped) return
      running = services.drain().catch(error => { stopped = true; onError(error); return services.close() })
        .finally(() => { running = null; if (!stopped) timer = environment.setTimeout(() => { timer = null; tick() }, 16) })
    }, 0)
  }
  const componentRoot = options.componentRoot || session.nativeComponentRoot
  const services = new BrowserHostServices({ runtime: transport, catalog, environment, ...options, componentRoot, onQueueReady: tick })
  try {
    await services.configure(trusted)
    const loaded = await session.load({ ...loadOptions, hostServices: transport.configuration })
    transport.activate(loaded.loadResult)
    if (componentRoot && environment.document) services.observeDomSurface({ root:componentRoot,sessionId:session.owner.sessionId,isInputEnabled:()=>session.status.inputEnabled })
    tick()
    return { services, loaded, async close() {
      stopped = true
      if (timer !== null) environment.clearTimeout(timer); timer = null
      const revoke = services.close()
      await running
      await revoke
    } }
  } catch (error) {
    stopped = true
    if (timer !== null) environment.clearTimeout(timer)
    try { await services.close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'native browser load and cleanup failed') }
    throw error
  }
}
