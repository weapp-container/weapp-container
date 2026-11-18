import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {BrowserHostServices} from './browser-host-services.mjs'
import {HOST_API_RESOURCE_MAX_BYTES} from './worker-session-client.mjs'
const catalog=JSON.parse(await readFile(new URL('../../../crates/container-runtime/src/host-api-catalog.json',import.meta.url)))
const trusted={application:{hostAppId:'host',tenantId:'tenant',publisherId:'publisher',appId:'app',environment:'release',version:'1',packRoot:'a'.repeat(64)},account:{principalId:'alice',epoch:1}}
const turn=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
class Transport {
  requests=[];completions=[];events=[];sequence=0
  host_services_protocol_json(){return '{"version":"1.0"}'}
  configure_host_services_json(value){this.config=JSON.parse(value)}
  take_host_requests_json(){return JSON.stringify(this.requests.splice(0))}
  complete_host_api_call_json(callId,value){this.completions.push({callId,...JSON.parse(value)});return '{}'}
  dispatch_host_api_event_json(value){this.events.push(JSON.parse(value));return '{}'}
  revoke_host_services_json(){this.revoked=true;return '[]'}
  call(method,payload={}){const callId='call-'+ ++this.sequence;this.requests.push({kind:'call',method,payload,callId,context:{...trusted,sessionId:'owner',callId,api:method}});return callId}
}
class Audio extends EventTarget {
  autoplay=false;loop=false;volume=1;playbackRate=1;currentTime=0;duration=NaN;paused=true;buffered={length:0};removed=0;loads=0;pauses=0
  pause(){this.pauses++;this.paused=true;this.dispatchEvent(new Event('pause'))}
  async play(){this.paused=false;this.dispatchEvent(new Event('play'))}
  removeAttribute(name){assert.equal(name,'src');this.removed++;delete this.src}
  load(){this.loads++}
}
async function fixture({AudioClass=Audio,runtimeSetup=()=>{},...options}={}){
  const runtime=new Transport(),elements=[],errors=[]
  runtimeSetup(runtime)
  const environment={navigator:{},setTimeout,clearTimeout,fetch,location:{origin:'https://host.test',href:'https://host.test/'},Audio:class extends AudioClass{constructor(){super();elements.push(this)}},...options}
  const services=new BrowserHostServices({runtime,catalog,environment,onDiagnostic:error=>errors.push(error)})
  await services.configure(trusted)
  const flush=async()=>{await services.drain();await turn();await services.drain()}
  runtime.call('wx.createInnerAudioContext',{objectId:'audio'});await flush()
  const call=(member,payload={})=>runtime.call('object:InnerAudioContext.'+member,{objectId:'audio',...payload})
  return {runtime,services,elements,errors,call,flush}
}

test('remote audio is fetched without host credentials and only an owned Blob URL reaches decoder',async()=>{
  const requests=[]
  const f=await fixture({fetch:async(url,options)=>{requests.push({url,options});return new Response(new Uint8Array([0,1,2]),{headers:{'content-type':'audio/mpeg'}})}})
  f.call('src',{action:'set',value:'https://host.test/audio.mp3'});await f.flush()
  assert.equal(requests.length,1);assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.redirect,'error')
  const url=f.elements.at(-1).src;assert.match(url,/^blob:/);assert.deepEqual([...new Uint8Array(await (await fetch(url)).arrayBuffer())],[0,1,2])
  assert.equal(f.runtime.completions.at(-1).result.properties.src,'https://host.test/audio.mp3')
  await f.services.close();await assert.rejects(fetch(url));assert.equal(f.elements.at(-1).removed,1)
})

test('an origin-relative packaged path is rejected before it can read host-site resources',async()=>{
  let fetched=0;const f=await fixture({fetch:()=>{fetched++;throw new Error('host-site request must not run')}})
  f.call('src',{action:'set',value:'../../assets/private.mp3'});await f.flush()
  assert.equal(fetched,0);assert.equal(f.runtime.completions.at(-1).error.code,'unsupported');assert.equal(f.elements.length,1);await f.services.close()
})

test('replaced audio has a new native decoder, invalidates queued events and rejects stale browser callbacks',async()=>{
  const f=await fixture({fetch:async()=>new Response('audio')})
  f.call('onPlay',{subscriptionId:'plays',action:'subscribe'});await f.flush()
  const original=f.elements[0];original.dispatchEvent(new Event('play'))
  // Source replacement handler runs after the request pump. No old decoder
  // event may be delivered once its native release begins.
  f.call('src',{action:'set',value:'https://host.test/new.mp3'});await f.services.drain();await turn();await f.services.drain()
  const delivered=f.runtime.events.length;original.dispatchEvent(new Event('play'));await f.services.drain();assert.equal(f.runtime.events.length,delivered)
  f.call('play');await f.flush();assert.equal(f.runtime.events.length,delivered+1);assert.equal(f.elements.length,2);assert.equal(original.loads,1)
  await f.services.close()
})

test('a late managed source drains before a newer source acquires bytes and its exact URL is released',async()=>{
  let fetched=0;const file=deferred(),f=await fixture({fetch:async()=>{fetched++;return new Response('latest')}});const acquired=[]
  f.services.files.objectUrl=async()=>{await file.promise;const url=URL.createObjectURL(new Blob(['obsolete']));acquired.push(url);return url}
  f.services.files.releaseUrl=url=>URL.revokeObjectURL(url)
  const old=f.call('src',{action:'set',value:'wxfile://user/old.mp3'});await f.services.drain();await turn()
  const latest=f.call('src',{action:'set',value:'https://host.test/latest.mp3'});await f.flush()
  assert.equal(fetched,0,'replacement must wait the old native acquisition terminal');assert.equal(f.elements.at(-1).src,undefined)
  file.resolve();await turn();await f.services.drain()
  assert.match(f.elements.at(-1).src,/^blob:/);assert.equal(fetched,1)
  assert.equal(f.runtime.completions.find(value=>value.callId===old).error.code,'cancelled')
  assert.equal(f.runtime.completions.find(value=>value.callId===latest).result.properties.src,'https://host.test/latest.mp3')
  await assert.rejects(fetch(acquired[0]));await f.services.close()
})

test('retirement waits a real in-flight audio HTTP terminal and never publishes or assigns late bytes',async()=>{
  const received=deferred(),release=deferred();let signal
  const f=await fixture({fetch:async(url,options)=>{signal=options.signal;received.resolve();await release.promise;return new Response('old-account-audio')}})
  f.call('src',{action:'set',value:'https://host.test/slow.mp3'});await f.services.drain();await received.promise
  let closed=false;const closing=f.services.close().then(()=>closed=true);await turn();assert.equal(closed,false);assert.equal(signal.aborted,true)
  release.resolve();await closing;assert.equal(f.elements.at(-1).src,undefined);assert.equal(f.runtime.completions.length,1)
})

test('failed exact decoder release is retryable and successful cleanup stages are not replayed',async()=>{
  let fail=true
  class Faulty extends Audio{load(){this.loads++;if(fail)throw new Error('native decoder still owns resource')}}
  const f=await fixture({AudioClass:Faulty});await assert.rejects(f.services.close(),/close failed/)
  assert.equal(f.elements[0].pauses,1);assert.equal(f.elements[0].removed,1);fail=false
  await f.services.close();assert.equal(f.elements[0].pauses,1);assert.equal(f.elements[0].removed,1);assert.equal(f.elements[0].loads,2)
})

test('actual HTTP data reaches only a Blob decoder and an excessive declared resource fails without playback',async t=>{
  const server=createServer((request,response)=>{if(request.url==='/too-big'){response.setHeader('content-length',String(32*1024*1024+1));response.end()}else response.end('actual-audio-fixture')})
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close())
  const origin='http://127.0.0.1:'+server.address().port,f=await fixture({location:{origin,href:origin+'/'}});t.after(()=>f.services.close())
  f.call('src',{action:'set',value:origin+'/clip'});await f.services.drain()
  const until=Date.now()+3000;while(!f.elements.at(-1).src){assert(Date.now()<until);await turn()}
  await f.services.drain();const url=f.elements.at(-1).src;assert.equal(await (await fetch(url)).text(),'actual-audio-fixture')
  f.call('src',{action:'set',value:origin+'/too-big'});await f.services.drain();while(!f.runtime.completions.some(value=>value.error)){assert(Date.now()<until);await turn();await f.services.drain()}
  assert.match(f.runtime.completions.at(-1).error.message,/decoder limit/);assert.equal(f.elements.at(-1).src,undefined)
})

test('audio producer backpressure revokes its queued events and rejects playback before native side effects',async()=>{
  let plays=0
  class CountingAudio extends Audio{async play(){plays++;return super.play()}}
  const f=await fixture({AudioClass:CountingAudio})
  f.call('onPlay',{subscriptionId:'audio-play',action:'subscribe'});await f.flush()
  for(let index=0;index<257;index++)f.elements[0].dispatchEvent(new Event('play'))
  await turn();await f.services.drain();assert.equal(f.runtime.events.length,0)
  assert(f.errors.some(error=>error.message.includes('queue is full')))
  f.call('play');await f.flush();assert.equal(plays,0);assert.equal(f.runtime.completions.at(-1).error.code,'cancelled');await f.services.close()
})

test('failed exact managed URL release keeps private files available for owner-close retry',async()=>{
  const f=await fixture();await f.services.files.write('wxfile://user/audio.mp3','managed audio')
  f.call('src',{action:'set',value:'wxfile://user/audio.mp3'});await f.flush();const url=f.elements.at(-1).src
  let fail=true,releases=0;const release=f.services.files.releaseUrl.bind(f.services.files)
  f.services.files.releaseUrl=value=>{assert.equal(value,url);releases++;if(fail)throw new Error('native URL still retained');release(value)}
  await assert.rejects(f.services.close(),/close failed/);assert.equal(await (await f.services.files.read('wxfile://user/audio.mp3')).text(),'managed audio')
  fail=false;await f.services.close();assert.equal(releases,2);await assert.rejects(fetch(url));assert.equal(f.elements.at(-1).removed,1)
})

test('close aborts a real pending playback algorithm and waits its terminal without guest settlement',async()=>{
  let pending
  class PendingAudio extends Audio{
    play(){pending=deferred();return pending.promise}
    load(){super.load();if(pending){pending.reject(Object.assign(new Error('playback aborted by load'),{name:'AbortError'}));pending=null}}
  }
  const f=await fixture({AudioClass:PendingAudio});f.call('play');await f.services.drain();await turn();assert(pending)
  await f.services.close();assert.equal(pending,null);assert.equal(f.runtime.completions.length,1)
})

test('the exact pending API context authorizes packaged bytes without any host-site fetch',async()=>{
  let received,fetched=0
  const f=await fixture({fetch(){fetched++;throw new Error('package must never fetch host resources')},runtimeSetup(runtime){
    runtime.host_services_protocol_json=()=>JSON.stringify({version:'1.0',packagedApiResources:'1.0'})
    runtime.host_api_resource=async context=>{received=JSON.parse(context);return new Uint8Array([0,128,255])}
  }})
  const callId=f.call('src',{action:'set',value:'/assets/tone.wav'});await f.flush()
  assert.equal(fetched,0);assert.equal(received.callId,callId);assert.equal(received.api,'object:InnerAudioContext.src');assert.deepEqual(received.application,trusted.application)
  const url=f.elements.at(-1).src;assert.deepEqual([...new Uint8Array(await (await fetch(url)).arrayBuffer())],[0,128,255]);await f.services.close();await assert.rejects(fetch(url))
})

test('the direct package audio decoder admits the shared wire ceiling and rejects the next byte',async()=>{
  let size=HOST_API_RESOURCE_MAX_BYTES
  const f=await fixture({runtimeSetup(runtime){
    runtime.host_services_protocol_json=()=>JSON.stringify({version:'1.0',packagedApiResources:'1.0'})
    runtime.host_api_resource=async()=>new Uint8Array(size)
  }})
  f.call('src',{action:'set',value:'/assets/boundary.wav'});await f.flush()
  const url=f.elements.at(-1).src;assert.equal((await (await fetch(url)).arrayBuffer()).byteLength,size)
  size++;f.call('src',{action:'set',value:'/assets/oversized.wav'});await f.flush()
  assert.match(f.runtime.completions.at(-1).error.message,/verified decoder limit/);assert.equal(f.elements.at(-1).src,undefined)
  await assert.rejects(fetch(url));await f.services.close()
})

test('cancellation of pending playback aborts its native algorithm without closing the owner',async()=>{
  let pending
  class PendingAudio extends Audio{
    play(){pending=deferred();return pending.promise}
    load(){super.load();if(pending){pending.reject(Object.assign(new Error('native abort'),{name:'AbortError'}));pending=null}}
  }
  const f=await fixture({AudioClass:PendingAudio}),callId=f.call('play');await f.services.drain();await turn();assert(pending)
  f.runtime.requests.push({kind:'cancel',callId});await f.flush();assert.equal(pending,null);assert.equal(f.elements[0].loads,1)
  assert.equal(f.runtime.completions.length,1);f.call('play');await f.flush();assert.equal(f.runtime.completions.at(-1).error.code,'cancelled');await f.services.close()
})

test('a cancellation queued after native source success wins before the completion is delivered',async()=>{
  const f=await fixture({fetch:async()=>new Response('audio')}),callId=f.call('src',{action:'set',value:'https://host.test/clip.mp3'})
  await f.services.drain();await turn();const url=f.elements.at(-1).src;assert.match(url,/^blob:/)
  f.runtime.requests.push({kind:'cancel',callId});await f.flush();assert(!f.runtime.completions.some(value=>value.callId===callId));await assert.rejects(fetch(url));await f.services.close()
})

test('a guest completion callback cancelling another completed call still retires its exact decoder',async()=>{
  const f=await fixture({fetch:async()=>new Response('audio')})
  const trigger=f.call('volume'),second=f.call('src',{action:'set',value:'https://host.test/clip.mp3'})
  await f.services.drain();await turn();const url=f.elements.at(-1).src
  const complete=f.runtime.complete_host_api_call_json.bind(f.runtime)
  f.runtime.complete_host_api_call_json=(callId,value)=>{const result=complete(callId,value);if(callId===trigger)f.runtime.requests.push({kind:'cancel',callId:second});return result}
  await f.flush();await assert.rejects(fetch(url));assert.equal(f.elements.at(-1).loads,1);await f.services.close()
})

test('empty src clears native selection and never assigns an origin-relative empty URL',async()=>{
  const f=await fixture();f.call('src',{action:'set',value:''});await f.flush()
  assert.equal(f.elements.at(-1).src,undefined);assert.equal(f.elements.at(-1).loads,1);await f.services.close()
})

test('a failed source setter reaches the current audio onError subscription exactly once',async()=>{
  const f=await fixture({fetch:async()=>{throw Object.assign(new Error('native resource failed'),{errCode:811,errMsg:'raw native audio error'})}})
  f.call('onError',{subscriptionId:'audio-errors',action:'subscribe'});await f.flush()
  f.call('src',{action:'set',value:'https://host.test/fail.mp3'});await f.flush()
  assert.equal(f.runtime.events.length,1);assert.equal(f.runtime.events[0].event,'Error');assert.equal(f.runtime.events[0].value.errCode,811);assert.equal(f.runtime.events[0].value.errMsg,'raw native audio error')
  f.elements.at(-1).dispatchEvent(new Event('error'));await f.flush();assert.equal(f.runtime.events.length,1);await f.services.close()
})
