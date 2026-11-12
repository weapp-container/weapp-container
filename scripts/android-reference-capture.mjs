import { isDeepStrictEqual } from 'node:util'
import { inspectAndroidReferenceVisual } from './android-reference-visual.mjs'

function requireCapture(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message), { code })
}

const positiveInteger = value => Number.isSafeInteger(value) && value > 0
const eglIdentity = value => typeof value === 'string' && /^0x[0-9a-f]{1,16}$/i.test(value) && !/^0x0+$/i.test(value)
const identity = receipt => ({
  schemaVersion: receipt?.schemaVersion,
  sessionId: receipt?.sessionId,
  revision: receipt?.revision,
  frame: receipt?.frame,
  viewport: receipt?.viewport,
  surface: receipt?.surface,
  windowObservation: receipt?.windowObservation,
  displayMetrics: receipt?.displayMetrics,
  foreground: receipt?.foreground,
})

function validateDrawable(receipt) {
  const surface = receipt?.surface, drawable = surface?.drawableObservation
  const code = 'ERR_REFERENCE_CAPTURE_DRAWABLE'
  requireCapture(receipt?.schemaVersion === 1 && receipt.status === 'ready'
    && typeof receipt.sessionId === 'string' && receipt.sessionId.length > 0
    && Number.isSafeInteger(receipt.revision) && receipt.revision >= 0
    && positiveInteger(receipt.frame?.frame_id) && surface?.backend === 'skia-gpu-gles'
    && surface.presentedFrameId === receipt.frame.frame_id && positiveInteger(surface.presentationSequence),
  code, 'Receipt does not identify a ready, presented reference frame')
  requireCapture(drawable?.schemaVersion === 2 && drawable.status === 'passed'
    && drawable.frameId === receipt.frame.frame_id && positiveInteger(drawable.targetEpoch)
    && positiveInteger(drawable.acceptedWidth) && positiveInteger(drawable.acceptedHeight)
    && drawable.acceptedWidth === surface.width && drawable.acceptedHeight === surface.height
    && typeof drawable.surfaceRecreationAttempted === 'boolean' && typeof drawable.surfaceRecreated === 'boolean'
    && (!drawable.surfaceRecreated || drawable.surfaceRecreationAttempted),
  code, 'Require a successful v2 drawable observation for the accepted Surface')
  const samples = [drawable.beforeDraw, drawable.afterDraw, drawable.afterSwap]
  for (const sample of samples) {
    requireCapture(sample && sample.width === drawable.acceptedWidth && sample.height === drawable.acceptedHeight
      && eglIdentity(sample.contextId) && eglIdentity(sample.surfaceId)
      && Number.isSafeInteger(sample.framebuffer) && sample.framebuffer >= 0
      && Array.isArray(sample.viewport) && sample.viewport.length === 4 && sample.viewport.every(Number.isSafeInteger)
      && Array.isArray(sample.scissor) && sample.scissor.length === 4 && sample.scissor.every(Number.isSafeInteger),
    code, 'A drawable sample differs from the accepted physical dimensions or lacks EGL identity')
  }
  requireCapture(samples.every(sample => sample.contextId === samples[0].contextId
    && sample.surfaceId === samples[0].surfaceId && sample.framebuffer === samples[0].framebuffer),
  code, 'EGL context, Surface or framebuffer changed during presentation')
  requireCapture(drawable.beforeDraw.framebuffer === 0, code, 'Owned EGL window must draw to framebuffer zero')
  const transition = drawable.beforeTransition
  requireCapture(transition && positiveInteger(transition.width) && positiveInteger(transition.height)
    && transition.contextId === samples[0].contextId && eglIdentity(transition.surfaceId)
    && Number.isSafeInteger(transition.framebuffer) && transition.framebuffer >= 0
    && Array.isArray(transition.viewport) && transition.viewport.length === 4 && transition.viewport.every(Number.isSafeInteger)
    && Array.isArray(transition.scissor) && transition.scissor.length === 4 && transition.scissor.every(Number.isSafeInteger),
  code, 'Missing or inconsistent pre-transition EGL observation')
  requireCapture(isDeepStrictEqual(drawable.afterDraw.viewport, [0, 0, surface.width, surface.height]),
    code, 'After-draw viewport differs from the accepted physical Surface')
}

function errorRecord(error) {
  return { code: error?.code || 'ERR_REFERENCE_CAPTURE', message: error?.message || String(error),
    stack: typeof error?.stack === 'string' ? error.stack : null }
}

/**
 * Correlate untouched OS capture bytes with live, stable presented receipts.
 * Every attempt is saved before success, retry or failure is decided. read and
 * assertLive failures are terminal ownership boundaries. Caller callbacks must
 * enforce their own I/O deadlines; this helper bounds attempts and retry time.
 */
export async function captureAndroidReference({
  label, read, capture, assertLive, save, now = () => performance.now(),
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  timeoutMs = 5000, pollMs = 150,
}) {
  requireCapture(typeof label === 'string' && label.length > 0, 'ERR_REFERENCE_CAPTURE_INPUT', 'Capture label is required')
  requireCapture([read, capture, assertLive, save, now, wait].every(value => typeof value === 'function'),
    'ERR_REFERENCE_CAPTURE_INPUT', 'Capture requires read/capture/assertLive/save/now/wait callbacks')
  requireCapture(positiveInteger(timeoutMs) && timeoutMs <= 5000 && positiveInteger(pollMs),
    'ERR_REFERENCE_CAPTURE_INPUT', 'Require 0 < timeoutMs <= 5000 and positive integer pollMs')
  const started = now()
  requireCapture(Number.isFinite(started), 'ERR_REFERENCE_CAPTURE_INPUT', 'Capture clock must return finite milliseconds')
  const deadline = started + timeoutMs, maximumAttempts = Math.min(100, 1 + Math.ceil(timeoutMs / pollMs))
  const failed = entry => Object.assign(new Error(`${label}: reference capture did not stabilize within ${timeoutMs} ms (${entry.error?.message})`),
    { code: 'ERR_REFERENCE_CAPTURE', attempts: entry.attempt, lastAttempt: entry })
  let lastAttempt
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (lastAttempt && now() >= deadline) throw failed(lastAttempt)
    const entry = { attempt, before: null, after: null, png: null, inspection: null, error: null, status: 'failed' }
    let phase = 'assertLive', terminalError
    try {
      await assertLive()
      phase = 'read'
      entry.before = structuredClone(await read())
      phase = 'capture'
      let captureError
      try {
        const png = await capture()
        requireCapture(png instanceof Uint8Array, 'ERR_REFERENCE_VISUAL_INPUT', 'Capture must return untouched PNG Uint8Array bytes')
        entry.png = Buffer.from(png)
      } catch (error) { captureError = error }
      phase = 'assertLive'
      await assertLive()
      phase = 'read'
      entry.after = structuredClone(await read())
      phase = 'inspect'
      if (captureError) throw captureError
      requireCapture(isDeepStrictEqual(identity(entry.before), identity(entry.after)),
        'ERR_REFERENCE_CAPTURE_UNSTABLE', 'Frame/session/revision/presentation or Surface geometry changed during OS capture')
      validateDrawable(entry.before)
      validateDrawable(entry.after)
      entry.inspection = inspectAndroidReferenceVisual({ png: entry.png, receipt: entry.after, label })
      requireCapture(entry.inspection.status === 'passed', 'ERR_REFERENCE_CAPTURE_VISUAL', 'OS screenshot fails reference-fixture frame placement')
      entry.status = 'passed'
    } catch (error) {
      entry.error = errorRecord(error)
      if (phase === 'read' || phase === 'assertLive') terminalError = error
    }
    // A persistence failure must propagate immediately, never become a retry.
    await save(entry)
    lastAttempt = entry
    if (terminalError) throw terminalError
    if (entry.status === 'passed') return entry
    const current = now()
    requireCapture(Number.isFinite(current) && current >= started, 'ERR_REFERENCE_CAPTURE_INPUT', 'Capture clock moved backwards or became non-finite')
    if (current >= deadline || attempt === maximumAttempts) {
      throw failed(entry)
    }
    await wait(Math.min(pollMs, deadline - current))
  }
}
