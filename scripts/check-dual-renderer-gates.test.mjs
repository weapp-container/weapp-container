import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BASELINE_COMMIT, COMPILER_COMMIT, HOSTS, RENDERERS, createChecklist,
  inspectChecklist, requiredGates, runtimeCombinations, selectBaselinePaths, sha256,
} from './check-dual-renderer-gates.mjs'

const baseline = JSON.parse(readFileSync(new URL('../docs/dual-renderer/baseline-v1.json', import.meta.url)))
const expectedCommit = 'a'.repeat(40)

function evidenceFixture(id = 'web.remote.skia.quickjs.pack-execution') {
  const checklist = createChecklist()
  const entry = checklist.gates.find(item => item.id === id)
  assert.ok(entry)
  const raw = Buffer.from('independent test fixture output\n')
  const files = new Map([['evidence/output.log', raw]])
  const receipt = {
    schemaVersion: 1, gateId: id, status: 'passed', commit: expectedCommit,
    baselineCommit: BASELINE_COMMIT, compilerCommit: COMPILER_COMMIT,
    evidenceKind: entry.evidenceKind, host: entry.host, runtime: entry.runtime,
    renderer: entry.renderer, engine: entry.engine, executionStatus: 'passed',
    availability: 'available', observedExecution: true,
    checks: entry.checks.map(id => ({ id, status: 'passed' })),
    environment: { os: 'fixture-os', device: 'test-only-fixture' },
    artifacts: [{ path: 'evidence/output.log', sha256: sha256(raw) }],
  }
  entry.status = 'passed'
  entry.reason = ''
  const refresh = () => {
    const bytes = Buffer.from(JSON.stringify(receipt))
    files.set('evidence/receipt.json', bytes)
    entry.evidence = { path: 'evidence/receipt.json', sha256: sha256(bytes) }
  }
  const inspect = () => inspectChecklist(checklist, baseline, { expectedCommit, readArtifact: path => {
    assert.ok(files.has(path), `missing fixture artifact: ${path}`)
    return files.get(path)
  } })
  refresh()
  return { checklist, entry, receipt, files, refresh, inspect }
}

test('new goal ledger is entirely unknown and cannot grant completion', () => {
  const result = inspectChecklist(createChecklist(), baseline, { expectedCommit })
  assert.equal(result.valid, true)
  assert.equal(result.releaseReady, false)
  assert.equal(result.status, 'incomplete')
  assert.equal(result.counts.unknown, requiredGates().length)
  assert.equal(result.counts.passed, 0)
})

test('seven actual hosts and both Web runtime modes are frozen independently', () => {
  assert.deepEqual(HOSTS, ['web', 'macos', 'windows', 'linux', 'android', 'ios', 'harmony'])
  assert.deepEqual(RENDERERS, ['skia', 'webview'])
  assert.equal(runtimeCombinations().length, 16)
  const gates = requiredGates()
  assert.equal(gates.length, 279)
  for (const { host, runtime, renderer } of runtimeCombinations()) {
    assert.ok(gates.some(gate => gate.id === `${host}.${runtime}.${renderer}.quickjs.performance`))
  }
  assert.ok(gates.some(gate => gate.id === 'ios.native.webview.v8.pack-execution'))
  assert.ok(gates.some(gate => gate.id === 'windows.native.skia.v8.engine-availability'))
  assert.ok(!gates.some(gate => gate.renderer === 'skyline-compat'))
})

test('required gates cannot be deleted, duplicated, or weakened', () => {
  for (const mutate of [
    checklist => checklist.gates.pop(),
    checklist => checklist.gates.push(checklist.gates[0]),
    checklist => { checklist.gates[0].checks = [] },
    checklist => { checklist.gates[0].evidenceKind = 'mock' },
  ]) {
    const checklist = createChecklist()
    mutate(checklist)
    assert.equal(inspectChecklist(checklist, baseline, { expectedCommit }).valid, false)
  }
})

test('one source-bound receipt does not pass the rest of the goal', () => {
  const f = evidenceFixture()
  const result = f.inspect()
  assert.deepEqual(result.errors, [])
  assert.equal(result.counts.passed, 1)
  assert.equal(result.releaseReady, false)
})

test('old source commit or wrong engine/backend cannot be relabelled', () => {
  for (const mutate of [
    receipt => { receipt.commit = BASELINE_COMMIT },
    receipt => { receipt.renderer = 'webview' },
    receipt => { receipt.engine = 'v8' },
    receipt => { receipt.runtime = 'browser' },
    receipt => { receipt.compilerCommit = '0'.repeat(40) },
  ]) {
    const f = evidenceFixture()
    mutate(f.receipt)
    f.refresh()
    assert.equal(f.inspect().valid, false)
  }
})

test('receipt and raw artifact hashes are verified independently', () => {
  const receipt = evidenceFixture()
  receipt.files.set('evidence/receipt.json', Buffer.from('{}'))
  assert.match(receipt.inspect().errors.join('\n'), /receipt SHA-256 mismatch/)
  const raw = evidenceFixture()
  raw.files.set('evidence/output.log', Buffer.from('changed'))
  assert.match(raw.inspect().errors.join('\n'), /artifact SHA-256 mismatch/)
})

test('blocked status, unavailable execution and a failed check cannot become passed', () => {
  for (const mutate of [
    receipt => { receipt.status = 'blocked' },
    receipt => { receipt.executionStatus = 'blocked' },
    receipt => { receipt.availability = 'unavailable' },
    receipt => { receipt.checks[0].status = 'blocked' },
    receipt => { receipt.observedExecution = false },
    receipt => { receipt.evidenceKind = 'test' },
  ]) {
    const f = evidenceFixture()
    mutate(f.receipt)
    f.refresh()
    assert.equal(f.inspect().valid, false)
  }
})

test('a retained blocked attempt remains incomplete, never a pass', () => {
  const f = evidenceFixture()
  f.entry.status = f.receipt.status = 'blocked'
  f.entry.reason = 'No owned Windows GPU runner is available.'
  f.receipt.commit = BASELINE_COMMIT
  f.refresh()
  const result = f.inspect()
  assert.equal(result.valid, true)
  assert.equal(result.counts.blocked, 1)
  assert.equal(result.counts.passed, 0)
  assert.equal(result.releaseReady, false)
})

test('software or emulator evidence cannot satisfy hardware/device gates', () => {
  const f = evidenceFixture('android.native.skia.quickjs.surface')
  f.receipt.hardwareAccelerated = false
  f.receipt.softwareFallback = true
  f.receipt.deviceClass = 'emulator'
  f.refresh()
  assert.match(f.inspect().errors.join('\n'), /hardware GPU evidence required/)
  assert.match(f.inspect().errors.join('\n'), /physical device evidence required/)
  f.receipt.hardwareAccelerated = true
  f.receipt.softwareFallback = false
  f.receipt.deviceClass = 'physical'
  f.refresh()
  assert.equal(f.inspect().valid, true)
})

test('official inventory is retained without merging unresolved near-parity into this goal', () => {
  assert.equal(baseline.sourceCount, 172)
  assert.equal(baseline.conformanceCaseIds.length, 172)
  assert.equal(baseline.officialCaseBaseline.length, 172)
  assert.ok(baseline.officialRegressionIds.length > 0)
  assert.ok(baseline.officialRegressionIds.length < 172)
  const f = evidenceFixture('baseline.devtools')
  f.receipt.caseResults = baseline.officialRegressionIds.map(id => ({ id, status: 'passed' }))
  f.receipt.officialCaseBaseline = structuredClone(baseline.officialCaseBaseline)
  f.refresh()
  assert.equal(f.inspect().valid, true)
  f.receipt.officialCaseBaseline.find(item => item.status === 'unknown').status = 'passed'
  f.refresh()
  assert.match(f.inspect().errors.join('\n'), /status\/provenance changed/)
})

test('every frozen runtime contract remains required on each supported host and renderer', () => {
  const f = evidenceFixture('macos.native.webview.quickjs.conformance')
  f.receipt.caseResults = baseline.runtimeContractIds.map(id => ({ id, status: 'passed' }))
  f.refresh()
  assert.equal(f.inspect().valid, true)
  f.receipt.caseResults.pop()
  f.refresh()
  assert.match(f.inspect().errors.join('\n'), /coverage incomplete/)
})

test('unavailable optional V8 requires ERR_ENGINE and is only an availability test', () => {
  const f = evidenceFixture('web.browser.skia.v8.engine-availability')
  f.receipt.engineAvailability = 'unavailable'
  f.receipt.errorCode = 'ERR_ENGINE'
  f.refresh()
  assert.equal(f.inspect().valid, true)
  f.receipt.errorCode = null
  f.refresh()
  assert.match(f.inspect().errors.join('\n'), /ERR_ENGINE/)
  f.receipt.engineAvailability = 'available'
  f.receipt.engineExecuted = 'quickjs'
  f.refresh()
  assert.match(f.inspect().errors.join('\n'), /must execute V8/)
})

test('performance enforces numeric budgets and observed input frequency', () => {
  const f = evidenceFixture('web.browser.skia.quickjs.performance')
  Object.assign(f.receipt, {
    hardwareAccelerated: true, softwareFallback: false, samples: 60,
    workload: { nodes: 1000, setDataEntries: 10000, scrollItems: 1000, networkRequests: 20 },
    presentation: { logicalWidth: 375, logicalHeight: 667, renderScale: 2 },
    metrics: { firstFrameP50Ms: 300, firstFrameP95Ms: 500, setData10kP95Ms: 5, bridgeP99Ms: 1,
      scrollDroppedFrameRate: 0.005, steadyStateMemoryMiB: 100, runtimeIncrementMiB: 6,
      inputToPresentP95Ms: 30, coldStartP50Ms: 400, hotStartP50Ms: 200, observedInputHz: 60 },
  })
  f.refresh()
  assert.equal(f.inspect().valid, true)
  for (const [key, invalid] of [['inputToPresentP95Ms', 51], ['observedInputHz', 30], ['scrollDroppedFrameRate', 0.02], ['firstFrameP50Ms', null]]) {
    const previous = f.receipt.metrics[key]
    f.receipt.metrics[key] = invalid
    f.refresh()
    assert.equal(f.inspect().valid, false, key)
    f.receipt.metrics[key] = previous
  }
})

test('baseline path selection freezes existing entrypoints without generated evidence', () => {
  assert.deepEqual(selectBaselinePaths(['docs/evidence/old/script.mjs', 'scripts/host-smoke.mjs', 'crates/a/src/lib.rs', 'docs/api-inventory-v1.json', 'vendor/weapp-vite']),
    ['crates/a/src/lib.rs', 'docs/api-inventory-v1.json', 'scripts/host-smoke.mjs'])
  assert.ok(baseline.files.length > 200)
  assert.ok(baseline.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)))
})
