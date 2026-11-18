/** Exact original two-route, zero-business-action profile. */
import { createCollector as itemCollector } from '../../../conformance/recipes/subpackage-item-collector.mjs'
import { createCollector as userCollector } from '../../../conformance/recipes/subpackage-user-collector.mjs'
import { subpackageDescriptor, subpackageAssertionIds, assertSubpackageStaticOutputs } from './subpackage-static.mjs'
import { orderedPlansActionTape, replayOrderedPlans } from './ordered-plans-replay.mjs'
export function subpackageActionTape(caseId, trace) {
  return orderedPlansActionTape({ descriptor: subpackageDescriptor(caseId), assertionIds: subpackageAssertionIds(caseId), trace, label: 'Subpackage' })
}
export async function replaySubpackage(options) {
  const descriptor = subpackageDescriptor(options.caseId)
  return replayOrderedPlans({ ...options, descriptor, assertionIds: subpackageAssertionIds(options.caseId),
    createCollector: options.caseId.endsWith('-item') ? itemCollector : userCollector,
    assertStaticOutputs: assertSubpackageStaticOutputs, label: 'Subpackage' })
}
