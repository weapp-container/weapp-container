import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppServiceTestRealm} from './app-service-test-realm.mjs';

// These are the production QuickJS/V8 bootstrap compositions in a Node VM.
// They verify facade admission and transport, not native-engine pixels.
function fixture(engine) {
  const r=createAppServiceTestRealm(engine);
  r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.createCanvasContext':'full','wx.canvas.draw':'full'}});
  r.run(`globalThis.ctx=wx.createCanvasContext('affine');`);
  return r;
}
function drain(r) {
  const batch=r.json('__container_drain_events()');
  assert.equal(r.transports.installHostEnvironment({kind:'effects-ack',drainId:batch.__containerDrainId}),true);
  return batch.events;
}

for(const engine of ['quickjs','v8']) {
  test(`${engine}: affine methods retain scalar order and clip ordering`,()=>{
    const r=fixture(engine);
    assert.equal(r.run('ctx.setTransform(2,1,-.5,3,7,-9)'),undefined);
    r.run('ctx.save();ctx.beginPath();ctx.rect(0,0,10,8);');
    assert.equal(r.run('ctx.transform(1,-2,3,4,-5,6)'),undefined);
    assert.equal(r.run('ctx.clip()'),undefined);
    r.run('ctx.restore();ctx.fill();ctx.draw(true)');
    const [event]=drain(r);
    assert.equal(event.options.reserve,true);
    assert.deepEqual(event.options.commands,[
      {op:'setTransform',args:[2,1,-.5,3,7,-9]},{op:'save',args:[]},
      {op:'beginPath',args:[]},{op:'rect',args:[0,0,10,8]},
      {op:'transform',args:[1,-2,3,4,-5,6]},{op:'clip',args:[]},
      {op:'restore',args:[]},{op:'fill',args:[]}]);
    r.run('ctx.draw()');assert.deepEqual(drain(r)[0].options.commands,[]);
  });

  test(`${engine}: malformed matrices reject before enqueue without conversion hooks`,()=>{
    const r=fixture(engine);
    const result=r.json(`(()=>{ctx.beginPath();globalThis.hooks=0;const errors=[];
      const object={toJSON(){hooks++;return 1},valueOf(){hooks++;return 1}};
      const matrices=[[1,0,0,1,0],[1,0,0,1,0,undefined],
        [object,0,0,1,0,0],[[1],0,0,1,0,0],[new Number(1),0,0,1,0,0],
        ['1',0,0,1,0,0],[true,0,0,1,0,0],[null,0,0,1,0,0],
        [NaN,0,0,1,0,0],[Infinity,0,0,1,0,0],[1e100,0,0,1,0,0]];
      for(const method of ['setTransform','transform'])for(const values of matrices){
        try{ctx[method](...values)}catch(e){errors.push(e.code)}
      }
      ctx.clip();ctx.transform(1,0,0,1,2,3);ctx.draw();return {errors,hooks};})()`);
    assert.deepEqual(result,{errors:Array(22).fill('ERR_INVALID_REQUEST'),hooks:0});
    assert.deepEqual(drain(r)[0].options.commands,[
      {op:'beginPath',args:[]},{op:'clip',args:[]},{op:'transform',args:[1,0,0,1,2,3]}]);
  });

  test(`${engine}: argument-copy reentry cannot alter the admitted prefix`,()=>{
    const r=fixture(engine);
    const result=r.json(`(()=>{ctx.beginPath();const errors=[];
      const nested=new Proxy([1],{getOwnPropertyDescriptor(target,key){
        for(const action of [()=>ctx.clip(),()=>ctx.transform(1,0,0,1,0,0),()=>ctx.draw()]){
          try{action()}catch(e){errors.push(e.code)}
        }return Object.getOwnPropertyDescriptor(target,key);
      }});
      try{ctx.setTransform(nested,0,0,1,0,0)}catch(e){errors.push(e.code)}
      ctx.setTransform(1,0,0,1,4,5);ctx.clip();ctx.draw();return errors;})()`);
    assert.deepEqual(result,Array(4).fill('ERR_INVALID_REQUEST'));
    assert.deepEqual(drain(r)[0].options.commands,[
      {op:'beginPath',args:[]},{op:'setTransform',args:[1,0,0,1,4,5]},{op:'clip',args:[]}]);
  });

  test(`${engine}: affine commands share the queue budget and recover after draw`,()=>{
    const r=fixture(engine);
    r.run('for(let i=0;i<16384;i++)ctx.beginPath()');
    assert.deepEqual(r.json(`(()=>{const codes=[];for(const action of [
      ()=>ctx.setTransform(1,0,0,1,0,0),()=>ctx.transform(1,0,0,1,0,0),()=>ctx.clip()
    ])try{action()}catch(e){codes.push(e.code)}return codes})()`),Array(3).fill('ERR_RESOURCE_LIMIT'));
    r.run('ctx.draw()');assert.equal(drain(r)[0].options.commands.length,16384);
    r.run('ctx.setTransform(1,0,0,1,0,0);ctx.transform(2,0,0,2,0,0);ctx.clip();ctx.draw()');
    assert.deepEqual(drain(r)[0].options.commands.map(command=>command.op),['setTransform','transform','clip']);
  });

  test(`${engine}: rejected draw retries exactly once and reentrant work belongs to next draw`,()=>{
    const r=fixture(engine);
    assert.equal(r.run(`(()=>{ctx.setTransform(1,0,0,1,4,5);ctx.clip();
      const push=__container_events.push;try{__container_events.push=()=>{throw Error('unavailable')};ctx.draw(true)}
      catch(e){return e.message}finally{__container_events.push=push}})()`),'unavailable');
    r.run(`globalThis.nested='';const push=__container_events.push;let once=false;
      __container_events.push=function(event){if(!once){once=true;ctx.transform(2,0,0,2,0,0);ctx.clip();
        try{ctx.draw()}catch(e){nested=e.code}}return push.call(this,event)};
      try{ctx.draw(true)}finally{__container_events.push=push}ctx.draw();ctx.draw();`);
    assert.equal(r.run('nested'),'ERR_INVALID_REQUEST');
    const events=drain(r);
    assert.deepEqual(events.map(event=>event.options.commands),[
      [{op:'setTransform',args:[1,0,0,1,4,5]},{op:'clip',args:[]}],
      [{op:'transform',args:[2,0,0,2,0,0]},{op:'clip',args:[]}],[]]);
  });

  test(`${engine}: owned affine transport preserves commands and retires with its receiver`,()=>{
    const r=fixture(engine);
    r.transports.dispatchLifecycleNotification('session',{});
    r.run(`Page({});__container_set_current_pages([0],[{index:0,instanceId:11,route:'pages/affine'}]);
      __container_registration_module_id='module:affine.js';__container_managed_component_modules[__container_registration_module_id]=true;
      globalThis.definition=Component({methods:{}});__container_registration_module_id=null;
      globalThis.component=__container_clone_component_instance(definition,{scopeId:'affine',moduleId:'module:affine.js',pageId:11,parentScopeId:null,ownerScopeId:null});
      globalThis.owned=wx.createCanvasContext('owned-affine',component);
      owned.setTransform(1,0,0,1,6,7);owned.beginPath();owned.rect(0,0,8,8);owned.clip();owned.draw(true);`);
    const requests=JSON.parse(r.transports.captureReceiverIncarnations({kind:'canvas-draw-requests',after:'0'})).requests;
    assert.equal(requests.length,2);
    assert.deepEqual(requests[1].options.commands,[
      {op:'setTransform',args:[1,0,0,1,6,7]},{op:'beginPath',args:[]},
      {op:'rect',args:[0,0,8,8]},{op:'clip',args:[]}]);
    r.run(`__container_unmount_component(component.__container_component_index);owned.transform(2,0,0,2,0,0);`);
    assert.equal(r.run('(()=>{try{owned.draw()}catch(e){return e.code}})()'),'ERR_CANCELLED');
    assert.deepEqual(drain(r),[]);
    r.run('ctx.clip();ctx.draw()');assert.deepEqual(drain(r)[0].options.commands,[{op:'clip',args:[]}]);
  });
}
