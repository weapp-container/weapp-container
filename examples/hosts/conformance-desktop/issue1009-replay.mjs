import { descriptor } from '../../../conformance/recipes/issue1009-descriptor.mjs'
import { methodPollPolicies } from '../../../conformance/recipes/issue1009-source-policy.mjs'
import { assertIssue1009DomEvidence } from '../../../conformance/recipes/issue1009-source-assertions.mjs'
import { sourceActionTape, replaySourcePlan } from './source-plan-replay.mjs'
import { assertIssue1009Outputs } from './issue1009-static.mjs'
export const issue1009ActionTape = trace => sourceActionTape(descriptor, trace, { methodPollPolicies })
export async function replayIssue1009(options) {
  const result = await replaySourcePlan({ ...options, descriptor, methodPollPolicies, assertStatic: assertIssue1009Outputs })
  assertIssue1009DomEvidence(result.events.filter(event => event.op === 'dom.checkpoint').map(event => event.payload))
  return result
}
