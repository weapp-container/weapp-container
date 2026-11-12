/** CPU source/adapter contracts. Synthetic IPC has no native presentation or official status. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {descriptor} from './issue826-descriptor.mjs'
import {createCollector} from './issue826-collector.mjs'
import {issue826ActionTape,replayIssue826} from '../../examples/hosts/conformance-desktop/issue826-replay.mjs'
const root=new URL('../../',import.meta.url),hash=v=>createHash('sha256').update(v).digest('hex')
const source=await readFile(new URL('vendor/weapp-vite/'+descriptor.caseSourcePath,root),'utf8')
const tree=ts.createSourceFile('case.ts',source,ts.ScriptTarget.Latest,true)
const code=ts.transpileModule(tree.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getText(tree)).join('\n'),
 {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
const values=[['__ISSUE_826_UTIL_SHARED__','__ISSUE_826_UTIL_SINGLE__','__ISSUE_826_UTIL_LEAF_A__:__ISSUE_826_UTIL_LEAF_B__','__ISSUE_826_SERVICE_SHARED__','__ISSUE_826_SERVICE_SINGLE__','__ISSUE_826_LOCAL_UNMATCHED__'].join('|'),
 ['__ISSUE_826_UTIL_SHARED__','__ISSUE_826_UTIL_LEAF_A__:__ISSUE_826_UTIL_LEAF_B__','__ISSUE_826_SERVICE_SHARED__'].join('|')]
const steps=descriptor.plans[0].steps,checks=steps.filter(step=>step.kind==='checkpoint')
const groups=at=>checks[at].queries.map(({fields,...address})=>({...address,count:1,nodes:[{text:values[at]}]}))
function passive({entries=[],closingEntries=[],missingData=false,dataOverride,throwData}={}){
 const events=[],calls=[],meta={closed:false,entries,reset(){entries.length=0}},program={}
 program.enableLog=async()=>{program.__weappViteRuntimeLogMeta=meta}
 const pages=checks.map((step,at)=>({pageId:at+1,path:step.route,async data(...args){calls.push({op:'data',at,args});if(throwData)throw throwData;return dataOverride??values[at]}}))
 if(missingData)delete pages[0].data
 let active
 program.reLaunch=async route=>{calls.push({op:'reLaunch',route});return active=pages.find(page=>'/'+page.path===route)}
 program.currentPage=async()=>active
 const collector=createCollector({emit:event=>events.push({...structuredClone(event),seq:events.length})});collector.attach(program)
 const run=async()=>{
  await program.enableLog(15000,{structured:true})
  let callback;const context={describe(_name,_options,invoke){invoke()},beforeAll(){},afterAll(){},it(_name,invoke){callback=invoke},
   PREPARE_GITHUB_ISSUES_BUILD_TIMEOUT:1,prepareGithubIssuesBuild:async()=>{},closeSharedMiniProgram:async()=>{},releaseSharedMiniProgram:async()=>{},
   getSharedMiniProgram:async()=>program,relaunchPage:async(p,route)=>p.reLaunch(route),
   expect(value){return {toBe(expected){assert.equal(value,expected)},toEqual(expected){assert.deepEqual(JSON.parse(JSON.stringify(value)),JSON.parse(JSON.stringify(expected)))}}},
   createDomAcceptance(_ctx,_fixture,plans){return {async check(id,session,page){const at=plans.findIndex(plan=>plan.id===id);assert.equal(page.path,checks[at].route);assert.equal(plans[at].nodes[0].text,values[at]);collector.checkpoint({evidence:{id,route:page.path,nodes:groups(at)}},{session,page})}}}}
  runInNewContext(code,context,{timeout:1000});await callback({skip(){throw new Error('source skip')}});entries.push(...closingEntries);meta.closed=true;collector.flush()
  return {caseId:descriptor.caseId,oracle:'wechat-devtools',run:{status:'passed'},assertions:[{id:descriptor.plans[0].fullName,passed:true}],events}
 }
 return {program,pages,collector,events,calls,run}
}
const startup=engine=>({engine,sessionId:'synthetic-source826',runtimeDataObservation:{kind:'private-receiver-data-and-runtime-journal-v1',incarnation:'synthetic-journal826',journalBegins:'native-realm-bootstrap-before-app-modules'}})
function wire(engine,{mutate,rejectOp,entries=[],bootstrapEntries=[],closingEntries=[]}={}){
 let pump=0,action=0,required=0,revision=1,pageId=1,route='pages/home/index',checkpoint=0,dataAt=0;const calls=[]
 const proof=()=>({kind:'owner-pump-native-presentation-v1',sessionId:startup(engine).sessionId,route,pageId:String(pageId),templateRevision:String(revision),consumedTemplateRevision:String(revision),frameId:String(revision+10),renderRevision:String(revision),presentationAckRevision:String(revision),actionSeq:String(action),ownerPumpSeq:String(pump),requiredPumpSeq:String(required),presented:true})
 const request=async(op,payload={})=>{calls.push({op,payload:structuredClone(payload)});if(op===rejectOp?.op)throw rejectOp.error;pump++;let result
  if(op==='render.settle')result=proof()
  else if(op==='reLaunch'){route=payload.route.replace(/^\//,'');pageId++;action++;required=pump+1;pump++;revision++;result={path:route,completion:proof()}}
  else if(op==='currentPage')result={path:route,pageId:String(pageId),completion:proof()}
  else if(op==='data.read')result={kind:'native-private-receiver-data-v1',owner:payload.owner,route,pageId:String(pageId),scopeId:null,path:payload.path,source:payload.source,receiverTokenSha256:'a'.repeat(64),value:{kind:'json',value:values[dataAt++]},completion:proof()}
  else if(op==='checkpoint')result={id:checks[checkpoint].id,route,nodes:groups(checkpoint++),completion:proof()}
  else if(op==='runtime.logs'||op==='runtime.logs.close'){const all=[...bootstrapEntries,...(op==='runtime.logs'&&calls.filter(c=>c.op==='runtime.logs').length===1?[]:entries),...(op==='runtime.logs.close'?closingEntries:[])];result={kind:'native-runtime-log-snapshot-v1',owner:payload.owner,...(op==='runtime.logs.close'?{closed:true}:{reset:false}),journal:{kind:'runtime-logs',generation:0,startCursor:0,resetCursor:0,endCursor:all.length,entries:all.map((entry,cursor)=>({cursor,...entry})),complete:true,overflow:false}}}
  else throw new Error('unplanned synthetic op '+op)
  result=structuredClone(result);return mutate?.(result,op,payload)??result
 };return {request,calls}
}
const replay=(engine,w,trace)=>replayIssue826({...w,startup:startup(engine),oracleTrace:trace,staticInputs:{caseId:descriptor.caseId,sourceSha256:descriptor.sourceSha256,files:[]}})
test('exact original source performs both real Page.data reads, route changes, DOM checks and full runtime-error filter',async()=>{
 for(const ref of descriptor.sourceGuards){const raw=await readFile(new URL('vendor/weapp-vite/'+ref.path,root));assert.equal(hash(raw),ref.sha256);assert.equal(raw.length,ref.bytes)}
 const p=passive({entries:[{level:'log',text:'ordinary source log'},{level:'ERROR',text:'case sensitive level stays ignored'}]}),trace=await p.run()
 assert.deepEqual(trace.events.map(e=>e.op),['runtime.logs.begin','route.active','data.read','dom.checkpoint','reLaunch','data.read','dom.checkpoint','runtime.logs.assertion'])
 assert.deepEqual(JSON.parse(JSON.stringify(p.calls.filter(c=>c.op==='data').map(c=>c.args))),[['value',{timeout:5000}],['value',{timeout:5000}]])
 assert.equal(trace.assertions.length,1);assert.equal(issue826ActionTape(trace).filter(step=>step.op==='data.read').length,2)
})
test('data observation preserves provider results/errors and requires actual reads independently of DOM',async()=>{
 const error=Object.freeze(new Error('original data provider rejection')),p=passive({throwData:error});await assert.rejects(p.run(),e=>e===error)
 for(const options of [{missingData:true},{dataOverride:'different actual data'}])await assert.rejects(passive(options).run())
 const p2=passive();await p2.program.reLaunch('/'+checks[0].route);await p2.pages[0].data('other',{timeout:5000});assert.throws(()=>p2.collector.flush(),/data read/)
})
test('all selected runtime entries survive level filtering in original order; absent metadata fails',async()=>{
 const entries=[{level:'warn',text:'ignored'},{level:'error',text:'actual error'},{level:'exception',text:'actual exception'}],p=passive({entries})
 await assert.rejects(p.run());assert.deepEqual(p.events.at(-1).payload.selected,entries.slice(1));assert.deepEqual(p.collector.diagnostics().runtimeLogs[0].entries,entries)
 const c=createCollector({emit(){}});assert.throws(()=>c.attach({async reLaunch(){},async currentPage(){}}),/subscription/)
})
test('complete source trace replays both data reads and both routes for each engine without expected values in requests',async()=>{
 const trace=await passive().run()
 for(const engine of ['quickjs','v8']){const w=wire(engine),result=await replay(engine,w,trace);assert.equal(result.dataFacts.length,2);assert.equal(result.runtimeLogFacts.length,3);assert.deepEqual(result.events,trace.events)
  assert.deepEqual(w.calls.map(c=>c.op),['render.settle','runtime.logs','reLaunch','currentPage','data.read','checkpoint','reLaunch','data.read','checkpoint','runtime.logs','runtime.logs.close']);assert(!JSON.stringify(w.calls).includes('__ISSUE_826_'))}
})
test('native data/log identity, complete cursor coverage, source values and original selected errors fail closed',async()=>{
 const trace=await passive().run();const variants=[
  ['data.read',v=>{v.owner.incarnation='foreign'}],['data.read',v=>{v.pageId='999'}],['data.read',v=>{v.scopeId='foreign'}],['data.read',v=>{v.source.callsite='foreign'}],['data.read',v=>{v.value.value='different'}],
  ['runtime.logs',v=>{v.journal.complete=false;v.journal.overflow=true}],['runtime.logs',v=>{v.journal.endCursor=1}],['runtime.logs',v=>{v.owner.sessionId='foreign'}]]
 for(const [op,change]of variants){const w=wire('quickjs',{mutate:(v,actual)=>{if(op===actual)change(v);return v}});await assert.rejects(replay('quickjs',w,trace))}
 await assert.rejects(replay('quickjs',wire('quickjs',{entries:[{level:'error',text:'native actual error'}]}),trace))
 const error=Object.freeze(new Error('native transport rejected'));await assert.rejects(replay('quickjs',wire('quickjs',{rejectOp:{op:'data.read',error}}),trace),e=>e===error)
})

test('source filter excludes pre-subscription bootstrap and post-filter close entries while raw native journal retains both',async()=>{
 const closing=[{level:'error',text:'actual owner close phase error'}],p=passive({closingEntries:closing}),trace=await p.run()
 assert.deepEqual(trace.events.at(-1).payload.selected,[]);assert.deepEqual(p.collector.diagnostics().runtimeLogs.at(-1).entries,closing)
 const w=wire('quickjs',{bootstrapEntries:[{level:'error',text:'before source subscription'}],closingEntries:closing})
 const result=await replay('quickjs',w,trace);assert.equal(result.runtimeLogFacts[0].journal.entries.length,1);assert.equal(result.runtimeLogFacts.at(-1).journal.entries.length,2)
 assert.deepEqual(result.events.at(-1).payload.selected,[])
})

test('closing helper reads cannot substitute for the original source runtime error-array read',async()=>{
 const p=passive();await p.program.enableLog(15000,{structured:true})
 for(let at=0;at<checks.length;at++){
  const page=await p.program.reLaunch('/'+checks[at].route);await page.data('value',{timeout:5000})
  p.collector.checkpoint({evidence:{id:checks[at].id,route:checks[at].route,nodes:groups(at)}},{session:p.program,page})
 }
 p.program.__weappViteRuntimeLogMeta.closed=true
 void p.program.__weappViteRuntimeLogMeta.entries
 assert.throws(()=>p.collector.flush(),/actual close/)
 assert.equal(p.events.some(event=>event.op==='runtime.logs.assertion'),false)
})


test('pinned runtime helper classifies Error text in ordinary console.log as a selected source error',async()=>{
 const trace=await passive().run()
 for(const engine of ['quickjs','v8']) for(const text of ['Error: original console error','TypeError: wrong receiver','RangeError: bounded']) {
  await assert.rejects(replay(engine,wire(engine,{entries:[{level:'log',text}]}),trace))
 }
 // Explicit source levels retain their priority over text heuristics.
 for(const level of ['debug','info','warn']) await replay('quickjs',wire('quickjs',{entries:[{level,text:'Error: explicitly non-error source level'}]}),trace)
})

test('native data source options accept cross-realm literals and reject wrong/extra/accessor fields before IPC',async()=>{
 const {createObservedNativeProgram}=await import('../../examples/hosts/conformance-desktop/native-program.mjs')
 const read=steps.find(step=>step.kind==='data.read'),context={sourceSha256:descriptor.sourceSha256,startup:startup('quickjs'),reads:[{...read,route:checks[0].route}]}
 const w=wire('quickjs'),program=createObservedNativeProgram(w.request,{dataContext:context}),page=await program.reLaunch('/'+checks[0].route)
 const options=runInNewContext('({timeout:5000})');assert.equal(await page.data('value',options),values[0]);assert.equal(options.timeout,5000)
 assert.equal(w.calls.filter(call=>call.op==='data.read').length,1);assert.ok(w.calls.filter(call=>call.op==='data.read').every(call=>!Object.hasOwn(call.payload,'options')))
 let getterReads=0
 for(const bad of [undefined,{timeout:4999},{timeout:5000,extra:true},{get timeout(){getterReads++;return 5000}}]){
  const other=wire('quickjs'),owner=createObservedNativeProgram(other.request,{dataContext:context}),selected=await owner.reLaunch('/'+checks[0].route)
  await assert.rejects(selected.data('value',bad),/next original source/);assert.equal(other.calls.some(call=>call.op==='data.read'),false)
 }
 assert.equal(getterReads,0)
})
