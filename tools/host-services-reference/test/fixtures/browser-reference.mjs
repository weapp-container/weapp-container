import { randomBytes } from 'node:crypto';
import { HostServices } from '../../src/service.ts';
import { createHostServicesHandler } from '../../src/server.ts';
import { equalSecret } from '../../src/crypto.ts';
import { requireThat, ServiceError, text } from '../../src/errors.ts';

const secret = () => randomBytes(32).toString('base64url');
const bearer = request => /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(request.headers.authorization ?? '')?.[1];
async function body(request) {
  requireThat((request.headers['content-type'] ?? '').split(';')[0] === 'application/json', 'invalid_content_type', 'Use application/json', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length; requireThat(size <= 262144, 'body_too_large', 'Body exceeds 256 KiB', 413); chunks.push(chunk);
  }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError('invalid_json', 'JSON object required'); }
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'invalid_request', 'JSON object required');
  return value;
}
const send = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
};

/** Integration fixture only, mounted ahead of an explicit static route map.
 * This is not another deployment service or a production identity gateway.
 * Confidential app/issuer credentials and redeemed app bearers stay in Node.
 * The independent control credential is for the browser host closure only.
 */
export function createWebIdentityReferenceFixture({ applications, now = Date.now } = {}) {
  requireThat(Array.isArray(applications) && applications.length > 0 && applications.length <= 8,
    'fixture_configuration', 'Configure one to eight trusted applications');
  const registry = new Map();
  for (const [index, input] of applications.entries()) {
    const appId = text(input.miniAppId ?? input.appId, 'miniAppId');
    requireThat(!registry.has(appId), 'fixture_configuration', 'Duplicate application');
    requireThat(/^[a-f0-9]{64}$/.test(input.packRoot ?? ''), 'fixture_configuration', 'Verified pack root required');
    const application = { hostAppId: input.hostAppId ?? 'web-reference-host', tenantId: input.tenantId ?? 'reference-tenant',
      publisherId: input.publisherId ?? 'reference-publisher', appId, environment: input.environment ?? 'develop',
      version: input.version ?? '1', packRoot: input.packRoot };
    for (const [name, value] of Object.entries(application)) text(value, name);
    registry.set(appId, { application, clientId: `browser-reference-business-${index}`, clientSecret: secret() });
  }
  const controlToken = secret(), service = new HostServices({ issuerSecret: secret(), identitySecret: secret(),
    applications: [...registry.values()].map(({ application: a, clientId, clientSecret }) => ({
      // The installed v1 browser client is a legacy fixture until its v2/fence integration is accepted.
      miniAppId: a.appId, identityProtocol: '1.0', publisherId: a.publisherId, hostAppId: a.hostAppId, tenantId: a.tenantId, environment: a.environment,
      clientId, clientSecret, trustedPackRoots: [a.packRoot], authorizationPolicies: {
        profile: { purpose: 'Display the authorized profile in this application', permissionVersion: 'profile-v1' },
        phone: { purpose: 'Associate the verified phone with this application', permissionVersion: 'phone-v1' },
      },
    })),
  }, { now });
  const core = createHostServicesHandler(service), sessions = new Map(), active = new Set();
  const counters = { hostSessions: 0, businessExchanges: 0, delayedLoginResponses: 0 };
  let origin, closing = false, closePromise, nextSequence = 0, delay = null, businessReservations = 0;
  const choose = miniAppId => {
    const entry = registry.get(miniAppId ?? (registry.size === 1 ? registry.keys().next().value : null));
    requireThat(entry, 'unknown_app', 'Choose a registered miniAppId', 404); return entry;
  };
  const control = request => requireThat(equalSecret(bearer(request), controlToken), 'invalid_fixture_control', 'Host control credential required', 401);
  const delayState = () => ({ sequence: delay?.sequence ?? null, armed: delay?.armed ?? false,
    issued: delay?.issued ?? false, pending: delay?.pending ?? false, released: delay?.released ?? false });
  const backend = async (path, input, authorization) => {
    // The target is fixed by this harness, never a guest URL or an open proxy.
    const response = await fetch(origin + path, { method: input === undefined ? 'GET' : 'POST',
      headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), Authorization: authorization },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), redirect: 'error', signal: AbortSignal.timeout(5000) });
    const value = await response.json();
    if (!response.ok) throw new ServiceError(typeof value.error === 'string' ? value.error : 'backend_rejected',
      typeof value.message === 'string' ? value.message : 'Reference backend rejected request', response.status);
    return value;
  };
  const business = token => {
    const session = sessions.get(token);
    requireThat(session && session.expiresAt > now(), 'invalid_business_session', 'Business session expired', 401);
    service.session(session.accessToken); return session;
  };
  async function routes(request, response, path) {
    requireThat(origin && request.headers.host === new URL(origin).host, 'fixture_host_rejected', 'Bound loopback Host required', 403);
    requireThat(!request.headers.origin || request.headers.origin === origin, 'fixture_origin_rejected', 'Same origin required', 403);
    requireThat(request.headers['sec-fetch-site'] !== 'cross-site', 'fixture_origin_rejected', 'Cross-site request rejected', 403);
    requireThat(!closing, 'fixture_closed', 'Fixture is closing', 503);
    if (path === '/fixture/host' && request.method === 'POST') {
      control(request); const input = await body(request), entry = choose(input.miniAppId), a = entry.application;
      requireThat(['alice', 'bob'].includes(input.principalId), 'invalid_fixture_principal', 'Use alice or bob');
      // Fixed trusted fixture records, not guest-supplied profile/phone data.
      const issued = service.issueHostSession({ hostAppId: a.hostAppId, tenantId: a.tenantId, environment: a.environment,
        principalId: input.principalId, principalEpoch: input.principalEpoch,
        profile: { nickName: input.principalId === 'alice' ? 'Alice' : 'Bob' }, phone: '+8613800000000' });
      counters.hostSessions++;
      return send(response, 201, { ...issued, application: a, account: { principalId: input.principalId, epoch: issued.principalEpoch }, referenceOnly: true });
    }
    if (path === '/fixture/login-delay') {
      control(request);
      if (request.method === 'GET') return send(response, 200, delayState());
      if (request.method === 'POST') {
        const input = await body(request);
        if (input.action === 'arm') {
          requireThat(!delay || delay.released, 'fixture_delay_busy', 'Previous login delay has not been released', 409);
          let release; const wait = new Promise(resolve => { release = resolve; });
          delay = { sequence: ++nextSequence, armed: true, issued: false, pending: false, released: false, wait, release };
        } else if (input.action === 'release') {
          requireThat(delay && input.sequence === delay.sequence, 'fixture_delay_mismatch', 'Release the exact delay sequence', 409);
          delay.armed = false; delay.released = true; delay.release();
        } else throw new ServiceError('invalid_request', 'Choose arm or release');
        return send(response, 200, delayState());
      }
    }
    if (path === '/business/exchange' && request.method === 'POST') {
      const input = await body(request), entry = choose(input.miniAppId);
      for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
      // Reserve before awaiting HTTP, so concurrent exchanges cannot overflow
      // the bounded map or consume a code when no local session can be kept.
      requireThat(sessions.size + businessReservations < 256, 'fixture_session_limit', 'Business session limit reached', 503);
      businessReservations++;
      try {
        const app = await backend('/v1/apps/exchange-login', { code: text(input.code, 'code', 1024) },
          'Basic ' + Buffer.from(`${entry.clientId}:${entry.clientSecret}`).toString('base64'));
        const businessSession = secret();
        sessions.set(businessSession, { accessToken: app.accessToken, appUserId: app.appUserId,
          miniAppId: entry.application.appId, expiresAt: now() + app.expiresIn * 1000 });
        counters.businessExchanges++;
        return send(response, 200, { businessSession, appUserId: app.appUserId, expiresIn: app.expiresIn });
      } finally { businessReservations--; }
    }
    if (path === '/business/session' && request.method === 'GET') {
      const session = business(bearer(request));
      return send(response, 200, { appUserId: session.appUserId, miniAppId: session.miniAppId });
    }
    if (path === '/business/logout' && request.method === 'POST') {
      const input = await body(request), session = business(input.businessSession);
      const result = await backend('/v1/apps/logout', {}, `Bearer ${session.accessToken}`);
      sessions.delete(input.businessSession); return send(response, 200, result);
    }
    if (path === '/business/phone' && request.method === 'POST') {
      const input = await body(request), session = business(input.businessSession), entry = choose(session.miniAppId);
      const result = await backend('/v1/apps/exchange-phone', { code: text(input.code, 'code', 1024), appAccessToken: session.accessToken },
        'Basic ' + Buffer.from(`${entry.clientId}:${entry.clientSecret}`).toString('base64'));
      return send(response, 200, result);
    }
    if (path === '/v1/host/login-codes' && request.method === 'POST' && delay?.armed) {
      const gate = delay; gate.armed = false;
      const captured = { headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(value) { this.body = value; } };
      await core(request, captured);
      if (captured.status >= 200 && captured.status < 300) {
        gate.issued = true; gate.pending = true; counters.delayedLoginResponses++;
        await gate.wait; gate.pending = false;
      }
      if (!response.destroyed) { response.writeHead(captured.status, captured.headers); response.end(captured.body); }
      return;
    }
    if (path === '/health' || path.startsWith('/v1/')) return core(request, response);
    return send(response, 404, { error: 'not_found', message: 'Unknown fixture endpoint' });
  }
  return {
    controlToken,
    publicConfiguration: Object.freeze({ referenceOnly: true, applications: [...registry.values()].map(entry => structuredClone(entry.application)) }),
    bindOrigin(value) {
      const parsed = new URL(value);
      requireThat(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) &&
        parsed.origin === value && !parsed.username && !parsed.password && (!origin || origin === value),
      'fixture_configuration', 'Bind one exact loopback HTTP origin'); origin = parsed.origin;
    },
    async handle(request, response) {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path !== '/health' && !['/v1/', '/fixture/', '/business/'].some(prefix => path.startsWith(prefix))) return false;
      const operation = (async () => {
        try { await routes(request, response, path); }
        catch (error) {
          if (response.destroyed) return;
          const known = error instanceof ServiceError;
          if (!response.headersSent) send(response, known ? error.status : 500,
            { error: known ? error.code : 'internal_error', message: known ? error.message : 'Reference fixture failed' });
          else response.end();
        }
      })();
      active.add(operation); try { await operation; } finally { active.delete(operation); }
      return true;
    },
    observations: () => ({ ...counters, activeRequests: active.size, delay: delayState() }),
    close() {
      return closePromise ??= (async () => {
        closing = true;
        if (delay) { delay.armed = false; delay.released = true; delay.release(); }
        await Promise.allSettled([...active]); sessions.clear(); service.close();
      })();
    },
  };
}
