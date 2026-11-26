#!/usr/bin/env node
/**
 * Validate a release simulator with an already-built native mini-program tree.
 *
 * This path intentionally bypasses the weapp-vite watcher. It checks the
 * portable packer and the shipped simulator against the same kind of raw
 * output that can be opened by an official mini-program IDE.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultProject = resolve(root, 'examples/apps/community/miniprogram-demo-text')
const defaultOut = join(homedir(), '.codex/private-validation/weapp-container', `native-artifact-release-${Date.now()}`)

function optionValue(args, index, name) {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

export function parseArgs(args = process.argv.slice(2)) {
  const options = {
    project: defaultProject,
    simulatorBin: resolve(root, 'target/release/weapp-simulator'),
    out: defaultOut,
  }
  const seen = new Set()
  const names = new Map([
    ['--project', 'project'],
    ['--simulator-bin', 'simulatorBin'],
    ['--out', 'out'],
  ])
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    const key = names.get(argument)
    if (!key) throw new Error(`Unknown option ${argument}`)
    if (seen.has(argument)) throw new Error(`Duplicate option ${argument}`)
    seen.add(argument)
    options[key] = resolve(optionValue(args, index, argument))
    index += 1
  }
  return options
}

function usage() {
  return `Usage: pnpm devtools:release:native-smoke -- [options]

Options:
  --project <dir>         raw native mini-program output (default: examples/apps/community/miniprogram-demo-text)
  --simulator-bin <path>  release simulator binary
  --out <dir>             owned evidence directory
`
}

async function command(file, args) {
  const result = await runFile(file, args, { cwd: root, maxBuffer: 10 * 1024 * 1024 })
  return result.stdout
}

export async function runSmoke(options) {
  const packer = resolve(root, 'tools/container-manifest/dist/cli.mjs')
  const pack = join(options.out, 'pack')
  const snapshot = join(options.out, 'snapshot.json')
  const reportPath = join(options.out, 'report.json')
  await mkdir(dirname(options.out), { recursive: true })
  await mkdir(options.out)
  const app = JSON.parse(await readFile(join(options.project, 'app.json'), 'utf8'))
  assert.ok(Array.isArray(app.pages) && typeof app.pages[0] === 'string' && app.pages[0].length > 0)
  await command(process.execPath, [packer, options.project, '--out', pack])
  await command(options.simulatorBin, [
    'run', '--pack', pack, '--engine', 'quickjs', '--viewport', '375x667',
    '--snapshot', snapshot, '--report', reportPath,
  ])
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.equal(report.status, 'passed')
  assert.equal(report.engine, 'quickjs')
  assert.equal(report.route, app.pages[0])
  assert.equal(report.compiler?.commit, 'unknown')
  assert.equal(report.snapshot?.width, 375)
  assert.equal(report.snapshot?.height, 667)
  assert.equal(report.snapshot?.format, 'rgba8-premultiplied')
  return {
    status: 'passed',
    input: options.project,
    pack,
    report: reportPath,
    snapshot: snapshot,
    execution: {
      engine: report.engine,
      route: report.route,
      compilerCommit: report.compiler.commit,
      renderer: report.renderer,
      frame: { width: report.snapshot.width, height: report.snapshot.height, format: report.snapshot.format },
    },
    evidence: 'raw native mini-program artifact packed and executed by the release simulator; no weapp-vite watcher was used',
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs()
    if (options.help) process.stdout.write(usage())
    else process.stdout.write(`${JSON.stringify(await runSmoke(options), null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`native-artifact-release-smoke: ${error.stack || error}\n`)
    process.exitCode = 1
  }
}
