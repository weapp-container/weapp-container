import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

const events = ['Canplay','Ended','Error','Pause','Play','Seeked','Seeking','Stop','TimeUpdate','Waiting']
const catalog = JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url)))
const onNames = events.map(event=>`object:InnerAudioContext.on${event}`)
const offNames = events.map(event=>`object:InnerAudioContext.off${event}`)
const controls = ['play','pause','stop','seek','destroy','src','volume','playbackRate','currentTime']
const registered = ['wx.createInnerAudioContext',...onNames,...controls.map(key=>`object:InnerAudioContext.${key}`)]
const policy = (on='full',off='full') => ({kind:'capabilities',capabilities:Object.fromEntries([
  ...registered.map(name=>[name,onNames.includes(name)?on:'full']),...offNames.map(name=>[name,off]),
])})

function fixture(engine, producers=true) {
  const r=createAppServiceTestRealm(engine)
  r.transports.installHostEnvironment(policy())
  // Runtime normalization removes compatibility-only off names from actual
  // installed descriptors. Native configuration tests cover that boundary.
  r.context.descriptors={apis:catalog.apis.filter(row=>(producers?registered:registered.filter(name=>!onNames.includes(name))).includes(row.name)),
    objectApis:catalog.apis.filter(row=>row.receiver==='InnerAudioContext')}
  r.run('__container_install_host_services(descriptors)')
  const snapshot=()=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'finite-notification-snapshot'}))
  const emit=(entry,sequence='1',value={sample:1},extra={})=>r.transports.installHostEnvironment({
    kind:'finite-notification',api:entry.api,event:{subscriptionId:entry.id,objectId:entry.objectId,sequence,value,...extra},
  })
  const calls=()=>r.json('__container_events.filter(e=>e.type==="api.call")')
  const settle=async(call,error=null)=>{
    r.context.settlement={id:call.id,error}
    r.run('__container_resolve_api(settlement.id,{},settlement.error)')
    await Promise.resolve();await Promise.resolve();await Promise.resolve()
  }
  return {...r,snapshot,emit,calls,settle}
}

for (const engine of ['quickjs','v8']) {
  for (const event of events) {
    test(`${engine}/InnerAudioContext.${event}: exact callback, sync void, remove-all and receiver isolation`,()=>{
      const r=fixture(engine)
      r.run(`globalThis.a=wx.createInnerAudioContext();globalThis.b=wx.createInnerAudioContext();globalThis.trace=[];
        globalThis.first=function(value){trace.push('first:'+value.sample)};globalThis.second=function(value){trace.push('second:'+value.sample)};
        globalThis.on=a.on${event};globalThis.off=a.off${event};
        globalThis.returns=[on(first),on(second),on(first),b.on${event}(first)];`)
      assert.deepEqual(r.json('returns.map(value=>value===undefined)'),[true,true,true,true])
      const active=r.snapshot().active
      assert.equal(active.length,3)
      const own=active.filter(entry=>entry.objectId===active[0].objectId),other=active.find(entry=>entry.objectId!==active[0].objectId)
      for(const entry of active)r.emit(entry)
      assert.equal(r.run('off(function(){})'),undefined)
      assert.equal(r.run('off.call(b,first)'),undefined)
      for(const entry of active)r.emit(entry,'2')
      assert.deepEqual(r.json('trace'),['first:1','second:1','first:1','second:1','first:1'])
      assert.equal(r.run('off(undefined)'),undefined)
      assert.deepEqual(r.snapshot().active,[other])
      assert.deepEqual(r.snapshot().cancellations,own.map(entry=>entry.id))
      r.run('on(first)')
      const current=r.snapshot().active.find(entry=>entry.objectId===own[0].objectId)
      assert.notEqual(current.id,own[0].id)
      assert.equal(r.run('off()'),undefined)
      r.emit(own[0],'3');r.emit(current);r.emit(other,'3')
      assert.equal(r.json('trace').length,6)
      assert.equal(r.calls().filter(call=>call.name.includes('.off')||call.name.endsWith('.destroy')||call.name.endsWith('.stop')).length,0)
      for(const value of ['null','1','{}','[]']){
        assert.throws(()=>r.run(`on(${value})`),/listener must be a function/)
        assert.throws(()=>r.run(`off(${value})`),/listener must be a function/)
      }
    })
  }

  test(`${engine}: saved off uses its own grant; denying on revokes existing callbacks`,()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createInnerAudioContext();globalThis.cb=function(){};globalThis.on=a.onPlay;globalThis.off=a.offPlay;on(cb)')
    const old=r.snapshot().active[0]
    r.transports.installHostEnvironment(policy('full','unsupported'))
    r.run("__container_capabilities['object:InnerAudioContext.offPlay']='full';a.offPlay=function(){}")
    assert.throws(()=>r.run('off(cb)'),error=>error.code==='ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.snapshot().active.length,1)
    r.transports.installHostEnvironment(policy('unsupported','full'))
    assert.equal(r.run('off()'),undefined)
    assert.deepEqual(r.snapshot().cancellations,[old.id])
    assert.throws(()=>r.run('on(cb)'),error=>error.code==='ERR_UNSUPPORTED_CAPABILITY')
  })

  test(`${engine}: no producer descriptor allocates no listener identity and off needs no producer`,()=>{
    const r=fixture(engine,false)
    r.run('globalThis.a=wx.createInnerAudioContext()')
    assert.equal(r.run('a.offError()'),undefined)
    assert.throws(()=>r.run('a.onError(null)'),/listener must be a function/)
    assert.throws(()=>r.run('a.onError(function(){})'),error=>error.code==='ERR_UNSUPPORTED_CAPABILITY')
    assert.deepEqual(r.snapshot(),{active:[],cancellations:[]})
    r.context.producers={apis:catalog.apis.filter(row=>onNames.includes(row.name)),objectApis:[]}
    r.run('__container_install_host_services(producers);a.onError(function(){})')
    assert.equal(r.snapshot().active[0].id,'finite-subscription-1')
  })

  test(`${engine}: receiver/event/exact sequence fences reject malformed payload before decoding`,()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createInnerAudioContext();globalThis.trace=[];a.onTimeUpdate(function(value){trace.push(value)})')
    const entry=r.snapshot().active[0],malformed={__weappBinary:{type:'ArrayBuffer',bytes:'not-bytes'}}
    for(const seq of ['0','01','+1','18446744073709551616'])assert.doesNotThrow(()=>r.emit(entry,seq,malformed))
    assert.doesNotThrow(()=>r.emit({...entry,api:'object:InnerAudioContext.onError'},'1',malformed))
    assert.doesNotThrow(()=>r.emit(entry,'1',malformed,{objectId:'native-object-999'}))
    assert.doesNotThrow(()=>r.emit(entry,'1',malformed,{event:'Play'}))
    r.emit(entry,'9007199254740993',{actual:1});r.emit(entry,'9007199254740992',malformed)
    assert.deepEqual(r.json('trace'),[{actual:1}])
  })

  test(`${engine}: private cancellation survives poisoned public transports, queues and intrinsics`,()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createInnerAudioContext();globalThis.count=0;globalThis.cb=function(){count++};a.onWaiting(cb);globalThis.off=a.offWaiting')
    const entry=r.snapshot().active[0]
    r.run(`__container_api_call=__container_receive_native_event=function(){throw Error('public transport')};
      __container_events.length=0;Object.freeze(__container_events);Array.prototype.push=Array.prototype.splice=Object.create=Reflect.apply=function(){throw Error('public intrinsic')};off(cb)`)
    r.emit(entry)
    assert.equal(r.run('count'),0)
    assert.deepEqual(r.snapshot().cancellations,[entry.id])
    assert.equal(r.transports.installHostEnvironment({kind:'finite-notification-cancel-ack',subscriptionId:entry.id}),true)
    assert.deepEqual(r.snapshot().cancellations,[])
  })

  test(`${engine}: failed factory private hooks retire only that receiver`,async()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createInnerAudioContext();globalThis.b=wx.createInnerAudioContext();globalThis.cb=function(){};a.onError(cb);b.onError(cb)')
    const before=r.snapshot().active
    await r.settle(r.calls().find(call=>call.name==='wx.createInnerAudioContext'),{code:'ERR_FACTORY'})
    assert.deepEqual(r.snapshot().active,[before[1]])
    assert.deepEqual(r.snapshot().cancellations,[before[0].id])
    assert.throws(()=>r.run('a.onError(cb)'),error=>error.code==='ERR_FACTORY')
    assert.equal(r.run('a.offError()'),undefined)
  })

  test(`${engine}: destroy fences immediately and host failure cannot revive the closed owner`,async()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createInnerAudioContext();globalThis.b=wx.createInnerAudioContext();globalThis.count=0;globalThis.cb=function(){count++};a.onPlay(cb);a.onError(cb);b.onPlay(cb)')
    const before=r.snapshot().active
    r.run('a.destroy().catch(function(){})')
    assert.deepEqual(r.snapshot().active,[before[2]])
    assert.deepEqual(r.snapshot().cancellations,before.slice(0,2).map(entry=>entry.id))
    for(const entry of before)r.emit(entry)
    assert.equal(r.run('count'),1)
    assert.throws(()=>r.run('a.onPlay(cb)'),error=>error.code==='ERR_CANCELLED')
    await r.settle(r.calls().find(call=>call.name==='object:InnerAudioContext.destroy'),{code:'ERR_DESTROY'})
    assert.deepEqual(r.snapshot().active,[before[2]])
    assert.throws(()=>r.run('a.onPlay(cb)'),error=>error.code==='ERR_CANCELLED')
    assert.equal(r.run('a.offPlay()'),undefined)
  })

  test(`${engine}: retained retirement acknowledges destroy twice without replaying cancellation or touching another owner`,async()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createInnerAudioContext();globalThis.b=wx.createInnerAudioContext();globalThis.count=0;globalThis.cb=function(){count++};a.onPlay(cb);b.onPlay(cb)')
    const before=r.snapshot().active
    r.run('a.destroy().catch(function(){})')
    const pending=r.snapshot(),calls=r.calls().length
    assert.deepEqual(pending.active,[before[1]])
    assert.deepEqual(pending.cancellations,[before[0].id])
    for(let index=0;index<2;index++)assert.equal(r.transports.installHostEnvironment({kind:'finite-notification-object-retire',objectId:before[0].objectId}),true)
    assert.deepEqual(r.snapshot(),pending)
    assert.equal(r.calls().length,calls)
    assert.equal(r.run('count'),0)
    await r.settle(r.calls().find(call=>call.name==='object:InnerAudioContext.destroy'))
    assert.deepEqual(r.snapshot(),pending)
    for(const entry of before)r.emit(entry)
    assert.equal(r.run('count'),1)
    assert.throws(()=>r.run('a.onPlay(cb)'),error=>error.code==='ERR_CANCELLED')
  })

  test(`${engine}: retained retirement rejects malformed identities and acknowledges absent canonical u64 identities without effects`,()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createInnerAudioContext();globalThis.count=0;a.onPlay(function(){count++})')
    const before=r.snapshot(),calls=r.calls().length
    for(const objectId of [undefined,null,1,{},'', 'foreign-1','native-object-','native-object-0','native-object-01','native-object-+1','native-object-１','native-object-1 ','native-object-18446744073709551616']){
      assert.equal(r.transports.installHostEnvironment({kind:'finite-notification-object-retire',objectId}),false)
    }
    // IDs stay strings at the retained boundary, including values beyond the
    // safe Number range; validation shares the exact attachObject u64 grammar.
    for(const objectId of ['native-object-2','native-object-9007199254740993','native-object-18446744073709551615']){
      assert.equal(r.transports.installHostEnvironment({kind:'finite-notification-object-retire',objectId}),true)
    }
    assert.deepEqual(r.snapshot(),before)
    assert.equal(r.calls().length,calls)
    assert.equal(r.run('count'),0)
    r.emit(before.active[0])
    assert.equal(r.run('count'),1)
  })

  test(`${engine}: play/pause/stop/seek and writable properties preserve callback ownership`,()=>{
    const r=fixture(engine)
    r.run(`globalThis.a=wx.createInnerAudioContext();globalThis.count=0;a.onPlay(function(){count++});
      a.play();a.pause();a.stop();a.seek(2);a.src='track.wav';a.volume=.25;a.playbackRate=1.5;a.currentTime=3;`)
    const active=r.snapshot().active
    assert.equal(active.length,1)
    assert.deepEqual(r.snapshot().cancellations,[])
    r.emit(active[0])
    assert.equal(r.run('count'),1)
    assert.equal(r.run('a.volume'),.25)
    assert.equal(r.run('a.playbackRate'),1.5)
  })

  test(`${engine}: typed native retirement precedes replaced public resolver and is receiver-local`,()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createInnerAudioContext();globalThis.b=wx.createInnerAudioContext();globalThis.count=0;globalThis.cb=function(){count++};a.onCanplay(cb);b.onCanplay(cb);__container_resolve_api=function(){throw Error("public resolver")}')
    const before=r.snapshot().active
    assert.equal(r.transports.installHostEnvironment({kind:'finite-notification-object-retire',objectId:before[0].objectId}),true)
    assert.deepEqual(r.snapshot().active,[before[1]])
    assert.deepEqual(r.snapshot().cancellations,[before[0].id])
    for(const entry of before)r.emit(entry)
    assert.equal(r.run('count'),1)
    assert.equal(r.run('a.offCanplay()'),undefined)
    assert.throws(()=>r.run('a.onCanplay(cb)'),error=>error.code==='ERR_CANCELLED')
  })

  test(`${engine}: poisoned Promise.then cannot retain destroy or failed-factory private hooks`,async()=>{
    const r=fixture(engine)
    r.run(`globalThis.originalThen=Promise.prototype.then;Promise.prototype.then=function(){throw Error('public then')};
      globalThis.a=wx.createInnerAudioContext();globalThis.b=wx.createInnerAudioContext();globalThis.cb=function(){};
      a.onEnded(cb);b.onEnded(cb);a.destroy();Promise.prototype.then=originalThen;`)
    assert.equal(r.snapshot().active.length,1)
    await r.settle(r.calls().filter(call=>call.name==='wx.createInnerAudioContext')[1],{code:'ERR_FACTORY'})
    assert.deepEqual(r.snapshot().active,[])
    assert.equal(r.snapshot().cancellations.length,2)
  })

  test(`${engine}: terminal retirement cancels without off grant and regrant cannot revive an owner`,()=>{
    const r=fixture(engine)
    r.run('globalThis.a=wx.createInnerAudioContext();globalThis.count=0;globalThis.cb=function(){count++};a.onSeeked(cb);a.onSeeking(cb)')
    const before=r.snapshot().active
    r.transports.installHostEnvironment(policy('full','unsupported'))
    r.transports.dispatchLifecycleNotification('retire',{})
    r.transports.installHostEnvironment(policy())
    assert.deepEqual(r.snapshot().active,[])
    assert.deepEqual(new Set(r.snapshot().cancellations),new Set(before.map(entry=>entry.id)))
    for(const entry of before)r.emit(entry)
    assert.equal(r.run('count'),0)
    assert.equal(r.run('a.offSeeked()'),undefined)
    assert.throws(()=>r.run('a.onSeeked(cb)'),error=>error.code==='ERR_CANCELLED')
  })
}
