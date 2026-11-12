import assert from 'node:assert/strict'
import test from 'node:test'
import {pathToFileURL} from 'node:url'
const root=process.env.FRAMEWORK_BOUNDARY_SOURCE_ROOT || new URL('../',import.meta.url).pathname
const {createAppServiceTestRealm}=await import(pathToFileURL(root+'/scripts/app-service-test-realm.mjs'))
function fixture(engine){
 const r=createAppServiceTestRealm(engine)
 r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.nextTick':'partial','wx.requestIdleCallback':'partial','wx.cancelIdleCallback':'partial','setData':'partial','wx.navigateTo':'partial','wx.onError':'partial','wx.offError':'partial','wx.onAppShow':'partial','wx.onAppRoute':'partial','wx.offAppRoute':'partial'}})
 r.run(`globalThis.trace=[];Page({data:{value:0}});Page({data:{value:0}});__container_set_current_pages([0,1],[{index:0,instanceId:11},{index:1,instanceId:12}]);globalThis.a=__container_page_instances['11'];globalThis.b=__container_page_instances['12'];`)
 r.flush=async()=>{for(let i=0;i<4;i++)await Promise.resolve()}
 r.invoke=who=>r.run(`__container_invoke_page_instance(${who==='a'?11:12},${who==='a'?0:1},'start',[])`)
 r.retire=who=>r.run(`__container_invoke_page_instance(${who==='a'?11:12},${who==='a'?0:1},'onUnload',[])`)
 r.poll=async()=>{await r.flush();const call=(action,extra={})=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'turn-scheduler',action,...extra}));call('begin',{limit:64,idleBudgetMs:null});try{for(let i=0;i<64;i++){if(!call('task',{allowIdle:false}).called)break;await r.flush()}}finally{call('end')}}
 r.channel=async()=>{r.run(`a.start=function(){wx.navigateTo({url:'pages/target',success:function(value){globalThis.channel=value.eventChannel}})}`);r.invoke('a');const id=r.run(`__container_events.filter(x=>x.type==='api.call'&&x.name==='wx.navigateTo').at(-1).id`);assert.equal(r.transports.bindEventChannel(id,12),true);r.run(`__container_resolve_api(${id},{errMsg:'navigateTo:ok'},null)`);await r.flush()}
 return r
}
for(const engine of ['quickjs','v8']){
 test(`${engine}: setData completion preserves microtask timing, strict this, zero arguments and caller restoration`,async()=>{
  const r=fixture(engine);r.run(`a.start=function(){trace.push('before');b.setData({value:1},function(){'use strict';trace.push(['completion',this===undefined,arguments.length,__container_capture_api_owner()===b]);wx.nextTick(()=>trace.push('b-task'))});trace.push(['after',__container_capture_api_owner()===a]);wx.nextTick(()=>trace.push('a-task'))}`);r.invoke('a');assert.deepEqual(r.json('trace'),['before',['after',true]]);await r.flush();assert.deepEqual(r.json('trace'),['before',['after',true],['completion',true,0,true]]);r.retire('a');await r.poll();assert.deepEqual(r.json('trace'),['before',['after',true],['completion',true,0,true],'b-task'])
 })
 test(`${engine}: setData completion remains admitted after receiver unload while its scheduled work retires`,async()=>{
  const r=fixture(engine);r.run(`a.start=function(){this.setData({value:1},function(){trace.push('completion');wx.nextTick(()=>trace.push('stale'))})}`);r.invoke('a');r.retire('a');await r.flush();assert.deepEqual(r.json('trace'),['completion']);await r.poll();assert.deepEqual(r.json('trace'),['completion'])
 })
 test(`${engine}: throwing setData completion still rejects its Promise and restores realm scope`,async()=>{
  const r=fixture(engine);r.run(`globalThis.originalThen=Promise.prototype.then;Promise.prototype.then=function(){const result=Reflect.apply(originalThen,this,arguments);globalThis.completionPromise=result;return result};a.start=function(){this.setData({},function(){wx.nextTick(()=>trace.push('stale'));throw Error('setData completion')})}`);r.invoke('a');const pending=r.run('completionPromise');r.run('Promise.prototype.then=originalThen');await assert.rejects(pending,/setData completion/);r.retire('a');r.run(`wx.nextTick(()=>trace.push('realm'))`);await r.poll();assert.deepEqual(r.json('trace'),['realm'])
 })
 test(`${engine}: EventChannel queued once listener retires before recursive emit and keeps registration owner`,async()=>{
  const r=fixture(engine);await r.channel();r.run(`channel.emit('queued',7);b.start=function(){channel.once('queued',function(value){'use strict';trace.push([value,this===channel,__container_capture_api_owner()===b]);channel.emit('queued',8);wx.nextTick(()=>trace.push('b-task'))});trace.push(['restored',__container_capture_api_owner()===b])}`);r.invoke('b');assert.deepEqual(r.json('trace'),[[7,true,true],['restored',true]]);r.retire('b');await r.poll();assert.deepEqual(r.json('trace'),[[7,true,true],['restored',true]])
 })
 test(`${engine}: throwing EventChannel listener reports once, preserves snapshot mutation, and restores the emitter`,async()=>{
  const r=fixture(engine);await r.channel();r.run(`wx.onError(function(message){trace.push(['error',message,__container_capture_api_owner()===null]);wx.nextTick(()=>trace.push('realm-error'))});a.start=function(){channel.on('ping',function(){trace.push(['listener',this===channel,__container_capture_api_owner()===a]);channel.off('ping');wx.nextTick(()=>trace.push('stale'));throw Error('channel callback')});channel.on('ping',function(){trace.push('removed-before-entry')})}`);r.invoke('a');r.run(`b.start=function(){channel.emit('ping');trace.push(['emitter',__container_capture_api_owner()===b]);wx.nextTick(()=>trace.push('b-task'))}`);r.invoke('b');r.retire('a');await r.poll();assert.deepEqual(r.json('trace'),[['listener',true,true],['error','channel callback',true],['emitter',true],'realm-error','b-task'])
 })
 for(const kind of ['lifecycle','route'])test(`${engine}: nested ${kind} realm notification restores a Page caller`,async()=>{
  const r=fixture(engine);r.context.deliver=()=>kind==='lifecycle'?r.transports.dispatchLifecycleNotification('show',{}):r.transports.dispatchRouteNotification('after',JSON.stringify({path:'pages/target'}));r.run(`${kind==='lifecycle'?'wx.onAppShow':'wx.onAppRoute'}(function(){trace.push(['realm-listener',this===globalThis,__container_capture_api_owner()===null]);wx.nextTick(()=>trace.push('realm-task'))});a.start=function(){deliver();trace.push(['caller',__container_capture_api_owner()===a]);wx.nextTick(()=>trace.push('stale'))}`);r.invoke('a');r.retire('a');await r.poll();assert.deepEqual(r.json('trace'),[['realm-listener',true,true],['caller',true],'realm-task'])
 })
 test(`${engine}: error listener keeps root this and original payload, isolates listener throws, and restores failing Page`,async()=>{
  const r=fixture(engine);r.run(`wx.onError(function(value){trace.push(['error',value,this===globalThis,__container_capture_api_owner()===null]);wx.nextTick(()=>trace.push('realm-error'));throw Error('listener failure')});a.start=function(){wx.nextTick(function(){throw Error('page failure')})}`);r.invoke('a');await r.poll();r.retire('a');await r.poll();assert.deepEqual(r.json('trace'),[['error','page failure',true,true],'realm-error']);assert.equal(r.run(`__container_errors.filter(x=>x.source==='error-listener'&&x.message==='listener failure').length`),1)
 })
}
