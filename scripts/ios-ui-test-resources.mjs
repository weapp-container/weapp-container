import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { cleanupIOSAppResource, processPID } from './ios-app-resource-cleanup.mjs'
import { validUDID } from './ios-ui-test-contracts.mjs'

/** A stale lease is evidence for a person to inspect, never permission to steal it. */
export function acquireIOSUILease({ udid, runID, base = tmpdir(), pid = process.pid }) {
  if (!validUDID(udid) || !/^[a-zA-Z0-9-]+$/.test(runID ?? '')) throw new Error('explicit simulator/run identity required for lease')
  const directory = resolve(base, `weapp-container-ios-ui-${udid.toLowerCase()}.lock`)
  try { mkdirSync(directory) }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`simulator UI lease already exists; inspect and preserve ${directory}`); throw error }
  const token = randomUUID()
  const path = resolve(directory, 'owner.json')
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, udid, runID, pid, token, acquiredAt: new Date().toISOString() }) + '\n', { flag: 'wx' })
  return { directory, release() {
    const owner = JSON.parse(readFileSync(path))
    if (owner.token !== token || owner.pid !== pid || owner.runID !== runID) throw new Error(`UI lease identity changed; preserved ${directory}`)
    unlinkSync(path)
    rmdirSync(directory)
  } }
}

/** Observe only the two unique bundles; never adopt a replacement PID. */
export function observeIOSUIPIDs(resources, listing) {
  let changed = false
  for (const owner of resources) {
    const pid = processPID(listing, owner.bundleId)
    if (pid === null) continue
    if (!owner.installed) throw new Error(`unacknowledged task install has a live process; preserved ${owner.bundleId}`)
    if (owner.pid !== null && owner.pid !== pid) throw new Error(`task bundle process identity changed: expected ${owner.pid}, found ${pid}; preserved ${owner.bundleId}`)
    if (owner.pid === null) { owner.pid = pid; changed = true }
  }
  return changed
}

/** Each exact app is cleaned independently so one ambiguity cannot hide the other. */
export function cleanupIOSUIResources(resources, run, assertAbsent) {
  const items = []
  for (const owner of [...resources].reverse()) {
    try {
      const item = cleanupIOSAppResource(owner, run)
      if (item.status === 'passed' && owner.installed === true) {
        assertAbsent(owner.udid, owner.bundleId)
        item.bundleAbsentAfterCleanup = true
      }
      items.push(item)
    } catch (error) { items.push({ schemaVersion: 1, status: 'failed', udid: owner.udid, bundleId: owner.bundleId, error: error.message, simulatorRetained: true }) }
  }
  return { schemaVersion: 1, status: items.every(item => item.status === 'passed') ? 'passed' : 'failed', items, simulatorRetained: true }
}
