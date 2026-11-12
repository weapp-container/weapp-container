#!/usr/bin/env node
/**
 * Run the pinned weapp-vite/mpcore runtime conformance suite.
 *
 * This entry point deliberately drives the headless provider only. The
 * upstream DevTools suite owns the real IDE lease and its version-selection
 * preflight; it must be invoked separately with an explicitly selected
 * official CLI. A green headless report therefore never claims DevTools,
 * emulator, or physical-device conformance.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SUBMODULE_PATH = join(ROOT, 'vendor', 'weapp-vite')
const DEFAULT_REPORT_PATH = join(ROOT, 'artifacts', 'mpcore-conformance.json')
const OFFICIAL_DEVTOOLS_SOURCE = 'https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html'
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const SUITES = [
  {
    id: 'ide-shared-launch-check',
    args: ['exec', 'tsx', 'scripts/check-e2e-ide-shared-launch.ts'],
    description: 'static guard that IDE suites reuse one automator launch and switch pages with reLaunch',
  },
  {
    id: 'headless-provider-smoke',
    config: 'e2e/vitest.e2e.ci.config.ts',
    files: ['e2e/ci/headless-automator-provider.test.ts'],
    description: 'headless automator launch, navigation and setData contract',
  },
  {
    id: 'wevu-runtime-weapp',
    config: 'e2e/vitest.e2e.headless.config.ts',
    files: ['e2e/ide/wevu-runtime.weapp.test.ts'],
    description: 'WXML snapshots, page reLaunch, scroll and layout semantics in ESM/CJS',
  },
]

function usage() {
  return `Usage: node scripts/verify-mpcore-conformance.mjs [options]\n\n`
    + `Modes (default: --dry-run):\n`
    + `  --dry-run                 Validate the pinned submodule and print the suites.\n`
    + `  --run                     Prepare upstream packages and run suites serially.\n\n`
    + `Options:\n`
    + `  --skip-prepare            Reuse existing upstream node_modules/dist files.\n`
    + `  --report <path>           JSON report path (default: artifacts/mpcore-conformance.json).\n`
    + `  --help                    Show this help.\n`
}

function parseArgs(argv) {
  const options = {
    mode: 'dry-run',
    prepare: true,
    reportPath: DEFAULT_REPORT_PATH,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      // pnpm/npm inserts this separator when forwarding script arguments.
      continue
    } else if (arg === '--dry-run') {
      options.mode = 'dry-run'
    } else if (arg === '--run') {
      options.mode = 'run'
    } else if (arg === '--skip-prepare') {
      options.prepare = false
    } else if (arg === '--report') {
      const value = argv[++index]
      if (!value) throw new Error('--report requires a value')
      options.reportPath = resolve(ROOT, value)
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }

  return options
}

function inspectSubmodule() {
  const result = {
    path: 'vendor/weapp-vite',
    initialized: false,
    pinnedCommit: null,
    checkedOutCommit: null,
    matches: false,
    error: null,
  }

  try {
    const pinned = execFileSync('git', ['ls-tree', 'HEAD', '--', 'vendor/weapp-vite'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
    result.pinnedCommit = pinned.split(/\s+/)[2] || null
  } catch (error) {
    result.error = `unable to read pinned submodule: ${error.message || error}`
    return result
  }

  try {
    result.checkedOutCommit = execFileSync('git', ['-C', SUBMODULE_PATH, 'rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim() || null
    result.initialized = Boolean(result.checkedOutCommit)
  } catch (error) {
    result.error = `submodule is not initialized: ${error.message || error}`
  }

  result.matches = Boolean(
    result.initialized
      && result.pinnedCommit
      && result.checkedOutCommit
      && result.pinnedCommit === result.checkedOutCommit,
  )
  if (!result.matches && !result.error) {
    result.error = `pinned commit ${result.pinnedCommit || 'missing'} does not match checkout ${result.checkedOutCommit || 'missing'}`
  }
  return result
}

function summarizeOutput(output) {
  const text = String(output || '')
  const testFiles = text.match(/Test Files\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/)?.[1]
  const tests = text.match(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/)?.[1]
  return {
    testFiles: testFiles ? Number(testFiles) : null,
    tests: tests ? Number(tests) : null,
  }
}

function runCommand(args, label, envOverrides = {}) {
  const command = `${pnpm} ${args.join(' ')}`
  const startedAt = new Date().toISOString()
  const start = process.hrtime.bigint()
  const result = spawnSync(pnpm, args, {
    cwd: SUBMODULE_PATH,
    env: {
      ...process.env,
      ...envOverrides,
    },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000
  const stdout = result.stdout || ''
  const stderr = result.stderr || ''
  return {
    label,
    command,
    cwd: SUBMODULE_PATH,
    startedAt,
    durationMs: Math.round(durationMs * 100) / 100,
    status: result.error ? 'error' : result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal,
    stdout,
    stderr,
    summary: summarizeOutput(`${stdout}\n${stderr}`),
    error: result.error ? String(result.error.message || result.error) : null,
  }
}

function suiteArgs(suite) {
  if (suite.args) {
    return suite.args
  }
  return [
    'exec',
    'vitest',
    'run',
    '-c',
    suite.config,
    ...suite.files,
  ]
}

function writeReport(reportPath, report) {
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function printSummary(report) {
  process.stdout.write(`mpcore conformance (${report.mode})\n`)
  process.stdout.write(`submodule: ${report.submodule.matches ? 'ok' : 'mismatch'} ${report.submodule.checkedOutCommit || 'unavailable'}\n`)
  for (const run of report.runs) {
    process.stdout.write(`- ${run.label}: ${run.status}\n`)
  }
  process.stdout.write(`DevTools: ${report.environment.devtools.status}\n`)
  process.stdout.write(`report: ${report.reportPath}\n`)
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(usage())
      return 0
    }
  } catch (error) {
    process.stderr.write(`${error.message || error}\n${usage()}`)
    return 2
  }

  const submodule = inspectSubmodule()
  const generatedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    generatedAt,
    mode: options.mode,
    provider: 'headless',
    runtime: 'mpcore/@mpcore/simulator',
    root: ROOT,
    submodule,
    suite: {
      automatorLaunch: 'one launch per suite; shared session within each upstream test describe',
      pageSwitch: 'miniProgram.reLaunch(route)',
      e2eApps: ['e2e-apps/base', 'e2e-apps/wevu-runtime-e2e'],
      suites: SUITES,
    },
    environment: {
      devtools: {
        status: 'not-run',
        reason: 'This invocation uses the headless provider. Real DevTools requires an explicit CLI selection and its own lease/preflight.',
        officialStableSource: OFFICIAL_DEVTOOLS_SOURCE,
        officialStableQueriedAt: null,
        selectedCliPath: null,
        version: null,
        baseLibraryVersion: null,
      },
      simulator: {
        status: options.mode === 'dry-run' ? 'planned' : 'pending',
        toolVersion: 'headless-simulator',
        baseLibraryVersion: null,
      },
    },
    prepare: [],
    runs: [],
    reportPath: options.reportPath,
    notes: [
      'A passed run proves only the pinned mpcore headless semantics and build/test path.',
      'It does not prove real WeChat DevTools, desktop GPU, emulator, or physical-device behavior.',
      `For the real IDE gate use the upstream DevTools config with an explicit WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH; official version source: ${OFFICIAL_DEVTOOLS_SOURCE}.`,
    ],
  }

  if (!submodule.matches) {
    report.runs = SUITES.map(suite => ({
      label: suite.id,
      status: 'blocked',
      error: 'submodule-mismatch',
    }))
    report.environment.simulator.status = 'blocked'
    writeReport(options.reportPath, report)
    printSummary(report)
    return 1
  }

  if (options.mode === 'run') {
    if (options.prepare) {
      const install = runCommand(['install', '--frozen-lockfile'], 'upstream-install')
      report.prepare.push(install)
      if (install.status !== 'passed') {
        report.environment.simulator.status = 'blocked'
        writeReport(options.reportPath, report)
        printSummary(report)
        return 1
      }

      const build = runCommand(['run', 'build:pkgs'], 'upstream-build-pkgs')
      report.prepare.push(build)
      if (build.status !== 'passed') {
        report.environment.simulator.status = 'blocked'
        writeReport(options.reportPath, report)
        printSummary(report)
        return 1
      }
    }

    for (const suite of SUITES) {
      const run = runCommand(suiteArgs(suite), suite.id, {
        E2E_FULL_MATRIX: '1',
        WEAPP_VITE_E2E_RUNTIME_PROVIDER: 'headless',
      })
      report.runs.push(run)
      if (run.status !== 'passed') {
        break
      }
    }
    report.environment.simulator.status = report.runs.length === SUITES.length && report.runs.every(run => run.status === 'passed')
      ? 'passed'
      : 'failed'
  }

  writeReport(options.reportPath, report)
  printSummary(report)
  if (options.mode === 'dry-run') return 0
  return report.environment.simulator.status === 'passed' ? 0 : 1
}

process.exitCode = main()
