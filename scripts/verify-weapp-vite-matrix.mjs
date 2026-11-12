#!/usr/bin/env node
/**
 * Verify the build-side weapp-vite platform matrix used by the container.
 *
 * The default command is an aggregate upstream gate. A custom command may use
 * the `{platform}` placeholder to run one command per target, serially. Every
 * result is copied from the child process; this script never turns a planned
 * or unavailable run into a pass.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SUBMODULE_PATH = join(ROOT, 'vendor', 'weapp-vite')
const DEFAULT_REPORT_PATH = join(ROOT, 'artifacts', 'weapp-vite-matrix.json')
// The wrapper installs/builds ignored upstream dist files before running the
// aggregate gate. It is resolved from the submodule root at execution time.
const DEFAULT_COMMAND = 'node ../../scripts/build-weapp-vite-platforms.mjs'

// Keep this list explicit. The upstream repository also has compatibility and
// planned platforms; the container build gate covers only these six targets.
const TARGETS = [
  { id: 'weapp', family: 'wechat', expected: ['wxml', 'wxss', 'project.config.json'] },
  { id: 'alipay', family: 'alipay', expected: ['axml', 'acss', 'mini.project.json'] },
  { id: 'swan', family: 'baidu', expected: ['swan', 'css', 'project.swan.json'] },
  { id: 'tt', family: 'douyin', expected: ['ttml', 'ttss', 'project.config.json'] },
  { id: 'jd', family: 'jingdong', expected: ['jxml', 'jxss', 'project.config.json'] },
  { id: 'xhs', family: 'xiaohongshu', expected: ['xhsml', 'css', 'project.config.json'] },
]

function usage() {
  return `Usage: node scripts/verify-weapp-vite-matrix.mjs [options]

Modes (default: --dry-run):
  --dry-run                 Check the submodule and print the planned matrix.
  --run                     Execute the upstream build gate and write a report.

Options:
  --command <command>       Override the command. Use {platform} to run it once
                            per target; without it the command is aggregate.
  --report <path>           JSON report path (default: artifacts/weapp-vite-matrix.json).
  --target <id>             Restrict the matrix; may be repeated.
  --help                    Show this help.

The same command can be supplied with CONTAINER_WEAPP_VITE_MATRIX_COMMAND.
`
}

function parseArgs(argv) {
  const options = {
    mode: 'dry-run',
    command: process.env.CONTAINER_WEAPP_VITE_MATRIX_COMMAND || DEFAULT_COMMAND,
    reportPath: DEFAULT_REPORT_PATH,
    targetIds: [],
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      options.mode = 'dry-run'
    } else if (arg === '--run') {
      options.mode = 'run'
    } else if (arg === '--command') {
      const value = argv[++index]
      if (!value) throw new Error('--command requires a value')
      options.command = value
    } else if (arg === '--report') {
      const value = argv[++index]
      if (!value) throw new Error('--report requires a path')
      options.reportPath = resolve(ROOT, value)
    } else if (arg === '--target') {
      const value = argv[++index]
      if (!value) throw new Error('--target requires a platform id')
      options.targetIds.push(value)
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

function resolveTargets(targetIds) {
  const ids = targetIds.length ? targetIds : TARGETS.map(target => target.id)
  const known = new Map(TARGETS.map(target => [target.id, target]))
  const unknown = ids.filter(id => !known.has(id))
  if (unknown.length) throw new Error(`unknown target(s): ${unknown.join(', ')}`)
  return ids.map(id => known.get(id))
}

function runCommand(command, target, runIndex, totalRuns) {
  const expanded = command.replaceAll('{platform}', target.id)
  const startedAt = new Date().toISOString()
  const start = process.hrtime.bigint()
  // A command is intentionally run through the user's shell so that a project
  // can provide a normal pnpm/npm command. The command is explicit user input.
  const result = spawnSync(expanded, {
    cwd: SUBMODULE_PATH,
    env: {
      ...process.env,
      E2E_FULL_MATRIX: '1',
      E2E_PLATFORM: target.id,
      CONTAINER_MATRIX_PLATFORM: target.id,
    },
    shell: true,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000
  const status = result.error
    ? 'error'
    : result.status === 0
      ? 'passed'
      : 'failed'

  return {
    index: runIndex,
    total: totalRuns,
    target: target.id,
    command: expanded,
    cwd: SUBMODULE_PATH,
    startedAt,
    durationMs: Math.round(durationMs * 100) / 100,
    status,
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null,
  }
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function printSummary(report) {
  process.stdout.write(`weapp-vite matrix (${report.mode})\n`)
  process.stdout.write(`submodule: ${report.submodule.matches ? 'ok' : 'mismatch'} ${report.submodule.checkedOutCommit || 'unavailable'}\n`)
  for (const target of report.targets) {
    process.stdout.write(`- ${target.id}: ${target.status}\n`)
  }
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
    const targets = resolveTargets(options.targetIds)
    const submodule = inspectSubmodule()
    const hasPlaceholder = options.command.includes('{platform}')
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: options.mode,
      command: options.command,
      commandScope: hasPlaceholder ? 'per-target' : 'aggregate',
      root: ROOT,
      submodule,
      targets: targets.map(target => ({
        ...target,
        status: options.mode === 'dry-run' ? 'planned' : 'not-run',
        evidence: null,
      })),
      runs: [],
      reportPath: options.reportPath,
      notes: [
        'A target is marked passed only when the configured child command exits with code 0.',
        'An aggregate command has one evidence record shared by all selected targets.',
        'This report does not prove IDE, simulator, emulator, or physical-device runtime behavior.',
      ],
    }

    if (!submodule.matches) {
      report.targets = report.targets.map(target => ({
        ...target,
        status: 'blocked',
        evidence: 'submodule-mismatch',
      }))
      report.notes.push('Build command was not started because the submodule checkout is not pinned to the superproject commit.')
      writeReport(options.reportPath, report)
      printSummary(report)
      return 1
    }

    if (options.mode === 'run') {
      if (hasPlaceholder) {
        for (let index = 0; index < targets.length; index += 1) {
          const target = targets[index]
          const run = runCommand(options.command, target, index + 1, targets.length)
          report.runs.push(run)
          report.targets[index].status = run.status
          report.targets[index].evidence = report.runs.length - 1
        }
      } else {
        // Upstream e2e:platform:build is an aggregate, non-parallel gate. Keep
        // one process and expose its exact outcome for every selected target.
        const aggregateTarget = { id: 'matrix' }
        const run = runCommand(options.command, aggregateTarget, 1, 1)
        report.runs.push(run)
        for (const target of report.targets) {
          target.status = run.status
          target.evidence = 0
        }
      }
    }

    writeReport(options.reportPath, report)
    printSummary(report)
    if (options.mode === 'dry-run') return 0
    return report.runs.every(run => run.status === 'passed') ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`)
    process.stderr.write(usage())
    return 2
  }
}

process.exitCode = main()

