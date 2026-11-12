import { openGuest, readPack } from './web-acceptance-scope-browser.mjs'

// This derived guest owns only its application code and business session.
// Host/issuer/confidential-client credentials never enter its module or exports.
export const REFERENCE_IDENTITY_GUEST = `
var __identityCode=null,__businessSession=null,__appUserId=null,__identityOps={},__identityChanges=[];
function __identityError(e){return {code:e.code,errCode:e.errCode,errMsg:e.errMsg,message:e.message,backendCode:e.backendCode};}
exports.__identityStart=function(action,options){
 options=options||{};var op={done:false,events:[]};__identityOps[action]=op;
 function callbacks(){return {success:function(){op.events.push('callback');},fail:function(){op.events.push('fail');},complete:function(){op.events.push('complete');}};}
 var work;
 try{
  if(action==='login')work=wx.login(callbacks()).then(function(value){__identityCode=value.code;return {codePresent:typeof value.code==='string'&&value.code.length>0,expiresIn:value.expiresIn};});
  else if(action==='check')work=wx.checkSession(callbacks());
  else if(action==='profile')work=wx.getUserProfile(Object.assign({desc:'Display the registered reference profile'},callbacks()));
  else if(action==='logout')work=weappContainer.identity.logout(callbacks());
  else if(action==='exchange'||action==='repeat-exchange'||action==='wrong-exchange')work=wx.request({url:options.origin+'/business/exchange',method:'POST',header:{'content-type':'application/json'},data:{miniAppId:options.miniAppId,code:__identityCode}}).then(function(response){
   if(response.statusCode<200||response.statusCode>=300)throw {code:'HTTP_REJECTED',errCode:response.statusCode,errMsg:response.data.error};
   if(response.data.accessToken||response.data.hostAccessToken)throw Error('private backend bearer entered guest');
   __businessSession=response.data.businessSession;__appUserId=response.data.appUserId;return {appUserId:__appUserId,expiresIn:response.data.expiresIn};
  });
  else if(action==='business-check')work=wx.request({url:options.origin+'/business/session',method:'GET',header:{Authorization:'Bearer '+__businessSession}}).then(function(response){return {statusCode:response.statusCode,appUserId:response.data.appUserId};});
  else if(action==='business-logout')work=wx.request({url:options.origin+'/business/logout',method:'POST',header:{'content-type':'application/json'},data:{businessSession:__businessSession}}).then(function(response){return {statusCode:response.statusCode,loggedOut:response.data.loggedOut};});
  else throw Error('Unknown identity guest action');
  Promise.resolve(work).then(function(value){op.events.push('promise');op.value=value;op.done=true;},function(error){op.events.push('rejected');op.error=__identityError(error);op.done=true;});
 }catch(error){op.error=__identityError(error);op.done=true;}
 return {started:true};
};
exports.__identitySubscribe=function(){weappContainer.identity.onChange(function(value){__identityChanges.push(value);});return true;};
exports.__identityRead=function(){return {operations:__identityOps,changes:__identityChanges,state:weappContainer.identity.getState(),hasCode:!!__identityCode,hasBusinessSession:!!__businessSession,appUserId:__appUserId};};
`

const check = (value, message) => { if (!value) throw new Error(message) }
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

export async function runReferenceIdentity({ metrics, controlToken }) {
  const report = { modes: {}, cleanup: [], limitations: [
    'Reference principals and profiles are controlled integration records; this does not authenticate a production user or verify a real phone.',
    'Public native owners are retired/recreated explicitly. This scope does not prove controller presentation, input gating or BrowserHostAccountManager surface switching.',
    'App logout synchronously starts the real native owner close barrier; its retiring guest callback is discarded. The host observes the actual close result before recreating the owner.',
    'No physical hardware, merchant transaction, phone button or real-time code expiration wait is claimed.',
  ] }
  globalThis.__webReferenceIdentityScope = report
  const control = async (path, body) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${controlToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', redirect: 'error' })
    check(response.ok, `Host fixture control rejected: ${path} ${response.status}`)
    return response.json()
  }
  for (const mode of ['direct', 'worker']) {
    const { createReferenceIdentityClient } = await import(`/${mode}/reference-identity-client.mjs`)
    const pack = await readPack(new URL(`/fixtures/identity/${mode}/pack-index.json`, location.href))
    const app1 = `reference-${mode}-one`, app2 = `reference-${mode}-two`, active = new Set(), calls = [], logoutOperations = [], retirements = new Map()
    const hosts = new Map()
    const bootstrap = async (app, principal, epoch) => {
      const result = await control('/fixture/host', { miniAppId: app, principalId: principal, principalEpoch: epoch })
      hosts.set(JSON.stringify([app, principal, epoch]), result.hostAccessToken)
      // Never return or retain bearer in any result that will be serialized.
      return { application: result.application, account: result.account }
    }
    const makeOwner = async config => {
      let owner
      const identity = createReferenceIdentityClient({ endpoint: location.origin, allowLoopbackHTTP: true,
        hostToken: ({ context }) => {
          calls.push({ api: context.api, app: context.application.appId, epoch: String(context.account.epoch), sessionId: context.sessionId, packRoot: context.application.packRoot })
          const token = hosts.get(JSON.stringify([context.application.appId, context.account.principalId, String(context.account.epoch)]))
          check(token, 'No trusted credential for this exact application/account epoch')
          return token
        },
        confirmAuthorization: ({ kind, purpose, permissionVersion }) => window.confirm(`${kind} (${permissionVersion}): ${purpose}`),
        requestLogout: ({ context, backendResult }) => {
          check(backendResult.hostSessionRetained === true && backendResult.consentsRetained === true, 'Backend app logout changed host/consent ownership')
          const receipt = { operationId: `${mode}-host-logout-${logoutOperations.length + 1}`, epoch: context.account.epoch, status: 'running' }
          logoutOperations.push(receipt)
          // close begins its real service/native revocation synchronously. The
          // retiring call never waits on its own asynchronous close barrier.
          const completion = close(owner).then(() => { receipt.status = 'closed' }, error => { receipt.status = 'failed'; throw error })
          retirements.set(receipt.operationId, completion); void completion.catch(() => {})
          return { ...receipt }
        },
      })
      try { owner = await openGuest({ mode, pack, ...config, metrics, identity }) }
      catch (error) { if (error.ownerCleanup) report.cleanup.push(...error.ownerCleanup); throw error }
      owner.config = config; owner.identity = identity; active.add(owner)
      return owner
    }
    const close = async owner => {
      if (!active.has(owner)) return
      try { await owner.close() } finally { report.cleanup.push(...owner.cleanup); active.delete(owner) }
    }
    const read = owner => owner.call('__identityRead')
    const action = async (owner, name, app = owner.config.application.appId) => {
      check((await owner.call('__identityStart', [name, { origin: location.origin, miniAppId: app }])).started, 'Guest action did not start')
      const result = await owner.wait('__identityRead', value => value.operations[name]?.done === true)
      return { result, op: result.operations[name] }
    }
    const refresh = async owner => {
      const context = { ...owner.config, sessionId: owner.sessionId, callId: `${mode}-trusted-refresh`, api: 'weappContainer.identity.getState' }
      const state = await owner.identity.getState({}, { context, signal: new AbortController().signal, services: owner.services })
      owner.services.setApplicationIdentityState(state); await owner.services.drain()
      return read(owner)
    }
    try {
      const alice = await bootstrap(app1, 'alice', '9007199254740993')
      let first = await makeOwner(alice)
      check((await read(first)).state.appLoggedIn === false, 'Unredeemed application began logged in')
      await first.call('__identitySubscribe'); await first.services.drain()
      // Real browser confirmation UI is accepted/dismissed by the sole runner.
      const denied = await action(first, 'profile')
      check(denied.op.error?.errCode === 2001 && denied.result.state.profileAuthorized === false, 'Denied profile authorization was not isolated')
      const granted = await action(first, 'profile')
      check(granted.op.value?.userInfo?.nickName === 'Alice', 'Trusted backend profile did not reach real guest')
      check(granted.result.state.appLoggedIn === false && granted.result.state.profileAuthorized === true, 'Independent consent was hidden before app login')
      const revoked = await action(first, 'profile')
      check(revoked.op.error?.errCode === 2001 && revoked.result.state.profileAuthorized === false && revoked.result.state.userInfo === undefined, 'Denied renewal retained prior profile authorization or disclosure')
      const regranted = await action(first, 'profile')
      check(regranted.op.value?.userInfo?.nickName === 'Alice' && regranted.result.state.profileAuthorized === true, 'Profile was not usable after explicit reauthorization')
      const before = await action(first, 'check')
      check(before.op.error && before.result.state.appLoggedIn === false, 'Unredeemed session incorrectly passed')
      const login = await action(first, 'login')
      check(login.op.value?.codePresent === true && login.op.value.expiresIn > 0, 'Backend did not issue a real app code')
      check(login.op.events.join(',') === 'callback,complete,promise', 'Login callback/complete/Promise ordering changed')
      check((await action(first, 'check')).op.error, 'Issuing a code fabricated an app session')
      const wrong = await action(first, 'wrong-exchange', app2)
      check(wrong.op.error?.errCode === 401, 'Cross-app code exchange was accepted')
      const exchange = await action(first, 'exchange')
      check(typeof exchange.op.value?.appUserId === 'string', 'Real HTTP business exchange failed after wrong app attempt')
      check((await action(first, 'repeat-exchange')).op.error?.errCode === 401, 'Login code was redeemable twice')
      const loggedIn = await refresh(first)
      check(loggedIn.state.appLoggedIn && loggedIn.state.profileAuthorized, 'Redeemed session/consent missing from refreshed snapshot')
      check(!(await action(first, 'check')).op.error, 'Redeemed live application failed checkSession')
      const initialSession = first.sessionId
      await bootstrap(app1, 'alice', '9007199254740993')
      check(!(await action(first, 'check')).op.error && first.sessionId === initialSession, 'Same-user credential refresh rebuilt or broke the owner')
      const second = await makeOwner(await bootstrap(app2, 'alice', '9007199254740993'))
      await action(second, 'login'); const otherExchange = await action(second, 'exchange'); await refresh(second)
      check(otherExchange.op.value.appUserId !== exchange.op.value.appUserId, 'Pairwise application user identity was not isolated')
      check((await action(first, 'business-logout')).op.value?.statusCode === 200, 'Confidential business backend failed to revoke its session')
      const revokedSession = await action(first, 'check')
      check(revokedSession.op.error?.backendCode === 'invalid_app_session' && revokedSession.result.state.appLoggedIn === false && revokedSession.result.state.profileAuthorized === true, 'Backend logout did not refresh false snapshot while preserving raw failure and consent')
      await action(first, 'login'); check(!(await action(first, 'exchange')).op.error, 'Reauthentication after backend logout failed')
      check(!(await action(first, 'check')).op.error, 'checkSession did not refresh redeemed session to true')
      await first.call('__identityStart', ['logout', {}])
      const logoutDeadline = performance.now() + 10000
      while (!logoutOperations.length) {
        await first.services.drain(); await tick()
        check(performance.now() < logoutDeadline, 'Backend logout did not reach the synchronous host retirement callback')
      }
      check(logoutOperations.length === 1, 'App logout initiated multiple retirements')
      await retirements.get(logoutOperations[0].operationId)
      check(logoutOperations[0].status === 'closed', 'Real native owner retirement did not complete')
      let blocked = false
      try { await read(first) } catch { blocked = true }
      check(blocked, 'Retired application still accepted guest commands')
      first = await makeOwner(alice)
      const rebuilt = await read(first)
      check(!rebuilt.hasCode && !rebuilt.hasBusinessSession && rebuilt.state.hostLoggedIn && !rebuilt.state.appLoggedIn && rebuilt.state.profileAuthorized, 'Fresh owner inherited guest data or lost host login/retained consent')
      check((await action(first, 'check')).op.error, 'Logged-out fresh owner passed checkSession')
      check(!(await action(second, 'check')).op.error, 'App logout revoked a different application')
      const gate = await control('/fixture/login-delay', { action: 'arm' })
      await first.call('__identityStart', ['login', {}])
      const deadline = performance.now() + 10000
      for (;;) {
        await first.services.drain(); const state = await control('/fixture/login-delay')
        if (state.issued && state.pending) break
        check(performance.now() < deadline, 'Backend never signed the delayed real login code'); await tick()
      }
      check(!(await read(first)).operations.login.done, 'Delayed backend code settled before release')
      await close(first); await close(second)
      const bobConfig = await bootstrap(app1, 'bob', '9007199254740994'), bob = await makeOwner(bobConfig)
      await control('/fixture/login-delay', { action: 'release', sequence: gate.sequence })
      for (let turn = 0; turn < 5; turn++) { await bob.services.drain(); await tick() }
      const bobState = await read(bob)
      check(!bobState.hasCode && !bobState.hasBusinessSession && Object.keys(bobState.operations).length === 0 && !bobState.state.appLoggedIn && !bobState.state.profileAuthorized, 'Late retired-account code entered the new guest')
      await action(bob, 'login'); const bobExchange = await action(bob, 'exchange'); await refresh(bob)
      check(bobExchange.op.value.appUserId !== exchange.op.value.appUserId && !(await action(bob, 'check')).op.error, 'New account did not get an isolated live app session')
      check(calls.every(call => call.packRoot === pack.index.integrityRoot && ['9007199254740993', '9007199254740994'].includes(call.epoch)), 'Trusted context lost exact root/epoch')
      report.modes[mode] = { realReferenceBackend: true, loginOrdering: login.op.events, singleUse: true, wrongApplicationRejectedWithoutConsumption: true, redeemedSession: true, independentConsentBeforeLogin: true, profileDeniedThenGranted: true, previousConsentRevokedOnDenial: true, backendLogoutSnapshotFalse: true, rawInvalidSessionPreserved: true, checkSessionRefreshesTrue: true, retainedConsentAfterLogout: true, siblingAppUnaffected: true, pairwiseAppUsers: true, sameOwnerCredentialRefresh: true, oldOwnerGuestDataDiscarded: true, delayedRealBackendResultRetired: true, newAccountIsolated: true, hostLogoutReceipts: logoutOperations, trustedCalls: calls }
    } finally {
      const failures = []
      for (const owner of [...active]) try { await close(owner) } catch (error) { failures.push(error) }
      hosts.clear()
      if (failures.length) throw new AggregateError(failures, 'Identity owner cleanup failed')
    }
  }
  report.status = 'passed'
  return report
}
