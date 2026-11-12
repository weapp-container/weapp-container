/** Optional real-browser button fixture. Importing this file never launches a
 * browser, server, compiler or runtime. The caller owns all resources. */
import assert from 'node:assert/strict'

export function buttonSmokeWxml(build) {
  assert.match(build, /^(?:A|B(?:[2-9]|1[0-6])?)$/)
  return `<view class="page"><text id="build">Build ${build}</text><text id="count">Count: {{count}}</text><text id="startup-marker">{{marker}}</text>
<view id="event-parent" data-owner="parent" capture-bind:tap="captureTap" bindtap="bubbleTap">
<button id="increment" class="author-button" type="primary" data-action="increment" catchtap="increment"><text id="increment-child" data-value="{{17}}">Increment</text></button>
<button id="disabled" disabled="{{true}}" bindtap="unexpectedDisabled" bindtouchstart="unexpectedDisabled"><text id="disabled-child">Disabled</text></button>
<button id="loading" loading="{{true}}" bindtap="loadingTap">Loading</button>
<button id="disable-on-touch" disabled="{{touchDisabled}}" bindtouchstart="disableOnTouch" bindtouchend="terminalTouch" bindtouchcancel="cancelTouch" bindtap="unexpectedLateTap"><text id="disable-touch-child">Disable on touch</text></button>
<button id="arm-space" bindtap="armSpaceRebuild">Arm Space rebuild</button>
<button id="space-button" bindtap="spaceTap">Space target {{spaceRevision}}</button>
<button id="source-omitted">Default source type omitted</button>
</view></view>\n`
}

export function buttonSmokeFiles() {
  return {
    'pages/home/index.js': `Page({
  data: { count: 0, marker: 'page-default-marker', touchDisabled: false, loadingTaps: 0, spaceRevision: 0, spaceTaps: 0 },
  recordButtonEvent: function(label, event) {
    if (!this.__buttonEvents) this.__buttonEvents = [];
    if (this.__buttonEvents.length >= 256) throw new Error('Button fixture event budget exceeded');
    this.__buttonEvents.push({ label: label, type: event.type, target: event.target, currentTarget: event.currentTarget });
  },
  captureTap: function(event) { this.recordButtonEvent('capture', event); },
  bubbleTap: function(event) { this.recordButtonEvent('bubble', event); },
  increment: function(event) { this.recordButtonEvent('increment', event); this.setData({ count: this.data.count + 1 }); },
  unexpectedDisabled: function(event) { this.recordButtonEvent('disabled-leak', event); },
  loadingTap: function(event) { this.recordButtonEvent('loading', event); this.setData({ loadingTaps: this.data.loadingTaps + 1 }); },
  disableOnTouch: function(event) { this.recordButtonEvent('disable-touchstart', event); this.setData({ touchDisabled: true }); },
  terminalTouch: function(event) { this.recordButtonEvent('late-touchend', event); },
  cancelTouch: function(event) { this.recordButtonEvent('retired-touchcancel', event); },
  unexpectedLateTap: function(event) { this.recordButtonEvent('late-tap', event); },
  armSpaceRebuild: function(event) { this.recordButtonEvent('space-armed', event); this.__spaceRebuildArmed = true; var page = this; setTimeout(function() { page.setData({ spaceRevision: page.data.spaceRevision + 1 }); }, 1500); },
  spaceTap: function(event) { this.recordButtonEvent('space-tap', event); this.setData({ spaceTaps: this.data.spaceTaps + 1 }); }
});\n`,
    'public/browser-dev-button-state.js': `exports.browserDevButtonState = function() { var pages = getCurrentPages(); var page = pages[pages.length - 1]; return { fixture: 'browser-dev-button-v1', route: page.route, count: page.data.count, marker: page.data.marker, loadingTaps: page.data.loadingTaps, touchDisabled: page.data.touchDisabled, spaceRevision: page.data.spaceRevision, spaceTaps: page.data.spaceTaps, spaceArmed: page.__spaceRebuildArmed === true, events: page.__buttonEvents || [] }; };\n`,
    'app.wxss': `.page { padding: 12px; } text { display: block; color: #17324d; font-size: 14px; } button { height: 48px; min-height: 32px; margin: 6px 0; line-height: 32px; font-size: 14px; } button[type="primary"] { color: #123456; } .author-button { background-color: #d0e0f0; font-size: 19px; } [type] { border-top-width: 7px; }\n`
  }
}

/** Serialized by Playwright; no Node closure, heap mutation or alternate engine. */
export async function readButtonSmokeState({ query, expected = {} }) {
  const app = window.weappContainerDev, ownerKey = app.status.manager.executing.ownerKey
  const response = await app.request({ ownerKey, op: 'module.call', payload: query })
  if (response?.stale || response?.result?.ok !== true || !Array.isArray(response.result.result)
    || response.result.result.length !== 1) throw new Error('Actual AppService button state query failed')
  const state = response.result.result[0]
  if (state?.fixture !== 'browser-dev-button-v1' || !Array.isArray(state.events) || state.events.length > 256)
    throw new Error('Actual AppService returned an invalid bounded button observation')
  return Object.entries(expected).every(([key, value]) => state[key] === value) ? state : null
}

/** Observes native focus/key/click in every owned frame. No event is synthesized.
 * The old frame/element references are installed only by armButtonFocusProbe. */
export function installButtonNativeAudit() {
  if (window !== window.top) return
  const audit = { events: [], dropped: 0, sequence: 0, probe: null }, attached = new WeakSet()
  // Node.isConnected describes membership in a Document, not whether that
  // Document's owning iframe still belongs to the active top-level tree.
  audit.probeFacts = () => {
    const probe = audit.probe
    return { oldFrameConnected: probe?.frame?.isConnected ?? null, oldElementConnected: probe?.element?.isConnected ?? null,
      oldFrameOwnerIsTopDocument: probe?.frame?.ownerDocument === document,
      oldFrameContainedByTopDocument: Boolean(probe?.frame && document.contains(probe.frame)),
      oldFrameInert: probe?.frame?.inert ?? null, oldFramePointerEvents: probe?.frame?.style?.pointerEvents ?? null,
      oldElementOwnerIsProbeDocument: Boolean(probe?.document && probe.element?.ownerDocument === probe.document),
      oldElementRootIsProbeDocument: Boolean(probe?.document && probe.element?.getRootNode() === probe.document),
      oldDocumentHasFocus: probe?.document?.hasFocus() ?? null }
  }
  Object.defineProperty(window, '__buttonNativeAudit', { value: audit })
  const attach = frame => {
    const doc = frame.contentDocument, child = frame.contentWindow
    if (!doc || attached.has(doc)) return
    attached.add(doc)
    for (const type of ['focusin', 'keydown', 'keyup', 'click', 'pointerdown', 'pointerup', 'pointercancel']) {
      doc.addEventListener(type, event => {
        if (audit.events.length >= 512) { audit.dropped++; return }
        const probe = audit.probe, current = window.weappContainerDev?.status.manager.executing
        const ownerMatchesProbe = probe?.owner && ['workerEpoch', 'sessionId', 'packSha256', 'transportBackend'].every(key => current?.owner?.[key] === probe.owner[key])
        audit.events.push({ sequence: ++audit.sequence, type, targetId: event.target?.id ?? '', key: event.key ?? null, trusted: event.isTrusted,
          at: performance.timeOrigin + performance.now(), frameAudit: true, probe: probe?.name ?? null, repeat: event.repeat === true,
          sourceFrameIsProbeFrame: probe?.frame === frame, sourceDocumentIsProbeDocument: probe?.document === doc, targetIsProbeElement: probe?.element === event.target,
          ownerMatchesProbe: ownerMatchesProbe === true, primaryInputAtEvent: current?.inputEnabled === true && frame.inert === false && frame.style.pointerEvents === 'auto',
          ...audit.probeFacts() })
      }, true)
    }
    Object.defineProperty(child, '__buttonNativeAuditInstalled', { value: true, configurable: true })
  }
  // Parent capture sees the real srcdoc load before the presenter's target
  // load continuation. Sandbox scripts remain disabled; the audit never adds
  // allow-scripts, an inline script or an alternate frame runtime.
  document.addEventListener('load', event => {
    if (event.target?.tagName === 'IFRAME' && event.target.title === 'Weapp Container DOM surface') attach(event.target)
  }, true)
}

export function armButtonFocusProbe({ name, selector, checkpoint }) {
  const selected = window.__browserDevDomSurface.current({ owner: checkpoint?.owner, key: checkpoint?.key })
  const current = window.weappContainerDev?.status.manager.executing, frame = selected?.frame
  if (checkpoint?.inputEnabled !== true || !frame || frame.contentWindow.__buttonNativeAuditInstalled !== true)
    throw new Error('Held-key probe requires the same live primary owner and interactive DOM frame/final')
  const element = frame.contentDocument.querySelector(selector)
  if (!element || frame.contentDocument.activeElement !== element)
    throw new Error('Owned current DOM focus probe target is absent or unfocused')
  const startSequence = window.__buttonNativeAudit.sequence
  window.__buttonNativeAudit.probe = { name, frame, document: frame.contentDocument, element,
    owner: checkpoint.owner, key: checkpoint.key, startSequence }
  return { name, targetId: element.id, owner: checkpoint.owner, key: checkpoint.key, startSequence }
}

/** Verify this held-key sequence, never an earlier ordinary Space check. */
export function assertHeldButtonSpaceAudit(audit, probe) {
  assert.equal(audit.dropped, 0)
  const events = audit.events.filter(event => event.probe === probe.name && event.sequence > probe.startSequence)
  const downs = events.filter(event => event.type === 'keydown' && event.key === ' ')
  assert.equal(downs.length, 1, 'This held-key probe must observe exactly one native Space keydown')
  const keydown = downs[0]
  assert.equal(keydown.trusted, true); assert.equal(keydown.repeat, false); assert.equal(keydown.targetId, probe.targetId)
  for (const field of ['sourceFrameIsProbeFrame', 'sourceDocumentIsProbeDocument', 'targetIsProbeElement',
    'oldFrameConnected', 'oldElementConnected', 'oldFrameOwnerIsTopDocument', 'oldFrameContainedByTopDocument',
    'oldElementOwnerIsProbeDocument', 'oldElementRootIsProbeDocument', 'oldDocumentHasFocus', 'ownerMatchesProbe', 'primaryInputAtEvent'])
    assert.equal(keydown[field], true, `Held Space did not begin on the exact interactive old frame: ${field}`)
  assert.equal(keydown.oldFrameInert, false); assert.equal(keydown.oldFramePointerEvents, 'auto')
  const restored = events.filter(event => event.type === 'focusin' && event.targetId === probe.targetId)
  assert.equal(restored.length, 1, 'New surface must restore native focus exactly once for this held-key probe')
  const focus = restored[0]
  assert.equal(focus.trusted, true); assert.equal(focus.ownerMatchesProbe, true)
  for (const field of ['sourceFrameIsProbeFrame', 'sourceDocumentIsProbeDocument', 'targetIsProbeElement'])
    assert.equal(focus[field], false, `Focus did not move to a new frame after old removal: ${field}`)
  assertRetiredButtonSurface(focus)
  assert.ok(Number.isSafeInteger(keydown.sequence) && Number.isSafeInteger(focus.sequence) && keydown.sequence < focus.sequence,
    'Exact old-frame Space keydown must precede the new-frame focus restoration')
  return { keydown, restoredFocus: focus }
}

/** A retained srcdoc Document may keep its subtree connected to that Document.
 * Retirement concerns its owning frame and input/focus authority instead. */
export function assertRetiredButtonSurface(facts) {
  for (const field of ['oldFrameConnected', 'oldFrameContainedByTopDocument', 'oldDocumentHasFocus'])
    assert.equal(facts[field], false, `Old owning surface is not retired: ${field}`)
  for (const field of ['oldFrameOwnerIsTopDocument', 'oldFrameInert', 'oldElementOwnerIsProbeDocument'])
    assert.equal(facts[field], true, `Old surface provenance/input fence is unproved: ${field}`)
  assert.equal(facts.oldFramePointerEvents, 'none')
  assert.equal(typeof facts.oldElementConnected, 'boolean')
  assert.equal(typeof facts.oldElementRootIsProbeDocument, 'boolean')
  assert.equal(facts.oldElementConnected, facts.oldElementRootIsProbeDocument,
    'Node connectivity must agree with its retained Document root, independently of iframe attachment')
}

export function assertReleasedButtonSpaceAudit(audit, probe) {
  const held = assertHeldButtonSpaceAudit(audit, probe)
  const events = audit.events.filter(event => event.probe === probe.name && event.sequence > probe.startSequence)
  const ups = events.filter(event => event.type === 'keyup' && event.key === ' ')
  assert.equal(ups.length, 1, 'Exactly one genuine terminal must close this held Space sequence')
  const keyup = ups[0]
  assert.equal(keyup.trusted, true); assert.equal(keyup.targetId, probe.targetId)
  assert.equal(keyup.ownerMatchesProbe, true); assert.equal(keyup.primaryInputAtEvent, true)
  for (const field of ['sourceFrameIsProbeFrame', 'sourceDocumentIsProbeDocument', 'targetIsProbeElement']) assert.equal(keyup[field], false)
  assertRetiredButtonSurface(keyup)
  assert.ok(keyup.sequence > held.restoredFocus.sequence, 'Late keyup must occur after old-frame retirement and new focus')
  assert.equal(events.some(event => event.type === 'click' && event.targetId === probe.targetId), false,
    'Held Space must not replay a click onto the replacement surface')
  return { ...held, keyup }
}

export function readButtonNativeAudit() {
  const value = window.__buttonNativeAudit
  if (!value) throw new Error('Real button native audit is unavailable')
  return { events: value.events, dropped: value.dropped }
}

/** Exact runtime ACK plus actual current DOM input fence; manager.submission
 * is intentionally Skia-only and must never be used as a DOM receipt. */
export function buttonDomCheckpoint() {
  const current = window.weappContainerDev?.status.manager.executing
  if (!current) throw new Error('Original DOM owner is absent')
  const selected = window.__browserDevDomSurface.current()
  return { owner: current.owner, inputEnabled: selected !== null, key: selected?.key ?? null }
}

export function buttonStyleObservation() {
  const frame = window.__browserDevDomSurface.current()?.frame, doc = frame?.contentDocument
  const button = doc?.querySelector('#increment'), omitted = doc?.querySelector('#source-omitted')
  if (!button || !omitted) throw new Error('Actual button style source elements are missing')
  const style = frame.contentWindow.getComputedStyle(button)
  return { tag: button.tagName, nativeType: button.type, color: style.color, background: style.backgroundColor,
    fontSize: style.fontSize, sourceBorder: style.borderTopWidth,
    omittedSource: omitted.hasAttribute('data-wc-button-source-type'), omittedBorder: frame.contentWindow.getComputedStyle(omitted).borderTopWidth,
    loadingDisabled: doc.querySelector('#loading').disabled, loadingBusy: doc.querySelector('#loading').getAttribute('aria-busy') }
}

/** Runs only when explicitly called by the real harness. All app changes enter
 * through trusted browser input and declared Page handlers/timers. CDP is a
 * session on this caller-owned context/page, never a remote Chrome connection. */
export async function runButtonSmoke({ page, context, frame, guard, evaluate, snapshot, query, route, initialCount, save, resources, cleanup, release, result = {} }) {
  assert.equal(typeof release, 'function', 'Owned resource cleanup needs an independent bounded, non-aborted wait')
  const read = () => evaluate(readButtonSmokeState, { query })
  const waitState = async expected => {
    const value = await guard(async () => {
      const expires = performance.now() + 15_000
      while (true) {
        const value = await evaluate(readButtonSmokeState, { query, expected })
        if (value !== null) return value
        assert.ok(performance.now() < expires, 'Actual AppService button state did not reach its expectation')
        await new Promise(done => setTimeout(done, 25))
      }
    }, 20_000, 'strict awaited actual AppService button state poll')
    for (const [key, expectedValue] of Object.entries(expected)) assert.equal(value[key], expectedValue)
    assert.equal(value.route, route); return value
  }
  const current = () => guard(async () => {
    const expires = performance.now() + 15_000
    while (true) {
      const value = await evaluate(buttonDomCheckpoint)
      if (value.inputEnabled) return value
      assert.ok(performance.now() < expires, 'Current interactive accepted DOM surface did not settle')
      await new Promise(done => setTimeout(done, 25))
    }
  }, 20_000, 'unique current interactive DOM surface checkpoint')
  const waitAccepted = async previous => {
    const value = await guard(async () => {
      const expires = performance.now() + 15_000
      while (true) {
        const value = await current()
        assert.equal(value.owner.sessionId, previous.owner.sessionId); assert.equal(value.owner.workerEpoch, previous.owner.workerEpoch)
        if (value.inputEnabled && BigInt(value.key.presentationRevision) > BigInt(previous.key.presentationRevision)
          && BigInt(value.key.documentRevision) > BigInt(previous.key.documentRevision)) return value
        assert.ok(performance.now() < expires, 'Actual newer DOM runtime final/input fence did not settle')
        await new Promise(done => setTimeout(done, 25))
      }
    }, 20_000, 'strict awaited actual newer accepted DOM presentation')
    return value
  }
  const quiet = () => guard(() => page.waitForTimeout(250), 1000, 'bounded late native event observation')
  const clickPoint = async selector => {
    const box = await guard(() => frame().locator(selector).boundingBox(), 15_000, 'actual button descendant geometry')
    assert.ok(box?.width > 0 && box.height > 0)
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  Object.assign(result, { fixture: 'button', status: 'running', checks: [], boundary: 'Actual owned Chromium + fixed producer + QuickJS Worker observations only; no official, GPU, performance or seven-host gate claim.' })
  const check = (name, observation) => result.checks.push({ name, status: 'passed', observation })
  // The ordinary A click must be the FIRST real button click, on its text child.
  let state = await waitState({ count: initialCount + 1 })
  assert.deepEqual(state.events.map(event => event.label), ['capture', 'increment'])
  const first = state.events[1]
  assert.equal(first.target.id, 'increment-child'); assert.equal(first.target.dataset.value, 17)
  assert.equal(first.currentTarget.id, 'increment'); assert.equal(first.currentTarget.dataset.action, 'increment')
  assert.equal(state.events[0].currentTarget.id, 'event-parent')
  check('first-child-target-dataset-capture-catch', state)
  for (const [key, count] of [['Enter', initialCount + 2], ['Space', initialCount + 3]]) {
    const previous = await current()
    await guard(() => frame().locator('#increment').focus(), 15_000, `actual ${key} button focus`)
    await guard(() => page.keyboard.press(key), 15_000, `trusted native ${key}`)
    state = await waitState({ count }); await waitAccepted(previous)
    assert.equal(state.events.filter(event => event.label === 'increment').length, count - initialCount)
    assert.equal(state.events.some(event => event.label === 'bubble'), false)
    check(`native-${key}-single-tap`, state)
  }
  const beforeDisabled = await read(), disabledPoint = await clickPoint('#disabled-child')
  await guard(() => page.mouse.click(disabledPoint.x, disabledPoint.y), 15_000, 'actual disabled descendant click')
  await quiet(); assert.deepEqual(await read(), beforeDisabled)
  check('native-disabled-descendant-no-parent-or-target-events', beforeDisabled)
  const beforeLoading = await current()
  await guard(() => frame().locator('#loading').click(), 15_000, 'actual loading button click')
  state = await waitState({ loadingTaps: 1 }); await waitAccepted(beforeLoading)
  check('loading-remains-interactive', state)
  const style = await evaluate(buttonStyleObservation)
  assert.deepEqual(style, { tag: 'BUTTON', nativeType: 'button', color: 'rgb(18, 52, 86)', background: 'rgb(208, 224, 240)',
    fontSize: '19px', sourceBorder: '7px', omittedSource: false, omittedBorder: '1px', loadingDisabled: false, loadingBusy: 'true' })
  check('actual-author-css-and-source-type-selectors', style)
  await snapshot('02-button-native-and-style')
  let cdp, acquiring
  try {
    acquiring = context.newCDPSession(page).then(value => {
      cdp = value
      resources.push({ resource: 'button-touch-cdp-session', createdByThisRun: true, browserConnection: 'owned context.newCDPSession(page); no remote connection', retained: false })
      return value
    })
    await guard(() => acquiring, 15_000, 'touch-only CDP session on owned context/page')
    const previous = await current(), point = await clickPoint('#disable-touch-child')
    await guard(() => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 7 }] }), 15_000, 'real native touchstart')
    state = await waitState({ touchDisabled: true }); const accepted = await waitAccepted(previous)
    const retired = await read()
    assert.equal(retired.events.filter(event => event.label === 'retired-touchcancel').length, 1)
    await guard(() => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }), 15_000, 'late real native touchend after accepted disabled rebuild')
    await quiet(); state = await read()
    assert.deepEqual(state, retired, 'Late terminal leaked a new target or ancestor event after real retirement')
    assert.equal(state.events.filter(event => event.label === 'disable-touchstart').length, 1)
    assert.equal(state.events.filter(event => event.label === 'retired-touchcancel').length, 1)
    assert.equal(state.events.some(event => ['late-touchend', 'late-tap', 'disabled-leak'].includes(event.label)), false)
    check('touchstart-disable-accepted-retirement-late-terminal', { state, previous, accepted })
    const fresh = await clickPoint('#increment-child'), freshPrevious = await current()
    await guard(() => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...fresh, id: 7 }] }), 15_000, 'fresh contact after old contact retirement')
    await guard(() => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }), 15_000, 'fresh terminal after old contact retirement')
    state = await waitState({ count: initialCount + 4 }); await waitAccepted(freshPrevious)
    check('new-trusted-touch-works-after-retired-contact', state)
  } finally {
    if (acquiring && !cdp) {
      try { await release(() => acquiring, 15_000, 'settle original owned CDP acquisition before cleanup') }
      catch (error) { cleanup.push({ resource: 'button-touch-cdp-acquisition', status: 'unresolved', error: { message: String(error.message) } }); throw error }
    }
    if (cdp) {
      try { await release(() => cdp.detach(), 15_000, 'owned touch CDP detach'); cleanup.push({ resource: 'button-touch-cdp-session', status: 'detached' }) }
      catch (error) { cleanup.push({ resource: 'button-touch-cdp-session', status: 'unresolved', error: { message: String(error.message) } }); throw error }
    }
  }
  await guard(() => frame().locator('#arm-space').click(), 15_000, 'real UI arms declared AppService timer')
  await waitState({ spaceRevision: 0, spaceArmed: true })
  await guard(() => frame().locator('#space-button').focus(), 15_000, 'real Space target focus')
  const beforeSpace = await current()
  assert.equal(beforeSpace.inputEnabled, true, 'Held Space requires a live primary input checkpoint')
  const heldProbe = await evaluate(armButtonFocusProbe, { name: 'space-held-rebuild', selector: '#space-button', checkpoint: beforeSpace })
  let heldState
  try {
    await guard(() => page.keyboard.down('Space'), 15_000, 'real held Space keydown')
    state = await waitState({ spaceRevision: 1 }); await waitAccepted(beforeSpace)
    const focus = await evaluate(() => {
      const frame = window.__browserDevDomSurface.current()?.frame
      if (!frame) throw new Error('Replacement interactive DOM surface is absent after accepted focus restoration')
      const probe = window.__buttonNativeAudit.probe
      return { id: frame.contentDocument.activeElement?.id, currentFrameIsProbeFrame: frame === probe.frame,
        currentDocumentIsProbeDocument: frame.contentDocument === probe.document, ...window.__buttonNativeAudit.probeFacts() }
    })
    assert.equal(focus.id, 'space-button'); assert.equal(focus.currentFrameIsProbeFrame, false); assert.equal(focus.currentDocumentIsProbeDocument, false)
    assertRetiredButtonSurface(focus)
    heldState = await read()
    const native = await evaluate(readButtonNativeAudit)
    const heldNative = assertHeldButtonSpaceAudit(native, heldProbe)
    check('held-Space-rebuild-focus-after-real-old-frame-removal', { state, focus, probe: heldProbe, heldNative })
  } finally { await release(() => page.keyboard.up('Space'), 15_000, 'release this harness held Space key') }
  await quiet(); state = await waitState({ spaceTaps: 0 })
  assert.deepEqual(state, heldState, 'Late real keyup changed AppService state after the old owning frame retired')
  const releasedHeld = assertReleasedButtonSpaceAudit(await evaluate(readButtonNativeAudit), heldProbe)
  check('held-Space-native-keyup-after-retirement-no-click', { state, releasedHeld })
  const freshSpace = await current()
  await guard(() => page.keyboard.press('Space'), 15_000, 'fresh native Space after surface replacement')
  state = await waitState({ spaceTaps: 1 }); await waitAccepted(freshSpace)
  check('late-keyup-no-replay-and-fresh-Space-single-tap', state)
  const native = await evaluate(readButtonNativeAudit)
  assert.equal(native.dropped, 0)
  assert.ok(native.events.some(event => event.type === 'click' && event.targetId === 'increment-child' && event.trusted))
  assert.ok(native.events.some(event => event.type === 'keydown' && event.key === 'Enter' && event.trusted))
  assert.ok(native.events.some(event => event.type === 'keydown' && event.key === ' ' && event.trusted))
  assert.ok(native.events.some(event => event.type === 'pointerdown' && event.targetId === 'disable-touch-child' && event.trusted))
  result.nativeAudit = native; result.finalState = state; result.status = 'passed'
  await snapshot('02-button-late-native-retirement')
  await save('02-button-report.json', result)
  return result
}
