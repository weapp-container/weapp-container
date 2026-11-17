import { generateKeyPairSync, randomBytes, sign, X509Certificate, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';

const der = (tag, ...values) => {
  const body = Buffer.concat(values.map(v => Buffer.isBuffer(v) ? v : Buffer.from(v)));
  const n = body.length;
  const size = n < 128 ? Buffer.from([n]) : (() => {
    const bytes = []; for (let x = n; x; x >>= 8) bytes.unshift(x & 255);
    return Buffer.from([128 | bytes.length, ...bytes]);
  })();
  return Buffer.concat([Buffer.from([tag]), size, body]);
};
const seq = (...v) => der(0x30, ...v);
const oid = (...v) => der(6, Buffer.from(v));
const utf8 = v => der(12, Buffer.from(v));
const algorithm = seq(oid(42, 134, 72, 206, 61, 4, 3, 2)); // ECDSA/SHA-256
const time = date => der(0x17, Buffer.from(date.toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Generate an ordinary self-signed leaf using Node's crypto primitives. Clients
// trust only this certificate's QR-pinned SHA-256, never a global CA exception.
export function generateIdentity(now = Date.now()) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = seq(der(0x31, seq(oid(85, 4, 3), utf8('Weapp Container Dev Server'))));
  const serial = randomBytes(16); serial[0] &= 0x7f; serial[0] |= 1;
  const extensions = der(0xa3, seq(
    seq(oid(85, 29, 19), der(4, seq())),
    seq(oid(85, 29, 37), der(4, seq(oid(43, 6, 1, 5, 5, 7, 3, 1)))),
    seq(oid(85, 29, 17), der(4, seq(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1]))))),
  ));
  const tbs = seq(der(0xa0, der(2, Buffer.from([2]))), der(2, serial), algorithm, name,
    seq(time(new Date(now - 300000)), time(new Date(now + 365 * 86400000))), name,
    publicKey.export({ type: 'spki', format: 'der' }), extensions);
  const raw = seq(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])));
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', raw), fingerprint: digest(raw) };
}

export async function atomicPrivateJson(file, value) {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    const { rm } = await import('node:fs/promises'); await rm(temp, { force: true }); throw error;
  }
}

export async function loadIdentity(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'identity.json');
  let value;
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('ERR_DEV_IDENTITY: invalid identity file');
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const generated = generateIdentity();
    value = { key: generated.key, cert: generated.cert, serverId: randomBytes(16).toString('hex') };
    await atomicPrivateJson(file, value);
  }
  const cert = new X509Certificate(value.cert);
  if (Date.parse(cert.validTo) <= Date.now()) throw new Error('ERR_DEV_IDENTITY: certificate expired; rotate identity and pair again');
  return { ...value, fingerprint: digest(cert.raw) };
}
