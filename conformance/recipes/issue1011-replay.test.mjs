/** Synthetic IPC contracts. Engine names are labels, not execution evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {performance} from 'node:perf_hooks'
import {fixture,plan,pollOptions,checkpointGroups,staticInputs} from './issue1011-test-fixture.mjs'
import {expectedSnapshot} from './issue1011-source-assertions.mjs'
import {encodeMethodValue} from './source-method-values.mjs'
import {replayIssue1011,issue1011ActionTape} from '../../examples/hosts/conformance-desktop/issue1011-replay.mjs'
const NONCE='a'.repeat(64),ACQUIRE='accepted-frame.nodes.acquire.v1',TAP='accepted-frame.nodes.tap.v1'
const startup=engine=>({status:'passed',engine,sessionId:'synthetic-1011',acceptedFrameNodes:{kind:'accepted-frame-node-capabilities-v1',version:1,engine,sessionId:'synthetic-1011',sessionInstance:NONCE,operations:[ACQUIRE,TAP],selection:['first','all'],inputTransport:'native-host-coordinate-event'}})
async function trace(){const f=fixture();await f.start();await f.taps();await f.poll();f.finish();return f.trace()}
function native(engine,{samples=[expectedSnapshot],tapFailure,mutate}={}){
 let pump=0,action=0,required=0,revision=1,pageId='1',route='pages/home/index',methodAt=0,checkpointAt=0,stamp=1000
 const calls=[],proof=()=>({kind:'owner-pump-native-presentation-v1',sessionId:startup(engine).sessionId,route,pageId,templateRevision:String(revision),consumedTemplateRevision:String(revision),frameId:String(revision),renderRevision:String(revision),presentationAckRevision:String(revision),actionSeq:String(action),ownerPumpSeq:String(++pump),requiredPumpSeq:String(required),presented:true})
 const owner=()=>({kind:'accepted-frame-owner-v1',engine,sessionId:startup(engine).sessionId,sessionInstance:NONCE,route,pageId,templateRevision:String(revision),frameId:String(revision),renderRevision:String(revision)})
 const act=()=>{action++;required=pump+1;revision++}
 const request=async(op,payload={})=>{
  calls.push({op,payload:structuredClone(payload),at:performance.now()});let result
  if(op==='render.settle')result=proof()
  else if(op==='reLaunch'){route=payload.route.replace(/^\//,'');pageId=String(Number(pageId)+1);act();result={path:route,completion:proof()}}
  else if(op==='currentPage')result={path:route,pageId,completion:proof()}
  else if(op==='checkpoint'){const id=['initial','captured'][checkpointAt++];result={id,route,nodes:checkpointGroups(id),completion:proof()}}
  else if(op==='accepted-frame.nodes.capabilities.v1')result={...startup(engine).acceptedFrameNodes,completion:proof()}
  else if(op===ACQUIRE){const current=owner();result={kind:'accepted-frame-node-acquisition-v1',version:1,owner:current,target:payload.target,selection:payload.selection,matchCount:2,count:1,nodes:[{handle:{kind:'accepted-frame-node-v1',owner:current,token:'1'.repeat(64)},parent:null,metadata:{id:'duplicate-public-id',publicId:'duplicate-public-id',tag:'button',eventIdentity:'first-actual-occurrence',componentScopeId:null,eventOwnerScopeId:null}}],completion:proof()}}
  else if(op===TAP){if(tapFailure)throw tapFailure;const input=proof();act();result={kind:'accepted-frame-node-tap-v1',version:1,route,node:payload.node,owner:payload.node.owner,x:12,y:14,frameId:input.frameId,renderRevision:input.renderRevision,inputTransport:'native-host-coordinate-event',inputCompletion:input,completion:proof()}}
  else if(op==='method.call'){
   const at=methodAt++,sample=samples[Math.min(at,samples.length-1)];act();result={kind:'native-guest-method-result-v1',owner:{kind:'source-labelled-native-method-owner-v1',engine,sessionId:startup(engine).sessionId,sourceInvocationId:payload.sourceInvocationId,sourceDeclaration:payload.source,sourceDeclarationTrust:'caller-declared-not-official-oracle',route,pageId,originalDeadlineNs:payload.deadlineNs,deadlineClock:'original-unix-deadline-plus-once-anchored-monotonic-budget',sessionBeginAttempts:1,sessionPollAttempts:2,requestSha256:'b'.repeat(64),receiverTokenSha256:'c'.repeat(64)},observation:sample&&Object.hasOwn(sample,'throw')?{kind:'rejected',ticket:'synthetic/'+at,reason:{kind:'json',value:sample.throw}}:{kind:'fulfilled',ticket:'synthetic/'+at,value:encodeMethodValue(sample)},completion:proof()}
  }else throw Error('Unplanned synthetic operation '+op)
  return mutate?.(result,op,payload)??result
 }
 return{calls,request,readinessClock:()=>stamp,readinessWait:async ms=>{stamp+=ms}}
}
const replay=(engine,wire,oracleTrace)=>replayIssue1011({...wire,startup:startup(engine),oracleTrace,staticInputs:staticInputs()})
test('both synthetic transports use actual first opaque handles and real original240ms waits',async()=>{
 const oracle=await trace()
 for(const engine of ['quickjs','v8']){const wire=native(engine),started=performance.now(),result=await replay(engine,wire,oracle)
  assert.ok(performance.now()-started>=1100);assert.deepEqual(result.events,oracle.events)
  assert.equal(result.nodeInputFacts.length,11);assert.equal(result.nodeInputFacts[0].operation,'root-readiness');assert.equal(result.tapHelperJournal.attempts.length,10)
  assert.equal(wire.calls.filter(c=>c.op==='query'||c.op==='tap').length,0)
  assert.ok(wire.calls.filter(c=>c.op===ACQUIRE).every(c=>c.payload.selection==='first'))
  assert.ok(wire.calls.filter(c=>c.op===TAP).every(c=>Object.keys(c.payload).sort().join(',')==='node,route,version'))
  const taps=wire.calls.filter(c=>c.op===TAP);for(let i=1;i<taps.length;i++)assert.ok(taps[i].at-taps[i-1].at>=220)
  assert.deepEqual(result.events.filter(e=>e.op==='tap.helper.attempt').map(e=>e.payload.completion.value),Array(10).fill({kind:'undefined'}))
 }
})
test('actual method rejections and incorrect snapshots drive native retry independently of oracle count',async()=>{
 const oracle=await trace(),wire=native('quickjs',{samples:[{throw:'pending'},{objectCaptures:[],tupleCaptures:[]},expectedSnapshot]}),result=await replay('quickjs',wire,oracle)
 assert.equal(result.sourcePollJournal.attempts.length,3);assert.equal(result.methodFacts.length,3);assert.deepEqual(result.events,oracle.events)
 assert.ok(result.sourcePollJournal.attempts.every(a=>a.callOptions.timeout===5000&&a.callDeadlineMs===a.startedAtMs+5000))
 assert.ok(wire.calls.filter(c=>c.op==='method.call').every(c=>Object.keys(c.payload).sort().join(',')==='args,deadlineNs,method,route,source,sourceInvocationId'))
})
test('unreviewed native fallback operations fail closed after one actual failed opaque tap',async()=>{
 const oracle=await trace(),wire=native('quickjs',{tapFailure:new Error('real synthetic tap error')})
 await assert.rejects(replay('quickjs',wire,oracle),error=>error.code==='NATIVE_OPAQUE_INPUT_UNSUPPORTED')
 assert.equal(wire.calls.filter(c=>c.op===TAP).length,1);assert.equal(wire.calls.filter(c=>['tap','trigger','touchstart','touchend','dispatchEvent'].includes(c.op)).length,0)
 assert.equal(wire.calls.filter(c=>c.op==='method.call').length,0)
})
test('missing, replaced or reordered helper attempts reject before native input',async()=>{
 const original=await trace()
 for(const mutate of [t=>t.events.splice(2,1),t=>t.events[2].payload.operation='trigger',t=>t.events[3].payload.attemptOrdinal++,t=>t.events.find(e=>e.op==='method.poll').payload.callOptions.timeout=6000]){const oracle=structuredClone(original);mutate(oracle);oracle.events.forEach((e,i)=>e.seq=i);const wire=native('quickjs');await assert.rejects(replay('quickjs',wire,oracle),/Source-plan/);assert.equal(wire.calls.length,0)}
 assert.equal(issue1011ActionTape(original).filter(s=>s.op==='tap.helper').length,5)
})
