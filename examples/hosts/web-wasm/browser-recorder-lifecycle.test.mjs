import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { BrowserHostServices } from './browser-host-services.mjs'

// These are adversarial protocol doubles. They do not establish browser codec,
// microphone, permission-dialog, OPFS durability or physical-device acceptance.
const catalog=JSON.parse(await readFile(new URL('../../../crates/container-runtime/src/host-api-catalog.json',import.meta.url),'utf8'))
const trusted={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'recorder',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:'1'}}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
async function until(predicate){const end=Date.now()+3000;while(!predicate()){assert.ok(Date.now()<end,'recorder protocol timed out');await settle()}}
class Runtime {
  requests=[];completions=[];events=[];sequence=0
  host_services_protocol_json(){return '{"version":"1.0"}'}
  configure_host_services_json(value){this.configuration=JSON.parse(value)}
  take_host_requests_json(){return JSON.stringify(this.requests.splice(0))}
  complete_host_api_call_json(callId,value){this.completions.push({callId,...JSON.parse(value)});return '[]'}
  dispatch_host_api_event_json(value){this.events.push(JSON.parse(value));return '[]'}
  revoke_host_services_json(){this.revoked=true;return '[]'}
  call(method,payload={},identity=trusted){const callId=`call-${++this.sequence}`;this.requests.push({kind:'call',callId,method,payload,context:{...identity,sessionId:'session',callId,api:method}});return callId}
  cancel(callId){this.requests.push({kind:'cancel',callId})}
}
async function fixture(options={}) {
  const runtime=new Runtime(),document=new EventTarget(),window=new EventTarget(),recorders=[],order=[],entries=new Map(),timers=new Map(),diagnostics=[]
  const control={clock:0,permissionCalls:0,stopError:null,trackError:null,writeGate:null,writeError:null,removeError:null,...options}
  document.hidden=false
  class Track extends EventTarget {
    kind='audio';readyState='live';stops=0
    getSettings(){return control.settings||{sampleRate:8000,channelCount:2}}
    stop(){this.stops++;order.push('track-stop');if(control.trackError)throw control.trackError;this.readyState='ended'}
  }
  const track=new Track(),stream={getTracks:()=>[track]}
  const privateRoot={async getDirectoryHandle(){return this}}
  class Recorder {
    static isTypeSupported(value){return (control.supported||['audio/mpeg']).includes(value)}
    state='inactive';stops=0
    constructor(input,config){assert.equal(input,stream);this.mimeType=control.actualMime||config.mimeType;this.audioBitsPerSecond=control.actualBitrate||config.audioBitsPerSecond;this.config=config;recorders.push(this)}
    start(){this.state='recording';order.push('native-start')}
    pause(){this.state='paused';order.push('native-pause')}
    resume(){this.state='recording';order.push('native-resume')}
    stop(){this.stops++;order.push('native-stop');if(control.stopError)throw control.stopError;this.state='inactive'}
    data(bytes=[1,2],type=this.mimeType){this.ondataavailable?.({data:new Blob([new Uint8Array(bytes)],{type})})}
    finish(bytes=[3,4]){this.state='inactive';this.data(bytes);this.onstop?.()}
  }
  if(control.missingTypeSupport)Recorder.isTypeSupported=undefined
  if(control.typeSupportError)Recorder.isTypeSupported=()=>{throw control.typeSupportError}
  const environment={navigator:{onLine:true,...(control.persistent===false?{}:{storage:{getDirectory:async()=>privateRoot}}),mediaDevices:{getUserMedia:async constraints=>{control.permissionCalls++;control.constraints=constraints;return control.permissionGate?await control.permissionGate:stream}}},MediaRecorder:Recorder,Blob,document,window,location:{origin:'https://host.test',href:'https://host.test/'},performance:{now:()=>control.clock},setTimeout:callback=>{const key=Symbol();timers.set(key,()=>{timers.delete(key);callback()});return key},clearTimeout:key=>timers.delete(key)}
  const services=new BrowserHostServices({runtime,catalog,environment,onDiagnostic:error=>diagnostics.push(error)})
  if(control.nativeOverride)services.registerApiHandler('wx.getRecorderManager',(payload)=>({objectId:payload.objectId,nativeOverride:true}))
  await services.configure(trusted)
  services.files={persistent:control.persistent!==false,async write(path,blob){assert.notEqual(control.filesClosed,true);order.push('file-write');if(control.writeGate)await control.writeGate;entries.set(path,blob);if(control.writeError)throw control.writeError;order.push('file-written')},async remove(path){assert.notEqual(control.filesClosed,true);order.push('file-remove');if(control.removeError)throw control.removeError;if(!entries.delete(path))throw new DOMException('absent','NotFoundError')},async close(){control.filesClosed=true;order.push('files-close')}}
  const pump=async()=>{await services.drain();await settle();await services.drain()}
  const manager=async()=>{const key=runtime.call('wx.getRecorderManager',{objectId:'recorder'});await pump();assert.equal(runtime.completions.find(item=>item.callId===key)?.result.objectId,'recorder');return key}
  const call=(method,payload={})=>runtime.call(`object:RecorderManager.${method}`,{objectId:'recorder',...(method==='start'?{format:'mp3'}:{}),...payload})
  const subscribe=async()=>{for(const event of ['Start','Pause','Resume','Stop','Error','InterruptionBegin'])call(`on${event}`,{subscriptionId:event,action:'subscribe'});await pump()}
  const start=async(payload={})=>{const key=call('start',payload);await pump();assert.equal(recorders.length,1);recorders[0].onstart();await pump();assert.ok(runtime.completions.find(item=>item.callId===key)?.result);return recorders[0]}
  const close=async()=>{control.stopError=null;control.trackError=null;control.removeError=null;const promise=services.close();await settle();for(const recorder of recorders)if(recorder.onstop)recorder.finish();await promise}
  return {runtime,services,control,track,stream,recorders,order,entries,timers,document,diagnostics,pump,manager,call,subscribe,start,close}
}

test('browser recorder registers only frozen on methods and rejects unsupported encoding/options before microphone access',async()=>{
  const f=await fixture();await f.manager()
  assert.equal(f.runtime.configuration.apis.some(name=>name.startsWith('object:RecorderManager.off')),false)
  for(const payload of [{format:'aac'},{format:'PCM'},{format:undefined},{duration:0},{sampleRate:12345},{sampleRate:48000,encodeBitRate:16000},{numberOfChannels:3},{encodeBitRate:1},{frameSize:0},{audioSource:'mic'},{audioMode:'voiceChat'}]){
    const key=f.call('start',payload);await f.pump();assert.ok(f.runtime.completions.find(item=>item.callId===key)?.error)
  }
  assert.equal(f.control.permissionCalls,0);await f.close()
  const memory=await fixture({persistent:false});assert.equal(memory.runtime.configuration.apis.some(name=>name==='wx.getRecorderManager'||name.startsWith('object:RecorderManager.')),false);assert.deepEqual(memory.services.capabilities().recordingFormats,[]);assert.equal(memory.control.permissionCalls,0);await memory.close()
})

test('browser recorder negotiation omits the whole group without an installed baseline encoder and preserves permission errors separately',async()=>{
  for(const options of [{supported:['audio/webm;codecs=opus']},{supported:[]},{missingTypeSupport:true},{typeSupportError:new Error('codec query failed')}]){
    const f=await fixture(options);assert.equal(f.runtime.configuration.apis.some(name=>name==='wx.getRecorderManager'||name.startsWith('object:RecorderManager.')),false);assert.deepEqual(f.services.capabilities().recordingFormats,[])
    const factory=f.runtime.call('wx.getRecorderManager',{objectId:'absent'}),start=f.call('start');await f.pump();assert.equal(f.runtime.completions.find(value=>value.callId===factory).error.code,'unsupported');assert.equal(f.runtime.completions.find(value=>value.callId===start).error.code,'unsupported');assert.equal(f.control.permissionCalls,0);assert.equal(f.recorders.length,0);assert.equal(f.runtime.events.length,0);assert.equal(f.entries.size,0);await f.close()
  }
  const permission=deferred(),f=await fixture({permissionGate:permission.promise});await f.manager();const call=f.call('start');await f.pump();permission.reject(new DOMException('user denied microphone','NotAllowedError'));await f.pump();assert.equal(f.runtime.completions.find(value=>value.callId===call).error.code,'permission_denied');assert.ok(f.services.capabilities().apis.includes('object:RecorderManager.start'));assert.deepEqual(f.services.capabilities().recordingFormats,['mp3']);assert.equal(f.recorders.length,0);await f.close()
  const native=await fixture({supported:[],nativeOverride:true});await native.manager();assert.ok(native.runtime.completions[0].result.nativeOverride);assert.equal(native.runtime.configuration.apis.filter(name=>name==='wx.getRecorderManager'||name.startsWith('object:RecorderManager.')).length,1);await native.close()
})

test('browser recorder validates actual track settings and encoder MIME/bitrate without relabeling browser output',async()=>{
  for(const options of [{settings:{sampleRate:48000,channelCount:2}},{actualMime:'audio/webm'},{actualBitrate:64000}]){
    const f=await fixture(options);await f.manager();const key=f.call('start');await f.pump();await until(()=>f.runtime.completions.some(item=>item.callId===key));await f.pump()
    assert.equal(f.runtime.completions.find(item=>item.callId===key).error.code,'unsupported');assert.equal(f.track.readyState,'ended');assert.equal(f.entries.size,0);await f.close()
  }
})

test('browser recorder waits for real start/pause/resume/stop and publishes one complete encoded file after track release and persistence',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const start=f.call('start');await f.pump();const recorder=f.recorders[0]
  assert.equal(f.runtime.completions.some(value=>value.callId===start),false);assert.equal(f.runtime.events.length,0)
  f.control.clock=1000;recorder.onstart();await f.pump();assert.equal(f.runtime.events.at(-1).event,'Start')
  assert.deepEqual(f.control.constraints,{audio:{sampleRate:{exact:8000},channelCount:{exact:2}}});assert.equal(recorder.config.audioBitsPerSecond,48000)
  f.control.clock=2000;const pause=f.call('pause');await f.pump();assert.equal(f.runtime.completions.some(value=>value.callId===pause),false);recorder.onpause();await f.pump()
  f.control.clock=5000;f.call('resume');await f.pump();recorder.onresume();await f.pump();recorder.data([1,2])
  f.control.clock=7000;const stop=f.call('stop');await f.pump();assert.equal(recorder.state,'inactive');assert.equal(f.entries.size,0);assert.equal(f.runtime.completions.some(value=>value.callId===stop),false)
  const write=deferred();f.control.writeGate=write.promise;recorder.finish([3,4]);await until(()=>f.order.includes('file-write'));await f.pump()
  assert.equal(f.track.readyState,'ended');assert.equal(f.runtime.events.some(value=>value.event==='Stop'),false)
  write.resolve();await until(()=>f.order.includes('file-written'));await f.pump();const event=f.runtime.events.find(value=>value.event==='Stop')
  assert.equal(event.value.duration,3000);assert.equal(event.value.mimeType,'audio/mpeg');assert.equal(event.value.fileSize,4);assert.match(event.value.tempFilePath,/\.mp3$/)
  assert.deepEqual([...new Uint8Array(await f.entries.get(event.value.tempFilePath).arrayBuffer())],[1,2,3,4]);assert.ok(f.order.indexOf('track-stop')<f.order.indexOf('file-write'));assert.ok(f.runtime.completions.find(value=>value.callId===stop).result);await f.close()
})

test('browser recorder owner close waits for the native stop event and discards late audio before file publication',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start(),oldData=recorder.ondataavailable,oldStop=recorder.onstop
  let closed=false;const closing=f.services.close().then(()=>closed=true);await until(()=>recorder.stops===1);await settle();assert.equal(closed,false)
  oldData({data:new Blob(['old-account'],{type:'audio/mpeg'})});oldStop();await closing;assert.equal(f.track.readyState,'ended');assert.equal(f.entries.size,0)
  oldData({data:new Blob(['later'],{type:'audio/mpeg'})});oldStop();await settle();assert.equal(f.entries.size,0);assert.equal(f.runtime.events.some(value=>value.event==='Stop'),false)
})

test('browser recorder late getUserMedia result retains failed exact track stop for explicit close retry',async()=>{
  const permission=deferred(),f=await fixture({permissionGate:permission.promise,trackError:new Error('track stop failed')});await f.manager();f.call('start');await f.pump()
  let closed=false;const closing=f.services.close().then(()=>closed=true);await settle();assert.equal(closed,false);permission.resolve(f.stream)
  await assert.rejects(closing,/owner close failed/);assert.equal(f.recorders.length,0);assert.equal(f.track.readyState,'live');assert.ok(f.track.stops>=1)
  const attempts=f.track.stops;f.control.trackError=null;await f.services.close();assert.equal(f.track.stops,attempts+1);assert.equal(f.track.readyState,'ended');assert.equal(f.entries.size,0)
})

test('browser recorder cancellation during pause waits for real terminal and revokes queued producer events',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start(),pause=f.call('pause');await f.pump();const oldPause=recorder.onpause
  f.runtime.cancel(pause);await f.pump();await until(()=>recorder.stops===1);oldPause();await f.pump();assert.equal(f.runtime.events.some(value=>value.event==='Pause'),false)
  const closing=f.services.close();recorder.finish();await closing;assert.equal(f.runtime.completions.some(value=>value.callId===pause),false);assert.equal(f.entries.size,0)
})

test('recorder cancellation after native start or pause success but before guest completion still revokes the exact capture',async()=>{
  for(const phase of ['start','pause']){
    const f=await fixture();await f.manager();await f.subscribe();let key,recorder
    if(phase==='start'){
      key=f.call('start');await f.services.drain();await settle();recorder=f.recorders[0];recorder.onstart();await settle()
    }else{recorder=await f.start();f.runtime.events=[];key=f.call('pause');await f.services.drain();await settle();recorder.onpause();await settle()}
    assert.equal(f.runtime.completions.some(value=>value.callId===key),false);f.runtime.cancel(key);await f.pump();await until(()=>recorder.stops===1);recorder.finish();await f.pump();assert.equal(f.runtime.completions.some(value=>value.callId===key),false);assert.equal(f.runtime.events.length,0);assert.equal(f.entries.size,0);assert.equal(f.track.readyState,'ended');await f.close()
  }
})

test('browser recorder native interruption preserves error and emits no fabricated Stop or interruption-end',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start();recorder.onerror({error:Object.assign(new Error('native microphone lost'),{code:77})});await until(()=>recorder.stops===1);recorder.finish();await f.pump()
  assert.deepEqual(f.runtime.events.map(value=>value.event),['Start','InterruptionBegin','Error']);assert.equal(f.runtime.events.at(-1).value.errCode,77);assert.equal(f.entries.size,0);assert.equal(f.track.readyState,'ended');await f.close()
})

test('browser recorder close during persistence removes the completed old-user file before drain acknowledges',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start(),write=deferred();f.control.writeGate=write.promise;f.call('stop');await f.pump();recorder.finish();await until(()=>f.order.includes('file-write'))
  let closed=false;const closing=f.services.close().then(()=>closed=true);await settle();assert.equal(closed,false);write.resolve();await closing
  assert.equal(f.entries.size,0);assert.ok(f.order.indexOf('file-remove')>f.order.indexOf('file-written'));assert.equal(f.runtime.events.some(value=>value.event==='Stop'),false)
})

test('browser recorder failed old-user file removal retains exact cleanup and leaves private files open for close retry',async()=>{
  const f=await fixture();await f.manager();const recorder=await f.start(),write=deferred();f.control.writeGate=write.promise;f.control.removeError=new Error('old file removal failed');f.call('stop');await f.pump();recorder.finish();await until(()=>f.order.includes('file-write'))
  const closing=f.services.close();write.resolve();await assert.rejects(closing,/owner close failed/)
  assert.equal(f.entries.size,1);assert.notEqual(f.control.filesClosed,true);assert.equal(recorder.stops,1)
  const writes=f.order.filter(value=>value==='file-write').length,removes=f.order.filter(value=>value==='file-remove').length
  f.control.removeError=null;await f.services.close();assert.equal(f.entries.size,0);assert.equal(f.control.filesClosed,true);assert.equal(recorder.stops,1)
  assert.equal(f.order.filter(value=>value==='file-write').length,writes);assert.equal(f.order.filter(value=>value==='file-remove').length,removes+1)
})

test('browser recorder failed persistent write cleans its partial managed file without publishing Stop',async()=>{
  const f=await fixture({writeError:new Error('persistent write failed')});await f.manager();await f.subscribe();const recorder=await f.start(),key=f.call('stop');await f.pump();recorder.finish();await until(()=>f.order.includes('file-remove'));await f.pump()
  assert.equal(f.entries.size,0);assert.ok(f.runtime.completions.find(value=>value.callId===key).error);assert.equal(f.runtime.events.some(value=>value.event==='Stop'),false);await f.close()
})

test('browser recorder failed native stop retains the exact recorder until retry observes its real terminal',async()=>{
  const f=await fixture();await f.manager();const recorder=await f.start();f.control.stopError=new Error('native stop failed')
  await assert.rejects(f.services.close(),/owner close failed/);assert.equal(recorder.stops,1);assert.equal(f.track.readyState,'ended');assert.equal(typeof recorder.onstop,'function')
  f.control.stopError=null;let closed=false;const retry=f.services.close().then(()=>closed=true);await until(()=>recorder.stops===2);assert.equal(closed,false);recorder.finish();await retry;assert.equal(f.entries.size,0)
})

test('browser recorder background and native event backpressure revoke pending values and stop exact capture',async()=>{
  for(const background of [true,false]){
    const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start()
    if(background){f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'))}
    else for(let index=0;index<300;index++)recorder.onpause?.()
    await until(()=>recorder.stops===1);recorder.finish();await f.pump();assert.equal(f.runtime.events.some(value=>value.event==='Stop'||value.event==='Pause'),false);assert.equal(f.entries.size,0);assert.equal(f.track.readyState,'ended');await f.close()
  }
})

test('browser recorder duration limit requests stop but still waits for native terminal and complete output',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start({duration:1000});assert.equal(f.timers.size,1)
  f.control.clock=1000;[...f.timers.values()][0]();await until(()=>recorder.stops===1);assert.equal(f.entries.size,0);recorder.finish([1]);await f.pump()
  assert.equal(f.runtime.events.find(value=>value.event==='Stop').value.duration,1000);assert.equal(f.timers.size,0);await f.close()
})
