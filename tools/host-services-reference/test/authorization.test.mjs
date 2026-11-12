import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostServices } from '../src/service.mjs';

const selection = { miniAppId: 'mini', packRoot: 'a'.repeat(64), expectedPrincipalId: 'user', expectedPrincipalEpoch: '1' };
const clientSecret = 'client-secret-'.repeat(4);
const policies = {
  profile: { purpose: 'Display your profile in this miniapp', permissionVersion: '1' },
  phone: { purpose: 'Associate your verified phone with this miniapp', permissionVersion: '1' },
};
const configuration = (database, authorizationPolicies = policies) => ({
  database, issuerSecret: 'issuer-secret-'.repeat(4), identitySecret: 'identity-secret-'.repeat(4),
  applications: [{ miniAppId: 'mini', hostAppId: 'host', tenantId: 'tenant', environment: 'test',
    identityProtocol: '1.0', clientId: 'backend', clientSecret, trustedPackRoots: [selection.packRoot], authorizationPolicies }],
});
const identity = { hostAppId: 'host', tenantId: 'tenant', environment: 'test', principalId: 'user', principalEpoch: '1',
  profile: { nickName: 'Alice' }, phone: '+8613800000000' };
const code = expected => error => error.code === expected;

test('authorization requires a registered purpose and explicit confirmation of its exact version', t => {
  const service = new HostServices(configuration(':memory:'));
  t.after(() => service.close());
  const host = service.issueHostSession(identity).hostAccessToken;
  const policy = service.authorizationPolicy(host, { ...selection, kind: 'profile' });
  for (const change of [{ purpose: undefined }, { purpose: 'Another purpose' }, { permissionVersion: '2' }]) {
    assert.throws(() => service.setConsent(host, { ...selection, ...policy, ...change, granted: true }), code('authorization_policy_changed'));
  }
  assert.equal(service.identityState(host, selection).profileAuthorized, false);
  service.setConsent(host, { ...selection, ...policy, granted: true });
  assert.equal(service.identityState(host, selection).profileAuthorized, true);
  assert.equal(service.identityState(host, selection).phoneAuthorized, false);
  service.setConsent(host, { ...selection, kind: 'profile', granted: false });
  assert.equal(service.identityState(host, selection).profileAuthorized, false);
});

test('persisted grants and outstanding phone codes become invalid when purpose or permission version changes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-authorization-')), database = join(directory, 'reference.sqlite');
  let service = new HostServices(configuration(database));
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  const host = service.issueHostSession(identity).hostAccessToken;
  const app = service.exchangeLogin('backend', clientSecret, service.loginCode(host, selection).code).accessToken;
  for (const kind of ['profile', 'phone']) service.setConsent(host, { ...selection, ...service.authorizationPolicy(host, { ...selection, kind }), granted: true });
  const phone = service.phoneCode(host, selection).code, before = service.identityState(host, selection).authorizationVersion;
  service.close();
  const next = { profile: { ...policies.profile, purpose: 'A new profile purpose' }, phone: { ...policies.phone, permissionVersion: '2' } };
  service = new HostServices(configuration(database, next));
  const state = service.identityState(host, selection);
  assert.equal(state.appLoggedIn, true); assert.equal(state.profileAuthorized, false); assert.equal(state.phoneAuthorized, false);
  assert.notEqual(state.authorizationVersion, before); assert.equal(state.userInfo, undefined);
  assert.throws(() => service.profile(app), code('consent_required'));
  assert.throws(() => service.exchangePhone('backend', clientSecret, phone), code('consent_required'));
  assert.throws(() => service.setConsent(host, { ...selection, ...policies.phone, kind: 'phone', granted: true }), code('authorization_policy_changed'));
  service.setConsent(host, { ...selection, ...service.authorizationPolicy(host, { ...selection, kind: 'phone' }), granted: true });
  assert.throws(() => service.exchangePhone('backend', clientSecret, phone), code('invalid_code'));
  const fresh = service.phoneCode(host, selection).code;
  assert.equal(service.exchangePhone('backend', clientSecret, fresh).phoneNumber, identity.phone);
});

test('unconfigured authorization is unavailable while explicit revocation and silent login remain available', t => {
  const service = new HostServices(configuration(':memory:', {}));
  t.after(() => service.close());
  const host = service.issueHostSession(identity).hostAccessToken;
  assert.ok(service.loginCode(host, selection).code);
  assert.throws(() => service.authorizationPolicy(host, { ...selection, kind: 'phone' }), code('authorization_unavailable'));
  assert.throws(() => service.setConsent(host, { ...selection, ...policies.phone, kind: 'phone', granted: true }), code('authorization_unavailable'));
  assert.equal(service.setConsent(host, { ...selection, kind: 'phone', granted: false }).granted, false);
  assert.equal(service.identityState(host, selection).phoneAuthorized, false);
});
