import { descriptor } from '../../../conformance/recipes/issue297-302-descriptor.mjs'
import { replaySourcePlan, sourceActionTape } from './source-plan-replay.mjs'
import { assertIssue297302StaticOutputs } from './issue297-302-static.mjs'
export const issue297302ActionTape = trace => sourceActionTape(descriptor, trace)
export const replayIssue297302 = options => replaySourcePlan({ ...options, descriptor, assertStatic: assertIssue297302StaticOutputs })
