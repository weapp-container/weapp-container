import type { HarmonyApplicationIdentity, HarmonyHostAccount } from './HostServices';
import type { HarmonyLiveSession } from './LiveSession';

export interface HarmonyAccountLaunch { route?: string; query?: Record<string,string>; scene?: number; extra?: Object; }
export interface HarmonyAccountFailure { code: string; message: string; }
export interface HarmonyAccountControllerReceipt {
  operationId: string; epoch: string; phase: string; error: HarmonyAccountFailure | null;
}
export interface HarmonyAccountOperationReceipt {
  operationId: string; epoch: string; status: string; controllers: Array<HarmonyAccountControllerReceipt>;
}
export interface HarmonyAccountControllerState {
  phase: string; inputEnabled: boolean; sessionIncarnation: number | null;
  operation: HarmonyAccountControllerReceipt | null;
}
export class HarmonyAccountError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message);this.code=code; }
}
export class HarmonyAccountCancellation {
  cancelled: boolean = false;
  private readonly listeners: Set<() => void> = new Set();
  readonly failures: Array<HarmonyAccountFailure> = [];
  onCancel(listener: () => void): () => void {
    if(this.cancelled)this.notify(listener);else this.listeners.add(listener);
    return ():void=>{this.listeners.delete(listener);};
  }
  cancel(): void {if(this.cancelled)return;this.cancelled=true;for(const listener of this.listeners)this.notify(listener);this.listeners.clear();}
  private notify(listener: () => void): void {try{listener();}catch(error){this.failures.push(accountFailure(error as Error));}}
}
export interface HarmonyAccountOwnerContext {
  application: HarmonyApplicationIdentity; account: HarmonyHostAccount; sessionId: string;
  operationId: string; sessionIncarnation: number; storageScope: string; launchOptions: HarmonyAccountLaunch;
  appAuthorized: boolean; cancellation: HarmonyAccountCancellation;
  requestLogout: (launchOptions?: HarmonyAccountLaunch) => Promise<HarmonyAccountOperationReceipt>;
  grantApplication: () => void;
}
/** Factory constructs an unstarted session using createWeappContainer(),
 * reinstalls adapters and fonts, and supplies its real presentation waiter. */
export interface HarmonyAccountExecutionOwner {
  session: HarmonyLiveSession;
  waitForPresentation: (cancellation: HarmonyAccountCancellation) => Promise<void>;
  invoke: (method: string, payload: Object) => Promise<Object>;
}
export type HarmonyAccountOwnerFactory = (context: HarmonyAccountOwnerContext) => Promise<HarmonyAccountExecutionOwner>;
export interface HarmonyAccountAttachOptions {
  application: HarmonyApplicationIdentity; createOwner: HarmonyAccountOwnerFactory;
  launchOptions?: HarmonyAccountLaunch; initialSessionId?: string; onState?: (state: HarmonyAccountControllerState) => void;
}
export interface HarmonyAccountBackend {
  revokeBackend: (principalId: string) => Promise<void>;
  clearLocalData: (application: HarmonyApplicationIdentity, principalId: string, storageScope: string) => Promise<void>;
}
interface ControllerReplacement { account: HarmonyHostAccount; operationId: string; launchOptions: HarmonyAccountLaunch; appAuthorized: boolean; }
interface ControllerLaunch { controller: HarmonyAccountController; launch: HarmonyAccountLaunch; }
let managerSequence: number = 0;

function ensure(value: boolean, message: string, code: string = 'ERR_INVALID_REQUEST'): void {if(!value)throw new HarmonyAccountError(code,message);}
function accountFailure(error: Error): HarmonyAccountFailure {return {code:error instanceof HarmonyAccountError?error.code:'ERR_ENGINE',message:error.message||String(error)};}
function accountCopy(account: HarmonyHostAccount): HarmonyHostAccount {return {principalId:account.principalId,epoch:account.epoch};}
function applicationCopy(application: HarmonyApplicationIdentity): HarmonyApplicationIdentity {return {hostAppId:application.hostAppId,tenantId:application.tenantId,publisherId:application.publisherId,appId:application.appId,environment:application.environment,version:application.version,packRoot:application.packRoot};}
function validateJson(value: Object | null | undefined, seen: Set<Object>, depth: number): void {
  ensure(depth<=64,'host launch JSON nesting exceeds the limit');
  if(value===null||typeof value==='string'||typeof value==='boolean')return;
  if(typeof value==='number'){ensure(Number.isFinite(value as number),'host launch JSON numbers must be finite');return;}
  ensure(value!==undefined&&typeof value==='object','host launch options must contain JSON values');
  const object=value as Object;ensure(!seen.has(object),'host launch options contain a circular value');seen.add(object);
  if(Array.isArray(object)){for(const item of object as Array<Object|null|undefined>)validateJson(item,seen,depth+1);}
  else{
    const prototype=Object.getPrototypeOf(object);ensure(prototype===Object.prototype||prototype===null,'host launch options require plain JSON objects');
    ensure(Object.getOwnPropertySymbols(object).length===0,'host launch options cannot contain symbol keys');
    const record=object as Record<string,Object|null|undefined>;for(const key of Object.keys(object))validateJson(record[key],seen,depth+1);
  }
  seen.delete(object);
}
function jsonObjectCopy(value: Object, message: string): Record<string,Object> {
  ensure(value!==null&&typeof value==='object'&&!Array.isArray(value),message);validateJson(value,new Set(),0);
  return JSON.parse(JSON.stringify(value)) as Record<string,Object>;
}
function launchCopy(launch: HarmonyAccountLaunch): HarmonyAccountLaunch {
  const value=jsonObjectCopy(launch,'host launch options must be a JSON object');
  if(Object.prototype.hasOwnProperty.call(value,'route'))ensure(typeof value.route==='string'&&(value.route as string).length>0,'host launch route must be a non-empty string');
  if(Object.prototype.hasOwnProperty.call(value,'query')){const query=value.query;ensure(query!==null&&typeof query==='object'&&!Array.isArray(query),'host launch query must be an object');for(const item of Object.values(query))ensure(typeof item==='string','host launch query values must be strings');}
  if(Object.prototype.hasOwnProperty.call(value,'scene'))ensure(typeof value.scene==='number'&&Number.isSafeInteger(value.scene as number)&&(value.scene as number)>=0,'host launch scene must be a nonnegative safe integer');
  if(Object.prototype.hasOwnProperty.call(value,'extra'))ensure(value.extra!==null&&typeof value.extra==='object'&&!Array.isArray(value.extra),'host launch extra must be a JSON object');
  return value as HarmonyAccountLaunch;
}
function receiptCopy(receipt: HarmonyAccountControllerReceipt): HarmonyAccountControllerReceipt {return JSON.parse(JSON.stringify(receipt)) as HarmonyAccountControllerReceipt;}
function operationCopy(receipt: HarmonyAccountOperationReceipt): HarmonyAccountOperationReceipt {return JSON.parse(JSON.stringify(receipt)) as HarmonyAccountOperationReceipt;}
function validateAccount(account: HarmonyHostAccount): void {
  ensure(typeof account.epoch==='string'&&/^[1-9][0-9]{0,19}$/.test(account.epoch)&&(account.epoch.length<20||account.epoch<='18446744073709551615'),'account epoch must be a canonical positive u64 decimal string');
  ensure(account.principalId===null||typeof account.principalId==='string'&&account.principalId.length>0&&account.principalId.length<=1024,'opaque account principalId required');
}
function laterEpoch(next: string, previous: string): boolean {return next.length>previous.length||next.length===previous.length&&next>previous;}
function nextEpoch(epoch: string): string {
  ensure(epoch!=='18446744073709551615','account epoch exhausted');let result='',carry=1;
  for(let index=epoch.length-1;index>=0;index--){const value=Number(epoch[index])+carry;result=String(value%10)+result;carry=value>=10?1:0;}
  return carry>0?'1'+result:result;
}
function applicationDomain(application: HarmonyApplicationIdentity): string {return JSON.stringify([application.hostAppId,application.tenantId]);}
function validateApplication(application: HarmonyApplicationIdentity): void {
  const fields:Array<string>=[application.hostAppId,application.tenantId,application.publisherId,application.appId,application.environment,application.version];
  ensure(fields.every((value:string):boolean=>typeof value==='string'&&value.length>0)&&/^[a-f0-9]{64}$/.test(application.packRoot),'trusted installation identity and accepted pack root required');
}
/** Diagnostic framing only. The Rust owner computes and locks actual private
 * directories. Version/pack upgrades preserve this application/user scope. */
export function harmonyStorageScope(application: HarmonyApplicationIdentity, account: HarmonyHostAccount): string {
  return JSON.stringify(['weapp-account-v1',application.hostAppId,application.tenantId,application.publisherId,application.appId,application.environment,account.principalId]);
}

export class HarmonyHostAccountManager {
  private value: HarmonyHostAccount;
  private readonly controllers: Set<HarmonyAccountController> = new Set();
  private readonly applications: Map<string,HarmonyApplicationIdentity> = new Map();
  private readonly operations: Map<string,HarmonyAccountOperationReceipt> = new Map();
  private readonly grants: Map<string,boolean> = new Map();
  private readonly listeners: Set<(account: HarmonyHostAccount) => void> = new Set();
  private readonly deleting: Map<string,Promise<void>> = new Map();
  private domain: string | null = null;
  private revision: number = 0;
  private readonly managerId: string = `harmony-account-manager-${Date.now()}-${++managerSequence}`;
  private readonly backend: HarmonyAccountBackend | null;
  lastObserverError: HarmonyAccountFailure | null = null;
  constructor(account: HarmonyHostAccount, backend: HarmonyAccountBackend | null = null) {validateAccount(account);this.value=accountCopy(account);this.backend=backend;}
  get account(): HarmonyHostAccount {return accountCopy(this.value);}
  attach(options: HarmonyAccountAttachOptions): HarmonyAccountController {
    const launch=launchCopy(options.launchOptions===undefined?{}:options.launchOptions);
    this.acceptApplication(options.application);ensure(typeof options.createOwner==='function','fresh execution owner factory required');
    if(options.initialSessionId!==undefined)ensure(typeof options.initialSessionId==='string'&&options.initialSessionId.length>0&&options.initialSessionId.length<=256,'explicit initial session identity must be a bounded non-empty string');
    const controller=new HarmonyAccountController(this,`${this.managerId}-controller-${++this.revision}`,applicationCopy(options.application),options.createOwner,options.onState||(():void=>{}),options.initialSessionId);
    this.controllers.add(controller);
    controller.replace({account:this.account,operationId:`initial-${this.revision}`,launchOptions:launch,appAuthorized:this.applicationAuthorized(options.application)});
    return controller;
  }
  switchAccount(account: HarmonyHostAccount, launches: Record<string,HarmonyAccountLaunch> = {}): Promise<HarmonyAccountOperationReceipt> {
    const launchMap=new Map<string,HarmonyAccountLaunch>();const values=jsonObjectCopy(launches,'host launches must be an object keyed by application id');for(const key of Object.keys(values))launchMap.set(key,launchCopy(values[key] as HarmonyAccountLaunch));
    validateAccount(account);ensure(account.principalId===null||!this.deleting.has(account.principalId),'this principal is being deleted','ERR_IDENTITY_SWITCHING');
    if(account.principalId===this.value.principalId&&account.epoch===this.value.epoch)return Promise.resolve({operationId:'unchanged',epoch:account.epoch,status:'complete',controllers:[]});
    ensure(laterEpoch(account.epoch,this.value.epoch),'account changes require a strictly greater epoch','ERR_STALE_ACCOUNT_EPOCH');
    const prepared:Array<ControllerLaunch>=[];for(const controller of this.controllers)prepared.push({controller,launch:launchCopy(launchMap.get(controller.application.appId)||{})});
    this.value=accountCopy(account);
    const receipt:HarmonyAccountOperationReceipt={operationId:`account-${account.epoch}-${++this.revision}`,epoch:account.epoch,status:'running',controllers:[]};this.rememberOperation(receipt);
    const replacements:Array<Promise<HarmonyAccountControllerReceipt>>=[];
    // replace() synchronously revokes current AND awaiting-presentation owners
    // for every controller before this method returns its first Promise.
    for(const item of prepared){const controller=item.controller;replacements.push(controller.isClosed()?controller.close().then(():HarmonyAccountControllerReceipt=>{return {operationId:receipt.operationId,epoch:account.epoch,phase:'complete',error:null};},(error:Error):HarmonyAccountControllerReceipt=>{return {operationId:receipt.operationId,epoch:account.epoch,phase:'failed',error:accountFailure(error)};}):controller.replace({account:accountCopy(account),operationId:receipt.operationId,launchOptions:item.launch,appAuthorized:this.applicationAuthorized(controller.application)}));}
    this.notify();return this.finishOperation(receipt,replacements);
  }
  query(operationId: string): HarmonyAccountOperationReceipt | null {const receipt=this.operations.get(operationId);return receipt===undefined?null:operationCopy(receipt);}
  applicationAuthorized(application: HarmonyApplicationIdentity): boolean {return this.value.principalId!==null&&this.grants.get(harmonyStorageScope(application,this.value))===true;}
  grantApplication(application: HarmonyApplicationIdentity): void {this.acceptApplication(application);ensure(this.value.principalId!==null,'host account must be logged in','ERR_PERMISSION_DENIED');this.grants.set(harmonyStorageScope(application,this.value),true);this.notify();}
  logoutApplication(application: HarmonyApplicationIdentity, launchOptions: HarmonyAccountLaunch = {}): Promise<HarmonyAccountOperationReceipt> {
    const launch=launchCopy(launchOptions);this.acceptApplication(application);const account=this.account,scope=harmonyStorageScope(application,account);this.grants.set(scope,false);
    const receipt:HarmonyAccountOperationReceipt={operationId:`app-logout-${++this.revision}`,epoch:account.epoch,status:'running',controllers:[]};this.rememberOperation(receipt);
    const replacements:Array<Promise<HarmonyAccountControllerReceipt>>=[];
    for(const controller of this.controllers)if(harmonyStorageScope(controller.application,account)===scope&&!controller.isClosed())replacements.push(controller.replace({account:accountCopy(account),operationId:receipt.operationId,launchOptions:launchCopy(launch),appAuthorized:false}));
    this.notify();return this.finishOperation(receipt,replacements);
  }
  onChange(listener: (account: HarmonyHostAccount) => void): () => void {this.listeners.add(listener);return ():void=>{this.listeners.delete(listener);};}
  async refreshCredentials(refresh: (account: HarmonyHostAccount, current: () => boolean) => Promise<void>): Promise<void> {
    const account=this.account,current=():boolean=>account.principalId===this.value.principalId&&account.epoch===this.value.epoch;
    await refresh(accountCopy(account),current);ensure(current(),'credential refresh belongs to a retired account','ERR_CANCELLED');
  }
  deleteAccount(principalId: string, launches: Record<string,HarmonyAccountLaunch> = {}): Promise<void> {
    ensure(typeof principalId==='string'&&principalId.length>0,'principalId required');ensure(this.backend!==null,'explicit backend revocation and local-data deletion callbacks required');
    const existing=this.deleting.get(principalId);if(existing!==undefined)return existing;
    // Defer the body until the deletion reservation is installed. Restoring the
    // same principal while backend revocation awaits is forbidden.
    const deletion=Promise.resolve().then(async():Promise<void>=>{
      if(this.value.principalId===principalId){const receipt=await this.switchAccount({principalId:null,epoch:nextEpoch(this.value.epoch)},launches);ensure(receipt.status==='complete','retirement must finish before deleting account data','ERR_IDENTITY_SWITCHING');}
      ensure(Array.from(this.controllers).every((controller:HarmonyAccountController):boolean=>controller.isSettled()),'retained native/storage owners must drain before deleting data','ERR_IDENTITY_SWITCHING');
      const applications=Array.from(this.applications.values());await this.backend!.revokeBackend(principalId);
      ensure(Array.from(this.controllers).every((controller:HarmonyAccountController):boolean=>controller.isSettled()),'account replacement must settle before deleting data','ERR_IDENTITY_SWITCHING');
      for(const application of applications)await this.backend!.clearLocalData(applicationCopy(application),principalId,harmonyStorageScope(application,{principalId,epoch:'1'}));
      for(const application of applications)this.grants.delete(harmonyStorageScope(application,{principalId,epoch:'1'}));
    }).finally(():void=>{this.deleting.delete(principalId);});
    this.deleting.set(principalId,deletion);return deletion;
  }
  detach(controller: HarmonyAccountController): void {this.controllers.delete(controller);}
  retryRetirements(): Promise<void> {return Promise.all(Array.from(this.controllers).filter((controller:HarmonyAccountController):boolean=>controller.isClosed()).map((controller:HarmonyAccountController):Promise<void>=>controller.close())).then(():void=>{});}
  private acceptApplication(application: HarmonyApplicationIdentity): void {
    validateApplication(application);const domain=applicationDomain(application);
    if(this.domain===null)this.domain=domain;ensure(domain===this.domain,'one account manager belongs to one host/tenant domain');
    const key=harmonyStorageScope(application,{principalId:null,epoch:'1'});ensure(this.applications.has(key)||this.applications.size<4096,'known application limit');this.applications.set(key,applicationCopy(application));
  }
  private rememberOperation(receipt: HarmonyAccountOperationReceipt): void {this.operations.set(receipt.operationId,receipt);while(this.operations.size>64)this.operations.delete(this.operations.keys().next().value);}
  private finishOperation(receipt: HarmonyAccountOperationReceipt, replacements: Array<Promise<HarmonyAccountControllerReceipt>>): Promise<HarmonyAccountOperationReceipt> {
    return Promise.all(replacements).then((results:Array<HarmonyAccountControllerReceipt>):HarmonyAccountOperationReceipt=>{receipt.controllers=results;receipt.status=this.value.epoch!==receipt.epoch||results.some((result:HarmonyAccountControllerReceipt):boolean=>result.phase==='superseded')?'superseded':results.every((result:HarmonyAccountControllerReceipt):boolean=>result.phase==='complete')?'complete':'failed';this.notify();return operationCopy(receipt);});
  }
  private notify(): void {for(const listener of this.listeners){try{listener(this.account);}catch(error){this.lastObserverError=accountFailure(error as Error);}}}
}

export class HarmonyAccountController {
  private readonly manager: HarmonyHostAccountManager;
  private readonly id: string;
  private readonly identity: HarmonyApplicationIdentity;
  private readonly factory: HarmonyAccountOwnerFactory;
  private readonly observer: (state: HarmonyAccountControllerState) => void;
  private readonly initialSessionId: string | undefined;
  private readonly retired: Set<HarmonyAccountExecutionOwner> = new Set();
  private readonly receipts: Map<string,HarmonyAccountControllerReceipt> = new Map();
  private owner: HarmonyAccountExecutionOwner | null = null;
  private cancellation: HarmonyAccountCancellation | null = null;
  private phase: string = 'empty';
  private receipt: HarmonyAccountControllerReceipt | null = null;
  private tail: Promise<void> = Promise.resolve();
  private wait: Promise<HarmonyAccountControllerReceipt> | null = null;
  private closed: boolean = false;
  private closeComplete: boolean = false;
  private closing: Promise<void> | null = null;
  private incarnation: number = 0;
  private launch: HarmonyAccountLaunch = {};
  lastObserverError: HarmonyAccountFailure | null = null;
  constructor(manager: HarmonyHostAccountManager,id: string,application: HarmonyApplicationIdentity,factory: HarmonyAccountOwnerFactory,observer: (state: HarmonyAccountControllerState) => void,initialSessionId?: string) {this.manager=manager;this.id=id;this.identity=applicationCopy(application);this.factory=factory;this.observer=observer;this.initialSessionId=initialSessionId;}
  get application(): HarmonyApplicationIdentity {return applicationCopy(this.identity);}
  get state(): HarmonyAccountControllerState {return {phase:this.closed?'closed':this.phase,inputEnabled:this.allowed(),sessionIncarnation:this.allowed()?this.incarnation:null,operation:this.receipt===null?null:receiptCopy(this.receipt)};}
  get ready(): Promise<HarmonyAccountControllerReceipt> {return this.wait||Promise.resolve({operationId:'empty',epoch:this.manager.account.epoch,phase:this.phase,error:null});}
  isClosed(): boolean {return this.closed;}
  isSettled(): boolean {return this.closeComplete||!this.closed&&this.phase==='complete'&&this.retired.size===0&&this.owner!==null;}
  query(operationId: string): HarmonyAccountControllerReceipt | null {const receipt=this.receipts.get(operationId);return receipt===undefined?null:receiptCopy(receipt);}
  replace(replacement: ControllerReplacement): Promise<HarmonyAccountControllerReceipt> {
    ensure(!this.closed,'controller is closed','ERR_CANCELLED');this.cancellation?.cancel();
    const cancellation=new HarmonyAccountCancellation();this.cancellation=cancellation;this.launch=launchCopy(replacement.launchOptions);
    const old=this.owner;this.owner=null;if(old!==null)this.retired.add(old);
    let revokeError:HarmonyAccountFailure|null=null;
    try{old?.session.revokeIdentity();}catch(error){revokeError=accountFailure(error as Error);}
    const receipt:HarmonyAccountControllerReceipt={operationId:replacement.operationId,epoch:replacement.account.epoch,phase:'revoking',error:null};this.receipt=receipt;this.publish(receipt,'revoking');
    const current=():boolean=>!this.closed&&!cancellation.cancelled&&this.cancellation===cancellation&&this.manager.account.epoch===replacement.account.epoch;
    const run=async():Promise<HarmonyAccountControllerReceipt>=>{
      let candidate:HarmonyAccountExecutionOwner|null=null,candidateRevoked=false;
      const revokeCandidate=():void=>{if(candidate!==null&&!candidateRevoked){candidate.session.revokeIdentity();candidateRevoked=true;}};
      const remove=cancellation.onCancel(revokeCandidate);
      try{
        if(this.retired.size>0){if(current())this.publish(receipt,'draining');await this.drainRetired();}
        if(revokeError!==null)throw new HarmonyAccountError(revokeError.code,revokeError.message);
        ensure(current(),'replacement superseded before factory','ERR_CANCELLED');this.publish(receipt,'starting');
        const incarnation=++this.incarnation,sessionId=incarnation===1&&this.initialSessionId!==undefined?this.initialSessionId:`${this.id}-epoch-${replacement.account.epoch}-incarnation-${incarnation}`;
        const context:HarmonyAccountOwnerContext={application:this.application,account:accountCopy(replacement.account),sessionId,operationId:replacement.operationId,sessionIncarnation:incarnation,storageScope:harmonyStorageScope(this.identity,replacement.account),launchOptions:launchCopy(replacement.launchOptions),appAuthorized:replacement.appAuthorized,cancellation,
          requestLogout:(launchOptions:HarmonyAccountLaunch={}):Promise<HarmonyAccountOperationReceipt>=>{ensure(current(),'old execution owner cannot log out its replacement','ERR_CANCELLED');return this.manager.logoutApplication(this.identity,launchOptions);},
          grantApplication:():void=>{ensure(current(),'old execution owner cannot authorize its replacement','ERR_CANCELLED');this.manager.grantApplication(this.identity);}};
        candidate=await this.factory(context);ensure(current(),'replacement superseded during factory','ERR_CANCELLED');
        const installed=candidate.session.executionIdentity();
        ensure(installed.sessionId===sessionId&&installed.hostIdentity!==null&&harmonyStorageScope(installed.hostIdentity.application,installed.hostIdentity.account)===context.storageScope&&installed.hostIdentity.application.version===this.identity.version&&installed.hostIdentity.application.packRoot===this.identity.packRoot&&installed.hostIdentity.account.epoch===replacement.account.epoch,'replacement session must bind the exact trusted application, account, epoch and fresh incarnation');
        candidate.session.start();ensure(current(),'replacement superseded during startup','ERR_CANCELLED');
        this.publish(receipt,'awaitingPresentation');await candidate.waitForPresentation(cancellation);ensure(current(),'replacement superseded before presentation','ERR_CANCELLED');
        ensure(candidate.session.isRunnable(),'replacement needs an acknowledged current frame before enabling input','ERR_RENDER');
        this.owner=candidate;candidate=null;this.publish(receipt,'complete');return receiptCopy(receipt);
      }catch(error){
        let failure=accountFailure(error as Error);
        if(candidate!==null){const abandoned=candidate;this.retired.add(abandoned);try{revokeCandidate();}catch(cleanup){failure=accountFailure(cleanup as Error);}try{await this.drainRetired();}catch(cleanup){failure=accountFailure(cleanup as Error);}}
        const superseded=this.cancellation!==cancellation||this.manager.account.epoch!==replacement.account.epoch;
        this.publish(receipt,superseded?'superseded':'failed',failure);return receiptCopy(receipt);
      }finally{remove();}
    };
    this.wait=this.tail.then(run,run);this.tail=this.wait.then(():void=>{});return this.wait;
  }
  async invoke(method: string,payload: Object = {}): Promise<Object> {
    ensure(this.allowed(),'identity switching or failed; business commands are blocked','ERR_IDENTITY_SWITCHING');
    const epoch=this.manager.account.epoch,owner=this.owner!,result=await owner.invoke(method,payload);
    ensure(this.allowed()&&this.owner===owner&&this.manager.account.epoch===epoch,'old identity result was revoked','ERR_CANCELLED');return result;
  }
  retry(launchOptions: HarmonyAccountLaunch = this.launch): Promise<HarmonyAccountControllerReceipt> {ensure(this.phase==='failed'&&!this.closed,'retry requires a failed replacement');return this.replace({account:this.manager.account,operationId:`${this.receipt!.operationId}-retry-${this.incarnation+1}`,launchOptions:launchCopy(launchOptions),appAuthorized:this.manager.applicationAuthorized(this.identity)});}
  cancel(): boolean {if(this.phase==='complete'||this.closed)return false;this.cancellation?.cancel();if(this.receipt!==null)this.publish(this.receipt,'failed',{code:'ERR_CANCELLED',message:'replacement cancelled; previous identity remains revoked'});return true;}
  close(): Promise<void> {
    if(this.closeComplete)return Promise.resolve();if(this.closing!==null)return this.closing;
    this.closed=true;this.cancellation?.cancel();const owner=this.owner;this.owner=null;if(owner!==null)this.retired.add(owner);
    let revokeError:Error|null=null;try{owner?.session.revokeIdentity();}catch(error){revokeError=error as Error;}
    const task=(async():Promise<void>=>{await this.tail;await this.drainRetired();if(revokeError!==null)throw revokeError;this.closeComplete=true;this.manager.detach(this);if(this.receipt!==null)this.publish(this.receipt,'closed');})();
    this.closing=task.finally(():void=>{this.closing=null;});return this.closing;
  }
  private allowed(): boolean {return !this.closed&&this.phase==='complete'&&this.receipt?.epoch===this.manager.account.epoch&&this.owner!==null;}
  private async drainRetired(): Promise<void> {
    const failures:Array<string>=[];
    for(const retired of this.retired){let failed=false;try{retired.session.detachSurface();}catch(error){failed=true;failures.push((error as Error).message);}try{await retired.session.closeAndDrain();}catch(error){failed=true;failures.push((error as Error).message);}if(!failed)this.retired.delete(retired);}
    if(failures.length>0)throw new HarmonyAccountError('ERR_IDENTITY_SWITCHING',`native owner retirement requires retry: ${failures.join('; ')}`);
  }
  private publish(receipt: HarmonyAccountControllerReceipt,phase: string,error: HarmonyAccountFailure | null = null): void {
    receipt.phase=phase;receipt.error=error;this.receipts.set(receipt.operationId,receiptCopy(receipt));while(this.receipts.size>64)this.receipts.delete(this.receipts.keys().next().value);
    if(this.receipt!==receipt)return;this.phase=phase;
    // Host observers may request another account. Defer notification until all
    // sibling controllers have crossed the synchronous shared-epoch gate.
    const snapshot=this.state;Promise.resolve().then(():void=>{if(this.receipt!==receipt||this.phase!==phase)return;try{this.observer(snapshot);}catch(observerError){this.lastObserverError=accountFailure(observerError as Error);}});
  }
}
