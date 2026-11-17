import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppServiceTestRealm} from './app-service-test-realm.mjs';

// Production native bootstrap compositions in Node VM. Delivery values below
// exercise only the private transport; they are not synthesized pixel evidence.
function fixture(engine, pages=true) {
  const r=createAppServiceTestRealm(engine);
  r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.createCanvasContext':'full','wx.canvas.draw':'full'}});
  r.transports.dispatchLifecycleNotification('session',{});
  if(pages) r.run(`Page({});Page({});__container_set_current_pages([0,1],[
    {index:0,instanceId:11,route:'pages/first'},{index:1,instanceId:12,route:'pages/second'}]);
    globalThis.first=__container_page_instances['11'];globalThis.second=__container_page_instances['12'];
    __container_registration_module_id='module:panel.js';__container_managed_component_modules[__container_registration_module_id]=true;
    globalThis.definition=Component({methods:{}});__container_registration_module_id=null;
    globalThis.component=__container_clone_component_instance(definition,{scopeId:'panel',moduleId:'module:panel.js',pageId:11,parentScopeId:null,ownerScopeId:null});`);
  r.capture=(after='0')=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'canvas-draw-requests',after})).requests;
  r.deliver=(ticket,result={canvasId:'shared',width:3,height:2},error=null)=>r.transports.dispatchLifecycleNotification('ownedCanvas',{ticket,result,error});
  return r;
}
function events(r) {
  const batch=r.json('__container_drain_events()');
  assert.equal(r.transports.installHostEnvironment({kind:'effects-ack',drainId:batch.__containerDrainId}),true);
  return batch.events;
}
for(const engine of ['quickjs','v8']) {
  test(`${engine}: Canvas captures real receivers and exact private incarnation proof`,()=>{
    const r=fixture(engine);
    r.run(`globalThis.a=wx.createCanvasContext('shared',component);globalThis.b=wx.createCanvasContext('shared');
      component.scopeId='forged';component.__container_page_id='12';a.fillRect(0,0,1,1);a.draw();`);
    const [componentContext,pageContext,draw]=r.capture();
    assert.deepEqual(componentContext.owner,{pageId:'11',scopeId:'panel'});
    assert.deepEqual(pageContext.owner,{pageId:'12',scopeId:null});
    const proof=JSON.parse(r.transports.captureReceiverIncarnations({kind:'selector-query-receivers',pageId:'11',scopes:['panel']}));
    assert.deepEqual(componentContext.receivers,proof);assert.deepEqual(draw.receivers,proof);
    assert.equal(draw.context,componentContext.context);assert.equal(draw.ticket,`canvas:${draw.sequence}`);
    assert.equal(r.run('typeof __container_owned_canvases'),'undefined');assert.equal(events(r).length,0);
  });
  test(`${engine}: public API events and mutable aliases cannot mint owned Canvas requests`,()=>{
    const r=fixture(engine);
    r.run(`__container_events.push({type:'api.call',name:'wx.canvas.draw',owner:{pageId:'11',scopeId:'panel'},context:'1',receivers:{pageToken:'1',scopes:{panel:'2'}}});`);
    assert.deepEqual(r.capture(),[]);
    r.run(`globalThis.ctx=wx.createCanvasContext('shared',component);
      __container_events=[];__container_page_instances=Object.create(null);__container_component_scopes=Object.create(null);
      __container_api_owner_for_observer=()=>({pageId:'12'});__container_run_with_api_owner=()=>{throw Error('forged')};ctx.fillRect(0,0,1,1);ctx.draw();`);
    const requests=r.capture();assert.equal(requests.length,2);assert.deepEqual(requests[1].owner,{pageId:'11',scopeId:'panel'});
  });
  test(`${engine}: pre-Page independent contexts remain independent after a Page appears`,()=>{
    const r=fixture(engine,false);r.run(`globalThis.early=wx.createCanvasContext('shared');`);
    r.run(`Page({});__container_set_current_pages([0],[{index:0,instanceId:11,route:'pages/first'}]);early.fillRect(0,0,1,1);early.draw();`);
    assert.deepEqual(r.capture(),[]);const publicEvents=events(r);assert.equal(publicEvents.length,1);assert.equal(publicEvents[0].name,'wx.canvas.draw');
    r.run(`globalThis.late=wx.createCanvasContext('shared');late.draw();`);assert.equal(r.capture().length,2);
  });
  test(`${engine}: invalid explicit or current receiver fails closed without fallback`,()=>{
    const r=fixture(engine);
    const codes=r.json(`(()=>{const values=[];for(const receiver of [{scopeId:'panel',pageId:11},Object.create(component),null]){
      const ctx=wx.createCanvasContext('shared',receiver);try{ctx.draw()}catch(e){values.push(e.code)}}
      __container_run_with_api_owner({pageId:12},()=>{const ctx=wx.createCanvasContext('shared');try{ctx.draw()}catch(e){values.push(e.code)}});return values})()`);
    assert.deepEqual(codes,Array(4).fill('ERR_CANCELLED'));assert.deepEqual(r.capture(),[]);assert.deepEqual(events(r),[]);
  });
  test(`${engine}: same scope replacement cannot revive an old context`,()=>{
    const r=fixture(engine);r.run(`globalThis.old=wx.createCanvasContext('shared',component);`);const [old]=r.capture();
    r.run(`globalThis.replacement=__container_clone_component_instance(definition,{scopeId:'panel',moduleId:'module:panel.js',pageId:11,parentScopeId:null,ownerScopeId:null});
      globalThis.code='';try{old.draw()}catch(e){code=e.code}globalThis.fresh=wx.createCanvasContext('shared',replacement);fresh.draw();`);
    assert.equal(r.run('code'),'ERR_CANCELLED');const [fresh,draw]=r.capture(old.sequence);
    assert.notEqual(fresh.receivers.scopes.panel,old.receivers.scopes.panel);assert.equal(draw.context,fresh.context);
  });
  test(`${engine}: owned command snapshots and request cursor stay immutable`,()=>{
    const r=fixture(engine);r.run(`globalThis.ctx=wx.createCanvasContext('shared',first);const dash=[2,3];ctx.setLineDash(dash,1);dash[0]=99;ctx.draw(true);`);
    const [registration,draw]=r.capture();assert.deepEqual(draw.options.commands,[{op:'setLineDash',args:[[2,3],1]}]);
    draw.options.commands[0].args[0][0]=77;assert.equal(r.capture()[1].options.commands[0].args[0][0],2);
    assert.deepEqual(r.capture(registration.sequence).map(item=>item.sequence),[draw.sequence]);assert.deepEqual(r.capture(draw.sequence),[]);
  });
  test(`${engine}: private completion restores receiver owner and is idempotent`,async()=>{
    const r=fixture(engine);r.run(`globalThis.trace=[];globalThis.ctx=wx.createCanvasContext('shared',component);
      globalThis.result=ctx.draw(false,function(value){'use strict';trace.push([this===undefined,__container_capture_api_owner()===component,value.canvasId])});`);
    const draw=r.capture()[1];assert.equal(r.deliver(draw.ticket),true);assert.equal(r.deliver(draw.ticket),true);
    assert.deepEqual(r.json('trace'),[[true,true,'shared']]);assert.equal((await r.run('result')).width,3);
    assert.equal(r.deliver('canvas:999999'),false);
  });
  test(`${engine}: retired receiver suppresses callbacks and realm retirement settles pending draws`,async()=>{
    const r=fixture(engine);r.run(`globalThis.called=0;globalThis.ctx=wx.createCanvasContext('shared',component);globalThis.result=ctx.draw(false,()=>called++);`);
    const draw=r.capture()[1];r.run(`__container_unmount_component(component.__container_component_index)`);
    assert.equal(r.deliver(draw.ticket),true);assert.equal(await r.run(`result.then(()=>'',e=>e.code)`),'ERR_CANCELLED');assert.equal(r.run('called'),0);
    r.run(`globalThis.other=wx.createCanvasContext('shared',second);globalThis.pending=other.draw();`);
    assert.equal(r.transports.dispatchLifecycleNotification('retire',{}),true);
    assert.equal(await r.run(`pending.then(()=>'',e=>e.code)`),'ERR_CANCELLED');assert.deepEqual(r.capture(draw.sequence),[]);
  });
  test(`${engine}: private queue count rejection preserves the last admitted command batch`,()=>{
    const r=fixture(engine);r.run(`globalThis.ctx=wx.createCanvasContext('shared',first);for(let i=0;i<255;i++)ctx.draw();ctx.fillRect(0,0,1,1);
      globalThis.code='';try{ctx.draw()}catch(e){code=e.code}`);
    const batch=r.capture();assert.equal(batch.length,256);assert.equal(r.run('code'),'ERR_RESOURCE_LIMIT');
    for(const request of batch.filter(item=>item.kind==='draw'))assert.equal(r.deliver(request.ticket),true);
    assert.deepEqual(r.capture(batch.at(-1).sequence),[]);r.run('ctx.draw()');
    assert.deepEqual(r.capture()[0].options.commands,[{op:'fillRect',args:[0,0,1,1]}]);
  });
  test(`${engine}: prototype and serializer poisoning never exposes private Canvas records`,()=>{
    const r=fixture(engine);r.run(`globalThis.hooks=0;const define=Object.defineProperty;const poison=function(){hooks++;throw Error('guest hook')};
      for(const key of ['sequence','bytes','failure','toJSON'])define(Object.prototype,key,{get:poison,set:poison,configurable:true});
      Array.prototype[Symbol.iterator]=poison;JSON.stringify=poison;JSON.parse=poison;Object.create=poison;Object.setPrototypeOf=poison;
      Object.defineProperty=poison;Object.getOwnPropertyDescriptor=poison;Reflect.ownKeys=poison;WeakMap.prototype.get=poison;Reflect.apply=poison;
      globalThis.ctx=wx.createCanvasContext('shared',first);ctx.fillRect(0,0,1,1);ctx.draw();`);
    const batch=r.capture();assert.equal(batch.length,2);assert.deepEqual(batch[1].options.commands,[{op:'fillRect',args:[0,0,1,1]}]);
    assert.equal(r.deliver(batch[1].ticket),true);assert.equal(r.run('hooks'),0);
  });
}
