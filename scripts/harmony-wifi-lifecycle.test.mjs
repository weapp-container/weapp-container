import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
const root=new URL('../examples/hosts/harmony/entry/src/main/ets/',import.meta.url)
const ownerSource=await readFile(new URL('session/HostServices.ts',root),'utf8')
const owner=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(ownerSource,{mode:'strip'})).toString('base64'))
const config={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:'1'}}
const policy={purpose:'配置家中设备热点',permissionVersion:'1',fullInfo:true,scan:true,connect:true}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const bssid='00:11:22:33:44:55',otherBssid='00:11:22:33:44:66'
class NativeTransport{
  commands=[];requests=[]
  hostServices(json){const c=JSON.parse(json);this.commands.push(c);if(c.operation==='protocol')return '{"version":"1.0","trustedContext":true,"ownerThreadCompletion":true}';if(c.operation==='configure')return '{"ok":true,"sessionId":"session"}';if(c.operation==='take')return JSON.stringify({requests:this.requests.splice(0)});return '{"ok":true}'}
  call(callId,method,payload={}){this.requests.push({kind:'call',callId,method,payload,context:{...config,sessionId:'session',callId,api:method}})}
  cancel(callId){this.requests.push({kind:'cancel',callId})}
  completions(){return this.commands.filter(x=>x.operation==='complete').map(x=>x.payload)}
  events(){return this.commands.filter(x=>x.operation==='event').map(x=>x.payload)}
}
async function fixture(options={}){
  const events=new Map(),permissionEvents=new Set(),grants=new Set(['ohos.permission.GET_WIFI_INFO','ohos.permission.SET_WIFI_INFO',...(options.mac===false?[]:['ohos.permission.GET_WIFI_PEERS_MAC'])])
  const stats={added:[],removed:[],connected:[],scan:0,off:[],nextId:41,existing:[],scanInfo:[{ssid:'Home',bssid,bssidType:1,rssi:-50,band:2,frequency:2412,securityType:3}],link:{ssid:'Home',bssid,rssi:-50,band:2,frequency:2412,connState:4}}
  const manager={getSelfPermissionStatus:p=>grants.has(p)?0:-1,requestPermissionsFromUser:()=>options.permission?.promise||Promise.resolve({authResults:[-1]}),on(event,permissions,callback){permissionEvents.add(callback)},off(event,permissions,callback){if(stats.permissionOffError)throw stats.permissionOffError;permissionEvents.delete(callback)}}
  const wifi={ConnState:{CONNECTED:4},WifiSecurityType:{WIFI_SEC_TYPE_INVALID:0,WIFI_SEC_TYPE_OPEN:1,WIFI_SEC_TYPE_PSK:3},DeviceAddressType:{REAL_DEVICE_ADDRESS:1},
    isWifiActive:()=>true,isConnected:()=>stats.link.connState===4,getLinkedInfoSync:()=>stats.link,getScanInfoList:()=>stats.scanInfo,getSignalLevel:()=>3,getCandidateConfigs:()=>stats.existing,
    on(event,fn){let set=events.get(event);if(!set)events.set(event,set=new Set());set.add(fn)},off(event,fn){stats.off.push([event,fn]);if(stats.offError===event)throw new Error('native off failed');events.get(event)?.delete(fn)},
    startScan(){stats.scan++;if(stats.scanError)throw stats.scanError},addCandidateConfig(config){stats.added.push(config);return options.addition?.promise||Promise.resolve(stats.nextId++)},
    connectToCandidateConfigWithUserAction(id){stats.connected.push(id);return options.action?.promise||Promise.resolve()},async removeCandidateConfig(id){stats.removed.push(id);if(stats.removeError)throw stats.removeError},
  }
  const dependencies={...owner,wifiManager:wifi,abilityAccessCtrl:{PermissionStatus:{GRANTED:0},createAtManager:()=>manager}}
  const source=(await readFile(new URL('native/HarmonyWifiApis.ets',root),'utf8')).replace(/^import .*;\n/gm,'')
  const key=`__harmonyWifi${++fixture.sequence}`;globalThis[key]=dependencies
  const module=await import('data:text/javascript;base64,'+Buffer.from(`const {HarmonyApiError,abilityAccessCtrl,wifiManager}=globalThis.${key};\n`+stripTypeScriptTypes(source,{mode:'strip'})).toString('base64'));delete globalThis[key]
  const container=(configuration=policy)=>{
    const native=new NativeTransport(),services=new owner.HarmonyHostServices(native),adapter=new module.HarmonyWifiApis({},services,configuration,()=>options.disclosure?.promise||Promise.resolve(true))
    services.configure(config,config.application.packRoot)
    const pump=async()=>{services.drain();await settle();services.drain();await settle();services.drain()}
    const start=async()=>{native.call('start','wx.startWifi');await pump();assert.equal(native.completions().find(x=>x.callId==='start').result.errMsg,'startWifi:ok')}
    return{native,services,adapter,pump,start}
  }
  const emit=(event,value)=>{for(const fn of [...events.get(event)||[]])fn(value)}
  return{...container(),container,stats,events,permissionEvents,grants,emit,module}
}
fixture.sequence=0

test('Harmony Wi-Fi default is uninstalled, real grants do not manufacture BSSID and partial events contain only SSID',async()=>{
  const f=await fixture({mac:false});assert.equal(f.module.installHarmonyWifiApis({},f.services,{}),null);await f.start()
  f.native.call('partial','wx.onWifiConnectedWithPartialInfo',{subscriptionId:'partial'});f.native.call('get','wx.getConnectedWifi',{partialInfo:true});await f.pump()
  const failure=f.native.completions().find(x=>x.callId==='get').error;assert.equal(failure.code,'permission_denied');assert.equal(failure.details.errCode,201)
  f.emit('wifiConnectionChange',1);assert.equal(f.native.events().length,0);await f.pump();assert.deepEqual(f.native.events().at(-1).value,{wifi:{SSID:'Home'}})
  f.services.revoke();await f.services.waitForDrain();assert.equal(f.permissionEvents.size,0)
})
test('Harmony Wi-Fi returns authentic full metadata and never invents missing network security',async()=>{
  const f=await fixture();await f.start();f.native.call('get','wx.getConnectedWifi');await f.pump()
  assert.deepEqual(f.native.completions().find(x=>x.callId==='get').result.wifi,{SSID:'Home',BSSID:bssid,frequency:2412,secure:true,signalStrength:75})
  f.stats.scanInfo=[];f.native.call('missing','wx.getConnectedWifi');f.native.call('partial','wx.getConnectedWifi',{partialInfo:true});await f.pump()
  assert.equal(f.native.completions().find(x=>x.callId==='missing').error.details.errCode,12010);assert.deepEqual(f.native.completions().find(x=>x.callId==='partial').result.wifi,{SSID:'Home',BSSID:bssid})
  f.services.revoke();await f.services.waitForDrain()
})
test('Harmony Wi-Fi pending disclosure and OS permission remain part of native drain after account revocation',async()=>{
  const disclosure=deferred(),f=await fixture({disclosure});f.native.call('start','wx.startWifi');await f.pump();f.services.revoke();let drained=false;const drain=f.services.waitForDrain().then(()=>drained=true);await settle();assert.equal(drained,false)
  disclosure.resolve(true);await drain;assert.equal([...f.events.values()].flatMap(x=>[...x]).length,0)
  const permission=deferred(),p=await fixture({mac:false,permission});await p.start();p.native.call('get','wx.getConnectedWifi');await p.pump();p.services.revoke();let done=false;const barrier=p.services.waitForDrain().then(()=>done=true);await settle();assert.equal(done,false);permission.resolve({authResults:[0]});await barrier;assert.equal(p.native.completions().some(x=>x.callId==='get'),false)
})
test('Harmony Wi-Fi scans wait native terminal; cancellation keeps the exact scanner lease until that terminal',async()=>{
  const f=await fixture(),other=f.container();await f.start();await other.start();f.native.call('listen','wx.onGetWifiList',{subscriptionId:'list'});f.native.call('scan','wx.getWifiList');await f.pump();assert.equal(f.stats.scan,1);assert.equal(f.native.completions().some(x=>x.callId==='scan'),false)
  const old=[...f.events.get('wifiScanStateChange')][0];f.native.cancel('scan');await f.pump();let drained=false;const drain=f.services.waitForDrain().then(()=>drained=true);await settle();assert.equal(drained,false)
  other.native.call('busy','wx.getWifiList');await other.pump();assert.equal(other.native.completions().find(x=>x.callId==='busy').error.details.errCode,12004)
  old(1);await drain;await f.pump();assert.equal(f.native.events().length,0);assert.equal(f.events.get('wifiScanStateChange').size,0)
  f.services.revoke();other.services.revoke();await Promise.all([f.services.waitForDrain(),other.services.waitForDrain()])
})
test('Harmony Wi-Fi scan terminal emits real records and exact off failure is retried without restarting the scan',async()=>{
  const f=await fixture();await f.start();f.native.call('listen','wx.onGetWifiList',{subscriptionId:'list'});f.native.call('scan','wx.getWifiList');await f.pump();f.stats.offError='wifiScanStateChange';f.emit('wifiScanStateChange',1);await f.pump()
  assert.deepEqual(f.native.events().at(-1).value.wifiList,[{SSID:'Home',BSSID:bssid,frequency:2412,secure:true,signalStrength:75}]);assert.equal(f.native.completions().find(x=>x.callId==='scan').result.errMsg,'getWifiList:ok')
  f.services.revoke();await assert.rejects(f.services.waitForDrain(),/release|resources/);f.stats.offError=null;await f.services.retryResourceCleanup();assert.equal(f.stats.scan,1);assert.equal(f.events.get('wifiScanStateChange').size,0)
})
test('Harmony Wi-Fi late candidate acquisition waits exact removal and cannot connect after cancellation',async()=>{
  const addition=deferred(),f=await fixture({addition});await f.start();f.native.call('connect','wx.connectWifi',{SSID:'Home',password:'password'});await f.pump();assert.equal(f.stats.added.length,1)
  f.native.cancel('connect');await f.pump();let done=false;const drain=f.services.waitForDrain().then(()=>done=true);await settle();assert.equal(done,false);addition.resolve(73);await drain
  assert.deepEqual(f.stats.removed,[73]);assert.deepEqual(f.stats.connected,[]);assert.equal(f.native.completions().some(x=>x.callId==='connect'),false);f.services.revoke();await f.services.waitForDrain()
})
test('Harmony Wi-Fi native user response plus target connection are required; OS response is retained through cancel',async()=>{
  const action=deferred(),f=await fixture({action});await f.start();f.stats.link={...f.stats.link,ssid:'Other',bssid:otherBssid};f.native.call('connect','wx.connectWifi',{SSID:'Home',password:'password'});await f.pump();assert.deepEqual(f.stats.connected,[41]);f.emit('wifiConnectionChange',1);await f.pump();assert.equal(f.native.completions().some(x=>x.callId==='connect'),false)
  action.resolve();await f.pump();assert.equal(f.native.completions().some(x=>x.callId==='connect'),false);f.stats.link={...f.stats.link,ssid:'Home',bssid};f.emit('wifiConnectionChange',1);await f.pump();assert.equal(f.native.completions().find(x=>x.callId==='connect').result.errMsg,'connectWifi:ok')
  f.services.revoke();await f.services.waitForDrain();assert.deepEqual(f.stats.removed,[41])
  const pending=deferred(),p=await fixture({action:pending});await p.start();p.native.call('connect','wx.connectWifi',{SSID:'Home',password:'password'});await p.pump();p.services.revoke();let done=false;const drain=p.services.waitForDrain().then(()=>done=true);await settle();assert.equal(done,false);assert.deepEqual(p.stats.removed,[]);pending.resolve();await drain;assert.deepEqual(p.stats.removed,[41])
})
test('Harmony Wi-Fi never adopts existing host candidates; failed exact removal remains retryable',async()=>{
  const f=await fixture();await f.start();f.stats.existing=[{ssid:'Home',netId:7}];f.native.call('existing','wx.connectWifi',{SSID:'Home',password:'password'});await f.pump();assert.equal(f.stats.added.length,0);assert.equal(f.native.completions().find(x=>x.callId==='existing').error.details.errCode,12004)
  f.stats.existing=[];f.native.call('connect','wx.connectWifi',{SSID:'Home',password:'password'});await f.pump();f.stats.removeError=new Error('remove exact candidate failed');f.services.revoke();await assert.rejects(f.services.waitForDrain(),/release|resources/);assert.ok(f.stats.removed.every(id=>id===41));f.stats.removeError=null;await f.services.retryResourceCleanup();assert.equal(f.events.get('wifiConnectionChange').size,0)
})
test('Harmony Wi-Fi event generations reject queued/late native callbacks after background and queue pressure stops ingress',async()=>{
  const f=await fixture();await f.start();f.native.call('listen','wx.onWifiConnectedWithPartialInfo',{subscriptionId:'partial'});await f.pump();const old=[...f.events.get('wifiConnectionChange')][0];old(1);f.services.setForeground(false);await settle();f.services.setForeground(true);await f.pump();assert.equal(f.native.events().length,0)
  f.native.call('restart','wx.startWifi');await f.pump();old(1);await f.pump();assert.equal(f.native.events().length,0)
  f.services.emit=()=>false;f.emit('wifiConnectionChange',1);await settle();assert.equal(f.events.get('wifiConnectionChange').size,0);f.services.revoke();await f.services.waitForDrain()
})
test('Harmony Wi-Fi permission revocation tears down native ingress and privacy aliases never become scan BSSIDs',async()=>{
  const f=await fixture();await f.start();f.native.call('scan','wx.getWifiList');await f.pump();f.stats.scanInfo[0].bssidType=0;f.emit('wifiScanStateChange',1);await f.pump();assert.equal(f.native.completions().find(x=>x.callId==='scan').error.code,'permission_denied')
  f.grants.delete('ohos.permission.GET_WIFI_INFO');for(const fn of [...f.permissionEvents])fn();await settle();assert.equal(f.events.get('wifiConnectionChange').size,0);f.services.revoke();await f.services.waitForDrain()
})

test('Harmony Wi-Fi full metadata rejects privacy address types even when native permission status says granted',async()=>{
  const f=await fixture();await f.start();f.stats.scanInfo[0].bssidType=0;f.native.call('get','wx.getConnectedWifi');await f.pump();assert.equal(f.native.completions().find(x=>x.callId==='get').error.details.errCode,12010)
  f.services.revoke();await f.services.waitForDrain()
})
test('Harmony Wi-Fi queued values are tied to the exact subscription object, not a reused subscription ID',async()=>{
  const f=await fixture();await f.start();f.native.call('old','wx.onWifiConnectedWithPartialInfo',{subscriptionId:'reused'});await f.pump();const gates=[];f.services.emit=(...args)=>{gates.push(args[6]);return true}
  f.emit('wifiConnectionChange',1);assert.equal(gates[0](),true)
  f.native.call('off','wx.offWifiConnectedWithPartialInfo',{subscriptionId:'reused'});f.native.call('new','wx.onWifiConnectedWithPartialInfo',{subscriptionId:'reused'});await f.pump();assert.equal(gates[0](),false)
  f.emit('wifiConnectionChange',1);assert.equal(gates.at(-1)(),true);f.services.revoke();await f.services.waitForDrain();assert.equal(gates.at(-1)(),false)
})
test('Harmony Wi-Fi concurrent closes share the exact pending native release and consume successful stages once',async()=>{
  const action=deferred(),f=await fixture({action});await f.start();f.native.call('connect','wx.connectWifi',{SSID:'Home',password:'password'});await f.pump()
  const first=f.adapter.close(),second=f.adapter.close();assert.equal(first,second);await settle();assert.equal(f.stats.off.filter(x=>x[0]==='wifiConnectionChange').length,1);assert.deepEqual(f.stats.removed,[])
  action.resolve();await Promise.all([first,second]);assert.deepEqual(f.stats.removed,[41]);await f.adapter.close();assert.deepEqual(f.stats.removed,[41]);f.services.revoke();await f.services.waitForDrain()
})
