import { HarmonyHostServices, HarmonyApiCall, HarmonyApiError } from './HostServices';
import { HarmonyAuthorizationPolicy } from './ReferenceHostServices';

export interface HarmonyDisclosureModel { appId: string; publisherId: string; kind: string; purpose: string; permissionVersion: string; }
export interface HarmonyDisclosureHandle {
  show(): Promise<void>;
  // Resolves only after this exact native dialog disappeared and its content
  // was disposed. Failed close retains the same handle for a later retry.
  close(): Promise<void>;
}
export interface HarmonyDisclosureDriver {
  create(model: HarmonyDisclosureModel, decision: (granted: boolean) => void, dismissed: () => void): HarmonyDisclosureHandle;
}
interface DisclosureRecord {
  handle: HarmonyDisclosureHandle; call: HarmonyApiCall; opening: Promise<void>;
  closing: Promise<void> | null; retired: boolean; settled: boolean; choice: boolean | null;
  resolve: (granted: boolean) => void; reject: (error: Object) => void;
}
let processDisclosureLease: Object | null = null;

/** Owns account-bound UI independently of its native drawing component. The
 * host service drain includes exact dialog dismissal and retryable disposal. */
export class HarmonyDisclosurePrompts {
  private readonly driver: HarmonyDisclosureDriver;
  private readonly records: Set<DisclosureRecord> = new Set();
  private closed: boolean = false;
  constructor(services: HarmonyHostServices, driver: HarmonyDisclosureDriver) {
    this.driver=driver;
    services.onClose(async():Promise<void>=>{
      this.closed=true;const attempts:Array<Promise<void>>=[];
      for(const record of this.records){record.retired=true;this.reject(record,new HarmonyApiError('cancelled','identity disclosure owner retired'));attempts.push(this.release(record));}
      const errors:Array<Object>=[];await Promise.all(attempts.map((task:Promise<void>):Promise<void>=>task.catch((error:Object):void=>{errors.push(error);})));if(errors.length>0)throw new Error('ERR_ENGINE: native disclosure UI requires cleanup retry');
    });
  }
  confirm(policy: HarmonyAuthorizationPolicy, call: HarmonyApiCall): Promise<boolean> {
    if(this.closed||call.cancellation.cancelled)return Promise.reject(new HarmonyApiError('cancelled','disclosure owner retired'));
    if(processDisclosureLease!==null)return Promise.reject(new HarmonyApiError('invalid_request','another identity disclosure dialog is active'));
    const lease:Object={};processDisclosureLease=lease;
    let accept:(granted:boolean)=>void=():void=>{},fail:(error:Object)=>void=():void=>{};
    const answer=new Promise<boolean>((resolve,reject):void=>{accept=resolve;fail=reject;});
    let record:DisclosureRecord|null=null;
    try{
      const model:HarmonyDisclosureModel={appId:call.context.application.appId,publisherId:call.context.application.publisherId,kind:policy.kind,purpose:policy.purpose,permissionVersion:policy.permissionVersion};
      const handle=this.driver.create(model,(granted:boolean):void=>{
        if(record===null||record.retired||record.settled||record.choice!==null||record.call.cancellation.cancelled)return;
        record.choice=granted;this.release(record).catch((error:Object):void=>{if(record!==null)this.reject(record,error);});
      },():void=>{
        if(record===null||record.choice!==null||record.settled)return;
        record.retired=true;this.reject(record,new HarmonyApiError('cancelled','identity disclosure dismissed'));
        this.release(record).catch(():void=>{}); // exact retained action is retried by onClose
      });
      record={handle,call,opening:Promise.resolve(),closing:null,retired:false,settled:false,choice:null,resolve:accept,reject:fail};
      const owned=record;this.records.add(owned);
      // Attach the retryable release before show(): revocation may occur while
      // native UI creation is pending and must still dismiss the resulting UI.
      call.cancellation.onCancel(async():Promise<void>=>{owned.retired=true;this.reject(owned,new HarmonyApiError('cancelled','identity disclosure owner retired'));await this.release(owned);});
      owned.opening=Promise.resolve().then(async():Promise<void>=>{if(!owned.retired)await owned.handle.show();});
      owned.opening.catch((error:Object):void=>{owned.retired=true;this.reject(owned,error);this.release(owned).catch(():void=>{});});
    }catch(error){if(processDisclosureLease===lease)processDisclosureLease=null;fail(error as Object);}
    return answer;
  }
  private reject(record: DisclosureRecord,error: Object): void {if(record.settled)return;record.settled=true;record.reject(error);}
  private release(record: DisclosureRecord): Promise<void> {
    if(!this.records.has(record))return Promise.resolve();if(record.closing!==null)return record.closing;
    const task=(async():Promise<void>=>{
      await record.opening.catch(():void=>{});await record.handle.close();
      this.records.delete(record);processDisclosureLease=null;
      if(!record.settled){record.settled=true;if(!record.retired&&!record.call.cancellation.cancelled&&record.choice!==null)record.resolve(record.choice);else record.reject(new HarmonyApiError('cancelled','identity disclosure owner retired'));}
    })();record.closing=task.finally(():void=>{record.closing=null;});return record.closing;
  }
}
