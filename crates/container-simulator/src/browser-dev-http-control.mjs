/** Browser dev control transport. Does not bootstrap a preview, grant authority,
 * run a Worker, auto-ACK delivery or queue work. Explicit negotiated retirement
 * releases only acknowledged prefixes after the original actual jobs settle.
 * Bounds below are logical retained-byte/admission limits, not browser RSS. */
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true })
const REQUEST_LIMIT = 64 * 1024, FINAL_LIMIT = 256 * 1024, ACK_LIMIT = 4096, RETIREMENT_LIMIT = 4096
const cleanup = new Set(['cancelActivation', 'finishClose', 'abandonStart', 'failOwner', 'retryClose', 'stop'])
const commands = new Set(['snapshot', 'issueActivation', 'cancelActivation', 'beginActivation', 'finishClose', 'abandonStart', 'startOwner', 'failOwner', 'runtimeReady', 'presentedReady', 'retryClose', 'stop'])
const identifier = (value, limit) => typeof value === 'string' && value.length <= limit && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fault = (code, message) => Object.assign(new Error(message), { code })
const need = (value, message) => { if (!value) throw fault('ERR_PROTOCOL_VERSION', message) }
const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])
const sha256Default = async bytes => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
const expectedAbort = (error, signal) => signal.aborted && (error === signal.reason || error?.name === 'AbortError')
const frozenJson = value => {
  const pending = [value]
  while (pending.length) {
    const next = pending.pop()
    if (next && typeof next === 'object') { for (const child of Object.values(next)) pending.push(child); Object.freeze(next) }
  }
  return value
}

async function boundedBody(response, limit, signal) {
  const length = response.headers.get('content-length')
  need(length === null || /^(0|[1-9][0-9]*)$/.test(length) && Number(length) <= limit, 'response length exceeds its bound')
  need(response.body && typeof response.body.getReader === 'function', 'streaming response body is required')
  const reader = response.body.getReader(), buffer = new Uint8Array(limit)
  let used = 0, completed = false
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      need(part.value instanceof Uint8Array && part.value.length <= limit - used, 'response body exceeds its bound')
      buffer.set(part.value, used); used += part.value.length
    }
    need(length === null || Number(length) === used, 'response length differs from body')
    completed = true; return buffer.slice(0, used)
  } finally {
    try { if (!completed) await reader.cancel() }
    catch (error) { if (!expectedAbort(error, signal)) throw Object.assign(new AggregateError([error], 'control response reader cleanup failed'), { code: 'ERR_CLEANUP' }) }
    finally {
      try { reader.releaseLock() }
      catch (error) { throw Object.assign(new AggregateError([error], 'control response reader release failed'), { code: 'ERR_CLEANUP' }) }
    }
  }
}

export class BrowserDevHttpControl {
  #origin; #run; #client; #secret; #fetch; #sha; #entries = new Map(); #objects = new WeakMap()
  #limits; #lanes = Object.fromEntries(['normal', 'cleanup', 'recovery', 'acknowledgement'].map(name => [name, { requests: 0, retained: 0, reserved: 0, active: 0 }]))
  #jobs = new Set(); #controllers = new Set(); #closing = null; #closeResult = null; #cleanupFailures = 0
  #capabilities; #highest = { normal: 0n, cleanup: 0n }
  #retirements = Object.fromEntries(['normal', 'cleanup'].map(name => [name, { throughSerial: '0', pending: null, lastReceipt: null, receiptCharge: 0 }]))
  constructor({ baseUrl, runId, clientId, secret, fetch: fetcher = globalThis.fetch?.bind(globalThis), sha256 = sha256Default,
    maxRequests = 512, maxRetainedBytes = 16 * 1024 * 1024, maxInFlight = 8,
    maxCleanupRequests = 128, maxCleanupRetainedBytes = 4 * 1024 * 1024, maxCleanupInFlight = 2,
    maxRecoveryInFlight = 2, maxAcknowledgementsInFlight = 8, maxObservationsInFlight = 1, retirementVersion } = {}) {
    const base = new URL(baseUrl)
    need(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password
      && !base.search && !base.hash && base.pathname === '/', 'same-origin root HTTP(S) base is required')
    need(!globalThis.location || globalThis.location.origin === base.origin, 'control base differs from current page origin')
    need(identifier(runId, 128) && identifier(clientId, 64), 'authenticated run/client are required')
    need(typeof secret === 'string' && secret.length > 0 && secret.length <= 4096 && /^[\x21-\x7e]+$/.test(secret), 'explicit transport secret is required')
    need(typeof fetcher === 'function' && typeof sha256 === 'function', 'fetch/hash adapters are required')
    need(retirementVersion === undefined || retirementVersion === '1.0', 'unsupported retirement capability version')
    this.#capabilities = Object.freeze(retirementVersion === undefined ? {} : { retirementVersion })
    need([maxRequests, maxCleanupRequests].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096)
      && [maxRetainedBytes, maxCleanupRetainedBytes].every(value => Number.isSafeInteger(value) && value >= 1024 * 1024 && value <= 256 * 1024 * 1024)
      && [maxInFlight, maxCleanupInFlight, maxRecoveryInFlight, maxAcknowledgementsInFlight, maxObservationsInFlight].every(value => Number.isSafeInteger(value) && value > 0 && value <= 64), 'finite transport limits are required')
    this.#origin = base.origin; this.#run = runId; this.#client = clientId; this.#secret = secret; this.#fetch = fetcher; this.#sha = sha256
    // Independent reservations preserve cleanup when normal/ACK work is full.
    // ACK of a cleanup result is downstream work, never a cleanup slot borrower.
    this.#limits = {
      normal: { maxRequests, maxRetainedBytes, maxInFlight },
      cleanup: { maxRequests: maxCleanupRequests, maxRetainedBytes: maxCleanupRetainedBytes, maxInFlight: maxCleanupInFlight },
      recovery: { maxRequests: 0, maxRetainedBytes: 4 * 1024 * 1024, maxInFlight: maxRecoveryInFlight },
      acknowledgement: { maxRequests: 0, maxRetainedBytes: 4 * 1024 * 1024, maxInFlight: maxAcknowledgementsInFlight },
      observation: { maxRequests: 0, maxRetainedBytes: 4 * 1024 * 1024, maxInFlight: maxObservationsInFlight },
      retirement: { maxRequests: 0, maxRetainedBytes: 256 * 1024, maxInFlight: 2 },
    }
    this.#lanes.observation = { requests: 0, retained: 0, reserved: 0, active: 0 }
    this.#lanes.retirement = { requests: 0, retained: 0, reserved: 0, active: 0 }
  }
  get capabilities() { return this.#capabilities }
  get status() {
    const lanes = Object.fromEntries(Object.entries(this.#lanes).map(([name, usage]) => [name, Object.freeze({ requests: usage.requests,
      retainedBytes: usage.retained, reservedBytes: usage.reserved, inFlight: usage.active, ...this.#limits[name] })]))
    const sum = field => Object.values(lanes).reduce((total, usage) => total + usage[field], 0)
    return Object.freeze({ phase: this.#closeResult ? this.#closeResult.closed ? 'closed' : 'cleanup-failed' : this.#closing ? 'closing' : 'open',
      requests: this.#entries.size, retainedBytes: sum('retainedBytes'), reservedBytes: sum('reservedBytes'), inFlight: sum('inFlight'),
      pendingActual: this.#jobs.size, cleanupFailures: this.#cleanupFailures, lanes: Object.freeze(lanes),
      highWater: Object.freeze({ normal: String(this.#highest.normal), cleanup: String(this.#highest.cleanup) }),
      retirements: Object.freeze(Object.fromEntries(Object.entries(this.#retirements).map(([name, state]) => [name, Object.freeze({
        throughSerial: state.throughSerial, pending: state.pending !== null, inFlight: state.pending?.actual !== null && state.pending?.actual !== undefined,
        lastReceipt: state.lastReceipt,
      })]))) })
  }
  #request(request, create, allowRetiring = false) {
    if (this.#closing) throw fault('ERR_CANCELLED', 'control transport is closing')
    need(request && [Object.prototype, null].includes(Object.getPrototypeOf(request))
      && Object.keys(request).sort().join(',') === 'command,payload,requestId,version'
      && Object.values(Object.getOwnPropertyDescriptors(request)).every(value => Object.hasOwn(value, 'value'))
      && request.version === '1.0' && commands.has(request.command) && typeof request.requestId === 'string', 'invalid control request')
    const { version, requestId, command } = request
    const prefix = `${this.#client}:${cleanup.has(command) ? 'cleanup' : 'control'}-`
    const serial = requestId.slice(prefix.length)
    need(requestId.length <= 128 && requestId.startsWith(prefix) && serial.length <= 20
      && /^[1-9][0-9]*$/.test(serial) && BigInt(serial) <= 18446744073709551615n, 'request belongs to another client/lane or invalid serial')
    const text = JSON.stringify(request), bytes = encoder.encode(text), wire = JSON.parse(text)
    need(wire.version === version && wire.command === command && wire.requestId === requestId
      && Object.keys(wire).sort().join(',') === 'command,payload,requestId,version', 'serialized request envelope changed')
    need(bytes.length <= REQUEST_LIMIT, 'control request exceeds its bound')
    // Request proxies/toJSON may synchronously close the transport. Never
    // insert or return a record after that close barrier has been published.
    if (this.#closing) throw fault('ERR_CANCELLED', 'control transport is closing')
    const existing = this.#entries.get(requestId)
    if (existing) {
      need(existing.text === text, 'immutable request bytes changed')
      if (existing.retiring && !allowRetiring) throw fault('ERR_CANCELLED', 'request belongs to an unresolved retirement')
      return existing
    }
    const laneName = cleanup.has(command) ? 'cleanup' : 'normal'
    if (BigInt(serial) <= this.#highest[laneName]) throw fault('ERR_CANCELLED', 'retired or unseen old request cannot be admitted again')
    need(create, 'replay/ACK cannot admit an unseen request')
    const lane = this.#lanes[laneName], limits = this.#limits[laneName]
    // Reserve the final on admission, before an invoke can become uncertain.
    // Exact replay can then use its independent temporary work budget without
    // charging a normal final to cleanup/recovery retained capacity.
    const charge = 1024 + 3 * bytes.length + FINAL_LIMIT
    if (lane.requests >= limits.maxRequests || lane.retained + lane.reserved + charge > limits.maxRetainedBytes)
      throw fault('ERR_CAPACITY', 'transport retained request capacity exhausted')
    const entry = { requestId, command, laneName, serial: BigInt(serial), text, bytes, charge, raw: null, hash: null, ack: null, acknowledged: null, invoked: false, active: 0, retiring: false }
    this.#entries.set(requestId, entry); this.#highest[laneName] = entry.serial; lane.requests++; lane.retained += charge
    return entry
  }
  #post(laneName, operation, body, limit, signal, consume, entry = null) {
    if (this.#closing) return Promise.reject(fault('ERR_CANCELLED', 'control transport is closing'))
    if (entry?.retiring) return Promise.reject(fault('ERR_CANCELLED', 'request belongs to an unresolved retirement'))
    const lane = this.#lanes[laneName], limits = this.#limits[laneName]
    const reservation = 3 * body.length + 2 * limit
    if (lane.active >= limits.maxInFlight || lane.retained + lane.reserved + reservation > limits.maxRetainedBytes)
      return Promise.reject(fault('ERR_CAPACITY', 'transport in-flight capacity exhausted'))
    const url = `${this.#origin}/__weapp/control/${operation}`, controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    lane.active++; lane.reserved += reservation; if (entry) entry.active++
    this.#controllers.add(controller)
    let actual, removeRelay
    actual = Promise.resolve().then(async () => {
      let response
      try {
        // Even property access can reenter close()/acknowledge(). The job and
        // entry.ack must already be published before touching this adapter.
        const addRelay = signal?.addEventListener
        const remove = signal?.removeEventListener
        need(!signal || typeof addRelay === 'function' && typeof remove === 'function', 'valid parent AbortSignal is required')
        removeRelay = remove
        if (signal?.aborted) abort(); else addRelay?.call(signal, 'abort', abort, { once: true })
        // A non-CORS POST with no-referrer can serialize Origin as null. Keep
        // the browser's exact same-origin authority; credentials never use URL.
        // Browser globals retain their own realm receiver; injected adapters
        // are plain functions and must never receive this transport as `this`.
        const fetcher = this.#fetch
        response = await fetcher(url, { method: 'POST', body: body.slice(), signal: controller.signal, redirect: 'error', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Weapp-Run-Id': this.#run, 'X-Weapp-Client-Id': this.#client, 'X-Weapp-Dev-Secret': this.#secret } })
        need(response && response.url === url && response.redirected === false && !['opaque', 'opaqueredirect'].includes(response.type), 'redirected/foreign control response refused')
        if (response.status !== 200) throw fault('ERR_HTTP', `control HTTP status ${response.status}`)
        need(/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? ''), 'JSON control response is required')
        const raw = await boundedBody(response, limit, controller.signal)
        return await consume(raw)
      } catch (error) {
        if (response?.body && !response.body.locked) {
          try { await response.body.cancel() }
          catch (cleanup) { if (!expectedAbort(cleanup, controller.signal)) error = Object.assign(new AggregateError([error, cleanup], 'control response cleanup failed'), { code: 'ERR_CLEANUP' }) }
        }
        if (error?.code === 'ERR_CLEANUP') this.#cleanupFailures = Math.min(Number.MAX_SAFE_INTEGER, this.#cleanupFailures + 1)
        throw error
      }
    }).finally(() => {
      try { removeRelay?.call(signal, 'abort', abort) }
      catch (error) { this.#cleanupFailures = Math.min(Number.MAX_SAFE_INTEGER, this.#cleanupFailures + 1); throw Object.assign(new AggregateError([error], 'control abort relay cleanup failed'), { code: 'ERR_CLEANUP' }) }
      finally { this.#controllers.delete(controller); this.#jobs.delete(actual); lane.active--; lane.reserved -= reservation; if (entry) entry.active-- }
    })
    this.#jobs.add(actual)
    return actual
  }
  #final(entry, operation, signal) {
    const laneName = operation === 'replay' ? 'recovery' : entry.laneName
    return this.#post(laneName, operation, entry.bytes, FINAL_LIMIT, signal, async raw => {
      const hasher = this.#sha, digest = await hasher(raw)
      need(hash(digest), 'invalid SHA-256 adapter result')
      const value = frozenJson(JSON.parse(decoder.decode(raw)))
      need(value?.version === '1.0' && value.requestId === entry.requestId && value.command === entry.command
        && ['ok', 'error'].includes(value.status) && value.snapshot?.runId === this.#run, 'queued/mismatched response is not a final')
      if (entry.raw) need(entry.hash === digest && equal(entry.raw, raw), 'exact request replay changed raw final bytes')
      else { entry.raw = raw; entry.hash = digest }
      this.#objects.set(value, { entry, hash: digest })
      return value
    }, entry)
  }
  invoke(request, { signal } = {}) {
    const entry = this.#request(request, true)
    need(!entry.invoked, 'invoke is once per request; use exact replay after uncertainty')
    // Admission consumes invoke even if transport fails before a final arrives.
    entry.invoked = true
    return this.#final(entry, 'invoke', signal)
  }
  replay(request, { signal } = {}) { return this.#final(this.#request(request, false), 'replay', signal) }
  /** Read-only authenticated observation. No command serial, ledger entry,
   * retained final or ACK. Keep a separate finite lane so watch polling cannot
   * consume exact replay or old-owner cleanup reservations. */
  observe({ signal } = {}) {
    return this.#post('observation', 'observe', encoder.encode('{"version":"1.0"}'), FINAL_LIMIT, signal, raw => {
      const value = frozenJson(JSON.parse(decoder.decode(raw)))
      const revision = field => typeof field === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(field)
        && BigInt(field) <= 18446744073709551615n
      need(value?.version === '1.0' && value.runId === this.#run && revision(value.controlRevision)
        && revision(value.terminalCleanupRevision) && typeof value.stopped === 'boolean'
        && typeof value.portableCurrent === 'boolean' && Object.hasOwn(value, 'offeredSite')
        && Object.hasOwn(value, 'preview'), 'invalid authenticated coordinator observation')
      return value
    })
  }
  /** Wait for actual admitted HTTP/hash/reader work without closing or aborting
   * it. The owner must already have stopped producing new commands. A timeout
   * imposed by the caller is not a drain result and retains this transport. */
  async drain() {
    while (this.#jobs.size) await Promise.allSettled([...this.#jobs])
    return Object.freeze({ drained: true, pendingActual: 0, cleanupFailures: this.#cleanupFailures })
  }
  acknowledge(request, rawParsedFinal, { signal } = {}) {
    const entry = this.#request(request, false), metadata = this.#objects.get(rawParsedFinal)
    need(metadata?.entry === entry && metadata.hash === entry.hash, 'ACK requires the original parsed final object adopted by the manager')
    if (entry.ack) return entry.ack
    if (entry.acknowledged) return Promise.resolve(entry.acknowledged)
    const body = encoder.encode(JSON.stringify({ version: '1.0', originalRequest: entry.text, finalSha256: entry.hash }))
    const actual = this.#post('acknowledgement', 'acknowledge', body, ACK_LIMIT, signal, raw => {
      const value = JSON.parse(decoder.decode(raw))
      need(value?.version === '1.0' && value.requestId === entry.requestId && value.finalSha256 === entry.hash
        && ['compacted', 'already-compacted'].includes(value.outcome), 'mismatched final acknowledgement response')
      const keys = Object.keys(value).sort().join(',')
      need(keys === 'finalSha256,outcome,requestId,version', 'unexpected final acknowledgement fields')
      return Object.freeze(value)
    }, entry).then(value => { entry.acknowledged = value; return value })
    entry.ack = actual
    void actual.finally(() => { if (entry.ack === actual) entry.ack = null }).catch(() => {})
    return actual
  }
  /** Explicitly retire a complete acknowledged prefix. A failed attempt retains
   * its exact original transaction and locks; no mutation or final is replayed.
   * After success, callers retain THIS actual promise/receipt: old command IDs
   * are forgotten and may not be submitted again, including to this method. */
  retire(requests, options = {}) {
    if (this.#closing) throw fault('ERR_CANCELLED', 'control transport is closing')
    if (this.#capabilities.retirementVersion !== '1.0') throw fault('ERR_UNSUPPORTED_CAPABILITY', 'control retirement was not negotiated')
    need(Array.isArray(requests) && requests.length > 0 && requests.length <= 64
      && Object.keys(requests).length === requests.length
      && Object.values(Object.getOwnPropertyDescriptors(requests)).every(value => Object.hasOwn(value, 'value')), 'a bounded dense retirement prefix is required')
    const entries = requests.map(request => this.#request(request, false, true)), laneName = entries[0].laneName
    need(entries.every((entry, index) => entry.laneName === laneName && (index === 0 || entries[index - 1].serial < entry.serial)), 'retirement prefix must be ordered in one lane')
    if (this.#closing) throw fault('ERR_CANCELLED', 'control transport is closing')
    const state = this.#retirements[laneName]
    let transaction = state.pending
    if (transaction) {
      need(entries.length === transaction.entries.length && entries.every((entry, index) => entry === transaction.entries[index]), 'retry must use the exact unresolved retirement prefix')
    } else {
      const retained = [...this.#entries.values()].filter(entry => entry.laneName === laneName).sort((a, b) => a.serial < b.serial ? -1 : 1)
      need(entries.every((entry, index) => retained[index] === entry && entry.serial > BigInt(state.throughSerial)
        && entry.acknowledged && entry.ack === null && entry.active === 0 && !entry.retiring), 'retirement requires the earliest acknowledged prefix with no actual work')
      const throughSerial = String(entries.at(-1).serial)
      const transcript = encoder.encode(`weapp-control-retirement-v1\n${this.#run}\n${this.#client}\n${laneName}\n${state.throughSerial}\n${throughSerial}\n`
        + entries.map(entry => `${entry.requestId}:${entry.hash}\n`).join(''))
      const charge = 1024 + 3 * transcript.length + 2 * RETIREMENT_LIMIT, usage = this.#lanes.retirement
      if (usage.retained + usage.reserved + charge > this.#limits.retirement.maxRetainedBytes) throw fault('ERR_CAPACITY', 'retirement transaction capacity exhausted')
      transaction = { entries, laneName, previousThrough: state.throughSerial, throughSerial, transcript, charge, digestPromise: null, body: null, request: null, actual: null }
      state.pending = transaction; usage.retained += charge
      for (const entry of entries) entry.retiring = true
    }
    if (transaction.actual) return transaction.actual
    let actual
    actual = Promise.resolve().then(async () => {
      // The exact job/transaction is already visible before a hash adapter or
      // options/AbortSignal getter can reenter close(), drain() or retire().
      if (!transaction.digestPromise) {
        const hasher = this.#sha
        transaction.digestPromise = Promise.resolve().then(() => hasher(transaction.transcript.slice())).then(prefixSha256 => {
          need(hash(prefixSha256), 'invalid retirement prefix SHA-256 adapter result')
          transaction.request = Object.freeze({ version: '1.0', lane: laneName, previousThrough: transaction.previousThrough,
            throughSerial: transaction.throughSerial, prefixSha256 })
          transaction.body = encoder.encode(JSON.stringify(transaction.request)); transaction.transcript = null
        })
        void transaction.digestPromise.catch(() => {})
      }
      await transaction.digestPromise
      if (this.#closing) throw fault('ERR_CANCELLED', 'control transport is closing')
      const signal = options?.signal
      const receipt = await this.#post('retirement', 'retire', transaction.body, RETIREMENT_LIMIT, signal, raw => {
        const value = JSON.parse(decoder.decode(raw)), expected = transaction.request
        need(value && Object.keys(value).sort().join(',') === 'clientId,lane,outcome,prefixSha256,previousThrough,retiredCount,runId,throughSerial,version'
          && value.version === expected.version && value.runId === this.#run && value.clientId === this.#client
          && value.lane === expected.lane && value.previousThrough === expected.previousThrough && value.throughSerial === expected.throughSerial
          && value.prefixSha256 === expected.prefixSha256 && value.retiredCount === transaction.entries.length && value.outcome === 'retired', 'mismatched retirement receipt')
        return Object.freeze(value)
      })
      // #post has now completed its ORIGINAL reader, cancellation and relay
      // cleanup. A parsed HTTP response alone was never a release barrier.
      if (this.#closing) throw fault('ERR_CANCELLED', 'control transport is closing')
      need(state.pending === transaction && transaction.entries.every(entry => entry.retiring && entry.active === 0
        && entry.ack === null && this.#entries.get(entry.requestId) === entry), 'retirement actual-work barrier changed')
      const usage = this.#lanes.retirement, receiptCharge = 1024 + 2 * encoder.encode(JSON.stringify(receipt)).length
      usage.retained = usage.retained - transaction.charge - state.receiptCharge + receiptCharge
      state.receiptCharge = receiptCharge; state.lastReceipt = receipt; state.throughSerial = transaction.throughSerial; state.pending = null
      for (const entry of transaction.entries) {
        this.#entries.delete(entry.requestId)
        const lane = this.#lanes[entry.laneName]; lane.requests--; lane.retained -= entry.charge
        // WeakMap metadata can outlive the map entry when a caller holds the
        // parsed final. Clear large owned fields before releasing the record.
        entry.bytes = null; entry.raw = null; entry.text = ''; entry.hash = null; entry.acknowledged = null; entry.charge = 0
      }
      transaction.entries = []; transaction.body = null
      return receipt
    }).finally(() => { transaction.actual = null; this.#jobs.delete(actual) })
    transaction.actual = actual; this.#jobs.add(actual)
    return actual
  }
  close() {
    if (this.#closing) return this.#closing
    let resolve
    this.#closing = new Promise(done => { resolve = done })
    // Publish the exact close barrier before abort callbacks can reenter.
    for (const controller of this.#controllers) controller.abort(fault('ERR_CANCELLED', 'control transport closed'))
    void Promise.allSettled([...this.#jobs]).then(() => {
      for (const entry of this.#entries.values()) { entry.bytes = null; entry.raw = null; entry.text = ''; entry.hash = null; entry.acknowledged = null }
      this.#entries.clear(); this.#objects = new WeakMap()
      for (const state of Object.values(this.#retirements)) { state.pending = null; state.receiptCharge = 0 }
      for (const lane of Object.values(this.#lanes)) { lane.requests = 0; lane.retained = 0 }
      this.#closeResult = Object.freeze({ closed: this.#cleanupFailures === 0, pendingActual: this.#jobs.size,
        cleanupFailures: this.#cleanupFailures })
      resolve(this.#closeResult)
    })
    return this.#closing
  }
  dispose() { return this.close() }
}
