<a id="harmony-wi-fi-access"></a>
# Harmony Wi-Fi 接入

**简体中文** · [English](WIFI.en.md)


API24 使用真实 `@ohos.wifiManager` STA 接口。默认不安装 Wi-Fi API；宿主在创建
小程序 owner 前显式调用：

```ts
import { configureHarmonyWifi } from './native/HarmonyWifiApis';
configureHarmonyWifi({
  purpose: '为用户选择的家中设备配置网络',
  permissionVersion: '1',
  fullInfo: true,
  scan: true,
  connect: true,
});
```

`Index` 在每次内部 owner 重建时重新执行 `installHarmonyWifiApis`。只有实际设备
声明 `SystemCapability.Communication.WiFi.STA` 且配置非空时才注册；传入 `null`
停止为后续 owner 安装。配置变化需由账号执行边界重建 owner，不修改正在执行的实例。

基础配置提供 `startWifi`、`stopWifi` 和 `on/offWifiConnectedWithPartialInfo`；
`fullInfo` 增加 `getConnectedWifi` 与 `on/offWifiConnected`；`scan` 增加
`getWifiList` 与 `on/offGetWifiList`，必须同时启用 `fullInfo`；`connect` 增加
`connectWifi`。所有配置开启时共 11 个清单接口。启动只初始化本 owner 的服务和监听，
不会打开系统 Wi-Fi 开关；停止只释放本 owner 的资源，不关闭系统 Wi-Fi。

宿主 manifest 显式声明 `GET_WIFI_INFO`、`SET_WIFI_INFO`、`GET_WIFI_PEERS_MAC`。
系统实际许可仍须验证。完整读取或扫描会单独校验 MAC 权限，必要时等待系统权限
请求的实际 Promise 终态。API24 明确规定未获 `GET_WIFI_PEERS_MAC` 时可能返回随机
BSSID；适配器不会把该别名伪装成真实接入点。`getConnectedWifi` 即使使用
`partialInfo:true` 也必须取得真实 SSID 与 BSSID；缺少权限时返回原生 201 权限错误。
只有 `WifiConnectedWithPartialInfo` 专用事件允许返回仅 SSID 的对象。

完整 WifiInfo 的安全性来自与 SSID/BSSID 对应的真实扫描记录，频率与信号来自
系统快照，原生信号等级 0..4 映射为 0/25/50/75/100。无法证明安全模式时明确失败，
不会默认 `secure:true`。扫描结果带随机地址类型时拒绝完整结果。扫描最多返回
256 个网络，持续订阅最多 128 个。

连接只创建当前 owner 的候选配置，支持开放网络及 8..63 字节 WPA-PSK 密码；
手动设置跳转、WEP/EAP 等模式未安装。相同 SSID 的宿主已有候选配置明确拒绝覆盖。
只使用本次 `addCandidateConfig` 返回的网络 ID，等待
`connectToCandidateConfigWithUserAction` 的系统用户响应，以及真实连接快照与目标
SSID/可选 BSSID 匹配后才完成。错误不自动重试连接或替换渠道；Wi-Fi 密码不会进入
其他请求、日志或宿主身份接口。

系统扫描没有取消句柄。取消只立即阻断该调用的事件，保留本次 listener 和进程租约，
直到原生成功/失败或 Wi-Fi 关闭终态；超时不会被当作扫描已停止。系统连接确认 UI
同样保留其实际 Promise，取消或换号等待其真实终态后删除精确候选配置。不会调用
全局 `disconnect`、`disableWifi`、`removeAllCandidateConfig` 等影响宿主或其他小程序
的操作。系统自身可能继续管理已经建立的物理网络连接；适配器撤销的是本 owner
候选配置、授权输入与监听，不对共享系统网络作虚假的独占断开承诺。

所有原生回调只通过 `HarmonyHostServices.emit` 入队，进入 JS 前再次验证账号、
incarnation、订阅及 Wi-Fi 代次。切后台、权限撤回、退出或换号阻止旧输入；队列
背压停止当前生产者。原生注销或候选删除失败保留精确对象，阻止执行边界报告完成，
由 `retryResourceCleanup` 重试；已成功的动作不会重复。

验证分界：`scripts/harmony-wifi-lifecycle.test.mjs` 执行生产 ArkTS 适配器和生产
HostServices，使用有限、可控制的 SDK 回调验证生命周期。官方 API24 HAP 编译验证
类型、真实模块与集成构建。真实 Wi-Fi 芯片、系统授权/确认 UI、AP 认证、扫描、后台
恢复和物理连接均为待验收，不以这些有限回调测试替代。
