import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'

// Execute the production ArkTS owner with finite, observable SDK callbacks.
// This proves protocol/lifetime behavior; physical BLE acceptance is separate.
const ownerSource=await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/session/HostServices.ts',import.meta.url),'utf8')
const owner=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(ownerSource,{mode:'strip'})).toString('base64'))
const config={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:'1'}}
const id='AA:BB:CC:DD:EE:FF',service='0000180F-0000-1000-8000-00805F9B34FB',characteristic='00002A19-0000-1000-8000-00805F9B34FB'
const settle=()=>new Promise(resolve=>setImmediate(resolve)),binary=bytes=>({__weappBinary:{type:'ArrayBuffer',bytes}})
class NativeTransport {
  commands=[];requests=[]
  constructor(configuration=config){this.configuration=configuration}
  hostServices(json){const command=JSON.parse(json);this.commands.push(command);if(command.operation==='protocol')return '{"version":"1.0","trustedContext":true,"ownerThreadCompletion":true}';if(command.operation==='configure')return '{"ok":true,"sessionId":"session"}';if(command.operation==='take')return JSON.stringify({requests:this.requests.splice(0)});return '{"ok":true}'}
  call(callId,method,payload={}){this.requests.push({kind:'call',callId,method,payload,context:{...this.configuration,sessionId:'session',callId,api:method}})}
  cancel(callId){this.requests.push({kind:'cancel',callId})}
  completions(){return this.commands.filter(value=>value.operation==='complete').map(value=>value.payload)}
  events(){return this.commands.filter(value=>value.operation==='event').map(value=>value.payload)}
}
class Gatt {
  events=new Map();closed=0;disconnected=0;connected=0;writes=[];services=[];order=[]
  on(event,callback){this.events.set(event,callback)} off(event,callback){assert.equal(this.events.get(event),callback);this.events.delete(event)}
  connect(){this.connected++} disconnect(){this.disconnected++} close(){this.closed++;if(this.closeError)throw this.closeError}
  getServices(){this.order.push('services');return this.servicesPromise||Promise.resolve(this.services)}
  async getRssiValue(){return -52}
  async readCharacteristicValue(value){this.order.push('read');return this.readPromise||{...value,characteristicValue:new Uint8Array([9,8]).buffer}}
  async writeCharacteristicValue(value,type){this.order.push('write');this.writes.push({value:[...new Uint8Array(value.characteristicValue)],type})}
  async setCharacteristicChangeNotification(value,state){this.order.push('notify');this.notifyState=state}
  setBLEMtuSize(mtu){this.requestedMtu=mtu}
  emit(event,value){this.events.get(event)?.(value)}
}
async function fixture({permission,dialog}={}){
  const clients=[],scanListeners=new Set(),states=new Set(),stats={scanStarts:0,scanStops:0}
  const dependencies={...owner,
    access:{BluetoothState:{STATE_ON:2,STATE_OFF:0},getState:()=>2,on(event,fn){states.add(fn)},off(event,fn){states.delete(fn)}},
    constant:{ProfileConnectionState:{STATE_CONNECTED:2,STATE_DISCONNECTED:0}},
    abilityAccessCtrl:{PermissionStatus:{GRANTED:0},createAtManager:()=>({getSelfPermissionStatus:()=>0,requestPermissionsFromUser:()=>permission||Promise.resolve({authResults:[0]})})},
    promptAction:{showDialog:()=>dialog||Promise.resolve({index:0})},
    ble:{ScanDuty:{SCAN_MODE_BALANCED:1},GattWriteType:{WRITE:1,WRITE_NO_RESPONSE:2},on(event,fn){scanListeners.add(fn)},off(event,fn){scanListeners.delete(fn)},startBLEScan(){stats.scanStarts++},stopBLEScan(){stats.scanStops++},createGattClientDevice(){const client=new Gatt();client.services=[{serviceUuid:service,isPrimary:true,characteristics:[{serviceUuid:service,characteristicUuid:characteristic,characteristicValue:new ArrayBuffer(0),descriptors:[],properties:{read:true,write:true,writeNoResponse:true,notify:true,indicate:false}}]}];clients.push(client);return client}},
  }
  const source=(await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/native/HarmonyBluetoothApis.ets',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'')
  const key=`__harmonyBle${++fixture.sequence}`;globalThis[key]=dependencies
  const binding=`const {HarmonyApiError,abilityAccessCtrl,promptAction,ble,access,constant}=globalThis.${key};\n`
  const module=await import('data:text/javascript;base64,'+Buffer.from(binding+stripTypeScriptTypes(source,{mode:'strip'})).toString('base64'))
  delete globalThis[key]
  const container=(configuration=config)=>{
    const native=new NativeTransport(configuration),services=new owner.HarmonyHostServices(native),adapter=new module.HarmonyBluetoothApis({},services)
    services.configure(configuration,configuration.application.packRoot)
    const pump=async()=>{services.drain();await settle();services.drain()}
    const open=async()=>{native.call('open','wx.openBluetoothAdapter');await pump();assert.equal(native.completions().at(-1).result.errMsg,'openBluetoothAdapter:ok')}
    const connect=async()=>{native.call('connect','wx.createBLEConnection',{deviceId:id});await pump();const client=clients.at(-1);client.emit('BLEConnectionStateChange',{deviceId:id,state:2});await pump();assert.equal(native.completions().at(-1).result.errMsg,'createBLEConnection:ok');return client}
    return {native,services,adapter,clients,scanListeners,states,stats,pump,open,connect}
  }
  return {...container(),container}
}
fixture.sequence=0

test('Harmony BLE permission resolving after revocation cannot acquire native resources and gates account drain',async()=>{
  let grant;const permission=new Promise(resolve=>grant=resolve),f=await fixture({permission})
  f.native.call('open','wx.openBluetoothAdapter');await f.pump();f.services.revoke()
  let done=false;const drain=f.services.waitForDrain().then(()=>done=true);await settle();assert.equal(done,false)
  grant({authResults:[0]});await drain
  assert.equal(f.states.size,0);assert.equal(f.clients.length,0);assert.equal(f.native.completions().length,0)
})

test('Harmony BLE scan callbacks queue only on the owner and obsolete scan cancellation cannot stop a replacement',async()=>{
  const f=await fixture();await f.open();f.native.call('listen','wx.onBluetoothDeviceFound',{subscriptionId:'found'});f.native.call('scan1','wx.startBluetoothDevicesDiscovery');await f.pump()
  const old=[...f.scanListeners][0],sample={deviceId:id,deviceName:'Sensor',rssi:-42,data:new Uint8Array([4,255,1,2,3]).buffer,serviceUuids:[service]}
  old([sample]);assert.equal(f.native.events().length,0);await f.pump()
  assert.deepEqual(f.native.events()[0].value.devices[0].advertisData,binary([1,2,3]))
  f.native.call('stop','wx.stopBluetoothDevicesDiscovery');await f.pump();f.native.call('scan2','wx.startBluetoothDevicesDiscovery',{allowDuplicatesKey:true});await f.pump()
  const stops=f.stats.scanStops;f.native.cancel('scan1');await f.pump();assert.equal(f.stats.scanStops,stops)
  const events=f.native.events().length;old([sample]);await f.pump();assert.equal(f.native.events().length,events)
  const fresh=[...f.scanListeners][0];fresh([sample]);await f.pump();assert.equal(f.native.events().length,events+1)
  f.services.revoke();await f.services.waitForDrain();assert.equal(f.scanListeners.size,0);assert.equal(f.states.size,0)
})

test('Harmony BLE serializes GATT calls, preserves exact binary notifications and bounds negotiated writes',async()=>{
  const f=await fixture();await f.open();const client=await f.connect()
  f.native.call('listen','wx.onBLECharacteristicValueChange',{subscriptionId:'values'});f.native.call('notify','wx.notifyBLECharacteristicValueChange',{deviceId:id,serviceId:'180F',characteristicId:'2A19',state:true});await f.pump()
  const value={serviceUuid:service,characteristicUuid:characteristic,characteristicValue:new Uint8Array([0,255,17]).buffer,descriptors:[]}
  client.emit('BLECharacteristicChange',value);assert.equal(f.native.events().length,0);await f.pump()
  assert.deepEqual(f.native.events().at(-1).value.value,binary([0,255,17]))
  f.native.call('write','wx.writeBLECharacteristicValue',{deviceId:id,serviceId:'180F',characteristicId:'2A19',value:binary([0,255]),writeType:'writeNoResponse'});f.native.call('tooBig','wx.writeBLECharacteristicValue',{deviceId:id,serviceId:'180F',characteristicId:'2A19',value:binary(Array(21).fill(0))});await f.pump()
  assert.deepEqual(client.writes,[{value:[0,255],type:2}]);assert.equal(f.native.completions().find(value=>value.callId==='tooBig').error.details.errCode,10013)
  assert.deepEqual(client.order,['services','notify','write'])
  f.services.revoke();await f.services.waitForDrain();assert.equal(client.closed,1);assert.equal(client.events.size,0)
})

test('Harmony BLE MTU completion waits for the native negotiation callback and cancellation retires its exact waiter',async()=>{
  const f=await fixture();await f.open();const client=await f.connect()
  f.native.call('listen','wx.onBLEMTUChange',{subscriptionId:'mtu'});f.native.call('mtu','wx.setBLEMTU',{deviceId:id,mtu:100});await f.pump()
  assert.equal(client.requestedMtu,100);assert.equal(f.native.completions().some(value=>value.callId==='mtu'),false)
  client.emit('BLEMtuChange',64);assert.equal(f.native.events().length,0);await f.pump()
  assert.equal(f.native.completions().find(value=>value.callId==='mtu').result.errMsg,'setBLEMTU:ok');assert.equal(f.native.events().at(-1).value.mtu,64)
  f.native.call('get','wx.getBLEMTU',{deviceId:id});f.native.call('pending','wx.setBLEMTU',{deviceId:id,mtu:200});await f.pump()
  assert.equal(f.native.completions().find(value=>value.callId==='get').result.mtu,64)
  const old=client.events.get('BLEMtuChange');f.native.cancel('pending');await f.pump();await f.services.waitForDrain()
  assert.equal(client.closed,1);assert.equal(client.events.size,0);assert.equal(f.native.completions().some(value=>value.callId==='pending'),false)
  const count=f.native.events().length;old(200);await f.pump();assert.equal(f.native.events().length,count)
  f.services.revoke();await f.services.waitForDrain()
})

test('Harmony BLE parses service filters and exact service/manufacturer data from the platform raw advertisement',async()=>{
  const f=await fixture();await f.open();f.native.call('listen','wx.onBluetoothDeviceFound',{subscriptionId:'found'});f.native.call('scan','wx.startBluetoothDevicesDiscovery',{services:['180F']});await f.pump()
  const scan=[...f.scanListeners][0]
  scan([{deviceId:id,deviceName:'Raw peripheral',rssi:-44,data:new Uint8Array([3,3,0x0f,0x18,5,0x16,0x0f,0x18,0,255,4,255,0,255,17]).buffer}]);await f.pump()
  const device=f.native.events().find(value=>value.event==='BluetoothDeviceFound').value.devices[0]
  assert.deepEqual(device.advertisServiceUUIDs,[service]);assert.deepEqual(device.serviceData[service],binary([0,255]));assert.deepEqual(device.advertisData,binary([0,255,17]))
  const events=f.native.events().length;scan([{deviceId:'00:11:22:33:44:55',deviceName:'Other',rssi:-40,data:new Uint8Array([3,3,0x0a,0x18]).buffer}]);await f.pump();assert.equal(f.native.events().length,events)
  f.services.revoke();await f.services.waitForDrain()
})

test('Harmony BLE process scanner lease prevents another container from stopping or adopting its producer',async()=>{
  const f=await fixture(),other=f.container({...config,application:{...config.application,appId:'other'}})
  await f.open();await other.open();f.native.call('scan','wx.startBluetoothDevicesDiscovery');await f.pump();assert.equal(f.stats.scanStarts,1)
  other.native.call('busy','wx.startBluetoothDevicesDiscovery');other.native.call('stop','wx.stopBluetoothDevicesDiscovery');await other.pump()
  assert.match(other.native.completions().find(value=>value.callId==='busy').error.message,/another container/);assert.equal(f.stats.scanStops,0)
  other.services.revoke();await other.services.waitForDrain();assert.equal(f.scanListeners.size,1);assert.equal(f.stats.scanStops,0)
  f.services.revoke();await f.services.waitForDrain();assert.equal(f.stats.scanStops,1);assert.equal(f.scanListeners.size,0)
})

test('Harmony BLE retirement waits for a native read final and never publishes its old-account bytes',async()=>{
  const f=await fixture();await f.open();const client=await f.connect();let finish
  client.readPromise=new Promise(resolve=>finish=resolve)
  f.native.call('listen','wx.onBLECharacteristicValueChange',{subscriptionId:'value'});f.native.call('read','wx.readBLECharacteristicValue',{deviceId:id,serviceId:'180F',characteristicId:'2A19'});await f.pump()
  const late=client.events.get('BLECharacteristicChange');f.services.revoke();let done=false;const drain=f.services.waitForDrain().then(()=>done=true);await settle();assert.equal(done,false);assert.equal(client.closed,1)
  const value={serviceUuid:service,characteristicUuid:characteristic,characteristicValue:new Uint8Array([99]).buffer,descriptors:[]};late(value);finish(value);await drain
  assert.equal(f.native.events().length,0);assert.equal(f.native.completions().some(value=>value.callId==='read'),false)
})

test('Harmony BLE backpressure stops the exact native notification producer and failed native close remains retryable',async()=>{
  const f=await fixture();await f.open();const client=await f.connect()
  f.native.call('listen','wx.onBLECharacteristicValueChange',{subscriptionId:'value'});f.native.call('notify','wx.notifyBLECharacteristicValueChange',{deviceId:id,serviceId:'180F',characteristicId:'2A19',state:true});await f.pump()
  f.services.emit=()=>false;client.closeError=new Error('native client close failed')
  client.emit('BLECharacteristicChange',{serviceUuid:service,characteristicUuid:characteristic,characteristicValue:new Uint8Array([1]).buffer,descriptors:[]});await settle()
  await assert.rejects(f.adapter.close(),/did not retire/);assert.ok(client.closed>=2)
  client.closeError=null;await f.adapter.close();assert.ok(client.closed>=3)
  f.services.revoke();await f.services.waitForDrain()
})


test('Harmony BLE queued scan and characteristic events are revoked before the owner enters JS',async()=>{
  const f=await fixture();await f.open();const client=await f.connect()
  f.native.call('found','wx.onBluetoothDeviceFound',{subscriptionId:'found'});f.native.call('values','wx.onBLECharacteristicValueChange',{subscriptionId:'values'});f.native.call('scan','wx.startBluetoothDevicesDiscovery');f.native.call('notify','wx.notifyBLECharacteristicValueChange',{deviceId:id,serviceId:'180F',characteristicId:'2A19',state:true});await f.pump()
  const before=f.native.events().length
  const value={serviceUuid:service,characteristicUuid:characteristic,characteristicValue:new Uint8Array([7]).buffer,descriptors:[]}
  client.emit('BLECharacteristicChange',value)
  ;[...f.scanListeners][0]([{deviceId:id,deviceName:'Sensor',rssi:-42,data:new ArrayBuffer(0),serviceUuids:[service]}])
  f.services.setForeground(false);await settle();f.services.setForeground(true);await f.pump()
  assert.equal(f.native.events().length,before)
  f.services.revoke();await f.services.waitForDrain()
})

test('Harmony BLE notification disable revokes a queued value before native completion and cannot revive it on re-enable',async()=>{
  const f=await fixture();await f.open();const client=await f.connect()
  f.native.call('values','wx.onBLECharacteristicValueChange',{subscriptionId:'values'});f.native.call('notify','wx.notifyBLECharacteristicValueChange',{deviceId:id,serviceId:'180F',characteristicId:'2A19',state:true});await f.pump()
  f.native.call('disable','wx.notifyBLECharacteristicValueChange',{deviceId:id,serviceId:'180F',characteristicId:'2A19',state:false});f.services.drain()
  const value={serviceUuid:service,characteristicUuid:characteristic,characteristicValue:new Uint8Array([7]).buffer,descriptors:[]}
  client.emit('BLECharacteristicChange',value);await settle();f.services.drain()
  assert.equal(f.native.events().filter(event=>event.event==='BLECharacteristicValueChange').length,0)
  f.native.call('enable','wx.notifyBLECharacteristicValueChange',{deviceId:id,serviceId:'180F',characteristicId:'2A19',state:true});await f.pump();client.emit('BLECharacteristicChange',value);await f.pump()
  assert.equal(f.native.events().filter(event=>event.event==='BLECharacteristicValueChange').length,1)
  f.services.revoke();await f.services.waitForDrain()
})
