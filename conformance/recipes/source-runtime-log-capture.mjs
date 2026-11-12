/** Passive observation of the original complete runtime meta.entries read.
 * Runtime attachment precedes enableLog in the pinned launcher. Bind the real
 * meta after an actual Page acquisition, preserving the original array/reset. */
import {createOrderedStepsCollector} from './ordered-steps-collector-core.mjs'
import {encodeMethodValue,decodeMethodValue} from './source-method-values.mjs'
const require=(ok,message)=>{if(!ok)throw new Error(message)}
export const selectRuntimeErrors=(entries,ignore)=>entries.filter(entry=>entry.level==='error'||entry.level==='exception').filter(entry=>!ignore||!ignore(entry))
export function createRuntimeLogCollector({descriptor,emit,context}) {
 const core=createOrderedStepsCollector({descriptor,emit,context}),spec=descriptor.runtimeLogCapture
 const restores=[],navigationRestores=[],facts=[];let owner,seen=false,begun=false,boundMeta,boundArray,failure,checkpoints=0,closed=false
 const expected=descriptor.plans.flatMap(plan=>plan.steps).filter(step=>step.kind==='checkpoint').length
 const caught=fn=>{try{return fn()}catch(error){failure??=error}}
 const healthy=()=>{if(failure)throw failure}
 const bindMeta=()=>{
   const metaField=Object.getOwnPropertyDescriptor(owner,'__weappViteRuntimeLogMeta'),meta=metaField?.value
   if(!meta)return
   require(!boundMeta||boundMeta===meta,'actual runtime log meta owner was replaced')
   if(boundMeta)return
   require(typeof meta==='object' && meta.closed===false && typeof meta.reset==='function','complete actual runtime log meta is absent')
   const entries=Object.getOwnPropertyDescriptor(meta,'entries')
   require(entries && Object.hasOwn(entries,'value') && Array.isArray(entries.value),'complete actual runtime log array is absent or accessor based')
   boundMeta=meta;boundArray=entries.value
   Object.defineProperty(meta,'entries',{configurable:true,enumerable:entries.enumerable,get(){
    if(!closed && !seen && meta.closed===false && meta.closing!==true && checkpoints===expected)caught(()=>{
     healthy();require(begun,'original complete runtime log subscription never succeeded');require(this===boundMeta && Object.getOwnPropertyDescriptor(owner,'__weappViteRuntimeLogMeta')?.value===boundMeta,'runtime log array read changed its actual owner')
     const snapshot=decodeMethodValue(encodeMethodValue(entries.value))
     require(snapshot.every(entry=>entry && typeof entry==='object' && typeof entry.level==='string' && typeof entry.text==='string'),'runtime log entry has no actual level/text')
     const selected=selectRuntimeErrors(snapshot)
     facts.push({entries:snapshot,selected});seen=true
     emit({kind:'event',op:'runtime.logs.assertion',payload:{sourceSha256:descriptor.sourceSha256,sourceCallsite:spec.sourceCallsite,filter:spec.filter,selected}})
    })
    return entries.value
   }})
   restores.push(()=>Object.defineProperty(meta,'entries',entries))
 }
 return {
  attach(program){
   healthy();require(!owner||owner===program,'runtime log capture changed its actual owner')
   core.attach(program);if(owner){caught(bindMeta);return}owner=program
   for(const key of ['reLaunch','currentPage'])if(typeof program[key]==='function'){
    const own=Object.getOwnPropertyDescriptor(program,key),original=program[key]
    const wrapped=async function(...args){const result=await Reflect.apply(original,this,args);caught(bindMeta);return result}
    Object.defineProperty(program,key,{configurable:true,writable:true,value:wrapped})
    navigationRestores.push(()=>{if(program[key]===wrapped){if(own)Object.defineProperty(program,key,own);else delete program[key]}})
   }
   require(typeof program.enableLog==='function','actual structured runtime log subscription method is absent')
   const own=Object.getOwnPropertyDescriptor(program,'enableLog'),original=program.enableLog
   const wrapped=async function(...args){
    const result=await Reflect.apply(original,this,args)
    caught(()=>{healthy();bindMeta();require(this===owner && boundMeta && args.length===2 && Number.isFinite(args[0]) && args[0]>0
      && args[0]<=15000 && args[1]?.structured===true,'actual structured runtime log subscription differs from pinned source')
      if(!begun){begun=true;emit({kind:'lifecycle',op:'runtime.logs.begin',payload:{sourceSha256:descriptor.sourceSha256,
       subscriptionCallsite:spec.subscriptionCallsite,subscriptionHelperSha256:spec.subscriptionHelperSha256,structured:true}})}
    })
    return result
   }
   Object.defineProperty(program,'enableLog',{configurable:true,writable:true,value:wrapped})
   navigationRestores.push(()=>{if(program.enableLog===wrapped){if(own)Object.defineProperty(program,'enableLog',own);else delete program.enableLog}})
   caught(bindMeta)
  },
  checkpoint(observation,ctx){healthy();caught(bindMeta);healthy();require(boundMeta,'complete actual runtime log metadata was never established');core.checkpoint(observation,ctx);checkpoints++},
  diagnostics:()=>({...core.diagnostics(),runtimeLogs:structuredClone(facts)}),
  flush(){
   if(closed){healthy();return}closed=true
   for(const restore of navigationRestores.reverse())caught(restore);caught(()=>core.flush())
   caught(()=>{healthy();require(boundMeta && seen && boundMeta.closed===true,'original runtime log owner never completed its actual close')
    const entries=decodeMethodValue(encodeMethodValue(boundArray)),prior=facts[0].entries
    require(entries.length>=prior.length && JSON.stringify(entries.slice(0,prior.length))===JSON.stringify(prior),'runtime journal entries were removed or rewritten after the original assertion')
    facts.push({phase:'owner-close',entries})
   })
   for(const restore of restores.reverse())caught(restore);healthy()
  },
 }
}
