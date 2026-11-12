import { descriptor } from '../../../conformance/recipes/issue1182-descriptor.mjs'
import { replaySourcePlan } from './source-plan-replay.mjs'
import { assertIssue1182StaticOutputs } from './issue1182-static.mjs'
export const replayIssue1182 = options => replaySourcePlan({ ...options, descriptor, assertStatic: assertIssue1182StaticOutputs })
