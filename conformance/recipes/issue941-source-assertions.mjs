import { isDeepStrictEqual } from 'node:util'
import { descriptor } from './issue941-descriptor.mjs'
const require=(ok,message)=>{if(!ok)throw new Error('Issue941 original assertion: '+message)}
export function assertIssue941MethodResults(methodResults) {
 const plan=descriptor.plans[0],step=plan.steps.find(step=>step.kind==='method.call')
 require(Array.isArray(methodResults)&&methodResults.length===1,'actual method result is missing or duplicated')
 const actual=methodResults[0]
 require(actual.route===plan.route&&actual.method===step.method&&actual.sourceCallsite===step.sourceCallsite,'actual method source or Page differs')
 const result=actual.value
 require(Array.isArray(result?.resultMethods)&&result.resultMethods.length===14,'resultMethods toHaveLength(14)')
 require(result.resultMethods.every(item=>item.sameIdentity&&!item.isPromise)===true,'every direct-return identity and promise condition')
 require(Array.isArray(result.voidMethods)&&result.voidMethods.length===7,'voidMethods toHaveLength(7)')
 require(result.voidMethods.every(item=>item.isUndefined&&!item.isPromise)===true,'every void return and promise condition')
 require(isDeepStrictEqual(result.cacheManagerOptions,['maxSize']),'cacheManagerOptions toEqual')
 return {originalExpectations:5,sourceCallsite:step.sourceCallsite}
}
