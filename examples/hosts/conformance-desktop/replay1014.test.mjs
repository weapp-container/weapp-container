import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { replayCase, caseDefinition, collectorInputs } from './replay.mjs'
const caseId='ide-github-issues-runtime-issue1014',route='pages/issue-1014/index'
function synthetic(mutate) {
 const calls=[];let count=0
 return {calls,async request(op,payload){
  calls.push({op,payload:structuredClone(payload)})
  assert(!JSON.stringify(payload).includes('unsupported-object-title'),'expected attribute value never crosses IPC')
  assert(!JSON.stringify(payload).includes('issue 1014 object directives'),'expected text never crosses IPC')
  let result
  if(op==='reLaunch')result={path:route}
  else if(op==='query')result={...payload,count:1,nodes:[{}]}
  else if(op==='tap'){count++;result={...payload,inputTransport:'native-host-coordinate-event'}}
  else {assert.equal(op,'checkpoint');result={id:payload.checkpoint,route,nodes:payload.selectors.map(q=>{
   const query=typeof q==='string'?{selector:q}:q
   return {selector:query.selector,query:'css',count:1,nodes:[query.fields?{attributes:{'data-title':'unsupported-object-title'}}:{text:query.selector==='#issue1014-title'?'issue 1014 object directives':String(count)}]}
  })}}
  return mutate?mutate(op,result,payload):result
 }}
}
test('1014 field requests contain attribute names only and normalize actual attribute-only nodes',async()=>{
 const p=synthetic(),r=await replayCase({caseId,request:p.request});assert.equal(r.assertions.length,1)
 assert.deepEqual(r.events.map(e=>e.op),['route.active','dom.checkpoint','tap','dom.checkpoint'])
 assert.deepEqual(p.calls.filter(c=>c.op==='checkpoint')[0].payload.selectors,[ '#issue1014-title',{selector:'#issue1014-explicit-control',fields:{text:false,attributes:['data-title']}},'#issue1014-explicit-count'])
 assert.deepEqual(r.events[1].payload.nodes[1].nodes,[{attributes:{'data-title':'unsupported-object-title'}}])
 assert.equal(p.calls.filter(c=>c.op==='tap').length,1)
})
test('1014 missing/null/wrong actual attributes fail before input and never fill from descriptor',async()=>{
 for(const value of [null,undefined,'actual different value']){
  const p=synthetic((op,r)=>{if(op==='checkpoint')r.nodes[1].nodes[0].attributes['data-title']=value;return r})
  await assert.rejects(replayCase({caseId,request:p.request}),/Actual rendered attribute/);assert.equal(p.calls.some(c=>c.op==='tap'),false)
 }
})
test('1014 text/count and action divergence stop the complete case',async()=>{
 for(const at of [0,1]){
  const p=synthetic((op,r)=>{if(op==='checkpoint'&&r.id===(at?'explicit-control-tapped':'explicit-control-initial'))r.nodes.at(-1).nodes[0].text='actual divergence';return r})
  await assert.rejects(replayCase({caseId,request:p.request}),/Actual rendered text/)
 }
 const p=synthetic((op,r)=>op==='tap'?{...r,inputTransport:'not-native'}:r)
 await assert.rejects(replayCase({caseId,request:p.request}),/coordinate input/)
})
test('1014 exact transport errors remain failures',async()=>{
 for(const op of ['reLaunch','checkpoint','query','tap']){
  const p=synthetic(),failure=new Error('actual original '+op)
  await assert.rejects(replayCase({caseId,request:(at,arg)=>{if(at===op)throw failure;return p.request(at,arg)}}),e=>e===failure)
 }
})
test('1014 descriptor is coverage-only and exact collector import closure is frozen',async()=>{
 const d=caseDefinition(caseId)
 for(const ref of [{path:d.collectorPath,sha256:d.collectorSha256},...d.collectorDependencies]){
  const bytes=await readFile(new URL(ref.path,import.meta.url));assert.equal(createHash('sha256').update(bytes).digest('hex'),ref.sha256)
  assert(!bytes.toString().includes('unsupported-object-title'));assert(!bytes.toString().includes('issue 1014 object directives'))
  assert.deepEqual(collectorInputs().find(r=>r.path===ref.path),ref)
 }
})
