/** Shared passive ownership and generation boundary for the two reviewed
 * collectors. This module only observes operations that the provider actually
 * performs; it never drives a query, navigation, method, or expected-value poll.
 * Case descriptors and actual field projection stay in their adapters. */
import { createPassiveQueryContext } from './passive-query-context.mjs'

const samePage = (left, right) => left && right && left.owner === right.owner && left.epoch === right.epoch
  && left.route === right.route && (left.page === right.page || Number.isSafeInteger(left.pageId)
    && left.pageId >= 0 && left.pageId === right.pageId)

export function createPassiveCollector({ emit, descriptor, label, ownershipName, pageQueries, projectNodes }) {
  const routeOf = value => {
    if (typeof value !== 'string' || !value || value.trim() !== value || /[\\?#]/.test(value)) {
      throw new Error(`${label} actual page route is malformed`)
    }
    const route = value.replace(/^\/+|\/+$/g, '')
    if (!route || route.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${label} actual page route is not canonical`)
    return route
  }

  const programs = new WeakMap(), pages = new WeakMap(), elements = new WeakMap(), restores = []
  const queryContext = createPassiveQueryContext()
  // The pinned shared helper returns a forwarding recoverable-session Proxy.
  // Its property reads reach the real transport; a private owner marker binds
  // checkpoint context without driving currentPage or guessing Proxy identity.
  const ownership = Symbol(ownershipName)
  let checkpoints = 0, taps = 0, queries = 0, active, established, transportOwner, closed = false, failure
  const fail = error => { failure ??= error; throw error }
  const require = (condition, message) => { if (!condition) fail(new Error(message)) }
  const healthy = () => { if (failure) throw failure }
  const publish = event => { try { emit(event) } catch (error) { fail(error) } }
  const wrap = (target, key, factory) => {
    require(typeof target?.[key] === 'function', `${label} provider has no ${key} operation`)
    const own = Object.getOwnPropertyDescriptor(target, key), original = target[key], wrapped = factory(original)
    Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapped })
    restores.push(() => {
      if (target[key] !== wrapped) return
      if (own) Object.defineProperty(target, key, own)
      else delete target[key]
    })
  }
  const current = info => info && !closed && info.owner === transportOwner && info.epoch === info.owner.epoch
    && samePage(active, info) && routeOf(info.page.path) === info.route
  const currentElement = (element, binding) => elements.get(element) === binding && current(binding?.info)
  const detail = (operation, info, selector, scope, acquisition, options) => ({ operation, owner: info?.owner,
    page: info?.page, route: info?.route, epoch: info?.epoch, selector, scope, acquisition, options })
  const observeElement = (element, page, info, scope, selector, acquisition) => {
    if (element == null) return element
    const previous = elements.get(element), canonical = scope.length === 0 && selector === descriptor.action.selector
    queryContext.binding({element,info,query:selector,scope,acquisition,canonical,previous})
    healthy()
    require(current(info), `${label} actual Element query belongs to another page or generation`)
    require(typeof element === 'object' && typeof selector === 'string' && selector,
      `${label} query returned an unidentifiable actual Element`)
    require(!previous || previous.info.owner === info.owner && previous.info.epoch <= info.epoch,
      `${label} Element is aliased across actual transports or obsolete generations`)
    if (previous?.canonical && !canonical) return element
    require(!previous || !canonical || !previous.canonical || previous.acquisition < acquisition,
      `${label} query completed after a later actual Element acquisition`)
    elements.set(element, { info, selector, scope: [...scope], acquisition, canonical })
    if (previous) return element
    if (typeof element.$ === 'function') wrap(element, '$', original => async function (childSelector, ...args) {
      if (queryContext.internal()) return await queryContext.run(() => Reflect.apply(original, this, [childSelector, ...args]), detail('Element.$', elements.get(element)?.info, childSelector, undefined, undefined, args[0]))
      const binding = elements.get(element), acquisition = ++queries
      const child = await queryContext.run(() => Reflect.apply(original, this, [childSelector, ...args]), detail('Element.$', binding.info, childSelector, [...binding.scope, binding.selector], acquisition, args[0]))
      try {
        require(currentElement(element, binding), `${label} child query belongs to another page or acquisition`)
        return observeElement(child, page, binding.info, [...binding.scope, binding.selector], childSelector, acquisition)
      }
      catch (error) { failure ??= error; return child }
    })
    if (typeof element.tap === 'function') wrap(element, 'tap', original => async function (...args) {
      if (queryContext.internal()) return await queryContext.run(() => Reflect.apply(original, this, args), detail('Element.tap', elements.get(element)?.info))
      const binding = elements.get(element)
      if (!binding?.canonical) {
        const result = await queryContext.run(() => Reflect.apply(original, this, args), detail('Element.tap', binding?.info, binding?.selector, binding?.scope, binding?.acquisition))
        try { healthy(); require(false, `${label} successful tap is outside its actual checkpoint interval or scope: no canonical action query`) }
        catch (error) { failure ??= error }
        return result
      }
      const { info, scope, selector } = binding, page = info.page
      // Capture the interval before awaiting. A later initial checkpoint or
      // navigation cannot retrospectively admit a tap that already started.
      const before = { checkpoints, taps, active }
      let actualRoute, routeFailure
      try { actualRoute = routeOf(page.path) } catch (error) { routeFailure = error }
      const result = await queryContext.run(() => Reflect.apply(original, this, args), detail('Element.tap', info, selector, scope, binding.acquisition))
      try {
        healthy()
        if (routeFailure) fail(routeFailure)
        require(!closed && before.checkpoints === descriptor.action.afterCheckpoint && checkpoints === before.checkpoints
          && before.taps === 0 && taps === before.taps && selector === descriptor.action.selector && scope.length === 0,
        `${label} successful tap is outside its actual checkpoint interval or scope`)
        require(actualRoute === descriptor.route && routeOf(page.path) === actualRoute && info.owner === transportOwner && info.epoch === info.owner.epoch
          && currentElement(element, binding) && samePage(before.active, info) && samePage(active, info) && samePage(established, info),
        `${label} successful tap belongs to another actual page or generation`)
        taps++
        publish({ kind: 'event', op: 'tap', payload: { route: actualRoute, selector } })
      } catch (error) { failure ??= error }
      return result
    })
    return element
  }
  const observePage = (page, owner, epoch) => {
    healthy()
    require(!closed && owner === transportOwner, `${label} Page observation belongs to another transport or closed collector`)
    if (page == null) return page // currentPage may be temporarily unavailable.
    require(typeof page === 'object' && epoch === owner.epoch, `${label} Page observation belongs to an obsolete generation`)
    const info = { page, owner, epoch, route: routeOf(page.path), pageId: page.pageId }
    if (!pages.has(page)) {
      for (const key of ['waitForRendered', 'waitFor', 'wxml']) if (typeof page[key] === 'function') {
        wrap(page, key, original => async function (...args) {
          return await queryContext.run(() => Reflect.apply(original, this, args), detail(`Page.${key}`, pages.get(page)))
        })
      }
      if (pageQueries.length > 1) require(pageQueries.some(key => typeof page[key] === 'function'), `${label} actual Page has no query operation`)
      for (const key of pageQueries) if (pageQueries.length === 1 || typeof page[key] === 'function') wrap(page, key, original => async function (selector, ...args) {
        if (queryContext.internal()) return await queryContext.run(() => Reflect.apply(original, this, [selector, ...args]), detail(`Page.${key}`, pages.get(page), selector, undefined, undefined, args[0]))
        // Bind before await: a delayed array cannot adopt a later Page epoch.
        const queried = pages.get(page), acquisition = ++queries
        const result = await queryContext.run(() => Reflect.apply(original, this, [selector, ...args]), detail(`Page.${key}`, queried, selector, [], acquisition, args[0]))
        try {
          if (key === '$$') {
            require(Array.isArray(result), `${label} actual query array is malformed`)
            for (const element of result) observeElement(element, page, queried, [], selector, acquisition)
            return result
          }
          return observeElement(result, page, queried, [], selector, acquisition)
        } catch (error) { failure ??= error; return result }
      })
    }
    pages.set(page, info)
    active = info
    return page
  }
  return {
    diagnostics: () => queryContext.snapshot(),
    attach(program) {
      healthy()
      require(!closed && program && typeof program === 'object', `${label} attachment has no open actual MiniProgram`)
      if (programs.has(program)) return
      const owner = { program, epoch: 0 }
      programs.set(program, owner)
      transportOwner = owner; active = undefined
      require(['currentPage', 'reLaunch'].some(key => typeof program[key] === 'function'), `${label} provider has no Page acquisition operation`)
      Object.defineProperty(program, ownership, { configurable: true, value: owner })
      restores.push(() => { if (program[ownership] === owner) delete program[ownership] })
      for (const key of ['currentPage', 'reLaunch']) if (typeof program[key] === 'function') wrap(program, key, original => async function (...args) {
        const epoch = owner.epoch, page = await queryContext.run(() => Reflect.apply(original, this, args), { operation: `MiniProgram.${key}`, owner, epoch: owner.epoch })
        try {
          require(epoch === owner.epoch, `${label} Page acquisition completed after another generation`)
          if (key === 'reLaunch') {
            require(page && typeof page === 'object', `${label} reLaunch returned no actual Page`)
            owner.epoch++
          }
          return observePage(page, owner, owner.epoch)
        } catch (error) { failure ??= error; return page }
      })
    },
    checkpoint(observation, context) {
      healthy()
      require(!closed, `${label} checkpoint arrived after collector flush`)
      const evidence = observation?.evidence, planned = descriptor.checkpoints[checkpoints]
      require(planned && evidence?.id === planned.id, `${label} actual checkpoints are missing, duplicated or out of order`)
      let route
      try { route = routeOf(evidence.route) } catch (error) { fail(error) }
      const info = context === undefined ? active : pages.get(context?.page)
      let contextOwner, currentRoute
      try { contextOwner = context?.session?.[ownership]; currentRoute = info && routeOf(info.page.path) }
      catch (error) { fail(error) }
      require(info && info.owner === transportOwner && info.epoch === info.owner.epoch && samePage(active, info)
        && (context === undefined || contextOwner === info.owner)
        && route === descriptor.route && currentRoute === route && info.route === route,
      `${label} checkpoint lacks its observed actual Page, session, route or generation`)
      require(taps === planned.taps && (!established || samePage(established, info)),
        `${label} checkpoint is missing its successful tap or original page generation`)
      require(Array.isArray(evidence.nodes) && evidence.nodes.length === planned.queries.length,
        `${label} checkpoint is missing actual selector observations`)
      const nodes = projectNodes(evidence.nodes, planned, require)
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
      queryContext.close()
      healthy()
      require(checkpoints === descriptor.checkpoints.length && taps === 1, `${label} actual observation coverage is incomplete`)
    },
  }
}
