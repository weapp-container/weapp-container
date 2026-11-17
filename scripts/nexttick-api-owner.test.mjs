import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
const root=process.env.NEXTTICK_SOURCE_ROOT || new URL('../',import.meta.url).pathname
const {createAppServiceTestRealm}=await import(pathToFileURL(root+'/scripts/app-service-test-realm.mjs'))
const results=[]
function realm(engine){
 let outcome={status:'success',result:{errMsg:'getSystemInfo:ok'}}
 const r=createAppServiceTestRealm(engine,{__container_host_performance_now:()=>100,__container_host_api_delivery_claim:()=>JSON.stringify(outcome)})
 r.outcome=value=>{outcome=value}
 r.capability=value=>r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.nextTick':'full','wx.requestIdleCallback':'partial','wx.getSystemInfo':value}})
 r.capability('partial')
 r.run(`globalThis.trace=[];globalThis.owners=[];globalThis.receivers=[];Page({});__container_set_current_pages([0],[{index:0,instanceId:11}]);globalThis.page=__container_page_instances['11'];`)
 r.call=()=>r.run(`__container_invoke_page_instance(11,0,'request',[])`)
 r.deliver=(mode)=>{
  const id=r.run(`__container_events.filter(x=>x.type==='api.call'&&x.name==='wx.getSystemInfo').slice(-1)[0].id`)
  if(mode==='ticket')r.run(`__container_resolve_api(${id},null,null,'native-test-ticket')`)
  else if(mode==='legacy-failure')r.run(`__container_resolve_api(${id},null,{errMsg:'getSystemInfo:fail test'})`)
  else r.run(`__container_resolve_api(${id},{errMsg:'getSystemInfo:ok'},null)`)
 }
 r.unload=()=>r.run(`__container_invoke_page_instance(11,0,'onUnload',[])`)
 r.flush=async()=>{for(let i=0;i<4;i++)await Promise.resolve()}
 r.poll=async()=>{
  await r.flush();const command=(action,extra={})=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'turn-scheduler',action,...extra}));command('begin',{limit:64,idleBudgetMs:null})
  try{for(let i=0;i<64;i++){if(!command('task',{allowIdle:false}).called)break;await Promise.resolve()}}finally{command('end')}
 }
 r.define=(throwPrimary=false)=>r.run(`page.request=function(){
  const record=function(name,receiver){trace.push(name);owners.push(__container_capture_api_owner()===page);receivers.push(receiver===options);wx.nextTick(()=>trace.push('tick-'+name));wx.requestIdleCallback(()=>trace.push('idle-'+name),{timeout:0})};
  const options={success:function(value){'use strict';record('success',this);${throwPrimary?"throw Error('primary callback')":''}},fail:function(value){'use strict';record('fail',this);${throwPrimary?"throw Error('primary callback')":''}},complete:function(value){'use strict';record('complete',this)}};
  globalThis.apiPromise=wx.getSystemInfo(options);apiPromise.then(()=>trace.push('resolved'),()=>trace.push('rejected'));
 }`)
 return r
}
const cases=[]
for(const mode of ['ticket-success','ticket-failure','legacy-success','legacy-failure','local-failure']){
 const primary=mode.includes('failure')?'fail':'success'
 for(const throws of [false,true])cases.push([`${mode}${throws?' throwing primary':''} restores Page for primary and complete without changing settlement`,async r=>{
  if(mode==='local-failure')r.capability('unsupported')
  if(mode==='ticket-failure')r.outcome({status:'failure',error:{errMsg:'getSystemInfo:fail test'}})
  r.define(throws);r.call();if(mode!=='local-failure')r.deliver(mode.startsWith('ticket')?'ticket':mode)
  await r.flush();assert.deepEqual(r.json('trace'),[primary,'complete',primary==='fail'?'rejected':'resolved']);assert.deepEqual(r.json('owners'),[true,true]);assert.deepEqual(r.json('receivers'),[true,true]);
  r.unload();await r.poll();await r.poll();assert.deepEqual(r.json('trace'),[primary,'complete',primary==='fail'?'rejected':'resolved'])
 }])
}
cases.push(['claimed retired delivery preserves native admission and does not settle',async r=>{
 r.outcome({status:'retired'});r.define();r.call();r.deliver('ticket');await r.flush();assert.deepEqual(r.json('trace'),[]);await r.poll();assert.deepEqual(r.json('trace'),[])
}])
cases.push(['callback owner survives replacement public owner aliases without leaking authority',async r=>{
 r.define();r.call();r.run(`__container_run_with_api_owner=(owner,fn)=>fn();__container_capture_api_owner=()=>null`);r.deliver('ticket');await r.flush();r.unload();await r.poll();await r.poll();assert.deepEqual(r.json('trace'),['success','complete','resolved']);assert.equal(r.run(`typeof __container_turn_scheduler`),'undefined');assert.equal(r.run(`typeof __container_deliver_api_callback`),'undefined');assert.equal(r.run(`__container_invoke_api_callback.length`),3);assert.deepEqual(r.json(`Object.keys(__container_api_pending).map(id=>Object.keys(__container_api_pending[id]))`),[])
}])
cases.push(['API delivery keeps callback admission after unload and only retires queued owner work',async r=>{
 r.define();r.call();r.unload();r.deliver('legacy-success');await r.flush();assert.deepEqual(r.json('trace'),['success','complete','resolved']);await r.poll();await r.poll();assert.deepEqual(r.json('trace'),['success','complete','resolved'])
}])
cases.push(['local async result success carries the invoking Page without changing callbacks or Promise',async r=>{
 r.run(`page.request=function(){const options={success:function(){trace.push('success');receivers.push(this===options);wx.nextTick(()=>trace.push('stale'))},complete:function(){trace.push('complete')}};__container_async_result(options,{value:1},null).then(()=>trace.push('resolved'))}`);r.call();await r.flush();assert.deepEqual(r.json('trace'),['success','complete','resolved']);assert.deepEqual(r.json('receivers'),[true]);r.unload();await r.poll();assert.deepEqual(r.json('trace'),['success','complete','resolved'])
}])
cases.push(['callback completion restores realm context for unrelated application Promise continuation',async r=>{
 r.run(`page.request=function(){wx.getSystemInfo({success:function(){wx.nextTick(()=>trace.push('stale'))}}).then(()=>wx.nextTick(()=>trace.push('realm-continuation')))}`);r.call();r.deliver('ticket');await r.flush();r.unload();await r.poll();assert.deepEqual(r.json('trace'),['realm-continuation'])
}])
cases.push(['live callback work is deferred exactly once and pending record exposes no owner token',async r=>{
 r.define();r.call();assert.deepEqual(r.json('Object.keys(__container_api_pending[1]).sort()'),['name','options','reject','resolve']);r.deliver('ticket');await r.flush();assert.deepEqual(r.json('trace'),['success','complete','resolved']);await r.poll();await r.poll();assert.deepEqual(r.json('trace'),['success','complete','resolved','tick-success','tick-complete','idle-success','idle-complete']);await r.poll();assert.equal(r.json('trace').length,7)
}])
for(const engine of ['quickjs','v8'])for(const [name,check]of cases){const r=realm(engine);try{await check(r);results.push({engine,name,status:'pass'})}catch(error){results.push({engine,name,status:'fail',trace:r.json('trace'),owners:r.json('owners'),error:String(error.stack||error)})}}
const report={source:root,total:results.length,passed:results.filter(x=>x.status==='pass').length,failed:results.filter(x=>x.status==='fail').length,results};console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1
