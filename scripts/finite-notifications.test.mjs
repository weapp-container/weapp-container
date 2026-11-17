import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

const events = ['AfterPageLoad', 'AppRouteDone', 'BeforePageLoad', 'CopyUrl',
  'EmbeddedMiniProgramHeightChange', 'LazyLoadError', 'MenuButtonBoundingClientRectWeightChange',
  'ParallelStateChange', 'UserOffTranslation', 'UserTriggerTranslation']
const catalog = JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url)))
const descriptors = catalog.apis.filter(row => events.some(event => row.name === 'wx.on' + event))
const policy = (on = 'full', off = 'full') => ({ kind:'capabilities', capabilities:Object.fromEntries(
  events.flatMap(event => [['wx.on' + event,on],['wx.off' + event,off]])) })
function fixture(engine, install = true) {
  const r = createAppServiceTestRealm(engine)
  r.transports.installHostEnvironment(policy())
  r.context.nativeDescriptors = { apis:descriptors, objectApis:[] }
  if (install) r.run('__container_install_host_services(nativeDescriptors)')
  const snapshot = () => JSON.parse(r.transports.captureReceiverIncarnations({kind:'finite-notification-snapshot'}))
  const emit = (entry, sequence = '1', value = {sample:1}, extra = {}) => r.transports.installHostEnvironment({
    kind:'finite-notification', api:entry.api, event:{subscriptionId:entry.id,sequence,value,objectId:null,...extra},
  })
  const ack = id => r.transports.installHostEnvironment({kind:'finite-notification-cancel-ack',subscriptionId:id})
  return {...r,snapshot,emit,ack}
}

for (const engine of ['quickjs','v8']) {
  test(`${engine}: bootstrap methods grant no undeclared authority`, () => {
    const r = createAppServiceTestRealm(engine)
    for (const event of events) {
      assert.throws(() => r.run(`wx.on${event}(function(){})`), e => e.code === 'ERR_UNSUPPORTED_CAPABILITY')
      assert.throws(() => r.run(`wx.off${event}()`), e => e.code === 'ERR_UNSUPPORTED_CAPABILITY')
    }
    assert.equal(r.run('typeof __container_bind_finite_notifications'),'undefined')
  })

  for (const event of events) {
    test(`${engine}/${event}: actual native registration, exact-function cleanup and no-argument cleanup`, () => {
      const r = fixture(engine)
      r.run(`globalThis.trace=[];globalThis.first=function(v){trace.push('first:'+v.sample)};
        globalThis.second=function(v){trace.push('second:'+v.sample)};
        globalThis.savedOn=wx.on${event};globalThis.savedOff=wx.off${event};
        globalThis.returned=[savedOn(first),savedOn(second),savedOn(first)];`)
      assert.deepEqual(r.json('returned.map(value=>value===undefined)'),[true,true,true])
      const active = r.snapshot().active
      assert.equal(active.length,2)
      for (const entry of active) r.emit(entry)
      assert.deepEqual(r.json('trace'),['first:1','second:1'])
      assert.equal(r.run('savedOff(function(){})'),undefined)
      if (event === 'CopyUrl') {
        assert.deepEqual(r.snapshot().active,[])
        assert.equal(r.snapshot().cancellations.length,2)
      } else {
        assert.equal(r.snapshot().active.length,2)
        assert.equal(r.run('savedOff(first)'),undefined)
        assert.equal(r.snapshot().active.length,1)
        r.emit(active[0],'2')
        r.emit(active[1],'2')
        assert.deepEqual(r.json('trace'),['first:1','second:1','second:1'])
        assert.equal(r.run('savedOff(undefined)'),undefined)
        assert.deepEqual(r.snapshot().active,[])
      }
      for (const entry of active) r.emit(entry,'3')
      const pending = r.snapshot().cancellations
      assert.equal(pending.length,2)
      assert.deepEqual(r.snapshot().cancellations,pending,'capture does not consume cancellations')
      assert.equal(r.ack('finite-subscription-999999'),false)
      assert.equal(r.ack(pending[0]),true)
      assert.deepEqual(r.snapshot().cancellations,pending.slice(1))
      assert.equal(r.ack(pending[1]),true)
      assert.equal(r.run('savedOff()'),undefined)
      assert.deepEqual(r.snapshot(),{active:[],cancellations:[]})
    })
  }

  test(`${engine}: listener argument validation and CopyUrl's argument-independent clear-all`, () => {
    const r = fixture(engine)
    for (const event of events) {
      for (const value of ['null','1','{}','[]']) {
        assert.throws(() => r.run(`wx.on${event}(${value})`),/listener must be a function/)
        if (event === 'CopyUrl') assert.equal(r.run(`wx.off${event}(${value})`),undefined)
        else assert.throws(() => r.run(`wx.off${event}(${value})`),/listener must be a function/)
      }
    }
    r.run('function a(){};function b(){};wx.onCopyUrl(a);wx.onCopyUrl(b);wx.offCopyUrl(a)')
    assert.deepEqual(r.snapshot().active,[])
  })

  test(`${engine}: same function in different event pairs retains independent identities`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];globalThis.callback=function(v){trace.push(v.sample)};
      wx.onBeforePageLoad(callback);wx.onAfterPageLoad(callback);wx.offBeforePageLoad(callback);`)
    const snapshot = r.snapshot()
    assert.equal(snapshot.active.length,1)
    assert.equal(snapshot.active[0].api,'wx.onAfterPageLoad')
    assert.equal(snapshot.cancellations.length,1)
    r.emit(snapshot.active[0])
    assert.deepEqual(r.json('trace'),[1])
  })

  test(`${engine}: saved aliases preserve independent on/off policy and reject public-map grants`, () => {
    const r = fixture(engine)
    r.run('globalThis.trace=[];globalThis.on=wx.onBeforePageLoad;globalThis.off=wx.offBeforePageLoad;globalThis.cb=function(v){trace.push(v.sample)};on(cb)')
    const entry = r.snapshot().active[0]
    r.transports.installHostEnvironment(policy('partial','unsupported'))
    assert.throws(() => r.run('off()'),e => e.code === 'ERR_UNSUPPORTED_CAPABILITY')
    r.run("__container_capabilities['wx.offBeforePageLoad']='full'")
    assert.throws(() => r.run('off(cb)'),e => e.code === 'ERR_UNSUPPORTED_CAPABILITY')
    r.emit(entry)
    r.transports.installHostEnvironment(policy('partial','partial'))
    assert.equal(r.run("__container_capabilities['wx.offBeforePageLoad']"),'partial')
    assert.equal(r.run('off(cb)'),undefined)
    r.transports.installHostEnvironment(policy('unsupported','full'))
    r.run("__container_capabilities['wx.onBeforePageLoad']='full'")
    assert.throws(() => r.run('on(cb)'),e => e.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.run('off()'),undefined)
    r.emit(entry,'2')
    assert.deepEqual(r.json('trace'),[1])
  })

  test(`${engine}: trusted on withdrawal clears callbacks and private pending resources`, () => {
    const r = fixture(engine)
    r.run('globalThis.trace=[];globalThis.cb=function(){trace.push(1)};wx.onAppRouteDone(cb)')
    const old = r.snapshot().active[0]
    r.transports.installHostEnvironment(policy('unsupported','full'))
    assert.deepEqual(r.snapshot().active,[])
    assert.deepEqual(r.snapshot().cancellations,[old.id])
    r.transports.installHostEnvironment(policy())
    r.run('wx.onAppRouteDone(cb)')
    const current = r.snapshot().active[0]
    assert.notEqual(current.id,old.id)
    r.emit(old);r.emit(current)
    assert.deepEqual(r.json('trace'),[1])
  })

  test(`${engine}: payload/name/object/sequence fences reject stale and foreign deliveries`, () => {
    const r = fixture(engine)
    r.run('globalThis.trace=[];wx.onLazyLoadError(function(v){trace.push(v.sample)})')
    const entry = r.snapshot().active[0]
    for (const next of ['0','01','-1','x','18446744073709551616','900719925474099300000']) r.emit(entry,next)
    r.emit({...entry,api:'wx.onBeforePageLoad'})
    r.emit({...entry,id:'native-subscription-1'})
    r.emit(entry,'1',{sample:'foreign'},{objectId:'foreign'})
    r.emit(entry,'1',{sample:'wrong event'},{event:'BeforePageLoad'})
    r.emit(entry,'9007199254740993',{sample:'valid'},{event:'LazyLoadError'})
    r.emit(entry,'9007199254740993',{sample:'duplicate'})
    r.emit(entry,'9007199254740992',{sample:'older'})
    r.emit(entry,'18446744073709551615',{sample:'last'})
    assert.deepEqual(r.json('trace'),['valid','last'])
  })

  test(`${engine}: descriptor replacement and foreign counterparts cannot replace either facade`, () => {
    const r = fixture(engine)
    r.context.forged = {apis:[
      ...catalog.apis.filter(row => events.some(event => row.name === 'wx.off'+event)),
      {name:'wx.onForeign',kind:'subscription',owner:'host',counterpart:'wx.offLazyLoadError'},
    ],objectApis:[]}
    r.run(`globalThis.trace=[];globalThis.on=wx.onLazyLoadError;globalThis.off=wx.offLazyLoadError;
      globalThis.cb=function(){trace.push('real')};on(cb);__container_install_host_services(forged);`)
    assert.deepEqual(r.json('[on===wx.onLazyLoadError,off===wx.offLazyLoadError]'),[true,true])
    const entry = r.snapshot().active[0]
    r.emit(entry);r.run('off(cb)');r.emit(entry,'2')
    assert.deepEqual(r.json('trace'),['real'])
  })

  test(`${engine}: registration made before native descriptor installation joins the same owner`, () => {
    const r = fixture(engine,false)
    r.run('globalThis.calls=0;globalThis.cb=function(){calls++};wx.onParallelStateChange(cb)')
    assert.deepEqual(r.snapshot(),{active:[],cancellations:[]})
    r.run('__container_install_host_services(nativeDescriptors)')
    const entry = r.snapshot().active[0]
    r.emit(entry);r.run('wx.offParallelStateChange(cb)');r.emit(entry,'2')
    assert.equal(r.run('calls'),1)
    assert.deepEqual(r.snapshot().cancellations,[entry.id])
  })

  test(`${engine}: public transport/prototype poisoning cannot retain callbacks or erase cancellation`, () => {
    const r = fixture(engine)
    r.run('globalThis.calls=0;globalThis.on=wx.onUserTriggerTranslation;globalThis.off=wx.offUserTriggerTranslation;globalThis.cb=function(){calls++};on(cb)')
    const entry = r.snapshot().active[0]
    r.run(`wx.onUserTriggerTranslation=function(){};wx.offUserTriggerTranslation=function(){throw Error('fake')};
      globalThis.__container_receive_native_event=function(){throw Error('fake ingress')};
      globalThis.__container_api_call=function(){throw Error('fake transport')};
      __container_events.length=0;Object.freeze(__container_events);
      Array.prototype.push=Array.prototype.slice=Array.prototype.splice=function(){throw Error('poison')};
      Object.create=Object.defineProperty=Object.getOwnPropertyDescriptor=Reflect.apply=function(){throw Error('poison')};
      off(cb);`)
    r.emit(entry)
    assert.equal(r.run('calls'),0)
    assert.deepEqual(r.snapshot(),{active:[],cancellations:[entry.id]})
    assert.equal(r.ack(entry.id),true)
    assert.deepEqual(r.snapshot(),{active:[],cancellations:[]})
  })

  test(`${engine}: native callbacks isolate failures and off/re-add cannot receive an old identity`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];globalThis.cb=function(){trace.push('called');wx.offUserOffTranslation(cb);wx.onUserOffTranslation(cb);throw Error('listener')};wx.onUserOffTranslation(cb)`)
    const old = r.snapshot().active[0]
    r.emit(old)
    const current = r.snapshot().active[0]
    assert.notEqual(current.id,old.id)
    r.emit(old,'2')
    assert.deepEqual(r.json('trace'),['called'])
  })

  test(`${engine}: private cancellation storage is reserved at registration and released only by ACK`, () => {
    const r = fixture(engine)
    r.run('globalThis.callbacks=[];for(let i=0;i<4096;i++){const cb=function(){};callbacks.push(cb);wx.onBeforePageLoad(cb)}')
    assert.equal(r.snapshot().active.length,4096)
    assert.throws(() => r.run('wx.onBeforePageLoad(function(){})'),/registration budget exceeded/)
    assert.equal(r.run('wx.offBeforePageLoad()'),undefined)
    const cancelled = r.snapshot().cancellations
    assert.equal(cancelled.length,4096)
    assert.throws(() => r.run('wx.onBeforePageLoad(function(){})'),/registration budget exceeded/)
    r.ack(cancelled.at(-1))
    assert.equal(r.run('wx.onBeforePageLoad(function(){})'),undefined)
    assert.equal(r.snapshot().active.length,1)
  })

  test(`${engine}: terminal retirement is permanent across capability reinstallation`, () => {
    const r = fixture(engine)
    r.run('globalThis.trace=[];globalThis.on=wx.onBeforePageLoad;globalThis.off=wx.offBeforePageLoad;on(function(){trace.push(1)})')
    const entry = r.snapshot().active[0]
    r.transports.dispatchLifecycleNotification('retire',{})
    r.transports.installHostEnvironment(policy())
    r.emit(entry)
    assert.deepEqual(r.json('trace'),[])
    assert.deepEqual(r.snapshot().cancellations,[entry.id])
    assert.throws(() => r.run('on(function(){})'),/notifications are retired/)
    assert.equal(r.run('off()'),undefined)
  })
}
