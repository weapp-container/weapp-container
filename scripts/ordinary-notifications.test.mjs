import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

const events = ['ApiCategoryChange', 'AudioInterruptionBegin', 'AudioInterruptionEnd',
  'KeyboardHeightChange', 'LocalServiceDiscoveryStop', 'LocalServiceFound', 'LocalServiceLost',
  'LocalServiceResolveFail', 'MemoryWarning', 'ScreenRecordingStateChanged', 'ThemeChange',
  'VoIPChatInterrupted', 'VoIPChatMembersChanged', 'VoIPChatSpeakersChanged',
  'VoIPChatStateChanged', 'VoIPVideoMembersChanged', 'BatteryInfoChange',
  'BLEPeripheralConnectionStateChanged', 'DeviceMotionChange', 'NetworkWeakChange']
const catalog = JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url)))
const descriptors = catalog.apis.filter(row => events.some(event => row.name === 'wx.on' + event))
const policy = (on = 'full', off = 'full') => ({ kind:'capabilities', capabilities:Object.fromEntries(
  [...events.flatMap(event => [['wx.on' + event,on],['wx.off' + event,off]]),
    ['wx.onBeforePageLoad','full'],['wx.offBeforePageLoad','full']]) })
function fixture(engine, install = true) {
  const r = createAppServiceTestRealm(engine)
  r.transports.installHostEnvironment(policy())
  r.context.nativeDescriptors = { apis:[...descriptors, catalog.apis.find(row => row.name === 'wx.onBeforePageLoad')], objectApis:[] }
  if (install) r.run('__container_install_host_services(nativeDescriptors)')
  const snapshot = () => JSON.parse(r.transports.captureReceiverIncarnations({kind:'finite-notification-snapshot'}))
  const emit = (entry, sequence = '1', value = {sample:1}, extra = {}) => r.transports.installHostEnvironment({
    kind:'finite-notification', api:entry.api, event:{subscriptionId:entry.id,sequence,value,objectId:null,...extra},
  })
  const ack = id => r.transports.installHostEnvironment({kind:'finite-notification-cancel-ack',subscriptionId:id})
  return {...r,snapshot,emit,ack}
}

for (const engine of ['quickjs','v8']) {
  test(`${engine}: ordinary facades grant no undeclared authority`, () => {
    const r = createAppServiceTestRealm(engine)
    for (const event of events) {
      assert.throws(() => r.run(`wx.on${event}(function(){})`), e => e.code === 'ERR_UNSUPPORTED_CAPABILITY')
      assert.throws(() => r.run(`wx.off${event}()`), e => e.code === 'ERR_UNSUPPORTED_CAPABILITY')
    }
  })

  for (const event of events) {
    test(`${engine}/${event}: actual subscription, exact identity and both clear-all forms`, () => {
      const r = fixture(engine)
      r.run(`globalThis.trace=[];globalThis.first=function(v){trace.push('first:'+v.sample)};
        globalThis.second=function(v){trace.push('second:'+v.sample)};
        globalThis.on=wx.on${event};globalThis.off=wx.off${event};
        globalThis.returned=[on(first),on(second),on(first)];`)
      assert.deepEqual(r.json('returned.map(value=>value===undefined)'),[true,true,true])
      const active = r.snapshot().active
      assert.equal(active.length,2)
      const nativeCalls = r.json('__container_events.filter(event=>event.type==="api.call").map(event=>({name:event.name,options:event.options}))')
      assert.equal(nativeCalls.length,2)
      assert.equal(nativeCalls[0].name,'wx.on'+event)
      assert.equal(nativeCalls[0].options.subscriptionId,active[0].id)
      for (const entry of active) r.emit(entry)
      assert.equal(r.run('off(function(){})'),undefined)
      assert.equal(r.snapshot().active.length,2)
      assert.equal(r.run('off.call({fake:true},first)'),undefined)
      r.emit(active[0],'2');r.emit(active[1],'2')
      assert.deepEqual(r.json('trace'),['first:1','second:1','second:1'])
      assert.equal(r.run('off(undefined)'),undefined)
      assert.deepEqual(r.snapshot().active,[])
      for (const entry of active) r.emit(entry,'3')
      assert.deepEqual(r.json('trace'),['first:1','second:1','second:1'])
      assert.deepEqual(r.snapshot().cancellations,active.map(entry=>entry.id))
      r.ack(active[1].id)
      assert.equal(r.run('on(first)'),undefined)
      const current = r.snapshot().active[0]
      assert.notEqual(current.id,active[0].id)
      assert.equal(r.run('off()'),undefined)
      assert.deepEqual(r.snapshot().cancellations,[current.id])
      for (const value of ['null','1','{}','[]']) {
        assert.throws(() => r.run(`on(${value})`),/listener must be a function/)
        assert.throws(() => r.run(`off(${value})`),/listener must be a function/)
      }
    })
  }

  test(`${engine}: four device payloads survive retained delivery and removal has independent admission`, () => {
    const r = fixture(engine)
    const samples = {
      BatteryInfoChange: {isLowPowerModeEnabled:true},
      BLEPeripheralConnectionStateChanged: {connected:true,deviceId:'peer',serverId:'server'},
      DeviceMotionChange: {alpha:1.5,beta:-2,gamma:0.25},
      NetworkWeakChange: {weakNet:true,networkType:'wifi'},
    }
    r.context.samples = samples
    r.run(`globalThis.received={};globalThis.callbacks={};for(const event of Object.keys(samples)){
      const callback=function(value){received[event]=value};callbacks[event]=callback;wx['on'+event](callback);
    }`)
    const active = r.snapshot().active
    assert.equal(active.length,4)
    for (const entry of active) r.emit(entry,'1',samples[entry.api.slice(5)])
    assert.deepEqual(r.json('received'),samples)
    r.run("for(const event of Object.keys(samples))wx['off'+event](callbacks[event])")
    for (const entry of active) r.emit(entry,'2',{stale:true})
    assert.deepEqual(r.json('received'),samples)
    assert.deepEqual(new Set(r.snapshot().cancellations),new Set(active.map(entry=>entry.id)))
    r.transports.installHostEnvironment(policy('unsupported','full'))
    assert.equal(r.run('wx.offDeviceMotionChange()'),undefined)
    assert.throws(() => r.run('wx.onDeviceMotionChange(function(){})'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
  })

  test(`${engine}: Full and Partial producer policy survives while original ten keep their ceiling`, () => {
    const r = fixture(engine)
    for (const support of ['full','partial']) {
      r.transports.installHostEnvironment(policy(support,'partial'))
      for (const event of events) {
        assert.equal(r.run(`__container_capabilities['wx.on${event}']`),support)
        assert.equal(r.run(`__container_capability('wx.on${event}')`),support)
        assert.equal(r.run(`__container_capabilities['wx.off${event}']`),'partial')
      }
      assert.equal(r.run("__container_capabilities['wx.onBeforePageLoad']"),'partial')
    }
  })

  test(`${engine}: missing producer descriptor rejects before allocating identity or callback state`, () => {
    const r = fixture(engine,false)
    for (const event of events) {
      assert.throws(() => r.run(`wx.on${event}(null)`),/listener must be a function/)
      assert.throws(() => r.run(`wx.on${event}(function(){})`),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
    }
    assert.deepEqual(r.snapshot(),{active:[],cancellations:[]})
    r.run('__container_install_host_services(nativeDescriptors);wx.onThemeChange(function(){})')
    assert.equal(r.snapshot().active[0].id,'finite-subscription-1')
  })

  test(`${engine}: saved aliases keep independent grants despite public-map and facade changes`, () => {
    const r = fixture(engine)
    r.run('globalThis.trace=[];globalThis.on=wx.onThemeChange;globalThis.off=wx.offThemeChange;globalThis.cb=function(v){trace.push(v.sample)};on(cb)')
    const old = r.snapshot().active[0]
    r.transports.installHostEnvironment(policy('full','unsupported'))
    r.run("__container_capabilities['wx.offThemeChange']='full';wx.offThemeChange=function(){}")
    assert.throws(() => r.run('off(cb)'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
    r.emit(old)
    r.transports.installHostEnvironment(policy('unsupported','unsupported'))
    assert.deepEqual(r.snapshot().active,[])
    assert.deepEqual(r.snapshot().cancellations,[old.id])
    r.run("__container_capabilities['wx.onThemeChange']='full'")
    assert.throws(() => r.run('on(cb)'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
    r.transports.installHostEnvironment(policy())
    r.run('on(cb);off(cb)')
    r.emit(old,'2')
    assert.deepEqual(r.json('trace'),[1])
  })

  test(`${engine}: ordinary and original pairs share one owner with independent identities`, () => {
    const r = fixture(engine)
    r.run('globalThis.trace=[];globalThis.cb=function(v){trace.push(v.sample)};wx.onBeforePageLoad(cb);wx.onThemeChange(cb);wx.onMemoryWarning(cb)')
    const before = r.snapshot().active
    assert.equal(new Set(before.map(entry=>entry.id)).size,3)
    r.run('wx.offThemeChange(cb)')
    for (const entry of before) r.emit(entry)
    assert.deepEqual(r.json('trace'),[1,1])
    assert.equal(r.snapshot().active.length,2)
  })

  test(`${engine}: direct and foreign descriptor counterparts cannot replace owned facades`, () => {
    const r = fixture(engine)
    r.context.forged = {apis:[
      ...catalog.apis.filter(row => events.some(event => row.name === 'wx.off'+event)),
      {name:'wx.onForeign',kind:'subscription',owner:'host',counterpart:'wx.offMemoryWarning'},
    ],objectApis:[]}
    r.run('globalThis.on=wx.onMemoryWarning;globalThis.off=wx.offMemoryWarning;globalThis.calls=0;globalThis.cb=function(){calls++};on(cb);__container_install_host_services(forged)')
    assert.deepEqual(r.json('[on===wx.onMemoryWarning,off===wx.offMemoryWarning]'),[true,true])
    const entry = r.snapshot().active[0]
    r.emit(entry);r.run('off(cb)');r.emit(entry,'2')
    assert.equal(r.run('calls'),1)
  })

  test(`${engine}: exact native name, object, event and u64 sequence fences remain in the owner`, () => {
    const r = fixture(engine)
    r.run('globalThis.trace=[];wx.onVoIPChatStateChanged(function(v){trace.push(v.sample)})')
    const entry = r.snapshot().active[0]
    for (const seq of ['0','+1','01','18446744073709551616']) r.emit(entry,seq)
    r.emit({...entry,api:'wx.onVoIPChatMembersChanged'})
    r.emit(entry,'1',{sample:'foreign'},{objectId:'foreign'})
    r.emit(entry,'1',{sample:'wrong'},{event:'ThemeChange'})
    r.emit(entry,'9007199254740993',{sample:'valid'},{event:'VoIPChatStateChanged'})
    r.emit(entry,'9007199254740992',{sample:'old'})
    r.emit(entry,'18446744073709551615',{sample:'last'})
    assert.deepEqual(r.json('trace'),['valid','last'])
  })

  test(`${engine}: poisoned public effects and transports cannot retain removed native callbacks`, () => {
    const r = fixture(engine)
    r.run('globalThis.calls=0;globalThis.off=wx.offLocalServiceFound;globalThis.cb=function(){calls++};wx.onLocalServiceFound(cb)')
    const entry = r.snapshot().active[0]
    r.run(`globalThis.__container_receive_native_event=function(){throw Error('guest ingress')};
      globalThis.__container_api_call=function(){throw Error('guest transport')};
      __container_events.length=0;Object.freeze(__container_events);
      Array.prototype.push=Array.prototype.splice=Object.create=Reflect.apply=function(){throw Error('poison')};off(cb)`)
    r.emit(entry)
    assert.equal(r.run('calls'),0)
    assert.deepEqual(r.snapshot().cancellations,[entry.id])
    assert.equal(r.ack(entry.id),true)
  })

  test(`${engine}: callback removal and re-add uses a fresh identity even when the callback throws`, () => {
    const r = fixture(engine)
    r.run("globalThis.calls=0;globalThis.cb=function(){calls++;wx.offAudioInterruptionBegin(cb);wx.onAudioInterruptionBegin(cb);throw Error('listener')};wx.onAudioInterruptionBegin(cb)")
    const old = r.snapshot().active[0]
    r.emit(old)
    const current = r.snapshot().active[0]
    assert.notEqual(current.id,old.id)
    r.emit(old,'2')
    assert.equal(r.run('calls'),1)
  })

  test(`${engine}: terminal retirement cancels ordinary registrations despite off withdrawal`, () => {
    const r = fixture(engine)
    r.run('globalThis.calls=0;globalThis.on=wx.onScreenRecordingStateChanged;globalThis.cb=function(){calls++};on(cb)')
    const old = r.snapshot().active[0]
    r.transports.installHostEnvironment(policy('full','unsupported'))
    r.transports.dispatchLifecycleNotification('retire',{})
    r.transports.installHostEnvironment(policy())
    r.emit(old)
    assert.equal(r.run('calls'),0)
    assert.deepEqual(r.snapshot().cancellations,[old.id])
    assert.throws(() => r.run('on(cb)'),/notifications are retired/)
  })
}
