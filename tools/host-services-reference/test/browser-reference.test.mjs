import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { createWebIdentityReferenceFixture } from './fixtures/browser-reference.mjs';

const applications = [
  { miniAppId: 'browser-app-one', packRoot: '1'.repeat(64) },
  { miniAppId: 'browser-app-two', packRoot: '2'.repeat(64) },
];
const epoch = '9007199254740993';
const selected = host => ({ miniAppId: host.application.appId, packRoot: host.application.packRoot,
  expectedPrincipalId: host.account.principalId, expectedPrincipalEpoch: host.account.epoch });

async function setup(t, options = {}) {
  const fixture = createWebIdentityReferenceFixture({ applications, ...options }), paths = [];
  const server = createServer(async (request, response) => {
    paths.push(`${request.method} ${new URL(request.url, 'http://localhost').pathname}`);
    try {
      if (await fixture.handle(request, response)) return;
      if (request.method === 'GET' && request.url === '/host.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end('export const host = true;');
      } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(500); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`; fixture.bindOrigin(origin);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Release held responses before waiting for this fixture's server.
    await fixture.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  t.after(close);
  const request = async (path, input, token, options = {}) => {
    const response = await fetch(origin + path, { method: input === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), ...(options.signal ? { signal: options.signal } : {}) });
    const raw = await response.text(); let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    return { status: response.status, body, headers: response.headers };
  };
  const host = async (miniAppId = applications[0].miniAppId, principalId = 'alice', principalEpoch = epoch) => {
    const response = await request('/fixture/host', { miniAppId, principalId, principalEpoch }, fixture.controlToken);
    assert.equal(response.status, 201); return response.body;
  };
  const loginCode = async host => {
    const response = await request('/v1/host/login-codes', selected(host), host.hostAccessToken);
    assert.equal(response.status, 201); return response.body.code;
  };
  const login = async host => {
    const response = await request('/business/exchange', { miniAppId: host.application.appId, code: await loginCode(host) });
    assert.equal(response.status, 200); return response.body;
  };
  const consent = async (host, kind, granted) => {
    const policy = await request('/v1/host/authorization-policy', { ...selected(host), kind }, host.hostAccessToken);
    assert.equal(policy.status, 200);
    const response = await request('/v1/host/consents', { ...selected(host), ...policy.body, granted }, host.hostAccessToken);
    assert.equal(response.status, 200); return response.body;
  };
  return { fixture, origin, paths, request, host, loginCode, login, consent, close };
}

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'fixture condition settled before deadline');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('browser HTTP fixture owns only explicit routes and rejects cross-origin/control misuse', { timeout: 10000 }, async t => {
  const { fixture, origin, request } = await setup(t);
  const publicFields = Object.keys(fixture.publicConfiguration).sort();
  assert.deepEqual(publicFields, ['applications', 'referenceOnly']);
  assert.ok(fixture.publicConfiguration.applications.every(app => !Object.keys(app).some(key => /secret|token|client/i.test(key))));
  const staticFile = await request('/host.js');
  assert.equal(staticFile.status, 200); assert.equal(staticFile.body, 'export const host = true;');
  assert.equal((await request('/fixture/unknown')).status, 404);
  assert.equal((await request('/business/unknown')).status, 404);
  assert.equal((await request('/fixture/host', {})).status, 401);
  assert.equal((await request('/fixture/host', {}, fixture.controlToken, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await request('/health', undefined, undefined, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const hostRejection = await new Promise((resolve, reject) => {
    const outbound = httpRequest(origin + '/health', { headers: { Host: 'foreign.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }); outbound.on('error', reject); outbound.end();
  });
  assert.equal(hostRejection, 403);
  assert.equal((await request('/health', undefined, undefined, { headers: { Origin: origin } })).status, 200);
  assert.equal((await request('/health')).headers.get('access-control-allow-origin'), null);
  assert.throws(() => fixture.bindOrigin('http://127.0.0.1:1'), /loopback HTTP origin/);
  for (const principalEpoch of [1, '01', '0', '-1', '18446744073709551616']) {
    assert.equal((await request('/fixture/host', { miniAppId: applications[0].miniAppId, principalId: 'alice', principalEpoch }, fixture.controlToken)).status, 400);
  }
  assert.equal((await request('/fixture/host', { miniAppId: 'unknown', principalId: 'alice', principalEpoch: epoch }, fixture.controlToken)).status, 404);
  assert.equal((await request('/fixture/host', { miniAppId: applications[0].miniAppId, principalId: 'guest', principalEpoch: epoch }, fixture.controlToken)).status, 400);
  assert.equal((await request('/fixture/host', { principalId: 'alice', principalEpoch: epoch }, fixture.controlToken)).status, 404);
  assert.equal((await request('/fixture/login-delay', { action: 'unknown' }, fixture.controlToken)).status, 400);
  assert.equal(fixture.observations().activeRequests, 0);
});

test('browser business exchange uses HTTP and confidential credentials while preserving two-app/two-user isolation', { timeout: 10000 }, async t => {
  const { fixture, paths, request, host, loginCode, login } = await setup(t);
  const aliceOne = await host(), aliceTwo = await host(applications[1].miniAppId), bobOne = await host(applications[0].miniAppId, 'bob');
  assert.ok(aliceOne.account.epoch === epoch);
  const before = await request('/v1/host/check-session', selected(aliceOne), aliceOne.hostAccessToken);
  assert.equal(before.status, 401);
  const code = await loginCode(aliceOne);
  assert.equal((await request('/business/exchange', { miniAppId: applications[1].miniAppId, code })).status, 401);
  const first = await request('/business/exchange', { miniAppId: applications[0].miniAppId, code });
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body).sort(), ['appUserId', 'businessSession', 'expiresIn']);
  assert.ok(!JSON.stringify(first.body).includes(aliceOne.hostAccessToken));
  assert.equal((await request('/business/exchange', { miniAppId: applications[0].miniAppId, code })).status, 401);
  const second = await login(aliceTwo), bob = await login(bobOne);
  assert.ok(first.body.appUserId !== second.appUserId && first.body.appUserId !== bob.appUserId);
  assert.equal((await request('/v1/host/check-session', selected(aliceOne), aliceOne.hostAccessToken)).status, 200);
  for (const [businessSession, miniAppId] of [[first.body.businessSession, applications[0].miniAppId], [second.businessSession, applications[1].miniAppId], [bob.businessSession, applications[0].miniAppId]]) {
    const active = await request('/business/session', undefined, businessSession);
    assert.equal(active.status, 200); assert.equal(active.body.miniAppId, miniAppId);
    assert.deepEqual(Object.keys(active.body).sort(), ['appUserId', 'miniAppId']);
  }
  assert.equal((await request('/business/logout', { businessSession: first.body.businessSession })).status, 200);
  assert.equal((await request('/business/session', undefined, first.body.businessSession)).status, 401);
  assert.equal((await request('/business/session', undefined, second.businessSession)).status, 200);
  assert.equal((await request('/business/session', undefined, bob.businessSession)).status, 200);
  const state = await request('/v1/host/identity-state', selected(aliceOne), aliceOne.hostAccessToken);
  assert.equal(state.status, 200); assert.equal(state.body.hostLoggedIn, true); assert.equal(state.body.appLoggedIn, false);
  assert.equal(paths.filter(path => path === 'POST /v1/apps/exchange-login').length, 5);
  assert.equal(paths.filter(path => path === 'POST /v1/apps/logout').length, 1);
  assert.equal(fixture.observations().businessExchanges, 3);
});

test('browser profile and phone consent remain independent, versioned and bound to the business user', { timeout: 10000 }, async t => {
  const { paths, request, host, login, consent } = await setup(t);
  const alice = await host(), otherApp = await host(applications[1].miniAppId), bob = await host(applications[0].miniAppId, 'bob');
  const aliceSession = await login(alice), bobSession = await login(bob);
  assert.equal((await request('/v1/host/profile', selected(alice), alice.hostAccessToken)).status, 403);
  assert.equal((await request('/v1/host/phone-codes', selected(alice), alice.hostAccessToken)).status, 403);
  await consent(alice, 'profile', true);
  assert.equal((await request('/v1/host/profile', selected(alice), alice.hostAccessToken)).status, 200);
  assert.equal((await request('/v1/host/phone-codes', selected(alice), alice.hostAccessToken)).status, 403);
  await consent(alice, 'phone', true);
  const phone = await request('/v1/host/phone-codes', selected(alice), alice.hostAccessToken);
  assert.equal(phone.status, 201);
  assert.equal((await request('/business/phone', { businessSession: bobSession.businessSession, code: phone.body.code })).status, 403);
  const exchanged = await request('/business/phone', { businessSession: aliceSession.businessSession, code: phone.body.code });
  assert.equal(exchanged.status, 200); assert.ok(/^\+\d{11,15}$/.test(exchanged.body.phoneNumber));
  assert.equal((await request('/business/phone', { businessSession: aliceSession.businessSession, code: phone.body.code })).status, 401);
  const beforeRevocation = await request('/v1/host/phone-codes', selected(alice), alice.hostAccessToken);
  assert.equal(beforeRevocation.status, 201);
  await consent(alice, 'phone', false);
  assert.equal((await request('/business/phone', { businessSession: aliceSession.businessSession, code: beforeRevocation.body.code })).status, 403);
  assert.equal((await request('/v1/host/profile', selected(alice), alice.hostAccessToken)).status, 200);
  for (const owner of [otherApp, bob]) {
    const state = await request('/v1/host/identity-state', selected(owner), owner.hostAccessToken);
    assert.equal(state.body.profileAuthorized, false); assert.equal(state.body.phoneAuthorized, false);
  }
  const policy = await request('/v1/host/authorization-policy', { ...selected(alice), kind: 'phone' }, alice.hostAccessToken);
  assert.equal((await request('/v1/host/consents', { ...selected(alice), ...policy.body, permissionVersion: 'obsolete', granted: true }, alice.hostAccessToken)).status, 409);
  await consent(alice, 'profile', false);
  assert.equal((await request('/v1/host/profile', selected(alice), alice.hostAccessToken)).status, 403);
  assert.equal(paths.filter(path => path === 'POST /v1/apps/exchange-phone').length, 4);
});

test('browser code expiry and higher exact principal epoch invalidate earlier HTTP results', { timeout: 10000 }, async t => {
  let clock = Date.now();
  const { fixture, request, host, loginCode, login } = await setup(t, { now: () => clock });
  const alice = await host(), code = await loginCode(alice);
  clock += 60001;
  assert.equal((await request('/business/exchange', { miniAppId: alice.application.appId, code })).status, 401);
  const active = await login(alice), outstanding = await loginCode(alice);
  const fresh = await host(applications[0].miniAppId, 'alice', '9007199254740994');
  assert.equal((await request('/business/session', undefined, active.businessSession)).status, 401);
  assert.equal((await request('/business/exchange', { miniAppId: alice.application.appId, code: outstanding })).status, 401);
  assert.equal((await request('/v1/host/identity-state', selected(alice), alice.hostAccessToken)).status, 401);
  assert.equal((await request('/v1/host/identity-state', { ...selected(fresh), expectedPrincipalEpoch: epoch }, fresh.hostAccessToken)).status, 403);
  assert.equal((await request('/v1/host/identity-state', selected(fresh), fresh.hostAccessToken)).status, 200);
  assert.equal((await request('/fixture/host', { miniAppId: alice.application.appId, principalId: 'alice', principalEpoch: epoch }, fixture.controlToken)).status, 409);
});

test('browser business session capacity is reserved before concurrent HTTP code exchange', { timeout: 10000 }, async t => {
  const { fixture, paths, request, host, loginCode } = await setup(t);
  const alice = await host();
  // Keep socket concurrency below the OS listen backlog. The final eight
  // exchanges still race for exactly six available business session slots.
  const codes = [], exchanges = [];
  for (let offset = 0; offset < 258; offset += 16) {
    codes.push(...await Promise.all(Array.from({ length: Math.min(16, 258 - offset) }, () => loginCode(alice))));
  }
  const exchange = code => request('/business/exchange', { miniAppId: alice.application.appId, code });
  for (let offset = 0; offset < 250; offset += 16) {
    exchanges.push(...await Promise.all(codes.slice(offset, Math.min(offset + 16, 250)).map(exchange)));
  }
  exchanges.push(...await Promise.all(codes.slice(250).map(exchange)));
  assert.equal(exchanges.filter(result => result.status === 200).length, 256);
  assert.equal(exchanges.filter(result => result.status === 503).length, 2);
  assert.ok(exchanges.filter(result => result.status === 503).every(result => result.body.error === 'fixture_session_limit'));
  assert.equal(paths.filter(path => path === 'POST /v1/apps/exchange-login').length, 256);
  assert.equal(fixture.observations().businessExchanges, 256);
  assert.equal(fixture.observations().activeRequests, 0);
});

test('browser fixture holds a real issued login response until its exact control sequence is released', { timeout: 10000 }, async t => {
  const { fixture, request, host } = await setup(t);
  const alice = await host();
  const arm = await request('/fixture/login-delay', { action: 'arm' }, fixture.controlToken);
  assert.equal(arm.status, 200); assert.equal(arm.body.armed, true);
  let completed = false;
  const delayed = request('/v1/host/login-codes', selected(alice), alice.hostAccessToken).then(result => { completed = true; return result; });
  await until(() => fixture.observations().delay.issued);
  assert.equal(completed, false);
  const state = await request('/fixture/login-delay', undefined, fixture.controlToken);
  assert.equal(state.body.issued, true); assert.equal(state.body.pending, true); assert.equal('code' in state.body, false);
  assert.equal((await request('/fixture/login-delay', { action: 'arm' }, fixture.controlToken)).status, 409);
  assert.equal((await request('/fixture/login-delay', { action: 'release', sequence: arm.body.sequence + 1 }, fixture.controlToken)).status, 409);
  assert.equal(completed, false);
  assert.equal((await request('/fixture/login-delay', { action: 'release', sequence: arm.body.sequence }, fixture.controlToken)).status, 200);
  const issued = await delayed;
  assert.equal(issued.status, 201);
  assert.equal((await request('/business/exchange', { miniAppId: alice.application.appId, code: issued.body.code })).status, 200);
  const next = await request('/fixture/login-delay', { action: 'arm' }, fixture.controlToken);
  assert.ok(next.body.sequence > arm.body.sequence);
  await request('/fixture/login-delay', { action: 'release', sequence: next.body.sequence }, fixture.controlToken);
  assert.equal(fixture.observations().activeRequests, 0);
});

test('browser fixture closes a cancelled delayed HTTP response without retaining work or accepting new service calls', { timeout: 10000 }, async t => {
  const { fixture, request, host, close } = await setup(t);
  const alice = await host(), abort = new AbortController();
  await request('/fixture/login-delay', { action: 'arm' }, fixture.controlToken);
  const delayed = request('/v1/host/login-codes', selected(alice), alice.hostAccessToken, { signal: abort.signal }).then(() => false, () => true);
  await until(() => fixture.observations().delay.issued);
  abort.abort(); assert.equal(await delayed, true);
  await fixture.close();
  assert.equal(fixture.observations().activeRequests, 0);
  assert.equal(fixture.observations().delay.pending, false);
  assert.equal((await request('/health')).status, 503);
  await close();
});
