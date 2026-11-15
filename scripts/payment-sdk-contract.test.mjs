import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('native SDKs expose separate order and standard JSAPI payment boundaries', async () => {
  const [android, ios, desktopHeader, desktopSource, harmony] = await Promise.all([
    read('sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidAppPayments.kt'),
    read('sdk/ios/Sources/WeappContainer/AppPayments.swift'),
    read('sdk/desktop/include/weapp/host_services.hpp'),
    read('sdk/desktop/src/host_services_adapter.cpp'),
    read('examples/hosts/harmony/entry/src/main/ets/session/ReferenceHostServices.ts'),
  ]);

  assert.match(android, /interface AndroidNativeWxPayChannel/);
  assert.match(android, /fun installWxRequestPayment\(/);
  assert.match(android, /validatedWxPaymentOptions/);
  assert.match(ios, /protocol WeappNativeWxPayChannel/);
  assert.match(ios, /installWxRequestPayment\(/);
  assert.match(ios, /validatedWxPaymentOptions/);
  assert.match(desktopHeader, /class HostWxPaymentChannel/);
  assert.match(desktopHeader, /wx_payments/);
  assert.match(desktopSource, /const std::set<std::string> wx_payment_apis/);
  assert.match(desktopSource, /validate_wx_payment/);
  assert.match(harmony, /interface HarmonyNativeWxPaymentChannel/);
  assert.match(harmony, /function validatedWxPaymentOptions/);
  assert.match(harmony, /wxChannel\?\: HarmonyNativeWxPaymentChannel/);
});

test('standard JSAPI validation keeps the signed field allowlist identical', async () => {
  const sources = await Promise.all([
    read('sdk/android/library/src/main/java/com/sonofmagic/weapp/container/sdk/AndroidAppPayments.kt'),
    read('sdk/ios/Sources/WeappContainer/AppPayments.swift'),
    read('sdk/desktop/src/host_services_adapter.cpp'),
    read('examples/hosts/harmony/entry/src/main/ets/session/ReferenceHostServices.ts'),
  ]);
  for (const source of sources) {
    for (const field of ['timeStamp', 'nonceStr', 'package', 'signType', 'paySign']) assert.match(source, new RegExp(field));
    for (const signType of ['MD5', 'HMAC-SHA256', 'RSA']) assert.match(source, new RegExp(signType.replace('-', '\\-')));
  }
});
