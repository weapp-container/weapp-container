import nodeTest from 'node:test'
const test=(name,body)=>nodeTest(name,{timeout:5000},body)
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'

// Actual production transport/services, finite HTTP callbacks. This proves
// native terminal ownership and queues; it is not a physical network receipt.
const servicesSource=await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/session/HostServices.ts',import.meta.url),'utf8')
const services=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(servicesSource,{mode:'strip'})).toString('base64'))
const config={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:'9007199254740993'}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const makeCall=(id='call')=>({context:{...structuredClone(config),sessionId:'session',callId:id,api:'wx.login'},cancellation:new services.HarmonyCallCancellation()})
const bytes=text=>new TextEncoder().encode(text).buffer
class NativeHttp {
  listeners=new Map();destroyCalls=0;failDestroy=0;started=false;terminal=deferred()
  on(event,callback){this.listeners.set(event,callback)}
  requestInStream(target,options){this.started=true;this.target=target;this.options=options;return this.terminal.promise}
  destroy(){this.destroyCalls++;if(this.failDestroy-->0)throw Object.assign(new Error('native destroy failed'),{code:2300010})}
  chunk(value){this.listeners.get('dataReceive')(typeof value==='string'?bytes(value):value)}
  end(){this.listeners.get('dataEnd')()}
  respond(value,status=200){this.chunk(JSON.stringify(value));this.end();this.terminal.resolve(status)}
}
const tasks=[]
const http={createHttp(){const native=new NativeHttp();tasks.push(native);return native},RequestMethod:{POST:'POST'},HttpDataType:{ARRAY_BUFFER:2}}
const util={TextEncoder:class{encodeInto(value){return new TextEncoder().encode(value)}},TextDecoder:{create(label,options){const decoder=new TextDecoder(label,options);return {decodeToString(bytes){return decoder.decode(bytes)}}}}}
const transportSource=(await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/native/HarmonyAccountTransport.ets',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'')
globalThis.__harmonyAccountHttp={...services,http,url:{URL},util}
const {HarmonyAccountHttpsTransport}=await import('data:text/javascript;base64,'+Buffer.from('const {HarmonyApiError,http,url,util}=globalThis.__harmonyAccountHttp;\n'+stripTypeScriptTypes(transportSource,{mode:'strip'})).toString('base64'))
function transport(options={}){return new HarmonyAccountHttpsTransport({origin:'https://accounts.test',hostToken:()=> 'native-only-host-token',...options})}
async function until(predicate){for(let attempt=0;attempt<100;attempt++){if(predicate())return;await tick()}assert.ok(predicate(),'finite native callback fixture did not reach expected phase')}
function release(task){task.terminal.reject(Object.assign(new Error('native request cancelled'),{code:2300001}))}

test('Harmony account HTTPS transport constrains origin/endpoints, keeps token native and disables redirects/cache',async()=>{
  for(const origin of ['http://accounts.test','https://accounts.test/','https://user:pass@accounts.test','https://accounts.test/path'])assert.throws(()=>transport({origin}),/exact HTTPS/)
  const owner=transport();for(const path of ['/v1/host/logout','//evil.test/path','/v1/host/profile?x=1','/v1/payments/orders/../launch'])assert.throws(()=>owner.request(path,{},makeCall()),/endpoint/)
  const call=makeCall(),result=owner.request('/v1/host/login-codes',{miniAppId:'app'},call);await tick();const native=tasks.at(-1)
  assert.equal(native.target,'https://accounts.test/v1/host/login-codes');assert.equal(native.options.header.Authorization,'Bearer native-only-host-token');assert.equal(native.options.usingCache,false);assert.equal(native.options.maxRedirects,0);assert.equal(native.options.maxLimit,262144)
  assert.equal(JSON.stringify(call).includes('native-only-host-token'),false);native.respond({code:'one-time',expiresIn:60});assert.deepEqual(await result,{code:'one-time',expiresIn:60});assert.equal(native.destroyCalls,1);await owner.close();assert.equal(native.destroyCalls,1)
})

test('Harmony account success requires both native final and stream end before returning JSON',async()=>{
  const owner=transport(),call=makeCall(),result=owner.request('/v1/host/profile',{},call);let complete=false;result.then(()=>complete=true);await tick();const native=tasks.at(-1)
  native.terminal.resolve(200);native.chunk('{"nickName":"Alice"}');await tick();assert.equal(complete,false);assert.equal(native.destroyCalls,0)
  native.end();assert.deepEqual(await result,{nickName:'Alice'});assert.equal(native.destroyCalls,1);await owner.close()
})

test('Harmony late native credential resolution after cancellation cannot create a request',async()=>{
  const token=deferred(),owner=transport({hostToken:()=>token.promise}),call=makeCall(),count=tasks.length,result=owner.request('/v1/host/profile',{},call)
  call.cancellation.cancel();await assert.rejects(result,{category:'cancelled'});await call.cancellation.waitForDrain();await owner.close();token.resolve('late-host-token');await tick();assert.equal(tasks.length,count)
})

test('Harmony cancellation rejects the caller while exact HTTP terminal still gates close and cancellation drain',async()=>{
  const owner=transport(),call=makeCall(),result=owner.request('/v1/host/profile',{},call);await tick();const native=tasks.at(-1)
  call.cancellation.cancel();await assert.rejects(result,{category:'cancelled'});assert.equal(native.destroyCalls,1)
  let drained=false,closed=false;const draining=call.cancellation.waitForDrain().then(()=>drained=true),closing=owner.close().then(()=>closed=true);await tick();assert.equal(drained,false);assert.equal(closed,false)
  release(native);await Promise.all([draining,closing]);assert.equal(native.destroyCalls,1)
})

test('Harmony failed native destroy retains the exact request and retries its real release',async()=>{
  const owner=transport(),call=makeCall(),result=owner.request('/v1/host/profile',{},call);await tick();const native=tasks.at(-1);native.failDestroy=2
  call.cancellation.cancel();await assert.rejects(result,{category:'cancelled'});await assert.rejects(call.cancellation.waitForDrain(),/native resources/)
  await assert.rejects(owner.close(),/release retry/);assert.equal(native.destroyCalls,2)
  let closed=false;const closing=owner.close().then(()=>closed=true);await tick();assert.equal(native.destroyCalls,3);assert.equal(closed,false)
  release(native);await closing;await call.cancellation.retryCleanup();await owner.close();assert.equal(native.destroyCalls,3)
})

test('Harmony streamed 256 KiB quota cancels producer and retains its actual final barrier',async()=>{
  const owner=transport(),call=makeCall(),result=owner.request('/v1/host/profile',{},call);await tick();const native=tasks.at(-1)
  native.chunk(new ArrayBuffer(131072));native.chunk(new ArrayBuffer(131073));await assert.rejects(result,/response exceeds/);assert.equal(native.destroyCalls,1)
  let closed=false;const closing=owner.close().then(()=>closed=true);await tick();assert.equal(closed,false);release(native);await closing;assert.equal(native.destroyCalls,1)
})

test('Harmony backend error preserves HTTP status and public message and rejects invalid response JSON',async()=>{
  for(const [value,status,expected] of [[{error:'permission_denied',message:'Registered purpose changed'},403,{category:'permission_denied',errCode:403,errMsg:'Registered purpose changed'}],[[],200,{category:'invalid_request',errCode:200}]]){
    const owner=transport(),result=owner.request('/v1/host/profile',{},makeCall());await tick();const native=tasks.at(-1);native.respond(value,status);await assert.rejects(result,expected);assert.equal(native.destroyCalls,1);await owner.close()
  }
  const owner=transport(),result=owner.request('/v1/host/profile',{},makeCall());await tick();const native=tasks.at(-1);native.chunk(new Uint8Array([255]).buffer);native.end();native.terminal.resolve(200);await assert.rejects(result,/invalid UTF-8 JSON/);await owner.close()
  assert.throws(()=>transport().request('/v1/host/profile',{text:'中'.repeat(90000)},makeCall()),/request exceeds/)
})

test('Harmony total deadline bounds pending credentials and trusted nanoseconds divide before Number conversion',async()=>{
  const token=deferred(),owner=transport({timeoutMs:100,hostToken:()=>token.promise}),count=tasks.length,result=owner.request('/v1/host/profile',{},makeCall())
  await assert.rejects(result,{category:'timeout'});token.resolve('late-token');await tick();assert.equal(tasks.length,count);await owner.close()
  const expired=makeCall();expired.context.deadlineNs=String(Date.now()-1)+'000000';assert.throws(()=>transport().request('/v1/host/profile',{},expired),{category:'timeout'})
  const current=makeCall();current.context.deadlineNs=String(Date.now()+5000)+'123456';const next=transport(),response=next.request('/v1/host/profile',{},current);await tick();const native=tasks.at(-1);assert.ok(native.options.readTimeout<=5000);native.respond({});await response;await next.close()
})

test('Harmony real host-service retirement waits native account terminal and drops its old completion',async()=>{
  class Runtime{commands=[];requests=[];hostServices(json){const command=JSON.parse(json);this.commands.push(command);if(command.operation==='protocol')return JSON.stringify({version:'1.0',trustedContext:true,ownerThreadCompletion:true});if(command.operation==='configure')return JSON.stringify({ok:true,sessionId:'session'});if(command.operation==='take')return JSON.stringify({requests:this.requests.splice(0)});return '{"ok":true}'}}
  const runtime=new Runtime(),dispatcher=new services.HarmonyHostServices(runtime),owner=transport();dispatcher.registerApiHandler('wx.login',(payload,call)=>owner.request('/v1/host/login-codes',payload,call));dispatcher.onClose(()=>owner.close());dispatcher.configure(config,config.application.packRoot)
  runtime.requests.push({kind:'call',callId:'login',method:'wx.login',payload:{},context:{...config,sessionId:'session',callId:'login',api:'wx.login'}});dispatcher.drain();await tick();const native=tasks.at(-1);dispatcher.revoke();let drained=false;const draining=dispatcher.waitForDrain().then(()=>drained=true);await tick();assert.equal(drained,false);release(native);await draining;dispatcher.drain();assert.equal(runtime.commands.some(command=>command.operation==='complete'),false);assert.equal(native.destroyCalls,1)
})


async function productionSession(name,bindings){
  const source=(await readFile(new URL(`../examples/hosts/harmony/entry/src/main/ets/session/${name}.ts`,import.meta.url),'utf8')).replace(/^import .*;\n/gm,'')
  return import('data:text/javascript;base64,'+Buffer.from(bindings+stripTypeScriptTypes(source,{mode:'strip'})).toString('base64'))
}
const {HarmonyReferenceIdentity,HarmonyReferencePayments}=await productionSession('ReferenceHostServices','const {HarmonyHostServices,HarmonyApiError,HarmonyCallCancellation}=globalThis.__harmonyAccountHttp;\n')
const {HarmonyDisclosurePrompts}=await productionSession('DisclosurePrompts','const {HarmonyApiError}=globalThis.__harmonyAccountHttp;\n')
const {HarmonyAccountCancellation,harmonyStorageScope}=await productionSession('HostAccountManager','')
globalThis.__harmonyAccountInstall={...services,HarmonyReferenceIdentity,HarmonyReferencePayments,HarmonyDisclosurePrompts,harmonyStorageScope,HarmonyAccountHttpsTransport,HarmonyArkUIDisclosureDriver:class{create(){throw new Error('no disclosure requested during startup')}}}
const assemblySource=(await readFile(new URL('../examples/hosts/harmony/entry/src/main/ets/native/HarmonyReferenceHost.ets',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'')
const {configureHarmonyReferenceHost,installHarmonyReferenceHost}=await import('data:text/javascript;base64,'+Buffer.from('const {HarmonyApiError,HarmonyReferenceIdentity,HarmonyReferencePayments,HarmonyDisclosurePrompts,harmonyStorageScope,HarmonyAccountHttpsTransport,HarmonyArkUIDisclosureDriver}=globalThis.__harmonyAccountInstall;\n'+stripTypeScriptTypes(assemblySource,{mode:'strip'})).toString('base64'))
class ConfigurationRuntime{commands=[];hostServices(json){const command=JSON.parse(json);this.commands.push(command);if(command.operation==='protocol')return JSON.stringify({version:'1.0',trustedContext:true,ownerThreadCompletion:true});if(command.operation==='configure')return JSON.stringify({ok:true,sessionId:'session'});if(command.operation==='take')return '{"requests":[]}';return '{"ok":true}'}}
function ownerContext(){return {...structuredClone(config),sessionId:'fresh-session',operationId:'account-2',sessionIncarnation:2,storageScope:harmonyStorageScope(config.application,config.account),launchOptions:{},appAuthorized:false,cancellation:new HarmonyAccountCancellation(),requestLogout:async()=>({status:'complete'}),grantApplication(){}}}

test('Harmony default reference-host assembly advertises no fabricated identity or payment provider',async()=>{
  configureHarmonyReferenceHost(null);const runtime=new ConfigurationRuntime(),dispatcher=new services.HarmonyHostServices(runtime),before=tasks.length
  assert.equal(await installHarmonyReferenceHost(dispatcher,config,{},ownerContext()),null);assert.deepEqual(dispatcher.supportedApis(),[]);assert.equal(tasks.length,before);dispatcher.revoke();await dispatcher.waitForDrain()
})

test('Harmony configured factory prepares real identity snapshot before native configure and omits unconfigured payment',async()=>{
  configureHarmonyReferenceHost({origin:'https://accounts.test',hostToken:call=>{assert.equal(call.context.account.epoch,'9007199254740993');return 'native-host-token'}})
  const runtime=new ConfigurationRuntime(),dispatcher=new services.HarmonyHostServices(runtime),installing=installHarmonyReferenceHost(dispatcher,config,{},ownerContext());await tick();const native=tasks.at(-1)
  assert.equal(runtime.commands.some(command=>command.operation==='configure'),false);native.respond({hostLoggedIn:true,appLoggedIn:false,profileAuthorized:false,phoneAuthorized:false,privateHostField:'must-not-reach-JS'});const installed=await installing;assert.ok(installed.identity)
  assert.equal(dispatcher.supportedApis().includes('wx.login'),true);assert.equal(dispatcher.supportedApis().includes('wx.requestPayment'),false);assert.equal(dispatcher.supportedApis().includes('component:button.open-type.getPhoneNumber'),true);dispatcher.configure(config,config.application.packRoot)
  const snapshot=runtime.commands.find(command=>command.operation==='configure').payload.syncValues['weappContainer.identity.getState'];assert.deepEqual(snapshot,{hostLoggedIn:true,appLoggedIn:false,profileAuthorized:false,phoneAuthorized:false});dispatcher.revoke();await dispatcher.waitForDrain();configureHarmonyReferenceHost(null)
})

test('Harmony account replacement during factory preflight revokes real transport before a candidate can return',async()=>{
  configureHarmonyReferenceHost({origin:'https://accounts.test',hostToken:()=> 'native-host-token'});const runtime=new ConfigurationRuntime(),dispatcher=new services.HarmonyHostServices(runtime),context=ownerContext(),installing=installHarmonyReferenceHost(dispatcher,config,{},context);await tick();const native=tasks.at(-1)
  context.cancellation.cancel();await assert.rejects(installing,{category:'cancelled'});let drained=false;const draining=dispatcher.waitForDrain().then(()=>drained=true);await tick();assert.equal(drained,false);assert.equal(native.destroyCalls,1);assert.equal(runtime.commands.some(command=>command.operation==='configure'),false)
  release(native);await draining;assert.equal(native.destroyCalls,1);configureHarmonyReferenceHost(null)
})
