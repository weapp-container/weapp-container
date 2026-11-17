import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createAppServiceTestRealm } from './app-service-test-realm.mjs'

// Exact production compositions in a Node VM, with retained native transports
// invoked by the test host. Real App/Page producer coverage remains native.
const events = [['AppShow','show'],['AppHide','hide'],['BeforePageUnload','beforePageUnload'],['AfterPageUnload','afterPageUnload']]
const names = events.flatMap(([event]) => ['wx.on'+event,'wx.off'+event])
const policy = (overrides = {}) => ({kind:'capabilities',capabilities:{...Object.fromEntries(names.map(name=>[name,'full'])),...overrides}})
const unsupported = error => error.code === 'ERR_UNSUPPORTED_CAPABILITY'
const catalog = JSON.parse(readFileSync(new URL('../crates/container-runtime/src/host-api-catalog.json',import.meta.url)))

function fixture(engine) {
  const r = createAppServiceTestRealm(engine)
  r.transports.installHostEnvironment(policy())
  const dispatch = r.transports.dispatchLifecycleNotification
  dispatch('session',{})
  r.run('Page({});globalThis.trace=[]')
  let serial=10
  function page() {
    const id=++serial
    r.run(`__container_set_current_pages([0],[{index:0,instanceId:${id},route:'home'}]);globalThis.page=__container_page_instances['${id}']`)
    return {pageId:String(id),path:'home',routeEventId:'route:'+id}
  }
  function finish(record) {
    r.run(`__container_invoke_page_instance(${Number(record.pageId)},0,'onUnload',[])`)
    return dispatch('afterPageUnload',record)
  }
  function emit(name) {
    if(name==='show'||name==='hide') return dispatch(name,{scene:1001,reason:2})
    const record=page()
    const accepted=dispatch('beforePageUnload',record)
    const finished=finish(record)
    return name==='beforePageUnload'?accepted:finished
  }
  return {...r,dispatch,page,finish,emit}
}

for(const engine of ['quickjs','v8']) {
  test(`${engine}: bootstrap preserves only its existing AppShow/AppHide Partial defaults`,()=>{
    const r=createAppServiceTestRealm(engine)
    assert.deepEqual(r.json(`[${names.map(name=>`__container_capabilities['${name}']`).join(',')}]`),
      ['partial','unsupported','partial','unsupported','unsupported','unsupported','unsupported','unsupported'])
    for(const name of names.filter(name=>!['wx.onAppShow','wx.onAppHide'].includes(name)))
      assert.throws(()=>r.run(`${name}(${name.includes('.on')?'function(){}':''})`),unsupported)
  })

  for(const [event,kind] of events) {
    const on='wx.on'+event,off='wx.off'+event
    test(`${engine}: ${event} validates callbacks, deduplicates, and removes by identity or omission`,()=>{
      const r=fixture(engine)
      assert.deepEqual(r.json(`(function(){globalThis.a=function(){trace.push('a')};globalThis.b=function(){trace.push('b')};
        return [${on}(a),${on}(b),${on}(a),${off}(function(){})].map(value=>value===undefined)})()`),[true,true,true,true])
      r.emit(kind);assert.equal(r.run(`${off}(a)`),undefined);r.emit(kind)
      assert.equal(r.run(`${off}()`),undefined);r.emit(kind)
      assert.deepEqual(r.json('trace'),['a','b','b'])
      for(const value of ['null','1','{}','[]']) {
        assert.throws(()=>r.run(`${on}(${value})`),/listener must be a function/)
        assert.throws(()=>r.run(`${off}(${value})`),/listener must be a function/)
      }
    })

    test(`${engine}: ${event} ordinary off preserves an emission snapshot`,()=>{
      const r=fixture(engine)
      r.run(`function later(){trace.push('later')};${on}(function(){trace.push('first');${off}();${on}(later)});${on}(function(){trace.push('second')})`)
      r.emit(kind);r.emit(kind)
      assert.deepEqual(r.json('trace'),['first','second','later'])
    })

    test(`${engine}: ${event} own admission is independent and Partial grades stay Partial`,()=>{
      const r=fixture(engine)
      r.run(`globalThis.on=${on};globalThis.off=${off};globalThis.callback=function(){trace.push('kept')};on(callback)`)
      r.transports.installHostEnvironment(policy({[on]:'partial',[off]:'unsupported'}))
      assert.throws(()=>r.run('off()'),unsupported);r.emit(kind)
      r.transports.installHostEnvironment(policy({[on]:'partial',[off]:'partial'}))
      assert.deepEqual(r.json(`[__container_capabilities['${on}'],__container_capabilities['${off}']]`),['partial','partial'])
      r.run('off(callback)');r.emit(kind)
      r.transports.installHostEnvironment(policy({[on]:'unsupported',[off]:'full'}))
      assert.equal(r.run('off()'),undefined)
      r.run(`__container_capabilities['${on}']='full';__container_capabilities['${off}']='full'`)
      assert.throws(()=>r.run('on(callback)'),unsupported)
      assert.deepEqual(r.json('trace'),['kept'])
    })

    test(`${engine}: ${event} trusted withdrawal cancels only its active tail and never resurrects it`,()=>{
      const r=fixture(engine)
      r.context.withdraw=()=>{
        r.transports.installHostEnvironment(policy({[on]:'unsupported'}))
        r.transports.installHostEnvironment(policy())
      }
      r.run(`${on}(function(){trace.push('first');withdraw()});${on}(function(){trace.push('stale')});wx.onAppHide(function(){trace.push('other')})`)
      r.emit(kind);r.emit(kind)
      if(kind!=='hide') {r.emit('hide');assert.deepEqual(r.json('trace'),['first','other'])}
      else assert.deepEqual(r.json('trace'),['first'])
    })

    test(`${engine}: ${event} terminal retirement cuts a captured tail and later grants cannot revive it`,()=>{
      const r=fixture(engine)
      r.context.retire=()=>r.dispatch('retire',{})
      r.run(`globalThis.on=${on};globalThis.off=${off};on(function(){trace.push('first');retire()});on(function(){trace.push('retired')})`)
      r.emit(kind);r.transports.installHostEnvironment(policy())
      assert.equal(r.emit(kind),false)
      assert.throws(()=>r.run('on(function(){})'),/notifications are retired/)
      assert.equal(r.run('off()'),undefined)
      assert.deepEqual(r.json('trace'),['first'])
    })
  }

  test(`${engine}: before denial still records the departure and after denial does not prevent retirement`,()=>{
    for(const denied of ['wx.onBeforePageUnload','wx.onAfterPageUnload']) {
      const r=fixture(engine),allowed=denied.includes('Before')?'After':'Before'
      r.transports.installHostEnvironment(policy({[denied]:'unsupported'}))
      r.run(`wx.on${allowed}PageUnload(function(event){trace.push({keys:Object.keys(event),path:event.path,id:event.routeEventId,actual:event.page===page})})`)
      const record=r.page()
      assert.equal(r.dispatch('beforePageUnload',record),true)
      assert.equal(r.finish(record),true)
      assert.equal(r.dispatch('afterPageUnload',record),false)
      assert.deepEqual(r.json('trace'),[{keys:allowed==='Before'?['path','routeEventId','page']:['path','routeEventId'],path:'home',id:record.routeEventId,actual:allowed==='Before'}])
    }
  })

  test(`${engine}: withdrawal and regrant during a pending departure preserve matching retirement and cancellation`,()=>{
    const r=fixture(engine)
    r.run(`wx.onBeforePageUnload(function(){trace.push('before')});wx.onAfterPageUnload(function(e){trace.push('after:'+e.routeEventId)})`)
    const first=r.page(),retry={...first,routeEventId:'retry'}
    assert.equal(r.dispatch('beforePageUnload',first),true)
    r.transports.installHostEnvironment(policy({'wx.onBeforePageUnload':'unsupported'}))
    assert.equal(r.dispatch('cancelPageUnload',retry),false)
    assert.equal(r.dispatch('cancelPageUnload',first),true)
    r.transports.installHostEnvironment(policy())
    assert.equal(r.dispatch('beforePageUnload',retry),true)
    assert.equal(r.finish(retry),true)
    assert.deepEqual(r.json('trace'),['before','after:retry'])
  })

  test(`${engine}: reentrant before withdrawal fences its tail while the same departure still reaches after`,()=>{
    const r=fixture(engine)
    r.context.withdraw=()=>{
      r.transports.installHostEnvironment(policy({'wx.onBeforePageUnload':'unsupported'}))
      r.transports.installHostEnvironment(policy())
    }
    r.run(`wx.onBeforePageUnload(function(e){trace.push('head:'+e.routeEventId);withdraw()});
      wx.onBeforePageUnload(function(){trace.push('stale')});wx.onAfterPageUnload(function(e){trace.push('after:'+e.routeEventId)})`)
    assert.equal(r.emit('beforePageUnload'),true)
    assert.deepEqual(r.json('trace'),['head:route:11','after:route:11'])
  })

  test(`${engine}: full environment publication uses the same private lifecycle admission`,()=>{
    const r=fixture(engine)
    r.run(`wx.onBeforePageUnload(function(){trace.push('before')});wx.onAfterPageUnload(function(e){trace.push('after:'+e.routeEventId)})`)
    const record=r.page()
    assert.equal(r.dispatch('beforePageUnload',record),true)
    assert.equal(r.transports.installHostEnvironment({version:'1.0',domQuery:false,
      capabilities:policy({'wx.onBeforePageUnload':'unsupported'}).capabilities,
      syncApiValues:{},syncApiErrors:{},storage:null,files:null}),true)
    assert.throws(()=>r.run('wx.onBeforePageUnload(function(){})'),unsupported)
    assert.equal(r.finish(record),true)
    assert.deepEqual(r.json('trace'),['before','after:'+record.routeEventId])
  })

  test(`${engine}: inherited method grants never replace missing own declarations`,()=>{
    const r=fixture(engine)
    const inherited=Object.create(Object.fromEntries(names.map(name=>[name,'full'])))
    inherited['wx.offAppShow']='partial'
    assert.equal(r.transports.installHostEnvironment({kind:'capabilities',capabilities:inherited}),true)
    for(const name of names.filter(name=>name!=='wx.offAppShow'))
      assert.throws(()=>r.run(`${name}(${name.includes('.on')?'function(){}':''})`),unsupported)
    assert.equal(r.run('wx.offAppShow()'),undefined)
    assert.equal(r.run(`__container_capabilities['wx.offAppShow']`),'partial')
  })

  test(`${engine}: callback identities and captured intrinsics survive public alias and method poisoning`,()=>{
    const r=fixture(engine)
    r.run(`globalThis.reads=0;globalThis.on=wx.onAppShow;globalThis.off=wx.offAppShow;
      globalThis.callback=function(){trace[trace.length]='kept'};Object.defineProperty(callback,'toJSON',{get:function(){reads++;throw Error('serialized')}});
      on(callback);on(callback);wx.onAppShow=function(){};wx.offAppShow=function(){throw Error('fake')};
      __container_app_listeners={show:[function(){trace[trace.length]='forged'}]};
      Array.prototype.slice=Array.prototype.splice=Array.prototype.push=Object.create=Object.defineProperty=Object.getOwnPropertyDescriptor=Reflect.apply=function(){throw Error('poisoned')}`)
    r.emit('show');r.run('off(callback)');r.emit('show')
    assert.deepEqual(r.json('trace'),['kept']);assert.equal(r.run('reads'),0)
  })

  test(`${engine}: denied visibility listeners still pause and resume the realm scheduler`,async()=>{
    const r=fixture(engine)
    r.transports.installHostEnvironment(policy({'wx.onAppHide':'unsupported','wx.onAppShow':'unsupported','wx.nextTick':'partial'}))
    r.dispatch('hide',{});r.run(`wx.nextTick(function(){trace.push('resumed')})`)
    const command=(action,extra={})=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'turn-scheduler',action,...extra}))
    await Promise.resolve()
    command('begin',{limit:64,idleBudgetMs:null})
    try {assert.equal(command('task',{allowIdle:false}).called,false)} finally {command('end')}
    assert.deepEqual(r.json('trace'),[])
    r.dispatch('show',{});command('begin',{limit:64,idleBudgetMs:null})
    try {assert.equal(command('task',{allowIdle:false}).called,true)} finally {command('end')}
    assert.deepEqual(r.json('trace'),['resumed'])
  })

  test(`${engine}: reentrant app listeners use null Page ownership for real nextTick`,async()=>{
    const r=fixture(engine)
    r.transports.installHostEnvironment(policy({'wx.nextTick':'partial'}))
    r.context.nativeShow=()=>r.dispatch('show',{})
    const record=r.page()
    r.run(`wx.onAppShow(function(){trace.push(__container_capture_api_owner()===null);wx.nextTick(function(){trace.push('realm')})});
      page.fire=function(){nativeShow();wx.nextTick(function(){trace.push('stalePage')})};
      __container_invoke_page_instance(${Number(record.pageId)},0,'fire',[]);
      __container_invoke_page_instance(${Number(record.pageId)},0,'onUnload',[])`)
    const command=(action,extra={})=>JSON.parse(r.transports.captureReceiverIncarnations({kind:'turn-scheduler',action,...extra}))
    await Promise.resolve();command('begin',{limit:64,idleBudgetMs:null})
    try {for(let i=0;i<64;i++){if(!command('task',{allowIdle:false}).called)break;await Promise.resolve()}} finally {command('end')}
    assert.deepEqual(r.json('trace'),[true,'realm'])
  })

  test(`${engine}: direct and unrelated counterpart descriptors cannot replace any lifecycle method`,()=>{
    const rows=catalog.apis.filter(row=>names.includes(row.name))
    for(const apis of [rows.map(row=>({...row,owner:'host'})),
      rows.map((row,index)=>({name:'wx.onForeignLifecycle'+index,kind:'subscription',owner:'host',counterpart:row.name}))]) {
      const r=fixture(engine)
      r.context.registry={apis,objectApis:[]}
      r.run(`globalThis.saved=[${names.join(',')}];__container_install_host_services(registry)`)
      assert.deepEqual(r.json(`[${names.map((name,index)=>`${name}===saved[${index}]`).join(',')}]`),names.map(()=>true))
      r.run(`wx.onAppShow(function(){trace.push('actual')})`);r.emit('show');r.run('wx.offAppShow()');r.emit('show')
      assert.deepEqual(r.json('trace'),['actual'])
      assert.equal(r.run(`__container_events.filter(row=>row.type==='api.call').length`),0)
    }
  })

  test(`${engine}: standalone App hook failure remains the original error while listeners run once`,()=>{
    const r=createAppServiceTestRealm(engine)
    r.transports.installHostEnvironment(policy())
    r.run(`globalThis.trace=[];globalThis.original=Error('hook');App({onShow:function(){trace.push('hook');throw original}});
      wx.onAppShow(function(){trace.push('throwing');throw Error('listener')});wx.onAppShow(function(){trace.push('later')})`)
    assert.throws(()=>r.run(`__container_invoke_app('onShow',[{scene:1001}])`),error=>error===r.run('original'))
    assert.deepEqual(r.json('trace'),['hook','throwing','later'])
    assert.equal(r.run(`__container_errors.filter(row=>row.message==='listener').length`),1)
  })
}

test('catalog changes exactly lifecycle ownership while retaining locked signatures and defaults',()=>{
  const rows=catalog.apis.filter(row=>names.includes(row.name))
  assert.equal(rows.length,8)
  for(const row of rows) {
    const off=row.name.includes('.off'),name=row.name.slice(3)
    assert.equal(row.owner,'runtime');assert.equal(row.kind,'subscription');assert.equal(row.baseline,'included')
    assert.deepEqual(row.signatures,[{parameters:[{name:'listener',type:name[0].toUpperCase()+name.slice(1)+'Callback',optional:off}],returns:'void'}])
  }
  const generator=readFileSync(new URL('./generate-host-api-catalog.mjs',import.meta.url),'utf8')
  const globals=/const runtimeGlobals = new Set\(\('([^']+)'\)/.exec(generator)[1].split(' ')
  for(const name of names)assert(globals.includes(name.slice(3)))
})
