/** Actual pinned Page/Element bytecode with a synthetic local transport.
 * These models establish collector boundaries only: no SDK, DevTools,
 * compiler, native host or captured r4 IPC is executed or inferred. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { Page } from '../../vendor/weapp-vite/packages/miniprogram-automator/dist/index.mjs'
import { createCollector } from './issue1072-collector.mjs'

const routes=['pages/home/index','pages/external/index','pages/dynamic/index']
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes});return {promise,resolve}}
async function archive(name,s){
 if(!process.env.WEAPP_CONTAINER_QUERY_PROBE_ARCHIVE)return
 const directory=resolve(process.env.WEAPP_CONTAINER_QUERY_PROBE_ARCHIVE);await mkdir(directory,{recursive:true})
 const references=[]
 for(const relative of ['../../vendor/weapp-vite/packages/miniprogram-automator/dist/index.mjs','./issue1072-collector.mjs','./passive-query-context.mjs']){
  const file=new URL(relative,import.meta.url),bytes=await readFile(file)
  references.push({url:file.href,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length})
 }
 await writeFile(resolve(directory,name+'.json'),JSON.stringify({schemaVersion:1,kind:'actual-pinned-automator-synthetic-transport-model',
  boundary:'Exact imported class artifact plus synthetic in-memory transport; no original r4 query path, raw IPC, SDK, DevTools, compiler or native host is established.',
  references,events:s.events,operations:s.operations,diagnostics:s.collector.diagnostics()},null,2)+'\n')
}
function model({helperGate}={}) {
  const events=[],operations=[],pages=new Map(),state={text:'',helper:false},entered=deferred()
  const connection={prefersAppServicePageProtocol:false,async send(method,params,options){
    operations.push({method,params:structuredClone(params),options:options&&structuredClone(options)})
    if(method==='Page.getElement') {
      if(state.helper&&params.selector==='#increment'&&options.timeout<=800){
        entered.resolve();if(helperGate)await helperGate.promise
        throw new Error('synthetic missing direct node during provider helper')
      }
      // A root/view selector may legally alias the exact target node.
      return {elementId:'same-actual-node',tagName:'view'}
    }
    if(method==='Element.getElement')return {elementId:'same-actual-node',tagName:'view'}
    if(method==='Element.getDOMProperties')return {properties:[state.text]}
    if(method==='Element.tap'){state.text='actual post tap';return}
    throw new Error(`Unexpected synthetic method ${method}`)
  }}
  const program={async reLaunch(route){state.text='actual before '+route;return Page.create(connection,{id:7,path:route.slice(1),query:{}},pages)}}
  const collector=createCollector({emit:e=>events.push(e)});collector.attach(program)
  const checkpoint=(index)=>collector.checkpoint({evidence:{id:`package-${index}`,route:routes[index],nodes:[{selector:'#increment',query:'css',count:1,nodes:[{text:state.text}]}]}})
  return {program,collector,events,operations,state,entered,checkpoint}
}
async function finish(s,start=0) {
 for(let index=start;index<3;index++){
  const page=await s.program.reLaunch('/'+routes[index]),element=await page.$('#increment')
  await element.text();await element.tap();s.checkpoint(index)
 }
 s.collector.flush()
}

test('pinned actual helper nested Page.$/Element.$ and legal same-node aliases retain the canonical target across cache-reused launches',async()=>{
 const s=model();let originalPage,originalElement
 for(let index=0;index<3;index++){
  const page=await s.program.reLaunch('/'+routes[index])
  const alias=await page.$('view'),element=await page.$('#increment')
  assert.equal(alias,element)
  if(index){assert.equal(page,originalPage);assert.equal(element,originalElement)}else{originalPage=page;originalElement=element}
  const actual=await element.text()
  s.state.helper=true
  const ready=await page.waitForRendered({selector:'#increment',timeout:3000})
  s.state.helper=false
  assert.deepEqual(JSON.parse(ready),{selector:'#increment',nodes:[{dataset:{}}]})
  assert.equal(await page.$('view'),element)
  await element.tap();s.checkpoint(index)
  assert.equal(s.events[index*4+1].payload.text,actual)
 }
 s.collector.flush();assert.equal(s.events.length,12)
 assert.equal(Object.hasOwn(originalPage,'$'),false);assert.equal(Object.hasOwn(originalPage,'waitForRendered'),false)
 assert.equal(Object.hasOwn(originalElement,'$'),false);assert.equal(Object.hasOwn(originalElement,'text'),false);assert.equal(Object.hasOwn(originalElement,'tap'),false)
 const diagnostic=s.collector.diagnostics(),calls=diagnostic.events.filter(e=>e.phase==='begin')
 assert.ok(calls.some(e=>e.operation==='Page.waitForRendered'&&!e.internal))
 assert.ok(calls.some(e=>e.operation==='Page.$'&&e.selector==='page'&&e.internal))
 assert.ok(calls.some(e=>e.operation==='Element.$'&&e.selector==='#increment'&&e.internal))
 assert.ok(s.operations.some(e=>e.method==='Element.getElement'))
 await archive('pinned-helper-cache-alias',s)
})

test('pinned actual helper pending in one async lineage does not swallow a concurrent external canonical query',async()=>{
 const gate=deferred(),s=model({helperGate:gate}),page=await s.program.reLaunch('/'+routes[0])
 s.state.helper=true;const helper=page.waitForRendered({selector:'#increment',timeout:3000});await s.entered.promise
 const element=await page.$('#increment');await element.text();await element.tap()
 gate.resolve();await helper;s.state.helper=false;s.checkpoint(0);await finish(s,1)
 const calls=s.collector.diagnostics().events.filter(e=>e.phase==='begin')
 const outer=calls.find(e=>e.operation==='Page.waitForRendered'),concurrent=calls.find(e=>e.operation==='Page.$'&&e.acquisition===1)
 assert.ok(concurrent);assert.equal(concurrent.internal,false);assert.notEqual(concurrent.root,outer.root)
 await archive('pinned-helper-concurrent-external',s)
})

test('synthetic transport reentrant queries exercise the actual pinned Page wrapper without claiming an observed route-fallback path',async()=>{
 const events=[],pages=new Map();let page,nested=false
 const connection={prefersAppServicePageProtocol:false,async send(method,params){
  if(method==='Page.getElement'){
   if(params.selector==='#increment'&&!nested){nested=true;await page.$('view');nested=false}
   return {elementId:'same',tagName:'view'}
  }
  if(method==='Element.getDOMProperties')return {properties:['actual']}
  if(method==='Element.tap')return
  throw new Error(method)
 }}
 const program={async reLaunch(route){page=Page.create(connection,{id:9,path:route.slice(1),query:{}},pages);return page}}
 const collector=createCollector({emit:e=>events.push(e)});collector.attach(program)
 for(const [index,route]of routes.entries()){
  page=await program.reLaunch('/'+route);const element=await page.$('#increment');await element.text();await element.tap()
  collector.checkpoint({evidence:{id:`package-${index}`,route,nodes:[{selector:'#increment',query:'css',count:1,nodes:[{text:'actual checkpoint'}]}]}})
 }
 collector.flush();assert.equal(events.length,12)
 const queries=collector.diagnostics().events.filter(e=>e.phase==='begin'&&e.operation==='Page.$')
 assert.ok(queries.some(e=>e.selector==='view'&&e.internal));assert.ok(queries.filter(e=>!e.internal).every(e=>e.selector==='#increment'))
 await archive('pinned-class-synthetic-transport-reentrant',{collector,events,operations:[]})
})

test('an actual pinned same-node alias alone cannot supply the missing canonical action acquisition',async()=>{
 const s=model(),page=await s.program.reLaunch('/'+routes[0]),alias=await page.$('view')
 await alias.text();await alias.tap()
 assert.equal(s.events.length,1);assert.throws(()=>s.collector.flush(),/no canonical action query/)
 await archive('pinned-alias-missing-canonical',s)
})
