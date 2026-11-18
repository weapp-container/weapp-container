import { descriptor } from '../../../conformance/recipes/issue1008-descriptor.mjs'
import { readinessPolicies } from '../../../conformance/recipes/issue1008-source-policy.mjs'
import { sourceActionTape, replaySourcePlan } from './source-plan-replay.mjs'
import { assertIssue1008Outputs } from './issue1008-static.mjs'
export const issue1008ActionTape = trace => sourceActionTape(descriptor, trace, { readinessPolicies })
export const replayIssue1008 = options => replaySourcePlan({ ...options, descriptor, readinessPolicies, assertStatic: assertIssue1008Outputs })
