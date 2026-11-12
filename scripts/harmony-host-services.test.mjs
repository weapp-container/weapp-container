import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

// Executes the actual platform-independent ArkTS owner queue. The finite N-API
// transport tests protocol/lifecycle only and is not device acceptance evidence.
const source=await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/session/HostServices.ts',import.meta.url),'utf8')
const {HarmonyHostServices,HarmonyApiError}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source,{mode:'strip'})).toString('base64'))
const trusted={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:'9007199254740993'}}
class NativeTransport {
  requests=[];commands=[]
  hostServices(json){const command=JSON.parse(json);this.commands.push(command);if(command.operation==='protocol')return '{"version":"1.0","trustedContext":true,"ownerThreadCompletion":true}';if(command.operation==='take')return JSON.stringify({requests:this.requests.splice(0)});if(command.operation==='configure')return JSON.stringify({ok:true,sessionId:'session'});return command.operation==='complete'||command.operation==='event'?'{"batch":{"messages":[]}}':'{"ok":true}'}
  call(callId,method,payload={},context={}){this.requests.push({kind:'call',callId,method,payload,context:{...trusted,sessionId:'session',api:method,callId,...context}})}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
test('Harmony native completions preserve trusted u64 scope and raw errors only at owner drain',async()=>{
  const native=new NativeTransport(),services=new HarmonyHostServices(native)
  let context
  services.registerApiHandler('wx.login',async(payload,call)=>{context=call.context;return {code:'explicit-handler-code'}})
  services.registerApiHandler('wx.requestPayment',async()=>{throw new HarmonyApiError('permission_denied','denied',7001,'requestPayment:fail denied')})
  services.configure(trusted,trusted.application.packRoot)
  native.call('login','wx.login');native.call('pay','wx.requestPayment');services.drain();await settle()
  assert.equal(native.commands.filter(command=>command.operation==='complete').length,0)
  services.drain();assert.equal(context.account.epoch,'9007199254740993')
  const completed=native.commands.filter(command=>command.operation==='complete')
  assert.equal(completed[0].payload.result.code,'explicit-handler-code')
  assert.deepEqual(completed[1].payload.error.details,{errCode:7001,errMsg:'requestPayment:fail denied'})
  services.revoke();await services.waitForDrain()
})
test('Harmony stale account cannot enter an adapter and subscription callbacks only enqueue',async()=>{
  const native=new NativeTransport(),services=new HarmonyHostServices(native);let invoked=0,context
  services.registerApiHandler('wx.login',async()=>{invoked++;return {code:'never'}})
  services.registerApiHandler('wx.onAccelerometerChange',async(payload,call)=>{context=call.context;call.cancellation.retainUntilCancelled();return {}})
  services.configure(trusted,trusted.application.packRoot)
  native.call('stale','wx.login',{}, {account:{principalId:'bob',epoch:'9007199254740994'}})
  native.call('listen','wx.onAccelerometerChange',{subscriptionId:'sensor'})
  services.drain();await settle();services.drain();assert.equal(invoked,0)
  assert.equal(services.emit(context,'sensor',1,'AccelerometerChange',{x:1,y:2,z:3}),true)
  assert.equal(native.commands.some(command=>command.operation==='event'),false)
  services.drain();assert.equal(native.commands.filter(command=>command.operation==='event').length,1)
  services.revoke();assert.equal(services.emit(context,'sensor',2,'AccelerometerChange',{}),false)
})
test('Harmony revocation blocks immediately and waits the actual asynchronous device release barrier',async()=>{
  const native=new NativeTransport(),services=new HarmonyHostServices(native);let release,released=false
  const gate=new Promise(resolve=>release=resolve)
  services.registerApiHandler('wx.setKeepScreenOn',async(payload,call)=>{call.cancellation.retainUntilCancelled();call.cancellation.onCancel(async()=>{await gate;released=true});return {}})
  services.configure(trusted,trusted.application.packRoot);native.call('lock','wx.setKeepScreenOn');services.drain();await settle()
  services.revoke();let drained=false;const drain=services.waitForDrain().then(()=>drained=true)
  await settle();assert.equal(drained,false);assert.equal(released,false);assert.deepEqual(services.drain(),[])
  release();await drain;assert.equal(released,true);assert.equal(drained,true)
})

test('Harmony native filesystem root and sync declarations precede configure and stale incarnations cannot access disk',async()=>{
  const native=new NativeTransport(),services=new HarmonyHostServices(native);let invoked=0
  services.setManagedFilesRoot('/private/host/managed')
  services.declareNativeApi('object:FileSystemManager.readFileSync')
  services.registerApiHandler('wx.login',async(payload,call)=>{invoked++;services.managedFile(call.context,'object:FileSystemManager.access',{path:'wxfile://user/'});return {code:'scoped'}})
  services.configure(trusted,trusted.application.packRoot)
  const root=native.commands.findIndex(command=>command.operation==='managedFilesRoot'),configure=native.commands.findIndex(command=>command.operation==='configure')
  assert.ok(root<configure);assert.ok(native.commands[configure].payload.apis.includes('object:FileSystemManager.readFileSync'))
  native.call('old','wx.login',{}, {sessionId:'previous-incarnation'})
  native.call('new','wx.login');services.drain();await settle();services.drain();assert.equal(invoked,1)
  const disk=native.commands.filter(command=>command.operation==='managedFile');assert.equal(disk.length,1);assert.equal(disk[0].payload.context.sessionId,'session')
  services.revoke();assert.throws(()=>services.managedFile({...trusted,sessionId:'session'},'object:FileSystemManager.access',{}),/retired/)
  await services.waitForDrain()
})
test('Harmony binary completions use UTF8 budgets and saturation still settles every call once',async()=>{
  const native=new NativeTransport(),services=new HarmonyHostServices(native)
  services.registerApiHandler('wx.request',async()=>({data:{__weappBinary:{type:'ArrayBuffer',bytes:Array(1024*1024).fill(255)}}}))
  services.configure(trusted,trusted.application.packRoot)
  for(let index=0;index<3;index++)native.call(`large-${index}`,'wx.request')
  services.drain();await settle();services.drain()
  const completed=native.commands.filter(command=>command.operation==='complete')
  assert.equal(completed.length,3);assert.equal(new Set(completed.map(command=>command.payload.callId)).size,3)
  assert.equal(completed[0].payload.result.data.__weappBinary.bytes.length,1024*1024)
  assert.equal(completed.filter(command=>command.payload.error?.message==='native completion queue byte limit').length,2)
  services.revoke();await services.waitForDrain()
})

test('Harmony release retry retains failed exact cancellation and adapter cleanup actions while completed resources stay retired',async()=>{
  const native=new NativeTransport(),services=new HarmonyHostServices(native);let fails=true,failed=0,completed=0,adapter=0
  services.registerApiHandler('wx.login',async(payload,call)=>{call.cancellation.retainUntilCancelled();call.cancellation.onCancel(async()=>{failed++;if(fails)throw new Error('native release failed')});call.cancellation.onCancel(()=>{completed++});return {}})
  services.onClose(async()=>{adapter++;if(fails)throw new Error('adapter release failed')});services.configure(trusted,trusted.application.packRoot);native.call('resource','wx.login');services.drain();await settle()
  services.revoke();await assert.rejects(services.waitForDrain(),/failed to stop/);await assert.rejects(services.retryResourceCleanup(),/still failed/);assert.equal(completed,1);assert.equal(failed,2);assert.equal(adapter,2)
  fails=false;await services.retryResourceCleanup();await services.waitForDrain();assert.equal(failed,3);assert.equal(adapter,3);assert.equal(completed,1);await services.retryResourceCleanup();assert.equal(failed,3);assert.equal(adapter,3)
})

test('Harmony cleanup installed after handler revocation stays in the actual retry barrier',async()=>{
  const native=new NativeTransport(),services=new HarmonyHostServices(native);let finish,attempts=0,fails=true
  const gate=new Promise(resolve=>finish=resolve)
  services.registerApiHandler('wx.login',async(payload,call)=>{await gate;call.cancellation.onCancel(async()=>{attempts++;if(fails)throw new Error('late-acquired native handle retained')});return {}})
  services.configure(trusted,trusted.application.packRoot);native.call('late','wx.login');services.drain();await settle();services.revoke();finish();await assert.rejects(services.waitForDrain(),/failed to stop/);assert.equal(attempts,1)
  fails=false;await services.retryResourceCleanup();assert.equal(attempts,2);assert.equal(native.commands.filter(value=>value.operation==='complete').length,0)
})

test('Harmony failed native revoke blocks all callbacks and is retried before claiming drained',async()=>{
  const native=new NativeTransport(),original=native.hostServices.bind(native);let failures=true
  native.hostServices=json=>{const value=JSON.parse(json);if(value.operation==='revoke'&&failures){native.commands.push(value);return '{"ok":false,"error":"native revoke failed"}'}return original(json)}
  const services=new HarmonyHostServices(native);services.configure(trusted,trusted.application.packRoot)
  assert.throws(()=>services.revoke(),/cleanup failures/);assert.deepEqual(services.drain(),[]);await assert.rejects(services.waitForDrain(),/revocation requires retry/);assert.equal(services.emit({...trusted,sessionId:'session'},'old',1,'Event',{}),false)
  failures=false;await services.retryResourceCleanup();assert.equal(native.commands.filter(value=>value.operation==='revoke').length,2)
})

test('Harmony concurrent retry calls share the exact pending native cleanup attempt',async()=>{
  const native=new NativeTransport(),services=new HarmonyHostServices(native);let attempts=0,release
  const gate=new Promise(resolve=>release=resolve)
  services.onClose(async()=>{attempts++;if(attempts===1)throw new Error('initial failure');await gate});services.configure(trusted,trusted.application.packRoot);services.revoke();await assert.rejects(services.waitForDrain())
  const retry=services.retryResourceCleanup();assert.equal(services.retryResourceCleanup(),retry);await settle();assert.equal(attempts,2);let done=false;retry.then(()=>done=true);await settle();assert.equal(done,false);release();await retry;assert.equal(done,true)
})

test('Harmony cancellation before JS dispatch releases the exact settled native call and suppresses both success and error terminals',async()=>{
  const native=new NativeTransport(),services=new HarmonyHostServices(native),released=[]
  services.registerApiHandler('wx.login',async(payload,call)=>{call.cancellation.onCancel(()=>released.push(call.context.callId));if(payload.fail)throw new HarmonyApiError('permission_denied','denied',7001,'login:fail denied');return {code:'native-success'}})
  services.configure(trusted,trusted.application.packRoot)
  native.call('success','wx.login');native.call('failure','wx.login',{fail:true});services.drain();await settle()
  native.requests.push({kind:'cancel',callId:'success'},{kind:'cancel',callId:'failure'});services.drain();await services.waitForDrain()
  assert.deepEqual(released,['success','failure']);assert.equal(native.commands.filter(value=>value.operation==='complete').length,0)
  services.revoke();await services.waitForDrain();assert.equal(released.length,2)
})

test('Harmony one JS callback can cancel a later queued completion and the just-delivered resource before final collection',async()=>{
  const native=new NativeTransport(),original=native.hostServices.bind(native),released=[],services=new HarmonyHostServices(native)
  native.hostServices=json=>{const value=JSON.parse(json),result=original(json);if(value.operation==='complete'&&value.payload.callId==='first')native.requests.push({kind:'cancel',callId:'first'},{kind:'cancel',callId:'second'});return result}
  services.registerApiHandler('wx.login',async(payload,call)=>{call.cancellation.onCancel(()=>released.push(call.context.callId));return {code:call.context.callId}})
  services.configure(trusted,trusted.application.packRoot);native.call('first','wx.login');native.call('second','wx.login');services.drain();await settle();services.drain();await services.waitForDrain()
  assert.deepEqual(native.commands.filter(value=>value.operation==='complete').map(value=>value.payload.callId),['first']);assert.deepEqual(released,['first','second'])
  services.revoke();await services.waitForDrain()
})

test('Harmony native transport failure retains the exact completion and later queued calls without repeating delivered records',async()=>{
  const native=new NativeTransport(),original=native.hostServices.bind(native),services=new HarmonyHostServices(native),attempts=[],released=[];let fails=true
  native.hostServices=json=>{const value=JSON.parse(json);if(value.operation==='complete'){attempts.push(value.payload);if(value.payload.callId==='second'&&fails)return '{"ok":false,"error":"transport temporarily unavailable"}'}return original(json)}
  services.registerApiHandler('wx.login',async(payload,call)=>{call.cancellation.onCancel(()=>released.push(call.context.callId));return {code:call.context.callId}})
  services.configure(trusted,trusted.application.packRoot);for(const id of ['first','second','third'])native.call(id,'wx.login');services.drain();await settle();assert.throws(()=>services.drain(),/temporarily unavailable/)
  // The first call's controller also survives the failed drain's final take.
  native.requests.push({kind:'cancel',callId:'first'});native.call('arrived-during-failure','wx.login');assert.throws(()=>services.drain(),/temporarily unavailable/);fails=false;services.drain();assert.deepEqual(released,['first']);await settle();services.drain()
  assert.deepEqual(attempts.map(value=>value.callId),['first','second','second','second','third','arrived-during-failure']);assert.deepEqual(attempts[1],attempts[3]);assert.deepEqual(native.commands.filter(value=>value.operation==='complete').map(value=>value.payload.callId),['first','second','third','arrived-during-failure'])
  services.revoke();await services.waitForDrain()
})

test('Harmony all 256 terminal reservations survive a full event lane and release cancellation budgets exactly',async()=>{
  const native=new NativeTransport(),services=new HarmonyHostServices(native),eventContext={...trusted,sessionId:'session'}
  services.registerApiHandler('wx.login',async()=>({code:'é'.repeat(24*1024)}));services.configure(trusted,trusted.application.packRoot)
  for(let i=0;i<256;i++){assert.equal(services.emit(eventContext,'sensor',i+1,'Sample',{value:i}),true);native.call('terminal-'+i,'wx.login')}
  assert.equal(services.emit(eventContext,'sensor',257,'Sample',{}),false);services.drain();await settle()
  native.requests.push({kind:'cancel',callId:'terminal-0'});services.drain()
  const completed=native.commands.filter(value=>value.operation==='complete');assert.equal(completed.length,255);assert.equal(new Set(completed.map(value=>value.payload.callId)).size,255);assert.ok(completed.some(value=>value.payload.result));assert.ok(completed.some(value=>value.payload.error?.message==='native completion queue byte limit'))
  // Reclaimed terminal reservations admit a fresh complete batch.
  for(let i=0;i<256;i++)native.call('next-'+i,'wx.login');services.drain();await settle();services.drain();assert.equal(native.commands.filter(value=>value.operation==='complete').length,511)
  services.revoke();await services.waitForDrain()
})

test('Harmony dispatched retained objects do not consume pending call slots required to stop them',async()=>{
  const native=new NativeTransport(),services=new HarmonyHostServices(native);let stopped=0
  services.registerApiHandler('wx.login',async(payload,call)=>{call.cancellation.retainUntilCancelled();return {}});services.registerApiHandler('wx.checkSession',async()=>{stopped++;return {}});services.configure(trusted,trusted.application.packRoot)
  for(let i=0;i<256;i++)native.call('object-'+i,'wx.login');services.drain();await settle();services.drain()
  native.call('stop','wx.checkSession');services.drain();await settle();services.drain();assert.equal(stopped,1);assert.ok(native.commands.find(value=>value.operation==='complete'&&value.payload.callId==='stop').payload.result)
  services.revoke();await services.waitForDrain()
})
