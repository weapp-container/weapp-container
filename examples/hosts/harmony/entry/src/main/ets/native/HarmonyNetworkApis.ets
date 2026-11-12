import http from '@ohos.net.http';
import url from '@ohos.url';
import util from '@ohos.util';
import { BusinessError } from '@ohos.base';
import { HarmonyHostServices, HarmonyApiCall, HarmonyApiError } from '../session/HostServices';
import { HarmonyManagedFiles } from './HarmonyManagedFiles';

interface NetworkOptions {
  url?: string; method?: string; data?: Object | string; header?: Record<string,string>;
  timeout?: number; responseType?: string; dataType?: string; objectId?: string;
  subscriptionId?: string; action?: string; filePath?: string; name?: string; formData?: Record<string,string>;
}
interface BinaryBytes { type:string;bytes:Array<number>; }
interface BinaryValue { __weappBinary:BinaryBytes; }
interface NetworkResult { errMsg:string;statusCode?:number;header?:Object;data?:Object|string;tempFilePath?:string;filePath?:string; }
interface NetworkEvent { header?:Object;totalBytesWritten?:number;totalBytesExpectedToWrite?:number;totalBytesSent?:number;totalBytesExpectedToSend?:number;progress?:number;data?:Object; }
interface NativeNetworkTask { request:http.HttpRequest;abort:(reason:HarmonyApiError)=>void; }
interface NetworkSubscription { call:HarmonyApiCall;id:string;object:string;event:string;sequence:number; }

/** Isolated API24 HTTP requests. Origins are host policy; redirects and shared
 * response caching are disabled. No host bearer or cookie store is installed.
 */
export class HarmonyNetworkApis {
  private readonly services:HarmonyHostServices;
  private readonly files:HarmonyManagedFiles;
  private readonly origins:Set<string> = new Set();
  private readonly tasks:Map<string,NativeNetworkTask> = new Map();
  private readonly subscriptions:Map<string,NetworkSubscription> = new Map();
  readonly supportedApis:Array<string> = [
    'wx.request','wx.downloadFile','wx.uploadFile',
    'object:RequestTask.abort','object:DownloadTask.abort','object:UploadTask.abort',
    'object:RequestTask.onHeadersReceived','object:RequestTask.offHeadersReceived',
    'object:RequestTask.onChunkReceived','object:RequestTask.offChunkReceived',
    'object:DownloadTask.onHeadersReceived','object:DownloadTask.offHeadersReceived',
    'object:DownloadTask.onProgressUpdate','object:DownloadTask.offProgressUpdate',
    'object:UploadTask.onHeadersReceived','object:UploadTask.offHeadersReceived',
    'object:UploadTask.onProgressUpdate','object:UploadTask.offProgressUpdate',
  ];
  constructor(services:HarmonyHostServices,files:HarmonyManagedFiles,allowedOrigins:Array<string>=[]) {
    this.services=services;this.files=files;
    if(allowedOrigins.length>128)throw new HarmonyApiError('invalid_request','network origin limit');
    for(const origin of allowedOrigins){const parsed=new url.URL(origin);if(parsed.protocol!=='https:'||parsed.origin!==origin||parsed.username||parsed.password)throw new HarmonyApiError('invalid_request','configure exact HTTPS origins');this.origins.add(origin);}
    for(const api of this.supportedApis)services.registerApiHandler(api,async(payload:Object,call:HarmonyApiCall):Promise<Object>=>{
      try{return await this.invoke(api,payload as NetworkOptions,call);}
      catch(error){if(error instanceof HarmonyApiError)throw error;const native=error as BusinessError;throw new HarmonyApiError('invalid_request',native.message,native.code,`${api.replace(/^wx\./,'')}:fail ${native.message}`);}
    });
    services.onClose(()=>{const failures:Array<Error>=[];for(const task of this.tasks.values()){try{task.abort(new HarmonyApiError('cancelled','native HTTP owner closed'));}catch(error){failures.push(error as Error);}}this.tasks.clear();this.subscriptions.clear();if(failures.length)throw new Error(`${failures.length} native HTTP resources failed to stop`);});
  }
  private current(call:HarmonyApiCall):void {if(call.cancellation.cancelled)throw new HarmonyApiError('cancelled','network owner retired');}
  private ok(api:string):NetworkResult{return {errMsg:`${api.replace(/^wx\./,'')}:ok`};}
  private binary(bytes:Uint8Array):BinaryValue {const values:Array<number>=[];for(const value of bytes)values.push(value);return {__weappBinary:{type:'ArrayBuffer',bytes:values}};}
  private emit(object:string,event:string,value:NetworkEvent):void {
    for(const subscription of this.subscriptions.values())if(subscription.object===object&&subscription.event===event&&!subscription.call.cancellation.cancelled){
      if(!this.services.emit(subscription.call.context,subscription.id,++subscription.sequence,event,value,object)){this.tasks.get(object)?.abort(new HarmonyApiError('cancelled','network event queue rejected the producer'));this.tasks.delete(object);}
    }
  }
  private async invoke(api:string,options:NetworkOptions,call:HarmonyApiCall):Promise<Object> {
    this.current(call);
    if(api.startsWith('object:')) {
      const object=options.objectId;if(typeof object!=='string')throw new HarmonyApiError('invalid_request','task object identity required');
      if(api.endsWith('.abort')){this.tasks.get(object)?.abort(new HarmonyApiError('cancelled','native HTTP request aborted'));this.tasks.delete(object);return this.ok(api);}
      const subscription=options.subscriptionId;
      if(typeof subscription!=='string')throw new HarmonyApiError('invalid_request','task subscription identity required');
      if(options.action==='unsubscribe'||api.includes('.off'))this.subscriptions.delete(subscription);
      else {
        if(this.subscriptions.size>=256)throw new HarmonyApiError('invalid_request','network subscription limit');
        const event=api.slice(api.lastIndexOf('.')+3);this.subscriptions.set(subscription,{call,id:subscription,object,event,sequence:0});
        call.cancellation.retainUntilCancelled();call.cancellation.onCancel(()=>{this.subscriptions.delete(subscription);});
      }return this.ok(api);
    }
    if(typeof options.url!=='string'||typeof options.objectId!=='string')throw new HarmonyApiError('invalid_request','URL and runtime task identity required');
    const target=new url.URL(options.url);
    if(target.protocol!=='https:'||target.username||target.password||!this.origins.has(target.origin))throw new HarmonyApiError('permission_denied','network origin is not allowed');
    const method=(api==='wx.uploadFile'?'POST':options.method||'GET').toUpperCase();
    const methods:Record<string,http.RequestMethod>={'GET':http.RequestMethod.GET,'POST':http.RequestMethod.POST,'PUT':http.RequestMethod.PUT,'DELETE':http.RequestMethod.DELETE,'HEAD':http.RequestMethod.HEAD,'OPTIONS':http.RequestMethod.OPTIONS};
    if(methods[method]===undefined)throw new HarmonyApiError('unsupported','HTTP method is unavailable');
    if(this.tasks.size>=64)throw new HarmonyApiError('invalid_request','native network concurrency limit');
    const headers:Record<string,string>=options.header||{};
    let data:Object|string|ArrayBuffer|undefined=options.data;
    if(method==='GET'||method==='HEAD') {
      if(data!==undefined&&typeof data!=='string'){const values=data as Record<string,Object>;for(const key of Object.keys(values))target.searchParams.append(key,typeof values[key]==='string'?values[key] as string:JSON.stringify(values[key]));}
      else if(typeof data==='string'&&data.length>0)throw new HarmonyApiError('invalid_request','GET data must be a query object');data=undefined;
    }else if(api==='wx.uploadFile') {
      if(typeof options.filePath!=='string'||typeof options.name!=='string'||! /^[a-zA-Z0-9_-]{1,128}$/.test(options.name))throw new HarmonyApiError('invalid_request','managed upload path and safe field name required');
      const bytes=this.files.readUpload(options.filePath,call),boundary=`weapp-${Date.now()}-${call.context.callId.replace(/[^a-zA-Z0-9]/g,'')}`;
      const encoder=new util.TextEncoder();let prefix='';
      if(options.formData!==undefined)for(const key of Object.keys(options.formData)){if(! /^[a-zA-Z0-9_-]{1,128}$/.test(key))throw new HarmonyApiError('invalid_request','unsafe form field name');prefix+=`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${options.formData[key]}\r\n`;}
      prefix+=`--${boundary}\r\nContent-Disposition: form-data; name="${options.name}"; filename="upload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`;
      const start=encoder.encodeInto(prefix),end=encoder.encodeInto(`\r\n--${boundary}--\r\n`);
      if(start.byteLength+end.byteLength+bytes.byteLength>2*1048576)throw new HarmonyApiError('invalid_request','multipart upload byte limit');
      const body=new Uint8Array(start.byteLength+bytes.byteLength+end.byteLength);body.set(start,0);body.set(bytes,start.byteLength);body.set(end,start.byteLength+bytes.byteLength);data=body.buffer;headers['Content-Type']=`multipart/form-data; boundary=${boundary}`;
    }else if(typeof data==='object'&&data!==null) {
      const marker=data as BinaryValue;
      if(marker.__weappBinary!==undefined){if(marker.__weappBinary.type!=='ArrayBuffer'||marker.__weappBinary.bytes.length>1048576||marker.__weappBinary.bytes.some((value:number)=>!Number.isInteger(value)||value<0||value>255))throw new HarmonyApiError('invalid_request','invalid binary request body');data=new Uint8Array(marker.__weappBinary.bytes).buffer;}
      else{data=JSON.stringify(data);if(headers['Content-Type']===undefined)headers['Content-Type']='application/json';}
    }
    const request=http.createHttp(),object=options.objectId;
    let responseHeader:Record<string,Object>={};const chunks:Array<Uint8Array>=[];let totalBytes=0;
    let finish:()=>void=()=>{},fail:(error:HarmonyApiError)=>void=()=>{};
    const finished=new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;});finished.catch(()=>{});
    let rejectCancelled:(error:HarmonyApiError)=>void=()=>{},destroyed=false;
    const cancelled=new Promise<number>((resolve,reject)=>{rejectCancelled=reject;});cancelled.catch(()=>{});
    const destroy=():void=>{if(!destroyed){destroyed=true;request.destroy();}};
    const task:NativeNetworkTask={request,abort:(reason:HarmonyApiError):void=>{fail(reason);rejectCancelled(reason);destroy();if(this.tasks.get(object)===task)this.tasks.delete(object);}};
    this.tasks.set(object,task);call.cancellation.onCancel(()=>{task.abort(new HarmonyApiError('cancelled','native HTTP request cancelled'));});
    const limit=api==='wx.downloadFile'?8*1048576:1048576;
    request.on('headersReceive',(header:Object)=>{responseHeader=header as Record<string,Object>;const event:NetworkEvent={header};this.emit(object,'HeadersReceived',event);});
    request.on('dataReceiveProgress',(progress:http.DataReceiveProgressInfo)=>{if(api!=='wx.uploadFile'){const event:NetworkEvent={totalBytesWritten:progress.receiveSize,totalBytesExpectedToWrite:progress.totalSize,progress:progress.totalSize>0?Math.round(progress.receiveSize*100/progress.totalSize):0};this.emit(object,'ProgressUpdate',event);}});
    request.on('dataSendProgress',(progress:http.DataSendProgressInfo)=>{if(api==='wx.uploadFile'){const event:NetworkEvent={totalBytesSent:progress.sendSize,totalBytesExpectedToSend:progress.totalSize,progress:progress.totalSize>0?Math.round(progress.sendSize*100/progress.totalSize):0};this.emit(object,'ProgressUpdate',event);}});
    request.on('dataReceive',(chunk:ArrayBuffer)=>{
      if(call.cancellation.cancelled){task.abort(new HarmonyApiError('cancelled','network stream owner retired'));return;}
      if(chunk.byteLength>limit-totalBytes){task.abort(new HarmonyApiError('invalid_request','native response byte limit'));return;}
      const bytes=new Uint8Array(chunk);chunks.push(bytes);totalBytes+=bytes.byteLength;
      if(api==='wx.request')for(let offset=0;offset<bytes.byteLength;offset+=1048576){const event:NetworkEvent={data:this.binary(bytes.slice(offset,offset+1048576))};this.emit(object,'ChunkReceived',event);}
    });
    request.on('dataEnd',()=>finish());
    try {
      const timeout=Math.max(1,Math.min(300000,options.timeout||60000));
      const settings:http.HttpRequestOptions={method:methods[method],header:headers,extraData:data,usingCache:false,maxRedirects:0,connectTimeout:Math.min(10000,timeout),readTimeout:timeout,expectDataType:http.HttpDataType.ARRAY_BUFFER,maxLimit:api==='wx.downloadFile'?8*1048576:1048576};
      const statusCode=await Promise.race([request.requestInStream(target.toString(),settings),cancelled]);await finished;this.current(call);
      const bytes=new Uint8Array(totalBytes);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      const result=this.ok(api);result.statusCode=statusCode;result.header=responseHeader;
      if(api==='wx.downloadFile'){const path=this.files.writeTemporary(bytes,call,options.filePath);if(options.filePath)result.filePath=path;else result.tempFilePath=path;}
      else if(options.responseType==='arraybuffer')result.data=this.binary(bytes);
      else{const text=util.TextDecoder.create('utf-8',{fatal:false}).decodeToString(bytes);if(api==='wx.request'&&options.dataType!=='text'){try{result.data=JSON.parse(text) as Object;}catch{result.data=text;}}else result.data=text;}
      return result;
    }finally{destroy();if(this.tasks.get(object)===task)this.tasks.delete(object);}
  }
}
