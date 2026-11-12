import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { MessageChannel } from 'node:worker_threads'
import { BrowserWavRecorder } from './browser-wav-recorder.mjs'
import { recorderSupport } from './browser-recorder-support.mjs'
import { BrowserHostServices } from './browser-host-services.mjs'

// Production worklet code + real transferable MessagePorts, with finite native
// graph handles. Actual browser capture/AudioWorklet/OPFS runs separately.
const workletSource=await readFile(new URL('./browser-wav-recorder-worklet.mjs',import.meta.url),'utf8')
const catalog=JSON.parse(await readFile(new URL('../../../crates/container-runtime/src/host-api-catalog.json',import.meta.url),'utf8'))
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const turn=()=>new Promise(resolve=>setImmediate(resolve))
async function until(predicate){const end=Date.now()+3000;while(!predicate()){assert.ok(Date.now()<end,'finite native lifecycle timed out');await turn()}}
function graph(options={}) {
  const control={contexts:[],nodes:[],disconnects:{source:0,node:0,gain:0},addModuleCalls:[],...options}
  let workletPort,Processor
  class Base {constructor(){this.port=workletPort}}
  vm.runInNewContext(workletSource,{AudioWorkletProcessor:Base,registerProcessor:(name,value)=>{assert.equal(name,'weapp-private-wav-v1');Processor=value},ArrayBuffer,DataView,Set,Number,Math,Error})
  const disconnect=name=>()=>{control.disconnects[name]++;if(control.disconnectError===name)throw new Error(name+' disconnect failed')}
  class Context extends EventTarget {
    state='suspended';closes=0;resumeWaiting=false;closed=deferred()
    constructor(configuration){super();this.sampleRate=control.actualRate||configuration.sampleRate;this.destination={};control.contexts.push(this)}
    get audioWorklet(){return {addModule:async(url,options)=>{control.addModuleCalls.push({url,options});if(control.moduleGate)await control.moduleGate.promise}}}
    createMediaStreamSource(stream){assert.ok(stream);return {connect(){},disconnect:disconnect('source')}}
    createGain(){return {gain:{value:1},connect(){},disconnect:disconnect('gain')}}
    async resume(){if(control.resumeGate){this.resumeWaiting=true;try{await Promise.race([control.resumeGate.promise,this.closed.promise])}finally{this.resumeWaiting=false}}if(this.state==='closed')throw new DOMException('context is closed','InvalidStateError');this.state='running';this.dispatchEvent(new Event('statechange'))}
    async close(){this.closes++;if(control.closeError)throw control.closeError;if(control.closeGate)await control.closeGate.promise;this.state='closed';if(this.resumeWaiting)this.closed.reject(new DOMException('closed native resume','InvalidStateError'));for(const node of control.nodes)node.processor.port.close();this.dispatchEvent(new Event('statechange'))}
  }
  class Node extends EventTarget {
    constructor(context,name,options){super();assert.equal(name,'weapp-private-wav-v1');this.context=context;const channel=new MessageChannel();this.port=channel.port1;workletPort=channel.port2;this.processor=new Processor(options);this.options=options;control.nodes.push(this)}
    connect(){}
    disconnect=disconnect('node')
    samples(channels){return this.processor.process([channels])}
  }
  const track=Object.assign(new EventTarget(),{kind:'audio',readyState:'live',stops:0,getSettings:()=>({sampleRate:48000,channelCount:2}),stop(){this.stops++;this.readyState='ended'}})
  const stream={getTracks:()=>[track]},root={async getDirectoryHandle(){return this}},document=Object.assign(new EventTarget(),{hidden:false})
  const environment={AudioContext:Context,AudioWorkletNode:Node,MediaRecorder:class{static isTypeSupported(){return false}},Blob,isSecureContext:true,navigator:{storage:{getDirectory:async()=>root},mediaDevices:{getUserMedia:async constraints=>{control.constraints=constraints;return stream}}},document,window:new EventTarget(),location:{origin:'https://host.test',href:'https://host.test/'},setTimeout,clearTimeout}
  return {environment,control,track,stream}
}
async function recording(options={}) {
  const f=graph(options),recorder=new BrowserWavRecorder(f.environment,f.stream,{sampleRate:8000,channels:2,duration:60000,maxBytes:32*1024*1024,...options.recording}),signal=new AbortController(),events=[],data=[]
  for(const name of ['start','pause','resume','stop'])recorder['on'+name]=()=>events.push(name)
  recorder.onerror=event=>events.push(['error',event.error.message]);recorder.ondataavailable=event=>data.push(event.data)
  await recorder.initialize(signal.signal);return {...f,recorder,signal,events,data}
}
const samples=(frames=128,value=.25)=>[new Float32Array(frames).fill(value),new Float32Array(frames).fill(-value)]

test('immutable recorder support distinguishes installed backends, storage and permissions without opening a device',()=>{
  const f=graph(),support=recorderSupport(f.environment,true)
  assert.deepEqual(Object.keys(support.formats),['wav']);assert.equal(support.formats.wav.backend,'wav-worklet');assert.ok(Object.isFrozen(support.formats));assert.throws(()=>{support.formats.wav.mimeType='audio/webm'})
  assert.equal(recorderSupport(f.environment,false).available,false);assert.equal(recorderSupport({...f.environment,isSecureContext:false},true).available,false);assert.equal(f.control.contexts.length,0)
})

test('real production worklet converts channels to exact little-endian PCM and completes one RIFF after pause/resume/stop',async()=>{
  const f=await recording();f.recorder.start();await until(()=>f.events.includes('start'));const node=f.control.nodes[0]
  node.samples(samples(128,.5));f.recorder.pause();await until(()=>f.events.includes('pause'));node.samples(samples(128,1));f.recorder.resume();await until(()=>f.events.includes('resume'));node.samples(samples(128,.25));f.recorder.stop();await until(()=>f.events.includes('stop'))
  assert.deepEqual(f.events,['start','pause','resume','stop']);assert.equal(f.data.length,1)
  const bytes=await f.data[0].arrayBuffer(),view=new DataView(bytes)
  assert.equal(new TextDecoder().decode(bytes.slice(0,4)),'RIFF');assert.equal(new TextDecoder().decode(bytes.slice(8,16)),'WAVEfmt ');assert.equal(view.getUint32(24,true),8000);assert.equal(view.getUint16(22,true),2);assert.equal(view.getUint16(34,true),16);assert.equal(view.getUint32(40,true),256*4)
  assert.equal(view.getInt16(44,true),16384);assert.equal(view.getInt16(46,true),-16384);assert.equal(view.getInt16(44+128*4,true),8192);assert.equal(f.recorder.recordedDurationMs,32)
  assert.equal(f.control.addModuleCalls[0].options.credentials,'omit');assert.match(f.control.addModuleCalls[0].url,/browser-wav-recorder-worklet\.mjs$/)
  await f.recorder.release();assert.equal(f.control.contexts[0].state,'closed');assert.deepEqual(f.control.disconnects,{source:1,node:1,gain:1});await f.recorder.release();assert.equal(f.control.contexts[0].closes,1)
})

test('native worklet credits bound queued PCM and overflow terminates instead of publishing a gapped file',async()=>{
  const f=await recording();f.recorder.start();await until(()=>f.events.includes('start'));const node=f.control.nodes[0]
  for(let i=0;i<5;i++){node.samples(samples(2048));assert.ok(node.processor.pending.size<=4)}
  await until(()=>f.events.includes('stop'));assert.equal(f.data.length,0);assert.ok(f.events.some(value=>Array.isArray(value)&&/backpressure/.test(value[1])));await until(()=>node.processor.pending.size===0);await f.recorder.release()
})

test('duration is bounded by actual PCM sample frames and byte overflow yields no RIFF output',async()=>{
  const f=await recording({recording:{duration:10}});f.recorder.start();await until(()=>f.events.includes('start'));f.control.nodes[0].samples(samples(128));await until(()=>f.events.includes('stop'));const data=await f.data[0].arrayBuffer();assert.equal(new DataView(data).getUint32(40,true),80*4);assert.equal(f.recorder.recordedDurationMs,10);await f.recorder.release()
  const small=await recording({recording:{maxBytes:44+32}});small.recorder.start();await until(()=>small.events.includes('start'));small.control.nodes[0].samples(samples(128));await until(()=>small.events.includes('stop'));assert.equal(small.data.length,0);assert.ok(small.events.some(value=>Array.isArray(value)&&/byte budget/.test(value[1])));await small.recorder.release()
})

test('cancellation during module acquisition closes the exact context and still waits for the actual native module terminal',async()=>{
  const gate=deferred(),f=graph({moduleGate:gate}),signal=new AbortController(),recorder=new BrowserWavRecorder(f.environment,f.stream,{sampleRate:8000,channels:2,duration:100,maxBytes:4096})
  let settled=false;const initializing=recorder.initialize(signal.signal).then(()=>assert.fail('cancelled initialization succeeded'),()=>{settled=true})
  await until(()=>f.control.addModuleCalls.length===1);signal.abort();await turn();assert.equal(f.control.contexts[0].state,'closed');assert.equal(settled,false);gate.resolve();await initializing;assert.equal(f.control.nodes.length,0);assert.equal(f.control.contexts[0].closes,1)
})

test('failed close during a native pending resume rejects retirement and retains the exact graph for explicit retry',async()=>{
  const resumeGate=deferred(),f=graph({resumeGate,closeError:new Error('native close failed')}),signal=new AbortController(),recorder=new BrowserWavRecorder(f.environment,f.stream,{sampleRate:8000,channels:2,duration:100,maxBytes:4096})
  const initializing=recorder.initialize(signal.signal);await until(()=>f.control.contexts[0]?.resumeWaiting);signal.abort();await assert.rejects(initializing,/acquisition and release failed/);assert.equal(f.control.contexts[0].state,'suspended')
  const previous={...f.control.disconnects};f.control.closeError=null;await recorder.release();assert.equal(f.control.contexts[0].state,'closed');assert.deepEqual(f.control.disconnects,previous);assert.equal(f.control.contexts[0].closes,2)
})

test('release waits for actual context close and retries only failed exact native stages',async()=>{
  const f=await recording(),closeGate=deferred();f.control.closeGate=closeGate;f.control.disconnectError='node';let closed=false;const releasing=f.recorder.release().catch(error=>{assert.match(error.message,/exact native releases/);closed=true})
  await until(()=>f.control.contexts[0].closes===1);assert.equal(closed,false);closeGate.resolve();await releasing;assert.equal(f.control.contexts[0].state,'closed');assert.deepEqual(f.control.disconnects,{source:1,node:1,gain:1})
  f.control.disconnectError=null;await f.recorder.release();assert.deepEqual(f.control.disconnects,{source:1,node:2,gain:1});assert.equal(f.control.contexts[0].closes,1)
})

class Runtime {
  requests=[];completions=[];events=[];sequence=0
  host_services_protocol_json(){return '{"version":"1.0"}'}
  configure_host_services_json(value){this.configuration=JSON.parse(value)}
  take_host_requests_json(){return JSON.stringify(this.requests.splice(0))}
  complete_host_api_call_json(callId,value){this.completions.push({callId,...JSON.parse(value)});return '{}'}
  dispatch_host_api_event_json(value){this.events.push(JSON.parse(value));return '{}'}
  revoke_host_services_json(){return '[]'}
  call(method,payload={}){const callId='call-'+ ++this.sequence;this.requests.push({kind:'call',method,callId,payload,context:{...trusted,sessionId:'wav-owner',callId,api:method}});return callId}
}
const trusted={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'wav-app',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:'1'}}
async function hostFixture(options={}){
  const f=graph(options),runtime=new Runtime(),entries=new Map(),services=new BrowserHostServices({runtime,catalog,environment:f.environment})
  await services.configure(trusted);services.files={persistent:true,async write(path,blob){if(options.writeGate)await options.writeGate.promise;entries.set(path,blob)},async remove(path){entries.delete(path)},async close(){}}
  const pump=async()=>{await services.drain();await turn();await services.drain()},invoke=async(method,payload={})=>{const id=runtime.call(method,payload);await pump();return id}
  await invoke('wx.getRecorderManager',{objectId:'wav'});await invoke('object:RecorderManager.onStop',{objectId:'wav',subscriptionId:'stop',action:'subscribe'})
  return {...f,runtime,services,entries,pump,invoke}
}

test('full host recorder bridge selects real WAV backend and publishes only after graph closure and private file completion',async()=>{
  const f=await hostFixture();assert.deepEqual(f.services.capabilities().recordingFormats,['wav'])
  const rejected=await f.invoke('object:RecorderManager.start',{objectId:'wav',format:'wav',encodeBitRate:48000});assert.equal(f.runtime.completions.find(value=>value.callId===rejected).error.code,'unsupported');assert.equal(f.control.contexts.length,0)
  const start=await f.invoke('object:RecorderManager.start',{objectId:'wav',format:'wav'});await until(()=>f.control.nodes.length===1);await f.pump();assert.ok(f.runtime.completions.find(value=>value.callId===start).result);assert.deepEqual(f.control.constraints,{audio:{channelCount:{exact:2}}})
  f.control.nodes[0].samples(samples(128));const stop=await f.invoke('object:RecorderManager.stop',{objectId:'wav'});await until(()=>f.entries.size===1);await f.pump();const event=f.runtime.events.find(value=>value.event==='Stop')
  assert.equal(event.value.fileSize,44+128*4);assert.equal(event.value.duration,16);assert.equal(event.value.pcmBitRate,256000);assert.equal(event.value.mimeType,'audio/wav');assert.equal(f.control.contexts[0].state,'closed');assert.equal(f.track.readyState,'ended');assert.ok(f.runtime.completions.find(value=>value.callId===stop).result)
  const file=await f.entries.get(event.value.tempFilePath).arrayBuffer();assert.equal(new DataView(file).getUint32(40,true),128*4);await f.services.close()
})

test('48kHz WAV with no compressed bitrate stops on native sample frames without a main-thread duration timer',async()=>{
  const f=await hostFixture();f.environment.setTimeout=()=>assert.fail('PCM duration must use native sample frames')
  try{
    const start=await f.invoke('object:RecorderManager.start',{objectId:'wav',format:'wav',sampleRate:48000,duration:1});await until(()=>f.control.nodes.length===1);await f.pump();assert.ok(f.runtime.completions.find(value=>value.callId===start).result)
    f.control.nodes[0].samples(samples(128));await until(()=>f.entries.size===1);await f.pump();const stop=f.runtime.events.find(value=>value.event==='Stop').value
    assert.equal(stop.duration,1);assert.equal(stop.sampleRate,48000);assert.equal(stop.pcmBitRate,1536000);assert.equal(stop.fileSize,44+48*4)
  }finally{await f.services.close()}
})

test('host account retirement while the worklet module loads blocks until its actual terminal and never publishes old audio',async()=>{
  const gate=deferred(),f=await hostFixture({moduleGate:gate});await f.invoke('object:RecorderManager.start',{objectId:'wav',format:'wav'});await until(()=>f.control.addModuleCalls.length===1)
  let closed=false;const closing=f.services.close().then(()=>closed=true);await turn();assert.equal(closed,false);assert.equal(f.control.contexts[0].state,'closed');gate.resolve();await closing;assert.equal(f.track.readyState,'ended');assert.equal(f.entries.size,0);assert.equal(f.runtime.events.length,0)
})

test('cancelled WAV start after actual worklet receipt drains native stop and closes its graph without guest completion',async()=>{
  const f=await hostFixture(),call=f.runtime.call('object:RecorderManager.start',{objectId:'wav',format:'wav'})
  await f.services.drain();await until(()=>f.control.nodes.length===1);await turn();await turn();assert.equal(f.runtime.completions.some(value=>value.callId===call),false)
  f.runtime.requests.push({kind:'cancel',callId:call});await f.pump();await until(()=>f.control.contexts[0].state==='closed');await f.pump();assert.equal(f.runtime.completions.some(value=>value.callId===call),false);assert.equal(f.track.readyState,'ended');assert.equal(f.entries.size,0);assert.equal(f.runtime.events.length,0);await f.services.close()
})

test('WAV graph close failure withholds Stop and files until exact owner retry succeeds',async()=>{
  const f=await hostFixture();await f.invoke('object:RecorderManager.start',{objectId:'wav',format:'wav'});await until(()=>f.control.nodes.length===1);await f.pump();f.control.nodes[0].samples(samples(128));f.control.closeError=new Error('native graph close failed')
  await f.invoke('object:RecorderManager.stop',{objectId:'wav'});await f.pump();assert.equal(f.entries.size,0);assert.equal(f.runtime.events.some(value=>value.event==='Stop'),false);await assert.rejects(f.services.close(),/owner close failed/)
  f.control.closeError=null;await f.services.close();assert.equal(f.track.readyState,'ended');assert.equal(f.entries.size,0);assert.equal(f.control.contexts[0].state,'closed');assert.deepEqual(f.control.disconnects,{source:1,node:1,gain:1})
})
