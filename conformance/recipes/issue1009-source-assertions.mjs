/** 保留原例完整值断言；这些预期内容不属于 descriptor 或 IPC 参数。 */
import { isDeepStrictEqual } from 'node:util'
import { descriptor } from './issue1009-descriptor.mjs'
const require = (value, message) => { if (!value) throw new Error(message) }
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
export const expectedResults = freeze({ bindings: 'CS', control: 'PA', ctxCallback: 'PA', event: 'PA-tap', nested: 'PAA', scopeCallback: 'IA' })
export const expectedDomCheckpoints = freeze([
  { id: 'initial', nodes: [
    { selector: '#issue-1009-page', attributes: { 'data-e2e-issue': '1009' } },
    { selector: '#issue1009-result-ctx', text: 'ctx: pending' },
    { selector: '#issue1009-result-scope', text: 'scope: pending' },
    { selector: '#issue1009-result-bindings', text: 'bindings: pending' },
    { selector: '#issue1009-result-nested', text: 'nested: pending' },
    { selector: '#issue1009-result-event', text: 'event: pending' },
    { selector: '#issue1009-result-control', text: 'control: pending' },
  ] },
  { id: 'completed', nodes: [
    { selector: '#issue1009-result-ctx', text: 'ctx: PA' },
    { selector: '#issue1009-result-scope', text: 'scope: IA' },
    { selector: '#issue1009-result-bindings', text: 'bindings: CS' },
    { selector: '#issue1009-result-nested', text: 'nested: PAA' },
    { selector: '#issue1009-result-event', text: 'event: PA-tap' },
    { selector: '#issue1009-result-control', text: 'control: PA' },
  ] },
])
export function assertIssue1009MethodResult(methodResults) {
  const plan = descriptor.plans[0], poll = plan.steps.find(step => step.kind === 'method.poll')
  require(Array.isArray(methodResults) && methodResults.length === 1, 'Issue1009 actual final poll result is absent or duplicated')
  const result = methodResults[0]
  require(result?.route === plan.route && result.method === poll.method && result.sourceCallsite === poll.sourceCallsite,
    'Issue1009 actual final poll result belongs to another source/Page method')
  require(isDeepStrictEqual(result.value, expectedResults), 'Issue1009 original six-field toEqual assertion failed')
  return { sourceCallsite: poll.pollAssertCallsite, matcher: 'toEqual', fields: Object.keys(expectedResults) }
}
/** Input is the core-projected normalized groups, not raw helper groups with optional undefined keys. */
export function assertIssue1009DomEvidence(checkpoints) {
  require(Array.isArray(checkpoints) && checkpoints.length === 2, 'Issue1009 original DOM checkpoint coverage is incomplete')
  const checks = []
  for (const [ordinal, expected] of expectedDomCheckpoints.entries()) {
    const actual = checkpoints[ordinal]
    require(actual?.id === expected.id && actual.route === descriptor.plans[0].route
      && Array.isArray(actual.nodes) && actual.nodes.length === expected.nodes.length,
    'Issue1009 original DOM checkpoint identity/order differs')
    for (const [at, node] of expected.nodes.entries()) {
      const group = actual.nodes[at], { selector, ...fields } = node
      require(isDeepStrictEqual(group, { selector, query: 'css', count: 1, nodes: [fields] }),
        `Issue1009 original rendered assertion failed: ${expected.id}/${selector}`)
      checks.push(`${expected.id}/${selector}`)
    }
  }
  require(checks.length === 13, 'Issue1009 original DOM assertions were omitted')
  return { checkpoints: 2, nodeAssertions: checks.length, checks }
}
