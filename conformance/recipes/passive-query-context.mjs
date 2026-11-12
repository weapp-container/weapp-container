import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'

/** Keep one provider operation's internal calls in its own async lineage.
 * A concurrent caller outside that lineage has no active store. A callback
 * that outlives the operation also loses internal status when it settles.
 * This is an observation boundary for a trusted provider, not a sandbox. */
export function createPassiveQueryContext() {
  const storage = new AsyncLocalStorage()
  const identities = new WeakMap(), events = []
  let calls = 0, objects = 0, dropped = 0, clippedStrings = 0, clippedScopes = 0, closed = false
  const bounded = text => {
    if (typeof text !== 'string') return undefined
    if (text.length > 256) clippedStrings++
    return text.slice(0, 256)
  }
  const identity = value => {
    if (!value || typeof value !== 'object' && typeof value !== 'function') return { type: typeof value }
    if (!identities.has(value)) identities.set(value, ++objects)
    const result = { object: identities.get(value) }
    // Own data only: metadata capture cannot invoke a provider getter or a
    // Proxy trap. Object identity still works when metadata is unavailable.
    if (types.isProxy(value)) return { ...result, opaque: true }
    try {
      const fields = {}
      for (const name of ['id', 'pageId', 'nodeId', 'tagName']) {
        const own = Object.getOwnPropertyDescriptor(value, name)
        if (!own || !Object.hasOwn(own, 'value')) continue
        const field = own.value
        if (field === null || typeof field === 'boolean' || typeof field === 'number' && Number.isFinite(field)) fields[name] = field
        else if (typeof field === 'string') fields[name] = bounded(field)
      }
      return { ...result, fields }
    } catch { return { ...result, unavailable: true } }
  }
  const record = event => {
    if (events.length < 256) events.push({ seq: events.length, ...event })
    else dropped++
  }
  const options = value => {
    if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined
    const result = {}
    for (const key of ['fallback', 'routeOnly', 'timeout']) {
      const own = Object.getOwnPropertyDescriptor(value, key)
      if (own && Object.hasOwn(own, 'value') && (typeof own.value === 'boolean'
        || typeof own.value === 'number' && Number.isFinite(own.value))) result[key] = own.value
    }
    return result
  }
  const returned = value => {
    const result = identity(value)
    if (!Array.isArray(value) || types.isProxy(value)) return result
    const length = Object.getOwnPropertyDescriptor(value, 'length').value
    result.count = length
    result.elements = []
    for (let index = 0; index < Math.min(length, 16); index++) {
      const own = Object.getOwnPropertyDescriptor(value, index)
      result.elements.push(own && Object.hasOwn(own, 'value') ? identity(own.value) : { unavailable: true })
    }
    return result
  }
  return {
    internal: () => !closed && storage.getStore()?.active === true,
    binding({ element, info, query, scope, acquisition, canonical, previous }) {
      const binding = (value, generation) => value && ({ owner: identity(value.owner), page: identity(value.page),
        route: bounded(value.route), launch: value.launch, epoch: value.epoch, acquisition: generation })
      record({ phase: 'binding', element: identity(element), selector: bounded(query),
        scope: scope.slice(0, 16).map(bounded), canonical,
        attempted: binding(info, acquisition), previous: binding(previous?.info, previous?.acquisition) })
    },
    async run(invoke, detail = {}) {
      if (closed) return await invoke()
      const inherited = storage.getStore(), parent = inherited?.active ? inherited : undefined
      const call = ++calls, root = parent?.root ?? { active: true, call }
      if (Array.isArray(detail.scope) && detail.scope.length > 16) clippedScopes++
      const context = { root, call, get active() { return root.active } }
      const before = { call, root: root.call, parent: parent?.call ?? null, internal: !!parent,
        operation: bounded(detail.operation), selector: bounded(detail.selector),
        scope: Array.isArray(detail.scope) ? detail.scope.slice(0, 16).map(bounded) : undefined,
        owner: detail.owner ? identity(detail.owner) : undefined, page: detail.page ? identity(detail.page) : undefined,
        route: bounded(detail.route), launch: detail.launch, epoch: detail.epoch, acquisition: detail.acquisition,
        options: options(detail.options) }
      record({ phase: 'begin', ...before })
      return await storage.run(context, async () => {
        try {
          const result = await invoke()
          record({ phase: 'return', call, root: root.call, result: returned(result) })
          return result
        } catch (error) {
          record({ phase: 'throw', call, root: root.call, errorType: typeof error })
          throw error
        } finally { if (!parent) root.active = false }
      })
    },
    close() { if (!closed) { closed = true; storage.disable() } },
    snapshot: () => ({ schemaVersion: 1, kind: 'passive-provider-operation-diagnostics',
      boundary: 'Public provider call lineage and safe own-data object metadata; no raw IPC capture or semantic verdict.',
      limits: { events: 256, stringLength: 256, scopeDepth: 16, returnedArrayElements: 16 }, dropped, clippedStrings, clippedScopes, closed,
      events: JSON.parse(JSON.stringify(events)) }),
  }
}
