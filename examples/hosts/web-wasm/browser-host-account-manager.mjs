/** Stable browser controllers with replaceable execution owners. Host tokens
 * stay with the caller; only an opaque principal and epoch are retained here.
 */
const check = (value, message, code = 'ERR_INVALID_REQUEST') => { if (!value) throw Object.assign(new Error(message), { code }) }
const copy = value => structuredClone(value)
const cancelled = message => Object.assign(new Error(message), { code: 'ERR_CANCELLED' })
const errorValue = error => ({ code: error?.code || 'ERR_ENGINE', message: error?.message || String(error) })
const samePrincipal = (a,b) => a.principalId === b.principalId && String(a.epoch) === String(b.epoch)
const jsonValueCopy = (value, seen = new Set(), depth = 0) => {
  check(depth <= 64, 'host launch JSON nesting exceeds the limit')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { check(Number.isFinite(value), 'host launch JSON numbers must be finite'); return value }
  check(value !== undefined && typeof value === 'object', 'host launch options must contain JSON values')
  check(!seen.has(value), 'host launch options contain a circular value'); seen.add(value)
  let result
  if (Array.isArray(value)) {
    result = []
    for (const item of value) result.push(jsonValueCopy(item, seen, depth + 1))
  } else {
    const prototype = Object.getPrototypeOf(value)
    check(prototype === Object.prototype || prototype === null, 'host launch options require plain JSON objects')
    check(Object.getOwnPropertySymbols(value).length === 0, 'host launch options cannot contain symbol keys')
    result = Object.fromEntries(Object.keys(value).map(key => [key, jsonValueCopy(value[key], seen, depth + 1)]))
  }
  seen.delete(value)
  return result
}
const jsonObjectCopy = value => {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'host launch options must be a JSON object')
  return jsonValueCopy(value)
}
const launchValue = launch => {
  const value = jsonObjectCopy(launch)
  if (Object.hasOwn(value, 'route')) check(typeof value.route === 'string' && value.route.length > 0, 'host launch route must be a non-empty string')
  if (Object.hasOwn(value, 'query')) {
    check(value.query !== null && typeof value.query === 'object' && !Array.isArray(value.query), 'host launch query must be an object')
    for (const item of Object.values(value.query)) check(typeof item === 'string', 'host launch query values must be strings')
  }
  if (Object.hasOwn(value, 'scene')) check(Number.isSafeInteger(value.scene) && value.scene >= 0, 'host launch scene must be a nonnegative safe integer')
  if (Object.hasOwn(value, 'extra')) check(value.extra !== null && typeof value.extra === 'object' && !Array.isArray(value.extra), 'host launch extra must be a JSON object')
  return value
}
const accountValue = value => {
  check(((typeof value?.epoch === 'string' && /^[1-9][0-9]{0,19}$/.test(value.epoch) && BigInt(value.epoch) <= 18446744073709551615n) || Number.isSafeInteger(value?.epoch) && value.epoch > 0) && (value.principalId == null || typeof value.principalId === 'string' && value.principalId.length > 0), 'account needs a positive safe epoch and opaque principalId')
  return Object.freeze({ principalId: value.principalId ?? null, epoch: value.epoch })
}
export function browserStorageScope(application, account) {
  return JSON.stringify(['weapp-account-v1',application.hostAppId,application.tenantId,application.publisherId,
    application.appId,application.environment,account.principalId ?? null])
}

export class BrowserHostAccountManager {
  #account; #controllers = new Set(); #revision = 0; #operations = new Map(); #listeners = new Set()
  #applicationGrants = new Map(); #domain = null
  #knownApplications = new Map(); #deletingPrincipals = new Set()
  constructor(account, { revokeBackend = async () => {}, clearLocalData = async () => {} } = {}) {
    this.#account = accountValue(account); this.revokeBackend = revokeBackend; this.clearLocalData = clearLocalData
  }
  get account() { return this.#account }
  attach({ application, createOwner, launchOptions = {}, onState = () => {} }) {
    launchOptions = launchValue(launchOptions)
    check(typeof createOwner === 'function' && typeof onState === 'function', 'owner factory and state observer must be functions')
    check(['hostAppId','tenantId','publisherId','appId','environment','packRoot'].every(key => typeof application?.[key] === 'string' && application[key]), 'trusted installation identity is required')
    const domain=JSON.stringify([application.hostAppId,application.tenantId]); this.#domain ||= domain
    check(domain === this.#domain, 'an account manager belongs to one host/tenant identity domain')
    this.#knownApplications.set(browserStorageScope(application,{principalId:null}),copy(application))
    const controller = new BrowserAccountController(this, { application: copy(application), createOwner, onState })
    this.#controllers.add(controller)
    controller.replace({ account: this.#account, operationId: 'initial', launchOptions: copy(launchOptions), appAuthorized: this.applicationAuthorized(application) })
    return controller
  }
  /** Revokes every attached controller synchronously before any await. Fresh
   * launch options are host-supplied by appId; page stack/query never migrate.
   */
  switchAccount(account, { launches = {} } = {}) {
    account = accountValue(account)
    // Freeze every launch before changing epoch or touching any sibling.
    // A serialization error must not leave only part of the group gated.
    launches = jsonObjectCopy(launches)
    for (const options of Object.values(launches)) launchValue(options)
    check(!this.#deletingPrincipals.has(account.principalId), 'account deletion is in progress', 'ERR_ACCOUNT_DELETING')
    if (samePrincipal(account, this.#account)) return Promise.resolve({ operationId: 'unchanged', epoch: account.epoch, status: 'complete', controllers: [] })
    check(BigInt(account.epoch) > BigInt(this.#account.epoch), 'account changes require a strictly greater epoch', 'ERR_STALE_ACCOUNT_EPOCH')
    this.#account = account
    const operationId = `account-${account.epoch}-${++this.#revision}`
    const receipt = { operationId, epoch: account.epoch, status: 'running', controllers: [] }
    this.#operations.set(operationId, receipt)
    while (this.#operations.size > 64) this.#operations.delete(this.#operations.keys().next().value)
    const replacements = [...this.#controllers].map(controller => controller.state.phase === 'closed'
      ? controller.close().then(() => ({ operationId, epoch: account.epoch, phase: 'complete' }))
      : controller.replace({ account, operationId, launchOptions: Object.hasOwn(launches,controller.application.appId) ? launches[controller.application.appId] : {}, appAuthorized: this.applicationAuthorized(controller.application) }))
    this.#notify()
    return Promise.allSettled(replacements).then(results => {
      receipt.controllers = results.map((result, index) => result.status === 'fulfilled' ? result.value : { status: 'failed', error: errorValue(result.reason), index })
      receipt.status = String(this.#account.epoch) !== String(account.epoch) ? 'superseded' : receipt.controllers.every(controller => controller.phase === 'complete') ? 'complete' : 'failed'
      this.#notify(); return copy(receipt)
    })
  }
  query(operationId) { const receipt = this.#operations.get(operationId); return receipt ? copy(receipt) : null }
  applicationAuthorized(application) { return this.#account.principalId !== null && this.#applicationGrants.get(browserStorageScope(application,this.#account)) === true }
  /** Miniapp logout revokes only this app's grant for this principal. Other
   * miniapps and the host login remain live. All instances of the app rebuild.
   */
  logoutApplication(application, options = {}) { return this.#beginApplicationLogout(application,options).completion }
  /** Execution-owner callbacks receive an immediate operation receipt. Waiting
   * for replacement inside the retiring owner's own handler would deadlock its
   * close barrier. The host can query the operation's eventual terminal state.
   */
  requestApplicationLogout(application, options = {}) {
    const operation=this.#beginApplicationLogout(application,options)
    void operation.completion.catch(error=>{this.lastOperationError=errorValue(error)})
    return copy(operation.receipt)
  }
  #beginApplicationLogout(application, { launchOptions = {} } = {}) {
    launchOptions = launchValue(launchOptions)
    const scope=browserStorageScope(application,this.#account)
    this.#applicationGrants.set(scope,false)
    const operationId=`app-logout-${++this.#revision}`,account=this.#account
    const controllers=[...this.#controllers].filter(controller=>browserStorageScope(controller.application,account)===scope)
    const receipt={operationId,epoch:account.epoch,status:'running',controllers:[]};this.#operations.set(operationId,receipt)
    while(this.#operations.size>64)this.#operations.delete(this.#operations.keys().next().value)
    const replacements=controllers.map(controller=>controller.state.phase==='closed'
      ? controller.close().then(()=>({operationId,epoch:account.epoch,phase:'complete'}),error=>({operationId,epoch:account.epoch,phase:'failed',error:errorValue(error)}))
      : controller.replace({account,operationId,launchOptions:copy(launchOptions),appAuthorized:false}))
    const completion=Promise.all(replacements).then(results=>{
      receipt.controllers=results
      receipt.status=String(account.epoch)!==String(this.#account.epoch)?'superseded':receipt.controllers.every(controller=>controller.phase==='complete')?'complete':'failed'
      this.#notify();return copy(receipt)
    })
    return {receipt,completion}
  }
  grantApplication(application) { this.#applicationGrants.set(browserStorageScope(application,this.#account),true);this.#notify() }
  onChange(listener) { check(typeof listener === 'function', 'listener must be a function'); this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  #notify() { for (const listener of this.#listeners) { try { listener({hostLoggedIn:this.#account.principalId!==null,epoch:this.#account.epoch}) } catch (error) { this.lastObserverError = errorValue(error) } } }
  refreshCredentials(refresh) { check(typeof refresh === 'function', 'refresh must remain in the host'); return refresh(this.#account) }
  async deleteAccount(principalId, options = {}) {
    check(typeof principalId === 'string' && principalId, 'principalId is required')
    check(!this.#deletingPrincipals.has(principalId), 'account deletion is already in progress', 'ERR_ACCOUNT_DELETING')
    this.#deletingPrincipals.add(principalId)
    for (const application of this.#knownApplications.values()) this.#applicationGrants.delete(browserStorageScope(application,{principalId}))
    try {
    const previous = this.#account
    if (previous.principalId === principalId) {
      const operation = await this.switchAccount({ principalId: null, epoch: typeof previous.epoch === 'string' ? String(BigInt(previous.epoch)+1n) : previous.epoch + 1 }, options)
      check(operation.status === 'complete', 'account retirement must complete before deleting local data', 'ERR_IDENTITY_SWITCHING')
    }
    check([...this.#controllers].every(controller => controller.state.phase === 'complete'), 'pending owner retirement must finish before deleting local data', 'ERR_IDENTITY_SWITCHING')
    // Backend authorization revocation is a host callback; no credentials are
    // serialized into guest configuration or arbitrary wx.request headers.
    await this.revokeBackend({ principalId })
    for (const application of this.#knownApplications.values()) await this.clearLocalData({ application, principalId, storageScope: browserStorageScope(application, { principalId }) })
    } finally { this.#deletingPrincipals.delete(principalId) }
  }
  detach(controller) { this.#controllers.delete(controller) }
}

export class BrowserAccountController {
  #manager; #factory; #observer; #owner = null; #phase = 'empty'; #receipt = null; #abort = null
  #tail = Promise.resolve(); #closed = false; #incarnation = 0; #wait = null; #launch = {}; #receipts = new Map()
  #retired = new Set(); #closePromise = null; #closeComplete = false; #observerPending = false
  constructor(manager, { application, createOwner, onState }) { this.#manager = manager; this.application = Object.freeze(application); this.#factory = createOwner; this.#observer = onState }
  get state() { return Object.freeze({ phase: this.#closed ? 'closed' : this.#phase, inputEnabled: this.#allowed(),
    operation: this.#receipt ? copy(this.#receipt) : null, sessionIncarnation: this.#allowed() ? this.#incarnation : null }) }
  get ready() { return this.#wait || Promise.resolve(this.state) }
  #allowed() { return !this.#closed && this.#phase === 'complete' && String(this.#receipt?.epoch) === String(this.#manager.account.epoch) && this.#owner !== null }
  #publish(phase, error) {
    this.#phase = phase
    if (this.#receipt) { this.#receipt.phase = phase; this.#receipt.error = error ? errorValue(error) : null; this.#receipts.set(this.#receipt.operationId, copy(this.#receipt)); while (this.#receipts.size > 64) this.#receipts.delete(this.#receipts.keys().next().value) }
    // A synchronous observer could start a newer group switch halfway through
    // revoking sibling owners. Notify after that synchronous boundary and read
    // the latest state at delivery, so an obsolete snapshot cannot enable UI.
    if (!this.#observerPending) {
      this.#observerPending = true
      queueMicrotask(() => {
        this.#observerPending = false
        try { this.#observer(this.state) } catch (error) { this.lastObserverError = errorValue(error) }
      })
    }
  }
  query(operationId) { return copy(this.#receipts.get(operationId) || null) }
  replace({ account, operationId, launchOptions, appAuthorized = this.#manager.applicationAuthorized(this.application) }) {
    check(!this.#closed, 'controller is closed', 'ERR_CANCELLED')
    launchOptions = launchValue(launchOptions)
    this.#abort?.abort(); const abort = new AbortController(); this.#abort = abort
    this.#launch = copy(launchOptions)
    const old = this.#owner; this.#owner = null
    if (old) this.#retired.add(old)
    // Owner.revoke is synchronous and must disable input/JS callbacks before
    // returning. Device callbacks subsequently observe the shared epoch gate.
    let revokeError
    try { old?.revoke() } catch (error) { revokeError = error }
    this.#receipt = { operationId, epoch: account.epoch, phase: 'revoking', error: null }
    this.#publish('revoking')
    const current = () => !this.#closed && !abort.signal.aborted && String(this.#manager.account.epoch) === String(account.epoch)
    const run = async () => {
      let candidate = null, candidateRevoked = false, candidateRevokeError = null
      const revokeCandidate = () => { if (candidate && !candidateRevoked) { candidate.revoke(); candidateRevoked = true } }
      const abortCandidate = () => { try { revokeCandidate() } catch (error) { candidateRevokeError = error } }
      abort.signal.addEventListener('abort', abortCandidate, { once: true })
      try {
        // This tail covers old GPU/device drain and storage close barriers.
        // A newer epoch waits for the old namespace lock even after abort.
        if (this.#retired.size) {
          if (current()) this.#publish('draining')
          const errors = []
          for (const retired of this.#retired) {
            let failed = false
            try { await retired.detachSurface() } catch (error) { errors.push(error); failed = true }
            try { await retired.close() } catch (error) { errors.push(error); failed = true }
            if (!failed) this.#retired.delete(retired)
          }
          if (errors.length) throw new AggregateError(errors, 'old owner retirement failed')
        }
        if (revokeError) throw revokeError
        if (!current()) return { operationId, epoch: account.epoch, phase: 'superseded' }
        this.#publish('starting')
        const sessionIncarnation = ++this.#incarnation
        candidate = await this.#factory({ application: this.application, account, operationId, sessionIncarnation,
          storageScope: browserStorageScope(this.application, account), launchOptions: copy(launchOptions), appAuthorized,
          requestLogout:options=>{ check(current(), 'old identity cannot log out another execution owner', 'ERR_CANCELLED'); return this.#manager.requestApplicationLogout(this.application,options) },
          grantApplication:()=>{ check(current(), 'old identity cannot grant another account access', 'ERR_CANCELLED'); return this.#manager.grantApplication(this.application) },signal: abort.signal })
        check(candidate && ['revoke','detachSurface','close','start','waitForPresentation','invoke'].every(name => typeof candidate[name] === 'function'), 'replacement factory did not return a complete execution owner')
        if (!current()) throw cancelled('replacement superseded before startup')
        await candidate.start(copy(launchOptions))
        if (!current()) throw cancelled('replacement superseded after startup')
        this.#publish('awaitingPresentation')
        await candidate.waitForPresentation({ signal: abort.signal })
        if (!current()) throw cancelled('replacement superseded before presentation')
        this.#owner = candidate; candidate = null; this.#publish('complete'); return copy(this.#receipt)
      } catch (error) {
        if (candidate) {
          const cleanupErrors = []
          try { revokeCandidate() } catch (cleanup) { cleanupErrors.push(cleanup) }
          try { await candidate.detachSurface() } catch (cleanup) { cleanupErrors.push(cleanup) }
          try { await candidate.close() } catch (cleanup) { cleanupErrors.push(cleanup) }
          if (cleanupErrors.length) { this.#retired.add(candidate); error = new AggregateError([error,...cleanupErrors], 'replacement and retirement failed') }
          else if (candidateRevokeError) error = new AggregateError([error,candidateRevokeError], 'candidate revocation initially failed')
        }
        if (current()) this.#publish('failed', error)
        return { operationId, epoch: account.epoch, phase: current() ? 'failed' : 'superseded', error: errorValue(error) }
      } finally { abort.signal.removeEventListener('abort', abortCandidate) }
    }
    this.#wait = this.#tail.then(run, run)
    this.#tail = this.#wait.then(() => {})
    return this.#wait
  }
  async invoke(method, payload) {
    check(this.#allowed(), 'identity switching or failed; business commands are blocked', 'ERR_IDENTITY_SWITCHING')
    const epoch = this.#manager.account.epoch, owner = this.#owner
    const value = await owner.invoke(method, payload)
    check(this.#allowed() && this.#owner === owner && String(this.#manager.account.epoch) === String(epoch), 'old identity result was revoked', 'ERR_CANCELLED')
    return value
  }
  retry(launchOptions = this.#launch) { check(this.#phase === 'failed', 'retry requires a failed replacement'); return this.replace({ account: this.#manager.account, operationId: `${this.#receipt.operationId}-retry-${this.#incarnation+1}`, launchOptions }) }
  cancel() {
    if (this.#phase === 'complete' || this.#closed) return false
    this.#abort?.abort(); this.#publish('failed', cancelled('identity replacement cancelled; old identity remains revoked')); return true
  }
  close() {
    if (this.#closeComplete) return Promise.resolve()
    if (this.#closePromise) return this.#closePromise
    this.#closed = true; this.#abort?.abort(); const owner = this.#owner; this.#owner = null
    const errors = []
    if (owner) { this.#retired.add(owner); try { owner.revoke() } catch (error) { errors.push(error) } }
    this.#closePromise = (async () => {
      await this.#tail
      for (const retired of this.#retired) {
        let failed = false
        try { await retired.detachSurface() } catch (error) { errors.push(error); failed = true }
        try { await retired.close() } catch (error) { errors.push(error); failed = true }
        if (!failed) this.#retired.delete(retired)
      }
      if (errors.length) throw new AggregateError(errors, 'controller cleanup failed')
      this.#manager.detach(this); this.#closeComplete = true; this.#publish('closed')
    })().finally(() => { this.#closePromise = null })
    return this.#closePromise
  }
}
