import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
const root=process.env.NEXTTICK_SOURCE_ROOT || new URL('../',import.meta.url).pathname
const {createAppServiceTestRealm}=await import(pathToFileURL(root+'/scripts/app-service-test-realm.mjs'))
const results=[]
function realm(engine){
 const r=createAppServiceTestRealm(engine)
 r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.nextTick':'full','Component.triggerEvent':'full'}})
 r.run(`globalThis.trace=[];Page({data:{number:0}});__container_set_current_pages([0],[{index:0,instanceId:11}]);globalThis.page=__container_page_instances['11'];
  __container_registration_module_id='module:c.js';__container_managed_component_modules[__container_registration_module_id]=true;globalThis.definition=Component({methods:{}});__container_registration_module_id=null;
  globalThis.child=__container_clone_component_instance(definition,{scopeId:'child',moduleId:'module:c.js',pageId:11,parentScopeId:null,ownerScopeId:null});
  globalThis.parent=__container_clone_component_instance(definition,{scopeId:'parent',moduleId:'module:c.js',pageId:11,parentScopeId:null,ownerScopeId:null});
 `)
 r.dispatch=()=>{
  const expected=JSON.parse(r.transports.captureReceiverIncarnations({pageId:'11',scopes:['child','parent']}))
  return r.transports.createReceiverEventDispatcher(r.run('__container_dispatch_owned_event'))({pageId:'11',expected,event:{type:'tap',dispatches:[{handler:'tap',ownerScopeId:'child',currentTarget:'child',phase:'target'}]}})
 }
 r.route=(ownerScopeId=null)=>r.run(`const records=[{scopeId:'child',ownerScopeId:${JSON.stringify(ownerScopeId)}},{scopeId:'parent',ownerScopeId:null}];const batch={pageId:11,eventNodes:[{key:'host',parentKey:null,ownerScopeId:${JSON.stringify(ownerScopeId)},componentScopeId:'child',attributes:{bindchange:'receive'},dataset:{},mark:{}},{key:'parent-host',parentKey:null,ownerScopeId:null,componentScopeId:'parent',attributes:{},dataset:{},mark:{}}]};__container_publish_component_event_batch(batch,__container_prepare_component_event_batch(batch,records))`)
 r.poll=async()=>{
  await Promise.resolve();const command=(action,extra={})=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'turn-scheduler',action,...extra}));command('begin',{limit:64,idleBudgetMs:null});let called=0
  try{for(let i=0;i<64;i++){if(!command('task',{allowIdle:false}).called)break;called++;await Promise.resolve()}}finally{command('end')}
  return called
 }
 return r
}
const cases=[
 ['fixed component setData example ends sync at2 then next slice at3',async r=>{
  r.run(`child.methods.doSth=function(){this.setData({number:1});wx.nextTick(()=>{this.setData({number:3});trace.push('later')});this.setData({number:2});trace.push('sync-end')};__container_invoke_component(child.__container_component_index,'doSth',[])`)
  assert.equal(r.run('child.data.number'),2);assert.deepEqual(r.json('trace'),['sync-end']);await r.poll();assert.equal(r.run('child.data.number'),3);assert.deepEqual(r.json('trace'),['sync-end','later'])
 }],
 ['nextTick is independent of idle capability or producer',async r=>{
  assert.equal(r.run(`wx.nextTick(function(){trace.push('later')})`),undefined);assert.throws(()=>r.run(`wx.requestIdleCallback(function(){})`));await r.poll();assert.deepEqual(r.json('trace'),['later'])
 }],
 ['retained child input nested parent handler survives child removal',async r=>{
  r.run(`page.receive=function(){this.setData({number:1});wx.nextTick(()=>{this.setData({number:3});trace.push('later')});this.setData({number:2});__container_unmount_component(child.__container_component_index);trace.push('sync-end')};child.tap=function(){this.triggerEvent('change',{})}`);r.route();r.dispatch();assert.equal(r.run('page.data.number'),2);await r.poll();assert.equal(r.run('page.data.number'),3);assert.deepEqual(r.json('trace'),['sync-end','later'])
 }],
 ['nested parent component handler uses parent incarnation',async r=>{
  r.run(`parent.receive=function(){wx.nextTick(()=>trace.push('parent'));__container_unmount_component(child.__container_component_index);trace.push('sync-end')};child.tap=function(){this.triggerEvent('change',{})}`);r.route('parent');r.dispatch();await r.poll();assert.deepEqual(r.json('trace'),['sync-end','parent'])
 }],
 ['nested parent event restores child frame after return',async r=>{
  r.run(`page.receive=function(){wx.nextTick(()=>trace.push('parent'))};child.tap=function(){this.triggerEvent('change',{});wx.nextTick(()=>trace.push('child'));__container_unmount_component(this.__container_component_index)}`);r.route();r.dispatch();await r.poll();assert.deepEqual(r.json('trace'),['parent'])
 }],
 ['nested events survive mutable public owner alias replacement',async r=>{
  r.run(`__container_run_with_api_owner=function(owner,fn){return fn()};__container_capture_api_owner=()=>null;page.receive=function(){wx.nextTick(()=>trace.push('parent'));__container_unmount_component(child.__container_component_index)};child.tap=function(){this.triggerEvent('change',{})}`);r.route();r.dispatch();await r.poll();assert.deepEqual(r.json('trace'),['parent'])
 }],
 ['throwing nested parent restores source before its later registration',async r=>{
  r.run(`page.receive=function(){wx.nextTick(()=>trace.push('parent'));throw Error('nested')};child.tap=function(){this.triggerEvent('change',{});wx.nextTick(()=>trace.push('child'));__container_unmount_component(this.__container_component_index)}`);r.route();r.dispatch();await r.poll();assert.deepEqual(r.json('trace'),['parent'])
 }],
 ['Page data observer uses actual Page instead of calling child',async r=>{
  r.run(`page.observers={number:function(){wx.nextTick(()=>trace.push('page-observer'))}};child.tap=function(){page.setData({number:1});__container_unmount_component(this.__container_component_index)}`);r.dispatch();await r.poll();assert.deepEqual(r.json('trace'),['page-observer'])
 }],
 ['component data observer uses actual parent instead of calling child',async r=>{
  r.run(`parent.observers={number:function(){wx.nextTick(()=>trace.push('component-observer'))}};child.tap=function(){parent.setData({number:1});__container_unmount_component(this.__container_component_index)}`);r.dispatch();await r.poll();assert.deepEqual(r.json('trace'),['component-observer'])
 }],
 ['component property observer uses actual parent instead of calling child',async r=>{
  r.run(`parent.__container_property_descriptors={number:{observer:function(){wx.nextTick(()=>trace.push('property-observer'))}}};child.tap=function(){__container_component_apply_patch(parent,{number:1},'property.update');__container_unmount_component(this.__container_component_index)}`);r.dispatch();await r.poll();assert.deepEqual(r.json('trace'),['property-observer'])
 }],
 ['relation callback uses actual parent instead of calling child',async r=>{
  r.run(`parent.__container_relation_definitions={edge:{linked:function(){wx.nextTick(()=>trace.push('relation'))}}};child.tap=function(){__container_publish_component_relation_tables(11,[{instance:parent,nodes:{edge:[child]}}],false);__container_unmount_component(this.__container_component_index)}`);r.dispatch();await r.poll();assert.deepEqual(r.json('trace'),['relation'])
 }],
 ['retiring the true parent still drops its queued work',async r=>{
  r.run(`parent.receive=function(){wx.nextTick(()=>trace.push('stale'));__container_unmount_component(parent.__container_component_index)};child.tap=function(){this.triggerEvent('change',{})}`);r.route('parent');r.dispatch();await r.poll();assert.deepEqual(r.json('trace'),[])
 }],
 ['retained bootstrap moves event producers without public scheduler authority',async r=>{
  assert.deepEqual(r.json(`['__container_turn_scheduler','__container_scheduler_timer_ready','__receiver_capture'].map(function(n){return typeof globalThis[n]})`),['undefined','undefined','undefined']);assert.equal(typeof r.run('__container_dispatch_owned_event'),'function');assert.equal(typeof r.run('__container_commit_component_relations'),'function')
 }],
]
for(const engine of ['quickjs','v8'])for(const [name,fn]of cases){try{await fn(realm(engine));results.push({engine,name,status:'pass'})}catch(error){results.push({engine,name,status:'fail',error:String(error?.stack||error)})}}
const report={source:root,total:results.length,passed:results.filter(x=>x.status==='pass').length,failed:results.filter(x=>x.status==='fail').length,results};console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1
