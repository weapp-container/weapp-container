import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppServiceTestRealm} from './app-service-test-realm.mjs';
// This deterministic native callback double checks production bootstrap wire
// behavior only. Real entropy, store and decoded consumer tests live in Rust.
for (const engine of ['quickjs','v8']) {
  function realm(capabilities={}) {
    let serial=0; const leases=new Map(), calls=[];
    const r=createAppServiceTestRealm(engine,{__container_host_buffer_url(operation,wire){
      calls.push({operation,wire});
      if(operation==='create'){const url='wxbuffer://'+String(++serial).padStart(48,'0');leases.set(url,Buffer.from(wire,'hex'));return JSON.stringify({ok:true,value:url});}
      if(operation==='revoke'){leases.delete(wire);return JSON.stringify({ok:true,value:null});}
      throw Error('unexpected operation');
    }});
    r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.createBufferURL':'partial','wx.revokeBufferURL':'partial',...capabilities}});
    return {...r,leases,calls};
  }
  test(`${engine}: ArrayBuffer and exactly nine TypedArrays snapshot their exact byte slices`,()=>{
    const r=realm();
    for(const type of ['Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array']){
      const url=r.run(`(()=>{const buffer=new ArrayBuffer(32);const all=new Uint8Array(buffer);for(let i=0;i<32;i++)all[i]=i+1;const item=new ${type}(buffer,8,8/${type}.BYTES_PER_ELEMENT);const url=wx.createBufferURL(item);all.fill(255);return url;})()`);
      assert.deepEqual([...r.leases.get(url)],[9,10,11,12,13,14,15,16],type);
    }
    const url=r.run('wx.createBufferURL(new Uint8Array([0,128,255]).buffer)');assert.deepEqual([...r.leases.get(url)],[0,128,255]);
    assert.equal(r.run('typeof __container_host_buffer_url'),'undefined');
    assert.equal(new Set(r.leases.keys()).size,10);
  });
  test(`${engine}: empty buffers, repeated identity, revoke void and duplicate/unknown revoke`,()=>{
    const r=realm();r.run('globalThis.buffer=new ArrayBuffer(0);globalThis.a=wx.createBufferURL(buffer);globalThis.b=wx.createBufferURL(buffer)');
    assert.notEqual(r.run('a'),r.run('b'));assert.equal(r.leases.get(r.run('a')).length,0);
    assert.equal(r.run('wx.revokeBufferURL(a)'),undefined);assert.equal(r.leases.has(r.run('a')),false);
    assert.equal(r.run('wx.revokeBufferURL(a)'),undefined);assert.equal(r.run('wx.revokeBufferURL("unknown")'),undefined);
    assert.equal(r.leases.has(r.run('b')),true);
  });
  test(`${engine}: rejects DataView, BigInt arrays, shared buffers, forgeries and non-string revoke`,()=>{
    const r=realm();for(const expression of ['undefined','null','{}','[]','new DataView(new ArrayBuffer(8))','new BigInt64Array(1)','new BigUint64Array(1)','new SharedArrayBuffer(8)','new Uint8Array(new SharedArrayBuffer(8))','new Proxy(new Uint8Array(1),{})','Object.create(Uint8Array.prototype)','{[Symbol.toStringTag]:"Uint8Array",buffer:new ArrayBuffer(1),byteOffset:0,byteLength:1}'])assert.throws(()=>r.run(`wx.createBufferURL(${expression})`),undefined,expression);
    for(const expression of ['null','{}','42','new String("unknown")'])assert.throws(()=>r.run(`wx.revokeBufferURL(${expression})`));
    assert.equal(r.calls.length,0);
  });
  test(`${engine}: captured intrinsics bypass aliases, getters, toJSON and prototype poisoning`,()=>{
    const r=realm();
    const url=r.run(`(()=>{const item=new Uint16Array(new Uint8Array([1,2,3,4,5,6]).buffer,2,1);Object.defineProperties(item,{buffer:{get(){throw Error('buffer getter')}},byteOffset:{get(){throw Error('offset getter')}},byteLength:{get(){throw Error('length getter')}},toJSON:{value(){throw Error('toJSON')}}});Array.prototype.toJSON=()=>{throw Error('array toJSON')};JSON.parse=()=>{throw Error('parse alias')};Reflect.apply=()=>{throw Error('apply alias')};globalThis.Uint8Array=()=>{throw Error('constructor alias')};return wx.createBufferURL(item);})()`);
    assert.deepEqual([...r.leases.get(url)],[3,4]);assert.equal(r.run(`wx.revokeBufferURL(${JSON.stringify(url)})`),undefined);
  });
  test(`${engine}: own capability denial precedes argument observation and create/revoke are independent`,()=>{
    const r=realm({'wx.createBufferURL':'unsupported'});
    assert.throws(()=>r.run('wx.createBufferURL({get buffer(){throw Error("observed")}})'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');
    assert.equal(r.calls.length,0);assert.equal(r.run('wx.revokeBufferURL("unknown")'),undefined);
    r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.createBufferURL':'partial','wx.revokeBufferURL':'unsupported'}});
    const url=r.run('wx.createBufferURL(new ArrayBuffer(1))');assert.throws(()=>r.run(`wx.revokeBufferURL(${JSON.stringify(url)})`),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');assert.equal(r.leases.has(url),true);
  });
  test(`${engine}: stale host descriptors cannot replace private runtime API ownership`,()=>{
    const r=realm();r.run(`globalThis.savedCreate=wx.createBufferURL;globalThis.savedRevoke=wx.revokeBufferURL;__container_install_host_services({apis:[{name:'wx.createBufferURL',owner:'host',kind:'async'},{name:'wx.revokeBufferURL',owner:'host',kind:'async'}]})`);
    assert.equal(r.run('wx.createBufferURL===savedCreate && wx.revokeBufferURL===savedRevoke'),true);
  });
  test(`${engine}: detached and oversized inputs never reach native allocation`,()=>{
    const r=realm();const detached=new ArrayBuffer(8);structuredClone(detached,{transfer:[detached]});r.context.detached=detached;
    assert.throws(()=>r.run('wx.createBufferURL(detached)'));assert.throws(()=>r.run('wx.createBufferURL(new ArrayBuffer(8388609))'));assert.equal(r.calls.length,0);
  });
}

for(const engine of ['quickjs','v8'])test(`${engine}: guest diagnostic grants cannot change trusted independent admission or revive retirement`,()=>{
  let creates=0,revokes=0;
  const r=createAppServiceTestRealm(engine,{__container_host_buffer_url(op){if(op==='create')creates++;else revokes++;return JSON.stringify({ok:true,value:op==='create'?'wxbuffer://'+'a'.repeat(48):null})}})
  r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.createBufferURL':'unsupported','wx.revokeBufferURL':'partial'}})
  r.run('globalThis.savedCreate=wx.createBufferURL;globalThis.savedRevoke=wx.revokeBufferURL;__container_capabilities["wx.createBufferURL"]="full";globalThis.__container_capability=()=>"full"')
  assert.throws(()=>r.run('savedCreate(new ArrayBuffer(1))'),failure=>failure.code==='ERR_UNSUPPORTED_CAPABILITY');assert.equal(creates,0);assert.equal(r.run('savedRevoke("unknown")'),undefined);assert.equal(revokes,1)
  r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.createBufferURL':'partial','wx.revokeBufferURL':'unsupported'}})
  r.run('__container_capabilities["wx.revokeBufferURL"]="full"');assert.throws(()=>r.run('savedRevoke("unknown")'),failure=>failure.code==='ERR_UNSUPPORTED_CAPABILITY');r.run('savedCreate(new ArrayBuffer(0))');assert.equal(creates,1)
  r.transports.dispatchLifecycleNotification('retire',null)
  r.transports.installHostEnvironment({kind:'capabilities',capabilities:{'wx.createBufferURL':'full','wx.revokeBufferURL':'full'}})
  for(const expression of ['savedCreate(new ArrayBuffer(1))','savedRevoke("unknown")'])assert.throws(()=>r.run(expression),failure=>failure.code==='ERR_UNSUPPORTED_CAPABILITY');assert.equal(creates,1);assert.equal(revokes,1)
})

for(const engine of ['quickjs','v8'])test(`${engine}: complete trusted environment publication also replaces private BufferURL policy`,()=>{
  let writes=0;const r=createAppServiceTestRealm(engine,{__container_host_buffer_url(){writes++;return JSON.stringify({ok:true,value:'wxbuffer://'+'a'.repeat(48)})}})
  function install(create,revoke){assert.equal(r.transports.installHostEnvironment({version:'1.0',capabilities:{'wx.createBufferURL':create,'wx.revokeBufferURL':revoke},domQuery:false,syncApiValues:{},syncApiErrors:{},storage:null,files:null}),true)}
  install('partial','unsupported');r.run('globalThis.saved=wx.createBufferURL;saved(new ArrayBuffer(1))');assert.equal(writes,1)
  install('unsupported','partial');r.run('__container_capabilities["wx.createBufferURL"]="full"');assert.throws(()=>r.run('saved(new ArrayBuffer(1))'),failure=>failure.code==='ERR_UNSUPPORTED_CAPABILITY');assert.equal(writes,1)
})
