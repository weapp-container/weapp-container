import common from '@ohos.app.ability.common';
import abilityAccessCtrl, { Permissions } from '@ohos.abilityAccessCtrl';
import wifiManager from '@ohos.wifiManager';
import { BusinessError } from '@ohos.base';
import { UIContext } from '@ohos.arkui.UIContext';
import { HarmonyHostServices, HarmonyApiCall, HarmonyApiError } from '../session/HostServices';
import { HarmonyDisclosurePrompts } from '../session/DisclosurePrompts';
import { HarmonyWifiDisclosureDriver } from './HarmonyWifiDisclosure';

export interface HarmonyWifiConfiguration { purpose: string; permissionVersion: string; fullInfo: boolean; scan: boolean; connect: boolean; }
interface WifiOptions { SSID?: string; BSSID?: string; password?: string; maunal?: boolean; partialInfo?: boolean; subscriptionId?: string; action?: string; }
interface WifiInfo { SSID: string; BSSID?: string; frequency?: number; secure?: boolean; signalStrength?: number; }
interface WifiResult { errMsg?: string; wifi?: WifiInfo; wifiList?: Array<WifiInfo>; }
interface Subscription { call: HarmonyApiCall; id: string; event: string; sequence: number; }
interface Scan {
  owner: HarmonyWifiApis; call: HarmonyApiCall; generation: number; retired: boolean; started: boolean; terminal: boolean;
  registered: boolean; radioRegistered: boolean; releasing: Promise<void> | null;
  listener: (state: number) => void; radio: (state: number) => void;
  final: Promise<void>; finalize: () => void; answer: Promise<void>; finish: (error?: Object) => void;
}
interface Candidate {
  owner: HarmonyWifiApis; call: HarmonyApiCall; generation: number; ssid: string; bssid: string | null;
  id: number | null; retired: boolean; removed: boolean; userAccepted: boolean;
  acquisition: Promise<number>; action: Promise<void> | null; releasing: Promise<void> | null;
  answer: Promise<void>; finish: (error?: Object) => void;
}
// The system radio is shared. Never replace another container's scan/candidate,
// and never call global enableWifi/disableWifi/disconnect or remove all configs.
let processScan: Scan | null = null;
let processCandidate: Candidate | null = null;
let configuredWifi: HarmonyWifiConfiguration | null = null;
export function configureHarmonyWifi(configuration: HarmonyWifiConfiguration | null): void {
  if(configuration===null){configuredWifi=null;return;}
  if(configuration.purpose.trim().length===0||configuration.permissionVersion.trim().length===0||configuration.purpose.length>512||configuration.permissionVersion.length>64||configuration.scan&&!configuration.fullInfo)throw new Error('ERR_INVALID_REQUEST: explicit Wi-Fi purpose/version and fullInfo scan policy required');
  configuredWifi={purpose:configuration.purpose,permissionVersion:configuration.permissionVersion,fullInfo:configuration.fullInfo,scan:configuration.scan,connect:configuration.connect};
}
export function installHarmonyWifiApis(context: common.UIAbilityContext, services: HarmonyHostServices, ui: UIContext): HarmonyWifiApis | null {
  if(configuredWifi===null||!canIUse('SystemCapability.Communication.WiFi.STA'))return null;
  const configuration=configuredWifi;
  const prompts=new HarmonyDisclosurePrompts(services,new HarmonyWifiDisclosureDriver(ui));
  return new HarmonyWifiApis(context,services,configuration,(call:HarmonyApiCall):Promise<boolean>=>prompts.confirm({kind:'wifi',purpose:configuration.purpose,permissionVersion:configuration.permissionVersion},call));
}

/** API24 Wi-Fi STA. Native callbacks only enqueue through the owning service.
 * Complete WifiInfo never contains a privacy-random BSSID or invented security. */
export class HarmonyWifiApis {
  private readonly context: common.UIAbilityContext;
  private readonly services: HarmonyHostServices;
  private readonly configuration: HarmonyWifiConfiguration;
  private readonly confirm: (call: HarmonyApiCall) => Promise<boolean>;
  private readonly manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
  private readonly subscriptions: Map<string,Subscription> = new Map();
  private readonly scans: Set<Scan> = new Set();
  private readonly candidates: Set<Candidate> = new Set();
  private readonly backgroundDrains: Set<Promise<void>> = new Set();
  private opened: boolean = false; private opening: boolean = false;
  private closed: boolean = false; private foreground: boolean = true;
  private generation: number = 0; private lease: number = 0;
  private stopping: Promise<void> | null = null; private closing: Promise<void> | null = null; private closeComplete: boolean = false;
  private connectionRegistered: boolean = false; private permissionRegistered: boolean = false;
  private connectionListener: ((state:number)=>void) | null = null;
  private permissionListener: (()=>void) | null = null;
  private readonly permissions: Array<Permissions> = ['ohos.permission.GET_WIFI_INFO'];
  readonly supportedApis: Array<string> = ['wx.startWifi','wx.stopWifi','wx.onWifiConnectedWithPartialInfo','wx.offWifiConnectedWithPartialInfo'];
  constructor(context: common.UIAbilityContext, services: HarmonyHostServices, configuration: HarmonyWifiConfiguration, confirm: (call:HarmonyApiCall)=>Promise<boolean>) {
    this.context=context;this.services=services;this.configuration={purpose:configuration.purpose,permissionVersion:configuration.permissionVersion,fullInfo:configuration.fullInfo,scan:configuration.scan,connect:configuration.connect};this.confirm=confirm;
    if(configuration.fullInfo){this.supportedApis.push('wx.getConnectedWifi','wx.onWifiConnected','wx.offWifiConnected');this.permissions.push('ohos.permission.GET_WIFI_PEERS_MAC');}
    if(configuration.scan){if(!configuration.fullInfo)throw new Error('Wi-Fi scans require fullInfo policy');this.supportedApis.push('wx.getWifiList','wx.onGetWifiList','wx.offGetWifiList');}
    if(configuration.connect)this.supportedApis.push('wx.connectWifi');
    if(configuration.scan||configuration.connect)this.permissions.push('ohos.permission.SET_WIFI_INFO');
    for(const api of this.supportedApis)services.registerApiHandler(api,async(payload:Object,call:HarmonyApiCall):Promise<Object>=>{
      try{return await this.invoke(api,payload as WifiOptions,call);}catch(error){throw this.error(error as Object,api);}
    });
    services.onForeground((visible:boolean):void=>{this.foreground=visible;if(!visible)this.background(this.stop());});
    services.onClose(():Promise<void>=>this.close());
  }
  private ok(api:string,result:WifiResult={}):WifiResult {result.errMsg=api.replace(/^wx\./,'')+':ok';return result;}
  private failure(message:string,code:number=12010):HarmonyApiError {return new HarmonyApiError('invalid_request',message,code,'Wi-Fi:fail '+message);}
  private error(error:Object,api:string):HarmonyApiError {
    if(error instanceof HarmonyApiError)return error;
    const native=error as BusinessError;
    return new HarmonyApiError(native.code===201||native.code===202?'permission_denied':native.code===801?'unsupported':'invalid_request',native.message||String(error),native.code||12010,api.replace(/^wx\./,'')+':fail '+(native.message||String(error)));
  }
  private current(call:HarmonyApiCall,generation:number=this.generation):void {
    if(this.closed||!this.foreground||generation!==this.generation||call.cancellation.cancelled)throw new HarmonyApiError('cancelled','Wi-Fi execution owner retired');
  }
  private permitted(full:boolean=false,write:boolean=false):void {
    for(const permission of ['ohos.permission.GET_WIFI_INFO',...(write?['ohos.permission.SET_WIFI_INFO']:[]),...(full?['ohos.permission.GET_WIFI_PEERS_MAC']:[])] as Array<Permissions>) {
      if(this.manager.getSelfPermissionStatus(permission)!==abilityAccessCtrl.PermissionStatus.GRANTED)throw new HarmonyApiError('permission_denied',permission+' is not granted',201,'Wi-Fi:fail auth deny');
    }
  }
  private fullInfo(link:wifiManager.WifiLinkedInfo,partial:boolean=false):WifiInfo {
    this.permitted(true);
    if(link.connState!==wifiManager.ConnState.CONNECTED||!link.ssid||!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(link.bssid)||/^00(:00){5}$/.test(link.bssid)||link.bssid.toLowerCase()==='02:00:00:00:00:00')throw this.failure('cannot obtain genuine connected Wi-Fi information');
    const result:WifiInfo={SSID:link.ssid,BSSID:link.bssid};if(partial)return result;
    const scan=wifiManager.getScanInfoList().find((value:wifiManager.WifiScanInfo):boolean=>value.bssidType===wifiManager.DeviceAddressType.REAL_DEVICE_ADDRESS&&value.ssid===link.ssid&&value.bssid.toLowerCase()===link.bssid.toLowerCase());
    if(scan===undefined||scan.securityType===wifiManager.WifiSecurityType.WIFI_SEC_TYPE_INVALID)throw this.failure('connected Wi-Fi security is not available from a genuine scan');
    result.frequency=link.frequency;result.secure=scan.securityType!==wifiManager.WifiSecurityType.WIFI_SEC_TYPE_OPEN;result.signalStrength=this.signal(link.rssi,link.band);return result;
  }
  private signal(rssi:number,band:number):number {const level=wifiManager.getSignalLevel(rssi,band);if(!Number.isInteger(level)||level<0||level>4)throw this.failure('invalid native Wi-Fi signal');return level*25;}
  private emit(event:string,value:WifiResult,generation:number,call?:HarmonyApiCall):boolean {
    for(const subscription of this.subscriptions.values())if(subscription.event===event&&!subscription.call.cancellation.cancelled){
      if(!this.services.emit(subscription.call.context,subscription.id,++subscription.sequence,event,value,undefined,():boolean=>this.opened&&!this.closed&&this.foreground&&generation===this.generation&&this.subscriptions.get(subscription.id)===subscription&&!subscription.call.cancellation.cancelled&&(call===undefined||!call.cancellation.cancelled)))return false;
    }return true;
  }
  private connected(state:number,generation:number):void {
    if(state!==1||!this.opened||this.closed||!this.foreground||generation!==this.generation)return;
    try {
      this.permitted();const link=wifiManager.getLinkedInfoSync();if(link.connState!==wifiManager.ConnState.CONNECTED||!link.ssid)return;
      const candidate=processCandidate;
      if(candidate!==null&&candidate.owner===this&&!candidate.retired&&candidate.userAccepted&&candidate.generation===generation&&candidate.ssid===link.ssid&&(candidate.bssid===null||candidate.bssid===link.bssid.toLowerCase()))candidate.finish();
      if(!this.emit('WifiConnectedWithPartialInfo',{wifi:{SSID:link.ssid}},generation))throw this.failure('Wi-Fi partial event backpressure');
      if(this.configuration.fullInfo&&Array.from(this.subscriptions.values()).some((value:Subscription):boolean=>value.event==='WifiConnected')){
        let wifi:WifiInfo|null=null;
        try{wifi=this.fullInfo(link);}catch(error){if(error instanceof HarmonyApiError&&error.category==='permission_denied')throw error;console.error('WEAPP_WIFI_FULL_INFO '+String(error));}
        if(wifi!==null&&!this.emit('WifiConnected',{wifi},generation))throw this.failure('Wi-Fi event backpressure');
      }
    }catch(error){console.error('WEAPP_WIFI_CALLBACK '+String(error));this.background(this.stop());}
  }
  private async invoke(api:string,options:WifiOptions,call:HarmonyApiCall):Promise<Object> {
    const accepted=this.generation;this.current(call,accepted);
    if(api.startsWith('wx.on')||api.startsWith('wx.off')){
      const id=options.subscriptionId;if(typeof id!=='string'||id.length===0||id.length>256)throw this.failure('subscriptionId required');
      if(api.startsWith('wx.off')||options.action==='unsubscribe')this.subscriptions.delete(id);
      else {if(this.subscriptions.has(id)||this.subscriptions.size>=128)throw this.failure('Wi-Fi subscription limit');this.subscriptions.set(id,{id,call,event:api.substring(5),sequence:0});call.cancellation.retainUntilCancelled();call.cancellation.onCancel(():void=>{this.subscriptions.delete(id);});}
      return this.ok(api);
    }
    if(api==='wx.startWifi'){
      if(this.opened){this.permitted();return this.ok(api);}if(this.opening||this.scans.size>0||this.candidates.size>0||this.connectionRegistered||this.permissionRegistered)throw this.failure('previous Wi-Fi owner cleanup is pending',12004);
      this.opening=true;
      try{
        if(!await this.confirm(call))throw new HarmonyApiError('permission_denied','App Wi-Fi authorization denied',12007,'startWifi:fail auth deny');this.current(call,accepted);this.permitted();
        if(!wifiManager.isWifiActive())throw this.failure('Wi-Fi is not enabled',12005);
        const lease=++this.lease;this.connectionListener=(state:number):void=>this.connected(state,accepted);wifiManager.on('wifiConnectionChange',this.connectionListener);this.connectionRegistered=true;
        this.permissionListener=():void=>{try{this.permitted();if(this.configuration.fullInfo)this.permitted(true);}catch{this.background(this.stop());}};
        this.manager.on('selfPermissionStateChange',this.permissions,this.permissionListener);this.permissionRegistered=true;this.opened=true;
        call.cancellation.retainUntilCancelled();call.cancellation.onCancel(():Promise<void>=>lease===this.lease?this.stop():Promise.resolve());return this.ok(api);
      }catch(error){await this.stop();throw error as Error;}finally{this.opening=false;}
    }
    if(api==='wx.stopWifi'){await this.stop();return this.ok(api);}
    if(!this.opened)throw this.failure('call startWifi first',12000);this.permitted();if(!wifiManager.isWifiActive())throw this.failure('Wi-Fi is not enabled',12005);
    if(api==='wx.getConnectedWifi'){
      await this.authorizeMac(call,accepted);this.current(call,accepted);return this.ok(api,{wifi:this.fullInfo(wifiManager.getLinkedInfoSync(),options.partialInfo===true)});
    }
    if(api==='wx.getWifiList'){await this.authorizeMac(call,accepted);await this.scan(call,accepted);return this.ok(api);}
    if(api==='wx.connectWifi'){await this.connect(options,call,accepted);return this.ok(api);}
    throw new HarmonyApiError('unsupported','Wi-Fi API is not installed');
  }
  private async authorizeMac(call:HarmonyApiCall,generation:number):Promise<void> {
    if(!this.configuration.fullInfo)throw new HarmonyApiError('permission_denied','Host did not enable full Wi-Fi information',201);
    this.permitted();if(this.manager.getSelfPermissionStatus('ohos.permission.GET_WIFI_PEERS_MAC')!==abilityAccessCtrl.PermissionStatus.GRANTED){
      // The OS prompt is not cancelable. Its real Promise remains in the host
      // execution barrier; no old owner can consume a late permission result.
      await this.manager.requestPermissionsFromUser(this.context,['ohos.permission.GET_WIFI_PEERS_MAC']);
    }
    this.current(call,generation);this.permitted(true);
  }
  private async scan(call:HarmonyApiCall,generation:number):Promise<void> {
    this.current(call,generation);this.permitted(true,true);if(processScan!==null)throw this.failure('another native Wi-Fi scan is active or awaiting terminal cleanup',12004);
    let finalize:()=>void=():void=>{},finish:(error?:Object)=>void=():void=>{};
    const final=new Promise<void>((resolve):void=>{finalize=resolve;});let settled=false;
    const answer=new Promise<void>((resolve,reject):void=>{finish=(error?:Object):void=>{if(settled)return;settled=true;if(error===undefined)resolve();else reject(error);};});
    answer.catch(():void=>{}); // observe rejection while native acquisition/UI is still draining
    const scan:Scan={owner:this,call,generation,retired:false,started:false,terminal:false,registered:false,radioRegistered:false,releasing:null,listener:():void=>{},radio:():void=>{},final,finalize,answer,finish};
    scan.listener=(state:number):void=>{
      if(scan.terminal)return;scan.terminal=true;scan.finalize();
      if(!scan.retired&&!call.cancellation.cancelled&&generation===this.generation&&this.opened)try{
        this.permitted(true);if(state!==1)throw this.failure('native Wi-Fi scan failed');
        const snapshots=wifiManager.getScanInfoList();if(snapshots.length>256)throw this.failure('Wi-Fi scan exceeds 256 networks');const values:Array<WifiInfo>=[];
        for(const value of snapshots){if(value.bssidType!==wifiManager.DeviceAddressType.REAL_DEVICE_ADDRESS)throw new HarmonyApiError('permission_denied','OS returned a privacy BSSID alias',201);if(!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value.bssid)||value.securityType===wifiManager.WifiSecurityType.WIFI_SEC_TYPE_INVALID)continue;values.push({SSID:value.ssid,BSSID:value.bssid,frequency:value.frequency,secure:value.securityType!==wifiManager.WifiSecurityType.WIFI_SEC_TYPE_OPEN,signalStrength:this.signal(value.rssi,value.band)});}
        if(!this.emit('GetWifiList',{wifiList:values},generation,call))throw this.failure('Wi-Fi scan event backpressure');scan.finish();
      }catch(error){scan.finish(error as Object);}else scan.finish(new HarmonyApiError('cancelled','Wi-Fi scan owner retired'));
      this.background(this.releaseScan(scan));
    };
    scan.radio=(state:number):void=>{if(state===0)scan.listener(0);};
    processScan=scan;this.scans.add(scan);call.cancellation.retainUntilCancelled();call.cancellation.onCancel(():Promise<void>=>{scan.retired=true;scan.finish(new HarmonyApiError('cancelled','Wi-Fi scan cancelled'));return this.releaseScan(scan);});
    try{wifiManager.on('wifiScanStateChange',scan.listener);scan.registered=true;wifiManager.on('wifiStateChange',scan.radio);scan.radioRegistered=true;wifiManager.startScan();scan.started=true;}
    catch(error){scan.terminal=true;scan.finalize();scan.finish(error as Object);await this.releaseScan(scan);}
    await answer;
  }
  private releaseScan(scan:Scan):Promise<void> {
    if(!this.scans.has(scan))return Promise.resolve();if(scan.releasing!==null)return scan.releasing;
    const task=(async():Promise<void>=>{
      // API24 startScan exposes no cancel handle. Preserve the process lease and
      // exact listener until a real success/failure or radio-off terminal event.
      if(scan.started&&!scan.terminal)await scan.final;
      if(scan.registered){wifiManager.off('wifiScanStateChange',scan.listener);scan.registered=false;}
      if(scan.radioRegistered){wifiManager.off('wifiStateChange',scan.radio);scan.radioRegistered=false;}
      this.scans.delete(scan);if(processScan===scan)processScan=null;
    })();scan.releasing=task.finally(():void=>{scan.releasing=null;});return scan.releasing;
  }
  private async connect(options:WifiOptions,call:HarmonyApiCall,generation:number):Promise<void> {
    if(options.maunal===true)throw new HarmonyApiError('unsupported','manual settings navigation is not installed');
    const ssid=options.SSID,password=options.password;if(typeof ssid!=='string'||ssid.length===0||this.utf8(ssid)>32||ssid.includes('\u0000'))throw this.failure('invalid SSID',12008);
    if(typeof password!=='string'||this.utf8(password)>63||password.length>0&&this.utf8(password)<8)throw this.failure('only open or 8..63-byte WPA-PSK passwords are supported',12014);
    const bssid=options.BSSID?.toLowerCase()||null;if(bssid!==null){if(!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(bssid))throw this.failure('invalid BSSID');await this.authorizeMac(call,generation);}
    this.current(call,generation);this.permitted(false,true);if(processCandidate!==null)throw this.failure('another candidate connection is active or retiring',12004);
    const existing=wifiManager.getCandidateConfigs();if(existing.some((config:wifiManager.WifiDeviceConfig):boolean=>config.ssid===ssid))throw this.failure('existing host candidate cannot be replaced by this owner',12004);
    const config:wifiManager.WifiDeviceConfig={ssid,preSharedKey:password,securityType:password.length===0?wifiManager.WifiSecurityType.WIFI_SEC_TYPE_OPEN:wifiManager.WifiSecurityType.WIFI_SEC_TYPE_PSK};
    if(bssid!==null){config.bssid=bssid;config.bssidType=wifiManager.DeviceAddressType.REAL_DEVICE_ADDRESS;}
    let finish:(error?:Object)=>void=():void=>{};let settled=false;
    const answer=new Promise<void>((resolve,reject):void=>{finish=(error?:Object):void=>{if(settled)return;settled=true;if(error===undefined)resolve();else reject(error);};});
    answer.catch(():void=>{}); // observe rejection while native acquisition/UI is still draining
    const candidate:Candidate={owner:this,call,generation,ssid,bssid,id:null,retired:false,removed:false,userAccepted:false,acquisition:Promise.resolve(-1),action:null,releasing:null,answer,finish};
    processCandidate=candidate;this.candidates.add(candidate);call.cancellation.retainUntilCancelled();call.cancellation.onCancel(():Promise<void>=>{candidate.retired=true;candidate.finish(new HarmonyApiError('cancelled','Wi-Fi connection cancelled'));return this.releaseCandidate(candidate);});
    candidate.acquisition=Promise.resolve().then(async():Promise<number>=>{if(candidate.retired)return -1;const id=await wifiManager.addCandidateConfig(config);if(!Number.isInteger(id)||id<0)throw this.failure('native Wi-Fi candidate was not created');candidate.id=id;return id;});
    try{
      await candidate.acquisition;this.current(call,generation);if(candidate.retired)throw new HarmonyApiError('cancelled','Wi-Fi candidate retired');
      candidate.action=wifiManager.connectToCandidateConfigWithUserAction(candidate.id!);await candidate.action;this.current(call,generation);candidate.userAccepted=true;this.connected(1,generation);await answer;
    }catch(error){candidate.retired=true;candidate.finish(error as Object);await this.releaseCandidate(candidate);throw error as Error;}
  }
  private releaseCandidate(candidate:Candidate):Promise<void> {
    if(!this.candidates.has(candidate))return Promise.resolve();if(candidate.releasing!==null)return candidate.releasing;
    const task=(async():Promise<void>=>{
      candidate.retired=true;candidate.finish(new HarmonyApiError('cancelled','Wi-Fi candidate owner retired'));
      await candidate.acquisition.catch(():number=>-1);if(candidate.action!==null)await candidate.action.catch(():void=>{});
      if(candidate.id!==null&&!candidate.removed){await wifiManager.removeCandidateConfig(candidate.id);candidate.removed=true;}
      this.candidates.delete(candidate);if(processCandidate===candidate)processCandidate=null;
    })();candidate.releasing=task.finally(():void=>{candidate.releasing=null;});return candidate.releasing;
  }
  private utf8(value:string):number {let size=0;for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code<128)size++;else if(code<2048)size+=2;else if(code>=0xD800&&code<=0xDBFF&&i+1<value.length&&value.charCodeAt(i+1)>=0xDC00&&value.charCodeAt(i+1)<=0xDFFF){size+=4;i++;}else size+=3;}return size;}
  private background(task:Promise<void>):void {const tracked=task.catch((error:Object):void=>console.error('WEAPP_WIFI_CLEANUP '+String(error))).then(():void=>{this.backgroundDrains.delete(tracked);});this.backgroundDrains.add(tracked);}
  private stop():Promise<void> {
    if(this.stopping!==null)return this.stopping;
    this.opened=false;this.generation++;
    const task=Promise.resolve().then(async():Promise<void>=>{
    const errors:Array<Object>=[];const tasks:Array<Promise<void>>=[];
    for(const scan of this.scans){scan.retired=true;scan.finish(new HarmonyApiError('cancelled','Wi-Fi owner stopped'));tasks.push(this.releaseScan(scan));}
    for(const candidate of this.candidates){candidate.retired=true;candidate.finish(new HarmonyApiError('cancelled','Wi-Fi owner stopped'));tasks.push(this.releaseCandidate(candidate));}
    if(this.connectionRegistered&&this.connectionListener!==null)try{wifiManager.off('wifiConnectionChange',this.connectionListener);this.connectionRegistered=false;}catch(error){errors.push(error as Object);}
    if(this.permissionRegistered&&this.permissionListener!==null)try{this.manager.off('selfPermissionStateChange',this.permissions,this.permissionListener);this.permissionRegistered=false;}catch(error){errors.push(error as Object);}
    await Promise.all(tasks.map((task:Promise<void>):Promise<void>=>task.catch((error:Object):void=>{errors.push(error);})));if(errors.length>0)throw new Error('ERR_ENGINE: Wi-Fi native release remains pending');
    });this.stopping=task.finally(():void=>{this.stopping=null;});return this.stopping;
  }
  close():Promise<void> {
    if(this.closeComplete)return Promise.resolve();if(this.closing!==null)return this.closing;
    this.closed=true;this.subscriptions.clear();
    const task=(async():Promise<void>=>{await this.stop();await Promise.all(Array.from(this.backgroundDrains));this.closeComplete=true;})();
    this.closing=task.finally(():void=>{this.closing=null;});return this.closing;
  }
}
