import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeviceDevServer, sanitizeInspectorSnapshot } from './device-dev-server.mjs';
import { canonicalize } from '../tools/container-manifest/src/json-integrity.mjs';
import { digest } from './lib/device-dev/identity.mjs';
import { projectPlayerViewDiagnostics } from './lib/device-dev/player-view-diagnostics.mjs';
import { nativeViewMetricsFixture } from './fixtures/device-dev-view-metrics.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'weapp-dev-device-'));
  const packs = path.join(root, 'packs'); await mkdir(packs);
  const options = { project: root, packRoot: packs, identityRoot: path.join(root, 'identity'), host: '127.0.0.1', advertiseHost: '127.0.0.1', port: 0, adminPort: 0 };
  const server = await DeviceDevServer.create(options);
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { root, packs, server, options };
}
async function request(server, url, { method = 'GET', data, token, fingerprint = server.identity.fingerprint, admin = false, origin, host } = {}) {
  const endpoint = admin ? server.adminOrigin : server.endpoint;
  const bytes = data === undefined ? null : Buffer.from(JSON.stringify(data));
  return new Promise((resolve, reject) => {
    const req = (admin ? http : https).request(new URL(url, endpoint), {
      method, agent: false, ca: server.identity.cert,
      checkServerIdentity: (_, cert) => digest(cert.raw) === fingerprint ? undefined : Error('PIN_MISMATCH'),
      headers: { ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), ...(host ? { host } : {}) },
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.once('error', reject);
      res.once('end', () => { const raw = Buffer.concat(chunks); let json; try { json = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, raw, json }); });
    }); req.once('error', reject); if (bytes) req.write(bytes); req.end();
  });
}
async function pair(server, id = 'test-device') {
  const code = new URL(server.issuePairing().uri).searchParams.get('code');
  const data = { protocolVersion: '1.0', code, deviceId: id, name: 'Test Device', platform: 'macos' };
  const result = await request(server, '/v1/pair', { method: 'POST', data });
  assert.equal(result.status, 200); assert.equal(result.json.protocolVersion, '1.0');
  return { token: result.json.deviceToken, data };
}
async function pack(packs, revision, text = 'contents') {
  const dir = path.join(packs, `generation-${revision}`), blob = Buffer.from(text), hash = digest(blob);
  await mkdir(path.join(dir, 'blobs/sha256'), { recursive: true });
  const manifest = { schemaVersion: 1, compiler: { name: 'weapp-vite', commit: 'a'.repeat(40), platform: 'weapp' }, assets: [{ path: 'a.txt', sha256: hash, size: blob.length, mime: 'text/plain' }], integrity: { algorithm: 'sha256', root: '' } };
  manifest.integrity.root = digest(Buffer.from(canonicalize(manifest)));
  const raw = Buffer.from(canonicalize(manifest) + '\n');
  await writeFile(path.join(dir, 'manifest.json'), raw); await writeFile(path.join(dir, 'blobs/sha256', hash), blob);
  return { report: { revision, packDirectory: dir, manifestSha256: digest(raw), integrityRoot: manifest.integrity.root }, hash, blob, raw };
}
async function sourceMappedPack(packs, revision, source = 'src/home.ts', mapOverrides = {}) {
  const dir = path.join(packs, `generation-${revision}`);
  await mkdir(path.join(dir, 'blobs/sha256'), { recursive: true });
  const module = Buffer.from('throw new Error("test");'), moduleHash = digest(module);
  const map = Buffer.from(JSON.stringify({ version: 3, names: [], sources: [source], mappings: 'AAAA', ...mapOverrides })), mapHash = digest(map);
  const manifest = { schemaVersion: 1, compiler: { name: 'weapp-vite', commit: 'a'.repeat(40), platform: 'weapp' },
    modules: [{ id: 'module:app.js', sha256: moduleHash, format: 'commonjs', scope: 'app' }],
    assets: [{ path: 'app.js.map', sha256: mapHash, size: map.length, mime: 'application/json' }], integrity: { algorithm: 'sha256', root: '' } };
  manifest.integrity.root = digest(Buffer.from(canonicalize(manifest)));
  const raw = Buffer.from(canonicalize(manifest) + '\n');
  await writeFile(path.join(dir, 'manifest.json'), raw);
  await writeFile(path.join(dir, 'blobs/sha256', moduleHash), module); await writeFile(path.join(dir, 'blobs/sha256', mapHash), map);
  return { report: { revision, packDirectory: dir, manifestSha256: digest(raw), integrityRoot: manifest.integrity.root }, mapFile: path.join(dir, 'blobs/sha256', mapHash) };
}
async function reportPeer(t, server, token) {
  const url = new URL(server.endpoint), socket = tls.connect({ host: url.hostname, port: Number(url.port), ca: server.identity.cert });
  t.after(() => socket.destroy()); await once(socket, 'secureConnect');
  let received = Buffer.alloc(0);
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('WSS timeout')), 3000);
    socket.on('data', part => { received = Buffer.concat([received, part]); if (received.includes(Buffer.from('"type":"ready"'))) { clearTimeout(timeout); resolve(); } }); socket.once('error', reject);
  });
  socket.write(`GET /v1/events HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer ${token}\r\n\r\n`);
  await ready;
  return { socket, send(value) {
    const bytes = Buffer.from(JSON.stringify(value)), mask = Buffer.from([5, 19, 27, 43]);
    assert.ok(bytes.length < 65536);
    const header = bytes.length < 126 ? Buffer.from([0x81, 0x80 | bytes.length]) : Buffer.from([0x81, 0xfe, bytes.length >> 8, bytes.length & 255]);
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask[i % 4];
    socket.write(Buffer.concat([header, mask, bytes]));
  } };
}
async function reported(server, peer, report) {
  const record = server.record;
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Report timeout')), 3000);
      server.record = function (event) { record.call(this, event); if (event.type === 'report') { clearTimeout(timeout); resolve(event); } };
      peer.send({ protocolVersion: '1.0', type: 'report', projectId: server.projectId, runId: server.runId, ...report });
    });
  } finally { server.record = record; }
}

async function inspectionResult(server, requestId) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = (await request(server, `/inspections/${requestId}`, { admin: true, token: server.adminSecret })).json;
    if (value.status !== 'pending') return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Inspection did not settle');
}

function playerViewJournal(count = 16, last = 23n) {
  return {
    schemaVersion: 1, lastSequence: last.toString(), droppedCount: (last - BigInt(count)).toString(),
    responseTruncated: false,
    entries: Array.from({ length: count }, (_, index) => ({
      schemaVersion: 1, operation: 'resizeTexture', viewLease: '18446744073709551615',
      operationSequence: String(index + 1), retired: false, code: 'ERR_CANCELLED',
      nativeReason: 'layout-observation-superseded', controllerRole: 'accepted',
      sequence: (last - BigInt(count - 1 - index)).toString(),
    })),
  };
}
function nearInspectorByteLimit(spare) {
  const data = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`value${index}`, 'x'.repeat(1960)]));
  data.padding = '';
  const snapshot = { pages: [{ id: 1, route: 'pages/home/index', data }] };
  const length = 48 * 1024 - spare - Buffer.byteLength(JSON.stringify(sanitizeInspectorSnapshot(snapshot)));
  assert.ok(length >= 0 && length <= 2048);
  data.padding = 'x'.repeat(length);
  assert.equal(Buffer.byteLength(JSON.stringify(sanitizeInspectorSnapshot(snapshot))), 48 * 1024 - spare);
  return snapshot;
}

test('typed Player journal preserves canonical counters and independent scalar copies', () => {
  assert.equal(projectPlayerViewDiagnostics(undefined), undefined);
  const journal = playerViewJournal();
  const result = sanitizeInspectorSnapshot({ pages: [], playerViewDiagnostics: journal });
  assert.deepEqual(result.playerViewDiagnostics, journal);
  assert.notEqual(result.playerViewDiagnostics, journal);
  assert.notEqual(result.playerViewDiagnostics.entries[0], journal.entries[0]);
  journal.entries[0].code = 'ERR_MUTATED_SOURCE';
  assert.equal(result.playerViewDiagnostics.entries[0].code, 'ERR_CANCELLED');
  result.playerViewDiagnostics.entries.at(-1).code = 'ERR_MUTATED_RESPONSE';
  assert.equal(journal.entries.at(-1).code, 'ERR_CANCELLED');
  const wide = playerViewJournal(16, BigInt('9'.repeat(128)));
  wide.entries[0].code = null;
  assert.deepEqual(projectPlayerViewDiagnostics(wide), wide);
});

test('explicit initial zero journal remains distinct from legacy unavailable observation', () => {
  const empty = { schemaVersion: 1, lastSequence: '0', droppedCount: '0', responseTruncated: false, entries: [] };
  const result = sanitizeInspectorSnapshot({ pages: [], playerViewDiagnostics: empty });
  assert.deepEqual(result.playerViewDiagnostics, empty);
  assert.equal(Object.hasOwn(sanitizeInspectorSnapshot({ pages: [] }), 'playerViewDiagnostics'), false);
  assert.notEqual(result.playerViewDiagnostics, empty);
});

test('typed Player journal rejects unknown fields, invalid enums and ambiguous identifiers', () => {
  const bad = [
    ['unknown wrapper field', value => { value.privateDetails = 'must not be forwarded'; }],
    ['unknown entry field', value => { value.entries[0].rawMessage = 'Bearer must not be forwarded'; }],
    ['missing wrapper field', value => { delete value.droppedCount; }],
    ['missing entry field', value => { delete value.entries[0].retired; }],
    ['wrapper schema', value => { value.schemaVersion = 2; }],
    ['entry schema', value => { value.entries[0].schemaVersion = 2; }],
    ['entry count', value => { value.entries.push(structuredClone(value.entries.at(-1))); }],
    ['entries type', value => { value.entries = {}; }],
    ['unknown operation', value => { value.entries[0].operation = 'evaluateArbitraryCommand'; }],
    ['unknown native reason', value => { value.entries[0].nativeReason = 'private raw error'; }],
    ['unknown role', value => { value.entries[0].controllerRole = 'trusted'; }],
    ['retired type', value => { value.entries[0].retired = 'false'; }],
    ['code injection', value => { value.entries[0].code = 'ERR_CANCELLED\nBearer private'; }],
    ['code terminal newline', value => { value.entries[0].code = 'ERR_CANCELLED\n'; }],
    ['empty code suffix', value => { value.entries[0].code = 'ERR_'; }],
    ['long code suffix', value => { value.entries[0].code = 'ERR_' + 'X'.repeat(49); }],
    ['numeric lease', value => { value.entries[0].viewLease = 1; }],
    ['lease terminal newline', value => { value.entries[0].viewLease = '1\n'; }],
    ['zero lease', value => { value.entries[0].viewLease = '0'; }],
    ['overflow lease', value => { value.entries[0].viewLease = '18446744073709551616'; }],
    ['zero operation sequence', value => { value.entries[0].operationSequence = '0'; }],
    ['overflow operation sequence', value => { value.entries[0].operationSequence = '18446744073709551616'; }],
    ['duplicate sequence', value => { value.entries[1].sequence = value.entries[0].sequence; }],
    ['decreasing sequence', value => { value.entries[1].sequence = '1'; }],
    ['future sequence', value => { value.entries.at(-1).sequence = '24'; }],
    ['missing newest entry', value => { value.lastSequence = '24'; }],
    ['dropped counter beyond last', value => { value.droppedCount = '24'; }],
    ['invalid truncation flag', value => { value.responseTruncated = 1; }],
  ];
  for (const text of ['01', '-1', '+1', ' 1', '1.0', '1\n', '1\r\n', '9'.repeat(129)]) {
    bad.push([`noncanonical last counter (${text.length} characters)`, value => { value.lastSequence = text; }]);
    bad.push([`noncanonical dropped counter (${text.length} characters)`, value => { value.droppedCount = text; }]);
  }
  for (const [label, mutate] of bad) {
    const journal = playerViewJournal(); mutate(journal);
    assert.throws(() => projectPlayerViewDiagnostics(journal), { code: 'ERR_DEV_INSPECT_DATA' }, label);
  }
  assert.throws(() => projectPlayerViewDiagnostics(null), { code: 'ERR_DEV_INSPECT_DATA' });
});

test('typed Player journal is optional and guest fields never become Player observations', () => {
  const guest = { injected: 'guest-only', entries: [{ code: 'ERR_SPOOFED' }] };
  const snapshot = { pages: [{ id: 1, route: 'home', data: { playerViewDiagnostics: guest } }], state: { playerViewDiagnostics: guest } };
  const plain = sanitizeInspectorSnapshot(snapshot);
  assert.equal(Object.hasOwn(plain, 'playerViewDiagnostics'), false);
  assert.equal(Object.hasOwn(plain, 'state'), false);
  assert.deepEqual(plain.pages[0].data.playerViewDiagnostics, guest);
  const journal = playerViewJournal();
  const result = sanitizeInspectorSnapshot({ ...snapshot, playerViewDiagnostics: journal });
  assert.deepEqual(result.playerViewDiagnostics, journal);
  assert.equal(result.playerViewDiagnostics.entries[0].code, 'ERR_CANCELLED');
});

test('typed Player journal has a separate node budget and trims only its response at 48KiB', () => {
  // Exactly 2048 nodes in the existing guest copy, leaving no guest-node space
  // for an otherwise valid, independently bounded typed journal.
  const fullNodes = { pages: [{ id: 1, route: 'home', data: { items: Array(2044).fill(0) } }] };
  const journal = playerViewJournal();
  assert.equal(sanitizeInspectorSnapshot({ ...fullNodes, playerViewDiagnostics: journal }).playerViewDiagnostics.entries.length, 16);
  fullNodes.pages[0].data.items.push(0);
  assert.throws(() => sanitizeInspectorSnapshot({ ...fullNodes, playerViewDiagnostics: journal }), { code: 'ERR_DEV_INSPECT_LIMIT' });
  const partial = sanitizeInspectorSnapshot({ ...nearInspectorByteLimit(900), playerViewDiagnostics: journal });
  assert.ok(Buffer.byteLength(JSON.stringify(partial)) <= 48 * 1024);
  assert.equal(partial.playerViewDiagnostics.responseTruncated, true);
  assert.ok(partial.playerViewDiagnostics.entries.length > 0 && partial.playerViewDiagnostics.entries.length < 16);
  assert.equal(partial.playerViewDiagnostics.entries.at(-1).sequence, '23');
  assert.equal(partial.playerViewDiagnostics.droppedCount, '7');
  const base = nearInspectorByteLimit(0);
  assert.throws(() => sanitizeInspectorSnapshot({ ...base, playerViewDiagnostics: journal }), { code: 'ERR_DEV_INSPECT_LIMIT' });
  const empty = { schemaVersion: 1, lastSequence: '0', droppedCount: '0', responseTruncated: false, entries: [] };
  assert.throws(() => sanitizeInspectorSnapshot({ ...base, playerViewDiagnostics: empty }), { code: 'ERR_DEV_INSPECT_LIMIT' });
  const overhead = Buffer.byteLength(JSON.stringify(sanitizeInspectorSnapshot({ pages: [], playerViewDiagnostics: empty }))) -
    Buffer.byteLength(JSON.stringify({ pages: [] }));
  const exact = sanitizeInspectorSnapshot({ ...nearInspectorByteLimit(overhead), playerViewDiagnostics: empty });
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 48 * 1024);
  assert.deepEqual(exact.playerViewDiagnostics, empty);
  const trimmed = sanitizeInspectorSnapshot({ ...nearInspectorByteLimit(overhead), playerViewDiagnostics: journal });
  assert.deepEqual(trimmed.playerViewDiagnostics, { ...journal, responseTruncated: true, entries: [] });
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed)) <= 48 * 1024);
  assert.equal(journal.entries.length, 16);
  assert.equal(journal.responseTruncated, false);
});

test('paired inspector preserves typed View journal through WSS and authenticated HTTP', async t => {
  const { server, packs } = await fixture(t);
  await server.publish((await pack(packs, 1)).report);
  const { token } = await pair(server), peer = await reportPeer(t, server, token);
  await reported(server, peer, { generation: '1', phase: 'started' });
  const receipt = await request(server, '/inspect', { admin: true, method: 'POST', token: server.adminSecret, data: { deviceId: 'test-device' } });
  assert.equal(receipt.status, 202);
  const journal = playerViewJournal(2, 9007199254740994n);
  journal.entries[0].controllerRole = 'retired'; journal.entries[0].retired = true;
  const currentFailure = { schemaVersion: 1, sequence: '1', recordedAtMs: '1793351000000',
    phase: 'runtime', code: 'ERR_ENGINE', origin: { controllerRole: 'accepted', controllerId: '1', view: null }, observedAccepted: null };
  const failures = { schemaVersion: 1, journalId: 'f'.repeat(32), lastSequence: '1', droppedCount: '0',
    responseTruncated: false, current: currentFailure, entries: [structuredClone(currentFailure)] };
  const guest = { entries: [{ code: 'ERR_GUEST_SPOOFED' }] };
  const response = { protocolVersion: '1.0', type: 'inspect-result', requestId: receipt.json.requestId,
    projectId: server.projectId, runId: server.runId, generation: '1', status: 'ok', snapshot: {
      pages: [{ id: 1, route: 'pages/home/index', data: { count: 7, playerViewDiagnostics: guest } }],
      state: { inputEnabled: true, viewExecutionMetrics: nativeViewMetricsFixture(), playerViewDiagnostics: guest }, playerViewDiagnostics: journal, playerFailures: failures,
    } };
  const second = await pair(server, 'other-device'), other = await reportPeer(t, server, second.token);
  other.send(response);
  await new Promise(resolve => setTimeout(resolve, 20));
  const pending = await request(server, `/inspections/${receipt.json.requestId}`, { admin: true, token: server.adminSecret });
  assert.equal(pending.json.status, 'pending'); assert.equal(pending.json.snapshot, undefined);
  peer.send(response);
  const result = await inspectionResult(server, receipt.json.requestId);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.snapshot.playerViewDiagnostics, journal);
  assert.deepEqual(result.snapshot.playerFailures, failures);
  assert.deepEqual(result.snapshot.pages[0].data.playerViewDiagnostics, guest);
  assert.deepEqual(result.snapshot.state, { inputEnabled: true, viewExecutionMetrics: nativeViewMetricsFixture() });
  assert.equal(result.snapshot.state.viewExecutionMetrics.frontier.providerStages.lastBatch.boottimeStartNs, null);
  assert.equal(result.snapshot.playerViewDiagnostics.entries.at(-1).sequence, '9007199254740994');
  assert.equal(server.peers.get('test-device').accepted.generation, '1', 'diagnostics cannot change operation/health authority');
  for (const unauthorized of [undefined, token, second.token]) {
    const rejected = await request(server, `/inspections/${receipt.json.requestId}`, { admin: true, token: unauthorized });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.json.snapshot, undefined);
    assert.equal(rejected.raw.includes(Buffer.from('playerViewDiagnostics')), false);
    assert.equal(rejected.raw.includes(Buffer.from('playerFailures')), false);
  }
  assert.equal(JSON.stringify(server.history).includes('playerViewDiagnostics'), false);
  assert.equal(JSON.stringify(server.history).includes('playerFailures'), false);
  await server.publish((await pack(packs, 2)).report);
  await reported(server, peer, { generation: '2', phase: 'started' });
  const stale = await request(server, `/inspections/${receipt.json.requestId}`, { admin: true, token: server.adminSecret });
  assert.equal(stale.json.error, 'ERR_DEV_STALE_INSPECTION');
  assert.equal(stale.json.snapshot, undefined);
  assert.equal(stale.raw.includes(Buffer.from('playerViewDiagnostics')), false);
  const again = await request(server, '/inspect', { admin: true, method: 'POST', token: server.adminSecret, data: { deviceId: 'test-device' } });
  peer.send({ ...response, requestId: again.json.requestId }); // old generation
  const staleResponse = await inspectionResult(server, again.json.requestId);
  assert.equal(staleResponse.error, 'ERR_DEV_STALE_INSPECTION');
  assert.equal(staleResponse.snapshot, undefined);
});

test('authenticated inspector uses the accepted device generation and redacts one page batch', async t => {
  const { server, packs } = await fixture(t);
  await server.publish((await pack(packs, 1)).report);
  const { token } = await pair(server), peer = await reportPeer(t, server, token);
  assert.equal((await request(server, '/inspect', { admin: true, method: 'POST', token: server.adminSecret, data: { deviceId: 'test-device' } })).json.error, 'ERR_DEV_NOT_STARTED');
  await reported(server, peer, { generation: '1', phase: 'started' });
  assert.equal((await request(server, '/inspect', { admin: true, method: 'POST', data: { deviceId: 'test-device' } })).status, 401);
  const receipt = await request(server, '/inspect', { admin: true, method: 'POST', token: server.adminSecret, data: { deviceId: 'test-device' } });
  assert.equal(receipt.status, 202); assert.equal(receipt.json.status, 'pending');
  assert.equal((await request(server, '/inspect', { admin: true, method: 'POST', token: server.adminSecret, data: { deviceId: 'test-device' } })).json.error, 'ERR_DEV_INSPECT_BUSY');
  const response = { protocolVersion: '1.0', type: 'inspect-result', requestId: receipt.json.requestId, projectId: server.projectId, runId: server.runId, generation: '1', status: 'ok', snapshot: { state: { schemaVersion: 1, ownerId: '18446744073709551615', inputEnabled: true, secretNativeConfig: 'not exposed' }, pages: [{ id: 7, route: 'pages/home/index', data: { count: 9, accessToken: 'hidden', text: 'Bearer private' } }] } };
  const second = await pair(server, 'other-device'), other = await reportPeer(t, server, second.token);
  other.send(response);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(server.inspections.get(receipt.json.requestId).status, 'pending', 'a different paired device cannot fulfill this request');
  peer.send(response);
  const result = await inspectionResult(server, receipt.json.requestId);
  assert.equal(result.status, 'completed'); assert.equal(result.generation, '1');
  assert.deepEqual(result.snapshot, { pages: [{ id: 7, route: 'pages/home/index', data: { count: 9, accessToken: '[redacted]', text: '[redacted]' } }], state: { schemaVersion: 1, ownerId: '18446744073709551615', inputEnabled: true } });
  assert.equal(JSON.stringify(server.history).includes('secretNativeConfig'), false, 'snapshots never enter diagnostic history');
  await reported(server, peer, { generation: '2', phase: 'started' });
  const stale = (await request(server, `/inspections/${receipt.json.requestId}`, { admin: true, token: server.adminSecret })).json;
  assert.equal(stale.error, 'ERR_DEV_STALE_INSPECTION'); assert.equal(stale.snapshot, undefined);
});

test('inspector timeouts and stale responses cannot become success or mutate a device', async t => {
  const { server, packs } = await fixture(t); server.options.inspectorTimeoutMs = 30;
  await server.publish((await pack(packs, 1)).report);
  const { token } = await pair(server), peer = await reportPeer(t, server, token);
  await reported(server, peer, { generation: '1', phase: 'started' });
  const inspect = () => request(server, '/inspect', { admin: true, method: 'POST', token: server.adminSecret, data: { deviceId: 'test-device' } });
  let receipt = (await inspect()).json;
  assert.equal((await inspectionResult(server, receipt.requestId)).error, 'ERR_DEV_TIMEOUT');
  receipt = (await inspect()).json;
  peer.send({ protocolVersion: '1.0', type: 'inspect-result', ...receipt, runId: 'wrong-run', status: 'ok', snapshot: { pages: [] } });
  assert.equal((await inspectionResult(server, receipt.requestId)).error, 'ERR_DEV_STALE_INSPECTION');
  const invalid = await request(server, '/inspect', { admin: true, method: 'POST', token: server.adminSecret, data: { deviceId: 'test-device', op: 'pages.write' } });
  assert.equal(invalid.json.error, 'ERR_DEV_INSPECT_DATA');
  assert.throws(() => sanitizeInspectorSnapshot({ pages: [{ id: 1, route: 'home', data: { huge: 'x'.repeat(2049) } }] }), { code: 'ERR_DEV_INSPECT_LIMIT' });
});

test('TLS pin, one-use pairing, auth and protocol rejection use actual HTTPS', async t => {
  const { server } = await fixture(t);
  await assert.rejects(request(server, '/v1/project', { fingerprint: '0'.repeat(64) }), /PIN_MISMATCH/);
  assert.equal((await request(server, '/v1/project')).status, 401);
  const { token, data } = await pair(server);
  assert.equal((await request(server, '/v1/project', { token })).status, 204);
  assert.equal((await request(server, '/v1/pair', { method: 'POST', data })).status, 401);
  assert.equal((await request(server, '/v1/pair', { method: 'POST', data: { ...data, protocolVersion: '2.0' } })).status, 409);
});

test('verified generation serves exact manifest and CAS bytes; stale publish cannot replace it', async t => {
  const { server, packs } = await fixture(t), { token } = await pair(server);
  const p1 = await pack(packs, 1), p2 = await pack(packs, 2, 'new');
  assert.equal(await server.publish(p1.report), true);
  const descriptor = (await request(server, '/v1/project', { token })).json;
  assert.deepEqual(descriptor.blobs, [{ sha256: p1.hash, size: p1.blob.length }]);
  assert.deepEqual((await request(server, descriptor.manifestPath, { token })).raw, p1.raw);
  assert.deepEqual((await request(server, `/v1/blobs/${p1.hash}`, { token })).raw, p1.blob);
  assert.equal(await server.publish(p2.report), true);
  assert.equal(await server.publish(p1.report), false);
  assert.equal((await request(server, '/v1/project', { token })).json.generation, '2');
  assert.equal((await request(server, '/v1/blobs/' + 'a'.repeat(64), { token })).status, 404);
});

test('bad manifest, corrupt blob and symlink preserve last accepted pack', async t => {
  const { server, packs, root } = await fixture(t);
  const first = await pack(packs, 1); await server.publish(first.report);
  const bad = await pack(packs, 2); bad.report.manifestSha256 = '0'.repeat(64);
  await assert.rejects(server.publish(bad.report), { code: 'ERR_DEV_MANIFEST_HASH' });
  const corrupt = await pack(packs, 3); await writeFile(path.join(corrupt.report.packDirectory, 'blobs/sha256', corrupt.hash), 'corrupt');
  await assert.rejects(server.publish(corrupt.report), { code: 'ERR_DEV_BLOB_HASH' });
  const link = await pack(packs, 4); const file = path.join(link.report.packDirectory, 'blobs/sha256', link.hash);
  await rm(file); await writeFile(path.join(root, 'outside'), link.blob); await symlink(path.join(root, 'outside'), file);
  await assert.rejects(server.publish(link.report), { code: 'ERR_DEV_BLOB_PATH' });
  assert.equal(server.current.descriptor.generation, '1');
});

test('pack root escape is rejected even with matching hashes', async t => {
  const { server, root } = await fixture(t); const outside = path.join(root, 'outside'); await mkdir(outside);
  const p = await pack(outside, 1); await assert.rejects(server.publish(p.report), { code: 'ERR_DEV_PACK_ROOT' });
});

test('pair expiry and bounded failed attempts do not grant a credential', async t => {
  const { server } = await fixture(t); const ticket = new URL(server.issuePairing().uri); server.pairing.expiresAt = Date.now() - 1;
  const data = { protocolVersion: '1.0', code: ticket.searchParams.get('code'), deviceId: 'expired', name: 'x', platform: 'ios' };
  for (let i = 0; i < 5; i++) assert.equal((await request(server, '/v1/pair', { method: 'POST', data })).status, 401);
  assert.equal((await request(server, '/v1/pair', { method: 'POST', data })).status, 429);
  assert.equal(server.devices.size, 0);
});

test('developer dashboard enforces host, origin and independent owner authentication', async t => {
  const { server } = await fixture(t);
  assert.equal((await request(server, '/', { admin: true, host: 'attacker.example' })).status, 403);
  assert.equal((await request(server, '/state', { admin: true })).status, 401);
  assert.equal((await request(server, '/pair', { admin: true, method: 'POST', data: {}, token: server.adminSecret, origin: 'https://attacker.example' })).status, 403);
  const state = await request(server, '/state', { admin: true, token: server.adminSecret }); assert.equal(state.status, 200);
  const { token } = await pair(server);
  assert.equal((await request(server, '/state', { admin: true, token })).status, 401);
  const revoked = await request(server, '/revoke', { admin: true, method: 'POST', token: server.adminSecret, data: { deviceId: 'test-device' } });
  assert.equal(revoked.status, 200); assert.equal((await request(server, '/v1/project', { token })).status, 401);
});

test('certificate and credentials survive server restart, generation incarnation changes', async t => {
  const { server, options } = await fixture(t); const { token } = await pair(server);
  const fingerprint = server.identity.fingerprint, runId = server.runId;
  const stored = await readFile(server.devicesFile, 'utf8'); assert.ok(!stored.includes(token));
  await server.close(); const second = await DeviceDevServer.create(options); t.after(() => second.close());
  assert.equal(second.identity.fingerprint, fingerprint); assert.notEqual(second.runId, runId);
  assert.equal((await request(second, '/v1/project', { token })).status, 204);
});

test('actual authenticated WSS gets a bounded ready frame and shutdown closes it', async t => {
  const { server } = await fixture(t); const { token } = await pair(server);
  const url = new URL(server.endpoint);
  const socket = tls.connect({ host: url.hostname, port: Number(url.port), ca: server.identity.cert });
  t.after(() => socket.destroy()); await once(socket, 'secureConnect');
  socket.write(`GET /v1/events HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer ${token}\r\n\r\n`);
  let received = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('WSS timeout')), 3000);
    socket.on('data', part => { received = Buffer.concat([received, part]); if (received.includes(Buffer.from('"type":"ready"'))) { clearTimeout(timeout); resolve(); } }); socket.once('error', reject);
  });
  assert.match(received.toString(), /101 Switching Protocols/);
  assert.equal(server.peers.size, 1);
  server.devices.get('test-device').expiresAt = Date.now() - 1;
  server.sweepPeers();
  assert.equal(server.peers.size, 0, 'an established WSS cannot outlive its device credential');
  await server.close(); assert.equal(server.peers.size, 0); assert.equal(server.sockets.size, 0);
});

test('actual WSS maps only the accepted project/run/generation and keeps raw diagnostics', async t => {
  const { server, packs } = await fixture(t), { token } = await pair(server);
  const first = await sourceMappedPack(packs, 1, 'src/first.ts'), second = await sourceMappedPack(packs, 2, 'src/second.ts');
  await server.publish(first.report); await server.publish(second.report);
  const peer = await reportPeer(t, server, token), details = { error: { code: 'ERR_ENGINE', message: 'test', stack: 'at x (app.js:1:1)' } };
  let event = await reported(server, peer, { generation: '2', phase: 'error', details });
  assert.equal(event.sourceMapping.reason, 'unaccepted-generation');
  await reported(server, peer, { generation: '1', phase: 'started' });
  event = await reported(server, peer, { generation: '1', phase: 'error', details });
  assert.equal(event.sourceMapping.status, 'mapped'); assert.deepEqual(event.details, details);
  assert.equal(event.sourceMapping.frames[0].original.file, 'src/first.ts');
  await reported(server, peer, { generation: '2', phase: 'starting' });
  event = await reported(server, peer, { generation: '2', phase: 'log', details: { stack: 'app.js:1:1' } });
  assert.equal(event.sourceMapping.reason, 'unaccepted-generation');
  // A late presentation cannot change the accepted candidate's identity.
  await reported(server, peer, { generation: '2', phase: 'started' });
  await reported(server, peer, { generation: '2', phase: 'diagnostic', details: { code: 'NATIVE_FRAME_ACKNOWLEDGED', screenPresented: false } });
  await reported(server, peer, { generation: '2', phase: 'metrics', details: { downloadMs: 4 } });
  assert.equal(server.peers.get('test-device').phase, 'started', 'logs and telemetry do not replace app lifecycle state');
  await reported(server, peer, { generation: '1', phase: 'presented' });
  event = await reported(server, peer, { generation: '1', phase: 'error', details });
  assert.equal(event.sourceMapping.reason, 'unaccepted-generation');
  event = await reported(server, peer, { generation: '2', phase: 'error', details });
  assert.equal(event.sourceMapping.frames[0].original.file, 'src/second.ts');
  for (let revision = 3; revision <= 5; revision++) await server.publish((await pack(packs, revision)).report);
  event = await reported(server, peer, { generation: '2', phase: 'error', details });
  assert.equal(event.sourceMapping.reason, 'generation-unavailable');
});

test('actual WSS rejects a foreign project or run instead of resolving its source map', async t => {
  const { server, packs } = await fixture(t), { token } = await pair(server);
  await server.publish((await sourceMappedPack(packs, 1)).report);
  for (const values of [{ projectId: 'other-project' }, { runId: 'other-run' }]) {
    const peer = await reportPeer(t, server, token);
    const closed = once(peer.socket, 'close');
    peer.send({ protocolVersion: '1.0', type: 'report', projectId: server.projectId, runId: server.runId, generation: '1', phase: 'started', ...values });
    await closed;
    assert.equal(server.history.filter(event => event.type === 'report').length, 0);
  }
});

test('CAS map corruption rejects publication; malformed maps retain a runnable pack with explicit unmapped result', async t => {
  const { server, packs } = await fixture(t);
  const first = await sourceMappedPack(packs, 1); await server.publish(first.report);
  const corrupt = await sourceMappedPack(packs, 2); await writeFile(corrupt.mapFile, 'corrupted');
  await assert.rejects(server.publish(corrupt.report), { code: 'ERR_DEV_BLOB_HASH' });
  assert.equal(server.current.descriptor.generation, '1');
  const malformed = await sourceMappedPack(packs, 3, '/private/server/core.rs');
  assert.equal(await server.publish(malformed.report), true);
  const result = server.current.sourceMaps.resolve({ stack: 'app.js:1:1' });
  assert.equal(result.frames[0].reason, 'unsafe-source');
  assert.ok(!JSON.stringify(result).includes('core.rs'));
  // Immutable compiled tables cannot be replaced by a changed map on disk.
  await writeFile(first.mapFile, 'changed after verification');
  assert.equal(server.generations.get('1').sourceMaps.resolve({ stack: 'app.js:1:1' }).status, 'mapped');
});
