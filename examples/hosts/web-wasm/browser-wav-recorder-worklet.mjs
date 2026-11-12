// Trusted static AudioWorklet. Audio messages have four credits; a stalled
// consumer terminates recording instead of dropping samples or growing queues.
registerProcessor('weapp-private-wav-v1',class extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const value=options.processorOptions
    if(![1,2].includes(value.channels)||!Number.isSafeInteger(value.maxBytes)||value.maxBytes<=0||value.maxBytes>32*1024*1024-44||!Number.isSafeInteger(value.maxFrames)||value.maxFrames<=0)throw new Error('invalid private WAV processor bounds')
    this.channels=value.channels;this.maxBytes=value.maxBytes;this.maxFrames=value.maxFrames
    this.state='inactive';this.frames=0;this.bytes=0;this.sequence=0;this.pending=new Set();this.buffer=null;this.offset=0;this.done=false
    this.port.onmessage=event=>{
      const message=event.data
      if(message?.kind==='ack'){this.pending.delete(message.sequence);return}
      if(this.done)return
      const action=message?.action,id=message?.id
      if(!Number.isSafeInteger(id)||id<=0||!['start','pause','resume','stop'].includes(action)){this.fail('invalid recorder command');return}
      if(action==='start'&&this.state==='inactive'){this.state='recording';this.port.postMessage({kind:'state',action,id});return}
      if(action==='pause'&&this.state==='recording'){if(!this.flush())return;this.state='paused';this.port.postMessage({kind:'state',action,id});return}
      if(action==='resume'&&this.state==='paused'){this.state='recording';this.port.postMessage({kind:'state',action,id});return}
      if(action==='stop'){this.finish(id);return}
      this.fail('invalid recorder state transition')
    }
  }
  fail(message){if(this.done)return;this.done=true;this.state='inactive';this.buffer=null;this.offset=0;this.port.postMessage({kind:'error',message,frames:this.frames})}
  flush(){
    if(!this.offset)return true
    if(this.pending.size>=4){this.fail('PCM consumer backpressure exceeded four chunks');return false}
    const bytes=this.offset*this.channels*2,buffer=this.buffer.slice(0,bytes),sequence=++this.sequence
    this.pending.add(sequence);this.port.postMessage({kind:'pcm',sequence,buffer},[buffer]);this.buffer=null;this.offset=0;return true
  }
  finish(id=null){if(!this.flush())return;this.done=true;this.state='inactive';this.port.postMessage({kind:'stop',id,frames:this.frames,bytes:this.bytes})}
  process(inputs) {
    if(this.done)return false
    if(this.state!=='recording')return true
    const channels=inputs[0]
    if(!channels?.length||!channels[0]?.length)return true
    if(channels.length!==this.channels||channels.some(channel=>channel.length!==channels[0].length)){this.fail('PCM input channel count changed');return false}
    for(let frame=0;frame<channels[0].length;frame++){
      if(this.frames>=this.maxFrames){this.finish();return false}
      if(this.bytes+this.channels*2>this.maxBytes){this.fail('PCM recording byte budget exceeded');return false}
      if(!this.buffer){this.buffer=new ArrayBuffer(2048*this.channels*2);this.view=new DataView(this.buffer)}
      const view=this.view
      for(let channel=0;channel<this.channels;channel++){
        const sample=channels[channel][frame]
        if(!Number.isFinite(sample)){this.fail('PCM input contained a non-finite sample');return false}
        const value=Math.max(-1,Math.min(1,sample));view.setInt16((this.offset*this.channels+channel)*2,Math.round(value*(value<0?32768:32767)),true)
      }
      this.offset++;this.frames++;this.bytes+=this.channels*2
      if(this.offset===2048&&!this.flush())return false
    }
    return true
  }
})
