/** Offline synthetic providers only. No official indexed test/compiler/native/UI. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import data from '../../../conformance/recipes/template-static-test-inputs.json' with { type: 'json' }
import { descriptor } from '../../../conformance/recipes/template-multi-platform-descriptor.mjs'
import { assertTemplateStaticOutputs } from '../../../conformance/recipes/template-static-assertions.mjs'
import { resolvePages, assertTemplateRouteCoverage, formatWxml, normalizeWxmlForSnapshot } from '../../../conformance/recipes/template-snapshot-format.mjs'
import { loadTemplateInputs } from './template-multi-platform-static.mjs'
import { replayCase, caseDefinition, collectorInputs } from './replay.mjs'
const CASE=descriptor.caseId,SOURCE=descriptor.sourceSha256,COMMIT='0ad7ba6269b97c03ec95de9e6c9e9e2d8773f84e',BASELINE='wechat-devtools-2.02.2609250-sdk-3.17.3'
const hash=b=>createHash('sha256').update(b).digest('hex')
const files=()=>data.files.map(({path,source})=>{const bytes=Buffer.from(source);return{path,bytes,length:bytes.length,sha256:hash(bytes)}})
const staticInputs=()=>({caseId:CASE,sourceSha256:SOURCE,manifestIntegrity:'a'.repeat(64),files:files()})
const nodes=ordinal=>['原生多平台 + Web','MP_PLATFORM=weapp','status=ready','weapp',String(ordinal)].map((text,at)=>{
 const {selector,scope}=descriptor.checkpoints[ordinal].queries[at];return{selector,query:'css',...(scope?{scope:[...scope]}:{}),count:1,nodes:[{text}]}
})
const originalTrace=()=>({schemaVersion:1,caseId:CASE,oracle:'wechat-devtools',run:{status:'passed',host:'devtools',engine:'wechat',environment:{baselineId:BASELINE,compilerCommit:COMMIT,caseSourceSha256:SOURCE,manifestIntegrity:'a'.repeat(64)}},
 assertions:[{id:descriptor.test,passed:true}],events:[
 {seq:0,kind:'lifecycle',op:'route.active',payload:{route:descriptor.route}},
 {seq:1,kind:'render',op:'dom.checkpoint',payload:{id:descriptor.checkpoints[0].id,route:descriptor.route,nodes:nodes(0)}},
 {seq:2,kind:'event',op:'tap',payload:{route:descriptor.route,selector:descriptor.action.selector}},
 {seq:3,kind:'render',op:'dom.checkpoint',payload:{id:descriptor.checkpoints[1].id,route:descriptor.route,nodes:nodes(1)}}]})
function syntheticWire({mutate,fail}={}){
 const calls=[];let pump=0,action=0,required=0,revision=1,pageId=1,route='pages/home/index'
 const proof=()=>({kind:'owner-pump-native-presentation-v1',sessionId:'synthetic-unit-only',route,pageId:String(pageId),templateRevision:String(revision),consumedTemplateRevision:String(revision),frameId:String(revision+10),renderRevision:String(revision),presentationAckRevision:String(revision),actionSeq:String(action),ownerPumpSeq:String(pump),requiredPumpSeq:String(required),presented:true})
 const request=async(op,payload={})=>{
  calls.push({op,payload:structuredClone(payload)});if(op===fail?.op)throw fail.error;pump++;let value
  if(op==='render.settle')value=proof()
  else if(op==='reLaunch'){route=payload.route.replace(/^\//,'');pageId++;revision++;action++;required=pump+1;pump++;value={path:route,completion:proof()}}
  else if(op==='currentPage')value={path:route,pageId:String(pageId),completion:proof()}
  else{
   assert.equal(payload.route,route);const address={route,selector:payload.selector,...(payload.scope?{scope:structuredClone(payload.scope)}:{}),frameId:revision+10,renderRevision:revision,completion:proof()}
   if(op==='query')value={...address,count:1,nodes:[{id:'actual/'+payload.selector,componentScopeId:null}]}
   else if(op==='tap'){const inputCompletion=proof(),frameId=revision+10,renderRevision=revision;action++;required=pump+1;pump++;revision++;value={...address,frameId,renderRevision,x:10,y:20,inputTransport:'native-host-coordinate-event',inputCompletion,completion:proof()}}
   else if(op==='checkpoint'){const ordinal=descriptor.checkpoints.findIndex(s=>s.id===payload.checkpoint);value={id:payload.checkpoint,route,nodes:nodes(ordinal),completion:proof()}}
   else throw Error('Unplanned synthetic operation '+op)
  }
  return mutate?.(value,op,payload,calls)??value
 };return{calls,request}
}
const fixture={manifest:{compiler:{commit:COMMIT},integrity:{root:'a'.repeat(64)}}}
function closure(mutate=()=>{}){
 const store=new Map(),records={};const put=(key,value)=>{
  const changed=mutate(key,value);if(changed!==undefined)value=changed
  const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value)),reference={path:'synthetic/'+key,sha256:hash(bytes),bytes:bytes.length};store.set(reference.path,bytes);records[key]={value,reference};return reference
 }
 const generated=files().map((f,at)=>({kind:'file',path:f.path,artifact:put('file-'+at,f.bytes)}));mutate('generated',generated)
 const config=put('runtime-config','{"miniprogramRoot":"dist"}'),projectOutput=generated.map(i=>({...i,path:'weapp/dist/'+i.path}));projectOutput.push({kind:'file',path:'weapp/project.config.json',artifact:config})
 const transaction=put('transaction',{schemaVersion:1,kind:'weapp-container.template-producer-transaction',profile:'template-native-static-snapshot-v1',sourceRoot:'/synthetic/source',sourceProjectPath:'/synthetic/source/dist/weapp',generatedRoot:'/synthetic/source/dist/weapp/dist',runtimeProjectPath:'/synthetic/sdk-snapshot',runtimeRoot:'/synthetic/sdk-snapshot',postHelperProjectOutput:structuredClone(projectOutput),postHelperGenerated:structuredClone(generated),snapshotFiles:[...structuredClone(generated),{kind:'file',path:'project.config.json',artifact:put('sdk-config','{}')},{kind:'file',path:'project.private.config.json',artifact:put('sdk-private-config','{}')}]})
 const checkpoint=put('checkpoint',{schemaVersion:1,kind:'weapp-container.static-generated-checkpoint',status:'captured',caseId:CASE,sourceSha256:SOURCE,producerTransaction:transaction,runtimeGenerated:structuredClone(generated),
  runtimeObservation:put('runtime',{projectPath:'/synthetic/sdk-snapshot'}),build:{generated,producerProfile:{profile:'template-native-static-snapshot-v1'},projectPath:'/synthetic/source',sourceRoot:'/synthetic/source',sourceOutputRelative:'dist',outputRelative:'dist/weapp/dist',runtimeProjectPath:'/synthetic/source/dist/weapp',outputRoot:'/synthetic/source/dist/weapp/dist',projectConfig:config,runtimeProjectConfig:config,projectOutput,staticCliProfile:{profile:'static-template-weapp-directory-v1',sourceRoot:'/synthetic/source'}}})
 const fixtureBuild=put('fixture-build',{schemaVersion:1,kind:'weapp-container.fixture-build',status:'built',caseId:CASE,sourceSha256:SOURCE,checkpoint,fixture:put('fixture',structuredClone(fixture)),before:put('before',structuredClone(generated)),after:put('after',structuredClone(generated))})
 const suiteReport=put('suite',{success:true,testResults:[{name:'/synthetic/checkout/'+descriptor.caseSourcePath,status:'passed',assertionResults:[{fullName:descriptor.test,status:'passed'}]}]})
 const trace=put('trace',originalTrace()),execution=put('execution',{schemaVersion:1,kind:'wechat-devtools-case-execution',status:'passed',caseId:CASE,sourceSha256:SOURCE,sourceUnchanged:true,compilerCommit:COMMIT,baseline:{id:BASELINE},traceSha256:trace.sha256,manifestIntegrity:fixture.manifest.integrity.root,observedDevtoolsVersion:'2.02.2609250',observedBaseLibraryVersion:'3.17.3',fixtureBuild,suiteReport})
 return{recipe:{caseId:CASE,sourceSha256:SOURCE,fixtureValue:fixture,oracle:{trace,execution}},records,store,loadArtifact:async ref=>store.get(ref.path)}
}
const replay=(wire,overrides={})=>replayCase({caseId:CASE,request:wire.request,oracleTrace:originalTrace(),staticInputs:staticInputs(),...overrides})
test('complete generated assertions match both unchanged snapshots and generated route/syntax checks',async()=>{
 const result=await assertTemplateStaticOutputs(staticInputs());assert.equal(result.originalSnapshotAssertions.length,2);assert.equal(result.originalWxmlSyntaxChecks,1);assert.deepEqual(result.generatedPages,[descriptor.route])
})
test('original formatting preserves source helper normalization including compatibility attributes and unsupported event rejection order',async()=>{
 assert.equal(await formatWxml(normalizeWxmlForSnapshot('<button id="x" @tap="a"/>')),'<button activity-type="0" entrance-path="" need-show-entrance="" id="x"/>')
 const pages=resolvePages({pages:['/a/','a'],subPackages:[{root:'sub',pages:['p','sub/q']}],subpackages:[{root:'other',pages:['r']}]});assert.deepEqual(pages,['a','sub/p','sub/q','other/r'])
 const routes=pages.map(route=>({route,steps:[{route}]}));assertTemplateRouteCoverage(pages,routes)
 assert.throws(()=>assertTemplateRouteCoverage(pages,routes.concat(routes[0])),/duplicate/)
 assert.throws(()=>assertTemplateRouteCoverage(pages,routes.slice(1)),/coverage/)
 assert.throws(()=>assertTemplateRouteCoverage(pages,[{route:'a',steps:[]}]),/coverage|checkpoints/)
})
test('snapshot, syntax, empty/stale routes, missing/generated bytes and encoding drift fail closed',async()=>{
 for(const [path,mutate] of [['app.wxss',s=>s.replace('#f4f6f8','#ffffff')],['pages/index/index.wxml',s=>s.replace('page-shell','other-shell')],['pages/index/index.wxml',s=>s.replace('<view ','<view @click="bad" ')],['app.json',()=>'{"pages":[]}'],['app.json',()=>'{"pages":["foreign/route"]}']]){
  const value=staticInputs(),file=value.files.find(f=>f.path===path);file.bytes=Buffer.from(mutate(file.bytes.toString()));file.length=file.bytes.length;file.sha256=hash(file.bytes);await assert.rejects(assertTemplateStaticOutputs(value))
 }
 for(const mutate of [v=>v.files.pop(),v=>v.files.reverse(),v=>v.files[0].sha256='b'.repeat(64),v=>v.sourceSha256='b'.repeat(64),v=>{const f=v.files[2];f.bytes=Buffer.from([255]);f.length=1;f.sha256=hash(f.bytes)}]){const value=staticInputs();mutate(value);await assert.rejects(assertTemplateStaticOutputs(value))}
})
test('loader binds exact original result, baseline, fixture, nested project and consumed generated artifacts',async()=>{
 const loaded=await loadTemplateInputs(closure());assert.equal(loaded.staticInputs.files.length,3);assert.equal(loaded.trace.events.length,4);assert.ok(loaded.references.length>10);await assertTemplateStaticOutputs(loaded.staticInputs)
})
test('loader rejects incomplete original results, foreign mappings, detached generations and artifact byte drift',async()=>{
 const cases=[['suite',v=>v.testResults[0].assertionResults[0].status='skipped'],['suite',v=>v.testResults[0].assertionResults.push({...v.testResults[0].assertionResults[0]})],['execution',v=>v.sourceUnchanged=false],['execution',v=>v.observedBaseLibraryVersion='other'],['trace',v=>v.assertions=[]],['runtime',v=>v.projectPath+='-copy'],['checkpoint',v=>v.build.runtimeProjectPath+='-copy'],['checkpoint',v=>v.build.projectOutput.pop()],['checkpoint',v=>v.build.projectOutput[0].artifact={...v.build.generated[1].artifact}],['after',v=>v.pop()],['fixture',v=>v.manifest.integrity.root='c'.repeat(64)]]
 for(const [key,fn]of cases)await assert.rejects(loadTemplateInputs(closure((k,v)=>{if(k===key)fn(v)})), undefined, key)
 const value=closure();value.store.set('synthetic/file-1',Buffer.from('changed'));await assert.rejects(loadTemplateInputs(value),/bytes differ/)
})
test('native template uses current owner-pump adapter and returns complete original assertions before driver-owned cleanup',async()=>{
 const wire=syntheticWire(),result=await replay(wire);assert.deepEqual(result.events,originalTrace().events);assert.deepEqual(result.assertions,originalTrace().assertions);assert.equal(result.staticCoverage.originalSnapshotAssertions.length,2);assert.equal(result.completionFacts.length,8)
 assert.deepEqual(wire.calls.map(c=>c.op),['render.settle','reLaunch','currentPage','checkpoint','query','tap','checkpoint'])
 const sent=JSON.stringify(wire.calls);for(const s of ['原生多平台 + Web','MP_PLATFORM=weapp','status=ready','f4f6f8'])assert.equal(sent.includes(s),false)
 assert.equal(caseDefinition(CASE).oracleInputs,'template');assert.throws(()=>caseDefinition(CASE.replace('template','sfc-template')),/no reviewed/)
 const input=collectorInputs();assert.equal(new Set(input.map(x=>x.path)).size,input.length);assert.ok(input.some(x=>x.path.endsWith('template-multi-platform-snapshots.json')))
})
test('missing static/oracle proof and aborted calls produce no native IPC',async()=>{
 for(const overrides of [{oracleTrace:undefined},{staticInputs:undefined},{oracleTrace:{...originalTrace(),assertions:[]}},{signal:AbortSignal.abort(new Error('stop'))}]){const wire=syntheticWire();await assert.rejects(replay(wire,overrides));assert.deepEqual(wire.calls,[])}
})
test('native stale presentations, scope/page swaps, nonunique tap and missing coordinate input fail closed',async()=>{
 const cases=[['checkpoint',v=>v.completion.presented=false],['currentPage',v=>v.pageId='999'],['query',v=>v.scope=['foreign']],['query',v=>{v.count=2;v.nodes.push({...v.nodes[0],id:'second'})}],['tap',v=>v.inputTransport='synthetic-direct-dispatch'],['tap',v=>v.completion.actionSeq='0'],['tap',v=>v.completion.ownerPumpSeq='1']]
 for(const [at,fn]of cases){const wire=syntheticWire({mutate:(v,op)=>{if(op===at)fn(v)}});await assert.rejects(replay(wire));assert.ok(wire.calls.filter(c=>c.op==='tap').length<=1)}
})
test('native actual text/count and complete original event trace remain final assertions',async()=>{
 for(const fn of [v=>v.nodes[0].nodes[0].text='wrong',v=>v.nodes[0].count=0,v=>v.nodes[3].scope=['foreign']]){const wire=syntheticWire({mutate:(v,op)=>{if(op==='checkpoint')fn(v)}});await assert.rejects(replay(wire),/text|count|scope/);assert.equal(wire.calls.some(c=>c.op==='tap'),false)}
 const trace=originalTrace();trace.events[3].payload.nodes[0].nodes[0].text='different original observation';await assert.rejects(replay(syntheticWire(),{oracleTrace:trace}),/trace differs/)
 const invalid=originalTrace();invalid.events[0].seq=1;const wire=syntheticWire();await assert.rejects(replay(wire,{oracleTrace:invalid}));assert.deepEqual(wire.calls,[])
})
test('native provider rejection preserves identity without retrying original side effects',async()=>{
 for(const op of ['render.settle','reLaunch','currentPage','checkpoint','query','tap']){const error=Object.freeze(new Error('synthetic '+op)),wire=syntheticWire({fail:{op,error}});await assert.rejects(replay(wire),e=>e===error);assert.equal(wire.calls.filter(c=>c.op===op).length,1)}
})
