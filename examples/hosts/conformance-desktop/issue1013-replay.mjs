import { descriptor } from '../../../conformance/recipes/issue1013-descriptor.mjs'
import { replaySourcePlan, sourceActionTape } from './source-plan-replay.mjs'
import { assertIssue1013StaticOutputs } from './issue1013-static.mjs'
export const issue1013ActionTape = trace => sourceActionTape(descriptor, trace)
export const replayIssue1013 = options => replaySourcePlan({ ...options, descriptor, assertStatic: assertIssue1013StaticOutputs })
