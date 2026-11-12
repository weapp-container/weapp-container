/** Contract tests: actual WorkerWebSession, WorkerBridgeTransport
 * and integrity-checking admission loader. InMemoryCoordinatorTransport below
 * is explicitly a controlled JS DOUBLE of Rust DTO/state transitions. RPC, DOM
 * and scheduler/presenter are controlled doubles; this does
 * NOT run Rust, HTTP, generated WASM, a Worker, browser, presenter or GPU.
 * CanvasKit resources use explicitly fake SHA-by-length/zero bytes and finite
 * fake module/typeface/Blob URLs; this is not real drawing or font evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { BrowserDevOwnerManager } from '../examples/hosts/web-wasm/browser-dev-owner-manager.mjs'
import { WorkerWebSession, WORKER_OWNER_RENDER_SCALE_CONTRACT, WORKER_RENDER_SCALE_CONTRACT, INPUT_TIMING_CONTRACT } from '../examples/hosts/web-wasm/worker-web-session.mjs'
import { WorkerBridgeTransport } from '../examples/hosts/web-wasm/worker-bridge-transport.mjs'
import { createWorkerAdmissionLoader, WORKER_RENDERER_PINS } from '../examples/hosts/web-wasm/worker-admission-loader.mjs'

const baseUrl = 'http://127.0.0.1:58730/', route = 'pages/home/index'
const pin = value => value.repeat(64), runtimePin = pin('d')
const preview = { version: '1.0', runId: 'run-test', previewId: 'preview-test', leaseRevision: '3' }
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const clone = value => structuredClone(value)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b))).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const error = (code, message = code) => Object.assign(new Error(message), { code })
const deferred = () => { let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no}); void promise.catch(()=>{}); return {promise,resolve,reject} }
const tick = async () => { for(let i=0;i<100;i++) await Promise.resolve() }
const until = async predicate => { for(let i=0;i<3000&&!predicate();i++) await Promise.resolve(); assert.ok(predicate(),'expected controlled boundary was not reached') }
const hasCode = (failure,code) => failure?.code===code || [...(failure?.errors??[]),failure?.cause].some(value=>value&&hasCode(value,code))
const rect = (width=375,height=667) => ({x:0,y:0,width,height})
function controlledWait(actual,{signal}) {
  if(!signal) return actual
  if(signal.aborted) return Promise.reject(error('ERR_CANCELLED'))
  const abort=deferred(), listener=()=>abort.reject(error('ERR_CANCELLED'))
  signal.addEventListener('abort',listener,{once:true})
  return Promise.race([actual,abort.promise]).finally(()=>signal.removeEventListener('abort',listener))
}
class Element {
  constructor(document) { this.ownerDocument=document;this.children=[];this.style={};this.listeners=new Map();this.isConnected=true }
  append(child) {child.parent=this;this.children.push(child);child.isConnected=true}
  remove() {if(this.parent)this.parent.children=this.parent.children.filter(value=>value!==this);this.isConnected=false}
  setAttribute() {}
  addEventListener(name,listener) {const entries=this.listeners.get(name)??new Set();entries.add(listener);this.listeners.set(name,entries)}
  removeEventListener(name,listener) {this.listeners.get(name)?.delete(listener)}
}
function surface() {
  const document={hidden:false,baseURI:baseUrl};document.createElement=()=>new Element(document)
  const target=document.createElement();document.addEventListener=target.addEventListener.bind(target);document.removeEventListener=target.removeEventListener.bind(target)
  document.defaultView=document.createElement();return document.createElement()
}
function offered(siteId='1',{metrics,renderScale,startupMetricsRevision='7',transportBackend='browser-view'}={}) {
  const app=bytes(`App({version:${siteId}});`),appSha=sha256(app)
  const manifest={schemaVersion:3,protocolVersion:'1.0',compiler:{name:'weapp-vite',commit:`contract-${siteId}`,platform:'weapp'},
    app:{appJson:'app.json',entryModule:'app.js'},routes:[{id:`route:${route}`,path:route,kind:'page',entryModule:`${route}.js`}],
    modules:[{id:'module:app.js',sha256:appSha,format:'commonjs',scope:'app'}],templates:[],styles:[],assets:[],capabilities:{},
    rendering:{version:'1.0',default:transportBackend==='browser-view'?'webview':'skia',pages:{}},integrity:{algorithm:'sha256',root:''}}
  manifest.integrity.root=sha256(bytes(canonical(manifest)))
  const manifestBytes=bytes(manifest),manifestSha=sha256(manifestBytes)
  const index={schemaVersion:1,manifest:'./manifest.json',manifestSize:manifestBytes.length,manifestSha256:manifestSha,
    integrityRoot:manifest.integrity.root,blobs:[{sha256:appSha,size:app.length,url:`./blobs/${appSha}`} ]}
  const indexBytes=bytes(index),indexSha=sha256(indexBytes)
  const indexUrl=new URL(`/__weapp/pack/run-test/${siteId}/pack-index.json`,baseUrl).href
  const startupJson=JSON.stringify({schemaVersion:1,execution:'worker',engine:'quickjs',
    index:{url:'./pack-index.json',sha256:indexSha,size:indexBytes.length},viewport:{width:375,height:667},rendererPolicy:{mode:'manifest'},
    ...(metrics===undefined?{}:{metrics}),...(renderScale===undefined?{}:{renderScale}),...(transportBackend==='external-frame'?{rendererAssets:rendererConfig()}:{})})
  const site={version:'1.0',runId:'run-test',siteId,tokenId:sha256(bytes(`token:${siteId}`)),
    portable:{packGeneration:siteId,sourceRevision:siteId,compilerReceiptSequence:siteId,manifestSha256:manifestSha,
      integrityRoot:manifest.integrity.root,selectedRoute:route},
    runtime:{bundleSha256:runtimePin,producerReportSha256:pin('a'),sourceInventorySha256:pin('b'),sourceCommit:'a'.repeat(40)},
    startup:{revision:siteId,sha256:sha256(bytes(startupJson)),metricsRevision:startupMetricsRevision},
    index:{sha256:indexSha,size:String(indexBytes.length)},descriptorSha256:sha256(bytes(`descriptor:${siteId}`)),transportBackend,
    runtimeBaseUrl:`/__weapp/runtime/${runtimePin}/`,indexUrl,
    descriptorUrl:`/__weapp/site/run-test/${siteId}/site.json`}
  return {site,startupJson,pack:{manifest,index,indexBytes,indexSha,indexUrl,
    files:new Map([[indexUrl,indexBytes],[new URL('manifest.json',indexUrl).href,manifestBytes]])}}
}
function rendererConfig() {
  const resource=key=>({...WORKER_RENDERER_PINS[key],url:`/vendor/${key}`})
  return {schemaVersion:1,renderer:'canvaskit',fallback:'error',canvaskit:{version:'0.42.0',variant:'full',
    javascript:resource('javascript'),wasm:resource('wasm'),license:resource('license'),package:resource('package')},
    font:{binary:resource('font'),license:resource('fontLicense')}}
}
let rendererBytes
function fakeRendererResources() {
  if(!rendererBytes) {rendererBytes=new Map(Object.entries(WORKER_RENDERER_PINS).map(([key,pin])=>[key,new Uint8Array(pin.size)]))
    rendererBytes.get('package').fill(32);rendererBytes.get('package').set(bytes({name:'canvaskit-wasm',version:'0.42.0'}))}
  return rendererBytes
}
const offerValue = value => ({site:value.site,startupJson:value.startupJson})

/** Controlled transport DOUBLE, NOT the Rust coordinator or HTTP adapter.
 * It stores each exact command's immutable final for actual same-request replay;
 * snapshots deliberately omit StartTicket/startRevision like the Rust DTO. */
class InMemoryCoordinatorTransport {
  constructor(h,first) {this.h=h;this.rev=10n;this.terminal=0n;this.site=clone(first.site);this.current=true;this.stopped=false;this.owner=null;this.activation=null;this.closeTicket=null;this.ledger=new Map();this.requests=[];this.replays=[];this.previousOwnerClosed=false}
  bump() {
    this.need(!this.stopped,'run stopped')
    if(this.rev===18446744073709551615n){this.stopped=true;this.current=false;this.site=null;this.terminal=1n;if(this.activation?.phase!=='closing')this.activation=null;throw error('ERR_CANCELLED','authority exhausted')}
    return String(++this.rev)
  }
  cleanupBump() {
    if(!this.stopped&&this.rev<18446744073709551615n){this.rev++;return}
    if(!this.stopped){this.stopped=true;this.current=false;this.site=null;this.activation=null}
    this.need(this.terminal<18446744073709551615n,'cleanup exhausted');this.terminal++
  }
  snapshot() {return clone({version:'1.0',runId:'run-test',controlRevision:String(this.rev),terminalCleanupRevision:String(this.terminal),stopped:this.stopped,
    portable:this.site?.portable??null,portableCurrent:this.current,sitePhase:this.site?'ready':'absent',offeredSite:this.site,
    preview,ownerKey:this.owner?.key??null,ownerPhase:this.owner?.phase??null,ownerMatchesSource:!!this.owner&&this.owner.binding.siteId===this.site?.siteId,
    runtimePhase:this.owner?.runtime?'ready':this.owner?'starting':'absent',presentationPhase:this.owner?.presented?'ready':this.owner?'waiting-for-presentation':'absent',
    activationId:this.activation?.permit.binding.activationId??null,activationPhase:this.activation?.phase??null,
    runtimeReady:this.owner?.runtime??null,presentedReady:this.owner?.presented??null,sourceDiagnostic:null,siteDiagnostic:null,ownerDiagnostic:null,
    previousOwnerClosed:this.previousOwnerClosed})}
  offer(next) {this.bump();this.site=clone(next.site);this.current=true;this.activation=null}
  need(value,message) {if(!value)throw error('ERR_CANCELLED',message)}
  equal(a,b,message) {this.need(canonical(a)===canonical(b),message)}
  makeClose(replacement=null) {const ticket={version:'1.0',closeRevision:String(this.rev),terminalCleanupRevision:String(this.terminal),preview:clone(preview),owner:clone(this.owner.key),replacesWithActivation:replacement};this.closeTicket=ticket;this.owner.phase='closing';return clone(ticket)}
  transition(command,payload) {
    switch(command) {
      case 'snapshot':return this.snapshot()
      case 'issueActivation': {
        this.equal(payload.preview,preview,'lease');this.need(!this.stopped&&this.current&&this.site?.siteId===payload.siteId,'current offered site')
        this.need(payload.expectedControlRevision===String(this.rev)&&!this.activation&&!this.closeTicket,'approval/control boundary')
        const activationId=this.bump(),binding={version:'1.0',runId:'run-test',siteId:this.site.siteId,tokenId:this.site.tokenId,activationId,
          preview:clone(preview),startupRevision:this.site.startup.revision,runtimeBundleSha256:this.site.runtime.bundleSha256,indexSha256:this.site.index.sha256}
        const permit={binding,controlRevision:String(this.rev)};this.activation={permit,phase:'granted',site:clone(this.site)};return clone(permit)
      }
      case 'cancelActivation':this.equal(payload.preview,preview,'lease');this.equal(payload.permit,this.activation?.permit,'exact permit');this.need(this.activation.phase==='granted','unconsumed');this.bump();this.activation=null;return null
      case 'beginActivation': {
        this.equal(payload.permit,this.activation?.permit,'exact granted permit');this.need(this.activation.phase==='granted'&&payload.permit.controlRevision===String(this.rev),'stale control revision')
        const revision=this.bump()
        if(this.owner) {this.activation.phase='closing';return {kind:'close',instruction:this.makeClose(payload.permit.binding.activationId)}}
        this.activation.phase='start-allowed';this.activation.startRevision=revision
        return {kind:'start',instruction:{binding:clone(payload.permit.binding),startRevision:revision}}
      }
      case 'abandonStart':this.need(!this.owner&&!this.closeTicket&&this.activation?.phase==='start-allowed','unused only');this.equal(payload.ticket,{binding:this.activation.permit.binding,startRevision:this.activation.startRevision},'exact start');this.bump();this.activation=null;return null
      case 'startOwner': {
        this.need(!this.stopped&&!this.owner&&!this.closeTicket&&this.activation?.phase==='start-allowed','empty start slot')
        this.equal(payload.ticket,{binding:this.activation.permit.binding,startRevision:this.activation.startRevision},'exact start')
        this.need(this.site?.siteId===payload.ticket.binding.siteId&&this.current,'current start source')
        const key={activationId:payload.ticket.binding.activationId,ownerSerial:this.bump(),clientOwnerId:payload.clientOwnerId}
        this.owner={key,binding:clone(payload.ticket.binding),site:clone(this.site),phase:'starting',runtime:null,presented:null};this.activation=null
        return {binding:clone(this.owner.binding),owner:clone(key)}
      }
      case 'runtimeReady':this.equal(payload.ownerKey,this.owner?.key,'registered owner');this.equal(payload.binding,this.owner.binding,'binding');this.need(payload.engineProvider==='quickjs-wasm'&&payload.owner.packSha256===this.owner.site.index.sha256,'actual engine/pin');this.bump();this.owner.phase='runtime-ready';this.owner.runtime=clone(payload);return null
      case 'presentedReady':this.equal(payload.ownerKey,this.owner?.key,'registered owner');this.need(this.owner.runtime&&payload.acceptedCurrent&&payload.inputEnabled,'accepted runtime');this.need(payload.metricsRevision===this.owner.site.startup.metricsRevision,'server metrics namespace');this.bump();this.owner.phase='presented';this.owner.presented=clone(payload);return null
      case 'failOwner':this.equal(payload.ownerKey,this.owner?.key,'registered owner');this.need(!this.closeTicket,'one exact close');this.cleanupBump();this.activation=null;return this.makeClose()
      case 'finishClose': {
        this.equal(payload.ticket,this.closeTicket,'exact close ticket');this.equal(payload.ticket.owner,this.owner?.key,'exact closing owner');this.cleanupBump();this.closeTicket=null
        if(!payload.closeFinal.success) {this.owner.phase='close-uncertain';this.activation=null;return null}
        this.need(payload.closeFinal.evidenceOrigin==='browser-reported'&&!payload.closeFinal.pendingActual,'verified close origin')
        this.owner=null;this.previousOwnerClosed=true
        if(this.activation?.phase==='closing'&&this.site?.siteId===this.activation.permit.binding.siteId&&this.current) {
          this.activation.phase='start-allowed';this.activation.startRevision=String(this.rev)
          return {binding:clone(this.activation.permit.binding),startRevision:String(this.rev)}
        }
        this.activation=null;return null
      }
      case 'stop':if(this.stopped&&(this.closeTicket||!this.owner))return this.closeTicket?clone(this.closeTicket):null;this.cleanupBump();this.stopped=true;this.current=false;this.site=null;this.activation=null;return this.closeTicket?clone(this.closeTicket):this.owner?this.makeClose():null
      default:throw error('ERR_PROTOCOL_VERSION',`double does not implement ${command}`)
    }
  }
  async invoke(request) {
    const cleanup=['cancelActivation','finishClose','abandonStart','failOwner','retryClose','stop'].includes(request.command)
    const match=/^(.+):(control|cleanup)-([1-9][0-9]*)$/.exec(request.requestId)
    this.need(match&&match[2]===(cleanup?'cleanup':'control'),'command must use its fixed canonical request namespace')
    this.need(match[1]===(this.h.managerOptions?.clientId??'browser-client'),'request must belong to the registered client')
    this.highest??={control:0n,cleanup:0n}
    const serial=BigInt(match[3])
    this.need(serial<=18446744073709551615n&&serial>this.highest[match[2]],'lane serial must be bounded and above its independent highwater')
    this.highest[match[2]]=serial
    this.need(!this.ledger.has(request.requestId),'request id must never mutate twice');this.requests.push(request);this.h.log.push(`control:${request.command}`)
    this.h.beforeControl?.(request,this)
    let final
    try {const result=this.transition(request.command,request.payload);final={version:'1.0',requestId:request.requestId,command:request.command,status:'ok',result,snapshot:this.snapshot()}}
    catch(failure) {final={version:'1.0',requestId:request.requestId,command:request.command,status:'error',error:{code:failure.code??'ERR_ENGINE',message:failure.message},snapshot:this.snapshot()}}
    this.ledger.set(request.requestId,{request:clone(request),final:clone(final)})
    if(this.h.onReply)return this.h.onReply(request,clone(final),this)
    return clone(final)
  }
  async replay(request) {
    this.replays.push(request);const stored=this.ledger.get(request.requestId)
    if(this.h.onReplay)return this.h.onReplay(request,stored?clone(stored.final):null,this)
    this.need(stored,'no genuine final exists for a never-invoked request');this.equal(request,stored.request,'same immutable replay request');return clone(stored.final)
  }
}

// Retirement protocol DOUBLE. Real HTTP hashing/cleanup and Rust ledger
// atomicity are tested separately; this binds the manager's exact command refs.
function retirementTransport(h) {
  const transport=h.control,acked=new Set(),lanes={normal:{through:'0',last:null},cleanup:{through:'0',last:null}}
  transport.capabilities=Object.freeze({retirementVersion:'1.0'});h.retirementCalls=[]
  transport.acknowledge=async(request,raw)=>{
    await h.acknowledge?.(request,raw,h)
    const stored=transport.ledger.get(request.requestId)
    assert.ok(stored);assert.deepEqual(raw,stored.final);acked.add(request.requestId)
  }
  transport.retire=requests=>{
    h.retirementCalls.push(requests)
    const commit=()=>{
      const laneName=requests[0].requestId.includes(':cleanup-')?'cleanup':'normal',lane=lanes[laneName]
      const ids=requests.map(request=>request.requestId)
      if(lane.last&&canonical(lane.last.ids)===canonical(ids))return lane.last.receipt
      const prefix=[...transport.ledger.values()].filter(value=>(value.request.requestId.includes(':cleanup-')?'cleanup':'normal')===laneName).slice(0,requests.length)
      assert.equal(prefix.length,requests.length)
      for(let i=0;i<requests.length;i++){
        assert.equal(prefix[i].request.requestId,ids[i]);assert.deepEqual(prefix[i].request,requests[i]);assert.ok(acked.has(ids[i]))
      }
      const throughSerial=ids.at(-1).split('-').at(-1)
      const transcript=`weapp-control-retirement-v1\nrun-test\n${h.managerOptions?.clientId??'browser-client'}\n${laneName}\n${lane.through}\n${throughSerial}\n`
        +prefix.map(value=>`${value.request.requestId}:${sha256(bytes(value.final))}\n`).join('')
      const receipt=Object.freeze({version:'1.0',runId:'run-test',clientId:h.managerOptions?.clientId??'browser-client',lane:laneName,
        previousThrough:lane.through,throughSerial,prefixSha256:sha256(bytes(transcript)),retiredCount:requests.length,outcome:'retired'})
      for(const key of ids){transport.ledger.delete(key);acked.delete(key)}
      lane.through=throughSerial;lane.last={ids,receipt};return receipt
    }
    return h.retire?h.retire(requests,h,commit):Promise.resolve(commit())
  }
}

function ownerFixture(options,h) {
  const id=String(h.entries.length+1),e={id,hooks:options,session:null,owner:null,raw:null,scheduler:null,closeGate:null,loadGate:null,failLoad:null,calls:[],observation:null}
  const adapter={setOwnerInputFence:({revision,blocked})=>({version:'1.0',revision,blocked}),acceptsOwnerInput:()=>false,
    receiveObservation(){},prepareTemplate:async()=>({candidate:true}),preparePaint:async()=>({candidate:true}),
    present:async()=>({acknowledged:true,inputEnabled:true}),release(){},freezeInput(){},
    suspendOwnedSurface:async()=>({version:'1.0',suspended:true}),resumeOwnedSurface:()=>({version:'1.0',readyForFreshSurface:true}),
    cancelOwnedWork:async()=>{},dispose:async()=>({closed:true})}
  e.session=new WorkerWebSession({...options,requestFrame(){throw Error('controlled scheduler owns no RAF')},cancelFrame(){},factories:{
    rpc(config) {
      h.workers++;h.log.push(`worker:${id}`);e.rpcHooks=config
      e.raw={workerEpoch:`epoch-${id}`,sessionId:`session-${id}`,actualFinalContract:'1.0',closes:0,
        async requestHost(op,payload) {
          e.calls.push(op)
          if(op==='load') {
            e.loadPayload=clone(payload)
            if(e.loadGate)await e.loadGate.promise;if(e.failLoad)throw e.failLoad
            const p=h.packsByPin.get(payload.indexSha256);assert.ok(p,'RPC double uses the same real admitted pack')
            const backend=p.manifest.rendering.default==='webview'?'browser-view':'external-frame',profile=p.manifest.rendering.default
            const textFont=payload.textFont
            if(textFont!==undefined) {
              const font=rendererConfig().font.binary
              assert.deepEqual(textFont,{version:'1.0',profile:'sfnt-unhinted-v1',url:new URL(font.url,baseUrl).href,sha256:font.sha256,size:font.size},
                'RPC double accepts only the exact admitted renderer font')
            }
            e.owner={workerEpoch:this.workerEpoch,sessionId:this.sessionId,packSha256:payload.indexSha256,transportBackend:backend}
            e.observation={version:'1.0',sequence:'1',state:{owner:e.owner,sessionId:e.owner.sessionId,transportBackend:backend,surfaceGeneration:'1',
              inputLifetimeRevision:'1',templateRevision:'1',renderRevision:'0',viewRevision:'1',viewport:rect(),lifecycle:'Active',rendererProfile:profile,declaredRendererProfile:profile,requiresRestart:false,currentPage:{pageId:'1',path:route}}}
            return {state:clone(e.observation.state),capabilities:{quickjs:true},manifest:clone(p.manifest),renderer:backend,transportBackend:backend,viewport:rect(),
              pack:{indexSha256:p.indexSha,manifestSha256:p.index.manifestSha256,integrityRoot:p.manifest.integrity.root,blobsDownloaded:0,downloadedBytes:100},
              declaredProfile:profile,effectiveProfile:profile,rendererPolicy:payload.rendererPolicy,
              ...(backend==='external-frame'?{externalPresentation:{version:'1.0',consumedInput:'1.0',ackOutcome:'1.0',physicalTarget:'1.0'},surfaceRecovery:{version:'1.0',retainedExternalFrame:'1.0'}}:{}),
              ...(payload.renderScale===undefined?{}:{renderScaleContract:clone(WORKER_RENDER_SCALE_CONTRACT)}),
              ...(payload.inputTiming===undefined?{}:{inputTiming:clone(INPUT_TIMING_CONTRACT)}),
              ...(textFont===undefined?{}:{textFont:{sha256:textFont.sha256,face_index:0,profile:textFont.profile}}),
              observationContract:{version:'1.0',sequence:'u64',surfaceGeneration:'1.0',inputLifetime:'1.0'},observation:clone(e.observation)}
          }
          if(op==='bridge')return {messages:[{...payload.envelope,kind:'response',payload:{ok:true,owner:id}}],observation:clone(e.observation)}
          if(op==='metrics') {e.observation.sequence=String(BigInt(e.observation.sequence)+1n);e.observation.state.viewport=rect(payload.windowWidth,payload.windowHeight);return {messages:[],observation:clone(e.observation)}}
          if(op==='state')return {state:clone(e.observation.state),observation:clone(e.observation)}
          throw Error(`unexpected fake RPC operation ${op}`)
        },
        async close() {this.closes++;h.log.push(`close-start:${id}`);h.onRawClose?.(e);if(e.closeGate)await e.closeGate.promise;h.log.push(`close-final:${id}`);return {closed:true}},
      };return e.raw
    },bridge:config=>new WorkerBridgeTransport(config),domAdapter:()=>adapter,
    canvasAdapter(config) {e.assetOptions=config;h.canvasCreates++;h.log.push(`canvas:${id}`);h.onCanvas?.(e,config);return adapter},
    scheduler(config) {
      e.scheduler={status:{phase:'idle',accepted:null},observe(value){this.latest=value},suspend(){this.status={phase:'idle',accepted:null};config.onState(this.status)},resume(){},
        suspendOwnedSurface:async()=>({version:'1.0',recoveryId:'1'}),resumeOwnedSurface(){},retry(){},close:async()=>({closed:true}),
        async accept(inputEnabled=true,proofChanges={}) {
          const context={isCurrent:()=>true},candidate=await config.adapter.prepareTemplate({},context)
          await config.adapter.present(candidate,context);await config.adapter.release(candidate,context)
          this.status={phase:'presented',accepted:{hardKey:`key-${id}`,inputEnabled,proof:{version:'1.0',owner:e.owner,attemptId:'1',surfaceGeneration:'1',
            consumedInput:{pageId:'1',routePath:route,templateRevision:e.observation.state.templateRevision,viewport:clone(e.observation.state.viewport)},
            publication:e.owner.transportBackend==='browser-view'?{kind:'browser-view',key:{sessionId:e.owner.sessionId,pageId:'1',documentRevision:'3',presentationRevision:'5',surfaceGeneration:'1',profile:'webview'}}:{kind:'external-frame',renderRevision:'5'},...proofChanges}}}
          config.onState(this.status)
        },fault(){config.onState({phase:'faulted'})}};return e.scheduler
    },
  }})
  h.entries.push(e);return e
}
function harness(options={}) {
  const first=options.first??offered(),h={entries:[],workers:0,imports:0,fetched:[],errors:[],states:[],batches:[],log:[],packsByPin:new Map(),files:new Map(),
    preparations:[],borrows:[],canvasCreates:0,renderer:{imports:0,initializes:0,decodes:0,deletes:0,created:[],revoked:[],module:null},...options}
  h.renderer.module={finiteFakeOnly:true,Typeface:{MakeTypefaceFromData(){h.renderer.decodes++;return h.fontProbe?h.fontProbe(h):{delete(){h.renderer.deletes++}}}}}
  h.install=p=>{h.packsByPin.set(p.pack.indexSha,p.pack);for(const [url,value]of p.pack.files)h.files.set(url,value)};h.install(first)
  h.control=new InMemoryCoordinatorTransport(h,first)
  if(options.retirement)retirementTransport(h)
  else if(options.acknowledge)h.control.acknowledge=(request,raw)=>options.acknowledge(request,raw,h)
  h.publish=p=>{h.install(p);h.control.offer(p);return offerValue(p)}
  h.runtime={ownerRenderScaleContract:WORKER_OWNER_RENDER_SCALE_CONTRACT,renderScaleContract:WORKER_RENDER_SCALE_CONTRACT,inputTimingContract:INPUT_TIMING_CONTRACT,createLoader({baseUrl}) {
    const loader=createWorkerAdmissionLoader({baseUrl,sha256:async value=>Object.values(WORKER_RENDERER_PINS).find(pin=>pin.size===value.length)?.sha256??sha256(value),fetch:async(url,init)=>{
      h.fetched.push({url,init});if(h.fetchHook)return h.fetchHook(url,init,h)
      const value=h.files.get(url)??fakeRendererResources().get(new URL(url).pathname.split('/').at(-1));assert.ok(value,`unexpected real loader resource ${url}`)
      return new Response(value,{headers:{'content-length':String(value.length)}})
    },makeBlob:(parts,details)=>({parts,type:details.type}),createObjectURL:value=>{
      const url=`blob:manager-fake/${h.renderer.created.length+1}`;h.renderer.created.push({url,value});return url},
    revokeObjectURL:async url=>{h.renderer.revoked.push(url);await h.onRevoke?.(url,h)},
    importModule:async()=>{h.renderer.imports++;if(h.onDrawingImport)return h.onDrawingImport(h)
      return {default:async()=>{h.renderer.initializes++;h.log.push('renderer-init');return h.onDrawingInit?h.onDrawingInit(h):h.renderer.module}}}})
    h.loader=loader
    return {admitWorkerPack:loader.admitWorkerPack,async preparePinnedRendererAssets(config){
      h.preparations.push(config);h.log.push('renderer-prepare');h.beforePreparation?.(config,h)
      const lease=await loader.preparePinnedRendererAssets(config);h.log.push('renderer-prepared')
      if(h.afterPreparation)await h.afterPreparation(lease,config,h);return lease
    },async loadPinnedCanvasKit(config){h.borrows.push(config);h.log.push('renderer-borrow')
      const borrowed=await loader.loadPinnedCanvasKit(config);if(h.afterBorrow)await h.afterBorrow(borrowed,config,h);return borrowed}}
  },createSession(config) {h.onBeforeConstruct?.(config);const e=ownerFixture(config,h);h.onConstruct?.(e);return e.session}}
  h.manager=new BrowserDevOwnerManager({surfaceRoot:surface(),baseUrl,preview,clientId:'browser-client',sha256,
    runBounded:(actual,details)=>h.runBounded?h.runBounded(actual,details):controlledWait(actual,details),
    importRuntime:async()=>{h.imports++;if(h.importGate)await h.importGate.promise;return h.runtime},control:h.control,
    onState:state=>{h.states.push(state);h.onState?.(state)},onError:value=>h.errors.push(value),onBatch:value=>h.batches.push(value),...h.managerOptions})
  return h
}
const commands=h=>h.control.requests.map(request=>request.command)
const nonceAt=serial=>`00000000-0000-4000-8000-${serial.toString(16).padStart(12,'0')}`
const nonceOne=nonceAt(1),nonceTwo=nonceAt(2)
const mockIdentityEntropy=t=>{let serial=0;return t.mock.method(globalThis.crypto,'randomUUID',()=>nonceAt(++serial))}
function assertOwnerIdentity(value,clientId='browser-client') {
  assert.equal(typeof value,'string');assert.equal(value.startsWith(`${clientId}:owner-`),true)
  assert.match(value.slice(clientId.length+7),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.ok(new TextEncoder().encode(value).length<=128)
}

test('manager preserves the pinned Skia startup density through its real Worker owner',async()=>{
  for(const renderScale of [2,'auto']) {
    const first=offered('1',{transportBackend:'external-frame',renderScale}),h=harness({first})
    try {
      await h.manager.offer(offerValue(first)).ready
      assert.equal(h.entries[0].loadPayload.renderScale,renderScale==='auto'?1:2)
      assert.deepEqual(h.entries[0].loadPayload.viewport,{width:375,height:667})
      assert.equal(h.entries[0].calls.includes('scale'),false)
    } finally {await h.manager.close()}
  }
})

test('manager hands fractional auto density to its real replacement owner without re-sampling',async()=>{
  for(const density of [1.25,1.75]) {
    const root=surface();root.ownerDocument.defaultView.devicePixelRatio=1
    const first=offered('1',{transportBackend:'external-frame',renderScale:2}),h=harness({first,managerOptions:{surfaceRoot:root}})
    try {
      await h.manager.offer(offerValue(first)).ready
      const old=h.entries[0],next=offered('2',{transportBackend:'external-frame',renderScale:'auto'})
      root.ownerDocument.defaultView.devicePixelRatio=density
      h.onBeforeConstruct=()=>{root.ownerDocument.defaultView.devicePixelRatio=4}
      h.onConstruct=e=>{const load=e.session.load.bind(e.session);e.session.load=options=>{e.loadOptions=options;return load(options)}}
      await h.manager.offer(h.publish(next)).ready
      assert.equal(old.raw.closes,1)
      assert.deepEqual(h.entries[1].loadOptions.renderScale,{version:'1.0',mode:'captured-auto',requested:'auto',displayDensity:density,effectiveScale:density})
      assert.equal(Object.isFrozen(h.entries[1].loadOptions.renderScale),true)
      assert.equal(h.entries[1].loadPayload.renderScale,density)
      assert.deepEqual(h.entries[1].loadPayload.renderScaleContract,{version:'1.0'})
      assert.equal(h.entries[1].calls.includes('scale'),false)
      assert.equal(h.entries[1].session.status.runtimeReady,true)
    } finally {await h.manager.close()}
  }
})

test('invalid public fractional and captured-auto startup targets preserve the exact ready owner without a tick',async()=>{
  for(const renderScale of [1.25,1.75,{version:'1.0',mode:'captured-auto',requested:'auto',displayDensity:1.25,effectiveScale:1.25}]) {
    const first=offered('1',{transportBackend:'external-frame',renderScale:2}),h=harness({first})
    try {
      const ready=await h.manager.offer(offerValue(first)).ready,old=h.entries[0]
      const next=offered('2',{transportBackend:'external-frame',renderScale})
      await assert.rejects(h.manager.offer(h.publish(next)).ready,error=>hasCode(error,'ERR_PROTOCOL_VERSION'))
      assert.equal(old.raw.closes,0);assert.equal(h.entries.length,1)
      const result=await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{name:'wx.canIUse',args:['fixture']}})
      assert.equal(result.result.owner,old.id)
    } finally {await h.manager.close()}
  }
})

test('a pinned producer must explicitly declare exact owner and Worker density semantics before retiring a live owner',async()=>{
  for(const [field,value]of [['ownerRenderScaleContract',undefined],['renderScaleContract',undefined],
    ['ownerRenderScaleContract',{...WORKER_OWNER_RENDER_SCALE_CONTRACT,version:'0.9'}],
    ['ownerRenderScaleContract',{...WORKER_OWNER_RENDER_SCALE_CONTRACT,extra:true}],
    ['renderScaleContract',{...WORKER_RENDER_SCALE_CONTRACT,version:'2.0'}],
    ['renderScaleContract',{...WORKER_RENDER_SCALE_CONTRACT,startup:'after-first-export'}],
    ['renderScaleContract',{...WORKER_RENDER_SCALE_CONTRACT,extra:true}]]) {
    const first=offered('1',{transportBackend:'external-frame',renderScale:2}),h=harness({first})
    try {
      const ready=await h.manager.offer(offerValue(first)).ready,old=h.entries[0],preparations=h.preparations.length
      const next=offered('2',{transportBackend:'external-frame',renderScale:'auto'})
      // Distinct immutable bundle: changing a cached module would not model an
      // older pinned producer. Its methods may exist but declare no scale ABI.
      next.site.runtime.bundleSha256=pin('e');next.site.runtimeBaseUrl=`/__weapp/runtime/${pin('e')}/`
      if(value===undefined)delete h.runtime[field];else h.runtime[field]=value
      await assert.rejects(h.manager.offer(h.publish(next)).ready,error=>hasCode(error,'ERR_PROTOCOL_VERSION'))
      assert.equal(h.imports,2);assert.equal(h.preparations.length,preparations)
      assert.equal(old.raw.closes,0);assert.equal(h.entries.length,1);assert.equal(old.session.status.runtimeReady,true)
      const result=await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{name:'wx.canIUse',args:['fixture']}})
      assert.equal(result.result.owner,old.id)
    } finally {await h.manager.close()}
  }
})

test('older producer without density declarations remains compatible when no scale is requested',async()=>{
  const h=harness();delete h.runtime.ownerRenderScaleContract;delete h.runtime.renderScaleContract
  try {await h.manager.offer(offerValue(offered())).ready;assert.equal(h.entries[0].session.status.runtimeReady,true)}
  finally {await h.manager.close()}
})

test('optional causal diagnostics require a declared pinned ABI before live owner retirement',async()=>{
  for(const declaration of [undefined,{...INPUT_TIMING_CONTRACT,version:'2.0'},{...INPUT_TIMING_CONTRACT,compositor:'presented'}]) {
    const first=offered('1',{transportBackend:'external-frame'}),h=harness({first,managerOptions:{inputTiming:{version:'1.0'}}})
    try {
      const ready=await h.manager.offer(offerValue(first)).ready,old=h.entries[0]
      assert.deepEqual(old.loadPayload.inputTiming,{version:'1.0'})
      const report=h.manager.inputTimingReport({ownerKey:ready.ownerKey})
      assert.equal(report.report.gate.status,'blocked');assert.equal(report.report.gate.inputToPresentP95Ms,null)
      assert.throws(()=>h.manager.inputTimingReport({ownerKey:'other-owner'}),error=>hasCode(error,'ERR_CANCELLED'))
      const next=offered('2',{transportBackend:'external-frame'})
      next.site.runtime.bundleSha256=pin('e');next.site.runtimeBaseUrl=`/__weapp/runtime/${pin('e')}/`
      if(declaration===undefined)delete h.runtime.inputTimingContract;else h.runtime.inputTimingContract=declaration
      const preparations=h.preparations.length
      await assert.rejects(h.manager.offer(h.publish(next)).ready,error=>hasCode(error,'ERR_PROTOCOL_VERSION'))
      assert.equal(old.raw.closes,0);assert.equal(h.entries.length,1);assert.equal(h.preparations.length,preparations)
      const result=await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{name:'wx.canIUse',args:['fixture']}})
      assert.equal(result.result.owner,old.id)
    } finally {await h.manager.close()}
  }
})

test('diagnostics remain absent for legacy callers and reject DOM before construction',async()=>{
  const h=harness()
  try {
    const ready=await h.manager.offer(offerValue(offered())).ready
    assert.equal(Object.hasOwn(h.entries[0].loadPayload,'inputTiming'),false)
    assert.equal(h.manager.inputTimingReport({ownerKey:ready.ownerKey}).report,null)
  } finally {await h.manager.close()}
  const dom=harness({managerOptions:{inputTiming:{version:'1.0'}}})
  try {await assert.rejects(dom.manager.offer(offerValue(offered())).ready,error=>hasCode(error,'ERR_PROTOCOL_VERSION'));assert.equal(dom.entries.length,0)}
  finally {await dom.manager.close()}
})

test('manager rejects incompatible startup density before constructing a replacement owner',async()=>{
  for(const [backend,renderScale]of [['browser-view',2],['external-frame',0],['external-frame','2']]) {
    const first=offered('1',{transportBackend:backend,renderScale}),h=harness({first})
    try {await assert.rejects(h.manager.offer(offerValue(first)).ready,/startup renderScale/);assert.equal(h.entries.length,0)}
    finally {await h.manager.close()}
  }
})

test('automatic density budget is checked before retiring the exact live owner',async()=>{
  const root=surface();root.ownerDocument.defaultView.devicePixelRatio=3
  const first=offered('1',{transportBackend:'external-frame',renderScale:2}),h=harness({first,managerOptions:{surfaceRoot:root}})
  try {
    const ready=await h.manager.offer(offerValue(first)).ready
    const old=h.entries[0],next=offered('2',{transportBackend:'external-frame',renderScale:'auto'})
    const startup=JSON.parse(next.startupJson);startup.viewport={width:1100,height:1100}
    next.startupJson=JSON.stringify(startup);next.site.startup.sha256=sha256(bytes(next.startupJson))
    await assert.rejects(h.manager.offer(h.publish(next)).ready,/physical target budget/)
    assert.equal(h.entries.length,1);assert.equal(old.raw.closes,0)
    assert.equal(old.session.status.runtimeReady,true)
    const result=await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{name:'wx.canIUse',args:['fixture']}})
    assert.equal(result.result.owner,old.id)
  } finally {await h.manager.close()}
})

test('fresh managers with the same client and preview retain distinct per-entry owner identities',async t=>{
  const random=mockIdentityEntropy(t)
  const first=harness(),second=harness()
  try {
    await first.manager.offer(offerValue(offered())).ready
    const beforeSecond=random.mock.callCount()
    await second.manager.offer(offerValue(offered())).ready
    const a=first.control.requests.find(value=>value.command==='startOwner')
    const b=second.control.requests.find(value=>value.command==='startOwner')
    assert.equal(first.manager.status.clientId,second.manager.status.clientId)
    assert.deepEqual(first.manager.status.preview,second.manager.status.preview)
    assert.equal(a.requestId,b.requestId);assert.deepEqual(a.payload.ticket,b.payload.ticket)
    assert.notEqual(a.payload.clientOwnerId,b.payload.clientOwnerId)
    assert.equal(a.payload.clientOwnerId,`browser-client:owner-${nonceOne}`)
    assert.equal(b.payload.clientOwnerId,`browser-client:owner-${nonceAt(beforeSecond+1)}`)
    assertOwnerIdentity(a.payload.clientOwnerId);assertOwnerIdentity(b.payload.clientOwnerId)
    assert.equal(Object.isFrozen(a.payload),true);assert.equal(Object.isFrozen(b.payload),true)
    assert.ok(random.mock.callCount()>beforeSecond)
  } finally { await Promise.all([first.manager.close(),second.manager.close()]) }
})

test('inert owner random identity remains bounded for the maximum trusted client identity',async t=>{
  const random=mockIdentityEntropy(t),clientId='c'.repeat(64)
  const h=harness({managerOptions:{clientId}})
  try {
    await h.manager.offer(offerValue(offered())).ready
    const start=h.control.requests.find(value=>value.command==='startOwner')
    assertOwnerIdentity(start.payload.clientOwnerId,clientId)
    assert.equal(start.payload.clientOwnerId.length,107)
    assert.equal(start.payload.clientOwnerId,`${clientId}:owner-${nonceOne}`)
    assert.ok(random.mock.callCount()>=1,'the real bridge may independently allocate its own request correlation prefix')
  } finally { await h.manager.close() }
})

test('missing or malformed cryptographic entropy cannot register an inert owner with a predictable fallback',async t=>{
  let source
  t.mock.getter(globalThis,'crypto',()=>({randomUUID:source}))
  for(const value of [undefined,()=> 'not-a-random-uuid',()=> 'f'.repeat(129)]) {
    source=value;const h=harness()
    try {
      const ticket=h.manager.offer(offerValue(offered()))
      await assert.rejects(ticket.ready,failure=>hasCode(failure,'ERR_PROTOCOL_VERSION'))
      await until(()=>commands(h).includes('abandonStart'))
      assert.equal(commands(h).includes('startOwner'),false);assert.equal(h.workers,0);assert.equal(h.entries.length,0)
      assert.equal(h.control.owner,null)
    } finally { await h.manager.close() }
  }
})

test('snapshot refresh shares bounded command serials with concurrent offers without replacing desired intent',async()=>{
  const h=harness()
  try {
    const firstPoll=h.manager.refreshSnapshot(),ticket=h.manager.offer(offerValue(offered())),secondPoll=h.manager.refreshSnapshot()
    const [a,b]=await Promise.all([firstPoll,secondPoll,ticket.ready]);await tick()
    assert.equal(Object.isFrozen(a),true);assert.equal(Object.isFrozen(b),true)
    assert.equal(h.workers,1);assert.equal(h.manager.status.desired,ticket.identity)
    const desired=h.manager.status.desired,key=h.manager.status.executing.ownerKey
    const refreshed=await h.manager.refreshSnapshot()
    assert.deepEqual(refreshed.ownerKey,key);assert.equal(h.manager.status.desired,desired)
    assert.equal(h.entries[0].raw.closes,0);assert.equal(h.manager.status.executing.runtimeReady,true)
    const requests=h.control.requests.filter(value=>!['cancelActivation','finishClose','abandonStart','failOwner','retryClose','stop'].includes(value.command))
    assert.deepEqual(requests.map(value=>value.requestId),requests.map((_,index)=>`browser-client:control-${index+1}`))
    assert.equal(new Set(requests.map(value=>value.requestId)).size,requests.length)
  } finally { await h.manager.close() }
})

test('snapshot refresh queued behind actual startup cannot bypass it or invoke after close',async()=>{
  const loadGate=deferred(),h=harness({onConstruct:e=>{e.loadGate=loadGate}})
  const ticket=h.manager.offer(offerValue(offered()))
  await until(()=>h.entries[0]?.calls.includes('load'))
  const readyFailed=assert.rejects(ticket.ready,failure=>hasCode(failure,'ERR_CANCELLED'))
  const before=h.control.requests.filter(value=>value.command==='snapshot').length
  const refreshing=h.manager.refreshSnapshot();let settled=false
  void refreshing.then(()=>{settled=true},()=>{settled=true})
  await tick();assert.equal(settled,false)
  const refreshFailed=assert.rejects(refreshing,failure=>hasCode(failure,'ERR_CANCELLED'))
  const closing=h.manager.close()
  await assert.rejects(h.manager.refreshSnapshot(),failure=>hasCode(failure,'ERR_CANCELLED'))
  loadGate.resolve()
  await Promise.all([readyFailed,refreshFailed,closing])
  assert.equal(h.control.requests.filter(value=>value.command==='snapshot').length,before)
  assert.equal(h.workers,1);assert.equal(h.entries[0].raw.closes,1)
  assert.equal(h.manager.status.uncertain,null)
  await assert.rejects(h.manager.refreshSnapshot(),failure=>hasCode(failure,'ERR_CANCELLED'))
})

test('timed-out snapshot refresh retains actual invoke and recovers only the same immutable request',async()=>{
  const reply=deferred(),timeout=deferred();let first=true,bound=true
  const h=harness({runBounded(actual,details){
    return bound&&details.phase==='control:snapshot'&&details.identity?.snapshotRefresh
      ?Promise.race([actual,timeout.promise]):controlledWait(actual,details)
  }})
  h.onReply=async(request,final)=>{if(request.command==='snapshot'&&first){first=false;await reply.promise}return final}
  const refreshing=h.manager.refreshSnapshot(),failed=assert.rejects(refreshing,failure=>hasCode(failure,'ERR_TIMEOUT'))
  await until(()=>h.control.requests.length===1)
  const original=h.control.requests[0]
  timeout.reject(error('ERR_TIMEOUT','snapshot final response remained in flight'));await failed
  assert.equal(h.manager.status.uncertain.command,'snapshot');assert.equal(h.manager.status.desired,null)
  assert.equal(h.manager.status.pendingOperations.some(value=>value.phase==='control-raw:snapshot'),true)
  await assert.rejects(h.manager.refreshSnapshot(),failure=>hasCode(failure,'ERR_RENDER'))
  bound=false;await h.manager.recover()
  assert.equal(h.control.replays.length,1);assert.equal(h.control.replays[0],original)
  assert.equal(h.control.requests.length,1);assert.equal(h.manager.status.uncertain,null)
  assert.equal(h.manager.status.pendingOperations.some(value=>value.phase==='control-raw:snapshot'),true,'bounded recovery does not drop the actual outstanding invoke')
  const fresh=await h.manager.refreshSnapshot();assert.equal(fresh.runId,'run-test')
  assert.deepEqual(h.control.requests.map(value=>value.requestId),['browser-client:control-1','browser-client:control-2'])
  reply.resolve();await until(()=>h.manager.status.pendingOperations.length===0)
  assert.equal(h.manager.status.terminalControlFailure,null);assert.equal(h.workers,0)
  await h.manager.close()
})

test('snapshot refresh genuine error final remains recoverable without executing the command again',async()=>{
  const h=harness(),transition=h.control.transition.bind(h.control);let fail=true
  h.control.transition=(command,payload)=>{if(command==='snapshot'&&fail){fail=false;throw error('ERR_ENGINE','actual snapshot failure')}return transition(command,payload)}
  await assert.rejects(h.manager.refreshSnapshot(),failure=>hasCode(failure,'ERR_ENGINE'))
  assert.equal(h.manager.status.uncertain.command,'snapshot')
  assert.equal(h.control.requests.length,1)
  await h.manager.recover()
  assert.equal(h.manager.status.uncertain,null);assert.equal(h.control.replays.length,0)
  assert.equal(h.control.requests.length,1)
  await h.manager.refreshSnapshot();assert.equal(h.control.requests.length,2)
  await h.manager.close()
})

test('snapshot refresh pending contexts use the existing finite offer budget',async()=>{
  const reply=deferred(),h=harness({managerOptions:{maxPendingOffers:1}})
  h.onReply=async(request,final)=>{if(request.command==='snapshot')await reply.promise;return final}
  const refreshing=h.manager.refreshSnapshot()
  await until(()=>h.control.requests.length===1)
  await assert.rejects(h.manager.refreshSnapshot(),failure=>hasCode(failure,'ERR_PROTOCOL_VERSION'))
  assert.equal(h.control.requests.length,1);assert.equal(h.manager.status.pendingOperations.some(value=>value.phase==='snapshot-refresh'),true)
  reply.resolve();await refreshing;await tick()
  await h.manager.refreshSnapshot();assert.equal(h.control.requests.length,2)
  await h.manager.close()
})

test('runtime pins reject invented or missing producer receipts before any control or owner work',async()=>{
  const h=harness()
  try {
    for(const field of ['sourceSnapshotSha256','sourceMapSha256','toolchainSha256','rendererAssetsSha256']) {
      const value=structuredClone(offerValue(offered()))
      value.site.runtime[field]=pin('f')
      assert.throws(()=>h.manager.offer(value),failure=>hasCode(failure,'ERR_PROTOCOL_VERSION'))
    }
    const missing=structuredClone(offerValue(offered()))
    delete missing.site.runtime.sourceInventorySha256
    assert.throws(()=>h.manager.offer(missing),failure=>hasCode(failure,'ERR_PROTOCOL_VERSION'))
    assert.deepEqual(commands(h),[]);assert.equal(h.imports,0);assert.equal(h.workers,0);assert.equal(h.fetched.length,0)
  } finally { await h.manager.close() }
})

test('real metadata admission creates no owner before integrity checks and ready is not presentation',async()=>{
  const gate=deferred(),h=harness();let held=true
  h.fetchHook=async(url,_init,env)=>{if(held)await gate.promise;const value=env.files.get(url);return new Response(value,{headers:{'content-length':String(value.length)}})}
  const ticket=h.manager.offer(offerValue(offered()));await until(()=>h.fetched.length===1)
  assert.equal(h.workers,0);assert.equal(h.entries.length,0);assert.deepEqual(commands(h),[])
  held=false;gate.resolve();const ready=await ticket.ready;await tick()
  assert.equal(ready.runtimeReady,true);assert.equal(h.workers,1);assert.equal(h.fetched.length,4,'real loader repeats pure index/manifest admission inside the real owner')
  assert.equal(h.manager.status.executing.hasPresented,false);assert.equal(h.manager.status.executing.inputEnabled,false)
  assert.equal(h.control.owner.phase,'runtime-ready');assert.equal(h.control.owner.runtime.evidenceOrigin,'browser-reported')
  assert.ok(h.fetched.every(({url})=>!url.includes('/blobs/')),'preflight does not claim executable blob preflight')
  await h.manager.close()
})

test('real accepted proof maps attempt/document/publication namespaces without invented revisions',async()=>{
  const h=harness(),ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  await h.entries[0].scheduler.accept();const value=await ticket.presented
  assert.equal(value.receipt.presentationRevision,'1');assert.equal(value.receipt.publication.revision,'5')
  assert.equal(value.receipt.metricsRevision,'7');assert.equal(value.receipt.publication.pageId,'1')
  const proof=h.manager.status.history.find(value=>value.kind==='accepted-proof').value
  assert.equal(proof.proof.publication.key.documentRevision,'3');assert.equal(proof.metricsBinding.ownerFenceRevision,'0')
  assert.equal(h.manager.status.executing.hasPresented,true);assert.equal(h.manager.status.executing.inputEnabled,true)
  h.entries[0].scheduler.suspend();assert.equal(h.manager.status.executing.hasPresented,true);assert.equal(h.manager.status.executing.inputEnabled,false)
  await h.manager.close()
})

test('explicit initial metrics may await presentation after real load without failing runtime ready',async()=>{
  const first=offered('1',{metrics:{windowWidth:375,windowHeight:667,screenWidth:375,screenHeight:667,pixelRatio:2,statusBarHeight:0,screenTop:0,deviceOrientation:'portrait',
    safeArea:{left:0,top:0,right:375,bottom:667,width:375,height:667}}}),h=harness({first})
  const ticket=h.manager.offer(offerValue(first));await ticket.ready;await tick()
  assert.deepEqual(h.entries[0].session.status.metricsFence,{revision:'1',phase:'awaiting-presentation'})
  assert.equal(h.control.owner.phase,'runtime-ready');assert.equal(h.manager.status.history.some(value=>value.kind==='metrics-binding'),false)
  await h.entries[0].scheduler.accept();await ticket.presented
  assert.deepEqual(h.entries[0].session.status.metricsFence,{revision:'1',phase:'open'})
  const mapped=h.manager.status.history.find(value=>value.kind==='metrics-binding').value
  assert.equal(mapped.ownerFenceRevision,'1');assert.equal(mapped.startupMetricsRevision,'7')
  await h.manager.close()
})

test('self-pinned modified startup with valid site/token IDs is rejected against authoritative full site',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));const ready=await first.ready;await tick()
  const legitimate=offered('2');h.publish(legitimate)
  const forged=clone(offerValue(legitimate)),config=JSON.parse(forged.startupJson);config.data={forged:true}
  forged.startupJson=JSON.stringify(config);forged.site.startup.sha256=sha256(bytes(forged.startupJson))
  const next=h.manager.offer(forged);await assert.rejects(next.ready,/full authoritative/)
  assert.equal(h.entries[0].raw.closes,0);assert.equal(h.workers,1)
  assert.equal(commands(h).filter(value=>value==='issueActivation').length,1)
  const response=await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{}});assert.equal(response.result.owner,'1')
  await h.manager.close()
})

test('real index integrity failure preserves the exact live owner before any replacement authority',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));const ready=await first.ready;await tick()
  const next=offered('2'),value=h.publish(next);h.files.set(next.pack.indexUrl,bytes('corrupt metadata'))
  const ticket=h.manager.offer(value);await assert.rejects(ticket.ready)
  assert.equal(h.entries[0].raw.closes,0);assert.equal(h.workers,1)
  assert.equal(h.errors.at(-1).previousOwnerPreserved,true)
  assert.equal((await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{}})).result.owner,'1')
  await h.manager.close()
})

test('ready waits the exact runtime record and immediate invalid target preserves its live owner without ticks',async()=>{
  const h=harness(),finalGate=deferred();let settled=false
  h.onReply=async(request,final)=>{if(request.command==='runtimeReady')await finalGate.promise;return final}
  const ticket=h.manager.offer(offerValue(offered()))
  void ticket.ready.then(()=>{settled=true},()=>{settled=true})
  try {
    await until(()=>commands(h).includes('runtimeReady'))
    assert.equal(settled,false,'a local Worker load is not the coordinator final')
    assert.equal(h.entries[0].session.status.runtimeReady,true)
    finalGate.resolve()
    const ready=await ticket.ready
    assert.equal(h.control.owner.phase,'runtime-ready')
    const old=h.entries[0],next=offered('2'),config=JSON.parse(next.startupJson)
    config.viewport={width:0,height:667};next.startupJson=JSON.stringify(config);next.site.startup.sha256=sha256(bytes(next.startupJson))
    await assert.rejects(h.manager.offer(h.publish(next)).ready,/startup index\/viewport\/renderer/)
    assert.equal(old.raw.closes,0);assert.equal(h.entries.length,1)
    assert.equal(old.session.status.runtimeReady,true)
    assert.equal(h.errors.at(-1).previousOwnerPreserved,true)
    const result=await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{}})
    assert.equal(result.result.owner,old.id)
  } finally {finalGate.resolve();await h.manager.close()}
})

test('cancellation before delayed runtime acknowledgement never publishes ready or revives the closing owner',async()=>{
  const h=harness(),finalGate=deferred();let readyValue=null
  h.onReply=async(request,final)=>{if(request.command==='runtimeReady')await finalGate.promise;return final}
  const ticket=h.manager.offer(offerValue(offered()))
  void ticket.ready.then(value=>{readyValue=value},()=>{})
  const rejected=assert.rejects(ticket.ready,{code:'ERR_CANCELLED'})
  await until(()=>commands(h).includes('runtimeReady'))
  const cancelled=ticket.cancel();await rejected
  assert.equal(readyValue,null)
  finalGate.resolve();await cancelled
  assert.equal(readyValue,null);assert.equal(h.entries[0].raw.closes,1)
  assert.equal(h.entries[0].session.status.phase,'closed');assert.equal(h.control.owner,null)
  await h.manager.close()
})

test('close from the stable runtime observer rejects ready instead of handing off a retired owner',async()=>{
  let closing
  const h=harness()
  h.onState=state=>{if(state.phase==='runtime-ready'&&!closing)closing=h.manager.close()}
  const ticket=h.manager.offer(offerValue(offered()))
  await assert.rejects(ticket.ready,{code:'ERR_CANCELLED'})
  await closing
  assert.equal(h.entries[0].raw.closes,1);assert.equal(h.control.owner,null)
})

test('replacement awaits real old close receipt AND server exact final before new constructor/load',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  const old=h.entries[0],localGate=old.closeGate=deferred(),finalGate=deferred()
  h.onReply=async(request,final)=>{if(request.command==='finishClose')await finalGate.promise;return final}
  const ticket=h.manager.offer(h.publish(offered('2')));await until(()=>old.raw.closes===1)
  assert.equal(h.entries.length,1);localGate.resolve();await until(()=>commands(h).includes('finishClose'))
  assert.equal(h.entries.length,1);assert.equal(h.manager.status.executing.retired,true)
  finalGate.resolve();await ticket.ready
  assert.equal(h.entries.length,2);assert.ok(h.log.indexOf('close-final:1')<h.log.indexOf('worker:2'))
  const starts=h.control.requests.filter(value=>value.command==='startOwner')
  assertOwnerIdentity(starts[1].payload.clientOwnerId)
  assert.notEqual(starts[0].payload.clientOwnerId,starts[1].payload.clientOwnerId)
  assert.equal(h.control.owner.key.clientOwnerId,starts[1].payload.clientOwnerId);await h.manager.close()
})

test('still-granted stale permit is cancelled exactly and fresh control is rechecked before retry',async()=>{
  const h=harness();let advanced=false
  h.onReply=(request,final,server)=>{if(request.command==='issueActivation'&&!advanced){advanced=true;server.bump()}return final}
  const ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  assert.deepEqual(commands(h).slice(0,8),['snapshot','issueActivation','beginActivation','cancelActivation','snapshot','issueActivation','beginActivation','startOwner'])
  assert.equal(h.workers,1);await h.manager.close()
})

test('cancelled exact StartAllowed final is abandoned without fake owner construction',async()=>{
  const h=harness(),reply=deferred();let ticket
  h.onReply=async(request,final)=>{if(request.command==='beginActivation')await reply.promise;return final}
  ticket=h.manager.offer(offerValue(offered()));await until(()=>h.control.activation?.phase==='start-allowed')
  const cancelling=ticket.cancel();await assert.rejects(ticket.ready,failure=>hasCode(failure,'ERR_CANCELLED'))
  await until(()=>commands(h).includes('abandonStart'));assert.equal(h.control.activation,null);assert.equal(h.control.owner,null)
  assert.equal(h.entries.length,0);assert.equal(h.workers,0);assert.ok(h.control.replays.some(value=>value.command==='beginActivation'))
  reply.resolve();await cancelling;await h.manager.close()
})

test('registration final exists before loading observer and cancellation proves never-constructed cleanup',async()=>{
  const h=harness();let ticket,cancelling,observed=false
  h.onState=state=>{if(state.phase==='loading'&&!observed){observed=true;assert.ok(h.control.owner);assert.equal(state.executing.constructed,false);cancelling=ticket.cancel()}}
  ticket=h.manager.offer(offerValue(offered()));await assert.rejects(ticket.ready,failure=>hasCode(failure,'ERR_CANCELLED'))
  await until(()=>cancelling);await cancelling
  const final=h.control.requests.find(value=>value.command==='finishClose')
  assert.equal(final.payload.closeFinal.outcome,'never-constructed');assert.equal(h.entries.length,0);assert.equal(h.control.owner,null)
  await h.manager.close()
})

test('lost start final retains exact request/clientOwnerId, blocks replacement, then replay cleans inert slot',async t=>{
  const random=mockIdentityEntropy(t)
  const h=harness();let allow=false
  h.onReply=(request,final)=>{if(request.command==='startOwner')throw error('ERR_TIMEOUT','lost registration response');return final}
  h.onReplay=(request,final)=>{if(request.command==='startOwner'&&!allow)throw error('ERR_TIMEOUT','final replay unavailable');assert.ok(final);return final}
  const ticket=h.manager.offer(offerValue(offered()));await assert.rejects(ticket.ready)
  assert.ok(h.manager.status.uncertain);assert.equal(h.entries.length,0);assert.ok(h.control.owner)
  assert.throws(()=>h.manager.offer(offerValue(offered())),failure=>hasCode(failure,'ERR_RENDER'))
  const start=h.control.requests.find(value=>value.command==='startOwner');allow=true;await h.manager.recover()
  assert.equal(start.payload.clientOwnerId,`browser-client:owner-${nonceOne}`)
  assert.equal(random.mock.callCount(),1,'exact recovery never allocates a different inert intent identity')
  assert.ok(h.control.replays.filter(value=>value.command==='startOwner').every(value=>canonical(value)===canonical(start)))
  assert.equal(h.control.requests.filter(value=>value.command==='startOwner').length,1);assert.equal(h.control.owner,null)
  assert.equal(h.control.requests.find(value=>value.command==='finishClose').payload.closeFinal.outcome,'never-constructed')
  h.onReply=null;h.onReplay=null;const next=h.manager.offer(h.publish(offered('2')));await next.ready
  assert.equal(h.control.requests.filter(value=>value.command==='startOwner')[1].payload.clientOwnerId,`browser-client:owner-${nonceTwo}`)
  await h.manager.close()
})

test('queued receipt is never a final; exact replay of the stored real final is required',async()=>{
  const h=harness();let available=false
  h.onReply=(request,final)=>request.command==='beginActivation'?{queued:true,requestId:request.requestId}:final
  h.onReplay=(request,final)=>{if(request.command==='beginActivation'&&!available)throw error('ERR_TIMEOUT');return final}
  const ticket=h.manager.offer(offerValue(offered()));await assert.rejects(ticket.ready)
  assert.ok(h.manager.status.uncertain);assert.equal(h.entries.length,0);assert.equal(h.workers,0)
  assert.equal(h.manager.status.snapshot.activationPhase,'granted','partial snapshot does not invent the lost StartTicket')
  available=true;await h.manager.recover();assert.equal(h.control.activation,null)
  assert.ok(commands(h).includes('abandonStart'));await h.manager.close()
})

test('late finishClose final adoption clears exact old registration even after bounded failure',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  const gate=deferred(),timeout=deferred();let delayed=false,waited=false
  h.onReply=async(request,final)=>{if(request.command==='finishClose'&&!delayed){delayed=true;await gate.promise}return final}
  h.runBounded=(actual,details)=>{if(details.phase==='control:finishClose'&&!waited){waited=true;return Promise.race([actual,timeout.promise])}return controlledWait(actual,details)}
  const second=h.manager.offer(h.publish(offered('2')));await until(()=>delayed);timeout.reject(error('ERR_TIMEOUT'));await assert.rejects(second.ready)
  assert.equal(h.manager.status.executing,null);assert.equal(h.control.owner,null);assert.equal(h.control.activation,null)
  gate.resolve();await tick();h.runBounded=null;h.onReply=null
  const third=h.manager.offer(h.publish(offered('3')));await third.ready;assert.equal(h.workers,2);await h.manager.close()
})

test('partial actual owner load failure attempts exact cleanup, retains fatal uncertainty and never rolls back old heap',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  h.onConstruct=e=>{if(e.id==='2')e.failLoad=error('ERR_ENGINE','controlled load failed')}
  const second=h.manager.offer(h.publish(offered('2')));await assert.rejects(second.ready,failure=>hasCode(failure,'ERR_ENGINE'))
  await until(()=>h.control.owner?.phase==='close-uncertain'&&h.manager.status.cleanupFailure)
  assert.equal(h.entries[0].raw.closes,1);assert.equal(h.entries[1].raw.closes,1);assert.equal(h.control.owner.phase,'close-uncertain')
  assert.equal(h.errors.at(-1).previousOwnerPreserved,false);assert.equal(h.manager.status.executing.retired,true)
  assert.ok(h.manager.status.cleanupFailure);await assert.rejects(h.manager.close())
})

test('actual close rejection remains uncertain although WorkerWebSession phase says closed',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  h.onRawClose=()=>{throw error('ERR_RENDER','owned Worker close failed')}
  const second=h.manager.offer(h.publish(offered('2')));await assert.rejects(second.ready,failure=>hasCode(failure,'ERR_RENDER'))
  assert.equal(h.entries[0].session.status.phase,'closed');assert.equal(h.control.owner.phase,'close-uncertain');assert.equal(h.workers,1)
  assert.ok(h.manager.status.cleanupFailure);assert.throws(()=>h.manager.offer(offerValue(offered('3'))))
  await assert.rejects(h.manager.close())
})

test('superseding during old close serializes cleanup, abandons old start, then loads only newest source',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  const gate=h.entries[0].closeGate=deferred(),second=h.manager.offer(h.publish(offered('2')))
  await until(()=>h.entries[0].raw.closes===1);const third=h.manager.offer(h.publish(offered('3')));await tick()
  assert.equal(h.workers,1);gate.resolve();await assert.rejects(second.ready,failure=>hasCode(failure,'ERR_CANCELLED'));await third.ready
  assert.equal(h.workers,2);assert.equal(h.manager.status.executing.identity.siteId,'3');await h.manager.close()
})

test('inert wrapper survives reentrant factory disposal and real transferred owner closes before load',async()=>{
  const h=harness();let closing
  h.onBeforeConstruct=()=>{closing=h.manager.close()}
  const ticket=h.manager.offer(offerValue(offered()));await assert.rejects(ticket.ready,failure=>hasCode(failure,'ERR_CANCELLED'))
  await closing;assert.equal(h.entries.length,1);assert.equal(h.workers,0);assert.equal(h.entries[0].session.status.phase,'closed')
  assert.equal(h.control.owner,null);assert.equal(h.manager.close(),closing)
})

test('cancel barrier is installed before owner-closing observers and is identity-stable under reentry',async()=>{
  const h=harness(),ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  let nested
  h.onState=state=>{if(state.executing?.retired&&!nested)nested=ticket.cancel()}
  const original=ticket.cancel();assert.equal(nested,original);assert.equal(ticket.cancel(),original);await original
  assert.equal(commands(h).filter(value=>value==='failOwner').length,1);assert.equal(h.control.owner,null);await h.manager.close()
})

test('successful pipeline completion still allows explicit cancellation and mandatory server cleanup',async()=>{
  const h=harness(),ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  await ticket.cancel();assert.equal(h.control.owner,null);assert.equal(h.entries[0].raw.closes,1)
  assert.ok(commands(h).includes('failOwner'));assert.ok(commands(h).includes('finishClose'));await h.manager.close()
})

test('actual normal close carries its immutable admitted tuple and exact RPC identity into finishClose',async()=>{
  const h=harness(),ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  const e=h.entries[0],owner=e.session.owner
  await h.manager.close()
  const report=h.control.requests.find(value=>value.command==='finishClose').payload.closeFinal
  assert.equal(report.outcome,'closed');assert.equal(report.evidenceOrigin,'browser-reported')
  assert.equal(report.receipt.version,'1.0');assert.deepEqual(report.receipt.owner,owner)
  assert.deepEqual(report.receipt.rpcIdentity,{workerEpoch:e.raw.workerEpoch,sessionId:e.raw.sessionId})
  assert.equal(Object.isFrozen(report.receipt.owner),true);assert.equal(Object.isFrozen(report.receipt.rpcIdentity),true)
  assert.equal(e.raw.closes,1);assert.equal(h.control.owner,null)
})

test('constructed session closed before load reports explicit null identity without claiming never-constructed',async()=>{
  const h=harness();let closing
  h.onBeforeConstruct=()=>{closing=h.manager.close()}
  const ticket=h.manager.offer(offerValue(offered()));await assert.rejects(ticket.ready,failure=>hasCode(failure,'ERR_CANCELLED'))
  await closing
  const report=h.control.requests.find(value=>value.command==='finishClose').payload.closeFinal
  assert.equal(report.outcome,'closed');assert.equal(h.entries.length,1);assert.equal(h.workers,0)
  assert.equal(report.receipt.owner,null);assert.equal(report.receipt.rpcIdentity,null);assert.equal(report.receipt.workerFinal,null)
})

test('cancel during actual session admission retains pre-admission RPC teardown identity without runtime-ready',async()=>{
  const gate=deferred(),h=harness(),create=h.runtime.createSession
  h.runtime.createSession=options=>create({...options,admitPack:async config=>{await gate.promise;return options.admitPack(config)}})
  const ticket=h.manager.offer(offerValue(offered())),failed=assert.rejects(ticket.ready,failure=>hasCode(failure,'ERR_CANCELLED'))
  await until(()=>h.workers===1)
  const e=h.entries[0];assert.equal(e.session.owner,null)
  const cancelling=ticket.cancel();await tick();assert.equal(e.raw.closes,0)
  gate.resolve();await cancelling;await failed
  const report=h.control.requests.find(value=>value.command==='finishClose').payload.closeFinal
  assert.equal(report.outcome,'closed');assert.equal(report.receipt.owner,null)
  assert.deepEqual(report.receipt.rpcIdentity,{workerEpoch:e.raw.workerEpoch,sessionId:e.raw.sessionId})
  assert.equal(commands(h).includes('runtimeReady'),false);assert.equal(e.raw.closes,1)
  await h.manager.close()
})

test('cancel after admission preserves actual close owner before public load becomes runtime-ready',async()=>{
  const gate=deferred(),h=harness({onConstruct:e=>{e.loadGate=gate}})
  const ticket=h.manager.offer(offerValue(offered())),failed=assert.rejects(ticket.ready,failure=>hasCode(failure,'ERR_CANCELLED'))
  await until(()=>h.entries[0]?.calls.includes('load'))
  const e=h.entries[0],owner=e.session.owner;assert.ok(owner);assert.equal(h.manager.status.executing.owner,null)
  const cancelling=ticket.cancel();await tick();assert.equal(e.raw.closes,0)
  gate.resolve();await cancelling;await failed
  const report=h.control.requests.find(value=>value.command==='finishClose').payload.closeFinal
  assert.equal(report.outcome,'closed');assert.deepEqual(report.receipt.owner,owner)
  assert.equal(commands(h).includes('runtimeReady'),false);assert.equal(e.raw.closes,1)
  await h.manager.close()
})

test('malformed actual close receipts never authorize a replacement or erase the registered owner',async()=>{
  for(const rewrite of [
    value=>({...value,owner:null}),
    value=>({...value,owner:{...value.owner,workerEpoch:'other-worker'}}),
    value=>({...value,rpcIdentity:{...value.rpcIdentity,sessionId:'other-session'}}),
    value=>({...value,owner:{...value.owner,packSha256:pin('f')}}),
    value=>({...value,owner:{...value.owner,transportBackend:'external-frame'}}),
    value=>({...value,workerFinal:{closed:false}}),
    value=>({...value,rpcIdentity:null}),
    value=>{const result={...value};delete result.owner;return result},
    value=>({...value,untrustedExtra:true}),
  ]) {
    const h=harness(),first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
    const e=h.entries[0],close=e.session.close.bind(e.session)
    e.session.close=async()=>rewrite(await close())
    const next=h.manager.offer(h.publish(offered('2')))
    await assert.rejects(next.ready);await tick()
    const reports=h.control.requests.filter(value=>value.command==='finishClose')
    assert.ok(reports.length>0);assert.ok(reports.every(value=>value.payload.closeFinal.success===false))
    assert.equal(h.workers,1);assert.equal(e.raw.closes,1);assert.equal(e.session.status.phase,'closed')
    assert.equal(h.control.owner.phase,'close-uncertain');assert.equal(h.manager.status.executing.retired,true)
    await assert.rejects(h.manager.close())
  }
})

test('real runtime fatal after successful pipeline attempts mandatory cleanup and retains failed close authority',async()=>{
  const h=harness(),ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  h.entries[0].scheduler.fault();await until(()=>h.control.owner?.phase==='close-uncertain')
  assert.equal(h.entries[0].raw.closes,1);assert.equal(h.manager.status.executing.retired,true)
  assert.ok(h.manager.status.cleanupFailure);assert.ok(commands(h).includes('failOwner'))
  const finish=h.control.requests.find(value=>value.command==='finishClose');assert.equal(finish.payload.closeFinal.success,false)
  await assert.rejects(h.manager.close())
})

test('soft accepted template lag waits without fault until matching accepted proof is real',async()=>{
  const h=harness(),ticket=h.manager.offer(offerValue(offered()));const ready=await ticket.ready;await tick()
  const e=h.entries[0];e.observation.sequence='2';e.observation.state.templateRevision='2';e.observation.state.viewRevision='2'
  await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{}})
  await e.scheduler.accept(true,{consumedInput:{pageId:'1',routePath:route,templateRevision:'1',viewport:rect()}});await tick()
  assert.equal(h.errors.length,0);assert.equal(h.manager.status.executing.hasPresented,false);assert.equal(e.raw.closes,0)
  await e.scheduler.accept(true,{attemptId:'2'});const presented=await ticket.presented
  assert.equal(presented.receipt.templateRevision,'2');await h.manager.close()
})

test('stale owner callbacks retain provenance without mutating new owner state',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));await first.ready;await tick();const old=h.entries[0]
  const next=h.manager.offer(h.publish(offered('2')));await next.ready;await tick();const identity=h.manager.status.executing.identity
  old.hooks.onState({runtimeReady:true,fault:error('OLD_ERROR')});old.hooks.onError(error('OLD_ERROR'));old.hooks.onBatch({messages:[{op:'timer.old'}]})
  assert.equal(h.manager.status.executing.identity,identity);assert.equal(h.manager.status.executing.retired,false)
  assert.equal(h.batches.at(-1).stale,true);assert.equal(h.batches.at(-1).identity.siteId,'1')
  assert.ok(h.manager.status.history.some(value=>value.kind==='late-error'));await h.manager.close()
})

test('bridge diagnostic envelopes retain real severity and message without creating engine errors',async()=>{
  const diagnostics=[],h=harness({managerOptions:{onDiagnostic:value=>diagnostics.push(value)}})
  try {
    await h.manager.offer(offerValue(offered())).ready;await tick();const e=h.entries[0]
    const envelope=(op,payload)=>({protocolVersion:'1.0',sessionId:e.owner.sessionId,requestId:'',kind:'event',op,payload})
    e.hooks.onDiagnostic(envelope('diagnostic',{level:'info',message:'View renderer ready',data:{secret:'not-for-display'}}))
    e.hooks.onDiagnostic(envelope('diagnostic',{level:'warn',message:'Optional font unavailable',data:{token:'not-for-display'}}))
    e.hooks.onDiagnostic(envelope('diagnostic',{level:'info',code:'VIEW_READY',message:'Ready with a real code'}))
    e.hooks.onDiagnostic(envelope('error',{error:{code:'ERR_RENDER',message:'Surface commit failed'},secret:'not-for-display'}))
    e.hooks.onDiagnostic({level:'debug',message:'data patch batch applied',data:{secret:'not-for-display'}})
    e.hooks.onDiagnostic(Object.assign(error('ERR_TIMEOUT','Original timeout'),{level:'info',secret:'not-for-display'}))
    assert.deepEqual(diagnostics.map(({identity,ownerKey,stale,...value})=>value),[
      {level:'info',message:'View renderer ready'},
      {level:'warn',message:'Optional font unavailable'},
      {level:'info',code:'VIEW_READY',message:'Ready with a real code'},
      {level:'error',code:'ERR_RENDER',message:'Surface commit failed'},
      {level:'debug',message:'data patch batch applied'},
      {level:'error',code:'ERR_TIMEOUT',message:'Original timeout'},
    ])
    for(const value of diagnostics) {
      assert.equal(value.identity.siteId,'1');assert.deepEqual(value.ownerKey,h.manager.status.executing.ownerKey)
      assert.equal(value.stale,false);assert.equal(Object.isFrozen(value),true)
      assert.equal(JSON.stringify(value).includes('not-for-display'),false)
    }
    assert.equal(h.errors.length,0);assert.equal(h.manager.status.executing.retired,false)
  } finally { await h.manager.close() }
})

test('diagnostic projection is UTF-8 bounded and never inspects or retains arbitrary data',async()=>{
  const diagnostics=[],h=harness({managerOptions:{onDiagnostic:value=>diagnostics.push(value)}})
  try {
    await h.manager.offer(offerValue(offered())).ready;await tick()
    const payload={level:'warn',code:'码'.repeat(128),message:'🧪'.repeat(2048)}
    Object.defineProperty(payload,'data',{enumerable:true,get(){throw Error('raw diagnostic data must not be inspected')}})
    h.entries[0].hooks.onDiagnostic({op:'diagnostic',payload,secret:'not-for-display'})
    assert.equal(diagnostics.length,1)
    const value=diagnostics[0]
    assert.equal(value.level,'warn');assert.ok(Buffer.byteLength(value.code)<=128);assert.ok(Buffer.byteLength(value.message)<=2048)
    assert.equal(value.code.includes('\ufffd'),false);assert.equal(value.message.includes('\ufffd'),false)
    assert.deepEqual(Object.keys(value).sort(),['code','identity','level','message','ownerKey','stale'])
    assert.equal(JSON.stringify(value).includes('not-for-display'),false)
  } finally { await h.manager.close() }
})

test('real Worker batch and bridge error shape expands engine errors without faulting or replaying the owner',async()=>{
  const diagnostics=[],h=harness({managerOptions:{onDiagnostic:value=>diagnostics.push(value)}})
  try {
    await h.manager.offer(offerValue(offered())).ready;await tick();const e=h.entries[0]
    const ownerKey=h.manager.status.executing.ownerKey,calls=[...e.calls],closes=e.raw.closes
    const errors=[{name:'ReferenceError',message:'missingExport is not defined',stack:'ReferenceError: missingExport is not defined\n    at pages/home/index.js:12:7'},
      {name:'TypeError',message:'formatter is not callable',stack:'TypeError: formatter is not callable\n    at view/format.view.js:8:3'}]
    const observation=clone(e.observation);observation.sequence='2'
    e.rpcHooks.onEvent({version:'1.0',workerEpoch:e.owner.workerEpoch,sessionId:e.owner.sessionId,
      requestId:'worker-event-1',kind:'event',op:'batch',payload:{phase:'live',observation,messages:[{
        protocolVersion:'1.0',sessionId:e.owner.sessionId,requestId:'',kind:'event',op:'error',
        payload:{source:'quickjs',errors,secret:'not-for-display'},
      }]}})
    assert.equal(diagnostics.length,2)
    for(let index=0;index<errors.length;index++) {
      const value=diagnostics[index]
      assert.deepEqual(value,{identity:h.manager.status.executing.identity,ownerKey,stale:false,level:'error',source:'quickjs',...errors[index]})
      assert.equal(Object.isFrozen(value),true);assert.equal(JSON.stringify(value).includes('not-for-display'),false)
    }
    assert.deepEqual(e.calls,calls,'Reporting must not add a drain, bridge call or any application re-entry')
    assert.equal(e.raw.closes,closes);assert.equal(h.errors.length,0)
    assert.equal(e.session.status.phase,'ready');assert.equal(h.manager.status.executing.retired,false)
    assert.equal(e.session.status.requiresRestart,false)
  } finally { await h.manager.close() }
})

test('error projection preserves legacy single, payload-only and failed response forms with bounded plain text stacks',async()=>{
  const diagnostics=[],h=harness({managerOptions:{onDiagnostic:value=>diagnostics.push(value)}})
  try {
    await h.manager.offer(offerValue(offered())).ready;await tick();const e=h.entries[0]
    const error={code:'ERR_ENGINE',name:'TypeError',message:'<img src=x onerror=alert(1)>',stack:'TypeError: test\n    at app.js:9:2'}
    for(const value of [{op:'error',payload:{error}},
      {source:'v8',errors:[error]},
      {kind:'response',op:'module.call',payload:{ok:false,error}}])e.hooks.onDiagnostic(value)
    assert.equal(diagnostics.length,3)
    for(const value of diagnostics) {
      for(const key of ['code','name','message','stack'])assert.equal(value[key],error[key])
      assert.equal(value.level,'error');assert.equal(value.stale,false)
    }
    assert.equal(diagnostics[1].source,'v8')
    const stack='🧪'.repeat(5000),message='错误'.repeat(2000)
    e.hooks.onDiagnostic({op:'error',payload:{source:'quickjs',errors:[{code:'码'.repeat(200),name:'名'.repeat(200),message,stack}]}})
    const value=diagnostics.at(-1)
    assert.ok(Buffer.byteLength(value.code)<=128);assert.ok(Buffer.byteLength(value.name)<=128)
    assert.ok(Buffer.byteLength(value.message)<=2048);assert.equal(Buffer.byteLength(value.stack),8192)
    assert.equal(value.stackTruncated,true)
    for(const key of ['code','name','message','stack'])assert.equal(value[key].includes('\ufffd'),false)
    assert.equal(h.errors.length,0)
  } finally { await h.manager.close() }
})

test('malformed diagnostics and accessors never execute user getters or conversions and cannot retire the owner',async()=>{
  const diagnostics=[],h=harness({managerOptions:{onDiagnostic:value=>diagnostics.push(value)}})
  let inspected=0
  const unread=()=>{inspected++;throw Error('diagnostic getter must not run')}
  const getters=keys=>Object.defineProperties({},Object.fromEntries(keys.map(key=>[key,{enumerable:true,get:unread}])))
  try {
    await h.manager.offer(offerValue(offered())).ready;await tick();const e=h.entries[0]
    const errors=[null,42,'not a diagnostic',getters(['message','name','code','stack','level','data','toString','toJSON'])]
    Object.defineProperty(errors,'4',{enumerable:true,get:unread})
    const noCoercion={toString:unread,toJSON:unread,[Symbol.toPrimitive]:unread}
    errors.push({level:noCoercion,code:noCoercion,name:noCoercion,message:noCoercion,stack:noCoercion})
    e.hooks.onDiagnostic({op:'error',payload:{source:'quickjs',errors}})
    e.hooks.onDiagnostic(getters(['op','payload','message','name','code','stack','level','error','errors','source','data']))
    e.hooks.onDiagnostic({op:'error',payload:getters(['error','errors','source','message','name','code','stack','level','data'])})
    for(const errors of [undefined,null,{},'invalid',[]])e.hooks.onDiagnostic({op:'error',payload:{errors}})
    assert.equal(inspected,0);assert.equal(diagnostics.length,13)
    assert.ok(diagnostics.every(value=>value.level==='error'&&value.message==='Runtime diagnostic has no message'))
    assert.ok(diagnostics.every(value=>!Object.hasOwn(value,'stack')&&!Object.hasOwn(value,'name')))
    assert.equal(h.errors.length,0);assert.equal(h.manager.status.executing.retired,false)
    assert.equal(h.manager.status.cleanupFailure,null)
  } finally { await h.manager.close() }
})

test('runtime error expansion has an explicit finite omission record and preserves stale owner provenance',async()=>{
  const diagnostics=[],h=harness({managerOptions:{onDiagnostic:value=>diagnostics.push(value)}})
  try {
    await h.manager.offer(offerValue(offered())).ready;await tick();const old=h.entries[0],oldIdentity=h.manager.status.executing.identity,oldKey=h.manager.status.executing.ownerKey
    await h.manager.offer(h.publish(offered('2'))).ready;await tick();const current=h.manager.status.executing
    const errors=Array.from({length:100},(_,index)=>({name:'Error',message:`Error ${index}`,stack:`at app.js:${index+1}:1`}))
    let inspected=0
    Object.defineProperty(errors,'31',{get(){inspected++;throw Error('outside expansion budget')}})
    old.hooks.onDiagnostic({op:'error',payload:{source:'quickjs',errors}})
    assert.equal(inspected,0);assert.equal(diagnostics.length,32)
    for(let index=0;index<31;index++) {
      assert.equal(diagnostics[index].message,`Error ${index}`);assert.equal(diagnostics[index].stack,`at app.js:${index+1}:1`)
    }
    assert.deepEqual(diagnostics.at(-1),{identity:oldIdentity,ownerKey:oldKey,stale:true,
      level:'warn',code:'DIAGNOSTIC_TRUNCATED',message:'69 additional runtime errors were omitted (32 record limit)'})
    assert.ok(diagnostics.every(value=>value.identity===oldIdentity&&value.stale===true&&Object.isFrozen(value)))
    assert.equal(h.manager.status.executing.identity,current.identity);assert.equal(h.manager.status.executing.retired,false)
    assert.equal(h.errors.length,0)
  } finally { await h.manager.close() }
})

test('shared immutable import is not aborted by first subscriber and pending jobs retain capacity',async()=>{
  const gate=deferred(),h=harness({importGate:gate,managerOptions:{maxPendingOffers:1}}),first=h.manager.offer(offerValue(offered()))
  await until(()=>h.imports===1);const cancellation=first.cancel();await assert.rejects(first.ready)
  assert.throws(()=>h.manager.offer(offerValue(offered())),/pending budget/)
  gate.resolve();await cancellation;const next=h.manager.offer(h.publish(offered('2')));await next.ready
  assert.equal(h.imports,1);assert.equal(h.workers,1);await h.manager.close()
})

test('normal command lifetime exhaustion reserves independent bounded mandatory cleanup authority',async()=>{
  const h=harness({managerOptions:{maxControlCommands:5}}),ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  assert.equal(commands(h).length,5);await h.manager.close()
  assert.ok(commands(h).includes('stop'));assert.ok(commands(h).includes('finishClose'));assert.equal(h.control.owner,null)
  const normal=h.control.requests.filter(value=>!['stop','finishClose'].includes(value.command))
  const cleanup=h.control.requests.filter(value=>['stop','finishClose'].includes(value.command))
  assert.deepEqual(normal.map(value=>value.requestId.split(':').at(-1)),['control-1','control-2','control-3','control-4','control-5'])
  assert.deepEqual(cleanup.map(value=>value.requestId.split(':').at(-1)),['cleanup-1','cleanup-2'])
})

test('timed-out never-invoked queued command is locally pruned only after genuine work settles without server retirement or serial reuse',async()=>{
  const h=harness({retirement:true}),first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  const rawReply=deferred(),presentationTimeout=deferred(),queuedTimeout=deferred();let queuedWaiting=false
  h.onReply=async(request,final)=>{if(request.command==='presentedReady')await rawReply.promise;return final}
  h.runBounded=(actual,details)=>{
    if(details.phase==='control:presentedReady')return Promise.race([actual,presentationTimeout.promise])
    if(details.phase==='control:snapshot'&&details.identity?.siteId==='2'){queuedWaiting=true;return Promise.race([actual,queuedTimeout.promise])}
    return controlledWait(actual,details)
  }
  await h.entries[0].scheduler.accept();await until(()=>commands(h).includes('presentedReady'))
  const second=h.manager.offer(h.publish(offered('2')));await until(()=>queuedWaiting)
  queuedTimeout.reject(error('ERR_TIMEOUT','queued command expired before invoke'));await assert.rejects(second.ready);await tick()
  presentationTimeout.reject(error('ERR_TIMEOUT','unknown predecessor final'));await until(()=>h.manager.status.uncertain)
  await h.manager.recover();await tick()
  assert.equal(h.control.requests.filter(value=>value.command==='snapshot').length,1,'expired B snapshot was never invoked')
  assert.equal(h.control.activation,null);assert.equal(h.workers,1)
  h.manager.retryControlRetirements({maxOperations:64});await tick()
  assert.equal(h.manager.status.controlRetirements.locallyDiscardedCommands,'0','late actual predecessor still owns retained work')
  rawReply.resolve();await until(()=>h.manager.status.pendingOperations.length===0)
  h.runBounded=null;h.onReply=null;await finishRetirements(h)
  const discarded=h.manager.status.controlRetirements
  assert.equal(discarded.locallyDiscardedCommands,'1')
  assert.equal(discarded.normalThrough,'6','local discard cannot manufacture a server retirement cursor')
  assert.equal(discarded.retiredCommands,String(h.control.requests.length),'only actual server finals count as retired')
  assert.equal(h.retirementCalls.flat().some(request=>request.requestId==='browser-client:control-7'),false)
  const replays=h.control.replays.length;await h.manager.recover()
  assert.equal(h.control.replays.length,replays,'recover cannot resurrect the discarded reservation')
  await h.manager.refreshSnapshot();assert.equal(h.control.requests.at(-1).requestId,'browser-client:control-8')
  await assert.rejects(h.control.invoke({version:'1.0',requestId:'browser-client:control-7',command:'snapshot',payload:{}}),{code:'ERR_CANCELLED'})
  assert.equal(h.control.requests.some(request=>request.requestId==='browser-client:control-7'),false)
  const closed=await h.manager.close();assert.equal(closed.workerClosed,true)
  assert.equal(h.entries[0].raw.closes,1);assert.equal(h.control.owner,null)
  await finishRetirements(h)
  assert.equal(h.manager.status.controlRetirements.normalThrough,'8')
  assert.equal(h.manager.status.controlRetirements.locallyDiscardedCommands,'1')
  assert.equal(h.manager.status.controlRetirements.retiredCommands,String(h.control.requests.length))
  assert.equal(h.manager.status.transportDrained,true)
})

test('repeated timed-out recovery reuses one raw unsettled replay and does not grow pending work',async()=>{
  const h=harness(),gate=deferred();let failReplay=true
  h.onReply=(request,final)=>{if(request.command==='startOwner')throw error('ERR_TIMEOUT');return final}
  h.onReplay=async(request,final)=>{if(request.command==='startOwner'&&failReplay)await gate.promise;return final}
  h.runBounded=(actual,details)=>details.phase==='control-replay'&&failReplay?Promise.reject(error('ERR_TIMEOUT')):controlledWait(actual,details)
  const ticket=h.manager.offer(offerValue(offered()));await assert.rejects(ticket.ready);await tick()
  const before=h.manager.status.pendingOperations.length
  for(let i=0;i<4;i++)await assert.rejects(h.manager.recover())
  assert.equal(h.control.replays.filter(value=>value.command==='startOwner').length,1)
  assert.equal(h.manager.status.pendingOperations.length,before)
  failReplay=false;gate.resolve();await tick();await h.manager.recover();assert.equal(h.control.owner,null)
  h.onReply=null;h.onReplay=null;h.runBounded=null;await h.manager.close()
})

test('malformed exact replay cannot synthesize a lost StartTicket from snapshot',async()=>{
  const h=harness();let corrupted=true
  h.onReply=(request,final)=>{if(request.command==='beginActivation')throw error('ERR_TIMEOUT');return final}
  h.onReplay=(request,final)=>{if(request.command==='beginActivation'&&corrupted)return {...final,status:'ok',result:{kind:'start',instruction:{binding:{},startRevision:'1'}}};return final}
  const ticket=h.manager.offer(offerValue(offered()));await assert.rejects(ticket.ready);assert.equal(h.workers,0);assert.ok(h.manager.status.uncertain)
  corrupted=false;await h.manager.recover();assert.equal(h.control.activation,null);assert.equal(h.workers,0);await h.manager.close()
})

test('restaging the same portable generation uses distinct site-scoped immutable pack/config namespaces',async()=>{
  const first=offered(),h=harness({first}),ticket=h.manager.offer(offerValue(first));await ticket.ready;await tick()
  const restaged=offered('2'),indexUrl=restaged.pack.indexUrl
  const oldManifest=first.pack.files.get(new URL('manifest.json',first.pack.indexUrl).href)
  restaged.pack={...first.pack,indexUrl,files:new Map([[indexUrl,first.pack.indexBytes],[new URL('manifest.json',indexUrl).href,oldManifest]])}
  restaged.site.portable=clone(first.site.portable);restaged.site.index=clone(first.site.index)
  const config=JSON.parse(first.startupJson);config.data={configurationRevision:2}
  restaged.startupJson=JSON.stringify(config);restaged.site.startup.sha256=sha256(bytes(restaged.startupJson))
  const next=h.manager.offer(h.publish(restaged));await next.ready
  assert.equal(h.manager.status.executing.identity.siteId,'2');assert.equal(h.control.owner.site.portable.packGeneration,'1')
  assert.equal(h.control.owner.site.index.sha256,first.site.index.sha256)
  assert.notEqual(h.control.owner.site.indexUrl,first.site.indexUrl);assert.ok(h.control.owner.site.indexUrl.includes('/run-test/2/'))
  assert.equal(h.workers,2);await h.manager.close()
})

test('direct manager callback fault after completed startup still sends mandatory cleanup for a healthy real owner',async()=>{
  const h=harness(),ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  // Direct boundary injection, intentionally does not fault WorkerWebSession.
  h.entries[0].hooks.onError(error('ERR_ENGINE','manager boundary callback fault'))
  await until(()=>h.manager.status.executing===null);assert.equal(h.control.owner,null);assert.equal(h.entries[0].raw.closes,1)
  assert.ok(commands(h).includes('failOwner'));assert.equal(h.manager.status.executing,null);await h.manager.close()
})

test('conflicting valid late final after genuine replay is sticky and cannot replace adopted snapshot authority',async()=>{
  const h=harness(),late=deferred(),timeout=deferred();let waiting=false
  h.onReply=async(request,final)=>{
    if(request.command==='startOwner') {waiting=true;await late.promise;const conflict=clone(final);conflict.result.owner.ownerSerial='999';conflict.snapshot.ownerKey.ownerSerial='999';conflict.snapshot.controlRevision='999';return conflict}
    return final
  }
  h.runBounded=(actual,details)=>details.phase==='control:startOwner'?Promise.race([actual,timeout.promise]):controlledWait(actual,details)
  const ticket=h.manager.offer(offerValue(offered()));await until(()=>waiting);timeout.reject(error('ERR_TIMEOUT'));await assert.rejects(ticket.ready)
  assert.equal(h.control.owner,null,'genuine replay permitted exact never-constructed cleanup')
  const genuineRevision=h.manager.status.snapshot.controlRevision;late.resolve();await until(()=>h.manager.status.uncertain)
  assert.equal(h.manager.status.snapshot.controlRevision,genuineRevision,'conflicting snapshot was not adopted')
  assert.equal(h.entries.length,0);assert.equal(h.workers,0)
  await assert.rejects(h.manager.recover(),/changed its final/)
  assert.throws(()=>h.manager.offer(offerValue(offered('2'))));await assert.rejects(h.manager.close())
})

test('conflicting final arriving during awaited cleanup cannot be erased by cleanup completion',async()=>{
  const h=harness(),original=deferred(),finish=deferred(),timeout=deferred();let startWaiting=false,finishWaiting=false
  h.onReply=async(request,final)=>{
    if(request.command==='startOwner'){startWaiting=true;await original.promise;const conflict=clone(final);conflict.result.owner.ownerSerial='999';conflict.snapshot.ownerKey.ownerSerial='999';conflict.snapshot.controlRevision='999';return conflict}
    if(request.command==='finishClose'){finishWaiting=true;await finish.promise}
    return final
  }
  h.runBounded=(actual,details)=>details.phase==='control:startOwner'?Promise.race([actual,timeout.promise]):controlledWait(actual,details)
  const ticket=h.manager.offer(offerValue(offered()));await until(()=>startWaiting);timeout.reject(error('ERR_TIMEOUT'))
  await until(()=>finishWaiting);original.resolve();await until(()=>h.manager.status.terminalControlFailure)
  finish.resolve();await assert.rejects(ticket.ready)
  assert.ok(h.manager.status.terminalControlFailure);assert.ok(h.manager.status.uncertain)
  await assert.rejects(h.manager.recover(),/changed its final/);await assert.rejects(h.manager.close())
})

test('late conflicting replay after original final adoption is equally terminal after bounded callers ended',async()=>{
  const h=harness(),original=deferred(),replay=deferred(),startTimeout=deferred(),replayTimeout=deferred();let invoked=false,replaying=false
  h.onReply=async(request,final)=>{if(request.command==='startOwner'){invoked=true;await original.promise}return final}
  h.onReplay=async(request,final)=>{
    if(request.command==='startOwner'){replaying=true;await replay.promise;const conflict=clone(final);conflict.result.owner.ownerSerial='999';conflict.snapshot.ownerKey.ownerSerial='999';conflict.snapshot.controlRevision='999';return conflict}
    return final
  }
  h.runBounded=(actual,details)=>details.phase==='control:startOwner'?Promise.race([actual,startTimeout.promise])
    :details.phase==='control-replay'?Promise.race([actual,replayTimeout.promise]):controlledWait(actual,details)
  const ticket=h.manager.offer(offerValue(offered()));await until(()=>invoked);startTimeout.reject(error('ERR_TIMEOUT'))
  await until(()=>replaying);replayTimeout.reject(error('ERR_TIMEOUT'));await assert.rejects(ticket.ready)
  original.resolve();await until(()=>h.manager.status.executing?.ownerKey)
  const genuine=h.manager.status.snapshot.controlRevision;replay.resolve();await until(()=>h.manager.status.terminalControlFailure)
  assert.equal(h.manager.status.snapshot.controlRevision,genuine);assert.equal(h.entries.length,0);assert.equal(h.workers,0)
  await assert.rejects(h.manager.recover(),/changed its final/);await assert.rejects(h.manager.close())
})

test('terminal cleanup snapshots at u64 authority maximum advance by the exact cleanup revision lane',async()=>{
  const h=harness(),ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  h.control.rev=18446744073709551615n
  await h.manager.close()
  const stop=h.control.requests.find(value=>value.command==='stop'),finish=h.control.requests.find(value=>value.command==='finishClose')
  assert.ok(stop);assert.equal(finish.payload.ticket.closeRevision,'18446744073709551615')
  assert.equal(finish.payload.ticket.terminalCleanupRevision,'1')
  assert.equal(h.manager.status.snapshot.controlRevision,'18446744073709551615')
  assert.equal(h.manager.status.snapshot.terminalCleanupRevision,'2');assert.equal(h.control.owner,null)
})

test('terminal final conflict synchronously gates an actually loaded input-enabled owner before observers',async()=>{
  const h=harness(),ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  const original=deferred(),timeout=deferred();let reporting=false,observedGate=null
  h.onReply=async(request,final)=>{
    if(request.command==='presentedReady'){reporting=true;await original.promise;const conflict=clone(final);conflict.snapshot.controlRevision='999';return conflict}
    return final
  }
  h.runBounded=(actual,details)=>details.phase==='control:presentedReady'?Promise.race([actual,timeout.promise]):controlledWait(actual,details)
  await h.entries[0].scheduler.accept();await until(()=>reporting);timeout.reject(error('ERR_TIMEOUT'));await until(()=>h.manager.status.uncertain)
  await h.manager.recover();assert.equal(h.entries[0].session.status.inputEnabled,true,'actual test owner is still actively presented before conflict')
  h.onState=state=>{if(state.terminalControlFailure&&!observedGate)observedGate={inputEnabled:h.entries[0].session.status.inputEnabled,phase:h.entries[0].session.status.phase}}
  original.resolve();await until(()=>h.manager.status.terminalControlFailure);await until(()=>h.entries[0].session.status.phase==='closed')
  assert.ok(observedGate);assert.equal(observedGate.inputEnabled,false);assert.notEqual(observedGate.phase,'ready');assert.equal(h.entries[0].raw.closes,1);assert.equal(h.manager.status.executing.retired,true)
  assert.ok(h.control.owner,'local input teardown is never a fabricated server cleanup final')
  await assert.rejects(h.manager.close())
})

test('failure close facts stay nonempty and UTF8-byte bounded for the typed control ledger',async()=>{
  const h=harness(),ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  // Deliberately failing deadline adapter supplies the Unicode transport error.
  h.runBounded=(actual,details)=>details.phase==='owner-close'?Promise.reject(error('错'.repeat(300),'错'.repeat(1500))):controlledWait(actual,details)
  const next=h.manager.offer(h.publish(offered('2')));await assert.rejects(next.ready)
  const report=h.control.requests.find(value=>value.command==='finishClose').payload.closeFinal.error
  assert.ok(report.code.startsWith('错'));assert.equal(bytes(report.code).length,126)
  assert.ok(report.message.startsWith('错'));assert.equal(bytes(report.message).length,2046)
  await assert.rejects(h.manager.close())
})


test('authoritative actual startup route mismatch is rejected before retirement or replacement authority',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));const ready=await first.ready;await tick()
  const next=offered('2'),config=JSON.parse(next.startupJson);config.route='pages/not-selected/index'
  next.startupJson=JSON.stringify(config);next.site.startup.sha256=sha256(bytes(next.startupJson))
  const ticket=h.manager.offer(h.publish(next));await assert.rejects(ticket.ready,/startup route differs/)
  assert.equal(h.entries[0].raw.closes,0);assert.equal(h.workers,1)
  assert.equal(commands(h).filter(value=>value==='issueActivation').length,1)
  assert.equal((await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{}})).result.owner,'1')
  await h.manager.close()
})

test('defined actual startup route matching independently selected route remains accepted',async()=>{
  const first=offered(),config=JSON.parse(first.startupJson);config.route=first.site.portable.selectedRoute
  first.startupJson=JSON.stringify(config);first.site.startup.sha256=sha256(bytes(first.startupJson))
  const h=harness({first}),ticket=h.manager.offer(offerValue(first));await ticket.ready;await tick()
  assert.equal(h.workers,1);assert.equal(h.control.owner.phase,'runtime-ready')
  await h.manager.close()
})


test('v3 DOM branch never starts drawing-resource preparation, borrow or import',async()=>{
  const h=harness(),ticket=h.manager.offer(offerValue(offered()));await ticket.ready;await tick()
  assert.equal(h.preparations.length,0);assert.equal(h.borrows.length,0);assert.equal(h.renderer.imports,0)
  assert.equal(h.canvasCreates,0);await h.manager.close()
})

test('v3 imported factory must expose actual two-phase resource interface before any owner authority',async()=>{
  const h=harness(),factory=h.runtime.createLoader
  h.runtime.createLoader=config=>{const actual=factory(config);return {admitWorkerPack:actual.admitWorkerPack,loadPinnedCanvasKit:actual.loadPinnedCanvasKit}}
  const ticket=h.manager.offer(offerValue(offered()));await assert.rejects(ticket.ready,/two-phase admission loader/)
  assert.equal(h.workers,0);assert.deepEqual(commands(h),[]);await h.manager.close()
})

test('v3 external preparation precedes old close and actual matching owner borrows same-loader lease',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  const next=h.manager.offer(h.publish(offered('2',{transportBackend:'external-frame'})));await next.ready;await tick()
  assert.equal(h.preparations.length,1);assert.equal(h.borrows.length,1);assert.equal(h.renderer.imports,1)
  assert.equal(h.renderer.decodes,1);assert.equal(h.renderer.deletes,1);assert.equal(h.canvasCreates,1)
  assert.ok(h.log.indexOf('renderer-prepared')<h.log.indexOf('close-start:1'))
  assert.ok(h.log.indexOf('close-final:1')<h.log.indexOf('worker:2'))
  assert.ok(h.log.indexOf('renderer-borrow')>h.log.indexOf('worker:2'))
  const borrowed=h.borrows[0],entry=h.entries[1]
  assert.deepEqual(borrowed.owner,entry.owner);assert.equal(borrowed.loadResult.pack.indexSha256,entry.owner.packSha256)
  assert.equal(borrowed.loadResult.state.sessionId,entry.owner.sessionId)
  assert.equal(borrowed.preparedRendererAssets.kind,'static-renderer-assets');assert.equal(borrowed.preparedRendererAssets.disposed,true)
  assert.equal(entry.assetOptions.CanvasKit,h.renderer.module);assert.equal(entry.assetOptions.fontData.byteLength,WORKER_RENDERER_PINS.font.size)
  assert.equal(h.loader.rendererResourceStatus().ownerLeases,1);assert.equal(h.loader.rendererResourceStatus().staticLeases,0)
  assert.equal(h.manager.status.executing.hasPresented,false,'static resource readiness is not accepted presentation')
  await h.manager.close();assert.equal(h.loader.rendererResourceStatus().ownerLeases,0)
})

test('v3 font decode failure preserves real prior owner and bridge before replacement permission',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));const ready=await first.ready;await tick()
  h.fontProbe=()=>null
  const ticket=h.manager.offer(h.publish(offered('2',{transportBackend:'external-frame'})));await assert.rejects(ticket.ready,/could not be decoded/)
  assert.equal(h.entries[0].raw.closes,0);assert.equal(h.workers,1);assert.equal(h.borrows.length,0)
  assert.equal(commands(h).filter(value=>value==='issueActivation').length,1)
  assert.equal((await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{}})).result.owner,'1')
  assert.equal(h.errors.at(-1).previousOwnerPreserved,true);assert.equal(h.manager.status.cleanupFailure,null)
  await h.manager.close()
})

test('v3 drawing import failure preserves actual prior owner and never borrows or constructs replacement',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));const ready=await first.ready;await tick()
  h.onDrawingImport=async()=>{throw error('ERR_RENDER','controlled drawing import failed')}
  const ticket=h.manager.offer(h.publish(offered('2',{transportBackend:'external-frame'})));await assert.rejects(ticket.ready,/drawing import failed/)
  assert.equal(h.entries[0].raw.closes,0);assert.equal(h.workers,1);assert.equal(h.borrows.length,0)
  assert.equal(h.renderer.revoked.length,2);assert.equal(h.loader.rendererResourceStatus().staticLeases,0)
  assert.equal((await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{}})).result.owner,'1')
  await h.manager.close()
})

test('v3 deferred drawing initializer cannot retire old owner or issue replacement authority early',async()=>{
  const initialized=deferred(),h=harness(),first=h.manager.offer(offerValue(offered()));const ready=await first.ready;await tick()
  h.onDrawingInit=()=>initialized.promise
  const next=h.manager.offer(h.publish(offered('2',{transportBackend:'external-frame'})));await until(()=>h.renderer.initializes===1)
  assert.equal(h.entries[0].raw.closes,0);assert.equal(h.workers,1);assert.equal(commands(h).filter(value=>value==='issueActivation').length,1)
  assert.equal((await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{}})).result.owner,'1')
  initialized.resolve(h.renderer.module);await next.ready;await tick()
  assert.equal(h.entries[0].raw.closes,1);assert.equal(h.workers,2);await h.manager.close()
})

test('v3 superseded pending initializer and actual revoke barrier cannot be bypassed by a new DOM offer',async()=>{
  const initialized=deferred(),revokeStarted=deferred(),revokeDone=deferred(),h=harness()
  const first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  h.onDrawingInit=()=>initialized.promise;h.onRevoke=async url=>{if(url.endsWith('/1')){revokeStarted.resolve();await revokeDone.promise}}
  const obsolete=h.manager.offer(h.publish(offered('2',{transportBackend:'external-frame'})));await until(()=>h.renderer.initializes===1)
  const obsoleteReady=assert.rejects(obsolete.ready,{code:'ERR_CANCELLED'})
  const newest=h.manager.offer(h.publish(offered('3')));await tick()
  assert.equal(h.entries[0].raw.closes,0);assert.equal(h.workers,1)
  initialized.resolve(h.renderer.module);await revokeStarted.promise;await tick()
  assert.equal(h.entries[0].raw.closes,0);assert.equal(commands(h).filter(value=>value==='issueActivation').length,1)
  assert.ok(h.manager.status.pendingOperations.some(value=>value.phase==='renderer-release'))
  revokeDone.resolve();await obsoleteReady;await newest.ready;await tick()
  assert.equal(h.workers,2);assert.equal(h.canvasCreates,0);assert.equal(h.preparations.length,1)
  assert.equal(h.loader.rendererResourceStatus().preparationWaiters,0);assert.equal(h.loader.rendererResourceStatus().staticLeases,0)
  await h.manager.close()
})

test('v3 late static lease after cancellation is retained and disposed before another owner can activate',async()=>{
  const returned=deferred(),releaseReturn=deferred(),h=harness();let heldLease
  const first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  h.afterPreparation=async lease=>{heldLease=lease;returned.resolve();await releaseReturn.promise}
  const obsolete=h.manager.offer(h.publish(offered('2',{transportBackend:'external-frame'})));await returned.promise
  const oldReady=assert.rejects(obsolete.ready,{code:'ERR_CANCELLED'}),newest=h.manager.offer(h.publish(offered('3')))
  await tick();assert.equal(h.entries[0].raw.closes,0);assert.equal(heldLease.disposed,true,'native cancellation can release static before delayed provider return')
  assert.ok(h.manager.status.pendingOperations.some(value=>value.phase==='renderer-release'))
  releaseReturn.resolve();await oldReady;await newest.ready;await tick()
  assert.equal(h.borrows.length,0);assert.equal(h.workers,2);assert.equal(h.loader.rendererResourceStatus().staticLeases,0)
  await h.manager.close()
})

test('v3 explicit cancellation has stable identity and awaits actual pending preparation cleanup',async()=>{
  const initialized=deferred(),h=harness(),first=h.manager.offer(offerValue(offered()));const ready=await first.ready;await tick()
  h.onDrawingInit=()=>initialized.promise
  const ticket=h.manager.offer(h.publish(offered('2',{transportBackend:'external-frame'})));await until(()=>h.renderer.initializes===1)
  const rejected=assert.rejects(ticket.ready,{code:'ERR_CANCELLED'}),a=ticket.cancel(),b=ticket.cancel();assert.equal(a,b)
  let settled=false;void a.then(()=>{settled=true},()=>{settled=true});await tick();assert.equal(settled,false)
  assert.equal(h.entries[0].raw.closes,0);initialized.resolve(h.renderer.module);await a;await rejected
  assert.equal(h.workers,1);assert.equal(h.borrows.length,0);assert.equal(h.loader.rendererResourceStatus().preparationWaiters,0)
  assert.equal((await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{}})).result.owner,'1')
  await h.manager.close()
})

test('v3 font cleanup uncertainty is sticky before old retirement and still cleans old owner on explicit close',async()=>{
  const h=harness(),first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  h.fontProbe=()=>({delete(){h.renderer.deletes++;throw error('ERR_RENDER','controlled temporary font delete failure')}})
  const next=h.manager.offer(h.publish(offered('2',{transportBackend:'external-frame'})));await assert.rejects(next.ready)
  assert.equal(h.entries[0].raw.closes,0);assert.equal(h.workers,1);assert.ok(h.manager.status.cleanupFailure)
  assert.throws(()=>h.manager.offer(h.publish(offered('3'))),/cleanup is uncertain/)
  await assert.rejects(h.manager.close());assert.equal(h.entries[0].raw.closes,1);assert.equal(h.control.owner,null)
})

test('v3 failed static disposal after real borrow cleans the untransferred independent owner lease',async()=>{
  const first=offered('1',{transportBackend:'external-frame'}),h=harness({first})
  let borrowedBeforeFailure=false,disposalFailed=false
  h.afterBorrow=()=>{
    assert.equal(h.loader.rendererResourceStatus().ownerLeases,1)
    borrowedBeforeFailure=true
    const signal=h.preparations[0].signal,remove=signal.removeEventListener.bind(signal)
    signal.removeEventListener=(...args)=>{
      signal.removeEventListener=remove;disposalFailed=true
      throw error('ERR_RENDER','controlled static listener cleanup failure')
    }
  }
  const ticket=h.manager.offer(offerValue(first));await assert.rejects(ticket.ready)
  await until(()=>h.control.owner?.phase==='close-uncertain'&&h.entries[0].raw.closes===1)
  assert.equal(borrowedBeforeFailure,true);assert.equal(disposalFailed,true)
  assert.equal(h.borrows.length,1);assert.equal(h.canvasCreates,0)
  assert.equal(h.loader.rendererResourceStatus().ownerFontBytes,0);assert.equal(h.loader.rendererResourceStatus().staticLeases,0)
  assert.ok(h.manager.status.cleanupFailure);assert.equal(h.entries[0].raw.closes,1)
  await assert.rejects(h.manager.close());assert.equal(h.control.owner?.phase,'close-uncertain','actual fatal close cannot be upgraded to a successful server cleanup receipt')
})

test('v3 supersession during actual borrow transfers late owner lease only for real owner cleanup',async()=>{
  const borrowed=deferred(),releaseBorrow=deferred(),h=harness();let lateLease
  const first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  h.afterBorrow=async lease=>{lateLease=lease;borrowed.resolve();await releaseBorrow.promise}
  const obsolete=h.manager.offer(h.publish(offered('2',{transportBackend:'external-frame'})));await borrowed.promise
  const rejected=assert.rejects(obsolete.ready,{code:'ERR_CANCELLED'}),newest=h.manager.offer(h.publish(offered('3')))
  await tick();assert.equal(h.workers,2);assert.equal(h.loader.rendererResourceStatus().ownerLeases,1)
  releaseBorrow.resolve();await rejected;await newest.ready;await tick()
  assert.throws(()=>lateLease.fontData,{code:'ERR_CANCELLED'})
  assert.equal(h.loader.rendererResourceStatus().ownerLeases,0);assert.equal(h.loader.rendererResourceStatus().ownerFontBytes,0)
  assert.equal(h.entries[1].raw.closes,1);assert.equal(h.workers,3)
  assert.ok(h.log.indexOf('close-final:2')<h.log.indexOf('worker:3'))
  await h.manager.close()
})


test('v3 cancellation after real static readiness accepts its late already-disposed opaque lease without protocol fault',async()=>{
  const returned=deferred(),releaseReturn=deferred(),h=harness();let held
  const first=h.manager.offer(offerValue(offered()));const ready=await first.ready;await tick()
  h.afterPreparation=async lease=>{held=lease;returned.resolve();await releaseReturn.promise}
  const ticket=h.manager.offer(h.publish(offered('2',{transportBackend:'external-frame'})));await returned.promise
  const rejected=assert.rejects(ticket.ready,{code:'ERR_CANCELLED'}),cancelling=ticket.cancel();let settled=false
  void cancelling.then(()=>{settled=true},()=>{settled=true});await tick();assert.equal(settled,false);assert.equal(held.disposed,true)
  releaseReturn.resolve();await cancelling;await rejected
  assert.equal(h.manager.status.cleanupFailure,null);assert.equal(h.borrows.length,0);assert.equal(h.entries[0].raw.closes,0)
  assert.equal((await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{}})).result.owner,'1')
  await h.manager.close()
})

test('v3 manager close retains pending preparation until actual initializer and cleanup settle',async()=>{
  const initialized=deferred(),h=harness(),first=h.manager.offer(offerValue(offered()));await first.ready;await tick()
  h.onDrawingInit=()=>initialized.promise
  const ticket=h.manager.offer(h.publish(offered('2',{transportBackend:'external-frame'})));await until(()=>h.renderer.initializes===1)
  const rejected=assert.rejects(ticket.ready,{code:'ERR_CANCELLED'}),closing=h.manager.close();assert.equal(closing,h.manager.close())
  let settled=false;void closing.then(()=>{settled=true},()=>{settled=true});await tick()
  assert.equal(settled,false);assert.equal(h.workers,1);assert.equal(h.borrows.length,0)
  initialized.resolve(h.renderer.module);const receipt=await closing;await rejected
  assert.equal(receipt.closed,true);assert.equal(h.control.owner,null);assert.equal(h.control.stopped,true)
  assert.equal(h.loader.rendererResourceStatus().preparationWaiters,0);assert.equal(h.loader.rendererResourceStatus().staticLeases,0)
  assert.equal(h.loader.rendererResourceStatus().ownerLeases,0);assert.equal(h.entries[0].raw.closes,1)
})

// ACK seam contracts. Transport/HTTP bytes below are DOUBLES;
// these do not execute Rust, HTTP, a Worker, browser, presenter or GPU.
async function finishAcknowledgements(h) {
  for(let i=0;i<100&&h.manager.status.finalAcknowledgements.pending;i++) {
    h.manager.retryFinalAcknowledgements({maxOperations:64});await tick()
  }
  assert.equal(h.manager.status.finalAcknowledgements.pending,0)
}
function startOneAcknowledgement(h) {
  for(let i=0;i<=h.control.requests.length+1;i++){
    const result=h.manager.retryFinalAcknowledgements({maxOperations:1})
    assert.ok(result.inspected<=1)
    if(result.started)return result
  }
  assert.fail('bounded cursor did not reach a retryable retained final')
}

test('final ACK optional seam preserves legacy control and reports its resource boundary',async()=>{
  const h=harness();await h.manager.offer(offerValue(offered())).ready
  assert.equal(h.manager.status.finalAcknowledgements.enabled,false)
  assert.equal(h.manager.status.finalAcknowledgements.pending,0)
  const closed=await h.manager.close()
  assert.equal(closed.closed,true);assert.equal(closed.transportDrained,true)
})

test('final ACK receives the frozen original parsed object only after complete adoption',async()=>{
  const wire=new WeakMap(),seen=[]
  const h=harness({acknowledge(request,raw,env){
    assert.ok(Object.isFrozen(raw));assert.ok(Object.isFrozen(raw.snapshot))
    const retained=wire.get(raw);assert.ok(retained,'original parsed identity survived copy/adopt')
    assert.equal(request,retained.request);assert.equal(raw,retained.parsed)
    assert.notEqual(retained.sha256,sha256(bytes(JSON.stringify(raw))),'raw wire whitespace is significant')
    assert.ok(BigInt(env.manager.status.snapshot.controlRevision)>=BigInt(raw.snapshot.controlRevision))
    if(request.command==='startOwner')assert.deepEqual(env.manager.status.executing.ownerKey,raw.result.owner)
    seen.push(request.requestId)
  }})
  h.onReply=(request,final)=>{
    const text=JSON.stringify(final,null,2)+'\n',parsed=JSON.parse(text)
    wire.set(parsed,{request,parsed,sha256:sha256(bytes(text))});return parsed
  }
  await h.manager.offer(offerValue(offered())).ready;await tick()
  assert.equal(h.manager.status.uncertain,null);assert.equal(h.manager.status.finalAcknowledgements.pending,0)
  assert.equal(new Set(seen).size,seen.length);assert.equal(seen.length,h.control.requests.length)
  await h.manager.close();await tick();assert.equal(seen.length,h.control.requests.length)
})

test('synchronous ACK throw preserves retained final and explicitly retries the same command once',async()=>{
  const retry=deferred(),calls=[];let failed=false
  const h=harness({acknowledge(request,raw){
    calls.push({request,raw})
    if(request.command==='startOwner'){
      if(!failed){failed=true;throw error('ERR_CAPACITY','retained server body still borrowed')}
      return retry.promise
    }
  }})
  await h.manager.offer(offerValue(offered())).ready;await tick()
  assert.equal(h.workers,1);assert.equal(h.manager.status.executing.retired,false)
  assert.equal(h.manager.status.uncertain,null);assert.equal(h.manager.status.terminalControlFailure,null)
  assert.equal(h.manager.status.finalAcknowledgements.pending,1);assert.equal(h.manager.status.finalAcknowledgements.failed,1)
  const original=calls.find(value=>value.request.command==='startOwner'),invokes=h.control.requests.length
  const first=startOneAcknowledgement(h)
  assert.equal(first.started,1);assert.equal(h.manager.retryFinalAcknowledgements().started,0)
  await tick();assert.equal(h.manager.status.finalAcknowledgements.inFlight,1)
  const attempts=calls.filter(value=>value.request.command==='startOwner')
  assert.equal(attempts.length,2);assert.equal(attempts[1].request,original.request);assert.equal(attempts[1].raw,original.raw)
  assert.equal(h.control.requests.length,invokes,'ACK retry did not invoke another mutation')
  assert.equal(h.control.replays.length,0)
  retry.resolve();await tick();assert.equal(h.manager.status.finalAcknowledgements.pending,0)
  await h.manager.close()
})

test('validated error finals ACK after adoption even though the original command rejects',async()=>{
  const calls=[],h=harness({acknowledge(request,raw){calls.push({request,raw})}})
  h.beforeControl=(request,server)=>{if(request.command==='issueActivation')server.bump()}
  await assert.rejects(h.manager.offer(offerValue(offered())).ready);await tick()
  const failed=calls.filter(value=>value.request.command==='issueActivation')
  assert.ok(failed.length>0);assert.ok(failed.every(value=>value.raw.status==='error'&&Object.isFrozen(value.raw)))
  assert.equal(new Set(failed.map(value=>value.request.requestId)).size,failed.length)
  assert.equal(h.manager.status.finalAcknowledgements.pending,0);assert.equal(h.workers,0)
  await h.manager.close()
})

test('asynchronous ACK failure never becomes owner cleanup or control uncertainty',async()=>{
  let failAck=true;const h=harness({acknowledge(){return failAck?Promise.reject(error('ERR_TIMEOUT','ACK response lost')):undefined}})
  await h.manager.offer(offerValue(offered())).ready;await tick()
  assert.equal(h.manager.status.uncertain,null);assert.equal(h.manager.status.cleanupFailure,null)
  assert.equal(h.manager.status.executing.retired,false);assert.equal(h.entries[0].raw.closes,0)
  assert.equal(h.manager.status.finalAcknowledgements.failed,h.control.requests.length)
  const reconciled=await h.manager.recover()
  assert.equal(reconciled.controlReconciled,true);assert.equal(reconciled.transportDrained,false)
  const count=h.control.requests.length;failAck=false;await finishAcknowledgements(h)
  assert.equal(h.control.requests.length,count);await h.manager.close()
})

test('ACK global capacity and bounded explicit retry own no background retry queue',async()=>{
  const gates=[],raws=[],h=harness({managerOptions:{maxFinalAcknowledgementsInFlight:2},acknowledge(request){
    const gate=deferred();gates.push({request,gate});return gate.promise
  }})
  h.onReply=(_request,raw)=>{raws.push(raw);return raw}
  await h.manager.offer(offerValue(offered())).ready;await tick()
  assert.equal(gates.length,2);assert.equal(h.manager.status.finalAcknowledgements.inFlight,2)
  assert.ok(raws.every(raw=>Object.isFrozen(raw)&&Object.isFrozen(raw.snapshot)),'queued original finals are immutable before ACK admission')
  assert.equal(h.manager.status.finalAcknowledgements.pending,h.control.requests.length)
  assert.equal(h.manager.retryFinalAcknowledgements({maxOperations:64}).started,0)
  gates[0].gate.resolve();gates[1].gate.resolve();await tick()
  assert.equal(h.manager.status.finalAcknowledgements.inFlight,0)
  assert.equal(gates.length,2,'settlement did not append a background retry')
  assert.equal(startOneAcknowledgement(h).started,1)
  assert.equal(startOneAcknowledgement(h).started,1)
  assert.equal(h.manager.retryFinalAcknowledgements({maxOperations:1}).started,0)
  await tick();assert.equal(gates.length,4)
  for(const value of gates)value.gate.resolve();await tick()
  // Close is required to finish its old owner even with ACK capacity occupied.
  const closing=h.manager.close();await until(()=>h.control.owner===null)
  const closed=await closing;assert.equal(closed.workerClosed,true);assert.equal(closed.coordinatorStopped,true)
  assert.equal(closed.transportDrained,false);assert.ok(closed.finalAcknowledgements.pending>0)
  for(let i=0;i<20&&h.manager.status.finalAcknowledgements.pending;i++){
    for(const value of gates)value.gate.resolve()
    await tick();h.manager.retryFinalAcknowledgements({maxOperations:64});await tick()
  }
  for(const value of gates)value.gate.resolve();await tick()
  assert.equal(h.manager.status.finalAcknowledgements.pending,0)
})

test('ACK retry cursor counts skipped ledger entries and advances within each explicit scan budget',async()=>{
  let failed=false;const calls=[],h=harness({acknowledge(request){
    calls.push(request.requestId)
    if(request.command==='runtimeReady'&&!failed){failed=true;throw error('ERR_TIMEOUT')}
  }})
  await h.manager.offer(offerValue(offered())).ready;await tick()
  assert.equal(h.manager.status.finalAcknowledgements.failed,1)
  const count=h.control.requests.length
  assert.equal(h.control.requests[count-1].command,'runtimeReady')
  for(let i=0;i<count-1;i++){
    const result=h.manager.retryFinalAcknowledgements({maxOperations:1})
    assert.equal(result.inspected,1);assert.equal(result.started,0)
    assert.equal(h.manager.status.finalAcknowledgements.pending,1)
  }
  const retry=h.manager.retryFinalAcknowledgements({maxOperations:1})
  assert.equal(retry.inspected,1);assert.equal(retry.started,1)
  assert.equal(h.manager.status.finalAcknowledgements.failed,0,'failed counter changes at retry admission')
  await tick();assert.equal(h.manager.status.finalAcknowledgements.pending,0)
  assert.equal(h.control.requests.length,count);assert.equal(calls.length,count+1)
  const end=h.manager.retryFinalAcknowledgements({maxOperations:1})
  assert.equal(end.inspected,1);assert.equal(end.reachedEnd,true)
  assert.equal(h.manager.retryFinalAcknowledgements({maxOperations:1}).inspected,1,'end resets the original Map iterator')
  await h.manager.close()
})

test('close and recover report a hanging actual ACK without blocking mandatory owner close',async()=>{
  const gate=deferred(),h=harness({acknowledge(){return gate.promise}})
  await h.manager.offer(offerValue(offered())).ready;await tick()
  const before=h.manager.status.finalAcknowledgements.inFlight
  assert.ok(before>0)
  for(let i=0;i<5;i++){
    const result=h.manager.retryFinalAcknowledgements()
    assert.equal(result.started,0);assert.equal(result.finalAcknowledgements.inFlight,before)
  }
  assert.equal(h.manager.status.pendingOperations.some(value=>value.phase.startsWith('final-ack')),false)
  const recovering=await h.manager.recover()
  assert.equal(recovering.controlReconciled,true);assert.equal(recovering.transportDrained,false)
  const closed=await h.manager.close()
  assert.equal(closed.closed,true);assert.equal(closed.workerClosed,true);assert.equal(h.entries[0].raw.closes,1)
  assert.equal(h.control.owner,null);assert.equal(h.control.stopped,true)
  assert.ok(closed.finalAcknowledgements.inFlight>0);assert.equal(closed.transportDrained,false)
  assert.equal(h.manager.status.uncertain,null)
  gate.resolve();await tick();await finishAcknowledgements(h)
  assert.equal(h.manager.status.transportDrained,true)
  assert.equal(closed.transportDrained,false,'close receipt is an immutable point-in-time resource report')
})

test('control drain owns ACK reservation through manager adoption beyond the underlying transport promise',async()=>{
  const gate=deferred(),entered=deferred(),calls=[];let failed=true
  const h=harness({acknowledge(request){
    calls.push(request)
    if(failed)throw error('ERR_TIMEOUT','first ACK failed before explicit retry')
    entered.resolve();return gate.promise
  }})
  await h.manager.refreshSnapshot();await h.manager.drainControlWork()
  assert.equal(h.manager.status.finalAcknowledgements.failed,1)
  failed=false;assert.equal(h.manager.retryFinalAcknowledgements({maxOperations:64}).started,1)
  assert.equal(calls.length,1,'adapter invocation is still deferred behind the registered reservation')
  let settled=false
  const draining=h.manager.drainControlWork().then(status=>{settled=true;return status})
  await entered.promise;assert.equal(settled,false)
  gate.resolve();await gate.promise
  assert.equal(h.manager.status.finalAcknowledgements.pending,1,'transport completion precedes manager settlement')
  const drained=await draining
  assert.equal(drained.finalAcknowledgements.pending,0);assert.equal(drained.finalAcknowledgements.inFlight,0)
  assert.equal(drained.finalAcknowledgements.failed,0);assert.equal(drained.transportDrained,true)
  assert.equal(calls.length,2);assert.equal(calls[0],calls[1]);assert.equal(h.control.requests.length,1)
  assert.ok(drained.history.some(value=>value.kind==='final-acknowledged'))
  assert.equal(h.control.replays.length,0)
  await h.manager.close();await h.manager.drainControlWork()
})

test('control drain reports ACK failure and queued finals without retrying or blocking mandatory close',async()=>{
  const gate=deferred(),calls=[],h=harness({retirement:true,managerOptions:{maxFinalAcknowledgementsInFlight:1},
    acknowledge(request){calls.push(request);return gate.promise}})
  await h.manager.offer(offerValue(offered())).ready;await until(()=>h.manager.status.pendingOperations.length===0)
  const commandsBefore=h.control.requests.length
  assert.equal(calls.length,1)
  const draining=h.manager.drainControlWork();gate.reject(error('ERR_TIMEOUT','late ACK failed'))
  const drained=await draining
  assert.equal(drained.finalAcknowledgements.failed,1);assert.equal(drained.finalAcknowledgements.inFlight,0)
  assert.equal(drained.finalAcknowledgements.pending,commandsBefore)
  assert.equal(drained.finalAcknowledgements.queued,commandsBefore-1);assert.equal(drained.transportDrained,false)
  assert.equal(calls.length,1);assert.equal(h.control.requests.length,commandsBefore);assert.equal(h.retirementCalls.length,0)
  assert.equal(drained.uncertain,null);assert.equal(drained.cleanupFailure,null)
  const closed=await h.manager.close();assert.equal(closed.workerClosed,true);assert.equal(h.entries[0].raw.closes,1)
  const afterClose=await h.manager.drainControlWork()
  assert.ok(afterClose.finalAcknowledgements.failed>0);assert.equal(afterClose.finalAcknowledgements.inFlight,0)
  assert.equal(afterClose.transportDrained,false);assert.equal(h.control.owner,null)
  h.acknowledge=()=>undefined;await finishRetirements(h)
})

test('control drain adopts late retirement success or failure without creating a retry or changing owner cleanup',async()=>{
  for(const failure of [false,true]){
    const gate=deferred(),entered=deferred(),h=harness({retirement:true,retire(_requests,_env,commit){
      entered.resolve();return gate.promise.then(()=>{if(failure)throw error('ERR_TIMEOUT','retirement reply lost');return commit()})
    }})
    await h.manager.offer(offerValue(offered())).ready;await until(()=>h.manager.status.pendingOperations.length===0)
    await h.manager.drainControlWork()
    const commandsBefore=h.control.requests.length
    assert.equal(h.manager.retryControlRetirements({maxOperations:64}).started,1)
    assert.equal(h.retirementCalls.length,0,'reservation exists before the actual adapter starts')
    const draining=h.manager.drainControlWork();await entered.promise
    gate.resolve();const drained=await draining
    assert.equal(drained.controlRetirements.inFlight,0);assert.equal(drained.controlRetirements.pending,Number(failure))
    assert.equal(drained.controlRetirements.failed,Number(failure))
    assert.equal(drained.controlRetirements.retainedCommands,failure?commandsBefore:0)
    assert.equal(drained.transportDrained,!failure);assert.equal(drained.uncertain,null)
    assert.equal(h.retirementCalls.length,1);assert.equal(h.control.requests.length,commandsBefore)
    const closed=await h.manager.close();assert.equal(closed.workerClosed,true);assert.equal(h.control.owner,null)
    await h.manager.drainControlWork();assert.equal(h.retirementCalls.length,1,'close/drain did not start another retirement')
    h.retire=(_requests,_env,commit)=>Promise.resolve(commit());await finishRetirements(h)
  }
})

test('Stop drains already-owned ACK and retirement adoption after Worker close without admitting more control work',async()=>{
  const acknowledgements=deferred(),retirement=deferred(),retirementEntered=deferred()
  const h=harness({retirement:true,acknowledge(request){if(request.requestId.includes(':cleanup-'))return acknowledgements.promise},
    retire(_requests,_env,commit){retirementEntered.resolve();return retirement.promise.then(commit)}})
  await h.manager.offer(offerValue(offered())).ready;await until(()=>h.manager.status.pendingOperations.length===0)
  await h.manager.drainControlWork();h.manager.retryControlRetirements({maxOperations:64});await retirementEntered.promise
  const closed=await h.manager.close()
  assert.equal(closed.workerClosed,true);assert.equal(closed.coordinatorStopped,true);assert.equal(closed.transportDrained,false)
  assert.ok(closed.finalAcknowledgements.inFlight>0);assert.equal(closed.controlRetirements.inFlight,1)
  const commandsBefore=h.control.requests.length;let settled=false
  const draining=h.manager.drainControlWork().then(status=>{settled=true;return status})
  acknowledgements.resolve();await until(()=>h.manager.status.finalAcknowledgements.inFlight===0)
  assert.equal(settled,false,'retirement remains an independent owned barrier after ACK adoption')
  retirement.resolve();const drained=await draining
  assert.equal(drained.phase,'closed');assert.equal(drained.finalAcknowledgements.pending,0)
  assert.equal(drained.controlRetirements.pending,0);assert.equal(drained.transportDrained,true)
  assert.equal(drained.controlRetirements.cleanupRetained,2,'Stop did not mint a new cleanup retirement transaction')
  assert.equal(h.retirementCalls.length,1);assert.equal(h.control.requests.length,commandsBefore);assert.equal(h.control.replays.length,0)
  assert.equal(h.entries[0].raw.closes,1);assert.equal(h.control.owner,null)
})

test('control drain snapshots registered work and reports rather than waits for later ACK admission',async()=>{
  const first=deferred(),second=deferred(),calls=[],h=harness({acknowledge(request){
    calls.push(request);return request.requestId.endsWith('control-1')?first.promise:second.promise
  }})
  await h.manager.refreshSnapshot()
  const draining=h.manager.drainControlWork()
  await h.manager.refreshSnapshot();assert.equal(h.manager.status.finalAcknowledgements.inFlight,2)
  first.resolve();const drained=await draining
  assert.equal(drained.finalAcknowledgements.inFlight,1);assert.equal(drained.finalAcknowledgements.pending,1)
  assert.equal(drained.transportDrained,false);assert.equal(calls.length,2);assert.equal(h.control.requests.length,2)
  second.resolve();assert.equal((await h.manager.drainControlWork()).finalAcknowledgements.pending,0)
  await h.manager.close();await h.manager.drainControlWork()
})

test('queued or invalid finals never ACK; genuine replay ACKs only its adopted original object',async()=>{
  const calls=[],h=harness({acknowledge(request,raw){calls.push({request,raw})}});let available=false
  const queued={queued:true}
  h.onReply=(request,final)=>request.command==='beginActivation'?queued:final
  h.onReplay=(request,final)=>{if(request.command==='beginActivation'&&!available)throw error('ERR_TIMEOUT');return final}
  await assert.rejects(h.manager.offer(offerValue(offered())).ready);await tick()
  assert.ok(h.manager.status.uncertain)
  assert.equal(calls.some(value=>value.raw===queued||value.request.command==='beginActivation'),false)
  available=true;await h.manager.recover();await tick()
  assert.equal(calls.filter(value=>value.request.command==='beginActivation').length,1)
  assert.equal(h.control.requests.filter(value=>value.command==='beginActivation').length,1)
  await h.manager.close()
})

test('late equal invoke after genuine replay adoption never duplicates its ACK',async()=>{
  const gate=deferred(),calls=[],h=harness({acknowledge(request,raw){calls.push({request,raw})}});let waiting=false
  h.onReply=async(request,final)=>{if(request.command==='startOwner'){waiting=true;await gate.promise}return final}
  h.runBounded=(actual,details)=>details.phase==='control:startOwner'?Promise.reject(error('ERR_TIMEOUT')):controlledWait(actual,details)
  await assert.rejects(h.manager.offer(offerValue(offered())).ready);await until(()=>waiting)
  await h.manager.recover();await tick()
  assert.equal(calls.filter(value=>value.request.command==='startOwner').length,1)
  gate.resolve();await tick()
  assert.equal(calls.filter(value=>value.request.command==='startOwner').length,1)
  assert.equal(h.manager.status.terminalControlFailure,null)
  await h.manager.close()
})

test('late conflicting final is not ACKed and cannot retry or retire the conflicted op',async()=>{
  const gate=deferred(),calls=[],h=harness({retirement:true,acknowledge(request,raw){calls.push({request,raw});if(request.command==='startOwner')throw error('ERR_TIMEOUT')}});let waiting=false,conflict
  h.onReply=async(request,final)=>{
    if(request.command==='startOwner'){waiting=true;await gate.promise;conflict=clone(final);conflict.result.owner.ownerSerial='999';conflict.snapshot.ownerKey.ownerSerial='999';conflict.snapshot.controlRevision='999';return conflict}
    return final
  }
  h.runBounded=(actual,details)=>details.phase==='control:startOwner'?Promise.reject(error('ERR_TIMEOUT')):controlledWait(actual,details)
  await assert.rejects(h.manager.offer(offerValue(offered())).ready);await until(()=>waiting)
  await h.manager.recover();await tick()
  assert.equal(calls.filter(value=>value.request.command==='startOwner').length,1)
  gate.resolve();await until(()=>h.manager.status.terminalControlFailure)
  h.manager.retryFinalAcknowledgements({maxOperations:64});await tick()
  assert.equal(calls.filter(value=>value.request.command==='startOwner').length,1)
  assert.equal(calls.some(value=>value.raw===conflict),false)
  assert.equal(h.manager.status.finalAcknowledgements.blocked,1)
  assert.equal(h.manager.retryControlRetirements({maxOperations:64}).started,0)
  assert.equal(h.retirementCalls.length,0)
  await assert.rejects(h.manager.close())
})

test('ACK retry budgets and optional adapter reject invalid configuration',async()=>{
  for(const value of [0,-1,1.5,65,Infinity]){
    const h=harness();assert.throws(()=>h.manager.retryFinalAcknowledgements({maxOperations:value}),{code:'ERR_PROTOCOL_VERSION'});await h.manager.close()
    assert.throws(()=>harness({managerOptions:{maxFinalAcknowledgementsInFlight:value}}),{code:'ERR_PROTOCOL_VERSION'})
  }
  assert.throws(()=>harness({managerOptions:{control:{invoke(){},replay(){},acknowledge:true}}}),{code:'ERR_PROTOCOL_VERSION'})
})


async function finishRetirements(h) {
  for(let i=0;i<200;i++){
    h.manager.retryFinalAcknowledgements({maxOperations:64})
    h.manager.retryControlRetirements({maxOperations:64});await tick()
    const state=h.manager.status.controlRetirements
    if(state.retainedCommands===0&&state.pending===0)return
  }
  assert.fail(`retirement did not drain: ${JSON.stringify(h.manager.status.controlRetirements)}`)
}

test('retirement is negotiated explicitly and legacy lifetime limits remain unchanged',async()=>{
  const h=harness({managerOptions:{maxControlCommands:1}})
  await h.manager.refreshSnapshot();await tick()
  const state=h.manager.retryControlRetirements({maxOperations:64})
  assert.equal(state.started,0);assert.equal(state.controlRetirements.enabled,false)
  assert.equal(state.controlRetirements.retainedCommands,1)
  await assert.rejects(h.manager.refreshSnapshot(),{code:'ERR_PROTOCOL_VERSION'})
  await h.manager.close()
  assert.throws(()=>harness({managerOptions:{control:{invoke(){},replay(){},capabilities:{retirementVersion:'2.0'}}}}),{code:'ERR_PROTOCOL_VERSION'})
  assert.throws(()=>harness({managerOptions:{control:{invoke(){},replay(){},acknowledge(){},capabilities:{retirementVersion:'1.0'}}}}),{code:'ERR_PROTOCOL_VERSION'})
})

test('adopted ACKed prefixes release retained capacity through repeated offers without resetting serials',async()=>{
  const h=harness({retirement:true,managerOptions:{maxControlCommands:8}})
  for(let generation=1;generation<=40;generation++){
    const offer=generation===1?offerValue(offered()):h.publish(offered(String(generation)))
    await h.manager.offer(offer).ready;await tick();await finishRetirements(h)
    assert.equal(h.manager.status.controlRetirements.normalRetained,0)
    assert.equal(h.manager.status.controlRetirements.cleanupRetained,0)
    assert.equal(h.manager.status.uncertain,null)
    assert.equal(h.control.ledger.size,0)
  }
  assert.ok(h.control.requests.length>200)
  const normal=h.control.requests.filter(request=>request.requestId.includes(':control-'))
  const cleanup=h.control.requests.filter(request=>request.requestId.includes(':cleanup-'))
  assert.ok(normal.length>8);assert.ok(cleanup.length>0)
  assert.ok(normal.every((request,index)=>BigInt(request.requestId.split('-').at(-1))===BigInt(index+1)))
  assert.ok(cleanup.every((request,index)=>BigInt(request.requestId.split('-').at(-1))===BigInt(index+1)))
  const closed=await h.manager.close();await tick();assert.equal(closed.closed,true)
  assert.equal(h.control.owner,null);assert.equal(h.entries.every(entry=>entry.raw.closes===1),true)
  await finishRetirements(h);assert.equal(h.manager.status.transportDrained,true)
})

test('unACKed earliest command blocks retirement instead of skipping to later adopted finals',async()=>{
  const gate=deferred(),h=harness({retirement:true,acknowledge(request){if(request.requestId.endsWith('control-1'))return gate.promise}})
  await h.manager.offer(offerValue(offered())).ready;await tick()
  assert.equal(h.manager.retryControlRetirements({maxOperations:64}).started,0)
  assert.equal(h.retirementCalls.length,0)
  gate.resolve();await tick();await finishRetirements(h)
  assert.ok(h.retirementCalls.length>0)
  await h.manager.close();await tick();await finishRetirements(h)
})

test('lost retirement reply retains exact batch and retries its original command objects without mutation replay',async()=>{
  const gate=deferred();let first=true
  const h=harness({retirement:true,retire(requests,_env,commit){
    if(first){first=false;commit();return Promise.reject(error('ERR_TIMEOUT','original retirement reply lost'))}
    return gate.promise.then(commit)
  }})
  await h.manager.offer(offerValue(offered())).ready;await tick()
  const before=h.control.requests.length,started=h.manager.retryControlRetirements({maxOperations:64})
  assert.equal(started.started,1);await tick()
  const failed=h.manager.status.controlRetirements
  assert.equal(failed.failed,1);assert.ok(failed.retainedCommands>0)
  assert.equal(h.manager.status.uncertain,null)
  h.manager.retryControlRetirements({maxOperations:64});await tick()
  assert.equal(h.retirementCalls.length,2);assert.equal(h.retirementCalls[1],h.retirementCalls[0])
  assert.ok(h.retirementCalls[1].every((request,index)=>request===h.retirementCalls[0][index]))
  assert.equal(h.manager.retryControlRetirements({maxOperations:64}).started,0)
  gate.resolve();await tick();assert.equal(h.manager.status.controlRetirements.retainedCommands,0)
  assert.equal(h.control.requests.length,before);assert.equal(h.control.replays.length,0)
  assert.equal(h.manager.status.controlRetirements.pending,0)
  await h.manager.close();await tick();await finishRetirements(h)
})

test('invalid retirement receipt never releases records or prevents required Worker and server close',async()=>{
  let wrong=true
  const h=harness({retirement:true,retire(_requests,_env,commit){const receipt=commit();return Promise.resolve(wrong?{...receipt,clientId:'foreign'}:receipt)}})
  await h.manager.offer(offerValue(offered())).ready;await tick()
  h.manager.retryControlRetirements({maxOperations:64});await tick()
  assert.equal(h.manager.status.controlRetirements.failed,1)
  assert.ok(h.manager.status.controlRetirements.retainedCommands>0)
  assert.equal(h.manager.status.transportDrained,false)
  const retry=h.manager.retryFinalAcknowledgements({maxOperations:64})
  assert.equal(retry.transportDrained,false);assert.equal(retry.controlRetirements.failed,1)
  const recovered=await h.manager.recover();assert.equal(recovered.controlReconciled,true);assert.equal(recovered.transportDrained,false)
  const closed=await h.manager.close();assert.equal(closed.closed,true);assert.equal(closed.workerClosed,true)
  assert.equal(closed.transportDrained,false);assert.equal(h.control.owner,null);assert.equal(h.entries[0].raw.closes,1)
  assert.equal(h.manager.status.uncertain,null)
  wrong=false;await tick();await finishRetirements(h)
  assert.equal(h.manager.status.transportDrained,true)
})

test('retirement adapter reentry sees published pending barrier and cannot duplicate the batch',async()=>{
  const gate=deferred();let reentries=0
  const h=harness({retirement:true,retire(_requests,env,commit){
    reentries++;assert.equal(env.manager.status.controlRetirements.inFlight,1)
    assert.equal(env.manager.status.transportDrained,false)
    const acks=env.manager.retryFinalAcknowledgements({maxOperations:64})
    assert.equal(acks.transportDrained,false);assert.equal(acks.controlRetirements.inFlight,1)
    assert.equal(env.manager.retryControlRetirements({maxOperations:64}).started,0)
    return gate.promise.then(commit)
  }})
  await h.manager.offer(offerValue(offered())).ready;await tick()
  const first=h.manager.retryControlRetirements({maxOperations:64});assert.equal(first.started,1)
  await tick();assert.equal(reentries,1)
  const closing=h.manager.close();await tick()
  assert.equal(h.entries[0].raw.closes,1)
  const closed=await closing;assert.equal(closed.workerClosed,true);assert.equal(closed.transportDrained,false)
  gate.resolve();await tick();await finishRetirements(h)
})

test('late actual invoke blocks a replay-adopted and ACKed command until its genuine work settles',async()=>{
  const gate=deferred(),h=harness({retirement:true});let waiting=false
  h.onReply=async(request,final)=>{if(request.command==='snapshot'&&!waiting){waiting=true;await gate.promise}return final}
  h.runBounded=(actual,details)=>details.phase==='control:snapshot'?Promise.reject(error('ERR_TIMEOUT')):controlledWait(actual,details)
  await assert.rejects(h.manager.refreshSnapshot());await until(()=>waiting)
  await h.manager.recover();await tick()
  assert.equal(h.manager.status.finalAcknowledgements.pending,0)
  assert.equal(h.manager.retryControlRetirements({maxOperations:64}).started,0)
  assert.equal(h.retirementCalls.length,0)
  gate.resolve();await tick();await finishRetirements(h)
  h.runBounded=null;await h.manager.close();await tick();await finishRetirements(h)
})

test('retirement scan is explicitly bounded and preserves independent cleanup progress',async()=>{
  const h=harness({retirement:true});await h.manager.offer(offerValue(offered())).ready;await tick()
  for(let i=0;i<3;i++){
    const scan=h.manager.retryControlRetirements({maxOperations:1});assert.ok(scan.inspected<=1);assert.ok(scan.started<=1);await tick()
  }
  await finishRetirements(h)
  const closed=await h.manager.close();await tick();assert.equal(closed.closed,true)
  await finishRetirements(h)
  for(const value of [0,-1,1.5,65,Infinity])assert.throws(()=>h.manager.retryControlRetirements({maxOperations:value}),{code:'ERR_PROTOCOL_VERSION'})
})

// Contract doubles below describe the receipt boundary, not physical GPU work.
const gpuSubmission = (e, changes = {}) => ({ version:'1.0',status:'submitted',owner:clone(e.owner),attemptId:'1',surfaceGeneration:'1',renderRevision:'5',
  frameId:4,presenterGeneration:1,viewport:rect(),physicalSize:{width:750,height:1334},backend:'canvaskit-webgl2',
  context:{api:'webgl2',version:'WebGL 2.0',vendor:'contract double',renderer:'contract renderer',unmaskedVendor:null,unmaskedRenderer:null,
    surfaceIsGpu:true,contextLost:false,physicalHardware:'unknown'},
  runtimeBoundary:{frameBatches:1,perNodeRuntimeCalls:0,softwareRgbaUploads:0},
  presentation:{pictureSubmissions:1,flushes:1,gpuCompletion:'not-waited',glError:0},...changes })

test('surface before manager load completion remains submitted without runtime readiness or input authority',async()=>{
  const first=offered('1',{transportBackend:'external-frame'}),returnLoad=deferred(),surfaceReported=deferred()
  let earlyState
  const h=harness({first,onConstruct:e=>{
    const load=e.session.load.bind(e.session)
    e.session.load=async options=>{
      const result=await load(options)
      e.hooks.onSurface({submission:gpuSubmission(e)})
      surfaceReported.resolve()
      await returnLoad.promise
      return result
    }
  },onState:state=>{
    if(state.executing?.submission&&!state.executing.runtimeReady)earlyState=state
  }})
  try {
    const ticket=h.manager.offer(offerValue(first))
    await surfaceReported.promise
    assert.equal(h.entries[0].session.status.runtimeReady,true,'the actual owner has completed load')
    assert.ok(earlyState,'the manager emitted the early surface state before awaiting load completion')
    assert.equal(earlyState.executing.runtimeReady,false);assert.equal(earlyState.executing.hasPresented,false)
    assert.equal(earlyState.executing.inputEnabled,false);assert.equal(earlyState.executing.submission.phase,'submitted')
    assert.equal(earlyState.executing.submission.value.status,'submitted');assert.equal(earlyState.executing.submission.proof,null)
    assert.equal(commands(h).includes('runtimeReady'),false);assert.equal(commands(h).includes('presentedReady'),false)
    returnLoad.resolve();await ticket.ready;await tick()
    assert.equal(h.manager.status.executing.runtimeReady,true);assert.equal(h.manager.status.executing.inputEnabled,false)
    assert.equal(h.manager.status.executing.submission.phase,'submitted');assert.equal(h.manager.status.executing.hasPresented,false)
    assert.deepEqual(h.manager.status.executing.submission.value.owner,h.entries[0].owner)
    assert.equal(h.errors.length,0)
  } finally { returnLoad.resolve();await h.manager.close() }
})

test('GPU submission is bounded diagnostics until the matching current proof is accepted, on every frame',async()=>{
  const first=offered('1',{transportBackend:'external-frame'}),h=harness({first})
  try {
    const ticket=h.manager.offer(offerValue(first)),ready=await ticket.ready;await tick();const e=h.entries[0]
    const raw=gpuSubmission(e);raw.secret='not retained';raw.context.driverHandle={secret:'not retained'}
    e.hooks.onSurface({submission:raw,canvas:{secret:'not retained'}})
    const submitted=h.manager.status.executing.submission
    assert.equal(submitted.phase,'submitted');assert.equal(submitted.proof,null)
    assert.equal(h.manager.status.executing.hasPresented,false);assert.equal(h.manager.status.executing.inputEnabled,false)
    assert.equal(Object.isFrozen(submitted.value.context),true);assert.equal(JSON.stringify(submitted).includes('not retained'),false)
    raw.context.renderer='mutated after callback';assert.equal(submitted.value.context.renderer,'contract renderer')
    await e.scheduler.accept()
    // This controlled adapter owns no canvas/input helper. Supply the manager
    // callback's input gate explicitly; this remains a contract double.
    e.hooks.onState({...e.session.status,inputEnabled:true});await tick()
    assert.equal(h.manager.status.executing.hasPresented,true)
    await ticket.presented
    let accepted=h.manager.status.executing.submission
    assert.equal(accepted.phase,'accepted');assert.deepEqual(accepted.proof,e.scheduler.status.accepted.proof)
    e.observation.sequence='2';e.observation.state.templateRevision='2';e.observation.state.viewRevision='2'
    await h.manager.request({ownerKey:ready.ownerKey,op:'api.call',payload:{}})
    assert.equal(h.manager.status.executing.submission.phase,'submitted','soft stale frame cannot claim current acceptance')
    e.hooks.onSurface({submission:gpuSubmission(e,{attemptId:'2',renderRevision:'6',frameId:5,presenterGeneration:2})})
    assert.equal(h.manager.status.executing.submission.phase,'submitted')
    await e.scheduler.accept(true,{attemptId:'2',publication:{kind:'external-frame',renderRevision:'6'}})
    e.hooks.onState({...e.session.status,inputEnabled:true})
    accepted=h.manager.status.executing.submission
    assert.equal(accepted.phase,'accepted');assert.equal(accepted.proof.consumedInput.templateRevision,'2')
    assert.equal(accepted.proof.attemptId,'2');assert.equal(accepted.proof.publication.renderRevision,'6')
    assert.equal(h.manager.status.history.filter(value=>value.kind==='accepted-proof').length,1,'initial coordinator receipt is not repeated per frame')
    e.hooks.onSurface({submission:gpuSubmission(e)})
    assert.equal(h.manager.status.executing.submission.value.attemptId,'2','late previous attempt is ignored')
    e.scheduler.suspend();assert.equal(h.manager.status.executing.submission.phase,'submitted')
  } finally { await h.manager.close() }
})

test('GPU metadata cannot claim another owner, page surface or viewport and retired callbacks cannot replace it',async()=>{
  const first=offered('1',{transportBackend:'external-frame'}),h=harness({first})
  try {
    await h.manager.offer(offerValue(first)).ready;await tick();const old=h.entries[0]
    for(const changes of [{owner:{...old.owner,sessionId:'unrelated'}},{surfaceGeneration:'2'},{viewport:rect(414,736)}]) {
      old.hooks.onSurface({submission:gpuSubmission(old,changes)});assert.equal(h.manager.status.executing.submission,null)
    }
    const next=offered('2',{transportBackend:'external-frame'})
    await h.manager.offer(h.publish(next)).ready;await tick();const e=h.entries[1]
    e.hooks.onSurface({submission:gpuSubmission(e)});old.hooks.onSurface({submission:gpuSubmission(old)})
    assert.deepEqual(h.manager.status.executing.submission.value.owner,e.owner);assert.equal(h.errors.length,0)
  } finally { await h.manager.close() }
})

test('invalid GPU receipts fail closed before they become status or input authority',async()=>{
  for(const change of [{context:{api:'webgl2'}},{presentation:{pictureSubmissions:1,flushes:1,gpuCompletion:'complete',glError:0}},
    {runtimeBoundary:{frameBatches:1,perNodeRuntimeCalls:1,softwareRgbaUploads:0}}, {physicalSize:{width:4097,height:1}},
    {context:{...gpuSubmission({owner:{}}).context,renderer:'🧪'.repeat(129)}}]) {
    const first=offered('1',{transportBackend:'external-frame'}),h=harness({first})
    try {
      await h.manager.offer(offerValue(first)).ready;await tick();const e=h.entries[0]
      e.hooks.onSurface({submission:gpuSubmission(e,change)})
      assert.equal(h.manager.status.executing.submission,null);assert.equal(h.manager.status.executing.inputEnabled,false)
      assert.ok(h.errors.some(value=>value.error.code==='ERR_PROTOCOL_VERSION'))
    } finally { await h.manager.close() }
  }
})

test('recoverable local surface state downgrades old submission without failing or replacing its Worker owner',async()=>{
  const first=offered('1',{transportBackend:'external-frame'}),h=harness({first})
  try {
    await h.manager.offer(offerValue(first)).ready;await tick();const e=h.entries[0]
    e.hooks.onSurface({submission:gpuSubmission(e)});await e.scheduler.accept()
    e.hooks.onState({...e.session.status,inputEnabled:true});await tick()
    assert.equal(h.manager.status.executing.submission.phase,'accepted')
    const ownerKey=h.manager.status.executing.ownerKey, recovery={version:'1.0',lossId:'1',phase:'blocked',surfaceGeneration:null,extra:'not retained'}
    e.hooks.onState({...e.session.status,inputEnabled:true,surfaceRecovery:recovery})
    const blocked=h.manager.status.executing
    assert.equal(blocked.inputEnabled,false);assert.equal(blocked.runtimeReady,true)
    assert.equal(blocked.submission.phase,'submitted');assert.equal(blocked.hasPresented,true)
    assert.deepEqual(blocked.surfaceRecovery,{version:'1.0',lossId:'1',phase:'blocked',surfaceGeneration:null})
    assert.equal(blocked.ownerKey,ownerKey);assert.equal(h.workers,1);assert.equal(e.raw.closes,0)
    assert.equal(commands(h).includes('failOwner'),false);assert.equal(h.errors.length,0)
    recovery.phase='mutated';assert.equal(blocked.surfaceRecovery.phase,'blocked')
    e.observation.sequence='2';e.observation.state.surfaceGeneration='2';e.observation.state.inputLifetimeRevision='2'
    e.observation.state.renderRevision='6'
    const proof={...e.scheduler.status.accepted.proof,surfaceGeneration:'2',attemptId:'2',publication:{kind:'external-frame',renderRevision:'6'}}
    e.scheduler.status={phase:'presented',accepted:{hardKey:'new-actual',inputEnabled:true,proof}}
    e.hooks.onState({...e.session.status,inputEnabled:true,observation:clone(e.observation),surfaceRecovery:{version:'1.0',lossId:'1',phase:'awaiting-presentation',surfaceGeneration:'2'}})
    e.hooks.onSurface({submission:gpuSubmission(e,{surfaceGeneration:'2',attemptId:'2',renderRevision:'6'})})
    assert.equal(h.manager.status.executing.inputEnabled,false)
    e.hooks.onState({...e.session.status,inputEnabled:true,observation:clone(e.observation),surfaceRecovery:null})
    assert.equal(h.manager.status.executing.inputEnabled,true)
    assert.equal(h.manager.status.executing.submission.phase,'accepted')
    assert.equal(h.workers,1)
  } finally { await h.manager.close() }
})

test('surface retry is pinned to the exact live owner and loss, coalesces clicks and never grants input',async()=>{
  const first=offered('1',{transportBackend:'external-frame'}),h=harness({first}),held=deferred()
  try {
    await h.manager.offer(offerValue(first)).ready;await tick();const e=h.entries[0]
    const intent={ownerKey:h.manager.status.executing.ownerKey,lossId:'1'}
    e.hooks.onState({...e.session.status,surfaceRecovery:{version:'1.0',lossId:'1',phase:'blocked',surfaceGeneration:null}})
    let calls=0;e.session.retrySurfaceRecovery=()=>{calls++;return held.promise}
    await assert.rejects(h.manager.retrySurfaceRecovery({...intent,lossId:'2'}),{code:'ERR_CANCELLED'})
    await assert.rejects(h.manager.retrySurfaceRecovery({...intent,ownerKey:{}}),{code:'ERR_CANCELLED'})
    const pending=h.manager.retrySurfaceRecovery(intent)
    assert.equal(pending,h.manager.retrySurfaceRecovery(clone(intent)))
    await tick();assert.equal(calls,1)
    assert.ok(h.manager.status.pendingOperations.some(value=>value.phase==='surface-recovery-retry'))
    assert.equal(h.manager.status.executing.inputEnabled,false)
    held.resolve({recovered:true})
    const result=await pending
    assert.equal(result.stale,false);assert.deepEqual(result.ownerKey,intent.ownerKey);assert.equal(result.lossId,'1')
    assert.equal(h.manager.status.executing.inputEnabled,false,'native retry result is not an accepted GPU presentation')
    assert.equal(h.workers,1);assert.equal(e.raw.closes,0);assert.equal(commands(h).includes('failOwner'),false)
    e.hooks.onState({...e.session.status,surfaceRecovery:{version:'1.0',lossId:'2',phase:'blocked',surfaceGeneration:null}})
    await assert.rejects(h.manager.retrySurfaceRecovery(intent),{code:'ERR_CANCELLED'})
    assert.equal(calls,1)
  } finally {held.resolve();await h.manager.close()}
})

test('close fences a queued surface retry before it can enter the old session',async()=>{
  const first=offered('1',{transportBackend:'external-frame'}),h=harness({first})
  await h.manager.offer(offerValue(first)).ready;await tick();const e=h.entries[0]
  e.hooks.onState({...e.session.status,surfaceRecovery:{version:'1.0',lossId:'1',phase:'blocked',surfaceGeneration:null}})
  let calls=0;e.session.retrySurfaceRecovery=async()=>{calls++}
  const pending=h.manager.retrySurfaceRecovery({ownerKey:h.manager.status.executing.ownerKey,lossId:'1'})
  const closing=h.manager.close()
  await assert.rejects(pending,{code:'ERR_CANCELLED'});await closing;assert.equal(calls,0)
})

test('close waits for an admitted actual surface retry without claiming that its result is presentation',async()=>{
  const first=offered('1',{transportBackend:'external-frame'}),h=harness({first}),held=deferred()
  await h.manager.offer(offerValue(first)).ready;await tick();const e=h.entries[0]
  e.hooks.onState({...e.session.status,surfaceRecovery:{version:'1.0',lossId:'1',phase:'blocked',surfaceGeneration:null}})
  let entered=false;e.session.retrySurfaceRecovery=()=>{entered=true;return held.promise}
  const pending=h.manager.retrySurfaceRecovery({ownerKey:h.manager.status.executing.ownerKey,lossId:'1'})
  await tick();assert.equal(entered,true)
  let finished=false;const closing=h.manager.close().then(value=>{finished=true;return value})
  await tick();assert.equal(finished,false)
  held.resolve({recovered:true});assert.equal((await pending).stale,true)
  assert.equal((await closing).closed,true)
})
