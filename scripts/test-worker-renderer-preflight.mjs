/** Resource lifecycle contracts.
 * Uses the actual admission loader with finite fake streams, fake SHA pins,
 * fake drawing initializer/typeface and owned fake Blob URLs. Does not execute
 * real CanvasKit/WASM/font code, Worker, owner runtime, DOM, server or GPU. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createWorkerAdmissionLoader, WORKER_RENDERER_PINS, WORKER_RENDERER_LEASE_LIMITS }
  from '../examples/hosts/web-wasm/worker-admission-loader.mjs'

const BASE='http://127.0.0.1:58730/'
const bytes=value=>new TextEncoder().encode(JSON.stringify(value))
const sha256=value=>createHash('sha256').update(value).digest('hex')
const error=message=>Object.assign(new Error(message),{code:'ERR_RENDER'})
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});void promise.catch(()=>{});return {promise,resolve,reject}}
const tick=async()=>{for(let i=0;i<100;i++)await Promise.resolve()}
const until=async predicate=>{for(let i=0;i<3000&&!predicate();i++)await Promise.resolve();assert.ok(predicate(),'controlled boundary not reached')}
const outcome=promise=>promise.then(value=>({value}),error=>({error}))
const owner=Object.freeze({workerEpoch:'preflight-epoch',sessionId:'preflight-session',packSha256:'a'.repeat(64),transportBackend:'external-frame'})
const loadResult=Object.freeze({transportBackend:'external-frame',pack:{indexSha256:owner.packSha256},
 state:{sessionId:owner.sessionId,transportBackend:'external-frame'},
 externalPresentation:{version:'1.0',consumedInput:'1.0',ackOutcome:'1.0',physicalTarget:'1.0'}})
function rendererConfig(prefix='/vendor') {
 const resource=key=>({...WORKER_RENDERER_PINS[key],url:`${prefix}/${key}`})
 return {schemaVersion:1,renderer:'canvaskit',fallback:'error',canvaskit:{version:'0.42.0',variant:'full',
 javascript:resource('javascript'),wasm:resource('wasm'),license:resource('license'),package:resource('package')},
 font:{binary:resource('font'),license:resource('fontLicense')}}
}
// Realistic lengths, zero-filled nonexecutable resources; this fake digest maps
// lengths to pins. This is not evidence that pinned real bytes are valid.
let resources
function fakeResources() {
 if(!resources){resources=new Map(Object.entries(WORKER_RENDERER_PINS).map(([key,pin])=>[key,new Uint8Array(pin.size)]));
 resources.get('package').fill(32);resources.get('package').set(bytes({name:'canvaskit-wasm',version:'0.42.0'}))}
 return resources
}
function environment(hooks={}) {
 const activity={fetches:[],imports:0,initializes:0,decodes:0,deletes:0,created:[],revoked:[],initSignals:[],module:null}
 activity.module={fakeOnly:true,Typeface:{MakeTypefaceFromData(value){
  activity.decodes++;assert.equal(value.byteLength,WORKER_RENDERER_PINS.font.size)
  return hooks.typeface?hooks.typeface(value,activity):{delete(){activity.deletes++}}
 }}}
 const loader=createWorkerAdmissionLoader({baseUrl:BASE,
  rendererLeaseLimits:{...WORKER_RENDERER_LEASE_LIMITS,...hooks.limits},
  sha256:async value=>hooks.sha256?.(value)??Object.values(WORKER_RENDERER_PINS).find(pin=>pin.size===value.length)?.sha256??sha256(value),
  fetch:async(url,init)=>{activity.fetches.push(url);activity.initSignals.push(init.signal)
   const key=new URL(url).pathname.split('/').at(-1),value=fakeResources().get(key);assert.ok(value)
   return hooks.fetch?.(url,init,key,value,activity)??new Response(value,{headers:{'content-length':String(value.length)}})},
  makeBlob:(parts,options)=>({parts,type:options.type}),
  createObjectURL:value=>{const url=`blob:preflight-fake/${activity.created.length+1}`;activity.created.push({url,value});return url},
  revokeObjectURL:async url=>{activity.revoked.push(url);await hooks.revoke?.(url,activity)},
  importModule:async url=>{activity.imports++
   if(hooks.importModule)return hooks.importModule(url,activity)
   return {default:async options=>{activity.initializes++
    assert.equal(options.locateFile('canvaskit.wasm'),activity.created.at(-1).url)
    assert.throws(()=>options.locateFile('unverified.wasm'),{code:'ERR_RENDER'})
    return hooks.initialize?hooks.initialize(options,activity):activity.module}}
  }})
 const prepare=options=>loader.preparePinnedRendererAssets({rendererAssets:rendererConfig(),...options})
 const load=options=>loader.loadPinnedCanvasKit({owner,loadResult,rendererAssets:rendererConfig(),...options})
 return {loader,prepare,load,activity}
}

test('opaque owner-free preflight verifies six resources then initializer and font lifetime, never claims GPU',async()=>{
 const e=environment(),lease=await e.prepare()
 assert.equal(e.activity.fetches.length,6);assert.equal(e.activity.imports,1);assert.equal(e.activity.initializes,1)
 assert.equal(e.activity.decodes,1);assert.equal(e.activity.deletes,1)
 assert.deepEqual(Object.keys(lease).sort(),['dispose','disposed','kind','provenance','scope','version'])
 assert.equal(lease.CanvasKit,undefined);assert.equal(lease.fontData,undefined)
 assert.equal(lease.provenance.staticFontDecoded,true);assert.equal(lease.provenance.gpuSurfaceValidated,false)
 assert.equal(e.activity.created[0].value.parts[1],'\nexport default CanvasKitInit;\n','verified script suffix must contain actual newlines')
 assert.deepEqual(e.activity.revoked,e.activity.created.map(value=>value.url))
 const status=e.loader.rendererResourceStatus();assert.equal(status.ownerLeases,0);assert.equal(status.staticLeases,1)
 assert.equal(status.moduleDisposal,'not-supported');assert.equal(status.cachedModuleRetained,true);assert.equal(status.gpuSurfaceValidated,false)
 const disposal=lease.dispose();assert.equal(lease.dispose(),disposal);await disposal
 assert.equal(e.loader.rendererResourceStatus().staticLeases,0)
 assert.equal(e.loader.rendererResourceStatus().cachedModuleRetained,true)
})

test('pin or URL admission failure precedes renderer fetch, import, and owner creation',async()=>{
 const e=environment()
 for(const mutate of [c=>{c.canvaskit.version='0.43.0'},c=>{c.font.binary.sha256='b'.repeat(64)},c=>{c.font.binary.url='/api/font'}]) {
  const rendererAssets=rendererConfig();mutate(rendererAssets);await assert.rejects(e.prepare({rendererAssets}))
 }
 assert.equal(e.activity.fetches.length,0);assert.equal(e.activity.imports,0)
 assert.equal(e.loader.rendererResourceStatus().initializations,0)
})

test('static font decode failure rejects preparation without claiming font or GPU readiness',async()=>{
 const e=environment({typeface:()=>null});await assert.rejects(e.prepare(),/could not be decoded/)
 const status=e.loader.rendererResourceStatus();assert.equal(status.staticLeases,0);assert.equal(status.ownerLeases,0)
 assert.equal(status.cachedModuleRetained,false);assert.equal(status.gpuSurfaceValidated,false)
 assert.equal(e.activity.deletes,0);assert.deepEqual(e.activity.revoked,e.activity.created.map(value=>value.url))
})

test('temporary font delete failure is sticky cleanup uncertainty and never reinitializes',async()=>{
 const e=environment({typeface:(_value,a)=>({delete(){a.deletes++;throw error('font handle delete failed')}})})
 await assert.rejects(e.prepare(),failure=>failure.code==='ERR_RENDER'&&failure.details.cleanupErrors.some(value=>value.includes('font handle delete failed')))
 assert.equal(e.activity.deletes,1);assert.ok(e.loader.rendererResourceStatus().cleanupFault)
 await assert.rejects(e.prepare(),/temporary typeface cleanup/);assert.equal(e.activity.imports,1)
 assert.equal(e.loader.rendererResourceStatus().staticLeases,0)
})

test('missing temporary font destructor refuses publication and remains cleanup uncertainty',async()=>{
 const e=environment({typeface:()=>({unownedFakeHandle:true})})
 await assert.rejects(e.prepare(),/cannot be released/);assert.ok(e.loader.rendererResourceStatus().cleanupFault)
 await assert.rejects(e.prepare());assert.equal(e.activity.imports,1)
})

test('owner validation still happens before implicit resource preparation or prepared borrow',async()=>{
 const e=environment();await assert.rejects(e.load({owner:{...owner,sessionId:'different'}}),{code:'ERR_PROTOCOL_VERSION'})
 assert.equal(e.activity.fetches.length,0)
 const prepared=await e.prepare();await assert.rejects(e.load({preparedRendererAssets:prepared,loadResult:{...loadResult,transportBackend:'browser-view'}}),{code:'ERR_PROTOCOL_VERSION'})
 assert.equal(e.loader.rendererResourceStatus().ownerLeases,0);await prepared.dispose()
})

test('original owner path without prepared assets remains compatible and releases its implicit static lease',async()=>{
 const e=environment(),first=await e.load(),second=await e.load()
 assert.equal(first.CanvasKit,second.CanvasKit);assert.notEqual(first.fontData,second.fontData)
 assert.equal(e.activity.initializes,1);assert.equal(e.activity.decodes,1)
 assert.equal(e.loader.rendererResourceStatus().staticLeases,0);assert.equal(e.loader.rendererResourceStatus().ownerLeases,2)
 await first.dispose();await second.dispose();assert.equal(e.loader.rendererResourceStatus().ownerFontBytes,0)
})

test('only an exact same-loader live static lease can be borrowed',async()=>{
 const e=environment(),foreign=environment(),prepared=await e.prepare(),foreignPrepared=await foreign.prepare()
 for(const candidate of [{},Object.freeze({...prepared}),foreignPrepared])
  await assert.rejects(e.load({preparedRendererAssets:candidate}),/live exact-config lease/)
 await assert.rejects(e.load({preparedRendererAssets:prepared,rendererAssets:rendererConfig('/other-vendor')}),/live exact-config lease/)
 await prepared.dispose();await assert.rejects(e.load({preparedRendererAssets:prepared}),/live exact-config lease/)
 assert.equal(e.loader.rendererResourceStatus().ownerLeases,0);await foreignPrepared.dispose()
})

test('retained shared module rejects rebranding under another resource URL configuration',async()=>{
 const e=environment(),prepared=await e.prepare(),live=await e.load({preparedRendererAssets:prepared})
 const retained=live.CanvasKit
 await assert.rejects(e.prepare({rendererAssets:rendererConfig('/other-vendor')}),/different exact resource configuration/)
 assert.equal(e.activity.fetches.length,6);assert.equal(e.activity.imports,1)
 assert.equal(live.CanvasKit,retained);assert.equal(live.fontData.byteLength,WORKER_RENDERER_PINS.font.size)
 assert.equal(e.loader.rendererResourceStatus().staticLeases,1);await prepared.dispose();await live.dispose()
})

test('static release and cancellation preserve independent borrowed owner font copies',async()=>{
 const e=environment(),controller=new AbortController(),prepared=await e.prepare({signal:controller.signal})
 const first=await e.load({preparedRendererAssets:prepared}),second=await e.load({preparedRendererAssets:prepared})
 const module=first.CanvasKit;new Uint8Array(first.fontData)[0]=83
 assert.equal(new Uint8Array(second.fontData)[0],0)
 controller.abort('static preflight retired');await tick();assert.equal(prepared.disposed,true)
 assert.equal(first.CanvasKit,module);assert.equal(second.CanvasKit,module);assert.equal(e.loader.rendererResourceStatus().ownerLeases,2)
 const stable=first.dispose();assert.equal(first.dispose(),stable);await stable
 assert.throws(()=>first.fontData,{code:'ERR_CANCELLED'});assert.equal(second.CanvasKit,module)
 await second.dispose();assert.equal(e.loader.rendererResourceStatus().ownerFontBytes,0)
})

test('one aborted preparation waits for shared initialization while the live waiter still publishes',async()=>{
 const begun=deferred(),done=deferred(),controller=new AbortController()
 const e=environment({initialize:(_options,a)=>{begun.resolve();return done.promise}})
 let cancelledSettled=false
 const cancelled=outcome(e.prepare({signal:controller.signal})).then(result=>{cancelledSettled=true;return result}),live=e.prepare()
 await begun.promise;controller.abort('one consumer cancelled');await tick()
 assert.equal(cancelledSettled,false);assert.equal(e.activity.initSignals[0].aborted,false)
 assert.equal(e.loader.rendererResourceStatus().preparationWaiters,2)
 done.resolve(e.activity.module);assert.equal((await cancelled).error.code,'ERR_CANCELLED')
 const prepared=await live;assert.equal(e.activity.initializes,1);assert.equal(e.activity.decodes,1)
 assert.equal(e.loader.rendererResourceStatus().preparationWaiters,0);await prepared.dispose()
})

test('last cancellation awaits actual initializer and cleanup; late preparation cannot overlap',async()=>{
 const begun=deferred(),initialized=deferred(),cleanupBegun=deferred(),cleanupDone=deferred(),controller=new AbortController()
 const e=environment({initialize:()=>{begun.resolve();return initialized.promise},revoke:async(url)=>{if(url.endsWith('/1')){cleanupBegun.resolve();await cleanupDone.promise}}})
 let oldSettled=false,newSettled=false
 const old=outcome(e.prepare({signal:controller.signal})).then(result=>{oldSettled=true;return result})
 await begun.promise;controller.abort('last cancelled');const next=outcome(e.prepare()).then(result=>{newSettled=true;return result})
 await tick();assert.equal(oldSettled,false);assert.equal(newSettled,false);assert.equal(e.activity.imports,1)
 assert.equal(e.activity.initSignals[0].aborted,true)
 initialized.resolve(e.activity.module);await cleanupBegun.promise;await tick()
 assert.equal(oldSettled,false);assert.equal(newSettled,false);assert.equal(e.activity.imports,1)
 cleanupDone.resolve();assert.equal((await old).error.code,'ERR_CANCELLED')
 // New initialization sees the already-resolved controlled initializer, only
 // after the old actual cleanup barrier. No resource/module overlap claimed.
 const prepared=(await next).value;assert.ok(prepared);assert.equal(e.activity.imports,2)
 await prepared.dispose()
})

test('pending waiter and static lease limits reserve capacity until actual settlement',async()=>{
 const begun=deferred(),done=deferred(),controller=new AbortController()
 const e=environment({limits:{preparationWaiters:1,staticLeases:1},initialize:()=>{begun.resolve();return done.promise}})
 const pending=outcome(e.prepare({signal:controller.signal}));await begun.promise;controller.abort('cancel')
 await assert.rejects(e.prepare(),/capacity exhausted/);assert.equal(e.loader.rendererResourceStatus().preparationWaiters,1)
 done.resolve(e.activity.module);assert.equal((await pending).error.code,'ERR_CANCELLED')
 const prepared=await e.prepare();await assert.rejects(e.prepare(),/capacity exhausted/)
 assert.equal(e.loader.rendererResourceStatus().staticLeases,1);await prepared.dispose()
 const again=await e.prepare();await again.dispose()
})

test('owner lease count and copied-font byte capacity are explicit and released independently',async()=>{
 const e=environment({limits:{ownerLeases:2,ownerFontBytes:WORKER_RENDERER_PINS.font.size}}),prepared=await e.prepare()
 const first=await e.load({preparedRendererAssets:prepared});assert.equal(e.loader.rendererResourceStatus().ownerFontBytes,WORKER_RENDERER_PINS.font.size)
 await assert.rejects(e.load({preparedRendererAssets:prepared}),/owner renderer\/font lease capacity/)
 assert.equal(e.loader.rendererResourceStatus().ownerLeases,1);await first.dispose()
 const second=await e.load({preparedRendererAssets:prepared});await prepared.dispose();await second.dispose()
 assert.equal(e.loader.rendererResourceStatus().ownerLeases,0);assert.equal(e.loader.rendererResourceStatus().ownerFontBytes,0)
 const count=environment({limits:{ownerLeases:1}}),s=await count.prepare(),o=await count.load({preparedRendererAssets:s})
 await assert.rejects(count.load({preparedRendererAssets:s}),/capacity/);await o.dispose();await s.dispose()
})

test('non-cleanup initialization failure has a finite lifetime retry budget',async()=>{
 const e=environment({limits:{initializations:2},importModule:async()=>{throw error('controlled import failure')}})
 await assert.rejects(e.prepare(),/controlled import failure/);await assert.rejects(e.prepare(),/controlled import failure/)
 await assert.rejects(e.prepare(),/lifetime budget exhausted/)
 assert.equal(e.activity.imports,2);assert.equal(e.loader.rendererResourceStatus().initializations,2)
 assert.equal(e.loader.rendererResourceStatus().cleanupFault,null)
})

test('Blob URL cleanup failure blocks publication and future preparation with no fake destructor retry',async()=>{
 const e=environment({revoke:async url=>{if(url.endsWith('/1'))throw error('controlled URL cleanup failure')}})
 await assert.rejects(e.prepare(),failure=>failure.details.cleanupErrors.some(value=>value.includes('controlled URL cleanup failure')))
 assert.equal(e.activity.deletes,1);assert.equal(e.activity.revoked.length,2)
 await assert.rejects(e.prepare());assert.equal(e.activity.imports,1)
 assert.equal(e.loader.rendererResourceStatus().staticLeases,0);assert.ok(e.loader.rendererResourceStatus().cleanupFault)
})

test('cancellation or signal listener failure before returning a static lease cannot leak its capacity',async()=>{
 const e=environment();let adds=0
 const signal={aborted:false,addEventListener(){if(++adds===2)throw error('controlled listener failure')},removeEventListener(){}}
 await assert.rejects(e.prepare({signal}),/controlled listener failure/)
 assert.equal(e.loader.rendererResourceStatus().staticLeases,0);assert.equal(e.loader.rendererResourceStatus().preparationWaiters,0)
 const ready=await e.prepare();await ready.dispose()
})


test('throwing waiter-listener removal cannot leak reservations or an unpublished static lease',async()=>{
 const e=environment()
 const signal={aborted:false,addEventListener(){},removeEventListener(){throw error('waiter listener removal failed')}}
 await assert.rejects(e.prepare({signal}),failure=>failure.code==='ERR_RENDER'&&failure.details.cleanupErrors.some(value=>value.includes('listener removal failed')))
 const status=e.loader.rendererResourceStatus();assert.equal(status.preparationWaiters,0);assert.equal(status.staticLeases,0)
 assert.equal(status.ownerLeases,0);assert.ok(status.cleanupFault)
 await assert.rejects(e.prepare());assert.equal(e.activity.imports,1)
})

test('static listener cleanup uses a reentrant stable barrier and releases accounting despite removal failure',async()=>{
 const e=environment();let removals=0,lease,nested,failStatic=false
 const signal={aborted:false,addEventListener(){},removeEventListener(){
  removals++;if(failStatic){nested=lease.dispose();throw error('static listener removal failed')}
 }}
 lease=await e.prepare({signal});assert.equal(removals,1)
 const live=await e.load({preparedRendererAssets:lease}),module=live.CanvasKit;failStatic=true
 const disposal=lease.dispose();assert.equal(nested,disposal);assert.equal(lease.dispose(),disposal)
 await assert.rejects(disposal,/cleanup failed/)
 const status=e.loader.rendererResourceStatus();assert.equal(status.staticLeases,0);assert.equal(status.ownerLeases,1);assert.ok(status.cleanupFault)
 assert.equal(live.CanvasKit,module);assert.equal(live.fontData.byteLength,WORKER_RENDERER_PINS.font.size)
 await live.dispose();assert.equal(e.loader.rendererResourceStatus().ownerFontBytes,0)
})
