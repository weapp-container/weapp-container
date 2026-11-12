// Explicit synthetic media evidence in real browser APIs, QuickJS/WASM and
// CanvasKit. Canvas-produced streams are not physical camera/device acceptance.
import initializeWasm, { WebWasmHost } from './pkg/container_host_web.js'
import { BrowserHostServices } from './browser-host-services.mjs'
import { CanvasKitFramePresenter } from './canvaskit-presenter.mjs'
import { WorkerRpcClient } from './worker-session-client.mjs'
import { WORKER_RENDERER_PINS } from './worker-admission-loader.mjs'

const check=(value,message)=>{if(!value)throw new Error(message)}
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`:JSON.stringify(value)
const encoder=new TextEncoder(), hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('')
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const fetchBytes=async url=>{const response=await fetch(url,{credentials:'omit',redirect:'error'});check(response.ok,`probe resource failed: ${url}`);return new Uint8Array(await response.arrayBuffer())}
const element=(tag,attrs={},children=[])=>({kind:'element',tag,attrs,bindings:[],children})
const findNodes=root=>[root,...root.children.flatMap(findNodes)]

async function rendererResources() {
  const config=JSON.parse(new TextDecoder().decode(await fetchBytes('./runtime-config.json')))
  check(config.renderer==='canvaskit'&&config.canvaskit?.version==='0.42.0','probe needs the pinned real CanvasKit build')
  const resources={},descriptors={...config.canvaskit,font:config.font?.binary,fontLicense:config.font?.license}
  for(const [key,pin] of Object.entries(WORKER_RENDERER_PINS)){
    const descriptor=descriptors[key];check(descriptor?.sha256===pin.sha256&&descriptor.size===pin.size,`renderer pin mismatch: ${key}`)
    const bytes=await fetchBytes(descriptor.url);check(bytes.length===pin.size&&await hash(bytes)===pin.sha256,`renderer bytes mismatch: ${key}`);resources[key]=bytes
  }
  const url=URL.createObjectURL(new Blob([resources.javascript,'\nexport default CanvasKitInit;\n'],{type:'text/javascript'})),wasm=URL.createObjectURL(new Blob([resources.wasm],{type:'application/wasm'}))
  try{const {default:init}=await import(url);return {CanvasKit:await init({locateFile:name=>{check(name==='canvaskit.wasm','unexpected renderer resource');return wasm}}),fontData:resources.font.buffer}}
  finally{URL.revokeObjectURL(url);URL.revokeObjectURL(wasm)}
}
async function encodedClip() {
  const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64
  const context=canvas.getContext('2d'),paint=()=>{context.fillStyle='#ff0000';context.fillRect(0,0,64,64)};paint()
  const stream=canvas.captureStream(15),mime=['video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm'].find(value=>MediaRecorder.isTypeSupported(value));check(mime,'real WebM encoder is unavailable')
  const recorder=new MediaRecorder(stream,{mimeType:mime}),chunks=[]
  const ended=new Promise((resolve,reject)=>{recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data)};recorder.onstop=resolve;recorder.onerror=reject})
  let timer
  try{recorder.start();timer=setInterval(paint,40);await delay(500);recorder.stop();await ended;const bytes=new Uint8Array(await new Blob(chunks,{type:mime}).arrayBuffer());check(bytes.length>0,'real media encoder produced no clip');return {bytes,mime}}
  finally{clearInterval(timer);if(recorder.state!=='inactive')recorder.stop();for(const track of stream.getTracks())track.stop();canvas.remove()}
}
async function fixture(clip, baseIndexUrl='./pack-index.json') {
  // Derive from an admitted schema rather than guessing serde's optional wire
  // fields. In particular empty Module.dependencies is omitted canonically.
  const indexLocation=new URL(baseIndexUrl,location.href),index=JSON.parse(new TextDecoder().decode(await fetchBytes(indexLocation)))
  const manifestBytes=await fetchBytes(new URL(index.manifest,indexLocation));check(await hash(manifestBytes)===index.manifestSha256,'base manifest digest mismatch')
  const base=JSON.parse(new TextDecoder().decode(manifestBytes));check(base.integrity.root===index.integrityRoot&&await hash(encoder.encode(canonical({...base,integrity:{...base.integrity,root:''}})))===index.integrityRoot,'base manifest root mismatch')
  const blobs={},add=async bytes=>{const sha=await hash(bytes);blobs[`sha256:${sha}`]=[...bytes];return sha}
  const app=encoder.encode('App({});exports.inspect=()=>({engine:typeof wx.createVideoContext});'),page=encoder.encode('Page({});')
  const route='pages/probe/index',templateId=`template:${route}.wxml`
  const ast={version:1,nodes:[element('view',{id:'root',style:'width:96px;height:64px;background-color:#ffffff;position:relative'},[
    element('view',{id:'clip',style:'width:80px;height:64px;overflow:hidden;position:relative'},[
      element('video',{id:'video',src:'../../assets/probe.webm',muted:'true',autoplay:'true',loop:'true',controls:'false',style:'position:absolute;left:0px;top:0px;width:64px;height:64px;z-index:0'}),
      element('camera',{id:'camera',style:'position:absolute;left:32px;top:0px;width:64px;height:64px;z-index:1'}),
      element('view',{id:'overlay',style:'position:absolute;left:44px;top:16px;width:16px;height:32px;background-color:#00ff00;z-index:2'})
    ])
  ])]}
  const appSha=await add(app),pageSha=await add(page),templateSha=await add(encoder.encode(canonical(ast))),clipSha=await add(clip.bytes)
  const manifest={...structuredClone(base),schemaVersion:1,protocolVersion:'1.0',compiler:{name:'weapp-vite',commit:'explicit-browser-media-probe',platform:'weapp'},app:{appJson:'app.json',entryModule:'module:app.js'},routes:[{id:`route:${route}`,path:route,kind:'page',entryModule:`module:${route}.js`}],
    modules:[{id:'module:app.js',sha256:appSha,format:'commonjs',scope:'app'},{id:`module:${route}.js`,sha256:pageSha,format:'commonjs',scope:'page'}],templates:[{id:templateId,wxmlAst:`sha256:${templateSha}`,bindings:[]}],styles:[],components:[],assets:[{path:'assets/probe.webm',sha256:clipSha,size:clip.bytes.length,mime:clip.mime}],capabilities:{'component:camera':'full','component:video':'full'},integrity:{algorithm:'sha256',root:''}}
  for(const field of ['viewScripts','viewCompilation','modernView','rendering'])delete manifest[field]
  manifest.integrity.root=await hash(encoder.encode(canonical(manifest)))
  return {manifest,blobs,route,templateId,clipSha}
}

/** Optional workerIndex points to an existing verified pack on the same server.
 * Its byte roundtrip uses an explicit manually presented slot, not a claim of
 * complete SDK/fixture media acceptance. All resources are closed in finally.
 */
export async function runHostServicesMediaBrowserProbe({catalog,CanvasKit,fontData,workerIndex='./pack-index.json',workerUrl='./runtime-worker.mjs'}={}) {
  check(catalog?.baseline?.baseLibrary==='3.17.3','locked catalog required')
  check(typeof HTMLCanvasElement.prototype.captureStream==='function'&&typeof MediaRecorder==='function','real media capture and encoding required')
  const clip=await encodedClip(),pack=await fixture(clip,workerIndex || './pack-index.json')
  if(!CanvasKit||!fontData)({CanvasKit,fontData}=await rendererResources())
  await initializeWasm()
  const report={classification:'synthetic-media-real-browser-quickjs-wasm-canvaskit',physicalCamera:'not-run',merchantTransaction:'not-run',checks:{},cleanup:[]}
  const root=document.createElement('div'),canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;root.append(canvas);document.body.append(root)
  const cameraCanvas=document.createElement('canvas');cameraCanvas.width=64;cameraCanvas.height=64
  const cameraContext=cameraCanvas.getContext('2d'),paintCamera=()=>{cameraContext.fillStyle='#0000ff';cameraContext.fillRect(0,0,64,64)};paintCamera()
  // captureStream emits changed canvas frames; keep producing after the video
  // begins playback so requestVideoFrameCallback never depends on first-frame timing.
  const cameraTimer=setInterval(paintCamera,50)
  const cameraStreams=[],diagnostics=[];let host,services,presenter,client,request=0,lastPresented='0'
  const envelope=(sessionId,op,payload)=>({protocolVersion:'1.0',sessionId,requestId:`media-${++request}`,kind:'request',op,payload})
  const ok=batch=>{const response=batch.messages.find(message=>message.kind==='response');check(response?.payload?.ok===true,JSON.stringify(batch));return response.payload}
  const dispatch=(op,payload)=>ok(JSON.parse(host.dispatch_json(JSON.stringify(envelope('media-probe',op,payload)))))
  const present=()=>{const revision=host.render_revision().toString();if(revision===lastPresented)return;presenter.submit(JSON.parse(host.render_frame_json()));const outcome=JSON.parse(host.acknowledge_presentation_outcome_json(BigInt(revision)));check(outcome.acknowledged===true,'real frame acknowledgement rejected');lastPresented=revision}
  const render=()=>{dispatch('render.commit',{templateId:pack.templateId,frameId:request+1,viewport:{x:0,y:0,width:96,height:64},blobs:pack.blobs});present()}
  const waitMedia=async()=>{const until=performance.now()+12000;for(;;){await services.drain();present();const frame=JSON.parse(host.render_frame_json());if(Object.keys(frame.images||{}).length>=2)return frame;check(performance.now()<until,'real media frame timed out '+JSON.stringify(diagnostics));await delay(20)}}
  try {
    host=new WebWasmHost();host.load_manifest_json_with_config(canonical(pack.manifest),JSON.stringify({session_id:'media-probe',engine:'quickjs',require_integrity:true,renderer_mode:'external-frame',host:{kind:'web',windowWidth:96,windowHeight:64}}))
    const environment={document,window,location,isSecureContext,OffscreenCanvas,fetch:fetch.bind(globalThis),Blob,File,setTimeout,clearTimeout,
      navigator:{mediaDevices:{async getUserMedia(){const stream=cameraCanvas.captureStream(15);cameraStreams.push(stream);return stream}}}}
    services=new BrowserHostServices({runtime:host,catalog,environment,componentRoot:root,onDiagnostic:error=>diagnostics.push(String(error))})
    await services.configure({application:{hostAppId:'media-probe',tenantId:'probe',publisherId:'explicit-fixture',appId:'media-app',environment:'trial',version:'probe',packRoot:pack.manifest.integrity.root},account:{principalId:'probe',epoch:'9007199254740993'}})
    const initialized=dispatch('app.init',{modules:pack.manifest.modules.map(module=>({id:module.id,bytes:pack.blobs[`sha256:${module.sha256}`]})),blobs:pack.blobs});check(initialized.engineProviderAvailable===true,'actual QuickJS unavailable')
    dispatch('app.lifecycle',{event:'launch'});dispatch('page.push',{path:pack.route})
    presenter=await CanvasKitFramePresenter.create(CanvasKit,canvas,fontData);render()
    const frame=await waitMedia(),nodes=findNodes(frame.root)
    check(nodes.filter(node=>['camera','video'].includes(node.tag)).every(node=>node.image?.resource.startsWith('weapp-native-component-frame:')),'media did not enter the ordinary image slots')
    check(root.querySelectorAll('video').length===0,'a visible media overlay replaced single-canvas composition')
    const pixels=presenter.snapshotEvidence().rgba,sample=(x,y)=>[...pixels.slice((y*96+x)*4,(y*96+x)*4+4)]
    const samples={video:sample(16,32),camera:sample(36,32),overlay:sample(50,32),clipped:sample(90,32)}
    check(samples.video[0]>160&&samples.video[1]<80&&samples.video[2]<80,'decoded packaged video is not visible')
    check(samples.camera[2]>160&&samples.camera[0]<80&&samples.camera[1]<80,'camera/sibling paint order is incorrect')
    check(samples.overlay[1]>160&&samples.overlay[0]<80&&samples.overlay[2]<80,'foreground sibling did not cover media')
    check(samples.clipped.slice(0,3).every(value=>value>240),'media escaped ancestor clip')
    report.checks.composition={samples,clipSha256:pack.clipSha,packRoot:pack.manifest.integrity.root,cameraStreams:cameraStreams.length,context:presenter.contextInfo()}
    dispatch('app.lifecycle',{event:'hide'});await services.drain();check(cameraStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')),'background camera still active');report.checks.hideStopsTracks=true
    dispatch('app.lifecycle',{event:'show'});render();await waitMedia();check(cameraStreams.length>=2,'foreground did not create a fresh camera owner')
    dispatch('page.pop',{});await services.drain();check(cameraStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')),'unmounted camera still active');report.checks.unmountStopsTracks=true
    dispatch('page.push',{path:pack.route});render();await waitMedia();await services.close();services=null
    check(cameraStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')),'revoked camera still active');check(JSON.parse(host.host_component_snapshots_json()).length===0,'revoked slots survived');report.checks.revocationStopsTracks=true
    if(workerIndex){
      const indexUrl=new URL(workerIndex,location.href),indexBytes=await fetchBytes(indexUrl),index=JSON.parse(new TextDecoder().decode(indexBytes))
      client=new WorkerRpcClient({workerUrl,timeoutMs:30000,closeTimeoutMs:5000})
      await client.requestHost('load',{indexUrl:indexUrl.href,indexSha256:await hash(indexBytes),indexSize:indexBytes.length,renderer:'external-frame',viewport:{width:96,height:64},hostServices:{application:{hostAppId:'media-probe',tenantId:'probe',publisherId:'explicit-fixture',appId:'worker-media',environment:'trial',version:'probe',packRoot:index.integrityRoot},account:{principalId:'probe',epoch:'1'},apis:['component:camera'],syncValues:{}}})
      const raw={frameId:1,viewport:{x:0,y:0,width:96,height:64},root:{id:'worker-camera',tag:'camera',bounds:{x:0,y:0,width:96,height:64},opacity:1,children:[]}}
      const batch=await client.requestHost('bridge',{envelope:envelope(client.sessionId,'render.commit',raw)});ok(batch)
      const current=await client.requestHost('frame.current',{});presenter.submit(current.frame);await client.requestHost('ack',{renderRevision:current.renderRevision})
      const slots=(await client.requestHost('native.components',{})).components;check(slots.length===1,'Worker slot not presented')
      const slot=slots[0],metadata={sessionId:client.sessionId,accountEpoch:'1',pageId:slot.pageId,nodeId:slot.nodeId,sequence:'1',width:1,height:1,format:'rgba8'},owned=new Uint8Array([200,10,20,255])
      const receipt=await client.requestHost('native.frame',{metadata,pixels:owned},{transfer:[owned.buffer]});check(receipt.accepted===true&&owned.byteLength===0,'real Worker byte transfer failed')
      const updated=await client.requestHost('frame.current',{});check(Object.values(updated.frame.images).some(image=>image.pixels[0]===200&&image.pixels[3]===255),'Worker pixels did not enter native render tree');report.checks.workerByteRoundtrip=true
      await client.requestHost('native.revoke',{});await client.close();client=null
    }
    return report
  } finally {
    const errors=[]
    for(const [name,cleanup] of [['worker',()=>client?.close()],['services',()=>services?.close()],['presenter',()=>presenter?.dispose()],['host',()=>{if(host){host.unload();host.free()}}],['camera-streams',()=>{clearInterval(cameraTimer);for(const stream of cameraStreams)for(const track of stream.getTracks())track.stop()}],['surface',()=>{root.remove();cameraCanvas.remove()}]]){
      try{await cleanup();report.cleanup.push({name,status:'closed'})}catch(error){errors.push(error);report.cleanup.push({name,status:'failed',message:String(error)})}
    }
    if(errors.length)throw new AggregateError(errors,'media probe cleanup failed')
  }
}
