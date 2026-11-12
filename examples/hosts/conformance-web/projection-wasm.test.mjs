import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { initSync, project_frame_json } from './generated/projection.js'
import { PROJECTION_WASM_PIN } from './generated/projection-pin.mjs'
import { createWebProgram } from './replay-1058.mjs'
import { loadRustProjection } from './projection-loader.mjs'

// Node instantiates the real pure Rust query WASM with explicitly synthetic
// typed scene data. This does not execute a browser, Worker, guest or presenter.
const bytes = await readFile(new URL('./generated/projection_bg.wasm', import.meta.url))
assert.equal(bytes.length, PROJECTION_WASM_PIN.bytes)
assert.equal(createHash('sha256').update(bytes).digest('hex'), PROJECTION_WASM_PIN.sha256)
initSync({ module: bytes })
const frame = await readFile(new URL('./synthetic-frame.json', import.meta.url), 'utf8')
const project = request => JSON.parse(project_frame_json(frame, JSON.stringify({ route: 'synthetic/route', ...request })))

test('browser projection loader rejects bytes that differ from its built pin', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, async arrayBuffer() { return new ArrayBuffer(8) } })
  try { await assert.rejects(loadRustProjection(), { code: 'ERR_CONFORMANCE_PROJECTION' }) }
  finally { globalThis.fetch = original }
})

test('real query WASM preserves exact text and uses real serde RenderNode attributes', () => {
  const result = project({ op: 'query.text', selector: '#synthetic-button' })
  assert.equal(result.status, 'ok'); assert.equal(result.result.text, '  supplied synthetic tree  ')
  const attribute = project({ op: 'query.attribute', selector: '#synthetic-button', name: 'data-source' })
  assert.deepEqual(attribute.result.value, { type: 'string', value: 'synthetic-typed-tree' })
})

test('real query WASM computes hit coordinates and checkpoint missing counts from the typed tree', () => {
  assert.deepEqual(project({ op: 'tap', selector: '#synthetic-button' }).result.point, { x: 30, y: 35 })
  const checkpoint = project({ op: 'checkpoint', checkpoint: 'synthetic-only', selectors: ['#synthetic-button', '#absent'] })
  assert.equal(checkpoint.result.nodes[0].nodes[0].text, 'supplied synthetic tree')
  assert.equal(checkpoint.result.nodes[1].count, 0)
})

test('real query WASM rejects expected values, foreign transport fields and noncomponent scopes', () => {
  for (const request of [
    { op: 'query', selector: '#synthetic-button', text: 'expected' },
    { op: 'query', selector: '#synthetic-button', count: 1 },
    { op: 'query', selector: '#synthetic-button', id: 'forged' },
    { op: 'query', selector: '#synthetic-button', scope: ['#synthetic-button'] },
    { op: 'checkpoint', checkpoint: 'synthetic', selectors: [{ selector: '#synthetic-button', fields: { text: 'expected' } }] },
  ]) assert.equal(project(request).status, 'error')
})

test('Web provider validates coordinate transport and preserves request failures without substituting native labels', async () => {
  const seen = [], failure = new Error('synthetic transport failure')
  const program = createWebProgram(async (op, payload) => {
    seen.push({ op, payload })
    if (op === 'reLaunch') return { path: 'synthetic/route' }
    if (op === 'query') return { route: 'synthetic/route', selector: '#synthetic-button', count: 1, nodes: [{}] }
    if (op === 'tap') throw failure
  })
  const page = await program.reLaunch('/synthetic/route'), node = await page.$('#synthetic-button')
  await assert.rejects(node.tap(), error => error === failure)
  assert.deepEqual(seen.at(-1), { op: 'tap', payload: { route: 'synthetic/route', selector: '#synthetic-button' } })
  assert.ok(seen.every(({ payload }) => !('text' in payload) && !('expected' in payload)))
})
