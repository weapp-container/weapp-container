import { createOrderedStepsCollector } from './ordered-steps-collector-core.mjs'
import { observeSourceExpectPoll } from './source-poll-observer.mjs'
import { descriptor } from './issue1011-descriptor.mjs'
import { methodPollPolicies } from './issue1011-source-policy.mjs'
export const requiredSourceCollectorFeatures=Object.freeze(['source-tap-helper-attempts','source-expect-poll-scope','source-method-options'])
export function createCollector(options){
 const core=createOrderedStepsCollector({...options,descriptor,methodPollPolicies});let restore
 return {...core,observeExpectPoll(expect,flag){if(restore)throw new Error('Issue1011 poll observer already installed');restore=observeSourceExpectPoll({expect,flag,collector:core})},
  flush(){try{core.flush()}finally{restore?.();restore=undefined}}}
}
