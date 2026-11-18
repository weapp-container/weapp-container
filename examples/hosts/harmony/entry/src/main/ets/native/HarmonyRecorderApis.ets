import common from '@ohos.app.ability.common';
import abilityAccessCtrl from '@ohos.abilityAccessCtrl';
import media from '@ohos.multimedia.media';
import fs from '@ohos.file.fs';
import util from '@ohos.util';
import systemDateTime from '@ohos.systemDateTime';
import promptAction from '@ohos.promptAction';
import { BusinessError } from '@ohos.base';
import { HarmonyHostServices, HarmonyApiCall, HarmonyApiError } from '../session/HostServices';
import { HarmonyManagedFiles } from './HarmonyManagedFiles';

interface RecorderOptions {
  objectId?: string; subscriptionId?: string; action?: string;
  duration?: number; sampleRate?: number; numberOfChannels?: number; encodeBitRate?: number;
  format?: string; audioSource?: string; audioMode?: string; frameSize?: number;
}
interface RecorderEncoding {
  duration: number; rate: number; channels: number; bitrate: number; extension: string;
  codec: media.CodecMimeType; container: media.ContainerFormatType;
}
interface RecorderResult { objectId?: string; errMsg?: string; tempFilePath?: string; duration?: number; fileSize?: number; errCode?: number; }
interface RecorderScope { auxiliaryRoot: string; }
interface RecorderSubscription { call: HarmonyApiCall; objectId: string; event: string; sequence: number; }
interface PendingRecording { call: HarmonyApiCall; objectId: string; generation: number; recording: NativeRecording | null; }
interface NativeRecording {
  objectId: string; owner: HarmonyApiCall; generation: number; native: media.AVRecorder | null;
  path: string; file: fs.File | null; removed: boolean; extension: string; durationLimit: number;
  queue: Promise<void>; retirement: Promise<void> | null; stop: Promise<void> | null; stopError: HarmonyApiError | null; release: Promise<void> | null; released: boolean;
  retiring: boolean; discard: boolean; published: boolean; errorPublished: boolean; stopRequested: boolean;
  elapsed: number; segmentStarted: number | null; phase: media.AVRecorderState;
  timer: number | null; importedPath: string | null; importedReady: boolean; outputSize: number;
  stateListener: (state: media.AVRecorderState, reason: media.StateChangeReason) => void;
  errorListener: (error: BusinessError) => void;
}

/** Real API24 AVRecorder. Every native resource stays in its exact account
 * owner until native release, operation drain and staging-file cleanup finish. */
export class HarmonyRecorderApis {
  private readonly context: common.UIAbilityContext;
  private readonly services: HarmonyHostServices;
  private readonly files: HarmonyManagedFiles;
  private readonly objects: Map<string,HarmonyApiCall> = new Map();
  private readonly subscriptions: Map<string,RecorderSubscription> = new Map();
  private readonly backgroundDrains: Set<Promise<void>> = new Set();
  private active: NativeRecording | null = null;
  private pending: PendingRecording | null = null;
  private closed: boolean = false;
  private foreground: boolean = true;
  private generation: number = 0;
  private readonly byteLimit: number = 4*1048576;
  readonly supportedApis: Array<string> = [
    'wx.getRecorderManager','object:RecorderManager.start','object:RecorderManager.stop',
    'object:RecorderManager.pause','object:RecorderManager.resume',
    'object:RecorderManager.onStart','object:RecorderManager.onStop','object:RecorderManager.onPause',
    'object:RecorderManager.onResume','object:RecorderManager.onError','object:RecorderManager.onInterruptionBegin',
  ];
  constructor(context: common.UIAbilityContext, services: HarmonyHostServices, files: HarmonyManagedFiles) {
    this.context=context;this.services=services;this.files=files;
    if(!canIUse('SystemCapability.Multimedia.Media.AVRecorder'))return;
    for(const api of this.supportedApis)services.registerApiHandler(api,async(payload:Object,call:HarmonyApiCall):Promise<Object>=>{
      const options=payload as RecorderOptions;
      try{return await this.invoke(api,options,call);}
      catch(error){
        const failure=this.error(error as Error,api);
        throw failure;
      }
    });
    services.onForeground((visible:boolean):void=>{
      this.foreground=visible;
      if(!visible){this.generation++;this.pending=null;if(this.active!==null)this.background(this.retire(this.active,false));}
    });
    services.onClose(():Promise<void>=>this.close());
  }
  private now():number{return systemDateTime.getUptime(systemDateTime.TimeType.ACTIVE);}
  private fail(message:string,category:string='invalid_request',code:number=-1):HarmonyApiError{return new HarmonyApiError(category,message,code,`RecorderManager:fail ${message}`);}
  private error(error:Error,api:string):HarmonyApiError{
    if(error instanceof HarmonyApiError)return error;
    const native=error as BusinessError;
    return new HarmonyApiError(native.code===201||native.code===202?'permission_denied':native.code===801||native.code===5400106?'unsupported':'invalid_request',native.message,native.code,`${api.split('.').pop()}:fail ${native.message}`);
  }
  private ok(api:string,objectId?:string):RecorderResult{const value:RecorderResult={errMsg:`${api.split('.').pop()}:ok`};if(objectId!==undefined)value.objectId=objectId;return value;}
  private sameOwner(first:HarmonyApiCall,second:HarmonyApiCall):boolean{
    const a=first.context.application,b=second.context.application;
    return first.context.sessionId===second.context.sessionId&&a.hostAppId===b.hostAppId&&a.tenantId===b.tenantId&&a.publisherId===b.publisherId&&a.appId===b.appId&&a.environment===b.environment&&a.version===b.version&&a.packRoot===b.packRoot&&first.context.account.principalId===second.context.account.principalId&&first.context.account.epoch===second.context.account.epoch;
  }
  private current(call:HarmonyApiCall,generation:number=this.generation):void{
    if(this.closed||!this.foreground||call.cancellation.cancelled||generation!==this.generation)throw this.fail('recording execution owner retired','cancelled');
  }
  private permitted():void{
    if(abilityAccessCtrl.createAtManager().getSelfPermissionStatus('ohos.permission.MICROPHONE')!==abilityAccessCtrl.PermissionStatus.GRANTED)throw this.fail('microphone permission revoked','permission_denied',201);
  }
  private recordingCurrent(recording:NativeRecording,call:HarmonyApiCall):void{
    this.current(call,recording.generation);this.current(recording.owner,recording.generation);this.permitted();
    if(this.active!==recording||recording.retiring||!this.sameOwner(recording.owner,call))throw this.fail('recorder incarnation retired','cancelled');
  }
  private async invoke(api:string,options:RecorderOptions,call:HarmonyApiCall):Promise<Object>{
    this.current(call);
    const id=options.objectId;
    if(typeof id!=='string'||id.length===0||id.length>256)throw this.fail('runtime recorder objectId required');
    if(api==='wx.getRecorderManager'){
      if(this.objects.size>=16||this.objects.has(id))throw this.fail('recorder object limit or duplicate');
      this.objects.set(id,call);call.cancellation.retainUntilCancelled();
      call.cancellation.onCancel(():void|Promise<void>=>{
        this.objects.delete(id);
        for(const entry of this.subscriptions)if(entry[1].objectId===id)this.subscriptions.delete(entry[0]);
        if(this.pending?.objectId===id)this.pending=null;
        if(this.active?.objectId===id)return this.retire(this.active,false);
      });
      return this.ok(api,id);
    }
    const owner=this.objects.get(id);
    if(owner===undefined||owner.cancellation.cancelled||!this.sameOwner(owner,call))throw this.fail('recorder belongs to a retired owner','cancelled');
    if(api.startsWith('object:RecorderManager.on')){
      const subscription=options.subscriptionId;
      if(typeof subscription!=='string'||subscription.length===0)throw this.fail('runtime subscriptionId required');
      if(options.action==='unsubscribe')this.subscriptions.delete(subscription);
      else{
        if(this.subscriptions.size>=128||this.subscriptions.has(subscription))throw this.fail('recorder subscription limit or duplicate');
        this.subscriptions.set(subscription,{call,objectId:id,event:api.substring('object:RecorderManager.on'.length),sequence:0});
        call.cancellation.retainUntilCancelled();call.cancellation.onCancel(():void=>{this.subscriptions.delete(subscription);});
      }
      return this.ok(api);
    }
    if(api==='object:RecorderManager.start'){await this.start(id,owner,options,call);return this.ok(api);}
    const recording=this.active;
    if(recording===null||recording.objectId!==id||!this.sameOwner(recording.owner,call))throw this.fail('recorder is not active');
    call.cancellation.onCancel(():Promise<void>=>this.retire(recording,false));
    if(api==='object:RecorderManager.stop'){await this.retire(recording,true);return this.ok(api);}
    const operation=recording.queue.then(async():Promise<void>=>{
      this.recordingCurrent(recording,call);const native=recording.native!;
      if(api==='object:RecorderManager.pause'){
        if(native.state!=='started')throw this.fail('recorder is not recording');
        await native.pause();
      }else{
        if(native.state!=='paused')throw this.fail('recorder is not paused');
        await native.resume();
      }
      this.recordingCurrent(recording,call);
    });
    recording.queue=operation.then(():void=>{},():void=>{});
    try{await operation;}catch(error){if(call.cancellation.cancelled||!this.foreground||recording.generation!==this.generation)await this.retire(recording,false);throw error as Error;}
    return this.ok(api);
  }
  private encoding(options:RecorderOptions):RecorderEncoding{
    if(options.frameSize!==undefined)throw this.fail('AVRecorder does not expose frame recording','unsupported',801);
    if(options.audioSource!==undefined&&options.audioSource!=='auto')throw this.fail('only the system-routed auto microphone source is installed','unsupported',801);
    if(options.audioMode!==undefined&&options.audioMode!=='default')throw this.fail('only the default audio processing mode is installed','unsupported',801);
    const format=options.format||'aac';
    if(format!=='aac'&&format!=='mp3')throw this.fail('only capability-checked AAC ADTS and MP3 encoders are installed','unsupported',801);
    const duration=options.duration===undefined?60000:options.duration,rate=options.sampleRate===undefined?8000:options.sampleRate,channels=options.numberOfChannels===undefined?2:options.numberOfChannels,bitrate=options.encodeBitRate===undefined?48000:options.encodeBitRate;
    if(!Number.isInteger(duration)||duration<1||duration>600000||![8000,11025,12000,16000,22050,24000,32000,44100,48000].includes(rate)||![1,2].includes(channels)||!Number.isInteger(bitrate)||bitrate<16000||bitrate>320000)throw this.fail('recording options exceed the baseline bounds');
    const ranges:Record<string,Array<number>>={'8000':[16000,48000],'11025':[16000,48000],'12000':[24000,64000],'16000':[24000,96000],'22050':[32000,128000],'24000':[32000,128000],'32000':[48000,192000],'44100':[64000,320000],'48000':[64000,320000]};
    const range=ranges[String(rate)];if(bitrate<range[0]||bitrate>range[1])throw this.fail('bitrate is outside the baseline range for this sample rate');
    return {duration,rate,channels,bitrate,extension:format,codec:format==='aac'?media.CodecMimeType.AUDIO_AAC:media.CodecMimeType.AUDIO_MP3,container:format==='aac'?media.ContainerFormatType.CFT_AAC:media.ContainerFormatType.CFT_MP3};
  }
  private async start(id:string,owner:HarmonyApiCall,options:RecorderOptions,call:HarmonyApiCall):Promise<void>{
    if(this.active!==null||this.pending!==null)throw this.fail('recorder is active, starting or awaiting cleanup');
    const encoding=this.encoding(options),pending:PendingRecording={call,objectId:id,generation:this.generation,recording:null};this.pending=pending;
    call.cancellation.onCancel(():void|Promise<void>=>{if(this.pending===pending)this.pending=null;if(pending.recording!==null)return this.retire(pending.recording,false);});
    try{
      const app=call.context.application;
      const consent=await promptAction.showDialog({title:'麦克风授权',message:`${app.appId}（${app.publisherId}）申请使用麦克风录音。录音仅属于当前账号和小程序，离开前台即停止。`,buttons:[{text:'允许',color:'#1677ff'},{text:'拒绝',color:'#666666'}]});
      this.pendingCurrent(pending,owner);if(consent.index!==0)throw this.fail('application microphone consent denied','permission_denied',201);
      const permission=await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(this.context,['ohos.permission.MICROPHONE']);
      this.pendingCurrent(pending,owner);if(permission.authResults.length!==1||permission.authResults[0]!==0)throw this.fail('OS microphone permission denied','permission_denied',201);this.permitted();
      const scope=this.services.managedFileScope(owner.context) as RecorderScope;
      if(typeof scope.auxiliaryRoot!=='string'||!scope.auxiliaryRoot.startsWith('/')||scope.auxiliaryRoot.includes('\0'))throw this.fail('trusted managed staging directory required');
      const recording:NativeRecording={objectId:id,owner,generation:pending.generation,native:null,path:`${scope.auxiliaryRoot}/recording-${util.generateRandomUUID()}.${encoding.extension}`,file:null,removed:false,extension:encoding.extension,durationLimit:encoding.duration,queue:Promise.resolve(),retirement:null,stop:null,stopError:null,release:null,released:false,retiring:false,discard:false,published:false,errorPublished:false,stopRequested:false,elapsed:0,segmentStarted:null,phase:'idle',timer:null,importedPath:null,importedReady:false,outputSize:0,stateListener:():void=>{},errorListener:():void=>{}};
      pending.recording=recording;this.active=recording;
      const startup=this.startNative(recording,encoding,call);recording.queue=startup.then(():void=>{},():void=>{});
      await startup;
    }catch(error){
      const failure=this.error(error as Error,'RecorderManager.start');
      if(failure.category!=='cancelled')this.emitError(id,failure,pending.recording===null?undefined:pending.recording);
      if(pending.recording!==null)await this.retire(pending.recording,false);
      throw failure;
    }finally{if(this.pending===pending)this.pending=null;}
  }
  private pendingCurrent(pending:PendingRecording,owner:HarmonyApiCall):void{
    this.current(pending.call,pending.generation);this.current(owner,pending.generation);
    if(this.pending!==pending||this.objects.get(pending.objectId)!==owner)throw this.fail('pending recording owner retired','cancelled');
  }
  private async startNative(recording:NativeRecording,encoding:RecorderEncoding,call:HarmonyApiCall):Promise<void>{
    const native=await media.createAVRecorder();recording.native=native;this.recordingCurrent(recording,call);
    recording.stateListener=(state:media.AVRecorderState,reason:media.StateChangeReason):void=>{
      try{this.stateChanged(recording,state,reason);}catch(error){this.emitError(recording.objectId,this.error(error as Error,'RecorderManager'),recording);this.background(this.retire(recording,false));}
    };
    recording.errorListener=(error:BusinessError):void=>{
      if(!this.canPublish(recording))return;
      if(error.code===5400107)this.emit(recording.objectId,'InterruptionBegin',{},recording);
      this.emitError(recording.objectId,this.error(error,'RecorderManager'),recording);
      this.background(this.retire(recording,false));
    };
    native.on('stateChange',recording.stateListener);native.on('error',recording.errorListener);
    const encoders=await native.getAvailableEncoder();this.recordingCurrent(recording,call);
    if(!encoders.some((encoder:media.EncoderInfo):boolean=>encoder.mimeType===encoding.codec&&(encoder.sampleRate===undefined||encoder.sampleRate.includes(encoding.rate))&&(encoder.channels===undefined||encoding.channels>=encoder.channels.min&&encoding.channels<=encoder.channels.max)&&(encoder.bitRate===undefined||encoding.bitrate>=encoder.bitRate.min&&encoding.bitrate<=encoder.bitRate.max)))throw this.fail('requested encoder, sample rate, channels or bitrate is unavailable','unsupported',801);
    recording.file=fs.openSync(recording.path,fs.OpenMode.READ_WRITE|fs.OpenMode.CREATE|fs.OpenMode.TRUNC|fs.OpenMode.NOFOLLOW);
    await native.setWillMuteWhenInterrupted(false);this.recordingCurrent(recording,call);
    const profile:media.AVRecorderProfile={audioBitrate:encoding.bitrate,audioChannels:encoding.channels,audioCodec:encoding.codec,audioSampleRate:encoding.rate,fileFormat:encoding.container};
    await native.prepare({audioSourceType:media.AudioSourceType.AUDIO_SOURCE_TYPE_DEFAULT,profile,url:`fd://${recording.file.fd}`,maxDuration:Math.max(1,Math.ceil(encoding.duration/1000))});this.recordingCurrent(recording,call);
    await native.start();this.recordingCurrent(recording,call);
    if(native.state!=='started')throw this.fail('native recorder did not enter started state');
    if(recording.segmentStarted===null)recording.segmentStarted=this.now();
    recording.timer=setInterval(():void=>this.tick(recording),100);
  }
  private stateChanged(recording:NativeRecording,state:media.AVRecorderState,reason:media.StateChangeReason):void{
    if(this.active!==recording)return;
    const previous=recording.phase;recording.phase=state;
    if(state==='paused'||state==='stopped'||state==='error'||state==='released')this.endSegment(recording);
    if(recording.retiring||!this.canPublish(recording))return;
    try{this.permitted();}catch(error){this.emitError(recording.objectId,error as HarmonyApiError,recording);this.background(this.retire(recording,false));return;}
    if(state==='started'){
      if(recording.segmentStarted===null)recording.segmentStarted=this.now();
      if(previous==='paused')this.emit(recording.objectId,'Resume',{},recording);else if(previous!=='started')this.emit(recording.objectId,'Start',{},recording);
    }else if(state==='paused'&&previous!=='paused')this.emit(recording.objectId,'Pause',{},recording);
    else if(state==='stopped'&&!recording.stopRequested)this.background(this.retire(recording,true));
    else if(state==='error')this.background(this.retire(recording,false));
  }
  private endSegment(recording:NativeRecording):void{if(recording.segmentStarted!==null){recording.elapsed+=Math.max(0,this.now()-recording.segmentStarted);recording.segmentStarted=null;}}
  private tick(recording:NativeRecording):void{
    if(this.active!==recording||recording.retiring)return;
    try{
      this.recordingCurrent(recording,recording.owner);
      const elapsed=recording.elapsed+(recording.segmentStarted===null?0:Math.max(0,this.now()-recording.segmentStarted));
      const size=recording.file===null?0:fs.statSync(recording.file.fd).size;
      if(size>this.byteLimit){this.emitError(recording.objectId,this.fail('recording exceeds four MiB'),recording);this.background(this.retire(recording,false));}
      else if(elapsed>=recording.durationLimit)this.background(this.retire(recording,true));
    }catch(error){this.emitError(recording.objectId,this.error(error as Error,'RecorderManager'),recording);this.background(this.retire(recording,false));}
  }
  private canPublish(recording:NativeRecording):boolean{return this.active===recording&&!this.closed&&this.foreground&&recording.generation===this.generation&&!recording.owner.cancellation.cancelled&&this.objects.get(recording.objectId)===recording.owner;}
  private emit(objectId:string,event:string,value:RecorderResult={},producer?:NativeRecording):void{
    if(this.closed||!this.foreground)return;
    for(const entry of this.subscriptions){const subscription=entry[1];if(subscription.objectId!==objectId||subscription.event!==event||subscription.call.cancellation.cancelled)continue;
      subscription.sequence++;
      if(!this.services.emit(subscription.call.context,entry[0],subscription.sequence,event,value,objectId)){
        const recording=producer||this.active;if(recording!==null&&recording.objectId===objectId)this.background(this.retire(recording,false));return;
      }
    }
  }
  private emitError(objectId:string,error:HarmonyApiError,recording?:NativeRecording):void{
    if(recording!==undefined){if(recording.errorPublished||!this.canPublish(recording))return;recording.errorPublished=true;}
    this.emit(objectId,'Error',{errMsg:error.errMsg,errCode:error.errCode},recording);
  }
  private bounded(task:Promise<void>,message:string):Promise<void>{return new Promise<void>((resolve,reject):void=>{const timer=setTimeout(():void=>reject(this.fail(message,'timeout')),5000);task.then(():void=>{clearTimeout(timer);resolve();},(error:Error):void=>{clearTimeout(timer);reject(error);});});}
  private async retire(recording:NativeRecording,publish:boolean):Promise<void>{
    if(!publish)recording.discard=true;
    recording.retiring=true;if(recording.timer!==null){clearInterval(recording.timer);recording.timer=null;}
    if(recording.retirement!==null)return recording.retirement;
    const task=(async():Promise<void>=>{
      await this.bounded(recording.queue,'native recorder operation has not drained; retry cleanup');
      const native=recording.native;
      if(native!==null&&!recording.released){
        if(!recording.discard&&(native.state==='started'||native.state==='paused')){
          recording.stopRequested=true;
          if(recording.stop===null)recording.stop=Promise.resolve().then(():Promise<void>=>native.stop()).catch((error:Error):void=>{recording.discard=true;recording.stopError=this.error(error,'RecorderManager.stop');});
          await this.bounded(recording.stop,'native recorder stop has not drained; retry cleanup');
        }
        // A cancelled stop still has to settle before release; cancellation
        // cannot turn an outstanding platform operation into a drained one.
        if(recording.stop!==null)await this.bounded(recording.stop,'native recorder stop has not drained; retry cleanup');
        try{this.endSegment(recording);}catch(error){recording.discard=true;recording.stopError=this.error(error as Error,'RecorderManager.stop');}
        if(recording.release===null){
          const release=Promise.resolve().then(():Promise<void>=>native.release()).then(():void=>{recording.released=true;});
          recording.release=release;release.catch(():void=>{if(recording.release===release)recording.release=null;});
        }
        await this.bounded(recording.release,'native recorder release has not drained; retry cleanup');
        try{native.off('stateChange',recording.stateListener);}catch{}
        try{native.off('error',recording.errorListener);}catch{}
      }
      if(!recording.discard&&!recording.published&&this.canPublish(recording)){
        this.permitted();
        if(!recording.importedReady){
          if(recording.file===null)throw this.fail('native recording staging file is missing');
          fs.fsyncSync(recording.file.fd);const stat=fs.statSync(recording.file.fd);
          if(!stat.isFile()||stat.size<=0||stat.size>this.byteLimit)throw this.fail('native recording output is empty or exceeds four MiB');
          const bytes=new Uint8Array(stat.size);let offset=0;
          while(offset<stat.size){const chunk=new ArrayBuffer(Math.min(1048576,stat.size-offset)),count=fs.readSync(recording.file.fd,chunk,{offset,length:chunk.byteLength});if(count<=0)throw this.fail('native recording output ended before its declared length');bytes.set(new Uint8Array(chunk,0,count),offset);offset+=count;}
          if(recording.importedPath===null)recording.importedPath=`wxfile://user/recording-${util.generateRandomUUID()}.${recording.extension}`;
          this.files.writeTemporary(bytes,recording.owner,recording.importedPath);recording.importedReady=true;recording.outputSize=stat.size;
        }
      }
      if(recording.file!==null){fs.closeSync(recording.file);recording.file=null;}
      if(!recording.removed){if(fs.accessSync(recording.path))fs.unlinkSync(recording.path);recording.removed=true;}
      if(recording.importedReady&&!recording.discard&&!recording.published&&this.canPublish(recording)){
        this.emit(recording.objectId,'Stop',{tempFilePath:recording.importedPath!,duration:Math.round(recording.elapsed),fileSize:recording.outputSize},recording);recording.published=true;
      }
      if(this.active===recording)this.active=null;
      if(recording.stopError!==null)throw recording.stopError;
    })();
    recording.retirement=task;
    try{await task;}finally{recording.retirement=null;}
  }
  private background(task:Promise<void>):void{const tracked=task.catch((error:Object):void=>{console.error(`WEAPP_CONTAINER_RECORDER_CLEANUP ${String(error)}`);}).then(():void=>{this.backgroundDrains.delete(tracked);});this.backgroundDrains.add(tracked);}
  async close():Promise<void>{this.closed=true;this.foreground=false;this.generation++;this.pending=null;if(this.active!==null)await this.retire(this.active,false);await Promise.all(Array.from(this.backgroundDrains));this.objects.clear();this.subscriptions.clear();}
}
