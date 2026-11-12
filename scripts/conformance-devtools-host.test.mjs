import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireOfficialHost, assertOfficialHostContinuity, parseOfficialArguments, releaseOfficialHost } from './conformance-devtools-runner.mjs'

const target = { cliPath: '/selected/cli', appPath: '/selected/app.asar', profileDir: '/selected/profile',
  installationId: '1'.repeat(64), version: '2.02.2609250', channel: 'stable' }
const selected = { state: 'selected', identities: [{ pid: 123, started: 'process start identity', executable: '/selected/Electron' }] }
function fixture({ snapshots = [selected], targets = [target] } = {}) {
  let index = 0
  let targetIndex = 0
  const calls = []
  const context = { target: structuredClone(target), machineLease: { released: false, createChildScope() {} },
    resolveSelectedTarget: async () => { calls.push('resolve'); return structuredClone(targets[Math.min(targetIndex++, targets.length - 1)]) },
    hostLifecycle: {
      inspectDevtoolsHost: async () => { calls.push('inspect'); return structuredClone(snapshots[Math.min(index++, snapshots.length - 1)]) },
      claimDevtoolsHost: async () => { calls.push('claim'); if (snapshots[0].state !== 'cold') throw new Error('cold host required'); return { target, initial: snapshots[0], claimedAt: 'owned claim' } },
      quitClaimedDevtoolsHost: async () => { calls.push('quit') },
    } }
  return { context, calls }
}

test('borrowing is explicit and the default continues to require a cold host', async () => {
  assert.equal(parseOfficialArguments(['--case', 'ide-test']).borrowSelectedHost, false)
  assert.equal(parseOfficialArguments(['--borrow-selected-host', '--case', 'ide-test']).borrowSelectedHost, true)
  const { context, calls } = fixture()
  await assert.rejects(acquireOfficialHost(context), /cold host required/)
  assert.deepEqual(calls, ['claim'])
})

test('selected borrowing retains exact installation and process identities without granting host close authority', async () => {
  const { context, calls } = fixture()
  const host = await acquireOfficialHost({ ...context, borrowSelectedHost: true })
  assert.equal(host.mode, 'borrowed-selected')
  assert.deepEqual(host.initial, selected)
  context.target.version = 'changed caller object'
  assert.equal(host.target.version, target.version)
  assert.deepEqual(await assertOfficialHostContinuity(host, context), selected)
  const released = await releaseOfficialHost(host, context)
  assert.deepEqual(released, { hostAfter: selected, borrowedResourcesPreserved: true })
  assert.ok(!calls.includes('claim') && !calls.includes('quit'))
})

test('a cold host still uses owned lifecycle when selected borrowing is allowed', async () => {
  const { context, calls } = fixture({ snapshots: [{ state: 'cold', identities: [] }] })
  const host = await acquireOfficialHost({ ...context, borrowSelectedHost: true })
  assert.equal(host.mode, 'cold-owned')
  await releaseOfficialHost(host, context)
  assert.deepEqual(calls, ['inspect', 'claim', 'quit', 'inspect'])
})

test('borrowed admission requires an active machine lease and rejects unknown or foreign hosts', async () => {
  for (const machineLease of [null, { released: true, createChildScope() {} }, { released: false }]) {
    const { context, calls } = fixture()
    await assert.rejects(acquireOfficialHost({ ...context, machineLease, borrowSelectedHost: true }), /active machine E2E lease/)
    assert.deepEqual(calls, [])
  }
  for (const snapshot of [{ state: 'foreign', identities: selected.identities }, { state: 'unknown', identities: [] }, { state: 'selected', identities: [] },
    { state: 'selected', identities: [{ pid: 123, executable: '/selected/Electron' }] }]) {
    const { context, calls } = fixture({ snapshots: [snapshot] })
    await assert.rejects(acquireOfficialHost({ ...context, borrowSelectedHost: true }), /identified selected|identity is incomplete/)
    assert.ok(!calls.includes('claim') && !calls.includes('quit'))
  }
})

test('replacement process and changed installation cannot be admitted or closed by borrowing', async () => {
  const changedProcess = structuredClone(selected)
  changedProcess.identities[0].started = 'reused PID belongs to a different process'
  for (const options of [{ snapshots: [selected, changedProcess] }, { targets: [{ ...target, installationId: '2'.repeat(64) }] }]) {
    const { context, calls } = fixture(options)
    await assert.rejects(acquireOfficialHost({ ...context, borrowSelectedHost: true }), /changed before borrowing/)
    assert.ok(!calls.includes('quit'))
  }
  for (const options of [{ snapshots: [selected, selected, changedProcess] }, { targets: [target, { ...target, installationId: '2'.repeat(64) }] }]) {
    const { context, calls } = fixture(options)
    const host = await acquireOfficialHost({ ...context, borrowSelectedHost: true })
    await assert.rejects(releaseOfficialHost(host, context), /changed; preserve it/)
    assert.ok(!calls.includes('quit'))
  }
})

test('borrowed host read errors retain uncertainty without attempting host shutdown', async () => {
  const { context, calls } = fixture()
  const host = await acquireOfficialHost({ ...context, borrowSelectedHost: true })
  context.hostLifecycle.inspectDevtoolsHost = async () => { throw new Error('OS identity inspection failed') }
  await assert.rejects(releaseOfficialHost(host, context), /OS identity inspection failed/)
  assert.ok(!calls.includes('quit'))
  await assert.rejects(releaseOfficialHost({ ...host, mode: 'unknown' }, context), /no host was closed/)
})
