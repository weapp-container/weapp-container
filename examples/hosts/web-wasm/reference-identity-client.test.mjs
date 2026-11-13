import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostServices } from '../../../tools/host-services-reference/src/service.ts'
import { createHostServicesHandler } from '../../../tools/host-services-reference/src/server.ts'
import { createReferenceIdentityClient, ReferenceIdentityError } from './reference-identity-client.mjs'

const policies = { profile: { purpose: 'Display your authorized profile', permissionVersion: 'profile-v1' },
  phone: { purpose: 'Link your verified phone', permissionVersion: 'phone-v1' } }
const application = { hostAppId: 'host', tenantId: 'tenant', publisherId: 'publisher', appId: 'first', environment: 'release', version: '1', packRoot: 'a'.repeat(64) }
const account = { principalId: 'alice', epoch: '9007199254740993' }
const context = { application, account, sessionId: 'owner-A', callId: 'call-A', api: 'wx.login' }
const call = (extra = {}) => ({ context: structuredClone(context), signal: new AbortController().signal, ...extra })
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const noLogout = () => ({ operationId: 'logout-1', status: 'running', epoch: account.epoch })

async function http(t, handler) {
  const server = createServer(handler)
  server.requestTimeout = 5000
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return `http://127.0.0.1:${server.address().port}`
}
const send = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
async function fixture(t, { intercept, confirm = async () => true, logout = noLogout, tokenProvider, fetchImpl } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'weapp-identity-sqlite-'))
  const clientSecret = 'business-only-client-secret-'.repeat(3)
  const service = new HostServices({ database: join(directory, 'accounts.sqlite'), issuerSecret: 'issuer-only-'.repeat(5), identitySecret: 'identity-only-'.repeat(5), applications: ['first', 'other'].map(miniAppId => ({
    miniAppId, identityProtocol: '1.0', hostAppId: 'host', tenantId: 'tenant', environment: 'release', clientId: `business-${miniAppId}`, clientSecret,
    trustedPackRoots: [application.packRoot], allowedPaymentChannels: [], authorizationPolicies: policies,
  })) })
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }) })
  const host = service.issueHostSession({ hostAppId: 'host', tenantId: 'tenant', environment: 'release', principalId: 'alice', principalEpoch: account.epoch,
    phone: '+8613800000001', profile: { nickName: 'Alice', avatarUrl: 'https://images.example/alice.png', privateField: 'not-public' } })
  const otherHost = service.issueHostSession({ hostAppId: 'host', tenantId: 'tenant', environment: 'release', principalId: 'bob', principalEpoch: account.epoch,
    phone: '+8613800000002', profile: { nickName: 'Bob' } })
  const requests = [], handler = createHostServicesHandler(service)
  const endpoint = await http(t, async (request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie })
    if (intercept && await intercept(request, response, { service, host, otherHost })) return
    await handler(request, response)
  })
  const client = createReferenceIdentityClient({ endpoint, allowLoopbackHTTP: true,
    hostToken: tokenProvider || (async ({ context: captured }) => captured.account.principalId === 'alice' ? host.hostAccessToken : otherHost.hostAccessToken),
    confirmAuthorization: confirm, requestLogout: logout, ...(fetchImpl ? { fetchImpl } : {}) })
  const selection = { miniAppId: application.appId, packRoot: application.packRoot, expectedPrincipalId: account.principalId, expectedPrincipalEpoch: account.epoch }
  const exchange = async code => {
    const response = await fetch(endpoint + '/v1/apps/exchange-login', { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`business-first:${clientSecret}`).toString('base64')}` }, body: JSON.stringify({ code }) })
    assert.equal(response.status, 200); return response.json()
  }
  return { client, service, host, otherHost, endpoint, requests, selection, exchange, clientSecret }
}

test('real SQLite/HTTP: consent may precede login; code issuance does not redeem a session', async t => {
  const confirmations = [], f = await fixture(t, { confirm: async value => { confirmations.push(value); return true } })
  assert.deepEqual(await f.client.getState({}, call()), { hostLoggedIn: true, appLoggedIn: false, profileAuthorized: false, phoneAuthorized: false,
    authorizationVersion: f.service.identityState(f.host.hostAccessToken, f.selection).authorizationVersion })
  await assert.rejects(f.client.getUserInfo({}, call()), error => error.code === 'permission_denied')
  assert.equal(confirmations.length, 0, 'getUserInfo cannot implicitly prompt or grant')
  const profile = await f.client.getUserProfile({ desc: 'guest tries to replace purpose' }, call())
  assert.equal(profile.userInfo.nickName, 'Alice'); assert.equal(profile.userInfo.privateField, undefined)
  assert.equal(confirmations[0].purpose, policies.profile.purpose)
  assert.equal(confirmations[0].permissionVersion, policies.profile.permissionVersion)
  assert.ok(Object.isFrozen(confirmations[0].application) && Object.isFrozen(confirmations[0].account))
  const before = await f.client.getState({}, call())
  assert.equal(before.profileAuthorized, true); assert.equal(before.appLoggedIn, false)
  const login = await f.client.login({ miniAppId: 'other', hostAccessToken: 'guest-token' }, call())
  assert.equal((await f.client.getState({}, call())).appLoggedIn, false)
  await assert.rejects(f.client.checkSession({}, call()), error => error.code === 'permission_denied' && error.backendCode === 'invalid_app_session')
  const business = await f.exchange(login.code)
  assert.ok(business.accessToken)
  assert.equal((await f.client.getState({}, call())).appLoggedIn, true)
  assert.equal((await f.client.checkSession({}, call())).valid, true)
  assert.ok(!JSON.stringify({ profile, login, before }).includes(f.host.hostAccessToken))
  assert.ok(!JSON.stringify(login).includes(f.clientSecret))
  assert.ok(f.requests.filter(value => value.path.startsWith('/v1/host/')).every(value => value.authorization === `Bearer ${f.host.hostAccessToken}` && value.cookie === undefined))
})

test('real SQLite/HTTP: phone consent returns a one-time code and logout retains consents', async t => {
  let f, invoked = 0
  const abort = new AbortController()
  f = await fixture(t, { logout: ({ context: captured, backendResult }) => {
    invoked++; assert.equal(captured.account.epoch, account.epoch); assert.equal(backendResult.consentsRetained, true)
    assert.equal(f.service.identityState(f.host.hostAccessToken, f.selection).appLoggedIn, false)
    abort.abort(); return noLogout()
  } })
  const login = await f.client.login({}, call()); const business = await f.exchange(login.code)
  await f.client.getUserProfile({}, call())
  const phone = await f.client.authorizePhone({ purpose: 'guest-purpose' }, call())
  assert.ok(phone.code); assert.equal(phone.phoneNumber, undefined)
  const response = await fetch(f.endpoint + '/v1/apps/exchange-phone', { method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: `Basic ${Buffer.from(`business-first:${f.clientSecret}`).toString('base64')}` }, body: JSON.stringify({ code: phone.code, appAccessToken: business.accessToken }) })
  assert.equal(response.status, 200); assert.equal((await response.json()).phoneNumber, '+8613800000001')
  assert.deepEqual(await f.client.logout({}, call({ signal: abort.signal })), noLogout(), 'logout cannot wait on its own retired execution owner')
  assert.equal(invoked, 1)
  const state = await f.client.getState({}, call())
  assert.equal(state.hostLoggedIn, true); assert.equal(state.appLoggedIn, false)
  assert.equal(state.profileAuthorized, true); assert.equal(state.phoneAuthorized, true)
})

test('signed-out snapshots perform no token-provider or fetch work', async () => {
  let tokens = 0, requests = 0
  const client = createReferenceIdentityClient({ endpoint: 'https://identity.example', hostToken: () => { tokens++; throw new Error('unexpected') },
    confirmAuthorization: async () => true, requestLogout: noLogout, fetchImpl: async () => { requests++; throw new Error('unexpected') } })
  const guest = call(); guest.context.account.principalId = null
  assert.deepEqual(await client.getState({}, guest), { hostLoggedIn: false, appLoggedIn: false, profileAuthorized: false, phoneAuthorized: false })
  assert.equal(tokens, 0); assert.equal(requests, 0)
  await assert.rejects(client.login({}, guest), error => error.code === 'permission_denied')
  assert.equal(tokens, 0)
})

test('explicit denial is persisted; cancelled or invalid host confirmation never grants', async t => {
  const f = await fixture(t, { confirm: async () => false })
  await assert.rejects(f.client.getUserProfile({}, call()), error => error.code === 'permission_denied' && error.errMsg === 'getUserProfile:fail auth deny')
  assert.equal((await f.client.getState({}, call())).profileAuthorized, false)
  assert.equal(f.requests.filter(value => value.path === '/v1/host/consents').length, 1)
  const entered = defer(), abort = new AbortController()
  const pending = createReferenceIdentityClient({ endpoint: f.endpoint, allowLoopbackHTTP: true, hostToken: () => f.host.hostAccessToken,
    confirmAuthorization: async () => { entered.resolve(); return new Promise(() => {}) }, requestLogout: noLogout })
  const cancelled = pending.authorizePhone({}, call({ signal: abort.signal })); await entered.promise; abort.abort()
  await assert.rejects(cancelled, error => error.code === 'cancelled')
  assert.equal((await f.client.getState({}, call())).phoneAuthorized, false)
  assert.equal(f.requests.filter(value => value.path === '/v1/host/consents').length, 1)
  const invalid = createReferenceIdentityClient({ endpoint: f.endpoint, allowLoopbackHTTP: true, hostToken: () => f.host.hostAccessToken,
    confirmAuthorization: () => undefined, requestLogout: noLogout })
  await assert.rejects(invalid.getUserProfile({}, call()), error => error.code === 'invalid_request')
  assert.equal(f.requests.filter(value => value.path === '/v1/host/consents').length, 1)
})

test('policy changes while the host prompt is open cannot silently authorize a new purpose', async t => {
  const entered = defer(), gate = defer()
  const f = await fixture(t, { confirm: async () => { entered.resolve(); return gate.promise } })
  const pending = f.client.getUserProfile({}, call()); await entered.promise
  f.service.apps.get('first').authorizationPolicies.profile.permissionVersion = 'profile-v2'
  gate.resolve(true)
  await assert.rejects(pending, error => error.backendCode === 'authorization_policy_changed')
  assert.equal((await f.client.getState({}, call())).profileAuthorized, false)
})

test('late disclosure is rejected after revocation or a same-scope new consent revision', async t => {
  for (const revoke of [true, false]) {
    const entered = defer(), gate = defer(); let delay = false
    const f = await fixture(t, { intercept: async (request, response, { service, host }) => {
      if (request.url !== '/v1/host/profile' || !delay) return false
      const original = service.hostProfile(host.hostAccessToken, f.selection)
      entered.resolve(); await gate.promise; send(response, 200, original); return true
    } })
    await f.client.getUserProfile({}, call()); delay = true
    const pending = f.client.getUserInfo({}, call()); await entered.promise
    f.service.setConsent(f.host.hostAccessToken, { ...f.selection, kind: 'profile', ...policies.profile, granted: !revoke })
    gate.resolve()
    await assert.rejects(pending, error => error.code === (revoke ? 'permission_denied' : 'cancelled'))
  }
})

test('same-client newer authorization invalidates an older pending prompt', async t => {
  const first = defer(), entered = defer(); let count = 0
  const f = await fixture(t, { confirm: async () => { if (++count === 1) { entered.resolve(); return first.promise } return true } })
  const pending = f.client.getUserProfile({}, call()); await entered.promise
  assert.equal((await f.client.getUserProfile({}, call())).userInfo.nickName, 'Alice')
  first.resolve(true)
  await assert.rejects(pending, error => error.code === 'cancelled')
  assert.equal(f.requests.filter(value => value.path === '/v1/host/consents').length, 1)
})

test('long legal policies and opaque authorization versions use the transport byte budget', async t => {
  const longPolicies = { profile: { purpose: 'p'.repeat(512), permissionVersion: 'v'.repeat(64) },
    phone: { purpose: 'h'.repeat(512), permissionVersion: 'w'.repeat(64) } }
  const authorizationVersion = JSON.stringify(longPolicies)
  assert.ok(authorizationVersion.length > 1024)
  const f = await fixture(t, { confirm: async value => {
    assert.equal(value.purpose, longPolicies.profile.purpose); assert.equal(value.permissionVersion, longPolicies.profile.permissionVersion)
    return true
  }, intercept: async (request, response, { service, host }) => {
    if (request.url !== '/v1/host/identity-state') return false
    send(response, 200, { ...service.identityState(host.hostAccessToken, f.selection), authorizationVersion }); return true
  } })
  f.service.apps.get('first').authorizationPolicies = structuredClone(longPolicies)
  assert.equal((await f.client.getUserProfile({}, call())).userInfo.nickName, 'Alice')
  assert.equal((await f.client.getState({}, call())).authorizationVersion, authorizationVersion)
})

test('backend errors preserve nested fields, null precedence and canonical/core classifications', async t => {
  let payload = { code: 'envelope', errCode: 1, errMsg: 'envelope', details: { trace: 'outer', stable: 'kept' }, error: {
    code: 'ERR_UNSUPPORTED_CAPABILITY', message: 'Capability unavailable', errCode: 4017, errMsg: 'login:fail original',
    details: { trace: 'inner', stable: null, provider: { retryAfter: 5 } }, trace: 'nested' } }
  const endpoint = await http(t, (_request, response) => send(response, 409, payload))
  const client = createReferenceIdentityClient({ endpoint, allowLoopbackHTTP: true, hostToken: () => 'host-only-token', confirmAuthorization: async () => true, requestLogout: noLogout })
  await assert.rejects(client.login({}, call()), error => {
    assert.ok(error instanceof ReferenceIdentityError); assert.equal(error.code, 'unsupported'); assert.equal(error.backendCode, 'ERR_UNSUPPORTED_CAPABILITY')
    assert.equal(error.errCode, 4017); assert.equal(error.errMsg, 'login:fail original'); assert.equal(error.details.trace, 'nested')
    assert.equal(error.details.stable, 'kept'); assert.deepEqual(error.details.provider, { retryAfter: 5 })
    assert.ok(!('code' in error.details) && !('details' in error.details)); return true
  })
  for (const [code, expected] of [['timeout', 'timeout'], ['ERR_CANCELLED', 'cancelled'], ['invalid_app_session', 'permission_denied'],
    ['ERR_INVALID_APP_SESSION', 'permission_denied'], ['permission_denied', 'permission_denied'], ['unknown_provider', 'invalid_request']]) {
    payload = { error: { code, errCode: 4017, errMsg: 'provider:fail original' } }
    await assert.rejects(client.login({}, call()), error => error.code === expected && error.errCode === 4017 && error.backendCode === code)
  }
  for (const error of [null, 3, false, {}, [], '  ']) {
    payload = { error, message: null }
    await assert.rejects(client.login({}, call()), value => value.code === 'invalid_request' && value.backendCode === 'ERR_HOST_SERVICES' && value.errCode === -1)
  }
})

test('trusted selection is frozen before async credential retrieval and never uses guest payload', async t => {
  const entered = defer(), gate = defer(); let captured
  const f = await fixture(t, { tokenProvider: async value => { captured = value.context; entered.resolve(); await gate.promise; return f.host.hostAccessToken } })
  const supplied = call(), pending = f.client.login({ miniAppId: 'other', expectedPrincipalEpoch: '1' }, supplied)
  await entered.promise
  supplied.context.application.appId = 'other'; supplied.context.account.epoch = '2'
  assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.application) && Object.isFrozen(captured.account))
  gate.resolve()
  const result = await pending
  assert.ok(result.code); assert.equal(captured.application.appId, 'first'); assert.equal(captured.account.epoch, account.epoch)
})

test('the real service rejects token/owner mismatch and unaccepted packs; unsafe epochs fail before credentials', async t => {
  let tokens = 0
  const f = await fixture(t, { tokenProvider: () => { tokens++; return f.host.hostAccessToken } })
  const bob = call(); bob.context.account.principalId = 'bob'
  await assert.rejects(f.client.login({}, bob), error => error.code === 'permission_denied' && error.backendCode === 'host_identity_mismatch')
  const untrusted = call(); untrusted.context.application.packRoot = 'b'.repeat(64)
  await assert.rejects(f.client.login({}, untrusted), error => error.backendCode === 'untrusted_pack')
  const unsafe = call(); unsafe.context.account.epoch = Number(account.epoch)
  await assert.rejects(f.client.login({}, unsafe), error => error.code === 'invalid_request')
  assert.equal(tokens, 2)
})

test('credential provider failures and malformed bearers expose no credential contents', async t => {
  let requests = 0
  const endpoint = await http(t, (_request, response) => { requests++; send(response, 200, {}) })
  for (const hostToken of [() => { throw new Error('private-provider-token') }, () => 'Bearer private-token', () => 'private\r\nInjected: token']) {
    const client = createReferenceIdentityClient({ endpoint, allowLoopbackHTTP: true, hostToken, confirmAuthorization: async () => true, requestLogout: noLogout })
    await assert.rejects(client.login({}, call()), error => {
      assert.equal(error.code, 'permission_denied'); assert.ok(!JSON.stringify(error).includes('private')); return true
    })
  }
  assert.equal(requests, 0)
})

test('tokens cannot follow redirects or appear on an arbitrary origin; fetch options disable ambient state', async t => {
  let foreign = 0, options
  const target = await http(t, (_request, response) => { foreign++; send(response, 200, { code: 'wrong', expiresIn: 60 }) })
  const endpoint = await http(t, (_request, response) => { response.writeHead(307, { Location: target + '/stolen' }); response.end() })
  const client = createReferenceIdentityClient({ endpoint, allowLoopbackHTTP: true, hostToken: () => 'host-only-token', confirmAuthorization: async () => true,
    requestLogout: noLogout, fetchImpl: (url, init) => { options = init; return fetch(url, init) } })
  await assert.rejects(client.login({}, call()), error => error.code === 'invalid_request')
  assert.equal(foreign, 0); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store')
  for (const endpoint of ['http://example.com', 'http://localhost.evil.test', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?key=secret']) {
    assert.throws(() => createReferenceIdentityClient({ endpoint, allowLoopbackHTTP: true, hostToken: () => 'token', confirmAuthorization: async () => true, requestLogout: noLogout }))
  }
  assert.throws(() => createReferenceIdentityClient({ endpoint: 'http://localhost', hostToken: () => 'token', confirmAuthorization: async () => true, requestLogout: noLogout }))
})

test('response limits cover declared and streaming UTF-8 bytes, invalid JSON and content types', async t => {
  for (const mode of ['declared', 'streamed', 'utf8', 'json', 'type']) {
    const endpoint = await http(t, (_request, response) => {
      if (mode === 'type') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('{}'); return }
      response.writeHead(200, { 'Content-Type': 'application/json', ...(mode === 'declared' ? { 'Content-Length': '262145' } : {}) })
      if (mode === 'json') response.end('{broken')
      else if (mode === 'utf8') response.end(JSON.stringify({ value: '汉'.repeat(100000) }))
      else { response.write(' '.repeat(131072)); response.end(' '.repeat(131073)) }
    })
    const client = createReferenceIdentityClient({ endpoint, allowLoopbackHTTP: true, hostToken: () => 'host-only-token', confirmAuthorization: async () => true, requestLogout: noLogout })
    await assert.rejects(client.login({}, call()), error => error.code === 'invalid_request')
  }
})

test('abort and deadlines also bound hanging credential providers and pending HTTP response bodies', async t => {
  let tokens = 0
  const client = createReferenceIdentityClient({ endpoint: 'https://identity.example', hostToken: () => { tokens++; return new Promise(() => {}) },
    confirmAuthorization: async () => true, requestLogout: noLogout, timeoutMs: 15 })
  await assert.rejects(client.login({}, call()), error => error.code === 'timeout')
  const expired = call({ deadlineNs: String(BigInt(Date.now() - 1) * 1_000_000n) })
  await assert.rejects(client.login({}, expired), error => error.code === 'timeout')
  assert.equal(tokens, 1)
  const entered = defer()
  const endpoint = await http(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); entered.resolve() })
  const network = createReferenceIdentityClient({ endpoint, allowLoopbackHTTP: true, hostToken: () => 'token', confirmAuthorization: async () => true, requestLogout: noLogout })
  const abort = new AbortController(), pending = network.login({}, call({ signal: abort.signal }))
  await entered.promise; abort.abort()
  await assert.rejects(pending, error => error.code === 'cancelled')
})

test('logout rejects missing backend revocation and asynchronous owner-destruction callbacks', async t => {
  let invoked = 0
  const badEndpoint = await http(t, (_request, response) => send(response, 403, { error: 'invalid_host_session' }))
  const denied = createReferenceIdentityClient({ endpoint: badEndpoint, allowLoopbackHTTP: true, hostToken: () => 'token', confirmAuthorization: async () => true, requestLogout: () => { invoked++; return noLogout() } })
  await assert.rejects(denied.logout({}, call()), error => error.code === 'permission_denied'); assert.equal(invoked, 0)
  const f = await fixture(t, { logout: () => new Promise(() => {}) })
  await assert.rejects(f.client.logout({}, call()), error => error.message.includes('immediate operation receipt'))
})
