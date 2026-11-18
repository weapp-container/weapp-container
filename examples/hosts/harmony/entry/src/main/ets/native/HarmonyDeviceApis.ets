import common from '@ohos.app.ability.common';
import abilityAccessCtrl from '@ohos.abilityAccessCtrl';
import { Permissions } from '@ohos.abilityAccessCtrl';
import pasteboard from '@ohos.pasteboard';
import batteryInfo from '@ohos.batteryInfo';
import connection from '@ohos.net.connection';
import vibrator from '@ohos.vibrator';
import geoLocationManager from '@ohos.geoLocationManager';
import sensor from '@ohos.sensor';
import userAuth from '@ohos.userIAM.userAuth';
import window from '@ohos.window';
import promptAction from '@ohos.promptAction';
import call from '@ohos.telephony.call';
import { BusinessError } from '@ohos.base';
import { HarmonyHostServices, HarmonyApiCall, HarmonyApiError } from '../session/HostServices';

interface DeviceOptions {
  data?: string; value?: number; keepScreenOn?: boolean; type?: string; interval?: string;
  subscriptionId?: string; action?: string; title?: string; content?: string; duration?: number;
  confirmText?: string; cancelText?: string; showCancel?: boolean; itemList?: Array<string>;
  phoneNumber?: string; scope?: string; isHighAccuracy?: boolean;checkAuthMode?: string;
}
interface DeviceResult {
  errMsg?: string; data?: string; value?: number; level?: number; isCharging?: boolean;
  networkType?: string; confirm?: boolean; cancel?: boolean; tapIndex?: number;
  latitude?: number; longitude?: number; accuracy?: number | string; altitude?: number;
  speed?: number; horizontalAccuracy?: number; verticalAccuracy?: number;
  x?: number; y?: number; z?: number; direction?: number;supportMode?: Array<string>;isEnrolled?: boolean;
}
interface AppPermissionSnapshot {
  cameraAuthorized?: string;microphoneAuthorized?: string;locationAuthorized?: string;
  bluetoothAuthorized?: string;phoneCalendarAuthorized?: string;locationReducedAccuracy?: boolean;
}
interface DeviceSubscription { call: HarmonyApiCall; id: string; event: string; sequence: number; }
interface SensorResource { active: boolean; stopped: boolean; stop: () => void; }

/** API 24 OpenHarmony device adapter. Install explicitly before app.init.
 * Each operation delegates to the real system API; no simulator success data.
 */
export class HarmonyDeviceApis {
  private readonly context: common.UIAbilityContext;
  private readonly services: HarmonyHostServices;
  private readonly sensors: Map<string, SensorResource> = new Map();
  private readonly subscriptions: Map<string, DeviceSubscription> = new Map();
  private toastId: number | null = null;
  private foreground: boolean = true;
  private closed: boolean = false;
  private brightnessQueue: Promise<void> = Promise.resolve();
  private keepScreenQueue: Promise<void> = Promise.resolve();
  private toastQueue: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private brightnessWindow: window.Window | null = null;
  private brightnessOriginal: number | null = null;
  private keepScreenWindow: window.Window | null = null;
  private keepScreenOriginal: boolean | null = null;
  readonly supportedApis: Array<string> = [
    'wx.getClipboardData', 'wx.setClipboardData', 'wx.getBatteryInfo', 'wx.getNetworkType',
    'wx.getScreenBrightness', 'wx.setScreenBrightness', 'wx.setKeepScreenOn', 'wx.vibrateLong', 'wx.vibrateShort',
    'wx.showToast', 'wx.hideToast', 'wx.showModal', 'wx.showActionSheet', 'wx.makePhoneCall', 'wx.authorize',
    'wx.getLocation', 'wx.getFuzzyLocation','wx.checkIsSupportSoterAuthentication','wx.checkIsSoterEnrolledInDevice',
    'wx.startAccelerometer', 'wx.stopAccelerometer', 'wx.onAccelerometerChange', 'wx.offAccelerometerChange',
    'wx.startGyroscope', 'wx.stopGyroscope', 'wx.onGyroscopeChange', 'wx.offGyroscopeChange',
    'wx.startCompass', 'wx.stopCompass', 'wx.onCompassChange', 'wx.offCompassChange',
  ];
  constructor(context: common.UIAbilityContext, services: HarmonyHostServices) {
    this.context = context; this.services = services;
    services.setSyncSnapshot('wx.getAppAuthorizeSetting',this.appPermissions());
    for(const api of this.supportedApis) services.registerApiHandler(api, async (payload: Object, nativeCall: HarmonyApiCall): Promise<Object> => {
      try { return await this.invoke(api, payload as DeviceOptions, nativeCall); }
      catch(error) {
        if(error instanceof HarmonyApiError)throw error;
        const nativeError = error as BusinessError;
        throw new HarmonyApiError(nativeError.code === 201 || nativeError.code === 202 ? 'permission_denied' : [801,12500005,12500006].includes(nativeError.code) ? 'unsupported' : 'invalid_request',
          nativeError.message, nativeError.code, `${api.replace(/^wx\./,'')}:fail ${nativeError.message}`);
      }
    });
    services.onForeground((visible: boolean) => { this.foreground=visible;if(!visible)this.stopDevices();else this.refreshPermissions(); });
    services.onClose(() => this.close());
  }
  private ok(api: string, values: DeviceResult = {}): DeviceResult { values.errMsg=`${api.replace(/^wx\./,'')}:ok`;return values; }
  private requireCurrent(nativeCall: HarmonyApiCall): void { if(this.closed||nativeCall.cancellation.cancelled)throw new HarmonyApiError('cancelled','native owner retired'); }
  private async permissions(permissions: Array<Permissions>, nativeCall: HarmonyApiCall): Promise<void> {
    const result=await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(this.context,permissions);
    this.requireCurrent(nativeCall);this.refreshPermissions();
    if(result.authResults.some((value: number) => value !== 0))throw new HarmonyApiError('permission_denied','OS permission denied',201,'authorize:fail auth deny');
  }
  private appPermissions(): AppPermissionSnapshot {
    const manager=abilityAccessCtrl.createAtManager();
    const status=(permission:Permissions):string|undefined=>{
      const value=manager.getSelfPermissionStatus(permission);
      if(value===abilityAccessCtrl.PermissionStatus.GRANTED)return 'authorized';
      if(value===abilityAccessCtrl.PermissionStatus.DENIED||value===abilityAccessCtrl.PermissionStatus.RESTRICTED)return 'denied';
      if(value===abilityAccessCtrl.PermissionStatus.NOT_DETERMINED)return 'not determined';return undefined;
    };
    const precise=status('ohos.permission.LOCATION'),approximate=status('ohos.permission.APPROXIMATELY_LOCATION');
    const value:AppPermissionSnapshot={cameraAuthorized:status('ohos.permission.CAMERA'),microphoneAuthorized:status('ohos.permission.MICROPHONE'),locationAuthorized:precise==='authorized'||approximate==='authorized'?'authorized':precise,bluetoothAuthorized:status('ohos.permission.ACCESS_BLUETOOTH'),phoneCalendarAuthorized:status('ohos.permission.READ_CALENDAR')};
    if(precise!==undefined&&approximate!==undefined)value.locationReducedAccuracy=approximate==='authorized'&&precise!=='authorized';
    return value;
  }
  private refreshPermissions():void {const snapshots:Record<string,Object>={'wx.getAppAuthorizeSetting':this.appPermissions()};this.services.updateSyncSnapshots(snapshots);}
  private async invoke(api: string, options: DeviceOptions, nativeCall: HarmonyApiCall): Promise<Object> {
    this.requireCurrent(nativeCall);
    switch(api) {
      case 'wx.checkIsSupportSoterAuthentication': {
        const supportMode:Array<string>=[];
        for(const mode of ['fingerPrint','facial']) {
          try{userAuth.getAvailableStatus(mode==='fingerPrint'?userAuth.UserAuthType.FINGERPRINT:userAuth.UserAuthType.FACE,userAuth.AuthTrustLevel.ATL1);supportMode.push(mode);}
          catch(error){const native=error as BusinessError;if(native.code===12500010||native.code===12500013)supportMode.push(mode);else if(native.code!==12500005&&native.code!==12500006)throw new HarmonyApiError(native.code===201?'permission_denied':native.code===801?'unsupported':'invalid_request',native.message,native.code);}
        }
        return this.ok(api,{supportMode});
      }
      case 'wx.checkIsSoterEnrolledInDevice': {
        if(options.checkAuthMode!=='fingerPrint'&&options.checkAuthMode!=='facial')throw new HarmonyApiError('invalid_request','checkAuthMode must be fingerPrint or facial');
        try{const state=userAuth.getEnrolledState(options.checkAuthMode==='fingerPrint'?userAuth.UserAuthType.FINGERPRINT:userAuth.UserAuthType.FACE);return this.ok(api,{isEnrolled:state.credentialCount>0});}
        catch(error){const native=error as BusinessError;if(native.code===12500010)return this.ok(api,{isEnrolled:false});throw new HarmonyApiError(native.code===201?'permission_denied':[801,12500005,12500006].includes(native.code)?'unsupported':'invalid_request',native.message,native.code);}
      }
      case 'wx.getClipboardData': return this.ok(api,{data:(await pasteboard.getSystemPasteboard().getData()).getPrimaryText()});
      case 'wx.setClipboardData':
        if(typeof options.data !== 'string' || options.data.length > 1048576)throw new HarmonyApiError('invalid_request','invalid clipboard data');
        await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN,options.data));return this.ok(api);
      case 'wx.getBatteryInfo': return this.ok(api,{level:batteryInfo.batterySOC,isCharging:[batteryInfo.BatteryChargeState.ENABLE,batteryInfo.BatteryChargeState.FULL].includes(batteryInfo.chargingStatus)});
      case 'wx.getNetworkType': {
        const network=await connection.getDefaultNet();
        if(network.netId===0)return this.ok(api,{networkType:'none'});
        const capabilities=await connection.getNetCapabilities(network);
        return this.ok(api,{networkType:capabilities.bearerTypes.includes(connection.NetBearType.BEARER_WIFI)?'wifi':'unknown'});
      }
      case 'wx.getScreenBrightness': {
        const value=(await window.getLastWindow(this.context)).getWindowProperties().brightness;
        if(value<0||value>1)throw new HarmonyApiError('unsupported','system-managed brightness is not exposed by the window service');
        return this.ok(api,{value});
      }
      case 'wx.setScreenBrightness': {
        if(options.value===undefined || !Number.isFinite(options.value) || options.value<0 || options.value>1)throw new HarmonyApiError('invalid_request','brightness must be in 0..1');
        const value=options.value;
        const task=this.brightnessQueue.then(async():Promise<void>=>{
          this.requireCurrent(nativeCall);const target=await window.getLastWindow(this.context);this.requireCurrent(nativeCall);
          if(this.brightnessWindow!==null&&this.brightnessWindow!==target)await this.restoreBrightness();
          if(this.brightnessWindow===null){this.brightnessWindow=target;this.brightnessOriginal=target.getWindowProperties().brightness;}
          await target.setWindowBrightness(value);
          if(this.closed||nativeCall.cancellation.cancelled)await this.restoreBrightness();
        });this.brightnessQueue=task.catch(():void=>{});await task;
        return this.ok(api);
      }
      case 'wx.setKeepScreenOn': {
        if(typeof options.keepScreenOn!=='boolean')throw new HarmonyApiError('invalid_request','keepScreenOn must be boolean');
        const value=options.keepScreenOn;
        const task=this.keepScreenQueue.then(async():Promise<void>=>{
          this.requireCurrent(nativeCall);const target=await window.getLastWindow(this.context);this.requireCurrent(nativeCall);
          if(this.keepScreenWindow!==null&&this.keepScreenWindow!==target)await this.restoreKeepScreen();
          if(this.keepScreenWindow===null){this.keepScreenWindow=target;this.keepScreenOriginal=target.getWindowProperties().isKeepScreenOn;}
          await target.setWindowKeepScreenOn(value);
          if(this.closed||nativeCall.cancellation.cancelled)await this.restoreKeepScreen();
        });this.keepScreenQueue=task.catch(():void=>{});await task;return this.ok(api);
      }
      case 'wx.vibrateLong':case 'wx.vibrateShort':
        await vibrator.startVibration({type:'time',duration:api==='wx.vibrateLong'?400:15},{usage:'touch'});return this.ok(api);
      case 'wx.makePhoneCall':
        if(typeof options.phoneNumber!=='string'||! /^[+0-9 ()-]{1,64}$/.test(options.phoneNumber))throw new HarmonyApiError('invalid_request','invalid phone number');
        await call.makeCall(this.context,options.phoneNumber);return this.ok(api);
      case 'wx.showToast': {
        if(typeof options.title!=='string')throw new HarmonyApiError('invalid_request','title required');
        const title=options.title;
        const task=this.toastQueue.then(async():Promise<void>=>{
          this.requireCurrent(nativeCall);this.closeToast();
          this.toastId=await promptAction.openToast({message:title,duration:Math.min(10000,Math.max(1500,options.duration||1500))});
          if(this.closed||nativeCall.cancellation.cancelled)this.closeToast();
        });this.toastQueue=task.catch(():void=>{});await task;return this.ok(api);
      }
      case 'wx.hideToast': {
        const task=this.toastQueue.then(():void=>{this.requireCurrent(nativeCall);this.closeToast();});this.toastQueue=task.catch(():void=>{});await task;return this.ok(api);
      }
      case 'wx.showModal': {
        const buttons: Array<promptAction.Button> = [{text:options.confirmText||'确定',color:'#1677ff'}];
        if(options.showCancel!==false)buttons.push({text:options.cancelText||'取消',color:'#666666'});
        const result=await promptAction.showDialog({title:options.title||'',message:options.content||'',buttons});this.requireCurrent(nativeCall);
        return this.ok(api,{confirm:result.index===0,cancel:result.index!==0});
      }
      case 'wx.showActionSheet': {
        const items=options.itemList;
        if(items===undefined||items.length<1||items.length>6)throw new HarmonyApiError('invalid_request','itemList must contain 1..6 strings');
        const buttons: [promptAction.Button,promptAction.Button?,promptAction.Button?,promptAction.Button?,promptAction.Button?,promptAction.Button?] = [{text:items[0],color:'#111111'}];
        for(let index=1;index<items.length;index++)buttons.push({text:items[index],color:'#111111'});
        const result: promptAction.ActionMenuSuccessResponse=await promptAction.showActionMenu({buttons});this.requireCurrent(nativeCall);return this.ok(api,{tapIndex:result.index});
      }
      case 'wx.authorize': {
        const permissions: Array<Permissions> = options.scope==='scope.userLocation'?['ohos.permission.APPROXIMATELY_LOCATION','ohos.permission.LOCATION']:options.scope==='scope.camera'?['ohos.permission.CAMERA']:options.scope==='scope.record'?['ohos.permission.MICROPHONE']:[];
        if(permissions.length===0)throw new HarmonyApiError('unsupported','scope requires a host-specific authorization flow');
        await this.permissions(permissions,nativeCall);return this.ok(api);
      }
      case 'wx.getLocation':case 'wx.getFuzzyLocation': {
        if(options.type!==undefined&&options.type!=='wgs84')throw new HarmonyApiError('unsupported','GCJ02 requires an explicitly configured coordinate adapter');
        await this.permissions(api==='wx.getFuzzyLocation'?['ohos.permission.APPROXIMATELY_LOCATION']:['ohos.permission.APPROXIMATELY_LOCATION','ohos.permission.LOCATION'],nativeCall);
        const location=await geoLocationManager.getCurrentLocation({priority:geoLocationManager.LocationRequestPriority.ACCURACY,scenario:geoLocationManager.LocationRequestScenario.UNSET});
        this.requireCurrent(nativeCall);
        return this.ok(api,{latitude:location.latitude,longitude:location.longitude,accuracy:location.accuracy,altitude:location.altitude,speed:location.speed,horizontalAccuracy:location.accuracy,verticalAccuracy:location.altitudeAccuracy});
      }
      default:return this.sensor(api,options,nativeCall);
    }
  }
  private sensor(api: string, options: DeviceOptions, nativeCall: HarmonyApiCall): Object {
    const family=api.includes('Accelerometer')?'Accelerometer':api.includes('Gyroscope')?'Gyroscope':'Compass';
    if(api.startsWith('wx.on')) {
      if(typeof options.subscriptionId!=='string')throw new HarmonyApiError('invalid_request','subscriptionId required');
      const id=options.subscriptionId;this.subscriptions.set(id,{call:nativeCall,id,event:`${family}Change`,sequence:0});
      nativeCall.cancellation.retainUntilCancelled();nativeCall.cancellation.onCancel(()=>{this.subscriptions.delete(id);});
    } else if(api.startsWith('wx.off')) { if(options.subscriptionId!==undefined)this.subscriptions.delete(options.subscriptionId); }
    else if(api.startsWith('wx.stop')) { this.stopSensor(family); }
    else {
      if(!this.foreground)throw new HarmonyApiError('permission_denied','foreground sensor access required');
      const interval=options.interval==='game'?20000000:options.interval==='ui'?60000000:200000000;
      if(options.interval!==undefined&&!['normal','ui','game'].includes(options.interval))throw new HarmonyApiError('invalid_request','unknown sensor interval');
      this.stopSensor(family);
      const resource:SensorResource={active:true,stopped:false,stop:():void=>{}};
      this.sensors.set(family,resource);
      if(family==='Accelerometer'){
        const listener=(value:sensor.AccelerometerResponse):void=>{if(resource.active&&!nativeCall.cancellation.cancelled)this.emit(family,{x:value.x/9.80665,y:value.y/9.80665,z:value.z/9.80665});};
        resource.stop=():void=>sensor.off(sensor.SensorId.ACCELEROMETER,listener);
        try{sensor.on(sensor.SensorId.ACCELEROMETER,listener,{interval});}catch(error){resource.active=false;throw error as Error;}
      } else if(family==='Gyroscope'){
        const listener=(value:sensor.GyroscopeResponse):void=>{if(resource.active&&!nativeCall.cancellation.cancelled)this.emit(family,{x:value.x,y:value.y,z:value.z});};
        resource.stop=():void=>sensor.off(sensor.SensorId.GYROSCOPE,listener);
        try{sensor.on(sensor.SensorId.GYROSCOPE,listener,{interval});}catch(error){resource.active=false;throw error as Error;}
      } else {
        const listener=(value:sensor.OrientationResponse):void=>{if(resource.active&&!nativeCall.cancellation.cancelled)this.emit(family,{direction:value.alpha,accuracy:'unknown'});};
        resource.stop=():void=>sensor.off(sensor.SensorId.ORIENTATION,listener);
        try{sensor.on(sensor.SensorId.ORIENTATION,listener,{interval});}catch(error){resource.active=false;throw error as Error;}
      }
      nativeCall.cancellation.retainUntilCancelled();nativeCall.cancellation.onCancel(():void=>this.stopSensor(family,resource));
    }
    return this.ok(api);
  }
  private emit(family:string,value:DeviceResult):void {
    if(this.closed||!this.foreground)return;
    const resource=this.sensors.get(family);if(resource===undefined||!resource.active)return;
    for(const subscription of this.subscriptions.values())if(subscription.event===`${family}Change`&&!subscription.call.cancellation.cancelled){
      subscription.sequence++;
      if(!this.services.emit(subscription.call.context,subscription.id,subscription.sequence,subscription.event,value,undefined,():boolean=>resource.active&&!this.closed&&this.foreground&&!subscription.call.cancellation.cancelled)){
        try{this.stopSensor(family);}catch(error){console.error(`WEAPP_CONTAINER_SENSOR_CLEANUP ${String(error)}`);}return;
      }
    }
  }
  private stopSensor(family:string,resource:SensorResource|undefined=this.sensors.get(family)):void {
    if(resource===undefined||resource.stopped)return;resource.active=false;
    resource.stop();resource.stopped=true;
    if(this.sensors.get(family)===resource)this.sensors.delete(family);
  }
  private stopDevices():void {
    const failures: Array<Error> = [];
    for(const family of this.sensors.keys()){try{this.stopSensor(family);}catch(error){failures.push(error as Error);}}
    if(failures.length>0)throw new Error(`${failures.length} sensor resources failed to stop`);
  }
  private closeToast():void {const id=this.toastId;if(id!==null){promptAction.closeToast(id);if(this.toastId===id)this.toastId=null;}}
  private async restoreBrightness():Promise<void> {
    const target=this.brightnessWindow,original=this.brightnessOriginal;
    if(target!==null&&original!==null){await target.setWindowBrightness(original);if(this.brightnessWindow===target){this.brightnessWindow=null;this.brightnessOriginal=null;}}
  }
  private async restoreKeepScreen():Promise<void> {
    const target=this.keepScreenWindow,original=this.keepScreenOriginal;
    if(target!==null&&original!==null){await target.setWindowKeepScreenOn(original);if(this.keepScreenWindow===target){this.keepScreenWindow=null;this.keepScreenOriginal=null;}}
  }
  close():Promise<void> {
    if(this.closing!==null)return this.closing;
    this.closed=true;this.foreground=false;
    const task=(async():Promise<void>=>{
      const failures: Array<Error> = [];
      try{this.stopDevices();}catch(error){failures.push(error as Error);}
      this.subscriptions.clear();
      await Promise.all([this.brightnessQueue,this.keepScreenQueue,this.toastQueue]);
      try{this.closeToast();}catch(error){failures.push(error as Error);}
      try{await this.restoreBrightness();}catch(error){failures.push(error as Error);}
      try{await this.restoreKeepScreen();}catch(error){failures.push(error as Error);}
      if(failures.length>0)throw new Error(`${failures.length} native device resources failed to close`);
    })();this.closing=task.finally(():void=>{this.closing=null;});return this.closing;
  }
}
