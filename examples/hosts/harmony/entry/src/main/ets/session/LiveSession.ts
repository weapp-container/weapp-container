import { PortablePack } from './PortablePack';
import type { HarmonyHostServices, HarmonyHostServicesConfig } from './HostServices';

/** One ArkTS executor owns this complete native session and its EGL surface. */
export interface HarmonySessionRuntime {
  loadManifestWithConfig(manifestJson: string, configJson: string): string;
  dispatch(envelopeJson: string): string;
  inspectState(): string;
  pollTimers(nowNsDecimalString: string): string;
  acknowledgePresentation(renderRevisionDecimalString: string): string;
  resizeViewport(width: number, height: number): string;
  attachSurface(surfaceId: string, width: number, height: number): string;
  renderSurface(width: number, height: number): string;
  detachSurface(): string;
  destroy(): void;
}
export interface HarmonySessionOptions {
  sessionId: string;
  engine: string;
  route?: string;
  width: number;
  height: number;
  foreground?: boolean;
  launchOptions?: HarmonySessionLaunchOptions;
  hostServices?: HarmonyHostServices;
  hostIdentity?: HarmonyHostServicesConfig;
}
export interface HarmonySessionLaunchOptions { query?: Record<string,string>; scene?: number; extra?: Object; }
interface HarmonyLaunchPayload { path: string; query: Record<string,string>; scene?: number; extra?: Object; }
export interface InspectionPage { id: number; route: string; data: Object; }
export interface NativeFontInspection { installedFaces: number; families: Array<string>; }
export interface HarmonyInspection {
  schemaVersion: number;
  sessionId: string;
  page?: InspectionPage | null;
  frameId?: number | null;
  viewRevision?: number | null;
  renderRevision?: number | null;
  nativeFonts?: NativeFontInspection | null;
}
export interface BridgePayload {
  ok?: boolean;
  committed?: boolean;
  source?: string;
  templateId?: string;
  frameId?: number;
  revision?: number;
  engineProviderAvailable?: boolean;
  engine?: string;
  loadedModules?: number;
  manifest?: ManifestAcknowledgement;
  error?: Object;
}
interface ManifestAcknowledgement { integrity: string; }
export interface BridgeMessage {
  protocolVersion: string;
  sessionId: string;
  requestId: string;
  kind: string;
  op: string;
  payload: BridgePayload;
}
export interface BridgeBatch { ok?: boolean; error?: Object; messages: Array<BridgeMessage>; }
interface NativeStatus { ok: boolean; error?: Object; operation?: string; renderer?: string; gpuSurface?: boolean; }
interface Envelope { protocolVersion: string; sessionId: string; requestId: string; kind: string; op: string; payload: Object; }
interface Viewport { x: number; y: number; width: number; height: number; }
interface RenderPayload {
  frameId: number;
  templateId: string;
  styleIds: Array<string>;
  viewport: Viewport;
  blobs: Record<string, Array<number>>;
}
interface Contact { identifier: number; clientX: number; clientY: number; pageX: number; pageY: number; }
interface EventDetail { x?: number; y?: number; }
interface NativeEvent {
  type: string;
  x: number;
  y: number;
  timeStamp: number;
  detail: EventDetail;
  touches: Array<Contact>;
  changedTouches: Array<Contact>;
}
interface PointerState { id: number; x: number; y: number; lastX: number; lastY: number; timeMs: number; moved: boolean; }
export interface HarmonySessionReceipt {
  schemaVersion: number;
  sessionId: string;
  engine: string;
  manifestIntegrity: string;
  status: string;
  cleanupComplete: boolean;
  runtimeFailed: boolean;
  presentationSuspended: boolean;
  foreground: boolean;
  revision: number;
  route: string;
  frameId: number;
  presentedFrameId: number;
  presentationSequence: number;
  viewport: Viewport;
  surfaceWidth: number;
  surfaceHeight: number;
  inspection?: HarmonyInspection;
  diagnostics: Array<string>;
  trace: Array<BridgeMessage>;
  limitations: Array<string>;
}
export interface HarmonyExecutionIdentity { sessionId: string; hostIdentity: HarmonyHostServicesConfig | null; }

/** Convert before multiplying: Number nanoseconds would lose precision. */
export function unixEpochNanoseconds(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('ERR_ENGINE: expected non-negative Unix epoch integer milliseconds');
  const value = nowMs === 0 ? '0' : `${nowMs}000000`;
  const maximum = '18446744073709551615';
  if (value.length > maximum.length || value.length === maximum.length && value > maximum) {
    throw new Error('ERR_ENGINE: Unix epoch nanoseconds exceed u64');
  }
  return value;
}

export class HarmonyLiveSession {
  private readonly pack: PortablePack;
  private readonly runtime: HarmonySessionRuntime;
  private readonly options: HarmonySessionOptions;
  private readonly onReceipt: (receipt: HarmonySessionReceipt) => void;
  private started: boolean = false;
  private closed: boolean = false;
  private destroyed: boolean = false;
  private closing: Promise<void> | null = null;
  private suspended: boolean = false;
  private identityRevoked: boolean = false;
  private presentationSuspended: boolean = false;
  private foreground: boolean = true;
  private attached: boolean = false;
  private surfaceId: string | null = null;
  private frameId: number = 0;
  private renderedRevision: number = -1;
  private renderedPageId: number = -1;
  private presentedFrameId: number = 0;
  private presentationSequence: number = 0;
  private sequence: number = 0;
  private revision: number = 0;
  private width: number;
  private height: number;
  private surfaceWidth: number = 0;
  private surfaceHeight: number = 0;
  private route: string;
  private pointerState: PointerState | null = null;
  private inspection?: HarmonyInspection;
  private diagnostics: Array<string> = [];
  private trace: Array<BridgeMessage> = [];

  constructor(pack: PortablePack, runtime: HarmonySessionRuntime, options: HarmonySessionOptions,
    onReceipt: (receipt: HarmonySessionReceipt) => void) {
    this.pack = pack;
    this.runtime = runtime;
    this.options = {sessionId:options.sessionId,engine:options.engine,route:options.route,width:options.width,height:options.height,foreground:options.foreground,launchOptions:options.launchOptions===undefined?undefined:JSON.parse(JSON.stringify(options.launchOptions)) as HarmonySessionLaunchOptions,hostServices:options.hostServices,hostIdentity:options.hostIdentity===undefined?undefined:JSON.parse(JSON.stringify(options.hostIdentity)) as HarmonyHostServicesConfig};
    this.foreground=options.foreground!==false;
    this.onReceipt = onReceipt;
    this.width = this.dimension(options.width);
    this.height = this.dimension(options.height);
    this.route = pack.requireRoute(options.route || pack.firstRoute());
    if (!['quickjs', 'v8'].includes(options.engine) || options.sessionId.length === 0) {
      throw new Error('ERR_ENGINE: invalid explicit engine or session identity');
    }
  }

  start(): void {
    if (this.started || this.closed || this.identityRevoked || this.suspended) throw new Error('ERR_ENGINE: a session owner can start only once and cannot start after identity revocation or startup failure');
    // Consume once before native initialization; failures cannot replay App hooks.
    this.started = true;
    try {
      const config = { engine: this.options.engine, session_id: this.options.sessionId, require_integrity: true,
        page_render_mode: 'native-gpu',
        host: { windowWidth: this.width, windowHeight: this.height } };
      this.nativeStatus(this.runtime.loadManifestWithConfig(this.pack.manifestJson, JSON.stringify(config)), 'manifest.load');
      if (this.options.hostServices !== undefined) {
        if (this.options.hostIdentity === undefined) throw new Error('ERR_INVALID_REQUEST: trusted host identity is required');
        this.options.hostServices.configure(this.options.hostIdentity, this.pack.integrityRoot);
        if(!this.foreground)this.options.hostServices.setForeground(false);
      }
      const init = this.dispatch('app.init', { manifest: this.pack.manifest, modules: this.pack.modules(),
        blobs: this.pack.blobs, launchOptions: this.launchPayload() });
      if (init.engineProviderAvailable !== true || init.engine !== this.options.engine ||
        init.loadedModules !== this.pack.manifest.modules.length || init.manifest?.integrity !== this.pack.integrityRoot) {
        throw new Error('ERR_ENGINE: app.init did not acknowledge the requested native engine and verified module closure');
      }
      this.dispatch('app.lifecycle', { event: 'launch', options: this.launchPayload() });
      this.dispatch('page.push', { path: this.route,query:this.options.launchOptions?.query||{} });
      this.renderFrame();
      this.publish();
    } catch (error) { this.fail(error); throw error; }
  }

  canPump(): boolean { return this.started && !this.closed && !this.suspended && this.foreground; }

  isRunnable(): boolean { return this.canPump() && !this.presentationSuspended && this.attached && this.presentedFrameId === this.frameId; }
  executionIdentity(): HarmonyExecutionIdentity {return {sessionId:this.options.sessionId,hostIdentity:this.options.hostIdentity===undefined?null:JSON.parse(JSON.stringify(this.options.hostIdentity)) as HarmonyHostServicesConfig};}

  attachSurface(surfaceId: string, physicalWidth: number, physicalHeight: number): void {
    if (!this.started || this.closed || this.suspended) return;
    try {
      if (surfaceId.length === 0) throw new Error('ERR_RENDER: empty XComponent surface id');
      if (this.attached) {this.detachSurface();if(this.attached)throw new Error('ERR_RENDER: prior native surface still requires retirement');}
      this.surfaceId = surfaceId;
      this.surfaceWidth = this.dimension(physicalWidth);
      this.surfaceHeight = this.dimension(physicalHeight);
      if (!this.presentationSuspended && this.tryAttach()) this.presentAvailable();
      this.publish();
    } catch (error) { this.reportPresentationFailure(error); }
  }

  detachSurface(): void {
    if (this.destroyed) return;
    this.surfaceId = null;
    if(!this.closed&&!this.identityRevoked)try { this.cancelPointer(Date.now()); } catch (error) { this.suspended = true; this.remember(error); }
    // EGL cleanup cannot be skipped because a user touchcancel hook threw.
    try {
      this.retireSurface();
    } catch (error) { this.presentationSuspended = true; this.remember(error); }
    this.presentedFrameId = 0;
    this.publish();
  }

  resize(width: number, height: number, physicalWidth: number, physicalHeight: number): void {
    if (!this.started || this.closed || this.suspended) return;
    try {
      const nextWidth = this.dimension(width), nextHeight = this.dimension(height);
      const nextPhysicalWidth = this.dimension(physicalWidth), nextPhysicalHeight = this.dimension(physicalHeight);
      if (this.width === nextWidth && this.height === nextHeight && this.surfaceWidth === nextPhysicalWidth && this.surfaceHeight === nextPhysicalHeight) return;
      // A captured gesture must end against its old coordinate space.
      this.cancelPointer(Date.now());
      const changed = this.width !== nextWidth || this.height !== nextHeight;
      if (changed) this.validateBatch(this.runtime.resizeViewport(nextWidth, nextHeight));
      this.width = nextWidth;
      this.height = nextHeight;
      this.surfaceWidth = nextPhysicalWidth;
      this.surfaceHeight = nextPhysicalHeight;
      if (changed) this.renderFrame();
      else this.presentAvailable();
      this.publish();
    } catch (error) { this.fail(error); }
  }

  setForeground(visible: boolean): void {
    if (!this.started || this.closed || this.identityRevoked || this.foreground === visible) return;
    // Consume the OS transition before user hooks so exceptions cannot replay
    // show/hide or leave the receipt claiming a background app is foreground.
    this.foreground = visible;
    this.options.hostServices?.setForeground(visible);
    try { this.cancelPointer(Date.now()); } catch (error) { this.suspended = true; this.remember(error); }
    try {
      this.dispatch('app.lifecycle', { event: visible ? 'show' : 'hide', options: this.launchPayload() });
      if (visible && !this.suspended) this.renderFrame();
      else this.inspect();
    } catch (error) { this.suspended = true; this.remember(error); }
    this.publish();
  }

  pointer(action: string, id: number, x: number, y: number, timeMs: number, slop: number = 8): void {
    if (!this.isRunnable()) return;
    try {
      if (![id, x, y, timeMs, slop].every((value: number) => Number.isFinite(value)) || !Number.isInteger(id) || timeMs < 0 || slop < 0) {
        throw new Error('ERR_ENGINE: invalid native pointer sample');
      }
      const events: Array<NativeEvent> = [];
      const current = this.pointerState;
      if (action === 'down') {
        if (current !== null) { this.cancelPointer(timeMs); this.renderFrame(); this.publish(); return; }
        const contact: PointerState = { id, x, y, lastX: x, lastY: y, timeMs, moved: false };
        this.pointerState = contact;
        events.push(this.touchEvent('touchstart', contact, x, y, timeMs, true));
      } else if (action === 'move') {
        if (current === null || current.id !== id) return;
        current.lastX = x; current.lastY = y;
        current.moved = current.moved || Math.hypot(x - current.x, y - current.y) > slop;
        events.push(this.touchEvent('touchmove', current, x, y, timeMs, true));
      } else if (action === 'up') {
        this.pointerState = null;
        if (current === null || current.id !== id) return;
        events.push(this.touchEvent('touchend', current, x, y, timeMs, false));
        if (!current.moved && Math.hypot(x - current.x, y - current.y) <= slop && timeMs - current.timeMs >= 0 && timeMs - current.timeMs <= 500) {
          events.push(this.touchEvent('tap', current, x, y, timeMs, false));
        }
      } else if (action === 'cancel' || action === 'multiple') {
        this.cancelPointer(timeMs);
        this.renderFrame();
        this.publish();
        return;
      } else throw new Error(`ERR_ENGINE: unsupported pointer action: ${action}`);
      this.dispatch('event.batch', { events });
      this.renderFrame();
      this.publish();
    } catch (error) { this.fail(error); }
  }

  pollTimers(nowMs: number): void {
    if (!this.canPump()) return;
    try {
      if (this.options.hostServices !== undefined) {
        for (const batch of this.options.hostServices.drain()) this.validateBatch(JSON.stringify(batch));
      }
      // The AppService clock advances even while a drawable is unavailable
      // or a failed presenter waits for an explicit retry.
      const messages = this.validateBatch(this.runtime.pollTimers(unixEpochNanoseconds(nowMs)));
      // onReady, observer effects and component-only setData may occur after
      // a render acknowledgement, without a subsequent timer event. Compare
      // against the revision actually rendered, never the later inspection.
      this.inspect();
      if (this.presentationSuspended) {
        if (messages.length > 0) this.publish();
        return;
      }
      if (this.surfaceId !== null && !this.attached) {
        try { this.tryAttach(); }
        catch (error) { this.reportPresentationFailure(error); return; }
      }
      if (messages.length === 0 && this.inspection?.viewRevision === this.renderedRevision &&
        this.inspection?.page?.id === this.renderedPageId) {
        // Only the documented drawable-size race retries automatically.
        // A terminal renderer fault sets presentationSuspended instead.
        if (this.surfaceId !== null && (!this.attached || this.presentedFrameId !== this.frameId)) {
          if (this.presentAvailable()) this.publish();
        }
        return;
      }
      this.renderFrame();
      this.publish();
    } catch (error) { this.fail(error); }
  }

  close(): void {
    if(this.options.hostServices!==undefined){this.closeAndDrain().catch((error:Object)=>{this.remember(error);this.publish();});return;}
    if(this.destroyed)return;
    this.prepareClose();
    try { this.retireSurface();this.runtime.destroy();this.destroyed=true; } catch (error) { this.remember(error); }
    this.publish();
  }

  /** The owner and its storage leases outlive asynchronous native release. A
   * failed release remains blocked and cannot be reused for another identity. */
  closeAndDrain(): Promise<void> {
    if(this.destroyed)return Promise.resolve();
    if(this.closing!==null)return this.closing;
    const retry=this.closed;this.prepareClose();
    const closing=(async():Promise<void>=>{
      let surfaceError:Object|null=null;
      try{this.retireSurface();}catch(error){surfaceError=error as Object;this.remember(error);}
      // Device release still runs when the GPU detach fails. Neither failure
      // can drop the old native/storage owner or turn a retry into success.
      if(retry&&this.options.hostServices!==undefined)await this.options.hostServices.retryResourceCleanup();else await this.waitForHostServicesDrain();
      if(surfaceError!==null)throw surfaceError;
      this.runtime.destroy();this.destroyed=true;this.publish();
    })();this.closing=closing.finally(():void=>{this.closing=null;});this.publish();return this.closing;
  }

  private prepareClose(): void {
    if (this.closed) return;
    this.closed=true;
    // Every cleanup stage runs even after a user callback or native error.
    if (this.started && !this.identityRevoked) {
      try { this.cancelPointer(Date.now()); } catch (error) { this.remember(error); }
      try { this.dispatch('app.lifecycle', { event: 'unload' }); } catch (error) { this.remember(error); }
    }
    try { this.options.hostServices?.revoke(); } catch (error) { this.remember(error); }
    this.surfaceId = null;
    this.pointerState = null;
    this.foreground = false;
    this.presentedFrameId = 0;
  }
  private retireSurface(): void {
    if(this.attached){this.nativeStatus(this.runtime.detachSurface(),'surface.detach');this.attached=false;}
  }

  /** Synchronous account epoch gate. The replacing controller then waits for
   * detach/close before constructing a new owner with fresh launch options. */
  revokeIdentity(): void {
    if(this.closed || this.identityRevoked)return;
    this.identityRevoked=true;this.suspended=true;this.pointerState=null;this.foreground=false;
    try{this.options.hostServices?.revoke();}finally{this.publish();}
  }
  waitForHostServicesDrain(): Promise<void> { return this.options.hostServices?.waitForDrain() || Promise.resolve(); }

  reportFailure(error: Object): void { if (!this.closed) this.fail(error); }

  reportPresentationFailure(error: Object): void {
    if (this.closed) return;
    this.presentationSuspended = true;
    this.pointerState = null;
    this.remember(error);
    this.publish();
  }

  /** Reattach if necessary and render current live data only on host request. */
  retryPresentation(): void {
    if (!this.canPump() || this.surfaceId === null) return;
    try {
      if (this.presentationSuspended && this.attached) {
        // A failed makeCurrent/swap may leave native handles allocated but
        // unusable. Retire that identity before attaching a replacement. Keep
        // attached=true on failure so a later explicit retry finishes cleanup;
        // surfaceId and geometry remain available for the replacement.
        this.presentedFrameId = 0;
        this.nativeStatus(this.runtime.detachSurface(), 'surface.retry.detach');
        this.attached = false;
      }
      if (!this.tryAttach()) return;
      this.renderFrame(true);
      this.publish();
    } catch (error) { this.reportPresentationFailure(error); }
  }

  private renderFrame(retry: boolean = false): void {
    if (this.presentationSuspended && !retry) return;
    this.inspect();
    const page = this.inspection?.page;
    if (page === undefined || page === null) throw new Error('ERR_RENDER: no active page to render');
    this.route = this.pack.requireRoute(page.route);
    const pageId = page.id;
    const candidate = this.frameId + 1;
    const payload: RenderPayload = { frameId: candidate, templateId: `template:${this.route}.wxml`,
      styleIds: this.pack.styleIds(this.route), viewport: { x: 0, y: 0, width: this.width, height: this.height },
      blobs: this.pack.blobs };
    // Each manifest commit uses the verified closure owned by this pack.
    // Resource reuse requires an explicit negotiated native protocol; an
    // unrecognized host-only flag cannot replace content-addressed bytes.
    // Deliberately omit data: page and component setData belong to AppService.
    const acknowledgement = this.dispatch('render.commit', payload);
    if (acknowledgement.committed !== true || acknowledgement.source !== 'manifest' ||
      acknowledgement.frameId !== candidate || acknowledgement.templateId !== payload.templateId ||
      !Number.isSafeInteger(acknowledgement.revision) || acknowledgement.revision === undefined || acknowledgement.revision < 0) {
      throw new Error('ERR_RENDER: native runtime did not commit the requested manifest frame');
    }
    this.frameId = candidate;
    this.renderedRevision = acknowledgement.revision;
    this.renderedPageId = pageId;
    this.inspect();
    if (this.inspection?.frameId !== this.frameId) throw new Error('ERR_RENDER: inspection does not match the committed frame');
    this.presentAvailable(retry);
  }

  private tryAttach(): boolean {
    if (this.attached) return true;
    if (this.surfaceId === null) return false;
    const json = this.runtime.attachSurface(this.surfaceId, this.surfaceWidth, this.surfaceHeight);
    const candidate = JSON.parse(json) as NativeStatus;
    if (candidate.ok !== true && candidate.operation === 'surface-size-not-ready') return false;
    const status = this.nativeStatus(json, 'surface.attach');
    if (status.renderer !== 'skia-gpu-gles') throw new Error('ERR_RENDER: native GLES surface was not attached');
    this.attached = true;
    return true;
  }

  private presentAvailable(retry: boolean = false): boolean {
    try { return this.present(retry); }
    catch (error) { this.reportPresentationFailure(error); return false; }
  }

  private present(retry: boolean = false): boolean {
    if (!this.attached || !this.foreground || this.suspended || this.presentationSuspended && !retry) return false;
    const revision = this.inspection?.renderRevision;
    if (revision === undefined || revision === null || !Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error('ERR_RENDER: no committed render revision');
    }
    const json = this.runtime.renderSurface(this.surfaceWidth, this.surfaceHeight);
    const candidate = JSON.parse(json) as NativeStatus;
    if (candidate.ok !== true && candidate.operation === 'surface-size-not-ready') {
      this.presentedFrameId = 0;
      return false;
    }
    const status = this.nativeStatus(json, 'surface.present');
    if (status.gpuSurface !== true || status.renderer !== 'skia-gpu-gles') throw new Error('ERR_RENDER: frame was not submitted to the attached GLES surface');
    this.presentedFrameId = this.frameId;
    this.presentationSequence += 1;
    // renderSurface returns only after eglSwapBuffers. Readiness runs here on
    // the runtime owner thread; queue submission does not imply GPU completion.
    this.validateBatch(this.runtime.acknowledgePresentation(String(revision)));
    this.presentationSuspended = false;
    return true;
  }

  private inspect(): void {
    const value = JSON.parse(this.runtime.inspectState()) as HarmonyInspection;
    if (value.sessionId !== this.options.sessionId) throw new Error('ERR_ENGINE: inspection belongs to a different session');
    this.inspection = value;
  }

  private cancelPointer(timeMs: number): void {
    const pointer = this.pointerState;
    this.pointerState = null;
    if (pointer !== null) this.dispatch('event.batch', { events: [this.touchEvent('touchcancel', pointer, pointer.lastX, pointer.lastY, timeMs, false)] });
  }

  private touchEvent(type: string, pointer: PointerState, x: number, y: number, timeMs: number, active: boolean): NativeEvent {
    const touch: Contact = { identifier: pointer.id, clientX: x, clientY: y, pageX: x, pageY: y };
    const detail: EventDetail = type === 'tap' ? { x, y } : {};
    return { type, x, y, timeStamp: timeMs, detail, touches: active ? [touch] : [], changedTouches: [touch] };
  }

  private dispatch(op: string, payload: Object): BridgePayload {
    this.sequence += 1;
    const requestId = `harmony-session-${this.sequence}`;
    const envelope: Envelope = { protocolVersion: '1.0', sessionId: this.options.sessionId, requestId, kind: 'request', op, payload };
    const messages = this.validateBatch(this.runtime.dispatch(JSON.stringify(envelope)));
    const matches = messages.filter((message: BridgeMessage) => message.protocolVersion === '1.0' && message.sessionId === this.options.sessionId &&
      message.requestId === requestId && message.kind === 'response' && message.op === op);
    if (matches.length !== 1 || matches[0].payload.ok !== true) throw new Error(`ERR_ENGINE: missing unique successful ${op} acknowledgement`);
    return matches[0].payload;
  }

  private validateBatch(json: string): Array<BridgeMessage> {
    const batch = JSON.parse(json) as BridgeBatch;
    if (batch.ok === false || !Array.isArray(batch.messages)) throw new Error(`ERR_ENGINE: invalid native bridge batch: ${json}`);
    for (const message of batch.messages) {
      if (message.sessionId !== this.options.sessionId || message.protocolVersion !== '1.0') throw new Error('ERR_ENGINE: native bridge batch belongs to another session/protocol');
      this.trace.push(message);
      if (this.trace.length > 128) this.trace.shift();
      if (message.op === 'error' || message.kind === 'response' && message.payload.ok === false) {
        throw new Error(`ERR_ENGINE: native bridge operation failed: ${JSON.stringify(message)}`);
      }
    }
    return batch.messages;
  }

  private nativeStatus(json: string, operation: string): NativeStatus {
    const status = JSON.parse(json) as NativeStatus;
    if (status.ok !== true) throw new Error(`ERR_ENGINE: ${operation} failed: ${json}`);
    return status;
  }

  private dimension(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 4294967295) throw new Error('ERR_RENDER: dimensions must be positive u32 integers');
    return value;
  }
  private launchPayload(): HarmonyLaunchPayload {return {path:this.route,query:this.options.launchOptions?.query||{},scene:this.options.launchOptions?.scene,extra:this.options.launchOptions?.extra};}

  private remember(error: Object): void {
    this.diagnostics.push(error instanceof Error ? error.message : String(error));
    if (this.diagnostics.length > 16) this.diagnostics.shift();
  }

  private fail(error: Object): void {
    this.suspended = true;
    this.pointerState = null;
    this.remember(error);
    try { this.inspect(); } catch (inspectionError) { this.remember(inspectionError); }
    this.publish();
  }

  private publish(): void {
    this.revision += 1;
    const receipt: HarmonySessionReceipt = { schemaVersion: 1, sessionId: this.options.sessionId, engine: this.options.engine,
      manifestIntegrity: this.pack.integrityRoot, status: this.destroyed ? 'closed' : this.closed ? 'closing' : this.suspended || this.presentationSuspended || !this.foreground ? 'suspended' : this.attached && this.presentedFrameId === this.frameId ? 'ready' : 'waiting-surface',cleanupComplete:this.destroyed,
      runtimeFailed: this.suspended, presentationSuspended: this.presentationSuspended,
      foreground: this.foreground, revision: this.revision, route: this.route, frameId: this.frameId,
      presentedFrameId: this.presentedFrameId, presentationSequence: this.presentationSequence,
      viewport: { x: 0, y: 0, width: this.width, height: this.height }, surfaceWidth: this.surfaceWidth, surfaceHeight: this.surfaceHeight,
      inspection: this.inspection, diagnostics: this.diagnostics.slice(), trace: this.trace.slice(),
      limitations: ['single-pointer/tap only; multi-touch cancels the active gesture',
        'ArkUI/Skia surface use does not establish physical GPU, DevTools parity or performance acceptance'] };
    // A development observer is outside the runtime transaction. Keep its
    // error for the next observation, without replaying hooks, suspending
    // working app logic or recursively invoking the failing observer.
    try { this.onReceipt(receipt); } catch (error) { this.remember(error); }
  }
}
