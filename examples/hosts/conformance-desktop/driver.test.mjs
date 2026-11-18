import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCheckpoint, dispose } from './driver.mjs'

test('native assertions require actual text, exact selector order and actual absence', () => {
  const evidence = { nodes: [
    { selector: '#actual', query: 'css', count: 1, nodes: [{ text: 'observed-7' }] },
    { selector: '#removed', query: 'css', count: 0, nodes: [] },
  ] }
  const expected = [{ selector: '#actual', text: 'observed-7' }, { selector: '#removed', count: 0 }]
  assertCheckpoint(evidence, expected)
  for (const mutate of [
    value => { value.nodes[0].nodes[0].text = 'stale-6' },
    value => { value.nodes[1].count = 1; value.nodes[1].nodes = [{ text: '' }] },
    value => value.nodes.reverse(),
    value => { value.nodes[0].nodes = [] },
  ]) {
    const value = structuredClone(evidence); mutate(value)
    assert.throws(() => assertCheckpoint(value, expected), /Actual rendered/)
  }
})

test('disposing a job that acquired no native host does not touch unrelated resources', async () => {
  assert.deepEqual(await dispose({ outputDirectory: '/unused-job' }), { ownedResourcesReleased: true, borrowedResourcesPreserved: true })
})
