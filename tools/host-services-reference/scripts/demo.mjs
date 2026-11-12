import { randomBytes } from 'node:crypto';
import { HostServices } from '../src/service.mjs';
const policies = { profile: { purpose: 'Display the authorized profile', permissionVersion: '1' }, phone: { purpose: 'Associate the verified phone', permissionVersion: '1' } };
import { referenceSignature } from '../src/crypto.mjs';

const secret = () => randomBytes(32).toString('base64url');
const packRoot = 'a'.repeat(64), clientSecret = secret(), callbackSecret = secret();
const service = new HostServices({ issuerSecret: secret(), identitySecret: secret(), applications: [{
  miniAppId: 'demo', publisherId: 'publisher', identityProtocol: '2.0', clientId: 'demo-backend', clientSecret, hostAppId: 'host', tenantId: 'tenant', environment: 'develop',
  trustedPackRoots: [packRoot], allowedPaymentChannels: ['reference'], authorizationPolicies: policies,
}], payments: { reference: { callbackSecret } } });
try {
  const host = service.issueHostSession({ hostAppId: 'host', tenantId: 'tenant', environment: 'develop', principalId: 'verified-user', principalEpoch: '1',
    profile: { nickName: 'Demo user' }, phone: '+8613800000000' });
  const code = service.loginCode(host.hostAccessToken, { miniAppId: 'demo', packRoot });
  const app = service.exchangeLogin('demo-backend', clientSecret, code.code);
  const selection = { miniAppId: 'demo', packRoot, expectedPublisherId: 'publisher', expectedPrincipalId: 'verified-user', expectedPrincipalEpoch: '1' };
  const policy = service.authorizationPolicyV2(host.hostAccessToken, { ...selection, kind: 'profile' });
  const consent = service.setConsentV2(host.hostAccessToken, { ...selection, kind: 'profile', granted: true, decisionId: secret(),
    challengeId: policy.challengeId, expectedRevision: policy.revision, purpose: policy.purpose, permissionVersion: policy.permissionVersion });
  const order = await service.createOrder(app.accessToken, { channel: 'reference', product: 'app', amount: 1, currency: 'CNY', description: 'Reference demo only', idempotencyKey: 'demo-1' });
  const raw = JSON.stringify({ eventId: 'demo-event', merchantOrderId: order.merchantOrderId, miniAppId: 'demo', transactionId: 'reference-demo-transaction', amount: 1, currency: 'CNY', status: 'paid' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  service.notification('reference', { 'x-reference-timestamp': timestamp, 'x-reference-signature': referenceSignature(callbackSecret, timestamp, raw) }, raw);
  console.log(JSON.stringify({ referenceOnly: true, identityProtocol: '2.0',
    profile: service.profileV2(app.accessToken, { expectedConsentRevision: consent.revision }).userInfo,
    payment: service.getOrder(app.accessToken, order.orderId) }, null, 2));
} finally { service.close(); }
