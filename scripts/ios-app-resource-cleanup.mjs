#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function processPID(output, bundleId) {
  const prefix = `UIKitApplication:${bundleId}`
  for (const line of output.split('\n')) {
    const [pid, , label] = line.trim().split(/\s+/)
    if ((label === prefix || label?.startsWith(prefix + '[')) && /^\d+$/.test(pid)) return Number(pid)
  }
  return null
}

/** Only the unique app installed/launched by this smoke is eligible for cleanup. */
export function cleanupIOSAppResource(owner, run) {
  if (owner?.owned !== true || !owner.udid || !/^[a-zA-Z0-9.-]+$/.test(owner.bundleId ?? '')) throw new Error('missing task-owned iOS app resource identity')
  const report = { schemaVersion: 1, status: 'passed', udid: owner.udid, bundleId: owner.bundleId, launchedPID: owner.pid ?? null, steps: [], warnings: [], simulatorRetained: true }
  if (owner.installed !== true && owner.installAttempted !== true) return report
  if (owner.installed !== true) {
    return { ...report, status: 'blocked-unowned',
      reason: 'Install was attempted but never acknowledged; bundle ownership is unproven, so no process may be terminated or bundle uninstalled',
      bundlePreserved: true, installationAcknowledged: false }
  }
  const list = () => {
    const result = run(['spawn', owner.udid, 'launchctl', 'list'])
    if (result.status !== 0) throw new Error(`cannot inspect task app process: ${result.stderr || result.stdout}`)
    return processPID(result.stdout, owner.bundleId)
  }
  const running = list()
  if (running !== null) {
    if (running !== owner.pid) throw new Error(`task bundle process identity changed: expected ${owner.pid}, found ${running}; preserved`)
    const result = run(['terminate', owner.udid, owner.bundleId])
    if (result.status !== 0) {
      if (list() !== null) throw new Error(`task app termination failed: ${result.stderr || result.stdout}`)
      report.warnings.push(`task app exited during terminate: ${result.stderr || result.stdout}`)
      report.steps.push('already-exited-during-terminate')
    } else report.steps.push('terminated-owned-process')
  } else report.steps.push('already-exited')
  const removed = run(['uninstall', owner.udid, owner.bundleId])
  if (removed.status !== 0) throw new Error(`task app uninstall failed: ${removed.stderr || removed.stdout}`)
  report.steps.push('uninstalled-owned-bundle')
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report
  let owner
  try {
    if (process.argv.length !== 4) throw new Error('usage: ios-app-resource-cleanup.mjs <ownership.json> <cleanup.json>')
    owner = JSON.parse(await readFile(process.argv[2], 'utf8'))
    report = cleanupIOSAppResource(owner, args => {
      const result = spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
      return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.error?.message ?? result.stderr ?? '' }
    })
    for (const warning of report.warnings) console.error(`[ios-app] cleanup warning: ${warning}`)
    if (report.status !== 'passed') {
      console.error(`[ios-app] cleanup ${report.status}: ${report.reason}`)
      process.exitCode = 1
    }
  } catch (error) {
    report = { schemaVersion: 1, status: 'failed', error: error.message, udid: owner?.udid, bundleId: owner?.bundleId, launchedPID: owner?.pid, simulatorRetained: true }
    console.error(`[ios-app] cleanup failed: ${error.message}`)
    process.exitCode = 1
  }
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n')
}
