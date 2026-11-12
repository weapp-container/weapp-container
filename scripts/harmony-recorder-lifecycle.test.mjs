import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'

// Production ArkTS with finite SDK callbacks. No audio sample, microphone or
// hardware acceptance is implied by these lifecycle/resource assertions.
const sourceRoot='../examples/hosts/harmony/entry/src/main/ets/'
const ownerSource=await readFile(new URL(sourceRoot+'session/HostServices.ts',import.meta.url),'utf8')
const owner=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(ownerSource,{mode:'strip'})).toString('base64'))
const catalog=JSON.parse(await readFile(new URL('../crates/container-runtime/src/host-api-catalog.json',import.meta.url),'utf8'))
const configuration={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'recorder-app',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:'1'}}
const settle=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}

class NativeTransport {
  commands=[];requests=[]
  hostServices(json){const command=JSON.parse(json);this.commands.push(command);if(command.operation==='protocol')return '{"version":"1.0","trustedContext":true,"ownerThreadCompletion":true}';if(command.operation==='configure')return '{"ok":true,"sessionId":"session"}';if(command.operation==='take')return JSON.stringify({requests:this.requests.splice(0)});if(command.operation==='managedFileScope')return '{"auxiliaryRoot":"/private/alice/recorder-app/native"}';return '{"ok":true}'}
  call(callId,method,payload={}){this.requests.push({kind:'call',callId,method,payload,context:{...configuration,sessionId:'session',callId,api:method}})}
  cancel(callId){this.requests.push({kind:'cancel',callId})}
  completions(){return this.commands.filter(value=>value.operation==='complete').map(value=>value.payload)}
  events(){return this.commands.filter(value=>value.operation==='event').map(value=>value.payload)}
}

async function fixture(options={}){
  const entries=new Map(),descriptors=new Map(),timers=new Map(),clients=[],imports=[],order=[]
  const state={time:1000,sequence:0,fd:10,permission:0},native=new NativeTransport()
  class Recorder {
    events=new Map();state='idle';releases=0;stops=0;pauses=0;resumes=0;config=null
    on(event,callback){this.events.set(event,callback)}
    off(event,callback){assert.equal(this.events.get(event),callback);this.events.delete(event)}
    emitState(value,reason=1){this.state=value;this.events.get('stateChange')?.(value,reason)}
    async getAvailableEncoder(){return options.encoders||[{mimeType:'audio/mp4a-latm',sampleRate:[8000,16000,44100],channels:{min:1,max:2},bitRate:{min:16000,max:128000}},{mimeType:'audio/mpeg',sampleRate:[44100],channels:{min:1,max:2},bitRate:{min:64000,max:128000}}]}
    async setWillMuteWhenInterrupted(value){assert.equal(value,false)}
    async prepare(value){order.push('prepare');this.config=value;this.fd=Number(value.url.slice(5));this.emitState('prepared')}
    async start(){order.push('start');if(this.startGate)await this.startGate;this.emitState('started')}
    async pause(){order.push('pause');this.pauses++;if(this.pauseGate)await this.pauseGate;this.emitState('paused')}
    async resume(){order.push('resume');this.resumes++;this.emitState('started')}
    async stop(){order.push('stop');this.stops++;if(this.stopGate)await this.stopGate;if(this.stopError)throw this.stopError;descriptors.get(this.fd).bytes=new Uint8Array([255,241,0,128,17]);this.emitState('stopped')}
    async release(){order.push('release');this.releases++;if(this.releaseGate)await this.releaseGate;if(this.releaseError)throw this.releaseError;this.emitState('released')}
    error(value){this.events.get('error')?.(value)}
  }
  const dependencies={...owner,canIUse:()=>options.syscap!==false,
    media:{CodecMimeType:{AUDIO_AAC:'audio/mp4a-latm',AUDIO_MP3:'audio/mpeg'},ContainerFormatType:{CFT_AAC:'aac',CFT_MP3:'mp3'},AudioSourceType:{AUDIO_SOURCE_TYPE_DEFAULT:0},async createAVRecorder(){const client=new Recorder();clients.push(client);order.push('create');if(options.createGate)await options.createGate;return client}},
    abilityAccessCtrl:{PermissionStatus:{GRANTED:0},createAtManager:()=>({getSelfPermissionStatus:()=>state.permission,requestPermissionsFromUser:()=>options.permission||Promise.resolve({authResults:[0]})})},
    promptAction:{showDialog:()=>options.dialog||Promise.resolve({index:0})},
    systemDateTime:{TimeType:{ACTIVE:1},getUptime:()=>state.time},util:{generateRandomUUID:()=>`uuid-${++state.sequence}`},
    fs:{OpenMode:{READ_WRITE:2,CREATE:64,TRUNC:512,NOFOLLOW:65536},openSync(path){order.push('open');assert.match(path,/^\/private\/alice\/recorder-app\/native\/recording-uuid-/);assert.equal(entries.has(path),false);const value={path,fd:++state.fd,bytes:new Uint8Array()};entries.set(path,value);descriptors.set(value.fd,value);return value},
      statSync(fd){const file=descriptors.get(fd);assert.ok(file);return {size:file.bytes.length,isFile:()=>true}},
      fsyncSync(fd){assert.ok(descriptors.has(fd))},
      readSync(fd,buffer,{offset,length}){const bytes=descriptors.get(fd).bytes.slice(offset,offset+Math.min(length,2));new Uint8Array(buffer).set(bytes);return bytes.length},
      closeSync(file){order.push('close');if(state.closeError)throw state.closeError;assert.ok(descriptors.delete(file.fd))},
      accessSync:path=>entries.has(path),unlinkSync(path){order.push('unlink');if(state.unlinkError)throw state.unlinkError;assert.ok(entries.delete(path))}},
    setInterval(callback){const id=++state.sequence;timers.set(id,callback);return id},clearInterval(id){timers.delete(id)},
  }
  const source=(await readFile(new URL(sourceRoot+'native/HarmonyRecorderApis.ets',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'')
  const key=`__harmonyRecorder${++fixture.sequence}`;globalThis[key]=dependencies
  const binding=`const {HarmonyApiError,canIUse,abilityAccessCtrl,media,fs,util,systemDateTime,promptAction,setInterval,clearInterval}=globalThis.${key};\n`
  const module=await import('data:text/javascript;base64,'+Buffer.from(binding+stripTypeScriptTypes(source,{mode:'strip'})).toString('base64'));delete globalThis[key]
  const services=new owner.HarmonyHostServices(native),files={writeTemporary(bytes,call,path){order.push('import');assert.equal(call.context.account.principalId,'alice');assert.match(path,/^wxfile:\/\/user\/recording-uuid-\d+\.(aac|mp3)$/);imports.push({bytes:[...bytes],path});return path}}
  const adapter=new module.HarmonyRecorderApis({},services,files);services.configure(configuration,configuration.application.packRoot)
  const pump=async()=>{services.drain();await settle();services.drain()}
  const manager=async()=>{native.call('manager','wx.getRecorderManager',{objectId:'recorder'});await pump();assert.equal(native.completions().at(-1).result.objectId,'recorder')}
  const call=(id,method,payload={})=>native.call(id,`object:RecorderManager.${method}`,{objectId:'recorder',...payload})
  const subscribe=async(events=['Start','Stop','Pause','Resume','Error','InterruptionBegin'])=>{for(const event of events)call('on'+event,'on'+event,{subscriptionId:'sub'+event});await pump()}
  const start=async(value={})=>{call('start','start',value);await pump();assert.equal(native.completions().find(value=>value.callId==='start').result.errMsg,'start:ok');return clients.at(-1)}
  const cleanup=async()=>{services.revoke();await services.waitForDrain();assert.equal(timers.size,0);assert.equal(descriptors.size,0);assert.equal(entries.size,0)}
  return {native,services,adapter,clients,imports,order,state,entries,descriptors,timers,pump,manager,call,subscribe,start,cleanup}
}
fixture.sequence=0

test('Harmony recorder registers only real catalog APIs and omits absent native capability',async()=>{
  const f=await fixture(),names=new Set(catalog.apis.map(value=>value.name))
  for(const api of f.adapter.supportedApis){assert.ok(names.has(api),api);assert.doesNotMatch(api,/\.off|FrameRecorded|InterruptionEnd/)}
  await f.cleanup();const absent=await fixture({syscap:false});assert.deepEqual(absent.services.supportedApis(),[]);await absent.cleanup()
})

test('Harmony recorder late microphone permission after hide/revoke never creates a native capturer and gates account drain',async()=>{
  const permission=deferred(),f=await fixture({permission:permission.promise});await f.manager();f.call('start','start');await f.pump()
  f.services.setForeground(false);f.services.revoke();let done=false;const drain=f.services.waitForDrain().then(()=>done=true);await settle();assert.equal(done,false)
  permission.resolve({authResults:[0]});await drain;assert.equal(f.clients.length,0);assert.equal(f.entries.size,0);assert.equal(f.native.events().length,0)
})

test('Harmony recorder native creation completing after revocation is actually released before owner drain',async()=>{
  const creation=deferred(),f=await fixture({createGate:creation.promise});await f.manager();f.call('start','start');await f.pump();assert.equal(f.clients.length,1)
  f.services.revoke();let done=false;const drain=f.services.waitForDrain().then(()=>done=true);await settle();assert.equal(done,false);assert.equal(f.clients[0].releases,0)
  creation.resolve();await drain;assert.equal(f.clients[0].releases,1);assert.equal(f.order.includes('prepare'),false);assert.equal(f.imports.length,0);assert.equal(f.entries.size,0)
})

test('Harmony recorder native state events queue on the owner, pause time is excluded, and Stop publishes managed bytes after release and cleanup',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start({format:'aac',sampleRate:16000,numberOfChannels:1,encodeBitRate:64000})
  assert.equal(recorder.config.profile.fileFormat,'aac');assert.equal(recorder.config.profile.audioCodec,'audio/mp4a-latm');assert.equal(recorder.config.maxDuration,60)
  f.state.time+=1000;f.call('pause','pause');await f.pump();f.state.time+=5000;f.call('resume','resume');await f.pump();f.state.time+=2000
  const events=f.native.events().length;f.call('stop1','stop');f.call('stop2','stop');await f.pump()
  assert.equal(recorder.stops,1);assert.equal(recorder.releases,1);assert.equal(f.native.events().length,events+1)
  const stop=f.native.events().at(-1);assert.equal(stop.event,'Stop');assert.equal(stop.objectId,'recorder');assert.equal(stop.value.duration,3000);assert.equal(stop.value.fileSize,5);assert.equal(stop.value.tempFilePath,f.imports[0].path);assert.deepEqual(f.imports[0].bytes,[255,241,0,128,17])
  assert.ok(f.order.indexOf('release')<f.order.indexOf('import'));assert.ok(f.order.indexOf('import')<f.order.indexOf('close'));assert.ok(f.order.indexOf('close')<f.order.indexOf('unlink'))
  assert.deepEqual(f.native.events().map(value=>value.event),['Start','Pause','Resume','Stop']);assert.equal(f.entries.size,0);assert.equal(f.descriptors.size,0);await f.cleanup()
})

test('Harmony recorder validates format/frame/source and actual encoder capabilities without starting a substitute codec',async()=>{
  const f=await fixture();await f.manager();await f.subscribe()
  for(const [id,value] of [['frame',{frameSize:1}],['wav',{format:'wav'}],['source',{audioSource:'headsetMic'}],['fractional',{duration:1.5}],['mode',{audioMode:'voiceChat'}],['bitrate',{sampleRate:8000,encodeBitRate:128000}]]){f.call(id,'start',value);await f.pump();assert.ok(f.native.completions().find(row=>row.callId===id).error)}
  assert.equal(f.clients.length,0)
  f.call('encoder','start',{sampleRate:48000,encodeBitRate:128000});await f.pump();assert.equal(f.clients.length,1);assert.equal(f.clients[0].releases,1);assert.equal(f.order.includes('prepare'),false);assert.equal(f.native.completions().find(row=>row.callId==='encoder').error.code,'unsupported')
  const recorder=await f.start({format:'mp3',sampleRate:44100,encodeBitRate:128000});assert.equal(recorder.config.profile.audioCodec,'audio/mpeg');assert.equal(recorder.config.profile.fileFormat,'mp3');await f.cleanup()
})

test('Harmony recorder background cleanup waits for native release, ignores late callbacks and publishes no old-user output',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start(),release=deferred();recorder.releaseGate=release.promise
  assert.deepEqual(recorder.config.profile,{audioBitrate:48000,audioChannels:2,audioCodec:'audio/mp4a-latm',audioSampleRate:8000,fileFormat:'aac'})
  const callback=recorder.events.get('stateChange');const count=f.native.events().length;f.services.setForeground(false);await settle();assert.equal(recorder.releases,1)
  f.services.revoke();let done=false;const drain=f.services.waitForDrain().then(()=>done=true);await settle();assert.equal(done,false);assert.equal(f.descriptors.size,1)
  callback('started',1);callback('stopped',2);release.resolve();await drain
  assert.equal(f.native.events().length,count);assert.equal(f.imports.length,0);assert.equal(f.entries.size,0);assert.equal(f.descriptors.size,0);assert.equal(f.timers.size,0)
})

test('Harmony recorder cancelling a queued pause waits for its real platform final before release',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start(),pause=deferred();recorder.pauseGate=pause.promise
  f.call('pause','pause');await f.pump();f.native.cancel('pause');await f.pump();let done=false;const drain=f.services.waitForDrain().then(()=>done=true);await settle();assert.equal(done,false);assert.equal(recorder.releases,0)
  pause.resolve();await drain;assert.equal(recorder.releases,1);assert.equal(f.native.events().some(value=>value.event==='Pause'),false);assert.equal(f.native.completions().some(value=>value.callId==='pause'),false);await f.cleanup()
})

test('Harmony recorder native interruption preserves raw error and releases the exact producer without fabricated interruption-end or Stop',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start()
  const count=f.native.events().length;recorder.error({code:5400107,message:'native audio interrupted'});assert.equal(f.native.events().length,count);await f.pump();await f.services.waitForDrain()
  assert.deepEqual(f.native.events().map(value=>value.event),['Start','InterruptionBegin','Error']);assert.equal(f.native.events().at(-1).value.errCode,5400107);assert.match(f.native.events().at(-1).value.errMsg,/native audio interrupted/);assert.equal(recorder.releases,1);assert.equal(f.imports.length,0);await f.cleanup()
})

test('Harmony recorder failed native release retains its file and retry barrier and cannot admit another recording',async()=>{
  const f=await fixture();await f.manager();const recorder=await f.start();recorder.releaseError={code:5400105,message:'native service died'}
  f.call('stop','stop');await f.pump();assert.equal(f.native.completions().find(value=>value.callId==='stop').error.details.errCode,5400105);assert.equal(f.descriptors.size,1);assert.equal(f.entries.size,1)
  f.call('again','start');await f.pump();assert.match(f.native.completions().find(value=>value.callId==='again').error.message,/awaiting cleanup/);assert.equal(f.clients.length,1)
  await assert.rejects(f.adapter.close(),error=>error.message==='native service died');assert.equal(f.descriptors.size,1)
  recorder.releaseError=null;await f.adapter.close();assert.equal(recorder.releases,3);assert.equal(f.descriptors.size,0);assert.equal(f.entries.size,0);await f.cleanup()
})

test('Harmony recorder event queue backpressure retires the exact producer and never publishes partial recorded output',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();f.services.emit=()=>false;f.call('start','start');await f.pump();await f.services.waitForDrain()
  assert.equal(f.clients[0].releases,1);assert.equal(f.entries.size,0);assert.equal(f.imports.length,0);assert.equal(f.timers.size,0);await f.cleanup()
})

test('Harmony recorder cancellation during native Stop preserves its operation barrier until the actual final',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start(),stop=deferred();recorder.stopGate=stop.promise
  f.call('stop','stop');await f.pump();assert.equal(recorder.stops,1);f.native.cancel('stop');await f.pump();let done=false;const drain=f.services.waitForDrain().then(()=>done=true);await settle();assert.equal(done,false);assert.equal(recorder.releases,0)
  stop.resolve();await drain;assert.equal(recorder.releases,1);assert.equal(f.imports.length,0);assert.equal(f.native.events().some(value=>value.event==='Stop'),false);await f.cleanup()
})

test('Harmony recorder permission revocation stops real capture and obsolete state callbacks cannot affect a replacement',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const first=await f.start(),old=first.events.get('stateChange')
  f.state.permission=-1;for(const tick of f.timers.values())tick();await f.pump();await f.services.waitForDrain()
  assert.equal(first.releases,1);assert.equal(f.native.events().at(-1).value.errCode,201);assert.equal(f.descriptors.size,0)
  f.state.permission=0;f.call('replacement','start');await f.pump();assert.equal(f.clients.length,2);const count=f.native.events().length
  old('paused',2);old('stopped',2);await f.pump();assert.equal(f.native.events().length,count);assert.equal(f.clients[1].releases,0);await f.cleanup()
})

test('Harmony recorder releases after a native Stop throws synchronously and retains no staging descriptor',async()=>{
  const f=await fixture();await f.manager();const recorder=await f.start();recorder.stop=()=>{throw {code:5400103,message:'native stop I/O error'}}
  f.call('stop','stop');await f.pump();assert.equal(recorder.releases,1);assert.equal(f.descriptors.size,0);assert.equal(f.entries.size,0);assert.equal(f.native.completions().find(value=>value.callId==='stop').error.details.errCode,5400103);await f.cleanup()
})

test('Harmony recorder retries staging cleanup without repeating native release or publishing Stop before the file is retired',async()=>{
  const f=await fixture();await f.manager();await f.subscribe();const recorder=await f.start();f.state.unlinkError={code:13900005,message:'native unlink failed'}
  f.call('stop','stop');await f.pump();assert.equal(recorder.releases,1);assert.equal(f.entries.size,1);assert.equal(f.descriptors.size,0);assert.equal(f.native.events().some(value=>value.event==='Stop'),false);assert.equal(f.imports.length,1)
  f.state.unlinkError=null;f.call('retry','stop');await f.pump();assert.equal(recorder.releases,1);assert.equal(f.entries.size,0);assert.equal(f.imports.length,1);assert.equal(f.native.events().filter(value=>value.event==='Stop').length,1);await f.cleanup()
})
