import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
const root=new URL('../examples/hosts/harmony/entry/src/main/ets/',import.meta.url)
const ownerSource=await readFile(new URL('session/HostServices.ts',root),'utf8')
const owner=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(ownerSource,{mode:'strip'})).toString('base64'))
const config={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:'1'}}
const technologies=['Ndef','IsoDep','MifareClassic','MifareUltralight','NfcA','NfcB','NfcF','NfcV']
const policy={purpose:'读取我选择的门禁标签',permissionVersion:'1',exclusiveForegroundDispatch:true,technologies}
const types={Ndef:6,IsoDep:3,MifareClassic:8,MifareUltralight:9,NfcA:1,NfcB:2,NfcF:4,NfcV:5}
const binary=bytes=>({__weappBinary:{type:'ArrayBuffer',bytes}})
const settle=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
const nativeInfo=(uid=[4,128,255])=>({uid,technology:[6,3,8,9,1,2,4,5]})
class Transport {
  commands=[];requests=[];sequence=0
  hostServices(json){const c=JSON.parse(json);this.commands.push(c);if(c.operation==='protocol')return '{"version":"1.0","trustedContext":true,"ownerThreadCompletion":true}';if(c.operation==='configure')return '{"ok":true,"sessionId":"session"}';if(c.operation==='take')return JSON.stringify({requests:this.requests.splice(0)});return '{"ok":true}'}
  call(method,payload={}){const callId='call-'+ ++this.sequence;this.requests.push({kind:'call',callId,method,payload,context:{...config,sessionId:'session',callId,api:method}});return callId}
  cancel(callId){this.requests.push({kind:'cancel',callId})}
  completions(){return this.commands.filter(x=>x.operation==='complete').map(x=>x.payload)}
  events(){return this.commands.filter(x=>x.operation==='event').map(x=>x.payload)}
}
async function fixture(options={}){
  const callbacks=new Set(),radios=new Set(),permissions=new Set(),stats={registered:[],unregistered:[],sessions:[],maximum:128,transmits:[],writes:[],resets:[],timeouts:[],permission:true,radio:3,record:{tnf:2,rtdType:[97,0,255],id:[128,0,255],payload:[255,0,128]}}
  const message=()=>({getNdefRecords:()=>[stats.record]})
  class Session {
    connected=false
    constructor(technology,info){this.technology=technology;this.info=info;stats.sessions.push(this)}
    connect(){this.connected=true}
    resetConnection(){stats.resets.push(this);if(stats.resetError)throw stats.resetError;this.connected=false}
    isConnected(){return this.connected}
    setTimeout(value){stats.timeouts.push([this,value])}
    getMaxTransmitSize(){return stats.maximum}
    getHistoricalBytes(){return [128,0,255]}
    getAtqa(){return [68,0]}
    getSak(){return 8}
    transmit(data){stats.transmits.push([this,data]);return options.transmit?.promise||Promise.resolve([144,0])}
    getNdefMessage(){return message()}
    readNdef(){return options.read?.promise||Promise.resolve(message())}
    writeNdef(value){stats.writes.push([this,value]);return options.write?.promise||Promise.resolve()}
  }
  const tag={NDEF:6,ISO_DEP:3,MIFARE_CLASSIC:8,MIFARE_ULTRALIGHT:9,NFC_A:1,NFC_B:2,NFC_F:4,NFC_V:5,
    registerForegroundDispatch(element,poll,callback){stats.registered.push([element,poll,callback]);callbacks.add(callback)},
    unregisterForegroundDispatch(element){stats.unregistered.push(element);if(stats.offError)throw stats.offError;callbacks.clear()},
    ndef:{makeTextRecord:(text,lang)=>({tnf:1,rtdType:[84],id:[],payload:[2,101,110,...new TextEncoder().encode(text)]}),makeUriRecord:uri=>({tnf:1,rtdType:[85],id:[],payload:[0,...new TextEncoder().encode(uri)]}),createNdefMessage:records=>({getNdefRecords:()=>records}),messageToBytes:message=>message.getNdefRecords().flatMap(record=>[0,record.tnf,...record.rtdType,...record.id,...record.payload])}}
  for(const technology of technologies)tag['get'+technology]=info=>new Session(technology,info)
  const nfcController={NfcState:{STATE_ON:3},getNfcState:()=>stats.radio,on(event,fn){radios.add(fn)},off(event,fn){if(stats.radioOffError)throw stats.radioOffError;radios.delete(fn)}}
  const manager={getSelfPermissionStatus:()=>stats.permission?0:-1,on(event,list,fn){permissions.add(fn)},off(event,list,fn){if(stats.permissionOffError)throw stats.permissionOffError;permissions.delete(fn)}}
  const dependencies={...owner,tag,nfcController,abilityAccessCtrl:{PermissionStatus:{GRANTED:0},createAtManager:()=>manager},canIUse:()=>true}
  const source=(await readFile(new URL('native/HarmonyNfcApis.ets',root),'utf8')).replace(/^import .*;\n/gm,'')
  const key=`__harmonyNfc${++fixture.sequence}`;globalThis[key]=dependencies
  const module=await import('data:text/javascript;base64,'+Buffer.from(`const {HarmonyApiError,abilityAccessCtrl,tag,nfcController,canIUse}=globalThis.${key};\n`+stripTypeScriptTypes(source,{mode:'strip'})).toString('base64'));delete globalThis[key]
  const container=(configuration=policy)=>{
    const native=new Transport(),services=new owner.HarmonyHostServices(native),adapter=new module.HarmonyNfcApis({abilityInfo:{bundleName:'host.example',name:'EntryAbility',moduleName:'entry'}},services,configuration,()=>options.disclosure?.promise||Promise.resolve(true))
    services.configure(config,config.application.packRoot)
    const pump=async()=>{for(let i=0;i<3;i++){services.drain();await settle()}}
    const invoke=async(method,payload={})=>{const id=native.call(method,payload);await pump();return native.completions().find(value=>value.callId===id)}
    const factory=async(id='reader')=>invoke('wx.getNFCAdapter',{objectId:id})
    const child=async(technology,id=technology,parent='reader')=>invoke('object:NFCAdapter.get'+technology,{objectId:id,receiverId:parent})
    const start=async(id='reader')=>{if(!native.completions().some(value=>value.result?.objectId===id))await factory(id);const result=await invoke('object:NFCAdapter.startDiscovery',{objectId:id});assert.equal(result.result?.errMsg,'object:NFCAdapter.startDiscovery:ok');return result}
    const stop=async()=>{services.revoke();await services.waitForDrain()}
    return {native,services,adapter,pump,invoke,factory,child,start,stop}
  }
  const emit=info=>{for(const callback of [...callbacks])callback(undefined,info)}
  return {...container(options.configuration),container,module,stats,callbacks,radios,permissions,emit,message}
}
fixture.sequence=0

test('Harmony NFC default and policy gates expose only explicitly chosen real technology leaves',async()=>{
  const f=await fixture({configuration:{...policy,technologies:['NfcA']}})
  try{
    assert.equal(f.module.installHarmonyNfcApis({},f.services,{}),null)
    assert.throws(()=>f.module.configureHarmonyNfc({...policy,exclusiveForegroundDispatch:false}),/exclusive/)
    assert.throws(()=>f.module.configureHarmonyNfc({...policy,technologies:['invented']}),/technologies/)
    assert.equal(f.adapter.supportedApis.length,15);assert.ok(!f.adapter.supportedApis.includes('object:NFCAdapter.getNdef'))
    const factory=await f.factory();assert.deepEqual(factory.result.properties.tech,{nfcA:'NFC_A'});assert.equal(f.stats.registered.length,0)
  }finally{await f.stop()}
})

test('Harmony NFC all selected native technologies map exactly the frozen 66 leaves, with actual A/B/F/V poll filters',async()=>{
  const f=await fixture()
  try{
    const catalog=JSON.parse(await readFile(new URL('../crates/container-runtime/src/host-api-catalog.json',import.meta.url)))
    const names=catalog.apis.filter(api=>api.name==='wx.getNFCAdapter'||/^object:(NFCAdapter|Ndef|IsoDep|MifareClassic|MifareUltralight|Nfc[ABFV])\./.test(api.name)).map(api=>api.name)
    assert.deepEqual([...f.adapter.supportedApis].sort(),names.sort())
    assert.equal(new Set(f.module.potentialApis).size,66)
    assert.deepEqual([...f.module.potentialApis].sort(),[...f.adapter.supportedApis].sort())
    await f.start();assert.deepEqual(f.stats.registered[0][1],[1,2,4,5]);assert.deepEqual(f.stats.registered[0][0],{bundleName:'host.example',abilityName:'EntryAbility',moduleName:'entry'})
  }finally{await f.stop()}
})

test('Harmony NFC discovery preserves genuine UID and raw NDEF fields, emits only through the owner queue',async()=>{
  const f=await fixture()
  try{
    await f.start();await f.invoke('object:NFCAdapter.onDiscovered',{objectId:'reader',subscriptionId:'discovered'});f.emit(nativeInfo())
    assert.equal(f.native.events().length,0);await f.pump();const event=f.native.events()[0]
    assert.deepEqual(event.value.id,binary([4,128,255]));assert.deepEqual(event.value.techs,['NDEF','ISO_DEP','MIFARE_CLASSIC','MIFARE_ULTRALIGHT','NFC_A','NFC_B','NFC_F','NFC_V'])
    assert.deepEqual(event.value.messages,[{records:[{tnf:2,type:binary([97,0,255]),id:binary([128,0,255]),payload:binary([255,0,128])}]}])
  }finally{await f.stop()}
})

test('Harmony NFC seven raw technologies use real connect, max, timeout, transmit and logical close objects',async()=>{
  const f=await fixture()
  try{
    await f.start();f.emit(nativeInfo());await f.pump()
    for(const technology of technologies.filter(value=>value!=='Ndef')){
      await f.child(technology)
      assert.ok((await f.invoke('object:'+technology+'.connect',{objectId:technology})).result)
      assert.equal((await f.invoke('object:'+technology+'.isConnected',{objectId:technology})).result.isConnected,true)
      assert.equal((await f.invoke('object:'+technology+'.getMaxTransceiveLength',{objectId:technology})).result.length,128)
      await f.invoke('object:'+technology+'.setTimeout',{objectId:technology,timeout:700})
      assert.deepEqual((await f.invoke('object:'+technology+'.transceive',{objectId:technology,data:binary([128,0,255])})).result.data,binary([144,0]))
      if(technology==='IsoDep')assert.deepEqual((await f.invoke('object:IsoDep.getHistoricalBytes',{objectId:technology})).result.histBytes,binary([128,0,255]))
      if(technology==='NfcA'){assert.deepEqual((await f.invoke('object:NfcA.getAtqa',{objectId:technology})).result.atqa,binary([68,0]));assert.equal((await f.invoke('object:NfcA.getSak',{objectId:technology})).result.sak,8)}
      await f.invoke('object:'+technology+'.close',{objectId:technology})
      assert.equal((await f.invoke('object:'+technology+'.isConnected',{objectId:technology})).result.isConnected,false)
    }
    assert.equal(f.stats.transmits.length,7);assert.equal(f.stats.resets.length,7);assert.ok(f.stats.timeouts.every(([,value])=>value===700))
  }finally{await f.stop()}
})

test('Harmony NFC NDEF reads and writes raw binary through actual native message objects',async()=>{
  const f=await fixture()
  try{
    await f.start();await f.child('Ndef');await f.invoke('object:Ndef.onNdefMessage',{objectId:'Ndef',subscriptionId:'message'});f.emit(nativeInfo());await f.pump()
    assert.ok((await f.invoke('object:Ndef.connect',{objectId:'Ndef'})).result);assert.deepEqual(f.native.events().at(-1).value.records[0].id,binary([128,0,255]))
    const raw={tnf:2,type:binary([97,0,255]),id:binary([0,128]),payload:binary([255,0])}
    assert.ok((await f.invoke('object:Ndef.writeNdefMessage',{objectId:'Ndef',records:[raw]})).result)
    assert.deepEqual(f.stats.writes[0][1].getNdefRecords(),[{tnf:2,rtdType:[97,0,255],id:[0,128],payload:[255,0]}])
  }finally{await f.stop()}
})

test('Harmony NFC actual tag technology and native maximum restrict operations without fabricated support',async()=>{
  const f=await fixture()
  try{
    await f.start();f.emit({uid:[1],technology:[1]});await f.pump();await f.child('MifareClassic');assert.equal((await f.invoke('object:MifareClassic.connect',{objectId:'MifareClassic'})).error.code,'unsupported')
    await f.child('NfcA');await f.invoke('object:NfcA.connect',{objectId:'NfcA'});f.stats.maximum=2
    assert.equal((await f.invoke('object:NfcA.transceive',{objectId:'NfcA',data:binary([1,2,3])})).error.code,'invalid_request');assert.equal(f.stats.transmits.length,0)
    assert.equal((await f.invoke('object:NfcA.setTimeout',{objectId:'NfcA',timeout:0.5})).error.code,'invalid_request')
  }finally{await f.stop()}
})

test('Harmony NFC a new tag epoch invalidates old children even for the same UID and drops queued old discovery',async()=>{
  const f=await fixture()
  try{
    await f.start();await f.invoke('object:NFCAdapter.onDiscovered',{objectId:'reader',subscriptionId:'discovered'});f.emit(nativeInfo());await f.pump();await f.child('NfcA');await f.invoke('object:NfcA.connect',{objectId:'NfcA'})
    f.emit(nativeInfo());await f.pump();assert.equal(f.stats.resets.length,1)
    assert.equal((await f.invoke('object:NfcA.transceive',{objectId:'NfcA',data:binary([1])})).error.code,'cancelled')
    const old=[...f.callbacks][0];old(undefined,nativeInfo([7]));f.services.setForeground(false);f.services.setForeground(true);await f.pump();assert.ok(f.native.events().every(event=>event.value.id.__weappBinary.bytes[0]!==7));old(undefined,nativeInfo([8]));await f.pump();assert.equal(f.callbacks.size,0)
  }finally{await f.stop()}
})

test('Harmony NFC cancellation waits the actual transmit terminal and retains its process lease',async()=>{
  const transmit=deferred(),f=await fixture({transmit}),other=f.container()
  try{
    await f.start();f.emit(nativeInfo());await f.pump();await f.child('IsoDep');await f.invoke('object:IsoDep.connect',{objectId:'IsoDep'})
    const call=f.native.call('object:IsoDep.transceive',{objectId:'IsoDep',data:binary([1])});await f.pump();assert.equal(f.stats.transmits.length,1)
    f.native.cancel(call);await f.pump();let drained=false;const barrier=f.services.waitForDrain().then(()=>drained=true);await settle();assert.equal(drained,false);assert.equal(f.callbacks.size,0);assert.equal(f.stats.resets.length,1)
    await other.factory();const busy=await other.invoke('object:NFCAdapter.startDiscovery',{objectId:'reader'});assert.equal(busy.error.code,'invalid_request')
    transmit.resolve([144,0]);await barrier;await f.pump();assert.equal(f.native.completions().some(value=>value.callId===call),false)
    await other.start();assert.equal(f.stats.registered.length,2)
  }finally{transmit.resolve([144,0]);await Promise.all([f.stop(),other.stop()])}
})

test('Harmony NFC failed exact unregister and reset remain owned and retry only their retained release stages',async()=>{
  const f=await fixture(),other=f.container()
  try{
    await f.start();f.emit(nativeInfo());await f.pump();await f.child('NfcA');await f.invoke('object:NfcA.connect',{objectId:'NfcA'});f.stats.offError=new Error('native unregister failed');f.stats.resetError=new Error('native reset failed')
    f.services.revoke();await assert.rejects(f.services.waitForDrain(),/release|resources/);await other.factory();assert.ok((await other.invoke('object:NFCAdapter.startDiscovery',{objectId:'reader'})).error)
    assert.equal(f.stats.registered.length,1);f.stats.offError=null;f.stats.resetError=null;await f.services.retryResourceCleanup();assert.equal(f.callbacks.size,0);assert.equal(f.radios.size,0);assert.equal(f.permissions.size,0)
    await other.start();assert.equal(f.stats.registered.length,2)
  }finally{f.stats.offError=null;f.stats.resetError=null;await Promise.all([f.services.retryResourceCleanup(),other.stop()])}
})

test('Harmony NFC pending disclosure remains an execution barrier and cannot acquire after revocation',async()=>{
  const disclosure=deferred(),f=await fixture({disclosure})
  await f.factory();f.native.call('object:NFCAdapter.startDiscovery',{objectId:'reader'});await f.pump();f.services.revoke();let drained=false;const barrier=f.services.waitForDrain().then(()=>drained=true);await settle();assert.equal(drained,false)
  disclosure.resolve(true);await barrier;assert.equal(f.stats.registered.length,0);assert.equal(f.callbacks.size,0)
})

test('Harmony NFC native discovery success remains cancellable while its JS completion is still queued',async()=>{
  const f=await fixture()
  try{
    await f.factory();const call=f.native.call('object:NFCAdapter.startDiscovery',{objectId:'reader'});f.services.drain();await settle();assert.equal(f.callbacks.size,1)
    f.native.cancel(call);f.services.drain();await f.services.waitForDrain()
    assert.equal(f.callbacks.size,0);assert.equal(f.stats.unregistered.length,1);assert.equal(f.native.completions().some(value=>value.callId===call),false)
    await f.start();assert.equal(f.callbacks.size,1)
  }finally{await f.stop()}
})

test('Harmony NFC backpressure stops its own exact foreground dispatch and no stale callback can restart it',async()=>{
  const f=await fixture()
  try{
    await f.start();await f.invoke('object:NFCAdapter.onDiscovered',{objectId:'reader',subscriptionId:'discovered'});const callback=[...f.callbacks][0];f.services.emit=()=>false;callback(undefined,nativeInfo());await f.pump()
    assert.equal(f.callbacks.size,0);assert.equal(f.stats.unregistered.length,1);callback(undefined,nativeInfo());await f.pump();assert.equal(f.stats.registered.length,1)
  }finally{await f.stop()}
})

test('Harmony NFC close shares the actual pending native write terminal and does not acknowledge cancellation as completion',async()=>{
  const write=deferred(),f=await fixture({write})
  await f.start();f.emit(nativeInfo());await f.pump();await f.child('Ndef');await f.invoke('object:Ndef.connect',{objectId:'Ndef'})
  f.native.call('object:Ndef.writeNdefMessage',{objectId:'Ndef',texts:['hello']});await f.pump();const a=f.adapter.close(),b=f.adapter.close();assert.equal(a,b);let closed=false;void a.then(()=>closed=true);await settle();assert.equal(closed,false)
  write.resolve();await Promise.all([a,b]);assert.equal(f.stats.resets.length,1);await f.stop()
})

test('Harmony NFC revocation and radio changes release owned ingress without toggling the system NFC controller',async()=>{
  const f=await fixture()
  try{
    await f.factory();f.stats.permission=false;assert.equal((await f.invoke('object:NFCAdapter.startDiscovery',{objectId:'reader'})).error.code,'permission_denied');assert.equal(f.stats.registered.length,0)
    f.stats.permission=true;await f.start();f.stats.permission=false;for(const callback of [...f.permissions])callback();await f.pump();assert.equal(f.callbacks.size,0)
    f.stats.permission=true;await f.start();for(const callback of [...f.radios])callback(1);await f.pump();assert.equal(f.callbacks.size,0);assert.equal(f.stats.registered.length,2)
  }finally{await f.stop()}
})

test('Harmony NFC object factories and subscriptions cannot cross technology or survive their retained object cancellation',async()=>{
  const f=await fixture()
  try{
    await f.start();f.emit(nativeInfo());await f.pump();const child=await f.child('NfcA');assert.ok(child.result)
    assert.equal((await f.invoke('object:IsoDep.getHistoricalBytes',{objectId:'NfcA'})).error.code,'invalid_request')
    assert.equal((await f.invoke('object:NFCAdapter.getIsoDep',{objectId:'reader',receiverId:'reader'})).error.code,'invalid_request')
    const ndef=await f.child('Ndef');await f.invoke('object:Ndef.onNdefMessage',{objectId:'Ndef',subscriptionId:'ndef'});await f.invoke('object:Ndef.connect',{objectId:'Ndef'});const count=f.native.events().length
    f.native.cancel(ndef.callId);await f.pump();assert.equal((await f.invoke('object:Ndef.connect',{objectId:'Ndef'})).error.code,'cancelled');assert.equal(f.native.events().length,count)
  }finally{await f.stop()}
})

test('Harmony NFC enforces aggregate NDEF binary limits before writing native messages',async()=>{
  const f=await fixture()
  try{
    await f.start();f.emit(nativeInfo());await f.pump();await f.child('Ndef');await f.invoke('object:Ndef.connect',{objectId:'Ndef'})
    const record={tnf:2,type:binary([97]),id:binary([]),payload:binary(Array(600000).fill(128))}
    assert.equal((await f.invoke('object:Ndef.writeNdefMessage',{objectId:'Ndef',records:[record,record]})).error.code,'invalid_request');assert.equal(f.stats.writes.length,0)
  }finally{await f.stop()}
})
