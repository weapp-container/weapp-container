<a id="api24-nfc-标签适配器"></a>
# API24 NFC Tag Adapter

[简体中文](NFC.md) · **English**


`HarmonyNfcApis.ets` does not register the API by default, nor does it request tags or display the authorization interface. Host is creating
session, explicitly configure the purpose, permission version, and technical scope before executing `app.init`, and ensure that the host
The process's NFC foreground dispatch channel is exclusive to this adapter:

```ts
import { configureHarmonyNfc } from './native/HarmonyNfcApis';

configureHarmonyNfc({
  purpose: '读取和写入用户选择的设备配置标签',
  permissionVersion: '1',
  exclusiveForegroundDispatch: true,
  technologies: ['Ndef', 'IsoDep', 'NfcA'],
});
```

Example Index has called `installHarmonyNfcApis(context, services, uiContext)`; configuration
Do not install if
is empty or the system is missing NFC.Tag/Core Syscap. manifest declares `NFC_TAG`, each time
When starting discovery, the actual OS grant, NFC open status and foreground owner are still verified and displayed including the current
Independent authorization interface for mini-programs, publishers and purposes. Canceling authorization closes that exact dialog and waits for it to disappear.

`technologies` can choose `Ndef`, `IsoDep`, `MifareClassic`, `MifareUltralight`,
`NfcA`, `NfcB`, `NfcF`, `NfcV`. When all eight are selected, the corresponding frozen base library 3.17.3 / typings
66 tag leaves of 5.2.3; when selecting a smaller range, only the corresponding factory, method and tech are registered
Constant. The specific label is still determined by the real `TagInfo.technology` and native factory, and cannot be determined by
The presence of NFC on a device assumes that technology such as MIFARE Classic is available.

The actual mapping is as follows:

| wx contract | API24 native interface |
| --- | --- |
| discovery start/stop | `registerForegroundDispatch` / `unregisterForegroundDispatch` |
| discovered id / techs | original `TagInfo.uid` / `TagInfo.technology` |
| Eight technologies factory | `tag.getNdef/getIsoDep/getMifareClassic/getMifareUltralight/getNfcA/B/F/V` |
| connect / close / isConnected | same actual `TagSession.connect/resetConnection/isConnected` |
| setTimeout / transceive / getMaxTransceiveLength | `TagSession.setTimeout/transmit/getMaxTransmitSize` |
| IsoDep historical bytes | `IsoDepTag.getHistoricalBytes` |
| NfcA ATQA / SAK | `NfcATag.getAtqa/getSak` |
| NDEF read/write | Actual discovery cache for `NdefTag.readNdef/writeNdef`, `getNdefMessage` |
| NDEF record type / id / payload | raw `NdefRecord.rtdType/id/payload` byte array |

Only use the officially required NFC-A/B/F/V for polling parameters, and report the truly supported technology when a callback is found.
Use foreground dispatch to retain the host’s wallet and card simulation. `tag.on('readerMode')`
disables card emulation, so it is not used here nor does it call global enable/disable NFC or HCE
Method. Although the API accepts UIAbility's `ElementName`, it exposes natively implemented N-API callbacks
The registry is global to the process. The process lease can only coordinate the containers of this SDK;
`exclusiveForegroundDispatch` requires the host to first allow other UIAbility, native modules and third-party
The SDK hands over the foreground dispatch of the process. This configuration is a deployment constraint that the host must implement.
The container cannot detect whether other modules have surrendered the channel.

Run at most one asynchronous native I/O per label epoch. Cancel, stop, background or owner close
will immediately disable the old event, then unregister its own dispatch, reset the exact TagSession, and wait
True transmit/read/write Promise terminal. `resetConnection` is the native logical connection reset,
Does not prove that the physical RF is disconnected, nor does it replace the asynchronous I/O terminal. failed unregister, off, reset
Retain the same resource and process lease; the owner has been revoked and try again through `retryResourceCleanup()`,
Will not rebuild the reader or release the NFC state of other hosts. The new label callback uses
The old child is invalid. The callback backlog only retains the latest tag, and stops its own ingress when the event queue rejects it.
It can still be canceled when the native discovery is successful and the JS completion has not yet been sent; the shared owner is in each completion
Read the cancellation queue before entering JS and retain the exact cancellation object until after the last read. Transfer failed retention
The original completion, its byte quota and the new call that has been taken out, retrying will not lose the subsequent finalization results.

Adapter limit 16 adapters, 32 children, 256 subscriptions per owner; UID max
256 bytes, NDEF maximum 64 records, each type/id maximum 255 bytes, the entire message maximum
1 MiB. Raw input is also limited by actual `getMaxTransmitSize()`, with output at most 1 MiB.
Timeout accepts an integer from 100...30000 ms and gives it to the real `setTimeout`.

The official basis is [nfcTag](https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-connectivity-kit/js-apis-nfcTag.md),
[TagSession](https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-connectivity-kit/js-apis-tagSession.md)、
[nfctech](https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-connectivity-kit/js-apis-nfctech.md)
and [nfcController](https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-connectivity-kit/js-apis-nfcController.md).
This implementation is based on the native API24 / 6.1.1.125 SDK statement; document and source code excerpts and input
Hash, test, and standalone HAP build records are kept in development evidence. No testing of physical tags, actual OS
Authorization or wallet coexistence does not constitute device, cross-platform parity or release acceptance.
