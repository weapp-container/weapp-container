/** Host-realm adapter for the Node 24/SQLite reference account service.
 * Pass the returned methods to BrowserHostServices.identity; never serialize
 * this object or its credential callback into a guest, Worker or configuration.
 */
const LIMIT = 256 * 1024, encoder = new TextEncoder()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim() ? value : null
const categories = new Set(['invalid_request', 'permission_denied', 'timeout', 'cancelled', 'unsupported'])
const permissionCodes = new Set(['consent_required', 'invalid_host_session', 'invalid_app_session', 'host_identity_mismatch', 'stale_principal'])
const apiName = api => api.replace(/^wx\./, '')

export class ReferenceIdentityError extends Error {
  constructor(code, message, { api = 'identity', details = {}, backendCode, httpStatus } = {}) {
    super(message)
    this.name = 'ReferenceIdentityError'; this.code = code; this.retryable = false; this.api = api
    this.details = { ...details }
    if (!text(this.details.errMsg)) this.details.errMsg = `${apiName(api)}:fail ${message}`
    if (this.details.errCode == null) this.details.errCode = code === 'permission_denied' ? 2001 : -1
    this.errCode = this.details.errCode; this.errMsg = this.details.errMsg
    if (backendCode !== undefined) this.backendCode = backendCode
    if (httpStatus !== undefined) this.httpStatus = httpStatus
  }
}
const fail = (condition, message, code = 'invalid_request') => { if (!condition) throw new ReferenceIdentityError(code, message) }
function backendError(value, api, status) {
  const nested = object(value?.error) ? value.error : null
  const code = text(nested?.code) || text(value?.code) || text(value?.error) || 'ERR_HOST_SERVICES'
  const fields = Object.create(null), excluded = new Set(['code', 'message', 'error', 'details'])
  for (const source of [value, value?.details, nested?.details, nested]) {
    if (object(source)) for (const [key, field] of Object.entries(source)) if (!excluded.has(key) && field != null) fields[key] = field
  }
  const message = text(nested?.message) || text(value?.message) || text(fields.errMsg) || 'Host identity request failed'
  const normalized = code.replace(/^ERR_/, '').toLowerCase()
  const category = normalized === 'unsupported_capability' ? 'unsupported' : permissionCodes.has(normalized) ? 'permission_denied'
    : categories.has(normalized) ? normalized : 'invalid_request'
  if (fields.backendCode === undefined) fields.backendCode = code
  return new ReferenceIdentityError(category, message, { api, details: fields, backendCode: code, httpStatus: status })
}
function jsonCopy(value) {
  const encoded = JSON.stringify(value)
  fail(typeof encoded === 'string' && encoder.encode(encoded).byteLength <= LIMIT, 'Host identity metadata exceeds limit')
  return JSON.parse(encoded)
}
function freeze(value) {
  if (object(value) || Array.isArray(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }
  return value
}
function capture(call) {
  fail(object(call?.context), 'Trusted host call context required')
  const context = jsonCopy(call.context), { application: app, account } = context
  fail(object(app) && object(account), 'Trusted application and account required')
  for (const name of ['hostAppId', 'tenantId', 'publisherId', 'appId', 'environment', 'version']) {
    fail(text(app[name]) && app[name].length <= 1024, `Trusted application ${name} required`)
  }
  fail(/^[a-f0-9]{64}$/.test(app.packRoot ?? ''), 'Verified installed pack root required', 'permission_denied')
  fail(account.principalId === null || text(account.principalId) && account.principalId.length <= 1024, 'Trusted account principal required')
  fail((typeof account.epoch === 'string' && /^[1-9][0-9]{0,19}$/.test(account.epoch) || Number.isSafeInteger(account.epoch) && account.epoch > 0)
    && BigInt(account.epoch) <= 18446744073709551615n, 'Exact positive account epoch required')
  return freeze(context)
}
function wait(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(value).then(result => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve(result) },
      error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error) })
  })
}
function publicState(value) {
  const fields = ['hostLoggedIn', 'appLoggedIn', 'profileAuthorized', 'phoneAuthorized']
  fail(object(value) && fields.every(key => typeof value[key] === 'boolean') && value.hostLoggedIn === true, 'Invalid reference identity state')
  // The complete response is byte-bounded by the transport. A legal opaque
  // version may contain both registered purposes and exceed 1024 characters.
  fail(text(value.authorizationVersion), 'Identity authorization version required')
  const state = Object.fromEntries(fields.map(key => [key, value[key]]))
  state.authorizationVersion = value.authorizationVersion
  if (value.profileAuthorized && value.userInfo !== undefined) state.userInfo = publicProfile(value.userInfo)
  return state
}
function publicProfile(value) {
  fail(object(value), 'Invalid public profile')
  return Object.fromEntries(['nickName', 'avatarUrl'].filter(key => typeof value[key] === 'string').map(key => [key, value[key]]))
}

export function createReferenceIdentityClient({ endpoint, hostToken, confirmAuthorization, requestLogout,
  allowLoopbackHTTP = false, timeoutMs = 15_000, fetchImpl = globalThis.fetch } = {}) {
  let origin
  try { origin = new URL(endpoint) } catch { throw new ReferenceIdentityError('invalid_request', 'Fixed identity endpoint required') }
  fail(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/'
    && (origin.protocol === 'https:' || allowLoopbackHTTP === true && origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)),
  'Use HTTPS; loopback HTTP requires explicit development opt-in')
  fail(typeof hostToken === 'function' && typeof fetchImpl === 'function', 'Host credential provider and fetch required')
  fail(typeof confirmAuthorization === 'function' && typeof requestLogout === 'function', 'Host authorization and logout callbacks required')
  fail(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, 'Identity timeout must be 1..120000 milliseconds')
  origin = origin.origin
  const activeScopes = new Map()

  async function run(api, call, action, { change, retiring = false } = {}) {
    const context = capture(call), controller = new AbortController(), signal = controller.signal
    const abort = () => controller.abort(new ReferenceIdentityError(call.signal?.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', 'Host identity call cancelled', { api }))
    let timeout = timeoutMs, timer
    const deadline = call.deadlineNs ?? context.deadlineNs
    if (deadline != null) {
      fail(typeof deadline === 'string' && /^[0-9]{1,20}$/.test(deadline) && BigInt(deadline) <= 18446744073709551615n, 'Exact native call deadline required')
      const remaining = BigInt(deadline) - BigInt(Date.now()) * 1_000_000n
      if (remaining <= 0n) throw new ReferenceIdentityError('timeout', 'Host identity call deadline expired', { api })
      timeout = Math.min(timeout, Number((remaining + 999_999n) / 1_000_000n))
    }
    if (call.signal !== undefined) fail(typeof call.signal?.addEventListener === 'function', 'Valid host call AbortSignal required')
    if (call.signal?.aborted) abort()
    else call.signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => controller.abort(new ReferenceIdentityError('timeout', 'Host identity call timed out', { api })), timeout)
    const key = JSON.stringify([context.application.hostAppId, context.application.tenantId, context.application.publisherId,
      context.application.appId, context.application.environment, context.account.principalId, String(context.account.epoch)])
    const revision = activeScopes.get(key) || { profile: 0, phone: 0, active: 0 }
    activeScopes.set(key, revision); revision.active++
    if (change === 'logout') { revision.profile++; revision.phone++ } else if (change) revision[change]++
    const accepted = { profile: revision.profile, phone: revision.phone }
    const guard = kind => {
      if (signal.aborted) throw signal.reason
      if (kind && accepted[kind] !== revision[kind]) throw new ReferenceIdentityError('cancelled', 'A newer authorization superseded this disclosure', { api })
    }
    const scope = { api, context, signal, services: call.services, guard,
      selection: { miniAppId: context.application.appId, packRoot: context.application.packRoot,
        expectedPrincipalId: context.account.principalId, expectedPrincipalEpoch: context.account.epoch } }
    try {
      guard()
      const result = await action(scope)
      if (!retiring) guard()
      return result
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof ReferenceIdentityError) {
        if (error.api !== 'identity') throw error
        throw new ReferenceIdentityError(error.code, error.message, { api, details: { ...error.details, errMsg: null } })
      }
      throw new ReferenceIdentityError('invalid_request', 'Host identity operation failed', { api })
    } finally {
      clearTimeout(timer); call.signal?.removeEventListener('abort', abort)
      if (--revision.active === 0) activeScopes.delete(key)
    }
  }
  async function request(scope, path, extra = {}) {
    scope.guard()
    fail(scope.context.account.principalId !== null, 'Host login required', 'permission_denied')
    let token
    try { token = await wait(hostToken({ context: scope.context, signal: scope.signal }), scope.signal) }
    catch (error) { if (scope.signal.aborted) throw error; throw new ReferenceIdentityError('permission_denied', 'Host credential provider failed', { api: scope.api }) }
    fail(typeof token === 'string' && token.length > 0 && token.length <= 8192 && /^[A-Za-z0-9\-._~+/]+=*$/.test(token), 'Valid native host bearer required', 'permission_denied')
    scope.guard()
    let response
    try {
      response = await wait(fetchImpl(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...scope.selection, ...extra }), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: scope.signal }), scope.signal)
    } catch (error) { if (scope.signal.aborted) throw error; throw new ReferenceIdentityError('invalid_request', 'Identity backend request failed', { api: scope.api }) }
    const reader = response.body?.getReader()
    try {
      fail(/^[a-z0-9.+-]+\/([a-z0-9.+-]*\+)?json$/i.test(response.headers.get('content-type')?.split(';')[0].trim() || ''), 'Identity backend must return JSON')
      const length = response.headers.get('content-length')
      fail(!length || !/^[0-9]+$/.test(length) || BigInt(length) <= BigInt(LIMIT), 'Identity backend response exceeds 256 KiB')
      fail(reader, 'Identity backend response body required')
      const chunks = []; let size = 0
      for (;;) {
        const next = await wait(reader.read(), scope.signal)
        if (next.done) break
        size += next.value.byteLength
        fail(size <= LIMIT, 'Identity backend response exceeds 256 KiB')
        chunks.push(next.value)
      }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      let value
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
      catch { throw new ReferenceIdentityError('invalid_request', 'Identity backend returned invalid JSON', { api: scope.api }) }
      scope.guard()
      if (!response.ok) throw backendError(value, scope.api, response.status)
      fail(object(value), 'Identity backend JSON must be an object')
      return value
    } catch (error) {
      if (reader) void reader.cancel().catch(() => {})
      throw error
    } finally { reader?.releaseLock() }
  }
  const state = async scope => publicState(await request(scope, '/v1/host/identity-state'))
  async function disclose(scope, kind, path) {
    scope.guard(kind)
    const before = await state(scope)
    fail(before[`${kind}Authorized`], `Explicit ${kind} authorization required`, 'permission_denied')
    scope.guard(kind)
    const value = await request(scope, path)
    const after = await state(scope)
    scope.guard(kind)
    fail(after[`${kind}Authorized`], `${kind} authorization was revoked`, 'permission_denied')
    fail(before.authorizationVersion === after.authorizationVersion, 'Authorization changed during disclosure', 'cancelled')
    return value
  }
  async function authorize(scope, kind, path) {
    const policy = await request(scope, '/v1/host/authorization-policy', { kind })
    fail(policy.kind === kind && text(policy.purpose) && policy.purpose.length <= 512
      && text(policy.permissionVersion) && policy.permissionVersion.length <= 64, 'Invalid registered authorization policy')
    scope.guard(kind)
    let granted
    try { granted = await wait(confirmAuthorization(Object.freeze({ kind, purpose: policy.purpose, permissionVersion: policy.permissionVersion,
      application: scope.context.application, account: scope.context.account, signal: scope.signal })), scope.signal) }
    catch (error) { if (scope.signal.aborted) throw error; throw new ReferenceIdentityError('invalid_request', 'Host authorization confirmation failed', { api: scope.api }) }
    fail(typeof granted === 'boolean', 'Host must explicitly allow or deny authorization')
    scope.guard(kind)
    await request(scope, '/v1/host/consents', { kind, purpose: policy.purpose, permissionVersion: policy.permissionVersion, granted })
    if (!granted) throw new ReferenceIdentityError('permission_denied', 'User denied consent', { api: scope.api, details: { errCode: 2001, errMsg: `${apiName(scope.api)}:fail auth deny` } })
    return disclose(scope, kind, path)
  }
  function codeResult(value, api) {
    fail(text(value.code) && value.code.length <= 1024 && Number.isFinite(value.expiresIn) && value.expiresIn > 0 && value.expiresIn <= 86400, 'Invalid reference one-time code')
    return { code: value.code, expiresIn: value.expiresIn, errMsg: `${apiName(api)}:ok` }
  }
  return Object.freeze({
    getState: (_payload, call) => run('weappContainer.identity.getState', call, scope => scope.context.account.principalId === null
      ? { hostLoggedIn: false, appLoggedIn: false, profileAuthorized: false, phoneAuthorized: false } : state(scope)),
    login: (_payload, call) => run('wx.login', call, async scope => codeResult(await request(scope, '/v1/host/login-codes'), scope.api)),
    checkSession: (_payload, call) => run('wx.checkSession', call, async scope => {
      const value = await request(scope, '/v1/host/check-session'); fail(value.valid === true, 'Invalid application session response')
      return { valid: true, errMsg: 'checkSession:ok' }
    }),
    getUserInfo: (_payload, call) => run('wx.getUserInfo', call, async scope => ({ userInfo: publicProfile(await disclose(scope, 'profile', '/v1/host/profile')), errMsg: 'getUserInfo:ok' })),
    getUserProfile: (_payload, call) => run('wx.getUserProfile', call, async scope => ({ userInfo: publicProfile(await authorize(scope, 'profile', '/v1/host/profile')), errMsg: 'getUserProfile:ok' }), { change: 'profile' }),
    authorizePhone: (_payload, call) => run('weappContainer.identity.authorizePhone', call, async scope => codeResult(await authorize(scope, 'phone', '/v1/host/phone-codes'), scope.api), { change: 'phone' }),
    logout: (_payload, call) => run('weappContainer.identity.logout', call, async scope => {
      const backendResult = await request(scope, '/v1/host/app-logout')
      fail(backendResult.loggedOut === true, 'Backend did not confirm application logout')
      scope.guard()
      let receipt
      try { receipt = requestLogout({ context: scope.context, backendResult: freeze(jsonCopy(backendResult)), services: scope.services }) }
      catch { throw new ReferenceIdentityError('invalid_request', 'Host logout initiation failed', { api: scope.api }) }
      if (receipt && typeof receipt.then === 'function') {
        void Promise.resolve(receipt).catch(() => {})
        throw new ReferenceIdentityError('invalid_request', 'requestLogout must return an immediate operation receipt', { api: scope.api })
      }
      fail(object(receipt), 'Host logout operation receipt required')
      return jsonCopy(receipt)
    }, { change: 'logout', retiring: true }),
  })
}
