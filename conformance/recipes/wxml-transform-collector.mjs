/** Passive capture of the complete unchanged wxml-transform runtime surface.
 * Successful actual operations supply every value. Structure, not expectation,
 * defines coverage. Navigation requests are distinct from active-route state.
 * This candidate needs captured producer and native replay admission separately.
 */
import { descriptor } from './wxml-transform-descriptor.mjs'

const sameScope = (a, b) => Array.isArray(a) && a.length === b.length && b.every((part, index) => a[index] === part)
const routeOf = value => {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\\?#]/.test(value)) throw new Error('Wxml actual route is malformed')
  const result = value.replace(/^\/+|\/+$/g, '')
  if (!result || result.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Wxml actual route is not canonical')
  return result
}
const scalar = value => value === undefined ? { type: 'undefined' }
  : value === null ? { type: 'null' }
    : typeof value === 'string' ? { type: 'string', value }
      : undefined

export function createCollector({ emit }) {
  const pages = new WeakMap(), elements = new WeakMap(), restores = []
  const ownership = Symbol('wxml-transform-observed-transport-owner')
  let owner, active, epoch = 0, queries = 0, launchCalls = 0, checkpointCount = 0, directAt = 0
  let pending, closed = false, failure
  const fail = error => { failure ??= error; throw error }
  const require = (condition, message) => { if (!condition) fail(new Error(message)) }
  const healthy = () => { if (failure) throw failure }
  const phase = () => checkpointCount % 2 === 1 && directAt < descriptor.direct.length
  const publish = event => { try { emit(event) } catch (error) { fail(error) } }
  const wrap = (target, key, factory) => {
    require(typeof target?.[key] === 'function', `Wxml provider has no ${key}`)
    const own = Object.getOwnPropertyDescriptor(target, key), original = target[key], wrapped = factory(original)
    Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapped })
    restores.push(() => {
      if (target[key] !== wrapped) return
      if (own) Object.defineProperty(target, key, own)
      else delete target[key]
    })
  }
  const current = info => info && info.owner === owner && info.epoch === epoch && info === active
    && pages.get(info.page) === info && routeOf(info.page.path) === info.route
  const currentElement = (element, binding) => binding && elements.get(element) === binding && current(binding.info)
  const tokenFor = (op, selector, name, binding) => {
    if (!phase() && op !== 'tap') return undefined
    const token = { checkpointCount, directAt, info: active, pending, binding, op, selector, name }
    // Keep the original call running even if observation will fail. Its result
    // or rejection is authoritative; evidence failure is reported at flush.
    pending = token
    return token
  }
  const settle = (token, payload) => {
    healthy()
    const planned = descriptor.direct[token.directAt]
    require(!closed && !token.pending && pending === token && checkpointCount === token.checkpointCount && directAt === token.directAt
      && current(token.info) && planned?.op === token.op && planned.selector === token.selector && planned.name === token.name,
    'Wxml original direct operation completed outside its current source interval')
    if (token.binding) require(currentElement(token.binding.element, token.binding), 'Wxml direct read belongs to a stale Element acquisition')
    directAt++
    publish({ kind: token.op === 'tap' ? 'event' : 'render', op: token.op === 'query' ? 'query.result' : token.op === 'tap' ? 'tap' : `query.${token.op}`,
      payload: { route: token.info.route, selector: token.selector, ...(token.name === undefined ? {} : { name: token.name }), ...payload } })
  }
  const finish = (token, payload) => {
    if (!token) return
    try { settle(token, payload) } catch (error) { failure ??= error }
    finally { if (pending === token) pending = undefined }
  }
  const bindElement = (element, info, scope, selector, acquisition) => {
    if (element == null) return element
    healthy()
    require(!closed && current(info) && typeof element === 'object' && typeof selector === 'string' && selector,
      'Wxml query has no identifiable actual Element from the current page')
    const old = elements.get(element)
    require(!old || old.info === info && old.selector === selector && sameScope(old.scope, scope)
      || old.info.owner === info.owner && old.info.epoch < info.epoch,
    'Wxml actual cached Element is aliased across owners or query scopes')
    require(!old || old.acquisition < acquisition, 'Wxml older query completed after a newer Element acquisition')
    elements.set(element, { element, info, scope: [...scope], selector, acquisition })
    if (old) return element
    if (typeof element.$ === 'function') wrap(element, '$', original => async function (selector, ...args) {
      const binding = elements.get(element), acquisition = ++queries
      const child = await Reflect.apply(original, this, [selector, ...args])
      try {
        healthy()
        require(!closed && currentElement(element, binding), 'Wxml child query belongs to a stale Element acquisition')
        if (phase()) fail(new Error('Wxml original direct operation has an unreviewed nested query scope'))
        return bindElement(child, binding.info, [...binding.scope, binding.selector], selector, acquisition)
      } catch (error) { failure ??= error; return child }
    })
    // The pinned Element has attribute(); fallback attr() is retained only if
    // that is the provider operation selected by the unchanged source helper.
    const attributeKey = typeof element.attribute === 'function' ? 'attribute' : typeof element.attr === 'function' ? 'attr' : undefined
    for (const [key, op] of [['text', 'text'], ...(attributeKey ? [[attributeKey, 'attribute']] : []), ['tap', 'tap']]) {
      if (typeof element[key] !== 'function') continue
      wrap(element, key, original => async function (...args) {
        const binding = elements.get(element), token = tokenFor(op, binding?.selector, op === 'attribute' ? args[0] : undefined, binding)
        let result
        try { result = await Reflect.apply(original, this, args) }
        catch (error) { if (pending === token) pending = undefined; throw error }
        if (token) {
          try {
            healthy()
            require(binding?.scope.length === 0 && (op === 'attribute' ? args.length === 1 && typeof args[0] === 'string' : args.length === 0),
              'Wxml direct operation has another actual argument or scope')
            const value = op === 'tap' ? undefined : scalar(result)
            require(op === 'tap' || value !== undefined, 'Wxml actual read is outside the string/null/undefined profile')
            finish(token, op === 'tap' ? {} : { value })
          } catch (error) { failure ??= error; if (pending === token) pending = undefined }
        }
        return result
      })
    }
    return element
  }
  const bindPage = (page, generation, fromLaunch) => {
    healthy()
    if (page == null && !fromLaunch) return page
    require(!closed && page && typeof page === 'object' && generation === epoch, 'Wxml actual Page acquisition is stale or absent')
    const route = routeOf(page.path), prior = pages.get(page)
    let info = prior
    if (!prior || prior.epoch !== generation) info = { owner, page, route, epoch: generation, fromLaunch }
    else require(prior.owner === owner && prior.route === route, 'Wxml route mutated without an observed reLaunch')
    if (!prior) wrap(page, '$', original => async function (selector, ...args) {
      const info = pages.get(page), acquisition = ++queries, token = tokenFor('query', selector)
      let result
      try { result = await Reflect.apply(original, this, [selector, ...args]) }
      catch (error) { if (pending === token) pending = undefined; throw error }
      try {
        if (token) require(args.length === 0, 'Wxml direct query has unreviewed arguments')
        bindElement(result, info, [], selector, acquisition)
        if (token) finish(token, { result: { type: result === null ? 'null' : result === undefined ? 'undefined' : 'element' } })
      } catch (error) { failure ??= error; if (pending === token) pending = undefined }
      return result
    })
    pages.set(page, info)
    active = info
    return page
  }
  return {
    attach(program) {
      healthy()
      require(!closed && program && typeof program === 'object', 'Wxml attachment has no open actual MiniProgram')
      if (owner?.program === program) return
      require(!owner, 'Wxml collector cannot combine different MiniProgram transports')
      owner = { program }
      Object.defineProperty(program, ownership, { configurable: true, value: owner })
      restores.push(() => { if (program[ownership] === owner) delete program[ownership] })
      wrap(program, 'reLaunch', original => async function (requested, ...args) {
        const before = { epoch, checkpointCount, directAt, pending }, call = ++launchCalls
        const page = await Reflect.apply(original, this, [requested, ...args])
        try {
          healthy()
          require(!closed && !before.pending && !pending && before.epoch === epoch && before.checkpointCount === checkpointCount
            && before.directAt === directAt && call === launchCalls && checkpointCount % 2 === 0 && checkpointCount < descriptor.routes.length * 2,
          'Wxml successful reLaunch is outside its actual completed-route interval')
          const route = routeOf(page?.path)
          require(args.length === 0 && routeOf(requested) === route && route === descriptor.routes[checkpointCount / 2], 'Wxml actual reLaunch request/route differs')
          epoch++
          bindPage(page, epoch, true)
          publish({ kind: 'lifecycle', op: 'route.reLaunch', payload: { requested, route } })
        } catch (error) { failure ??= error }
        return page
      })
      wrap(program, 'currentPage', original => async function (...args) {
        const generation = epoch, page = await Reflect.apply(original, this, args)
        try { return bindPage(page, generation, false) }
        catch (error) { failure ??= error; return page }
      })
    },
    checkpoint(observation, context) {
      try {
        healthy()
        require(!closed && !pending, 'Wxml checkpoint crossed an original pending operation or flush')
        const planned = descriptor.checkpoints[checkpointCount % 2], route = descriptor.routes[Math.floor(checkpointCount / 2)]
        const evidence = observation?.evidence
        require(planned && route && evidence?.id === planned.id && routeOf(evidence.route) === route
          && current(active) && active.route === route && active.fromLaunch,
        'Wxml checkpoint is absent, reordered, duplicated or lacks its actual route launch')
        if (context !== undefined) require(context?.session?.[ownership] === owner && pages.get(context.page) === active,
          'Wxml checkpoint belongs to another actual session or Page')
        require(checkpointCount % 2 === 0 ? directAt === 0 : directAt === descriptor.direct.length,
          'Wxml direct source observation coverage is incomplete')
        require(Array.isArray(evidence.nodes) && evidence.nodes.length === planned.selectors.length, 'Wxml checkpoint selector observations are incomplete')
        const nodes = Array.from(evidence.nodes, (group, index) => {
          require(group && group.selector === planned.selectors[index] && group.query === 'css' && group.has === undefined
            && (group.scope === undefined || sameScope(group.scope, [])) && Number.isSafeInteger(group.count) && group.count >= 0
            && Array.isArray(group.nodes) && group.nodes.length === group.count, 'Wxml checkpoint has another query, scope or count')
          return { selector: group.selector, query: group.query, count: group.count, nodes: Array.from(group.nodes, node => {
            require(node && typeof node.text === 'string', 'Wxml checkpoint actual rendered text is missing')
            return { text: node.text }
          }) }
        })
        if (checkpointCount % 2 === 0) publish({ kind: 'lifecycle', op: 'route.active', payload: { route } })
        publish({ kind: 'render', op: 'dom.checkpoint', payload: { id: evidence.id, route, nodes } })
        checkpointCount++
        directAt = 0
      } catch (error) { fail(error) }
    },
    flush() {
      if (closed) { healthy(); return }
      closed = true
      for (const restore of restores.reverse()) {
        try { restore() } catch (error) { failure ??= error }
      }
      healthy()
      require(checkpointCount === descriptor.routes.length * 2 && directAt === 0 && !pending, 'Wxml actual observation coverage is incomplete')
    },
  }
}
