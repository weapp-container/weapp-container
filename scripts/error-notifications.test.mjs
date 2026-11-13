import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildManifest, canonicalize } from '../tools/container-manifest/src/index.ts'
import test from 'node:test'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

// These realms execute each exact production Rust source composition. They
// verify the shared JS contract, not native engine interruption or device parity.
const catalog = JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json', import.meta.url), 'utf8'))
const errorDescriptors = catalog.apis.filter(entry => ['wx.onError','wx.offError'].includes(entry.name))
const policy = (on = 'partial', off = 'partial') => ({ kind: 'capabilities', capabilities: { 'wx.onError': on, 'wx.offError': off } })
function fixture(engine) {
  const realm = createAppServiceTestRealm(engine)
  return { ...realm, report: realm.run('__container_report_error'), batch: realm.transports.batchCall }
}

// Regression controls for the pre-existing native diagnostics contract. These
// use the production callback helper, not a second implementation of reporting.
for (const engine of ['quickjs', 'v8']) {
  test(`${engine}: safe hub preserves standard Error diagnostic names`, () => {
    const r=fixture(engine)
    r.run(`globalThis.trace=[];wx.onError(function(value){trace.push(value)});
      globalThis.original=TypeError('batch failure');globalThis.fail=function(){throw original};`)
    let thrown
    try { r.batch(null,'fail',[]) } catch(error) { thrown=error }
    assert.equal(thrown,r.run('original'))
    assert.equal(r.run('__container_errors[0].message'),'batch failure')
    assert.equal(r.run('__container_errors[0].name'),'TypeError')
    assert.deepEqual(r.json('trace'),['batch failure'])
  })

  test(`${engine}: callback diagnostic failure retains its legacy fallback after one private notification`, () => {
    const r=fixture(engine)
    r.run(`globalThis.trace=[];globalThis.getterCalls=0;
      wx.onError(function(value){trace.push(value)});
      __container_invoke_api_callback({success:function(){throw {get message(){getterCalls++;throw Error('reporting getter')}}}},'success',{});`)
    assert.equal(r.run('getterCalls'),1)
    assert.deepEqual(r.json('trace'),['Error'])
    assert.deepEqual(r.json('__container_errors.map(function(x){return [x.name,x.message]})'),[['Error','API callback threw an unreportable value']])
  })

  for (const mode of ['freeze-errors','poison-push']) {
    test(`${engine}: ${mode} callback diagnostics cannot skip complete, settlement or private delivery`, async () => {
      const r=fixture(engine)
      await r.run(`(function(){
        globalThis.trace='';globalThis.notifications='';globalThis.getterCalls=0;
        const push=Array.prototype.push;
        wx.onError(function(value){notifications+=value+';'});
        function hostile(){throw {get message(){
          getterCalls++;
          ${mode==='freeze-errors' ? 'Object.freeze(__container_errors)' : "Array.prototype.push=function(){throw Error('poisoned push')}"};
          throw Error('unreportable callback value');
        }}}
        return __container_async_result({
          success:function(){trace+='success;';hostile()},
          complete:function(){trace+='complete;';hostile()}
        },{ok:true},null).then(function(){trace+='resolve;';Array.prototype.push=push});
      })()`)
      assert.equal(r.run('trace'),'success;complete;resolve;')
      assert.equal(r.run('notifications'),'Error;Error;')
      assert.equal(r.run('getterCalls'),2)
      assert.equal(r.run('__container_errors.length'),mode==='freeze-errors' ? 0 : 2)
      if (mode==='poison-push') assert.deepEqual(r.json('__container_errors.map(function(x){return x.message})'),[
        'API callback threw an unreportable value','API callback threw an unreportable value',
      ])
    })
  }

  test(`${engine}: legacy callback projection never becomes private listener data`, () => {
    const r=fixture(engine)
    r.run(`globalThis.trace=[];globalThis.reads=[];
      wx.onError(function(value){trace.push(value)});
      __container_invoke_api_callback({success:function(){throw {
        get message(){reads.push('message');return 'diagnostic message'},
        get name(){reads.push('name');return 'DiagnosticError'},
        get stack(){reads.push('stack');return 'diagnostic stack'}
      }}},'success',{});`)
    assert.deepEqual(r.json('trace'),['Error'])
    assert.deepEqual(r.json('reads'),['message','name','stack','stack'])
    assert.deepEqual(r.json('__container_errors'),[{message:'diagnostic message',name:'DiagnosticError',stack:'diagnostic stack'}])
  })

  test(`${engine}: poisoned intrinsic Error names do not execute getters in the safe hub`, () => {
    const r=fixture(engine)
    r.run(`globalThis.calls=0;globalThis.trace=[];wx.onError(function(value){trace.push(value)});
      globalThis.original=TypeError('safe original');
      Object.defineProperty(TypeError.prototype,'name',{get:function(){calls++;throw Error('name getter')}});`)
    r.report(r.run('original'))
    assert.equal(r.run('calls'),0)
    assert.equal(r.run('__container_errors[0].name'),'TypeError')
    assert.deepEqual(r.json('trace'),['safe original'])
  })
}

for (const engine of ['quickjs', 'v8']) {
  test(`${engine}: exact callback removal, remove-all and void results`, () => {
    const r = fixture(engine)
    assert.deepEqual(r.json(`(function() {
      globalThis.trace=[];
      globalThis.first=function(value){trace.push('first:'+value)};
      globalThis.second=function(value){trace.push('second:'+value)};
      return [wx.onError(first)===undefined,wx.onError(second)===undefined,
        wx.onError(first)===undefined,wx.offError(function(){})===undefined];
    })()`), [true,true,true,true])
    r.report('one')
    assert.deepEqual(r.json('trace'), ['first:one','second:one'])
    assert.equal(r.run('wx.offError(first)'), undefined)
    r.report('two')
    assert.equal(r.run('wx.offError()'), undefined)
    r.report('three')
    assert.deepEqual(r.json('trace'), ['first:one','second:one','second:two'])
    assert.equal(r.run('wx.offError(undefined)'), undefined)
    for (const source of ['wx.onError(null)','wx.offError(null)']) assert.throws(() => r.run(source), /listener must be a function/)
  })

  test(`${engine}: wx error registration preserves SocketTask error methods`, () => {
    const r=fixture(engine)
    assert.deepEqual(r.json(`(function(){
      const task=wx.connectSocket({url:'wss://fixture.invalid'});
      function callback(){}
      return [typeof task.onError,typeof task.offError,
        task.onError(callback)===task,task.offError(callback)===task,
        wx.onError(callback)===undefined,wx.offError(callback)===undefined];
    })()`), ['function','function',true,true,true,true])
  })

  test(`${engine}: host descriptors cannot split the error pair authority`, () => {
    for (const names of [['wx.offError'],['wx.onError'],['wx.onError','wx.offError'],['wx.onStaleOther']]) {
      const r=fixture(engine)
      r.context.hostConfig={apis:names[0]==='wx.onStaleOther'
        ? [{name:'wx.onStaleOther',kind:'subscription',owner:'host',counterpart:'wx.offError'}]
        : errorDescriptors.filter(entry=>names.includes(entry.name)).map(entry=>({...entry,owner:'host'})),objectApis:[]}
      // Match actual Session init order. Stale host-owned descriptors cannot
      // replace the private pair even before the first guest module executes.
      r.run(`globalThis.savedOn=wx.onError;globalThis.savedOff=wx.offError;
        __container_install_host_services(hostConfig);
        globalThis.trace=[];globalThis.first=function(value){trace.push('first:'+value)};
        globalThis.second=function(value){trace.push('second:'+value)};
        wx.onError(first);wx.onError(second);`)
      assert.deepEqual(r.json('[wx.onError===savedOn,wx.offError===savedOff]'),[true,true],names.join(','))
      r.report('before')
      assert.equal(r.run('wx.offError(first)'),undefined)
      r.report('exact')
      assert.equal(r.run('wx.offError()'),undefined)
      r.report('all')
      assert.deepEqual(r.json('trace'),['first:before','second:before','second:exact'])
      assert.equal(r.run(`__container_events.filter(function(event){return event.type==='api.call'}).length`),0)
    }
  })

  test(`${engine}: retirement survives host descriptor and trusted policy reinstallation`, () => {
    const r=fixture(engine)
    r.context.hostConfig={apis:errorDescriptors.map(entry=>({...entry,owner:'host'})),objectApis:[]}
    r.run('globalThis.savedOn=wx.onError;globalThis.savedOff=wx.offError;globalThis.trace=[];wx.onError(function(value){trace.push(value)})')
    assert.equal(r.transports.dispatchLifecycleNotification('retire',{}),true)
    assert.equal(r.run('__container_install_host_services(hostConfig)'),true)
    assert.equal(r.transports.installHostEnvironment(policy('full','full')),true)
    assert.deepEqual(r.json('[wx.onError===savedOn,wx.offError===savedOff]'),[true,true])
    assert.throws(()=>r.run('wx.onError(function(){})'),/error notifications are retired/)
    assert.equal(r.run('wx.offError()'),undefined)
    r.report('late')
    assert.deepEqual(r.json('trace'),[])
  })

  test(`${engine}: on/off mutation uses a callback snapshot`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];
      function later(value){trace.push('later:'+value)}
      function removed(value){trace.push('removed:'+value)}
      function first(value){trace.push('first:'+value);wx.offError();wx.onError(later)}
      wx.onError(first);wx.onError(removed);`)
    r.report('one'); r.report('two')
    assert.deepEqual(r.json('trace'), ['first:one','removed:one','later:two'])
  })

  test(`${engine}: listener failures and nested reporting are bounded`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];
      wx.onError(function(value){trace.push('first:'+value);__container_report_error(Error('nested'));throw Error('listener failed')});
      wx.onError(function(value){trace.push('second:'+value)});`)
    r.report(r.run('Error("original")'))
    assert.deepEqual(r.json('trace'), ['first:original','second:original'])
    assert.deepEqual(r.json('__container_errors.map(function(x){return [x.message,x.source||null]})'), [['original',null],['listener failed','error-listener']])
    r.report('next')
    assert.deepEqual(r.json('trace.slice(2)'), ['first:next','second:next'])
  })

  test(`${engine}: aliases, diagnostic queues and mutable intrinsics cannot suppress delivery`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];wx.onError(function(value){trace[trace.length]=value});
      globalThis.__container_error_handlers=[];
      Object.freeze(globalThis.__container_errors);
      globalThis.__container_report_error=function(){throw Error('retargeted')};
      Array.prototype.push=Array.prototype.slice=Array.prototype.splice=function(){throw Error('poisoned array')};
      Reflect.apply=function(){throw Error('poisoned apply')};
      Object.defineProperty=function(){throw Error('poisoned define')};
      Object.getOwnPropertyDescriptor=function(){throw Error('poisoned descriptor')};`)
    r.report('retained')
    assert.deepEqual(r.json('trace'), ['retained'])
    assert.equal(r.run('wx.offError()'), undefined)
    r.report('cleared')
    assert.deepEqual(r.json('trace'), ['retained'])
  })

  test(`${engine}: retained batch reporter preserves original identity and reports once per throw`, () => {
    const r = fixture(engine)
    const original = r.run(`globalThis.trace=[];wx.onError(function(value){trace.push(value);throw Error('listener')});
      globalThis.original=Error('same error');globalThis.fail=function(){throw original};
      globalThis.__container_report_error=function(){throw Error('retargeted')};original`)
    for (let index=0;index<2;index++) {
      let thrown
      try { r.batch(null,'fail',[]) } catch (error) { thrown=error }
      assert.equal(thrown,original)
    }
    assert.deepEqual(r.json('trace'), ['same error','same error'])
    assert.deepEqual(r.json('__container_errors.filter(function(x){return !x.source}).map(function(x){return x.message})'), ['same error','same error'])
  })

  test(`${engine}: timer, queueMicrotask and API callback reporters are retained`, async () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];wx.onError(function(value){trace.push(value)});
      setTimeout(function(){throw Error('timer failed')},0);
      queueMicrotask(function(){throw Error('microtask callback failed')});
      globalThis.__container_report_error=function(){throw Error('retargeted')};`)
    r.run('__container_timer_begin(Date.now()+1000,10);__container_timer_task();__container_timer_end()')
    r.run(`__container_invoke_api_callback({success:function(){throw Error('API callback failed')}},'success',{})`)
    await Promise.resolve(); await Promise.resolve()
    assert.deepEqual(r.json('trace'), ['timer failed','API callback failed','microtask callback failed'])
    assert.equal(r.run('typeof __container_bind_timer_error_reporter'), 'undefined')
  })

  test(`${engine}: on and off policies are independent and only on revocation clears delivery`, () => {
    const r = fixture(engine)
    r.run(`globalThis.trace=[];globalThis.savedOn=wx.onError;globalThis.savedOff=wx.offError;
      globalThis.listener=function(value){trace.push(value)};savedOn(listener);
      __container_capabilities['wx.onError']='unsupported';__container_capabilities['wx.offError']='unsupported';`)
    r.report('public map cannot revoke')
    assert.equal(r.transports.installHostEnvironment(policy('partial','unsupported')),true)
    r.run(`__container_capabilities['wx.offError']='full'`)
    assert.throws(()=>r.run('savedOff()'),value=>value.code==='ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.run('savedOn(function(value){trace.push("new:"+value)})'),undefined)
    r.report('off denied')
    assert.deepEqual(r.json('trace'),['public map cannot revoke','off denied','new:off denied'])
    assert.equal(r.transports.installHostEnvironment(policy('unsupported','full')),true)
    assert.throws(()=>r.run('savedOn(listener)'),value=>value.code==='ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.run('savedOff()'),undefined)
    r.report('on denied')
    assert.equal(r.transports.installHostEnvironment(policy('full','full')),true)
    assert.deepEqual(r.json("[__container_capabilities['wx.onError'],__container_capabilities['wx.offError']]"), ['partial','full'])
    r.report('restored')
    assert.deepEqual(r.json('trace'),['public map cannot revoke','off denied','new:off denied'])
    r.run('savedOn(listener)');r.report('fresh registration')
    assert.deepEqual(r.json('trace'),['public map cannot revoke','off denied','new:off denied','fresh registration'])
  })

  test(`${engine}: removal denial during dispatch keeps the registration snapshot live`, () => {
    const r=fixture(engine)
    r.context.denyOff=()=>r.transports.installHostEnvironment(policy('partial','unsupported'))
    r.run(`globalThis.trace=[];wx.onError(function(value){trace.push('first:'+value);denyOff()});
      wx.onError(function(value){trace.push('second:'+value)});`)
    r.report('one');r.report('two')
    assert.deepEqual(r.json('trace'),['first:one','second:one','first:two','second:two'])
  })

  test(`${engine}: on-only policy still retires unconditionally while public off is denied`, () => {
    const r=fixture(engine)
    assert.equal(r.transports.installHostEnvironment(policy('partial','unsupported')),true)
    r.context.retire=()=>r.transports.dispatchLifecycleNotification('retire',{})
    r.run(`globalThis.trace=[];globalThis.savedOn=wx.onError;globalThis.savedOff=wx.offError;
      savedOn(function(value){trace.push('first:'+value);retire()});
      savedOn(function(value){trace.push('second:'+value)});`)
    r.report('one');r.report('late')
    assert.deepEqual(r.json('trace'),['first:one'])
    assert.throws(()=>r.run('savedOff()'),value=>value.code==='ERR_UNSUPPORTED_CAPABILITY')
    assert.deepEqual(r.json('__container_error_handlers'),[])
    r.transports.installHostEnvironment(policy('full','full'))
    assert.throws(()=>r.run('savedOn(function(){})'),/error notifications are retired/)
    assert.equal(r.run('savedOff()'),undefined)
    r.report('restored policy')
    assert.deepEqual(r.json('trace'),['first:one'])
  })

  test(`${engine}: full host snapshot and revocation during dispatch use the same private policy`, () => {
    let r
    r=fixture(engine)
    r.context.revoke=()=>{
      assert.equal(r.transports.installHostEnvironment(policy('unsupported','partial')),true)
      assert.equal(r.transports.installHostEnvironment(policy()),true)
    }
    r.run(`globalThis.trace=[];wx.onError(function(value){trace.push('first:'+value);revoke()});
      wx.onError(function(value){trace.push('second:'+value)});`)
    r.report('one');r.report('two')
    assert.deepEqual(r.json('trace'), ['first:one'])
    assert.equal(r.transports.installHostEnvironment({version:'1.0',capabilities:{'wx.onError':'unsupported','wx.offError':'partial'},
      domQuery:false,syncApiValues:{},syncApiErrors:{},storage:null,files:null}),true)
    assert.throws(()=>r.run('wx.onError(function(){})'),value=>value.code==='ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(r.run('wx.offError()'),undefined)
  })

  test(`${engine}: terminal retirement cancels the remaining snapshot and borrowed registration`, () => {
    const r=fixture(engine)
    r.context.retire=()=>r.transports.dispatchLifecycleNotification('retire',{})
    r.run(`globalThis.trace=[];globalThis.savedOn=wx.onError;globalThis.savedOff=wx.offError;
      savedOn(function(value){trace.push('first:'+value);retire()});
      savedOn(function(value){trace.push('second:'+value)});`)
    r.report('one');r.report('two')
    assert.deepEqual(r.json('trace'), ['first:one'])
    assert.throws(()=>r.run('savedOn(function(){})'),/error notifications are retired/)
    assert.equal(r.run('savedOff()'),undefined)
    r.transports.installHostEnvironment(policy())
    assert.throws(()=>r.run('savedOn(function(){})'),/error notifications are retired/)
    assert.deepEqual(r.json('[typeof wx.onUnhandledRejection,typeof wx.offUnhandledRejection]'), ['function','function'])
    assert.throws(()=>r.run('wx.onUnhandledRejection(function(){})'),error=>error.code==='ERR_UNSUPPORTED_CAPABILITY')
  })

  test(`${engine}: normalization avoids getters and preserves primitive/stack diagnostics`, () => {
    const r=fixture(engine)
    r.run(`globalThis.trace=[];globalThis.getterCalls=0;wx.onError(function(value){trace.push(value)});
      globalThis.hostile={get message(){getterCalls++;throw Error('getter')},get stack(){getterCalls++;throw Error('getter')}};`)
    r.report(r.run('hostile'));r.report(0);r.report(null);r.report(false)
    const error=r.run(`Object.defineProperty(Error('stacked'),'stack',{value:'fixture own-data stack',configurable:true})`);r.report(error)
    assert.equal(r.run('getterCalls'),0)
    assert.deepEqual(r.json('trace'), ['Error','0','null','false','stacked'])
    assert.equal(r.run('typeof __container_errors[4].stack'),'string')
    // This stage deliberately retains the pre-existing wx string projection.
    assert.equal(r.run('typeof trace[4]'),'string')
  })
}

test('fixed catalog and generator reserve only the wx error pair for runtime ownership', () => {
  assert.equal(errorDescriptors.length,2)
  assert(errorDescriptors.every(entry=>entry.owner==='runtime' && entry.kind==='subscription'))
  assert.deepEqual(errorDescriptors.find(entry=>entry.name==='wx.offError').signatures,
    [{parameters:[{name:'listener',type:'WxOffErrorCallback',optional:true}],returns:'void'}])
  const socket=catalog.apis.find(entry=>entry.name==='object:SocketTask.onError')
  assert.equal(socket.owner,'host')
  const generator=readFileSync(new URL('./generate-host-api-catalog.mjs',import.meta.url),'utf8')
  const globals=/const runtimeGlobals = new Set\(\('([^']+)'\)/.exec(generator)?.[1].split(' ')
  assert(globals?.includes('onError') && globals.includes('offError'))
})


test('actual production default manifest admits both error methods and matches the native fixture', async context => {
  const root=await mkdtemp(path.join(os.tmpdir(),'weapp-error-default-'))
  context.after(()=>rm(root,{recursive:true,force:true}))
  const native=readFileSync(new URL('../crates/container-runtime/tests/error_notifications.rs',import.meta.url),'utf8')
  const source=/const SOURCE: &str = r#"([\s\S]*?)"#;/.exec(native)?.[1]
  assert.equal(typeof source,'string')
  await writeFile(path.join(root,'app.json'),'{"pages":[]}\n')
  await writeFile(path.join(root,'app.js'),source)
  const built=await buildManifest(root,{compilerCommit:'error-default-manifest-contract'})
  assert.deepEqual(built.diagnostics.filter(item=>item.severity==='error'),[])
  assert.equal(built.manifest.capabilities['wx.onError'],'partial')
  assert.equal(built.manifest.capabilities['wx.offError'],'partial')
  const fixtureBytes=readFileSync(new URL('../crates/container-runtime/tests/fixtures/error-default-manifest.json',import.meta.url),'utf8')
  assert.equal(canonicalize(built.manifest)+'\n',fixtureBytes)
  for (const engine of ['quickjs','v8']) {
    const r=fixture(engine)
    assert.equal(r.transports.installHostEnvironment({kind:'capabilities',capabilities:built.manifest.capabilities}),true)
    assert.deepEqual(r.json("[wx.canIUse('onError'),wx.canIUse('offError'),__container_capabilities['wx.onError'],__container_capabilities['wx.offError']]"),[true,true,'partial','partial'])
    r.run("globalThis.trace=[];wx.onError(function(value){trace.push(value)})")
    r.report('default manifest')
    assert.deepEqual(r.json('trace'),['default manifest'])
    assert.equal(r.run('wx.offError()'),undefined)
    r.report('removed');assert.deepEqual(r.json('trace'),['default manifest'])
    const legacy={...built.manifest.capabilities};delete legacy['wx.offError']
    const original=JSON.stringify(legacy)
    assert.equal(r.transports.installHostEnvironment({kind:'capabilities',capabilities:legacy}),true)
    assert.equal(JSON.stringify(legacy),original,'trusted installation does not rewrite legacy manifest input')
    assert.deepEqual(r.json("[wx.canIUse('onError'),wx.canIUse('offError')]"),[true,false])
    r.run("wx.onError(function(value){trace.push(value)})")
    r.report('legacy manifest')
    assert.deepEqual(r.json('trace'),['default manifest','legacy manifest'])
    assert.throws(()=>r.run('wx.offError()'),value=>value.code==='ERR_UNSUPPORTED_CAPABILITY')
    r.transports.dispatchLifecycleNotification('retire',{})
    r.report('retired');assert.deepEqual(r.json('trace'),['default manifest','legacy manifest'])
    assert.deepEqual(r.json('__container_error_handlers'),[])
  }
})
