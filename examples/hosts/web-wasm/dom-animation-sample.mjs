/** Session-owned numeric samples only. This module never reads a clock or
 * evaluates View code, and never installs a CSS animation/transition. */
export class DomAnimationSampleError extends Error {
  constructor(message) { super(message); this.name = 'DomAnimationSampleError'; this.code = 'ERR_PROTOCOL_VERSION' }
}
const invalid = message => { throw new DomAnimationSampleError(message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) } return value }
export const sameAnimationKey = (a, b) => object(a) && object(b) && ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile'].every(k => a[k] === b[k])
export const sameConsumedSample = (a, b) => object(a) && object(b) && a.demandRevision === b.demandRevision && a.sampleRevision === b.sampleRevision
const exact = (value, fields, name) => {
  if (!object(value) || Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value, k))) invalid(`invalid ${name} shape`)
}
export function animationU64(value) {
  if (typeof value !== 'string' || value.length > 20 || !/^(?:0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 18446744073709551615n) invalid('animation revision requires a canonical u64')
  return value
}
function animationKey(value) {
  exact(value, ['sessionId', 'pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration', 'profile'], 'animation presentation key')
  if (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 4096 || value.profile !== 'webview') invalid('invalid animation presentation key')
  for (const name of ['pageId', 'documentRevision', 'presentationRevision', 'surfaceGeneration']) animationU64(value[name])
  return value
}
function occurrence(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) invalid('invalid animation occurrence')
  return value
}
function matrix(value) {
  exact(value, ['a', 'b', 'c', 'd', 'tx', 'ty'], 'affine transform')
  if (Object.values(value).some(x => !Number.isFinite(x))) invalid('animation transform must be finite')
  return { ...value }
}
function opacity(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) invalid('animation opacity must be finite in [0,1]')
  return value
}
function origin(value) {
  if (typeof value !== 'string' || !value || value.length > 256) invalid('invalid animation origin')
  const parts = value.trim().split(/\s+/)
  if (parts.length < 1 || parts.length > 3 || parts.some((part, i) => i === 2
    ? !/^[-+]?0(?:\.0+)?(?:px)?$/i.test(part)
    : !/^(?:left|right|top|bottom|center|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:px|%)?|[-+]?0)$/i.test(part))) invalid('animation origin must be a typed 2D CSS origin')
  return value
}
export function copyAnimationStyles(value, expectedIds) {
  if (!Array.isArray(value) || value.length > 100000 || new TextEncoder().encode(JSON.stringify(value)).byteLength > 16 * 1024 * 1024) invalid('animation style budget exceeded')
  const seen = new Set(), result = value.map(item => {
    exact(item, ['occurrenceId', 'opacity', 'transform', 'origin'], 'animation style')
    const id = occurrence(item.occurrenceId)
    if (seen.has(id)) invalid('duplicate animation occurrence')
    seen.add(id)
    return { occurrenceId: id, opacity: item.opacity === null ? null : opacity(item.opacity),
      transform: item.transform === null ? null : matrix(item.transform), origin: item.origin === null ? null : origin(item.origin) }
  })
  if (expectedIds && (seen.size !== expectedIds.length || expectedIds.some(id => !seen.has(id)))) invalid('animation styles do not cover the exact requested occurrences')
  return freeze(result)
}
export function copyAnimationRequest(value) {
  if (value === undefined) return undefined
  exact(value, ['version', 'requestId', 'baselines', 'styles'], 'animation baseline request')
  if (value.version !== '1.0' || typeof value.requestId !== 'string' || !value.requestId || value.requestId.length > 4096
    || !Array.isArray(value.baselines) || value.baselines.length > 100000
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > 16 * 1024 * 1024) invalid('invalid animation baseline request')
  const baselines = value.baselines.map(item => {
    exact(item, ['occurrenceId', 'opacity', 'transform'], 'animation baseline descriptor')
    if (typeof item.opacity !== 'boolean' || typeof item.transform !== 'boolean') invalid('animation baseline descriptor flags must be booleans')
    return { occurrenceId: occurrence(item.occurrenceId), opacity: item.opacity, transform: item.transform }
  })
  const baselineIds = new Set(baselines.map(item => item.occurrenceId))
  if (baselineIds.size !== baselines.length) invalid('duplicate animation baseline occurrence')
  const styles = copyAnimationStyles(value.styles)
  const requests = new Map(baselines.map(item => [item.occurrenceId, item]))
  for (const style of styles) {
    const request = requests.get(style.occurrenceId)
    if (request && (request.opacity && style.opacity !== null
      || request.transform && (style.transform !== null || style.origin !== null))) invalid('provisional styles overwrite an unbound baseline property')
  }
  return freeze({ version: '1.0', requestId: value.requestId, baselines, styles })
}
export function copyConsumedSample(value) {
  exact(value, ['demandRevision', 'sampleRevision'], 'consumed animation sample')
  return freeze({ demandRevision: animationU64(value.demandRevision), sampleRevision: animationU64(value.sampleRevision) })
}
export function copySamplePermit(value, submission) {
  exact(value, ['version', 'key', 'baseKey', 'baseGeometryEpoch', 'consumedSample', 'permitId'], 'retained sample permit')
  animationKey(value.key); animationKey(value.baseKey); animationU64(value.baseGeometryEpoch); copyConsumedSample(value.consumedSample)
  if (value.version !== '1.0' || !sameAnimationKey(value.key, submission.key) || !sameAnimationKey(value.baseKey, submission.baseKey)
    || value.baseGeometryEpoch !== submission.baseGeometryEpoch || !sameConsumedSample(value.consumedSample, submission.consumedSample)
    || typeof value.permitId !== 'string' || !value.permitId || value.permitId.length > 4096) invalid('sample permit does not authorize the exact cloned sample')
  return freeze(structuredClone(value))
}
export function copySampleSubmission(value, baseKey, baseGeometryEpoch, demandRevision) {
  exact(value, ['version', 'key', 'baseKey', 'baseGeometryEpoch', 'consumedSample', 'viewport', 'styles'], 'retained sample submission')
  animationKey(value.key); animationKey(value.baseKey); animationU64(value.baseGeometryEpoch)
  if (value.version !== '1.0' || !sameAnimationKey(value.baseKey, baseKey) || value.baseGeometryEpoch !== baseGeometryEpoch
    || !object(value.key) || !['sessionId', 'pageId', 'documentRevision', 'surfaceGeneration', 'profile'].every(k => value.key[k] === baseKey[k])
    || BigInt(animationU64(value.key.presentationRevision)) <= BigInt(animationU64(baseKey.presentationRevision))) invalid('sample submission does not retain the exact accepted topology')
  const consumedSample = copyConsumedSample(value.consumedSample)
  if (BigInt(consumedSample.demandRevision) < BigInt(animationU64(demandRevision))) invalid('retained sample consumed an older demand')
  exact(value.viewport, ['width', 'height'], 'sample viewport')
  if (!Object.values(value.viewport).every(x => Number.isFinite(x) && x > 0 && x <= 4096)) invalid('invalid retained sample viewport')
  return freeze({ ...structuredClone(value), consumedSample, styles: copyAnimationStyles(value.styles) })
}

/** A computed transform matrix excludes transform-origin; preserve both facts. */
export function computedAnimationBaseline(descriptor, computed) {
  exact(descriptor, ['occurrenceId', 'opacity', 'transform'], 'animation baseline descriptor')
  if (typeof descriptor.opacity !== 'boolean' || typeof descriptor.transform !== 'boolean') invalid('invalid animation baseline property request')
  const font = typeof computed?.fontSize === 'string' && /^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)px$/i.exec(computed.fontSize.trim())
  const fontSize = font && Number(font[1])
  if (!Number.isFinite(fontSize) || fontSize < 0) invalid('computed animation fontSize must resolve to nonnegative pixels')
  let result = { occurrenceId: occurrence(descriptor.occurrenceId), opacity: descriptor.opacity ? opacity(Number(computed?.opacity)) : null, transform: null, fontSize, origin: null }
  if (descriptor.opacity && (typeof computed?.opacity !== 'string' || !computed.opacity.trim())) invalid('missing computed animation opacity')
  if (!descriptor.transform) return freeze(result)
  const text = computed?.transform
  let transform
  if (text === 'none') transform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
  else {
    const match = typeof text === 'string' && /^matrix\(([^)]+)\)$/.exec(text)
    const values = match?.[1].split(',').map(x => x.trim() === '' ? NaN : Number(x.trim()))
    if (!values || values.length !== 6 || values.some(x => !Number.isFinite(x))) invalid('computed animation baseline requires an actual affine 2D transform')
    transform = Object.fromEntries(['a', 'b', 'c', 'd', 'tx', 'ty'].map((k, i) => [k, values[i]]))
  }
  const parts = typeof computed?.transformOrigin === 'string' ? computed.transformOrigin.trim().split(/\s+/) : []
  if (parts.length < 2 || parts.length > 3 || parts.some(x => !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?px$/i.test(x))) invalid('computed animation origin must resolve to pixels')
  const [x, y, z = 0] = parts.map(v => Number.parseFloat(v))
  if (![x, y, z].every(Number.isFinite) || z !== 0) invalid('computed animation origin must be finite and 2D')
  return freeze({ ...result, transform, origin: { x, y } })
}

/** Validates the complete patch before writing. Undo is registered before each
 * setter, including a setter which mutates and then throws. */
export function stageAnimationStyles(styles, { elementFor, document, isCurrent = () => true, supports = () => true }) {
  styles = copyAnimationStyles(styles)
  const operations = []
  const current = () => { if (isCurrent() !== true) invalid('animation sample no longer owns its retained surface') }
  for (const item of styles) {
    const node = elementFor(item.occurrenceId)
    if (node?.nodeType !== 1 || node.ownerDocument !== document || !node.isConnected || !node.style?.setProperty
      || !node.style?.getPropertyValue || !node.style?.getPropertyPriority || !node.style?.removeProperty) invalid('animation target is not the exact connected retained element')
    const properties = []
    if (item.opacity !== null) properties.push(['opacity', String(item.opacity)])
    if (item.transform !== null) properties.push(['transform', `matrix(${['a', 'b', 'c', 'd', 'tx', 'ty'].map(k => item.transform[k]).join(',')})`])
    if (item.origin !== null) properties.push(['transform-origin', item.origin])
    for (const [name, value] of properties) {
      if (supports(name, value) !== true) invalid(`unsupported sampled ${name}`)
      operations.push({ node, id: item.occurrenceId, name, value, before: node.style.getPropertyValue(name), priority: node.style.getPropertyPriority(name) })
    }
  }
  const undo = []
  let state = 'prepared', rollbackFailure
  const rollback = () => {
    if (rollbackFailure) throw rollbackFailure
    if (state === 'acknowledged') invalid('an acknowledged animation sample cannot roll back')
    const failures = []
    for (const op of undo.splice(0).reverse()) try {
      if (op.before === '') op.node.style.removeProperty(op.name)
      else op.node.style.setProperty(op.name, op.before, op.priority)
    } catch (failure) { failures.push(failure) }
    state = failures.length ? 'rollback-failed' : 'rolled-back'
    if (failures.length) { rollbackFailure = Object.assign(new DomAnimationSampleError('animation style rollback failed'), { cleanupErrors: failures }); throw rollbackFailure }
  }
  return Object.freeze({
    get state() { return state },
    apply() {
      if (state !== 'prepared') invalid('animation style sample has already been consumed')
      try {
        current()
        for (const op of operations) {
          if (elementFor(op.id) !== op.node || op.node.ownerDocument !== document || !op.node.isConnected
            || op.node.style.getPropertyValue(op.name) !== op.before || op.node.style.getPropertyPriority(op.name) !== op.priority) invalid('retained animation target/style changed after staging')
        }
        state = 'applying'
        for (const op of operations) {
          current()
          if (elementFor(op.id) !== op.node || op.node.ownerDocument !== document || !op.node.isConnected) invalid('animation target identity changed during mutation')
          undo.push(op); op.node.style.setProperty(op.name, op.value, 'important'); current()
          if (elementFor(op.id) !== op.node || op.node.ownerDocument !== document || !op.node.isConnected) invalid('animation target identity changed during mutation')
        }
        state = 'applied'
      } catch (failure) {
        try { rollback() } catch (cleanup) { failure.cleanupErrors = [...(failure.cleanupErrors ?? []), cleanup] }
        throw failure
      }
    },
    rollback,
    acknowledge() { if (state !== 'applied') invalid('only an applied sample can acknowledge'); state = 'acknowledged'; undo.length = 0 },
  })
}
