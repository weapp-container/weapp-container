/** Exact1011 original input helper attempts remain observable effects. */
import { isDeepStrictEqual } from 'node:util'
import { descriptor } from '../conformance/recipes/issue1011-descriptor.mjs'
import { sourceActionTape } from '../examples/hosts/conformance-desktop/source-plan-replay.mjs'
import { methodPollPolicies } from '../conformance/recipes/issue1011-source-policy.mjs'
const require=(ok,message)=>{if(!ok)throw new Error('Source tap evidence: '+message)}
export function assertSourceTapHelperEvidence({trace,journal}){
 const events=trace.events.filter(event=>event.op==='tap.helper.attempt'),raw=journal?.tapHelperJournal
 if(!events.length){require(raw===undefined&&trace.caseId!==descriptor.caseId,'missing exact source input attempts or orphan tap helper journal');return}
 require(trace.caseId===descriptor.caseId&&trace.run?.environment?.caseSourceSha256===descriptor.sourceSha256,'attempts are outside the independently reviewed source')
 require(raw?.schemaVersion===1&&raw.kind==='pinned-tap-helper-journal-v1'&&raw.caseId===descriptor.caseId&&raw.sourceSha256===descriptor.sourceSha256
  &&Array.isArray(raw.acquisitions)&&raw.acquisitions.length===5&&Array.isArray(raw.attempts)&&raw.attempts.length===events.length,'complete helper acquisitions/attempts are absent')
 sourceActionTape(descriptor,trace,{methodPollPolicies})
 const steps=descriptor.plans[0].steps.filter(step=>step.kind==='tap'),first=raw.acquisitions[0],ids=new Set()
 for(const [at,acquired] of raw.acquisitions.entries()){
  const step=steps[at]
  require(Object.keys(acquired).sort().join(',')==='acquisition,actionOrdinal,argumentCount,epoch,pageId,planOrdinal,present,route,selector,sourceStepCursor'
   && acquired.planOrdinal===0&&acquired.actionOrdinal===at&&acquired.sourceStepCursor===at+1&&acquired.route===descriptor.plans[0].route
   && acquired.selector===step.address.selector&&acquired.argumentCount===1&&acquired.present===true
   &&Number.isSafeInteger(acquired.pageId)&&acquired.pageId>=0&&acquired.pageId===first.pageId
   &&Number.isSafeInteger(acquired.epoch)&&acquired.epoch>0&&acquired.epoch===first.epoch
   &&Number.isSafeInteger(acquired.acquisition)&&acquired.acquisition>0&&!ids.has(acquired.acquisition),'actual first acquisition lineage/order differs')
  ids.add(acquired.acquisition)
 }
 if(journal?.sourcePollJournal)require(journal.sourcePollJournal.attempts?.every(attempt=>attempt.pageId===first.pageId),'input and snapshot use different actual Page incarnations')
 for(const [at,attempt] of raw.attempts.entries()){
  const {pageId,epoch,acquisition,sourceStepCursor,startedAtMs,endedAtMs,...payload}=attempt,acquired=raw.acquisitions[payload.actionOrdinal]
  require(Object.keys(attempt).sort().join(',')==='acquisition,actionOrdinal,args,attemptOrdinal,completion,endedAtMs,epoch,helperSha256,operation,pageId,planOrdinal,query,route,selector,sourceCallsite,sourceStepCursor,startedAtMs'
   &&acquired&&pageId===acquired.pageId&&epoch===acquired.epoch&&acquisition===acquired.acquisition&&sourceStepCursor===acquired.sourceStepCursor
   &&Number.isSafeInteger(startedAtMs)&&Number.isSafeInteger(endedAtMs)&&endedAtMs>=startedAtMs
   &&(at===0||startedAtMs>=raw.attempts[at-1].endedAtMs)&&isDeepStrictEqual(events[at].payload,payload),'actual input/wait attempt was omitted, replaced or rebound')
 }
 return{actualAcquisitions:5,actualAttempts:raw.attempts.length}
}
