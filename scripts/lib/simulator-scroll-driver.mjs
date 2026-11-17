/** Browser RAF is the input clock. This function runs in the existing page;
 * every observed RAF requests exactly one native CDP wheel, never catchup. */
export function scheduleBrowserRafWheels({ bindingName, controlName, count, maxInflight }) {
  if (globalThis[controlName]) throw new Error('RAF wheel driver is already installed')
  const records = [], errors = []
  let handle = null, pending = 0, stopped = false, terminalStatus, resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const snapshot = () => ({ status: terminalStatus, acknowledgement: 'native-command-admission', records, errors, pending })
  function finish(status) {
    if (stopped) return
    stopped = true
    terminalStatus = status
    if (handle !== null) cancelAnimationFrame(handle)
    handle = null
    resolveDone(snapshot())
  }
  function tick(timestamp) {
    handle = null
    if (stopped) return
    if (pending >= maxInflight) {
      errors.push({ code: 'ERR_DRIVER_BACKPRESSURE', rafTimestamp: timestamp, observedAt: performance.now(), pending })
      finish('failed')
      return
    }
    const record = { index: records.length, rafTimestamp: timestamp, scheduledAt: performance.now(), inflightBefore: pending }
    records.push(record)
    pending++
    let request
    try { request = globalThis[bindingName](record) }
    catch (error) { request = Promise.reject(error) }
    Promise.resolve(request).then(reply => {
      record.admissionAcknowledgedAt = performance.now()
      record.ok = reply?.ok === true && reply?.admitted === true
      if (!record.ok) {
        errors.push({ code: reply?.code || 'ERR_DRIVER_DISPATCH', index: record.index, message: reply?.error || 'native wheel admission failed' })
        finish('failed')
      }
    }, error => {
      record.admissionAcknowledgedAt = performance.now()
      record.ok = false
      errors.push({ code: 'ERR_DRIVER_BINDING', index: record.index, message: error.message })
      finish('failed')
    }).finally(() => {
      pending--
      if (!stopped && records.length === count && pending === 0) finish('completed')
    })
    if (records.length < count && !stopped) handle = requestAnimationFrame(tick)
  }
  globalThis[controlName] = () => {
    if (!stopped) finish('cancelled')
    const result = snapshot()
    delete globalThis[controlName]
    return result
  }
  handle = requestAnimationFrame(tick)
  return done
}

export function stopBrowserRafWheels(controlName) {
  return globalThis[controlName]?.() ?? null
}

/** Own one binding and RAF callback on an existing page, not its CDP session.
 * The caller detaches that session even after timeout to settle native calls. */
export async function driveBrowserRafWheels({ page, cdp, x, y, signal, evidence = {}, count = 241, maxInflight = 4, timeoutMs = 15_000, cleanupTimeoutMs = 1_000 }) {
  if (![x, y].every(Number.isFinite) || !Number.isSafeInteger(count) || count < 1 ||
      !Number.isSafeInteger(maxInflight) || maxInflight < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs <= 0) {
    throw new Error('invalid RAF wheel driver options')
  }
  signal?.throwIfAborted()
  const bindingName = '__weappNativeRafWheel', controlName = '__weappRafWheelControl'
  Object.assign(evidence, { driverVersion: 2,
    method: 'one requested 3 CSS-pixel native wheel per browser RAF via exposeBinding; immediate command-admission acknowledgement; native CDP completion drained separately; CDP delta converted using actual browser DPR; no Node pacing, catchup or synthetic DOM events',
    count, maxInflight, timeoutMs, cleanupTimeoutMs,
    requestedLogicalDelta: { x: 0, y: 3, unit: 'css-px' }, dispatches: [], errors: [], cleanup: {} })
  let active = true, pending = 0, nextIndex = 0, lastTimestamp = -Infinity, bindingAcquisition, bindingCleanup, timer, abort
  let bindingAcquired = false, schedulerStarted = false, phase = 'browser-dpr'
  let browserResult, failure, rejectNativeFailure
  const nativeJobs = new Set()
  const nativeFailure = new Promise((_, reject) => { rejectNativeFailure = reject })
  // A native response can fail after the admission loop has been interrupted.
  // Keep that late rejection observed; the caller owns CDP detach on failure.
  nativeFailure.catch(() => {})
  function failNative(error) {
    active = false
    rejectNativeFailure(error)
  }
  function ensureActive() {
    if (!active) throw new Error('RAF wheel driver has stopped')
  }
  async function boundedCleanup(name, operation) {
    let cleanupTimer, finished = false
    const cleanup = Promise.resolve().then(operation).then(value => {
      finished = true
      return value
    }, error => {
      finished = true
      throw error
    })
    try {
      return await Promise.race([cleanup, new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => {
          const error = new Error(`RAF wheel driver ${name} cleanup exceeded ${cleanupTimeoutMs} ms`)
          error.code = 'ERR_DRIVER_CLEANUP_TIMEOUT'
          reject(error)
        }, cleanupTimeoutMs)
      })])
    } finally {
      clearTimeout(cleanupTimer)
      if (!finished) evidence.cleanup[`${name}IncompleteAtReturn`] = true
    }
  }
  const interrupted = new Promise((_, reject) => {
    timer = setTimeout(() => {
      active = false
      evidence.timeoutPhase = phase
      const error = new Error(`RAF wheel driver exceeded ${timeoutMs} ms`)
      error.code = 'ERR_DRIVER_TIMEOUT'
      reject(error)
    }, timeoutMs)
    abort = () => {
      active = false
      const error = signal.reason instanceof Error ? signal.reason : new Error('RAF wheel driver aborted')
      failure ??= error
      reject(error)
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
  const complete = async () => {
    const devicePixelRatio = await page.evaluate(() => globalThis.devicePixelRatio)
    ensureActive()
    if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) throw new Error('browser devicePixelRatio must be positive and finite')
    // Chromium's native wheel input path divides CDP deltas by device scale
    // before DOM delivery. Keep the requested DOM/CSS delta at three pixels;
    // the strict gate independently verifies the actual trusted DOM events.
    const cdpDeltaY = evidence.requestedLogicalDelta.y * devicePixelRatio
    evidence.devicePixelRatio = devicePixelRatio
    evidence.cdpPhysicalDelta = { x: 0, y: cdpDeltaY, unit: 'device-px' }
    phase = 'binding-acquisition'
    // Keep ownership of an acquisition that settles after timeout. Its result
    // still has to be disposed, even though this run can never resume.
    bindingAcquisition = Promise.resolve().then(() => page.exposeBinding(bindingName, (source, request) => {
      const receivedAt = performance.now()
      if (!active) return { ok: false, error: 'RAF wheel driver has stopped' }
      if (source.page !== page || source.frame !== page.mainFrame() || request?.index !== nextIndex ||
          !Number.isFinite(request.rafTimestamp) || request.rafTimestamp <= lastTimestamp ||
          !Number.isFinite(request.scheduledAt) || request.scheduledAt < request.rafTimestamp || nextIndex >= count) {
        const code = 'ERR_DRIVER_REQUEST', error = 'invalid RAF wheel binding request'
        evidence.errors.push({ code, receivedAt, request, error })
        failNative(new Error(`RAF wheel driver failed: ${code}: ${error}`))
        return { ok: false, code, error }
      }
      if (pending >= maxInflight) {
        const code = 'ERR_DRIVER_NATIVE_BACKPRESSURE', error = 'native RAF wheel command budget exhausted'
        evidence.errors.push({ code, receivedAt, request, pending, error })
        failNative(new Error(`RAF wheel driver failed: ${code}: ${error}`))
        return { ok: false, code, error }
      }
      nextIndex++
      lastTimestamp = request.rafTimestamp
      const record = { index: request.index, rafTimestamp: request.rafTimestamp, browserScheduledAt: request.scheduledAt,
        receivedAt, dispatchedAt: performance.now(), inflightBefore: pending }
      evidence.dispatches.push(record)
      pending++
      evidence.observedMaxInflight = Math.max(evidence.observedMaxInflight || 0, pending)
      // Binding replies acknowledge only admission. Waiting for native input
      // completion here also makes browser credits wait for another main-thread
      // turn, conflating delivered commands with actual native backpressure.
      let response
      try { response = cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: cdpDeltaY }) }
      catch (error) { response = Promise.reject(error) }
      const job = Promise.resolve(response).then(() => {
        record.completedAt = performance.now()
        record.ok = true
      }, error => {
        record.completedAt = performance.now()
        record.ok = false
        record.error = error.message
        evidence.errors.push({ code: 'ERR_DRIVER_NATIVE_DISPATCH', index: request.index, error: error.message })
        failNative(new Error(`RAF wheel driver failed: native dispatch ${request.index}: ${error.message}`))
      }).finally(() => { pending--; nativeJobs.delete(job) })
      nativeJobs.add(job)
      record.admissionReturnedAt = performance.now()
      return { ok: true, admitted: true }
    })).then(binding => {
      bindingAcquired = true
      if (!active) evidence.cleanup.bindingAcquiredAfterStop = true
      return binding
    })
    const binding = await bindingAcquisition
    ensureActive()
    if (!binding || typeof binding.dispose !== 'function') throw new Error('Playwright exposeBinding must return a disposable binding')
    phase = 'raf-admission'
    schedulerStarted = true
    browserResult = await page.evaluate(scheduleBrowserRafWheels, { bindingName, controlName, count, maxInflight })
    ensureActive()
    evidence.browser = browserResult
    if (browserResult.status !== 'completed' || evidence.dispatches.length !== count || evidence.errors.length) {
      throw new Error(`RAF wheel driver failed: ${browserResult.status}`)
    }
    // No more admissions follow browser completion. Success still requires
    // every actual native command to finish inside the same timeout/abort.
    phase = 'native-completion-drain'
    await Promise.all([...nativeJobs])
    ensureActive()
    if (evidence.errors.length || evidence.dispatches.some(record => record.ok !== true)) {
      throw new Error('RAF wheel driver failed: native commands did not all complete successfully')
    }
  }
  try {
    await Promise.race([complete(), nativeFailure, interrupted])
  } catch (error) { failure = error }
  finally {
    active = false
    evidence.cleanup.nativePendingAtCleanup = pending
    clearTimeout(timer)
    try {
      if (schedulerStarted) await boundedCleanup('raf', async () => {
        const result = await page.evaluate(stopBrowserRafWheels, controlName)
        if (result) evidence.browser = result
        evidence.cleanup.rafStopped = true
      })
      else evidence.cleanup.rafNotStarted = true
    } catch (error) {
      evidence.cleanup.rafError = error.message
      failure ??= error
    }
    if (bindingAcquisition) try {
      evidence.cleanup.bindingAcquisitionPendingAtCleanup = !bindingAcquired
      bindingCleanup ??= bindingAcquisition.then(async binding => {
        if (!binding || typeof binding.dispose !== 'function') throw new Error('Playwright exposeBinding must return a disposable binding')
        await binding.dispose()
        evidence.cleanup.bindingDisposed = true
      })
      await boundedCleanup('binding', () => bindingCleanup)
    } catch (error) {
      evidence.cleanup.bindingError = error.message
      failure ??= error
    }
    if (abort) signal?.removeEventListener('abort', abort)
    evidence.cleanup.abortListenerRemoved = true
    evidence.status = failure ? 'failed' : 'completed'
  }
  if (failure) throw failure
  return evidence
}
