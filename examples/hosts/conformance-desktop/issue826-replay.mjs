import {descriptor} from '../../../conformance/recipes/issue826-descriptor.mjs'
import {sourceActionTape,replaySourcePlan} from './source-plan-replay.mjs'
import {assertIssue826Outputs} from './issue826-static.mjs'
export const issue826ActionTape=trace=>sourceActionTape(descriptor,trace)
export const replayIssue826=options=>replaySourcePlan({...options,descriptor,assertStatic:assertIssue826Outputs})
