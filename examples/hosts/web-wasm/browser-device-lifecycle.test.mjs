import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {BrowserHostServices} from './browser-host-services.mjs'
const catalog=JSON.parse(await readFile(new URL('../../../crates/container-runtime/src/host-api-catalog.json',import.meta.url)))
const trusted={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:1}}
const turn=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
class Transport {
  requests=[];completions=[];events=[];sequence=0
  host_services_protocol_json(){return '{"version":"1.0"}'}
  configure_host_services_json(value){this.config=JSON.parse(value)}
  take_host_requests_json(){return JSON.stringify(this.requests.splice(0))}
  complete_host_api_call_json(callId,value){this.completions.push({callId,...JSON.parse(value)});return '{}'}
  dispatch_host_api_event_json(value){this.events.push(JSON.parse(value));return '{}'}
  revoke_host_services_json(){this.revoked=true;return '[]'}
  call(method,payload={}){const callId='call-'+ ++this.sequence;this.requests.push({kind:'call',method,payload,callId,context:{...trusted,sessionId:'owner',callId,api:method}});return callId}
  cancel(callId){this.requests.push({kind:'cancel',callId})}
}
async function fixture(environment={},options={}){
  const runtime=new Transport(),document=Object.assign(new EventTarget(),{hidden:false}),window=new EventTarget()
  const env={navigator:{},document,window,setTimeout,clearTimeout,...environment}
  const errors=[],services=new BrowserHostServices({runtime,catalog,environment:env,onDiagnostic:error=>errors.push(error),...options})
  await services.configure(trusted)
  const flush=async()=>{await services.drain();await turn();await services.drain()}
  return {runtime,services,env,errors,flush}
}
const coords={latitude:1,longitude:2,accuracy:3,speed:0,altitude:0,altitudeAccuracy:0}

test('one-shot location owns an actual watch including ID zero, clears before result and suppresses late values',async()=>{
  const stops=[];let callback
  const f=await fixture({navigator:{geolocation:{watchPosition(success){callback=success;return 0},clearWatch(id){stops.push(id)}}}})
  f.runtime.call('wx.getLocation');await f.services.drain();await turn();callback({coords})
  assert.deepEqual(stops,[0]);assert.equal(f.runtime.completions.length,0)
  callback({coords:{...coords,latitude:99}});await f.flush()
  assert.equal(f.runtime.completions.length,1);assert.equal(f.runtime.completions[0].result.latitude,1)
  await f.services.close();assert.deepEqual(stops,[0])
})

test('location cancellation releases exact source and failed clearWatch remains an owner barrier until explicit retry',async()=>{
  let callback,attempts=0,fail=true
  const f=await fixture({navigator:{geolocation:{watchPosition(success){callback=success;return 7},clearWatch(id){assert.equal(id,7);attempts++;if(fail)throw new Error('clear failed')}}}})
  const call=f.runtime.call('wx.getLocation');await f.services.drain();await turn()
  f.runtime.cancel(call);await f.services.drain();await turn();callback({coords})
  await assert.rejects(f.services.close(),/close failed/);assert.equal(attempts,2)
  fail=false;await f.services.close();assert.equal(attempts,3);assert.equal(f.runtime.completions.length,0)
  await f.services.close();assert.equal(attempts,3)
})

test('continuous location revokes queued values and old callbacks across stop and restart',async()=>{
  const callbacks=[],stops=[]
  const f=await fixture({navigator:{geolocation:{watchPosition(callback){callbacks.push(callback);return callbacks.length},clearWatch(id){stops.push(id)}}}})
  f.runtime.call('wx.onLocationChange',{action:'subscribe',subscriptionId:'position'});f.runtime.call('wx.startLocationUpdate');await f.flush()
  // Stop is delivered by the normal owner request lane. Callback delivery is
  // deliberately paused until that stop's actual handler has run.
  f.runtime.call('wx.stopLocationUpdate');await f.services.drain();callbacks[0]({coords});await turn();await f.services.drain()
  assert.equal(f.runtime.events.length,0)
  f.runtime.call('wx.startLocationUpdate');await f.flush();callbacks[0]({coords});callbacks[1]({coords:{...coords,latitude:4}});await f.services.drain()
  assert.equal(f.runtime.events.length,1);assert.equal(f.runtime.events[0].value.latitude,4);assert.deepEqual(stops,[1])
  await f.services.close();assert.deepEqual(stops,[1,2])
})

test('late sensor permission never installs a stopped listener and close waits the actual permission terminal',async()=>{
  const permission=deferred(),window=new EventTarget();let listeners=0
  const add=window.addEventListener.bind(window);window.addEventListener=(event,listener)=>{if(event==='devicemotion')listeners++;return add(event,listener)}
  const f=await fixture({window,DeviceMotionEvent:{requestPermission:()=>permission.promise}})
  f.runtime.call('wx.startAccelerometer');await f.services.drain();await turn()
  f.runtime.call('wx.stopAccelerometer');await f.services.drain();await turn()
  let closed=false;const closing=f.services.close().then(()=>closed=true);await turn();assert.equal(closed,false)
  permission.resolve('granted');await closing;assert.equal(listeners,0);assert.equal(f.runtime.completions.length,0)
})

test('sensor hide revokes pending queue entries; failed exact remove is retained and retried',async()=>{
  const window=new EventTarget(),remove=window.removeEventListener.bind(window);let fail=true,removals=0
  window.removeEventListener=(event,listener)=>{if(event==='devicemotion'){removals++;if(fail)throw new Error('remove failed')}return remove(event,listener)}
  const f=await fixture({window,DeviceMotionEvent:{}})
  f.runtime.call('wx.onAccelerometerChange',{action:'subscribe',subscriptionId:'acceleration'});f.runtime.call('wx.startAccelerometer');await f.flush()
  const sample=Object.assign(new Event('devicemotion'),{accelerationIncludingGravity:{x:1,y:2,z:3}});window.dispatchEvent(sample)
  f.env.document.hidden=true;f.env.document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(sample);await f.services.drain()
  assert.equal(f.runtime.events.length,0)
  await assert.rejects(f.services.close(),/close failed/);fail=false;await f.services.close();assert.equal(removals,3)
})

test('late wake-lock acquisition waits exact asynchronous release; failed releases can be retried',async()=>{
  const acquisition=deferred(),released=deferred();let releases=0,fail=true
  const f=await fixture({navigator:{wakeLock:{request:()=>acquisition.promise}}})
  f.runtime.call('wx.setKeepScreenOn',{keepScreenOn:true});await f.services.drain();await turn()
  let closed=false;const closing=f.services.close();closing.catch(()=>{});await turn();assert.equal(closed,false)
  acquisition.resolve({release(){releases++;if(fail)return released.promise;return Promise.resolve()}});await turn()
  const rejected=assert.rejects(closing,/close failed/);released.reject(new Error('lock release failed'));await rejected
  fail=false;await f.services.close();closed=true;assert.equal(closed,true);assert.equal(releases,2)
})

test('wake-lock acquisition is refused while the document is hidden', async () => {
  let requests = 0
  const f = await fixture({ navigator: { wakeLock: { request: async () => { requests++; return { release: async () => {} } } } } })
  f.env.document.hidden = true
  const callId = f.runtime.call('wx.setKeepScreenOn', { keepScreenOn: true })
  await f.flush()
  const completion = f.runtime.completions.find(value => value.callId === callId)
  assert.equal(completion?.error.code, 'permission_denied')
  assert.equal(requests, 0)
  await f.services.close()
})

test('retirement waits a custom host operation and shares one close promise without old guest completion',async()=>{
  const operation=deferred();const f=await fixture({}, {identity:{login:()=>operation.promise}})
  f.runtime.call('wx.login');await f.services.drain();await turn()
  const closing=f.services.close();assert.equal(f.services.close(),closing);let closed=false;void closing.then(()=>closed=true)
  await turn();assert.equal(closed,false);operation.resolve({code:'obsolete'});await closing
  assert.equal(f.runtime.completions.length,0);assert.equal(f.runtime.revoked,true)
})

test('a full producer queue cannot strand 256 terminal results, including oversized successes',async()=>{
  class Socket extends EventTarget {readyState=1;bufferedAmount=0;close(){this.readyState=3}send(){}}
  let socket
  const f=await fixture({location:{origin:'https://host.test'},WebSocket:class extends Socket{constructor(){super();socket=this}}},{identity:{login:()=>({code:'x'.repeat(4*1024*1024)})}})
  f.runtime.call('wx.connectSocket',{url:'wss://host.test',objectId:'socket'});await f.flush()
  f.runtime.call('object:SocketTask.onMessage',{objectId:'socket',subscriptionId:'message',action:'subscribe'});await f.flush()
  // Fill real non-coalesced producers after the next drain starts, so terminal
  // settlement must survive an event queue already at its entry bound.
  for(let i=0;i<256;i++)f.runtime.call('wx.login')
  await f.services.drain();for(let i=0;i<256;i++)socket.dispatchEvent(Object.assign(new Event('message'),{data:'sample-'+i}));await turn()
  for(let i=0;i<4;i++)await f.services.drain()
  const results=f.runtime.completions.slice(2)
  assert.equal(results.length,256);assert.equal(new Set(results.map(value=>value.callId)).size,256)
  assert.ok(results.some(value=>value.error?.message.includes('byte budget')));assert.equal(f.runtime.events.length,256)
  await f.services.close()
})

test('transient native completion transport failure retains the exact terminal for the next owner pump',async()=>{
  const f=await fixture({}, {identity:{login:()=>({code:'once'})}})
  const complete=f.runtime.complete_host_api_call_json.bind(f.runtime);let fail=true
  f.runtime.complete_host_api_call_json=(...args)=>{if(fail){fail=false;throw new Error('transport unavailable')}return complete(...args)}
  f.runtime.call('wx.login');await f.services.drain();await turn();await assert.rejects(f.services.drain(),/transport unavailable/)
  await f.services.drain();assert.equal(f.runtime.completions.length,1);assert.equal(f.runtime.completions[0].result.code,'once');await f.services.close()
})

test('application logout requested from an active host handler cannot wait on its own retirement barrier',async()=>{
  const {BrowserHostAccountManager}=await import('./browser-host-account-manager.mjs')
  const manager=new BrowserHostAccountManager(trusted.account),created=[];let receipt
  const controller=manager.attach({application:trusted.application,createOwner:async options=>{
    const f=await fixture({}, {identity:{logout:async()=>{receipt=await options.requestLogout();return receipt}}})
    created.push(f)
    return {revoke(){void f.services.close().catch(()=>{})},detachSurface:async()=>{},close:()=>f.services.close(),start:async()=>{},waitForPresentation:async()=>{},invoke:async()=>{}}
  }})
  await controller.ready
  created[0].runtime.call('weappContainer.identity.logout');await created[0].services.drain();await turn()
  assert.equal(receipt.status,'running');await controller.ready
  assert.equal(manager.query(receipt.operationId).status,'complete');assert.equal(created.length,2)
  assert.equal(created[0].runtime.completions.length,0);assert.equal(controller.state.inputEnabled,true)
  await controller.close()
})

test('OPFS writable abort failure retains its exact handle across close and successful retry',async()=>{
  const {BrowserPrivateFiles}=await import('./browser-host-services.mjs')
  let aborts=0,fail=true
  const stream={async write(){throw new Error('disk write failed')},async close(){throw new Error('unexpected close')},async abort(){aborts++;if(fail)throw new Error('native stream still locked')}}
  const directory={async getDirectoryHandle(){return this},async getFileHandle(){return {createWritable:async()=>stream}}}
  const files=await new BrowserPrivateFiles('account-a',{storage:{getDirectory:async()=>directory}}).initialize()
  await assert.rejects(files.write('wxfile://user/private','bytes'),/write and abort failed/);assert.equal(aborts,1)
  await assert.rejects(files.close(),/retained handles/);assert.equal(aborts,2)
  fail=false;await files.close();assert.equal(aborts,3);await files.close();assert.equal(aborts,3)
})

test('destructively taken new calls survive a preceding completion transport failure',async()=>{
  let nativeCalls=0
  const f=await fixture({}, {identity:{login:()=>({code:'native-'+ ++nativeCalls})}})
  const first=f.runtime.call('wx.login');await f.services.drain();await turn()
  const second=f.runtime.call('wx.login'),complete=f.runtime.complete_host_api_call_json.bind(f.runtime);let failed=false
  f.runtime.complete_host_api_call_json=(callId,value)=>{if(!failed){failed=true;throw new Error('transport unavailable')}return complete(callId,value)}
  await assert.rejects(f.services.drain(),/transport unavailable/)
  await f.flush();assert.equal(nativeCalls,2);assert.deepEqual(f.runtime.completions.map(value=>value.callId),[first,second]);await f.services.close()
})

test('all 256 guest completion callbacks can start their next native call without stale admission charges',async()=>{
  let nativeCalls=0
  const f=await fixture({}, {identity:{login:()=>({code:'native-'+ ++nativeCalls})}}),first=new Set()
  for(let index=0;index<256;index++)first.add(f.runtime.call('wx.login'))
  await f.services.drain();await turn()
  const complete=f.runtime.complete_host_api_call_json.bind(f.runtime)
  f.runtime.complete_host_api_call_json=(callId,value)=>{const result=complete(callId,value);if(first.has(callId))f.runtime.call('wx.login');return result}
  await f.flush();assert.equal(nativeCalls,512);assert.equal(f.runtime.completions.length,512);assert(f.runtime.completions.every(value=>value.result?.code));await f.services.close()
})
