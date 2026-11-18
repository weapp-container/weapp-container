import {descriptor} from '../../../conformance/recipes/issue826-descriptor.mjs'
import {loadSourcePlanInputs} from './source-plan-static.mjs'
export const issue826AssertionIds=Object.freeze(descriptor.plans.map(plan=>plan.fullName))
export const loadIssue826Inputs=options=>loadSourcePlanInputs({...options,descriptor,assertionIds:issue826AssertionIds})
export function assertIssue826Outputs(input){if(input?.caseId!==descriptor.caseId || input.sourceSha256!==descriptor.sourceSha256 || input.files?.length!==0)throw new Error('Issue826 source envelope differs');return {caseId:descriptor.caseId,originalPageDataExpectations:2,originalDomCheckpoints:2,originalRuntimeErrorArrayExpectations:1,originalGeneratedFileExpectations:0}}
