/** Internal default-off accepted-frame reader. No recipe/producer registration.
 * Startup, capability and owner metadata bind the requested engine. This is
 * transport validation, not source or native-presentation attestation. */
import { isDeepStrictEqual } from 'node:util'
import { validateCompletion } from './native-program.mjs'

export const acceptedFrameFieldsV1 = Object.freeze([
  'computed.display', 'computed.flex-direction', 'computed.flex-wrap',
  'computed.opacity', 'computed.visibility',
  'size.viewport-border-aabb.v1', 'offset.viewport-border-aabb.v1',
])
const operation = 'accepted-frame.observe.v1'
const engines = ['quickjs', 'v8']
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const check = (condition, message) => {
  if (!condition) throw Object.assign(new Error(message), { code: 'ACCEPTED_FRAME_OBSERVER_UNAVAILABLE' })
}
const exact = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
const canonical = value => typeof value === 'string' && value && value.trim() === value && !value.includes('\0')
const fields = value => {
  check(Array.isArray(value) && value.length > 0 && value.length <= acceptedFrameFieldsV1.length
    && new Set(value).size === value.length && value.every(name => acceptedFrameFieldsV1.includes(name)),
  'Accepted-frame fields must be unique supported typed selectors')
  return [...value]
}
const route = value => {
  check(canonical(value) && !/[\\?#]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..'),
    'Accepted-frame route must be canonical')
  return value
}
const ownerKeys = ['kind', 'sessionId', 'sessionInstance', 'engine', 'route', 'pageId', 'templateRevision', 'frameId', 'renderRevision']
const owner = (value, binding, completion) => {
  check(exact(value, ownerKeys) && value.kind === 'accepted-frame-owner-v1'
    && value.engine === binding.engine && value.sessionId === binding.sessionId
    && value.sessionInstance === binding.sessionInstance, 'Accepted-frame owner crossed its startup/engine/session binding')
  for (const key of ['route', 'pageId', 'templateRevision', 'frameId', 'renderRevision'])
    check(value[key] === completion[key], `Accepted-frame owner ${key} differs from its actual completion`)
  return structuredClone(value)
}
const handle = (value, current) => {
  check(exact(value, ['kind', 'owner', 'token']) && value.kind === 'accepted-frame-node-v1'
    && sha(value.token) && isDeepStrictEqual(value.owner, current), 'Node handle belongs to another actual accepted frame')
}
const address = value => {
  check(object(value), 'Accepted-frame target must be an explicit address object')
  if (exact(value, ['node'])) return structuredClone(value)
  if (Object.hasOwn(value, 'parent')) {
    check(Object.keys(value).every(key => ['parent', 'selector', 'has'].includes(key))
      && canonical(value.selector) && (!Object.hasOwn(value, 'has') || canonical(value.has)),
    'Parent-addressed query accepts only an actual handle, selector and optional has')
    return structuredClone(value)
  }
  check(exact(value, ['query']) && object(value.query)
    && Object.keys(value.query).every(key => ['selector', 'scope', 'has', 'query'].includes(key))
    && canonical(value.query.selector) && !Object.hasOwn(value.query, 'fields'),
  'Accepted-frame query must keep legacy checkpoint fields outside the versioned typed field list')
  return structuredClone(value)
}
const valueFor = (field, value) => {
  if (field === 'computed.display') check(['block', 'flex', 'none'].includes(value), 'Actual display is missing or unsupported')
  else if (field === 'computed.flex-direction') check(['row', 'row-reverse', 'column', 'column-reverse'].includes(value), 'Actual flex direction is missing')
  else if (field === 'computed.flex-wrap') check(['nowrap', 'wrap', 'wrap-reverse'].includes(value), 'Actual flex wrap is missing')
  else if (field === 'computed.visibility') check(['visible', 'hidden'].includes(value), 'Actual resolved visibility is missing')
  else if (field === 'computed.opacity') check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, 'Actual local opacity is missing')
  else {
    const offset = field.startsWith('offset.')
    const keys = ['coordinateSpace', 'box', 'clipped', 'width', 'height', ...(offset ? ['left', 'top'] : [])]
    check(exact(value, keys) && value.coordinateSpace === 'viewport-css-px' && value.box === 'transformed-border-aabb'
      && value.clipped === false && ['width', 'height', ...(offset ? ['left', 'top'] : [])].every(key => Number.isFinite(value[key]))
      && value.width >= 0 && value.height >= 0, 'Actual geometry lacks the declared coordinate/box semantics')
  }
}

export function createAcceptedFrameObserverV1(request, { requestedEngine, startup, enabled = false, signal } = {}) {
  let pending, previous, binding
  const send = async (op, payload) => {
    if (signal?.aborted) throw signal.reason ?? new Error('Accepted-frame observation aborted')
    const value = await request(op, payload)
    if (signal?.aborted) throw signal.reason ?? new Error('Accepted-frame observation aborted')
    return value
  }
  const declared = structuredClone(startup)
  const validateCapability = value => {
    check(object(value) && value.kind === 'accepted-frame-observation-capabilities-v1' && value.version === 1
      && value.sessionId === declared.sessionId && value.engine === requestedEngine && value.engine === declared.engine
      && sha(value.sessionInstance) && isDeepStrictEqual(value.operations, [operation])
      && isDeepStrictEqual(value.fields, acceptedFrameFieldsV1), 'Accepted-frame capability does not match actual startup and requested engine')
    return { engine: value.engine, sessionId: value.sessionId, sessionInstance: value.sessionInstance }
  }
  const ready = () => pending ??= (async () => {
    check(enabled === true, 'Accepted-frame observer is disabled by default')
    check(engines.includes(requestedEngine) && declared?.status === 'passed'
      && declared.engine === requestedEngine && canonical(declared.sessionId), 'Requested engine differs from actual immutable startup')
    const startupBinding = validateCapability(declared.acceptedFrameObservation)
    const capability = await send('accepted-frame.capabilities.v1', { version: 1 })
    binding = validateCapability(capability)
    check(isDeepStrictEqual(binding, startupBinding), 'Runtime capability changed its actual startup instance')
    previous = validateCompletion(capability.completion)
    check(previous.sessionId === binding.sessionId, 'Capability completion belongs to another session')
    return structuredClone(binding)
  })()
  return {
    ready,
    async observe({ route: requestedRoute, target, fields: requestedFields } = {}) {
      await ready()
      const selected = fields(requestedFields), actualTarget = address(target), path = route(requestedRoute)
      for (const incoming of [actualTarget.node, actualTarget.parent].filter(Boolean)) {
        handle(incoming, incoming.owner)
        check(exact(incoming.owner, ownerKeys) && incoming.owner.engine === binding.engine
          && incoming.owner.sessionId === binding.sessionId && incoming.owner.sessionInstance === binding.sessionInstance,
        'Input node handle crossed its actual startup/engine/session binding')
      }
      const value = await send(operation, { version: 1, route: path, target: actualTarget, fields: selected })
      check(value?.kind === 'accepted-frame-observation-v1' && value.version === 1
        && isDeepStrictEqual(value.target, actualTarget) && isDeepStrictEqual(value.fields, selected), 'Accepted-frame response changed its selected address/fields')
      const completion = validateCompletion(value.completion, previous)
      check(completion.route === path, 'Accepted-frame response changed its actual route')
      const current = owner(value.owner, binding, completion)
      if (actualTarget.node) handle(actualTarget.node, current)
      if (actualTarget.parent) handle(actualTarget.parent, current)
      check(Number.isSafeInteger(value.count) && value.count >= 0 && Array.isArray(value.nodes)
        && value.nodes.length === value.count && value.count <= 4096, 'Accepted-frame result has incomplete actual node counts')
      if (Object.hasOwn(actualTarget, 'node')) check(value.count === 1
        && isDeepStrictEqual(value.nodes[0]?.handle, actualTarget.node),
      'Accepted-frame exact node address must return one matching handle')
      const tokens = new Set()
      for (const node of value.nodes) {
        check(exact(node, ['handle', 'parent', 'metadata', 'values']), 'Accepted-frame node has unknown or missing fields')
        handle(node.handle, current)
        if (node.parent !== null) handle(node.parent, current)
        check(!tokens.has(node.handle.token), 'Actual frame repeats a node handle'); tokens.add(node.handle.token)
        check(object(node.metadata) && exact(node.values, selected), 'Actual node lacks requested values')
        for (const field of selected) valueFor(field, node.values[field])
      }
      previous = completion
      return structuredClone(value)
    },
  }
}
