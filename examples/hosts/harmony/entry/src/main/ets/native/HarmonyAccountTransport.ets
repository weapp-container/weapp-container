import http from '@ohos.net.http';
import url from '@ohos.url';
import util from '@ohos.util';
import { BusinessError } from '@ohos.base';
import { HarmonyApiCall, HarmonyApiError } from '../session/HostServices';
import { HarmonyAccountTransport } from '../session/ReferenceHostServices';

export interface HarmonyAccountTransportOptions {
  origin: string;
  // Called only in native code with the exact trusted account/application call.
  // Never install this closure or its bearer as a guest wx.request adapter.
  hostToken: (call: HarmonyApiCall) => string | Promise<string>;
  timeoutMs?: number;
}
interface BackendFailure { error?: string; message?: string; }
interface AccountExchange {
  call: HarmonyApiCall; request: http.HttpRequest | null;
  cancelled: Promise<void>; rejectCancelled: (reason: HarmonyApiError) => void;
  nativeDone: Promise<void>; finishNative: () => void;
  streamDone: Promise<void>; finishStream: () => void;
  retired: boolean; released: boolean; destroyed: boolean; started: boolean;
  nativeSettled: boolean; nativeRejected: boolean; streamEnded: boolean;
  releasing: Promise<void> | null; releaseError: HarmonyApiError | null; timer: number; deadlineMs: number;
}

/** HTTPS only, dedicated account backend, no redirect or shared response cache.
 * Cancelling JS never fabricates native release: native terminal and successful
 * destroy must both be observed before the exact request leaves close(). */
export class HarmonyAccountHttpsTransport implements HarmonyAccountTransport {
  private readonly origin: string;
  private readonly hostToken: (call: HarmonyApiCall) => string | Promise<string>;
  private readonly timeoutMs: number;
  private readonly exchanges: Set<AccountExchange> = new Set();
  private closed: boolean = false;
  private closing: Promise<void> | null = null;
  constructor(options: HarmonyAccountTransportOptions) {
    const parsed=new url.URL(options.origin);
    if(parsed.protocol!=='https:'||parsed.origin!==options.origin||parsed.username||parsed.password||typeof options.hostToken!=='function')throw new HarmonyApiError('invalid_request','configure an exact HTTPS account backend origin and native hostToken closure');
    const timeout=options.timeoutMs===undefined?30000:options.timeoutMs;
    if(!Number.isSafeInteger(timeout)||timeout<100||timeout>120000)throw new HarmonyApiError('invalid_request','account backend timeout must be 100..120000 milliseconds');
    this.origin=options.origin;this.hostToken=options.hostToken;this.timeoutMs=timeout;
  }
  request(path: string,body: Object,call: HarmonyApiCall): Promise<Object> {
    this.ensure(call);const timeout=this.timeout(call);
    if(! /^\/v1\/host\/(identity-state|login-codes|check-session|authorization-policy|consents|phone-codes|profile|app-logout)$/.test(path)&&! /^\/v1\/payments\/orders\/[A-Za-z0-9-]{1,128}\/launch$/.test(path))throw new HarmonyApiError('invalid_request','account transport endpoint is not allowed');
    if(body===null||typeof body!=='object'||Array.isArray(body))throw new HarmonyApiError('invalid_request','account backend body must be a JSON object');
    const serialized=JSON.stringify(body),bytes=new util.TextEncoder().encodeInto(serialized);
    if(bytes.byteLength>262144)throw new HarmonyApiError('invalid_request','account backend request exceeds 256 KiB');
    if(this.exchanges.size>=16)throw new HarmonyApiError('invalid_request','account backend concurrency limit');
    let rejectCancelled:(reason:HarmonyApiError)=>void=():void=>{};
    const cancelled=new Promise<void>((_resolve,reject):void=>{rejectCancelled=reject;});cancelled.catch(():void=>{});
    let finishNative:()=>void=():void=>{},finishStream:()=>void=():void=>{};
    const nativeDone=new Promise<void>((resolve):void=>{finishNative=resolve;}),streamDone=new Promise<void>((resolve):void=>{finishStream=resolve;});
    const exchange:AccountExchange={call,request:null,cancelled,rejectCancelled,nativeDone,finishNative,streamDone,finishStream,retired:false,released:false,destroyed:false,started:false,nativeSettled:false,nativeRejected:false,streamEnded:false,releasing:null,releaseError:null,timer:-1,deadlineMs:Date.now()+timeout};
    this.exchanges.add(exchange);
    exchange.timer=setTimeout(():void=>{this.retire(exchange,new HarmonyApiError('timeout','account backend total deadline expired')).catch(():void=>{});},timeout);
    call.cancellation.onCancel(():Promise<void>=>this.retire(exchange,new HarmonyApiError('cancelled','account request owner retired')));
    const requestBody=new ArrayBuffer(bytes.byteLength);new Uint8Array(requestBody).set(bytes);
    const execution=this.execute(exchange,path,requestBody).finally(():Promise<void>=>this.release(exchange));
    // The execution still owns native cleanup after the consuming call is
    // cancelled. Keep its rejection observed while the retained barrier drains.
    execution.catch(():void=>{});
    return Promise.race([execution,cancelled.then(():Object=>{throw new HarmonyApiError('cancelled','account request cancelled');})]);
  }
  close(): Promise<void> {
    this.closed=true;
    if(this.closing!==null)return this.closing;
    const task=(async():Promise<void>=>{
      const failures:Array<Object>=[];
      await Promise.all(Array.from(this.exchanges).map(async(exchange:AccountExchange):Promise<void>=>{try{await this.retire(exchange,new HarmonyApiError('cancelled','account transport closed'));}catch(error){failures.push(error as Object);}}));
      if(failures.length>0)throw new HarmonyApiError('invalid_request',`${failures.length} native account requests still require release retry`);
    })();this.closing=task.finally(():void=>{this.closing=null;});return this.closing;
  }
  private ensure(call: HarmonyApiCall): void {
    if(this.closed||call.cancellation.cancelled)throw new HarmonyApiError('cancelled','account backend execution owner retired');
  }
  private ensureExchange(exchange: AccountExchange): void {
    this.ensure(exchange.call);if(exchange.retired)throw new HarmonyApiError('cancelled','account backend request retired');
  }
  private timeout(call: HarmonyApiCall): number {
    const deadline=call.context.deadlineNs;if(deadline===undefined)return this.timeoutMs;
    if(! /^[0-9]{1,20}$/.test(deadline))throw new HarmonyApiError('invalid_request','invalid trusted account deadline');
    // Divide decimal nanoseconds before converting to a safe millisecond number.
    const deadlineMs=Number(deadline.length>6?deadline.slice(0,-6):'0');
    const remaining=deadlineMs-Date.now();if(remaining<=0)throw new HarmonyApiError('timeout','account backend deadline expired');
    return Math.max(1,Math.min(this.timeoutMs,remaining));
  }
  private async execute(exchange: AccountExchange,path: string,body: ArrayBuffer): Promise<Object> {
    this.ensureExchange(exchange);
    const token=await Promise.race([Promise.resolve(this.hostToken(exchange.call)),exchange.cancelled.then(():string=>'')]);
    this.ensureExchange(exchange);
    if(typeof token!=='string'||token.length===0||token.length>8192||! /^[\x21-\x7e]+$/.test(token))throw new HarmonyApiError('permission_denied','native host credential is unavailable');
    const timeout=Math.max(1,Math.min(this.timeout(exchange.call),exchange.deadlineMs-Date.now())),request=http.createHttp();exchange.request=request;
    const chunks:Array<Uint8Array>=[];let received=0,quotaFailure:HarmonyApiError|null=null;
    request.on('dataReceive',(buffer:ArrayBuffer):void=>{
      if(exchange.retired||exchange.call.cancellation.cancelled)return;
      if(buffer.byteLength>262144-received){quotaFailure=new HarmonyApiError('invalid_request','account backend response exceeds 256 KiB');this.retire(exchange,quotaFailure).catch(():void=>{});return;}
      const chunk=new Uint8Array(buffer).slice();received+=chunk.byteLength;chunks.push(chunk);
    });
    request.on('dataEnd',():void=>{exchange.streamEnded=true;exchange.finishStream();this.nativeTerminal(exchange);});
    const settings:http.HttpRequestOptions={method:http.RequestMethod.POST,header:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json','Accept':'application/json','Cache-Control':'no-store'},extraData:body,usingCache:false,maxRedirects:0,connectTimeout:Math.min(10000,timeout),readTimeout:timeout,expectDataType:http.HttpDataType.ARRAY_BUFFER,maxLimit:262144};
    let native:Promise<number>;
    try{native=request.requestInStream(this.origin+path,settings);exchange.started=true;}
    catch(error){throw this.nativeError(error as Object);}
    native.then(():void=>{exchange.nativeSettled=true;this.nativeTerminal(exchange);},():void=>{exchange.nativeSettled=true;exchange.nativeRejected=true;this.nativeTerminal(exchange);});
    let status:number;
    try{status=await Promise.race([native,exchange.cancelled.then(():number=>0)]);await Promise.race([exchange.streamDone,exchange.cancelled]);}
    catch(error){if(quotaFailure!==null)throw this.nativeError(quotaFailure);if(error instanceof HarmonyApiError)throw error;throw this.nativeError(error as Object);}
    this.ensureExchange(exchange);
    const bytes=new Uint8Array(received);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    let value:Object;
    try{value=JSON.parse(util.TextDecoder.create('utf-8',{fatal:true}).decodeToString(bytes)) as Object;}
    catch{throw new HarmonyApiError('invalid_request','account backend returned invalid UTF-8 JSON',status);}
    if(value===null||typeof value!=='object'||Array.isArray(value))throw new HarmonyApiError('invalid_request','account backend returned a non-object JSON value',status);
    if(!Number.isInteger(status)||status<200||status>=300){
      const failure=value as BackendFailure,message=typeof failure.message==='string'?failure.message.slice(0,512):'account backend rejected the request';
      throw new HarmonyApiError(status===401||status===403?'permission_denied':status===408||status===504?'timeout':'invalid_request',message,status,message);
    }
    return value;
  }
  private nativeTerminal(exchange: AccountExchange): void {
    if(exchange.nativeSettled&&(exchange.nativeRejected||exchange.streamEnded))exchange.finishNative();
  }
  private retire(exchange: AccountExchange,reason: HarmonyApiError): Promise<void> {
    if(!exchange.retired){exchange.retired=true;if(exchange.timer>=0){clearTimeout(exchange.timer);exchange.timer=-1;}exchange.rejectCancelled(reason);}
    return this.release(exchange,true);
  }
  private release(exchange: AccountExchange,retry: boolean = false): Promise<void> {
    if(exchange.released)return Promise.resolve();if(exchange.releasing!==null)return exchange.releasing;
    if(exchange.releaseError!==null&&!retry)return Promise.reject(exchange.releaseError);exchange.releaseError=null;
    const task=(async():Promise<void>=>{
      const request=exchange.request;
      if(request!==null&&!exchange.destroyed){try{request.destroy();exchange.destroyed=true;}catch(error){throw this.nativeError(error as Object);}}
      if(exchange.started)await exchange.nativeDone;
      if(exchange.timer>=0){clearTimeout(exchange.timer);exchange.timer=-1;}exchange.released=true;this.exchanges.delete(exchange);
    })();exchange.releasing=task.catch((error:Object):void=>{exchange.releaseError=this.nativeError(error);throw exchange.releaseError;}).finally(():void=>{exchange.releasing=null;});return exchange.releasing;
  }
  private nativeError(error: Object): HarmonyApiError {
    if(error instanceof HarmonyApiError)return error;
    const failure=error as BusinessError;return new HarmonyApiError('invalid_request','native account HTTP operation failed',typeof failure.code==='number'?failure.code:-1,typeof failure.message==='string'?failure.message.slice(0,512):'native account HTTP operation failed');
  }
}
