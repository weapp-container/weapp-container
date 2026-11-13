import type { Input, HeadersInput, ProviderOptions } from './types.ts';
import { randomBytes } from 'node:crypto';
import { alipayCanonical, alipayRequestCanonical, decimalToMinor, decryptWechatResource, equalSecret,
  minorToDecimal, rawJsonProperty, referenceSignature, rsaSign, rsaVerify, timestampFresh,
  uniqueForm, verifyWechatMessage, wechatAuthorizationMessage } from './crypto.ts';
import { requireThat, text } from './errors.ts';

const nonce = () => randomBytes(16).toString('hex');
const state = (value: string) => ({ SUCCESS: 'paid', TRADE_SUCCESS: 'paid', TRADE_FINISHED: 'paid',
  CLOSED: 'closed', TRADE_CLOSED: 'closed', REFUND: 'refunded' } as Record<string, string>)[value] ?? 'pending';
const json = (raw: string): Input => { try { return JSON.parse(raw); } catch { requireThat(false, 'invalid_provider_response', 'Invalid provider JSON', 502); } };
const requireHttps = (value: string) => {
  const url = new URL(value);
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.hash,
    'provider_configuration', 'Provider endpoint must use HTTPS', 503);
  return url;
};

export class ReferenceProvider {
  secret: string; now: () => number;
  constructor({ callbackSecret }: Input, { now = Date.now }: ProviderOptions = {}) {
    requireThat(typeof callbackSecret === 'string' && callbackSecret.length >= 32, 'provider_configuration', 'Reference callback secret must have at least 32 characters', 503);
    this.secret = callbackSecret; this.now = now;
  }
  async create(order: Input) {
    requireThat(order.product === 'app', 'unsupported_product', 'Reference channel only supports the reference app launch');
    return { launch: { kind: 'reference', orderId: order.id, merchantOrderId: order.merchantOrderId }, status: 'pending' };
  }
  async query() { requireThat(false, 'query_unavailable', 'Reference channel uses signed local callbacks', 409); }
  notification(headers: HeadersInput, raw: string) {
    const get = (name: string) => headers instanceof Headers ? headers.get(name) : headers[name];
    const timestamp = get('x-reference-timestamp'); timestampFresh(timestamp, this.now());
    requireThat(equalSecret(referenceSignature(this.secret, timestamp as string, raw), get('x-reference-signature')), 'invalid_signature', 'Invalid reference callback signature', 401);
    const body = json(raw);
    requireThat(['paid', 'closed'].includes(body.status), 'invalid_notification', 'Unknown reference payment state');
    return { eventId: text(body.eventId, 'eventId'), merchantOrderId: text(body.merchantOrderId, 'merchantOrderId'),
      amount: body.amount, currency: body.currency, status: body.status,
      transactionId: text(body.transactionId, 'transactionId'), providerAppId: body.miniAppId };
  }
  validate(order: Input, event: Input) { requireThat(event.providerAppId === order.miniAppId, 'payment_mismatch', 'Reference app mismatch'); }
}

export class WechatProvider {
  config: Input; fetch: typeof globalThis.fetch; now: () => number; endpoint: URL;
  constructor(config: Input, { fetch = globalThis.fetch, now = Date.now }: ProviderOptions = {}) {
    this.config = config; this.fetch = fetch; this.now = now;
    this.endpoint = requireHttps(config.endpoint ?? 'https://api.mch.weixin.qq.com');
    requireThat(this.endpoint.origin === 'https://api.mch.weixin.qq.com', 'provider_configuration', 'Use the official WeChat Pay gateway', 503);
    for (const field of ['mchid', 'serialNo', 'apiV3Key', 'notifyUrl']) text(config[field], field, 16384);
    requireThat(typeof config.privateKey === 'string' && config.privateKey.includes('PRIVATE KEY'), 'provider_configuration', 'Configure merchant RSA private key PEM', 503);
    requireHttps(config.notifyUrl);
    requireThat(Buffer.byteLength(config.apiV3Key) === 32 && Object.keys(config.platformKeys ?? {}).length > 0,
      'provider_configuration', 'Configure API v3 key and pinned WeChat platform public keys', 503);
  }
  appId(order: Input) { return text(this.config.appIds?.[order.product], `WeChat ${order.product} app ID`); }
  async request(method: string, path: string, body?: Input) {
    const raw = body === undefined ? '' : JSON.stringify(body), timestamp = String(Math.floor(this.now() / 1000)), n = nonce();
    const signature = rsaSign(wechatAuthorizationMessage(method, path, timestamp, n, raw), this.config.privateKey);
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchid}",nonce_str="${n}",timestamp="${timestamp}",serial_no="${this.config.serialNo}",signature="${signature}"`;
    const response = await this.fetch(new URL(path, this.endpoint), { method, headers: { Authorization: authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(raw ? { body: raw } : {}), redirect: 'error', signal: AbortSignal.timeout(15000) });
    const responseRaw = await response.text();
    verifyWechatMessage(response.headers, responseRaw, this.config.platformKeys, this.now());
    requireThat(response.ok, 'provider_rejected', 'WeChat Pay rejected the request; reconcile the persisted merchant order before retrying', 502);
    return json(responseRaw);
  }
  async create(order: Input) {
    requireThat(['app', 'jsapi', 'h5', 'native'].includes(order.product), 'unsupported_product', 'Unsupported WeChat product');
    const appid = this.appId(order), body: Input = { appid, mchid: this.config.mchid, description: order.description,
      out_trade_no: order.merchantOrderId, notify_url: this.config.notifyUrl, amount: { total: order.amount, currency: order.currency } };
    if (order.product === 'jsapi') body.payer = { openid: text(order.paymentContext.openid, 'payer.openid') };
    if (order.product === 'h5') body.scene_info = { payer_client_ip: text(order.paymentContext.payerClientIp, 'payerClientIp'), h5_info: { type: 'Wap' } };
    const result = await this.request('POST', `/v3/pay/transactions/${order.product}`, body);
    let launch;
    if (order.product === 'h5') launch = { kind: 'wechat-h5', url: text(result.h5_url, 'h5_url', 4096) };
    else if (order.product === 'native') launch = { kind: 'wechat-qr', codeUrl: text(result.code_url, 'code_url', 4096) };
    else {
      const prepayId = text(result.prepay_id, 'prepay_id'), timeStamp = String(Math.floor(this.now() / 1000)), nonceStr = nonce();
      const packageValue = order.product === 'app' ? prepayId : `prepay_id=${prepayId}`;
      const signature = rsaSign(`${appid}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`, this.config.privateKey);
      launch = order.product === 'app'
        ? { kind: 'wechat-app', appId: appid, partnerId: this.config.mchid, prepayId, packageValue: 'Sign=WXPay', nonceStr, timeStamp, sign: signature }
        : { kind: 'wechat-jsapi', appId: appid, timeStamp, nonceStr, package: packageValue, signType: 'RSA', paySign: signature };
    }
    return { launch, status: 'pending' };
  }
  event(body: Input, eventId: string | null) {
    return { eventId, merchantOrderId: text(body.out_trade_no, 'out_trade_no'), providerAppId: body.appid,
      merchantId: body.mchid, amount: body.amount?.total, currency: body.amount?.currency,
      transactionId: body.transaction_id, status: state(body.trade_state) };
  }
  async query(order: Input) {
    const result = await this.request('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(order.merchantOrderId)}?mchid=${encodeURIComponent(this.config.mchid)}`);
    return this.event(result, null);
  }
  notification(headers: HeadersInput, raw: string) {
    verifyWechatMessage(headers, raw, this.config.platformKeys, this.now());
    const outer = json(raw);
    requireThat(outer.event_type === 'TRANSACTION.SUCCESS' && outer.resource_type === 'encrypt-resource', 'invalid_notification', 'Unsupported WeChat notification');
    const body = decryptWechatResource(outer.resource, this.config.apiV3Key);
    requireThat(body.trade_state === 'SUCCESS', 'invalid_notification', 'Unexpected WeChat transaction state');
    return this.event(body, text(outer.id, 'event id'));
  }
  validate(order: Input, event: Input) {
    requireThat(event.providerAppId === this.appId(order) && event.merchantId === this.config.mchid,
      'payment_mismatch', 'WeChat merchant or app mismatch');
  }
}

export class AlipayProvider {
  config: Input; fetch: typeof globalThis.fetch; now: () => number; endpoint: URL;
  constructor(config: Input, { fetch = globalThis.fetch, now = Date.now }: ProviderOptions = {}) {
    this.config = config; this.fetch = fetch; this.now = now;
    this.endpoint = requireHttps(config.gateway ?? 'https://openapi.alipay.com/gateway.do');
    requireThat(['https://openapi.alipay.com', 'https://openapi-sandbox.dl.alipaydev.com'].includes(this.endpoint.origin),
      'provider_configuration', 'Use the official Alipay production or sandbox gateway', 503);
    for (const field of ['appId', 'sellerId', 'notifyUrl']) text(config[field], field, 16384);
    requireThat(typeof config.privateKey === 'string' && config.privateKey.includes('PRIVATE KEY') && typeof config.publicKey === 'string' && config.publicKey.includes('PUBLIC KEY'),
      'provider_configuration', 'Configure merchant private key and Alipay public key PEM', 503);
    requireHttps(config.notifyUrl);
  }
  parameters(method: string, business: Input, notify = false) {
    // Alipay timestamps use Beijing local time, independent of the server TZ.
    const timestamp = new Date(this.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    const fields: Record<string, string> = { app_id: this.config.appId, method, format: 'JSON', charset: 'utf-8', sign_type: 'RSA2', timestamp,
      version: '1.0', biz_content: JSON.stringify(business), ...(notify ? { notify_url: this.config.notifyUrl } : {}) };
    fields.sign = rsaSign(alipayRequestCanonical(fields), this.config.privateKey);
    return fields;
  }
  async request(method: string, business: Input) {
    const fields = this.parameters(method, business, method !== 'alipay.trade.query');
    const response = await this.fetch(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(fields).toString(), redirect: 'error', signal: AbortSignal.timeout(15000) });
    const raw = await response.text();
    requireThat(response.ok, 'provider_rejected', 'Alipay HTTP request failed; reconcile the persisted order', 502);
    const envelope = json(raw), property = `${method.replaceAll('.', '_')}_response`, signed = rawJsonProperty(raw, property);
    requireThat(rsaVerify(signed, envelope.sign, this.config.publicKey), 'invalid_signature', 'Alipay response signature verification failed', 502);
    const result = envelope[property];
    requireThat(result?.code === '10000', 'provider_rejected', 'Alipay rejected the request; reconcile the persisted order', 502);
    return result;
  }
  async create(order: Input) {
    requireThat(['app', 'jsapi', 'h5', 'native'].includes(order.product), 'unsupported_product', 'Unsupported Alipay product');
    const business = { out_trade_no: order.merchantOrderId, total_amount: minorToDecimal(order.amount), subject: order.description, seller_id: this.config.sellerId };
    let launch;
    if (order.product === 'app') {
      const fields = this.parameters('alipay.trade.app.pay', { ...business, product_code: 'QUICK_MSECURITY_PAY' }, true);
      launch = { kind: 'alipay-app', orderString: new URLSearchParams(fields).toString() };
    } else if (order.product === 'h5') {
      const fields = this.parameters('alipay.trade.wap.pay', { ...business, product_code: 'QUICK_WAP_WAY' }, true);
      launch = { kind: 'alipay-h5', url: `${this.endpoint}?${new URLSearchParams(fields)}` };
    } else if (order.product === 'jsapi') {
      const result = await this.request('alipay.trade.create', { ...business, buyer_id: text(order.paymentContext.buyerId, 'buyerId') });
      requireThat(result.out_trade_no === order.merchantOrderId, 'payment_mismatch', 'Alipay create returned another order');
      launch = { kind: 'alipay-jsapi', tradeNO: text(result.trade_no, 'trade_no') };
    } else {
      const result = await this.request('alipay.trade.precreate', business);
      requireThat(result.out_trade_no === order.merchantOrderId, 'payment_mismatch', 'Alipay create returned another order');
      launch = { kind: 'alipay-qr', qrCode: text(result.qr_code, 'qr_code', 4096) };
    }
    return { launch, status: 'pending' };
  }
  async query(order: Input) {
    const result = await this.request('alipay.trade.query', { out_trade_no: order.merchantOrderId });
    return { eventId: null, merchantOrderId: result.out_trade_no, amount: decimalToMinor(result.total_amount), currency: 'CNY',
      providerAppId: this.config.appId, merchantId: this.config.sellerId, transactionId: result.trade_no,
      status: state(result.trade_status) };
  }
  notification(_headers: HeadersInput, raw: string) {
    const fields = uniqueForm(raw);
    requireThat(fields.sign_type === 'RSA2' && rsaVerify(alipayCanonical(fields), fields.sign, this.config.publicKey), 'invalid_signature', 'Alipay notification signature verification failed', 401);
    requireThat(['TRADE_SUCCESS', 'TRADE_FINISHED', 'TRADE_CLOSED', 'WAIT_BUYER_PAY'].includes(fields.trade_status), 'invalid_notification', 'Unknown Alipay state');
    return { eventId: text(fields.notify_id, 'notify_id'), merchantOrderId: text(fields.out_trade_no, 'out_trade_no'),
      amount: decimalToMinor(fields.total_amount), currency: 'CNY', providerAppId: fields.app_id, merchantId: fields.seller_id,
      transactionId: fields.trade_no, status: state(fields.trade_status) };
  }
  validate(_order: Input, event: Input) {
    requireThat(event.providerAppId === this.config.appId && event.merchantId === this.config.sellerId,
      'payment_mismatch', 'Alipay merchant or app mismatch');
  }
}
