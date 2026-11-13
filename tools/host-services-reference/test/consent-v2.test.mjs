import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostServices } from '../src/service.ts';
import { digest } from '../src/crypto.ts';

const decision = () => randomBytes(16).toString('base64url');
const policies = { profile: { purpose: 'Display the public profile', permissionVersion: '1' }, phone: { purpose: 'Associate the verified phone', permissionVersion: '1' } };
const identity = { hostAppId: 'host', tenantId: 'tenant', environment: 'test', principalId: 'alice', principalEpoch: '1',
  profile: { nickName: 'Alice', avatarUrl: 'https://example.test/alice.png', secret: 'not public' }, phone: '+8613800000000' };
const packRoot = 'a'.repeat(64), nextPack = 'b'.repeat(64), clientSecret = 'client-secret-'.repeat(4);
const selection = { miniAppId: 'mini', packRoot, expectedPrincipalId: 'alice', expectedPrincipalEpoch: '1', expectedPublisherId: 'publisher' };
const configuration = (database = ':memory:', changes = {}) => ({ database, issuerSecret: 'issuer-secret-'.repeat(4), identitySecret: 'identity-secret-'.repeat(4),
  applications: [{ miniAppId: 'mini', publisherId: 'publisher', hostAppId: 'host', tenantId: 'tenant', environment: 'test',
    clientId: 'business', clientSecret, trustedPackRoots: [packRoot, nextPack], authorizationPolicies: policies, ...changes }] });
const fails = (expected, status) => error => error.code === expected && (status === undefined || error.status === status);
function fixture(t, config = configuration(), options = {}) {
  const service = new HostServices(config, options); t.after(() => service.close());
  const host = service.issueHostSession(identity).hostAccessToken;
  const app = service.exchangeLogin('business', clientSecret, service.loginCode(host, selection).code).accessToken;
  const policy = (kind = 'profile', selected = selection, token = host) => service.authorizationPolicyV2(token, { ...selected, kind });
  const request = (challenge, selected = selection) => ({ ...selected, kind: challenge.kind, granted: true, decisionId: decision(),
    challengeId: challenge.challengeId, expectedRevision: challenge.revision, purpose: challenge.purpose, permissionVersion: challenge.permissionVersion });
  const grant = kind => service.setConsentV2(host, request(policy(kind)));
  const revoke = kind => service.setConsentV2(host, { ...selection, kind, granted: false, decisionId: decision() });
  return { service, host, app, policy, request, grant, revoke };
}

test('v2 defaults require a publisher and every trusted selection field; legacy cannot downgrade strict registration', t => {
  assert.throws(() => new HostServices(configuration(':memory:', { publisherId: undefined })), fails('invalid_request'));
  const f = fixture(t);
  assert.deepEqual(f.service.identityCapabilitiesV2(f.host, selection), { identityProtocol: '2.0', consentRevision: '1.0', scopeSchema: '2.0', kinds: ['profile', 'phone'], maxRequestBytes: 262144, maxResponseBytes: 262144 });
  for (const name of Object.keys(selection)) {
    const value = { ...selection }; delete value[name];
    assert.throws(() => f.service.identityCapabilitiesV2(f.host, value), fails('invalid_request'));
  }
  assert.throws(() => f.service.identityCapabilitiesV2(f.host, { ...selection, expectedPublisherId: 'other' }), fails('publisher_identity_mismatch', 403));
  assert.throws(() => f.service.identityStateV2(f.host, { ...selection, guessed: true }), fails('invalid_request'));
  for (const call of [() => f.service.authorizationPolicy(f.host, { ...selection, kind: 'profile' }), () => f.service.identityState(f.host, selection),
    () => f.service.setConsent(f.host, { ...selection, ...policies.profile, kind: 'profile', granted: true }), () => f.service.profile(f.app),
    () => f.service.hostProfile(f.host, selection), () => f.service.phoneCode(f.host, selection), () => f.service.exchangePhone('business', clientSecret, 'unused')]) {
    assert.throws(call, fails('identity_protocol_required', 426));
  }
  assert.deepEqual(f.service.checkSession(f.host, selection), { valid: true });
  assert.equal(f.service.setConsent(f.host, { ...selection, kind: 'profile', granted: false }).revision, '1');
});

test('v2 grants atomically consume hashed challenges, replay identical decisions and reject superseded grants', t => {
  const f = fixture(t, configuration(), { now: () => 1000000 }), input = f.request(f.policy());
  assert.equal(f.service.db.prepare('SELECT id FROM consent_challenges_v2').get().id, digest(input.challengeId));
  const receipt = f.service.setConsentV2(f.host, input);
  assert.equal(receipt.revision, '1');
  assert.deepEqual(f.service.setConsentV2(f.host, { ...input }), receipt);
  assert.throws(() => f.service.setConsentV2(f.host, { ...input, purpose: 'changed' }), fails('consent_decision_conflict', 409));
  assert.throws(() => f.service.setConsentV2(f.host, { ...input, decisionId: decision() }), fails('invalid_consent_challenge', 401));
  assert.deepEqual(f.service.hostProfileV2(f.host, { ...selection, expectedConsentRevision: '1' }).userInfo, { nickName: 'Alice', avatarUrl: identity.profile.avatarUrl });
  const revoke = { ...selection, kind: 'profile', granted: false, decisionId: decision() };
  assert.equal(f.service.setConsentV2(f.host, revoke).revision, '2');
  assert.equal(f.service.setConsentV2(f.host, revoke).revision, '2');
  assert.throws(() => f.service.setConsentV2(f.host, input), fails('consent_decision_superseded', 409));
  assert.equal(f.service.identityStateV2(f.host, selection).profileAuthorized, false);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM consent_changes_v2').get().n, 2);
  const events = f.service.db.prepare('SELECT revision,granted,decision_id FROM consent_changes_v2 ORDER BY sequence').all();
  assert.deepEqual(events.map(e => [e.revision, e.granted]), [['1', 1], ['2', 0]]);
});

test('v2 revoke supersedes outstanding UI decisions without advancing another kind', t => {
  const f = fixture(t), stale = f.request(f.policy());
  f.grant('phone');
  assert.equal(f.revoke('profile').revision, '1');
  assert.throws(() => f.service.setConsentV2(f.host, stale), fails('consent_revision_changed', 409));
  assert.equal(f.service.db.prepare('SELECT consumed FROM consent_challenges_v2 WHERE id=?').get(digest(stale.challengeId)).consumed, 0);
  const state = f.service.identityStateV2(f.host, selection);
  assert.deepEqual(state.consentRevisions, { profile: '1', phone: '1' });
  assert.equal(state.profileAuthorized, false); assert.equal(state.phoneAuthorized, true);
  assert.equal(f.grant('profile').revision, '2');
});

test('v2 rejects missing preconditions, noncanonical u64 strings and revision overflow without partial writes', t => {
  const f = fixture(t), input = f.request(f.policy());
  for (const name of ['challengeId', 'expectedRevision']) { const value = { ...input }; delete value[name]; assert.throws(() => f.service.setConsentV2(f.host, value), fails('consent_precondition_required', 428)); }
  for (const value of [0, 1, -1, null, '', '00', '+1', '-1', '1.0', '18446744073709551616']) {
    assert.throws(() => f.service.setConsentV2(f.host, { ...input, expectedRevision: value }), fails('invalid_request'));
    assert.throws(() => f.service.hostProfileV2(f.host, { ...selection, expectedConsentRevision: value }), fails('invalid_request'));
  }
  f.service.db.prepare("UPDATE consent_states_v2 SET revision='9007199254740993' WHERE kind='profile'").run();
  assert.equal(f.revoke('profile').revision, '9007199254740994');
  f.service.db.prepare("UPDATE consent_states_v2 SET revision='18446744073709551615' WHERE kind='profile'").run();
  const before = f.service.db.prepare('SELECT COUNT(*) AS n FROM consent_changes_v2').get().n;
  assert.throws(() => f.revoke('profile'), fails('consent_revision_exhausted', 409));
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM consent_changes_v2').get().n, before);
  assert.equal(f.service.identityStateV2(f.host, selection).consentRevisions.profile, '18446744073709551615');
  assert.equal(f.service.db.prepare('SELECT typeof(revision) AS type FROM consent_states_v2 WHERE kind=?').get('profile').type, 'text');
});

test('v2 challenge expiration, host session mismatch and wrong domain never consume another challenge', t => {
  let now = 1000000;
  const f = fixture(t, configuration(), { now: () => now }), input = f.request(f.policy());
  const other = f.service.issueHostSession(identity).hostAccessToken;
  assert.throws(() => f.service.setConsentV2(other, input), fails('invalid_consent_challenge', 401));
  const bob = f.service.issueHostSession({ ...identity, principalId: 'bob' }).hostAccessToken;
  assert.throws(() => f.service.setConsentV2(bob, { ...input, expectedPrincipalId: 'bob' }), fails('invalid_consent_challenge', 401));
  assert.equal(f.service.db.prepare('SELECT consumed FROM consent_challenges_v2 WHERE id=?').get(digest(input.challengeId)).consumed, 0);
  now += 60000;
  assert.throws(() => f.service.setConsentV2(f.host, input), fails('invalid_consent_challenge', 401));
  assert.equal(f.service.identityStateV2(f.host, selection).profileAuthorized, false);
});

test('v2 durable grants survive same-user new epochs and legal pack upgrades, while old epoch requests fail', t => {
  const f = fixture(t); f.grant('profile'); f.grant('phone');
  const old = f.request(f.policy()), phone = f.service.phoneCodeV2(f.host, { ...selection, expectedConsentRevision: '1' }).code;
  const nextIdentity = { ...identity, principalEpoch: '2' }, host = f.service.issueHostSession(nextIdentity).hostAccessToken;
  const next = { ...selection, expectedPrincipalEpoch: '2', packRoot: nextPack };
  const state = f.service.identityStateV2(host, next);
  assert.equal(state.profileAuthorized, true); assert.equal(state.phoneAuthorized, true);
  assert.deepEqual(state.consentRevisions, { profile: '1', phone: '1' });
  assert.throws(() => f.service.setConsentV2(f.host, old), fails('stale_principal', 401));
  assert.throws(() => f.service.setConsentV2(host, { ...old, expectedPrincipalEpoch: '2' }), fails('invalid_consent_challenge', 401));
  const app = f.service.exchangeLogin('business', clientSecret, f.service.loginCode(host, next).code).accessToken;
  assert.throws(() => f.service.exchangePhoneV2('business', clientSecret, { code: phone, appAccessToken: app }), fails('stale_principal', 401));
  assert.deepEqual(f.service.profileV2(app, { expectedConsentRevision: '1' }).userInfo, state.userInfo);
  f.service.logoutApp(app);
  assert.equal(f.service.identityStateV2(host, next).profileAuthorized, true);
  assert.equal(f.service.identityStateV2(host, next).appLoggedIn, false);
});

test('v2 phone codes require current owner, epoch, pack, revision and grant; failed ownership does not consume', t => {
  const f = fixture(t); f.grant('phone');
  const issued = f.service.phoneCodeV2(f.host, { ...selection, expectedConsentRevision: '1' });
  const bob = f.service.issueHostSession({ ...identity, principalId: 'bob' }).hostAccessToken;
  const bobApp = f.service.exchangeLogin('business', clientSecret, f.service.loginCode(bob, { ...selection, expectedPrincipalId: 'bob' }).code).accessToken;
  assert.throws(() => f.service.exchangePhoneV2('business', clientSecret, { code: issued.code, appAccessToken: bobApp }), fails('phone_owner_mismatch', 403));
  assert.equal(f.service.exchangePhoneV2('business', clientSecret, { code: issued.code, appAccessToken: f.app }).phoneNumber, identity.phone);
  assert.throws(() => f.service.exchangePhoneV2('business', clientSecret, { code: issued.code, appAccessToken: f.app }), fails('invalid_code', 401));
  const stale = f.service.phoneCodeV2(f.host, { ...selection, expectedConsentRevision: '1' });
  f.revoke('phone'); f.grant('phone');
  assert.throws(() => f.service.exchangePhoneV2('business', clientSecret, { code: stale.code, appAccessToken: f.app }), fails('consent_revision_changed', 409));
});

test('v2 policy authority is durable across live services, policy ABA and deletion, without reviving old decisions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-consent-v2-policy-')), database = join(directory, 'reference.sqlite');
  const services = [];
  t.after(() => { for (const service of services) service.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = changes => { const service = new HostServices(configuration(database, changes)); services.push(service); return service; };
  const a = open(), host = a.issueHostSession(identity).hostAccessToken;
  const challenge = a.authorizationPolicyV2(host, { ...selection, kind: 'profile' });
  const request = { ...selection, ...policies.profile, kind: 'profile', granted: true, decisionId: decision(), challengeId: challenge.challengeId, expectedRevision: challenge.revision };
  const changed = { ...policies, profile: { ...policies.profile, permissionVersion: '2' } };
  open({ authorizationPolicies: changed });
  assert.throws(() => a.setConsentV2(host, request), fails('authorization_policy_changed', 409));
  assert.equal(a.authorizationPolicyV2(host, { ...selection, kind: 'profile' }).permissionVersion, '2');
  open();
  assert.throws(() => a.setConsentV2(host, request), fails('consent_revision_changed', 409));
  assert.equal(a.identityStateV2(host, selection).consentRevisions.profile, '2');
  assert.equal(a.identityStateV2(host, selection).consentRevisions.phone, '0');
  open({ authorizationPolicies: { phone: policies.phone } });
  assert.equal(a.identityStateV2(host, selection).consentRevisions.profile, '3');
  assert.throws(() => a.authorizationPolicyV2(host, { ...selection, kind: 'profile' }), fails('authorization_unavailable', 403));
  assert.equal(a.setConsentV2(host, { ...selection, kind: 'profile', granted: false, decisionId: decision() }).revision, '4');
  assert.throws(() => open({ publisherId: 'other' }), fails('app_registration_conflict', 409));
  assert.throws(() => open({ identityProtocol: '1.0' }), fails('identity_protocol_required', 426));
});

test('v2 persisted grants expire once, revision never resets after reopen, and deletion removes durable challenges/decisions/events', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-consent-v2-expiry-')), database = join(directory, 'reference.sqlite');
  let now = 1000000, service = new HostServices(configuration(database), { now: () => now });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  let host = service.issueHostSession(identity).hostAccessToken;
  const challenge = service.authorizationPolicyV2(host, { ...selection, kind: 'profile' });
  service.setConsentV2(host, { ...selection, ...policies.profile, kind: 'profile', granted: true, decisionId: decision(), challengeId: challenge.challengeId, expectedRevision: '0' });
  now += 30 * 86400000;
  host = service.issueHostSession(identity).hostAccessToken;
  assert.throws(() => service.hostProfileV2(host, { ...selection, expectedConsentRevision: '1' }), fails('consent_revision_changed', 409));
  assert.equal(service.identityStateV2(host, selection).consentRevisions.profile, '2');
  service.close(); service = new HostServices(configuration(database), { now: () => now });
  assert.equal(service.identityStateV2(host, selection).consentRevisions.profile, '2');
  service.deletePrincipal({ ...identity, principalEpoch: '2' });
  for (const table of ['consent_states_v2', 'consent_challenges_v2', 'consent_decisions_v2', 'consent_changes_v2']) assert.equal(service.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  const restored = service.issueHostSession({ ...identity, principalEpoch: '2' }).hostAccessToken;
  assert.equal(service.identityStateV2(restored, { ...selection, expectedPrincipalEpoch: '2' }).profileAuthorized, false);
});

test('v2 never guesses legacy consent migration, rejects old phone codes, and does not change pairwise app user IDs', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-consent-v2-legacy-')), database = join(directory, 'reference.sqlite');
  let service = new HostServices(configuration(database, { identityProtocol: '1.0' }));
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  const host = service.issueHostSession(identity).hostAccessToken;
  const before = service.exchangeLogin('business', clientSecret, service.loginCode(host, selection).code);
  service.setConsent(host, { ...selection, ...policies.profile, kind: 'profile', granted: true });
  service.setConsent(host, { ...selection, ...policies.phone, kind: 'phone', granted: true });
  const phone = service.phoneCode(host, selection).code;
  service.close(); service = new HostServices(configuration(database));
  const state = service.identityStateV2(host, selection);
  assert.equal(state.profileAuthorized, false); assert.equal(state.phoneAuthorized, false);
  assert.deepEqual(state.consentRevisions, { profile: '0', phone: '0' });
  assert.throws(() => service.exchangePhoneV2('business', clientSecret, { code: phone, appAccessToken: before.accessToken }), fails('identity_protocol_required', 426));
  const after = service.exchangeLogin('business', clientSecret, service.loginCode(host, selection).code);
  assert.equal(after.appUserId, before.appUserId);
});

test('v2 durable consent scopes contain the complete trusted tuple and never merge app, user, host, tenant, publisher or environment', t => {
  const config = configuration();
  for (const [field, value] of [['miniAppId', 'sibling'], ['hostAppId', 'other-host'], ['tenantId', 'other-tenant'], ['publisherId', 'other-publisher'], ['environment', 'release']]) {
    const base = config.applications[0], id = field === 'miniAppId' ? value : `mini-${field}`;
    config.applications.push({ ...base, miniAppId: id, clientId: `${id}-business`, [field]: value });
  }
  const f = fixture(t, config); f.grant('profile');
  const first = f.service.db.prepare('SELECT data FROM consent_states_v2 WHERE kind=?').get('profile');
  assert.deepEqual(Object.keys(JSON.parse(first.data).scope), ['hostAppId', 'tenantId', 'publisherId', 'principalId', 'miniAppId', 'environment']);
  for (const app of config.applications.slice(1)) {
    const host = f.service.issueHostSession({ ...identity, hostAppId: app.hostAppId, tenantId: app.tenantId, environment: app.environment }).hostAccessToken;
    const selected = { ...selection, miniAppId: app.miniAppId, expectedPublisherId: app.publisherId };
    assert.equal(f.service.identityStateV2(host, selected).profileAuthorized, false);
    f.service.setConsentV2(host, { ...selected, kind: 'profile', granted: false, decisionId: decision() });
  }
  const bob = f.service.issueHostSession({ ...identity, principalId: 'bob' }).hostAccessToken;
  assert.equal(f.service.identityStateV2(bob, { ...selection, expectedPrincipalId: 'bob' }).profileAuthorized, false);
  const state = f.service.identityStateV2(f.host, selection);
  assert.equal(state.profileAuthorized, true); assert.equal(state.consentRevisions.profile, '1');
});

test('v2 refuses publisher assignment to an existing legacy app with no verified mapping', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-consent-v2-no-migration-')), database = join(directory, 'reference.sqlite');
  const legacy = new HostServices(configuration(database, { identityProtocol: '1.0', publisherId: undefined }));
  legacy.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => new HostServices(configuration(database)), fails('app_registration_conflict', 409));
});

test('v2 direct methods reject inherited decisions, accessors and proxies before reading or digesting them', t => {
  const f = fixture(t), input = f.request(f.policy());
  const inherited = Object.assign(Object.create({ granted: true }), input);
  delete inherited.granted;
  assert.throws(() => f.service.setConsentV2(f.host, inherited), fails('invalid_request'));
  Object.getPrototypeOf(inherited).granted = false;
  assert.throws(() => f.service.setConsentV2(f.host, inherited), fails('invalid_request'));
  let reads = 0;
  const accessor = { ...input };
  Object.defineProperty(accessor, 'granted', { enumerable: true, get: () => { reads++; return true; } });
  assert.throws(() => f.service.setConsentV2(f.host, accessor), fails('invalid_request'));
  assert.equal(reads, 0);
  assert.throws(() => f.service.setConsentV2(f.host, new Proxy(input, {})), fails('invalid_request'));
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM consent_decisions_v2').get().n, 0);
  assert.equal(f.service.setConsentV2(f.host, Object.assign(Object.create(null), input)).revision, '1');
});

test('strict v1 deny rechecks current epoch and trusted installation after BEGIN IMMEDIATE', t => {
  const directory = mkdtempSync(join(tmpdir(), 'weapp-consent-v2-deny-boundary-')), database = join(directory, 'reference.sqlite');
  const a = new HostServices(configuration(database)), b = new HostServices(configuration(database));
  t.after(() => { a.close(); b.close(); rmSync(directory, { recursive: true, force: true }); });
  const oldHost = a.issueHostSession(identity).hostAccessToken;
  const challenge = a.authorizationPolicyV2(oldHost, { ...selection, kind: 'profile' });
  a.setConsentV2(oldHost, { ...selection, ...policies.profile, kind: 'profile', granted: true, decisionId: decision(), challengeId: challenge.challengeId, expectedRevision: '0' });
  const original = a.transaction.bind(a);
  let newHost;
  a.transaction = operation => {
    a.transaction = original;
    newHost = b.issueHostSession({ ...identity, principalEpoch: '2' }).hostAccessToken;
    return original(operation);
  };
  assert.throws(() => a.setConsent(oldHost, { ...selection, kind: 'profile', granted: false }), fails('stale_principal', 401));
  assert.equal(a.identityStateV2(newHost, { ...selection, expectedPrincipalEpoch: '2' }).profileAuthorized, true);
  const stableSelection = { ...selection, expectedPrincipalEpoch: '2' };
  a.transaction = operation => {
    a.transaction = original;
    const changed = new HostServices(configuration(database, { trustedPackRoots: [nextPack] })); changed.close();
    return original(operation);
  };
  assert.throws(() => a.setConsent(newHost, { ...stableSelection, kind: 'profile', granted: false }), fails('untrusted_pack', 403));
  assert.equal(a.identityStateV2(newHost, { ...stableSelection, packRoot: nextPack }).profileAuthorized, true);
});
