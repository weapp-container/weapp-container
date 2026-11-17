import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

const pairs = [
  ['TCPSocket','BindWifi'],['TCPSocket','Close'],['TCPSocket','Connect'],['TCPSocket','Error'],['TCPSocket','Message'],
  ['UDPSocket','Close'],['UDPSocket','Error'],['UDPSocket','Listening'],['UDPSocket','Message'],
]
const catalog = JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url)))
const factories = ['wx.createTCPSocket','wx.createUDPSocket']
const onNames = pairs.map(([type,event]) => `object:${type}.on${event}`)
const offNames = pairs.map(([type,event]) => `object:${type}.off${event}`)
const registered = [...factories,...onNames,'object:TCPSocket.close','object:UDPSocket.close']
const policy = (on='full',off='full') => ({kind:'capabilities',capabilities:Object.fromEntries([
  ...registered.map(name=>[name,onNames.includes(name)?on:'full']),...offNames.map(name=>[name,off]),
  ['wx.onThemeChange','full'],['wx.offThemeChange','full'],
])})
function fixture(engine, producers=true) {
  const r=createAppServiceTestRealm(engine)
  r.transports.installHostEnvironment(policy())
  r.context.descriptors={apis:catalog.apis.filter(row=>
    (producers?registered:registered.filter(name=>!onNames.includes(name))).includes(row.name)),
    objectApis:catalog.apis.filter(row=>['TCPSocket','UDPSocket'].includes(row.receiver))}
  r.run('__container_install_host_services(descriptors)')
  const snapshot=()=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'finite-notification-snapshot'}))
  const emit=(entry,sequence='1',value={sample:1},extra={})=>r.transports.installHostEnvironment({
    kind:'finite-notification',api:entry.api,event:{subscriptionId:entry.id,objectId:entry.objectId,sequence,value,...extra},
  })
  const ack=id=>r.transports.installHostEnvironment({kind:'finite-notification-cancel-ack',subscriptionId:id})
  const calls=()=>r.json('__container_events.filter(e=>e.type==="api.call")')
  const settle=async(call,error=null)=>{
    r.context.settlement={id:call.id,error}
    r.run('__container_resolve_api(settlement.id,{},settlement.error)')
    await Promise.resolve();await Promise.resolve();await Promise.resolve()
  }
  return {...r,snapshot,emit,ack,calls,settle}
}

for (const engine of ['quickjs','v8']) {
  for (const [type,event] of pairs) {
    test(`${engine}/${type}.${event}: actual on authority, exact identity, both clear forms and object isolation`,()=>{
      const r=fixture(engine)
      r.run(`globalThis.a=wx.create${type}();globalThis.b=wx.create${type}();globalThis.trace=[];
        globalThis.first=function(v){trace.push('first:'+v.sample)};globalThis.second=function(v){trace.push('second:'+v.sample)};
        globalThis.on=a.on${event};globalThis.off=a.off${event};
        globalThis.returns=[on(first),on(second),on(first),b.on${event}(first)];`)
      assert.deepEqual(r.json('returns.map(value=>value===undefined)'),[true,true,true,true])
      const active=r.snapshot().active
      assert.equal(active.length,3)
      assert.equal(new Set(active.map(row=>row.id)).size,3)
      const a=active.filter(row=>row.objectId===active[0].objectId),b=active.find(row=>row.objectId!==active[0].objectId)
      const subscriptions=r.calls().filter(call=>call.name===`object:${type}.on${event}`)
      assert.equal(subscriptions.length,3)
      for (const row of subscriptions) assert.ok(active.some(entry=>entry.id===row.options.subscriptionId&&entry.objectId===row.options.objectId))
      assert.equal(r.run('off(function(){})'),undefined)
      for (const entry of active) r.emit(entry)
      assert.equal(r.run('off.call(b,first)'),undefined)
      for (const entry of active) r.emit(entry,'2')
      assert.deepEqual(r.json('trace'),['first:1','second:1','first:1','second:1','first:1'])
      assert.equal(r.run('off(undefined)'),undefined)
      assert.deepEqual(r.snapshot().active,[b])
      assert.deepEqual(r.snapshot().cancellations,a.map(entry=>entry.id))
      assert.equal(r.run('on(first)'),undefined)
      const current=r.snapshot().active.find(entry=>entry.objectId===a[0].objectId)
      assert.notEqual(current.id,a[0].id)
      assert.equal(r.run('off()'),undefined)
      r.emit(a[0],'3');r.emit(current,'1');r.emit(b,'3')
      assert.equal(r.json('trace').length,6)
      assert.equal(r.calls().filter(call=>call.name.endsWith('.close')||call.name.includes('.off')).length,0)
      for (const value of ['null','1','{}','[]']) {
        assert.throws(()=>r.run(`on(${value})`),/listener must be a function/)
        assert.throws(()=>r.run(`off(${value})`),/listener must be a function/)
      }
    })
  }

  test(`${engine}: own off admission is independent of producer and public capability maps`,()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createTCPSocket();globalThis.cb=function(){};globalThis.on=a.onMessage;globalThis.off=a.offMessage;on(cb)')
    const old=r.snapshot().active[0]
    r.transports.installHostEnvironment(policy('full','unsupported'))
    r.run("__container_capabilities['object:TCPSocket.offMessage']='full';a.offMessage=function(){}")
    assert.throws(()=>r.run('off(cb)'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.snapshot().active.length,1)
    r.transports.installHostEnvironment(policy('unsupported','full'))
    assert.deepEqual(r.snapshot().cancellations,[old.id])
    assert.equal(r.run('off()'),undefined)
    assert.throws(()=>r.run('on(cb)'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.snapshot().active.length,0)
  })

  test(`${engine}: missing producer descriptor rejects before identity allocation; off needs no provider`,()=>{
    const r=fixture(engine,false)
    r.run('globalThis.a=wx.createUDPSocket()')
    assert.equal(r.run('a.offMessage()'),undefined)
    assert.throws(()=>r.run('a.onMessage(null)'),/listener must be a function/)
    assert.throws(()=>r.run('a.onMessage(function(){})'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
    assert.deepEqual(r.snapshot(),{active:[],cancellations:[]})
    r.context.producers={apis:catalog.apis.filter(row=>onNames.includes(row.name)),objectApis:[]}
    r.run('__container_install_host_services(producers);a.onMessage(function(){})')
    assert.equal(r.snapshot().active[0].id,'finite-subscription-1')
  })

  test(`${engine}: typed ingress binds name, object, event and exact u64; mutable public ingress is unused`,()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createTCPSocket();globalThis.trace=[];a.onMessage(function(v){trace.push(v)});__container_receive_native_event=function(){throw Error("public ingress")}')
    const entry=r.snapshot().active[0]
    for (const seq of ['0','+1','01','18446744073709551616']) r.emit(entry,seq)
    r.emit({...entry,api:'object:UDPSocket.onMessage'})
    r.emit(entry,'1',{}, {objectId:null});r.emit(entry,'1',{}, {objectId:'native-object-2'});r.emit(entry,'1',{}, {event:'Error'})
    r.emit(entry,'9007199254740993',{message:{__weappBinary:{type:'ArrayBuffer',bytes:[0,128,255]}},remoteInfo:{address:'127.0.0.1',family:'IPv4',port:9000},localInfo:{address:'127.0.0.1',family:'IPv4',port:8000}})
    r.emit(entry,'9007199254740992',{stale:true})
    assert.deepEqual(r.json('Array.from(new Uint8Array(trace[0].message))'),[0,128,255])
    assert.equal(r.json('trace').length,1)
  })

  test(`${engine}: private removal survives poisoned public queues, transports and convenience methods`,()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createUDPSocket();globalThis.calls=0;globalThis.cb=function(){calls++};a.onError(cb);globalThis.off=a.offError')
    const entry=r.snapshot().active[0]
    r.run(`__container_receive_native_event=__container_api_call=function(){throw Error('public')};
      __container_events.length=0;Object.freeze(__container_events);Array.prototype.push=Array.prototype.splice=Object.create=Reflect.apply=function(){throw Error('poison')};off(cb)`)
    r.emit(entry)
    assert.equal(r.run('calls'),0)
    assert.deepEqual(r.snapshot().cancellations,[entry.id])
    assert.equal(r.ack(entry.id),true)
    assert.deepEqual(r.snapshot().cancellations,[])
  })

  test(`${engine}: failed factory retires only its owner; removal remains independently idempotent`,async()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createTCPSocket();globalThis.b=wx.createTCPSocket();globalThis.cb=function(){};a.onError(cb);b.onError(cb)')
    const before=r.snapshot().active
    await r.settle(r.calls().find(call=>call.name==='wx.createTCPSocket'),{code:'ERR_FACTORY',errMsg:'factory failed'})
    assert.deepEqual(r.snapshot().active,[before[1]])
    assert.deepEqual(r.snapshot().cancellations,[before[0].id])
    assert.throws(()=>r.run('a.onError(cb)'),e=>e.code==='ERR_FACTORY')
    assert.equal(r.run('a.offError(cb)'),undefined)
  })

  test(`${engine}: inherited setters cannot capture receiver records, private states or retirement hooks`,()=>{
    const r=fixture(engine)
    r.run(`globalThis.leaked=0;const originalDefine=Object.defineProperty;
      Object.defineProperty(Array.prototype,'0',{__proto__:null,configurable:true,set:function(value){
        if(value&&value.policy&&value.objectId)leaked++;
        originalDefine(this,'0',{__proto__:null,value:value,writable:true,configurable:true,enumerable:true});
      }});
      for(const name of ['value','retireFiniteNotifications'])Object.defineProperty(Object.prototype,name,{__proto__:null,configurable:true,set:function(value){
        if(this.type==='TCPSocket'&&this.id==='native-object-1')leaked++;
        originalDefine(this,name,{__proto__:null,value:value,writable:true,configurable:true,enumerable:true});
      }});
      globalThis.a=wx.createTCPSocket();a.onMessage(function(){});
      delete Array.prototype[0];delete Object.prototype.value;delete Object.prototype.retireFiniteNotifications;`)
    assert.equal(r.run('leaked'),0)
    assert.equal(r.snapshot().active.length,1)
  })

  test(`${engine}: private factory and UDP retirement hooks survive public Promise.then replacement`,async()=>{
    const r=fixture(engine)
    // Poison before hook attachment, then restore only the public raw fixture
    // resolver's scheduler. Native retirement under poisoned settlement is
    // independently exercised by the real Session suite.
    r.run('globalThis.originalThen=Promise.prototype.then;Promise.prototype.then=function(){throw Error("public then")};globalThis.a=wx.createUDPSocket();globalThis.b=wx.createTCPSocket();globalThis.cb=function(){};a.onMessage(cb);b.onMessage(cb);a.close();Promise.prototype.then=originalThen')
    assert.equal(r.snapshot().active.length,2)
    await r.settle(r.calls().find(call=>call.name==='object:UDPSocket.close'))
    await r.settle(r.calls().find(call=>call.name==='wx.createTCPSocket'),{code:'ERR_FACTORY'})
    assert.deepEqual(r.snapshot().active,[])
    assert.equal(r.snapshot().cancellations.length,2)
  })

  test(`${engine}: native object retirement revokes callbacks before public Promise resolution`,async()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createUDPSocket();globalThis.b=wx.createUDPSocket();globalThis.cb=function(){};a.onMessage(cb);b.onMessage(cb);__container_resolve_api=function(){throw Error("public resolver")}')
    const before=r.snapshot().active
    assert.equal(r.transports.installHostEnvironment({kind:'finite-notification-object-retire',objectId:before[0].objectId}),true)
    assert.deepEqual(r.snapshot().active,[before[1]])
    assert.deepEqual(r.snapshot().cancellations,[before[0].id])
    assert.throws(()=>r.run('a.onMessage(cb)'),e=>e.code==='ERR_CANCELLED')
    assert.equal(r.run('a.offMessage()'),undefined)
    const calls=r.calls().length
    await assert.rejects(r.run('a.close()'),error=>error.code==='ERR_CANCELLED')
    assert.equal(r.calls().length,calls)
    assert.equal(r.transports.installHostEnvironment({kind:'finite-notification-object-retire',objectId:before[0].objectId}),true)
    assert.deepEqual(r.snapshot().active,[before[1]])
    assert.deepEqual(r.snapshot().cancellations,[before[0].id])
  })

  test(`${engine}: UDP close succeeds after final Close; failed close and TCP close preserve live owners`,async()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createUDPSocket();globalThis.b=wx.createTCPSocket();globalThis.trace=[];a.onClose(function(){trace.push("udp-close")});a.onMessage(function(){trace.push("udp-message")});b.onMessage(function(){trace.push("tcp-message")})')
    const before=r.snapshot().active,udp=before.filter(entry=>entry.api.startsWith('object:UDPSocket.')),tcp=before.find(entry=>entry.api.startsWith('object:TCPSocket.'))
    r.run('a.close().catch(function(){})')
    const firstClose=r.calls().filter(call=>call.name==='object:UDPSocket.close').at(-1)
    await r.settle(firstClose,{code:'ERR_CLOSE',errMsg:'close failed'})
    assert.equal(r.snapshot().active.length,3)
    r.run('a.close();b.close()')
    r.emit(udp.find(entry=>entry.api.endsWith('onClose')))
    await r.settle(r.calls().filter(call=>call.name==='object:UDPSocket.close').at(-1))
    await r.settle(r.calls().find(call=>call.name==='object:TCPSocket.close'))
    assert.deepEqual(r.snapshot().active,[tcp])
    for (const entry of before) r.emit(entry,'2')
    assert.deepEqual(r.json('trace'),['udp-close','tcp-message'])
    assert.throws(()=>r.run('a.onMessage(function(){})'),e=>e.code==='ERR_CANCELLED')
    assert.equal(r.run('a.offMessage()'),undefined)
    assert.equal(r.run('b.onMessage(function(){})'),undefined)
  })

  test(`${engine}: same callback across event types and globals is isolated; stale completion cannot remove replacement`,async()=>{
    const r=fixture(engine)
    r.context.extra={apis:[catalog.apis.find(row=>row.name==='wx.onThemeChange')],objectApis:[]}
    r.run('__container_install_host_services(extra);globalThis.a=wx.createTCPSocket();globalThis.trace=[];globalThis.cb=function(v){trace.push(v)};a.onError(cb);a.onMessage(cb);wx.onThemeChange(cb)')
    const old=r.snapshot().active.find(entry=>entry.api==='object:TCPSocket.onError')
    r.run('a.offError(cb);a.onError(cb)')
    const current=r.snapshot().active.find(entry=>entry.api===old.api)
    assert.notEqual(old.id,current.id)
    await r.settle(r.calls().find(call=>call.options.subscriptionId===old.id),{code:'ERR_CANCELLED'})
    assert.equal(r.snapshot().active.length,3)
    r.emit(old);r.emit(current)
    assert.equal(r.json('trace').length,1)
  })

  test(`${engine}: terminal owner retirement cancels all object callbacks even when off grant is absent`,()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createTCPSocket();globalThis.b=wx.createUDPSocket();globalThis.calls=0;globalThis.cb=function(){calls++};a.onMessage(cb);b.onMessage(cb)')
    const before=r.snapshot().active
    r.transports.installHostEnvironment(policy('full','unsupported'))
    r.transports.dispatchLifecycleNotification('retire',{})
    r.transports.installHostEnvironment(policy())
    for (const entry of before) r.emit(entry)
    assert.equal(r.run('calls'),0)
    assert.deepEqual(new Set(r.snapshot().cancellations),new Set(before.map(entry=>entry.id)))
    assert.equal(r.run('a.offMessage()'),undefined)
    assert.throws(()=>r.run('a.onMessage(cb)'),e=>e.code==='ERR_CANCELLED')
  })
}
