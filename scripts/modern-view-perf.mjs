#!/usr/bin/env node
/** Native View batch comparison. This does not satisfy production host budgets. */
import { createHash } from 'node:crypto'
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baselineCommit = '081f878808075cfe9c2f1e2025ca97f2a4a9f956'
const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/modern-view-perf.mjs [options]
  --profile debug|release  native test profile (default: release)
  --samples <number>      warm samples per variant, >=100 (default: 500)
  --out-dir <directory>   JSON reports (default: artifacts/modern-view-performance)
  --quickjs-test-binary <path>  explicitly reuse an already built native test binary
  --v8-test-binary <path>       required together with --quickjs-test-binary
The TypeScript/handwritten JS and cached/historical WXS p95 ratios must each
be <=1.05 for both engines. Results describe native batches on this machine;
they do not satisfy DevTools, GPU, device, production package or host gates.`)
  process.exit(0)
}
const options = { profile: 'release', samples: 500, outDir: 'artifacts/modern-view-performance' }
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  const value = args[++index]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  if (flag === '--profile') options.profile = value
  else if (flag === '--samples') options.samples = Number(value)
  else if (flag === '--out-dir') options.outDir = value
  else if (flag === '--quickjs-test-binary') options.quickjsBinary = resolve(root, value)
  else if (flag === '--v8-test-binary') options.v8Binary = resolve(root, value)
  else throw new Error(`unknown option: ${flag}`)
}
if (!['debug', 'release'].includes(options.profile)) throw new Error('profile must be debug or release')
if (!Number.isSafeInteger(options.samples) || options.samples < 100) throw new Error('samples must be an integer >=100')
if (Boolean(options.quickjsBinary) !== Boolean(options.v8Binary)) throw new Error('both native test binary paths are required together')
const outDir = resolve(root, options.outDir)
const fixtureDir = join(root, 'tools/container-manifest/test/fixtures/modern-perf')
const sourcePaths = [
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'crates/container-core/Cargo.toml',
  'crates/container-engine-quickjs/Cargo.toml',
  'crates/container-engine-v8/Cargo.toml',
  'tools/container-manifest/package.json',
  'tools/container-manifest/test/modern-view.test.mjs',
  'scripts/modern-view-perf.mjs',
]
const sourceTrees = [
  'crates/container-core/src',
  'crates/container-core/tests/support',
  'crates/container-engine-quickjs/src',
  'crates/container-engine-v8/src',
  'tools/container-manifest/src',
  'tools/container-manifest/test/fixtures/modern-perf',
]
const optionalSourcePaths = ['.npmrc', '.pnpmfile.cjs']
const optionalSourceTrees = ['.cargo']
let ownedTemp
let activeChild
let interrupted
let forceTimer
const errors = []
const reports = []
const summary = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), profile: options.profile,
  samples: options.samples, baselineCommit, scope: 'native View relative p95 only',
  threshold: 1.05, status: 'failed', reports, errors,
  execution: options.quickjsBinary ? 'explicit-prebuilt-native-tests' : 'cargo-build-and-test',
  environment: {
    scope: 'driver snapshots include fixture verification and any Cargo build time; not per-sample CPU utilization',
    backgroundLoadNote: process.env.WEAPP_VIEW_BENCH_BACKGROUND_NOTE || null,
    before: { timestamp: new Date().toISOString(), loadAverage: loadavg() },
  },
}
function killOwnedChild(signal) {
  if (!activeChild?.pid) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(activeChild.pid), '/T', '/F'])
    if (result.status !== 0 && activeChild.exitCode === null) activeChild.kill(signal)
  } else {
    try { process.kill(-activeChild.pid, signal) }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}
function onSignal(signal) {
  interrupted = signal
  try { killOwnedChild(signal) } catch (error) { errors.push(`stop owned child: ${error.message}`) }
  forceTimer ??= setTimeout(() => {
    try { killOwnedChild('SIGKILL') } catch (error) { errors.push(`force stop owned child: ${error.message}`) }
  }, 3000).unref()
}
const onSigint = () => onSignal('SIGINT')
const onSigterm = () => onSignal('SIGTERM')
process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)
function run(program, argv, env = {}) {
  if (interrupted) return Promise.reject(new Error(`interrupted: ${interrupted}`))
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(program, argv, {
      cwd: root, env: { ...process.env, ...env }, stdio: 'inherit',
      detached: process.platform !== 'win32',
    })
    activeChild = child
    child.once('error', error => { activeChild = undefined; rejectRun(error) })
    child.once('exit', (code, signal) => {
      activeChild = undefined
      if (interrupted) rejectRun(new Error(`interrupted: ${interrupted}`))
      else if (code !== 0) rejectRun(new Error(`${program} exited ${code ?? signal}`))
      else resolveRun()
    })
  })
}
function ratio(report, numerator, denominator) {
  const value = name => report.variants.find(item => item.name === name)?.warmRenderBatch?.p95
  const top = value(numerator)
  const bottom = value(denominator)
  if (!Number.isFinite(top) || top <= 0 || !Number.isFinite(bottom) || bottom <= 0) {
    throw new Error(`invalid native p95 for ${numerator}/${denominator}`)
  }
  return top / bottom
}
function sourceIdentity() {
  // Re-enumerate on both sides so added/deleted fixture or compiler inputs also
  // invalidate the report. This proves repository inputs, not installed package bytes.
  const paths = [...sourcePaths, ...optionalSourcePaths.filter(path => existsSync(join(root, path)))]
  function collect(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) collect(path)
      else if (entry.isFile()) paths.push(path)
      else throw new Error(`unsupported source-proof entry: ${path}`)
    }
  }
  for (const directory of [...sourceTrees, ...optionalSourceTrees.filter(path => existsSync(join(root, path)))]) collect(directory)
  return Object.fromEntries(paths.sort().map(path => {
    const bytes = readFileSync(join(root, path))
    return [path, { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }]
  }))
}
try {
  mkdirSync(outDir, { recursive: true })
  summary.sourceProof = {
    algorithm: 'sha256',
    scope: 'repository runtime/compiler/fixture sources and build lock/config files; installed dependency bytes are not independently attested',
    before: sourceIdentity(),
  }
  ownedTemp = mkdtempSync(join(tmpdir(), 'weapp-modern-perf-'))
  const baseline = execFileSync('git', ['show', `${baselineCommit}:crates/container-core/src/view.js`], { cwd: root })
  const baselinePath = join(ownedTemp, 'legacy-view.js')
  writeFileSync(baselinePath, baseline)
  summary.baselineSha256 = createHash('sha256').update(baseline).digest('hex')
  summary.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  await run(process.execPath, ['--test', '--test-name-pattern', 'the performance fixture', 'tools/container-manifest/test/modern-view.test.mjs'])
  for (const engine of ['quickjs', 'v8']) {
    if (interrupted) break
    const reportPath = join(outDir, `${engine}.json`)
    // A failed build may never produce a report; do not read an earlier run.
    rmSync(reportPath, { force: true })
    try {
      const binary = options[`${engine}Binary`]
      const program = binary || 'cargo'
      const benchmarkArgs = ['native_view_performance_report', '--ignored', '--nocapture', '--test-threads=1']
      const argv = binary ? benchmarkArgs : [
        'test', '-p', `container-engine-${engine}`, '--features', `${engine}-native`,
        '--locked', '--lib', ...(options.profile === 'release' ? ['--release'] : []),
        'native_view_performance_report', '--', ...benchmarkArgs.slice(1),
      ]
      if (binary) {
        summary.prebuiltBinaries ??= {}
        summary.prebuiltBinaries[engine] = {
          path: binary, sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
          classification: 'explicit prebuilt diagnostic; source-to-binary linkage is not verified by this runner',
        }
      }
      await run(program, argv, {
        WEAPP_VIEW_BENCH_FIXTURES: fixtureDir,
        WEAPP_VIEW_BENCH_LEGACY_BOOTSTRAP: baselinePath,
        WEAPP_VIEW_BENCH_REPORT: reportPath,
        WEAPP_VIEW_BENCH_SAMPLES: String(options.samples),
      })
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      if (report.schemaVersion !== 1 || report.engine !== engine || report.environment?.profile !== `${options.profile}-test`) throw new Error('native report identity/profile mismatch')
      const typescriptToJavascript = ratio(report, 'modernTypescript', 'modernJavascript')
      const cachedToLegacyHead = ratio(report, 'legacyCached', 'legacyHeadBaseline')
      const passed = typescriptToJavascript <= 1.05 && cachedToLegacyHead <= 1.05
      reports.push({ engine, path: reportPath, typescriptToJavascript, cachedToLegacyHead, status: passed ? 'passed' : 'failed' })
      console.log(`${engine}: TS/JS p95=${typescriptToJavascript.toFixed(4)}, cached/old WXS=${cachedToLegacyHead.toFixed(4)} (${passed ? 'passed' : 'FAILED: >5% regression'})`)
      if (!passed) errors.push(`${engine}: relative p95 exceeds 5% threshold; inspect ${reportPath}`)
    } catch (error) {
      errors.push(`${engine}: ${error.stack || error}`)
    }
  }
  if (reports.length === 2 && !errors.length && !interrupted) summary.status = 'passed'
} catch (error) {
  errors.push(String(error.stack || error))
} finally {
  clearTimeout(forceTimer)
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  // run() waits for this task's child to exit, including after an interrupt.
  // Only this invocation's mkdtemp directory is removed.
  try { if (ownedTemp) rmSync(ownedTemp, { recursive: true, force: true }) }
  catch (error) { errors.push(`owned temp cleanup: ${error.stack || error}`); summary.status = 'failed' }
  try {
    if (summary.sourceProof) {
      summary.sourceProof.after = sourceIdentity()
      summary.sourceProof.unchanged = JSON.stringify(summary.sourceProof.before) === JSON.stringify(summary.sourceProof.after)
      if (!summary.sourceProof.unchanged) {
        errors.push('native benchmark sources changed during the run; rebuild and remeasure this revision')
        summary.status = 'failed'
      }
    }
  } catch (error) { errors.push(`source identity: ${error.stack || error}`); summary.status = 'failed' }
  summary.cleanup = { temporaryBaselineRemoved: !ownedTemp || !errors.some(error => error.startsWith('owned temp cleanup:')), childStopped: !activeChild }
  summary.environment.after = { timestamp: new Date().toISOString(), loadAverage: loadavg() }
  if (interrupted) { summary.interrupted = interrupted; summary.status = 'failed' }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`Native relative performance ${summary.status}: ${join(outDir, 'summary.json')}`)
}
if (summary.status !== 'passed') process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1
