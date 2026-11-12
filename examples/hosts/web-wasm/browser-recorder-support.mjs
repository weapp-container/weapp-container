// An encoder's mere constructor is not evidence of a baseline output format.
// Permission/device state is intentionally evaluated by each actual call.
export const RECORDER_MIMES=Object.freeze({mp3:Object.freeze(['audio/mpeg']),aac:Object.freeze(['audio/aac']),wav:Object.freeze(['audio/wav','audio/x-wav'])})
export function recorderSupport(environment,persistentFiles) {
  const formats={}
  if(persistentFiles&&typeof environment.navigator?.mediaDevices?.getUserMedia==='function') {
    const Recorder=environment.MediaRecorder
    if(typeof Recorder==='function'&&typeof Recorder.isTypeSupported==='function')for(const [format,mimes]of Object.entries(RECORDER_MIMES)){
      const mimeType=mimes.find(value=>{try{return Recorder.isTypeSupported(value)===true}catch{return false}})
      if(mimeType)formats[format]=Object.freeze({backend:'media-recorder',mimeType,acceptedMimes:mimes})
    }
    const Context=environment.AudioContext||environment.webkitAudioContext
    if(!formats.wav&&environment.isSecureContext===true&&typeof Context==='function'
      &&typeof environment.AudioWorkletNode==='function'&&'audioWorklet' in Context.prototype
      &&['createMediaStreamSource','createGain','resume','close'].every(name=>typeof Context.prototype[name]==='function')){
      formats.wav=Object.freeze({backend:'wav-worklet',mimeType:'audio/wav',acceptedMimes:RECORDER_MIMES.wav})
    }
  }
  return Object.freeze({formats:Object.freeze(formats),available:Object.keys(formats).length>0})
}
