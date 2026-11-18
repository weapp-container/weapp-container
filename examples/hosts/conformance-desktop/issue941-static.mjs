/** Three original existence checks plus all five actual direct-return assertions. */
import { createHash } from 'node:crypto'
import { descriptor } from '../../../conformance/recipes/issue941-descriptor.mjs'
import { assertIssue941MethodResults } from '../../../conformance/recipes/issue941-source-assertions.mjs'
import { loadSourcePlanInputs } from './source-plan-static.mjs'
const require=(ok,message)=>{if(!ok)throw new Error('Issue941 original source: '+message)}
export const issue941AssertionIds=Object.freeze(descriptor.plans.map(plan=>plan.fullName))
export const loadIssue941Inputs=options=>loadSourcePlanInputs({...options,descriptor,assertionIds:issue941AssertionIds})
export function assertIssue941Outputs(input,{methodResults}={}) {
 require(input?.caseId===descriptor.caseId&&input.sourceSha256===descriptor.sourceSha256&&input.files?.length===3,'compiled file existence coverage')
 for(const [at,path] of descriptor.compiledFiles.entries()) {
  const file=input.files[at]
  require(file.path===path&&Buffer.isBuffer(file.bytes)&&file.length===file.bytes.length&&file.sha256===createHash('sha256').update(file.bytes).digest('hex'),'compiled path identity '+path)
 }
 const method=assertIssue941MethodResults(methodResults)
 return {caseId:descriptor.caseId,sourceSha256:descriptor.sourceSha256,originalExistenceExpectations:3,originalMethodExpectations:method.originalExpectations,originalDomCheckpoints:2,files:input.files.map(({path,sha256,length})=>({path,sha256,bytes:length}))}
}
