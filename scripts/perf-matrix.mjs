#!/usr/bin/env node
/**
 * Produce one versioned performance report for every release-matrix pair.
 *
 * The portable baseline can run on any Node runner, but it has no host frame
 * clock, renderer surface or process sampler.  Matrix rows therefore carry an
 * explicit `availability: unavailable` marker until a host harness replaces
 * the protocol-only measurements.  This command never upgrades those rows to
 * `passed` based on compilation, emulator reachability or software fallback.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const HOSTS = ['web', 'macos', 'windows', 'linux', 'android', 'ios', 'harmony']
const ENGINES = ['quickjs', 'v8']
const args = process.argv.slice(2)
const valueAfter = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const outDirArg = valueAfter('--out-dir', 'artifacts/performance-matrix')
const outDir = path.resolve(ROOT, outDirArg)
const packArg = valueAfter('--pack', null)
const pack = packArg ? path.resolve(ROOT, packArg) : null
const iterations = Number(valueAfter('--iterations', process.env.CONTAINER_PERF_ITERATIONS || 20))
const allowIncomplete = args.includes('--allow-incomplete')
if (!Number.isInteger(iterations) || iterations < 20) {
  throw new Error('--iterations must be an integer >= 20')
}

function parseReport(stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

function blockedProtocolReport(host, engine, reason) {
  const report = runBaseline(host, engine)
  report.status = report.status === 'failed' ? 'failed' : 'incomplete'
  report.availability = { status: 'blocked', reason }
  report.disclaimer = `${report.disclaimer || ''} ${reason}`.trim()
  return report
}

function runBaseline(host, engine) {
  const result = spawnSync(process.execPath, [
    'scripts/perf-baseline.mjs',
    '--host', host,
    '--engine', engine,
    '--iterations', String(iterations),
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  const report = parseReport(result.stdout || '')
  if (!report) {
    return {
      schemaVersion: 1,
      benchmark: 'container-performance',
      referenceApp: { nodes: 1000, setDataEntries: 10000, scrollItems: 1000, networkRequests: 20 },
      host,
      engine,
      commit: 'unknown',
      environment: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid },
      hostClass: ['android', 'ios', 'harmony'].includes(host) ? 'mobile' : 'desktop',
      iterations,
      metrics: {},
      thresholds: {},
      status: 'failed',
      evidence: { protocol: 'failed', nativeHost: 'not_measured' },
      availability: { status: 'blocked', reason: `Protocol baseline failed to produce JSON (exit ${result.status ?? 'unknown'}): ${(result.stderr || '').trim() || 'no stderr'}` },
      disclaimer: 'No valid protocol report was produced; host evidence is unavailable.',
    }
  }
  report.availability = {
    status: 'unavailable',
    reason: 'No host lifecycle, renderer frame clock, process sampler and device/GPU harness are attached to this matrix run; protocol-only measurements cannot prove host performance.',
  }
  // A protocol-only report must not be accidentally consumed as a complete
  // host result if a future baseline adds more measured protocol fields.
  if (report.status === 'passed') report.status = 'incomplete'
  return report
}

const within = (candidate, directory) => candidate === directory || candidate.startsWith(`${directory}${path.sep}`)

function validateExecutableOutput(root, output, pack, targetDir) {
  const protectedDirectories = ['.git', '.cargo', 'crates', 'scripts', 'tools', 'examples', 'sdk', 'vendor', 'apps']
  if (output === root || protectedDirectories.some(name => within(output, path.join(root, name)))) {
    throw new Error('Performance output must be outside source and Git directories')
  }
  if (within(output, targetDir) || within(targetDir, output)) {
    throw new Error('Performance output and Cargo cache must be separate directories')
  }
  if (within(output, pack) || within(pack, output)) {
    throw new Error('Performance output and input pack must be separate directories')
  }
}

/** Preserve engine-specific executables before another feature build replaces them. */
export function buildSimulatorBinary(engine, options = {}) {
  const root = options.root || ROOT
  const inputPack = options.pack ?? pack
  const output = options.outDir || outDir
  const environment = options.environment || process.env
  // Fixed engine lanes keep performance providers separate from the normal
  // simulator/watch executable and from each other's feature selection.
  const targetDir = path.resolve(root, environment.CARGO_TARGET_DIR || 'target', 'performance-matrix', engine)
  const command = options.cargo || environment.CARGO || 'cargo'
  const run = options.spawn || spawnSync
  const platform = options.platform || process.platform
  if (!ENGINES.includes(engine)) throw new Error(`Unsupported simulator engine: ${engine}`)
  if (!inputPack) return { path: null, reason: 'no --pack was supplied; protocol-only matrix mode is active' }
  if (!existsSync(inputPack)) return { path: null, reason: `pack does not exist: ${inputPack}` }
  validateExecutableOutput(root, path.resolve(output), path.resolve(inputPack), targetDir)
  mkdirSync(output, { recursive: true })
  mkdirSync(targetDir, { recursive: true })
  validateExecutableOutput(realpathSync(root), realpathSync(output), realpathSync(inputPack), realpathSync(targetDir))
  const result = run(command, [
    'build', '-p', 'container-simulator', '--no-default-features',
    '--features', `${engine}-native,skia-raster`, '--bin', 'weapp-simulator',
    '--example', 'web-host-perf', '--locked', '--message-format=json-render-diagnostics',
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...environment, CARGO_TARGET_DIR: targetDir, CARGO_TERM_COLOR: 'never' },
  })
  if (result.status === 0) {
    const artifacts = (result.stdout || '').split(/\r?\n/).map(parseReport)
      .filter(value => value?.reason === 'compiler-artifact' && typeof value.executable === 'string')
    const executable = (name, kind, optional = false) => {
      const selected = artifacts.filter(value => value.target?.name === name && value.target?.kind?.includes(kind))
      if (optional && selected.length === 0) return null
      if (selected.length !== 1) throw new Error(`Cargo did not identify exactly one ${name} ${kind} executable`)
      const filename = path.resolve(root, selected[0].executable)
      if (!within(realpathSync(filename), realpathSync(targetDir)) || !statSync(filename).isFile()) {
        throw new Error(`Cargo emitted ${name} outside its selected target directory`)
      }
      return filename
    }
    let retained
    try {
      const binary = executable('weapp-simulator', 'bin')
      const hostProbe = executable('web-host-perf', 'example', true)
      // A new directory prevents an earlier run or a symlink from becoming a
      // copy destination. These small final artifacts are distinct from caches.
      retained = mkdtempSync(path.join(output, `executables-${engine}-`))
      const retain = (source, name) => {
        const destination = path.join(retained, name + (platform === 'win32' ? '.exe' : ''))
        copyFileSync(source, destination)
        chmodSync(destination, statSync(source).mode & 0o777)
        return destination
      }
      return {
        path: retain(binary, 'weapp-simulator'),
        webHostProbePath: hostProbe ? retain(hostProbe, 'web-host-perf') : null,
        targetDir,
        reason: hostProbe ? null : `simulator ${engine} build omitted the WebSurface host probe executable`,
      }
    } catch (error) {
      if (retained) rmSync(retained, { recursive: true, force: true })
      return { path: null, reason: `simulator ${engine} executable retention failed: ${error.message}` }
    }
  }
  return {
    path: null,
    reason: `simulator ${engine} build failed (exit ${result.status ?? 'unknown'}): ${(result.stderr || result.stdout || '').trim().slice(-1000) || 'no output'}`,
  }
}

function runSimulatorHost(host, engine, binary) {
  const reportPath = path.join(outDir, `${host}-${engine}.json`)
  const probeArgs = [
    'scripts/perf-simulator-host.mjs',
    '--pack', pack,
    '--simulator-bin', binary.path,
    '--host', host,
    '--engine', engine,
    '--iterations', String(iterations),
    '--out', reportPath,
  ]
  if (host === 'web' && binary.webHostProbePath) {
    probeArgs.push('--host-probe-bin', binary.webHostProbePath)
  }
  const result = spawnSync(process.execPath, probeArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null
  const parsed = report ? parseReport(report) : null
  if (parsed) return parsed
  return blockedProtocolReport(host, engine, `simulator probe produced no report (exit ${result.status ?? 'unknown'}): ${(result.stderr || result.stdout || '').trim().slice(-1000) || 'no output'}`)
}

async function main() {
  await mkdir(outDir, { recursive: true })
  const reports = []
  const simulatorBinaries = new Map()
  if (pack) {
    for (const engine of ENGINES) simulatorBinaries.set(engine, buildSimulatorBinary(engine))
  }
  for (const host of HOSTS) {
    for (const engine of ENGINES) {
      const binary = simulatorBinaries.get(engine)
      const report = binary && ['web', 'macos', 'windows', 'linux'].includes(host)
        ? binary.path
          ? (host === 'web' && !binary.webHostProbePath
            ? blockedProtocolReport(host, engine, binary.reason || 'WebSurface host probe executable is unavailable')
            : runSimulatorHost(host, engine, binary))
          : blockedProtocolReport(host, engine, binary.reason)
        : runBaseline(host, engine)
      const filename = `${host}-${engine}.json`
      const reportPath = path.join(outDir, filename)
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      reports.push({
        host,
        engine,
        path: path.relative(ROOT, reportPath),
        status: report.status,
        availability: report.availability?.status || 'legacy-unspecified',
        commit: report.commit || 'unknown',
        protocol: report.evidence?.protocol || 'unknown',
      })
    }
  }

  const passed = reports.filter(report => report.status === 'passed' && report.availability === 'available')
  const summary = {
    passed: passed.length,
    incomplete: reports.filter(report => report.status === 'incomplete').length,
    failed: reports.filter(report => report.status === 'failed').length,
    unavailable: reports.filter(report => report.availability === 'unavailable').length,
    blocked: reports.filter(report => report.availability === 'blocked').length,
  }
  const matrix = {
    schemaVersion: 1,
    benchmark: 'container-performance-matrix',
    generatedAt: new Date().toISOString(),
    commit: reports.find(report => report.commit !== 'unknown')?.commit || 'unknown',
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      cwd: ROOT,
      ci: process.env.CI === 'true' || process.env.CI === '1',
    },
    hosts: HOSTS,
    engines: ENGINES,
    iterations,
    reports,
    summary,
    status: passed.length === reports.length ? 'passed' : summary.failed > 0 ? 'failed' : 'incomplete',
    disclaimer: 'Rows marked unavailable or blocked are explicit evidence gaps. They cannot be promoted to passed without a host-owned lifecycle, renderer, frame, memory and engine harness report.',
  }
  const indexPath = path.join(outDir, 'index.json')
  await writeFile(indexPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`)
  if (matrix.status === 'failed' || (matrix.status !== 'passed' && !allowIncomplete)) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
