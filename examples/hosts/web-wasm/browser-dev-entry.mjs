import { BrowserDevApplication } from './browser-dev-app.mjs'
import { BrowserDevHttpControl } from './browser-dev-http-control.mjs'

const element = id => document.getElementById(id)
const config = element('weapp-dev-bootstrap')
const { bootstrap, secret } = JSON.parse(config.textContent)
// Credentials remain in the authenticated transport, never in an inspection
// URL, console message or the application's public status projection.
config.remove()
const control = new BrowserDevHttpControl({ ...bootstrap, secret })
const log = [], trace = [], status = element('dev-status'), diagnostics = element('dev-diagnostics')
let recoveryIntent = null
const displayValue = (value, key) => {
  if (value === null || typeof value !== 'object') return undefined
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined }
  catch { return undefined }
}
const displayText = (value, limit) => {
  const encoder = new TextEncoder()
  let result = '', used = 0
  for (const point of value) { const size = encoder.encode(point).byteLength; if (used + size > limit) break; result += point; used += size }
  return result
}
const showProblem = value => {
  const error = displayValue(value, 'error') ?? value
  const rawMessage = displayValue(error, 'message'), rawLevel = displayValue(error, 'level'), rawCode = displayValue(error, 'code')
  const rawName = displayValue(error, 'name'), rawStack = displayValue(error, 'stack'), rawSource = displayValue(error, 'source')
  const message = typeof rawMessage === 'string' ? displayText(rawMessage, 2048) : 'Development operation failed'
  const level = ['trace', 'debug', 'info', 'warn', 'error'].includes(rawLevel) ? rawLevel : 'error'
  const code = typeof rawCode === 'string' && rawCode.length ? ` ${displayText(rawCode, 128)}` : ''
  const name = typeof rawName === 'string' && rawName.length ? ` ${displayText(rawName, 128)}` : ''
  const source = ['quickjs', 'v8'].includes(rawSource) ? ` [${rawSource}]` : ''
  const boundedStack = typeof rawStack === 'string' ? displayText(rawStack, 8192) : ''
  const stack = boundedStack ? `\n${boundedStack}${boundedStack !== rawStack || displayValue(error, 'stackTruncated') === true ? '\n[stack truncated]' : ''}` : ''
  log.push(`${new Date().toLocaleTimeString()}  ${level.toUpperCase()}${code}${source}${name}\n${message}${stack}`)
  if (log.length > 32) log.shift()
  diagnostics.textContent = log.join('\n\n')
}
const app = new BrowserDevApplication({ bootstrap, surfaceRoot: element('dev-surface'), control,
  onDiagnostic: showProblem,
  onBatch(value) {
    trace.push(Object.freeze({ siteId: value.identity?.siteId ?? null, stale: value.stale === true,
      messages: Object.freeze((value.batch?.messages ?? []).slice(0, 64).map(message => Object.freeze({
        op: message.op, kind: message.kind, ok: message.payload?.ok === true,
      }))) }))
    if (trace.length > 64) trace.shift()
  },
  onState(value) {
    const manager = value.manager, observed = value.observation, executing = manager?.executing
    const capacity = value.transport?.lanes?.normal
    const stage = value.offered?.siteId ?? '—', runtime = executing?.runtimeReady ? 'ready' : 'waiting'
    const presented = executing?.hasPresented ? 'presented' : 'waiting'
    const submission = executing?.submission, picture = submission?.value
    const backend = executing?.owner?.transportBackend
    const gpu = picture ? `WebGL2 GPU surface / ${submission.phase}` : backend === 'browser-view' ? 'browser DOM/CSS' : 'waiting for submission'
    status.textContent = [
      `开发循环     ${value.phase}`,
      `构建版本     ${stage}`,
      `运行时位置   browser Worker / QuickJS WASM`,
      `Worker       ${runtime}`,
      `画面         ${presented}`,
      `输入         ${executing?.inputEnabled ? 'enabled' : 'blocked'}`,
      `画面恢复     ${executing?.surfaceRecovery?.phase ?? '—'}`,
      `渲染器       ${backend === 'external-frame' ? 'Skia / CanvasKit' : backend === 'browser-view' ? 'WebView / DOM' : '—'}`,
      `后端         ${backend ?? '—'}`,
      `GPU surface  ${gpu}`,
      `物理像素     ${picture ? `${picture.physicalSize.width} × ${picture.physicalSize.height}` : '—'}`,
      `驱动         ${picture?.context.unmaskedRenderer ?? picture?.context.renderer ?? '—'}`,
      `硬件 / 完成  ${picture ? `${picture.context.physicalHardware} / ${picture.presentation.gpuCompletion}` : 'unknown / unknown'}`,
      `控制版本     ${observed?.controlRevision ?? '—'}`,
      `源产物       ${observed?.portableCurrent ? 'current' : 'building / unavailable'}`,
      `控制记录     ${capacity ? `${(capacity.retainedBytes / 1048576).toFixed(1)} / ${(capacity.maxRetainedBytes / 1048576).toFixed(0)} MiB` : '—'}`,
      `记录退役     ${manager?.controlRetirements?.enabled ? `${manager.controlRetirements.inFlight} in flight / ${manager.controlRetirements.failed} failed` : 'disabled'}`,
    ].join('\n')
    const closed = value.phase === 'closed', failed = value.phase === 'cleanup-failed'
    recoveryIntent = !closed && !failed && value.phase !== 'closing' && executing?.surfaceRecovery?.phase === 'blocked'
      ? Object.freeze({ ownerKey: executing.ownerKey, lossId: executing.surfaceRecovery.lossId }) : null
    element('dev-retry-surface').hidden = recoveryIntent === null || closed || failed || value.phase === 'closing'
    element('dev-retry-surface').disabled = value.surfaceRetryPending === true
    element('dev-phase').textContent = closed || failed ? value.phase : manager?.phase ?? value.phase
    element('dev-refresh').disabled = closed || failed || value.phase === 'closing'
    element('dev-stop').disabled = closed || failed || value.phase === 'closing'
    element('dev-retry-cleanup').hidden = !value.cleanupRetryable
    element('dev-cleanup').textContent = closed ? 'Worker、控制通道已关闭，可以关闭此页面。'
      : failed ? '清理尚未完成，保留原会话和资源；请查看诊断。' : '关闭页面前请先停止开发会话。'
  },
})
element('dev-refresh').addEventListener('click', () => { void app.refresh().catch(showProblem) })
element('dev-stop').addEventListener('click', () => { void app.close().catch(showProblem) })
element('dev-retry-cleanup').addEventListener('click', () => { void app.retryCleanup().catch(showProblem) })
element('dev-retry-surface').addEventListener('click', () => { if (recoveryIntent) void app.retrySurfaceRecovery(recoveryIntent).catch(() => {}) })
const beforeUnload = event => { if (app.status.phase !== 'closed') { event.preventDefault(); event.returnValue = '' } }
window.addEventListener('beforeunload', beforeUnload)
// One explicitly owned diagnostic handle. A returned request result is not a
// presentation receipt and cannot override the manager's owner/version fences.
window.weappContainerDev = Object.freeze({ get status() { return app.status }, get trace() { return Object.freeze([...trace]) },
  refresh: () => app.refresh(), request: (value, options) => app.request(value, options),
  close: () => app.close(), retryCleanup: () => app.retryCleanup(),
  retrySurfaceRecovery: value => app.retrySurfaceRecovery(value) })
void app.start().catch(showProblem)
