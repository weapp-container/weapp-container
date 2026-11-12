/** Passive observation of the unchanged #1034 route loop. A completed original
 * tap establishes the original poll's preceding actual read boundary. Expected
 * text remains in the unchanged assertions, never in this evidence producer. */
import { descriptor } from './issue1034-descriptor.mjs'

const routeOf = value => {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\\?#]/.test(value)) throw new Error('Issue1034 actual Page route is malformed')
  const route = value.replace(/^\/+|\/+$/g, '')
  if (!route || route.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Issue1034 actual Page route is not canonical')
  return route
}
const sameScope = (left, right) => Array.isArray(left) && left.length === right.length && right.every((part, index) => left[index] === part)
const emptyScope = value => value === undefined || sameScope(value, [])

export function createCollector({ emit }) {
  const programs = new WeakMap(), pages = new WeakMap(), elements = new WeakMap(), restores = [], acquisitions = []
  const ownership = Symbol('issue1034-observed-transport-owner')
  let checkpoints = 0, taps = 0, launches = 0, pendingOperations = 0, active, transportOwner, sourceRead, pendingTap, closed = false, failure
  const fail = error => { failure ??= error; throw error }
  const require = (condition, message) => { if (!condition) fail(new Error(message)) }
  const healthy = () => { if (failure) throw failure }
  const publish = event => { try { emit(event) } catch (error) { fail(error) } }
  const current = info => info && info === active && info.owner === transportOwner && info.epoch === info.owner.epoch
    && routeOf(info.page.path) === info.route
  const wrap = (target, key, factory) => {
    require(typeof target?.[key] === 'function', `Issue1034 provider has no ${key} operation`)
    const own = Object.getOwnPropertyDescriptor(target, key), original = target[key], wrapped = factory(original)
    Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapped })
    restores.push(() => {
      if (target[key] !== wrapped) return
      if (own) Object.defineProperty(target, key, own)
      else delete target[key]
    })
  }
  const observeElement = (element, info, scope, selector) => {
    if (element == null) return element
    require(typeof element === 'object' && typeof selector === 'string' && selector && current(info),
      'Issue1034 actual Element has no current observed Page or query identity')
    const previous = elements.get(element)
    require(acquisitions.length < 8192, 'Issue1034 actual query acquisition journal overflowed')
    const acquisition = { ordinal: acquisitions.length, route: info.route, epoch: info.epoch, selector, scope: [...scope],
      prior: previous ? { route: previous.info.route, epoch: previous.info.epoch, selector: previous.selector,
        scope: [...previous.scope], sameOwner: previous.info.owner === info.owner, inFlight: previous.inFlight } : null,
      accepted: false }
    acquisitions.push(acquisition)
    if (previous) {
      require(previous.info.owner === info.owner && previous.inFlight === 0 && !pendingTap
        && (previous.info === info || previous.info.epoch < info.epoch && !current(previous.info)),
      'Issue1034 actual Element acquisition crosses an owner, active generation or pending operation')
      // Query identity belongs to a successful acquisition, not to the SDK's
      // cached Element object: different selectors can match the same node.
      // Keep the actual object and use the latest settled query's context.
      // This recipe observes the original immediate awaited query -> method
      // flow; it does not infer which JS variable later refers to a cache hit.
      elements.set(element, { info, scope: [...scope], selector, inFlight: 0 })
      acquisition.accepted = true
      return element
    }
    elements.set(element, { info, scope: [...scope], selector, inFlight: 0 })
    acquisition.accepted = true
    if (typeof element.$ === 'function') wrap(element, '$', original => async function (childSelector, ...args) {
      const binding = elements.get(element)
      binding.inFlight++; pendingOperations++
      try {
        const child = await Reflect.apply(original, this, [childSelector, ...args])
        try {
          healthy()
          require(this === element && elements.get(element) === binding && current(binding.info),
            'Issue1034 child query completed across an actual Element acquisition')
          return observeElement(child, binding.info, [...binding.scope, binding.selector], childSelector)
        } catch (error) { failure ??= error; return child }
      } finally { binding.inFlight--; pendingOperations-- }
    })
    if (typeof element.text === 'function') wrap(element, 'text', original => async function (...args) {
      const binding = elements.get(element), { info, scope, selector } = binding
      const before = { checkpoints, taps, pendingTap }
      binding.inFlight++; pendingOperations++
      try {
        const result = await Reflect.apply(original, this, args)
        try {
          healthy()
          require(!closed && this === element && elements.get(element) === binding && current(info),
            'Issue1034 text read belongs to another Page generation, acquisition or transport')
          if (selector === descriptor.pollSelector && scope.length === 0 && before.taps === before.checkpoints) {
            require(typeof result === 'string', 'Issue1034 actual source text read is not a string')
            require(!before.pendingTap && !pendingTap && before.checkpoints === checkpoints && before.taps === taps,
              'Issue1034 source read completed across an original action boundary')
            sourceRead = { info, checkpoint: checkpoints, text: result }
          }
        } catch (error) { failure ??= error }
        return result
      } finally { binding.inFlight--; pendingOperations-- }
    })
    if (typeof element.tap === 'function') wrap(element, 'tap', original => async function (...args) {
      const binding = elements.get(element), { info, scope, selector } = binding
      const before = { checkpoints, taps, launches, active, sourceRead, pendingTap }
      const token = {}
      pendingTap = token
      binding.inFlight++; pendingOperations++
      let route, routeFailure
      try { route = routeOf(info.page.path) } catch (error) { routeFailure = error }
      let result
      try { result = await Reflect.apply(original, this, args) }
      finally { binding.inFlight--; pendingOperations--; if (pendingTap === token) pendingTap = undefined }
      try {
        healthy()
        if (routeFailure) fail(routeFailure)
        const planned = descriptor.checkpoints[checkpoints]
        require(!closed && this === element && elements.get(element) === binding && !before.pendingTap && !pendingTap
          && planned && selector === descriptor.tapSelector && scope.length === 0
          && before.checkpoints === checkpoints && before.taps === taps && taps === checkpoints
          && before.launches === launches && launches === checkpoints + 1,
        'Issue1034 successful tap is outside its original launch/checkpoint interval or scope')
        require(current(info) && before.active === info && route === planned.route && info.route === route,
          'Issue1034 successful tap belongs to another actual Page generation or route')
        require(before.sourceRead && before.sourceRead.info === info && before.sourceRead.checkpoint === checkpoints,
          'Issue1034 successful tap has no preceding actual source read from this launch')
        sourceRead = undefined
        taps++
        publish({ kind: 'render', op: 'query.text', payload: { route, selector: descriptor.pollSelector, text: before.sourceRead.text } })
        publish({ kind: 'event', op: 'tap', payload: { route, selector } })
      } catch (error) { failure ??= error }
      return result
    })
    return element
  }
  const observeLaunch = (page, owner, before) => {
    healthy()
    const planned = descriptor.checkpoints[checkpoints]
    require(!closed && owner === transportOwner && page && typeof page === 'object', 'Issue1034 reLaunch has no current actual Page transport')
    const route = routeOf(page.path)
    require(planned && route === planned.route && !pendingTap && checkpoints === before.checkpoints && taps === before.taps
      && launches === before.launches && owner.epoch === before.epoch && launches === checkpoints && taps === checkpoints,
    'Issue1034 successful reLaunch is outside the original route/checkpoint interval')
    const info = { page, owner, route, epoch: ++owner.epoch }
    if (!pages.has(page)) wrap(page, '$', original => async function (selector, ...args) {
      const acquired = pages.get(page)
      pendingOperations++
      try {
        const element = await Reflect.apply(original, this, [selector, ...args])
        try {
          healthy()
          require(this === page && pages.get(page) === acquired && current(acquired),
            'Issue1034 actual query has no current observed Page acquisition')
          return observeElement(element, acquired, [], selector)
        } catch (error) { failure ??= error; return element }
      } finally { pendingOperations-- }
    })
    pages.set(page, info)
    active = info; sourceRead = undefined; launches++
    publish({ kind: 'lifecycle', op: 'route.active', payload: { route } })
    return page
  }
  return {
    diagnostics: () => ({ kind: 'issue1034-actual-query-acquisitions-v1', acquisitions: structuredClone(acquisitions) }),
    attach(program) {
      healthy()
      require(!closed && program && typeof program === 'object', 'Issue1034 attachment has no open actual MiniProgram')
      if (programs.has(program)) return
      const owner = { program, epoch: 0 }
      programs.set(program, owner)
      Object.defineProperty(program, ownership, { configurable: true, value: owner })
      restores.push(() => { if (program[ownership] === owner) delete program[ownership] })
      transportOwner = owner; active = undefined; sourceRead = undefined
      wrap(program, 'reLaunch', original => async function (...args) {
        const before = { checkpoints, taps, launches, epoch: owner.epoch }
        pendingOperations++
        try {
          const page = await Reflect.apply(original, this, args)
          try { return observeLaunch(page, owner, before) }
          catch (error) { failure ??= error; return page }
        } finally { pendingOperations-- }
      })
    },
    checkpoint(observation, context) {
      healthy()
      require(!closed, 'Issue1034 checkpoint arrived after collector flush')
      const evidence = observation?.evidence, planned = descriptor.checkpoints[checkpoints]
      require(planned && evidence?.id === planned.id, 'Issue1034 actual checkpoints are missing, duplicated or out of order')
      let route, info, contextOwner
      try { route = routeOf(evidence.route); info = context === undefined ? active : pages.get(context?.page); contextOwner = context?.session?.[ownership] }
      catch (error) { fail(error) }
      require(current(info) && route === planned.route && info.route === route && (context === undefined || contextOwner === info.owner)
        && launches === checkpoints + 1 && taps === checkpoints + 1 && !pendingTap,
      'Issue1034 checkpoint lacks its actual Page, session, route, launch or completed tap')
      require(Array.isArray(evidence.nodes) && evidence.nodes.length === planned.queries.length,
        'Issue1034 checkpoint is missing actual selector observations')
      const nodes = Array.from(evidence.nodes, (group, index) => {
        require(group && group.selector === planned.queries[index] && group.query === 'css' && group.has === undefined && emptyScope(group.scope)
          && Number.isSafeInteger(group.count) && group.count >= 0 && Array.isArray(group.nodes) && group.nodes.length === group.count,
        'Issue1034 actual checkpoint query/count/scope is incomplete')
        return { selector: group.selector, query: group.query, count: group.count, nodes: Array.from(group.nodes, node => {
          require(node && typeof node.text === 'string', 'Issue1034 actual checkpoint rendered text is missing')
          return { text: node.text }
        }) }
      })
      publish({ kind: 'render', op: 'dom.checkpoint', payload: { id: evidence.id, route, nodes } })
      checkpoints++
    },
    flush() {
      if (closed) { healthy(); return }
      closed = true
      for (const restore of restores.reverse()) { try { restore() } catch (error) { failure ??= error } }
      healthy()
      require(checkpoints === descriptor.checkpoints.length && taps === checkpoints && launches === checkpoints && !pendingTap && pendingOperations === 0,
        'Issue1034 actual observation coverage is incomplete')
    },
  }
}
