import assert from 'node:assert/strict'
import test from 'node:test'
import {pathToFileURL} from 'node:url'
const root=process.env.CROSS_CANVAS_SOURCE_ROOT || new URL('../',import.meta.url).pathname
const {createAppServiceTestRealm}=await import(pathToFileURL(root+'/scripts/app-service-test-realm.mjs'))
function fixture(engine){
 const r=createAppServiceTestRealm(engine,{__container_host_api_delivery_claim:()=>JSON.stringify({status:'success',result:{errMsg:'getSystemInfo:ok'}})})
 r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.nextTick':'partial','wx.createCanvasContext':'full','wx.canvas.draw':'full','wx.getSystemInfo':'partial','wx.onError':'partial','wx.offError':'partial'}})
 r.transports.dispatchLifecycleNotification('session',{})
 r.run(`globalThis.trace=[];Page({data:{number:0,showCanvas:true}});Page({});__container_set_current_pages([0,1],[{index:0,instanceId:11},{index:1,instanceId:12}]);globalThis.page=__container_page_instances['11'];
 __container_registration_module_id='module:panel.js';__container_managed_component_modules[__container_registration_module_id]=true;globalThis.definition=Component({methods:{}});__container_registration_module_id=null;
 globalThis.component=__container_clone_component_instance(definition,{scopeId:'panel',moduleId:'module:panel.js',pageId:11,parentScopeId:null,ownerScopeId:null});`)
 r.capture=(after='0')=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'canvas-draw-requests',after})).requests
 r.deliver=(ticket,error=null)=>r.transports.dispatchLifecycleNotification('ownedCanvas',{ticket,result:{canvasId:'shared',width:3,height:2},error})
 r.unload=()=>r.run(`__container_invoke_page_instance(11,0,'onUnload',[])`)
 r.effects=()=>{const batch=r.json('__container_drain_events()');assert.equal(r.transports.installHostEnvironment({kind:'effects-ack',drainId:batch.__containerDrainId}),true);return batch.events}
 r.flush=async()=>{for(let i=0;i<4;i++)await Promise.resolve()}
 r.poll=async()=>{await r.flush();const command=(action,extra={})=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'turn-scheduler',action,...extra}));command('begin',{limit:64,idleBudgetMs:null});try{for(let i=0;i<64;i++){if(!command('task',{allowIdle:false}).called)break;await Promise.resolve()}}finally{command('end')}}
 return r
}
for(const engine of ['quickjs','v8']){
 test(`${engine}: Canvas completion preserves unbound this and exactly-once settlement, then nextTick updates data in a later turn`,async()=>{
  const r=fixture(engine);r.run(`globalThis.ctx=wx.createCanvasContext('shared',component);globalThis.pending=ctx.draw(false,function(value){'use strict';trace.push(['complete',this===undefined,__container_capture_api_owner()===component]);component.setData({number:2});wx.nextTick(()=>{component.setData({number:3});trace.push(['later',component.data.number])})})`)
  const draw=r.capture()[1];assert.equal(r.deliver(draw.ticket),true);assert.equal(r.deliver(draw.ticket),true);assert.equal((await r.run('pending')).width,3);assert.deepEqual(r.json('trace'),[['complete',true,true]]);assert.equal(r.run('component.data.number'),2)
  await r.poll();await r.poll();assert.deepEqual(r.json('trace'),[['complete',true,true],['later',3]]);assert.equal(r.run('component.data.number'),3)
 })
 test(`${engine}: live Canvas callback nextTick retires with the actual component instead of becoming realm work`,async()=>{
  const r=fixture(engine);r.run(`globalThis.ctx=wx.createCanvasContext('shared',component);ctx.draw(false,function(){trace.push('complete');wx.nextTick(()=>trace.push('stale'))})`);r.deliver(r.capture()[1].ticket);r.run(`__container_unmount_component(component.__container_component_index)`);await r.poll();assert.deepEqual(r.json('trace'),['complete'])
 })
 test(`${engine}: Canvas callback native API delivery keeps the component incarnation across its framework microtask`,async()=>{
  const r=fixture(engine);r.run(`globalThis.ctx=wx.createCanvasContext('shared',component);ctx.draw(false,function(){wx.getSystemInfo({success:function(){trace.push('success');wx.nextTick(()=>trace.push('stale-success'))},complete:function(){trace.push('complete');wx.nextTick(()=>trace.push('stale-complete'))}})})`)
  r.deliver(r.capture()[1].ticket);const id=r.run(`__container_events.filter(x=>x.type==='api.call'&&x.name==='wx.getSystemInfo').at(-1).id`);r.run(`__container_resolve_api(${id},null,null,'actual-delivery-entry')`);await r.flush();r.run(`__container_unmount_component(component.__container_component_index)`);await r.poll();assert.deepEqual(r.json('trace'),['success','complete'])
 })
 test(`${engine}: nextTick Canvas draw and public setData effects coexist until the ordinary acknowledged drain`,async()=>{
  const r=fixture(engine);r.run(`globalThis.ctx=wx.createCanvasContext('shared',page);page.schedule=function(){wx.nextTick(()=>{page.setData({showCanvas:false});ctx.fillRect(0,0,1,1);ctx.draw(false,()=>trace.push('complete'));trace.push('later')})};__container_invoke_page_instance(11,0,'schedule',[])`)
  assert.equal(r.capture().filter(x=>x.kind==='draw').length,0);await r.poll();const [draw]=r.capture().filter(x=>x.kind==='draw');assert.deepEqual(draw.options.commands,[{op:'fillRect',args:[0,0,1,1]}]);const events=r.effects();assert.ok(events.some(x=>x.type==='data.patch.batch'&&x.patches.some(p=>p.path==='showCanvas'&&p.value===false)));assert.equal(r.deliver(draw.ticket),true);assert.deepEqual(r.json('trace'),['later','complete'])
 })
 test(`${engine}: throwing Canvas completion reports once, resolves once and restores the frame before unrelated realm work`,async()=>{
  const r=fixture(engine);r.run(`wx.onError(value=>trace.push('error:'+value));globalThis.ctx=wx.createCanvasContext('shared',page);globalThis.pending=ctx.draw(false,function(){trace.push('complete');wx.nextTick(()=>trace.push('stale'));throw Error('canvas callback')})`)
  const ticket=r.capture()[1].ticket;r.deliver(ticket);r.deliver(ticket);assert.equal((await r.run('pending')).canvasId,'shared');r.unload();r.run(`wx.nextTick(()=>trace.push('realm'))`);await r.poll();assert.deepEqual(r.json('trace'),['complete','error:canvas callback','realm'])
 })
 test(`${engine}: poisoned public owner aliases cannot turn Canvas callback work into a surviving realm task`,async()=>{
  const r=fixture(engine);r.run(`globalThis.ctx=wx.createCanvasContext('shared',page);ctx.draw(false,function(){wx.nextTick(()=>trace.push('stale'))});__container_run_with_api_owner=(owner,fn)=>fn();__container_capture_api_owner=()=>null`);r.deliver(r.capture()[1].ticket);r.unload();await r.poll();assert.deepEqual(r.json('trace'),[])
 })
 test(`${engine}: Canvas queue capacity is retained during callback reentry and does not leak scheduler owner`,async()=>{
  const r=fixture(engine);r.run(`globalThis.ctx=wx.createCanvasContext('shared',page);ctx.draw(false,function(){ctx.fillRect(0,0,1,1);try{ctx.draw()}catch(e){trace.push(e.code)}wx.nextTick(()=>trace.push('stale'))});for(let i=0;i<254;i++)ctx.draw()`);const full=r.capture();assert.equal(full.length,256);r.deliver(full[1].ticket);r.unload();await r.poll();assert.deepEqual(r.json('trace'),['ERR_RESOURCE_LIMIT'])
 })
 test(`${engine}: Canvas Promise continuations preserve existing realm scope after private callback exit`,async()=>{
  const r=fixture(engine);r.run(`globalThis.ctx=wx.createCanvasContext('shared',page);ctx.draw(false,function(){wx.nextTick(()=>trace.push('stale'))}).then(()=>wx.nextTick(()=>trace.push('realm-promise')))`);r.deliver(r.capture()[1].ticket);await r.flush();r.unload();await r.poll();assert.deepEqual(r.json('trace'),['realm-promise'])
 })
}
