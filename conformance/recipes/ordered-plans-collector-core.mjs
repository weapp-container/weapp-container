/** Passive ordered source plans. Titles are source provenance, not runtime task IDs.
 * No expected values, guest evaluation, navigation or query is driven here. */
import { createPassiveQueryContext } from './passive-query-context.mjs'
import { orderedQueryFields, projectOrderedDomNodes } from './ordered-dom-projection.mjs'

const routeOf = value => {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\\?#]/.test(value)) throw new Error('Ordered plans actual route is malformed')
  const route = value.replace(/^\/+|\/+$/g, '')
  if (!route || route.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Ordered plans actual route is not canonical')
  return route
}
const samePage = (a, b) => a && b && a.owner === b.owner && a.epoch === b.epoch && a.route === b.route
  && (a.page === b.page || Number.isSafeInteger(a.pageId) && a.pageId >= 0 && a.pageId === b.pageId)

export function createOrderedPlansCollector({ emit, descriptor, context }) {
  const label = descriptor.caseId, programs = new WeakMap(), pages = new WeakMap(), elements = new WeakMap(), restores = []
  const lineage = createPassiveQueryContext(), ownership = Symbol('ordered-plans-actual-transport-owner')
  let owner, active, checkpoints = 0, pending = 0, closed = false, failure
  const fail = error => { failure ??= error; throw error }
  const require = (ok, message) => { if (!ok) fail(new Error(`${label}: ${message}`)) }
  const healthy = () => { if (failure) throw failure }
  require(!context || context.caseId === descriptor.caseId && context.sourceSha256 === descriptor.sourceSha256,
    'collector context differs from the exact source case')
  require(descriptor.plans.length > 0 && descriptor.plans.every((plan, index) => plan.ordinal === index
    && typeof plan.test === 'string' && plan.test && plan.actions.length === 0 && plan.checkpoints.length === 1
    && plan.checkpoints[0].id && plan.checkpoints[0].queries.length > 0), 'unsupported ordered source plan shape')
  for (const plan of descriptor.plans) for (const query of plan.checkpoints[0].queries) orderedQueryFields(query, require)
  const wrap = (target, key, factory) => {
    require(typeof target?.[key] === 'function', `provider has no ${key}`)
    const own = Object.getOwnPropertyDescriptor(target, key), original = target[key], wrapped = factory(original)
    Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapped })
    restores.push(() => {
      if (target[key] !== wrapped) return
      if (own) Object.defineProperty(target, key, own)
      else delete target[key]
    })
  }
  const current = info => !closed && info && info.owner === owner && info.epoch === owner.epoch
    && samePage(active, info) && routeOf(info.page.path) === info.route
  const detail = (operation, info, selector) => ({ operation, owner: info?.owner, page: info?.page,
    route: info?.route, epoch: info?.epoch, selector })
  const observeElement = (element, info) => {
    if (element == null) return element
    require(current(info) && typeof element === 'object', 'actual Element query is stale or malformed')
    const prior = elements.get(element)
    require(!prior || prior.owner === info.owner && prior.epoch <= info.epoch, 'actual Element crosses transports or obsolete generations')
    elements.set(element, info)
    if (prior) return element
    for (const key of ['$', '$$']) if (typeof element[key] === 'function') wrap(element, key, original => async function (...args) {
      if (lineage.internal()) return await lineage.run(() => Reflect.apply(original, this, args), detail(`Element.${key}`, elements.get(element), args[0]))
      const before = elements.get(element); pending++
      try {
        const result = await lineage.run(() => Reflect.apply(original, this, args), detail(`Element.${key}`, before, args[0]))
        try {
          healthy(); require(elements.get(element) === before && current(before), 'child query completed after another actual acquisition')
          if (key === '$$') { require(Array.isArray(result), 'actual child query array is malformed'); for (const child of result) observeElement(child, before) }
          else observeElement(result, before)
        } catch (error) { failure ??= error }
        return result
      } finally { pending-- }
    })
    if (typeof element.tap === 'function') wrap(element, 'tap', original => async function (...args) {
      if (lineage.internal()) return await lineage.run(() => Reflect.apply(original, this, args), detail('Element.tap', elements.get(element)))
      const before = elements.get(element); pending++
      try {
        const result = await lineage.run(() => Reflect.apply(original, this, args), detail('Element.tap', before))
        // Preserve the exact guest completion; a successful unplanned action is sticky evidence failure.
        try { healthy(); require(false, 'successful business tap is outside the empty source action plan') }
        catch (error) { failure ??= error }
        return result
      } finally { pending-- }
    })
    return element
  }
  const observePage = (page, transport, epoch) => {
    healthy()
    require(!closed && transport === owner && epoch === owner.epoch, 'actual Page acquisition is obsolete or cross-owned')
    if (page == null) return page
    require(typeof page === 'object', 'actual Page is malformed')
    const info = { owner: transport, epoch, page, route: routeOf(page.path), pageId: page.pageId }
    const prior = pages.get(page)
    require(!prior || prior.owner === transport && prior.epoch <= epoch, 'actual Page aliases another transport')
    require(!prior || prior.epoch !== epoch || prior.route === info.route && prior.pageId === info.pageId,
      'actual Page identity changed without an observed reLaunch')
    if (!prior) {
      for (const key of ['waitForRendered', 'waitFor', 'wxml']) if (typeof page[key] === 'function') wrap(page, key, original => async function (...args) {
        return await lineage.run(() => Reflect.apply(original, this, args), detail(`Page.${key}`, pages.get(page)))
      })
      for (const key of ['$', '$$']) if (typeof page[key] === 'function') wrap(page, key, original => async function (...args) {
        if (lineage.internal()) return await lineage.run(() => Reflect.apply(original, this, args), detail(`Page.${key}`, pages.get(page), args[0]))
        const before = pages.get(page); pending++
        try {
          const result = await lineage.run(() => Reflect.apply(original, this, args), detail(`Page.${key}`, before, args[0]))
          try {
            healthy(); require(current(before), 'query completed after another actual Page generation')
            if (key === '$$') { require(Array.isArray(result), 'actual query array is malformed'); for (const element of result) observeElement(element, before) }
            else observeElement(result, before)
          } catch (error) { failure ??= error }
          return result
        } finally { pending-- }
      })
    }
    pages.set(page, info); active = info
    return page
  }
  return {
    diagnostics: () => lineage.snapshot(),
    attach(program) {
      healthy(); require(!closed && program && typeof program === 'object', 'attachment has no open actual MiniProgram')
      if (programs.has(program)) { require(programs.get(program) === owner, 'cannot reactivate a retired actual transport'); return }
      require(pending === 0, 'transport changed during an actual pending operation')
      const transport = { program, epoch: 0 }; programs.set(program, transport); owner = transport; active = undefined
      require(['currentPage', 'reLaunch'].some(key => typeof program[key] === 'function'), 'provider has no actual Page acquisition')
      Object.defineProperty(program, ownership, { configurable: true, value: transport })
      restores.push(() => { if (program[ownership] === transport) delete program[ownership] })
      for (const key of ['currentPage', 'reLaunch']) if (typeof program[key] === 'function') wrap(program, key, original => async function (...args) {
        if (lineage.internal()) return await lineage.run(() => Reflect.apply(original, this, args), { operation: `MiniProgram.${key}`, owner: transport })
        const before = { epoch: transport.epoch, checkpoints }; pending++
        try {
          const result = await lineage.run(() => Reflect.apply(original, this, args), { operation: `MiniProgram.${key}`, owner: transport, epoch: before.epoch })
          try {
            healthy(); require(!closed && owner === transport && before.epoch === transport.epoch && before.checkpoints === checkpoints,
              'Page acquisition completed after another generation or checkpoint')
            if (key === 'reLaunch') {
              require(result && routeOf(args[0]) === routeOf(result.path), 'actual reLaunch request and result route differ')
              transport.epoch++
            }
            observePage(result, transport, transport.epoch)
          } catch (error) { failure ??= error }
          return result
        } finally { pending-- }
      })
    },
    checkpoint(observation, context) {
      try {
        healthy(); require(!closed && pending === 0, 'checkpoint crossed a pending operation or flush')
        const plan = descriptor.plans[checkpoints], planned = plan?.checkpoints[0], evidence = observation?.evidence
        require(planned && evidence?.id === planned.id, 'actual checkpoints are missing, duplicated or out of order')
        const route = routeOf(evidence.route), info = context === undefined ? active : pages.get(context?.page)
        require(current(info) && (context === undefined || context?.session?.[ownership] === owner)
          && route === plan.route && info.route === route, 'checkpoint lacks its observed actual Page, session, route or generation')
        require(Array.isArray(evidence.nodes) && evidence.nodes.length === planned.queries.length, 'actual selector observations are incomplete')
        const nodes = projectOrderedDomNodes(evidence.nodes, planned.queries, require)
        const identity = { planOrdinal: plan.ordinal, checkpointOrdinal: checkpoints, route }
        try {
          emit({ kind: 'lifecycle', op: 'route.active', payload: { ...identity } })
          emit({ kind: 'render', op: 'dom.checkpoint', payload: { ...identity, id: evidence.id, nodes } })
        } catch (error) { fail(error) }
        checkpoints++
      } catch (error) { fail(error) }
    },
    flush() {
      if (closed) { healthy(); return }
      closed = true
      for (const restore of restores.reverse()) { try { restore() } catch (error) { failure ??= error } }
      lineage.close(); healthy()
      require(checkpoints === descriptor.plans.length && pending === 0, 'actual ordered plan coverage is incomplete')
    },
  }
}
