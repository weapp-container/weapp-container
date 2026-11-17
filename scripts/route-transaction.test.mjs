// Native callback validators in this Node suite are explicit test doubles.
// Both real production bootstrap compositions are loaded by the shared reader;
// actual Rust parser/engine/Session contracts live in route_transactions.rs.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../crates/container-core/src/route-transaction.js', import.meta.url), 'utf8');
const schedulerSource = readFileSync(new URL('../crates/container-core/src/turn-scheduler.js', import.meta.url), 'utf8');
const apiOwnerSource = readFileSync(new URL('../crates/container-core/src/api-owner.js', import.meta.url), 'utf8');

function fixture(options = {}) {
  const nativeCalls = [], reports = [];
  let handles, active = false, rewritten = false;
  const context = vm.createContext({
    wx: {}, trace: [],
    __container_capabilities: Object.fromEntries(['wx.onBeforeAppRoute','wx.offBeforeAppRoute','wx.onAppRoute','wx.offAppRoute','wx.rewriteRoute'].map(name=>[name,'partial'])),
    __container_report_error: error => { reports.push(String(error)); if(options.report) options.report(context); },
    // Deliberately a validator test double. These tests do not execute the
    // Rust route parser, native source-stack validation or real page routing.
    __container_host_route_rewrite: (url, preserve) => {
      nativeCalls.push({ url, preserve });
      if (!active) return JSON.stringify({ ok: false, errMsg: 'rewriteRoute:fail no native lease' });
      if (rewritten) return JSON.stringify({ ok: false, errMsg: 'rewriteRoute:fail already rewritten' });
      if (url === '/reject') return JSON.stringify({ ok: false, errMsg: 'rewriteRoute:fail rejected' });
      rewritten = true;
      return JSON.stringify({ ok: true, errMsg: 'rewriteRoute:ok' });
    },
  });
  // This isolated route fixture has no Page receivers or native scheduling
  // producer. Compose the real private scheduler and API owner dependency;
  // actual owner/lifecycle behavior is covered by both production bootstraps.
  vm.runInContext(apiOwnerSource, context, { filename: 'api-owner.js' });
  handles = vm.runInContext('(function(){const __host_scheduler_clock=()=>0;const __receiver_weak=new WeakMap();const __receiver_pages=Object.create(null),__receiver_scopes=Object.create(null);' + schedulerSource + source + ';return __container_routes;})()', context, { filename: 'route-transaction.js' });
  const event = JSON.stringify({ routeEventId: 'route:7', path: 'original', query: { key: 'value' },
    openType: 'navigateTo', page: {}, notFound: false, renderer: 'webview', webviewId: 12, pipMode: 'max' });
  return {
    context, nativeCalls, reports, handles,
    run: script => vm.runInContext(script, context),
    before() { active = true; rewritten = false; try { return handles.before(event); } finally { active = false; } },
    after() { return handles.after(event); },
  };
}

test('bootstrap requires native installation and removes synchronous glue', () => {
  assert.throws(() => vm.runInNewContext(source, { wx: {} }), /native synchronous installation/);
  const f = fixture();
  assert.equal(f.run('typeof __container_host_route_rewrite'), 'undefined');
  assert.equal(f.run('typeof __container_host_install_route_dispatch'), 'undefined');
  assert.equal(f.run('typeof __container_route_transactions'), 'undefined');
  assert.equal(f.run('typeof wx.onAppRouteDone'), 'undefined');
});

test('rewrite returns void and validator sees only primitive values before success', () => {
  const f = fixture();
  f.run(`wx.onBeforeAppRoute(function(event) {
    trace.push(event.path);
    const options = { url:'/chosen?x=1', preserveQuery:true,
      success:function(result){trace.push(result.errMsg);result.errMsg='tampered'},
      complete:function(result){trace.push(result.errMsg)},
      toJSON:function(){throw Error('must not serialize options')}
    };
    trace.push(wx.rewriteRoute(options) === undefined);
  });`);
  assert.equal(f.before(), true);
  assert.deepEqual(f.nativeCalls, [{ url: '/chosen?x=1', preserve: true }]);
  assert.equal(f.run('trace.join("|")'), 'original|rewriteRoute:ok|rewriteRoute:ok|true');
});

test('outside listener, after listener and Promise jobs cannot use rewrite authority', async () => {
  const f = fixture();
  f.run(`const failure = result => trace.push(result.errMsg);
    wx.rewriteRoute({url:'/outside',fail:failure});
    wx.onBeforeAppRoute(function(){Promise.resolve().then(function(){wx.rewriteRoute({url:'/job',fail:failure})})});
    wx.onAppRoute(function(){wx.rewriteRoute({url:'/after',fail:failure})});`);
  f.before();
  f.after();
  await f.run('Promise.resolve()');
  assert.equal(f.nativeCalls.length, 0);
  assert.equal(f.run('trace.length'), 3);
  assert.equal(f.run('trace.every(message => message.includes("only allowed"))'), true);
});

test('callback settlement has no rewrite lease and native reserves before success', () => {
  const f = fixture();
  f.run(`wx.onBeforeAppRoute(function(){
    wx.rewriteRoute({url:'/one',success:function(){
      wx.rewriteRoute({url:'/nested',fail:function(r){trace.push(r.errMsg)} });
    }});
    wx.rewriteRoute({url:'/two',fail:function(r){trace.push(r.errMsg)}});
  });`);
  f.before();
  assert.deepEqual(f.nativeCalls.map(call => call.url), ['/one', '/two']);
  assert.equal(f.run('trace[0].includes("only allowed")'), true);
  assert.equal(f.run('trace[1]'), 'rewriteRoute:fail already rewritten');
});

test('invalid primitives and accessor fields do not invoke validator or accessor', () => {
  const f = fixture();
  f.run(`let hooks = 0;
    wx.onBeforeAppRoute(function(){
      const options = {fail:function(r){trace.push(r.code)}};
      Object.defineProperty(options,'url',{get:function(){hooks++;return '/bad'}});
      wx.rewriteRoute(options);
      wx.rewriteRoute({url:'/bad',preserveQuery:1,fail:options.fail});
      wx.rewriteRoute({url:42,fail:options.fail});
      const callbacks = {url:'/good'};
      Object.defineProperty(callbacks,'success',{get:function(){hooks++}});
      wx.rewriteRoute(callbacks);
    });`);
  f.before();
  assert.equal(f.run('hooks'), 0);
  assert.deepEqual(f.nativeCalls, [{ url: '/good', preserve: false }]);
  assert.equal(f.run('trace.length'), 3);
});

test('duplicate/off/listener mutation uses an emission snapshot with isolated event objects', () => {
  const f = fixture();
  f.run(`function added(event){trace.push('added:'+event.path)}
    function second(event){trace.push('second:'+event.path+':'+event.query.key)}
    function first(event){trace.push('first');event.path='forged';event.query.key='forged';
      wx.offBeforeAppRoute(second);wx.onBeforeAppRoute(added)}
    wx.onBeforeAppRoute(first);wx.onBeforeAppRoute(first);wx.onBeforeAppRoute(second);`);
  f.before();
  assert.equal(f.run('trace.join("|")'), 'first|second:original:value');
  f.run('trace.length=0');
  f.before();
  assert.equal(f.run('trace.join("|")'), 'first|added:original');
  f.run('wx.offBeforeAppRoute();trace.length=0');
  f.before();
  assert.equal(f.run('trace.length'), 0);
});

test('guest exceptions are reported, complete still runs and later listeners run', () => {
  const f = fixture();
  f.run(`wx.onBeforeAppRoute(function(){wx.rewriteRoute({url:'/one',
      success:function(){throw Error('success threw')},complete:function(){trace.push('complete')}});
      throw Error('listener threw')});
    wx.onBeforeAppRoute(function(){trace.push('later')});`);
  assert.equal(f.before(), true);
  assert.equal(f.run('trace.join("|")'), 'complete|later');
  assert.equal(f.reports.length, 2);
});

test('invalid native target may fail without corrupting a later valid rewrite', () => {
  const f = fixture();
  f.run(`wx.onBeforeAppRoute(function(){
    wx.rewriteRoute({url:'/reject',fail:function(r){trace.push(r.errMsg)}});
    wx.rewriteRoute({url:'/valid',success:function(r){trace.push(r.errMsg)}});
  });`);
  f.before();
  assert.equal(f.run('trace.join("|")'), 'rewriteRoute:fail rejected|rewriteRoute:ok');
  assert.deepEqual(f.nativeCalls.map(call => call.url), ['/reject', '/valid']);
});

test('captured intrinsics and native handles survive guest compatibility mutations', () => {
  const f = fixture();
  f.run(`wx.onBeforeAppRoute(function(event){
    wx.rewriteRoute({url:'/safe',success:function(r){trace[trace.length]=r.errMsg+':'+event.path}});
  });
  JSON.parse=function(){throw Error('replaced parse')};
  Object.prototype.toJSON=function(){throw Error('prototype toJSON')};
  Array.prototype.slice=function(){throw Error('replaced slice')};
  Reflect.apply=function(){throw Error('replaced apply')};
  wx.onBeforeAppRoute=function(){throw Error('public alias replaced')};`);
  f.before();
  assert.equal(f.run('trace[0]'), 'rewriteRoute:ok:original');
  assert.equal(f.reports.length, 0);
});

test('retirement closes callbacks, pending jobs and future registration', async () => {
  const f = fixture();
  f.run(`wx.onBeforeAppRoute(function(){Promise.resolve().then(function(){
    wx.rewriteRoute({url:'/late',fail:function(r){trace.push(r.errMsg)}})
  })});`);
  f.before();
  f.handles.retire();
  await f.run('Promise.resolve()');
  assert.equal(f.before(), false);
  assert.equal(f.after(), false);
  assert.equal(f.nativeCalls.length, 0);
  assert.throws(() => f.run('wx.onAppRoute(function(){})'), /retired/);
});

test('both production bootstrap compositions retain the private synchronous route transport', async () => {
  const {createAppServiceTestRealm} = await import('./app-service-test-realm.mjs');
  for (const engine of ['quickjs','v8']) {
    const calls=[];
    const realm=createAppServiceTestRealm(engine,{__container_host_route_rewrite:(url,preserve)=>{
      calls.push({url,preserve});return JSON.stringify({ok:true,errMsg:'rewriteRoute:ok'});
    }});
    realm.run("globalThis.routeTrace=[];wx.onBeforeAppRoute(function(event){routeTrace.push(event.path);wx.rewriteRoute({url:'/final',success:function(r){routeTrace.push(r.errMsg)}})});");
    assert.equal(typeof realm.transports.dispatchRouteNotification,'function');
    realm.transports.dispatchRouteNotification('before',JSON.stringify({path:'initial'}));
    assert.deepEqual(calls,[{url:'/final',preserve:false}]);
    assert.deepEqual(realm.json('routeTrace'),['initial','rewriteRoute:ok']);
    assert.equal(realm.run('typeof __container_host_route_rewrite'),'undefined');
    assert.equal(realm.run('typeof __container_routes'),'undefined');
    realm.transports.dispatchLifecycleNotification('retire',null);
    assert.equal(realm.transports.dispatchRouteNotification('before','{}'),false);
  }
});


test('error reporting does not inherit the throwing listener rewrite lease', () => {
  const f=fixture({report:context=>vm.runInContext("wx.rewriteRoute({url:'/report',fail:function(r){trace.push(r.errMsg)}})",context)});
  f.run("wx.onBeforeAppRoute(function(){throw Error('report me')});");
  f.before();
  assert.equal(f.nativeCalls.length,0);
  assert.equal(f.run('trace[0].includes("only allowed")'),true);
});


test('failed unload attempts release only their matching live incarnation and route identity', async () => {
  const {createAppServiceTestRealm}=await import('./app-service-test-realm.mjs');
  for(const engine of ['quickjs','v8']) {
    const realm=createAppServiceTestRealm(engine), dispatch=realm.transports.dispatchLifecycleNotification;
    realm.transports.installHostEnvironment({kind:'capabilities',capabilities:{
      'wx.onBeforePageUnload':'partial','wx.onAfterPageUnload':'partial',
    }});
    dispatch('session',{});
    realm.run(`Page({});__container_set_current_pages([0],[{index:0,instanceId:11,route:'home'}]);
      globalThis.unloadTrace=[];
      wx.onBeforePageUnload(function(e){unloadTrace.push(['before',e.routeEventId])});
      wx.onAfterPageUnload(function(e){unloadTrace.push(['after',e.routeEventId])});`);
    const first={pageId:'11',path:'home',routeEventId:'failed'};
    const second={...first,routeEventId:'retry'};
    assert.equal(dispatch('beforePageUnload',first),true);
    assert.equal(dispatch('cancelPageUnload',second),false);
    assert.equal(dispatch('beforePageUnload',second),false);
    assert.equal(dispatch('cancelPageUnload',first),true);
    assert.equal(dispatch('beforePageUnload',second),true);
    realm.run('__container_invoke_page_instance(11,0,"onUnload",[])');
    assert.equal(dispatch('cancelPageUnload',second),false);
    assert.equal(dispatch('afterPageUnload',first),false);
    assert.equal(dispatch('afterPageUnload',second),true);
    assert.equal(dispatch('afterPageUnload',second),false);
    assert.deepEqual(realm.json('unloadTrace'),[['before','failed'],['before','retry'],['after','retry']]);
  }
});


const routeApis=['wx.onBeforeAppRoute','wx.offBeforeAppRoute','wx.onAppRoute','wx.offAppRoute','wx.rewriteRoute'];
const routePolicy=value=>Object.fromEntries(routeApis.map(name=>[name,value]));

test('trusted policy copies own data, clamps Full and revokes borrowed listener methods', () => {
  const f=fixture();let getters=0;
  f.run('globalThis.borrowedOn=wx.onAppRoute;globalThis.borrowedOff=wx.offAppRoute;wx.onAppRoute(function(){trace.push("old")});');
  const full=routePolicy('full');f.handles.install(full);assert.deepEqual(Object.values(full),['partial','full','partial','full','partial']);
  const denied=routePolicy('unsupported');f.handles.install(denied);
  f.run('for(const name of Object.keys(__container_capabilities))__container_capabilities[name]="full";');
  assert.throws(()=>f.run('borrowedOn(function(){})'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');
  assert.throws(()=>f.run('borrowedOff()'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');
  assert.equal(f.after(),false);assert.equal(f.before(),false);
  f.handles.install(routePolicy('partial'));f.after();assert.equal(f.run('trace.length'),0);
  const getter=routePolicy('partial');Object.defineProperty(getter,'wx.onAppRoute',{get(){getters++;return 'full'}});
  f.handles.install(getter);assert.equal(getters,0);assert.equal(f.after(),false);
});

test('off-only revocation retires its pair and publication cannot resume an old emission snapshot', () => {
  const f=fixture();f.context.publish=()=>{f.handles.install(routePolicy('unsupported'));f.handles.install(routePolicy('partial'));};
  f.run('wx.onAppRoute(function(){trace.push("first");publish()});wx.onAppRoute(function(){trace.push("stale")});');
  f.after();assert.equal(f.run('trace.join()'),'first');f.after();assert.equal(f.run('trace.join()'),'first');
  f.run('wx.onAppRoute(function(){trace.push("fresh")})');const cap=routePolicy('partial');cap['wx.offAppRoute']='unsupported';f.handles.install(cap);
  assert.equal(cap['wx.onAppRoute'],'unsupported');assert.equal(f.after(),false);
  assert.throws(()=>f.run('wx.onAppRoute(function(){})'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');
  f.handles.install(routePolicy('partial'));f.after();assert.equal(f.run('trace.join()'),'first');
});

test('both production compositions enforce trusted Unsupported and never execute a forged rewrite', async () => {
  const {createAppServiceTestRealm}=await import('./app-service-test-realm.mjs');
  for(const engine of ['quickjs','v8']) {
    let calls=0;const realm=createAppServiceTestRealm(engine,{__container_host_route_rewrite:()=>{calls++;return JSON.stringify({ok:true,errMsg:'rewriteRoute:ok'})}});
    for(const name of routeApis)assert.equal(realm.run(`wx.canIUse(${JSON.stringify(name.slice(3))})`),true);
    realm.run('globalThis.denials=[];globalThis.oldOn=wx.onAppRoute;globalThis.oldOff=wx.offAppRoute;wx.onAppRoute(function(){denials.push("stale")});');
    realm.transports.installHostEnvironment({kind:'capabilities',capabilities:routePolicy('unsupported')});
    realm.run('for(const name of Object.keys(__container_capabilities))__container_capabilities[name]="full";');
    for(const name of routeApis.slice(0,4))assert.throws(()=>realm.run(`wx[${JSON.stringify(name.slice(3))}](function(){})`),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');
    assert.throws(()=>realm.run('oldOn(function(){})'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');
    assert.throws(()=>realm.run('oldOff()'),e=>e.code==='ERR_UNSUPPORTED_CAPABILITY');
    assert.equal(realm.transports.dispatchRouteNotification('before','{}'),false);assert.equal(realm.transports.dispatchRouteNotification('after','{}'),false);
    realm.run('wx.rewriteRoute({url:"/forged",fail:function(e){denials.push(e.code)}})');assert.equal(calls,0);
    assert.deepEqual(realm.json('denials'),['ERR_UNSUPPORTED_CAPABILITY']);
    realm.transports.installHostEnvironment({kind:'capabilities',capabilities:routePolicy('full')});
    assert.deepEqual(realm.json(`${JSON.stringify(routeApis)}.map(function(name){return __container_capabilities[name]})`),['partial','full','partial','full','partial']);
    assert.deepEqual(realm.json("[__container_capabilities['wx.onError'],__container_capabilities['wx.offError']]"),['unsupported','unsupported']);
    realm.transports.dispatchRouteNotification('after','{}');assert.deepEqual(realm.json('denials'),['ERR_UNSUPPORTED_CAPABILITY']);
    const rewriteDenied=routePolicy('partial');rewriteDenied['wx.rewriteRoute']='unsupported';realm.transports.installHostEnvironment({kind:'capabilities',capabilities:rewriteDenied});
    realm.run('wx.onBeforeAppRoute(function(){wx.rewriteRoute({url:"/forged",fail:function(e){denials.push(e.code)}})})');
    realm.transports.dispatchRouteNotification('before','{}');assert.equal(calls,0);assert.equal(realm.json('denials').at(-1),'ERR_UNSUPPORTED_CAPABILITY');
  }
});
