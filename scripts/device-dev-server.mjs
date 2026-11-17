import https from 'node:https';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, realpath, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalize } from '../tools/container-manifest/src/json-integrity.mjs';
import { loadIdentity, atomicPrivateJson, digest } from './lib/device-dev/identity.mjs';
import { acceptWebSocket } from './lib/device-dev/websocket.mjs';
import { createSourceMapIndex, unmappedSourceDiagnostic } from './lib/device-dev/source-maps.mjs';
import { projectInspectorState, projectDevelopmentAttempt, projectAcceptedPack } from './lib/device-dev/inspector-state.mjs';
import { projectPlayerViewDiagnostics } from './lib/device-dev/player-view-diagnostics.mjs';
import { projectPlayerFailures } from './lib/device-dev/player-failures.mjs';
import { projectPlayerRetirementDiagnostics } from './lib/device-dev/player-retirements.mjs';
import QRCode from 'qrcode';

const HASH = /^[a-f0-9]{64}$/;
const BODY_LIMIT = 65536;
const now = () => Date.now();
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (code, message = code) => Object.assign(new Error(message), { code });
const json = (res, status, value) => {
  const body = status === 204 ? '' : JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body);
};
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail('ERR_DEV_CONTENT_TYPE');
  let n = 0; const chunks = [];
  for await (const part of req) { n += part.length; if (n > BODY_LIMIT) throw fail('ERR_DEV_BODY_LIMIT'); chunks.push(part); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('ERR_DEV_JSON'); }
}
const inside = (root, file) => file.startsWith(root + path.sep);
const cleanLabel = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\x00-\x1f]/.test(value);
const INSPECT_LIMIT = 48 * 1024;
// Page data and a typed projection of passive SDK state share one bounded read.
// Credentials, storage, private native configuration and arbitrary commands do
// not cross this endpoint. Validate again at the service boundary.
export function sanitizeInspectorSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.pages) || snapshot.pages.length > 32) throw fail('ERR_DEV_INSPECT_LIMIT');
  let nodes = 0;
  const copy = (value, depth = 0) => {
    if (++nodes > 2048 || depth > 12) throw fail('ERR_DEV_INSPECT_LIMIT');
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (typeof value === 'string') {
      if (value.length > 2048) throw fail('ERR_DEV_INSPECT_LIMIT');
      return value.replace(/weapp-container:\/\/\S+|Bearer\s+\S+|(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/gi, '[redacted]');
    }
    if (Array.isArray(value)) return value.map(v => copy(v, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key.length > 256) throw fail('ERR_DEV_INSPECT_LIMIT');
      return [key, /token|password|secret|authorization|cookie|credential|private.?key|session.?key/i.test(key) ? '[redacted]' : copy(entry, depth + 1)];
    }));
    throw fail('ERR_DEV_INSPECT_DATA');
  };
  const result = { pages: snapshot.pages.map(page => {
    if (!page || !['string', 'number'].includes(typeof page.id) || typeof page.route !== 'string') throw fail('ERR_DEV_INSPECT_DATA');
    return { id: copy(page.id), route: copy(page.route), data: copy(page.data) };
  }) };
  const state = projectInspectorState(snapshot.state);
  if (state !== undefined) result.state = copy(state);
  const developmentAttempt = projectDevelopmentAttempt(snapshot.developmentAttempt);
  if (developmentAttempt !== undefined) result.developmentAttempt = copy(developmentAttempt);
  const acceptedPack = projectAcceptedPack(snapshot.acceptedPack);
  if (acceptedPack !== undefined) result.acceptedPack = copy(acceptedPack);
  if (Buffer.byteLength(JSON.stringify(result)) > INSPECT_LIMIT) throw fail('ERR_DEV_INSPECT_LIMIT');
  // This fixed, scalar journal has its own 16-entry bound. Charging it to
  // guest page nodes would reject an otherwise valid inspection. Byte limits
  // still cover the complete response, and only this projected copy is trimmed.
  const journal = projectPlayerViewDiagnostics(snapshot.playerViewDiagnostics);
  const failures = projectPlayerFailures(snapshot.playerFailures);
  const retirements = projectPlayerRetirementDiagnostics(snapshot.playerRetirementDiagnostics);
  if (journal !== undefined) result.playerViewDiagnostics = journal;
  if (failures !== undefined) result.playerFailures = failures;
  if (retirements !== undefined) result.playerRetirementDiagnostics = retirements;
  while (Buffer.byteLength(JSON.stringify(result)) > INSPECT_LIMIT) {
    // Retired failures never displace the active error. Only response copies
    // are trimmed; every journal retains its explicit coverage envelope.
    if (retirements?.entries.length) {
      retirements.entries.shift();
      retirements.responseTruncated = true;
    } else if (journal?.entries.length) {
      journal.entries.shift();
      journal.responseTruncated = true;
    } else if (failures?.entries.length) {
      failures.entries.shift();
      failures.responseTruncated = true;
    } else {
      // Current error and explicit empty envelopes are coverage metadata.
      // Preserve them or fail the existing total budget explicitly.
      throw fail('ERR_DEV_INSPECT_LIMIT');
    }
  }
  return result;
}

export class DeviceDevServer {
  static async create(options) {
    const instance = new DeviceDevServer(options);
    await instance.initialize(); return instance;
  }
  constructor(options) {
    this.options = options; this.current = null; this.generations = new Map(); this.devices = new Map();
    this.peers = new Map(); this.sockets = new Set(); this.attempts = new Map(); this.history = [];
    this.pairing = null; this.closing = false; this.publication = Promise.resolve();
    this.inspections = new Map();
    this.runId = randomBytes(16).toString('hex');
  }
  async initialize() {
    this.packRoot = await realpath(this.options.packRoot);
    this.identity = await loadIdentity(this.options.identityRoot);
    this.projectId = digest(Buffer.from(await realpath(this.options.project))).slice(0, 32);
    this.adminSecret = randomBytes(32).toString('hex');
    this.devicesFile = path.join(this.options.identityRoot, 'devices.json');
    try {
      const stored = JSON.parse(await readFile(this.devicesFile, 'utf8'));
      for (const d of stored.devices ?? []) if (HASH.test(d.tokenHash) && cleanLabel(d.id) && d.expiresAt > now()) this.devices.set(d.id, d);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.server = https.createServer({ key: this.identity.key, cert: this.identity.cert, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, (req, res) => {
      this.handle(req, res).catch(error => { if (!res.headersSent) json(res, error.code === 'ERR_DEV_UNAUTHORIZED' ? 401 : 400, { error: error.code ?? 'ERR_DEV_REQUEST' }); else res.destroy(); });
    });
    this.server.maxConnections = 64; this.server.requestTimeout = 30000; this.server.headersTimeout = 10000;
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.on('tlsClientError', () => {});
    await this.listen(this.server, this.options.port ?? 5180, this.options.host ?? '0.0.0.0');
    this.endpoint = `https://${this.options.advertiseHost.includes(':') ? `[${this.options.advertiseHost}]` : this.options.advertiseHost}:${this.server.address().port}`;
    this.admin = http.createServer((req, res) => { this.handleAdmin(req, res).catch(error => { if (!res.headersSent) json(res, 400, { error: error.code ?? 'ERR_DEV_ADMIN' }); else res.destroy(); }); });
    this.admin.maxConnections = 16; this.admin.requestTimeout = 10000; this.admin.headersTimeout = 5000;
    try { await this.listen(this.admin, this.options.adminPort ?? 5179, '127.0.0.1'); }
    catch (error) { await this.close(); throw error; }
    this.adminOrigin = `http://127.0.0.1:${this.admin.address().port}`;
    this.heartbeat = setInterval(() => this.sweepPeers(), 15000).unref();
  }
  sweepPeers() {
    for (const [id, peer] of this.peers) {
      const device = this.devices.get(id);
      if (!device || device.expiresAt <= now() || !equal(device.tokenHash, peer.tokenHash) || peer.lastSeen < now() - 60000) {
        peer.ws.close(1001); this.peers.delete(id);
      } else peer.ws.send({ protocolVersion: '1.0', type: 'heartbeat' });
    }
  }
  async listen(server, port, host) {
    server.listen(port, host); await once(server, 'listening');
  }
  issuePairing() {
    const code = randomBytes(24).toString('base64url');
    this.pairing = { hash: digest(code), expiresAt: now() + 120000 };
    const uri = new URL('weapp-container://connect');
    for (const [key, value] of Object.entries({ endpoint: this.endpoint, fingerprint: this.identity.fingerprint, code, project: this.projectId })) uri.searchParams.set(key, value);
    return { uri: uri.toString(), expiresAt: this.pairing.expiresAt };
  }
  authenticate(req) {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw fail('ERR_DEV_UNAUTHORIZED');
    const hash = digest(auth.slice(7));
    for (const device of this.devices.values()) if (device.expiresAt > now() && equal(device.tokenHash, hash)) return device;
    throw fail('ERR_DEV_UNAUTHORIZED');
  }
  async pair(req, res) {
    const address = req.socket.remoteAddress;
    // Bound failed attempts and their cardinality; no ever-growing address map.
    for (const [key, value] of this.attempts) if (value.until < now()) this.attempts.delete(key);
    const attempt = this.attempts.get(address) ?? { count: 0, until: now() + 60000 };
    if (attempt.count >= 5 || this.attempts.size >= 256) return json(res, 429, { error: 'ERR_DEV_PAIR_RATE' });
    attempt.count++; this.attempts.set(address, attempt);
    const value = await body(req);
    if (value.protocolVersion !== '1.0') return json(res, 409, { error: 'ERR_PROTOCOL_VERSION' });
    if (!cleanLabel(value.deviceId) || !cleanLabel(value.name) || !['android', 'ios', 'macos', 'windows', 'linux'].includes(value.platform)) throw fail('ERR_DEV_DEVICE');
    if (!this.pairing || this.pairing.expiresAt <= now() || !equal(this.pairing.hash, digest(String(value.code)))) throw fail('ERR_DEV_UNAUTHORIZED');
    if (!this.devices.has(value.deviceId) && this.devices.size >= 32) throw fail('ERR_DEV_DEVICE_LIMIT');
    this.pairing = null; // Single use, consumed before the first asynchronous write.
    const token = randomBytes(32).toString('base64url');
    const device = { id: value.deviceId, name: value.name, platform: value.platform, tokenHash: digest(token), expiresAt: now() + 30 * 86400000 };
    const prior = this.devices.get(device.id); this.devices.set(device.id, device);
    try { await this.saveDevices(); } catch (error) { if (prior) this.devices.set(device.id, prior); else this.devices.delete(device.id); throw error; }
    this.peers.get(device.id)?.ws.close(1008);
    json(res, 200, { protocolVersion: '1.0', deviceToken: token, projectId: this.projectId, serverId: this.identity.serverId });
  }
  saveDevices() {
    // Serialize replacements so concurrent pairing/revocation cannot restore a
    // removed credential with a late rename.
    this.deviceWrite = (this.deviceWrite ?? Promise.resolve()).catch(() => {}).then(() => atomicPrivateJson(this.devicesFile, { devices: [...this.devices.values()] }));
    return this.deviceWrite;
  }
  async handle(req, res) {
    if (this.closing) return json(res, 503, { error: 'ERR_DEV_CLOSED' });
    const url = new URL(req.url, 'https://device.invalid');
    if (req.method === 'POST' && url.pathname === '/v1/pair') return this.pair(req, res);
    this.authenticate(req);
    if (req.method !== 'GET') return json(res, 405, { error: 'ERR_DEV_METHOD' });
    if (url.pathname === '/v1/project') return json(res, this.current ? 200 : 204, this.current?.descriptor);
    const match = /^\/v1\/generations\/([1-9][0-9]*)\/manifest\.json$/.exec(url.pathname);
    if (match) {
      const generation = this.generations.get(match[1]); if (!generation) return json(res, 404, { error: 'ERR_DEV_GENERATION' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': generation.manifest.length, 'cache-control': 'private, immutable', etag: `"${generation.descriptor.manifestSha256}"` }); return res.end(generation.manifest);
    }
    const blob = /^\/v1\/blobs\/([a-f0-9]{64})$/.exec(url.pathname);
    if (blob) {
      let entry;
      for (const generation of this.generations.values()) { entry = generation.blobs.get(blob[1]); if (entry) break; }
      if (!entry) return json(res, 404, { error: 'ERR_DEV_BLOB' });
      // Open without following symlinks. Generation files belong to the build
      // supervisor; the server never serves arbitrary URL paths from disk.
      const file = await open(entry.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat(); if (!stat.isFile() || stat.size !== entry.size) throw fail('ERR_DEV_BLOB_CHANGED');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': entry.size, 'cache-control': 'private, immutable', etag: `"${blob[1]}"` });
        await pipeline(file.createReadStream({ autoClose: false }), res);
      } finally { await file.close(); }
      return;
    }
    json(res, 404, { error: 'ERR_DEV_NOT_FOUND' });
  }
  upgrade(req, socket, head) {
    try {
      if (this.closing || req.url !== '/v1/events') throw fail('ERR_DEV_NOT_FOUND');
      const device = this.authenticate(req);
      if (this.peers.size >= 16 && !this.peers.has(device.id)) throw fail('ERR_DEV_PEER_LIMIT');
      this.peers.get(device.id)?.ws.close(1001);
      let peer;
      const ws = acceptWebSocket(req, socket, head, {
        message: value => {
          const currentDevice = this.devices.get(device.id);
          if (!currentDevice || currentDevice.expiresAt <= now() || !equal(currentDevice.tokenHash, device.tokenHash)) throw fail('ERR_DEV_UNAUTHORIZED');
          if (!value || typeof value !== 'object') throw fail('ERR_DEV_MESSAGE');
          if (peer) peer.lastSeen = now();
          if (value.type === 'heartbeat') return;
          if (value.type === 'inspect-result') { this.receiveInspection(device.id, peer, value); return; }
          if (value.type !== 'report' || value.protocolVersion !== '1.0') throw fail('ERR_PROTOCOL_VERSION');
          const { generation, runId, projectId, phase, details } = value;
          if (!['connected', 'downloading', 'downloaded', 'verified', 'starting', 'started', 'presented', 'error', 'diagnostic', 'metrics', 'log'].includes(phase)) throw fail('ERR_DEV_PHASE');
          if (generation !== undefined && (!/^[1-9][0-9]{0,15}$/.test(String(generation)) || runId !== this.runId)) throw fail('ERR_DEV_GENERATION');
          if (projectId !== undefined && projectId !== this.projectId) throw fail('ERR_DEV_PROJECT');
          // Diagnostic traffic does not change the accepted app's lifecycle.
          if (peer && !['diagnostic', 'metrics', 'log'].includes(phase)) peer.phase = phase;
          // Mapping is tied to the peer's accepted instance, not the newest
          // publication or a candidate currently downloading/starting.
          const identity = generation === undefined ? null : { runId, generation: String(generation) };
          if (peer && identity && (phase === 'started' || (phase === 'presented' && (!peer.accepted || peer.accepted.generation === identity.generation)))) peer.accepted = identity;
          let sourceMapping;
          if (['error', 'diagnostic', 'log'].includes(phase)) {
            if (!identity || !peer?.accepted || peer.accepted.runId !== runId || peer.accepted.generation !== identity.generation) sourceMapping = unmappedSourceDiagnostic('unaccepted-generation');
            else {
              const accepted = this.generations.get(identity.generation);
              sourceMapping = accepted ? accepted.sourceMaps.resolve(details) : unmappedSourceDiagnostic('generation-unavailable');
            }
          }
          this.record({ type: 'report', deviceId: device.id, projectId: this.projectId, runId, generation, phase, details, ...(sourceMapping ? { sourceMapping } : {}) });
        },
        close: () => { this.cancelInspections(device.id, peer); if (this.peers.get(device.id) === peer) this.peers.delete(device.id); },
      });
      if (!ws) return;
      peer = { ws, tokenHash: device.tokenHash, lastSeen: now(), phase: 'connected' }; this.peers.set(device.id, peer);
      ws.send({ protocolVersion: '1.0', type: 'ready', serverId: this.identity.serverId, projectId: this.projectId, runId: this.runId });
      if (this.current) ws.send({ protocolVersion: '1.0', type: 'pack', runId: this.runId, generation: this.current.descriptor.generation });
    } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
  }
  record(event) { this.history.push({ ...event, timestamp: now() }); if (this.history.length > 200) this.history.shift(); }
  settleInspection(entry, status, error, snapshot) {
    if (entry.status !== 'pending') return;
    clearTimeout(entry.timer); entry.status = status; entry.error = error; entry.snapshot = snapshot;
  }
  cancelInspections(deviceId, peer) {
    for (const entry of this.inspections.values()) if (entry.deviceId === deviceId && entry.peer === peer) this.settleInspection(entry, 'error', 'ERR_DEV_DISCONNECTED');
  }
  requestInspection(deviceId) {
    const device = this.devices.get(deviceId), peer = this.peers.get(deviceId);
    if (!device || device.expiresAt <= now() || !peer || !equal(device.tokenHash, peer.tokenHash)) throw fail('ERR_DEV_DISCONNECTED');
    if (!peer.accepted) throw fail('ERR_DEV_NOT_STARTED');
    if (!this.generations.has(peer.accepted.generation)) throw fail('ERR_DEV_GENERATION');
    for (const [id, entry] of this.inspections) {
      if (entry.createdAt < now() - 60000) { this.settleInspection(entry, 'error', 'ERR_DEV_TIMEOUT'); this.inspections.delete(id); }
      else if (entry.deviceId === deviceId && entry.status === 'pending') throw fail('ERR_DEV_INSPECT_BUSY');
    }
    while (this.inspections.size >= 32) {
      const settled = [...this.inspections].find(([, entry]) => entry.status !== 'pending');
      if (!settled) throw fail('ERR_DEV_INSPECT_BUSY');
      this.inspections.delete(settled[0]);
    }
    const requestId = randomBytes(16).toString('hex');
    const entry = { requestId, deviceId, peer, projectId: this.projectId, ...peer.accepted, createdAt: now(), status: 'pending' };
    entry.timer = setTimeout(() => this.settleInspection(entry, 'error', 'ERR_DEV_TIMEOUT'), this.options.inspectorTimeoutMs ?? 5000).unref();
    this.inspections.set(requestId, entry);
    if (!peer.ws.send({ protocolVersion: '1.0', type: 'inspect-request', op: 'pages.read', requestId, projectId: entry.projectId, runId: entry.runId, generation: entry.generation })) this.settleInspection(entry, 'error', 'ERR_DEV_DISCONNECTED');
    return this.inspectionState(entry);
  }
  inspectionState(entry) {
    if (entry.status !== 'error' && (this.peers.get(entry.deviceId) !== entry.peer || entry.peer.accepted?.generation !== entry.generation || entry.peer.accepted?.runId !== entry.runId)) {
      clearTimeout(entry.timer); entry.status = 'error'; entry.error = 'ERR_DEV_STALE_INSPECTION'; entry.snapshot = undefined;
    }
    const { requestId, deviceId, projectId, runId, generation, status, error, snapshot } = entry;
    return { requestId, deviceId, projectId, runId, generation, status, ...(error ? { error } : {}), ...(snapshot ? { snapshot } : {}) };
  }
  receiveInspection(deviceId, peer, value) {
    const entry = this.inspections.get(value.requestId);
    if (!entry || entry.status !== 'pending' || entry.deviceId !== deviceId || entry.peer !== peer) return;
    if (value.protocolVersion !== '1.0' || value.projectId !== entry.projectId || value.runId !== entry.runId || value.generation !== entry.generation || peer.accepted?.generation !== entry.generation || peer.accepted?.runId !== entry.runId) return this.settleInspection(entry, 'error', 'ERR_DEV_STALE_INSPECTION');
    if (value.status !== 'ok') return this.settleInspection(entry, 'error', ['ERR_DEV_INSPECT_LIMIT', 'ERR_DEV_STALE_INSPECTION', 'ERR_DEV_INSPECT_BUSY', 'ERR_DEV_INSPECT_DATA'].includes(value.error) ? value.error : 'ERR_DEV_INSPECT_FAILED');
    try {
      const snapshot = sanitizeInspectorSnapshot(value.snapshot);
      for (const provenance of [snapshot.acceptedPack, snapshot.developmentAttempt]) {
        if (provenance && (provenance.projectId !== entry.projectId || provenance.runId !== entry.runId)) throw fail('ERR_DEV_STALE_INSPECTION');
      }
      this.settleInspection(entry, 'completed', undefined, snapshot);
    }
    catch (error) { this.settleInspection(entry, 'error', error.code ?? 'ERR_DEV_INSPECT_DATA'); }
  }
  broadcast(value) { for (const peer of this.peers.values()) peer.ws.send({ protocolVersion: '1.0', ...value }); }
  diagnostic(value) { this.record({ type: 'diagnostic', diagnostic: value }); this.broadcast({ type: 'diagnostic', diagnostic: value }); }
  publish(report) {
    const operation = this.publication.catch(() => {}).then(() => this.validatePublication(report));
    this.publication = operation; return operation;
  }
  async validatePublication(report) {
    if (!Number.isSafeInteger(report.revision) || report.revision <= 0) throw fail('ERR_DEV_REVISION');
    if (this.current && BigInt(report.revision) <= BigInt(this.current.descriptor.generation)) return false;
    const root = await realpath(report.packDirectory);
    if (!inside(this.packRoot, root)) throw fail('ERR_DEV_PACK_ROOT');
    const manifestFile = path.join(root, 'manifest.json');
    if (!(await lstat(manifestFile)).isFile() || (await lstat(manifestFile)).isSymbolicLink()) throw fail('ERR_DEV_MANIFEST');
    const raw = await readFile(manifestFile); if (raw.length > 8 * 1024 * 1024) throw fail('ERR_DEV_MANIFEST_LIMIT');
    if (digest(raw) !== report.manifestSha256) throw fail('ERR_DEV_MANIFEST_HASH');
    const manifest = JSON.parse(raw.toString('utf8'));
    if (![1, 2, 3].includes(manifest.schemaVersion) || manifest.integrity?.algorithm !== 'sha256') throw fail('ERR_INVALID_MANIFEST');
    const rootHash = digest(Buffer.from(canonicalize({ ...manifest, integrity: { algorithm: 'sha256', root: '' } })));
    if (rootHash !== manifest.integrity.root || rootHash !== report.integrityRoot) throw fail('ERR_DEV_INTEGRITY');
    const blobs = new Map(); let bytes = raw.length;
    const blobRoot = path.join(root, 'blobs', 'sha256');
    if (!inside(root, await realpath(blobRoot))) throw fail('ERR_DEV_BLOB_PATH');
    for (const entry of await readdir(blobRoot, { withFileTypes: true })) {
      if (!HASH.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw fail('ERR_DEV_BLOB_PATH');
      const file = path.join(blobRoot, entry.name), stat = await lstat(file);
      bytes += stat.size;
      if (bytes > 256 * 1024 * 1024 || blobs.size >= 10000) throw fail('ERR_DEV_PACK_LIMIT');
      if (digest(await readFile(file)) !== entry.name) throw fail('ERR_DEV_BLOB_HASH');
      blobs.set(entry.name, { file, size: stat.size });
    }
    const descriptor = { protocolVersion: '1.0', projectId: this.projectId, runId: this.runId, generation: String(report.revision), manifestSha256: report.manifestSha256, integrityRoot: report.integrityRoot,
      manifestPath: `/v1/generations/${report.revision}/manifest.json`, blobsPath: '/v1/blobs/',
      compiler: manifest.compiler, schemaVersion: manifest.schemaVersion, route: report.selectedRoute ?? null,
      blobs: [...blobs].map(([sha256, value]) => ({ sha256, size: value.size })).sort((a, b) => a.sha256.localeCompare(b.sha256)) };
    if (Buffer.byteLength(JSON.stringify(descriptor)) > 2 * 1024 * 1024) throw fail('ERR_DEV_DESCRIPTOR_LIMIT');
    const sourceMaps = await createSourceMapIndex(manifest, async (hash, limit) => {
      const entry = blobs.get(hash);
      if (!entry || entry.size > limit) throw Object.assign(new Error('source map unavailable'), { reason: entry ? 'map-budget' : 'missing-map' });
      const file = await open(entry.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== entry.size) throw fail('ERR_DEV_BLOB_CHANGED');
        // Fixed-size read prevents a concurrently growing file bypassing limits.
        const bytes = Buffer.alloc(entry.size + 1); let length = 0;
        while (length < bytes.length) {
          const read = await file.read(bytes, length, bytes.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== entry.size || digest(bytes.subarray(0, length)) !== hash) throw fail('ERR_DEV_BLOB_HASH');
        return bytes.subarray(0, length);
      } finally { await file.close(); }
    });
    if (this.closing) throw fail('ERR_DEV_CLOSED');
    this.current = { descriptor, manifest: raw, blobs, sourceMaps }; this.generations.set(descriptor.generation, this.current);
    while (this.generations.size > 3) this.generations.delete(this.generations.keys().next().value);
    this.record({ type: 'pack', generation: descriptor.generation, blobCount: blobs.size, bytes });
    this.broadcast({ type: 'pack', runId: this.runId, generation: descriptor.generation }); return true;
  }
  async handleAdmin(req, res) {
    const expected = new URL(this.adminOrigin);
    if (req.headers.host !== expected.host || (req.headers.origin && req.headers.origin !== this.adminOrigin)) return json(res, 403, { error: 'ERR_DEV_ORIGIN' });
    if (req.method === 'GET' && req.url === '/') {
      const template = await readFile(new URL('./lib/device-dev/dashboard.html', import.meta.url), 'utf8');
      const page = template.replace('__ADMIN_SECRET__', JSON.stringify(this.adminSecret));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" }); return res.end(page);
    }
    if (!equal(req.headers.authorization, `Bearer ${this.adminSecret}`)) return json(res, 401, { error: 'ERR_DEV_UNAUTHORIZED' });
    if (req.method === 'GET' && req.url === '/state') return json(res, 200, { protocolVersion: '1.0', projectId: this.projectId, endpoint: this.endpoint, project: this.current?.descriptor ?? null,
      devices: [...this.devices.values()].map(({ id, name, platform, expiresAt }) => ({ id, name, platform, expiresAt, connected: this.peers.has(id), phase: this.peers.get(id)?.phase ?? 'disconnected' })), history: this.history });
    if (req.method === 'POST' && req.url === '/pair') {
      const pairing = this.issuePairing();
      return json(res, 200, { ...pairing, qr: await QRCode.toDataURL(pairing.uri, { errorCorrectionLevel: 'M', width: 340, margin: 2 }) });
    }
    if (req.method === 'POST' && req.url === '/revoke') {
      const { deviceId } = await body(req); this.devices.delete(deviceId); this.peers.get(deviceId)?.ws.close(1008); this.peers.delete(deviceId); await this.saveDevices(); return json(res, 200, { revoked: true });
    }
    if (req.method === 'POST' && req.url === '/command') {
      const { deviceId, name } = await body(req);
      if (!['reload', 'rollback'].includes(name) || !this.peers.has(deviceId)) throw fail('ERR_DEV_COMMAND');
      this.peers.get(deviceId).ws.send({ protocolVersion: '1.0', type: 'command', name }); return json(res, 202, { queued: true });
    }
    if (req.method === 'POST' && req.url === '/inspect') {
      const value = await body(req);
      if (Object.keys(value).some(key => key !== 'deviceId')) throw fail('ERR_DEV_INSPECT_DATA');
      return json(res, 202, this.requestInspection(value.deviceId));
    }
    if (req.method === 'GET' && /^\/inspections\/[a-f0-9]{32}$/.test(req.url)) {
      const entry = this.inspections.get(req.url.split('/')[2]);
      return entry ? json(res, 200, this.inspectionState(entry)) : json(res, 404, { error: 'ERR_DEV_INSPECT_NOT_FOUND' });
    }
    json(res, 404, { error: 'ERR_DEV_NOT_FOUND' });
  }
  async close() {
    if (this.closing) return; this.closing = true; clearInterval(this.heartbeat);
    for (const entry of this.inspections.values()) clearTimeout(entry.timer);
    this.inspections.clear();
    this.broadcast({ type: 'shutdown' }); for (const peer of this.peers.values()) peer.ws.close(1001); this.peers.clear();
    const servers = [this.server, this.admin].filter(Boolean);
    const socketClosures = [...this.sockets].map(socket => new Promise(resolve => {
      if (socket.closed) resolve(); else { socket.once('close', resolve); socket.destroy(); }
    }));
    await Promise.all([...socketClosures, ...servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }))]);
    await this.publication.catch(() => {}); await this.deviceWrite?.catch(() => {});
  }
}

async function cli() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--project', '--pack-root', '--identity-root', '--host', '--port', '--admin-port', '--advertise-host'].includes(args[i]) || !args[i + 1]) throw fail('ERR_DEV_OPTIONS');
    options[args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[i + 1];
  }
  for (const key of ['project', 'packRoot', 'identityRoot']) if (!options[key]) throw fail('ERR_DEV_OPTIONS');
  for (const key of ['port', 'adminPort']) if (options[key] !== undefined) { options[key] = Number(options[key]); if (!Number.isInteger(options[key]) || options[key] < 0 || options[key] > 65535) throw fail('ERR_DEV_OPTIONS'); }
  options.advertiseHost ??= Object.values(networkInterfaces()).flat().find(v => v.family === 'IPv4' && !v.internal)?.address ?? '127.0.0.1';
  const server = await DeviceDevServer.create(options);
  process.stdout.write(JSON.stringify({ type: 'ready', endpoint: server.endpoint, dashboard: server.adminOrigin, pairing: server.issuePairing() }) + '\n');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = async () => { input.close(); await server.close(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    for await (const line of input) {
      if (Buffer.byteLength(line) > BODY_LIMIT) throw fail('ERR_DEV_CONTROL_LIMIT');
      const value = JSON.parse(line);
      if (value.type === 'publish') {
        try { const published = await server.publish(value.report); process.stdout.write(JSON.stringify({ type: 'published', revision: value.report.revision, published }) + '\n'); }
        catch (error) { server.diagnostic({ phase: 'publish', code: error.code ?? 'ERR_DEV_PUBLISH', message: 'Device pack publication rejected' }); process.stdout.write(JSON.stringify({ type: 'rejected', revision: value.report.revision, code: error.code ?? 'ERR_DEV_PUBLISH' }) + '\n'); }
      } else if (value.type === 'diagnostic') server.diagnostic(value.diagnostic);
      else if (value.type === 'shutdown') break;
      else throw fail('ERR_DEV_CONTROL');
    }
  } finally { await stop(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) cli().catch(error => { process.stderr.write((error.code ?? 'ERR_DEV_SERVER') + '\n'); process.exitCode = 1; });
