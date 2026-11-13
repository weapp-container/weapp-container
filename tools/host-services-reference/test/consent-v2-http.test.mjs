import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostServices } from '../src/service.ts';
import { createHostServicesServer } from '../src/server.ts';

const secret = () => randomBytes(32).toString('base64url');
const decision = () => randomBytes(16).toString('base64url');
const policies = {
  profile: { purpose: 'Display the approved profile', permissionVersion: '1' },
  phone: { purpose: 'Associate the verified phone', permissionVersion: '1' },
};
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

// This loopback proxy gates real HTTP bytes, never a replacement service method.
// Before: JSON is received/parsed, but the real handler/transaction has not run.
// After: the real handler has finished and its actual response bytes are held.
// Only sequence/stage/counts are observable through gate.state().
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'weapp-consent-v2-http-'));
  const issuerSecret = secret(), clientSecret = secret(), packRoot = 'a'.repeat(64), nextPackRoot = 'b'.repeat(64);
  const service = new HostServices({ database: join(directory, 'reference.sqlite'), issuerSecret, identitySecret: secret(),
    applications: [{ miniAppId: 'mini', publisherId: 'publisher', hostAppId: 'host', tenantId: 'tenant', environment: 'develop',
      clientId: 'business', clientSecret, trustedPackRoots: [packRoot, nextPackRoot], authorizationPolicies: policies }],
  });
  const origin = createHostServicesServer(service);
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  const originUrl = `http://127.0.0.1:${origin.address().port}`;
  const pending = new Map(), gates = new Set();
  let armed, sequence = 0, closing = false;
  const proxy = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    const drained = deferred(); pending.set(controller, drained.promise);
    const cancelled = () => { if (!outgoing.writableEnded) controller.abort(); };
    incoming.once('aborted', cancelled); outgoing.once('close', cancelled);
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of incoming) {
        bytes += chunk.length;
        if (bytes > 262144) throw new Error('fixture body limit');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (raw.length) JSON.parse(raw.toString('utf8'));
      const gate = armed?.path === incoming.url ? armed : undefined;
      if (gate) armed = undefined;
      if (gate?.stage === 'before') await gate.hold(controller.signal);
      controller.signal.throwIfAborted();
      const response = await fetch(originUrl + incoming.url, {
        method: incoming.method, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(incoming.headers.authorization ? { Authorization: incoming.headers.authorization } : {}) },
        ...(incoming.method === 'GET' ? {} : { body: raw }),
      });
      const responseBytes = Buffer.from(await response.arrayBuffer());
      if (responseBytes.length > 262144) throw new Error('fixture response limit');
      if (gate?.stage === 'after') await gate.hold(controller.signal);
      controller.signal.throwIfAborted();
      outgoing.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end(responseBytes);
    } catch {
      if (!outgoing.destroyed && !outgoing.headersSent) {
        outgoing.writeHead(503, { 'Content-Type': 'application/json' });
        outgoing.end('{"error":"fixture_cancelled"}');
      }
    } finally {
      incoming.off('aborted', cancelled); outgoing.off('close', cancelled);
      pending.delete(controller); drained.resolve();
    }
  });
  proxy.requestTimeout = 5000; proxy.headersTimeout = 5000;
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const close = async () => {
    if (closing) return;
    closing = true;
    for (const gate of gates) gate.cancel();
    const drained = [...pending.values()];
    for (const controller of pending.keys()) controller.abort();
    for (const server of [proxy, origin]) {
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await stopped;
      assert.equal(server.listening, false, 'owned HTTP server closed');
    }
    await Promise.all(drained);
    assert.equal(pending.size, 0, 'all owned proxy requests drained');
    service.close(); await rm(directory, { recursive: true });
  };
  t.after(close);
  const arm = (stage, path) => {
    assert.equal(armed, undefined, 'only one armed gate');
    const reached = deferred(), released = deferred(), settled = deferred();
    let entered = false, finished = false, cancelled = false;
    const id = ++sequence;
    const finish = (cancel = false) => {
      if (finished) return;
      cancelled = cancel; finished = true; clearTimeout(timer);
      released.resolve(); gates.delete(gate);
      if (!entered) { reached.resolve(false); settled.resolve(); }
    };
    const timer = setTimeout(() => finish(true), 4000); timer.unref();
    const gate = {
      stage, path, reached: reached.promise, settled: settled.promise,
      state: () => ({ sequence: id, stage, pending: entered && !finished }),
      release: expected => { if (expected !== id) return false; finish(); return true; },
      cancel: () => finish(true),
      async hold(signal) {
        entered = true; reached.resolve(true);
        const abort = () => finish(true);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        try { await released.promise; signal.throwIfAborted(); if (cancelled) throw new Error('fixture gate cancelled'); }
        finally { signal.removeEventListener('abort', abort); clearTimeout(timer); settled.resolve(); }
      },
    };
    armed = gate; gates.add(gate); return gate;
  };
  const request = async (path, token, value, { signal, basic = false, method = 'POST', direct = false } = {}) => {
    const response = await fetch((direct ? originUrl : base) + path, { method, signal,
      headers: { 'Content-Type': 'application/json', Authorization: basic ? `Basic ${Buffer.from(`business:${clientSecret}`).toString('base64')}` : `Bearer ${token}` },
      ...(method === 'GET' ? {} : { body: JSON.stringify(value) }),
    });
    return { status: response.status, body: await response.json(), noStore: response.headers.get('cache-control') === 'no-store' };
  };
  const issue = async (principalId = 'alice', principalEpoch = '1', overrides = {}) => {
    const result = await request('/v1/issuer/host-sessions', issuerSecret, {
      hostAppId: 'host', tenantId: 'tenant', environment: 'develop', principalId, principalEpoch,
      profile: { nickName: 'Approved profile', privateField: 'never disclosed' }, phone: '+8613800000000', ...overrides,
    });
    assert.equal(result.status, 201);
    return { token: result.body.hostAccessToken, selection: { miniAppId: 'mini', packRoot, expectedPublisherId: 'publisher', expectedPrincipalId: principalId, expectedPrincipalEpoch: principalEpoch } };
  };
  const grantBody = async (owner, kind) => {
    const policy = await request('/v2/host/authorization-policy', owner.token, { ...owner.selection, kind });
    assert.equal(policy.status, 200);
    assert.equal(policy.body.identityProtocol, '2.0');
    const { challengeId, revision, purpose, permissionVersion } = policy.body;
    assert.equal(typeof challengeId, 'string');
    return { ...owner.selection, kind, granted: true, decisionId: decision(), challengeId, expectedRevision: revision, purpose, permissionVersion };
  };
  const grant = async (owner, kind) => {
    const result = await request('/v2/host/consents', owner.token, await grantBody(owner, kind));
    assert.equal(result.status, 200); return result.body.revision;
  };
  const revoke = (owner, kind) => request('/v2/host/consents', owner.token, { ...owner.selection, kind, granted: false, decisionId: decision() });
  return { service, request, issue, arm, grantBody, grant, revoke, close, nextPackRoot };
}

test('strict v2 HTTP negotiation, schema, ownership and legacy disclosure gates', { timeout: 15000 }, async t => {
  const f = await fixture(t), owner = await f.issue();
  const capabilities = await f.request('/v2/host/identity-capabilities', owner.token, owner.selection);
  assert.equal(capabilities.status, 200); assert.equal(capabilities.body.identityProtocol, '2.0');
  assert.equal(capabilities.body.consentRevision, '1.0'); assert.equal(capabilities.body.scopeSchema, '2.0');
  assert.equal(capabilities.noStore, true);
  const unknown = await f.request('/v2/host/identity-state', owner.token, { ...owner.selection, ignored: true });
  assert.equal(unknown.status, 400);
  const publisher = await f.request('/v2/host/identity-state', owner.token, { ...owner.selection, expectedPublisherId: 'other' });
  assert.equal(publisher.status, 403);
  const body = await f.grantBody(owner, 'profile');
  for (const expectedRevision of [0, '00', '-1', '18446744073709551616']) {
    assert.equal((await f.request('/v2/host/consents', owner.token, { ...body, expectedRevision })).status, 400);
  }
  assert.equal((await f.request('/v2/host/consents', owner.token, { ...owner.selection, kind: 'profile', granted: true, decisionId: decision() })).status, 428);
  assert.equal((await f.request('/v2/host/consents', owner.token, body)).status, 200, 'invalid requests did not consume the challenge');
  const legacy = { ...owner.selection }; delete legacy.expectedPublisherId;
  for (const path of ['/v1/host/profile', '/v1/host/phone-codes', '/v1/host/identity-state']) {
    const result = await f.request(path, owner.token, legacy);
    assert.equal(result.status, 426); assert.equal(result.body.error, 'identity_protocol_required');
    assert.equal(Object.hasOwn(result.body, 'userInfo'), false);
  }
  const denied = await f.request('/v1/host/consents', owner.token, { ...legacy, kind: 'profile', granted: false });
  assert.equal(denied.status, 200);
  const state = await f.request('/v2/host/identity-state', owner.token, owner.selection);
  assert.equal(state.body.profileAuthorized, false);
});

test('real HTTP stale grant held before transaction cannot resurrect a completed revoke', { timeout: 15000 }, async t => {
  const f = await fixture(t), owner = await f.issue(), body = await f.grantBody(owner, 'profile');
  const gate = f.arm('before', '/v2/host/consents');
  const pending = f.request('/v2/host/consents', owner.token, body);
  assert.equal(await gate.reached, true);
  const revoked = await f.revoke(owner, 'profile'); assert.equal(revoked.status, 200);
  assert.equal(gate.release(gate.state().sequence + 1), false, 'wrong sequence cannot release');
  assert.equal(gate.state().pending, true);
  assert.equal(gate.release(gate.state().sequence), true);
  const stale = await pending; assert.equal(stale.status, 409); assert.equal(stale.body.error, 'consent_revision_changed');
  const state = await f.request('/v2/host/identity-state', owner.token, owner.selection);
  assert.equal(state.body.profileAuthorized, false);
  assert.equal(state.body.consentRevisions.profile, revoked.body.revision);
});

test('already generated grant receipt is superseded and cannot replay old success', { timeout: 15000 }, async t => {
  const f = await fixture(t), owner = await f.issue(), body = await f.grantBody(owner, 'profile');
  const gate = f.arm('after', '/v2/host/consents');
  const pending = f.request('/v2/host/consents', owner.token, body);
  assert.equal(await gate.reached, true);
  const committed = await f.request('/v2/host/identity-state', owner.token, owner.selection);
  assert.equal(committed.body.profileAuthorized, true, 'real grant transaction completed before the gate');
  const revoked = await f.revoke(owner, 'profile'); assert.equal(revoked.status, 200);
  gate.release(gate.state().sequence);
  const old = await pending; assert.equal(old.status, 200);
  assert.ok(BigInt(old.body.revision) < BigInt(revoked.body.revision), 'held receipt retains its old revision; clients still need a fence');
  const replay = await f.request('/v2/host/consents', owner.token, body);
  assert.equal(replay.status, 409); assert.equal(replay.body.error, 'consent_decision_superseded');
  const state = await f.request('/v2/host/identity-state', owner.token, owner.selection);
  assert.equal(state.body.profileAuthorized, false);
});

test('generated profile, phone code and state keep old revisions while new reads/exchange reject', { timeout: 15000 }, async t => {
  const f = await fixture(t), owner = await f.issue();
  const login = await f.request('/v1/host/login-codes', owner.token, owner.selection);
  assert.equal(login.status, 201);
  const app = await f.request('/v1/apps/exchange-login', undefined, { code: login.body.code }, { basic: true });
  assert.equal(app.status, 200);
  const phoneRevision = await f.grant(owner, 'phone');
  for (const [path, kind] of [['/v2/host/profile', 'profile'], ['/v2/host/phone-codes', 'phone'], ['/v2/host/identity-state', 'profile']]) {
    const revision = kind === 'phone' ? phoneRevision : await f.grant(owner, kind);
    const input = { ...owner.selection, ...(path.endsWith('identity-state') ? {} : { expectedConsentRevision: revision }) };
    const gate = f.arm('after', path), pending = f.request(path, owner.token, input);
    assert.equal(await gate.reached, true);
    const revoked = await f.revoke(owner, kind); assert.equal(revoked.status, 200);
    gate.release(gate.state().sequence);
    const old = await pending; assert.ok(old.status >= 200 && old.status < 300);
    assert.equal(path.endsWith('identity-state') ? old.body.consentRevisions[kind] : old.body.revision, revision);
    const state = await f.request('/v2/host/identity-state', owner.token, owner.selection);
    assert.equal(state.body[`${kind}Authorized`], false);
    assert.equal(state.body.consentRevisions[kind], revoked.body.revision);
    if (kind === 'phone') {
      assert.equal(typeof old.body.code, 'string', 'real phone code was issued before revoke');
      const exchange = await f.request('/v2/apps/exchange-phone', undefined, { code: old.body.code, appAccessToken: app.body.accessToken }, { basic: true });
      assert.ok(exchange.status === 403 || exchange.status === 409);
      assert.equal(Object.hasOwn(exchange.body, 'phoneNumber'), false);
    } else {
      assert.equal(Object.hasOwn(old.body.userInfo, 'privateField'), false);
      const read = await f.request('/v2/host/profile', owner.token, { ...owner.selection, expectedConsentRevision: revision });
      assert.equal(read.status, 409);
    }
  }
});

test('HTTP gates drain on caller abort and fixture shutdown without retaining server resources', { timeout: 15000 }, async t => {
  const f = await fixture(t), owner = await f.issue();
  for (const stage of ['before', 'after']) {
    const gate = f.arm(stage, '/v2/host/identity-state'), controller = new AbortController();
    const result = f.request('/v2/host/identity-state', owner.token, owner.selection, { signal: controller.signal }).then(() => false, () => true);
    assert.equal(await gate.reached, true); controller.abort();
    assert.equal(await result, true); await gate.settled;
    assert.equal(gate.state().pending, false);
  }
  const gate = f.arm('after', '/v2/host/identity-state');
  const result = f.request('/v2/host/identity-state', owner.token, owner.selection).then(() => true, () => true);
  assert.equal(await gate.reached, true); await f.close();
  await gate.settled; await result;
  assert.equal(gate.state().pending, false);
});

test('v2 advertised byte bounds apply to actual serialized HTTP responses and requests', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const owner = await f.issue('large', '1', { profile: { nickName: 'x'.repeat(261900) } });
  await f.grant(owner, 'profile');
  const response = await f.request('/v2/host/identity-state', owner.token, owner.selection);
  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'response_too_large');
  assert.equal(Object.hasOwn(response.body, 'userInfo'), false, 'oversized sensitive response was not partially sent');
  assert.ok(Buffer.byteLength(JSON.stringify(response.body)) < 262144);
  const tooLarge = await f.request('/v2/host/identity-state', owner.token, { ...owner.selection, extra: 'x'.repeat(262144) }, { direct: true });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error, 'body_too_large');
});
