/** Passive source-step machine. This profile does not reinterpret older traces.
 * Provider calls retain their original result/error; observation errors surface
 * at checkpoint/flush. No query, navigation or expected value is driven here. */
import { isDeepStrictEqual } from 'node:util'
import { createPassiveQueryContext } from './passive-query-context.mjs'
import { encodeMethodValue, decodeMethodValue, methodArguments } from './source-method-values.mjs'

const ensure = (ok, message) => { if (!ok) throw new Error(message) }
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : ''
const selector = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !value.includes('\0')
export const routeOf = value => {
  ensure(selector(value) && !/[\\?#]/.test(value), 'Ordered steps actual route is malformed')
  const route = value.replace(/^\/+|\/+$/g, '')
  ensure(route && route.split('/').every(part => part && part !== '.' && part !== '..'), 'Ordered steps actual route is not canonical')
  return route
}
export function sourceAddress(value) {
  ensure(value && Object.keys(value).every(key => ['selector', 'query', 'scope', 'has'].includes(key))
    && selector(value.selector) && (value.query === undefined || value.query === 'css'), 'Ordered steps query address is unsupported')
  const address = { selector: value.selector, query: 'css' }
  if (value.scope !== undefined) {
    ensure(Array.isArray(value.scope), 'Ordered steps scope must be typed steps')
    for (const step of value.scope) ensure(selector(step) || keys(step) === 'has' && selector(step.has), 'Ordered steps scope step is unsupported')
    if (value.scope.length) address.scope = structuredClone(value.scope)
  }
  if (value.has !== undefined) { ensure(selector(value.has), 'Ordered steps has predicate is unsupported'); address.has = value.has }
  return address
}
export function queryAddress(query) {
  const { fields: _fields, ...address } = query
  return sourceAddress(address)
}
export function projectCheckpoint(groups, queries) {
  ensure(Array.isArray(groups) && groups.length === queries.length, 'Ordered steps actual selector coverage is incomplete')
  return Array.from(groups, (group, at) => {
    const query = queries[at], { count, nodes, ...rawAddress } = group ?? {}
    const address = sourceAddress(rawAddress)
    ensure(isDeepStrictEqual(address, queryAddress(query)) && Number.isSafeInteger(count) && count >= 0
      && Array.isArray(nodes) && nodes.length === count, 'Ordered steps actual address or raw count is incomplete')
    return { ...address, count, nodes: Array.from(nodes, node => {
      ensure(node && typeof node === 'object' && !Array.isArray(node), 'Ordered steps actual node is absent')
      const actual = {}
      if (query.fields.text) { ensure(typeof node.text === 'string', 'Ordered steps actual text is absent'); actual.text = node.text }
      if (query.fields.attributes.length) {
        ensure(node.attributes && typeof node.attributes === 'object' && !Array.isArray(node.attributes), 'Ordered steps actual attributes are absent')
        actual.attributes = {}
        for (const name of query.fields.attributes) {
          ensure(Object.hasOwn(node.attributes, name), 'Ordered steps requested actual attribute is absent')
          actual.attributes[name] = structuredClone(node.attributes[name])
        }
      }
      return actual
    }) }
  })
}
const samePage = (a, b) => a && b && a.owner === b.owner && a.epoch === b.epoch && a.route === b.route
  && (a.page === b.page || a.pageId === b.pageId)

export function createOrderedStepsCollector({ emit, descriptor, context, readinessPolicies = {}, methodPollPolicies = {}, clock = Date.now }) {
  const programs = new WeakMap(), pages = new WeakMap(), elements = new WeakMap(), owners = new WeakSet(), restores = []
  const lineage = createPassiveQueryContext(), ownership = Symbol('ordered-steps-actual-transport-owner')
  let owner, active, established, planAt = 0, stepAt = 0, cursor = 0, acquisition = 0, pending = 0, inFlight, closed = false, failure
  const methodOutcomes = [], pollAttempts = [], tapHelperAttempts = [], tapHelperAcquisitions = []
  let tapHelperState
  let readinessScope, routeMethodScope, pollScope, singleAcquisition
  let rootReady
  const rootReadiness=descriptor.pageRootReadiness
  if(rootReadiness)ensure(keys(rootReadiness)==='helperSha256,selector,sourceCallsite,timeoutMs'&&selector(rootReadiness.selector)&&rootReadiness.timeoutMs===5000
    &&selector(rootReadiness.sourceCallsite)&&/^[a-f0-9]{64}$/.test(rootReadiness.helperSha256),'Unsupported exact source root readiness')
  // Match the guest observation boundary: primitives are lossless; arbitrary
  // thrown objects remain private and are never inspected for message/toJSON.
  const thrownValue = error => error === undefined ? { kind: 'undefined' }
    : error === null || ['string', 'boolean'].includes(typeof error) || typeof error === 'number' && Number.isFinite(error) && !Object.is(error, -0)
      ? { kind: 'json', value: error } : { kind: 'uninspectable', valueType: typeof error }
  const fail = error => { failure ??= error; throw failure }
  const require = (ok, message) => { if (!ok) fail(new Error(`${descriptor.caseId}: ${message}`)) }
  const healthy = () => { if (failure) throw failure }
  const plan = () => descriptor.plans[planAt]
  const step = () => plan()?.steps[stepAt]
  const stepRoute = () => step()?.route ?? plan()?.route
  require(!context || context.caseId === descriptor.caseId && context.sourceSha256 === descriptor.sourceSha256, 'source context differs')
  require(Array.isArray(descriptor.plans) && descriptor.plans.length > 0, 'source plans are absent')
  for (const [index, value] of descriptor.plans.entries()) {
    require(value.ordinal === index && value.route === routeOf(value.route) && selector(value.fullName)
      && Array.isArray(value.steps) && value.steps.length > 0 && ['checkpoint', 'method.readiness', 'method.call', 'data.read'].includes(value.steps[0].kind)
      && ['checkpoint', 'method.call'].includes(value.steps.at(-1).kind), 'source plan is unsupported')
    let checkpoints = 0, actions = 0, expectedRoute=value.route
    for (const entry of value.steps) {
      if(entry.kind==='reLaunch')expectedRoute=entry.route
      require((entry.route??value.route)===expectedRoute,'source step changed routes without its original reLaunch')
      if (entry.kind === 'checkpoint') {
        require(entry.ordinal === checkpoints++ && selector(entry.id) && Array.isArray(entry.queries) && entry.queries.length > 0, 'source checkpoint is malformed')
        for (const query of entry.queries) {
          queryAddress(query)
          require(keys(query.fields) === 'attributes,text' && typeof query.fields.text === 'boolean'
            && Array.isArray(query.fields.attributes) && query.fields.attributes.every(selector)
            && new Set(query.fields.attributes).size === query.fields.attributes.length, 'source field selection is malformed')
        }
      } else if (entry.kind === 'reLaunch') {
        require(entry.ordinal === actions++ && entry.route === routeOf(entry.route) && selector(entry.sourceCallsite)
          && entry.sourceCallsite.length <= 256 && entry.sourceAcquisition === 'MiniProgram.reLaunch then actual new Page',
        'source in-plan reLaunch action is unsupported')
      } else if (entry.kind === 'method.poll') {
        const policy = methodPollPolicies[entry.sourceCallsite]
        require(entry.ordinal === actions++ && selector(entry.method) && selector(entry.sourceCallsite)
          && entry.sourceCallsite.length <= 256 && /^[a-f0-9]{64}$/.test(entry.helperSha256)
          && ['Page.callMethod inside original awaited expect.poll', 'Page.callMethodWithOptions inside original awaited expect.poll'].includes(entry.sourceAcquisition)
          && (entry.sourceAcquisition === 'Page.callMethodWithOptions inside original awaited expect.poll'
            ? keys(entry.callOptions) === 'timeout' && entry.callOptions.timeout === 5000 : entry.callOptions === undefined)
          && selector(entry.pollScopeCallsite) && selector(entry.pollAssertCallsite) && /^[a-f0-9]{64}$/.test(entry.pollSourceSha256)
          && entry.normalization?.kind === 'pinned-pure-read-terminal-v1'
          && entry.normalization.rawAttempts === 'complete-private-journal'
          && /^[a-f0-9]{64}$/.test(entry.normalization.methodBodySha256)
          && descriptor.sourceGuards?.some(guard => guard.path === entry.normalization.sourcePath && guard.sha256 === entry.normalization.sourceSha256)
          && entry.matcher === 'toEqual' && policy && typeof policy.satisfied === 'function'
          && entry.timeoutMs === policy.timeoutMs && entry.intervalMs === policy.intervalMs
          && Number.isSafeInteger(entry.timeoutMs) && entry.timeoutMs > 0 && entry.timeoutMs <= 60000
          && Number.isSafeInteger(entry.intervalMs) && entry.intervalMs > 0 && entry.intervalMs < entry.timeoutMs,
        'source poll action, policy or original timeout/interval is unsupported')
        methodArguments(entry.args)
      } else if (entry.kind === 'data.read') {
        require(entry.ordinal === actions++ && ['Page','Element'].includes(entry.target) && selector(entry.path)
          && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entry.path) && selector(entry.sourceCallsite)
          && (entry.target === 'Page' ? keys(entry.options) === 'timeout' && Number.isSafeInteger(entry.options.timeout) && entry.options.timeout > 0
            : entry.options === undefined && entry.address), 'source data read is unsupported')
        if (entry.target === 'Element') sourceAddress(entry.address)
      } else if (entry.kind === 'method.call' || entry.kind === 'method.readiness') {
        require(entry.ordinal === actions++ && selector(entry.method) && selector(entry.sourceCallsite)
          && entry.sourceCallsite.length <= 256 && /^[a-f0-9]{64}$/.test(entry.helperSha256)
          && ['Page.callMethod then awaited terminal completion', 'callRoutePageMethod then awaited terminal completion', 'Page.callMethodWithOptions then awaited terminal completion'].includes(entry.sourceAcquisition), 'source method action is unsupported')
        require(entry.sourceAcquisition !== 'callRoutePageMethod then awaited terminal completion' || /^[a-f0-9]{64}$/.test(entry.routeHelperSha256),
          'source route-method helper identity is absent')
        require(entry.sourceAcquisition === 'Page.callMethodWithOptions then awaited terminal completion'
          ? entry.kind === 'method.call' && keys(entry.callOptions) === 'timeout' && Number.isSafeInteger(entry.callOptions.timeout)
            && entry.callOptions.timeout > 0 && entry.callOptions.timeout <= 60000
          : entry.callOptions === undefined, 'source explicit method options or acquisition differ')
        methodArguments(entry.args)
        if (entry.kind === 'method.readiness') {
          const policy = readinessPolicies[entry.sourceCallsite]
          require(policy && typeof policy.ready === 'function' && policy.timeoutMs === 12000 && policy.pollMs === 220
            && /^[a-f0-9]{64}$/.test(entry.readinessHelperSha256), 'source readiness policy or helper identity is absent')
        }
      } else {
        require(entry.kind === 'tap' && entry.ordinal === actions++
          && ['Page.$$ then unique Element.tap', 'Page.$ then actual Element.tap', 'tapElement Page.$ default and actual fallback sequence'].includes(entry.sourceAcquisition), 'source action is unsupported')
        if (entry.sourceAcquisition === 'Page.$ then actual Element.tap') require(entry.queryMethod === '$'
          && keys(entry.queryOptions) === 'timeout' && entry.queryOptions.timeout === 2000
          && selector(entry.sourceCallsite) && selector(entry.tapCallsite) && Number.isSafeInteger(entry.sourceIteration)
          && entry.sourceIteration === entry.ordinal && /^[a-f0-9]{64}$/.test(entry.pageHelperSha256)
          && /^[a-f0-9]{64}$/.test(entry.elementHelperSha256), 'source single-element acquisition identity/options are unsupported')
        if (entry.sourceAcquisition === 'tapElement Page.$ default and actual fallback sequence') require(entry.queryMethod === '$'
          && entry.queryOptions === undefined && selector(entry.sourceCallsite) && entry.sourceIteration === entry.ordinal
          && entry.helper?.queryArguments === 1 && entry.helper.waitMs === 240
          && isDeepStrictEqual(entry.helper.modes, ['tap','trigger','touch','dispatch'])
          && descriptor.sourceGuards?.some(guard => guard.path === entry.helper.path && guard.sha256 === entry.helper.sha256)
          && /^[a-f0-9]{64}$/.test(entry.helper.functionSha256), 'original tap helper source/default query is unsupported')
        const address = sourceAddress(entry.address)
        require(!address.scope?.length && address.has === undefined, 'Page action acquisition requires a flat source address')
      }
    }
  }
  const current = info => !closed && info && info.owner === owner && info.epoch === owner.epoch && samePage(active, info)
    && routeOf(info.page.path) === info.route && (!established || samePage(established, info))
  const detail = (operation, info, address) => ({ operation, owner: info?.owner, page: info?.page,
    route: info?.route, epoch: info?.epoch, selector: address?.selector, scope: address?.scope })
  const establish = info => {
    require(current(info) && info.route === stepRoute(), 'source operation lacks its actual plan route')
    if (!established) { established = info; emit({ kind: 'lifecycle', op: 'route.active', payload: { planOrdinal: planAt, route: info.route } }) }
  }
  const advance = () => {
    cursor++; stepAt++; singleAcquisition = undefined
    if (stepAt === plan().steps.length) { planAt++; stepAt = 0; established = undefined;rootReady=undefined }
  }
  const wrap = (target, key, factory) => {
    const own = Object.getOwnPropertyDescriptor(target, key), original = target[key], wrapped = factory(original)
    Object.defineProperty(target, key, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapped })
    restores.push(() => { if (target[key] === wrapped) { if (own) Object.defineProperty(target, key, own); else delete target[key] } })
  }
  const caught = invoke => { try { invoke() } catch (error) { failure ??= error } }
  const helperStep = entry => entry?.kind === 'tap' && entry.sourceAcquisition === 'tapElement Page.$ default and actual fallback sequence'
  const observeTapHelper = async (target, receiver, operation, args, invoke, binding) => {
    const planned = step(), at = cursor, info = binding?.info ?? pages.get(target), token = {}, startedAtMs = clock()
    const exclusive = !pending && !inFlight; let valid = false, state = tapHelperState
    caught(() => {
      if (!state && helperStep(planned) && binding) state = tapHelperState = { step: planned, cursor: at, binding, expected: 'tap', mode: 0, attempts: 0 }
      const expectedArgs = operation === 'trigger' ? ['tap'] : operation === 'dispatchEvent' ? [{eventName:'tap'}] : operation === 'waitFor' ? [240] : []
      valid = exclusive && receiver === target && state && state.step === planned && state.cursor === at && current(info)
        && state.binding.info === info && (operation === 'waitFor' ? target === info.page : binding === state.binding && binding.canonical)
        && state.expected === operation && isDeepStrictEqual(methodArguments(args), expectedArgs)
        && singleAcquisition?.cursor === at && singleAcquisition.acquisition === state.binding.acquisition
      require(valid, 'tap helper attempt lacks its actual default first acquisition, receiver, arguments or fallback order')
    })
    inFlight ??= token; pending++
    const record = completion => caught(() => {
      healthy(); require(valid && pending === 1 && inFlight === token && at === cursor && step() === planned
        && tapHelperState === state && current(info), 'tap helper attempt crossed its actual Page or source interval')
      const attemptOrdinal = state.attempts++
      const payload = { planOrdinal:planAt, actionOrdinal:planned.ordinal, route:info.route, ...state.binding.address,
        sourceCallsite:planned.sourceCallsite, helperSha256:planned.helper.sha256, operation, args:methodArguments(args),
        attemptOrdinal, completion:structuredClone(completion) }
      tapHelperAttempts.push({...structuredClone(payload),pageId:info.pageId,epoch:info.epoch,acquisition:state.binding.acquisition,
        sourceStepCursor:at,startedAtMs,endedAtMs:clock()})
      emit({kind:'event',op:'tap.helper.attempt',payload})
      if(completion.kind==='rejected') {state.mode++;state.expected=['tap','trigger','touchstart','dispatchEvent'][state.mode] ?? 'exhausted'}
      else if(operation==='waitFor') {
        emit({kind:'event',op:'tap',payload:{planOrdinal:planAt,actionOrdinal:planned.ordinal,route:info.route,...state.binding.address}})
        tapHelperState=undefined;advance()
      } else state.expected=operation==='touchstart'?'touchend':'waitFor'
    })
    try {
      const value=await lineage.run(invoke,detail('source tapElement/'+operation,info,binding?.address))
      record({kind:'fulfilled',value:encodeMethodValue(value)});return value
    } catch(error) {record({kind:'rejected',thrown:thrownValue(error)});throw error}
    finally {pending--;if(inFlight===token)inFlight=undefined}
  }
  const bindElement = (element, binding) => {
    if (element == null) return element
    require(typeof element === 'object' && current(binding.info), 'actual Element is malformed or stale')
    const previous = elements.get(element)
    require(!previous || previous.info.owner === binding.info.owner && previous.info.epoch <= binding.info.epoch, 'actual Element crosses owners or obsolete generations')
    // A checkpoint alias cannot rename an action already acquired in this interval.
    if (!(previous?.canonical && previous.cursor === cursor)) elements.set(element, binding)
    if (previous) return element
    for (const key of ['$', '$$']) if (typeof element[key] === 'function') wrap(element, key, original => async function (...args) {
      if (lineage.internal()) return await lineage.run(() => Reflect.apply(original, this, args), detail(`Element.${key}`, elements.get(element)?.info))
      const before = elements.get(element), at = cursor, id = ++acquisition; pending++
      try {
        const result = await lineage.run(() => Reflect.apply(original, this, args), detail(`Element.${key}`, before?.info, { selector: args[0] }))
        caught(() => {
          healthy(); require(this === element && elements.get(element) === before && current(before?.info) && at === cursor, 'child query completed across an actual binding or step')
          const address = sourceAddress({ selector: args[0], scope: [...(before.address.scope ?? []), before.address.selector] })
          bindResults(result, key, { info: before.info, address, acquisition: id, cursor: at, canonical: false })
        })
        return result
      } finally { pending-- }
    })
    if (typeof element.data === 'function') wrap(element, 'data', original => async function (...args) {
      if (lineage.internal()) return await lineage.run(() => Reflect.apply(original, this, args), detail('Element.data', elements.get(element)?.info))
      const before = elements.get(element)
      return await observeData(element, this, args, () => Reflect.apply(original, this, args), before?.info, before?.address, 'Element')
    })
    for (const operation of ['trigger','touchstart','touchend','dispatchEvent']) if(typeof element[operation]==='function') wrap(element,operation,original=>async function(...args){
      if(lineage.internal() || !helperStep(step())) return await lineage.run(()=>Reflect.apply(original,this,args),detail('Element.'+operation,elements.get(element)?.info))
      return await observeTapHelper(element,this,operation,args,()=>Reflect.apply(original,this,args),elements.get(element))
    })
    if (typeof element.tap === 'function') wrap(element, 'tap', original => async function (...args) {
      if (lineage.internal()) return await lineage.run(() => Reflect.apply(original, this, args), detail('Element.tap', elements.get(element)?.info))
      if(helperStep(step())) return await observeTapHelper(element,this,'tap',args,()=>Reflect.apply(original,this,args),elements.get(element))
      const before = elements.get(element), planned = step(), at = cursor, token = {}, priorFlight = inFlight
      const exclusive = pending === 0 && !priorFlight
      if (!exclusive) caught(() => require(false, 'concurrent actual action or query crosses its action interval'))
      let valid = false
      // Even malformed observation metadata must not replace the provider's
      // eventual original completion or rejection.
      caught(() => { valid = !closed && this === element && before?.canonical && before.cursor === at && current(before.info)
        && planned?.kind === 'tap' && isDeepStrictEqual(before.address, sourceAddress(planned.address)) })
      inFlight ??= token; pending++
      try {
        const result = await lineage.run(() => Reflect.apply(original, this, args), detail('Element.tap', before?.info, before?.address))
        caught(() => {
          healthy(); require(exclusive && valid && inFlight === token && pending === 1 && at === cursor && step() === planned
            && elements.get(element) === before && current(before.info), 'successful tap lacks its unique actual acquisition or ordered interval')
          emit({ kind: 'event', op: 'tap', payload: { planOrdinal: planAt, actionOrdinal: planned.ordinal, route: before.info.route, ...before.address } })
          advance()
        })
        return result
      } finally { pending--; if (inFlight === token) inFlight = undefined }
    })
    return element
  }
  const bindResults = (result, key, binding) => {
    if (key === '$$') {
      require(Array.isArray(result), 'actual query array is malformed')
      require(new Set(result).size === result.length, 'actual query array repeats an Element identity')
      for (const element of result) { require(element != null, 'actual query array has an absent Element'); bindElement(element, { ...binding, canonical: binding.canonical && result.length === 1 }) }
    } else bindElement(result, binding)
  }
  const observeData = async (target, receiver, args, invoke, info, address, kind) => {
    const planned=step(), at=cursor, exclusive=pending===0&&!inFlight, token={}
    let valid=false
    caught(() => { valid=receiver===target && current(info) && planned?.kind==='data.read' && planned.target===kind
      && args[0]===planned.path && (kind==='Page' ? args.length===2 && keys(args[1])==='timeout' && Object.getOwnPropertyDescriptor(args[1],'timeout')?.value===planned.options.timeout
        : args.length===1 && isDeepStrictEqual(address,sourceAddress(planned.address))) })
    inFlight??=token; pending++
    try {
      const result=await lineage.run(invoke,detail(kind+'.data',info,address))
      caught(() => {
        healthy();require(exclusive && valid && inFlight===token && pending===1 && at===cursor && step()===planned && current(info),
          'data read crossed its actual source/Page/ordered interval')
        establish(info)
        emit({kind:'event',op:'data.read',payload:{planOrdinal:planAt,actionOrdinal:planned.ordinal,route:info.route,target:kind,
          path:planned.path,...(planned.options?{options:structuredClone(planned.options)}:{}),...(address?{address:structuredClone(address)}:{}),
          sourceCallsite:planned.sourceCallsite,completion:{kind:'fulfilled',value:encodeMethodValue(result)}}})
        advance()
      })
      return result
    } catch(error) { caught(() => require(false,'source data read did not fulfill')); throw error }
    finally { pending--;if(inFlight===token)inFlight=undefined }
  }
  const observeMethod = async (page, receiver, args, invoke, acquisitionKind, routeHelperSha256, callOptions) => {
      const before = pages.get(page), planned = step(), at = cursor, token = {}, priorFlight = inFlight
      const readiness = planned?.kind === 'method.readiness', scope = readinessScope
      const explicit = acquisitionKind === 'Page.callMethodWithOptions then awaited terminal completion'
      const deadline = explicit && planned?.callOptions ? clock() + planned.callOptions.timeout : undefined
      const exclusive = pending === 0 && !priorFlight
      if (!exclusive) caught(() => require(false, 'concurrent actual action or query crosses its action interval'))
      let valid = false, actualArgs, observedCallOptions
      caught(() => { if (explicit && keys(callOptions) === 'timeout') observedCallOptions = { timeout: callOptions.timeout }
        actualArgs = methodArguments(args.slice(1)); valid = receiver === page && current(before) && ['method.call', 'method.readiness'].includes(planned?.kind)
        && planned.sourceAcquisition === acquisitionKind
        && (!explicit || observedCallOptions?.timeout === planned.callOptions?.timeout)
        && (acquisitionKind !== 'callRoutePageMethod then awaited terminal completion' || routeHelperSha256 === planned.routeHelperSha256)
        && args[0] === planned.method && isDeepStrictEqual(actualArgs, methodArguments(planned.args))
        if (readiness) {
          require(scope && scope.step === planned && scope.info === before && !scope.satisfied && clock() <= scope.deadline,
            'readiness method lacks its original source scope/deadline')
          scope.attempts++
        } else require(!scope, 'final method crossed an open readiness source scope') })
      inFlight ??= token; pending++
      try {
        const result = await lineage.run(invoke, detail(acquisitionKind, before))
        caught(() => {
          healthy(); require(exclusive && valid && inFlight === token && pending === 1 && at === cursor && step() === planned
            && pages.get(page) === before && current(before), 'successful method lacks its actual source address, Page or ordered interval')
          if (explicit) require(clock() <= deadline, 'explicit method completed after its original source timeout')
          establish(before)
          const encoded = encodeMethodValue(result)
          const ready = readiness ? Boolean(readinessPolicies[planned.sourceCallsite].ready(decodeMethodValue(encoded))) : undefined
          if (readiness) require(clock() <= scope.deadline, 'readiness result completed after its original deadline')
          emit({ kind: 'event', op: planned.kind, payload: { planOrdinal: planAt, actionOrdinal: planned.ordinal,
            route: before.route, method: planned.method, args: actualArgs,
            sourceCallsite: planned.sourceCallsite, helperSha256: planned.helperSha256,
            ...(explicit ? { callOptions: observedCallOptions } : {}),
            ...(readiness ? { attemptOrdinal: scope.attempts - 1, ready } : {}),
            completion: { kind: 'fulfilled', value: encoded } } })
          if (!readiness || ready) { if (readiness) scope.satisfied = true; advance() }
        })
        methodOutcomes.push({ planOrdinal: planAt, sourceStepCursor: at, kind: 'fulfilled' })
        return result
      } catch (error) {
        if (readiness) caught(() => {
          healthy(); require(exclusive && valid && inFlight === token && pending === 1 && at === cursor && step() === planned
            && pages.get(page) === before && current(before) && clock() <= scope.deadline, 'readiness throw crossed its source interval/deadline')
          establish(before)
          emit({ kind: 'event', op: 'method.readiness', payload: { planOrdinal: planAt, actionOrdinal: planned.ordinal,
            route: before.route, method: planned.method, args: actualArgs, sourceCallsite: planned.sourceCallsite, helperSha256: planned.helperSha256,
            attemptOrdinal: scope.attempts - 1, ready: false, completion: { kind: 'rejected', thrown: thrownValue(error) } } })
        })
        methodOutcomes.push({ planOrdinal: planAt, sourceStepCursor: at, kind: 'rejected', thrownType: typeof error })
        throw error
      } finally { pending--; if (inFlight === token) inFlight = undefined }
  }
  const observePollMethod = async (page, receiver, args, invoke, callOptions) => {
    const info = pages.get(page), planned = step(), scope = pollScope, at = cursor, token = {}, startedAtMs = clock()
    const exclusive = pending === 0 && !inFlight
    let valid = false, actualArgs
    const callDeadlineMs = callOptions?.timeout === undefined ? undefined : startedAtMs + callOptions.timeout
    caught(() => {
      actualArgs = methodArguments(args.slice(1))
      require(exclusive && receiver === page && current(info) && planned?.kind === 'method.poll'
        && scope && scope.step === planned && scope.info === info && !scope.completed && clock() <= scope.deadline
        && args[0] === planned.method && isDeepStrictEqual(actualArgs, methodArguments(planned.args))
        && isDeepStrictEqual(callOptions,planned.callOptions),
      'poll method lacks its actual source scope, Page, address or original deadline')
      valid = true; scope.attempts++
    })
    inFlight ??= token; pending++
    const observe = completion => caught(() => {
      healthy(); require(valid && inFlight === token && pending === 1 && at === cursor && step() === planned
        && pollScope === scope && pages.get(page) === info && current(info) && clock() <= scope.deadline
        && (callDeadlineMs === undefined || clock() <= callDeadlineMs),
      'poll terminal crossed its source interval, Page or original deadline')
      establish(info); scope.last = completion
      pollAttempts.push({ planOrdinal: planAt, sourceStepCursor: at, actionOrdinal: planned.ordinal, pageId: info.pageId,
        route: info.route, method: planned.method, args: actualArgs, sourceCallsite: planned.sourceCallsite,
        helperSha256: planned.helperSha256, ...(callOptions ? {callOptions:structuredClone(callOptions),callDeadlineMs}:{}), attemptOrdinal: scope.attempts - 1, startedAtMs, endedAtMs: clock(),
        scopeStartedAtMs: scope.startedAtMs, sourceDeadlineMs: scope.deadline, completion: structuredClone(completion) })
    })
    try {
      const value = await lineage.run(invoke, detail(planned.sourceAcquisition, info))
      caught(() => observe({ kind: 'fulfilled', value: encodeMethodValue(value) }))
      methodOutcomes.push({ planOrdinal: planAt, sourceStepCursor: at, kind: 'fulfilled', pollAttempt: scope?.attempts })
      return value
    } catch (error) {
      observe({ kind: 'rejected', thrown: thrownValue(error) })
      methodOutcomes.push({ planOrdinal: planAt, sourceStepCursor: at, kind: 'rejected', thrownType: typeof error, pollAttempt: scope?.attempts })
      throw error
    } finally { pending--; if (inFlight === token) inFlight = undefined }
  }
  const observePage = (page, transport, epoch) => {
    require(!closed && owner === transport && epoch === transport.epoch && page && typeof page === 'object', 'actual Page acquisition is stale or absent')
    const info = { owner: transport, epoch, page, pageId: page.pageId, route: routeOf(page.path) }, previous = pages.get(page)
    require(Number.isSafeInteger(info.pageId) && info.pageId >= 0, 'actual Page lacks its provider incarnation')
    require(!previous || previous.owner === transport && previous.epoch <= epoch
      && (previous.epoch !== epoch || previous.pageId === info.pageId && previous.route === info.route), 'actual Page aliases another owner or incarnation')
    require(!established || samePage(established, info), 'actual Page changed inside a source plan')
    pages.set(page, info); active = info
    if (previous) return page
    if (typeof page.data === 'function') wrap(page,'data',original => async function(...args) {
      if(lineage.internal())return await lineage.run(() => Reflect.apply(original,this,args),detail('Page.data',pages.get(page)))
      return await observeData(page,this,args,() => Reflect.apply(original,this,args),pages.get(page),undefined,'Page')
    })
    if (typeof page.callMethod === 'function') wrap(page, 'callMethod', original => async function (...args) {
      if (lineage.internal()) return await lineage.run(() => Reflect.apply(original, this, args), detail('Page.callMethod', pages.get(page)))
      if (step()?.kind === 'method.poll') return await observePollMethod(page, this, args, () => Reflect.apply(original, this, args))
      return await observeMethod(page, this, args, () => Reflect.apply(original, this, args), 'Page.callMethod then awaited terminal completion')
    })
    if (typeof page.callMethodWithOptions === 'function') wrap(page, 'callMethodWithOptions', original => async function (name, options, ...args) {
      if (lineage.internal()) return await lineage.run(() => Reflect.apply(original, this, [name, options, ...args]), detail('Page.callMethodWithOptions', pages.get(page)))
      if(step()?.kind==='method.poll') return await observePollMethod(page,this,[name,...args],()=>Reflect.apply(original,this,[name,options,...args]),options)
      return await observeMethod(page, this, [name, ...args], () => Reflect.apply(original, this, [name, options, ...args]),
        'Page.callMethodWithOptions then awaited terminal completion', undefined, options)
    })
    for (const key of ['waitForRendered', 'waitFor', 'wxml']) if (typeof page[key] === 'function') wrap(page, key, original => async function (...args) {
      if (lineage.internal()) return await lineage.run(() => Reflect.apply(original, this, args), detail(`Page.${key}`, pages.get(page)))
      if(key==='waitFor' && helperStep(step())) return await observeTapHelper(page,this,key,args,()=>Reflect.apply(original,this,args),undefined)
      const before = pages.get(page), at = cursor, root=key==='waitForRendered'&&rootReadiness
      // DevTools performs an unrelated bridge warmup on the first page before
      // the reviewed source plan starts. Only the planned route can satisfy
      // the source root-readiness contract.
      const appliesRoot = root && before?.route === plan()?.route
      if(appliesRoot)caught(()=>require(!rootReady&&!established&&stepAt===0&&pending===0&&args.length===1
        &&keys(args[0])==='selector,timeout'&&args[0].selector===root.selector&&args[0].timeout===root.timeoutMs,
      'original source root readiness options/order differ'))
      const rootStarted=clock();pending++
      try {
        const result = await lineage.run(() => Reflect.apply(original, this, args), detail(`Page.${key}`, before))
        caught(() => { healthy(); require(this === page && current(before) && at === cursor, 'readiness completed across an actual Page or source step') })
        if(appliesRoot)caught(()=>{
          healthy();require(clock()<=rootStarted+root.timeoutMs,'original source root readiness deadline elapsed')
          rootReady=before;establish(before)
          emit({kind:'event',op:'route.root.ready',payload:{planOrdinal:planAt,route:before.route,...root}})
        })
        return result
      } finally { pending-- }
    })
    for (const key of ['$', '$$']) if (typeof page[key] === 'function') wrap(page, key, original => async function (...args) {
      if (lineage.internal()) return await lineage.run(() => Reflect.apply(original, this, args), detail(`Page.${key}`, pages.get(page), { selector: args[0] }))
      const before = pages.get(page), at = cursor, id = ++acquisition; pending++
      try {
        const result = await lineage.run(() => Reflect.apply(original, this, args), detail(`Page.${key}`, before, { selector: args[0] }))
        caught(() => {
          healthy(); require(this === page && current(before) && at === cursor, 'query completed across an actual Page or source step')
          const address = sourceAddress({ selector: args[0] }), planned = step()
          const matches = planned?.kind === 'tap' && isDeepStrictEqual(address, sourceAddress(planned.address))
          const single = matches && ['Page.$ then actual Element.tap','tapElement Page.$ default and actual fallback sequence'].includes(planned.sourceAcquisition) && key === '$'
          if (single) {
            require((helperStep(planned) ? args.length === 1 : args.length === 2 && keys(args[1]) === 'timeout' && args[1].timeout === planned.queryOptions.timeout) && !singleAcquisition,
              'single-element source query options or acquisition count differs')
            singleAcquisition = { cursor: at, acquisition: id }
            if(helperStep(planned)) tapHelperAcquisitions.push({planOrdinal:planAt,actionOrdinal:planned.ordinal,sourceStepCursor:at,pageId:before.pageId,epoch:before.epoch,route:before.route,acquisition:id,selector:args[0],argumentCount:args.length,present:result!==null&&result!==undefined})
          }
          bindResults(result, key, { info: before, address, acquisition: id, cursor: at,
            canonical: matches && (single || key === '$$' && planned.sourceAcquisition === 'Page.$$ then unique Element.tap') })
        })
        return result
      } finally { pending-- }
    })
    return page
  }
  return {
    diagnostics: () => ({ ...lineage.snapshot(), ...(descriptor.plans.some(plan=>plan.steps.some(helperStep)) ? {tapHelperJournal:{schemaVersion:1,kind:'pinned-tap-helper-journal-v1',caseId:descriptor.caseId,sourceSha256:descriptor.sourceSha256,acquisitions:structuredClone(tapHelperAcquisitions),attempts:structuredClone(tapHelperAttempts)}}:{}), methodOutcomes: structuredClone(methodOutcomes), pollAttempts: structuredClone(pollAttempts),
      ...(Object.keys(methodPollPolicies).length ? { sourcePollJournal: { schemaVersion: 1, kind: 'pinned-pure-read-poll-journal-v1',
        caseId: descriptor.caseId, sourceSha256: descriptor.sourceSha256,
        normalization: structuredClone(descriptor.plans[0].steps.find(entry => entry.kind === 'method.poll').normalization),
        attempts: structuredClone(pollAttempts) } } : {}) }),
    async sourcePoll({ timeoutMs, intervalMs, matcher }, invoke) {
      const planned = step(), info = active, prior = pollScope
      const startedAtMs = clock(), scope = { step: planned, info, startedAtMs, deadline: startedAtMs + timeoutMs, attempts: 0, completed: false }
      caught(() => require(typeof invoke === 'function' && !prior && !readinessScope && !pending && !inFlight
        && planned?.kind === 'method.poll' && current(info) && info.route === plan().route
        && timeoutMs === planned.timeoutMs && intervalMs === planned.intervalMs && matcher === planned.matcher,
      'original expect.poll scope/defaults are absent, concurrent, stale or overridden'))
      pollScope = scope
      try {
        const result = await invoke()
        caught(() => {
          healthy(); require(pollScope === scope && !pending && !inFlight && step() === planned && current(info)
            && clock() <= scope.deadline && scope.attempts > 0 && scope.last?.kind === 'fulfilled'
            && methodPollPolicies[planned.sourceCallsite].satisfied(decodeMethodValue(scope.last.value)),
          'original expect.poll matcher omitted actual calls, failed its condition or completed after its source deadline')
          scope.completed = true
          emit({ kind: 'event', op: 'method.poll', payload: { planOrdinal: planAt, actionOrdinal: planned.ordinal,
            route: info.route, method: planned.method, args: methodArguments(planned.args), sourceCallsite: planned.sourceCallsite,
            helperSha256: planned.helperSha256, ...(planned.callOptions?{callOptions:structuredClone(planned.callOptions)}:{}), completion: structuredClone(scope.last) } })
          advance()
        })
        return result
      } catch (error) {
        caught(() => require(false, 'original expect.poll matcher did not complete successfully'))
        throw error
      } finally { pollScope = prior }
    },
    async routePageMethod({ session, route, method, args, helperSha256 }, invoke) {
      require(typeof invoke === 'function', 'route-method source invocation is absent')
      const info = active, scope = { info, sawPage: false }, previous = routeMethodScope
      caught(() => require(!previous && current(info) && session?.[ownership] === owner && routeOf(route) === info.route,
        'route-method source session/route is stale or substituted'))
      routeMethodScope = scope
      try {
        return await observeMethod(info?.page, info?.page, [method, ...methodArguments(args)], async () => {
          const value = await invoke()
          caught(() => require(scope.sawPage && routeMethodScope === scope, 'route-method source helper omitted its actual Page acquisition'))
          return value
        }, 'callRoutePageMethod then awaited terminal completion', helperSha256)
      } finally { routeMethodScope = previous }
    },
    readinessStart({ session, page, route, timeoutMs, startedAt, helperSha256 }) {
      if (!Object.keys(readinessPolicies).length) return undefined
      healthy(); const planned = step(), info = pages.get(page), policy = readinessPolicies[planned?.sourceCallsite]
      require(!readinessScope && !pending && !inFlight && planned?.kind === 'method.readiness' && current(info)
        && session?.[ownership] === owner && routeOf(route) === plan().route && timeoutMs === policy.timeoutMs
        && helperSha256 === planned.readinessHelperSha256 && Number.isSafeInteger(startedAt) && startedAt <= clock()
        && clock() <= startedAt + timeoutMs, 'source readiness scope is absent, stale or malformed')
      readinessScope = { token: {}, step: planned, info, deadline: startedAt + timeoutMs, attempts: 0, satisfied: false }
      return readinessScope.token
    },
    readinessEnd(token) {
      if (!Object.keys(readinessPolicies).length && token === undefined) return
      healthy(); const scope = readinessScope
      require(scope && token === scope.token && scope.satisfied && scope.attempts > 0 && !pending && !inFlight
        && clock() <= scope.deadline, 'source readiness scope timed out, is pending or never met its predicate')
      readinessScope = undefined
    },
    attach(program) {
      healthy(); require(!closed && program && typeof program === 'object', 'attachment has no open actual MiniProgram')
      const recovered = programs.get(program) ?? program[ownership]
      if (recovered) { require(owners.has(recovered) && recovered === owner, 'cannot reactivate another actual transport'); programs.set(program, recovered); return }
      require(pending === 0 && !established, 'transport changed inside a pending operation or source plan')
      const transport = { program, epoch: 0 }; owners.add(transport); programs.set(program, transport); owner = transport; active = undefined
      require(['currentPage', 'reLaunch'].some(key => typeof program[key] === 'function'), 'provider has no actual Page acquisition')
      Object.defineProperty(program, ownership, { configurable: true, value: transport })
      restores.push(() => { if (program[ownership] === transport) delete program[ownership] })
      for (const key of ['currentPage', 'reLaunch']) if (typeof program[key] === 'function') wrap(program, key, original => async function (...args) {
        if (lineage.internal()) {
          const result = await lineage.run(() => Reflect.apply(original, this, args), { operation: `MiniProgram.${key}`, owner: transport })
          if (routeMethodScope) caught(() => {
            const info = routeMethodScope.info
            require(key === 'currentPage' && owner === transport && this?.[ownership] === transport && current(info)
              && result && routeOf(result.path) === info.route && result.pageId === info.pageId,
            'route-method helper acquired another actual Page incarnation or transport')
            routeMethodScope.sawPage = true
          })
          return result
        }
        const epoch = transport.epoch, at = cursor, exclusive = pending === 0, planned = step(), before = active; pending++
        try {
          const result = await lineage.run(() => Reflect.apply(original, this, args), { operation: `MiniProgram.${key}`, owner: transport, epoch })
          caught(() => {
            healthy(); require(!closed && owner === transport && this?.[ownership] === transport && at === cursor && transport.epoch === epoch && exclusive,
              'Page acquisition crossed an actual operation, owner or source step')
            const explicit = key === 'reLaunch' && planned?.kind === 'reLaunch'
            if (key === 'reLaunch') {
              require(result && routeOf(args[0]) === routeOf(result.path), 'actual reLaunch returned another route')
              if (explicit) {
                require(current(before) && planned.route === routeOf(args[0]) && args.length === 1
                  && Number.isSafeInteger(result.pageId) && result.pageId !== before.pageId,
                'source in-plan reLaunch lacks its actual new Page incarnation')
                established = undefined
              } else require(!established, 'actual reLaunch crossed a source plan')
              transport.epoch++
            }
            observePage(result, transport, transport.epoch)
            if (explicit) {
              established = active
              emit({ kind: 'event', op: 'reLaunch', payload: { planOrdinal: planAt, actionOrdinal: planned.ordinal,
                route: active.route, sourceCallsite: planned.sourceCallsite } })
              advance()
            }
          })
          return result
        } finally { pending-- }
      })
    },
    checkpoint(observation, context) {
      try {
        healthy(); require(!closed && pending === 0 && !inFlight && !pollScope, 'checkpoint crossed a pending operation or flush')
        const planned = step(), evidence = observation?.evidence, info = context === undefined ? active : pages.get(context?.page)
        require(planned?.kind === 'checkpoint' && evidence?.id === planned.id, 'actual checkpoints are missing, duplicated or reordered')
        require(current(info), 'checkpoint lacks its actual Page/session/route generation: current Page')
        require(!rootReadiness||samePage(rootReady,info),'checkpoint omitted its original actual Page root readiness')
        require(context === undefined || context?.session?.[ownership] === owner, 'checkpoint lacks its actual Page/session/route generation: session owner')
        require(evidence.route === stepRoute() && info.route === evidence.route, 'checkpoint lacks its actual Page/session/route generation: route')
        const nodes = projectCheckpoint(evidence.nodes, planned.queries), identity = { planOrdinal: planAt, route: info.route }
        establish(info)
        emit({ kind: 'render', op: 'dom.checkpoint', payload: { ...identity, checkpointOrdinal: planned.ordinal, id: evidence.id, nodes } })
        advance()
      } catch (error) { fail(error) }
    },
    flush() {
      if (closed) { healthy(); return }
      closed = true
      for (const restore of restores.reverse()) caught(restore)
      lineage.close(); healthy()
      require(planAt === descriptor.plans.length && stepAt === 0 && pending === 0 && !inFlight && !readinessScope && !pollScope, 'actual source-step coverage is incomplete')
    },
  }
}
