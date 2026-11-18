import common from '@ohos.app.ability.common';
import abilityAccessCtrl from '@ohos.abilityAccessCtrl';
import ble from '@ohos.bluetooth.ble';
import access from '@ohos.bluetooth.access';
import constant from '@ohos.bluetooth.constant';
import promptAction from '@ohos.promptAction';
import { BusinessError } from '@ohos.base';
import { HarmonyHostServices, HarmonyApiCall, HarmonyApiError } from '../session/HostServices';

interface BluetoothOptions {
  deviceId?: string; serviceId?: string; characteristicId?: string; services?: Array<string>;
  subscriptionId?: string; action?: string; state?: boolean; value?: Object; writeType?: string;
  timeout?: number; mtu?: number; interval?: number; allowDuplicatesKey?: boolean; mode?: string;
}
interface BinaryEnvelope { __weappBinary: BinaryBytes; }
interface BinaryBytes { bytes: Array<number>; type: string; }
interface BluetoothDevice {
  deviceId: string; name?: string; localName?: string; RSSI?: number;
  advertisData?: BinaryEnvelope; advertisServiceUUIDs?: Array<string>; serviceData?: Record<string, BinaryEnvelope>;
}
interface ServiceResult { uuid: string; isPrimary: boolean; }
interface CharacteristicProperties { read: boolean; write: boolean; notify: boolean; indicate: boolean; writeNoResponse: boolean; writeDefault: boolean; }
interface CharacteristicResult { uuid: string; properties: CharacteristicProperties; }
interface BluetoothResult {
  errMsg?: string; available?: boolean; discovering?: boolean; devices?: Array<BluetoothDevice>;
  services?: Array<ServiceResult>; characteristics?: Array<CharacteristicResult>; RSSI?: number; mtu?: number;
  deviceId?: string; connected?: boolean; serviceId?: string; characteristicId?: string; value?: BinaryEnvelope;
}
interface BluetoothSubscription { call: HarmonyApiCall; id: string; event: string; sequence: number; }
interface AdvertisementField { type: number; bytes: Uint8Array; }
interface BluetoothNotificationLease { active: boolean; }
interface BluetoothConnection {
  deviceId: string; client: ble.GattClientDevice; call: HarmonyApiCall; generation: number;
  connected: boolean; retiring: boolean; nativeClosed: boolean; mtu: number;
  services: Array<ble.GattService>; notifications: Map<string, BluetoothNotificationLease>; queue: Promise<BluetoothResult>;
  retirement: Promise<void> | null; connectFinish: ((error?: HarmonyApiError) => void) | null;
  mtuFinish: ((error?: HarmonyApiError) => void) | null;
  stateListener: (state: ble.BLEConnectionChangeState) => void;
  valueListener: (value: ble.BLECharacteristic) => void; mtuListener: (mtu: number) => void;
}

// The platform scanner is process-wide. A second container receives an explicit
// busy error and cannot stop, replace filters or consume another app's scan.
let scanOwner: HarmonyBluetoothApis | null = null;

/** API24 central/GATT implementation. Native callbacks only enqueue through
 * HarmonyHostServices; its owner drain is the sole N-API/QuickJS entry point. */
export class HarmonyBluetoothApis {
  private readonly context: common.UIAbilityContext;
  private readonly services: HarmonyHostServices;
  private readonly devices: Map<string, BluetoothDevice> = new Map();
  private readonly connections: Map<string, BluetoothConnection> = new Map();
  private readonly subscriptions: Map<string, BluetoothSubscription> = new Map();
  private readonly retiring: Set<BluetoothConnection> = new Set();
  private readonly backgroundDrains: Set<Promise<void>> = new Set();
  private opened: boolean = false;
  private closed: boolean = false;
  private foreground: boolean = true;
  private discovering: boolean = false;
  private generation: number = 0;
  private opening: boolean = false;
  private scanServices: Array<string> = [];
  private duplicates: boolean = false;
  private stateRegistered: boolean = false;
  private scanRegistered: boolean = false;
  private adapterLease: number = 0;
  private scanLease: number = 0;
  private stateListener: ((state: access.BluetoothState) => void) | null = null;
  private scanListener: ((values: Array<ble.ScanResult>) => void) | null = null;
  readonly supportedApis: Array<string> = [
    'wx.openBluetoothAdapter','wx.closeBluetoothAdapter','wx.getBluetoothAdapterState',
    'wx.startBluetoothDevicesDiscovery','wx.stopBluetoothDevicesDiscovery','wx.getBluetoothDevices','wx.getConnectedBluetoothDevices',
    'wx.createBLEConnection','wx.closeBLEConnection','wx.getBLEDeviceServices','wx.getBLEDeviceCharacteristics','wx.getBLEDeviceRSSI',
    'wx.readBLECharacteristicValue','wx.writeBLECharacteristicValue','wx.notifyBLECharacteristicValueChange','wx.getBLEMTU','wx.setBLEMTU',
    'wx.onBluetoothAdapterStateChange','wx.offBluetoothAdapterStateChange','wx.onBluetoothDeviceFound','wx.offBluetoothDeviceFound',
    'wx.onBLEConnectionStateChange','wx.offBLEConnectionStateChange','wx.onBLECharacteristicValueChange','wx.offBLECharacteristicValueChange',
    'wx.onBLEMTUChange','wx.offBLEMTUChange',
  ];
  constructor(context: common.UIAbilityContext, services: HarmonyHostServices) {
    this.context = context; this.services = services;
    for (const api of this.supportedApis) services.registerApiHandler(api, async (payload: Object, call: HarmonyApiCall): Promise<Object> => {
      try { return await this.invoke(api, payload as BluetoothOptions, call); }
      catch (error) {
        if (error instanceof HarmonyApiError) throw error;
        const native = error as BusinessError;
        throw new HarmonyApiError(native.code === 201 || native.code === 202 ? 'permission_denied' : native.code === 801 ? 'unsupported' : 'invalid_request',native.message,native.code,`${api.replace(/^wx\./,'')}:fail ${native.message}`);
      }
    });
    services.onForeground((visible: boolean): void => { this.foreground = visible; if (!visible) { this.generation++; this.background(this.stopResources()); } });
    services.onClose((): Promise<void> => this.close());
  }
  private ok(api: string, values: BluetoothResult = {}): BluetoothResult { values.errMsg = `${api.replace(/^wx\./,'')}:ok`; return values; }
  private fail(reason: string, code: number = 10000): HarmonyApiError { return new HarmonyApiError('invalid_request',reason,code,`Bluetooth:fail ${reason}`); }
  private available(): boolean { return access.getState() === access.BluetoothState.STATE_ON; }
  private current(call: HarmonyApiCall, generation: number = this.generation): void {
    if (this.closed || !this.foreground || generation !== this.generation || call.cancellation.cancelled) throw new HarmonyApiError('cancelled','Bluetooth execution owner retired');
  }
  private permitted(): void {
    if (abilityAccessCtrl.createAtManager().getSelfPermissionStatus('ohos.permission.ACCESS_BLUETOOTH') !== abilityAccessCtrl.PermissionStatus.GRANTED) {
      this.generation++; this.background(this.stopResources());
      throw new HarmonyApiError('permission_denied','Bluetooth permission revoked',201,'Bluetooth:fail auth deny');
    }
  }
  private uuid(value?: string): string {
    if (value === undefined) throw this.fail('UUID required',10013);
    let uuid = value.toUpperCase();
    if (/^[0-9A-F]{4}$/.test(uuid)) uuid = `0000${uuid}-0000-1000-8000-00805F9B34FB`;
    else if (/^[0-9A-F]{8}$/.test(uuid)) uuid = `${uuid}-0000-1000-8000-00805F9B34FB`;
    if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(uuid)) throw this.fail('invalid UUID',10013);
    return uuid;
  }
  private deviceId(value?: string): string {
    if (value === undefined || !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(value)) throw this.fail('valid Bluetooth deviceId required',10013);
    return value.toUpperCase();
  }
  private async invoke(api: string, options: BluetoothOptions, call: HarmonyApiCall): Promise<Object> {
    const accepted = this.generation; this.current(call,accepted);
    if (api.startsWith('wx.on') || api.startsWith('wx.off')) {
      if (typeof options.subscriptionId !== 'string' || options.subscriptionId.length === 0) throw this.fail('subscriptionId required',10013);
      const id = options.subscriptionId;
      if (api.startsWith('wx.off') || options.action === 'unsubscribe') this.subscriptions.delete(id);
      else {
        if (this.subscriptions.size >= 128 || this.subscriptions.has(id)) throw this.fail('Bluetooth subscription limit or duplicate');
        this.subscriptions.set(id,{call,id,event:api.substring(5),sequence:0});
        call.cancellation.retainUntilCancelled(); call.cancellation.onCancel((): void => { this.subscriptions.delete(id); });
      }
      return this.ok(api);
    }
    if (api === 'wx.openBluetoothAdapter') {
      if (options.mode !== undefined && options.mode !== 'central') throw new HarmonyApiError('unsupported','only central mode is installed');
      if (this.opened) { this.permitted(); if (!this.available()) throw this.fail('Bluetooth is unavailable',10001); return this.ok(api); }
      if (this.opening) throw this.fail('Bluetooth authorization is already pending');
      this.opening = true;
      try {
        const app = call.context.application;
        const consent = await promptAction.showDialog({title:'蓝牙授权',message:`${app.appId}（${app.publisherId}）申请发现并连接附近的蓝牙设备。此授权仅适用于当前账号和小程序。`,buttons:[{text:'允许',color:'#1677ff'},{text:'拒绝',color:'#666666'}]});
        this.current(call,accepted); if (consent.index !== 0) throw new HarmonyApiError('permission_denied','App Bluetooth permission denied',201,'openBluetoothAdapter:fail auth deny');
        const permission = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(this.context,['ohos.permission.ACCESS_BLUETOOTH']);
        this.current(call,accepted);
        if (permission.authResults.length !== 1 || permission.authResults[0] !== 0) throw new HarmonyApiError('permission_denied','OS Bluetooth permission denied',201,'openBluetoothAdapter:fail auth deny');
        this.permitted(); if (!this.available()) throw this.fail('Bluetooth is unavailable',10001);
        const lease = ++this.adapterLease;
        this.stateListener = (state: access.BluetoothState): void => {
          if (lease !== this.adapterLease || !this.opened || this.closed) return;
          try { this.permitted(); } catch { return; }
          const available = state === access.BluetoothState.STATE_ON;
          if (!available) { this.generation++; this.background(this.stopResources()); }
          this.emit('BluetoothAdapterStateChange',{available,discovering:this.discovering});
        };
        access.on('stateChange',this.stateListener); this.stateRegistered = true; this.opened = true;
        call.cancellation.retainUntilCancelled(); call.cancellation.onCancel((): Promise<void> => lease === this.adapterLease ? this.retireAdapter() : Promise.resolve());
        return this.ok(api);
      } finally { this.opening = false; }
    }
    if (api === 'wx.closeBluetoothAdapter') { await this.retireAdapter(); return this.ok(api); }
    if (!this.opened) throw this.fail('Bluetooth adapter is not initialized',10000);
    this.permitted();
    if (api === 'wx.getBluetoothAdapterState') return this.ok(api,{available:this.available(),discovering:this.discovering});
    if (!this.available()) throw this.fail('Bluetooth is unavailable',10001);
    switch (api) {
      case 'wx.startBluetoothDevicesDiscovery': {
        if (this.discovering || scanOwner === this && this.scanRegistered) throw this.fail('Bluetooth discovery is active or its previous stop requires retry');
        if (scanOwner !== null && scanOwner !== this) throw this.fail('the process Bluetooth scanner belongs to another container');
        const requested = options.services || []; if (requested.length > 32) throw this.fail('service filter limit',10013);
        this.scanServices = requested.map((uuid: string): string => this.uuid(uuid)); this.duplicates = options.allowDuplicatesKey === true;
        const filters: Array<ble.ScanFilter> = this.scanServices.map((uuid: string): ble.ScanFilter => { return {serviceUuid:uuid}; });
        if (options.interval !== undefined && (!Number.isFinite(options.interval) || options.interval < 0)) throw this.fail('invalid scan interval',10013);
        scanOwner = this; const lease = ++this.scanLease;
        this.scanListener = (values: Array<ble.ScanResult>): void => {
          if (lease !== this.scanLease) return;
          try { this.discovered(values); } catch (error) { console.error(`WEAPP_CONTAINER_BLE_SCAN ${String(error)}`); try { this.stopScan(); } catch (cleanup) { console.error(`WEAPP_CONTAINER_BLE_SCAN_CLEANUP ${String(cleanup)}`); } }
        };
        try { ble.on('BLEDeviceFind',this.scanListener); this.scanRegistered = true; ble.startBLEScan(filters,{dutyMode:ble.ScanDuty.SCAN_MODE_BALANCED,interval:Math.min(10000,options.interval || 0)}); this.discovering = true; }
        catch (error) { this.stopScan(); throw error as Error; }
        call.cancellation.retainUntilCancelled(); call.cancellation.onCancel((): void => { if (lease === this.scanLease) this.stopScan(); });
        this.emit('BluetoothAdapterStateChange',{available:true,discovering:true}); return this.ok(api);
      }
      case 'wx.stopBluetoothDevicesDiscovery': this.stopScan(); this.emit('BluetoothAdapterStateChange',{available:true,discovering:false}); return this.ok(api);
      case 'wx.getBluetoothDevices': return this.ok(api,{devices:Array.from(this.devices.values())});
      case 'wx.getConnectedBluetoothDevices': {
        const filters = (options.services || []).map((uuid: string): string => this.uuid(uuid));
        if (filters.length === 0) throw this.fail('services filter required',10013);
        const found: Array<BluetoothDevice> = [];
        for (const connection of this.connections.values()) if (connection.connected && !connection.retiring) {
          const result = await this.operation(connection,call,async (): Promise<BluetoothResult> => { connection.services = await connection.client.getServices(); this.connectionCurrent(connection,call); return {}; });
          if (result !== undefined && connection.services.some((service: ble.GattService): boolean => filters.includes(this.uuid(service.serviceUuid)))) found.push({deviceId:connection.deviceId,name:this.devices.get(connection.deviceId)?.name || ''});
        }
        return this.ok(api,{devices:found});
      }
      case 'wx.createBLEConnection': await this.connect(this.deviceId(options.deviceId),options,call); return this.ok(api);
      case 'wx.closeBLEConnection': { const connection = this.connection(options,call,false); await this.retireConnection(connection); return this.ok(api); }
      default: {
        const connection = this.connection(options,call);
        return this.operation(connection,call,async (): Promise<BluetoothResult> => {
          switch (api) {
            case 'wx.getBLEDeviceServices': connection.services = await connection.client.getServices(); this.connectionCurrent(connection,call); return this.ok(api,{services:connection.services.map((service: ble.GattService): ServiceResult => { return {uuid:this.uuid(service.serviceUuid),isPrimary:service.isPrimary}; })});
            case 'wx.getBLEDeviceCharacteristics': {
              if (connection.services.length === 0) connection.services = await connection.client.getServices(); this.connectionCurrent(connection,call);
              const serviceId = this.uuid(options.serviceId), service = connection.services.find((value: ble.GattService): boolean => this.uuid(value.serviceUuid) === serviceId);
              if (service === undefined) throw this.fail('service not found',10004);
              return this.ok(api,{characteristics:service.characteristics.map((value: ble.BLECharacteristic): CharacteristicResult => { return {uuid:this.uuid(value.characteristicUuid),properties:{read:value.properties?.read === true,write:value.properties?.write === true,notify:value.properties?.notify === true,indicate:value.properties?.indicate === true,writeNoResponse:value.properties?.writeNoResponse === true,writeDefault:value.properties?.write === true}}; })});
            }
            case 'wx.getBLEDeviceRSSI': { const RSSI = await connection.client.getRssiValue(); this.connectionCurrent(connection,call); return this.ok(api,{RSSI}); }
            case 'wx.getBLEMTU': return this.ok(api,{mtu:connection.mtu});
            case 'wx.setBLEMTU': {
              if (!Number.isInteger(options.mtu) || (options.mtu || 0) < 23 || (options.mtu || 0) > 517) throw this.fail('MTU must be 23..517',10013);
              await new Promise<void>((resolve,reject): void => {
                let settled = false;
                const timer = setTimeout((): void => connection.mtuFinish?.(this.fail('BLE MTU negotiation timed out',10008)),10000);
                connection.mtuFinish = (error?: HarmonyApiError): void => { if (settled) return; settled = true; clearTimeout(timer); connection.mtuFinish = null; if (error !== undefined) reject(error); else resolve(); };
                try { connection.client.setBLEMtuSize(options.mtu!); } catch (error) { const native = error as BusinessError; connection.mtuFinish(new HarmonyApiError(native.code === 201 ? 'permission_denied' : 'invalid_request',native.message,native.code)); }
              });
              this.connectionCurrent(connection,call); return this.ok(api);
            }
            default: {
              if (connection.services.length === 0) connection.services = await connection.client.getServices(); this.connectionCurrent(connection,call);
              const serviceId = this.uuid(options.serviceId), characteristicId = this.uuid(options.characteristicId);
              const service = connection.services.find((value: ble.GattService): boolean => this.uuid(value.serviceUuid) === serviceId);
              const characteristic = service?.characteristics.find((value: ble.BLECharacteristic): boolean => this.uuid(value.characteristicUuid) === characteristicId);
              if (characteristic === undefined) throw this.fail('characteristic not found',10005);
              if (api === 'wx.readBLECharacteristicValue') {
                if (characteristic.properties?.read !== true) throw this.fail('characteristic is not readable',10007);
                const value = await connection.client.readCharacteristicValue(characteristic); this.connectionCurrent(connection,call); this.characteristic(connection,value,true,call); return this.ok(api);
              }
              if (api === 'wx.writeBLECharacteristicValue') {
                const value = this.bytes(options.value), noResponse = options.writeType === 'writeNoResponse';
                if (options.writeType !== undefined && !['write','writeNoResponse'].includes(options.writeType)) throw this.fail('invalid writeType',10013);
                if (value.byteLength > connection.mtu - 3 || value.byteLength > 512) throw this.fail('characteristic write exceeds negotiated MTU',10013);
                if (noResponse ? characteristic.properties?.writeNoResponse !== true : characteristic.properties?.write !== true) throw this.fail('characteristic write mode is unsupported',10007);
                const outgoing: ble.BLECharacteristic = {serviceUuid:characteristic.serviceUuid,characteristicUuid:characteristic.characteristicUuid,characteristicValue:value,descriptors:characteristic.descriptors,properties:characteristic.properties};
                await connection.client.writeCharacteristicValue(outgoing,noResponse ? ble.GattWriteType.WRITE_NO_RESPONSE : ble.GattWriteType.WRITE); this.connectionCurrent(connection,call); return this.ok(api);
              }
              if (typeof options.state !== 'boolean') throw this.fail('notification state required',10013);
              if (options.state && characteristic.properties?.notify !== true && characteristic.properties?.indicate !== true) throw this.fail('characteristic cannot notify or indicate',10007);
              const key = `${serviceId}:${characteristicId}`;connection.notifications.delete(key);
              try{await connection.client.setCharacteristicChangeNotification(characteristic,options.state);this.connectionCurrent(connection,call);}
              catch(error){this.background(this.retireConnection(connection));throw error as Error;}
              if(options.state)connection.notifications.set(key,{active:true});
              return this.ok(api);
            }
          }
        });
      }
    }
  }
  private sameOwner(first: HarmonyApiCall, second: HarmonyApiCall): boolean {
    const a = first.context.application, b = second.context.application;
    return first.context.sessionId === second.context.sessionId &&
      a.hostAppId === b.hostAppId && a.tenantId === b.tenantId && a.publisherId === b.publisherId && a.appId === b.appId &&
      a.environment === b.environment && a.version === b.version && a.packRoot === b.packRoot &&
      first.context.account.principalId === second.context.account.principalId && first.context.account.epoch === second.context.account.epoch;
  }
  private connection(options: BluetoothOptions, call: HarmonyApiCall, connected: boolean = true): BluetoothConnection {
    const id = this.deviceId(options.deviceId), connection = this.connections.get(id);
    if (connection === undefined || connection.retiring || !this.sameOwner(connection.call,call) || connected && !connection.connected) throw this.fail('BLE device is disconnected or belongs to another owner',10006);
    return connection;
  }
  private connectionCurrent(connection: BluetoothConnection, call: HarmonyApiCall): void {
    this.current(call,connection.generation); this.permitted();
    if (this.connections.get(connection.deviceId) !== connection || connection.retiring || !connection.connected || !this.sameOwner(connection.call,call)) throw new HarmonyApiError('cancelled','BLE connection incarnation retired');
  }
  private operation(connection: BluetoothConnection, call: HarmonyApiCall, action: () => Promise<BluetoothResult>): Promise<BluetoothResult> {
    call.cancellation.onCancel((): Promise<void> => this.retireConnection(connection));
    const next = connection.queue.then(async (): Promise<BluetoothResult> => { this.connectionCurrent(connection,call); return action(); });
    connection.queue = next.then((): BluetoothResult => { return {}; },(): BluetoothResult => { return {}; }); return next;
  }
  private async connect(deviceId: string, options: BluetoothOptions, call: HarmonyApiCall): Promise<void> {
    if (this.connections.has(deviceId) || this.connections.size >= 16) throw this.fail('BLE connection is already owned or connection limit reached');
    const generation = this.generation, client = ble.createGattClientDevice(deviceId);
    const connection: BluetoothConnection = {deviceId,client,call,generation,connected:false,retiring:false,nativeClosed:false,mtu:23,services:[],notifications:new Map(),queue:Promise.resolve<BluetoothResult>({}),retirement:null,connectFinish:null,mtuFinish:null,stateListener:(): void => {},valueListener:(): void => {},mtuListener:(): void => {}};
    connection.stateListener = (state: ble.BLEConnectionChangeState): void => {
      if (this.connections.get(deviceId) !== connection || connection.retiring || connection.generation !== this.generation || call.cancellation.cancelled || this.closed || !this.foreground) return;
      try { this.permitted(); } catch { return; }
      if (state.deviceId.toUpperCase() !== deviceId) return;
      if (state.state === constant.ProfileConnectionState.STATE_CONNECTED) {
        connection.connected = true; connection.connectFinish?.(); this.emit('BLEConnectionStateChange',{deviceId,connected:true});
      } else if (state.state === constant.ProfileConnectionState.STATE_DISCONNECTED) {
        const wasConnected = connection.connected; connection.connected = false; connection.connectFinish?.(this.fail('BLE connection disconnected',10006));
        if (wasConnected) this.emit('BLEConnectionStateChange',{deviceId,connected:false}); this.background(this.retireConnection(connection));
      }
    };
    connection.valueListener = (value: ble.BLECharacteristic): void => this.characteristic(connection,value);
    connection.mtuListener = (mtu: number): void => {
      if (this.connections.get(deviceId) !== connection || connection.retiring || connection.generation !== this.generation || this.closed || !this.foreground || call.cancellation.cancelled) return;
      try { this.permitted(); } catch { return; }
      if (!Number.isInteger(mtu) || mtu < 23 || mtu > 517) { this.background(this.retireConnection(connection)); return; }
      connection.mtu = mtu; connection.mtuFinish?.(); if (connection.connected) this.emit('BLEMTUChange',{deviceId,mtu});
    };
    this.connections.set(deviceId,connection);
    try {
      client.on('BLEConnectionStateChange',connection.stateListener); client.on('BLECharacteristicChange',connection.valueListener); client.on('BLEMtuChange',connection.mtuListener);
      call.cancellation.retainUntilCancelled(); call.cancellation.onCancel((): Promise<void> => this.retireConnection(connection));
      await new Promise<void>((resolve,reject): void => {
        let settled = false;
        const duration = options.timeout === undefined ? 15000 : options.timeout;
        if (!Number.isFinite(duration) || duration < 1 || duration > 60000) { reject(this.fail('connection timeout must be 1..60000 ms',10013)); return; }
        const timer = setTimeout((): void => { connection.connectFinish?.(this.fail('BLE connection timed out',10003)); },duration);
        connection.connectFinish = (error?: HarmonyApiError): void => { if (settled) return; settled = true; clearTimeout(timer); connection.connectFinish = null; if (error !== undefined) reject(error); else resolve(); };
        try { this.current(call,generation); client.connect(); } catch (error) { const native = error as BusinessError; connection.connectFinish(error instanceof HarmonyApiError ? error : new HarmonyApiError(native.code === 201 ? 'permission_denied' : 'invalid_request',native.message,native.code)); }
      });
      this.connectionCurrent(connection,call);
    } catch (error) { await this.retireConnection(connection); throw error as Error; }
  }
  private binary(value: ArrayBuffer): BinaryEnvelope { return {__weappBinary:{type:'ArrayBuffer',bytes:Array.from(new Uint8Array(value))}}; }
  private bytes(value?: Object): ArrayBuffer {
    const binary = value as BinaryEnvelope;
    if (binary === undefined || binary === null || binary.__weappBinary === undefined || binary.__weappBinary.type !== 'ArrayBuffer' || !Array.isArray(binary.__weappBinary.bytes) || binary.__weappBinary.bytes.length > 512 || binary.__weappBinary.bytes.some((byte: number): boolean => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw this.fail('bounded ArrayBuffer required',10013);
    return new Uint8Array(binary.__weappBinary.bytes).buffer as ArrayBuffer;
  }
  private characteristic(connection: BluetoothConnection, value: ble.BLECharacteristic, read: boolean = false, call?: HarmonyApiCall): void {
    try {
      this.connectionCurrent(connection,connection.call);
      const serviceId = this.uuid(value.serviceUuid), characteristicId = this.uuid(value.characteristicUuid);
      const key=`${serviceId}:${characteristicId}`,lease=connection.notifications.get(key);
      if (!read && lease===undefined) return;
      if (value.characteristicValue.byteLength > 512) throw this.fail('BLE notification exceeds 512 bytes');
      this.emit('BLECharacteristicValueChange',{deviceId:connection.deviceId,serviceId,characteristicId,value:this.binary(value.characteristicValue)},connection,
        ():boolean=>read?call!==undefined&&!call.cancellation.cancelled:connection.notifications.get(key)===lease);
    } catch { if (!connection.retiring) this.background(this.retireConnection(connection)); }
  }
  private discovered(values: Array<ble.ScanResult>): void {
    if (!this.discovering || scanOwner !== this || this.closed || !this.foreground) return;
    try { this.permitted(); } catch { return; }
    if (values.length > 256) { this.stopScan(); return; }
    for (const value of values) {
      if (value.data.byteLength > 65536) { this.stopScan(); return; }
      const fields = this.advertisement(value.data), deviceId = this.deviceId(value.deviceId), advertised = (value.serviceUuids || []).map((uuid: string): string => this.uuid(uuid));
      for (const field of fields) {
        const width = [2,3].includes(field.type) ? 2 : [4,5].includes(field.type) ? 4 : [6,7].includes(field.type) ? 16 : 0;
        if (width > 0) for (let offset = 0; offset + width <= field.bytes.length; offset += width) { const uuid = this.advertisedUuid(field.bytes.slice(offset,offset+width)); if (!advertised.includes(uuid)) advertised.push(uuid); }
      }
      if (this.scanServices.length > 0 && !this.scanServices.some((uuid: string): boolean => advertised.includes(uuid))) continue;
      const previous = this.devices.has(deviceId);
      if (!previous && this.devices.size >= 256) { this.stopScan(); return; }
      const serviceData: Record<string,BinaryEnvelope> = {};
      if (value.serviceDataMap !== undefined) for (const entry of value.serviceDataMap.entries()) { const uuid = entry[0], bytes = entry[1]; if (bytes.byteLength > 512) { this.stopScan(); return; }; serviceData[this.uuid(uuid)] = this.binary(bytes.slice().buffer as ArrayBuffer); }
      for (const field of fields) { const width = field.type === 22 ? 2 : field.type === 32 ? 4 : field.type === 33 ? 16 : 0; if (width > 0 && field.bytes.length >= width) serviceData[this.advertisedUuid(field.bytes.slice(0,width))] = this.binary(field.bytes.slice(width).buffer as ArrayBuffer); }
      const device: BluetoothDevice = {deviceId,name:value.deviceName,localName:value.deviceName,RSSI:value.rssi,advertisData:this.binary(this.manufacturer(value.data)),advertisServiceUUIDs:advertised,serviceData};
      this.devices.set(deviceId,device);
      if (!previous || this.duplicates) this.emit('BluetoothDeviceFound',{devices:[device]});
    }
  }
  private manufacturer(buffer: ArrayBuffer): ArrayBuffer {
    for (const field of this.advertisement(buffer)) if (field.type === 255) return field.bytes.buffer as ArrayBuffer;
    return new ArrayBuffer(0);
  }
  private advertisement(buffer: ArrayBuffer): Array<AdvertisementField> {
    const data = new Uint8Array(buffer), fields: Array<AdvertisementField> = [];
    for (let index = 0; index < data.length;) { const length = data[index]; if (length === 0) break; if (index + length >= data.length) throw this.fail('malformed BLE advertisement'); fields.push({type:data[index+1],bytes:data.slice(index+2,index+length+1)}); index += length+1; }
    return fields;
  }
  private advertisedUuid(bytes: Uint8Array): string {
    let hex = ''; for (let index = bytes.length-1; index >= 0; index--) hex += bytes[index].toString(16).padStart(2,'0').toUpperCase();
    if (bytes.length === 16) hex = `${hex.substring(0,8)}-${hex.substring(8,12)}-${hex.substring(12,16)}-${hex.substring(16,20)}-${hex.substring(20)}`;
    return this.uuid(hex);
  }
  private emit(event: string, value: BluetoothResult, producer?: BluetoothConnection, isCurrent?: () => boolean): void {
    if (this.closed || !this.foreground) return;
    const generation=this.generation,adapterLease=this.adapterLease,scanLease=this.scanLease;
    for (const subscription of this.subscriptions.values()) if (subscription.event === event && !subscription.call.cancellation.cancelled) {
      subscription.sequence++;
      const deliver=():boolean=>!this.closed&&this.foreground&&this.generation===generation&&this.adapterLease===adapterLease&&this.subscriptions.get(subscription.id)===subscription&&!subscription.call.cancellation.cancelled&&
        (event!=='BluetoothDeviceFound'||this.discovering&&this.scanLease===scanLease)&&
        (producer===undefined||!producer.retiring&&producer.connected&&this.connections.get(producer.deviceId)===producer)&&(isCurrent===undefined||isCurrent());
      if (!this.services.emit(subscription.call.context,subscription.id,subscription.sequence,event,value,undefined,deliver)) { if (producer !== undefined) this.background(this.retireConnection(producer)); else this.stopScan(); return; }
    }
  }
  private stopScan(): void {
    this.discovering=false;
    if (scanOwner !== this) { this.discovering = false; return; }
    // Preserve the lease if native stop/unregistration fails, so another
    // container cannot adopt an uncertain producer during cleanup retry.
    ble.stopBLEScan(); if (this.scanRegistered && this.scanListener !== null) { ble.off('BLEDeviceFind',this.scanListener); this.scanRegistered = false; }
    this.discovering = false; scanOwner = null; this.scanLease++; this.scanListener = null;
  }
  private async retireConnection(connection: BluetoothConnection): Promise<void> {
    if (connection.retirement !== null) return connection.retirement;
    connection.retiring = true; connection.connected = false; this.retiring.add(connection);
    connection.connectFinish?.(new HarmonyApiError('cancelled','BLE connection retired'));
    connection.mtuFinish?.(new HarmonyApiError('cancelled','BLE MTU owner retired'));
    const task = (async (): Promise<void> => {
      if (!connection.nativeClosed) {
        // Closing this exact client is the platform resource release primitive;
        // it must succeed before the connection is removed from the barrier.
        try { connection.client.off('BLEConnectionStateChange',connection.stateListener); } catch {}
        try { connection.client.off('BLECharacteristicChange',connection.valueListener); } catch {}
        try { connection.client.off('BLEMtuChange',connection.mtuListener); } catch {}
        try { connection.client.disconnect(); } catch {}
        connection.client.close(); connection.nativeClosed = true;
      }
      await new Promise<void>((resolve,reject): void => {
        const timer = setTimeout((): void => reject(this.fail('native GATT operations have not drained; retry cleanup')),5000);
        connection.queue.then((): void => { clearTimeout(timer); resolve(); },(error: Error): void => { clearTimeout(timer); reject(error); });
      });
      connection.notifications.clear(); connection.services = [];
      if (this.connections.get(connection.deviceId) === connection) this.connections.delete(connection.deviceId);
      this.retiring.delete(connection);
    })();
    connection.retirement = task;
    try { await task; } finally { connection.retirement = null; }
  }
  private background(task: Promise<void>): void { const tracked = task.catch((error: Object): void => { console.error(`WEAPP_CONTAINER_BLE_CLEANUP ${String(error)}`); }).then((): void => { this.backgroundDrains.delete(tracked); }); this.backgroundDrains.add(tracked); }
  private async stopResources(): Promise<void> {
    let scanError: Object | null = null; try { this.stopScan(); } catch (error) { scanError = error as Object; }
    const failures: Array<Object> = [];
    const resources = new Set<BluetoothConnection>(Array.from(this.connections.values()).concat(Array.from(this.retiring)));
    for (const connection of resources) { try { await this.retireConnection(connection); } catch (error) { failures.push(error as Object); } }
    if (scanError !== null) failures.push(scanError);
    if (failures.length > 0) throw this.fail(`${failures.length} native BLE resources did not retire; retry cleanup`);
  }
  private async retireAdapter(): Promise<void> {
    this.generation++; this.adapterLease++; this.opened = false;
    await this.stopResources();
    if (this.stateRegistered && this.stateListener !== null) { access.off('stateChange',this.stateListener); this.stateRegistered = false; this.stateListener = null; }
    this.devices.clear();
  }
  async close(): Promise<void> { this.closed = true; this.foreground = false; await this.retireAdapter(); await Promise.all(Array.from(this.backgroundDrains)); this.subscriptions.clear(); }
}
