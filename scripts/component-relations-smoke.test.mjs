import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INITIAL_TRACE, REMOVED_TRACE, RESTORED_TRACE, inspectSnapshot, inspectSummary, inspectTrace } from './component-relations-smoke.mjs'

function summary(phase = 'initial') {
  const present = phase !== 'removed'
  const mutated = phase === 'mutated'
  const restored = phase === 'restored'
  const callbacks = [
    ['parent', 'linked', 0, 'child'], ['child', 'linked', 0, 'parent'],
    ...(phase === 'removed' || restored ? [['parent', 'unlinked', 0, 'child'], ['child', 'unlinked', 0, 'parent']] : []),
    ...(restored ? [['parent', 'linked', 1, 'child'], ['child', 'linked', 1, 'parent']] : []),
  ].map(([label, event, childGeneration, targetLabel]) => ({ label, event, childGeneration, targetLabel,
    sourceIsLiveReference: true, targetIsLiveReference: true }))
  return {
    launched: true, capabilities: { relations: true, getRelationNodes: true },
    trace: [...(restored ? RESTORED_TRACE : phase === 'removed' ? REMOVED_TRACE : INITIAL_TRACE)],
    showChild: present, childPresent: present, parentSurvives: true,
    childIsInitial: phase === 'initial' || mutated,
    parentNodes: present ? ['child'] : [], childNodes: present ? ['parent'] : [],
    parentRelationUsesLiveChild: present, childRelationUsesLiveParent: present,
    relationArrayIsFresh: true, relationArrayIsIsolated: true,
    heldChildRelations: phase === 'initial' || mutated ? ['parent'] : [],
    childCount: present ? Number(mutated) : null,
    childColor: present ? mutated ? '#1976d2' : '#e53935' : null,
    heldChildCount: phase === 'initial' ? 0 : 1,
    childGenerations: restored ? 2 : 1,
    initialChildTracked: true, currentChildTracked: true, restoredChildIsFresh: true,
    callbacks,
  }
}

function record(id, op, payload, requestPayload = {}) {
  const envelope = { protocolVersion: '1.0', sessionId: 'simulator-1', requestId: id, op }
  return { request: { ...envelope, kind: 'request', payload: requestPayload },
    response: { messages: [{ ...envelope, kind: 'response', payload: { ok: true, ...payload } }] } }
}

function call(id, name, value) {
  return record(id, 'module.call', { moduleId: 'module:pages/index/index.js', export: name, result: [value] })
}

function trace() {
  return { schemaVersion: 1, records: [
    record('startup-init', 'app.init', {}),
    record('startup-launch', 'app.lifecycle', {}, { event: 'launch' }),
    record('startup-page', 'page.push', {}, { path: 'pages/index/index' }),
    record('startup-render', 'render.commit', {}),
    call('inspect-initial', 'inspect', summary()),
    call('bump-held-child', 'bumpHeldChild', { count: 1, sameHeldReference: true, selectedSeesSameState: true }),
    record('render-mutated', 'render.commit', {}, { templateId: 'template:pages/index/index.wxml' }),
    call('inspect-mutated', 'inspect', summary('mutated')),
    call('removed-set-data', 'remove', true),
    record('render-removed', 'render.commit', {}, { templateId: 'template:pages/index/index.wxml' }),
    call('inspect-removed', 'inspect', summary('removed')),
    call('restored-set-data', 'restore', true),
    record('render-restored', 'render.commit', {}, { templateId: 'template:pages/index/index.wxml' }),
    call('inspect-restored', 'inspect', summary('restored')),
  ] }
}

function snapshot(phase = 'initial') {
  const pixels = new Array(200 * 160 * 4).fill(255)
  const fill = phase === 'removed' ? [255, 255, 255, 255] : phase === 'mutated' ? [25, 118, 210, 255] : [229, 57, 53, 255]
  for (let y = 32; y < 80; y++) for (let x = 24; x < 88; x++) {
    const offset = y * 800 + x * 4
    pixels.splice(offset, 4, ...fill)
  }
  return { width: 200, height: 160, stride: 800, format: 'rgba8', pixels }
}

test('relations evidence requires exact saved lifecycle trace through every phase', () => {
  for (const phase of ['initial', 'mutated', 'removed', 'restored']) inspectSummary(summary(phase), phase)
  const wrongOrder = summary()
  ;[wrongOrder.trace[2], wrongOrder.trace[3]] = [wrongOrder.trace[3], wrongOrder.trace[2]]
  assert.throws(() => inspectSummary(wrongOrder, 'initial'), /exact saved lifecycle/)
  const missingDetached = summary('removed')
  missingDetached.trace.splice(7, 1)
  assert.throws(() => inspectSummary(missingDetached, 'removed'), /exact saved lifecycle/)
  const linkedBeforeAttached = summary('restored')
  linkedBeforeAttached.trace.splice(10, 1)
  assert.throws(() => inspectSummary(linkedBeforeAttached, 'restored'), /exact saved lifecycle/)
})

test('relations evidence rejects cloned objects, shared arrays and false method success', () => {
  for (const key of ['parentSurvives', 'parentRelationUsesLiveChild', 'childRelationUsesLiveParent',
    'relationArrayIsFresh', 'relationArrayIsIsolated', 'initialChildTracked', 'currentChildTracked']) {
    const cloned = summary()
    cloned[key] = false
    assert.throws(() => inspectSummary(cloned, 'initial'), key)
  }
  for (const key of ['sourceIsLiveReference', 'targetIsLiveReference']) {
    const callbackClone = summary()
    callbackClone.callbacks[0][key] = false
    assert.throws(() => inspectSummary(callbackClone, 'initial'), /live component objects/)
  }
  const noMutation = trace()
  noMutation.records.find(record => record.request.requestId === 'bump-held-child').response.messages[0].payload.result[0].selectedSeesSameState = false
  assert.throws(() => inspectTrace(noMutation, 'restored'), /actual selected child/)
})

test('relations evidence rejects stale disposed references and restored instance reuse', () => {
  const stale = summary('removed')
  stale.heldChildRelations = ['parent']
  assert.throws(() => inspectSummary(stale, 'removed'), /no stale relationships/)
  for (const [key, value] of [['childIsInitial', true], ['restoredChildIsFresh', false], ['childGenerations', 1],
    ['childCount', 1], ['heldChildCount', 0]]) {
    const reused = summary('restored')
    reused[key] = value
    assert.throws(() => inspectSummary(reused, 'restored'), key)
  }
})

test('trace evidence requires successful correlated native calls and rendering after each mutation', () => {
  inspectTrace(trace(), 'restored')
  const stale = trace()
  stale.records.find(record => record.request.requestId === 'inspect-mutated').response.messages[0].sessionId = 'unrelated-session'
  assert.throws(() => inspectTrace(stale, 'restored'), /correlated runtime response/)
  const injected = trace()
  injected.records.find(record => record.request.requestId === 'render-mutated').request.payload.data = { showChild: true }
  assert.throws(() => inspectTrace(injected, 'restored'), /not injected expectations/)
  const reordered = trace()
  const renderIndex = reordered.records.findIndex(record => record.request.requestId === 'render-mutated')
  ;[reordered.records[renderIndex], reordered.records[renderIndex + 1]] = [reordered.records[renderIndex + 1], reordered.records[renderIndex]]
  assert.throws(() => inspectTrace(reordered, 'restored'), /mutation -> render/)
  const duplicate = trace()
  duplicate.records.push(duplicate.records.find(record => record.request.requestId === 'inspect-initial'))
  assert.throws(() => inspectTrace(duplicate, 'restored'), /exactly one request/)
  const error = trace()
  error.records.find(record => record.request.requestId === 'render-mutated').response.messages[0].payload.ok = false
  assert.throws(() => inspectTrace(error, 'restored'), /unexpected failed request/)
  const noStartup = trace()
  noStartup.records.splice(0, 3)
  assert.throws(() => inspectTrace(noStartup, 'restored'), /canonical startup/)
})

test('snapshot evidence rejects absent, incomplete and stale component pixels', () => {
  for (const phase of ['initial', 'mutated', 'removed', 'restored']) inspectSnapshot(snapshot(phase), phase)
  assert.throws(() => inspectSnapshot(snapshot(), 'mutated'), /actual component RGBA/)
  assert.throws(() => inspectSnapshot(snapshot(), 'removed'), /actual component RGBA/)
  assert.throws(() => inspectSnapshot(snapshot('removed'), 'restored'), /actual component RGBA/)
  assert.throws(() => inspectSnapshot({ ...snapshot(), pixels: [] }, 'initial'), /complete snapshot/)
  assert.throws(() => inspectSnapshot({ ...snapshot(), pixels: undefined }, 'initial'), /actual pixel bytes/)
  const invalid = snapshot()
  invalid.pixels[1000] = 256
  assert.throws(() => inspectSnapshot(invalid, 'initial'), /valid RGBA byte/)
})
