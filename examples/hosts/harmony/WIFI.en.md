<a id="harmony-wi-fi-接入"></a>
# Harmony Wi-Fi Access

[简体中文](WIFI.md) · **English**


API24 uses the real `@ohos.wifiManager` STA interface. The Wi-Fi API is not installed by default; the host explicitly calls it before creating a mini-program owner:

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

`Index` Re-executes `installHarmonyWifiApis` at each internal owner reconstruction. Registers only when the actual device declares `SystemCapability.Communication.WiFi.STA` and the configuration is non-empty; passing `null` stops future owner installations. Configuration changes require account boundary reconstruction of the owner, without modifying the currently executing instance.

Base configuration provides `startWifi`, `stopWifi`, and `on/offWifiConnectedWithPartialInfo`;
`fullInfo` adds `getConnectedWifi` and `on/offWifiConnected`; `scan` adds
`getWifiList` and `on/offGetWifiList`, must enable `fullInfo` simultaneously; `connect` adds
`connectWifi`. When all configurations are enabled, there are a total of 11 list interface methods. Startup only initializes the services and listeners for the current owner, without opening the system Wi-Fi switch; stop only releases resources of the current owner, without closing the system Wi-Fi.

Host manifest explicitly declares `GET_WIFI_INFO`, `SET_WIFI_INFO`, `GET_WIFI_PEERS_MAC`.
System-level permission validation is still required. Full reading or scanning will separately verify MAC permission, and will await the actual Promise resolution of system permission requests. API 24 explicitly specifies that random BSSID may be returned when `GET_WIFI_PEERS_MAC` is not granted; adapters will not spoof this alias as a real access point. `getConnectedWifi` must still return the actual SSID and BSSID even when `partialInfo:true` is used; a native 201 permission error is returned when permissions are missing. Only the `WifiConnectedWithPartialInfo` dedicated event is allowed to return an object containing only the SSID.

The complete WifiInfo security comes from real scan records corresponding to SSID/BSSID, frequency and signal strength from
system snapshots, native signal levels 0..4 mapped to 0/25/50/75/100. It cannot prove a secure mode explicitly fails,
does not default to `secure:true`. Complete results are rejected when random address types are present in scan results. Scan results return at most 256 networks, with continuous subscription supporting up to 128.

Connection creates only candidate configurations for the current owner, supporting open networks and 8..63 byte WPA-PSK passwords;
Manual setup for roaming, WEP/EAP, and other modes is not installed. Candidate configurations for existing hosts with the same SSID explicitly reject coverage.
Only uses the network ID returned by the current `addCandidateConfig`, waits for system user response from `connectToCandidateConfigWithUserAction`, and completes only after a real connection snapshot matches the target SSID/optional BSSID. Errors do not automatically retry connection or switch channels; Wi-Fi passwords are not passed to other requests, logs, or host identity interfaces.

System scan has no canceled handles. Cancellation only immediately blocks the event of the current call, preserving the listener and process lease until native success/failure or Wi-Fi closure final state; timeout is not considered as scan stopped. System connection confirmation UI retains its actual Promise, and removes the exact candidate configuration only after cancellation or number change waits for its true final state. Global operations such as `disconnect`, `disableWifi`, `removeAllCandidateConfig`, etc., which affect the host or other mini-programs, are not invoked. The system itself may continue managing established physical network connections; the adapter revokes only the owner's candidate configurations, authorization input, and listening, and does not make false promises of exclusive disconnection from shared system networks.

All native callbacks are enqueued via `HarmonyHostServices.emit` and undergo revalidation of account, incarnation, subscription, and Wi-Fi generation before reaching JS. Backgrounding, permission revocation, exit, or number change blocks previous input; queue backpressure stops current producer. Native unregistration or candidate deletion failures retain the exact object to prevent boundary report completion, retried by `retryResourceCleanup`; successful actions are not repeated.

Verification Boundary: `scripts/harmony-wifi-lifecycle.test.mjs` executes production ArkTS adapter and production HostServices, using limited, controllable SDK callbacks to verify lifecycle. Official API24 HAP compilation validation of types, real modules, and integrated builds. Real Wi-Fi chips, system authorization/confirmation UI, AP authentication, scanning, background recovery, and physical connection are pending acceptance and are not considered equivalent to these limited callback tests.
