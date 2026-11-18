import { HarmonyHostServices, HarmonyHostServicesConfig, HarmonyApiCall, HarmonyApiContext, HarmonyApiError, HarmonyCallCancellation } from './HostServices';

/** Dedicated, native-only account backend transport. Never install it as the
 * guest wx.request adapter or return its bearer to a mini-program. */
export interface HarmonyAccountTransport {
  request(path: string, body: Object, call: HarmonyApiCall): Promise<Object>;
  close(): Promise<void>;
}
export interface HarmonyAuthorizationPolicy { kind: string; purpose: string; permissionVersion: string; }
export interface HarmonyIdentityState {
  hostLoggedIn: boolean; appLoggedIn: boolean; profileAuthorized: boolean; phoneAuthorized: boolean;
  authorizationVersion?: string;
}
export interface HarmonyIdentityHooks {
  confirm: (policy: HarmonyAuthorizationPolicy, call: HarmonyApiCall) => Promise<boolean>;
  // Initiate the manager's replacement synchronously, but do not await its
  // retirement from inside the retiring execution owner's own handler.
  logoutApplication: () => void;
}
interface IdentitySubscription { call: HarmonyApiCall; sequence: number; }
interface IdentityOptions { subscriptionId?: string; action?: string; }
interface ProfileResult { userInfo: Object; }
interface ReferenceCode { code: string; expiresIn: number; }
interface HostSelection { miniAppId: string; packRoot: string; expectedPrincipalId: string | null; expectedPrincipalEpoch: string; }
interface ConsentSelection extends HostSelection { kind: string; granted: boolean; purpose: string; permissionVersion: string; }
interface PolicySelection extends HostSelection { kind: string; }

export function harmonyHostSelection(call: HarmonyApiCall): HostSelection {
  const application=call.context.application,account=call.context.account;
  return {miniAppId:application.appId,packRoot:application.packRoot,expectedPrincipalId:account.principalId,expectedPrincipalEpoch:account.epoch};
}
function current(call: HarmonyApiCall): void {if(call.cancellation.cancelled)throw new HarmonyApiError('cancelled','account execution owner retired');}
function stateValue(value: Object, context: HarmonyApiContext): HarmonyIdentityState {
  const state=value as HarmonyIdentityState;
  if(typeof state.hostLoggedIn!=='boolean'||typeof state.appLoggedIn!=='boolean'||typeof state.profileAuthorized!=='boolean'||typeof state.phoneAuthorized!=='boolean'||state.hostLoggedIn!==(context.account.principalId!==null)||!state.hostLoggedIn&&(state.appLoggedIn||state.profileAuthorized||state.phoneAuthorized))throw new HarmonyApiError('invalid_request','backend returned an invalid account identity state');
  // Do not copy host profile/private backend fields into a synchronous snapshot.
  const result:HarmonyIdentityState={hostLoggedIn:state.hostLoggedIn,appLoggedIn:state.appLoggedIn,profileAuthorized:state.profileAuthorized,phoneAuthorized:state.phoneAuthorized};
  if(typeof state.authorizationVersion==='string')result.authorizationVersion=state.authorizationVersion;
  return result;
}
function codeValue(value: Object): ReferenceCode {
  const code=value as ReferenceCode;
  if(typeof code.code!=='string'||code.code.length===0||code.code.length>1024||!Number.isInteger(code.expiresIn)||code.expiresIn<0||code.expiresIn>60)throw new HarmonyApiError('invalid_request','backend returned an invalid one-time code');
  return {code:code.code,expiresIn:code.expiresIn};
}

/** Installs real reference-service endpoints. prepare() must finish before
 * configure/load, so synchronous identity reads never wait on network/UI. */
export class HarmonyReferenceIdentity {
  readonly potentialApis: Array<string> = ['weappContainer.identity.getState','component:button.open-type.getPhoneNumber'];
  readonly supportedApis: Array<string> = [
    'wx.login','wx.checkSession','wx.getUserInfo','wx.getUserProfile',
    'weappContainer.identity.authorizePhone','weappContainer.identity.logout',
    'weappContainer.identity.onChange','weappContainer.identity.offChange',
  ];
  private readonly services: HarmonyHostServices;
  private readonly backend: HarmonyAccountTransport;
  private readonly hooks: HarmonyIdentityHooks;
  private readonly subscriptions: Map<string,IdentitySubscription> = new Map();
  private readonly preparation: HarmonyCallCancellation = new HarmonyCallCancellation();
  private readonly pending: Set<Promise<Object>> = new Set();
  private prepared: boolean = false;
  private closed: boolean = false;
  private consentPending: boolean = false;
  private refreshSequence: number = 0;
  private appliedSequence: number = 0;
  private preparationTask: Promise<void> | null = null;
  constructor(services: HarmonyHostServices, backend: HarmonyAccountTransport, hooks: HarmonyIdentityHooks) {
    this.services=services;this.backend=backend;this.hooks=hooks;
    for(const api of this.supportedApis)services.registerApiHandler(api,(payload:Object,call:HarmonyApiCall):Promise<Object>=>this.invoke(api,payload as IdentityOptions,call));
    // The core's real button gesture dispatches authorizePhone and emits the
    // getphonenumber event. This is a component marker, not wx.getPhoneNumber.
    services.declareNativeApi('component:button.open-type.getPhoneNumber');
    services.onClose(async():Promise<void>=>{
      this.closed=true;this.preparation.cancel();this.subscriptions.clear();
      await this.backend.close();
      if(this.preparationTask!==null)await this.preparationTask.catch(():void=>{});
      while(this.pending.size>0)await Promise.all(Array.from(this.pending).map((task:Promise<Object>):Promise<void>=>task.then(():void=>{},():void=>{})));
    });
  }
  prepare(configuration: HarmonyHostServicesConfig): Promise<void> {
    if(this.preparationTask!==null)return this.preparationTask;
    if(this.prepared||this.closed)throw new HarmonyApiError('cancelled','identity preparation owner is unavailable');
    const copied=JSON.parse(JSON.stringify(configuration)) as HarmonyHostServicesConfig;
    const context:HarmonyApiContext={application:copied.application,account:copied.account,sessionId:'native-preflight',callId:'identity-preflight',api:'weappContainer.identity.getState'};
    const call:HarmonyApiCall={context,cancellation:this.preparation};
    const task=(async():Promise<void>=>{
      const value=copied.account.principalId===null?{hostLoggedIn:false,appLoggedIn:false,profileAuthorized:false,phoneAuthorized:false}:await this.request('/v1/host/identity-state',harmonyHostSelection(call),call);
      this.ensure(call);this.services.setSyncSnapshot('weappContainer.identity.getState',stateValue(value,context));this.prepared=true;
    })();this.preparationTask=task;return task;
  }
  /** Refresh after app-backend code redemption, consent revocation, credential
   * refresh or foreground recovery, using a current native call context. */
  async refresh(call: HarmonyApiCall): Promise<HarmonyIdentityState> {
    this.ensure(call);const sequence=++this.refreshSequence;
    const state=stateValue(await this.request('/v1/host/identity-state',harmonyHostSelection(call),call),call.context);this.ensure(call);
    // A late earlier read cannot overwrite a newer authorization snapshot.
    if(sequence<this.appliedSequence)return state;
    this.appliedSequence=sequence;this.services.updateSyncSnapshots({'weappContainer.identity.getState':state});
    for(const [id,subscription] of this.subscriptions){
      if(subscription.call.cancellation.cancelled){this.subscriptions.delete(id);continue;}
      if(!this.services.emit(subscription.call.context,id,++subscription.sequence,'IdentityChange',state)){this.subscriptions.delete(id);this.services.release(subscription.call.context);}
    }
    return state;
  }
  private ensure(call: HarmonyApiCall): void {current(call);if(this.closed)throw new HarmonyApiError('cancelled','account adapter retired');}
  private request(path: string, body: Object, call: HarmonyApiCall): Promise<Object> {
    this.ensure(call);const task=this.backend.request(path,body,call);this.pending.add(task);
    task.then(():void=>{this.pending.delete(task);},():void=>{this.pending.delete(task);});return task;
  }
  private async invoke(api: string, options: IdentityOptions, call: HarmonyApiCall): Promise<Object> {
    this.ensure(call);if(!this.prepared)throw new HarmonyApiError('invalid_request','prepare the trusted identity snapshot before loading');
    if(api.endsWith('.onChange')||api.endsWith('.offChange')){
      const id=options.subscriptionId;if(typeof id!=='string'||id.length===0)throw new HarmonyApiError('invalid_request','runtime subscription identity required');
      if(api.endsWith('.offChange')||options.action==='unsubscribe')this.subscriptions.delete(id);
      else{if(this.subscriptions.size>=256)throw new HarmonyApiError('invalid_request','identity subscription limit');const entry:IdentitySubscription={call,sequence:0};this.subscriptions.set(id,entry);call.cancellation.retainUntilCancelled();call.cancellation.onCancel(():void=>{if(this.subscriptions.get(id)===entry)this.subscriptions.delete(id);});}
      return {};
    }
    if(call.context.account.principalId===null)throw new HarmonyApiError('permission_denied','host login required',2001,`${api}:fail host login required`);
    const selection=harmonyHostSelection(call);
    if(api==='wx.login'){const code=codeValue(await this.request('/v1/host/login-codes',selection,call));await this.refresh(call);return code;}
    if(api==='wx.checkSession'){
      try{const result=await this.request('/v1/host/check-session',selection,call);this.ensure(call);return result;}
      catch(error){if(!call.cancellation.cancelled){try{await this.refresh(call);}catch{this.ensure(call);}}throw error;}
    }
    if(api==='weappContainer.identity.logout'){
      await this.request('/v1/host/app-logout',selection,call);await this.refresh(call);this.ensure(call);
      this.hooks.logoutApplication();return {};
    }
    if(api==='wx.getUserInfo')return this.profile(call);
    const phone=api==='weappContainer.identity.authorizePhone',kind=phone?'phone':'profile';
    if(this.consentPending)throw new HarmonyApiError('invalid_request','another identity authorization UI is active');
    this.consentPending=true;
    try{
      const query:PolicySelection={...selection,kind};
      const policy=await this.request('/v1/host/authorization-policy',query,call) as HarmonyAuthorizationPolicy;this.ensure(call);
      if(policy.kind!==kind||typeof policy.purpose!=='string'||policy.purpose.length===0||policy.purpose.length>512||typeof policy.permissionVersion!=='string'||policy.permissionVersion.length===0||policy.permissionVersion.length>64)throw new HarmonyApiError('invalid_request','invalid registered disclosure policy');
      const granted=await this.hooks.confirm({kind,purpose:policy.purpose,permissionVersion:policy.permissionVersion},call);this.ensure(call);
      if(typeof granted!=='boolean')throw new HarmonyApiError('invalid_request','authorization requires an explicit decision');
      const consent:ConsentSelection={...selection,kind,granted,purpose:policy.purpose,permissionVersion:policy.permissionVersion};
      await this.request('/v1/host/consents',consent,call);this.ensure(call);
      if(!granted){await this.refresh(call);throw new HarmonyApiError('permission_denied','user denied disclosure',2001,`${api.replace(/^wx\./,'')}:fail auth deny`);}
      const result=phone?codeValue(await this.request('/v1/host/phone-codes',selection,call)):await this.profile(call);
      await this.refresh(call);return result;
    }finally{this.consentPending=false;}
  }
  private async profile(call: HarmonyApiCall): Promise<ProfileResult> {
    const profile=await this.request('/v1/host/profile',harmonyHostSelection(call),call) as Record<string,Object>;this.ensure(call);
    const userInfo:Record<string,Object>={};for(const name of ['nickName','avatarUrl'])if(typeof profile[name]==='string')userInfo[name]=profile[name];
    return {userInfo};
  }
}

export interface HarmonyPaymentLaunch { orderId: string; channel: string; product: string; status: string; launch?: Object; }
export interface HarmonyNativePaymentChannel {
  channel: string; product: string; kind: string;
  // Resolve only when the official UI/SDK callback is terminal. Wallet success
  // is still followed by signed backend confirmation. No automatic UI retry.
  pay: (launch: Object, call: HarmonyApiCall) => Promise<void>;
}
interface PaymentOptions { orderId?: string; }
interface PaymentResult { orderId: string; serverConfirmed: boolean; }
interface LaunchKind { kind?: string; }
interface PaymentWaiter { call: HarmonyApiCall; cancel: () => void; }
let activeWallet: boolean = false;

/** Explicit channel injection, including Harmony's official SDK supplied by the
 * host. No channels means no payment API is advertised or registered. */
export class HarmonyReferencePayments {
  readonly supportedApis: Array<string> = ['wx.requestPayment','weappContainer.payment.request'];
  private readonly channels: Map<string,HarmonyNativePaymentChannel> = new Map();
  private readonly backend: HarmonyAccountTransport;
  private closed: boolean = false;
  private readonly waiters: Set<PaymentWaiter> = new Set();
  constructor(services: HarmonyHostServices,backend: HarmonyAccountTransport,channels: Array<HarmonyNativePaymentChannel>) {
    this.backend=backend;
    for(const channel of channels){const key=JSON.stringify([channel.channel,channel.product]);if(!channel.channel||!channel.product||!channel.kind||this.channels.has(key))throw new HarmonyApiError('invalid_request','unique explicitly configured payment channel/product required');this.channels.set(key,channel);}
    if(channels.length>0)for(const api of this.supportedApis)services.registerApiHandler(api,(payload:Object,call:HarmonyApiCall):Promise<Object>=>this.request(payload as PaymentOptions,call));
    services.onClose(async():Promise<void>=>{this.closed=true;for(const waiter of this.waiters)waiter.cancel();this.waiters.clear();await this.backend.close();});
  }
  private ensure(call: HarmonyApiCall): void {current(call);if(this.closed)throw new HarmonyApiError('cancelled','payment caller retired; submitted transactions may still complete');}
  private async order(orderId: string, call: HarmonyApiCall): Promise<HarmonyPaymentLaunch> {
    this.ensure(call);const order=await this.backend.request(`/v1/payments/orders/${orderId}/launch`,harmonyHostSelection(call),call) as HarmonyPaymentLaunch;this.ensure(call);
    if(order.orderId!==orderId||typeof order.status!=='string'||typeof order.channel!=='string'||typeof order.product!=='string')throw new HarmonyApiError('invalid_request','invalid backend order reference');return order;
  }
  private async request(options: PaymentOptions, call: HarmonyApiCall): Promise<PaymentResult> {
    this.ensure(call);const orderId=options.orderId;
    if(typeof orderId!=='string'||! /^[A-Za-z0-9-]{1,128}$/.test(orderId)||Object.keys(options).some((key:string):boolean=>key!=='orderId'&&key!=='timeout'))throw new HarmonyApiError('invalid_request','pass a trusted orderId; guest signatures cannot launch native APP Pay');
    const order=await this.order(orderId,call);
    if(order.status==='paid')return {orderId,serverConfirmed:true};
    if(order.status!=='pending')throw new HarmonyApiError('invalid_request',`backend reports order ${order.status}`);
    const channel=this.channels.get(JSON.stringify([order.channel,order.product]));
    if(channel===undefined||order.launch===undefined||(order.launch as LaunchKind).kind!==channel.kind)throw new HarmonyApiError('unsupported','official payment channel/product is not configured');
    if(activeWallet)throw new HarmonyApiError('invalid_request','another official payment UI is active');activeWallet=true;
    // A financial transaction can outlive its caller. Release the JS execution
    // wait on cancellation, but reserve the process-wide wallet callback until
    // its real terminal, so it cannot be assigned to a replacement account.
    const launch=order.launch;
    const payment=Promise.resolve().then(async():Promise<void>=>{this.ensure(call);await channel.pay(launch,call);});
    const terminal=payment.then(():void=>{activeWallet=false;},(error:Error):void=>{activeWallet=false;throw error;});
    await new Promise<void>((resolve,reject):void=>{
      call.cancellation.onCancel(():void=>{reject(new HarmonyApiError('cancelled','stopped waiting; submitted wallet transaction may still complete'));});
      terminal.then(resolve,reject);
    });
    this.ensure(call);
    for(let attempt=0;attempt<21;attempt++){
      const confirmed=await this.order(orderId,call);
      if(confirmed.status==='paid')return {orderId,serverConfirmed:true};
      if(confirmed.status!=='pending')throw new HarmonyApiError('invalid_request',`backend reports order ${confirmed.status}`);
      if(attempt<20)await this.delay(call);
    }
    throw new HarmonyApiError('timeout',`server confirmation pending for ${orderId}; query this order before another payment`);
  }
  private delay(call: HarmonyApiCall): Promise<void> {
    return new Promise<void>((resolve,reject):void=>{
      let settled=false,timer:number=-1;
      const waiter:PaymentWaiter={call,cancel:():void=>{if(settled)return;settled=true;if(timer>=0)clearTimeout(timer);this.waiters.delete(waiter);reject(new HarmonyApiError('cancelled','stopped waiting; financial transaction is unchanged'));}};
      this.waiters.add(waiter);call.cancellation.onCancel(waiter.cancel);
      if(!settled)timer=setTimeout(():void=>{if(settled)return;settled=true;this.waiters.delete(waiter);resolve();},500);
    });
  }
}
