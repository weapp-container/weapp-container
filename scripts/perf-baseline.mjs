#!/usr/bin/env node
/**
 * Deterministic protocol/perf evidence producer.
 *
 * The reference app and the native host gates have deliberately different
 * evidence boundaries. This command measures the two protocol operations that
 * can run on every CI runner (10,000-entry setData and a batched bridge
 * envelope), while recording all native/device metrics as `not_measured`.
 * A report with `status: incomplete` must never be presented as a host pass.
 */
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_ITERATIONS = 120
const DEFAULT_ENTRIES = 10_000
const outIndex = process.argv.indexOf('--out')
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : null
const hostIndex = process.argv.indexOf('--host')
const engineIndex = process.argv.indexOf('--engine')
const iterationsIndex = process.argv.indexOf('--iterations')
const iterations = Number(iterationsIndex >= 0
  ? process.argv[iterationsIndex + 1]
  : (process.env.CONTAINER_PERF_ITERATIONS || DEFAULT_ITERATIONS))
const entries = Number(process.env.CONTAINER_PERF_ENTRIES || DEFAULT_ENTRIES)
const host = hostIndex >= 0 ? process.argv[hostIndex + 1] : (process.env.CONTAINER_PERF_HOST || 'web')
const engine = engineIndex >= 0 ? process.argv[engineIndex + 1] : (process.env.CONTAINER_PERF_ENGINE || 'quickjs')

// Keep the host identifiers aligned with the near-parity release matrix.  The
// legacy `desktop` and `miniProgram` aliases remain accepted so old local
// reports can still be inspected, but new matrix reports use the concrete
// macOS/Windows/Linux names.
const VALID_HOSTS = new Set(['web', 'macos', 'windows', 'linux', 'desktop', 'android', 'ios', 'harmony', 'miniProgram'])
const VALID_ENGINES = new Set(['quickjs', 'v8', 'host'])
if (!Number.isInteger(iterations) || iterations < 20) throw new Error('--iterations must be an integer >= 20')
if (entries !== DEFAULT_ENTRIES) {
  throw new Error(`CONTAINER_PERF_ENTRIES must equal the fixed reference workload ${DEFAULT_ENTRIES}`)
}
if (!VALID_HOSTS.has(host)) throw new Error(`unsupported --host: ${host}`)
if (!VALID_ENGINES.has(engine)) throw new Error(`unsupported --engine: ${engine}`)

function makePatch(size) {
  const patch = []
  for (let i = 0; i < size; i += 1) patch.push([`items[${i}].value`, i])
  return patch
}

function applyBatch(state, patch) {
  for (const [path, value] of patch) {
    const match = /^items\[(\d+)\]\.value$/.exec(path)
    if (match) state.items[Number(match[1])].value = value
  }
}

function percentile(samples, p) {
  const ordered = [...samples].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1)]
}

function measured(value, unit, samples) {
  return {
    status: 'measured',
    unit,
    value,
    ...(samples ? { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), p99: percentile(samples, 0.99) } : {}),
  }
}

function notMeasured(unit, reason) {
  return { status: 'not_measured', unit, reason }
}

function unsupported(unit, reason) {
  return { status: 'unsupported', unit, reason }
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function gitValue(args, fallback = 'unknown') {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim() || fallback
  } catch {
    return fallback
  }
}

function environment() {
  const dirty = gitValue(['status', '--porcelain'], '')
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    // These fields make a report attributable without requiring a separate
    // CI log lookup.  They are deliberately additive so older reports remain
    // valid against schema v1.
    osRelease: os.release(),
    cpuCount: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
    ci: process.env.CI === 'true' || process.env.CI === '1',
    gitBranch: gitValue(['branch', '--show-current']),
    gitDirty: dirty.length > 0,
    target: process.env.TARGET || process.env.CARGO_BUILD_TARGET || 'host',
  }
}

const DESKTOP_HOSTS = new Set(['macos', 'windows', 'linux', 'desktop', 'web', 'miniProgram'])
const mobile = new Set(['android', 'ios', 'harmony']).has(host)
const hostClass = mobile ? 'mobile' : DESKTOP_HOSTS.has(host) ? 'desktop' : 'unknown'

const patch = makePatch(entries)
const setDataSamples = []
for (let run = 0; run < iterations; run += 1) {
  const state = { items: Array.from({ length: entries }, () => ({ value: 0 })) }
  const start = performance.now()
  applyBatch(state, patch)
  setDataSamples.push(performance.now() - start)
}

// Bridge latency is measured over an envelope with 100 events. This keeps the
// operation representative of batch transport without conflating it with the
// separate 10,000-entry setData gate.
const bridgePayload = { events: Array.from({ length: 100 }, (_, index) => ({ type: 'tap', index, dataset: { index } })) }
const bridgeSamples = []
for (let run = 0; run < iterations; run += 1) {
  const start = performance.now()
  const encoded = JSON.stringify(bridgePayload)
  JSON.parse(encoded)
  bridgeSamples.push(performance.now() - start)
}

const setDataP95 = percentile(setDataSamples, 0.95)
const bridgeP99 = percentile(bridgeSamples, 0.99)
const thresholds = {
  first_frame_p50_ms: mobile ? 900 : 500,
  first_frame_p95_ms: 1500,
  set_data_10k_p95_ms: 8,
  bridge_p99_ms: mobile ? 5 : 2,
  scroll_dropped_frame_rate: 0.01,
  steady_state_memory_mb: mobile ? 120 : 150,
  quickjs_runtime_package_mb: 8,
}

const metrics = {
  cold_start_ms: notMeasured('ms', 'Requires a host lifecycle and an installed runtime'),
  hot_start_ms: notMeasured('ms', 'Requires a host lifecycle and an installed runtime'),
  first_frame_ms: notMeasured('ms', 'Requires a host renderer and frame clock'),
  set_data_10k_ms: measured(setDataP95, 'ms', setDataSamples),
  bridge_p99_ms: measured(bridgeP99, 'ms', bridgeSamples),
  scroll_dropped_frame_rate: notMeasured('ratio', 'Requires a host frame callback and long-list fixture'),
  steady_state_memory_mb: notMeasured('MiB', 'Requires a host process memory sampler'),
  quickjs_runtime_package_mb: engine === 'quickjs'
    ? notMeasured('MiB', 'Measured by release artifact packaging')
    : unsupported('MiB', 'This report uses a host-supplied engine; QuickJS package size is not applicable'),
}

const protocolPass = setDataP95 <= thresholds.set_data_10k_p95_ms && bridgeP99 <= thresholds.bridge_p99_ms
const allMeasured = Object.values(metrics).every((metric) => metric.status === 'measured')
const report = {
  schemaVersion: 1,
  benchmark: 'container-performance',
  referenceApp: { nodes: 1000, setDataEntries: entries, scrollItems: 1000, networkRequests: 20 },
  host,
  engine,
  commit: gitCommit(),
  environment: environment(),
  hostClass,
  iterations,
  metrics,
  thresholds,
  status: allMeasured && protocolPass ? 'passed' : protocolPass ? 'incomplete' : 'failed',
  evidence: {
    protocol: protocolPass ? 'passed' : 'failed',
    nativeHost: 'not_measured',
  },
  availability: {
    status: 'protocol_only',
    reason: 'The portable baseline measures protocol work only; a host lifecycle, renderer frame clock, memory sampler and device/GPU harness are required for host performance evidence.',
  },
  disclaimer: 'Protocol-layer JavaScript measurements do not prove native host, emulator or device performance. Native metrics remain incomplete until a host harness records them.',
}
const output = `${JSON.stringify(report, null, 2)}\n`
process.stdout.write(output)
if (outPath) {
  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
  await writeFile(outPath, output, 'utf8')
}
if (report.status === 'failed') process.exitCode = 1
