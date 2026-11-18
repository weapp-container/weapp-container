import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { BrowserHostServices } from './browser-host-services.mjs'
import { bluetoothUuid } from './browser-bluetooth-owner.mjs'
const catalog = JSON.parse(await readFile(new URL('../../../crates/container-runtime/src/host-api-catalog.json', import.meta.url)))
const trusted = { application: { hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64) }, account: { principalId:'alice',epoch:1 } }
const serviceId = bluetoothUuid('180d'), characteristicId = bluetoothUuid('2a37')
const turn = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes;reject=no }); return { promise,resolve,reject } }
class Transport {
  requests=[];completions=[];events=[];sequence=0
  host_services_protocol_json(){return '{"version":"1.0"}'}
  configure_host_services_json(value){this.config=JSON.parse(value)}
  take_host_requests_json(){return JSON.stringify(this.requests.splice(0))}
  complete_host_api_call_json(callId,value){this.completions.push({callId,...JSON.parse(value)});return '{}'}
  dispatch_host_api_event_json(value){this.events.push(JSON.parse(value));return '{}'}
  revoke_host_services_json(){return '[]'}
  call(method,payload={}) { const callId='call-'+ ++this.sequence;this.requests.push({kind:'call',method,payload,callId,context:{...trusted,sessionId:'owner',callId,api:method}});return callId }
  cancel(callId){this.requests.push({kind:'cancel',callId})}
}
class TrackedTarget extends EventTarget {
  listeners=new Map();failRemove=false
  addEventListener(name,listener,options){super.addEventListener(name,listener,options);let set=this.listeners.get(name);if(!set)this.listeners.set(name,set=new Set());set.add(listener)}
  removeEventListener(name,listener,options){if(this.failRemove)throw new Error('exact listener remove failed');super.removeEventListener(name,listener,options);this.listeners.get(name)?.delete(listener)}
  count(){return [...this.listeners.values()].reduce((n,set)=>n+set.size,0)}
}
class Characteristic extends TrackedTarget {
  uuid=characteristicId;properties={read:true,write:true,writeWithoutResponse:true,notify:true,indicate:false};valid=true;started=false;starts=0;stops=0;writes=[];startGate=null;stopGate=null;readGate=null;failStop=false
  value=new DataView(new Uint8Array([7]).buffer)
  constructor(gatt){super();this.gatt=gatt}
  operation(work){if(!this.valid)return Promise.reject(new DOMException('stale characteristic','InvalidStateError'));return this.gatt.algorithm(work)}
  readValue(){return this.operation(async()=>{if(this.readGate)await this.readGate.promise;return this.value})}
  writeValueWithResponse(value){return this.operation(()=>{this.writes.push({response:true,value:[...new Uint8Array(value)]})})}
  writeValueWithoutResponse(value){return this.operation(()=>{this.writes.push({response:false,value:[...new Uint8Array(value)]})})}
  startNotifications(){this.starts++;return this.operation(async()=>{if(this.startGate)await this.startGate.promise;return this}).then(target=>{this.started=true;return target})}
  stopNotifications(){this.stops++;return this.operation(async()=>{if(this.stopGate)await this.stopGate.promise;if(this.failStop)throw new DOMException('stop failed','NetworkError');this.started=false;return this})}
  sample(bytes=[7]){this.value=new DataView(new Uint8Array(bytes).buffer);if(this.started&&this.valid)this.dispatchEvent(new Event('characteristicvaluechanged'))}
}
class Device extends TrackedTarget {
  id='device';connects=0;disconnects=0;connectGate=null;abortGate=null;serviceGate=null;failDisconnect=false;algorithms=new Set();characteristics=[];serviceCalls=0;duplicateServices=false;duplicateCharacteristics=false
  constructor(){
    super()
    this.gatt={connected:false,connect:()=>this.connect(),disconnect:()=>this.disconnect(),getPrimaryServices:uuid=>this.getServices(uuid),algorithm:work=>this.algorithm(work)}
  }
  algorithm(work,kind='gatt') {
    const token={active:true,abort:deferred()};this.algorithms.add(token)
    const workPromise=Promise.resolve().then(work)
    const checked=workPromise.then(value=>{if(!token.active)throw new DOMException('native algorithm disconnected',kind==='connect'?'AbortError':'NetworkError');return value})
    return Promise.race([checked,token.abort.promise]).finally(()=>this.algorithms.delete(token))
  }
  connect(){
    this.connects++
    return this.algorithm(async()=>{if(this.connectGate)await this.connectGate.promise;return this.gatt},'connect').then(gatt=>{this.gatt.connected=true;this.characteristic=new Characteristic(this.gatt);this.characteristics.push(this.characteristic);return gatt})
  }
  disconnect(){
    this.disconnects++;if(this.failDisconnect)throw new Error('disconnect failed')
    // The native simulator clears active algorithms exactly as §6.2 requires.
    // abortGate delays the actual platform terminal; it never resolves a
    // connection successfully after disconnect invalidates its algorithm.
    for(const token of this.algorithms){token.active=false;const finish=()=>token.abort.reject(new DOMException('native algorithm disconnected','AbortError'));if(this.abortGate)void this.abortGate.promise.then(finish);else queueMicrotask(finish)}
    const wasConnected=this.gatt.connected;this.gatt.connected=false
    for(const characteristic of this.characteristics){characteristic.valid=false;characteristic.started=false}
    if(wasConnected)this.dispatchEvent(new Event('gattserverdisconnected'))
  }
  getServices(uuid){
    this.serviceCalls++
    return this.algorithm(async()=>{
      if(this.serviceGate)await this.serviceGate.promise
      if(uuid!==serviceId)throw new DOMException('service missing','NotFoundError')
      const characteristic=this.characteristic
      const service={uuid:serviceId,isPrimary:true,getCharacteristics:input=>this.algorithm(()=>{
        if(!characteristic.valid)throw new DOMException('stale service','InvalidStateError')
        const list=input&&input!==characteristicId?[]:[characteristic]
        return this.duplicateCharacteristics?[...list,...list]:list
      })}
      return this.duplicateServices?[service,service]:[service]
    })
  }
}
function grant(device,extra={}) { return {...trusted,device,exclusiveSession:true,purpose:'read heart rate',permissionVersion:'1',services:[serviceId],...extra} }
async function fixture({device=new Device(),bluetooth={requestDevice(){throw new Error('chooser must remain host-owned')},getDevices(){throw new Error('origin-wide enumeration prohibited')}},configuration,environment={},defaultGrant=true}={}) {
  const runtime=new Transport(),document=Object.assign(new EventTarget(),{hidden:false}),errors=[]
  const services=new BrowserHostServices({runtime,catalog,bluetooth:configuration??(defaultGrant?{initialized:true,grants:[grant(device)]}:null),environment:{navigator:{bluetooth},document,window:new EventTarget(),isSecureContext:true,setTimeout,clearTimeout,...environment},onDiagnostic:error=>errors.push(error)})
  await services.configure(trusted)
  const flush=async()=>{await services.drain();await turn();await services.drain()}
  const invoke=async(method,payload={})=>{const call=runtime.call(method,payload);await flush();return runtime.completions.find(result=>result.callId===call)}
  const connect=()=>invoke('wx.createBLEConnection',{deviceId:device.id})
  const notify=(state=true,extra={})=>invoke('wx.notifyBLECharacteristicValueChange',{deviceId:device.id,serviceId:'180D',characteristicId:'2A37',state,...extra})
  const subscribe=()=>invoke('wx.onBLECharacteristicValueChange',{action:'subscribe',subscriptionId:'values'})
  return {runtime,services,document,errors,device,bluetooth,flush,invoke,connect,notify,subscribe}
}
test('no configured grants means no Bluetooth handlers or origin enumeration',async()=>{
  const f=await fixture({defaultGrant:false});assert.equal(f.services.capabilities().apis.some(api=>/Bluetooth|BLE/.test(api)),false);await f.services.close();assert.equal(f.device.disconnects,0)
})
test('explicit grant scope includes accepted package, user, epoch, purpose and service allowlist',async()=>{
  for(const override of [{application:{...trusted.application,packRoot:'b'.repeat(64)}},{account:{principalId:'bob',epoch:1}},{account:{...trusted.account,epoch:2}},{purpose:''},{permissionVersion:''},{exclusiveSession:false},{services:['180d','180D']}]) {
    const device=new Device();await assert.rejects(fixture({configuration:{initialized:true,grants:[grant(device,override)]}}));assert.equal(device.disconnects,0)
  }
  await assert.rejects(fixture({configuration:{initialized:false,grants:[grant(new Device())]}}),/initialized/)
})
test('capabilities expose only initialized GATT leaves; connected host devices are never adopted',async()=>{
  const f=await fixture();const apis=f.services.capabilities().apis
  for(const api of ['wx.openBluetoothAdapter','wx.getBluetoothAdapterState','wx.getBluetoothDevices','wx.startBluetoothDevicesDiscovery'])assert.equal(apis.includes(api),false)
  f.device.gatt.connected=true;assert.equal((await f.connect()).error.code,'permission_denied');await f.services.close();assert.equal(f.device.disconnects,0)
})
test('shared global lease isolates owners and old close never disconnects a replacement owner',async()=>{
  const device=new Device(),bluetooth={};const a=await fixture({device,bluetooth}),b=await fixture({device,bluetooth})
  assert.ok((await a.connect()).result);assert.equal((await b.connect()).error.code,'permission_denied')
  await a.services.close();assert.equal(device.disconnects,1);assert.ok((await b.connect()).result);await a.services.close();assert.equal(device.gatt.connected,true);assert.equal(device.disconnects,1);await b.services.close()
})
test('cancel pending connect disconnects immediately and close waits the actual native abort terminal',async()=>{
  const f=await fixture();f.device.connectGate=deferred();f.device.abortGate=deferred()
  const call=f.runtime.call('wx.createBLEConnection',{deviceId:f.device.id});await f.services.drain();await turn();f.runtime.cancel(call);await f.services.drain();await turn();assert.equal(f.device.disconnects,1)
  let closed=false;const closing=f.services.close().then(()=>closed=true);await turn();assert.equal(closed,false)
  f.device.abortGate.resolve();await closing;assert.equal(f.device.gatt.connected,false);assert.equal(f.runtime.completions.some(value=>value.callId===call),false);assert.equal(f.device.count(),0)
})
test('close adapter invalidates a pending connection and does not admit new work',async()=>{
  const f=await fixture();f.device.connectGate=deferred();const call=f.runtime.call('wx.createBLEConnection',{deviceId:f.device.id});await f.services.drain();await turn();await f.invoke('wx.closeBluetoothAdapter');assert.equal(f.device.disconnects,1);assert.equal((await f.connect()).error.code,'cancelled');assert.equal(f.runtime.completions.find(value=>value.callId===call)?.error.code,'cancelled');await f.services.close()
})
test('allowlist and normalized UUIDs govern discovery, properties and both write modes',async()=>{
  const f=await fixture();await f.connect()
  const result=await f.invoke('wx.getBLEDeviceCharacteristics',{deviceId:f.device.id,serviceId:'180D'})
  assert.deepEqual(result.result.characteristics[0].properties,{read:true,write:true,writeDefault:true,writeNoResponse:true,notify:true,indicate:false})
  assert.equal((await f.invoke('wx.getBLEDeviceCharacteristics',{deviceId:f.device.id,serviceId:'180f'})).error.code,'permission_denied')
  const value={__weappBinary:{bytes:[1,2]}};for(const writeType of ['write','writeNoResponse'])assert.ok((await f.invoke('wx.writeBLECharacteristicValue',{deviceId:f.device.id,serviceId,characteristicId,writeType,value})).result)
  assert.deepEqual(f.device.characteristic.writes.map(value=>value.response),[true,false]);assert.equal(f.device.serviceCalls,1)
  assert.equal((await f.invoke('wx.writeBLECharacteristicValue',{deviceId:f.device.id,serviceId,characteristicId,writeType:'auto',value})).error.code,'invalid_request');await f.services.close()
})
test('cancelled native notification start immediately disconnects its exact source and drains its terminal',async()=>{
  const f=await fixture();await f.connect();await f.subscribe();const target=f.device.characteristic;target.startGate=deferred()
  const call=f.runtime.call('wx.notifyBLECharacteristicValueChange',{deviceId:f.device.id,serviceId,characteristicId,state:true});await f.services.drain();await turn();f.runtime.cancel(call);await f.flush();target.startGate.resolve();await f.flush();target.sample();await f.flush()
  assert.equal(f.device.disconnects,1);assert.equal(target.stops,0);assert.equal(target.started,false);assert.equal(target.count(),0);assert.equal(f.runtime.events.length,0);await f.services.close()
})
test('disable during native start invalidates the old generation and restart creates one listener',async()=>{
  const f=await fixture();await f.connect();await f.subscribe();const target=f.device.characteristic;target.startGate=deferred()
  f.runtime.call('wx.notifyBLECharacteristicValueChange',{deviceId:f.device.id,serviceId,characteristicId,state:true});await f.services.drain();await turn();f.runtime.call('wx.notifyBLECharacteristicValueChange',{deviceId:f.device.id,serviceId,characteristicId,state:false});await f.services.drain();await turn();target.startGate.resolve();await f.flush();assert.equal(target.started,false);assert.equal(target.stops,1);assert.equal(target.count(),0)
  target.startGate=null;await f.notify();assert.equal(target.count(),1);target.sample([9]);await f.flush();assert.equal(f.runtime.events.length,1);await f.services.close()
})
test('disable intent takes effect while the previous start is still discovering its service',async()=>{
  const f=await fixture();await f.connect();await f.subscribe();f.device.serviceGate=deferred();const target=f.device.characteristic
  const start=f.runtime.call('wx.notifyBLECharacteristicValueChange',{deviceId:f.device.id,serviceId,characteristicId,state:true});await f.services.drain();await turn();assert.equal(f.device.serviceCalls,1)
  const stop=f.runtime.call('wx.notifyBLECharacteristicValueChange',{deviceId:f.device.id,serviceId,characteristicId,state:false});await f.services.drain();await turn();f.device.serviceGate.resolve();await f.flush()
  assert.equal(target.starts,0);assert.equal(target.count(),0);assert.equal(f.runtime.completions.find(result=>result.callId===start).error.code,'cancelled');assert.ok(f.runtime.completions.find(result=>result.callId===stop).result)
  target.sample();await f.flush();assert.equal(f.runtime.events.length,0);await f.services.close()
})
test('cancellation after native acquisition but before owner completion drain still releases the exact connection',async()=>{
  for(const mode of ['connect','notify']) {
    const f=await fixture();let gate,call
    if(mode==='connect') {
      gate=f.device.connectGate=deferred();call=f.runtime.call('wx.createBLEConnection',{deviceId:f.device.id})
    } else {
      await f.connect();gate=f.device.characteristic.startGate=deferred();call=f.runtime.call('wx.notifyBLECharacteristicValueChange',{deviceId:f.device.id,serviceId,characteristicId,state:true})
    }
    await f.services.drain();await turn()
    // Start a normal owner turn with an empty completion lane, then let the
    // native promise finish while the transport is taking guest requests.
    const requests=deferred(),take=f.runtime.take_host_requests_json.bind(f.runtime)
    f.runtime.take_host_requests_json=()=>requests.promise
    const draining=f.services.drain();await turn();gate.resolve();await turn()
    assert.equal(f.device.gatt.connected,true)
    if(mode==='notify')assert.equal(f.device.characteristic.started,true)
    assert.equal(f.runtime.completions.some(result=>result.callId===call),false)
    requests.resolve(JSON.stringify([{kind:'cancel',callId:call}]));await draining;f.runtime.take_host_requests_json=take;await f.flush()
    assert.equal(f.device.disconnects,1);assert.equal(f.device.gatt.connected,false);assert.equal(f.device.count(),0);assert.equal(f.runtime.completions.some(result=>result.callId===call),false)
    if(mode==='notify')assert.equal(f.device.characteristic.count(),0)
    await f.services.close()
  }
})
test('disable revokes an already queued notification, including subscription ID reuse',async()=>{
  const f=await fixture();await f.connect();await f.subscribe();await f.notify();const target=f.device.characteristic
  f.runtime.call('wx.notifyBLECharacteristicValueChange',{deviceId:f.device.id,serviceId,characteristicId,state:false});await f.services.drain();target.sample();await turn();await f.services.drain();assert.equal(f.runtime.events.length,0)
  await f.notify();f.runtime.call('wx.offBLECharacteristicValueChange',{subscriptionId:'values'});await f.services.drain();target.sample();await turn();await f.services.drain();await f.subscribe();await f.flush();assert.equal(f.runtime.events.length,0);await f.services.close()
})
test('stop failure retains the notification until exact retry and preserves native error fields',async()=>{
  const f=await fixture();await f.connect();await f.notify();const target=f.device.characteristic;target.failStop=true
  const result=await f.notify(false);assert.equal(result.error.details.nativeName,'NetworkError');assert.equal(typeof result.error.details.errCode,'number');assert.equal(target.count(),1)
  target.failStop=false;await f.notify(false);assert.equal(target.stops,2);assert.equal(target.count(),0);await f.services.close()
})
test('failed listener cleanup retains the lease and retries without repeating successful disconnect',async()=>{
  const device=new Device(),bluetooth={};const a=await fixture({device,bluetooth}),b=await fixture({device,bluetooth});await a.connect();await a.notify();const target=device.characteristic;target.failRemove=true
  await assert.rejects(a.services.close(),/close failed/);assert.equal(device.disconnects,1);assert.equal((await b.connect()).error.code,'permission_denied')
  target.failRemove=false;await a.services.close();assert.equal(device.disconnects,1);assert.equal(target.count(),0);assert.ok((await b.connect()).result);await b.services.close()
})
test('disconnect and service changes invalidate all native attributes before reconnection',async()=>{
  const f=await fixture();await f.connect();await f.subscribe();await f.notify();const old=f.device.characteristic;const oldListener=[...old.listeners.get('characteristicvaluechanged')][0]
  f.device.dispatchEvent(new Event('servicechanged'));await f.flush();assert.equal(old.valid,false);assert.equal(old.count(),0);assert.ok((await f.connect()).result);await f.notify();oldListener({target:old});await f.flush();assert.equal(f.runtime.events.length,0);assert.notEqual(f.device.characteristic,old);assert.equal(f.device.serviceCalls,2);await f.services.close()
})
test('actual disconnection is observed for every connection and stale connected events are revoked',async()=>{
  const f=await fixture();await f.invoke('wx.onBLEConnectionStateChange',{action:'subscribe',subscriptionId:'connection'});await f.connect();f.runtime.events=[]
  f.device.disconnect();await f.flush();assert.deepEqual(f.runtime.events.map(event=>event.value.connected),[false]);assert.equal(f.device.count(),0);await f.services.close()
})
test('permission revocation and background suspension disconnect resources and reject new calls',async()=>{
  for(const hidden of [false,true]) {
    const device=new Device(),permission=new AbortController(),f=await fixture({device,configuration:{initialized:true,grants:[grant(device,{signal:permission.signal})]}});await f.connect();await f.notify()
    if(hidden){f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'))}else permission.abort()
    await f.flush();assert.equal(device.gatt.connected,false);assert.equal(device.characteristic.count(),0);assert.ok((await f.connect()).error);await f.services.close()
  }
})
test('backpressure revokes the producer, queued values and binary ownership without unbounded allocations',async()=>{
  const f=await fixture();await f.connect();await f.subscribe();await f.notify();const target=f.device.characteristic
  for(let i=0;i<257;i++)target.sample([i&255]);await turn();await f.services.drain();assert.equal(f.device.gatt.connected,false);assert.equal(f.runtime.events.length,0);assert.equal(f.services.binary.size,0);assert.ok(f.errors.some(error=>/queue|backpressure/.test(error.message)));await f.services.close()
})
test('ambiguous UUIDs and explicit notify transport types are refused instead of silently substituted',async()=>{
  const f=await fixture();await f.connect();f.device.duplicateServices=true
  assert.equal((await f.invoke('wx.getBLEDeviceServices',{deviceId:f.device.id})).error.code,'unsupported');f.device.duplicateServices=false;f.device.duplicateCharacteristics=true
  assert.equal((await f.invoke('wx.getBLEDeviceCharacteristics',{deviceId:f.device.id,serviceId})).error.code,'unsupported');f.device.duplicateCharacteristics=false
  f.device.characteristic.properties.indicate=true;assert.equal((await f.notify(true,{type:'indication'})).error.code,'unsupported');assert.equal(f.device.characteristic.starts,0);await f.services.close()
})
test('unsupported notification reconfiguration preserves the exact existing or pending native source',async()=>{
  for(const pending of [false,true]) {
    const f=await fixture();await f.connect();await f.subscribe();const target=f.device.characteristic;target.properties.indicate=true
    if(pending)target.startGate=deferred()
    const call=f.runtime.call('wx.notifyBLECharacteristicValueChange',{deviceId:f.device.id,serviceId,characteristicId,state:true});await f.services.drain();await turn()
    assert.equal(target.starts,1)
    const rejected=await f.notify(true,{type:'indication'});assert.equal(rejected.error.code,'unsupported')
    if(pending){target.startGate.resolve();await f.flush()}
    assert.ok(f.runtime.completions.find(result=>result.callId===call).result);assert.equal(target.started,true);assert.equal(target.starts,1);assert.equal(target.stops,0);assert.equal(target.count(),1)
    target.sample([11]);await f.flush();assert.equal(f.runtime.events.length,1);assert.equal(f.device.gatt.connected,true);await f.services.close()
  }
})
test('cancel pending read aborts only the leased connection and cannot publish a late read result',async()=>{
  const f=await fixture();await f.connect();await f.subscribe();const target=f.device.characteristic;target.readGate=deferred()
  const call=f.runtime.call('wx.readBLECharacteristicValue',{deviceId:f.device.id,serviceId,characteristicId});await f.services.drain();await turn();f.runtime.cancel(call);await f.flush()
  assert.equal(f.device.gatt.connected,false);target.readGate.resolve();await f.flush();assert.equal(f.runtime.events.length,0);assert.equal(f.runtime.completions.some(result=>result.callId===call),false);await f.services.close()
})
test('close drains an in-flight native stop and consumes each successful cleanup stage once',async()=>{
  const f=await fixture();await f.connect();await f.notify();const target=f.device.characteristic;target.stopGate=deferred();f.device.abortGate=deferred()
  f.runtime.call('wx.notifyBLECharacteristicValueChange',{deviceId:f.device.id,serviceId,characteristicId,state:false});await f.services.drain();await turn()
  let closed=false;const closing=f.services.close().then(()=>closed=true);await turn();assert.equal(closed,false);assert.equal(f.device.disconnects,1)
  f.device.abortGate.resolve();await closing;assert.equal(target.count(),0);assert.equal(target.stops,1);await f.services.close();assert.equal(f.device.disconnects,1)
})
test('Bluetooth binary bounds reject an oversized write before hardware access',async()=>{
  const f=await fixture();await f.connect();const result=await f.invoke('wx.writeBLECharacteristicValue',{deviceId:f.device.id,serviceId,characteristicId,value:{__weappBinary:{bytes:Array(513).fill(1)}}})
  assert.equal(result.error.code,'invalid_request');assert.equal(f.device.characteristic.writes.length,0);assert.equal(f.services.binary.size,0);await f.services.close()
})
