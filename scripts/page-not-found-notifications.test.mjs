import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

// Both exact production bootstrap compositions run in Node VM. The existing
// compatibility dispatcher is exercised explicitly; no missing-route producer,
// App recovery, native engine, device or SDK behavior is claimed here.
const catalog = JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url)))
const names = ['wx.onPageNotFound', 'wx.offPageNotFound']
const descriptors = catalog.apis.filter(row => names.includes(row.name))
const policy = (on = 'partial', off = 'full') => ({ kind: 'capabilities', capabilities: {
  'wx.onPageNotFound': on, 'wx.offPageNotFound': off,
} })
function fixture(engine) {
  const realm = createAppServiceTestRealm(engine)
  realm.transports.installHostEnvironment(policy())
  return { ...realm, dispatch: realm.run('__container_dispatch_app_listeners') }
}

for (const engine of ['quickjs', 'v8']) {
  test(`${engine}: legacy default registration does not acquire an undeclared removal grant`, () => {
    const r = createAppServiceTestRealm(engine)
    r.run('wx.onPageNotFound(function(){})')
    assert.equal(r.run("__container_capabilities['wx.onPageNotFound']"), 'partial')
    assert.equal(r.run("__container_capabilities['wx.offPageNotFound']"), 'unsupported')
    assert.throws(() => r.run('wx.offPageNotFound()'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.transports.dispatchLifecycleNotification('retire', {}), true)
  })

  test(`${engine}: exact-function and omitted removal share the actual registration list`, () => {
    const r = fixture(engine)
    assert.deepEqual(r.json(`(function() {
      globalThis.trace=[];
      globalThis.first=function(event){trace.push('first:'+event.path);return {label:'first'}};
      globalThis.second=function(event){trace.push('second:'+event.path);return {label:'second'}};
      return [wx.onPageNotFound(first),wx.onPageNotFound(second),wx.onPageNotFound(first),
        wx.offPageNotFound(function(){})].map(value=>value===undefined);
    })()`), [true, true, true, true])
    assert.deepEqual(JSON.parse(JSON.stringify(r.dispatch('pageNotFound', [{path:'one'}]))), [{label:'first'}, {label:'second'}])
    assert.equal(r.run('wx.offPageNotFound(first)'), undefined)
    r.dispatch('pageNotFound', [{path:'two'}])
    assert.equal(r.run('wx.offPageNotFound()'), undefined)
    r.dispatch('pageNotFound', [{path:'three'}])
    assert.deepEqual(r.json('trace'), ['first:one', 'second:one', 'second:two'])
    assert.equal(r.run('wx.offPageNotFound(undefined)'), undefined)
    for (const value of ['null','1','{}']) assert.throws(() => r.run(`wx.offPageNotFound(${value})`), /callback must be a function/)
  })

  test(`${engine}: mutable public arrays and poisoned list methods cannot own registration or removal`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace='';globalThis.savedOn=wx.onPageNotFound;globalThis.savedOff=wx.offPageNotFound;
      globalThis.kept=function(){trace+='kept;'};globalThis.removed=function(){trace+='removed;'};
      savedOn(kept);savedOn(removed);
      __container_app_listeners.pageNotFound=[function(){trace+='forged;'}];
      Array.prototype.indexOf=Array.prototype.push=Array.prototype.splice=Array.prototype.slice=function(){throw Error('poisoned list')};
      savedOff(removed);`)
    r.dispatch('pageNotFound', [{}])
    assert.equal(r.run('trace'), 'kept;')
    r.run('Object.freeze(__container_app_listeners);savedOff()')
    r.dispatch('pageNotFound', [{}])
    assert.equal(r.run('trace'), 'kept;')
  })

  test(`${engine}: diagnostic projection reads no guest alias getter`, () => {
    const r = fixture(engine)
    r.run(`globalThis.reads=0;globalThis.trace='';
      Object.defineProperty(globalThis,'__container_app_listeners',{get:function(){reads++;throw Error('alias getter')},configurable:true});
      function callback(){trace+='called;'}wx.onPageNotFound(callback);wx.offPageNotFound(callback);wx.onPageNotFound(callback);`)
    r.dispatch('pageNotFound', [{}])
    assert.equal(r.run('reads'), 0)
    assert.equal(r.run('trace'), 'called;')
    assert.equal(r.run('wx.offPageNotFound()'), undefined)
    assert.equal(r.run('reads'), 0)
  })

  test(`${engine}: ordinary mutation keeps the current compatibility dispatch snapshot`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];
      function later(){trace.push('later')}
      function removed(){trace.push('removed')}
      function first(){trace.push('first');wx.offPageNotFound();wx.onPageNotFound(later)}
      wx.onPageNotFound(first);wx.onPageNotFound(removed);`)
    r.dispatch('pageNotFound', [{}]); r.dispatch('pageNotFound', [{}])
    assert.deepEqual(r.json('trace'), ['first','removed','later'])
  })

  test(`${engine}: trusted revocation cancels a captured tail and public map forgery cannot restore it`, () => {
    const r = fixture(engine)
    r.context.revoke = () => r.transports.installHostEnvironment(policy('unsupported', 'full'))
    r.run(`globalThis.trace=[];globalThis.borrowedOn=wx.onPageNotFound;globalThis.borrowedOff=wx.offPageNotFound;
      wx.onPageNotFound(function(){trace.push('first');revoke()});
      wx.onPageNotFound(function(){trace.push('stale-tail')});`)
    r.dispatch('pageNotFound', [{}])
    r.run(`__container_capabilities['wx.onPageNotFound']='full';`)
    assert.throws(() => r.run('borrowedOn(function(){})'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.run('borrowedOff()'), undefined)
    r.transports.installHostEnvironment(policy())
    r.dispatch('pageNotFound', [{}])
    assert.deepEqual(r.json('trace'), ['first'])
    assert.deepEqual(r.json("[__container_capabilities['wx.onPageNotFound'],__container_capabilities['wx.offPageNotFound']]"), ['partial','full'])
  })

  test(`${engine}: trusted admission changes precede reentrant diagnostic projection traps`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];globalThis.borrowedOn=wx.onPageNotFound;globalThis.borrowedOff=wx.offPageNotFound;
      borrowedOn(function(){trace.push('old')});
      globalThis.attempted=false;globalThis.reentry=[];
      __container_app_listeners=new Proxy({}, {defineProperty:function(target,key,descriptor){
        if(!attempted){attempted=true;
          try{borrowedOn(function(){trace.push('revived')});reentry.push('on allowed')}catch(error){reentry.push(error.code)}
          try{borrowedOff();reentry.push('off allowed')}catch(error){reentry.push(error.code)}
        }
        return Reflect.defineProperty(target,key,descriptor);
      }});`)
    r.transports.installHostEnvironment(policy('unsupported', 'unsupported'))
    assert.deepEqual(r.json('reentry'), ['ERR_UNSUPPORTED_CAPABILITY','ERR_UNSUPPORTED_CAPABILITY'])
    r.transports.installHostEnvironment(policy())
    r.dispatch('pageNotFound', [{}])
    assert.deepEqual(r.json('trace'), [])
  })

  test(`${engine}: removal policy is independent and never promotes a Partial grant`, () => {
    const r = fixture(engine)
    r.run('globalThis.trace=[];globalThis.callback=function(){trace.push("kept")};wx.onPageNotFound(callback)')
    r.transports.installHostEnvironment(policy('partial', 'unsupported'))
    assert.throws(() => r.run('wx.offPageNotFound()'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    r.dispatch('pageNotFound', [{}])
    r.transports.installHostEnvironment(policy('partial', 'partial'))
    assert.equal(r.run("__container_capabilities['wx.offPageNotFound']"), 'partial')
    r.run('wx.offPageNotFound(callback)')
    r.dispatch('pageNotFound', [{}])
    r.transports.installHostEnvironment(policy('unsupported', 'full'))
    assert.equal(r.run('wx.offPageNotFound()'), undefined)
    assert.throws(() => r.run('wx.onPageNotFound(callback)'), error => error.code === 'ERR_UNSUPPORTED_CAPABILITY')
    assert.deepEqual(r.json('trace'), ['kept'])
  })

  test(`${engine}: direct and unrelated-counterpart host descriptors cannot split the runtime pair`, () => {
    for (const config of [descriptors.map(row=>({...row,owner:'host'})),
      [{name:'wx.onUnrelated',kind:'subscription',owner:'host',counterpart:'wx.offPageNotFound'}]]) {
      const r = fixture(engine)
      r.context.registry = {apis:config,objectApis:[]}
      r.run(`globalThis.savedOn=wx.onPageNotFound;globalThis.savedOff=wx.offPageNotFound;
        globalThis.trace=[];globalThis.callback=function(){trace.push('actual')};wx.onPageNotFound(callback);
        __container_install_host_services(registry);`)
      assert.deepEqual(r.json('[wx.onPageNotFound===savedOn,wx.offPageNotFound===savedOff]'), [true,true])
      r.dispatch('pageNotFound', [{}])
      r.run('savedOff(callback)')
      r.dispatch('pageNotFound', [{}])
      assert.deepEqual(r.json('trace'), ['actual'])
      assert.equal(r.run("__container_events.filter(row=>row.type==='api.call').length"), 0)
    }
  })

  test(`${engine}: terminal cleanup is unconditional and trusted reinstallation cannot revive borrowed registration`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];globalThis.borrowedOn=wx.onPageNotFound;globalThis.borrowedOff=wx.offPageNotFound;
      wx.onPageNotFound(function(){trace.push('stale')});
      wx.onPageNotFound=function(){};wx.offPageNotFound=function(){throw Error('public off')};
      __container_app_listeners={pageNotFound:[function(){trace.push('fake')}]};`)
    r.transports.installHostEnvironment(policy('partial', 'unsupported'))
    assert.equal(r.transports.dispatchLifecycleNotification('retire', {}), true)
    r.transports.installHostEnvironment(policy())
    r.dispatch('pageNotFound', [{}])
    assert.deepEqual(r.json('trace'), [])
    assert.throws(() => r.run('borrowedOn(function(){})'), /notifications are retired/)
    assert.equal(r.run('borrowedOff()'), undefined)
  })

  test(`${engine}: listener errors preserve later existing dispatch callbacks`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];wx.onPageNotFound(function(){trace.push('throwing');throw Error('page-not-found listener')});
      wx.onPageNotFound(function(){trace.push('later')});`)
    r.dispatch('pageNotFound', [{}])
    assert.deepEqual(r.json('trace'), ['throwing','later'])
    assert.equal(r.run("__container_errors.filter(row=>row.message==='page-not-found listener').length"), 1)
  })
}

test('catalog generation preserves runtime ownership and the fixed optional void removal signature', () => {
  assert.equal(descriptors.length, 2)
  for (const row of descriptors) assert.equal(row.owner, 'runtime')
  assert.deepEqual(descriptors.find(row=>row.name==='wx.offPageNotFound').signatures, [{parameters:[{name:'listener',type:'OffPageNotFoundCallback',optional:true}],returns:'void'}])
  const generator = readFileSync(new URL('./generate-host-api-catalog.mjs', import.meta.url), 'utf8')
  const runtimeGlobals = /const runtimeGlobals = new Set\(\('([^']+)'\)/.exec(generator)[1].split(' ')
  for (const name of ['onPageNotFound','offPageNotFound']) assert(runtimeGlobals.includes(name))
})
