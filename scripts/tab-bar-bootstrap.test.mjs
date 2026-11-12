import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppServiceTestRealm } from './app-service-test-realm.mjs';
function events(value) { const batch=value.json('__container_drain_events()'); value.transports.installHostEnvironment({kind:'effects-ack',drainId:batch.__containerDrainId}); return batch.events; }
const methods = ['setTabBarBadge', 'removeTabBarBadge', 'showTabBarRedDot', 'hideTabBarRedDot', 'setTabBarStyle'];
for (const engine of ['quickjs', 'v8']) {
  function realm(supported = true) {
    const value = createAppServiceTestRealm(engine, { __container_host_performance_now: () => 0 });
    assert.equal(value.transports.installHostEnvironment({kind:'capabilities', capabilities:Object.fromEntries(methods.map(method=>['wx.'+method,supported?'partial':'unsupported']))}), true);
    return value;
  }
  test(`${engine}: real shared tabBar bridge queues calls and resolves native callback/Promise failures`, async () => {
    const value = realm();
    value.run(`globalThis.log=[]; globalThis.result=wx.setTabBarBadge({index:1,text:'12',success:r=>log.push(r.errMsg),complete:r=>log.push('complete')});`);
    const queued = events(value);
    assert.equal(queued.length,1);
    assert.equal(queued[0].name,'wx.setTabBarBadge');
    assert.deepEqual(queued[0].options,{index:1,text:'12'});
    value.run(`__container_resolve_api(${queued[0].id},{errMsg:'setTabBarBadge:ok'},null)`);
    await value.run('result');
    assert.deepEqual(value.json('log'),['setTabBarBadge:ok','complete']);
    value.run(`globalThis.failed=wx.setTabBarStyle({color:'red',fail:r=>log.push(r.code),complete:r=>log.push('failed-complete')}); failed.catch(()=>{});`);
    const next = events(value)[0];
    value.run(`__container_resolve_api(${next.id},null,{errMsg:'setTabBarStyle:fail invalid color',code:'ERR_INVALID_REQUEST'})`);
    await assert.rejects(value.run('failed'), error=>error.code==='ERR_INVALID_REQUEST');
    assert.deepEqual(value.json('log'),['setTabBarBadge:ok','complete','ERR_INVALID_REQUEST','failed-complete']);
  });
  test(`${engine}: optional style and explicit unsupported admission have real completion flow`, async () => {
    const value = realm();
    value.run(`globalThis.pending=wx.setTabBarStyle();`);
    const [event] = events(value);
    assert.deepEqual(event.options,{});
    value.run(`__container_resolve_api(${event.id},{errMsg:'setTabBarStyle:ok'},null)`);
    await value.run('pending');
    const blocked = realm(false);
    blocked.run(`globalThis.log=[];globalThis.pending=wx.showTabBarRedDot({index:0,fail:r=>log.push(r.code),complete:()=>log.push('complete')}); pending.catch(()=>{});`);
    await assert.rejects(blocked.run('pending'),error=>error.code==='ERR_UNSUPPORTED_CAPABILITY');
    assert.deepEqual(events(blocked),[]);
    assert.deepEqual(blocked.json('log'),['ERR_UNSUPPORTED_CAPABILITY','complete']);
  });
  test(`${engine}: unfinished visibility and icon contracts fail through callbacks and Promise`, async () => {
    const value = realm();
    value.run(`globalThis.log=[]; globalThis.pending=wx.showTabBar({animation:true,fail:r=>log.push(r.code)});pending.catch(()=>{});`);
    await assert.rejects(value.run('pending'),error=>error.code==='ERR_UNSUPPORTED_CAPABILITY');
    value.run(`globalThis.pending=wx.setTabBarItem({index:0,iconPath:'https://example.test/icon.png'});pending.catch(()=>{});`);
    await assert.rejects(value.run('pending'),error=>error.code==='ERR_UNSUPPORTED_CAPABILITY');
    assert.deepEqual(events(value),[]);
    assert.deepEqual(value.json('log'),['ERR_UNSUPPORTED_CAPABILITY']);
  });
  test(`${engine}: untrusted prototype fields, accessors and toJSON cannot alter accepted options`, async () => {
    const value = realm();
    value.run(`globalThis.reads=0; Object.defineProperty(Object.prototype,'index',{set(){throw Error('setter')},configurable:true});
      const options=Object.create({text:'secret',toJSON(){throw Error('json')}});
      Object.defineProperty(options,'index',{value:0,enumerable:true});
      globalThis.first=wx.setTabBarBadge(options); first.catch(()=>{});`);
    await assert.rejects(value.run('first'),error=>error.code==='ERR_INVALID_REQUEST');
    assert.deepEqual(events(value),[]);
    value.run(`globalThis.second=wx.setTabBarBadge({get index(){reads++;return 1},text:'1'}); second.catch(()=>{});`);
    await assert.rejects(value.run('second'),error=>error.code==='ERR_INVALID_REQUEST');
    assert.equal(value.run('reads'),0);
    assert.deepEqual(events(value),[]);
  });
  test(`${engine}: primitive snapshots and retained callbacks never execute nested toJSON`, async () => {
    const value = realm();
    value.run(`globalThis.hooks=0;globalThis.log=[];
      const success=r=>log.push(r.errMsg);
      Object.defineProperty(success,'toJSON',{get(){hooks++;throw Error('callback serialized')}});
      const options={index:0,text:'1',success};
      globalThis.pending=wx.setTabBarBadge(options);
      options.success=()=>log.push('wrong callback');options.text='changed';`);
    const [event] = events(value);
    assert.deepEqual(event.options,{index:0,text:'1'});
    assert.equal(value.run('hooks'),0);
    value.run(`__container_resolve_api(${event.id},{errMsg:'setTabBarBadge:ok'},null)`);
    await value.run('pending');
    assert.deepEqual(value.json('log'),['setTabBarBadge:ok']);
    for (const [method,field,primitive] of [
      ['setTabBarBadge','index',0],['setTabBarBadge','text','1'],
      ['removeTabBarBadge','index',0],['showTabBarRedDot','index',0],['hideTabBarRedDot','index',0],
      ...['color','selectedColor','backgroundColor','borderStyle'].map(field=>['setTabBarStyle',field,field==='borderStyle'?'white':'#123456'])
    ]) {
      value.run(`globalThis.pending=wx[${JSON.stringify(method)}]({index:0,text:'1',[${JSON.stringify(field)}]:{toJSON(){hooks++;return ${JSON.stringify(primitive)}}}});pending.catch(()=>{});`);
      await assert.rejects(value.run('pending'),error=>error.code==='ERR_INVALID_REQUEST');
      assert.deepEqual(events(value),[]);
      assert.equal(value.run('hooks'),0);
    }
  });
}
