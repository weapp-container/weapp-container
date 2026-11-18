import { descriptor } from '../../../conformance/recipes/issue941-descriptor.mjs'
import { replaySourcePlan, sourceActionTape } from './source-plan-replay.mjs'
import { assertIssue941Outputs } from './issue941-static.mjs'
export const replayIssue941=options=>replaySourcePlan({...options,descriptor,assertStatic:assertIssue941Outputs})
export const issue941ActionTape=trace=>sourceActionTape(descriptor,trace)
