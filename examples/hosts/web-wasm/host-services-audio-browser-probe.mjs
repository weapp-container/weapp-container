// Explicit synthetic PCM evidence in real HTMLAudioElement + QuickJS/WASM.
// This does not exercise a microphone, physical speaker or platform acceptance.
import initializeWasm, { WebWasmHost } from './pkg/container_host_web.js'
import { BrowserHostServices } from './browser-host-services.mjs'
import { WorkerHostServicesTransport } from './worker-host-services.mjs'
import { WorkerRpcClient } from './worker-session-client.mjs'

const check=(value,message)=>{if(!value)throw new Error(message)}
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`:JSON.stringify(value)
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true})
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(n=>n.toString(16).padStart(2,'0')).join('')
const delay=()=>new Promise(resolve=>setTimeout(resolve,15))
async function fetchBytes(url) {const response=await fetch(url,{credentials:'omit',redirect:'error'});check(response.ok,`fixture request failed ${response.status}`);return new Uint8Array(await response.arrayBuffer())}
async function fixture(indexUrl) {
  const location=new URL(indexUrl,globalThis.location.href),indexBytes=await fetchBytes(location),index=JSON.parse(decoder.decode(indexBytes)),manifestBytes=await fetchBytes(new URL(index.manifest,location))
  check(await hash(manifestBytes)===index.manifestSha256,'audio fixture manifest digest mismatch')
  const manifest=JSON.parse(decoder.decode(manifestBytes));check(manifest.integrity.root===index.integrityRoot&&await hash(encoder.encode(canonical({...manifest,integrity:{...manifest.integrity,root:''}})))===index.integrityRoot,'audio fixture canonical root mismatch')
  const blobs={},moduleBytes=new Map()
  for(const blob of index.blobs){const value=await fetchBytes(new URL(blob.url,location));check(value.length===blob.size&&await hash(value)===blob.sha256,'audio fixture blob mismatch');blobs[`sha256:${blob.sha256}`]=[...value];moduleBytes.set(blob.sha256,value)}
  const entry=manifest.modules.find(module=>module.id.replace(/^module:/,'')===manifest.app.entryModule.replace(/^module:/,'')),asset=manifest.assets.find(asset=>asset.path==='assets/host-audio-probe.wav')
  check(entry?.format==='commonjs'&&asset&&asset.size>44&&decoder.decode(moduleBytes.get(entry.sha256)).includes('exports.__hostAudioCreate'),'run scripts/create-host-services-audio-fixture.mjs before the audio probe')
  return {location,indexBytes,index,manifest,blobs,entry,asset,modules:manifest.modules.map(module=>({id:module.id,bytes:blobs[`sha256:${module.sha256}`]}))}
}
function observeRuntime(owner,{oldProtocol=false,checkAuthority=false}={}) {
  const state={requests:new Map(),completions:[],resources:[],authorityRejections:0}
  const runtime=new Proxy(owner,{get(target,key){
    if(key==='host_services_protocol_json')return()=>{const value=JSON.parse(owner.host_services_protocol_json());if(oldProtocol)delete value.packagedApiResources;return JSON.stringify(value)}
    if(key==='take_host_requests_json')return async()=>{const value=await owner.take_host_requests_json();for(const request of JSON.parse(value))if(request.kind==='call')state.requests.set(request.callId,request);return value}
    if(key==='complete_host_api_call_json')return(callId,value)=>{state.completions.push({method:state.requests.get(callId)?.method,callId,...JSON.parse(value)});return owner.complete_host_api_call_json(callId,value)}
    if(key==='host_api_resource')return async context=>{
      const value=JSON.parse(context)
      if(checkAuthority)for(const changed of [{...value,callId:value.callId+'-wrong'},{...value,account:{...value.account,epoch:'1'}},{...value,api:'wx.login'}]){
        let rejected=false;try{await owner.host_api_resource(JSON.stringify(changed))}catch{rejected=true}check(rejected,'changed API resource context was accepted');state.authorityRejections++
      }
      const bytes=await owner.host_api_resource(context);check(bytes instanceof Uint8Array,'API resource transport did not return owned bytes');state.resources.push({context:value,sha256:await hash(bytes),bytes:bytes.length});return bytes
    }
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
  }})
  return {runtime,state}
}
function nativeEnvironment(observed,{remoteUrl,cookieEcho=false}={}) {
  return {document,window,location,isSecureContext,navigator,Audio:function(){const value=new Audio();observed.audio.push(value);return value},setTimeout:setTimeout.bind(globalThis),clearTimeout:clearTimeout.bind(globalThis),
    fetch:async(url,options)=>{const response=await fetch(url,options);if(remoteUrl&&new URL(url,location.href).href===remoteUrl.href){const echo=response.headers.get('X-Weapp-Probe-Cookie-Present');observed.remote.push({credentials:options?.credentials,redirect:options?.redirect,mode:options?.mode,cookiePresent:echo});if(cookieEcho)check(echo==='false','server did not confirm omission of the unique probe cookie')}return response}}
}

/** Generate a separately served fixture first; see WEB-AUDIO.md. No browser,
 * worker or native decoder survives this function's finally block. An optional
 * server echo can prove the unique benign probe cookie was absent on the wire.
 */
export async function runHostServicesAudioBrowserProbe({catalog,indexUrl='./audio-probe/pack-index.json',workerUrl='./runtime-worker.mjs',worker=true,remoteAudioUrl='./audio-probe/remote.wav',requireCookieEcho=false}={}) {
  check(catalog?.baseline?.baseLibrary==='3.17.3','locked catalog is required')
  const pack=await fixture(indexUrl);await initializeWasm()
  const report={classification:'synthetic-pcm-real-browser-audio-quickjs-wasm',physicalAudioOutput:'not-run',microphone:'not-run',merchantTransaction:'not-run',fixture:{packRoot:pack.index.integrityRoot,wavSha256:pack.asset.sha256,wavBytes:pack.asset.size},checks:{},cleanup:[]}
  const trusted={application:{hostAppId:'audio-probe',tenantId:'probe',publisherId:'explicit-fixture',appId:'audio-app',environment:'trial',version:'probe',packRoot:pack.index.integrityRoot},account:{principalId:'audio-principal',epoch:'9007199254740993'}}
  let host,services,client,request=0,cookieName=null;const observations=[]
  const envelope=(sessionId,op,payload)=>({protocolVersion:'1.0',sessionId,requestId:`audio-${++request}`,kind:'request',op,payload})
  const ok=batch=>{const response=batch.messages.find(message=>message.kind==='response');check(response?.payload?.ok===true,JSON.stringify(batch));return response.payload}
  const direct=(op,payload)=>ok(JSON.parse(host.dispatch_json(JSON.stringify(envelope('audio-direct',op,payload)))))
  const directCall=(name,args=[])=>direct('module.call',{moduleId:pack.entry.id,export:name,args}).result[0]
  const wait=async(predicate,read,label)=>{const until=performance.now()+12000;for(;;){await services.drain();const value=await read();if(predicate(value))return value;check(performance.now()<until,`${label} timed out: ${JSON.stringify(value)}`);await delay()}}
  const newDirect=()=>{host=new WebWasmHost();host.load_manifest_json_with_config(canonical(pack.manifest),JSON.stringify({session_id:'audio-direct',engine:'quickjs',require_integrity:true,renderer_mode:'external-frame'}))}
  const initialize=()=>check(direct('app.init',{blobs:pack.blobs,modules:pack.modules,launchOptions:{}}).engineProviderAvailable===true,'actual QuickJS provider unavailable')
  const closeDirect=async()=>{await services?.close();services=null;if(host){host.unload();host.free();host=null}}
  const inspect=()=>directCall('__hostAudioRead')
  try {
    newDirect();initialize()
    const denied=JSON.parse(host.dispatch_json(JSON.stringify(envelope('audio-direct','api.call',{name:'wx.createInnerAudioContext'})))).messages[0].payload
    check(denied.ok===false&&denied.error.code==='ERR_UNSUPPORTED_CAPABILITY','unconfigured audio fabricated sandbox success');report.checks.strictDefault=true
    await closeDirect()
    // Simulate an older runtime's explicit protocol advertisement while still
    // running the real current QuickJS engine. Package access must fail closed.
    newDirect();let observed={audio:[],remote:[]};observations.push(observed)
    let wrapped=observeRuntime(host,{oldProtocol:true})
    services=new BrowserHostServices({runtime:wrapped.runtime,catalog,environment:nativeEnvironment(observed)})
    await services.configure(trusted);initialize();directCall('__hostAudioCreate')
    await wait(()=>observed.audio.length>0&&observed.audio.at(-1).volume===0,inspect,'old-protocol factory')
    directCall('__hostAudioSource',[pack.asset.path]);await wait(()=>wrapped.state.completions.some(value=>value.method==='object:InnerAudioContext.src'&&value.error),inspect,'old-protocol source rejection')
    check(wrapped.state.resources.length===0&&wrapped.state.completions.find(value=>value.method==='object:InnerAudioContext.src').error.code==='unsupported','old protocol read package resources')
    check(observed.audio.every(audio=>!audio.getAttribute('src')),'old protocol assigned a native audio source');report.checks.oldProtocolRejectsPackage=true;await closeDirect()
    newDirect();observed={audio:[],remote:[]};observations.push(observed);wrapped=observeRuntime(host,{checkAuthority:true})
    cookieName='weapp_audio_probe_'+crypto.randomUUID().replaceAll('-','');const remoteUrl=new URL(remoteAudioUrl,location.href);remoteUrl.searchParams.set('probeCookie',cookieName)
    document.cookie=`${cookieName}=present; Path=/; SameSite=Lax`
    services=new BrowserHostServices({runtime:wrapped.runtime,catalog,allowedOrigins:[pack.location.origin,remoteUrl.origin],environment:nativeEnvironment(observed,{remoteUrl,cookieEcho:requireCookieEcho})})
    await services.configure(trusted);initialize();directCall('__hostAudioCreate');await wait(()=>observed.audio.length>0&&observed.audio.at(-1).volume===0,inspect,'direct audio factory')
    directCall('__hostAudioSource',[pack.asset.path])
    let state=await wait(value=>observed.audio.at(-1).readyState>=2&&value.log.some(row=>row[0]==='Canplay'),inspect,'real packaged PCM decode'),native=observed.audio.at(-1),packageUrl=native.src
    check(native instanceof HTMLAudioElement&&Math.abs(native.duration-4)<.05&&native.src.startsWith('blob:'),'packaged bytes did not reach a real native decoder')
    check(wrapped.state.resources.length===1&&wrapped.state.resources[0].sha256===pack.asset.sha256&&wrapped.state.authorityRejections===3,'package API authority/bytes mismatch')
    let retired=false;try{host.host_api_resource(JSON.stringify(wrapped.state.resources[0].context))}catch{retired=true}check(retired,'settled setter context retained package authority')
    directCall('__hostAudioPlay');state=await wait(value=>native.currentTime>.15&&value.log.some(row=>row[0]==='TimeUpdate'),inspect,'real PCM playback clock')
    const playedAt=native.currentTime;directCall('__hostAudioPause');state=await wait(value=>native.paused&&value.log.some(row=>row[0]==='pause-resolved'),inspect,'real PCM pause')
    report.checks.direct={duration:native.duration,playedAt,pausedAt:native.currentTime,guest:state,resource:wrapped.state.resources[0],mutatedContextRejections:wrapped.state.authorityRejections,settledContextRejected:retired,volume:native.volume}
    directCall('__hostAudioSource',[remoteUrl.href]);state=await wait(value=>observed.remote.length===1&&observed.audio.at(-1)!==native&&observed.audio.at(-1).readyState>=2&&value.properties.src===remoteUrl.href,inspect,'real HTTP PCM decode')
    const remoteNative=observed.audio.at(-1),remoteUrlOwned=remoteNative.src
    check(observed.remote[0].credentials==='omit'&&observed.remote[0].redirect==='error'&&observed.remote[0].mode==='cors'&&remoteUrlOwned.startsWith('blob:'),'remote audio bypassed bounded credential-free fetch')
    check(!native.getAttribute('src')&&native.paused,'source replacement left old native decoder active')
    report.checks.remote={...observed.remote[0],wireCookieVerified:observed.remote[0].cookiePresent==='false',nativeBlobSource:true,duration:remoteNative.duration}
    await closeDirect();check(observed.audio.every(audio=>audio.paused&&!audio.getAttribute('src')),'direct close left a native decoder source')
    for(const url of [packageUrl,remoteUrlOwned]){let revoked=false;try{await fetch(url)}catch{revoked=true}check(revoked,'closed audio retained its Blob URL')}
    report.checks.directCloseRevokesSources=true
    if(worker) {
      client=new WorkerRpcClient({workerUrl,timeoutMs:30000,closeTimeoutMs:5000})
      const transport=new WorkerHostServicesTransport({nativeHostServices:(op,payload={})=>client.requestHost(op,payload),revokeHostIdentity:()=>client.requestHost('native.revoke',{})})
      observed={audio:[],remote:[]};observations.push(observed);wrapped=observeRuntime(transport)
      services=new BrowserHostServices({runtime:wrapped.runtime,catalog,environment:nativeEnvironment(observed)})
      await services.configure(trusted)
      const loaded=await client.requestHost('load',{indexUrl:pack.location.href,indexSha256:await hash(pack.indexBytes),indexSize:pack.indexBytes.length,renderer:'external-frame',engine:'quickjs',viewport:{width:375,height:667},hostServices:transport.configuration,loadTimeoutMs:30000})
      transport.activate(loaded);check(JSON.parse(transport.host_services_protocol_json()).packagedApiResources==='1.0','Worker did not negotiate packaged API resources')
      const call=async(name,args=[])=>ok(await client.requestHost('bridge',{envelope:envelope(client.sessionId,'module.call',{moduleId:pack.entry.id,export:name,args})})).result[0],read=()=>call('__hostAudioRead')
      await call('__hostAudioCreate');await wait(()=>observed.audio.length>0&&observed.audio.at(-1).volume===0,read,'Worker audio factory');await call('__hostAudioSource',[pack.asset.path])
      state=await wait(value=>observed.audio.at(-1).readyState>=2&&value.log.some(row=>row[0]==='Canplay'),read,'Worker packaged PCM decode');native=observed.audio.at(-1)
      check(wrapped.state.resources.length===1&&wrapped.state.resources[0].sha256===pack.asset.sha256&&wrapped.state.resources[0].context.sessionId===client.sessionId,'Worker package bytes/context changed')
      await call('__hostAudioPlay');await wait(value=>native.currentTime>.15&&value.log.some(row=>row[0]==='TimeUpdate'),read,'Worker PCM playback clock');await call('__hostAudioPause');state=await wait(value=>native.paused&&value.log.some(row=>row[0]==='pause-resolved'),read,'Worker PCM pause')
      report.checks.worker={duration:native.duration,pausedAt:native.currentTime,guest:state,resource:wrapped.state.resources[0]}
      await services.close();services=null;await client.close();client=null;check(observed.audio.every(audio=>audio.paused&&!audio.getAttribute('src')),'Worker close left native audio source');report.checks.workerCloseRevokesSources=true
    }
    return report
  } finally {
    const errors=[]
    for(const [name,cleanup]of [['services',()=>services?.close()],['worker',()=>client?.close()],['direct-host',()=>{if(host){host.unload();host.free();host=null}}],['probe-cookie',()=>{if(cookieName)document.cookie=`${cookieName}=; Max-Age=0; Path=/; SameSite=Lax`}],['native-audio-check',()=>check(observations.every(value=>value.audio.every(audio=>audio.paused&&!audio.getAttribute('src'))),'probe left native audio resources')]]){
      try{await cleanup();report.cleanup.push({name,status:'closed'})}catch(error){errors.push(error);report.cleanup.push({name,status:'failed',message:String(error)})}
    }
    if(errors.length)throw new AggregateError(errors,'audio probe cleanup failed')
  }
}
