// Explicit synthetic protocol fixture executed in a real browser/QuickJS/WASM.
// This does not assert physical device or merchant acceptance.
import { BrowserHostServices } from './browser-host-services.mjs'
import { WorkerHostServicesTransport } from './worker-host-services.mjs'
import { WorkerRpcClient } from './worker-session-client.mjs'
import initializeWasm, { WebWasmHost } from './pkg/container_host_web.js'

const check=(value,message)=>{if(!value)throw new Error(message)}
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`:JSON.stringify(value)
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('')
const bytes=async url=>{const response=await fetch(url,{credentials:'omit'});check(response.ok,`probe resource ${response.status}: ${url}`);return new Uint8Array(await response.arrayBuffer())}
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true})

export async function runHostServicesBrowserProbe({catalog,indexUrl='./pack-index.json',workerUrl='./runtime-worker.mjs',metrics}={}) {
  check(catalog?.baseline?.baseLibrary==='3.17.3','locked catalog is required')
  check(metrics&&['windowWidth','windowHeight','pixelRatio','screenWidth','screenHeight','statusBarHeight','screenTop'].every(name=>Number.isFinite(metrics[name])),
    'an explicit complete current host window observation is required')
  const {windowWidth,windowHeight,...displayMetrics}=structuredClone(metrics)
  const nativeHost={kind:'web',windowWidth,windowHeight,displayMetrics}
  const indexLocation=new URL(indexUrl,location.href),indexBytes=await bytes(indexLocation),index=JSON.parse(decoder.decode(indexBytes))
  const manifestBytes=await bytes(new URL(index.manifest,indexLocation));check(await hash(manifestBytes)===index.manifestSha256,'manifest hash mismatch')
  const manifest=JSON.parse(decoder.decode(manifestBytes));check(manifest.integrity.root===index.integrityRoot,'pack root mismatch')
  check(await hash(encoder.encode(canonical({...manifest,integrity:{...manifest.integrity,root:''}})))===index.integrityRoot,'manifest root is invalid')
  const blobs={}
  for(const blob of index.blobs){const value=await bytes(new URL(blob.url,indexLocation));check(value.length===blob.size&&await hash(value)===blob.sha256,'blob integrity mismatch');blobs[`sha256:${blob.sha256}`]=[...value]}
  const entry=manifest.modules.find(module=>module.id.replace(/^module:/,'')===manifest.app.entryModule.replace(/^module:/,''))
  check(entry?.format==='commonjs','probe requires a CommonJS fixture')
  const source=decoder.decode(new Uint8Array(blobs[`sha256:${entry.sha256}`]));check(!source.includes('__hostServicesProbe'),'probe export collision')
  const fixture=`\n// Explicit browser protocol fixture, not upstream app behavior.\nvar __hostServicesProbeLog=[];exports.__hostServicesProbeStart=function(){wx.login({success:function(r){__hostServicesProbeLog.push(['callback',r.code]);},complete:function(){__hostServicesProbeLog.push('complete');}}).then(function(r){__hostServicesProbeLog.push(['promise',r.code]);}).catch(function(e){__hostServicesProbeLog.push(['login-fail',e.code]);});wx.requestPayment({timeStamp:'1',nonceStr:'explicit-fixture',package:'prepay_id=explicit-fixture',signType:'RSA',paySign:'explicit-fixture'}).catch(function(e){__hostServicesProbeLog.push(['payment-fail',e.errCode,e.errMsg]);});wx.request({url:${JSON.stringify(indexLocation.href)},responseType:'arraybuffer'}).then(function(r){__hostServicesProbeLog.push(['binary',r.data instanceof ArrayBuffer,r.data.byteLength]);});return 'started';};exports.__hostServicesProbeRead=function(){return {log:__hostServicesProbeLog};};var __hostServicesFlood={settled:0,success:0,errors:[]};exports.__hostServicesFloodStart=function(){for(var i=0;i<260;i++)wx.login().then(function(r){__hostServicesFlood.success++;__hostServicesFlood.settled++;},function(e){__hostServicesFlood.errors.push(e.errMsg||e.message);__hostServicesFlood.settled++;});return 'flood-started';};exports.__hostServicesFloodRead=function(){return __hostServicesFlood;};\n`
  const changed=encoder.encode(source+fixture),changedHash=await hash(changed),derived=structuredClone(manifest)
  derived.modules.find(module=>module.id===entry.id).sha256=changedHash;derived.integrity.root='';derived.integrity.root=await hash(encoder.encode(canonical(derived)))
  const derivedBlobs={...blobs,[`sha256:${changedHash}`]:[...changed]}
  await initializeWasm()
  const report={classification:'synthetic-protocol-fixture-real-browser-quickjs-wasm',physicalDevices:'not-run',merchantTransaction:'not-run',metrics:structuredClone(metrics),checks:{},cleanup:[]}
  const application=packRoot=>({hostAppId:'browser-probe',tenantId:'probe',publisherId:'explicit-fixture',appId:'probe-app',environment:'trial',version:'protocol-probe',packRoot})
  const config={application:application(derived.integrity.root),account:{principalId:'probe-principal',epoch:'9007199254740993'}}
  let host,services,client,workerServices,request=0
  const envelope=(sessionId,op,payload)=>({protocolVersion:'1.0',sessionId,requestId:`probe-${++request}`,kind:'request',op,payload})
  const dispatch=(owner,sessionId,op,payload)=>JSON.parse(owner.dispatch_json(JSON.stringify(envelope(sessionId,op,payload))))
  const ok=batch=>{const response=batch.messages.find(message=>message.kind==='response');check(response?.payload?.ok===true,JSON.stringify(batch));return response.payload}
  const modules=derived.modules.map(module=>({id:module.id,bytes:derivedBlobs[`sha256:${module.sha256}`]}))
  const initialize=owner=>ok(dispatch(owner,'direct-probe','app.init',{blobs:derivedBlobs,modules,launchOptions:{}}))
  const call=name=>ok(dispatch(host,'direct-probe','module.call',{moduleId:entry.id,export:name,args:[]})).result[0]
  try {
    host=new WebWasmHost();host.load_manifest_json_with_config(canonical(derived),JSON.stringify({session_id:'direct-probe',engine:'quickjs',require_integrity:true,renderer_mode:'external-frame',host:nativeHost}))
    initialize(host)
    for(const api of ['wx.login','wx.requestPayment']){
      const denied=dispatch(host,'direct-probe','api.call',{name:api}).messages[0].payload
      check(denied.ok===false&&denied.error.code==='ERR_UNSUPPORTED_CAPABILITY',`unconfigured ${api} fabricated sandbox success`)
    }
    host.unload();host.free();host=null;report.checks.strictDefault=true
    host=new WebWasmHost();host.load_manifest_json_with_config(canonical(derived),JSON.stringify({session_id:'direct-probe',engine:'quickjs',require_integrity:true,renderer_mode:'external-frame',host:nativeHost}))
    let contexts=[],flooding=false
    services=new BrowserHostServices({runtime:host,catalog,allowedOrigins:[indexLocation.origin],identity:{login:(payload,call)=>{contexts.push(call.context);return {code:flooding?'x'.repeat(4*1024*1024):'explicit-probe-one-use-code'}}},payment:{requestLegacy:()=>{throw Object.assign(new Error('fixture channel rejected'),{errCode:7001,errMsg:'requestPayment:fail fixture channel rejected'})}}})
    await services.configure(config);check(initialize(host).engineProviderAvailable===true,'actual QuickJS provider unavailable')
    check(call('__hostServicesProbeStart')==='started','actual guest exports did not execute')
    const until=performance.now()+10000;let log
    do {await services.drain();await new Promise(resolve=>setTimeout(resolve,5));log=call('__hostServicesProbeRead').log;check(performance.now()<until,'native browser completion timed out '+JSON.stringify({log,contexts}))}while(log.length<5)
    check(JSON.stringify(log.slice(0,3))===JSON.stringify([['callback','explicit-probe-one-use-code'],'complete',['promise','explicit-probe-one-use-code']]),'callback/complete/Promise order changed')
    check(log.some(value=>Array.isArray(value)&&value[0]==='binary'&&value[1]===true&&value[2]===indexBytes.length),'real HTTP response did not become a guest ArrayBuffer')
    check(log.some(value=>Array.isArray(value)&&value[0]==='payment-fail'&&value[1]===7001),'raw native payment error lost')
    check(contexts.length===1&&String(contexts[0].account.epoch)===config.account.epoch&&contexts[0].application.packRoot===derived.integrity.root,'native context lost trusted scope')
    report.checks.directGuest={log,epoch:config.account.epoch,packRoot:derived.integrity.root}
    flooding=true;check(call('__hostServicesFloodStart')==='flood-started','actual guest flood did not execute')
    const floodUntil=performance.now()+20000;let flood
    do{await services.drain();await new Promise(resolve=>setTimeout(resolve,5));flood=call('__hostServicesFloodRead');check(performance.now()<floodUntil,'guest flood settlement timed out '+JSON.stringify(flood))}while(flood.settled<260)
    check(flood.success>0&&flood.errors.some(message=>message.includes('byte budget'))&&flood.settled===260,'terminal reservations did not settle every admitted/rejected guest call')
    check(contexts.length===257,'native pending admission bound changed')
    report.checks.terminalReservations={settled:flood.settled,success:flood.success,errors:flood.errors.length,byteBudgetFailures:flood.errors.filter(message=>message.includes('byte budget')).length,pendingCallLimit:256}
    await services.close();services=null;host.unload();host.free();host=null
    client=new WorkerRpcClient({workerUrl,timeoutMs:30000,closeTimeoutMs:5000})
    const transport=new WorkerHostServicesTransport({nativeHostServices:(op,payload={})=>client.requestHost(op,payload),revokeHostIdentity:()=>client.requestHost('native.revoke',{})})
    let workerContexts=[]
    workerServices=new BrowserHostServices({runtime:transport,catalog,identity:{login:(payload,call)=>{workerContexts.push(call.context);return {code:'explicit-worker-probe-code'}}}})
    await workerServices.configure({...config,application:application(index.integrityRoot)})
    const loaded=await client.requestHost('load',{indexUrl:indexLocation.href,indexSha256:await hash(indexBytes),indexSize:indexBytes.length,renderer:'external-frame',engine:'quickjs',viewport:{width:windowWidth,height:windowHeight},metrics,hostServices:transport.configuration,loadTimeoutMs:30000})
    transport.activate(loaded)
    const pending=await client.requestHost('bridge',{envelope:envelope(client.sessionId,'api.call',{name:'wx.login'})})
    const workerUntil=performance.now()+10000;let batches=[]
    while(workerContexts.length===0||batches.length===0){batches.push(...await workerServices.drain());await new Promise(resolve=>setTimeout(resolve,5));check(performance.now()<workerUntil,'Worker native completion timed out')}
    check(workerContexts[0].sessionId===client.sessionId&&String(workerContexts[0].account.epoch)===config.account.epoch,'Worker/native context mismatch')
    report.checks.workerTransport={pending,batches,epoch:config.account.epoch,packRoot:index.integrityRoot}
    return report
  } finally {
    const errors=[]
    for(const [name,cleanup] of [['worker-services',()=>workerServices?.close()],['worker',()=>client?.close()],['direct-services',()=>services?.close()],['direct-host',()=>{if(host){host.unload();host.free()}}]]){
      try{await cleanup();report.cleanup.push({name,status:'closed'})}catch(error){errors.push(error);report.cleanup.push({name,status:'failed',message:error.message})}
    }
    if(errors.length)throw new AggregateError(errors,'browser probe cleanup failed')
  }
}
