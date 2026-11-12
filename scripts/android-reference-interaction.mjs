/** Black-box reference-app inputs. Runtime calls are never used to simulate a touch. */
import assert from 'node:assert/strict'

const nodes = node => node ? [node, ...(node.children || []).flatMap(nodes)] : []
const texts = receipt => nodes(receipt.frame?.root).map(node => node.text)
const positive = value => Number.isFinite(value) && value > 0

export function referenceTapPoint(receipt, publicId) {
  const matches = nodes(receipt.frame?.root).filter(node => node.attributes?.id === publicId || node.id === publicId)
  assert.equal(matches.length, 1, `Expected one rendered #${publicId}`)
  const bounds = matches[0].bounds, viewport = receipt.frame.viewport, surface = receipt.surface
  assert.ok(bounds && [bounds.width, bounds.height, viewport.width, viewport.height, surface.width, surface.height].every(positive), 'Invalid input geometry')
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
  assert.ok(x >= viewport.x && y >= viewport.y && x < viewport.x + viewport.width && y < viewport.y + viewport.height, `#${publicId} is outside the visible viewport`)
  assert.ok(Number.isFinite(surface.screenX) && Number.isFinite(surface.screenY), 'Missing physical surface origin')
  return {
    x: Math.round(surface.screenX + (x - viewport.x) * surface.width / viewport.width),
    y: Math.round(surface.screenY + (y - viewport.y) * surface.height / viewport.height),
  }
}

export function inspectInteractionReceipt(receipt, expected) {
  assert.equal(receipt.schemaVersion, 1, 'Unknown interaction receipt schema')
  for (const key of ['sessionId', 'engine', 'manifestIntegrity']) assert.equal(receipt[key], expected[key], `Interaction ${key} changed`)
  assert.ok(Number.isSafeInteger(receipt.revision) && receipt.revision >= 0, 'Invalid interaction revision')
  assert.ok(Number.isSafeInteger(receipt.frame?.frame_id) && receipt.frame.frame_id > 0, 'Missing or invalid committed frame ID')
  assert.ok(Number.isSafeInteger(receipt.surface?.presentedFrameId) && receipt.surface.presentedFrameId >= 0, 'Missing or invalid presented frame ID')
  assert.ok(['ready', 'suspended', 'closed'].includes(receipt.status), 'Invalid interaction state')
  return receipt
}

export function displaySizeRestore(text) {
  const physical = /^Physical size: (\d+)x(\d+)\s*$/m.exec(text)
  const overrides = [...text.matchAll(/^Override size: (\d+)x(\d+)\s*$/gm)]
  assert.ok(physical && [physical[1], physical[2]].every(value => Number(value) > 0) && overrides.length <= 1
    && overrides.every(value => [value[1], value[2]].every(dimension => Number(dimension) > 0)), 'Cannot establish original display size')
  return overrides.length ? `${overrides[0][1]}x${overrides[0][2]}` : 'reset'
}

export function referenceResizeTarget(text) {
  const override = displaySizeRestore(text)
  const active = override === 'reset' ? /^Physical size: (\d+x\d+)\s*$/m.exec(text)[1] : override
  return active === '900x1600' ? '1000x1700' : '900x1600'
}

export function displayDensityRestore(text) {
  const physical = /^Physical density: (\d+)\s*$/m.exec(text)
  const overrides = [...text.matchAll(/^Override density: (\d+)\s*$/gm)]
  assert.ok(physical && Number(physical[1]) > 0 && overrides.length <= 1
    && overrides.every(value => Number(value[1]) > 0), 'Cannot establish original display density')
  return overrides.length ? overrides[0][1] : 'reset'
}

export function referenceDensityTarget(text) {
  const override = displayDensityRestore(text)
  const active = override === 'reset' ? /^Physical density: (\d+)\s*$/m.exec(text)[1] : override
  return active === '480' ? '420' : '480'
}

function observeDisplay(command, options) {
  const size = command(['shell', 'wm', 'size'], options).text
  const density = command(['shell', 'wm', 'density'], options).text
  const sizeRestore = displaySizeRestore(size), densityRestore = displayDensityRestore(density)
  const activeSize = (sizeRestore === 'reset' ? /^Physical size: (\d+x\d+)\s*$/m.exec(size)[1] : sizeRestore).split('x').map(Number)
  const dpi = Number(densityRestore === 'reset' ? /^Physical density: (\d+)\s*$/m.exec(density)[1] : densityRestore)
  assert.ok(activeSize.every(positive) && positive(dpi), 'Invalid active display dimensions or density')
  return { size, density, sizeRestore, densityRestore, width: activeSize[0], height: activeSize[1], pixelRatio: dpi / 160 }
}

/** Verify host projection against independent OS display queries, not receipt equality alone. */
export function assertReferenceHostInfo(info, receipt, display) {
  const raw = receipt.windowObservation, metrics = receipt.displayMetrics
  assert.ok(info && raw && metrics, 'Missing API snapshot or observed host window metrics')
  const near = (actual, expected, label) => assert.ok(Number.isFinite(actual) && Number.isFinite(expected)
    && Math.abs(actual - expected) <= 1e-6, `${label}: expected ${expected}, received ${actual}`)
  near(raw.density, display.pixelRatio, 'Observed Android density differs from wm density')
  assert.equal(raw.displayWidth, display.width, 'Observed screen width differs from wm size')
  assert.equal(raw.displayHeight, display.height, 'Observed screen height differs from wm size')
  near(metrics.pixelRatio, display.pixelRatio, 'Runtime display density')
  assert.ok(['portrait', 'landscape'].includes(raw.deviceOrientation), 'Missing observed device orientation')
  assert.equal(info.settings?.deviceOrientation, raw.deviceOrientation, 'System setting orientation is stale')
  assert.equal(info.system?.deviceOrientation, raw.deviceOrientation, 'System information orientation is stale')
  for (const [name, value] of Object.entries({ getWindowInfo: info.window, getSystemInfoSync: info.system })) {
    assert.ok(value && typeof value === 'object', `Missing ${name} result`)
    near(value.pixelRatio, display.pixelRatio, `${name}.pixelRatio`)
    assert.equal(value.screenWidth, Math.round(display.width / display.pixelRatio), `${name}.screenWidth`)
    assert.equal(value.screenHeight, Math.round(display.height / display.pixelRatio), `${name}.screenHeight`)
    assert.equal(value.windowWidth, receipt.viewport.width, `${name}.windowWidth`)
    assert.equal(value.windowHeight, receipt.viewport.height, `${name}.windowHeight`)
    near(value.statusBarHeight, raw.statusBars?.top / display.pixelRatio, `${name}.statusBarHeight`)
    assert.ok(!Object.hasOwn(value, 'windowTop'), `${name} must not invent windowTop`)
    if (raw.safeAreaMapping === 'unknown') assert.ok(!Object.hasOwn(value, 'safeArea'), `${name} must not invent an unverified safe-area transform`)
  }
  near(info.window.screenTop, raw.windowOrigin?.y / display.pixelRatio, 'getWindowInfo.screenTop host window origin')
  assert.ok(info.device && typeof info.device.platform === 'string' && info.device.platform.length > 0, 'Missing device snapshot')
  assert.ok(!Object.hasOwn(info.device, 'pixelRatio'), 'getDeviceInfo must not invent pixelRatio')
  assert.ok(!Object.hasOwn(info.system, 'screenTop'), 'getSystemInfoSync must not invent screenTop')
}

/** The caller owns command recording, PID checks, receipt bytes and screenshots. */
export async function exerciseAndroidReference(context) {
  const { command, read, save, capture, assertLive, wait, now, timeoutMs, expected, evidence } = context
  assert.ok(context.serial.startsWith('emulator-'), 'Reference resize exercise requires an explicitly selected emulator')
  Object.assign(evidence, { schemaVersion: 1, status: 'running', checks: {}, displayCleanup: { status: 'not-needed' }, densityCleanup: { status: 'not-needed' },
    callbackOrderOracle: { status: 'unknown', baseline: 'DevTools 2.02.2608080 / base library 3.17.3',
      reason: 'Existing official App and Page traces are separate; a joint foreground/background callback oracle has not been captured' },
    evidenceBoundary: 'Real adb touch, display resize/density and HOME/resume; API snapshots are checked against wm size/density, committed tree, GLES presentation and OS screenshots',
    limitations: ['Reference fixture only', 'Callback ordering is the current implementation contract; joint fixed-version DevTools comparison remains unknown', 'Safe-area coordinate mapping to the fixed official runtime remains unknown and is omitted', 'Single-pointer tap coverage; scroll, multi-touch and full gesture semantics remain unverified', 'Official emulator execution does not establish real-device or physical GPU parity'] })
  let current, restore = null, restoreDensity = null, originalViewport = null
  const presented = receipt => receipt.status === 'ready' && receipt.surface?.backend === 'skia-gpu-gles'
    && receipt.surface.presentedFrameId > 0
    && receipt.surface.presentedFrameId === receipt.frame?.frame_id
  async function captureFrame(label) {
    const accepted = await capture(label)
    // The compositor can settle after polling. Subsequent input must use the
    // accepted capture's current frame, not the earlier polled geometry.
    if (accepted !== undefined) current = inspectInteractionReceipt(accepted, expected)
  }
  async function poll(label, predicate, foreground = true) {
    const deadline = now() + timeoutMs
    let last
    while (now() < deadline) {
      assertLive(foreground)
      const value = read()
      if (value) {
        last = inspectInteractionReceipt(value, expected)
        if (predicate(last)) { save(label, last); return last }
      }
      await wait(100)
    }
    if (last) save(`${label}-timeout`, last)
    throw new Error(`Deadline expired waiting for reference interaction: ${label}`)
  }
  async function tap(id, label, predicate) {
    const previous = current.revision
    const point = referenceTapPoint(current, id)
    assertLive(true)
    command(['shell', 'input', 'tap', String(point.x), String(point.y)])
    current = await poll(label, receipt => receipt.revision > previous && presented(receipt) && predicate(receipt))
    evidence.checks[label] = { status: 'passed', publicId: id, physicalPoint: point, revision: current.revision, frameId: current.frame.frame_id }
    await captureFrame(label)
  }
  try {
    current = await poll('initial', presented)
    assert.equal(current.page?.route, 'pages/home/index', 'Reference route differs')
    assert.equal(current.page.data.count, 0, 'Reference page must start at zero')
    assert.ok(texts(current).includes('组件计数：0'), 'Reference component did not start at zero')
    const initialTrace = ['app:launch', 'app:show', 'page:load', 'page:show', 'page:ready']
    assert.deepEqual(current.page.data.lifecycleTrace, initialTrace, 'Initial callbacks must run App launch/show before Page load/show/ready')
    originalViewport = { ...current.viewport }
    const initialDisplay = observeDisplay(command)
    assertReferenceHostInfo(current.page.data.moduleScopeHostInfo, current, initialDisplay)
    evidence.checks.initial = { status: 'passed', viewport: originalViewport, frameId: current.frame.frame_id, callbackTrace: current.page.data.lifecycleTrace,
      osDisplay: initialDisplay, moduleScopeHostInfo: current.page.data.moduleScopeHostInfo }
    await captureFrame('initial')
    await tap('increment', 'page-tap', receipt => receipt.page?.data?.count === 1 && texts(receipt).includes('点击次数：1'))
    await tap('component-increment', 'component-tap', receipt => receipt.page?.data?.count === 1
      && ['点击次数：1', '组件计数：1', '页面 slot：1'].every(text => texts(receipt).includes(text)))
    await tap('component-slot', 'slot-tap', receipt => receipt.page?.data?.count === 2
      && ['点击次数：2', '组件计数：1', '页面 slot：2'].every(text => texts(receipt).includes(text)))
    assertReferenceHostInfo(current.page.data.tapHostInfo, current, initialDisplay)

    assertLive(true)
    const originalSize = command(['shell', 'wm', 'size']).text
    restore = displaySizeRestore(originalSize)
    evidence.originalDisplaySize = restore
    const previous = current.revision
    // This operation is explicitly limited to the selected official emulator.
    // Restore the observed override, including a pre-existing override, in finally.
    command(['shell', 'wm', 'size', referenceResizeTarget(originalSize)])
    current = await poll('resize', receipt => receipt.revision > previous && presented(receipt)
      && receipt.viewport?.width !== originalViewport.width && receipt.page?.data?.count === 2
      && receipt.page.data.windowInfo?.windowWidth === receipt.viewport.width
      && receipt.page.data.windowInfo?.windowHeight === receipt.viewport.height)
    assert.equal(current.hostWindow?.width, current.viewport.width, 'Runtime window width is stale after resize')
    assert.equal(current.hostWindow?.height, current.viewport.height, 'Runtime window height is stale after resize')
    const resizedDisplay = observeDisplay(command)
    assertReferenceHostInfo(current.page.data.resizeHostInfo, current, resizedDisplay)
    evidence.checks.resize = { status: 'passed', viewport: current.viewport, hostWindow: current.hostWindow,
      osDisplay: resizedDisplay, callbackHostInfo: current.page.data.resizeHostInfo,
      callbackWindowInfo: current.page.data.windowInfo, callbackTrace: current.page.data.lifecycleTrace, sessionPreserved: true }
    await captureFrame('resize')
    // Exercise the same OS hit-test mapping after the drawable allocation
    // changes; matching API dimensions alone cannot prove pixel placement.
    await tap('increment', 'resized-page-tap', receipt => receipt.page?.data?.count === 3
      && ['点击次数：3', '组件计数：1', '页面 slot：3'].every(text => texts(receipt).includes(text)))
    assertReferenceHostInfo(current.page.data.tapHostInfo, current, resizedDisplay)
    command(['shell', 'wm', 'size', restore])
    assert.equal(displaySizeRestore(command(['shell', 'wm', 'size']).text), restore, 'Display override restoration was not observed')
    restore = null
    current = await poll('resize-restored', receipt => presented(receipt)
      && receipt.viewport?.width === originalViewport.width && receipt.viewport?.height === originalViewport.height)
    evidence.displayCleanup = { status: 'passed', viewport: current.viewport }
    await captureFrame('resize-restored')

    const originalDensity = command(['shell', 'wm', 'density']).text
    restoreDensity = displayDensityRestore(originalDensity)
    evidence.originalDisplayDensity = restoreDensity
    const densityRevision = current.revision
    const targetDensity = referenceDensityTarget(originalDensity)
    command(['shell', 'wm', 'density', targetDensity])
    const changedDisplay = observeDisplay(command)
    assert.equal(changedDisplay.pixelRatio, Number(targetDensity) / 160, 'Density override was not observed')
    current = await poll('density', receipt => receipt.revision > densityRevision && presented(receipt)
      && receipt.page?.data?.count === 3 && receipt.page.data.resizeHostInfo?.window?.pixelRatio === changedDisplay.pixelRatio)
    assertReferenceHostInfo(current.page.data.resizeHostInfo, current, changedDisplay)
    assert.deepEqual(current.page.data.moduleScopeHostInfo, evidence.checks.initial.moduleScopeHostInfo, 'Density change must preserve the original module-scope observation')
    evidence.checks.density = { status: 'passed', osDisplay: changedDisplay, viewport: current.viewport,
      callbackHostInfo: current.page.data.resizeHostInfo, sessionPreserved: true, frameId: current.frame.frame_id }
    await captureFrame('density')
    command(['shell', 'wm', 'density', restoreDensity])
    assert.equal(displayDensityRestore(command(['shell', 'wm', 'density']).text), restoreDensity, 'Density override restoration was not observed')
    restoreDensity = null
    current = await poll('density-restored', receipt => presented(receipt)
      && receipt.viewport?.width === originalViewport.width && receipt.viewport?.height === originalViewport.height
      && receipt.page?.data?.resizeHostInfo?.window?.pixelRatio === initialDisplay.pixelRatio)
    assertReferenceHostInfo(current.page.data.resizeHostInfo, current, observeDisplay(command))
    evidence.densityCleanup = { status: 'passed', viewport: current.viewport, pixelRatio: initialDisplay.pixelRatio }
    await captureFrame('density-restored')

    const lifecycleSequence = Math.max(0, ...(current.lifecycle || []).map(item => item.sequence))
    assertLive(true)
    command(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
    const hidden = await poll('background', receipt => receipt.status === 'suspended'
      && receipt.lifecycle?.some(item => item.sequence > lifecycleSequence && item.event === 'hide')
      && receipt.page?.data?.lifecycleTrace?.slice(-2).join(',') === 'app:hide,page:hide', false)
    const hideSequence = Math.max(...hidden.lifecycle.filter(item => item.event === 'hide').map(item => item.sequence))
    // A configuration change while paused must be installed before onShow.
    const pausedDensity = command(['shell', 'wm', 'density']).text
    restoreDensity = displayDensityRestore(pausedDensity)
    command(['shell', 'wm', 'density', referenceDensityTarget(pausedDensity)])
    const resumeDisplay = observeDisplay(command)
    command(['shell', 'am', 'start', '-W', '-n', `${context.package}/.MainActivity`], { timeoutMs: 15_000 })
    current = await poll('resume', receipt => presented(receipt) && receipt.page?.data?.count === 3
      && receipt.lifecycle?.some(item => item.sequence > hideSequence && item.event === 'show')
      && receipt.page.data.showHostInfo?.window?.pixelRatio === resumeDisplay.pixelRatio
      && receipt.page.data.lifecycleTrace?.filter(item => ['app:hide', 'page:hide', 'app:show', 'page:show'].includes(item)).slice(-4).join(',') === 'app:hide,page:hide,app:show,page:show')
    assertReferenceHostInfo(current.page.data.showHostInfo, current, resumeDisplay)
    assert.ok(texts(current).includes('组件计数：1'), 'Component state was reset by lifecycle transition')
    evidence.checks.lifecycle = { status: 'passed', hideSequence, lifecycle: current.lifecycle,
      osDisplay: resumeDisplay, onShowHostInfo: current.page.data.showHostInfo,
      callbackTrace: current.page.data.lifecycleTrace, sessionPreserved: true, pageCount: 3, componentCount: 1 }
    await captureFrame('resume')
    command(['shell', 'wm', 'density', restoreDensity])
    assert.equal(displayDensityRestore(command(['shell', 'wm', 'density']).text), restoreDensity, 'Post-resume density restoration was not observed')
    restoreDensity = null
    current = await poll('resume-density-restored', receipt => presented(receipt)
      && receipt.viewport?.width === originalViewport.width && receipt.viewport?.height === originalViewport.height
      && receipt.page?.data?.resizeHostInfo?.window?.pixelRatio === initialDisplay.pixelRatio)
    assertReferenceHostInfo(current.page.data.resizeHostInfo, current, observeDisplay(command))
    evidence.densityCleanup = { status: 'passed', viewport: current.viewport, pixelRatio: initialDisplay.pixelRatio, restoredAfterResume: true }
    await captureFrame('resume-density-restored')
    evidence.status = 'passed'
    return evidence
  } catch (error) {
    evidence.status = 'failed'
    evidence.error = error.message
    throw error
  } finally {
    const cleanupErrors = []
    for (const [setting, value, key, parse] of [
      ['density', restoreDensity, 'densityCleanup', displayDensityRestore],
      ['size', restore, 'displayCleanup', displaySizeRestore],
    ]) {
      if (value === null) continue
      try {
        command(['shell', 'wm', setting, value], { cleanup: true })
        const observed = parse(command(['shell', 'wm', setting], { cleanup: true }).text)
        assert.equal(observed, value, `${setting} override restoration was not observed`)
        evidence[key] = { status: 'passed', restored: value }
      } catch (error) {
        evidence.status = 'failed'
        evidence[key] = { status: 'failed', reason: error.message }
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length) throw new Error(`Android display cleanup failed: ${cleanupErrors.map(error => error.message).join('; ')}`, { cause: new AggregateError(cleanupErrors) })
  }
}
