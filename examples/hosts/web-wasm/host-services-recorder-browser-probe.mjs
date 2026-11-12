// Real native AudioWorklet / PCM / OPFS / QuickJS and Worker transport.
// The source is an explicit oscillator stream, never a physical microphone.
import initializeWasm, { WebWasmHost } from './pkg/container_host_web.js'
import { BrowserHostServices } from './browser-host-services.mjs'
import { WorkerHostServicesTransport } from './worker-host-services.mjs'
import { WorkerRpcClient } from './worker-session-client.mjs'
import { BrowserWavRecorder } from './browser-wav-recorder.mjs'
const check=(value,message)=>{if(!value)throw new Error(message)}
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true})
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`:JSON.stringify(value)
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('')
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function fetchBytes(url){const response=await fetch(url,{credentials:'omit',redirect:'error'});check(response.ok,'recorder fixture HTTP failed');return new Uint8Array(await response.arrayBuffer())}
async function fixture(indexUrl){
  const location=new URL(indexUrl,globalThis.location.href),indexBytes=await fetchBytes(location),index=JSON.parse(decoder.decode(indexBytes)),manifestBytes=await fetchBytes(new URL(index.manifest,location)),manifest=JSON.parse(decoder.decode(manifestBytes))
  check(await hash(manifestBytes)===index.manifestSha256&&manifest.integrity.root===index.integrityRoot&&await hash(encoder.encode(canonical({...manifest,integrity:{...manifest.integrity,root:''}})))===index.integrityRoot,'recorder fixture integrity mismatch')
  const blobs={};for(const entry of index.blobs){const bytes=await fetchBytes(new URL(entry.url,location));check(bytes.length===entry.size&&await hash(bytes)===entry.sha256,'recorder fixture blob mismatch');blobs[`sha256:${entry.sha256}`]=[...bytes]}
  const entry=manifest.modules.find(value=>value.id.replace(/^module:/,'')===manifest.app.entryModule.replace(/^module:/,''));check(decoder.decode(new Uint8Array(blobs[`sha256:${entry.sha256}`])).includes('exports.__hostRecorderCreate'),'generate the explicit recorder fixture first')
  return {location,index,indexBytes,manifest,blobs,entry,modules:manifest.modules.map(value=>({id:value.id,bytes:blobs[`sha256:${value.sha256}`]}))}
}

export async function runHostServicesRecorderBrowserProbe({catalog,indexUrl='./recorder-probe/pack-index.json',workerUrl='./runtime-worker.mjs',worker=true}={}) {
  check(catalog?.baseline?.baseLibrary==='3.17.3'&&isSecureContext&&navigator.storage?.getDirectory&&typeof AudioContext==='function'&&typeof AudioWorkletNode==='function','real secure-context Web Audio and OPFS are required')
  const pack=await fixture(indexUrl);await initializeWasm()
  const report={classification:'synthetic-oscillator-real-worklet-pcm-opfs-quickjs-wasm',physicalMicrophone:'not-run',physicalAudioOutput:'not-run',fixtureRoot:pack.index.integrityRoot,checks:{},cleanup:[]},contexts=[],streams=[],listeners=[],folders=[]
  let source,oscillator,gain,destination,host,services,client,boundaryEnvironment,request=0
  const envelope=(sessionId,op,payload)=>({protocolVersion:'1.0',sessionId,requestId:`recorder-${++request}`,kind:'request',op,payload})
  const ok=batch=>{const response=batch.messages.find(message=>message.kind==='response');check(response?.payload?.ok===true,JSON.stringify(batch));return response.payload}
  const until=async(predicate,read,label,allowError=false)=>{const end=performance.now()+15000;for(;;){await services.drain();const value=await read();const error=value?.log?.find(row=>row[0]==='Error'||String(row[0]).endsWith('-rejected'));check(allowError||!error,label+' failed: '+JSON.stringify(error));if(predicate(value))return value;check(performance.now()<end,label+' timed out '+JSON.stringify(value));await delay(15)}}
  const pumpFor=async(ms,read)=>{const end=performance.now()+ms;do{await services.drain();await read();await delay(15)}while(performance.now()<end)}
  const sessionKey=crypto.randomUUID()
  try {
    source=new AudioContext({sampleRate:48000});destination=source.createMediaStreamDestination();oscillator=source.createOscillator();gain=source.createGain();oscillator.frequency.value=440;gain.gain.value=.1;oscillator.connect(gain);gain.connect(destination);oscillator.start();await source.resume();check(source.state==='running','synthetic native source did not run')
    for(const mode of worker?['direct','worker']:['direct']){
      const observed={contexts:[],streams:[],nodes:[],constraints:[],pcmBytes:0,stops:[]},application={hostAppId:'recorder-probe',tenantId:'probe',publisherId:'explicit-fixture',appId:`recorder-${mode}-${sessionKey}`,environment:'trial',version:'probe',packRoot:pack.index.integrityRoot},account={principalId:'synthetic',epoch:'9007199254740993'}
      folders.push('weapp-'+await hash(encoder.encode(JSON.stringify([application.hostAppId,application.tenantId,application.publisherId,application.appId,application.environment,account.principalId]))))
      function RecordingContext(options){const value=new AudioContext(options);observed.contexts.push(value);contexts.push(value);return value}RecordingContext.prototype=AudioContext.prototype
      function RecordingWorklet(context,name,options){const value=new AudioWorkletNode(context,name,options),listener=event=>{if(event.data?.kind==='pcm')observed.pcmBytes+=event.data.buffer.byteLength;if(event.data?.kind==='stop')observed.stops.push({frames:event.data.frames,bytes:event.data.bytes})};value.port.addEventListener('message',listener);listeners.push({port:value.port,listener});observed.nodes.push(value);return value}RecordingWorklet.prototype=AudioWorkletNode.prototype
      const environment={document,window,location,isSecureContext,AudioContext:RecordingContext,AudioWorkletNode:RecordingWorklet,MediaRecorder,Blob,setTimeout:globalThis.setTimeout.bind(globalThis),clearTimeout:globalThis.clearTimeout.bind(globalThis),navigator:{storage:navigator.storage,mediaDevices:{async getUserMedia(constraints){observed.constraints.push(constraints);const stream=destination.stream.clone();observed.streams.push(stream);streams.push(stream);return stream}}}}
      boundaryEnvironment=environment
      let runtime,call,read
      if(mode==='direct'){
        host=new WebWasmHost();host.load_manifest_json_with_config(canonical(pack.manifest),JSON.stringify({session_id:'recorder-direct',engine:'quickjs',require_integrity:true,renderer_mode:'external-frame'}));runtime=host
        services=new BrowserHostServices({runtime,catalog,environment});await services.configure({application,account});const initialized=ok(JSON.parse(host.dispatch_json(JSON.stringify(envelope('recorder-direct','app.init',{blobs:pack.blobs,modules:pack.modules,launchOptions:{}})))));check(initialized.engineProviderAvailable===true,'real QuickJS missing')
        call=async(name,args=[])=>ok(JSON.parse(host.dispatch_json(JSON.stringify(envelope('recorder-direct','module.call',{moduleId:pack.entry.id,export:name,args}))))).result[0]
      }else{
        client=new WorkerRpcClient({workerUrl,timeoutMs:30000,closeTimeoutMs:5000});runtime=new WorkerHostServicesTransport({nativeHostServices:(op,payload={})=>client.requestHost(op,payload),revokeHostIdentity:()=>client.requestHost('native.revoke',{})})
        services=new BrowserHostServices({runtime,catalog,environment});await services.configure({application,account});const loaded=await client.requestHost('load',{indexUrl:pack.location.href,indexSha256:await hash(pack.indexBytes),indexSize:pack.indexBytes.length,renderer:'external-frame',engine:'quickjs',viewport:{width:375,height:667},hostServices:runtime.configuration,loadTimeoutMs:30000});runtime.activate(loaded)
        call=async(name,args=[])=>ok(await client.requestHost('bridge',{envelope:envelope(client.sessionId,'module.call',{moduleId:pack.entry.id,export:name,args})})).result[0]
      }
      const formats=services.capabilities().recordingFormats
      read=()=>call('__hostRecorderRead');check(services.files.persistent===true&&formats.includes('wav'),'real WAV/private files not negotiated')
      await call('__hostRecorderCreate');await services.drain();await delay(20);await services.drain();await call('__hostRecorderStart');await until(value=>value.log.some(row=>row[0]==='start-resolved'),read,mode+' native start')
      check(observed.nodes.length===1&&observed.contexts[0].sampleRate===8000,'actual 8kHz AudioWorklet graph missing');await pumpFor(160,read);await call('__hostRecorderPause');await until(value=>value.log.some(row=>row[0]==='pause-resolved'),read,mode+' native pause')
      const pausedBytes=observed.pcmBytes;await pumpFor(180,read);check(observed.pcmBytes===pausedBytes,'native worklet captured PCM during pause')
      await call('__hostRecorderResume');await until(value=>value.log.some(row=>row[0]==='resume-resolved'),read,mode+' native resume');await pumpFor(160,read);await call('__hostRecorderStop');let state=await until(value=>value.log.some(row=>row[0]==='Stop')&&value.log.some(row=>row[0]==='stop-resolved'),read,mode+' private complete file')
      const stop=state.log.find(row=>row[0]==='Stop')[1],file=await services.files.read(stop.tempFilePath);check(file instanceof File,'recording was not persisted as an OPFS File');const buffer=await file.arrayBuffer(),view=new DataView(buffer),frames=view.getUint32(40,true)/4
      check(decoder.decode(buffer.slice(0,4))==='RIFF'&&decoder.decode(buffer.slice(8,16))==='WAVEfmt '&&view.getUint16(20,true)===1&&view.getUint16(22,true)===2&&view.getUint32(24,true)===8000&&view.getUint16(34,true)===16&&view.getUint32(40,true)===buffer.byteLength-44,'actual private WAV header invalid')
      check(frames>0&&stop.duration===Math.round(frames/8)&&stop.fileSize===buffer.byteLength&&observed.stops[0].bytes===buffer.byteLength-44,'WAV final frames/bytes differ from guest Stop')
      const decoded=await source.decodeAudioData(buffer.slice(0)),channel=decoded.getChannelData(0);let squared=0;for(const value of channel)squared+=value*value;const rms=Math.sqrt(squared/channel.length);check(decoded.numberOfChannels===2&&Math.abs(decoded.duration-frames/8000)<.002&&rms>.01,'real decoder did not recover recorded oscillator PCM')
      await call('__hostRecorderReadFile');state=await until(value=>value.log.some(row=>row[0]==='private-read'),read,mode+' guest private read');const guestRead=state.log.find(row=>row[0]==='private-read')[1];check(guestRead.arrayBuffer&&guestRead.bytes===buffer.byteLength&&guestRead.nonzero,'guest private file byte transport failed')
      await call('__hostRecorderRemoveFile');state=await until(value=>value.log.some(row=>row[0]==='private-delete-resolved'),read,mode+' guest private delete');let deleted=false;try{await services.files.read(stop.tempFilePath)}catch(error){deleted=error.name==='NotFoundError'}check(deleted,'guest deletion did not remove actual OPFS file')
      check(observed.contexts[0].state==='closed'&&observed.streams[0].getTracks().every(track=>track.readyState==='ended'),'successful WAV output preceded native graph/track termination')
      const stopCount=state.log.filter(row=>row[0]==='Stop').length
      await call('__hostRecorderStart');await until(value=>observed.nodes.length===2&&value.log.filter(row=>row[0]==='start-resolved').length===2,read,mode+' backpressure native start')
      // Deliberate bounded stall: native audio processing continues on its own
      // rendering thread while this consumer cannot acknowledge any PCM chunk.
      const stalledUntil=performance.now()+1550;while(performance.now()<stalledUntil){}
      state=await until(value=>value.log.some(row=>row[0]==='Error'&&String(row[1]?.errMsg).includes('backpressure'))&&observed.contexts[1].state==='closed',read,mode+' native PCM backpressure',true)
      check(state.log.filter(row=>row[0]==='Stop').length===stopCount,'backpressure published a corrupted or partial recording')
      await call('__hostRecorderStart');await until(value=>observed.nodes.length===3&&value.log.filter(row=>row[0]==='start-resolved').length===3,read,mode+' cancellation native start',true);await services.close();services=null
      check(observed.contexts.every(context=>context.state==='closed')&&observed.streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')),'owner cancellation left a native recorder graph or track')
      report.checks[mode]={formats,sampleRate:8000,sourceSampleRate:source.sampleRate,channels:2,pcmBytes:buffer.byteLength-44,frames,durationMs:stop.duration,decodedDuration:decoded.duration,decodedRms:rms,privateFileSha256:await hash(buffer),guestPrivateRead:guestRead,privateDeleted:deleted,pauseNoFrames:true,nativeBackpressure:{maxPendingChunks:4,deliberateConsumerStallMs:1550,errorObserved:true,noSuccessfulStop:true},recordingContexts:observed.contexts.length,retiredContexts:observed.contexts.filter(value=>value.state==='closed').length,retiredTracks:observed.streams.flatMap(value=>value.getTracks()).filter(value=>value.readyState==='ended').length,successfulStopEvents:stopCount,cancelledThirdRecording:true}
      if(client){await client.close();client=null}if(host){host.unload();host.free();host=null}
    }
    const boundaries=[]
    for(const kind of ['duration','scaled-byte-budget']){
      const stream=await boundaryEnvironment.navigator.mediaDevices.getUserMedia({audio:{channelCount:{exact:2}}}),data=[],errors=[],options={sampleRate:8000,channels:2,duration:kind==='duration'?150:5000,maxBytes:kind==='duration'?32*1024*1024:44+4096},recorder=new BrowserWavRecorder(boundaryEnvironment,stream,options),signal=new AbortController()
      let finish;const ended=new Promise(resolve=>{finish=resolve});recorder.ondataavailable=event=>data.push(event.data);recorder.onerror=event=>errors.push(event.error.message);recorder.onstop=()=>finish();let timer
      try{
        await recorder.initialize(signal.signal);recorder.start();await Promise.race([ended,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('actual native boundary recording timed out')),15000)})]);clearTimeout(timer)
        if(kind==='duration'){check(data.length===1&&errors.length===0&&recorder.recordedDurationMs===150,'native frame duration bound failed');const value=await data[0].arrayBuffer();check(new DataView(value).getUint32(40,true)===1200*4,'native duration did not stop on exact PCM frame boundary')}
        else check(data.length===0&&errors.some(value=>value.includes('byte budget')),'native PCM byte bound published partial output')
        await recorder.release();for(const track of stream.getTracks())track.stop()
        boundaries.push({kind,...options,recordedDurationMs:recorder.recordedDurationMs,errors,completeFiles:data.length,nativeClosed:true})
      }finally{clearTimeout(timer);signal.abort();await recorder.release();for(const track of stream.getTracks())track.stop()}
    }
    report.checks.nativeBoundaries={cases:boundaries,productionCompleteFileLimit:32*1024*1024,full32MiBRecording:'not-run',scope:'Same production backend/native Worklet with an explicit scaled byte bound; this is not a full-size 32 MiB recording claim.'}
    return report
  }finally{
    const errors=[],cleanup=async(name,action)=>{try{await action();report.cleanup.push({name,status:'closed'})}catch(error){errors.push(error);report.cleanup.push({name,status:'failed',message:String(error)})}}
    await cleanup('services',()=>services?.close());await cleanup('worker',()=>client?.close());await cleanup('direct-host',()=>{if(host){host.unload();host.free();host=null}})
    await cleanup('probe-port-listeners',()=>{for(const item of listeners)item.port.removeEventListener('message',item.listener)})
    await cleanup('synthetic-streams',()=>{for(const stream of streams)for(const track of stream.getTracks())track.stop();for(const track of destination?.stream.getTracks()||[])track.stop()})
    await cleanup('recording-context-check',async()=>{const remaining=contexts.filter(value=>value.state!=='closed');for(const value of remaining)await value.close();check(remaining.length===0,'a recording context required fallback cleanup')})
    await cleanup('synthetic-source',async()=>{oscillator?.stop();oscillator?.disconnect();gain?.disconnect();if(source&&source.state!=='closed')await source.close()})
    await cleanup('owned-private-folders',async()=>{const root=await navigator.storage.getDirectory();for(const folder of folders)try{await root.removeEntry(folder,{recursive:true})}catch(error){if(error.name!=='NotFoundError')throw error}})
    if(errors.length)throw new AggregateError(errors,'recorder browser probe cleanup failed')
  }
}
