import { isDeepStrictEqual } from 'node:util'
import { descriptor } from './issue1011-descriptor.mjs'
import { expectedSnapshot, expectedDomCheckpoints } from './issue1011-original-values.mjs'
export { expectedSnapshot, expectedDomCheckpoints }
const require=(value,message)=>{if(!value)throw new Error('Issue1011 '+message)}
export function assertIssue1011MethodResult(results){
 const step=descriptor.plans[0].steps.find(step=>step.kind==='method.poll')
 require(Array.isArray(results)&&results.length===1,'actual snapshot is absent or duplicated')
 const actual=results[0]
 require(actual.route===descriptor.plans[0].route&&actual.method===step.method&&actual.sourceCallsite===step.sourceCallsite,'actual snapshot belongs to another source/Page')
 require(isDeepStrictEqual(actual.value,expectedSnapshot),'original complete toEqual snapshot assertion failed')
 return {sourceCallsite:step.pollAssertCallsite,matcher:'toEqual',objectCaptures:4,tupleCaptures:1}
}
export function assertIssue1011DomEvidence(checkpoints){
 require(Array.isArray(checkpoints)&&checkpoints.length===2,'original DOM checkpoints are incomplete')
 let assertions=0
 for(const [at,expected] of expectedDomCheckpoints.entries()){
  const actual=checkpoints[at]
  require(actual?.id===expected.id&&actual.route===descriptor.plans[0].route&&Array.isArray(actual.nodes)&&actual.nodes.length===expected.nodes.length,'DOM identity/order differs')
  for(const [index,node] of expected.nodes.entries()){
   const {selector,...fields}=node
   require(isDeepStrictEqual(actual.nodes[index],{selector,query:'css',count:1,nodes:[fields]}),'original rendered assertion failed: '+selector);assertions++
  }
 }
 require(assertions===7,'an original DOM assertion was omitted');return{checkpoints:2,nodeAssertions:assertions}
}
