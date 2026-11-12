import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'

// Execute production ArkTS adapters with finite native-event instrumentation.
// These tests cover cancellation/lifetime protocol, never device acceptance.
const session=await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/session/HostServices.ts',import.meta.url),'utf8')
const ownerModule=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(session,{mode:'strip'})).toString('base64'))
const config={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:'1'}}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
class NativeTransport {
  commands=[];requests=[]
  hostServices(json){const command=JSON.parse(json);this.commands.push(command);if(command.operation==='protocol')return JSON.stringify({version:'1.0',trustedContext:true,ownerThreadCompletion:true});if(command.operation==='configure')return JSON.stringify({ok:true,sessionId:'session'});if(command.operation==='take')return JSON.stringify({requests:this.requests.splice(0)});return '{"ok":true}'}
  call(id,method,payload){this.requests.push({kind:'call',callId:id,method,payload,context:{...config,sessionId:'session',callId:id,api:method}})}
  completions(){return this.commands.filter(command=>command.operation==='complete').map(command=>command.payload)}
}
let loadSequence=0
async function load(name,dependencies){
  const source=(await readFile(new URL(`../examples/hosts/harmony/entry/src/main/ets/native/${name}.ets`,import.meta.url),'utf8')).replace(/^import .*;\n/gm,'')
  const key=`harmony_${name}_${++loadSequence}`;globalThis[key]={...ownerModule,...dependencies}
  const bindings=`const { HarmonyHostServices,HarmonyApiError,http,url,util,webSocket,abilityAccessCtrl,userAuth,contact,calendarManager,image,sensor,window,promptAction }=globalThis.${key};\n`
  return import('data:text/javascript;base64,'+Buffer.from(bindings+stripTypeScriptTypes(source,{mode:'strip'})).toString('base64'))
}
class HttpTask {
  events=new Map();destroyed=0
  on(name,callback){this.events.set(name,callback)}
  requestInStream(){return new Promise(()=>{})}
  destroy(){this.destroyed++}
}
const tasks=[]
const {HarmonyNetworkApis}=await load('HarmonyNetworkApis',{url:{URL},http:{createHttp(){const task=new HttpTask();tasks.push(task);return task},RequestMethod:{GET:'GET',POST:'POST',PUT:'PUT',DELETE:'DELETE',HEAD:'HEAD',OPTIONS:'OPTIONS'},HttpDataType:{ARRAY_BUFFER:'arraybuffer'}}})
class Socket {
  events=new Map();closed=0
  constructor(){this.connected=new Promise(resolve=>this.finishConnect=resolve)}
  on(name,callback){this.events.set(name,callback)}
  connect(){return this.connected}
  async close(){this.closed++;return true}
}
const sockets=[]
const {HarmonySocketApis}=await load('HarmonySocketApis',{url:{URL},webSocket:{createWebSocket(){const socket=new Socket();sockets.push(socket);return socket}}})

test('Harmony abort settles an original native HTTP stream even when destroy never resolves requestInStream',async()=>{
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native)
  new HarmonyNetworkApis(services,{},['https://allowed.test']);services.configure(config,config.application.packRoot)
  native.call('request','wx.request',{objectId:'task',url:'https://allowed.test/data'});services.drain();await settle();assert.equal(tasks.length,1)
  native.call('abort','object:RequestTask.abort',{objectId:'task'});services.drain();await settle();services.drain()
  const results=native.completions();assert.equal(results.filter(result=>result.callId==='request').length,1);assert.equal(results.find(result=>result.callId==='request').error.code,'cancelled');assert.equal(tasks[0].destroyed,1)
  services.revoke();await services.waitForDrain();assert.equal(tasks[0].destroyed,1)
})
test('Harmony HTTP origins default to deny and a response quota stops the actual producer',async()=>{
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native)
  new HarmonyNetworkApis(services,{});services.configure(config,config.application.packRoot)
  native.call('denied','wx.request',{objectId:'denied',url:'https://allowed.test/data'});services.drain();await settle();services.drain();assert.equal(native.completions()[0].error.code,'permission_denied')
  services.revoke();await services.waitForDrain()
  const next=new NativeTransport(),allowed=new ownerModule.HarmonyHostServices(next);new HarmonyNetworkApis(allowed,{},['https://allowed.test']);allowed.configure(config,config.application.packRoot)
  next.call('large','wx.request',{objectId:'large',url:'https://allowed.test/data'});allowed.drain();await settle();const task=tasks.at(-1);task.events.get('dataReceive')(new ArrayBuffer(1024*1024+1));await settle();allowed.drain();assert.equal(task.destroyed,1);assert.match(next.completions()[0].error.message,/byte limit/)
  allowed.revoke();await allowed.waitForDrain()
})
test('Harmony a socket acquired after revocation cannot publish Open and its real close gates drain',async()=>{
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native)
  new HarmonySocketApis(services,['wss://allowed.test']);services.configure(config,config.application.packRoot)
  native.call('connect','wx.connectSocket',{objectId:'socket',url:'wss://allowed.test/path'});native.call('listen','object:SocketTask.onOpen',{objectId:'socket',subscriptionId:'open'});services.drain();await settle();services.drain()
  const socket=sockets.at(-1);services.revoke();let drained=false;const draining=services.waitForDrain().then(()=>drained=true);await settle();assert.equal(drained,false);assert.equal(socket.closed,0)
  socket.events.get('open')(undefined,{});socket.finishConnect(true);await draining;assert.equal(socket.closed,1);assert.equal(native.commands.filter(command=>command.operation==='event').length,0)
})

test('Harmony app permission snapshots preserve undetermined and reduced-accuracy grants and refresh on foreground',async()=>{
  const permissions=new Map([['ohos.permission.CAMERA',1],['ohos.permission.MICROPHONE',-1],['ohos.permission.LOCATION',-1],['ohos.permission.APPROXIMATELY_LOCATION',0]])
  const {HarmonyDeviceApis}=await load('HarmonyDeviceApis',{abilityAccessCtrl:{createAtManager(){return {getSelfPermissionStatus(name){return permissions.get(name)??2}}},PermissionStatus:{GRANTED:0,DENIED:-1,NOT_DETERMINED:1,INVALID:2,RESTRICTED:3}}})
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native)
  new HarmonyDeviceApis({},services);services.configure(config,config.application.packRoot)
  const initial=native.commands.find(command=>command.operation==='configure').payload.syncValues['wx.getAppAuthorizeSetting']
  assert.deepEqual(initial,{cameraAuthorized:'not determined',microphoneAuthorized:'denied',locationAuthorized:'authorized',locationReducedAccuracy:true})
  permissions.set('ohos.permission.LOCATION',0);services.setForeground(true)
  assert.equal(native.commands.findLast(command=>command.operation==='snapshots').payload['wx.getAppAuthorizeSetting'].locationReducedAccuracy,false)
  services.revoke();await services.waitForDrain();assert.throws(()=>services.updateSyncSnapshots({}),/retired/)
})

const devicePermissions={createAtManager:()=>({getSelfPermissionStatus:()=>2}),PermissionStatus:{GRANTED:0,DENIED:-1,NOT_DETERMINED:1,INVALID:2,RESTRICTED:3}}
async function deviceFixture(dependencies={}) {
  const {HarmonyDeviceApis}=await load('HarmonyDeviceApis',{abilityAccessCtrl:devicePermissions,...dependencies})
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native),adapter=new HarmonyDeviceApis({},services)
  services.configure(config,config.application.packRoot)
  const pump=async()=>{services.drain();await settle();services.drain()}
  return {native,services,adapter,pump}
}
test('Harmony failed sensor stop keeps the exact resource for retry and gates every old callback',async()=>{
  const listeners=[],stopped=[];let fail=true
  const f=await deviceFixture({sensor:{SensorId:{ACCELEROMETER:1},on(id,listener){listeners.push(listener)},off(id,listener){stopped.push(listener);if(fail)throw new Error('sensor off failed')}}})
  f.native.call('listen','wx.onAccelerometerChange',{subscriptionId:'motion'});f.native.call('start','wx.startAccelerometer',{});await f.pump()
  listeners[0]({x:9.80665,y:0,z:0});await f.pump();assert.equal(f.native.commands.filter(c=>c.operation==='event').length,1)
  f.native.call('stop','wx.stopAccelerometer',{});await f.pump();assert.equal(f.native.completions().find(c=>c.callId==='stop').error.code,'invalid_request')
  listeners[0]({x:9.80665,y:0,z:0});await f.pump();assert.equal(f.native.commands.filter(c=>c.operation==='event').length,1)
  f.native.call('blocked','wx.startAccelerometer',{});await f.pump();assert.equal(listeners.length,1)
  assert.throws(()=>f.services.revoke(),/cleanup/);await assert.rejects(f.services.waitForDrain(),/failed/)
  fail=false;await f.services.retryResourceCleanup();assert.ok(stopped.length>=4);assert.ok(stopped.every(listener=>listener===listeners[0]))
})
test('Harmony sensor stop and restart cannot route a queued old sample to replacement subscriptions',async()=>{
  const listeners=[],stopped=[]
  const f=await deviceFixture({sensor:{SensorId:{GYROSCOPE:2},on(id,listener){listeners.push(listener)},off(id,listener){stopped.push(listener)}}})
  f.native.call('listen','wx.onGyroscopeChange',{subscriptionId:'motion'});f.native.call('first','wx.startGyroscope',{});await f.pump()
  f.native.call('stop','wx.stopGyroscope',{});f.native.call('second','wx.startGyroscope',{});await f.pump()
  listeners[0]({x:1,y:2,z:3});listeners[1]({x:4,y:5,z:6});await f.pump()
  const events=f.native.commands.filter(c=>c.operation==='event');assert.equal(events.length,1);assert.deepEqual(events[0].payload.value,{x:4,y:5,z:6})
  f.native.requests.push({kind:'cancel',callId:'first'});await f.pump();assert.equal(stopped.length,1)
  f.services.revoke();await f.services.waitForDrain();assert.equal(stopped.length,2)
})
test('Harmony a sensor sample queued before hide cannot enter JS after the producer is retired',async()=>{
  const listeners=[]
  const f=await deviceFixture({sensor:{SensorId:{GYROSCOPE:2},on(id,listener){listeners.push(listener)},off(){}}})
  f.native.call('listen','wx.onGyroscopeChange',{subscriptionId:'motion'});f.native.call('start','wx.startGyroscope',{});await f.pump()
  listeners[0]({x:1,y:2,z:3});f.services.setForeground(false);f.services.setForeground(true);await f.pump()
  assert.equal(f.native.commands.filter(c=>c.operation==='event').length,0)
  f.services.revoke();await f.services.waitForDrain()
})

test('Harmony screen mutations serialize and failed restore retains each exact native target',async()=>{
  const writes=[],keeps=[];let finish,fail=true
  const target={getWindowProperties:()=>({brightness:0.35,isKeepScreenOn:false}),setWindowBrightness(value){writes.push(value);if(value===0.7)return new Promise(resolve=>finish=resolve);if(value===0.35&&fail)return Promise.reject(new Error('brightness restore failed'));return Promise.resolve()},setWindowKeepScreenOn(value){keeps.push(value);return !value&&fail?Promise.reject(new Error('keep restore failed')):Promise.resolve()}}
  const f=await deviceFixture({window:{getLastWindow:async()=>target}})
  f.native.call('first','wx.setScreenBrightness',{value:0.7});f.native.call('second','wx.setScreenBrightness',{value:0.9});f.native.call('keep','wx.setKeepScreenOn',{keepScreenOn:true});await f.pump();assert.deepEqual(writes,[0.7])
  finish();await f.pump();assert.deepEqual(writes,[0.7,0.9]);assert.deepEqual(keeps,[true])
  f.services.revoke();await assert.rejects(f.services.waitForDrain(),/failed/);assert.equal(writes.at(-1),0.35);assert.equal(keeps.at(-1),false)
  fail=false;await f.services.retryResourceCleanup();assert.deepEqual(writes,[0.7,0.9,0.35,0.35]);assert.deepEqual(keeps,[true,false,false])
})
test('Harmony account retirement waits for an in-flight window mutation and restores after its real terminal',async()=>{
  const writes=[];let finish
  const target={getWindowProperties:()=>({brightness:0.25}),setWindowBrightness(value){writes.push(value);return value===0.8?new Promise(resolve=>finish=resolve):Promise.resolve()}}
  const f=await deviceFixture({window:{getLastWindow:async()=>target}})
  f.native.call('pending','wx.setScreenBrightness',{value:0.8});await f.pump();f.services.revoke()
  let drained=false;const done=f.services.waitForDrain().then(()=>drained=true);await settle();assert.equal(drained,false);assert.deepEqual(writes,[0.8])
  finish();await done;assert.deepEqual(writes,[0.8,0.25]);assert.equal(f.native.completions().length,0)
})
test('Harmony late native toast creation closes its exact id and failed dismissal blocks retirement until retry',async()=>{
  const closed=[];let finish,fail=true
  const f=await deviceFixture({promptAction:{openToast(){return new Promise(resolve=>finish=resolve)},closeToast(id){closed.push(id);if(fail)throw new Error('native toast close failed')}}})
  f.native.call('toast','wx.showToast',{title:'Old account'});await f.pump();f.services.revoke()
  let drained=false;const done=f.services.waitForDrain().finally(()=>drained=true);await settle();assert.equal(drained,false)
  finish(41);await assert.rejects(done,/failed/);assert.deepEqual(closed,[41,41]);assert.equal(f.native.completions().length,0)
  fail=false;await f.services.retryResourceCleanup();assert.deepEqual(closed,[41,41,41])
})

test('Harmony biometric capability and enrollment reflect native hardware status without fabricating SOTER signatures',async()=>{
  const nativeError=code=>Object.assign(new Error(`native ${code}`),{code})
  const {HarmonyDeviceApis}=await load('HarmonyDeviceApis',{abilityAccessCtrl:{createAtManager(){return {getSelfPermissionStatus(){return 2}}},PermissionStatus:{GRANTED:0,DENIED:-1,NOT_DETERMINED:1,INVALID:2,RESTRICTED:3}},userAuth:{UserAuthType:{FINGERPRINT:4,FACE:2},AuthTrustLevel:{ATL1:10000},getAvailableStatus(mode){throw nativeError(mode===4?12500010:12500005)},getEnrolledState(mode){throw nativeError(mode===4?12500010:12500005)}}})
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native);new HarmonyDeviceApis({},services);services.configure(config,config.application.packRoot)
  native.call('support','wx.checkIsSupportSoterAuthentication',{});native.call('unenrolled','wx.checkIsSoterEnrolledInDevice',{checkAuthMode:'fingerPrint'});native.call('unsupported','wx.checkIsSoterEnrolledInDevice',{checkAuthMode:'facial'});services.drain();await settle();services.drain()
  const results=native.completions();assert.deepEqual(results.find(result=>result.callId==='support').result.supportMode,['fingerPrint']);assert.equal(results.find(result=>result.callId==='unenrolled').result.isEnrolled,false);assert.equal(results.find(result=>result.callId==='unsupported').error.code,'unsupported');assert.equal(services.supportedApis().includes('wx.startSoterAuthentication'),false)
  services.revoke();await services.waitForDrain()
})

test('Harmony system picker keeps retirement blocked until the actual native UI returns and discards its old-account result',async()=>{
  let finish,started=false
  const {HarmonySystemApis}=await load('HarmonySystemApis',{contact:{selectContacts(){started=true;return new Promise(resolve=>finish=resolve)}}})
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native);new HarmonySystemApis({},services,{})
  services.configure(config,config.application.packRoot);native.call('choose','wx.chooseContact',{});services.drain();await settle();assert.equal(started,true)
  services.revoke();let drained=false;const draining=services.waitForDrain().then(()=>drained=true);await settle();assert.equal(drained,false)
  finish([{name:{fullName:'Old account'},phoneNumbers:[{phoneNumber:'+123'}]}]);await draining
  assert.equal(native.completions().length,0)
})

test('Harmony user-owned contact UI may temporarily background its ability without fabricating permission grants',async()=>{
  let finish
  const {HarmonySystemApis}=await load('HarmonySystemApis',{contact:{selectContacts(options){assert.deepEqual(options,{isMultiSelect:false});return new Promise(resolve=>finish=resolve)}}})
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native);new HarmonySystemApis({},services,{})
  services.configure(config,config.application.packRoot);native.call('choose','wx.chooseContact',{});services.drain();await settle()
  services.setForeground(false);finish([{name:{fullName:'Selected contact'},phoneNumbers:[{phoneNumber:'+123'},{phoneNumber:'+123'},{phoneNumber:'+456'}]}]);await settle();services.drain()
  assert.deepEqual(native.completions()[0].result,{errMsg:'chooseContact:ok',displayName:'Selected contact',phoneNumber:'+123',phoneNumberList:['+123','+456']})
  native.call('hidden','wx.chooseContact',{});services.drain();await settle();services.drain();assert.equal(native.completions().at(-1).error.code,'permission_denied')
  services.revoke();await services.waitForDrain()
})

test('Harmony calendar editor converts seconds, reminders and recurrence while rejecting unsupported signed WeChat links before system UI',async()=>{
  const events=[],context={host:true}
  const {HarmonySystemApis}=await load('HarmonySystemApis',{calendarManager:{EventType:{NORMAL:0},RecurrenceFrequency:{DAILY:3,WEEKLY:2,MONTHLY:1,YEARLY:0},getCalendarManager(value){assert.equal(value,context);return {async editEvent(event){events.push(event);return 7}}}}})
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native);new HarmonySystemApis(context,services,{})
  services.configure(config,config.application.packRoot)
  native.call('calendar','wx.addPhoneRepeatCalendar',{title:'Meeting',startTime:1767225600,endTime:'1767229200',alarmOffset:120,repeatInterval:'week',repeatEndTime:1798761600,location:'Office'})
  native.call('link','wx.addPhoneCalendar',{title:'Signed',startTime:1767225600,path:'pages/index',signature:'unverified'})
  services.drain();await settle();services.drain()
  assert.equal(events.length,1);assert.equal(events[0].startTime,1767225600000);assert.equal(events[0].endTime,1767229200000)
  assert.deepEqual(events[0].reminderTime,[2]);assert.deepEqual(events[0].recurrenceRule,{recurrenceFrequency:2,interval:1,expire:1798761600000});assert.deepEqual(events[0].location,{location:'Office'})
  // The editor is serialized; repeat after the first real UI finishes.
  native.call('link2','wx.addPhoneCalendar',{title:'Signed',startTime:1767225600,path:'pages/index',signature:'unverified'});services.drain();await settle();services.drain()
  assert.equal(native.completions().find(value=>value.callId==='link2').error.code,'unsupported');assert.equal(events.length,1)
  native.call('lossy','wx.addPhoneCalendar',{title:'Alarm',startTime:1767225600,alarmOffset:1});services.drain();await settle();services.drain()
  assert.equal(native.completions().find(value=>value.callId==='lossy').error.code,'unsupported');assert.equal(events.length,1)
  services.revoke();await services.waitForDrain()
})

test('Harmony contact editor uses explicit native UI and preserves native cancel codes',async()=>{
  let value
  const {HarmonySystemApis}=await load('HarmonySystemApis',{contact:{async addContactViaUI(context,contact){value=contact;throw Object.assign(new Error('User cancel'),{code:16700103})}}})
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native);new HarmonySystemApis({},services,{})
  services.configure(config,config.application.packRoot)
  native.call('add','wx.addPhoneContact',{firstName:'Ada',lastName:'Lovelace',mobilePhoneNumber:'+123',weChatNumber:'chosen-id',homeAddressCity:'London',organization:'Work',title:'Engineer'})
  services.drain();await settle();services.drain()
  assert.deepEqual(value.name,{fullName:'Ada Lovelace',givenName:'Ada',familyName:'Lovelace',middleName:''})
  assert.deepEqual(value.phoneNumbers,[{phoneNumber:'+123',labelName:'mobile'}]);assert.deepEqual(value.imAddresses,[{imAddress:'chosen-id',labelName:'WeChat'}]);assert.equal(value.postalAddresses[0].city,'London')
  const error=native.completions()[0].error;assert.equal(error.code,'cancelled');assert.equal(error.details.errCode,16700103);assert.equal(error.details.errMsg,'addPhoneContact:fail User cancel')
  services.revoke();await services.waitForDrain()
})

test('Harmony photo acquisition returning after revocation releases the real decoder before drain and never opens an editor',async()=>{
  let finishInfo,released=0,opened=0
  const {HarmonySystemApis}=await load('HarmonySystemApis',{image:{createImageSource(buffer){assert.equal(buffer.byteLength,4);return {getImageInfo(){return new Promise(resolve=>finishInfo=resolve)},async release(){released++}}}},contact:{async addContactViaUI(){opened++;return 1}}})
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native);new HarmonySystemApis({},services,{readUpload(path){assert.equal(path,'wxfile://user/photo');return new Uint8Array([1,2,3,4])}})
  services.configure(config,config.application.packRoot);native.call('photo','wx.addPhoneContact',{firstName:'Photo',photoFilePath:'wxfile://user/photo'});services.drain();await settle()
  services.revoke();let drained=false;const draining=services.waitForDrain().then(()=>drained=true);await settle();assert.equal(drained,false)
  finishInfo({size:{width:2,height:2}});await draining;assert.equal(released,1);assert.equal(opened,0)
})

test('Harmony a failed photo release retains its exact decoder for real cleanup retry without a permanent rejected barrier',async()=>{
  let finishUI,released=0,sourcesReleased=0,fail=true
  const pixels={async release(){released++;if(fail)throw new Error('native image release failed')}}
  const {HarmonySystemApis}=await load('HarmonySystemApis',{image:{createImageSource(){return {async getImageInfo(){return {size:{width:2,height:2}}},async createPixelMap(){return pixels},async release(){sourcesReleased++}}}},contact:{addContactViaUI(){return new Promise(resolve=>finishUI=resolve)}}})
  const native=new NativeTransport(),services=new ownerModule.HarmonyHostServices(native);new HarmonySystemApis({},services,{readUpload(){return new Uint8Array([1])}})
  services.configure(config,config.application.packRoot);native.call('photo','wx.addPhoneContact',{firstName:'Photo',photoFilePath:'wxfile://user/photo'});services.drain();await settle()
  services.revoke();finishUI(1);await assert.rejects(services.waitForDrain(),/native resources failed to stop/);assert(released>=1);assert.equal(sourcesReleased,0);assert.equal(native.completions().length,0)
  const attempts=released;fail=false;await services.retryResourceCleanup();await services.waitForDrain();assert.equal(released,attempts+1);assert.equal(sourcesReleased,1)
  await services.retryResourceCleanup();assert.equal(sourcesReleased,1);assert.equal(native.completions().length,0)
})
