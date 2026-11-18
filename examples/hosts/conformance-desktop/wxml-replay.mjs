/** Replay only the original operation/address tape. Oracle values enter the
 * final comparison after every native observation, never IPC or readiness. */
import { isDeepStrictEqual } from 'node:util'
import { createCollector } from '../../../conformance/recipes/wxml-transform-collector.mjs'
import { descriptor } from '../../../conformance/recipes/wxml-transform-descriptor.mjs'
import { createObservedNativeProgram } from './native-program.mjs'
import { assertWxmlStaticOutputs } from './wxml-static.mjs'

const require = (condition, message) => { if (!condition) throw new Error(message) }
export const wxmlAssertionIds = Object.freeze(['native', 'vue'].map(kind =>
  `WXML function transform runtime preserves typed attributes, renamed tags and events in ${kind} templates`))
const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : ''
const routeOf = value => typeof value === 'string' && value.replace(/^\/+|\/+$/g, '')
const normalized = event => {
  require(keys(event) === 'kind,op,payload,seq' || keys(event) === 'atNs,kind,op,payload,seq', 'Wxml original event has an unreviewed field')
  return { seq: event.seq, kind: event.kind, op: event.op, payload: structuredClone(event.payload) }
}

/** This reads addresses and operation structure only. In particular it does
 * not project text, query result types, attribute values, counts or tap data. */
export function wxmlActionTape(trace) {
  require(trace?.caseId === 'ide-wxml-transform-runtime' && trace.run?.status === 'passed'
    && trace.oracle === 'wechat-devtools' && Array.isArray(trace.events), 'Wxml replay lacks its actual passed original trace')
  require(isDeepStrictEqual(trace.assertions, wxmlAssertionIds.map(id => ({ id, passed: true }))), 'Wxml original assertion identities are incomplete or foreign')
  const events = trace.events.map((event, index) => {
    const value = normalized(event)
    require(value.seq === index, 'Wxml original sequence is missing, duplicated or reordered')
    return value
  })
  const tape = []
  let at = 0
  const take = (kind, op, route) => {
    const event = events[at++]
    require(event?.kind === kind && event.op === op && event.payload?.route === route, 'Wxml original operation/route sequence differs from the pinned source')
    return event.payload
  }
  const checkpoint = (route, index) => {
    const planned = descriptor.checkpoints[index], payload = take('render', 'dom.checkpoint', route)
    require(keys(payload) === 'id,nodes,route' && payload.id === planned.id && Array.isArray(payload.nodes)
      && payload.nodes.length === planned.selectors.length && payload.nodes.every((group, index) =>
        keys(group) === 'count,nodes,query,selector' && group.selector === planned.selectors[index] && group.query === 'css'),
    'Wxml original checkpoint address/selector projection differs')
    tape.push({ op: 'checkpoint', route, id: planned.id, selectors: [...planned.selectors] })
  }
  for (const route of descriptor.routes) {
    let launches = 0
    while (events[at]?.op === 'route.reLaunch') {
      const payload = take('lifecycle', 'route.reLaunch', route)
      require(keys(payload) === 'requested,route' && routeOf(payload.requested) === route && !/[\\?#]/.test(payload.requested)
        && payload.requested.trim() === payload.requested, 'Wxml original navigation request differs from its actual route')
      tape.push({ op: 'reLaunch', requested: payload.requested }); launches++
    }
    require(launches > 0, 'Wxml original active route has no real reLaunch command')
    require(keys(take('lifecycle', 'route.active', route)) === 'route', 'Wxml original route state has another projection')
    tape.push({ op: 'currentPage', route })
    checkpoint(route, 0)
    for (const planned of descriptor.direct) {
      const op = planned.op === 'query' ? 'query.result' : planned.op === 'tap' ? 'tap' : `query.${planned.op}`
      const payload = take(planned.op === 'tap' ? 'event' : 'render', op, route)
      const expectedKeys = planned.op === 'query' ? 'result,route,selector' : planned.op === 'tap' ? 'route,selector'
        : planned.op === 'attribute' ? 'name,route,selector,value' : 'route,selector,value'
      require(keys(payload) === expectedKeys && payload.selector === planned.selector && payload.name === planned.name,
        'Wxml original direct address/name differs from the unchanged source')
      tape.push({ ...planned, route })
    }
    checkpoint(route, 1)
  }
  require(at === events.length, 'Wxml original trace has extra operations after complete source coverage')
  return tape
}

export async function replayWxml({ request, signal, oracleTrace, staticInputs }) {
  const tape = wxmlActionTape(oracleTrace), events = []
  const collector = createCollector({ emit: event => events.push({ ...structuredClone(event), seq: events.length }) })
  const program = createObservedNativeProgram(request, { signal })
  let page
  const elements = new Map()
  collector.attach(program)
  try {
    await program.ready()
    for (const action of tape) {
      if (action.op === 'reLaunch') { page = await program.reLaunch(action.requested); elements.clear() }
      else if (action.op === 'currentPage') {
        const actual = await program.currentPage()
        require(actual === page && actual.path === action.route, 'Wxml current actual Page differs from its observed navigation')
      } else if (action.op === 'checkpoint') {
        const evidence = await program.checkpoint(action.id, page, action.selectors)
        collector.checkpoint({ evidence }, { session: program, page })
      } else if (action.op === 'query') elements.set(action.selector, await page.$(action.selector))
      else {
        const element = elements.get(action.selector)
        require(element, 'Wxml original getter/tap has no actual acquired Element')
        if (action.op === 'attribute') await element.attribute(action.name)
        else if (action.op === 'text') await element.text()
        else if (action.op === 'tap') await element.tap()
        else throw new Error('Wxml action tape has an unreviewed operation')
      }
    }
    collector.flush()
    // No actual value has been compared with an oracle value before this point.
    require(isDeepStrictEqual(events, oracleTrace.events.map(normalized)), 'Wxml complete actual seq/kind/op/payload trace differs from the original oracle')
    const staticCoverage = assertWxmlStaticOutputs(staticInputs)
    return { events, assertions: wxmlAssertionIds.map(id => ({ id, passed: true })),
      completionFacts: program.completions(), staticCoverage }
  } catch (error) {
    try { collector.flush() } catch { /* Keep the original native/validation failure identity. */ }
    throw error
  }
}
