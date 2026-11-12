/** Browser-native host implementation. Device callbacks only enqueue data;
 * drain() is the sole entry into the QuickJS/WASM owner. No host credentials
 * are attached to fetch. Identity/payment must be explicitly supplied by host.
 */
import { browserFileDigest } from './browser-file-digest.mjs'
import { BrowserBluetoothOwner } from './browser-bluetooth-owner.mjs'
import { recorderSupport } from './browser-recorder-support.mjs'
import { BrowserWavRecorder } from './browser-wav-recorder.mjs'
import { HOST_API_RESOURCE_MAX_BYTES } from './worker-session-client.mjs'
export const BROWSER_HOST_SERVICES_PROTOCOL = Object.freeze({ version: '1.0', nativeContext: true, ownerQueue: true })
const MAX_CALLS = 256, MAX_EVENTS = 256, MAX_QUEUE_BYTES = 8 * 1024 * 1024, MAX_BINARY_BYTES = 32 * 1024 * 1024
// Rust admits at most 256 pending calls. Device producers cannot consume their
// terminal lane; each admitted call retains enough space for a bounded failure.
const MAX_COMPLETION_BYTES = 8 * 1024 * 1024, COMPLETION_RESERVE = 4096
const encoder = new TextEncoder()
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const check = (value, message, code = 'invalid_request') => { if (!value) throw Object.assign(new Error(message), { code }) }
const ok = (name, result = {}) => ({ errMsg: `${name.replace(/^wx\./, '')}:ok`, ...result })
const id = prefix => `${prefix}-${globalThis.crypto.randomUUID()}`
const safeValue = value => JSON.parse(JSON.stringify(value))
const validEpoch = value => (typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n)
  || Number.isSafeInteger(value) && value > 0
/** Map the Network Information API into the finite wx networkType vocabulary.
 * Browser connection names such as `cellular` and `ethernet` are transport
 * details, not values accepted by wx; effectiveType supplies the closest
 * coarse cellular generation when the browser exposes it. */
export const browserNetworkType = navigator => {
  if (navigator?.onLine === false) return 'none'
  const connection = navigator?.connection || navigator?.mozConnection || navigator?.webkitConnection
  const type = connection?.type
  if (type === 'wifi') return 'wifi'
  if (type === 'none') return 'none'
  const effective = connection?.effectiveType
  if (type === 'cellular' || effective) {
    if (effective === '2g' || effective === 'slow-2g') return '2g'
    if (effective === '3g') return '3g'
    if (effective === '4g') return '4g'
  }
  return 'unknown'
}
function identityState(value, account) {
  const fields=['hostLoggedIn','appLoggedIn','profileAuthorized','phoneAuthorized']
  check(value && fields.every(key=>typeof value[key]==='boolean'),'identity state requires four explicit authorization booleans')
  check(value.hostLoggedIn===(account.principalId!==null),'identity state belongs to a different host account','cancelled')
  // Application sessions and disclosure consent have separate lifetimes.
  // Issuing a login code does not redeem it, and app logout retains consent.
  check(value.hostLoggedIn || !value.appLoggedIn && !value.profileAuthorized && !value.phoneAuthorized,'identity grants require a host account')
  const state=Object.fromEntries(fields.map(key=>[key,value[key]]))
  if(value.authorizationVersion!==undefined) {
    check(typeof value.authorizationVersion==='string' && value.authorizationVersion.length>0,'identity authorizationVersion must be an opaque nonempty string')
    state.authorizationVersion=value.authorizationVersion
  }
  if(value.userInfo!=null) {
    check(value.profileAuthorized && typeof value.userInfo==='object' && !Array.isArray(value.userInfo),'identity userInfo requires profile authorization and a public profile object')
    state.userInfo=safeValue(value.userInfo)
  }
  return state
}
function decodeNativeValue(value) {
  if (!value || typeof value !== 'object') return value
  if (value.__weappBinary) {
    const descriptor = value.__weappBinary
    check(Array.isArray(descriptor.bytes) && descriptor.bytes.length <= 1024 * 1024
      && descriptor.bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255), 'invalid guest binary value')
    return new Uint8Array(descriptor.bytes).buffer
  }
  return Array.isArray(value) ? value.map(decodeNativeValue) : Object.fromEntries(Object.entries(value).map(([key,item]) => [key,decodeNativeValue(item)]))
}
const failure = (api, error) => ({ code: ['invalid_request','permission_denied','timeout','cancelled','unsupported'].includes(error?.code) ? error.code
  : error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'permission_denied'
    : error?.name === 'AbortError' ? 'cancelled' : error?.name === 'NotSupportedError' ? 'unsupported' : 'invalid_request',
message: error?.message || String(error), retryable: false,
details: { errMsg: error?.errMsg || `${api.replace(/^wx\./, '')}:fail ${error?.message || String(error)}`,
  ...(error?.errCode === undefined ? {} : { errCode: error.errCode }), ...(error?.details || {}) } })

/** Retained native buffers are scoped to this owner. Transfer out invalidates
 * the handle; explicit retain/release is bounded and expires on account change.
 */
export class BrowserBinaryStore {
  #values = new Map(); #bytes = 0; #scope; #closed = false
  constructor(scope, { maxBytes = MAX_BINARY_BYTES } = {}) { this.#scope = scope; this.maxBytes = maxBytes }
  put(value, { ttl = 30_000 } = {}) {
    check(!this.#closed, 'binary owner closed', 'cancelled')
    const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value).slice()
    this.sweep(); check(bytes.byteLength <= this.maxBytes - this.#bytes, 'binary backpressure limit exceeded')
    const handle = id('binary'); this.#values.set(handle, { bytes, refs: 1, expires: Date.now() + ttl }); this.#bytes += bytes.byteLength
    return Object.freeze({ handle, byteLength: bytes.byteLength, scope: this.#scope })
  }
  get(handle) { this.sweep(); const value = this.#values.get(handle); check(value, 'binary handle released or expired', 'cancelled'); return value.bytes.slice() }
  retain(handle) { const value = this.#values.get(handle); check(value && value.expires > Date.now(), 'binary handle expired', 'cancelled'); check(value.refs < 1024, 'binary retain limit exceeded'); value.refs++ }
  release(handle) { const value = this.#values.get(handle); if (!value) return false; if (--value.refs === 0) { this.#values.delete(handle); this.#bytes -= value.bytes.byteLength } return true }
  take(handle) { const value = this.get(handle); const stored = this.#values.get(handle); this.#bytes -= stored.bytes.byteLength; this.#values.delete(handle); return value.buffer }
  sweep() { for (const [handle, value] of this.#values) if (value.expires <= Date.now()) { this.#values.delete(handle); this.#bytes -= value.bytes.byteLength } }
  close() { this.#closed = true; this.#values.clear(); this.#bytes = 0 }
  get size() { return this.#values.size }
}

/** Async OPFS operations are acknowledged only after close/flush. This class
 * intentionally offers no synchronous persistent-file or storage methods.
 */
export class BrowserPrivateFiles {
  #root; #scope; #closed = false; #urls = new Set(); #memory = new Map()
  #pending = new Set(); #aborts = new Set(); #closeResult
  constructor(scope, navigator = globalThis.navigator) { this.#scope = scope; this.navigator = navigator }
  async initialize() {
    if (this.navigator?.storage?.getDirectory) {
      const digest = await crypto.subtle.digest('SHA-256', encoder.encode(this.#scope))
      const folder = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
      const root = await this.navigator.storage.getDirectory()
      this.#root = await root.getDirectoryHandle(`weapp-${folder}`, { create: true })
    }
    return this
  }
  path(path) {
    check(!this.#closed, 'file owner closed', 'cancelled')
    check(typeof path === 'string' && path.startsWith('wxfile://user/'), 'file path must be a managed wxfile://user/ path')
    const parts = path.slice(14).split('/')
    check(parts.length > 0 && parts.length <= 32 && parts.every(part => part && part !== '.' && part !== '..' && !/[\\\0]/.test(part)), 'invalid virtual file path')
    return parts
  }
  async #parent(path, create = false) {
    const parts = this.path(path); let parent = this.#root
    check(parent, 'persistent files require OPFS', 'unsupported')
    for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part, { create })
    return [parent, parts.at(-1)]
  }
  write(path, data, options = {}) { return this.#track(this.#write(path,data,options)) }
  #track(operation) { this.#pending.add(operation); void operation.then(()=>this.#pending.delete(operation),()=>this.#pending.delete(operation)); return operation }
  async #write(path, data, { append = false } = {}) {
    const parts = this.path(path); const bytes = data instanceof Blob ? data : new Blob([data])
    check(bytes.size <= MAX_BINARY_BYTES, 'file exceeds per-write limit')
    if (!this.#root) { this.#memory.set(parts.join('/'), append ? new Blob([this.#memory.get(parts.join('/')) || '', bytes]) : bytes); return }
    const [parent, name] = await this.#parent(path, true); const file = await parent.getFileHandle(name, { create: true })
    const stream = await file.createWritable({ keepExistingData: append })
    const release={abort:()=>stream.abort(),error:null};this.#aborts.add(release)
    try { if (append) await stream.seek((await file.getFile()).size); await stream.write(bytes); await stream.close();this.#aborts.delete(release) }
    catch (error) {
      try{await release.abort();this.#aborts.delete(release)}catch(cleanup){release.error=cleanup;throw new AggregateError([error,cleanup],'managed file write and abort failed')}
      throw error
    }
  }
  async read(path) {
    const parts = this.path(path)
    if (!this.#root) { const file = this.#memory.get(parts.join('/')); check(file, 'managed file does not exist'); return file }
    const [parent, name] = await this.#parent(path); return (await parent.getFileHandle(name)).getFile()
  }
  remove(path) { return this.#track(this.#remove(path)) }
  async #remove(path) { const parts = this.path(path); if (!this.#root) { check(this.#memory.delete(parts.join('/')), 'file does not exist'); return }
    const [parent, name] = await this.#parent(path); await parent.removeEntry(name) }
  async list(path) {
    const parts = this.path(path); let directory = this.#root; check(directory, 'directory listing requires OPFS', 'unsupported')
    for (const part of parts) directory = await directory.getDirectoryHandle(part)
    const files = []; for await (const key of directory.keys()) files.push(key); return files.sort()
  }
  mkdir(path) { return this.#track(this.#mkdir(path)) }
  async #mkdir(path) { const parts = this.path(path); let directory = this.#root; check(directory, 'directories require OPFS', 'unsupported'); for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true }) }
  async temporary(blob, extension = 'bin') { const path = `wxfile://user/tmp/${id('file')}.${extension}`; await this.write(path, blob); return path }
  async objectUrl(path) { const file=await this.read(path);check(!this.#closed,'file owner closed','cancelled');const url = URL.createObjectURL(file); this.#urls.add(url); return url }
  releaseUrl(url) { if (this.#urls.has(url)) { URL.revokeObjectURL(url);this.#urls.delete(url) } }
  close() {
    if(this.#closeResult)return this.#closeResult
    this.#closed=true
    const retry=[...this.#aborts].filter(release=>release.error)
    const closing=(async()=>{
      for(const release of retry)try{await release.abort();this.#aborts.delete(release)}catch(error){release.error=error}
      // Failed writes already report to their callers. Owner retirement waits
      // their native terminals and fails only if a writable handle is retained.
      while(this.#pending.size)await Promise.allSettled([...this.#pending])
      const errors=[]
      for(const url of this.#urls)try{URL.revokeObjectURL(url);this.#urls.delete(url)}catch(error){errors.push(error)}
      this.#memory.clear()
      errors.push(...[...this.#aborts].map(release=>release.error||new Error('managed writable stream did not close')))
      if(errors.length)throw new AggregateError(errors,'managed file owner drain failed; retry retained handles')
    })()
    this.#closeResult=closing.catch(error=>{this.#closeResult=null;throw error})
    return this.#closeResult
  }
  get persistent() { return Boolean(this.#root) }
}

export class BrowserHostServices {
  #runtime; #env; #catalog; #config; #handlers = new Map(); #snapshots = new Map()
  #calls = new Map(); #subscriptions = new Map(); #objects = new Map(); #components = new Map()
  #retainedCalls = new Map(); #objectReady = new Map(); #completedCalls = new Set(); #requestBacklog = new Map()
  #componentSequence = new Map(); #componentAvailability = new Set(); #domObserver = null; #domScan = null
  #queue = []; #queueBytes = 0; #queueInFlight = 0; #completionBytes = 0; #completionIds = new Set(); #closed = false; #draining = false; #sequence = 0; #overflow = null
  #watch = null; #wakeLock = null; #sensorStops = new Map(); #cleanup = new Set(); #prepared = false
  #closeResult; #closeStarted = false; #privateStoresClosing = false; #configureAbort = null; #identityState = null
  #identityRevision = 0; #identityHostRevision = 0
  #executions = new Set(); #releases = new Set(); #releaseRecords = new Map(); #oneShotLocations = new Set(); #resourceEpoch = 0
  #sensorIntents = new Map(); #wakeQueue = Promise.resolve(); #wakeLockRelease = null
  #frameSlots = new Map(); #frameBytes = 0; #frameSequence = new Map(); #frameProtocol = false; #frameFailures = new Map()
  #bluetoothOwner = null
  #battery = null
  #batteryListenersInstalled = false
  #recordingFormats = Object.freeze([])
  constructor({ runtime, catalog, environment = globalThis, componentRoot = null, allowedOrigins,
    identity = {}, payment = {}, bluetooth = null, onQueueReady = () => {}, onDiagnostic = () => {} } = {}) {
    check(runtime && typeof runtime.configure_host_services_json === 'function' && typeof runtime.host_services_protocol_json === 'function',
      'runtime does not implement host services protocol 1.0', 'unsupported')
    check(parse(runtime.host_services_protocol_json()).version === '1.0', 'host services protocol mismatch', 'unsupported')
    check(Array.isArray(catalog?.apis), 'frozen API catalog is required')
    this.#frameProtocol = parse(runtime.host_services_protocol_json()).componentFrames === '1.0' && typeof runtime.host_component_snapshots_json === 'function' && typeof runtime.submit_host_component_frame === 'function'
    this.#runtime = runtime; this.#env = environment; this.#catalog = new Map(catalog.apis.map(api => [api.name, api]))
    this.componentRoot = componentRoot; this.identity = identity; this.payment = payment; this.onQueueReady = onQueueReady; this.onDiagnostic = onDiagnostic
    this.bluetooth = bluetooth
    const origin = environment.location?.origin; this.allowedOrigins = new Set(allowedOrigins || (origin ? [origin] : []))
  }
  registerApiHandler(name, handler) {
    check(!this.#prepared, 'register API handlers before configure')
    const descriptor = this.#catalog.get(name)
    check(descriptor && descriptor.owner === 'host' && (descriptor.kind !== 'syncLocal' || descriptor.property === true) && descriptor.baseline !== 'newer-than-baseline', `${name} cannot be registered`)
    check(typeof handler === 'function', 'API handler must be a function'); this.#handlers.set(name, handler); return this
  }
  setSyncSnapshot(name, value) {
    check(!this.#prepared, 'install snapshots before configure')
    const descriptor = this.#catalog.get(name)
    check(descriptor?.owner === 'host' && descriptor.kind === 'syncSnapshot', `${name} is not a snapshot API`)
    this.#snapshots.set(name, safeValue(value)); return this
  }
  #track(operation) {
    const finished=Promise.resolve(operation).then(()=>{},()=>{}).finally(()=>this.#executions.delete(finished))
    this.#executions.add(finished);return operation
  }
  #release(action) {
    const previous=this.#releaseRecords.get(action);if(previous){if(this.#closed&&previous.error)throw previous.error;return this.#attemptRelease(previous)}
    const record={action,pending:null,error:null};this.#releases.add(record)
    this.#releaseRecords.set(action,record)
    return this.#attemptRelease(record)
  }
  #attemptRelease(record) {
    if(record.pending)return record.pending
    record.error=null
    try {
      const result=record.action()
      if(result&&typeof result.then==='function') {
        const pending=Promise.resolve(result).then(value=>{this.#releases.delete(record);this.#releaseRecords.delete(record.action);return value},error=>{record.error=error;throw error}).finally(()=>{record.pending=null})
        record.pending=pending;pending.catch(error=>this.#diagnostic(error));return pending
      }
      this.#releases.delete(record);this.#releaseRecords.delete(record.action);return result
    } catch(error) {record.error=error;throw error}
  }
  configure(options) { return this.#track(this.#configure(options)) }
  async #configure({ application, account, appAuthorized = false, identityState: initialIdentityState }) {
    check(!this.#prepared && !this.#closed, 'host services already configured or closed')
    check(validEpoch(account?.epoch), 'account epoch must be a safe positive integer')
    this.#config = safeValue({ application, account: { ...account, principalId: account.principalId ?? null } })
    const scope = JSON.stringify([application.hostAppId, application.tenantId, application.publisherId, application.appId, application.environment, account.principalId ?? null])
    this.binary = new BrowserBinaryStore(scope); this.files = await new BrowserPrivateFiles(scope, this.#env.navigator).initialize()
    if(this.#closed){await this.files.close();throw Object.assign(new Error('host owner retired during file initialization'),{code:'cancelled'})}
    this.#configureAbort=new AbortController()
    const suppliedState=typeof this.identity.getState==='function'
      ? await this.identity.getState({}, {context:{application:this.#config.application,account:this.#config.account,sessionId:'native-preflight',callId:id('identity-state'),api:'weappContainer.identity.getState'},signal:this.#configureAbort.signal,services:this})
      : initialIdentityState || {hostLoggedIn:this.#config.account.principalId!==null,appLoggedIn:appAuthorized===true,profileAuthorized:false,phoneAuthorized:false}
    if(this.#closed){await this.files.close();throw Object.assign(new Error('host owner retired during identity preparation'),{code:'cancelled'})}
    this.#identityState=identityState(suppliedState,this.#config.account)
    this.applicationAuthorized = this.#identityState.appLoggedIn
    // BatteryManager is asynchronous to acquire, but once the host has
    // acquired it the synchronous WeChat snapshot can be installed before
    // the guest starts. This preserves synchronous semantics without
    // inventing a promise-backed sync API. Browsers that do not expose the
    // Battery Status API simply leave the snapshot unavailable.
    if (typeof this.#env.navigator?.getBattery === 'function') {
      try {
        const battery = await this.#env.navigator.getBattery()
        if (battery && Number.isFinite(battery.level) && typeof battery.charging === 'boolean') {
          this.#battery = battery
          this.setSyncSnapshot('wx.getBatteryInfoSync', this.#batterySnapshot(battery))
        }
      } catch (error) {
        this.#diagnostic(error)
      }
    }
    this.#installBrowserApis()
    const orientation=this.#env.screen?.orientation?.type
    this.setSyncSnapshot('wx.getSystemSetting',orientation?{deviceOrientation:orientation.startsWith('landscape')?'landscape':'portrait'}:{})
    const authorizeSetting={}
    if(this.#env.navigator?.permissions?.query)for(const [name,key] of [['camera','cameraAuthorized'],['microphone','microphoneAuthorized'],['geolocation','locationAuthorized']]){
      try{const permission=await this.#env.navigator.permissions.query({name});authorizeSetting[key]=permission.state==='granted'?'authorized':permission.state==='denied'?'denied':'not determined'}catch{/* This browser does not expose this permission snapshot. */}
    }
    if(this.#closed){await this.files.close();throw Object.assign(new Error('host owner retired during permission snapshot'),{code:'cancelled'})}
    this.setSyncSnapshot('wx.getAppAuthorizeSetting',authorizeSetting)
    this.#prepared = true
    const apis = [...new Set([...this.#handlers.keys(), ...this.#snapshots.keys(), ...this.#componentAvailability])]
    await this.#runtime.configure_host_services_json(JSON.stringify({ ...this.#config, apis, syncValues: Object.fromEntries(this.#snapshots) }))
    this.#installBatteryListeners()
    return this.capabilities()
  }
  #batterySnapshot(battery) {
    return { level: Math.round(Math.min(1, Math.max(0, battery.level)) * 100), isCharging: battery.charging, errMsg: 'getBatteryInfoSync:ok' }
  }
  #installBatteryListeners() {
    const battery = this.#battery
    if (this.#batteryListenersInstalled || !battery || typeof battery.addEventListener !== 'function') return
    const update = () => {
      if (this.#closed || !this.#prepared) return
      try { this.updateSnapshots({ 'wx.getBatteryInfoSync': this.#batterySnapshot(battery) }) }
      catch (error) { this.#diagnostic(error) }
    }
    for (const event of ['levelchange', 'chargingchange']) {
      battery.addEventListener(event, update)
      this.#cleanup.add(() => battery.removeEventListener?.(event, update))
    }
    this.#batteryListenersInstalled = true
  }
  capabilities() {
    return Object.freeze({ version: '1.0', secureContext: this.#env.isSecureContext === true,
      apis: Object.freeze([...new Set([...this.#handlers.keys(), ...this.#snapshots.keys(), ...this.#componentAvailability])]),
      persistentFiles: this.files?.persistent === true, synchronousPersistentFiles: false, recordingFormats:this.#recordingFormats,
      permissions: 'queried-separately', maxEvents: MAX_EVENTS, maxPendingCalls: MAX_CALLS,
      maxQueueBytes: MAX_QUEUE_BYTES + MAX_COMPLETION_BYTES, maxEventQueueBytes: MAX_QUEUE_BYTES, maxCompletionQueueBytes: MAX_COMPLETION_BYTES, maxBinaryBytes: MAX_BINARY_BYTES })
  }
  updateSnapshots(values) {
    check(this.#prepared && !this.#closed && values && typeof values === 'object', 'snapshots require a live host owner')
    for (const name of Object.keys(values)) check(this.#snapshots.has(name), `${name} is not an installed snapshot`)
    return this.#enqueue({type:'snapshots',values:safeValue(values)})
  }
  setApplicationIdentityState(state) {
    check(this.#prepared && !this.#closed,'identity state requires a live prepared owner','cancelled')
    const value=identityState(state,this.#config.account)
    this.#identityHostRevision++
    this.#applyIdentityState(value)
  }
  #applyIdentityState(value) {
    this.#identityState=value;this.#identityRevision++;this.applicationAuthorized=value.appLoggedIn
    this.updateSnapshots({'weappContainer.identity.getState':value});this.#emit('IdentityChange',value)
  }
  #register(name, handler) { if (this.#catalog.get(name)?.owner === 'host' && !this.#handlers.has(name)) this.registerApiHandler(name, handler) }
  #assertContext(context) {
    check(!this.#closed && this.#prepared, 'host services owner retired', 'cancelled')
    check(context?.sessionId && String(context.account?.epoch) === String(this.#config.account.epoch)
      && context.account?.principalId === this.#config.account.principalId
      && ['hostAppId','tenantId','publisherId','appId','environment','packRoot'].every(key => context.application?.[key] === this.#config.application[key]),
    'untrusted or stale host API context', 'cancelled')
  }
  #diagnostic(error) { try { this.onDiagnostic(error) } catch { /* Diagnostics cannot interrupt resource cleanup or native settlement. */ } }
  #enqueue(entry, { coalesceKey, component, isCurrent } = {}) {
    if (this.#closed) return false
    let bytes = encoder.encode(JSON.stringify(entry)).byteLength
    const completion=entry.type==='completion'
    if(completion) {
      if(this.#completionIds.has(entry.callId))return true
      check(this.#completionIds.size<MAX_CALLS,'runtime exceeded negotiated pending-call bound')
      const reserve=(MAX_CALLS-this.#completionIds.size-1)*COMPLETION_RESERVE
      if(bytes>MAX_COMPLETION_BYTES-this.#completionBytes-reserve) {
        entry={type:'completion',callId:entry.callId,data:{error:failure(entry.api||'hostAPI',Object.assign(new Error('browser completion byte budget exceeded'),{code:'invalid_request'}))}}
        bytes=encoder.encode(JSON.stringify(entry)).byteLength
        check(bytes<=COMPLETION_RESERVE,'runtime call identity exceeds terminal reservation')
      }
      this.#completionIds.add(entry.callId);this.#completionBytes+=bytes
    } else {
      if (coalesceKey) {
        const previous = this.#queue.findIndex(value => value.coalesceKey === coalesceKey)
        if (previous >= 0) { this.#queueBytes -= this.#queue[previous].bytes; this.#queue.splice(previous, 1) }
      }
      const eventCount=this.#queue.reduce((count,value)=>count+(value.entry.type!=='completion'?1:0),0)+this.#queueInFlight
      if (eventCount >= MAX_EVENTS || bytes > MAX_QUEUE_BYTES - this.#queueBytes) {
        this.#overflow ||= Object.assign(new Error('browser native event queue is full; producer suspended'), { code: 'invalid_request' })
        this.#diagnostic(this.#overflow); return false
      }
      this.#queueBytes+=bytes
    }
    this.#queue.push({ entry, bytes, coalesceKey, component, isCurrent })
    try { this.onQueueReady() } catch (error) { this.#diagnostic(error) }
    return true
  }
  #emit(event, value, objectId, { coalesce = true, isCurrent } = {}) {
    if(this.#closed)return false
    try { value = this.#encodeNativeValue(value) } catch(error) { this.#diagnostic(error);return false }
    let accepted = true
    for (const [subscriptionId, subscription] of this.#subscriptions) {
      if (subscription.event !== event || subscription.objectId !== objectId) continue
      const data = { sessionId: subscription.context.sessionId, accountEpoch: subscription.context.account.epoch,
        subscriptionId, sequence: ++subscription.sequence, value, ...(objectId ? { objectId } : {}), event }
      accepted = this.#enqueue({ type: 'event', data }, { coalesceKey: coalesce ? subscriptionId : undefined,
        isCurrent:()=>this.#subscriptions.get(subscriptionId)===subscription&&(!isCurrent||isCurrent()) }) && accepted
    }
    return accepted
  }
  #encodeNativeValue(value, released = new Map()) {
    if (!value || typeof value !== 'object') return value
    let bytes
    if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer,value.byteOffset,value.byteLength)
    else if (typeof value.handle === 'string' && typeof value.byteLength === 'number' && typeof value.scope === 'string') {
      if (released.has(value.handle)) return released.get(value.handle)
      bytes = this.binary.get(value.handle)
      check(bytes.byteLength <= 1024*1024, 'binary chunk exceeds the runtime 1 MiB materialization limit')
      const converted = { __weappBinary: { bytes: [...bytes], type: 'ArrayBuffer' } }
      released.set(value.handle, converted); this.binary.release(value.handle)
      return converted
    }
    if (bytes) { check(bytes.byteLength <= 1024*1024, 'binary chunk exceeds the runtime 1 MiB materialization limit'); return { __weappBinary: { bytes: [...bytes], type: 'ArrayBuffer' } } }
    return Array.isArray(value) ? value.map(item => this.#encodeNativeValue(item,released))
      : Object.fromEntries(Object.entries(value).map(([key,item]) => [key,this.#encodeNativeValue(item,released)]))
  }
  #listen(event, payload, context) {
    check(typeof payload.subscriptionId === 'string', 'subscriptionId is required')
    if (payload.action === 'unsubscribe') this.#subscriptions.delete(payload.subscriptionId)
    else { check(this.#subscriptions.size < MAX_EVENTS, 'subscription limit exceeded'); this.#subscriptions.set(payload.subscriptionId, { event, objectId: payload.objectId, context, sequence: 0 }) }
    return ok(context.api)
  }
  #eventApis(on, off, event) {
    this.#register(on, (payload, { context }) => this.#listen(event, payload, context))
    if (off) this.#register(off, (payload, { context }) => this.#listen(event, { ...payload, action: 'unsubscribe' }, context))
  }
  #object(type, value, dispose = () => {}, objectId) {
    check(this.#objects.size < 256, 'native object limit exceeded'); objectId ||= id(type)
    check(!this.#objects.has(objectId), 'native object ID is already owned'); this.#objects.set(objectId, { type, value, dispose }); return objectId
  }
  #getObject(payload, type) {
    const objectId = payload.objectId || payload.taskId; const object = this.#objects.get(objectId)
    check(object && object.type === type, 'object belongs to a different owner or was destroyed', 'cancelled')
    return [object.value, objectId]
  }
  #destroyObject(objectId) { const object = this.#objects.get(objectId); if (!object) return; this.#objects.delete(objectId); return this.#release(object.dispose) }
  #url(value) {
    const url = new URL(value, this.#env.location?.href)
    check(['http:','https:','ws:','wss:'].includes(url.protocol), 'network URL protocol is not allowed')
    check(this.allowedOrigins.has(url.origin) || this.allowedOrigins.has(url.origin.replace(/^ws/, 'http')), 'network origin is not allowed', 'permission_denied')
    check(!url.username && !url.password, 'URL credentials are prohibited'); return url.href
  }
  #cancelCall(callId) {
    this.#calls.get(callId)?.abort(); this.#calls.delete(callId)
    this.#requestBacklog.delete(callId)
    this.#completedCalls.delete(callId)
    if(this.#completionIds.delete(callId)){const index=this.#queue.findIndex(value=>value.entry.type==='completion'&&value.entry.callId===callId);if(index>=0){this.#completionBytes-=this.#queue[index].bytes;this.#queue.splice(index,1)}}
    const retained=this.#retainedCalls.get(callId)
    if(retained?.objectId)try{Promise.resolve(this.#destroyObject(retained.objectId)).catch(error=>this.#diagnostic(error))}catch(error){this.#diagnostic(error)}
    if(retained?.subscriptionId)this.#subscriptions.delete(retained.subscriptionId)
    this.#retainedCalls.delete(callId)
  }
  async #takeNativeRequests() {
    const requests=parse(await this.#runtime.take_host_requests_json())
    // Destructive native reads must survive a later transport/presentation
    // failure. The runtime admits at most 256 in-flight calls in total.
    for(const request of requests)if(request.kind==='call')this.#requestBacklog.set(request.callId,request)
    for(const request of requests)if(request.kind==='cancel')this.#cancelCall(request.callId)
    check(this.#requestBacklog.size<=MAX_CALLS,'native request backlog limit exceeded')
  }
  /** This is called by the owner event loop after a normal runtime turn. It
   * drains callbacks and then starts newly produced requests without recursion.
   */
  async drain() {
    check(!this.#draining, 'native owner drain is reentrant'); if (this.#closed) return []
    this.#draining = true; const batches = []
    try {
      // A cancellation already committed by JS wins over a queued native
      // result. Keep ordinary new calls until callbacks from this batch finish.
      await this.#takeNativeRequests()
      if (this.#frameProtocol) await this.#refreshFrameComponents()
      let componentPresentationPending = false
      const queuedCount = Math.min(MAX_EVENTS,this.#queue.length)
      for (let count = 0; count < queuedCount && this.#queue.length; count++) {
        // JS entered by a preceding completion can revoke another producer.
        await this.#takeNativeRequests()
        if(!this.#queue.length)break
        const queued = this.#queue.shift(), { entry, bytes, component, coalesceKey, isCurrent } = queued
        const completion=entry.type==='completion'
        if(!completion)this.#queueInFlight++; let defer = false
        try {
          if(isCurrent&&!isCurrent())continue
          if (entry.type === 'completion') {
            try{batches.push(parse(await this.#runtime.complete_host_api_call_json(entry.callId, JSON.stringify(entry.data))))}
            catch(error){defer=true;throw error}
          }
          else if (entry.type === 'snapshots') { await this.#runtime.update_host_service_snapshots_json(JSON.stringify(entry.values)); for(const [name,value] of Object.entries(entry.values)) this.#snapshots.set(name,value) }
          else if (entry.type === 'component') {
            if (!this.#mediaAlive(component)) continue
            if (componentPresentationPending) defer = true
            else try { batches.push(parse(await this.#runtime.dispatch_host_component_event_json(JSON.stringify(entry.data)))) }
            catch (error) {
              // A prior callback may produce a new layout. Keep this exact
              // decoder's event bounded until the owner presents that layout;
              // other cancellation/security failures remain fatal.
              if ((error?.code === 'ERR_CANCELLED' || /^ERR_CANCELLED:/.test(String(error?.message || error)))
                && String(error?.message || error).includes('native component has no current presentation')) {
                componentPresentationPending = true; defer = true
              } else throw error
            }
          }
          else if (entry.type === 'phone') batches.push(parse(await this.#runtime.authorize_phone_button_json(entry.nodeId)))
          else batches.push(parse(await this.#runtime.dispatch_host_api_event_json(JSON.stringify(entry.data))))
        } finally {
          if(!completion)this.#queueInFlight--
          // A more recent coalesced event wins while an asynchronous transport
          // is pending. Reservations stay charged throughout the native call.
          if (defer && !this.#closed && (completion || this.#mediaAlive(component)) && (!coalesceKey || !this.#queue.some(value => value.coalesceKey === coalesceKey))) this.#queue.push(queued)
          else if (!this.#closed) {
            if(completion){this.#completionIds.delete(entry.callId);this.#completionBytes-=bytes;this.#completedCalls.add(entry.callId)}
            else this.#queueBytes-=bytes
          }
        }
      }
      // Frame pixels create a repaint that needs an actual presenter ACK. They
      // must follow callbacks/events, never revoke their presentation mid-drain.
      for (const [nodeId, frame] of this.#frameSlots) {
        this.#frameSlots.delete(nodeId); this.#frameBytes -= frame.pixels.byteLength
        if (this.#components.get(nodeId) !== frame.component || !this.#mediaAlive(frame.component)) continue
        await this.#runtime.submit_host_component_frame(JSON.stringify(frame.metadata), frame.pixels)
      }
      // Completion callbacks can cancel another completion from this batch.
      // Its controller is retained until this second native queue read.
      await this.#takeNativeRequests()
      for(const callId of this.#completedCalls)this.#calls.delete(callId)
      this.#completedCalls.clear()
      for (const [callId,request] of this.#requestBacklog) {
        this.#start(request)
        this.#requestBacklog.delete(callId)
      }
      this.binary.sweep(); return batches
    } finally { this.#draining = false; if(!this.#closed&&(this.#queue.length||this.#requestBacklog.size)){try{this.onQueueReady()}catch(error){this.#diagnostic(error)}} }
  }
  #start(request) {
    const controller = new AbortController()
    let timeout
    try {
      this.#assertContext(request.context)
      check(this.#calls.size < MAX_CALLS, 'native call concurrency limit exceeded')
      const handler = this.#handlers.get(request.method); check(handler, `unregistered browser API ${request.method}`, 'unsupported')
      this.#calls.set(request.callId, controller)
      if (request.deadlineNs != null) {
        const remaining = Number(BigInt(request.deadlineNs) / 1_000_000n) - Date.now()
        check(remaining > 0, 'native call deadline expired', 'timeout'); timeout = this.#env.setTimeout(() => controller.abort(), Math.min(remaining, 2_147_483_647))
      }
      const payload = decodeNativeValue(request.payload || {}), descriptor = this.#catalog.get(request.method)
      const prerequisite = request.method.startsWith('object:') && payload.objectId ? this.#objectReady.get(payload.objectId) : undefined
      const operation = Promise.resolve(prerequisite).then(() => {
        check(!controller.signal.aborted && !this.#closed, 'native call was revoked', 'cancelled')
        return handler(payload, { context: request.context, signal: controller.signal, services: this })
      })
      if (['object','task'].includes(descriptor?.kind) && payload.objectId) {
        this.#objectReady.set(payload.objectId, operation)
        this.#retainedCalls.set(request.callId, { objectId: payload.objectId })
      } else if (descriptor?.kind === 'subscription' && payload.action !== 'unsubscribe') this.#retainedCalls.set(request.callId, { subscriptionId: payload.subscriptionId })
      this.#track(operation)
        .then(result => {
          if (!controller.signal.aborted && !this.#closed) this.#enqueue({ type: 'completion', callId: request.callId, api:request.method, data: { result: this.#encodeNativeValue(result ?? ok(request.method)) } })
        })
        .catch(error => { if (!controller.signal.aborted && !this.#closed) this.#enqueue({ type: 'completion', callId: request.callId, api:request.method, data: { error: failure(request.method, error) } }) })
        .finally(() => { if(controller.signal.aborted||this.#closed)this.#calls.delete(request.callId); if (timeout) this.#env.clearTimeout(timeout) })
        .catch(error => this.#diagnostic(error))
    } catch (error) { this.#calls.delete(request.callId); this.#enqueue({ type: 'completion', callId: request.callId, api:request.method, data: { error: failure(request.method, error) } }) }
  }
  #installBrowserApis() {
    const env = this.#env, nav = env.navigator || {}, win = env.window || env
    const request = async (payload, { signal, context }) => {
      const method = (payload.method || 'GET').toUpperCase(), url = new URL(this.#url(payload.url))
      const headers = { 'content-type': 'application/json', ...payload.header }
      let body = payload.data
      if (method === 'GET' || method === 'HEAD') {
        if (payload.data && typeof payload.data === 'object' && !(payload.data instanceof ArrayBuffer) && !ArrayBuffer.isView(payload.data)) {
          for (const [key, value] of Object.entries(payload.data)) url.searchParams.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
        } else check(payload.data == null || payload.data === '', 'GET data must be a query object')
        body = undefined
      } else if (body != null && typeof body === 'object' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && !(body instanceof Blob)) {
        const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || ''
        body = String(contentType).includes('application/x-www-form-urlencoded') ? new URLSearchParams(Object.entries(body).map(([key,value]) => [key,String(value)])).toString() : JSON.stringify(body)
      }
      const response = await env.fetch(url.href, { method, headers, body,
        signal, credentials: 'omit', redirect: 'error' })
      const header = Object.fromEntries(response.headers.entries())
      let data
      if (payload.responseType === 'arraybuffer') data = await response.arrayBuffer()
      else { data = await response.text(); if (payload.dataType === 'json' || payload.dataType === undefined) { try { data = JSON.parse(data) } catch { /* WeChat retains text when JSON parsing fails. */ } } }
      return ok(context.api, { statusCode: response.status, header, data })
    }
    if (env.fetch) {
      this.#register('wx.request', request)
      this.#register('wx.downloadFile', async (payload, { signal, context }) => {
        const response = await env.fetch(this.#url(payload.url), { signal, headers: payload.header, credentials: 'omit', redirect: 'error' })
        check(Number(response.headers.get('content-length') || 0) <= MAX_BINARY_BYTES, 'download exceeds file limit')
        const blob = await response.blob(); check(blob.size <= MAX_BINARY_BYTES, 'download exceeds file limit')
        const path = payload.filePath || await this.files.temporary(blob)
        if (payload.filePath) await this.files.write(path, blob)
        return ok(context.api, { statusCode: response.status, tempFilePath: path, filePath: path })
      })
      this.#register('wx.uploadFile', async (payload, { signal, context }) => {
        const form = new env.FormData(); form.append(payload.name || 'file', await this.files.read(payload.filePath), payload.filePath.split('/').at(-1))
        for (const [key, value] of Object.entries(payload.formData || {})) form.append(key, String(value))
        const response = await env.fetch(this.#url(payload.url), { method: 'POST', body: form, headers: payload.header, credentials: 'omit', redirect: 'error', signal })
        return ok(context.api, { statusCode: response.status, data: await response.text() })
      })
    }
    if (env.WebSocket) {
      this.#register('wx.connectSocket', (payload, { context }) => {
        check(!payload.header || !Object.keys(payload.header).length, 'browser WebSocket cannot set custom headers', 'unsupported')
        const socket = new env.WebSocket(this.#url(payload.url), payload.protocols || []); socket.binaryType = 'arraybuffer'
        const objectId = this.#object('SocketTask', socket, () => { if (socket.readyState < 2) socket.close(1000, 'owner retired') }, payload.objectId || payload.taskId)
        socket.addEventListener('open', () => this.#emit('Open', {}, objectId, { coalesce: false }))
        socket.addEventListener('close', event => { this.#emit('Close', { code: event.code, reason: event.reason }, objectId, { coalesce: false }); this.#destroyObject(objectId) })
        socket.addEventListener('error', () => this.#emit('Error', { errMsg: 'socket error' }, objectId, { coalesce: false }))
        socket.addEventListener('message', event => {
          if(this.#closed || !this.#objects.has(objectId))return
          const data = typeof event.data === 'string' ? { data: event.data } : { data: this.binary.put(event.data), dataEncoding: 'binary-handle' }
          if (!this.#emit('Message', data, objectId, { coalesce: false })) { socket.close(1009, 'native queue backpressure'); this.#destroyObject(objectId) }
        })
        return ok(context.api, { objectId })
      })
      this.#register('object:SocketTask.send', (payload, { context }) => {
        const [socket] = this.#getObject(payload, 'SocketTask'); check(socket.readyState === 1, 'socket is not open')
        check(socket.bufferedAmount < MAX_QUEUE_BYTES, 'socket send backpressure limit exceeded')
        socket.send(payload.data?.handle ? this.binary.get(payload.data.handle) : payload.data); return ok(context.api)
      })
      this.#register('object:SocketTask.close', (payload, { context }) => { const [socket] = this.#getObject(payload, 'SocketTask'); socket.close(payload.code || 1000, payload.reason || ''); return ok(context.api) })
      for (const event of ['Open','Close','Error','Message']) this.#eventApis(`object:SocketTask.on${event}`, `object:SocketTask.off${event}`, event)
    }
    if (nav.geolocation?.watchPosition && nav.geolocation?.clearWatch) {
      const options = payload => {
        check(!payload.type || payload.type === 'wgs84', 'browser returns WGS84; GCJ02 requires an explicitly licensed transform', 'unsupported')
        const timeout=payload.highAccuracyExpireTime??15_000
        check(Number.isFinite(timeout)&&timeout>0&&timeout<=60_000,'location timeout must be in 1..60000 milliseconds')
        check(!this.#env.document?.hidden,'foreground location access required','permission_denied')
        return { enableHighAccuracy: payload.isHighAccuracy === true, timeout, maximumAge: 0 }
      }
      const position = p => ({ latitude: p.coords.latitude, longitude: p.coords.longitude, speed: p.coords.speed || 0,
        accuracy: p.coords.accuracy, altitude: p.coords.altitude || 0, verticalAccuracy: p.coords.altitudeAccuracy || 0, horizontalAccuracy: p.coords.accuracy })
      const locationError=error=>Object.assign(new Error(error.message), { code: error.code === 1 ? 'permission_denied' : error.code === 3 ? 'timeout' : 'invalid_request', errCode: error.code })
      this.#register('wx.getLocation', (payload, { signal, context }) => new Promise((resolve, reject) => {
        const configuration=options(payload)
        let watchId,ready=false,early,settled=false
        const finish=(error,value)=>{
          if(!ready){early=[error,value];return}if(settled)return;settled=true
          signal.removeEventListener('abort',onAbort);this.#oneShotLocations.delete(cancel)
          try{this.#release(()=>nav.geolocation.clearWatch(watchId))}catch(cleanup){error=cleanup}
          if(error)reject(error);else resolve(ok(context.api,value))
        }
        const cancel=()=>finish(Object.assign(new Error('location cancelled'),{code:'cancelled'})),onAbort=cancel
        check(!signal.aborted&&!this.#closed,'location owner retired','cancelled')
        signal.addEventListener('abort',onAbort,{once:true});this.#oneShotLocations.add(cancel)
        try{watchId=nav.geolocation.watchPosition(p=>finish(null,position(p)),error=>finish(locationError(error)),configuration)}
        catch(error){signal.removeEventListener('abort',onAbort);this.#oneShotLocations.delete(cancel);throw error}
        ready=true;if(early)finish(...early)
      }))
      this.#register('wx.startLocationUpdate', (payload, { context,signal }) => {
        const configuration=options(payload);this.#stopLocationWatch()
        const watch={id:null,active:true,stop:()=>{nav.geolocation.clearWatch(watch.id);if(this.#watch===watch)this.#watch=null}};this.#watch=watch
        const isCurrent=()=>watch.active&&this.#watch===watch&&!this.#closed
        try{watch.id=nav.geolocation.watchPosition(p=>{
          if(isCurrent()&&!this.#emit('LocationChange',position(p),undefined,{isCurrent}))this.#stopLocationWatch()
        },error=>{
          if(isCurrent())this.#emit('LocationError',{errCode:error.code,errMsg:error.message},undefined,{isCurrent})
        },configuration)}catch(error){watch.active=false;this.#watch=null;throw error}
        if(signal.aborted||this.#closed)this.#stopLocationWatch()
        return ok(context.api)
      })
      this.#register('wx.stopLocationUpdate', (payload, { context }) => { this.#stopLocationWatch(); return ok(context.api) })
      this.#eventApis('wx.onLocationChange','wx.offLocationChange','LocationChange'); this.#eventApis('wx.onLocationError','wx.offLocationError','LocationError')
    }
    if (nav.clipboard?.writeText) this.#register('wx.setClipboardData', async (payload, { context }) => { check(typeof payload.data === 'string', 'clipboard data must be a string'); await nav.clipboard.writeText(payload.data); return ok(context.api) })
    if (nav.clipboard?.readText) this.#register('wx.getClipboardData', async (payload, { context }) => ok(context.api, { data: await nav.clipboard.readText() }))
    if (nav.vibrate) for (const [api, pattern] of [['wx.vibrateShort', 15],['wx.vibrateLong',400]]) this.#register(api, (payload, { context }) => { check(nav.vibrate(pattern), 'vibration is unavailable', 'unsupported'); return ok(context.api) })
    if (nav.share) this.#register('wx.shareFileMessage', async (payload, { context }) => { const blob = await this.files.read(payload.filePath); const file = new env.File([blob], payload.fileName || 'shared-file'); check(!nav.canShare || nav.canShare({ files: [file] }), 'file sharing is unavailable', 'unsupported'); await nav.share({ files: [file] }); return ok(context.api) })
    if (nav.wakeLock?.request) this.#register('wx.setKeepScreenOn', (payload, { context, signal }) => {
      check(typeof payload.keepScreenOn==='boolean','keepScreenOn must be boolean')
      const epoch=this.#resourceEpoch
      const task=this.#wakeQueue.then(async()=>{
        await this.#releaseWakeLock()
        check(!signal.aborted&&!this.#closed&&epoch===this.#resourceEpoch,'wake-lock owner retired','cancelled')
        if(payload.keepScreenOn) {
          check(!env.document?.hidden,'foreground wake-lock access required','permission_denied')
          const lock=await nav.wakeLock.request('screen');this.#wakeLock=lock
          this.#wakeLockRelease=async()=>{await lock.release();if(this.#wakeLock===lock){this.#wakeLock=null;this.#wakeLockRelease=null}}
          if(signal.aborted||this.#closed||epoch!==this.#resourceEpoch||env.document?.hidden) {await this.#releaseWakeLock();throw Object.assign(new Error('wake-lock owner retired'),{code:'cancelled'})}
        }
        return ok(context.api)
      });this.#wakeQueue=task.catch(()=>{});return task
    })
    else this.#register('wx.setKeepScreenOn', payload => {
      check(typeof payload.keepScreenOn === 'boolean', 'keepScreenOn must be boolean')
      check(false, 'Screen Wake Lock API is unavailable in this browser', 'unsupported')
    })
    if (win.addEventListener) {
      const network = () => this.#emit('NetworkStatusChange', { isConnected: nav.onLine !== false, networkType: browserNetworkType(nav) })
      for (const event of ['online','offline']) { win.addEventListener(event, network); this.#cleanup.add(() => win.removeEventListener(event, network)) }
      this.#register('wx.getNetworkType', (payload, { context }) => ok(context.api, { networkType: browserNetworkType(nav) }))
      this.#eventApis('wx.onNetworkStatusChange','wx.offNetworkStatusChange','NetworkStatusChange')
      const visibility = () => { if (env.document?.hidden) { try{this.#stopBackgroundResources()}catch(error){this.#diagnostic(error)} this.#emit('AppHide', {}) } else this.#emit('AppShow', {}) }
      env.document?.addEventListener('visibilitychange', visibility); this.#cleanup.add(() => env.document?.removeEventListener('visibilitychange', visibility))
    }
    if (nav.getBattery) this.#register('wx.getBatteryInfo', async (payload, { context }) => {
      const battery = this.#battery || await nav.getBattery()
      check(battery && Number.isFinite(battery.level) && typeof battery.charging === 'boolean', 'browser battery snapshot is invalid', 'unsupported')
      return ok(context.api, { level: Math.round(Math.min(1, Math.max(0, battery.level)) * 100), isCharging: battery.charging })
    })
    if (nav.permissions?.query) this.#register('wx.getSetting', async (payload, { context }) => {
      const authSetting = {}
      for (const [name, scope] of [['geolocation','scope.userLocation'],['camera','scope.camera'],['microphone','scope.record'],['clipboard-read','scope.clipboard']]) {
        try { const permission = await nav.permissions.query({ name }); if (permission.state !== 'prompt') authSetting[scope] = permission.state === 'granted' } catch { /* browser does not expose this permission query */ }
      }
      return ok(context.api, { authSetting })
    })
    if (env.DeviceMotionEvent || env.DeviceOrientationEvent) this.#installSensors()
    if (this.bluetooth) this.#installBluetooth()
    if (env.NDEFReader) this.#installNfc()
    const recording=recorderSupport(env,this.files?.persistent===true)
    this.#recordingFormats=Object.freeze(Object.keys(recording.formats))
    if (recording.available) this.#installRecorder(recording)
    if (env.Audio) this.#installAudio()
    if (nav.mediaDevices?.getUserMedia && this.componentRoot) { this.#installCamera(); this.#componentAvailability.add('component:camera') }
    if (env.document && this.componentRoot) { this.#installVideo(); this.#componentAvailability.add('component:video') }
    this.#installFiles()
    for (const [api, callback] of [['wx.login',this.identity.login],['wx.checkSession',this.identity.checkSession],['wx.getUserProfile',this.identity.getUserProfile],['wx.getUserInfo',this.identity.getUserInfo],
      ['weappContainer.identity.logout',this.identity.logout],['weappContainer.identity.authorizePhone',this.identity.authorizePhone],['wx.requestPayment',this.payment.requestLegacy],['weappContainer.payment.request',this.payment.request]]) {
      if (typeof callback === 'function') this.#register(api, async (payload, call) => {
        const hostRevision=this.#identityHostRevision
        const refresh=async()=>{
          for(let attempt=0;attempt<3;attempt++) {
            check(hostRevision===this.#identityHostRevision,'host identity changed during API call','cancelled')
            const revision=this.#identityRevision
            const state=identityState(await this.identity.getState({},call),this.#config.account)
            check(!call.signal.aborted && !this.#closed,'identity owner retired during state refresh','cancelled')
            // Explicit host notifications revoke in-flight reads immediately.
            check(hostRevision===this.#identityHostRevision,'host identity changed during state refresh','cancelled')
            if(revision!==this.#identityRevision) {
              if(JSON.stringify(state)===JSON.stringify(this.#identityState))return
              // Backend versions are opaque. If a sibling refresh won, read
              // again rather than guessing which of the two versions is newer.
              continue
            }
            this.#applyIdentityState(state);return
          }
          check(false,'identity state kept changing during state refresh','cancelled')
        }
        let result
        try { result=await callback(payload,call) }
        catch(error) {
          const backendCode=error?.backendCode ?? error?.details?.backendCode ?? error?.code
          const consentApi=['wx.getUserProfile','wx.getUserInfo','weappContainer.identity.authorizePhone'].includes(api)
          if((consentApi || api==='wx.checkSession' && ['invalid_app_session','ERR_INVALID_APP_SESSION'].includes(backendCode))
            && typeof this.identity.getState==='function' && !call.signal.aborted && !this.#closed) {
            // A refusal can revoke an earlier grant. Project the backend state
            // without replacing the original API failure. A second error must never
            // replace the business error or resurrect a retired owner.
            try { await refresh() } catch(refreshError) { this.#diagnostic(refreshError) }
          }
          throw error
        }
        // Logout may synchronously retire this execution owner. Its operation
        // receipt is queried through the stable host controller; refreshing the
        // retiring handler would wait on the owner it is helping to close.
        if(api==='weappContainer.identity.logout' && (call.signal.aborted || this.#closed))return result
        if(!api.includes('payment') && api!=='wx.requestPayment')check(hostRevision===this.#identityHostRevision,'host identity changed during API call','cancelled')
        if(api==='weappContainer.identity.logout' && typeof this.identity.getState!=='function')this.setApplicationIdentityState({...this.#identityState,appLoggedIn:false})
        else if(!api.includes('payment') && api!=='wx.requestPayment' && typeof this.identity.getState==='function')await refresh()
        if(typeof this.identity.getState==='function') {
          if(api==='wx.getUserProfile' || api==='wx.getUserInfo')check(this.#identityState.profileAuthorized,'profile authorization was revoked','permission_denied')
          if(api==='weappContainer.identity.authorizePhone')check(this.#identityState.phoneAuthorized,'phone authorization was revoked','permission_denied')
        }
        return result
      })
    }
    this.setSyncSnapshot('weappContainer.identity.getState', this.#identityState)
    this.#eventApis('weappContainer.identity.onChange','weappContainer.identity.offChange','IdentityChange')
  }
  #installFiles() {
    const files = this.files
    this.#register('wx.getFileSystemManager', (payload, { context }) => ok(context.api, { objectId: this.#object('FileSystemManager', files, () => {}, payload.objectId) }))
    for (const [member, run] of [
      ['readFile', async p => {
        check(p.encoding == null || ['utf8','utf-8'].includes(p.encoding), 'this adapter supports utf8 text or ArrayBuffer reads', 'unsupported')
        return { data: p.encoding ? await (await files.read(p.filePath)).text() : await (await files.read(p.filePath)).arrayBuffer() }
      }],
      ['writeFile', async p => { check(p.encoding == null || ['utf8','utf-8'].includes(p.encoding), 'this adapter supports utf8 text or ArrayBuffer writes', 'unsupported'); await files.write(p.filePath, p.data?.handle ? this.binary.get(p.data.handle) : p.data); return {} }],
      ['appendFile', async p => { check(p.encoding == null || ['utf8','utf-8'].includes(p.encoding), 'this adapter supports utf8 text or ArrayBuffer writes', 'unsupported'); await files.write(p.filePath, p.data, { append: true }); return {} }],
      ['unlink', async p => { await files.remove(p.filePath); return {} }],
      ['mkdir', async p => { await files.mkdir(p.dirPath); return {} }],
      ['readdir', async p => ({ files: await files.list(p.dirPath) })],
      ['copyFile', async p => { await files.write(p.destPath, await files.read(p.srcPath)); return {} }],
      ['rename', async p => { await files.write(p.newPath, await files.read(p.oldPath)); await files.remove(p.oldPath); return {} }],
      ['access', async p => { await files.read(p.path); return {} }],
      ['getFileInfo', async p => ({ size: (await files.read(p.filePath)).size })],
    ]) this.#register(`object:FileSystemManager.${member}`, async (payload, { context }) => { this.#getObject(payload, 'FileSystemManager'); return ok(context.api, await run(payload)) })
    this.#register('wx.getFileInfo', async (payload, { context }) => {
      const file = await files.read(payload.filePath), buffer = await file.arrayBuffer()
      return ok(context.api, { size: file.size, digest: await browserFileDigest(buffer,payload.digestAlgorithm) })
    })
    this.#register('wx.saveFile', async (payload, { context }) => { const savedFilePath = payload.filePath || `wxfile://user/saved/${id('file')}`; await files.write(savedFilePath, await files.read(payload.tempFilePath)); return ok(context.api, { savedFilePath }) })
    this.#register('wx.removeSavedFile', async (payload, { context }) => { await files.remove(payload.filePath); return ok(context.api) })
  }
  #installSensors() {
    const env = this.#env, win = env.window || env
    for (const [api, event, type, browserEvent, transform] of [
      ['Accelerometer','AccelerometerChange','Accelerometer','devicemotion', e => ({ x: -(e.accelerationIncludingGravity?.x || 0) / 9.80665, y: -(e.accelerationIncludingGravity?.y || 0) / 9.80665, z: -(e.accelerationIncludingGravity?.z || 0) / 9.80665 })],
      ['Gyroscope','GyroscopeChange','Gyroscope','devicemotion', e => ({ x: (e.rotationRate?.beta || 0) * Math.PI / 180, y: (e.rotationRate?.gamma || 0) * Math.PI / 180, z: (e.rotationRate?.alpha || 0) * Math.PI / 180 })],
      ['Compass','CompassChange','AbsoluteOrientationSensor','deviceorientationabsolute', e => ({ direction: (360 - (e.alpha || 0)) % 360, accuracy: e.webkitCompassAccuracy ?? 0 })],
    ]) {
      if (!env.DeviceMotionEvent && type !== 'AbsoluteOrientationSensor') continue
      if (type === 'AbsoluteOrientationSensor' && !env.DeviceOrientationEvent) continue
      this.#register(`wx.start${api}`, async (payload, { context, signal }) => {
        const epoch=this.#resourceEpoch
        check(!env.document?.hidden,'foreground sensor access required','permission_denied')
        this.#stopSensor(api)
        const intent={};this.#sensorIntents.set(api,intent)
        const permissionType = api === 'Compass' ? env.DeviceOrientationEvent : env.DeviceMotionEvent
        if (permissionType?.requestPermission) check(await permissionType.requestPermission() === 'granted', 'sensor permission denied', 'permission_denied')
        check(!signal.aborted&&!this.#closed&&epoch===this.#resourceEpoch&&this.#sensorIntents.get(api)===intent&&!env.document?.hidden, 'sensor owner retired while requesting permission', 'cancelled')
        const source={active:true,stop:null},isCurrent=()=>source.active&&this.#sensorStops.get(api)===source&&!this.#closed
        const listener=e=>{if(isCurrent()&&!this.#emit(event,transform(e),undefined,{isCurrent})) {try{this.#stopSensor(api)}catch(error){this.#diagnostic(error)}}}
        source.stop=()=>{win.removeEventListener(browserEvent,listener);if(this.#sensorStops.get(api)===source)this.#sensorStops.delete(api)}
        this.#sensorStops.set(api,source)
        try{win.addEventListener(browserEvent,listener)}catch(error){this.#stopSensor(api);throw error}
        return ok(context.api)
      })
      this.#register(`wx.stop${api}`, (payload, { context }) => { this.#stopSensor(api);return ok(context.api) })
      this.#eventApis(`wx.on${event}`,`wx.off${event}`,event)
    }
  }
  #installBluetooth() {
    check(this.#env.isSecureContext !== false, 'Web Bluetooth requires a secure context', 'unsupported')
    const owner = new BrowserBluetoothOwner({ configuration: this.bluetooth, ...this.#config, bluetooth: this.#env.navigator?.bluetooth,
      emit: (event, value, isCurrent) => this.#emit(event, value, undefined, { coalesce: false, isCurrent }), diagnostic: error => this.#diagnostic(error) })
    this.#bluetoothOwner = owner
    for (const [api, handler] of owner.handlers()) this.#register(api, handler)
    this.#cleanup.add(owner.close)
    this.#eventApis('wx.onBLEConnectionStateChange','wx.offBLEConnectionStateChange','BLEConnectionStateChange')
    this.#eventApis('wx.onBLECharacteristicValueChange','wx.offBLECharacteristicValueChange','BLECharacteristicValueChange')
  }
  #installNfc() {
    // Web NFC is an NDEF message API, not the locked wx tag-connection API.
    // Its record parser transforms text/URI payloads and exposes record IDs as
    // strings; scan()/write() do not expose tag connect/isConnected or raw NFC
    // technology commands. Advertising these wx leaves would fabricate their
    // binary/connection contract. Install no reader or capability here; a
    // future exact UID-only subset or separately catalogued host adapter must
    // establish its own contract. See docs/host-services/WEB-NFC.md and the
    // official specification: https://w3c-cg.github.io/web-nfc/ .
  }
  #installRecorder(support) {
    const env = this.#env
    const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});promise.catch(()=>{});return {promise,resolve,reject}}
    const now=()=>env.performance?.now?.() ?? Date.now()
    const mime=value=>String(value||'').split(';',1)[0].trim().toLowerCase()
    const retired=()=>Object.assign(new Error('recorder owner retired'),{code:'cancelled'})
    const current=record=>!this.#closed&&!record.owner.disposed&&record.owner.generation===record.generation&&this.#objects.get(record.objectId)?.value===record.owner
    const live=record=>current(record)&&!record.revoked
    const activeTime=record=>record.elapsed+(record.segment===null?0:Math.max(0,now()-record.segment))
    const clearTimer=record=>{if(record.timer!==null){env.clearTimeout(record.timer);record.timer=null}}
    const report=(record,error)=>{this.#diagnostic(error);if(current(record))this.#emit('Error',{errMsg:error?.message||String(error),...(error?.code===undefined?{}:{errCode:error.code})},record.objectId,{coalesce:false,isCurrent:()=>current(record)})}
    const rememberTracks=record=>{
      // Enumerate again on retry if getTracks itself failed. Every acquired
      // track gets one stable release action, including a late permission result.
      for(const track of record.stream?.getTracks()||[])if(!record.tracks.has(track)) {
        const ended=()=>{if(live(record)&&!record.stopObserved){emit(record,'InterruptionBegin',{});report(record,new Error('microphone track ended'));revoke(record)}}
        const item={stop:async()=>{if(track.readyState!=='ended')await track.stop();check(track.readyState==='ended','microphone track stop is not acknowledged')},detach:()=>track.removeEventListener('ended',ended)}
        record.tracks.set(track,item);track.addEventListener('ended',ended)
      }
    }
    const cleanTracks=async record=>{
      const errors=[];rememberTracks(record)
      for(const item of record.tracks.values())for(const action of [item.stop,item.detach])try{await this.#release(action)}catch(error){errors.push(error)}
      if(errors.length)throw errors[0]
    }
    const stopNative=async record=>{
      await record.ready.promise
      if(!record.startIssued||record.stopObserved)return
      // stop() changes .state synchronously; only the real stop event proves
      // that final dataavailable and the native recording operation have ended.
      if(!record.stopRequested&&record.recorder.state!=='inactive'){record.recorder.stop();record.stopRequested=true;record.elapsed=activeTime(record);record.segment=null}
      await record.terminal.promise
    }
    const finalize=record=>{
      if(record.finalized)return Promise.resolve()
      if(record.finalizing)return record.finalizing
      const operation=(async()=>{
        await record.ready.promise
        if(record.startIssued)await record.terminal.promise
        await this.#release(record.detachStartAbort)
        for(const intent of record.actionAborts.values())await this.#release(intent.detach)
        await this.#release(record.releaseRecorder)
        await cleanTracks(record);await this.#release(record.clearTimer)
        if(record.recorder)await this.#release(record.detach)
        if(live(record)&&record.startIssued) {
          check(record.chunks.length&&record.bytes>0,'native recorder produced no encoded audio')
          check(record.acceptedMimes.includes(mime(record.recorder.mimeType)),'native recorder changed the requested encoding','unsupported')
          const blob=new (env.Blob||Blob)(record.chunks,{type:record.recorder.mimeType})
          check(blob.size===record.bytes&&blob.size<=MAX_BINARY_BYTES,'native recording exceeded its complete-file bound')
          record.path||=`wxfile://user/tmp/${id('recording')}.${record.format}`
          if(!record.persisted){
            record.writeStarted=true
            try{await this.files.write(record.path,blob);record.persisted=true}
            catch(error){await this.#release(record.removeFile);throw error}
          }
          if(live(record)) {
            const duration=record.backend==='wav-worklet'?record.recorder.recordedDurationMs:record.elapsed
            if(!emit(record,'Stop',{tempFilePath:record.path,fileSize:blob.size,duration:Math.round(duration),mimeType:blob.type,...(record.backend==='wav-worklet'?{sampleRate:record.sampleRate,numberOfChannels:record.channels,pcmBitsPerSample:16,pcmBitRate:record.recorder.audioBitsPerSecond}:{})}))record.revoked=true
            else record.published=true
          }
        }
        // A write already in progress at revocation must finish and then be
        // removed from the old private scope before this owner acknowledges drain.
        if(record.writeStarted&&!record.published)await this.#release(record.removeFile)
        record.chunks=[];record.bytes=0;record.finalized=true;record.owner.records.delete(record)
        if(record.owner.current===record)record.owner.current=null
      })()
      record.finalizing=operation.finally(()=>{record.finalizing=null});record.finalizing.catch(()=>{});return record.finalizing
    }
    const revoke=record=>{
      record.revoked=true
      try{this.#track(Promise.resolve(this.#release(record.dispose))).catch(error=>report(record,error))}catch(error){report(record,error)}
    }
    const emit=(record,event,value)=>{
      const isCurrent=()=>event==='InterruptionBegin'?current(record):live(record)
      if(!isCurrent())return false
      const accepted=this.#emit(event,value,record.objectId,{coalesce:false,isCurrent})
      if(!accepted)revoke(record)
      return accepted
    }
    const schedule=record=>{
      clearTimer(record)
      // PCM duration is measured and stopped on the native render thread.
      if(record.backend==='wav-worklet')return
      if(live(record)&&!record.stopRequested&&record.segment!==null)record.timer=env.setTimeout(()=>{
        record.timer=null
        if(live(record))this.#track(stopNative(record).then(()=>finalize(record))).catch(error=>{report(record,error);revoke(record)})
      },Math.max(0,record.duration-activeTime(record)))
    }
    const validate=payload=>{
      const format=payload.format??'aac'
      check(typeof format==='string'&&['mp3','aac','wav','PCM'].includes(format),'invalid recorder format')
      const codec=support.formats[format]
      check(codec,`browser does not encode the requested ${format} format`,'unsupported')
      const {acceptedMimes,mimeType,backend}=codec
      if(backend==='media-recorder'){
        let available=false;try{available=env.MediaRecorder.isTypeSupported(mimeType)===true}catch{/* No replacement encoding is permitted. */}
        check(available,`browser no longer encodes the requested ${format} format`,'unsupported')
      }
      const duration=payload.duration??60_000,sampleRate=payload.sampleRate??8000,channels=payload.numberOfChannels??2,bitrate=payload.encodeBitRate??48000
      check(Number.isInteger(duration)&&duration>0&&duration<=600_000,'recording duration must be 1..600000 milliseconds')
      check([8000,11025,12000,16000,22050,24000,32000,44100,48000].includes(sampleRate),'unsupported recorder sample rate')
      check(channels===1||channels===2,'recorder needs one or two channels')
      if(backend!=='wav-worklet'||payload.encodeBitRate!==undefined){
        check(Number.isInteger(bitrate)&&bitrate>=16000&&bitrate<=320000,'recorder bitrate must be 16000..320000')
        const ranges={8000:[16000,48000],11025:[16000,48000],12000:[24000,64000],16000:[24000,96000],22050:[32000,128000],24000:[32000,128000],32000:[48000,192000],44100:[64000,320000],48000:[64000,320000]}
        check(bitrate>=ranges[sampleRate][0]&&bitrate<=ranges[sampleRate][1],'recorder bitrate is outside the baseline range for its sample rate')
      }
      check(backend!=='wav-worklet'||payload.encodeBitRate===undefined,'uncompressed PCM WAV cannot satisfy a compressed encodeBitRate option','unsupported')
      check(payload.frameSize===undefined,'browser recorder does not expose complete encoded frame callbacks','unsupported')
      check(payload.audioSource===undefined||payload.audioSource==='auto','browser recorder cannot select the requested native audio source','unsupported')
      check(payload.audioMode===undefined||payload.audioMode==='default','browser recorder cannot guarantee the requested native audio processing mode','unsupported')
      check(this.files?.persistent===true,'recording requires persistent private browser files','unsupported')
      check(!env.document?.hidden,'foreground microphone access required','permission_denied')
      return {format,acceptedMimes,mimeType,backend,duration,sampleRate,channels,bitrate}
    }
    this.#register('wx.getRecorderManager', (payload, { context }) => {
      const owner={current:null,records:new Set(),generation:0,disposed:false}
      const dispose=async()=>{owner.disposed=true;owner.generation++;const errors=[];for(const record of [...owner.records])try{await record.dispose()}catch(error){errors.push(error)}if(errors.length)throw errors[0]}
      return ok(context.api,{objectId:this.#object('RecorderManager',owner,dispose,payload.objectId)})
    })
    this.#register('object:RecorderManager.start', async (payload, { context, signal }) => {
      const [owner,objectId]=this.#getObject(payload,'RecorderManager');check(!owner.current,'recorder is already acquiring, recording or draining')
      const options=validate(payload),record={...options,owner,objectId,generation:++owner.generation,stream:null,recorder:null,tracks:new Map(),chunks:[],bytes:0,elapsed:0,segment:null,timer:null,ready:deferred(),terminal:deferred(),waiters:new Map(),actionAborts:new Map(),revoked:false,startIssued:false,stopObserved:false,stopRequested:false,finalized:false}
      record.clearTimer=()=>clearTimer(record)
      record.releaseRecorder=()=>record.recorder?.release?.()
      record.detach=()=>{for(const event of ['start','pause','resume','error','dataavailable','stop'])record.recorder[`on${event}`]=null}
      record.removeFile=async()=>{if(record.writeStarted){try{await this.files.remove(record.path)}catch(error){if(error?.name!=='NotFoundError')throw error}record.persisted=false;record.writeStarted=false}}
      record.dispose=()=>{
        if(record.disposing)return record.disposing
        record.revoked=true
        const operation=(async()=>{
          const errors=[]
          try{await this.#release(record.clearTimer)}catch(error){errors.push(error)}
          try{await stopNative(record)}catch(error){errors.push(error);try{await cleanTracks(record)}catch(cleanup){errors.push(cleanup)}}
          if(!errors.length)await finalize(record)
          else throw errors[0]
        })()
        record.disposing=operation.finally(()=>{record.disposing=null});record.disposing.catch(()=>{});return record.disposing
      }
      owner.current=record;owner.records.add(record)
      const abort=()=>revoke(record);signal.addEventListener('abort',abort,{once:true})
      record.detachStartAbort=()=>signal.removeEventListener('abort',abort)
      const event=(name,callback)=>{if(record.stopObserved)return;callback?.();record.waiters.get(name)?.resolve();record.waiters.delete(name);if(live(record))emit(record,name[0].toUpperCase()+name.slice(1),{})}
      try {
        record.stream=await env.navigator.mediaDevices.getUserMedia({audio:{...(options.backend==='wav-worklet'?{}:{sampleRate:{exact:options.sampleRate}}),channelCount:{exact:options.channels}}})
        rememberTracks(record)
        // Install exact late-stream releases before checking the old owner's lease.
        if(!live(record)||signal.aborted||env.document?.hidden){record.ready.resolve();record.revoked=true;await this.#release(record.dispose);throw retired()}
        const tracks=record.stream.getTracks();check(tracks.length===1&&tracks[0].kind==='audio','browser did not acquire one microphone track','unsupported')
        const settings=tracks[0].getSettings();check((options.backend==='wav-worklet'||settings.sampleRate===options.sampleRate)&&settings.channelCount===options.channels,'browser microphone settings do not match requested sample rate/channels','unsupported')
        if(options.backend==='wav-worklet'){
          record.recorder=new BrowserWavRecorder(env,record.stream,{sampleRate:options.sampleRate,channels:options.channels,duration:options.duration,maxBytes:MAX_BINARY_BYTES})
          await record.recorder.initialize(signal)
        }else record.recorder=new env.MediaRecorder(record.stream,{mimeType:options.mimeType,audioBitsPerSecond:options.bitrate})
        record.ready.resolve()
        check(!signal.aborted&&live(record),'recorder owner retired during encoder acquisition','cancelled')
        check(options.acceptedMimes.includes(mime(record.recorder.mimeType))&&record.recorder.audioBitsPerSecond===(options.backend==='wav-worklet'?options.sampleRate*options.channels*16:options.bitrate),'browser encoder did not accept the requested format/bitrate','unsupported')
        const started=deferred();record.waiters.set('start',started)
        record.recorder.onstart=()=>event('start',()=>{if(!record.stopRequested){record.segment=now();schedule(record)}})
        record.recorder.onpause=()=>event('pause',()=>{if(!record.stopRequested){record.elapsed=activeTime(record);record.segment=null}clearTimer(record)})
        record.recorder.onresume=()=>event('resume',()=>{if(!record.stopRequested){record.segment=now();schedule(record)}})
        record.recorder.onerror=event=>{if(!record.stopObserved&&live(record)){emit(record,'InterruptionBegin',{});report(record,event.error||new Error('native recording failed'));revoke(record)}}
        record.recorder.ondataavailable=event=>{
          if(!live(record)||record.stopObserved||!event.data?.size)return
          if(!record.acceptedMimes.includes(mime(event.data.type))||event.data.size>MAX_BINARY_BYTES-record.bytes){report(record,new Error('native encoded recording format/size exceeded its bound'));revoke(record);return}
          record.bytes+=event.data.size;record.chunks.push(event.data)
        }
        record.recorder.onstop=()=>{
          if(record.stopObserved)return
          record.elapsed=activeTime(record);record.segment=null;record.stopObserved=true
          for(const pending of record.waiters.values())pending.reject(new Error('native recorder stopped before its requested state event'));record.waiters.clear()
          record.terminal.resolve();this.#track(finalize(record)).catch(error=>report(record,error))
        }
        record.startIssued=true
        try{record.recorder.start()}catch(error){if(record.recorder.state==='inactive'){record.startIssued=false;record.terminal.resolve()}throw error}
        await started.promise
        if(signal.aborted||!live(record))throw retired()
        return ok(context.api)
      } catch(error) {
        record.ready.resolve();record.revoked=true
        try{await this.#release(record.dispose)}catch(cleanup){this.#diagnostic(cleanup)}
        throw error
      }
    })
    for(const action of ['stop','pause','resume'])this.#register(`object:RecorderManager.${action}`,async(payload,{context,signal})=>{
      const [owner]=this.#getObject(payload,'RecorderManager'),record=owner.current;check(record?.recorder,'recorder has not started')
      const previous=record.actionAborts.get(action);if(previous)await this.#release(previous.detach)
      const intent={detach:null},abort=()=>{if(record.actionAborts.get(action)===intent)revoke(record)}
      intent.detach=()=>signal.removeEventListener('abort',abort);record.actionAborts.set(action,intent);signal.addEventListener('abort',abort,{once:true})
      let successful=false
      try {
        if(action==='stop'){await stopNative(record);await finalize(record)}
        else {
          check(live(record)&&record.recorder.state===(action==='pause'?'recording':'paused'),`recorder cannot ${action} in its current state`)
          check(!record.waiters.has(action),`recorder ${action} is already pending`)
          const pending=deferred();record.waiters.set(action,pending)
          try{record.recorder[action]()}catch(error){record.waiters.delete(action);pending.reject(error);throw error}
          await pending.promise
        }
        if(signal.aborted||!current(record))throw retired()
        successful=true
        return ok(context.api)
      } catch(error){if(signal.aborted)revoke(record);throw error}finally{if(!successful)await this.#release(intent.detach)}
    })
    for (const event of ['Start','Stop','Pause','Resume','Error','InterruptionBegin']) this.#eventApis(`object:RecorderManager.on${event}`,undefined,event)
  }
  #installAudio() {
    const env=this.#env
    const properties=owner=>{
      const audio=owner.decoder.audio
      return {src:owner.source,startTime:owner.startTime,autoplay:owner.autoplay,loop:owner.loop,volume:owner.volume,playbackRate:owner.playbackRate,
        currentTime:audio.currentTime,duration:Number.isFinite(audio.duration)?audio.duration:0,paused:audio.paused,
        buffered:audio.buffered?.length?audio.buffered.end(audio.buffered.length-1):0}
    }
    const alive=(owner,decoder)=>!this.#closed&&owner.active&&owner.decoder===decoder&&this.#objects.get(owner.objectId)?.value===owner
    const dispose=decoder=>{
      decoder.active=false;decoder.abort.abort()
      if(decoder.disposing)return decoder.disposing
      const operation=(async()=>{
        const errors=[]
        for(const stage of decoder.cleanup)if(!stage.done)try{await stage.run();stage.done=true}catch(error){errors.push(error)}
        if(errors.length)throw new AggregateError(errors,'audio decoder release failed')
      })()
      decoder.disposing=operation.finally(()=>{decoder.disposing=null});decoder.disposing.catch(error=>this.#diagnostic(error));return decoder.disposing
    }
    const decoder=owner=>{
      const audio=new env.Audio();audio.preload='metadata';audio.autoplay=owner.autoplay;audio.loop=owner.loop;audio.volume=owner.volume;audio.playbackRate=owner.playbackRate
      const value={audio,active:true,abort:new AbortController(),url:null,releaseUrl:null,urlReleased:false,cleanup:[],playIntent:null}
      const add=run=>value.cleanup.push({run,done:false})
      // A decoder owns one source incarnation. Replacing src replaces the real
      // element too, so queued browser events cannot be mistaken for new media.
      add(()=>audio.pause());add(()=>audio.removeAttribute('src'));add(()=>audio.load())
      add(()=>{value.playIntent?.detach();value.playIntent=null})
      for(const [browserEvent,event] of [['play','Play'],['pause','Pause'],['ended','Ended'],['error','Error'],['canplay','Canplay'],['timeupdate','TimeUpdate'],['waiting','Waiting'],['seeking','Seeking'],['seeked','Seeked']]) {
        const listener=()=>{
          const isCurrent=()=>value.active&&alive(owner,value)
          if(!isCurrent())return
          const data=browserEvent==='error'?{errCode:audio.error?.code,errMsg:audio.error?.message,properties:properties(owner)}:{currentTime:audio.currentTime,duration:Number.isFinite(audio.duration)?audio.duration:0,properties:properties(owner)}
          if(!this.#emit(event,data,owner.objectId,{coalesce:browserEvent==='timeupdate',isCurrent}))void this.#release(value.dispose).catch(error=>this.#diagnostic(error))
        }
        audio.addEventListener(browserEvent,listener);add(()=>audio.removeEventListener(browserEvent,listener))
      }
      const metadata=()=>{if(value.active&&alive(owner,value)&&owner.startTime)audio.currentTime=owner.startTime}
      audio.addEventListener('loadedmetadata',metadata);add(()=>audio.removeEventListener('loadedmetadata',metadata))
      add(()=>value.releaseUrl?.());value.dispose=()=>dispose(value)
      return value
    }
    const source=async(owner,path,signal,context)=>{
      check(typeof path==='string','audio source must be a string')
      const packaged=path&&!path.startsWith('wxfile://')&&!/^https?:\/\//i.test(path)
      if(packaged)check(typeof this.#runtime.host_api_resource==='function'&&parse(this.#runtime.host_services_protocol_json()).packagedApiResources==='1.0','packaged audio requires an installed verified-resource transport','unsupported')
      const previous=owner.decoder,current=decoder(owner),preceding=owner.sourceOperation
      let finished;const terminal=new Promise(resolve=>{finished=resolve});owner.sourceOperation=terminal
      owner.decoder=current;owner.source=path
      const retiring=this.#release(previous.dispose);Promise.resolve(retiring).catch(error=>this.#diagnostic(error))
      const cancel=()=>{try{void Promise.resolve(this.#release(current.dispose)).catch(error=>this.#diagnostic(error))}catch(error){this.#diagnostic(error)}};signal.addEventListener('abort',cancel,{once:true})
      current.cleanup.push({run:()=>signal.removeEventListener('abort',cancel),done:false})
      try {
        if(preceding)await preceding
        await retiring
        check(!signal.aborted&&alive(owner,current),'audio source superseded','cancelled')
        if(path.startsWith('wxfile://')) {
          current.url=await this.files.objectUrl(path)
          current.releaseUrl=()=>{if(!current.urlReleased){this.files.releaseUrl(current.url);current.urlReleased=true}}
        } else if(packaged) {
          const bytes=await this.#runtime.host_api_resource(JSON.stringify(context))
          check(bytes instanceof Uint8Array&&bytes.byteLength<=HOST_API_RESOURCE_MAX_BYTES,'packaged audio exceeds verified decoder limit')
          current.url=URL.createObjectURL(new Blob([bytes]))
          current.releaseUrl=()=>{if(!current.urlReleased){URL.revokeObjectURL(current.url);current.urlReleased=true}}
        } else if(path) {
          const response=await env.fetch(this.#url(path),{credentials:'omit',redirect:'error',mode:'cors',signal:current.abort.signal})
          check(response.ok,'audio resource request failed')
          check(Number(response.headers.get('content-length')||0)<=MAX_BINARY_BYTES,'audio resource exceeds decoder limit')
          const reader=response.body?.getReader();check(reader,'bounded audio streaming reader is unavailable','unsupported')
          const chunks=[];let bytes=0
          try {for(;;){const result=await reader.read();if(result.done)break;bytes+=result.value.byteLength;check(bytes<=MAX_BINARY_BYTES,'audio resource exceeds decoder limit');chunks.push(result.value)}}
          catch(error){await reader.cancel();throw error}finally{reader.releaseLock()}
          current.url=URL.createObjectURL(new Blob(chunks,{type:response.headers.get('content-type')||'application/octet-stream'}))
          current.releaseUrl=()=>{if(!current.urlReleased){URL.revokeObjectURL(current.url);current.urlReleased=true}}
        }
        check(!signal.aborted&&current.active&&alive(owner,current),'audio source superseded','cancelled')
        if(current.url)current.audio.src=current.url
        else {current.audio.removeAttribute('src');current.audio.load()}
        return current
      } catch(error) {
        // Source acquisition can finish after an earlier disposer had no URL
        // yet. Register that exact late handle even when its decoder is gone.
        const errors=[error]
        // Invalidate native listeners/playback even if exact late URL release
        // fails. Both stable release handles remain available to close retry.
        try{await this.#release(current.dispose)}catch(cleanup){errors.push(cleanup)}
        if(current.releaseUrl)try{await this.#release(current.releaseUrl)}catch(cleanup){errors.push(cleanup)}
        if(errors.length>1)throw new AggregateError(errors,'audio acquisition and cleanup failed')
        throw error
      }
      finally{finished();if(owner.sourceOperation===terminal)owner.sourceOperation=null}
    }
    this.#register('wx.createInnerAudioContext',(payload,{context})=>{
      check([...this.#objects.values()].filter(value=>value.type==='InnerAudioContext').length<8,'audio context limit exceeded')
      const owner={objectId:null,active:true,source:'',startTime:0,autoplay:false,loop:false,volume:1,playbackRate:1,decoder:null,sourceOperation:null}
      owner.decoder=decoder(owner)
      owner.objectId=this.#object('InnerAudioContext',owner,()=>{owner.active=false;return dispose(owner.decoder)},payload.objectId)
      return ok(context.api,{objectId:owner.objectId,properties:properties(owner)})
    })
    for(const member of ['src','startTime','autoplay','loop','volume','playbackRate','currentTime','duration','paused','buffered'])this.#register(`object:InnerAudioContext.${member}`,async(payload,{context,signal})=>{
      const [owner]=this.#getObject(payload,'InnerAudioContext')
      if(payload.action==='set') {
        check(!['currentTime','duration','paused','buffered'].includes(member),`${member} is read-only`)
        if(member==='src') {
          const operation=source(owner,payload.value,signal,context),target=owner.decoder
          try{await operation}catch(error){
            const isCurrent=()=>alive(owner,target)&&!signal.aborted
            if(error?.code!=='cancelled'&&isCurrent())this.#emit('Error',{errMsg:error.errMsg||error.message,...(error.errCode===undefined?{}:{errCode:error.errCode}),properties:properties(owner)},owner.objectId,{coalesce:false,isCurrent})
            throw error
          }
        }
        else if(member==='startTime'){check(Number.isFinite(payload.value)&&payload.value>=0,'startTime must be nonnegative');owner.startTime=payload.value}
        else {
          check(owner.decoder.active&&alive(owner,owner.decoder),'audio decoder retired','cancelled')
          if(member==='volume')check(Number.isFinite(payload.value)&&payload.value>=0&&payload.value<=1,'volume must be in 0..1')
          else if(member==='playbackRate')check(Number.isFinite(payload.value)&&payload.value>=.5&&payload.value<=2,'playbackRate must be in 0.5..2')
          else check(typeof payload.value==='boolean',`${member} must be boolean`)
          owner.decoder.audio[member]=payload.value;owner[member]=owner.decoder.audio[member]
        }
      }
      return ok(context.api,{properties:properties(owner)})
    })
    for(const action of ['play','pause','stop','seek','destroy'])this.#register(`object:InnerAudioContext.${action}`,async(payload,{context,signal})=>{
      const [owner,objectId]=this.#getObject(payload,'InnerAudioContext'),current=owner.decoder,audio=current.audio
      check(payload.src===undefined,'set the audio src property before playback')
      if(action==='destroy'){await this.#destroyObject(objectId);return ok(context.api)}
      check(current.active&&alive(owner,current),'audio decoder retired','cancelled')
      if(action==='play') {
        current.playIntent?.detach()
        const intent={detach:()=>signal.removeEventListener('abort',cancel)}
        const cancel=()=>{if(current.playIntent===intent)try{void Promise.resolve(this.#release(current.dispose)).catch(error=>this.#diagnostic(error))}catch(error){this.#diagnostic(error)}}
        current.playIntent=intent;signal.addEventListener('abort',cancel,{once:true})
        await audio.play()
      }
      else if(action==='pause')audio.pause()
      else if(action==='stop'){audio.pause();audio.currentTime=0;this.#emit('Stop',{},objectId,{coalesce:false,isCurrent:()=>current.active&&alive(owner,current)})}
      else {const position=payload.position??payload.args?.[0];check(Number.isFinite(position)&&position>=0,'seek position must be nonnegative');audio.currentTime=position}
      check(!signal.aborted&&current.active&&alive(owner,current),'audio owner retired or source replaced','cancelled')
      return ok(context.api,{properties:properties(owner)})
    })
    for(const event of ['Play','Pause','Stop','Ended','Error','Canplay','TimeUpdate','Waiting','Seeking','Seeked'])this.#eventApis(`object:InnerAudioContext.on${event}`,`object:InnerAudioContext.off${event}`,event)
  }
  #installCamera() {
    const env = this.#env
    this.#register('wx.createCameraContext', (payload, { context }) => {
      const component = this.#mediaTarget('camera', payload.cameraId || payload.id, context)
      check(component?.type === 'camera' && component.stream, 'camera context requires a bound in-container camera component')
      const objectId = this.#object('CameraContext', component, () => {}, payload.objectId); return ok(context.api, { objectId })
    })
    this.#register('object:CameraContext.takePhoto', async (payload, { context }) => {
      const [component] = this.#getObject(payload, 'CameraContext'), video = component.element
      this.#assertMediaTarget(component,context)
      const canvas = env.document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight
      check(canvas.width > 0 && canvas.height > 0, 'camera has no frame')
      canvas.getContext('2d').drawImage(video, 0, 0); const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', payload.quality === 'low' ? .5 : payload.quality === 'normal' ? .8 : .95))
      check(blob, 'camera image encoding failed'); return ok(context.api, { tempImagePath: await this.files.temporary(blob, 'jpg'), width: canvas.width, height: canvas.height })
    })
    this.#register('object:CameraContext.setZoom', async (payload, { context }) => { const [component] = this.#getObject(payload, 'CameraContext'); this.#assertMediaTarget(component,context); const track = component.stream.getVideoTracks()[0]; check(track.getCapabilities?.().zoom, 'camera zoom is unavailable', 'unsupported'); await track.applyConstraints({ advanced: [{ zoom: payload.zoom }] }); return ok(context.api, { zoom: track.getSettings().zoom }) })
    if (env.BarcodeDetector) this.#register('wx.scanCode', async (payload, { context }) => {
      const component = [...this.#components.values()].find(c => c.type === 'camera' && c.stream); check(component, 'scanCode requires a visible in-container camera component')
      const formats = await env.BarcodeDetector.getSupportedFormats(), detector = new env.BarcodeDetector({ formats })
      const codes = await detector.detect(component.element); check(codes.length, 'no barcode detected')
      return ok(context.api, { result: codes[0].rawValue, scanType: codes[0].format, charSet: 'UTF-8', rawData: codes[0].rawValue })
    })
  }
  #installVideo() {
    this.#register('wx.createVideoContext', (payload, { context }) => {
      const key = payload.id || payload.videoId || payload.args?.[0]
      const component = this.#mediaTarget('video', key, context)
      check(component?.type === 'video', 'video context requires a currently bound in-container video')
      return ok(context.api, { objectId: this.#object('VideoContext', component, () => {}, payload.objectId) })
    })
    for (const action of ['play','pause','stop','seek','requestFullScreen','exitFullScreen','playbackRate']) this.#register(`object:VideoContext.${action}`, async (payload, { context }) => {
      const [component] = this.#getObject(payload, 'VideoContext'), video = component.element
      this.#assertMediaTarget(component, context)
      if (action === 'play') await video.play()
      else if (action === 'pause') video.pause()
      else if (action === 'stop') { video.pause(); video.currentTime = 0 }
      else if (action === 'seek') video.currentTime = payload.position ?? payload.args?.[0] ?? 0
      else if (action === 'playbackRate') { const rate = payload.rate ?? payload.args?.[0]; check(Number.isFinite(rate) && rate > 0, 'playback rate must be positive'); video.playbackRate = rate }
      else if (action === 'requestFullScreen') { check(component.domOwned, 'fullscreen video requires the DOM renderer', 'unsupported'); check(video.requestFullscreen, 'fullscreen is unavailable', 'unsupported'); await video.requestFullscreen() }
      else { check(video.ownerDocument.exitFullscreen, 'fullscreen is unavailable', 'unsupported'); await video.ownerDocument.exitFullscreen() }
      return ok(context.api)
    })
  }
  #mediaTarget(type, publicId, context) {
    const target = context.componentTarget
    const component = target ? this.#components.get(target.nodeId)
      : [...this.#components.values()].find(value => value.domOwned && value.type === type && (!publicId || value.nodeId === publicId || value.publicId === publicId))
    check(component?.type === type, 'media context requires a current accepted component', 'cancelled')
    this.#assertMediaTarget(component, context); return component
  }
  #assertMediaTarget(component, context) {
    check(this.#components.get(component.nodeId) === component && (!component.isAlive || component.isAlive()), 'media component was retired', 'cancelled')
    if (!component.domOwned) {
      const target = context.componentTarget
      check(target && target.nodeId === component.nodeId && String(target.pageId) === String(component.binding.pageId)
        && (target.ownerScopeId ?? null) === (component.binding.ownerScopeId ?? null), 'media context target does not match presented ownership', 'cancelled')
    }
  }
  async #refreshFrameComponents() {
    const snapshots = parse(await this.#runtime.host_component_snapshots_json())
    check(Array.isArray(snapshots) && snapshots.length <= 256, 'invalid accepted media component batch')
    const live = new Set()
    for (const snapshot of snapshots) {
      if (!['camera','video'].includes(snapshot.tag) || snapshot.accountEpoch !== String(this.#config.account.epoch) || !snapshot.visible) continue
      const bounds = snapshot.localBounds, a = snapshot.attributes || {}, nodeId = snapshot.nodeId
      if (!(bounds?.width > 0 && bounds?.height > 0)) continue
      live.add(nodeId)
      const signature = JSON.stringify([snapshot.sessionId,snapshot.pageId,snapshot.tag,a])
      if (this.#frameFailures.get(nodeId) === signature) continue
      this.#frameFailures.delete(nodeId)
      const prior = this.#components.get(nodeId)
      if (prior && (!prior.frameOwned || prior.sessionId !== snapshot.sessionId || prior.binding.pageId !== snapshot.pageId || snapshot.tag === 'camera' && prior.binding.devicePosition !== a['device-position'] || snapshot.tag === 'video' && prior.binding.src !== a.src)) this.unbindComponent(nodeId)
      const truth = key => a[key] !== undefined && a[key] !== 'false'
      const binding = {...snapshot,signature,id:nodeId,type:snapshot.tag,publicId:a.id,rect:bounds,frameOwned:true,
        src:a.src,devicePosition:a['device-position'],objectFit:a['object-fit'],initialTime:Number(a['initial-time']) || 0,
        autoplay:truth('autoplay'),loop:truth('loop'),muted:truth('muted'),controls:truth('controls'),visible:true}
      binding.isAlive = () => !this.#closed && this.#components.get(nodeId)?.binding.sessionId === snapshot.sessionId
        && this.#components.get(nodeId)?.binding.pageId === snapshot.pageId
      binding.isCurrent = binding.isAlive
      if (!prior && this.#components.size >= 16) { this.#diagnostic(new Error('native media decoder limit exceeded')); continue }
      void this.bindComponent(binding).catch(error => { if (!this.#closed) { const current=this.#components.get(nodeId);if(current?.binding.signature===signature)this.unbindComponent(nodeId,current);this.#frameFailures.set(nodeId,signature);this.#diagnostic(error) } })
    }
    for (const [nodeId,component] of this.#components) if (component.frameOwned && !live.has(nodeId)) this.unbindComponent(nodeId)
    for (const nodeId of this.#frameFailures.keys()) if (!live.has(nodeId)) this.#frameFailures.delete(nodeId)
  }
  #mediaAlive(component) { return !this.#closed && this.#components.get(component.nodeId) === component && (!component.isAlive || component.isAlive()) }
  async #mediaSource(component, binding, source) {
    if (binding.resolvedSrc) { check(binding.resolvedSrc.startsWith('blob:'), 'DOM media must use a verified content-addressed resource'); return binding.resolvedSrc }
    if (source.startsWith('wxfile://')) return this.files.objectUrl(source)
    if (component.frameOwned && !/^[a-z][a-z0-9+.-]*:/i.test(source) && !source.startsWith('//')) {
      check(typeof this.#runtime.host_component_resource === 'function', 'runtime cannot authorize packaged native media', 'unsupported')
      const bytes = await this.#runtime.host_component_resource(JSON.stringify({sessionId:binding.sessionId,accountEpoch:String(this.#config.account.epoch),pageId:binding.pageId,nodeId:component.nodeId}))
      if (bytes == null) return null
      check(bytes instanceof Uint8Array && bytes.byteLength <= 16*1024*1024, 'packaged media resource exceeds decoder limit')
      if (!this.#mediaAlive(component) || (component.binding.resolvedSrc || component.binding.src) !== source) return null
      const url = URL.createObjectURL(new Blob([bytes])); if(component.ownedSourceUrl)URL.revokeObjectURL(component.ownedSourceUrl);component.ownedSourceUrl = url;return url
    }
    // Fetch explicitly without host cookies or bearer credentials. A detached
    // <video src=https:> would otherwise inherit browser cookies implicitly.
    const url = this.#url(source);check(/^https?:/.test(url),'video source requires HTTP(S)')
    const controller = new AbortController();component.sourceAbort?.abort();component.sourceAbort = controller
    const response = await this.#env.fetch(url,{credentials:'omit',redirect:'error',mode:'cors',signal:controller.signal})
    check(response.ok,'video resource request failed')
    check(Number(response.headers.get('content-length') || 0) <= 16*1024*1024,'video resource exceeds decoder limit')
    const reader = response.body?.getReader(); check(reader,'bounded media streaming reader is unavailable','unsupported')
    const chunks=[];let length=0
    try {
      while(true){const result=await reader.read();if(result.done)break;length+=result.value.byteLength;check(length<=16*1024*1024,'video resource exceeds decoder limit');chunks.push(result.value)}
    } catch(error){await reader.cancel();throw error} finally{reader.releaseLock()}
    if (!this.#mediaAlive(component) || (component.binding.resolvedSrc || component.binding.src) !== source) return null
    const objectUrl=URL.createObjectURL(new Blob(chunks,{type:response.headers.get('content-type') || 'application/octet-stream'}))
    if(component.ownedSourceUrl)URL.revokeObjectURL(component.ownedSourceUrl);component.ownedSourceUrl=objectUrl;return objectUrl
  }
  #scheduleComponentFrame(component) {
    if (this.#closed || !component.frameOwned || !this.#mediaAlive(component) || component.captureScheduled) return
    const video = component.element
    const capture = () => {
      component.captureScheduled = null
      if (!this.#mediaAlive(component)) return
      try {
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !this.#frameSlots.has(component.nodeId)) {
          const scale = Math.min(1, 512 / Math.max(video.videoWidth,video.videoHeight))
          const width = Math.max(1,Math.floor(video.videoWidth * scale)), height = Math.max(1,Math.floor(video.videoHeight * scale))
          const canvas = component.captureCanvas ||= this.#env.OffscreenCanvas ? new this.#env.OffscreenCanvas(width,height) : this.#env.document.createElement('canvas')
          canvas.width = width; canvas.height = height
          const ctx = canvas.getContext('2d',{willReadFrequently:true}); check(ctx, 'RGBA frame extraction is unavailable', 'unsupported')
          ctx.drawImage(video,0,0,width,height)
          const pixels = new Uint8Array(ctx.getImageData(0,0,width,height).data.buffer)
          check(pixels.byteLength <= 1024*1024, 'component RGBA frame exceeds limit')
          if (this.#frameBytes + pixels.byteLength <= 16*1024*1024) {
            const binding = component.binding, key = `${binding.sessionId}:${binding.pageId}:${component.nodeId}`
            const sequence = (this.#frameSequence.get(key) || 0n) + 1n; this.#frameSequence.set(key,sequence)
            this.#frameSlots.set(component.nodeId,{component,pixels,metadata:{sessionId:binding.sessionId,accountEpoch:String(this.#config.account.epoch),pageId:binding.pageId,nodeId:component.nodeId,sequence:String(sequence),width,height,format:'rgba8'}})
            this.#frameBytes += pixels.byteLength; this.onQueueReady()
          }
        }
      } catch (error) { this.#componentEvent(component,'error',{errMsg:error.message}); this.#diagnostic(error); this.unbindComponent(component.nodeId,component); return }
      this.#scheduleComponentFrame(component)
    }
    if (video.requestVideoFrameCallback) component.captureScheduled = {kind:'video',id:video.requestVideoFrameCallback(capture)}
    else component.captureScheduled = {kind:'timer',id:this.#env.setTimeout(capture,33)}
  }
  #componentEvent(component, event, value) {
    if (this.#closed || this.#components.get(component.nodeId) !== component || component.isCurrent && !component.isCurrent()) return
    const sequence = (this.#componentSequence.get(component.nodeId) || 0) + 1; this.#componentSequence.set(component.nodeId,sequence)
    this.#enqueue({ type:'component',data:{sessionId:component.sessionId,accountEpoch:String(this.#config.account.epoch),nodeId:component.nodeId,event,sequence:String(sequence),value} }, { component, coalesceKey: event === 'timeupdate' || event === 'progress' ? `component:${component.nodeId}:${event}` : undefined })
  }
  /** Track only accepted visible DOM publications. Native elements are children
   * of their actual WXML nodes, so browser layout provides clipping, transforms,
   * stacking and input with the surrounding document. Removed frames stop media
   * synchronously through the presenter's native disposer before resource release.
   */
  observeDomSurface({ root = this.componentRoot, sessionId, isInputEnabled = () => true } = {}) {
    const MutationObserver = root?.ownerDocument?.defaultView?.MutationObserver || this.#env.MutationObserver
    check(root?.querySelectorAll && MutationObserver && sessionId, 'DOM component binding requires a real container surface and session')
    this.#domObserver?.disconnect()
    const scan = () => {
      if (this.#closed) return
      const live = new Set()
      for (const frame of root.querySelectorAll('iframe')) {
        if (frame.style.visibility === 'hidden' || !frame.isConnected || frame.getAttribute('data-weapp-native-accepted') !== 'true') continue
        const document = frame.contentDocument
        for (const mount of document?.querySelectorAll('[data-wc-native-component]') || []) {
          const descriptor = JSON.parse(mount.getAttribute('data-wc-native-component'))
          const nodeId = descriptor.nodeId, rect = mount.getBoundingClientRect(), style = document.defaultView.getComputedStyle(mount)
          if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) continue
          if (frame.inert && !this.#components.has(nodeId)) continue
          live.add(nodeId)
          const isAlive = () => frame.isConnected && frame.style.visibility !== 'hidden' && mount.isConnected && !this.#closed
          const isCurrent = () => isAlive() && !frame.inert && isInputEnabled()
          void this.bindComponent({ ...descriptor,id:nodeId,sessionId,accountEpoch:String(this.#config.account.epoch),rect:{x:0,y:0,width:rect.width,height:rect.height},mount,isCurrent,isAlive,visible:true })
            .catch(error => { if (isCurrent()) this.#diagnostic(error) })
        }
      }
      for (const [nodeId,component] of this.#components) if (component.domOwned && !live.has(nodeId)) this.unbindComponent(nodeId)
    }
    this.#domScan = scan
    this.#domObserver = new MutationObserver(mutations => {
      if (mutations.some(mutation => mutation.type === 'childList' || mutation.target?.tagName === 'IFRAME')) scan()
    })
    this.#domObserver.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['style','inert']})
    root.addEventListener('weapp-native-surface',scan); this.#cleanup.add(() => root.removeEventListener('weapp-native-surface',scan))
    scan(); return () => { this.#domObserver?.disconnect(); this.#domScan = null }
  }
  /** The renderer must pass an accepted geometry token for each native node.
   * The element is mounted inside the supplied container surface, with clipping
   * and visibility updated by every accepted render; no detached demo window.
   */
  bindComponent(binding) { return this.#track(this.#bindComponent(binding)) }
  async #bindComponent(binding) {
    check(!this.#closed && this.componentRoot && binding.sessionId && String(binding.accountEpoch) === String(this.#config.account.epoch), 'component scope is stale', 'cancelled')
    check((binding.mount || binding.frameOwned && this.#frameProtocol) && ['camera','video'].includes(binding.type) && binding.id && ['x','y','width','height'].every(k => Number.isFinite(binding.rect?.[k])), 'invalid native component binding')
    let component = this.#components.get(binding.id)
    if (!component) {
      const element = this.#env.document.createElement('video'); element.playsInline = true; element.muted = binding.type === 'camera'; element.dataset.weappComponent = binding.id
      component = { type: binding.type,nodeId:binding.id,publicId:binding.publicId,element,stream:null,sessionId:binding.sessionId,domOwned:Boolean(binding.mount),frameOwned:binding.frameOwned === true,isCurrent:binding.isCurrent,isAlive:binding.isAlive || (()=>!this.#closed && this.#components.get(binding.id)===component),binding };
      this.#components.set(binding.id, component); if (binding.mount) binding.mount.append(element)
      element.dataset.weappNativeMedia = ''; element.__weappNativeDispose = () => this.unbindComponent(binding.id,component)
      if (binding.type === 'video') for (const event of ['play','pause','ended','timeupdate','waiting','error','loadedmetadata','progress']) element.addEventListener(event, () => this.#componentEvent(component,event,
        event === 'error' ? {errMsg:element.error?.message || 'video playback failed'} : event === 'timeupdate' ? {currentTime:element.currentTime,duration:Number.isFinite(element.duration)?element.duration:0} : event === 'loadedmetadata' ? {width:element.videoWidth,height:element.videoHeight,duration:Number.isFinite(element.duration)?element.duration:0} : event === 'progress' ? {buffered:element.buffered.length?element.buffered.end(element.buffered.length-1):0} : {}))
      if (binding.type === 'camera') {
        try {
          component.stream = await this.#env.navigator.mediaDevices.getUserMedia({ video: { facingMode: binding.devicePosition === 'front' ? 'user' : 'environment' }, audio: false })
          check(!this.#closed && this.#components.get(binding.id) === component && (!component.isAlive || component.isAlive()), 'camera binding was retired while requesting permission', 'cancelled')
          component.element.srcObject = component.stream; await component.element.play()
          this.#componentEvent(component,'initdone',{maxZoom:component.stream.getVideoTracks()[0]?.getCapabilities?.().zoom?.max || 1})
        }
        catch (error) {
          this.#componentEvent(component,'error',{errMsg:error.message})
          if(this.#components.get(binding.id)===component)this.unbindComponent(binding.id,component)
          else for(const track of component.stream?.getTracks()||[]) {try{this.#release(()=>track.stop())}catch(cleanupError){this.#diagnostic(cleanupError)}}
          throw error
        }
      }
    } else component.binding = binding
    check(component.sessionId === binding.sessionId, 'component belongs to retired session', 'cancelled')
    if(component.binding !== binding)return component.element
    if (binding.mount && component.element.parentNode !== binding.mount) binding.mount.append(component.element)
    component.isCurrent = binding.isCurrent; component.isAlive = binding.isAlive || component.isAlive; component.publicId = binding.publicId
    if (binding.mount) Object.assign(component.element.style,{display:'block',position:'relative',width:'100%',height:'100%',objectFit:binding.objectFit || 'contain'})
    if (binding.type === 'video') {
      const source = binding.resolvedSrc || binding.src
      if (source && component.source !== source) {
        if (!component.pendingSource || component.pendingSource.source !== source) {
          const promise = this.#mediaSource(component,binding,source); component.pendingSource = {source,promise}
        }
        const pending = component.pendingSource, resolved = await pending.promise
        if (component.pendingSource === pending) component.pendingSource = null
        if (!resolved || !this.#mediaAlive(component) || (component.binding.resolvedSrc || component.binding.src) !== source || component.source === source) return component.element
        component.element.src = resolved; component.source = source; component.autoplayStarted = false
        if (binding.initialTime) component.element.currentTime = binding.initialTime
      }
      component.element.controls = binding.controls !== false; component.element.muted = binding.muted === true; component.element.loop = binding.loop === true
      if (binding.autoplay && !component.autoplayStarted) { await component.element.play(); component.autoplayStarted = true }
      else if (!binding.autoplay) component.autoplayStarted = false
    }
    if (component.frameOwned) this.#scheduleComponentFrame(component)
    if (binding.visible === false) { component.element.pause(); if (component.type === 'camera') this.unbindComponent(binding.id) }
    return component.element
  }
  unbindComponent(componentId, expected) {
    const component = this.#components.get(componentId)
    if (!component || expected && component !== expected) return
    this.#components.delete(componentId)
    const errors=[],clean=operation=>{try{this.#release(operation)}catch(error){errors.push(error)}}
    if (component.captureScheduled?.kind === 'video') clean(()=>component.element.cancelVideoFrameCallback?.(component.captureScheduled.id))
    else if (component.captureScheduled) clean(()=>this.#env.clearTimeout(component.captureScheduled.id))
    component.captureScheduled = null
    const frame = this.#frameSlots.get(componentId)
    if(frame){this.#frameBytes -= frame.pixels.byteLength;this.#frameSlots.delete(componentId)}
    component.captureCanvas = null; clean(()=>component.sourceAbort?.abort()); clean(()=>component.element.pause())
    for (const track of component.stream?.getTracks() || []) clean(()=>track.stop())
    clean(()=>{component.element.srcObject=null})
    // Stop the decoder's pending resource selection before revoking our URL.
    // Removing a detached video alone does not cancel a queued Blob fetch.
    clean(()=>component.element.removeAttribute?.('src')); clean(()=>component.element.load?.())
    clean(()=>component.element.remove())
    if (component.ownedSourceUrl) clean(()=>URL.revokeObjectURL(component.ownedSourceUrl))
    for (const [objectId, object] of this.#objects) if (object.value === component) clean(()=>this.#destroyObject(objectId))
    for (const error of errors) this.#diagnostic(error)
  }
  #stopLocationWatch() {
    const watch=this.#watch;if(!watch)return;watch.active=false
    this.#release(watch.stop);if(this.#watch===watch)this.#watch=null
  }
  #stopSensor(api) {
    this.#sensorIntents.delete(api)
    const source=this.#sensorStops.get(api);if(!source)return;source.active=false
    this.#release(source.stop)
  }
  #releaseWakeLock() {if(this.#wakeLockRelease)return this.#release(this.#wakeLockRelease)}
  #stopBackgroundResources() {
    this.#resourceEpoch++;this.#sensorIntents.clear()
    const errors=[],clean=action=>{try{action()}catch(error){errors.push(error)}}
    clean(()=>this.#stopLocationWatch())
    for(const cancel of this.#oneShotLocations)clean(cancel)
    for (const api of this.#sensorStops.keys()) clean(()=>this.#stopSensor(api))
    for (const [objectId, object] of this.#objects) if (['RecorderManager','InnerAudioContext'].includes(object.type)) clean(()=>this.#destroyObject(objectId))
    for (const componentId of [...this.#components.keys()]) clean(()=>this.unbindComponent(componentId))
    clean(()=>this.#releaseWakeLock())
    if(this.#bluetoothOwner)clean(()=>this.#release(this.#bluetoothOwner.suspend))
    if(errors.length)throw new AggregateError(errors,'native browser background resources failed to stop')
  }
  close() {
    if (this.#closeResult) return this.#closeResult
    this.#closed = true
    this.#configureAbort?.abort()
    const cleanup=operation=>{try{operation()}catch(error){this.#diagnostic(error)}}
    // A rejected release keeps its exact handle/action. Only a subsequent
    // explicit close retries it; an in-flight close shares one barrier.
    for(const release of this.#releases)if(release.error&&!release.pending) {try{this.#attemptRelease(release)}catch(error){this.#diagnostic(error)}}
    if(!this.#closeStarted) {
      this.#closeStarted=true
      cleanup(()=>this.#release(()=>this.#domObserver?.disconnect())); this.#domScan = null
      for (const call of this.#calls.values()) cleanup(()=>call.abort()); this.#calls.clear()
      this.#retainedCalls.clear(); this.#objectReady.clear();this.#completedCalls.clear();this.#requestBacklog.clear();this.#subscriptions.clear(); this.#queue = []; this.#queueBytes = 0;this.#completionIds.clear();this.#completionBytes=0
      this.#frameFailures.clear(); this.#frameSequence.clear()
      cleanup(()=>this.#stopBackgroundResources())
      for (const objectId of [...this.#objects.keys()]) cleanup(()=>this.#destroyObject(objectId))
      for (const dispose of this.#cleanup) cleanup(()=>this.#release(dispose)); this.#cleanup.clear()
      // No guest lifecycle hooks or fail callbacks are executed after revocation.
      cleanup(()=>this.#release(()=>this.#runtime.revoke_host_services_json()))
    }
    const closing=(async()=>{
      // Permission/UI callbacks can acquire a real device after revocation.
      // Their continuation must register and finish its release before the
      // new account can acquire files or resources from this owner.
      while(this.#executions.size)await Promise.all([...this.#executions])
      const waitReleases=async()=>{
        while([...this.#releases].some(release=>release.pending))await Promise.allSettled([...this.#releases].map(release=>release.pending).filter(Boolean))
        const errors=[...this.#releases].map(release=>release.error).filter(Boolean)
        if(errors.length)throw new AggregateError(errors,'native browser owner close failed; retry retained releases')
      }
      // Resource disposers can still remove revoked recordings from this scope.
      // Keep files/binaries usable until every exact cleanup handle has drained.
      await waitReleases()
      if(!this.#privateStoresClosing) {
        this.#privateStoresClosing=true
        cleanup(()=>this.#release(()=>this.binary?.close()));cleanup(()=>this.#release(()=>this.files?.close()))
      }
      await waitReleases()
    })()
    this.#closeResult=closing.catch(error=>{this.#closeResult=null;throw error})
    return this.#closeResult
  }
}
