import { descriptor } from '../../../conformance/recipes/issue1011-descriptor.mjs'
import { methodPollPolicies } from '../../../conformance/recipes/issue1011-source-policy.mjs'
import { assertIssue1011DomEvidence } from '../../../conformance/recipes/issue1011-source-assertions.mjs'
import { tapElement } from '../../../conformance/recipes/issue1011-tap-source.mjs'
import { sourceActionTape, replaySourcePlan } from './source-plan-replay.mjs'
import { assertIssue1011Outputs } from './issue1011-static.mjs'
export const issue1011ActionTape=trace=>sourceActionTape(descriptor,trace,{methodPollPolicies})
export async function replayIssue1011(options){
 const result=await replaySourcePlan({...options,descriptor,methodPollPolicies,tapSourceHelper:tapElement,assertStatic:assertIssue1011Outputs})
 assertIssue1011DomEvidence(result.events.filter(event=>event.op==='dom.checkpoint').map(event=>event.payload))
 return result
}
