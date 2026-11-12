/** Two complete source files reuse the sealed source-step/runtime boundaries. */
import { descriptor as issue547 } from '../../../conformance/recipes/issue547-descriptor.mjs'
import { descriptor as issue289 } from '../../../conformance/recipes/issue289-descriptor.mjs'
import { replaySourcePlan, sourceActionTape } from './source-plan-replay.mjs'
import { assertIssue547StaticOutputs } from './issue547-static.mjs'
import { assertIssue289StaticOutputs } from './issue289-static.mjs'
const require = (ok, message) => { if (!ok) throw new Error(message) }
const definitions = new Map([[issue547.caseId, { descriptor: issue547, assertStatic: assertIssue547StaticOutputs }],
  [issue289.caseId, { descriptor: issue289, assertStatic: assertIssue289StaticOutputs }]])
export const componentScopeFamilyActionTape = (caseId, trace) => {
  const definition = definitions.get(caseId)
  require(definition, 'Unknown component scope source case')
  return sourceActionTape(definition.descriptor, trace)
}
export async function observeComponentMarker({ plan, page }) {
  const readiness = plan.readiness
  require(readiness && Object.keys(readiness).sort().join(',') === 'attributes,selector'
    && typeof readiness.selector === 'string' && Array.isArray(readiness.attributes), 'Source marker field selection is malformed')
  const element = await page.$(readiness.selector)
  require(element, 'Original source marker has no actual rendered Element')
  const attributes = {}
  for (const name of readiness.attributes) attributes[name] = await element.attribute(name)
  return { selector: readiness.selector, attributes }
}
export function assertIssue547Readiness(planObservations) {
  require(Array.isArray(planObservations) && planObservations.length === 1, 'Original issue547 marker observation is incomplete')
  const entry = planObservations[0], value = entry?.value
  require(entry && Object.keys(entry).sort().join(',') === 'planOrdinal,route,value'
    && entry.planOrdinal === 0 && entry.route === issue547.plans[0].route
    && value && Object.keys(value).sort().join(',') === 'attributes,selector' && value.selector === '#issue547-page'
    && value.attributes && Object.keys(value.attributes).join(',') === 'data-e2e-issue'
    && value.attributes['data-e2e-issue'] === '547', 'Original issue547 rendered dataset readiness assertion failed')
}
export async function replayComponentScopeFamily(options) {
  const definition = definitions.get(options.caseId)
  require(definition, 'Unknown component scope source case')
  const marker = definition.descriptor === issue547
  return replaySourcePlan({ ...options, descriptor: definition.descriptor,
    ...(marker ? { observePlan: observeComponentMarker } : {}),
    assertStatic: (input, { planObservations } = {}) => {
      if (marker) assertIssue547Readiness(planObservations)
      return definition.assertStatic(input)
    } })
}
