// Tests the real Worker scheduler/transport with an injected finite host.
// This is protocol evidence, not QuickJS/WASM or browser device acceptance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { WorkerHostServicesTransport } from './worker-host-services.mjs'
import { createWorkerRuntime } from './worker-runtime.mjs'
import { HOST_API_RESOURCE_MAX_BYTES, WorkerRpcClient, measureWorkerPayload } from './worker-session-client.mjs'
const bytes=value=>new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value))
const hash=value=>createHash('sha256').update(value).digest('hex')
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value)
function pack(){
  const module=bytes('App({});'),moduleHash=hash(module),manifest={schemaVersion:1,protocolVersion:'1.0',compiler:{name:'weapp-vite',commit:'native-services-protocol-test',platform:'weapp'},app:{appJson:'app.json',entryModule:'app.js'},routes:[{id:'route:home',path:'pages/home/index',kind:'page',entryModule:'pages/home/index.js'}],modules:[{id:'module:app.js',sha256:moduleHash,format:'commonjs',scope:'app',dependencies:[]}],templates:[],styles:[],components:[],assets:[],capabilities:{},integrity:{algorithm:'sha256',root:''}}
  manifest.integrity.root=hash(bytes(canonical(manifest)))
  const manifestBytes=bytes(manifest),index={schemaVersion:1,manifest:'./manifest.json',manifestSha256:hash(manifestBytes),integrityRoot:manifest.integrity.root,blobs:[{sha256:moduleHash,size:module.length,url:'./app.blob'}]},indexBytes=bytes(index)
  return {manifest,indexSha256:hash(indexBytes),files:new Map([['https://worker.test/pack-index.json',indexBytes],['https://worker.test/manifest.json',manifestBytes],['https://worker.test/app.blob',module]])}
}
class FiniteHost {
  log=[]; lifecycle='Created'; requests=[{kind:'call',callId:'call-1',method:'wx.login',payload:{}}]
  load_manifest_json_with_config(manifest,config){this.config=JSON.parse(config);this.log.push('load')}
  host_services_protocol_json(){return JSON.stringify({version:'1.0',trustedContext:true,ownerThreadCompletion:true,events:true,revocation:true,componentFrames:'1.0',...(this.oldResources?{}:{packagedApiResources:'1.0'})})}
  configure_host_services_json(config){this.trusted=JSON.parse(config);this.log.push('configure')}
  capabilities_json(){return JSON.stringify({quickjs:true})}
  runtime_state_json(){return JSON.stringify({schemaVersion:1,sessionId:this.config.session_id,currentPage:this.page||null,viewport:{width:375,height:667},rendererProfile:'skia',declaredRendererProfile:'skia',viewRevision:'0',renderRevision:'0',templateRevision:'0',lifecycle:this.lifecycle,requiresRestart:false})}
  dispatch_json(value){const message=JSON.parse(value);this.log.push(message.op);if(message.op==='app.lifecycle')this.lifecycle=message.payload.event==='unload'?'Destroyed':'Active';if(message.op==='page.push')this.page={pageId:'1',path:message.payload.path};return JSON.stringify({messages:[{...message,kind:'response',payload:{ok:true,...(message.op==='app.init'?{engineProviderAvailable:true}:{})}}]})}
  host_component_snapshots_json(){return JSON.stringify([{sessionId:this.config.session_id,pageId:'1',nodeId:'camera'}])}
  host_component_resource(target){this.mediaTarget=JSON.parse(target);return this.mediaPending ? undefined : new Uint8Array([1,2,3])}
  host_api_resource(context){this.resourceContext=JSON.parse(context);return new Uint8Array([0,128,255])}
  submit_host_component_frame(metadata,pixels){this.frame={metadata:JSON.parse(metadata),pixels};return true}
  poll_timers(){return '{"messages":[]}'}
  take_host_requests_json(){return JSON.stringify(this.requests.splice(0))}
  complete_host_api_call_json(callId,result){this.completion={callId,...JSON.parse(result)};this.log.push('complete');return '{"messages":[]}'}
  dispatch_host_api_event_json(event){this.event=JSON.parse(event);this.log.push('event');return '{"messages":[]}'}
  revoke_host_services_json(){this.log.push('revoke');return '[{"kind":"cancel","callId":"call-1"}]'}
  retire_browser_preview(){this.log.push('retire');return '{"messages":[]}'}
  unload(){this.log.push('unload')}
  free(){this.log.push('free')}
}
function fixture(t,{oldHost=false}={}){
  const p=pack(),host=new FiniteHost(),pending=new Map();let sequence=0
  if(oldHost)host.host_services_protocol_json=undefined
  const timerJobs=new Set(),timer={setTimeout(callback,ms){const handle=setTimeout(()=>{timerJobs.delete(handle);callback()},ms);timerJobs.add(handle);return handle},clearTimeout(handle){clearTimeout(handle);timerJobs.delete(handle)}}
  const runtime=createWorkerRuntime({initializeWasm:async()=>{},createHost:()=>host,baseUrl:'https://worker.test/runtime-worker.mjs',fetch:async url=>new Response(p.files.get(url)),timer,send:message=>{if(message.kind==='response'&&message.payload.status!=='queued')pending.get(message.requestId)?.(message.payload)}})
  const request=(op,payload={})=>new Promise(resolve=>{const requestId=`test-${++sequence}`;pending.set(requestId,resolve);runtime.receive({version:'1.0',workerEpoch:'worker-1',sessionId:'session-1',requestId,kind:'request',op,payload})})
  t.after(async()=>{await request('close');for(const handle of timerJobs)clearTimeout(handle)})
  const hostServices={application:{hostAppId:'host',tenantId:'tenant',publisherId:'pub',appId:'app',environment:'release',version:'1',packRoot:p.manifest.integrity.root},account:{principalId:'alice',epoch:1},apis:['wx.login'],syncValues:{}}
  return {host,request,load:(services=hostServices,options={})=>request('load',{...options,indexUrl:'./pack-index.json',indexSha256:p.indexSha256,hostServices:services}),hostServices}
}
test('Worker installs native services before app.init and preserves full completion/event protocol',async t=>{
  const f=fixture(t);const loaded=await f.load();assert.equal(loaded.status,'ok',JSON.stringify(loaded));assert.equal(loaded.result.hostServices.version,'1.0')
  assert.ok(f.host.log.indexOf('configure')<f.host.log.indexOf('app.init'))
  const taken=await f.request('native.take');assert.equal(taken.result.requests[0].callId,'call-1')
  await f.request('native.complete',{callId:'call-1',completion:{error:{code:'permission_denied',message:'denied',details:{errCode:1001,errMsg:'login:fail denied'}}}})
  assert.equal(f.host.completion.error.details.errCode,1001)
  const event={sessionId:'session-1',accountEpoch:1,subscriptionId:'sub-1',sequence:1,value:{data:'value'}}
  await f.request('native.event',{event});assert.deepEqual(f.host.event,event)
})
test('revocation uses control lane, stops new work and close never runs old guest unload hooks',async t=>{
  const f=fixture(t);await f.load();const revoked=await f.request('native.revoke');assert.equal(revoked.result.revoked,true)
  assert.equal((await f.request('native.take')).error.code,'ERR_IDENTITY_SWITCHING')
  const state=await f.request('state');assert.equal(state.result.inputEnabled,false);assert.equal(state.result.hostIdentityRevoked,true)
  await f.request('close');assert.equal(f.host.log.filter(op=>op==='app.lifecycle').length,1)
  assert.equal(f.host.log.includes('free'),true)
})
test('old runtime and mismatched accepted pack reject native feature before app code',async t=>{
  const old=fixture(t,{oldHost:true});assert.equal((await old.load()).error.code,'ERR_PROTOCOL_VERSION');assert.equal(old.host.log.includes('app.init'),false)
  const wrong=fixture(t);assert.equal((await wrong.load({...wrong.hostServices,application:{...wrong.hostServices.application,packRoot:'0'.repeat(64)}})).error.code,'ERR_INVALID_MANIFEST');assert.equal(wrong.host.log.includes('app.init'),false)
})

test('native media frames keep a bounded byte lane and reject a retired owner',async t=>{
  const f=fixture(t);await f.load()
  assert.equal((await f.request('native.components')).result.components[0].nodeId,'camera')
  const metadata={sessionId:'session-1',accountEpoch:'1',pageId:'1',nodeId:'camera',sequence:'1',width:1,height:1,format:'rgba8'}
  const pixels=new Uint8Array([255,1,2,255])
  assert.equal((await f.request('native.frame',{metadata,pixels})).result.accepted,true)
  assert.ok(f.host.frame.pixels instanceof Uint8Array);assert.deepEqual(f.host.frame.metadata,metadata)
  assert.equal((await f.request('native.frame',{metadata:{...metadata,sessionId:'retired'},pixels})).status,'error')
  assert.equal((await f.request('native.frame',{metadata,pixels:new Uint8Array(1024*1024+1)})).status,'error')
  await f.request('native.revoke');assert.equal((await f.request('native.frame',{metadata,pixels})).error.code,'ERR_IDENTITY_SWITCHING')
})

test('Worker media resource retains pending geometry and transfers only verified native bytes',async t=>{
  const f=fixture(t);await f.load();const target={sessionId:'session-1',accountEpoch:'1',pageId:'1',nodeId:'video'}
  f.host.mediaPending=true;assert.equal((await f.request('native.media-resource',{target})).result.pending,true)
  f.host.mediaPending=false;const result=await f.request('native.media-resource',{target});assert.deepEqual([...new Uint8Array(result.result.bytes)],[1,2,3]);assert.deepEqual(f.host.mediaTarget,target)
})
test('host transport relinquishes the owned pixel buffer through the transfer list',async()=>{
  let received
  const transport=new WorkerHostServicesTransport({async nativeHostServices(op,payload,options){received={op,payload:structuredClone(payload,{transfer:options.transfer})};return {accepted:true}},async revokeHostIdentity(){return {cancellations:[]}}})
  transport.activate({hostServices:{version:'1.0',trustedContext:true,ownerThreadCompletion:true,componentFrames:'1.0'}})
  const pixels=new Uint8Array([1,2,3,4]);assert.equal(await transport.submit_host_component_frame(JSON.stringify({sessionId:'session-1'}),pixels),true)
  assert.equal(pixels.byteLength,0);assert.equal(received.op,'native.frame');assert.deepEqual([...received.payload.pixels],[1,2,3,4])
})

test('failed native revoke remains blocked, shares in-flight close and retries the exact host control',async()=>{
  let attempts=0,fail=true,release
  const blocked=new Promise(resolve=>{release=resolve})
  const transport=new WorkerHostServicesTransport({async nativeHostServices(){throw new Error('retired request entered native')},async revokeHostIdentity(){attempts++;await blocked;if(fail)throw new Error('native identity still active');return {revoked:true,cancellations:[{callId:'old'}]}}})
  transport.activate({hostServices:{version:'1.0',trustedContext:true,ownerThreadCompletion:true}})
  const closing=transport.revoke_host_services_json(),rejected=assert.rejects(closing,/native identity still active/)
  assert.equal(transport.revoke_host_services_json(),closing)
  await assert.rejects(transport.take_host_requests_json(),{code:'ERR_CANCELLED'})
  release();await rejected
  await assert.rejects(transport.take_host_requests_json(),{code:'ERR_CANCELLED'})
  fail=false
  assert.equal(await transport.revoke_host_services_json(),'[{"callId":"old"}]')
  assert.equal(attempts,2)
  assert.equal(await transport.revoke_host_services_json(),'[]')
  assert.equal(attempts,2)
})

test('a malformed native revoke final cannot become a successful transport close on retry',async()=>{
  let attempts=0
  const transport=new WorkerHostServicesTransport({async nativeHostServices(){},async revokeHostIdentity(){attempts++;return attempts===1?{}:{cancellations:[]}}})
  transport.activate({hostServices:{version:'1.0',trustedContext:true,ownerThreadCompletion:true}})
  await assert.rejects(transport.revoke_host_services_json(),{code:'ERR_PROTOCOL_VERSION'})
  assert.equal(await transport.revoke_host_services_json(),'[]')
  assert.equal(attempts,2)
})

test('packaged API bytes use the host-only Worker lane, version gate and exact current context',async t=>{
  const f=fixture(t);await f.load();const context={sessionId:'session-1',callId:'source-1',api:'object:InnerAudioContext.src'}
  const result=await f.request('native.api-resource',{context});assert.equal(result.status,'ok');assert.deepEqual([...new Uint8Array(result.result.bytes)],[0,128,255]);assert.deepEqual(f.host.resourceContext,context)
  assert.equal((await f.request('native.api-resource',{context:{...context,sessionId:'old'}})).status,'error')
  const old=fixture(t);old.host.oldResources=true;await old.load();assert.equal((await old.request('native.api-resource',{context})).error.code,'ERR_PROTOCOL_VERSION');assert.equal(old.host.resourceContext,undefined)
  await f.request('native.revoke');assert.equal((await f.request('native.api-resource',{context})).error.code,'ERR_IDENTITY_SWITCHING')
})

test('Worker transport refuses package bytes from an older runtime and transfers the negotiated result',async()=>{
  const calls=[],transport=new WorkerHostServicesTransport({async nativeHostServices(op,payload){calls.push({op,payload});return {bytes:new Uint8Array([9,8]).buffer}},async revokeHostIdentity(){return {cancellations:[]}}})
  transport.activate({hostServices:{version:'1.0',trustedContext:true,ownerThreadCompletion:true}})
  await assert.rejects(transport.host_api_resource('{}'),/does not implement/);assert.equal(calls.length,0)
  transport.activate({hostServices:{version:'1.0',trustedContext:true,ownerThreadCompletion:true,packagedApiResources:'1.0'}})
  assert.deepEqual([...await transport.host_api_resource(JSON.stringify({callId:'source'}))],[9,8]);assert.equal(calls[0].op,'native.api-resource');assert.deepEqual(calls[0].payload,{context:{callId:'source'}})
})

test('package API resource ceiling fits the real Worker response budget even with a large negotiated observation',async t=>{
  const f=fixture(t)
  f.host.observation_contract_json=()=>JSON.stringify({version:'1.0',inputLifetime:'1.0'})
  f.host.observation_state_json=()=>JSON.stringify({version:'1.0',inputLifetimeRevision:'1',state:{...JSON.parse(f.host.runtime_state_json()),diagnostic:'x'.repeat(128*1024)}})
  const loaded=await f.load(undefined,{observation:{version:'1.0'}});assert.equal(loaded.status,'ok',JSON.stringify(loaded));assert.equal(loaded.result.observation.state.diagnostic.length,128*1024)
  const context={sessionId:'session-1',callId:'boundary',api:'object:InnerAudioContext.src'}
  f.host.host_api_resource=()=>new Uint8Array(HOST_API_RESOURCE_MAX_BYTES)
  const accepted=await f.request('native.api-resource',{context});assert.equal(accepted.status,'ok',JSON.stringify(accepted));assert.equal(accepted.result.bytes.byteLength,HOST_API_RESOURCE_MAX_BYTES);assert.equal(accepted.result.observation,undefined)
  f.host.host_api_resource=()=>new Uint8Array(HOST_API_RESOURCE_MAX_BYTES+1)
  const rejected=await f.request('native.api-resource',{context});assert.equal(rejected.status,'error');assert.match(rejected.error.message,/API resource exceeds transfer limit/)
})

test('native binary request, response and timer event cross real client/owner clone boundaries without spending JSON node credit',async t=>{
  const p=pack(),host=new FiniteHost(),listeners=new Set(),sent=[],received=[],jobs=new Set()
  let runtime,client
  const timer={setTimeout(callback,ms){const handle=setTimeout(()=>{jobs.delete(handle);callback()},ms);jobs.add(handle);return handle},clearTimeout(handle){clearTimeout(handle);jobs.delete(handle)}}
  const worker={addEventListener(type,listener){if(type==='message')listeners.add(listener)},removeEventListener(type,listener){if(type==='message')listeners.delete(listener)},
    postMessage(message,transfer=[]){const data=structuredClone(message,{transfer});received.push(data);queueMicrotask(()=>runtime.receive(data))},
    terminate(){for(const handle of jobs)clearTimeout(handle);jobs.clear()}}
  runtime=createWorkerRuntime({initializeWasm:async()=>{},createHost:()=>host,baseUrl:'https://worker.test/runtime-worker.mjs',fetch:async url=>new Response(p.files.get(url)),timer,
    send(message,transfer=[]){const data=structuredClone(message,{transfer});sent.push({message,data,transferred:transfer.length});queueMicrotask(()=>{for(const listener of listeners)listener({data})})}})
  client=new WorkerRpcClient({workerFactory:()=>worker,workerEpoch:'worker-1',sessionId:'session-1',timeoutMs:3000,onEvent:message=>events.push(message)})
  const events=[]
  t.after(async()=>{await client.close();assert.equal(jobs.size,0)})
  const transport=new WorkerHostServicesTransport({nativeHostServices:(op,payload={},options={})=>client.requestHost(op,payload,options),revokeHostIdentity:()=>client.requestHost('native.revoke',{})})
  const services={application:{hostAppId:'host',tenantId:'tenant',publisherId:'pub',appId:'app',environment:'release',version:'1',packRoot:p.manifest.integrity.root},account:{principalId:'alice',epoch:1},apis:['wx.login'],syncValues:{}}
  const loaded=await client.requestHost('load',{indexUrl:'./pack-index.json',indexSha256:p.indexSha256,hostServices:services})
  assert.equal(loaded.hostServices.binaryTransfer,'1.0');transport.activate(loaded)
  const bytes=Array.from({length:65536},(_,index)=>index%256),marker={__weappBinary:{type:'ArrayBuffer',bytes}}
  assert.throws(()=>measureWorkerPayload(marker),/node budget/)
  host.requests=[{kind:'call',callId:'binary',method:'object:FileSystemManager.writeFile',payload:{data:marker}}]
  const taken=JSON.parse(await transport.take_host_requests_json())
  assert.deepEqual(taken[0].payload.data,marker)
  const takeWire=sent.findLast(entry=>entry.data.op==='native.take'&&entry.data.payload.status==='ok')
  assert.equal(takeWire.transferred,1);assert.equal(takeWire.message.payload.result.requests[0].payload.data.__weappBinary.bytes.byteLength,0,'only the newly packed backing is detached')
  assert.equal(bytes.length,65536,'original native result stays retryable')
  host.complete_host_api_call_json=function(callId,result){this.completion={callId,...JSON.parse(result)};return JSON.stringify({messages:[{op:'binary.reply',payload:{data:marker}}]})}
  const completed=JSON.parse(await transport.complete_host_api_call_json('binary',JSON.stringify({result:{data:marker}})))
  assert.deepEqual(host.completion.result.data,marker);assert.deepEqual(completed.messages[0].payload.data,marker)
  assert.ok(received.findLast(message=>message.op==='native.complete').payload.completion.result.data.__weappBinary.bytes instanceof ArrayBuffer)
  const event={sessionId:'session-1',accountEpoch:1,subscriptionId:'binary-sub',sequence:1,value:{data:marker}}
  await transport.dispatch_host_api_event_json(JSON.stringify(event));assert.deepEqual(host.event,event)
  let emitted=false
  host.poll_timers=()=>{if(emitted)return '{"messages":[]}';emitted=true;return JSON.stringify({messages:[{op:'binary.timer',payload:{data:marker}}]})}
  const deadline=Date.now()+3000
  while(!events.some(message=>message.op==='batch'&&message.payload.messages.some(inner=>inner.op==='binary.timer'))){assert.ok(Date.now()<deadline,'binary timer event did not arrive');await new Promise(resolve=>setTimeout(resolve,5))}
  const delivered=events.find(message=>message.op==='batch'&&message.payload.messages.some(inner=>inner.op==='binary.timer'))
  assert.deepEqual(delivered.payload.messages[0].payload.data,marker)
  assert.equal(sent.find(entry=>entry.data.requestId===delivered.requestId).transferred,1)
  assert.equal(client.failure,null)
})

test('binary completion refuses an old Worker and a failed post can retry from unchanged native JSON',async()=>{
  const bytes=Array.from({length:65536},(_,index)=>index%256),source=JSON.stringify({result:{data:{__weappBinary:{type:'ArrayBuffer',bytes}}}})
  let calls=0,reject=true,captured
  const transport=new WorkerHostServicesTransport({async nativeHostServices(op,payload,options){calls++;if(reject)throw new Error('post rejected');captured=structuredClone(payload,{transfer:options.transfer});return {batch:{messages:[]}}},async revokeHostIdentity(){return {cancellations:[]}}})
  transport.activate({hostServices:{version:'1.0',trustedContext:true,ownerThreadCompletion:true}})
  await assert.rejects(transport.complete_host_api_call_json('binary',source),error=>error.code==='ERR_PROTOCOL_VERSION');assert.equal(calls,0)
  transport.activate({hostServices:{version:'1.0',trustedContext:true,ownerThreadCompletion:true,binaryTransfer:'1.0'}})
  await assert.rejects(transport.complete_host_api_call_json('binary',source),/post rejected/)
  reject=false;assert.equal(await transport.complete_host_api_call_json('binary',source),'{"messages":[]}')
  assert.deepEqual([...new Uint8Array(captured.completion.result.data.__weappBinary.bytes)],bytes)
  assert.equal(JSON.parse(source).result.data.__weappBinary.bytes.length,65536)
})
