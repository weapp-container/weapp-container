import { createWeappContainer } from '../native/WeappContainer';
import util from '@ohos.util';
import fs from '@ohos.file.fs';
import common from '@ohos.app.ability.common';
import cryptoFramework from '@ohos.security.cryptoFramework';
import { PortablePack } from '../session/PortablePack';
import { HarmonyLiveSession, HarmonySessionReceipt, HarmonySmokeProbeResult, HarmonyExecutionOperation, InspectionPage, BridgeMessage, BridgeBatch, BridgePayload, NativeFontInspection } from '../session/LiveSession';
import { abilityLifecycle } from '../session/AbilityLifecycle';
import { HarmonyHostServices } from '../session/HostServices';
import { HarmonyDeviceApis } from '../native/HarmonyDeviceApis';
import { HarmonyManagedFiles } from '../native/HarmonyManagedFiles';
import { HarmonyNetworkApis } from '../native/HarmonyNetworkApis';
import { HarmonySocketApis } from '../native/HarmonySocketApis';
import { HarmonySystemApis } from '../native/HarmonySystemApis';
import { HarmonyBluetoothApis } from '../native/HarmonyBluetoothApis';
import { HarmonyRecorderApis } from '../native/HarmonyRecorderApis';
import { installHarmonyReferenceHost } from '../native/HarmonyReferenceHost';
import { installHarmonyWifiApis } from '../native/HarmonyWifiApis';
import { installHarmonyNfcApis } from '../native/HarmonyNfcApis';
import { collectHarmonyHostObservation } from '../native/HarmonyHostObservation';
import { HarmonyHostAccountManager, HarmonyAccountController, HarmonyAccountOwnerContext, HarmonyAccountExecutionOwner, HarmonyAccountError, HarmonyAccountControllerState, HarmonyAccountLaunch } from '../session/HostAccountManager';

// Keep failed close barriers alive beyond ArkUI component destruction. A real
// host owns one such manager for its authenticated host/tenant account domain.
const hostAccountManager = new HarmonyHostAccountManager({principalId:null,epoch:'1'});

function sha256Bytes(bytes: Uint8Array): string {
  const md = cryptoFramework.createMd('SHA256');
  md.updateSync({ data: bytes });
  const digest = md.digestSync().data;
  let output = '';
  for (let index = 0; index < digest.length; index += 1) output += digest[index].toString(16).padStart(2, '0');
  return output;
}

interface LiveObservation {
  schemaVersion: number;
  sessionId: string;
  engine: string;
  status: string;
  foreground: boolean;
  revision: number;
  route: string;
  frameId: number;
  presentedFrameId: number;
  presentationSequence: number;
  width: number;
  height: number;
  surfaceWidth: number;
  surfaceHeight: number;
  page?: InspectionPage | null;
  viewRevision?: number | null;
  nativeFonts?: NativeFontInspection | null;
  diagnostics: Array<string>;
  evidenceBoundary: string;
}

interface SmokeSnapshot {
  frame_id: number;
  width: number;
  height: number;
  stride: number;
  format: string;
  pixels: Array<number>;
}

interface SmokeSnapshotSummary {
  frame_id: number;
  width: number;
  height: number;
  stride: number;
  format: string;
  pixelCount: number;
  sha256: string;
  pixels: Array<number>;
}

interface ExecutionFixture { id: string; sourceCommit: string|null; manifest: Object; }
interface ExecutionBuild { status: string; sourceCommit: string|null; workingTreeDirty: boolean; host: string; engine: string; artifactSha256: string|null; }
interface ExecutionReceipt {
  schemaVersion: number; fixture: ExecutionFixture; host: string; engine: string; status: string;
  sourceCommit: string|null; artifactSha256: string|null; fixtureId: string; manifestIntegrity: string;
  sessionId: string; route: string; operations: Record<string,HarmonyExecutionOperation>; surfaceProbe: Object; build: ExecutionBuild;
}

@Entry
@Component
struct Index {
  @State status: string = 'Waiting for an observed surface';
  @State accountFailed: boolean = false;
  private readonly xComponentController: XComponentController = new XComponentController();
  private session: HarmonyLiveSession | null = null;
  private accountController: HarmonyAccountController | null = null;
  private presentationCheck: (() => void) | null = null;
  private lastReceipt: HarmonySessionReceipt | null = null;
  private pack: PortablePack | null = null;
  private surfaceReady: boolean = false;
  private attachedSurfaceId: string = '';
  private closed: boolean = false;
  private areaWidth: number = 0;
  private areaHeight: number = 0;
  private timer: number = -1;
  private lifecycleListener: number = -1;
  private ignoringMultiple: boolean = false;
  private initialSmokeLogged: boolean = false;
  private smokeProbeLogged: boolean = false;
  private executionReceiptPath: string = '';
  private executionReceiptFrozen: boolean = false;

  aboutToAppear(): void {
    this.closed = false;
    this.lifecycleListener = abilityLifecycle.subscribe((foreground: boolean, destroyed: boolean) => {
      if (destroyed) { this.closeSession(); return; }
      this.stopPump();
      if (this.session !== null) this.session.setForeground(foreground);
      if (foreground) { this.synchronizeSurface(); this.startPump(); }
    });
    try {
      const hostContext = this.getUIContext().getHostContext();
      if (hostContext === undefined) throw new Error('ERR_HOST_CONTEXT: ArkUI host context is unavailable');
      const context = hostContext as common.UIAbilityContext;
      this.executionReceiptPath = `${context.filesDir}/portable-pack-execution.json`;
      this.clearExecutionReceipt();
      this.pack = PortablePack.load((path: string): Uint8Array => context.resourceManager.getRawFileContentSync(path),
        (bytes: Uint8Array): string => util.TextDecoder.create('utf-8', { fatal: true, ignoreBOM: true }).decodeToString(bytes), sha256Bytes);
      this.synchronizeSurface();
    } catch (error) { this.reportFailure(error); }
  }

  aboutToDisappear(): void {
    if (this.lifecycleListener >= 0) abilityLifecycle.unsubscribe(this.lifecycleListener);
    this.lifecycleListener = -1;
    this.closeSession();
  }

  private synchronizeSurface(): void {
    if (this.closed || !this.surfaceReady || this.pack === null || !Number.isFinite(this.areaWidth) || !Number.isFinite(this.areaHeight) || this.areaWidth <= 0 || this.areaHeight <= 0) return;
    try {
      const width = Math.max(1, Math.round(this.areaWidth)), height = Math.max(1, Math.round(this.areaHeight));
      const physicalWidth = Math.max(1, Math.round(this.getUIContext().vp2px(this.areaWidth)));
      const physicalHeight = Math.max(1, Math.round(this.getUIContext().vp2px(this.areaHeight)));
      if(this.accountController===null){
        // This bundled, hash-verified fixture is the sample's trusted
        // installation. Production obtains identity from its signed registry.
        // The example installs no fabricated host login or payment backend.
        const launch:HarmonyAccountLaunch={};const initialRoute=AppStorage.get<string>('weappContainerRoute');if(initialRoute!==undefined&&initialRoute.length>0)launch.route=initialRoute;
        this.accountController=hostAccountManager.attach({
          application:{hostAppId:'weapp-container-harmony-example',tenantId:'example',publisherId:'bundled-example-installation',appId:'harmony-example',environment:'develop',version:'host-services-preview',packRoot:this.pack.integrityRoot},
          initialSessionId:AppStorage.get<string>('weappContainerSessionId')||undefined,
          launchOptions:launch,
          createOwner:(context:HarmonyAccountOwnerContext):Promise<HarmonyAccountExecutionOwner>=>this.createAccountOwner(context),
          onState:(state:HarmonyAccountControllerState):void=>{this.accountFailed=state.phase==='failed';if(state.phase==='failed')this.status=state.operation?.error?.message||'Account replacement failed; retry required';if(state.phase==='complete')this.startPump();},
        });
      }
      if(this.session===null)return;
      this.session.resize(width, height, physicalWidth, physicalHeight);
      const surfaceId = this.xComponentController.getXComponentSurfaceId();
      if (surfaceId !== this.attachedSurfaceId) {
        this.session.attachSurface(surfaceId, physicalWidth, physicalHeight);
        this.attachedSurfaceId = surfaceId;
      }
      this.startPump();
      this.presentationCheck?.();
    } catch (error) { this.reportFailure(error); }
  }

  private async createAccountOwner(context:HarmonyAccountOwnerContext):Promise<HarmonyAccountExecutionOwner>{
    const pack=this.pack;if(pack===null||this.closed)throw new HarmonyAccountError('ERR_CANCELLED','ArkUI owner is closed');
    const route=pack.requireRoute(context.launchOptions.route||pack.firstRoute());
    const engine=AppStorage.get<string>('weappContainerEngine')||'quickjs';
    if(!['quickjs','v8'].includes(engine))throw new HarmonyAccountError('ERR_ENGINE','explicit QuickJS or V8 provider required');
    const hostContextValue = this.getUIContext().getHostContext();
    if (hostContextValue === undefined) throw new HarmonyAccountError('ERR_HOST_CONTEXT', 'ArkUI host context is unavailable');
    const hostContext = hostContextValue as common.UIAbilityContext;
    const hostObservation=await collectHarmonyHostObservation(hostContext,Math.max(1,Math.round(this.areaWidth)),Math.max(1,Math.round(this.areaHeight)));
    const container=createWeappContainer();
    const services=new HarmonyHostServices(container,(error:Object)=>console.error(`WEAPP_CONTAINER_NATIVE_ERROR ${String(error)}`));
    const session=new HarmonyLiveSession(pack,container,{sessionId:context.sessionId,engine,route,width:hostObservation.windowWidth,height:hostObservation.windowHeight,foreground:abilityLifecycle.foreground,launchOptions:context.launchOptions,hostServices:services,hostIdentity:{application:context.application,account:context.account},hostObservation},(receipt:HarmonySessionReceipt):void=>{
      if(context.cancellation.cancelled||this.session?.executionIdentity().sessionId!==receipt.sessionId)return;
      this.observeReceipt(receipt);
    });
    this.session=session;this.attachedSurfaceId='';this.lastReceipt=null;this.initialSmokeLogged=false;this.smokeProbeLogged=false;
    try{
      new HarmonyDeviceApis(hostContext,services);const files=new HarmonyManagedFiles(services,`${hostContext.filesDir}/weapp-container-managed`);
      new HarmonySystemApis(hostContext,services,files);new HarmonyBluetoothApis(hostContext,services);new HarmonyRecorderApis(hostContext,services,files);
      new HarmonyNetworkApis(services,files,[]);new HarmonySocketApis(services,[]); // Explicit HTTPS allowlist; empty denies all origins.
      installHarmonyWifiApis(hostContext,services,this.getUIContext()); // Explicit host configuration; default installs no Wi-Fi APIs.
      installHarmonyNfcApis(hostContext,services,this.getUIContext()); // Explicit host purpose and exclusive foreground dispatch; default disabled.
      await installHarmonyReferenceHost(services,{application:context.application,account:context.account},this.getUIContext(),context);
    }catch(error){session.reportFailure(error as Object);}
    return {session,
      waitForPresentation:():Promise<void>=>new Promise<void>((resolve,reject):void=>{
        let settled=false;let remove:(()=>void)|null=null;
        const finish=(error?:Object):void=>{if(settled)return;settled=true;remove?.();if(this.presentationCheck===check)this.presentationCheck=null;if(error!==undefined)reject(error);else resolve();};
        const check=():void=>{
          if(this.closed||context.cancellation.cancelled||this.session!==session){finish(new HarmonyAccountError('ERR_CANCELLED','presentation owner retired'));return;}
          if(this.lastReceipt?.runtimeFailed||this.lastReceipt?.presentationSuspended){finish(new HarmonyAccountError('ERR_RENDER',this.lastReceipt.diagnostics.join('; ')));return;}
          if(session.isRunnable())finish();
        };
        this.presentationCheck=check;remove=context.cancellation.onCancel(():void=>finish(new HarmonyAccountError('ERR_CANCELLED','presentation cancelled')));
        this.synchronizeSurface();this.startPump();check();
      }),
      invoke:async(method:string,_payload:Object):Promise<Object>=>{if(method==='inspect')return JSON.parse(container.inspectState()) as Object;throw new HarmonyAccountError('ERR_INVALID_REQUEST','install an explicit business command handler');},
    };
  }

  private retryAccount():void{
    const controller=this.accountController;if(controller===null)return;
    try{controller.retry().catch((error:Object):void=>this.reportFailure(error));}catch(error){this.reportFailure(error as Object);}
  }

  private observeReceipt(receipt:HarmonySessionReceipt):void{
    this.lastReceipt=receipt;this.status=`${receipt.status} · ${receipt.route} · frame ${receipt.frameId} · ${receipt.engine}`;
    const observation:LiveObservation={schemaVersion:1,sessionId:receipt.sessionId,engine:receipt.engine,status:receipt.status,foreground:receipt.foreground,revision:receipt.revision,route:receipt.route,frameId:receipt.frameId,presentedFrameId:receipt.presentedFrameId,presentationSequence:receipt.presentationSequence,width:receipt.viewport.width,height:receipt.viewport.height,surfaceWidth:receipt.surfaceWidth,surfaceHeight:receipt.surfaceHeight,page:receipt.inspection?.page,viewRevision:receipt.inspection?.viewRevision,diagnostics:receipt.diagnostics,nativeFonts:receipt.inspection?.nativeFonts,evidenceBoundary:'sample-runtime-observation'};
    console.info(`WEAPP_CONTAINER_LIVE_STATE ${JSON.stringify(observation)}`);
    if(this.smokeEnabled()&&!this.initialSmokeLogged&&receipt.frameId>0){this.initialSmokeLogged=true;for(const op of ['app.init','app.lifecycle','page.push','render.commit']){const message=receipt.trace.find((item:BridgeMessage):boolean=>item.op===op&&item.kind==='response');if(message!==undefined)console.info(`WEAPP_CONTAINER_SMOKE ${op} ${JSON.stringify(this.smokeMessage(message))}`);}}
    if(this.smokeEnabled()&&!this.smokeProbeLogged&&receipt.frameId>0&&receipt.presentedFrameId===receipt.frameId&&this.session!==null){
      this.smokeProbeLogged=true;
      try{
        const probes=this.session.smokeProbe();
        if(probes!==null){
          const renderSnapshot=this.snapshotSummary(probes.renderSnapshot);
          const surfaceProbe=probes.surfaceProbe as Record<string,Object>;
          surfaceProbe['snapshotSha256']=renderSnapshot.sha256;
          console.info(`WEAPP_CONTAINER_SMOKE render.snapshot ${JSON.stringify(renderSnapshot)}`);
          console.info(`WEAPP_CONTAINER_SMOKE canvas.draw ${JSON.stringify({messages:[probes.canvasDraw]})}`);
          console.info(`WEAPP_CONTAINER_SMOKE canvas.snapshot ${JSON.stringify(this.snapshotSummary(probes.canvasSnapshot))}`);
          console.info(`WEAPP_CONTAINER_SMOKE api.call ${JSON.stringify({messages:[probes.apiCall]})}`);
          console.info(`WEAPP_CONTAINER_SURFACE_PROBE ${JSON.stringify(probes.surfaceProbe)}`);
          console.info(`WEAPP_CONTAINER_GPU_PROBE ${JSON.stringify(probes.gpuProbe)}`);
          this.writeExecutionReceipt(renderSnapshot,probes);
        }else throw new Error('ERR_RENDER: the first presented frame did not retain direct EGL surface evidence');
      }catch(error){console.error(`WEAPP_CONTAINER_SMOKE error ${JSON.stringify({message:String(error)})}`);}
    }
    if(receipt.diagnostics.length>0)console.error(`WEAPP_CONTAINER_SMOKE error ${JSON.stringify(receipt.diagnostics)}`);
    this.presentationCheck?.();
  }

  private startPump(): void {
    if (this.timer >= 0 || this.closed || !abilityLifecycle.foreground || this.session === null || !this.session.canPump()) return;
    // Timer polling is a complete host transaction. Date.now is Unix epoch;
    // the pure owner converts to checked decimal u64 nanoseconds losslessly.
    this.timer = setInterval(() => {
      if (this.session !== null) {
        this.session.pollTimers(Date.now());
        this.presentationCheck?.();
        if (!this.session.canPump()) this.stopPump();
      }
    }, 16);
  }

  private stopPump(): void {
    if (this.timer >= 0) clearInterval(this.timer);
    this.timer = -1;
  }

  private onSurfaceLoaded(): void {
    this.surfaceReady = true;
    this.synchronizeSurface();
  }

  private onSurfaceDestroyed(): void {
    this.surfaceReady = false;
    this.attachedSurfaceId = '';
    this.ignoringMultiple = false;
    if (this.session !== null) this.session.detachSurface();
    this.startPump();
  }

  private onSurfaceArea(width: number, height: number): void {
    this.areaWidth = width;
    this.areaHeight = height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      this.attachedSurfaceId = '';
      if (this.session !== null) this.session.detachSurface();
      this.startPump();
      return;
    }
    this.synchronizeSurface();
  }

  private onSurfaceTouch(event: TouchEvent): void {
    if (this.accountController?.state.inputEnabled!==true || this.session === null || !this.session.isRunnable()) return;
    if (event.touches.length > 1) {
      if (!this.ignoringMultiple) this.session.pointer('multiple', 0, 0, 0, Date.now());
      this.ignoringMultiple = true;
      return;
    }
    if (this.ignoringMultiple) {
      if (event.touches.length === 0) this.ignoringMultiple = false;
      return;
    }
    const touch = event.changedTouches[0];
    if (touch === undefined) return;
    let action = '';
    if (event.type === TouchType.Down) action = 'down';
    else if (event.type === TouchType.Move) action = 'move';
    else if (event.type === TouchType.Up) action = 'up';
    else if (event.type === TouchType.Cancel) action = 'cancel';
    if (action.length === 0) return;
    // ArkUI local coordinates are vp; Rust uses the rounded observed vp
    // viewport. No screen/status-bar offset or physical-pixel guess is used.
    const x = touch.x * Math.round(this.areaWidth) / this.areaWidth;
    const y = touch.y * Math.round(this.areaHeight) / this.areaHeight;
    this.session.pointer(action, touch.id, x, y, Date.now());
  }

  private closeSession(): void {
    if (this.closed&&this.accountController===null) return;
    this.closed = true;
    this.stopPump();
    this.ignoringMultiple = false;
    const controller=this.accountController;
    if(controller!==null)controller.close().then(()=>{if(this.accountController===controller){this.accountController=null;this.session=null;this.presentationCheck=null;}}).catch((error:Object)=>{this.reportFailure(error);});
    this.pack = null;
  }

  private reportFailure(error: Object): void {
    this.stopPump();
    const message = error instanceof Error ? error.message : String(error);
    this.status = message;
    if (this.session !== null) this.session.reportFailure(error);
    console.error(`WEAPP_CONTAINER_SMOKE error ${JSON.stringify({ message })}`);
  }

  private smokeEnabled(): boolean { return AppStorage.get<boolean>('weappContainerSmoke')===true; }

  private clearExecutionReceipt(): void {
    if(this.executionReceiptPath.length===0)return;
    for(const path of [this.executionReceiptPath,`${this.executionReceiptPath}.pending`]){
      try{fs.accessSync(path);fs.unlinkSync(path);}catch(_error){}
    }
  }

  private writeExecutionReceipt(renderSnapshot: SmokeSnapshotSummary, probes: HarmonySmokeProbeResult): void {
    if(this.executionReceiptFrozen||this.executionReceiptPath.length===0||this.pack===null||this.session===null)return;
    const operations=this.session.executionOperations() as Record<string,HarmonyExecutionOperation>;
    const surfaceProbe=probes.surfaceProbe as Record<string,Object>;
    const sessionId=surfaceProbe['sessionId'] as string;
    operations['render.snapshot']={status:0,sessionId,json:JSON.stringify(renderSnapshot)};
    const engine=surfaceProbe['engine'] as string;
    const fixtureId=AppStorage.get<string>('weappContainerFixtureId')||'portable-pack-reference-v1';
    if(fixtureId.length===0||fixtureId.length>256)throw new Error('ERR_ENGINE: invalid execution fixture identity');
    const receipt: ExecutionReceipt={
      schemaVersion:1,
      fixture:{id:fixtureId,sourceCommit:null,manifest:this.pack.manifest},
      host:'harmony',engine,status:'passed',sourceCommit:null,artifactSha256:null,
      fixtureId,manifestIntegrity:this.pack.integrityRoot,
      sessionId,route:this.lastReceipt?.route||this.pack.firstRoute(),
      operations,surfaceProbe,
      build:{status:'unknown',sourceCommit:null,workingTreeDirty:false,host:'harmony',engine,artifactSha256:null},
    };
    const pending=`${this.executionReceiptPath}.pending`;
    let file: fs.File|null=null;
    try{
      file=fs.openSync(pending,fs.OpenMode.READ_WRITE|fs.OpenMode.CREATE|fs.OpenMode.TRUNC|fs.OpenMode.NOFOLLOW);
      fs.writeSync(file.fd,JSON.stringify(receipt));
      fs.fsyncSync(file.fd);
    }finally{if(file!==null)fs.closeSync(file);}
    fs.renameSync(pending,this.executionReceiptPath);
    this.executionReceiptFrozen=true;
    console.info(`WEAPP_CONTAINER_EXECUTION_RECEIPT ${JSON.stringify({path:this.executionReceiptPath,sessionId:surfaceProbe['sessionId']})}`);
  }

  private smokeMessage(message: BridgeMessage): BridgeBatch {
    if(message.op!=='app.init')return {messages:[message]};
    const payload: BridgePayload = {
      ok: message.payload.ok,
      engine: message.payload.engine,
      engineProviderAvailable: message.payload.engineProviderAvailable,
      loadedModules: message.payload.loadedModules,
      manifest: message.payload.manifest,
    };
    const smokeMessage: BridgeMessage = {
      protocolVersion: message.protocolVersion,
      sessionId: message.sessionId,
      requestId: message.requestId,
      kind: message.kind,
      op: message.op,
      payload,
    };
    return { messages: [smokeMessage] };
  }

  private snapshotSummary(json: string): SmokeSnapshotSummary {
    const snapshot=JSON.parse(json) as SmokeSnapshot;
    const pixels=snapshot.pixels;
    if(!Array.isArray(pixels)||!Number.isSafeInteger(snapshot.width)||snapshot.width<1||!Number.isSafeInteger(snapshot.height)||snapshot.height<1||!Number.isSafeInteger(snapshot.frame_id)||snapshot.frame_id<1||snapshot.format!=='rgba8-premultiplied'||snapshot.stride<snapshot.width*4||pixels.length!==snapshot.width*snapshot.height*4)throw new Error('ERR_RENDER: smoke snapshot metadata or byte length is invalid');
    const bytes=new Uint8Array(pixels.length);
    for(let index=0;index<pixels.length;index+=1){const pixel=pixels[index];if(!Number.isInteger(pixel)||pixel<0||pixel>255)throw new Error('ERR_RENDER: smoke snapshot contains an invalid RGBA byte');bytes[index]=pixel;}
    const summary: SmokeSnapshotSummary = {
      frame_id: snapshot.frame_id,
      width: snapshot.width,
      height: snapshot.height,
      stride: snapshot.stride,
      format: snapshot.format,
      pixelCount: pixels.length,
      sha256: sha256Bytes(bytes),
      pixels: pixels.slice(0, 4),
    };
    return summary;
  }

  build(): void {
    Column() {
      // A separate status strip keeps the native content surface unobscured.
      Text('Weapp Container').fontSize(18).height(28)
      Text(this.status).fontSize(11).maxLines(2).height(36)
      if(this.accountFailed){Button('Retry account owner').onClick(():void=>this.retryAccount())}
      Stack() {
        XComponent({
          id: 'weapp-container-surface', type: 'surface', libraryname: 'entry', controller: this.xComponentController,
        })
          .onLoad(() => { this.onSurfaceLoaded(); })
          .onDestroy(() => { this.onSurfaceDestroyed(); })
          .width('100%')
          .height('100%')
        // The native XComponent owns presentation. A coextensive ArkUI input
        // plane owns pointer delivery instead of relying on generic touch
        // handlers on a native surface. Both use the same local vp geometry.
        Column() {}
          .id('weapp-container-input')
          .width('100%')
          .height('100%')
          .hitTestBehavior(HitTestMode.Block)
          .onTouch((event: TouchEvent) => { this.onSurfaceTouch(event); })
      }
        .onAreaChange((_oldArea: Area, area: Area) => { this.onSurfaceArea(Number(area.width), Number(area.height)); })
        .width('100%')
        .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
  }
}
