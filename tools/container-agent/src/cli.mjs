#!/usr/bin/env node
import process from 'node:process'
import { callTool, initProject, inspectProject, listReleases, prepareRelease, commitRelease, rollbackRelease, publishRelease, runPreviewDaemon, serveMcp } from './index.mjs'

function usage() {
  console.log(`Usage: weapp-container-agent <command> [options]

Commands:
  init --project <dir>
  inspect --project <dir>
  build --project <dir> [--wv-bin <file>]
  preview start|status|stop --project <dir> [--pack <dir>] [--surface web|desktop]
  test run --project <dir> --scenario <file>
  release prepare|commit|list|rollback|publish --project <dir> [--version <version>]
  job status|events|cancel --project <dir> --job <id>
  mcp --project <dir>

All commands emit JSON when --json is supplied.`)
}

function value(args, name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const result = args[index + 1]
  if (!result || result.startsWith('--')) throw new Error(`${name} requires a value`)
  return result
}

function jsonOutput(valueToPrint, json) {
  process.stdout.write(`${json ? JSON.stringify(valueToPrint, null, 2) : JSON.stringify(valueToPrint, null, 2)}\n`)
}

const args = process.argv.slice(2)
const json = args.includes('--json')
const command = args[0]
const project = value(args, '--project', process.cwd())

try {
  if (command === '--preview-daemon') {
    const simulatorPrefix = value(args, '--simulator-prefix', '[]')
    await runPreviewDaemon({ projectRoot: project, token: value(args, '--token', undefined), surface: value(args, '--surface', 'web'), engine: value(args, '--engine', 'quickjs'), renderer: value(args, '--renderer', 'webview'), port: Number(value(args, '--port', '0')), packDirectory: value(args, '--pack', undefined), logPath: value(args, '--log', undefined), errorPath: value(args, '--error', undefined), simulatorCommand: value(args, '--simulator-command', undefined), simulatorPrefix: JSON.parse(simulatorPrefix) })
    process.exitCode = 0
  } else if (!command || command === '--help' || command === '-h') {
    usage()
    process.exit(0)
  } else if (command === 'mcp') {
    await serveMcp(project)
  }
  if (command === '--preview-daemon' || !command || command === '--help' || command === '-h' || command === 'mcp') {
    // MCP and daemon lifetimes are owned by their streams and control server.
  } else {
    let result
    if (command === 'init') result = await initProject(project)
    else if (command === 'inspect') result = await inspectProject(project)
    else if (command === 'build') result = await callTool('container_build', { projectPath: project, wvBin: value(args, '--wv-bin', undefined) })
    else if (command === 'preview') {
    const action = args[1]
    if (action === 'start') result = await callTool('container_preview_start', { projectPath: project, packDirectory: value(args, '--pack', undefined), surface: value(args, '--surface', 'web'), renderer: value(args, '--renderer', 'webview'), port: Number(value(args, '--port', '0')), timeoutMs: Number(value(args, '--timeout-ms', '120000')) })
    else if (action === 'status') result = await callTool('container_preview_status', { projectPath: project })
    else if (action === 'stop') result = await callTool('container_preview_stop', { projectPath: project })
    else throw new Error('preview requires start, status or stop')
    } else if (command === 'test') {
    if (args[1] !== 'run') throw new Error('test requires run')
    const scenario = JSON.parse(await (await import('node:fs/promises')).readFile(value(args, '--scenario'), 'utf8'))
    result = await callTool('container_test_start', { projectPath: project, scenario })
    } else if (command === 'release') {
    const action = args[1]
    const version = value(args, '--version', undefined)
    if (action === 'prepare') result = await prepareRelease(project, version)
    else if (action === 'commit') result = await commitRelease(project, version, { confirmed: args.includes('--confirm') })
    else if (action === 'list') result = await listReleases(project)
    else if (action === 'rollback') result = await rollbackRelease(project, version, { confirmed: args.includes('--confirm') })
    else if (action === 'publish') result = await publishRelease(project, version, { confirmed: args.includes('--confirm'), platform: value(args, '--platform', 'weapp'), description: value(args, '--desc', undefined), privateKeyPath: value(args, '--private-key', undefined), wvBin: value(args, '--wv-bin', undefined), timeoutMs: Number(value(args, '--timeout-ms', '120000')) })
    else throw new Error('release requires prepare, commit, list, rollback or publish')
    } else if (command === 'job') {
    const job = value(args, '--job', undefined)
    const action = args[1]
    const tool = action === 'status' ? 'container_job_status' : action === 'events' ? 'container_job_events' : action === 'cancel' ? 'container_job_cancel' : undefined
    if (!tool) throw new Error('job requires status, events or cancel')
    result = await callTool(tool, { projectPath: project, jobId: job })
    } else throw new Error(`Unknown command: ${command}`)
    jsonOutput(result, json)
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message, code: error.code ?? 'ERR_AGENT' })}\n`)
  process.exitCode = error.code === 'ERR_CANCELLED' ? 130 : 1
}
