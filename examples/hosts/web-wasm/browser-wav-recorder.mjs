const check=(value,message)=>{if(!value)throw Object.assign(new Error(message),{code:'unsupported'})}
const retired=()=>Object.assign(new Error('WAV recorder owner retired'),{code:'cancelled'})
export function wavHeader(bytes,sampleRate,channels) {
  const header=new ArrayBuffer(44),view=new DataView(header),text=(offset,value)=>{for(let n=0;n<value.length;n++)view.setUint8(offset+n,value.charCodeAt(n))}
  text(0,'RIFF');view.setUint32(4,bytes+36,true);text(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,bytes,true)
  return header
}

/** One real Web Audio graph; no microphone credentials or guest JS enter its
 * worklet. All output stays private until the complete RIFF file is published.
 */
export class BrowserWavRecorder {
  #environment;#stream;#options;#context=null;#source=null;#node=null;#gain=null
  #revoked=false;#releasing=null;#pending=new Set();#stages=new Map();#chunks=[];#bytes=0;#sequence=0;#command=0;#commands=new Map();#stopped=false;#started=false;#failed=false;#listener=null;#processorError=null;#contextState=null;#detachAbort=null
  state='inactive';mimeType='audio/wav';recordedDurationMs=0
  constructor(environment,stream,options){this.#environment=environment;this.#stream=stream;this.#options=options;this.audioBitsPerSecond=options.sampleRate*options.channels*16}
  async #native(action){const promise=Promise.resolve().then(action);this.#pending.add(promise);try{return await promise}finally{this.#pending.delete(promise)}}
  async #acquire(action,signal){
    const operation=this.#native(action);let cancel
    const aborted=new Promise((resolve,reject)=>{cancel=()=>reject(retired());signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()})
    try{return await Promise.race([operation,aborted])}finally{signal.removeEventListener('abort',cancel)}
  }
  #assert(signal){if(this.#revoked||signal?.aborted)throw retired()}
  async initialize(signal) {
    this.#assert(signal)
    const cancel=()=>{void this.release().catch(()=>{})};signal.addEventListener('abort',cancel,{once:true});this.#detachAbort=()=>signal.removeEventListener('abort',cancel)
    try {
      const Context=this.#environment.AudioContext||this.#environment.webkitAudioContext
      this.#context=new Context({sampleRate:this.#options.sampleRate})
      check(this.#context.sampleRate===this.#options.sampleRate,'AudioContext did not accept the requested PCM sample rate')
      await this.#acquire(()=>this.#context.audioWorklet.addModule(new URL('./browser-wav-recorder-worklet.mjs',import.meta.url).href,{credentials:'omit'}),signal)
      this.#assert(signal)
      this.#source=this.#context.createMediaStreamSource(this.#stream)
      this.#gain=this.#context.createGain();this.#gain.gain.value=0
      this.#node=new this.#environment.AudioWorkletNode(this.#context,'weapp-private-wav-v1',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[this.#options.channels],channelCount:this.#options.channels,channelCountMode:'explicit',channelInterpretation:'discrete',processorOptions:{channels:this.#options.channels,maxBytes:this.#options.maxBytes-44,maxFrames:Math.floor(this.#options.duration*this.#options.sampleRate/1000)}})
      this.#listener=event=>this.#message(event.data);this.#node.port.addEventListener('message',this.#listener);this.#node.port.start()
      this.#processorError=()=>this.#fail(new Error('native WAV AudioWorklet processor failed'));this.#node.addEventListener('processorerror',this.#processorError)
      this.#contextState=()=>{if(this.#started&&!this.#revoked&&!this.#stopped&&this.#context.state!=='running')this.#fail(new Error('native WAV audio context interrupted'))}
      this.#context.addEventListener('statechange',this.#contextState)
      this.#source.connect(this.#node);this.#node.connect(this.#gain);this.#gain.connect(this.#context.destination)
      await this.#acquire(()=>this.#context.resume(),signal);this.#assert(signal);check(this.#context.state==='running','WAV audio context did not start')
    } catch(error){try{await this.release()}catch(cleanup){throw new AggregateError([error,cleanup],'WAV graph acquisition and release failed')}throw error}
    finally{this.#detachAbort?.();this.#detachAbort=null}
  }
  #state(action,state){if(this.#revoked||this.#stopped)throw retired();check(this.#commands.size<4,'WAV native command queue exceeded four receipts');const id=++this.#command;this.#commands.set(id,action);this.state=state;try{this.#node.port.postMessage({kind:'command',action,id})}catch(error){this.#commands.delete(id);this.#fail(error);throw error}}
  start(){this.#started=true;this.#state('start','recording')}
  pause(){this.#state('pause','paused')}
  resume(){this.#state('resume','recording')}
  stop(){this.#state('stop','inactive')}
  #fail(error){if(this.#failed||this.#stopped||this.#revoked)return;this.#failed=true;this.state='inactive';this.onerror?.({error});this.#finish(false)}
  #message(message) {
    if(this.#revoked||this.#stopped)return
    try {
      if(message?.kind==='pcm'){
        check(Number.isSafeInteger(message.sequence)&&message.sequence===this.#sequence+1&&message.buffer instanceof ArrayBuffer&&message.buffer.byteLength>0&&message.buffer.byteLength<=2048*this.#options.channels*2&&message.buffer.byteLength%(this.#options.channels*2)===0,'invalid native PCM chunk')
        check(message.buffer.byteLength<=this.#options.maxBytes-44-this.#bytes,'native WAV byte limit exceeded')
        this.#sequence=message.sequence;this.#chunks.push(message.buffer);this.#bytes+=message.buffer.byteLength;this.#node.port.postMessage({kind:'ack',sequence:message.sequence});return
      }
      if(message?.kind==='state'){
        check(['start','pause','resume'].includes(message.action)&&this.#commands.get(message.id)===message.action,'invalid native WAV state receipt')
        this.#commands.delete(message.id);this['on'+message.action]?.();return
      }
      if(message?.kind==='error'){this.#fail(new Error(message.message||'native PCM producer failed'));return}
      check(message?.kind==='stop'&&(message.id===null||this.#commands.get(message.id)==='stop')&&message.bytes===this.#bytes&&message.frames*this.#options.channels*2===this.#bytes,'native WAV final byte count mismatch')
      if(message.id!==null)this.#commands.delete(message.id)
      this.#finish(true)
    }catch(error){this.#fail(error)}
  }
  #finish(success) {
    if(this.#stopped)return
    this.#stopped=true;this.state='inactive';this.recordedDurationMs=this.#bytes/(this.#options.sampleRate*this.#options.channels*2)*1000
    if(success&&!this.#failed&&this.#bytes>0){const BlobType=this.#environment.Blob||Blob;this.ondataavailable?.({data:new BlobType([wavHeader(this.#bytes,this.#options.sampleRate,this.#options.channels),...this.#chunks],{type:'audio/wav'})})}
    else if(success&&!this.#failed){this.#failed=true;this.onerror?.({error:new Error('native WAV recorder produced no PCM samples')})}
    this.#chunks=[];this.onstop?.()
  }
  release=()=>{
    this.#revoked=true;this.state='inactive';this.#chunks=[];this.#commands.clear()
    if(this.#releasing)return this.#releasing
    const stage=async(name,action)=>{if(this.#stages.get(name))return;await action();this.#stages.set(name,true)}
    const operation=(async()=>{
      const errors=[],run=async(name,action)=>{try{await stage(name,action)}catch(error){errors.push(error)}}
      // Close the graph before waiting for addModule/resume: a pending native
      // resume can otherwise wait indefinitely for user activation at logout.
      await run('source',()=>this.#source?.disconnect());await run('node',()=>this.#node?.disconnect());await run('gain',()=>this.#gain?.disconnect())
      await run('port-listener',()=>{if(this.#node&&this.#listener)this.#node.port.removeEventListener('message',this.#listener)})
      await run('processor-listener',()=>{if(this.#node&&this.#processorError)this.#node.removeEventListener('processorerror',this.#processorError)})
      await run('context-listener',()=>{if(this.#context&&this.#contextState)this.#context.removeEventListener('statechange',this.#contextState)})
      await run('port',()=>this.#node?.port.close())
      await run('context',async()=>{if(this.#context&&this.#context.state!=='closed')await this.#native(()=>this.#context.close())})
      // A failed close retains the graph and actual native promises for an
      // explicit retry; do not deadlock the first failed owner retirement.
      if(!errors.length)while(this.#pending.size)await Promise.allSettled([...this.#pending])
      await run('abort',()=>this.#detachAbort?.())
      if(errors.length)throw new AggregateError(errors,'WAV exact native releases failed; retry close')
    })()
    this.#releasing=operation.finally(()=>{this.#releasing=null});this.#releasing.catch(()=>{});return this.#releasing
  }
}
