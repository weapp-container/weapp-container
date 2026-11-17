import assert from 'node:assert/strict';
import test from 'node:test';
import {createAppServiceTestRealm} from './app-service-test-realm.mjs';

// Exact production QuickJS/V8 source compositions run in Node VM realms.
// Entropy responses are deterministic WIRE DOUBLES, not native RNG evidence.
const tick = () => new Promise(resolve => setImmediate(resolve));
function drain(realm) {
  const batch = realm.json('__container_drain_events()');
  assert.equal(realm.transports.installHostEnvironment({kind:'effects-ack',drainId:batch.__containerDrainId}),true);
  return batch.events;
}
const policy = {kind:'capabilities',capabilities:{'wx.onError':'partial','wx.offError':'partial','wx.getRandomValues':'full'}};
for (const engine of ['quickjs','v8']) {
  test(`${engine}: RNG wire delivery reports a thrown callback once, completes and consumes internal rejection`, async () => {
    const realm=createAppServiceTestRealm(engine), unhandled=[];
    const capture=error=>unhandled.push(error);
    process.on('unhandledRejection',capture);
    try {
      assert.equal(realm.transports.installHostEnvironment(policy),true);
      realm.run(`globalThis.trace=[];globalThis.notifications=[];
        wx.onError(message=>notifications.push(message));
        globalThis.__container_report_error=()=>{throw Error('retargeted reporter')};`);
      for (const failed of [false,true]) {
        realm.run(`trace=[];notifications=[];globalThis.returned=wx.getRandomValues({length:1,
          success(result){trace.push('success:'+result.randomValues.byteLength);throw Error('RNG success callback')},
          fail(error){trace.push('fail:'+error.code);throw Error('RNG fail callback')},
          complete(){trace.push('complete')}});`);
        assert.equal(realm.run('returned===undefined'),true);
        const [event]=drain(realm);assert.equal(event.name,'wx.getRandomValues');
        if(failed) realm.run(`__container_resolve_api(${event.id},null,{code:'ERR_ENGINE',errMsg:'getRandomValues:fail wire double'})`);
        else realm.run(`__container_resolve_api(${event.id},{randomValues:{__weappBinary:{type:'ArrayBuffer',bytes:[23]}},errMsg:'getRandomValues:ok'},null)`);
        await tick();await tick();
        assert.deepEqual(realm.json('trace'),[failed?'fail:ERR_ENGINE':'success:1','complete']);
        assert.deepEqual(realm.json('notifications'),[failed?'RNG fail callback':'RNG success callback']);
      }
      assert.deepEqual(unhandled,[]);
      assert.equal(realm.run('wx.offError()'),undefined);
    } finally { process.off('unhandledRejection',capture); }
  });

  test(`${engine}: ordinary host registry preserves both core families and host extension keys`, async () => {
    const realm=createAppServiceTestRealm(engine);
    assert.equal(realm.transports.installHostEnvironment({...policy,capabilities:{...policy.capabilities,'wx.onHostPing':'partial','wx.offHostPing':'partial','weappContainer.identity.getState':'partial'}}),true);
    realm.context.registry={apis:[
      {name:'wx.onHostPing',kind:'subscription',owner:'host',counterpart:'wx.offHostPing'},
      {name:'weappContainer.identity.getState',kind:'syncSnapshot',owner:'host'},
    ],objectApis:[]};
    realm.run(`globalThis.savedRandom=wx.getRandomValues;globalThis.savedOn=wx.onError;globalThis.savedOff=wx.offError;
      globalThis.messages=[];__container_install_host_services(registry);wx.onError(message=>messages.push(message));
      globalThis.returned=wx.getRandomValues({length:1,success(){throw Error('after host installation')},complete(){messages.push('complete')}});`);
    assert.deepEqual(realm.json('[wx.getRandomValues===savedRandom,wx.onError===savedOn,wx.offError===savedOff]'),[true,true,true]);
    assert.equal(realm.run("wx.canIUse('weappContainer.identity.getState')"),true);
    const [event]=drain(realm);assert.equal(event.name,'wx.getRandomValues');
    realm.run(`__container_resolve_api(${event.id},{randomValues:{__weappBinary:{type:'ArrayBuffer',bytes:[1]}},errMsg:'getRandomValues:ok'},null)`);
    await tick();assert.deepEqual(realm.json('messages'),['after host installation','complete']);
    realm.run('wx.offError();wx.onHostPing(function(){})');
    const native=drain(realm);assert.equal(native.length,1);assert.equal(native[0].name,'wx.onHostPing');
  });
}
