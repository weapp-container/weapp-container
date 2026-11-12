import webSocket from '@ohos.net.webSocket';
import url from '@ohos.url';
import { BusinessError } from '@ohos.base';
import { HarmonyHostServices,HarmonyApiCall,HarmonyApiError } from '../session/HostServices';

interface SocketOptions {url?:string;objectId?:string;header?:Record<string,string>;protocols?:Array<string>;subscriptionId?:string;action?:string;data?:Object|string;code?:number;reason?:string;}
interface SocketResult {errMsg:string;objectId?:string;}
interface BinaryBytes {type:string;bytes:Array<number>;}
interface BinaryValue {__weappBinary:BinaryBytes;}
interface SocketEvent {data?:Object|string;header?:Object;code?:number;reason?:string;errMsg?:string;errCode?:number;}
interface SocketSubscription {id:string;object:string;event:string;call:HarmonyApiCall;sequence:number;}
interface SocketOwner {socket:webSocket.WebSocket;call:HarmonyApiCall;open:boolean;closed:boolean;retired:boolean;sendingBytes:number;opening:Promise<void>;closing:Promise<void>|null;}

/** A real API24 WebSocket, scoped to a native incarnation. The host explicitly
 * permits exact WSS origins; TLS verification remains enabled. Native callbacks
 * only enqueue bounded records, and disposal waits actual socket release.
 */
export class HarmonySocketApis {
  private readonly services:HarmonyHostServices;
  private readonly origins:Set<string>=new Set();
  private readonly sockets:Map<string,SocketOwner>=new Map();
  private readonly subscriptions:Map<string,SocketSubscription>=new Map();
  readonly supportedApis:Array<string>=[
    'wx.connectSocket','object:SocketTask.send','object:SocketTask.close',
    'object:SocketTask.onOpen','object:SocketTask.onClose','object:SocketTask.onError','object:SocketTask.onMessage',
  ];
  constructor(services:HarmonyHostServices,allowedOrigins:Array<string>=[]) {
    this.services=services;
    if(allowedOrigins.length>128)throw new HarmonyApiError('invalid_request','socket origin limit');
    for(const origin of allowedOrigins){const parsed=new url.URL(origin);if(parsed.protocol!=='wss:'||parsed.origin!==origin||parsed.username||parsed.password)throw new HarmonyApiError('invalid_request','configure exact WSS origins');this.origins.add(origin);}
    for(const api of this.supportedApis)services.registerApiHandler(api,async(payload:Object,call:HarmonyApiCall):Promise<Object>=>{
      try{return await this.invoke(api,payload as SocketOptions,call);}catch(error){if(error instanceof HarmonyApiError)throw error;const native=error as BusinessError;throw new HarmonyApiError('invalid_request',native.message,native.code,`${api.replace(/^wx\./,'')}:fail ${native.message}`);}
    });
    services.onClose(async()=>{const releases:Array<Promise<void>>=[];for(const object of this.sockets.keys()){const owner=this.sockets.get(object);if(owner!==undefined)releases.push(this.retire(object,owner));}await Promise.all(releases);this.subscriptions.clear();});
  }
  private ok(api:string):SocketResult{return {errMsg:`${api.replace(/^wx\./,'')}:ok`};}
  private current(call:HarmonyApiCall):void {if(call.cancellation.cancelled)throw new HarmonyApiError('cancelled','socket owner retired');}
  private binary(bytes:ArrayBuffer):BinaryValue {const values:Array<number>=[];for(const byte of new Uint8Array(bytes))values.push(byte);return {__weappBinary:{type:'ArrayBuffer',bytes:values}};}
  private emit(object:string,event:string,value:SocketEvent):void {
    for(const subscription of this.subscriptions.values())if(subscription.object===object&&subscription.event===event&&!subscription.call.cancellation.cancelled){
      if(!this.services.emit(subscription.call.context,subscription.id,++subscription.sequence,event,value,object)){const owner=this.sockets.get(object);if(owner!==undefined)owner.call.cancellation.cancel();}
    }
  }
  private releaseSubscriptions(object:string):void {
    for(const id of this.subscriptions.keys()){const subscription=this.subscriptions.get(id);if(subscription!==undefined&&subscription.object===object){this.subscriptions.delete(id);this.services.release(subscription.call.context);}}
  }
  private retire(object:string,owner:SocketOwner):Promise<void> {
    if(owner.closing!==null)return owner.closing;
    owner.retired=true;
    const closing=(async():Promise<void>=>{
      // A pending native connect can acquire a socket after revocation. Await its
      // resolution, then close that exact owner; it can never publish a late Open.
      await owner.opening;
      if(!owner.closed){const closed=await owner.socket.close({code:1000,reason:'owner retired'});if(!closed)throw new HarmonyApiError('invalid_request','native socket close was rejected');owner.closed=true;}
      if(this.sockets.get(object)===owner)this.sockets.delete(object);this.releaseSubscriptions(object);
    })();owner.closing=closing;return closing;
  }
  private async invoke(api:string,options:SocketOptions,call:HarmonyApiCall):Promise<Object> {
    this.current(call);const object=options.objectId;
    if(typeof object!=='string')throw new HarmonyApiError('invalid_request','runtime socket identity required');
    if(api==='wx.connectSocket') {
      if(typeof options.url!=='string'||this.sockets.size>=32||this.sockets.has(object))throw new HarmonyApiError('invalid_request','unique URL/socket identity and available capacity required');
      const target=new url.URL(options.url);if(target.protocol!=='wss:'||target.username||target.password||!this.origins.has(target.origin))throw new HarmonyApiError('permission_denied','socket origin is not allowed');
      const protocols=options.protocols||[];if(protocols.length>16||protocols.some((value:string)=>! /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)))throw new HarmonyApiError('invalid_request','invalid socket protocols');
      const socket=webSocket.createWebSocket();
      const owner:SocketOwner={socket,call,open:false,closed:false,retired:false,sendingBytes:0,opening:Promise.resolve(),closing:null};this.sockets.set(object,owner);
      socket.on('open',(error:BusinessError,header:Object)=>{if(error!==undefined&&error!==null&&error.code!==0){const value:SocketEvent={errCode:error.code,errMsg:error.message};this.emit(object,'Error',value);return;}owner.open=true;if(!owner.retired&&!call.cancellation.cancelled){const value:SocketEvent={header};this.emit(object,'Open',value);}});
      socket.on('message',(error:BusinessError,data:string|ArrayBuffer)=>{
        if(owner.retired||call.cancellation.cancelled)return;
        if(error!==undefined&&error!==null&&error.code!==0){const value:SocketEvent={errCode:error.code,errMsg:error.message};this.emit(object,'Error',value);return;}
        if((typeof data==='string'?data.length*4:data.byteLength)>1048576){call.cancellation.cancel();return;}
        const value:SocketEvent={data:typeof data==='string'?data:this.binary(data)};this.emit(object,'Message',value);
      });
      socket.on('error',(error:BusinessError)=>{if(!owner.retired&&!call.cancellation.cancelled){const value:SocketEvent={errCode:error.code,errMsg:error.message};this.emit(object,'Error',value);}});
      socket.on('close',(error:BusinessError,result:webSocket.CloseResult)=>{
        owner.closed=true;owner.open=false;
        if(!owner.retired&&!call.cancellation.cancelled){const value:SocketEvent={code:result.code,reason:result.reason};this.emit(object,'Close',value);}
        if(this.sockets.get(object)===owner)this.sockets.delete(object);this.releaseSubscriptions(object);this.services.release(call.context);
      });
      const settings:webSocket.WebSocketRequestOptions={header:options.header,protocol:protocols.join(','),skipServerCertVerification:false};
      owner.opening=socket.connect(target.toString(),settings).then((connected:boolean):void=>{if(!connected)throw new HarmonyApiError('invalid_request','native socket connection rejected');}).catch((error:BusinessError):void=>{
        owner.closed=true;if(!owner.retired&&!call.cancellation.cancelled){const value:SocketEvent={errCode:error.code,errMsg:error.message};this.emit(object,'Error',value);}if(this.sockets.get(object)===owner)this.sockets.delete(object);this.releaseSubscriptions(object);this.services.release(call.context);
      });
      call.cancellation.retainUntilCancelled();call.cancellation.onCancel(()=>this.retire(object,owner));
      const result=this.ok(api);result.objectId=object;return result;
    }
    const owner=this.sockets.get(object);if(owner===undefined||owner.retired||owner.call.cancellation.cancelled)throw new HarmonyApiError('cancelled','socket belongs to a retired owner');
    if(api.includes('.on')) {
      const id=options.subscriptionId;if(typeof id!=='string')throw new HarmonyApiError('invalid_request','socket subscription identity required');
      if(options.action==='unsubscribe'){const subscription=this.subscriptions.get(id);this.subscriptions.delete(id);if(subscription!==undefined)this.services.release(subscription.call.context);return this.ok(api);}
      if(this.subscriptions.size>=256)throw new HarmonyApiError('invalid_request','socket subscription limit');
      const event=api.slice(api.lastIndexOf('.')+3);this.subscriptions.set(id,{id,object,event,call,sequence:0});call.cancellation.retainUntilCancelled();call.cancellation.onCancel(()=>{this.subscriptions.delete(id);});return this.ok(api);
    }
    if(api.endsWith('.send')) {
      if(!owner.open)throw new HarmonyApiError('invalid_request','socket is not open');
      let data:string|ArrayBuffer;let bytes:number;
      if(typeof options.data==='string'){data=options.data;bytes=data.length*4;}else{const marker=options.data as BinaryValue;if(marker===undefined||marker.__weappBinary===undefined||marker.__weappBinary.type!=='ArrayBuffer'||marker.__weappBinary.bytes.length>1048576||marker.__weappBinary.bytes.some((value:number)=>!Number.isInteger(value)||value<0||value>255))throw new HarmonyApiError('invalid_request','socket data must be bounded text or ArrayBuffer');data=new Uint8Array(marker.__weappBinary.bytes).buffer;bytes=marker.__weappBinary.bytes.length;}
      if(bytes>1048576-owner.sendingBytes)throw new HarmonyApiError('invalid_request','socket send queue byte limit');owner.sendingBytes+=bytes;
      try{const sent=await owner.socket.send(data);this.current(call);if(!sent)throw new HarmonyApiError('invalid_request','native socket send rejected');return this.ok(api);}finally{owner.sendingBytes-=bytes;}
    }
    if(api.endsWith('.close')) {
      const code=options.code===undefined?1000:options.code,reason=options.reason||'';if(!(code===1000||Number.isInteger(code)&&code>=3000&&code<=4999)||reason.length*4>123)throw new HarmonyApiError('invalid_request','invalid socket close code or reason');
      owner.open=false;const settings:webSocket.WebSocketCloseOptions={code,reason};if(!await owner.socket.close(settings))throw new HarmonyApiError('invalid_request','native socket close rejected');return this.ok(api);
    }
    throw new HarmonyApiError('unsupported','socket API unavailable');
  }
}
