<a id="api24-nfc-tag-adapter"></a>
# API24 NFC 标签适配器

**简体中文** · [English](NFC.en.md)


`HarmonyNfcApis.ets` 默认不注册 API，也不请求标签或显示授权界面。宿主在创建
session、执行 `app.init` 前显式配置用途、权限版本、技术范围，并保证宿主
进程的 NFC foreground dispatch 通道由此适配器独占：

```ts
import { configureHarmonyNfc } from './native/HarmonyNfcApis';

configureHarmonyNfc({
  purpose: '读取和写入用户选择的设备配置标签',
  permissionVersion: '1',
  exclusiveForegroundDispatch: true,
  technologies: ['Ndef', 'IsoDep', 'NfcA'],
});
```

示例 Index 已调用 `installHarmonyNfcApis(context, services, uiContext)`；配置
为空或系统缺少 NFC.Tag/Core Syscap 时不安装。manifest 声明 `NFC_TAG`，每次
开始发现时仍校验实际 OS grant、NFC 开启状态和前景 owner，并显示包含当前
小程序、发布者和用途的独立授权界面。取消授权会关闭该确切对话框并等待消失。

`technologies` 可以选择 `Ndef`、`IsoDep`、`MifareClassic`、`MifareUltralight`、
`NfcA`、`NfcB`、`NfcF`、`NfcV`。选择全部八种时对应冻结基础库 3.17.3 / typings
5.2.3 的 66 个标签叶子；选择较小范围时只注册相应 factory、方法和 tech
常量。具体标签仍由真实 `TagInfo.technology` 和 native factory 决定，不能因为
设备存在 NFC 就假定 MIFARE Classic 等技术可用。

实际映射如下：

| wx 合同 | API24 原生接口 |
| --- | --- |
| discovery start/stop | `registerForegroundDispatch` / `unregisterForegroundDispatch` |
| discovered id / techs | 原始 `TagInfo.uid` / `TagInfo.technology` |
| 八种技术 factory | `tag.getNdef/getIsoDep/getMifareClassic/getMifareUltralight/getNfcA/B/F/V` |
| connect / close / isConnected | 同一实际 `TagSession.connect/resetConnection/isConnected` |
| setTimeout / transceive / getMaxTransceiveLength | `TagSession.setTimeout/transmit/getMaxTransmitSize` |
| IsoDep 历史字节 | `IsoDepTag.getHistoricalBytes` |
| NfcA ATQA / SAK | `NfcATag.getAtqa/getSak` |
| NDEF read / write | `NdefTag.readNdef/writeNdef`，`getNdefMessage` 的实际发现缓存 |
| NDEF record type / id / payload | 原始 `NdefRecord.rtdType/id/payload` 字节数组 |

轮询参数只使用官方要求的 NFC-A/B/F/V，发现回调再报告真实支持的技术。
使用 foreground dispatch 可保留宿主的钱包与卡模拟。`tag.on('readerMode')`
会禁用卡模拟，因此这里不使用它，也不调用全局 enable/disable NFC 或 HCE
方法。虽然 API 接收 UIAbility 的 `ElementName`，公开原生实现的 N-API 回调
注册表是进程全局的。进程 lease 只能协调本 SDK 的容器；
`exclusiveForegroundDispatch` 要求宿主先让其它 UIAbility、原生模块及第三方
SDK 交出该进程的 foreground dispatch。此配置是宿主必须落实的部署约束，
容器无法检测其它模块是否已经交出通道。

每个标签 epoch 最多运行一个异步 native I/O。取消、stop、后台或 owner 关闭
会立即禁用旧事件，然后注销自己的 dispatch、重置确切 TagSession，并等待
真实 transmit/read/write Promise 终端。`resetConnection` 是原生逻辑连接重置，
不证明物理 RF 已断开，也不替代异步 I/O 终端。失败的 unregister、off、reset
保留同一资源及进程 lease；已撤销 owner 通过 `retryResourceCleanup()` 重试，
不会重建 reader 或释放其它宿主的 NFC 状态。新的标签回调即使 UID 相同，也使
旧 child 失效。回调积压只保留最新标签，事件队列拒收时停止自己的 ingress。
原生发现已成功、JS completion 尚未发出时仍可取消；共享 owner 在每条 completion
进入 JS 前读取取消队列，保留确切的取消对象到最后一次读取之后。传输失败保留
原 completion、其字节额度和已取出的新调用，重试不会丢失后续终结结果。

适配器限制每个 owner 16 个 adapter、32 个 child、256 个订阅；UID 最多
256 字节，NDEF 最多 64 条记录、每条 type/id 最多 255 字节、整条消息最多
1 MiB。raw 输入还受实际 `getMaxTransmitSize()` 限制，输出最多 1 MiB。
超时时间接受 100...30000 ms 整数并交给真实 `setTimeout`。

官方依据为 [nfcTag](https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-connectivity-kit/js-apis-nfcTag.md)、
[TagSession](https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-connectivity-kit/js-apis-tagSession.md)、
[nfctech](https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-connectivity-kit/js-apis-nfctech.md)
和 [nfcController](https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-connectivity-kit/js-apis-nfcController.md)。
本次实现以本机真实 API24 / 6.1.1.125 SDK 声明为准；文档及源码摘录、输入
hash、测试和独立 HAP 构建记录保存在开发证据中。没有测试物理标签、实际 OS
授权或钱包共存，不构成设备、跨平台 parity 或发布验收。
