#!/usr/bin/env node
/**
 * Run one portable pack through the native QuickJS and V8 adapters.
 *
 * This is an engine conformance smoke, not a host or DevTools parity claim.
 * Both engines must be explicitly compiled; a missing V8 provider is a hard
 * failure so CI cannot silently turn the comparison into a QuickJS-only run.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const valueAfter = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const pack = resolve(ROOT, valueAfter('--pack', 'artifacts/reference'))
const out = resolve(ROOT, valueAfter('--out', 'artifacts/engine-conformance.json'))
const scriptPath = resolve(ROOT, valueAfter('--script', 'fixtures/engine-conformance.jsonl'))
const cargo = process.env.CARGO || 'cargo'
const timeoutMs = Number(valueAfter('--timeout', '120000'))
// The fixture deliberately asks the runtime to reLaunch an absent page so
// both engines exercise the same structured request error. It is part of the
// conformance contract; unexpected errors still fail an engine run.
const EXPECTED_ERROR_REQUESTS = new Set(['route'])

if (!existsSync(pack)) throw new Error(`pack does not exist: ${pack}`)
if (!existsSync(scriptPath)) throw new Error(`conformance script does not exist: ${scriptPath}`)
if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('--timeout must be >= 1000')

function gitCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function runEngine(engine, feature, directory) {
  const reportPath = resolve(directory, `${engine}.report.json`)
  const tracePath = resolve(directory, `${engine}.trace.json`)
  const command = [
    'run', '-p', 'container-simulator', '--no-default-features',
    '--features', feature, '--locked', '--', 'run', '--pack', pack,
    '--engine', engine, '--report', reportPath, '--trace', tracePath,
    '--script', scriptPath,
  ]
  const result = spawnSync(cargo, command, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
  })
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
  const trace = existsSync(tracePath) ? JSON.parse(readFileSync(tracePath, 'utf8')) : null
  const records = Array.isArray(trace?.records) ? trace.records : trace?.events
  const errorMessage = records?.flatMap(record => record?.response?.messages || [])
    .find(message => {
      const expectedRouteError = EXPECTED_ERROR_REQUESTS.has(message?.requestId)
        && message?.payload?.error?.code === 'ERR_INVALID_REQUEST'
      return !expectedRouteError && (message?.payload?.ok === false || message?.op === 'error')
    })
  return {
    engine,
    feature,
    command: [cargo, ...command].join(' '),
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error?.code === 'ETIMEDOUT',
    report,
    trace,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status === 0
      && report?.status === 'passed'
      && report?.engine === engine
      && trace?.schemaVersion === 1
      && (Array.isArray(trace.records) || Array.isArray(trace.events))
      && !errorMessage
      ? 'passed'
      : 'failed',
    error: errorMessage?.payload?.error || (errorMessage ? 'bridge error response' : null),
  }
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const key of Object.keys(value).sort()) {
    // Engine metadata is expected to differ; all protocol and lifecycle data
    // remains part of the comparison.
    if (key === 'engine' || key === 'engineProviderAvailable') continue
    // Diagnostic effects identify the adapter that emitted them. That is
    // useful in each engine report but is intentionally excluded from the
    // semantic trace comparison.
    if (key === 'source' && (value[key] === 'quickjs' || value[key] === 'v8')) continue
    output[key] = normalize(value[key])
  }
  return output
}

function compareTraces(quickjs, v8) {
  if (!quickjs || !v8) return { status: 'failed', reason: 'missing trace' }
  const left = JSON.stringify(normalize(quickjs))
  const right = JSON.stringify(normalize(v8))
  return left === right
    ? { status: 'passed', reason: 'normalized bridge traces match' }
    : { status: 'failed', reason: 'normalized bridge traces differ' }
}

const temporary = resolve(ROOT, 'target', `engine-conformance-${process.pid}`)
rmSync(temporary, { recursive: true, force: true })
mkdirSync(temporary, { recursive: true })
const runs = [
  runEngine('quickjs', 'quickjs-native', temporary),
  runEngine('v8', 'v8-native', temporary),
]

const comparison = compareTraces(runs[0].trace, runs[1].trace)
const report = {
  schemaVersion: 1,
  scope: 'engine-conformance-smoke',
  generatedAt: new Date().toISOString(),
  commit: gitCommit(),
  pack: {
    path: pack,
    manifestSha256: existsSync(resolve(pack, 'manifest.json')) ? sha256(resolve(pack, 'manifest.json')) : null,
  },
  script: {
    path: scriptPath,
    sha256: sha256(scriptPath),
  },
  engines: runs.map(({ engine, feature, command, exitCode, signal, timedOut, report: engineReport, trace, stdout, stderr, status }) => ({
    engine,
    feature,
    command,
    exitCode,
    signal,
    timedOut,
    status,
    report: engineReport,
    traceCount: Array.isArray(trace?.records)
      ? trace.records.length
      : Array.isArray(trace?.events) ? trace.events.length : null,
    stdoutTail: stdout.slice(-4000),
    stderrTail: stderr.slice(-4000),
  })),
  comparison,
  evidenceBoundary: 'This proves one portable pack has matching normalized simulator traces under native QuickJS and V8. It does not prove WeChat DevTools, native GPU, emulator/device or seven-host parity.',
}
report.status = runs.every(run => run.status === 'passed') && comparison.status === 'passed' ? 'passed' : 'failed'
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
rmSync(temporary, { recursive: true, force: true })
if (report.status !== 'passed') process.exitCode = 1
