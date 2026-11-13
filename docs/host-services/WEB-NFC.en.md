<a id="web-nfc-与冻结-wx-nfc-合同"></a>
# Web NFC and frozen wx NFC contract

[简体中文](WEB-NFC.md) · **English**


The web host does not register the current NFC tag API by default. The browser provides `NDEFReader`, which can only prove the existence
Web NFC interface; it does not prove that the interface meets base library 3.17.3, typings 5.2.3 frozen wx
Tag concatenation and raw record semantics. Trusted hosts can still be satisfied by explicit installation via `registerApiHandler`
Independent native implementation of specific leaf contracts.

Previously, the discovery callback directly returned the `serialNumber` string and Web
`{recordType, mediaType, data}` object, violating WeChat `id: ArrayBuffer` and original
`{id, type, payload}` records the contract. Using fields read by the browser to spell out placeholder objects cannot be repaired.
Semantic differences:

- Web `serialNumber` is a colon-separated hexadecimal string encoded in original order; the device does not provide a serial number
It is empty when
. It can support a well-defined subset of UIDs in the future, but does not prove that any tag has a usable UID.
- Web `NDEFRecord.id` is `USVString`, no arbitrary binary ID is preserved. Removed when parsing text records
status/language bytes; prefix will be expanded when parsing URI records; MIME type will be reserialized;
Absolute-URL records `data` from TYPE. Browser fields cannot universally restore raw bytes.
- `NDEFReader` only has `scan`, `write`, `makeReadOnly`; it has no tag level `connect`,
`isConnected` or corresponding `close`. AbortSignal that stops scanning cannot be acknowledged as a tag break.
- The browser does not support raw ISO-DEP, MIFARE Classic/Ultralight, NFC-A/B/F/V
transceive, historical bytes, ATQA, SAK, hardware maximum sending and receiving length and technical timeout interface.

This batch of modifications does not instantiate the reader, request NFC permissions, or create persistent scan or binary handles.
Therefore no scans, expiration callbacks or overwritten AbortController from previous discovery implementations are left behind.
66 unregistered frozen tag leaves, and 55 leaves with clear browser capability limitations, complete
is listed in the [Platform Restrictions List](./platform-constraints.json) and the [API Matrix](./api-matrix.json); original development records are kept in the [Private Archive](../archived-evidence.en.md). remaining leaves
Remain unimplemented and cannot be marked as never supported by browsers just because the supporting connection API is missing.

In the future, precise UID-only discovery subsets can be demonstrated independently, or after the frozen directory has a corresponding contract
Add Web NDEF host extension. There is no claim here that the browser cannot implement any NFC functionality.

The official basis is [Web NFC specification](https://w3c-cg.github.io/web-nfc/), specifically
`NDEFRecord`/`NDEFReader` interface, NFC reading algorithm, and Parsing NDEF
Text, URL, MIME, absolute-URL parsing steps under records. Private historical archive retains original official
gzip snapshot of HTML, SHA-256, excerpt and Node contract test output. These are development phase specifications
Verification and hosting testing, no browser devices, physical tags, authorization pop-ups or publishing acceptance results.
