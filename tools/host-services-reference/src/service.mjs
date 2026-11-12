import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID } from 'node:crypto';
import { digest, equalSecret, opaqueToken } from './crypto.mjs';
import { epoch, integer, requireThat, ServiceError, text } from './errors.mjs';
import { AlipayProvider, ReferenceProvider, WechatProvider } from './providers.mjs';
import { ConsentV2Store, CONSENT_KINDS, IDENTITY_PROTOCOL, consentRevision, domainKey, exactInput } from './consent-v2.mjs';

const parse = row => row ? JSON.parse(row.data) : undefined;
const key = value => digest(JSON.stringify(value));
const principalKey = scope => key([scope.hostAppId, scope.tenantId, scope.principalId, scope.environment]);
const ownerKey = scope => key([scope.hostAppId, scope.tenantId, scope.principalId, scope.principalEpoch, scope.miniAppId, scope.environment]);
const consentKey = (scope, kind) => key([ownerKey(scope), kind]);
const allowedKinds = new Set(['profile', 'phone']);
const publicProfile = profile => Object.fromEntries(['nickName', 'avatarUrl'].filter(name => typeof profile?.[name] === 'string').map(name => [name, profile[name]]));
const selectionFieldsV2 = ['miniAppId', 'packRoot', 'expectedPrincipalId', 'expectedPrincipalEpoch', 'expectedPublisherId'];

/** Trusted backend reference: the HTTP layer, never guest JavaScript, owns credentials. */
export class HostServices {
  constructor(config, { now = Date.now, fetch = globalThis.fetch, providers } = {}) {
    this.config = config; this.now = now;
    requireThat(typeof config.identitySecret === 'string' && config.identitySecret.length >= 32, 'provider_configuration', 'Configure a stable identitySecret of at least 32 characters', 503);
    requireThat(typeof config.issuerSecret === 'string' && config.issuerSecret.length >= 32, 'provider_configuration', 'Configure a server-only issuerSecret of at least 32 characters', 503);
    this.apps = new Map(); this.clients = new Map();
    for (const configured of config.applications ?? []) {
      const app = { ...configured, identityProtocol: configured.identityProtocol ?? IDENTITY_PROTOCOL };
      requireThat(['1.0', IDENTITY_PROTOCOL].includes(app.identityProtocol), 'provider_configuration', 'Configure identityProtocol 1.0 or 2.0 explicitly', 503);
      if (app.identityProtocol === IDENTITY_PROTOCOL || app.publisherId !== undefined) text(app.publisherId, 'trusted publisherId');
      for (const field of ['miniAppId', 'hostAppId', 'tenantId', 'environment', 'clientId']) text(app[field], field);
      requireThat(typeof app.clientSecret === 'string' && app.clientSecret.length >= 32, 'provider_configuration', 'Each app requires a strong confidential client secret', 503);
      requireThat(!this.apps.has(app.miniAppId) && !this.clients.has(app.clientId), 'provider_configuration', 'Duplicate app/client ID', 503);
      requireThat(Array.isArray(app.trustedPackRoots) && app.trustedPackRoots.length > 0 && app.trustedPackRoots.every(root => /^[a-f0-9]{64}$/.test(root)),
        'provider_configuration', 'Configure verified pack SHA-256 roots for each app', 503);
      for (const [kind, policy] of Object.entries(app.authorizationPolicies ?? {})) {
        requireThat(allowedKinds.has(kind) && policy && typeof policy === 'object' && !Array.isArray(policy),
          'provider_configuration', 'Authorization policies must name profile or phone', 503);
        text(policy.purpose, 'registered authorization purpose', 512);
        text(policy.permissionVersion, 'registered permission version', 64);
      }
      this.apps.set(app.miniAppId, structuredClone(app)); this.clients.set(app.clientId, this.apps.get(app.miniAppId));
    }
    this.providers = providers ?? Object.fromEntries(Object.entries(config.payments ?? {}).map(([name, value]) => {
      const Provider = { reference: ReferenceProvider, wechat: WechatProvider, alipay: AlipayProvider }[name];
      requireThat(Provider, 'provider_configuration', 'Unknown configured payment channel', 503);
      return [name, new Provider(value, { now, fetch })];
    }));
    this.db = new DatabaseSync(config.database ?? ':memory:');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, epoch TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, data TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, app_id TEXT NOT NULL, data TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS codes (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, app_id TEXT NOT NULL, client_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS consents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, dedup_key TEXT UNIQUE NOT NULL, merchant_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS session_app_host ON sessions(host_id,app_id);
      CREATE INDEX IF NOT EXISTS code_app_host ON codes(host_id,app_id);`);
    this.consentV2 = new ConsentV2Store(this.db, now);
    try { this.transaction(() => this.consentV2.configure(this.apps.values())); }
    catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  identityTransaction(operation) {
    // State expiration/policy normalization must remain committed even when a
    // stale request is rejected. Decision/code mutations happen only after all
    // validation, and storage failures or revision exhaustion roll back fully.
    const outcome = this.transaction(() => {
      try { return { value: operation() }; }
      catch (error) {
        if (!(error instanceof ServiceError) || error.code === 'consent_revision_exhausted') throw error;
        return { error };
      }
    });
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }
  strictIdentity(miniAppId) {
    return this.db.prepare('SELECT identity_protocol FROM identity_app_registry WHERE app_id=?').get(miniAppId)?.identity_protocol === IDENTITY_PROTOCOL;
  }
  requireLegacyIdentity(miniAppId) {
    requireThat(!this.strictIdentity(miniAppId), 'identity_protocol_required', 'Application requires identity protocol 2.0', 426);
  }
  selectionV2(input, extra = []) {
    exactInput(input, [...selectionFieldsV2, ...extra]);
    for (const name of selectionFieldsV2) text(input[name], name, name === 'packRoot' ? 64 : 256);
    epoch(input.expectedPrincipalEpoch);
  }
  hostScopeV2(token, selection) {
    const host = this.host(token, selection), scope = this.appScope(host, selection.miniAppId, selection.packRoot);
    requireThat(this.strictIdentity(scope.miniAppId), 'identity_protocol_required', 'Application does not support identity protocol 2.0', 426);
    requireThat(selection.expectedPublisherId === scope.publisherId, 'publisher_identity_mismatch', 'Native publisher does not match trusted registration', 403);
    return { host, scope };
  }
  sessionScopeV2(token) {
    const session = this.session(token), host = this.hostRecord(session.hostId), scope = this.appScope(host, session.scope.miniAppId, session.packRoot);
    requireThat(this.strictIdentity(scope.miniAppId), 'identity_protocol_required', 'Application does not support identity protocol 2.0', 426);
    requireThat(session.scope.publisherId === scope.publisherId && domainKey(session.scope) === domainKey(scope),
      'app_scope_mismatch', 'App session does not match current trusted publisher scope', 403);
    return { session, host, scope };
  }
  application(miniAppId) {
    const app = this.apps.get(miniAppId);
    requireThat(app, 'unknown_app', 'Application is not registered', 404); return app;
  }
  authenticateClient(clientId, secret) {
    const app = this.clients.get(clientId);
    requireThat(app && equalSecret(app.clientSecret, secret), 'invalid_client', 'Invalid confidential client credentials', 401); return app;
  }
  authenticateIssuer(secret) { requireThat(equalSecret(this.config.issuerSecret, secret), 'invalid_issuer', 'Trusted host identity issuer required', 401); }
  hostRecord(id) {
    const row = this.db.prepare('SELECT * FROM hosts WHERE id=?').get(id), host = parse(row);
    requireThat(host && !row.revoked && host.expiresAt > this.now(), 'invalid_host_session', 'Host session expired or revoked', 401);
    const current = this.db.prepare('SELECT epoch FROM principals WHERE id=?').get(principalKey(host.scope));
    requireThat(current?.epoch === host.scope.principalEpoch, 'stale_principal', 'Host identity epoch was revoked', 401);
    return host;
  }
  host(token, selection = {}) {
    const host = this.hostRecord(digest(text(token, 'host bearer', 1024)));
    if (selection.expectedPrincipalId !== undefined || selection.expectedPrincipalEpoch !== undefined) {
      requireThat(selection.expectedPrincipalId === host.scope.principalId && epoch(selection.expectedPrincipalEpoch) === host.scope.principalEpoch,
        'host_identity_mismatch', 'Native account context does not match the host bearer', 403);
    }
    return host;
  }
  session(token) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(digest(text(token, 'app bearer', 1024))), session = parse(row);
    requireThat(session && !row.revoked && session.expiresAt > this.now(), 'invalid_app_session', 'App session expired or revoked', 401);
    this.hostRecord(session.hostId); return session;
  }
  issueHostSession(identity) {
    const scope = {};
    for (const field of ['hostAppId', 'tenantId', 'principalId', 'environment']) scope[field] = text(identity[field], field);
    scope.principalEpoch = epoch(identity.principalEpoch);
    const token = opaqueToken(), id = digest(token), ttl = integer(identity.expiresIn ?? 3600, 'expiresIn', 1, 86400);
    const host = { id, scope, profile: publicProfile(identity.profile), phone: identity.phone === undefined ? null : text(identity.phone, 'verified phone', 64), expiresAt: this.now() + ttl * 1000 };
    this.transaction(() => {
      const current = this.db.prepare('SELECT epoch FROM principals WHERE id=?').get(principalKey(scope));
      requireThat(!current || BigInt(scope.principalEpoch) >= BigInt(current.epoch), 'stale_principal', 'Cannot restore a revoked principal epoch', 409);
      this.db.prepare('INSERT INTO principals(id,epoch) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch').run(principalKey(scope), scope.principalEpoch);
      this.db.prepare('INSERT INTO hosts(id,data) VALUES(?,?)').run(id, JSON.stringify(host));
    });
    return { hostAccessToken: token, expiresIn: ttl, principalEpoch: scope.principalEpoch };
  }
  revokePrincipal(identity) {
    const scope = {};
    for (const field of ['hostAppId', 'tenantId', 'principalId', 'environment']) scope[field] = text(identity[field], field);
    const next = epoch(identity.principalEpoch);
    this.transaction(() => {
      const current = this.db.prepare('SELECT epoch FROM principals WHERE id=?').get(principalKey(scope));
      requireThat(!current || BigInt(next) > BigInt(current.epoch), 'stale_principal', 'Revocation requires a greater principal epoch', 409);
      this.db.prepare('INSERT INTO principals(id,epoch) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch').run(principalKey(scope), next);
    }); return { principalEpoch: next };
  }
  deletePrincipal(identity) {
    const scope = {};
    for (const field of ['hostAppId', 'tenantId', 'principalId', 'environment']) scope[field] = text(identity[field], field);
    const next = epoch(identity.principalEpoch), principal = principalKey(scope);
    return this.transaction(() => {
      const current = this.db.prepare('SELECT epoch FROM principals WHERE id=?').get(principal);
      requireThat(!current || BigInt(next) > BigInt(current.epoch), 'stale_principal', 'Account deletion requires a greater principal epoch', 409);
      // Collect every persisted scope before deleting it.  ownerKey contains the epoch,
      // so deleting only the current epoch would leave old-account orders and consents.
      const scopes = new Map(), hostIds = new Set(), orderIds = new Set();
      const collect = value => {
        try {
          const candidate = typeof value === 'string' ? JSON.parse(value) : value;
          // Host records carry a parent scope without miniAppId; only app
          // scopes can own consent records.
          if (candidate?.scope && candidate.scope.miniAppId && principalKey(candidate.scope) === principal) {
            scopes.set(ownerKey(candidate.scope), candidate.scope);
          }
          return candidate;
        } catch { return undefined; }
      };
      for (const row of this.db.prepare('SELECT id,data FROM hosts').all()) {
        const host = collect(row.data);
        if (host?.scope && principalKey(host.scope) === principal) hostIds.add(row.id);
      }
      for (const row of this.db.prepare('SELECT id,host_id,data FROM sessions').all()) {
        const session = collect(row.data);
        if (session?.scope && principalKey(session.scope) === principal) hostIds.add(row.host_id);
      }
      for (const row of this.db.prepare('SELECT id,host_id,data FROM codes').all()) {
        const code = collect(row.data);
        if (code?.scope && principalKey(code.scope) === principal) hostIds.add(row.host_id);
      }
      for (const row of this.db.prepare('SELECT id,data FROM orders').all()) {
        const order = collect(row.data);
        if (order?.scope && principalKey(order.scope) === principal) orderIds.add(row.id);
      }
      const consentIds = [];
      for (const oldScope of scopes.values()) for (const kind of allowedKinds) consentIds.push(consentKey(oldScope, kind));
      if (consentIds.length) this.db.prepare(`DELETE FROM consents WHERE id IN (${consentIds.map(() => '?').join(',')})`).run(...consentIds);
      const durableConsents = this.db.prepare('DELETE FROM consent_states_v2 WHERE principal_key=?').run(principal).changes;
      if (orderIds.size) {
        for (const row of this.db.prepare('SELECT id,data FROM payment_events').all()) {
          const event = parse(row);
          if (event?.orderId && orderIds.has(event.orderId)) this.db.prepare('DELETE FROM payment_events WHERE id=?').run(row.id);
        }
        this.db.prepare(`DELETE FROM orders WHERE id IN (${[...orderIds].map(() => '?').join(',')})`).run(...orderIds);
      }
      if (hostIds.size) {
        // Bind each host ID separately.  This keeps deletion compatible with
        // node:sqlite builds that reject variadic array bindings for IN lists.
        for (const id of hostIds) {
          this.db.prepare('DELETE FROM sessions WHERE host_id=?').run(id);
          this.db.prepare('DELETE FROM codes WHERE host_id=?').run(id);
          this.db.prepare('DELETE FROM hosts WHERE id=?').run(id);
        }
      }
      this.db.prepare('INSERT INTO principals(id,epoch) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch').run(principal, next);
      return { deleted: true, principalEpoch: next, removed: { hosts: hostIds.size, orders: orderIds.size, consents: consentIds.length + Number(durableConsents) } };
    });
  }
  logoutHost(token) { const host = this.host(token); this.db.prepare('UPDATE hosts SET revoked=1 WHERE id=?').run(host.id); return { loggedOut: true }; }
  appScope(host, miniAppId, packRoot) {
    this.application(miniAppId);
    const registration = this.db.prepare('SELECT * FROM identity_app_registry WHERE app_id=?').get(miniAppId);
    requireThat(registration && registration.host_app_id === host.scope.hostAppId && registration.tenant_id === host.scope.tenantId && registration.environment === host.scope.environment,
      'app_scope_mismatch', 'App does not belong to this host scope', 403);
    requireThat(registration && JSON.parse(registration.trusted_pack_roots).includes(packRoot), 'untrusted_pack', 'Installed pack root is not allowlisted', 403);
    return { ...host.scope, miniAppId, ...(registration.publisher_id ? { publisherId: registration.publisher_id } : {}) };
  }
  makeCode(host, scope, kind, packRoot, consentRevision) {
    const app = this.application(scope.miniAppId), code = opaqueToken();
    const record = { hostId: host.id, scope, packRoot, expiresAt: Math.min(this.now() + 60000, host.expiresAt), consentRevision,
      ...(kind === 'phone-v2' ? { identityProtocol: IDENTITY_PROTOCOL, consentDomain: domainKey(scope) } : {}) };
    this.db.prepare('INSERT INTO codes(id,host_id,app_id,client_id,kind,data) VALUES(?,?,?,?,?,?)')
      .run(digest(code), host.id, app.miniAppId, app.clientId, kind, JSON.stringify(record));
    return { code, expiresIn: Math.max(0, Math.floor((record.expiresAt - this.now()) / 1000)) };
  }
  loginCode(token, selection) {
    const { miniAppId, packRoot } = selection;
    const host = this.host(token, selection), scope = this.appScope(host, miniAppId, packRoot);
    return this.makeCode(host, scope, 'login', packRoot);
  }
  identityState(token, selection) {
    const { miniAppId, packRoot } = selection;
    const host = this.host(token, selection), scope = this.appScope(host, miniAppId, packRoot);
    this.requireLegacyIdentity(miniAppId);
    const consents = Object.fromEntries([...allowedKinds].map(kind => {
      const record = parse(this.db.prepare('SELECT data FROM consents WHERE id=?').get(consentKey(scope, kind)));
      return [kind, this.currentConsent(scope, kind, record) ? record : null];
    }));
    const appLoggedIn = this.appSessionLive(scope, packRoot);
    return { hostLoggedIn: true, appLoggedIn, profileAuthorized: consents.profile?.granted === true, phoneAuthorized: consents.phone?.granted === true,
      authorizationVersion: key([scope.principalEpoch, ...[...allowedKinds].map(kind => [kind, this.policy(scope, kind), consents[kind]?.revision ?? null])]),
      ...(consents.profile?.granted ? { userInfo: publicProfile(host.profile) } : {}) };
  }
  appSessionLive(scope, packRoot) {
    return this.db.prepare('SELECT * FROM sessions WHERE app_id=? AND revoked=0').all(scope.miniAppId).some(row => {
      const session = parse(row);
      if (session.expiresAt <= this.now() || ownerKey(session.scope) !== ownerKey(scope) || session.packRoot !== packRoot) return false;
      try { this.hostRecord(session.hostId); return true; } catch { return false; }
    });
  }
  checkSession(token, selection) {
    const host = this.host(token, selection), scope = this.appScope(host, selection.miniAppId, selection.packRoot);
    requireThat(this.appSessionLive(scope, selection.packRoot), 'invalid_app_session', 'No live redeemed application session exists', 401);
    return { valid: true };
  }
  consumeCode(clientId, secret, code, kind, operation) {
    const app = this.authenticateClient(clientId, secret), id = digest(text(code, 'code', 1024));
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM codes WHERE id=?').get(id), record = parse(row);
      requireThat(record && row.kind === kind && row.client_id === app.clientId && row.app_id === app.miniAppId && !row.consumed && record.expiresAt > this.now(),
        'invalid_code', 'Code is expired, consumed, or belongs to another app', 401);
      const host = this.hostRecord(record.hostId);
      this.appScope(host, app.miniAppId, record.packRoot);
      const result = operation(record, host);
      this.db.prepare('UPDATE codes SET consumed=1 WHERE id=?').run(id);
      return result;
    });
  }
  exchangeLogin(clientId, secret, code) {
    return this.consumeCode(clientId, secret, code, 'login', (record, host) => {
      const token = opaqueToken(), expiresAt = Math.min(this.now() + 3600000, host.expiresAt);
      const session = { hostId: host.id, scope: record.scope, packRoot: record.packRoot, expiresAt };
      this.db.prepare('INSERT INTO sessions(id,host_id,app_id,data) VALUES(?,?,?,?)').run(digest(token), host.id, record.scope.miniAppId, JSON.stringify(session));
      // The app user ID is pairwise; neither a global principal ID nor a host token is disclosed.
      const userKey = [record.scope.hostAppId, record.scope.tenantId, record.scope.principalId, record.scope.miniAppId, record.scope.environment];
      const appUserId = createHmac('sha256', this.config.identitySecret).update(JSON.stringify(userKey)).digest('base64url');
      return { accessToken: token, tokenType: 'Bearer', expiresIn: Math.floor((expiresAt - this.now()) / 1000), appUserId };
    });
  }
  policy(scope, kind) {
    const policy = this.application(scope.miniAppId).authorizationPolicies?.[kind];
    return policy ? { purpose: policy.purpose, permissionVersion: policy.permissionVersion } : null;
  }
  currentConsent(scope, kind, record) {
    const policy = this.policy(scope, kind);
    return policy && record?.expiresAt > this.now() && record.purpose === policy.purpose && record.permissionVersion === policy.permissionVersion;
  }
  authorizationPolicy(token, selection) {
    const host = this.host(token, selection), scope = this.appScope(host, selection.miniAppId, selection.packRoot);
    this.requireLegacyIdentity(scope.miniAppId);
    requireThat(allowedKinds.has(selection.kind), 'invalid_request', 'Choose profile or phone');
    const policy = this.policy(scope, selection.kind);
    requireThat(policy, 'authorization_unavailable', 'No authorization purpose is registered for this application', 403);
    return { kind: selection.kind, ...policy };
  }
  consent(scope, kind) {
    this.requireLegacyIdentity(scope.miniAppId);
    const consent = parse(this.db.prepare('SELECT data FROM consents WHERE id=?').get(consentKey(scope, kind)));
    requireThat(consent?.granted && this.currentConsent(scope, kind, consent), 'consent_required', `Explicit ${kind} consent for the current purpose and permission version is required`, 403);
    return consent;
  }
  setConsent(token, selection) {
    const { miniAppId, packRoot, kind, granted } = selection;
    requireThat(allowedKinds.has(kind) && typeof granted === 'boolean', 'invalid_request', 'Choose profile or phone and explicit granted boolean');
    return this.identityTransaction(() => {
      // The account/installation check is part of the write transaction. A
      // previously validated v1 caller must not revoke a newer durable owner.
      const host = this.host(token, selection), scope = this.appScope(host, miniAppId, packRoot);
      if (this.strictIdentity(miniAppId)) {
        if (granted) this.requireLegacyIdentity(miniAppId);
        return this.consentV2.decide(host, scope, {
          miniAppId, packRoot, expectedPrincipalId: scope.principalId, expectedPrincipalEpoch: scope.principalEpoch,
          expectedPublisherId: scope.publisherId, kind, granted: false, decisionId: opaqueToken(),
        });
      }
      const policy = this.policy(scope, kind);
      if (granted) {
        requireThat(policy, 'authorization_unavailable', 'No authorization purpose is registered for this application', 403);
        requireThat(selection.purpose === policy.purpose && selection.permissionVersion === policy.permissionVersion,
          'authorization_policy_changed', 'The confirmed authorization purpose or permission version is stale; request confirmation again', 409);
      }
      const consent = { granted, ...policy, revision: opaqueToken(), expiresAt: this.now() + 30 * 86400000 };
      this.db.prepare('INSERT INTO consents(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(consentKey(scope, kind), JSON.stringify(consent));
      return { kind, granted, ...policy, consentReceipt: consent.revision, expiresAt: consent.expiresAt };
    });
  }
  profile(token) { const session = this.session(token); this.requireLegacyIdentity(session.scope.miniAppId); this.consent(session.scope, 'profile'); return publicProfile(this.hostRecord(session.hostId).profile); }
  hostProfile(token, selection) {
    const { miniAppId, packRoot } = selection;
    const host = this.host(token, selection), scope = this.appScope(host, miniAppId, packRoot);
    this.consent(scope, 'profile'); return publicProfile(host.profile);
  }
  phoneCode(token, selection) {
    const { miniAppId, packRoot } = selection;
    const host = this.host(token, selection), scope = this.appScope(host, miniAppId, packRoot), consent = this.consent(scope, 'phone');
    requireThat(host.phone, 'phone_unavailable', 'Host backend has no verified phone number', 409);
    return this.makeCode(host, scope, 'phone', packRoot, consent.revision);
  }
  exchangePhone(clientId, secret, code, expectedAppAccessToken) {
    this.requireLegacyIdentity(this.authenticateClient(clientId, secret).miniAppId);
    return this.consumeCode(clientId, secret, code, 'phone', (record, host) => {
      if (expectedAppAccessToken !== undefined) {
        const expected = this.session(expectedAppAccessToken);
        requireThat(ownerKey(expected.scope) === ownerKey(record.scope) && expected.packRoot === record.packRoot, 'phone_owner_mismatch', 'Phone code belongs to another business user', 403);
      }
      const consent = this.consent(record.scope, 'phone');
      requireThat(consent.revision === record.consentRevision && host.phone, 'invalid_code', 'Phone consent changed after code issuance', 401);
      return { phoneNumber: host.phone };
    });
  }
  identityCapabilitiesV2(token, selection) {
    this.selectionV2(selection);
    return this.identityTransaction(() => {
      this.hostScopeV2(token, selection);
      return { identityProtocol: IDENTITY_PROTOCOL, consentRevision: '1.0', scopeSchema: '2.0', kinds: [...CONSENT_KINDS],
        maxRequestBytes: 262144, maxResponseBytes: 262144 };
    });
  }
  authorizationPolicyV2(token, selection) {
    this.selectionV2(selection, ['kind']);
    requireThat(CONSENT_KINDS.includes(selection.kind), 'invalid_request', 'Choose profile or phone');
    return this.identityTransaction(() => {
      const { host, scope } = this.hostScopeV2(token, selection);
      return this.consentV2.challenge(host, scope, selection.kind);
    });
  }
  setConsentV2(token, selection) {
    this.selectionV2(selection, ['kind', 'granted', 'decisionId', 'challengeId', 'expectedRevision', 'purpose', 'permissionVersion']);
    if (selection.expectedRevision !== undefined) consentRevision(selection.expectedRevision);
    return this.identityTransaction(() => {
      const { host, scope } = this.hostScopeV2(token, selection);
      return this.consentV2.decide(host, scope, selection);
    });
  }
  identityStateV2(token, selection) {
    this.selectionV2(selection);
    return this.identityTransaction(() => {
      const { host, scope } = this.hostScopeV2(token, selection);
      const states = Object.fromEntries(CONSENT_KINDS.map(kind => [kind, this.consentV2.state(scope, kind)]));
      return { identityProtocol: IDENTITY_PROTOCOL, hostLoggedIn: true, appLoggedIn: this.appSessionLive(scope, selection.packRoot),
        profileAuthorized: states.profile.granted, phoneAuthorized: states.phone.granted,
        authorizationVersion: key(CONSENT_KINDS.map(kind => [kind, states[kind].revision, states[kind].policyDigest])),
        consentRevisions: Object.fromEntries(CONSENT_KINDS.map(kind => [kind, states[kind].revision])),
        consentExpiresIn: Object.fromEntries(CONSENT_KINDS.map(kind => [kind, states[kind].granted ? Math.max(0, Math.floor((states[kind].expiresAt - this.now()) / 1000)) : 0])),
        ...(states.profile.granted ? { userInfo: publicProfile(host.profile) } : {}) };
    });
  }
  hostProfileV2(token, selection) {
    this.selectionV2(selection, ['expectedConsentRevision']);
    return this.identityTransaction(() => {
      const { host, scope } = this.hostScopeV2(token, selection);
      const state = this.consentV2.granted(scope, 'profile', selection.expectedConsentRevision);
      return { identityProtocol: IDENTITY_PROTOCOL, kind: 'profile', revision: state.revision, userInfo: publicProfile(host.profile) };
    });
  }
  profileV2(token, input) {
    exactInput(input, ['expectedConsentRevision']);
    return this.identityTransaction(() => {
      const { host, scope } = this.sessionScopeV2(token);
      const state = this.consentV2.granted(scope, 'profile', input.expectedConsentRevision);
      return { identityProtocol: IDENTITY_PROTOCOL, kind: 'profile', revision: state.revision, userInfo: publicProfile(host.profile) };
    });
  }
  phoneCodeV2(token, selection) {
    this.selectionV2(selection, ['expectedConsentRevision']);
    return this.identityTransaction(() => {
      const { host, scope } = this.hostScopeV2(token, selection);
      const state = this.consentV2.granted(scope, 'phone', selection.expectedConsentRevision);
      requireThat(host.phone, 'phone_unavailable', 'Host backend has no verified phone number', 409);
      const result = this.makeCode(host, scope, 'phone-v2', selection.packRoot, state.revision);
      return { identityProtocol: IDENTITY_PROTOCOL, kind: 'phone', revision: state.revision, ...result };
    });
  }
  exchangePhoneV2(clientId, secret, input) {
    exactInput(input, ['code', 'appAccessToken']);
    const app = this.authenticateClient(clientId, secret);
    const id = digest(text(input.code, 'code', 1024));
    text(input.appAccessToken, 'appAccessToken', 1024);
    return this.identityTransaction(() => {
      requireThat(this.strictIdentity(app.miniAppId), 'identity_protocol_required', 'Application does not support identity protocol 2.0', 426);
      const row = this.db.prepare('SELECT * FROM codes WHERE id=?').get(id), record = parse(row);
      requireThat(record && row.app_id === app.miniAppId && row.client_id === app.clientId && !row.consumed && record.expiresAt > this.now(),
        'invalid_code', 'Code is expired, consumed, or belongs to another app', 401);
      requireThat(row.kind === 'phone-v2' && record.identityProtocol === IDENTITY_PROTOCOL, 'identity_protocol_required', 'Phone code was not issued by identity protocol 2.0', 426);
      const host = this.hostRecord(record.hostId), scope = this.appScope(host, app.miniAppId, record.packRoot);
      requireThat(record.scope.publisherId === scope.publisherId && record.consentDomain === domainKey(scope) && domainKey(record.scope) === domainKey(scope), 'invalid_code', 'Phone code trusted scope changed', 401);
      const expected = this.sessionScopeV2(input.appAccessToken);
      requireThat(ownerKey(expected.scope) === ownerKey(record.scope) && domainKey(expected.scope) === domainKey(scope) && expected.session.packRoot === record.packRoot,
        'phone_owner_mismatch', 'Phone code belongs to another business user', 403);
      const state = this.consentV2.granted(scope, 'phone', record.consentRevision);
      requireThat(host.phone, 'phone_unavailable', 'Host backend has no verified phone number', 409);
      this.db.prepare('UPDATE codes SET consumed=1 WHERE id=?').run(id);
      return { identityProtocol: IDENTITY_PROTOCOL, kind: 'phone', revision: state.revision, phoneNumber: host.phone };
    });
  }
  logoutApp(token) {
    const session = this.session(token);
    return this.revokeAppSessions(session.scope);
  }
  logoutAppForHost(token, selection) {
    const { miniAppId, packRoot } = selection;
    const host = this.host(token, selection), scope = this.appScope(host, miniAppId, packRoot);
    return this.revokeAppSessions(scope);
  }
  revokeAppSessions(scope) {
    this.transaction(() => {
      for (const [table, field] of [['sessions', 'revoked'], ['codes', 'consumed']]) {
        for (const row of this.db.prepare(`SELECT * FROM ${table} WHERE app_id=?`).all(scope.miniAppId)) {
          if (ownerKey(parse(row).scope) === ownerKey(scope)) this.db.prepare(`UPDATE ${table} SET ${field}=1 WHERE id=?`).run(row.id);
        }
      }
    }); return { loggedOut: true, hostSessionRetained: true, consentsRetained: true };
  }
  publicOrder(order, includeLaunch = false) {
    return { orderId: order.id, merchantOrderId: order.merchantOrderId, channel: order.channel, product: order.product,
      amount: order.amount, currency: order.currency, status: order.status, submission: order.submission,
      clientWaitCancelled: order.clientWaitCancelled, createdAt: order.createdAt,
      ...(includeLaunch && order.launch ? { launch: order.launch } : {}) };
  }
  order(id) { const order = parse(this.db.prepare('SELECT data FROM orders WHERE id=?').get(text(id, 'orderId'))); requireThat(order, 'unknown_order', 'Order not found', 404); return order; }
  ownedOrder(session, id) { const order = this.order(id); requireThat(order.ownerKey === ownerKey(session.scope), 'order_forbidden', 'Order belongs to another app or principal', 403); return order; }
  saveOrder(order) { this.db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(order), order.id); }
  async createOrder(token, input) {
    const session = this.session(token), app = this.application(session.scope.miniAppId), channel = text(input.channel, 'channel'), product = text(input.product, 'product');
    requireThat(this.providers[channel] && app.allowedPaymentChannels?.includes(channel), 'channel_unavailable', 'Payment channel is not configured for this app', 403);
    requireThat(['app', 'jsapi', 'h5', 'native'].includes(product), 'unsupported_product', 'Unknown payment product');
    const request = { channel, product, amount: integer(input.amount, 'amount', 1, 100000000000),
      currency: input.currency ?? 'CNY', description: text(input.description, 'description', 120),
      paymentContext: { ...(input.paymentContext?.openid ? { openid: text(input.paymentContext.openid, 'openid') } : {}),
        ...(input.paymentContext?.buyerId ? { buyerId: text(input.paymentContext.buyerId, 'buyerId') } : {}),
        ...(input.paymentContext?.payerClientIp ? { payerClientIp: text(input.paymentContext.payerClientIp, 'payerClientIp', 64) } : {}) } };
    requireThat(request.currency === 'CNY', 'unsupported_currency', 'Reference adapters currently support CNY only');
    const dedupKey = key([ownerKey(session.scope), text(input.idempotencyKey, 'idempotencyKey', 128)]), requestHash = key(request);
    const existing = parse(this.db.prepare('SELECT data FROM orders WHERE dedup_key=?').get(dedupKey));
    if (existing) { requireThat(existing.requestHash === requestHash, 'idempotency_conflict', 'Idempotency key was used with another request', 409); return this.publicOrder(existing, true); }
    const order = { id: randomUUID(), miniAppId: app.miniAppId, ownerKey: ownerKey(session.scope), scope: session.scope, requestHash,
      merchantOrderId: `wc${randomUUID().replaceAll('-', '').slice(0, 28)}`, ...request, createdAt: this.now(), status: 'pending',
      submission: 'submitting', clientWaitCancelled: false };
    // Reserve before asynchronous I/O: retries and concurrent requests share one merchant order.
    this.db.prepare('INSERT INTO orders(id,owner_key,dedup_key,merchant_id,data) VALUES(?,?,?,?,?)')
      .run(order.id, order.ownerKey, dedupKey, order.merchantOrderId, JSON.stringify(order));
    try {
      const result = await this.providers[channel].create(order);
      const current = this.order(order.id);
      current.launch = result.launch; current.submission = 'submitted';
      // A callback can complete while create() is awaiting the provider.
      this.saveOrder(current); return this.publicOrder(current, true);
    } catch (error) {
      const current = this.order(order.id); current.submission = 'uncertain'; this.saveOrder(current);
      throw new ServiceError('payment_submission_uncertain', `Payment submission could not be confirmed; reconcile order ${order.id} before retrying`, 502);
    }
  }
  getOrder(token, id) { return this.publicOrder(this.ownedOrder(this.session(token), id), true); }
  launchForHost(token, id, selection) {
    const { miniAppId, packRoot } = selection;
    const host = this.host(token, selection), scope = this.appScope(host, miniAppId, packRoot);
    return this.publicOrder(this.ownedOrder({ scope }, id), true);
  }
  cancelWait(token, id) { const order = this.ownedOrder(this.session(token), id); order.clientWaitCancelled = true; this.saveOrder(order); return this.publicOrder(order); }
  applyPayment(order, event) {
    this.providers[order.channel].validate(order, event);
    requireThat(event.merchantOrderId === order.merchantOrderId && event.amount === order.amount && event.currency === order.currency,
      'payment_mismatch', 'Payment order, amount or currency mismatch');
    requireThat(['pending', 'paid', 'closed', 'refunded'].includes(event.status), 'invalid_notification', 'Unknown payment status');
    if (['paid', 'refunded'].includes(event.status)) text(event.transactionId, 'provider transaction ID');
    if (order.transactionId && event.transactionId) requireThat(order.transactionId === event.transactionId, 'payment_mismatch', 'Provider transaction ID changed');
    const before = order.status;
    if (before !== 'refunded' && !(before === 'paid' && ['pending', 'closed'].includes(event.status))) order.status = event.status;
    if (event.transactionId) order.transactionId = event.transactionId;
    order.updatedAt = this.now(); this.saveOrder(order);
    return { becamePaid: before !== 'paid' && before !== 'refunded' && order.status === 'paid', order: this.publicOrder(order) };
  }
  async reconcileOrder(token, id) {
    const order = this.ownedOrder(this.session(token), id), event = await this.providers[order.channel].query(order);
    return this.transaction(() => this.applyPayment(this.order(order.id), event));
  }
  notification(channel, headers, raw) {
    const provider = this.providers[channel]; requireThat(provider, 'channel_unavailable', 'Payment channel is not configured', 404);
    const event = provider.notification(headers, raw), eventKey = key([channel, text(event.eventId, 'eventId')]), payloadHash = digest(raw);
    return this.transaction(() => {
      const found = this.db.prepare('SELECT * FROM payment_events WHERE id=?').get(eventKey);
      if (found) { requireThat(found.payload_hash === payloadHash, 'event_conflict', 'Event ID was replayed with a different authenticated payload', 409); return { duplicate: true, becamePaid: false }; }
      const order = parse(this.db.prepare('SELECT data FROM orders WHERE merchant_id=?').get(event.merchantOrderId));
      requireThat(order && order.channel === channel, 'unknown_order', 'Payment order is not registered for this channel', 404);
      const result = this.applyPayment(order, event);
      this.db.prepare('INSERT INTO payment_events(id,payload_hash,data) VALUES(?,?,?)').run(eventKey, payloadHash, JSON.stringify({ orderId: order.id, event, receivedAt: this.now() }));
      return { duplicate: false, ...result };
    });
  }
}
