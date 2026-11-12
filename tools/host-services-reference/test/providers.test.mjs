import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, generateKeyPairSync } from 'node:crypto';
import { AlipayProvider, WechatProvider } from '../src/providers.mjs';
import { alipayCanonical, alipayRequestCanonical, decimalToMinor, decryptWechatResource, rawJsonProperty,
  rsaSign, rsaVerify, uniqueForm, wechatAuthorizationMessage, wechatMessage } from '../src/crypto.mjs';

const keys = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const merchant = keys(), platform = keys(), alipayKeys = keys(), now = 1790000000000, timestamp = String(Math.floor(now / 1000));
const wechatConfig = { mchid: 'merchant-1', serialNo: 'MERCHANT-SERIAL', privateKey: merchant.privateKey,
  apiV3Key: '0123456789abcdef0123456789abcdef', platformKeys: { 'PLATFORM-SERIAL': platform.publicKey },
  notifyUrl: 'https://backend.example/v1/payments/callbacks/wechat', appIds: { app: 'wx-app', jsapi: 'wx-jsapi', h5: 'wx-h5', native: 'wx-native' } };
const alipayConfig = { appId: 'ali-app', sellerId: 'seller-1', privateKey: merchant.privateKey, publicKey: alipayKeys.publicKey,
  notifyUrl: 'https://backend.example/v1/payments/callbacks/alipay' };
const order = product => ({ id: 'server-order-1', miniAppId: 'miniapp', merchantOrderId: 'merchantorder1', amount: 123, currency: 'CNY', description: 'Order', product,
  paymentContext: { openid: 'trusted-openid', buyerId: 'trusted-buyer', payerClientIp: '203.0.113.1' } });
function signedWechat(raw, time = timestamp) {
  return { 'wechatpay-timestamp': time, 'wechatpay-nonce': 'response-nonce', 'wechatpay-serial': 'PLATFORM-SERIAL',
    'wechatpay-signature': rsaSign(wechatMessage(time, 'response-nonce', raw), platform.privateKey) };
}
function encryptedWechat(transaction) {
  const nonce = '0123456789ab', associated_data = 'transaction', cipher = createCipheriv('aes-256-gcm', Buffer.from(wechatConfig.apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated_data));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]);
  return { algorithm: 'AEAD_AES_256_GCM', nonce, associated_data, ciphertext: bytes.toString('base64') };
}

test('WeChat API v3 requests and all four launch products use official product-specific signing contracts', async () => {
  const seen = [];
  const provider = new WechatProvider(wechatConfig, { now: () => now, fetch: async (url, init) => {
    const fields = Object.fromEntries([...init.headers.Authorization.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    assert.ok(rsaVerify(wechatAuthorizationMessage(init.method, url.pathname + url.search, fields.timestamp, fields.nonce_str, init.body ?? ''), fields.signature, merchant.publicKey));
    assert.equal(fields.serial_no, 'MERCHANT-SERIAL');
    const request = JSON.parse(init.body); seen.push({ path: url.pathname, request });
    const raw = JSON.stringify({ prepay_id: 'prepay-1', h5_url: 'https://wx.tenpay.com/pay/test', code_url: 'weixin://wxpay/test' });
    return new Response(raw, { headers: signedWechat(raw) });
  } });
  for (const product of ['app', 'jsapi', 'h5', 'native']) {
    const result = await provider.create(order(product));
    assert.equal(result.status, 'pending'); assert.equal(seen.at(-1).path, `/v3/pay/transactions/${product}`);
    assert.equal(seen.at(-1).request.appid, wechatConfig.appIds[product]);
    const launch = result.launch;
    if (product === 'app') {
      assert.equal(launch.packageValue, 'Sign=WXPay');
      assert.ok(rsaVerify(`${launch.appId}\n${launch.timeStamp}\n${launch.nonceStr}\n${launch.prepayId}\n`, launch.sign, merchant.publicKey));
      assert.ok(!rsaVerify(`${launch.appId}\n${launch.timeStamp}\n${launch.nonceStr}\nprepay_id=${launch.prepayId}\n`, launch.sign, merchant.publicKey));
    }
    if (product === 'jsapi') {
      assert.equal(seen.at(-1).request.payer.openid, 'trusted-openid');
      assert.ok(rsaVerify(`${launch.appId}\n${launch.timeStamp}\n${launch.nonceStr}\n${launch.package}\n`, launch.paySign, merchant.publicKey));
    }
    if (product === 'h5') assert.equal(seen.at(-1).request.scene_info.payer_client_ip, '203.0.113.1');
    assert.ok(!JSON.stringify(launch).includes(merchant.privateKey)); assert.ok(!JSON.stringify(launch).includes(wechatConfig.apiV3Key));
  }
});

test('WeChat response signature failures and missing JSAPI payer identity fail closed', async () => {
  const provider = new WechatProvider(wechatConfig, { now: () => now, fetch: async () => {
    const original = JSON.stringify({ prepay_id: 'original' });
    return new Response(JSON.stringify({ prepay_id: 'tampered' }), { headers: signedWechat(original) });
  } });
  await assert.rejects(provider.create(order('app')), error => error.code === 'invalid_signature');
  await assert.rejects(provider.create({ ...order('jsapi'), paymentContext: {} }), error => error.code === 'invalid_request');
});

test('WeChat callbacks verify pinned RSA proof before authenticated AES-GCM decryption', () => {
  const provider = new WechatProvider(wechatConfig, { now: () => now });
  const transaction = { out_trade_no: 'merchantorder1', appid: 'wx-app', mchid: 'merchant-1', amount: { total: 123, currency: 'CNY' }, trade_state: 'SUCCESS', transaction_id: 'wx-transaction' };
  const resource = encryptedWechat(transaction), raw = JSON.stringify({ id: 'event-1', resource_type: 'encrypt-resource', event_type: 'TRANSACTION.SUCCESS', resource });
  const event = provider.notification(signedWechat(raw), raw);
  assert.equal(event.amount, 123); assert.equal(event.status, 'paid'); provider.validate(order('app'), event);
  assert.throws(() => provider.notification(signedWechat(raw), raw.replace('event-1', 'event-2')), error => error.code === 'invalid_signature');
  assert.throws(() => provider.notification({ ...signedWechat(raw), 'wechatpay-serial': 'UNTRUSTED' }, raw), error => error.code === 'invalid_signature');
  assert.throws(() => provider.notification(signedWechat(raw, String(Number(timestamp) - 301)), raw), error => error.code === 'invalid_signature');
  const corrupted = { ...resource, associated_data: 'changed' };
  assert.throws(() => decryptWechatResource(corrupted, wechatConfig.apiV3Key), error => error.code === 'invalid_notification');
  assert.throws(() => provider.validate(order('app'), { ...event, merchantId: 'other-merchant' }), error => error.code === 'payment_mismatch');
});

test('WeChat signed queries retain amount and merchant binding', async () => {
  const provider = new WechatProvider(wechatConfig, { now: () => now, fetch: async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(url.searchParams.get('mchid'), 'merchant-1');
    const raw = JSON.stringify({ out_trade_no: 'merchantorder1', appid: 'wx-app', mchid: 'merchant-1', amount: { total: 123, currency: 'CNY' }, trade_state: 'SUCCESS', transaction_id: 'tx' });
    return new Response(raw, { headers: signedWechat(raw) });
  } });
  const event = await provider.query(order('app')); assert.equal(event.status, 'paid'); provider.validate(order('app'), event);
});

test('Alipay APP and H5 payloads are RSA2 signed, URL-encoded after signing, and stay pending', async () => {
  const provider = new AlipayProvider(alipayConfig, { now: () => now, fetch: () => { throw new Error('APP/H5 must not call gateway'); } });
  for (const product of ['app', 'h5']) {
    const result = await provider.create(order(product)); assert.equal(result.status, 'pending');
    const raw = product === 'app' ? result.launch.orderString : new URL(result.launch.url).search.slice(1), fields = uniqueForm(raw);
    assert.ok(rsaVerify(alipayRequestCanonical(fields), fields.sign, merchant.publicKey));
    assert.ok(!rsaVerify(alipayCanonical(fields), fields.sign, merchant.publicKey));
    assert.equal(fields.sign_type, 'RSA2'); assert.equal(JSON.parse(fields.biz_content).total_amount, '1.23');
    assert.equal(JSON.parse(fields.biz_content).product_code, product === 'app' ? 'QUICK_MSECURITY_PAY' : 'QUICK_WAP_WAY');
  }
});

test('Alipay gateway responses verify original signed JSON bytes for JSAPI, QR and query', async () => {
  const provider = new AlipayProvider(alipayConfig, { now: () => now, fetch: async (_url, init) => {
    const fields = uniqueForm(init.body); assert.ok(rsaVerify(alipayRequestCanonical(fields), fields.sign, merchant.publicKey));
    if (fields.method === 'alipay.trade.create') assert.equal(JSON.parse(fields.biz_content).buyer_id, 'trusted-buyer');
    const property = fields.method.replaceAll('.', '_') + '_response';
    const signed = '{ "code" : "10000", "out_trade_no" : "merchantorder1", "trade_no":"ali-tx", "qr_code":"https://qr.alipay.com/test", "total_amount":"1.23", "trade_status":"TRADE_SUCCESS" }';
    const raw = `{ "${property}" : ${signed}, "sign":${JSON.stringify(rsaSign(signed, alipayKeys.privateKey))} }`;
    assert.equal(rawJsonProperty(raw, property), signed);
    return new Response(raw);
  } });
  assert.equal((await provider.create(order('jsapi'))).launch.tradeNO, 'ali-tx');
  assert.equal((await provider.create(order('native'))).launch.kind, 'alipay-qr');
  assert.equal((await provider.query(order('app'))).status, 'paid');
});

test('Alipay forged response or duplicate response properties cannot substitute payment data', async () => {
  const signed = '{"code":"10000","out_trade_no":"merchantorder1","trade_no":"ali-tx"}';
  const provider = new AlipayProvider(alipayConfig, { now: () => now, fetch: async () => new Response(JSON.stringify({
    alipay_trade_create_response: { code: '10000', out_trade_no: 'other-order', trade_no: 'forged' }, sign: rsaSign(signed, alipayKeys.privateKey),
  })) });
  await assert.rejects(provider.create(order('jsapi')), error => error.code === 'invalid_signature');
  assert.throws(() => rawJsonProperty('{"a":1,"a":2}', 'a'), error => error.code === 'invalid_provider_response');
});

test('Alipay notifications verify decoded sorted fields without sign_type, require RSA2, and reject duplicate keys', () => {
  const provider = new AlipayProvider(alipayConfig, { now: () => now });
  const fields = { app_id: 'ali-app', seller_id: 'seller-1', out_trade_no: 'merchantorder1', total_amount: '1.23', trade_no: 'ali-tx', trade_status: 'TRADE_SUCCESS', notify_id: 'notify-1', sign_type: 'RSA2' };
  fields.sign = rsaSign(alipayCanonical(fields), alipayKeys.privateKey);
  const raw = new URLSearchParams(fields).toString(), event = provider.notification({}, raw);
  provider.validate(order('app'), event); assert.equal(event.amount, 123);
  assert.throws(() => provider.notification({}, raw.replace('1.23', '1.24')), error => error.code === 'invalid_signature');
  assert.throws(() => provider.notification({}, `${raw}&total_amount=1.24`), error => error.code === 'invalid_notification');
  assert.throws(() => provider.notification({}, raw.replace('RSA2', 'RSA')), error => error.code === 'invalid_signature');
});

test('decimal currency parsing is exact and rejects exponent/negative/fractional minor units', () => {
  assert.equal(decimalToMinor('0.01'), 1); assert.equal(decimalToMinor('12.3'), 1230);
  for (const value of ['-1.00', '1e2', '1.001', '01.00', 1.23]) assert.throws(() => decimalToMinor(value));
});
