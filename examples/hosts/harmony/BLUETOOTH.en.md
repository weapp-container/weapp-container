<a id="harmonyos-ble-中心端和-gatt"></a>
# HarmonyOS BLE central and GATT

[简体中文](BLUETOOTH.md) · **English**


`HarmonyBluetoothApis.ets` uses the official OpenHarmony API24 Bluetooth access
and BLE APIs. `Index.ets` recreates this adapter for each internal owner, before
host-service configuration, and the module declares the in-use
`ohos.permission.ACCESS_BLUETOOTH` permission.

The installed API set comprises adapter open/close/state; discovery start/stop;
discovered and owned connected devices; GATT connect/disconnect, services,
characteristics, RSSI, read, write and notification configuration; negotiated
MTU get/set; and the corresponding adapter/device/connection/value/MTU
subscriptions. Peripheral/server mode is not installed or advertised.

Opening the adapter first asks for application consent using the trusted
application and publisher identity, then requests the actual OS permission.
The grant belongs to this account's application owner and is not persisted or
shared with another application. A closed/replaced owner asks again. The
adapter never enables system Bluetooth silently. Consent denial, OS denial,
Bluetooth switched off and an absent installed capability remain distinct
outcomes. Pending consent or OS permission cannot start resources after
backgrounding, cancellation or owner revocation.

The OS scanner is process-wide. This implementation grants one exclusive
scanner lease across container instances. Another container receives an
explicit busy failure and cannot replace filters or stop that scanner. A
later scan starts only after the previous native scanner and listener have
retired. Discovery filters normalize 16/32/128-bit UUIDs; raw advertising
fields supply service UUIDs, service data and exact manufacturer bytes when
the SDK's optional decoded fields are absent.

Each GATT client has an exact owner, connection generation and sequential
operation queue. Connect succeeds after the platform's connected callback.
MTU changes succeed after the actual `BLEMtuChange` callback; requesting a
size alone does not imply negotiation succeeded. Writes are bounded by both
the negotiated `MTU - 3` and the 512-byte characteristic limit. Read results,
notifications, service data and manufacturer data use the protocol's binary
envelopes without text conversion. Discovery retains at most 256 devices;
one raw advertisement is limited to 64 KiB and one service value to 512 bytes.

Platform callbacks only enqueue through `HarmonyHostServices`. Its owning
ArkTS executor drains records into N-API and QuickJS; callbacks never enter JS
directly. Queue backpressure stops the exact scanner or GATT producer.
Backgrounding, revocation, adapter shutdown and owner close stop discovery and
retire all GATT clients. Cancelling an in-flight GATT operation retires that
client because the SDK has no independent command-cancellation primitive.
Cleanup unregisters listeners, disconnects, calls the native client's `close`,
then waits for outstanding SDK promises. A failed native close or undrained
operation retains the cleanup barrier for retry and cannot release the old
account owner as if cleanup succeeded.

Run the lifecycle contracts with:

```sh
node --test scripts/harmony-bluetooth-lifecycle.test.mjs
```

These tests execute the production ArkTS owner after type stripping against
finite, observable SDK callbacks. They cover late permission, owner-thread
delivery, obsolete scan cancellation, two-container scanner isolation, GATT
ordering, exact binary values, MTU negotiation/cancellation, a native read
still draining during revocation, and retry after a native cleanup failure.
They verify lifetime behavior and do not constitute physical-device evidence.

The official API24 compiler produced an unsigned HAP on 2026-11-02, with the
source hashes and artifact receipt retained under
[`docs/host-services/evidence/2026-11-02-harmony-ble`](../../../docs/archived-evidence.en.md).
The HAP SHA-256 is
`7f3ae87b808637011e82b4190e5665f972ae1913d500b56d7e051cdcd44836c0`.
SDK warnings include the existing unverified N-API module, throwable platform
APIs and deprecated dialog helpers; packaging succeeded without signing.

Physical BLE discovery, pairing/system authorization UI, service enumeration,
peripheral-specific read/write and MTU behavior, notification traffic, device
disconnect, permission revocation and background/resume remain **pending
device acceptance**. An API24 build and the finite-callback tests do not mark
those cases as accepted. BLE needs an actual supported radio and peripheral;
an unavailable radio is reported explicitly.
