import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {createAppServiceTestRealm} from './app-service-test-realm.mjs'

// Data-ingress unit tests exercise the same retained collector that native
// rejection hooks call. Node VM does not prove either native Promise producer.
const policy=(on='full',off='full')=>({kind:'capabilities',capabilities:{
  'wx.onUnhandledRejection':on,'wx.offUnhandledRejection':off,
}})
function fixture(engine){
  const r=createAppServiceTestRealm(engine)
  r.transports.installHostEnvironment(policy())
  assert.equal(typeof r.transports.trackPromiseRejection,'function')
  assert.equal(typeof r.transports.flushUnhandledRejections,'function')
  return r
}
for(const engine of ['quickjs','v8']){
 test(`${engine}: trusted removal admission is independent and never promotes Partial`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.p=Promise.resolve();globalThis.trace=[];wx.onUnhandledRejection(function(){trace.push('kept')})`)
  r.transports.installHostEnvironment(policy('partial','unsupported'))
  assert.throws(()=>r.run('wx.offUnhandledRejection()'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
  r.transports.trackPromiseRejection(r.run('p'),0,false);r.transports.flushUnhandledRejections()
  assert.deepEqual(r.json('trace'),['kept'])
  r.transports.installHostEnvironment(policy('partial','partial'))
  assert.equal(r.run("__container_capabilities['wx.offUnhandledRejection']"),'partial')
  assert.equal(r.run('wx.offUnhandledRejection()'),undefined)
  for(const value of ['null','{}','1'])assert.throws(()=>r.run(`wx.offUnhandledRejection(${value})`),/listener must be a function/)
 })
 test(`${engine}: direct and unrelated-counterpart host descriptors cannot split the runtime listener pair`,()=>{
  const r=fixture(engine)
  r.context.registry={apis:[{name:'wx.onUnhandledRejection',kind:'subscription',owner:'host',counterpart:'wx.offUnhandledRejection'},{name:'wx.onOther',kind:'subscription',owner:'host',counterpart:'wx.offUnhandledRejection'}],objectApis:[]}
  r.run(`globalThis.savedOn=wx.onUnhandledRejection;globalThis.savedOff=wx.offUnhandledRejection;__container_install_host_services(registry)`)
  assert.deepEqual(r.json('[savedOn===wx.onUnhandledRejection,savedOff===wx.offUnhandledRejection]'),[true,true])
 })
 test(`${engine}: exact removal and ordinary mutation preserve one delivery snapshot`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.p=Promise.resolve();globalThis.trace=[];
    globalThis.later=function(){trace.push('later')};
    globalThis.second=function(){trace.push('second')};
    globalThis.first=function(){trace.push('first');wx.offUnhandledRejection();wx.onUnhandledRejection(later)};
    wx.onUnhandledRejection(first);wx.onUnhandledRejection(first);wx.onUnhandledRejection(second);`)
  r.transports.trackPromiseRejection(r.run('p'),1,false);r.transports.flushUnhandledRejections()
  assert.deepEqual(r.json('trace'),['first','second'])
  r.transports.trackPromiseRejection(r.run('p'),2,false);r.transports.flushUnhandledRejections()
  assert.deepEqual(r.json('trace'),['first','second','later'])
  assert.equal(r.run('wx.offUnhandledRejection(later)'),undefined)
  r.transports.trackPromiseRejection(r.run('p'),3,false);r.transports.flushUnhandledRejections()
  assert.equal(r.run('trace.length'),3)
 })
 test(`${engine}: trusted registration revocation cancels a listener tail and public grants cannot revive it`,()=>{
  const r=fixture(engine)
  r.context.revoke=()=>r.transports.installHostEnvironment(policy('unsupported','full'))
  r.run(`globalThis.p=Promise.resolve();globalThis.trace=[];globalThis.borrowed=wx.onUnhandledRejection;
    wx.onUnhandledRejection(function(){trace.push('first');revoke()});
    wx.onUnhandledRejection(function(){trace.push('tail')});`)
  r.transports.trackPromiseRejection(r.run('p'),0,false);r.transports.flushUnhandledRejections()
  r.run(`__container_capabilities['wx.onUnhandledRejection']='full'`)
  assert.throws(()=>r.run('borrowed(function(){})'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY')
  r.transports.installHostEnvironment(policy())
  r.transports.trackPromiseRejection(r.run('p'),1,false);r.transports.flushUnhandledRejections()
  assert.deepEqual(r.json('trace'),['first'])
 })
 test(`${engine}: primitive reasons, hostile public aliases and replaced App alias preserve actual identities`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.p=Promise.resolve();globalThis.trace=[];
    App({onUnhandledRejection:function(e){trace.push(['app',e.reason])}});
    wx.onUnhandledRejection(function(e){trace.push(['wx',e.reason])});
    globalThis.__container_app={onUnhandledRejection:function(){trace.push('forged')}};
    globalThis.__container_app_listeners={unhandledRejection:[function(){trace.push('forged')}]};
    globalThis.trackPromiseRejection=function(){throw Error('forged')};
    Array.prototype.push=function(){throw Error('poisoned')};`)
  r.run('trace.push=function(value){this[this.length]=value}')
  for(const reason of [undefined,null,17,'reason']){
   r.transports.trackPromiseRejection(r.run('p'),reason,false);r.transports.flushUnhandledRejections()
  }
  assert.equal(r.run('trace.length'),8)
  assert.equal(r.run('trace[0][1]===undefined'),true)
  assert.deepEqual(r.json('trace.slice(2)'),[['app',null],['wx',null],['app',17],['wx',17],['app','reason'],['wx','reason']])
 })
 test(`${engine}: listener errors isolate and reentrant captures wait for another checkpoint`,()=>{
  const r=fixture(engine);let entered=false
  r.context.capture=()=>{if(!entered){entered=true;r.transports.trackPromiseRejection(r.run('second'),2,false);r.transports.flushUnhandledRejections()}}
  r.run(`globalThis.p=Promise.resolve();globalThis.second=Promise.resolve();globalThis.trace=[];
    wx.onUnhandledRejection(function(e){trace.push(e.reason);capture();throw Error('listener failure')});
    wx.onUnhandledRejection(function(e){trace.push('later')});`)
  r.transports.trackPromiseRejection(r.run('p'),1,false);r.transports.flushUnhandledRejections()
  assert.deepEqual(r.json('trace'),[1,'later'])
  r.transports.flushUnhandledRejections();assert.deepEqual(r.json('trace'),[1,'later',2,'later'])
 })
 test(`${engine}: retirement clears pending values and borrowed registration remains retired`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.p=Promise.resolve();globalThis.trace=[];globalThis.borrowed=wx.onUnhandledRejection;
    App({onUnhandledRejection:function(){trace.push('app')}});wx.onUnhandledRejection(function(){trace.push('wx')});`)
  r.transports.trackPromiseRejection(r.run('p'),1,false)
  assert.equal(r.transports.dispatchLifecycleNotification('retire',{}),true)
  r.transports.installHostEnvironment(policy());r.transports.flushUnhandledRejections()
  r.transports.trackPromiseRejection(r.run('p'),2,false);r.transports.flushUnhandledRejections()
  assert.deepEqual(r.json('trace'),[])
  assert.throws(()=>r.run('borrowed(function(){})'),/notifications are retired/)
 })
 test(`${engine}: capture budget failure is explicit and handled entries release admission`,()=>{
  const r=fixture(engine)
  const values=Array.from({length:4097},()=>({}))
  for(let i=0;i<4096;i++)r.transports.trackPromiseRejection(values[i],i,false)
  assert.throws(()=>r.transports.trackPromiseRejection(values[4096],0,false),/capture budget exceeded/)
  r.transports.trackPromiseRejection(values[0],undefined,true)
  r.transports.trackPromiseRejection(values[4096],0,false)
 })
 test(`${engine}: retained native ingress preserves Promise and reason identities through checkpoint delivery`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.promise=Promise.resolve();globalThis.reason=new Error('identity');globalThis.trace=[];
    App({onUnhandledRejection:function(event){trace.push(['app',this===getApp(),event.promise===promise,event.reason===reason])}});
    wx.onUnhandledRejection(function(event){trace.push(['wx',event.promise===promise,event.reason===reason])});`)
  r.transports.trackPromiseRejection(r.run('promise'),r.run('reason'),false)
  assert.deepEqual(r.json('trace'),[])
  r.transports.flushUnhandledRejections()
  assert.deepEqual(r.json('trace'),[['app',true,true,true],['wx',true,true]])
  r.transports.flushUnhandledRejections()
  assert.equal(r.run('trace.length'),2)
 })
 test(`${engine}: native handler-added notification cancels the same pending Promise only`,()=>{
  const r=fixture(engine)
  r.run(`globalThis.first=Promise.resolve();globalThis.second=Promise.resolve();globalThis.trace=[];
    wx.onUnhandledRejection(function(event){trace.push(event.reason)});`)
  r.transports.trackPromiseRejection(r.run('first'),'handled',false)
  r.transports.trackPromiseRejection(r.run('second'),'unhandled',false)
  r.transports.trackPromiseRejection(r.run('first'),undefined,true)
  r.transports.flushUnhandledRejections()
  assert.deepEqual(r.json('trace'),['unhandled'])
 })
}

test('native source uses pinned provider hooks and retained transports without Promise replacement or JSON identity transport',()=>{
 const q=readFileSync(new URL('../crates/container-engine-quickjs/src/lib.rs',import.meta.url),'utf8')
 const v=readFileSync(new URL('../crates/container-engine-v8/src/lib.rs',import.meta.url),'utf8')
 assert(q.includes('runtime.set_host_promise_rejection_tracker(Some(Box::new('))
 assert(q.includes('Rc::downgrade(&promise_rejections)'))
 assert(/native\s*\.flush_rejections\s*\.clone\(\)\s*\.restore\(&ctx\)/.test(q))
 assert(v.includes('isolate.set_promise_reject_callback(Self::promise_reject_callback)'))
 assert(v.includes('PromiseHandlerAddedAfterReject'))
 assert(v.includes('let result = native.flush_unhandled_rejections()'))
 assert(v.includes('error.code == container_core::EngineErrorCode::Interrupted'))
 const hub=readFileSync(new URL('../crates/container-core/src/unhandled-rejections.js',import.meta.url),'utf8')
 assert(!/JSON\.|Promise\.prototype|globalThis\.Promise\s*=/.test(hub))
})

test('catalog and generator identify actual runtime-owned rejection listener pair',()=>{
 const catalog=JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json',import.meta.url)))
 for(const name of ['wx.onUnhandledRejection','wx.offUnhandledRejection'])assert.equal(catalog.apis.find(x=>x.name===name).owner,'runtime')
 const generator=readFileSync(new URL('./generate-host-api-catalog.mjs',import.meta.url),'utf8')
 const globals=/const runtimeGlobals = new Set\(\('([^']+)'\)/.exec(generator)[1].split(' ')
 for(const name of ['onUnhandledRejection','offUnhandledRejection'])assert(globals.includes(name))
})
