#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const COMPILER_ROOT = resolve(ROOT, 'vendor/weapp-vite')
const RUNNER_PATH = 'scripts/build-weapp-vite-platforms.mjs'
const RUNNER_COMMAND = 'node ../../scripts/build-weapp-vite-platforms.mjs'
const REPORT_PATH = resolve(ROOT, 'artifacts/weapp-vite-matrix.json')
const TARGETS = ['weapp', 'alipay', 'swan', 'tt', 'jd', 'xhs']
const PLATFORM_TESTS = [
  'vitest',
  'run',
  '--config',
  'e2e/vitest.e2e.platform-build.config.ts',
  'e2e/ci/platform-build.test.ts',
]

function parseArgs(argv) {
  if (argv.length === 0) return { help: false }
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true }
  throw new Error(`unknown arguments: ${argv.join(' ')}`)
}

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function run(command, args, cwd) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  })
  return {
    command: [command, ...args].join(' '),
    cwd,
    startedAt,
    durationMs: Date.now() - started,
    status: result.error || result.status !== 0 ? 'failed' : 'passed',
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`Usage: node ../../${RUNNER_PATH}\nRun from vendor/weapp-vite after initializing the pinned submodule.\n`)
    return
  }

  if (!existsSync(resolve(COMPILER_ROOT, 'package.json'))) {
    throw new Error('vendor/weapp-vite is not initialized')
  }
  if (resolve(process.cwd()) !== COMPILER_ROOT) {
    throw new Error('run this command from vendor/weapp-vite')
  }

  const pinnedCommit = git(['rev-parse', 'HEAD:vendor/weapp-vite'])
  const checkedOutCommit = git(['rev-parse', 'HEAD'], COMPILER_ROOT)
  const initialCompilerStatus = git(['status', '--porcelain'], COMPILER_ROOT)
  if (pinnedCommit !== checkedOutCommit || initialCompilerStatus) {
    throw new Error('the initialized compiler must be clean and match the HEAD gitlink')
  }

  const startedAt = new Date().toISOString()
  const started = Date.now()
  const phases = []
  phases.push(run('pnpm', ['install', '--frozen-lockfile'], COMPILER_ROOT))
  if (phases.at(-1).status === 'passed') {
    phases.push(run('pnpm', ['run', 'build:pkgs'], COMPILER_ROOT))
  }
  if (phases.at(-1).status === 'passed') {
    phases.push(run('pnpm', ['exec', ...PLATFORM_TESTS], COMPILER_ROOT))
  }

  const finalCompilerStatus = git(['status', '--porcelain'], COMPILER_ROOT)
  const allPassed = phases.length === 3
    && phases.every(phase => phase.status === 'passed')
    && !finalCompilerStatus
  const platformTestsPassed = phases.length === 3 && phases[2].status === 'passed' && !finalCompilerStatus
  const exitCode = allPassed ? 0 : phases.find(phase => phase.status !== 'passed')?.exitCode ?? 1
  const signal = phases.find(phase => phase.status !== 'passed')?.signal ?? null
  const runReceipt = {
    index: 1,
    total: 1,
    target: 'matrix',
    command: RUNNER_COMMAND,
    cwd: COMPILER_ROOT,
    startedAt,
    durationMs: Date.now() - started,
    status: allPassed ? 'passed' : 'failed',
    exitCode,
    signal,
    phases,
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root: ROOT,
    sourceCommit: git(['rev-parse', 'HEAD']),
    sourceWorkingTreeDirty: Boolean(git(['status', '--porcelain'])),
    mode: 'run',
    command: RUNNER_COMMAND,
    commandScope: 'aggregate',
    runner: {
      path: RUNNER_PATH,
      sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    },
    submodule: {
      path: 'vendor/weapp-vite',
      initialized: true,
      pinnedCommit,
      checkedOutCommit,
      matches: pinnedCommit === checkedOutCommit,
      dirty: Boolean(finalCompilerStatus),
    },
    targets: TARGETS.map(id => ({
      id,
      status: platformTestsPassed ? 'passed' : phases.length === 3 ? 'failed' : 'blocked',
      evidence: platformTestsPassed ? 2 : 0,
    })),
    runs: [runReceipt],
  }

  mkdirSync(dirname(REPORT_PATH), { recursive: true })
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ reportPath: REPORT_PATH, status: allPassed ? 'passed' : 'failed', phases: phases.map(phase => ({ command: phase.command, status: phase.status, exitCode: phase.exitCode })) }, null, 2)}\n`)
  if (!allPassed) process.exitCode = 1
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
