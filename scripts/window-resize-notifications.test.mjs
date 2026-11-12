import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

// These are exact production bootstrap compositions in Node VM. The retained
// native transport is called explicitly here; actual host resize delivery is
// covered by the separate, not-yet-executed native Session test source.
const names = ['wx.onWindowResize', 'wx.offWindowResize']
const catalog = JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url)))
const descriptors = catalog.apis.filter(row => names.includes(row.name))
const policy = (on = 'full', off = 'full') => ({ kind: 'capabilities', capabilities: {
  'wx.onWindowResize': on, 'wx.offWindowResize': off,
} })
const dimensions = (width = 800, height = 400) => ({ size: { windowWidth: width, windowHeight: height } })
function fixture(engine) {
  const realm = createAppServiceTestRealm(engine)
  realm.transports.installHostEnvironment(policy())
  return { ...realm, resize: value => realm.transports.dispatchLifecycleNotification('windowResize', value ?? dimensions()) }
}

for (const engine of ['quickjs', 'v8']) {
  test(`${engine}: no undeclared resize listener grant is added at bootstrap`, () => {
    const r = createAppServiceTestRealm(engine)
    assert.deepEqual(r.json("[wx.canIUse('onWindowResize'),wx.canIUse('offWindowResize')]"), [false, false])
    assert.throws(() => r.run('wx.onWindowResize(function(){})'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.throws(() => r.run('wx.offWindowResize()'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.transports.dispatchLifecycleNotification('windowResize', dimensions()), false)
  })

  test(`${engine}: exact-function and omitted removal operate on one private list`, () => {
    const r = fixture(engine)
    assert.deepEqual(r.json(`(function(){
      globalThis.trace=[];globalThis.first=function(e){trace.push('first:'+e.size.windowWidth)};
      globalThis.second=function(e){trace.push('second:'+e.size.windowWidth)};
      return [wx.onWindowResize(first),wx.onWindowResize(second),wx.onWindowResize(first),
        wx.offWindowResize(function(){})].map(value=>value===undefined);
    })()`), [true,true,true,true])
    assert.equal(r.resize(), true)
    assert.equal(r.run('wx.offWindowResize(first)'), undefined)
    r.resize(dimensions(640,480))
    assert.equal(r.run('wx.offWindowResize()'), undefined)
    r.resize(dimensions(500,300))
    assert.deepEqual(r.json('trace'), ['first:800','second:800','second:640'])
    assert.equal(r.run('wx.offWindowResize(undefined)'), undefined)
    for (const value of ['null','1','{}','[]']) {
      assert.throws(() => r.run(`wx.onWindowResize(${value})`), /callback must be a function/)
      assert.throws(() => r.run(`wx.offWindowResize(${value})`), /callback must be a function/)
    }
  })

  test(`${engine}: each listener receives exactly the locked result shape and a fresh size`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];wx.onWindowResize(function(event){
      trace.push({keys:Object.keys(event),sizeKeys:Object.keys(event.size),width:event.size.windowWidth,height:event.size.windowHeight,receiver:this===globalThis});
      event.size.windowWidth=-1;event.extra='guest';
    });wx.onWindowResize(function(event){trace.push(event)});`)
    r.resize({ ...dimensions(), deviceOrientation:'landscape', hostSecret:'not-public' })
    assert.deepEqual(r.json('trace'), [
      {keys:['size'],sizeKeys:['windowWidth','windowHeight'],width:800,height:400,receiver:true}, dimensions(),
    ])
  })

  test(`${engine}: public maps, methods and poisoned array operations do not own callbacks`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace='';globalThis.on=wx.onWindowResize;globalThis.off=wx.offWindowResize;
      globalThis.keep=function(){trace+='kept;'};globalThis.remove=function(){trace+='removed;'};
      on(keep);on(remove);wx.onWindowResize=function(){};wx.offWindowResize=function(){throw Error('fake')};
      __container_app_listeners={windowResize:[function(){trace+='forged;'}]};
      Array.prototype.slice=Array.prototype.splice=Array.prototype.indexOf=Array.prototype.push=function(){throw Error('poisoned')};
      off(remove);`)
    r.resize()
    assert.equal(r.run('trace'), 'kept;')
    assert.equal(r.run('off()'), undefined)
    r.resize()
    assert.equal(r.run('trace'), 'kept;')
  })

  test(`${engine}: callback identity is never serialized and captured intrinsics survive replacement`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];globalThis.reads=0;globalThis.on=wx.onWindowResize;globalThis.off=wx.offWindowResize;
      globalThis.callback=function(event){trace[trace.length]=event.size.windowWidth};
      Object.defineProperty(callback,'toJSON',{get:function(){reads++;throw Error('callback serialization')}});
      Object.create=Object.defineProperty=Object.getOwnPropertyDescriptor=Reflect.apply=Number.isInteger=function(){throw Error('replaced intrinsic')};
      on(callback);on(callback);`)
    r.resize()
    assert.equal(r.run('off(callback)'),undefined)
    r.resize()
    assert.deepEqual(r.json('trace'),[800])
    assert.equal(r.run('reads'),0)
  })

  test(`${engine}: ordinary on/off mutation keeps the active dispatch snapshot`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];function later(){trace.push('later')};
      wx.onWindowResize(function(){trace.push('first');wx.offWindowResize();wx.onWindowResize(later)});
      wx.onWindowResize(function(){trace.push('second')});`)
    r.resize();r.resize()
    assert.deepEqual(r.json('trace'), ['first','second','later'])
  })

  test(`${engine}: trusted on withdrawal cancels the captured tail and cannot be forged back`, () => {
    const r = fixture(engine)
    r.context.revoke = () => r.transports.installHostEnvironment(policy('unsupported','full'))
    r.run(`globalThis.trace=[];globalThis.on=wx.onWindowResize;globalThis.off=wx.offWindowResize;
      on(function(){trace.push('first');revoke()});on(function(){trace.push('stale')});`)
    r.resize()
    r.run("__container_capabilities['wx.onWindowResize']='full'")
    assert.throws(() => r.run('on(function(){})'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.run('off()'), undefined)
    r.transports.installHostEnvironment(policy())
    r.resize()
    assert.deepEqual(r.json('trace'), ['first'])
  })

  test(`${engine}: removal admission is independent and each Partial grant stays Partial`, () => {
    const r = fixture(engine)
    r.run('globalThis.trace=[];globalThis.callback=function(){trace.push("kept")};wx.onWindowResize(callback)')
    r.transports.installHostEnvironment(policy('partial','unsupported'))
    assert.throws(() => r.run('wx.offWindowResize()'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    r.resize()
    r.transports.installHostEnvironment(policy('partial','partial'))
    assert.deepEqual(r.json("[__container_capabilities['wx.onWindowResize'],__container_capabilities['wx.offWindowResize']]"), ['partial','partial'])
    r.run('wx.offWindowResize(callback)');r.resize()
    r.transports.installHostEnvironment(policy('unsupported','full'))
    assert.equal(r.run('wx.offWindowResize()'), undefined)
    assert.throws(() => r.run('wx.onWindowResize(callback)'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.deepEqual(r.json('trace'), ['kept'])
  })

  test(`${engine}: direct and unrelated-counterpart descriptors cannot replace the runtime pair`, () => {
    for (const apis of [descriptors.map(row=>({...row,owner:'host'})),
      [{name:'wx.onForeignResize',kind:'subscription',owner:'host',counterpart:'wx.offWindowResize'}]]) {
      const r = fixture(engine)
      r.context.registry = {apis,objectApis:[]}
      r.run(`globalThis.on=wx.onWindowResize;globalThis.off=wx.offWindowResize;
        globalThis.trace=[];globalThis.callback=function(){trace.push('actual')};on(callback);
        __container_install_host_services(registry);`)
      assert.deepEqual(r.json('[wx.onWindowResize===on,wx.offWindowResize===off]'), [true,true])
      r.resize();r.run('off(callback)');r.resize()
      assert.deepEqual(r.json('trace'), ['actual'])
      assert.equal(r.run("__container_events.filter(row=>row.type==='api.call').length"), 0)
    }
  })

  test(`${engine}: terminal retirement cancels in-flight tails and later admission cannot revive them`, () => {
    const r = fixture(engine)
    r.context.retire = () => r.transports.dispatchLifecycleNotification('retire', {})
    r.run(`globalThis.trace=[];globalThis.on=wx.onWindowResize;globalThis.off=wx.offWindowResize;
      on(function(){trace.push('first');retire()});on(function(){trace.push('retired-tail')});`)
    r.resize()
    r.transports.installHostEnvironment(policy())
    assert.equal(r.resize(), false)
    assert.throws(() => r.run('on(function(){})'), /notifications are retired/)
    assert.equal(r.run('off()'), undefined)
    assert.deepEqual(r.json('trace'), ['first'])
  })

  test(`${engine}: reentrant app listeners clear Page ownership before queuing nextTick`, async () => {
    const r = fixture(engine)
    r.transports.installHostEnvironment({kind:'capabilities',capabilities:{
      ...policy().capabilities, 'wx.nextTick':'partial',
    }})
    r.context.nativeResize = () => r.resize()
    r.run(`globalThis.trace=[];Page({});
      __container_set_current_pages([0],[{index:0,instanceId:11}]);
      globalThis.page=__container_page_instances['11'];
      wx.onWindowResize(function(){
        trace.push(__container_capture_api_owner()===null);
        wx.nextTick(function(){trace.push('realm')});
      });
      page.fire=function(){nativeResize();wx.nextTick(function(){trace.push('stalePage')})};
      __container_invoke_page_instance(11,0,'fire',[]);
      __container_invoke_page_instance(11,0,'onUnload',[]);`)
    const command = (action, extra={}) => JSON.parse(r.transports.captureReceiverIncarnations({kind:'turn-scheduler',action,...extra}))
    await Promise.resolve()
    command('begin',{limit:64,idleBudgetMs:null})
    try {
      for(let i=0;i<64;i++) {
        if(!command('task',{allowIdle:false}).called) break
        await Promise.resolve()
      }
    } finally { command('end') }
    assert.deepEqual(r.json('trace'),[true,'realm'])
  })

  test(`${engine}: malformed native dispatch does not run payload accessors or emit listeners`, () => {
    const r = fixture(engine)
    r.run('globalThis.calls=0;wx.onWindowResize(function(){calls++})')
    let gets=0
    for (const value of [null,{}, {size:{}}, dimensions(0,400), dimensions(800,NaN), dimensions(1.5,3),
      Object.defineProperty({},'size',{get(){gets++;throw Error('size accessor')}}),
      {size:Object.defineProperty({},'windowWidth',{get(){gets++;throw Error('width accessor')}})}]) {
      assert.equal(r.transports.dispatchLifecycleNotification('windowResize',value), false)
    }
    assert.equal(gets,0)
    assert.equal(r.run('calls'),0)
  })

  test(`${engine}: listener failures are reported once while later listeners still run`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];wx.onWindowResize(function(){trace.push('throwing');throw Error('resize-listener')});
      wx.onWindowResize(function(){trace.push('later')});`)
    r.resize()
    assert.deepEqual(r.json('trace'), ['throwing','later'])
    assert.equal(r.run("__container_errors.filter(row=>row.message==='resize-listener').length"),1)
  })
}

test('catalog keeps exactly two locked subscription signatures and runtime ownership', () => {
  assert.equal(descriptors.length,2)
  for (const row of descriptors) {
    assert.equal(row.owner,'runtime')
    assert.equal(row.kind,'subscription')
    assert.equal(row.baseline,'included')
    assert.equal(row.event,'WindowResize')
    assert.deepEqual(row.signatures,[{parameters:[{name:'listener',type:row.name.includes('.off')?'OffWindowResizeCallback':'OnWindowResizeCallback',optional:row.name.includes('.off')}],returns:'void'}])
  }
})
