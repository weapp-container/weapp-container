/** Original SFC template actions plus complete generated assertions.
 * Expected values stay in host assertions; native host disposal is owned and
 * required by driver.mjs before any final trace is admitted. */
import { isDeepStrictEqual } from 'node:util'
import { createCollector } from '../../../conformance/recipes/template-multi-platform-sfc-collector.mjs'
import { descriptor } from '../../../conformance/recipes/template-multi-platform-sfc-descriptor.mjs'
import { assertTemplateStaticOutputs } from '../../../conformance/recipes/template-sfc-static-assertions.mjs'
import { createObservedNativeProgram } from './native-program.mjs'
const ensure = (value, message) => { if (!value) throw new Error(message) }
const expectedNodes = count => [
  { selector: '.page-heading__title', text: 'Vue SFC 多平台 + Web' },
  { selector: '#platform-marker', text: 'MP_PLATFORM=weapp' },
  { selector: '#runtime-status', text: 'status=ready' },
  { selector: '#component-platform', scope: ['#platform-card-host'], text: 'weapp' },
  { selector: '#counter-value', text: String(count) },
  { selector: '#counter-doubled', text: `doubled=${count * 2}` },
]
const normalized = event => {
  const keys = Object.keys(event ?? {}).sort().join(',')
  ensure(keys === 'kind,op,payload,seq' || keys === 'atNs,kind,op,payload,seq', 'Template original event has unreviewed fields')
  return { seq: event.seq, kind: event.kind, op: event.op, payload: structuredClone(event.payload) }
}
export async function replayTemplate({ caseId, request, signal, oracleTrace, staticInputs }) {
  ensure(caseId === descriptor.caseId && typeof request === 'function', 'Unsupported native template case or transport')
  ensure(oracleTrace?.caseId === descriptor.caseId && oracleTrace.oracle === 'wechat-devtools' && oracleTrace.run?.status === 'passed'
    && isDeepStrictEqual(oracleTrace.assertions, [{ id: descriptor.test, passed: true }]) && oracleTrace.events?.length === 4,
  'Template native replay lacks its complete passed original source trace')
  const original = oracleTrace.events.map(normalized)
  ensure(original.every((event, at) => event.seq === at) && isDeepStrictEqual(original.map(({ kind, op }) => ({ kind, op })), [
    { kind: 'lifecycle', op: 'route.active' }, { kind: 'render', op: 'dom.checkpoint' },
    { kind: 'event', op: 'tap' }, { kind: 'render', op: 'dom.checkpoint' },
  ]) && isDeepStrictEqual(original[0].payload, { route: descriptor.route })
    && isDeepStrictEqual(original[2].payload, { route: descriptor.route, selector: descriptor.action.selector })
    && original[1].payload.id === descriptor.checkpoints[0].id && original[3].payload.id === descriptor.checkpoints[1].id,
  'Template original source trace has missing, duplicated, reordered or foreign operations')
  const staticCoverage = await assertTemplateStaticOutputs(staticInputs)
  const events = [], collector = createCollector({ emit: event => events.push({ ...structuredClone(event), seq: events.length }) })
  const program = createObservedNativeProgram(request, { signal })
  collector.attach(program)
  const check = async (page, ordinal) => {
    const planned = descriptor.checkpoints[ordinal]
    const selectors = planned.queries.map(query => query.scope?.length ? { selector: query.selector, scope: [...query.scope] } : query.selector)
    const evidence = await program.checkpoint(planned.id, page, selectors), expected = expectedNodes(ordinal)
    ensure(evidence?.nodes?.length === expected.length, 'Template native actual selector coverage differs')
    for (const [at, entry] of expected.entries()) {
      const group = evidence.nodes[at]
      ensure(group?.selector === entry.selector && group.query === 'css' && group.has === undefined
        && isDeepStrictEqual(group.scope ?? [], entry.scope ?? []) && group.count === 1 && group.nodes?.length === 1
        && group.nodes[0]?.text === entry.text, 'Template native actual rendered text/count/scope differs: ' + entry.selector)
    }
    collector.checkpoint({ evidence }, { session: program, page })
  }
  try {
    await program.ready()
    const page = await program.reLaunch('/' + descriptor.route), current = await program.currentPage()
    ensure(current === page && current.path === descriptor.route, 'Template current page differs from its actual launch')
    await check(page, 0)
    const nodes = await page.$$(descriptor.action.selector, { fallback: false, timeout: 5000 })
    ensure(nodes.length === 1, 'Template original tap requires exactly one actual target')
    await nodes[0].tap()
    await check(page, 1)
    collector.flush()
    ensure(isDeepStrictEqual(events, original), 'Template complete actual native trace differs from the original oracle')
    return { events, assertions: [{ id: descriptor.test, passed: true }], completionFacts: program.completions(), staticCoverage }
  } catch (error) {
    try { collector.flush() } catch { /* Preserve the original native/assertion failure. */ }
    throw error
  }
}
