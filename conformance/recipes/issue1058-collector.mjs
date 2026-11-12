/** Passive normalization for the unchanged upstream issue #1058 assertions.
 * Checkpoint payloads come exclusively from completed DOM evidence. Expected
 * text/data never enters this module; the plan below checks coverage only. */
const plan = [
  { id: 'count-0', selectors: ['#builtin', '#pascal', '#kebab', '#duplicate', '#increment'] },
  { id: 'count-1', selectors: ['#builtin', '#pascal', '#kebab', '#duplicate', '#increment'] },
  { id: 'branch-0', selectors: ['#lowercase', '#explicit-pascal', '#toggle'] },
  { id: 'branch-1', selectors: ['#lowercase', '#explicit-pascal', '#toggle'] },
  { id: 'branch-2', selectors: ['#lowercase', '#explicit-pascal', '#toggle'] },
]
const tapAfterCheckpoint = new Map([[1, '#increment'], [3, '#toggle'], [4, '#toggle']])
const tapsBeforeAction = new Map([[1, 0], [3, 1], [4, 2]])
const routeOf = value => {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('?') || value.includes('#')) {
    throw new Error('Issue1058 observation has no actual page route')
  }
  const route = value.replace(/^\/+|\/+$/g, '')
  if (!route || route.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Issue1058 observation route is not canonical')
  return route
}

export function createCollector({ emit }) {
  const programs = new WeakSet(), pages = new WeakSet(), elements = new WeakSet(), restores = []
  let checkpoints = 0, taps = 0, activeRoute, closed = false, failure
  const fail = error => { failure ??= error; throw error }
  const require = (condition, message) => { if (!condition) fail(new Error(message)) }
  const publish = event => {
    try { emit(event) } catch (error) { fail(error) }
  }
  const wrap = (target, key, factory) => {
    require(typeof target?.[key] === 'function', `Issue1058 provider has no ${key} operation`)
    const own = Object.getOwnPropertyDescriptor(target, key), original = target[key]
    const wrapped = factory(original)
    Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapped })
    restores.push(() => {
      if (target[key] !== wrapped) return
      if (own) Object.defineProperty(target, key, own)
      else delete target[key]
    })
  }
  const observeElement = (element, page, selector) => {
    if (!element || elements.has(element) || !['#increment', '#toggle'].includes(selector)) return element
    elements.add(element)
    wrap(element, 'tap', original => async function (...args) {
      const actualRoute = page.path
      const result = await Reflect.apply(original, this, args)
      // Evidence failures are reported by flush. A completed guest action
      // keeps its original return value and the upstream assertion behavior.
      try {
        require(!closed, 'Issue1058 tap arrived after collector flush')
        const route = routeOf(actualRoute)
        require(tapAfterCheckpoint.get(checkpoints) === selector && tapsBeforeAction.get(checkpoints) === taps && activeRoute === route,
          'Issue1058 successful tap is outside its actual checkpoint interval')
        taps++
        publish({ kind: 'event', op: 'tap', payload: { route, selector } })
      } catch (error) { failure ??= error }
      return result
    })
    return element
  }
  const observePage = page => {
    require(page && typeof page === 'object', 'Issue1058 reLaunch returned no actual Page')
    if (pages.has(page)) return page
    pages.add(page)
    wrap(page, '$', original => async function (selector, ...args) {
      const element = await Reflect.apply(original, this, [selector, ...args])
      try { return observeElement(element, page, selector) }
      catch (error) { failure ??= error; return element }
    })
    return page
  }
  return {
    attach(program) {
      require(!closed, 'Issue1058 attachment arrived after collector flush')
      if (programs.has(program)) return
      programs.add(program)
      wrap(program, 'reLaunch', original => async function (...args) {
        const page = await Reflect.apply(original, this, args)
        try { return observePage(page) }
        catch (error) { failure ??= error; return page }
      })
    },
    checkpoint(observation) {
      require(!closed, 'Issue1058 checkpoint arrived after collector flush')
      const evidence = observation?.evidence
      const expected = plan[checkpoints]
      require(expected && evidence?.id === expected.id, 'Issue1058 actual checkpoints are missing, duplicated, or out of order')
      const route = routeOf(evidence.route)
      require(Array.isArray(evidence.nodes) && evidence.nodes.length === expected.selectors.length,
        'Issue1058 checkpoint is missing actual selector observations')
      const nodes = evidence.nodes.map((group, index) => {
        require(group.selector === expected.selectors[index] && group.query === 'css'
          && Number.isSafeInteger(group.count) && group.count >= 0 && Array.isArray(group.nodes) && group.nodes.length === group.count,
        'Issue1058 checkpoint has an incomplete actual node query')
        return { selector: group.selector, query: group.query, count: group.count, nodes: group.nodes.map(node => {
          require(node && typeof node.text === 'string', 'Issue1058 checkpoint is missing actual rendered text')
          return { text: node.text }
        }) }
      })
      const requiredTaps = [0, 1, 1, 2, 3][checkpoints]
      require(taps === requiredTaps, 'Issue1058 checkpoint is missing a successful observed tap')
      if (route !== activeRoute) {
        activeRoute = route
        publish({ kind: 'lifecycle', op: 'route.active', payload: { route } })
      }
      publish({ kind: 'render', op: 'dom.checkpoint', payload: { id: evidence.id, route, nodes } })
      checkpoints++
    },
    flush() {
      if (closed) { if (failure) throw failure; return }
      closed = true
      for (const restore of restores.reverse()) {
        try { restore() } catch (error) { failure ??= error }
      }
      if (failure) throw failure
      require(checkpoints === plan.length && taps === 3, 'Issue1058 actual observation coverage is incomplete')
    },
  }
}
