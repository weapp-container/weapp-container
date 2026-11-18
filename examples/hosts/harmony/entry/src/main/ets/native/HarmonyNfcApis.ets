import common from '@ohos.app.ability.common';
import abilityAccessCtrl from '@ohos.abilityAccessCtrl';
import tag from '@ohos.nfc.tag';
import nfcController from '@ohos.nfc.controller';
import { BusinessError } from '@ohos.base';
import bundleManager from '@ohos.bundle.bundleManager';
import { UIContext } from '@ohos.arkui.UIContext';
import { HarmonyHostServices, HarmonyApiCall, HarmonyApiError } from '../session/HostServices';
import { HarmonyDisclosurePrompts } from '../session/DisclosurePrompts';
import { HarmonyNfcDisclosureDriver } from './HarmonyNfcDisclosure';

export interface HarmonyNfcConfiguration {
  purpose: string; permissionVersion: string; exclusiveForegroundDispatch: boolean; technologies: Array<string>;
}
interface BinaryBytes { type: string; bytes: Array<number>; }
interface BinaryValue { __weappBinary: BinaryBytes; }
interface NdefRecordValue { tnf: number; type: BinaryValue; id: BinaryValue; payload: BinaryValue; }
interface NdefValue { records: Array<NdefRecordValue>; }
interface NfcOptions {
  objectId?: string; receiverId?: string; subscriptionId?: string; action?: string; timeout?: number;
  data?: BinaryValue; texts?: Array<string>; uris?: Array<string>; records?: Array<NdefRecordValue>;
}
interface NfcResult {
  errMsg?: string; objectId?: string; properties?: NfcProperties; isConnected?: boolean; length?: number;
  histBytes?: BinaryValue; atqa?: BinaryValue; sak?: number; data?: BinaryValue;
  id?: BinaryValue; techs?: Array<string>; messages?: Array<NdefValue>; records?: Array<NdefRecordValue>;
}
interface NfcProperties { tech: Record<string,string>; }
interface Adapter { id: string; call: HarmonyApiCall; }
interface StartIntent { adapter: Adapter; }
interface Child { id: string; parent: string; call: HarmonyApiCall; technology: string; epoch: number | null; message: NdefValue | null; }
interface Subscription { id: string; object: string; call: HarmonyApiCall; event: string; sequence: number; }
interface Connection {
  child: Child; reader: Reader; native: tag.TagSession; retired: boolean; reset: boolean;
  pending: Set<Promise<void>>; closing: Promise<void> | null;
}
interface Reader {
  adapter: Adapter; element: bundleManager.ElementName; active: boolean; registered: boolean; radioRegistered: boolean; permissionRegistered: boolean;
  callback: (error: BusinessError, info: tag.TagInfo) => void; radio: (state: nfcController.NfcState) => void; permission: () => void;
  latest: tag.TagInfo | null; info: tag.TagInfo | null; epoch: number; loop: Promise<void> | null;
  connection: Connection | null; retiredConnections: Set<Connection>; closing: Promise<void> | null;
}
const technologyNames: Array<string> = ['Ndef','IsoDep','MifareClassic','MifareUltralight','NfcA','NfcB','NfcF','NfcV'];
const technologyValues: Array<string> = ['NDEF','ISO_DEP','MIFARE_CLASSIC','MIFARE_ULTRALIGHT','NFC_A','NFC_B','NFC_F','NFC_V'];
// Source inventory only. Runtime registration below remains configuration scoped.
// The finite adapter test proves exact equality with all eight selected technologies.
export const potentialApis: Array<string> = [
  'object:IsoDep.close', 'object:IsoDep.connect', 'object:IsoDep.getHistoricalBytes',
  'object:IsoDep.getMaxTransceiveLength', 'object:IsoDep.isConnected', 'object:IsoDep.setTimeout', 'object:IsoDep.transceive',
  'object:MifareClassic.close', 'object:MifareClassic.connect', 'object:MifareClassic.getMaxTransceiveLength',
  'object:MifareClassic.isConnected', 'object:MifareClassic.setTimeout', 'object:MifareClassic.transceive',
  'object:MifareUltralight.close', 'object:MifareUltralight.connect', 'object:MifareUltralight.getMaxTransceiveLength',
  'object:MifareUltralight.isConnected', 'object:MifareUltralight.setTimeout', 'object:MifareUltralight.transceive',
  'object:Ndef.close', 'object:Ndef.connect', 'object:Ndef.isConnected', 'object:Ndef.offNdefMessage',
  'object:Ndef.onNdefMessage', 'object:Ndef.setTimeout', 'object:Ndef.writeNdefMessage',
  'object:NfcA.close', 'object:NfcA.connect', 'object:NfcA.getAtqa', 'object:NfcA.getMaxTransceiveLength',
  'object:NfcA.getSak', 'object:NfcA.isConnected', 'object:NfcA.setTimeout', 'object:NfcA.transceive',
  'object:NFCAdapter.getIsoDep', 'object:NFCAdapter.getMifareClassic', 'object:NFCAdapter.getMifareUltralight',
  'object:NFCAdapter.getNdef', 'object:NFCAdapter.getNfcA', 'object:NFCAdapter.getNfcB',
  'object:NFCAdapter.getNfcF', 'object:NFCAdapter.getNfcV', 'object:NFCAdapter.offDiscovered',
  'object:NFCAdapter.onDiscovered', 'object:NFCAdapter.startDiscovery', 'object:NFCAdapter.stopDiscovery', 'object:NFCAdapter.tech',
  'object:NfcB.close', 'object:NfcB.connect', 'object:NfcB.getMaxTransceiveLength', 'object:NfcB.isConnected',
  'object:NfcB.setTimeout', 'object:NfcB.transceive',
  'object:NfcF.close', 'object:NfcF.connect', 'object:NfcF.getMaxTransceiveLength', 'object:NfcF.isConnected',
  'object:NfcF.setTimeout', 'object:NfcF.transceive',
  'object:NfcV.close', 'object:NfcV.connect', 'object:NfcV.getMaxTransceiveLength', 'object:NfcV.isConnected',
  'object:NfcV.setTimeout', 'object:NfcV.transceive', 'wx.getNFCAdapter',
];
let configuredNfc: HarmonyNfcConfiguration | null = null;
// Dispatch is addressed by Ability but the native N-API callback registry is
// process wide. The host handoff excludes every other UIAbility/native NFC
// dispatcher in this process; this lease coordinates only this SDK's owners.
let processReader: Reader | null = null;

function copyConfiguration(configuration:HarmonyNfcConfiguration):HarmonyNfcConfiguration {
  if(configuration.exclusiveForegroundDispatch!==true||typeof configuration.purpose!=='string'||!configuration.purpose.trim()||configuration.purpose.length>512||typeof configuration.permissionVersion!=='string'||!configuration.permissionVersion.trim()||configuration.permissionVersion.length>64||!Array.isArray(configuration.technologies)||configuration.technologies.length===0||configuration.technologies.length>8||new Set(configuration.technologies).size!==configuration.technologies.length||configuration.technologies.some((name:string):boolean=>!technologyNames.includes(name)))throw new Error('ERR_INVALID_REQUEST: explicit NFC purpose/version, technologies and exclusive foreground dispatch required');
  return {purpose:configuration.purpose,permissionVersion:configuration.permissionVersion,exclusiveForegroundDispatch:true,technologies:configuration.technologies.slice()};
}
export function configureHarmonyNfc(configuration: HarmonyNfcConfiguration | null): void {
  if(configuration===null){configuredNfc=null;return;}
  configuredNfc=copyConfiguration(configuration);
}
export function installHarmonyNfcApis(context: common.UIAbilityContext,services: HarmonyHostServices,ui: UIContext): HarmonyNfcApis | null {
  if(configuredNfc===null||!canIUse('SystemCapability.Communication.NFC.Tag')||!canIUse('SystemCapability.Communication.NFC.Core'))return null;
  const configuration=configuredNfc,prompts=new HarmonyDisclosurePrompts(services,new HarmonyNfcDisclosureDriver(ui));
  return new HarmonyNfcApis(context,services,configuration,(call:HarmonyApiCall):Promise<boolean>=>prompts.confirm({kind:'nfc',purpose:configuration.purpose,permissionVersion:configuration.permissionVersion},call));
}

/** API24 tag sessions. Native callbacks only enqueue through HarmonyHostServices.
 * resetConnection is an owned logical session reset, never an I/O terminal ACK. */
export class HarmonyNfcApis {
  private readonly services: HarmonyHostServices;
  private readonly configuration: HarmonyNfcConfiguration;
  private readonly element: bundleManager.ElementName;
  private readonly confirm: (call:HarmonyApiCall) => Promise<boolean>;
  private readonly manager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
  private readonly adapters: Map<string,Adapter> = new Map();
  private readonly children: Map<string,Child> = new Map();
  private readonly subscriptions: Map<string,Subscription> = new Map();
  private readonly readers: Set<Reader> = new Set();
  private readonly backgroundDrains: Set<Promise<void>> = new Set();
  private closed: boolean = false; private foreground: boolean = true; private epoch: number = 0;
  private starting: StartIntent | null = null; private closing: Promise<void> | null = null;
  readonly supportedApis: Array<string> = ['wx.getNFCAdapter','object:NFCAdapter.tech','object:NFCAdapter.startDiscovery','object:NFCAdapter.stopDiscovery','object:NFCAdapter.onDiscovered','object:NFCAdapter.offDiscovered'];
  constructor(context:common.UIAbilityContext,services:HarmonyHostServices,configuration:HarmonyNfcConfiguration,confirm:(call:HarmonyApiCall)=>Promise<boolean>) {
    this.services=services;this.configuration=copyConfiguration(configuration);this.confirm=confirm;
    this.element={bundleName:context.abilityInfo.bundleName,abilityName:context.abilityInfo.name,moduleName:context.abilityInfo.moduleName};
    if(!this.element.bundleName||!this.element.abilityName)throw new Error('NFC requires a real UIAbility ElementName');
    for(const technology of this.configuration.technologies){
      this.addSupportedApi('object:NFCAdapter.get'+technology);
      const methods=technology==='Ndef'?['connect','close','isConnected','setTimeout','writeNdefMessage','onNdefMessage','offNdefMessage']:['connect','close','isConnected','setTimeout','transceive','getMaxTransceiveLength',...(technology==='IsoDep'?['getHistoricalBytes']:[]),...(technology==='NfcA'?['getAtqa','getSak']:[])];
      for(const method of methods)this.addSupportedApi('object:'+technology+'.'+method);
    }
    for(const api of this.supportedApis)services.registerApiHandler(api,async(payload:Object,call:HarmonyApiCall):Promise<Object>=>{
      try{return await this.invoke(api,payload as NfcOptions,call);}catch(error){if(error instanceof HarmonyApiError)throw error;const native=error as BusinessError;throw new HarmonyApiError(native.code===201?'permission_denied':native.code===801?'unsupported':'invalid_request',native.message||String(error),native.code||-1,api+':fail '+(native.message||String(error)));}
    });
    services.onForeground((visible:boolean):void=>{this.foreground=visible;if(!visible){this.epoch++;this.starting=null;this.background(this.stopAll());}});
    services.onClose(():Promise<void>=>this.close());
  }
  private addSupportedApi(api:string):void{if(!potentialApis.includes(api))throw new Error('NFC API missing from audited inventory: '+api);this.supportedApis.push(api);}
  private fail(message:string,category:string='invalid_request'):HarmonyApiError{return new HarmonyApiError(category,message,-1,'NFC:fail '+message);}
  private ok(api:string,result:NfcResult={}):NfcResult{result.errMsg=api.replace(/^wx\./,'')+':ok';return result;}
  private current(call:HarmonyApiCall,epoch:number=this.epoch):void{if(this.closed||!this.foreground||epoch!==this.epoch||call.cancellation.cancelled)throw this.fail('NFC owner retired','cancelled');}
  private sameOwner(a:HarmonyApiCall,b:HarmonyApiCall):boolean{return a.context.sessionId===b.context.sessionId&&a.context.account.epoch===b.context.account.epoch&&a.context.account.principalId===b.context.account.principalId;}
  private permitted():void{if(this.manager.getSelfPermissionStatus('ohos.permission.NFC_TAG')!==abilityAccessCtrl.PermissionStatus.GRANTED)throw this.fail('ohos.permission.NFC_TAG is not granted','permission_denied');}
  private bytes(value:BinaryValue):Array<number>{if(value===undefined||value.__weappBinary===undefined||value.__weappBinary.type!=='ArrayBuffer')throw this.fail('ArrayBuffer required');return this.validBytes(value.__weappBinary.bytes);}
  private validBytes(value:Array<number>,limit:number=1048576):Array<number>{if(!Array.isArray(value)||value.length>limit||value.some((byte:number):boolean=>!Number.isInteger(byte)||byte<0||byte>255))throw this.fail('invalid or oversized native binary value');return value.slice();}
  private binary(value:Array<number>):BinaryValue{return {__weappBinary:{type:'ArrayBuffer',bytes:this.validBytes(value)}};}
  private techIds():Array<number>{return [tag.NDEF,tag.ISO_DEP,tag.MIFARE_CLASSIC,tag.MIFARE_ULTRALIGHT,tag.NFC_A,tag.NFC_B,tag.NFC_F,tag.NFC_V];}
  private properties():NfcProperties{const values:Record<string,string>={};for(const technology of this.configuration.technologies){const index=technologyNames.indexOf(technology);const key=technology.substring(0,1).toLowerCase()+technology.substring(1);values[key]=technologyValues[index];}return {tech:values};}
  private reader(parent:string):Reader|undefined{return Array.from(this.readers).find((value:Reader):boolean=>value.adapter.id===parent);}
  private async invoke(api:string,value:NfcOptions,call:HarmonyApiCall):Promise<NfcResult>{
    this.current(call);const id=value.objectId;if(typeof id!=='string'||!id||id.length>256)throw this.fail('objectId required');
    if(api==='wx.getNFCAdapter'){
      if(this.adapters.size>=16||this.adapters.has(id)||this.children.has(id))throw this.fail('NFC adapter limit or duplicate ID');
      const adapter:Adapter={id,call};this.adapters.set(id,adapter);call.cancellation.retainUntilCancelled();
      call.cancellation.onCancel(async():Promise<void>=>{if(this.starting?.adapter===adapter)this.starting=null;const reader=this.reader(id);if(reader!==undefined)await this.releaseReader(reader);this.adapters.delete(id);for(const child of this.children.values())if(child.parent===id)this.forgetChild(child);for(const subscription of this.subscriptions.values())if(subscription.object===id)this.subscriptions.delete(subscription.id);});
      return this.ok(api,{objectId:id,properties:this.properties()});
    }
    if(api.startsWith('object:NFCAdapter.get')){
      const parent=value.receiverId,adapter=parent===undefined?undefined:this.adapters.get(parent),technology=api.substring('object:NFCAdapter.get'.length);
      if(adapter===undefined||!this.sameOwner(adapter.call,call)||!this.configuration.technologies.includes(technology)||this.children.has(id)||this.adapters.has(id)||this.children.size>=32)throw this.fail('NFC technology factory is not owned');
      const reader=this.reader(adapter.id),child:Child={id,parent:adapter.id,call,technology,epoch:reader?.info===null||reader===undefined?null:reader.epoch,message:null};this.children.set(id,child);call.cancellation.retainUntilCancelled();
      call.cancellation.onCancel(async():Promise<void>=>{const owned=this.reader(child.parent);if(owned?.connection?.child===child)await this.releaseConnection(owned.connection);this.forgetChild(child);});
      return this.ok(api,{objectId:id});
    }
    const child=this.children.get(id),parent=api.startsWith('object:NFCAdapter.')?id:child?.parent,adapter=parent===undefined?undefined:this.adapters.get(parent);
    if(adapter===undefined||!this.sameOwner(adapter.call,call)||child!==undefined&&!this.sameOwner(child.call,call))throw this.fail('NFC object retired','cancelled');
    if(child!==undefined&&!api.startsWith('object:'+child.technology+'.'))throw this.fail('NFC object technology does not match this API');
    if(api.includes('.on')||api.includes('.off')){
      const subscription=value.subscriptionId;if(typeof subscription!=='string'||!subscription||subscription.length>256)throw this.fail('subscriptionId required');
      if(api.includes('.off')||value.action==='unsubscribe')this.subscriptions.delete(subscription);
      else{
        if(this.subscriptions.size>=256)throw this.fail('NFC subscription limit');
        const event=child===undefined?'Discovered':'NdefMessage',record:Subscription={id:subscription,object:id,call,event,sequence:0};this.subscriptions.set(subscription,record);call.cancellation.retainUntilCancelled();call.cancellation.onCancel(():void=>{if(this.subscriptions.get(subscription)===record)this.subscriptions.delete(subscription);});
        const reader=this.reader(adapter.id);if(child!==undefined&&child.message!==null&&reader!==undefined&&child.epoch===reader.epoch)this.emit(reader,'NdefMessage',child.message,id,child);
      }return this.ok(api);
    }
    if(api==='object:NFCAdapter.tech')return this.ok(api);
    if(api==='object:NFCAdapter.startDiscovery'){await this.start(adapter,call);return this.ok(api);}
    if(api==='object:NFCAdapter.stopDiscovery'){if(this.starting?.adapter===adapter)this.starting=null;const reader=this.reader(adapter.id);if(reader!==undefined)await this.releaseReader(reader);return this.ok(api);}
    if(child===undefined)throw this.fail('NFC technology object retired','cancelled');
    const reader=this.reader(child.parent);if(reader===undefined||!reader.active||reader.info===null)throw this.fail('discover an NFC tag first');
    if(child.epoch===null)child.epoch=reader.epoch;if(child.epoch!==reader.epoch)throw this.fail('NFC object belongs to a retired tag','cancelled');
    this.permitted();const native=this.native(child.technology,reader.info),method=api.substring(api.lastIndexOf('.')+1);
    if(method==='getMaxTransceiveLength'){const length=native.getMaxTransmitSize();if(!Number.isInteger(length)||length<1)throw this.fail('native maximum unavailable');return this.ok(api,{length});}
    if(method==='getHistoricalBytes')return this.ok(api,{histBytes:this.binary((native as tag.IsoDepTag).getHistoricalBytes())});
    if(method==='getAtqa')return this.ok(api,{atqa:this.binary((native as tag.NfcATag).getAtqa())});
    if(method==='getSak'){const sak=(native as tag.NfcATag).getSak();if(!Number.isInteger(sak)||sak<0||sak>255)throw this.fail('invalid native SAK');return this.ok(api,{sak});}
    const existing=reader.connection;
    if(method==='isConnected')return this.ok(api,{isConnected:existing?.child===child&&!existing.retired?existing.native.isConnected():native.isConnected()});
    if(method==='close'){if(existing?.child===child)await this.releaseConnection(existing);return this.ok(api);}
    if(existing!==null&&existing.child!==child)throw this.fail('another NFC technology owns the native tag');
    if(method==='setTimeout'&&(value.timeout===undefined||!Number.isFinite(value.timeout)||!Number.isInteger(value.timeout)||value.timeout<100||value.timeout>30000))throw this.fail('timeout must be an integer 100...30000 ms');
    if(existing===null&&method!=='connect'&&method!=='setTimeout')throw this.fail('connect the NFC technology first');
    const connection=existing===null?this.connection(reader,child,native):existing;
    if(connection.retired||connection.pending.size>0)throw this.fail('native NFC operation or cleanup is pending');
    if(method==='setTimeout'){const timeout=value.timeout;if(timeout===undefined||!Number.isFinite(timeout)||!Number.isInteger(timeout)||timeout<100||timeout>30000)throw this.fail('timeout must be an integer 100...30000 ms');connection.native.setTimeout(timeout);return this.ok(api);}
    if(method==='connect'){
      connection.native.connect();if(!connection.native.isConnected())throw this.fail('native tag did not connect');
      if(child.technology==='Ndef'){const message=await this.operation(connection,call,():Promise<tag.NdefMessage>=>(connection.native as tag.NdefTag).readNdef());this.current(call);if(connection.retired||child.epoch!==reader.epoch)throw this.fail('NDEF tag retired','cancelled');child.message=this.ndefValue(message);this.emit(reader,'NdefMessage',child.message,id,child);}
      return this.ok(api);
    }
    if(!connection.native.isConnected())throw this.fail('connect the NFC technology first');
    if(method==='transceive'){const data=this.bytes(value.data!),maximum=connection.native.getMaxTransmitSize();if(!Number.isInteger(maximum)||maximum<1||data.length===0||data.length>maximum)throw this.fail('raw data exceeds actual native maximum');const result=await this.operation(connection,call,():Promise<Array<number>>=>connection.native.transmit(data));this.current(call);if(connection.retired)throw this.fail('NFC tag retired','cancelled');return this.ok(api,{data:this.binary(result)});}
    if(method==='writeNdefMessage'){const message=this.ndefMessage(value);await this.operation(connection,call,():Promise<void>=>(connection.native as tag.NdefTag).writeNdef(message));this.current(call);if(connection.retired)throw this.fail('NFC tag retired','cancelled');return this.ok(api);}
    throw this.fail('NFC leaf is not installed','unsupported');
  }
  private native(technology:string,info:tag.TagInfo):tag.TagSession{
    const index=technologyNames.indexOf(technology);if(index<0||!info.technology.includes(this.techIds()[index]))throw this.fail('actual tag does not support this technology','unsupported');
    switch(technology){case 'Ndef':return tag.getNdef(info);case 'IsoDep':return tag.getIsoDep(info);case 'MifareClassic':return tag.getMifareClassic(info);case 'MifareUltralight':return tag.getMifareUltralight(info);case 'NfcA':return tag.getNfcA(info);case 'NfcB':return tag.getNfcB(info);case 'NfcF':return tag.getNfcF(info);case 'NfcV':return tag.getNfcV(info);default:throw this.fail('unknown NFC technology','unsupported');}
  }
  private connection(reader:Reader,child:Child,native:tag.TagSession):Connection{const value:Connection={child,reader,native,retired:false,reset:false,pending:new Set(),closing:null};reader.connection=value;return value;}
  private forgetChild(child:Child):void{this.children.delete(child.id);for(const subscription of this.subscriptions.values())if(subscription.object===child.id)this.subscriptions.delete(subscription.id);}
  private async operation<T>(connection:Connection,call:HarmonyApiCall,run:()=>Promise<T>):Promise<T>{
    if(connection.pending.size>0||connection.retired)throw this.fail('native NFC operation is already active');
    call.cancellation.onCancel(():Promise<void>=>this.releaseReader(connection.reader));
    const operation=Promise.resolve().then(():Promise<T>=>{this.current(call);if(connection.retired)throw this.fail('NFC connection retired','cancelled');return run();});
    const terminal=operation.then(():void=>{},():void=>{});connection.pending.add(terminal);
    try{return await operation;}finally{connection.pending.delete(terminal);}
  }
  private async start(adapter:Adapter,call:HarmonyApiCall):Promise<void>{
    const old=this.reader(adapter.id);if(old!==undefined){if(old.active)return;throw this.fail('previous NFC reader cleanup is pending');}
    if(this.starting!==null||processReader!==null)throw this.fail('foreground NFC dispatch is already owned');
    const intent:StartIntent={adapter},epoch=this.epoch;this.starting=intent;
    try{
      if(!await this.confirm(call))throw this.fail('NFC disclosure denied','permission_denied');this.current(call,epoch);if(this.starting!==intent||this.adapters.get(adapter.id)!==adapter)throw this.fail('NFC start retired','cancelled');
      this.permitted();if(nfcController.getNfcState()!==nfcController.NfcState.STATE_ON)throw this.fail('system NFC is not enabled');if(processReader!==null)throw this.fail('foreground NFC dispatch is already owned');
      const reader:Reader={adapter,element:this.element,active:true,registered:false,radioRegistered:false,permissionRegistered:false,callback:():void=>{},radio:():void=>{},permission:():void=>{},latest:null,info:null,epoch:++this.epoch,loop:null,connection:null,retiredConnections:new Set(),closing:null};
      reader.callback=(error:BusinessError,info:tag.TagInfo):void=>{if(!this.readerCurrent(reader))return;if(error!==undefined&&error!==null&&error.code!==0){this.background(this.releaseReader(reader));return;}try{this.validBytes(info.uid,256);if(!Array.isArray(info.technology)||info.technology.length>16||info.technology.some((value:number):boolean=>!Number.isInteger(value)||value<0||value>255))throw this.fail('invalid native tag technology list');}catch{this.background(this.releaseReader(reader));return;}reader.latest=info;if(reader.loop===null)this.consume(reader);};
      reader.radio=(state:nfcController.NfcState):void=>{if(state!==nfcController.NfcState.STATE_ON)this.background(this.releaseReader(reader));};
      reader.permission=():void=>{try{this.permitted();}catch{this.background(this.releaseReader(reader));}};
      processReader=reader;this.readers.add(reader);call.cancellation.onCancel(():Promise<void>=>this.releaseReader(reader));
      try{
        nfcController.on('nfcStateChange',reader.radio);reader.radioRegistered=true;
        this.manager.on('selfPermissionStateChange',['ohos.permission.NFC_TAG'],reader.permission);reader.permissionRegistered=true;
        tag.registerForegroundDispatch(reader.element,[tag.NFC_A,tag.NFC_B,tag.NFC_F,tag.NFC_V],reader.callback);reader.registered=true;
      }catch(error){await this.releaseReader(reader);throw error as Error;}
    }finally{if(this.starting===intent)this.starting=null;}
  }
  private readerCurrent(reader:Reader):boolean{return !this.closed&&this.foreground&&reader.active&&processReader===reader&&!reader.adapter.call.cancellation.cancelled&&this.adapters.get(reader.adapter.id)===reader.adapter;}
  private consume(reader:Reader):void{
    const task=(async():Promise<void>=>{
      while(reader.latest!==null&&this.readerCurrent(reader)){
        const info=reader.latest;reader.latest=null;reader.info=null;reader.epoch=++this.epoch;
        if(reader.connection!==null)await this.releaseConnection(reader.connection);if(!this.readerCurrent(reader))return;
        reader.info=info;const result:NfcResult={id:this.binary(info.uid),techs:info.technology.map((value:number):string=>{const index=this.techIds().indexOf(value);return index<0?'':technologyValues[index];}).filter((value:string):boolean=>value!=='')};
        if(info.technology.includes(tag.NDEF)&&this.configuration.technologies.includes('Ndef')){try{result.messages=[this.ndefValue(tag.getNdef(info).getNdefMessage())];}catch(error){console.warn('WEAPP_NFC_CACHED_MESSAGE '+String(error));}}
        if(!this.emit(reader,'Discovered',result,reader.adapter.id)){this.background(this.releaseReader(reader));return;}
      }
    })();reader.loop=task;
    void task.catch((error:Object):void=>{console.error('WEAPP_NFC_DISCOVERY '+String(error));this.background(this.releaseReader(reader));}).then(():void=>{if(reader.loop===task)reader.loop=null;if(reader.latest!==null&&this.readerCurrent(reader))this.consume(reader);});
  }
  private ndefValue(message:tag.NdefMessage):NdefValue{
    const records=message.getNdefRecords();if(records.length>64)throw this.fail('too many native NDEF records');let size=0;
    const result:Array<NdefRecordValue>=records.map((record:tag.NdefRecord):NdefRecordValue=>{const type=this.validBytes(record.rtdType,255),id=this.validBytes(record.id,255),payload=this.validBytes(record.payload);size+=type.length+id.length+payload.length;if(size>1048576||!Number.isInteger(record.tnf)||record.tnf<0||record.tnf>7)throw this.fail('invalid or oversized native NDEF message');return {tnf:record.tnf,type:this.binary(type),id:this.binary(id),payload:this.binary(payload)};});return {records:result};
  }
  private ndefMessage(value:NfcOptions):tag.NdefMessage{
    const records:Array<tag.NdefRecord>=[];const texts=value.texts||[],uris=value.uris||[],raw=value.records||[];
    let size=0;const append=(record:tag.NdefRecord):void=>{size+=record.rtdType.length+record.id.length+record.payload.length+10;if(size>1048576)throw this.fail('NDEF message exceeds 1 MiB');records.push(record);};
    if(!Array.isArray(texts)||!Array.isArray(uris)||!Array.isArray(raw)||texts.length+uris.length+raw.length<1||texts.length+uris.length+raw.length>64)throw this.fail('NDEF requires 1...64 records');
    for(const text of texts){if(typeof text!=='string'||text.length>262144)throw this.fail('invalid NDEF text');append(tag.ndef.makeTextRecord(text,'en'));}
    for(const uri of uris){if(typeof uri!=='string'||uri.length>262144)throw this.fail('invalid NDEF URI');append(tag.ndef.makeUriRecord(uri));}
    for(const record of raw){if(!Number.isInteger(record.tnf)||record.tnf<0||record.tnf>7)throw this.fail('invalid NDEF TNF');append({tnf:record.tnf,rtdType:this.validBytes(this.bytes(record.type),255),id:this.validBytes(this.bytes(record.id),255),payload:this.bytes(record.payload)});}
    const message=tag.ndef.createNdefMessage(records);if(tag.ndef.messageToBytes(message).length>1048576)throw this.fail('NDEF message exceeds 1 MiB');return message;
  }
  private emit(reader:Reader,event:string,value:NfcResult|NdefValue,object:string,child?:Child):boolean{
    const epoch=reader.epoch;
    for(const subscription of this.subscriptions.values())if(subscription.object===object&&subscription.event===event&&!subscription.call.cancellation.cancelled){
      if(!this.services.emit(subscription.call.context,subscription.id,++subscription.sequence,event,value,object,():boolean=>this.readerCurrent(reader)&&reader.epoch===epoch&&this.subscriptions.get(subscription.id)===subscription&&!subscription.call.cancellation.cancelled&&(child===undefined||this.children.get(child.id)===child&&child.epoch===epoch))){this.background(this.releaseReader(reader));return false;}
    }return true;
  }
  private releaseConnection(connection:Connection):Promise<void>{
    connection.retired=true;connection.reader.retiredConnections.add(connection);if(connection.closing!==null)return connection.closing;
    const task=(async():Promise<void>=>{
      let failure:Object|null=null;if(!connection.reset)try{connection.native.resetConnection();connection.reset=true;}catch(error){failure=error as Object;}
      while(connection.pending.size>0)await Promise.all(Array.from(connection.pending));
      if(failure!==null)throw failure as Error;if(connection.native.isConnected()){connection.reset=false;throw this.fail('native tag session did not close');}
      if(connection.reader.connection===connection)connection.reader.connection=null;connection.reader.retiredConnections.delete(connection);
    })();connection.closing=task.finally(():void=>{connection.closing=null;});return connection.closing;
  }
  private releaseReader(reader:Reader):Promise<void>{
    if(!this.readers.has(reader))return Promise.resolve();
    reader.active=false;reader.latest=null;reader.info=null;reader.epoch=++this.epoch;if(reader.closing!==null)return reader.closing;
    const task=(async():Promise<void>=>{
      const failures:Array<Object>=[];
      if(reader.registered)try{tag.unregisterForegroundDispatch(reader.element);reader.registered=false;}catch(error){failures.push(error as Object);}
      if(reader.radioRegistered)try{nfcController.off('nfcStateChange',reader.radio);reader.radioRegistered=false;}catch(error){failures.push(error as Object);}
      if(reader.permissionRegistered)try{this.manager.off('selfPermissionStateChange',['ohos.permission.NFC_TAG'],reader.permission);reader.permissionRegistered=false;}catch(error){failures.push(error as Object);}
      const connections=new Set<Connection>(Array.from(reader.retiredConnections));if(reader.connection!==null)connections.add(reader.connection);
      for(const connection of connections)try{await this.releaseConnection(connection);}catch(error){failures.push(error as Object);}
      if(reader.loop!==null)await reader.loop.catch(():void=>{});
      if(failures.length>0)throw this.fail('native NFC resources require cleanup retry');
      this.readers.delete(reader);if(processReader===reader)processReader=null;
    })();reader.closing=task.finally(():void=>{reader.closing=null;});return reader.closing;
  }
  private background(task:Promise<void>):void{const tracked=task.catch((error:Object):void=>console.error('WEAPP_NFC_CLEANUP '+String(error))).then(():void=>{this.backgroundDrains.delete(tracked);});this.backgroundDrains.add(tracked);}
  private async stopAll():Promise<void>{const failures:Array<Object>=[];for(const reader of this.readers)try{await this.releaseReader(reader);}catch(error){failures.push(error as Object);}if(failures.length>0)throw this.fail('native NFC readers require cleanup retry');}
  close():Promise<void>{if(this.closing!==null)return this.closing;this.closed=true;this.foreground=false;this.epoch++;this.starting=null;const task=(async():Promise<void>=>{await this.stopAll();await Promise.all(Array.from(this.backgroundDrains));this.adapters.clear();this.children.clear();this.subscriptions.clear();})();this.closing=task.finally(():void=>{this.closing=null;});return this.closing;}
}
