/** Passive normalization for the unchanged upstream issue #1072 assertions.
 * The plan records coverage only. The original poll supplies the last actual
 * text read before each successful original tap; no expected values enter. */
import { createPassiveQueryContext } from './passive-query-context.mjs'

const plan = [
  { id: 'package-0', route: 'pages/home/index' },
  { id: 'package-1', route: 'pages/external/index' },
  { id: 'package-2', route: 'pages/dynamic/index' },
]
const selector = '#increment'
const sameScope = (left, right) => Array.isArray(left) && left.length === right.length
  && right.every((part, index) => typeof left[index] === 'string' && left[index] === part)
const routeOf = value => {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\\?#]/.test(value)) {
    throw new Error('Issue1072 observation has no actual page route')
  }
  const route = value.replace(/^\/+|\/+$/g, '')
  if (!route || route.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Issue1072 observation route is not canonical')
  return route
}

export function createCollector({ emit }) {
  const programs = new WeakSet(), pages = new WeakMap(), elements = new WeakMap(), restores = [], reads = new Map()
  const queryContext = createPassiveQueryContext()
  let checkpoints = 0, taps = 0, launches = 0, queries = 0, active, pendingTap, closed = false, failure
  const fail = error => { failure ??= error; throw error }
  const require = (condition, message) => { if (!condition) fail(new Error(message)) }
  const healthy = () => { if (failure) throw failure }
  const publish = event => { try { emit(event) } catch (error) { fail(error) } }
  const wrap = (target, key, factory) => {
    require(typeof target?.[key] === 'function', `Issue1072 provider has no ${key} operation`)
    const own = Object.getOwnPropertyDescriptor(target, key), original = target[key]
    const wrapped = factory(original)
    Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapped })
    restores.push(() => {
      if (target[key] !== wrapped) return
      if (own) Object.defineProperty(target, key, own)
      else delete target[key]
    })
  }
  const readKey = (scope, query) => JSON.stringify([...scope, query])
  const current = info => info && active === info && pages.get(info.page) === info
    && info.launch === launches && routeOf(info.page.path) === info.route
  const currentElement = (element, binding) => elements.get(element) === binding && current(binding?.info)
  const detail = (operation, info, query, scope, acquisition, options) => ({ operation, owner: info?.owner,
    page: info?.page, route: info?.route, launch: info?.launch, selector: query, scope, acquisition, options })
  const observeElement = (element, info, scope, query, acquisition) => {
    if (element == null) return element
    const previous = elements.get(element), canonical = scope.length === 0 && query === selector
    queryContext.binding({element,info,query,scope,acquisition,canonical,previous})
    healthy()
    require(!closed && current(info), 'Issue1072 query has no actual Element from the current launch')
    require(typeof element === 'object' && typeof query === 'string' && query.length > 0,
      'Issue1072 query returned an unidentifiable actual Element')
    // The pinned transport caches Pages by pageId and Elements by elementId.
    // A completed query in a later observed launch may therefore return the
    // same object. Update its binding, rather than closing wrappers over the
    // first launch. Operations already in flight retain their old binding.
    require(!previous || previous.info === info || previous.info.owner === info.owner && previous.info.launch < info.launch,
      'Issue1072 actual Element was aliased across different transports or launches')
    // Several CSS selectors may legitimately return the provider's same cached
    // node. Only the actual descriptor action query acquires its trace address;
    // another alias must not rename or invalidate that canonical acquisition.
    if (previous?.canonical && !canonical) return element
    require(!previous || !canonical || !previous.canonical || previous.acquisition < acquisition,
      'Issue1072 query completed after a later actual Element acquisition')
    elements.set(element, { info, query, scope: [...scope], acquisition, canonical })
    if (previous) return element
    if (typeof element.$ === 'function') wrap(element, '$', original => async function (childQuery, ...args) {
      if (queryContext.internal()) return await queryContext.run(() => Reflect.apply(original, this, [childQuery, ...args]),
        detail('Element.$', elements.get(element)?.info, childQuery, undefined, undefined, args[0]))
      const binding = elements.get(element), acquisition = ++queries
      const child = await queryContext.run(() => Reflect.apply(original, this, [childQuery, ...args]),
        detail('Element.$', binding.info, childQuery, [...binding.scope, binding.query], acquisition, args[0]))
      try {
        healthy()
        require(!closed && currentElement(element, binding), 'Issue1072 child query is outside its current launch')
        return observeElement(child, binding.info, [...binding.scope, binding.query], childQuery, acquisition)
      } catch (error) { failure ??= error; return child }
    })
    if (typeof element.text === 'function') wrap(element, 'text', original => async function (...args) {
      if (queryContext.internal()) return await queryContext.run(() => Reflect.apply(original, this, args), detail('Element.text', elements.get(element)?.info))
      const binding = elements.get(element), before = { checkpoints, taps, pendingTap }
      const result = await queryContext.run(() => Reflect.apply(original, this, args), detail('Element.text', binding?.info, binding?.query, binding?.scope, binding?.acquisition))
      try {
        healthy()
        if (!binding?.canonical) return result
        require(!closed, 'Issue1072 text read arrived after collector flush')
        require(currentElement(element, binding) && typeof result === 'string',
          'Issue1072 text read has no actual string from the current launch')
        // Reads made by the original post-tap checkpoint are observations too,
        // but cannot become a pre-tap read. A source poll must finish before
        // the original action starts and in the interval where it began.
        if (before.taps === before.checkpoints) {
          require(!before.pendingTap && !pendingTap && before.checkpoints === checkpoints && before.taps === taps,
            'Issue1072 source read completed across an original action boundary')
          reads.set(readKey(binding.scope, binding.query), { info: binding.info, text: result })
        }
      } catch (error) { failure ??= error }
      return result
    })
    if (typeof element.tap === 'function') wrap(element, 'tap', original => async function (...args) {
      if (queryContext.internal()) return await queryContext.run(() => Reflect.apply(original, this, args), detail('Element.tap', elements.get(element)?.info))
      const binding = elements.get(element)
      if (!binding?.canonical) {
        const result = await queryContext.run(() => Reflect.apply(original, this, args), detail('Element.tap', binding?.info, binding?.query, binding?.scope, binding?.acquisition))
        try { healthy(); require(false, 'Issue1072 successful tap is outside its actual launch, checkpoint interval or scope: no canonical action query') }
        catch (error) { failure ??= error }
        return result
      }
      const { info, scope, query } = binding
      const key = readKey(scope, query), before = { checkpoints, taps, launches, active, pendingTap, precedingRead: reads.get(key) }
      const token = {}
      pendingTap = token
      let actualRoute, routeFailure
      try { actualRoute = routeOf(info.page.path) } catch (error) { routeFailure = error }
      let result
      try { result = await queryContext.run(() => Reflect.apply(original, this, args), detail('Element.tap', info, query, scope, binding.acquisition)) }
      finally { if (pendingTap === token) pendingTap = undefined }
      // Completed guest operations retain their original result, even when
      // observation coverage fails. Flush reports the evidence failure.
      try {
        healthy()
        if (routeFailure) fail(routeFailure)
        require(!closed, 'Issue1072 tap arrived after collector flush')
        const expected = plan[checkpoints]
        require(expected && actualRoute === info.route && info.route === expected.route && query === selector && scope.length === 0
          && currentElement(element, binding) && before.active === info && !before.pendingTap && !pendingTap
          && before.checkpoints === checkpoints && before.taps === taps && before.launches === launches
          && taps === checkpoints && launches === checkpoints + 1,
        'Issue1072 successful tap is outside its actual launch, checkpoint interval or scope')
        require(before.precedingRead && before.precedingRead.info === info,
          'Issue1072 successful tap has no preceding actual text read from this launch')
        reads.delete(key)
        taps++
        publish({ kind: 'render', op: 'query.text', payload: { route: info.route, selector: query, text: before.precedingRead.text } })
        publish({ kind: 'event', op: 'tap', payload: { route: info.route, selector: query } })
      } catch (error) { failure ??= error }
      return result
    })
    return element
  }
  const observeLaunch = (page, owner, before) => {
    healthy()
    require(!closed, 'Issue1072 reLaunch arrived after collector flush')
    require(page && typeof page === 'object', 'Issue1072 reLaunch returned no actual Page')
    const route = routeOf(page.path), expected = plan[checkpoints]
    require(expected && route === expected.route && launches === checkpoints && taps === checkpoints
      && before.launches === launches && before.checkpoints === checkpoints && before.taps === taps
      && !before.pendingTap && !pendingTap,
      'Issue1072 successful reLaunch is outside its actual checkpoint interval or route')
    const info = { page, owner, route, launch: ++launches }
    active = info
    reads.clear()
    if (!pages.has(page)) {
      // These public provider helpers query internally but return strings or
      // readiness results, not a caller-acquired Element. Their intermediate
      // roots/scopes must never relabel the caller's final query binding.
      for (const key of ['waitForRendered', 'waitFor', 'wxml']) if (typeof page[key] === 'function') {
        wrap(page, key, original => async function (...args) {
          return await queryContext.run(() => Reflect.apply(original, this, args), detail(`Page.${key}`, pages.get(page)))
        })
      }
      wrap(page, '$', original => async function (query, ...args) {
        if (queryContext.internal()) return await queryContext.run(() => Reflect.apply(original, this, [query, ...args]), detail('Page.$', pages.get(page), query, undefined, undefined, args[0]))
        const acquired = pages.get(page), acquisition = ++queries
        const element = await queryContext.run(() => Reflect.apply(original, this, [query, ...args]), detail('Page.$', acquired, query, [], acquisition, args[0]))
        try { return observeElement(element, acquired, [], query, acquisition) }
        catch (error) { failure ??= error; return element }
      })
    }
    pages.set(page, info)
    publish({ kind: 'lifecycle', op: 'route.active', payload: { route } })
    return page
  }
  return {
    diagnostics: () => queryContext.snapshot(),
    attach(program) {
      healthy()
      require(!closed, 'Issue1072 attachment arrived after collector flush')
      require(program && typeof program === 'object', 'Issue1072 attachment has no actual MiniProgram')
      if (programs.has(program)) return
      programs.add(program)
      wrap(program, 'reLaunch', original => async function (...args) {
        const before = { checkpoints, taps, launches, pendingTap }
        const page = await queryContext.run(() => Reflect.apply(original, this, args), { operation: 'MiniProgram.reLaunch', owner: program })
        try { return observeLaunch(page, program, before) }
        catch (error) { failure ??= error; return page }
      })
    },
    checkpoint(observation) {
      healthy()
      require(!closed, 'Issue1072 checkpoint arrived after collector flush')
      const evidence = observation?.evidence, expected = plan[checkpoints]
      require(expected && evidence?.id === expected.id, 'Issue1072 actual checkpoints are missing, duplicated, or out of order')
      let route
      try { route = routeOf(evidence.route) } catch (error) { fail(error) }
      require(route === expected.route && current(active) && active.route === route && !pendingTap && launches === checkpoints + 1 && taps === checkpoints + 1,
        'Issue1072 checkpoint is missing its actual route launch or successful observed tap')
      require(Array.isArray(evidence.nodes) && evidence.nodes.length === 1,
        'Issue1072 checkpoint is missing actual selector observations')
      const group = evidence.nodes[0]
      require(group && group.selector === selector && group.query === 'css' && group.has === undefined
        && (group.scope === undefined || sameScope(group.scope, []))
        && Number.isSafeInteger(group.count) && group.count >= 0 && Array.isArray(group.nodes) && group.nodes.length === group.count,
      'Issue1072 checkpoint has an incomplete actual node query or scope')
      const nodes = [{ selector: group.selector, query: group.query, count: group.count, nodes: Array.from(group.nodes, node => {
        require(node && typeof node.text === 'string', 'Issue1072 checkpoint is missing actual rendered text')
        return { text: node.text }
      }) }]
      publish({ kind: 'render', op: 'dom.checkpoint', payload: { id: evidence.id, route, nodes } })
      checkpoints++
    },
    flush() {
      if (closed) { healthy(); return }
      closed = true
      for (const restore of restores.reverse()) {
        try { restore() } catch (error) { failure ??= error }
      }
      queryContext.close()
      healthy()
      require(checkpoints === plan.length && taps === plan.length && launches === plan.length && !pendingTap,
        'Issue1072 actual observation coverage is incomplete')
    },
  }
}
