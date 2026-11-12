/** Passive normalization for the unchanged upstream issue #1185 assertions.
 * The plan describes coverage only. Rendered values come exclusively from
 * completed DOM evidence, and actions come from successful original calls. */
const component = 'pages/component/index', bar = 'pages/bar/bar', unused = 'pages/unused/unused'
const componentQueries = [{ scope: ['#foo'], selector: '#foo-values' }, { scope: ['#foo'], selector: '#foo-increment' }]
const barQueries = [{ selector: '#bar-values' }, { selector: '#bar-increment' }]
const plan = [
  { id: 'component-0', route: component, queries: componentQueries, taps: 0 },
  { id: 'component-1', route: component, queries: componentQueries, taps: 1 },
  { id: 'page-0', route: bar, queries: barQueries, taps: 1 },
  { id: 'page-1', route: bar, queries: barQueries, taps: 2 },
  { id: 'unused-sibling', route: unused, queries: [{ selector: '#unused-value' }], taps: 2 },
]
const tapAfterCheckpoint = new Map([
  [1, { route: component, scope: ['#foo'], selector: '#foo-increment', previous: 0 }],
  [3, { route: bar, scope: [], selector: '#bar-increment', previous: 1 }],
])
const sameScope = (left, right) => Array.isArray(left) && left.length === right.length
  && right.every((part, index) => typeof left[index] === 'string' && left[index] === part)
const routeOf = value => {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\\?#]/.test(value)) {
    throw new Error('Issue1185 observation has no actual page route')
  }
  const route = value.replace(/^\/+|\/+$/g, '')
  if (!route || route.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Issue1185 observation route is not canonical')
  return route
}

export function createCollector({ emit }) {
  const programs = new WeakSet(), pages = new WeakSet(), elements = new WeakMap(), restores = []
  let checkpoints = 0, taps = 0, activeRoute, closed = false, failure
  const fail = error => { failure ??= error; throw error }
  const require = (condition, message) => { if (!condition) fail(new Error(message)) }
  const healthy = () => { if (failure) throw failure }
  const publish = event => { try { emit(event) } catch (error) { fail(error) } }
  const wrap = (target, key, factory) => {
    require(typeof target?.[key] === 'function', `Issue1185 provider has no ${key} operation`)
    const own = Object.getOwnPropertyDescriptor(target, key), original = target[key]
    const wrapped = factory(original)
    Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapped })
    restores.push(() => {
      if (target[key] !== wrapped) return
      if (own) Object.defineProperty(target, key, own)
      else delete target[key]
    })
  }
  const observeElement = (element, page, scope, selector) => {
    if (element == null) return element
    require(typeof element === 'object' && typeof selector === 'string' && selector.length > 0,
      'Issue1185 query returned an unidentifiable actual Element')
    const previous = elements.get(element)
    if (previous) {
      require(previous.page === page && previous.selector === selector && sameScope(previous.scope, scope),
        'Issue1185 actual Element was aliased across different query scopes')
      return element
    }
    elements.set(element, { page, selector, scope: [...scope] })
    if (typeof element.$ === 'function') wrap(element, '$', original => async function (childSelector, ...args) {
      const child = await Reflect.apply(original, this, [childSelector, ...args])
      try { return observeElement(child, page, [...scope, selector], childSelector) }
      catch (error) { failure ??= error; return child }
    })
    if (typeof element.tap === 'function') wrap(element, 'tap', original => async function (...args) {
      let actualRoute, routeFailure
      try { actualRoute = page.path } catch (error) { routeFailure = error }
      const result = await Reflect.apply(original, this, args)
      // Observation failures must not replace a completed guest operation's
      // return value or interfere with unchanged upstream assertion behavior.
      try {
        healthy()
        if (routeFailure) fail(routeFailure)
        require(!closed, 'Issue1185 tap arrived after collector flush')
        const route = routeOf(actualRoute), expected = tapAfterCheckpoint.get(checkpoints)
        require(expected && expected.route === route && expected.selector === selector && sameScope(scope, expected.scope)
          && expected.previous === taps && activeRoute === route,
        'Issue1185 successful tap is outside its actual checkpoint interval or scope')
        taps++
        publish({ kind: 'event', op: 'tap', payload: { route, ...(scope.length ? { scope: [...scope] } : {}), selector } })
      } catch (error) { failure ??= error }
      return result
    })
    return element
  }
  const observePage = page => {
    require(page && typeof page === 'object', 'Issue1185 reLaunch returned no actual Page')
    if (pages.has(page)) return page
    pages.add(page)
    wrap(page, '$', original => async function (selector, ...args) {
      const element = await Reflect.apply(original, this, [selector, ...args])
      try { return observeElement(element, page, [], selector) }
      catch (error) { failure ??= error; return element }
    })
    return page
  }
  return {
    attach(program) {
      healthy()
      require(!closed, 'Issue1185 attachment arrived after collector flush')
      require(program && typeof program === 'object', 'Issue1185 attachment has no actual MiniProgram')
      if (programs.has(program)) return
      programs.add(program)
      wrap(program, 'reLaunch', original => async function (...args) {
        const page = await Reflect.apply(original, this, args)
        try { return observePage(page) }
        catch (error) { failure ??= error; return page }
      })
    },
    checkpoint(observation) {
      healthy()
      require(!closed, 'Issue1185 checkpoint arrived after collector flush')
      const evidence = observation?.evidence, expected = plan[checkpoints]
      require(expected && evidence?.id === expected.id, 'Issue1185 actual checkpoints are missing, duplicated, or out of order')
      const route = routeOf(evidence.route)
      require(route === expected.route, 'Issue1185 actual checkpoint is on another page route')
      require(Array.isArray(evidence.nodes) && evidence.nodes.length === expected.queries.length,
        'Issue1185 checkpoint is missing actual selector observations')
      const nodes = Array.from(evidence.nodes, (group, index) => {
        const query = expected.queries[index], scope = query.scope ?? []
        require(group && group.selector === query.selector && group.query === 'css' && group.has === undefined
          && sameScope(group.scope ?? [], scope)
          && Number.isSafeInteger(group.count) && group.count >= 0 && Array.isArray(group.nodes) && group.nodes.length === group.count,
        'Issue1185 checkpoint has an incomplete actual node query or scope')
        return { selector: group.selector, query: group.query, ...(scope.length ? { scope: [...group.scope] } : {}), count: group.count,
          nodes: Array.from(group.nodes, node => {
            require(node && typeof node.text === 'string', 'Issue1185 checkpoint is missing actual rendered text')
            return { text: node.text }
          }) }
      })
      require(taps === expected.taps, 'Issue1185 checkpoint is missing a successful observed tap')
      if (route !== activeRoute) {
        activeRoute = route
        publish({ kind: 'lifecycle', op: 'route.active', payload: { route } })
      }
      publish({ kind: 'render', op: 'dom.checkpoint', payload: { id: evidence.id, route, nodes } })
      checkpoints++
    },
    flush() {
      if (closed) { healthy(); return }
      closed = true
      for (const restore of restores.reverse()) {
        try { restore() } catch (error) { failure ??= error }
      }
      healthy()
      require(checkpoints === plan.length && taps === 2, 'Issue1185 actual observation coverage is incomplete')
    },
  }
}
