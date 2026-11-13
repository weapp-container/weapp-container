import type { Input, HeadersInput } from './types.ts';
import type { BinaryLike, KeyLike } from 'node:crypto';
import { createDecipheriv, createHash, createHmac, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto';
import { requireThat } from './errors.ts';

export const digest = (value: BinaryLike) => createHash('sha256').update(value).digest('hex');
export const opaqueToken = () => randomBytes(32).toString('base64url');
export function equalSecret(left: unknown, right: unknown) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());
}
export const rsaSign = (message: string, privateKey: KeyLike) => sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64');
export function rsaVerify(message: string, signature: unknown, publicKey: KeyLike) {
  try { return typeof signature === 'string' && verify('RSA-SHA256', Buffer.from(message), publicKey, Buffer.from(signature, 'base64')); }
  catch { return false; }
}
export function timestampFresh(value: unknown, now: number, skewSeconds = 300) {
  requireThat(typeof value === 'string' && /^\d{1,12}$/.test(value) && Math.abs(Number(value) - Math.floor(now / 1000)) <= skewSeconds,
    'invalid_signature', 'Signed timestamp is outside the accepted window', 401);
}
export const wechatMessage = (timestamp: string, nonce: string, raw: string) => `${timestamp}\n${nonce}\n${raw}\n`;
export const wechatAuthorizationMessage = (method: string, path: string, timestamp: string, nonce: string, body: string) => `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
export function verifyWechatMessage(headers: HeadersInput, raw: string, keys: Record<string, string>, now: number) {
  const get = (name: string): any => headers instanceof Headers ? headers.get(name) : headers[name.toLowerCase()];
  const timestamp = get('wechatpay-timestamp'), nonce = get('wechatpay-nonce'), serial = get('wechatpay-serial');
  timestampFresh(timestamp, now);
  requireThat(typeof nonce === 'string' && nonce.length > 0 && nonce.length <= 128 && !/[\r\n]/.test(nonce), 'invalid_signature', 'Invalid signed nonce', 401);
  requireThat(typeof serial === 'string' && Object.hasOwn(keys, serial), 'invalid_signature', 'Unconfigured WeChat platform key', 401);
  requireThat(rsaVerify(wechatMessage(timestamp, nonce, raw), get('wechatpay-signature'), keys[serial]), 'invalid_signature', 'WeChat signature verification failed', 401);
}
export function decryptWechatResource(resource: Input, apiV3Key: string) {
  requireThat(resource?.algorithm === 'AEAD_AES_256_GCM' && typeof resource.nonce === 'string' && typeof resource.ciphertext === 'string',
    'invalid_notification', 'Unsupported encrypted resource');
  requireThat(Buffer.byteLength(apiV3Key ?? '') === 32, 'provider_configuration', 'WeChat API v3 key must be 32 bytes', 503);
  const bytes = Buffer.from(resource.ciphertext, 'base64');
  requireThat(bytes.length > 16, 'invalid_notification', 'Encrypted resource is truncated');
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(resource.nonce));
    decipher.setAuthTag(bytes.subarray(-16));
    decipher.setAAD(Buffer.from(resource.associated_data ?? ''));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString('utf8'));
  } catch { requireThat(false, 'invalid_notification', 'Encrypted resource authentication failed', 401); }
}
export function alipayCanonical(fields: Input) {
  return Object.entries(fields).filter(([key, value]) => key !== 'sign' && key !== 'sign_type' && value !== '' && value !== undefined && value !== null)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&');
}
// Request signing includes sign_type; notifications omit it under Alipay RSA2.
export function alipayRequestCanonical(fields: Input) {
  return Object.entries(fields).filter(([key, value]) => key !== 'sign' && value !== '' && value !== undefined && value !== null)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&');
}
export function uniqueForm(raw: string) {
  const fields: Record<string, string> = Object.create(null);
  for (const [key, value] of new URLSearchParams(raw)) {
    requireThat(!Object.hasOwn(fields, key), 'invalid_notification', 'Duplicate form field');
    fields[key] = value;
  }
  return fields;
}
export function decimalToMinor(value: unknown) {
  requireThat(typeof value === 'string' && /^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(value), 'invalid_amount', 'Invalid decimal amount');
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  requireThat(Number.isSafeInteger(amount), 'invalid_amount', 'Amount exceeds integer range');
  return amount;
}
export const minorToDecimal = (amount: number) => `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;

// Alipay signs the original response value bytes. JSON.parse/stringify can
// change whitespace, escaping and numeric representations, invalidating proof.
export function rawJsonProperty(raw: string, wanted: string) {
  let i = 0;
  const whitespace = () => { while (/\s/.test(raw[i] ?? '') && i < raw.length) i++; };
  const quoted = (): string => {
    requireThat(raw[i] === '"', 'invalid_provider_response', 'Expected JSON string', 502);
    const start = i++;
    while (i < raw.length) { if (raw[i] === '\\') i += 2; else if (raw[i++] === '"') return raw.slice(start, i); }
    throw new Error('Unterminated JSON string');
  };
  const value = () => {
    const start = i;
    if (raw[i] === '"') quoted();
    else if (raw[i] === '{' || raw[i] === '[') {
      const stack = [raw[i++] === '{' ? '}' : ']'];
      while (stack.length && i < raw.length) {
        if (raw[i] === '"') quoted();
        else if (raw[i] === '{' || raw[i] === '[') stack.push(raw[i++] === '{' ? '}' : ']');
        else if (raw[i] === '}' || raw[i] === ']') { requireThat(raw[i++] === stack.pop(), 'invalid_provider_response', 'Mismatched JSON container', 502); }
        else i++;
      }
      requireThat(!stack.length, 'invalid_provider_response', 'Truncated JSON container', 502);
    } else while (i < raw.length && raw[i] !== ',' && raw[i] !== '}') i++;
    return raw.slice(start, i).trimEnd();
  };
  whitespace(); requireThat(raw[i++] === '{', 'invalid_provider_response', 'Expected JSON response object', 502);
  const seen = new Set(); let found;
  whitespace();
  while (raw[i] !== '}') {
    const key = JSON.parse(quoted());
    requireThat(!seen.has(key), 'invalid_provider_response', 'Duplicate response property', 502); seen.add(key);
    whitespace(); requireThat(raw[i++] === ':', 'invalid_provider_response', 'Expected JSON colon', 502); whitespace();
    const part = value(); if (key === wanted) found = part;
    whitespace(); if (raw[i] === '}') break;
    requireThat(raw[i++] === ',', 'invalid_provider_response', 'Expected JSON separator', 502); whitespace();
  }
  requireThat(found !== undefined, 'invalid_provider_response', 'Signed response property missing', 502);
  return found;
}
export const referenceSignature = (secret: string, timestamp: string, raw: string) => createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
