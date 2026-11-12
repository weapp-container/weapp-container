import assert from 'node:assert/strict'
import test from 'node:test'
import { createPassiveCollector } from './passive-collector-core.mjs'

const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes});return {promise,resolve}}
const route='synthetic/shared',selector='#actual-control'
function session({array=false,gate,helperGate}={}){
 const events=[],originals=[],collector=createPassiveCollector({emit:e=>events.push(e),label:'SyntheticShared',ownershipName:'synthetic-shared',
  descriptor:{route,action:{selector,afterCheckpoint:1},checkpoints:[{id:'before',queries:[],taps:0},{id:'after',queries:[],taps:1}]},
  pageQueries:array?['$','$$']:['$'],projectNodes:n=>n})
 const element={id:'synthetic-element',pageId:1,async $(query){return element},async tap(){return 'actual result'}}
 const page={path:route,pageId:1,async $(query,options){return options?.gate?gate.promise:element},async $$(query,options){return [await this.$(query,options)]},
  async waitForRendered(){await this.$('view');if(helperGate)await helperGate.promise;return 'actual readiness'}}
 const program={async currentPage(){return page},async reLaunch(){return page}}
 for(const [object,keys]of [[element,['$','tap']],[page,['$','$$','waitForRendered']],[program,['currentPage','reLaunch']]])
  for(const key of keys)originals.push({object,key,own:Object.getOwnPropertyDescriptor(object,key)})
 collector.attach(program)
 const checkpoint=id=>collector.checkpoint({evidence:{id,route,nodes:[]}},{session:program,page})
 const acquire=async query=>array?(await page.$$(query))[0]:page.$(query)
 return {collector,events,program,page,element,originals,checkpoint,acquire}
}

test('shared scalar/array adapters accept helper and external same-node aliases without relabeling the descriptor action',async()=>{
 for(const array of [false,true]){
  const s=session({array});await s.program.currentPage();s.checkpoint('before')
  assert.equal(await s.acquire('view'),s.element);assert.equal(await s.acquire(selector),s.element)
  assert.equal(await s.page.waitForRendered(),'actual readiness')
  assert.equal(await s.acquire('view'),s.element);assert.equal(await s.element.$('#alias'),s.element)
  assert.equal(await s.element.tap(),'actual result');s.checkpoint('after');s.collector.flush()
  assert.deepEqual(s.events[2].payload,{route,selector})
  for(const {object,key,own}of s.originals)assert.deepEqual(Object.getOwnPropertyDescriptor(object,key),own)
 }
})

test('shared helper awaiting in one lineage cannot swallow a concurrently acquired external target',async()=>{
 for(const array of [false,true]){
  const helperGate=deferred(),s=session({array,helperGate});await s.program.currentPage();s.checkpoint('before')
  const helper=s.page.waitForRendered();await Promise.resolve()
  await s.acquire(selector);await s.element.tap();helperGate.resolve();await helper
  s.checkpoint('after');s.collector.flush();assert.equal(s.events.length,4)
 }
})

test('shared missing canonical target, including nested same-object aliases, cannot synthesize descriptor action identity',async()=>{
 for(const array of [false,true]){
  const s=session({array});await s.program.currentPage();s.checkpoint('before')
  const alias=await s.acquire('view');await alias.$(selector);assert.equal(await alias.tap(),'actual result')
  assert.equal(s.events.length,2);assert.throws(()=>s.collector.flush(),/no canonical action query/)
 }
})

test('shared out-of-order canonical completion preserves original objects while failing the older acquisition',async()=>{
 for(const array of [false,true]){
  const gate=deferred(),s=session({array,gate});await s.program.currentPage();s.checkpoint('before')
  const earlier=array?s.page.$$(selector,{gate:true}):s.page.$(selector,{gate:true})
  await s.acquire(selector);gate.resolve(s.element)
  assert.equal(array?(await earlier)[0]:await earlier,s.element)
  assert.equal(await s.element.tap(),'actual result');assert.equal(s.events.length,2)
  assert.throws(()=>s.collector.flush(),/later actual Element acquisition/)
 }
})

test('shared late canonical query cannot adopt a later cached Page epoch or another transport owner',async()=>{
 for(const scenario of ['epoch','owner']){
  const gate=deferred(),s=session({gate});await s.program.currentPage();s.checkpoint('before')
  const pending=s.page.$(selector,{gate:true})
  if(scenario==='epoch')await s.program.reLaunch()
  else s.collector.attach({async currentPage(){return s.page}})
  gate.resolve(s.element);assert.equal(await pending,s.element)
  assert.equal(s.events.length,2);assert.throws(()=>s.collector.flush(),/generation|page/)
 }
})
