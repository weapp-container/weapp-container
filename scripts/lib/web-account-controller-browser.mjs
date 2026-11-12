import { readPack } from './web-acceptance-scope-browser.mjs'

// Appended to the original archive's application module. The original Page,
// template, styles and input handlers remain unmodified.
export const ACCOUNT_CONTROLLER_GUEST = `
var __controllerRect=null;
exports.__controllerQuery=function(){__controllerRect=null;wx.createSelectorQuery().select('#increment').boundingClientRect(function(v){__controllerRect=v;}).exec();return true;};
exports.__controllerRead=function(){var p=getCurrentPages()[0];return {rect:__controllerRect,page:p?{count:p.data.count,message:p.data.message}:null,launch:wx.getLaunchOptionsSync(),identity:exports.__identityRead()};};
`

const check = (value, message) => { if (!value) throw new Error(message) }
const tick = () => new Promise(resolve => setTimeout(resolve, 20))
const copy = value => structuredClone(value)
const same = (a, b) => a && b && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key])
const positive = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
const ownerKeys = ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend']

function presentation(session, root) {
  const state = session.status, observed = state.observation?.state, accepted = state.presentation?.accepted, proof = accepted?.proof
  const canvas = root.querySelector('canvas')
  if (!(state.runtimeReady && state.inputEnabled && state.metricsFence.phase === 'open' && accepted?.inputEnabled === true
    && proof?.version === '1.0' && ownerKeys.every(key => proof.owner?.[key] === session.owner?.[key])
    && positive(proof.attemptId) && proof.surfaceGeneration === observed?.surfaceGeneration
    && proof.consumedInput?.pageId === observed.currentPage?.pageId && proof.consumedInput.routePath === observed.currentPage.path
    && proof.consumedInput.templateRevision === observed.templateRevision && same(proof.consumedInput.viewport, observed.viewport)
    && proof.publication?.kind === 'external-frame' && positive(proof.publication.renderRevision)
    && canvas?.isConnected && canvas.width > 0 && canvas.height > 0)) return null
  return copy({ proof, metricsFence: state.metricsFence, canvas: { width: canvas.width, height: canvas.height }, inputEnabled: state.inputEnabled })
}

export async function runAccountController({ metrics, controlToken }) {
  const report = { schemaVersion: 1, status: 'running', owners: [], phases: [], controllerStates: [], logoutReceipts: [], calls: [], cleanup: [], limitations: [
    'WorkerWebSession QuickJS/CanvasKit on this browser only; no direct controller, other OS, V8, hardware or merchant claim.',
    'Presentation is the original browser-reported accepted GPU submission proof and connected canvas, not physical display/compositor feedback.',
    'Reference Alice/Bob identities exercise the real Node24/SQLite backend; production authentication, phone and payment are outside this scope.',
    'Rapid consecutive epochs, startup-fault retry, cleanup-failure retry and forced delivery of cancelled native callbacks are not covered by this finite scope.',
  ] }
  globalThis.__accountControllerScope = report
  const [{ BrowserHostAccountManager }, { WorkerWebSession }, { loadBrowserHostServices }, { createReferenceIdentityClient }, { WORKER_PRODUCT_CONFIG }] = await Promise.all([
    import('/worker/browser-host-account-manager.mjs'), import('/worker/worker-web-session.mjs'), import('/worker/worker-host-services.mjs'),
    import('/worker/reference-identity-client.mjs'), import('/worker/worker-product-config.mjs'),
  ])
  const pack = await readPack(new URL('/packs/controller/pack-index.json', location.href))
  const catalog = await (await fetch('/catalog.json')).json()
  const assets = copy(WORKER_PRODUCT_CONFIG.rendererAssets)
  for (const group of [assets.canvaskit, assets.font]) for (const value of Object.values(group)) if (value && typeof value === 'object' && value.url) value.url = new URL(value.url, new URL('/worker/', location.href)).href
  const control = async (path, body) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${controlToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    check(response.ok, `Host fixture rejected ${path}: ${response.status}`); return response.json()
  }
  const apps = ['controller-worker-one', 'controller-worker-two'], credentials = new Map(), controllers = [], records = []
  let manager, sequence = 0
  const wait = async (predicate, message, signal, timeout = 45000) => {
    const end = performance.now() + timeout
    for (;;) { if (signal?.aborted) throw Object.assign(new Error('Retired candidate'), { code: 'ERR_CANCELLED' }); const result = await predicate(); if (result) return result; check(performance.now() < end, message); await tick() }
  }
  const bootstrap = async (principalId, epoch) => {
    const results = await Promise.all(apps.map(miniAppId => control('/fixture/host', { miniAppId, principalId, principalEpoch: epoch })))
    for (let i = 0; i < apps.length; i++) credentials.set(JSON.stringify([apps[i], principalId, epoch]), results[i].hostAccessToken)
    return results
  }
  const createOwner = options => {
    const id = ++sequence, root = document.createElement('section'); root.id = `account-owner-${id}`; root.style.cssText = 'display:inline-block;vertical-align:top;margin:8px;width:375px;height:667px'; document.body.append(root)
    const evidence = { id, appId: options.application.appId, principalId: options.account.principalId, epoch: options.account.epoch, incarnation: options.sessionIncarnation, operationId: options.operationId, storageScope: options.storageScope, launchOptions: options.launchOptions, events: [] }
    report.owners.push(evidence)
    let native = null, startup = null, closing = null, nativeClose = null, sessionClose = null
    const session = new WorkerWebSession({ surfaceRoot: root,
      onError: error => { evidence.fault = { code: error.code, message: error.message } },
      onState: state => { evidence.lastState = { phase: state.phase, inputEnabled: state.inputEnabled, runtimeReady: state.runtimeReady, hostIdentityRevoked: state.hostIdentityRevoked } },
    })
    const mark = event => evidence.events.push({ event, at: performance.now() })
    const beginClose = () => {
      if (closing) return closing
      mark('revoke-started')
      if (native) { nativeClose = native.close(); void nativeClose.catch(() => {}) }
      sessionClose = session.close(); void sessionClose.catch(() => {})
      check(session.status.inputEnabled === false, 'Worker input remained enabled after synchronous close boundary')
      closing = (async () => {
        // Observe startup rejection separately: cancellation of an unfinished
        // start is expected, but an actual native/surface close failure is not.
        if (startup) await startup.then(() => {}, error => { evidence.startupFailure = { code: error.code, message: error.message } })
        if (native && !nativeClose) { nativeClose = native.close(); void nativeClose.catch(() => {}) }
        const results = await Promise.allSettled([nativeClose ?? Promise.resolve(), sessionClose])
        const failures = results.filter(value => value.status === 'rejected').map(value => value.reason)
        if (failures.length) throw new AggregateError(failures, 'Real Worker/native close failed')
        const final = results[1].value
        check(final.closed && final.workerClosed && final.ownedMountRemoved && !root.querySelector('[data-worker-web-session]'), 'Worker close omitted real mount/Worker final')
        evidence.closeFinal = copy(final); mark('real-close-complete'); root.remove()
        report.cleanup.push({ kind: 'worker-account-owner', id: String(id), ownership: 'created', terminal: 'closed', sessionId: final.owner?.sessionId })
      })()
      void closing.catch(error => { evidence.closeFailure = String(error) }); return closing
    }
    const identity = createReferenceIdentityClient({ endpoint: location.origin, allowLoopbackHTTP: true,
      hostToken: ({ context }) => {
        report.calls.push({ api: context.api, app: context.application.appId, epoch: context.account.epoch, sessionId: context.sessionId, packRoot: context.application.packRoot })
        const credential = credentials.get(JSON.stringify([context.application.appId, context.account.principalId, String(context.account.epoch)]))
        check(credential, 'No host credential for this exact app/account epoch'); return credential
      },
      confirmAuthorization: () => { throw new Error('Authorization UI outside this scope') },
      requestLogout: ({ backendResult }) => {
        check(backendResult.hostSessionRetained && backendResult.consentsRetained, 'Backend app logout changed host ownership')
        const receipt = options.requestLogout({ launchOptions: { route: 'pages/home/index', query: { message: 'Application logged out' } } })
        report.logoutReceipts.push({ receipt, immediate: controllers.map(controller => controller.state), nativeInput: records.filter(record => record.options.application.appId === options.application.appId).map(record => record.session.status.inputEnabled) })
        return receipt
      },
    })
    const owner = { options, session, root, evidence, identity, get services() { return native?.services },
      revoke() { void beginClose() }, detachSurface: beginClose, close: beginClose,
      start(launchOptions) {
        mark('start')
        startup = loadBrowserHostServices({ session, catalog, trusted: { application: options.application, account: options.account }, identity, allowedOrigins: [location.origin],
          onError: error => { evidence.serviceError = String(error) },
          loadOptions: { indexUrl: pack.indexUrl.href, indexSha256: globalThis.__accountControllerIndexSha256, indexSize: pack.indexBytes.length, engine: 'quickjs', renderer: 'auto', rendererPolicy: { mode: 'manifest' }, rendererAssets: assets,
            viewport: { width: metrics.windowWidth, height: metrics.windowHeight }, metrics, route: launchOptions.route ?? 'pages/home/index', query: launchOptions.query ?? {}, launchOptions, timeoutMs: 15000, loadTimeoutMs: 30000 },
        }).then(value => { native = value; evidence.owner = copy(session.owner); mark('runtime-started') })
        return startup
      },
      async waitForPresentation({ signal }) {
        mark('presentation-wait')
        const result = await wait(() => { if (session.status.fault) throw session.status.fault; return presentation(session, root) }, 'No exact accepted CanvasKit presentation', signal)
        evidence.presentation = result; mark('presentation-accepted'); return result
      },
      async invoke(method, payload) { const value = await session.request(method, payload); return value },
    }
    records.push(owner); return owner
  }
  const current = controller => [...records].reverse().find(record => record.options.application.appId === controller.application.appId && record.options.sessionIncarnation === controller.state.sessionIncarnation)
  const call = async (controller, name, args = []) => (await controller.invoke('module.call', { moduleId: pack.entry.id, export: name, args })).result[0]
  const read = controller => call(controller, '__controllerRead')
  const action = async (controller, name) => {
    await call(controller, '__identityStart', [name, { origin: location.origin, miniAppId: controller.application.appId }])
    const result = await wait(async () => { const result = await read(controller); return result.identity.operations[name]?.done && result }, `Identity ${name} did not settle`)
    const op = result.identity.operations[name]; check(!op.error, `Identity ${name} failed: ${JSON.stringify(op.error)}`); return op
  }
  const authenticate = async controller => {
    const login = await action(controller, 'login'); check(login.events.join(',') === 'callback,complete,promise', 'Login ordering changed')
    const exchange = await action(controller, 'exchange'); await action(controller, 'check')
    check((await read(controller)).identity.state.appLoggedIn, 'Backend session did not refresh application state')
    current(controller).options.grantApplication(); return exchange.value.appUserId
  }
  const realClick = async controller => {
    await call(controller, '__controllerQuery')
    const value = await wait(async () => { const value = await read(controller); return value.rect?.width > 0 && value }, 'Real guest selector did not find the input target')
    const owner = current(controller), box = owner.root.querySelector('canvas').getBoundingClientRect(), rect = value.rect
    const before = presentation(owner.session, owner.root)
    check(before, 'Real input did not start from an accepted current picture')
    const coordinate = { x: box.left + rect.left + rect.width / 2, y: box.top + rect.top + rect.height / 2 }
    check(typeof globalThis.__accountControllerClick === 'function', 'Real browser input binding missing')
    await globalThis.__accountControllerClick(coordinate)
    const clicked = await wait(async () => { const value = await read(controller); return value.page.count === 1 && value }, 'Real pointer input did not return through native transport to guest Page')
    const after = await wait(() => {
      const proof = presentation(owner.session, owner.root)
      return proof && BigInt(proof.proof.consumedInput.templateRevision) > BigInt(before.proof.consumedInput.templateRevision)
        && BigInt(proof.proof.publication.renderRevision) > BigInt(before.proof.publication.renderRevision) && proof
    }, 'Updated input picture did not advance both accepted template and render revisions')
    return { coordinate, count: clicked.page.count, before, proof: after }
  }
  const mustRejectOld = record => {
    const errors = []
    for (const method of ['requestLogout', 'grantApplication']) {
      try { record.options[method](); throw new Error('Old incarnation still had host authority') } catch (error) { check(error.code === 'ERR_CANCELLED', `Unexpected stale authority error: ${error}`); errors.push({ method, code: error.code }) }
    }
    return errors
  }
  try {
    const initial = await bootstrap('alice', '9007199254740993')
    manager = new BrowserHostAccountManager(initial[0].account)
    for (let i = 0; i < apps.length; i++) controllers.push(manager.attach({ application: initial[i].application, createOwner, launchOptions: { route: 'pages/home/index', query: { message: `Alice application ${i + 1}` } }, onState: state => report.controllerStates.push({ app: apps[i], ...copy(state) }) }))
    await Promise.all(controllers.map(controller => controller.ready))
    check(controllers.every(controller => controller.state.inputEnabled), 'Initial stable controllers did not wait for true presentation')
    check((await Promise.all(controllers.map(read))).every((value, i) => value.page.message === `Alice application ${i + 1}` && value.page.count === 0), 'Initial host query did not reach the real page')
    const firstOwner = current(controllers[0]), siblingOwner = current(controllers[1]), aliceUser = await authenticate(controllers[0]), siblingUser = await authenticate(controllers[1])
    check(aliceUser !== siblingUser, 'Pairwise app identity was not isolated')
    report.phases.push({ phase: 'initial-real-input', result: await realClick(controllers[0]), first: await read(controllers[0]), sibling: await read(controllers[1]) })
    await manager.refreshCredentials(async account => { await bootstrap(account.principalId, String(account.epoch)) })
    check(current(controllers[0]) === firstOwner && current(controllers[1]) === siblingOwner, 'Credential refresh replaced a live owner')
    await action(controllers[0], 'check')
    await call(controllers[0], '__identityStart', ['logout', {}])
    await wait(() => report.logoutReceipts.length === 1, 'Guest logout did not reach host manager')
    const immediateLogout = report.logoutReceipts[0]
    check(immediateLogout.receipt.status === 'running' && immediateLogout.immediate[0].inputEnabled === false && immediateLogout.immediate[1].inputEnabled === true && immediateLogout.nativeInput.every(value => value === false), 'App logout did not synchronously gate only its own real owner')
    const logoutId = report.logoutReceipts[0].receipt.operationId
    const logout = await wait(() => { const value = manager.query(logoutId); return value?.status !== 'running' && value }, 'App logout operation never terminated')
    check(logout.status === 'complete' && controllers[0].state.inputEnabled && current(controllers[1]) === siblingOwner, 'App logout did not preserve the stable sibling')
    const loggedOut = await read(controllers[0])
    check(loggedOut.page.count === 0 && loggedOut.page.message === 'Application logged out' && !loggedOut.identity.hasCode && !loggedOut.identity.hasBusinessSession && !loggedOut.identity.state.appLoggedIn && loggedOut.identity.state.hostLoggedIn, 'App logout inherited old guest data or lost host login')
    check((await read(controllers[1])).identity.state.appLoggedIn, 'App logout changed the sibling app session')
    report.phases.push({ phase: 'application-logout', operation: logout, state: loggedOut, oldIncarnation: mustRejectOld(firstOwner), siblingSessionId: siblingOwner.session.owner.sessionId })
    await bootstrap('bob', '9007199254740994')
    const beforeBob = controllers.map(current)
    const switched = manager.switchAccount({ principalId: 'bob', epoch: '9007199254740994' }, { launches: Object.fromEntries(apps.map((app, i) => [app, { route: 'pages/home/index', query: { message: `Bob application ${i + 1}` } }])) })
    check(controllers.every(controller => !controller.state.inputEnabled) && beforeBob.every(record => record.session.status.inputEnabled === false), 'Account epoch did not synchronously gate all inputs')
    const blocked = await Promise.all(controllers.map(async controller => { try { await read(controller); throw new Error('Business command entered a switching identity') } catch (error) { check(error.code === 'ERR_IDENTITY_SWITCHING', `Unexpected switch rejection ${error}`); return error.code } }))
    const bob = await switched; check(bob.status === 'complete', `Bob switch failed: ${JSON.stringify(bob)}`)
    const bobStates = await Promise.all(controllers.map(read))
    check(bobStates.every((value, i) => value.page.count === 0 && value.page.message === `Bob application ${i + 1}` && !value.identity.hasCode && !value.identity.hasBusinessSession && !value.identity.state.appLoggedIn), 'Account switch inherited Alice state/query')
    check(beforeBob.every((record, i) => current(controllers[i]).session.owner.sessionId !== record.session.owner.sessionId), 'Stable controller retained retired internal identity')
    const bobUser = await authenticate(controllers[0]); check(bobUser !== aliceUser, 'Bob reused Alice application identity')
    report.phases.push({ phase: 'alice-to-bob', operation: bob, immediateBusinessRejections: blocked, oldIncarnations: beforeBob.map(mustRejectOld), states: bobStates, exactEpoch: manager.account.epoch })
    report.phases.push({ phase: 'bob-real-input', result: await realClick(controllers[0]) })
    for (const app of apps) {
      const applicationOwners = report.owners.filter(owner => owner.appId === app)
      for (let i = 1; i < applicationOwners.length; i++) {
        const retired = applicationOwners[i - 1].events.find(event => event.event === 'real-close-complete'), started = applicationOwners[i].events.find(event => event.event === 'start')
        check(retired && started && retired.at <= started.at, 'Replacement started before the previous real Worker/GPU/storage close barrier')
      }
    }
    check(report.owners.every(record => !record.fault && !record.serviceError && !record.closeFailure), 'Real owner/service fault occurred')
    check(report.calls.every(call => call.packRoot === pack.index.integrityRoot), 'Trusted package root changed')
    report.checks = { stableControllers: true, exactDecimalEpochs: true, actualReferenceLogin: true, appLogoutThroughGuest: true, siblingAppRetained: true, credentialRefreshSameOwner: true, sharedSynchronousInputBarrier: true, realPointerInputToGuest: true, freshGuestDataAndQuery: true, staleIncarnationAuthorityRejected: true, actualCanvasKitPresentation: true, actualWorkerSurfaceCloseBeforeReplacement: true }
    report.status = 'passed'
  } finally {
    const failures = []
    for (const controller of controllers) try { await controller.close() } catch (error) { failures.push(error) }
    // Retain actual close failures, but still attempt every factory-owned
    // resource if an incomplete controller could not retire its candidate.
    for (const record of records) if (!record.evidence.closeFinal) try { await record.close() } catch (error) { failures.push(error) }
    credentials.clear()
    if (failures.length) { report.status = 'failed'; throw new AggregateError(failures, 'Account controller cleanup failed') }
    check(report.cleanup.length === report.owners.length && document.querySelectorAll('[data-worker-web-session],canvas,section[id^="account-owner-"]').length === 0, 'Real account surface/Worker resources leaked')
    report.closedAllOwners = true
  }
  return report
}
