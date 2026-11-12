import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectObservedEvidence, exclusiveFocus, explicitLauncherSource, logicalPoint, parseOptions, scrollTop, selectorFieldsQuery, wheelDriverDelta } from './simulator-presentation-controls-smoke.mjs'

test('controls evidence requires an explicit new output directory and validates engine/options', () => {
  assert.throws(() => parseOptions([]), /--out/)
  assert.throws(() => parseOptions(['--out']), /requires a value/)
  assert.throws(() => parseOptions(['--out', 'evidence', '--engine', 'other']), /quickjs or v8/)
  assert.throws(() => parseOptions(['--out', 'evidence', '--headed']), /unknown option/)
  assert.equal(parseOptions(['--out', 'evidence']).engine, 'quickjs')
  assert.ok(parseOptions(['--out', 'evidence']).binary.endsWith('/target/release/weapp-simulator'))
  assert.deepEqual(parseOptions(['--help']), { help: true })
})

test('explicit CLI launcher preserves owned PID and treats executable paths as data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weapp-controls-launcher-'))
  try {
    const binary = join(directory, "binary '$(printf unsafe)' `printf unsafe`"), wrapper = join(directory, 'launcher')
    await writeFile(binary, '#!/bin/sh\nprintf \'pid=%s\\n\' "$$"\nprintf \'%s\\n\' "$@"\n')
    await chmod(binary, 0o700)
    await writeFile(wrapper, explicitLauncherSource(binary))
    const result = spawnSync('/bin/sh', [wrapper, 'dev', '--viewport', '375x667', '--project', 'path with spaces'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split('\n'), [`pid=${result.pid}`, 'dev', '--viewport', '375x667', '--project', 'path with spaces', '--render-scale', '2', '--fps', '60'])
    assert.ok((await readFile(wrapper, 'utf8')).includes('exec '))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('native input coordinates follow CSS zoom and logical viewport, independent of physical density', () => {
  for (const zoom of [.5, 1, 2]) {
    const bounds = { x: 43, y: 91, width: 375 * zoom, height: 667 * zoom }
    const native = logicalPoint(bounds, { x: 120, y: 245 }, { width: 375, height: 667 })
    assert.equal(native.x, 43 + 120 * zoom)
    assert.equal(native.y, 91 + 245 * zoom)
  }
  assert.throws(() => logicalPoint(null, { x: 1, y: 1 }, { width: 375, height: 667 }))
})

test('DPR ownership evidence requires observed exclusive focus and an active visible page', () => {
  const visible = { focused: true, visibility: 'visible', hidden: false }
  assert.equal(exclusiveFocus(visible, { focused: false }), true)
  assert.equal(exclusiveFocus(visible, { focused: true }), false)
  assert.equal(exclusiveFocus({ ...visible, hidden: true }, { focused: false }), false)
  assert.equal(exclusiveFocus({ ...visible, visibility: 'hidden' }, { focused: false }), false)
})

test('scroll evidence explicitly requests offset and geometry and rejects missing offsets before polling', () => {
  const query = selectorFieldsQuery('#controls-scroll')
  assert.equal(query.operation, 'fields')
  assert.equal(query.fields.scrollOffset, true)
  assert.equal(query.fields.rect, true)
  assert.equal(query.fields.size, true)
  assert.equal(scrollTop({ scrollTop: 0 }), 0)
  assert.equal(scrollTop({ scrollTop: 40 }), 40)
  assert.throws(() => scrollTop({ left: 20, top: 145, width: 320, height: 180 }), /scrollOffset must be finite/)
  assert.throws(() => scrollTop({ scrollTop: Number.NaN }), /scrollOffset must be finite/)
})

test('CDP wheel driver converts a fixed logical delta to physical input at every CSS zoom', () => {
  for (const zoom of [.5, 1, 2]) for (const dpr of [1, 1.5, 2]) {
    const input = wheelDriverDelta(20, 667 * zoom, 667, dpr)
    const trustedDomDelta = input / dpr
    assert.equal(trustedDomDelta / zoom, 20)
  }
  assert.throws(() => wheelDriverDelta(Number.NaN, 667, 667, 2))
  assert.throws(() => wheelDriverDelta(20, 667, 0, 2))
})

test('failure diagnostics preserve independent runtime observations when a browser collector fails', async () => {
  const observed = await collectObservedEvidence({
    runtime: async () => ({ presentation: { renderScale: 'auto', effectiveScale: 2 } }),
    browser: () => { throw new Error('page unavailable during cleanup') },
    probe: async () => ({ mediaChanges: 0, focused: true, dpr: 1.5 }),
  })
  assert.equal(observed.runtime.presentation.effectiveScale, 2)
  assert.equal(observed.probe.dpr, 1.5)
  assert.equal(observed.browser.observationError.message, 'page unavailable during cleanup')
})
