/** Internal native IPC adapter for the reviewed synchronous wxml profile.
 * Completion is an accepted/presented generation after a real owner pump;
 * this is not a claim about future timers, network or arbitrary async work. */
import { isDeepStrictEqual } from 'node:util'
import { createOpaqueNativeNodes } from './opaque-native-nodes.mjs'
import { decodeMethodValue, methodArguments } from '../../../conformance/recipes/source-method-values.mjs'

const require = (condition, message) => { if (!condition) { const error = new Error(message); error.code = 'CONFORMANCE_NATIVE_PROVENANCE_FAILED'; throw error } }
const decimal = (value, field) => {
  require(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n,
    `Native completion ${field} is not a canonical u64`)
  return BigInt(value)
}
const routeOf = value => {
  require(typeof value === 'string' && value.trim() === value && !/[\\?#]/.test(value), 'Native actual route is malformed')
  const route = value.replace(/^\/+|\/+$/g, '')
  require(route && route.split('/').every(part => part && part !== '.' && part !== '..'), 'Native actual route is not canonical')
  return route
}
const sameScope = (left, right) => Array.isArray(left) && Array.isArray(right) && isDeepStrictEqual(left, right)

export function validateCompletion(value, previous, { action = false } = {}) {
  require(value?.kind === 'owner-pump-native-presentation-v1' && value.presented === true
    && typeof value.sessionId === 'string' && value.sessionId && value.route === routeOf(value.route),
  'Native completion lacks its actual owner/presentation identity')
  for (const key of ['pageId', 'templateRevision', 'consumedTemplateRevision', 'frameId', 'renderRevision',
    'presentationAckRevision', 'actionSeq', 'ownerPumpSeq', 'requiredPumpSeq']) decimal(value[key], key)
  require(decimal(value.renderRevision, 'renderRevision') > 0n && decimal(value.frameId, 'frameId') > 0n
    && value.templateRevision === value.consumedTemplateRevision && value.renderRevision === value.presentationAckRevision
    && decimal(value.ownerPumpSeq, 'ownerPumpSeq') >= decimal(value.requiredPumpSeq, 'requiredPumpSeq')
    && decimal(value.ownerPumpSeq, 'ownerPumpSeq') > 0n,
  'Native completion has an unpresented, stale-input or unpumped generation')
  if (previous) {
    require(value.sessionId === previous.sessionId && decimal(value.ownerPumpSeq, 'ownerPumpSeq') > decimal(previous.ownerPumpSeq, 'ownerPumpSeq')
      && decimal(value.actionSeq, 'actionSeq') === decimal(previous.actionSeq, 'actionSeq') + (action ? 1n : 0n),
    'Native completion crossed its session, owner pump or action sequence')
    require(action ? decimal(value.requiredPumpSeq, 'requiredPumpSeq') > decimal(previous.ownerPumpSeq, 'ownerPumpSeq')
      : value.requiredPumpSeq === previous.requiredPumpSeq, 'Native action did not require a new actual owner pump')
    if (!action) require(value.pageId === previous.pageId && value.route === previous.route,
      'Native completion changed its page without an original action')
    require(decimal(value.renderRevision, 'renderRevision') >= decimal(previous.renderRevision, 'renderRevision'),
      'Native accepted presentation revision went backwards')
  }
  return structuredClone(value)
}

export function createObservedNativeProgram(request, { signal, methodContext, nowNs = () => BigInt(Date.now()) * 1000000n,
  methodBudgetNs = 8000000000n, nodeContext, readinessPolicies = {}, methodPollPolicies = {}, readinessRemainingNs, dataContext, pageRootReadiness } = {}) {
  let previous, ready, active, methodAt = 0, methodInvocation = 0
  const pages = new Map(), completions = [], methodFacts = [], nodeInputFacts = [], methodTickets = new Set()
  // Context is copied before the first await; source addresses never come from
  // expected oracle return values. The full receipt reader authenticates startup.
  const methods = methodContext === undefined ? undefined : structuredClone(methodContext)
  if (methods) {
    require(/^[a-f0-9]{64}$/.test(methods.sourceSha256) && ['quickjs', 'v8'].includes(methods.startup?.engine)
      && typeof methods.startup?.sessionId === 'string' && methods.startup.sessionId
      && Array.isArray(methods.methods) && methods.methods.length > 0, 'Native method context lacks its pinned source/actual startup')
    require(typeof methodBudgetNs === 'bigint' && methodBudgetNs > 0n && methodBudgetNs <= 60000000000n,
      'Native method budget must be bounded and positive')
    for (const spec of methods.methods) {
      require(spec.route === routeOf(spec.route) && typeof spec.method === 'string' && spec.method && spec.method.trim() === spec.method
        && typeof spec.sourceCallsite === 'string' && spec.sourceCallsite.length > 0 && spec.sourceCallsite.length <= 256,
      'Native method context source address is malformed')
      methodArguments(spec.args)
      require(spec.callOptions === undefined || ['method.call','method.poll'].includes(spec.kind) && Object.keys(spec.callOptions).sort().join(',') === 'timeout'
        && Number.isSafeInteger(spec.callOptions.timeout) && spec.callOptions.timeout > 0 && spec.callOptions.timeout <= 60000,
      'Native original explicit method options are malformed')
      require(spec.kind !== 'method.readiness' || typeof readinessPolicies[spec.sourceCallsite]?.ready === 'function',
        'Native readiness method has no original source policy')
      require(spec.kind !== 'method.poll' || typeof methodPollPolicies[spec.sourceCallsite]?.satisfied === 'function',
        'Native poll method has no original source policy')
    }
  }
  const data = dataContext === undefined ? undefined : structuredClone(dataContext), dataFacts=[], runtimeLogFacts=[], nativeRuntimeEntries=[]
  let dataAt=0, previousJournal, sourceLogCursor
  const runtimeOwner=data?{engine:data.startup?.engine,sessionId:data.startup?.sessionId,incarnation:data.startup?.runtimeDataObservation?.incarnation}:undefined
  if(data) require(/^[a-f0-9]{64}$/.test(data.sourceSha256) && ['quickjs','v8'].includes(runtimeOwner.engine)
    && typeof runtimeOwner.sessionId==='string' && runtimeOwner.sessionId && typeof runtimeOwner.incarnation==='string' && runtimeOwner.incarnation
    && data.startup.runtimeDataObservation.kind==='private-receiver-data-and-runtime-journal-v1'
    && data.startup.runtimeDataObservation.journalBegins==='native-realm-bootstrap-before-app-modules'
    && Array.isArray(data.reads),'Native data/runtime context lacks its actual startup journal owner')
  const callSourceData=async(page,scopeId,path,options,target,address)=>{
    const spec=data?.reads[dataAt]
    require(page===active && spec?.route===page.path && spec.target===target && spec.path===path
      && (spec.options ? options && Object.keys(options).sort().join(',')==='timeout'
        && Object.getOwnPropertyDescriptor(options,'timeout')?.value===spec.options.timeout : options===undefined)
      && (target==='Page'||isDeepStrictEqual(spec.address,address)),
      'Native data read is not its next original source address')
    const source={sha256:data.sourceSha256,callsite:spec.sourceCallsite}
    const observed=await send('data.read',{owner:runtimeOwner,route:page.path,pageId:page.nativePageId,scopeId:scopeId??null,path,source})
    require(page===active && observed?.kind==='native-private-receiver-data-v1' && isDeepStrictEqual(observed.owner,runtimeOwner)
      && observed.route===page.path && observed.pageId===page.nativePageId && observed.scopeId===(scopeId??null)
      && observed.path===path && isDeepStrictEqual(observed.source,source) && /^[a-f0-9]{64}$/.test(observed.receiverTokenSha256),
      'Native data result lacks its actual source/Page/component instance owner')
    const completion=accept(observed.completion)
    require(completion.pageId===page.nativePageId && completion.route===page.path,'Native data result changed its actual Page')
    const value=decodeMethodValue(observed.value);dataAt++;dataFacts.push(structuredClone(observed));return value
  }
  const captureRuntimeLogs=async(reset=false,terminal=false)=>{
    require(data && typeof reset==='boolean','Native runtime logs require their actual startup owner')
    const observed=await send(terminal?'runtime.logs.close':'runtime.logs',{owner:runtimeOwner,...(terminal?{}:{reset})})
    const journal=observed?.journal
    require(observed?.kind==='native-runtime-log-snapshot-v1' && isDeepStrictEqual(observed.owner,runtimeOwner) && (terminal?observed.closed===true:observed.reset===reset)
      && journal?.kind==='runtime-logs' && journal.complete===true && journal.overflow===false
      && Number.isSafeInteger(journal.generation) && journal.generation>=0 && Number.isSafeInteger(journal.startCursor) && journal.startCursor>=0
      && Number.isSafeInteger(journal.resetCursor) && journal.resetCursor>=journal.startCursor && journal.resetCursor<=journal.endCursor
      && Number.isSafeInteger(journal.endCursor) && journal.endCursor>=journal.startCursor && Array.isArray(journal.entries)
      && journal.entries.length===journal.endCursor-journal.startCursor && journal.entries.length<=1024
      && journal.entries.reduce((total,entry)=>total+(typeof entry.text==='string'?entry.text.length:65537),0)<=65536
      && journal.entries.every((entry,at)=>Object.keys(entry).sort().join(',')==='cursor,level,text' && entry.cursor===journal.startCursor+at
        && ['debug','info','log','warn','error','exception'].includes(entry.level) && typeof entry.text==='string' && entry.text.length<=65536),
      'Native runtime journal is incomplete, overflowed or has missing/reordered entries')
    require(!previousJournal || journal.endCursor>=previousJournal.endCursor
      && journal.startCursor===previousJournal.startCursor && isDeepStrictEqual(journal.entries.slice(0,previousJournal.entries.length),previousJournal.entries)
      && (reset?journal.generation===previousJournal.generation+1 && journal.resetCursor===journal.endCursor
        : journal.generation===previousJournal.generation && journal.resetCursor===previousJournal.resetCursor),
      'Native runtime journal reset/cursor ownership changed')
    previousJournal=structuredClone(journal);runtimeLogFacts.push(structuredClone(observed))
    if(reset)sourceLogCursor=journal.resetCursor
    const selected=journal.entries.filter(entry=>sourceLogCursor!==undefined && entry.cursor>=sourceLogCursor).map(({level,text})=>({
      // Pinned automator.ts resolveConsoleLevel: explicit debug/info/warn/error
      // take precedence, while log uses the exact original text classifiers.
      level:level==='log' ? (/\b(?:TypeError|ReferenceError|SyntaxError|Error|RangeError)\b/.test(text)?'error':/\b(?:warn(?:ing)?|deprecated|deprecation)\b/i.test(text)||/\[Component\]/.test(text)?'warn':'log') : level,text
    }));nativeRuntimeEntries.splice(0,nativeRuntimeEntries.length,...selected);return selected
  }
  const callSourceMethod = async (page, name, args, callOptions) => {
    const spec = methods?.methods[methodAt]
    require(page === active && spec?.route === page.path && spec.method === name
      && isDeepStrictEqual(methodArguments(args), spec.args) && (spec.callOptions
        ? callOptions && Object.keys(callOptions).sort().join(',') === 'timeout' && callOptions.timeout === spec.callOptions.timeout
        : callOptions === undefined), 'Native method is not the next original action on the current Page')
    const remaining = ['method.readiness', 'method.poll'].includes(spec.kind) && readinessRemainingNs ? readinessRemainingNs() : methodBudgetNs
    require(typeof remaining === 'bigint' && remaining > 0n, 'Native readiness original source budget expired')
    const sourceBudget = spec.callOptions ? BigInt(spec.callOptions.timeout) * 1000000n : methodBudgetNs
    const budget = spec.kind === 'method.poll' && !spec.callOptions ? remaining : remaining < sourceBudget ? remaining : sourceBudget
    const now = nowNs(); require(typeof now === 'bigint' && now >= 0n && now + budget <= 18446744073709551615n,
      'Native method original deadline is outside u64 time')
    const sourceInvocationId = `${methods.sourceSha256}/${methodInvocation++}`, deadlineNs = String(now + budget)
    const source = { sha256: methods.sourceSha256, callsite: spec.sourceCallsite }
    if (!['method.readiness', 'method.poll'].includes(spec.kind)) methodAt++
    let result
    try { result = await send('method.call', { route: page.path, method: name, args: methodArguments(args), sourceInvocationId, deadlineNs, source }) }
    catch (error) { methodFacts.push({ sourceInvocationId, sourceDeclaration: source, route: page.path, pageId: page.nativePageId,
      status: 'transport-rejected', errorType: typeof error }); throw error }
    const owner = result?.owner
    require(page === active && result?.kind === 'native-guest-method-result-v1'
      && owner?.kind === 'source-labelled-native-method-owner-v1' && owner.engine === methods.startup.engine
      && owner.sessionId === methods.startup.sessionId && owner.sessionId === previous.sessionId
      && owner.sourceInvocationId === sourceInvocationId && isDeepStrictEqual(owner.sourceDeclaration, source)
      && owner.sourceDeclarationTrust === 'caller-declared-not-official-oracle' && owner.route === page.path && owner.pageId === page.nativePageId
      && owner.originalDeadlineNs === deadlineNs && owner.deadlineClock === 'original-unix-deadline-plus-once-anchored-monotonic-budget'
      && owner.sessionBeginAttempts === 1 && Number.isSafeInteger(owner.sessionPollAttempts) && owner.sessionPollAttempts >= 1
      && /^[a-f0-9]{64}$/.test(owner.receiverTokenSha256) && /^[a-f0-9]{64}$/.test(owner.requestSha256),
    'Native method result lacks its same-source/Page/engine original-deadline owner')
    const completion = accept(result.completion, { action: true })
    require(completion.route === page.path && completion.pageId === page.nativePageId,
      'Native method completion changed its original Page incarnation')
    const observation = result.observation
    require(observation && typeof observation.ticket === 'string' && observation.ticket && !methodTickets.has(observation.ticket),
      'Native method terminal ticket is absent or duplicated')
    methodTickets.add(observation.ticket)
    methodFacts.push({ owner: structuredClone(owner), observation: structuredClone(observation), completion: structuredClone(completion) })
    if (observation.kind !== 'fulfilled') {
      require(['threw', 'rejected', 'serialization-failed', 'unsupported', 'revoked', 'cancelled'].includes(observation.kind),
        'Native method did not deliver an explicit terminal outcome')
      if (['method.readiness', 'method.poll'].includes(spec.kind) && ['threw', 'rejected'].includes(observation.kind)
        && ['undefined', 'json'].includes(observation.reason?.kind)) throw decodeMethodValue(observation.reason)
      const error = new Error(`Actual native method ${observation.kind}`)
      error.name = 'NativeSourceMethodError'; error.observation = structuredClone(observation); error.owner = structuredClone(owner)
      throw error
    }
    require(Object.keys(observation).sort().join(',') === 'kind,ticket,value', 'Native method fulfilled outcome has unreviewed fields')
    const value = decodeMethodValue(observation.value)
    if (spec.kind === 'method.readiness' && readinessPolicies[spec.sourceCallsite].ready(value)
      || spec.kind === 'method.poll' && methodPollPolicies[spec.sourceCallsite].satisfied(value)) methodAt++
    return value
  }
  const send = async (op, payload = {}) => {
    if (signal?.aborted) throw signal.reason ?? new Error('Native replay aborted')
    const result = await request(op, payload)
    if (signal?.aborted) throw signal.reason ?? new Error('Native replay aborted')
    return result
  }
  const accept = (value, options) => {
    previous = validateCompletion(value, previous, options)
    completions.push(previous)
    return previous
  }
  // One completion ledger covers the legacy and explicit opaque-node channels.
  // The channel never falls back to selectors after an actual acquisition.
  const opaque = nodeContext?.enabled === true ? createOpaqueNativeNodes(send, {
    enabled: true, requestedEngine: nodeContext.requestedEngine, startup: nodeContext.startup, acceptCompletion: accept, signal,
  }) : undefined
  const rootReadiness=pageRootReadiness===undefined?undefined:structuredClone(pageRootReadiness)
  if(rootReadiness)require(opaque&&rootReadiness.timeoutMs===5000&&typeof rootReadiness.selector==='string'
    &&Object.keys(rootReadiness).sort().join(',')==='helperSha256,selector,sourceCallsite,timeoutMs','Native root readiness lacks its exact explicit source profile')
  const actualPage = page => ({ route: page.path, pageId: page.nativePageId })
  const opaqueElements = async (page, target, selection) => {
    require(page === active, 'Native opaque query has no current actual Page')
    const value = await opaque.acquire(actualPage(page), target, selection)
    require(page === active, 'Native opaque acquisition outlived its actual Page')
    nodeInputFacts.push({operation:'acquire',evidence:structuredClone(value)})
    return value.nodes.map(node => {
      const current = () => require(page === active, 'Native opaque Element belongs to a retired actual Page')
      return {
        id: node.metadata.id,
        ...(node.metadata.componentScopeId ? { tagName: 'component', componentScopeId: node.metadata.componentScopeId } : {}),
        async $$(selector) { current(); return opaqueElements(page, { parent: node.handle, selector }, 'all') },
        async $(selector) { current(); return (await opaqueElements(page, { parent: node.handle, selector }, 'first'))[0] ?? null },
        async tap() {
          current()
          const proof = await opaque.tap(actualPage(page), node.handle)
          current()
          nodeInputFacts.push({operation:'tap',evidence:structuredClone(proof)})
        },
        ...Object.fromEntries(['trigger','touchstart','touchend','dispatchEvent'].map(operation=>[operation,async function(){
          current();throw Object.assign(new Error('Native opaque '+operation+' has no reviewed input transport'),{code:'NATIVE_OPAQUE_INPUT_UNSUPPORTED'})
        }])),
        async text() { current(); throw new Error('Opaque Element text has no reviewed exact-node read contract') },
        async attribute() { current(); throw new Error('Opaque Element attribute has no reviewed exact-node read contract') },
      }
    })
  }
  const start = () => ready ??= (async () => {
    const completion = accept(await send('render.settle'))
    require(!methods || completion.sessionId === methods.startup.sessionId, 'Native method actual startup session differs from completion')
    return completion
  })()
  const address = (value, page, scope, selector) => {
    require(value && value.route === page.path && value.selector === selector && sameScope(value.scope ?? [], scope),
      'Native read returned another actual route, selector or component scope')
    const completion = accept(value.completion)
    require(completion.route === page.path && completion.pageId === page.nativePageId,
      'Native read returned another actual page incarnation')
    require(Number.isSafeInteger(value.frameId) && value.frameId >= 0 && String(value.frameId) === completion.frameId
      && Number.isSafeInteger(value.renderRevision) && value.renderRevision >= 0 && String(value.renderRevision) === completion.renderRevision,
    'Native read frame does not match its accepted/presented completion')
  }
  const queryElements = async (page, scope, selector) => {
    require(page === active, 'Native query has no current actual Page')
    require(typeof selector === 'string' && selector, 'Native query needs a selector')
    const target = { route: page.path, ...(scope.length ? { scope: [...scope] } : {}), selector }
    const observed = await send('query', target)
    address(observed, page, scope, selector)
    require(Number.isSafeInteger(observed.count) && observed.count >= 0 && Array.isArray(observed.nodes)
      && observed.nodes.length === observed.count, 'Native query lacks actual node-count evidence')
    const ids = observed.nodes.map(node => node?.id)
    require(ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length, 'Native matches have absent or duplicate actual node identities')
    require(observed.nodes.every(node => node.componentScopeId == null || typeof node.componentScopeId === 'string'
      && node.componentScopeId && node.componentScopeId.trim() === node.componentScopeId && !node.componentScopeId.includes('\0')),
    'Native matches have malformed actual component host metadata')
    return observed.nodes.map(node => {
    const unique = () => require(observed.count === 1 && page === active, 'Native Element operation needs its unique current actual acquisition')
    return {
      id: node.id,
      ...(typeof node.componentScopeId === 'string' && node.componentScopeId ? { tagName: 'component', componentScopeId: node.componentScopeId } : {}),
      async $$(selector) {
        unique()
        require(typeof node.componentScopeId === 'string' && node.componentScopeId,
          'Native child query has no concrete runtime component host')
        return queryElements(page, [...scope, target.selector], selector)
      },
      async $(selector) { return (await this.$$(selector))[0] ?? null },
      ...(data && node.componentScopeId ? {async data(path) {
        unique();return await callSourceData(page,node.componentScopeId,path,undefined,'Element',
          {selector,query:'css',...(scope.length?{scope:[...scope]}:{})})
      }} : {}),
      async text() {
        unique()
        const value = await send('query.text', target)
        address(value, page, scope, selector)
        require(value.count === 1 && typeof value.text === 'string', 'Native text read has no actual rendered string')
        return value.text
      },
      async attribute(name) {
        unique()
        require(typeof name === 'string' && name && name.trim() === name && !name.includes('\0'), 'Native attribute needs a canonical field name')
        const value = await send('query.attribute', { ...target, name })
        address(value, page, scope, selector)
        require(value.count === 1 && value.name === name && typeof value.present === 'boolean' && value.value && typeof value.value === 'object',
          'Native attribute read lacks actual field presence')
        if (value.present === false) {
          require(Object.keys(value.value).join(',') === 'type' && value.value.type === 'absent', 'Native absent field has a fabricated value')
          throw new Error('Native absent attribute has no reviewed Automator getter-value contract for this profile')
        }
        require(Object.keys(value.value).sort().join(',') === 'type,value' && value.value.type === 'string' && typeof value.value.value === 'string',
          'Native present attribute has no actual rendered string')
        return value.value.value
      },
      async tap() {
        unique()
        const value = await send('tap', target)
        require(value && value.route === page.path && value.selector === selector && sameScope(value.scope ?? [], scope)
          && value.inputTransport === 'native-host-coordinate-event' && Number.isFinite(value.x) && Number.isFinite(value.y),
        'Native tap lacks its actual coordinate-input proof')
        const input = accept(value.inputCompletion)
        require(input.route === page.path && input.pageId === page.nativePageId
          && Number.isSafeInteger(value.frameId) && String(value.frameId) === input.frameId
          && Number.isSafeInteger(value.renderRevision) && String(value.renderRevision) === input.renderRevision,
        'Native tap coordinates belong to another accepted input presentation')
        const completion = accept(value.completion, { action: true })
        require(completion.route === page.path && completion.pageId === page.nativePageId, 'Synchronous wxml tap changed its actual page')
        return value
      },
    }
    })
  }
  const pageFrom = value => {
    require(value && value.path === routeOf(value.path) && value.completion?.route === value.path
      && value.pageId === value.completion.pageId, 'Native currentPage lacks its actual route/page identity')
    const id = value.pageId, numeric = Number(id)
    require(Number.isSafeInteger(numeric) && numeric >= 0 && String(numeric) === id, 'Native Page ID cannot be represented by the pinned Automator contract')
    let page = pages.get(id)
    if (!page) {
      page = { path: value.path, pageId: numeric, nativePageId: id,
        ...(rootReadiness?{async waitForRendered(options){
          require(page===active&&options&&Object.keys(options).sort().join(',')==='selector,timeout'
            &&options.selector===rootReadiness.selector&&options.timeout===rootReadiness.timeoutMs,'Native root readiness changed its original options/Page')
          const deadline=Date.now()+options.timeout
          while(Date.now()<=deadline){
            const evidence=await opaque.acquire(actualPage(page),{query:{selector:options.selector}},'first')
            require(page===active&&Date.now()<=deadline,'Native root readiness outlived its original Page/deadline')
            nodeInputFacts.push({operation:'root-readiness',evidence:structuredClone(evidence)})
            if(evidence.count>0)return
            await new Promise((resolve,reject)=>{const done=()=>{signal?.removeEventListener('abort',abort);resolve()},timer=setTimeout(done,220)
              const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason??new Error('Native root readiness aborted'))}
              if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true})})
          }
          throw new Error('Native original source root readiness deadline elapsed')
        }}:{}),
        async $$(selector) { return opaque ? opaqueElements(page, { query: { selector } }, 'all') : queryElements(page, [], selector) },
        async $(selector) { return opaque ? (await opaqueElements(page, { query: { selector } }, 'first'))[0] ?? null : (await queryElements(page, [], selector))[0] ?? null },
        ...(opaque ? {async waitFor(ms){
          require(page===active&&ms===240,'Native source wait is outside its reviewed Page/240ms helper')
          await new Promise((resolve,reject)=>{
            const done=()=>{signal?.removeEventListener('abort',abort);resolve()},timer=setTimeout(done,ms)
            const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason??new Error('Native source wait aborted'))}
            if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true})
          })
          require(page===active,'Native source wait outlived its actual Page');accept(await send('render.settle'))
        }}:{}),
        ...(data ? { async data(path,options) {return await callSourceData(page,null,path,options,'Page')} } : {}),
        ...(methods ? { async callMethod(name, ...args) { return callSourceMethod(page, name, args) },
          async callMethodWithOptions(name, options, ...args) { return callSourceMethod(page, name, args, options) } } : {}) }
      pages.set(id, page)
    } else require(page.path === value.path, 'Native actual page ID was reused across different routes')
    active = page
    return page
  }
  return {
    ready: start,
    async settle() { await start(); return accept(await send('render.settle')) },
    async reLaunch(requested) {
      await start()
      const value = await send('reLaunch', { route: requested }), completion = accept(value?.completion, { action: true })
      require(value.path === routeOf(requested) && completion.route === value.path, 'Native reLaunch returned another actual route')
      return pageFrom({ path: value.path, pageId: completion.pageId, completion })
    },
    async currentPage() {
      await start()
      const value = await send('currentPage')
      accept(value?.completion)
      return pageFrom(value)
    },
    async checkpoint(id, page, selectors) {
      require(page === active, 'Native checkpoint has no current actual Page')
      const value = await send('checkpoint', { route: page.path, checkpoint: id, selectors })
      const completion = accept(value?.completion)
      require(value.id === id && value.route === page.path && completion.pageId === page.nativePageId && completion.route === page.path,
        'Native checkpoint returned another actual route/page/id')
      // Completion facts belong to raw IPC/provenance, not the normalized DOM
      // payload shared with the unchanged official helper.
      const { completion: _completion, ...evidence } = value
      return evidence
    },
    completions: () => structuredClone(completions),
    methodFacts: () => structuredClone(methodFacts),
    nodeInputFacts: () => structuredClone(nodeInputFacts),
    ...(data ? {captureRuntimeLogs,async enableLog(timeout,options){require(sourceLogCursor===undefined && timeout>0 && options?.structured===true,'Native source log subscription is duplicate or malformed');await captureRuntimeLogs(false);sourceLogCursor=previousJournal.endCursor;return undefined},async closeRuntimeLogs(){const result=await captureRuntimeLogs(false,true);this.__weappViteRuntimeLogMeta.closed=true;return result},dataFacts:()=>structuredClone(dataFacts),runtimeLogFacts:()=>structuredClone(runtimeLogFacts),
      __weappViteRuntimeLogMeta:{closed:false,entries:nativeRuntimeEntries,reset(){throw new Error('Native reset must complete its actual journal IPC')}}} : {}),
  }
}
