#!/usr/bin/env node
/**
 * Validate a performance evidence report and enforce the protocol gates.
 * Native host metrics are intentionally optional here; --require-complete is
 * reserved for a host harness that has collected every required measurement.
 */
import { readFile } from 'node:fs/promises'
import process from 'node:process'

const args = process.argv.slice(2)
const reportPath = args.find((arg) => !arg.startsWith('--'))
const requireComplete = args.includes('--require-complete')
if (!reportPath) {
  console.error('Usage: check-performance-report <report.json> [--require-complete]')
  process.exit(2)
}

const fail = (message) => {
  console.error(`performance report invalid: ${message}`)
  process.exitCode = 1
}
let report
try {
  report = JSON.parse(await readFile(reportPath, 'utf8'))
} catch (error) {
  fail(error.message)
  process.exit(1)
}

const required = [
  'schemaVersion', 'benchmark', 'referenceApp', 'host', 'engine', 'commit',
  'environment', 'iterations', 'metrics', 'thresholds', 'status', 'evidence', 'disclaimer',
]
for (const key of required) if (!(key in report)) fail(`missing ${key}`)
if (report.schemaVersion !== 1) fail(`schemaVersion must be 1, got ${report.schemaVersion}`)
if (report.benchmark !== 'container-performance') fail(`unexpected benchmark ${report.benchmark}`)
if (!['web', 'macos', 'windows', 'linux', 'desktop', 'android', 'ios', 'harmony', 'miniProgram'].includes(report.host)) fail(`unsupported host ${report.host}`)
if (!['quickjs', 'v8', 'host'].includes(report.engine)) fail(`unsupported engine ${report.engine}`)
if (report.hostClass !== undefined && !['desktop', 'mobile', 'unknown'].includes(report.hostClass)) fail(`unsupported hostClass ${report.hostClass}`)
if (report.referenceApp?.nodes !== 1000) fail('referenceApp.nodes must be 1000')
if (report.referenceApp?.setDataEntries !== 10_000) fail('referenceApp.setDataEntries must be 10000')
if (report.referenceApp?.scrollItems !== 1000) fail('referenceApp.scrollItems must be 1000')
if (report.referenceApp?.networkRequests !== 20) fail('referenceApp.networkRequests must be 20')
if (!Number.isInteger(report.iterations) || report.iterations < 20) fail('iterations must be >= 20')
if (!report.commit || report.commit === 'unknown') fail('commit must identify the measured source revision')

const availability = report.availability
if (availability !== undefined) {
  if (!availability || !['available', 'protocol_only', 'unavailable', 'blocked'].includes(availability.status)) {
    fail('availability.status is invalid')
  } else if (typeof availability.reason !== 'string' || !availability.reason) {
    fail('availability.reason is required')
  }
}

// A simulator-process probe is useful evidence for runtime/process timing and
// RSS, but it cannot certify a native window or GPU frame clock. Validate that
// its explicit boundary is preserved when reports are copied into artifacts.
if (report.hostProbe !== undefined) {
  const probe = report.hostProbe
  if (!probe || probe.schemaVersion !== 1) fail('hostProbe.schemaVersion must be 1')
  if (!['simulator-process', 'native-host'].includes(probe.mode)) fail('hostProbe.mode is invalid')
  if (!probe.process || !probe.runtime) fail('hostProbe.process and hostProbe.runtime are required')
  if (!Array.isArray(probe.rendererBackends)) fail('hostProbe.rendererBackends must be an array')
  if (typeof probe.nativeSurfaceAttached !== 'boolean') fail('hostProbe.nativeSurfaceAttached must be boolean')
  if (typeof probe.gpuFrameSamplerAttached !== 'boolean') fail('hostProbe.gpuFrameSamplerAttached must be boolean')
  if (typeof probe.evidenceBoundary !== 'string' || !probe.evidenceBoundary) fail('hostProbe.evidenceBoundary is required')
  if (probe.mode === 'simulator-process' && (probe.nativeSurfaceAttached || probe.gpuFrameSamplerAttached)) {
    fail('simulator-process hostProbe cannot claim native surface or GPU frame sampler')
  }
  if (!Number.isInteger(probe.process?.sampleCount) || probe.process.sampleCount < 0) fail('hostProbe.process.sampleCount is invalid')
  if (!Array.isArray(probe.runtime?.lifecycleStates)) fail('hostProbe.runtime.lifecycleStates must be an array')
  if (!Array.isArray(probe.runtime?.snapshots)) fail('hostProbe.runtime.snapshots must be an array')
}

const metric = (name) => report.metrics?.[name]
const metricNames = [
  'cold_start_ms', 'hot_start_ms', 'first_frame_ms', 'set_data_10k_ms',
  'bridge_p99_ms', 'scroll_dropped_frame_rate', 'steady_state_memory_mb',
  'quickjs_runtime_package_mb',
]
for (const name of metricNames) {
  const value = metric(name)
  if (!value || typeof value !== 'object') {
    fail(`missing metric ${name}`)
  } else if (!['measured', 'not_measured', 'unsupported'].includes(value.status)) {
    fail(`${name}.status is invalid`)
  } else if (typeof value.unit !== 'string' || !value.unit) {
    fail(`${name}.unit is required`)
  } else if (value.status === 'measured') {
    for (const percentile of ['value', 'p50', 'p95', 'p99']) {
      if (!Number.isFinite(value[percentile]) || value[percentile] < 0) fail(`${name}.${percentile} is invalid`)
    }
  } else if (typeof value.reason !== 'string' || !value.reason) {
    fail(`${name}.reason is required for ${value.status}`)
  }
}

const measuredValue = (name, percentile) => {
  const value = metric(name)
  if (!value || value.status !== 'measured' || typeof value[percentile] !== 'number') {
    fail(`${name}.${percentile} is not measured`)
    return NaN
  }
  return value[percentile]
}
const setDataP95 = measuredValue('set_data_10k_ms', 'p95')
const bridgeP99 = measuredValue('bridge_p99_ms', 'p99')
const setDataLimit = report.thresholds?.set_data_10k_p95_ms
const bridgeLimit = report.thresholds?.bridge_p99_ms
if (!(Number.isFinite(setDataLimit) && setDataLimit > 0)) fail('missing set_data_10k_p95_ms threshold')
if (!(Number.isFinite(bridgeLimit) && bridgeLimit > 0)) fail('missing bridge_p99_ms threshold')
if (Number.isFinite(setDataP95) && setDataP95 > setDataLimit) fail(`setData p95 ${setDataP95}ms exceeds ${setDataLimit}ms`)
if (Number.isFinite(bridgeP99) && bridgeP99 > bridgeLimit) fail(`bridge p99 ${bridgeP99}ms exceeds ${bridgeLimit}ms`)
const protocolPass = Number.isFinite(setDataP95) && Number.isFinite(bridgeP99)
  && setDataP95 <= setDataLimit && bridgeP99 <= bridgeLimit
const firstFrame = metric('first_frame_ms')
const scroll = metric('scroll_dropped_frame_rate')
const memory = metric('steady_state_memory_mb')
const quickjsPackage = metric('quickjs_runtime_package_mb')
const firstFrameP50Limit = report.thresholds?.first_frame_p50_ms
const firstFrameP95Limit = report.thresholds?.first_frame_p95_ms
const scrollLimit = report.thresholds?.scroll_dropped_frame_rate
const memoryLimit = report.thresholds?.steady_state_memory_mb
const packageLimit = report.thresholds?.quickjs_runtime_package_mb
for (const [name, value] of Object.entries({
  first_frame_p50_ms: firstFrameP50Limit,
  first_frame_p95_ms: firstFrameP95Limit,
  scroll_dropped_frame_rate: scrollLimit,
  steady_state_memory_mb: memoryLimit,
  quickjs_runtime_package_mb: packageLimit,
})) if (!(Number.isFinite(value) && value > 0)) fail(`missing ${name} threshold`)
if (firstFrame?.status === 'measured') {
  if (firstFrame.p50 > firstFrameP50Limit) fail(`first frame p50 ${firstFrame.p50}ms exceeds ${firstFrameP50Limit}ms`)
  if (firstFrame.p95 > firstFrameP95Limit) fail(`first frame p95 ${firstFrame.p95}ms exceeds ${firstFrameP95Limit}ms`)
}
if (scroll?.status === 'measured' && scroll.value > scrollLimit) fail(`scroll drop rate ${scroll.value} exceeds ${scrollLimit}`)
if (memory?.status === 'measured' && memory.value > memoryLimit) fail(`memory ${memory.value}MiB exceeds ${memoryLimit}MiB`)
if (quickjsPackage?.status === 'measured' && quickjsPackage.value > packageLimit) fail(`QuickJS package ${quickjsPackage.value}MiB exceeds ${packageLimit}MiB`)
const completeMetric = (name) => metric(name)?.status === 'measured'
  || (name === 'quickjs_runtime_package_mb' && report.engine !== 'quickjs' && metric(name)?.status === 'unsupported')
const allMeasured = metricNames.every(completeMetric)
const expectedStatus = protocolPass ? (allMeasured ? 'passed' : 'incomplete') : 'failed'
if (report.evidence?.protocol !== (protocolPass ? 'passed' : 'failed')) fail(`protocol evidence is ${report.evidence?.protocol}`)
if (report.status !== expectedStatus) fail(`status is ${report.status}; expected ${expectedStatus}`)
if (report.status === 'passed' && report.evidence?.nativeHost !== 'passed') fail('passed report requires nativeHost evidence')
if (report.status === 'passed' && availability && availability.status !== 'available') {
  fail(`passed report availability is ${availability.status}; host evidence must be marked available`)
}
if (requireComplete && report.status !== 'passed') fail(`report status is ${report.status}; complete host evidence is required`)

if (process.exitCode !== 1) {
  console.log(`performance report accepted: protocol gates passed (${report.host}/${report.engine}); status=${report.status}`)
}
