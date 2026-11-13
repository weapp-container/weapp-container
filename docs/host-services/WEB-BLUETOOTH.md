<a id="web-bluetooth-gatt-subset-of-host-authorization"></a>
# Web Bluetooth：宿主授权的 GATT 子集

**简体中文** · [English](WEB-BLUETOOTH.en.md)


`BrowserHostServices` 默认不安装蓝牙 API。浏览器的蓝牙权限授予的是 origin；它既不表示当前小程序、账号已经授权，也不代表宿主拥有连接。容器不调用 `navigator.bluetooth.getDevices()`，不接管已经连接的设备，不修改浏览器对象的共享属性。

接入方必须在可信宿主 UI 中完成用户授权与设备选择、初始化当前设备会话，再将 `BluetoothDevice` 和当前小程序授权记录传入：

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

传入授权最多 32 个设备、每设备最多 32 个服务；用途和权限版本必须明确。`exclusiveSession: true` 表示宿主明确交接此 realm 中该 BluetoothDevice/GATT server 的独占使用权，交接期间宿主不得继续调用它；SDK 租约能协调容器实例，无法拦截任意宿主 JS。已连接设备仍拒绝接管。宿主可信代码负责确认该用途已获同意，不能将小程序提交的对象直接用作授权记录。变更用户、账号 epoch、应用版本或已接受包需要重新创建授权。`signal` 可立即撤销当前设备授权；未提供 signal 时，宿主通过关闭 owner 撤销。

安装的接口为 `closeBluetoothAdapter`、`createBLEConnection`、`closeBLEConnection`、`getBLEDeviceServices`、`getBLEDeviceCharacteristics`、`readBLECharacteristicValue`、`writeBLECharacteristicValue`、`notifyBLECharacteristicValueChange`，以及连接、特征值变化的 on/off。服务查询只返回明确授权的主服务。UUID 可使用 16/32/128 位十六进制字符串，内部统一成小写 128 位格式；重复服务或特征 UUID 无法通过 wx 参数唯一寻址时拒绝调用。

不安装 `openBluetoothAdapter`、`getBluetoothAdapterState`、设备发现、`getBluetoothDevices` 或适配器状态监听。浏览器 `getAvailability()` 即使系统软件关闭 radio 仍可能返回 true，也不能报告 wx 所需的真实上电状态；`getDevices()` 返回 origin 历史授权设备，并非扫描结果，缺少真实 RSSI、广播等字段。宿主可以单独提供具备准确语义的原生适配器。页面须处于安全上下文，并满足浏览器 Bluetooth Permissions Policy。

`closeBluetoothAdapter` 释放本 owner 的会话，不关闭共享硬件。后台隐藏、关闭适配器后当前 owner 不再接受新的 GATT 调用；宿主在重新初始化后创建新 owner。所有连接由同一 `navigator.bluetooth` 的共享租约管理；另一个容器或宿主已经使用的连接不能被接管，失败的释放仍保留租约。不同浏览器 realm 的物理 ATT 连接由浏览器规范管理，容器只断开自己持有的 GATT server。

取消 connect/read/write/notify 会立即使当前连接代际失效并调用该连接的 `disconnect()`；关闭会等待浏览器实际完成/中止操作。通知的 start/stop 串行执行；disable 在调用时就替换每个特征的 intent，覆盖尚未完成的发现和 start，迟到 start 成功后停止确切 source。规范断连会使 GATT 属性对象和通知上下文失效，因此重连会重新发现服务和特征。任何失败的 disconnect、stop 或 listener removal 都保留确切对象，显式 close/重试成功后才释放租约。关闭与新账号开始之间不能跳过这道屏障。

`notifyBLECharacteristicValueChange.type` 只有在特征恰好支持所请求的 notification 或 indication 时才可接受。浏览器 `startNotifications()` 由 UA 选择协议，没有强制选型参数；两者均支持时显式指定类型会返回不支持。对已有明确特征的重配置会先检查类型，再替换 intent；无效参数不会留下失去事件归属的原生通知，也不会撤销该特征尚在等待的有效 start。写入模式严格映射到 WithResponse/WithoutResponse；特征值与单次写入最多 512 字节。特征属性同时提供 `writeDefault` 和 `writeNoResponse`。原生 DOMException 名称和数字 code 分别保留为公开 `nativeName` 和 `errCode`，容器错误分类保持独立。

原生事件只进入 owner 队列；队列项绑定确切连接和通知代际。取消、断连、权限撤销、后台隐藏及 off/on 复用订阅 ID 后，旧事件不能进入 JS。队列背压会撤销并释放该连接，不无限累积二进制数据。通知监听没有共享 expando，也不依赖垃圾回收释放。

规范证据与有限生产适配器测试见 [2026-11-02 Web Bluetooth 记录](../archived-evidence.md)。该记录覆盖代码、协议和受控原生终结顺序；真实浏览器 chooser、物理 BLE radio、系统权限、硬件断连与后台行为仍待独立验收，不将 source 测试标为设备验收。
