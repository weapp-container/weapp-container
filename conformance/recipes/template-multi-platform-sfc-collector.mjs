/** Passive observation of the unchanged multi-platform template test. Providers retain
 * their original results/errors. Only completed actual DOM evidence is emitted. */
import { descriptor } from './template-multi-platform-sfc-descriptor.mjs'

const routeOf = value => {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\\?#]/.test(value)) {
    throw new Error('TemplateMultiPlatform actual page route is malformed')
  }
  const route = value.replace(/^\/+|\/+$/g, '')
  if (!route || route.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('TemplateMultiPlatform actual page route is not canonical')
  return route
}
const sameScope = (left, right) => Array.isArray(left === undefined ? [] : left) && (left === undefined ? [] : left).length === right.length
  && right.every((part, index) => typeof left[index] === 'string' && left[index] === part)
const samePage = (left, right) => left && right && left.owner === right.owner && left.epoch === right.epoch
  && left.route === right.route && (left.page === right.page || Number.isSafeInteger(left.pageId)
    && left.pageId >= 0 && left.pageId === right.pageId)

export function createCollector({ emit }) {
  const programs = new WeakMap(), pages = new WeakMap(), elements = new WeakMap(), restores = []
  // The pinned shared helper returns a forwarding recoverable-session Proxy.
  // Its property reads reach the real transport; a private owner marker binds
  // checkpoint context without driving currentPage or guessing Proxy identity.
  const ownership = Symbol('template-multi-platform-sfc-observed-transport-owner')
  let checkpoints = 0, taps = 0, active, established, closed = false, failure
  const fail = error => { failure ??= error; throw error }
  const require = (condition, message) => { if (!condition) fail(new Error(message)) }
  const healthy = () => { if (failure) throw failure }
  const publish = event => { try { emit(event) } catch (error) { fail(error) } }
  const wrap = (target, key, factory) => {
    require(typeof target?.[key] === 'function', `TemplateMultiPlatform provider has no ${key} operation`)
    const own = Object.getOwnPropertyDescriptor(target, key), original = target[key], wrapped = factory(original)
    Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapped })
    restores.push(() => {
      if (target[key] !== wrapped) return
      if (own) Object.defineProperty(target, key, own)
      else delete target[key]
    })
  }
  const observeElement = (element, page, info, scope, selector) => {
    if (element == null) return element
    require(typeof element === 'object' && typeof selector === 'string' && selector,
      'TemplateMultiPlatform query returned an unidentifiable actual Element')
    const previous = elements.get(element)
    if (previous) {
      require(samePage(previous.info, info) && previous.selector === selector
        && JSON.stringify(previous.scope) === JSON.stringify(scope), 'TemplateMultiPlatform Element is aliased across actual pages, generations or scopes')
      return element
    }
    elements.set(element, { info, selector, scope: [...scope] })
    for (const method of ['$', '$$']) if (typeof element[method] === 'function') wrap(element, method, original => async function (childSelector, ...args) {
      const result = await Reflect.apply(original, this, [childSelector, ...args])
      try {
        if (method === '$$') {
          require(Array.isArray(result), 'TemplateMultiPlatform actual $$ result is not an array')
          for (const child of result) observeElement(child, page, info, [...scope, selector], childSelector)
          return result
        }
        return observeElement(result, page, info, [...scope, selector], childSelector)
      } catch (error) { failure ??= error; return result }
    })
    if (typeof element.tap === 'function') wrap(element, 'tap', original => async function (...args) {
      // Capture the interval before awaiting. A later initial checkpoint or
      // navigation cannot retrospectively admit a tap that already started.
      const before = { checkpoints, taps, active }
      let actualRoute, routeFailure
      try { actualRoute = routeOf(page.path) } catch (error) { routeFailure = error }
      const result = await Reflect.apply(original, this, args)
      try {
        healthy()
        if (routeFailure) fail(routeFailure)
        require(!closed && before.checkpoints === descriptor.action.afterCheckpoint && checkpoints === before.checkpoints
          && before.taps === 0 && taps === before.taps && selector === descriptor.action.selector && scope.length === 0,
        'TemplateMultiPlatform successful tap is outside its actual checkpoint interval or scope')
        require(actualRoute === descriptor.route && routeOf(page.path) === actualRoute && info.epoch === info.owner.epoch
          && samePage(before.active, info) && samePage(active, info) && samePage(established, info),
        'TemplateMultiPlatform successful tap belongs to another actual page or generation')
        taps++
        publish({ kind: 'event', op: 'tap', payload: { route: actualRoute, selector } })
      } catch (error) { failure ??= error }
      return result
    })
    return element
  }
  const observePage = (page, owner, epoch) => {
    healthy()
    require(!closed, 'TemplateMultiPlatform Page observation arrived after collector flush')
    if (page == null) return page // currentPage may be temporarily unavailable.
    require(typeof page === 'object' && epoch === owner.epoch, 'TemplateMultiPlatform Page observation belongs to an obsolete generation')
    const info = { page, owner, epoch, route: routeOf(page.path), pageId: page.pageId }
    if (!pages.has(page)) {
      require(['$', '$$'].some(key => typeof page[key] === 'function'), 'TemplateMultiPlatform Page has no actual query operation')
      for (const method of ['$', '$$']) if (typeof page[method] === 'function') wrap(page, method, original => async function (selector, ...args) {
        const queried = pages.get(page)
        const result = await Reflect.apply(original, this, [selector, ...args])
        try {
          if (method === '$$') {
            require(Array.isArray(result), 'TemplateMultiPlatform actual $$ result is not an array')
            for (const element of result) observeElement(element, page, queried, [], selector)
            return result
          }
          return observeElement(result, page, queried, [], selector)
        } catch (error) { failure ??= error; return result }
      })
    }
    pages.set(page, info)
    active = info
    return page
  }
  return {
    attach(program) {
      healthy()
      require(!closed && program && typeof program === 'object', 'TemplateMultiPlatform attachment has no open actual MiniProgram')
      if (programs.has(program)) return
      const owner = { program, epoch: 0 }
      programs.set(program, owner)
      require(['currentPage', 'reLaunch'].some(key => typeof program[key] === 'function'), 'TemplateMultiPlatform provider has no Page acquisition operation')
      Object.defineProperty(program, ownership, { configurable: true, value: owner })
      restores.push(() => { if (program[ownership] === owner) delete program[ownership] })
      for (const key of ['currentPage', 'reLaunch']) if (typeof program[key] === 'function') wrap(program, key, original => async function (...args) {
        const epoch = owner.epoch, page = await Reflect.apply(original, this, args)
        try {
          require(epoch === owner.epoch, 'TemplateMultiPlatform Page acquisition completed after another generation')
          if (key === 'reLaunch') {
            require(page && typeof page === 'object', 'TemplateMultiPlatform reLaunch returned no actual Page')
            owner.epoch++
          }
          return observePage(page, owner, owner.epoch)
        } catch (error) { failure ??= error; return page }
      })
    },
    checkpoint(observation, context) {
      healthy()
      require(!closed, 'TemplateMultiPlatform checkpoint arrived after collector flush')
      const evidence = observation?.evidence, planned = descriptor.checkpoints[checkpoints]
      require(planned && evidence?.id === planned.id, 'TemplateMultiPlatform actual checkpoints are missing, duplicated or out of order')
      let route
      try { route = routeOf(evidence.route) } catch (error) { fail(error) }
      const info = context === undefined ? active : pages.get(context?.page)
      let contextOwner, currentRoute
      try { contextOwner = context?.session?.[ownership]; currentRoute = info && routeOf(info.page.path) }
      catch (error) { fail(error) }
      require(info && info.epoch === info.owner.epoch && samePage(active, info)
        && (context === undefined || contextOwner === info.owner)
        && route === descriptor.route && currentRoute === route && info.route === route,
      'TemplateMultiPlatform checkpoint lacks its observed actual Page, session, route or generation')
      require(taps === planned.taps && (!established || samePage(established, info)),
        'TemplateMultiPlatform checkpoint is missing its successful tap or original page generation')
      require(Array.isArray(evidence.nodes) && evidence.nodes.length === planned.queries.length,
        'TemplateMultiPlatform checkpoint is missing actual selector observations')
      const nodes = Array.from(evidence.nodes, (group, index) => {
        require(group && group.selector === planned.queries[index].selector && group.query === 'css' && group.has === undefined
          && sameScope(group.scope, planned.queries[index].scope ?? []) && Number.isSafeInteger(group.count) && group.count >= 0
          && Array.isArray(group.nodes) && group.nodes.length === group.count, 'TemplateMultiPlatform actual node query or scope is incomplete')
        return { selector: group.selector, query: group.query, ...(group.scope?.length ? { scope: [...group.scope] } : {}), count: group.count, nodes: Array.from(group.nodes, node => {
          require(node && typeof node.text === 'string', 'TemplateMultiPlatform actual rendered text is missing')
          return { text: node.text }
        }) }
      })
      if (!established) {
        established = info
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
      require(checkpoints === descriptor.checkpoints.length && taps === 1, 'TemplateMultiPlatform actual observation coverage is incomplete')
    },
  }
}
