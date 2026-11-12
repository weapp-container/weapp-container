import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostServices } from '../src/service.mjs';
const policies = { profile: { purpose: 'Display the authorized profile', permissionVersion: '1' }, phone: { purpose: 'Associate the verified phone', permissionVersion: '1' } };
import { ReferenceProvider } from '../src/providers.mjs';
import { referenceSignature } from '../src/crypto.mjs';

const packRoot = 'a'.repeat(64), secret = 'app-secret-'.repeat(4), callbackSecret = 'callback-secret-'.repeat(4);
const config = database => ({ database, issuerSecret: 'issuer-secret-'.repeat(4), identitySecret: 'identity-secret-'.repeat(4),
  applications: ['first', 'second'].map(miniAppId => ({ miniAppId, identityProtocol: '1.0', clientId: `${miniAppId}-backend`, clientSecret: secret,
    hostAppId: 'host', tenantId: 'tenant', environment: 'test', trustedPackRoots: [packRoot], allowedPaymentChannels: ['reference'], authorizationPolicies: policies })),
  payments: { reference: { callbackSecret } } });
const identity = (principalId = 'user', principalEpoch = '1') => ({ hostAppId: 'host', tenantId: 'tenant', environment: 'test', principalId, principalEpoch,
  profile: { nickName: 'Alice', avatarUrl: 'https://example.test/a.png', privateEmail: 'hidden@example.test' }, phone: '+8613800000000' });
const selection = miniAppId => ({ miniAppId, packRoot });
const input = (idempotencyKey = 'request-1') => ({ idempotencyKey, channel: 'reference', product: 'app', amount: 123, currency: 'CNY', description: 'A backend-owned order' });
const errorCode = code => error => error.code === code;
function fixture(t, options = {}) {
  let time = 1790000000000;
  if (options.providers) for (const provider of Object.values(options.providers)) provider.now = () => time;
  const service = new HostServices(config(options.database), { now: () => time, ...options });
  t.after(() => service.close());
  const host = service.issueHostSession(identity()).hostAccessToken;
  const login = (miniAppId = 'first', hostToken = host) => {
    const { code } = service.loginCode(hostToken, selection(miniAppId));
    return service.exchangeLogin(`${miniAppId}-backend`, secret, code).accessToken;
  };
  const callback = (order, overrides = {}, rawOverride) => {
    const raw = rawOverride ?? JSON.stringify({ eventId: 'event-1', merchantOrderId: order.merchantOrderId, amount: order.amount,
      currency: order.currency, miniAppId: 'first', transactionId: 'tx-1', status: 'paid', ...overrides });
    const timestamp = String(Math.floor(time / 1000));
    return service.notification('reference', { 'x-reference-timestamp': timestamp, 'x-reference-signature': referenceSignature(callbackSecret, timestamp, raw) }, raw);
  };
  return { service, host, login, callback, advance: amount => { time += amount; } };
}

test('login codes are short-lived, single-use, app-specific, and a failed cross-app exchange does not consume them', t => {
  const { service, host, advance } = fixture(t);
  const { code } = service.loginCode(host, selection('first'));
  assert.throws(() => service.exchangeLogin('first-backend', 'bad-secret', code), errorCode('invalid_client'));
  assert.throws(() => service.exchangeLogin('second-backend', secret, code), errorCode('invalid_code'));
  const result = service.exchangeLogin('first-backend', secret, code);
  assert.equal(result.tokenType, 'Bearer'); assert.ok(result.appUserId);
  assert.throws(() => service.exchangeLogin('first-backend', secret, code), errorCode('invalid_code'));
  const expiring = service.loginCode(host, selection('first')); advance(61000);
  assert.throws(() => service.exchangeLogin('first-backend', secret, expiring.code), errorCode('invalid_code'));
});

test('host scope and verified installed pack are checked; pairwise app IDs differ', t => {
  const { service, host, login } = fixture(t);
  assert.throws(() => service.loginCode(host, { miniAppId: 'first', packRoot: 'b'.repeat(64) }), errorCode('untrusted_pack'));
  const wrongHost = service.issueHostSession({ ...identity('other'), tenantId: 'another-tenant' }).hostAccessToken;
  assert.throws(() => service.loginCode(wrongHost, selection('first')), errorCode('app_scope_mismatch'));
  const ids = ['first', 'second'].map(app => service.exchangeLogin(`${app}-backend`, secret, service.loginCode(host, selection(app)).code).appUserId);
  assert.notEqual(ids[0], ids[1]); assert.ok(login());
});

test('silent host reuse grants neither profile nor phone; consent is separate per app and disclosure is whitelisted', t => {
  const { service, host, login } = fixture(t), first = login(), second = login('second');
  assert.throws(() => service.profile(first), errorCode('consent_required'));
  assert.throws(() => service.phoneCode(host, selection('first')), errorCode('consent_required'));
  assert.throws(() => service.setConsent(first, { ...selection('first'), ...policies.profile, kind: 'profile', granted: true }), errorCode('invalid_host_session'));
  service.setConsent(host, { ...selection('first'), ...policies.profile, kind: 'profile', granted: true });
  assert.deepEqual(service.profile(first), { nickName: 'Alice', avatarUrl: 'https://example.test/a.png' });
  assert.throws(() => service.profile(second), errorCode('consent_required'));
  assert.throws(() => service.phoneCode(host, selection('first')), errorCode('consent_required'));
  service.setConsent(host, { ...selection('first'), ...policies.phone, kind: 'phone', granted: true });
  const { code } = service.phoneCode(host, selection('first'));
  assert.throws(() => service.exchangePhone('second-backend', secret, code), errorCode('invalid_code'));
  assert.deepEqual(service.exchangePhone('first-backend', secret, code), { phoneNumber: '+8613800000000' });
  assert.throws(() => service.exchangePhone('first-backend', secret, code), errorCode('invalid_code'));
});

test('identity state requires a redeemed live app session and leaks no host identity or unauthorized profile', t => {
  const { service, host, advance } = fixture(t);
  const before = service.identityState(host, selection('first'));
  assert.equal(before.hostLoggedIn, true); assert.equal(before.appLoggedIn, false);
  assert.equal(before.userInfo, undefined); assert.equal(before.principalId, undefined);
  assert.throws(() => service.checkSession(host, selection('first')), errorCode('invalid_app_session'));
  const { code } = service.loginCode(host, selection('first'));
  assert.equal(service.identityState(host, selection('first')).appLoggedIn, false);
  service.exchangeLogin('first-backend', secret, code);
  assert.deepEqual(service.checkSession(host, selection('first')), { valid: true });
  assert.equal(service.identityState(host, selection('second')).appLoggedIn, false);
  service.setConsent(host, { ...selection('first'), ...policies.profile, kind: 'profile', granted: true });
  const after = service.identityState(host, selection('first'));
  assert.equal(after.profileAuthorized, true); assert.equal(after.phoneAuthorized, false);
  assert.deepEqual(after.userInfo, { nickName: 'Alice', avatarUrl: 'https://example.test/a.png' });
  assert.notEqual(after.authorizationVersion, before.authorizationVersion);
  service.setConsent(host, { ...selection('first'), kind: 'profile', granted: false });
  assert.equal(service.identityState(host, selection('first')).userInfo, undefined);
  advance(3600001);
  assert.throws(() => service.checkSession(host, selection('first')), errorCode('invalid_host_session'));
});

test('native account selection rejects a bearer for another principal or epoch', t => {
  const { service, host } = fixture(t);
  const matching = { ...selection('first'), expectedPrincipalId: 'user', expectedPrincipalEpoch: '1' };
  assert.ok(service.loginCode(host, matching).code);
  for (const changed of [{ expectedPrincipalId: 'other' }, { expectedPrincipalEpoch: '2' }]) {
    const mismatched = { ...matching, ...changed };
    assert.throws(() => service.loginCode(host, mismatched), errorCode('host_identity_mismatch'));
    assert.throws(() => service.identityState(host, mismatched), errorCode('host_identity_mismatch'));
    assert.throws(() => service.setConsent(host, { ...mismatched, ...policies.profile, kind: 'profile', granted: true }), errorCode('host_identity_mismatch'));
  }
});

test('app logout revokes all same-principal sibling host sessions without revoking another principal or app', t => {
  const { service, host, login } = fixture(t);
  const sibling = service.issueHostSession(identity()).hostAccessToken;
  const unrelated = service.issueHostSession(identity('other')).hostAccessToken;
  const app = login(), siblingApp = login('first', sibling), otherApp = login('second', sibling), otherPrincipal = login('first', unrelated);
  const code = service.loginCode(sibling, selection('first')).code;
  service.logoutAppForHost(host, selection('first'));
  for (const token of [app, siblingApp]) assert.throws(() => service.session(token), errorCode('invalid_app_session'));
  assert.throws(() => service.exchangeLogin('first-backend', secret, code), errorCode('invalid_code'));
  assert.equal(service.identityState(sibling, selection('first')).appLoggedIn, false);
  assert.ok(service.session(otherApp)); assert.ok(service.session(otherPrincipal)); assert.ok(service.host(sibling));
});

test('consent revocation blocks profile and pending phone codes; re-grant cannot revive the old phone code', t => {
  const { service, host, login } = fixture(t), app = login();
  for (const kind of ['profile', 'phone']) service.setConsent(host, { ...selection('first'), ...policies[kind], kind, granted: true });
  const { code } = service.phoneCode(host, selection('first'));
  for (const kind of ['profile', 'phone']) service.setConsent(host, { ...selection('first'), kind, granted: false });
  assert.throws(() => service.profile(app), errorCode('consent_required'));
  assert.throws(() => service.exchangePhone('first-backend', secret, code), errorCode('consent_required'));
  service.setConsent(host, { ...selection('first'), ...policies.phone, kind: 'phone', granted: true });
  assert.throws(() => service.exchangePhone('first-backend', secret, code), errorCode('invalid_code'));
});

test('app logout revokes sibling sessions/codes for that app but retains host login and the other app', t => {
  const { service, host, login } = fixture(t), app = login(), sibling = login(), other = login('second');
  const code = service.loginCode(host, selection('first')).code;
  service.logoutApp(app);
  assert.throws(() => service.session(sibling), errorCode('invalid_app_session'));
  assert.throws(() => service.exchangeLogin('first-backend', secret, code), errorCode('invalid_code'));
  assert.ok(service.session(other)); assert.ok(login());
});

test('host logout and monotonic principal epochs invalidate descendant sessions/codes', t => {
  const { service, host, login } = fixture(t), app = login();
  service.logoutHost(host);
  assert.throws(() => service.session(app), errorCode('invalid_host_session'));
  const newHost = service.issueHostSession(identity()).hostAccessToken, active = login('first', newHost);
  const code = service.loginCode(newHost, selection('first')).code;
  service.revokePrincipal({ ...identity(), principalEpoch: '2' });
  assert.throws(() => service.session(active), errorCode('stale_principal'));
  assert.throws(() => service.exchangeLogin('first-backend', secret, code), errorCode('stale_principal'));
  assert.throws(() => service.issueHostSession(identity()), errorCode('stale_principal'));
  assert.throws(() => service.revokePrincipal(identity()), errorCode('stale_principal'));
  assert.ok(service.issueHostSession(identity('user', '2')).hostAccessToken);
});

test('principal deletion removes all local account data, invalidates old credentials, and preserves another principal', async t => {
  const { service, host, login, callback } = fixture(t), app = login();
  service.setConsent(host, { ...selection('first'), ...policies.profile, kind: 'profile', granted: true });
  service.setConsent(host, { ...selection('first'), ...policies.phone, kind: 'phone', granted: true });
  const phoneCode = service.phoneCode(host, selection('first')).code;
  const pendingLoginCode = service.loginCode(host, selection('first')).code;
  const order = await service.createOrder(app, input('delete-me'));
  const otherHost = service.issueHostSession(identity('other')).hostAccessToken;
  const otherApp = login('first', otherHost);
  const deleted = service.deletePrincipal({ ...identity(), principalEpoch: '2' });
  assert.deepEqual(deleted, { deleted: true, principalEpoch: '2', removed: { hosts: 1, orders: 1, consents: 2 } });
  assert.throws(() => service.host(host), errorCode('invalid_host_session'));
  assert.throws(() => service.session(app), errorCode('invalid_app_session'));
  assert.throws(() => service.exchangeLogin('first-backend', secret, pendingLoginCode), errorCode('invalid_code'));
  assert.throws(() => service.exchangePhone('first-backend', secret, phoneCode), errorCode('invalid_code'));
  assert.throws(() => service.getOrder(app, order.orderId), errorCode('invalid_app_session'));
  assert.throws(() => callback(order), errorCode('unknown_order'));
  assert.ok(service.host(otherHost));
  assert.ok(service.session(otherApp));
  const replacement = service.issueHostSession(identity('user', '2')).hostAccessToken;
  const replacementCode = service.loginCode(replacement, selection('first')).code;
  const replacementApp = service.exchangeLogin('first-backend', secret, replacementCode).accessToken;
  assert.throws(() => service.profile(replacementApp), errorCode('consent_required'));
  assert.throws(() => service.deletePrincipal({ ...identity(), principalEpoch: '2' }), errorCode('stale_principal'));
});

test('epoch transport preserves full u64 decimal values and rejects numeric or overflowing epochs', t => {
  const { service } = fixture(t);
  assert.ok(service.issueHostSession(identity('large-user', '18446744073709551615')));
  for (const value of [1, '0', '18446744073709551616', '01', '-1']) assert.throws(() => service.issueHostSession(identity('invalid', value)), errorCode('invalid_request'));
});

test('native profile/app-logout endpoints enforce matching installation and existing consent without app secrets', t => {
  const { service, host, login } = fixture(t), app = login();
  assert.throws(() => service.hostProfile(host, selection('first')), errorCode('consent_required'));
  service.setConsent(host, { ...selection('first'), ...policies.profile, kind: 'profile', granted: true });
  assert.deepEqual(service.hostProfile(host, selection('first')), service.profile(app));
  assert.throws(() => service.hostProfile(host, { miniAppId: 'first', packRoot: '0'.repeat(64) }), errorCode('untrusted_pack'));
  service.logoutAppForHost(host, selection('first'));
  assert.throws(() => service.profile(app), errorCode('invalid_app_session')); assert.ok(login());
});

test('concurrent idempotent create reserves one provider order and rejects changed payloads', async t => {
  let finish, calls = 0;
  const provider = new ReferenceProvider({ callbackSecret });
  provider.create = async () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const { service, login } = fixture(t, { providers: { reference: provider } }), app = login();
  const first = service.createOrder(app, input());
  const waiting = await service.createOrder(app, input());
  assert.equal(waiting.submission, 'submitting'); assert.equal(calls, 1);
  finish({ launch: { kind: 'reference', orderId: waiting.orderId }, status: 'pending' });
  const completed = await first;
  assert.equal(completed.orderId, waiting.orderId);
  assert.equal((await service.createOrder(app, input())).orderId, completed.orderId); assert.equal(calls, 1);
  await assert.rejects(service.createOrder(app, { ...input(), amount: 124 }), errorCode('idempotency_conflict'));
});

test('orders are isolated by app, principal and epoch; native launch checks pack identity', async t => {
  const { service, host, login } = fixture(t), app = login(), otherApp = login('second');
  const order = await service.createOrder(app, input());
  assert.throws(() => service.getOrder(otherApp, order.orderId), errorCode('order_forbidden'));
  const otherHost = service.issueHostSession(identity('another-user')).hostAccessToken, otherUser = login('first', otherHost);
  assert.throws(() => service.getOrder(otherUser, order.orderId), errorCode('order_forbidden'));
  assert.throws(() => service.launchForHost(otherHost, order.orderId, selection('first')), errorCode('order_forbidden'));
  assert.throws(() => service.launchForHost(host, order.orderId, { miniAppId: 'first', packRoot: '0'.repeat(64) }), errorCode('untrusted_pack'));
  assert.equal(service.launchForHost(host, order.orderId, selection('first')).launch.kind, 'reference');
});

test('callback signatures, ownership, amount and replay binding are required; duplicate fulfillment is suppressed', async t => {
  const { service, login, callback } = fixture(t), app = login(), order = await service.createOrder(app, input());
  const raw = JSON.stringify({});
  assert.throws(() => service.notification('reference', { 'x-reference-timestamp': '1', 'x-reference-signature': 'x' }, raw), errorCode('invalid_signature'));
  assert.throws(() => callback(order, { amount: 124 }), errorCode('payment_mismatch'));
  assert.throws(() => callback(order, { miniAppId: 'second' }), errorCode('payment_mismatch'));
  assert.equal(callback(order).becamePaid, true);
  assert.equal(callback(order).duplicate, true);
  assert.equal(callback(order, { eventId: 'event-2' }).becamePaid, false);
  assert.throws(() => callback(order, { amount: 124 }), errorCode('event_conflict'));
  assert.throws(() => callback(order, { eventId: 'event-3', transactionId: 'another-tx' }), errorCode('payment_mismatch'));
  assert.equal(service.getOrder(app, order.orderId).status, 'paid');
});

test('cancel waiting never cancels the trade, and later or reordered callbacks preserve paid', async t => {
  const { service, login, callback } = fixture(t), app = login(), order = await service.createOrder(app, input());
  assert.equal(service.cancelWait(app, order.orderId).status, 'pending');
  callback(order); callback(order, { eventId: 'event-closed', status: 'closed' });
  const final = service.getOrder(app, order.orderId);
  assert.equal(final.status, 'paid'); assert.equal(final.clientWaitCancelled, true);
});

test('callback arriving before create response is never overwritten', async t => {
  let complete;
  const provider = new ReferenceProvider({ callbackSecret });
  provider.create = async order => new Promise(resolve => { complete = () => resolve({ launch: { kind: 'reference', orderId: order.id } }); });
  const { service, login, callback } = fixture(t, { providers: { reference: provider } }), app = login();
  const pending = service.createOrder(app, input()), order = await service.createOrder(app, input());
  callback(order); complete();
  assert.equal((await pending).status, 'paid');
});

test('uncertain submissions retain the merchant order and never resubmit blindly', async t => {
  let calls = 0;
  const provider = new ReferenceProvider({ callbackSecret });
  provider.create = async () => { calls++; throw new Error('transport timeout'); };
  const { service, login, callback } = fixture(t, { providers: { reference: provider } }), app = login();
  await assert.rejects(service.createOrder(app, input()), errorCode('payment_submission_uncertain'));
  const existing = await service.createOrder(app, input()); assert.equal(existing.submission, 'uncertain'); assert.equal(calls, 1);
  callback(existing); assert.equal(service.getOrder(app, existing.orderId).status, 'paid');
});

test('database reopen retains sessions, idempotency reservations and verified callback deduplication', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'host-services-')), database = join(directory, 'service.sqlite');
  let service = new HostServices(config(database));
  try {
    const host = service.issueHostSession(identity()).hostAccessToken;
    const app = service.exchangeLogin('first-backend', secret, service.loginCode(host, selection('first')).code).accessToken;
    const order = await service.createOrder(app, input());
    const raw = JSON.stringify({ eventId: 'persisted-event', merchantOrderId: order.merchantOrderId, miniAppId: 'first', amount: 123, currency: 'CNY', transactionId: 'persisted-tx', status: 'paid' });
    const timestamp = String(Math.floor(Date.now() / 1000)), headers = { 'x-reference-timestamp': timestamp, 'x-reference-signature': referenceSignature(callbackSecret, timestamp, raw) };
    service.notification('reference', headers, raw); service.close(); service = new HostServices(config(database));
    assert.equal((await service.createOrder(app, input())).orderId, order.orderId);
    assert.equal(service.getOrder(app, order.orderId).status, 'paid');
    assert.equal(service.notification('reference', headers, raw).duplicate, true);
    const exposed = JSON.stringify(service.getOrder(app, order.orderId));
    for (const value of [secret, callbackSecret, 'user', host, app]) assert.ok(!exposed.includes(value));
  } finally { service.close(); rmSync(directory, { recursive: true, force: true }); }
});
