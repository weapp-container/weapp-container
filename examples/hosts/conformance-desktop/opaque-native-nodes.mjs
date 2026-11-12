/** Explicit default-off native node acquisition/input transport. A public WXML
 * id is metadata only. Every effect uses the actual opaque accepted-frame node. */
import { isDeepStrictEqual } from 'node:util'
const ACQUIRE = 'accepted-frame.nodes.acquire.v1', TAP = 'accepted-frame.nodes.tap.v1'
const CAPABILITIES = 'accepted-frame.nodes.capabilities.v1'
const ownerKeys = ['kind', 'sessionId', 'sessionInstance', 'engine', 'route', 'pageId', 'templateRevision', 'frameId', 'renderRevision']
const require = (condition, message) => { if (!condition) throw Object.assign(new Error(message), { code: 'NATIVE_OPAQUE_NODE_PROVENANCE_FAILED' }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const address = value => typeof value === 'string' && value && value.trim() === value && !value.includes('\0')
const routeOf = value => { require(address(value) && !/[\\?#]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..'), 'Opaque node route is not canonical'); return value }
const decimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n
export function createOpaqueNativeNodes(request, { enabled = false, requestedEngine, startup, acceptCompletion, signal } = {}) {
  const declared = structuredClone(startup); let binding, ready
  const send = async (operation, payload) => {
    if (signal?.aborted) throw signal.reason ?? new Error('Opaque node input aborted')
    const actual = await request(operation, structuredClone(payload))
    if (signal?.aborted) throw signal.reason ?? new Error('Opaque node input aborted')
    return actual
  }
  const capability = (value, runtime = false) => {
    const keys = ['kind', 'version', 'engine', 'sessionId', 'sessionInstance', 'operations', 'selection', 'inputTransport', ...(runtime ? ['completion'] : [])]
    require(exact(value, keys) && value.kind === 'accepted-frame-node-capabilities-v1' && value.version === 1
      && value.engine === requestedEngine && value.engine === declared.engine && value.sessionId === declared.sessionId && sha(value.sessionInstance)
      && isDeepStrictEqual(value.operations, [ACQUIRE, TAP]) && isDeepStrictEqual(value.selection, ['first', 'all'])
      && value.inputTransport === 'native-host-coordinate-event', 'Opaque node capability differs from actual startup/engine/session')
    return { engine: value.engine, sessionId: value.sessionId, sessionInstance: value.sessionInstance }
  }
  const owner = (value, completion) => {
    require(exact(value, ownerKeys) && value.kind === 'accepted-frame-owner-v1'
      && value.engine === binding.engine && value.sessionId === binding.sessionId && value.sessionInstance === binding.sessionInstance,
    'Opaque node owner crosses its actual startup/engine/session')
    for (const key of ['pageId', 'templateRevision', 'frameId', 'renderRevision']) require(decimal(value[key]), `Opaque node owner ${key} is not canonical u64`)
    routeOf(value.route)
    if (completion) for (const key of ['sessionId', 'route', 'pageId', 'templateRevision', 'frameId', 'renderRevision']) require(value[key] === completion[key], `Opaque node owner ${key} differs from actual completion`)
    return value
  }
  const handle = (value, current) => {
    require(exact(value, ['kind', 'owner', 'token']) && value.kind === 'accepted-frame-node-v1' && sha(value.token), 'Opaque node handle is malformed')
    owner(value.owner)
    if (current) require(isDeepStrictEqual(value.owner, current), 'Opaque node handle belongs to another actual accepted generation')
  }
  const prepareTarget = target => {
    if (object(target) && Object.hasOwn(target, 'parent')) {
      require(Object.keys(target).every(key => ['parent', 'selector', 'has'].includes(key)) && address(target.selector)
        && (target.has === undefined || address(target.has)), 'Opaque parent query has unknown/missing address fields')
      handle(target.parent); return structuredClone(target)
    }
    require(exact(target, ['query']) && object(target.query) && address(target.query.selector)
      && Object.keys(target.query).every(key => ['selector', 'query', 'scope', 'has'].includes(key))
      && (target.query.query === undefined || target.query.query === 'css')
      && (target.query.has === undefined || address(target.query.has)), 'Opaque node query has unsupported addresses or expected fields')
    if (target.query.scope !== undefined) require(Array.isArray(target.query.scope) && target.query.scope.every(part => address(part) || exact(part, ['has']) && address(part.has)), 'Opaque node query has malformed typed scope')
    return structuredClone(target)
  }
  const page = (value, completion) => require(value && decimal(value.pageId) && value.route === routeOf(value.route)
    && value.pageId === completion.pageId && value.route === completion.route && completion.sessionId === binding.sessionId,
  'Opaque node result belongs to another actual Page incarnation')
  const start = () => ready ??= (async () => {
    require(enabled === true && ['quickjs', 'v8'].includes(requestedEngine) && declared?.status === 'passed'
      && declared.engine === requestedEngine && address(declared.sessionId) && typeof acceptCompletion === 'function', 'Opaque node transport is disabled or lacks an actual startup/completion binding')
    const initial = capability(declared.acceptedFrameNodes)
    const actual = await send(CAPABILITIES, { version: 1 })
    binding = capability(actual, true)
    require(isDeepStrictEqual(binding, initial), 'Opaque node capability changed its actual Session instance')
    const completion = acceptCompletion(actual.completion)
    require(completion.sessionId === binding.sessionId, 'Opaque capability completion belongs to another Session')
    return structuredClone(binding)
  })()
  return {
    ready: start,
    async acquire(actualPage, target, selection) {
      await start(); require(['first', 'all'].includes(selection), 'Opaque node selection is not first/all')
      const selected = prepareTarget(target), route = routeOf(actualPage.route)
      if (selected.parent) require(selected.parent.owner.route === route && selected.parent.owner.pageId === actualPage.pageId, 'Opaque parent belongs to another Page')
      const value = await send(ACQUIRE, { version: 1, route, target: selected, selection })
      require(exact(value, ['kind', 'version', 'owner', 'target', 'selection', 'matchCount', 'count', 'nodes', 'completion'])
        && value.kind === 'accepted-frame-node-acquisition-v1' && value.version === 1
        && isDeepStrictEqual(value.target, selected) && value.selection === selection, 'Opaque acquisition changed the original address/selection')
      page(actualPage, value.completion); const current = owner(value.owner, value.completion)
      if (selected.parent) handle(selected.parent, current)
      require(Number.isSafeInteger(value.matchCount) && value.matchCount >= 0 && value.matchCount <= 4096
        && Number.isSafeInteger(value.count) && value.count === (selection === 'first' ? Math.min(value.matchCount, 1) : value.matchCount)
        && Array.isArray(value.nodes) && value.nodes.length === value.count, 'Opaque acquisition has incomplete actual match/selection counts')
      const tokens = new Set()
      for (const node of value.nodes) {
        require(exact(node, ['handle', 'parent', 'metadata']) && exact(node.metadata, ['id', 'publicId', 'tag', 'eventIdentity', 'componentScopeId', 'eventOwnerScopeId'])
          && typeof node.metadata.id === 'string' && ['publicId', 'tag', 'eventIdentity', 'componentScopeId', 'eventOwnerScopeId'].every(key => node.metadata[key] === null || typeof node.metadata[key] === 'string'), 'Opaque acquired node metadata is malformed')
        handle(node.handle, current); if (node.parent !== null) handle(node.parent, current)
        require(!tokens.has(node.handle.token), 'Opaque acquisition repeats an actual handle'); tokens.add(node.handle.token)
      }
      acceptCompletion(value.completion)
      return structuredClone(value)
    },
    async tap(actualPage, node) {
      await start(); handle(node)
      require(node.owner.route === routeOf(actualPage.route) && node.owner.pageId === actualPage.pageId, 'Opaque tap handle crosses its original Page')
      const selected = structuredClone(node), value = await send(TAP, { version: 1, route: actualPage.route, node: selected })
      require(exact(value, ['kind', 'version', 'route', 'node', 'owner', 'x', 'y', 'frameId', 'renderRevision', 'inputTransport', 'inputCompletion', 'completion'])
        && value.kind === 'accepted-frame-node-tap-v1' && value.version === 1 && value.route === actualPage.route
        && isDeepStrictEqual(value.node, selected) && isDeepStrictEqual(value.owner, selected.owner)
        && value.inputTransport === 'native-host-coordinate-event' && Number.isFinite(value.x) && Number.isFinite(value.y)
        && value.frameId === value.inputCompletion?.frameId && value.renderRevision === value.inputCompletion?.renderRevision,
      'Opaque tap lacks its exact handle and actual coordinate-input proof')
      owner(value.owner, value.inputCompletion); handle(selected, value.owner)
      const input = acceptCompletion(value.inputCompletion); page(actualPage, input)
      const completion = acceptCompletion(value.completion, { action: true }); page(actualPage, completion)
      return structuredClone(value)
    },
  }
}
