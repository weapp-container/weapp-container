import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppServiceTestRealm } from './app-service-test-realm.mjs';
function runtime(engine, session = true) {
  const realm = createAppServiceTestRealm(engine);
  realm.transports.installHostEnvironment({kind:'capabilities', capabilities:{'wx.createIntersectionObserver':'partial'}});
  realm.run(`Page({}); Page({}); __container_set_current_pages([0,1],[
    {index:0,instanceId:11,route:'pages/first'}, {index:1,instanceId:12,route:'pages/second'}]);
    globalThis.firstPage=__container_page_instances['11']; globalThis.secondPage=__container_page_instances['12'];
    __container_registration_module_id='module:owner-component.js';
    __container_managed_component_modules[__container_registration_module_id]=true;
    globalThis.definition=Component({methods:{}}); __container_registration_module_id=null;
    globalThis.component=__container_clone_component_instance(definition,{
      scopeId:'owner-component',moduleId:'module:owner-component.js',pageId:11,parentScopeId:null,ownerScopeId:null});
    globalThis.trace=[];`);
  if (session) realm.transports.dispatchLifecycleNotification('session', {});
  realm.capture = revision => JSON.parse(realm.transports.captureReceiverIncarnations({kind:'intersection-query-state', revision: revision ?? null}));
  realm.deliver = (subscriptions, extra = {}) => realm.transports.dispatchLifecycleNotification('intersectionQuery', subscriptions.map(source => ({...source, value:{intersectionRatio:1,id:'target'}, ...extra})));
  return realm;
}
for (const engine of ['quickjs','v8']) {
  test(`${engine}: disconnect is synchronous void before observe and remains idempotent`, () => {
    const r=runtime(engine);
    assert.equal(r.run('globalThis.observer=wx.createIntersectionObserver(); observer.disconnect()'), undefined);
    assert.equal(r.run('observer.disconnect()'), undefined);
  });
  test(`${engine}: private complete snapshot removes disconnected subscriptions`, () => {
    const r=runtime(engine); r.run("globalThis.observer=wx.createIntersectionObserver(); observer.observe('#target',function(value){trace.push(value.id)});");
    const state=r.capture(); assert.equal(state.subscriptions.length,1);
    assert.equal(r.run('observer.disconnect()'), undefined);
    const after=r.capture(state.revision); assert.equal(after.unchanged,undefined); assert.deepEqual(after.subscriptions,[]);
  });
  test(`${engine}: same-batch and future notifications are suppressed after callback disconnect, other observers proceed`, () => {
    const r=runtime(engine); r.run(`globalThis.a=wx.createIntersectionObserver(); globalThis.b=wx.createIntersectionObserver();
      a.observe('#a',function(){'use strict'; trace.push(['a',this===undefined,__container_capture_api_owner()===secondPage]); a.disconnect()});
      a.observe('#a2',function(){trace.push('unreachable')}); b.observe('#b',function(){trace.push('b')});`);
    const state=r.capture(); r.deliver(state.subscriptions); r.deliver(state.subscriptions);
    assert.deepEqual(r.json('trace'),[['a',true,true],'b','b']);
    assert.equal(r.capture().subscriptions.length,1);
  });
  test(`${engine}: queued notification and pending admission are locally revoked`, () => {
    const r=runtime(engine); r.run("globalThis.observer=wx.createIntersectionObserver(); observer.observe('#target',function(){trace.push('bad')});");
    const queued=r.capture().subscriptions; r.run('observer.disconnect()'); r.deliver(queued);
    r.run("globalThis.pending=wx.createIntersectionObserver(); pending.observe('#target',function(){trace.push('bad')}); pending.disconnect();");
    assert.deepEqual(r.json('trace'),[]); assert.deepEqual(r.capture().subscriptions,[]);
  });
  test(`${engine}: capability revocation does not gate cleanup`, () => {
    const r=runtime(engine); r.run("globalThis.observer=wx.createIntersectionObserver(); observer.observe('#target',function(){trace.push('bad')});");
    const state=r.capture(); r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.createIntersectionObserver':'unsupported'}});
    assert.equal(r.run('observer.disconnect()'),undefined); assert.deepEqual(r.capture(state.revision).subscriptions,[]);
    r.deliver(state.subscriptions); assert.deepEqual(r.json('trace'),[]);
  });
  test(`${engine}: revoked capability capture removes admission even without guest disconnect`, () => {
    const r=runtime(engine); r.run("globalThis.observer=wx.createIntersectionObserver(); observer.observe('#target',function(){trace.push('bad')});");
    const state=r.capture(); r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.createIntersectionObserver':'unsupported'}});
    assert.deepEqual(r.capture(state.revision).subscriptions,[]); r.deliver(state.subscriptions); assert.deepEqual(r.json('trace'),[]);
  });
  test(`${engine}: component owner context is private while unscoped geometry stays page-wide`, () => {
    const r=runtime(engine); r.run(`__container_run_with_api_owner(component,function(){
      globalThis.observer=wx.createIntersectionObserver(); observer.observe('#target',function(){'use strict';trace.push(this===undefined,__container_capture_api_owner()===component)});});`);
    const state=r.capture(); assert.equal(state.subscriptions[0].scopeId,null); assert.equal(state.subscriptions[0].ownerScopeId,'owner-component');
    r.deliver(state.subscriptions); assert.deepEqual(r.json('trace'),[true,true]);
  });
  test(`${engine}: replacement component cannot inherit textual scope subscriptions`, () => {
    const r=runtime(engine); r.run("globalThis.observer=component.createIntersectionObserver(); observer.observe('#target',function(){trace.push('bad')});");
    const old=r.capture().subscriptions;
    r.run(`globalThis.replacement=__container_clone_component_instance(definition,{scopeId:'owner-component',moduleId:'module:owner-component.js',pageId:11,parentScopeId:null,ownerScopeId:null});`);
    r.deliver(old); assert.deepEqual(r.json('trace'),[]); assert.deepEqual(r.capture().subscriptions,[]);
    assert.throws(()=>r.run("observer.observe('#other',function(){})"));
  });
  test(`${engine}: detached component cleanup is synchronous and isolated`, () => {
    const r=runtime(engine); r.run(`globalThis.observer=component.createIntersectionObserver(); observer.observe('#target',function(){trace.push('bad')});
      globalThis.other=wx.createIntersectionObserver(); other.observe('#other',function(){trace.push('other')});`);
    const old=r.capture().subscriptions; r.run('__container_unmount_component(component.__container_component_index)');
    r.deliver(old); assert.deepEqual(r.json('trace'),['other']); assert.equal(r.capture().subscriptions.length,1);
  });
  test(`${engine}: unloaded and reused page id cannot receive prior object notifications`, () => {
    const r=runtime(engine); r.run(`__container_run_with_api_owner(firstPage,function(){globalThis.observer=wx.createIntersectionObserver(); observer.observe('#target',function(){trace.push('bad')});});`);
    const old=r.capture().subscriptions;
    r.run(`__container_invoke_page_instance(11,0,'onUnload',[]); delete __container_page_instances['11']; __container_set_current_pages([0,1],[{index:0,instanceId:11,route:'pages/first'},{index:1,instanceId:12,route:'pages/second'}]);`);
    r.deliver(old); assert.deepEqual(r.json('trace'),[]); assert.deepEqual(r.capture().subscriptions,[]);
  });
  test(`${engine}: public queues, tables, aliases and forged tokens do not own delivery`, () => {
    const r=runtime(engine); r.run("globalThis.observer=wx.createIntersectionObserver(); observer.observe('#target',function(){trace.push('valid')});");
    const state=r.capture(); r.run(`__container_events=[]; __container_observers=Object.create(null); __container_page_instances=Object.create(null); __container_component_scopes=Object.create(null); __container_notify_observers=function(){throw new Error('public notification')};`);
    r.deliver(state.subscriptions,{ownerToken:'999999'}); r.deliver(state.subscriptions,{observerId:'intersection:999999'});
    r.deliver(state.subscriptions); assert.deepEqual(r.json('trace'),['valid']);
    r.run('observer.disconnect()'); assert.deepEqual(r.capture().subscriptions,[]);
  });
  test(`${engine}: throwing callback is isolated from later observer`, () => {
    const r=runtime(engine); r.run(`globalThis.a=wx.createIntersectionObserver();globalThis.b=wx.createIntersectionObserver();
      a.observe('#a',function(){trace.push('a');throw new Error('callback failure')});b.observe('#b',function(){trace.push('b')});`);
    r.deliver(r.capture().subscriptions); assert.deepEqual(r.json('trace'),['a','b']);
  });
  test(`${engine}: disconnect and capture execute no guest serializer, getter, Promise, iterator or bridge hooks`, () => {
    const r=runtime(engine); r.run(`globalThis.observer=wx.createIntersectionObserver(); observer.observe('#target',function(){});
      globalThis.poisonCount=0; const define=Object.defineProperty; const poison=function(){poisonCount++;throw new Error('guest hook')};
      Object.defineProperty(Object.prototype,'toJSON',{get:poison,configurable:true});
      Array.prototype[Symbol.iterator]=poison; JSON.stringify=poison; JSON.parse=poison; Object.create=poison; Object.defineProperty=poison;
      Object.getOwnPropertyDescriptor=poison; Reflect.ownKeys=poison; WeakMap.prototype.get=poison; Reflect.apply=poison;
      Promise.resolve=poison;Promise.prototype.then=poison; __container_api_call=poison;
      define(globalThis,'__container_events',{get:poison,set:poison,configurable:true});`);
    assert.equal(r.run('observer.disconnect()'),undefined); assert.deepEqual(r.capture().subscriptions,[]); assert.equal(r.run('poisonCount'),0);
  });
  test(`${engine}: active private capture and callback clone survive poisoned serialization intrinsics`, () => {
    const r=runtime(engine); r.run(`globalThis.observer=wx.createIntersectionObserver({thresholds:[0,1]}); observer.observe('#target',function(value){trace.push(value.id)});
      globalThis.poisonCount=0; const poison=function(){poisonCount++;throw new Error('guest hook')};
      Object.defineProperty(Object.prototype,'toJSON',{get:poison,configurable:true});
      Array.prototype[Symbol.iterator]=poison; JSON.stringify=poison; JSON.parse=poison; Object.create=poison; Object.defineProperty=poison;
      Object.getOwnPropertyDescriptor=poison; Reflect.ownKeys=poison; WeakMap.prototype.get=poison; Reflect.apply=poison;`);
    const state=r.capture(); assert.equal(state.subscriptions.length,1); r.deliver(state.subscriptions);
    assert.equal(r.run("trace.length===1 && trace[0]==='target'"),true); assert.equal(r.run('poisonCount'),0);
    r.run('observer.disconnect()'); assert.deepEqual(r.capture().subscriptions,[]);
  });
  test(`${engine}: known options snapshot does not execute toJSON and rejects accessors`, () => {
    const r=runtime(engine); r.run(`globalThis.count=0; globalThis.config={thresholds:[0,1],toJSON:function(){count++;throw 0}};
      globalThis.observer=wx.createIntersectionObserver(config);observer.relativeToViewport({top:2,toJSON:function(){count++;throw 0}}).observe('#target',function(){});`);
    const state=r.capture(); assert.deepEqual(state.subscriptions[0].options.thresholds,[0,1]); assert.equal(r.run('count'),0);
    assert.throws(()=>r.run("wx.createIntersectionObserver({get initialRatio(){count++;return 0}})")); assert.equal(r.run('count'),0);
  });
  test(`${engine}: standalone diagnostic disconnect returns void and owns bridge rejection`, async () => {
    const r=runtime(engine,false); r.run(`__container_api_call=function(){return Promise.reject(new Error('bridge refused'))}; globalThis.observer=wx.createIntersectionObserver();`);
    assert.equal(r.run('observer.disconnect()'),undefined); assert.equal(r.run('observer.disconnect()'),undefined);
    await new Promise(resolve=>setImmediate(resolve));
  });
  test(`${engine}: retired Session cannot deliver or admit observers`, () => {
    const r=runtime(engine); r.run("globalThis.observer=wx.createIntersectionObserver(); observer.observe('#target',function(){trace.push('bad')});");
    const state=r.capture(); r.transports.dispatchLifecycleNotification('retire',{}); r.deliver(state.subscriptions);
    assert.deepEqual(r.json('trace'),[]); assert.deepEqual(r.capture(state.revision).subscriptions,[]); assert.throws(()=>r.run('wx.createIntersectionObserver()'));
  });
}

for(const engine of ['quickjs','v8']) {
 test(`${engine}: rejected admission is consumed once without removing another valid subscription`,()=>{
  const r=runtime(engine);
  r.run(`globalThis.observer=wx.createIntersectionObserver();observer.observe('#good',function(){trace.push('good')});observer.observe('#broken[',function(){trace.push('bad')});`);
  const before=r.capture(),bad=before.subscriptions.find(entry=>entry.selector==='#broken['),good=before.subscriptions.find(entry=>entry.selector==='#good');
  assert.equal(r.transports.dispatchLifecycleNotification('intersectionReject',[{...bad,ownerToken:'999999'}]),false);
  assert.equal(r.capture().subscriptions.length,2);
  assert.equal(r.transports.dispatchLifecycleNotification('intersectionReject',[bad]),true);
  const after=r.capture(before.revision);assert.equal(after.unchanged,undefined);assert.deepEqual(after.subscriptions.map(entry=>entry.selector),['#good']);
  assert.equal(r.transports.dispatchLifecycleNotification('intersectionReject',[bad]),false);
  assert.equal(r.capture(after.revision).unchanged,true);
  r.transports.dispatchLifecycleNotification('intersectionQuery',[{...bad,value:{}},{...good,value:{}}]);
  assert.deepEqual(r.json('trace'),['good']);
 });
 test(`${engine}: Proxy margin descriptor reentrancy cannot exceed nativeMode single-root invariant`,()=>{
  const r=runtime(engine);
  r.run(`globalThis.blocked=0;globalThis.observer=wx.createIntersectionObserver({nativeMode:true});
    const margins=new Proxy({top:1},{getOwnPropertyDescriptor:function(target,key){
      if(key==='top'){try{observer.relativeToViewport();}catch(error){blocked++;}}
      return Reflect.getOwnPropertyDescriptor(target,key);
    }});
    observer.relativeToViewport(margins).observe('#target',function(){});`);
  assert.equal(r.run('blocked'),1);
  assert.equal(r.capture().subscriptions[0].options.relativeRoots.length,1);
 });
}
