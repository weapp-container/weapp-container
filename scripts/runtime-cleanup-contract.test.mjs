// Pure Node VM evidence for the two exact native bootstrap source compositions.
// Native route validation and actual native engine execution are outside this test.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL,fileURLToPath} from 'node:url';
const source=process.argv[2] || fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
const {createAppServiceTestRealm}=await import(pathToFileURL(source+'/scripts/app-service-test-realm.mjs'));
const names=['wx.onBeforeAppRoute','wx.offBeforeAppRoute','wx.onAppRoute','wx.offAppRoute','wx.rewriteRoute'];
const caps=Object.fromEntries([...names,'wx.nextTick','wx.requestIdleCallback','wx.cancelIdleCallback'].map(n=>[n,'full']));
const results=[];
function realm(engine){const clock={now:100};const r=createAppServiceTestRealm(engine,{__container_host_performance_now:()=>clock.now});r.clock=clock;r.install=(extra={})=>r.transports.installHostEnvironment({kind:'capabilities',capabilities:{...caps,...extra}});r.install();r.run('globalThis.trace=[]');r.dispatch=kind=>r.transports.dispatchRouteNotification(kind,'{}');r.begin=(budget=null)=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'turn-scheduler',action:'begin',idleBudgetMs:budget,limit:64}));r.task=(allowIdle=false)=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'turn-scheduler',action:'task',allowIdle}));r.end=()=>r.transports.captureReceiverIncarnations({kind:'turn-scheduler',action:'end'});r.poll=async()=>{await Promise.resolve();r.begin();try{for(let i=0;i<64;i++){if(!r.task().called)break;await Promise.resolve();}}finally{r.end()}};return r}
async function test(engine,name,fn){try{await fn(realm(engine));results.push({engine,name,passed:true})}catch(e){results.push({engine,name,passed:false,error:String(e.stack||e)})}}
for(const engine of ['quickjs','v8']){
 await test(engine,'cleanup full grades are separate from incomplete producer grades',r=>{
  r.install({'wx.onBeforeAppRoute':'partial','wx.onAppRoute':'partial','wx.requestIdleCallback':'partial'});
  assert.deepEqual(r.json(`${JSON.stringify([...names,'wx.requestIdleCallback','wx.cancelIdleCallback'])}.map(n=>__container_capabilities[n])`),['partial','full','partial','full','partial','partial','full']);
  r.install({'wx.offBeforeAppRoute':'partial','wx.offAppRoute':'partial','wx.cancelIdleCallback':'partial'});
  assert.deepEqual(r.json(`[__container_capabilities['wx.offBeforeAppRoute'],__container_capabilities['wx.offAppRoute'],__container_capabilities['wx.cancelIdleCallback']]`),['partial','partial','partial']);
 });
 for(const [on,off,kind] of [['onBeforeAppRoute','offBeforeAppRoute','before'],['onAppRoute','offAppRoute','after']]){
  await test(engine,off+' removes exact real private registration, dedupe, unknown and all',r=>{
   assert.deepEqual(r.json(`(()=>{globalThis.first=()=>trace.push('first');globalThis.second=()=>trace.push('second');return [wx.${on}(first)===undefined,wx.${on}(first)===undefined,wx.${on}(second)===undefined,wx.${off}(()=>{})===undefined]})()`),[true,true,true,true]);
   r.dispatch(kind);assert.deepEqual(r.json('trace'),['first','second']);assert.equal(r.run(`wx.${off}(first)`),undefined);r.dispatch(kind);assert.deepEqual(r.json('trace'),['first','second','second']);assert.equal(r.run(`wx.${off}()`),undefined);r.dispatch(kind);assert.deepEqual(r.json('trace'),['first','second','second']);
  });
  await test(engine,off+' during snapshot affects future events only',r=>{
   r.run(`globalThis.second=()=>trace.push('second');wx.${on}(()=>{trace.push('first');wx.${off}(second)});wx.${on}(second)`);
   r.dispatch(kind);r.dispatch(kind);assert.deepEqual(r.json('trace'),['first','second','first']);
  });
  await test(engine,off+' revocation cancels remaining captured batch and clears registrations',r=>{
   r.context.revoke=()=>r.install({['wx.'+off]:'unsupported'});
   r.run(`globalThis.savedOff=wx.${off};wx.${on}(()=>{trace.push('first');revoke()});wx.${on}(()=>trace.push('stale'))`);
   r.dispatch(kind);assert.deepEqual(r.json('trace'),['first']);assert.throws(()=>r.run('savedOff()'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');
   r.run(`__container_capabilities['wx.${on}']='full';__container_capabilities['wx.${off}']='full'`);assert.throws(()=>r.run(`wx.${on}(()=>{})`),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');
   r.install();r.dispatch(kind);assert.deepEqual(r.json('trace'),['first']);
  });
  for(const attack of ['direct-off','direct-on','unrelated-counterpart']){
   await test(engine,off+' retains same private owner after stale descriptor '+attack,r=>{
    r.run(`globalThis.first=()=>trace.push('first');globalThis.savedOn=wx.${on};globalThis.savedOff=wx.${off};wx.${on}(first)`);
    const desc=attack==='direct-off'?{name:'wx.'+off,kind:'subscription',owner:'host'}:attack==='direct-on'?{name:'wx.'+on,kind:'subscription',owner:'host',counterpart:'wx.'+off}:{name:'wx.onStaleOther',kind:'subscription',owner:'host',counterpart:'wx.'+off};
    r.context.hostConfig={apis:[desc],objectApis:[]};assert.equal(r.run('__container_install_host_services(hostConfig)'),true);
    assert.equal(r.run(`wx.${off}(first)`),undefined);r.dispatch(kind);assert.deepEqual(r.json('trace'),[], 'cleanup must remove the actual private registration');
    r.run(`wx.${on}(first)`);r.dispatch(kind);assert.deepEqual(r.json('trace'),['first']);assert.deepEqual(r.json(`[wx.${on}===savedOn,wx.${off}===savedOff]`),[true,true]);
   });
  }
 }
 await test(engine,'cancel removes real pending ID, absent and fired IDs are void no-ops',async r=>{
  r.run(`globalThis.id=wx.requestIdleCallback(()=>trace.push('canceled'),{timeout:0});wx.cancelIdleCallback(id);wx.cancelIdleCallback(id);wx.cancelIdleCallback(99999);globalThis.fired=wx.requestIdleCallback(()=>trace.push('fired'),{timeout:0})`);await r.poll();assert.deepEqual(r.json('trace'),['fired']);assert.equal(r.run('wx.cancelIdleCallback(fired)'),undefined);await r.poll();assert.deepEqual(r.json('trace'),['fired']);
 });
 await test(engine,'cancel of captured idle wins before its timeout turn and never cancels nextTick',async r=>{
  r.run(`globalThis.id=wx.requestIdleCallback(()=>trace.push('idle'),{timeout:0});wx.nextTick(()=>{trace.push('tick');Promise.resolve().then(()=>wx.cancelIdleCallback(id))});wx.cancelIdleCallback(2)`);await r.poll();assert.deepEqual(r.json('trace'),['tick']);
 });
 await test(engine,'cancel revocation remains independent and borrowed alias cannot bypass it',async r=>{
  r.run(`globalThis.id=wx.requestIdleCallback(()=>trace.push('still admitted'),{timeout:0});globalThis.oldCancel=wx.cancelIdleCallback`);r.install({'wx.cancelIdleCallback':'unsupported'});assert.throws(()=>r.run('oldCancel(id)'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');await r.poll();assert.deepEqual(r.json('trace'),['still admitted']);
 });
 await test(engine,'request revocation removes captured idle records without revival',async r=>{
  r.run(`wx.requestIdleCallback(()=>trace.push('stale'),{timeout:0})`);r.begin();r.install({'wx.requestIdleCallback':'unsupported'});r.install();assert.equal(r.task().called,false);r.end();await r.poll();assert.deepEqual(r.json('trace'),[]);
 });
 await test(engine,'cancel remains independently full with unavailable request producer',r=>{
  r.install({'wx.requestIdleCallback':'unsupported'});assert.equal(r.run("__container_capabilities['wx.cancelIdleCallback']"),'full');assert.equal(r.run('wx.cancelIdleCallback(99999)'),undefined);assert.throws(()=>r.run('wx.requestIdleCallback(()=>{})'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');
 });
 await test(engine,'stale native descriptor cannot replace real cancellation ownership',async r=>{
  r.run(`globalThis.id=wx.requestIdleCallback(()=>trace.push('stale'),{timeout:0});globalThis.oldCancel=wx.cancelIdleCallback`);r.context.config={apis:[{name:'wx.cancelIdleCallback',kind:'subscription',owner:'host'}],objectApis:[]};r.run('__container_install_host_services(config)');assert.equal(r.run('oldCancel===wx.cancelIdleCallback'),true);r.run('wx.cancelIdleCallback(id)');await r.poll();assert.deepEqual(r.json('trace'),[]);
 });
 await test(engine,'captured receiver retirement and same-ID replacement cannot revive idle work',async r=>{
  r.run(`Page({});__container_set_current_pages([0],[{index:0,instanceId:11}]);globalThis.page=__container_page_instances['11'];page.queue=()=>{globalThis.id=wx.requestIdleCallback(()=>trace.push('old'),{timeout:0})};__container_invoke_page_instance(11,0,'queue',[])`);r.begin();r.run(`__container_invoke_page_instance(11,0,'onUnload',[]);delete __container_page_instances['11'];__container_set_current_pages([0],[{index:0,instanceId:11}]);wx.cancelIdleCallback(id)`);assert.equal(r.task().called,false);r.end();await r.poll();assert.deepEqual(r.json('trace'),[]);
 });
}
const report={source,kind:'pure-node-production-source-composition',actualNativeEngineExecuted:false,actualHostOrDeviceExecuted:false,availabilityDelta:0,acceptanceDelta:0,tests:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,results};console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
