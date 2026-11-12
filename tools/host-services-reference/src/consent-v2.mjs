import { digest, opaqueToken } from './crypto.mjs';
import { requireThat } from './errors.mjs';
import { types } from 'node:util';

export const IDENTITY_PROTOCOL = '2.0';
export const CONSENT_KINDS = ['profile', 'phone'];
const maximumRevision = 18446744073709551615n;
export function consentRevision(value) {
  requireThat(typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= maximumRevision,
    'invalid_request', 'Consent revision must be a canonical decimal u64 string');
  return value;
}
export function exactInput(input, names) {
  requireThat(input && typeof input === 'object' && !types.isProxy(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input)) &&
    Reflect.ownKeys(input).every(name => {
      const field = Object.getOwnPropertyDescriptor(input, name);
      return typeof name === 'string' && names.includes(name) && field.enumerable && Object.hasOwn(field, 'value') &&
        ['string', 'boolean'].includes(typeof field.value);
    }) &&
    names.every(name => !(name in input) || Object.hasOwn(input, name)),
    'invalid_request', 'Unexpected identity protocol field');
}
export const durableDomain = scope => Object.fromEntries(['hostAppId', 'tenantId', 'publisherId', 'principalId', 'miniAppId', 'environment'].map(name => [name, scope[name]]));
export const domainKey = scope => digest(JSON.stringify(Object.values(durableDomain(scope))));
const consentId = (scope, kind) => digest(JSON.stringify([domainKey(scope), kind]));
const read = row => row && { ...JSON.parse(row.data), revision: row.revision };
const policyHash = policy => digest(JSON.stringify(policy));
const nextRevision = value => {
  const next = BigInt(consentRevision(value)) + 1n;
  requireThat(next <= maximumRevision, 'consent_revision_exhausted', 'Consent revision is exhausted', 409);
  return next.toString();
};

/** All methods run inside the service's BEGIN IMMEDIATE transaction. */
export class ConsentV2Store {
  constructor(db, now) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS identity_app_registry (
      app_id TEXT PRIMARY KEY, host_app_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
      publisher_id TEXT, environment TEXT NOT NULL, identity_protocol TEXT NOT NULL, trusted_pack_roots TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consent_policies_v2 (app_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(app_id,kind));
      CREATE TABLE IF NOT EXISTS consent_states_v2 (id TEXT PRIMARY KEY, principal_key TEXT NOT NULL, app_id TEXT NOT NULL, kind TEXT NOT NULL,
        revision TEXT NOT NULL CHECK(typeof(revision)='text'), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consent_challenges_v2 (id TEXT PRIMARY KEY, consent_id TEXT NOT NULL REFERENCES consent_states_v2(id) ON DELETE CASCADE,
        host_id TEXT NOT NULL, principal_epoch TEXT NOT NULL, expected_revision TEXT NOT NULL, policy_digest TEXT NOT NULL,
        expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS consent_decisions_v2 (consent_id TEXT NOT NULL REFERENCES consent_states_v2(id) ON DELETE CASCADE,
        decision_id TEXT NOT NULL, request_digest TEXT NOT NULL, challenge_id TEXT, revision TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(consent_id,decision_id));
      CREATE TABLE IF NOT EXISTS consent_changes_v2 (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        consent_id TEXT NOT NULL REFERENCES consent_states_v2(id) ON DELETE CASCADE, revision TEXT NOT NULL,
        granted INTEGER NOT NULL, decision_id TEXT, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS consent_states_principal_v2 ON consent_states_v2(principal_key);`);
  }
  configure(apps) {
    for (const app of apps) {
      const registration = [app.hostAppId, app.tenantId, app.publisherId ?? null, app.environment];
      const previous = this.db.prepare('SELECT * FROM identity_app_registry WHERE app_id=?').get(app.miniAppId);
      requireThat(!previous || JSON.stringify([previous.host_app_id, previous.tenant_id, previous.publisher_id, previous.environment]) === JSON.stringify(registration),
        'app_registration_conflict', 'Application trusted scope cannot be rebound without an explicit migration', 409);
      requireThat(!previous || previous.identity_protocol !== '2.0' || app.identityProtocol === '2.0',
        'identity_protocol_required', 'A strict application cannot be downgraded to legacy identity', 426);
      this.db.prepare(`INSERT INTO identity_app_registry VALUES(?,?,?,?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET identity_protocol=excluded.identity_protocol,trusted_pack_roots=excluded.trusted_pack_roots`)
        .run(app.miniAppId, ...registration, app.identityProtocol, JSON.stringify(app.trustedPackRoots));
      if (app.identityProtocol !== '2.0') continue;
      for (const kind of CONSENT_KINDS) {
        const policy = app.authorizationPolicies?.[kind] ? { purpose: app.authorizationPolicies[kind].purpose, permissionVersion: app.authorizationPolicies[kind].permissionVersion } : null;
        const hash = policyHash(policy);
        const old = this.db.prepare('SELECT digest FROM consent_policies_v2 WHERE app_id=? AND kind=?').get(app.miniAppId, kind);
        this.db.prepare(`INSERT INTO consent_policies_v2 VALUES(?,?,?,?) ON CONFLICT(app_id,kind) DO UPDATE SET data=excluded.data,digest=excluded.digest`)
          .run(app.miniAppId, kind, JSON.stringify(policy), hash);
        if (old && old.digest !== hash) {
          for (const row of this.db.prepare('SELECT * FROM consent_states_v2 WHERE app_id=? AND kind=?').all(app.miniAppId, kind)) {
            this.transition(row.id, read(row), policy, false, null, 'policy');
          }
        }
      }
    }
  }
  policy(scope, kind) {
    const row = this.db.prepare('SELECT data FROM consent_policies_v2 WHERE app_id=? AND kind=?').get(scope.miniAppId, kind);
    requireThat(row, 'identity_protocol_required', 'Application does not support identity protocol 2.0', 426);
    return JSON.parse(row.data);
  }
  save(id, state) { this.db.prepare('UPDATE consent_states_v2 SET revision=?,data=? WHERE id=?').run(state.revision, JSON.stringify(state), id); }
  transition(id, state, policy, granted, decisionId, reason) {
    const next = { ...state, revision: nextRevision(state.revision), granted, purpose: policy?.purpose ?? null,
      permissionVersion: policy?.permissionVersion ?? null, policyDigest: policyHash(policy), expiresAt: granted ? this.now() + 30 * 86400000 : null };
    this.save(id, next);
    this.db.prepare('INSERT INTO consent_changes_v2(consent_id,revision,granted,decision_id,reason) VALUES(?,?,?,?,?)')
      .run(id, next.revision, granted ? 1 : 0, decisionId, reason);
    return next;
  }
  state(scope, kind) {
    const id = consentId(scope, kind), policy = this.policy(scope, kind);
    let state = read(this.db.prepare('SELECT * FROM consent_states_v2 WHERE id=?').get(id));
    if (!state) {
      state = { scope: durableDomain(scope), kind, revision: '0', granted: false, purpose: policy?.purpose ?? null,
        permissionVersion: policy?.permissionVersion ?? null, policyDigest: policyHash(policy), expiresAt: null };
      const principal = digest(JSON.stringify([scope.hostAppId, scope.tenantId, scope.principalId, scope.environment]));
      this.db.prepare('INSERT INTO consent_states_v2 VALUES(?,?,?,?,?,?)').run(id, principal, scope.miniAppId, kind, '0', JSON.stringify(state));
    } else if (state.policyDigest !== policyHash(policy) || (state.granted && state.expiresAt <= this.now())) {
      state = this.transition(id, state, policy, false, null, state.policyDigest !== policyHash(policy) ? 'policy' : 'expired');
    }
    return state;
  }
  challenge(host, scope, kind) {
    const state = this.state(scope, kind), policy = this.policy(scope, kind);
    requireThat(policy, 'authorization_unavailable', 'No authorization purpose is registered for this application', 403);
    const challengeId = opaqueToken(), expiresAt = Math.min(this.now() + 60000, host.expiresAt);
    this.db.prepare('INSERT INTO consent_challenges_v2(id,consent_id,host_id,principal_epoch,expected_revision,policy_digest,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(digest(challengeId), consentId(scope, kind), host.id, scope.principalEpoch, state.revision, state.policyDigest, expiresAt);
    return { identityProtocol: IDENTITY_PROTOCOL, kind, ...policy, revision: state.revision, challengeId, expiresIn: Math.max(0, Math.floor((expiresAt - this.now()) / 1000)) };
  }
  decide(host, scope, input) {
    const { kind, granted, decisionId } = input;
    requireThat(CONSENT_KINDS.includes(kind) && typeof granted === 'boolean', 'invalid_request', 'Choose profile or phone and explicit granted boolean');
    requireThat(typeof decisionId === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(decisionId), 'invalid_request', 'decisionId must be an opaque random identifier');
    const state = this.state(scope, kind), id = consentId(scope, kind), policy = this.policy(scope, kind);
    const requestDigest = digest(JSON.stringify(Object.keys(input).sort().map(name => [name, input[name]])));
    const existing = this.db.prepare('SELECT * FROM consent_decisions_v2 WHERE consent_id=? AND decision_id=?').get(id, decisionId);
    if (existing) {
      requireThat(existing.request_digest === requestDigest, 'consent_decision_conflict', 'decisionId was used with a different request', 409);
      requireThat(existing.revision === state.revision, 'consent_decision_superseded', 'A later consent decision superseded this result', 409);
      return { ...JSON.parse(existing.result), ...(state.granted ? { expiresIn: Math.max(0, Math.floor((state.expiresAt - this.now()) / 1000)) } : {}) };
    }
    let challenge;
    if (granted) {
      requireThat(input.challengeId !== undefined && input.expectedRevision !== undefined, 'consent_precondition_required', 'Grant requires a challenge and expected revision', 428);
      consentRevision(input.expectedRevision);
      requireThat(typeof input.challengeId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.challengeId), 'invalid_consent_challenge', 'Invalid consent challenge', 401);
      challenge = this.db.prepare('SELECT * FROM consent_challenges_v2 WHERE id=?').get(digest(input.challengeId));
      requireThat(challenge && !challenge.consumed && challenge.expires_at > this.now() && challenge.consent_id === id && challenge.host_id === host.id && challenge.principal_epoch === scope.principalEpoch,
        'invalid_consent_challenge', 'Consent challenge is expired, consumed or belongs to another host context', 401);
      requireThat(policy && challenge.policy_digest === state.policyDigest && input.purpose === policy.purpose && input.permissionVersion === policy.permissionVersion,
        'authorization_policy_changed', 'Authorization policy changed; request a new explicit decision', 409);
      requireThat(challenge.expected_revision === input.expectedRevision && input.expectedRevision === state.revision,
        'consent_revision_changed', 'Consent revision changed; request a new explicit decision', 409);
    }
    const next = this.transition(id, state, policy, granted, decisionId, granted ? 'grant' : 'revoke');
    if (challenge) this.db.prepare('UPDATE consent_challenges_v2 SET consumed=1 WHERE id=?').run(challenge.id);
    const result = { identityProtocol: IDENTITY_PROTOCOL, kind, granted, revision: next.revision, decisionId,
      ...(granted ? { expiresIn: Math.floor((next.expiresAt - this.now()) / 1000) } : {}) };
    this.db.prepare('INSERT INTO consent_decisions_v2 VALUES(?,?,?,?,?,?)').run(id, decisionId, requestDigest, challenge?.id ?? null, next.revision, JSON.stringify(result));
    return result;
  }
  granted(scope, kind, expectedRevision) {
    consentRevision(expectedRevision);
    const state = this.state(scope, kind);
    requireThat(expectedRevision === state.revision, 'consent_revision_changed', 'Consent revision changed', 409);
    requireThat(state.granted, 'consent_required', `Explicit ${kind} consent is required`, 403);
    return state;
  }
}
