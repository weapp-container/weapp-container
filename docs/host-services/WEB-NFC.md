<a id="web-nfc-and-frozen-wx-nfc-contract"></a>
# Web NFC 与冻结 wx NFC 合同

**简体中文** · [English](WEB-NFC.en.md)


Web 宿主默认不注册当前 NFC 标签 API。浏览器提供 `NDEFReader`，只能证明存在
Web NFC 接口；它不能证明该接口满足基础库 3.17.3、typings 5.2.3 冻结的 wx
标签连接和原始记录语义。可信宿主仍可通过 `registerApiHandler` 显式安装满足
具体叶子合同的独立原生实现。

此前 discovery 回调直接返回 `serialNumber` 字符串和 Web
`{recordType, mediaType, data}` 对象，违反微信 `id: ArrayBuffer` 与原始
`{id, type, payload}` 记录合同。用浏览器读取到的字段拼出占位对象，不能修复这种
语义差异：

- Web `serialNumber` 是按原顺序编码的冒号分隔十六进制字符串；设备不提供序列号
  时为空。它可支持将来明确限定的 UID 子集，但不能证明任意标签都有可用 UID。
- Web `NDEFRecord.id` 为 `USVString`，不保留任意二进制 ID。解析文本记录时会移除
  status/language 字节；解析 URI 记录时会展开前缀；MIME type 会重新序列化；
  absolute-URL 记录的 `data` 来自 TYPE。浏览器字段不能普遍恢复原始字节。
- `NDEFReader` 只有 `scan`、`write`、`makeReadOnly`；它没有标签级 `connect`、
  `isConnected` 或对应 `close`。停止扫描的 AbortSignal 不能作为标签断开确认。
- 浏览器没有 raw ISO-DEP、MIFARE Classic/Ultralight、NFC-A/B/F/V 的
  transceive、历史字节、ATQA、SAK、硬件最大收发长度及技术超时接口。

这批修改不实例化 reader，不请求 NFC 权限，也不创建持续扫描或二进制句柄，
因此不会留下以前 discovery 实现的扫描、过期回调或被覆盖的 AbortController。
未注册的 66 个冻结标签叶子，以及其中有明确浏览器能力限制的 55 个叶子，完整
列在 [平台限制清单](./platform-constraints.json) 与 [API 矩阵](./api-matrix.json) 中；原始开发记录保存在 [私有档案](../archived-evidence.md)。其余叶子
保持未实现，不能仅因配套连接 API 缺失就一概标为浏览器永远不支持。

未来可以单独论证精确的 UID-only discovery 子集，或在冻结目录有相应合同后
增加 Web NDEF 宿主扩展。这里不宣称浏览器无法实现任何 NFC 功能。

官方依据为 [Web NFC specification](https://w3c-cg.github.io/web-nfc/)，特别是
`NDEFRecord`/`NDEFReader` 接口、NFC reading algorithm，以及 Parsing NDEF
records 下的 text、URL、MIME、absolute-URL 解析步骤。私有历史档案保留原始官方
HTML 的 gzip 快照、SHA-256、摘录及 Node 合同测试输出。这些是开发阶段的规范
核对和宿主测试，没有浏览器设备、物理标签、授权弹窗或发布验收结果。
