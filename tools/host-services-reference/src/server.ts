import type { IncomingMessage, RequestListener } from 'node:http';
import type { HostServices } from './service.ts';
import type { Input } from './types.ts';
import { createServer } from 'node:http';
import { requireThat, ServiceError, text } from './errors.ts';

const bearer = (request: IncomingMessage) => {
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(request.headers.authorization ?? '');
  requireThat(match, 'authentication_required', 'Bearer authentication required', 401); return match[1];
};
const client = (request: IncomingMessage): [string, string] => {
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(request.headers.authorization ?? '');
  requireThat(match, 'invalid_client', 'Confidential client Basic authentication required', 401);
  const decoded = Buffer.from(match[1], 'base64').toString('utf8'), colon = decoded.indexOf(':');
  requireThat(colon > 0, 'invalid_client', 'Invalid Basic client credentials', 401);
  return [decoded.slice(0, colon), decoded.slice(colon + 1)];
};
async function body(request: IncomingMessage) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; requireThat(bytes <= 262144, 'body_too_large', 'Body exceeds 256 KiB', 413); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function parsed(request: IncomingMessage, raw: string): Input {
  requireThat((request.headers['content-type'] ?? '').split(';')[0] === 'application/json', 'invalid_content_type', 'Use application/json', 415);
  let value; try { value = JSON.parse(raw); } catch { throw new ServiceError('invalid_json', 'Invalid JSON request'); }
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'invalid_request', 'Request body must be a JSON object'); return value;
}

export function createHostServicesHandler(service: HostServices): RequestListener {
  return async (request, response) => {
    const send = (status: number, value: any, type = 'application/json') => {
      const encoded = type === 'application/json' ? JSON.stringify(value) : value;
      requireThat(Buffer.byteLength(encoded) <= 262144, 'response_too_large', 'Response exceeds 256 KiB', 500);
      response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(encoded);
    };
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname, method = request.method;
      if (method === 'GET' && path === '/health') return send(200, { status: 'ok', service: 'host-services-reference' });
      const raw = await body(request);
      const callback = /^\/v1\/payments\/callbacks\/(reference|wechat|alipay)$/.exec(path);
      if (method === 'POST' && callback) {
        service.notification(callback[1], request.headers, raw);
        if (callback[1] === 'alipay') return send(200, 'success', 'text/plain');
        if (callback[1] === 'wechat') { response.writeHead(204, { 'Cache-Control': 'no-store' }); return response.end(); }
        return send(200, { accepted: true });
      }
      if (method === 'POST' && path === '/v1/issuer/host-sessions') {
        service.authenticateIssuer(bearer(request)); return send(201, service.issueHostSession(parsed(request, raw)));
      }
      if (method === 'POST' && path === '/v1/issuer/principal-epochs') {
        service.authenticateIssuer(bearer(request)); return send(200, service.revokePrincipal(parsed(request, raw)));
      }
      if (method === 'POST' && path === '/v1/issuer/principal-delete') {
        service.authenticateIssuer(bearer(request)); return send(200, service.deletePrincipal(parsed(request, raw)));
      }
      const hostV2 = ({
        '/v2/host/identity-capabilities': ['identityCapabilitiesV2', 200],
        '/v2/host/authorization-policy': ['authorizationPolicyV2', 200],
        '/v2/host/consents': ['setConsentV2', 200],
        '/v2/host/identity-state': ['identityStateV2', 200],
        '/v2/host/profile': ['hostProfileV2', 200],
        '/v2/host/phone-codes': ['phoneCodeV2', 201],
      } satisfies Record<string, [keyof HostServices, number]>)[path as '/v2/host/identity-capabilities'];
      if (method === 'POST' && hostV2) return send(hostV2[1], service[hostV2[0]](bearer(request), parsed(request, raw)));
      if (method === 'POST' && path === '/v2/apps/profile') return send(200, service.profileV2(bearer(request), parsed(request, raw)));
      if (method === 'POST' && path === '/v2/apps/exchange-phone') return send(200, service.exchangePhoneV2(...client(request), parsed(request, raw)));
      if (method === 'POST' && path === '/v1/host/login-codes') return send(201, service.loginCode(bearer(request), parsed(request, raw)));
      if (method === 'POST' && path === '/v1/host/identity-state') return send(200, service.identityState(bearer(request), parsed(request, raw)));
      if (method === 'POST' && path === '/v1/host/check-session') return send(200, service.checkSession(bearer(request), parsed(request, raw)));
      if (method === 'POST' && path === '/v1/host/authorization-policy') return send(200, service.authorizationPolicy(bearer(request), parsed(request, raw)));
      if (method === 'POST' && path === '/v1/host/consents') return send(200, service.setConsent(bearer(request), parsed(request, raw)));
      if (method === 'POST' && path === '/v1/host/phone-codes') return send(201, service.phoneCode(bearer(request), parsed(request, raw)));
      if (method === 'POST' && path === '/v1/host/profile') return send(200, service.hostProfile(bearer(request), parsed(request, raw)));
      if (method === 'POST' && path === '/v1/host/app-logout') return send(200, service.logoutAppForHost(bearer(request), parsed(request, raw)));
      if (method === 'POST' && path === '/v1/host/logout') return send(200, service.logoutHost(bearer(request)));
      if (method === 'POST' && path === '/v1/apps/exchange-login') { const credentials = client(request); return send(200, service.exchangeLogin(...credentials, parsed(request, raw).code)); }
      if (method === 'POST' && path === '/v1/apps/exchange-phone') {
        const credentials = client(request), input = parsed(request, raw);
        // Public HTTP callers must bind the one-time phone code to the
        // currently authenticated business user.  The service method keeps
        // its omitted fourth argument only for trusted in-process callers.
        return send(200, service.exchangePhone(...credentials, input.code, text(input.appAccessToken, 'appAccessToken', 1024)));
      }
      if (method === 'GET' && path === '/v1/apps/profile') return send(200, service.profile(bearer(request)));
      if (method === 'POST' && path === '/v1/apps/logout') return send(200, service.logoutApp(bearer(request)));
      if (method === 'POST' && path === '/v1/payments/orders') return send(201, await service.createOrder(bearer(request), parsed(request, raw)));
      const order = /^\/v1\/payments\/orders\/([A-Za-z0-9-]+)(?:\/(reconcile|cancel-wait|launch))?$/.exec(path);
      if (order) {
        if (method === 'GET' && !order[2]) return send(200, service.getOrder(bearer(request), order[1]));
        if (method === 'POST' && order[2] === 'reconcile') return send(200, await service.reconcileOrder(bearer(request), order[1]));
        if (method === 'POST' && order[2] === 'cancel-wait') return send(200, service.cancelWait(bearer(request), order[1]));
        if (method === 'POST' && order[2] === 'launch') return send(200, service.launchForHost(bearer(request), order[1], parsed(request, raw)));
      }
      return send(404, { error: 'not_found', message: 'Unknown endpoint' });
    } catch (error) {
      // Never log credentials, tokens, provider responses, keys, phone numbers or raw bodies.
      const known = error instanceof ServiceError;
      if (!response.headersSent) send(known ? error.status : 500, { error: known ? error.code : 'internal_error', message: known ? error.message : 'Internal service error' });
      else response.end();
    }
  };
}

export function createHostServicesServer(service: HostServices) {
  const server = createServer(createHostServicesHandler(service));
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  return server;
}
