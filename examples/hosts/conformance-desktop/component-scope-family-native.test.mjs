/** Synthetic provider/IPC contracts only; no original compiler/SDK/native host. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { descriptor as issue547 } from '../../../conformance/recipes/issue547-descriptor.mjs'
import { descriptor as issue289 } from '../../../conformance/recipes/issue289-descriptor.mjs'
import { projectCheckpoint } from '../../../conformance/recipes/ordered-steps-collector-core.mjs'
import { caseDefinition, collectorInputs, replayCase } from './replay.mjs'
import { componentScopeFamilyActionTape, replayComponentScopeFamily, observeComponentMarker, assertIssue547Readiness } from './component-scope-family-replay.mjs'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const rawGroups=step=>step.queries.map((q,at)=>({selector:q.selector,query:'css',...(q.scope?{scope:structuredClone(q.scope)}:{}),count:q.fields.text?1:at%3,nodes:Array.from({length:q.fields.text?1:at%3},(_,index)=>({text:` raw actual ${step.id}/${at}/${index} `,extra:'unused'}))}))
function trace(d) {
 const events=[]
 for(const p of d.plans){const identity={planOrdinal:p.ordinal,route:p.route};events.push({seq:events.length,kind:'lifecycle',op:'route.active',payload:identity});for(const step of p.steps)events.push(step.kind==='tap'?{seq:events.length,kind:'event',op:'tap',payload:{...identity,actionOrdinal:step.ordinal,...step.address}}:{seq:events.length,kind:'render',op:'dom.checkpoint',payload:{...identity,checkpointOrdinal:step.ordinal,id:step.id,nodes:projectCheckpoint(rawGroups(step),step.queries)}})}
 return{schemaVersion:1,caseId:d.caseId,oracle:'wechat-devtools',run:{status:'passed'},events,assertions:d.plans.map(p=>({id:p.fullName,passed:true}))}
}
async function staticInput(d) {
 const code=await readFile(new URL('../../../vendor/weapp-vite/'+d.caseSourcePath,import.meta.url),'utf8'),ast=ts.createSourceFile('original.ts',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),variables={},parts=new Map(d.compiledFiles.map(path=>[path,[]]))
 const walk=node=>{if(ts.isVariableDeclaration(node)&&node.initializer&&ts.isAwaitExpression(node.initializer)&&ts.isCallExpression(node.initializer.expression)){const call=node.initializer.expression;if(['readDistFile','readDistWxml'].includes(call.expression.getText(ast)))variables[node.name.getText(ast)]=call.arguments[0].text}if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='toContain'){const expect=node.expression.expression;parts.get(variables[expect.arguments[0].getText(ast)]).push(node.arguments[0].text)}ts.forEachChild(node,walk)};walk(ast)
 return{caseId:d.caseId,sourceSha256:d.sourceSha256,files:[...parts].map(([path,literals])=>{const bytes=Buffer.from(literals.join('\n'));return{path,bytes,length:bytes.length,sha256:hash(bytes)}})}
}
function wire(d,{mutate,fail,marker='547',markerAbsent=false,tapCount=1}={}) {
 const calls=[];let pump=0,action=0,required=0,revision=1,pageId=1,route='pages/home/index',planAt=-1,stepAt=0
 const proof=()=>({kind:'owner-pump-native-presentation-v1',sessionId:'synthetic-scope-only',route,pageId:String(pageId),templateRevision:String(revision),consumedTemplateRevision:String(revision),frameId:String(revision+10),renderRevision:String(revision),presentationAckRevision:String(revision),actionSeq:String(action),ownerPumpSeq:String(pump),requiredPumpSeq:String(required),presented:true})
 const request=async(op,payload={})=>{
  calls.push({op,payload:structuredClone(payload)});if(fail?.op===op)throw fail.error;pump++;let value
  if(op==='render.settle')value=proof()
  else if(op==='reLaunch'){route=payload.route.slice(1);pageId++;revision++;action++;required=pump;planAt++;stepAt=0;assert.equal(route,d.plans[planAt].route);value={path:route,completion:proof()}}
  else if(op==='currentPage')value={path:route,pageId:String(pageId),completion:proof()}
  else if(op==='query') {const isMarker=payload.selector==='#issue547-page',count=isMarker?(markerAbsent?0:1):tapCount;value={route,selector:payload.selector,count,nodes:Array.from({length:count},(_,at)=>({id:'actual-node-'+at})),frameId:revision+10,renderRevision:revision,completion:proof()}}
  else if(op==='query.attribute')value={route,selector:payload.selector,count:1,name:payload.name,present:true,value:{type:'string',value:marker},frameId:revision+10,renderRevision:revision,completion:proof()}
  else if(op==='checkpoint'){const p=d.plans[planAt],step=p.steps[stepAt++];assert.equal(step.kind,'checkpoint');assert.equal(payload.checkpoint,step.id);assert.deepEqual(payload.selectors,step.queries.map(q=>({...q})));value={id:step.id,route,nodes:rawGroups(step),completion:proof()}}
  else if(op==='tap'){const step=d.plans[planAt].steps[stepAt++];assert.equal(step.kind,'tap');assert.equal(step.address.selector,payload.selector);const input=proof();pump++;action++;required=pump;revision++;value={route,selector:payload.selector,inputTransport:'native-host-coordinate-event',x:10,y:20,frameId:Number(input.frameId),renderRevision:Number(input.renderRevision),inputCompletion:input,completion:proof()}}
  else throw Error('Unplanned synthetic op '+op)
  return mutate?.(value,op,payload)??value
 };return{calls,request}
}
for(const d of [issue547,issue289]) {
 test(d.caseId+' replays complete original source order using independent actual IPC values',async()=>{
  const w=wire(d),oracle=trace(d),r=await replayComponentScopeFamily({caseId:d.caseId,request:w.request,oracleTrace:oracle,staticInputs:await staticInput(d)})
  assert.deepEqual(r.events,oracle.events);assert.deepEqual(r.assertions,oracle.assertions);assert.equal(r.staticCoverage.originalStaticExpectations,d===issue547?5:28)
  assert.equal(w.calls.filter(c=>c.op==='tap').length,d===issue547?0:12);assert.equal(w.calls.filter(c=>c.op==='checkpoint').length,d===issue547?1:16)
  assert(w.calls.filter(c=>c.op==='checkpoint').flatMap(c=>c.payload.selectors).every(q=>!('count'in q)&&!('value'in q)&&!('expected'in q)))
  for(const call of w.calls)assert(!JSON.stringify(call.payload).includes('raw actual'))
  if(d===issue547){assert.deepEqual(r.planObservations,[{planOrdinal:0,route:d.plans[0].route,value:{selector:'#issue547-page',attributes:{'data-e2e-issue':'547'}}}]);assert(w.calls.findIndex(c=>c.op==='query.attribute')<w.calls.findIndex(c=>c.op==='checkpoint'))}
 })
 test(d.caseId+' source tape rejects incomplete/extra/foreign/changed original observations',()=>{
  for(const change of [t=>t.events.pop(),t=>t.events.push(t.events[0]),t=>t.events[0].seq=4,t=>t.assertions.pop(),t=>t.caseId='foreign',t=>t.events.find(e=>e.op==='dom.checkpoint').payload.nodes[0].selector='#wrong',t=>t.events.find(e=>e.op==='dom.checkpoint').payload.nodes[0].scope=['#wrong']]){const t=trace(d);change(t);assert.throws(()=>componentScopeFamilyActionTape(d.caseId,t))}
 })
 test(d.caseId+' actual value mismatch and stale Page completion reject',async()=>{
  const input=await staticInput(d)
  for(const w of [wire(d,{mutate:(v,op)=>{if(op==='checkpoint')v.nodes[0].nodes[0].text='different actual';return v}}),wire(d,{mutate:(v,op)=>{if(op==='currentPage')v.completion.pageId='999';return v}})])await assert.rejects(replayComponentScopeFamily({caseId:d.caseId,request:w.request,oracleTrace:trace(d),staticInputs:input}))
 })
 test(d.caseId+' preserves the actual IPC rejection identity',async()=>{
  const error=Object.assign(Error('actual sentinel'),{code:'ACTUAL'}),w=wire(d,{fail:{op:'checkpoint',error}})
  await assert.rejects(replayComponentScopeFamily({caseId:d.caseId,request:w.request,oracleTrace:trace(d),staticInputs:await staticInput(d)}),e=>e===error)
 })
}
test('issue547 actual marker value is asserted only after its checkpoint trace completes',async()=>{
 const w=wire(issue547,{marker:'wrong actual'});await assert.rejects(replayComponentScopeFamily({caseId:issue547.caseId,request:w.request,oracleTrace:trace(issue547),staticInputs:await staticInput(issue547)}),/dataset readiness/);assert.equal(w.calls.filter(c=>c.op==='checkpoint').length,1)
})
test('issue547 missing actual marker rejects without fabricating Element/attribute',async()=>{
 const w=wire(issue547,{markerAbsent:true});await assert.rejects(replayComponentScopeFamily({caseId:issue547.caseId,request:w.request,oracleTrace:trace(issue547),staticInputs:await staticInput(issue547)}),/actual rendered Element/);assert(!w.calls.some(c=>c.op==='query.attribute'||c.op==='checkpoint'))
})
test('issue289 requires unique actual root Page.$$ acquisition for every tap',async()=>{
 const w=wire(issue289,{tapCount:2});await assert.rejects(replayComponentScopeFamily({caseId:issue289.caseId,request:w.request,oracleTrace:trace(issue289),staticInputs:await staticInput(issue289)}),/one actual rendered control/);assert.equal(w.calls.filter(c=>c.op==='tap').length,0)
})
test('marker callback sends field names only and readiness wrapper rejects changed identities',async()=>{
 const calls=[],value=await observeComponentMarker({plan:issue547.plans[0],page:{$:async selector=>{calls.push(selector);return{attribute:async name=>{calls.push(name);return'547'}}}}})
 assert.deepEqual(calls,['#issue547-page','data-e2e-issue']);const observations=[{planOrdinal:0,route:issue547.plans[0].route,value}];assert.doesNotThrow(()=>assertIssue547Readiness(observations))
 for(const mutate of [v=>v[0].planOrdinal=1,v=>v[0].route='foreign',v=>v[0].value.selector='#foreign',v=>v[0].value.attributes['data-e2e-issue']='wrong',v=>v.push(v[0])]){const changed=structuredClone(observations);mutate(changed);assert.throws(()=>assertIssue547Readiness(changed))}
})
test('count-only source queries keep raw count, project every node to an empty record',()=>{
 let seen=0;for(const p of issue289.plans)for(const s of p.steps)if(s.kind==='checkpoint')for(const [at,q]of s.queries.entries())if(!q.fields.text){const projected=projectCheckpoint(rawGroups(s),s.queries)[at];assert.equal(projected.nodes.length,projected.count);assert(projected.nodes.every(n=>Object.keys(n).length===0));seen++}assert(seen>10)
})

test('both exact case registries declare complete sealed collector inputs and native dispatcher', async () => {
  for (const d of [issue547, issue289]) {
    const definition = caseDefinition(d.caseId), issue = d === issue547 ? '547' : '289'
    assert.equal(definition.sourceSha256, d.sourceSha256); assert.equal(definition.requiresOracleTrace, true); assert.equal(definition.oracleInputs, 'issue' + issue)
    const registry = JSON.parse(await readFile(new URL('../../../conformance/recipes/issue' + issue + '-v1.json', import.meta.url)))
    const recipe = registry.recipes[0]; assert.equal(recipe.caseId, d.caseId); assert.equal(recipe.sourceSha256, d.sourceSha256)
    for (const expected of [recipe.collector, ...recipe.collectorInputs]) {
      const bytes = await readFile(new URL('../../../' + expected.path, import.meta.url))
      assert.equal(hash(bytes), expected.sha256); assert.equal(bytes.length, expected.bytes)
      assert.equal(collectorInputs().find(ref => ref.path === '../../../' + expected.path).sha256, expected.sha256)
    }
    const w = wire(d), result = await replayCase({ caseId: d.caseId, request: w.request, oracleTrace: trace(d), staticInputs: await staticInput(d) })
    assert.deepEqual(result.events, trace(d).events); assert.deepEqual(result.assertions, trace(d).assertions)
  }
})
