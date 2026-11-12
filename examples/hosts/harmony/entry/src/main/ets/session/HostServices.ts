/** Native callbacks enqueue records; only the owning ArkTS executor drains into
 * N-API/QuickJS. Account credentials never enter this protocol. */
export interface HarmonyHostServicesRuntime { hostServices(commandJson: string): string; }
export interface HarmonyApplicationIdentity {
  hostAppId: string; tenantId: string; publisherId: string; appId: string;
  environment: string; version: string; packRoot: string;
}
export interface HarmonyHostAccount { principalId: string | null; epoch: string; }
export interface HarmonyHostServicesConfig { application: HarmonyApplicationIdentity; account: HarmonyHostAccount; }
export interface HarmonyApiContext {
  sessionId: string; api: string; application: HarmonyApplicationIdentity; account: HarmonyHostAccount;
  callId: string; deadlineNs?: string; cancelToken?: string;
}
export interface HarmonyApiFailure { code: string; message: string; retryable: boolean; details: Object; }
export class HarmonyApiError extends Error {
  readonly category: string; readonly errCode: number; readonly errMsg: string;
  constructor(category: string, message: string, errCode: number = -1, errMsg: string = message) { super(message); this.category=category;this.errCode=errCode;this.errMsg=errMsg; }
}
interface HostRequest {
  kind: string; callId: string; method: string; payload: Object;
  context: HarmonyApiContext; deadlineNs?: string;
}
interface HostRequests { requests: Array<HostRequest>; }
interface Protocol { version: string; trustedContext: boolean; ownerThreadCompletion: boolean; }
interface NativeResult { ok?: boolean; error?: Object; batch?: Object; sessionId?: string; }
interface Completion { callId: string; result?: Object; error?: HarmonyApiFailure; }
interface HostEvent { sessionId: string; accountEpoch: string; subscriptionId: string; sequence: string; event: string; value: Object; objectId?: string; }
interface QueueEntry { operation: string; payload: Object; bytes: number; isCurrent?: () => boolean; call?: HarmonyCallCancellation; }
interface DeliveredCall { id: string; call: HarmonyCallCancellation; }
interface CancellationCleanup { action: () => void | Promise<void>; complete: boolean; running: Promise<void> | null; error: Object | null; }

export class HarmonyCallCancellation {
  cancelled: boolean = false;
  retained: boolean = false;
  private cleanups: Array<CancellationCleanup> = [];
  onCancel(cleanup: () => void | Promise<void>): void { const entry:CancellationCleanup={action:cleanup,complete:false,running:null,error:null};this.cleanups.push(entry);if(this.cancelled)this.runCleanup(entry); }
  retainUntilCancelled(): void { this.retained = true; }
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const cleanup of this.cleanups) this.runCleanup(cleanup);
    this.requireSuccess();
  }
  async waitForDrain(): Promise<void> {
    while(this.cleanups.some((entry:CancellationCleanup):boolean=>entry.running!==null))await Promise.all(this.cleanups.filter((entry:CancellationCleanup):boolean=>entry.running!==null).map((entry:CancellationCleanup):Promise<void>=>entry.running!));
    this.requireSuccess();this.cleanups=this.cleanups.filter((entry:CancellationCleanup):boolean=>!entry.complete);
  }
  async retryCleanup(): Promise<void> {
    await this.waitForRunning();
    for(const cleanup of this.cleanups)if(!cleanup.complete)this.runCleanup(cleanup);
    await this.waitForDrain();
  }
  private async waitForRunning(): Promise<void> {while(this.cleanups.some((entry:CancellationCleanup):boolean=>entry.running!==null))await Promise.all(this.cleanups.filter((entry:CancellationCleanup):boolean=>entry.running!==null).map((entry:CancellationCleanup):Promise<void>=>entry.running!));}
  private requireSuccess(): void {const failures=this.cleanups.filter((entry:CancellationCleanup):boolean=>entry.error!==null);if(failures.length>0)throw new Error(`ERR_ENGINE: ${failures.length} native resources failed to stop`);}
  private runCleanup(cleanup: CancellationCleanup): void {
    if(cleanup.complete||cleanup.running!==null)return;
    cleanup.error=null;
    try{
      const result=cleanup.action();
      if(result instanceof Promise){const running=result.then(():void=>{cleanup.complete=true;},(error:Object):void=>{cleanup.error=error;}).then(():void=>{cleanup.running=null;});cleanup.running=running;}
      else cleanup.complete=true;
    }catch(error){cleanup.error=error as Object;}
  }
}
export interface HarmonyApiCall { context: HarmonyApiContext; cancellation: HarmonyCallCancellation; }
export type HarmonyApiHandler = (payload: Object, call: HarmonyApiCall) => Promise<Object>;

export class HarmonyHostServices {
  private readonly runtime: HarmonyHostServicesRuntime;
  private readonly handlers: Map<string, HarmonyApiHandler> = new Map();
  private readonly nativeApis: Set<string> = new Set();
  private managedFilesRoot: string | null = null;
  private readonly snapshots: Record<string, Object> = {};
  private readonly calls: Map<string, HarmonyCallCancellation> = new Map();
  private readonly pendingCalls: Set<string> = new Set();
  private readonly completionSizes: Map<string, number> = new Map();
  private completionBytes: number = 0;
  private deliveredCalls: Array<DeliveredCall> = [];
  private incomingRequests: Array<HostRequest> = [];
  private queue: Array<QueueEntry> = [];
  private queueBytes: number = 0;
  private configuration: HarmonyHostServicesConfig | null = null;
  private incarnation: string | null = null;
  private active: boolean = false;
  private closed: boolean = false;
  private draining: boolean = false;
  private readonly cleanup: HarmonyCallCancellation = new HarmonyCallCancellation();
  private backgroundCleanup: Array<() => void> = [];
  private foregroundObservers: Array<(visible: boolean) => void> = [];
  private onError: (error: Object) => void;
  private executions: Set<Promise<void>> = new Set();
  private drains: Set<Promise<void>> = new Set();
  private readonly retiredCalls: Set<HarmonyCallCancellation> = new Set();
  private nativeRevokePending: boolean = false;
  private retryingCleanup: Promise<void> | null = null;

  constructor(runtime: HarmonyHostServicesRuntime, onError: (error: Object) => void = () => {}) { this.runtime = runtime; this.onError = onError; }
  registerApiHandler(name: string, handler: HarmonyApiHandler): void {
    if (this.active || this.closed || this.handlers.has(name)) throw new Error('ERR_INVALID_REQUEST: register unique APIs before configure');
    this.handlers.set(name, handler);
  }
  setManagedFilesRoot(root: string): void { if(this.active||this.closed||!root.startsWith('/'))throw new Error('ERR_INVALID_REQUEST: host-private root required before configure');this.managedFilesRoot=root; }
  declareNativeApi(name: string): void { if(this.active||this.closed)throw new Error('ERR_INVALID_REQUEST: declare native APIs before configure');this.nativeApis.add(name); }
  release(context: HarmonyApiContext): void { if(this.current(context))this.cancel(context.callId); }
  managedFile(context: HarmonyApiContext, method: string, payload: Object): Object {
    if(!this.current(context))throw new HarmonyApiError('cancelled','managed file owner retired');
    return this.command('managedFile',{context,method,payload});
  }
  managedFileScope(context: HarmonyApiContext): Object {
    if(!this.current(context))throw new HarmonyApiError('cancelled','managed file owner retired');
    return this.command('managedFileScope',{});
  }
  setSyncSnapshot(name: string, value: Object): void {
    if (this.active || this.closed) throw new Error('ERR_INVALID_REQUEST: install snapshots before configure');
    this.snapshots[name] = JSON.parse(JSON.stringify(value)) as Object;
  }
  updateSyncSnapshots(values: Record<string,Object>): void {
    if(!this.active||this.closed)throw new HarmonyApiError('cancelled','snapshot owner retired');
    this.command('snapshots',values);
    for(const name of Object.keys(values))this.snapshots[name]=JSON.parse(JSON.stringify(values[name])) as Object;
  }
  onClose(cleanup: () => void | Promise<void>): void { this.cleanup.onCancel(cleanup); }
  onBackground(cleanup: () => void): void { this.backgroundCleanup.push(cleanup); }
  onForeground(observer: (visible: boolean) => void): void { this.foregroundObservers.push(observer); }
  setForeground(visible: boolean): void {
    for(const observer of this.foregroundObservers){try{observer(visible);}catch(error){this.report(error as Object);}}
    if(!visible)for(const cleanup of this.backgroundCleanup){try{cleanup();}catch(error){this.report(error as Object);}}
  }
  supportedApis(): Array<string> { return Array.from(this.handlers.keys()).concat(Object.keys(this.snapshots)).concat(Array.from(this.nativeApis)); }
  configure(config: HarmonyHostServicesConfig, acceptedPackRoot: string): void {
    if (this.active || this.closed || config.application.packRoot !== acceptedPackRoot || !/^[1-9][0-9]{0,19}$/.test(config.account.epoch)) throw new Error('ERR_INVALID_REQUEST: invalid trusted installation/account');
    const protocol = this.command('protocol', {}) as Protocol;
    if (protocol.version !== '1.0' || protocol.trustedContext !== true || protocol.ownerThreadCompletion !== true) throw new Error('ERR_PROTOCOL_VERSION: native host services 1.0 required');
    this.configuration = JSON.parse(JSON.stringify(config)) as HarmonyHostServicesConfig;
    if(this.managedFilesRoot!==null)this.command('managedFilesRoot',{root:this.managedFilesRoot});
    const configured=this.command('configure', { application: config.application, account: config.account, apis: this.supportedApis(), syncValues: this.snapshots }) as NativeResult;
    if(typeof configured.sessionId!=='string'||configured.sessionId.length===0)throw new Error('ERR_PROTOCOL_VERSION: native owner incarnation required');
    this.incarnation=configured.sessionId;this.active = true;
  }
  emit(context: HarmonyApiContext, subscriptionId: string, sequence: number, event: string, value: Object, objectId?: string, isCurrent?: () => boolean): boolean {
    if (!this.current(context) || !Number.isSafeInteger(sequence) || sequence < 1) return false;
    const payload: HostEvent = { sessionId: context.sessionId, accountEpoch: context.account.epoch, subscriptionId, sequence: String(sequence), event, value };
    if (objectId !== undefined) payload.objectId = objectId;
    return this.enqueue('event', payload, isCurrent);
  }
  /** Called after bridge/timer turns on the same executor as the N-API owner. */
  drain(): Array<Object> {
    if (!this.active || this.closed) return [];
    if (this.draining) throw new Error('ERR_INVALID_REQUEST: host service drain is reentrant');
    this.draining = true;
    const batches: Array<Object> = [];
    try {
      const requests=this.incomingRequests,cancelled: Set<string> = new Set();
      // A queued native success is still cancellable until it actually enters
      // JS. A callback from an earlier completion may also cancel the next one.
      this.takeRequests(requests,cancelled);
      for(let count=0;count<512&&this.queue.length>0;count++){
        const entry=this.queue[0];
        if(entry.isCurrent!==undefined&&!entry.isCurrent()){this.queue.shift();this.queueBytes-=entry.bytes;continue;}
        // Keep this exact record and its byte reservation if native transport
        // fails. Nothing later in the queue is silently discarded.
        const result=this.command(entry.operation,entry.payload) as NativeResult;
        if(this.queue[0]===entry)this.queue.shift();
        if(entry.operation==='complete'){
          const completion=entry.payload as Completion;this.forgetCompletion(completion.callId);this.pendingCalls.delete(completion.callId);
          if(entry.call!==undefined)this.deliveredCalls.push({id:completion.callId,call:entry.call});
        }else this.queueBytes-=entry.bytes;
        if(result.batch!==undefined)batches.push(result.batch);
        this.takeRequests(requests,cancelled);
      }
      // Keep the handler cancellation object through the final native take:
      // guest callbacks can release a just-completed resource synchronously.
      this.takeRequests(requests,cancelled);
      for(const entry of this.deliveredCalls)if(!entry.call.retained&&this.calls.get(entry.id)===entry.call)this.calls.delete(entry.id);
      this.deliveredCalls=[];
      while(requests.length>0){const request=requests.shift()!;if(!cancelled.has(request.callId))this.start(request);}
      return batches;
    } finally { this.draining = false; }
  }
  revoke(): void {
    if (this.closed) return;
    this.closed = true;
    const failures: Array<Object> = [];
    for (const call of this.calls.values()) { try { this.retire(call); } catch (error) { failures.push(error as Object); } }
    this.calls.clear();this.pendingCalls.clear();this.completionSizes.clear();this.completionBytes=0;this.deliveredCalls=[];this.incomingRequests=[];this.queue = []; this.queueBytes = 0;
    try{this.cleanup.cancel();}catch(error){failures.push(error as Object);}this.trackDrain(this.cleanup.waitForDrain());
    this.backgroundCleanup=[];this.foregroundObservers=[];
    this.nativeRevokePending=this.active;
    try{if(this.nativeRevokePending){this.command('revoke', {});this.nativeRevokePending=false;}}catch(error){failures.push(error as Object);}finally{this.active = false;}
    if (failures.length > 0) throw new Error(`ERR_ENGINE: ${failures.length} host services cleanup failures`);
  }
  async waitForDrain(): Promise<void> {
    while(this.executions.size>0||this.drains.size>0)await Promise.all(Array.from(this.executions).concat(Array.from(this.drains)));
    await this.cleanup.waitForDrain();
    for(const call of this.retiredCalls){await call.waitForDrain();this.retiredCalls.delete(call);}
    if(this.nativeRevokePending)throw new Error('ERR_ENGINE: native owner revocation requires retry');
  }
  /** Retry only retained, unsuccessful release actions. A successful Promise
   * means actual callbacks drained and native revocation succeeded again. */
  retryResourceCleanup(): Promise<void> {
    if(this.retryingCleanup!==null)return this.retryingCleanup;
    if(!this.closed)return Promise.reject(new Error('ERR_INVALID_REQUEST: cleanup retry requires a revoked owner'));
    const task=(async():Promise<void>=>{
      while(this.executions.size>0||this.drains.size>0)await Promise.all(Array.from(this.executions).concat(Array.from(this.drains)));
      const failures:Array<Object>=[];
      for(const call of this.retiredCalls){try{await call.retryCleanup();this.retiredCalls.delete(call);}catch(error){failures.push(error as Object);}}
      try{await this.cleanup.retryCleanup();}catch(error){failures.push(error as Object);}
      if(this.nativeRevokePending){try{this.command('revoke',{});this.nativeRevokePending=false;}catch(error){failures.push(error as Object);}}
      if(failures.length>0)throw new Error(`ERR_ENGINE: ${failures.length} retained native release barriers still failed`);
      await this.waitForDrain();
    })();this.retryingCleanup=task.finally(():void=>{this.retryingCleanup=null;});return this.retryingCleanup;
  }
  private trackDrain(promise: Promise<void>): void {
    const tracked=promise.catch((error: Object)=>{this.report(error);}).then(()=>{this.drains.delete(tracked);});
    this.drains.add(tracked);
  }
  private observeRetired(call: HarmonyCallCancellation): void {this.retiredCalls.add(call);this.trackDrain(call.waitForDrain().then(():void=>{this.retiredCalls.delete(call);}));}
  private retire(call: HarmonyCallCancellation): void { try{call.cancel();}finally{this.observeRetired(call);} }
  private current(context: HarmonyApiContext): boolean {
    const config = this.configuration;
    return this.active && !this.closed && config !== null && context.sessionId===this.incarnation && context.application.version===config.application.version && context.account.epoch === config.account.epoch && context.account.principalId === config.account.principalId &&
      context.application.hostAppId === config.application.hostAppId && context.application.tenantId === config.application.tenantId &&
      context.application.publisherId === config.application.publisherId && context.application.appId === config.application.appId &&
      context.application.environment === config.application.environment && context.application.packRoot === config.application.packRoot;
  }
  private start(request: HostRequest): void {
    if(this.calls.has(request.callId))throw new Error('ERR_PROTOCOL_VERSION: duplicate native call identity');
    const cancellation = new HarmonyCallCancellation();
    this.calls.set(request.callId, cancellation);this.pendingCalls.add(request.callId);
    const admitted=this.executions.size<256;
    const execution=Promise.resolve().then(() => {
      if (!this.current(request.context) || cancellation.cancelled) throw new Error('ERR_CANCELLED: stale native call');
      if(request.deadlineNs !== undefined && Number(request.deadlineNs.slice(0,-6)||'0')<=Date.now()) throw new HarmonyApiError('timeout','native deadline expired');
      if (!admitted || this.pendingCalls.size > 256) throw new Error('ERR_INVALID_REQUEST: native concurrency limit');
      const handler = this.handlers.get(request.method);
      if (handler === undefined) throw new Error('ERR_UNSUPPORTED_CAPABILITY: host API is not installed');
      return handler(request.payload, { context: request.context, cancellation });
    }).then((result: Object) => {
      if (!cancellation.cancelled && this.current(request.context)) { const completion: Completion = { callId: request.callId, result }; this.enqueue('complete', completion,undefined,cancellation); }
    }).catch((error: Error) => {
      if (!cancellation.cancelled && this.current(request.context)) {
        const failure: HarmonyApiFailure = { code: error instanceof HarmonyApiError ? error.category : error.message.startsWith('ERR_CANCELLED') ? 'cancelled' : error.message.startsWith('ERR_UNSUPPORTED') ? 'unsupported' : 'invalid_request', message: error.message, retryable: false,
          details: error instanceof HarmonyApiError ? {errCode:error.errCode,errMsg:error.errMsg} : { errMsg: `${request.method.replace(/^wx\./, '')}:fail ${error.message}` } };
        const completion: Completion = { callId: request.callId, error: failure }; this.enqueue('complete', completion,undefined,cancellation);
      }
    }).catch((error: Error) => this.report(error)).then(()=>{
      // Native permission/resource acquisition can finish after revocation. Its
      // handler must finish registering release hooks before the barrier settles.
      if(cancellation.cancelled){this.pendingCalls.delete(request.callId);this.observeRetired(cancellation);}
      else if(!this.current(request.context)){this.pendingCalls.delete(request.callId);if(this.calls.get(request.callId)===cancellation)this.calls.delete(request.callId);}
      this.executions.delete(execution);
    });
    this.executions.add(execution);
  }
  private takeRequests(requests:Array<HostRequest>,cancelled:Set<string>):void{
    const native=this.command('take',{}) as HostRequests;
    for(const request of native.requests){
      if(request.kind==='cancel'){cancelled.add(request.callId);for(let index=requests.length-1;index>=0;index--)if(requests[index].callId===request.callId)requests.splice(index,1);try{this.cancel(request.callId);}catch(error){this.report(error as Object);}}
      else if(request.kind==='call'&&!cancelled.has(request.callId))requests.push(request);
    }
  }
  private forgetCompletion(callId:string):void{const bytes=this.completionSizes.get(callId);if(bytes!==undefined){this.completionSizes.delete(callId);this.completionBytes-=bytes;}}
  private cancel(callId: string): void {
    const call=this.calls.get(callId);this.calls.delete(callId);this.pendingCalls.delete(callId);this.forgetCompletion(callId);
    this.queue=this.queue.filter((entry:QueueEntry):boolean=>entry.operation!=='complete'||(entry.payload as Completion).callId!==callId);
    if(call!==undefined)this.retire(call);
  }
  private utf8Bytes(text: string): number {
    let bytes=0;
    for(let index=0;index<text.length;index++){const code=text.charCodeAt(index);if(code<128)bytes++;else if(code<2048)bytes+=2;else if(code>=0xD800&&code<=0xDBFF&&index+1<text.length&&text.charCodeAt(index+1)>=0xDC00&&text.charCodeAt(index+1)<=0xDFFF){bytes+=4;index++;}else bytes+=3;}
    return bytes;
  }
  private enqueue(operation: string, payload: Object, isCurrent?: () => boolean, call?: HarmonyCallCancellation): boolean {
    if (this.closed) return false;
    let bytes=this.utf8Bytes(JSON.stringify(payload));
    // Events cannot consume terminal space. Reserve 2 KiB for each of the
    // runtime's 256 pending calls, including those whose native result is late.
    if(operation==='complete') {
      const previous=payload as Completion;if(this.completionSizes.has(previous.callId))return true;
      if(this.completionSizes.size>=256)throw new Error('ERR_PROTOCOL_VERSION: runtime exceeded negotiated pending-call bound');
      const reserve=(256-this.completionSizes.size-1)*2048;
      if(bytes>8*1024*1024-this.completionBytes-reserve){
        const failure:HarmonyApiFailure={code:'invalid_request',message:'native completion queue byte limit',retryable:false,details:{errMsg:'host API:fail native completion queue byte limit'}};
        const completion:Completion={callId:previous.callId,error:failure};payload=completion;bytes=this.utf8Bytes(JSON.stringify(payload));
        if(bytes>2048)throw new Error('ERR_PROTOCOL_VERSION: runtime call identity exceeds terminal reservation');
      }
      this.completionSizes.set(previous.callId,bytes);this.completionBytes+=bytes;
    }else{
      if(this.queue.filter((entry:QueueEntry):boolean=>entry.operation!=='complete').length>=256||bytes>7*1024*1024-this.queueBytes){this.report(new Error('ERR_INVALID_REQUEST: native queue backpressure'));return false;}
      this.queueBytes+=bytes;
    }
    this.queue.push({ operation, payload, bytes, isCurrent,call });return true;
  }
  private command(operation: string, payload: Object): Object {
    const value = JSON.parse(this.runtime.hostServices(JSON.stringify({ operation, payload }))) as NativeResult;
    if (value.ok === false) throw new Error(`ERR_ENGINE: native ${operation} failed: ${JSON.stringify(value.error)}`);
    return value;
  }
  private report(error: Object): void { try { this.onError(error); } catch { /* observer cannot stop owner cleanup */ } }
}
