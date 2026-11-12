#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processPID } from './ios-app-resource-cleanup.mjs'

/** Observe the exact launched app, retaining its last bytes even if V8 aborts. */
export async function waitIOSAppStartup(owner, options, io) {
  if (!owner?.owned || !owner.installed || !owner.udid
      || !/^[a-zA-Z0-9.-]+$/.test(owner.bundleId ?? '')
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !options.sessionId || !['quickjs', 'v8'].includes(options.engine)
      || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('installed task app, PID, session, engine and positive timeout required')
  }
  const start = io.now()
  let evidenceBytes = null
  let observedPid = null
  let observedStatus = null
  const finish = (status, code, reason) => ({
    report: { schemaVersion: 1, status, code, reason, phase: 'startup',
      udid: owner.udid, bundleId: owner.bundleId, expectedPid: owner.pid, observedPid,
      sessionId: options.sessionId, engine: options.engine, observedStatus,
      elapsedMs: io.now() - start },
    evidenceBytes,
  })
  while (io.now() - start < options.timeoutMs) {
    let evidence = null
    let readError = null
    try {
      const bytes = await io.read()
      if (bytes !== null) {
        evidenceBytes = bytes
        evidence = JSON.parse(bytes.toString('utf8'))
        observedStatus = evidence?.status ?? null
      }
    } catch (error) { readError = error.message }
    const process = await io.run(['spawn', owner.udid, 'launchctl', 'list'])
    if (process.status !== 0) {
      return finish('failed', 'ERR_ENGINE', `cannot observe app process: ${process.stderr || process.stdout}`)
    }
    observedPid = processPID(process.stdout, owner.bundleId)
    if (observedPid !== owner.pid) {
      return finish('failed', 'ERR_ENGINE', `app exited or changed identity before startup: expected ${owner.pid}, found ${observedPid}; inspect app-stderr.log`)
    }
    if (readError) return finish('failed', 'ERR_ENGINE', `cannot read startup evidence: ${readError}`)
    if (evidence) {
      if (evidence.status === 'passed') {
        if (evidence.sessionId !== options.sessionId || evidence.engine !== options.engine) {
          return finish('failed', 'ERR_ENGINE', 'startup evidence belongs to another session or engine')
        }
        return finish('passed', null, 'matching startup evidence from the live owned app; GPU and screenshot require separate validation')
      }
      if (['failed', 'blocked'].includes(evidence.status)) {
        return finish(evidence.status, 'ERR_ENGINE', `app reported ${evidence.status}; inspect evidence.json and app-stderr.log`)
      }
      if (evidence.status !== 'running') return finish('failed', 'ERR_ENGINE', 'invalid startup evidence status')
    }
    await io.wait(Math.min(250, Math.max(0, options.timeoutMs - (io.now() - start))))
  }
  return finish('failed', 'ERR_TIMEOUT', 'live app did not produce terminal startup evidence before the deadline')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report
  const [ownershipPath, evidencePath, out, sessionId, engine, seconds] = process.argv.slice(2)
  try {
    if (process.argv.length !== 8) throw new Error('usage: ios-app-startup.mjs <ownership.json> <app-evidence.json> <output-dir> <session> <engine> <timeout-seconds>')
    const owner = JSON.parse(readFileSync(ownershipPath, 'utf8'))
    const result = await waitIOSAppStartup(owner, { sessionId, engine, timeoutMs: Number(seconds) * 1000 }, {
      now: () => performance.now(),
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
      read: () => {
        try { return readFileSync(evidencePath) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
      },
      run: args => {
        const result = spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
        return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.error?.message ?? result.stderr ?? '' }
      },
    })
    report = result.report
    if (result.evidenceBytes !== null) writeFileSync(resolve(out, 'evidence.json'), result.evidenceBytes)
    if (report.status !== 'passed') throw new Error(report.reason)
  } catch (error) {
    report ??= { schemaVersion: 1, status: 'failed', phase: 'startup', reason: error.message }
    console.error(`[ios-app] ${error.message}`)
    process.exitCode = 1
  }
  if (out) writeFileSync(resolve(out, 'startup-wait.json'), JSON.stringify(report, null, 2) + '\n')
}
