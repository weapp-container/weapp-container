#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processPID } from './ios-app-resource-cleanup.mjs'

// A drawable readback omits CoreAnimation composition. Capture that separate
// boundary only while the exact task app still owns its launch PID.
export function captureIOSAppScreen(owner, path, run, read = readFileSync) {
  if (!owner?.owned || !owner.installed || !owner.udid
      || !/^[a-zA-Z0-9.-]+$/.test(owner.bundleId ?? '')
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new Error('installed task app and launch PID required for screen capture')
  }
  const check = () => {
    const result = run(['spawn', owner.udid, 'launchctl', 'list'])
    if (result.status !== 0) throw new Error(`cannot inspect screen capture app: ${result.stderr || result.stdout}`)
    const pid = processPID(result.stdout, owner.bundleId)
    if (pid !== owner.pid) throw new Error(`screen capture app identity changed: expected ${owner.pid}, found ${pid}`)
    return pid
  }
  const before = check()
  const result = run(['io', owner.udid, 'screenshot', '--type=png', path])
  if (result.status !== 0) throw new Error(`simulator screen capture failed: ${result.stderr || result.stdout}`)
  const after = check()
  const bytes = read(path)
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || bytes.subarray(12, 16).toString() !== 'IHDR'
      || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) {
    throw new Error('simulator screen capture did not produce a PNG image')
  }
  return {
    schemaVersion: 1, status: 'captured', evidenceBoundary: 'official-simulator-composited-screen',
    udid: owner.udid, bundleId: owner.bundleId, pidBefore: before, pidAfter: after,
    width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    foregroundVerified: false, presentationVerified: false,
    limitations: ['A live app PID does not prove foreground ownership. Inspect this OS screenshot separately from the GPU drawable readback.'],
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report
  try {
    if (process.argv.length !== 5) throw new Error('usage: ios-app-screen.mjs <ownership.json> <screen.png> <report.json>')
    const owner = JSON.parse(readFileSync(process.argv[2], 'utf8'))
    report = captureIOSAppScreen(owner, process.argv[3], args => {
      const result = spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: 30000 })
      return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.error?.message ?? result.stderr ?? '' }
    })
  } catch (error) {
    report = { schemaVersion: 1, status: 'failed', error: error.message }
    console.error(`[ios-app] ${error.message}`)
    process.exitCode = 1
  }
  if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify(report, null, 2) + '\n')
}
