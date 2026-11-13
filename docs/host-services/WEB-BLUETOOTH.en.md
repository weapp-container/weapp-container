<a id="web-bluetooth宿主授权的-gatt-子集"></a>
# Web Bluetooth: GATT Subset of Host Authorization

[简体中文](WEB-BLUETOOTH.md) · **English**


`BrowserHostServices` defaults to not installing Bluetooth API. Browser Bluetooth permissions are granted to an origin; they do not indicate that the current mini-program or account has been authorized, nor do they indicate that the host possesses connectivity. The container does not call `navigator.bluetooth.getDevices()`, does not take over already-connected devices, and does not modify the browser object's shared properties.

The integrator must obtain user consent, select the device, and initialize its current session in trusted host UI, then pass in the `BluetoothDevice` and the current mini-program authorization record:

```js
// 在宿主按钮的真实用户手势中运行；不要把 chooser 放进 guest 调用队列。
const device = await navigator.bluetooth.requestDevice({
  filters: [{ services: ['heart_rate'] }],
  optionalServices: ['battery_service'],
})
// 宿主根据自己的账号、用途和权限版本取得应用级授权。
const permission = new AbortController()
const bluetooth = {
  initialized: true, // 宿主已完成设备会话初始化；不是浏览器 radio 状态声明。
  grants: [{
    application, // 当前可信安装记录：hostAppId/tenantId/publisherId/appId/
                 // environment/version/packRoot，全部与 configure 一致。
    account,     // 当前 principalId 和 epoch，全部与 configure 一致。
    device,
    exclusiveSession: true, // 宿主交接此 realm 的 GATT session，停止自行使用。
    purpose: '读取本次运动的心率',
    permissionVersion: 'heart-rate-v1',
    services: ['180d'], // 小程序可访问的服务；不继承 origin 的其他授权。
    signal: permission.signal,
  }],
}
const services = new BrowserHostServices({ runtime, catalog, bluetooth })
await services.configure({ application, account })
// 通过宿主业务入口仅向该应用提供获准 device.id；它不是 MAC 地址。
// 撤销授权：permission.abort()；账号切换时仍须 await services.close()。
```

Up to 32 devices can be authorized, with up to 32 services per device; the purpose and permission version must be explicitly specified. `exclusiveSession: true` indicates that the host explicitly transfers exclusive usage rights for this BluetoothDevice/GATT server within the realm, and during the transfer period, the host shall not make further calls to it; the SDK lease can coordinate container instances but cannot intercept any host JS. Taking over an already connected device is still rejected. Trusted host code is responsible for verifying that the purpose has been explicitly authorized and cannot directly use the mini-program submitted object as the authorization record. Changes to the user, account epoch, app version, or accepted package require a new authorization. `signal` can immediately revoke the current device's authorization; without signal, the host revokes the authorization by closing the owner.

The installed interfaces are `closeBluetoothAdapter`, `createBLEConnection`, `closeBLEConnection`, `getBLEDeviceServices`, `getBLEDeviceCharacteristics`, `readBLECharacteristicValue`, `writeBLECharacteristicValue`, `notifyBLECharacteristicValueChange`, and the on/off callbacks for connection and characteristic value changes. Service queries return only the primary services explicitly authorized. UUIDs can be provided as 16-bit, 32-bit, or 128-bit hexadecimal strings, internally standardized to lowercase 128-bit format; calls are rejected when duplicate service or characteristic UUIDs cannot be uniquely addressed via wx parameters.

No installation of `openBluetoothAdapter`, `getBluetoothAdapterState`, device discovery, `getBluetoothDevices`, or adapter state listening. The browser's `getAvailability()` may still return true even when the system software disables the radio, and cannot report the actual powered-on state required by wx; `getDevices()` returns historically authorized devices by origin, not scan results, and lacks real RSSI, broadcast, and other fields. The host can independently provide a native adapter with accurate semantics. The page must be in a secure context and comply with the browser's Bluetooth Permissions Policy.

`closeBluetoothAdapter` releases the session of the current owner without closing the shared hardware. In the background, when the adapter is hidden and disabled, the current owner no longer accepts new GATT calls; a new owner is created by the host after reinitialization. All connections are managed by a shared lease of the same `navigator.bluetooth`; connections used by another container or host cannot be taken over, and failed releases still retain the lease. Physical ATT connections across different browser realms are managed by the browser specification, and containers only terminate connections they hold to GATT server.

Cancel connect/read/write/notify will immediately invalidate the current connection generation and invoke the `disconnect()` on that connection; closing will wait until the browser actually completes or aborts the operation. Notification start/stop operations are executed sequentially; disable replaces each feature's intent at the time of invocation, overriding pending discovery and start, and stops the exact source after a delayed start succeeds. Specified disconnection invalidates GATT attribute objects and notification contexts, so reconnection will re-discover services and features. Any failed disconnect, stop, or listener removal retains the exact object and only releases the lease after explicit close or retry success. Closing cannot be skipped between a new account and the start.

`notifyBLECharacteristicValueChange.type` is only accepted if the characteristic explicitly supports the requested notification or indication. The browser `startNotifications()` is chosen by UA, with no mandated protocol parameter; if both are supported, explicitly specifying the type will return "not supported". When reconfiguring an existing characteristic, type is first checked before replacing intent; invalid parameters will not leave native notifications without event ownership, nor will they cancel a valid start that is still pending. Write mode strictly maps to WithResponse/WithoutResponse; the characteristic value and a single write operation are limited to a maximum of 512 bytes. The characteristic property simultaneously provides `writeDefault` and `writeNoResponse`. The native DOMException name and numeric code are preserved as public `nativeName` and `errCode`, respectively, and container error categorization remains independent.

Native events only enter the owner queue; queue items are bound to specific connections and notification generations. After cancellation, disconnection, permission revocation, background hiding, or off/on reuse of subscription IDs, old events cannot enter JS. Queue backpressure will terminate and release the connection, without indefinitely accumulating binary data. Notification listeners have no shared expando and do not rely on garbage collection for release.

Specification evidence and limited production adapter test see [2026-11-02 Web Bluetooth Record](../archived-evidence.en.md). This record covers code, protocol, and controlled native termination sequence; real browser chooser, physical BLE radio, system permissions, hardware disconnection, and background behavior remain to be independently verified and are not marked as device acceptance.
