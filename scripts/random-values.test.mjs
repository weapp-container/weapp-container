import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import { createAppServiceTestRealm } from './app-service-test-realm.mjs';

// Deterministic TEST DOUBLES below exercise wire decoding and delivery only.
// Rust Session tests cover the real CSPRNG; no entropy-quality claim is made here.
function events(realm) {
  const batch = realm.json('__container_drain_events()');
  assert.equal(realm.transports.installHostEnvironment({kind:'effects-ack',drainId:batch.__containerDrainId}), true);
  return batch.events;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function resolve(realm, event, bytes) {
  realm.context.wire={randomValues:{__weappBinary:{type:'ArrayBuffer',bytes}},errMsg:'getRandomValues:ok'};
  realm.run(`__container_resolve_api(${event.id},wire,null)`);
}
for (const engine of ['quickjs', 'v8']) {
  function realm(supported = true) {
    const value = createAppServiceTestRealm(engine);
    assert.equal(value.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.getRandomValues':supported?'full':'unsupported'}}), true);
    return value;
  }
  test(`${engine}: callback mode returns void and shares one decoded result through success then complete`, async () => {
    const r=realm();
    r.run(`globalThis.log=[];globalThis.successValue=null;globalThis.completeValue=null;
      Math.random=function(){throw Error('insecure RNG must never run')};
      globalThis.crypto={getRandomValues(){throw Error('guest RNG must never run')}};
      globalThis.returned=wx.getRandomValues({length:3,
        success:r=>{successValue=r;log.push('success')},complete:r=>{completeValue=r;log.push('complete')}});`);
    assert.equal(r.run('returned===undefined'),true);
    const [event]=events(r);assert.equal(event.name,'wx.getRandomValues');assert.deepEqual(event.options,{length:3});
    resolve(r,event,[0,128,255]);await tick();
    assert.deepEqual(r.json('log'),['success','complete']);assert.equal(r.run('successValue===completeValue'),true);
    assert.equal(r.run('successValue.randomValues instanceof ArrayBuffer'),true);
    assert.deepEqual(r.json('Array.from(new Uint8Array(successValue.randomValues))'),[0,128,255]);
  });
  test(`${engine}: no callback returns a Promise for zero, Web Crypto chunk edges and exact maximum`, async () => {
    const r=realm();r.run('globalThis.buffers=[]');
    for(const length of [0,1,16,65535,65536,65537,1048576]){
      r.run(`globalThis.pending=wx.getRandomValues({length:${length}}).then(r=>{buffers.push(r.randomValues);return r.randomValues.byteLength});`);
      const [event]=events(r);assert.deepEqual(event.options,{length});
      resolve(r,event,Array.from({length},(_,i)=>i%256));assert.equal(await r.run('pending'),length);
    }
    assert.equal(r.run('buffers.every((b,i)=>b instanceof ArrayBuffer && buffers.every((c,j)=>i===j||b!==c))'),true);
  });
  test(`${engine}: normal Get accepts inherited numeric fields and getters exactly once`, async () => {
    const r=realm();
    r.run(`globalThis.lengthReads=0;globalThis.callbackReads=0;globalThis.log=[];
      const prototype={get length(){lengthReads++;return 3},get success(){callbackReads++;return r=>log.push(r.randomValues.byteLength)}};
      globalThis.returned=wx.getRandomValues(Object.create(prototype));`);
    assert.equal(r.run('returned===undefined'),true);assert.equal(r.run('lengthReads'),1);assert.equal(r.run('callbackReads'),1);
    const [event]=events(r);assert.deepEqual(event.options,{length:3});resolve(r,event,[1,2,3]);await tick();assert.deepEqual(r.json('log'),[3]);
    r.run('globalThis.pending=wx.getRandomValues(Object.create({length:1}))');
    const [inherited]=events(r);assert.deepEqual(inherited.options,{length:1});resolve(r,inherited,[255]);assert.equal((await r.run('pending')).randomValues.byteLength,1);
  });
  test(`${engine}: Proxy length/callback reads occur once and the captured primitive survives mutation`, async () => {
    const r=realm();
    r.run(`globalThis.reads={};globalThis.log=[];globalThis.options={length:2,success:r=>log.push(r.randomValues.byteLength)};
      globalThis.proxy=new Proxy(options,{get(target,key,receiver){reads[key]=(reads[key]||0)+1;return Reflect.get(target,key,receiver)}});
      globalThis.returned=wx.getRandomValues(proxy);options.length=999;options.success=()=>log.push('wrong');`);
    assert.equal(r.run('returned===undefined'),true);assert.equal(r.run('reads.length'),1);assert.equal(r.run('reads.success'),1);assert.equal(r.run('reads.fail'),1);assert.equal(r.run('reads.complete'),1);
    const [event]=events(r);assert.deepEqual(event.options,{length:2});resolve(r,event,[1,2]);await tick();assert.deepEqual(r.json('log'),[2]);
    r.run(`globalThis.log=[];globalThis.getCount=0;globalThis.returned=wx.getRandomValues(new Proxy({}, {
      has(){return false},get(target,key){if(key==='length')return 1;if(key==='success'){getCount++;return r=>log.push(r.randomValues.byteLength)}}}));`);
    assert.equal(r.run('returned===undefined'),true);assert.equal(r.run('getCount'),1);
    const [virtual]=events(r);resolve(r,virtual,[7]);await tick();assert.deepEqual(r.json('log'),[1]);
  });
  test(`${engine}: retained callbacks keep the original options receiver and complete survives a thrown success`, async () => {
    const r=realm();r.run(`globalThis.log=[];globalThis.options={length:1,
      success:function(value){log.push(this===options?'success-this':'wrong');throw Error('callback threw')},
      complete:function(value){log.push(this===options?'complete-this':'wrong')}};
      globalThis.returned=wx.getRandomValues(options);options.success=function(){log.push('changed')};`);
    assert.equal(r.run('returned===undefined'),true);const [event]=events(r);resolve(r,event,[1]);await tick();
    assert.deepEqual(r.json('log'),['success-this','complete-this']);
    assert.equal(r.run("__container_errors.some(e=>e.message==='callback threw')"),true);
  });
  test(`${engine}: callback property presence selects void even when undefined or inherited`, async () => {
    const r=realm();
    for(const input of ["{length:0,success:undefined}","{length:0,fail:undefined}","{length:0,complete:undefined}","Object.create({length:0,success:undefined})"]){
      r.run(`globalThis.returned=wx.getRandomValues(${input});`);assert.equal(r.run('returned===undefined'),true);
      const [event]=events(r);resolve(r,event,[]);await tick();
    }
  });
  test(`${engine}: invalid original length values reject without object.toJSON coercion`, async () => {
    const r=realm();
    for(const expression of ['undefined','null','{}',"{length:'16'}",'{length:true}','{length:null}','{length:[]}','{length:-1}','{length:1.5}','{length:1048577}','{length:NaN}','{length:Infinity}']){
      r.run(`globalThis.pending=wx.getRandomValues(${expression});pending.catch(()=>{});`);
      await assert.rejects(r.run('pending'),e=>e.code==='ERR_INVALID_REQUEST');assert.deepEqual(events(r),[]);
    }
    r.run(`globalThis.hooks=0;globalThis.pending=wx.getRandomValues({length:{toJSON(){hooks++;return 16}}});pending.catch(()=>{});`);
    await assert.rejects(r.run('pending'),e=>e.code==='ERR_INVALID_REQUEST');assert.equal(r.run('hooks'),0);assert.deepEqual(events(r),[]);
  });
  test(`${engine}: callback failures return void and have no unhandled internal rejection`, async () => {
    const r=realm();
    for(const input of ["{length:-1,fail:r=>log.push(r.code),complete:r=>log.push('complete')}","{length:-1,success:undefined}"]){
      r.run(`globalThis.log=[];globalThis.returned=wx.getRandomValues(${input});`);assert.equal(r.run('returned===undefined'),true);await tick();assert.deepEqual(events(r),[]);
    }
    for(const code of ['ERR_ENGINE','ERR_CANCELLED','ERR_TIMEOUT']){
      r.run(`globalThis.log=[];globalThis.failValue=null;globalThis.completeValue=null;globalThis.returned=wx.getRandomValues({length:16,
        fail:r=>{failValue=r;log.push(r.code)},complete:r=>{completeValue=r;log.push('complete')}});`);
      assert.equal(r.run('returned===undefined'),true);const [event]=events(r);
      r.run(`__container_resolve_api(${event.id},null,{code:${JSON.stringify(code)},errMsg:'getRandomValues:fail unavailable'})`);await tick();
      assert.deepEqual(r.json('log'),[code,'complete']);assert.equal(r.run('failValue===completeValue'),true);
    }
  });
  test(`${engine}: Promise failures reject for native errors and malformed binary`, async () => {
    const r=realm();
    for(const code of ['ERR_ENGINE','ERR_CANCELLED','ERR_TIMEOUT']){
      r.run('globalThis.pending=wx.getRandomValues({length:16});pending.catch(()=>{})');const [event]=events(r);
      r.run(`__container_resolve_api(${event.id},null,{code:${JSON.stringify(code)},errMsg:'getRandomValues:fail unavailable'})`);
      await assert.rejects(r.run('pending'),e=>e.code===code);
    }
    r.run('globalThis.pending=wx.getRandomValues({length:1});pending.catch(()=>{})');const [event]=events(r);resolve(r,event,[256]);
    await assert.rejects(r.run('pending'),e=>e.code==='ERR_INVALID_RESPONSE');
  });
  test(`${engine}: getters throw their original exception synchronously and options.toJSON never replaces the snapshot`, async () => {
    const r=realm();
    r.run("globalThis.original=Error('getter');globalThis.hooks=0");
    for(const input of ["{get length(){throw original}}","{length:1,get success(){throw original}}"]){
      let thrown;try{r.run(`wx.getRandomValues(${input})`)}catch(e){thrown=e}assert.equal(thrown,r.run('original'));assert.deepEqual(events(r),[]);
    }
    r.run(`globalThis.pending=wx.getRandomValues({length:1,toJSON(){hooks++;return {length:999}}});`);const [event]=events(r);
    assert.deepEqual(event.options,{length:1});assert.equal(r.run('hooks'),0);resolve(r,event,[42]);await r.run('pending');
  });
  test(`${engine}: runtime owner descriptors cannot replace the facade directly or through a later counterpart`, async () => {
    const r=realm();r.run('globalThis.original=wx.getRandomValues');
    r.context.hostConfig={apis:[{name:'wx.onStaleOther',kind:'subscription',owner:'host',counterpart:'wx.getRandomValues'},
      {name:'wx.getRandomValues',kind:'syncSnapshot',owner:'runtime'},
      {name:'component:camera',kind:'object',owner:'runtime'}],objectApis:[]};
    r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.getRandomValues':'full','component:camera':'partial'}});
    assert.equal(r.run('__container_install_host_services(hostConfig)'),true);
    assert.equal(r.run('wx.getRandomValues===original'),true);assert.equal(r.run("wx.canIUse('camera')"),true);
    r.run('globalThis.pending=wx.getRandomValues({length:1})');const [event]=events(r);resolve(r,event,[42]);
    assert.equal((await r.run('pending')).randomValues.byteLength,1);
  });
  test(`${engine}: host denial keeps callback void and Promise rejection modes`, async () => {
    const r=realm(false);assert.equal(r.run("wx.canIUse('getRandomValues')"),false);
    r.run("globalThis.log=[];globalThis.returned=wx.getRandomValues({length:1,fail:r=>log.push(r.code),complete:()=>log.push('complete')})");
    assert.equal(r.run('returned===undefined'),true);await tick();assert.deepEqual(r.json('log'),['ERR_UNSUPPORTED_CAPABILITY','complete']);assert.deepEqual(events(r),[]);
    r.run('globalThis.pending=wx.getRandomValues({length:1});pending.catch(()=>{})');await assert.rejects(r.run('pending'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');assert.deepEqual(events(r),[]);
  });
}

test('fixed catalog and generator declare cryptographic wx generation runtime-owned',()=>{
  const catalog=JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json',import.meta.url),'utf8'));
  assert.equal(catalog.apis.find(api=>api.name==='wx.getRandomValues').owner,'runtime');
  const source=readFileSync(new URL('./generate-host-api-catalog.mjs',import.meta.url),'utf8');
  const globals=/const runtimeGlobals = new Set\(\('([^']+)'\)/.exec(source)?.[1].split(' ');
  assert(globals?.includes('getRandomValues'));
  assert.equal(catalog.apis.find(api=>api.name==='object:UserCryptoManager.getRandomValues').owner,'host');
});
