/** Synthetic provider only: never an official receipt or runtime pair. */
import assert from 'node:assert/strict'
import { descriptor } from './issue1009-descriptor.mjs'
import { expectedResults, expectedDomCheckpoints } from './issue1009-source-assertions.mjs'
import { createCollector } from './issue1009-collector.mjs'
export const plan = descriptor.plans[0]
export const selectors = plan.steps.filter(step => step.kind === 'tap').map(step => step.address.selector)
export const pollOptions = { timeoutMs: 10000, intervalMs: 50, matcher: 'toEqual' }
export function fixture({ samples = [structuredClone(expectedResults)], fallback = false, queryNull = false, onQuery, onTap, onMethod } = {}) {
  const events = [], calls = [], allElements = new Map(); let stamp = 1000, sampleAt = 0
  const page = { path: plan.route, pageId: 17,
    async waitForRendered(options) { calls.push({ op: 'waitForRendered', options }); return true },
    async $$(selector, options) { calls.push({ op: '$$', selector, options }); return [element(selector)] },
    async $(selector, options) {
      calls.push({ op: '$', selector, options }); if (onQuery) return await onQuery(selector, options, element)
      if (queryNull) return null
      if (fallback) return (await this.$$(selector, options))[0] ?? null
      return element(selector)
    },
    async callMethod(name, ...args) {
      calls.push({ op: 'method', name, args }); if (onMethod) return await onMethod(name, args)
      const value = samples[Math.min(sampleAt++, samples.length - 1)]
      if (value && Object.hasOwn(value, 'throw')) throw value.throw
      return structuredClone(value)
    },
  }
  function element(selector) {
    if (!allElements.has(selector)) allElements.set(selector, { async tap(...args) { calls.push({ op: 'tap', selector, args }); return onTap ? await onTap(selector, args) : undefined } })
    return allElements.get(selector)
  }
  const program = { async reLaunch(route) { calls.push({ op: 'reLaunch', route }); return page }, async currentPage() { return page } }
  const collector = createCollector({ clock: () => stamp, emit: event => events.push({ ...structuredClone(event), seq: events.length }) })
  collector.attach(program)
  const checkpoint = id => {
    const expected = expectedDomCheckpoints.find(value => value.id === id)
    const nodes = expected.nodes.map(({ selector, ...fields }) => ({ selector, query: 'css', scope: undefined, has: undefined, count: 1, nodes: [structuredClone(fields)] }))
    collector.checkpoint({ evidence: { id, route: page.path, nodes } }, { session: program, page })
  }
  const start = async () => { await program.reLaunch('/' + plan.route); checkpoint('initial') }
  const taps = async () => { for (const selector of selectors) { const control = await page.$(selector, { timeout: 2000 }); assert.ok(control); await control.tap() } }
  return { page, program, collector, events, calls, element, start, taps, checkpoint, setClock: value => { stamp = value },
    trace: () => ({ caseId: descriptor.caseId, oracle: 'wechat-devtools', run: { status: 'passed' }, events,
      assertions: [{ id: plan.fullName, passed: true }] }) }
}
