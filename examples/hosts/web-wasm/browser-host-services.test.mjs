import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { BrowserHostServices, BrowserBinaryStore, BrowserPrivateFiles, browserNetworkType } from './browser-host-services.mjs'
import { browserFileDigest } from './browser-file-digest.mjs'

const catalog = JSON.parse(await readFile(new URL('../../../crates/container-runtime/src/host-api-catalog.json', import.meta.url), 'utf8'))
const trusted = { application: { hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64) }, account: { principalId:'alice',epoch:1 } }
class RuntimeTransportHarness {
  requests = []; completions = []; events = []; snapshotUpdates = []; revoked = false
  host_services_protocol_json() { return '{"version":"1.0"}' }
  configure_host_services_json(value) { this.config = JSON.parse(value) }
  update_host_service_snapshots_json(value) { this.snapshotUpdates.push(JSON.parse(value)); return '{"messages":[]}' }
  take_host_requests_json() { return JSON.stringify(this.requests.splice(0)) }
  complete_host_api_call_json(callId, value) { this.completions.push({ callId,...JSON.parse(value) }); return '{"messages":[]}' }
  dispatch_host_api_event_json(value) { this.events.push(JSON.parse(value)); return '{"messages":[]}' }
  revoke_host_services_json() { this.revoked = true; return '[]' }
  call(method, payload, context = {}) {
    const callId = `call-${++this.sequence || (this.sequence=1)}`
    this.requests.push({ kind:'call',callId,method,payload,deadlineNs:null,cancelToken:null,
      context: { ...trusted,sessionId:'session-1',callId,api:method,deadlineNs:null,cancelToken:null,...context } })
    return callId
  }
}
const eventually = async predicate => {
  const until = Date.now()+3000
  while (!predicate()) { assert.ok(Date.now()<until,'asynchronous operation timed out'); await new Promise(resolve=>setTimeout(resolve,5)) }
}
async function fixture({ origin = 'http://localhost', ...options } = {}) {
  const runtime = new RuntimeTransportHarness(), window = new EventTarget()
  const environment = { navigator:{ onLine:true }, window, location:{origin,href:origin+'/'}, fetch,FormData,Blob,File,
    setTimeout,clearTimeout,...options.environment }
  let queued = 0
  const services = new BrowserHostServices({ ...options, runtime,catalog,environment,onQueueReady:()=>queued++ })
  await services.configure(trusted)
  return { runtime,services,environment, get queued(){return queued} }
}

test('real fetch results enter runtime only during owner drain, preserving native trusted context', async t => {
  let headers
  const server = createServer((request,response)=>{ headers=request.headers; response.setHeader('content-type','application/json'); response.end('{"answer":42}') })
  server.listen(0,'127.0.0.1'); await once(server,'listening'); t.after(()=>server.close())
  const origin=`http://127.0.0.1:${server.address().port}`, f=await fixture({origin}); t.after(()=>f.services.close())
  const callId=f.runtime.call('wx.request',{url:origin+'/private',dataType:'json'})
  await f.services.drain(); await eventually(()=>f.queued>0)
  assert.deepEqual(f.runtime.completions,[],'browser completion reentered the guest outside drain')
  await f.services.drain()
  assert.equal(f.runtime.completions[0].callId,callId)
  assert.deepEqual(f.runtime.completions[0].result.data,{answer:42})
  assert.equal(headers.authorization,undefined); assert.equal(headers.cookie,undefined)
  assert.equal(f.runtime.config.apis.includes('wx.login'),false,'production cannot install sandbox account handlers')
  assert.equal(f.runtime.config.apis.includes('wx.requestPayment'),false)
})

test('cross-app and stale epoch calls fail before device or backend side effects',async t=>{
  let invoked=0
  const f=await fixture({identity:{login:()=>{invoked++;return {code:'opaque-one-use'}}}});t.after(()=>f.services.close())
  f.runtime.call('wx.login',{}, {account:{principalId:'alice',epoch:2}})
  f.runtime.call('wx.login',{}, {application:{...trusted.application,appId:'other'}})
  await f.services.drain(); await f.services.drain()
  assert.equal(invoked,0);assert.equal(f.runtime.completions.length,2)
  assert.ok(f.runtime.completions.every(result=>result.error.code==='cancelled'))
})

test('subscriptions coalesce sensor-like values and cancel revokes already queued events',async t=>{
  const f=await fixture();t.after(()=>f.services.close())
  const callId=f.runtime.call('wx.onNetworkStatusChange',{subscriptionId:'network-1',action:'subscribe'})
  await f.services.drain();await new Promise(resolve=>setImmediate(resolve));await f.services.drain()
  f.environment.window.dispatchEvent(new Event('offline'));f.environment.navigator.onLine=false
  f.environment.window.dispatchEvent(new Event('offline'))
  assert.equal(f.runtime.events.length,0)
  await f.services.drain();assert.equal(f.runtime.events.length,1)
  assert.equal(f.runtime.events[0].sequence,2);assert.equal(f.runtime.events[0].value.isConnected,false)
  f.runtime.requests.push({kind:'cancel',callId});await f.services.drain()
  f.environment.window.dispatchEvent(new Event('online'));await f.services.drain();assert.equal(f.runtime.events.length,1)
})

test('network adapter maps browser connection details into wx networkType values', () => {
  assert.equal(browserNetworkType({ onLine: false }), 'none')
  assert.equal(browserNetworkType({ onLine: true, connection: { type: 'wifi' } }), 'wifi')
  assert.equal(browserNetworkType({ onLine: true, connection: { type: 'cellular', effectiveType: 'slow-2g' } }), '2g')
  assert.equal(browserNetworkType({ onLine: true, connection: { type: 'cellular', effectiveType: '3g' } }), '3g')
  assert.equal(browserNetworkType({ onLine: true, connection: { type: 'cellular', effectiveType: '4g' } }), '4g')
  assert.equal(browserNetworkType({ onLine: true, connection: { type: 'ethernet' } }), 'unknown')
  assert.equal(browserNetworkType({ onLine: true }), 'unknown')
})

test('Battery Status API seeds a synchronous snapshot and tracks native changes', async t => {
  const battery = Object.assign(new EventTarget(), { level: 0.42, charging: true })
  const f = await fixture({ environment: { navigator: { onLine: true, getBattery: async () => battery } } })
  t.after(() => f.services.close())
  assert.equal(f.runtime.config.apis.includes('wx.getBatteryInfoSync'), true)
  assert.deepEqual(f.runtime.config.syncValues['wx.getBatteryInfoSync'], { level: 42, isCharging: true, errMsg: 'getBatteryInfoSync:ok' })
  battery.level = 0.73; battery.charging = false
  battery.dispatchEvent(new Event('levelchange')); battery.dispatchEvent(new Event('chargingchange'))
  await f.services.drain(); await f.services.drain()
  assert.deepEqual(f.runtime.snapshotUpdates.at(-1), { 'wx.getBatteryInfoSync': { level: 73, isCharging: false, errMsg: 'getBatteryInfoSync:ok' } })
})

test('getNetworkType and status events expose mapped values through the host queue', async t => {
  const f = await fixture(); t.after(() => f.services.close()); f.environment.navigator.connection = { type: 'wifi' }
  const callId = f.runtime.call('wx.getNetworkType', {})
  await f.services.drain(); await eventually(() => f.queued > 0); await f.services.drain(); await eventually(() => f.runtime.completions.length > 0)
  assert.deepEqual(f.runtime.completions.find(completion => completion.callId === callId)?.result, { errMsg: 'getNetworkType:ok', networkType: 'wifi' })
  const subscriptionId = f.runtime.call('wx.onNetworkStatusChange', { subscriptionId: 'network-wifi', action: 'subscribe' })
  await f.services.drain(); await eventually(() => f.queued > 0); await f.services.drain(); await eventually(() => f.runtime.completions.length > 0)
  f.environment.navigator.onLine = false; f.environment.window.dispatchEvent(new Event('offline')); await f.services.drain(); await f.services.drain()
  assert.equal(f.runtime.events.at(-1)?.value.networkType, 'none')
  f.runtime.requests.push({ kind: 'cancel', callId: subscriptionId }); await f.services.drain()
})

test('vibration handlers surface browser scheduling refusal as unsupported', async t => {
  const scheduled = []
  const f = await fixture({ environment: { navigator: { onLine: true, vibrate: pattern => { scheduled.push(pattern); return false } } } })
  t.after(() => f.services.close())
  assert.equal(f.runtime.config.apis.includes('wx.vibrateShort'), true)
  assert.equal(f.runtime.config.apis.includes('wx.vibrateLong'), true)
  const shortCall = f.runtime.call('wx.vibrateShort', {})
  const longCall = f.runtime.call('wx.vibrateLong', {})
  await f.services.drain(); await f.services.drain()
  assert.deepEqual(scheduled, [15, 400])
  assert.deepEqual(f.runtime.completions.map(completion => [completion.callId, completion.error.code]), [[shortCall, 'unsupported'], [longCall, 'unsupported']])
})

test('missing Screen Wake Lock is registered as an explicit refusal instead of sandbox success', async t => {
  const f = await fixture()
  t.after(() => f.services.close())
  assert.equal(f.environment.navigator.wakeLock, undefined)
  assert.equal(f.runtime.config.apis.includes('wx.setKeepScreenOn'), true)
  const callId = f.runtime.call('wx.setKeepScreenOn', { keepScreenOn: true })
  await f.services.drain(); await f.services.drain()
  const completion = f.runtime.completions.find(value => value.callId === callId)
  assert.equal(completion?.error.code, 'unsupported')
  assert.match(completion?.error.details.errMsg, /Screen Wake Lock API is unavailable/)
})

test('clipboard read returns the browser-owned text through the host queue', async t => {
  const clipboard = { async readText() { return 'clipboard-oracle' }, async writeText() {} }
  const f = await fixture({ environment: { navigator: { onLine: true, clipboard } } })
  t.after(() => f.services.close())
  assert.equal(f.runtime.config.apis.includes('wx.getClipboardData'), true)
  const callId = f.runtime.call('wx.getClipboardData', {})
  await f.services.drain(); await eventually(() => f.queued > 0); await f.services.drain(); await eventually(() => f.runtime.completions.length > 0)
  assert.deepEqual(f.runtime.completions.find(completion => completion.callId === callId)?.result, { data: 'clipboard-oracle', errMsg: 'getClipboardData:ok' })
})

test('factory ownership is guest supplied and async file operations wait in object order',async t=>{
  const f=await fixture();t.after(()=>f.services.close())
  f.runtime.call('wx.getFileSystemManager',{objectId:'files-1'})
  f.runtime.call('object:FileSystemManager.writeFile',{objectId:'files-1',filePath:'wxfile://user/test.txt',data:'hello'})
  await f.services.drain();await eventually(()=>f.queued>=2);await f.services.drain()
  assert.equal(f.runtime.completions[0].result.objectId,'files-1')
  assert.equal(await (await f.services.files.read('wxfile://user/test.txt')).text(),'hello')
  await assert.rejects(()=>f.services.files.read('wxfile://user/../host-token'),/invalid virtual/)
  assert.equal(f.services.capabilities().synchronousPersistentFiles,false)
  assert.equal(f.runtime.config.apis.includes('object:FileSystemManager.writeFileSync'),false)
})

test('abort and owner close suppress a late real HTTP response',async t=>{
  let release
  const gate=new Promise(resolve=>release=resolve)
  const server=createServer(async(request,response)=>{await gate;response.end('late')})
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close())
  const origin=`http://127.0.0.1:${server.address().port}`,f=await fixture({origin})
  f.runtime.call('wx.request',{url:origin+'/slow',dataType:'text'})
  await f.services.drain();await f.services.close();release();await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal(f.runtime.revoked,true);assert.deepEqual(f.runtime.completions,[])
})

test('binary ownership enforces release, expiry, transfer and byte backpressure',()=>{
  const store=new BrowserBinaryStore('scope',{maxBytes:4})
  const value=store.put(new Uint8Array([1,2,3,4]));assert.throws(()=>store.put(new Uint8Array([5])),/backpressure/)
  store.retain(value.handle);assert.equal(store.release(value.handle),true);assert.deepEqual([...store.get(value.handle)],[1,2,3,4])
  assert.deepEqual([...new Uint8Array(store.take(value.handle))],[1,2,3,4]);assert.throws(()=>store.get(value.handle),/expired/)
  const expired=store.put(new Uint8Array([1]),{ttl:0});assert.throws(()=>store.get(expired.handle),/expired/)
  store.close();assert.throws(()=>store.put(new Uint8Array()),/closed/)
})

test('scoped temporary files are never inherited by another browser owner',async()=>{
  const old=await new BrowserPrivateFiles('alice',{}).initialize();await old.write('wxfile://user/private.txt','alice')
  const next=await new BrowserPrivateFiles('bob',{}).initialize();await assert.rejects(()=>next.read('wxfile://user/private.txt'))
  old.close();next.close()
})

test('real HTTP request preserves query, invalid JSON text and binary request/response bytes',async t=>{
  const received=[]
  const server=createServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk)
    received.push({url:request.url,body:Buffer.concat(chunks)})
    if(request.url.startsWith('/binary'))response.end(Buffer.from([0,255,1,2]));else response.end('plain text is not JSON')
  })
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close())
  const origin=`http://127.0.0.1:${server.address().port}`,f=await fixture({origin});t.after(()=>f.services.close())
  f.runtime.call('wx.request',{url:origin+'/query?existing=1',data:{space:'a b',zero:0},dataType:'json'})
  f.runtime.call('wx.request',{url:origin+'/binary',method:'POST',data:{__weappBinary:{bytes:[9,0,255],type:'ArrayBuffer'}},responseType:'arraybuffer'})
  await f.services.drain();await eventually(()=>f.queued>=2);await f.services.drain()
  assert.equal(new URL(received[0].url,origin).searchParams.get('space'),'a b')
  assert.equal(new URL(received[0].url,origin).searchParams.get('zero'),'0')
  assert.deepEqual([...received.find(request=>request.url==='/binary').body],[9,0,255])
  assert.equal(f.runtime.completions.find(result=>typeof result.result.data==='string').result.data,'plain text is not JSON')
  assert.deepEqual(f.runtime.completions.find(result=>result.result.data?.__weappBinary).result.data.__weappBinary.bytes,[0,255,1,2])
})

test('baseline MD5 and SHA1 file digests match independent Node crypto across padding boundaries',async()=>{
  for(const length of [0,3,55,56,63,64,65,1000]) {
    const bytes=Uint8Array.from({length},(_,index)=>(index*37)&255)
    for(const algorithm of ['md5','sha1'])assert.equal(await browserFileDigest(bytes.buffer,algorithm),createHash(algorithm).update(bytes).digest('hex'))
  }
  await assert.rejects(()=>browserFileDigest(new ArrayBuffer(0),'sha256'),/md5 or sha1/)
})

test('binary completion aliases release once and invalid chunks settle as an error',async t=>{
  let services,oversized=false
  const f=await fixture({identity:{login:()=>{
    if(oversized)return {data:new ArrayBuffer(1024*1024+1)}
    const value=services.binary.put(new Uint8Array([1,2,3]));return {first:value,second:value}
  }}});services=f.services;t.after(()=>services.close())
  f.runtime.call('wx.login',{});await services.drain();await eventually(()=>f.queued>=1);await services.drain()
  assert.deepEqual(f.runtime.completions[0].result.first,f.runtime.completions[0].result.second);assert.equal(services.binary.size,0)
  oversized=true;f.runtime.call('wx.login',{});await services.drain();await eventually(()=>f.queued>=2);await services.drain()
  assert.match(f.runtime.completions[1].error.message,/materialization limit/)
})

// These finite media objects prove owner/permission race behavior, not camera
// acquisition or browser compositor acceptance. Those require a real browser.
const mediaFixture=async()=>{
  let resolve,stops=0
  const pending=new Promise(yes=>resolve=yes),mount=()=>({append(element){element.parentNode=this;element.isConnected=true}})
  const document=Object.assign(new EventTarget(),{createElement(){return Object.assign(new EventTarget(),{style:{},dataset:{},isConnected:true,pause(){},async play(){},remove(){this.parentNode=null;this.isConnected=false}})}})
  const f=await fixture({componentRoot:mount(),environment:{document,navigator:{mediaDevices:{getUserMedia:()=>pending}}}})
  const stream={getTracks:()=>[{stop(){stops++}}],getVideoTracks:()=>[{getCapabilities:()=>({})}]}
  const binding={type:'camera',id:'camera-1',sessionId:'session-1',accountEpoch:'1',rect:{x:0,y:0,width:100,height:100},mount:mount(),isCurrent:()=>true,isAlive:()=>true}
  return {f,binding,mount,resolve:()=>resolve(stream),get stops(){return stops}}
}
test('late camera permission after owner close releases the actual newly returned stream',async()=>{
  const m=await mediaFixture(),operation=m.f.services.bindComponent(m.binding)
  const retired=assert.rejects(operation,/retired/);let closed=false
  const closing=m.f.services.close().then(()=>closed=true)
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false,'account retirement waits actual acquisition')
  m.resolve();await retired;await closing;assert.equal(m.stops,1)
})
test('pending camera follows the current accepted node without returning to its retired mount',async()=>{
  const m=await mediaFixture(),old=m.binding.mount,next=m.mount()
  const operation=m.f.services.bindComponent(m.binding)
  await m.f.services.bindComponent({...m.binding,mount:next});m.binding.isAlive=()=>false
  m.resolve();const element=await operation
  assert.equal(element.parentNode,next);assert.notEqual(element.parentNode,old);assert.equal(m.stops,0)
  await m.f.services.close();assert.equal(m.stops,1)
})

test('identity snapshots and onChange use the complete account schema and await host preparation before app init',async t=>{
  const native=new RuntimeTransportHarness(),env={navigator:{},location:{origin:'https://host.test',href:'https://host.test/'},setTimeout,clearTimeout}
  let resolveState,queried=false
  const initial=new Promise(resolve=>resolveState=resolve)
  const services=new BrowserHostServices({runtime:native,catalog,environment:env,identity:{getState:async()=>{queried=true;return initial}}})
  t.after(()=>services.close())
  const configuring=services.configure(trusted);await new Promise(resolve=>setImmediate(resolve));assert.equal(queried,true);assert.equal(native.config,undefined)
  const state={hostLoggedIn:true,appLoggedIn:false,profileAuthorized:true,phoneAuthorized:true,
    authorizationVersion:'consent-before-login',userInfo:{nickName:'Alice',avatarUrl:'https://host.test/avatar'}}
  resolveState(state);await configuring;assert.deepEqual(native.config.syncValues['weappContainer.identity.getState'],state)
  assert.equal('loggedIn' in native.config.syncValues['weappContainer.identity.getState'],false)
  native.call('weappContainer.identity.onChange',{subscriptionId:'identity',action:'subscribe'});await services.drain();await new Promise(resolve=>setImmediate(resolve));await services.drain()
  const revoked={hostLoggedIn:true,appLoggedIn:false,profileAuthorized:false,phoneAuthorized:false}
  native.update_host_service_snapshots_json=value=>{native.snapshots=JSON.parse(value)}
  services.setApplicationIdentityState(revoked);await services.drain()
  assert.deepEqual(native.snapshots['weappContainer.identity.getState'],revoked);assert.deepEqual(native.events.at(-1).value,revoked)
  assert.throws(()=>services.setApplicationIdentityState({loggedIn:true}),/four explicit/)
  const consentRetained={...state,appLoggedIn:false,authorizationVersion:'consent-after-logout'}
  services.setApplicationIdentityState(consentRetained);await services.drain()
  assert.deepEqual(native.snapshots['weappContainer.identity.getState'],consentRetained)
  assert.throws(()=>services.setApplicationIdentityState({...revoked,userInfo:{nickName:'revoked'}}),/profile authorization/)
  assert.throws(()=>services.setApplicationIdentityState({...revoked,authorizationVersion:0}),/opaque nonempty string/)
  // Snapshot values are copied at the host boundary; caller mutations cannot
  // change a queued event or introduce unrelated host credential fields.
  const supplied={...state,userInfo:{nickName:'Before'},hostAccessToken:'host-only'}
  services.setApplicationIdentityState(supplied);supplied.userInfo.nickName='After';await services.drain()
  assert.equal(native.snapshots['weappContainer.identity.getState'].userInfo.nickName,'Before')
  assert.equal('hostAccessToken' in native.snapshots['weappContainer.identity.getState'],false)
})

test('signed-out identity cannot retain application or disclosure grants',async()=>{
  const native=new RuntimeTransportHarness()
  const services=new BrowserHostServices({runtime:native,catalog,environment:{navigator:{}},identity:{getState:()=>({hostLoggedIn:false,appLoggedIn:false,profileAuthorized:true,phoneAuthorized:false})}})
  try { await assert.rejects(services.configure({...trusted,account:{principalId:null,epoch:2}}),/grants require a host account/) }
  finally { await services.close() }
})

test('checkSession projects real redemption before its completion and preserves consent on app logout',async t=>{
  let state={hostLoggedIn:true,appLoggedIn:false,profileAuthorized:true,phoneAuthorized:true,authorizationVersion:'v1',userInfo:{nickName:'Alice'}}
  const f=await fixture({identity:{getState:()=>state,checkSession:()=>({valid:true}),logout:()=>{state={...state,appLoggedIn:false};return {loggedOut:true,consentsRetained:true}}}})
  t.after(()=>f.services.close())
  state={...state,appLoggedIn:true}
  const check=f.runtime.call('wx.checkSession',{})
  await f.services.drain();await new Promise(resolve=>setImmediate(resolve));await f.services.drain()
  assert.equal(f.runtime.snapshotUpdates.at(-1)['weappContainer.identity.getState'].appLoggedIn,true)
  assert.equal(f.runtime.completions.find(value=>value.callId===check)?.result.valid,true)
  const logout=f.runtime.call('weappContainer.identity.logout',{})
  await f.services.drain();await new Promise(resolve=>setImmediate(resolve));await f.services.drain()
  assert.deepEqual(f.runtime.snapshotUpdates.at(-1)['weappContainer.identity.getState'],state)
  assert.equal(state.profileAuthorized,true);assert.equal(state.phoneAuthorized,true)
  assert.equal(f.runtime.completions.find(value=>value.callId===logout)?.result.consentsRetained,true)
})

test('custom app logout without a state provider retains the installed disclosure consent',async t=>{
  const f=await fixture({identity:{logout:()=>({loggedOut:true})}});t.after(()=>f.services.close())
  const initial={hostLoggedIn:true,appLoggedIn:true,profileAuthorized:true,phoneAuthorized:true,authorizationVersion:'retained',userInfo:{nickName:'Alice'}}
  f.services.setApplicationIdentityState(initial)
  const callId=f.runtime.call('weappContainer.identity.logout',{})
  await f.services.drain();await new Promise(resolve=>setImmediate(resolve));await f.services.drain()
  assert.deepEqual(f.runtime.snapshotUpdates.at(-1)['weappContainer.identity.getState'],{...initial,appLoggedIn:false})
  assert.equal(f.runtime.completions.find(value=>value.callId===callId)?.result.loggedOut,true)
})

test('invalid checkSession refresh is best effort and never overwrites the original API failure',async t=>{
  const initial={hostLoggedIn:true,appLoggedIn:true,profileAuthorized:true,phoneAuthorized:false}
  let refreshFails=false,prepared=false,queries=0
  const original=Object.assign(new Error('original session error'),{code:'invalid_request',details:{backendCode:'ERR_INVALID_APP_SESSION',errCode:4017,errMsg:'checkSession:fail original',reason:{revoked:true}}})
  const f=await fixture({identity:{getState:()=>{queries++;if(prepared&&refreshFails)throw new Error('secondary refresh failure');return prepared?{...initial,appLoggedIn:false}:initial},checkSession:()=>{throw original}}})
  t.after(()=>f.services.close());prepared=true
  for(const fails of [false,true]) {
    refreshFails=fails
    const callId=f.runtime.call('wx.checkSession',{})
    await f.services.drain();await new Promise(resolve=>setImmediate(resolve));await f.services.drain()
    const error=f.runtime.completions.find(value=>value.callId===callId)?.error
    assert.equal(error.message,'original session error');assert.equal(error.details.errCode,4017)
    assert.equal(error.details.errMsg,'checkSession:fail original');assert.deepEqual(error.details.reason,{revoked:true})
  }
  assert.equal(queries,3)
  assert.equal(f.runtime.snapshotUpdates.at(-1)['weappContainer.identity.getState'].appLoggedIn,false)
})

test('retired identity ignores delayed refresh and logout never refreshes the retiring handler',async()=>{
  const state={hostLoggedIn:true,appLoggedIn:true,profileAuthorized:true,phoneAuthorized:false}
  let refreshStarted,releaseRefresh,queries=0
  const started=new Promise(resolve=>refreshStarted=resolve),delayed=new Promise(resolve=>releaseRefresh=resolve)
  const f=await fixture({identity:{getState:()=>{if(++queries===1)return state;refreshStarted();return delayed},checkSession:()=>({valid:true})}})
  f.runtime.call('wx.checkSession',{});await f.services.drain();await started
  const closing=f.services.close();releaseRefresh(state);await closing
  assert.deepEqual(f.runtime.snapshotUpdates,[]);assert.deepEqual(f.runtime.completions,[])
  let ownerClosing,logoutQueries=0
  const g=await fixture({identity:{getState:()=>{logoutQueries++;return state},logout:(_payload,call)=>{ownerClosing=call.services.close();return {operationId:'logout-1',status:'running'}}}})
  g.runtime.call('weappContainer.identity.logout',{});await g.services.drain()
  await new Promise(resolve=>setImmediate(resolve));await ownerClosing
  assert.equal(logoutQueries,1);assert.deepEqual(g.runtime.completions,[])
})

test('a delayed refresh cannot restore consent after a host revocation on the same owner',async t=>{
  const authorized={hostLoggedIn:true,appLoggedIn:true,profileAuthorized:true,phoneAuthorized:true,authorizationVersion:'before',userInfo:{nickName:'Alice'}}
  const revoked={hostLoggedIn:true,appLoggedIn:true,profileAuthorized:false,phoneAuthorized:false,authorizationVersion:'after'}
  let queries=0,startRefresh,releaseRefresh
  const started=new Promise(resolve=>startRefresh=resolve),delayed=new Promise(resolve=>releaseRefresh=resolve)
  const f=await fixture({identity:{getState:()=>{if(++queries===1)return authorized;startRefresh();return delayed},checkSession:()=>({valid:true})}})
  t.after(()=>f.services.close())
  const callId=f.runtime.call('wx.checkSession',{});await f.services.drain();await started
  f.services.setApplicationIdentityState(revoked);releaseRefresh(authorized)
  await new Promise(resolve=>setImmediate(resolve));await f.services.drain()
  assert.deepEqual(f.runtime.snapshotUpdates.map(update=>update['weappContainer.identity.getState']),[revoked])
  assert.equal(f.runtime.completions.find(value=>value.callId===callId)?.error.code,'cancelled')
})

test('authorization denial refreshes a revoked prior consent before returning the original refusal',async t=>{
  let state={hostLoggedIn:true,appLoggedIn:false,profileAuthorized:true,phoneAuthorized:true,authorizationVersion:'granted',userInfo:{nickName:'Alice'}}
  const deny=()=>{state={...state,profileAuthorized:false,phoneAuthorized:false,authorizationVersion:'denied'};delete state.userInfo;throw Object.assign(new Error('User denied consent'),{code:'permission_denied',errCode:2001,errMsg:'getUserProfile:fail auth deny'})}
  const f=await fixture({identity:{getState:()=>state,getUserProfile:deny}});t.after(()=>f.services.close())
  const callId=f.runtime.call('wx.getUserProfile',{})
  await f.services.drain();await new Promise(resolve=>setImmediate(resolve));await f.services.drain()
  assert.deepEqual(f.runtime.snapshotUpdates.at(-1)['weappContainer.identity.getState'],state)
  const error=f.runtime.completions.find(value=>value.callId===callId)?.error
  assert.equal(error.code,'permission_denied');assert.equal(error.details.errCode,2001)
  assert.equal(error.details.errMsg,'getUserProfile:fail auth deny')
})

test('concurrent backend refreshes reread opaque conflicting versions and converge on the backend',async t=>{
  const initial={hostLoggedIn:true,appLoggedIn:false,profileAuthorized:false,phoneAuthorized:false,authorizationVersion:'initial'}
  const first={...initial,appLoggedIn:true,authorizationVersion:'opaque-z'}
  const latest={...first,profileAuthorized:true,authorizationVersion:'opaque-a',userInfo:{nickName:'Alice'}}
  let queries=0,releaseFirst,releaseSecond
  const one=new Promise(resolve=>releaseFirst=resolve),two=new Promise(resolve=>releaseSecond=resolve)
  const f=await fixture({identity:{getState:()=>{queries++;return queries===1?initial:queries===2?one:queries===3?two:latest},checkSession:()=>({valid:true})}})
  t.after(()=>f.services.close())
  const a=f.runtime.call('wx.checkSession',{}),b=f.runtime.call('wx.checkSession',{})
  await f.services.drain();await eventually(()=>queries===3)
  releaseFirst(first);await new Promise(resolve=>setImmediate(resolve))
  releaseSecond(latest);await new Promise(resolve=>setImmediate(resolve));await f.services.drain()
  assert.equal(queries,4,'conflicting sibling snapshots require one new backend read')
  assert.deepEqual(f.runtime.snapshotUpdates.at(-1)['weappContainer.identity.getState'],latest)
  assert.ok([a,b].every(callId=>f.runtime.completions.find(value=>value.callId===callId)?.result.valid===true))
})

test('host revocation during the disclosure callback blocks its payload and any subsequent stale refresh',async t=>{
  const authorized={hostLoggedIn:true,appLoggedIn:true,profileAuthorized:true,phoneAuthorized:false,authorizationVersion:'granted',userInfo:{nickName:'Alice'}}
  const revoked={hostLoggedIn:true,appLoggedIn:true,profileAuthorized:false,phoneAuthorized:false,authorizationVersion:'revoked'}
  let enteredCallback,releaseCallback,queries=0
  const entered=new Promise(resolve=>enteredCallback=resolve),pending=new Promise(resolve=>releaseCallback=resolve)
  const f=await fixture({identity:{getState:()=>{queries++;return authorized},getUserInfo:async()=>{enteredCallback();await pending;return {userInfo:authorized.userInfo}}}})
  t.after(()=>f.services.close())
  const callId=f.runtime.call('wx.getUserInfo',{});await f.services.drain();await entered
  f.services.setApplicationIdentityState(revoked);releaseCallback()
  await new Promise(resolve=>setImmediate(resolve));await f.services.drain()
  assert.equal(queries,1,'an already revoked call must not start a new backend snapshot read')
  assert.deepEqual(f.runtime.snapshotUpdates.map(update=>update['weappContainer.identity.getState']),[revoked])
  const completion=f.runtime.completions.find(value=>value.callId===callId)
  assert.equal(completion.error.code,'cancelled');assert.equal(completion.result,undefined)
})

test('custom identity handlers without getState also lose disclosure rights on host revocation',async t=>{
  let enteredCallback,releaseCallback
  const entered=new Promise(resolve=>enteredCallback=resolve),pending=new Promise(resolve=>releaseCallback=resolve)
  const f=await fixture({identity:{getUserInfo:async()=>{enteredCallback();await pending;return {userInfo:{nickName:'Old grant'}}}}})
  t.after(()=>f.services.close())
  const state={hostLoggedIn:true,appLoggedIn:false,profileAuthorized:true,phoneAuthorized:false}
  f.services.setApplicationIdentityState(state)
  const callId=f.runtime.call('wx.getUserInfo',{});await f.services.drain();await entered
  f.services.setApplicationIdentityState({...state,profileAuthorized:false});releaseCallback()
  await new Promise(resolve=>setImmediate(resolve));await f.services.drain()
  const completion=f.runtime.completions.find(value=>value.callId===callId)
  assert.equal(completion.error.code,'cancelled');assert.equal(completion.result,undefined)
})

test('a refreshed backend refusal suppresses an already captured profile or phone code',async t=>{
  let revoked=false
  const state={hostLoggedIn:true,appLoggedIn:true,profileAuthorized:true,phoneAuthorized:true}
  const f=await fixture({identity:{getState:()=>({...state,profileAuthorized:!revoked,phoneAuthorized:!revoked}),getUserInfo:()=>{revoked=true;return {userInfo:{nickName:'Captured before revoke'}}},authorizePhone:()=>({code:'captured-before-revoke'})}})
  t.after(()=>f.services.close())
  for(const api of ['wx.getUserInfo','weappContainer.identity.authorizePhone']) {
    const callId=f.runtime.call(api,{})
    await f.services.drain();await new Promise(resolve=>setImmediate(resolve));await f.services.drain()
    const completion=f.runtime.completions.find(value=>value.callId===callId)
    assert.equal(completion.error.code,'permission_denied');assert.equal(completion.result,undefined)
  }
  assert.equal(f.runtime.snapshotUpdates.at(-1)['weappContainer.identity.getState'].profileAuthorized,false)
})

// Finite frame extraction proves ownership/backpressure only; root's browser
// probe separately exercises real media decoding, QuickJS/WASM and CanvasKit.
test('accepted media slots use detached decoders, bounded byte frames and trusted context targets',async t=>{
  const runtime=new RuntimeTransportHarness(), callbacks=new Map(), frames=[], errors=[]
  let appends=0,stops=0,callbackId=0
  const stream={getTracks:()=>[{stop(){stops++}}],getVideoTracks:()=>[{getCapabilities:()=>({})}]}
  const elements=[],document=Object.assign(new EventTarget(),{createElement(){const element=Object.assign(new EventTarget(),{
    style:{},dataset:{},videoWidth:1920,videoHeight:1080,readyState:2,pause(){},async play(){},remove(){},
    requestVideoFrameCallback(callback){callbacks.set(++callbackId,callback);return callbackId},cancelVideoFrameCallback(id){callbacks.delete(id)}
  });elements.push(element);return element}})
  class OffscreenCanvas {constructor(width,height){this.width=width;this.height=height}getContext(){return {drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(this.width*this.height*4).fill(71)})}}}
  let snapshots=[{sessionId:'session-1',accountEpoch:'1',pageId:'1',revision:'1',nodeId:'node-camera',tag:'camera',attributes:{id:'public-camera'},ownerScopeId:'owner-1',localBounds:{x:2,y:3,width:200,height:100},visible:true}]
  runtime.host_services_protocol_json=()=>JSON.stringify({version:'1.0',componentFrames:'1.0'})
  runtime.host_component_snapshots_json=()=>JSON.stringify(snapshots)
  runtime.submit_host_component_frame=(metadata,pixels)=>{frames.push({metadata:JSON.parse(metadata),pixels});return true}
  runtime.dispatch_host_component_event_json=()=>'{"messages":[]}'
  const environment={document,OffscreenCanvas,navigator:{mediaDevices:{getUserMedia:async()=>stream}},setTimeout,clearTimeout}
  const services=new BrowserHostServices({runtime,catalog,environment,componentRoot:{append(){appends++}},onDiagnostic:error=>errors.push(error)})
  await services.configure(trusted);t.after(()=>services.close())
  await services.drain();await new Promise(resolve=>setImmediate(resolve));assert.equal(appends,0)
  assert.equal(elements.length,1);assert.equal(callbacks.size,1)
  const capture=()=>{const [key,callback]=callbacks.entries().next().value;callbacks.delete(key);callback()}
  capture();capture();assert.equal(frames.length,0,'media callback must not enter WASM')
  await services.drain();assert.equal(frames.length,1);assert.equal(frames[0].metadata.width,512);assert.equal(frames[0].metadata.height,288)
  assert.ok(frames[0].pixels instanceof Uint8Array);assert.equal(frames[0].pixels.byteLength,512*288*4)
  assert.equal('pixels' in frames[0].metadata,false)
  runtime.call('wx.createCameraContext',{cameraId:'public-camera',objectId:'camera-context'},{componentTarget:{pageId:'1',nodeId:'node-camera',ownerScopeId:'wrong-owner'}})
  await services.drain();await new Promise(resolve=>setImmediate(resolve));await services.drain()
  assert.equal(runtime.completions.at(-1).error.code,'cancelled')
  snapshots=[];await services.drain();assert.equal(stops,1);assert.equal(callbacks.size,0)
  assert.equal(errors.length,0)
})

test('a denied camera slot never reprompts on every owner tick',async t=>{
  const runtime=new RuntimeTransportHarness();let prompts=0
  runtime.host_services_protocol_json=()=>JSON.stringify({version:'1.0',componentFrames:'1.0'})
  runtime.host_component_snapshots_json=()=>JSON.stringify([{sessionId:'session-1',accountEpoch:'1',pageId:'1',nodeId:'camera',tag:'camera',attributes:{},localBounds:{x:0,y:0,width:20,height:20},visible:true}])
  runtime.submit_host_component_frame=()=>true;runtime.dispatch_host_component_event_json=()=>'{"messages":[]}'
  const document=Object.assign(new EventTarget(),{createElement:()=>Object.assign(new EventTarget(),{style:{},dataset:{},pause(){},remove(){}})})
  const services=new BrowserHostServices({runtime,catalog,componentRoot:{},environment:{document,navigator:{mediaDevices:{getUserMedia:async()=>{prompts++;throw new Error('permission denied')}}}}})
  await services.configure(trusted);t.after(()=>services.close())
  await services.drain();await new Promise(resolve=>setImmediate(resolve));await services.drain();await services.drain()
  assert.equal(prompts,1)
})

test('packaged video waits for accepted geometry and retries without using the host page URL',async t=>{
  const runtime=new RuntimeTransportHarness(),targets=[];let reads=0
  runtime.host_services_protocol_json=()=>JSON.stringify({version:'1.0',componentFrames:'1.0'})
  runtime.host_component_snapshots_json=()=>JSON.stringify([{sessionId:'session-1',accountEpoch:'1',pageId:'1',nodeId:'video',tag:'video',attributes:{src:'../assets/movie.webm'},localBounds:{x:0,y:0,width:20,height:20},visible:true}])
  runtime.submit_host_component_frame=()=>true;runtime.dispatch_host_component_event_json=()=>'{"messages":[]}'
  runtime.host_component_resource=target=>{targets.push(JSON.parse(target));return ++reads===1 ? null : new Uint8Array([1,2,3])}
  const videos=[],document=Object.assign(new EventTarget(),{createElement:()=>{const value=Object.assign(new EventTarget(),{style:{},dataset:{},pause(){},remove(){},requestVideoFrameCallback(){return 1},cancelVideoFrameCallback(){}});videos.push(value);return value}})
  const services=new BrowserHostServices({runtime,catalog,componentRoot:{},environment:{document,navigator:{},fetch:()=>{throw new Error('host-page URL fallback forbidden')}}})
  await services.configure(trusted);t.after(()=>services.close())
  await services.drain();await new Promise(resolve=>setImmediate(resolve));assert.equal(videos[0].src,undefined)
  await services.drain();await new Promise(resolve=>setImmediate(resolve));assert.ok(videos[0].src.startsWith('blob:'));assert.equal(reads,2)
  assert.deepEqual(targets[1],{sessionId:'session-1',accountEpoch:'1',pageId:'1',nodeId:'video'})
  const ownedUrl=videos[0].src;await services.close();await assert.rejects(fetch(ownedUrl))
})

test('same-node video source replacement drops old pixels and invalidates old contexts',async t=>{
  const runtime=new RuntimeTransportHarness(),callbacks=new Map(),videos=[],frames=[];let serial=0,source='one.webm'
  runtime.host_services_protocol_json=()=>JSON.stringify({version:'1.0',componentFrames:'1.0'})
  runtime.host_component_snapshots_json=()=>JSON.stringify([{sessionId:'session-1',accountEpoch:'1',pageId:'1',nodeId:'video',tag:'video',attributes:{id:'player',src:source},localBounds:{x:0,y:0,width:20,height:20},visible:true}])
  runtime.host_component_resource=()=>new Uint8Array([1,2,3]);runtime.submit_host_component_frame=(metadata,pixels)=>{frames.push({metadata,pixels});return true};runtime.dispatch_host_component_event_json=()=>'{"messages":[]}'
  const document=Object.assign(new EventTarget(),{createElement:()=>{const video=Object.assign(new EventTarget(),{style:{},dataset:{},readyState:2,videoWidth:1,videoHeight:1,pause(){this.paused=true},async play(){},remove(){this.removed=true},requestVideoFrameCallback(callback){callbacks.set(++serial,callback);return serial},cancelVideoFrameCallback(id){callbacks.delete(id)}});videos.push(video);return video}})
  class OffscreenCanvas{getContext(){return {drawImage(){},getImageData:()=>({data:new Uint8ClampedArray([1,2,3,255])})}}}
  const services=new BrowserHostServices({runtime,catalog,componentRoot:{},environment:{document,OffscreenCanvas,navigator:{}}});await services.configure(trusted);t.after(()=>services.close())
  await services.drain();await new Promise(resolve=>setImmediate(resolve))
  runtime.call('wx.createVideoContext',{id:'player',objectId:'old-video'},{componentTarget:{pageId:'1',nodeId:'video',ownerScopeId:null}})
  await services.drain();await new Promise(resolve=>setImmediate(resolve));await services.drain();assert.equal(runtime.completions.at(-1).result.objectId,'old-video')
  const [key,capture]=callbacks.entries().next().value;callbacks.delete(key);capture();assert.equal(frames.length,0)
  source='two.webm';await services.drain();await new Promise(resolve=>setImmediate(resolve))
  assert.equal(frames.length,0,'old-source queued pixels survived replacement');assert.equal(videos.length,2);assert.equal(videos[0].removed,true);assert.equal(videos[0].paused,true)
  runtime.call('object:VideoContext.play',{objectId:'old-video'},{componentTarget:{pageId:'1',nodeId:'video',ownerScopeId:null}})
  await services.drain();await new Promise(resolve=>setImmediate(resolve));await services.drain();assert.equal(runtime.completions.at(-1).error.code,'cancelled')
})

test('media events precede byte repaints and pending-layout events retain their exact decoder lifetime',async t=>{
  const runtime=new RuntimeTransportHarness(),videos=[],callbacks=new Map(),order=[];let serial=0,presented=true,source='one.webm'
  runtime.host_services_protocol_json=()=>JSON.stringify({version:'1.0',componentFrames:'1.0'})
  runtime.host_component_snapshots_json=()=>JSON.stringify([{sessionId:'session-1',accountEpoch:'1',pageId:'1',nodeId:'video',tag:'video',attributes:{src:source},localBounds:{x:0,y:0,width:20,height:20},visible:true}])
  runtime.host_component_resource=()=>new Uint8Array([1,2,3])
  runtime.submit_host_component_frame=()=>{order.push('frame');presented=false;return true}
  runtime.dispatch_host_component_event_json=value=>{
    if(!presented)throw new Error('ERR_CANCELLED: native component has no current presentation')
    const event=JSON.parse(value);order.push(event.event)
    if(event.event==='play')presented=false // The guest's callback produced a layout that needs a real ACK.
    return '{"messages":[]}'
  }
  const document=Object.assign(new EventTarget(),{createElement:()=>{const video=Object.assign(new EventTarget(),{style:{},dataset:{},readyState:2,videoWidth:1,videoHeight:1,duration:4,currentTime:1,pause(){},remove(){},requestVideoFrameCallback(callback){callbacks.set(++serial,callback);return serial},cancelVideoFrameCallback(id){callbacks.delete(id)}});videos.push(video);return video}})
  class OffscreenCanvas{getContext(){return {drawImage(){},getImageData:()=>({data:new Uint8ClampedArray([1,2,3,255])})}}}
  const services=new BrowserHostServices({runtime,catalog,componentRoot:{},environment:{document,OffscreenCanvas,navigator:{}}});await services.configure(trusted);t.after(()=>services.close())
  await services.drain();await new Promise(resolve=>setImmediate(resolve))
  videos[0].dispatchEvent(new Event('play'));videos[0].dispatchEvent(new Event('timeupdate'))
  const [key,capture]=callbacks.entries().next().value;callbacks.delete(key);capture()
  await services.drain();assert.deepEqual(order,['play','frame'],'a byte repaint invalidated a pending component callback')
  await services.drain();assert.deepEqual(order,['play','frame'],'unpresented callbacks must wait without failing the owner')
  presented=true;await services.drain();assert.deepEqual(order,['play','frame','timeupdate'])

  // A deferred event cannot later target a replacement with the same node ID.
  presented=false;videos[0].dispatchEvent(new Event('ended'));await services.drain()
  source='two.webm';await services.drain();await new Promise(resolve=>setImmediate(resolve))
  presented=true;await services.drain();assert.deepEqual(order,['play','frame','timeupdate'])
  videos[1].dispatchEvent(new Event('ended'));await services.drain();assert.equal(order.at(-1),'ended')
})
