#!/usr/bin/env node
/**
 * Collect repeatable startup/frame diagnostics from the developer simulator.
 *
 * The default path is a software/headless process probe. When a host-owned
 * WebSurface probe executable is supplied, its same-process lifecycle, RGBA
 * snapshot and HTTP bridge measurements are merged into the report. Both
 * paths retain an explicit `incomplete`/native-host boundary until a real
 * browser/native GPU frame sampler is attached.
 */
import { performance } from 'node:perf_hooks'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const valueAfter = (name, fallback = null) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const pack = valueAfter('--pack')
const simulator = valueAfter('--simulator-bin')
const hostProbeBin = valueAfter('--host-probe-bin')
const host = valueAfter('--host', 'web')
const engine = valueAfter('--engine', 'quickjs')
const out = valueAfter('--out')
const iterations = Number(valueAfter('--iterations', '20'))
const allowedHosts = new Set(['web', 'macos', 'windows', 'linux'])
const allowedEngines = new Set(['quickjs', 'v8'])

if (!pack) throw new Error('--pack is required')
if (!simulator) throw new Error('--simulator-bin is required')
if (!allowedHosts.has(host)) throw new Error(`unsupported simulator host: ${host}`)
if (!allowedEngines.has(engine)) throw new Error(`unsupported simulator engine: ${engine}`)
if (hostProbeBin && host !== 'web') throw new Error('--host-probe-bin is only supported with --host web')
if (!Number.isInteger(iterations) || iterations < 20) throw new Error('--iterations must be an integer >= 20')
if (!existsSync(resolve(pack))) throw new Error(`pack does not exist: ${resolve(pack)}`)
if (!existsSync(resolve(simulator))) throw new Error(`simulator binary does not exist: ${resolve(simulator)}`)
if (hostProbeBin && !existsSync(resolve(hostProbeBin))) throw new Error(`host probe binary does not exist: ${resolve(hostProbeBin)}`)

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function percentile(samples, p) {
  const ordered = [...samples].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1)]
}

function measured(samples, unit) {
  const value = percentile(samples, 0.95)
  return {
    status: 'measured',
    unit,
    value,
    p50: percentile(samples, 0.50),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
  }
}

function notMeasured(unit, reason) {
  return { status: 'not_measured', unit, reason }
}

/**
 * Read one child process RSS sample without relying on a platform-specific
 * host harness.  This is intentionally a diagnostic sampler: it gives the
 * simulator row attributable process memory evidence, but it cannot prove a
 * native window/GPU surface.  A missing sampler remains explicit instead of
 * being represented as zero.
 */
function processRssMb(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
      return match ? Number(match[1]) / 1024 : null
    }
    if (process.platform === 'darwin' || process.platform === 'freebsd') {
      const output = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (!/^\d+(?:\.\d+)?$/.test(output)) return null
      const kib = Number(output)
      return Number.isFinite(kib) && kib >= 0 ? kib / 1024 : null
    }
    if (process.platform === 'win32') {
      const output = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (!/^\d+(?:\.\d+)?$/.test(output)) return null
      const bytes = Number(output)
      return Number.isFinite(bytes) && bytes >= 0 ? bytes / (1024 * 1024) : null
    }
  } catch {
    // The process may have exited between the child event and this sample;
    // absence of a sample is represented by not_measured below.
  }
  return null
}

function metricFromSamples(samples, unit) {
  const finite = samples.filter((value) => Number.isFinite(value))
  return finite.length ? measured(finite, unit) : notMeasured(unit, 'process sampler produced no samples')
}

function runHostProbe() {
  if (!hostProbeBin) return null
  const result = spawnSync(resolve(hostProbeBin), [
    '--pack', resolve(pack),
    '--engine', engine,
    '--iterations', String(iterations),
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const probe = parseJson(result.stdout || '')
  if (!probe) {
    return {
      error: `host probe produced no JSON (exit ${result.status ?? 'unknown'}): ${(result.stderr || '').trim().slice(-1000) || 'no stderr'}`,
    }
  }
  if (result.status !== 0) {
    return {
      error: `host probe exited with ${result.status ?? result.signal ?? 'unknown'}: ${(result.stderr || '').trim().slice(-1000) || 'no stderr'}`,
      probe,
    }
  }
  return { probe }
}

function canonicalProbe(probe) {
  // Rust examples from older builds used snake_case. Keep the merge tolerant
  // so a stale probe executable cannot silently drop its evidence boundary.
  if (!probe || typeof probe !== 'object') return null
  const hostProbe = probe.hostProbe || probe.host_probe
  if (!hostProbe) return null
  const processProbe = hostProbe.process || {}
  const runtimeProbe = hostProbe.runtime || {}
  return {
    ...hostProbe,
    schemaVersion: hostProbe.schemaVersion ?? hostProbe.schema_version,
    rendererBackends: hostProbe.rendererBackends ?? hostProbe.renderer_backends ?? [],
    nativeSurfaceAttached: hostProbe.nativeSurfaceAttached ?? hostProbe.native_surface_attached ?? false,
    gpuFrameSamplerAttached: hostProbe.gpuFrameSamplerAttached ?? hostProbe.gpu_frame_sampler_attached ?? false,
    evidenceBoundary: hostProbe.evidenceBoundary ?? hostProbe.evidence_boundary ?? 'host probe boundary unavailable',
    process: {
      ...processProbe,
      coldStart: processProbe.coldStart ?? processProbe.cold_start,
      sampleCount: processProbe.sampleCount ?? processProbe.sample_count ?? 0,
    },
    runtime: {
      ...runtimeProbe,
      lifecycleStates: runtimeProbe.lifecycleStates ?? runtimeProbe.lifecycle_states ?? [],
      firstFrame: runtimeProbe.firstFrame ?? runtimeProbe.first_frame,
    },
  }
}

function mergeHostProbeReport(report, probeResult) {
  if (!probeResult) return null
  if (probeResult.error) return { error: probeResult.error, probe: probeResult.probe || null }
  const probe = probeResult.probe
  const canonical = canonicalProbe(probe)
  if (!canonical) return { error: 'host probe JSON did not contain a hostProbe object', probe }
  const probeMetrics = probe.metrics || {}
  const metrics = {
    ...report.metrics,
    cold_start_ms: probeMetrics.cold_start_ms || probeMetrics.coldStartMs || report.metrics.cold_start_ms,
    first_frame_ms: probeMetrics.first_frame_ms || probeMetrics.firstFrameMs || report.metrics.first_frame_ms,
    set_data_10k_ms: probeMetrics.set_data_10k_ms || probeMetrics.setData10kMs || report.metrics.set_data_10k_ms,
    bridge_p99_ms: probeMetrics.bridge_p99_ms || probeMetrics.bridgeP99Ms || report.metrics.bridge_p99_ms,
    steady_state_memory_mb: probeMetrics.steady_state_memory_mb || probeMetrics.steadyStateMemoryMb || report.metrics.steady_state_memory_mb,
  }
  // These two metrics now come from the actual WebSurface/Rust runtime.
  // Recompute the gate after merging; a fast Node-only baseline cannot mask
  // a slow real bridge or a 10k runtime patch batch.
  const protocolPass = report.evidence?.protocol === 'passed'
    && metrics.set_data_10k_ms?.status === 'measured'
    && metrics.set_data_10k_ms.p95 <= report.thresholds?.set_data_10k_p95_ms
    && metrics.bridge_p99_ms?.status === 'measured'
    && metrics.bridge_p99_ms.p99 <= report.thresholds?.bridge_p99_ms
  return {
    ...report,
    metrics,
    evidence: { ...report.evidence, protocol: protocolPass ? 'passed' : 'failed', nativeHost: 'not_measured' },
    hostProbe: canonical,
    availability: {
      status: 'available',
      reason: 'Host-owned WebSurface measured lifecycle, software RGBA frame and HTTP bridge on this build machine; browser and GPU evidence are not attached.',
    },
    status: protocolPass ? 'incomplete' : 'failed',
    disclaimer: `${probe.disclaimer || ''} This report does not certify browser, GPU, DevTools, emulator or device performance.`.trim(),
  }
}

function runProtocolBaseline() {
  const result = spawnSync(process.execPath, [
    'scripts/perf-baseline.mjs',
    '--host', host,
    '--engine', engine,
    '--iterations', String(iterations),
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const report = parseJson(result.stdout || '')
  if (report) return report
  return {
    schemaVersion: 1,
    benchmark: 'container-performance',
    referenceApp: { nodes: 1000, setDataEntries: 10000, scrollItems: 1000, networkRequests: 20 },
    host,
    engine,
    commit: gitCommit(),
    environment: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid },
    hostClass: 'desktop',
    iterations,
    metrics: {},
    thresholds: {},
    status: 'failed',
    evidence: { protocol: 'failed', nativeHost: 'not_measured' },
    availability: { status: 'blocked', reason: `protocol baseline did not produce JSON (exit ${result.status ?? 'unknown'})` },
    disclaimer: 'No valid protocol report was produced.',
  }
}

async function runOnce(directory, index) {
  const reportPath = join(directory, `simulator-${index}.json`)
  const started = performance.now()
  const child = spawn(resolve(simulator), [
    'run', '--pack', resolve(pack), '--engine', engine, '--report', reportPath,
  ], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout?.on('data', (chunk) => stdoutChunks.push(String(chunk)))
  child.stderr?.on('data', (chunk) => stderrChunks.push(String(chunk)))
  const rssSamples = []
  const sample = () => {
    const rss = processRssMb(child.pid)
    if (rss !== null) rssSamples.push(rss)
  }
  // The simulator is intentionally short-lived, so sample immediately and
  // then at a small interval. The final sample is best-effort because the
  // child can disappear before the kernel query returns.
  sample()
  const sampler = setInterval(sample, 5)
  const result = await new Promise((resolveResult) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolveResult(value)
    }
    child.once('error', (error) => finish({ status: null, signal: null, error }))
    child.once('close', (status, signal) => finish({ status, signal, error: null }))
  })
  clearInterval(sampler)
  sample()
  const elapsed = performance.now() - started
  const report = existsSync(reportPath) ? parseJson(readFileSync(reportPath, 'utf8')) : null
  const passed = result.status === 0 && report?.status === 'passed' && report?.engine === engine
  return {
    elapsed,
    passed,
    renderer: report?.renderer || null,
    lifecycleState: report?.lifecycleState || null,
    runtimeElapsedMs: Number.isFinite(Number(report?.elapsedMs)) ? Number(report.elapsedMs) : null,
    snapshot: report?.snapshot || null,
    rssSamples,
    rssPeakMb: rssSamples.length ? Math.max(...rssSamples) : null,
    report,
    stderr: stderrChunks.join('').slice(-2000),
    stdout: stdoutChunks.join('').slice(-2000),
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message || null,
  }
}

const baseline = runProtocolBaseline()
const hostProbeResult = runHostProbe()
if (hostProbeBin) {
  const merged = mergeHostProbeReport(baseline, hostProbeResult)
  if (merged?.error) {
    baseline.availability = { status: 'blocked', reason: merged.error }
    baseline.status = baseline.evidence?.protocol === 'passed' ? 'incomplete' : 'failed'
    baseline.disclaimer = `${baseline.disclaimer || ''} ${merged.error}`.trim()
  } else if (merged) {
    const output = `${JSON.stringify(merged, null, 2)}\n`
    if (out) {
      const path = resolve(out)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, output, 'utf8')
    }
    process.stdout.write(output)
    process.exit(merged.status === 'failed' ? 1 : 0)
  }
}
const directory = mkdtempSync(join(tmpdir(), `weapp-simulator-perf-${process.pid}-`))
let runs = []
try {
  // Keep samples machine-level serial. Parallel simulator processes would
  // measure scheduler contention instead of the host's cold-start path.
  for (let index = 0; index < iterations; index += 1) {
    runs.push(await runOnce(directory, index))
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}

const startupSamples = runs.filter(run => run.passed).map(run => run.elapsed)
const runtimeFrameSamples = runs
  .filter(run => run.passed)
  .map(run => Number.isFinite(run.runtimeElapsedMs) && run.runtimeElapsedMs > 0 ? run.runtimeElapsedMs : run.elapsed)
const memorySamples = runs.flatMap(run => run.rssSamples)
const renderers = [...new Set(runs.map(run => run.renderer).filter(Boolean))]
const lifecycleStates = [...new Set(runs.map(run => run.lifecycleState).filter(Boolean))]
const snapshots = [...new Map(runs
  .map(run => run.snapshot)
  .filter(Boolean)
  .map(snapshot => [`${snapshot.width}x${snapshot.height}:${snapshot.format}`, snapshot]))
  .values()]
const failedRuns = runs.filter(run => !run.passed)
const protocolPass = baseline.evidence?.protocol === 'passed'
const report = {
  ...baseline,
  commit: gitCommit(),
  iterations,
  metrics: {
    ...baseline.metrics,
    cold_start_ms: startupSamples.length ? measured(startupSamples, 'ms') : notMeasured('ms', 'simulator startup failed for every iteration'),
    first_frame_ms: runtimeFrameSamples.length ? measured(runtimeFrameSamples, 'ms') : notMeasured('ms', 'simulator did not produce a committed frame'),
    hot_start_ms: notMeasured('ms', 'The CLI starts a fresh simulator process for each probe; no persistent host hot-start clock is attached'),
    scroll_dropped_frame_rate: notMeasured('ratio', 'Requires a host frame callback and long-list fixture'),
    steady_state_memory_mb: metricFromSamples(memorySamples, 'MiB'),
    quickjs_runtime_package_mb: engine === 'quickjs'
      ? notMeasured('MiB', 'Measured by release artifact packaging')
      : { status: 'unsupported', unit: 'MiB', reason: 'V8 is a host-supplied engine; QuickJS package size is not applicable' },
  },
  evidence: {
    ...baseline.evidence,
    nativeHost: 'not_measured',
  },
  hostProbe: {
    schemaVersion: 1,
    mode: 'simulator-process',
    process: {
      lifecycle: startupSamples.length ? 'measured' : 'not_measured',
      coldStart: metricFromSamples(startupSamples, 'ms'),
      rss: metricFromSamples(memorySamples, 'MiB'),
      sampleCount: memorySamples.length,
    },
    runtime: {
      lifecycleStates,
      firstFrame: metricFromSamples(runtimeFrameSamples, 'ms'),
      snapshots,
    },
    rendererBackends: renderers,
    nativeSurfaceAttached: false,
    gpuFrameSamplerAttached: false,
    evidenceBoundary: 'simulator process and software snapshot only; no native GPU surface',
  },
  availability: {
    status: 'blocked',
    reason: failedRuns.length
      ? `simulator failed in ${failedRuns.length}/${iterations} iterations; renderer=${renderers.join(',') || 'unknown'}`
      : `simulator produced ${renderers.join(',') || 'unknown'} frames, but no native ${host} surface or GPU frame sampler is attached`,
  },
  status: failedRuns.length || !protocolPass ? 'failed' : 'incomplete',
  disclaimer: `This is a ${host}/${engine} developer-simulator process probe on ${process.platform}/${process.arch}. It records startup and protocol diagnostics; ${renderers.join(',') || 'the selected renderer'} is not native GPU evidence and does not certify host, DevTools, emulator or device performance.`,
}

const output = `${JSON.stringify(report, null, 2)}\n`
if (out) {
  const path = resolve(out)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, output, 'utf8')
}
process.stdout.write(output)
if (report.status === 'failed') process.exitCode = 1
