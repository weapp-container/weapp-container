import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppServiceTestRealm} from './app-service-test-realm.mjs';

function fixture(engine) {
  const r=createAppServiceTestRealm(engine);
  r.transports.installHostEnvironment({kind:'capabilities',capabilities:{
    'wx.createCanvasContext':'full','wx.createOffscreenCanvas':'full','wx.canvas.draw':'full'}});
  r.run(`globalThis.ctx=wx.createCanvasContext('arcto');`);
  return r;
}
function drain(r) {
  const batch=r.json('__container_drain_events()');
  assert.equal(r.transports.installHostEnvironment({kind:'effects-ack',drainId:batch.__containerDrainId}),true);
  return batch.events;
}

// Production bootstrap compositions in a Node VM; these are facade/transport
// checks. Actual QuickJS/V8 and renderer execution remain separate gates.
for(const engine of ['quickjs','v8']) {
  test(`${engine}: arcTo has five ordered scalars and a void result on legacy and offscreen contexts`,()=>{
    const r=fixture(engine);
    assert.equal(r.run('ctx.arcTo(2,-3,5,7,11)'),undefined);
    r.run('ctx.draw(true)');
    assert.deepEqual(drain(r)[0].options.commands,[{op:'arcTo',args:[2,-3,5,7,11]}]);
    assert.deepEqual(r.json(`(()=>{const c=wx.createOffscreenCanvas({type:'2d',width:8,height:8});
      const first=c.getContext('2d'),second=c.getContext('2d');
      const result=first.arcTo(1,2,3,4,0);second.draw();return {same:first===second,void:result===undefined};})()`),{same:true,void:true});
    const event=drain(r)[0];
    assert.deepEqual(event.options.commands,[{op:'arcTo',args:[1,2,3,4,0]}]);
    assert.deepEqual([event.options.width,event.options.height],[8,8]);
  });

  test(`${engine}: malformed arcTo never converts caller objects or enqueues a partial command`,()=>{
    const r=fixture(engine);
    const result=r.json(`(()=>{ctx.beginPath();let hooks=0;const errors=[];
      const object={toJSON(){hooks++;return 1},valueOf(){hooks++;return 1}};
      const values=[[1,2,3,4],[1,2,3,4,undefined],[object,2,3,4,5],
        ['1',2,3,4,5],[true,2,3,4,5],[null,2,3,4,5],[[1],2,3,4,5],
        [NaN,2,3,4,5],[Infinity,2,3,4,5],[1e100,2,3,4,5],
        [1,2,3,4,-1],[1,2,3,4,-1e-100]];
      for(const args of values)try{ctx.arcTo(...args)}catch(e){errors.push(e.code)}
      ctx.arcTo(1,2,3,4,0);ctx.draw();return {hooks,errors};})()`);
    assert.deepEqual(result,{hooks:0,errors:Array(12).fill('ERR_INVALID_REQUEST')});
    assert.deepEqual(drain(r)[0].options.commands,[{op:'beginPath',args:[]},{op:'arcTo',args:[1,2,3,4,0]}]);
  });

  test(`${engine}: arcTo argument-copy reentry retains the old prefix and allows recovery`,()=>{
    const r=fixture(engine);
    const result=r.json(`(()=>{ctx.beginPath();const errors=[];const nested=new Proxy([1],{
      getOwnPropertyDescriptor(target,key){for(const action of [()=>ctx.arcTo(1,2,3,4,5),()=>ctx.draw()])
        try{action()}catch(e){errors.push(e.code)}return Object.getOwnPropertyDescriptor(target,key)}});
      try{ctx.arcTo(nested,2,3,4,5)}catch(e){errors.push(e.code)}
      ctx.arcTo(1,2,3,4,5);ctx.draw();return errors;})()`);
    assert.deepEqual(result,Array(3).fill('ERR_INVALID_REQUEST'));
    assert.deepEqual(drain(r)[0].options.commands,[{op:'beginPath',args:[]},{op:'arcTo',args:[1,2,3,4,5]}]);
  });

  test(`${engine}: arcTo consumes the shared queue budget and failed draw retries exactly once`,()=>{
    const r=fixture(engine);
    r.run('for(let i=0;i<16384;i++)ctx.arcTo(1,2,3,4,5)');
    assert.equal(r.run('(()=>{try{ctx.arcTo(1,2,3,4,5)}catch(e){return e.code}})()'),'ERR_RESOURCE_LIMIT');
    r.run('ctx.draw()');assert.equal(drain(r)[0].options.commands.length,16384);
    assert.equal(r.run(`(()=>{ctx.arcTo(1,2,3,4,5);const push=__container_events.push;
      try{__container_events.push=()=>{throw Error('arcto unavailable')};ctx.draw(true)}
      catch(e){return e.message}finally{__container_events.push=push}})()`),'arcto unavailable');
    r.run('ctx.draw(true);ctx.draw()');
    assert.deepEqual(drain(r).map(event=>event.options.commands),[[{op:'arcTo',args:[1,2,3,4,5]}],[]]);
  });

  test(`${engine}: owned arcTo transport preserves affine clip order and retires with its receiver`,()=>{
    const r=fixture(engine);
    r.transports.dispatchLifecycleNotification('session',{});
    r.run(`Page({});__container_set_current_pages([0],[{index:0,instanceId:11,route:'pages/arcto'}]);
      __container_registration_module_id='module:arcto.js';__container_managed_component_modules[__container_registration_module_id]=true;
      globalThis.definition=Component({methods:{}});__container_registration_module_id=null;
      globalThis.component=__container_clone_component_instance(definition,{scopeId:'arcto',moduleId:'module:arcto.js',pageId:11,parentScopeId:null,ownerScopeId:null});
      globalThis.owned=wx.createCanvasContext('owned-arcto',component);
      owned.setTransform(1,0,0,1,6,7);owned.beginPath();owned.moveTo(0,0);
      owned.arcTo(8,0,8,8,4);owned.clip();owned.draw(true);`);
    const requests=JSON.parse(r.transports.captureReceiverIncarnations({kind:'canvas-draw-requests',after:'0'})).requests;
    assert.equal(requests.length,2);
    assert.equal(requests[0].kind,'context');assert.equal(requests[1].kind,'draw');
    assert.deepEqual(requests[0].context,requests[1].context);
    assert.deepEqual(requests[1].owner,{pageId:'11',scopeId:'arcto'});
    assert.deepEqual(requests[0].receivers,requests[1].receivers);
    assert.equal(requests[1].options.canvasId,'owned-arcto');
    assert.equal(requests[1].options.reserve,true);
    assert.deepEqual(requests[1].options.commands,[
      {op:'setTransform',args:[1,0,0,1,6,7]},{op:'beginPath',args:[]},
      {op:'moveTo',args:[0,0]},{op:'arcTo',args:[8,0,8,8,4]},{op:'clip',args:[]}]);
    r.run(`__container_unmount_component(component.__container_component_index);owned.arcTo(8,8,0,8,4);`);
    assert.equal(r.run('(()=>{try{owned.draw()}catch(e){return e.code}})()'),'ERR_CANCELLED');
    assert.deepEqual(JSON.parse(r.transports.captureReceiverIncarnations({kind:'canvas-draw-requests',after:requests[1].sequence})).requests,[]);
    assert.deepEqual(drain(r),[]);
    r.run('ctx.arcTo(1,2,3,4,5);ctx.draw()');
    assert.deepEqual(drain(r)[0].options.commands,[{op:'arcTo',args:[1,2,3,4,5]}]);
  });
}
