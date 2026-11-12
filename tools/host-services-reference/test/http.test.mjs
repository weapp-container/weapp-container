import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { HostServices } from '../src/service.mjs';
const policies = { profile: { purpose: 'Display the authorized profile', permissionVersion: '1' }, phone: { purpose: 'Associate the verified phone', permissionVersion: '1' } };
import { createHostServicesServer } from '../src/server.mjs';
import { referenceSignature } from '../src/crypto.mjs';

test('loopback HTTP flow enforces trust domains and processes only signed payment notifications', async t => {
  const issuerSecret = 'issuer_secret_'.repeat(4), clientSecret = 'client_secret_'.repeat(4), callbackSecret = 'callback_secret_'.repeat(4), packRoot = 'a'.repeat(64);
  const service = new HostServices({ issuerSecret, identitySecret: 'pairwise_id_secret_'.repeat(4), applications: [{ miniAppId: 'mini', hostAppId: 'host', tenantId: 'tenant', environment: 'test', identityProtocol: '1.0', clientId: 'backend', clientSecret,
    trustedPackRoots: [packRoot], allowedPaymentChannels: ['reference'], authorizationPolicies: policies }], payments: { reference: { callbackSecret } } });
  const server = createHostServicesServer(service);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, token, body, authorization) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(authorization ? { Authorization: authorization } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const identity = { hostAppId: 'host', tenantId: 'tenant', principalId: 'verified-user', principalEpoch: '1', environment: 'test', phone: '+8613800000000', profile: { nickName: 'Alice' } };
  assert.equal((await request('/v1/issuer/host-sessions', undefined, identity)).status, 401);
  const issued = await request('/v1/issuer/host-sessions', issuerSecret, identity); assert.equal(issued.status, 201);
  const host = issued.body.hostAccessToken, selection = { miniAppId: 'mini', packRoot, expectedPrincipalId: 'verified-user', expectedPrincipalEpoch: '1' };
  assert.equal((await request('/v1/host/identity-state', host, selection)).body.appLoggedIn, false);
  assert.equal((await request('/v1/host/check-session', host, selection)).status, 401);
  assert.equal((await request('/v1/host/identity-state', host, { ...selection, expectedPrincipalEpoch: '2' })).status, 403);
  const code = (await request('/v1/host/login-codes', host, selection)).body.code;
  assert.equal((await request('/v1/host/identity-state', host, selection)).body.appLoggedIn, false);
  const basic = `Basic ${Buffer.from(`backend:${clientSecret}`).toString('base64')}`;
  const exchanged = await request('/v1/apps/exchange-login', undefined, { code }, basic); assert.equal(exchanged.status, 200);
  const app = exchanged.body.accessToken;
  const active = await request('/v1/host/identity-state', host, selection);
  assert.equal(active.body.hostLoggedIn, true); assert.equal(active.body.appLoggedIn, true); assert.equal(active.body.profileAuthorized, false);
  assert.equal((await request('/v1/host/check-session', host, selection)).status, 200);
  assert.equal((await request('/v1/issuer/principal-delete', undefined, identity)).status, 401);
  assert.equal((await request('/v1/host/consents', app, { ...selection, ...policies.profile, kind: 'profile', granted: true })).status, 401);
  assert.equal((await request('/v1/apps/profile', app)).status, 403);
  assert.equal((await request('/v1/host/authorization-policy', app, { ...selection, kind: 'profile' })).status, 401);
  assert.equal((await request('/v1/host/authorization-policy', host, { ...selection, kind: 'profile', expectedPrincipalEpoch: '2' })).status, 403);
  const policy = await request('/v1/host/authorization-policy', host, { ...selection, kind: 'profile' });
  assert.deepEqual(policy.body, { kind: 'profile', ...policies.profile });
  assert.equal(policy.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/v1/host/consents', host, { ...selection, kind: 'profile', granted: true })).status, 409);
  assert.equal((await request('/v1/host/consents', host, { ...selection, ...policy.body, purpose: 'Unregistered purpose', granted: true })).status, 409);
  assert.equal((await request('/v1/host/consents', host, { ...selection, ...policy.body, granted: true })).status, 200);
  assert.deepEqual((await request('/v1/apps/profile', app)).body, { nickName: 'Alice' });
  const created = await request('/v1/payments/orders', app, { channel: 'reference', product: 'app', amount: 1, currency: 'CNY', description: 'HTTP reference', idempotencyKey: 'http-1' });
  assert.equal(created.status, 201); const order = created.body;
  assert.equal((await request(`/v1/payments/orders/${order.orderId}/launch`, host, selection)).body.launch.kind, 'reference');
  const cancelledWait = await request(`/v1/payments/orders/${order.orderId}/cancel-wait`, app, {});
  assert.equal(cancelledWait.status, 200);
  assert.equal(cancelledWait.body.status, 'pending');
  assert.equal(cancelledWait.body.clientWaitCancelled, true);
  const repeatedCancelWait = await request(`/v1/payments/orders/${order.orderId}/cancel-wait`, app, {});
  assert.equal(repeatedCancelWait.status, 200);
  assert.equal(repeatedCancelWait.body.clientWaitCancelled, true);
  const unavailableReconcile = await request(`/v1/payments/orders/${order.orderId}/reconcile`, app, {});
  assert.equal(unavailableReconcile.status, 409);
  assert.equal(unavailableReconcile.body.error, 'query_unavailable');
  const raw = JSON.stringify({ eventId: 'http-event', merchantOrderId: order.merchantOrderId, miniAppId: 'mini', amount: 1, currency: 'CNY', transactionId: 'http-tx', status: 'paid' });
  assert.equal((await fetch(base + '/v1/payments/callbacks/reference', { method: 'POST', body: raw })).status, 401);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const notify = await fetch(base + '/v1/payments/callbacks/reference', { method: 'POST', body: raw, headers: { 'x-reference-timestamp': timestamp, 'x-reference-signature': referenceSignature(callbackSecret, timestamp, raw) } });
  assert.equal(notify.status, 200); await notify.arrayBuffer();
  const final = await request(`/v1/payments/orders/${order.orderId}`, app); assert.equal(final.body.status, 'paid'); assert.equal(final.headers.get('cache-control'), 'no-store');
  for (const value of [issuerSecret, clientSecret, callbackSecret, host, app, '+8613800000000']) assert.ok(!JSON.stringify(final.body).includes(value));
  const oversized = await fetch(base + '/v1/host/login-codes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(262145) });
  assert.equal(oversized.status, 413); await oversized.arrayBuffer();
});

test('issuer principal deletion endpoint revokes credentials and requires a monotonic epoch', async t => {
  const issuerSecret = 'issuer_delete_'.repeat(4), clientSecret = 'client_delete_'.repeat(4), packRoot = 'b'.repeat(64);
  const service = new HostServices({ issuerSecret, identitySecret: 'identity_delete_'.repeat(4), applications: [{ miniAppId: 'mini', hostAppId: 'host', tenantId: 'tenant', environment: 'test', identityProtocol: '1.0', clientId: 'backend', clientSecret,
    trustedPackRoots: [packRoot], allowedPaymentChannels: [], authorizationPolicies: policies }] });
  const server = createHostServicesServer(service); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, token, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const identity = { hostAppId: 'host', tenantId: 'tenant', environment: 'test', principalId: 'delete-user', principalEpoch: '1' };
  const issued = await request('/v1/issuer/host-sessions', issuerSecret, identity);
  assert.equal(issued.status, 201);
  const host = issued.body.hostAccessToken;
  const deleted = await request('/v1/issuer/principal-delete', issuerSecret, { ...identity, principalEpoch: '2' });
  assert.equal(deleted.status, 200); assert.equal(deleted.body.deleted, true); assert.equal(deleted.body.principalEpoch, '2');
  assert.equal((await request('/v1/host/login-codes', host, { miniAppId: 'mini', packRoot })).status, 401);
  const stale = await request('/v1/issuer/principal-delete', issuerSecret, { ...identity, principalEpoch: '2' });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'stale_principal');
});

test('HTTP phone exchange requires the matching app owner session', async t => {
  const issuerSecret = 'issuer_phone_'.repeat(4), clientSecret = 'client_phone_'.repeat(4), packRoot = 'c'.repeat(64);
  const service = new HostServices({ issuerSecret, identitySecret: 'identity_phone_'.repeat(4), applications: [{ miniAppId: 'mini', hostAppId: 'host', tenantId: 'tenant', environment: 'test', identityProtocol: '1.0', clientId: 'backend', clientSecret,
    trustedPackRoots: [packRoot], allowedPaymentChannels: [], authorizationPolicies: policies }] });
  const server = createHostServicesServer(service); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); service.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, basic = `Basic ${Buffer.from(`backend:${clientSecret}`).toString('base64')}`;
  const request = async (path, token, body, authorization = basic) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : { Authorization: authorization }) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const identity = (principalId, principalEpoch = '1') => ({ hostAppId: 'host', tenantId: 'tenant', environment: 'test', principalId, principalEpoch, phone: `+861380000${principalId === 'alice' ? '0001' : '0002'}` });
  const selection = principalId => ({ miniAppId: 'mini', packRoot, expectedPrincipalId: principalId, expectedPrincipalEpoch: '1' });
  const issue = async principalId => (await request('/v1/issuer/host-sessions', undefined, identity(principalId), `Bearer ${issuerSecret}`)).body.hostAccessToken;
  const login = async (host, principalId) => {
    const code = (await request('/v1/host/login-codes', host, selection(principalId))).body.code;
    return (await request('/v1/apps/exchange-login', undefined, { code }, basic)).body.accessToken;
  };
  const aliceHost = await issue('alice'), bobHost = await issue('bob');
  const aliceApp = await login(aliceHost, 'alice'), bobApp = await login(bobHost, 'bob');
  const consent = { ...selection('alice'), kind: 'phone', ...policies.phone, granted: true };
  assert.equal((await request('/v1/host/consents', aliceHost, consent)).status, 200);
  const phoneCode = (await request('/v1/host/phone-codes', aliceHost, selection('alice'))).body.code;
  assert.equal((await request('/v1/apps/exchange-phone', undefined, { code: phoneCode })).status, 400);
  const wrongOwner = await request('/v1/apps/exchange-phone', undefined, { code: phoneCode, appAccessToken: bobApp });
  assert.equal(wrongOwner.status, 403); assert.equal(wrongOwner.body.error, 'phone_owner_mismatch');
  const correctOwner = await request('/v1/apps/exchange-phone', undefined, { code: phoneCode, appAccessToken: aliceApp });
  assert.equal(correctOwner.status, 200); assert.equal(correctOwner.body.phoneNumber, '+8613800000001');
});
