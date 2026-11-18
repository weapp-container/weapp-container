/** Replay an admitted ordered source profile. Oracle counts, field values and
 * node identities are held for the final comparison; only addresses drive IPC. */
import { isDeepStrictEqual } from 'node:util'
import { decodeMethodValue, methodArguments } from '../../../conformance/recipes/source-method-values.mjs'
import { createOrderedStepsCollector, queryAddress, projectCheckpoint, sourceAddress } from '../../../conformance/recipes/ordered-steps-collector-core.mjs'
import { createObservedNativeProgram } from './native-program.mjs'
import { createSourceExceptionCollector, exceptionIdentity } from '../../../conformance/recipes/source-exception-capture.mjs'
import {createRuntimeLogCollector} from '../../../conformance/recipes/source-runtime-log-capture.mjs'
import { withNativeExceptionChannel } from './native-exception-channel.mjs'

const require = (condition, message) => { if (!condition) throw new Error(message) }
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : ''
export const normalizedSourceEvent = event => {
  require(keys(event) === 'kind,op,payload,seq' || keys(event) === 'atNs,kind,op,payload,seq', 'Source-plan original event has an unreviewed field')
  return { seq: event.seq, kind: event.kind, op: event.op, payload: structuredClone(event.payload) }
}
export function sourceActionTape(descriptor, trace, { readinessPolicies = {}, methodPollPolicies = {} } = {}) {
  const ids = descriptor.plans.map(plan => plan.fullName)
  require(trace?.caseId === descriptor.caseId && trace.oracle === 'wechat-devtools' && trace.run?.status === 'passed'
    && isDeepStrictEqual(trace.assertions, ids.map(id => ({ id, passed: true }))) && Array.isArray(trace.events),
  'Source-plan replay lacks its complete passed original source trace')
  const events = trace.events.map(normalizedSourceEvent), tape = []
  require(events.every((event, at) => event.seq === at), 'Source-plan original sequence is missing, duplicated or reordered')
  let at = 0
  if (descriptor.exceptionCapture) {
    const event = events[at++], identity = exceptionIdentity(descriptor)
    require(event?.kind === 'lifecycle' && event.op === 'exceptions.begin' && isDeepStrictEqual(event.payload, identity),
      'Source-plan original exception interval has no successful source subscription')
    tape.push({ op: 'exceptions.begin' })
  }
  if(descriptor.runtimeLogCapture){
    const event=events[at++],spec=descriptor.runtimeLogCapture
    require(event?.kind==='lifecycle' && event.op==='runtime.logs.begin' && isDeepStrictEqual(event.payload,{sourceSha256:descriptor.sourceSha256,
      subscriptionCallsite:spec.subscriptionCallsite,subscriptionHelperSha256:spec.subscriptionHelperSha256,structured:true}),
      'Source-plan original structured runtime log subscription is absent')
    tape.push({op:'runtime.logs.begin'})
  }
  for (const plan of descriptor.plans) {
    const active = events[at++]
    require(active?.kind === 'lifecycle' && active.op === 'route.active'
      && isDeepStrictEqual(active.payload, { planOrdinal: plan.ordinal, route: plan.route }), 'Source-plan original active route/ordinal differs')
    tape.push({ op: 'reLaunch', requested: '/' + plan.route }, { op: 'currentPage', route: plan.route, planOrdinal: plan.ordinal })
    if(descriptor.pageRootReadiness){const event=events[at++],spec=descriptor.pageRootReadiness
      require(event?.kind==='event'&&event.op==='route.root.ready'&&isDeepStrictEqual(event.payload,{planOrdinal:plan.ordinal,route:plan.route,...spec}),
        'Source-plan original root readiness is absent, changed or reordered')
      tape.push({op:'route.root.ready',route:plan.route,...spec})
    }
    for (const step of plan.steps) {
      const event = events[at++], identity = { planOrdinal: plan.ordinal, route: plan.route }
      if (step.kind === 'method.readiness') {
        const policy = readinessPolicies[step.sourceCallsite]
        require(policy && typeof policy.ready === 'function', 'Source-plan readiness lacks original policy')
        let current = event, attempt = 0, ready = false
        while (!ready) {
          const payload = current?.payload
          require(current?.kind === 'event' && current.op === 'method.readiness'
            && keys(payload) === 'actionOrdinal,args,attemptOrdinal,completion,helperSha256,method,planOrdinal,ready,route,sourceCallsite'
            && payload.planOrdinal === plan.ordinal && payload.route === plan.route && payload.actionOrdinal === step.ordinal
            && payload.attemptOrdinal === attempt++ && payload.method === step.method
            && isDeepStrictEqual(methodArguments(payload.args), methodArguments(step.args))
            && payload.sourceCallsite === step.sourceCallsite && payload.helperSha256 === step.helperSha256,
          'Source-plan original readiness identity/attempt order differs')
          const completion = payload.completion
          if (completion?.kind === 'fulfilled') {
            require(keys(completion) === 'kind,value', 'Source-plan readiness fulfilled completion is malformed')
            ready = Boolean(policy.ready(decodeMethodValue(completion.value)))
          } else {
            require(keys(completion) === 'kind,thrown' && completion.kind === 'rejected' && completion.thrown,
              'Source-plan readiness rejection is absent')
            ready = false
          }
          require(payload.ready === ready, 'Source-plan readiness predicate differs from original source policy')
          if (!ready) current = events[at++]
        }
        tape.push({ op: 'method.readiness', route: plan.route, planOrdinal: plan.ordinal, method: step.method,
          args: methodArguments(step.args), sourceCallsite: step.sourceCallsite, readinessHelperSha256: step.readinessHelperSha256,
          ...(step.routeHelperSha256 ? { routeHelperSha256: step.routeHelperSha256 } : {}) })
      } else if (step.kind === 'method.poll') {
        const policy = methodPollPolicies[step.sourceCallsite], payload = event?.payload
        require(policy && typeof policy.satisfied === 'function' && policy.timeoutMs === step.timeoutMs && policy.intervalMs === step.intervalMs,
          'Source-plan poll lacks its original policy/defaults')
        require(event?.kind === 'event' && event.op === 'method.poll'
          && keys(payload) === (step.callOptions ? 'actionOrdinal,args,callOptions,completion,helperSha256,method,planOrdinal,route,sourceCallsite' : 'actionOrdinal,args,completion,helperSha256,method,planOrdinal,route,sourceCallsite')
          && isDeepStrictEqual(payload.callOptions,step.callOptions)
          && payload.planOrdinal === plan.ordinal && payload.route === plan.route && payload.actionOrdinal === step.ordinal
          && payload.method === step.method && isDeepStrictEqual(methodArguments(payload.args), methodArguments(step.args))
          && payload.sourceCallsite === step.sourceCallsite && payload.helperSha256 === step.helperSha256
          && keys(payload.completion) === 'kind,value' && payload.completion.kind === 'fulfilled'
          && policy.satisfied(decodeMethodValue(payload.completion.value)),
        'Source-plan original poll final matcher completion/result is absent or differs')
        tape.push({ op: 'method.poll', route: plan.route, method: step.method, args: methodArguments(step.args),
          sourceCallsite: step.sourceCallsite, timeoutMs: step.timeoutMs, intervalMs: step.intervalMs, matcher: step.matcher,
          ...(step.callOptions?{callOptions:structuredClone(step.callOptions)}:{}) })
      } else if (step.kind === 'data.read') {
        const payload=event?.payload,route=step.route??plan.route
        require(event?.kind==='event' && event.op==='data.read' && keys(payload)==='actionOrdinal,completion,options,path,planOrdinal,route,sourceCallsite,target'
          && payload.planOrdinal===plan.ordinal && payload.actionOrdinal===step.ordinal && payload.route===route && payload.target===step.target
          && payload.path===step.path && isDeepStrictEqual(payload.options,step.options) && payload.sourceCallsite===step.sourceCallsite
          && keys(payload.completion)==='kind,value' && payload.completion.kind==='fulfilled','Source-plan original data read identity/order differs')
        decodeMethodValue(payload.completion.value)
        tape.push({op:'data.read',route,target:step.target,path:step.path,options:structuredClone(step.options),sourceCallsite:step.sourceCallsite})
      } else if (step.kind === 'tap') {
        const address = sourceAddress(step.address)
        if(step.sourceAcquisition==='tapElement Page.$ default and actual fallback sequence'){
          let current=event,expected='tap',mode=0,attempt=0,completed=false
          while(!completed){
            const payload=current?.payload,operation=payload?.operation
            const args=operation==='trigger'?['tap']:operation==='dispatchEvent'?[{eventName:'tap'}]:operation==='waitFor'?[240]:[]
            require(attempt<12 && current?.kind==='event'&&current.op==='tap.helper.attempt'
              && keys(payload)==='actionOrdinal,args,attemptOrdinal,completion,helperSha256,operation,planOrdinal,query,route,selector,sourceCallsite'
              && payload.planOrdinal===plan.ordinal&&payload.actionOrdinal===step.ordinal&&payload.route===plan.route
              && payload.selector===address.selector&&payload.query==='css'&&payload.sourceCallsite===step.sourceCallsite
              && payload.helperSha256===step.helper.sha256&&payload.operation===expected&&payload.attemptOrdinal===attempt++
              && isDeepStrictEqual(methodArguments(payload.args),args),'Source-plan original tap helper attempt/order/address differs')
            const outcome=payload.completion
            if(outcome?.kind==='fulfilled'){
              require(keys(outcome)==='kind,value','Source-plan helper fulfilled result is malformed');decodeMethodValue(outcome.value)
              if(operation==='waitFor')completed=true;else expected=operation==='touchstart'?'touchend':'waitFor'
            }else{
              const thrown=outcome?.thrown
              require(outcome?.kind==='rejected'&&keys(outcome)==='kind,thrown'&&(keys(thrown)==='kind'&&thrown.kind==='undefined'
                ||keys(thrown)==='kind,value'&&thrown.kind==='json'&&(thrown.value===null||['string','boolean'].includes(typeof thrown.value)||typeof thrown.value==='number'&&Number.isFinite(thrown.value)&&!Object.is(thrown.value,-0))
                ||keys(thrown)==='kind,valueType'&&thrown.kind==='uninspectable'&&['object','function','symbol','bigint','number'].includes(thrown.valueType)),
              'Source-plan helper rejection is absent or has an unreviewed shape')
              expected=['tap','trigger','touchstart','dispatchEvent'][++mode]
              require(expected,'Source-plan helper exhausted every original fallback')
            }
            if(!completed)current=events[at++]
          }
          const terminal=events[at++]
          require(terminal?.kind==='event'&&terminal.op==='tap'&&isDeepStrictEqual(terminal.payload,{...identity,actionOrdinal:step.ordinal,...address}),
            'Source-plan original helper success omitted its actual completed wait/tap')
          tape.push({op:'tap.helper',route:plan.route,address});continue
        }
        require(event?.kind === 'event' && event.op === 'tap'
          && isDeepStrictEqual(event.payload, { ...identity, actionOrdinal: step.ordinal, ...address }), 'Source-plan original action address/order differs')
        tape.push({ op: 'tap', route: plan.route, address, ...(step.sourceAcquisition === 'Page.$ then actual Element.tap'
          ? { queryMethod: '$', queryOptions: structuredClone(step.queryOptions) } : {}) })
      } else if (step.kind === 'reLaunch') {
        require(event?.kind === 'event' && event.op === 'reLaunch'
          && isDeepStrictEqual(event.payload, { ...identity, route:step.route, actionOrdinal: step.ordinal, sourceCallsite: step.sourceCallsite }),
        'Source-plan original in-plan reLaunch address/order differs')
        tape.push({ op: 'source.reLaunch', requested: '/' + step.route })
      } else if (step.kind === 'method.call') {
        const payload = event?.payload
        require(event?.kind === 'event' && event.op === 'method.call'
          && keys(payload) === (step.callOptions ? 'actionOrdinal,args,callOptions,completion,helperSha256,method,planOrdinal,route,sourceCallsite' : 'actionOrdinal,args,completion,helperSha256,method,planOrdinal,route,sourceCallsite')
          && isDeepStrictEqual(payload.callOptions, step.callOptions)
          && payload.planOrdinal === plan.ordinal && payload.route === plan.route && payload.actionOrdinal === step.ordinal
          && payload.method === step.method && isDeepStrictEqual(methodArguments(payload.args), methodArguments(step.args))
          && payload.sourceCallsite === step.sourceCallsite && payload.helperSha256 === step.helperSha256
          && keys(payload.completion) === 'kind,value' && payload.completion.kind === 'fulfilled',
        'Source-plan original method address/order or terminal completion differs')
        decodeMethodValue(payload.completion.value)
        tape.push({ op: 'method.call', route: plan.route, method: step.method, args: methodArguments(step.args), sourceCallsite: step.sourceCallsite,
          ...(step.routeHelperSha256 ? { routeHelperSha256: step.routeHelperSha256 } : {}),
          ...(step.callOptions ? { callOptions: structuredClone(step.callOptions) } : {}) })
      } else {
        const payload = event?.payload
        require(event?.kind === 'render' && event.op === 'dom.checkpoint' && keys(payload) === 'checkpointOrdinal,id,nodes,planOrdinal,route'
          && payload.planOrdinal === plan.ordinal && payload.route === (step.route??plan.route) && payload.checkpointOrdinal === step.ordinal && payload.id === step.id,
        'Source-plan original checkpoint identity/order differs')
        // Validate the entire observation shape without deriving a runtime
        // condition or an IPC count/text/attribute value from it.
        require(isDeepStrictEqual(projectCheckpoint(payload.nodes, step.queries), payload.nodes), 'Source-plan original fields/address projection differs')
        tape.push({ op: 'checkpoint', route: step.route??plan.route, id: step.id,
          selectors: step.queries.map(query => ({ ...queryAddress(query), fields: structuredClone(query.fields) })) })
      }
    }
  }
  if (descriptor.exceptionCapture) {
    const event = events[at++]
    require(event?.kind === 'lifecycle' && event.op === 'exceptions.end'
      && isDeepStrictEqual(event.payload, { ...exceptionIdentity(descriptor), count: 0 }),
    'Source-plan original exception interval is incomplete or contains actual messages')
    tape.push({ op: 'exceptions.end' })
  }
  if(descriptor.runtimeLogCapture){
    const event=events[at++],spec=descriptor.runtimeLogCapture,payload=event?.payload
    require(event?.kind==='event' && event.op==='runtime.logs.assertion' && keys(payload)==='filter,selected,sourceCallsite,sourceSha256'
      && payload.sourceSha256===descriptor.sourceSha256 && payload.sourceCallsite===spec.sourceCallsite && payload.filter===spec.filter
      && Array.isArray(payload.selected) && payload.selected.every(entry=>entry.level==='error'||entry.level==='exception'),
      'Source-plan original complete runtime log filter is absent or malformed')
    require(payload.selected.length===0,'Source-plan original runtime errors assertion did not pass')
    tape.push({op:'runtime.logs'})
  }
  require(at === events.length, 'Source-plan original trace has extra operations')
  return tape
}
export async function replaySourcePlan({ descriptor, assertStatic, observePlan, request, signal, oracleTrace, staticInputs, startup, readinessPolicies = {}, methodPollPolicies = {}, readinessClock = Date.now, readinessWait = ms => new Promise(resolve => setTimeout(resolve, ms)), tapSourceHelper }) {
  require(observePlan === undefined || typeof observePlan === 'function', 'Source-plan observation hook is malformed')
  const tape = sourceActionTape(descriptor, oracleTrace, { readinessPolicies, methodPollPolicies }), events = [], planObservations = [], methodResults = []
  const collector = (descriptor.exceptionCapture ? createSourceExceptionCollector : descriptor.runtimeLogCapture ? createRuntimeLogCollector : createOrderedStepsCollector)(
    { descriptor, readinessPolicies, methodPollPolicies, clock: readinessClock, emit: event => events.push({ ...structuredClone(event), seq: events.length }) })
  const methods = descriptor.plans.flatMap(plan => plan.steps.filter(step => ['method.call', 'method.readiness', 'method.poll'].includes(step.kind))
    .map(step => ({ kind: step.kind, route: plan.route, method: step.method, args: methodArguments(step.args), sourceCallsite: step.sourceCallsite, ...(step.callOptions ? { callOptions: structuredClone(step.callOptions) } : {}) })))
  const dataReads=descriptor.plans.flatMap(plan=>plan.steps.filter(step=>step.kind==='data.read').map(step=>({...step,route:step.route??plan.route})))
  let activeReadinessDeadline
  let program = createObservedNativeProgram(request, { signal, readinessPolicies, methodPollPolicies,
    ...(descriptor.nativeNodeInput?.enabled===true?{nodeContext:{enabled:true,requestedEngine:startup?.engine,startup}}:{}),
    ...(descriptor.pageRootReadiness?{pageRootReadiness:descriptor.pageRootReadiness}:{}),
    readinessRemainingNs: () => BigInt(Math.max(1, activeReadinessDeadline - readinessClock())) * 1000000n,
    ...(dataReads.length || descriptor.runtimeLogCapture ? {dataContext:{sourceSha256:descriptor.sourceSha256,reads:dataReads,startup}}:{}),
    ...(methods.length ? { methodContext: { sourceSha256: descriptor.sourceSha256, methods, startup } } : {}) })
  if (descriptor.exceptionCapture) program = withNativeExceptionChannel(program, { request, descriptor, startup, signal })
  let page
  const callMethod = entry => entry.routeHelperSha256 ? collector.routePageMethod({ session: program, route: entry.route,
    method: entry.method, args: methodArguments(entry.args), helperSha256: entry.routeHelperSha256 }, async () => {
    const actual = await program.currentPage()
    require(actual === page && actual.path === entry.route, 'Source route-method actual Page differs from its source owner')
    return await actual.callMethod(entry.method, ...methodArguments(entry.args))
  }) : entry.callOptions ? page.callMethodWithOptions(entry.method, structuredClone(entry.callOptions), ...methodArguments(entry.args))
    : page.callMethod(entry.method, ...methodArguments(entry.args))
  collector.attach(program)
  try {
    await program.ready()
    for (const entry of tape) {
      if(entry.op==='runtime.logs.begin')await program.enableLog(15000,{structured:true})
      else if (entry.op === 'exceptions.begin') {
        await program.beginExceptions()
        program.on('exception', event => { require(typeof event.message === 'string', 'Actual native exception message is absent') })
      } else if (entry.op === 'exceptions.end') await program.close()
      else if (entry.op === 'reLaunch') page = await program.reLaunch(entry.requested)
      else if (entry.op === 'source.reLaunch') page = await program.reLaunch(entry.requested)
      else if (entry.op === 'currentPage') {
        const actual = await program.currentPage()
        require(actual === page && actual.path === entry.route, 'Source-plan current Page differs from its actual navigation')
        if (observePlan) {
          const value = await observePlan({ plan: descriptor.plans[entry.planOrdinal], page: actual, program, signal })
          require(value !== undefined, 'Source-plan observation hook returned no actual evidence')
          planObservations.push({ planOrdinal: entry.planOrdinal, route: entry.route, value: structuredClone(value) })
        }
      } else if(entry.op==='route.root.ready'){
        await page.waitForRendered({selector:entry.selector,timeout:entry.timeoutMs})
      } else if(entry.op==='data.read') {
        require(entry.target==='Page','Element data replay requires the original source acquisition profile')
        await page.data(entry.path,entry.options)
      } else if(entry.op==='runtime.logs') {
        await program.captureRuntimeLogs(false)
        const selected=program.__weappViteRuntimeLogMeta.entries.filter(entry=>entry.level==='error'||entry.level==='exception')
        require(selected.length===0,'Source-plan original runtime errors assertion failed')
      } else if (entry.op === 'checkpoint') {
        const evidence = await program.checkpoint(entry.id, page, entry.selectors)
        collector.checkpoint({ evidence }, { session: program, page })
      } else if(entry.op==='tap.helper'){
        require(typeof tapSourceHelper==='function'&&page.path===entry.route,'Source-plan original tap helper is absent or has another Page')
        await tapSourceHelper(page,entry.address.selector)
      } else if (entry.op === 'method.readiness') {
        const policy = readinessPolicies[entry.sourceCallsite], startedAt = readinessClock(), deadline = startedAt + policy.timeoutMs
        activeReadinessDeadline = deadline
        const token = collector.readinessStart({ session: program, page, route: entry.route, timeoutMs: policy.timeoutMs,
          startedAt, helperSha256: entry.readinessHelperSha256 })
        let ready = false, failed = false
        try {
          while (readinessClock() <= deadline) {
            let timer
            const remaining = Math.max(1, deadline - readinessClock())
            try {
              const result = await Promise.race([callMethod(entry),
                new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('Source readiness original deadline elapsed');
                  error.code = 'CONFORMANCE_SOURCE_READINESS_TIMEOUT'; reject(error) }, remaining) })])
              ready = Boolean(policy.ready(result))
              if (ready) break
            } catch (error) {
              if (['CONFORMANCE_NATIVE_PROVENANCE_FAILED', 'CONFORMANCE_SOURCE_READINESS_TIMEOUT'].includes(error?.code)) throw error
              // The pinned original helper catches an actual callback rejection
              // and performs a new source iteration; final methods never retry.
            } finally { clearTimeout(timer) }
            await readinessWait(policy.pollMs)
          }
          require(ready, 'Source readiness original deadline elapsed without its predicate')
        } catch (error) { failed = true; throw error }
        finally {
          try { collector.readinessEnd(token) }
          catch (error) { if (!failed) throw error }
          finally { activeReadinessDeadline = undefined }
        }
      } else if (entry.op === 'method.poll') {
        const policy = methodPollPolicies[entry.sourceCallsite], deadline = readinessClock() + entry.timeoutMs
        activeReadinessDeadline = deadline
        let finalValue
        try {
          await collector.sourcePoll({ timeoutMs: entry.timeoutMs, intervalMs: entry.intervalMs, matcher: entry.matcher }, async () => {
            let satisfied = false
            while (readinessClock() <= deadline) {
              let timer
              try {
                const value = await Promise.race([callMethod(entry), new Promise((_, reject) => { timer = setTimeout(() => {
                  const error = new Error('Original poll deadline elapsed'); error.code = 'CONFORMANCE_SOURCE_POLL_TIMEOUT'; reject(error)
                }, Math.max(1, deadline - readinessClock())) })])
                if (policy.satisfied(value)) { satisfied = true; finalValue = value; break }
              } catch (error) {
                if (['CONFORMANCE_NATIVE_PROVENANCE_FAILED', 'CONFORMANCE_SOURCE_POLL_TIMEOUT'].includes(error?.code)) throw error
              } finally { clearTimeout(timer) }
              await readinessWait(entry.intervalMs)
            }
            require(satisfied, 'Original poll deadline elapsed without successful source matcher')
          })
        } finally { activeReadinessDeadline = undefined }
        methodResults.push({ route: entry.route, method: entry.method, sourceCallsite: entry.sourceCallsite, value: finalValue })
      } else if (entry.op === 'method.call') {
        require(page.path === entry.route, 'Source-plan method belongs to another Page route')
        const value = await callMethod(entry)
        methodResults.push({ route: entry.route, method: entry.method, sourceCallsite: entry.sourceCallsite, value })
      } else {
        require(entry.op === 'tap' && !entry.address.scope?.length && entry.address.has === undefined, 'Source-plan action acquisition is unsupported')
        if (entry.queryMethod === '$') {
          const control = await page.$(entry.address.selector, structuredClone(entry.queryOptions))
          require(control, 'Source-plan original single-element action has no actual rendered control')
          await control.tap()
        } else {
          const nodes = await page.$$(entry.address.selector, { fallback: false, timeout: 5000 })
          require(nodes.length === 1, 'Source-plan original action requires one actual rendered control')
          await nodes[0].tap()
        }
      }
    }
    if(descriptor.runtimeLogCapture)await program.closeRuntimeLogs()
    collector.flush()
    require(isDeepStrictEqual(events, oracleTrace.events.map(normalizedSourceEvent)), 'Source-plan complete actual seq/kind/op/payload trace differs from the original oracle')
    const staticCoverage = assertStatic(staticInputs, { planObservations, methodResults })
    return { events, assertions: descriptor.plans.map(plan => ({ id: plan.fullName, passed: true })), completionFacts: program.completions(), staticCoverage,
      ...(dataReads.length || descriptor.runtimeLogCapture ? {dataFacts:program.dataFacts(),runtimeLogFacts:program.runtimeLogFacts()}:{}),
      ...(methods.length ? { methodFacts: program.methodFacts() } : {}),
      ...(Object.keys(methodPollPolicies).length ? { sourcePollJournal: collector.diagnostics().sourcePollJournal } : {}),
      ...(descriptor.nativeNodeInput?.enabled===true ? {tapHelperJournal:collector.diagnostics().tapHelperJournal,nodeInputFacts:program.nodeInputFacts()}:{}),
      ...(descriptor.exceptionCapture ? { exceptionFacts: program.exceptionFacts() } : {}),
      ...(observePlan ? { planObservations } : {}) }
  } catch (error) {
    try { collector.flush() } catch { /* Preserve the original native/validation error identity. */ }
    throw error
  }
}
