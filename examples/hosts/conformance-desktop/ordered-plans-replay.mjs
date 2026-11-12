/** Shared source-ordered zero-action replay. Only addresses and field names
 * cross native IPC. Full observed values are compared after every plan runs. */
import { isDeepStrictEqual } from 'node:util'
import { orderedNativeQuery, projectOrderedDomNodes } from '../../../conformance/recipes/ordered-dom-projection.mjs'
import { createObservedNativeProgram } from './native-program.mjs'

const require = (condition, message) => { if (!condition) throw new Error(message) }
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : ''
const normalized = event => {
  require(keys(event) === 'kind,op,payload,seq' || keys(event) === 'atNs,kind,op,payload,seq', 'Ordered plans original event has an unreviewed field')
  return { seq: event.seq, kind: event.kind, op: event.op, payload: structuredClone(event.payload) }
}

export function orderedPlansActionTape({ descriptor, assertionIds, trace, label }) {
  require(trace?.caseId === descriptor.caseId && trace.oracle === 'wechat-devtools' && trace.run?.status === 'passed'
    && isDeepStrictEqual(trace.assertions, assertionIds.map(id => ({ id, passed: true }))) && Array.isArray(trace.events)
    && trace.events.length === descriptor.plans.length * 2, `${label} replay lacks its complete passed original ordered-it trace`)
  const events = trace.events.map(normalized)
  require(events.every((event, index) => event.seq === index), `${label} original sequence is missing, duplicated or reordered`)
  return descriptor.plans.map((plan, index) => {
    const active = events[index * 2], checkpoint = events[index * 2 + 1], identity = { planOrdinal: index, checkpointOrdinal: index, route: plan.route }
    require(active.kind === 'lifecycle' && active.op === 'route.active' && isDeepStrictEqual(active.payload, identity),
      `${label} original route/plan ordinal differs from its unchanged source`)
    const payload = checkpoint.payload, planned = plan.checkpoints[0]
    require(checkpoint.kind === 'render' && checkpoint.op === 'dom.checkpoint'
      && keys(payload) === 'checkpointOrdinal,id,nodes,planOrdinal,route' && payload.planOrdinal === index && payload.checkpointOrdinal === index
      && payload.route === plan.route && payload.id === planned.id
      && isDeepStrictEqual(projectOrderedDomNodes(payload.nodes, planned.queries), payload.nodes),
    `${label} original checkpoint addresses/ordinals differ from its unchanged source`)
    return { route: plan.route, requested: '/' + plan.route, id: planned.id,
      selectors: planned.queries.map(orderedNativeQuery),
      ...(plan.renderedRoots ? { renderedRoots: [...plan.renderedRoots] } : {}) }
  })
}

export async function replayOrderedPlans({ descriptor, createCollector, assertionIds, assertStaticOutputs, label,
  request, signal, oracleTrace, staticInputs }) {
  const tape = orderedPlansActionTape({ descriptor, assertionIds, trace: oracleTrace, label }), events = []
  const collector = createCollector({ emit: event => events.push({ ...structuredClone(event), seq: events.length }) })
  const program = createObservedNativeProgram(request, { signal })
  collector.attach(program)
  try {
    await program.ready()
    for (const action of tape) {
      const page = await program.reLaunch(action.requested), actual = await program.currentPage()
      require(page && actual === page && actual.path === action.route,
        `${label} current actual Page differs from its observed navigation`)
      if (action.renderedRoots) {
        let root
        for (const selector of action.renderedRoots) { root = await actual.$(selector); if (root) break }
        require(root, `${label} actual source route has no rendered root`)
      }
      const evidence = await program.checkpoint(action.id, actual, action.selectors)
      collector.checkpoint({ evidence }, { session: program, page: actual })
    }
    collector.flush()
    require(isDeepStrictEqual(events, oracleTrace.events.map(normalized)), `${label} complete actual seq/kind/op/payload trace differs from the original oracle`)
    const staticCoverage = assertStaticOutputs(staticInputs)
    require(staticCoverage.caseId === descriptor.caseId, `${label} static coverage belongs to another source case`)
    return { events, assertions: assertionIds.map(id => ({ id, passed: true })), completionFacts: program.completions(), staticCoverage }
  } catch (error) {
    try { collector.flush() } catch { /* Preserve the actual IPC/assertion error object. */ }
    throw error
  }
}
