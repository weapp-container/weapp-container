/** Optional bounded diagnostics. A runtime ACK or canvas swap is never a
 * compositor/physical-display endpoint. This module owns no business work. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const copy = value => freeze(structuredClone(value))
const same = (a, b) => a === b || Boolean(a && b && typeof a === 'object' && typeof b === 'object'
  && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key])))
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const ownerFields = ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend']
const owner = value => record(value) && ownerFields.every(key => id(value[key]))
const immutableOwner = value => Object.fromEntries(ownerFields.map(key => [key, value[key]]))
const rect = value => value && ['width', 'height'].every(key => Number.isFinite(value[key]))
  && [value.x ?? 0, value.y ?? 0].every(Number.isFinite)
  ? { x: value.x ?? 0, y: value.y ?? 0, width: value.width, height: value.height } : null
const path = value => typeof value === 'string' && value.length <= 4096 ? value : null
const source = value => ({ pageId: decimal(value?.currentPage?.pageId) ? value.currentPage.pageId : null,
  routePath: path(value?.currentPage?.path), templateRevision: decimal(value?.templateRevision) ? value.templateRevision : null,
  surfaceGeneration: decimal(value?.surfaceGeneration) ? value.surfaceGeneration : null,
  inputLifetimeRevision: decimal(value?.inputLifetimeRevision) ? value.inputLifetimeRevision : null, viewport: rect(value?.viewport) })
const sameScope = (a, b) => a?.pageId === b?.pageId && a?.routePath === b?.routePath && same(a?.viewport, b?.viewport)
const changedWithinLifetime = value => decimal(value.before.templateRevision) && decimal(value.after.templateRevision)
  && value.before.templateRevision !== value.after.templateRevision && sameScope(value.before, value.after)
  && decimal(value.before.surfaceGeneration) && value.before.surfaceGeneration === value.after.surfaceGeneration
  && decimal(value.before.inputLifetimeRevision) && value.before.inputLifetimeRevision === value.after.inputLifetimeRevision
const tokensValid = value => Array.isArray(value) && value.length > 0 && value.length <= 64
  && value.every(decimal) && new Set(value).size === value.length
const sourceValid = value => exact(value, ['pageId', 'routePath', 'templateRevision', 'surfaceGeneration', 'inputLifetimeRevision', 'viewport'])
  && ['pageId', 'templateRevision', 'surfaceGeneration', 'inputLifetimeRevision'].every(key => value[key] === null || decimal(value[key]))
  && (value.routePath === null || path(value.routePath) !== null)
  && (value.viewport === null || exact(value.viewport, ['x', 'y', 'width', 'height']) && rect(value.viewport) !== null)
const consumedValid = value => exact(value, ['pageId', 'routePath', 'templateRevision', 'viewport'])
  && decimal(value.pageId) && path(value.routePath) !== null && decimal(value.templateRevision)
  && exact(value.viewport, ['x', 'y', 'width', 'height']) && rect(value.viewport) !== null
const appliedValid = (value, withAssociation = false) => exact(value, ['version', 'sessionId', 'sequence', 'sampleIds', 'requestId',
  'innerRequestId', 'workerAt', 'clockDomain', 'before', 'after', 'outcome', ...(withAssociation ? ['association'] : [])])
  && value.version === '1.0' && id(value.sessionId) && decimal(value.sequence) && tokensValid(value.sampleIds)
  && id(value.requestId) && id(value.innerRequestId) && (value.workerAt === null || Number.isFinite(value.workerAt) && value.workerAt >= 0)
  && value.clockDomain === 'worker-monotonic' && sourceValid(value.before) && sourceValid(value.after)
  && ['success', 'error', 'unknown'].includes(value.outcome)
  && (!withAssociation || ['exact-data-revision', 'ordered-only'].includes(value.association))
export const INPUT_TIMING_CONTRACT = Object.freeze({ version: '1.0', scope: 'skia-worker',
  applied: 'native-dispatch-final', clone: 'original-consumed-input', endpoints: 'submission-swap-runtime-ack',
  compositor: 'missing', physicalDisplay: 'missing' })
export const inputTimingRequestValid = value => record(value) && Object.keys(value).length === 1 && value.version === '1.0'

/** Remote paths lack a native input→clone token. Keep every bounded input or
 * input-batch fact, but never associate it with the next unrelated frame. */
export class UncorrelatedInputLedger {
  #scope; #clock; #last = -Infinity; #sequence = 0n; #records = []; #closed = false
  #counts = { evicted: 0, clockFaults: 0, late: 0, invalid: 0 }
  constructor({ scope, clock = () => globalThis.performance.now() } = {}) {
    if (!['remote-raster', 'remote-dom'].includes(scope) || typeof clock !== 'function') throw new TypeError('invalid remote diagnostic scope')
    this.#scope = scope; this.#clock = clock
  }
  #time() {
    let at
    try { at = this.#clock() } catch { this.#counts.clockFaults++; return null }
    if (!Number.isFinite(at) || at < 0 || at < this.#last) { this.#counts.clockFaults++; return null }
    this.#last = at; return at
  }
  capture({ binding = {}, type = 'event-batch', eventCount = 1, nativeTimeStamp, isTrusted } = {}) {
    if (this.#closed || !id(type) || !Number.isSafeInteger(eventCount) || eventCount < 1 || eventCount > 256
      || this.#sequence === 18446744073709551615n) { this.#counts.invalid++; return null }
    const projected = {}
    for (const key of ['sessionId', 'pageId', 'previewEpoch', 'configGeneration', 'surfaceGeneration', 'documentRevision', 'presentationRevision', 'renderRevision']) {
      if (typeof binding[key] === 'string' && binding[key].length <= 128 || Number.isSafeInteger(binding[key]) && binding[key] >= 0) projected[key] = binding[key]
    }
    const sampleId = String(++this.#sequence)
    this.#records.push({ sampleId, binding: projected, type, eventCount, capturedAt: this.#time(),
      nativeTimeStamp: Number.isFinite(nativeTimeStamp) && nativeTimeStamp >= 0 ? nativeTimeStamp : null,
      nativeClockDomain: 'dom-event-unmapped', isTrusted: isTrusted === true, completedAt: null, outcome: 'pending', requestId: null })
    if (this.#records.length > 512) { this.#records.shift(); this.#counts.evicted++ }
    return sampleId
  }
  complete(sampleIds, { outcome = 'protocol-completed', requestId } = {}) {
    const at = this.#time()
    for (const sampleId of sampleIds ?? []) {
      const value = this.#records.find(record => record.sampleId === sampleId)
      if (!value) { this.#counts.invalid++; continue }
      if (value.outcome !== 'pending' || this.#closed) { this.#counts.late++; continue }
      value.completedAt = at; value.outcome = id(outcome) ? outcome : 'unknown'; value.requestId = id(requestId) ? requestId : null
    }
  }
  drop(sampleIds, reason) { this.complete(sampleIds, { outcome: `discarded:${id(reason) ? reason.slice(0, 110) : 'unknown'}` }) }
  retire() {
    if (this.#closed) return
    this.complete(this.#records.filter(value => value.outcome === 'pending').map(value => value.sampleId), { outcome: 'owner-retired' }); this.#closed = true
  }
  snapshot() { return copy({ version: '1.0', scope: this.#scope, association: 'unavailable', clockDomain: 'window-monotonic',
    gate: { status: 'blocked', missing: ['native-input-clone-token', 'compositor-presentation-feedback'], inputToPresentP95Ms: null },
    counts: this.#counts, maxRecords: 512, retired: this.#closed, records: this.#records }) }
}

/** Worker-local input ordering. Capture once at original render; callers must
 * retain that clone receipt through frame.current/scale/recovery. */
export class AppliedInputTrace {
  #session; #clock; #last = -Infinity; #sequence = 0n; #records = []; #dropped = 0; #faults = 0
  constructor({ sessionId, clock = () => globalThis.performance.now() }) {
    if (!id(sessionId) || typeof clock !== 'function') throw new TypeError('input timing requires session and monotonic clock')
    this.#session = sessionId; this.#clock = clock
  }
  #time() {
    let value
    try { value = this.#clock() } catch { this.#faults++; return null }
    if (!Number.isFinite(value) || value < 0 || value < this.#last) { this.#faults++; return null }
    this.#last = value; return value
  }
  applied({ sampleIds, requestId, innerRequestId, before, after, ok }) {
    if (!tokensValid(sampleIds) || !id(requestId) || !id(innerRequestId) || this.#sequence === 18446744073709551615n) {
      this.#faults++; return null
    }
    const value = copy({ version: '1.0', sessionId: this.#session, sequence: String(++this.#sequence), sampleIds,
      requestId, innerRequestId, workerAt: this.#time(), clockDomain: 'worker-monotonic', before: source(before), after: source(after),
      outcome: ok === true ? 'success' : ok === false ? 'error' : 'unknown' })
    this.#records.push(value)
    if (this.#records.length > 32) { this.#records.shift(); this.#dropped++ }
    return value
  }
  clone(consumedInput) {
    const applied = this.#records.map(value => ({ ...value,
      association: value.outcome === 'success' && sameScope(value.after, consumedInput) && changedWithinLifetime(value)
        && value.after.templateRevision === consumedInput.templateRevision ? 'exact-data-revision' : 'ordered-only' }))
    return copy({ version: '1.0', sessionId: this.#session, capturedThrough: String(this.#sequence), workerAt: this.#time(),
      clockDomain: 'worker-monotonic', consumedInput, applied, droppedAppliedBatches: this.#dropped, clockFaults: this.#faults })
  }
}

/** One immutable owner, one Window clock domain, bounded samples/frames/events.
 * No quantile or gate can be inferred from these candidate protocol stages. */
export class InputCausalLedger {
  #owner; #clock; #clockDomain; #timeOrigin; #last = -Infinity; #serial = 0n; #closed = false
  #samples = new Map(); #frames = new Map(); #events = []; #maxSamples; #maxFrames; #maxEvents
  #counts = { captured: 0, evictedSamples: 0, evictedFrames: 0, evictedEvents: 0, clockFaults: 0, invalid: 0, late: 0, dropped: 0, omittedDiagnostics: 0 }
  constructor({ owner: identity, clock = () => globalThis.performance.now(), clockDomain = 'window-monotonic',
    timeOrigin = globalThis.performance?.timeOrigin ?? null, maxSamples = 512, maxFrames = 64, maxEvents = 2048 } = {}) {
    if (!owner(identity) || typeof clock !== 'function' || !id(clockDomain)
      || ![maxSamples, maxFrames, maxEvents].every(value => Number.isSafeInteger(value) && value > 0)
      || maxSamples > 512 || maxFrames > 64 || maxEvents > 4096
      || !(timeOrigin === null || Number.isFinite(timeOrigin))) throw new TypeError('invalid bounded input timing ledger')
    this.#owner = copy(immutableOwner(identity)); this.#clock = clock; this.#clockDomain = clockDomain; this.#timeOrigin = timeOrigin
    this.#maxSamples = maxSamples; this.#maxFrames = maxFrames; this.#maxEvents = maxEvents
  }
  #time() {
    let value
    try { value = this.#clock() } catch { this.#counts.clockFaults++; return null }
    if (!Number.isFinite(value) || value < 0 || value < this.#last) { this.#counts.clockFaults++; return null }
    this.#last = value; return value
  }
  #event(kind, details, at = this.#time()) {
    this.#events.push({ kind, at, ...details })
    if (this.#events.length > this.#maxEvents) { this.#events.shift(); this.#counts.evictedEvents++ }
    return at
  }
  #invalid(reason) { this.#counts.invalid++; this.#event('incomplete', { reason }); return null }
  capture({ state, type, nativeTimeStamp, isTrusted }) {
    if (this.#closed || !id(type) || this.#serial === 18446744073709551615n) return this.#invalid('capture-after-retirement-or-invalid')
    const sampleId = String(++this.#serial), at = this.#time()
    const value = { sampleId, owner: this.#owner, source: source(state), type,
      nativeTimeStamp: Number.isFinite(nativeTimeStamp) && nativeTimeStamp >= 0 ? nativeTimeStamp : null,
      nativeClockDomain: 'dom-event-unmapped', isTrusted: isTrusted === true, capturedAt: at, status: 'captured',
      queuedAt: null, appliedReceivedAt: null, applied: null, frames: [], dropped: null }
    this.#samples.set(sampleId, value); this.#counts.captured++
    if (this.#samples.size > this.#maxSamples) {
      const oldest = this.#samples.keys().next().value; this.#samples.delete(oldest); this.#counts.evictedSamples++
      this.#event('sample-evicted', { sampleId: oldest, reason: 'sample-budget' }, at)
    }
    this.#event('input', { sampleId }, at); return sampleId
  }
  queued(sampleIds) {
    const at = this.#time()
    for (const sampleId of sampleIds ?? []) {
      const value = this.#samples.get(sampleId)
      if (!value || value.status !== 'captured') { this.#invalid('queued-unknown-or-duplicate-sample'); continue }
      value.queuedAt = at; value.status = 'queued'; this.#event('queued', { sampleId }, at)
    }
  }
  applied(receipt, { late = false } = {}) {
    if (receipt === undefined || receipt?.omitted) return this.omitted('applied', receipt?.omitted ?? 'not-delivered', { late })
    if (!appliedValid(receipt) || receipt.sessionId !== this.#owner.sessionId) return this.#invalid('invalid-applied-receipt')
    const at = this.#time()
    for (const sampleId of receipt.sampleIds) {
      const value = this.#samples.get(sampleId)
      if (!value) { this.#invalid('applied-sample-not-retained'); continue }
      if (value.applied && !same(value.applied, receipt)) { this.#invalid('sample-applied-twice'); continue }
      value.applied ??= copy(receipt); value.appliedReceivedAt ??= at
      if (late || this.#closed || value.dropped) this.#counts.late++
      else value.status = receipt.outcome === 'success' ? 'applied' : 'application-error'
      this.#event('applied', { sampleId, sequence: receipt.sequence, late: late || this.#closed || Boolean(value.dropped) }, at)
    }
  }
  frame(stage, { proof, inputTiming, physicalSize, late = false, code } = {}) {
    const publication = proof?.publication, consumed = proof?.consumedInput
    if (!exact(proof, ['version', 'owner', 'attemptId', 'surfaceGeneration', 'publication', 'consumedInput']) || proof.version !== '1.0'
      || !exact(proof.owner, ownerFields) || !owner(proof.owner) || !same(immutableOwner(proof.owner), this.#owner) || !decimal(proof.attemptId)
      || !decimal(proof.surfaceGeneration) || publication?.kind !== 'external-frame' || !decimal(publication.renderRevision)
      || !exact(publication, ['kind', 'renderRevision']) || !consumedValid(consumed)) return this.#invalid('invalid-frame-owner-or-proof')
    const key = JSON.stringify([proof.attemptId, proof.surfaceGeneration, publication.renderRevision]), at = this.#time()
    let value = this.#frames.get(key)
    if (stage === 'clone') {
      if (value) return this.#invalid('duplicate-clone')
      const valid = exact(inputTiming, ['version', 'sessionId', 'capturedThrough', 'workerAt', 'clockDomain', 'consumedInput', 'applied', 'droppedAppliedBatches', 'clockFaults'])
        && inputTiming.version === '1.0' && inputTiming.sessionId === this.#owner.sessionId
        && decimal(inputTiming.capturedThrough) && same(inputTiming.consumedInput, consumed) && Array.isArray(inputTiming.applied)
        && inputTiming.applied.length <= 32 && inputTiming.applied.every(item => appliedValid(item, true) && item.sessionId === this.#owner.sessionId)
        && inputTiming.clockDomain === 'worker-monotonic' && (inputTiming.workerAt === null || Number.isFinite(inputTiming.workerAt) && inputTiming.workerAt >= 0)
        && ['droppedAppliedBatches', 'clockFaults'].every(key => Number.isSafeInteger(inputTiming[key]) && inputTiming[key] >= 0)
      const size = exact(physicalSize, ['width', 'height']) && ['width', 'height'].every(key => Number.isSafeInteger(physicalSize[key]) && physicalSize[key] > 0 && physicalSize[key] <= 4096)
        && physicalSize.width * physicalSize.height * 4 <= 16 * 1024 * 1024
        ? copy(physicalSize) : null
      value = { key, proof: copy(proof), physicalSize: size, cloneReceivedAt: at,
        submittedAt: null, visibleSwapAt: null, runtimeAckReceivedAt: null, failure: null, late: late || this.#closed,
        inputTiming: valid ? copy(Object.fromEntries(['version', 'sessionId', 'capturedThrough', 'workerAt', 'clockDomain', 'droppedAppliedBatches', 'clockFaults'].map(key => [key, inputTiming[key]]))) : null,
        samples: [], omittedSampleLinks: 0, complete: valid && size !== null && inputTiming.droppedAppliedBatches === 0 && inputTiming.clockFaults === 0 }
      if (!valid) {
        if (inputTiming === undefined || inputTiming?.omitted) this.omitted('clone', inputTiming?.omitted ?? 'not-delivered', { late })
        else this.#invalid('clone-has-no-valid-original-input-receipt')
      }
      else for (const applied of inputTiming.applied) {
        if (!tokensValid(applied.sampleIds)) { value.complete = false; this.#invalid('invalid-clone-input-ids'); continue }
        for (const sampleId of applied.sampleIds) {
          const sample = this.#samples.get(sampleId)
          if (!sample) continue // An explicitly counted earlier eviction is not a new input.
          const association = applied.association === 'exact-data-revision' && sameScope(sample.source, consumed)
            && sample.source.surfaceGeneration === proof.surfaceGeneration
            && sameScope(applied.after, consumed) && changedWithinLifetime(applied)
            && applied.after.surfaceGeneration === proof.surfaceGeneration
            && sample.source.inputLifetimeRevision === applied.after.inputLifetimeRevision
            && applied.after?.templateRevision === consumed.templateRevision && applied.outcome === 'success'
            ? 'exact-data-revision' : 'ordered-only'
          if (value.samples.some(link => link.sampleId === sampleId)) { value.complete = false; this.#invalid('duplicate-clone-sample'); continue }
          if (sample.frames.length < 4 && value.samples.length < 128) {
            value.samples.push({ sampleId, association }); sample.frames.push(key)
          } else { value.omittedSampleLinks++; value.complete = false; this.#invalid('sample-frame-attempt-budget') }
        }
      }
      this.#frames.set(key, value)
      if (this.#frames.size > this.#maxFrames) { this.#frames.delete(this.#frames.keys().next().value); this.#counts.evictedFrames++; this.#event('frame-evicted', { reason: 'frame-budget' }, at) }
    } else {
      if (!value || !same(value.proof, proof)) return this.#invalid('frame-stage-has-no-exact-clone')
      const field = { submitted: 'submittedAt', 'visible-swap': 'visibleSwapAt', 'runtime-ack': 'runtimeAckReceivedAt' }[stage]
      if (stage === 'failed') value.failure = id(code) ? code : 'ERR_RENDER'
      else if (!field || value[field] !== null) return this.#invalid('unknown-or-duplicate-frame-stage')
      else if (stage === 'visible-swap' && value.submittedAt === null || stage === 'runtime-ack' && value.visibleSwapAt === null) return this.#invalid('frame-stage-predecessor-missing')
      else value[field] = at
      value.late ||= late || this.#closed
    }
    if (value.late) this.#counts.late++
    this.#event(stage, { key, late: value.late }, at)
    return key
  }
  drop(sampleIds, reason = 'discarded') {
    const at = this.#time()
    for (const sampleId of sampleIds ?? []) {
      const value = this.#samples.get(sampleId)
      if (!value) { this.#invalid('discarded-sample-not-retained'); continue }
      if (!value.dropped) { value.dropped = { reason: id(reason) ? reason : 'discarded', at }; value.status = 'discarded'; this.#counts.dropped++ }
      this.#event('discarded', { sampleId, reason: value.dropped.reason }, at)
    }
  }
  omitted(stage, reason = 'not-delivered', { late = false } = {}) {
    this.#counts.omittedDiagnostics++
    if (late || this.#closed) this.#counts.late++
    this.#event('diagnostic-omitted', { stage: ['applied', 'clone'].includes(stage) ? stage : 'unknown',
      reason: ['not-delivered', 'payload-budget', 'diagnostic-budget', 'invalid-diagnostic', 'request-diagnostic-omitted'].includes(reason)
        ? reason : 'unknown', late: late || this.#closed })
    return null
  }
  retire() {
    if (this.#closed) return
    this.#closed = true
    for (const value of this.#frames.values()) if (value.runtimeAckReceivedAt === null) { value.late = true; value.complete = false }
    this.drop([...this.#samples.values()].filter(value => !value.dropped && value.frames.length === 0).map(value => value.sampleId), 'owner-retired')
    this.#event('retired', {})
  }
  snapshot() {
    const frames = [...this.#frames.values()], candidates = []
    for (const frame of frames) for (const link of frame.samples) {
      const sample = this.#samples.get(link.sampleId)
      if (!sample || sample.capturedAt === null || frame.late || sample.dropped || link.association !== 'exact-data-revision') continue
      const stages = {}
      for (const [name, at] of [['applied-received', sample.appliedReceivedAt], ['clone-received', frame.cloneReceivedAt],
        ['submitted', frame.submittedAt], ['visible-swap', frame.visibleSwapAt], ['runtime-ack-received', frame.runtimeAckReceivedAt]]) {
        if (this.#counts.clockFaults === 0 && at !== null && at >= sample.capturedAt) stages[name] = at - sample.capturedAt
      }
      candidates.push({ sampleId: sample.sampleId, frameKey: frame.key, association: link.association,
        clockDomain: this.#clockDomain, durationsMs: stages, endpoint: 'protocol-stages-only', visualChange: 'unproven' })
    }
    return copy({ version: '1.0', owner: this.#owner, clock: { domain: this.#clockDomain, timeOrigin: this.#timeOrigin },
      retired: this.#closed, gate: { status: 'blocked', missing: ['compositor-frame-flow', 'compositor-presentation-feedback', 'physical-display-evidence'],
        inputToPresentP95Ms: null, scrollDroppedFrameRate: null }, counts: this.#counts,
      limits: { maxSamples: this.#maxSamples, maxFrames: this.#maxFrames, maxEvents: this.#maxEvents, maxSampleFrameAttempts: 4, maxFrameSampleLinks: 128 },
      samples: [...this.#samples.values()], frames, events: this.#events, candidates })
  }
}
