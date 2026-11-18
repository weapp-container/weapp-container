/** Original four-route, four-initial, zero-business-action Web profile. */
import { descriptor } from '../../../conformance/recipes/web-runtime-descriptor.mjs'
import { createCollector } from '../../../conformance/recipes/web-runtime-collector.mjs'
import { orderedPlansActionTape, replayOrderedPlans } from './ordered-plans-replay.mjs'
import { webRuntimeAssertionIds, assertWebRuntimeStaticOutputs } from './web-runtime-static.mjs'
export function webRuntimeActionTape(trace) {
  return orderedPlansActionTape({ descriptor, assertionIds: webRuntimeAssertionIds(), trace, label: 'Web runtime' })
}
export async function replayWebRuntime(options) {
  if (options.caseId !== descriptor.caseId) throw new Error('Web runtime replay belongs to another source case')
  return replayOrderedPlans({ ...options, descriptor, createCollector, assertionIds: webRuntimeAssertionIds(),
    assertStaticOutputs: assertWebRuntimeStaticOutputs, label: 'Web runtime' })
}
