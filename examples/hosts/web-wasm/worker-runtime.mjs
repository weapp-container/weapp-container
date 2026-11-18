import { decodeNativeFrameBinary } from './worker-frame-wire.mjs'
import { routeStyleIds } from './render-inputs.mjs'
import { measureWorkerPayload, WORKER_EVENT_LIMITS, HOST_API_RESOURCE_MAX_BYTES, splitWorkerInputTiming, fitWorkerInputTiming, isWorkerInputTimingRequest } from './worker-session-client.mjs'
import { AppliedInputTrace, INPUT_TIMING_CONTRACT, inputTimingRequestValid } from './input-causal-ledger.mjs'
import { packHostApiWire, unpackHostApiWire } from './host-api-binary-wire.mjs'
import { packWorkerFrameWire, workerFrameResponseLimits } from './worker-frame-wire.mjs'

// This module owns scheduling and verified pack loading. It imports no WASM,
// browser presentation, HTTP runtime transport, DOM, or pixel readback API.
export const WORKER_PROTOCOL_VERSION = '1.0'
export const WORKER_PACK_BUDGET = 128 * 1024 * 1024
const INDEX_LIMIT = 2 * 1024 * 1024
const MANIFEST_LIMIT = 8 * 1024 * 1024
const RESOURCE_LIMIT = 16 * 1024 * 1024
const TEXT_FONT_LIMIT = 32 * 1024 * 1024
const MAX_BLOBS = 16384
const PACK_FETCH_CONCURRENCY = 6
const ORDINARY_LIMIT = 64
const CONTROL_LIMIT = 7 // The eighth reserved slot belongs exclusively to close.
const MESSAGE_LIMIT = 16 * 1024 * 1024
const CONTROL_MESSAGE_LIMIT = 64 * 1024
const IN_FLIGHT_LIMIT = 64 * 1024 * 1024
const CONTROL_RESERVE = 256 * 1024
const U64_MAX = 18446744073709551615n
const CONTROL_OPS = new Set(['retire', 'abort', 'view.retire', 'view.abort', 'view.sample.abort', 'events.ack', 'native.revoke'])
const HOST_OPS = new Set(['load', 'bridge', 'state', 'frame', 'frame.current', 'surface.recover', 'renderer.transition', 'ack', 'resource', 'metrics', 'scale', 'retire', 'abort', 'view.retire', 'view.abort', 'view.sample.abort', 'events.ack', 'close', 'native.take', 'native.complete', 'native.event', 'native.revoke', 'native.phone', 'native.component', 'native.snapshots', 'native.components', 'native.frame', 'native.media-resource', 'native.api-resource'])
const ENVELOPE_KEYS = ['version', 'workerEpoch', 'sessionId', 'requestId', 'kind', 'op', 'payload']
const PURE_BRIDGE_OPS = new Set(['cancel', 'diagnostic', 'error'])
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = (value, limit = 128) => typeof value === 'string' && value.length > 0 && value.length <= limit && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
const digestString = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20 && BigInt(value) <= U64_MAX
const fail = (code, message, details) => Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) })
const check = (condition, code, message) => { if (!condition) throw fail(code, message) }
const diagnostic = error => ({ code: error?.code || String(error).match(/ERR_[A-Z_]+/)?.[0] || 'ERR_ENGINE',
  message: error?.message || String(error), ...(error?.details === undefined ? {} : { details: error.details }) })
const rendererProfiles = new Set(['skia', 'skyline-compat', 'webview'])
export const WORKER_RENDER_SCALE_CONTRACT = Object.freeze({ version: '1.0', density: 'finite-positive-up-to-4',
  startup: 'before-first-export', target: 'native-exact-revision-v1', update: 'retained-layout', metrics: 'unchanged' })
const transportForProfile = profile => profile === 'webview' ? 'browser-view' : 'external-frame'
export const WORKER_RENDERER_TRANSITION_CONTRACT = Object.freeze({ version: '1.0', runtimeOwner: '1.0',
  presenterBinding: '1.0', inputLifetime: '1.0', transitionFinal: '1.0', observation: '2.0' })
const HOST_RENDERER_TRANSITION_CONTRACT = Object.freeze({ version: '1.0', runtimeOwner: '1.0',
  presenterBinding: '1.0', inputLifetime: '1.0', transitionFinal: '1.0' })
const PRESENTER_OPS = new Set(['frame', 'frame.current', 'surface.recover', 'ack', 'resource', 'scale', 'retire', 'abort', 'view.retire', 'view.abort', 'view.sample.abort'])
const PRESENTER_BRIDGE_OPS = new Set(['render.commit', 'event.batch', 'view.prepare', 'view.prepare.commit', 'view.presented', 'view.geometry', 'view.events', 'view.query.result', 'view.abort', 'view.animation.baseline', 'view.sample.prepare', 'view.sample.presented', 'view.sample.abort'])

function parseRendererTransitions(value) {
  if (value === undefined) return null
  check(record(value) && Object.keys(value).length === 1 && value.version === '1.0',
    'ERR_PROTOCOL_VERSION', 'rendererTransitions requires explicit version 1.0')
  return WORKER_RENDERER_TRANSITION_CONTRACT
}

export function copyWorkerPresenterBinding(value, sessionId) {
  value = boundedJsonCopy(value)
  check(record(value) && Object.keys(value).length === 4 && value.version === '1.0'
    && value.sessionId === sessionId && identifier(sessionId) && decimal(value.generation) && value.generation !== '0'
    && ['browser-view', 'external-frame'].includes(value.transportBackend),
  'ERR_PROTOCOL_VERSION', 'invalid exact Worker presenter binding')
  return freezeJson(value)
}

function parseRendererPolicy(value) {
  if (value === undefined) return null // Preserve the existing low-level force contract.
  check(record(value), 'ERR_INVALID_REQUEST', 'rendererPolicy must be an explicit manifest or force policy')
  if (value.mode === 'manifest' && Object.keys(value).length === 1) return { mode: 'manifest' }
  if (value.mode === 'force' && Object.keys(value).length === 2 && rendererProfiles.has(value.profile)) {
    return { mode: 'force', profile: value.profile }
  }
  throw fail('ERR_INVALID_REQUEST', 'rendererPolicy must be {mode:manifest} or {mode:force,profile}')
}

function sameRendererPolicy(a, b) {
  return record(a) && a.mode === b.mode && Object.keys(a).length === (b.mode === 'force' ? 2 : 1)
    && (b.mode !== 'force' || a.profile === b.profile)
}

function declaredProfileForRoute(manifest, path) {
  const rendering = manifest.rendering
  if (rendering == null) return 'skia' // Match Rust's optional legacy declaration.
  check(record(rendering) && rendering.version === '1.0' && record(rendering.pages)
    && rendererProfiles.has(rendering.default), 'ERR_INVALID_MANIFEST', 'unsupported rendering profile declaration')
  const profile = Object.prototype.hasOwnProperty.call(rendering.pages, path) ? rendering.pages[path] : rendering.default
  check(rendererProfiles.has(profile), 'ERR_INVALID_MANIFEST', 'route declares an unsupported renderer profile')
  return profile
}

// Opt-in product scheduling contract. These pure helpers are also available
// to a future page adapter AFTER structured clone, which does not retain freeze.
const EXTERNAL_PRESENTATION_CONTRACT = Object.freeze({ version: '1.0', consumedInput: '1.0', ackOutcome: '1.0', physicalTarget: '1.0' })
const SURFACE_RECOVERY_CONTRACT = Object.freeze({ version: '1.0', retainedExternalFrame: '1.0' })
const finiteRect = value => record(value) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key]))
  && value.width > 0 && value.height > 0 && value.width <= 4096 && value.height <= 4096
const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every(key => a[key] === b[key])
const batchHasError = batch => batch.messages.some(message => message.op === 'error' || message.payload?.ok === false || message.payload?.requiresRestart === true)
function freezeJson(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    for (const child of Object.values(value)) freezeJson(child, seen)
    Object.freeze(value)
  }
  return value
}
function boundedJsonCopy(value) {
  measureWorkerPayload(value, { maxBytes: MESSAGE_LIMIT })
  return structuredClone(value)
}
const BROWSER_QUERIES_CONTRACT = Object.freeze({ version: '1.0' })
function browserQueriesRequest(value) {
  if (value === undefined) return null
  check(record(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'version') && value.version === '1.0',
    'ERR_PROTOCOL_VERSION', 'browserQueries requires the explicit version 1.0 contract')
  return BROWSER_QUERIES_CONTRACT
}
function parseExternalPresentationRequest(value) {
  if (value === undefined) return null
  check(record(value) && Object.keys(value).length === 1 && value.version === '1.0',
    'ERR_PROTOCOL_VERSION', 'externalPresentation requires the explicit version 1.0 contract')
  return EXTERNAL_PRESENTATION_CONTRACT
}
function externalContract(value) {
  check(record(value) && Object.keys(value).length === 4 && Object.keys(EXTERNAL_PRESENTATION_CONTRACT).every(key => value[key] === EXTERNAL_PRESENTATION_CONTRACT[key]),
    'ERR_PROTOCOL_VERSION', 'host does not advertise consumedInput/ackOutcome/physicalTarget 1.0')
  return EXTERNAL_PRESENTATION_CONTRACT
}
function surfaceRecoveryRequest(value) {
  if (value === undefined) return null
  check(record(value) && Object.keys(value).length === 1 && value.version === '1.0',
    'ERR_PROTOCOL_VERSION', 'surfaceRecovery requires the explicit version 1.0 contract')
  return SURFACE_RECOVERY_CONTRACT
}
function surfaceRecoveryContract(value) {
  check(record(value) && Object.keys(value).length === 2
    && Object.keys(SURFACE_RECOVERY_CONTRACT).every(key => value[key] === SURFACE_RECOVERY_CONTRACT[key]),
  'ERR_PROTOCOL_VERSION', 'host does not advertise retained external frame recovery 1.0')
  return SURFACE_RECOVERY_CONTRACT
}

/** Exact accepted physical size, independent of current metrics/device DPR. */
export function copyExternalFrameTarget(value, { sessionId, renderRevision } = {}) {
  value = boundedJsonCopy(value)
  check(identifier(sessionId) && decimal(renderRevision) && renderRevision !== '0',
    'ERR_PROTOCOL_VERSION', 'physical target requires an exact session/render token')
  check(record(value) && Object.keys(value).length === 5 && value.version === '1.0',
    'ERR_PROTOCOL_VERSION', 'unsupported physical target contract')
  check(value.sessionId === sessionId && value.renderRevision === renderRevision,
    'ERR_CANCELLED', 'physical target belongs to another session or render revision')
  check(['width', 'height'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= 4096)
    && value.width * value.height * 4 <= 16 * 1024 * 1024,
  'ERR_RENDER', 'physical target exceeds the external presentation budget')
  return Object.freeze({ version: '1.0', sessionId, renderRevision, width: value.width, height: value.height })
}

/** Copy only exact-frame prepare metadata, never ACK/current-state inference. */
export function copyExternalFrameScheduling(value, { sessionId, renderRevision, frame } = {}) {
  // Reject accessors/non-data before reading externally supplied fields.
  value = boundedJsonCopy(value)
  check(identifier(sessionId) && decimal(renderRevision) && renderRevision !== '0' && record(frame) && finiteRect(frame.viewport),
    'ERR_PROTOCOL_VERSION', 'external scheduling requires an exact frame/session/render token')
  check(record(value) && value.version === '1.0', 'ERR_PROTOCOL_VERSION', 'unsupported external consumed-input version')
  check(value.sessionId === sessionId && value.renderRevision === renderRevision,
    'ERR_CANCELLED', 'consumed-input metadata belongs to another session or render revision')
  let input = null
  if (value.consumedInput !== null) {
    const raw = value.consumedInput
    check(record(raw) && decimal(raw.pageId) && raw.pageId !== '0' && decimal(raw.templateRevision)
      && typeof raw.routePath === 'string' && raw.routePath.length > 0 && raw.routePath.length <= 4096
      && finiteRect(raw.viewport) && sameRect(raw.viewport, frame.viewport),
    'ERR_PROTOCOL_VERSION', 'invalid clone-time consumed input or frame geometry mismatch')
    input = Object.freeze({ pageId: raw.pageId, routePath: raw.routePath, templateRevision: raw.templateRevision,
      viewport: Object.freeze({ x: raw.viewport.x, y: raw.viewport.y, width: raw.viewport.width, height: raw.viewport.height }) })
  }
  return Object.freeze({ version: '1.0', sessionId, renderRevision, consumedInput: input })
}

/** Validate/copy a genuine final. It contains NO consumedInput/scheduling. */
export function copyExternalPresentationOutcome(value, { sessionId, renderRevision } = {}) {
  value = boundedJsonCopy(value)
  check(identifier(sessionId) && decimal(renderRevision) && renderRevision !== '0',
    'ERR_PROTOCOL_VERSION', 'external ACK requires an exact session/render token')
  check(record(value) && value.version === '1.0' && value.acknowledged === true
    && typeof value.inputEnabled === 'boolean' && typeof value.requiresRestart === 'boolean',
  'ERR_PROTOCOL_VERSION', 'host returned an invalid structured external ACK')
  check(value.sessionId === sessionId && value.renderRevision === renderRevision,
    'ERR_CANCELLED', 'ACK final belongs to another session or render revision')
  check(!Object.prototype.hasOwnProperty.call(value, 'consumedInput') && !Object.prototype.hasOwnProperty.call(value, 'scheduling'),
    'ERR_PROTOCOL_VERSION', 'ACK final must not relabel consumed template input')
  const batch = value.batch, state = value.observedState
  check(record(batch) && Array.isArray(batch.messages) && batch.messages.every(message => record(message)
    && message.sessionId === sessionId && message.protocolVersion === '1.0'
    && typeof message.requestId === 'string' && ['request', 'response', 'event', 'batch'].includes(message.kind)
    && typeof message.op === 'string' && message.op.length > 0 && Object.prototype.hasOwnProperty.call(message, 'payload')),
  'ERR_PROTOCOL_VERSION', 'structured ACK must preserve a complete session-bound bridge batch')
  check(record(state) && state.schemaVersion === 1 && state.sessionId === sessionId
    && decimal(state.templateRevision) && decimal(state.renderRevision) && decimal(state.viewRevision)
    && (state.sampleDemandRevision === undefined || decimal(state.sampleDemandRevision))
    && rendererProfiles.has(state.rendererProfile) && rendererProfiles.has(state.declaredRendererProfile)
    && ['Created', 'Active', 'Background', 'Destroyed'].includes(state.lifecycle)
    && record(state.viewport) && ['width', 'height'].every(key => Number.isSafeInteger(state.viewport[key]) && state.viewport[key] > 0 && state.viewport[key] <= 4096)
    && typeof state.requiresRestart === 'boolean'
    && (state.currentPage === null || record(state.currentPage) && decimal(state.currentPage.pageId)
      && state.currentPage.pageId !== '0' && typeof state.currentPage.path === 'string' && state.currentPage.path.length > 0 && state.currentPage.path.length <= 4096),
  'ERR_PROTOCOL_VERSION', 'structured ACK is missing its pure observed runtime state')
  check(!value.inputEnabled || (!value.requiresRestart && !state.requiresRestart && !state.executionFault
    && state.lifecycle === 'Active' && state.currentPage !== null && state.renderRevision === renderRevision
    && transportForProfile(state.rendererProfile) === 'external-frame' && !batchHasError(batch)),
  'ERR_PROTOCOL_VERSION', 'structured ACK grants input contrary to its runtime outcome')
  // Preserve all batch diagnostics/effects and all observed state fields. No
  // filtering, fake bridge response ID or replacement with latest template data.
  return freezeJson({ version: '1.0', sessionId, renderRevision, acknowledged: true,
    inputEnabled: value.inputEnabled, requiresRestart: value.requiresRestart, batch, observedState: state })
}

const OBSERVATION_CONTRACT = Object.freeze({ version: '1.0', sequence: 'u64', surfaceGeneration: '1.0', inputLifetime: '1.0' })
const RENDERER_OBSERVATION_CONTRACT = Object.freeze({ version: '2.0', sequence: 'u64', surfaceGeneration: '1.0',
  inputLifetime: '1.0', runtimeOwner: '1.0', presenterBinding: '1.0' })
const HOST_OBSERVATION_CONTRACT = Object.freeze({ version: '1.0', inputLifetime: '1.0' })
function parseObservationRequest(value) {
  if (value === undefined) return null
  check(record(value) && Object.keys(value).length === 1 && value.version === '1.0',
    'ERR_PROTOCOL_VERSION', 'observation requires the explicit version 1.0 contract')
  return OBSERVATION_CONTRACT
}
function hostObservationContract(value) {
  check(record(value) && Object.keys(value).length === 2
    && Object.keys(HOST_OBSERVATION_CONTRACT).every(key => value[key] === HOST_OBSERVATION_CONTRACT[key]),
  'ERR_PROTOCOL_VERSION', 'host is missing the hard input-lifetime observation contract 1.0')
}
/** Checked string counter; neither wrap nor Number/response arrival is ordering. */
export function nextObservationU64(value) {
  check(decimal(value) && BigInt(value) < U64_MAX, 'ERR_ENGINE', 'observation counter exhausted; create a new Worker/session')
  return (BigInt(value) + 1n).toString()
}

/** Reserve every monotonic recovery token before an irreversible native call.
 * Current render may stay unchanged for render-required, but the subsequent
 * required template publication must still have an available revision. */
export function preflightSurfaceRecoveryRevisions(expected, observationSequence) {
  return Object.freeze({ renderRevision: nextObservationU64(expected.renderRevision),
    inputLifetimeRevision: nextObservationU64(expected.inputLifetimeRevision),
    surfaceGeneration: nextObservationU64(expected.surfaceGeneration),
    observationSequence: nextObservationU64(observationSequence) })
}
/** A receiver preserves the original sequence; it never manufactures a new one. */
export function copyOrderedObservation(value, expectedOwner) {
  value = boundedJsonCopy(value)
  const state = value?.state, owner = state?.owner
  check(record(value) && value.version === '1.0' && decimal(value.sequence) && value.sequence !== '0'
    && record(state) && record(owner) && record(expectedOwner)
    && ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend'].every(key => owner[key] === expectedOwner[key])
    && identifier(owner.workerEpoch) && identifier(owner.sessionId) && digestString(owner.packSha256)
    && ['browser-view', 'external-frame'].includes(owner.transportBackend)
    && state.sessionId === owner.sessionId && state.transportBackend === owner.transportBackend
    && decimal(state.surfaceGeneration) && state.surfaceGeneration !== '0'
    && (decimal(state.inputLifetimeRevision) || state.inputLifetimeRevision === null && state.requiresRestart === true)
    && decimal(state.templateRevision) && decimal(state.renderRevision) && decimal(state.viewRevision)
    && (state.sampleDemandRevision === undefined || decimal(state.sampleDemandRevision))
    && finiteRect(state.viewport) && ['Created', 'Active', 'Background', 'Destroyed'].includes(state.lifecycle)
    && rendererProfiles.has(state.rendererProfile) && rendererProfiles.has(state.declaredRendererProfile)
    && typeof state.requiresRestart === 'boolean'
    && (state.currentPage === null || record(state.currentPage) && decimal(state.currentPage.pageId)
      && state.currentPage.pageId !== '0' && typeof state.currentPage.path === 'string' && state.currentPage.path.length > 0 && state.currentPage.path.length <= 4096),
  'ERR_PROTOCOL_VERSION', 'invalid ordered observation identity, sequence or logical lifetime')
  return freezeJson(value)
}

/** Optional v2 observations keep the actual Worker/session/pack owner stable.
 * A presenter binding is not a presented/input proof. Legacy v1 is separate. */
export function copyRendererTransitionObservation(value, expectedOwner) {
  value = boundedJsonCopy(value)
  const state = value?.state, owner = state?.owner
  check(record(value) && value.version === '2.0' && decimal(value.sequence) && value.sequence !== '0'
    && record(state) && record(owner) && record(expectedOwner) && Object.keys(owner).length === 3 && Object.keys(expectedOwner).length === 3
    && ['workerEpoch', 'sessionId', 'packSha256'].every(key => owner[key] === expectedOwner[key])
    && identifier(owner.workerEpoch) && identifier(owner.sessionId) && digestString(owner.packSha256)
    && state.sessionId === owner.sessionId && decimal(state.surfaceGeneration) && state.surfaceGeneration !== '0'
    && (decimal(state.inputLifetimeRevision) || state.inputLifetimeRevision === null && state.requiresRestart === true)
    && decimal(state.templateRevision) && decimal(state.renderRevision) && decimal(state.viewRevision)
    && (state.sampleDemandRevision === undefined || decimal(state.sampleDemandRevision))
    && finiteRect(state.viewport) && ['Created', 'Active', 'Background', 'Destroyed'].includes(state.lifecycle)
    && rendererProfiles.has(state.rendererProfile) && rendererProfiles.has(state.declaredRendererProfile)
    && typeof state.requiresRestart === 'boolean' && typeof state.transitionRequired === 'boolean'
    && (state.currentPage === null || record(state.currentPage) && decimal(state.currentPage.pageId)
      && state.currentPage.pageId !== '0' && typeof state.currentPage.path === 'string'
      && state.currentPage.path.length > 0 && state.currentPage.path.length <= 4096),
  'ERR_PROTOCOL_VERSION', 'invalid renderer-transition observation or stable runtime owner')
  const binding = copyWorkerPresenterBinding(state.presenterBinding, owner.sessionId)
  check(state.transportBackend === binding.transportBackend
    && state.transitionRequired === !!(state.currentPage && transportForProfile(state.rendererProfile) !== binding.transportBackend),
  'ERR_PROTOCOL_VERSION', 'renderer binding and required family disagree')
  return freezeJson(value)
}

/** Validate a presenter attachment without rewriting the original load receipt.
 * The runtime owner is stable; the derived owner scopes local GPU/DOM resources
 * to one admitted native presenter generation. This is not a presented proof. */
export function copyWorkerPresenterAttachment(value, loadResult, expectedOwner) {
  value = boundedJsonCopy(value)
  const fields = ['version', 'runtimeOwner', 'presenterBinding', 'observation']
  check(record(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
    && value.version === '1.0' && record(loadResult) && record(loadResult.rendererTransitions)
    && Object.keys(loadResult.rendererTransitions).length === Object.keys(WORKER_RENDERER_TRANSITION_CONTRACT).length
    && Object.keys(WORKER_RENDERER_TRANSITION_CONTRACT).every(key => loadResult.rendererTransitions[key] === WORKER_RENDERER_TRANSITION_CONTRACT[key])
    && record(value.runtimeOwner) && record(loadResult.runtimeOwner)
    && Object.keys(value.runtimeOwner).length === 3 && Object.keys(loadResult.runtimeOwner).length === 3
    && ['workerEpoch', 'sessionId', 'packSha256'].every(key => value.runtimeOwner[key] === loadResult.runtimeOwner[key])
    && value.runtimeOwner.packSha256 === loadResult.pack?.indexSha256,
  'ERR_PROTOCOL_VERSION', 'presenter attachment requires the original negotiated load and stable runtime owner')
  const observation = copyRendererTransitionObservation(value.observation, value.runtimeOwner)
  const binding = copyWorkerPresenterBinding(value.presenterBinding, value.runtimeOwner.sessionId)
  check(Object.keys(binding).every(key => binding[key] === observation.state.presenterBinding[key])
    && !observation.state.transitionRequired && !observation.state.requiresRestart,
  'ERR_PROTOCOL_VERSION', 'presenter attachment must name a committed current native binding')
  const owner = { ...value.runtimeOwner, transportBackend: binding.transportBackend, presenterGeneration: binding.generation }
  if (expectedOwner !== undefined) check(record(expectedOwner) && Object.keys(expectedOwner).length === 5
    && Object.keys(owner).every(key => expectedOwner[key] === owner[key]),
  'ERR_PROTOCOL_VERSION', 'presenter attachment belongs to another resource generation')
  return freezeJson({ ...value, observation, presenterBinding: binding, owner })
}

/** Preserve v2 observations on presenter receivers; never relabel them as v1. */
export function copyWorkerPresenterObservation(value, expectedOwner) {
  if (expectedOwner?.presenterGeneration === undefined) return copyOrderedObservation(value, expectedOwner)
  const runtimeOwner = Object.fromEntries(['workerEpoch', 'sessionId', 'packSha256'].map(key => [key, expectedOwner[key]]))
  const next = copyRendererTransitionObservation(value, runtimeOwner), binding = next.state.presenterBinding
  check(binding.generation === expectedOwner.presenterGeneration && binding.transportBackend === expectedOwner.transportBackend,
    'ERR_PROTOCOL_VERSION', 'presenter observation belongs to a retired binding')
  return next
}

function finiteMilliseconds(value, fallback, maximum, label) {
  const result = value ?? fallback
  check(Number.isSafeInteger(result) && result > 0 && result <= maximum, 'ERR_INVALID_REQUEST', `${label} must be a finite positive integer <= ${maximum}`)
  return result
}

function logicalViewport(value = { width: 375, height: 667 }) {
  check(record(value) && ['width', 'height'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= 4096),
    'ERR_RENDER', 'logical viewport must contain width/height between 1 and 4096')
  return { x: 0, y: 0, width: value.width, height: value.height }
}

// Preflight only; the native exact-revision target remains the sole authority
// for presenter allocation. Never use this estimate to relabel a frame.
function validateRenderScale(size, scale) {
  check(Number.isFinite(scale) && scale > 0 && scale <= 4, 'ERR_RENDER', 'render scale requires a finite density in 0..4')
  const width = Math.ceil(size.width * scale), height = Math.ceil(size.height * scale)
  check(width <= 4096 && height <= 4096 && width * height * 4 <= 16 * 1024 * 1024,
    'ERR_RENDER', 'physical target exceeds the external presentation budget')
  return scale
}

/** Worker clocks use Unix epoch nanoseconds, never RAF's relative timestamp. */
export function workerUnixNanos(nowMilliseconds) {
  check(Number.isSafeInteger(nowMilliseconds) && nowMilliseconds >= 0, 'ERR_ENGINE', 'invalid Unix millisecond clock')
  const value = BigInt(nowMilliseconds) * 1000000n
  check(value <= U64_MAX, 'ERR_ENGINE', 'Unix timer clock exceeds u64 nanoseconds')
  return value
}

function canonicalJson(value, depth = 0) {
  check(depth <= 128, 'ERR_INVALID_MANIFEST', 'manifest nesting exceeds the canonicalization budget')
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`
  check(record(value), 'ERR_INVALID_MANIFEST', 'manifest contains an invalid JSON value')
  // Packer/Rust order UTF-8 bytes; JS's default UTF-16 ordering differs for
  // supplementary characters. Preserve the actual manifest root algorithm.
  const keys = Object.keys(value).map(key => ({ key, bytes: encoder.encode(key) }))
  keys.sort((a, b) => {
    for (let index = 0; index < Math.min(a.bytes.length, b.bytes.length); index++) {
      if (a.bytes[index] !== b.bytes[index]) return a.bytes[index] - b.bytes[index]
    }
    return a.bytes.length - b.bytes.length
  })
  return `{${keys.map(({ key }) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(',')}}`
}

async function defaultSha256(bytes) {
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason || fail('ERR_CANCELLED', 'Worker operation was cancelled'))
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}

function staticUrl(input, base, origin) {
  const url = new URL(input, base)
  check(['http:', 'https:'].includes(url.protocol) && url.origin === origin && !url.username && !url.password && !url.hash,
    'ERR_PERMISSION_DENIED', 'Worker pack URLs must be same-origin static HTTP(S) resources')
  let path = url.pathname
  for (let count = 0; count < 3; count++) {
    const decoded = decodeURIComponent(path)
    if (decoded === path) break
    path = decoded
  }
  check(!path.replaceAll('\\', '/').split('/').includes('api'), 'ERR_PERMISSION_DENIED', 'Worker pack loading cannot access a runtime /api endpoint')
  return url
}

const FONT_CACHE_NAME = 'weapp-container-showcase-font-v1'
async function readBounded(fetchResource, url, { signal, limit, expected, budget, onError, cacheable = false, verifyCachedBytes }) {
  if (signal.aborted) throw signal.reason || fail('ERR_CANCELLED', 'Worker pack loading was cancelled')
  // Fetch owns the signal. Await its actual terminal so an aborted pack cannot
  // leave a late response outside the download group's ownership.
  let response, cache, fromNetwork = false
  if (cacheable && globalThis.caches?.open) {
    try { cache = await globalThis.caches.open(FONT_CACHE_NAME); response = await cache.match(url.href) } catch { cache = undefined }
  }
  if (!response) {
    response = await fetchResource(url.href, { signal, redirect: 'error', credentials: 'same-origin', cache: 'default' })
    fromNetwork = true
  }
  const chunks = []
  let length = 0, completed = false, reader = null, reading = null
  try {
    if (signal.aborted) throw signal.reason || fail('ERR_CANCELLED', 'Worker pack loading was cancelled')
    check(response.ok, 'ERR_INVALID_MANIFEST', `pack resource returned HTTP ${response.status}`)
    check(!response.redirected && (!response.url || new URL(response.url).href === url.href), 'ERR_PERMISSION_DENIED', 'pack resource redirected')
    const lengthHeader = response.headers?.get('content-length')
    if (lengthHeader !== null && lengthHeader !== undefined) {
      const length = Number(lengthHeader)
      check(Number.isSafeInteger(length) && length >= 0 && length <= limit, 'ERR_INVALID_MANIFEST', 'pack Content-Length exceeds the resource budget')
    }
    check(typeof response.body?.getReader === 'function', 'ERR_INVALID_MANIFEST', 'pack response requires a bounded readable byte stream')
    reader = response.body.getReader()
    while (true) {
      reading = Promise.resolve(reader.read())
      const result = await abortable(reading, signal)
      reading = null
      if (result.done) { completed = true; break }
      check(result.value instanceof Uint8Array, 'ERR_INVALID_MANIFEST', 'pack stream returned non-byte data')
      length += result.value.byteLength
      budget.bytes += result.value.byteLength
      check(length <= limit && budget.bytes <= WORKER_PACK_BUDGET && (expected === undefined || length <= expected),
        'ERR_INVALID_MANIFEST', 'pack bytes exceed their declared size or the 128 MiB budget')
      chunks.push(result.value)
    }
  } catch (error) {
    onError?.(error)
    throw error
  } finally {
    if (!completed) {
      // Preserve the original failure, but settle both the pending read and
      // underlying cancellation before this owned resource is released.
      await Promise.allSettled([
        Promise.resolve().then(() => reader ? reader.cancel() : response.body?.cancel?.()),
        ...(reading ? [reading] : []),
      ])
    }
    try { reader?.releaseLock() } catch (error) { if (completed) throw error }
  }
  check(expected === undefined || length === expected, 'ERR_INVALID_MANIFEST', 'pack resource differs from its declared size')
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  if (cacheable) {
    try { await verifyCachedBytes(bytes) } catch (error) { await cache?.delete(url.href).catch(() => {}); throw error }
    if (cache && fromNetwork && !signal.aborted) await cache.put(url.href, new Response(bytes, { headers: { 'content-length': String(bytes.length), 'content-type': 'font/ttf' } })).catch(() => {})
  }
  return bytes
}

async function verifiedPack(options, dependencies, signal) {
  const { fetchResource, sha256, baseUrl } = dependencies
  const base = new URL(baseUrl)
  const indexUrl = staticUrl(options.indexUrl ?? './pack-index.json', base, base.origin)
  const budget = { bytes: 0 }
  const indexBytes = await readBounded(fetchResource, indexUrl, { signal, limit: INDEX_LIMIT, expected: options.indexSize, budget })
  const indexSha256 = await abortable(sha256(indexBytes), signal)
  if (options.indexSha256 !== undefined) check(digestString(options.indexSha256) && options.indexSha256 === indexSha256, 'ERR_INVALID_MANIFEST', 'pack index hash differs from the supplied pin')
  const index = JSON.parse(decoder.decode(indexBytes))
  check(record(index) && index.schemaVersion === 1 && typeof index.manifest === 'string' && digestString(index.manifestSha256) && digestString(index.integrityRoot),
    'ERR_INVALID_MANIFEST', 'invalid pack index')
  check(Array.isArray(index.blobs) && index.blobs.length <= MAX_BLOBS, 'ERR_INVALID_MANIFEST', 'pack blob count exceeds its budget')
  const descriptors = new Map()
  let blobBytes = 0
  for (const blob of index.blobs) {
    check(record(blob) && digestString(blob.sha256) && typeof blob.url === 'string' && Number.isSafeInteger(blob.size) && blob.size >= 0,
      'ERR_INVALID_MANIFEST', 'invalid content-addressed blob descriptor')
    check(!descriptors.has(blob.sha256), 'ERR_INVALID_MANIFEST', 'duplicate blob address')
    blobBytes += blob.size
    check(blobBytes <= WORKER_PACK_BUDGET, 'ERR_INVALID_MANIFEST', 'declared pack blobs exceed 128 MiB')
    descriptors.set(blob.sha256, { ...blob, location: staticUrl(blob.url, indexUrl, base.origin) })
  }
  const manifestBytes = await readBounded(fetchResource, staticUrl(index.manifest, indexUrl, base.origin), {
    signal, limit: MANIFEST_LIMIT, expected: index.manifestSize, budget,
  })
  check(await abortable(sha256(manifestBytes), signal) === index.manifestSha256, 'ERR_INVALID_MANIFEST', 'manifest hash differs from pack index')
  const manifestText = decoder.decode(manifestBytes)
  const manifest = JSON.parse(manifestText)
  check(record(manifest?.integrity) && manifest.integrity.algorithm === 'sha256' && manifest.integrity.root === index.integrityRoot,
    'ERR_INVALID_MANIFEST', 'manifest integrity root differs from pack index')
  const unsigned = { ...manifest, integrity: { ...manifest.integrity, root: '' } }
  check(await abortable(sha256(encoder.encode(canonicalJson(unsigned))), signal) === index.integrityRoot,
    'ERR_INVALID_MANIFEST', 'manifest content does not match its integrity root')
  check(Array.isArray(manifest.modules) && Array.isArray(manifest.routes), 'ERR_INVALID_MANIFEST', 'manifest modules/routes are missing')
  let moduleBytes = 0
  for (const module of manifest.modules) {
    check(typeof module.id === 'string' && module.id.length > 0 && module.id.length <= 4096 && digestString(module.sha256) && descriptors.has(module.sha256),
      'ERR_INVALID_MANIFEST', 'module is missing its verified blob')
    moduleBytes += descriptors.get(module.sha256).size
  }
  // The current Rust JSON boundary expands each raw blob to numeric values.
  // Account conservatively for arrays and UTF-16 JSON before allocating them;
  // a 128 MiB download must not silently become gigabytes of transport data.
  check(blobBytes * 17 + moduleBytes * 8 + manifestBytes.byteLength * 2 + INDEX_LIMIT <= WORKER_PACK_BUDGET,
    'ERR_INVALID_MANIFEST', 'pack JSON expansion exceeds the 128 MiB initialization budget')
  const blobs = Object.create(null)
  const downloads = new AbortController(), entries = [...descriptors]
  let next = 0, failure = null
  const stop = error => {
    if (!failure) failure = error || fail('ERR_CANCELLED', 'Worker pack loading was cancelled')
    if (!downloads.signal.aborted) downloads.abort(failure)
  }
  const cancelled = () => stop(signal.reason)
  signal.addEventListener('abort', cancelled, { once: true })
  if (signal.aborted) cancelled()
  try {
    const workers = Array.from({ length: Math.min(PACK_FETCH_CONCURRENCY, entries.length) }, async () => {
      while (!downloads.signal.aborted && next < entries.length) {
        const [sha, blob] = entries[next++]
        try {
          const bytes = await readBounded(fetchResource, blob.location, { signal: downloads.signal, limit: blob.size, expected: blob.size, budget, onError: stop })
          const actual = await sha256(bytes)
          if (downloads.signal.aborted) throw downloads.signal.reason
          check(actual === sha, 'ERR_INVALID_MANIFEST', `blob integrity mismatch: ${sha}`)
          blobs[`sha256:${sha}`] = Array.from(bytes)
        } catch (error) { stop(error) }
      }
    })
    await Promise.allSettled(workers)
    if (failure) throw failure
  } finally {
    signal.removeEventListener('abort', cancelled)
  }
  const modules = manifest.modules.map(module => ({ id: module.id, bytes: blobs[`sha256:${module.sha256}`] }))
  return { manifest, manifestText, blobs, modules, provenance: { indexSha256, manifestSha256: index.manifestSha256,
    integrityRoot: index.integrityRoot, downloadedBytes: budget.bytes } }
}

function bridgeMessages(payload) {
  if (record(payload?.envelope) && payload.batch === undefined) return [payload.envelope]
  if (record(payload?.batch) && Array.isArray(payload.batch.messages) && payload.envelope === undefined) return payload.batch.messages
  throw fail('ERR_INVALID_REQUEST', 'bridge requires exactly one envelope or batch')
}

function pureBridge(payload) {
  try { const messages = bridgeMessages(payload); return messages.length > 0 && messages.every(message => PURE_BRIDGE_OPS.has(message.op)) }
  catch { return false }
}

/** One owner per actual Worker. Dependencies exist for deterministic unit tests;
 * the production entry creates exactly one real WebWasmHost in this Worker.
 * receive() never enters WASM; accepted work runs one task at a time. */
export function createWorkerRuntime({ initializeWasm, createHost, send,
  fetch: fetchResource = globalThis.fetch?.bind(globalThis), sha256 = defaultSha256,
  baseUrl = globalThis.location?.href, clock = () => Date.now(),
  monotonicClock = () => globalThis.performance.now(),
  timer = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
  timerIntervalMs = 16, postTask = globalThis.scheduler?.postTask?.bind(globalThis.scheduler) } = {}) {
  for (const [name, value] of Object.entries({ initializeWasm, createHost, send, fetchResource, sha256, clock, monotonicClock })) {
    check(typeof value === 'function', 'ERR_ENGINE', `Worker dependency ${name} is unavailable`)
  }
  check(timer && typeof timer.setTimeout === 'function' && typeof timer.clearTimeout === 'function', 'ERR_ENGINE', 'Worker timer dependency is unavailable')
  check(postTask === undefined || typeof postTask === 'function', 'ERR_ENGINE', 'Worker task dependency is unavailable')
  check([8, 16].includes(timerIntervalMs), 'ERR_INVALID_REQUEST', 'Worker timer pump supports an 8 or 16 ms interval')
  const dependencies = { fetchResource, sha256, baseUrl }
  const ordinary = [], controls = [], pending = new Map()
  const outstandingEvents = new Map(), acknowledgedEvents = new Set()
  let identity = null, host = null, manifest = null, viewport = logicalViewport(), renderer = null
  let browserQueries = null
  let nativeServices = null, nativeRevoked = false
  let pendingRenderScale = null
  let managedRenderScale = null
  let inputTrace = null, retainedInputTiming = null
  // Business DTOs stay diagnostic-free through native validation. Only finish
  // may attach a bounded optional receipt after validating the business final.
  const resultInputTiming = new WeakMap()
  const withInputTiming = (result, diagnostic) => {
    resultInputTiming.set(result, diagnostic)
    return result
  }
  let rendererPolicy = null, rendererRestart = null, externalPresentation = null, surfaceRecovery = null
  let rendererTransitions = null, presenterBinding = null, presenterFrameExport = null, rendererBindingFault = null
  let observationContract = null, observationLive = false, observationOwner = null, latestObservation = null
  let observationSequence = '0', surfaceGeneration = '0', observationSignature = null, hardSignature = null, pendingObservationFault = null
  let phase = 'new', runtimeFault = null, workerFault = null, running = null, closeEntry = null, closeRequested = false
  let drainHandle = null, timerHandle = null, timerPending = false, preferTimer = false
  let bridgeSequence = 0, eventSequence = 0, frameSequence = 0, lastDirty = null, launched = false
  let inFlightBytes = 0, channelFailed = false
  let normalEventCount = 0, normalEventBytes = 0, criticalEventSent = false, lastMonotonic = null

  function monotonicNow() {
    const now = monotonicClock()
    check(Number.isFinite(now) && now >= 0 && (lastMonotonic === null || now >= lastMonotonic),
      'ERR_ENGINE', 'Worker monotonic clock must return finite nondecreasing milliseconds')
    lastMonotonic = now
    return now
  }

  function post(message, transfers) {
    if (channelFailed) return
    try { send(message, transfers) }
    catch (error) {
      // No reliable reply remains possible. Still run owned cleanup on the
      // serialized lane, including if the failed post was the close receipt.
      channelFailed = true; closeRequested = true; stopTimers()
      if (!closeEntry) closeEntry = { message: { op: 'close', payload: {} }, controller: new AbortController(), reservedBytes: 0 }
      if (running && !running.timer && running.message.op === 'load') running.controller.abort(error)
      scheduleDrain()
      throw error
    }
  }

  function reply(entry, payload, transfers = []) {
    if (channelFailed) return
    measureWorkerPayload(payload, workerFrameResponseLimits(entry.message.op, payload, { maxBytes: MESSAGE_LIMIT, transfers }))
    post({ version: WORKER_PROTOCOL_VERSION, workerEpoch: entry.message.workerEpoch, sessionId: entry.message.sessionId,
      requestId: entry.message.requestId, kind: 'response', op: entry.message.op, payload }, transfers)
  }
  function eventEnvelope(op, payload) {
    check(eventSequence < Number.MAX_SAFE_INTEGER, 'ERR_ENGINE', 'Worker event sequence exhausted')
    return { version: WORKER_PROTOCOL_VERSION, ...identity, requestId: `worker-event-${++eventSequence}`, kind: 'event', op, payload }
  }
  function sendEvent(message, bytes, critical = false, transfers = []) {
    outstandingEvents.set(message.requestId, { bytes, critical })
    if (!critical) { normalEventCount++; normalEventBytes += bytes }
    try { post(message, transfers) }
    catch (error) {
      outstandingEvents.delete(message.requestId)
      if (!critical) { normalEventCount--; normalEventBytes -= bytes }
      throw error
    }
  }
  function event(op, payload) {
    if (!identity || channelFailed) return
    let bytes = null, message = eventEnvelope(op, payload), wire
    try {
      wire = packHostApiWire(payload)
      message = { ...message, payload: wire.value }
      // Measure the entire envelope, including its exact event ID. A larger
      // bounded measurement budget lets an oversized event report its actual
      // byte cost without ever granting it normal output credit.
      bytes = measureWorkerPayload(message, { maxBytes: 256 * 1024 * 1024 })
      check(bytes <= WORKER_EVENT_LIMITS.bytes && normalEventCount < WORKER_EVENT_LIMITS.count
        && bytes <= WORKER_EVENT_LIMITS.bytes - normalEventBytes,
      'ERR_RPC_BACKPRESSURE', 'Worker event output credit is exhausted')
    } catch (error) {
      // Packing may reject metadata before the larger diagnostic measurement.
      // Preserve the old bounded byte accounting for an oversized JSON event;
      // this never grants credit or posts the rejected original payload.
      if (bytes === null) {
        try { bytes = measureWorkerPayload(message, { maxBytes: 256 * 1024 * 1024 }) } catch { /* Invalid or over-budget graphs have no exact bounded size. */ }
      }
      const failure = fail('ERR_RPC_BACKPRESSURE', 'Worker cannot deliver a runtime event within its bounded output credit',
        { undelivered: { op, bytes }, cause: diagnostic(error).code })
      markFault(failure, 'owner', { undelivered: { op, bytes } })
      throw failure
    }
    sendEvent(message, bytes, false, wire.transfer)
  }
  function startupBatch(batch) {
    // Startup has no admitted public observation yet. Label the exception only
    // on the opt-in wire; never mint or borrow a live sequence for app.init.
    check(!observationLive && running && !running.timer && running.message.op === 'load', 'ERR_ENGINE', 'startup batch escaped load admission')
    event('batch', observationContract ? { ...batch, phase: 'startup' } : batch)
  }
  function liveBatch(batch, observation) {
    check(observationLive && observation === latestObservation, 'ERR_ENGINE', 'live batch needs its actual same-turn observation')
    event('batch', { ...batch, phase: 'live', observation })
  }
  function acknowledgeEvents(payload) {
    const ids = payload.eventIds
    check(Object.keys(payload).length === 1 && Array.isArray(ids) && ids.length >= 1 && ids.length <= WORKER_EVENT_LIMITS.count
      && ids.every(id => identifier(id, 192)) && new Set(ids).size === ids.length,
    'ERR_INVALID_REQUEST', 'events.ack requires 1..64 unique event IDs')
    // Validate the whole batch before releasing any credit. Remember a bounded
    // set of acknowledged IDs for retries; unknown/future IDs never mint credit.
    check(ids.every(id => outstandingEvents.has(id) || acknowledgedEvents.has(id)),
      'ERR_INVALID_REQUEST', 'events.ack contains an unknown or expired event ID')
    for (const id of ids) {
      const entry = outstandingEvents.get(id)
      if (!entry) continue
      outstandingEvents.delete(id)
      if (!entry.critical) { normalEventCount--; normalEventBytes -= entry.bytes }
      acknowledgedEvents.add(id)
      if (acknowledgedEvents.size > 128) acknowledgedEvents.delete(acknowledgedEvents.values().next().value)
    }
    return { acknowledged: ids.slice(), pendingCount: outstandingEvents.size,
      pendingBytes: [...outstandingEvents.values()].reduce((sum, entry) => sum + entry.bytes, 0) }
  }
  function stopTimers() {
    if (timerHandle !== null) timer.clearTimeout(timerHandle)
    timerHandle = null; timerPending = false
  }
  function markFault(error, origin = 'owner', extra = {}) {
    if (origin === 'runtime') runtimeFault ??= diagnostic(error)
    else workerFault ??= diagnostic(error)
    phase = 'faulted'; stopTimers()
    // One separate, small fault slot remains available when normal event
    // credit is saturated. Never recurse through event() or retain an output
    // backlog, and never label an owner transport failure as an engine fault.
    const fault = origin === 'runtime' ? runtimeFault : workerFault
    announceFault({ error: { code: String(fault.code).slice(0, 128),
      message: String(fault.message).slice(0, 4096) }, origin, requiresRestart: true, ...extra })
  }
  function announceFault(payload) {
    // Opt-in host calls finish their pure state refresh on this same lane
    // before the one reserved fault publication; no duplicate fault event.
    if (observationLive) { pendingObservationFault ??= payload; return }
    publishFault(payload)
  }
  function flushObservationFault() {
    if (!pendingObservationFault) return
    const payload = pendingObservationFault
    pendingObservationFault = null
    publishFault({ ...payload, ...(latestObservation ? { observation: latestObservation } : {}) })
  }
  function preserveTimerFailure(batch, originalError, refreshError, failed, publicationCompleted) {
    if (!observationLive || !pendingObservationFault) return
    const fault = pendingObservationFault
    // A timer has no RPC final. Preserve its actual returned batch and original
    // failure here, not as a fake normal batch with an old observation. The
    // reserved publication below explicitly reports any budget-driven omission.
    const details = { ...(record(fault.error?.details) ? fault.error.details : {}),
      ...(!failed ? {} : { timerError: diagnostic(originalError),
        ...(originalError?.details === undefined ? {} : { originalDetails: originalError.details }) }),
      ...(batch === undefined ? {} : { committedResult: batch }),
      ...(refreshError === undefined ? {} : { observationRefreshError: diagnostic(refreshError) }) }
    pendingObservationFault = { ...fault, error: { ...fault.error, details }, timerTurn: {
      version: '1.0', effectDelivery: 'unconfirmed', publicationCompleted, committedResult: batch === undefined ? 'unavailable' : 'retained',
    } }
  }
  function boundedTimerFault(message, budgetError) {
    const payload = message.payload
    const timerTurn = { version: '1.0', effectDelivery: 'unconfirmed', publicationCompleted: payload.timerTurn.publicationCompleted,
      committedResult: payload.timerTurn.committedResult === 'unavailable' ? 'unavailable' : 'omitted',
      errorDetails: 'omitted', omissionCode: diagnostic(budgetError).code }
    const minimal = {
      origin: payload.origin, requiresRestart: true,
      error: { code: String(payload.error?.code ?? 'ERR_ENGINE').slice(0, 128),
        message: String(payload.error?.message ?? 'Worker timer turn failed').slice(0, 4096) },
    }
    const reduced = { ...message, payload: { ...minimal,
      ...(payload.undelivered ? { undelivered: payload.undelivered } : {}),
      ...(payload.observation ? { observation: payload.observation } : {}), timerTurn,
    } }
    try { return { message: reduced, bytes: measureWorkerPayload(reduced, { maxBytes: WORKER_EVENT_LIMITS.criticalBytes }) } }
    catch (observationError) {
      // An unusually large pure state cannot consume the sole freeze slot.
      // First retry the original result/error without that state: a small real
      // committed batch must not be lost just because the observation is large.
      const { observation, ...withoutObservation } = payload
      const omission = { observation: 'omitted', observationOmissionCode: diagnostic(observationError).code,
        ...(observation ? { lastObservationSequence: observation.sequence } : {}) }
      const resultOnly = { ...message, payload: { ...withoutObservation, timerTurn: { ...payload.timerTurn, ...omission } } }
      try { return { message: resultOnly, bytes: measureWorkerPayload(resultOnly, { maxBytes: WORKER_EVENT_LIMITS.criticalBytes }) } }
      catch {
        // Both optional evidence bodies exceed the fixed slot (or cannot be
        // serialized as plain data). Keep only bounded original error identity
        // and explicit evidence/delivery uncertainty; never mint a snapshot.
        const bounded = { ...message, payload: { ...minimal, timerTurn: { ...timerTurn, ...omission } } }
        return { message: bounded, bytes: measureWorkerPayload(bounded, { maxBytes: WORKER_EVENT_LIMITS.criticalBytes }) }
      }
    }
  }
  function publishFault(payload) {
    if (!identity || channelFailed || criticalEventSent) return
    let message = eventEnvelope('fault', payload), bytes
    try { bytes = measureWorkerPayload(message, { maxBytes: WORKER_EVENT_LIMITS.criticalBytes }) }
    catch (budgetError) {
      // Legacy wire semantics remain unchanged. Only an opt-in timer diagnostic
      // may shed its retained result/details, with explicit delivery uncertainty.
      if (!observationLive || payload.timerTurn?.version !== '1.0') throw budgetError
      const bounded = boundedTimerFault(message, budgetError); message = bounded.message; bytes = bounded.bytes
    }
    criticalEventSent = true
    sendEvent(message, bytes, true)
  }
  function rendererRestartError() {
    return fail('ERR_UNSUPPORTED_CAPABILITY', 'active route requires another renderer transport; explicitly restart with a new session', rendererRestart)
  }
  function observeRendererPolicy(state) {
    if (!rendererPolicy) return
    check(state.transportBackend === renderer && sameRendererPolicy(state.rendererPolicy, rendererPolicy),
      'ERR_ENGINE', 'Worker host did not honor the explicit renderer policy/transport contract')
    const path = state.currentPage?.path ?? ''
    if (state.currentPage) check(path.length <= 4096 && manifest.routes.some(route => route.path === path),
      'ERR_ENGINE', 'host active route is absent from the verified manifest')
    const declared = declaredProfileForRoute(manifest, path)
    const effective = rendererPolicy.mode === 'force' ? rendererPolicy.profile : declared
    check(state.declaredRendererProfile === declared && state.rendererProfile === effective,
      'ERR_ENGINE', 'host renderer profiles differ from the explicit policy and verified manifest')
    // Before app.init the default profile can differ from the requested route.
    // Validate the semantic contract then, but defer family admission until a
    // real page is active; the route selection must not be replaced by default.
    if (!state.currentPage) return
    if (runtimeFault || workerFault || rendererRestart || transportForProfile(effective) === renderer || rendererTransitions) return
    rendererRestart = { reason: 'renderer-profile-change', transportBackend: renderer,
      requiredTransportBackend: transportForProfile(effective), declaredProfile: declared, effectiveProfile: effective,
      routePath: path, pageId: state.currentPage.pageId, rendererPolicy }
    phase = 'restart-required'; stopTimers()
    // A policy transition is not an engine interruption or an automatic reload.
    // The same reserved fault slot freezes page consumers even if normal credit
    // is full. Keep the committed page and session available to diagnostics.
    announceFault({ origin: 'policy', error: diagnostic(rendererRestartError()), requiresRestart: true,
      reason: rendererRestart.reason, restartRequired: rendererRestart })
  }
  function nativeRuntimeState(observedState) {
    check(host && typeof host.runtime_state_json === 'function', 'ERR_ENGINE', 'Worker host is missing the read-only runtime_state_json contract')
    const state = observedState ?? JSON.parse(host.runtime_state_json())
    check(state?.schemaVersion === 1 && state.sessionId === identity.sessionId && decimal(state.viewRevision) && decimal(state.renderRevision)
      && decimal(state.templateRevision) && (state.sampleDemandRevision === undefined || decimal(state.sampleDemandRevision)) && ['skia', 'skyline-compat', 'webview'].includes(state.rendererProfile)
      && ['skia', 'skyline-compat', 'webview'].includes(state.declaredRendererProfile)
      && ['Created', 'Active', 'Background', 'Destroyed'].includes(state.lifecycle)
      && record(state.viewport) && ['width', 'height'].every(key => Number.isSafeInteger(state.viewport[key]) && state.viewport[key] > 0 && state.viewport[key] <= 4096)
      && (state.currentPage === null || (record(state.currentPage) && decimal(state.currentPage.pageId) && typeof state.currentPage.path === 'string')),
    'ERR_ENGINE', 'Worker host returned an invalid runtime state')
    return state
  }
  function runtimeState(observedState) {
    const state = nativeRuntimeState(observedState)
    if (rendererBindingFault) {
      // Diagnostic state is intentionally distinct from an admitted v2
      // observation: native commit may have occurred, but no new binding was
      // accepted. Report both facts, without minting input or an observation.
      return { ...state, presenterBindingStatus: 'uncertain', runtimeOwner: observationOwner,
        acceptedPresenterBinding: presenterBinding, nativeObservedState: state,
        bindingFault: rendererBindingFault, workerFault, requiresRestart: true, inputEnabled: false }
    }
    viewport = logicalViewport(state.viewport)
    if (state.requiresRestart || state.executionFault) markFault(state.executionFault || fail('ERR_ENGINE', 'runtime requires a new session'), 'runtime')
    observeRendererPolicy(state)
    return { ...state, transportBackend: renderer, rendererPolicy,
      ...(rendererTransitions ? { presenterBinding,
        transitionRequired: !!(state.currentPage && transportForProfile(state.rendererProfile) !== renderer) } : {}),
      requiresRestart: !!state.requiresRestart || !!runtimeFault || !!workerFault || !!rendererRestart || nativeRevoked,
      ...(nativeRevoked ? { inputEnabled: false, hostIdentityRevoked: true } : {}),
      ...(rendererRestart ? { reason: rendererRestart.reason, restartRequired: rendererRestart } : {}),
      ...(workerFault ? { workerFault } : {}) }
  }
  function captureObservation({ initial = false, emit = true } = {}) {
    if (!observationContract || !host || (!observationLive && !initial)) return null
    // A rejected native final cannot authorize a v2 binding. Keep the last
    // genuine snapshot for receipt ACKs/cleanup; only diagnostic state may
    // expose the uncertain native transport, explicitly without authority.
    if (rendererBindingFault) return latestObservation
    const native = JSON.parse(host.observation_state_json())
    check(record(native) && native.version === '1.0' && (decimal(native.inputLifetimeRevision) || native.inputLifetimeRevision === null),
      'ERR_PROTOCOL_VERSION', 'host returned an invalid input-lifetime observation')
    if (native.inputLifetimeRevision === null && !workerFault) {
      markFault(fail('ERR_ENGINE', 'native input lifetime exhausted; create a new session'), 'owner')
    }
    const state = runtimeState(native.state)
    const logical = logicalViewport(state.viewport)
    const hard = JSON.stringify([state.currentPage?.pageId ?? null, state.currentPage?.path ?? null,
      logical.x, logical.y, logical.width, logical.height, state.lifecycle === 'Active', native.inputLifetimeRevision])
    const signature = JSON.stringify([state, native.inputLifetimeRevision])
    if (signature === observationSignature) return latestObservation
    const generation = hardSignature === hard ? surfaceGeneration : nextObservationU64(surfaceGeneration)
    const sequence = nextObservationU64(observationSequence)
    const copyObservation = rendererTransitions ? copyRendererTransitionObservation : copyOrderedObservation
    const next = copyObservation({ version: rendererTransitions ? '2.0' : '1.0', sequence, state: { ...state,
      owner: observationOwner, surfaceGeneration: generation, inputLifetimeRevision: native.inputLifetimeRevision,
      viewport: logical,
    } }, observationOwner)
    // Commit both checked counters only after the complete snapshot validates.
    observationSequence = sequence; surfaceGeneration = generation
    hardSignature = hard; observationSignature = signature; latestObservation = next
    if (emit && observationLive && !runtimeFault && !workerFault && !rendererRestart) {
      event('dirty', { currentPage: state.currentPage, viewRevision: state.viewRevision,
        templateRevision: state.templateRevision, renderRevision: state.renderRevision,
        viewport: state.viewport, lifecycle: state.lifecycle, rendererProfile: state.rendererProfile,
        declaredRendererProfile: state.declaredRendererProfile, requiresRestart: false, observation: next })
    }
    return next
  }
  function validateSurfaceOperation(operation, payload) {
    if (!observationLive || renderer !== 'browser-view') return
    const keyed = new Set(['view.prepare', 'view.prepare.commit', 'view.presented', 'view.geometry', 'view.events', 'view.query.result', 'view.animation.baseline', 'view.sample.prepare', 'view.sample.presented'])
    if (!keyed.has(operation)) return // Exact abort/retire remains available for cleanup.
    const state = latestObservation?.state
    const key = operation === 'view.sample.prepare' ? payload?.baseKey : operation === 'view.sample.presented' ? payload?.permit?.key : payload?.key
    const generation = operation === 'view.prepare' ? payload?.surfaceGeneration : key?.surfaceGeneration
    check(state && state.lifecycle === 'Active' && state.currentPage !== null
      && decimal(generation) && generation === state.surfaceGeneration,
    'ERR_CANCELLED', 'DOM operation belongs to a retired logical surface generation')
    if (operation !== 'view.prepare') check(key?.sessionId === identity.sessionId
      && key.pageId === state.currentPage.pageId && key.profile === 'webview',
    'ERR_CANCELLED', 'DOM key belongs to another current page/session')
  }
  function requirePresenterContext(context) {
    if (!rendererTransitions) return
    const observed = captureObservation(), state = observed?.state
    check(record(context) && Object.keys(context).length === 4 && record(context.presenterBinding)
      && decimal(context.pageId) && decimal(context.inputLifetimeRevision) && decimal(context.surfaceGeneration),
    'ERR_PROTOCOL_VERSION', 'negotiated presenter operation requires its exact presentationContext')
    const binding = copyWorkerPresenterBinding(context.presenterBinding, identity.sessionId)
    check(state && !state.requiresRestart && !state.transitionRequired && state.lifecycle === 'Active'
      && context.pageId === state.currentPage?.pageId && context.inputLifetimeRevision === state.inputLifetimeRevision
      && context.surfaceGeneration === state.surfaceGeneration && binding.generation === presenterBinding.generation
      && binding.transportBackend === renderer,
    'ERR_CANCELLED', 'presenter operation belongs to an old page, renderer binding or input lifetime')
  }
  function hasCurrentPresenterFrame(renderRevision) {
    if (!rendererTransitions) return true
    const state = latestObservation?.state, exported = presenterFrameExport
    return !!(state && exported && !state.transitionRequired && !state.requiresRestart && state.lifecycle === 'Active'
      && exported.generation === presenterBinding.generation && exported.pageId === state.currentPage?.pageId
      && exported.inputLifetimeRevision === state.inputLifetimeRevision && exported.surfaceGeneration === state.surfaceGeneration
      && (renderRevision === undefined || exported.renderRevision === renderRevision))
  }

  function transitionRenderer(payload) {
    ensureHealthy()
    check(rendererTransitions && observationLive, 'ERR_PROTOCOL_VERSION', 'renderer transitions were not explicitly negotiated')
    check(record(payload) && Object.keys(payload).length === 2 && payload.version === '1.0' && record(payload.expected),
      'ERR_PROTOCOL_VERSION', 'renderer.transition requires version and exact expected input')
    const expected = boundedJsonCopy(payload.expected)
    const keys = ['sessionId', 'pageId', 'routePath', 'rendererProfile', 'inputLifetimeRevision',
      'presenterGeneration', 'transportBackend', 'surfaceGeneration']
    check(Object.keys(expected).length === keys.length && keys.every(key => Object.hasOwn(expected, key))
      && expected.sessionId === identity.sessionId && typeof expected.routePath === 'string'
      && expected.routePath.length > 0 && expected.routePath.length <= 4096
      && ['pageId', 'inputLifetimeRevision', 'presenterGeneration', 'surfaceGeneration'].every(key => decimal(expected[key]))
      && expected.pageId !== '0' && expected.presenterGeneration !== '0' && expected.surfaceGeneration !== '0'
      && rendererProfiles.has(expected.rendererProfile)
      && ['browser-view', 'external-frame'].includes(expected.transportBackend),
    'ERR_PROTOCOL_VERSION', 'renderer transition expected input is malformed')
    const before = captureObservation(), state = before?.state
    check(state && state.lifecycle === 'Active' && !state.requiresRestart && state.transitionRequired
      && state.currentPage?.pageId === expected.pageId && state.currentPage.path === expected.routePath
      && ['rendererProfile', 'inputLifetimeRevision', 'surfaceGeneration'].every(key => state[key] === expected[key])
      && presenterBinding.generation === expected.presenterGeneration && renderer === expected.transportBackend,
    'ERR_CANCELLED', 'renderer transition no longer names the actual pending page and binding')
    // Reserve every counter before irreversible native cancellation hooks.
    const nextGeneration = nextObservationU64(presenterBinding.generation)
    const nextInput = nextObservationU64(expected.inputLifetimeRevision)
    nextObservationU64(observationSequence); nextObservationU64(surfaceGeneration)
    const { surfaceGeneration: _surfaceGeneration, ...nativeExpected } = expected
    // A native throw keeps its original diagnostic. Retirement may already
    // have revoked input; the ordinary finally observation exposes that state.
    // A returned-but-malformed final is different: native commit is uncertain,
    // so fault the owner rather than accepting another presentation operation.
    const text = host.transition_renderer_json(JSON.stringify({ version: '1.0', expected: nativeExpected }))
    const acceptedBinding = presenterBinding, acceptedRenderer = renderer
    let result
    try {
      result = JSON.parse(text)
      check(record(result) && result.version === '1.0' && typeof result.ok === 'boolean'
        && Object.keys(result).length === (result.ok ? 7 : 8)
        && ['previousPresenterBinding', 'presenterBinding', 'inputLifetimeRevision', 'batch', 'observedState'].every(key => Object.hasOwn(result, key))
        && (result.ok || Object.hasOwn(result, 'error')),
        'ERR_PROTOCOL_VERSION', 'host omitted the original renderer transition final')
      const previous = copyWorkerPresenterBinding(result.previousPresenterBinding, identity.sessionId)
      check(['version', 'sessionId', 'generation', 'transportBackend'].every(key => previous[key] === presenterBinding[key])
        && record(result.batch) && Array.isArray(result.batch.messages)
        && result.batch.messages.every(message => record(message) && message.sessionId === identity.sessionId
          && message.protocolVersion === '1.0' && typeof message.requestId === 'string'
          && ['request', 'response', 'event', 'batch'].includes(message.kind)
          && typeof message.op === 'string' && message.op.length > 0 && Object.hasOwn(message, 'payload')),
      'ERR_PROTOCOL_VERSION', 'host omitted the original renderer binding or complete session-bound effects')
      const nextBinding = copyWorkerPresenterBinding(result.presenterBinding, identity.sessionId)
      if (result.ok) {
        check(nextBinding.generation === nextGeneration && nextBinding.transportBackend === transportForProfile(expected.rendererProfile)
          && result.inputLifetimeRevision === nextInput && result.observedState?.sessionId === identity.sessionId
          && result.observedState.transportBackend === nextBinding.transportBackend
          && result.observedState.currentPage?.pageId === expected.pageId && result.observedState.currentPage.path === expected.routePath
          && result.observedState.rendererProfile === expected.rendererProfile && result.observedState.lifecycle === 'Active'
          && result.observedState.requiresRestart === false && !result.observedState.executionFault,
        'ERR_PROTOCOL_VERSION', 'host transition final did not retain the exact page and revoke old input')
        presenterBinding = nextBinding; renderer = nextBinding.transportBackend
        presenterFrameExport = null
        pendingRenderScale = managedRenderScale
      } else check(nextBinding.generation === presenterBinding.generation && nextBinding.transportBackend === renderer
        && result.error?.code === 'ERR_CANCELLED',
      'ERR_PROTOCOL_VERSION', 'a cancelled renderer transition cannot replace the old binding')
      const batch = observeBatch(result.batch, result.observedState)
      const observedState = runtimeState(result.observedState)
      return { ...result, batch, observedState, runtimeOwner: observationOwner, inputEnabled: false }
    } catch (error) {
      // Preserve actual irreversible cancellation effects, including malformed
      // host metadata; never fabricate a successful transition or replay JS.
      const failure = fail(error.code || 'ERR_PROTOCOL_VERSION', error.message || String(error), {
        ...(error.details ?? {}), transitionFinalReceived: true,
        ...(record(result?.batch) && Array.isArray(result.batch.messages) ? { batch: result.batch } : {}),
      })
      // These are the last admitted tokens, not a rollback of native state.
      // Even validation after a proposed binding must preserve them until a
      // complete final has established the new contract.
      presenterBinding = acceptedBinding; renderer = acceptedRenderer; presenterFrameExport = null
      rendererBindingFault = freezeJson({ version: '1.0', status: 'uncertain',
        acceptedPresenterBinding: acceptedBinding, error: diagnostic(failure),
        ...(record(result?.batch) && Array.isArray(result.batch.messages) ? { batch: result.batch } : {}) })
      if (!runtimeFault && !workerFault) markFault(failure, 'owner')
      throw failure
    }
  }

  function observeState() {
    if (observationLive) return captureObservation()?.state ?? null
    if (!host) return null
    const state = runtimeState()
    // This is a state-change notification, not a command to reevaluate View.
    // Activity and paint may change independently from template input. Neither
    // this latest observation nor ACK-time state proves what a frame consumed.
    const signature = JSON.stringify([state.currentPage?.pageId, state.currentPage?.path,
      state.viewRevision, state.templateRevision, state.renderRevision,
      state.viewport.width, state.viewport.height, state.lifecycle,
      state.rendererProfile, state.declaredRendererProfile])
    if (!runtimeFault && !workerFault && !rendererRestart && signature !== lastDirty) {
      lastDirty = signature
      event('dirty', { currentPage: state.currentPage, viewRevision: state.viewRevision,
        templateRevision: state.templateRevision, renderRevision: state.renderRevision,
        viewport: state.viewport, lifecycle: state.lifecycle,
        rendererProfile: state.rendererProfile, declaredRendererProfile: state.declaredRendererProfile,
        requiresRestart: false })
    }
    return state
  }
  function observeBatch(batch, observedState) {
    check(record(batch) && Array.isArray(batch.messages), 'ERR_ENGINE', 'Worker host returned an invalid bridge batch')
    if (batch.messages.some(message => message.payload?.requiresRestart === true)) {
      const state = runtimeState(observedState)
      if (!runtimeFault && !workerFault) markFault(state.executionFault || fail('ERR_ENGINE', 'runtime interruption requires a new session'), 'runtime')
    }
    return batch
  }
  function parseBatch(text) {
    return observeBatch(JSON.parse(text))
  }
  function dispatch(op, payload, deadlineNs) {
    validateSurfaceOperation(op, payload)
    const requestId = `worker-host-${++bridgeSequence}`
    const envelope = { protocolVersion: '1.0', sessionId: identity.sessionId, requestId, kind: 'request', op, payload }
    let json = JSON.stringify(envelope)
    if (deadlineNs !== undefined) {
      check(typeof deadlineNs === 'bigint' && deadlineNs > 0n && deadlineNs <= U64_MAX,
        'ERR_ENGINE', 'Worker startup deadline exceeds canonical u64 nanoseconds')
      // serde expects a JSON u64 number, not a string. Emit only this trusted
      // BigInt decimal token; Number(ns) would lose epoch-nanosecond precision.
      json = `${json.slice(0, -1)},"deadlineNs":${deadlineNs.toString()}}`
    }
    const batch = parseBatch(host.dispatch_json(json))
    const responses = batch.messages.filter(message => message.kind === 'response' && message.sessionId === identity.sessionId && message.requestId === requestId && message.op === op)
    check(responses.length === 1, 'ERR_ENGINE', `uncorrelated Worker ${op} response`)
    return { batch, response: responses[0].payload }
  }
  function requireSuccess(result, context) {
    if (result.response?.ok !== true) throw fail(result.response?.error?.code || 'ERR_ENGINE',
      result.response?.error?.message || `${context} failed`, { batch: result.batch })
    return result
  }
  function ensureHealthy() {
    check(!nativeRevoked, 'ERR_IDENTITY_SWITCHING', 'host identity was revoked; create a fresh owner')
    if (rendererRestart && !runtimeFault && !workerFault) throw rendererRestartError()
    check(host && phase === 'ready' && !closeRequested && !runtimeFault && !workerFault, 'ERR_ENGINE',
      runtimeFault || workerFault ? 'Worker AppService requires a new session' : 'Worker runtime is not ready')
  }
  function checkCancelled(entry) {
    if (entry.controller.signal.aborted) throw entry.controller.signal.reason || fail('ERR_CANCELLED', 'Worker request cancelled')
  }
  function disposeHost(diagnostics) {
    const owned = host
    host = null
    observationLive = false
    if (!owned) return
    try { owned.unload() } catch (error) { diagnostics.push({ phase: 'unload', ...diagnostic(error) }) }
    try { owned.free() } catch (error) { diagnostics.push({ phase: 'free', ...diagnostic(error) }) }
  }
  async function load(entry) {
    const options = entry.message.payload
    check(record(options), 'ERR_INVALID_REQUEST', 'load payload must be an object')
    check((options.engine ?? 'quickjs') === 'quickjs', 'ERR_ENGINE', 'the Worker requires the real bounded QuickJS provider')
    const requestedRendererPolicy = parseRendererPolicy(options.rendererPolicy)
    const requestedExternalPresentation = parseExternalPresentationRequest(options.externalPresentation)
    const requestedObservation = parseObservationRequest(options.observation)
    const requestedRendererTransitions = parseRendererTransitions(options.rendererTransitions)
    const requestedSurfaceRecovery = surfaceRecoveryRequest(options.surfaceRecovery)
    const requestedBrowserQueries = browserQueriesRequest(options.browserQueries)
    check(!requestedRendererTransitions || requestedRendererPolicy?.mode === 'manifest'
      && requestedObservation && requestedExternalPresentation && options.inputTiming === undefined,
    'ERR_PROTOCOL_VERSION', 'rendererTransitions requires manifest policy, observation and externalPresentation; causal input timing is not negotiated for mixed owners')
    check(options.inputTiming === undefined || inputTimingRequestValid(options.inputTiming), 'ERR_PROTOCOL_VERSION', 'unsupported input timing contract')
    check(options.inputTiming === undefined || requestedExternalPresentation && requestedObservation,
      'ERR_PROTOCOL_VERSION', 'input timing requires ordered external presentation')
    const scaleContract = options.renderScaleContract
    check(scaleContract === undefined || record(scaleContract) && Object.keys(scaleContract).length === 1 && scaleContract.version === '1.0',
      'ERR_PROTOCOL_VERSION', 'unsupported render scale contract')
    check(options.renderScale === undefined || scaleContract?.version === '1.0', 'ERR_PROTOCOL_VERSION',
      'initial density requires render scale contract 1.0')
    check(!scaleContract || requestedExternalPresentation, 'ERR_PROTOCOL_VERSION',
      'initial physical render scale requires the exact external presentation target contract')
    check(!requestedSurfaceRecovery || (requestedExternalPresentation && requestedObservation),
      'ERR_PROTOCOL_VERSION', 'surfaceRecovery requires externalPresentation and ordered observation negotiation')
    let selected = requestedRendererPolicy ? null : options.renderer ?? 'browser-view'
    if (requestedRendererPolicy) {
      check(options.renderer === undefined || options.renderer === 'auto', 'ERR_INVALID_REQUEST', 'explicit rendererPolicy selects its transport; renderer may only be auto')
    } else check(['browser-view', 'external-frame'].includes(selected), 'ERR_RENDER', 'Worker renderer must be browser-view or external-frame')
    const size = logicalViewport(options.viewport)
    // A complete observation belongs to this new native owner before any guest
    // module executes. Never turn the layout-only viewport/default density into
    // a display snapshot. Rust validates the retained typed display fields.
    let initialDisplayMetrics
    if (options.metrics !== undefined) {
      check(record(options.metrics) && options.metrics.windowWidth === size.width
        && options.metrics.windowHeight === size.height, 'ERR_RENDER',
      'initial window metrics and logical viewport disagree')
      const { windowWidth: _width, windowHeight: _height, ...display } = options.metrics
      initialDisplayMetrics = display
    }
    const initialRenderScale = options.renderScale === undefined ? null : validateRenderScale(size, options.renderScale)
    const policy = options.engineExecution ?? {}
    check(record(policy), 'ERR_INVALID_REQUEST', 'engineExecution must be an object')
    const bootstrap = finiteMilliseconds(policy.bootstrapTimeoutMs, 5000, 60000, 'bootstrap timeout')
    const turn = finiteMilliseconds(policy.turnTimeoutMs, 250, 5000, 'turn timeout')
    const viewPolicy = options.viewExecution === undefined ? {} : options.viewExecution
    check(record(viewPolicy) && Object.keys(viewPolicy).every(key => key === 'batchTimeoutMs'),
      'ERR_INVALID_REQUEST', 'viewExecution must be an object containing only batchTimeoutMs')
    const viewBatch = viewPolicy.batchTimeoutMs === undefined ? 50 : viewPolicy.batchTimeoutMs
    check(Number.isSafeInteger(viewBatch) && viewBatch > 0 && viewBatch <= 5000,
      'ERR_INVALID_REQUEST', 'View batch timeout must be a finite positive integer <= 5000')
    const loadTimeout = finiteMilliseconds(options.loadTimeoutMs, 30000, 120000, 'load timeout')
    if (options.indexSize !== undefined) check(Number.isSafeInteger(options.indexSize) && options.indexSize >= 0 && options.indexSize <= INDEX_LIMIT,
      'ERR_INVALID_MANIFEST', 'invalid pinned pack index size')
    const absoluteDeadline = monotonicNow() + loadTimeout
    const expired = () => fail('ERR_TIMEOUT', 'Worker pack initialization exceeded its absolute monotonic deadline')
    function remainingMilliseconds() {
      checkCancelled(entry)
      check(!closeRequested, 'ERR_CANCELLED', 'Worker closed during initialization')
      const remaining = absoluteDeadline - monotonicNow()
      if (remaining <= 0) { const error = expired(); entry.controller.abort(error); throw error }
      return remaining
    }
    function startupStage(operation) {
      remainingMilliseconds()
      const result = operation()
      remainingMilliseconds()
      return result
    }
    function startupDispatch(op, payload) {
      return startupStage(() => {
        const remainingNs = BigInt(Math.floor(remainingMilliseconds() * 1_000_000))
        check(remainingNs > 0n, 'ERR_TIMEOUT', 'Worker startup has no execution budget remaining')
        // Convert only the remaining monotonic allowance to an absolute Unix
        // deadline for this Rust turn. Every later phase recomputes a shorter
        // allowance; post-checks still catch wall-clock changes and JS work.
        return requireSuccess(dispatch(op, payload, workerUnixNanos(clock()) + remainingNs), op)
      })
    }
    const timeout = timer.setTimeout(() => entry.controller.abort(expired()), loadTimeout)
    phase = 'loading'
    try {
      const pack = await verifiedPack(options, dependencies, entry.controller.signal)
      remainingMilliseconds()
      await abortable(initializeWasm(), entry.controller.signal)
      remainingMilliseconds()
      const route = pack.manifest.routes.find(item => item.path === options.route) || (!options.route && pack.manifest.routes[0])
      check(route && typeof route.path === 'string', 'ERR_INVALID_MANIFEST', 'requested route is absent from the verified manifest')
      if (requestedRendererPolicy) {
        const declared = declaredProfileForRoute(pack.manifest, route.path)
        selected = transportForProfile(requestedRendererPolicy.mode === 'force' ? requestedRendererPolicy.profile : declared)
      }
      check(!requestedExternalPresentation || selected === 'external-frame' || requestedRendererTransitions, 'ERR_UNSUPPORTED_CAPABILITY', 'externalPresentation requires the external-frame transport')
      check(!requestedBrowserQueries || selected === 'browser-view' || requestedRendererTransitions, 'ERR_UNSUPPORTED_CAPABILITY', 'browserQueries requires the browser-view transport')
      check(options.renderScale === undefined || selected === 'external-frame', 'ERR_UNSUPPORTED_CAPABILITY',
        'physical render scale applies only to external-frame; DOM uses browser density')
      manifest = pack.manifest; renderer = selected; rendererPolicy = requestedRendererPolicy; viewport = size
      startupStage(() => { host = createHost() })
      check(host && typeof host.runtime_state_json === 'function', 'ERR_ENGINE', 'bounded Worker host contract is unavailable')
      let textFont = null
      if (options.textFont !== undefined) {
        const descriptor = options.textFont
        check(record(descriptor) && Object.keys(descriptor).length === 5 && descriptor.version === '1.0'
          && descriptor.profile === 'sfnt-unhinted-v1' && digestString(descriptor.sha256)
          && Number.isSafeInteger(descriptor.size) && descriptor.size > 0 && descriptor.size <= TEXT_FONT_LIMIT,
        'ERR_PROTOCOL_VERSION', 'bounded pinned textFont 1.0 is required')
        check(typeof host.configure_text_font === 'function', 'ERR_PROTOCOL_VERSION', 'runtime does not implement verified text font ingress')
        const base = new URL(baseUrl), url = staticUrl(descriptor.url, base, base.origin)
        const bytes = await readBounded(fetchResource, url, { signal: entry.controller.signal, limit: TEXT_FONT_LIMIT, expected: descriptor.size, budget: { bytes: 0 }, cacheable: true,
          verifyCachedBytes: async value => check(await abortable(sha256(value), entry.controller.signal) === descriptor.sha256, 'ERR_INVALID_MANIFEST', 'text font SHA-256 differs from renderer pin') })
        check(await abortable(sha256(bytes), entry.controller.signal) === descriptor.sha256, 'ERR_INVALID_MANIFEST', 'text font SHA-256 differs from renderer pin')
        textFont = startupStage(() => JSON.parse(host.configure_text_font(bytes, descriptor.sha256)))
        check(record(textFont) && Object.keys(textFont).length === 3 && textFont.sha256 === descriptor.sha256 && textFont.face_index === 0 && textFont.profile === descriptor.profile,
          'ERR_PROTOCOL_VERSION', 'native text font identity differs from the accepted renderer face')
      }
      if (requestedRendererTransitions) startupStage(() => {
        check(['renderer_transition_contract_json', 'enable_renderer_transitions_json', 'renderer_transition_state_json',
          'transition_renderer_json', 'retire_page_presenter'].every(name => typeof host[name] === 'function'),
        'ERR_PROTOCOL_VERSION', 'host is missing explicit renderer transition exports')
        const offered = JSON.parse(host.renderer_transition_contract_json())
        check(record(offered) && Object.keys(offered).length === Object.keys(HOST_RENDERER_TRANSITION_CONTRACT).length
          && Object.keys(HOST_RENDERER_TRANSITION_CONTRACT).every(key => offered[key] === HOST_RENDERER_TRANSITION_CONTRACT[key]),
        'ERR_PROTOCOL_VERSION', 'host did not offer renderer transition version 1.0 before app.init')
      })
      if (options.renderScale !== undefined) startupStage(() => {
        check(typeof host.set_render_scale === 'function', 'ERR_PROTOCOL_VERSION', 'host is missing retained physical render scale')
        pendingRenderScale = initialRenderScale
        managedRenderScale = initialRenderScale
      })
      if (requestedExternalPresentation) startupStage(() => {
        check(['external_presentation_contract_json', 'last_frame_input_json', 'render_target_json', 'acknowledge_presentation_outcome_json'].every(name => typeof host[name] === 'function'),
          'ERR_PROTOCOL_VERSION', 'host is missing the explicit external presentation contract')
        // This export is pure and callable before load/app.init. No probing
        // application JS or fallback to legacy ACK may establish negotiation.
        externalPresentation = externalContract(JSON.parse(host.external_presentation_contract_json()))
      })
      if (requestedObservation) startupStage(() => {
        check(['observation_contract_json', 'observation_state_json'].every(name => typeof host[name] === 'function'),
          'ERR_PROTOCOL_VERSION', 'host is missing the explicit ordered observation contract')
        hostObservationContract(JSON.parse(host.observation_contract_json()))
        observationContract = requestedRendererTransitions ? RENDERER_OBSERVATION_CONTRACT : requestedObservation
        observationOwner = Object.freeze({ ...identity, packSha256: pack.provenance.indexSha256,
          ...(requestedRendererTransitions ? {} : { transportBackend: selected }) })
      })
      if (requestedSurfaceRecovery) startupStage(() => {
        check(['surface_recovery_contract_json', 'recover_external_frame_json'].every(name => typeof host[name] === 'function'),
          'ERR_PROTOCOL_VERSION', 'host is missing the explicit retained surface recovery contract')
        surfaceRecovery = surfaceRecoveryContract(JSON.parse(host.surface_recovery_contract_json()))
      })
      startupStage(() => {
        const remaining = Math.floor(remainingMilliseconds())
        check(remaining >= 1, 'ERR_TIMEOUT', 'Worker startup has less than one millisecond remaining')
        if (options.developmentSandbox === true) {
          check(options.hostServices === undefined && typeof host.enable_development_sandbox === 'function',
            'ERR_PROTOCOL_VERSION', 'development sandbox must be explicit and cannot coexist with production host services')
          host.enable_development_sandbox()
        } else check(options.developmentSandbox === undefined || options.developmentSandbox === false,
          'ERR_INVALID_REQUEST', 'developmentSandbox must be a boolean')
        host.load_manifest_json_with_config(pack.manifestText, JSON.stringify({
          session_id: identity.sessionId, engine: 'quickjs', require_integrity: true, renderer_mode: selected,
          ...(rendererPolicy ? { renderer_policy: rendererPolicy } : {}),
          engine_execution: { bootstrap_timeout_ms: Math.min(bootstrap, remaining), turn_timeout_ms: Math.min(turn, remaining) },
          // This is a trusted host allowance, still shortened by the active
          // AppService turn and request deadlines inside the native runtime.
          view_execution: { batch_timeout_ms: viewBatch },
          host: { kind: 'web', windowWidth: size.width, windowHeight: size.height,
            ...(initialDisplayMetrics === undefined ? {} : { displayMetrics: initialDisplayMetrics }) },
        }))
      })
      if (options.hostServices !== undefined) startupStage(() => {
        check(record(options.hostServices) && record(options.hostServices.application)
          && options.hostServices.application.packRoot === pack.provenance.integrityRoot,
        'ERR_INVALID_MANIFEST', 'host services must bind the accepted installation pack')
        check(['host_services_protocol_json','configure_host_services_json','take_host_requests_json',
          'complete_host_api_call_json','dispatch_host_api_event_json','revoke_host_services_json']
          .every(name => typeof host[name] === 'function'), 'ERR_PROTOCOL_VERSION', 'host does not implement native services 1.0')
        nativeServices = JSON.parse(host.host_services_protocol_json())
        check(nativeServices.version === '1.0' && nativeServices.trustedContext === true && nativeServices.ownerThreadCompletion === true,
          'ERR_PROTOCOL_VERSION', 'unsupported native host services protocol')
        nativeServices = { ...nativeServices, binaryTransfer: '1.0' }
        if (options.hostServices.apis?.some(name => ['component:camera','component:video'].includes(name))) {
          check(nativeServices.componentFrames === '1.0' && ['host_component_snapshots_json','submit_host_component_frame','host_component_resource'].every(name => typeof host[name] === 'function'),
            'ERR_PROTOCOL_VERSION', 'camera/video need the bounded native frame contract 1.0')
        }
        host.configure_host_services_json(JSON.stringify(options.hostServices))
      })
      const capabilities = startupStage(() => JSON.parse(host.capabilities_json()))
      if (requestedRendererTransitions) startupStage(() => {
        const enabled = JSON.parse(host.enable_renderer_transitions_json(JSON.stringify({ version: '1.0' })))
        check(enabled?.version === '1.0' && enabled.state?.sessionId === identity.sessionId
          && enabled.state.transportBackend === selected && decimal(enabled.inputLifetimeRevision),
        'ERR_PROTOCOL_VERSION', 'host did not enable renderer transitions on the original created session')
        presenterBinding = copyWorkerPresenterBinding(enabled.presenterBinding, identity.sessionId)
        check(presenterBinding.generation === '1' && presenterBinding.transportBackend === selected,
          'ERR_PROTOCOL_VERSION', 'new renderer binding must begin at generation 1 for the selected transport')
        rendererTransitions = requestedRendererTransitions
      })
      check(capabilities.quickjs === true, 'ERR_ENGINE', 'Worker host has no real QuickJS provider')
      // Reject an old/forced host before executing any application code.
      if (rendererPolicy) startupStage(() => runtimeState())
      if (requestedObservation) startupStage(() => {
        // Pure validation before any application JS. Do not mint sequence or
        // generation for Created/partially initialized startup state.
        const native = JSON.parse(host.observation_state_json())
        check(native?.version === '1.0' && decimal(native.inputLifetimeRevision),
          'ERR_PROTOCOL_VERSION', 'host cannot supply a healthy input-lifetime token before app.init')
        runtimeState(native.state)
      })
      if (requestedBrowserQueries) {
        const enabled = startupDispatch('view.query.enable', { version: '1.0', scope: 'session' })
        check(enabled.response.version === '1.0' && enabled.response.scope === 'session'
          && enabled.response.enabled === true && enabled.response.key === null,
        'ERR_PROTOCOL_VERSION', 'native host did not enable the session browser query contract')
        browserQueries = requestedBrowserQueries
        startupStage(() => startupBatch(enabled.batch))
      }
      const init = startupDispatch('app.init', { modules: pack.modules, blobs: pack.blobs, launchOptions: options.launchOptions ?? {} })
      startupStage(() => startupBatch(init.batch))
      check(init.response.engineProviderAvailable === true, 'ERR_ENGINE', 'app.init did not execute in a real engine provider')
      const launch = startupDispatch('app.lifecycle', { event: 'launch', options: options.launchOptions ?? {} })
      launched = true; startupStage(() => startupBatch(launch.batch))
      const page = startupDispatch('page.push', { path: route.path, data: options.data ?? {}, query: options.query ?? {} })
      startupStage(() => startupBatch(page.batch))
      const state = startupStage(() => runtimeState())
      check(!runtimeFault && !workerFault, 'ERR_ENGINE', 'Worker failed during startup')
      if (rendererRestart) throw rendererRestartError()
      const result = { state, capabilities, manifest, renderer, viewport, pack: pack.provenance,
        ...(textFont ? { textFont } : {}),
        ...(nativeServices ? { hostServices: nativeServices } : {}),
        transportBackend: renderer, declaredProfile: state.declaredRendererProfile,
        effectiveProfile: state.rendererProfile, rendererPolicy, ...(externalPresentation ? { externalPresentation } : {}),
        ...(surfaceRecovery ? { surfaceRecovery } : {}), ...(browserQueries ? { browserQueries } : {}),
        ...(rendererTransitions ? { rendererTransitions, runtimeOwner: observationOwner, presenterBinding } : {}),
        ...(scaleContract ? { renderScaleContract: WORKER_RENDER_SCALE_CONTRACT } : {}) }
      if (options.inputTiming !== undefined) {
        inputTrace = new AppliedInputTrace({ sessionId: identity.sessionId, clock: monotonicClock })
        result.inputTiming = INPUT_TIMING_CONTRACT
      }
      if (requestedObservation) startupStage(() => {
        result.observationContract = observationContract
        result.observation = captureObservation({ initial: true, emit: false })
      })
      // The final RPC response must fit before this host becomes runnable.
      // Otherwise finish() could reject a large valid manifest while leaving
      // the session ready and its business timers running after failed load.
      // startupStage also checks the total deadline after bounded traversal.
      startupStage(() => measureWorkerPayload({ status: 'ok', result }, { maxBytes: MESSAGE_LIMIT }))
      phase = 'ready'
      observationLive = !!requestedObservation
      return result
    } catch (error) {
      // Initial capture is tentative until the entire load response validates.
      // A rejected startup publishes no generation and never arms ordinary work.
      if (requestedObservation) {
        observationLive = false; latestObservation = null; observationSequence = '0'; surfaceGeneration = '0'
        observationSignature = null; hardSignature = null
      }
      if (host) { try { runtimeState() } catch { /* Construction may have failed before installing a session. */ } }
      if (!runtimeFault && !workerFault && !rendererRestart) { const diagnostics = []; disposeHost(diagnostics); phase = 'failed'; if (diagnostics.length) event('diagnostic', { diagnostics }) }
      throw error
    } finally { timer.clearTimeout(timeout) }
  }
  function currentFrame(batch, { fresh = false } = {}) {
    ensureHealthy()
    check(renderer === 'external-frame', 'ERR_RENDER', 'DOM presentation uses view.prepare and its complete presentation key')
    const observation = rendererTransitions ? captureObservation() : null
    if (rendererTransitions && !fresh) check(hasCurrentPresenterFrame(), 'ERR_CANCELLED',
      'presenter binding has no frame exported from its current input lifetime; render a new frame')
    const exportStarted = monotonicNow()
    const frame = typeof host.render_frame_binary === 'function'
      ? decodeNativeFrameBinary(host.render_frame_binary()) : JSON.parse(host.render_frame_json())
    const renderRevision = host.render_revision().toString()
    const result = { frame, renderRevision, viewRevision: host.view_revision().toString(), ...(batch ? { batch } : {}),
      ...(externalPresentation ? { renderDiagnostics: { version: '1.0', transport: typeof host.render_frame_binary === 'function' ? 'binary-rgba' : 'json-rgba',
        exportMs: monotonicNow() - exportStarted, cpuSnapshot: false } } : {}) }
    if (externalPresentation) {
      const metadata = JSON.parse(host.last_frame_input_json(BigInt(renderRevision)))
      result.scheduling = copyExternalFrameScheduling(metadata, { sessionId: identity.sessionId, renderRevision, frame })
      result.target = copyExternalFrameTarget(JSON.parse(host.render_target_json(BigInt(renderRevision))),
        { sessionId: identity.sessionId, renderRevision })
      if (managedRenderScale !== null) check(result.target.width === Math.ceil(frame.viewport.width * managedRenderScale)
        && result.target.height === Math.ceil(frame.viewport.height * managedRenderScale),
      'ERR_RENDER', 'native frame target did not apply the requested physical render scale')
      if (inputTrace && retainedInputTiming) withInputTiming(result,
        JSON.stringify(retainedInputTiming.consumedInput) === JSON.stringify(result.scheduling.consumedInput)
          ? retainedInputTiming : { version: '1.0', sessionId: identity.sessionId, incomplete: 'retained-consumed-input-mismatch' })
    }
    if (rendererTransitions) {
      const state = observation?.state, consumed = result.scheduling?.consumedInput
      check(state && !state.requiresRestart && !state.transitionRequired && state.lifecycle === 'Active'
        && consumed && consumed.pageId === state.currentPage?.pageId && consumed.routePath === state.currentPage.path
        && sameRect(consumed.viewport, state.viewport),
      'ERR_CANCELLED', 'exported frame does not belong to the current presenter page and logical surface')
      presenterFrameExport = Object.freeze({ generation: presenterBinding.generation, renderRevision,
        pageId: state.currentPage.pageId, inputLifetimeRevision: state.inputLifetimeRevision,
        surfaceGeneration: state.surfaceGeneration })
    }
    return result
  }
  function frame(payload) {
    ensureHealthy()
    check(renderer === 'external-frame', 'ERR_RENDER', 'DOM presentation does not produce a Skia frame')
    const state = runtimeState()
    ensureHealthy()
    const route = manifest.routes.find(item => item.path === state.currentPage?.path)
    check(route, 'ERR_RENDER', 'no active manifest route to render')
    check(frameSequence < Number.MAX_SAFE_INTEGER, 'ERR_RENDER', 'Worker frame sequence exhausted')
    check(payload?.viewport === undefined, 'ERR_RENDER', 'update logical dimensions through metrics before requesting a frame')
    const prepareStarted = monotonicNow()
    const result = requireSuccess(dispatch('render.commit', { frameId: ++frameSequence, templateId: `template:${route.path}.wxml`,
      useSessionResources: true, viewport, styleIds: routeStyleIds(manifest, route) }), 'render.commit')
    if (pendingRenderScale !== null) {
      // The native scale operation needs an accepted layout. Repaint that
      // retained tree before exporting the first frame: no 1x surface is ever
      // published, and no additional JS/WXS/template evaluation is performed.
      host.set_render_scale(pendingRenderScale)
      pendingRenderScale = null
    }
    const prepareMs = monotonicNow() - prepareStarted
    const exported = currentFrame(result.batch, { fresh: true })
    if (exported.renderDiagnostics) exported.renderDiagnostics.prepareMs = prepareMs
    if (inputTrace) {
      // Only original native render may mint input→clone diagnostic evidence.
      // Retained paint/recovery must carry this exact frozen snapshot forward.
      try { retainedInputTiming = inputTrace.clone(exported.scheduling.consumedInput); withInputTiming(exported, retainedInputTiming) }
      catch { withInputTiming(exported, { version: '1.0', sessionId: identity.sessionId, incomplete: 'clone-diagnostic-failed' }) }
    }
    return exported
  }
  function bridge(payload, outerRequestId) {
    check(host, 'ERR_ENGINE', 'Worker runtime has no session')
    const messages = bridgeMessages(payload)
    check(messages.length <= 256, 'ERR_INVALID_REQUEST', 'bridge batch exceeds 256 envelopes')
    for (const message of messages) {
      check(record(message) && message.sessionId === identity.sessionId && message.protocolVersion === '1.0', 'ERR_PROTOCOL_VERSION', 'inner bridge belongs to another session or protocol')
    }
    if (rendererTransitions && messages.some(message => PRESENTER_BRIDGE_OPS.has(message.op))) {
      check(messages.length === 1, 'ERR_INVALID_REQUEST', 'negotiated presenter envelopes require an indivisible single-operation host call')
      requirePresenterContext(payload.presentationContext)
    }
    if (observationLive && renderer === 'browser-view') {
      const keyed = messages.filter(message => ['view.prepare', 'view.prepare.commit', 'view.presented', 'view.geometry', 'view.events', 'view.query.result', 'view.animation.baseline', 'view.sample.prepare', 'view.sample.presented'].includes(message.op))
      // Do not split/replay an indivisible native batch. A mixed batch could
      // hide/show or leave/return before a stale later view key is checked.
      check(keyed.length === 0 || messages.length === 1, 'ERR_INVALID_REQUEST',
        'ordered DOM surface operations require one envelope per atomic host call')
      for (const message of keyed) validateSurfaceOperation(message.op, message.payload)
    }
    if (!pureBridge(payload)) ensureHealthy()
    const requestedTiming = inputTrace && payload.envelope?.op === 'event.batch' && payload.inputTiming?.version === '1.0'
    const traced = requestedTiming && !payload.inputTiming.omitted
    // These read-only diagnostics never call runtimeState(), observe policy,
    // schedule work, swallow a business exception or replace a business final.
    const traceState = () => { try {
      const native = JSON.parse(host.observation_state_json()), state = native.state, logical = logicalViewport(state.viewport)
      const hard = JSON.stringify([state.currentPage?.pageId ?? null, state.currentPage?.path ?? null,
        logical.x, logical.y, logical.width, logical.height, state.lifecycle === 'Active', native.inputLifetimeRevision])
      // Reuse a generation only if this read-only native lifetime has already
      // been observed. A transition stays unknown until the ordinary owner
      // observation path commits it; diagnostics never mint a generation.
      return { ...state, viewport: logical, inputLifetimeRevision: native.inputLifetimeRevision,
        surfaceGeneration: hard === hardSignature ? surfaceGeneration : null }
    } catch { return null } }
    const before = traced ? traceState() : null
    const batch = parseBatch(payload.envelope ? host.dispatch_json(JSON.stringify(payload.envelope)) : host.dispatch_batch_json(JSON.stringify(payload.batch)))
    if (traced) try {
      const final = batch.messages.find(message => message.kind === 'response' && message.requestId === payload.envelope.requestId
        && message.op === 'event.batch' && message.payload?.queued !== true)
      const receipt = inputTrace.applied({ sampleIds: payload.inputTiming.sampleIds, requestId: outerRequestId,
        innerRequestId: payload.envelope.requestId, before, after: traceState(), ok: final?.payload?.ok })
      if (receipt) return withInputTiming(batch, receipt)
      return withInputTiming(batch, { version: '1.0', sessionId: identity.sessionId, incomplete: 'invalid-input-diagnostic' })
    } catch { return withInputTiming(batch, { version: '1.0', sessionId: identity.sessionId, incomplete: 'applied-diagnostic-failed' }) }
    if (requestedTiming) return withInputTiming(batch, { version: '1.0', omitted: 'request-diagnostic-omitted' })
    return batch
  }
  async function shutdown() {
    phase = 'closing'; stopTimers()
    const diagnostics = []
    if (rendererBindingFault) diagnostics.push({ phase: 'renderer-binding', ...rendererBindingFault })
    if (host) {
      if (!runtimeFault && !workerFault && !rendererRestart && !nativeRevoked) {
        try { const batch = parseBatch(rendererTransitions ? host.retire_page_presenter('worker-closed') : host.retire_browser_preview('worker-closed')); if (batch.messages.length) diagnostics.push({ phase: 'retire', batch }) }
        catch (error) { diagnostics.push({ phase: 'retire', ...diagnostic(error) }) }
      }
      try {
        const state = runtimeState()
        if (launched && !runtimeFault && !workerFault && !rendererRestart && !nativeRevoked && state.lifecycle !== 'Destroyed') {
          const result = dispatch('app.lifecycle', { event: 'unload' })
          if (result.batch.messages.length) diagnostics.push({ phase: 'lifecycle', batch: result.batch })
        }
      } catch (error) { diagnostics.push({ phase: 'lifecycle', ...diagnostic(error) }) }
      if (observationLive) {
        try { captureObservation({ emit: false }) }
        catch (error) { diagnostics.push({ phase: 'observation', ...diagnostic(error) }) }
      }
      disposeHost(diagnostics)
    }
    manifest = null; phase = 'closed'
    outstandingEvents.clear(); acknowledgedEvents.clear()
    normalEventCount = 0; normalEventBytes = 0
    return { closed: true, diagnostics }
  }
  async function execute(entry) {
    const { op } = entry.message
    let payload = entry.message.payload
    if (op !== 'close') checkCancelled(entry)
    if (rendererTransitions && PRESENTER_OPS.has(op)) {
      requirePresenterContext(payload.presentationContext)
      const { presentationContext: _presentationContext, ...business } = payload
      payload = business
    }
    if (rendererRestart && !['state', 'events.ack', 'close'].includes(op) && !(op === 'bridge' && pureBridge(payload))) {
      throw rendererRestartError()
    }
    switch (op) {
      case 'load': return load(entry)
      case 'events.ack': return acknowledgeEvents(payload)
      case 'bridge': return bridge(payload, entry.message.requestId)
      case 'state': return runtimeState()
      case 'native.take': {
        ensureHealthy(); check(nativeServices, 'ERR_PROTOCOL_VERSION', 'native services were not negotiated')
        return { requests: JSON.parse(host.take_host_requests_json()) }
      }
      case 'native.complete': {
        ensureHealthy(); check(nativeServices && typeof payload.callId === 'string' && record(payload.completion),
          'ERR_INVALID_REQUEST', 'native completion requires a callId and result/error record')
        return { batch: observeBatch(parseBatch(host.complete_host_api_call_json(payload.callId, JSON.stringify(unpackHostApiWire(payload.completion))))) }
      }
      case 'native.event': {
        ensureHealthy(); check(nativeServices && record(payload.event) && payload.event.sessionId === identity.sessionId,
          'ERR_CANCELLED', 'native event belongs to a different execution owner')
        return { batch: observeBatch(parseBatch(host.dispatch_host_api_event_json(JSON.stringify(unpackHostApiWire(payload.event))))) }
      }
      case 'native.phone': {
        ensureHealthy(); check(nativeServices && typeof payload.nodeId === 'string' && typeof host.authorize_phone_button_json === 'function',
          'ERR_PROTOCOL_VERSION', 'phone authorization needs a current accepted button and supporting runtime')
        return { batch: observeBatch(parseBatch(host.authorize_phone_button_json(payload.nodeId))) }
      }
      case 'native.component': {
        ensureHealthy(); check(nativeServices && record(payload.event) && payload.event.sessionId === identity.sessionId
          && typeof host.dispatch_host_component_event_json === 'function', 'ERR_PROTOCOL_VERSION', 'native component events require the current supporting owner')
        return { batch: observeBatch(parseBatch(host.dispatch_host_component_event_json(JSON.stringify(unpackHostApiWire(payload.event))))) }
      }
      case 'native.snapshots': {
        ensureHealthy(); check(nativeServices && record(payload.values) && typeof host.update_host_service_snapshots_json === 'function',
          'ERR_PROTOCOL_VERSION', 'runtime does not implement trusted synchronous snapshot updates')
        host.update_host_service_snapshots_json(JSON.stringify(unpackHostApiWire(payload.values))); return { updated:true }
      }
      case 'native.components': {
        ensureHealthy(); check(nativeServices?.componentFrames === '1.0' && typeof host.host_component_snapshots_json === 'function',
          'ERR_PROTOCOL_VERSION', 'runtime does not implement accepted media geometry')
        return { components: JSON.parse(host.host_component_snapshots_json()) }
      }
      case 'native.media-resource': {
        ensureHealthy(); check(nativeServices?.componentFrames === '1.0' && record(payload.target)
          && payload.target.sessionId === identity.sessionId && typeof host.host_component_resource === 'function',
          'ERR_PROTOCOL_VERSION', 'native media resources require the accepted component owner')
        const bytes = host.host_component_resource(JSON.stringify(payload.target))
        if (bytes == null) return { pending:true }
        check(bytes instanceof Uint8Array && bytes.byteLength <= RESOURCE_LIMIT, 'ERR_ENGINE', 'native media exceeds transfer limit')
        return { bytes:bytes.slice().buffer }
      }
      case 'native.api-resource': {
        ensureHealthy(); check(nativeServices?.packagedApiResources === '1.0' && record(payload.context)
          && payload.context.sessionId === identity.sessionId && typeof host.host_api_resource === 'function',
          'ERR_PROTOCOL_VERSION', 'packaged API resources require a supporting current call owner')
        const bytes = host.host_api_resource(JSON.stringify(payload.context))
        check(bytes instanceof Uint8Array && bytes.byteLength <= HOST_API_RESOURCE_MAX_BYTES, 'ERR_ENGINE', 'API resource exceeds transfer limit')
        return { bytes:bytes.slice().buffer }
      }
      case 'native.frame': {
        ensureHealthy(); check(nativeServices?.componentFrames === '1.0' && record(payload.metadata)
          && payload.metadata.sessionId === identity.sessionId && payload.pixels instanceof Uint8Array
          && payload.pixels.byteLength <= 1024 * 1024 && typeof host.submit_host_component_frame === 'function',
          'ERR_PROTOCOL_VERSION', 'native RGBA frames require the current supporting owner and bounded bytes')
        return { accepted: host.submit_host_component_frame(JSON.stringify(payload.metadata), payload.pixels) }
      }
      case 'native.revoke': {
        check(nativeServices && host, 'ERR_PROTOCOL_VERSION', 'native services were not negotiated')
        nativeRevoked = true; stopTimers(); timerPending = false
        return { revoked: true, cancellations: JSON.parse(host.revoke_host_services_json()) }
      }
      case 'renderer.transition': return transitionRenderer(payload)
      case 'frame': return frame(payload)
      case 'frame.current': return currentFrame()
      case 'surface.recover': {
        ensureHealthy()
        check(surfaceRecovery && externalPresentation && observationContract && renderer === 'external-frame',
          'ERR_PROTOCOL_VERSION', 'surface recovery was not explicitly negotiated')
        check(record(payload) && Object.keys(payload).length === 2 && payload.version === '1.0',
          'ERR_PROTOCOL_VERSION', 'surface recovery needs version 1.0 and exact expected input')
        const expected = boundedJsonCopy(payload.expected)
        const keys = ['sessionId', 'pageId', 'routePath', 'viewport', 'rendererProfile', 'templateRevision',
          'renderRevision', 'inputLifetimeRevision', 'surfaceGeneration']
        check(record(expected) && Object.keys(expected).length === keys.length && keys.every(key => Object.hasOwn(expected, key))
          && identifier(expected.sessionId) && typeof expected.routePath === 'string' && expected.routePath.length <= 4096
          && ['pageId', 'templateRevision', 'renderRevision', 'inputLifetimeRevision', 'surfaceGeneration'].every(key => decimal(expected[key]))
          && expected.pageId !== '0' && expected.surfaceGeneration !== '0'
          && ['skia', 'skyline-compat'].includes(expected.rendererProfile) && finiteRect(expected.viewport)
          && Object.keys(expected.viewport).length === 4,
        'ERR_PROTOCOL_VERSION', 'surface recovery expected input is malformed')
        const observed = captureObservation(), state = observed?.state
        check(state && state.lifecycle === 'Active' && !state.requiresRestart
          && expected.sessionId === identity.sessionId && expected.pageId === state.currentPage?.pageId
          && expected.routePath === state.currentPage.path && sameRect(expected.viewport, state.viewport)
          && ['rendererProfile', 'templateRevision', 'renderRevision', 'inputLifetimeRevision', 'surfaceGeneration']
            .every(key => expected[key] === state[key]),
        'ERR_CANCELLED', 'surface recovery expected input belongs to a retired native surface')
        check(hasCurrentPresenterFrame(expected.renderRevision), 'ERR_CANCELLED',
          'surface recovery requires an actual exported frame from this presenter binding')
        const nextRevisions = preflightSurfaceRecoveryRevisions(expected, observationSequence)
        const { surfaceGeneration: _generation, ...nativeExpected } = expected
        const recovery = JSON.parse(host.recover_external_frame_json(JSON.stringify(nativeExpected)))
        check(record(recovery) && Object.keys(recovery).length === 7 && recovery.version === '1.0'
          && ['retained', 'render-required'].includes(recovery.kind)
          && recovery.sessionId === identity.sessionId && recovery.previousRenderRevision === expected.renderRevision
          && recovery.previousInputLifetimeRevision === expected.inputLifetimeRevision
          && recovery.renderRevision === (recovery.kind === 'retained' ? nextRevisions.renderRevision : expected.renderRevision)
          && recovery.inputLifetimeRevision === nextRevisions.inputLifetimeRevision,
        'ERR_PROTOCOL_VERSION', 'host did not mint exact monotonic surface recovery revisions')
        const result = recovery.kind === 'retained' ? currentFrame(undefined, { fresh: true }) : null
        const consumed = result?.scheduling?.consumedInput
        check(!result || (consumed && consumed.pageId === expected.pageId && consumed.routePath === expected.routePath
          && consumed.templateRevision === expected.templateRevision && sameRect(consumed.viewport, expected.viewport)
          && sameRect(result.frame.viewport, expected.viewport)),
        'ERR_PROTOCOL_VERSION', 'retained recovery does not carry the exact consumed native input')
        const next = captureObservation()
        check((!result || result.renderRevision === recovery.renderRevision) && next?.state.renderRevision === recovery.renderRevision
          && next.state.inputLifetimeRevision === recovery.inputLifetimeRevision
          && next.state.surfaceGeneration === nextRevisions.surfaceGeneration && next.sequence === nextRevisions.observationSequence
          && next.state.currentPage?.pageId === expected.pageId && next.state.currentPage.path === expected.routePath
          && next.state.lifecycle === 'Active' && !next.state.requiresRestart && next.state.rendererProfile === expected.rendererProfile
          && next.state.templateRevision === expected.templateRevision && sameRect(next.state.viewport, expected.viewport),
        'ERR_PROTOCOL_VERSION', 'recovered frame and genuine observation do not identify the same new surface')
        const recovered = { ...(result ?? {}), recovery: freezeJson(recovery) }
        return result && resultInputTiming.has(result) ? withInputTiming(recovered, resultInputTiming.get(result)) : recovered
      }
      case 'ack': {
        ensureHealthy()
        if (renderer === 'browser-view') return dispatch('view.presented', payload.permit).batch
        check(decimal(payload.renderRevision) && payload.renderRevision !== '0', 'ERR_RENDER', 'ack requires a canonical render revision')
        check(hasCurrentPresenterFrame(payload.renderRevision), 'ERR_CANCELLED',
          'external ACK does not name an exported frame from this presenter binding and input lifetime')
        if (!externalPresentation) return parseBatch(host.acknowledge_presentation(BigInt(payload.renderRevision)))
        const raw = JSON.parse(host.acknowledge_presentation_outcome_json(BigInt(payload.renderRevision)))
        let final
        try {
          final = copyExternalPresentationOutcome(raw, { sessionId: identity.sessionId, renderRevision: payload.renderRevision })
          const batch = observeBatch(final.batch, final.observedState)
          const state = runtimeState(final.observedState)
          // The native runtime alone can prove true. Worker policy/transport
          // faults may only suppress it; templateRevision is never a gate.
          return copyExternalPresentationOutcome({ ...final, batch, observedState: state,
            inputEnabled: final.inputEnabled && !state.requiresRestart,
            requiresRestart: final.requiresRestart || state.requiresRestart,
          }, { sessionId: identity.sessionId, renderRevision: payload.renderRevision })
        } catch (error) {
          // Publication/effects may already be irreversible. Preserve the real
          // batch in failure diagnostics; do not fabricate rollback/consumed.
          throw fail(error.code || 'ERR_PROTOCOL_VERSION', error.message || String(error), {
            ...(error.details ?? {}), acknowledged: raw?.acknowledged === true,
            renderRevision: payload.renderRevision, ...(record(raw?.batch) && Array.isArray(raw.batch.messages) ? { batch: raw.batch } : {}),
            ...(record(raw?.observedState) ? { observedState: raw.observedState } : {}),
          })
        }
      }
      case 'resource': {
        ensureHealthy()
        check(renderer === 'browser-view' && record(payload.key) && digestString(payload.sha256), 'ERR_RENDER', 'resource requires the complete DOM presentation key and SHA-256')
        const dynamic = typeof payload.path === 'string' && /^__container_buffer_urls\/[0-9a-f]{48}$/.test(payload.path)
        check(payload.path === undefined || dynamic, 'ERR_RENDER', 'resource path must identify an exact BufferURL lease')
        check(!dynamic || typeof host.browser_view_resource_at_path === 'function', 'ERR_UNSUPPORTED_CAPABILITY', 'runtime does not implement BufferURL resource leases')
        const bytes = dynamic ? host.browser_view_resource_at_path(JSON.stringify(payload.key), payload.sha256, payload.path)
          : host.browser_view_resource(JSON.stringify(payload.key), payload.sha256)
        check(bytes instanceof Uint8Array && bytes.byteLength <= RESOURCE_LIMIT, 'ERR_ENGINE', 'host resource exceeds the 16 MiB transfer budget')
        // Copy before transfer: never detach a wasm-bindgen view or WASM heap.
        return { key: payload.key, sha256: payload.sha256, ...(dynamic ? { path: payload.path } : {}), bytes: bytes.slice().buffer }
      }
      case 'metrics': {
        ensureHealthy()
        logicalViewport({ width: payload.windowWidth, height: payload.windowHeight })
        const batch = parseBatch(host.notify_window_metrics_json(JSON.stringify(payload)))
        runtimeState()
        return batch
      }
      case 'scale': {
        ensureHealthy()
        check(renderer === 'external-frame', 'ERR_RENDER', 'scale requires an external frame')
        validateRenderScale(runtimeState().viewport, payload.scale)
        // A scale request can precede the scheduler's first accepted layout.
        // In that case only the latest validated density is applied at export.
        if (BigInt(host.render_revision()) === 0n || !hasCurrentPresenterFrame()) pendingRenderScale = payload.scale
        else {
          host.set_render_scale(payload.scale)
          pendingRenderScale = null
        }
        managedRenderScale = payload.scale
        return { scale: payload.scale, state: runtimeState() }
      }
      case 'view.retire':
      case 'retire': {
        check(host, 'ERR_ENGINE', 'Worker runtime has no session')
        check(!workerFault, 'ERR_ENGINE', 'Worker owner is faulted; create a new session')
        const reason = typeof payload.reason === 'string' ? payload.reason : 'worker-preview-retired'
        return parseBatch(rendererTransitions ? host.retire_page_presenter(reason) : host.retire_browser_preview(reason))
      }
      case 'view.sample.abort': {
        check(host, 'ERR_ENGINE', 'Worker runtime has no session')
        check(!workerFault, 'ERR_ENGINE', 'Worker owner is faulted; create a new session')
        return dispatch('view.sample.abort', payload).batch
      }
      case 'view.abort':
      case 'abort': {
        check(host, 'ERR_ENGINE', 'Worker runtime has no session')
        check(!workerFault, 'ERR_ENGINE', 'Worker owner is faulted; create a new session')
        return dispatch('view.abort', payload.key).batch
      }
      case 'close': return shutdown()
      default: throw fail('ERR_INVALID_REQUEST', `unknown Worker operation: ${op}`)
    }
  }
  function finish(entry, result, error) {
    if (pending.get(entry.message.requestId) !== entry) return
    // Reuse the already minted Worker observation, including for an older
    // response/late cleanup. Response arrival never creates a sequence.
    const observation = observationContract ? latestObservation : null
    const timing = !error && record(result) ? resultInputTiming.get(result) : undefined
    // API resource reads do not enter guest JS or advance state. An optional
    // observation can fill the general message budget itself; it cannot share
    // the new resource protocol's fixed 64 KiB envelope reservation.
    if (observation && !error && record(result) && entry.message.op !== 'native.api-resource') result = { ...result, observation }
    let payload = error ? { status: 'error', error: { ...diagnostic(error), ...(observation ? { observation } : {}) } } : { status: 'ok', result }
    let transfers = result?.bytes instanceof ArrayBuffer && !error ? [result.bytes] : []
    try {
      const frameWire = packWorkerFrameWire(entry.message.op, payload)
      const limits = workerFrameResponseLimits(entry.message.op, frameWire.value, { maxBytes: MESSAGE_LIMIT })
      const wire = packHostApiWire(frameWire.value, limits)
      payload = wire.value
      transfers.push(...frameWire.transfer, ...wire.transfer)
      // Optional tracing must never replace a completed native business final
      // with a wire-budget error, including node/depth and marker boundaries.
      if (timing !== undefined) payload = fitWorkerInputTiming(payload, timing,
        { response: true, ...limits, transfers }).payload
      else measureWorkerPayload(payload, { ...limits, transfers })
    }
    catch (budgetError) {
      // Binary packing is an implementation detail of the existing bounded
      // RPC channel; callers retain its established payload-limit contract.
      if (budgetError?.code === 'ERR_HOST_API_BINARY_WIRE_LIMIT') budgetError = fail('ERR_RPC_PAYLOAD_TOO_LARGE', budgetError.message)
      // Encoding cannot erase the genuine final observation already minted
      // for this operation. Owners must see the payload failure, not infer a
      // protocol fault from a missing final ordered observation.
      payload = { status: 'error', error: { ...diagnostic(budgetError), ...(observation ? { observation } : {}) } }; transfers = []
    }
    pending.delete(entry.message.requestId)
    inFlightBytes -= entry.reservedBytes
    entry.reservedBytes = 0
    reply(entry, payload, transfers)
  }
  function scheduleTimers() {
    if (phase !== 'ready' || runtimeFault || workerFault || nativeRevoked || closeRequested || timerHandle !== null || timerPending) return
    timerHandle = timer.setTimeout(() => { timerHandle = null; timerPending = true; scheduleDrain() }, timerIntervalMs)
  }
  function scheduleDrain() {
    if (running || drainHandle !== null || phase === 'closed') return
    if (!closeEntry && !ordinary.length && !controls.length && !timerPending) { scheduleTimers(); return }
    const token = {}; drainHandle = token
    const run = () => {
      if (drainHandle !== token) return
      drainHandle = null
      void drainOne().catch(error => {
        // postMessage can fail even while sending the reserved fault event or
        // cancelling the close queue before drainOne enters its entry try.
        // post() has already queued exact-owner shutdown in that case. Observe
        // this detached task's rejection and keep that cleanup lane running.
        try { if (!channelFailed && !runtimeFault && !workerFault) markFault(error, 'owner') }
        catch { /* A failed fault notification has the same channel cleanup. */ }
        if (observationLive && host) { try { captureObservation({ emit: false }) } catch { /* Keep the last genuine sequence on exhaustion. */ } }
        try { flushObservationFault() } catch { /* post() owns exact channel cleanup. */ }
        scheduleDrain()
      })
    }
    // A nested setTimeout(0) is clamped by browsers, adding an artificial delay
    // to every event/frame/ACK hop. postTask keeps a real task boundary and the
    // same ordered queues without that timer floor. Unsupported/rejected task
    // submission retains the existing finite timer fallback, exactly once.
    const fallback = () => { if (drainHandle === token) timer.setTimeout(run, 0) }
    if (postTask) {
      try { void Promise.resolve(postTask(run, { priority: 'user-visible' })).catch(fallback) }
      catch { fallback() }
    } else fallback()
  }
  async function drainOne() {
    if (running || phase === 'closed') return
    let entry
    if (closeEntry) {
      entry = closeEntry; closeEntry = null
      for (const queued of [...controls.splice(0), ...ordinary.splice(0)]) finish(queued, null, fail('ERR_CANCELLED', 'Worker is closing'))
      timerPending = false
    } else if (controls.length) entry = controls.shift()
    else if (timerPending && (preferTimer || ordinary.length === 0)) {
      running = { timer: true }; timerPending = false; preferTimer = false
      let batch, originalError, observationRefreshError, timerFailed = false, batchDelivered = false
      try {
        ensureHealthy()
        batch = parseBatch(host.poll_timers(workerUnixNanos(clock())))
        if (observationLive) {
          let observation
          try { observation = captureObservation() }
          catch (refreshError) { observationRefreshError = refreshError; throw refreshError }
          // Consumers must receive the actual same-turn owner/page/lifetime
          // before any of this timer's effects, including ready/data batches.
          if (batch.messages.length) { liveBatch(batch, observation); batchDelivered = true }
        } else {
          // Preserve the non-opt-in event payload and legacy dirty ordering.
          if (batch.messages.length) event('batch', batch)
          observeState()
        }
      } catch (error) {
        originalError = error; timerFailed = true
        try { if (host) runtimeState() } catch { /* The original error remains the diagnostic. */ }
        // A failed scheduler cannot silently continue polling. In particular,
        // an exhausted normal event ledger must use only the reserved fault
        // slot, never recursively try to send another normal error event.
        if (!runtimeFault && !workerFault) markFault(error, 'owner')
      } finally {
        if (observationLive && host) {
          try { captureObservation() }
          catch (refreshError) {
            observationRefreshError ??= refreshError
            try { if (!workerFault) markFault(refreshError, 'owner') } catch { /* Channel cleanup owns disposal. */ }
          }
          if (timerFailed || observationRefreshError !== undefined) {
            preserveTimerFailure(batch, originalError, observationRefreshError, timerFailed, batchDelivered)
          }
        }
        try { flushObservationFault() } catch { /* post() owns exact channel cleanup. */ }
        running = null; scheduleTimers(); scheduleDrain()
      }
      return
    } else entry = ordinary.shift()
    if (!entry) { scheduleDrain(); return }
    running = entry; preferTimer = true
    if (observationContract || (entry.message.op === 'load' && entry.message.payload.observation !== undefined)) {
      let result, originalError
      try { result = await execute(entry) }
      catch (error) { originalError = error }
      finally {
        if (observationLive && host && phase !== 'closed') {
          try { captureObservation() }
          catch (refreshError) {
            try { if (!workerFault) markFault(refreshError, 'owner') } catch { /* Preserve the original result/error. */ }
            // A dirty notification may exhaust event credit after committing a
            // healthy snapshot. Observe the now-faulted owner without emitting
            // again; a genuinely unreadable native state keeps the last real
            // snapshot, never a fabricated replacement or renewed sequence.
            try { captureObservation({ emit: false }) }
            catch { /* Keep the genuine snapshot and original refresh failure. */ }
            originalError = fail(originalError?.code || refreshError.code || 'ERR_ENGINE',
              originalError?.message || refreshError.message || String(refreshError), {
                ...(originalError?.details === undefined ? {} : { originalDetails: originalError.details }),
                ...(result === undefined ? {} : { committedResult: result }), observationRefreshError: diagnostic(refreshError),
              })
          }
        }
        try { flushObservationFault() } catch { /* post() owns exact channel cleanup. */ }
        try { finish(entry, result, originalError) }
        finally { running = null; scheduleTimers(); scheduleDrain() }
      }
      return
    }
    try {
      const result = await execute(entry)
      // An already-entered Rust/JS call (including an entire bridge batch) is
      // indivisible here. Inspect its real final route before exposing a final
      // receipt, and freeze every subsequent ordinary/timer turn on mismatch.
      if (rendererPolicy && host && phase !== 'closed') {
        try { observeState() }
        catch (error) { markFault(error, 'owner') }
      }
      // Runtime effects already happened. Cancellation received after a sync
      // call cannot roll them back or turn a completed batch into fake failure.
      finish(entry, result)
      if (!rendererPolicy && host && phase !== 'closed') {
        try { observeState() }
        catch (error) { markFault(error, 'owner') }
      }
    } catch (error) {
      if (host) { try { runtimeState() } catch { /* Preserve the operation's actual failure. */ } }
      finish(entry, null, error)
    } finally { running = null; scheduleTimers(); scheduleDrain() }
  }
  function receive(message) {
    let entry
    try {
      check(record(message) && Object.keys(message).length === ENVELOPE_KEYS.length
        && ENVELOPE_KEYS.every(key => Object.prototype.hasOwnProperty.call(message, key))
        && message.version === WORKER_PROTOCOL_VERSION && identifier(message.workerEpoch) && identifier(message.sessionId)
        && identifier(message.requestId, 192) && identifier(message.op), 'ERR_PROTOCOL_VERSION', 'invalid Worker envelope')
      if (identity) check(message.workerEpoch === identity.workerEpoch && message.sessionId === identity.sessionId, 'ERR_CANCELLED', 'Worker epoch or session is stale')
      if (message.kind === 'cancel') {
        check(record(message.payload) && ['timeout', 'aborted'].includes(message.payload.reason), 'ERR_INVALID_REQUEST', 'invalid cancellation reason')
        const target = pending.get(message.requestId)
        if (target && target.message.op === message.op && message.op !== 'close') {
          target.controller.abort(fail('ERR_CANCELLED', `Worker request cancelled: ${message.payload?.reason ?? 'aborted'}`))
          // Client timeouts release the sender's reservation. Release this
          // independent owner reservation only after queued work is removed;
          // an active asynchronous load retains its bytes until abort settles.
          if (target !== running) {
            const queue = target.control ? controls : ordinary
            const index = queue.indexOf(target)
            if (index !== -1) queue.splice(index, 1)
            finish(target, null, target.controller.signal.reason)
          }
        }
        return true
      }
      check(message.kind === 'request' && HOST_OPS.has(message.op) && record(message.payload), 'ERR_INVALID_REQUEST', 'invalid Worker request operation or payload')
      const control = message.op === 'close' || CONTROL_OPS.has(message.op)
        || (message.op === 'state' && (rendererPolicy !== null || observationContract !== null)) || (message.op === 'bridge' && pureBridge(message.payload))
      const limits = { maxBytes: control ? CONTROL_MESSAGE_LIMIT : MESSAGE_LIMIT }
      let reservedBytes
      if (inputTrace && isWorkerInputTimingRequest(message.op, message.payload)) {
        const sideband = splitWorkerInputTiming(message.payload)
        if (sideband.present) {
          const fitted = fitWorkerInputTiming(sideband.base, sideband.diagnostic, limits)
          message = { ...message, payload: fitted.payload }; reservedBytes = fitted.baseBytes
        }
      }
      reservedBytes ??= measureWorkerPayload(message.payload, limits)
      const byteLimit = message.op === 'close' ? IN_FLIGHT_LIMIT : control ? IN_FLIGHT_LIMIT - CONTROL_MESSAGE_LIMIT : IN_FLIGHT_LIMIT - CONTROL_RESERVE
      check(reservedBytes <= byteLimit - inFlightBytes, 'ERR_RPC_QUEUE_FULL', 'Worker in-flight byte budget is full')
      entry = { message, controller: new AbortController(), reservedBytes, control }
      check(!pending.has(message.requestId), 'ERR_INVALID_REQUEST', 'duplicate pending Worker request id')
      check(phase !== 'closed' && !closeRequested, 'ERR_CANCELLED', 'Worker is closing or closed')
      if (!identity) {
        check(message.op === 'load' || message.op === 'close', 'ERR_INVALID_REQUEST', 'Worker first request must load a verified pack')
        identity = { workerEpoch: message.workerEpoch, sessionId: message.sessionId }
      } else check(message.op !== 'load', 'ERR_INVALID_REQUEST', 'create a new Worker for every loaded session')
      if (message.op === 'close') {
        closeRequested = true; stopTimers(); closeEntry = entry
        if (running && !running.timer && running.message.op === 'load') running.controller.abort(fail('ERR_CANCELLED', 'Worker closed while loading'))
      } else {
        const count = [...pending.values()].filter(item => item.control === control && item.message.op !== 'close').length
        check(count < (control ? CONTROL_LIMIT : ORDINARY_LIMIT), 'ERR_INVALID_REQUEST', 'Worker request queue is full')
        ;(control ? controls : ordinary).push(entry)
      }
      pending.set(message.requestId, entry)
      inFlightBytes += reservedBytes
      reply(entry, { status: 'queued' })
      scheduleDrain()
      return true
    } catch (error) {
      if (entry && pending.get(entry.message.requestId) === entry) {
        pending.delete(entry.message.requestId)
        inFlightBytes -= entry.reservedBytes
        entry.reservedBytes = 0
        const queue = entry.control ? controls : ordinary
        const index = queue.indexOf(entry)
        if (index !== -1) queue.splice(index, 1)
        if (closeEntry === entry && !channelFailed) closeEntry = null
        entry.controller.abort(error)
      }
      if (message?.kind !== 'cancel' && identifier(message?.requestId, 192) && identifier(message?.sessionId) && identifier(message?.workerEpoch) && identifier(message?.op)) {
        try { reply(entry ?? { message }, { status: 'error', error: { ...diagnostic(error), ...(observationContract && latestObservation ? { observation: latestObservation } : {}) } }) }
        catch { /* A broken postMessage channel cannot accept a second error. */ }
      }
      return false
    }
  }
  return Object.freeze({ receive })
}
